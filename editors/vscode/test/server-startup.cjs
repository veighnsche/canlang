/** Compile the extension first, then run with node test/server-startup.cjs. */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const local = (fsPath) => ({ uri: { scheme: 'file', fsPath } });
const remote = { uri: { scheme: 'vscode-remote', fsPath: '/remote' } };
const first = local('/workspace/first');
const second = local('/workspace/second');
const canDocument = { languageId: 'can', uri: { scheme: 'file', fsPath: '/workspace/second/a.can' } };
const serverPath = '/compiler path/can';
const disposable = { dispose() {} };

function startup({ folders, document, owner }, transformExtension = (source) => source) {
  const launches = [];
  const children = [];
  const handlers = {};
  const providers = {};
  const diagnosticUpdates = [];
  const channel = { ...disposable, appendLine() {} };
  const vscode = {
    workspace: {
      textDocuments: [],
      workspaceFolders: folders,
      getWorkspaceFolder: () => owner,
      getConfiguration: () => ({ get: (key, fallback) => key === 'serverPath' ? serverPath : fallback }),
      ...Object.fromEntries(['Open', 'Change', 'Save', 'Close'].map((event) => [
        `onDid${event}TextDocument`, (callback) => { handlers[event] = callback; return disposable; },
      ])),
      onDidChangeConfiguration: (callback) => { handlers.Configuration = callback; return disposable; },
    },
    window: {
      activeTextEditor: document ? { document } : undefined,
      createOutputChannel: () => channel,
      showErrorMessage() {},
    },
    languages: {
      createDiagnosticCollection: () => ({
        ...disposable,
        set(uri, diagnostics) { diagnosticUpdates.push({ uri, diagnostics }); },
        delete() {},
      }),
      ...Object.fromEntries([
        'registerHoverProvider', 'registerCompletionItemProvider', 'registerDefinitionProvider',
        'registerReferenceProvider', 'registerRenameProvider',
        'registerDocumentSemanticTokensProvider', 'registerCodeActionsProvider',
      ].map((name) => [name, (selector, provider, metadata) => {
        providers[name] = { selector, provider, metadata };
        return disposable;
      }])),
    },
    commands: { registerCommand: () => disposable },
    SemanticTokensLegend: class {},
    CodeActionKind: { QuickFix: 'quickfix' },
    CompletionItemKind: {},
    Uri: { parse: (value) => ({ toString: () => value }) },
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
      if (id === './client') return client;
      throw new Error(`Unexpected dependency: ${id}`);
    };
    let source = fs.readFileSync(path.join(__dirname, '..', 'out', `${name}.js`), 'utf8');
    if (name === 'extension') source = transformExtension(source);
    vm.runInNewContext(source, { exports, require: requireMock, setTimeout, clearTimeout });
    return exports;
  };
  client = load('client');
  load('extension').activate({ subscriptions: [] });
  // Serialize values from the VM realm before comparing prototype identity.
  const launch = () => JSON.parse(JSON.stringify(launches.at(-1)));
  return { launch, handlers, providers, diagnosticUpdates, children, client, channel };
}

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
console.log('PASS activation registers document/config listeners and quick fixes');

assert.throws(() => startup({}, (source) =>
  source.replace('vscodeApi.languages.registerCodeActionsProvider(',
    'vscodeApi.languages.registerCodeActionProvider(')),
  /registerCodeActionProvider is not a function/,
  'strict public API mock rejects the previous activation typo');
console.log('PASS strict public API mock rejects the previous activation typo');

const live = startup({ folders: [first] });
const child = live.children[0];
const publish = (message) => {
  const body = JSON.stringify(message);
  child.stdout.emit('data', `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};
const initialize = child.messages.find((message) => message.method === 'initialize');
publish({ jsonrpc: '2.0', id: initialize.id, result: { capabilities: {} } });
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

state.children[0].emit('exit', 1);
state.handlers.Open(canDocument);
assert.equal(state.launch().options.cwd, second.uri.fsPath, 'reopen uses the newly opened Can document');
console.log('PASS reopen uses the newly opened Can document');

new state.client.CanLanguageClient(serverPath, state.channel, false).start();
assert.deepEqual(state.launch().options, {}, 'existing three-argument callers preserve process cwd');
console.log('PASS existing three-argument callers preserve process cwd');
