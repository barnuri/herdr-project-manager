#!/usr/bin/env node
'use strict';

const { loadProjectCache, saveProjectCache } = require('../lib/cache');
const { loadConfig } = require('../lib/config');
const { discoverProjects, mergeProjects } = require('../lib/discover');
const { fuzzyFilter } = require('../lib/fuzzy');
const { openTab, openWorkspace } = require('../lib/herdr');

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
        ctrlW: '\x17',
        escape: '\x1b',
        enter: '\r',
        backspace: '\x7f',
        tab: '\t',
        ctrlT: '\x14',
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

    constructor(projects, io = { stdin: process.stdin, stdout: process.stdout }) {
        this.projects = projects;
        this.stdin = io.stdin;
        this.stdout = io.stdout;
        this.query = '';
        this.selectedIndex = 0;
        this.mode = 'workspace';
        this.onKey = this.onKey.bind(this);
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
        this.stdout.write(Picker.ANSI.hideCursor);
        this.render();
    }

    stop() {
        this.stdin.setRawMode(false);
        this.stdin.pause();
        this.stdin.off('data', this.onKey);
        this.stdout.write(Picker.ANSI.showCursor + Picker.ANSI.reset + '\n');
    }

    onKey(key) {
        const { KEY } = Picker;
        if (key === KEY.ctrlC || key === KEY.escape) {
            this.stop();
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

    render() {
        const { ANSI } = Picker;
        const rows = this.stdout.rows || Picker.DEFAULT_ROWS;
        const maxVisible = Math.max(1, rows - Picker.CHROME_ROWS);
        const items = this.filtered();
        if (this.selectedIndex >= items.length) {
            this.selectedIndex = Math.max(0, items.length - 1);
        }
        const windowStart = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), items.length - maxVisible));
        const visible = items.slice(windowStart, windowStart + maxVisible);

        const columns = this.stdout.columns || Picker.DEFAULT_COLUMNS;
        const nameWidth = Math.max(8, columns - 6);

        const lines = [];
        lines.push(`${ANSI.bold}${ANSI.cyan} Project Manager${ANSI.reset} ${ANSI.dim}(${items.length}/${this.projects.length})${ANSI.reset}`);
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
        lines.push(` ${ANSI.dim}⏎ open · ⇥ switch · esc close${ANSI.reset}`);
        this.stdout.write(ANSI.clear + lines.join('\n'));
    }

    modeButton(mode) {
        const { ANSI } = Picker;
        if (this.mode === mode) {
            return `${ANSI.inverse}${ANSI.bold}[ ${mode} ]${ANSI.reset}`;
        }
        return `${ANSI.dim}[ ${mode} ]${ANSI.reset}`;
    }

    static main() {
        const config = loadConfig();
        const cached = loadProjectCache();

        // paint instantly from the last run's cache; glob discovery refreshes in the background
        if (cached.length > 0) {
            const picker = new Picker(mergeProjects(config.projects, cached));
            picker.start();
            setImmediate(() => {
                const discovered = discoverProjects(config.globs);
                saveProjectCache(discovered);
                picker.updateProjects(mergeProjects(config.projects, discovered));
            });
            return;
        }

        const discovered = discoverProjects(config.globs);
        saveProjectCache(discovered);
        const projects = mergeProjects(config.projects, discovered);
        if (projects.length === 0) {
            process.stdout.write('No projects configured.\nAdd globs or projects via the "Edit project list" action.\n');
            if (!process.stdin.isTTY) {
                process.exitCode = 1;
                return;
            }
            process.stdout.write('Press any key to close…');
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.once('data', () => process.exit(0));
            return;
        }
        new Picker(projects).start();
    }
}

if (require.main === module) {
    Picker.main();
}

module.exports = { Picker };
