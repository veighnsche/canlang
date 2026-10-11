import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createServer } from 'node:http';
import { Window } from 'happy-dom';
import type { DerivedOperationInputs, PresentationContext } from '@canlang/contracts';
import { form, generatedFields } from '../src/forms.js';
import {
  registerBinder, startBrowserClient, startNativeBrowserClient,
  type BrowserClient, type BrowserClientOptions, type ComponentBinder,
} from '../src/browser/bootstrap.js';
import { submitFetchPollFetch } from '../src/browser/polling.js';
import type { SubmitFetch, SubmitFetchInit } from '../src/client.js';

const cancellationInputs: DerivedOperationInputs = {
  operation: 'Store.Job.schedule', kind: 'scenario', artifactVersion: 1,
  inputs: [{ name: 'title', kind: 'string', required: true }],
};
async function cancellationForm() {
  const context: PresentationContext = {
    preferredLocales: [], appDefaultLocale: 'en',
    theme: { mode: 'light', accent: 'blue', density: 'comfortable' },
    path: '/jobs', isPartial: false, csrfToken: 'csrf', principal: null, invocation: null,
    query: async () => ({ rows: [], columns: [] }),
  };
  return form({ context, derived: cancellationInputs, operation: cancellationInputs.operation, mode: 'scenario',
    action: '/operations/schedule', operationId: 'rendered-operation-id', timeZone: 'UTC',
    fields: generatedFields(cancellationInputs, 'scenario'), submit: 'Schedule', idPrefix: 'cancel-schedule',
    children: ['<input name="inputs[title]" value="draft"><button id="activated" type="submit" name="inputs[title]" value="activated" aria-disabled="false">Schedule</button>'],
  });
}

const failures = [undefined, Symbol('failure'), new Error('failure')];
const main = (text = 'OLD') => `<main id="can-main" data-can-context="owner" data-can-poll data-can-poll-url="/jobs" data-can-poll-interval="1" data-can-poll-context="owner"><p id="state">${text}</p></main>`;
const response = () => ({ status: 200, headers: { get: () => 'text/html' }, text: async () => main('NEW') });
async function settle() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
function throwsValue(action: () => void, expected: unknown) {
  let caught = false;
  try { action(); } catch (value) { caught = true; assert.equal(value, expected); }
  assert.equal(caught, true, 'the original thrown value must be reported');
}
async function rejectsValue(pending: Promise<unknown>, expected: unknown) {
  let caught = false;
  try { await pending; } catch (value) { caught = true; assert.equal(value, expected); }
  assert.equal(caught, true, 'the original rejected value must be reported');
}
class Clock {
  tasks = new Map<number, () => void>();
  sequence = 0;
  setTimeout = (callback: () => void, _ms: number) => { const id = ++this.sequence; this.tasks.set(id, callback); return id; };
  clearTimeout = (id: unknown) => { this.tasks.delete(id as number); };
  async tick() {
    const task = this.tasks.entries().next().value;
    assert.ok(task); this.tasks.delete(task[0]); task[1](); await settle();
  }
}
type EventPort = {
  addEventListener(type: string, listener: unknown, ...rest: unknown[]): void;
  removeEventListener(type: string, listener: unknown, ...rest: unknown[]): void;
};
function trackEvents(target: object) {
  const port = target as EventPort;
  const add = port.addEventListener.bind(target), remove = port.removeEventListener.bind(target);
  const active = new Map<string, Set<unknown>>(), removed = new Map<string, number>();
  let addFailure: { type: string; value: unknown } | undefined;
  let removeFailure: { type: string; value: unknown } | undefined;
  port.addEventListener = (type, listener, ...rest) => {
    const listeners = active.get(type) ?? new Set(); active.set(type, listeners); listeners.add(listener);
    add(type, listener, ...rest);
    if (addFailure?.type === type) throw addFailure.value;
  };
  port.removeEventListener = (type, listener, ...rest) => {
    removed.set(type, (removed.get(type) ?? 0) + 1); active.get(type)?.delete(listener);
    remove(type, listener, ...rest);
    if (removeFailure?.type === type) throw removeFailure.value;
  };
  return {
    active, removed,
    failAdd: (type: string, value: unknown) => { addFailure = { type, value }; },
    failRemove: (type: string, value: unknown) => { removeFailure = { type, value }; },
    clearFailures: () => { addFailure = undefined; removeFailure = undefined; },
    assertEmpty: () => { for (const [type, listeners] of active) assert.equal(listeners.size, 0, type); },
  };
}
async function world(html = main()) {
  const window = new Window({ url: 'https://can.test/jobs' });
  window.document.body.innerHTML = html;
  const clock = new Clock();
  Object.defineProperty(window, 'setTimeout', { configurable: true, value: clock.setTimeout });
  Object.defineProperty(window, 'clearTimeout', { configurable: true, value: clock.clearTimeout });
  Object.defineProperty(window, 'fetch', { configurable: true, value: async () => response() });
  const events = trackEvents(window), documentEvents = trackEvents(window.document);
  let client: BrowserClient | undefined;
  const coreOptions = (): BrowserClientOptions => {
    // The core port requires this adapter property; raw Window compatibility is outside this repair.
    Object.defineProperty(window, 'visibilityState', { configurable: true, get: () => window.document.visibilityState });
    return { window: window as unknown as BrowserClientOptions['window'], fetchImpl: async () => response() };
  };
  return {
    window, clock, events, documentEvents, coreOptions,
    setClient: (value: BrowserClient) => { client = value; },
    native: () => startNativeBrowserClient(window as unknown as Parameters<typeof startNativeBrowserClient>[0]),
    assertReleased: () => { assert.equal(clock.tasks.size, 0); events.assertEmpty(); documentEvents.assertEmpty(); },
    close: async () => { try { client?.stop(); } catch { /* Failed-disposer tests still close the DOM. */ } await window.happyDOM.close(); },
  };
}
let guardedBinder: ComponentBinder = () => () => {};
registerBinder('guarded-form', (...args) => guardedBinder(...args));
const forms = '<form id="first" data-can-guard></form><form id="second" data-can-guard></form>';

type ObserverFaults = { construct?: { value: unknown }; observe?: { value: unknown }; disconnect?: { value: unknown } };
function observerPort(window: Window, faults: ObserverFaults) {
  const NativeObserver = window.MutationObserver;
  let disconnects = 0;
  Object.defineProperty(window, 'MutationObserver', { configurable: true, value: class {
    constructor(callback: () => void) {
      if (faults.construct !== undefined) throw faults.construct.value;
      const observer = new NativeObserver(callback), observe = observer.observe.bind(observer), disconnect = observer.disconnect.bind(observer);
      Object.defineProperty(observer, 'observe', { value: () => {
        observe(window.document.body, { childList: true, subtree: true, attributes: true });
        if (faults.observe !== undefined) throw faults.observe.value;
      } });
      Object.defineProperty(observer, 'disconnect', { value: () => {
        disconnects++; disconnect();
        if (faults.disconnect !== undefined) throw faults.disconnect.value;
      } });
      return observer;
    }
  } });
  return { disconnects: () => disconnects };
}

describe('owned browser lifecycle cleanup', { concurrency: false }, () => {
  it('generated form stop physically cancels a pending Node fetch response body and restores controls', { timeout: 10000 }, async t => {
    let requestBody!: (value: string) => void, responseClosed!: () => void;
    const received = new Promise<string>(resolve => { requestBody = resolve; });
    const closed = new Promise<void>(resolve => { responseClosed = resolve; });
    let responseEnded = false;
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        requestBody(body);
        response.on('close', () => { responseEnded = response.writableEnded; responseClosed(); });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.flushHeaders();
        response.write('{"status":"committed",');
        // Suspend a successful response mid-body; only client cancellation closes it.
      });
    });
    let window: Window | undefined, client: BrowserClient | undefined;
    t.after(async () => {
      try { client?.stop(); } finally {
        server.closeAllConnections();
        await Promise.all([
          window?.happyDOM.close(),
          new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
        ]);
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    window = new Window({ url: `http://127.0.0.1:${address.port}/jobs` });
    window.document.body.innerHTML = await cancellationForm();
    const target = window.document.querySelector('form')!, button = window.document.querySelector('#activated')!;
    target.setAttribute('aria-busy', 'false');
    let readStarted!: (outcome: Promise<unknown>) => void;
    const reading = new Promise<Promise<unknown>[]>(resolve => { readStarted = outcome => resolve([outcome]); });
    let signal: AbortSignal | undefined;
    Object.defineProperty(window, 'fetch', { configurable: true, value: async (url: string, init: SubmitFetchInit) => {
      signal = init.signal;
      assert.equal(init.method, 'POST'); assert.equal(init.headers['content-type'], 'application/json');
      assert.equal(init.headers['x-csrf-token'], 'csrf'); assert.equal(typeof init.body, 'string');
      const response = await globalThis.fetch(new URL(url, window!.location.href), { ...init, body: init.body as string });
      return { status: response.status, headers: response.headers, text: () => {
        const pending = response.text();
        const outcome = pending.then(() => undefined, error => error as unknown);
        readStarted(outcome);
        return pending;
      } };
    } });
    client = startNativeBrowserClient(window as unknown as Parameters<typeof startNativeBrowserClient>[0]);
    target.dispatchEvent(new window.SubmitEvent('submit', { bubbles: true, cancelable: true,
      submitter: button as typeof window.HTMLButtonElement.prototype }));
    const [bodyOutcome] = await reading;
    assert.deepEqual(JSON.parse(await received), {
      operation: cancellationInputs.operation, operation_id: 'rendered-operation-id', inputs: { title: 'activated' },
    });
    assert.ok(signal); assert.equal(signal.aborted, false);
    assert.equal(button.hasAttribute('disabled'), true);
    client.stop();
    assert.equal(signal.aborted, true);
    assert.equal((await bodyOutcome as { name: string }).name, 'AbortError');
    await closed;
    assert.equal(responseEnded, false, 'Node fetch closed the real HTTP response before completion');
    await settle();
    assert.equal(target.getAttribute('aria-busy'), 'false');
    assert.equal(target.hasAttribute('data-can-submit-state'), false);
    assert.equal(button.hasAttribute('disabled'), false);
    assert.equal(button.getAttribute('aria-disabled'), 'false');
    assert.equal(target.querySelector('[data-can-form-feedback]')?.hasAttribute('hidden'), true);
    // This proves Node fetch body cancellation, not Chrome behavior or server-effect rollback.
  });

  it('generated form stop and rescan isolate ignored-abort body settlements and exhaust throwing teardown', { timeout: 10000 }, async () => {
    for (const transition of ['stop', 'rescan']) {
      const page = await world(await cancellationForm());
      const target = page.window.document.querySelector('form')!, button = page.window.document.querySelector('#activated')!;
      target.setAttribute('aria-busy', 'false');
      const formEvents = trackEvents(target), first = Symbol('swap teardown'), secondary = Symbol('submit teardown');
      const restoration = Symbol('submitter restoration'), removeAttribute = button.removeAttribute.bind(button);
      let failRestoration = false;
      Object.defineProperty(button, 'removeAttribute', { configurable: true, value: (name: string) => {
        removeAttribute(name);
        if (failRestoration && name === 'disabled') { failRestoration = false; throw restoration; }
      } });
      const signals: AbortSignal[] = [], results: unknown[] = [], errors: unknown[] = [];
      const bodies: Array<{ resolve(value: string): void; reject(value: unknown): void }> = [];
      const fetchImpl: SubmitFetch = async (_url, init) => {
        assert.ok(init.signal); signals.push(init.signal);
        const body = new Promise<string>((resolve, reject) => { bodies.push({ resolve, reject }); });
        return { status: 200, headers: { get: () => 'application/json' }, text: () => body };
      };
      const options = { ...page.coreOptions(), fetchImpl,
        onGeneratedFormResult: (_form: unknown, result: unknown) => results.push(result),
        onGeneratedFormError: (_form: unknown, error: unknown) => errors.push(error),
      };
      const submit = () => target.dispatchEvent(new page.window.SubmitEvent('submit', { bubbles: true, cancelable: true,
        submitter: button as typeof page.window.HTMLButtonElement.prototype }));
      try {
        let client = startBrowserClient({ ...options, onHtmxSwap: () => () => { throw first; } }); page.setClient(client);
        submit(); await settle();
        assert.equal(bodies.length, 1); assert.equal(signals[0]!.aborted, false);
        formEvents.failRemove('submit', secondary);
        if (transition === 'stop') {
          throwsValue(() => client.stop(), first);
          page.assertReleased();
        } else {
          page.window.document.body.setAttribute('data-can-context', 'replacement');
          failRestoration = true;
          throwsValue(() => client.rescan(), restoration);
        }
        formEvents.assertEmpty();
        assert.equal(signals[0]!.aborted, true);
        assert.equal(target.getAttribute('aria-busy'), 'false');
        assert.equal(target.hasAttribute('data-can-submit-state'), false);
        assert.equal(button.hasAttribute('disabled'), false);
        assert.equal(button.getAttribute('aria-disabled'), 'false');
        formEvents.clearFailures();
        if (transition === 'stop') { client = startBrowserClient(options); page.setClient(client); }
        else client.rescan();
        submit(); await settle();
        assert.equal(bodies.length, 2); assert.notEqual(signals[0], signals[1]); assert.equal(signals[1]!.aborted, false);
        if (transition === 'stop') bodies[0]!.reject(new Error('obsolete transport'));
        else bodies[0]!.resolve(JSON.stringify({ status: 'committed', operation_id: 'rendered-operation-id', records: [], deliveries: [], result: null }));
        await settle();
        assert.deepEqual(results, []); assert.deepEqual(errors, []);
        assert.equal(signals[1]!.aborted, false);
        assert.equal(target.getAttribute('data-can-submit-state'), 'pending');
        assert.equal(target.getAttribute('aria-busy'), 'true'); assert.equal(button.hasAttribute('disabled'), true);
        bodies[1]!.resolve(JSON.stringify({ status: 'committed', operation_id: 'rendered-operation-id', records: [], deliveries: [], result: null }));
        await settle();
        assert.equal(results.length, 1); assert.deepEqual(errors, []);
        assert.equal(target.getAttribute('data-can-submit-state'), 'committed');
        assert.equal(button.hasAttribute('disabled'), false);
        if (transition === 'rescan') throwsValue(() => client.stop(), first); else client.stop();
        formEvents.assertEmpty(); page.assertReleased();
      } finally {
        formEvents.clearFailures();
        for (const body of bodies) body.resolve('{}');
        await page.close();
      }
    }
  });

  for (const [index, original] of failures.entries()) {
    it(`rolls back hook acquisition and preserves original value ${index} over cleanup errors`, async () => {
      const page = await world(main() + forms), secondary = new Error('cleanup');
      let guardStops = 0;
      guardedBinder = () => () => { guardStops++; throw secondary; };
      page.events.failRemove('hashchange', secondary);
      try {
        throwsValue(() => startBrowserClient({ ...page.coreOptions(), onHtmxSwap: rescan => { rescan(); throw original; } }), original);
        page.assertReleased(); assert.equal(guardStops, 2);
        page.events.clearFailures(); guardedBinder = () => () => {};
        const fresh = startBrowserClient(page.coreOptions()); page.setClient(fresh);
        assert.equal(page.clock.tasks.size, 1); fresh.stop(); page.assertReleased();
      } finally { guardedBinder = () => () => {}; await page.close(); }
    });
    it(`exhausts stop disposers once and reports exact first value ${index}`, async () => {
      const page = await world(main() + forms), secondary = new Error('secondary');
      let hookStops = 0, guardStops = 0;
      guardedBinder = () => () => { guardStops++; throw secondary; };
      try {
        const client = startBrowserClient({ ...page.coreOptions(), onHtmxSwap: () => () => { hookStops++; throw original; } });
        page.setClient(client); page.events.failRemove('hashchange', secondary);
        throwsValue(() => client.stop(), original); page.assertReleased();
        assert.equal(hookStops, 1); assert.equal(guardStops, 2);
        client.stop(); assert.equal(hookStops, 1); assert.equal(guardStops, 2);
        assert.equal(page.events.removed.get('hashchange'), 1); assert.equal(page.events.removed.get('keydown'), 1);
        page.events.clearFailures(); guardedBinder = () => () => {};
        const fresh = startBrowserClient(page.coreOptions()); page.setClient(fresh); assert.notEqual(fresh, client);
        await page.clock.tick(); assert.equal(page.window.document.getElementById('state')?.textContent, 'NEW');
      } finally { guardedBinder = () => () => {}; await page.close(); }
    });
    it(`rolls back initial rescan and does not retry failed binder disposer ${index}`, async () => {
      const page = await world(main() + forms), secondary = new Error('binder cleanup');
      let releases = 0;
      guardedBinder = region => {
        if (region.getAttribute('id') === 'second') throw original;
        return () => { releases++; throw secondary; };
      };
      try {
        throwsValue(() => startBrowserClient(page.coreOptions()), original);
        page.assertReleased(); assert.equal(releases, 1);
        guardedBinder = () => () => {};
        page.setClient(startBrowserClient(page.coreOptions())); assert.equal(page.clock.tasks.size, 1);
      } finally { guardedBinder = () => () => {}; await page.close(); }
    });
    for (const phase of ['construct', 'observe'] as const) {
      it(`rolls back native observer ${phase} with exact original value ${index}`, async () => {
        const page = await world(), secondary = new Error('observer cleanup');
        const faults: ObserverFaults = { [phase]: { value: original }, disconnect: { value: secondary } };
        const observer = observerPort(page.window, faults);
        page.documentEvents.failRemove('htmx:afterSwap', secondary);
        try {
          throwsValue(() => page.native(), original); page.assertReleased();
          assert.equal(observer.disconnects(), phase === 'observe' ? 1 : 0);
          delete faults[phase]; delete faults.disconnect; page.documentEvents.clearFailures();
          const fresh = page.native(); page.setClient(fresh); assert.equal(page.clock.tasks.size, 1);
        } finally { await page.close(); }
      });
    }
    it(`native stop disposes observer, listeners and core despite first failure ${index}`, async () => {
      const page = await world(), secondary = new Error('core cleanup');
        const faults: ObserverFaults = { disconnect: { value: original } };
      const observer = observerPort(page.window, faults);
      try {
        const client = page.native(); page.setClient(client);
        page.documentEvents.failRemove('htmx:afterSwap', secondary); page.events.failRemove('popstate', secondary);
        throwsValue(() => client.stop(), original); page.assertReleased(); assert.equal(observer.disconnects(), 1);
        client.stop(); assert.equal(observer.disconnects(), 1);
        delete faults.disconnect; page.events.clearFailures(); page.documentEvents.clearFailures();
        const fresh = page.native(); page.setClient(fresh); assert.notEqual(fresh, client); assert.equal(page.clock.tasks.size, 1);
      } finally { await page.close(); }
    });
    it(`native stop reports core failure when observer disposal succeeds ${index}`, async () => {
      const page = await world(), observer = observerPort(page.window, {});
      try {
        const client = page.native(); page.setClient(client); page.documentEvents.failRemove('htmx:afterSwap', original);
        throwsValue(() => client.stop(), original); page.assertReleased(); assert.equal(observer.disconnects(), 1);
        client.stop(); assert.equal(observer.disconnects(), 1);
        page.documentEvents.clearFailures(); const fresh = page.native(); page.setClient(fresh); assert.notEqual(fresh, client);
      } finally { await page.close(); }
    });
    it(`synchronous fetch acquisition removes actual abort listener and preserves value ${index}`, async () => {
      const controller = new AbortController(), order: string[] = [], secondary = new Error('signal cleanup');
      const remove = controller.signal.removeEventListener.bind(controller.signal);
      Object.defineProperty(controller.signal, 'removeEventListener', { value: (...args: Parameters<AbortSignal['removeEventListener']>) => { remove(...args); throw secondary; } });
      const fetch = submitFetchPollFetch(() => { order.push('fetch'); throw original; });
      const pending = fetch('/jobs', { signal: controller.signal }); order.push('returned');
      assert.deepEqual(order, ['fetch', 'returned']); await rejectsValue(pending, original);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    });
  }
  for (const type of ['hashchange', 'keydown']) {
    it(`rolls back a partially installed core ${type} listener`, async () => {
      const page = await world(), original = Symbol(type);
      try { page.events.failAdd(type, original); throwsValue(() => startBrowserClient(page.coreOptions()), original); page.assertReleased(); }
      finally { await page.close(); }
    });
  }
  for (const type of ['htmx:afterSwap', 'popstate', 'visibilitychange', 'pagehide', 'pageshow']) {
    it(`rolls back partially installed native ${type} listener`, async () => {
      const page = await world(), original = Symbol(type), observer = observerPort(page.window, {});
      try {
        (type.includes(':') || type === 'visibilitychange' ? page.documentEvents : page.events).failAdd(type, original);
        throwsValue(() => page.native(), original); page.assertReleased();
        assert.equal(observer.disconnects(), type === 'htmx:afterSwap' ? 0 : 1);
      } finally { await page.close(); }
    });
  }
  it('ordinary native stop releases pending text and permits a fresh observer context rescan', async () => {
    const page = await world(); let finish!: (value: string) => void;
    const body = new Promise<string>(resolve => { finish = resolve; });
    Object.defineProperty(page.window, 'fetch', { configurable: true, value: async () => ({ ...response(), text: () => body }) });
    try {
      const old = page.native(); page.setClient(old); await page.clock.tick(); old.stop(); finish(main('NEW')); await settle();
      page.assertReleased(); assert.equal(page.window.document.getElementById('state')?.textContent, 'OLD');
      const fresh = page.native(); page.setClient(fresh); assert.notEqual(fresh, old);
      page.window.document.getElementById('can-main')!.setAttribute('data-can-context', 'fresh-owner'); await settle();
      assert.equal(page.clock.tasks.size, 1); fresh.stop(); page.assertReleased();
    } finally { await page.close(); }
  });
  it('async adapter settlement and abort still release actual signal listeners', async () => {
    for (const outcome of ['resolve', 'reject', 'abort']) {
      const controller = new AbortController(); let finish!: (value: ReturnType<typeof response>) => void;
      let reject!: (value: unknown) => void;
      const transport: SubmitFetch = () => new Promise((resolve, fail) => { finish = resolve; reject = fail; });
      const pending = submitFetchPollFetch(transport)('/jobs', { signal: controller.signal });
      if (outcome === 'resolve') { finish(response()); await pending; }
      else if (outcome === 'reject') { const original = Symbol('async'); reject(original); await rejectsValue(pending, original); }
      else {
        controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'abort releases without waiting for ignored transport');
        finish(response()); await settle();
      }
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    }
  });
  it('async adapter cleanup settles and preserves the operative rejection', async () => {
    for (const original of failures) {
      for (const outcome of ['resolve', 'reject', 'abort']) {
        const controller = new AbortController(), secondary = Symbol('async cleanup');
        const remove = controller.signal.removeEventListener.bind(controller.signal);
        let releases = 0;
        Object.defineProperty(controller.signal, 'removeEventListener', { value: (...args: Parameters<AbortSignal['removeEventListener']>) => {
          releases++; remove(...args); throw secondary;
        } });
        let finish!: (value: ReturnType<typeof response>) => void, reject!: (value: unknown) => void;
        const pending = submitFetchPollFetch((_url, init) => {
          assert.equal(init.signal, controller.signal);
          return new Promise((resolve, fail) => { finish = resolve; reject = fail; });
        })('/jobs', { signal: controller.signal });
        if (outcome === 'resolve') { finish(response()); await rejectsValue(pending, secondary); }
        else if (outcome === 'reject') { reject(original); await rejectsValue(pending, original); }
        else {
          controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
          assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
          reject(original); await settle();
        }
        assert.equal(releases, 1);
        assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      }
    }
  });
  it('native polling owns the supported abort signal through the pending response body', async () => {
    for (const transition of ['stop', 'hidden', 'logout', 'context', 'detach', 'supersede']) {
      const page = await world(); const finish: Array<(value: string) => void> = [];
      const signals: AbortSignal[] = []; let reads = 0;
      Object.defineProperty(page.window, 'fetch', { configurable: true, value: async (_url: string, init: SubmitFetchInit) => {
        assert.ok(init.signal); signals.push(init.signal);
        const body = new Promise<string>(resolve => { finish.push(resolve); });
        return { ...response(), text: () => { reads++; return body; } };
      } });
      try {
        const client = page.native(); page.setClient(client); await page.clock.tick();
        assert.equal(reads, 1); assert.equal(signals[0]?.aborted, false);
        if (transition === 'stop') client.stop();
        else if (transition === 'hidden') {
          Object.defineProperty(page.window.document, 'visibilityState', { configurable: true, value: 'hidden' });
          page.window.document.dispatchEvent(new page.window.Event('visibilitychange'));
        } else if (transition === 'logout') {
          page.window.document.body.setAttribute('data-can-logged-out', 'true'); await page.clock.tick();
        } else if (transition === 'context') {
          page.window.document.getElementById('can-main')!.setAttribute('data-can-context', 'new-owner'); await page.clock.tick();
        } else if (transition === 'detach') {
          page.window.document.getElementById('can-main')!.remove(); await page.clock.tick();
        } else await page.clock.tick();
        await settle();
        assert.equal(signals[0]?.aborted, true, transition);
        if (transition === 'supersede') { assert.equal(signals.length, 2); assert.equal(signals[1]?.aborted, false); }
        finish[0]!(main('NEW')); await settle();
        assert.notEqual(page.window.document.getElementById('state')?.textContent, 'NEW', transition);
        client.stop(); for (const complete of finish) complete(main('NEW')); await settle();
        assert.ok(signals.every(signal => signal.aborted), transition); page.assertReleased();
      } finally { await page.close(); }
    }
  });
});
