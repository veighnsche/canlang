import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpRequest, httpRequestBinary, httpStreamText } from '../src/http/client.js';
import type { HttpClientConfig, HttpRequest } from '../src/http/client.js';
import { HttpBodyLimitError } from '../src/http/errors.js';

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

test('every reader bounds redirect bodies before sending the next hop', async () => {
  const original=globalThis.fetch;
  try {
    for(const invoke of variants){
      let calls=0;let cancelled=0;
      let pulls=0;
      const body=new ReadableStream<Uint8Array>({pull(c){c.enqueue(new Uint8Array(9));if(++pulls===2)c.close();},cancel(){cancelled++;}});
      globalThis.fetch=async()=>{calls++;return calls===1?new Response(body,{status:302,headers:{location:'/next'}}):new Response('ok');};
      await assert.rejects(invoke({...config,maxBodyBytes:8},{method:'GET',path:'/'}), error=>error instanceof Error && error.name==='HttpBodyLimitError');
      assert.equal(calls,1);assert.equal(cancelled,1);assert.equal(body.locked,false);
    }
  } finally {globalThis.fetch=original;}
});

test('a redirect without Location keeps its unread status body', async () => {
  const original=globalThis.fetch;
  try {
    for(const invoke of variants){
      globalThis.fetch=async()=>new Response('body',{status:302});
      await assert.rejects(invoke(config,{method:'GET',path:'/'}), error=>error instanceof Error && error.name==='HttpStatusError' && 'status' in error && error.status===302);
    }
  } finally {globalThis.fetch=original;}
});

test('body quota detection bounds held cancellation without relabeling the original refusal', async () => {
  const original = globalThis.fetch;
  try {
    for (const invoke of variants) {
      for (const status of [200, 302, 500]) {
        for (const trigger of ['deadline', 'caller']) {
          const caller = new AbortController();
          let releaseCancel!: () => void, startedCancel!: () => void, observedAbort!: () => void;
          const held = new Promise<void>(resolve => { releaseCancel = resolve; });
          const started = new Promise<void>(resolve => { startedCancel = resolve; });
          const aborted = new Promise<void>(resolve => { observedAbort = resolve; });
          let calls = 0, cancellations = 0;
          let cleanupFinished = false, completed = false;
          const body = new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new Uint8Array(9)); },
            cancel() {
              cancellations++;
              startedCancel();
              return held.then(() => { cleanupFinished = true; });
            },
          });
          globalThis.fetch = async (_url, init) => {
            calls++;
            assert.ok(init?.signal);
            init.signal.addEventListener('abort', observedAbort, { once: true });
            return new Response(body, { status, ...(status === 302 ? { headers: { location: '/next' } } : {}) });
          };
          const outcome = invoke({ ...config, timeoutMs: trigger === 'deadline' ? 5 : 1000, maxBodyBytes: 8 },
            { method: 'GET', path: '/', signal: caller.signal }).then(
              value => { completed = true; return value; },
              error => { completed = true; return error as unknown; },
            );
          try {
            await started;
            if (trigger === 'caller') caller.abort(new Error('caller cancelled cleanup wait'));
            await aborted;
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(completed, true, `${status}/${trigger}: request must stop waiting after abort`);
            const error = await outcome;
            assert.ok(error instanceof HttpBodyLimitError);
            assert.equal(error.status, status);
            assert.equal(error.maxBytes, 8);
            assert.equal(calls, 1, 'a rejected redirect body never sends the next hop');
            assert.equal(cancellations, 1);
            assert.equal(body.locked, false);
            assert.equal(cleanupFinished, false, 'return does not claim physical cleanup completed');
          } finally {
            releaseCancel();
            await outcome;
          }
        }
      }
    }
  } finally { globalThis.fetch = original; }
});
