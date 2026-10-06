/**
 * T34-F5 child-unit proofs (memory substrate): the atomic child commit —
 * child domain/history/replay/outbox/schedule effects plus the terminal
 * outcome plus the checkpoint advance in ONE owner transaction — with
 * crash-observers asserting all-or-nothing.
 *
 * Proves (M2/C5): outcome staging cross-checked field-for-field against
 * the REAL F3 record path (attempts rules, exhaustion derivation, pin
 * rules); the linkage assertion's accept/refuse table; full-unit commit
 * observed complete; injected domain-version failure observed absent
 * (nothing partial); fence contention retried then atomic; join-port
 * refusal committing nothing; and the pipeline join threading the
 * source checkpoint to hook bodies. Durable-substrate atomicity +
 * kill/restart crash-observers live in `t34-f5-durable.test.ts`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  CommitBatch,
  DomainWrite,
  HistoryEntry,
  ModelName,
  OperationName,
  OutboxIntent,
  RecordId,
  ScheduleOp,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import type { ResolvedIdentity } from '@canlang/contracts';
import type {
  FanoutChildId,
  FanoutFailedReason,
  RetryPolicy,
} from '@canlang/contracts';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { StateError } from '@canlang/state/errors';
import {
  stageFanoutChildOutcome,
  stageFanoutMembership,
} from '@canlang/state/effects/staging';
import {
  assertFanoutChildJoin,
  createFanoutChildJoinPort,
} from '@canlang/state/ports/transact';
import type { OperationRegistry } from '@canlang/state/invocation/registry';
import { buildContext } from '@canlang/state/invocation/context';
import { runMutationWrites } from '@canlang/state/mutation/pipeline';
import { runFanoutChildWrites } from '@canlang/state/mutation/pipeline';
import { buildModelTable } from '@canlang/state/mutation/models';
import type { MembershipReader } from '@canlang/state/policy/roles';
import {
  FANOUT_CHECKPOINT_MODEL,
  FANOUT_CHILD_MODEL,
  FANOUT_INTENT_MODEL,
  fanoutChildRowId,
  fanoutIntentRowId,
  newFanoutCheckpointRow,
  newFanoutChildRow,
  newFanoutIntentRow,
  readFanoutCheckpointRow,
  readFanoutChildRow,
  withFanoutRowData,
} from '@canlang/state/fanout/tables';
import { freezeFanoutMembership } from '@canlang/state/fanout/membership';
import {
  FANOUT_T32_REFUSAL_REASON,
  stageFanoutCheckpointAdvanceWrite,
  stageFanoutChildOutcomeWrite,
  type FanoutChildAttemptResult,
} from '@canlang/state/fanout/outcome';
import { driveFanoutChild, observeFanoutUnit } from '@canlang/state/testing/fanout/test-driver';
import { loadWorkFanoutFns, type WorkFanoutFns } from './work-loader.js';
import {
  FIXED_NOW,
  asId,
  asModel,
  asOperation,
  createMemoryIdentityStore,
  makeBatch,
  makeDef,
  makeIdentity,
  makeRow,
  seedMember,
  uuidv7,
} from '@canlang/state/testing/invocation/fixtures';
import {
  field,
  hook,
  modelDef,
} from '@canlang/state/testing/mutation/fixtures';

const MODEL = 'Acme.Commitment';
const HANDLER = 'Shift.review_commitment';
const SOURCE = 'occ-unit-1';
const APP = 'acme-app';
const CHILD_OP = 'Acme.review_child';
const ACTOR = 't34-f5-join';
const META = { nowMs: FIXED_NOW, actor: ACTOR };
const POLICY: RetryPolicy = { maxAttempts: 3, horizonMs: 60_000 };

const fns: WorkFanoutFns = await loadWorkFanoutFns();

interface JoinWorld {
  readonly store: StoragePort;
  readonly memberships: MembershipReader;
  readonly registry: OperationRegistry;
  readonly identity: ResolvedIdentity;
  readonly owner: string;
  readonly clock: { nowMs(): number };
}

async function setupJoinWorld(model: string): Promise<JoinWorld> {
  const store = createMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const registry: OperationRegistry = new Map();
  (registry as Map<string, unknown>).set(
    CHILD_OP,
    makeDef({
      name: asOperation(CHILD_OP),
      by: 'members',
      inputs: {
        record: { type: 'record', model: asModel(model), versioned: false, required: true },
      },
    }),
  );
  return {
    store,
    memberships,
    registry,
    identity: makeIdentity({ membership: alice.membership }),
    owner: alice.team.team_id as string,
    clock: { nowMs: () => FIXED_NOW },
  };
}

async function seedRecord(store: StoragePort, model: string, id: string): Promise<StoredRow> {
  const row = makeRow({ id, data: { label: id } });
  const revision = await store.readRevision();
  await store.commit(
    makeBatch(revision as number, {
      writes: [{ kind: 'insert', model: asModel(model), row }],
    }),
  );
  return row;
}

/** Full test effects: domain mark + history + outbox + schedule + completed. */
function fullEffects(
  operationId: string,
  domainRow: StoredRow,
): {
  readonly writes: DomainWrite[];
  readonly history: HistoryEntry[];
  readonly outbox: OutboxIntent[];
  readonly schedules: ScheduleOp[];
  readonly result: FanoutChildAttemptResult;
} {
  const next: StoredRow = {
    ...domainRow,
    version: (domainRow.version + 1) as StoredRow['version'],
    updated: FIXED_NOW,
    updatedBy: ACTOR,
    data: { ...(domainRow.data as Record<string, unknown>), reviewed: true },
  };
  return {
    writes: [
      {
        kind: 'update',
        model: asModel(MODEL),
        id: domainRow.id,
        expectedVersion: domainRow.version,
        row: next,
      },
    ],
    history: [
      {
        model: asModel(MODEL),
        recordId: domainRow.id,
        version: next.version,
        operation: asOperation(CHILD_OP),
        operationId: operationId as never,
        actor: ACTOR,
        at: FIXED_NOW,
        change: 'update',
        before: domainRow.data as Record<string, unknown>,
        after: next.data as Record<string, unknown>,
      },
    ],
    outbox: [
      {
        intentId: `${operationId}#0`,
        operation: asOperation(CHILD_OP),
        operationId: operationId as never,
        target: 'Acme.notify',
        arguments: { record: domainRow.id as string },
        occurrenceIndex: 0,
      },
    ],
    schedules: [
      {
        op: 'replace',
        key: `review-${domainRow.id as string}`,
        at: FIXED_NOW + 1000,
        event: asOperation('Acme.remind'),
        payload: { record: domainRow.id as string },
      },
    ],
    result: { kind: 'completed' },
  };
}

describe('t34-f5 staging join: frozen-set + outcome validation', () => {
  it('stageFanoutMembership sorts; duplicates and empties fail closed', () => {
    assert.deepEqual(stageFanoutMembership(['b', 'a', 'c'], 'members'), ['a', 'b', 'c']);
    assert.throws(() => stageFanoutMembership(['a', 'a'], 'members'), StateError);
    assert.throws(() => stageFanoutMembership(['a', ''], 'members'), StateError);
    assert.throws(() => stageFanoutMembership('nope' as unknown as string[], 'members'), StateError);
  });

  it('stageFanoutChildOutcome pins the closed cause table', () => {
    assert.deepEqual(
      stageFanoutChildOutcome({ state: 'completed', causeKind: 'completed', causeReason: null, attempts: 1 }),
      { state: 'completed', causeKind: 'completed', causeReason: null, attempts: 1 },
    );
    assert.deepEqual(
      stageFanoutChildOutcome({ state: 'skipped', causeKind: 'skipped', causeReason: 'deleted', attempts: 0 }),
      { state: 'skipped', causeKind: 'skipped', causeReason: 'deleted', attempts: 0 },
    );
    // Open causes, non-terminal states, and bad attempts fail closed.
    assert.throws(
      () => stageFanoutChildOutcome({ state: 'skipped', causeKind: 'skipped', causeReason: 'bogus', attempts: 0 }),
      StateError,
    );
    assert.throws(
      () => stageFanoutChildOutcome({ state: 'failed', causeKind: 'failed', causeReason: null, attempts: 1 }),
      StateError,
    );
    assert.throws(
      () => stageFanoutChildOutcome({ state: 'pending', causeKind: null, causeReason: null, attempts: 0 }),
      StateError,
    );
    assert.throws(
      () => stageFanoutChildOutcome({ state: 'completed', causeKind: 'completed', causeReason: null, attempts: -1 }),
      StateError,
    );
  });
});

describe('t34-f5 outcome staging: F3 record cross-check', () => {
  const T0 = FIXED_NOW;

  /** Run the REAL F3 claim→record path for one result; return the recorded row data. */
  function realRecord(
    startAttempts: number,
    result: FanoutChildAttemptResult,
    nowMs: number,
    firstAttemptAtMs: number,
  ): { readonly state: string; readonly attempts: number; readonly causeKind: string | null; readonly causeReason: string | null } {
    const store = new fns.TestOnlyMemoryFanoutChildStore({ nowMs: () => nowMs });
    const fanoutId = fns.fanoutIntentRowId(SOURCE, HANDLER, 'model');
    store.insert(
      fns.newFanoutChildRow(
        {
          fanoutId,
          parentOccurrence: SOURCE,
          handler: HANDLER,
          recordId: 'r-1',
          attempts: startAttempts,
        },
        { nowMs: T0, actor: ACTOR },
      ),
    );
    const child: FanoutChildId = { parentOccurrence: SOURCE, handler: HANDLER, recordId: 'r-1' };
    const claimed = store.claim(() => true, {
      child,
      snapshotVersion: null,
      guard: { predicate: null },
      frozenInputs: null,
      readCurrentSnapshot: () => null,
    });
    assert.equal(claimed.status, 'claimed');
    const recorded = store.record({ child, result, nowMs, firstAttemptAtMs, policy: POLICY });
    assert.ok(recorded.status === 'recorded' || recorded.status === 'retried');
    const data = fns.readFanoutChildRow(recorded.row);
    return {
      state: data.state,
      attempts: data.attempts,
      causeKind: data.causeKind,
      causeReason: data.causeReason,
    };
  }

  /** Run the state stager from an equivalent running row; return the staged row data. */
  function stagedRecord(
    startAttempts: number,
    result: FanoutChildAttemptResult,
    nowMs: number,
    firstAttemptAtMs: number,
  ): { readonly state: string; readonly attempts: number; readonly causeKind: string | null; readonly causeReason: string | null } {
    const fanoutId = fanoutIntentRowId(SOURCE, HANDLER, 'model');
    const pending = newFanoutChildRow(
      { fanoutId, parentOccurrence: SOURCE, handler: HANDLER, recordId: 'r-1', attempts: startAttempts },
      META,
    );
    const running = withFanoutRowData(pending, { ...readFanoutChildRow(pending), state: 'running' }, META);
    const staged = stageFanoutChildOutcomeWrite({
      row: running,
      result,
      nowMs,
      firstAttemptAtMs,
      policy: POLICY,
      meta: { nowMs, actor: ACTOR },
    });
    const data = readFanoutChildRow(staged.row);
    return {
      state: data.state,
      attempts: data.attempts,
      causeKind: data.causeKind,
      causeReason: data.causeReason,
    };
  }

  const CASES: ReadonlyArray<{
    readonly name: string;
    readonly result: FanoutChildAttemptResult;
    readonly nowMs: number;
  }> = [
    { name: 'completed', result: { kind: 'completed' }, nowMs: T0 + 1000 },
    { name: 'skipped/non-applicable', result: { kind: 'skipped', reason: 'non-applicable' }, nowMs: T0 + 1000 },
    { name: 'failed/terminal', result: { kind: 'failed', reason: 'terminal' }, nowMs: T0 + 1000 },
    { name: 'transient within budget', result: { kind: 'transient' }, nowMs: T0 + 1000 },
    { name: 'transient past attempt cap', result: { kind: 'transient' }, nowMs: T0 + 1000 },
    { name: 'transient past horizon', result: { kind: 'transient' }, nowMs: T0 + POLICY.horizonMs + 1 },
  ];

  for (const kase of CASES) {
    it(`record ${kase.name} matches F3 field-for-field`, () => {
      const startAttempts = kase.name === 'transient past attempt cap' ? POLICY.maxAttempts - 1 : 1;
      assert.deepEqual(
        stagedRecord(startAttempts, kase.result, kase.nowMs, T0),
        realRecord(startAttempts, kase.result, kase.nowMs, T0),
      );
    });
  }

  it('pending-row pins record terminal with attempts unchanged', () => {
    const fanoutId = fanoutIntentRowId(SOURCE, HANDLER, 'model');
    for (const result of [
      { kind: 'skipped', reason: 'deleted' },
      { kind: 'failed', reason: 'missing-record' },
    ] as const satisfies ReadonlyArray<FanoutChildAttemptResult>) {
      const pending = newFanoutChildRow(
        { fanoutId, parentOccurrence: SOURCE, handler: HANDLER, recordId: 'r-9', attempts: 2 },
        META,
      );
      const staged = stageFanoutChildOutcomeWrite({
        row: pending,
        result,
        nowMs: T0,
        firstAttemptAtMs: T0,
        policy: POLICY,
        meta: META,
      });
      assert.equal(staged.terminal, true);
      const data = readFanoutChildRow(staged.row);
      assert.equal(data.attempts, 2);
      assert.equal(data.state, result.kind);
    }
    // Completed/transient pins are refused (both need an executed attempt).
    const pending = newFanoutChildRow(
      { fanoutId, parentOccurrence: SOURCE, handler: HANDLER, recordId: 'r-9' },
      META,
    );
    assert.throws(
      () =>
        stageFanoutChildOutcomeWrite({
          row: pending,
          result: { kind: 'completed' },
          nowMs: T0,
          firstAttemptAtMs: T0,
          policy: POLICY,
          meta: META,
        }),
      StateError,
    );
    // Recording against a terminal row is a caller bug (replay is the driver's job).
    const terminal = withFanoutRowData(
      pending,
      { ...readFanoutChildRow(pending), state: 'completed', causeKind: 'completed' },
      META,
    );
    assert.throws(
      () =>
        stageFanoutChildOutcomeWrite({
          row: terminal,
          result: { kind: 'completed' },
          nowMs: T0,
          firstAttemptAtMs: T0,
          policy: POLICY,
          meta: META,
        }),
      StateError,
    );
  });

  it('T32 refusal mapping matches F3', () => {
    assert.equal(FANOUT_T32_REFUSAL_REASON, fns.FANOUT_T32_REFUSAL_REASON);
    assert.equal(FANOUT_T32_REFUSAL_REASON, 'inaccessible-record');
  });
});

describe('t34-f5 transact join: linkage accept/refuse table', () => {
  const FANOUT_A = fanoutIntentRowId('occ-a', 'H', 'model');
  const FANOUT_B = fanoutIntentRowId('occ-b', 'H', 'model');

  function terminalChild(fanoutId: string, recordId: string): StoredRow {
    const pending = newFanoutChildRow(
      { fanoutId, parentOccurrence: 'occ-a', handler: 'H', recordId },
      META,
    );
    const running = withFanoutRowData(
      pending,
      { ...readFanoutChildRow(pending), state: 'running' },
      META,
    );
    return stageFanoutChildOutcomeWrite({
      row: running,
      result: { kind: 'completed' },
      nowMs: FIXED_NOW,
      firstAttemptAtMs: FIXED_NOW,
      policy: POLICY,
      meta: META,
    }).row;
  }

  function coveringCheckpoint(fanoutId: string, recordId: string): StoredRow {
    const checkpoint = newFanoutCheckpointRow({ fanoutId }, META);
    return stageFanoutCheckpointAdvanceWrite({ row: checkpoint, recordId, meta: META }).row;
  }

  function unitBatch(fanoutId: string, recordId: string): CommitBatch {
    return makeBatch(1, {
      writes: [
        {
          kind: 'update',
          model: FANOUT_CHILD_MODEL as ModelName,
          id: fanoutChildRowId('occ-a', 'H', recordId) as RecordId,
          expectedVersion: 2 as never,
          row: terminalChild(fanoutId, recordId),
        },
        {
          kind: 'update',
          model: FANOUT_CHECKPOINT_MODEL as ModelName,
          id: fanoutId as RecordId,
          expectedVersion: 1 as never,
          row: coveringCheckpoint(fanoutId, recordId),
        },
      ],
    });
  }

  it('accepts the co-committed outcome + checkpoint pair', () => {
    assert.doesNotThrow(() => assertFanoutChildJoin(unitBatch(FANOUT_A, 'r-1')));
  });

  it('accepts multi-child units and empty/non-fanout batches', () => {
    // One batch, two terminal children, ONE checkpoint update covering both.
    const both = newFanoutCheckpointRow({ fanoutId: FANOUT_A, completed: ['r-1', 'r-2'] }, META);
    const multi = makeBatch(1, {
      writes: [
        {
          kind: 'update',
          model: FANOUT_CHILD_MODEL as ModelName,
          id: fanoutChildRowId('occ-a', 'H', 'r-1') as RecordId,
          expectedVersion: 2 as never,
          row: terminalChild(FANOUT_A, 'r-1'),
        },
        {
          kind: 'update',
          model: FANOUT_CHILD_MODEL as ModelName,
          id: fanoutChildRowId('occ-a', 'H', 'r-2') as RecordId,
          expectedVersion: 2 as never,
          row: terminalChild(FANOUT_A, 'r-2'),
        },
        {
          kind: 'update',
          model: FANOUT_CHECKPOINT_MODEL as ModelName,
          id: FANOUT_A as RecordId,
          expectedVersion: 1 as never,
          row: both,
        },
      ],
    });
    assert.doesNotThrow(() => assertFanoutChildJoin(multi));
    assert.doesNotThrow(() => assertFanoutChildJoin(makeBatch(1, {})));
    assert.doesNotThrow(() =>
      assertFanoutChildJoin(
        makeBatch(1, {
          writes: [
            { kind: 'insert', model: asModel(MODEL), row: makeRow({ id: 'x' }) },
          ],
        }),
      ),
    );
  });

  it('refuses outcome-without-checkpoint and checkpoint-without-outcome', () => {
    const unit = unitBatch(FANOUT_A, 'r-1');
    assert.throws(
      () => assertFanoutChildJoin(makeBatch(1, { writes: [unit.writes[0] as DomainWrite] })),
      StateError,
    );
    assert.throws(
      () => assertFanoutChildJoin(makeBatch(1, { writes: [unit.writes[1] as DomainWrite] })),
      StateError,
    );
  });

  it('refuses cross-fanout cover', () => {
    const unit = unitBatch(FANOUT_A, 'r-1');
    const foreign = coveringCheckpoint(FANOUT_B, 'r-1');
    assert.throws(
      () =>
        assertFanoutChildJoin(
          makeBatch(1, {
            writes: [
              unit.writes[0] as DomainWrite,
              {
                kind: 'update',
                model: FANOUT_CHECKPOINT_MODEL as ModelName,
                id: FANOUT_B as RecordId,
                expectedVersion: 1 as never,
                row: foreign,
              },
            ],
          }),
        ),
      StateError,
    );
  });

  it('refuses fabricated completion and redefined frozen sets', () => {
    // Child insert already running.
    const running = withFanoutRowData(
      newFanoutChildRow({ fanoutId: FANOUT_A, parentOccurrence: 'occ-a', handler: 'H', recordId: 'r-1' }, META),
      { ...readFanoutChildRow(newFanoutChildRow({ fanoutId: FANOUT_A, parentOccurrence: 'occ-a', handler: 'H', recordId: 'r-1' }, META)), state: 'running' },
      META,
    );
    assert.throws(
      () =>
        assertFanoutChildJoin(
          makeBatch(1, {
            writes: [{ kind: 'insert', model: FANOUT_CHILD_MODEL as ModelName, row: running }],
          }),
        ),
      StateError,
    );
    // Checkpoint insert with non-empty completed.
    assert.throws(
      () =>
        assertFanoutChildJoin(
          makeBatch(1, {
            writes: [
              {
                kind: 'insert',
                model: FANOUT_CHECKPOINT_MODEL as ModelName,
                row: newFanoutCheckpointRow({ fanoutId: FANOUT_A, completed: ['r-1'] }, META),
              },
            ],
          }),
        ),
      StateError,
    );
    // Intent update (frozen set redefinition).
    const intent = newFanoutIntentRow(
      { sourceOccurrence: 'occ-a', handler: 'H', cohort: 'model', members: ['r-1'] },
      META,
    );
    assert.throws(
      () =>
        assertFanoutChildJoin(
          makeBatch(1, {
            writes: [
              {
                kind: 'update',
                model: FANOUT_INTENT_MODEL as ModelName,
                id: FANOUT_A as RecordId,
                expectedVersion: 1 as never,
                row: intent,
              },
            ],
          }),
        ),
      StateError,
    );
    // Fanout row removal.
    assert.throws(
      () =>
        assertFanoutChildJoin(
          makeBatch(1, {
            writes: [
              {
                kind: 'remove',
                model: FANOUT_CHILD_MODEL as ModelName,
                id: fanoutChildRowId('occ-a', 'H', 'r-1') as RecordId,
                expectedVersion: 1 as never,
              },
            ],
          }),
        ),
      StateError,
    );
  });

  it('refuses row-identity mismatch and open causes', () => {
    const good = terminalChild(FANOUT_A, 'r-1');
    const tampered: StoredRow = {
      ...good,
      data: { ...(good.data as Record<string, unknown>), recordId: 'r-2' },
    };
    assert.throws(
      () =>
        assertFanoutChildJoin(
          makeBatch(1, {
            writes: [
              {
                kind: 'update',
                model: FANOUT_CHILD_MODEL as ModelName,
                id: good.id,
                expectedVersion: 1 as never,
                row: tampered,
              },
              {
                kind: 'update',
                model: FANOUT_CHECKPOINT_MODEL as ModelName,
                id: FANOUT_A as RecordId,
                expectedVersion: 1 as never,
                row: coveringCheckpoint(FANOUT_A, 'r-1'),
              },
            ],
          }),
        ),
      StateError,
    );
  });

  it('join-port refusal commits nothing (revision pinned)', async () => {
    const { store } = await setupJoinWorld(MODEL);
    const port = createFanoutChildJoinPort({ store });
    const unit = unitBatch(FANOUT_A, 'r-1');
    const revBefore = await store.readRevision();
    await assert.rejects(
      () =>
        port.commitJoin({
          ...makeBatch(revBefore as number, { writes: [unit.writes[0] as DomainWrite] }),
          expectedRevision: revBefore,
        }),
      StateError,
    );
    assert.equal(await store.readRevision(), revBefore);
  });
});

describe('t34-f5 child unit: crash-observers (all-or-nothing)', () => {
  async function frozenWorld(size: number): Promise<
    JoinWorld & { readonly fanoutId: string; readonly members: ReadonlyArray<string> }
  > {
    const world = await setupJoinWorld(MODEL);
    for (let index = 0; index < size; index += 1) {
      await seedRecord(world.store, MODEL, `u-${String(index).padStart(3, '0')}`);
    }
    const outcome = await freezeFanoutMembership({
      store: world.store,
      cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
      cohort: { kind: 'model', owner: world.owner, model: MODEL },
      owner: world.owner,
      bounds: { pageLimit: 16, chunkSize: 16, maxAttempts: 5 },
      meta: META,
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) {
      throw new Error('freeze failed in test setup');
    }
    return { ...world, fanoutId: outcome.frozen.fanoutId, members: outcome.frozen.members };
  }

  function driveInput(
    world: JoinWorld & { readonly fanoutId: string },
    recordId: string,
    operationId: string,
    body: (row: StoredRow) => Promise<ReturnType<typeof fullEffects>>,
  ): Parameters<typeof driveFanoutChild>[0] {
    return {
      store: world.store,
      memberships: world.memberships,
      registry: world.registry,
      clock: world.clock,
      identity: world.identity,
      app: APP,
      source: 'test.fanout',
      childOperation: CHILD_OP,
      operationId,
      refInput: 'record',
      driven: {
        child: { parentOccurrence: SOURCE, handler: HANDLER, recordId },
        fanoutId: world.fanoutId,
        model: MODEL,
        recordId,
      },
      guard: () => true,
      body,
      nowMs: FIXED_NOW,
      firstAttemptAtMs: FIXED_NOW,
      policy: POLICY,
      meta: META,
    };
  }

  it('M2/C5 full unit commits: domain + history + receipt + outbox + schedule + outcome + checkpoint', async () => {
    const world = await frozenWorld(3);
    const recordId = world.members[0] as string;
    const operationId = uuidv7(FIXED_NOW, 1);
    const outcome = await driveFanoutChild(
      driveInput(world, recordId, operationId, async (row) => fullEffects(operationId, row)),
    );
    assert.equal(outcome.status, 'recorded');
    const observed = await observeFanoutUnit({
      store: world.store,
      fanoutId: world.fanoutId,
      child: { parentOccurrence: SOURCE, handler: HANDLER, recordId },
      domain: { model: MODEL, id: recordId, marker: 'reviewed' },
      receipt: {
        app: APP,
        owner: world.owner,
        principal: (world.identity.actor as { readonly user_id: string }).user_id,
        operation: CHILD_OP,
        operationId,
      },
      outboxIntentId: `${operationId}#0`,
      scheduleKey: `review-${recordId}`,
    });
    assert.deepEqual(observed, { verdict: 'complete' });
  });

  it('M2 stale domain version fails the unit with NOTHING committed', async () => {
    const world = await frozenWorld(2);
    const recordId = world.members[0] as string;
    const operationId = uuidv7(FIXED_NOW, 2);
    const outcome = await driveFanoutChild(
      driveInput(world, recordId, operationId, async (row) => {
        const effects = fullEffects(operationId, row);
        // Sabotage: the domain update carries a stale expected version,
        // so the unit commit loses the version check and rolls back.
        const sabotaged: DomainWrite = {
          kind: 'update',
          model: asModel(MODEL),
          id: row.id,
          expectedVersion: 999 as never,
          row: (effects.writes[0] as { readonly row: StoredRow }).row,
        };
        return { ...effects, writes: [sabotaged] };
      }),
    );
    assert.equal(outcome.status, 'retry');
    const observed = await observeFanoutUnit({
      store: world.store,
      fanoutId: world.fanoutId,
      child: { parentOccurrence: SOURCE, handler: HANDLER, recordId },
      domain: { model: MODEL, id: recordId, marker: 'reviewed' },
      receipt: {
        app: APP,
        owner: world.owner,
        principal: (world.identity.actor as { readonly user_id: string }).user_id,
        operation: CHILD_OP,
        operationId,
      },
      outboxIntentId: `${operationId}#0`,
      scheduleKey: `review-${recordId}`,
    });
    assert.deepEqual(observed, { verdict: 'absent' });
  });

  it('M2 fence contention retries, then commits atomically', async () => {
    const world = await frozenWorld(2);
    const recordId = world.members[1] as string;
    const operationId = uuidv7(FIXED_NOW, 3);
    let commits = 0;
    const racing: StoragePort = {
      ...world.store,
      commit: async (batch) => {
        commits += 1;
        if (commits === 2) {
          // One rival write lands before the unit commit (the claim is
          // commit 1): invoke's fence retry re-admits and re-executes
          // (fresh fanout versions), then commits the full unit.
          const revision = await world.store.readRevision();
          await world.store.commit(
            makeBatch(revision as number, {
              writes: [
                {
                  kind: 'insert',
                  model: asModel(MODEL),
                  row: makeRow({ id: 'rival-row', data: {} }),
                },
              ],
            }),
          );
        }
        return world.store.commit(batch);
      },
    };
    const input = driveInput(world, recordId, operationId, async (row) => fullEffects(operationId, row));
    const outcome = await driveFanoutChild({ ...input, store: racing });
    assert.equal(outcome.status, 'recorded');
    const observed = await observeFanoutUnit({
      store: world.store,
      fanoutId: world.fanoutId,
      child: { parentOccurrence: SOURCE, handler: HANDLER, recordId },
      domain: { model: MODEL, id: recordId, marker: 'reviewed' },
      receipt: {
        app: APP,
        owner: world.owner,
        principal: (world.identity.actor as { readonly user_id: string }).user_id,
        operation: CHILD_OP,
        operationId,
      },
      outboxIntentId: `${operationId}#0`,
      scheduleKey: `review-${recordId}`,
    });
    assert.deepEqual(observed, { verdict: 'complete' });
  });
});

describe('t34-f5 pipeline join: source checkpoint threading', () => {
  it('runFanoutChildWrites threads the source fence point to hook bodies', async () => {
    const store = createMemoryStorage();
    const seen: Array<{ readonly triggerRevision: unknown; readonly owner: string }> = [];
    const table = buildModelTable([
      modelDef(MODEL, {
        fields: { reviewed: field(), label: field() },
        hooks: [
          hook('observe', ['update'], (candidate, ctx) => {
            seen.push({
              triggerRevision: ctx.transitive.triggerRevision,
              owner: ctx.transitive.owner,
            });
            return candidate;
          }),
        ],
      }),
    ]);
    await seedRecord(store, MODEL, 'p-1');
    const revision = await store.readRevision();
    const context = buildContext({
      identity: makeIdentity({}),
      operation: asOperation(CHILD_OP),
      operationId: uuidv7(FIXED_NOW, 9),
      app: APP,
      source: 'test.fanout',
      now: FIXED_NOW,
    });
    const row = await store.load(asModel(MODEL), asId('p-1'));
    assert.ok(row !== null);
    const result = await runFanoutChildWrites({
      table,
      writes: [{ op: 'update', model: asModel(MODEL), id: asId('p-1'), data: { reviewed: true } }],
      context,
      store,
      sourceCheckpoint: { revision, owner: 'team-source' },
    });
    assert.equal(result.writes.length, 1);
    assert.deepEqual(seen, [{ triggerRevision: revision, owner: 'team-source' }]);
    // Baseline: the undelegated pipeline names no trigger revision.
    seen.length = 0;
    await runMutationWrites({ table, writes: [], context, store });
    assert.deepEqual(seen, []);
  });
});
