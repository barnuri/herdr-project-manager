'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runHerdr,
  runHerdrText,
  openTab,
  openWorkspace,
  notify,
  listPanes,
  paneLayout,
  paneSplit,
  paneRun,
  paneRename,
  paneClose,
} = require('../lib/herdr');

// Shell stub standing in for the real herdr binary: echoes canned stdout/stderr,
// records the argv it was called with, and exits with a canned code, all driven
// by HERDR_STUB_* env vars.
const STUB_SCRIPT = `#!/bin/sh
if [ -n "$HERDR_STUB_STDOUT" ]; then printf '%s' "$HERDR_STUB_STDOUT"; fi
if [ -n "$HERDR_STUB_STDERR" ]; then printf '%s' "$HERDR_STUB_STDERR" >&2; fi
if [ -n "$HERDR_STUB_ARGS_FILE" ]; then printf '%s\n' "$@" > "$HERDR_STUB_ARGS_FILE"; fi
exit "\${HERDR_STUB_EXIT:-0}"
`;

const STUB_ENV_VARS = ['HERDR_STUB_STDOUT', 'HERDR_STUB_STDERR', 'HERDR_STUB_EXIT', 'HERDR_STUB_ARGS_FILE'];

function readRecordedArgs(argsFilePath) {
  return fs
    .readFileSync(argsFilePath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

describe('herdr', () => {
  let tempDir;
  let stubPath;
  let argsFilePath;
  let previousBinPathEnv;

  beforeEach(() => {
    previousBinPathEnv = process.env.HERDR_BIN_PATH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-bin-test-'));
    stubPath = path.join(tempDir, 'herdr');
    argsFilePath = path.join(tempDir, 'args.txt');
    fs.writeFileSync(stubPath, STUB_SCRIPT, { mode: 0o755 });
    process.env.HERDR_BIN_PATH = stubPath;
    process.env.HERDR_STUB_ARGS_FILE = argsFilePath;
  });

  afterEach(() => {
    if (previousBinPathEnv === undefined) {
      delete process.env.HERDR_BIN_PATH;
    } else {
      process.env.HERDR_BIN_PATH = previousBinPathEnv;
    }
    for (const name of STUB_ENV_VARS) {
      delete process.env[name];
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('runHerdr', () => {
    test('parses the JSON envelope and returns its result', () => {
      process.env.HERDR_STUB_STDOUT = JSON.stringify({
        id: 'req-1',
        result: { tabId: 'tab-42', focused: true },
      });
      assert.deepEqual(runHerdr(['tab', 'create']), { tabId: 'tab-42', focused: true });
    });

    test('throws with stderr in the message on a non-zero exit', () => {
      process.env.HERDR_STUB_EXIT = '3';
      process.env.HERDR_STUB_STDERR = 'daemon not running';
      assert.throws(
        () => runHerdr(['tab', 'create']),
        /herdr tab create exited with code 3: daemon not running/
      );
    });

    test('throws a helpful error when stdout is not JSON', () => {
      process.env.HERDR_STUB_STDOUT = 'plain text, not json';
      assert.throws(
        () => runHerdr(['tab', 'list']),
        /herdr tab list did not print a JSON envelope .*got: plain text, not json/
      );
    });

    test('throws when the binary cannot be spawned', () => {
      process.env.HERDR_BIN_PATH = path.join(tempDir, 'does-not-exist');
      assert.throws(() => runHerdr(['tab', 'list']), /failed to spawn/);
    });
  });

  describe('runHerdrText', () => {
    test('returns raw stdout without parsing', () => {
      process.env.HERDR_STUB_STDOUT = 'not json at all\n';
      assert.equal(runHerdrText(['notification', 'show']), 'not json at all\n');
    });
  });

  describe('openTab / openWorkspace', () => {
    test('openTab throws a TypeError when cwd is missing', () => {
      assert.throws(() => openTab({ label: 'widget' }), {
        name: 'TypeError',
        message: 'cwd must be a non-empty string',
      });
    });

    test('openTab throws a TypeError when called with no options', () => {
      assert.throws(() => openTab(), TypeError);
    });

    test('openWorkspace throws a TypeError when cwd is missing', () => {
      assert.throws(() => openWorkspace({ label: 'widget' }), {
        name: 'TypeError',
        message: 'cwd must be a non-empty string',
      });
    });

    test('openWorkspace throws a TypeError when called with no options', () => {
      assert.throws(() => openWorkspace(), TypeError);
    });
  });

  describe('notify', () => {
    test('does not throw when the binary is missing', () => {
      process.env.HERDR_BIN_PATH = path.join(tempDir, 'does-not-exist');
      assert.doesNotThrow(() => notify('Build done', 'All green'));
    });

    test('does not throw when the binary exits non-zero', () => {
      process.env.HERDR_STUB_EXIT = '1';
      process.env.HERDR_STUB_STDERR = 'toast failed';
      assert.doesNotThrow(() => notify('Build done', 'All green'));
    });
  });

  describe('listPanes', () => {
    test('lists panes for a workspace and returns the panes array', () => {
      process.env.HERDR_STUB_STDOUT = JSON.stringify({
        id: 'req-1',
        result: { panes: [{ pane_id: 'pane-1' }, { pane_id: 'pane-2' }] },
      });
      const panes = listPanes({ workspace: 'ws-main' });
      assert.deepEqual(panes, [{ pane_id: 'pane-1' }, { pane_id: 'pane-2' }]);
      assert.deepEqual(readRecordedArgs(argsFilePath), ['pane', 'list', '--workspace', 'ws-main']);
    });

    test('lists panes for all workspaces when no workspace is given', () => {
      process.env.HERDR_STUB_STDOUT = JSON.stringify({ id: 'req-1', result: { panes: [] } });
      listPanes();
      assert.deepEqual(readRecordedArgs(argsFilePath), ['pane', 'list']);
    });

    test('throws with stderr in the message on a non-zero exit', () => {
      process.env.HERDR_STUB_EXIT = '1';
      process.env.HERDR_STUB_STDERR = 'daemon not running';
      assert.throws(() => listPanes(), /herdr pane list exited with code 1: daemon not running/);
    });
  });

  describe('paneLayout', () => {
    test('fetches the layout for a pane and returns the layout field', () => {
      process.env.HERDR_STUB_STDOUT = JSON.stringify({
        id: 'req-1',
        result: { layout: { rows: 24, cols: 80 } },
      });
      assert.deepEqual(paneLayout({ pane: 'pane-1' }), { rows: 24, cols: 80 });
      assert.deepEqual(readRecordedArgs(argsFilePath), ['pane', 'layout', '--pane', 'pane-1']);
    });

    test('throws with stderr in the message on a non-zero exit', () => {
      process.env.HERDR_STUB_EXIT = '1';
      process.env.HERDR_STUB_STDERR = 'pane not found';
      assert.throws(
        () => paneLayout({ pane: 'pane-1' }),
        /herdr pane layout --pane pane-1 exited with code 1: pane not found/
      );
    });
  });

  describe('paneSplit', () => {
    test('splits a pane and returns the new pane id, defaulting to --no-focus', () => {
      process.env.HERDR_STUB_STDOUT = JSON.stringify({
        id: 'req-1',
        result: { pane: { pane_id: 'pane-2' } },
      });
      const paneId = paneSplit({ pane: 'pane-1', direction: 'vertical', ratio: 0.5 });
      assert.equal(paneId, 'pane-2');
      assert.deepEqual(readRecordedArgs(argsFilePath), [
        'pane',
        'split',
        'pane-1',
        '--direction',
        'vertical',
        '--ratio',
        '0.5',
        '--no-focus',
      ]);
    });

    test('omits --no-focus when noFocus is false', () => {
      process.env.HERDR_STUB_STDOUT = JSON.stringify({
        id: 'req-1',
        result: { pane: { pane_id: 'pane-2' } },
      });
      paneSplit({ pane: 'pane-1', direction: 'horizontal', ratio: 0.3, noFocus: false });
      assert.deepEqual(readRecordedArgs(argsFilePath), [
        'pane',
        'split',
        'pane-1',
        '--direction',
        'horizontal',
        '--ratio',
        '0.3',
      ]);
    });

    test('throws a TypeError when ratio is not a number', () => {
      assert.throws(() => paneSplit({ pane: 'pane-1', direction: 'vertical', ratio: 'half' }), {
        name: 'TypeError',
        message: 'ratio must be a number',
      });
    });

    test('throws with stderr in the message on a non-zero exit', () => {
      process.env.HERDR_STUB_EXIT = '1';
      process.env.HERDR_STUB_STDERR = 'pane not found';
      assert.throws(
        () => paneSplit({ pane: 'pane-1', direction: 'vertical', ratio: 0.5 }),
        /herdr pane split pane-1 --direction vertical --ratio 0\.5 --no-focus exited with code 1: pane not found/
      );
    });
  });

  describe('paneRun', () => {
    test('does not throw on the real herdr contract of exit 0 with empty stdout', () => {
      process.env.HERDR_STUB_STDOUT = '';
      assert.doesNotThrow(() => paneRun('pane-1', 'npm test'));
      assert.deepEqual(readRecordedArgs(argsFilePath), ['pane', 'run', 'pane-1', 'npm test']);
    });

    test('throws with stderr in the message on a non-zero exit', () => {
      process.env.HERDR_STUB_EXIT = '1';
      process.env.HERDR_STUB_STDERR = 'pane not found';
      assert.throws(
        () => paneRun('pane-1', 'npm test'),
        /herdr pane run pane-1 npm test exited with code 1: pane not found/
      );
    });
  });

  describe('paneRename', () => {
    test('renames a pane and returns the result', () => {
      process.env.HERDR_STUB_STDOUT = JSON.stringify({ id: 'req-1', result: { label: 'build' } });
      assert.deepEqual(paneRename('pane-1', 'build'), { label: 'build' });
      assert.deepEqual(readRecordedArgs(argsFilePath), ['pane', 'rename', 'pane-1', 'build']);
    });

    test('throws with stderr in the message on a non-zero exit', () => {
      process.env.HERDR_STUB_EXIT = '1';
      process.env.HERDR_STUB_STDERR = 'pane not found';
      assert.throws(
        () => paneRename('pane-1', 'build'),
        /herdr pane rename pane-1 build exited with code 1: pane not found/
      );
    });
  });

  describe('paneClose', () => {
    test('closes a pane and returns the result', () => {
      process.env.HERDR_STUB_STDOUT = JSON.stringify({ id: 'req-1', result: { closed: true } });
      assert.deepEqual(paneClose('pane-1'), { closed: true });
      assert.deepEqual(readRecordedArgs(argsFilePath), ['pane', 'close', 'pane-1']);
    });

    test('throws with stderr in the message on a non-zero exit', () => {
      process.env.HERDR_STUB_EXIT = '1';
      process.env.HERDR_STUB_STDERR = 'pane not found';
      assert.throws(
        () => paneClose('pane-1'),
        /herdr pane close pane-1 exited with code 1: pane not found/
      );
    });
  });
});
