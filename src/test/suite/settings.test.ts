import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { resolveRylPath } from "../../binary";
import { BUNDLED_RYL_PATH } from "../../constants";
import type { RylSettings } from "../../settings";

// Violates document-start only, which the fixture config leaves off, so a
// document-start diagnostic proves another config was loaded.
const NO_DOCUMENT_START = "key: value\n";
// Violates trailing-spaces, which the fixture config enables.
const TRAILING = "key: value   \n";

const DEFAULTS: RylSettings = {
  enable: true,
  path: "",
  importStrategy: "fromEnvironment",
  configPath: "",
  fixOnSave: false,
};

suite("ryl binary resolution", () => {
  const folder = () => {
    const first = vscode.workspace.workspaceFolders?.[0];
    assert.ok(first, "expected the fixtures directory as the workspace folder");
    return first.uri.fsPath;
  };

  test("useBundled picks the bundled binary", async () => {
    assert.strictEqual(
      await resolveRylPath({ ...DEFAULTS, importStrategy: "useBundled" }),
      BUNDLED_RYL_PATH,
    );
  });

  test("ryl.path wins over useBundled and resolves relative and ~ paths", async () => {
    const absolute = path.join(os.tmpdir(), "custom-ryl");
    assert.strictEqual(
      await resolveRylPath({ ...DEFAULTS, path: absolute, importStrategy: "useBundled" }),
      absolute,
    );
    assert.strictEqual(
      await resolveRylPath({ ...DEFAULTS, path: "tools/ryl" }),
      path.join(folder(), "tools/ryl"),
    );
    assert.strictEqual(
      await resolveRylPath({ ...DEFAULTS, path: "~/bin/ryl" }),
      path.join(os.homedir(), "bin/ryl"),
    );
  });

  test("an untrusted workspace ignores ryl.path for the bundled binary", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(vscode.workspace, "isTrusted");
    assert.ok(descriptor?.configurable, "isTrusted must be stubbable for this test");
    Object.defineProperty(vscode.workspace, "isTrusted", { get: () => false, configurable: true });
    try {
      assert.strictEqual(
        await resolveRylPath({ ...DEFAULTS, path: "/somewhere/ryl" }),
        BUNDLED_RYL_PATH,
      );
    } finally {
      Object.defineProperty(vscode.workspace, "isTrusted", descriptor);
    }
  });

  test("fromEnvironment prefers a new-enough workspace .venv ryl", async function () {
    if (process.platform === "win32") {
      this.skip();
    }
    const venv = path.join(folder(), ".venv");
    // Non-recursive, so an existing .venv fails the test instead of being deleted below.
    fs.mkdirSync(venv);
    const bin = path.join(venv, "bin");
    fs.mkdirSync(bin);
    const venvRyl = path.join(bin, "ryl");
    try {
      fs.writeFileSync(venvRyl, "#!/bin/sh\necho 'ryl 0.25.0'\n", { mode: 0o755 });
      assert.strictEqual(await resolveRylPath(DEFAULTS), venvRyl);
      fs.writeFileSync(venvRyl, "#!/bin/sh\necho 'ryl 0.17.0'\n", { mode: 0o755 });
      assert.notStrictEqual(await resolveRylPath(DEFAULTS), venvRyl, "too old for ryl server");
    } finally {
      fs.rmSync(venv, { recursive: true, force: true });
    }
  });
});

suite("ryl settings and commands end-to-end", () => {
  const created: string[] = [];

  suiteTeardown(async () => {
    const ryl = vscode.workspace.getConfiguration("ryl");
    for (const key of ["enable", "path", "configPath", "trace.server"]) {
      await ryl.update(key, undefined, vscode.ConfigurationTarget.Global);
    }
    for (const file of created) {
      fs.rmSync(file, { recursive: true, force: true });
    }
  });

  async function open(name: string, content: string): Promise<vscode.TextDocument> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "expected the fixtures directory as the workspace folder");
    const file = path.join(folder.uri.fsPath, `${name}.generated.yaml`);
    fs.writeFileSync(file, content);
    created.push(file);
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    return doc;
  }

  async function setRyl(key: string, value: unknown) {
    await vscode.workspace
      .getConfiguration("ryl")
      .update(key, value, vscode.ConfigurationTarget.Global);
  }

  test("ryl.configPath loads the named config", async () => {
    const doc = await open("config-path", NO_DOCUMENT_START);
    const config = path.join(os.tmpdir(), `ryl-config-path-${process.pid}.toml`);
    fs.writeFileSync(config, '[lint.rules]\ndocument-start = "enable"\n');
    created.push(config);
    await setRyl("configPath", config);
    assert.ok(
      await waitForDiagnostics(doc.uri, (d) => d.some((x) => ruleOf(x) === "document-start")),
      "the configPath config should enable document-start",
    );
    await setRyl("configPath", undefined);
    assert.ok(
      await waitForDiagnostics(doc.uri, (d) => !d.some((x) => ruleOf(x) === "document-start")),
      "clearing configPath should return to discovery",
    );
  });

  test("ryl.enable false clears diagnostics and true restores them", async () => {
    const doc = await open("enable", TRAILING);
    assert.ok(await waitForDiagnostics(doc.uri, (d) => d.length > 0), "diagnostics while enabled");
    await setRyl("enable", false);
    // The restart this setting triggers clears diagnostics briefly on its own, so
    // require them to stay gone after a restarted server would have republished.
    assert.ok(
      await waitForDiagnostics(doc.uri, (d) => d.length === 0),
      "no diagnostics once disabled",
    );
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.strictEqual(rylDiagnostics(doc.uri).length, 0, "diagnostics stay gone while disabled");
    await setRyl("enable", true);
    assert.ok(
      await waitForDiagnostics(doc.uri, (d) => d.length > 0),
      "diagnostics once re-enabled",
    );
  });

  test("ryl.path runs the configured executable", async function () {
    if (process.platform === "win32") {
      this.skip();
    }
    const real = BUNDLED_RYL_PATH;
    assert.ok(fs.existsSync(real), "run `npm run download-ryl` first");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ryl-path-"));
    created.push(dir);
    const marker = path.join(dir, "invoked");
    const wrapper = path.join(dir, "ryl-wrapper");
    fs.writeFileSync(wrapper, `#!/bin/sh\necho "$@" >> '${marker}'\nexec '${real}' "$@"\n`, {
      mode: 0o755,
    });
    const doc = await open("path", TRAILING);
    await setRyl("path", wrapper);
    assert.ok(
      await waitForCondition(
        () => fs.existsSync(marker) && fs.readFileSync(marker, "utf8").includes("server"),
      ),
      "the wrapper set in ryl.path should be spawned as the server",
    );
    assert.ok(
      await waitForDiagnostics(doc.uri, (d) => d.length > 0),
      "diagnostics from the wrapper",
    );
    await setRyl("path", undefined);
  });

  test("trace.server, ryl.restart and the log commands keep the server serving", async () => {
    const doc = await open("restart", TRAILING);
    await setRyl("trace.server", "verbose");
    assert.ok(
      await waitForDiagnostics(doc.uri, (d) => d.length > 0),
      "diagnostics with tracing on",
    );
    await vscode.commands.executeCommand("ryl.restart");
    await vscode.commands.executeCommand("ryl.showClientLogs");
    await vscode.commands.executeCommand("ryl.showServerLogs");
    // A shown log channel can become the active text editor, which ryl.fixAll targets.
    await vscode.commands.executeCommand("workbench.action.closePanel");
    await vscode.window.showTextDocument(doc);
    assert.ok(
      await waitForDiagnostics(doc.uri, (d) => d.length > 0),
      "diagnostics after a restart",
    );
  });
});

async function waitForCondition(predicate: () => boolean, timeoutMs = 30000): Promise<boolean> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return true;
}

function rylDiagnostics(uri: vscode.Uri): vscode.Diagnostic[] {
  return vscode.languages.getDiagnostics(uri).filter((d) => d.source === "ryl");
}

function waitForDiagnostics(
  uri: vscode.Uri,
  predicate: (diagnostics: vscode.Diagnostic[]) => boolean,
): Promise<boolean> {
  return waitForCondition(() => predicate(rylDiagnostics(uri)));
}

function ruleOf(diagnostic: vscode.Diagnostic): string | number | undefined {
  const { code } = diagnostic;
  return typeof code === "object" ? code.value : code;
}
