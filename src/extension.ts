import * as vscode from "vscode";
import {
  DidChangeConfigurationNotification,
  type LanguageClient,
} from "vscode-languageclient/node";
import { resolveRylPath } from "./binary";
import { disposeChannels, getServerChannel, startServer, stopServer } from "./client";
import { fixFolder, resolveConfigPath } from "./fixWorkspace";
import { disposeLogger, getLogChannel, initLogger, log } from "./logger";
import { buildInitializationOptions, getSettings } from "./settings";

// Scope fix-all strictly to ryl's own action so a co-installed YAML fixer's
// source.fixAll.<other> can never be applied by ryl.fixAll / fixOnSave.
const RYL_FIX_ALL = vscode.CodeActionKind.SourceFixAll.append("ryl");

// fixOnSave is read at save time, so changing it must not restart the server: a
// save landing mid-restart would skip format-on-save.
const SERVER_SETTINGS = ["enable", "path", "importStrategy", "configPath", "trace.server"];

// The document languages ryl handles: YAML, plus Markdown (embedded YAML). The
// server gates Markdown on config, so fix-all is offered for both and the server
// returns no edit when there is nothing to fix.
function isRylDocument(document: vscode.TextDocument): boolean {
  return document.languageId === "yaml" || document.languageId === "markdown";
}

let client: LanguageClient | undefined;
let restartInProgress = false;
let restartQueued = false;
// Set in deactivate() so a restart in flight (or one queued behind it) cannot
// start a new server after the extension has been torn down.
let disposed = false;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLogger();

  context.subscriptions.push(
    vscode.commands.registerCommand("ryl.restart", () => runServer()),
    vscode.commands.registerCommand("ryl.fixAll", () => fixAllActiveEditor()),
    vscode.commands.registerCommand("ryl.fixAllWorkspace", () => fixAllWorkspace()),
    vscode.commands.registerCommand("ryl.showClientLogs", () => getLogChannel().show()),
    vscode.commands.registerCommand("ryl.showServerLogs", () => getServerChannel().show()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (SERVER_SETTINGS.some((key) => event.affectsConfiguration(`ryl.${key}`))) {
        void runServer();
      } else if (event.affectsConfiguration("ryl.diagnosticMode")) {
        void updateServerSettings();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void runServer()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void runServer()),
    vscode.workspace.onWillSaveTextDocument(handleWillSave),
  );

  await runServer();
}

export async function deactivate(): Promise<void> {
  disposed = true;
  if (client) {
    await stopServer(client);
    client = undefined;
  }
  disposeChannels();
  disposeLogger();
}

/**
 * (Re)start the server, coalescing concurrent requests: a restart asked for
 * while one is in flight collapses into a single trailing restart.
 */
async function runServer(): Promise<void> {
  if (disposed) {
    return;
  }
  if (restartInProgress) {
    restartQueued = true;
    return;
  }
  restartInProgress = true;
  try {
    if (client) {
      await stopServer(client);
      client = undefined;
    }
    if (disposed) {
      return;
    }
    if (!getSettings().enable) {
      log("ryl is disabled via ryl.enable.");
      return;
    }
    const started = await startServer();
    // deactivate() may have run while startServer awaited; do not resurrect it.
    if (disposed) {
      if (started) {
        await stopServer(started);
      }
      return;
    }
    client = started;
  } finally {
    restartInProgress = false;
    if (restartQueued && !disposed) {
      restartQueued = false;
      await runServer();
    }
  }
}

/**
 * Push the current settings to a running server without restarting it. A server
 * mid-(re)start may have read its settings before this change, so restart instead.
 */
async function updateServerSettings(): Promise<void> {
  if (!client || restartInProgress) {
    return runServer();
  }
  try {
    await client.sendNotification(DidChangeConfigurationNotification.type, {
      settings: { ryl: buildInitializationOptions(getSettings()) },
    });
  } catch (error) {
    log(`Failed to send settings to the ryl server: ${String(error)}`);
  }
}

function handleWillSave(event: vscode.TextDocumentWillSaveEvent): void {
  const document = event.document;
  // Skip when no server is running so save is never blocked on a no-op request.
  if (!client || !isRylDocument(document) || !getSettings(document).fixOnSave) {
    return;
  }
  event.waitUntil(computeFixAllEdits(document));
}

async function fixAllActiveEditor(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isRylDocument(editor.document)) {
    return;
  }
  const edits = await computeFixAllEdits(editor.document);
  if (edits.length === 0) {
    return;
  }
  const workspaceEdit = new vscode.WorkspaceEdit();
  workspaceEdit.set(editor.document.uri, edits);
  await vscode.workspace.applyEdit(workspaceEdit);
}

/** Ask VS Code for ryl's `source.fixAll` code action and return its edits for this document. */
async function computeFixAllEdits(document: vscode.TextDocument): Promise<vscode.TextEdit[]> {
  const range = new vscode.Range(
    new vscode.Position(0, 0),
    document.lineAt(document.lineCount - 1).range.end,
  );
  const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
    "vscode.executeCodeActionProvider",
    document.uri,
    range,
    RYL_FIX_ALL.value,
  );
  const fixAll = actions?.find((action) => action.kind && RYL_FIX_ALL.contains(action.kind));
  return fixAll?.edit?.get(document.uri) ?? [];
}

async function fixAllWorkspace(): Promise<void> {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(
    (folder) => folder.uri.scheme === "file",
  );
  if (folders.length === 0) {
    void vscode.window.showErrorMessage("ryl: no workspace folder is open.");
    return;
  }
  // The CLI writes to disk, so unsaved edits would conflict with its changes.
  if (!(await vscode.workspace.saveAll(false))) {
    void vscode.window.showErrorMessage(
      "ryl: could not save every open editor; nothing was fixed.",
    );
    return;
  }
  // Mirror the server: one binary and one config path, from the window-level settings.
  const settings = getSettings();
  const ryl = await resolveRylPath(settings);
  const configPath = resolveConfigPath(settings.configPath, folders[0].uri.fsPath);
  let fixed = 0;
  let remaining = 0;
  const failures: string[] = [];
  const completed = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "ryl: fixing workspace",
      cancellable: true,
    },
    async (progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      for (const folder of folders) {
        progress.report({ message: folder.name });
        const result = await fixFolder(ryl, folder.uri.fsPath, configPath, abort.signal);
        if (result.kind === "cancelled") {
          return false;
        }
        if (result.kind === "failed") {
          log(`ryl check --fix failed in ${folder.uri.fsPath}:\n${result.output}`);
          failures.push(`${folder.name}: ${result.message}`);
        } else {
          fixed += result.fixed;
          remaining += result.remaining;
        }
      }
      return true;
    },
  );
  if (!completed) {
    log("ryl.fixAllWorkspace cancelled.");
    return;
  }
  const summary = `ryl fixed ${fixed} problem${fixed === 1 ? "" : "s"}; ${remaining} remaining.`;
  log(summary);
  if (failures.length === 0) {
    void vscode.window.showInformationMessage(summary);
    return;
  }
  const choice = await vscode.window.showErrorMessage(
    `${summary} Failed in ${failures.join("; ")}`,
    "Show Logs",
  );
  if (choice) {
    getLogChannel().show();
  }
}
