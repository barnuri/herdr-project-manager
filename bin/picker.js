#!/usr/bin/env node
'use strict';

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
        up: '\x1b[A',
        down: '\x1b[B',
    };

    static NAME_COLUMN_WIDTH = 28;

    static DEFAULT_ROWS = 24;

    static CHROME_ROWS = 5;

    constructor(projects, io = { stdin: process.stdin, stdout: process.stdout }) {
        this.projects = projects;
        this.stdin = io.stdin;
        this.stdout = io.stdout;
        this.query = '';
        this.selectedIndex = 0;
        this.onKey = this.onKey.bind(this);
    }

    filtered() {
        return fuzzyFilter(this.projects, this.query, (p) => `${p.name} ${p.path}`);
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
            this.openSelected('tab');
            return;
        }
        if (key === KEY.ctrlW) {
            this.openSelected('workspace');
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

        const lines = [];
        lines.push(`${ANSI.bold}${ANSI.cyan} Projects${ANSI.reset} ${ANSI.dim}(${items.length}/${this.projects.length})${ANSI.reset}`);
        lines.push(` ${ANSI.yellow}filter:${ANSI.reset} ${this.query}${ANSI.dim}▏${ANSI.reset}`);
        lines.push('');
        for (const [offset, project] of visible.entries()) {
            const isSelected = windowStart + offset === this.selectedIndex;
            const marker = isSelected ? `${ANSI.inverse}${ANSI.bold}` : '';
            const name = project.name.padEnd(Picker.NAME_COLUMN_WIDTH).slice(0, Picker.NAME_COLUMN_WIDTH);
            lines.push(` ${marker} ${name} ${ANSI.reset}${marker}${ANSI.dim} ${project.path}${ANSI.reset}`);
        }
        if (items.length === 0) {
            lines.push(` ${ANSI.dim}no matches${ANSI.reset}`);
        }
        lines.push('');
        lines.push(` ${ANSI.dim}enter=open tab · ctrl+w=open workspace · esc=close${ANSI.reset}`);
        this.stdout.write(ANSI.clear + lines.join('\n'));
    }

    static main() {
        const config = loadConfig();
        const discovered = discoverProjects(config.globs);
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
