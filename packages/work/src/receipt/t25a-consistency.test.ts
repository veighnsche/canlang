/**
 * T25a completion-envelope consistency (DESIGN 8.0): a completion status
 * agrees with its payload, or the envelope is refused. ISOLATED MECHANISM
 * proof: pure predicate over supplied values, no store, no fetch.
 * Envelope admission into stored receipts rides with the L3 join (after
 * T18); durable proofs ride with it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isConsistentCompletion, toReceiptObservation } from './index.ts';

const ERROR = { code: 'rejected', message: 'nope' };

describe('t25a consistency: accepted status/payload triples', () => {
  it('accepts succeeded with a result and a null error', () => {
    assert.equal(isConsistentCompletion('succeeded', { reference: 'pay_1' }, null), true);
  });

  it('accepts succeeded with a genuinely-null result', () => {
    // A nullable/no-result operation follows its declared result type
    // rather than inventing a value; shape is the checker's job, not this
    // kernel's.
    assert.equal(isConsistentCompletion('succeeded', null, null), true);
  });

  it('accepts failed with a null result and a closed error', () => {
    assert.equal(isConsistentCompletion('failed', null, ERROR), true);
  });

  it('accepts unknown with a null result and a diagnostic error or null', () => {
    assert.equal(isConsistentCompletion('unknown', null, ERROR), true);
    assert.equal(isConsistentCompletion('unknown', null, null), true);
  });

  it('accepts skipped with nulls', () => {
    assert.equal(isConsistentCompletion('skipped', null, null), true);
  });
});

describe('t25a consistency: refused triples', () => {
  it('refuses succeeded carrying an error', () => {
    assert.equal(isConsistentCompletion('succeeded', { reference: 'pay_1' }, ERROR), false);
  });

  it('refuses failed carrying a result or missing its error', () => {
    assert.equal(isConsistentCompletion('failed', { reference: 'pay_1' }, ERROR), false);
    assert.equal(isConsistentCompletion('failed', null, null), false);
  });

  it('refuses unknown carrying a result', () => {
    assert.equal(isConsistentCompletion('unknown', { reference: 'pay_1' }, null), false);
  });

  it('refuses skipped carrying a result or an error', () => {
    assert.equal(isConsistentCompletion('skipped', { reference: 'pay_1' }, null), false);
    assert.equal(isConsistentCompletion('skipped', null, ERROR), false);
  });

  it('refuses pending: a receipt is never progress', () => {
    assert.equal(isConsistentCompletion('pending', null, null), false);
  });

  it('refuses unknown statuses without throwing', () => {
    for (const status of [null, undefined, 0, '', 'none', 'delivered', 'canceled', {}, []]) {
      assert.equal(isConsistentCompletion(status, null, null), false);
    }
  });

  it('refuses malformed errors without throwing', () => {
    const malformed: unknown[] = [
      0,
      'rejected',
      true,
      [],
      {},
      { code: 'rejected' },
      { message: 'nope' },
      { code: 7, message: 'nope' },
      { code: 'rejected', message: null },
      { code: null, message: 'nope' },
    ];
    for (const error of malformed) {
      assert.equal(isConsistentCompletion('failed', null, error), false);
      assert.equal(isConsistentCompletion('unknown', null, error), false);
    }
  });
});

describe('t25a consistency: transport boundaries', () => {
  it('reads missing payload keys as null', () => {
    // Transport serialization drops undefined keys; a missing key is null,
    // not a second failure shape.
    assert.equal(isConsistentCompletion('succeeded', undefined, undefined), true);
    assert.equal(isConsistentCompletion('skipped', undefined, undefined), true);
    assert.equal(isConsistentCompletion('unknown', undefined, undefined), true);
    assert.equal(isConsistentCompletion('failed', undefined, undefined), false);
  });

  it('accepts the closed string-pair error shape only', () => {
    // Empty strings are non-null, so they satisfy the doc's required-field
    // rule; closedness is about the key set, not string content.
    assert.equal(isConsistentCompletion('failed', null, { code: '', message: '' }), true);
    // Extra fields are refused, not ignored: the standard DeliveryError
    // carries no details/retryable/provider-response members.
    assert.equal(
      isConsistentCompletion('failed', null, { code: 'x', message: 'y', retryable: true }),
      false,
    );
  });
});

describe('t25a consistency: extras rejection (closed DeliveryError)', () => {
  const EXTRAS: unknown[] = [
    { code: 'rejected', message: 'nope', details: { provider: 'acme' } },
    { code: 'rejected', message: 'nope', retryable: true },
    { code: 'rejected', message: 'nope', 'provider-response': { status: 500 } },
    { code: 'rejected', message: 'nope', stack: 'Error: nope' },
    { code: 'rejected', message: 'nope', extra: undefined },
  ];

  it('refuses failed errors carrying extras', () => {
    for (const error of EXTRAS) {
      assert.equal(isConsistentCompletion('failed', null, error), false);
    }
  });

  it('refuses unknown diagnostic errors carrying extras', () => {
    for (const error of EXTRAS) {
      assert.equal(isConsistentCompletion('unknown', null, error), false);
    }
  });

  it('admits only the exact {code, message} pair, so retained observations never carry extras', () => {
    // Admission is the single gate: applyReceiptProgress refuses every
    // envelope this predicate rejects as inconsistent-envelope, so only
    // exact-pair errors can reach retention and toReceiptObservation.
    assert.equal(isConsistentCompletion('failed', null, ERROR), true);
    assert.equal(isConsistentCompletion('unknown', null, ERROR), true);
    const observed = toReceiptObservation('delivery', 0, {
      status: 'failed',
      result: null,
      error: ERROR,
    });
    assert.deepEqual(Object.keys(observed.error ?? {}).sort(), ['code', 'message']);
  });
});
