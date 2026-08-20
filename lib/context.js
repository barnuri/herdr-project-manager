'use strict';

function cwdFromContextJson(rawContextJson) {
  let context;
  try {
    context = JSON.parse(rawContextJson);
  } catch {
    return null;
  }
  if (context === null || typeof context !== 'object') {
    return null;
  }
  return context.pane?.foreground_cwd || context.pane?.cwd || context.workspace?.cwd || null;
}

function cwdFromPaneId(paneId, runHerdrFn) {
  const result = runHerdrFn(['pane', 'get', paneId]);
  if (result === null || typeof result !== 'object') {
    return null;
  }
  // The payload may nest the pane under 'pane' or be the pane object itself.
  const pane = result.pane && typeof result.pane === 'object' ? result.pane : result;
  return pane.foreground_cwd || pane.cwd || null;
}

function resolveTargetDirectory({ env, runHerdrFn, fallbackCwd }) {
  if (env.HERDR_PLUGIN_CONTEXT_JSON) {
    const contextCwd = cwdFromContextJson(env.HERDR_PLUGIN_CONTEXT_JSON);
    if (contextCwd) {
      return contextCwd;
    }
  }

  if (env.HERDR_PANE_ID) {
    const paneCwd = cwdFromPaneId(env.HERDR_PANE_ID, runHerdrFn);
    if (paneCwd) {
      return paneCwd;
    }
  }

  return fallbackCwd();
}

module.exports = { cwdFromContextJson, cwdFromPaneId, resolveTargetDirectory };
