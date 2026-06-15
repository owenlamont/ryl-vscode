import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import which from "which";
import { BUNDLED_RYL_PATH, RYL_BINARY_NAME } from "./constants";
import { log } from "./logger";
import type { RylSettings } from "./settings";

/**
 * Resolve the `ryl` executable to spawn. Precedence:
 *   untrusted workspace -> bundled (a configured path could point at a hostile
 *   binary); `ryl.path` setting; `importStrategy: useBundled`; workspace
 *   virtual environment; system PATH; bundled binary; bare command name.
 */
export async function resolveRylPath(settings: RylSettings): Promise<string> {
  if (!vscode.workspace.isTrusted) {
    log("Untrusted workspace: using the bundled ryl binary.");
    return bundledRyl();
  }
  if (settings.path) {
    const resolved = resolveConfiguredPath(settings.path);
    log(`Using ryl from the ryl.path setting: ${resolved}`);
    return resolved;
  }
  if (settings.importStrategy === "useBundled") {
    log("importStrategy is useBundled: using the bundled ryl binary.");
    return bundledRyl();
  }
  const venv = findWorkspaceVenvRyl();
  if (venv) {
    log(`Using ryl from the workspace virtual environment: ${venv}`);
    return venv;
  }
  const onPath = await which(RYL_BINARY_NAME, { nothrow: true });
  if (onPath) {
    log(`Using ryl from PATH: ${onPath}`);
    return onPath;
  }
  if (fs.existsSync(BUNDLED_RYL_PATH)) {
    log(`Using the bundled ryl binary: ${BUNDLED_RYL_PATH}`);
    return bundledRyl();
  }
  log(`No ryl binary found; falling back to "${RYL_BINARY_NAME}" on PATH.`);
  return RYL_BINARY_NAME;
}

/**
 * Return the bundled binary path, restoring the executable bit first: packaging
 * a .vsix (a zip) can drop Unix permission bits, leaving the shipped binary
 * non-executable on the user's machine.
 */
function bundledRyl(): string {
  if (process.platform !== "win32" && fs.existsSync(BUNDLED_RYL_PATH)) {
    try {
      fs.accessSync(BUNDLED_RYL_PATH, fs.constants.X_OK);
    } catch {
      try {
        fs.chmodSync(BUNDLED_RYL_PATH, 0o755);
      } catch (error) {
        log(`Could not mark bundled ryl executable (${BUNDLED_RYL_PATH}): ${String(error)}`);
      }
    }
  }
  return BUNDLED_RYL_PATH;
}

/**
 * Expand a leading `~`, return absolute and bare-command paths unchanged, and
 * resolve a relative path against the first workspace folder.
 */
function resolveConfiguredPath(configured: string): string {
  let candidate = configured;
  if (candidate === "~" || candidate.startsWith("~/") || candidate.startsWith("~\\")) {
    candidate = path.join(os.homedir(), candidate.slice(1));
  }
  if (path.isAbsolute(candidate)) {
    return candidate;
  }
  // A bare command name (no separators) is left for PATH resolution.
  if (!candidate.includes("/") && !candidate.includes("\\")) {
    return candidate;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? path.join(folder.uri.fsPath, candidate) : candidate;
}

function findWorkspaceVenvRyl(): string | undefined {
  const binDir = process.platform === "win32" ? "Scripts" : "bin";
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    for (const venv of [".venv", "venv"]) {
      const candidate = path.join(folder.uri.fsPath, venv, binDir, RYL_BINARY_NAME);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}
