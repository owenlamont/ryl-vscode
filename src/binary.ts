import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import which from "which";
import { BUNDLED_RYL_PATH, RYL_BINARY_NAME } from "./constants";
import { log } from "./logger";
import type { RylSettings } from "./settings";

const execFileAsync = promisify(execFile);

// The first ryl release with the `ryl server` LSP subcommand. An environment ryl
// older than this cannot run the language server, so resolution skips it in
// favour of the bundled binary rather than spawning a `ryl` that has no `server`.
const MINIMUM_RYL_VERSION = "0.18.0";

// Warn at most once per session when an incompatible environment ryl is ignored.
let warnedIncompatibleRyl = false;

/**
 * Resolve the `ryl` executable to spawn. Precedence:
 *   untrusted workspace -> bundled (a configured path could point at a hostile
 *   binary); `ryl.path` setting; `importStrategy: useBundled`; workspace
 *   virtual environment; system PATH; bundled binary; bare command name.
 *
 * An environment ryl (venv or PATH) is used only if it is new enough for the
 * `ryl server` LSP (>= MINIMUM_RYL_VERSION); an older one is skipped in favour of
 * the bundled binary, so a stale install (e.g. an old global ryl on PATH) cannot
 * silently break the language server. An explicit `ryl.path` is trusted as-is.
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
  let incompatible: string | undefined;
  const venv = findWorkspaceVenvRyl();
  if (venv) {
    if (await rylSupportsServer(venv)) {
      log(`Using ryl from the workspace virtual environment: ${venv}`);
      return venv;
    }
    log(`Ignoring ryl in the workspace virtual environment (too old for \`ryl server\`): ${venv}`);
    incompatible = venv;
  }
  const onPath = await which(RYL_BINARY_NAME, { nothrow: true });
  if (onPath) {
    if (await rylSupportsServer(onPath)) {
      log(`Using ryl from PATH: ${onPath}`);
      return onPath;
    }
    log(`Ignoring ryl on PATH (too old for \`ryl server\`): ${onPath}`);
    incompatible ??= onPath;
  }
  if (fs.existsSync(BUNDLED_RYL_PATH)) {
    if (incompatible) {
      warnIncompatibleRyl(incompatible);
    }
    log(`Using the bundled ryl binary: ${BUNDLED_RYL_PATH}`);
    return bundledRyl();
  }
  log(`No ryl binary found; falling back to "${RYL_BINARY_NAME}" on PATH.`);
  return RYL_BINARY_NAME;
}

/** Whether `rylPath --version` reports a version >= MINIMUM_RYL_VERSION (so it has `ryl server`). */
async function rylSupportsServer(rylPath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(rylPath, ["--version"], { timeout: 5000 });
    return meetsMinimum(stdout);
  } catch {
    // Cannot run it, or it has no --version: treat as unusable for the LSP.
    return false;
  }
}

/** Parse a "ryl X.Y.Z" version string and compare it against MINIMUM_RYL_VERSION. */
function meetsMinimum(versionOutput: string): boolean {
  const found = versionOutput.match(/(\d+)\.(\d+)\.(\d+)/);
  const minimum = MINIMUM_RYL_VERSION.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!found || !minimum) {
    return false;
  }
  for (let part = 1; part <= 3; part++) {
    const actual = Number(found[part]);
    const required = Number(minimum[part]);
    if (actual !== required) {
      return actual > required;
    }
  }
  return true;
}

function warnIncompatibleRyl(rylPath: string): void {
  if (warnedIncompatibleRyl) {
    return;
  }
  warnedIncompatibleRyl = true;
  void vscode.window.showWarningMessage(
    `The ryl found at ${rylPath} is too old for the language server (needs ${MINIMUM_RYL_VERSION} or newer); using the bundled binary instead. Update ryl, or set ryl.path / ryl.importStrategy to override.`,
  );
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
