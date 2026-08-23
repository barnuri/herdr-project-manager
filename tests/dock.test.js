'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  withLock,
  dockedPaneId,
  setDockedPane,
  clearDockedPane,
  isSnoozed,
  setSnoozed,
  clearSnoozed,
  findRightmostPane,
  computeSplitRatio,
  writeHeartbeat,
  readHeartbeat,
  decideEnsureAction,
} = require('../lib/dock');

describe('dock', () => {
  let tempDir;
  let savedStateDir;

  beforeEach(() => {
    savedStateDir = process.env.HERDR_PLUGIN_STATE_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-dock-'));
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir;
  });

  afterEach(() => {
    if (savedStateDir === undefined) {
      delete process.env.HERDR_PLUGIN_STATE_DIR;
    } else {
      process.env.HERDR_PLUGIN_STATE_DIR = savedStateDir;
    }
  });

  describe('withLock', () => {
    test('a second call while locked is a no-op in yield mode', () => {
      let outerCalled = false;
      let innerCalled = false;
      withLock(() => {
        outerCalled = true;
        withLock(() => {
          innerCalled = true;
        });
      });
      assert.equal(outerCalled, true);
      assert.equal(innerCalled, false);
    });

    test('wait mode retries and eventually succeeds once the lock is released', () => {
      const realMkdirSync = fs.mkdirSync;
      let lockAttempts = 0;
      fs.mkdirSync = (dir, options) => {
        if (options && options.recursive) {
          return realMkdirSync(dir, options);
        }
        lockAttempts += 1;
        if (lockAttempts === 1) {
          const error = new Error('EEXIST');
          error.code = 'EEXIST';
          throw error;
        }
        return realMkdirSync(dir, options);
      };

      try {
        let called = false;
        withLock(
          () => {
            called = true;
          },
          { wait: true }
        );
        assert.equal(called, true);
        assert.equal(lockAttempts, 2);
      } finally {
        fs.mkdirSync = realMkdirSync;
      }
    });

    test('a lock older than 30s is broken', () => {
      const lockDir = path.join(tempDir, 'ensure.lock');
      fs.mkdirSync(lockDir, { recursive: true });
      const staleTime = new Date(Date.now() - 31000);
      fs.utimesSync(lockDir, staleTime, staleTime);

      let called = false;
      withLock(() => {
        called = true;
      });
      assert.equal(called, true);
    });
  });

  describe('dockedPaneId/setDockedPane/clearDockedPane', () => {
    test('round-trips and keeps multiple tabs independent', () => {
      assert.equal(dockedPaneId('tab-1'), undefined);

      setDockedPane('tab-1', 'pane-1', 1000);
      setDockedPane('tab-2', 'pane-2', 2000);
      assert.deepEqual(dockedPaneId('tab-1'), { paneId: 'pane-1', dockedAt: 1000 });
      assert.deepEqual(dockedPaneId('tab-2'), { paneId: 'pane-2', dockedAt: 2000 });

      clearDockedPane('tab-1');
      assert.equal(dockedPaneId('tab-1'), undefined);
      assert.deepEqual(dockedPaneId('tab-2'), { paneId: 'pane-2', dockedAt: 2000 });
    });
  });

  describe('isSnoozed/setSnoozed/clearSnoozed', () => {
    test('round-trips', () => {
      assert.equal(isSnoozed('tab-1'), false);
      setSnoozed('tab-1');
      assert.equal(isSnoozed('tab-1'), true);
      clearSnoozed('tab-1');
      assert.equal(isSnoozed('tab-1'), false);
    });
  });

  describe('findRightmostPane', () => {
    test('returns null for an empty array', () => {
      assert.equal(findRightmostPane([]), null);
    });

    test('returns the only entry for a single-element array', () => {
      const pane = { pane_id: 'pane-1', rect: { x: 0, width: 10 } };
      assert.equal(findRightmostPane([pane]), pane);
    });

    test('keeps the first entry when the rightmost edge ties', () => {
      const first = { pane_id: 'pane-1', rect: { x: 0, width: 50 } };
      const tied = { pane_id: 'pane-2', rect: { x: 40, width: 10 } };
      const narrower = { pane_id: 'pane-3', rect: { x: 0, width: 20 } };
      assert.equal(findRightmostPane([first, tied, narrower]), first);
    });

    test('picks the pane with the furthest right edge', () => {
      const left = { pane_id: 'pane-1', rect: { x: 0, width: 30 } };
      const right = { pane_id: 'pane-2', rect: { x: 30, width: 50 } };
      assert.equal(findRightmostPane([left, right]), right);
    });
  });

  describe('computeSplitRatio', () => {
    test('returns null when the target is too narrow', () => {
      assert.equal(computeSplitRatio({ targetWidth: 37, tabWidth: 40 }), null);
    });

    test('does not return null once the target meets the minimum width', () => {
      const ratio = computeSplitRatio({ targetWidth: 38, tabWidth: 112 });
      assert.notEqual(ratio, null);
    });

    test('clamps the desired column count to minColumns when the fraction is too small', () => {
      // 0.25 * 40 = 10, clamped up to minColumns (28); (100 - 28) / 100 = 0.72
      assert.equal(computeSplitRatio({ targetWidth: 100, tabWidth: 40 }), 0.72);
    });

    test('clamps the desired column count to maxColumns when the fraction is too large', () => {
      // 0.25 * 300 = 75, clamped down to maxColumns (50); (200 - 50) / 200 = 0.75
      assert.equal(computeSplitRatio({ targetWidth: 200, tabWidth: 300 }), 0.75);
    });

    test('clamps the final ratio to 0.9 when the docked column would be too narrow', () => {
      // desiredCols clamps to 28; (1000 - 28) / 1000 = 0.972, clamped down to 0.9
      assert.equal(computeSplitRatio({ targetWidth: 1000, tabWidth: 40 }), 0.9);
    });

    test('clamps the final ratio to 0.1 when the docked column would exceed the target', () => {
      // desiredCols clamps to 50; (40 - 50) / 40 = -0.25, clamped up to 0.1
      assert.equal(computeSplitRatio({ targetWidth: 40, tabWidth: 1000 }), 0.1);
    });
  });

  describe('writeHeartbeat/readHeartbeat', () => {
    test('returns null for a missing file', () => {
      assert.equal(readHeartbeat('pane-missing'), null);
    });

    test('round-trips a written heartbeat', () => {
      writeHeartbeat('pane-1', { pid: 1234, ts: 999 });
      assert.deepEqual(readHeartbeat('pane-1'), { pid: 1234, ts: 999 });
    });
  });

  describe('decideEnsureAction', () => {
    const panes = [{ pane_id: 'pane-1' }, { pane_id: 'pane-2' }];

    test("returns 'open' when docked is missing", () => {
      const result = decideEnsureAction({
        panes,
        docked: undefined,
        now: 1000,
        heartbeatStaleAfterMs: 12000,
        dockGracePeriodMs: 15000,
      });
      assert.equal(result, 'open');
    });

    test("returns 'open' when the docked pane is not in the panes list", () => {
      const result = decideEnsureAction({
        panes,
        docked: { paneId: 'pane-gone', dockedAt: 0 },
        now: 1000,
        heartbeatStaleAfterMs: 12000,
        dockGracePeriodMs: 15000,
        readHeartbeatFn: () => {
          throw new Error('readHeartbeatFn should not be called');
        },
      });
      assert.equal(result, 'open');
    });

    test("returns 'noop' during the dock grace period", () => {
      const result = decideEnsureAction({
        panes,
        docked: { paneId: 'pane-1', dockedAt: 1000 },
        now: 1000 + 5000,
        heartbeatStaleAfterMs: 12000,
        dockGracePeriodMs: 15000,
        readHeartbeatFn: () => {
          throw new Error('readHeartbeatFn should not be called');
        },
      });
      assert.equal(result, 'noop');
    });

    test("returns 'noop' when the heartbeat is still fresh", () => {
      const now = 1000 + 20000;
      const result = decideEnsureAction({
        panes,
        docked: { paneId: 'pane-1', dockedAt: 1000 },
        now,
        heartbeatStaleAfterMs: 12000,
        dockGracePeriodMs: 15000,
        readHeartbeatFn: (paneId) => (paneId === 'pane-1' ? { pid: 1, ts: now - 5000 } : null),
      });
      assert.equal(result, 'noop');
    });

    test("returns 'replace' when the heartbeat is stale past the grace period", () => {
      const now = 1000 + 20000;
      const result = decideEnsureAction({
        panes,
        docked: { paneId: 'pane-1', dockedAt: 1000 },
        now,
        heartbeatStaleAfterMs: 12000,
        dockGracePeriodMs: 15000,
        readHeartbeatFn: (paneId) => (paneId === 'pane-1' ? { pid: 1, ts: now - 13000 } : null),
      });
      assert.equal(result, 'replace');
    });
  });
});
