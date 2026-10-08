/**
 * T34-F5 child-admission proofs (memory substrate): every child admits
 * through canonical `invoke` with FRESH authority (adopted T32 fence per
 * child), and cohort membership grants NO authority.
 *
 * Proves (M5/C4): per-child fresh admission (receipt revisions advance
 * per child — nothing carried); revocation between siblings voids only
 * the revoked child (failed/inaccessible-record, domain untouched,
 * terminal siblings unaffected); a frozen member without a live grant
 * is denied; duplicate child delivery replays without re-invoking;
 * duplicate attempt delivery replays the attempt receipt; and the
 * child-identity shape validates before any store touch.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ModelName,
  OperationName,
  RecordId,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import type { ResolvedIdentity } from '@canlang/contracts';
import type { FanoutChildId, RetryPolicy } from '@canlang/contracts';
import { createMemoryStorage } from '../storage/memory.js';
import { StateError } from '../errors.js';
import { assertFanoutChildJoin } from '../ports/transact.js';
import type { OperationRegistry } from '../invocation/registry.js';
import { openFanoutChildScope } from '../invocation/admission.js';
import { invokeFanoutChild } from '../invocation/invoke.js';
import type { MembershipReader } from '../policy/roles.js';
import {
  FANOUT_CHECKPOINT_MODEL,
  FANOUT_CHILD_MODEL,
  FANOUT_INTENT_MODEL,
  fanoutChildRowId,
  fanoutIntentRowId,
  withFanoutRowData,
  readFanoutCheckpointRow,
  readFanoutChildRow,
  readFanoutIntentRow,
} from './tables.js';
import { admitRetainedFanoutChunk, freezeFanoutMembership } from './membership.js';
import { driveFanoutChild } from '../../test/fanout/test-driver.js';
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
  type TestMembershipStore,
} from '../../test/invocation/fixtures.js';

const MODEL = 'Acme.Commitment';
const HANDLER = 'Shift.review_commitment';
const SOURCE = 'occ-adm-1';
const APP = 'acme-app';
const CHILD_OP = 'Acme.review_child';
const ACTOR = 't34-f5-admission';
const META = { nowMs: FIXED_NOW, actor: ACTOR };
const POLICY: RetryPolicy = { maxAttempts: 3, horizonMs: 60_000 };

interface AdmWorld {
  readonly store: StoragePort;
  readonly memberships: TestMembershipStore;
  readonly registry: OperationRegistry;
  readonly identity: ResolvedIdentity;
  readonly owner: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly clock: { nowMs(): number };
  readonly fanoutId: string;
  readonly members: ReadonlyArray<string>;
}

async function setupAdmWorld(size: number): Promise<AdmWorld> {
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
  const clock = { nowMs: () => FIXED_NOW };
  const owner = alice.team.team_id as string;
  for (let index = 0; index < size; index += 1) {
    const id = `a-${String(index).padStart(3, '0')}`;
    const revision = await store.readRevision();
    await store.commit(
      makeBatch(revision as number, {
        writes: [
          { kind: 'insert', model: asModel(MODEL), row: makeRow({ id, data: { label: id } }) },
        ],
      }),
    );
  }
  const outcome = await freezeFanoutMembership({
    store,
    cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
    cohort: { kind: 'model', owner, model: MODEL },
    owner,
    bounds: { pageLimit: 16, chunkSize: 16, maxAttempts: 5 },
    meta: META,
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) {
    throw new Error('freeze failed in test setup');
  }
  return {
    store,
    memberships,
    registry,
    identity: makeIdentity({ membership: alice.membership }),
    owner,
    userId: alice.user.user_id as string,
    membershipId: alice.membership.membership_id as string,
    clock,
    fanoutId: outcome.frozen.fanoutId,
    members: outcome.frozen.members,
  };
}

function markBody(domainModel: string) {
  return async (row: StoredRow) => {
    const next: StoredRow = {
      ...row,
      version: (row.version + 1) as StoredRow['version'],
      updated: FIXED_NOW,
      updatedBy: ACTOR,
      data: { ...(row.data as Record<string, unknown>), reviewed: true },
    };
    return {
      writes: [
        {
          kind: 'update' as const,
          model: asModel(domainModel),
          id: row.id,
          expectedVersion: row.version,
          row: next,
        },
      ],
      history: [
        {
          model: asModel(domainModel),
          recordId: row.id,
          version: next.version,
          operation: asOperation(CHILD_OP),
          operationId: 'op-body' as never,
          actor: ACTOR,
          at: FIXED_NOW,
          change: 'update' as const,
          before: row.data as Record<string, unknown>,
          after: next.data as Record<string, unknown>,
        },
      ],
      outbox: [],
      schedules: [],
      result: { kind: 'completed' as const },
    };
  };
}

async function drive(
  world: AdmWorld,
  recordId: string,
  operationId: string,
  identity?: ResolvedIdentity,
): Promise<ReturnType<typeof driveFanoutChild>> {
  return driveFanoutChild({
    store: world.store,
    memberships: world.memberships as MembershipReader,
    registry: world.registry,
    clock: world.clock,
    identity: identity ?? world.identity,
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
    body: markBody(MODEL),
    nowMs: FIXED_NOW,
    firstAttemptAtMs: FIXED_NOW,
    policy: POLICY,
    meta: META,
  });
}

async function childData(
  store: StoragePort,
  recordId: string,
): Promise<ReturnType<typeof readFanoutChildRow>> {
  const row = await store.load(
    FANOUT_CHILD_MODEL as ModelName,
    fanoutChildRowId(SOURCE, HANDLER, recordId) as RecordId,
  );
  assert.ok(row !== null);
  return readFanoutChildRow(row);
}

describe('t34-f5 admission: fresh fence per child (M5)', () => {
  it('restarts one bounded retained admission prefix with changed chunk bounds and atomic conflicts', async () => {
    const store = createMemoryStorage();
    await store.commit(makeBatch((await store.readRevision()) as number, {
      writes: ['a', 'b', 'c', 'd', 'e'].map(id => ({ kind: 'insert' as const,
        model: asModel(MODEL), row: makeRow({ id }) })),
    }));
    const interrupted = await freezeFanoutMembership({
      store: { ...store, commit: async batch => {
        if (batch.writes.some(write => write.kind === 'insert' && write.model === FANOUT_CHILD_MODEL &&
          readFanoutChildRow(write.row).recordId === 'c')) throw new Error('stop after durable first chunk');
        return store.commit(batch);
      } },
      cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
      cohort: { kind: 'model', owner: 'owner', model: MODEL }, owner: 'owner',
      bounds: { pageLimit: 2, chunkSize: 2, maxAttempts: 1 }, meta: META,
    });
    assert.equal(interrupted.ok, false);
    const fanoutId = fanoutIntentRowId(SOURCE, HANDLER, 'model');
    const initial = (await store.load(asModel(FANOUT_CHECKPOINT_MODEL), asId(fanoutId)))!;
    assert.equal(readFanoutCheckpointRow(initial).cursor, 'admit/1');
    // An already terminal sibling's coverage survives admission maintenance.
    const firstChild = (await store.load(asModel(FANOUT_CHILD_MODEL),
      asId(fanoutChildRowId(SOURCE, HANDLER, 'a'))))!;
    await store.commit(makeBatch((await store.readRevision()) as number, {
      writes: [
        { kind: 'update', model: asModel(FANOUT_CHILD_MODEL), id: firstChild.id,
          expectedVersion: firstChild.version, row: withFanoutRowData(firstChild,
            { ...readFanoutChildRow(firstChild), state: 'completed', causeKind: 'completed' }, META) },
        { kind: 'update', model: asModel(FANOUT_CHECKPOINT_MODEL), id: initial.id,
          expectedVersion: initial.version, row: withFanoutRowData(initial,
            { ...readFanoutCheckpointRow(initial), completed: ['a'] }, META) },
      ],
    }));
    let childLoads = 0;
    let inserts = 0;
    let commits = 0;
    let conflict = false;
    const restarted: StoragePort = {
      ...store,
      query: async () => { throw new Error('retained admission must not query'); },
      load: async (model, id) => {
        if (model === FANOUT_CHILD_MODEL) childLoads += 1;
        return store.load(model, id);
      },
      commit: async batch => {
        commits += 1;
        inserts += batch.writes.filter(write => write.kind === 'insert').length;
        if (conflict) {
          conflict = false;
          await store.commit(makeBatch((await store.readRevision()) as number, {
            writes: [{ kind: 'insert', model: asModel(MODEL), row: makeRow({ id: 'late' }) }],
          }));
        }
        return store.commit(batch);
      },
    };
    const capture = async (chunkSize: number) => ({ store: restarted, chunkSize, meta: META,
      expectedRevision: await store.readRevision(),
      intentRow: (await store.load(asModel(FANOUT_INTENT_MODEL), asId(fanoutId)))!,
      checkpointRow: (await store.load(asModel(FANOUT_CHECKPOINT_MODEL), asId(fanoutId)))!,
    });
    for (const cursor of ['unknown', 'admit/0', 'admit/01', 'admit/6', 'admit/v2/01', 'admit/v2/6']) {
      const current = await capture(1);
      await store.commit(makeBatch(current.expectedRevision as number, { writes: [{ kind: 'update',
        model: asModel(FANOUT_CHECKPOINT_MODEL), id: current.checkpointRow.id,
        expectedVersion: current.checkpointRow.version, row: withFanoutRowData(current.checkpointRow,
          { ...readFanoutCheckpointRow(current.checkpointRow), cursor }, META) }] }));
      assert.equal((await admitRetainedFanoutChunk(await capture(1))).ok, false);
    }
    const restore = await capture(1);
    await store.commit(makeBatch(restore.expectedRevision as number, { writes: [{ kind: 'update',
      model: asModel(FANOUT_CHECKPOINT_MODEL), id: restore.checkpointRow.id,
      expectedVersion: restore.checkpointRow.version, row: withFanoutRowData(restore.checkpointRow,
        { ...readFanoutCheckpointRow(restore.checkpointRow), cursor: 'admit/1' }, META) }] }));
    const first = await capture(1);
    assert.equal((await admitRetainedFanoutChunk({ ...first,
      intentRow: { ...first.intentRow, version: (first.intentRow.version + 1) as StoredRow['version'] } })).ok, false);
    assert.equal((await admitRetainedFanoutChunk({ ...first,
      intentRow: { ...first.intentRow, data: { ...first.intentRow.data,
        members: ['a', 'b', 'c', 'd', 'foreign'] } } })).ok, false);
    assert.equal(childLoads, 0);
    assert.equal(commits, 0);
    assert.deepEqual(await admitRetainedFanoutChunk(first), { ok: true, cursor: 'admit/v2/1', admitted: 0 });
    assert.equal(childLoads, 1);
    assert.equal(commits, 1);
    assert.equal(inserts, 0);
    // A new call changes the bound; the persisted offset still verifies b,c.
    const second = await capture(2);
    childLoads = inserts = commits = 0;
    conflict = true;
    assert.equal((await admitRetainedFanoutChunk(second)).ok, false);
    assert.equal(childLoads, 2);
    assert.equal(commits, 1);
    assert.equal(inserts, 1);
    assert.deepEqual(await store.load(asModel(FANOUT_CHECKPOINT_MODEL), asId(fanoutId)), second.checkpointRow);
    assert.equal(await store.load(asModel(FANOUT_CHILD_MODEL),
      asId(fanoutChildRowId(SOURCE, HANDLER, 'c'))), null);
    childLoads = inserts = commits = 0;
    assert.deepEqual(await admitRetainedFanoutChunk(await capture(2)),
      { ok: true, cursor: 'admit/v2/3', admitted: 1 });
    assert.equal(childLoads, 2);
    assert.equal(commits, 1);
    assert.equal(inserts, 1);
    assert.equal(await store.load(asModel(FANOUT_CHILD_MODEL),
      asId(fanoutChildRowId(SOURCE, HANDLER, 'd'))), null);
    // Recreate the caller from retained rows again; the final bounded slice nulls atomically.
    childLoads = inserts = commits = 0;
    assert.deepEqual(await admitRetainedFanoutChunk(await capture(3)),
      { ok: true, cursor: null, admitted: 2 });
    assert.equal(childLoads, 2);
    assert.equal(commits, 1);
    assert.equal(inserts, 2);
    const finished = (await store.load(asModel(FANOUT_CHECKPOINT_MODEL), asId(fanoutId)))!;
    assert.deepEqual(readFanoutCheckpointRow(finished), { fanoutId, completed: ['a'], cursor: null });
    for (const recordId of ['a', 'b', 'c', 'd', 'e']) assert.equal((await childData(store, recordId)).recordId, recordId);
    assert.equal((await childData(store, 'a')).state, 'completed');
    assert.equal(await store.load(asModel(FANOUT_CHILD_MODEL),
      asId(fanoutChildRowId(SOURCE, HANDLER, 'late'))), null);
  });

  it('resumes retained membership after interrupted admission without domain enumeration', async () => {
    // Memory-only fault injection: Work reads remain available on restart.
    const store = createMemoryStorage();
    await store.commit(makeBatch((await store.readRevision()) as number, {
      writes: ['a', 'b'].map((id) => ({
        kind: 'insert' as const,
        model: asModel(MODEL),
        row: makeRow({ id }),
      })),
    }));
    const fanoutId = fanoutIntentRowId(SOURCE, HANDLER, 'model');
    let interruptAdmission = true;
    let domainUnavailable = false;
    let domainQueries = 0;
    let cursorFinishes = 0;
    const faultStore: StoragePort = {
      ...store,
      query: async (query) => {
        if (query.model === MODEL) {
          domainQueries += 1;
          if (domainUnavailable) {
            throw new Error('current domain query unavailable');
          }
        }
        return store.query(query);
      },
      commit: async (batch) => {
        if (batch.writes.some((write) =>
          write.kind === 'insert' && write.model === FANOUT_CHILD_MODEL &&
          readFanoutChildRow(write.row).recordId === 'b')) {
          const checkpoint = await store.load(asModel(FANOUT_CHECKPOINT_MODEL), asId(fanoutId));
          assert.ok(checkpoint !== null);
          assert.equal(readFanoutCheckpointRow(checkpoint).cursor, 'admit/1');
          if (interruptAdmission) {
            throw new Error('interrupted after first admission chunk');
          }
        }
        if (batch.writes.some((write) =>
          write.kind === 'update' && write.model === FANOUT_CHECKPOINT_MODEL &&
          readFanoutCheckpointRow(write.row).cursor === null)) {
          assert.ok(await store.load(asModel(FANOUT_CHILD_MODEL),
            asId(fanoutChildRowId(SOURCE, HANDLER, 'b'))) !== null);
          cursorFinishes += 1;
        }
        return store.commit(batch);
      },
    };
    const input = {
      store: faultStore,
      cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
      cohort: { kind: 'model' as const, owner: 'owner', model: MODEL },
      owner: 'owner',
      bounds: { pageLimit: 2, chunkSize: 1, maxAttempts: 3 },
      meta: META,
      hasModel: (model: string) => model === MODEL,
    };
    const interrupted = await freezeFanoutMembership(input);
    assert.equal(interrupted.ok, false);
    if (!interrupted.ok) {
      assert.equal(interrupted.diagnosis.kind, 'membership-unavailable');
    }
    const intent = await store.load(asModel(FANOUT_INTENT_MODEL), asId(fanoutId));
    const checkpoint = await store.load(asModel(FANOUT_CHECKPOINT_MODEL), asId(fanoutId));
    assert.ok(intent !== null && checkpoint !== null);
    assert.deepEqual(readFanoutIntentRow(intent).members, ['a', 'b']);
    assert.equal(readFanoutCheckpointRow(checkpoint).cursor, 'admit/1');
    assert.equal((await childData(store, 'a')).recordId, 'a');
    assert.equal(await store.load(asModel(FANOUT_CHILD_MODEL),
      asId(fanoutChildRowId(SOURCE, HANDLER, 'b'))), null);
    assert.equal(cursorFinishes, 0);
    await store.commit(makeBatch((await store.readRevision()) as number, {
      writes: [{ kind: 'insert', model: asModel(MODEL), row: makeRow({ id: 'late' }) }],
    }));
    interruptAdmission = false;
    domainUnavailable = true;
    domainQueries = 0;
    const resumed = await freezeFanoutMembership(input);
    assert.equal(resumed.ok, true);
    if (resumed.ok) {
      assert.equal(resumed.frozen.replayed, true);
      assert.deepEqual(resumed.frozen.members, ['a', 'b']);
    }
    assert.equal(domainQueries, 0);
    assert.equal((await childData(store, 'b')).recordId, 'b');
    assert.equal(await store.load(asModel(FANOUT_CHILD_MODEL),
      asId(fanoutChildRowId(SOURCE, HANDLER, 'late'))), null);
    const finished = await store.load(asModel(FANOUT_CHECKPOINT_MODEL), asId(fanoutId));
    assert.ok(finished !== null);
    assert.equal(readFanoutCheckpointRow(finished).cursor, null);
    assert.equal(cursorFinishes, 1);
  });

  it('each child admits at a fresh revision (nothing carried)', async () => {
    const world = await setupAdmWorld(2);
    const first = world.members[0] as string;
    const second = world.members[1] as string;
    const op1 = uuidv7(FIXED_NOW, 11);
    const op2 = uuidv7(FIXED_NOW, 12);
    assert.equal((await drive(world, first, op1)).status, 'recorded');
    // A rival domain write lands between the siblings.
    const rival = await world.store.load(asModel(MODEL), asId(first));
    assert.ok(rival !== null);
    const revision = await world.store.readRevision();
    await world.store.commit(
      makeBatch(revision as number, {
        writes: [
          {
            kind: 'update',
            model: asModel(MODEL),
            id: asId(first),
            expectedVersion: rival.version,
            row: { ...rival, version: (rival.version + 1) as never, data: { ...rival.data } },
          },
        ],
      }),
    );
    assert.equal((await drive(world, second, op2)).status, 'recorded');
    // Receipt revisions prove fresh admission per child: the second
    // child admitted strictly after the rival write.
    const receipt1 = await world.store.readReceipt({
      app: APP,
      owner: world.owner,
      principal: world.userId,
      operation: asOperation(CHILD_OP),
      operationId: op1 as never,
    });
    const receipt2 = await world.store.readReceipt({
      app: APP,
      owner: world.owner,
      principal: world.userId,
      operation: asOperation(CHILD_OP),
      operationId: op2 as never,
    });
    assert.ok(receipt1 !== null && receipt2 !== null);
    assert.ok((receipt2.committedRevision as number) > (receipt1.committedRevision as number) + 1);
  });

  it('revocation between siblings voids ONLY the revoked child', async () => {
    const world = await setupAdmWorld(3);
    const first = world.members[0] as string;
    const second = world.members[1] as string;
    const third = world.members[2] as string;
    assert.equal((await drive(world, first, uuidv7(FIXED_NOW, 21))).status, 'recorded');
    await world.memberships.removeMembership(world.membershipId);
    const refused = await drive(world, second, uuidv7(FIXED_NOW, 22));
    assert.equal(refused.status, 'recorded');
    if (refused.status !== 'recorded') {
      return;
    }
    assert.deepEqual(refused.lifecycle, { status: 'unknown', reason: 'inaccessible-record' });
    const secondData = await childData(world.store, second);
    assert.equal(secondData.state, 'failed');
    assert.equal(secondData.causeReason, 'inaccessible-record');
    assert.equal(secondData.attempts, 0);
    // The refused child executed NOTHING: its domain row is untouched.
    const untouched = await world.store.load(asModel(MODEL), asId(second));
    assert.ok(untouched !== null);
    assert.equal(untouched.version, 1);
    assert.ok(!('reviewed' in (untouched.data as Record<string, unknown>)));
    // The terminal sibling stands as recorded (revocation is not retroactive).
    const firstData = await childData(world.store, first);
    assert.equal(firstData.state, 'completed');
    // A fresh grant re-admits the NEXT child (the fence is live, not sticky).
    await world.memberships.createMembership({
      team_id: world.owner as never,
      user_id: world.userId as never,
      is_owner: false,
      roles: [],
    });
    assert.equal((await drive(world, third, uuidv7(FIXED_NOW, 23))).status, 'recorded');
    assert.equal((await childData(world.store, third)).state, 'completed');
  });

  it('duplicate child delivery replays without re-invoking', async () => {
    const world = await setupAdmWorld(1);
    const only = world.members[0] as string;
    assert.equal((await drive(world, only, uuidv7(FIXED_NOW, 31))).status, 'recorded');
    const before = await childData(world.store, only);
    const domainBefore = await world.store.load(asModel(MODEL), asId(only));
    assert.ok(domainBefore !== null);
    const replayed = await drive(world, only, uuidv7(FIXED_NOW, 32));
    assert.equal(replayed.status, 'replayed');
    const after = await childData(world.store, only);
    assert.deepEqual(after, before);
    const domainAfter = await world.store.load(asModel(MODEL), asId(only));
    assert.ok(domainAfter !== null);
    assert.equal(domainAfter.version, domainBefore.version);
  });

  it('duplicate attempt delivery replays the attempt receipt', async () => {
    const world = await setupAdmWorld(1);
    const only = world.members[0] as string;
    const operationId = uuidv7(FIXED_NOW, 41);
    const input = {
      registry: world.registry,
      store: world.store,
      memberships: world.memberships as MembershipReader,
      clock: world.clock,
      childOperation: CHILD_OP,
      child: { parentOccurrence: SOURCE, handler: HANDLER, recordId: only } satisfies FanoutChildId,
      operationId,
      identity: world.identity,
      app: APP,
      source: 'test.fanout',
      inputs: { record: { id: only } },
      execute: async () => ({
        writes: [],
        history: [],
        outbox: [],
        schedules: [],
        uniqueClaims: [],
        uniqueReleases: [],
        resolvedDefaults: {},
        result: { pong: true },
      }),
      assertJoin: assertFanoutChildJoin,
    };
    const first = await invokeFanoutChild(input);
    assert.equal(first.status, 'committed');
    const second = await invokeFanoutChild(input);
    assert.equal(second.status, 'replayed');
    assert.deepEqual(second.result, { pong: true });
  });
});

describe('t34-f5 admission: membership grants NO authority (C4)', () => {
  it('a frozen member without a live grant is denied', async () => {
    const world = await setupAdmWorld(2);
    const target = world.members[0] as string;
    // Bob exists on the team object graph but holds NO membership row:
    // the child record is a frozen member, and that buys him nothing.
    const bobUser = await world.memberships.createUser('bob@example.test');
    const bobIdentity = makeIdentity({
      userId: bobUser.user_id as string,
      teamId: world.owner,
      membership: null,
    });
    const outcome = await drive(world, target, uuidv7(FIXED_NOW, 51), bobIdentity);
    assert.equal(outcome.status, 'recorded');
    if (outcome.status !== 'recorded') {
      return;
    }
    assert.deepEqual(outcome.lifecycle, { status: 'unknown', reason: 'inaccessible-record' });
    const data = await childData(world.store, target);
    assert.equal(data.state, 'failed');
    assert.equal(data.causeReason, 'inaccessible-record');
    const untouched = await world.store.load(asModel(MODEL), asId(target));
    assert.ok(untouched !== null);
    assert.equal(untouched.version, 1);
    // And the sibling still admits for the granted caller.
    const sibling = world.members[1] as string;
    assert.equal((await drive(world, sibling, uuidv7(FIXED_NOW, 52))).status, 'recorded');
    assert.equal((await childData(world.store, sibling)).state, 'completed');
  });

  it('child identity validates before any store touch', async () => {
    const world = await setupAdmWorld(1);
    const revBefore = await world.store.readRevision();
    await assert.rejects(
      () =>
        invokeFanoutChild({
          registry: world.registry,
          store: world.store,
          memberships: world.memberships as MembershipReader,
          clock: world.clock,
          childOperation: CHILD_OP,
          child: { parentOccurrence: SOURCE, handler: '', recordId: 'x' },
          operationId: uuidv7(FIXED_NOW, 61),
          identity: world.identity,
          app: APP,
          source: 'test.fanout',
          inputs: { record: { id: 'x' } },
          execute: async () => {
            throw new Error('must not execute');
          },
          assertJoin: assertFanoutChildJoin,
        }),
      StateError,
    );
    assert.equal(await world.store.readRevision(), revBefore);
  });

  it('openFanoutChildScope opens a fresh empty scope per child', async () => {
    const world = await setupAdmWorld(1);
    const revision = await world.store.readRevision();
    const first = await openFanoutChildScope(world.store, world.owner);
    const second = await openFanoutChildScope(world.store, world.owner);
    assert.equal(first.revision, revision);
    assert.equal(first.owner, world.owner);
    assert.deepEqual(first.dependencies, []);
    assert.deepEqual(second.dependencies, []);
    assert.ok(first !== second);
    // Enrollment on one scope never leaks to the sibling.
    first.enroll({ kind: 'record', model: asModel(MODEL), id: asId('a-000'), version: 1 as never });
    assert.equal(first.dependencies.length, 1);
    assert.equal(second.dependencies.length, 0);
    await assert.rejects(() => openFanoutChildScope(world.store, ''), StateError);
  });
});
