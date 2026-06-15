# Coding Agent Instructions

Guidance for navigating and modifying this repository.

## What This Is

`ryl-vscode` is the Visual Studio Code extension for [ryl](https://github.com/owenlamont/ryl),
a fast Rust YAML linter. It is a **thin TypeScript client**: it spawns
`ryl server` (ryl's built-in language server) over stdio via
[`vscode-languageclient`](https://www.npmjs.com/package/vscode-languageclient)
and forwards diagnostics, code actions, formatting, hover, and rename. Almost all
behaviour lives in ryl's server; the contract is documented in the ryl repo at
[`docs/editor-integration.md`](https://github.com/owenlamont/ryl/blob/main/docs/editor-integration.md).
Keep the client thin: if a feature can be done in the server, it belongs there.

## Coding Standards

- Code maintainability is the top priority: a new agent should get all needed
  context from the docs and code with no surprising behaviour (the
  pit-of-success principle).
- Before a non-trivial feature or behaviour change, propose a short plan and
  agree the approach before writing code.
- Separate judgment calls from mechanical work. When a change turns on
  user-facing behaviour or a trade-off, lay out the options and let the
  maintainer decide; carry out clear-cut fixes and review feedback directly.
- Keep code succinct: every line has a maintenance and read-time cost. Prefer
  good naming over comments. Comment the *why* (non-obvious invariants,
  verified-behaviour notes, deliberate trade-offs), not the *what*.
- Lean on the linters/formatters to fix things (Biome, prek auto-fixes) rather
  than correcting by hand; only fix what they cannot.
- Do not rely on memory for third-party APIs: the `vscode-languageclient` and
  VS Code APIs evolve, so verify against current docs and the real ryl server.
- No en/em dashes in prose.

## Project Structure

- **`src/`** - the extension.
  - `extension.ts` - `activate`/`deactivate`, command registration, restart
    coalescing, fix-on-save, config-change and trust-grant restarts.
  - `client.ts` - builds and starts the `LanguageClient` (`ryl server`, YAML
    document selector, config-file watchers, output/trace channels).
  - `binary.ts` - resolves which `ryl` to run (see precedence below) and restores
    the bundled binary's executable bit at runtime.
  - `settings.ts` - reads VS Code settings and builds the server's
    `initializationOptions` (`configPath` / `enable`, camelCase to match ryl).
  - `constants.ts`, `logger.ts`.
  - `test/` - the `@vscode/test-electron` end-to-end suite and its fixtures.
- **`scripts/download-ryl.mjs`** - downloads the pinned ryl release binary into
  `bundled/` for a given VS Code target. `bundled/` is gitignored (populated at
  package time).
- **`.github/workflows/`** - CI (lint/typecheck/build) and the per-target VSIX
  release matrix.
- **`esbuild.mjs`** - bundles `src/extension.ts` to `dist/extension.js`.
- **`biome.json`**, **`prek.toml`** - linting/formatting (Biome + prek).
- **`.ryl.toml`** - ryl dogfoods this repo's own YAML.

## Code Change Requirements

- After any edit, `prek run --all-files` must pass. prek will not scan new files
  until they are `git add`ed, so stage new modules first.
- For behaviour changes, `npm test` (the end-to-end suite) must pass and any
  user-facing docs (README, CHANGELOG, settings descriptions) must be updated.
- Build: `npm run compile` (esbuild); production `npm run package`. Type-check:
  `npm run check-types` (`tsc --noEmit`). Lint/format: `npx biome check .`.
- `npm test` runs the suite in a real VS Code instance (downloaded to
  `.vscode-test/`). It needs a display; on Linux/WSL it uses the ambient
  `DISPLAY` (WSLg) or xvfb, and needs `ryl` resolvable (the suite uses
  `--disable-workspace-trust` so the resolver reaches PATH or the bundled binary).

## Demo recording

`npm run demo` (= `uv run scripts/record_demo.py`) records the feature-tour
GIFs/MP4s used in release media. It compiles and runs the montage
(src/test/demo/montage.test.ts) against src/test/demo-workspace in a real VS Code
instance, screen-captures it with ffmpeg, then blackdetect-trims and encodes one
clip **per scenario**: `demo/demo-yaml.{mp4,gif}` (plain YAML) and
`demo/demo-markdown.{mp4,gif}` (YAML in a fenced Markdown block). The recorder
runs the montage once per scenario via `RYL_DEMO_SCENARIO`; the montage signals
when the workbench is ready so capture opens on a clean editor. Demo-only: not
shipped in the VSIX or run in CI.

It is a uv-runnable PEP 723 script (stdlib only) so it works cross-platform. The
screen-capture device is OS-specific:

| OS | ffmpeg device | Headless? | Notes |
|----|---------------|-----------|-------|
| Linux | `x11grab` | yes (Xvfb) | needs `Xvfb`; capture is fully off-screen |
| Windows | `gdigrab` | no | captures the whole desktop (`-i desktop`); gdigrab cannot read the GPU/DWM-composited VS Code window per-title (it yields all-black frames), so maximize VS Code on a clean desktop; a real window appears for ~20s, do not click into it |
| macOS | `avfoundation` | no | captures a whole display (no per-window grab); grant the terminal Screen Recording permission and have VS Code maximised |

Prerequisites: `uv`, plus an ffmpeg/ffprobe whose build includes the platform's
capture device (verify with `ffmpeg -devices`). On Linux the pixi/conda ffmpeg
lacks `x11grab`, so the script prefers `/usr/bin/ffmpeg` (the apt build) automatically;
override it with `--ffmpeg`/`--ffprobe` if needed. All settings are Typer options
(`--width`/`--height`/`--fps`, `--display-num`, `--avf-input`,
`--ffmpeg`/`--ffprobe`, `--scenario`); run `uv run scripts/record_demo.py --help` for
the full list, and pass them through npm with `npm run demo -- --ffmpeg /usr/bin/ffmpeg`.
The Linux and Windows paths are verified; the macOS path follows ffmpeg's documented
device syntax and should be validated on a Mac.

## Binary Resolution

`resolveRylPath` (src/binary.ts) tries, in order: untrusted workspace -> bundled;
`ryl.path`; `importStrategy: useBundled`; workspace `.venv`/`venv`; system `PATH`;
bundled binary; bare `ryl`.

## VS Code Extension Best Practices (gotchas to preserve)

- **Thin client.** `vscode-languageclient` auto-wires diagnostics, code actions,
  formatting, hover, and rename from the server's advertised capabilities. Do not
  reimplement them client-side.
- **Position encoding is server-side.** ryl's server negotiates `positionEncoding`
  and does all column math. Never compute LSP columns in the client.
- **`@types/vscode` must equal `engines.vscode`** (both `1.82`). Keep the floor low
  so the extension stays installable on Cursor/VSCodium/Windsurf, which lag
  mainline VS Code. `vscode-languageclient@9` sets this floor; v10 would raise it
  to 1.91.
- **Per-target VSIX, binary bundled in.** Ship one platform-specific `.vsix` per VS
  Code target, each carrying only its ryl binary (offline, no first-run download).
- **A `.vsix` is a zip and can strip Unix exec bits**, so the bundled binary is
  `chmod 0o755`-ed at runtime (`binary.ts`).
- **Untrusted workspaces use the bundled binary only** and ignore `ryl.path` /
  `ryl.configPath` (a configured path could be attacker-controlled).
- **E2E test isolation:** give each test its own fixture file. Sharing one open
  document lets a fix in one test change another's preconditions.
- **esbuild bundles runtime deps** into `dist/extension.js`, so `node_modules` is
  excluded from the VSIX (see `.vscodeignore`).

## Versioning and Bundling

- The shipped ryl binary version is pinned as `RYL_VERSION` in
  `scripts/download-ryl.mjs`. Bump it to ship a newer ryl, then regenerate the
  checksums: `node scripts/download-ryl.mjs --update-checksums` and commit
  `scripts/ryl-checksums.json`. `download-ryl` verifies every downloaded asset's
  SHA-256 against that file before extraction, so a release tampered with after
  pin-time fails the build.
- ryl publishes no `x86_64-apple-darwin` (Intel macOS) binary, so `darwin-x64` is
  not a build target. Re-add it (to `TARGETS`, the release matrix, and the
  checksums) once ryl ships that asset.
- The extension version (`package.json`) is independent of ryl's version.

## Publishing (manual prerequisites)

CI publishes to the VS Marketplace and Open VSX on a tag, but requires one-time
setup by the maintainer:

- A VS Marketplace publisher named `owenlamont` and an Azure DevOps PAT stored as
  the `VSCE_PAT` repository secret.
- An Open VSX namespace `owenlamont` and a token stored as `OVSX_TOKEN`.

## Development Environment

- This repo is developed on macOS, Linux, and Windows; do not assume a POSIX
  shell. Use `gh` for PRs and issue inspection. Don't commit or push without
  per-action approval.
- Wait on long-running work (tests, CI) via background tasks rather than polling
  loops.
- When referencing another repo's issues in GitHub text, use the fully-qualified
  `owner/repo#123` form: a bare `#123` auto-links to *this* repo. Writing `@codex`
  anywhere in a PR/issue body or comment (even quoted) triggers the Codex bot;
  neutralize it as `&#64;codex` when writing about it.
