import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { readTextBody, sendBody } from '../src/internal/controlled-http.js';

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
