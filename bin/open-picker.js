#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { stateDir } = require('../lib/cache');

const DEFAULT_PLUGIN_ID = 'barnuri.project-manager';
const PICKER_ENTRYPOINT = 'picker';
const PANE_STATE_FILE = 'sidebar-pane-id';

function herdrBinaryPath() {
    return process.env.HERDR_BIN_PATH || 'herdr';
}

function runHerdrJson(args) {
    const child = spawnSync(herdrBinaryPath(), args, { encoding: 'utf8' });
    if (child.error || child.status !== 0) {
        return null;
    }
    try {
        return JSON.parse(child.stdout).result;
    } catch {
        return null;
    }
}

function paneStatePath() {
    return path.join(stateDir(), PANE_STATE_FILE);
}

function storedPaneId() {
    try {
        return fs.readFileSync(paneStatePath(), 'utf8').trim() || null;
    } catch {
        return null;
    }
}

function storePaneId(paneId) {
    try {
        fs.mkdirSync(stateDir(), { recursive: true });
        fs.writeFileSync(paneStatePath(), `${paneId}\n`, 'utf8');
    } catch (error) {
        process.stderr.write(`open-picker: failed to store pane id: ${error.message}\n`);
    }
}

function clearPaneId() {
    try {
        fs.unlinkSync(paneStatePath());
    } catch {}
}

function paneIsOpen(paneId) {
    return runHerdrJson(['pane', 'get', paneId]) !== null;
}

// toggle: first invocation opens the sidebar, the next one closes it
function togglePicker() {
    const existing = storedPaneId();
    if (existing && paneIsOpen(existing)) {
        runHerdrJson(['pane', 'close', existing]);
        clearPaneId();
        return 0;
    }
    clearPaneId();

    const pluginId = process.env.HERDR_PLUGIN_ID || DEFAULT_PLUGIN_ID;
    const opened = runHerdrJson(['plugin', 'pane', 'open', '--plugin', pluginId, '--entrypoint', PICKER_ENTRYPOINT]);
    if (opened === null) {
        process.stderr.write('open-picker: failed to open the picker pane\n');
        return 1;
    }
    const paneId = opened.plugin_pane?.pane?.pane_id || opened.pane?.pane_id || opened.pane_id || null;
    if (paneId) {
        storePaneId(paneId);
    }
    return 0;
}

if (require.main === module) {
    process.exitCode = togglePicker();
}

module.exports = { togglePicker };
