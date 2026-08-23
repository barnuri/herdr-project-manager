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

  test('resolves a .git match to its parent directory', async () => {
    const projects = await discoverProjects([path.join(fixtureDir, '*', '.git')]);
    assert.deepEqual(projects, [
      { name: 'git-proj', path: gitProjectDir, source: 'glob' },
    ]);
  });

  test('keeps directories and drops plain-file matches', async () => {
    const projects = await discoverProjects([path.join(fixtureDir, '*')]);
    const paths = projects.map((project) => project.path).sort();
    assert.deepEqual(paths, [gitProjectDir, plainProjectDir]);
  });

  test('dedupes the same project matched by multiple globs', async () => {
    const projects = await discoverProjects([
      path.join(fixtureDir, '*', '.git'),
      path.join(fixtureDir, 'git-*'),
    ]);
    const gitProjMatches = projects.filter((project) => project.path === gitProjectDir);
    assert.equal(gitProjMatches.length, 1);
  });

  test('ignores globs that match nothing and non-string entries', async () => {
    const projects = await discoverProjects([
      path.join(fixtureDir, 'no-such-dir', '*'),
      null,
      42,
      '',
      path.join(fixtureDir, '*', '.git'),
    ]);
    assert.deepEqual(projects.map((project) => project.path), [gitProjectDir]);
  });

  test('returns an empty list for non-array input', async () => {
    assert.deepEqual(await discoverProjects(undefined), []);
    assert.deepEqual(await discoverProjects('not-an-array'), []);
  });

  test('does not block the event loop for the duration of the scan', async () => {
    let tickFired = false;
    setImmediate(() => {
      tickFired = true;
    });
    await discoverProjects([path.join(fixtureDir, '*', '.git')]);
    assert.equal(tickFired, true, 'expected a setImmediate callback queued before the scan to have run during it');
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

  test('disambiguates two different real directories that share a basename by appending the parent directory name', () => {
    const discovered = [
      { name: 'widget', path: '/opt/repos/widget', source: 'glob' },
      { name: 'widget', path: '/opt/nested/tool/widget', source: 'glob' },
    ];
    const merged = mergeProjects([], discovered);
    assert.deepEqual(merged.map((project) => project.name).sort(), ['widget (repos)', 'widget (tool)']);
    // paths are untouched — only the display name is disambiguated
    assert.deepEqual(merged.map((project) => project.path).sort(), ['/opt/nested/tool/widget', '/opt/repos/widget']);
  });

  test('does not disambiguate a name that only appears once', () => {
    const discovered = [
      { name: 'widget', path: '/opt/repos/widget', source: 'glob' },
      { name: 'gadget', path: '/opt/repos/gadget', source: 'glob' },
    ];
    const merged = mergeProjects([], discovered);
    assert.deepEqual(merged.map((project) => project.name).sort(), ['gadget', 'widget']);
  });

  test('disambiguates three colliding directories at once, each against the other two', () => {
    const discovered = [
      { name: 'widget', path: '/opt/a/widget', source: 'glob' },
      { name: 'widget', path: '/opt/b/widget', source: 'glob' },
      { name: 'widget', path: '/opt/c/widget', source: 'glob' },
    ];
    const merged = mergeProjects([], discovered);
    assert.deepEqual(
      merged.map((project) => project.name).sort(),
      ['widget (a)', 'widget (b)', 'widget (c)']
    );
  });

  test('widens to a deeper ancestor segment when two colliding entries also share their immediate parent name', () => {
    const discovered = [
      { name: 'widget', path: '/opt/foo/repos/widget', source: 'glob' },
      { name: 'widget', path: '/opt/bar/repos/widget', source: 'glob' },
    ];
    const merged = mergeProjects([], discovered);
    const names = merged.map((project) => project.name).sort();
    assert.deepEqual(names, [`widget (${path.join('bar', 'repos')})`, `widget (${path.join('foo', 'repos')})`]);
  });
});
