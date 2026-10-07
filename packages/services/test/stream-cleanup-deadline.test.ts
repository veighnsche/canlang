import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpStreamText } from '../src/http/client.js';
import { OllamaChatAdapter } from '../src/models/ollama.js';

const config = { baseUrl: 'http://local.invalid', timeoutMs: 20, maxBodyBytes: 4096 };
const encode = (text: string) => new TextEncoder().encode(text);
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('cleanup exceeded test bound')), 150);
      }),
    ]);
  } finally { clearTimeout(timer!); }
}

function fixture(chunks: Uint8Array[], options: {
  close?: boolean;
  cancel?: () => Promise<void> | void;
  readFailure?: { value: unknown };
  releaseFailure?: unknown;
} = {}) {
  const events: string[] = [];
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      for (const chunk of chunks) value.enqueue(chunk);
      if (options.close) value.close();
    },
    cancel() { events.push('underlying.cancel'); return options.cancel?.(); },
  }, { highWaterMark: 0 });
  const getReader = body.getReader.bind(body);
  body.getReader = (() => {
    const reader = getReader();
    const cancel = reader.cancel.bind(reader), release = reader.releaseLock.bind(reader);
    reader.cancel = (reason?: unknown) => { events.push('reader.cancel'); return cancel(reason); };
    reader.releaseLock = () => {
      events.push('release');
      if ('releaseFailure' in options) throw options.releaseFailure;
      release();
    };
    if (options.readFailure) reader.read = () => Promise.reject(options.readFailure!.value);
    return reader;
  }) as typeof body.getReader;
  return { body, controller, events };
}

async function withFetch<T>(body: ReadableStream<Uint8Array>, run: () => Promise<T>) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(body);
  try { return await run(); } finally { globalThis.fetch = original; }
}

const input = { model: 'm', messages: [{ role: 'user' as const, content: 'hello' }], maxTokens: 1 };
const final = JSON.stringify({ done: true, model: 'm', done_reason: 'stop', message: { content: 'done' } });
const adapter = () => new OllamaChatAdapter({ ...config, models: ['m'], maxOutputTokens: 2 });

for (const exit of ['early-return', 'byte-cap', 'model-final'] as const) {
  test(`${exit} releases after the existing deadline when cancellation never settles`, async () => {
    const f = fixture([encode(exit === 'model-final' ? `${final}\n` : 'body')], {
      cancel: () => new Promise<void>(() => {}),
    });
    await withFetch(f.body, async () => {
      if (exit === 'model-final') {
        const run = adapter().generateStream(input, { deliveryId: 'final' });
        const result = await bounded(run.done());
        assert.equal(result.status, 'succeeded');
        assert.equal(run.snapshots().at(-1)?.state, 'succeeded');
      } else {
        const iterator = httpStreamText({ ...config, maxBodyBytes: exit === 'byte-cap' ? 1 : 4096 }, { method: 'GET', path: '/' });
        if (exit === 'early-return') {
          await iterator.next();
          assert.equal((await bounded(iterator.return({ status: 200, url: 'return' }))).done, true);
        } else {
          await assert.rejects(bounded(iterator.next()), { name: 'HttpBodyLimitError' });
        }
      }
    });
    assert.equal(f.events.filter((event) => event === 'underlying.cancel').length, 1);
    assert.equal(f.events.filter((event) => event === 'release').length, 1);
  });
}

for (const reason of [new Error('original read'), undefined, Symbol('original read')]) {
  test(`caller read rejection retains ${typeof reason} identity despite pending cleanup`, async () => {
    const caller = new AbortController(); caller.abort();
    const f = fixture([], { readFailure: { value: reason }, cancel: () => new Promise<void>(() => {}) });
    await withFetch(f.body, async () => {
      const result = await bounded(httpStreamText(config, { method: 'GET', path: '/', signal: caller.signal }).next()
        .then(() => ({ rejected: false, value: null as unknown }), (value: unknown) => ({ rejected: true, value })));
      assert.equal(result.rejected, true);
      assert.equal(result.value, reason);
    });
    assert.equal(f.events.at(-1), 'release');
  });
}

test('early return still waits for cancellation while the signal is live', async () => {
  let finish!: () => void;
  const cancellation = new Promise<void>((resolve) => { finish = resolve; });
  const f = fixture([encode('first')], { cancel: () => cancellation });
  await withFetch(f.body, async () => {
    const iterator = httpStreamText({ ...config, timeoutMs: 500 }, { method: 'GET', path: '/' });
    await iterator.next();
    let returned = false;
    const result = iterator.return({ status: 200, url: '/' }).then(() => { returned = true; });
    await wait(5);
    assert.equal(returned, false); assert.equal(f.events.includes('release'), false);
    finish(); await bounded(result);
  });
  assert.equal(f.events.at(-1), 'release');
});

test('normal fragmented UTF8 exhaustion does not cancel', async () => {
  const bytes = encode('A😀Z'), f = fixture([bytes.slice(0, 3), bytes.slice(3)], { close: true });
  await withFetch(f.body, async () => {
    let text = '';
    for await (const segment of httpStreamText(config, { method: 'GET', path: '/' })) text += segment.text;
    assert.equal(text, 'A😀Z');
  });
  assert.deepEqual(f.events, ['release']);
});

test('model final at EOF keeps normal completion and no cancellation', async () => {
  const f = fixture([encode(final)], { close: true });
  await withFetch(f.body, async () => {
    assert.equal((await adapter().generateStream(input, { deliveryId: 'eof' }).done()).status, 'succeeded');
  });
  assert.deepEqual(f.events, ['release']);
});

for (const mode of ['return', 'cap', 'read'] as const) {
  test(`${mode} preserves its first outcome when cancellation rejects and release throws`, async () => {
    const cleanup = new Error('cleanup'), primary = new Error('read');
    const caller = new AbortController();
    if (mode === 'read') caller.abort();
    const f = fixture(mode === 'read' ? [] : [encode('body')], {
      cancel: () => Promise.reject(cleanup), releaseFailure: cleanup,
      ...(mode === 'read' ? { readFailure: { value: primary } } : {}),
    });
    await withFetch(f.body, async () => {
      const iterator = httpStreamText({ ...config, maxBodyBytes: mode === 'cap' ? 1 : 4096 }, { method: 'GET', path: '/', signal: caller.signal });
      if (mode === 'return') { await iterator.next(); await bounded(iterator.return({ status: 200, url: '/' })); }
      else await assert.rejects(bounded(iterator.next()), mode === 'cap' ? { name: 'HttpBodyLimitError' } : (error: unknown) => error === primary);
    });
    assert.equal(f.events.filter((event) => event === 'release').length, 1);
  });
}

for (const finishBy of ['settlement', 'caller-abort'] as const) {
  test(`cleanup removes its temporary abort listener once after ${finishBy}`, async () => {
    let finish!: () => void;
    const cancellation = new Promise<void>((resolve) => { finish = resolve; });
    const f = fixture([encode('first')], { cancel: () => cancellation });
    const caller = new AbortController(), original = globalThis.fetch;
    let added = 0, removed = 0;
    globalThis.fetch = async (_url, init) => {
      const signal = init!.signal!;
      const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
      signal.addEventListener = (...args: Parameters<typeof add>) => { if (args[0] === 'abort') added++; add(...args); };
      signal.removeEventListener = (...args: Parameters<typeof remove>) => { if (args[0] === 'abort') removed++; remove(...args); };
      return new Response(f.body);
    };
    try {
      const iterator = httpStreamText({ ...config, timeoutMs: 500 }, { method: 'GET', path: '/', signal: caller.signal });
      await iterator.next();
      const returning = iterator.return({ status: 200, url: '/' });
      await wait(5);
      if (finishBy === 'settlement') finish(); else caller.abort(Symbol('caller'));
      await bounded(returning);
      assert.equal(added, 1); assert.equal(removed, 1);
      assert.equal(f.events.filter((event) => event === 'release').length, 1);
    } finally { finish(); globalThis.fetch = original; }
  });
}
