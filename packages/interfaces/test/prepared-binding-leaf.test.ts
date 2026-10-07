import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DerivedOperationInputs, DerivedWritableInput } from '@canlang/contracts';
import { prepareHttpPlan } from '../src/envelope/prepared.js';
import { prepareMcpPlan } from '../src/mcp/prepared.js';
import type { OperationDescriptor, OperationInputShape } from '../src/ports.js';

const operation = 'acme.keys';
const descriptor: OperationDescriptor = { name: operation, kind: 'read', description: '', inputs: { fields: [] } };
const shape: OperationInputShape = { allowed: ['choice'], required: [] };
const derived = (input: DerivedWritableInput): DerivedOperationInputs => ({ operation, kind: 'read', artifactVersion: 1, inputs: [input] });
const builders = [
  { name: 'HTTP', build: (d: DerivedOperationInputs, s = shape) => prepareHttpPlan(operation, s, d) },
  { name: 'MCP', build: (d: DerivedOperationInputs, s = shape) => prepareMcpPlan(descriptor, s, d) },
];

for (const { name, build } of builders) {
  test(`${name} construction reads binding members in order and clones/freezes enum values`, () => {
    const calls: string[] = [];
    const enumValues = ['a', 'b'];
    const values: DerivedWritableInput = { name: 'choice', kind: 'enum', required: false, enumValues };
    const input = new Proxy(values, { get(target, key, receiver) { calls.push(String(key)); return Reflect.get(target, key, receiver); } });
    assert.deepEqual(calls, []);
    const plan = build(derived(input));
    assert.deepEqual(calls, ['name', 'kind', 'required', 'nullable', 'array', 'versioned', 'enumValues', 'enumValues', 'kind', 'kind', 'kind']);
    const entry = plan.binding[0]!;
    assert.deepEqual(entry.enumValues, ['a', 'b']);
    assert.notEqual(entry.enumValues, enumValues);
    enumValues.push('c');
    assert.deepEqual(entry.enumValues, ['a', 'b']);
    assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.binding) && Object.isFrozen(entry) && Object.isFrozen(entry.enumValues));
  });

  test(`${name} mismatch precedes shape/binding construction and binding getter throws in place`, () => {
    let reads = 0;
    const input = new Proxy({ name: 'choice', kind: 'enum', required: false } as DerivedWritableInput, {
      get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver); },
    });
    const poisonedShape: OperationInputShape = { get allowed(): readonly string[] { throw new Error('shape'); }, required: [] };
    assert.throws(() => build({ ...derived(input), operation: 'wrong.name' }, poisonedShape), /derived inputs name "wrong.name"/);
    assert.equal(reads, 0);
    assert.throws(() => build(derived(input), poisonedShape), /^Error: shape$/);
    assert.equal(reads, 0);
    const getterError = new Error('enum getter');
    const log: string[] = [];
    const throwing = new Proxy(input, { get(target, key, receiver) {
      log.push(String(key));
      if (key === 'enumValues') throw getterError;
      return Reflect.get(target, key, receiver);
    } });
    assert.throws(() => build(derived(throwing)), (err) => err === getterError);
    assert.deepEqual(log, ['name', 'kind', 'required', 'nullable', 'array', 'versioned', 'enumValues']);
  });
}
