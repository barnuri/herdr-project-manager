'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  configDir,
  configPath,
  defaultConfig,
  loadConfig,
  saveConfig,
  addProject,
  removeProject,
} = require('../lib/config');

describe('config', () => {
  let tempDir;
  let previousConfigDirEnv;

  beforeEach(() => {
    previousConfigDirEnv = process.env.HERDR_PLUGIN_CONFIG_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-config-test-'));
    process.env.HERDR_PLUGIN_CONFIG_DIR = tempDir;
  });

  afterEach(() => {
    if (previousConfigDirEnv === undefined) {
      delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    } else {
      process.env.HERDR_PLUGIN_CONFIG_DIR = previousConfigDirEnv;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('configDir / configPath', () => {
    test('configDir honors HERDR_PLUGIN_CONFIG_DIR', () => {
      assert.equal(configDir(), tempDir);
    });

    test('configPath is projects.json inside the config dir', () => {
      assert.equal(configPath(), path.join(tempDir, 'projects.json'));
    });
  });

  describe('loadConfig', () => {
    test('returns defaults when the config file does not exist', () => {
      assert.deepEqual(loadConfig(), defaultConfig());
    });

    test('returns defaults when the config file holds corrupt JSON', () => {
      fs.writeFileSync(configPath(), '{ this is not json', 'utf8');
      assert.deepEqual(loadConfig(), defaultConfig());
    });

    test('returns defaults when the config file is not an object', () => {
      fs.writeFileSync(configPath(), JSON.stringify(['not', 'a', 'config']), 'utf8');
      assert.deepEqual(loadConfig(), defaultConfig());
    });

    test('expands ~ in project paths', () => {
      fs.writeFileSync(
        configPath(),
        JSON.stringify({ globs: [], projects: [{ path: '~/some-proj' }] }),
        'utf8'
      );
      const config = loadConfig();
      assert.equal(config.projects[0].path, path.join(os.homedir(), 'some-proj'));
    });

    test('defaults a missing project name to the path basename', () => {
      fs.writeFileSync(
        configPath(),
        JSON.stringify({ globs: [], projects: [{ path: '/opt/repos/widget' }] }),
        'utf8'
      );
      const config = loadConfig();
      assert.deepEqual(config.projects, [{ name: 'widget', path: '/opt/repos/widget' }]);
    });
  });

  describe('saveConfig', () => {
    test('save/load round-trips a config', () => {
      const config = {
        globs: ['/opt/repos/*/.git'],
        projects: [{ name: 'widget', path: '/opt/repos/widget' }],
      };
      saveConfig(config);
      assert.deepEqual(loadConfig(), config);
    });

    test('creates the config dir when it does not exist', () => {
      const nestedDir = path.join(tempDir, 'nested', 'deeper');
      process.env.HERDR_PLUGIN_CONFIG_DIR = nestedDir;
      saveConfig(defaultConfig());
      assert.ok(fs.existsSync(path.join(nestedDir, 'projects.json')));
    });
  });

  describe('addProject', () => {
    test('appends a project without mutating the input config', () => {
      const config = defaultConfig();
      const updated = addProject(config, { name: 'widget', path: '/opt/repos/widget' });
      assert.deepEqual(updated.projects, [{ name: 'widget', path: '/opt/repos/widget' }]);
      assert.deepEqual(config.projects, []);
    });

    test('returns the config unchanged when the path is already present', () => {
      const config = addProject(defaultConfig(), { name: 'widget', path: '/opt/repos/widget' });
      const updated = addProject(config, { name: 'other-name', path: '/opt/repos/widget' });
      assert.equal(updated, config);
    });

    test('dedupes by resolved path, not by name', () => {
      const config = addProject(defaultConfig(), { name: 'widget', path: '/opt/repos/widget' });
      const updated = addProject(config, { name: 'widget', path: '/opt/repos/widget/../widget' });
      assert.equal(updated.projects.length, 1);
    });

    test('defaults the name to the path basename', () => {
      const updated = addProject(defaultConfig(), { path: '/opt/repos/widget' });
      assert.equal(updated.projects[0].name, 'widget');
    });

    test('expands ~ in the project path', () => {
      const updated = addProject(defaultConfig(), { path: '~/some-proj' });
      assert.equal(updated.projects[0].path, path.join(os.homedir(), 'some-proj'));
    });
  });

  describe('removeProject', () => {
    test('removes the matching project without mutating the input config', () => {
      const config = {
        globs: [],
        projects: [
          { name: 'widget', path: '/opt/repos/widget' },
          { name: 'gadget', path: '/opt/repos/gadget' },
        ],
      };
      const updated = removeProject(config, '/opt/repos/widget');
      assert.deepEqual(updated.projects, [{ name: 'gadget', path: '/opt/repos/gadget' }]);
      assert.equal(config.projects.length, 2);
    });

    test('matches by resolved path', () => {
      const config = {
        globs: [],
        projects: [{ name: 'widget', path: '/opt/repos/widget' }],
      };
      const updated = removeProject(config, '/opt/repos/widget/../widget');
      assert.deepEqual(updated.projects, []);
    });

    test('leaves the project list intact when nothing matches', () => {
      const config = {
        globs: [],
        projects: [{ name: 'widget', path: '/opt/repos/widget' }],
      };
      const updated = removeProject(config, '/opt/repos/unknown');
      assert.deepEqual(updated.projects, config.projects);
    });
  });
});
