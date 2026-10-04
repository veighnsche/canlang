/**
 * S3 envelope tests: operation IDs, closed inputs, ref codecs, versions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OperationInputShape } from '../src/ports.js';
import {
  OPERATION_ID_FUTURE_TOLERANCE_MS,
  OPERATION_ID_MAX_AGE_MS,
  UUID_V7_PATTERN,
  checkClosedInputs,
  extractUuidV7Ms,
  validateOperationId,
} from '../src/envelope/validate.js';
import { MAX_ID_LENGTH, parseMutationRef, parseReadRef } from '../src/envelope/refs.js';
import { checkExpectedVersion } from '../src/envelope/versions.js';

/** Test-only UUIDv7 maker: `ms` in the 48-bit time_hi field. */
function v7At(ms: number): string {
  const t = ms.toString(16).padStart(12, '0');
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-7abc-8def-abcdef123456`;
}

const V4 = '550e8400-e29b-41d4-a716-446655440000';

test('DESIGN-pinned operation-id bounds', () => {
  assert.equal(OPERATION_ID_MAX_AGE_MS, 24 * 60 * 60 * 1000);
  assert.equal(OPERATION_ID_FUTURE_TOLERANCE_MS, 5 * 60 * 1000);
});

test('UUID_V7_PATTERN pins version nibble 7 and variant 8/9/a/b', () => {
  assert.ok(UUID_V7_PATTERN.test(v7At(Date.now())));
  assert.ok(!UUID_V7_PATTERN.test(V4)); // version nibble 4
  assert.ok(!UUID_V7_PATTERN.test('not-a-uuid'));
  assert.ok(!UUID_V7_PATTERN.test(''));
});

test('extractUuidV7Ms round-trips the 48-bit timestamp', () => {
  const ms = 1_700_000_000_000;
  assert.equal(extractUuidV7Ms(v7At(ms)), ms);
  assert.equal(extractUuidV7Ms(V4), null);
  assert.equal(extractUuidV7Ms('bogus'), null);
});

test('validateOperationId accepts current and in-tolerance ids', () => {
  const now = Date.now();
  const clock = { nowMs: () => now };
  assert.equal(validateOperationId(v7At(now), clock), null);
  assert.equal(validateOperationId(v7At(now + 4 * 60 * 1000), clock), null);
  assert.equal(validateOperationId(v7At(now - 23 * 60 * 60 * 1000), clock), null);
  // Exact bounds pass (rejection is strictly beyond).
  assert.equal(validateOperationId(v7At(now - OPERATION_ID_MAX_AGE_MS), clock), null);
  assert.equal(validateOperationId(v7At(now + OPERATION_ID_FUTURE_TOLERANCE_MS), clock), null);
  // Default clock: a freshly minted id validates.
  assert.equal(validateOperationId(v7At(Date.now())), null);
});

test('validateOperationId rejects expired and future ids', () => {
  const now = Date.now();
  const clock = { nowMs: () => now };
  const expired = validateOperationId(v7At(now - 25 * 60 * 60 * 1000), clock);
  assert.equal(expired?.code, 'validation');
  assert.equal(expired?.message, 'Expired operation_id.');
  const future = validateOperationId(v7At(now + 6 * 60 * 1000), clock);
  assert.equal(future?.code, 'validation');
  assert.equal(future?.message, 'operation_id is from the future.');
});

test('validateOperationId rejects malformed and non-string ids', () => {
  const clock = { nowMs: () => Date.now() };
  for (const bad of ['not-a-uuid', '', V4, '550e8400-e29b-71d4-c716-446655440000']) {
    const err = validateOperationId(bad, clock);
    assert.equal(err?.code, 'validation');
    assert.equal(err?.message, 'Invalid operation_id.');
  }
  for (const bad of [42, null, undefined, {}, ['x'], true]) {
    const err = validateOperationId(bad, clock);
    assert.equal(err?.code, 'validation');
    assert.equal(err?.message, 'Invalid operation_id.');
  }
});

const SHAPE: OperationInputShape = { allowed: ['title', 'due'], required: ['title'] };

test('checkClosedInputs accepts exact and partial-but-sufficient inputs', () => {
  assert.equal(checkClosedInputs({ title: 't', due: 'd' }, SHAPE), null);
  assert.equal(checkClosedInputs({ title: 't' }, SHAPE), null);
  // Explicit null is present (omission vs null stays distinct).
  assert.equal(checkClosedInputs({ title: null }, SHAPE), null);
});

test('checkClosedInputs names the first unknown key', () => {
  const err = checkClosedInputs({ zzz: 1, title: 't', aaa: 2 }, SHAPE);
  assert.equal(err?.code, 'validation');
  assert.ok(err?.message.includes('zzz'));
  assert.deepEqual(err?.fields, [
    { path: '/zzz', code: 'unknown', message: `Unknown input 'zzz'.` },
  ]);
});

test('checkClosedInputs names the first missing required key', () => {
  const shape: OperationInputShape = { allowed: ['a', 'b'], required: ['a', 'b'] };
  const err = checkClosedInputs({}, shape);
  assert.equal(err?.code, 'validation');
  assert.ok(err?.message.includes('a'));
  assert.deepEqual(err?.fields, [
    { path: '/a', code: 'required', message: `Missing required input 'a'.` },
  ]);
});

test('checkClosedInputs rejects non-object inputs without throwing', () => {
  for (const bad of [null, undefined, 42, 'x', [1]]) {
    const err = checkClosedInputs(bad as never, SHAPE);
    assert.equal(err?.code, 'validation');
  }
});

test('parseReadRef accepts a bare id', () => {
  assert.deepEqual(parseReadRef({ id: 'abc' }), { ref: { id: 'abc' } });
  assert.deepEqual(parseReadRef({ id: 'x'.repeat(MAX_ID_LENGTH) }), {
    ref: { id: 'x'.repeat(MAX_ID_LENGTH) },
  });
});

test('parseReadRef rejects malformed ids and non-objects', () => {
  for (const value of [null, 42, 'x', [1], {}, { id: '' }, { id: 4 }, { id: 'x'.repeat(257) }]) {
    const out = parseReadRef(value);
    assert.ok('error' in out, `expected error for ${JSON.stringify(value)}`);
    assert.equal(out.error.code, 'validation');
  }
});

test('parseReadRef rejects extra members, naming the member', () => {
  const out = parseReadRef({ id: 'a', version: '1' });
  assert.ok('error' in out);
  assert.equal(out.error.code, 'validation');
  assert.ok(out.error.message.includes('version'));
  assert.deepEqual(out.error.fields, [
    { path: '/version', code: 'unknown', message: `Unknown member 'version'.` },
  ]);
});

test('parseMutationRef accepts id plus canonical version strings', () => {
  assert.deepEqual(parseMutationRef({ id: 'a', version: '4' }), {
    ref: { id: 'a', version: '4' },
  });
  const huge = '1' + '0'.repeat(100);
  assert.deepEqual(parseMutationRef({ id: 'a', version: huge }), {
    ref: { id: 'a', version: huge },
  });
});

test('parseMutationRef rejects non-string versions, including JSON numbers', () => {
  for (const version of [4, 4.5, '', '-3', '4.0', ' 4', '4 ', '0x10', 'abc', null]) {
    const out = parseMutationRef({ id: 'a', version });
    assert.ok('error' in out, `expected error for ${JSON.stringify(version)}`);
    assert.equal(out.error.code, 'validation');
    assert.deepEqual(out.error.fields, [
      { path: '/record/version', code: 'invalid', message: 'Invalid record version.' },
    ]);
  }
});

test('parseMutationRef rejects bad ids, extras, and non-objects', () => {
  const badId = parseMutationRef({ id: '', version: '1' });
  assert.ok('error' in badId);
  assert.deepEqual(badId.error.fields, [
    { path: '/record/id', code: 'invalid', message: 'Invalid record id.' },
  ]);
  const extra = parseMutationRef({ id: 'a', version: '1', zed: true });
  assert.ok('error' in extra);
  assert.ok(extra.error.message.includes('zed'));
  const nonObject = parseMutationRef(null);
  assert.ok('error' in nonObject);
  assert.equal(nonObject.error.code, 'validation');
});

test('parseMutationRef honors a custom fieldPath', () => {
  const out = parseMutationRef({ id: 'a', version: 'nope' }, '/args/todo');
  assert.ok('error' in out);
  assert.deepEqual(out.error.fields, [
    { path: '/args/todo/version', code: 'invalid', message: 'Invalid record version.' },
  ]);
});

test('checkExpectedVersion agrees on equal versions, however large', () => {
  assert.equal(checkExpectedVersion('4', '4'), null);
  const huge = '1' + '0'.repeat(100); // 2^100 scale
  assert.ok(BigInt(huge) > 2n ** 100n);
  assert.equal(checkExpectedVersion(huge, huge), null);
});

test('checkExpectedVersion conflicts on stale versions', () => {
  const err = checkExpectedVersion('4', '5');
  assert.equal(err?.code, 'conflict');
  assert.equal(err?.message, 'Record changed since it was read.');
  assert.deepEqual(err?.fields, [
    {
      path: '/record/version',
      code: 'stale',
      message: 'Expected version 4; current version is 5.',
    },
  ]);
  const hugeStale = checkExpectedVersion('1' + '0'.repeat(100), '2' + '0'.repeat(100));
  assert.equal(hugeStale?.code, 'conflict');
});

test('checkExpectedVersion honors a custom fieldPath and fails malformed safely', () => {
  const err = checkExpectedVersion('1', '2', '/args/todo/version');
  assert.deepEqual(err?.fields, [
    {
      path: '/args/todo/version',
      code: 'stale',
      message: 'Expected version 1; current version is 2.',
    },
  ]);
  for (
    const [submitted, current] of [
      ['abc', '4'],
      ['4', 'xyz'],
      ['', ''],
      ['4.5', '4'],
      [' ', '4'],
      ['0x10', '16'],
    ] as const
  ) {
    const malformed = checkExpectedVersion(submitted, current);
    assert.equal(malformed?.code, 'validation');
  }
  for (const bad of [null, undefined, 4, {}]) {
    assert.equal(checkExpectedVersion(bad as never, '4')?.code, 'validation');
    assert.equal(checkExpectedVersion('4', bad as never)?.code, 'validation');
  }
});
