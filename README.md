# herdr-project-manager

Project manager plugin for [herdr](https://herdr.dev) — inspired by the VSCode
[Project Manager](https://marketplace.visualstudio.com/items?itemName=alefragnani.project-manager)
extension. Keep a list of your projects (auto-discovered by glob patterns or added manually) and
jump into any of them as a new herdr **tab** or **workspace** from a fuzzy-filter picker.

## Features

- **Glob auto-discovery** — patterns like `~/sandbox/*/.git` find every repo automatically
  (a match on a `.git` directory registers its parent as the project).
- **Manual projects** — pin any directory with a custom name.
- **Fuzzy picker** in a herdr popup pane: type to filter, `Enter` opens the project as a new
  tab, `Ctrl+W` opens it as a new workspace, `Esc` closes.
- **Add current directory** action — one keypress to track the project you're standing in.
- Zero npm dependencies; plain Node.js (>= 22).

## Install

```bash
herdr plugin install barnuri/herdr-project-manager
```

Or for local development:

```bash
git clone https://github.com/barnuri/herdr-project-manager
herdr plugin link ./herdr-project-manager
```

## Usage

| What | How |
|---|---|
| Open the picker | Run the `Open project picker` action, or `herdr plugin pane open --plugin barnuri.project-manager --entrypoint picker` |
| Add current directory | Run the `Add current directory as project` action |
| Edit the project list | Run the `Edit project list` action (opens the config in `$EDITOR` in a new tab) |

Bind the picker to a key in your herdr `config.toml`:

```toml
[[keys.command]]
key = "prefix+p"
type = "plugin_action"
command = "barnuri.project-manager.open-picker"
description = "open project picker"
```

## Configuration

The config lives in the plugin's config directory (`herdr plugin config-dir barnuri.project-manager`),
in `projects.json`:

```json
{
    "globs": ["~/sandbox/*/.git", "~/work/**/.git"],
    "projects": [
        { "name": "dotfiles", "path": "~/.dotfiles" }
    ]
}
```

- `globs` — patterns expanded on every picker launch; `~` is expanded; a `.git` match registers
  its parent directory.
- `projects` — manual entries; they win over discovered entries on the same path.

## Development

```bash
npm test          # node --test tests/
herdr plugin link .
```

## Publishing note

The herdr marketplace indexes public GitHub repos carrying the `herdr-plugin` topic — add that
topic to the repo to make the plugin discoverable.

## License

MIT
