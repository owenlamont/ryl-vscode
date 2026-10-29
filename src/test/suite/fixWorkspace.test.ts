import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { resolveRylPath } from "../../binary";
import { fixFolder, resolveConfigPath } from "../../fixWorkspace";
import { getSettings } from "../../settings";

const RULES = '[lint.rules]\ntrailing-spaces = "enable"\nkey-duplicates = "enable"\n';

// The command rewrites every file in the workspace folder, which here holds the
// other suites' fixtures, so these tests drive fixFolder on a throwaway folder.
suite("ryl workspace fix", () => {
  let folder: string;

  setup(() => {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), "ryl-fix-workspace-"));
  });

  teardown(() => {
    fs.rmSync(folder, { recursive: true, force: true });
  });

  // ryl's walk honours .gitignore, which covers the other suites' *.generated.*
  // fixtures: they stay untouched, and this file must not match that pattern.
  test("ryl.fixAllWorkspace fixes a file in the workspace folder", async () => {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspace, "expected the fixtures directory as the workspace folder");
    const file = path.join(workspace.uri.fsPath, "workspace-fix.yaml");
    fs.writeFileSync(file, "a: 1   \n");
    try {
      await vscode.commands.executeCommand("ryl.fixAllWorkspace");
      assert.strictEqual(fs.readFileSync(file, "utf8"), "a: 1\n");
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test("fixes files on disk and counts fixed and remaining problems", async () => {
    fs.writeFileSync(path.join(folder, ".ryl.toml"), RULES);
    fs.mkdirSync(path.join(folder, "nested"));
    fs.writeFileSync(path.join(folder, "nested", "a.yaml"), "a: 1   \n");
    // A diagnostic quoting summary-shaped text must not be read as the summary.
    const key = '"(9 fixed, 9 remaining)"';
    fs.writeFileSync(path.join(folder, "b.yml"), `${key}: 1\n${key}: 2\n`);
    const result = await fixFolder(await resolveRylPath(getSettings()), folder, undefined);
    assert.deepStrictEqual(result, { kind: "fixed", fixed: 1, remaining: 1 });
    assert.strictEqual(fs.readFileSync(path.join(folder, "nested", "a.yaml"), "utf8"), "a: 1\n");
  });

  test("an explicit config path replaces discovery", async () => {
    const config = path.join(folder, "custom.toml");
    fs.writeFileSync(config, RULES);
    fs.writeFileSync(path.join(folder, "a.yaml"), "a: 1   \n");
    const result = await fixFolder(await resolveRylPath(getSettings()), folder, config);
    assert.deepStrictEqual(result, { kind: "fixed", fixed: 1, remaining: 0 });
  });

  test("a strict run that leaves only warnings still counts its fixes", async () => {
    fs.writeFileSync(
      path.join(folder, ".ryl.toml"),
      '[lint]\nstrict = true\n[lint.rules]\ntrailing-spaces = "enable"\nkey-duplicates = { level = "warning" }\n',
    );
    fs.writeFileSync(path.join(folder, "a.yaml"), "a: 1   \na: 2\n");
    const result = await fixFolder(await resolveRylPath(getSettings()), folder, undefined);
    assert.deepStrictEqual(result, { kind: "fixed", fixed: 1, remaining: 1 });
  });

  test("a file ryl cannot write fails with ryl's message", async function () {
    if (process.platform === "win32") {
      this.skip();
    }
    fs.writeFileSync(path.join(folder, ".ryl.toml"), RULES);
    const file = path.join(folder, "a.yaml");
    fs.writeFileSync(file, "a: 1   \n");
    fs.chmodSync(file, 0o444);
    const result = await fixFolder(await resolveRylPath(getSettings()), folder, undefined);
    assert.strictEqual(result.kind, "failed");
    assert.match(result.message, /a\.yaml/);
  });

  test("a config error fails with ryl's message", async () => {
    fs.writeFileSync(path.join(folder, "a.yaml"), "a: 1   \n");
    const missing = path.join(folder, "missing.toml");
    const result = await fixFolder(await resolveRylPath(getSettings()), folder, missing);
    assert.strictEqual(result.kind, "failed");
    assert.match(result.message, /missing\.toml/);
  });

  test("an aborted run reports cancelled, not failed", async () => {
    fs.writeFileSync(path.join(folder, "a.yaml"), "a: 1   \n");
    const result = await fixFolder(
      await resolveRylPath(getSettings()),
      folder,
      undefined,
      AbortSignal.abort(),
    );
    assert.deepStrictEqual(result, { kind: "cancelled" });
  });

  test("a relative config path resolves against the first folder, as the server does", () => {
    assert.strictEqual(resolveConfigPath("", folder), undefined);
    assert.strictEqual(
      resolveConfigPath("cfg/ryl.toml", folder),
      path.join(folder, "cfg", "ryl.toml"),
    );
  });
});
