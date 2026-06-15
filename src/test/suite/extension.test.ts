import * as assert from "node:assert";
import * as fs from "node:fs";
import * as vscode from "vscode";

// Fixture content is written at runtime (and gitignored) so prek's whitespace
// hooks cannot "fix" the trailing space these tests depend on. Each test uses
// its own file so one test fixing the document cannot affect another.
const SAMPLE = "name: ryl-vscode   \nitems:\n  - alpha\n  - beta\n";
// An anchor and the alias that references it, for the rename test.
const ANCHOR_SAMPLE = "default: &settings\n  key: value\nprod: *settings\n";

suite("ryl-vscode end-to-end", () => {
  const created: vscode.Uri[] = [];

  suiteTeardown(() => {
    for (const uri of created) {
      fs.rmSync(uri.fsPath, { force: true });
    }
  });

  async function openFreshSample(name: string, content = SAMPLE): Promise<vscode.TextDocument> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "expected the fixtures directory as the workspace folder");
    const uri = vscode.Uri.joinPath(folder.uri, `${name}.generated.yaml`);
    fs.writeFileSync(uri.fsPath, content);
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

  test("hover over a diagnostic shows the rule and docs link", async function () {
    this.timeout(60000);
    const doc = await openFreshSample("hover");
    const diagnostics = await waitForRylDiagnostics(doc.uri);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      doc.uri,
      diagnostics[0].range.start,
    );
    const text = hoverText(hovers);
    assert.match(text, /ryl: trailing-spaces/, "hover should name the ryl rule");
    assert.match(text, /ryl-docs\.pages\.dev/, "hover should link to the rule docs");
  });

  test("offers disable-rule quick fixes on a diagnostic", async function () {
    this.timeout(60000);
    const doc = await openFreshSample("quickfix");
    const diagnostics = await waitForRylDiagnostics(doc.uri);
    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      doc.uri,
      diagnostics[0].range,
      vscode.CodeActionKind.QuickFix.value,
    );
    const titles = (actions ?? []).map((action) => action.title);
    assert.ok(
      titles.includes("Disable trailing-spaces for this line"),
      `expected a disable-line quick fix, got: ${titles.join(", ")}`,
    );
    assert.ok(
      titles.includes("Disable ryl for this file"),
      `expected a disable-file quick fix, got: ${titles.join(", ")}`,
    );
  });

  test("renames a YAML anchor and its alias together", async function () {
    this.timeout(60000);
    const doc = await openFreshSample("rename", ANCHOR_SAMPLE);
    // Position within "settings" of "&settings" on line 0.
    const edit = await waitForRename(doc.uri, new vscode.Position(0, 12), "renamed");
    const edits = edit?.get(doc.uri) ?? [];
    assert.strictEqual(edits.length, 2, "rename should touch the anchor and its alias");
    assert.ok(
      edits.every((textEdit) => textEdit.newText.includes("renamed")),
      "both edits should apply the new anchor name",
    );
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

function hoverText(hovers: vscode.Hover[] | undefined): string {
  return (hovers ?? [])
    .flatMap((hover) => hover.contents)
    .map((content) => (typeof content === "string" ? content : content.value))
    .join("\n");
}

// The server may not have synced the document on the first rename request, so
// poll until it returns edits (or time out).
async function waitForRename(
  uri: vscode.Uri,
  position: vscode.Position,
  newName: string,
  timeoutMs = 30000,
): Promise<vscode.WorkspaceEdit | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
      "vscode.executeDocumentRenameProvider",
      uri,
      position,
      newName,
    );
    if (edit && edit.get(uri).length > 0) {
      return edit;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return undefined;
}
