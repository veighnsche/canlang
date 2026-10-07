import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { Window } from 'happy-dom';
import {
  registerBinder, startBrowserClient, startNativeBrowserClient,
  type BrowserClient, type BrowserClientOptions, type ComponentBinder,
} from '../src/browser/bootstrap.js';
import { submitFetchPollFetch } from '../src/browser/polling.js';
import type { SubmitFetch } from '../src/client.js';

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
      else { controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); finish(response()); await settle(); }
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    }
  });
});
