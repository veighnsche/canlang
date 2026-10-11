/** Direct emitted State module in Node/workerd; no Can artifact or Office qualification. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import { loadReceiptObserver, receiptObserverModuleUrl } from '../../src/receipt/observer-loader.js';

test('Node loader defers the exact missing observer and preserves resolver identity', async () => {
  assert.equal(receiptObserverModuleUrl, './observer.js');
  await assert.rejects(loadReceiptObserver(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as NodeJS.ErrnoException).code, 'ERR_MODULE_NOT_FOUND');
    assert.match(error.message, /^Cannot find module '[^']*\/receipt\/observer\.js'/);
    return true;
  });
});

test('workerd imports the emitted loader with a relative module identity and requests the actual observer lazily', async () => {
  const loader = await readFile(new URL('../../src/receipt/observer-loader.js', import.meta.url), 'utf8');
  const worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: [
    { type: 'ESModule', path: 'entry.js', contents: `
      import { loadReceiptObserver, receiptObserverModuleUrl } from './receipt/observer-loader.js';
      export default { async fetch(request) {
        if (new URL(request.url).pathname === '/observer') {
          try { const loaded = await loadReceiptObserver(); return Response.json({ value: loaded.identity }); }
          catch (error) { return Response.json({ error: error.message }, { status: 500 }); }
        }
        return Response.json({ specifier: receiptObserverModuleUrl });
      } };
    ` },
    { type: 'ESModule', path: 'receipt/observer-loader.js', contents: loader },
    { type: 'ESModule', path: 'receipt/observer.js', contents: 'export const identity = "actual-observer-module";' },
  ] });
  try {
    const startup = await worker.dispatchFetch('https://state.test/');
    assert.equal(startup.status, 200); assert.deepEqual(await startup.json(), { specifier: './observer.js' });
    const loaded = await worker.dispatchFetch('https://state.test/observer');
    assert.equal(loaded.status, 200); assert.deepEqual(await loaded.json(), { value: 'actual-observer-module' });
  } finally { await worker.dispose(); }
});

test('workerd loader propagates present observer initialization and nested dependency failures', async () => {
  const loader = await readFile(new URL('../../src/receipt/observer-loader.js', import.meta.url), 'utf8');
  for (const observer of ['throw new Error("present observer initialization failed");',
    'import "./missing-dependency.js"; export const identity = "unreachable";']) {
    const worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: [
      { type: 'ESModule', path: 'entry.js', contents: `
        import { loadReceiptObserver } from './receipt/observer-loader.js';
        export default { async fetch() {
          try { await loadReceiptObserver(); return new Response('unexpected observer success'); }
          catch (error) { return new Response(error.message, { status: 500 }); }
        } };
      ` },
      { type: 'ESModule', path: 'receipt/observer-loader.js', contents: loader },
      { type: 'ESModule', path: 'receipt/observer.js', contents: observer },
    ] });
    try {
      const response = await worker.dispatchFetch('https://state.test/');
      assert.equal(response.status, 500);
      assert.match(await response.text(), observer.startsWith('throw') ? /present observer initialization failed/ : /missing-dependency/);
    } finally { await worker.dispose(); }
  }
});
