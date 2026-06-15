import * as vscode from "vscode";

export type ImportStrategy = "fromEnvironment" | "useBundled";

export interface RylSettings {
  enable: boolean;
  path: string;
  importStrategy: ImportStrategy;
  configPath: string;
  fixOnSave: boolean;
}

export function getSettings(scope?: vscode.ConfigurationScope): RylSettings {
  const config = vscode.workspace.getConfiguration("ryl", scope);
  return {
    enable: config.get<boolean>("enable", true),
    path: config.get<string>("path", "").trim(),
    importStrategy: config.get<ImportStrategy>("importStrategy", "fromEnvironment"),
    configPath: config.get<string>("configPath", "").trim(),
    fixOnSave: config.get<boolean>("fixOnSave", false),
  };
}

/**
 * Options forwarded to `ryl server` at startup. Keys are camelCase to match the
 * server's `initializationOptions` parser (configPath / enable in src/lsp/mod.rs);
 * an incorrectly cased key is silently ignored, so keep these aligned with ryl.
 */
export interface RylInitializationOptions {
  configPath?: string;
  enable: boolean;
}

export function buildInitializationOptions(settings: RylSettings): RylInitializationOptions {
  return {
    configPath: settings.configPath || undefined,
    enable: settings.enable,
  };
}
