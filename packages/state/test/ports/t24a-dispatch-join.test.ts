/**
 * T24a dispatch join on the memory store: join-batch validation, the
 * linkage-asserted join port, and trigger-batch atomicity (domain +
 * history + outbox + dispatch rows in one fence revision; trigger
 * rollback voids intents). MEMORY-ONLY proofs (no persist channel);
 * the D1/DO durable proofs live in `t24a-dispatch-join-durable.test.ts`.
 *
 * Dispatch rows below are structural literals (this compiled suite
 * cannot runtime-import `@canlang/work` sources): the model pin lives
 * work-side in `t24a-staging-join.test.ts` (`DISPATCH_JOIN_MODEL` vs
 * `WORK_DISPATCH_MODEL`), and the full claim-lifecycle shape is proven
 * work-side with real rows. The join assertion only reads the row id
 * plus `data.intentId`/`data.guardVerdict`, pinned here exactly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  CommitBatch,
  HistoryEntry,
  ModelName,
  OperationName,
  OutboxIntent,
  RecordId,
  RecordVersion,
  StoredRow,
} from '../../../contracts/src/state.js';
import { StateError } from '../../src/errors.js';
import {
  describeIntentOrigin,
  stageDispatchJoin,
} from '../../src/effects/staging.js';
import {
  DISPATCH_JOIN_MODEL,
  assertDispatchJoin,
  createDispatchJoinPort,
} from '../../src/ports/transact.js';
import type { ExecuteHandler } from '../../src/invocation/invoke.js';
import {
  FIXED_NOW,
  STAGE_OP,
  asId,
  asModel,
  asOperation,
  invokeStage,
  makeStagedIntent,
  makeWidgetRow,
  pendingIntentIds,
  setupPortsWorld,
} from './fixtures.js';

/** Structural dispatch row mirroring the lane-4 `newDispatchRow` shape. */
function joinDispatchRow(
  intentId: string,
  over: Record<string, unknown> = {},
): StoredRow {
  return {
    id: intentId as RecordId,
    version: 1 as RecordVersion,
    created: FIXED_NOW,
    updated: FIXED_NOW,
    createdBy: 't24a-test',
    updatedBy: 't24a-test',
    archivedAt: null,
    parent: null,
    data: {
      intentId,
      operationId: 'op_trigger',
      source: 'std.EmailV1.send',
      occurrenceIndex: 0,
      originOccurrence: null,
      state: 'pending',
      attempts: 0,
      claimId: null,
      claimedAtMs: null,
      guardVerdict: null,
      deliveryId: null,
      errorCode: null,
      errorMessage: null,
      availableAtMs: null,
      firstAttemptAtMs: null,
      retryClass: null,
      ...over,
    },
  };
}

function joinBatch(over: Partial<CommitBatch> = {}): CommitBatch {
  return {
    expectedRevision: 0 as CommitBatch['expectedRevision'],
    writes: [],
    history: [],
    receipt: null,
    outbox: [],
    schedules: [],
    uniqueClaims: [],
    uniqueReleases: [],
    ...over,
  };
}

function joinIntent(intentId: string): OutboxIntent {
  return {
    intentId,
    operation: STAGE_OP as OperationName,
    operationId: 'op_trigger' as OutboxIntent['operationId'],
    target: 'std.EmailV1.send',
    arguments: { to: 'a@example.com' },
    occurrenceIndex: 0,
  };
}

describe('t24a stageDispatchJoin: origins and guard refs', () => {
  it('validates like staging and derives origins plus guard refs', () => {
    const join = stageDispatchJoin(
      [
        makeStagedIntent('tj-i1'),
        { ...makeStagedIntent('tj-i2'), dispatchGuard: 'eligible()' },
      ].map((intent) => ({ ...intent, operationId: 'op_join' })) as OutboxIntent[],
      { operationId: 'op_join' },
    );
    assert.equal(join.operationId, 'op_join');
    assert.deepEqual(
      join.origins.map((origin) => origin.intentId),
      ['tj-i1', 'tj-i2'],
    );
    assert.deepEqual(join.origins[1], {
      intentId: 'tj-i2',
      operation: STAGE_OP,
      operationId: 'op_join',
      target: 'mail.send',
      occurrenceIndex: 0,
      dispatchGuard: 'eligible()',
    });
    assert.deepEqual(join.guards, [{ intentId: 'tj-i2', guard: 'eligible()' }]);
    assert.deepEqual(
      describeIntentOrigin(join.intents[0]!, { operationId: 'op_join' }),
      { ...join.origins[0] },
    );
  });

  it('rejects cross-operation intents and duplicates exactly like staging', () => {
    assert.throws(
      () =>
        stageDispatchJoin(
          [{ ...makeStagedIntent('tj-x'), operationId: 'op_other' } as OutboxIntent],
          { operationId: 'op_join' },
        ),
      /cross-operation staging is forbidden/,
    );
    assert.throws(
      () =>
        stageDispatchJoin(
          [
            makeStagedIntent('tj-dup'),
            makeStagedIntent('tj-dup'),
          ].map((intent) => ({ ...intent, operationId: 'op_join' })) as OutboxIntent[],
          { operationId: 'op_join' },
        ),
      /Duplicate outbox intent id/,
    );
  });

  it('passes empty batches trivially (ordinary triggers stage no dispatch work)', () => {
    const join = stageDispatchJoin([], { operationId: 'op_join' });
    assert.deepEqual([join.intents, join.origins, join.guards], [[], [], []]);
  });
});

describe('t24a assertDispatchJoin: linkage before the store', () => {
  it('passes joined batches, skip-only rows and ordinary batches', () => {
    assertDispatchJoin(
      joinBatch({
        writes: [
          { kind: 'insert', model: DISPATCH_JOIN_MODEL as ModelName, row: joinDispatchRow('tj-a') },
          {
            kind: 'insert',
            model: DISPATCH_JOIN_MODEL as ModelName,
            row: joinDispatchRow('tj-b', { guardVerdict: false }),
          },
        ],
        outbox: [joinIntent('tj-a')],
      }),
    );
    // Ordinary batches with neither half pass trivially.
    assertDispatchJoin(joinBatch());
    // Claim/recovery batches (conditional updates, no outbox) pass too.
    assertDispatchJoin(
      joinBatch({
        writes: [
          {
            kind: 'update',
            model: DISPATCH_JOIN_MODEL as ModelName,
            id: 'tj-a' as RecordId,
            expectedVersion: 1 as RecordVersion,
            row: joinDispatchRow('tj-a', { state: 'claimed' }),
          },
        ],
      }),
    );
  });

  it('fails closed on missing halves, mismatched ids and duplicates', () => {
    // Intent without its row.
    assert.throws(
      () => assertDispatchJoin(joinBatch({ outbox: [joinIntent('tj-lonely')] })),
      /has no work\.dispatch row/,
    );
    // Deliverable row without its intent (only guard-false skips stage row-only).
    assert.throws(
      () =>
        assertDispatchJoin(
          joinBatch({
            writes: [
              { kind: 'insert', model: DISPATCH_JOIN_MODEL as ModelName, row: joinDispatchRow('tj-orphan') },
            ],
          }),
        ),
      /has no outbox intent/,
    );
    // Row id must equal data.intentId.
    const mismatchedBase = joinDispatchRow('tj-id');
    const mismatched: StoredRow = {
      ...mismatchedBase,
      data: { ...(mismatchedBase.data as Record<string, unknown>), intentId: 'tj-other' },
    };
    assert.throws(
      () =>
        assertDispatchJoin(
          joinBatch({
            writes: [
              { kind: 'insert', model: DISPATCH_JOIN_MODEL as ModelName, row: mismatched },
            ],
            outbox: [joinIntent('tj-other')],
          }),
        ),
      /must equal its data\.intentId/,
    );
    // Duplicate rows and duplicate intents.
    assert.throws(
      () =>
        assertDispatchJoin(
          joinBatch({
            writes: [
              { kind: 'insert', model: DISPATCH_JOIN_MODEL as ModelName, row: joinDispatchRow('tj-dup') },
              { kind: 'insert', model: DISPATCH_JOIN_MODEL as ModelName, row: joinDispatchRow('tj-dup') },
            ],
            outbox: [joinIntent('tj-dup')],
          }),
        ),
      /duplicate work\.dispatch row/,
    );
    assert.throws(
      () =>
        assertDispatchJoin(
          joinBatch({
            writes: [
              { kind: 'insert', model: DISPATCH_JOIN_MODEL as ModelName, row: joinDispatchRow('tj-dup') },
            ],
            outbox: [joinIntent('tj-dup'), joinIntent('tj-dup')],
          }),
        ),
      /duplicate outbox intent id/,
    );
    // Malformed row linkage fields fail closed as validation, never raw.
    const badBase = joinDispatchRow('tj-bad');
    const bad: StoredRow = {
      ...badBase,
      data: { ...(badBase.data as Record<string, unknown>), guardVerdict: 'yes' },
    };
    assert.throws(
      () =>
        assertDispatchJoin(
          joinBatch({
            writes: [{ kind: 'insert', model: DISPATCH_JOIN_MODEL as ModelName, row: bad }],
          }),
        ),
      (error: unknown) => error instanceof StateError && error.code === 'validation',
    );
  });
});

describe('t24a commitJoin: atomic trigger-batch staging (MEMORY-ONLY)', () => {
  function historyFor(
    recordId: string,
    operationId: string,
  ): HistoryEntry {
    return {
      model: asModel('Acme.Widget'),
      recordId: asId(recordId),
      version: 1 as RecordVersion,
      operation: asOperation(STAGE_OP),
      operationId: operationId as HistoryEntry['operationId'],
      actor: 't24a-test',
      at: FIXED_NOW,
      change: 'create',
      before: null,
      after: { title: 'Joined' },
    };
  }

  it('commits domain plus history plus outbox plus dispatch rows in one revision', async () => {
    const world = await setupPortsWorld();
    const port = createDispatchJoinPort({ store: world.store });
    const operationId = 'op_join_trigger';
    const committed = await port.commitJoin({
      ...joinBatch({
        writes: [
          { kind: 'insert', model: world.model, row: makeWidgetRow('tj-w1', { title: 'Joined' }) },
          { kind: 'insert', model: DISPATCH_JOIN_MODEL as ModelName, row: joinDispatchRow('tj-i1') },
        ],
        history: [historyFor('tj-w1', operationId)],
        outbox: [{ ...joinIntent('tj-i1'), operationId: operationId as OutboxIntent['operationId'] }],
      }),
      expectedRevision: (await world.store.readRevision()) as CommitBatch['expectedRevision'],
    });
    assert.equal(committed.revision, 1);
    assert.equal(await world.store.readRevision(), 1);
    assert.deepEqual((await world.store.load(world.model, asId('tj-w1')))?.data, {
      title: 'Joined',
    });
    assert.deepEqual(await pendingIntentIds(world.store), ['tj-i1']);
    const row = await world.store.load(DISPATCH_JOIN_MODEL as ModelName, asId('tj-i1'));
    assert.ok(row !== null);
    assert.equal((row!.data as Record<string, unknown>)['state'], 'pending');
    assert.equal(
      (await world.store.historyFor(world.model, asId('tj-w1'))).length,
      1,
    );
  });

  it('asserts linkage before the store: broken joins never reach the fence', async () => {
    const world = await setupPortsWorld();
    const port = createDispatchJoinPort({ store: world.store });
    await assert.rejects(
      port.commitJoin({
        ...joinBatch({ outbox: [joinIntent('tj-norow')] }),
        expectedRevision: (await world.store.readRevision()) as CommitBatch['expectedRevision'],
      }),
      (error: unknown) => error instanceof StateError && error.code === 'validation',
    );
    assert.equal(await world.store.readRevision(), 0);
  });

  it('rolls the whole join back when the trigger write fails (MEMORY-ONLY)', async () => {
    const world = await setupPortsWorld();
    const port = createDispatchJoinPort({ store: world.store });
    const revision = (await world.store.readRevision()) as CommitBatch['expectedRevision'];
    // A version-conflicted trigger write voids the batch: no row, no
    // intent, no dispatch row, no revision step.
    await assert.rejects(
      port.commitJoin({
        ...joinBatch({
          writes: [
            {
              kind: 'update',
              model: world.model,
              id: asId('tj-missing'),
              expectedVersion: 1 as RecordVersion,
              row: makeWidgetRow('tj-missing', { title: 'Void' }),
            },
            { kind: 'insert', model: DISPATCH_JOIN_MODEL as ModelName, row: joinDispatchRow('tj-i9') },
          ],
          outbox: [joinIntent('tj-i9')],
        }),
        expectedRevision: revision,
      }),
    );
    assert.equal(await world.store.readRevision(), 0);
    assert.deepEqual(await pendingIntentIds(world.store), []);
    assert.equal(
      await world.store.load(DISPATCH_JOIN_MODEL as ModelName, asId('tj-i9')),
      null,
    );
  });

  it('stages the join through the invoke path with the triggering batch', async () => {
    const world = await setupPortsWorld();
    const execute: ExecuteHandler = async (call) => ({
      writes: [
        { kind: 'insert', model: world.model, row: makeWidgetRow('tj-iw', { title: 'Invoke' }) },
        {
          kind: 'insert',
          model: DISPATCH_JOIN_MODEL as ModelName,
          row: joinDispatchRow('tj-ii', { operationId: call.context.operationId }),
        },
      ],
      history: [],
      outbox: [
        {
          intentId: 'tj-ii',
          operation: asOperation(STAGE_OP),
          operationId: call.context.operationId,
          target: 'std.EmailV1.send',
          arguments: { to: 'a@example.com' },
          occurrenceIndex: 0,
        },
      ],
      schedules: [],
      uniqueClaims: [],
      uniqueReleases: [],
      resolvedDefaults: {},
      result: { ok: true },
    });
    const out = await invokeStage(world, { execute });
    assert.equal(out.status, 'committed');
    assert.deepEqual(out.deliveries, [{ id: 'tj-ii', status: 'pending' }]);
    assert.equal(await world.store.readRevision(), 1);
    assert.deepEqual(await pendingIntentIds(world.store), ['tj-ii']);
    const row = await world.store.load(DISPATCH_JOIN_MODEL as ModelName, asId('tj-ii'));
    assert.ok(row !== null);
  });
});
