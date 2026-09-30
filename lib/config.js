'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { expandHomePath } = require('./paths');

const CONFIG_FILE_NAME = 'projects.json';
// Auto-docking the sidebar is opt-out: a config written before this key existed,
// or one with a non-boolean value, keeps the original always-open behaviour.
const DEFAULT_AUTO_OPEN = true;
const JSON_INDENT = 2;

// Corrupt-config warning is emitted at most once per process.
let hasWarnedAboutInvalidConfig = false;

function configDir() {
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) {
    return process.env.HERDR_PLUGIN_CONFIG_DIR;
  }
  return path.join(os.homedir(), '.config', 'herdr-project-manager');
}

function configPath() {
  return path.join(configDir(), CONFIG_FILE_NAME);
}

function defaultConfig() {
  return { globs: [], excludes: [], projects: [], autoOpen: DEFAULT_AUTO_OPEN };
}

function normalizeConfig(rawConfig) {
  if (rawConfig === null || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    return null;
  }

  const globs = Array.isArray(rawConfig.globs)
    ? rawConfig.globs.filter((glob) => typeof glob === 'string')
    : [];

  const excludes = Array.isArray(rawConfig.excludes)
    ? rawConfig.excludes.filter((exclude) => typeof exclude === 'string')
    : [];

  const rawProjects = Array.isArray(rawConfig.projects) ? rawConfig.projects : [];
  const projects = [];
  for (const entry of rawProjects) {
    if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string') {
      continue;
    }
    const projectPath = expandHomePath(entry.path);
    const name = typeof entry.name === 'string' && entry.name !== ''
      ? entry.name
      : path.basename(projectPath);
    projects.push({ name, path: projectPath });
  }

  const autoOpen = typeof rawConfig.autoOpen === 'boolean' ? rawConfig.autoOpen : DEFAULT_AUTO_OPEN;

  return { globs, excludes, projects, autoOpen };
}

function warnInvalidConfigOnce(reason) {
  if (hasWarnedAboutInvalidConfig) {
    return;
  }
  hasWarnedAboutInvalidConfig = true;
  process.stderr.write(`herdr-project-manager: ignoring invalid config at ${configPath()} (${reason}); using defaults\n`);
}

function loadConfig() {
  let fileContents;
  try {
    fileContents = fs.readFileSync(configPath(), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      warnInvalidConfigOnce(error.message);
    }
    return defaultConfig();
  }

  let parsed;
  try {
    parsed = JSON.parse(fileContents);
  } catch (error) {
    warnInvalidConfigOnce(error.message);
    return defaultConfig();
  }

  const normalized = normalizeConfig(parsed);
  if (normalized === null) {
    warnInvalidConfigOnce('not a config object');
    return defaultConfig();
  }
  return normalized;
}

function saveConfig(config) {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), `${JSON.stringify(config, null, JSON_INDENT)}\n`, 'utf8');
}

function isAutoOpenEnabled(config) {
  return typeof config?.autoOpen === 'boolean' ? config.autoOpen : DEFAULT_AUTO_OPEN;
}

function setAutoOpen(config, autoOpen) {
  return { ...config, autoOpen: Boolean(autoOpen) };
}

function toggleAutoOpen(config) {
  return setAutoOpen(config, !isAutoOpenEnabled(config));
}

function addProject(config, { name, path: projectPath }) {
  const expandedPath = expandHomePath(projectPath);
  const resolvedPath = path.resolve(expandedPath);

  const alreadyPresent = config.projects.some(
    (project) => path.resolve(project.path) === resolvedPath
  );
  if (alreadyPresent) {
    return config;
  }

  const projectName = typeof name === 'string' && name !== '' ? name : path.basename(expandedPath);
  return {
    ...config,
    projects: [...config.projects, { name: projectName, path: expandedPath }],
  };
}

function removeProject(config, projectPath) {
  const resolvedPath = path.resolve(expandHomePath(projectPath));
  return {
    ...config,
    projects: config.projects.filter(
      (project) => path.resolve(project.path) !== resolvedPath
    ),
  };
}

// globs and excludes are both plain, deduped pattern lists, so the add/remove/update
// rules live here once and each list gets a named wrapper below.
function addPattern(config, listKey, pattern) {
  if (typeof pattern !== 'string' || pattern.trim() === '') {
    return config;
  }
  if (config[listKey].includes(pattern)) {
    return config;
  }
  return { ...config, [listKey]: [...config[listKey], pattern] };
}

function removePattern(config, listKey, pattern) {
  return { ...config, [listKey]: config[listKey].filter((entry) => entry !== pattern) };
}

// Replaces oldPattern with newPattern in place (preserving its position in the list),
// dropping any other entry already equal to newPattern to keep the dedupe guarantee
// addPattern provides.
function updatePattern(config, listKey, oldPattern, newPattern) {
  if (typeof newPattern !== 'string' || newPattern.trim() === '') {
    return config;
  }
  if (newPattern === oldPattern) {
    return config;
  }
  const patterns = config[listKey]
    .filter((entry) => entry !== newPattern)
    .map((entry) => (entry === oldPattern ? newPattern : entry));
  return { ...config, [listKey]: patterns };
}

function addGlob(config, globPattern) {
  return addPattern(config, 'globs', globPattern);
}

function removeGlob(config, globPattern) {
  return removePattern(config, 'globs', globPattern);
}

function updateGlob(config, oldGlobPattern, newGlobPattern) {
  return updatePattern(config, 'globs', oldGlobPattern, newGlobPattern);
}

function addExclude(config, excludePattern) {
  return addPattern(config, 'excludes', excludePattern);
}

function removeExclude(config, excludePattern) {
  return removePattern(config, 'excludes', excludePattern);
}

function updateExclude(config, oldExcludePattern, newExcludePattern) {
  return updatePattern(config, 'excludes', oldExcludePattern, newExcludePattern);
}

// Replaces the project at oldProjectPath with newProjectPath in place, re-deriving the
// name from the new path's basename (mirroring addProject's convention), and dropping
// any other entry already resolving to newProjectPath to preserve the dedupe guarantee.
function updateProject(config, oldProjectPath, newProjectPath) {
  const resolvedOld = path.resolve(expandHomePath(oldProjectPath));
  const expandedNew = expandHomePath(newProjectPath);
  const resolvedNew = path.resolve(expandedNew);
  if (resolvedNew === resolvedOld) {
    return config;
  }
  const projectName = path.basename(expandedNew);
  const projects = config.projects
    .filter((project) => path.resolve(project.path) !== resolvedNew)
    .map((project) =>
      path.resolve(project.path) === resolvedOld ? { name: projectName, path: expandedNew } : project
    );
  return { ...config, projects };
}

module.exports = {
  DEFAULT_AUTO_OPEN,
  isAutoOpenEnabled,
  setAutoOpen,
  toggleAutoOpen,
  configDir,
  configPath,
  defaultConfig,
  loadConfig,
  saveConfig,
  addProject,
  removeProject,
  updateProject,
  addGlob,
  removeGlob,
  updateGlob,
  addExclude,
  removeExclude,
  updateExclude,
};
