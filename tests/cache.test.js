'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cachePath, loadProjectCache, saveProjectCache, stateDir } = require('../lib/cache');

describe('cache', () => {
  let tempDir;
  let savedStateDir;

  beforeEach(() => {
    savedStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-cache-'));
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir;
  });

  afterEach(() => {
    if (savedStateDir === undefined) {
      delete process.env.HERDR_PLUGIN_STATE_DIR;
    } else {
      process.env.HERDR_PLUGIN_STATE_DIR = savedStateDir;
    }
  });

  test('stateDir and cachePath honor HERDR_PLUGIN_STATE_DIR', () => {
    assert.equal(stateDir(), tempDir);
    assert.equal(cachePath(), path.join(tempDir, 'projects-cache.json'));
  });

  test('loadProjectCache returns [] when no cache exists', () => {
    assert.deepEqual(loadProjectCache(), []);
  });

  test('save then load round-trips project entries', () => {
    const projects = [
      { name: 'api', path: '/tmp/api', source: 'glob' },
      { name: 'web', path: '/tmp/web', source: 'glob' },
    ];
    saveProjectCache(projects);
    assert.deepEqual(loadProjectCache(), projects);
  });

  test('loadProjectCache drops malformed entries and non-array payloads', () => {
    fs.writeFileSync(cachePath(), JSON.stringify([{ name: 'ok', path: '/tmp/ok' }, { name: 'no-path' }, null, 'junk']));
    assert.deepEqual(loadProjectCache(), [{ name: 'ok', path: '/tmp/ok' }]);

    fs.writeFileSync(cachePath(), JSON.stringify({ not: 'an array' }));
    assert.deepEqual(loadProjectCache(), []);

    fs.writeFileSync(cachePath(), 'not json at all');
    assert.deepEqual(loadProjectCache(), []);
  });

  test('saveProjectCache ignores non-array input', () => {
    saveProjectCache({ nope: true });
    assert.equal(fs.existsSync(cachePath()), false);
  });
});
