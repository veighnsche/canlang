/** Compile the extension first, then run with node test/server-startup.cjs. */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const local = (fsPath) => ({ uri: { scheme: 'file', fsPath, toString: () => `file://${fsPath}` } });
const remote = { uri: { scheme: 'vscode-remote', fsPath: '/remote' } };
const first = local('/workspace/first');
const second = local('/workspace/second');
const canDocument = { languageId: 'can', uri: { scheme: 'file', fsPath: '/workspace/second/a.can' } };
const serverPath = '/compiler path/can';
const disposable = { dispose() {} };

function startup({ folders, document, owner, documents = [], folderForUri, trusted = true }, transformExtension = (source) => source) {
  const launches = [];
  const children = [];
  const handlers = {};
  const providers = {};
  const diagnosticUpdates = [];
  const diagnosticDeletes = [];
  const logs = [];
  const channel = { ...disposable, appendLine(line) { logs.push(line); }, show() {} };
  const status = { ...disposable, text: '', show() { this.visible = true; }, hide() { this.visible = false; } };
  const vscode = {
    workspace: {
      isTrusted: trusted, onDidGrantWorkspaceTrust: callback => { handlers.Trust = callback; return disposable; },
      textDocuments: documents,
      workspaceFolders: folders,
      getWorkspaceFolder: (uri) => folderForUri ? folderForUri(uri) : owner,
      createFileSystemWatcher: () => ({ ...disposable, ...Object.fromEntries(['Create', 'Change', 'Delete'].map((name) => [`onDid${name}`, (callback) => { handlers[`File${name}`] = callback; return disposable; }])) }),
      onDidChangeWorkspaceFolders: (callback) => { handlers.Folders = callback; return disposable; },
      getConfiguration: () => ({ get: (key, fallback) => key === 'serverPath' ? serverPath : fallback }),
      ...Object.fromEntries(['Open', 'Change', 'Save', 'Close'].map((event) => [
        `onDid${event}TextDocument`, (callback) => { handlers[event] = callback; return disposable; },
      ])),
      onDidChangeConfiguration: (callback) => { handlers.Configuration = callback; return disposable; },
    },
    window: {
      createStatusBarItem: () => status, onDidChangeActiveTextEditor: callback => { handlers.ActiveEditor = callback; return disposable; },
      showQuickPick: async () => undefined,
      activeTextEditor: document ? { document } : undefined,
      createOutputChannel: () => channel,
      showErrorMessage() {},
    },
    languages: {
      createDiagnosticCollection: () => ({
        ...disposable,
        set(uri, diagnostics) { diagnosticUpdates.push({ uri, diagnostics }); },
        delete(uri) { diagnosticDeletes.push(uri.toString()); },
      }),
      ...Object.fromEntries([
        'registerHoverProvider', 'registerCompletionItemProvider', 'registerDefinitionProvider',
        'registerReferenceProvider', 'registerRenameProvider',
        'registerDocumentSemanticTokensProvider', 'registerCodeActionsProvider',
        'registerDocumentFormattingEditProvider', 'registerDocumentSymbolProvider',
        'registerFoldingRangeProvider', 'registerSelectionRangeProvider',
      ].map((name) => [name, (selector, provider, metadata) => {
        providers[name] = { selector, provider, metadata };
        return disposable;
      }])),
    },
    commands: { registerCommand: () => disposable },
    StatusBarAlignment: { Right: 2 },
    SemanticTokensLegend: class {},
    CodeActionKind: { QuickFix: 'quickfix' },
    SymbolKind: {}, CompletionItemKind: {},
    Uri: { parse: (value) => ({ scheme: value.split(':')[0], fsPath: value.startsWith('file:') ? decodeURIComponent(new URL(value).pathname) : '', toString: () => value }) },
    Position: class { constructor(line, character) { this.line = line; this.character = character; } },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  };
  const childProcess = {
    spawn(command, args, options) {
      launches.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdout.setEncoding = child.stderr.setEncoding = () => {};
      child.stdin = new EventEmitter();
      child.messages = [];
      child.stdin.write = (frame) => {
        child.messages.push(JSON.parse(frame.split('\r\n\r\n')[1]));
      };
      children.push(child);
      return child;
    },
  };
  let client;
  const load = (name) => {
    const exports = {};
    const requireMock = (id) => {
      if (id === 'vscode') return vscode;
      if (id === 'child_process') return childProcess;
      if (id === 'buffer') return require('node:buffer');
      if (id === './client') return client;
      throw new Error(`Unexpected dependency: ${id}`);
    };
    let source = fs.readFileSync(path.join(__dirname, '..', 'out', `${name}.js`), 'utf8');
    if (name === 'extension') source = transformExtension(source);
    vm.runInNewContext(source, { exports, require: requireMock, setTimeout: () => 0, clearTimeout: () => {} });
    return exports;
  };
  client = load('client');
  load('extension').activate({ subscriptions: [] });
  // Serialize values from the VM realm before comparing prototype identity.
  const launch = () => JSON.parse(JSON.stringify(launches.at(-1)));
  return { launch, handlers, providers, status, logs, diagnosticUpdates, diagnosticDeletes, children, client, channel, workspace: vscode.workspace };
}

async function main() {

for (const [name, setup, cwd] of [
  ['current Can document folder', { folders: [first, second], document: canDocument, owner: second }, second.uri.fsPath],
  ['first local folder when editor is not Can', { folders: [remote, first], document: { languageId: 'json' }, owner: second }, first.uri.fsPath],
  ['unowned Can document', { folders: [first], document: canDocument }, first.uri.fsPath],
  ['remote owner falls back to local workspace', { folders: [remote, first], document: canDocument, owner: remote }, first.uri.fsPath],
  ['no workspace preserves process cwd', {}, undefined],
  ['remote-only workspace preserves process cwd', { folders: [remote] }, undefined],
]) {
  const state = startup(setup);
  assert.deepEqual(state.launch(), {
    command: serverPath,
    args: ['lsp'],
    options: cwd === undefined ? {} : { cwd },
  }, name);
  console.log(`PASS ${name}`);
}

const state = startup({ folders: [first, second], owner: second });
for (const name of ['Open', 'Change', 'Save', 'Close', 'Configuration']) {
  assert.equal(typeof state.handlers[name], 'function', `${name} listener registered`);
}
assert.deepEqual(
  JSON.parse(JSON.stringify(state.providers.registerCodeActionsProvider.metadata)),
  { providedCodeActionKinds: ['quickfix'] },
);
assert.equal(state.providers.registerCompletionItemProvider.metadata, '.', 'member completion dot trigger');
assert(state.providers.registerDocumentFormattingEditProvider && state.providers.registerDocumentSymbolProvider);
assert(state.providers.registerFoldingRangeProvider && state.providers.registerSelectionRangeProvider);
const restricted = startup({ folders: [second], document: canDocument, owner: second, trusted: false });
assert.equal(restricted.children.length, 0, 'restricted workspace launches no binary');
assert(restricted.status.text.includes('lock'));
restricted.workspace.isTrusted = true; restricted.handlers.Trust();
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
assert.equal(restricted.children.length, 1, 'trust granted starts the server');
assert(restricted.status.text.includes('sync'), 'status shows initialization');
const trustedChild = restricted.children[0];
const trustBody = JSON.stringify({jsonrpc:'2.0', id:trustedChild.messages[0].id, result:{capabilities:{}}});
trustedChild.stdout.emit('data', Buffer.from(`Content-Length: ${Buffer.byteLength(trustBody)}\r\n\r\n${trustBody}`).toString('latin1'));
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
assert(restricted.status.text.includes('check'), 'status reports ready');
assert(restricted.logs.some(line => line.includes('Language server ready')));
trustedChild.emit('exit', 1);
assert(restricted.status.text.includes('warning'), 'status reports an exited server');
console.log('PASS trust grant, visible starting/ready/unavailable status and lifecycle output');
assert(restricted.providers.registerHoverProvider, 'language providers are registered for later trust');
console.log('PASS restricted workspace syntax remains available without starting a server');
console.log('PASS activation registers document/config listeners, editing providers, dot completion and quick fixes');

assert.throws(() => startup({}, (source) =>
  source.replace('vscodeApi.languages.registerCodeActionsProvider(',
    'vscodeApi.languages.registerCodeActionProvider(')),
  /registerCodeActionProvider is not a function/,
  'strict public API mock rejects the previous activation typo');
console.log('PASS strict public API mock rejects the previous activation typo');

const live = startup({ folders: [first], owner: first });
const child = live.children[0];
const publish = (message) => {
  const body = JSON.stringify(message);
  child.stdout.emit('data', Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`).toString('latin1'));
};
const initialize = child.messages.find((message) => message.method === 'initialize');
publish({ jsonrpc: '2.0', id: initialize.id, result: { capabilities: {} } });
await Promise.resolve();
await Promise.resolve();
const uri = 'file:///workspace/first/diagnostics.can';
const changedDocument = {
  languageId: 'can', version: 2, uri: { toString: () => uri },
  getText: () => 'app T\nGiven\n policy\nWhen\nThen\n',
};
live.handlers.Change({ document: changedDocument });
const change = child.messages.find((message) => message.method === 'textDocument/didChange');
assert.deepEqual(JSON.parse(JSON.stringify(change.params)), {
  textDocument: { uri, version: 2 }, contentChanges: [{ text: changedDocument.getText() }],
});
const diagnostic = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
  message: 'Example source error', severity: 1, code: 'E1200',
};
publish({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics',
  params: { uri, version: 2, diagnostics: [diagnostic] } });
assert.equal(live.diagnosticUpdates.at(-1).diagnostics[0].code, 'E1200');
assert.equal(live.diagnosticUpdates.at(-1).diagnostics[0].severity, 0);
changedDocument.version = 3;
changedDocument.getText = () => 'app T\nGiven\nWhen\nThen\n';
live.handlers.Change({ document: changedDocument });
const correction = child.messages.filter((message) => message.method === 'textDocument/didChange').at(-1);
assert.equal(correction.params.textDocument.version, 3);
assert.equal(correction.params.contentChanges[0].text, changedDocument.getText());
publish({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics',
  params: { uri, version: 3, diagnostics: [] } });
assert.equal(live.diagnosticUpdates.at(-1).uri.toString(), uri);
assert.equal(live.diagnosticUpdates.at(-1).diagnostics.length, 0);
console.log('PASS change notifications and published diagnostic clearing');

const closedUri = 'file:///workspace/first/unopened.can';
const closedDocument = { languageId: 'can', version: 1,
  uri: { scheme: 'file', fsPath: '/workspace/first/unopened.can', toString: () => closedUri },
  getText: () => 'package Shared\n Given\n When\n Then\n' };
publish({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics',
  params: { uri: closedUri, diagnostics: [diagnostic] } });
assert.equal(live.diagnosticUpdates.at(-1).uri.toString(), closedUri, 'versionless closed project diagnostics install');
live.handlers.FileChange(closedDocument.uri);
assert.equal(live.diagnosticDeletes.at(-1), closedUri, 'watch change clears closed diagnostics pending refresh');
publish({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics',
  params: { uri: closedUri, diagnostics: [diagnostic] } });
live.handlers.Open(closedDocument);
assert.equal(live.diagnosticDeletes.at(-1), closedUri, 'opening establishes overlay ownership and clears closed publication');
const writesBeforeVersionless = live.diagnosticUpdates.length;
for (const params of [
  { uri: closedUri, diagnostics: [diagnostic] },
  { uri: closedUri, version: null, diagnostics: [diagnostic] },
  { uri: 'file:///workspace/second/unopened.can', diagnostics: [diagnostic] },
  { uri: 'vscode-remote://ssh/remote/unopened.can', diagnostics: [diagnostic] },
]) { publish({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params }); }
assert.equal(live.diagnosticUpdates.length, writesBeforeVersionless,
  'open owners, foreign roots and remote documents refuse versionless diagnostics');
const openedVersion = child.messages.filter((message) => message.method === 'textDocument/didOpen').at(-1).params.textDocument.version;
publish({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics',
  params: { uri: closedUri, version: openedVersion, diagnostics: [diagnostic] } });
assert.equal(live.diagnosticUpdates.length, writesBeforeVersionless + 1, 'current numeric overlay diagnostics install');
live.handlers.Close(closedDocument);
assert.equal(live.diagnosticDeletes.at(-1), closedUri, 'closing clears overlay diagnostics');
publish({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics',
  params: { uri: closedUri, diagnostics: [] } });
assert.equal(live.diagnosticUpdates.at(-1).diagnostics.length, 0, 'closed repair publication clears Problems');
console.log('PASS versionless local closed diagnostics, watch/open/close clears and strict open-owner refusal');

const readyChild = state.children[0];
const readyBody = JSON.stringify({ jsonrpc: '2.0', id: readyChild.messages[0].id, result: { capabilities: {} } });
readyChild.stdout.emit('data', Buffer.from(`Content-Length: ${Buffer.byteLength(readyBody)}\r\n\r\n${readyBody}`).toString('latin1'));
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
readyChild.emit('exit', 1);
state.handlers.Open(canDocument);
assert.equal(state.launch().options.cwd, second.uri.fsPath, 'reopen uses the newly opened Can document');
console.log('PASS reopen uses the newly opened Can document');

const projectDocument = (folder, name) => ({ languageId: 'can', version: 1,
  uri: { scheme: 'file', fsPath: `${folder.uri.fsPath}/${name}.can`, toString() { return `file://${this.fsPath}`; } },
  getText: () => 'app T\nGiven\nWhen\nThen\n' });
const oneDoc = projectDocument(first, 'one');
const twoDoc = projectDocument(second, 'two');
let currentFolders = [first, second];
const roots = startup({ folders: currentFolders, document: oneDoc, documents: [oneDoc, twoDoc],
  folderForUri: (uri) => currentFolders.find((folder) => uri.fsPath.startsWith(`${folder.uri.fsPath}/`)) });
assert.equal(roots.children.length, 2, 'one independent process per local root');
for (const [index, folder] of [first, second].entries()) {
  const child = roots.children[index];
  const initialize = child.messages.find((message) => message.method === 'initialize');
  assert.equal(initialize.params.rootUri, folder.uri.toString());
  assert.deepEqual(initialize.params.workspaceFolders.map((item) => item.uri), [first.uri.toString(), second.uri.toString()]);
  const body = JSON.stringify({ jsonrpc: '2.0', id: initialize.id, result: { capabilities: {} } });
  child.stdout.emit('data', Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`).toString('latin1'));
}
await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
for (const [index, doc] of [oneDoc, twoDoc].entries()) {
  const opens = roots.children[index].messages.filter((message) => message.method === 'textDocument/didOpen');
  assert.deepEqual(opens.map((message) => message.params.textDocument.uri), [doc.uri.toString()]);
}
for (const [event, type] of [['Create', 1], ['Change', 2], ['Delete', 3]]) {
  roots.handlers[`File${event}`](twoDoc.uri);
  assert.equal(roots.children[1].messages.at(-1).method, 'workspace/didChangeWatchedFiles');
  assert.equal(roots.children[1].messages.at(-1).params.changes[0].type, type);
}
assert(!roots.children[0].messages.some((message) => message.method === 'workspace/didChangeWatchedFiles'), 'watchers preserve root isolation');
currentFolders = [first];
roots.workspace.workspaceFolders = currentFolders;
roots.handlers.Folders({ added: [], removed: [second] });
assert.equal(roots.children.length, 3, 'departed-root document gets isolated fallback process');
assert(roots.children[1].messages.some((message) => message.method === 'shutdown'));
assert(!roots.children[0].messages.some((message) => message.method === 'shutdown'), 'unchanged root stays live');
assert.equal(roots.children[2].messages.find((message) => message.method === 'initialize').params.rootUri, null);
const nested = local('/workspace/first/nested');
currentFolders = [first, nested];
roots.workspace.workspaceFolders = currentFolders;
roots.handlers.Folders({ added: [nested], removed: [] });
assert.equal(roots.children.length, 4, 'parent restarts after a nested root boundary is added');
assert(roots.children[0].messages.some((message) => message.method === 'shutdown'));
const restartedParent = roots.children[3].messages.find((message) => message.method === 'initialize');
assert.equal(restartedParent.params.rootUri, first.uri.toString());
assert.deepEqual(restartedParent.params.workspaceFolders.map((item) => item.uri), [first.uri.toString(), nested.uri.toString()]);
console.log('PASS multi-root initialization, overlay routing, watched files, removal and nested ownership refresh');

new state.client.CanLanguageClient(serverPath, state.channel, false).start();
assert.deepEqual(state.launch().options, {}, 'existing three-argument callers preserve process cwd');
console.log('PASS existing three-argument callers preserve process cwd');

}
main().catch((error) => { console.error(error); process.exitCode = 1; });
