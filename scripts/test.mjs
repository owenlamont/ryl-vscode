import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(path.join(tmpdir(), "ryl-vscode-tests-"));
try {
  const executable = await downloadAndUnzipVSCode();
  for (const mode of ["trusted", "restricted"]) {
    const directory = path.join(temporary, mode);
    const profile = path.join(directory, "profile");
    mkdirSync(path.join(profile, "User"), { recursive: true });
    writeFileSync(
      path.join(profile, "User", "settings.json"),
      JSON.stringify({
        "ryl.importStrategy": "useBundled",
        "security.workspace.trust.startupPrompt": "never",
      }),
    );
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      XDG_CONFIG_HOME: path.join(directory, "config"),
      XDG_CACHE_HOME: path.join(directory, "cache"),
      RYL_SCHEMA_CACHE_DIR: path.join(directory, "schemas"),
      RYL_SCHEMA_ALLOWED_ORIGINS: "",
      RYL_OFFLINE: "0",
      RYL_NO_CACHE: "0",
      RYL_TEST_MODE: mode,
    };
    const args = [
      path.join(root, "src/test/fixtures"),
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--disable-updates",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-extensions",
      "--user-data-dir",
      profile,
      "--extensions-dir",
      path.join(directory, "extensions"),
      `--extensionDevelopmentPath=${root}`,
      `--extensionTestsPath=${path.join(root, "out/test/run.js")}`,
    ];
    // test-electron's runTests always disables Workspace Trust, so launch the downloaded host directly.
    if (mode === "trusted") args.push("--disable-workspace-trust");
    console.log(`Running ${mode} tests with isolated state in ${directory}`);
    await new Promise((resolve, reject) => {
      const child = spawn(executable, args, { env, stdio: "inherit" });
      const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`${mode} tests exited with ${code ?? signal}`));
      });
    });
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
