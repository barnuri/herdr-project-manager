'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { togglePicker } = require('../bin/open-picker');
const { dockedPaneId, setDockedPane, isSnoozed, setSnoozed } = require('../lib/dock');

// Shell stub standing in for the real herdr binary, matching the pattern used by
// tests/ensure-picker.test.js: dispatch canned JSON per subcommand and append every
// call's argv to a log file, all driven by HERDR_STUB_*_JSON / HERDR_STUB_CALLS_FILE.
const STUB_SCRIPT = `#!/bin/sh
case "$1 $2" in
  "pane list") printf '%s' "$HERDR_STUB_LIST_JSON" ;;
  "pane close") printf '%s' "$HERDR_STUB_CLOSE_JSON" ;;
  "plugin pane") printf '%s' "$HERDR_STUB_PLUGIN_OPEN_JSON" ;;
esac
if [ -n "$HERDR_STUB_CALLS_FILE" ]; then
  { printf '%s\t' "$@"; printf '\n'; } >> "$HERDR_STUB_CALLS_FILE"
fi
exit 0
`;

const STUB_ENV_VARS = [
  'HERDR_STUB_LIST_JSON',
  'HERDR_STUB_CLOSE_JSON',
  'HERDR_STUB_PLUGIN_OPEN_JSON',
  'HERDR_STUB_CALLS_FILE',
];

const TAB_ID = 'tab-1';
const DEFAULT_PLUGIN_ID = 'barnuri.project-manager';

function readRecordedCalls(callsFilePath) {
  if (!fs.existsSync(callsFilePath)) {
    return [];
  }
  return fs
    .readFileSync(callsFilePath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t').filter((part) => part.length > 0));
}

function setStubJson(varName, result) {
  process.env[varName] = JSON.stringify({ id: 'stub', result });
}

describe('open-picker', () => {
  let binDir;
  let stateDirPath;
  let callsFilePath;
  let previousBinPathEnv;
  let previousStateDirEnv;
  let previousExitCode;
  let previousStderrWrite;
  let stderrOutput;

  beforeEach(() => {
    previousBinPathEnv = process.env.HERDR_BIN_PATH;
    previousStateDirEnv = process.env.HERDR_PLUGIN_STATE_DIR;
    previousExitCode = process.exitCode;
    process.exitCode = undefined;

    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-picker-bin-'));
    const stubPath = path.join(binDir, 'herdr');
    callsFilePath = path.join(binDir, 'calls.log');
    fs.writeFileSync(stubPath, STUB_SCRIPT, { mode: 0o755 });
    process.env.HERDR_BIN_PATH = stubPath;
    process.env.HERDR_STUB_CALLS_FILE = callsFilePath;

    stateDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'open-picker-state-'));
    process.env.HERDR_PLUGIN_STATE_DIR = stateDirPath;

    stderrOutput = '';
    previousStderrWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      stderrOutput += chunk;
      return true;
    };

    setStubJson('HERDR_STUB_CLOSE_JSON', {});
  });

  afterEach(() => {
    process.stderr.write = previousStderrWrite;

    if (previousBinPathEnv === undefined) {
      delete process.env.HERDR_BIN_PATH;
    } else {
      process.env.HERDR_BIN_PATH = previousBinPathEnv;
    }
    if (previousStateDirEnv === undefined) {
      delete process.env.HERDR_PLUGIN_STATE_DIR;
    } else {
      process.env.HERDR_PLUGIN_STATE_DIR = previousStateDirEnv;
    }
    for (const name of STUB_ENV_VARS) {
      delete process.env[name];
    }
    process.exitCode = previousExitCode;
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(stateDirPath, { recursive: true, force: true });
  });

  test('no picker open in the focused tab opens one, clears any prior snooze, and records the docked pane', () => {
    setSnoozed(TAB_ID);
    setStubJson('HERDR_STUB_LIST_JSON', {
      panes: [{ pane_id: 'pane-focused', tab_id: TAB_ID, focused: true }],
    });
    setStubJson('HERDR_STUB_PLUGIN_OPEN_JSON', { plugin_pane: { pane: { pane_id: 'pane-new' } } });

    const exitCode = togglePicker();

    assert.equal(exitCode, 0);
    assert.deepEqual(readRecordedCalls(callsFilePath), [
      ['pane', 'list'],
      ['plugin', 'pane', 'open', '--plugin', DEFAULT_PLUGIN_ID, '--entrypoint', 'picker'],
    ]);
    assert.equal(dockedPaneId(TAB_ID).paneId, 'pane-new');
    assert.equal(isSnoozed(TAB_ID), false);
  });

  test('a picker already open and tracked in the focused tab closes it, clears the dock entry, and snoozes the tab', () => {
    setDockedPane(TAB_ID, 'pane-docked', Date.now());
    setStubJson('HERDR_STUB_LIST_JSON', {
      panes: [
        { pane_id: 'pane-focused', tab_id: TAB_ID, focused: true },
        { pane_id: 'pane-docked', tab_id: TAB_ID, focused: false },
      ],
    });

    const exitCode = togglePicker();

    assert.equal(exitCode, 0);
    assert.deepEqual(readRecordedCalls(callsFilePath), [
      ['pane', 'list'],
      ['pane', 'close', 'pane-docked'],
    ]);
    assert.equal(dockedPaneId(TAB_ID), undefined);
    assert.equal(isSnoozed(TAB_ID), true);
  });

  test('a stale tracked pane id (no longer in pane list) is treated as not open and a fresh picker is opened', () => {
    setDockedPane(TAB_ID, 'pane-gone', Date.now());
    setStubJson('HERDR_STUB_LIST_JSON', {
      panes: [{ pane_id: 'pane-focused', tab_id: TAB_ID, focused: true }],
    });
    setStubJson('HERDR_STUB_PLUGIN_OPEN_JSON', { plugin_pane: { pane: { pane_id: 'pane-new' } } });

    const exitCode = togglePicker();

    assert.equal(exitCode, 0);
    assert.deepEqual(readRecordedCalls(callsFilePath), [
      ['pane', 'list'],
      ['plugin', 'pane', 'open', '--plugin', DEFAULT_PLUGIN_ID, '--entrypoint', 'picker'],
    ]);
    assert.equal(dockedPaneId(TAB_ID).paneId, 'pane-new');
  });

  test('no focused pane in the pane list exits non-zero with a stderr message and no herdr mutation calls', () => {
    setStubJson('HERDR_STUB_LIST_JSON', {
      panes: [{ pane_id: 'pane-1', tab_id: TAB_ID, focused: false }],
    });

    const exitCode = togglePicker();

    assert.equal(exitCode, 1);
    assert.deepEqual(readRecordedCalls(callsFilePath), [['pane', 'list']]);
    assert.match(stderrOutput, /no focused pane/);
  });

  test('a shared lock already held by another process gives up after waiting and exits non-zero with a stderr message', () => {
    const lockDir = path.join(stateDirPath, 'ensure.lock');
    fs.mkdirSync(lockDir, { recursive: true });

    const exitCode = togglePicker();

    assert.equal(exitCode, 1);
    assert.deepEqual(readRecordedCalls(callsFilePath), []);
    assert.match(stderrOutput, /could not acquire lock/);
  });
});
