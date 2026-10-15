import assert from 'node:assert/strict';
import { it } from 'node:test';
import { bindNativeReadBooleanContext, bindNativeReadBooleanReader,
  forwardNativeReadBooleanReader, nativeReadBoolean } from './native-read-boolean.js';

it('requires the installed context or actual selected reader and preserves false', async () => {
  const context = Object.freeze({}), original = () => false, subject = Object.freeze({ id: 'item' });
  const calls: unknown[][] = [];
  await assert.rejects(nativeReadBoolean(context, original, subject), /installed request reader/);
  bindNativeReadBooleanContext(context, async (fn, row) => { calls.push([fn, row]); return false; });
  assert.equal(await nativeReadBoolean(context, original, subject), false);
  assert.deepEqual(calls, [[original, subject]]);
  assert.throws(() => bindNativeReadBooleanContext(context, async () => true), /cannot be rebound/);
  await assert.rejects(nativeReadBoolean({ ...context }, original, subject), /installed request reader/);

  const reader = () => [], outer = () => [];
  let active = true;
  bindNativeReadBooleanReader(reader, async (fn, row) => {
    assert.equal(fn, original); assert.equal(row, subject); return false;
  });
  forwardNativeReadBooleanReader(outer, async () => { if (!active) throw new Error('scope closed'); return reader; });
  const presentation = { canonical: Object.freeze({ readRecords: outer }) };
  assert.equal(await nativeReadBoolean(presentation, original, subject), false);
  active = false;
  await assert.rejects(nativeReadBoolean(presentation, original, subject), /scope closed/);
  await assert.rejects(nativeReadBoolean({ canonical: { readRecords: () => [] } }, original, subject), /installed request reader/);
  let accessed = false;
  await assert.rejects(nativeReadBoolean({ get canonical() { accessed = true; return presentation.canonical; } }, original, subject), /installed request reader/);
  assert.equal(accessed, false);
});
