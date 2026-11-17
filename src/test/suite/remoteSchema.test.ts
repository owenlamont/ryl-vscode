import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

const ORIGIN = "https://www.schemastore.org";
const URL = `${ORIGIN}/bower.json`;
const restricted = process.env.RYL_TEST_MODE === "restricted";

suite("remote schema approval", () => {
  let directory: string;
  let allowlist: string;
  let cache: string;

  suiteSetup(async () => {
    assert.equal(
      vscode.workspace.isTrusted,
      !restricted,
      "the host must have the requested trust state",
    );
    const config = process.env.XDG_CONFIG_HOME;
    const cacheDirectory = process.env.RYL_SCHEMA_CACHE_DIR;
    assert.ok(config && cacheDirectory, "run through npm test to isolate user state");
    allowlist = path.join(config, "ryl", "allowed-schema-origins");
    cache = cacheDirectory;
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder);
    directory = fs.mkdtempSync(path.join(folder.uri.fsPath, "schema.generated."));
    fs.writeFileSync(
      path.join(directory, ".ryl.toml"),
      `
[lint.rules.schema]
level = "error"
[[lint.rules.schema.schemas]]
url = "${URL}"
files = ["*.yaml"]
`,
    );
    const extension = vscode.extensions.getExtension("owenlamont.ryl");
    assert.ok(extension);
    await extension.activate();
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function open(name: string): Promise<vscode.TextDocument> {
    const file = path.join(directory, `${name}.yaml`);
    fs.writeFileSync(file, "name: 42\n");
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document);
    return document;
  }

  async function approval(document: vscode.TextDocument): Promise<vscode.CodeAction[]> {
    await waitFor(() => diagnostics(document).some((d) => d.message.includes("approval required")));
    const diagnostic = diagnostics(document).find((d) => d.message.includes("approval required"));
    assert.ok(diagnostic);
    assert.equal(diagnostic.range.start.line, 0);
    assert.equal(diagnostic.severity, vscode.DiagnosticSeverity.Error);
    const actions = await quickFixes(document, diagnostic.range);
    assert.deepEqual(
      actions.map((action) => action.title).sort(),
      [`Allow once ${ORIGIN}`, `Always allow ${ORIGIN}`].sort(),
    );
    return actions;
  }

  async function execute(actions: vscode.CodeAction[], title: string): Promise<void> {
    const action = actions.find((candidate) => candidate.title === `${title} ${ORIGIN}`);
    assert.ok(action?.command);
    assert.equal(action.command.command, "ryl.allowSchemaOrigin");
    await vscode.commands.executeCommand(
      action.command.command,
      ...(action.command.arguments ?? []),
    );
  }

  if (restricted) {
    test("Restricted Mode reports an ungranted origin without approval actions or downloads", async () => {
      const document = await open("restricted");
      await waitFor(() =>
        diagnostics(document).some(
          (d) => d.severity === vscode.DiagnosticSeverity.Error && d.message.includes(ORIGIN),
        ),
      );
      assert.deepEqual(await quickFixes(document, new vscode.Range(0, 0, 0, 8)), []);
      assert.ok(!fs.existsSync(allowlist));
      assert.ok(!fs.existsSync(cache));
    });

    test("Restricted Mode keeps a granted origin offline with no downloads or approval actions", async () => {
      fs.mkdirSync(path.dirname(allowlist), { recursive: true });
      fs.writeFileSync(allowlist, `${ORIGIN}\n`);
      await vscode.commands.executeCommand("ryl.restart");
      const document = await open("restricted-granted");
      await waitFor(() => diagnostics(document).some((d) => d.message.includes("offline cache")));
      assert.ok(diagnostics(document).every((d) => !d.message.includes("approval required")));
      assert.deepEqual(await quickFixes(document, new vscode.Range(0, 0, 0, 8)), []);
      assert.ok(
        !fs.existsSync(cache),
        "even a granted origin must not download in Restricted Mode",
      );
    });
  } else {
    test("Allow once validates the schema for the session without saving approval", async () => {
      const document = await open("once");
      const actions = await approval(document);
      assert.ok(!fs.existsSync(cache), "unapproved schemas must not be downloaded");
      await execute(actions, "Allow once");
      await validation(document);
      assert.ok(diagnostics(document).every((d) => !d.message.includes("approval required")));
      assert.ok(!fs.existsSync(allowlist));
      assert.ok(fs.readdirSync(cache).length > 0);
      const next = await open("same-session");
      await validation(next);
      await vscode.commands.executeCommand("ryl.restart");
      await approval(next);
    });

    test("Always allow persists the origin and survives a server restart", async () => {
      await vscode.commands.executeCommand("ryl.restart");
      const document = await open("always");
      await execute(await approval(document), "Always allow");
      await waitFor(() => fs.existsSync(allowlist));
      assert.equal(fs.readFileSync(allowlist, "utf8"), `${ORIGIN}\n`);
      await validation(document);
      await vscode.commands.executeCommand("ryl.restart");
      const next = await open("persisted");
      await validation(next);
      assert.ok(diagnostics(next).every((d) => !d.message.includes("approval required")));
    });
  }
});

function diagnostics(document: vscode.TextDocument): vscode.Diagnostic[] {
  return vscode.languages
    .getDiagnostics(document.uri)
    .filter((diagnostic) => diagnostic.source === "ryl");
}

async function validation(document: vscode.TextDocument): Promise<void> {
  const message = 'value is not of type "string"';
  await waitFor(() => diagnostics(document).some((diagnostic) => diagnostic.message === message));
  const diagnostic = diagnostics(document).find((entry) => entry.message === message);
  assert.ok(diagnostic);
  const code = typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code;
  assert.equal(code, "schema");
  assert.equal(diagnostic.range.start.line, 0);
  assert.equal(diagnostic.range.start.character, 6);
}

async function quickFixes(
  document: vscode.TextDocument,
  range: vscode.Range,
): Promise<vscode.CodeAction[]> {
  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
    "vscode.executeCodeActionProvider",
    document.uri,
    range,
    vscode.CodeActionKind.QuickFix.value,
  );
  return (actions ?? []).filter((action) => action.command?.command === "ryl.allowSchemaOrigin");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 45000;
  while (!predicate()) {
    assert.ok(
      Date.now() < deadline,
      `timed out waiting for schema diagnostics or approval persistence: ${JSON.stringify(
        vscode.languages.getDiagnostics().map(([uri, entries]) => ({
          uri: uri.toString(),
          messages: entries.filter((entry) => entry.source === "ryl").map((entry) => entry.message),
        })),
      )}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
