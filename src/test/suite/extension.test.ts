import * as assert from "node:assert";
import * as fs from "node:fs";
import * as vscode from "vscode";

// Fixture content is written at runtime (and gitignored) so prek's whitespace
// hooks cannot "fix" the trailing space these tests depend on. Each test uses
// its own file so one test fixing the document cannot affect another.
const SAMPLE = "name: ryl-vscode   \nitems:\n  - alpha\n  - beta\n";

suite("ryl-vscode end-to-end", () => {
  const created: vscode.Uri[] = [];

  suiteTeardown(() => {
    for (const uri of created) {
      fs.rmSync(uri.fsPath, { force: true });
    }
  });

  async function openFreshSample(name: string): Promise<vscode.TextDocument> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "expected the fixtures directory as the workspace folder");
    const uri = vscode.Uri.joinPath(folder.uri, `${name}.generated.yaml`);
    fs.writeFileSync(uri.fsPath, SAMPLE);
    created.push(uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    return doc;
  }

  test("publishes ryl diagnostics for a YAML file", async function () {
    this.timeout(60000);
    const doc = await openFreshSample("diagnostics");
    const diagnostics = await waitForRylDiagnostics(doc.uri);
    assert.ok(diagnostics.length > 0, "expected at least one ryl diagnostic");
    assert.ok(
      diagnostics.every((d) => d.source === "ryl"),
      "every diagnostic should be sourced from ryl",
    );
  });

  test("ryl.fixAll removes the trailing whitespace", async function () {
    this.timeout(60000);
    const doc = await openFreshSample("fixall");
    await waitForRylDiagnostics(doc.uri);
    await vscode.commands.executeCommand("ryl.fixAll");
    await waitFor(() => !firstLineHasTrailingSpace(doc));
    assert.ok(!firstLineHasTrailingSpace(doc), "trailing whitespace on line 1 should be fixed");
  });

  test("registers a document formatter that produces edits", async function () {
    this.timeout(60000);
    const doc = await openFreshSample("format");
    await waitForRylDiagnostics(doc.uri);
    const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      "vscode.executeFormatDocumentProvider",
      doc.uri,
      { tabSize: 2, insertSpaces: true },
    );
    assert.ok(edits && edits.length > 0, "ryl should provide formatting edits");
  });
});

function firstLineHasTrailingSpace(doc: vscode.TextDocument): boolean {
  return /[ \t]$/.test(doc.lineAt(0).text);
}

function waitForRylDiagnostics(uri: vscode.Uri, timeoutMs = 30000): Promise<vscode.Diagnostic[]> {
  const rylDiagnostics = () =>
    vscode.languages.getDiagnostics(uri).filter((d) => d.source === "ryl");
  return new Promise((resolve, reject) => {
    const existing = rylDiagnostics();
    if (existing.length > 0) {
      resolve(existing);
      return;
    }
    const timer = setTimeout(() => {
      sub.dispose();
      reject(new Error("timed out waiting for ryl diagnostics"));
    }, timeoutMs);
    const sub = vscode.languages.onDidChangeDiagnostics(() => {
      const current = rylDiagnostics();
      if (current.length > 0) {
        clearTimeout(timer);
        sub.dispose();
        resolve(current);
      }
    });
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 15000,
  intervalMs = 200,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
