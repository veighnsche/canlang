// W02.4 — receipt.ts conformance vs frozen independent originals.
//
// Oracle: fixtures/receipts/receipt.json was captured from the LIVE
// donors (work receipt remainder + state receipt tables). Leaf DAG:
// this test imports receipt.ts ONLY (plus node builtins); no live
// donor import. Results pass through by host reference: observation
// cases additionally assert result/error identity with the input.
// Re-freeze recipe: bun run a capture importing the live donors over
// the same corpus, writing {provenance, cases}.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as receipt from '../src/receipt.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = [join(HERE, 'fixtures', 'receipts', 'receipt.json'), join(HERE, '..', '..', 'conformance', 'fixtures', 'receipts', 'receipt.json')].find((p) => existsSync(p)) ?? join(HERE, 'fixtures', 'receipts', 'receipt.json');

type FrozenThrow = { name: string; code?: unknown; message: string };
type FrozenCase = { id: string; fn: string; input: unknown; expect: { ok?: unknown; throw?: FrozenThrow } };

function isTag(node: unknown, tag: string): boolean {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return false;
  const keys = Object.keys(node);
  return keys.length === 1 && keys[0] === tag;
}

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
      if (isTag(n, '$fn')) return (..._args: unknown[]): unknown => undefined;
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

function assertFrozen(actual: unknown, frozen: unknown, path: string): void {
  if (isTag(frozen, '$num') || isTag(frozen, '$undef')) {
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

describe('W02.4 receipt vs frozen originals', () => {
  it('freeze provenance recorded', () => {
    assert.ok(fixture.provenance?.frozen_at_head, 'must record freeze HEAD');
  });
  assert.ok(fixture.cases.length > 0, 'must hold cases');
  for (const c of fixture.cases) {
    it(c.id, () => {
      const target = (receipt as Record<string, unknown>)[c.fn];
      assert.equal(typeof target, 'function', `receipt.ts must export ${c.fn}`);
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
        const err = threw as { name?: unknown; code?: unknown; message?: unknown };
        assert.equal(err?.name, c.expect.throw.name, `${c.id} error name`);
        if ('code' in c.expect.throw) assert.deepStrictEqual(err?.code, c.expect.throw.code, `${c.id} error code`);
        assert.equal(err?.message, c.expect.throw.message, `${c.id} error message`);
        return;
      }
      assert.equal(threw, null, `${c.id} must not throw (got ${(threw as Error)?.message})`);
      assertFrozen(actual, c.expect.ok, c.id);
      if (c.fn === 'toReceiptObservation') {
        const recorded = (args[2] ?? {}) as { result?: unknown; error?: unknown };
        const out = actual as { result?: unknown; error?: unknown };
        assert.strictEqual(out.result, recorded.result, `${c.id} result passes by host reference`);
        assert.strictEqual(out.error, recorded.error, `${c.id} error passes by host reference`);
      }
    });
  }
});
