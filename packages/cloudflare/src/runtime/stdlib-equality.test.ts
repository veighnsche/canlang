import assert from 'node:assert/strict';
import test from 'node:test';
import type { CanValue } from '@canlang/contracts';
import { makeRecordRef, ValueError } from '@canlang/values';
import type { HandlerContext } from './context.js';
import { bindNativeRecord, nativeRecordReference } from './native-records.js';
import { equalValue } from './stdlib.js';

test('both equality ABIs use private native identities inside Contracts and arrays without business reads or context access', () => {
  const view = Object.freeze(Object.defineProperty({}, 'kind', { enumerable: true,
    get: () => assert.fail('native identity must not read business fields') }));
  bindNativeRecord(view, 'Input.Customer', 'customer', 2);
  const stored = { customer: makeRecordRef('Input.Customer', 'customer', 1n) }, hydrated = { customer: view as CanValue };
  const context = new Proxy({} as HandlerContext, { get: () => assert.fail('equality must not inspect context') });
  const order: string[] = [], left = () => { order.push('left'); return stored; }, right = () => { order.push('right'); return hydrated; };
  assert.equal(equalValue('Input', left(), right()), true); assert.deepEqual(order, ['left', 'right']); order.length = 0;
  assert.equal(equalValue(context, 'Input[]', [left()], [right()]), true); assert.deepEqual(order, ['left', 'right']);
  assert.equal(nativeRecordReference(hydrated.customer)?.version, 2n);
  assert.equal(equalValue('Input', stored, { customer: makeRecordRef('Input.Customer', 'other') }), false);
  const copy = Object.freeze({}); assert.equal(nativeRecordReference(copy), undefined);
  assert.throws(() => equalValue('Input', stored, { customer: copy }), error => error instanceof ValueError && error.code === 'invalid-construction');
});

test('native equality preserves ordinary short circuits and original demanded getter failures', () => {
  let reads = 0; const original = new Error('Original demanded field failure');
  const bad = Object.defineProperty({}, 'field', { enumerable: true, get: () => { reads++; throw original; } }) as CanValue;
  assert.equal(equalValue('Input', null, bad), false);
  assert.equal(equalValue('Input[]', [], [bad]), false);
  assert.equal(equalValue('Input', {}, bad), false);
  assert.equal(reads, 0);
  assert.throws(() => equalValue('Input', { field: true }, bad), error => error === original);
  assert.equal(reads, 1);
});
