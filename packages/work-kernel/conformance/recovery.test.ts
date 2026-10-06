// W02.4 — recovery.ts conformance vs frozen independent originals.
//
// Oracle: fixtures/receipts/recovery.json was captured from the LIVE
// donor (work recovery). Leaf DAG: this test imports recovery.ts ONLY
// (plus node builtins); no live donor import. Injected suppliers and
// resolvers revive from frozen tables: {$resolver:{id:value}} becomes
// (id|item)=>table lookup; {$supplierPages:[...]} becomes a scripted
// page supplier (calls recorded; scan/drain cases assert the cursor
// chain threads page-to-page). Re-freeze recipe: bun run a capture
// importing the live donor over the same corpus, writing
// {provenance, cases}.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as recovery from '../src/recovery.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = [join(HERE, 'fixtures', 'receipts', 'recovery.json'), join(HERE, '..', '..', 'conformance', 'fixtures', 'receipts', 'recovery.json')].find((p) => existsSync(p)) ?? join(HERE, 'fixtures', 'receipts', 'recovery.json');

type FrozenThrow = { name: string; code?: unknown; message: string };
type FrozenCase = { id: string; fn: string; input: unknown; expect: { ok?: unknown; throw?: FrozenThrow } };
type Page = { rows: unknown[]; nextCursor: string | null };

function isTag(node: unknown, tag: string): boolean {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return false;
  const keys = Object.keys(node);
  return keys.length === 1 && keys[0] === tag;
}

function thaw(node: unknown, calls?: Array<{ cursor: unknown; limit: unknown }>): unknown {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    if (isTag(node, '$num')) {
      const t = (node as Record<string, unknown>)['$num'];
      if (t === 'NaN') return NaN;
      if (t === 'Infinity') return Infinity;
      if (t === '-Infinity') return -Infinity;
      if (t === '-0') return -0;
      throw new Error(`bad $num tag: ${JSON.stringify(t)}`);
    }
    if (isTag(node, '$resolver')) {
      const table = thaw((node as Record<string, unknown>)['$resolver']) as Record<string, unknown>;
      return (idOrItem: unknown): unknown => {
        const id = typeof idOrItem === 'string' ? idOrItem : (idOrItem as { id: string }).id;
        return table[id] ?? null;
      };
    }
    if (isTag(node, '$supplierPages')) {
      const pages = thaw((node as Record<string, unknown>)['$supplierPages']) as Page[];
      let i = 0;
      return (cursor: unknown, limit: unknown): Page => {
        calls?.push({ cursor, limit });
        const page = pages[i];
        i += 1;
        if (page === undefined) throw new Error('supplier script exhausted');
        return { rows: [...page.rows], nextCursor: page.nextCursor };
      };
    }
    const o: Record<string, unknown> = {};
    for (const [k, e] of Object.entries(node)) o[k] = thaw(e, calls);
    return o;
  }
  if (Array.isArray(node)) return node.map((e) => thaw(e, calls));
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

describe('W02.4 recovery vs frozen originals', () => {
  it('freeze provenance recorded', () => {
    assert.ok(fixture.provenance?.frozen_at_head, 'must record freeze HEAD');
  });
  assert.ok(fixture.cases.length > 0, 'must hold cases');
  for (const c of fixture.cases) {
    it(c.id, () => {
      const target = (recovery as Record<string, unknown>)[c.fn];
      assert.equal(typeof target, 'function', `recovery.ts must export ${c.fn}`);
      const calls: Array<{ cursor: unknown; limit: unknown }> = [];
      const args = thaw(c.input, calls) as unknown[];
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
      if ((c.fn === 'scanDueBatch' || c.fn === 'drainDueScan') && calls.length > 0) {
        // Cursor chain threads page-to-page from the start cursor.
        const pages = (c.input as unknown[]).flatMap((a) => {
          const rec = a as Record<string, unknown>;
          return rec !== null && typeof rec === 'object' && '$supplierPages' in rec
            ? [(rec['$supplierPages'] as Page[])]
            : [];
        })[0] ?? [];
        const startOpt = (c.input as unknown[]).find((a) => a !== null && typeof a === 'object' && !Array.isArray(a) && !('$supplierPages' in (a as object))) as { cursor?: unknown; startCursor?: unknown } | undefined;
        let want: unknown = startOpt?.cursor ?? startOpt?.startCursor ?? null;
        calls.forEach((call, i) => {
          assert.deepStrictEqual(call.cursor, want, `${c.id} call ${i} cursor threads`);
          want = (pages[i] as Page | undefined)?.nextCursor ?? null;
        });
      }
    });
  }
});
