#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

const DEFAULT_PLUGIN_ID = 'barnuri.project-manager';
const PICKER_ENTRYPOINT = 'picker';

function openPicker() {
    const herdrBin = process.env.HERDR_BIN_PATH || 'herdr';
    const pluginId = process.env.HERDR_PLUGIN_ID || DEFAULT_PLUGIN_ID;
    const args = ['plugin', 'pane', 'open', '--plugin', pluginId, '--entrypoint', PICKER_ENTRYPOINT];

    const child = spawnSync(herdrBin, args, { stdio: 'inherit' });
    if (child.error) {
        process.stderr.write(`failed to run ${herdrBin}: ${child.error.message}\n`);
        return 1;
    }
    if (child.status === null) {
        process.stderr.write(`${herdrBin} terminated by signal ${child.signal}\n`);
        return 1;
    }
    return child.status;
}

if (require.main === module) {
    process.exitCode = openPicker();
}

module.exports = { openPicker };
