'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensurePicker } = require('../bin/ensure-picker');
const { saveConfig, defaultConfig, setAutoOpen } = require('../lib/config');
const {
  dockedPaneId,
  setDockedPane,
  isSnoozed,
  setSnoozed,
  writeHeartbeat,
  HEARTBEAT_STALE_AFTER_MS,
  DOCK_GRACE_PERIOD_MS,
} = require('../lib/dock');

// Shell stub standing in for the real herdr binary. Unlike tests/herdr.test.js's
// single-fixed-stdout stub, ensure-picker.js makes several sequential calls per
// run (pane list, then conditionally layout/split/run/rename/close), so this
// dispatches canned JSON per subcommand and appends every call's argv to a log
// file, all driven by HERDR_STUB_*_JSON / HERDR_STUB_CALLS_FILE env vars.
const STUB_SCRIPT = `#!/bin/sh
case "$1 $2" in
  "pane list") printf '%s' "$HERDR_STUB_LIST_JSON" ;;
  "pane layout") printf '%s' "$HERDR_STUB_LAYOUT_JSON" ;;
  "pane split") printf '%s' "$HERDR_STUB_SPLIT_JSON" ;;
  "pane run") printf '%s' "$HERDR_STUB_RUN_JSON" ;;
  "pane rename") printf '%s' "$HERDR_STUB_RENAME_JSON" ;;
  "pane close") printf '%s' "$HERDR_STUB_CLOSE_JSON" ;;
esac
if [ -n "$HERDR_STUB_CALLS_FILE" ]; then
  { printf '%s\t' "$@"; printf '\n'; } >> "$HERDR_STUB_CALLS_FILE"
fi
exit 0
`;

const STUB_ENV_VARS = [
  'HERDR_STUB_LIST_JSON',
  'HERDR_STUB_LAYOUT_JSON',
  'HERDR_STUB_SPLIT_JSON',
  'HERDR_STUB_RUN_JSON',
  'HERDR_STUB_RENAME_JSON',
  'HERDR_STUB_CLOSE_JSON',
  'HERDR_STUB_CALLS_FILE',
];

const PICKER_SCRIPT_PATH = path.join(__dirname, '..', 'bin', 'picker.js');
const TAB_ID = 'tab-1';

function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// Mirrors bin/ensure-picker.js's buildPickerCommand: it forwards the state-dir
// env var it itself received (the test's HERDR_PLUGIN_STATE_DIR override) plus
// the new pane's id, since a bare `pane run` shell gets neither otherwise.
function expectedPickerRunCommand(newPaneId, stateDir, configDirPath) {
  return `HERDR_PLUGIN_CONFIG_DIR=${shQuote(configDirPath)} HERDR_PLUGIN_STATE_DIR=${shQuote(stateDir)} HERDR_PANE_ID=${shQuote(newPaneId)} node ${shQuote(PICKER_SCRIPT_PATH)}`;
}

function readRecordedCalls(callsFilePath) {
  if (!fs.existsSync(callsFilePath)) {
    return [];
  }
  return fs
    .readFileSync(callsFilePath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t').filter((part) => part.length > 0));
}

function setStubJson(varName, result) {
  process.env[varName] = JSON.stringify({ id: 'stub', result });
}

describe('ensure-picker', () => {
  let binDir;
  let stateDirPath;
  let configDirPath;
  let callsFilePath;
  let previousBinPathEnv;
  let previousStateDirEnv;
  let previousConfigDirEnv;
  let previousExitCode;

  beforeEach(() => {
    previousBinPathEnv = process.env.HERDR_BIN_PATH;
    previousStateDirEnv = process.env.HERDR_PLUGIN_STATE_DIR;
    previousConfigDirEnv = process.env.HERDR_PLUGIN_CONFIG_DIR;
    previousExitCode = process.exitCode;
    process.exitCode = undefined;

    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-picker-bin-'));
    const stubPath = path.join(binDir, 'herdr');
    callsFilePath = path.join(binDir, 'calls.log');
    fs.writeFileSync(stubPath, STUB_SCRIPT, { mode: 0o755 });
    process.env.HERDR_BIN_PATH = stubPath;
    process.env.HERDR_STUB_CALLS_FILE = callsFilePath;

    stateDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-picker-state-'));
    process.env.HERDR_PLUGIN_STATE_DIR = stateDirPath;

    // ensure-picker reads the auto-open flag from the config file, so point it at an
    // empty temp dir: without this the suite would silently follow the developer's own
    // ~/.config config and stop docking the moment they turned auto-open off.
    configDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-picker-config-'));
    process.env.HERDR_PLUGIN_CONFIG_DIR = configDirPath;

    setStubJson('HERDR_STUB_SPLIT_JSON', { pane: { pane_id: 'pane-new' } });
    setStubJson('HERDR_STUB_RUN_JSON', {});
    setStubJson('HERDR_STUB_RENAME_JSON', {});
    setStubJson('HERDR_STUB_CLOSE_JSON', {});
  });

  afterEach(() => {
    if (previousBinPathEnv === undefined) {
      delete process.env.HERDR_BIN_PATH;
    } else {
      process.env.HERDR_BIN_PATH = previousBinPathEnv;
    }
    if (previousStateDirEnv === undefined) {
      delete process.env.HERDR_PLUGIN_STATE_DIR;
    } else {
      process.env.HERDR_PLUGIN_STATE_DIR = previousStateDirEnv;
    }
    if (previousConfigDirEnv === undefined) {
      delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    } else {
      process.env.HERDR_PLUGIN_CONFIG_DIR = previousConfigDirEnv;
    }
    for (const name of STUB_ENV_VARS) {
      delete process.env[name];
    }
    process.exitCode = previousExitCode;
    fs.rmSync(binDir, { recursive: true, force: true });
    fs.rmSync(stateDirPath, { recursive: true, force: true });
    fs.rmSync(configDirPath, { recursive: true, force: true });
  });

  describe('auto-open setting', () => {
    const FOCUSED_TAB_LIST = {
      panes: [{ pane_id: 'pane-focused', tab_id: TAB_ID, focused: true }],
    };
    const WIDE_LAYOUT = {
      layout: {
        area: { width: 200 },
        zoomed: false,
        panes: [{ pane_id: 'pane-focused', rect: { x: 0, width: 200 } }],
      },
    };

    test('autoOpen: false docks nothing and makes no herdr calls at all', () => {
      saveConfig(setAutoOpen(defaultConfig(), false));
      setStubJson('HERDR_STUB_LIST_JSON', FOCUSED_TAB_LIST);
      setStubJson('HERDR_STUB_LAYOUT_JSON', WIDE_LAYOUT);

      ensurePicker();

      assert.deepEqual(readRecordedCalls(callsFilePath), []);
      assert.equal(dockedPaneId(TAB_ID), undefined);
    });

    test('autoOpen: true docks as usual', () => {
      saveConfig(setAutoOpen(defaultConfig(), true));
      setStubJson('HERDR_STUB_LIST_JSON', FOCUSED_TAB_LIST);
      setStubJson('HERDR_STUB_LAYOUT_JSON', WIDE_LAYOUT);

      ensurePicker();

      assert.equal(dockedPaneId(TAB_ID).paneId, 'pane-new');
    });

    test('a config file with no autoOpen key still docks (the flag is opt-out)', () => {
      fs.writeFileSync(
        path.join(configDirPath, 'projects.json'),
        JSON.stringify({ globs: [], projects: [] }),
        'utf8'
      );
      setStubJson('HERDR_STUB_LIST_JSON', FOCUSED_TAB_LIST);
      setStubJson('HERDR_STUB_LAYOUT_JSON', WIDE_LAYOUT);

      ensurePicker();

      assert.equal(dockedPaneId(TAB_ID).paneId, 'pane-new');
    });
  });

  test('fresh tab with no docked picker docks: pane list -> layout -> split -> run -> rename', () => {
    setStubJson('HERDR_STUB_LIST_JSON', {
      panes: [{ pane_id: 'pane-focused', tab_id: TAB_ID, focused: true }],
    });
    setStubJson('HERDR_STUB_LAYOUT_JSON', {
      layout: {
        area: { width: 200 },
        zoomed: false,
        panes: [{ pane_id: 'pane-focused', rect: { x: 0, width: 200 } }],
      },
    });

    ensurePicker();

    assert.deepEqual(readRecordedCalls(callsFilePath), [
      ['pane', 'list'],
      ['pane', 'layout', '--pane', 'pane-focused'],
      ['pane', 'split', 'pane-focused', '--direction', 'right', '--ratio', '0.75', '--no-focus'],
      ['pane', 'run', 'pane-new', expectedPickerRunCommand('pane-new', stateDirPath, configDirPath)],
      ['pane', 'rename', 'pane-new', 'Projects'],
    ]);

    const docked = dockedPaneId(TAB_ID);
    assert.equal(docked.paneId, 'pane-new');
    assert.ok(Math.abs(docked.dockedAt - Date.now()) < 5000);
  });

  test('already docked and alive within the grace period is a no-op beyond the initial pane list', () => {
    setDockedPane(TAB_ID, 'pane-docked', Date.now() - 1000);
    setStubJson('HERDR_STUB_LIST_JSON', {
      panes: [
        { pane_id: 'pane-focused', tab_id: TAB_ID, focused: true },
        { pane_id: 'pane-docked', tab_id: TAB_ID, focused: false, label: 'Projects' },
      ],
    });

    ensurePicker();

    assert.deepEqual(readRecordedCalls(callsFilePath), [['pane', 'list']]);
    assert.equal(dockedPaneId(TAB_ID).paneId, 'pane-docked');
  });

  test('already docked and alive with a fresh heartbeat past the grace period is a no-op beyond the initial pane list', () => {
    setDockedPane(TAB_ID, 'pane-docked', Date.now() - (DOCK_GRACE_PERIOD_MS + 2000));
    writeHeartbeat('pane-docked', { pid: 111, ts: Date.now() - 1000 });
    setStubJson('HERDR_STUB_LIST_JSON', {
      panes: [
        { pane_id: 'pane-focused', tab_id: TAB_ID, focused: true },
        { pane_id: 'pane-docked', tab_id: TAB_ID, focused: false, label: 'Projects' },
      ],
    });

    ensurePicker();

    assert.deepEqual(readRecordedCalls(callsFilePath), [['pane', 'list']]);
    assert.equal(dockedPaneId(TAB_ID).paneId, 'pane-docked');
  });

  test('a snoozed tab is a no-op beyond the initial pane list', () => {
    setSnoozed(TAB_ID);
    setStubJson('HERDR_STUB_LIST_JSON', {
      panes: [{ pane_id: 'pane-focused', tab_id: TAB_ID, focused: true }],
    });

    ensurePicker();

    assert.deepEqual(readRecordedCalls(callsFilePath), [['pane', 'list']]);
    assert.equal(dockedPaneId(TAB_ID), undefined);
    assert.equal(isSnoozed(TAB_ID), true);
  });

  test('re-docks when the docked pane id is no longer in the pane list, without closing anything', () => {
    setDockedPane(TAB_ID, 'pane-gone', Date.now() - 1000);
    setStubJson('HERDR_STUB_LIST_JSON', {
      panes: [{ pane_id: 'pane-focused', tab_id: TAB_ID, focused: true }],
    });
    setStubJson('HERDR_STUB_LAYOUT_JSON', {
      layout: {
        area: { width: 200 },
        zoomed: false,
        panes: [{ pane_id: 'pane-focused', rect: { x: 0, width: 200 } }],
      },
    });

    ensurePicker();

    assert.deepEqual(readRecordedCalls(callsFilePath), [
      ['pane', 'list'],
      ['pane', 'layout', '--pane', 'pane-focused'],
      ['pane', 'split', 'pane-focused', '--direction', 'right', '--ratio', '0.75', '--no-focus'],
      ['pane', 'run', 'pane-new', expectedPickerRunCommand('pane-new', stateDirPath, configDirPath)],
      ['pane', 'rename', 'pane-new', 'Projects'],
    ]);
    assert.equal(dockedPaneId(TAB_ID).paneId, 'pane-new');
  });

  test('closes the old pane and re-docks when the docked pane is present but its heartbeat is stale past the grace period', () => {
    setDockedPane(TAB_ID, 'pane-docked', Date.now() - (DOCK_GRACE_PERIOD_MS + 2000));
    writeHeartbeat('pane-docked', { pid: 111, ts: Date.now() - (HEARTBEAT_STALE_AFTER_MS + 2000) });
    setStubJson('HERDR_STUB_LIST_JSON', {
      panes: [
        { pane_id: 'pane-focused', tab_id: TAB_ID, focused: true },
        { pane_id: 'pane-docked', tab_id: TAB_ID, focused: false, label: 'Projects' },
      ],
    });
    setStubJson('HERDR_STUB_LAYOUT_JSON', {
      layout: {
        area: { width: 200 },
        zoomed: false,
        panes: [{ pane_id: 'pane-focused', rect: { x: 0, width: 200 } }],
      },
    });

    ensurePicker();

    assert.deepEqual(readRecordedCalls(callsFilePath), [
      ['pane', 'list'],
      ['pane', 'close', 'pane-docked'],
      ['pane', 'layout', '--pane', 'pane-focused'],
      ['pane', 'split', 'pane-focused', '--direction', 'right', '--ratio', '0.75', '--no-focus'],
      ['pane', 'run', 'pane-new', expectedPickerRunCommand('pane-new', stateDirPath, configDirPath)],
      ['pane', 'rename', 'pane-new', 'Projects'],
    ]);
    assert.equal(dockedPaneId(TAB_ID).paneId, 'pane-new');
  });

  test('no focused pane in the pane list is a no-op beyond the initial pane list and exits cleanly', () => {
    setStubJson('HERDR_STUB_LIST_JSON', {
      panes: [{ pane_id: 'pane-1', tab_id: TAB_ID, focused: false }],
    });

    assert.doesNotThrow(() => ensurePicker());

    assert.deepEqual(readRecordedCalls(callsFilePath), [['pane', 'list']]);
    assert.equal(process.exitCode, undefined);
  });

  test('yields with no herdr calls at all when a concurrent lock is already held', () => {
    const lockDir = path.join(stateDirPath, 'ensure.lock');
    fs.mkdirSync(lockDir, { recursive: true });

    assert.doesNotThrow(() => ensurePicker());

    assert.deepEqual(readRecordedCalls(callsFilePath), []);
    assert.equal(process.exitCode, undefined);
  });

  // Ground truth for "is this pane one of ours" is now a heartbeat file (written
  // only by picker.js, for its own pane id) rather than the `pane rename` label —
  // the label was observed live to not reliably show up in `pane list` output for
  // freshly split panes, which silently defeated an earlier label-based version of
  // this dedup logic (every event then saw zero "docked" panes and redocked
  // unconditionally, with no grace-period protection — the "infinite panels"
  // incident these tests exist to guard against repeating).
  test('an extra stray pane with a live heartbeat gets closed alongside an already-tracked, already-alive docked pane', () => {
    const originalDockedAt = Date.now() - 1000;
    setDockedPane(TAB_ID, 'pane-docked', originalDockedAt);
    writeHeartbeat('pane-stray', { pid: 222, ts: Date.now() });
    setStubJson('HERDR_STUB_LIST_JSON', {
      panes: [
        { pane_id: 'pane-focused', tab_id: TAB_ID, focused: true },
        { pane_id: 'pane-docked', tab_id: TAB_ID, focused: false },
        { pane_id: 'pane-stray', tab_id: TAB_ID, focused: false },
      ],
    });

    ensurePicker();

    assert.deepEqual(readRecordedCalls(callsFilePath), [
      ['pane', 'list'],
      ['pane', 'close', 'pane-stray'],
    ]);
    assert.equal(dockedPaneId(TAB_ID).paneId, 'pane-docked');
    assert.equal(dockedPaneId(TAB_ID).dockedAt, originalDockedAt, 'the tracked pane\'s record must not be touched by the stray-pane cleanup');
  });

  test('an unrelated pane in the same tab without a heartbeat is left alone (only real picker panes get closed)', () => {
    setDockedPane(TAB_ID, 'pane-docked', Date.now() - 1000);
    setStubJson('HERDR_STUB_LIST_JSON', {
      panes: [
        { pane_id: 'pane-focused', tab_id: TAB_ID, focused: true },
        { pane_id: 'pane-docked', tab_id: TAB_ID, focused: false },
        { pane_id: 'pane-unrelated-shell', tab_id: TAB_ID, focused: false },
      ],
    });

    ensurePicker();

    assert.deepEqual(readRecordedCalls(callsFilePath), [['pane', 'list']]);
  });

  test('a stray pane with a heartbeat gets closed when the tab has no tracked docked pane and a fresh one is docked, and the dock is recorded before pane run/rename', () => {
    writeHeartbeat('pane-stray', { pid: 333, ts: Date.now() });
    setStubJson('HERDR_STUB_LIST_JSON', {
      panes: [
        { pane_id: 'pane-focused', tab_id: TAB_ID, focused: true },
        { pane_id: 'pane-stray', tab_id: TAB_ID, focused: false },
      ],
    });
    setStubJson('HERDR_STUB_LAYOUT_JSON', {
      layout: {
        area: { width: 200 },
        zoomed: false,
        panes: [{ pane_id: 'pane-focused', rect: { x: 0, width: 200 } }],
      },
    });

    ensurePicker();

    assert.deepEqual(readRecordedCalls(callsFilePath), [
      ['pane', 'list'],
      ['pane', 'close', 'pane-stray'],
      ['pane', 'layout', '--pane', 'pane-focused'],
      ['pane', 'split', 'pane-focused', '--direction', 'right', '--ratio', '0.75', '--no-focus'],
      ['pane', 'run', 'pane-new', expectedPickerRunCommand('pane-new', stateDirPath, configDirPath)],
      ['pane', 'rename', 'pane-new', 'Projects'],
    ]);
    assert.equal(dockedPaneId(TAB_ID).paneId, 'pane-new');
  });
});
