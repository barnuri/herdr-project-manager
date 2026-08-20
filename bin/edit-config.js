#!/usr/bin/env node
'use strict';

const { loadConfig, saveConfig, configPath, configDir } = require('../lib/config');
const { runHerdr, runHerdrText, notify } = require('../lib/herdr');

const NOTIFICATION_TITLE = 'Project Manager';
const CONFIG_TAB_LABEL = 'pm-config';
const DEFAULT_EDITOR = 'vi';

// 'pane run' takes a single shell command string, so the path must be quoted.
function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function findPaneId(created) {
  if (created === null || typeof created !== 'object') {
    return null;
  }
  // 'tab create' payloads have shipped both flat and nested pane ids.
  return created.pane_id || created.tab?.pane_id || created.panes?.[0]?.pane_id || null;
}

function main() {
  // Materialize the config file (with defaults) so the editor has something to open.
  saveConfig(loadConfig());

  const created = runHerdr(['tab', 'create', '--cwd', configDir(), '--label', CONFIG_TAB_LABEL, '--focus']);
  const paneId = findPaneId(created);

  if (!paneId) {
    notify(NOTIFICATION_TITLE, `Config: ${configPath()}`);
    return;
  }

  const editor = process.env.EDITOR || DEFAULT_EDITOR;
  runHerdrText(['pane', 'run', paneId, `${editor} ${shellQuote(configPath())}`]);
}

try {
  main();
} catch (error) {
  process.stderr.write(`edit-config failed: ${error.message}\n`);
  process.exit(1);
}
