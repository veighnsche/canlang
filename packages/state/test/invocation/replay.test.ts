/**
 * Lane 03 S3 replay-hash tests: canonical encoding (sorted keys, omission
 * vs null, submitted-version sensitivity) and fail-closed JSON-unsafe
 * values. The hash is the replay-identity comparison, so distinct inputs
 * must never share one.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { hashAdmittedInputs, hashInputs, stableStringify } from '../../src/invocation/replay.js';
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

describe('bounded admission hashes', () => {
  it('preserves complete raw canonical bytes, presence and existing scalar domains', async () => {
    const ownProto = JSON.parse('{"__proto__":{"kept":true},"z":0}');
    const inputs = [
      {}, { x: null }, { x: false }, { x: '' }, { x: -0 },
      { x: [1e-7, 1e21, Number.MIN_VALUE, Number.MAX_VALUE, '\ud800', '😀'] },
      ownProto, { '\uffff': 'last', '😀': 'pair', '\ud800': 'lone', a: 'first' },
      { x: new String('ab') }, { x: new Number(7) },
      { x: Object.assign(Object.create({ inherited: 'ignored' }), { a: 1 }) },
      { x: new Date('2026-10-11T00:00:00Z') },
      { x: { toJSON: () => ({ b: 2, a: [null] }), ignored: undefined } },
    ];
    for (const input of inputs) assert.equal(await hashAdmittedInputs(input), await hashInputs(input));
    const canonical = '{"a":[true,null],"b":1}';
    const golden = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))),
      byte => byte.toString(16).padStart(2, '0')).join('');
    assert.equal(await hashAdmittedInputs({ b: 1, a: [true, null] }), golden);
    assert.notEqual(await hashAdmittedInputs({}), await hashAdmittedInputs({ x: null }));
  });

  it('evaluates sorted getters and toJSON once in the existing order, preserving thrown identity', async () => {
    function source(trace: string[]): Record<string, unknown> {
      const child = Object.defineProperty({}, 'toJSON', { get() {
        trace.push('toJSON:get');
        return function () { trace.push('toJSON:call'); return ['kept', null]; };
      } });
      return Object.defineProperties({}, {
        z: { enumerable: true, get() { trace.push('z'); return child; } },
        a: { enumerable: true, get() { trace.push('a'); return -0; } },
        hidden: { get() { assert.fail('ignored getter'); } },
      });
    }
    const oldTrace: string[] = [], boundedTrace: string[] = [];
    assert.equal(await hashAdmittedInputs(source(boundedTrace)), await hashInputs(source(oldTrace)));
    assert.deepEqual(boundedTrace, ['a', 'z', 'toJSON:get', 'toJSON:get', 'toJSON:call']);
    assert.deepEqual(boundedTrace, oldTrace);
    const boom = new Error('original getter failure');
    await assert.rejects(hashAdmittedInputs(Object.defineProperty({}, 'x', {
      enumerable: true, get() { throw boom; },
    })), error => error === boom);
    const array = Object.assign([1], { ignored: undefined, [Symbol('ignored')]: 2 });
    assert.equal(await hashAdmittedInputs({ x: array }), await hashInputs({ x: [1] }));
    const trace: string[] = [];
    const dynamic = new Proxy([1, 2], { get(target, name, receiver) {
      trace.push(String(name)); return Reflect.get(target, name, receiver);
    } });
    await hashAdmittedInputs({ x: dynamic });
    assert.deepEqual(trace, ['toJSON', 'length', '0', 'length', '1', 'length']);
  });

  it('enforces reachable text, expanded-visit and depth boundaries before digest', async () => {
    const limit = (error: unknown) => error instanceof StateError && error.code === 'limit' &&
      error.retryable === false && error.details === null;
    const digest = mock.method(crypto.subtle, 'digest');
    async function refused(input: Record<string, unknown>): Promise<void> {
      const before = digest.mock.callCount();
      await assert.rejects(hashAdmittedInputs(input), limit);
      assert.equal(digest.mock.callCount(), before, 'resource refusal precedes digest');
    }
    try {
      const exactText = { x: '\u0000'.repeat(1_999_999) };
      assert.equal(await hashAdmittedInputs(exactText), await hashInputs(exactText));
      // Six escaped bytes per UTF16 unit plus bounded punctuation, not a
      // separately reachable 12,640,000-byte input requirement.
      assert.equal(new TextEncoder().encode(stableStringify(exactText)).length, 12_000_002);
      await refused({ x: 'a'.repeat(2_000_000) });
      const exactNodes = { x: Array(19_998).fill(null) };
      assert.equal(await hashAdmittedInputs(exactNodes), await hashInputs(exactNodes));
      let indexReads = 0;
      const tooWide = Array(19_999).fill(null);
      Object.defineProperty(tooWide, '0', { get() { indexReads++; return null; } });
      await refused({ x: tooWide });
      assert.equal(indexReads, 0);
      let leaf: unknown = null;
      for (let i = 0; i < 31; i++) leaf = [leaf];
      assert.equal(await hashAdmittedInputs({ x: leaf }), await hashInputs({ x: leaf }));
      await refused({ x: [leaf] });
      const shared = Array(9_998).fill(null);
      assert.equal(await hashAdmittedInputs({ a: shared, b: shared }), await hashInputs({ a: shared, b: shared }));
      await refused({ a: shared, b: shared, c: shared });
      const cycle: Record<string, unknown> = {}; cycle['self'] = cycle;
      await refused(cycle);
      // The public protocol is intentionally not capped.
      assert.match(await hashInputs({ x: [leaf] }), /^[0-9a-f]{64}$/);
    } finally { digest.mock.restore(); }
  });

  it('retains unsafe-value refusals, including holes and unsafe toJSON results', async () => {
    for (const x of [undefined, () => 1, Symbol('x'), 1n, NaN, Infinity, Array(1),
      { [Symbol('key')]: 1 }, { toJSON: () => 1n }]) {
      await assert.rejects(hashAdmittedInputs({ x }), error => error instanceof StateError && error.code === 'validation');
    }
  });

  it('uses the same actual emitted hash producer in Node and Worker', { timeout: 30_000 }, async () => {
    const modulePaths = ['invocation/replay.js', 'errors.js', 'storage/port.js'];
    const modules = await Promise.all(modulePaths.map(async path => ({
      type: 'ESModule' as const, path,
      contents: await readFile(new URL(`../../src/${path}`, import.meta.url), 'utf8'),
    })));
    const mf = new Miniflare({ compatibilityDate: '2025-07-18', modules: [
      { type: 'ESModule', path: 'worker.js', contents: `
        import { hashAdmittedInputs } from './invocation/replay.js';
        export default { async fetch(request) {
          try { return Response.json({ hash: await hashAdmittedInputs(await request.json()) }); }
          catch (error) { return Response.json({ code: error.code, retryable: error.retryable }); }
        } };
      ` }, ...modules,
    ] });
    try {
      for (const input of [{ b: 1, a: [true, null, '\ud800', '😀', -0, 1e21] },
        JSON.parse('{"__proto__":{"kept":true},"default":null}'), { x: 'a'.repeat(1_999_999) }]) {
        const response = await mf.dispatchFetch('http://localhost/', { method: 'POST', body: JSON.stringify(input) });
        assert.deepEqual(await response.json(), { hash: await hashAdmittedInputs(input) });
      }
      const response = await mf.dispatchFetch('http://localhost/', { method: 'POST',
        body: JSON.stringify({ x: 'a'.repeat(2_000_000) }) });
      assert.deepEqual(await response.json(), { code: 'limit', retryable: false });
    } finally { await mf.dispose(); }
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
