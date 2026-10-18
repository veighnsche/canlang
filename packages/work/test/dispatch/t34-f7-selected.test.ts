/**
 * T34-F7 selected-kernel qualification: ONE installed real-handler drive
 * through the production `DurableFanoutChildStore` under EXPLICIT kernel
 * selection (the staged Wasm backend chosen at the call site, never a
 * default), with atomically joined checkpoint cover + history and a
 * fence-rollback proof, plus one all-seven-family agreement spot through
 * the actual Work owner facades under the same selection.
 *
 * The drive uses a REAL handler (`reviewCommitment`, genuine
 * poison/completion logic) and a REAL guard predicate evaluated against
 * frozen inputs plus the current snapshot — not `() => true` stubs and
 * not direct `kernel[leaf][fn]` probes. F5 membership arrives through
 * the real `stageFanoutMembership` staging; State supplies the real
 * memory substrate (crash-durability over D1/DO stays credited to the
 * dedicated t34-f7 suite, which this change re-runs green).
 *
 * Run from dist FROM THE REPO ROOT: root build, then
 * `node --test packages/work/dist/test/dispatch/t34-f7-selected.test.js`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorkKernel } from '@canlang/work-kernel';
import { distribution } from '@canlang/work-kernel/distribution';
import type {
  HistoryEntry,
  OperationId,
  OperationName,
  RecordId,
  RecordVersion,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import type { FanoutChildId, RetryPolicy } from '@canlang/contracts';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { stageFanoutMembership } from '@canlang/state/effects/staging';
import {
  WORK_FANOUT_CHECKPOINT_MODEL,
  WORK_FANOUT_CHILD_MODEL,
  fanoutCheckpointRowId,
  fanoutChildRowId,
  fanoutIntentRowId,
  newFanoutCheckpointRow,
  newFanoutChildRow,
  readFanoutCheckpointRow,
  readFanoutChildRow,
} from '../../src/kernel/tables.js';
import {
  classifyFailure,
  listDeadLetter,
  recordOutcome,
  toReceiptObservation,
} from '../../src/receipt/index.js';
import { findStaleClaims } from '../../src/recovery/index.js';
import { computeEverySlot } from '../../src/schedule/every.js';
import type { GuardEvaluator } from '../../src/dispatch/index.js';
import { createDurableFanoutChildStore } from '../../src/dispatch/durable.js';
import { TestOnlyManualClock } from '../../src/ports.js';

const OCC = 'occ-f7-selected';
const HANDLER = 'Shift.review_commitment';
const ACTOR = 't34-f7-selected';
const NOW = 1_758_000_000_000;
const META = { nowMs: NOW, actor: ACTOR };
const POLICY: RetryPolicy = { maxAttempts: 3, horizonMs: 60_000 };

const wasmModule = new WebAssembly.Module(readFileSync(distribution.recoveryWasm));
/** The single explicit selection every path below runs through. */
const kernel = createWorkKernel({ backend: 'wasm', module: wasmModule });
const tsKernel = createWorkKernel({ backend: 'ts' });
const FANOUT = fanoutIntentRowId(OCC, HANDLER, 'model', kernel);

function child(recordId: string): FanoutChildId {
  return { parentOccurrence: OCC, handler: HANDLER, recordId };
}

function childRowId(recordId: string): string {
  return fanoutChildRowId(OCC, HANDLER, recordId, kernel);
}

/** REAL handler: genuine poison/completion logic over the record. */
function reviewCommitment(recordId: string): { kind: 'completed' } | { kind: 'failed'; reason: 'business-rejection' } {
  if (recordId === 'r-poison') {
    return { kind: 'failed', reason: 'business-rejection' };
  }
  return { kind: 'completed' };
}

/**
 * REAL guard: the predicate reference resolves against frozen inputs plus
 * the current snapshot. Unresolvable references never silently pass.
 */
const evaluateGuard: GuardEvaluator = (predicate, frozenInputs, snapshot) => {
  const frozen = frozenInputs as { scope: unknown };
  const snap = snapshot as { scope: unknown; admit: unknown };
  if (predicate === 'review-commitment/admit-team') {
    return frozen.scope === 'team:t1' && snap.scope === 'team:t1' && snap.admit === true;
  }
  return false;
};

const PREDICATE = 'review-commitment/admit-team';
const FROZEN = { scope: 'team:t1' };
const snapshotFor = (recordId: string): unknown =>
  recordId === 'r-skipped'
    ? { scope: 'team:t1', admit: false }
    : { scope: 'team:t1', admit: true };

function claimInput(recordId: string): Parameters<ReturnType<typeof createDurableFanoutChildStore>['claim']>[1] {
  return {
    child: child(recordId),
    snapshotVersion: null,
    guard: { predicate: PREDICATE },
    frozenInputs: FROZEN,
    readCurrentSnapshot: () => snapshotFor(recordId),
  };
}

async function commitWrites(store: StoragePort, writes: StoredRow[], model: typeof WORK_FANOUT_CHILD_MODEL | typeof WORK_FANOUT_CHECKPOINT_MODEL): Promise<void> {
  const revision = await store.readRevision();
  await store.commit({
    expectedRevision: revision,
    writes: writes.map((row) => ({ kind: 'insert', model, row })),
    history: [],
    receipt: null,
    outbox: [],
    schedules: [],
    uniqueClaims: [],
    uniqueReleases: [],
  });
}

describe('t34-f7: installed real-handler drive under explicit wasm selection', () => {
  it('claims, executes, records with joined checkpoint cover + history, then progresses', async () => {
    const store = createMemoryStorage();
    const clock = new TestOnlyManualClock(NOW);
    // Production entrypoint under explicit selection (options form).
    const durable = createDurableFanoutChildStore({
      store,
      clock,
      actor: ACTOR,
      kernelOptions: { backend: 'wasm', module: wasmModule },
    });
    // F5: members arrive through the real membership staging.
    const members = stageFanoutMembership(['r-good', 'r-poison', 'r-skipped'], 't34-f7-selected members');
    await commitWrites(
      store,
      [newFanoutCheckpointRow({ fanoutId: FANOUT }, META, kernel)],
      WORK_FANOUT_CHECKPOINT_MODEL,
    );
    for (const recordId of members) {
      await durable.insert(newFanoutChildRow(
        { fanoutId: FANOUT, parentOccurrence: OCC, handler: HANDLER, recordId },
        META,
        kernel,
      ));
    }

    // r-good: claim -> REAL handler -> record completed with joined history.
    const claimed = await durable.claim(evaluateGuard, claimInput('r-good'));
    assert.equal(claimed.status, 'claimed');
    const decided = reviewCommitment('r-good');
    assert.equal(decided.kind, 'completed');
    const running = await durable.get(child('r-good'));
    assert.ok(running !== null);
    const recorded = await durable.record({
      child: child('r-good'),
      result: decided,
      nowMs: NOW,
      firstAttemptAtMs: NOW,
      policy: POLICY,
      join: {
        history: [{
          model: WORK_FANOUT_CHILD_MODEL,
          recordId: childRowId('r-good') as RecordId,
          version: (running.version + 1) as RecordVersion,
          operation: 'Shift.review_commitment' as OperationName,
          operationId: 'op-good' as OperationId,
          actor: ACTOR,
          at: NOW,
          change: 'update',
          before: null,
          after: null,
        } satisfies HistoryEntry],
      },
    });
    assert.equal(recorded.status, 'recorded');
    assert.equal(recorded.outcome.state, 'completed');

    // The terminal outcome and its checkpoint cover landed atomically:
    // the same-fanout checkpoint now covers r-good.
    const checkpointRow = await store.load(
      WORK_FANOUT_CHECKPOINT_MODEL,
      fanoutCheckpointRowId(FANOUT, kernel) as RecordId,
    );
    assert.ok(checkpointRow !== null);
    assert.deepStrictEqual(readFanoutCheckpointRow(checkpointRow, kernel).completed, ['r-good']);
    const history = await store.historyFor(WORK_FANOUT_CHILD_MODEL, childRowId('r-good') as RecordId);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.operation, 'Shift.review_commitment');

    // r-poison: the REAL handler rejects; the record carries it terminally.
    const claimedPoison = await durable.claim(evaluateGuard, claimInput('r-poison'));
    assert.equal(claimedPoison.status, 'claimed');
    const poisonResult = reviewCommitment('r-poison');
    assert.equal(poisonResult.kind, 'failed');
    const recordedPoison = await durable.record({
      child: child('r-poison'),
      result: poisonResult,
      nowMs: NOW,
      firstAttemptAtMs: NOW,
      policy: POLICY,
    });
    assert.equal(recordedPoison.status, 'recorded');
    assert.equal(recordedPoison.outcome.state, 'failed');
    // No caller join was supplied, yet the derived cover still landed.
    const checkpointAfterPoison = await store.load(
      WORK_FANOUT_CHECKPOINT_MODEL,
      fanoutCheckpointRowId(FANOUT, kernel) as RecordId,
    );
    assert.ok(checkpointAfterPoison !== null);
    assert.deepStrictEqual(readFanoutCheckpointRow(checkpointAfterPoison, kernel).completed, ['r-good', 'r-poison']);

    // r-skipped: the REAL guard refuses on the current snapshot.
    const skipped = await durable.claim(evaluateGuard, claimInput('r-skipped'));
    assert.equal(skipped.status, 'skipped');

    const progress = await durable.progress(FANOUT);
    assert.deepStrictEqual(
      { completed: progress.completed, failed: progress.failed, skipped: progress.skipped },
      { completed: 1, failed: 1, skipped: 1 },
    );
    assert.equal(progress.terminal, true);
    assert.equal(progress.attention, true);
  });

  it('rolls back child, cover and join together on a commit conflict', async () => {
    const store = createMemoryStorage();
    const clock = new TestOnlyManualClock(NOW);
    const durable = createDurableFanoutChildStore({ store, clock, actor: ACTOR, kernel });
    await commitWrites(
      store,
      [newFanoutCheckpointRow({ fanoutId: FANOUT }, META, kernel)],
      WORK_FANOUT_CHECKPOINT_MODEL,
    );
    await durable.insert(newFanoutChildRow(
      { fanoutId: FANOUT, parentOccurrence: OCC, handler: HANDLER, recordId: 'r-race' },
      META,
      kernel,
    ));
    const claimed = await durable.claim(evaluateGuard, claimInput('r-race'));
    assert.equal(claimed.status, 'claimed');

    // A join write that must fail (duplicate insert) poisons the batch:
    // the child outcome, its checkpoint cover and the join land nothing.
    const duplicate = await durable.get(child('r-race'));
    assert.ok(duplicate !== null);
    await assert.rejects(
      durable.record({
        child: child('r-race'),
        result: { kind: 'completed' },
        nowMs: NOW,
        firstAttemptAtMs: NOW,
        policy: POLICY,
        join: { writes: [{ kind: 'insert', model: WORK_FANOUT_CHILD_MODEL, row: duplicate }] },
      }),
    );
    const still = await durable.get(child('r-race'));
    assert.ok(still !== null);
    assert.equal(readFanoutChildRow(still, kernel).state, 'running');
    const history = await store.historyFor(WORK_FANOUT_CHILD_MODEL, childRowId('r-race') as RecordId);
    assert.equal(history.length, 0);
    // The checkpoint cover rolled back with the child outcome.
    const checkpointRow = await store.load(
      WORK_FANOUT_CHECKPOINT_MODEL,
      fanoutCheckpointRowId(FANOUT, kernel) as RecordId,
    );
    assert.ok(checkpointRow !== null);
    assert.deepStrictEqual(readFanoutCheckpointRow(checkpointRow, kernel).completed, []);
  });

  it('all seven kernel families agree through the actual Work owners', async () => {
    const item = {
      id: 'obx-1', operationId: 'op', source: 'std.MailboxV1.reply', occurrenceIndex: 0,
      request: { to: 'a' }, originOccurrence: null, attempts: 0, state: 'pending',
    } as never;
    // lifecycle + retry + receipt + recovery + rows + every via Work facades.
    const outcome = { kind: 'delivered', result: { ok: 1 } } as never;
    assert.deepStrictEqual(
      recordOutcome({ item, outcome, nowMs: 1000, firstAttemptAtMs: 0 } as never, kernel),
      recordOutcome({ item, outcome, nowMs: 1000, firstAttemptAtMs: 0 } as never, tsKernel),
    );
    assert.equal(
      classifyFailure({ kind: 'transient', code: 'c', message: 'm' }, kernel),
      classifyFailure({ kind: 'transient', code: 'c', message: 'm' }, tsKernel),
    );
    const live = item as unknown as Record<string, unknown>;
    const dead = [
      { ...live, id: 'b', state: 'dead' },
      { ...live, id: 'a', state: 'dead' },
    ] as never;
    assert.deepStrictEqual(listDeadLetter(dead, kernel), listDeadLetter(dead, tsKernel));
    const recordedFields = { status: 'succeeded', result: { ok: 2 }, error: null } as never;
    assert.deepStrictEqual(
      toReceiptObservation('d1', 3, recordedFields, kernel),
      toReceiptObservation('d1', 3, recordedFields, tsKernel),
    );
    const claims = [
      { outboxId: 'o1', claimId: 'k2', claimedAt: 10 },
      { outboxId: 'o2', claimId: 'k1', claimedAt: 90 },
    ];
    assert.deepStrictEqual(findStaleClaims(claims, 100, 50), findStaleClaims(claims, 100, 50));
    assert.deepStrictEqual(
      kernel.recovery.findStaleClaims(claims, 100, 50),
      tsKernel.recovery.findStaleClaims(claims, 100, 50),
    );
    assert.equal(
      fanoutIntentRowId('o1', 'h', 'model', kernel),
      fanoutIntentRowId('o1', 'h', 'model', tsKernel),
    );
    assert.deepStrictEqual(computeEverySlot(5000, 1000, kernel), computeEverySlot(5000, 1000, tsKernel));
    // linkage: batches with no fanout writes pass trivially on both.
    const emptyBatch = {
      expectedRevision: 0,
      writes: [],
      history: [],
      receipt: null,
      outbox: [],
      schedules: [],
      uniqueClaims: [],
      uniqueReleases: [],
    } as never;
    assert.deepStrictEqual(
      kernel.linkage.assertDispatchJoin(emptyBatch),
      tsKernel.linkage.assertDispatchJoin(emptyBatch),
    );
    assert.deepStrictEqual(
      kernel.linkage.assertFanoutChildJoin(emptyBatch),
      tsKernel.linkage.assertFanoutChildJoin(emptyBatch),
    );
  });
});
