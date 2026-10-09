import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { readTextBody, sendBody } from '../src/internal/controlled-http.js';
import { startControlledMailServer } from '../src/ports.js';

function request(): EventEmitter & { destroy(): void; destroyedCalls: number } {
  return Object.assign(new EventEmitter(), {
    destroyedCalls: 0,
    destroy() { this.destroyedCalls += 1; },
  });
}

test('controlled body reader keeps chunk assembly, byte ceiling and listener profile', async () => {
  const req = request();
  const body = readTextBody(req as unknown as http.IncomingMessage);
  assert.deepEqual(['data', 'end', 'error'].map(name => req.listenerCount(name)), [1, 1, 1]);
  req.emit('data', Buffer.from([0xC3]));
  req.emit('data', Buffer.from([0xA9]));
  req.emit('end');
  assert.equal(await body, 'é');
  assert.equal(req.destroyedCalls, 0);
  assert.deepEqual(['data', 'end', 'error'].map(name => req.listenerCount(name)), [1, 1, 1]);
  const exact = request();
  const allowed = readTextBody(exact as unknown as http.IncomingMessage);
  exact.emit('data', Buffer.alloc(4_000_000, 0x61));
  exact.emit('end');
  assert.equal((await allowed).length, 4_000_000);
  assert.equal(exact.destroyedCalls, 0);
});

test('controlled body reader preserves oversize destruction and error identity', async () => {
  const large = request();
  const body = readTextBody(large as unknown as http.IncomingMessage);
  large.emit('data', Buffer.alloc(4_000_001));
  assert.equal(large.destroyedCalls, 1);
  await assert.rejects(body, { name: 'Error', message: 'harness body too large' });
  const broken = request();
  const failed = readTextBody(broken as unknown as http.IncomingMessage);
  const marker = new Error('transport marker');
  broken.emit('error', marker);
  await assert.rejects(failed, (error: unknown) => error === marker);
  assert.equal(broken.destroyedCalls, 0);
});

test('controlled response writer preserves raw string/JSON bytes and before-write faults', () => {
  const calls: unknown[] = [];
  const res = { writeHead(status: number, headers: unknown) { calls.push([status, headers]); }, end(text: unknown) { calls.push(text); } } as unknown as http.ServerResponse;
  sendBody(res, 201, 'é');
  assert.deepEqual(calls, [[201, { 'content-type': 'text/plain; charset=utf-8', 'content-length': 2 }], 'é']);
  calls.length = 0;
  const marker = new Error('serialization marker');
  const value = { get bad() { throw marker; } };
  assert.throws(() => sendBody(res, 200, value), (error: unknown) => error === marker);
  assert.deepEqual(calls, []);
  assert.throws(() => sendBody(res, 200, undefined), TypeError);
  assert.deepEqual(calls, []);
  sendBody(res, 202, { n: -0, missing: undefined });
  assert.deepEqual(calls, [[202, { 'content-type': 'application/json', 'content-length': 7 }], '{"n":0}']);
});

test('mail drip preserves successful status and body', async () => {
  const server = await startControlledMailServer({ kind: 'drip', delayMs: 1 });
  try {
    const response = await fetch(`${server.url}/send`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(await response.text(), '{"reference":"mail_drip"}');
  } finally {
    await server.close();
  }
});

test('mail drip releases acquired timers on peer teardown and server close', async (t) => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let scheduled: (() => void) | undefined;
  let released: (() => void) | undefined;
  t.mock.method(globalThis, 'setTimeout', (...args: Parameters<typeof setTimeout>) => {
    const timer = originalSetTimeout(...args);
    if (args[1] === 60_000) {
      timers.add(timer);
      scheduled?.();
    }
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', (timer: Parameters<typeof clearTimeout>[0]) => {
    originalClearTimeout(timer);
    if (timers.delete(timer as ReturnType<typeof setTimeout>)) released?.();
  });
  const server = await startControlledMailServer({ kind: 'drip', delayMs: 60_000 });
  const clients: http.ClientRequest[] = [];
  const request = async (): Promise<http.ClientRequest> => {
    const acquired = new Promise<void>((resolve) => { scheduled = resolve; });
    const client = http.request(`${server.url}/send`, { method: 'POST' });
    client.on('error', () => {});
    clients.push(client);
    client.end('{}');
    await acquired;
    scheduled = undefined;
    return client;
  };
  try {
    const disconnected = await request();
    assert.equal(timers.size, 1);
    const teardown = new Promise<void>((resolve) => { released = resolve; });
    disconnected.destroy();
    await teardown;
    released = undefined;
    assert.equal(timers.size, 0);
    await request();
    await request();
    assert.equal(timers.size, 2);
    await server.close();
    assert.equal(timers.size, 0);
  } finally {
    for (const client of clients) client.destroy();
    await server.close();
    for (const timer of timers) originalClearTimeout(timer);
  }
});
