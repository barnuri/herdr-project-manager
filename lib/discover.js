'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { expandHomePath } = require('./paths');

const GLOB_SOURCE = 'glob';
const MANUAL_SOURCE = 'manual';
const GIT_DIR_BASENAME = '.git';

function isExistingDirectory(candidatePath) {
  try {
    return fs.statSync(candidatePath).isDirectory();
  } catch {
    return false;
  }
}

function resolveProjectDir(matchPath) {
  // A glob like '~/repos/*/.git' matches the .git entry; the project is its parent.
  if (path.basename(matchPath) === GIT_DIR_BASENAME) {
    return path.dirname(matchPath);
  }
  return matchPath;
}

function discoverProjects(globs) {
  if (!Array.isArray(globs)) {
    return [];
  }

  const projectsByPath = new Map();

  for (const globPattern of globs) {
    if (typeof globPattern !== 'string' || globPattern.length === 0) {
      continue;
    }

    let matches;
    try {
      matches = fs.globSync(expandHomePath(globPattern));
    } catch (error) {
      process.stderr.write(`discover: glob "${globPattern}" failed: ${error.message}\n`);
      continue;
    }

    for (const match of matches) {
      const projectDir = resolveProjectDir(match);
      if (projectsByPath.has(projectDir) || !isExistingDirectory(projectDir)) {
        continue;
      }
      projectsByPath.set(projectDir, {
        name: path.basename(projectDir),
        path: projectDir,
        source: GLOB_SOURCE,
      });
    }
  }

  return [...projectsByPath.values()];
}

function mergeProjects(manualProjects, discoveredProjects) {
  const manual = Array.isArray(manualProjects) ? manualProjects : [];
  const discovered = Array.isArray(discoveredProjects) ? discoveredProjects : [];

  const merged = new Map();
  for (const project of manual) {
    merged.set(path.resolve(project.path), { ...project, source: MANUAL_SOURCE });
  }
  for (const project of discovered) {
    const resolvedPath = path.resolve(project.path);
    if (!merged.has(resolvedPath)) {
      merged.set(resolvedPath, project);
    }
  }

  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

module.exports = { discoverProjects, mergeProjects };
