import { execFile } from "node:child_process";
import * as path from "node:path";

export type FolderFixResult =
  | { kind: "fixed"; fixed: number; remaining: number }
  | { kind: "failed"; message: string; output: string }
  | { kind: "cancelled" };

const SUMMARY = /^Found \d+ problems? \((\d+) fixed, (\d+) remaining\)/m;

/**
 * Resolve `configPath` the way `ryl server` does: the server takes the path as-is,
 * so a relative one resolves against its cwd, the first workspace folder.
 */
export function resolveConfigPath(configPath: string, firstFolder: string): string | undefined {
  return configPath ? path.resolve(firstFolder, configPath) : undefined;
}

export function fixFolder(
  ryl: string,
  folder: string,
  configPath: string | undefined,
  signal?: AbortSignal,
): Promise<FolderFixResult> {
  // parsable keeps a colour-forcing environment variable from injecting ANSI codes.
  const args = ["check", "--fix", "--output-format", "parsable", "."];
  if (configPath) {
    args.push("--config-file", configPath);
  }
  return new Promise((resolve) => {
    execFile(
      ryl,
      args,
      { cwd: folder, signal, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (signal?.aborted) {
          resolve({ kind: "cancelled" });
          return;
        }
        const output = `${stdout}${stderr}`;
        const summary = SUMMARY.exec(output);
        const errorLine = /^error: .*/m.exec(stderr)?.[0];
        // A non-zero exit with a summary and no `error:` line is problems remaining, including
        // `lint.strict` warnings; a config, spawn or write error is a failure.
        if (error && (!summary || errorLine)) {
          const message = errorLine ?? error.message;
          resolve({ kind: "failed", message, output });
          return;
        }
        resolve({
          kind: "fixed",
          fixed: Number(summary?.[1] ?? 0),
          remaining: Number(summary?.[2] ?? 0),
        });
      },
    );
  });
}
