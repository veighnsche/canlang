/**
 * Minimal `can` language extension entry point (slice 2a).
 *
 * Activates on the `can` language (see `activationEvents` in package.json),
 * spawns `can lsp` over stdio via {@link CanLanguageClient}, and forwards
 * open/change/close for `.can` documents. The server binary path is the
 * `can.serverPath` setting (default `can` on PATH).
 *
 * When the server dies the client reports through `onExit` and is dropped;
 * reopening a `.can` file starts a fresh instance (restart-on-reopen).
 * The restart is user-paced (one spawn per manual reopen), so a
 * persistently crashing server cannot respawn-loop on its own.
 *
 * The global `vscode` namespace is ambiently declared in `./client` (zero
 * npm dependencies); slice 2b replaces it with real imports.
 */

import { CanLanguageClient } from './client';

const vscodeApi = require('vscode');

let client: CanLanguageClient | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const config = vscodeApi.workspace.getConfiguration('can');
  const serverPath = config.get<string>('serverPath', 'can');
  const trace = config.get<boolean>('traceServer', false);
  const channel = vscodeApi.window.createOutputChannel('Can');

  const startClient = (): void => {
    const canClient = new CanLanguageClient(serverPath, channel, trace);
    client = canClient;

    canClient.onExit = (code: number | null) => {
      if (client === canClient) {
        client = null;
      }
      vscodeApi.window.showErrorMessage(
        `Can language server exited (code ${code === null ? 'unknown' : code}). ` +
          'Check the Can output channel; reopen a .can file to retry.',
      );
    };

    canClient.start().then(
      () => {
        // The instance may have been replaced (or dropped) while the
        // handshake was in flight; only announce to the live one.
        if (client !== canClient) {
          return;
        }
        for (const doc of vscodeApi.workspace.textDocuments) {
          if (doc.languageId === 'can') {
            canClient.didOpen(doc);
          }
        }
      },
      (reason: unknown) => {
        if (client === canClient) {
          client = null;
        }
        vscodeApi.window.showErrorMessage(
          `Could not start the Can language server ('${serverPath} lsp'): ${String(reason)}. ` +
            'Set can.serverPath to your can binary.',
        );
      },
    );
  };

  startClient();

  context.subscriptions.push(
    vscodeApi.workspace.onDidOpenTextDocument((doc: vscode.TextDocument) => {
      if (doc.languageId !== 'can') {
        return;
      }
      if (client) {
        client.didOpen(doc);
      } else {
        // Restart-on-reopen: the previous server died (or never started).
        // Starting now re-announces every open document once the handshake
        // completes, so no explicit didOpen is needed here.
        startClient();
      }
    }),
    vscodeApi.workspace.onDidChangeTextDocument((event: vscode.TextDocumentChangeEvent) => {
      if (event.document.languageId === 'can' && client) {
        client.didChange(event.document);
      }
    }),
    vscodeApi.workspace.onDidCloseTextDocument((doc: vscode.TextDocument) => {
      if (doc.languageId === 'can' && client) {
        client.didClose(doc);
      }
    }),
    channel,
  );
}

export function deactivate(): void {
  const stopping = client ? client.stop() : null;
  client = null;
  void stopping;
}
