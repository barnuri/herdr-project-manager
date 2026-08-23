'use strict';

const { spawnSync } = require('node:child_process');

const DEFAULT_HERDR_BINARY = 'herdr';

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function spawnHerdr(args) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new TypeError('args must be a non-empty array of strings');
  }

  const binary = process.env.HERDR_BIN_PATH || DEFAULT_HERDR_BINARY;
  const spawned = spawnSync(binary, args, { encoding: 'utf8' });

  if (spawned.error) {
    throw new Error(`failed to spawn ${binary}: ${spawned.error.message}`);
  }
  if (spawned.status !== 0) {
    const stderr = (spawned.stderr || '').trim();
    throw new Error(`herdr ${args.join(' ')} exited with code ${spawned.status}${stderr ? `: ${stderr}` : ''}`);
  }

  return spawned;
}

function runHerdr(args) {
  const { stdout } = spawnHerdr(args);

  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error(
      `herdr ${args.join(' ')} did not print a JSON envelope (expected {"id", "result"}); got: ${stdout.trim()}`
    );
  }

  return envelope.result;
}

function runHerdrText(args) {
  return spawnHerdr(args).stdout;
}

function openTab({ cwd, label } = {}) {
  assertNonEmptyString(cwd, 'cwd');
  assertNonEmptyString(label, 'label');
  return runHerdr(['tab', 'create', '--cwd', cwd, '--label', label, '--focus']);
}

function openWorkspace({ cwd, label } = {}) {
  assertNonEmptyString(cwd, 'cwd');
  assertNonEmptyString(label, 'label');
  return runHerdr(['workspace', 'create', '--cwd', cwd, '--label', label, '--focus']);
}

function notify(title, body) {
  assertNonEmptyString(title, 'title');
  assertNonEmptyString(body, 'body');

  // Notifications are best-effort: a failed toast must never break the caller.
  try {
    runHerdrText(['notification', 'show', title, '--body', body]);
  } catch (error) {
    process.stderr.write(`herdr notification failed: ${error.message}\n`);
  }
}

function listPanes({ workspace } = {}) {
  const args = ['pane', 'list'];
  if (workspace) {
    args.push('--workspace', workspace);
  }
  return runHerdr(args).panes;
}

function paneLayout({ pane } = {}) {
  assertNonEmptyString(pane, 'pane');
  return runHerdr(['pane', 'layout', '--pane', pane]).layout;
}

function paneSplit({ pane, direction, ratio, noFocus = true } = {}) {
  assertNonEmptyString(pane, 'pane');
  assertNonEmptyString(direction, 'direction');
  if (typeof ratio !== 'number' || Number.isNaN(ratio)) {
    throw new TypeError('ratio must be a number');
  }

  const args = ['pane', 'split', pane, '--direction', direction, '--ratio', String(ratio)];
  if (noFocus) {
    args.push('--no-focus');
  }

  return runHerdr(args).pane.pane_id;
}

// Unlike list/split/layout/rename/close, `pane run` prints no JSON envelope on
// success — confirmed live: exit 0 with empty stdout. Parsing it as JSON (like
// runHerdr does) throws on every single call regardless of whether the command
// was actually typed into the pane correctly, which is what caused ensure-picker.js
// to log a false "crash" on every dock and skip the cosmetic paneRename step after it.
function paneRun(paneId, command) {
  assertNonEmptyString(paneId, 'paneId');
  assertNonEmptyString(command, 'command');
  runHerdrText(['pane', 'run', paneId, command]);
}

function paneRename(paneId, label) {
  assertNonEmptyString(paneId, 'paneId');
  assertNonEmptyString(label, 'label');
  return runHerdr(['pane', 'rename', paneId, label]);
}

function paneClose(paneId) {
  assertNonEmptyString(paneId, 'paneId');
  return runHerdr(['pane', 'close', paneId]);
}

module.exports = {
  runHerdr,
  runHerdrText,
  openTab,
  openWorkspace,
  notify,
  listPanes,
  paneLayout,
  paneSplit,
  paneRun,
  paneRename,
  paneClose,
};
