#!/usr/bin/env node
'use strict';

const { loadConfig, saveConfig, toggleAutoOpen, isAutoOpenEnabled } = require('../lib/config');
const { notify } = require('../lib/herdr');

const NOTIFICATION_TITLE = 'Project Manager';

function main() {
  const updatedConfig = toggleAutoOpen(loadConfig());
  saveConfig(updatedConfig);

  // Only the auto-docking behaviour changes: an already-docked sidebar stays put until
  // it is closed manually (Ctrl+Q or the toggle action), and `ensure-picker` simply
  // stops re-docking it on the next tab/pane event.
  const state = isAutoOpenEnabled(updatedConfig) ? 'on' : 'off';
  notify(NOTIFICATION_TITLE, `Auto-open sidebar: ${state}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`toggle-auto-open failed: ${error.message}\n`);
  process.exit(1);
}
