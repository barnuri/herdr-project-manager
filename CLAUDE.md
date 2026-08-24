# herdr-project-manager — agent instructions

## No persistent process to restart

Unlike its sibling plugins (herdr-telegram-notifications, herdr-auto-update, herdr-web-plugin),
this plugin has no `[[startup]]` entry in `herdr-plugin.toml` — every action (`picker`,
`open-picker`, `add-current`, `edit-config`) runs as a fresh one-shot process on each invocation.
Code changes here take effect immediately on the next action trigger; there is no long-running
watcher to restart.

If a future change adds a `[[startup]]` entry, add the same restart-on-change note the sibling
plugins carry — `herdr plugin enable`/`disable` does not respawn `[[startup]]` processes on
herdr 0.8.2 (confirmed empirically), only a real kill + relaunch does.
