// W02.3 — lifecycle.ts conformance vs frozen independent originals.
//
// Oracle: fixtures/policy/lifecycle.json was captured from the LIVE
// donor (packages/work/src/receipt/index.ts record/reconcile paths).
// Every case runs lifecycle.ts with the recorded input and compares
// against the frozen donor output. Leaf DAG: this test imports
// lifecycle.ts ONLY (plus node builtins); no live donor import.
// Re-freeze recipe: bun run a capture importing the live donor over
// the same corpus, writing {provenance, cases}.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lifecycle from '../src/lifecycle.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = [join(HERE, 'fixtures', 'policy', 'lifecycle.json'), join(HERE, '..', '..', 'conformance', 'fixtures', 'policy', 'lifecycle.json')].find((p) => existsSync(p)) ?? join(HERE, 'fixtures', 'policy', 'lifecycle.json');

type FrozenThrow = { name: string; code?: unknown; message: string };
type FrozenCase = { id: string; fn: string; input: unknown; expect: { ok?: unknown; throw?: FrozenThrow } };

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

const fixture = JSON.parse(readFileSync(FIX, 'utf8')) as {
  provenance: { frozen_at_head: string };
  cases: FrozenCase[];
};

describe('W02.3 lifecycle vs frozen originals', () => {
  it('freeze provenance recorded', () => {
    assert.ok(fixture.provenance?.frozen_at_head, 'must record freeze HEAD');
  });
  assert.ok(fixture.cases.length > 0, 'must hold cases');
  for (const c of fixture.cases) {
    it(c.id, () => {
      const target = (lifecycle as Record<string, unknown>)[c.fn];
      assert.equal(typeof target, 'function', `lifecycle.ts must export ${c.fn}`);
      const args = thaw(c.input) as unknown[];
      let actual: unknown;
      let threw: unknown = null;
      try {
        actual = (target as (...a: never[]) => unknown)(...(args as never[]));
      } catch (e) {
        threw = e;
      }
      if (c.expect.throw !== undefined) {
        assert.ok(threw !== null, `${c.id} must throw`);
        const err = threw as { name?: unknown; message?: unknown };
        assert.equal(err?.name, c.expect.throw.name, `${c.id} error name`);
        assert.equal(err?.message, c.expect.throw.message, `${c.id} error message`);
        return;
      }
      assert.equal(threw, null, `${c.id} must not throw (got ${(threw as Error)?.message})`);
      assertFrozen(actual, c.expect.ok, c.id);
    });
  }
});
