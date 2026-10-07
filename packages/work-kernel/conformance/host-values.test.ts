// W03.2 carrier prerequisite evidence. Executes immutable expected traces
// against the binding; this is not a production profile-point consumer join.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as carrier from '../bindings/host-values.js';
import type { PayloadRef, PresenceTag } from '../src/facts.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = [join(HERE, 'fixtures/traces/refs.json'), join(HERE, '../../conformance/fixtures/traces/refs.json')].find(existsSync);
assert.ok(FIXTURE, 'frozen refs.json must be available; never regenerate expectations');
type Step = { op: string; args: { presence?: PresenceTag; mode?: 'retain' | 'clone'; scope?: string; error?: string; stage?: string } };
type Case = { name: string; maxLive?: number; clone?: string; steps: Step[]; expected: unknown[] };
const frozen = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { transport: string; cases: Case[] };
assert.equal(frozen.transport, 'v0');

async function execute(entry: Case): Promise<unknown[]> {
  const payload = { nested: { value: 42 } };
  const original = new Error('original failure');
  const observed: unknown[] = [];
  const options = { maxLive: entry.maxLive ?? 8, ...(entry.clone === 'throw-original' ? { clone: <T>(_value: T): T => { throw original; } } : {}) };
  const scopes = new Map<string, carrier.CallScope>();
  let active = new carrier.CallScope('A', options);
  scopes.set('A', active);
  let ref: PayloadRef | undefined;
  let surfaced: unknown;
  const controller = new AbortController();
  const scopeFor = (step: Step): carrier.CallScope => {
    const key = step.args.scope ?? 'A';
    let scope = scopes.get(key);
    if (!scope) { scope = new carrier.CallScope(key, options); scopes.set(key, scope); }
    return scope;
  };
  const step = (item: Step): void => {
    const scope = scopeFor(item);
    try {
      switch (item.op) {
        case 'retain': {
          const presence = item.args.presence ?? 'missing';
          ref = scope.retain(payload, presence);
          assert.equal(scope.resolve(ref).presence, presence);
          break;
        }
        case 'materialize': {
          assert.ok(ref);
          const materialized = scope.materialize(ref, item.args.mode ?? 'retain');
          if (entry.name === 'retain-identity') observed.push({ identity: materialized === payload ? 'same' : 'different' });
          if (entry.name === 'clone-at-point') {
            assert.notEqual((materialized as typeof payload).nested, payload.nested);
            observed.push({ equal: assert.deepEqual(materialized, payload) === undefined, identity: materialized === payload ? 'same' : 'different' });
          }
          break;
        }
        case 'release': assert.ok(ref); scope.release(ref.index); break;
        case 'exit-scope': scope.dispose(); break;
        case 'throw-in-scope': throw original;
        case 'abort': assert.equal(item.args.stage, 'exit'); controller.abort(); break;
        case 'check-cancelled': break; // runInScope checks exit after callback settles.
        case 'check-clone-failures': observed.push({ preserved: scope.cloneFailures.length === 1 && scope.cloneFailures[0] === original, surfaced: surfaced === original ? 'original' : 'substituted' }); break;
        case 'list-exports': observed.push({ exports: Object.keys(carrier).sort(), payloadEnumeration: ['entries', 'values', 'payloads', Symbol.iterator].some((key) => key in scope) }); break;
        default: assert.fail(`unhandled frozen operation ${item.op}`);
      }
    } catch (failure) {
      if (item.op === 'throw-in-scope') throw failure;
      if (failure instanceof carrier.RefRejectionError) {
        observed.push({ code: failure.rejection.code, ...(entry.name.startsWith('dispose-on-') ? { disposed: scope.isDisposed } : {}), ...(entry.name === 'dispose-on-exception' ? { surfaced: surfaced === original ? 'original' : 'substituted' } : {}) });
      } else if (entry.clone === 'throw-original' && item.op === 'materialize') {
        surfaced = failure;
      } else { throw failure; }
    }
  };
  try {
    if (entry.name === 'dispose-on-success' || entry.name === 'dispose-on-exception' || entry.name === 'dispose-on-cancel') {
      // The lifecycle marker is performed by real runInScope exit/finally.
      const boundary = entry.steps.findIndex((item) => ['exit-scope', 'throw-in-scope', 'check-cancelled'].includes(item.op));
      assert.ok(boundary >= 0);
      active.dispose();
      try {
        await carrier.runInScope('A', { ...options, signal: controller.signal }, (scope) => {
          active = scope; scopes.set('A', scope);
          for (const item of entry.steps.slice(0, boundary + 1)) if (item.op !== 'exit-scope') step(item);
        });
      } catch (failure) {
        surfaced = failure;
        if (entry.name === 'dispose-on-cancel') {
          assert.ok(failure instanceof carrier.CallCancelledError);
          observed.push({ code: 'wt.call-cancelled', disposed: active.isDisposed });
        } else { assert.equal(failure, original); }
      }
      for (const item of entry.steps.slice(boundary + 1)) step(item);
      assert.equal(active.liveCount, 0);
      assert.equal(active.isDisposed, true);
    } else {
      for (const item of entry.steps) step(item);
    }
  } finally { for (const scope of scopes.values()) scope.dispose(); }
  if (entry.name === 'retain-identity' || entry.name === 'clone-at-point') observed.push({ disposed: active.isDisposed });
  return observed;
}

describe('W03.2 immutable refs traces through the actual carrier', () => {
  assert.equal(frozen.cases.length, 11);
  for (const entry of frozen.cases) it(entry.name, async () => assert.deepEqual(await execute(entry), entry.expected));
});

it('retention, resolution, release and disposal never inspect untouched payloads', () => {
  let reads = 0;
  const untouched = new Proxy({}, { get() { reads++; throw new Error('payload get'); }, ownKeys() { reads++; throw new Error('payload enumerate'); }, getOwnPropertyDescriptor() { reads++; throw new Error('payload descriptor'); } });
  const scope = new carrier.CallScope('opaque', { maxLive: 2 });
  const ref = scope.retain(untouched, 'accessor-backed');
  assert.equal(scope.resolve(ref).payload, untouched);
  assert.equal(scope.materialize(ref, 'retain'), untouched);
  scope.release(ref.index); scope.dispose();
  assert.equal(reads, 0);
  assert.deepEqual(Object.keys(carrier).sort(), ['CallCancelledError', 'CallScope', 'RefRejectionError', 'runInScope']);
  for (const key of ['entries', 'values', 'payloads', Symbol.iterator]) assert.equal(key in scope, false);
});

it('clone is called only at explicit materialization and preserves undefined thrown values', () => {
  let calls = 0;
  const scope = new carrier.CallScope('clone', { maxLive: 1, clone: <T>(_value: T): T => { calls++; throw undefined; } });
  const payload = { value: 1 };
  const ref = scope.retain(payload, 'own-null');
  assert.equal(scope.materialize(ref, 'retain'), payload); assert.equal(calls, 0);
  let threw = false;
  try { scope.materialize(ref, 'clone'); } catch (failure) { threw = true; assert.equal(failure, undefined); }
  assert.equal(threw, true); assert.equal(calls, 1); assert.deepEqual(scope.cloneFailures, [undefined]);
  scope.dispose();
});

it('valid bounds reject before allocation and released slots do not revive old indices', () => {
  const empty = new carrier.CallScope('zero', { maxLive: 0 });
  assert.throws(() => empty.retain({}, 'missing'), (failure) => failure instanceof carrier.RefRejectionError && failure.rejection.code === 'oversized-frame');
  assert.equal(empty.liveCount, 0);
  const scope = new carrier.CallScope('bounded', { maxLive: 1 });
  const first = scope.retain({}, 'missing');
  assert.throws(() => scope.retain({}, 'missing'), carrier.RefRejectionError); assert.equal(scope.liveCount, 1);
  scope.release(first.index); scope.release(first.index);
  const second = scope.retain({}, 'missing'); assert.ok(second.index > first.index);
  for (const index of [first.index, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => scope.resolve({ callToken: 'bounded', index }), (failure) => failure instanceof carrier.RefRejectionError && failure.rejection.code === 'stale-ref');
  scope.dispose(); scope.dispose(); assert.equal(scope.liveCount, 0);
});

it('runInScope disposes rejected loads and pre-aborted calls, preserving original exceptions', async () => {
  let captured: carrier.CallScope | undefined;
  await assert.rejects(carrier.runInScope('load', { maxLive: 1 }, (scope) => {
    captured = scope; scope.retain({}, 'missing'); scope.retain({}, 'missing');
  }), (failure) => failure instanceof carrier.RefRejectionError && failure.rejection.code === 'oversized-frame');
  assert.ok(captured); assert.equal(captured.isDisposed, true); assert.equal(captured.liveCount, 0);
  const controller = new AbortController(); controller.abort(); let entered = false;
  await assert.rejects(carrier.runInScope('preabort', { maxLive: 1, signal: controller.signal }, () => { entered = true; }), carrier.CallCancelledError);
  assert.equal(entered, false);
  const original = { arbitrary: 'thrown value' };
  await assert.rejects(carrier.runInScope('throw', { maxLive: 1 }, async (scope) => { captured = scope; scope.retain({}, 'missing'); throw original; }), (failure) => failure === original);
  assert.equal(captured.liveCount, 0); assert.equal(captured.isDisposed, true);
});

it('abort disposes immediately while an asynchronous callback is still pending', async () => {
  const controller = new AbortController(); let captured: carrier.CallScope | undefined;
  let finish!: () => void;
  const pending = run();
  async function run(): Promise<void> {
    await carrier.runInScope('pending', { maxLive: 1, signal: controller.signal }, async (scope) => { captured = scope; scope.retain({}, 'missing'); await new Promise<void>((resolve) => { finish = resolve; }); });
  }
  assert.ok(captured); controller.abort(); assert.equal(captured.liveCount, 0); assert.equal(captured.isDisposed, true);
  assert.throws(() => captured?.retain({}, 'missing'), carrier.RefRejectionError);
  finish(); await assert.rejects(pending, carrier.CallCancelledError);
});


it('runInScope removes cancellation listeners on success, failure and cancellation', async () => {
  for (const mode of ['success', 'failure', 'cancel'] as const) {
    let listener: (() => void) | undefined;
    let added = 0; let removed = 0; let aborted = false;
    const signal = {
      get aborted(): boolean { return aborted; },
      addEventListener(_type: 'abort', callback: () => void): void { added++; listener = callback; },
      removeEventListener(_type: 'abort', callback: () => void): void { assert.equal(callback, listener); removed++; listener = undefined; },
    };
    const original = new Error('clone failure');
    let captured: carrier.CallScope | undefined;
    const pending = carrier.runInScope('listeners', { maxLive: 1, signal, clone: <T>(_value: T): T => { throw original; } }, (scope) => {
      captured = scope;
      const ref = scope.retain({}, 'missing');
      if (mode === 'failure') scope.materialize(ref, 'clone');
      if (mode === 'cancel') { aborted = true; assert.ok(listener); listener(); }
    });
    if (mode === 'success') await pending;
    else await assert.rejects(pending, (failure) => mode === 'failure' ? failure === original : failure instanceof carrier.CallCancelledError);
    assert.ok(captured); assert.equal(captured.isDisposed, true); assert.equal(captured.liveCount, 0);
    if (mode === 'failure') assert.equal(captured.cloneFailures[0], original);
    assert.equal(added, 1); assert.equal(removed, 1); assert.equal(listener, undefined);
  }
});

it('allocation configuration rejects non-u32 counts before entering callbacks', async () => {
  for (const maxLive of [NaN, Infinity, -Infinity, -1, 0.5, 2 ** 32, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new carrier.CallScope('invalid', { maxLive }), (failure) => failure instanceof carrier.RefRejectionError && failure.rejection.code === 'count-overflow');
    let entered = false;
    await assert.rejects(carrier.runInScope('invalid', { maxLive }, () => { entered = true; }), (failure) => failure instanceof carrier.RefRejectionError && failure.rejection.code === 'count-overflow');
    assert.equal(entered, false);
  }
  for (const maxLive of [0, 1, 0xffffffff]) {
    const scope = new carrier.CallScope('valid', { maxLive });
    assert.equal(scope.liveCount, 0); scope.dispose();
  }
});

it('u32 index exhaustion refuses before allocation without recycling released refs', () => {
  const scope = new carrier.CallScope('index-boundary', { maxLive: 1 });
  // Test-only counter seed: exercise the exact boundary without four billion
  // allocations. This intentionally uses TS-private runtime state, not a
  // product API, and proves no payload encapsulation or allocation capacity.
  (scope as unknown as { nextIndex: number }).nextIndex = 0xffffffff;
  const last = scope.retain({}, 'missing'); assert.equal(last.index, 0xffffffff);
  assert.throws(() => scope.retain({}, 'missing'), (failure) => failure instanceof carrier.RefRejectionError && failure.rejection.code === 'oversized-frame');
  scope.release(last.index);
  assert.throws(() => scope.retain({}, 'missing'), (failure) => failure instanceof carrier.RefRejectionError && failure.rejection.code === 'count-overflow');
  assert.equal(scope.liveCount, 0);
  assert.throws(() => scope.resolve(last), (failure) => failure instanceof carrier.RefRejectionError && failure.rejection.code === 'stale-ref');
  scope.dispose();
  assert.throws(() => scope.retain({}, 'missing'), (failure) => failure instanceof carrier.RefRejectionError && failure.rejection.code === 'stale-ref');
});
