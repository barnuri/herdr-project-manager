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

module.exports = { runHerdr, runHerdrText, openTab, openWorkspace, notify };
