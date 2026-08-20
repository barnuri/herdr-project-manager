#!/usr/bin/env node
'use strict';

const path = require('node:path');

const { loadConfig, saveConfig, addProject } = require('../lib/config');
const { resolveTargetDirectory } = require('../lib/context');
const { runHerdr, notify } = require('../lib/herdr');

const NOTIFICATION_TITLE = 'Project Manager';

function main() {
  const targetDirectory = resolveTargetDirectory({
    env: process.env,
    runHerdrFn: runHerdr,
    fallbackCwd: () => process.cwd(),
  });
  const projectName = path.basename(targetDirectory);

  const config = loadConfig();
  const updatedConfig = addProject(config, { name: projectName, path: targetDirectory });

  // addProject returns the same object when the path is already tracked.
  if (updatedConfig === config) {
    notify(NOTIFICATION_TITLE, `${targetDirectory} already tracked`);
    return;
  }

  saveConfig(updatedConfig);
  notify(NOTIFICATION_TITLE, `Added ${projectName}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`add-current failed: ${error.message}\n`);
  process.exit(1);
}
