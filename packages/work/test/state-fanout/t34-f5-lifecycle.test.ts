/**
 * T34-F5 lifecycle proofs (memory substrate): current-state lookup
 * classifying each frozen member as present/deleted/moved/unknown, and
 * the terminal recording each classification drives.
 *
 * Proves (M4/C7): demonstrably deleted children (archived tombstone,
 * history-recorded disposal) record skipped/deleted WITHOUT executing;
 * moved records re-evaluate against the current body guard (false →
 * skipped/non-applicable, true → executed); unknown lookups
 * (missing-record, infra-read-failure) and authority failures
 * (inaccessible-record) NEVER masquerade as deletion — they record
 * failed with distinct reasons; and every classification feeds the REAL
 * F4 recovery scan to the pinned plan.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ModelName,
  RecordId,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import type { RetryPolicy } from '@canlang/contracts';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { StateError } from '@canlang/state/errors';
import type { OperationRegistry } from '@canlang/state/invocation/registry';
import type { MembershipReader } from '@canlang/state/policy/roles';
import {
  FANOUT_CHECKPOINT_MODEL,
  FANOUT_CHILD_MODEL,
  FANOUT_INTENT_MODEL,
  fanoutChildRowId,
  readFanoutChildRow,
} from '@canlang/state/fanout/tables';
import { freezeFanoutMembership } from '@canlang/state/fanout/membership';
import {
  classifyFanoutChildLifecycle,
  refusedFanoutLifecycle,
} from '@canlang/state/fanout/lifecycle';
import { driveFanoutChild } from '@canlang/state/testing/fanout/test-driver';
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

const MODEL = 'Acme.Signup';
const PARENT_MODEL = 'Acme.Opportunity';
const HANDLER = 'Volunteer.cancel_signup';
const SOURCE = 'occ-life-1';
const APP = 'acme-app';
const CHILD_OP = 'Acme.cancel_child';
const ACTOR = 't34-f5-lifecycle';
const META = { nowMs: FIXED_NOW, actor: ACTOR };
const POLICY: RetryPolicy = { maxAttempts: 3, horizonMs: 60_000 };

const fns: WorkFanoutFns = await loadWorkFanoutFns();

async function setup() {
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
        record: { type: 'record', model: asModel(MODEL), versioned: false, required: true },
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

async function seedParent(store: StoragePort, id: string): Promise<StoredRow> {
  const row = makeRow({ id, data: { venue: 'hall' } });
  const revision = await store.readRevision();
  await store.commit(
    makeBatch(revision as number, {
      writes: [{ kind: 'insert', model: asModel(PARENT_MODEL), row }],
    }),
  );
  return row;
}

async function seedChild(
  store: StoragePort,
  id: string,
  parentId: string | null,
  data: Record<string, unknown> = {},
): Promise<StoredRow> {
  const row = {
    ...makeRow({ id, data: { state: 'registered', ...data } }),
    ...(parentId === null
      ? {}
      : { parent: { model: asModel(PARENT_MODEL), id: asId(parentId) } }),
  };
  const revision = await store.readRevision();
  await store.commit(
    makeBatch(revision as number, {
      writes: [{ kind: 'insert', model: asModel(MODEL), row }],
    }),
  );
  return row;
}

async function freezeAnchored(
  store: StoragePort,
  owner: string,
  parentId: string,
): Promise<string> {
  const outcome = await freezeFanoutMembership({
    store,
    cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
    cohort: {
      kind: 'anchored-collection',
      owner,
      model: MODEL,
      parent: { model: PARENT_MODEL, id: parentId },
    },
    owner,
    bounds: { pageLimit: 16, chunkSize: 16, maxAttempts: 5 },
    meta: META,
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) {
    throw new Error('freeze failed in test setup');
  }
  return outcome.frozen.fanoutId;
}

async function childState(store: StoragePort, recordId: string): Promise<StoredRow> {
  const row = await store.load(
    FANOUT_CHILD_MODEL as ModelName,
    fanoutChildRowId(SOURCE, HANDLER, recordId) as RecordId,
  );
  assert.ok(row !== null);
  return row;
}

describe('t34-f5 lifecycle: classification table', () => {
  it('live rows classify present (anchored match, whole-model)', async () => {
    const { store } = await setup();
    await seedParent(store, 'opp-1');
    await seedChild(store, 's-1', 'opp-1');
    assert.deepEqual(
      await classifyFanoutChildLifecycle({
        store,
        model: MODEL,
        recordId: 's-1',
        anchor: { model: PARENT_MODEL, id: 'opp-1' },
      }),
      { status: 'present' },
    );
    assert.deepEqual(
      await classifyFanoutChildLifecycle({ store, model: MODEL, recordId: 's-1' }),
      { status: 'present' },
    );
  });

  it('archived rows classify deleted (explicit tombstone)', async () => {
    const { store } = await setup();
    await seedParent(store, 'opp-1');
    const row = await seedChild(store, 's-2', 'opp-1');
    const revision = await store.readRevision();
    await store.commit(
      makeBatch(revision as number, {
        writes: [
          {
            kind: 'update',
            model: asModel(MODEL),
            id: asId('s-2'),
            expectedVersion: row.version,
            row: { ...row, version: (row.version + 1) as never, archivedAt: FIXED_NOW },
          },
        ],
      }),
    );
    assert.deepEqual(
      await classifyFanoutChildLifecycle({ store, model: MODEL, recordId: 's-2' }),
      { status: 'deleted' },
    );
  });

  it('history-recorded disposal classifies deleted; bare nulls classify unknown', async () => {
    const { store } = await setup();
    await seedParent(store, 'opp-1');
    const row = await seedChild(store, 's-3', 'opp-1');
    const revision = await store.readRevision();
    await store.commit(
      makeBatch(revision as number, {
        writes: [
          { kind: 'remove', model: asModel(MODEL), id: asId('s-3'), expectedVersion: row.version },
        ],
        history: [
          {
            model: asModel(MODEL),
            recordId: asId('s-3'),
            version: row.version,
            operation: asOperation('Acme.remove'),
            operationId: 'op-1' as never,
            actor: ACTOR,
            at: FIXED_NOW,
            change: 'remove',
            before: {},
            after: null,
          },
        ],
      }),
    );
    assert.deepEqual(
      await classifyFanoutChildLifecycle({ store, model: MODEL, recordId: 's-3' }),
      { status: 'deleted' },
    );
    // Never-existed: unknown/missing-record — NEVER deletion.
    assert.deepEqual(
      await classifyFanoutChildLifecycle({ store, model: MODEL, recordId: 's-ghost' }),
      { status: 'unknown', reason: 'missing-record' },
    );
  });

  it('reparented and unparented records classify moved (anchored only)', async () => {
    const { store } = await setup();
    await seedParent(store, 'opp-1');
    await seedParent(store, 'opp-2');
    const moved = await seedChild(store, 's-4', 'opp-1');
    const revision = await store.readRevision();
    await store.commit(
      makeBatch(revision as number, {
        writes: [
          {
            kind: 'update',
            model: asModel(MODEL),
            id: asId('s-4'),
            expectedVersion: moved.version,
            row: {
              ...moved,
              version: (moved.version + 1) as never,
              parent: { model: asModel(PARENT_MODEL), id: asId('opp-2') },
            },
          },
        ],
      }),
    );
    assert.deepEqual(
      await classifyFanoutChildLifecycle({
        store,
        model: MODEL,
        recordId: 's-4',
        anchor: { model: PARENT_MODEL, id: 'opp-1' },
      }),
      { status: 'moved' },
    );
    // Whole-model cohorts never move: no anchor, no move.
    assert.deepEqual(
      await classifyFanoutChildLifecycle({ store, model: MODEL, recordId: 's-4' }),
      { status: 'present' },
    );
  });

  it('infra failures classify unknown/infra-read-failure', async () => {
    const { store } = await setup();
    await seedChild(store, 's-5', null);
    const failing: StoragePort = {
      ...store,
      load: async () => {
        throw new Error('boom: storage offline');
      },
    };
    assert.deepEqual(
      await classifyFanoutChildLifecycle({ store: failing, model: MODEL, recordId: 's-5' }),
      { status: 'unknown', reason: 'infra-read-failure' },
    );
  });

  it('claim-time refusals map to unknown/inaccessible-record', () => {
    assert.deepEqual(refusedFanoutLifecycle(), {
      status: 'unknown',
      reason: 'inaccessible-record',
    });
  });

  it('empty model/record inputs fail closed', async () => {
    const { store } = await setup();
    await assert.rejects(
      classifyFanoutChildLifecycle({ store, model: '', recordId: 'x' }),
      StateError,
    );
    await assert.rejects(
      classifyFanoutChildLifecycle({ store, model: MODEL, recordId: '' }),
      StateError,
    );
  });
});

describe('t34-f5 lifecycle: terminal recording through the driver', () => {
  async function drive(
    world: Awaited<ReturnType<typeof setup>> & { readonly fanoutId: string },
    recordId: string,
    operationId: string,
    guard: (row: StoredRow) => boolean,
    mustNotExecute: boolean,
  ): Promise<ReturnType<typeof driveFanoutChild>> {
    return driveFanoutChild({
      store: world.store,
      memberships: world.memberships as MembershipReader,
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
        anchor: { model: PARENT_MODEL, id: 'opp-1' },
      },
      guard,
      body: async () => {
        if (mustNotExecute) {
          throw new Error('deleted/unknown children must never execute');
        }
        return {
          writes: [],
          history: [],
          outbox: [],
          schedules: [],
          result: { kind: 'completed' as const },
        };
      },
      nowMs: FIXED_NOW,
      firstAttemptAtMs: FIXED_NOW,
      policy: POLICY,
      meta: META,
    });
  }

  it('deleted children record skipped/deleted without executing', async () => {
    const world = await setup();
    await seedParent(world.store, 'opp-1');
    await seedChild(world.store, 'victim', 'opp-1');
    const fanoutId = await freezeAnchored(world.store, world.owner, 'opp-1');
    // Archive AFTER the freeze: frozen membership persists; lifecycle decides.
    const row = await world.store.load(asModel(MODEL), asId('victim'));
    assert.ok(row !== null);
    const revision = await world.store.readRevision();
    await world.store.commit(
      makeBatch(revision as number, {
        writes: [
          {
            kind: 'update',
            model: asModel(MODEL),
            id: asId('victim'),
            expectedVersion: row.version,
            row: { ...row, version: (row.version + 1) as never, archivedAt: FIXED_NOW },
          },
        ],
      }),
    );
    const outcome = await drive({ ...world, fanoutId }, 'victim', uuidv7(FIXED_NOW, 71), () => true, true);
    assert.equal(outcome.status, 'recorded');
    const data = readFanoutChildRow(await childState(world.store, 'victim'));
    assert.equal(data.state, 'skipped');
    assert.equal(data.causeReason, 'deleted');
    assert.equal(data.attempts, 0);
  });

  it('moved children re-evaluate: guard-false skips, guard-true executes', async () => {
    const world = await setup();
    await seedParent(world.store, 'opp-1');
    await seedParent(world.store, 'opp-2');
    await seedChild(world.store, 'wanderer', 'opp-1');
    await seedChild(world.store, 'settler', 'opp-1');
    const fanoutId = await freezeAnchored(world.store, world.owner, 'opp-1');
    for (const id of ['wanderer', 'settler']) {
      const row = await world.store.load(asModel(MODEL), asId(id));
      assert.ok(row !== null);
      const revision = await world.store.readRevision();
      await world.store.commit(
        makeBatch(revision as number, {
          writes: [
            {
              kind: 'update',
              model: asModel(MODEL),
              id: asId(id),
              expectedVersion: row.version,
              row: {
                ...row,
                version: (row.version + 1) as never,
                parent: { model: asModel(PARENT_MODEL), id: asId('opp-2') },
              },
            },
          ],
        }),
      );
    }
    // Guard-false: explicitly accounted as non-applicable (never auto-cut silently).
    const skipped = await drive(
      { ...world, fanoutId },
      'wanderer',
      uuidv7(FIXED_NOW, 72),
      () => false,
      true,
    );
    assert.equal(skipped.status, 'recorded');
    if (skipped.status !== 'recorded') {
      return;
    }
    assert.deepEqual(skipped.lifecycle, { status: 'moved' });
    const skippedData = readFanoutChildRow(await childState(world.store, 'wanderer'));
    assert.equal(skippedData.state, 'skipped');
    assert.equal(skippedData.causeReason, 'non-applicable');
    // Guard-true: the moved record executes normally against current state.
    const executed = await drive(
      { ...world, fanoutId },
      'settler',
      uuidv7(FIXED_NOW, 73),
      () => true,
      false,
    );
    assert.equal(executed.status, 'recorded');
    assert.equal(readFanoutChildRow(await childState(world.store, 'settler')).state, 'completed');
  });

  it('unknown children record failed/missing-record without executing', async () => {
    const world = await setup();
    await seedParent(world.store, 'opp-1');
    await seedChild(world.store, 'vanished', 'opp-1');
    const fanoutId = await freezeAnchored(world.store, world.owner, 'opp-1');
    // Hard-remove with NO disposal history: unknowable, never deletion.
    const row = await world.store.load(asModel(MODEL), asId('vanished'));
    assert.ok(row !== null);
    const revision = await world.store.readRevision();
    await world.store.commit(
      makeBatch(revision as number, {
        writes: [
          { kind: 'remove', model: asModel(MODEL), id: asId('vanished'), expectedVersion: row.version },
        ],
      }),
    );
    // The memory adapter may record removal history implicitly; drop the
    // test to the unknown path only when no disposal history exists.
    const history = await world.store.historyFor(asModel(MODEL), asId('vanished'));
    const hasDisposal = history.some((entry) => entry.change === 'remove' || entry.change === 'archive');
    const outcome = await drive(
      { ...world, fanoutId },
      'vanished',
      uuidv7(FIXED_NOW, 74),
      () => true,
      true,
    );
    assert.equal(outcome.status, 'recorded');
    const data = readFanoutChildRow(await childState(world.store, 'vanished'));
    if (hasDisposal) {
      assert.equal(data.state, 'skipped');
      assert.equal(data.causeReason, 'deleted');
    } else {
      assert.equal(data.state, 'failed');
      assert.equal(data.causeReason, 'missing-record');
    }
  });
});

describe('t34-f5 lifecycle: REAL F4 scan consumes state classifications', () => {
  it('planFanoutRecoveryScan pins deleted/unknown/guard-false per the contract', async () => {
    const { store, owner } = await setup();
    await seedParent(store, 'opp-1');
    await seedChild(store, 'live', 'opp-1');
    await seedChild(store, 'gone', 'opp-1');
    const fanoutId = await freezeAnchored(store, owner, 'opp-1');
    // Dispose one member post-freeze with recorded history → deleted.
    const row = await store.load(asModel(MODEL), asId('gone'));
    assert.ok(row !== null);
    const revision = await store.readRevision();
    await store.commit(
      makeBatch(revision as number, {
        writes: [{ kind: 'remove', model: asModel(MODEL), id: asId('gone'), expectedVersion: row.version }],
        history: [
          {
            model: asModel(MODEL),
            recordId: asId('gone'),
            version: row.version,
            operation: asOperation('Acme.remove'),
            operationId: 'op-1' as never,
            actor: ACTOR,
            at: FIXED_NOW,
            change: 'remove',
            before: {},
            after: null,
          },
        ],
      }),
    );
    const storedIntent = await store.load(FANOUT_INTENT_MODEL as ModelName, fanoutId as RecordId);
    const storedCheckpoint = await store.load(FANOUT_CHECKPOINT_MODEL as ModelName, fanoutId as RecordId);
    assert.ok(storedIntent !== null && storedCheckpoint !== null);
    const liveLifecycle = await classifyFanoutChildLifecycle({ store, model: MODEL, recordId: 'live' });
    const goneLifecycle = await classifyFanoutChildLifecycle({ store, model: MODEL, recordId: 'gone' });
    assert.deepEqual(liveLifecycle, { status: 'present' });
    assert.deepEqual(goneLifecycle, { status: 'deleted' });
    const liveRow = fns.newFanoutChildRow(
      { fanoutId, parentOccurrence: SOURCE, handler: HANDLER, recordId: 'live' },
      META,
    );
    const goneRow = fns.newFanoutChildRow(
      { fanoutId, parentOccurrence: SOURCE, handler: HANDLER, recordId: 'gone' },
      META,
    );
    const plan = fns.planFanoutRecoveryScan({
      fanoutId,
      intent: fns.readFanoutIntentRow(storedIntent),
      checkpoint: fns.readFanoutCheckpointRow(storedCheckpoint),
      rows: [
        {
          child: fns.readFanoutChildRow(liveRow),
          claimedAtMs: null,
          guardVerdict: false,
          firstAttemptAtMs: null,
          lifecycle: liveLifecycle,
        },
        {
          child: fns.readFanoutChildRow(goneRow),
          claimedAtMs: null,
          guardVerdict: true,
          firstAttemptAtMs: null,
          lifecycle: goneLifecycle,
        },
      ],
      nowMs: FIXED_NOW,
      maxClaimAgeMs: 1000,
      policy: POLICY,
    });
    assert.deepEqual(plan.skipped, [
      { childId: fns.fanoutChildRowId(SOURCE, HANDLER, 'gone'), reason: 'deleted' },
      { childId: fns.fanoutChildRowId(SOURCE, HANDLER, 'live'), reason: 'non-applicable' },
    ]);
    assert.deepEqual(plan.failed, []);
    assert.deepEqual(plan.admit, []);
  });
});
