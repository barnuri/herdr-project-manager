'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { expandHomePath } = require('./paths');

const GLOB_SOURCE = 'glob';
const MANUAL_SOURCE = 'manual';
const GIT_DIR_BASENAME = '.git';

// An exclude entry beats every glob: a pattern is matched against the resolved project
// directory, and a plain directory path (no glob metacharacters to match with) drops the
// whole tree beneath it, so `~/x/groups` needs no `/**` suffix to hide what's inside it.
function isExcluded(projectPath, excludes) {
  if (!Array.isArray(excludes)) {
    return false;
  }
  const resolvedProject = path.resolve(projectPath);
  for (const pattern of excludes) {
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      continue;
    }
    const expandedPattern = expandHomePath(pattern);
    try {
      if (path.matchesGlob(resolvedProject, expandedPattern)) {
        return true;
      }
    } catch {
      // an unparseable pattern only disables its own glob matching, never the prefix rule
    }
    const resolvedPattern = path.resolve(expandedPattern);
    if (resolvedProject === resolvedPattern || resolvedProject.startsWith(`${resolvedPattern}${path.sep}`)) {
      return true;
    }
  }
  return false;
}

async function isExistingDirectory(candidatePath) {
  try {
    const stats = await fs.promises.stat(candidatePath);
    return stats.isDirectory();
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

// Async/non-blocking on purpose: a broad recursive glob (e.g. `**/.git` over a large
// tree) can take tens of seconds. The sync version froze the whole picker — no
// rendering, no keystrokes, no heartbeat writes — for the entire scan, which is what
// made a fresh dock look "stuck" and, worse, let it go heartbeat-stale and get replaced
// by ensure-picker.js before it ever finished starting up.
async function discoverProjects(globs, excludes = []) {
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
      matches = await Array.fromAsync(fs.promises.glob(expandHomePath(globPattern)));
    } catch (error) {
      process.stderr.write(`discover: glob "${globPattern}" failed: ${error.message}\n`);
      continue;
    }

    for (const match of matches) {
      const projectDir = resolveProjectDir(match);
      if (projectsByPath.has(projectDir) || isExcluded(projectDir, excludes)) {
        continue;
      }
      if (!(await isExistingDirectory(projectDir))) {
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

// Two different real directories can share a basename (e.g. a nested clone under a
// tool's own working tree next to the top-level repo of the same name) — appending
// enough of the parent path to every member of a same-name group tells them apart.
// A single parent segment isn't always enough: two colliding entries can also share
// their immediate parent's name (e.g. both nested under a directory literally called
// "repos" at different grandparent paths), so widen one segment at a time until the
// group's suffixes are actually distinct — mergeProjects has already deduped by
// resolved path before this runs, so distinct full paths guarantee this always
// terminates.
function disambiguateNames(projects) {
  const groups = new Map();
  for (const project of projects) {
    if (!groups.has(project.name)) {
      groups.set(project.name, []);
    }
    groups.get(project.name).push(project);
  }

  const renamed = new Map();
  for (const group of groups.values()) {
    if (group.length <= 1) {
      continue;
    }
    const parentSegments = group.map((project) => path.dirname(project.path).split(path.sep).filter(Boolean));
    const maxDepth = Math.max(...parentSegments.map((segments) => segments.length));

    let depth = 1;
    let suffixes;
    do {
      suffixes = parentSegments.map((segments) => segments.slice(-depth).join(path.sep));
      depth += 1;
    } while (new Set(suffixes).size < suffixes.length && depth <= maxDepth);

    group.forEach((project, index) => {
      renamed.set(project, `${project.name} (${suffixes[index]})`);
    });
  }

  return projects.map((project) => (renamed.has(project) ? { ...project, name: renamed.get(project) } : project));
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

  const sorted = [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
  return disambiguateNames(sorted);
}

module.exports = { discoverProjects, isExcluded, mergeProjects };
