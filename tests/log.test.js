'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { logPath, logError } = require('../lib/log');

describe('log', () => {
  let tempDir;
  let savedStateDir;

  beforeEach(() => {
    savedStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-log-'));
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir;
  });

  afterEach(() => {
    if (savedStateDir === undefined) {
      delete process.env.HERDR_PLUGIN_STATE_DIR;
    } else {
      process.env.HERDR_PLUGIN_STATE_DIR = savedStateDir;
    }
  });

  test('logPath is error.log inside the state dir', () => {
    assert.equal(logPath(), path.join(tempDir, 'error.log'));
  });

  test('logError appends a line with the component tag and the error stack', () => {
    logError('some-component', new Error('boom'));

    const content = fs.readFileSync(logPath(), 'utf8');
    assert.match(content, /\[some-component\]/);
    assert.match(content, /Error: boom/);
    assert.match(content, /^\[\d{4}-\d{2}-\d{2}T/);
  });

  test('logError appends multiple entries across calls, oldest first', () => {
    logError('a', new Error('first'));
    logError('b', new Error('second'));

    const content = fs.readFileSync(logPath(), 'utf8');
    const firstIndex = content.indexOf('[a]');
    const secondIndex = content.indexOf('[b]');
    assert.ok(firstIndex !== -1 && secondIndex !== -1, 'expected both entries to be present');
    assert.ok(firstIndex < secondIndex, 'expected the first call\'s entry to appear before the second\'s');
    assert.match(content, /first/);
    assert.match(content, /second/);
  });

  test('logError handles a plain non-Error value without a stack', () => {
    logError('component', 'a plain string error');
    const content = fs.readFileSync(logPath(), 'utf8');
    assert.match(content, /a plain string error/);
  });

  test('logError creates the state dir if it does not exist yet', () => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    assert.doesNotThrow(() => logError('component', new Error('boom')));
    assert.ok(fs.existsSync(logPath()));
  });

  test('logError truncates the log once it grows past the size cap instead of growing forever', () => {
    const target = logPath();
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(target, 'x'.repeat(1024 * 1024 + 1));

    logError('component', new Error('after cap'));

    const content = fs.readFileSync(target, 'utf8');
    assert.ok(content.length < 1024 * 1024, 'expected the log to have been truncated before appending');
    assert.match(content, /after cap/);
  });
});
