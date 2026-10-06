// W02.4 — linkage.ts conformance vs frozen independent originals.
//
// Oracle: fixtures/receipts/linkage.json was captured from the LIVE
// donors (state transact + state receipt join assertions). Leaf DAG:
// this test imports linkage.ts ONLY (plus node builtins); no live
// donor import. Throw code compares (StateError validation); void
// returns freeze as {$undef}. Re-freeze recipe: bun run a capture
// importing the live donors over the same corpus, writing
// {provenance, cases}.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as linkage from '../src/linkage.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = [join(HERE, 'fixtures', 'receipts', 'linkage.json'), join(HERE, '..', '..', 'conformance', 'fixtures', 'receipts', 'linkage.json')].find((p) => existsSync(p)) ?? join(HERE, 'fixtures', 'receipts', 'linkage.json');

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
    if (isTag(node, '$undef')) return undefined;
    const o: Record<string, unknown> = {};
    for (const [k, e] of Object.entries(node)) o[k] = thaw(e);
    return o;
  }
  if (Array.isArray(node)) return node.map(thaw);
  return node;
}

const fixture = JSON.parse(readFileSync(FIX, 'utf8')) as {
  provenance: { frozen_at_head: string };
  cases: FrozenCase[];
};

describe('W02.4 linkage vs frozen originals', () => {
  it('freeze provenance recorded', () => {
    assert.ok(fixture.provenance?.frozen_at_head, 'must record freeze HEAD');
  });
  assert.ok(fixture.cases.length > 0, 'must hold cases');
  for (const c of fixture.cases) {
    it(c.id, () => {
      const target = (linkage as Record<string, unknown>)[c.fn];
      assert.equal(typeof target, 'function', `linkage.ts must export ${c.fn}`);
      const args = thaw(c.input) as unknown[];
      let actual: unknown = 'unreached';
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
      assert.deepStrictEqual(actual, thaw(c.expect.ok), `${c.id} returns void`);
    });
  }
});
