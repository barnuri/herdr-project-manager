'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runHerdr, runHerdrText, openTab, openWorkspace, notify } = require('../lib/herdr');

// Shell stub standing in for the real herdr binary: echoes canned stdout/stderr
// and exits with a canned code, all driven by HERDR_STUB_* env vars.
const STUB_SCRIPT = `#!/bin/sh
if [ -n "$HERDR_STUB_STDOUT" ]; then printf '%s' "$HERDR_STUB_STDOUT"; fi
if [ -n "$HERDR_STUB_STDERR" ]; then printf '%s' "$HERDR_STUB_STDERR" >&2; fi
exit "\${HERDR_STUB_EXIT:-0}"
`;

const STUB_ENV_VARS = ['HERDR_STUB_STDOUT', 'HERDR_STUB_STDERR', 'HERDR_STUB_EXIT'];

describe('herdr', () => {
  let tempDir;
  let stubPath;
  let previousBinPathEnv;

  beforeEach(() => {
    previousBinPathEnv = process.env.HERDR_BIN_PATH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-bin-test-'));
    stubPath = path.join(tempDir, 'herdr');
    fs.writeFileSync(stubPath, STUB_SCRIPT, { mode: 0o755 });
    process.env.HERDR_BIN_PATH = stubPath;
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
});
