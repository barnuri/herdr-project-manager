'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { expandHomePath } = require('./paths');

const CONFIG_FILE_NAME = 'projects.json';
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
  return { globs: [], projects: [] };
}

function normalizeConfig(rawConfig) {
  if (rawConfig === null || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    return null;
  }

  const globs = Array.isArray(rawConfig.globs)
    ? rawConfig.globs.filter((glob) => typeof glob === 'string')
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

  return { globs, projects };
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

function addGlob(config, globPattern) {
  if (typeof globPattern !== 'string' || globPattern.trim() === '') {
    return config;
  }
  if (config.globs.includes(globPattern)) {
    return config;
  }
  return { ...config, globs: [...config.globs, globPattern] };
}

function removeGlob(config, globPattern) {
  return { ...config, globs: config.globs.filter((glob) => glob !== globPattern) };
}

// Replaces oldGlobPattern with newGlobPattern in place (preserving its position in the
// list), dropping any other entry already equal to newGlobPattern to keep the dedupe
// guarantee addGlob provides.
function updateGlob(config, oldGlobPattern, newGlobPattern) {
  if (typeof newGlobPattern !== 'string' || newGlobPattern.trim() === '') {
    return config;
  }
  if (newGlobPattern === oldGlobPattern) {
    return config;
  }
  const globs = config.globs
    .filter((glob) => glob !== newGlobPattern)
    .map((glob) => (glob === oldGlobPattern ? newGlobPattern : glob));
  return { ...config, globs };
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
};
