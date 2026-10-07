/**
 * `can` language extension entry point.
 *
 * Activates on the `can` language (see `activationEvents` in package.json),
 * spawns `can lsp` over stdio via {@link CanLanguageClient}, forwards
 * open/change/save/close for `.can` documents, and registers providers for
 * every server capability: hover, completion, definition, references,
 * rename, semantic tokens (full), and code actions. The server binary path
 * is the `can.serverPath` setting (default `can` on PATH).
 *
 * Providers are registered once and always talk to the live client, so a
 * server restart needs no re-registration. Restart paths: the contributed
 * `can.restartServer` command, any `can.serverPath`/`can.traceServer`
 * configuration change, and reopening a `.can` file after a crash
 * (restart-on-reopen). Restarts are user-paced, so a persistently crashing
 * server cannot respawn-loop on its own.
 *
 * The global `vscode` namespace is ambiently declared in `./client`
 * (zero npm dependencies; see the note there).
 */

import {
  CAN_SEMANTIC_TOKEN_MODIFIERS,
  CAN_SEMANTIC_TOKEN_TYPES,
  CanLanguageClient,
  isRecord,
} from './client';
import type { Json } from './client';

const vscodeApi = require('vscode');

let client: CanLanguageClient | null = null;

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** True for a wire `Position` the `vscode` constructors accept. */
function isLspPosition(value: unknown): value is LspPosition {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as { line?: unknown; character?: unknown };
  return (
    Number.isSafeInteger(record.line) &&
    (record.line as number) >= 0 &&
    Number.isSafeInteger(record.character) &&
    (record.character as number) >= 0
  );
}

function isLspRange(value: unknown): value is LspRange {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as { start?: unknown; end?: unknown };
  return isLspPosition(record.start) && isLspPosition(record.end);
}

/** Convert a wire range, or null when malformed (caller drops the item). */
function toRange(value: unknown): vscode.Range | null {
  if (!isLspRange(value)) {
    return null;
  }
  return new vscodeApi.Range(
    new vscodeApi.Position(value.start.line, value.start.character),
    new vscodeApi.Position(value.end.line, value.end.character),
  );
}

function toPosition(position: vscode.Position): Json {
  return { line: position.line, character: position.character };
}

/**
 * Send a data request to the live client, or resolve undefined when there
 * is none (server dead or starting) or the request fails. Providers use
 * this so a missing server degrades to "no result" instead of an error.
 */
function request<T>(
  document: vscode.TextDocument,
  token: vscode.CancellationToken,
  method: string,
  params: Json,
  convert: (result: Json) => T,
): Promise<T | undefined> {
  const live = client;
  if (!live) {
    return Promise.resolve(undefined);
  }
  return live.requestDocument(document, token, method, params, (result) =>
    client === live ? convert(result) : undefined).catch(() => undefined);
}

/** Convert one wire `{ range, newText }` edit, or null when malformed. */
function toTextEdit(value: Json): vscode.TextEdit | null {
  if (!isRecord(value)) {
    return null;
  }
  const range = toRange(value['range'] as unknown);
  const newText = value['newText'];
  if (!range || typeof newText !== 'string') {
    return null;
  }
  return new vscodeApi.TextEdit(range, newText);
}

/**
 * Fold a wire `WorkspaceEdit` into a `vscode.WorkspaceEdit`. The server
 * answers renames and code actions with `documentChanges`; the legacy
 * `changes` map is accepted too (ignored when both are absent).
 */
function toWorkspaceEdit(result: Json): vscode.WorkspaceEdit | null {
  if (!isRecord(result)) {
    return null;
  }
  const edit = new vscodeApi.WorkspaceEdit();
  let applied = false;
  const documentChanges = result['documentChanges'];
  if (Array.isArray(documentChanges)) {
    for (const change of documentChanges) {
      if (!isRecord(change)) {
        continue;
      }
      const doc = change['textDocument'];
      const edits = change['edits'];
      if (!isRecord(doc) || typeof doc['uri'] !== 'string' || !Array.isArray(edits)) {
        continue;
      }
      if (!client?.isDocumentVersion(doc['uri'], doc['version'])) {
        return null;
      }
      const converted: vscode.TextEdit[] = [];
      for (const item of edits) {
        const textEdit = toTextEdit(item);
        if (textEdit) {
          converted.push(textEdit);
        }
      }
      edit.set(vscodeApi.Uri.parse(doc['uri']), converted);
      applied = true;
    }
  }
  const changes = result['changes'];
  if (isRecord(changes)) {
    for (const uri of Object.keys(changes)) {
      if (!client?.isDocumentVersion(uri, null)) {
        return null;
      }
      const edits = changes[uri];
      if (!Array.isArray(edits)) {
        continue;
      }
      const converted: vscode.TextEdit[] = [];
      for (const item of edits) {
        const textEdit = toTextEdit(item);
        if (textEdit) {
          converted.push(textEdit);
        }
      }
      edit.set(vscodeApi.Uri.parse(uri), converted);
      applied = true;
    }
  }
  return applied ? edit : null;
}

function hoverProvider(): vscode.HoverProvider {
  return {
    provideHover(document, position, token) {
      return request(document, token, 'textDocument/hover', {
        textDocument: { uri: document.uri.toString() },
        position: toPosition(position),
      }, (result) => {
        if (result === undefined || !isRecord(result)) {
          return undefined;
        }
        const contents = result['contents'];
        if (typeof contents === 'string') {
          return new vscodeApi.Hover(new vscodeApi.MarkdownString(contents));
        }
        if (isRecord(contents) && typeof contents['value'] === 'string') {
          return new vscodeApi.Hover(new vscodeApi.MarkdownString(contents['value']));
        }
        return undefined;
      });
    },
  };
}

/** LSP kind order translated to host enum identities, never numeric aliases. */
const completionKinds: vscode.CompletionItemKind[] = [
  vscodeApi.CompletionItemKind.Text,
  vscodeApi.CompletionItemKind.Method,
  vscodeApi.CompletionItemKind.Function,
  vscodeApi.CompletionItemKind.Constructor,
  vscodeApi.CompletionItemKind.Field,
  vscodeApi.CompletionItemKind.Variable,
  vscodeApi.CompletionItemKind.Class,
  vscodeApi.CompletionItemKind.Interface,
  vscodeApi.CompletionItemKind.Module,
  vscodeApi.CompletionItemKind.Property,
  vscodeApi.CompletionItemKind.Unit,
  vscodeApi.CompletionItemKind.Value,
  vscodeApi.CompletionItemKind.Enum,
  vscodeApi.CompletionItemKind.Keyword,
  vscodeApi.CompletionItemKind.Snippet,
  vscodeApi.CompletionItemKind.Color,
  vscodeApi.CompletionItemKind.File,
  vscodeApi.CompletionItemKind.Reference,
  vscodeApi.CompletionItemKind.Folder,
  vscodeApi.CompletionItemKind.EnumMember,
  vscodeApi.CompletionItemKind.Constant,
  vscodeApi.CompletionItemKind.Struct,
  vscodeApi.CompletionItemKind.Event,
  vscodeApi.CompletionItemKind.Operator,
  vscodeApi.CompletionItemKind.TypeParameter,
];

function completionProvider(): vscode.CompletionItemProvider {
  return {
    provideCompletionItems(document, position, token) {
      return request(document, token, 'textDocument/completion', {
        textDocument: { uri: document.uri.toString() },
        position: toPosition(position),
      }, (result) => {
        if (result === undefined || !Array.isArray(result)) {
          return undefined;
        }
        const items: vscode.CompletionItem[] = [];
        for (const entry of result) {
          if (!isRecord(entry) || typeof entry['label'] !== 'string') {
            continue;
          }
          const item = new vscodeApi.CompletionItem(entry['label']);
          const kind = entry['kind'];
          if (typeof kind === 'number' && Number.isSafeInteger(kind)) {
            item.kind = completionKinds[kind - 1];
          }
          items.push(item);
        }
        return items;
      });
    },
  };
}

/** Convert a wire `{ uri, range }` location, or null when malformed. */
function toLocation(value: Json): vscode.Location | null {
  if (!isRecord(value)) {
    return null;
  }
  const uri = value['uri'];
  const range = toRange(value['range'] as unknown);
  if (typeof uri !== 'string' || !range) {
    return null;
  }
  return new vscodeApi.Location(vscodeApi.Uri.parse(uri), range);
}

function toLocations(result: Json | undefined): vscode.Location[] | undefined {
  if (result === undefined || !Array.isArray(result)) {
    return undefined;
  }
  const locations: vscode.Location[] = [];
  for (const entry of result) {
    const location = toLocation(entry);
    if (location) {
      locations.push(location);
    }
  }
  return locations;
}

function definitionProvider(): vscode.DefinitionProvider {
  return {
    provideDefinition(document, position, token) {
      return request(document, token, 'textDocument/definition', {
        textDocument: { uri: document.uri.toString() },
        position: toPosition(position),
      }, toLocations);
    },
  };
}

function referenceProvider(): vscode.ReferenceProvider {
  return {
    provideReferences(document, position, context, token) {
      return request(document, token, 'textDocument/references', {
        textDocument: { uri: document.uri.toString() },
        position: toPosition(position),
        context: { includeDeclaration: context.includeDeclaration },
      }, toLocations);
    },
  };
}

function renameProvider(): vscode.RenameProvider {
  return {
    provideRenameEdits(document, position, newName, token) {
      return request(document, token, 'textDocument/rename', {
        textDocument: { uri: document.uri.toString() },
        position: toPosition(position),
        newName,
      }, (result) => {
        if (result === undefined) {
          return undefined;
        }
        return toWorkspaceEdit(result) ?? undefined;
      });
    },
  };
}

function semanticTokensProvider(): vscode.DocumentSemanticTokensProvider {
  return {
    provideDocumentSemanticTokens(document, token) {
      return request(document, token, 'textDocument/semanticTokens/full', {
        textDocument: { uri: document.uri.toString() },
      }, (result) => {
        if (result === undefined || !isRecord(result)) {
          return undefined;
        }
        const data = result['data'];
        if (!Array.isArray(data)) {
          return undefined;
        }
        const numbers: number[] = [];
        for (const entry of data) {
          if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0) {
            return undefined;
          }
          numbers.push(entry);
        }
        // Server data is already LSP delta-encoded quintuples.
        return new vscodeApi.SemanticTokens(new Uint32Array(numbers));
      });
    },
  };
}

function codeActionProvider(): vscode.CodeActionProvider {
  return {
    provideCodeActions(document, range, _context, token) {
      return request(document, token, 'textDocument/codeAction', {
        textDocument: { uri: document.uri.toString() },
        range: {
          start: toPosition(range.start),
          end: toPosition(range.end),
        },
        context: { diagnostics: [] },
      }, (result) => {
        if (result === undefined || !Array.isArray(result)) {
          return undefined;
        }
        const actions: vscode.CodeAction[] = [];
        for (const entry of result) {
          if (!isRecord(entry) || typeof entry['title'] !== 'string') {
            continue;
          }
          const action = new vscodeApi.CodeAction(
            entry['title'],
            entry['kind'] === 'quickfix' ? vscodeApi.CodeActionKind.QuickFix : undefined,
          );
          // Server code-action edits nest under `edit.documentChanges`.
          if (isRecord(entry['edit'])) {
            const edit = toWorkspaceEdit(entry['edit']);
            if (!edit) {
              continue;
            }
            action.edit = edit;
          }
          actions.push(action);
        }
        return actions;
      });
    },
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscodeApi.window.createOutputChannel('Can');

  const startClient = (
    document: vscode.TextDocument | undefined = vscodeApi.window.activeTextEditor?.document,
  ): void => {
    const config = vscodeApi.workspace.getConfiguration('can');
    const serverPath = config.get<string>('serverPath', 'can');
    const trace = config.get<boolean>('traceServer', false);
    // Catalog discovery is relative to the server's cwd. Prefer the
    // current Can document's owning folder in a multi-folder workspace.
    const owningFolder = document?.languageId === 'can'
      ? vscodeApi.workspace.getWorkspaceFolder(document.uri)
      : undefined;
    const folder = owningFolder?.uri.scheme === 'file'
      ? owningFolder
      : vscodeApi.workspace.workspaceFolders?.find((item: vscode.WorkspaceFolder) =>
        item.uri.scheme === 'file');
    const canClient = new CanLanguageClient(serverPath, channel, trace, folder?.uri.fsPath);
    client = canClient;

    canClient.onExit = (code: number | null) => {
      if (client === canClient) {
        client = null;
      }
      vscodeApi.window.showErrorMessage(
        `Can language server exited (code ${code === null ? 'unknown' : code}). ` +
          'Check the Can output channel; reopen a .can file or run `Can: Restart Language Server` to retry.',
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

  const restartServer = (): Promise<void> => {
    const stopping = client;
    client = null;
    const stopped = stopping ? stopping.stop() : Promise.resolve();
    return stopped.then(() => {
      startClient();
    });
  };

  startClient();

  const selector: vscode.DocumentSelector = { language: 'can' };
  const legend = new vscodeApi.SemanticTokensLegend(
    [...CAN_SEMANTIC_TOKEN_TYPES],
    [...CAN_SEMANTIC_TOKEN_MODIFIERS],
  );

  context.subscriptions.push(
    vscodeApi.languages.registerHoverProvider(selector, hoverProvider()),
    vscodeApi.languages.registerCompletionItemProvider(selector, completionProvider()),
    vscodeApi.languages.registerDefinitionProvider(selector, definitionProvider()),
    vscodeApi.languages.registerReferenceProvider(selector, referenceProvider()),
    vscodeApi.languages.registerRenameProvider(selector, renameProvider()),
    vscodeApi.languages.registerDocumentSemanticTokensProvider(
      selector,
      semanticTokensProvider(),
      legend,
    ),
    vscodeApi.languages.registerCodeActionsProvider(selector, codeActionProvider(), {
      providedCodeActionKinds: [vscodeApi.CodeActionKind.QuickFix],
    }),
    vscodeApi.commands.registerCommand('can.restartServer', () => {
      void restartServer();
    }),
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
        startClient(doc);
      }
    }),
    vscodeApi.workspace.onDidChangeTextDocument((event: vscode.TextDocumentChangeEvent) => {
      if (event.document.languageId === 'can' && client) {
        client.didChange(event.document);
      }
    }),
    vscodeApi.workspace.onDidSaveTextDocument((doc: vscode.TextDocument) => {
      if (doc.languageId === 'can' && client) {
        client.didSave(doc);
      }
    }),
    vscodeApi.workspace.onDidCloseTextDocument((doc: vscode.TextDocument) => {
      if (doc.languageId === 'can' && client) {
        client.didClose(doc);
      }
    }),
    vscodeApi.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent) => {
      if (
        event.affectsConfiguration('can.serverPath') ||
        event.affectsConfiguration('can.traceServer')
      ) {
        void restartServer();
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
