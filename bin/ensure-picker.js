#!/usr/bin/env node
'use strict';

const path = require('node:path');

const {
    withLock,
    dockedPaneId,
    setDockedPane,
    isSnoozed,
    findRightmostPane,
    computeSplitRatio,
    decideEnsureAction,
    readHeartbeat,
    HEARTBEAT_STALE_AFTER_MS,
    DOCK_GRACE_PERIOD_MS,
} = require('../lib/dock');
const { listPanes, paneLayout, paneSplit, paneRun, paneRename, paneClose } = require('../lib/herdr');
const { loadConfig, isAutoOpenEnabled } = require('../lib/config');
const { logError } = require('../lib/log');

const PICKER_SCRIPT_PATH = path.join(__dirname, 'picker.js');
const DOCKED_PANE_LABEL = 'Projects';
const FORWARDED_ENV_VARS = ['HERDR_PLUGIN_CONFIG_DIR', 'HERDR_PLUGIN_STATE_DIR'];

// `pane run` types a plain shell command into a fresh, plugin-agnostic pane —
// herdr injects HERDR_PLUGIN_CONFIG_DIR/HERDR_PLUGIN_STATE_DIR into THIS
// script (an [[events]] hook) but not into that shell, so picker.js would
// otherwise fall back to the wrong config/state paths and show no projects.
function shQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function buildPickerCommand(newPaneId) {
    const envAssignments = FORWARDED_ENV_VARS.filter((name) => process.env[name]).map(
        (name) => `${name}=${shQuote(process.env[name])}`
    );
    envAssignments.push(`HERDR_PANE_ID=${shQuote(newPaneId)}`);
    return `${envAssignments.join(' ')} node ${shQuote(PICKER_SCRIPT_PATH)}`;
}

// A pane is unambiguously ours if it has ever written a heartbeat file:
// picker.js is the only thing that calls writeHeartbeat, and only for its
// own pane id. This is the ground truth for "is there a stray/duplicate
// picker pane in this tab" — NOT `pane rename`'s label, which was observed
// live to not reliably show up in `pane list` output for freshly split
// panes, silently defeating a label-based duplicate check entirely (every
// event then saw zero "docked" panes and redocked unconditionally, with no
// grace-period protection at all — the exact "infinite panels" incident
// this comment is here to warn against repeating).
function closeStrayPickerPanes(panes, tabId, keepPaneId) {
    for (const pane of panes) {
        if (pane.tab_id !== tabId || pane.pane_id === keepPaneId) {
            continue;
        }
        if (!readHeartbeat(pane.pane_id)) {
            continue;
        }
        try {
            paneClose(pane.pane_id);
        } catch {
            // already gone, fine
        }
    }
}

function runEnsure() {
    // Read fresh on every event: the setting is flipped by a one-shot action or by an
    // already-running picker pane, neither of which can reach into this process.
    if (!isAutoOpenEnabled(loadConfig())) {
        return;
    }

    const now = Date.now();
    const panes = listPanes();
    const focused = panes.find((pane) => pane.focused);
    if (!focused) {
        return;
    }

    const tabId = focused.tab_id;
    if (isSnoozed(tabId)) {
        return;
    }

    const docked = dockedPaneId(tabId);
    const action = decideEnsureAction({
        panes,
        tabId,
        docked,
        now,
        heartbeatStaleAfterMs: HEARTBEAT_STALE_AFTER_MS,
        dockGracePeriodMs: DOCK_GRACE_PERIOD_MS,
    });
    if (action === 'noop') {
        closeStrayPickerPanes(panes, tabId, docked.paneId);
        return;
    }

    if (action === 'replace') {
        try {
            paneClose(docked.paneId);
        } catch {
            // already gone, fine
        }
    }

    closeStrayPickerPanes(panes, tabId, docked ? docked.paneId : null);

    const layout = paneLayout({ pane: focused.pane_id });
    const target = findRightmostPane(layout.panes);
    if (!target) {
        return;
    }

    const ratio = computeSplitRatio({ targetWidth: target.rect.width, tabWidth: layout.area.width });
    if (ratio === null || layout.zoomed) {
        return;
    }

    const newPaneId = paneSplit({ pane: target.pane_id, direction: 'right', ratio, noFocus: true });
    // Record the dock BEFORE the remaining steps: if this event-hook process
    // gets cut off partway through (e.g. an execution timeout on the several
    // sequential herdr round-trips a full dock takes), the pane already
    // exists and MUST be tracked, or every later event sees "nothing docked"
    // and splits an unbounded stream of new panes — this ordering is why
    // that was happening live.
    setDockedPane(tabId, newPaneId, now);
    paneRun(newPaneId, buildPickerCommand(newPaneId));
    try {
        paneRename(newPaneId, DOCKED_PANE_LABEL);
    } catch {
        // cosmetic only
    }
}

function ensurePicker() {
    let caughtError = false;
    withLock(() => {
        try {
            runEnsure();
        } catch (error) {
            caughtError = true;
            process.stderr.write(`ensure-picker: ${error.message}\n`);
            logError('ensure-picker', error);
        }
    }, { wait: false });

    if (caughtError) {
        process.exitCode = 0;
    }
}

if (require.main === module) {
    ensurePicker();
}

module.exports = { ensurePicker };
