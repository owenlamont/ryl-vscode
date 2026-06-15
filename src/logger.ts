import * as vscode from "vscode";

// Single extension-level log channel ("ryl"). The language client's own
// server/trace channels are owned separately by client.ts.
let channel: vscode.LogOutputChannel | undefined;

export function getLogChannel(): vscode.LogOutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("ryl", { log: true });
  }
  return channel;
}

export function initLogger(): void {
  getLogChannel();
}

export function log(message: string): void {
  getLogChannel().info(message);
}

export function disposeLogger(): void {
  channel?.dispose();
  channel = undefined;
}
