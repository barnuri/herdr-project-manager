'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Picker } = require('../bin/picker');
const { loadConfig, defaultConfig } = require('../lib/config');
const { saveProjectCache } = require('../lib/cache');

describe('Picker.parseMouseSequence', () => {
  test('returns null for a plain key', () => {
    assert.equal(Picker.parseMouseSequence('a'), null);
  });

  test('returns null for an arrow-key escape sequence', () => {
    assert.equal(Picker.parseMouseSequence('\x1b[A'), null);
  });

  test('parses a left-button press sequence into 0-indexed column/row', () => {
    assert.deepEqual(Picker.parseMouseSequence('\x1b[<0;5;3M'), {
      button: 0,
      column: 4,
      row: 2,
      isPress: true,
    });
  });

  test('parses a release sequence with isPress false', () => {
    assert.deepEqual(Picker.parseMouseSequence('\x1b[<0;5;3m'), {
      button: 0,
      column: 4,
      row: 2,
      isPress: false,
    });
  });
});

describe('Picker.hitsCollapseCorner', () => {
  const width = 80;
  const height = 24;

  test('hits the bottom row within the last 4 columns', () => {
    assert.equal(Picker.hitsCollapseCorner(76, 23, width, height), true);
    assert.equal(Picker.hitsCollapseCorner(77, 23, width, height), true);
    assert.equal(Picker.hitsCollapseCorner(78, 23, width, height), true);
    assert.equal(Picker.hitsCollapseCorner(79, 23, width, height), true);
  });

  test('misses one row above the bottom row', () => {
    assert.equal(Picker.hitsCollapseCorner(76, 22, width, height), false);
  });

  test('misses one column outside the last-4-columns region', () => {
    assert.equal(Picker.hitsCollapseCorner(75, 23, width, height), false);
  });
});

describe('Picker#onKey mouse dispatch', () => {
  test('a mouse-press hitting the collapse corner calls toggleCollapse instead of appending to the query', () => {
    const picker = new Picker([], { stdin: {}, stdout: { columns: 80, rows: 24 } });
    let toggleCollapseCalls = 0;
    picker.toggleCollapse = () => {
      toggleCollapseCalls += 1;
    };

    picker.onKey('\x1b[<0;80;24M');

    assert.equal(toggleCollapseCalls, 1);
    assert.equal(picker.query, '');
  });

  test('a mouse-press that misses the collapse corner does not call toggleCollapse', () => {
    const picker = new Picker([], { stdin: {}, stdout: { columns: 80, rows: 24 } });
    let toggleCollapseCalls = 0;
    picker.toggleCollapse = () => {
      toggleCollapseCalls += 1;
    };

    picker.onKey('\x1b[<0;1;1M');

    assert.equal(toggleCollapseCalls, 0);
    assert.equal(picker.query, '');
  });

  test('a mouse release at the collapse corner does not call toggleCollapse', () => {
    const picker = new Picker([], { stdin: {}, stdout: { columns: 80, rows: 24 } });
    let toggleCollapseCalls = 0;
    picker.toggleCollapse = () => {
      toggleCollapseCalls += 1;
    };

    picker.onKey('\x1b[<0;80;24m');

    assert.equal(toggleCollapseCalls, 0);
    assert.equal(picker.query, '');
  });
});

describe('Picker.stripAnsi', () => {
  test('removes SGR escape codes and leaves plain text intact', () => {
    assert.equal(Picker.stripAnsi('\x1b[2m\x1b[36mhello\x1b[0m'), 'hello');
    assert.equal(Picker.stripAnsi('no codes here'), 'no codes here');
  });
});

function stdoutSpy(columns, rows) {
  const writes = [];
  return {
    columns,
    rows,
    write(chunk) {
      writes.push(chunk);
    },
    on() {},
    off() {},
    lastFrame() {
      return writes[writes.length - 1] || '';
    },
  };
}

function stdinSpy() {
  return {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    setEncoding() {},
    on() {},
    off() {},
    once() {},
  };
}

describe('Picker#render corner glyph placement', () => {
  test('truncates an overflowing hint line so the glyph still lands within the last 4 columns at a narrow width', () => {
    const stdout = stdoutSpy(28, 24);
    const picker = new Picker([{ name: 'a', path: '/a' }], { stdin: {}, stdout });

    picker.render();

    const lastLine = stdout.lastFrame().split('\n').pop();
    const plain = Picker.stripAnsi(lastLine);
    assert.ok(plain.length <= 28, `expected line to fit within 28 columns, got ${plain.length}`);
    assert.ok(plain.endsWith('«'), `expected the corner glyph at the end of the line, got ${JSON.stringify(plain)}`);
    assert.ok(plain.includes('…'), 'expected the overflowing hint text to be ellipsized');
  });

  test('pads short project lists so the hint line (and its glyph) lands on the pane\'s true last row', () => {
    const stdout = stdoutSpy(80, 24);
    const picker = new Picker(
      [
        { name: 'a', path: '/a' },
        { name: 'b', path: '/b' },
        { name: 'c', path: '/c' },
      ],
      { stdin: {}, stdout }
    );

    picker.render();

    const lines = stdout.lastFrame().split('\n');
    assert.equal(lines.length, 24, 'expected the rendered frame to fill exactly stdout.rows lines');
    assert.ok(lines[23].includes('«'), 'expected the corner glyph on the pane\'s true last row (index rows - 1)');
  });
});

describe('Picker settings editor', () => {
  let tempDir;
  let previousConfigDirEnv;
  let previousStateDirEnv;

  beforeEach(() => {
    previousConfigDirEnv = process.env.HERDR_PLUGIN_CONFIG_DIR;
    previousStateDirEnv = process.env.HERDR_PLUGIN_STATE_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-picker-settings-test-'));
    process.env.HERDR_PLUGIN_CONFIG_DIR = tempDir;
    process.env.HERDR_PLUGIN_STATE_DIR = tempDir;
  });

  afterEach(() => {
    if (previousConfigDirEnv === undefined) {
      delete process.env.HERDR_PLUGIN_CONFIG_DIR;
    } else {
      process.env.HERDR_PLUGIN_CONFIG_DIR = previousConfigDirEnv;
    }
    if (previousStateDirEnv === undefined) {
      delete process.env.HERDR_PLUGIN_STATE_DIR;
    } else {
      process.env.HERDR_PLUGIN_STATE_DIR = previousStateDirEnv;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('constructor + refreshProjects', () => {
    test('defaults this.config to an empty config when none is passed', () => {
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) });
      assert.deepEqual(picker.config, defaultConfig());
    });

    test('refreshProjects re-derives projects from real glob discovery and merges manual projects', async () => {
      const repoDir = path.join(tempDir, 'repos', 'widget');
      fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
      const config = {
        globs: [path.join(tempDir, 'repos', '*', '.git')],
        projects: [{ name: 'manual-one', path: path.join(tempDir, 'manual-one') }],
      };
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, config);

      await picker.refreshProjects();

      const names = picker.projects.map((p) => p.name).sort();
      assert.deepEqual(names, ['manual-one', 'widget']);
    });

    test('a stale refreshProjects call does not overwrite state once a newer call has started', async () => {
      const repoDir = path.join(tempDir, 'repos', 'existing');
      fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
      const config = { globs: [path.join(tempDir, 'repos', '*', '.git')], projects: [] };
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, config);

      const observedCalls = [];
      const originalUpdateProjects = picker.updateProjects.bind(picker);
      picker.updateProjects = (projects) => {
        observedCalls.push(projects.length);
        originalUpdateProjects(projects);
      };

      const staleCall = picker.refreshProjects(); // captures generation 1
      // Simulate a newer call having started (exactly what a second, later
      // refreshProjects() invocation does internally) before the first one's
      // discovery resolves.
      picker.refreshGeneration += 1;

      await staleCall;

      assert.deepEqual(observedCalls, [], 'the stale call must not have applied its result');
      assert.equal(picker.projects.length, 0, 'projects must be untouched by the stale call');
    });
  });

  describe('onKey dispatch regression + view transitions', () => {
    test('Ctrl+G toggles view from list to settings and back', () => {
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) });
      assert.equal(picker.view, 'list');
      picker.onKey('\x07');
      assert.equal(picker.view, 'settings');
      picker.onKey('\x07');
      assert.equal(picker.view, 'list');
    });

    test('Ctrl+G is never special-cased away from the input sub-mode\'s normal control-byte handling', () => {
      // \x07 is a control byte below the printable-fallback's `key >= ' '` guard, same as every
      // other control chord (ctrlC, ctrlT, ...) — none of those get typed into the query either,
      // so the assertion here is "not treated specially", not "always inserted verbatim".
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) });
      picker.view = 'input';
      picker.inputKind = 'glob';
      picker.onKey('\x07');
      assert.equal(picker.view, 'input');
      assert.equal(picker.query, '');
    });

    test('Escape behavior differs per view: list stops, settings returns to list, input cancels to settings', () => {
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) });
      let stopCalls = 0;
      picker.stop = () => {
        stopCalls += 1;
      };

      picker.onKey('\x1b');
      assert.equal(stopCalls, 1);

      picker.view = 'settings';
      picker.onKey('\x1b');
      assert.equal(picker.view, 'list');

      picker.view = 'input';
      picker.inputKind = 'glob';
      picker.savedQuery = 'previous';
      picker.query = 'typed-so-far';
      picker.inputError = 'value cannot be empty';
      picker.onKey('\x1b');
      assert.equal(picker.view, 'settings');
      assert.equal(picker.query, 'previous');
      assert.equal(picker.inputError, '');
    });

    test('collapsed state still expands on any key, including Ctrl+G', () => {
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) });
      picker.collapsed = true;
      let toggleCollapseCalls = 0;
      picker.toggleCollapse = () => {
        toggleCollapseCalls += 1;
      };

      picker.onKey('\x07');

      assert.equal(toggleCollapseCalls, 1);
      assert.equal(picker.view, 'list');
    });

    test('Escape while collapsed still quits (stop), regression: it must not be swallowed by the "any key expands" catch-all', () => {
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) });
      picker.collapsed = true;
      let stopCalls = 0;
      let toggleCollapseCalls = 0;
      picker.stop = () => {
        stopCalls += 1;
      };
      picker.toggleCollapse = () => {
        toggleCollapseCalls += 1;
      };

      picker.onKey('\x1b');

      assert.equal(stopCalls, 1);
      assert.equal(toggleCollapseCalls, 0);
    });

    test('printable characters and backspace still build up the filter query in list view (regression)', () => {
      const picker = new Picker([{ name: 'widget', path: '/w' }], { stdin: {}, stdout: stdoutSpy(80, 24) });
      picker.onKey('w');
      picker.onKey('i');
      assert.equal(picker.query, 'wi');
      picker.onKey('\x7f');
      assert.equal(picker.query, 'w');
    });

    test('the < key types into the query during input mode instead of collapsing the pane', () => {
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, defaultConfig());
      picker.beginInput('glob');
      let toggleCollapseCalls = 0;
      picker.toggleCollapse = () => {
        toggleCollapseCalls += 1;
      };

      picker.onKey('<');

      assert.equal(toggleCollapseCalls, 0);
      assert.equal(picker.query, '<');
    });
  });

  describe('buildSettingsRows', () => {
    test('orders globs, then excludes, then manual projects, then the three add-rows, then the refresh row', () => {
      const config = {
        globs: ['~/repos/*/.git'],
        excludes: ['~/repos/vendor'],
        projects: [{ name: 'widget', path: '/opt/repos/widget' }],
      };
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, config);

      const rows = picker.buildSettingsRows();

      assert.deepEqual(rows, [
        { kind: 'glob', value: '~/repos/*/.git' },
        { kind: 'exclude', value: '~/repos/vendor' },
        { kind: 'project', value: { name: 'widget', path: '/opt/repos/widget' } },
        { kind: 'add-glob' },
        { kind: 'add-exclude' },
        { kind: 'add-project' },
        { kind: 'refresh' },
      ]);
    });
  });

  describe('settings view rendering', () => {
    test('renders the gear glyph at row 0 within the last 4 columns, at several widths', () => {
      for (const columns of [28, 40, 80]) {
        const stdout = stdoutSpy(columns, 24);
        const picker = new Picker([], { stdin: {}, stdout }, defaultConfig());
        picker.view = 'settings';

        picker.render();

        const rawFirstLine = stdout.lastFrame().split('\n')[0].replace('\x1b[2J\x1b[H', '');
        const firstLine = Picker.stripAnsi(rawFirstLine);
        assert.ok(firstLine.endsWith(Picker.GEAR_GLYPH), `expected gear glyph at end of title line at width ${columns}, got ${JSON.stringify(firstLine)}`);
        assert.ok(firstLine.length <= columns, `expected title line to fit within ${columns} columns, got ${firstLine.length}`);
      }
    });

    test('the selected row is highlighted and delete glyphs only appear on glob/project rows', () => {
      const config = { globs: ['~/repos/*/.git'], projects: [] };
      const stdout = stdoutSpy(80, 24);
      const picker = new Picker([], { stdin: {}, stdout }, config);
      picker.view = 'settings';
      picker.settingsIndex = 0;

      picker.render();

      const lines = stdout.lastFrame().split('\n');
      const globLine = lines[Picker.SETTINGS_HEADER_ROWS];
      const addGlobLine = lines[Picker.SETTINGS_HEADER_ROWS + 1];
      assert.ok(globLine.includes('\x1b[7m'), 'expected the selected glob row to carry the inverse marker');
      assert.ok(Picker.stripAnsi(globLine).endsWith(Picker.DELETE_GLYPH), 'expected a delete glyph on the glob row');
      assert.ok(!Picker.stripAnsi(addGlobLine).includes(Picker.DELETE_GLYPH), 'expected no delete glyph on the "+ Add glob" row');
    });
  });

  describe('mouse hit-testing in the settings view', () => {
    test('clicking the gear icon toggles settings from both the list and settings views', () => {
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) });
      picker.onKey('\x1b[<0;80;1M');
      assert.equal(picker.view, 'settings');
      picker.onKey('\x1b[<0;80;1M');
      assert.equal(picker.view, 'list');
    });

    test('a press in a glob row\'s delete-glyph region removes exactly that row', () => {
      const config = { globs: ['~/repos/*/.git', '~/work/**/.git'], projects: [] };
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, config);
      picker.view = 'settings';

      const rowIndex = 0;
      const clickRow = Picker.SETTINGS_HEADER_ROWS + rowIndex + 1;
      picker.onKey(`\x1b[<0;80;${clickRow}M`);

      assert.deepEqual(picker.config.globs, ['~/work/**/.git']);
      assert.deepEqual(loadConfig().globs, ['~/work/**/.git']);
    });

    test('a press in the middle of a glob row (outside the delete-glyph region) opens edit mode instead of deleting it', () => {
      const config = { globs: ['~/repos/*/.git'], projects: [] };
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, config);
      picker.view = 'settings';

      const clickRow = Picker.SETTINGS_HEADER_ROWS + 1;
      picker.onKey(`\x1b[<0;10;${clickRow}M`);

      assert.deepEqual(picker.config.globs, ['~/repos/*/.git']);
      assert.equal(picker.view, 'input');
      assert.equal(picker.inputKind, 'glob');
      assert.equal(picker.query, '~/repos/*/.git');
    });

    test('a press anywhere on the "+ Add glob" row enters input mode', () => {
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, defaultConfig());
      picker.view = 'settings';

      const rowIndex = picker.buildSettingsRows().findIndex((row) => row.kind === 'add-glob');
      const clickRow = Picker.SETTINGS_HEADER_ROWS + rowIndex + 1;
      picker.onKey(`\x1b[<0;5;${clickRow}M`);

      assert.equal(picker.view, 'input');
      assert.equal(picker.inputKind, 'glob');
    });

    test('a press on the truncated tail of a long, ellipsized glob label does not delete it (regression: text must not overlap the delete-glyph region)', () => {
      const longGlob = `~/${'a'.repeat(60)}/*/.git`;
      const config = { globs: [longGlob], projects: [] };
      const paneWidth = 40;
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(paneWidth, 24) }, config);
      picker.view = 'settings';
      picker.render();
      const renderedRow = Picker.stripAnsi(picker.stdout.lastFrame().split('\n')[Picker.SETTINGS_HEADER_ROWS]);
      assert.ok(renderedRow.includes('…'), 'expected the long glob to actually be truncated at this width');

      const clickRow = Picker.SETTINGS_HEADER_ROWS + 1;
      // Column just left of the glyph region (paneWidth - 3), inside the truncated text itself.
      picker.onKey(`\x1b[<0;${paneWidth - 2};${clickRow}M`);

      assert.deepEqual(picker.config.globs, [longGlob]);
    });

    test('a mouse press is a no-op while the picker is collapsed', () => {
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, defaultConfig());
      picker.collapsed = true;
      picker.view = 'settings';
      let toggleSettingsCalls = 0;
      picker.toggleSettings = () => {
        toggleSettingsCalls += 1;
      };

      picker.onKey('\x1b[<0;80;1M');

      assert.equal(toggleSettingsCalls, 0);
      assert.equal(picker.view, 'settings');
    });

    test('a mouse press is a no-op while in the input sub-mode', () => {
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, defaultConfig());
      picker.beginInput('glob');
      let toggleSettingsCalls = 0;
      picker.toggleSettings = () => {
        toggleSettingsCalls += 1;
      };

      picker.onKey('\x1b[<0;80;1M');

      assert.equal(toggleSettingsCalls, 0);
      assert.equal(picker.view, 'input');
    });

    test('a press in a project row\'s delete-glyph region removes exactly that project', () => {
      const config = {
        globs: [],
        projects: [
          { name: 'widget', path: '/opt/repos/widget' },
          { name: 'gadget', path: '/opt/repos/gadget' },
        ],
      };
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, config);
      picker.view = 'settings';

      const clickRow = Picker.SETTINGS_HEADER_ROWS + 1;
      picker.onKey(`\x1b[<0;80;${clickRow}M`);

      assert.deepEqual(picker.config.projects, [{ name: 'gadget', path: '/opt/repos/gadget' }]);
      assert.deepEqual(loadConfig().projects, [{ name: 'gadget', path: '/opt/repos/gadget' }]);
    });

    test('a press in the middle of a project row (outside the delete-glyph region) opens edit mode instead of deleting it', () => {
      const config = { globs: [], projects: [{ name: 'widget', path: '/opt/repos/widget' }] };
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, config);
      picker.view = 'settings';

      const clickRow = Picker.SETTINGS_HEADER_ROWS + 1;
      picker.onKey(`\x1b[<0;10;${clickRow}M`);

      assert.deepEqual(picker.config.projects, [{ name: 'widget', path: '/opt/repos/widget' }]);
      assert.equal(picker.view, 'input');
      assert.equal(picker.inputKind, 'project');
      assert.equal(picker.query, '/opt/repos/widget');
    });

    test('a press anywhere on the "+ Add project" row enters input mode with inputKind project', () => {
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, defaultConfig());
      picker.view = 'settings';

      const rowIndex = picker.buildSettingsRows().findIndex((row) => row.kind === 'add-project');
      const clickRow = Picker.SETTINGS_HEADER_ROWS + rowIndex + 1;
      picker.onKey(`\x1b[<0;5;${clickRow}M`);

      assert.equal(picker.view, 'input');
      assert.equal(picker.inputKind, 'project');
    });
  });

  describe('input sub-mode', () => {
    test('typing accumulates into this.query and Enter with a non-empty value persists and returns to settings', () => {
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, defaultConfig());
      picker.beginInput('glob');

      for (const ch of '~/work/*/.git') {
        picker.onKey(ch);
      }
      assert.equal(picker.query, '~/work/*/.git');

      picker.onKey('\r');

      assert.equal(picker.view, 'settings');
      assert.deepEqual(picker.config.globs, ['~/work/*/.git']);
      assert.deepEqual(loadConfig().globs, ['~/work/*/.git']);
    });

    test('Enter with an empty value sets inputError and stays in input mode', () => {
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, defaultConfig());
      picker.beginInput('glob');

      picker.onKey('\r');

      assert.equal(picker.view, 'input');
      assert.notEqual(picker.inputError, '');
      assert.deepEqual(picker.config.globs, []);
    });

    test('Escape restores the saved filter query and returns to settings without persisting anything', () => {
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, defaultConfig());
      picker.query = 'my-filter';
      picker.beginInput('project');

      picker.onKey('/');
      picker.onKey('t');
      picker.onKey('m');
      picker.onKey('p');
      picker.onKey('\x1b');

      assert.equal(picker.view, 'settings');
      assert.equal(picker.query, 'my-filter');
      assert.deepEqual(picker.config.projects, []);
    });

    test('adding a project via the input sub-mode persists it with a basename-derived name', () => {
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, defaultConfig());
      picker.beginInput('project');

      for (const ch of '/opt/repos/widget') {
        picker.onKey(ch);
      }
      picker.onKey('\r');

      assert.equal(picker.view, 'settings');
      assert.deepEqual(picker.config.projects, [{ name: 'widget', path: '/opt/repos/widget' }]);
      assert.deepEqual(loadConfig().projects, [{ name: 'widget', path: '/opt/repos/widget' }]);
    });
  });

  describe('editing and deleting a project/glob row via the keyboard', () => {
    test('Enter on a selected project row opens edit mode pre-filled with its current path', () => {
      const config = { globs: [], projects: [{ name: 'widget', path: '/opt/repos/widget' }] };
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, config);
      picker.view = 'settings';
      picker.settingsIndex = 0;

      picker.onKey('\r');

      assert.equal(picker.view, 'input');
      assert.equal(picker.inputKind, 'project');
      assert.equal(picker.query, '/opt/repos/widget');
      assert.deepEqual(picker.config.projects, [{ name: 'widget', path: '/opt/repos/widget' }]);
    });

    test('confirming an edited project path replaces it in place, preserving position', () => {
      const config = {
        globs: [],
        projects: [
          { name: 'widget', path: '/opt/repos/widget' },
          { name: 'gadget', path: '/opt/repos/gadget' },
        ],
      };
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, config);
      picker.view = 'settings';
      picker.settingsIndex = 0;
      picker.onKey('\r');
      picker.query = '/opt/repos/renamed-widget';

      picker.onKey('\r');

      assert.equal(picker.view, 'settings');
      assert.deepEqual(picker.config.projects, [
        { name: 'renamed-widget', path: '/opt/repos/renamed-widget' },
        { name: 'gadget', path: '/opt/repos/gadget' },
      ]);
      assert.deepEqual(loadConfig().projects, [
        { name: 'renamed-widget', path: '/opt/repos/renamed-widget' },
        { name: 'gadget', path: '/opt/repos/gadget' },
      ]);
    });

    test('when an edit collides with an earlier duplicate (dropping it), the selection follows the edited row to its new index', () => {
      const config = { globs: ['~/a/*/.git', '~/b/*/.git', '~/c/*/.git'], projects: [] };
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, config);
      picker.view = 'settings';
      picker.settingsIndex = 2; // the '~/c/*/.git' row

      picker.onKey('\r');
      picker.query = '~/a/*/.git'; // collides with row 0, which sits before the edited row

      picker.onKey('\r');

      // '~/a/*/.git' (the pre-existing duplicate at index 0) is dropped, shifting every
      // later row left by one — the edited row (now holding the new value) lands at
      // index 1, not the stale pre-edit index 2.
      assert.deepEqual(picker.config.globs, ['~/b/*/.git', '~/a/*/.git']);
      assert.equal(picker.settingsIndex, 1);
    });

    test('Enter on a selected glob row opens edit mode pre-filled with its current pattern, and confirming replaces it in place', () => {
      const config = { globs: ['~/work/*/.git', '~/sandbox/**/.git'], projects: [] };
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, config);
      picker.view = 'settings';
      picker.settingsIndex = 1;

      picker.onKey('\r');
      assert.equal(picker.view, 'input');
      assert.equal(picker.inputKind, 'glob');
      assert.equal(picker.query, '~/sandbox/**/.git');

      picker.query = '~/other/**/.git';
      picker.onKey('\r');

      assert.deepEqual(picker.config.globs, ['~/work/*/.git', '~/other/**/.git']);
      assert.deepEqual(loadConfig().globs, ['~/work/*/.git', '~/other/**/.git']);
    });

    test('Escape while editing a row discards the edit and leaves the original value untouched', () => {
      const config = { globs: [], projects: [{ name: 'widget', path: '/opt/repos/widget' }] };
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, config);
      picker.view = 'settings';
      picker.settingsIndex = 0;
      picker.onKey('\r');
      picker.query = '/opt/repos/should-not-persist';

      picker.onKey('\x1b');

      assert.equal(picker.view, 'settings');
      assert.deepEqual(picker.config.projects, [{ name: 'widget', path: '/opt/repos/widget' }]);
    });

    test('Backspace on a selected project row removes it and persists', () => {
      const config = { globs: [], projects: [{ name: 'widget', path: '/opt/repos/widget' }] };
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, config);
      picker.view = 'settings';
      picker.settingsIndex = 0;

      picker.onKey('\x7f');

      assert.equal(picker.view, 'settings');
      assert.deepEqual(picker.config.projects, []);
      assert.deepEqual(loadConfig().projects, []);
    });

    test('Backspace on a selected glob row removes it and persists', () => {
      const config = { globs: ['~/work/*/.git'], projects: [] };
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, config);
      picker.view = 'settings';
      picker.settingsIndex = 0;

      picker.onKey('\x7f');

      assert.deepEqual(picker.config.globs, []);
      assert.deepEqual(loadConfig().globs, []);
    });

    test('Backspace on the "+ Add glob" row is a no-op', () => {
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, defaultConfig());
      picker.view = 'settings';
      const rowIndex = picker.buildSettingsRows().findIndex((row) => row.kind === 'add-glob');
      picker.settingsIndex = rowIndex;

      picker.onKey('\x7f');

      assert.equal(picker.view, 'settings');
      assert.deepEqual(picker.config, defaultConfig());
    });
  });

  describe('manual refresh (Ctrl+R and the settings "Refresh list" row)', () => {
    test('Ctrl+R calls refreshProjects from the list view', () => {
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, defaultConfig());
      let refreshCalls = 0;
      picker.refreshProjects = () => {
        refreshCalls += 1;
      };

      picker.onKey('\x12');

      assert.equal(refreshCalls, 1);
      assert.equal(picker.view, 'list');
    });

    test('Ctrl+R calls refreshProjects from the settings view without changing the view', () => {
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, defaultConfig());
      picker.view = 'settings';
      let refreshCalls = 0;
      picker.refreshProjects = () => {
        refreshCalls += 1;
      };

      picker.onKey('\x12');

      assert.equal(refreshCalls, 1);
      assert.equal(picker.view, 'settings');
    });

    test('Ctrl+R is a no-op while in the input sub-mode (never intercepted from typed text)', () => {
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, defaultConfig());
      picker.beginInput('glob');
      let refreshCalls = 0;
      picker.refreshProjects = () => {
        refreshCalls += 1;
      };

      picker.onKey('\x12');

      assert.equal(refreshCalls, 0);
      assert.equal(picker.view, 'input');
    });

    test('confirming a new exclude persists it and refreshes the list', () => {
      const picker = new Picker([], { stdin: stdinSpy(), stdout: stdoutSpy(40, 24) }, defaultConfig());
      picker.refreshProjects = () => {};
      picker.view = 'settings';
      picker.settingsIndex = picker.buildSettingsRows().findIndex((row) => row.kind === 'add-exclude');
      picker.onKey('\r');
      for (const character of '~/vendor') {
        picker.onKey(character);
      }

      picker.onKey('\r');

      assert.deepEqual(picker.config.excludes, ['~/vendor']);
      assert.deepEqual(loadConfig().excludes, ['~/vendor']);
      assert.equal(picker.view, 'settings');
    });

    test('Backspace on a selected exclude row removes it and persists', () => {
      const config = { globs: [], excludes: ['~/vendor'], projects: [] };
      const picker = new Picker([], { stdin: stdinSpy(), stdout: stdoutSpy(40, 24) }, config);
      picker.refreshProjects = () => {};
      picker.view = 'settings';
      picker.settingsIndex = 0;

      picker.onKey('\x7f');

      assert.deepEqual(picker.config.excludes, []);
      assert.deepEqual(loadConfig().excludes, []);
    });

    test('buildSettingsRows includes a trailing refresh row after the add-rows', () => {
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, defaultConfig());
      const rows = picker.buildSettingsRows();
      assert.deepEqual(rows.at(-1), { kind: 'refresh' });
    });

    test('Enter on the selected "Refresh list" row calls refreshProjects and stays in the settings view', () => {
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, defaultConfig());
      picker.view = 'settings';
      picker.settingsIndex = picker.buildSettingsRows().findIndex((row) => row.kind === 'refresh');
      let refreshCalls = 0;
      picker.refreshProjects = () => {
        refreshCalls += 1;
      };

      picker.onKey('\r');

      assert.equal(refreshCalls, 1);
      assert.equal(picker.view, 'settings');
    });

    test('a mouse click anywhere on the "Refresh list" row calls refreshProjects', () => {
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, defaultConfig());
      picker.view = 'settings';
      let refreshCalls = 0;
      picker.refreshProjects = () => {
        refreshCalls += 1;
      };

      const rowIndex = picker.buildSettingsRows().findIndex((row) => row.kind === 'refresh');
      const clickRow = Picker.SETTINGS_HEADER_ROWS + rowIndex + 1;
      picker.onKey(`\x1b[<0;5;${clickRow}M`);

      assert.equal(refreshCalls, 1);
    });

    test('end-to-end: Ctrl+R re-derives the real project list without ever observing an empty intermediate array', async () => {
      const repoDir = path.join(tempDir, 'repos', 'existing');
      fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
      const config = { globs: [path.join(tempDir, 'repos', '*', '.git')], projects: [] };
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) }, config);
      await picker.refreshProjects();
      assert.equal(picker.projects.length, 1);

      const newRepoDir = path.join(tempDir, 'repos', 'new-arrival');
      fs.mkdirSync(path.join(newRepoDir, '.git'), { recursive: true });

      const observedLengths = [];
      const originalUpdateProjects = picker.updateProjects.bind(picker);
      picker.updateProjects = (projects) => {
        observedLengths.push(projects.length);
        originalUpdateProjects(projects);
      };

      // refreshProjects() is async and fire-and-forget from onKey's synchronous
      // dispatch — capture the promise it returns so the test can await the same
      // work the real key handler kicks off without blocking on it.
      const originalRefreshProjects = picker.refreshProjects.bind(picker);
      let refreshPromise;
      picker.refreshProjects = () => {
        refreshPromise = originalRefreshProjects();
        return refreshPromise;
      };

      picker.onKey('\x12');
      await refreshPromise;

      assert.deepEqual(observedLengths, [2], 'expected exactly one update, straight from 1 to 2 projects, never through 0');
      assert.equal(picker.projects.length, 2);
    });
  });

  describe('Picker.main', () => {
    // main() registers process-level uncaughtException/unhandledRejection listeners
    // that call process.exit(1) — since Picker.handleFatalError is a stable static
    // method reference, remove the exact listener main() added so repeated calls
    // across these tests (and the rest of the suite) don't stack handlers that could
    // kill the whole test process on an unrelated later failure.
    afterEach(() => {
      process.removeListener('uncaughtException', Picker.handleFatalError);
      process.removeListener('unhandledRejection', Picker.handleFatalError);
    });

    test('with zero cached/configured projects and a TTY, becomes interactive immediately in the settings view instead of blocking on discovery first', () => {
      const stdout = stdoutSpy(80, 24);
      const picker = Picker.main({ stdin: stdinSpy(), stdout });

      assert.ok(picker, 'expected main() to return the constructed Picker');
      assert.equal(picker.view, 'settings');
      const plain = Picker.stripAnsi(stdout.lastFrame());
      assert.ok(plain.includes('Settings'), 'expected the settings view to have actually rendered');
    });

    test('with zero cached/configured projects and no TTY, prints the fallback message and exits without constructing an interactive picker', () => {
      const stdout = stdoutSpy(80, 24);
      const stdin = { ...stdinSpy(), isTTY: false };

      const result = Picker.main({ stdin, stdout });

      assert.equal(result, undefined);
      assert.match(stdout.lastFrame(), /No projects configured/);
      assert.equal(process.exitCode, 1);
      process.exitCode = 0;
    });

    test('with a non-empty project cache, starts directly in the list view without waiting on discovery', () => {
      saveProjectCache([{ name: 'cached-widget', path: '/opt/repos/cached-widget' }]);
      const stdout = stdoutSpy(80, 24);

      const picker = Picker.main({ stdin: stdinSpy(), stdout });

      assert.equal(picker.view, 'list');
      assert.deepEqual(picker.projects.map((p) => p.name), ['cached-widget']);
    });
  });

  describe('automatic background refresh', () => {
    let originalSetInterval;
    let originalClearInterval;
    let previousPaneIdEnv;

    beforeEach(() => {
      originalSetInterval = global.setInterval;
      originalClearInterval = global.clearInterval;
      // Unset regardless of the outer environment (e.g. running inside a real
      // herdr pane during development sets this) so "no paneId" is guaranteed.
      previousPaneIdEnv = process.env.HERDR_PANE_ID;
      delete process.env.HERDR_PANE_ID;
    });

    afterEach(() => {
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
      if (previousPaneIdEnv === undefined) {
        delete process.env.HERDR_PANE_ID;
      } else {
        process.env.HERDR_PANE_ID = previousPaneIdEnv;
      }
    });

    test('start() schedules an unref\'d auto-refresh interval regardless of paneId, and stop() clears it', () => {
      const scheduled = [];
      const cleared = [];
      global.setInterval = (fn, ms) => {
        const handle = originalSetInterval(fn, ms);
        scheduled.push({ handle, ms });
        return handle;
      };
      global.clearInterval = (handle) => {
        cleared.push(handle);
        return originalClearInterval(handle);
      };

      const picker = new Picker([], { stdin: stdinSpy(), stdout: stdoutSpy(80, 24) }, defaultConfig());
      assert.equal(picker.paneId, null, 'sanity: HERDR_PANE_ID was cleared for this test');

      picker.start();
      const autoRefreshEntry = scheduled.find((entry) => entry.ms === Picker.AUTO_REFRESH_INTERVAL_MS);
      assert.ok(autoRefreshEntry, 'expected an interval scheduled at Picker.AUTO_REFRESH_INTERVAL_MS even with no paneId');
      if (autoRefreshEntry.handle.hasRef) {
        assert.equal(autoRefreshEntry.handle.hasRef(), false, 'expected the auto-refresh timer to be unref\'d so it never keeps the process alive by itself');
      }

      picker.stop();
      assert.ok(cleared.includes(autoRefreshEntry.handle), 'expected stop() to clear the auto-refresh interval');
    });

    test('does not call refreshProjects synchronously on start() — only on the scheduled interval', () => {
      const picker = new Picker([], { stdin: stdinSpy(), stdout: stdoutSpy(80, 24) }, defaultConfig());
      let refreshCalls = 0;
      picker.refreshProjects = () => {
        refreshCalls += 1;
      };

      picker.start();
      assert.equal(refreshCalls, 0);
      picker.stop();
    });
  });

  describe('crash recovery', () => {
    test('onKey catches an exception thrown while handling a key and logs it instead of propagating', () => {
      const picker = new Picker([{ name: 'a', path: '/a' }], { stdin: {}, stdout: stdoutSpy(80, 24) });
      picker.moveSelection = () => {
        throw new Error('simulated crash');
      };

      assert.doesNotThrow(() => picker.onKey('\x1b[A'));
      assert.equal(picker.view, 'list', 'the picker instance should still be usable after the caught error');
    });

    test('safeCall catches and logs, never lets the wrapped function\'s exception escape', () => {
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) });
      assert.doesNotThrow(() =>
        picker.safeCall(() => {
          throw new Error('boom');
        })
      );
    });

    test('safeCall does not swallow success — the wrapped function still runs normally', () => {
      const picker = new Picker([], { stdin: {}, stdout: stdoutSpy(80, 24) });
      let ran = false;
      picker.safeCall(() => {
        ran = true;
      });
      assert.equal(ran, true);
    });
  });
});

function press(column, row) {
  return `\x1b[<0;${column + 1};${row + 1}M`;
}

function listPicker(stdout = stdoutSpy(40, 24)) {
  return new Picker(
    [
      { name: 'alpha', path: '/opt/alpha' },
      { name: 'beta', path: '/opt/beta' },
      { name: 'gamma', path: '/opt/gamma' },
    ],
    { stdin: stdinSpy(), stdout },
    defaultConfig()
  );
}

describe('Picker list-view mouse selection', () => {
  test('a press on a project row selects it without opening it', () => {
    const picker = listPicker();
    let openCalls = 0;
    picker.openSelected = () => {
      openCalls += 1;
    };

    picker.onKey(press(3, Picker.LIST_HEADER_ROWS + 2));

    assert.equal(picker.selectedIndex, 2);
    assert.equal(openCalls, 0);
  });

  test('a press on the already-selected row opens it in the current mode', () => {
    const picker = listPicker();
    picker.selectedIndex = 1;
    const openedModes = [];
    picker.openSelected = (mode) => openedModes.push(mode);

    picker.onKey(press(3, Picker.LIST_HEADER_ROWS + 1));

    assert.deepEqual(openedModes, ['workspace']);
  });

  test('a press below the last project is ignored', () => {
    const picker = listPicker();
    picker.selectedIndex = 1;
    let openCalls = 0;
    picker.openSelected = () => {
      openCalls += 1;
    };

    picker.onKey(press(3, Picker.LIST_HEADER_ROWS + 2 + 1));

    assert.equal(picker.selectedIndex, 1);
    assert.equal(openCalls, 0);
  });

  test('a press above the first project row (title/filter) is ignored', () => {
    const picker = listPicker();
    picker.selectedIndex = 1;

    picker.onKey(press(3, 1));

    assert.equal(picker.selectedIndex, 1);
  });

  test('a press on the scrolled list maps to the visible row, not the absolute index', () => {
    const projects = Array.from({ length: 60 }, (unused, index) => ({
      name: `proj-${String(index).padStart(2, '0')}`,
      path: `/opt/proj-${index}`,
    }));
    const picker = new Picker(projects, { stdin: stdinSpy(), stdout: stdoutSpy(40, 24) }, defaultConfig());
    picker.selectedIndex = 40;
    const { windowStart } = picker.listLayout();

    picker.onKey(press(3, Picker.LIST_HEADER_ROWS + 2));

    assert.equal(picker.selectedIndex, windowStart + 2);
  });

  test('a press on a mode button switches the open mode', () => {
    const picker = listPicker();
    const { modeRow } = picker.listLayout();

    picker.onKey(press(16, modeRow));
    assert.equal(picker.mode, 'tab');

    picker.onKey(press(3, modeRow));
    assert.equal(picker.mode, 'workspace');
  });

  test('modeAtColumn maps the rendered button strip and returns null outside it', () => {
    assert.equal(Picker.modeAtColumn(0), null);
    assert.equal(Picker.modeAtColumn(1), 'workspace');
    assert.equal(Picker.modeAtColumn(13), 'workspace');
    assert.equal(Picker.modeAtColumn(14), null);
    assert.equal(Picker.modeAtColumn(15), 'tab');
    assert.equal(Picker.modeAtColumn(21), 'tab');
    assert.equal(Picker.modeAtColumn(22), null);
  });
});

describe('Picker close-panel shortcut', () => {
  test('q is a plain filter keystroke, never a close shortcut', () => {
    const picker = listPicker();
    let closeCalls = 0;
    picker.closePanel = () => {
      closeCalls += 1;
    };

    picker.onKey('q');
    picker.onKey('q');

    assert.equal(closeCalls, 0);
    assert.equal(picker.query, 'qq');
  });

  test('ctrl+q closes the panel regardless of the filter contents', () => {
    const picker = listPicker();
    let closeCalls = 0;
    picker.closePanel = () => {
      closeCalls += 1;
    };
    picker.query = 'alpha';

    picker.onKey('\x11');

    assert.equal(closeCalls, 1);
  });

  test('ctrl+q closes the panel from the settings view too', () => {
    const picker = listPicker();
    let closeCalls = 0;
    picker.closePanel = () => {
      closeCalls += 1;
    };
    picker.view = 'settings';

    picker.onKey('\x11');

    assert.equal(closeCalls, 1);
  });
});

describe('Picker exclude rows', () => {
  test('an exclude row renders with a leading ! so it reads apart from a glob', () => {
    assert.equal(Picker.settingsRowLabel({ kind: 'exclude', value: '~/vendor' }), '! ~/vendor');
    assert.equal(Picker.settingsRowLabel({ kind: 'glob', value: '~/repos/*/.git' }), '~/repos/*/.git');
  });

  test('Enter on the "+ Add exclude" row enters input mode with inputKind exclude', () => {
    const picker = listPicker();
    picker.view = 'settings';
    picker.settingsIndex = picker.buildSettingsRows().findIndex((row) => row.kind === 'add-exclude');

    picker.onKey('\r');

    assert.equal(picker.view, 'input');
    assert.equal(picker.inputKind, 'exclude');
    assert.match(picker.stdout.lastFrame(), /Add exclude pattern:/);
  });

  test('Enter on a selected exclude row opens edit mode pre-filled with its pattern', () => {
    const config = { globs: [], excludes: ['~/vendor'], projects: [] };
    const picker = new Picker([], { stdin: stdinSpy(), stdout: stdoutSpy(40, 24) }, config);
    picker.view = 'settings';
    picker.settingsIndex = 0;

    picker.onKey('\r');

    assert.equal(picker.inputKind, 'exclude');
    assert.equal(picker.query, '~/vendor');
  });
});

function wheel(direction, column = 5, row = 5) {
  const button = direction === 'up' ? 64 : 65;
  return `\x1b[<${button};${column + 1};${row + 1}M`;
}

function longListPicker() {
  const projects = Array.from({ length: 60 }, (unused, index) => ({
    name: `proj-${String(index).padStart(2, '0')}`,
    path: `/opt/proj-${index}`,
  }));
  return new Picker(projects, { stdin: stdinSpy(), stdout: stdoutSpy(40, 24) }, defaultConfig());
}

describe('Picker.wheelDirection', () => {
  test('maps the SGR wheel buttons to a direction', () => {
    assert.equal(Picker.wheelDirection(64), -1);
    assert.equal(Picker.wheelDirection(65), 1);
  });

  test('ignores the modifier bits so ctrl/shift/meta + wheel still scrolls', () => {
    assert.equal(Picker.wheelDirection(64 + 16), -1);
    assert.equal(Picker.wheelDirection(65 + 4), 1);
  });

  test('returns 0 for plain buttons and for the horizontal wheel', () => {
    assert.equal(Picker.wheelDirection(0), 0);
    assert.equal(Picker.wheelDirection(2), 0);
    assert.equal(Picker.wheelDirection(66), 0);
    assert.equal(Picker.wheelDirection(67), 0);
  });
});

describe('Picker wheel scrolling', () => {
  test('wheel down advances the selection by WHEEL_LINES', () => {
    const picker = longListPicker();

    picker.onKey(wheel('down'));

    assert.equal(picker.selectedIndex, Picker.WHEEL_LINES);
  });

  test('wheel up moves back and clamps at the first row instead of wrapping', () => {
    const picker = longListPicker();
    picker.selectedIndex = 2;

    picker.onKey(wheel('up'));

    assert.equal(picker.selectedIndex, 0);
  });

  test('wheel down clamps at the last row instead of wrapping', () => {
    const picker = longListPicker();
    picker.selectedIndex = 58;

    picker.onKey(wheel('down'));
    picker.onKey(wheel('down'));

    assert.equal(picker.selectedIndex, 59);
  });

  test('the wheel scrolls the visible window of a long list', () => {
    const picker = longListPicker();
    const before = picker.listLayout().windowStart;

    for (let flick = 0; flick < 10; flick += 1) {
      picker.onKey(wheel('down'));
    }

    assert.ok(picker.listLayout().windowStart > before);
  });

  test('the wheel scrolls the settings rows too', () => {
    const config = { globs: ['~/a/*/.git', '~/b/*/.git'], excludes: [], projects: [] };
    const picker = new Picker([], { stdin: stdinSpy(), stdout: stdoutSpy(40, 24) }, config);
    picker.view = 'settings';

    picker.onKey(wheel('down'));

    assert.equal(picker.settingsIndex, Picker.WHEEL_LINES);
  });

  test('a wheel event on an empty list leaves the selection at zero', () => {
    const picker = new Picker([], { stdin: stdinSpy(), stdout: stdoutSpy(40, 24) }, defaultConfig());

    picker.onKey(wheel('down'));

    assert.equal(picker.selectedIndex, 0);
  });

  test('the wheel is ignored while collapsed and while editing an input', () => {
    const picker = longListPicker();
    picker.collapsed = true;
    picker.onKey(wheel('down'));
    assert.equal(picker.selectedIndex, 0);

    picker.collapsed = false;
    picker.view = 'input';
    picker.onKey(wheel('down'));
    assert.equal(picker.selectedIndex, 0);
  });

  test('a wheel event in the collapse-corner region scrolls instead of collapsing', () => {
    const picker = longListPicker();
    let toggleCollapseCalls = 0;
    picker.toggleCollapse = () => {
      toggleCollapseCalls += 1;
    };

    picker.onKey(wheel('down', 38, 23));

    assert.equal(toggleCollapseCalls, 0);
    assert.equal(picker.selectedIndex, Picker.WHEEL_LINES);
  });
});
