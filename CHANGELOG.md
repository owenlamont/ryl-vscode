# Changelog

All notable changes to the ryl VS Code extension are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1]

### Changed

- Bundle ryl 0.21.0 (was 0.18.1). Diagnostics now honour a document's `%YAML`
  version directive, and `YAMLLINT_CONFIG_FILE` is read only when it points at a
  yamllint YAML config.

### Fixed

- A `.config/ryl.toml` config file is discovered again. Discovery landed in ryl
  0.19.0 and the extension still bundled 0.18.1, which predates it
  ([ryl#399](https://github.com/owenlamont/ryl/issues/399)).
- The `tags` rule no longer misses a tag split across a `%TAG` directive.

## [0.2.0]

### Added

- Lint YAML embedded in Markdown (front matter and fenced ```yaml blocks) in the
  editor: Markdown files are forwarded to `ryl server`, which lints them when the
  ryl config opts in via `[files].markdown`. Live diagnostics, hover, and fix-all
  work on Markdown; per-line disable and rename remain YAML-only.

### Fixed

- Diagnostics are no longer reported twice in the editor. This bundles ryl 0.18.1,
  whose language server no longer pushes diagnostics to a client that also pulls
  them (the two were landing in separate diagnostic collections).

## [0.1.0]

### Added

- Initial extension: a thin client over `ryl server` (ryl's language server)
  providing live diagnostics, fix-all, document formatting, hover, anchor/alias
  rename, and disable-rule quick fixes for YAML files.
- A per-platform ryl binary is bundled with the extension, with override via the
  `ryl.path` setting, a workspace virtual environment, the system `PATH`, or
  `ryl.importStrategy: useBundled`.
- Settings: `ryl.enable`, `ryl.path`, `ryl.importStrategy`, `ryl.configPath`,
  `ryl.fixOnSave`, `ryl.trace.server`.
- Commands: `ryl.fixAll`, `ryl.restart`, `ryl.showClientLogs`, `ryl.showServerLogs`.
