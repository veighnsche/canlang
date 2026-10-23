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
let buffer = '', pipeline = [];
const frame = message => { const body=Buffer.from(JSON.stringify(message)); return Buffer.concat([Buffer.from('Content-Length: '+body.length+'\r\n\r\n'),body]); };
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
  if (message.method === 'initialize' && mode === 'init-malformed') { process.stdout.write('Content-Length: 12x\r\n\r\n'); continue; }
  if (message.method === 'initialize' && mode !== 'timeout') setTimeout(() => send({ jsonrpc: '2.0', id: message.id,
   ...(mode === 'error' ? { error: { code: -32603, message: 'test refusal' } } : { result: { capabilities: {} } }) }), 50);
  if (message.method === 'initialized' && mode === 'write-close') {
    process.stdin.pause(); fs.closeSync(0); process.stderr.write('CLOSED\n');
  }
  if (message.method === 'fixture/framing') {
    const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:message.id,result:'λ🙂é'}));
    const tail=frame({jsonrpc:'2.0',id:message.id,result:'must-not-dispatch'});
    let header='Content-Length: '+body.length+'\r\n\r\n', payload=body;
    if(mode==='unicode-split') {
      const bytes=frame({jsonrpc:'2.0',id:message.id,result:'λ🙂é'});let at=0;
      const next=()=>{if(at<bytes.length){process.stdout.write(bytes.subarray(at,++at));setTimeout(next,1);}};next();
    }else if(mode==='header-at-limit') {
      const prefix='cOnTeNt-LeNgTh:\t'+body.length+'\t\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\nX-Fill: ';
      const header=prefix+'a'.repeat(65536-Buffer.byteLength(prefix)-4)+'\r\n\r\n';
      process.stdout.write(Buffer.concat([Buffer.from(header),body]));
    }else if(mode==='malformed-bodies') {
      process.stdout.write(Buffer.concat([Buffer.from('Content-Length: 1\r\n\r\n\xff','latin1'),
        Buffer.from('Content-Length: 1\r\n\r\n{'),frame(null),frame([]),frame(7),frame({jsonrpc:'2.0',id:message.id,result:'λ🙂é'})]));
    }else if(mode==='equal-duplicate') {
      process.stdout.write(Buffer.concat([Buffer.from('Content-Length: '+body.length+'\r\nContent-Length: '+body.length+'\r\n\r\n'),body]));
    }else {
      if(mode==='missing-length')header='Content-Type: application/vscode-jsonrpc\r\n\r\n';
      if(mode==='prefixed-name')header='X-Content-Length: '+body.length+'\r\n\r\n';
      if(mode==='wrong-name')header='ContentLength: '+body.length+'\r\n\r\n';
      if(mode==='duplicate-conflict')header='Content-Length: '+body.length+'\r\nContent-Length: '+(body.length+1)+'\r\n\r\n';
      if(mode.startsWith('number:'))header='Content-Length: '+mode.slice(7)+'\r\n\r\n';
      if(mode==='header-complete-limit')header='Content-Length: '+body.length+'\r\nX-Fill: '+'a'.repeat(65536)+'\r\n\r\n';
      if(mode==='header-partial-limit') {header='Content-Length: '+body.length+'\r\nX-Fill: '+'a'.repeat(65536);payload=Buffer.alloc(0);}
      if(mode==='body-limit') {header='Content-Length: 67108865\r\n\r\n';payload=Buffer.alloc(0);}
      if(mode==='utf8-boundary')header='Content-Length: '+(body.indexOf(Buffer.from('🙂'))+1)+'\r\n\r\n';
      const partial=mode==='header-partial-limit'||mode==='body-limit';
      process.stdout.write(Buffer.concat([Buffer.from(header),payload,...(partial?[]:[tail])]));
    }
  }
  if (message.method === 'fixture/pipeline') {
    pipeline.push(message.id);
    if(pipeline.length===2)process.stdout.write(Buffer.concat(pipeline.map((id,index)=>frame({jsonrpc:'2.0',id,result:['first λ🙂','second 日本語'][index]}))));
  }
  if (message.method === 'shutdown' && mode === 'stop-malformed') { process.stdout.write('Content-Length: 12x\r\n\r\n'); continue; }
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
async function framingProcesses() {
  const malformed = ['missing-length', 'prefixed-name', 'wrong-name', 'duplicate-conflict',
    ...['12x', '+12', '-1', '1e2', '1.5', '', '0x20', '9007199254740992'].map(number => `number:${number}`),
    'header-partial-limit', 'header-complete-limit', 'body-limit', 'utf8-boundary'];
  for (const mode of malformed) {
    const f = realFixture(mode), c = f.client(), started = c.start(), child = f.children[0];
    await started;
    const doc = document(); c.didOpen(doc);
    assert.equal(c.isDocumentVersion(doc.uri.toString(), null), true);
    let exits = 0; c.onExit = () => { exits++; };
    const exited = once(child, 'exit'), began = Date.now();
    const result = c.request('fixture/framing', {});
    let settled = false; result.then(() => { settled = true; });
    await until(() => settled);
    assert.equal(await result, null, `${mode}: malformed framing cannot recover a pipelined result`);
    assert(Date.now() - began < 5000, `${mode}: pending work settles before the 10-second request timeout`);
    await exited; await tick();
    assert.equal(child.signalCode, 'SIGKILL', `${mode}: actual peer is reaped`);
    assert.equal(c.isDocumentVersion(doc.uri.toString(), null), false);
    assert.equal(c.pending.size, 0); assert.equal(c.buffer, '', `${mode}: no retained framing tail`);
    assert.equal(f.disposals, 1); assert.equal(exits, 1);
    const sent = child.messages.length;
    await assert.rejects(c.request('fixture/late', {}), /not ready/);
    assert.equal(child.messages.length, sent, 'retired peer receives no later request');
    await c.stop(); assert.equal(f.disposals, 1); assert.equal(exits, 1);
    console.log(`PASS OS malformed ${mode} closes framing, settles work and reaps peer once`);
  }
  for (const mode of ['unicode-split', 'equal-duplicate', 'header-at-limit', 'malformed-bodies']) {
    const f = realFixture(mode), c = f.client(), started = c.start(), child = f.children[0];
    await started;
    let byteChunks = 0;
    child.stdout.on('data', chunk => { if (chunk.length === 1) byteChunks++; });
    assert.equal(await c.request('fixture/framing', {}), 'λ🙂é');
    if (mode === 'unicode-split') assert(byteChunks > 0, 'the real pipe delivers split byte chunks');
    const replies = await Promise.all([c.request('fixture/pipeline', {}), c.request('fixture/pipeline', {})]);
    assert.deepEqual(replies, ['first λ🙂', 'second 日本語']);
    assert.equal(c.buffer, '');
    const exited = once(child, 'exit'); await c.stop(); await exited;
    assert.equal(child.exitCode, 0); assert.equal(f.disposals, 1);
    console.log(`PASS OS valid ${mode} and pipelined Unicode replies`);
  }
}
async function main() {
  await framingProcesses();
  for (const mode of ['init-malformed', 'stop-malformed']) {
    const f = realFixture(mode), c = f.client(), started = c.start(), child = f.children[0];
    const exited = once(child, 'exit'); let exits = 0; c.onExit = () => { exits++; };
    if (mode === 'init-malformed') await assert.rejects(started, /initialize failed/);
    else { await started; c.didOpen(document()); await c.stop(); }
    await exited;
    assert.equal(child.signalCode, 'SIGKILL'); assert.equal(exits, 0);
    assert.equal(c.pending.size, 0); assert.equal(c.documents.size, 0);
    assert.equal(c.buffer, ''); assert.equal(c.serverCapabilities(), null);
    assert.equal(f.disposals, 1);
    console.log(`PASS OS ${mode} retires captured child and initialization/shutdown work`);
  }
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
