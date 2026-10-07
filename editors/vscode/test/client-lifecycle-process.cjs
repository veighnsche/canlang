/** Real OS pipes, process exit, SIGKILL and EPIPE controls through the compiled
 * client callbacks; a tiny test peer provides controlled protocol failures. */
'use strict';
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const { once } = require('node:events');
const { fixture, document, tick } = require('./client-lifecycle.cjs');
const peer = String.raw`
const fs = require('node:fs');
const mode = process.argv[1];
let buffer = '';
const send = (message) => { const body = JSON.stringify(message);
 process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body); };
process.on('SIGTERM', () => {});
process.stdin.on('data', (chunk) => {
 buffer += chunk;
 for (;;) {
  const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
  const length = Number(/Content-Length: (\d+)/.exec(buffer.slice(0, end))[1]);
  if (Buffer.byteLength(buffer.slice(end + 4)) < length) return;
  const body = buffer.slice(end + 4, end + 4 + length); buffer = buffer.slice(end + 4 + length);
  const message = JSON.parse(body);
  if (message.method === 'initialize' && mode !== 'timeout') setTimeout(() => send({ jsonrpc: '2.0', id: message.id,
   ...(mode === 'error' ? { error: { code: -32603, message: 'test refusal' } } : { result: { capabilities: {} } }) }), 50);
  if (message.method === 'initialized' && mode === 'write-close') {
    process.stdin.pause(); fs.closeSync(0); process.stderr.write('CLOSED\n');
  }
  if (message.method === 'shutdown' && mode !== 'stubborn') send({ jsonrpc: '2.0', id: message.id, result: null });
  if (message.method === 'exit' && mode !== 'stubborn') process.exit(0);
 }
});
setInterval(() => {}, 1000);
`;
const children = [];
function realFixture(mode) {
  const f = fixture(() => {
    const child = mode === 'write-close' ? cp.spawn('python3', ['-u', '-c', String.raw`
import sys, json, os, time
while True:
 header = sys.stdin.buffer.readline()
 if not header: break
 length = int(header.split(b':')[1])
 sys.stdin.buffer.readline()
 message = json.loads(sys.stdin.buffer.read(length))
 if message['method'] == 'initialize':
  body = json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'result': {'capabilities': {}}})
  sys.stdout.write('Content-Length: ' + str(len(body.encode())) + '\r\n\r\n' + body); sys.stdout.flush()
 if message['method'] == 'initialized':
  os.close(0); sys.stderr.write('CLOSED\n'); sys.stderr.flush(); time.sleep(30)
`]) : cp.spawn(process.execPath, ['-e', peer, mode]); children.push(child);
    child.messages = [];
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (frame) => { child.messages.push(JSON.parse(frame.split('\r\n\r\n')[1])); return write(frame); };
    return child;
  }, true);
  return f;
}
async function until(check) {
  const end = Date.now() + 5000;
  while (!check()) { assert(Date.now() < end, 'process observation deadline'); await new Promise((r) => setTimeout(r, 10)); }
}
async function main() {
  {
    const f = realFixture('normal'), c = f.client(), started = c.start(), child = f.children[0];
    c.didOpen(document()); assert.deepEqual(child.messages.map((m) => m.method), ['initialize']);
    await started; c.didOpen(document()); assert.equal(child.messages.at(-1).method, 'textDocument/didOpen');
    const exit = once(child, 'exit'); await c.stop(); await exit;
    assert.equal(child.exitCode, 0);
    console.log('PASS OS delayed initialize and cooperative shutdown exit 0');
  }
  for (const mode of ['error', 'timeout', 'stubborn', 'write-close']) {
    const f = realFixture(mode), c = f.client(), started = c.start(), child = f.children[0];
    const exit = once(child, 'exit');
    if (mode === 'error') await assert.rejects(started, /initialize/);
    if (mode === 'timeout') await assert.rejects(started, /timed out/);
    if (mode === 'stubborn') { await started; const stopped = c.stop(); await stopped; }
    if (mode === 'write-close') {
      const closed = new Promise((resolve) => child.stderr.on('data', (chunk) => { if (String(chunk).includes('CLOSED')) resolve(); }));
      await started; await closed;
      const result = c.request('textDocument/hover', {}); assert.equal(await result, null);
    }
    await exit; assert.equal(child.signalCode, 'SIGKILL');
    console.log(`PASS OS ${mode} cleanup reaches SIGKILL and reaps child`);
  }
  {
    const f = realFixture('normal'), doc = document(); f.vscode.workspace.textDocuments.push(doc);
    f.extension.activate({ subscriptions: [] }); const first = f.children[0];
    await until(() => first.messages.some((m) => m.method === 'textDocument/didOpen'));
    const exit = once(first, 'exit'); first.kill('SIGKILL'); await exit; await tick();
    assert.equal(f.errors.length, 1); doc.version = 2; f.handlers.Open(doc);
    const second = f.children[1]; await until(() => second.messages.some((m) => m.method === 'textDocument/didOpen'));
    assert.equal(second.messages.find((m) => m.method === 'textDocument/didOpen').params.textDocument.text, 'version 2');
    const secondExit = once(second, 'exit'); await f.extension.deactivate(); await secondExit;
    console.log('PASS OS crash reopen uses fresh child and current document text');
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
});
