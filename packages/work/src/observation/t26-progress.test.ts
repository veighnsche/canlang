/**
 * T26 associated observable progress: relation correlation, terminal
 * immutability, cancellation, late usage and per-relation notification.
 * ISOLATED MECHANISM proofs: pure transitions over supplied records, no
 * store, no fence execution. The MEMORY-ONLY lifecycle below uses a
 * test-local map; durable (D1/DO) restart proofs ride the recovery
 * durable suite. Every relation of the T26 universe qualifies
 * independently through the same battery; no cross-relation inference.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AssociatedReceipt,
  ProgressTerminalNotification,
  ReceiptAssociation,
  ReceiptStatus,
} from '../../../contracts/src/work.js';
import { isTerminalReceiptStatus } from '../receipt/index.ts';
import {
  TestOnlyAllowAllGrants,
  TestOnlyAvailabilityMap,
} from './ports.ts';
import {
  T26_KNOWN_RELATION_TARGETS,
  applyRelatedProgress,
  assertKnownProgressRelation,
  cancelRelatedProgress,
  isKnownProgressRelation,
} from './association.ts';
import type { RelatedReceiptProgress } from './association.ts';
import { observeRelatedProgress } from './observation.ts';
import type { StoredReceipt } from './observation.ts';

const NOW = 1_791_120_000_000;
const SOURCE = 'Testprogress.send';

function association(overrides: Partial<ReceiptAssociation> = {}): ReceiptAssociation {
  return {
    locator: { recordId: 'rec_1', field: 'notification' },
    deliveryId: 'del_1',
    source: SOURCE,
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

function progress(
  relation: string,
  overrides: Partial<RelatedReceiptProgress> = {},
): RelatedReceiptProgress {
  return {
    relation,
    delivery_id: 'del_1',
    source: SOURCE,
    revision: 8,
    status: 'succeeded',
    result: { relation, marker: 'ok' },
    error: null,
    ...overrides,
  };
}

function stored(row: AssociatedReceipt): StoredReceipt {
  return { ...row, contentRef: null };
}

describe('t26 relation universe', () => {
  it('qualifies 16 relations (ordered T13 equality pinned in contracts)', () => {
    assert.equal(T26_KNOWN_RELATION_TARGETS.length, 16);
    assert.equal(new Set(T26_KNOWN_RELATION_TARGETS).size, 16);
    for (const target of T26_KNOWN_RELATION_TARGETS) {
      assert.equal(isKnownProgressRelation(target), true);
    }
  });

  it('rejects unknown trusted bindings loudly (declaration bug, never a refusal)', () => {
    assert.throws(
      () => assertKnownProgressRelation('std.HandbookV1.ask', 'probe'),
      /unknown progress relation/,
    );
    assert.throws(() => assertKnownProgressRelation('', 'probe'), /non-empty/);
    assert.throws(() => assertKnownProgressRelation(null, 'probe'), /non-empty/);
    assert.equal(isKnownProgressRelation('std.HandbookV1.ask'), false);
    assert.equal(isKnownProgressRelation(null), false);
  });

  it('pins the terminal receipt states', () => {
    const terminal: ReceiptStatus[] = ['succeeded', 'failed', 'skipped'];
    const open: ReceiptStatus[] = ['pending', 'unknown'];
    for (const status of terminal) {
      assert.equal(isTerminalReceiptStatus(status), true);
    }
    for (const status of open) {
      assert.equal(isTerminalReceiptStatus(status), false);
    }
  });
});

for (const relation of T26_KNOWN_RELATION_TARGETS) {
  const other = relation === 'std.EmailV1.send'
    ? 'std.TextGenerationV1.generate'
    : 'std.EmailV1.send';

  describe(`t26 progress on ${relation}`, () => {
    it('applies correlated terminal progress with exactly one notification', () => {
      const outcome = applyRelatedProgress(relation, association(), receiptRow(), progress(relation));
      const expected: ProgressTerminalNotification = {
        relation,
        deliveryId: 'del_1',
        revision: 8,
        status: 'succeeded',
      };
      assert.deepEqual(outcome, {
        applied: true,
        association: association({ revision: 8 }),
        receipt: {
          deliveryId: 'del_1',
          revision: 8,
          status: 'succeeded',
          result: { relation, marker: 'ok' },
          error: null,
        },
        notification: expected,
        replay: false,
      });
    });

    it('applies failed and skipped terminal payloads with their notifications', () => {
      const failed = applyRelatedProgress(
        relation,
        association(),
        receiptRow(),
        progress(relation, {
          status: 'failed',
          result: null,
          error: { code: 'provider-down', message: 'provider unreachable' },
        }),
      );
      assert.equal(failed.applied, true);
      assert.deepEqual(
        failed.applied ? failed.notification : null,
        { relation, deliveryId: 'del_1', revision: 8, status: 'failed' },
      );
      const skipped = applyRelatedProgress(
        relation,
        association(),
        receiptRow(),
        progress(relation, { status: 'skipped', result: null }),
      );
      assert.equal(skipped.applied, true);
      assert.deepEqual(
        skipped.applied ? skipped.notification : null,
        { relation, deliveryId: 'del_1', revision: 8, status: 'skipped' },
      );
    });

    it('applies uncertain progress without notifying, then notifies on resolve', () => {
      const uncertain = applyRelatedProgress(
        relation,
        association(),
        receiptRow(),
        progress(relation, { status: 'unknown', result: null, error: null }),
      );
      assert.equal(uncertain.applied, true);
      if (uncertain.applied) {
        assert.equal(uncertain.notification, null);
        assert.equal(uncertain.replay, false);
        const resolved = applyRelatedProgress(
          relation,
          uncertain.association,
          uncertain.receipt,
          progress(relation, { revision: 9 }),
        );
        assert.equal(resolved.applied, true);
        assert.deepEqual(
          resolved.applied ? resolved.notification : null,
          { relation, deliveryId: 'del_1', revision: 9, status: 'succeeded' },
        );
      }
    });

    it('replays duplicate delivery identically and mints nothing', () => {
      const first = applyRelatedProgress(relation, association(), receiptRow(), progress(relation));
      assert.equal(first.applied, true);
      if (first.applied) {
        const replay = applyRelatedProgress(
          relation,
          first.association,
          first.receipt,
          progress(relation),
        );
        assert.deepEqual(replay, {
          applied: true,
          association: first.association,
          receipt: first.receipt,
          notification: null,
          replay: true,
        });
      }
    });

    it('refuses newer hostile re-drives on terminal rows without touching them', () => {
      const first = applyRelatedProgress(relation, association(), receiptRow(), progress(relation));
      assert.equal(first.applied, true);
      if (first.applied) {
        const held = first.association;
        const row = first.receipt;
        const hostile = applyRelatedProgress(
          relation,
          held,
          row,
          progress(relation, {
            revision: 99,
            status: 'failed',
            result: null,
            error: { code: 'hostile', message: 'rewritten' },
          }),
        );
        assert.deepEqual(hostile, { applied: false, reason: 'terminal-immutable' });
        assert.deepEqual(held, first.association);
        assert.deepEqual(row, first.receipt);
      }
    });

    it('replays same-revision hostile envelopes with stored truth verbatim', () => {
      const first = applyRelatedProgress(relation, association(), receiptRow(), progress(relation));
      assert.equal(first.applied, true);
      if (first.applied) {
        const replay = applyRelatedProgress(
          relation,
          first.association,
          first.receipt,
          progress(relation, {
            status: 'failed',
            result: null,
            error: { code: 'hostile', message: 'rewritten' },
          }),
        );
        assert.deepEqual(replay, {
          applied: true,
          association: first.association,
          receipt: first.receipt,
          notification: null,
          replay: true,
        });
      }
    });

    it('reports T25a refusals before terminal gating', () => {
      const first = applyRelatedProgress(relation, association(), receiptRow(), progress(relation));
      assert.equal(first.applied, true);
      if (first.applied) {
        assert.deepEqual(
          applyRelatedProgress(
            relation,
            first.association,
            first.receipt,
            progress(relation, { status: 'pending', result: { bogus: true } }),
          ),
          { applied: false, reason: 'inconsistent-envelope' },
        );
        assert.deepEqual(
          applyRelatedProgress(
            relation,
            first.association,
            first.receipt,
            progress(relation, { delivery_id: 'del_other', revision: 99 }),
          ),
          { applied: false, reason: 'id-mismatch' },
        );
      }
    });

    it('cancels pending receipts to skipped with exactly one notification', () => {
      const outcome = cancelRelatedProgress({
        relation,
        association: association(),
        receipt: receiptRow(),
        revision: 8,
      });
      assert.deepEqual(outcome, {
        cancelled: true,
        association: association({ revision: 8 }),
        receipt: {
          deliveryId: 'del_1',
          revision: 8,
          status: 'skipped',
          result: null,
          error: null,
        },
        notification: { relation, deliveryId: 'del_1', revision: 8, status: 'skipped' },
      });
    });

    it('leaves terminal receipts untouched under cancellation', () => {
      const first = applyRelatedProgress(relation, association(), receiptRow(), progress(relation));
      assert.equal(first.applied, true);
      if (first.applied) {
        const held = first.association;
        const row = first.receipt;
        assert.deepEqual(
          cancelRelatedProgress({ relation, association: held, receipt: row, revision: 9 }),
          { cancelled: false, reason: 'terminal-immutable' },
        );
        assert.deepEqual(held, first.association);
        assert.deepEqual(row, first.receipt);
      }
      const voided = cancelRelatedProgress({
        relation,
        association: association(),
        receipt: receiptRow(),
        revision: 8,
      });
      assert.equal(voided.cancelled, true);
      if (voided.cancelled) {
        assert.deepEqual(
          cancelRelatedProgress({
            relation,
            association: voided.association,
            receipt: voided.receipt,
            revision: 9,
          }),
          { cancelled: false, reason: 'terminal-immutable' },
        );
      }
    });

    it('refuses stale cancellations without touching pending rows', () => {
      const held = association();
      const row = receiptRow();
      assert.deepEqual(
        cancelRelatedProgress({ relation, association: held, receipt: row, revision: 7 }),
        { cancelled: false, reason: 'stale-revision' },
      );
      assert.deepEqual(held, association());
      assert.deepEqual(row, receiptRow());
    });

    it('reads the retained outcome on late usage after terminal', () => {
      const first = applyRelatedProgress(relation, association(), receiptRow(), progress(relation));
      assert.equal(first.applied, true);
      if (first.applied) {
        const record = { id: 'rec_1' };
        const late = observeRelatedProgress({
          relation,
          locator: { record, field: 'notification' },
          selected: ['id', 'status', 'result', 'error'],
          association: first.association,
          receipt: stored(first.receipt),
          grants: new TestOnlyAllowAllGrants(),
          content: new TestOnlyAvailabilityMap(),
          nowMs: NOW,
        });
        assert.deepEqual(late, {
          outcome: 'observed',
          relation,
          projection: {
            id: 'del_1',
            status: 'succeeded',
            result: { relation, marker: 'ok' },
            error: null,
          },
          fenceRevision: 8,
        });
      }
    });

    it('echoes the relation on null and denied reads', () => {
      const record = { id: 'rec_1' };
      assert.deepEqual(
        observeRelatedProgress({
          relation,
          locator: { record, field: 'notification' },
          selected: ['status'],
          association: null,
          receipt: null,
          grants: new TestOnlyAllowAllGrants(),
          content: new TestOnlyAvailabilityMap(),
          nowMs: NOW,
        }),
        { outcome: 'null-association', relation },
      );
      assert.throws(
        () =>
          observeRelatedProgress({
            relation: 'std.HandbookV1.ask',
            locator: { record, field: 'notification' },
            selected: ['status'],
            association: null,
            receipt: null,
            grants: new TestOnlyAllowAllGrants(),
            content: new TestOnlyAvailabilityMap(),
            nowMs: NOW,
          }),
        /unknown progress relation/,
      );
    });

    it('rejects unknown-relation progress without touching records', () => {
      const held = association();
      const row = receiptRow();
      assert.deepEqual(
        applyRelatedProgress(relation, held, row, progress('std.HandbookV1.ask')),
        { applied: false, reason: 'unknown-relation' },
      );
      assert.deepEqual(held, association());
      assert.deepEqual(row, receiptRow());
    });

    it('refuses cross-relation correlation without touching records', () => {
      const held = association();
      const row = receiptRow();
      assert.deepEqual(
        applyRelatedProgress(relation, held, row, progress(other)),
        { applied: false, reason: 'cross-relation' },
      );
      assert.deepEqual(held, association());
      assert.deepEqual(row, receiptRow());
    });

    it('treats a missing relation claim as malformed', () => {
      const { relation: _dropped, ...rest } = progress(relation);
      void _dropped;
      assert.deepEqual(
        applyRelatedProgress(relation, association(), receiptRow(), rest),
        { applied: false, reason: 'malformed-completion' },
      );
      assert.deepEqual(
        applyRelatedProgress(relation, association(), receiptRow(), null),
        { applied: false, reason: 'malformed-completion' },
      );
    });

    it('checks relation routing before id/source/revision', () => {
      assert.deepEqual(
        applyRelatedProgress(
          relation,
          association(),
          receiptRow(),
          progress('std.HandbookV1.ask', { delivery_id: 'del_other' }),
        ),
        { applied: false, reason: 'unknown-relation' },
      );
      assert.deepEqual(
        applyRelatedProgress(
          relation,
          association(),
          receiptRow(),
          progress(other, { revision: 1, status: 'pending', result: { bogus: true } }),
        ),
        { applied: false, reason: 'cross-relation' },
      );
    });

    it('preserves T25a correlation verdicts under a valid relation', () => {
      assert.deepEqual(
        applyRelatedProgress(
          relation,
          association(),
          receiptRow(),
          progress(relation, { delivery_id: 'del_other' }),
        ),
        { applied: false, reason: 'id-mismatch' },
      );
      assert.deepEqual(
        applyRelatedProgress(
          relation,
          association(),
          receiptRow(),
          progress(relation, { source: 'Foreign.send' }),
        ),
        { applied: false, reason: 'source-mismatch' },
      );
      assert.deepEqual(
        applyRelatedProgress(
          relation,
          association(),
          receiptRow(),
          progress(relation, { revision: 6 }),
        ),
        { applied: false, reason: 'stale-revision' },
      );
    });

    it('throws loudly on unknown trusted bindings and skewed stores', () => {
      assert.throws(
        () => applyRelatedProgress('std.HandbookV1.ask', association(), receiptRow(), progress(relation)),
        /unknown progress relation/,
      );
      assert.throws(
        () =>
          cancelRelatedProgress({
            relation: 'std.HandbookV1.ask',
            association: association(),
            receipt: receiptRow(),
            revision: 8,
          }),
        /unknown progress relation/,
      );
      assert.throws(
        () =>
          applyRelatedProgress(
            relation,
            association(),
            receiptRow({ deliveryId: 'del_other' }),
            progress(relation),
          ),
        /does not belong/,
      );
      assert.throws(
        () =>
          cancelRelatedProgress({
            relation,
            association: association(),
            receipt: receiptRow({ revision: 8 }),
            revision: 9,
          }),
        /disagrees/,
      );
    });
  });
}

describe('t26 memory lifecycle (MEMORY-ONLY)', () => {
  it('runs one relation end to end: progress, duplicate, cancel, late read', () => {
    // Test-local pair map standing in for the committing store.
    // MEMORY-ONLY: single-owner, non-durable, non-atomic. Durable
    // restart rides the recovery durable suite.
    const relation = 'std.TextGenerationV1.generate';
    const map = new Map<string, { held: ReceiptAssociation; row: StoredReceipt }>();
    const notifications: ProgressTerminalNotification[] = [];
    const record = { id: 'rec_1' };
    const key = 'rec_1\0summary';
    map.set(key, {
      held: association({ locator: { recordId: 'rec_1', field: 'summary' } }),
      row: { ...receiptRow(), contentRef: null },
    });
    const apply = (envelope: RelatedReceiptProgress): string => {
      const slot = map.get(key);
      assert.ok(slot !== undefined);
      const outcome = applyRelatedProgress(relation, slot.held, slot.row, envelope);
      if (outcome.applied) {
        map.set(key, {
          held: outcome.association,
          row: { ...outcome.receipt, contentRef: null },
        });
        if (outcome.notification !== null) {
          notifications.push(outcome.notification);
        }
        return outcome.replay ? 'replay' : 'applied';
      }
      return outcome.reason;
    };

    assert.equal(
      apply({ ...progress(relation), status: 'unknown', result: null, error: null }),
      'applied',
    );
    assert.deepEqual(notifications, []);
    assert.equal(apply(progress(relation, { revision: 9 })), 'applied');
    assert.deepEqual(notifications, [
      { relation, deliveryId: 'del_1', revision: 9, status: 'succeeded' },
    ]);
    assert.equal(apply(progress(relation, { revision: 9 })), 'replay');
    assert.equal(notifications.length, 1);
    assert.equal(
      apply(
        progress(relation, {
          revision: 10,
          status: 'failed',
          result: null,
          error: { code: 'late', message: 'late' },
        }),
      ),
      'terminal-immutable',
    );
    const slot = map.get(key);
    assert.ok(slot !== undefined);
    assert.deepEqual(
      cancelRelatedProgress({ relation, association: slot.held, receipt: slot.row, revision: 10 }),
      { cancelled: false, reason: 'terminal-immutable' },
    );
    const late = observeRelatedProgress({
      relation,
      locator: { record, field: 'summary' },
      selected: ['status', 'result'],
      association: slot.held,
      receipt: slot.row,
      grants: new TestOnlyAllowAllGrants(),
      content: new TestOnlyAvailabilityMap(),
      nowMs: NOW,
    });
    assert.deepEqual(late, {
      outcome: 'observed',
      relation,
      projection: { status: 'succeeded', result: { relation, marker: 'ok' } },
      fenceRevision: 9,
    });
  });
});
