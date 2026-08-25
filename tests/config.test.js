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
  updateProject,
  addGlob,
  removeGlob,
  updateGlob,
  addExclude,
  removeExclude,
  updateExclude,
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
        excludes: ['/opt/repos/vendor'],
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

  describe('excludes', () => {
    test('defaults to an empty list', () => {
      assert.deepEqual(defaultConfig().excludes, []);
    });

    test('loadConfig defaults excludes to an empty list when the key is missing', () => {
      fs.writeFileSync(configPath(), JSON.stringify({ globs: ['/opt/*/.git'], projects: [] }), 'utf8');
      assert.deepEqual(loadConfig().excludes, []);
    });

    test('loadConfig keeps string entries and drops non-string ones', () => {
      fs.writeFileSync(
        configPath(),
        JSON.stringify({ globs: [], excludes: ['~/vendor', 42, null], projects: [] }),
        'utf8'
      );
      assert.deepEqual(loadConfig().excludes, ['~/vendor']);
    });

    test('addExclude appends without mutating the input config', () => {
      const config = defaultConfig();
      const updated = addExclude(config, '~/vendor/**');
      assert.deepEqual(updated.excludes, ['~/vendor/**']);
      assert.deepEqual(config.excludes, []);
    });

    test('addExclude ignores duplicates and blank patterns', () => {
      const config = addExclude(defaultConfig(), '~/vendor');
      assert.equal(addExclude(config, '~/vendor'), config);
      assert.equal(addExclude(config, '   '), config);
      assert.equal(addExclude(config, null), config);
    });

    test('addExclude leaves globs and projects untouched', () => {
      const config = addGlob(defaultConfig(), '~/repos/*/.git');
      const updated = addExclude(config, '~/repos/vendor');
      assert.deepEqual(updated.globs, ['~/repos/*/.git']);
      assert.deepEqual(updated.projects, []);
    });

    test('removeExclude drops only the matching pattern', () => {
      const config = { globs: [], excludes: ['~/a', '~/b'], projects: [] };
      assert.deepEqual(removeExclude(config, '~/a').excludes, ['~/b']);
      assert.deepEqual(config.excludes, ['~/a', '~/b']);
    });

    test('updateExclude replaces in place and dedupes against an existing entry', () => {
      const config = { globs: [], excludes: ['~/a', '~/b', '~/c'], projects: [] };
      assert.deepEqual(updateExclude(config, '~/b', '~/z').excludes, ['~/a', '~/z', '~/c']);
      assert.deepEqual(updateExclude(config, '~/c', '~/a').excludes, ['~/b', '~/a']);
    });

    test('updateExclude returns the config unchanged for a blank or identical value', () => {
      const config = { globs: [], excludes: ['~/a'], projects: [] };
      assert.equal(updateExclude(config, '~/a', '  '), config);
      assert.equal(updateExclude(config, '~/a', '~/a'), config);
    });
  });

  describe('addGlob', () => {
    test('appends a glob without mutating the input config', () => {
      const config = defaultConfig();
      const updated = addGlob(config, '~/repos/*/.git');
      assert.deepEqual(updated.globs, ['~/repos/*/.git']);
      assert.deepEqual(config.globs, []);
    });

    test('returns the config unchanged when the exact pattern is already present', () => {
      const config = addGlob(defaultConfig(), '~/repos/*/.git');
      const updated = addGlob(config, '~/repos/*/.git');
      assert.equal(updated, config);
    });

    test('does not dedupe patterns that are merely equivalent, only exact string matches', () => {
      const config = addGlob(defaultConfig(), '~/repos/*/.git');
      const updated = addGlob(config, '~/repos/**/.git');
      assert.equal(updated.globs.length, 2);
    });

    test('returns the config unchanged for a non-string pattern', () => {
      const config = defaultConfig();
      assert.equal(addGlob(config, null), config);
      assert.equal(addGlob(config, 42), config);
      assert.equal(addGlob(config, undefined), config);
    });

    test('returns the config unchanged for an empty or whitespace-only pattern', () => {
      const config = defaultConfig();
      assert.equal(addGlob(config, ''), config);
      assert.equal(addGlob(config, '   '), config);
    });
  });

  describe('removeGlob', () => {
    test('removes the matching glob without mutating the input config', () => {
      const config = { globs: ['~/repos/*/.git', '~/work/**/.git'], projects: [] };
      const updated = removeGlob(config, '~/repos/*/.git');
      assert.deepEqual(updated.globs, ['~/work/**/.git']);
      assert.equal(config.globs.length, 2);
    });

    test('matches by exact string, not by a resolved/expanded form', () => {
      const config = { globs: ['~/repos/*/.git'], projects: [] };
      const updated = removeGlob(config, path.join(os.homedir(), 'repos', '*', '.git'));
      assert.deepEqual(updated.globs, ['~/repos/*/.git']);
    });

    test('leaves the glob list intact when nothing matches', () => {
      const config = { globs: ['~/repos/*/.git'], projects: [] };
      const updated = removeGlob(config, '~/unknown/*/.git');
      assert.deepEqual(updated.globs, config.globs);
    });
  });

  describe('updateGlob', () => {
    test('replaces the matching glob in place, preserving its position, without mutating the input', () => {
      const config = { globs: ['~/repos/*/.git', '~/work/**/.git'], projects: [] };
      const updated = updateGlob(config, '~/repos/*/.git', '~/renamed/*/.git');
      assert.deepEqual(updated.globs, ['~/renamed/*/.git', '~/work/**/.git']);
      assert.deepEqual(config.globs, ['~/repos/*/.git', '~/work/**/.git']);
    });

    test('returns the config unchanged when the new value is empty or whitespace', () => {
      const config = { globs: ['~/repos/*/.git'], projects: [] };
      assert.deepEqual(updateGlob(config, '~/repos/*/.git', ''), config);
      assert.deepEqual(updateGlob(config, '~/repos/*/.git', '   '), config);
    });

    test('returns the config unchanged when the new value equals the old value', () => {
      const config = { globs: ['~/repos/*/.git'], projects: [] };
      assert.deepEqual(updateGlob(config, '~/repos/*/.git', '~/repos/*/.git'), config);
    });

    test('drops a pre-existing duplicate of the new value instead of creating two identical entries', () => {
      const config = { globs: ['~/repos/*/.git', '~/work/**/.git'], projects: [] };
      const updated = updateGlob(config, '~/repos/*/.git', '~/work/**/.git');
      assert.deepEqual(updated.globs, ['~/work/**/.git']);
    });
  });

  describe('updateProject', () => {
    test('replaces the matching project in place, preserving its position and re-deriving the name, without mutating the input', () => {
      const config = {
        globs: [],
        projects: [
          { name: 'widget', path: '/opt/repos/widget' },
          { name: 'gadget', path: '/opt/repos/gadget' },
        ],
      };
      const updated = updateProject(config, '/opt/repos/widget', '/opt/repos/renamed-widget');
      assert.deepEqual(updated.projects, [
        { name: 'renamed-widget', path: '/opt/repos/renamed-widget' },
        { name: 'gadget', path: '/opt/repos/gadget' },
      ]);
      assert.equal(config.projects[0].path, '/opt/repos/widget');
    });

    test('returns the config unchanged when the resolved new path equals the resolved old path', () => {
      const config = { globs: [], projects: [{ name: 'widget', path: '/opt/repos/widget' }] };
      const updated = updateProject(config, '/opt/repos/widget', '/opt/repos/widget');
      assert.deepEqual(updated.projects, config.projects);
    });

    test('drops a pre-existing duplicate of the new path instead of creating two identical entries', () => {
      const config = {
        globs: [],
        projects: [
          { name: 'widget', path: '/opt/repos/widget' },
          { name: 'gadget', path: '/opt/repos/gadget' },
        ],
      };
      const updated = updateProject(config, '/opt/repos/widget', '/opt/repos/gadget');
      assert.deepEqual(updated.projects, [{ name: 'gadget', path: '/opt/repos/gadget' }]);
    });

    test('expands a leading ~ in the new path the same way addProject does', () => {
      const config = { globs: [], projects: [{ name: 'widget', path: '/opt/repos/widget' }] };
      const updated = updateProject(config, '/opt/repos/widget', '~/repos/moved');
      assert.deepEqual(updated.projects, [{ name: 'moved', path: path.join(os.homedir(), 'repos', 'moved') }]);
    });
  });
});
