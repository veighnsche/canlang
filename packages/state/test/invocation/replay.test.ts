/**
 * Lane 03 S3 replay-hash tests: canonical encoding (sorted keys, omission
 * vs null, submitted-version sensitivity) and fail-closed JSON-unsafe
 * values. The hash is the replay-identity comparison, so distinct inputs
 * must never share one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashInputs, stableStringify } from '../../src/invocation/replay.js';
import { StateError } from '../../src/errors.js';

describe('stableStringify', () => {
  it('sorts object keys recursively', () => {
    assert.equal(stableStringify({ b: 1, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":1}');
  });

  it('encodes omission differently from explicit null', () => {
    assert.notEqual(stableStringify({}), stableStringify({ title: null }));
    assert.equal(stableStringify({ title: null }), '{"title":null}');
  });

  it('is sensitive to submitted versions', () => {
    const v1 = stableStringify({ expense: { id: 'rec-1', version: '1' } });
    const v2 = stableStringify({ expense: { id: 'rec-1', version: '2' } });
    assert.notEqual(v1, v2);
  });

  it('fails closed on JSON-unsafe values', () => {
    for (const unsafe of [
      { n: 10n },
      { u: undefined },
      { f: () => 1 },
      { s: Symbol('s') },
      { n: Number.NaN },
      { n: Number.POSITIVE_INFINITY },
      { nested: { deep: [1n] } },
    ]) {
      assert.throws(() => stableStringify(unsafe), StateError);
    }
  });

  it('fails closed on symbol-keyed inputs instead of collapsing them', () => {
    assert.throws(() => stableStringify({ [Symbol('k')]: 1 } as unknown as object), StateError);
  });

  it('cannot smuggle unsafe values through toJSON', () => {
    const smuggled = { toJSON: () => 10n };
    assert.throws(() => stableStringify({ v: smuggled }), StateError);
  });
});

describe('hashInputs', () => {
  it('is a stable lowercase hex SHA-256 over the canonical encoding', async () => {
    const a = await hashInputs({ b: 1, a: [true, null] });
    const b = await hashInputs({ a: [true, null], b: 1 });
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it('distinguishes omission from null and versions from each other', async () => {
    const omitted = await hashInputs({});
    const nulled = await hashInputs({ title: null });
    assert.notEqual(omitted, nulled);
    const v1 = await hashInputs({ expense: { id: 'rec-1', version: '1' } });
    const v2 = await hashInputs({ expense: { id: 'rec-1', version: '2' } });
    assert.notEqual(v1, v2);
  });
});
