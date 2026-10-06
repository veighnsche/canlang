// W02.3 — every.ts conformance vs frozen independent originals.
//
// Oracle: fixtures/policy/every.json was captured from the LIVE donor
// (packages/work/src/schedule/every.ts). Leaf DAG: this test imports
// every.ts ONLY (plus node builtins); no live donor import.
// HOST-DERIVED FIELD: frozen `admitted[].occurrenceId` values are real
// donor sha256 ids, but hashing stays host-owned by plan, so every.ts
// takes a supplied deriveId. This suite strips occurrenceId from both
// sides for the admission comparison, then proves exactly-one
// derivation per admission with correct components by recording the
// stub's call args and comparing them as a multiset against the frozen
// admitted set. Slot/slotStartMs/admission-set/order compare exactly.
// Throw extras (code/scope on the typed root error) compare exactly.
// Re-freeze recipe: bun run a capture importing the live donor over
// the same corpus, writing {provenance, cases}.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as every from '../src/every.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = [join(HERE, 'fixtures', 'policy', 'every.json'), join(HERE, '..', '..', 'conformance', 'fixtures', 'policy', 'every.json')].find((p) => existsSync(p)) ?? join(HERE, 'fixtures', 'policy', 'every.json');

type FrozenThrow = { name: string; code?: unknown; scope?: unknown; message: string };
type FrozenCase = { id: string; fn: string; input: unknown; expect: { ok?: unknown; throw?: FrozenThrow } };
type Admitted = { occurrenceId: unknown; app: string; handler: string; scope: string; owner: string; slot: number };
type TickOk = { slot: number; slotStartMs: number; admitted: Admitted[] };

function isTag(node: unknown, tag: string): boolean {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return false;
  const keys = Object.keys(node);
  return keys.length === 1 && keys[0] === tag;
}

function thaw(node: unknown): unknown {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    if (isTag(node, '$num')) {
      const t = (node as Record<string, unknown>)['$num'];
      if (t === 'NaN') return NaN;
      if (t === 'Infinity') return Infinity;
      if (t === '-Infinity') return -Infinity;
      if (t === '-0') return -0;
      throw new Error(`bad $num tag: ${JSON.stringify(t)}`);
    }
    const o: Record<string, unknown> = {};
    for (const [k, e] of Object.entries(node)) o[k] = thaw(e);
    return o;
  }
  if (Array.isArray(node)) return node.map(thaw);
  return node;
}

function assertFrozen(actual: unknown, frozen: unknown, path: string): void {
  if (isTag(frozen, '$num')) {
    assert.deepStrictEqual(actual, thaw(frozen), path);
    return;
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

const stripId = (a: Admitted): Omit<Admitted, 'occurrenceId'> => ({
  app: a.app, handler: a.handler, scope: a.scope, owner: a.owner, slot: a.slot,
});

const fixture = JSON.parse(readFileSync(FIX, 'utf8')) as {
  provenance: { frozen_at_head: string };
  cases: FrozenCase[];
};

describe('W02.3 every vs frozen originals', () => {
  it('freeze provenance recorded', () => {
    assert.ok(fixture.provenance?.frozen_at_head, 'must record freeze HEAD');
  });
  assert.ok(fixture.cases.length > 0, 'must hold cases');
  for (const c of fixture.cases) {
    it(c.id, () => {
      const target = (every as Record<string, unknown>)[c.fn];
      assert.equal(typeof target, 'function', `every.ts must export ${c.fn}`);
      const args = thaw(c.input) as unknown[];
      const calls: Array<{ app: string; handler: string; scope: string; owner: string; slot: number }> = [];
      const callArgs = c.fn === 'admitEveryTick'
        ? [...args, (app: string, handler: string, scope: string, owner: string, slot: number) => {
            calls.push({ app, handler, scope, owner, slot });
            return `stub:${app}:${handler}:${scope}:${owner}:${slot}`;
          }]
        : args;
      let actual: unknown;
      let threw: unknown = null;
      try {
        actual = (target as (...a: never[]) => unknown)(...(callArgs as never[]));
      } catch (e) {
        threw = e;
      }
      if (c.expect.throw !== undefined) {
        assert.ok(threw !== null, `${c.id} must throw`);
        const err = threw as { name?: unknown; code?: unknown; scope?: unknown; message?: unknown };
        assert.equal(err?.name, c.expect.throw.name, `${c.id} error name`);
        if ('code' in c.expect.throw) assert.deepStrictEqual(err?.code, c.expect.throw.code, `${c.id} error code`);
        if ('scope' in c.expect.throw) assert.deepStrictEqual(err?.scope, c.expect.throw.scope, `${c.id} error scope`);
        assert.equal(err?.message, c.expect.throw.message, `${c.id} error message`);
        return;
      }
      assert.equal(threw, null, `${c.id} must not throw (got ${(threw as Error)?.message})`);
      if (c.fn === 'admitEveryTick') {
        const a = actual as TickOk;
        const f = c.expect.ok as TickOk;
        assert.equal(a.slot, f.slot, `${c.id} slot`);
        assert.equal(a.slotStartMs, f.slotStartMs, `${c.id} slotStartMs`);
        assert.equal(a.admitted.length, f.admitted.length, `${c.id} admitted length`);
        // Order-sensitive admission compare with host-derived ids stripped.
        a.admitted.forEach((adm, i) => {
          assert.deepStrictEqual(stripId(adm), stripId(f.admitted[i] as Admitted), `${c.id} admitted[${i}]`);
          assert.equal(adm.occurrenceId, `stub:${adm.app}:${adm.handler}:${adm.scope}:${adm.owner}:${adm.slot}`, `${c.id} admitted[${i}] uses supplied deriveId`);
        });
        // Exactly one derivation per admission, correct components (order-free).
        const frozenSet = f.admitted.map((adm) => JSON.stringify(stripId(adm as Admitted))).sort();
        const callSet = calls.map((call) => JSON.stringify(call)).sort();
        assert.deepStrictEqual(callSet, frozenSet, `${c.id} deriveId calls match admitted set`);
        return;
      }
      assertFrozen(actual, c.expect.ok, c.id);
    });
  }
});
