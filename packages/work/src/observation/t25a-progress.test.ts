/**
 * T25a receipt progress: monotone revision fencing and current-attempt
 * correlation — stale attempts never overwrite newer associations.
 * ISOLATED MECHANISM proofs: pure transitions over supplied records, no
 * store, no fence execution. The MEMORY-ONLY lifecycle below uses a
 * test-local map; durable (D1/DO) proofs ride with the L3 join (after
 * T18). Terminal immutability is T26's scope, not this fence's.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AssociatedReceipt,
  ReceiptAssociation,
} from '../../../contracts/src/work.js';
import {
  TestOnlyAllowAllGrants,
  TestOnlyAvailabilityMap,
  TestOnlyGrantSet,
} from './ports.ts';
import {
  applyReceiptProgress,
  matchAssociatedCompletion,
} from './association.ts';
import type { ReceiptProgress } from './association.ts';
import { observeSelectedReceipt } from './observation.ts';
import type { StoredReceipt } from './observation.ts';

const NOW = 1_791_120_000_000;

function association(overrides: Partial<ReceiptAssociation> = {}): ReceiptAssociation {
  return {
    locator: { recordId: 'rec_1', field: 'notification' },
    deliveryId: 'del_1',
    source: 'Mail.send',
    revision: 7,
    ...overrides,
  };
}

function receiptRow(overrides: Partial<AssociatedReceipt> = {}): AssociatedReceipt {
  return {
    deliveryId: 'del_1',
    revision: 7,
    status: 'pending',
    result: null,
    error: null,
    ...overrides,
  };
}

function progress(overrides: Partial<ReceiptProgress> = {}): ReceiptProgress {
  return {
    delivery_id: 'del_1',
    source: 'Mail.send',
    revision: 8,
    status: 'succeeded',
    result: { reference: 'm_1' },
    error: null,
    ...overrides,
  };
}

describe('t25a progress: monotone application', () => {
  it('advances both records to the progress revision with its payload', () => {
    const outcome = applyReceiptProgress(association(), receiptRow(), progress());
    assert.deepEqual(outcome, {
      applied: true,
      association: association({ revision: 8 }),
      receipt: {
        deliveryId: 'del_1',
        revision: 8,
        status: 'succeeded',
        result: { reference: 'm_1' },
        error: null,
      },
    });
  });

  it('replays equal revisions idempotently', () => {
    // Same revision carries identical business content per the adapter
    // contract, so re-applying is a no-op with fresh records.
    const first = applyReceiptProgress(association(), receiptRow(), progress({ revision: 7 }));
    assert.equal(first.applied, true);
    if (first.applied) {
      assert.deepEqual(first.association, association({ revision: 7 }));
      const second = applyReceiptProgress(first.association, first.receipt, progress({ revision: 7 }));
      assert.deepEqual(second, first);
      assert.notEqual(second, first);
    }
  });

  it('ignores extra envelope fields beyond the progress keys', () => {
    const outcome = applyReceiptProgress(association(), receiptRow(), {
      ...progress(),
      provider_trace: 'trace_1',
      retryable: true,
    });
    assert.equal(outcome.applied, true);
  });

  it('normalizes missing payload keys to null', () => {
    const { result, error, ...rest } = progress({ status: 'skipped', result: null });
    void result;
    void error;
    const outcome = applyReceiptProgress(association(), receiptRow(), rest);
    assert.deepEqual(outcome, {
      applied: true,
      association: association({ revision: 8 }),
      receipt: { deliveryId: 'del_1', revision: 8, status: 'skipped', result: null, error: null },
    });
  });
});

describe('t25a progress: stale attempts never overwrite', () => {
  it('refuses older revisions without touching either record', () => {
    const held = association();
    const stored = receiptRow();
    const outcome = applyReceiptProgress(held, stored, progress({ revision: 6 }));
    assert.deepEqual(outcome, { applied: false, reason: 'stale-revision' });
    assert.deepEqual(held, association());
    assert.deepEqual(stored, receiptRow());
  });

  it('refuses superseded-attempt progress: old attempts keep their own receipts', () => {
    const outcome = applyReceiptProgress(
      association({ deliveryId: 'del_new' }),
      receiptRow({ deliveryId: 'del_new' }),
      progress({ delivery_id: 'del_old', revision: 99 }),
    );
    assert.deepEqual(outcome, { applied: false, reason: 'id-mismatch' });
  });

  it('refuses foreign sources', () => {
    const outcome = applyReceiptProgress(
      association(),
      receiptRow(),
      progress({ source: 'Billing.charge' }),
    );
    assert.deepEqual(outcome, { applied: false, reason: 'source-mismatch' });
  });

  it('refuses malformed progress without throwing', () => {
    const malformed: unknown[] = [
      null,
      undefined,
      0,
      'del_1',
      [],
      {},
      { delivery_id: 'del_1', source: 'Mail.send' },
      { ...progress(), delivery_id: '' },
      { ...progress(), source: '' },
      { ...progress(), revision: -1 },
      { ...progress(), revision: 1.5 },
    ];
    for (const envelope of malformed) {
      assert.deepEqual(applyReceiptProgress(association(), receiptRow(), envelope), {
        applied: false,
        reason: 'malformed-completion',
      });
    }
  });

  it('refuses inconsistent envelopes without throwing', () => {
    const inconsistent: ReceiptProgress[] = [
      progress({ status: 'pending', result: null }),
      progress({ status: 'succeeded', error: { code: 'x', message: 'y' } }),
      progress({ status: 'failed', result: { reference: 'm_1' }, error: null }),
      progress({ status: 'failed', error: null }),
      progress({ status: 'unknown', result: { reference: 'm_1' } }),
      progress({ status: 'skipped', result: { reference: 'm_1' }, error: null }),
    ];
    for (const envelope of inconsistent) {
      assert.deepEqual(applyReceiptProgress(association(), receiptRow(), envelope), {
        applied: false,
        reason: 'inconsistent-envelope',
      });
    }
  });

  it('checks correlation before consistency', () => {
    // A superseded id with an inconsistent payload reports the
    // correlation failure: consistency runs only after a match.
    assert.deepEqual(
      applyReceiptProgress(
        association(),
        receiptRow(),
        progress({ delivery_id: 'del_old', status: 'pending', result: { bogus: true } }),
      ),
      { applied: false, reason: 'id-mismatch' },
    );
    assert.deepEqual(
      applyReceiptProgress(
        association(),
        receiptRow(),
        progress({ revision: 6, status: 'pending', result: { bogus: true } }),
      ),
      { applied: false, reason: 'stale-revision' },
    );
  });

  it('matches the correlation verdict of matchAssociatedCompletion', () => {
    // Structural pin: progress application delegates correlation to the
    // existing matcher, so their verdicts agree on every input class.
    const cases: unknown[] = [
      progress(),
      progress({ revision: 6 }),
      progress({ delivery_id: 'del_old' }),
      progress({ source: 'Billing.charge' }),
      null,
      {},
    ];
    for (const envelope of cases) {
      const match = matchAssociatedCompletion('del_1', envelope, 'Mail.send', 7);
      const outcome = applyReceiptProgress(association(), receiptRow(), envelope);
      if (outcome.applied) {
        assert.deepEqual(match, { matched: true, reason: 'matched' });
      } else if (outcome.reason !== 'inconsistent-envelope') {
        assert.deepEqual(match, { matched: false, reason: outcome.reason });
      }
    }
  });
});

describe('t25a progress: trusted store agreement throws loudly', () => {
  it('rejects misshapen associations and receipts', () => {
    assert.throws(
      () => applyReceiptProgress(association({ deliveryId: '' }), receiptRow(), progress()),
      /association\.deliveryId/,
    );
    assert.throws(
      () => applyReceiptProgress(association({ source: '' }), receiptRow(), progress()),
      /association\.source/,
    );
    assert.throws(
      () => applyReceiptProgress(association({ revision: -1 }), receiptRow(), progress()),
      /association\.revision/,
    );
    assert.throws(
      () => applyReceiptProgress(association(), receiptRow({ deliveryId: '' }), progress()),
      /receipt\.deliveryId/,
    );
    assert.throws(
      () => applyReceiptProgress(association(), receiptRow({ revision: 1.5 }), progress()),
      /receipt\.revision/,
    );
  });

  it('rejects foreign receipts and revision skew', () => {
    assert.throws(
      () =>
        applyReceiptProgress(association(), receiptRow({ deliveryId: 'del_other' }), progress()),
      /does not belong/,
    );
    assert.throws(
      () => applyReceiptProgress(association(), receiptRow({ revision: 8 }), progress()),
      /disagrees/,
    );
  });

  it('never mutates its inputs', () => {
    const held = association();
    const stored = receiptRow();
    const envelope = progress();
    Object.freeze(held);
    Object.freeze(stored);
    Object.freeze(envelope);
    const outcome = applyReceiptProgress(held, stored, envelope);
    assert.equal(outcome.applied, true);
    assert.deepEqual(held, association());
    assert.deepEqual(stored, receiptRow());
  });
});

describe('t25a lifecycle on the memory map (MEMORY-ONLY)', () => {
  it('replaces the association without letting stale progress overwrite it', () => {
    // Test-local association map standing in for the committing store.
    // MEMORY-ONLY: single-owner, non-durable, non-atomic. The durable
    // lifecycle rides with the L3 join (after T18).
    const map = new Map<string, { held: ReceiptAssociation; stored: StoredReceipt }>();
    const record = { id: 'rec_1' };
    const key = 'rec_1\0notification';
    map.set(key, {
      held: association({ deliveryId: 'del_old', revision: 0 }),
      stored: {
        deliveryId: 'del_old',
        revision: 0,
        status: 'pending',
        result: null,
        error: null,
        contentRef: null,
      },
    });

    const apply = (envelope: ReceiptProgress): string => {
      const slot = map.get(key);
      assert.ok(slot !== undefined);
      const outcome = applyReceiptProgress(slot.held, slot.stored, envelope);
      if (outcome.applied) {
        map.set(key, {
          held: outcome.association,
          stored: { ...outcome.receipt, contentRef: null },
        });
        return 'applied';
      }
      return outcome.reason;
    };
    const statusOf = (): unknown => {
      const slot = map.get(key);
      assert.ok(slot !== undefined);
      const outcome = observeSelectedReceipt({
        locator: { record, field: 'notification' },
        selected: ['status'],
        association: slot.held,
        receipt: slot.stored,
        grants: new TestOnlyGrantSet(['status']),
        content: new TestOnlyAvailabilityMap(),
        nowMs: NOW,
      });
      assert.equal(outcome.outcome, 'observed');
      return outcome.outcome === 'observed' ? outcome.projection.status : null;
    };

    // Old attempt succeeds; the status-only reader sees it.
    assert.equal(
      apply({
        delivery_id: 'del_old',
        source: 'Mail.send',
        revision: 1,
        status: 'succeeded',
        result: { reference: 'old' },
        error: null,
      }),
      'applied',
    );
    assert.equal(statusOf(), 'succeeded');

    // Replacement selects the new attempt (an ordinary domain write by the
    // join); the old receipt row is retained but no longer current.
    const slot = map.get(key);
    assert.ok(slot !== undefined);
    assert.equal(slot.stored.result !== null, true);
    map.set(key, {
      held: association({ deliveryId: 'del_new', revision: 0 }),
      stored: {
        deliveryId: 'del_new',
        revision: 0,
        status: 'pending',
        result: null,
        error: null,
        contentRef: null,
      },
    });
    assert.equal(statusOf(), 'pending');

    // Late high-revision progress for the superseded attempt cannot
    // overwrite the new association; neither can a stale revision of it.
    assert.equal(
      apply({
        delivery_id: 'del_old',
        source: 'Mail.send',
        revision: 99,
        status: 'failed',
        result: null,
        error: { code: 'late', message: 'late' },
      }),
      'id-mismatch',
    );
    assert.equal(
      apply({
        delivery_id: 'del_new',
        source: 'Mail.send',
        revision: 1,
        status: 'succeeded',
        result: { reference: 'new' },
        error: null,
      }),
      'applied',
    );
    assert.equal(statusOf(), 'succeeded');
    // Equal-revision replay carries identical content per the adapter
    // contract and re-applies idempotently; a genuinely older revision is
    // refused instead (correlation reports before consistency).
    assert.equal(
      apply({
        delivery_id: 'del_new',
        source: 'Mail.send',
        revision: 1,
        status: 'succeeded',
        result: { reference: 'new' },
        error: null,
      }),
      'applied',
    );
    assert.equal(
      apply({
        delivery_id: 'del_new',
        source: 'Mail.send',
        revision: 0,
        status: 'pending',
        result: null,
        error: null,
      }),
      'stale-revision',
    );

    // Full-grant readers still observe the retained new-attempt payload;
    // the status-only boundary holds throughout.
    const current = map.get(key);
    assert.ok(current !== undefined);
    const full = observeSelectedReceipt({
      locator: { record, field: 'notification' },
      selected: ['id', 'status', 'result', 'error'],
      association: current.held,
      receipt: current.stored,
      grants: new TestOnlyAllowAllGrants(),
      content: new TestOnlyAvailabilityMap(),
      nowMs: NOW,
    });
    assert.deepEqual(full, {
      outcome: 'observed',
      projection: { id: 'del_new', status: 'succeeded', result: { reference: 'new' }, error: null },
      fenceRevision: 1,
    });
  });
});
