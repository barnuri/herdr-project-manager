'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { cwdFromContextJson, cwdFromPaneId, resolveTargetDirectory } = require('../lib/context');

describe('cwdFromContextJson', () => {
  test('prefers pane.foreground_cwd over pane.cwd and workspace.cwd', () => {
    const raw = JSON.stringify({
      pane: { foreground_cwd: '/fg', cwd: '/pane' },
      workspace: { cwd: '/workspace' },
    });
    assert.equal(cwdFromContextJson(raw), '/fg');
  });

  test('falls back to pane.cwd when foreground_cwd is missing', () => {
    const raw = JSON.stringify({
      pane: { cwd: '/pane' },
      workspace: { cwd: '/workspace' },
    });
    assert.equal(cwdFromContextJson(raw), '/pane');
  });

  test('falls back to workspace.cwd when the pane has no cwd', () => {
    const raw = JSON.stringify({ pane: {}, workspace: { cwd: '/workspace' } });
    assert.equal(cwdFromContextJson(raw), '/workspace');
  });

  test('returns null when no cwd fields are present', () => {
    assert.equal(cwdFromContextJson(JSON.stringify({ pane: {}, workspace: {} })), null);
    assert.equal(cwdFromContextJson(JSON.stringify({})), null);
  });

  test('returns null for malformed JSON', () => {
    assert.equal(cwdFromContextJson('{not json'), null);
    assert.equal(cwdFromContextJson(''), null);
  });

  test('returns null for JSON that is not an object', () => {
    assert.equal(cwdFromContextJson('null'), null);
    assert.equal(cwdFromContextJson('"just a string"'), null);
    assert.equal(cwdFromContextJson('42'), null);
  });
});

describe('cwdFromPaneId', () => {
  test('reads foreground_cwd from a flat payload', () => {
    const runHerdrFn = () => ({ foreground_cwd: '/flat-fg', cwd: '/flat' });
    assert.equal(cwdFromPaneId('7', runHerdrFn), '/flat-fg');
  });

  test('falls back to cwd in a flat payload without foreground_cwd', () => {
    const runHerdrFn = () => ({ cwd: '/flat' });
    assert.equal(cwdFromPaneId('7', runHerdrFn), '/flat');
  });

  test('reads the pane nested under a pane key', () => {
    const runHerdrFn = () => ({ pane: { cwd: '/nested' } });
    assert.equal(cwdFromPaneId('7', runHerdrFn), '/nested');
  });

  test('invokes runHerdrFn with the pane get command', () => {
    const calls = [];
    const runHerdrFn = (args) => {
      calls.push(args);
      return null;
    };
    cwdFromPaneId('pane-42', runHerdrFn);
    assert.deepEqual(calls, [['pane', 'get', 'pane-42']]);
  });

  test('returns null when runHerdrFn yields null or a non-object', () => {
    assert.equal(cwdFromPaneId('7', () => null), null);
    assert.equal(cwdFromPaneId('7', () => 'oops'), null);
    assert.equal(cwdFromPaneId('7', () => undefined), null);
  });

  test('returns null when the pane payload has no cwd fields', () => {
    assert.equal(cwdFromPaneId('7', () => ({ pane: {} })), null);
    assert.equal(cwdFromPaneId('7', () => ({})), null);
  });
});

describe('resolveTargetDirectory', () => {
  const failRunHerdr = () => {
    throw new Error('runHerdrFn must not be called');
  };
  const failFallback = () => {
    throw new Error('fallbackCwd must not be called');
  };

  test('HERDR_PLUGIN_CONTEXT_JSON wins over pane id and fallback', () => {
    const env = {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ pane: { foreground_cwd: '/from-context' } }),
      HERDR_PANE_ID: '3',
    };
    const resolved = resolveTargetDirectory({
      env,
      runHerdrFn: failRunHerdr,
      fallbackCwd: failFallback,
    });
    assert.equal(resolved, '/from-context');
  });

  test('HERDR_PANE_ID is used when no context JSON is set', () => {
    const calls = [];
    const runHerdrFn = (args) => {
      calls.push(args);
      return { foreground_cwd: '/from-pane' };
    };
    const resolved = resolveTargetDirectory({
      env: { HERDR_PANE_ID: 'p-9' },
      runHerdrFn,
      fallbackCwd: failFallback,
    });
    assert.equal(resolved, '/from-pane');
    assert.deepEqual(calls, [['pane', 'get', 'p-9']]);
  });

  test('falls through to the pane when the context JSON is unusable', () => {
    const env = {
      HERDR_PLUGIN_CONTEXT_JSON: '{broken',
      HERDR_PANE_ID: '5',
    };
    const resolved = resolveTargetDirectory({
      env,
      runHerdrFn: () => ({ cwd: '/from-pane' }),
      fallbackCwd: failFallback,
    });
    assert.equal(resolved, '/from-pane');
  });

  test('falls through to fallbackCwd when the pane lookup returns null', () => {
    const resolved = resolveTargetDirectory({
      env: { HERDR_PANE_ID: '5' },
      runHerdrFn: () => null,
      fallbackCwd: () => '/from-fallback',
    });
    assert.equal(resolved, '/from-fallback');
  });

  test('uses fallbackCwd when the env has neither variable', () => {
    const resolved = resolveTargetDirectory({
      env: {},
      runHerdrFn: failRunHerdr,
      fallbackCwd: () => '/from-fallback',
    });
    assert.equal(resolved, '/from-fallback');
  });
});
