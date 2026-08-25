# herdr-project-manager — agent instructions

## No persistent process to restart

Unlike its sibling plugins (herdr-telegram-notifications, herdr-auto-update, herdr-web-plugin),
this plugin has no `[[startup]]` entry in `herdr-plugin.toml` — every action (`picker`,
`open-picker`, `add-current`, `edit-config`) runs as a fresh one-shot process on each invocation.
Code changes here take effect immediately on the next action trigger; there is no long-running
watcher to restart.

## But an open picker pane is long-running — close it to pick up changes

`open-picker`, `add-current` and `edit-config` exit in milliseconds, so they always run the
code on disk. `picker` does not: once docked, it stays alive for the life of the pane, so an
already-open sidebar keeps executing the `bin/picker.js` and `lib/*.js` it loaded at startup.
Editing those files changes nothing in a pane that is already up — the change only lands in a
pane opened afterwards.

After changing picker code, verify in a *fresh* pane: close the docked sidebar (`Ctrl+Q` or
the `Open project picker` toggle action) and let it re-dock, or check with
`ps -eo pid,lstart,command | grep picker.js` that the pane's process started after the file's
mtime. A stale pane looks exactly like a broken feature — mouse clicks, new keys, and new
settings rows are all simply absent.

If a future change adds a `[[startup]]` entry, add the same restart-on-change note the sibling
plugins carry — `herdr plugin enable`/`disable` does not respawn `[[startup]]` processes on
herdr 0.8.2 (confirmed empirically), only a real kill + relaunch does.
