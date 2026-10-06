// W02.2 — rows.ts conformance: extracted module vs frozen independent originals.
//
// ORACLE DESIGN (plan: "compare BOTH producer directions against frozen
// originals; do not use both wrappers calling the same helper as the sole
// oracle"): fixtures/rows/*.json were captured from the LIVE donors
// (packages/work/src/kernel/tables.ts + packages/state/src/fanout/
// tables.ts) by an independent capture run (bun, direct src imports).
// Every case below runs rows.ts with the recorded input and compares
// against the frozen donor output — work-direction cases against the
// work donor's bytes, state-direction cases against the state donor's
// bytes. The oracle is the frozen bytes, not a second wrapper over
// rows.ts, and not a live donor cross-check.
//
// LEAF DAG: this test imports rows.ts ONLY (plus node builtins). It
// deliberately does not import the live donors: a work-kernel file
// importing work/state sources would violate the contracts-only leaf.
// Live-donor conformance is established at freeze time (the capture
// imports live donors) and re-established by re-freeze, never by a
// committed live import.
//
// INPUT/OUTPUT TAGS (JSON cannot spell these; thaw revives them):
//   {$num:'NaN'|'Infinity'|'-Infinity'|'-0'}  exact JS numerics
//   {$fn:true}    any function (compared by typeof only)
//   {$sym:true}   any symbol (compared by typeof only)
//   {$bigint:'N'} BigInt
//   {$undef:true} undefined
//   {$ref:'$.path'} cyclic back-reference (inputs only; outputs acyclic)
// ENGINE ERRORS: URIError/DataCloneError messages are engine-specific
// (capture ran under bun/JSC, this suite under node/V8). For those two
// names the suite compares name (+code) only, never message. All
// KernelTableError/StateError messages compare exactly.
// checkFanoutIdentitySet: the work donor keeps it private, so the
// direct unit freeze is state-only. rows.ts is still exercised in the
// work direction against the same success value (the sort/dedup logic
// is textually identical in both donors, and the work new-ok-sorted /
// new-duplicate cases pin it end-to-end); work-direction throws assert
// name 'KernelTableError' with the identical message text.
// RE-FREEZE RECIPE (deliberate, never automatic): bun run a capture
// importing both live donor sources over the same case corpus, writing
// fixtures/rows/*.json with {provenance:{frozen_at_head, donors,
// donor_digests}, cases:[{id, direction, fn, input, expect}]}. Then
// re-run this suite: any donor drift surfaces as a frozen mismatch to
// adjudicate, not to auto-update.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as rows from '../src/rows.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// Fixtures ship with sources; a dist run falls back to the source tree.
const FIXDIR = [join(HERE, 'fixtures', 'rows'), join(HERE, '..', '..', 'conformance', 'fixtures', 'rows')].find((p) => existsSync(p)) ?? join(HERE, 'fixtures', 'rows');

type FrozenThrow = { name: string; code?: unknown; message: string };
type FrozenCase = {
  id: string;
  direction: 'work' | 'state';
  fn: string;
  input: unknown;
  expect: { ok?: unknown; throw?: FrozenThrow };
};

/** Fns taking an appended `direction` argument in rows.ts. */
const DIRECTIONED = new Set([
  'checkFanoutIdentitySet',
  'fanoutIntentRowId',
  'fanoutCheckpointRowId',
  'fanoutChildRowId',
  'newFanoutIntentRow',
  'newFanoutCheckpointRow',
  'nextFanoutCheckpointData',
  'newFanoutChildRow',
  'readFanoutIntentRow',
  'readFanoutCheckpointRow',
  'readFanoutChildRow',
  'fanoutChildPageQuery',
  'fanoutChildPageResult',
]);

/** Engine-native errors: compare name (+code), never message. */
const ENGINE_ERRORS = new Set(['URIError', 'DataCloneError']);

function isTag(node: unknown, tag: string): boolean {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return false;
  const keys = Object.keys(node);
  return keys.length === 1 && keys[0] === tag;
}

/** Revive frozen tags to live values (two-pass for $ref cycles). */
function thaw(node: unknown): unknown {
  const byPath = new Map<string, unknown>();
  const build = (n: unknown, path: string): unknown => {
    if (n !== null && typeof n === 'object') {
      if (Array.isArray(n)) {
        const a: unknown[] = [];
        byPath.set(path, a);
        n.forEach((e, i) => a.push(build(e, `${path}[${i}]`)));
        return a;
      }
      if (isTag(n, '$num')) {
        const t = (n as Record<string, unknown>)['$num'];
        if (t === 'NaN') return NaN;
        if (t === 'Infinity') return Infinity;
        if (t === '-Infinity') return -Infinity;
        if (t === '-0') return -0;
        throw new Error(`bad $num tag: ${JSON.stringify(t)}`);
      }
      if (isTag(n, '$fn')) return (..._args: unknown[]): undefined => undefined;
      if (isTag(n, '$sym')) return Symbol('frozen');
      if (isTag(n, '$bigint')) return BigInt((n as Record<string, unknown>)['$bigint'] as string);
      if (isTag(n, '$undef')) return undefined;
      if (isTag(n, '$ref')) return { $deferredRef: (n as Record<string, unknown>)['$ref'] };
      const o: Record<string, unknown> = {};
      byPath.set(path, o);
      for (const [k, e] of Object.entries(n)) o[k] = build(e, `${path}.${k}`);
      return o;
    }
    return n;
  };
  const resolve = (n: unknown): unknown => {
    if (n !== null && typeof n === 'object') {
      if (Array.isArray(n)) {
        for (let i = 0; i < n.length; i++) n[i] = resolve(n[i]);
        return n;
      }
      const rec = n as Record<string, unknown>;
      if (isTag(rec, '$deferredRef')) {
        const target = byPath.get(rec['$deferredRef'] as string);
        if (target === undefined) throw new Error(`dangling $ref ${String(rec['$deferredRef'])}`);
        return target;
      }
      for (const k of Object.keys(rec)) rec[k] = resolve(rec[k]);
      return n;
    }
    return n;
  };
  return resolve(build(node, '$'));
}

/** Compare actual output against the frozen tree ($fn/$sym by typeof). */
function assertFrozen(actual: unknown, frozen: unknown, path: string): void {
  if (isTag(frozen, '$fn')) {
    assert.equal(typeof actual, 'function', `${path} must be a function`);
    return;
  }
  if (isTag(frozen, '$sym')) {
    assert.equal(typeof actual, 'symbol', `${path} must be a symbol`);
    return;
  }
  if (isTag(frozen, '$num') || isTag(frozen, '$bigint') || isTag(frozen, '$undef')) {
    assert.deepStrictEqual(actual, thaw(frozen), path);
    return;
  }
  if (isTag(frozen, '$ref')) {
    throw new Error(`${path}: frozen outputs must be acyclic`);
  }
  if (Array.isArray(frozen)) {
    assert.ok(Array.isArray(actual), `${path} must be an array`);
    const a = actual as unknown[];
    assert.equal(a.length, frozen.length, `${path} length`);
    frozen.forEach((e, i) => assertFrozen(a[i], e, `${path}[${i}]`));
    return;
  }
  if (frozen !== null && typeof frozen === 'object') {
    assert.ok(actual !== null && typeof actual === 'object' && !Array.isArray(actual), `${path} must be an object`);
    const a = actual as Record<string, unknown>;
    const f = frozen as Record<string, unknown>;
    assert.deepStrictEqual(Object.keys(a).sort(), Object.keys(f).sort(), `${path} keys`);
    for (const k of Object.keys(f)) assertFrozen(a[k], f[k], `${path}.${k}`);
    return;
  }
  assert.deepStrictEqual(actual, frozen, path);
}

function assertFrozenThrow(actual: unknown, expected: FrozenThrow, path: string): void {
  const err = actual as { name?: unknown; code?: unknown; message?: unknown };
  assert.equal(err?.name, expected.name, `${path} error name`);
  if ('code' in expected) {
    assert.deepStrictEqual(err?.code, expected.code, `${path} error code`);
  }
  if (!ENGINE_ERRORS.has(expected.name)) {
    assert.equal(err?.message, expected.message, `${path} error message`);
  }
}

function runRowsFn(fn: string, args: unknown[], direction: 'work' | 'state'): unknown {
  const target = (rows as Record<string, unknown>)[fn];
  assert.equal(typeof target, 'function', `rows.ts must export ${fn}`);
  const call = target as (...a: never[]) => unknown;
  const argv = (DIRECTIONED.has(fn) ? [...args, direction] : args) as unknown[] as never[];
  return call(...argv);
}

function checkCase(file: string, c: FrozenCase, direction: 'work' | 'state', note: string): void {
  const path = `${file}/${c.id}[${direction}]${note}`;
  const args = thaw(c.input) as unknown[];
  let actual: unknown;
  let threw: unknown = null;
  try {
    actual = runRowsFn(c.fn, args, direction);
  } catch (e) {
    threw = e;
  }
  if (c.expect.throw !== undefined) {
    // Work-direction identity-set unit: same text, work error name, no code.
    const expected: FrozenThrow =
      c.fn === 'checkFanoutIdentitySet' && direction === 'work'
        ? { name: 'KernelTableError', message: c.expect.throw.message }
        : c.expect.throw;
    assert.ok(threw !== null, `${path} must throw`);
    assertFrozenThrow(threw, expected, path);
    return;
  }
  assert.equal(threw, null, `${path} must not throw (got ${(threw as Error)?.message})`);
  assertFrozen(actual, c.expect.ok, path);
}

const FILES = readdirSync(FIXDIR).filter((f) => f.endsWith('.json')).sort();
assert.ok(FILES.length === 8, `expected 8 row fixture files, got ${FILES.length}`);

describe('W02.2 rows vs frozen originals', () => {
  let total = 0;
  for (const file of FILES) {
    const fixture = JSON.parse(readFileSync(join(FIXDIR, file), 'utf8')) as {
      provenance: { frozen_at_head: string; donors: Record<string, string> };
      cases: FrozenCase[];
    };
    assert.ok(fixture.provenance?.frozen_at_head, `${file} must record its freeze HEAD`);
    assert.ok(fixture.cases.length > 0, `${file} must hold cases`);
    for (const c of fixture.cases) {
      total += 1;
      it(`${file}/${c.id} [${c.direction}]`, () => {
        checkCase(file, c, c.direction, '');
      });
      // Identity-set unit freeze is state-only (work keeps it private):
      // also pin the work direction against the same frozen value.
      if (c.fn === 'checkFanoutIdentitySet' && c.direction === 'state') {
        total += 1;
        it(`${file}/${c.id} [work-pinned]`, () => {
          checkCase(file, c, 'work', ' (state-frozen value, work error name)');
        });
      }
    }
  }
  it('corpus is non-trivial', () => {
    assert.ok(total >= 100, `expected >= 100 checks, got ${total}`);
  });
});
