'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { stateDir } = require('./cache');

const LOG_FILE_NAME = 'error.log';
const MAX_LOG_BYTES = 1024 * 1024;

function logPath() {
  return path.join(stateDir(), LOG_FILE_NAME);
}

// Appends one line per error, with a timestamp/pid/component prefix and the
// full stack when available. Truncates the file once it exceeds MAX_LOG_BYTES
// instead of growing forever. Logging itself must never throw — a broken log
// write must not crash the very error path that's trying to report a crash.
function logError(component, error) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const target = logPath();
    const existingSize = fs.existsSync(target) ? fs.statSync(target).size : 0;
    if (existingSize > MAX_LOG_BYTES) {
      fs.writeFileSync(target, '', 'utf8');
    }
    const timestamp = new Date().toISOString();
    const detail = error && error.stack ? error.stack : String(error);
    fs.appendFileSync(target, `[${timestamp}] [pid ${process.pid}] [${component}] ${detail}\n`, 'utf8');
  } catch {
    // logging must never itself crash the caller
  }
}

module.exports = { logPath, logError };
