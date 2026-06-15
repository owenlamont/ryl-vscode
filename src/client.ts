import * as vscode from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  RevealOutputChannelOn,
  type ServerOptions,
  State,
} from "vscode-languageclient/node";
import { resolveRylPath } from "./binary";
import { EXTENSION_ID, SERVER_NAME, SERVER_SUBCOMMAND } from "./constants";
import { getLogChannel, log } from "./logger";
import { buildInitializationOptions, getSettings } from "./settings";

let serverChannel: vscode.OutputChannel | undefined;
let traceChannel: vscode.OutputChannel | undefined;
// Tracked so each (re)start disposes the previous client's state listener
// rather than leaving one attached to every stopped client.
let stateSubscription: vscode.Disposable | undefined;

export function getServerChannel(): vscode.OutputChannel {
  if (!serverChannel) {
    serverChannel = vscode.window.createOutputChannel(SERVER_NAME);
  }
  return serverChannel;
}

function getTraceChannel(): vscode.OutputChannel {
  if (!traceChannel) {
    traceChannel = vscode.window.createOutputChannel(`${SERVER_NAME} Trace`);
  }
  return traceChannel;
}

/** Build, start, and return a connected language client, or undefined if it failed to start. */
export async function startServer(): Promise<LanguageClient | undefined> {
  const settings = getSettings();
  const command = await resolveRylPath(settings);

  const serverOptions: ServerOptions = {
    command,
    args: [SERVER_SUBCOMMAND],
    options: {
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
      env: process.env,
    },
  };

  // The client reads `ryl.trace.server` itself; only attach a trace channel when
  // tracing is on so an empty channel does not clutter the Output dropdown.
  const tracing =
    vscode.workspace.getConfiguration(EXTENSION_ID).get<string>("trace.server", "off") !== "off";

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "yaml" },
      { scheme: "untitled", language: "yaml" },
      // Markdown is forwarded so the server can lint embedded YAML (front matter
      // and fenced ```yaml blocks). The server stays silent unless the resolved
      // ryl config opts in via `[files].markdown`, so this is quiet by default.
      { scheme: "file", language: "markdown" },
      { scheme: "untitled", language: "markdown" },
    ],
    outputChannel: getServerChannel(),
    traceOutputChannel: tracing ? getTraceChannel() : undefined,
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    diagnosticCollectionName: EXTENSION_ID,
    initializationOptions: buildInitializationOptions(settings),
    synchronize: {
      // Re-lint open documents when a discovered config file changes.
      fileEvents: [
        vscode.workspace.createFileSystemWatcher("**/ryl.toml"),
        vscode.workspace.createFileSystemWatcher("**/.ryl.toml"),
        vscode.workspace.createFileSystemWatcher("**/pyproject.toml"),
        vscode.workspace.createFileSystemWatcher("**/.yamllint"),
        vscode.workspace.createFileSystemWatcher("**/.yamllint.{yml,yaml}"),
      ],
    },
  };

  const client = new LanguageClient(EXTENSION_ID, SERVER_NAME, serverOptions, clientOptions);
  stateSubscription?.dispose();
  stateSubscription = client.onDidChangeState((event) => {
    if (event.newState === State.Running) {
      log("ryl server running.");
    } else if (event.newState === State.Stopped) {
      log("ryl server stopped.");
    }
  });

  try {
    log(`Starting ryl server: ${command} ${SERVER_SUBCOMMAND}`);
    await client.start();
  } catch (error) {
    log(`Failed to start ryl server: ${String(error)}`);
    void vscode.window
      .showErrorMessage(`Failed to start the ryl language server (${command}).`, "Show Logs")
      .then((choice) => {
        if (choice) {
          getLogChannel().show();
        }
      });
    return undefined;
  }
  return client;
}

export async function stopServer(client: LanguageClient): Promise<void> {
  stateSubscription?.dispose();
  stateSubscription = undefined;
  try {
    // stop() also disposes the connection, diagnostic collection (clearing
    // squiggles), and synced features; the client is discarded afterwards.
    await client.stop();
  } catch (error) {
    log(`Error stopping ryl server: ${String(error)}`);
  }
}

export function disposeChannels(): void {
  serverChannel?.dispose();
  serverChannel = undefined;
  traceChannel?.dispose();
  traceChannel = undefined;
}
