import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanValue } from '@canlang/contracts';
import { encodeValue, normalizeSchema, validateValue } from '@canlang/values';
import { bindNativeRecord, bindNativeReference, nativeRecordReference } from './native-records.js';
import { makeRecordRef } from '@canlang/values';
import { NativeValueReferenceError, nativeValueReferenceEncoder } from './native-value-schema.js';

const CUSTOMER = 'Inputs.Customer', OTHER = 'Inputs.Other';
const schema = normalizeSchema({ contracts: {
  'Inputs.Contact': { fields: { customer: { type: CUSTOMER } } },
  'Inputs.Request': { fields: {
    customer: { type: CUSTOMER }, contacts: { type: 'Inputs.Contact[]' }, optional: { type: `${CUSTOMER}?` },
    name: { type: 'Inputs.Name' }, choice: { type: `${CUSTOMER}|${OTHER}` }, count: { type: 'int' },
  } },
}, enums: { 'Inputs.Status': { cases: ['open', 'closed'] } },
  aliases: { 'Inputs.Name': { type: 'text', min: 1, max: 64, format: 'name' } } });
function native(model = CUSTOMER, version = 7) {
  let reads = 0;
  const view = Object.freeze(Object.defineProperties({}, {
    name: { enumerable: true, get() { reads++; throw new Error('business getter ran'); } },
    id: { enumerable: true, get() { reads++; throw new Error('identity getter ran'); } },
    version: { enumerable: true, get() { reads++; throw new Error('version getter ran'); } },
  }));
  bindNativeRecord(view, model, 'shared-id', version);
  return { view, reads: () => reads };
}
const value = (input: unknown) => input as CanValue;

test('typed reference callback preserves genuine identities at exact declared nested occurrences without reading native getters', () => {
  const customer = native(), other = native(OTHER, 11);
  const choice = Object.freeze({ kind: 'union', type: OTHER, value: other.view });
  const request = Object.freeze({ customer: customer.view, contacts: Object.freeze([Object.freeze({ customer: customer.view })]),
    optional: customer.view, name: 'Original', choice, count: 3n });
  const resolver = nativeValueReferenceEncoder('Inputs.Request', schema, request);
  assert.equal(resolver(value(customer.view), ['customer']), nativeRecordReference(customer.view));
  assert.equal(resolver(value(customer.view), ['contacts', 0, 'customer']), nativeRecordReference(customer.view));
  assert.equal(resolver(value(customer.view), ['optional']), nativeRecordReference(customer.view));
  assert.equal(resolver(value(other.view), ['choice', 'value']), nativeRecordReference(other.view));
  const wire = encodeValue('Inputs.Request', value(request), resolver);
  assert.deepEqual(wire, { customer: { id: 'shared-id', version: '7' }, contacts: [{ customer: { id: 'shared-id', version: '7' } }],
    optional: { id: 'shared-id', version: '7' }, name: 'Original', choice: { type: OTHER, value: { id: 'shared-id', version: '11' } }, count: '3' });
  assert.doesNotThrow(() => validateValue(schema, 'Inputs.Request', wire, 'create'));
  assert.equal(customer.reads(), 0); assert.equal(other.reads(), 0);
  const unversioned = Object.freeze({});
  const original = makeRecordRef(CUSTOMER, 'shared-id'); bindNativeReference(unversioned, original);
  assert.equal(nativeValueReferenceEncoder(CUSTOMER, undefined, unversioned)(value(unversioned), []), original);
  assert.deepEqual(encodeValue(CUSTOMER, value(unversioned), nativeValueReferenceEncoder(CUSTOMER, undefined, unversioned)), { id: 'shared-id' });
});

test('wrong-model same-id native references refuse before structural encoding can erase their model', () => {
  const wrong = native(OTHER), request = { customer: wrong.view };
  const resolver = nativeValueReferenceEncoder('Inputs.Request', schema, request);
  assert.throws(() => resolver(value(wrong.view), ['customer']), NativeValueReferenceError);
  assert.throws(() => encodeValue('Inputs.Request', value(request), resolver), NativeValueReferenceError);
  assert.equal(wrong.reads(), 0);
});

test('raw copied and unbound objects do not acquire native reference identities', () => {
  const issued = native(), copied = Object.defineProperties({}, Object.getOwnPropertyDescriptors(issued.view));
  const raw = { model: CUSTOMER, id: 'shared-id', version: 7n }, unbound = {};
  const resolver = nativeValueReferenceEncoder(CUSTOMER, schema, issued.view);
  for (const candidate of [copied, raw, unbound, makeRecordRef(CUSTOMER, 'shared-id', 7n)]) {
    assert.equal(resolver(value(candidate), []), undefined);
  }
  assert.equal(issued.reads(), 0);
  const queued = Object.freeze({ id: 'queued-id' });
  bindNativeReference(queued, makeRecordRef(CUSTOMER, 'queued-id'));
  const queuedResolver = nativeValueReferenceEncoder(CUSTOMER, schema, queued);
  assert.deepEqual(encodeValue(CUSTOMER, value(queued), queuedResolver), { id: 'queued-id' });
  const copiedQueue = { ...queued };
  assert.equal(queuedResolver(value(copiedQueue), []), undefined);
  assert.throws(() => encodeValue(CUSTOMER, value(copiedQueue),
    nativeValueReferenceEncoder(CUSTOMER, schema, copiedQueue, true)));
  const nested = { customer: queued };
  assert.deepEqual(encodeValue('Inputs.Contact', value(nested),
    nativeValueReferenceEncoder('Inputs.Contact', schema, nested, true)), { customer: { id: 'queued-id' } });
  const copiedNested = { customer: copiedQueue };
  assert.throws(() => encodeValue('Inputs.Contact', value(copiedNested),
    nativeValueReferenceEncoder('Inputs.Contact', schema, copiedNested, true)));
  const nullable = [queued];
  assert.deepEqual(encodeValue(`${CUSTOMER}[]?`, value(nullable),
    nativeValueReferenceEncoder(`${CUSTOMER}[]?`, schema, nullable, true)), [{ id: 'queued-id' }]);
  assert.equal(encodeValue(`${CUSTOMER}[]?`, null,
    nativeValueReferenceEncoder(`${CUSTOMER}[]?`, schema, null, true)), null);
});

test('genuine references require proven Model slots and their actual original occurrence', () => {
  const issued = native(), replacement = native(CUSTOMER, 9);
  for (const type of ['text', 'int', 'json', 'Inputs.Name', 'Inputs.Status', 'Inputs.Contact']) {
    assert.throws(() => nativeValueReferenceEncoder(type, schema, issued.view)(value(issued.view), []), NativeValueReferenceError, type);
  }
  const request = { customer: issued.view, name: issued.view, count: issued.view };
  const resolver = nativeValueReferenceEncoder('Inputs.Request', schema, request);
  for (const path of [['missing'], ['name'], ['count'], ['customer', 'name'], ['contacts', '0', 'customer']]) {
    assert.throws(() => resolver(value(issued.view), path), NativeValueReferenceError);
  }
  assert.throws(() => resolver(value(replacement.view), ['customer']), NativeValueReferenceError);
  assert.throws(() => nativeValueReferenceEncoder('Inputs.Request', undefined, request)(value(issued.view), ['customer']), NativeValueReferenceError);
  assert.equal(issued.reads(), 0); assert.equal(replacement.reads(), 0);
});

test('typed path and union metadata accessors never execute', () => {
  const issued = native(); let reads = 0;
  const accessor = () => { reads++; throw new Error('metadata getter ran'); };
  const request = Object.defineProperty({}, 'customer', { enumerable: true, get: accessor });
  assert.throws(() => nativeValueReferenceEncoder('Inputs.Request', schema, request)(value(issued.view), ['customer']), NativeValueReferenceError);
  const choice = Object.defineProperty({ value: issued.view }, 'type', { enumerable: true, get: accessor });
  assert.throws(() => nativeValueReferenceEncoder(`${CUSTOMER}|${OTHER}`, schema, choice)(value(issued.view), ['value']), NativeValueReferenceError);
  const path = Object.defineProperty(['customer'], '0', { enumerable: true, get: accessor });
  assert.throws(() => nativeValueReferenceEncoder('Inputs.Request', schema, { customer: issued.view })(value(issued.view), path), NativeValueReferenceError);
  assert.equal(reads, 0); assert.equal(issued.reads(), 0);
});

test('union selection must be an own declared branch and arrays use exact numeric slots', () => {
  const issued = native(OTHER);
  for (const choice of [
    { kind: 'union', type: CUSTOMER, value: issued.view },
    { kind: 'union', type: 'Inputs.Unknown', value: issued.view },
    Object.assign(Object.create({ type: OTHER }), { value: issued.view }),
  ]) {
    assert.throws(() => nativeValueReferenceEncoder(`${CUSTOMER}|${OTHER}`, schema, choice)(value(issued.view), ['value']), NativeValueReferenceError);
  }
  const request = { contacts: [{ customer: issued.view }] };
  const resolver = nativeValueReferenceEncoder('Inputs.Request', schema, request);
  for (const path of [['contacts', -1, 'customer'], ['contacts', 0.5, 'customer'], ['contacts', 1, 'customer'], ['contacts', '__proto__', 'customer']] as const) {
    assert.throws(() => resolver(value(issued.view), path), NativeValueReferenceError);
  }
  assert.equal(issued.reads(), 0);
});
