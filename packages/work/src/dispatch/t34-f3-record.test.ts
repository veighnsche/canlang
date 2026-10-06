/**
 * T34-F3 fanout child record: per-child bounded retry horizon reusing
 * the same identity, dead-letter visibility at exhaustion, terminal
 * attribution, revocation/reject isolation per child (sibling
 * unaffected), and duplicate-record replay identity.
 *
 * Scope: record only. Claim lives in `t34-f3-claim.test.ts`;
 * progress/scheduling lives in `t34-f3-progress.test.ts`. Bounds are
 * explicit per call (no default, no quota field).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FanoutChildId, RetryPolicy } from '../../../contracts/src/work.js';
import type { StoredRow } from '../../../contracts/src/state.js';
import { TestOnlyManualClock } from '../ports.ts';
import {
  fanoutChildRowId,
  fanoutIntentRowId,
  newFanoutChildRow,
  readFanoutChildRow,
} from '../kernel/tables.ts';
import { TestOnlyMemoryFanoutChildStore } from './index.ts';

const META = { nowMs: 1_758_000_000_000, actor: 't34-f3-test' };
const OCC = 'occ_f3_record';
const HANDLER = 'Shift.review_commitment';
const FANOUT = fanoutIntentRowId(OCC, HANDLER, 'model');
const POLICY: RetryPolicy = { maxAttempts: 3, horizonMs: 60_000 };

function child(recordId: string): FanoutChildId {
  return { parentOccurrence: OCC, handler: HANDLER, recordId };
}

function storeWith(recordIds: readonly string[]): TestOnlyMemoryFanoutChildStore {
  const store = new TestOnlyMemoryFanoutChildStore(new TestOnlyManualClock(META.nowMs));
  for (const recordId of recordIds) {
    store.insert(
      newFanoutChildRow(
        { fanoutId: FANOUT, parentOccurrence: OCC, handler: HANDLER, recordId },
        META,
      ),
    );
  }
  return store;
}

function claimRunning(
  store: TestOnlyMemoryFanoutChildStore,
  id: FanoutChildId,
): void {
  const outcome = store.claim(() => true, {
    child: id,
    snapshotVersion: null,
    guard: { predicate: null },
    frozenInputs: {},
    readCurrentSnapshot: () => ({}),
  });
  assert.equal(outcome.status, 'claimed');
}

describe('t34-f3 record: terminal attribution', () => {
  it('records completed with attempts++ on the same row', () => {
    const store = storeWith(['rec-done']);
    const id = child('rec-done');
    claimRunning(store, id);
    const outcome = store.record({
      child: id,
      result: { kind: 'completed' },
      nowMs: META.nowMs,
      firstAttemptAtMs: META.nowMs,
      policy: POLICY,
    });
    assert.equal(outcome.status, 'recorded');
    if (outcome.status !== 'recorded') throw new Error('unreachable');
    assert.deepEqual(outcome.outcome, {
      child: id,
      state: 'completed',
      attempts: 1,
      cause: { kind: 'completed' },
    });
    assert.equal(outcome.row.id, fanoutChildRowId(OCC, HANDLER, 'rec-done'));
  });

  it('records skipped/deleted and skipped/non-applicable without attempts++', () => {
    for (const reason of ['deleted', 'non-applicable'] as const) {
      const store = storeWith([`rec-skip-${reason}`]);
      const id = child(`rec-skip-${reason}`);
      claimRunning(store, id);
      const outcome = store.record({ child: id, result: { kind: 'skipped', reason }, nowMs: META.nowMs, firstAttemptAtMs: META.nowMs, policy: POLICY });
      assert.equal(outcome.status, 'recorded');
      if (outcome.status !== 'recorded') throw new Error('unreachable');
      assert.deepEqual(outcome.outcome, {
        child: id,
        state: 'skipped',
        attempts: 0,
        cause: { kind: 'skipped', reason },
      });
    }
  });

  it('records each terminal failed reason with attempts++', () => {
    for (const reason of [
      'business-rejection',
      'terminal',
      'missing-record',
      'inaccessible-record',
      'infra-read-failure',
    ] as const) {
      const store = storeWith([`rec-fail-${reason}`]);
      const id = child(`rec-fail-${reason}`);
      claimRunning(store, id);
      const outcome = store.record({ child: id, result: { kind: 'failed', reason }, nowMs: META.nowMs, firstAttemptAtMs: META.nowMs, policy: POLICY });
      assert.equal(outcome.status, 'recorded');
      if (outcome.status !== 'recorded') throw new Error('unreachable');
      assert.deepEqual(outcome.outcome.cause, { kind: 'failed', reason });
      assert.equal(outcome.outcome.attempts, 1);
    }
  });

  it('refuses a supplied exhausted reason (the horizon derives it)', () => {
    const store = storeWith(['rec-exh']);
    const id = child('rec-exh');
    claimRunning(store, id);
    assert.throws(
      () =>
        store.record({
          child: id,
          result: { kind: 'failed', reason: 'exhausted' as 'terminal' },
          nowMs: META.nowMs,
          firstAttemptAtMs: META.nowMs,
          policy: POLICY,
        }),
      /derived by the horizon/,
    );
  });

  it('requires a running claim (live-but-idle throws, nothing recorded)', () => {
    const store = storeWith(['rec-idle']);
    const id = child('rec-idle');
    assert.throws(
      () =>
        store.record({
          child: id,
          result: { kind: 'completed' },
          nowMs: META.nowMs,
          firstAttemptAtMs: META.nowMs,
          policy: POLICY,
        }),
      /running children only/,
    );
    const current = store.get(id);
    assert.ok(current !== null);
    assert.equal(readFanoutChildRow(current).state, 'pending');
  });

  it('fails closed on bad policy and timestamps', () => {
    const store = storeWith(['rec-bad']);
    const id = child('rec-bad');
    claimRunning(store, id);
    const base = {
      child: id,
      result: { kind: 'completed' } as const,
      nowMs: META.nowMs,
      firstAttemptAtMs: META.nowMs,
    };
    assert.throws(() => store.record({ ...base, policy: { maxAttempts: 0, horizonMs: 1 } }), /maxAttempts/);
    assert.throws(() => store.record({ ...base, policy: { maxAttempts: 3, horizonMs: 0 } }), /horizonMs/);
    assert.throws(() => store.record({ ...base, policy: POLICY, nowMs: -1 }), /nowMs/);
    assert.throws(() => store.record({ ...base, policy: POLICY, firstAttemptAtMs: -1 }), /firstAttemptAtMs/);
  });
});

describe('t34-f3 record: bounded retry horizon, same identity', () => {
  it('retries transient within budget: pending, attempts++ on the same row', () => {
    const store = storeWith(['rec-retry']);
    const id = child('rec-retry');
    const rowId = fanoutChildRowId(OCC, HANDLER, 'rec-retry');
    claimRunning(store, id);
    const first = store.record({
      child: id,
      result: { kind: 'transient' },
      nowMs: META.nowMs,
      firstAttemptAtMs: META.nowMs,
      policy: POLICY,
    });
    assert.equal(first.status, 'retried');
    if (first.status !== 'retried') throw new Error('unreachable');
    assert.equal(first.row.id, rowId);
    assert.deepEqual(
      [readFanoutChildRow(first.row).state, readFanoutChildRow(first.row).attempts],
      ['pending', 1],
    );
    // Second attempt reuses the same identity and completes with attempts 2.
    claimRunning(store, id);
    const second = store.record({
      child: id,
      result: { kind: 'completed' },
      nowMs: META.nowMs + 1,
      firstAttemptAtMs: META.nowMs,
      policy: POLICY,
    });
    assert.equal(second.status, 'recorded');
    if (second.status !== 'recorded') throw new Error('unreachable');
    assert.equal(second.row.id, rowId);
    assert.equal(second.outcome.attempts, 2);
  });

  it('exhausts on the attempt cap: failed/exhausted dead-letter, same identity', () => {
    const store = storeWith(['rec-cap']);
    const id = child('rec-cap');
    const rowId = fanoutChildRowId(OCC, HANDLER, 'rec-cap');
    const policy: RetryPolicy = { maxAttempts: 2, horizonMs: 60_000 };
    claimRunning(store, id);
    const first = store.record({
      child: id,
      result: { kind: 'transient' },
      nowMs: META.nowMs,
      firstAttemptAtMs: META.nowMs,
      policy,
    });
    assert.equal(first.status, 'retried');
    claimRunning(store, id);
    const second = store.record({
      child: id,
      result: { kind: 'transient' },
      nowMs: META.nowMs + 1,
      firstAttemptAtMs: META.nowMs,
      policy,
    });
    assert.equal(second.status, 'recorded');
    if (second.status !== 'recorded') throw new Error('unreachable');
    assert.equal(second.row.id, rowId);
    assert.deepEqual(second.outcome, {
      child: id,
      state: 'failed',
      attempts: 2,
      cause: { kind: 'failed', reason: 'exhausted' },
    });
    // Dead-letter is terminal: further claims replay, never re-drive.
    const replay = store.claim(() => true, {
      child: id,
      snapshotVersion: null,
      guard: { predicate: null },
      frozenInputs: {},
      readCurrentSnapshot: () => ({}),
    });
    assert.equal(replay.status, 'replayed');
  });

  it('exhausts on the time horizon even below the attempt cap', () => {
    const store = storeWith(['rec-horizon']);
    const id = child('rec-horizon');
    const policy: RetryPolicy = { maxAttempts: 8, horizonMs: 1000 };
    claimRunning(store, id);
    const outcome = store.record({
      child: id,
      result: { kind: 'transient' },
      nowMs: META.nowMs + 1000,
      firstAttemptAtMs: META.nowMs,
      policy,
    });
    assert.equal(outcome.status, 'recorded');
    if (outcome.status !== 'recorded') throw new Error('unreachable');
    assert.deepEqual(outcome.outcome.cause, { kind: 'failed', reason: 'exhausted' });
    assert.equal(outcome.outcome.attempts, 1);
  });
});

describe('t34-f3 record: isolation per child (sibling unaffected)', () => {
  it('isolates business rejection: sibling stays pending and claimable', () => {
    const store = storeWith(['rec-a', 'rec-b']);
    const rejected = child('rec-a');
    const sibling = child('rec-b');
    claimRunning(store, rejected);
    const failed = store.record({
      child: rejected,
      result: { kind: 'failed', reason: 'business-rejection' },
      nowMs: META.nowMs,
      firstAttemptAtMs: META.nowMs,
      policy: POLICY,
    });
    assert.equal(failed.status, 'recorded');
    if (failed.status !== 'recorded') throw new Error('unreachable');
    // Sibling row untouched: still pending v1, zero attempts.
    const siblingRow = store.get(sibling) as StoredRow;
    assert.equal(siblingRow.version, 1);
    assert.deepEqual(
      [readFanoutChildRow(siblingRow).state, readFanoutChildRow(siblingRow).attempts],
      ['pending', 0],
    );
    // Rejection outcome carries only its own identity: no sibling leak.
    assert.deepEqual(failed.outcome.child, rejected);
    assert.ok(!JSON.stringify(failed.outcome).includes('rec-b'));
    // Sibling still claims and completes independently.
    claimRunning(store, sibling);
    const done = store.record({
      child: sibling,
      result: { kind: 'completed' },
      nowMs: META.nowMs,
      firstAttemptAtMs: META.nowMs,
      policy: POLICY,
    });
    assert.equal(done.status, 'recorded');
    if (done.status !== 'recorded') throw new Error('unreachable');
    assert.equal(done.outcome.state, 'completed');
  });

  it('isolates revocation: the revoked child fails while the sibling proceeds', () => {
    const store = storeWith(['rec-rev', 'rec-ok']);
    const revoked = child('rec-rev');
    const sibling = child('rec-ok');
    const refused = store.claim(() => true, {
      child: revoked,
      snapshotVersion: null,
      guard: { predicate: 'spend.bounded' },
      frozenInputs: {},
      readCurrentSnapshot: () => ({ held: 1 }),
      fence: {
        checkpoint: { revision: 4, owner: 'team-a' },
        triggerRevision: { revision: 3 },
        revalidateAuthority: () => false,
      },
    });
    assert.equal(refused.status, 'refused-revoked');
    const siblingRow = store.get(sibling) as StoredRow;
    assert.equal(readFanoutChildRow(siblingRow).state, 'pending');
    claimRunning(store, sibling);
    const done = store.record({
      child: sibling,
      result: { kind: 'completed' },
      nowMs: META.nowMs,
      firstAttemptAtMs: META.nowMs,
      policy: POLICY,
    });
    assert.equal(done.status, 'recorded');
  });
});

describe('t34-f3 record: duplicate delivery replays the recorded outcome', () => {
  it('replays terminal records, minting nothing', () => {
    const store = storeWith(['rec-dup']);
    const id = child('rec-dup');
    claimRunning(store, id);
    const first = store.record({
      child: id,
      result: { kind: 'completed' },
      nowMs: META.nowMs,
      firstAttemptAtMs: META.nowMs,
      policy: POLICY,
    });
    assert.equal(first.status, 'recorded');
    if (first.status !== 'recorded') throw new Error('unreachable');
    const version = first.row.version;
    const replay = store.record({
      child: id,
      result: { kind: 'completed' },
      nowMs: META.nowMs + 5,
      firstAttemptAtMs: META.nowMs,
      policy: POLICY,
    });
    assert.equal(replay.status, 'replayed');
    if (replay.status !== 'replayed') throw new Error('unreachable');
    assert.deepEqual(replay.outcome, first.outcome);
    assert.equal(replay.row.version, version);
  });
});
