/**
 * S3 projection tests: allowlist leaf projection per DESIGN section 4.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasGrantedPath, projectFields } from '../src/projection/project.js';

/** Recursively freeze a JSON-ish value; any input write then throws. */
function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    return Object.freeze(value);
  }
  return value;
}

test('hasGrantedPath matches exact grants and parent subsumption', () => {
  assert.equal(hasGrantedPath(['a', 'a.b'], 'a'), true);
  assert.equal(hasGrantedPath(['a', 'a.b'], 'a.b'), true);
  // A granted parent covers unlisted descendants, mirroring projectFields.
  assert.equal(hasGrantedPath(['a'], 'a.c'), true);
  assert.equal(hasGrantedPath(['a.b'], 'a.c'), false);
  assert.equal(hasGrantedPath(['a.b'], 'a'), false);
  assert.equal(hasGrantedPath([], 'a'), false);
});

test('full grant returns an equal but fresh object', () => {
  const record = { a: 1, b: 'two' };
  const out = projectFields(record, ['a', 'b']);
  assert.deepEqual(out, { a: 1, b: 'two' });
  assert.notEqual(out, record);
});

test('subset grant omits denied leaves as absent keys, never null', () => {
  const record = { a: 1, b: 2 };
  const out = projectFields(record, ['a']);
  assert.deepEqual(out, { a: 1 });
  assert.ok(!('b' in out));
  const serialized = JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
  assert.ok(!('b' in serialized));
});

test('nested leaf keeps only the granted path without siblings', () => {
  const record = { a: { b: 1, c: 2 }, d: 3 };
  const out = projectFields(record, ['a.b']);
  assert.deepEqual(out, { a: { b: 1 } });
  assert.ok(!('c' in (out['a'] as Record<string, unknown>)));
  assert.ok(!('d' in out));
});

test('empty grants project to an empty object', () => {
  assert.deepEqual(projectFields({ a: 1 }, []), {});
});

test('granted null values pass through; null prefixes serialize null', () => {
  assert.deepEqual(projectFields({ a: null }, ['a']), { a: null });
  assert.deepEqual(projectFields({ n: null }, ['n.status']), { n: null });
});

test('unknown paths throw (grants come from checked policies)', () => {
  assert.throws(() => projectFields({ a: 1 }, ['nope']), Error);
  assert.throws(() => projectFields({ a: { b: 1 } }, ['a.nope']), Error);
  assert.throws(() => projectFields({ a: 1 }, ['']), Error);
  assert.throws(() => projectFields({ a: 1 }, ['a..b']), Error);
  assert.throws(() => projectFields({ a: 1 }, [42 as unknown as string]), Error);
  assert.throws(() => projectFields({ a: 1 }, ['__proto__']), Error);
  assert.throws(() => projectFields({ a: 1 }, ['a.__proto__']), Error);
});

test('cyclic records fail with a clean error, not stack exhaustion', () => {
  const record: Record<string, unknown> = { a: 1 };
  record['self'] = record;
  assert.throws(() => projectFields(record, ['self']), /nesting depth/);
});

test('arrays project whole-leaf only; descent into arrays throws', () => {
  const record = { tags: ['x', 'y'] };
  const out = projectFields(record, ['tags']);
  assert.deepEqual(out, { tags: ['x', 'y'] });
  assert.notEqual(out['tags'], record.tags);
  assert.throws(() => projectFields(record, ['tags.0']), Error);
  assert.throws(() => projectFields({ a: 1 }, ['a.b']), Error);
});

test('parent grants subsume descendants regardless of order', () => {
  const record = { a: { b: 1, c: 2 }, d: 3 };
  assert.deepEqual(projectFields(record, ['a', 'a.b']), { a: { b: 1, c: 2 } });
  assert.deepEqual(projectFields(record, ['a.b', 'a']), { a: { b: 1, c: 2 } });
});

test('projection never mutates its input', () => {
  const record = deepFreeze({ a: { b: [1, { c: 2 }] }, d: 'x' });
  const out = projectFields(record, ['a.b', 'd']);
  assert.deepEqual(out, { a: { b: [1, { c: 2 }] }, d: 'x' });
  // Output shares no references with the input: mutating it is safe.
  const nested = out['a'] as Record<string, unknown>;
  const list = nested['b'] as unknown[];
  list.push(999);
  (list[1] as Record<string, unknown>)['c'] = 'mutated';
  nested['b'] = list;
  assert.deepEqual(record, { a: { b: [1, { c: 2 }] }, d: 'x' });
});
