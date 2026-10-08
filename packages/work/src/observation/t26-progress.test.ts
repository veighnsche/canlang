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
  ReceiptResultContext,
  CommitBatch,
} from '@canlang/contracts';
import { DELIVERY_RESULT_LEAVES } from '@canlang/contracts';
import { assertReceiptJoin, newReceiptRow, readReceiptRow, withReceiptRowData, RECEIPT_MODEL } from '@canlang/state/receipt/tables';
import { isTerminalReceiptStatus } from '../receipt/index.js';
import {
  TestOnlyAllowAllGrants,
  TestOnlyAvailabilityMap,
} from './ports.js';
import {
  T26_KNOWN_RELATION_TARGETS,
  applyRelatedProgress,
  applyRetainedRelatedProgress,
  assertKnownProgressRelation,
  cancelRelatedProgress,
  isKnownProgressRelation,
} from './association.js';
import type { RelatedReceiptProgress } from './association.js';
import { observeRelatedProgress } from './observation.js';
import type { StoredReceipt } from './observation.js';

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

// The original request revision and run sequence are exact int64 wire values,
// intentionally distinct from the owner checkpoints 7, 8, 9, ... .
describe('context-qualified TextRun snapshots and late measured usage', () => {
  const relation = 'std.TextGenerationV1.generate';
  const context: ReceiptResultContext = { source: relation,
    declaredResult: { name: 'TextRun', fields: DELIVERY_RESULT_LEAVES['TextRun'] },
    request: { source: 'request_1', revision: '9223372036854775807' } };
  const run = { source: 'request_1', revision: '9223372036854775807', sequence: '9007199254740993',
    state: 'running', content: 'Partial', used_tokens: null, detail: null };
  const held = () => association({ source: relation });
  const envelope = (result: unknown, status: ReceiptStatus = 'pending', revision = 8) =>
    progress(relation, { source: relation, revision, status, result });

  it('returns the actual unchanged objects for an exact typed nonterminal replay', () => {
    for (const [state, status] of [['running', 'pending'], ['unknown', 'unknown']] as const) {
      const snapshot = { ...run, state };
      const first = applyRelatedProgress(relation, held(), receiptRow(), envelope(snapshot, status), context);
      assert.equal(first.applied, true);
      if (!first.applied) continue;
      const replay = applyRelatedProgress(relation, first.association, first.receipt,
        envelope({ ...snapshot }, status), context);
      assert.equal(replay.applied, true);
      if (replay.applied) {
        assert.strictEqual(replay.receipt, first.receipt);
        assert.strictEqual(replay.association, first.association);
        assert.equal(replay.replay, true);
        assert.equal(replay.notification, null);
      }
      const retained = applyRetainedRelatedProgress(relation, first.receipt, envelope({ ...snapshot }, status), context);
      assert.equal(retained.applied, true);
      if (retained.applied) {
        assert.strictEqual(retained.receipt, first.receipt);
        assert.equal(retained.replay, true);
        assert.equal(retained.notification, null);
        assert.equal(Object.hasOwn(retained, 'association'), false);
      }
      assert.deepEqual(applyRetainedRelatedProgress(relation, first.receipt,
        envelope({ ...snapshot, content: 'changed at the same checkpoint' }, status), context),
        { applied: false, reason: 'inconsistent-envelope' });
    }
  });

  it('preserves an already measured usage value across nonterminal and terminal snapshots', () => {
    const first = applyRelatedProgress(relation, held(), receiptRow(), envelope({ ...run, used_tokens: '7' }), context);
    assert.equal(first.applied, true);
    if (!first.applied) return;
    for (const state of ['running', 'succeeded']) {
      for (const used_tokens of [null, '8']) {
        assert.deepEqual(applyRelatedProgress(relation, first.association, first.receipt,
          envelope({ ...run, sequence: '9007199254740994', state, used_tokens },
            state === 'running' ? 'pending' : 'succeeded', 9), context),
          { applied: false, reason: 'inconsistent-envelope' });
      }
    }
    const terminal = applyRelatedProgress(relation, first.association, first.receipt,
      envelope({ ...run, sequence: '9007199254740994', state: 'succeeded', used_tokens: '7' }, 'succeeded', 9), context);
    assert.equal(terminal.applied, true);
    if (terminal.applied) assert.deepEqual(terminal.notification,
      { relation, deliveryId: 'del_1', revision: 9, status: 'succeeded' });
  });

  it('updates a retained superseded attempt without inventing a current association and preserves all fences', () => {
    const replacement = association({ source: relation, deliveryId: 'replacement', revision: 20 });
    const replacementReceipt = receiptRow({ deliveryId: 'replacement', revision: 20 });
    assert.deepEqual(applyRelatedProgress(relation, replacement, replacementReceipt, envelope(run), context),
      { applied: false, reason: 'id-mismatch' });
    const pending = applyRetainedRelatedProgress(relation, receiptRow(), envelope(run), context);
    assert.equal(pending.applied, true);
    if (!pending.applied) return;
    for (const [overrides, reason] of [
      [{ delivery_id: 'replacement' }, 'id-mismatch'], [{ source: 'different' }, 'source-mismatch'],
      [{ revision: 7 }, 'stale-revision'], [{ relation: 'std.EmailV1.send' }, 'cross-relation'],
      [{ result: { ...run, revision: '7' } }, 'inconsistent-envelope'],
    ] as const) {
      assert.deepEqual(applyRetainedRelatedProgress(relation, pending.receipt,
        { ...envelope(run, 'pending', 9), ...overrides }, context), { applied: false, reason });
    }
    const snapshot = { ...run, sequence: '9007199254740994', state: 'cancelled' };
    const terminal = applyRetainedRelatedProgress(relation, pending.receipt, envelope(snapshot, 'succeeded', 9), context);
    assert.equal(terminal.applied, true);
    if (!terminal.applied) return;
    assert.deepEqual(terminal.notification, { relation, deliveryId: 'del_1', revision: 9, status: 'succeeded' });
    const measured = { ...snapshot, sequence: '9007199254740995', used_tokens: '7' };
    const late = applyRetainedRelatedProgress(relation, terminal.receipt, envelope(measured, 'succeeded', 10), context);
    assert.equal(late.applied, true);
    if (!late.applied) return;
    assert.deepEqual(late.receipt.result, measured);
    assert.equal(late.notification, null);
    assert.equal(late.replay, false);
    assert.equal(Object.hasOwn(late, 'association'), false);
    const replay = applyRetainedRelatedProgress(relation, late.receipt, envelope(measured, 'succeeded', 10), context);
    assert.equal(replay.applied, true);
    if (replay.applied) { assert.strictEqual(replay.receipt, late.receipt); assert.equal(replay.replay, true); }
    assert.deepEqual(applyRetainedRelatedProgress(relation, late.receipt,
      envelope({ ...measured, sequence: '9007199254740996', used_tokens: '8' }, 'succeeded', 11), context),
      { applied: false, reason: 'inconsistent-envelope' });
    assert.deepEqual(applyRetainedRelatedProgress(relation, terminal.receipt,
      envelope({ ...measured, content: 'rewritten' }, 'succeeded', 10), context),
      { applied: false, reason: 'terminal-immutable' });
  });

  it('admits real running/unknown snapshots only with checked declaration and original request context', () => {
    const originalAssociation = held();
    const originalReceipt = receiptRow();
    assert.throws(() => applyRelatedProgress('std.EmailV1.send', originalAssociation, originalReceipt,
      { ...envelope(run), relation: 'std.EmailV1.send' }, context), /context disagrees with relation/);
    assert.deepEqual(originalAssociation, held());
    assert.deepEqual(originalReceipt, receiptRow());
    for (const [state, status] of [['queued', 'pending'], ['running', 'pending'], ['unknown', 'unknown']] as const) {
      const outcome = applyRelatedProgress(relation, held(), receiptRow(), envelope({ ...run, state }, status), context);
      assert.equal(outcome.applied, true);
      if (outcome.applied) {
        assert.equal(outcome.receipt.status, status);
        assert.deepEqual(outcome.receipt.result, { ...run, state });
        assert.equal(outcome.notification, null);
      }
    }
    for (const invalid of [undefined, { source: relation, declaredResult: context.declaredResult },
      { ...context, declaredResult: { name: 'TextRun', fields: [] } },
      { ...context, request: { source: 'different', revision: context.request!.revision } }]) {
      assert.deepEqual(applyRelatedProgress(relation, held(), receiptRow(), envelope(run), invalid),
        { applied: false, reason: 'inconsistent-envelope' });
    }
    assert.deepEqual(applyRelatedProgress(relation, held(), receiptRow(), envelope(run, 'succeeded'), context),
      { applied: false, reason: 'inconsistent-envelope' });
  });

  it('retains exact canonical DTOs through the actual State constructor/read/update/batch guard', () => {
    const data = { deliveryId: 'del_1', revision: 8, status: 'pending' as const, result: run, error: null,
      contentRef: null, resultExpiresAtMs: null };
    const meta = { nowMs: NOW, actor: 'worker' };
    assert.throws(() => newReceiptRow(data, meta), /inconsistent/);
    const row = newReceiptRow(data, meta, context);
    assert.throws(() => readReceiptRow(row), /inconsistent/);
    assert.deepEqual(readReceiptRow(row, context).receipt.result, run);
    const batch: CommitBatch = { expectedRevision: 7 as CommitBatch['expectedRevision'],
      writes: [{ kind: 'insert', model: RECEIPT_MODEL as CommitBatch['writes'][number]['model'], row }],
      history: [], receipt: null, outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [] };
    assert.throws(() => assertReceiptJoin(batch), /inconsistent/);
    assert.doesNotThrow(() => assertReceiptJoin(batch, new Map([['del_1', context]])));
    const later = withReceiptRowData(row, { ...data, revision: 9, result: { ...run, sequence: '9007199254740994' } }, meta, context);
    assert.equal(readReceiptRow(later, context).receipt.revision, 9);
    for (const result of [{ ...run, sequence: 1 }, { ...run, sequence: '01' }, { ...run, used_tokens: '-1' },
      { ...run, extra: 'private' }, { ...run, revision: '9223372036854775808' },
      { ...run, get content() { throw new Error('must not invoke accessor'); } }]) {
      assert.throws(() => newReceiptRow({ ...data, status: 'succeeded', result }, meta, context), /inconsistent/);
    }
  });

  it('orders exact snapshot sequences and rejects changed request correlation', () => {
    const first = applyRelatedProgress(relation, held(), receiptRow(), envelope(run), context);
    assert.equal(first.applied, true);
    if (!first.applied) return;
    for (const sequence of ['9007199254740992', '9007199254740993']) {
      assert.deepEqual(applyRelatedProgress(relation, first.association, first.receipt,
        envelope({ ...run, sequence }, 'pending', 9), context), { applied: false, reason: 'stale-sequence' });
    }
    assert.deepEqual(applyRelatedProgress(relation, first.association, first.receipt,
      envelope({ ...run, sequence: '9007199254740994', revision: '7' }, 'pending', 9), context),
      { applied: false, reason: 'inconsistent-envelope' });
  });

  it('delivers typed terminal business states once and enriches only previously absent usage', () => {
    for (const state of ['succeeded', 'failed', 'cancelled']) {
      const terminal = { ...run, state };
      const first = applyRelatedProgress(relation, held(), receiptRow(), envelope(terminal, 'succeeded'), context);
      assert.equal(first.applied, true);
      if (!first.applied) continue;
      assert.deepEqual(first.notification, { relation, deliveryId: 'del_1', revision: 8, status: 'succeeded' });
      const measured = { ...terminal, sequence: '9007199254740994', used_tokens: '9007199254740993' };
      const late = applyRelatedProgress(relation, first.association, first.receipt, envelope(measured, 'succeeded', 9), context);
      assert.equal(late.applied, true);
      if (!late.applied) continue;
      assert.deepEqual(late.receipt.result, measured);
      assert.equal(late.notification, null);
      assert.equal(late.replay, false);
      const replay = applyRelatedProgress(relation, late.association, late.receipt, envelope(measured, 'succeeded', 9), context);
      assert.equal(replay.applied, true);
      if (replay.applied) { assert.equal(replay.replay, true); assert.equal(replay.notification, null); }
      for (const change of [{ content: 'rewritten' }, { state: 'running' }, { detail: 'changed' },
        { used_tokens: '42' }, { used_tokens: null }]) {
        const rejected = applyRelatedProgress(relation, late.association, late.receipt,
          envelope({ ...measured, sequence: '9007199254740995', ...change }, 'succeeded', 10), context);
        assert.equal(rejected.applied, false);
      }
      assert.deepEqual(applyRelatedProgress(relation, first.association, first.receipt,
        envelope({ ...measured, content: 'changed' }, 'succeeded', 9), context),
        { applied: false, reason: 'terminal-immutable' });
    }
  });

  it('keeps transport failures closed and never turns cancellation into fabricated rich progress', () => {
    const failed = applyRelatedProgress(relation, held(), receiptRow(),
      envelope(null, 'failed'), context);
    assert.deepEqual(failed, { applied: false, reason: 'inconsistent-envelope' });
    const closed = applyRelatedProgress(relation, held(), receiptRow(),
      { ...envelope(null, 'failed'), error: { code: 'provider_failure', message: 'Unavailable' } }, context);
    assert.equal(closed.applied, true);
    const cancelled = cancelRelatedProgress({ relation, association: held(), receipt: receiptRow(), revision: 8 });
    assert.equal(cancelled.cancelled, true);
    if (cancelled.cancelled) assert.deepEqual(cancelled.receipt, { deliveryId: 'del_1', revision: 8,
      status: 'skipped', result: null, error: null });
  });
});

describe('selected canonical ImageRun receipt and progress core', () => {
  const relation = 'std.ImagesV1.submit';
  const context: ReceiptResultContext = { source: relation,
    declaredResult: { name: 'ImageRun', fields: DELIVERY_RESULT_LEAVES['ImageRun'] },
    request: { source: 'image_request', revision: '9223372036854775807' } };
  const outputs = [{ position: '0', image: { id: 'file_a' } }, { position: '1', image: { id: 'file_b' } }];
  const run = { source: 'image_request', revision: '9223372036854775807', sequence: '9007199254740993',
    state: 'running', outputs, charged_jobs: null, detail: null };
  const envelope = (result: unknown, status: ReceiptStatus = 'pending', revision = 8, source = relation) =>
    progress(source, { source, revision, status, result });
  const held = () => association({ source: relation });

  it('checks original submit/cancel/reconcile declarations and requests while preserving inspect/validate', () => {
    for (const source of ['std.ImagesV1.submit', 'std.ImagesV1.cancel', 'std.ImagesV1.reconcile']) {
      for (const [state, status] of [['queued', 'pending'], ['running', 'pending'], ['unknown', 'unknown']] as const) {
        const outcome = applyRelatedProgress(source, association({ source }), receiptRow(),
          envelope({ ...run, state }, status, 8, source), { ...context, source });
        assert.equal(outcome.applied, true);
        if (outcome.applied) assert.equal(outcome.notification, null);
      }
    }
    for (const invalid of [undefined, { source: relation, declaredResult: context.declaredResult },
      { ...context, declaredResult: { name: 'ImageRun', fields: [] } },
      { ...context, request: { source: 'other', revision: context.request!.revision } },
      { ...context, request: { source: 'image_request', revision: '01' } }]) {
      assert.deepEqual(applyRelatedProgress(relation, held(), receiptRow(), envelope(run), invalid),
        { applied: false, reason: 'inconsistent-envelope' });
    }
    assert.throws(() => applyRelatedProgress(relation, held(), receiptRow(), envelope(run),
      { ...context, source: 'std.ImagesV1.cancel' }), /context disagrees with relation/);
    for (const source of ['std.ImagesV1.inspect', 'std.ImagesV1.validate']) {
      assert.equal(applyRelatedProgress(source, association({ source }), receiptRow(),
        envelope({ valid: true }, 'succeeded', 8, source),
        { source, declaredResult: { name: 'WorkflowValidation', fields: [] } }).applied, true);
    }
  });

  it('retains actual current and original receipt objects for semantic ordered-output replays', () => {
    const first = applyRelatedProgress(relation, held(), receiptRow(), envelope(run), context);
    assert.equal(first.applied, true);
    if (!first.applied) return;
    const copy = { ...run, outputs: outputs.map(output => Object.assign(Object.create(null),
      { image: Object.assign(Object.create(null), output.image), position: output.position })) };
    const replay = applyRelatedProgress(relation, first.association, first.receipt, envelope(copy), context);
    assert.equal(replay.applied, true);
    if (replay.applied) {
      assert.strictEqual(replay.receipt, first.receipt);
      assert.strictEqual(replay.association, first.association);
      assert.equal(replay.replay, true);
      assert.equal(replay.notification, null);
    }
    const retained = applyRetainedRelatedProgress(relation, first.receipt, envelope(copy), context);
    assert.equal(retained.applied, true);
    if (retained.applied) {
      assert.strictEqual(retained.receipt, first.receipt);
      assert.equal(retained.replay, true);
      assert.equal(retained.notification, null);
      assert.equal(Object.hasOwn(retained, 'association'), false);
    }
    for (const changed of [[...outputs].reverse(), [outputs[0]],
      [{ ...outputs[0], image: { id: 'other_file' } }, outputs[1]]]) {
      assert.deepEqual(applyRetainedRelatedProgress(relation, first.receipt,
        envelope({ ...run, outputs: changed }), context), { applied: false, reason: 'inconsistent-envelope' });
    }
    for (const sequence of ['9007199254740992', '9007199254740993']) {
      assert.deepEqual(applyRelatedProgress(relation, first.association, first.receipt,
        envelope({ ...run, sequence }, 'pending', 9), context), { applied: false, reason: 'stale-sequence' });
    }
    const replacement = association({ source: relation, deliveryId: 'replacement', revision: 20 });
    assert.deepEqual(applyRelatedProgress(relation, replacement,
      receiptRow({ deliveryId: 'replacement', revision: 20 }), envelope(run), context),
      { applied: false, reason: 'id-mismatch' });
    for (const [change, reason] of [[{ delivery_id: 'replacement' }, 'id-mismatch'],
      [{ source: 'other' }, 'source-mismatch'], [{ revision: 7 }, 'stale-revision'],
      [{ relation: 'std.ImagesV1.cancel' }, 'cross-relation'],
      [{ result: { ...run, revision: '7' } }, 'inconsistent-envelope']] as const) {
      assert.deepEqual(applyRetainedRelatedProgress(relation, first.receipt,
        { ...envelope({ ...run, sequence: '9007199254740994' }, 'pending', 9), ...change }, context),
        { applied: false, reason });
    }
  });

  it('keeps one nonnegative measurement and enriches terminal outputs once through both progress gates', () => {
    const measured = { ...run, charged_jobs: '7' };
    const first = applyRelatedProgress(relation, held(), receiptRow(), envelope(measured), context);
    assert.equal(first.applied, true);
    if (!first.applied) return;
    for (const charged_jobs of [null, '8']) {
      assert.deepEqual(applyRelatedProgress(relation, first.association, first.receipt,
        envelope({ ...measured, charged_jobs, sequence: '9007199254740994' }, 'pending', 9), context),
        { applied: false, reason: 'inconsistent-envelope' });
    }
    assert.deepEqual(applyRetainedRelatedProgress(relation, first.receipt, envelope(null, 'succeeded', 9), context),
      { applied: false, reason: 'inconsistent-envelope' });
    for (const state of ['succeeded', 'failed', 'cancelled']) {
      const terminal = { ...run, state };
      const ended = applyRelatedProgress(relation, held(), receiptRow(), envelope(terminal, 'succeeded'), context);
      assert.equal(ended.applied, true);
      if (!ended.applied) continue;
      assert.deepEqual(ended.notification, { relation, deliveryId: 'del_1', revision: 8, status: 'succeeded' });
      const lateSnapshot = { ...terminal, sequence: '9007199254740994', charged_jobs: '9007199254740993',
        outputs: structuredClone(outputs) };
      const late = applyRelatedProgress(relation, ended.association, ended.receipt,
        envelope(lateSnapshot, 'succeeded', 9), context);
      const retained = applyRetainedRelatedProgress(relation, ended.receipt, envelope(lateSnapshot, 'succeeded', 9), context);
      for (const result of [late, retained]) {
        assert.equal(result.applied, true);
        if (result.applied) {
          assert.deepEqual(result.receipt.result, lateSnapshot);
          assert.equal(result.notification, null);
          assert.equal(result.replay, false);
        }
      }
      const replay = applyRetainedRelatedProgress(relation, ended.receipt,
        envelope({ ...terminal, sequence: '0', outputs: [] }, 'succeeded'), context);
      assert.equal(replay.applied, true);
      if (replay.applied) {
        assert.strictEqual(replay.receipt, ended.receipt);
        assert.equal(replay.replay, true);
        assert.equal(replay.notification, null);
      }
      for (const change of [{ outputs: [...outputs].reverse() }, { outputs: [] }, { detail: 'changed' },
        { outputs: [{ position: '0', image: { id: 'other_file' } }, outputs[1]] }]) {
        assert.deepEqual(applyRetainedRelatedProgress(relation, ended.receipt,
          envelope({ ...lateSnapshot, ...change }, 'succeeded', 9), context),
          { applied: false, reason: 'terminal-immutable' });
      }
      if (late.applied) {
        for (const charged_jobs of [null, '8']) {
          assert.deepEqual(applyRetainedRelatedProgress(relation, late.receipt,
            envelope({ ...lateSnapshot, charged_jobs, sequence: '9007199254740995' }, 'succeeded', 10), context),
            { applied: false, reason: 'inconsistent-envelope' });
        }
      }
    }
  });

  it('refuses malformed nested wire values before any accessor read or State row staging', () => {
    let reads = 0;
    const accessor = { position: '0', get image() { reads++; return { id: 'file_a' }; } };
    const fileAccessor = { get id() { reads++; return 'file_a'; } };
    const arrayAccessor = [outputs[0]];
    Object.defineProperty(arrayAccessor, '0', { get() { reads++; return outputs[0]; }, enumerable: true });
    const badResults = [{ ...run, outputs: [accessor] }, { ...run, outputs: [{ position: '0', image: fileAccessor }] },
      { ...run, outputs: arrayAccessor }, { ...run, get outputs() { reads++; return outputs; } },
      { ...run, outputs: [Object.create(outputs[0])] }, { ...run, outputs: [undefined] },
      { ...run, outputs: new Array(1) }, { ...run, outputs: [{ position: '01', image: { id: 'file_a' } }] },
      { ...run, outputs: [{ position: 0, image: { id: 'file_a' } }] },
      { ...run, outputs: [{ position: '0', image: { id: '' } }] },
      { ...run, outputs: [{ position: '0', image: 'file_a' }] },
      { ...run, outputs: [{ position: '0', image: { id: 'file_a', url: 'private' } }] },
      { ...run, outputs: [{ position: '0', image: { id: 'file_a' }, extra: undefined }] },
      { ...run, outputs: [{ image: { id: 'file_a' } }] }, { ...run, outputs: undefined },
      { ...run, sequence: '-1' }, { ...run, charged_jobs: '-1' }, { ...run, sequence: '01' },
      { ...run, revision: '9223372036854775808' }, { ...run, source: 'other' },
      { ...run, extra: 'private' }, { job: 'provider_job', state: 'running', outputs: [], detail: null }];
    const data = { deliveryId: 'del_1', revision: 8, status: 'pending' as const, result: run, error: null,
      contentRef: null, resultExpiresAtMs: null };
    const meta = { nowMs: NOW, actor: 'worker' };
    const row = newReceiptRow(data, meta, context);
    assert.deepEqual(readReceiptRow(row, context).receipt.result, run);
    const batch: CommitBatch = { expectedRevision: 7 as CommitBatch['expectedRevision'],
      writes: [{ kind: 'insert', model: RECEIPT_MODEL as CommitBatch['writes'][number]['model'], row }],
      history: [], receipt: null, outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [] };
    assert.throws(() => assertReceiptJoin(batch), /inconsistent/);
    assert.doesNotThrow(() => assertReceiptJoin(batch, new Map([['del_1', context]])));
    const later = withReceiptRowData(row, { ...data, revision: 9, result: { ...run, sequence: '9007199254740994' } }, meta, context);
    assert.equal(readReceiptRow(later, context).receipt.revision, 9);
    for (const result of badResults) {
      assert.deepEqual(applyRelatedProgress(relation, held(), receiptRow(), envelope(result), context),
        { applied: false, reason: 'inconsistent-envelope' });
      assert.throws(() => newReceiptRow({ ...data, result }, meta, context), /inconsistent/);
      assert.throws(() => withReceiptRowData(row, { ...data, revision: 9, result }, meta, context), /inconsistent/);
    }
    assert.equal(reads, 0);
  });
});
