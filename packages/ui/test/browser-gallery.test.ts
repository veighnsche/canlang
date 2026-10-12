/** Structural DOM/transport controls, not native decoder or provider authority qualification. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { startBrowserClient, startNativeBrowserClient } from '../src/browser/bootstrap.js';
import type { BrowserClient, BrowserClientOptions } from '../src/browser/bootstrap.js';
import { bindGallery } from '../src/browser/gallery.js';
import type { ClientInternals, ElementLike } from '../src/browser/bootstrap.js';
import type { ImageFetch, ImageFetchInit, ImageResponse } from '../src/browser/gallery.js';

const markup = `<section data-can-gallery data-can-gallery-loading="Loading preview" data-can-gallery-error="Preview unavailable">
<button data-can-gallery-preview data-can-preview-url="/mount/preview/one" data-can-original-url="/mount/original/one" aria-label="Preview one"><img data-can-gallery-thumb alt="Owning row preview"><span data-can-gallery-thumb-state role="status"></span></button>
<button data-can-gallery-preview data-can-preview-url="/mount/preview/two" data-can-original-url="/mount/original/two" aria-label="Preview two"><img data-can-gallery-thumb alt="Owning row preview"><span data-can-gallery-thumb-state role="status"></span></button>
<a data-can-gallery-original href="/mount/original/one">Original</a>
<dialog data-can-gallery-dialog><button data-can-gallery-close>Close</button><p data-can-gallery-state role="status" aria-live="polite"></p><img data-can-gallery-image hidden><a data-can-gallery-preview-original hidden>Download original</a></dialog></section>`;
const response = (status = 200, type = 'image/png', redirected = false): ImageResponse => ({
  status, redirected, headers: { get: () => type }, blob: async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type }),
});
async function settle() { for (let index = 0; index < 16; index++) await Promise.resolve(); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
function world(fetch: ImageFetch, native = false) {
  const window = new Window({ url: 'https://can.test/mount/page?team=current' });
  window.document.body.innerHTML = markup;
  const root = window.document.querySelector('[data-can-gallery]')!;
  const dialog = window.document.querySelector('dialog')!;
  const image = window.document.querySelector('[data-can-gallery-image]')!;
  const state = window.document.querySelector('[data-can-gallery-state]')!;
  const original = window.document.querySelector('[data-can-gallery-preview-original]')!;
  const buttons = [...window.document.querySelectorAll<typeof window.HTMLButtonElement.prototype>('button[data-can-gallery-preview]')];
  const closer = window.document.querySelector<typeof window.HTMLButtonElement.prototype>('[data-can-gallery-close]')!;
  let decodes = 0, modals = 0;
  let decode: () => Promise<void> = async () => {};
  Object.defineProperty(image, 'decode', { configurable: true, value: async () => { decodes++; await decode(); } });
  for (const thumb of root.querySelectorAll('[data-can-gallery-thumb]')) {
    Object.defineProperty(thumb, 'complete', { configurable: true, value: false });
    Object.defineProperty(thumb, 'decode', { configurable: true, value: async () => {} });
  }
  Object.defineProperty(dialog, 'showModal', { configurable: true, value: () => { modals++; dialog.setAttribute('open', ''); } });
  Object.defineProperty(dialog, 'close', { configurable: true, value: () => {
    dialog.removeAttribute('open'); dialog.dispatchEvent(new window.Event('close'));
  } });
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  const created: string[] = [], revoked: string[] = [];
  URL.createObjectURL = blob => { const url = create(blob); created.push(url); return url; };
  URL.revokeObjectURL = url => { revoked.push(url); revoke(url); };
  let client: BrowserClient;
  if (native) {
    Object.defineProperty(window, 'fetch', { configurable: true, value: async (url: string, init: ImageFetchInit) => {
      const result = await fetch(url, init); return { ...result, text: async () => { throw new Error('private bodies must not be read'); } };
    } });
    client = startNativeBrowserClient(window as unknown as Parameters<typeof startNativeBrowserClient>[0]);
  } else client = startBrowserClient({ window: window as unknown as BrowserClientOptions['window'], imageFetch: fetch,
    fetchImpl: async () => { throw new Error('gallery must not use POST transport'); } });
  return { window, root, dialog, image, state, original, buttons, closer, client, created, revoked,
    get decodes() { return decodes; }, get modals() { return modals; }, setDecode: (value: () => Promise<void>) => { decode = value; },
    async close() { try { client.stop(); } finally { URL.createObjectURL = create; URL.revokeObjectURL = revoke; await window.happyDOM.close(); } },
  };
}

test('gallery native adapter freshly fetches every activation and decodes thumbnails and modal with protected GET options', async () => {
  const requests: Array<{ url: string; init: ImageFetchInit }> = [];
  const t = world(async (url, init) => { requests.push({ url, init }); return response(); }, true);
  try {
    const thumb = t.buttons[0]!.querySelector('[data-can-gallery-thumb]')!;
    const thumbState = t.buttons[0]!.querySelector('[data-can-gallery-thumb-state]')!;
    assert.equal(requests.length, 0); assert.equal(thumbState.textContent, 'Loading preview');
    thumb.dispatchEvent(new t.window.Event('load')); await settle(); assert.equal(thumbState.textContent, '');
    thumb.dispatchEvent(new t.window.Event('error')); assert.equal(thumbState.textContent, 'Preview unavailable');
    t.buttons[0]!.click(); await settle();
    assert.equal(t.dialog.open, true); assert.equal(t.window.document.activeElement, t.closer);
    assert.equal(t.image.hasAttribute('hidden'), false); assert.equal(t.state.textContent, '');
    assert.equal(t.image.getAttribute('alt'), 'Owning row preview');
    assert.equal(t.original.getAttribute('href'), 'https://can.test/mount/original/one');
    assert.equal(t.original.hasAttribute('hidden'), false);
    t.closer.click(); assert.equal(t.image.getAttribute('alt'), ''); assert.equal(t.dialog.open, false); assert.equal(t.window.document.activeElement, t.buttons[0]);
    t.buttons[0]!.click(); await settle();
    assert.equal(requests.length, 2); assert.equal(t.decodes, 2); assert.equal(t.modals, 2);
    for (const { url, init } of requests) {
      assert.equal(url, 'https://can.test/mount/preview/one');
      assert.equal(init.method, 'GET'); assert.equal(init.cache, 'no-store'); assert.equal(init.credentials, 'same-origin');
      assert.equal(init.mode, 'same-origin'); assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal);
    }
    const escape = new t.window.Event('cancel', { cancelable: true });
    t.dialog.dispatchEvent(escape); assert.equal(escape.defaultPrevented, true); assert.equal(t.dialog.open, false);
    assert.equal(t.window.document.activeElement, t.buttons[0]);
    assert.deepEqual(t.revoked, t.created);
    assert.equal(t.root.querySelector('[data-can-gallery-original]')!.getAttribute('href'), '/mount/original/one');
  } finally { await t.close(); }
});

test('gallery refuses foreign URL auth media redirect and decoder failures without reading or displaying private details', async () => {
  let calls = 0, blobs = 0;
  let result = response();
  const t = world(async () => { calls++; return { ...result, blob: async () => { blobs++; return result.blob(); } }; });
  try {
    for (const url of ['https://foreign.test/private', 'https://user:password@can.test/private', '/private#fragment', 'javascript:alert(1)', '//can.test/private', '/mount\\private', '/mount/private name', '/mount/private\nname']) {
      t.buttons[0]!.setAttribute('data-can-preview-url', url); t.buttons[0]!.click(); await settle();
      assert.equal(calls, 0); assert.equal(t.state.textContent, 'Preview unavailable');
      assert.equal(t.image.hasAttribute('hidden'), true); assert.equal(t.original.hasAttribute('hidden'), true);
    }
    t.buttons[0]!.setAttribute('data-can-preview-url', '/mount/preview/one');
    t.buttons[0]!.setAttribute('data-can-original-url', 'https://foreign.test/original');
    t.buttons[0]!.click(); await settle(); assert.equal(calls, 0);
    t.buttons[0]!.setAttribute('data-can-original-url', '/mount/original/one');
    for (const value of [response(403), response(200, 'text/html'), response(200, 'image/png', true)]) {
      result = value; t.buttons[0]!.click(); await settle();
      assert.equal(t.state.textContent, 'Preview unavailable'); assert.equal(t.image.hasAttribute('hidden'), true);
    }
    assert.equal(blobs, 0);
    result = response(200, 'image/jpeg');
    t.setDecode(async () => { throw new Error('PRIVATE decoder detail'); });
    t.buttons[0]!.click(); await settle();
    assert.equal(blobs, 1); assert.equal(t.state.textContent, 'Preview unavailable');
    assert.ok(!t.root.innerHTML.includes('PRIVATE')); assert.deepEqual(t.revoked, t.created);
    assert.equal(t.original.hasAttribute('hidden'), true);
  } finally { await t.close(); }
});

test('gallery ignores late fetch blob and decode results after new activation close stop or disconnection', async () => {
  const first = deferred<ImageResponse>(); const requests: ImageFetchInit[] = [];
  const t = world(async (_url, init) => { requests.push(init); return requests.length === 1 ? first.promise : response(); });
  try {
    t.buttons[0]!.click(); t.buttons[1]!.click(); await settle();
    assert.equal(requests[0]!.signal.aborted, true); assert.equal(t.original.getAttribute('href'), 'https://can.test/mount/original/two');
    first.resolve(response()); await settle(); assert.equal(t.created.length, 1);
    const decoding = deferred<void>(); t.setDecode(() => decoding.promise);
    t.buttons[0]!.click(); await settle(); const latest = t.created.at(-1)!;
    assert.equal(t.image.hasAttribute('hidden'), true); t.closer.click();
    assert.ok(t.revoked.includes(latest)); assert.equal(requests.at(-1)!.signal.aborted, true);
    decoding.resolve(); await settle(); assert.equal(t.image.hasAttribute('hidden'), true);
    assert.equal(t.original.hasAttribute('hidden'), true);
  } finally { await t.close(); }
  const retargetedFetch = deferred<ImageResponse>();
  let retargetedSignal: AbortSignal | undefined;
  const retargeted = world(async (_url, init) => { retargetedSignal = init.signal; return retargetedFetch.promise; });
  try {
    retargeted.buttons[0]!.click();
    retargeted.buttons[0]!.setAttribute('data-can-preview-url', '/mount/preview/changed');
    retargeted.buttons[0]!.setAttribute('data-can-original-url', '/mount/original/changed');
    retargetedFetch.resolve(response()); await settle();
    assert.equal(retargetedSignal!.aborted, true); assert.equal(retargeted.created.length, 0);
    assert.equal(retargeted.image.hasAttribute('hidden'), true); assert.equal(retargeted.image.getAttribute('alt'), '');
    assert.equal(retargeted.original.hasAttribute('hidden'), true);
  } finally { await retargeted.close(); }
  const retargetedDecode = deferred<void>();
  const changed = world(async () => response()); changed.setDecode(() => retargetedDecode.promise);
  try {
    changed.buttons[0]!.click(); await settle(); assert.equal(changed.created.length, 1);
    changed.buttons[0]!.setAttribute('data-can-preview-url', '/mount/preview/replaced');
    retargetedDecode.resolve(); await settle();
    assert.deepEqual(changed.revoked, changed.created); assert.equal(changed.image.hasAttribute('hidden'), true);
    assert.equal(changed.original.hasAttribute('hidden'), true); assert.equal(changed.image.getAttribute('alt'), '');
  } finally { await changed.close(); }
  for (const change of ['moved-button', 'new-state', 'new-original'] as const) {
    const pending = deferred<ImageResponse>();
    const scope = world(async () => pending.promise);
    try {
      scope.buttons[0]!.click();
      if (change === 'moved-button') scope.window.document.body.append(scope.buttons[0]!);
      else {
        const outlet = change === 'new-state' ? scope.state : scope.original;
        outlet.replaceWith(outlet.cloneNode(true));
      }
      pending.resolve(response()); await settle();
      assert.equal(scope.created.length, 0); assert.equal(scope.image.hasAttribute('hidden'), true);
      assert.equal(scope.original.hasAttribute('hidden'), true);
    } finally { await scope.close(); }
  }
  for (const stage of ['fetch', 'blob', 'decode'] as const) {
    for (const contextChange of ['owner', 'navigation'] as const) {
      const fetched = deferred<ImageResponse>(), bytes = deferred<Blob>(), decoded = deferred<void>();
      const requests: ImageFetchInit[] = [];
      const scope = world(async (_url, init) => {
        requests.push(init);
        if (requests.length !== 1) return response();
        return stage === 'fetch' ? fetched.promise : { ...response(), blob: () => bytes.promise };
      });
      if (stage === 'decode') scope.setDecode(() => decoded.promise);
      try {
        scope.buttons[0]!.click(); await settle();
        if (stage === 'decode') { bytes.resolve(await response().blob()); await settle(); }
        assert.equal(requests.length, 1);
        const originalContext = scope.client.contextKey();
        if (contextChange === 'owner') scope.window.document.body.setAttribute('data-can-context', 'different-owner');
        else scope.window.history.pushState(null, '', '/mount/other?team=different');
        assert.notEqual(scope.client.contextKey(), originalContext);
        assert.equal(scope.root.isConnected, true);
        if (stage === 'fetch') fetched.resolve(response());
        else if (stage === 'blob') bytes.resolve(await response().blob());
        else decoded.resolve();
        await settle();
        assert.equal(requests[0]!.signal.aborted, true, `${stage}/${contextChange} releases the earlier request`);
        assert.equal(scope.created.length, stage === 'decode' ? 1 : 0);
        assert.deepEqual(scope.revoked, scope.created);
        assert.equal(scope.image.hasAttribute('hidden'), true);
        assert.equal(scope.image.getAttribute('src'), null);
        assert.equal(scope.image.getAttribute('alt'), '');
        assert.equal(scope.original.hasAttribute('hidden'), true);
        assert.equal(scope.original.getAttribute('href'), null);
        scope.buttons[0]!.click(); await settle(); assert.equal(requests.length, 1);
        scope.setDecode(async () => {}); scope.client.rescan();
        scope.buttons[0]!.click(); await settle();
        assert.equal(requests.length, 2); assert.equal(requests[1]!.signal.aborted, false);
        assert.equal(scope.image.hasAttribute('hidden'), false);
        assert.equal(scope.original.getAttribute('href'), 'https://can.test/mount/original/one');
      } finally { await scope.close(); }
    }
  }
  for (const ending of ['stop', 'disconnect'] as const) {
    const blob = deferred<Blob>(); let signal: AbortSignal | undefined;
    const v = world(async (_url, init) => { signal = init.signal; return { ...response(), blob: () => blob.promise }; });
    try {
      v.buttons[0]!.click(); await settle();
      if (ending === 'stop') v.client.stop(); else { v.root.remove(); v.client.rescan(); }
      assert.equal(signal!.aborted, true);
      blob.resolve(new Blob(['late bytes'], { type: 'image/png' })); await settle();
      assert.equal(v.created.length, 0); assert.equal(v.image.hasAttribute('hidden'), true);
      assert.equal(v.dialog.open, false); assert.equal(v.original.hasAttribute('hidden'), true);
    } finally { await v.close(); }
  }
});


test('gallery retained-root delegation handles inserted buttons and thumbnail events after rescan without rebinding', async () => {
  let calls = 0;
  const t = world(async () => { calls++; return response(); });
  try {
    t.buttons[0]!.click(); await settle();
    const currentUrl = t.image.getAttribute('src');
    const replacement = t.buttons[1]!.cloneNode(true) as typeof t.window.HTMLButtonElement.prototype;
    t.buttons[1]!.replaceWith(replacement); t.client.rescan();
    assert.equal(t.image.getAttribute('src'), currentUrl); assert.equal(t.dialog.open, true);
    const thumb = replacement.querySelector('[data-can-gallery-thumb]')!;
    let decodes = 0;
    Object.defineProperty(thumb, 'decode', { configurable: true, value: async () => { decodes++; } });
    thumb.dispatchEvent(new t.window.Event('load')); await settle();
    assert.equal(decodes, 1); assert.equal(replacement.querySelector('[data-can-gallery-thumb-state]')!.textContent, '');
    replacement.click(); await settle();
    assert.equal(calls, 2); assert.equal(t.original.getAttribute('href'), 'https://can.test/mount/original/two');
    const nested = t.window.document.createElement('section'); nested.setAttribute('data-can-gallery', '');
    const foreign = replacement.cloneNode(true) as typeof t.window.HTMLButtonElement.prototype; nested.append(foreign); t.root.append(nested);
    foreign.click(); await settle(); assert.equal(calls, 2);
  } finally { await t.close(); }
});


test('gallery failed listener acquisition preserves its error and disposal attempts every owned release', async () => {
  let requests = 0;
  const t = world(async () => { requests++; return response(); });
  t.client.stop();
  const internals: ClientInternals = {
    windowRef: t.window as unknown as ClientInternals['windowRef'],
    document: t.window.document as unknown as ClientInternals['document'], visibility: { visibilityState: 'visible' },
    fetchImpl: async () => { throw new Error('POST is not gallery transport'); },
    imageFetch: async () => { requests++; return response(); },
  };
  const root = t.root as unknown as ElementLike;
  const primary = new Error('listener acquisition failed'), removal = new Error('listener removal failed');
  const add = t.root.addEventListener.bind(t.root), remove = t.root.removeEventListener.bind(t.root);
  const dialogRemove = t.dialog.removeEventListener.bind(t.dialog);
  const removed: string[] = [];
  try {
    Object.defineProperty(t.root, 'addEventListener', { configurable: true, value: (...args: Parameters<typeof add>) => {
      add(...args); if (args[0] === 'load') throw primary;
    } });
    Object.defineProperty(t.root, 'removeEventListener', { configurable: true, value: (...args: Parameters<typeof remove>) => {
      removed.push(args[0]); remove(...args); if (args[0] === 'click') throw removal;
    } });
    assert.throws(() => bindGallery(root, t.client, internals), value => value === primary);
    assert.deepEqual(removed, ['click', 'load']);
    t.buttons[0]!.click(); await settle(); assert.equal(requests, 0);
    Object.defineProperty(t.root, 'addEventListener', { configurable: true, value: add });
    const dispose = bindGallery(root, t.client, internals);
    t.buttons[0]!.click(); await settle(); assert.equal(requests, 1);
    const closing = new Error('dialog close failed');
    Object.defineProperty(t.dialog, 'close', { configurable: true, value: () => { throw closing; } });
    Object.defineProperty(t.dialog, 'removeEventListener', { configurable: true, value: (...args: Parameters<typeof dialogRemove>) => {
      removed.push('dialog:' + args[0]); dialogRemove(...args);
    } });
    removed.length = 0;
    assert.throws(dispose, value => value === closing);
    assert.deepEqual(removed, ['click', 'load', 'error', 'dialog:cancel', 'dialog:close']);
    assert.deepEqual(t.revoked, t.created); assert.equal(t.image.hasAttribute('hidden'), true);
    assert.equal(t.window.document.activeElement, t.buttons[0]);
    t.buttons[0]!.click(); await settle(); assert.equal(requests, 1);
    dispose(); assert.equal(removed.length, 5);
  } finally { await t.close(); }
});


// The timer models the UA's queued close event; this remains a structural DOM control.
test('gallery queued old dialog close preserves reopened preview while current close aborts and revokes', async () => {
  const pending = deferred<ImageResponse>();
  const requests: ImageFetchInit[] = [];
  const t = world(async (_url, init) => { requests.push(init); return requests.length === 1 ? response() : pending.promise; });
  const queued: Promise<void>[] = [];
  Object.defineProperty(t.dialog, 'close', { configurable: true, value: () => {
    t.dialog.removeAttribute('open');
    queued.push(new Promise<void>(resolve => { t.window.setTimeout(() => {
      t.dialog.dispatchEvent(new t.window.Event('close')); resolve();
    }, 0); }));
  } });
  try {
    t.buttons[0]!.click(); await settle(); assert.equal(t.created.length, 1);
    t.closer.click(); t.buttons[1]!.click();
    assert.equal(t.dialog.open, true); assert.equal(requests[0]!.signal.aborted, true);
    await queued[0]; await settle();
    assert.equal(requests[1]!.signal.aborted, false); assert.equal(t.dialog.open, true);
    pending.resolve(response()); await settle();
    assert.equal(t.image.hasAttribute('hidden'), false);
    assert.equal(t.original.getAttribute('href'), 'https://can.test/mount/original/two');
    assert.equal(t.original.hasAttribute('hidden'), false); assert.equal(t.created.length, 2);
    t.dialog.close(); assert.equal(requests[1]!.signal.aborted, false);
    await queued[1]; await settle();
    assert.equal(requests[1]!.signal.aborted, true); assert.deepEqual(t.revoked, t.created);
    assert.equal(t.image.hasAttribute('hidden'), true); assert.equal(t.original.hasAttribute('hidden'), true);
    assert.equal(t.window.document.activeElement, t.buttons[1]);
  } finally { await t.close(); }
});
