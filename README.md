# ryl for Visual Studio Code

Visual Studio Code support for [ryl](https://github.com/owenlamont/ryl), a fast
YAML linter and formatter written in Rust. The extension is a thin client that runs
`ryl server`, ryl's built-in language server, so all linting, fixing, and formatting
is done by ryl itself.

A platform-specific build of ryl is bundled with the extension, so it works with
no separate install. If you already have ryl on your `PATH` or in a project
environment, the extension uses that instead (see [How ryl is located](#how-ryl-is-located)).

**Lint YAML as you type, then fix and format it:**

![ryl linting, auto-fixing, and formatting YAML in VS Code](https://raw.githubusercontent.com/owenlamont/ryl-vscode/main/images/demo-yaml.gif)

**...including YAML embedded in Markdown front matter and fenced blocks:**

![ryl linting, auto-fixing, and formatting YAML embedded in a Markdown file](https://raw.githubusercontent.com/owenlamont/ryl-vscode/main/images/demo-markdown.gif)

## Features

- **Live diagnostics.** YAML files are linted as you type, with squiggles that
  clear as you fix them.
- **YAML in Markdown.** When your ryl config opts in (`[files].markdown`), front
  matter and fenced ```yaml blocks in Markdown files are linted too, with
  diagnostics mapped back to the Markdown file. Markdown supports live
  diagnostics, hover, and fix-all (per-line disable and rename stay YAML-only).
- **Fix all.** Apply every safe ryl fix to a document via the `ryl.fixAll`
  command, the `source.fixAll.ryl` code action, or on save. `ryl.fixAllWorkspace`
  runs `ryl check --fix` over every workspace folder instead, after saving open
  editors, and reports how many problems it fixed.
- **Formatting.** Format Document runs `ryl format` with your config's `[format]`
  settings, for YAML files and YAML embedded in Markdown. Set ryl as the default
  formatter to format on save (see [Setup](#recommended-setup)).
- **Quick fixes.** Insert `# ryl disable-line` / `# ryl disable-file` directives
  to silence a rule for a line or file.
- **Hover.** Hover a diagnostic to see the rule, message, and a link to its docs.
- **Rename.** Rename a YAML anchor and its aliases together.

## Requirements

None. The extension bundles the matching ryl binary for your platform. Optionally
install ryl yourself (for example `uv tool install ryl`, `pip install ryl`,
`cargo install ryl`, `npm install ryl`, or `pixi global install ryl`) and the
extension will prefer it.

## Recommended setup

Add this to your settings to make ryl your YAML formatter and to apply safe lint
fixes on save:

```json
{
  "[yaml]": {
    "editor.defaultFormatter": "owenlamont.ryl",
    "editor.formatOnSave": true,
    "editor.codeActionsOnSave": {
      "source.fixAll.ryl": "explicit"
    }
  }
}
```

`ryl.fixOnSave` is a convenience equivalent to the `codeActionsOnSave` entry
above; pick whichever you prefer. Formatting and fixes are separate: Format
Document applies `ryl format`, while fix-all applies the safe fixes of your enabled
lint rules. Add `"[markdown]"` with the same `editor.defaultFormatter` to format
YAML embedded in Markdown when your config opts in (`[files].markdown`).

If an enabled lint rule's options disagree with a `[format]` setting (for example
`new-lines` with `type = "unix"` beside `line-ending = "cr-lf"`), ryl still formats
and shows a warning naming the rule and the setting to change. See ryl's
[conflicting lint rules](https://ryl-docs.pages.dev/formatter/#conflicting-lint-rules).

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `ryl.enable` | `true` | Enable the ryl language server. |
| `ryl.path` | `""` | Path to the `ryl` executable. Empty uses auto-detection (see below). |
| `ryl.importStrategy` | `fromEnvironment` | `fromEnvironment` prefers a ryl in your environment; `useBundled` always uses the bundled binary. |
| `ryl.configPath` | `""` | Path to a ryl config file (`ryl.toml`, `.ryl.toml`, or a deprecated yamllint-style config). Empty uses normal config discovery. |
| `ryl.fixOnSave` | `false` | Apply all safe fixes when saving a YAML file. |
| `ryl.trace.server` | `off` | Trace the LSP traffic between VS Code and ryl. |

## Commands

All commands are available from the Command Palette under the `ryl` category:

- **ryl: Fix all auto-fixable problems** (`ryl.fixAll`)
- **ryl: Fix all auto-fixable problems in workspace** (`ryl.fixAllWorkspace`)
- **ryl: Restart Server** (`ryl.restart`)
- **ryl: Show client logs** (`ryl.showClientLogs`)
- **ryl: Show server logs** (`ryl.showServerLogs`)

## How ryl is located

When `ryl.path` is empty, the extension resolves the executable in this order:

1. The `ryl.path` setting, if set.
2. The bundled binary, if `ryl.importStrategy` is `useBundled`.
3. A workspace virtual environment (`.venv`/`venv`).
4. The system `PATH`.
5. The binary bundled with the extension.

In an untrusted workspace the bundled binary is always used, and `ryl.path` /
`ryl.configPath` are ignored.

## Configuration

ryl discovers its configuration (`ryl.toml`, `.ryl.toml`, `[tool.ryl]` in
`pyproject.toml`, or a deprecated yamllint config) exactly as it does on the command line.
Set `ryl.configPath` to point at a specific file. See the
[ryl configuration docs](https://github.com/owenlamont/ryl) for the rules and
options.

## Coexistence with the Red Hat YAML extension

ryl is a linter and formatter, so it sits alongside the
[Red Hat YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml)
rather than replacing it: ryl owns lint and fix, Red Hat owns schema validation,
completion, and hover for schema-backed keys.

## Contributing

```sh
npm install            # install dependencies
npm run compile        # bundle the extension with esbuild
npm run download-ryl   # download the ryl binary into bundled/ for local runs
npm test               # run the end-to-end suite in a real VS Code instance
```

Press `F5` in VS Code to launch the extension in an Extension Development Host.
Linting and formatting are managed by [prek](https://prek.j178.dev) and
[Biome](https://biomejs.dev); run `prek run --all-files`.

## License

[MIT](LICENSE)
