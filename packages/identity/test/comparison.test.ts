import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { timingSafeEqualBytes } from '../src/sessions/comparison.js';
import { nativeCompare as nodeCompare } from '../src/sessions/comparison-node.js';
import { nativeCompare as workerCompare } from '../src/sessions/comparison-worker.js';

test('Node byte comparison uses exact views, lengths, and empty operands', () => {
  const a = new Uint8Array([9, 1, 2, 9]).subarray(1, 3);
  const b = new Uint8Array([8, 8, 1, 2, 8]).subarray(2, 4);
  assert.equal(timingSafeEqualBytes(a, b), true);
  assert.equal(timingSafeEqualBytes(a, new Uint8Array([1, 3])), false);
  assert.equal(timingSafeEqualBytes(a, new Uint8Array([1])), false);
  assert.equal(timingSafeEqualBytes(new Uint8Array(), new Uint8Array()), true);
  assert.throws(() => nodeCompare(a, new Uint8Array([1])), RangeError);
});

test('shared guard skips unequal lengths and propagates native faults', (t) => {
  const fault = new Error('synthetic native comparison fault');
  const a = new Uint8Array([9, 1, 2]).subarray(1);
  const b = new Uint8Array([8, 1, 2]).subarray(1);
  const calls: unknown[][] = [];
  const primitive = t.mock.method(crypto, 'timingSafeEqual', (...args: unknown[]) => {
    calls.push(args);
    throw fault;
  });
  // The production leaf keeps its static builtin import. Synchronize this
  // isolated test process's builtin export after mocking the actual primitive.
  syncBuiltinESMExports();
  try {
    assert.equal(timingSafeEqualBytes(a, new Uint8Array([1])), false);
    assert.equal(calls.length, 0);
    assert.throws(() => timingSafeEqualBytes(a, b), (error) => error === fault);
    assert.deepEqual(calls, [[a, b]]);
    assert.throws(() => timingSafeEqualBytes(new Uint8Array(), new Uint8Array()), (error) => error === fault);
    assert.equal(calls.length, 2);
  } finally {
    primitive.mock.restore();
    syncBuiltinESMExports();
  }
});

test('Worker primitive preserves its subtle receiver, views, and faults', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const a = new Uint8Array([9, 1, 2]).subarray(1);
  const b = new Uint8Array([8, 1, 2]).subarray(1);
  const fault = new Error('synthetic Worker primitive fault');
  let calls = 0;
  const subtle = {
    timingSafeEqual(this: unknown, left: Uint8Array, right: Uint8Array) {
      assert.equal(this, subtle);
      assert.equal(left, a);
      assert.equal(right, b);
      calls++;
      if (calls === 2) throw fault;
      return true;
    },
  };
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { subtle } });
    assert.equal(workerCompare(a, b), true);
    assert.throws(() => workerCompare(a, b), (error) => error === fault);
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
});

test('unsupported Worker primitive is an exact operational Error', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    for (const host of [undefined, {}, { subtle: {} }, { subtle: { timingSafeEqual: true } }]) {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: host });
      for (const operand of [new Uint8Array([1]), new Uint8Array()]) {
        assert.throws(() => workerCompare(operand, operand), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.constructor, Error);
          assert.equal(error.message, 'Identity host does not provide a native timing-safe comparison.');
          return true;
        });
      }
    }
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else Reflect.deleteProperty(globalThis, 'crypto');
  }
});
