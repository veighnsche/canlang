// W03 recovery planner only: retained original expectations plus demanded-read
// traces against the extracted TS donor. No production consumer adoption.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRecoveryPlanner } from '../src/index.js';
import { distribution } from '../src/distribution.js';
import { planRecoveryScan } from '../src/recovery.js';
import type { RecoverableRow, RecoveryPlan, RecoveryScanInput } from '../src/recovery.js';
import type { DispatchClaim, OutboxId } from '@canlang/contracts';

// The explicit compiled asset is mandatory; missing preparation is a failure.
const nativeModule = new WebAssembly.Module(readFileSync(distribution.recoveryWasm));
const native = createRecoveryPlanner({ backend: 'wasm', module: nativeModule });
const ts = createRecoveryPlanner({ backend: 'ts' });
const fixtureUrl = [new URL('./fixtures/receipts/recovery.json', import.meta.url),
  new URL('../../conformance/fixtures/receipts/recovery.json', import.meta.url)].find(existsSync);
assert.ok(fixtureUrl, 'retained original recovery fixture must exist');
type FrozenCase = { id: string; fn: string; input: unknown[];
  expect: { ok?: unknown; throw?: { name: string; message: string } } };
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as { cases: FrozenCase[] };

function thaw(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(thaw);
  if (value !== null && typeof value === 'object') {
    const data = value as Record<string, unknown>;
    if (Object.keys(data).length === 1 && '$num' in data) {
      switch (data['$num']) {
        case 'NaN': return NaN;
        case 'Infinity': return Infinity;
        case '-Infinity': return -Infinity;
        case '-0': return -0;
        default: throw new Error('Unknown retained numeric tag');
      }
    }
    if (Object.keys(data).length === 1 && '$resolver' in data) {
      const table = thaw(data['$resolver']) as Record<string, unknown>;
      return (id: string) => table[id] ?? null;
    }
    return Object.fromEntries(Object.entries(data).map(([key, item]) => [key, thaw(item)]));
  }
  return value;
}

const id = (value: string) => value as OutboxId;
function row(value: string, state: RecoverableRow['item']['state']): RecoverableRow {
  return { item: { id: id(value), operationId: 'original-operation', source: 'original-source',
    occurrenceIndex: 0, request: {}, originOccurrence: null, attempts: 1, state },
  guardVerdict: null, firstAttemptAtMs: null, retryClass: null };
}
function input(rows: readonly RecoverableRow[], claims: readonly DispatchClaim[] = []): RecoveryScanInput {
  return { rows, claims, evidence: () => null, nowMs: 100, maxClaimAgeMs: 10 };
}
function claim(value: string, claimedAt: number): DispatchClaim {
  return { outboxId: id(value), claimId: 'original-claim' as DispatchClaim['claimId'], claimedAt };
}
type Planner = (value: RecoveryScanInput) => RecoveryPlan;
function outcome(planner: Planner, value: RecoveryScanInput): unknown {
  try { return { ok: planner(value) }; }
  catch (error) {
    assert.ok(error instanceof Error);
    return { throw: { name: error.name, message: error.message } };
  }
}

describe('W03 native recovery planner', () => {
  it('native recovery ABI poisons wrong-phase handles, preserves validation codes and never reuses freed identities', () => {
    const exports = new WebAssembly.Instance(nativeModule).exports;
    assert.ok(exports.memory instanceof WebAssembly.Memory);
    const fn = (name: string): ((...args: number[]) => number) => {
      const value = exports[`can_recovery_${name}`];
      assert.equal(typeof value, 'function', `required genuine native export ${name}`);
      return value as (...args: number[]) => number;
    };
    const version = fn('abi_version'), create = fn('create'), free = fn('free');
    const demand = fn('demand'), errorCode = fn('error_code');
    const resultLen = fn('result_len'), textReply = fn('text_reply'), numberReply = fn('number_reply');
    const live = new Set<number>();
    let previous = 0;
    const fresh = () => {
      const handle = create();
      assert.ok(handle > previous, 'native handles are monotonic and distinct even after free');
      previous = handle; live.add(handle);
      assert.equal(demand(handle), 1); assert.equal(errorCode(handle), 0);
      return handle;
    };
    const release = (handle: number) => {
      assert.equal(free(handle), 1); live.delete(handle);
      assert.equal(free(handle), 0);
      assert.equal(demand(handle), 254); assert.equal(errorCode(handle), 100);
    };
    try {
      const earlyResult = fresh();
      assert.equal(resultLen(earlyResult, 0), 0);
      assert.equal(demand(earlyResult), 254); assert.equal(errorCode(earlyResult), 100);
      assert.equal(numberReply(earlyResult, 100), 254, 'poisoned handle cannot resume');
      release(earlyResult);
      const earlyText = fresh();
      assert.equal(textReply(earlyText), 254);
      assert.equal(errorCode(earlyText), 100);
      assert.equal(numberReply(earlyText, 100), 254);
      release(earlyText);
      const validations = [
        { prefix: [], value: NaN, code: 1 },
        { prefix: [100], value: -1, code: 1 },
        { prefix: [100, 100], value: Infinity, code: 2 },
        { prefix: [100, 100, 10], value: -1, code: 2 },
        { prefix: [100, 100, 10, 10], value: 1.5, code: 3 },
        { prefix: [100, 100, 10, 10, 3], value: 0, code: 3 },
        { prefix: [100, 100, 10, 10, 3, 3], value: Infinity, code: 4 },
        { prefix: [100, 100, 10, 10, 3, 3, 50], value: 0, code: 4 },
      ];
      for (const { prefix, value, code } of validations) {
        const handle = fresh();
        for (const [index, scalar] of prefix.entries()) assert.equal(numberReply(handle, scalar), index + 2);
        assert.equal(numberReply(handle, value), 254);
        assert.equal(demand(handle), 254); assert.equal(errorCode(handle), code);
        release(handle);
      }
    } finally {
      for (const handle of live) assert.equal(free(handle), 1);
    }
  });

  const cases = fixture.cases.filter(entry => entry.fn === 'planRecoveryScan');
  assert.ok(cases.length > 0);
  for (const entry of cases) {
    it(`retained original ${entry.id}`, () => {
      for (const planner of [ts, native]) {
        assert.deepEqual(outcome(planner, thaw(entry.input[0]) as RecoveryScanInput), thaw(entry.expect));
      }
    });
  }

  it('matches demanded property order, captures both stale arguments and reads claimedAt once', () => {
    function trace(planner: Planner, invalidLaterNow: boolean) {
      const events: string[] = [];
      let nowReads = 0, claimedReads = 0;
      const observe = <T>(target: object, key: string, get: () => T) => Object.defineProperty(target, key,
        { enumerable: true, get: () => { events.push(key); return get(); } });
      const original = row('claimed', 'claimed');
      const originalItem = original.item;
      const recorded = claim('claimed', 90);
      observe(recorded, 'claimedAt', () => { claimedReads++; return 90; });
      observe(recorded, 'outboxId', () => id('claimed'));
      observe(original, 'item', () => originalItem);
      observe(originalItem, 'state', () => 'claimed');
      observe(originalItem, 'id', () => id('claimed'));
      const value = input([original], [recorded]);
      observe(value, 'nowMs', () => (++nowReads >= 3 && invalidLaterNow) ? -1 : 100);
      observe(value, 'maxClaimAgeMs', () => 10);
      observe(value, 'claims', () => [recorded]);
      observe(value, 'rows', () => [original]);
      observe(value, 'evidence', () => { throw new Error('undemanded evidence'); });
      events.length = 0;
      const result = outcome(planner, value);
      return { result, events, claimedReads };
    }
    for (const invalid of [false, true]) {
      const expected = trace(planRecoveryScan, invalid);
      assert.deepEqual(trace(native, invalid), expected);
      assert.equal(expected.claimedReads, invalid ? 0 : 1);
    }
  });

  it('uses evidence only for uncertain rows with the original receiver and rereads callback-mutated IDs', () => {
    function trace(planner: Planner) {
      const events: string[] = [];
      const uncertain = row('before', 'uncertain');
      const value = input([row('settled', 'delivered'), row('pending', 'pending'), uncertain]);
      Object.defineProperty(uncertain, 'guardVerdict', { get() { throw new Error('undemanded guard'); } });
      Object.defineProperty(value, 'evidence', { value: function (this: RecoveryScanInput, actual: OutboxId) {
        assert.equal(this, value); assert.equal(actual, id('before')); events.push(actual);
        uncertain.item.id = id('after'); return null;
      } });
      const result = planner(value);
      assert.deepEqual(result.awaiting, [id('after')]);
      return { result, events };
    }
    assert.deepEqual(trace(native), trace(planRecoveryScan));
  });

  it('keeps duplicate claims last-wins and sorts opaque IDs by UTF16 including lone surrogates', () => {
    const names = ['\ue000', '😀', '\ud800', 'a', '\udfff'];
    const value = input([...names.map(name => row(name, 'uncertain')), row('last-fresh', 'claimed'), row('last-stale', 'claimed')],
      [claim('last-fresh', 0), claim('last-fresh', 100), claim('last-stale', 100), claim('last-stale', 0)]);
    const expected = planRecoveryScan(value);
    assert.deepEqual(expected.resume, [id('last-stale')]);
    assert.deepEqual(expected.awaiting, ['a', '\ud800', '😀', '\udfff', '\ue000'].map(id));
    assert.deepEqual(native(value), expected);
  });

  it('preserves f64 addition boundaries and unvalidated numeric or absent claimedAt facts', () => {
    for (const claimedAt of [2 ** 53, 90, -1, NaN, Infinity, -Infinity, null, undefined]) {
      const recorded = claimedAt === undefined ? { outboxId: id('claim'), claimId: 'original-claim' } as DispatchClaim
        : claim('claim', claimedAt as number);
      const value = { ...input([row('claim', 'claimed')], [recorded]),
        nowMs: claimedAt === 2 ** 53 ? 2 ** 53 : 100, maxClaimAgeMs: claimedAt === 2 ** 53 ? 1 : 10 };
      const expected = planRecoveryScan(value);
      if (claimedAt === 2 ** 53) assert.deepEqual(expected.resume, [id('claim')], 'addition rounds before comparison');
      assert.deepEqual(native(value), expected);
    }
  });

  it('supports nested native planner entry during original evidence without losing either call', () => {
    const outer = input([row('outer', 'uncertain')]);
    let nested: RecoveryPlan | undefined;
    Object.defineProperty(outer, 'evidence', { value: function (this: RecoveryScanInput, actual: OutboxId) {
      assert.equal(this, outer); assert.equal(actual, id('outer'));
      nested = native(input([row('inner', 'uncertain')]));
      return { kind: 'not-found' };
    } });
    const result = native(outer);
    assert.deepEqual(result.retry, [id('outer')]);
    assert.deepEqual(nested, planRecoveryScan(input([row('inner', 'uncertain')])));
  });

  it('preserves the original evidence throw and recovers without fallback after refused scalar facts', () => {
    const original = new Error('original evidence failure');
    const throwing = input([row('uncertain', 'uncertain')]);
    Object.defineProperty(throwing, 'evidence', { value: function (this: RecoveryScanInput) {
      assert.equal(this, throwing); throw original;
    } });
    assert.throws(() => native(throwing), error => error === original);
    for (const fact of ['90', 90n, false, new Number(90)]) {
      const recorded = { ...claim('claim', 90), claimedAt: fact } as unknown as DispatchClaim;
      assert.throws(() => native(input([row('claim', 'claimed')], [recorded])));
    }
    const nonstring = row('terminal', 'failed');
    nonstring.item.id = 42 as unknown as OutboxId;
    assert.throws(() => native(input([nonstring])));
    const good = input([row('after-failure', 'uncertain')]);
    assert.deepEqual(native(good), planRecoveryScan(good));
  });

  it('matches failed-row short circuit and separate nullable anchor observations', () => {
    function trace(planner: Planner, exhausted: boolean, secondAnchor: number | null | undefined) {
      const events: string[] = [];
      let anchorReads = 0, horizonReads = 0;
      const failed = row('failed', 'failed');
      const policy = { maxAttempts: 3, horizonMs: 50 };
      Object.defineProperty(policy, 'maxAttempts', { get() { events.push('policy.maxAttempts'); return 3; } });
      Object.defineProperty(policy, 'horizonMs', { get() { horizonReads++; events.push('policy.horizonMs'); return 50; } });
      Object.defineProperty(failed.item, 'attempts', { get() { events.push('item.attempts'); return exhausted ? 3 : 1; } });
      Object.defineProperty(failed, 'retryClass', { get() { events.push('row.retryClass'); return 'transient'; } });
      Object.defineProperty(failed, 'firstAttemptAtMs', { get() {
        anchorReads++; events.push(`row.anchor:${anchorReads}`); return anchorReads === 1 ? 1 : secondAnchor;
      } });
      const value = { ...input([failed]), policy };
      Object.defineProperty(value, 'nowMs', { get() { events.push('input.nowMs'); return 100; } });
      const result = planner(value);
      assert.equal(anchorReads, exhausted ? 0 : 2);
      assert.equal(horizonReads, exhausted ? 2 : 3);
      if (exhausted || secondAnchor === null) assert.deepEqual(result.dead, [id('failed')]);
      else assert.deepEqual(result.retry, [id('failed')]);
      return { result, events };
    }
    for (const exhausted of [false, true]) {
      for (const anchor of [90, null, undefined]) assert.deepEqual(trace(native, exhausted, anchor),
        trace(planRecoveryScan, exhausted, anchor));
    }
  });

  it('matches custom iterator caching and close behavior without replacing original failures', () => {
    type Mode = 'success' | 'body' | 'next' | 'done' | 'value';
    function trace(planner: Planner, channel: 'claims' | 'rows', mode: Mode) {
      const events: string[] = [];
      const original = new Error(`original ${channel} ${mode}`);
      const closeError = new Error('iterator return failure');
      let returns = 0, nextReads = 0, step = 0;
      const uncertain = row('uncertain', 'uncertain');
      const recorded = claim('claimed', 90);
      if (mode === 'body' && channel === 'claims') {
        Object.defineProperty(recorded, 'outboxId', { get() { events.push('claim.outboxId'); throw original; } });
      }
      const iterator: object = {};
      Object.defineProperty(iterator, 'next', { get() {
        nextReads++; events.push('get next');
        return function (this: object) {
          assert.equal(this, iterator); events.push('next');
          if (mode === 'next') throw original;
          const done = step++ !== 0;
          return {
            get done() { events.push('done'); if (mode === 'done') throw original; return done; },
            get value() { events.push('value'); if (mode === 'value') throw original;
              return channel === 'claims' ? recorded : uncertain; },
          };
        };
      } });
      Object.defineProperty(iterator, 'return', { value: function (this: object) {
        assert.equal(this, iterator); returns++; events.push('return'); throw closeError;
      } });
      const iterable = { [Symbol.iterator]() { events.push('iterator'); return iterator; } };
      const value: RecoveryScanInput = { ...input([]),
        ...(channel === 'claims' ? { claims: iterable as unknown as readonly DispatchClaim[] }
          : { rows: iterable as unknown as readonly RecoverableRow[] }) };
      Object.defineProperty(value, 'evidence', { value: function (this: RecoveryScanInput) {
        assert.equal(this, value); events.push('evidence');
        if (mode === 'body') throw original;
        return null;
      } });
      let result: RecoveryPlan | undefined;
      try {
        result = planner(value);
        assert.equal(mode, 'success');
      } catch (error) {
        assert.notEqual(mode, 'success'); assert.equal(error, original);
      }
      assert.equal(nextReads, 1, 'for-of caches the next method');
      assert.equal(returns, mode === 'body' ? 1 : 0);
      return { events, result, returns, nextReads };
    }
    for (const channel of ['claims', 'rows'] as const) {
      for (const mode of ['success', 'body', 'next', 'done', 'value'] as const) {
        assert.deepEqual(trace(native, channel, mode), trace(planRecoveryScan, channel, mode));
      }
    }
  });
});
