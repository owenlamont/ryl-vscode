import * as vscode from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";
import { disposeChannels, getServerChannel, startServer, stopServer } from "./client";
import { disposeLogger, getLogChannel, initLogger, log } from "./logger";
import { getSettings } from "./settings";

// Scope fix-all strictly to ryl's own action so a co-installed YAML fixer's
// source.fixAll.<other> can never be applied by ryl.fixAll / fixOnSave.
const RYL_FIX_ALL = vscode.CodeActionKind.SourceFixAll.append("ryl");

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
    vscode.commands.registerCommand("ryl.showClientLogs", () => getLogChannel().show()),
    vscode.commands.registerCommand("ryl.showServerLogs", () => getServerChannel().show()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("ryl")) {
        void runServer();
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
