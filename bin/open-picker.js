#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

const { listPanes, paneClose } = require('../lib/herdr');
const {
    withLock,
    dockedPaneId,
    setDockedPane,
    clearDockedPane,
    setSnoozed,
    clearSnoozed,
} = require('../lib/dock');

const DEFAULT_PLUGIN_ID = 'barnuri.project-manager';
const PICKER_ENTRYPOINT = 'picker';

// The declarative `plugin pane open` call isn't a generic pane primitive, so it
// doesn't belong in lib/herdr.js — keep its ad hoc JSON parsing local to this call.
function openPluginPane(pluginId) {
    const binary = process.env.HERDR_BIN_PATH || 'herdr';
    const child = spawnSync(
        binary,
        ['plugin', 'pane', 'open', '--plugin', pluginId, '--entrypoint', PICKER_ENTRYPOINT],
        { encoding: 'utf8' }
    );
    if (child.error || child.status !== 0) {
        return null;
    }
    try {
        return JSON.parse(child.stdout).result;
    } catch {
        return null;
    }
}

// toggle: first invocation in a tab opens the sidebar there, the next one closes it
function togglePicker() {
    let lockAcquired = false;
    let exitCode = 0;

    withLock(
        () => {
            lockAcquired = true;

            try {
                const panes = listPanes();
                const focused = panes.find((pane) => pane.focused);
                if (!focused) {
                    process.stderr.write('open-picker: no focused pane; cannot determine active tab\n');
                    exitCode = 1;
                    return;
                }
                const tabId = focused.tab_id;

                const docked = dockedPaneId(tabId);
                if (docked && panes.some((pane) => pane.pane_id === docked.paneId)) {
                    try {
                        paneClose(docked.paneId);
                    } catch {
                        // pane already gone; nothing to close
                    }
                    clearDockedPane(tabId);
                    setSnoozed(tabId);
                    return;
                }

                clearSnoozed(tabId);

                const pluginId = process.env.HERDR_PLUGIN_ID || DEFAULT_PLUGIN_ID;
                const opened = openPluginPane(pluginId);
                if (opened === null) {
                    process.stderr.write('open-picker: failed to open the picker pane\n');
                    exitCode = 1;
                    return;
                }
                const paneId = opened.plugin_pane?.pane?.pane_id || opened.pane?.pane_id || opened.pane_id || null;
                if (paneId) {
                    setDockedPane(tabId, paneId, Date.now());
                }
            } catch (error) {
                process.stderr.write(`open-picker: ${error.message}\n`);
                exitCode = 1;
            }
        },
        { wait: true }
    );

    if (!lockAcquired) {
        process.stderr.write('open-picker: could not acquire lock; a concurrent operation is in progress\n');
        return 1;
    }

    return exitCode;
}

if (require.main === module) {
    process.exitCode = togglePicker();
}

module.exports = { togglePicker };
