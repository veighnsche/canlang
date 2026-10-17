#!/usr/bin/env node
/** Finite installed compiler LSP witness, without an editor or downloads. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const option = name => process.argv[process.argv.indexOf(name) + 1];
const tools = resolve(option('--tool-root')), state = resolve(option('--state'));
assert.ok(state.startsWith('/home/'));
await mkdir(state, { recursive: true, mode: 0o700 });
const source = 'app   LspProof\nGiven\n Item { name:text }\n policy Item read=public\nWhen\n crud Item by=public fields=name\nThen\n page / title="LSP proof"\n  list Item\n   text row.name\n';
const file = join(state, 'LspProof.can'); await writeFile(file, source);
const uri = pathToFileURL(file).href;
const child = spawn(join(tools, 'bin/can'), ['lsp'], { cwd: state, env: { ...process.env, CAN_CATALOG: join(tools, 'lib/node_modules/@canlang/cloudflare/dist/native-catalog.json') }, stdio: ['pipe', 'pipe', 'inherit'] });
const exited = once(child, 'close');
let buffer = Buffer.alloc(0), sequence = 0;
const pending = new Map(), notifications = [];
child.stdout.on('data', bytes => {
  buffer = Buffer.concat([buffer, bytes]);
  while (true) {
    const boundary = buffer.indexOf('\r\n\r\n'); if (boundary < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, boundary).toString())[1]);
    if (buffer.length < boundary + 4 + length) return;
    const message = JSON.parse(buffer.subarray(boundary + 4, boundary + 4 + length).toString());
    buffer = buffer.subarray(boundary + 4 + length);
    if (message.id !== undefined) { const waiter = pending.get(message.id); if (waiter) { pending.delete(message.id); waiter(message); } }
    else notifications.push(message);
  }
});
const send = value => { const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...value })); child.stdin.write(`Content-Length: ${bytes.length}\r\n\r\n`); child.stdin.write(bytes); };
const request = (method, params) => new Promise((resolve, reject) => {
  const id = ++sequence, timeout = setTimeout(() => { pending.delete(id); reject(new Error(`LSP ${method} timed out`)); }, 10000);
  pending.set(id, message => { clearTimeout(timeout); assert.equal(message.error, undefined, JSON.stringify(message.error)); resolve(message.result); });
  send({ id, method, params });
});
try {
  const initialized = await request('initialize', { processId: process.pid, rootUri: pathToFileURL(state).href, capabilities: {} });
  assert.ok(initialized.capabilities.completionProvider);
  send({ method: 'initialized', params: {} });
  send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'can', version: 1, text: source } } });
  const until = Date.now() + 10000;
  while (!notifications.some(value => value.method === 'textDocument/publishDiagnostics') && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  const diagnostics = notifications.find(value => value.method === 'textDocument/publishDiagnostics');
  assert.ok(diagnostics); assert.deepEqual(diagnostics.params.diagnostics, []);
  const completions = await request('textDocument/completion', { textDocument: { uri }, position: { line: 9, character: 12 } });
  const items = Array.isArray(completions) ? completions : completions.items;
  assert.ok(items.some(item => item.label === 'name'), JSON.stringify(items));
  const definition = await request('textDocument/definition', { textDocument: { uri }, position: { line: 8, character: 8 } });
  assert.ok(Array.isArray(definition) && definition.length > 0); assert.equal(definition[0].uri, uri);
  const formatting = await request('textDocument/formatting', { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } });
  assert.ok(Array.isArray(formatting) && formatting.length > 0);
  send({ method: 'textDocument/didChange', params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'app LspProof\nGiven\n Item { name:missing }\n' }] } });
  const changedUntil = Date.now() + 10000;
  while (!notifications.some(value => value.method === 'textDocument/publishDiagnostics' && value.params.version === 2 && value.params.diagnostics.length > 0) && Date.now() < changedUntil) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(notifications.some(value => value.method === 'textDocument/publishDiagnostics' && value.params.version === 2 && value.params.diagnostics.length > 0));
  await request('shutdown', null); send({ method: 'exit' }); child.stdin.end();
  const [code] = await exited; assert.equal(code, 0);
  const results = { initialize: true, validDiagnostics: true, invalidDiagnostics: true, memberCompletion: true, definitionNavigation: true, formatting: true, installedCompiler: tools };
  await writeFile(join(state, 'lsp-results.json'), JSON.stringify(results, null, 2)); console.log(JSON.stringify(results, null, 2));
} finally { if (child.exitCode === null) { child.kill('SIGTERM'); await exited; } }
