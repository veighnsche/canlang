/** Compile first. Controlled transport events run the unmodified compiled client
 * and extension. Timers are virtual; real subprocess controls run separately. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const tick = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
const document = () => ({ languageId: 'can', version: 1,
  uri: { scheme: 'file', fsPath: '/test.can', toString: () => 'file:///test.can' },
  getText() { return `version ${this.version}`; } });
function fixture(spawnOverride, realTimers = false) {
  const state = { children: [], handlers: {}, commands: {}, errors: [], disposals: 0, timers: new Map() };
  let clock = 0, timerId = 0;
  const disposable = { dispose() {} };
  state.advance = async (ms) => {
    clock += ms;
    for (const [id, timer] of [...state.timers]) {
      if (timer.at <= clock && state.timers.delete(id)) timer.callback();
    }
    await tick();
  };
  const vscode = {
    workspace: { textDocuments: [], workspaceFolders: [], getWorkspaceFolder() {},
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      ...Object.fromEntries(['Open', 'Change', 'Save', 'Close'].map((name) => [
        `onDid${name}TextDocument`, (callback) => { state.handlers[name] = callback; return disposable; }])),
      onDidChangeConfiguration(callback) { state.handlers.Configuration = callback; return disposable; },
    },
    window: { createOutputChannel: () => ({ ...disposable, appendLine() {} }),
      showErrorMessage: (message) => state.errors.push(message) },
    commands: { registerCommand(name, callback) { state.commands[name] = callback; return disposable; } },
    languages: { createDiagnosticCollection: () => ({ set() {}, delete() {},
      dispose() { state.disposals++; } }),
      ...Object.fromEntries(['Hover', 'CompletionItem', 'Definition', 'Reference', 'Rename',
        'DocumentSemanticTokens', 'CodeActions'].map((name) => [`register${name}Provider`, () => disposable])),
    },
    CompletionItemKind: {}, SemanticTokensLegend: class {}, CodeActionKind: { QuickFix: 'quickfix' },
  };
  const childApi = { spawn() {
    if (spawnOverride) { const child = spawnOverride(); state.children.push(child); return child; }
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdout.setEncoding = child.stderr.setEncoding = () => {};
    child.messages = []; child.kills = []; child.ended = false;
    child.stdin.write = (frame) => {
      if (child.throwWrite) throw new Error('controlled write failure');
      child.messages.push(JSON.parse(frame.split('\r\n\r\n')[1]));
    };
    child.stdin.end = () => { child.ended = true; };
    child.kill = (signal) => { child.kills.push(signal); };
    child.reply = (method, result = { capabilities: {} }, error) => {
      const request = child.messages.findLast((message) => message.method === method);
      assert(request, `request ${method} exists`);
      const body = JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(error ? { error } : { result }) });
      child.stdout.emit('data', `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    };
    state.children.push(child); return child;
  } };
  let client;
  const load = (name) => {
    const exports = {};
    const requireMock = (id) => id === 'vscode' ? vscode : id === 'child_process' ? childApi :
      id === './client' ? client : require(id);
    vm.runInNewContext(fs.readFileSync(path.join(process.env.CAN_CLIENT_OUT || path.join(__dirname, '../out'), `${name}.js`), 'utf8'), {
      exports, require: requireMock,
      setTimeout(callback, ms) { if (realTimers) return setTimeout(callback, ms); const id = ++timerId; state.timers.set(id, { callback, at: clock + ms }); return id; },
      clearTimeout(id) { if (realTimers) clearTimeout(id); else state.timers.delete(id); },
    });
    return exports;
  };
  client = load('client'); state.extension = load('extension'); state.vscode = vscode;
  state.client = () => new client.CanLanguageClient('can', vscode.window.createOutputChannel(), false);
  return state;
}
async function main() {
  {
    const f = fixture(), c = f.client(), doc = document();
    const started = c.start(); assert.equal(c.start(), started, 'concurrent starts share handshake');
    const child = f.children[0]; c.didOpen(doc); c.didChange(doc); c.didSave(doc);
    await assert.rejects(c.request('textDocument/hover', {}), /not ready/);
    assert.deepEqual(child.messages.map((m) => m.method), ['initialize']);
    child.reply('initialize'); await started; c.didOpen(doc);
    assert.deepEqual(child.messages.map((m) => m.method), ['initialize', 'initialized', 'textDocument/didOpen']);
    const pending = c.request('textDocument/hover', {});
    child.emit('exit', 1); assert.equal(await pending, null);
    console.log('PASS delayed initialization gates traffic and shares handshake');
  }
  {
    const f = fixture(() => { throw new Error('controlled spawn failure'); }), c = f.client();
    await assert.rejects(c.start(), /could not spawn/);
    await assert.rejects(c.start(), /shut down/); assert.equal(f.disposals, 1);
    console.log('PASS synchronous spawn failure rejects and spends client');
  }
  {
    const f = fixture(), c = f.client(), started = c.start();
    const rejected = assert.rejects(started, /initialize failed/);
    const stopped = c.stop(); await assert.rejects(c.start(), /shut down/);
    await f.advance(2000); await stopped; await rejected;
    assert.equal(f.disposals, 1); assert.equal(f.timers.size, 0);
    console.log('PASS stop during handshake rejects startup and clears both deadlines');
  }
  for (const failure of ['rpc-error', 'spawn-error', 'timeout', 'write-error']) {
    const f = fixture(), c = f.client(); const started = c.start();
    const rejected = assert.rejects(started, /initialize/), child = f.children[0];
    if (failure === 'rpc-error') child.reply('initialize', null, { code: -32603, message: 'refused' });
    if (failure === 'spawn-error') { child.emit('error', new Error('ENOENT')); child.emit('exit', 1); }
    if (failure === 'timeout') await f.advance(10000);
    if (failure === 'write-error') child.stdin.emit('error', new Error('EPIPE'));
    await rejected; assert.equal(c.serverCapabilities(), null);
    assert(!child.messages.some((m) => m.method === 'initialized'));
    assert.equal(f.disposals, 1); assert.equal(f.timers.size, 0);
    await assert.rejects(c.start(), /shut down/);
    console.log(`PASS ${failure} initialization rejects and disposes once`);
  }
  for (const mode of ['cooperative', 'no-shutdown', 'no-exit', 'failed-write']) {
    const f = fixture(), c = f.client(); const started = c.start(), child = f.children[0];
    child.reply('initialize'); await started;
    let exits = 0; c.onExit = () => exits++;
    const pending = c.request('textDocument/hover', {});
    let pendingSettled = false;
    pending.then(() => { pendingSettled = true; });
    if (mode === 'failed-write') child.throwWrite = true;
    const stopped = c.stop(); assert.equal(c.stop(), stopped);
    await tick();
    assert(pendingSettled, 'stop cancels pending request at time zero without advancing virtual time');
    assert.equal(await pending, null, 'stop cancels outstanding work before any shutdown response or deadline');
    let settled = false; stopped.then(() => { settled = true; });
    if (mode === 'cooperative' || mode === 'no-exit') { child.reply('shutdown', null); assert(child.ended); }
    if (mode === 'cooperative') { child.emit('exit', 0); await tick(); assert(settled, 'exit settles stop immediately'); }
    if (mode === 'no-shutdown' || mode === 'no-exit') { await f.advance(1999); assert(!settled); await f.advance(1); }
    await stopped; assert.equal(await pending, null); assert.equal(exits, 0);
    assert.equal(f.disposals, 1); assert.equal(f.timers.size, 0);
    if (mode !== 'cooperative') assert.deepEqual(child.kills, ['SIGKILL']);
    const count = child.messages.length; c.didOpen(document()); assert.equal(child.messages.length, count);
    console.log(`PASS ${mode} stop settles requests and owns bounded cleanup`);
  }
  {
    const f = fixture(), c = f.client(); const started = c.start(), child = f.children[0];
    child.reply('initialize'); await started; child.throwWrite = true;
    await assert.rejects(c.request('textDocument/hover', {}), /not running/);
    assert.equal(f.disposals, 1, 'synchronous request write failure retires transport immediately');
    child.stdin.emit('error', new Error('EPIPE')); await c.stop();
    console.log('PASS synchronous failed request write rejects and retires client');
  }
  {
    const f = fixture(), c = f.client(), doc = document();
    const started = c.start(), child = f.children[0]; child.reply('initialize'); await started;
    c.didOpen(doc); assert(c.isDocumentVersion(doc.uri.toString(), 1));
    const pending = c.request('textDocument/hover', {});
    let pendingSettled = false;
    pending.then(() => { pendingSettled = true; });
    doc.version = 2; child.throwWrite = true; c.didChange(doc);
    assert(!c.isDocumentVersion(doc.uri.toString(), 2), 'unsent change cannot establish a current revision');
    assert(!c.isDocumentVersion(doc.uri.toString(), 1), 'failed transport retires previous document ownership too');
    await tick();
    assert(pendingSettled, 'failed notification settles pending request without waiting for process exit');
    assert.equal(await pending, null, 'failed notification settles existing request immediately');
    assert.deepEqual(child.messages.map((m) => m.method),
      ['initialize', 'initialized', 'textDocument/didOpen', 'textDocument/hover']);
    assert.equal(f.disposals, 1); assert.deepEqual(child.kills, ['SIGKILL']);
    await assert.rejects(c.request('textDocument/hover', {}), /not ready/);
    console.log('PASS failed change write retires unsent revision and pending work immediately');
  }
  {
    const f = fixture(), doc = document(); f.vscode.workspace.textDocuments.push(doc);
    f.extension.activate({ subscriptions: [] }); const first = f.children[0];
    f.handlers.Open(doc); doc.version = 2; f.handlers.Change({ document: doc });
    first.reply('initialize'); await tick();
    assert.equal(first.messages.filter((m) => m.method === 'textDocument/didOpen').length, 1);
    assert.equal(first.messages.find((m) => m.method === 'textDocument/didOpen').params.textDocument.text, 'version 2');
    f.commands['can.restartServer'](); f.commands['can.restartServer']();
    f.handlers.Configuration({ affectsConfiguration: () => true }); f.handlers.Open(doc);
    assert.equal(f.children.length, 1, 'restart and open wait for retiring child');
    first.reply('shutdown', null); first.emit('exit', 0); await tick();
    assert.equal(f.children.length, 2, 'overlapping restart coalesces to one child');
    const second = f.children[1]; second.reply('initialize'); await tick(); second.emit('exit', 1);
    assert.equal(f.errors.length, 1); f.handlers.Open(doc); assert.equal(f.children.length, 3);
    const third = f.children[2]; third.reply('initialize'); await tick();
    assert.equal(third.messages.find((m) => m.method === 'textDocument/didOpen').params.textDocument.text, 'version 2');
    f.commands['can.restartServer'](); const deactivated = f.extension.deactivate();
    third.reply('shutdown', null); third.emit('exit', 0); await deactivated;
    assert.equal(f.children.length, 3, 'deactivation prevents queued restart');
    console.log('PASS delayed replay, overlapping restarts, crash reopen and deactivation');
  }
}
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { fixture, document, tick };
