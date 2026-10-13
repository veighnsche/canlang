/**
 * `can` language extension entry point.
 *
 * Activates on the `can` language (see `activationEvents` in package.json),
 * spawns `can lsp` over stdio via {@link CanLanguageClient}, forwards
 * open/change/save/close for `.can` documents, and registers providers for
 * every server capability: hover, completion, definition, references,
 * rename, formatting, document symbols, semantic tokens (full), and code actions.
 * The server binary path is the `can.serverPath` setting (default `can` on PATH).
 *
 * Providers are registered once and route to the document's local-folder client.
 * Each folder owns a server/catalog; restarts need no re-registration. Restart paths: the contributed
 * `can.restartServer` command, any `can.serverPath`/`can.traceServer`
 * configuration change, workspace-folder ownership changes, and reopening
 * a `.can` file after a crash
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

const clients = new Map<string, CanLanguageClient>();

function folderFor(document?: vscode.TextDocument): vscode.WorkspaceFolder | undefined {
  const owner = document?.languageId === 'can' ? vscodeApi.workspace.getWorkspaceFolder(document.uri) : undefined;
  if (owner?.uri.scheme === 'file') { return owner; }
  if (document?.languageId === 'can' && document.uri.scheme !== 'untitled') { return undefined; }
  return vscodeApi.workspace.workspaceFolders?.find((item: vscode.WorkspaceFolder) => item.uri.scheme === 'file');
}
function clientKey(document?: vscode.TextDocument): string {
  return folderFor(document)?.uri.toString() ?? '';
}
function clientFor(document: vscode.TextDocument): CanLanguageClient | undefined {
  return clients.get(clientKey(document));
}
let active = false;
let restarting: Promise<void> | null = null;

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
  convert: (result: Json, live: CanLanguageClient) => T,
): Promise<T | undefined> {
  const live = clientFor(document);
  if (!live) {
    return Promise.resolve(undefined);
  }
  return live.requestDocument(document, token, method, params, (result) =>
    clientFor(document) === live ? convert(result, live) : undefined).catch(() => undefined);
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
 * answers renames and code actions with versioned `documentChanges`.
 * Refuse the whole edit when any target cannot be verified.
 */
function toWorkspaceEdit(result: Json, live: CanLanguageClient): vscode.WorkspaceEdit | null {
  if (!isRecord(result)) {
    return null;
  }
  const edit = new vscodeApi.WorkspaceEdit();
  let applied = false;
  const documentChanges = result['documentChanges'];
  if (Array.isArray(documentChanges)) {
    for (const change of documentChanges) {
      if (!isRecord(change)) {
        return null;
      }
      const doc = change['textDocument'];
      const edits = change['edits'];
      if (!isRecord(doc) || typeof doc['uri'] !== 'string' || !Array.isArray(edits)) {
        return null;
      }
      if (typeof doc['version'] !== 'number' || !live.isDocumentVersion(doc['uri'], doc['version'])) {
        return null;
      }
      const converted: vscode.TextEdit[] = [];
      for (const item of edits) {
        const textEdit = toTextEdit(item);
        if (!textEdit) { return null; }
        converted.push(textEdit);
      }
      edit.set(vscodeApi.Uri.parse(doc['uri']), converted);
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
          if (typeof entry['detail'] === 'string') { item.detail = entry['detail']; }
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
    async provideRenameEdits(document, position, newName, token) {
      const live = clientFor(document);
      const sourceVersion = document.version;
      if (!live || token.isCancellationRequested) { return undefined; }
      // References define the affected documents. Load them through the editor
      // before rename so every edit carries an authoritative overlay version.
      const locations = await request(document, token, 'textDocument/references', {
        textDocument: { uri: document.uri.toString() }, position: toPosition(position),
        context: { includeDeclaration: true },
      }, toLocations);
      if (!locations) { return undefined; }
      const uris = new Set(locations.map((location) => location.uri.toString()));
      for (const uri of uris) {
        if (uri === document.uri.toString() || live.isDocumentVersion(uri, null)) { continue; }
        if (!uri.startsWith('file:')) { throw new Error('Can project rename requires local files.'); }
        const target = await vscodeApi.workspace.openTextDocument(vscodeApi.Uri.parse(uri));
        if (clientFor(target) !== live) { throw new Error('Can cannot rename across separate workspace folders.'); }
        if (!live.isDocumentVersion(uri, null)) { live.didOpen(target); }
        if (token.isCancellationRequested || document.version !== sourceVersion || clientFor(document) !== live) {
          return undefined;
        }
      }
      if (token.isCancellationRequested || document.version !== sourceVersion || clientFor(document) !== live) {
        return undefined;
      }
      return request(document, token, 'textDocument/rename', {
        textDocument: { uri: document.uri.toString() }, position: toPosition(position), newName,
      }, (result, owner) => result === null ? null : toWorkspaceEdit(result, owner)).then((edit) => {
        if (edit === null) {
          throw new Error('Can cannot safely rename this symbol. Use a valid, non-colliding name on a supported declaration or reference; all affected files must be current.');
        }
        return edit;
      });
    },
  };
}

function formattingProvider(): vscode.DocumentFormattingEditProvider {
  return {
    provideDocumentFormattingEdits(document, options, token) {
      return request(document, token, 'textDocument/formatting', {
        textDocument: { uri: document.uri.toString() },
        options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
      }, (result) => {
        if (!Array.isArray(result)) { return undefined; }
        const edits: vscode.TextEdit[] = [];
        for (const entry of result) {
          const edit = toTextEdit(entry);
          if (edit) { edits.push(edit); }
        }
        return edits;
      });
    },
  };
}

/** LSP symbol kinds are one-based; use the host's enum identities. */
const symbolKinds: vscode.SymbolKind[] = [
  vscodeApi.SymbolKind.File, vscodeApi.SymbolKind.Module, vscodeApi.SymbolKind.Namespace,
  vscodeApi.SymbolKind.Package, vscodeApi.SymbolKind.Class, vscodeApi.SymbolKind.Method,
  vscodeApi.SymbolKind.Property, vscodeApi.SymbolKind.Field, vscodeApi.SymbolKind.Constructor,
  vscodeApi.SymbolKind.Enum, vscodeApi.SymbolKind.Interface, vscodeApi.SymbolKind.Function,
  vscodeApi.SymbolKind.Variable, vscodeApi.SymbolKind.Constant, vscodeApi.SymbolKind.String,
  vscodeApi.SymbolKind.Number, vscodeApi.SymbolKind.Boolean, vscodeApi.SymbolKind.Array,
  vscodeApi.SymbolKind.Object, vscodeApi.SymbolKind.Key, vscodeApi.SymbolKind.Null,
  vscodeApi.SymbolKind.EnumMember, vscodeApi.SymbolKind.Struct, vscodeApi.SymbolKind.Event,
  vscodeApi.SymbolKind.Operator, vscodeApi.SymbolKind.TypeParameter,
];

function toDocumentSymbol(value: Json): vscode.DocumentSymbol | null {
  if (!isRecord(value) || typeof value['name'] !== 'string') { return null; }
  const range = toRange(value['range']);
  const selection = toRange(value['selectionRange']);
  const kind = value['kind'];
  if (!range || !selection || typeof kind !== 'number' || !Number.isSafeInteger(kind) ||
      kind < 1 || kind > symbolKinds.length) { return null; }
  const symbol = new vscodeApi.DocumentSymbol(value['name'],
    typeof value['detail'] === 'string' ? value['detail'] : '', symbolKinds[kind - 1], range, selection);
  if (Array.isArray(value['children'])) {
    for (const child of value['children']) {
      const converted = toDocumentSymbol(child);
      if (converted) { symbol.children.push(converted); }
    }
  }
  return symbol;
}

function documentSymbolProvider(): vscode.DocumentSymbolProvider {
  return {
    provideDocumentSymbols(document, token) {
      return request(document, token, 'textDocument/documentSymbol', {
        textDocument: { uri: document.uri.toString() },
      }, (result) => {
        if (!Array.isArray(result)) { return undefined; }
        const symbols: vscode.DocumentSymbol[] = [];
        for (const entry of result) {
          const symbol = toDocumentSymbol(entry);
          if (symbol) { symbols.push(symbol); }
        }
        return symbols;
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
      }, (result, live) => {
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
            const edit = toWorkspaceEdit(entry['edit'], live);
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
  active = true;
  const channel = vscodeApi.window.createOutputChannel('Can');

  const startClient = (
    document: vscode.TextDocument | undefined = vscodeApi.window.activeTextEditor?.document,
    requestedFolder?: vscode.WorkspaceFolder,
  ): void => {
    const key = requestedFolder?.uri.toString() ?? clientKey(document);
    if (!active || clients.has(key)) { return; }
    const folder = requestedFolder ?? folderFor(document);
    const config = vscodeApi.workspace.getConfiguration('can', folder?.uri);
    const serverPath = config.get<string>('serverPath', 'can');
    const trace = config.get<boolean>('traceServer', false);
    const catalogFolder = folder ?? vscodeApi.workspace.workspaceFolders?.find(
      (item: vscode.WorkspaceFolder) => item.uri.scheme === 'file');
    const canClient = new CanLanguageClient(serverPath, channel, trace, catalogFolder?.uri.fsPath,
      folder?.uri.toString(),
      (vscodeApi.workspace.workspaceFolders ?? [])
        .filter((item: vscode.WorkspaceFolder) => item.uri.scheme === 'file')
        .map((item: vscode.WorkspaceFolder) => item.uri.toString()));
    clients.set(key, canClient);
    canClient.onExit = (code: number | null) => {
      if (clients.get(key) !== canClient) { return; }
      clients.delete(key);
      vscodeApi.window.showErrorMessage(
        `Can language server exited (code ${code === null ? 'unknown' : code}). ` +
        'Check the Can output channel; reopen a .can file or run `Can: Restart Language Server` to retry.');
    };
    canClient.start().then(() => {
      if (clients.get(key) !== canClient) { return; }
      for (const doc of vscodeApi.workspace.textDocuments) {
        if (doc.languageId === 'can' && clientKey(doc) === key) { canClient.didOpen(doc); }
      }
    }, (reason: unknown) => {
      if (clients.get(key) !== canClient) { return; }
      clients.delete(key);
      vscodeApi.window.showErrorMessage(
        `Could not start the Can language server ('${serverPath} lsp'): ${String(reason)}. ` +
        'Set can.serverPath to your can binary.');
    });
  };
  const restartServer = (): Promise<void> => {
    if (restarting) { return restarting; }
    const stopping = [...clients.values()];
    clients.clear();
    restarting = Promise.all(stopping.map((item) => item.stop())).then(() => {
      startClient();
      for (const doc of vscodeApi.workspace.textDocuments) {
        if (doc.languageId === 'can') { startClient(doc); }
      }
    }).finally(() => { restarting = null; });
    return restarting;
  };
  startClient();
  for (const doc of vscodeApi.workspace.textDocuments) {
    if (doc.languageId === 'can') { startClient(doc); }
  }
  const watcher = vscodeApi.workspace.createFileSystemWatcher('**/*.can');
  const watched = (uri: vscode.Uri, type: number): void => {
    if (uri.scheme !== 'file') { return; }
    const folder = vscodeApi.workspace.getWorkspaceFolder(uri);
    if (folder?.uri.scheme === 'file') { clients.get(folder.uri.toString())?.didChangeWatchedFiles(uri, type); }
  };
  context.subscriptions.push(watcher,
    watcher.onDidCreate((uri: vscode.Uri) => watched(uri, 1)),
    watcher.onDidChange((uri: vscode.Uri) => watched(uri, 2)),
    watcher.onDidDelete((uri: vscode.Uri) => watched(uri, 3)),
    vscodeApi.workspace.onDidChangeWorkspaceFolders((event: vscode.WorkspaceFoldersChangeEvent) => {
      // Remove departed owners and re-route their overlays. Unchanged roots keep
      // their server/catalog and revision owners.
      const current = new Set<string>((vscodeApi.workspace.workspaceFolders ?? [])
        .filter((folder: vscode.WorkspaceFolder) => folder.uri.scheme === 'file')
        .map((folder: vscode.WorkspaceFolder) => folder.uri.toString()));
      for (const [key, live] of [...clients]) {
        const nestedBoundaryChanged = [...event.added, ...event.removed].some((folder) =>
          folder.uri.scheme === 'file' && folder.uri.toString().startsWith(`${key.replace(/\/$/, '')}/`));
        if (key && (!current.has(key) || nestedBoundaryChanged)) {
          clients.delete(key); void live.stop();
          const folder = vscodeApi.workspace.workspaceFolders?.find((item: vscode.WorkspaceFolder) => item.uri.toString() === key);
          if (folder) { startClient(undefined, folder); }
        }
      }
      for (const doc of vscodeApi.workspace.textDocuments) {
        if (doc.languageId !== 'can') { continue; }
        const owner = clientFor(doc);
        for (const live of clients.values()) {
          if (live !== owner && live.isDocumentVersion(doc.uri.toString(), null)) { live.didClose(doc); }
        }
        startClient(doc);
        const currentOwner = clientFor(doc);
        if (currentOwner && !currentOwner.isDocumentVersion(doc.uri.toString(), null)) { currentOwner.didOpen(doc); }
      }
    }));

  const selector: vscode.DocumentSelector = { language: 'can' };
  // Preserve the wire indices, but isolate editor styling from generic theme
  // rules and standard TextMate fallbacks. Those lose Can's lexical distinctions
  // (sections versus keywords, descriptions versus comments, UI versus effects).
  // No superType or fallback scopes are contributed: existing syntax scopes own
  // appearance unless the user explicitly styles a Can semantic classification.
  const canClassification = (name: string): string => `can${name[0].toUpperCase()}${name.slice(1)}`;
  const legend = new vscodeApi.SemanticTokensLegend(
    CAN_SEMANTIC_TOKEN_TYPES.map(canClassification),
    CAN_SEMANTIC_TOKEN_MODIFIERS.map(canClassification),
  );

  context.subscriptions.push(
    vscodeApi.languages.registerHoverProvider(selector, hoverProvider()),
    vscodeApi.languages.registerCompletionItemProvider(selector, completionProvider(), '.'),
    vscodeApi.languages.registerDefinitionProvider(selector, definitionProvider()),
    vscodeApi.languages.registerReferenceProvider(selector, referenceProvider()),
    vscodeApi.languages.registerRenameProvider(selector, renameProvider()),
    vscodeApi.languages.registerDocumentFormattingEditProvider(selector, formattingProvider()),
    vscodeApi.languages.registerDocumentSymbolProvider(selector, documentSymbolProvider()),
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
      const live = clientFor(doc);
      if (live) { live.didOpen(doc); }
      else if (!restarting) { startClient(doc); }
    }),
    vscodeApi.workspace.onDidChangeTextDocument((event: vscode.TextDocumentChangeEvent) => {
      if (event.document.languageId === 'can') { clientFor(event.document)?.didChange(event.document); }
    }),
    vscodeApi.workspace.onDidSaveTextDocument((doc: vscode.TextDocument) => {
      if (doc.languageId === 'can') { clientFor(doc)?.didSave(doc); }
    }),
    vscodeApi.workspace.onDidCloseTextDocument((doc: vscode.TextDocument) => {
      if (doc.languageId === 'can') { clientFor(doc)?.didClose(doc); }
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

export function deactivate(): Promise<void> {
  active = false;
  const stopping = [...clients.values()].map((live) => live.stop());
  clients.clear();
  return Promise.all([...stopping, restarting]).then(() => undefined);
}
