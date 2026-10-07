import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpRequest, httpRequestBinary, httpStreamText } from '../src/http/client.js';
import type { HttpClientConfig, HttpRequest } from '../src/http/client.js';

const variants: Array<(config: HttpClientConfig, request: HttpRequest) => Promise<unknown>> = [
  httpRequest,
  httpRequestBinary,
  async (config, request) => {
    for await (const _part of httpStreamText(config, request)) { /* consume the whole body */ }
  },
];
const config = { baseUrl: 'https://synthetic.test', timeoutMs: 100, maxBodyBytes: 100 };

test('all readers preserve already-aborted caller reasons', async () => {
  const original = globalThis.fetch;
  try {
    for (const invoke of variants) {
      const caller = new AbortController();
      const reason = new Error('synthetic caller reason');
      caller.abort(reason);
      globalThis.fetch = async (_url, init) => {
        assert.ok(init?.signal?.aborted);
        throw init.signal.reason;
      };
      await assert.rejects(invoke(config, { method: 'GET', path: '/', signal: caller.signal }),
        (error: unknown) => error === reason);
    }
  } finally { globalThis.fetch = original; }
});

test('a caller winner stays cancellation when fetch rejects after the deadline', async () => {
  const original = globalThis.fetch;
  try {
    for (const invoke of variants) {
      const caller = new AbortController();
      const reason = new Error('caller won');
      globalThis.fetch = async (_url, init) => {
        const signal = init?.signal;
        assert.ok(signal);
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => setTimeout(() => reject(signal.reason), 35), { once: true });
          setTimeout(() => caller.abort(reason), 1);
        });
      };
      await assert.rejects(invoke({ ...config, timeoutMs: 15 }, { method: 'GET', path: '/', signal: caller.signal }),
        (error: unknown) => error === reason);
    }
  } finally { globalThis.fetch = original; }
});

test('a deadline winner stays timeout when the caller aborts later', async () => {
  const original = globalThis.fetch;
  try {
    for (const invoke of variants) {
      const caller = new AbortController();
      globalThis.fetch = async (_url, init) => {
        const signal = init?.signal;
        assert.ok(signal);
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => setTimeout(() => {
            caller.abort(new Error('late caller'));
            reject(signal.reason);
          }, 1), { once: true });
        });
      };
      await assert.rejects(invoke({ ...config, timeoutMs: 10 }, { method: 'GET', path: '/', signal: caller.signal }),
        (error: unknown) => error instanceof Error && 'kind' in error && error.kind === 'timeout');
    }
  } finally { globalThis.fetch = original; }
});

test('breaking a text stream cancels its reader and releases the body lock', async () => {
  const original = globalThis.fetch;
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('first chunk')); },
    cancel() { cancelled += 1; },
  });
  try {
    globalThis.fetch = async () => new Response(body);
    for await (const part of httpStreamText(config, { method: 'GET', path: '/' })) {
      assert.equal(part.text, 'first chunk');
      break;
    }
    assert.equal(cancelled, 1);
    assert.equal(body.locked, false);
  } finally { globalThis.fetch = original; }
});
