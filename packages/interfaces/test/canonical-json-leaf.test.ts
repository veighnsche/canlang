import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../src/http/canonical-json.js';
import { projectExportCell } from '../src/http/export.js';

test('canonical pair preserves holes, absent values, numeric and UTF16 bytes', () => {
  const sparse = new Array<unknown>(3);
  sparse[1] = undefined;
  assert.equal(canonicalJson(sparse), '[,null,]');
  assert.equal(canonicalJson({ z: undefined, a: null, n: NaN, zero: -0, text: '\uD800\n"' }),
    '{"a":null,"n":null,"text":"\\ud800\\n\\\"","z":null,"zero":0}');
  assert.equal(projectExportCell({ nested: sparse }), '{"nested":[,null,]}');
});

test('canonical pair reads own enumerable values before sorting and recursive reads', () => {
  const reads: string[] = [];
  const value = Object.create({ inherited: 'excluded' }) as Record<string, unknown>;
  Object.defineProperties(value, {
    z: { enumerable: true, get() { reads.push('z'); return { get nested() { reads.push('z.nested'); return 2; } }; } },
    a: { enumerable: true, get() { reads.push('a'); return { get nested() { reads.push('a.nested'); return 1; } }; } },
    hidden: { enumerable: false, get() { throw new Error('must not read non-enumerable'); } },
  });
  Object.defineProperty(value, Symbol('excluded'), { enumerable: true, value: 'excluded' });
  assert.equal(projectExportCell(value), '{"a":{"nested":1},"z":{"nested":2}}');
  assert.deepEqual(reads, ['z', 'a', 'a.nested', 'z.nested']);
});

test('canonical pair preserves getter exception identity before sorted traversal', () => {
  const marker = new Error('getter marker');
  const reads: string[] = [];
  const value = { get z() { reads.push('z'); throw marker; }, get a() { reads.push('a'); return 1; } };
  assert.throws(() => projectExportCell(value), (error: unknown) => error === marker);
  assert.deepEqual(reads, ['z']);
});

test('canonical pair keeps Date and toJSON profile and BigInt/cycle failures', () => {
  let jsonCalls = 0;
  const value = { toJSON() { jsonCalls += 1; return 'replacement'; }, z: 1 };
  assert.equal(projectExportCell(value), '{"toJSON":null,"z":1}');
  assert.equal(jsonCalls, 0);
  assert.equal(projectExportCell(new Date('2024-01-01T00:00:00Z')), '{}');
  assert.throws(() => projectExportCell({ n: 1n }), TypeError);
  const cycle: Record<string, unknown> = {};
  cycle['self'] = cycle;
  assert.throws(() => projectExportCell(cycle), RangeError);
});
