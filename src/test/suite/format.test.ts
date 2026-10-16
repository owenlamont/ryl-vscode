import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

// CRLF content under `line-ending = "cr-lf"` pins that a save keeps the file's bytes
// rather than letting the editor or the server normalise line endings.
const CRLF = "\r\n";
const YAML = `name: "value: stay"${CRLF}`;
const MARKDOWN = `\`\`\`yaml${CRLF}name: "value: stay"${CRLF}\`\`\`${CRLF}`;

suite("ryl format on save", () => {
  const createdDirs: string[] = [];

  async function setFormatOnSave(enabled: boolean) {
    for (const languageId of ["yaml", "markdown"]) {
      const editor = vscode.workspace.getConfiguration("editor", { languageId });
      const target = vscode.ConfigurationTarget.Global;
      await editor.update("defaultFormatter", enabled ? "owenlamont.ryl" : undefined, target, true);
      await editor.update("formatOnSave", enabled ? true : undefined, target, true);
    }
  }

  suiteSetup(() => setFormatOnSave(true));

  suiteTeardown(async () => {
    await setFormatOnSave(false);
    await vscode.workspace
      .getConfiguration("ryl")
      .update("fixOnSave", undefined, vscode.ConfigurationTarget.Global);
    for (const dir of createdDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function openFixture(
    name: string,
    markdown: boolean,
    fixOnSave: boolean,
    conflict = false,
  ) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "expected the fixtures directory as the workspace folder");
    const dir = path.join(folder.uri.fsPath, `${name}.generated.d`);
    fs.mkdirSync(dir, { recursive: true });
    createdDirs.push(dir);
    const config = [
      "[files]",
      'markdown = ["*.md"]',
      "[format]",
      'quote-style = "single"',
      'line-ending = "cr-lf"',
      "[lint.rules]",
      'trailing-spaces = "enable"',
      'document-start = "enable"',
      ...(conflict ? ["[lint.rules.new-lines]", 'type = "unix"'] : []),
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, ".ryl.toml"), config);
    const file = path.join(dir, markdown ? "sample.md" : "sample.yaml");
    fs.writeFileSync(file, markdown ? MARKDOWN : YAML);
    const uri = vscode.Uri.file(file);
    await vscode.workspace
      .getConfiguration("ryl", uri)
      .update("fixOnSave", fixOnSave, vscode.ConfigurationTarget.Global);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    assert.strictEqual(doc.eol, vscode.EndOfLine.CRLF);
    assert.ok((await formatEdits(doc)).length, "ryl should be ready to format the fixture");
    return { doc, editor };
  }

  // The first suite to run can open a document before the server has started, so poll
  // until the formatter answers rather than saving into a no-op format.
  async function formatEdits(doc: vscode.TextDocument): Promise<vscode.TextEdit[]> {
    let edits: vscode.TextEdit[] | undefined;
    for (let attempt = 0; attempt < 50 && !edits?.length; attempt++) {
      edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
        "vscode.executeFormatDocumentProvider",
        doc.uri,
        { tabSize: 2, insertSpaces: true },
      );
      if (!edits?.length) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    return edits ?? [];
  }

  async function saveWithTrailingSpaces(editor: vscode.TextEditor, line: number): Promise<Buffer> {
    const doc = editor.document;
    assert.ok(await editor.edit((edit) => edit.insert(doc.lineAt(line).range.end, "   ")));
    assert.ok(await doc.save(), "the dirty document should save");
    return fs.readFileSync(doc.uri.fsPath);
  }

  test("formatOnSave runs ryl format and keeps CRLF bytes", async () => {
    const { editor } = await openFixture("format-yaml", false, false);
    const bytes = await saveWithTrailingSpaces(editor, 0);
    assert.deepStrictEqual(bytes.toString(), `name: 'value: stay'${CRLF}`);
  });

  test("formatOnSave plus fixOnSave settles after one YAML save", async () => {
    const { editor } = await openFixture("format-fix-yaml", false, true);
    const expected = `---${CRLF}name: 'value: stay'${CRLF}`;
    assert.deepStrictEqual((await saveWithTrailingSpaces(editor, 0)).toString(), expected);
    assert.deepStrictEqual((await saveWithTrailingSpaces(editor, 1)).toString(), expected);
  });

  test("formatOnSave plus fixOnSave settles after one Markdown save", async () => {
    const { editor } = await openFixture("format-fix-markdown", true, true);
    const expected = `\`\`\`yaml${CRLF}name: 'value: stay'${CRLF}\`\`\`${CRLF}`;
    assert.deepStrictEqual((await saveWithTrailingSpaces(editor, 1)).toString(), expected);
    assert.deepStrictEqual((await saveWithTrailingSpaces(editor, 1)).toString(), expected);
  });

  test("conflicting lint and format settings show a warning", async () => {
    const notices: string[] = [];
    const window = vscode.window as { showWarningMessage: typeof vscode.window.showWarningMessage };
    const original = window.showWarningMessage;
    window.showWarningMessage = ((message: string, ...items: string[]) => {
      notices.push(message);
      return original(message, ...items);
    }) as typeof original;
    try {
      await openFixture("format-conflict", false, false, true);
      assert.ok(
        notices.some((message) => message.includes("new-lines")),
        `expected a new-lines conflict warning, got: ${JSON.stringify(notices)}`,
      );
    } finally {
      window.showWarningMessage = original;
    }
  });
});
