#!/usr/bin/env node
'use strict';

const { loadProjectCache, saveProjectCache } = require('../lib/cache');
const {
    loadConfig,
    defaultConfig,
    saveConfig,
    addGlob,
    removeGlob,
    updateGlob,
    addProject,
    removeProject,
    updateProject,
} = require('../lib/config');
const { discoverProjects, mergeProjects } = require('../lib/discover');
const { fuzzyFilter } = require('../lib/fuzzy');
const { openTab, openWorkspace, runHerdrText } = require('../lib/herdr');
const { writeHeartbeat, HEARTBEAT_INTERVAL_MS } = require('../lib/dock');
const { logError } = require('../lib/log');
const { expandHomePath } = require('../lib/paths');

class Picker {
    static ANSI = {
        clear: '\x1b[2J\x1b[H',
        hideCursor: '\x1b[?25l',
        showCursor: '\x1b[?25h',
        reset: '\x1b[0m',
        bold: '\x1b[1m',
        dim: '\x1b[2m',
        inverse: '\x1b[7m',
        cyan: '\x1b[36m',
        yellow: '\x1b[33m',
    };

    static KEY = {
        ctrlC: '\x03',
        ctrlG: '\x07',
        ctrlR: '\x12',
        ctrlW: '\x17',
        escape: '\x1b',
        enter: '\r',
        backspace: '\x7f',
        tab: '\t',
        ctrlT: '\x14',
        collapse: '<',
        up: '\x1b[A',
        down: '\x1b[B',
        left: '\x1b[D',
        right: '\x1b[C',
    };

    static DEFAULT_ROWS = 24;

    static DEFAULT_COLUMNS = 80;

    static CHROME_ROWS = 6;

    static ROW_ICON = '\uE0A0';

    static MODES = ['workspace', 'tab'];

    static COLLAPSED_TARGET_COLS = 8;

    static AUTO_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

    static COLLAPSED_STRIP_ROWS = 7;

    static SETTINGS_HEADER_ROWS = 2;

    static GEAR_GLYPH = '⚙';

    static DELETE_GLYPH = '✕';

    static RESIZE_STEP = 0.05;

    static RESIZE_SETTLE_MS = 120;

    static MAX_RESIZE_STEPS = 14;

    constructor(projects, io = { stdin: process.stdin, stdout: process.stdout }, config = defaultConfig()) {
        this.projects = projects;
        this.stdin = io.stdin;
        this.stdout = io.stdout;
        this.config = config;
        this.query = '';
        this.selectedIndex = 0;
        this.mode = 'workspace';
        this.collapsed = false;
        this.expandedCols = null;
        this.shrinkDirection = 'left';
        this.paneId = process.env.HERDR_PANE_ID || null;
        this.view = 'list';
        this.settingsIndex = 0;
        this.inputKind = null;
        this.editTarget = null;
        this.savedQuery = '';
        this.inputError = '';
        this.refreshGeneration = 0;
        this.onKey = this.onKey.bind(this);
        this.render = this.render.bind(this);
    }

    toggleMode() {
        const modes = Picker.MODES;
        this.mode = modes[(modes.indexOf(this.mode) + 1) % modes.length];
        this.render();
    }

    filtered() {
        return fuzzyFilter(this.projects, this.query, (p) => p.name);
    }

    start() {
        if (!this.stdin.isTTY) {
            this.stdout.write('picker requires a TTY (run it inside a herdr pane)\n');
            process.exitCode = 1;
            return;
        }
        this.stdin.setRawMode(true);
        this.stdin.resume();
        this.stdin.setEncoding('utf8');
        this.stdin.on('data', this.onKey);
        this.stdout.on('resize', () => this.safeCall(this.render));
        this.stdout.write(Picker.ANSI.hideCursor);
        this.stdout.write('\x1b[?1000h\x1b[?1006h');
        this.safeCall(this.render);
        if (this.paneId) {
            writeHeartbeat(this.paneId, { pid: process.pid, ts: Date.now() });
            this.heartbeatTimer = setInterval(() => {
                this.safeCall(() => writeHeartbeat(this.paneId, { pid: process.pid, ts: Date.now() }));
            }, HEARTBEAT_INTERVAL_MS);
            if (this.heartbeatTimer.unref) {
                this.heartbeatTimer.unref();
            }
        }
        this.autoRefreshTimer = setInterval(() => this.safeCall(() => this.refreshProjects()), Picker.AUTO_REFRESH_INTERVAL_MS);
        if (this.autoRefreshTimer.unref) {
            this.autoRefreshTimer.unref();
        }
    }

    safeCall(fn) {
        try {
            fn();
        } catch (error) {
            process.stderr.write(`project-manager: ${error && error.message ? error.message : error}\n`);
            logError('picker.safeCall', error);
        }
    }

    stop() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
        }
        if (this.autoRefreshTimer) {
            clearInterval(this.autoRefreshTimer);
        }
        this.stdin.setRawMode(false);
        this.stdin.pause();
        this.stdin.off('data', this.onKey);
        this.stdout.off('resize', this.render);
        this.stdout.write('\x1b[?1006l\x1b[?1000l');
        this.stdout.write(Picker.ANSI.showCursor + Picker.ANSI.reset + '\n');
    }

    onKey(key) {
        this.safeCall(() => this.handleKeyEvent(key));
    }

    handleKeyEvent(key) {
        const { KEY } = Picker;
        const mouse = Picker.parseMouseSequence(key);
        if (mouse) {
            this.handleMouse(mouse);
            return;
        }
        if (key === KEY.ctrlC) {
            this.stop();
            return;
        }
        if (key === KEY.escape && this.collapsed) {
            this.stop();
            return;
        }
        if (this.collapsed) {
            void this.toggleCollapse();
            return;
        }
        if (key === KEY.collapse && this.view !== 'input') {
            void this.toggleCollapse();
            return;
        }
        if (key === KEY.ctrlG && this.view !== 'input') {
            this.toggleSettings();
            return;
        }
        if (key === KEY.ctrlR && this.view !== 'input') {
            this.refreshProjects();
            return;
        }
        if (key === KEY.escape) {
            if (this.view === 'list') {
                this.stop();
            } else if (this.view === 'settings') {
                this.toggleSettings();
            } else {
                this.cancelInput();
            }
            return;
        }
        if (this.view === 'input') {
            if (key === KEY.enter) {
                this.confirmInput();
                return;
            }
            if (key === KEY.backspace) {
                this.query = this.query.slice(0, -1);
                this.render();
                return;
            }
            if (key.length === 1 && key >= ' ') {
                this.query += key;
                this.inputError = '';
                this.render();
            }
            return;
        }
        if (this.view === 'settings') {
            if (key === KEY.up) {
                this.moveSettingsSelection(-1);
                return;
            }
            if (key === KEY.down) {
                this.moveSettingsSelection(1);
                return;
            }
            if (key === KEY.enter) {
                this.activateSettingsRow();
                return;
            }
            if (key === KEY.backspace) {
                this.deleteSelectedRow();
                return;
            }
            return;
        }
        if (key === KEY.up) {
            this.moveSelection(-1);
            return;
        }
        if (key === KEY.down) {
            this.moveSelection(1);
            return;
        }
        if (key === KEY.backspace) {
            this.query = this.query.slice(0, -1);
            this.selectedIndex = 0;
            this.render();
            return;
        }
        if (key === KEY.enter) {
            this.openSelected(this.mode);
            return;
        }
        if (key === KEY.tab || key === KEY.left || key === KEY.right) {
            this.toggleMode();
            return;
        }
        if (key === KEY.ctrlW) {
            this.openSelected('workspace');
            return;
        }
        if (key === KEY.ctrlT) {
            this.openSelected('tab');
            return;
        }
        if (key.length === 1 && key >= ' ') {
            this.query += key;
            this.selectedIndex = 0;
            this.render();
        }
    }

    handleMouse(mouse) {
        if (!mouse.isPress || mouse.button !== 0) {
            return;
        }
        const paneWidth = this.stdout.columns || Picker.DEFAULT_COLUMNS;
        const paneHeight = this.collapsed ? Picker.COLLAPSED_STRIP_ROWS : this.stdout.rows || Picker.DEFAULT_ROWS;
        if (this.view !== 'input' && Picker.hitsCollapseCorner(mouse.column, mouse.row, paneWidth, paneHeight)) {
            void this.toggleCollapse();
            return;
        }
        if (this.collapsed || this.view === 'input') {
            return;
        }
        if (Picker.hitsGearIcon(mouse.column, mouse.row, paneWidth)) {
            this.toggleSettings();
            return;
        }
        if (this.view === 'settings') {
            this.handleSettingsClick(mouse, paneWidth);
        }
    }

    handleSettingsClick(mouse, paneWidth) {
        const rows = this.buildSettingsRows();
        const rowIndex = mouse.row - Picker.SETTINGS_HEADER_ROWS;
        const row = rows[rowIndex];
        if (!row) {
            return;
        }
        this.settingsIndex = rowIndex;
        // withCornerGlyph's layout puts the glyph at column paneWidth-2 (a
        // separator space at paneWidth-3, truncated/padded text at paneWidth-4
        // and below) — clicking the glyph deletes, clicking the label text edits.
        if (row.kind === 'glob' || row.kind === 'project') {
            if (mouse.column < paneWidth - 2) {
                this.beginEditSelectedRow();
            } else {
                this.deleteSelectedRow();
            }
            return;
        }
        this.activateSettingsRow();
    }

    toggleSettings() {
        this.view = this.view === 'settings' ? 'list' : 'settings';
        this.settingsIndex = 0;
        this.render();
    }

    buildSettingsRows() {
        const rows = [];
        for (const glob of this.config.globs) {
            rows.push({ kind: 'glob', value: glob });
        }
        for (const project of this.config.projects) {
            rows.push({ kind: 'project', value: project });
        }
        rows.push({ kind: 'add-glob' });
        rows.push({ kind: 'add-project' });
        rows.push({ kind: 'refresh' });
        return rows;
    }

    moveSettingsSelection(delta) {
        const count = this.buildSettingsRows().length;
        if (count === 0) {
            return;
        }
        this.settingsIndex = (this.settingsIndex + delta + count) % count;
        this.render();
    }

    activateSettingsRow() {
        const row = this.buildSettingsRows()[this.settingsIndex];
        if (!row) {
            return;
        }
        if (row.kind === 'glob' || row.kind === 'project') {
            this.beginEditSelectedRow();
            return;
        }
        if (row.kind === 'refresh') {
            this.refreshProjects();
            return;
        }
        this.beginInput(row.kind === 'add-glob' ? 'glob' : 'project');
    }

    beginEditSelectedRow() {
        const row = this.buildSettingsRows()[this.settingsIndex];
        if (!row || (row.kind !== 'glob' && row.kind !== 'project')) {
            return;
        }
        this.savedQuery = this.query;
        this.query = row.kind === 'glob' ? row.value : row.value.path;
        this.inputKind = row.kind;
        this.editTarget = row;
        this.inputError = '';
        this.view = 'input';
        this.render();
    }

    deleteSelectedRow() {
        const row = this.buildSettingsRows()[this.settingsIndex];
        if (!row) {
            return;
        }
        if (row.kind === 'glob') {
            this.config = removeGlob(this.config, row.value);
            this.persistConfig();
        } else if (row.kind === 'project') {
            this.config = removeProject(this.config, row.value.path);
            this.persistConfig();
        }
    }

    persistConfig() {
        saveConfig(this.config);
        const count = this.buildSettingsRows().length;
        this.settingsIndex = Math.min(this.settingsIndex, Math.max(0, count - 1));
        this.refreshProjects();
    }

    beginInput(kind) {
        this.savedQuery = this.query;
        this.query = '';
        this.inputKind = kind;
        this.editTarget = null;
        this.inputError = '';
        this.view = 'input';
        this.render();
    }

    confirmInput() {
        const value = this.query.trim();
        if (value === '') {
            this.inputError = 'value cannot be empty';
            this.render();
            return;
        }
        if (this.editTarget) {
            const { kind, value: previousValue } = this.editTarget;
            this.config = kind === 'glob'
                ? updateGlob(this.config, previousValue, value)
                : updateProject(this.config, previousValue.path, value);
            this.editTarget = null;
            // A collision with an earlier duplicate (updateGlob/updateProject's own
            // dedupe rule) shrinks the array before the edited row, shifting everything
            // after it left by one — re-locate the edited row by its new value instead
            // of trusting the pre-edit settingsIndex, or the selection silently lands on
            // an unrelated row.
            const expectedValue = kind === 'glob' ? value : expandHomePath(value);
            const newIndex = this.buildSettingsRows().findIndex(
                (row) => row.kind === kind && (kind === 'glob' ? row.value === expectedValue : row.value.path === expectedValue)
            );
            if (newIndex !== -1) {
                this.settingsIndex = newIndex;
            }
        } else {
            this.config = this.inputKind === 'glob' ? addGlob(this.config, value) : addProject(this.config, { path: value });
            this.editTarget = null;
        }
        this.persistConfig();
        this.query = this.savedQuery;
        this.inputError = '';
        this.view = 'settings';
        this.render();
    }

    cancelInput() {
        this.editTarget = null;
        this.query = this.savedQuery;
        this.inputError = '';
        this.view = 'settings';
        this.render();
    }

    moveSelection(delta) {
        const count = this.filtered().length;
        if (count === 0) {
            return;
        }
        this.selectedIndex = (this.selectedIndex + delta + count) % count;
        this.render();
    }

    updateProjects(projects) {
        this.projects = projects;
        this.render();
    }

    // Async and self-contained: never lets a discovery error surface as an unhandled
    // rejection, since every caller fires this without awaiting it (the timer, the
    // keyboard/click handlers, and main()'s post-start refresh all rely on that).
    //
    // Guards against overlapping calls resolving out of order (e.g. a manual Ctrl+R
    // landing while the initial post-start scan is still in flight): a call only
    // applies its result if no NEWER refreshProjects() call has started meanwhile —
    // a slower, stale scan must never overwrite a faster, fresher one.
    async refreshProjects() {
        const generation = ++this.refreshGeneration;
        try {
            const discovered = await discoverProjects(this.config.globs);
            saveProjectCache(discovered);
            if (generation !== this.refreshGeneration) {
                return;
            }
            this.updateProjects(mergeProjects(this.config.projects, discovered));
        } catch (error) {
            logError('picker.refreshProjects', error);
        }
    }

    resizePane(direction, amount) {
        if (!this.paneId) {
            return;
        }
        try {
            runHerdrText(['pane', 'resize', '--pane', this.paneId, '--direction', direction, '--amount', String(amount)]);
        } catch {}
    }

    static settle() {
        return new Promise((resolve) => setTimeout(resolve, Picker.RESIZE_SETTLE_MS));
    }

    static parseMouseSequence(chunk) {
        const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(chunk);
        if (!match) {
            return null;
        }
        const [, button, column, row, pressOrRelease] = match;
        return {
            button: Number(button),
            column: Number(column) - 1,
            row: Number(row) - 1,
            isPress: pressOrRelease === 'M',
        };
    }

    static hitsCollapseCorner(column, row, paneWidth, paneHeight) {
        return row === paneHeight - 1 && column >= paneWidth - 4;
    }

    // The title line is unconditionally the first line render() writes, in
    // every view, regardless of project/glob/settings-row count — unlike the
    // hint line (whose row depends on content length, see COLLAPSED_STRIP_ROWS
    // and the render() padding loop), row 0 never needs to be derived.
    static hitsGearIcon(column, row, paneWidth) {
        return row === 0 && column >= paneWidth - 4;
    }

    // collapse/expand mirrors herdr's own sidebar: the pane is resized step by
    // step until it reaches the target width; the shrink direction is detected
    // from the first step's effect (the sidebar may sit on either side)
    async toggleCollapse() {
        if (!this.paneId) {
            return;
        }
        if (this.collapsed) {
            const target = this.expandedCols || Picker.DEFAULT_COLUMNS / 2;
            const growDirection = this.shrinkDirection === 'left' ? 'right' : 'left';
            for (let step = 0; step < Picker.MAX_RESIZE_STEPS && (this.stdout.columns || 0) < target - 1; step += 1) {
                this.resizePane(growDirection, Picker.RESIZE_STEP);
                await Picker.settle();
            }
            this.collapsed = false;
            this.render();
            return;
        }
        this.expandedCols = this.stdout.columns || Picker.DEFAULT_COLUMNS;
        this.collapsed = true;
        this.render();
        let before = this.stdout.columns || 0;
        this.resizePane(this.shrinkDirection, Picker.RESIZE_STEP);
        await Picker.settle();
        if ((this.stdout.columns || 0) > before) {
            // first step grew the pane — the border sits on the other side
            this.shrinkDirection = this.shrinkDirection === 'left' ? 'right' : 'left';
            this.resizePane(this.shrinkDirection, Picker.RESIZE_STEP * 2);
            await Picker.settle();
        }
        for (let step = 0; step < Picker.MAX_RESIZE_STEPS && (this.stdout.columns || 0) > Picker.COLLAPSED_TARGET_COLS; step += 1) {
            before = this.stdout.columns || 0;
            this.resizePane(this.shrinkDirection, Picker.RESIZE_STEP);
            await Picker.settle();
            if ((this.stdout.columns || 0) >= before) {
                break;
            }
        }
        this.render();
    }

    openSelected(mode) {
        const items = this.filtered();
        const project = items[this.selectedIndex];
        if (!project) {
            return;
        }
        this.stop();
        try {
            if (mode === 'workspace') {
                openWorkspace({ cwd: project.path, label: project.name });
            } else {
                openTab({ cwd: project.path, label: project.name });
            }
        } catch (error) {
            process.stderr.write(`failed to open ${project.path}: ${error.message}\n`);
            process.exitCode = 1;
        }
    }

    static stripAnsi(text) {
        return text.replace(/\x1b\[[0-9;]*m/g, '');
    }

    withCornerGlyph(line, glyph, paneWidth, style = Picker.ANSI.dim) {
        const { ANSI } = Picker;
        const glyphVisibleWidth = 1;
        const textBudget = Math.max(0, paneWidth - 2 - glyphVisibleWidth);
        const plain = Picker.stripAnsi(line);
        const truncated = plain.length > textBudget ? `${plain.slice(0, Math.max(0, textBudget - 1))}…` : plain;
        const padding = ' '.repeat(Math.max(0, textBudget - truncated.length));
        return `${style}${truncated}${ANSI.reset}${padding} ${glyph}`;
    }

    render() {
        const { ANSI } = Picker;
        const paneWidth = this.stdout.columns || Picker.DEFAULT_COLUMNS;
        if (this.collapsed) {
            const countLine = this.withCornerGlyph(` ${ANSI.dim}${this.projects.length}${ANSI.reset}`, `${ANSI.cyan}${ANSI.bold}»${ANSI.reset}`, paneWidth);
            const strip = ['', '', '', ` ${ANSI.dim}P${ANSI.reset}`, ` ${ANSI.dim}M${ANSI.reset}`, '', countLine];
            this.stdout.write(ANSI.clear + strip.join('\n'));
            return;
        }
        if (this.view === 'settings') {
            this.renderSettings();
            return;
        }
        if (this.view === 'input') {
            this.renderInput();
            return;
        }
        const rows = this.stdout.rows || Picker.DEFAULT_ROWS;
        const maxVisible = Math.max(1, rows - Picker.CHROME_ROWS);
        const items = this.filtered();
        if (this.selectedIndex >= items.length) {
            this.selectedIndex = Math.max(0, items.length - 1);
        }
        const windowStart = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), items.length - maxVisible));
        const visible = items.slice(windowStart, windowStart + maxVisible);

        const nameWidth = Math.max(8, paneWidth - 6);

        const lines = [];
        const titleLine = `${ANSI.bold}${ANSI.cyan} Project Manager${ANSI.reset} ${ANSI.dim}(${items.length}/${this.projects.length})${ANSI.reset}`;
        lines.push(this.withCornerGlyph(titleLine, `${ANSI.dim}${Picker.GEAR_GLYPH}${ANSI.reset}`, paneWidth));
        lines.push(` ${ANSI.yellow}filter:${ANSI.reset} ${this.query}${ANSI.dim}▏${ANSI.reset}`);
        lines.push('');
        for (const [offset, project] of visible.entries()) {
            const isSelected = windowStart + offset === this.selectedIndex;
            const marker = isSelected ? `${ANSI.inverse}${ANSI.bold}` : '';
            const name = project.name.length > nameWidth ? `${project.name.slice(0, nameWidth - 1)}…` : project.name;
            lines.push(` ${ANSI.dim}${Picker.ROW_ICON}${ANSI.reset} ${marker} ${name} ${ANSI.reset}`);
        }
        if (items.length === 0) {
            lines.push(` ${ANSI.dim}no matches${ANSI.reset}`);
        }
        lines.push('');
        lines.push(` ${this.modeButton('workspace')} ${this.modeButton('tab')}`);
        while (lines.length < rows - 1) {
            lines.push('');
        }
        const hintLine = ` ⏎ open · ⇥ switch · < collapse · esc close`;
        lines.push(this.withCornerGlyph(hintLine, `${ANSI.cyan}«${ANSI.reset}`, paneWidth));
        this.stdout.write(ANSI.clear + lines.join('\n'));
    }

    renderSettings() {
        const { ANSI } = Picker;
        const paneWidth = this.stdout.columns || Picker.DEFAULT_COLUMNS;
        const titleLine = `${ANSI.bold}${ANSI.cyan} Settings${ANSI.reset}`;
        const lines = [this.withCornerGlyph(titleLine, `${ANSI.dim}${Picker.GEAR_GLYPH}${ANSI.reset}`, paneWidth), ''];
        for (const [index, row] of this.buildSettingsRows().entries()) {
            lines.push(this.renderSettingsRow(row, index === this.settingsIndex, paneWidth));
        }
        lines.push('');
        lines.push(` ${ANSI.dim}⏎ edit/activate · ⌫ delete · ⌃r refresh · ⌃g back · esc back${ANSI.reset}`);
        this.stdout.write(ANSI.clear + lines.join('\n'));
    }

    renderSettingsRow(row, isSelected, paneWidth) {
        const { ANSI } = Picker;
        const marker = isSelected ? `${ANSI.inverse}${ANSI.bold}` : '';
        if (row.kind === 'add-glob') {
            return ` ${marker}+ Add glob${ANSI.reset}`;
        }
        if (row.kind === 'add-project') {
            return ` ${marker}+ Add project${ANSI.reset}`;
        }
        if (row.kind === 'refresh') {
            return ` ${marker}↻ Refresh list${ANSI.reset}`;
        }
        const label = row.kind === 'glob' ? row.value : `${row.value.name} (${row.value.path})`;
        const style = isSelected ? `${ANSI.inverse}${ANSI.bold}` : ANSI.dim;
        return this.withCornerGlyph(` ${label}`, `${ANSI.dim}${Picker.DELETE_GLYPH}${ANSI.reset}`, paneWidth, style);
    }

    renderInput() {
        const { ANSI } = Picker;
        const verb = this.editTarget ? 'Edit' : 'Add';
        const label = this.inputKind === 'glob' ? `${verb} glob:` : `${verb} project path:`;
        const lines = [
            `${ANSI.bold}${ANSI.cyan} ${label}${ANSI.reset}`,
            '',
            ` ${this.query}${ANSI.dim}▏${ANSI.reset}`,
        ];
        if (this.inputError) {
            lines.push('', ` ${ANSI.dim}${this.inputError}${ANSI.reset}`);
        }
        lines.push('', ` ${ANSI.dim}⏎ confirm · esc cancel${ANSI.reset}`);
        this.stdout.write(ANSI.clear + lines.join('\n'));
    }

    modeButton(mode) {
        const { ANSI } = Picker;
        if (this.mode === mode) {
            return `${ANSI.inverse}${ANSI.bold}[ ${mode} ]${ANSI.reset}`;
        }
        return `${ANSI.dim}[ ${mode} ]${ANSI.reset}`;
    }

    static handleFatalError(error) {
        try {
            if (process.stdin.isTTY && process.stdin.setRawMode) {
                process.stdin.setRawMode(false);
            }
        } catch {
            // best-effort terminal reset only
        }
        process.stdout.write(`\x1b[?1006l\x1b[?1000l${Picker.ANSI.showCursor}${Picker.ANSI.reset}\n`);
        process.stderr.write(`project-manager: ${error && error.message ? error.message : error}\n`);
        logError('picker.fatal', error);
        process.exitCode = 1;
        process.exit(1);
    }

    // Accepts an optional io override (mirroring the constructor's own { stdin, stdout }
    // shape) so tests can exercise this wiring with the same stdinSpy()/stdoutSpy() stubs
    // used everywhere else in this class, instead of touching the real process streams.
    static main(io = { stdin: process.stdin, stdout: process.stdout }) {
        process.on('uncaughtException', Picker.handleFatalError);
        process.on('unhandledRejection', Picker.handleFatalError);

        const config = loadConfig();
        const cached = loadProjectCache();

        // Paint instantly from the last run's cache (possibly empty) and become
        // interactive immediately — glob discovery always refreshes in the background,
        // never before start(). Discovery on this user's real trees has taken 20+
        // seconds; running it synchronously here, before the picker exists at all,
        // used to freeze the pane for that whole span with no heartbeat and no input
        // handling, which is exactly what made a fresh dock look stuck and get
        // replaced by ensure-picker.js before it ever finished starting.
        const initialProjects = cached.length > 0 ? mergeProjects(config.projects, cached) : [];
        const picker = new Picker(initialProjects, io, config);

        // Zero projects with no TTY can't render the interactive settings editor either —
        // that's the one case still worth a plain message instead of start()'s own generic
        // "requires a TTY" line, since it also points at the fallback non-interactive action.
        if (initialProjects.length === 0 && !io.stdin.isTTY) {
            io.stdout.write('No projects configured.\nAdd globs or projects via the "Edit project list" action.\n');
            process.exitCode = 1;
            return undefined;
        }
        // Land straight in the settings view instead of an empty list — the whole
        // point is that the user has nothing to browse yet and needs to add one.
        if (initialProjects.length === 0) {
            picker.view = 'settings';
        }
        picker.start();
        setImmediate(() => picker.refreshProjects());
        return picker;
    }
}

if (require.main === module) {
    Picker.main();
}

module.exports = { Picker };
