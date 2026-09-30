'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { loadConfig, saveConfig, defaultConfig, setAutoOpen, addGlob } = require('../lib/config');

const SCRIPT_PATH = path.join(__dirname, '..', 'bin', 'toggle-auto-open.js');
// notify() shells out to the herdr binary; a no-op stub keeps the test off the real one.
const STUB_SCRIPT = '#!/bin/sh\nexit 0\n';

function runScript(configDirPath, binPath) {
  return spawnSync(process.execPath, [SCRIPT_PATH], {
    encoding: 'utf8',
    env: { ...process.env, HERDR_PLUGIN_CONFIG_DIR: configDirPath, HERDR_BIN_PATH: binPath },
  });
}

describe('toggle-auto-open', () => {
  let tempDir;
  let binPath;
  let previousConfigDirEnv;

  beforeEach(() => {
    previousConfigDirEnv = process.env.HERDR_PLUGIN_CONFIG_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toggle-auto-open-test-'));
    process.env.HERDR_PLUGIN_CONFIG_DIR = tempDir;
    binPath = path.join(tempDir, 'herdr');
    fs.writeFileSync(binPath, STUB_SCRIPT, { mode: 0o755 });
  });

  afterEach(() => {
    if (previousConfigDirEnv === undefined) {
      delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    } else {
      process.env.HERDR_PLUGIN_CONFIG_DIR = previousConfigDirEnv;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('turns auto-open off on the first run and back on the second', () => {
    assert.equal(runScript(tempDir, binPath).status, 0);
    assert.equal(loadConfig().autoOpen, false);

    assert.equal(runScript(tempDir, binPath).status, 0);
    assert.equal(loadConfig().autoOpen, true);
  });

  test('creates the config file with auto-open off when none exists yet', () => {
    assert.equal(runScript(tempDir, binPath).status, 0);
    assert.ok(fs.existsSync(path.join(tempDir, 'projects.json')));
    assert.equal(loadConfig().autoOpen, false);
  });

  test('leaves globs, excludes and projects untouched', () => {
    saveConfig(addGlob(setAutoOpen(defaultConfig(), true), '~/repos/*/.git'));

    assert.equal(runScript(tempDir, binPath).status, 0);

    const config = loadConfig();
    assert.deepEqual(config.globs, ['~/repos/*/.git']);
    assert.deepEqual(config.excludes, []);
    assert.deepEqual(config.projects, []);
    assert.equal(config.autoOpen, false);
  });
});
