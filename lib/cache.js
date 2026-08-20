'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CACHE_FILE_NAME = 'projects-cache.json';

function stateDir() {
  if (process.env.HERDR_PLUGIN_STATE_DIR) {
    return process.env.HERDR_PLUGIN_STATE_DIR;
  }
  return path.join(os.homedir(), '.local', 'state', 'herdr-project-manager');
}

function cachePath() {
  return path.join(stateDir(), CACHE_FILE_NAME);
}

function loadProjectCache() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(
    (entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string' && typeof entry.name === 'string'
  );
}

function saveProjectCache(projects) {
  if (!Array.isArray(projects)) {
    return;
  }
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(cachePath(), `${JSON.stringify(projects)}\n`, 'utf8');
  } catch (error) {
    process.stderr.write(`project-manager: failed to write cache: ${error.message}\n`);
  }
}

module.exports = { stateDir, cachePath, loadProjectCache, saveProjectCache };
