# Changelog

All notable changes to the ryl VS Code extension are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Lint YAML embedded in Markdown (front matter and fenced ```yaml blocks) in the
  editor: Markdown files are forwarded to `ryl server`, which lints them when the
  ryl config opts in via `[files].markdown`. Live diagnostics, hover, and fix-all
  work on Markdown; per-line disable and rename remain YAML-only.
- Initial extension: a thin client over `ryl server` (ryl's language server)
  providing live diagnostics, fix-all, document formatting, hover, anchor/alias
  rename, and disable-rule quick fixes for YAML files.
- A per-platform ryl binary is bundled with the extension, with override via the
  `ryl.path` setting, a workspace virtual environment, the system `PATH`, or
  `ryl.importStrategy: useBundled`.
- Settings: `ryl.enable`, `ryl.path`, `ryl.importStrategy`, `ryl.configPath`,
  `ryl.fixOnSave`, `ryl.trace.server`.
- Commands: `ryl.fixAll`, `ryl.restart`, `ryl.showClientLogs`, `ryl.showServerLogs`.
