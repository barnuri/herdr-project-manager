'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { stateDir } = require('./cache');

const LOCK_DIR_NAME = 'ensure.lock';
const STALE_LOCK_MS = 30000;
const LOCK_WAIT_ATTEMPTS = 5;
const LOCK_WAIT_DELAY_MS = 100;

const DOCKED_PANES_FILE_NAME = 'docked-panes.json';
const SNOOZED_TABS_FILE_NAME = 'snoozed-tabs.json';
const HEARTBEATS_DIR_NAME = 'heartbeats';

const HEARTBEAT_INTERVAL_MS = 4000;
const HEARTBEAT_STALE_AFTER_MS = 12000;
const DOCK_GRACE_PERIOD_MS = 15000;

function lockPath() {
  return path.join(stateDir(), LOCK_DIR_NAME);
}

function isLockStale(lockDir) {
  let stat;
  try {
    stat = fs.statSync(lockDir);
  } catch {
    return false;
  }
  return Date.now() - stat.mtimeMs >= STALE_LOCK_MS;
}

function tryAcquireLock(lockDir) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.mkdirSync(lockDir);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') {
      return false;
    }
  }

  if (!isLockStale(lockDir)) {
    return false;
  }

  try {
    fs.rmdirSync(lockDir);
  } catch {
    return false;
  }

  try {
    fs.mkdirSync(lockDir);
    return true;
  } catch {
    return false;
  }
}

function releaseLock(lockDir) {
  try {
    fs.rmdirSync(lockDir);
  } catch {
    // already released or never created; nothing to clean up
  }
}

function sleepSync(ms) {
  // Blocking sleep with no dependency: Atomics.wait on a private buffer
  // nobody else ever notifies, so it always waits the full timeout.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(fn, { wait = false } = {}) {
  const lockDir = lockPath();
  let acquired = tryAcquireLock(lockDir);

  for (let attempt = 0; wait && !acquired && attempt < LOCK_WAIT_ATTEMPTS; attempt += 1) {
    sleepSync(LOCK_WAIT_DELAY_MS);
    acquired = tryAcquireLock(lockDir);
  }

  if (!acquired) {
    return;
  }

  try {
    fn();
  } finally {
    releaseLock(lockDir);
  }
}

function readJsonMap(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed;
}

function writeJsonMap(filePath, map) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(map)}\n`, 'utf8');
  } catch (error) {
    process.stderr.write(`project-manager: failed to write ${path.basename(filePath)}: ${error.message}\n`);
  }
}

function dockedPanesPath() {
  return path.join(stateDir(), DOCKED_PANES_FILE_NAME);
}

function dockedPaneId(tabId) {
  return readJsonMap(dockedPanesPath())[tabId];
}

function setDockedPane(tabId, paneId, dockedAt) {
  const map = readJsonMap(dockedPanesPath());
  map[tabId] = { paneId, dockedAt };
  writeJsonMap(dockedPanesPath(), map);
}

function clearDockedPane(tabId) {
  const map = readJsonMap(dockedPanesPath());
  delete map[tabId];
  writeJsonMap(dockedPanesPath(), map);
}

function snoozedTabsPath() {
  return path.join(stateDir(), SNOOZED_TABS_FILE_NAME);
}

function isSnoozed(tabId) {
  return readJsonMap(snoozedTabsPath())[tabId] === true;
}

function setSnoozed(tabId) {
  const map = readJsonMap(snoozedTabsPath());
  map[tabId] = true;
  writeJsonMap(snoozedTabsPath(), map);
}

function clearSnoozed(tabId) {
  const map = readJsonMap(snoozedTabsPath());
  delete map[tabId];
  writeJsonMap(snoozedTabsPath(), map);
}

function findRightmostPane(panes) {
  if (!Array.isArray(panes) || panes.length === 0) {
    return null;
  }
  return panes.reduce((rightmost, pane) =>
    pane.rect.x + pane.rect.width > rightmost.rect.x + rightmost.rect.width ? pane : rightmost
  );
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function computeSplitRatio({ targetWidth, tabWidth, desiredFraction = 0.25, minColumns = 28, maxColumns = 50 } = {}) {
  if (targetWidth < minColumns + 10) {
    return null;
  }
  const desiredCols = clamp(desiredFraction * tabWidth, minColumns, maxColumns);
  return clamp((targetWidth - desiredCols) / targetWidth, 0.1, 0.9);
}

function heartbeatPath(paneId) {
  return path.join(stateDir(), HEARTBEATS_DIR_NAME, `${encodeURIComponent(paneId)}.json`);
}

function writeHeartbeat(paneId, { pid, ts }) {
  try {
    fs.mkdirSync(path.join(stateDir(), HEARTBEATS_DIR_NAME), { recursive: true });
    fs.writeFileSync(heartbeatPath(paneId), `${JSON.stringify({ pid, ts })}\n`, 'utf8');
  } catch (error) {
    process.stderr.write(`project-manager: failed to write heartbeat: ${error.message}\n`);
  }
}

function readHeartbeat(paneId) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(heartbeatPath(paneId), 'utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  return parsed;
}

function decideEnsureAction({
  panes,
  tabId,
  docked,
  now,
  heartbeatStaleAfterMs,
  dockGracePeriodMs,
  readHeartbeatFn = readHeartbeat,
} = {}) {
  if (docked === null || docked === undefined) {
    return 'open';
  }

  const paneStillPresent = Array.isArray(panes) && panes.some((pane) => pane.pane_id === docked.paneId);
  if (!paneStillPresent) {
    return 'open';
  }

  if (now - docked.dockedAt < dockGracePeriodMs) {
    return 'noop';
  }

  const heartbeat = readHeartbeatFn(docked.paneId);
  if (heartbeat && now - heartbeat.ts <= heartbeatStaleAfterMs) {
    return 'noop';
  }

  return 'replace';
}

module.exports = {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_AFTER_MS,
  DOCK_GRACE_PERIOD_MS,
  withLock,
  dockedPaneId,
  setDockedPane,
  clearDockedPane,
  isSnoozed,
  setSnoozed,
  clearSnoozed,
  findRightmostPane,
  computeSplitRatio,
  heartbeatPath,
  writeHeartbeat,
  readHeartbeat,
  decideEnsureAction,
};
