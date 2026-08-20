'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { discoverProjects, mergeProjects } = require('../lib/discover');

describe('discoverProjects', () => {
  let fixtureDir;
  let gitProjectDir;
  let plainProjectDir;

  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-discover-test-'));
    gitProjectDir = path.join(fixtureDir, 'git-proj');
    plainProjectDir = path.join(fixtureDir, 'plain-proj');
    fs.mkdirSync(path.join(gitProjectDir, '.git'), { recursive: true });
    fs.mkdirSync(plainProjectDir);
    fs.writeFileSync(path.join(fixtureDir, 'stray-file.txt'), 'not a project\n', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  test('resolves a .git match to its parent directory', () => {
    const projects = discoverProjects([path.join(fixtureDir, '*', '.git')]);
    assert.deepEqual(projects, [
      { name: 'git-proj', path: gitProjectDir, source: 'glob' },
    ]);
  });

  test('keeps directories and drops plain-file matches', () => {
    const projects = discoverProjects([path.join(fixtureDir, '*')]);
    const paths = projects.map((project) => project.path).sort();
    assert.deepEqual(paths, [gitProjectDir, plainProjectDir]);
  });

  test('dedupes the same project matched by multiple globs', () => {
    const projects = discoverProjects([
      path.join(fixtureDir, '*', '.git'),
      path.join(fixtureDir, 'git-*'),
    ]);
    const gitProjMatches = projects.filter((project) => project.path === gitProjectDir);
    assert.equal(gitProjMatches.length, 1);
  });

  test('ignores globs that match nothing and non-string entries', () => {
    const projects = discoverProjects([
      path.join(fixtureDir, 'no-such-dir', '*'),
      null,
      42,
      '',
      path.join(fixtureDir, '*', '.git'),
    ]);
    assert.deepEqual(projects.map((project) => project.path), [gitProjectDir]);
  });

  test('returns an empty list for non-array input', () => {
    assert.deepEqual(discoverProjects(undefined), []);
    assert.deepEqual(discoverProjects('not-an-array'), []);
  });
});

describe('mergeProjects', () => {
  test('manual entry wins over a discovered entry with the same path', () => {
    const manual = [{ name: 'my-widget', path: '/opt/repos/widget' }];
    const discovered = [{ name: 'widget', path: '/opt/repos/widget', source: 'glob' }];
    const merged = mergeProjects(manual, discovered);
    assert.deepEqual(merged, [
      { name: 'my-widget', path: '/opt/repos/widget', source: 'manual' },
    ]);
  });

  test('dedupes by resolved path', () => {
    const manual = [{ name: 'widget', path: '/opt/repos/widget' }];
    const discovered = [{ name: 'widget', path: '/opt/repos/widget/../widget', source: 'glob' }];
    const merged = mergeProjects(manual, discovered);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].source, 'manual');
  });

  test('sorts the merged list by name', () => {
    const manual = [{ name: 'zeta', path: '/opt/repos/zeta' }];
    const discovered = [
      { name: 'mid', path: '/opt/repos/mid', source: 'glob' },
      { name: 'alpha', path: '/opt/repos/alpha', source: 'glob' },
    ];
    const merged = mergeProjects(manual, discovered);
    assert.deepEqual(merged.map((project) => project.name), ['alpha', 'mid', 'zeta']);
  });

  test('tags every manual entry with source "manual"', () => {
    const merged = mergeProjects([{ name: 'widget', path: '/opt/repos/widget' }], []);
    assert.equal(merged[0].source, 'manual');
  });

  test('tolerates non-array arguments', () => {
    assert.deepEqual(mergeProjects(undefined, undefined), []);
    const merged = mergeProjects(null, [{ name: 'widget', path: '/opt/repos/widget', source: 'glob' }]);
    assert.equal(merged.length, 1);
  });
});
