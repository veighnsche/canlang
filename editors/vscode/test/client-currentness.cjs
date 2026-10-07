/** Compile first, then node test/client-currentness.cjs ($CAN_BIN overrides the real server).
 * Loads compiled providers verbatim. Delays complete real server frames and applies
 * offered edits in a UTF-16 host stand-in; this does not qualify the VS Code GUI.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '../../..');
const binary = process.env.CAN_BIN || path.join(root, 'compiler/target/debug/can');
const output = process.env.CAN_CLIENT_OUT || path.join(__dirname, '../out');
const children = [];
const disposable = { dispose() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert(Date.now() < deadline, 'real server observation deadline');
    await sleep(5);
  }
}
function document(text, name = 'é😀.can') {
  return { languageId: 'can', version: 1, text,
    uri: { scheme: 'file', fsPath: path.join(root, name), toString: () => `file://${root}/${name}` },
    getText() { return this.text; } };
}
function cancellation(cancelled = false) {
  const listeners = new Set();
  return { isCancellationRequested: cancelled, registrations: 0, disposals: 0,
    onCancellationRequested(callback) {
      this.registrations++;
      listeners.add(callback);
      return { dispose: () => { if (listeners.delete(callback)) this.disposals++; } };
    },
    cancel() { this.isCancellationRequested = true; for (const callback of [...listeners]) callback(); },
    get listenerCount() { return listeners.size; },
  };
}
function host(documents = []) {
  const state = { handlers: {}, providers: {}, collection: new Map(), updates: [], errors: [] };
  const vscode = {
    workspace: { textDocuments: documents, workspaceFolders: [], getWorkspaceFolder: () => undefined,
      getConfiguration: () => ({ get: (key, fallback) => key === 'serverPath' ? binary : fallback }),
      onDidChangeConfiguration: () => disposable,
      ...Object.fromEntries(['Open', 'Change', 'Save', 'Close'].map((name) => [
        `onDid${name}TextDocument`, (callback) => { state.handlers[name] = callback; return disposable; },
      ])),
    },
    window: { createOutputChannel: () => state.channel, showErrorMessage: (message) => state.errors.push(message) },
    commands: { registerCommand: () => disposable },
    languages: {
      createDiagnosticCollection: () => ({
        set(uri, diagnostics) { state.collection.set(uri.toString(), diagnostics); state.updates.push(diagnostics); },
        delete(uri) { state.collection.delete(uri.toString()); },
        dispose() { state.collection.clear(); },
      }),
      ...Object.fromEntries(['Hover', 'CompletionItem', 'Definition', 'Reference', 'Rename',
        'DocumentSemanticTokens', 'CodeActions'].map((name) => [
        `register${name}Provider`, (_selector, provider) => { state.providers[name] = provider; return disposable; },
      ])),
    },
    Uri: { parse: (value) => ({ toString: () => value }) },
    Position: class { constructor(line, character) {
      assert(Number.isInteger(line) && line >= 0 && Number.isInteger(character) && character >= 0);
      Object.assign(this, { line, character });
    } },
    Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    // Independent VS Code 1.91 identities, rather than the source ambient enum.
    CompletionItemKind: Object.fromEntries(['Text', 'Method', 'Function', 'Constructor', 'Field',
      'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword',
      'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct',
      'Event', 'Operator', 'TypeParameter'].map((name, index) => [name, index])),
    CompletionItem: class { constructor(label) { this.label = label; } },
    TextEdit: class { constructor(range, newText) { Object.assign(this, { range, newText }); } },
    WorkspaceEdit: class { constructor() { this.entries = new Map(); }
      set(uri, edits) { this.entries.set(uri.toString(), edits); } },
    MarkdownString: class { constructor(value) { this.value = value; } },
    Hover: class { constructor(contents) { this.contents = contents; } },
    SemanticTokensLegend: class {}, CodeActionKind: { QuickFix: 'quickfix' },
    CodeAction: class { constructor(title, kind) { Object.assign(this, { title, kind }); } },
    Location: class { constructor(uri, range) { Object.assign(this, { uri, range }); } },
    SemanticTokens: class { constructor(data) { this.data = data; } },
  };
  state.channel = { ...disposable, appendLine() {} };
  const childApi = { spawn(command, args, options) {
    const real = cp.spawn(command, args, options);
    const child = new EventEmitter();
    Object.assign(child, { real, sent: [], frames: [], held: [], gate: () => false,
      stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: new EventEmitter() });
    child.stdout.setEncoding = child.stderr.setEncoding = () => {};
    child.stdin.write = (raw) => {
      child.sent.push(JSON.parse(raw.split('\r\n\r\n')[1]));
      return real.stdin.write(raw);
    };
    child.stdin.end = () => real.stdin.end();
    child.kill = () => real.kill();
    real.stdin.on('error', (error) => child.stdin.emit('error', error));
    let buffer = Buffer.alloc(0);
    real.stdout.on('data', (raw) => {
      buffer = Buffer.concat([buffer, raw]);
      for (;;) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
        if (buffer.length < end + 4 + length) return;
        const frame = buffer.subarray(0, end + 4 + length);
        const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
        buffer = buffer.subarray(end + 4 + length);
        child.frames.push(message);
        if (child.gate(message)) child.held.push({ message, frame });
        else child.stdout.emit('data', frame.toString('utf8'));
      }
    });
    child.release = (held) => child.stdout.emit('data', held.frame.toString('utf8'));
    real.stderr.on('data', (raw) => child.stderr.emit('data', raw.toString()));
    real.on('error', (error) => child.emit('error', error));
    real.on('exit', (code) => { child.exit = code; child.emit('exit', code); });
    children.push(child);
    state.child = child;
    return child;
  } };
  let client;
  function load(name) {
    const exports = {};
    vm.runInNewContext(fs.readFileSync(path.join(output, `${name}.js`), 'utf8'), {
      exports, setTimeout, clearTimeout, require(id) {
        if (id === 'vscode') return vscode;
        if (id === 'child_process') return childApi;
        if (id === './client') return client;
        throw Error(`Unexpected dependency ${id}`);
      },
    });
    return exports;
  }
  client = load('client');
  state.client = new client.CanLanguageClient(binary, state.channel, false, root);
  state.extension = load('extension');
  return state;
}
function position(text, offset) {
  const prefix = text.slice(0, offset).split('\n');
  return { line: prefix.length - 1, character: prefix.at(-1).length };
}
function offset(text, point) {
  const lines = text.split('\n');
  assert(point.line < lines.length && point.character <= lines[point.line].length);
  return lines.slice(0, point.line).reduce((size, line) => size + line.length + 1, 0) + point.character;
}
function apply(edit, doc) {
  if (!edit) return false;
  const edits = edit.entries.get(doc.uri.toString());
  assert(edits, 'offered edit targets the live document');
  const spans = edits.map((item) => ({ start: offset(doc.text, item.range.start),
    end: offset(doc.text, item.range.end), text: item.newText })).sort((a, b) => b.start - a.start);
  for (const span of spans) doc.text = doc.text.slice(0, span.start) + span.text + doc.text.slice(span.end);
  return true;
}
const BAD = 'app T\nGiven\n Item {title:text="\\q"}\nWhen\nThen\n';
const GOOD = 'app T\nGiven\n Item {title:text}\nWhen\nThen\n';
const SYMBOL = fs.readFileSync(path.join(__dirname, 'lsp-capabilities.can'), 'utf8')
  .replace('let label=task.title', 'let label="😀"+task.title').replaceAll('\n', '\r\n');
const ACTION = fs.readFileSync(path.join(__dirname, 'lsp-codeaction.can'), 'utf8')
  .replace('let x=m?.n', 'let x="😀"+m?.n').replaceAll('\n', '\r\n');

async function diagnostics() {
  const state = host();
  const client = state.client;
  await client.start();
  const child = state.child;
  child.gate = (message) => message.method === 'textDocument/publishDiagnostics';
  const doc = document(BAD);
  client.didOpen(doc);
  await until(() => child.held.length === 1);
  const old = child.held[0];
  assert(old.message.params.diagnostics.length > 0);
  child.release(old);
  assert(state.collection.get(doc.uri.toString()).length > 0, 'current errors install');
  doc.text = GOOD; doc.version++;
  client.didChange(doc);
  await until(() => child.held.length === 2);
  const writes = state.updates.length;
  child.release(old);
  assert.equal(state.updates.length, writes, 'held old diagnostic is discarded');
  child.release(child.held[1]);
  assert.equal(state.collection.get(doc.uri.toString()).length, 0, 'current repair clears');
  client.didClose(doc);
  child.release(old);
  assert(!state.collection.has(doc.uri.toString()), 'closed errors do not revive');
  const reopened = document(GOOD);
  client.didOpen(reopened);
  await until(() => child.held.some((held) => held.message.params.version > doc.version));
  const reopenedPublication = child.held.find((held) => held.message.params.version > doc.version);
  const reopenWire = reopenedPublication.message.params.version;
  assert(reopenWire > old.message.params.version, 'same host version reopens with a new wire epoch');
  child.release(old);
  assert(!state.collection.has(doc.uri.toString()), 'old same-version open cannot revive');
  child.release(reopenedPublication);
  assert.equal(state.collection.get(doc.uri.toString()).length, 0, 'reopen current publication installs');
  child.gate = () => false;
  await client.stop();
  await until(() => child.exit !== undefined);
  console.log('PASS real client current/stale/closed/reopen diagnostics and repair clears');
}
async function providers() {
  const doc = document(SYMBOL, 'providers-é😀.can');
  const actionDoc = document(ACTION, 'actions-é😀.can');
  const state = host([doc, actionDoc]);
  state.extension.activate({ subscriptions: [] });
  const child = state.child;
  await until(() => child.frames.filter((m) => m.method === 'textDocument/publishDiagnostics').length === 2);
  const p = state.providers;
  const model = position(doc.text, doc.text.indexOf('Todo'));
  const task = position(doc.text, doc.text.indexOf('task:'));
  const use = position(doc.text, doc.text.indexOf('task.title'));
  const actionStart = position(actionDoc.text, actionDoc.text.indexOf('?.'));
  const actionRange = { start: actionStart, end: { ...actionStart, character: actionStart.character + 2 } };
  const cases = [
    ['hover', doc, (token) => p.Hover.provideHover(doc, task, token)],
    ['completion', doc, (token) => p.CompletionItem.provideCompletionItems(doc, use, token)],
    ['definition', doc, (token) => p.Definition.provideDefinition(doc, use, token)],
    ['references', doc, (token) => p.Reference.provideReferences(doc, model, { includeDeclaration: true }, token)],
    ['rename', doc, (token) => p.Rename.provideRenameEdits(doc, task, 'job', token)],
    ['semantic tokens', doc, (token) => p.DocumentSemanticTokens.provideDocumentSemanticTokens(doc, token)],
    ['code actions', actionDoc, (token) => p.CodeActions.provideCodeActions(actionDoc, actionRange, { diagnostics: [] }, token)],
  ];
  for (const [name, , invoke] of cases) {
    const token = cancellation(true);
    const before = child.sent.length;
    assert.equal(await invoke(token), undefined, `${name} pre-cancelled result`);
    assert.equal(child.sent.length, before, `${name} pre-cancelled sends no request`);
    assert.equal(token.registrations, 0);
  }
  console.log('PASS all seven actual providers suppress pre-cancelled calls');
  const completion = await cases[1][2](cancellation());
  for (const [label, kind] of [['Todo', 6], ['task', 5], ['and', 13]]) {
    assert.equal(completion.find((item) => item.label === label)?.kind, kind, label);
  }
  console.log('PASS actual type, variable and keyword completion host identities');
  for (const [name, target, invoke] of cases) {
    child.held = []; child.gate = (message) => Object.hasOwn(message, 'id');
    const token = cancellation();
    const pending = invoke(token);
    await until(() => child.held.length === 1);
    const held = child.held[0];
    assert(held.message.result && (!Array.isArray(held.message.result) || held.message.result.length > 0),
      `${name} real server supplies a result before stale rejection`);
    target.version++; state.handlers.Change({ document: target });
    child.release(held);
    const result = await pending;
    assert.equal(result, undefined, `${name} stale result`);
    assert.equal(token.listenerCount, 0, `${name} stale listener disposed`);
    if (name === 'rename') assert.equal(apply(result, target), false, 'stale rename applies no edit');
    if (name === 'code actions') assert.equal(apply(result?.[0]?.edit, target), false, 'stale action applies no edit');
    child.held = [];
    const liveToken = cancellation();
    const cancelled = invoke(liveToken);
    await until(() => child.held.length === 1);
    const cancelledFrame = child.held[0];
    const requestId = child.sent.filter((m) => Object.hasOwn(m, 'id')).at(-1).id;
    liveToken.cancel();
    const cancelledResult = await cancelled;
    assert.equal(cancelledResult, undefined, `${name} live-cancelled result settles before reply`);
    if (name === 'rename') assert.equal(apply(cancelledResult, target), false, 'cancelled rename applies no edit');
    if (name === 'code actions') assert.equal(apply(cancelledResult?.[0]?.edit, target), false, 'cancelled action applies no edit');
    assert(child.sent.some((m) => m.method === '$/cancelRequest' && m.params.id === requestId));
    assert.equal(liveToken.listenerCount, 0);
    child.release(cancelledFrame);
  }
  console.log('PASS all seven providers suppress stale revisions and settle live cancellation');
  child.held = [];
  const priorEpochRename = cases[4][2](cancellation());
  await until(() => child.held.length === 1);
  const priorEpochFrame = child.held[0];
  // A fresh open uses host version 1, while the one owner assigns a higher wire version.
  state.handlers.Close(doc);
  const reopened = document(SYMBOL, 'providers-é😀.can');
  state.handlers.Open(reopened);
  await until(() => child.frames.some((m) => m.method === 'textDocument/publishDiagnostics' &&
    m.params.uri === reopened.uri.toString() && m.params.version > doc.version));
  child.release(priorEpochFrame);
  assert.equal(await priorEpochRename, undefined, 'closed/reopened request epoch offers no edit');
  child.gate = () => false;
  const token = cancellation();
  const currentRename = await p.Rename.provideRenameEdits(reopened, task, 'job', token);
  assert(currentRename, 'current wire version passes even when host version resets to 1');
  const rawRename = child.frames.filter((m) => m.result?.documentChanges).at(-1).result;
  assert(rawRename.documentChanges[0].textDocument.version > reopened.version);
  assert(apply(currentRename, reopened));
  assert.equal(reopened.text, SYMBOL.replaceAll('task', 'job'),
    'host applies every offered rename edit exactly, preserving Unicode/CRLF');
  assert.equal(token.disposals, 1, 'completed request releases cancellation listener');
  assert.equal(token.listenerCount, 0);
  const before = child.sent.length; token.cancel();
  assert.equal(child.sent.length, before, 'completed request does not send late cancellation');
  const currentActions = await p.CodeActions.provideCodeActions(actionDoc, actionRange, { diagnostics: [] }, cancellation());
  assert.equal(currentActions[0]?.title, 'replace redundant `?.` with `.`');
  assert(apply(currentActions[0].edit, actionDoc));
  assert.equal(actionDoc.text, ACTION.replace('?.', '.'), 'UTF-16 current quick fix preserves emoji and exact text');
  console.log('PASS host stand-in applies current wire-version rename/action edits with Unicode/CRLF ranges');
  state.extension.deactivate();
  await until(() => child.exit !== undefined);
  assert.equal(state.errors.length, 0);
}
(async () => { await diagnostics(); await providers(); })().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  for (const child of children) if (child.exit === undefined) child.kill();
});
