// A scripted, paced feature tour of the ryl extension, driven through a real
// VS Code instance for screen recording (see scripts/record_demo.py). This is
// NOT part of the assertion suite (npm test runs only src/test/suite); it just
// performs visible actions with deliberate pauses so a recorder can capture the
// live diagnostics and fix-all behaviours.
//
// The recorder runs this once per scenario (RYL_DEMO_SCENARIO = "yaml" |
// "markdown"), capturing each to its own clip, so each story is told separately.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const YAML_CONTENT = [
  "#demo config",
  "name: ryl-vscode   ",
  "version: '1.0'",
  'greeting: "hello: world"',
  "env: {  debug: true  }",
  "ports: [  8080,9090  ]",
  "",
  "",
  "items:",
  "  - alpha",
  "  - beta",
].join("\n");

const MD_SCAFFOLD = [
  "# Service notes",
  "",
  "Config lives in a fenced block:",
  "",
  "```yaml",
  "", // the YAML is typed onto this empty line, pushing the closing fence down
  "```",
  "",
].join("\n");
const MD_FENCE_LINE = 5; // 0-based index of the empty line inside the fence
const MD_YAML = [
  "#config",
  "name: ryl-vscode   ",
  "version: '1.0'",
  'greeting: "hello: world"',
  "env: {  debug: true  }",
  "ports: [  8080,9090  ]",
].join("\n");

async function typeText(text: string, perChar = 30): Promise<void> {
  for (const ch of text) {
    await vscode.commands.executeCommand("type", { text: ch });
    // VS Code re-indents the new line on Enter even with autoIndent "none"
    // (it nests `- beta` past `- alpha`), so strip any auto-inserted leading
    // whitespace and let the next characters type each line verbatim.
    if (ch === "\n") {
      const editor = vscode.window.activeTextEditor;
      const pos = editor?.selection.active;
      if (editor && pos && pos.character > 0) {
        await editor.edit((b) => b.delete(new vscode.Range(pos.line, 0, pos.line, pos.character)));
      }
    }
    await sleep(perChar);
  }
}

// Tidy the UI, then signal the recorder that the workbench is ready so it starts
// ffmpeg only now (capture opens on a clean editor, no startup chrome).
async function tidyAndSignalReady(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
  await vscode.commands.executeCommand("notifications.clearAll");
  await vscode.commands.executeCommand("workbench.action.zoomIn");
  await vscode.commands.executeCommand("workbench.action.zoomIn");
  fs.writeFileSync(process.env.RYL_DEMO_READY ?? path.join(os.tmpdir(), "ryl-demo-ready"), "ok");
  await sleep(2500);
}

// Show the diagnostics in the Problems panel, then run "ryl: Fix all auto-fixable
// problems" from the Command Palette so the invocation is visible. A `>`-prefixed
// quickOpen query opens command mode pre-filtered to the ryl command; accepting
// runs the highlighted entry (same path as the `ryl.fixAll` command).
async function showProblemsThenFixAll(): Promise<void> {
  await vscode.commands.executeCommand("workbench.actions.view.problems");
  await sleep(3200);
  await vscode.commands.executeCommand("workbench.action.closePanel");
  await sleep(1000);
  await vscode.commands.executeCommand("workbench.action.quickOpen", "> ryl: Fix all auto-fixable");
  await sleep(2600);
  await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
  await sleep(3500);
}

async function showFormatDocument(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.quickOpen", "> Format Document");
  await sleep(2600);
  await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
  await sleep(3500);
}

async function runYamlScenario(folder: vscode.WorkspaceFolder): Promise<void> {
  const uri = vscode.Uri.joinPath(folder.uri, "demo.generated.yaml");
  fs.writeFileSync(uri.fsPath, "");
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  await tidyAndSignalReady();
  await typeText(YAML_CONTENT);
  await sleep(2500);
  await showProblemsThenFixAll();
  await showFormatDocument();
  fs.rmSync(uri.fsPath, { force: true });
}

async function runMarkdownScenario(folder: vscode.WorkspaceFolder): Promise<void> {
  const uri = vscode.Uri.joinPath(folder.uri, "notes.generated.md");
  fs.writeFileSync(uri.fsPath, MD_SCAFFOLD);
  const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  await tidyAndSignalReady();
  // Type into the empty line inside the fence; each newline pushes the closing
  // fence down, so the typed YAML ends up as the block's content.
  editor.selection = new vscode.Selection(MD_FENCE_LINE, 0, MD_FENCE_LINE, 0);
  await sleep(800);
  await typeText(MD_YAML);
  await sleep(2500);
  await showProblemsThenFixAll();
  await showFormatDocument();
  fs.rmSync(uri.fsPath, { force: true });
}

suite("ryl demo montage", () => {
  test("feature tour", async function () {
    this.timeout(300000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error("expected the demo workspace folder");
    }
    if ((process.env.RYL_DEMO_SCENARIO ?? "yaml") === "markdown") {
      await runMarkdownScenario(folder);
    } else {
      await runYamlScenario(folder);
    }
  });
});
