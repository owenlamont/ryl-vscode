import * as vscode from "vscode";

export type ImportStrategy = "fromEnvironment" | "useBundled";
export type DiagnosticMode = "openFilesOnly" | "workspace";

export interface RylSettings {
  enable: boolean;
  path: string;
  importStrategy: ImportStrategy;
  configPath: string;
  fixOnSave: boolean;
  diagnosticMode: DiagnosticMode;
}

export function getSettings(scope?: vscode.ConfigurationScope): RylSettings {
  const config = vscode.workspace.getConfiguration("ryl", scope);
  return {
    enable: config.get<boolean>("enable", true),
    path: config.get<string>("path", "").trim(),
    importStrategy: config.get<ImportStrategy>("importStrategy", "fromEnvironment"),
    configPath: config.get<string>("configPath", "").trim(),
    fixOnSave: config.get<boolean>("fixOnSave", false),
    diagnosticMode: config.get<DiagnosticMode>("diagnosticMode", "openFilesOnly"),
  };
}

/**
 * Options forwarded to `ryl server` at startup and, under a `ryl` section, in
 * `workspace/didChangeConfiguration`. Keys are camelCase to match the server's
 * settings parser (`Settings::from_options` in src/lsp/mod.rs), which resets any
 * omitted key to its default, so always send the full set.
 */
export interface RylInitializationOptions {
  configPath?: string;
  enable: boolean;
  diagnosticMode: DiagnosticMode;
}

export function buildInitializationOptions(settings: RylSettings): RylInitializationOptions {
  return {
    configPath: settings.configPath || undefined,
    enable: settings.enable,
    diagnosticMode: settings.diagnosticMode,
  };
}
