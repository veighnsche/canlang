/**
 * T34-F5 membership proofs (memory substrate): the authoritative frozen
 * identity set at an explicit source-occurrence/handler cutoff in the
 * owning store, for both cohort spellings.
 *
 * Proves (M1/M4/C5/C9): exact membership across bounded enumeration at
 * 499/500/501/1000 through the real freeze path (chunk size varied,
 * never cohort size); late-insert exclusion; concurrent insert/delete
 * exactness via scripted mid-enumeration writes; fence-exhaustion and
 * infra-failure diagnosing membership-unavailable (never partial);
 * duplicate-freeze replay; crash-between-chunks resume; anchor
 * unknown/deleted policy; unknown-model and cross-owner diagnoses; and
 * byte-compatibility with the REAL F2 rows/readers/derivations in both
 * directions. Durable-substrate (D1/DO) freeze + kill/restart proofs
 * live in `t34-f5-durable.test.ts`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ModelName,
  RecordId,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import type { FanoutCohortKind } from '@canlang/contracts';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { StateError } from '@canlang/state/errors';
import {
  FIXED_NOW,
  asId,
  asModel,
  createMemoryIdentityStore,
  makeBatch,
  makeRow,
  seedMember,
} from '@canlang/state/testing/invocation/fixtures';
import {
  FANOUT_CHECKPOINT_MODEL,
  FANOUT_CHILD_MODEL,
  FANOUT_INTENT_MODEL,
  fanoutChildRowId,
  fanoutIntentRowId,
  newFanoutCheckpointRow,
  newFanoutChildRow,
  newFanoutIntentRow,
  nextFanoutCheckpointData,
  readFanoutCheckpointRow,
  readFanoutChildRow,
  readFanoutIntentRow,
} from '@canlang/state/fanout/tables';
import { freezeFanoutMembership } from '@canlang/state/fanout/membership';
import type { FanoutFreezeBounds } from '@canlang/state/fanout/membership';
import { loadWorkFanoutFns, type WorkFanoutFns } from './work-loader.js';

const MODEL = 'Acme.Commitment';
const PARENT_MODEL = 'Acme.Opportunity';
const CHILD_MODEL = 'Acme.Signup';
const HANDLER = 'Shift.review_commitment';
const SOURCE = 'occ-source-1';
const ACTOR = 't34-f5-membership';
const META = { nowMs: FIXED_NOW, actor: ACTOR };
const BOUNDS: FanoutFreezeBounds = { pageLimit: 64, chunkSize: 100, maxAttempts: 5 };

const fns: WorkFanoutFns = await loadWorkFanoutFns();

async function setup() {
  const store = createMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  return { store, memberships, owner: alice.team.team_id as string, alice };
}

async function seedRecords(
  store: StoragePort,
  model: string,
  ids: ReadonlyArray<string>,
  chunk = 100,
): Promise<void> {
  for (let index = 0; index < ids.length; index += chunk) {
    const slice = ids.slice(index, index + chunk);
    const revision = await store.readRevision();
    await store.commit(
      makeBatch(revision as number, {
        writes: slice.map((id) => ({
          kind: 'insert' as const,
          model: asModel(model),
          row: makeRow({ id, data: { label: id } }),
        })),
      }),
    );
  }
}

function idsOf(count: number, prefix: string): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(4, '0')}`);
}

async function drainChildIds(store: StoragePort, fanoutId: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const rows = await store.query({
      model: FANOUT_CHILD_MODEL as ModelName,
      where:
        cursor === null
          ? { op: 'eq', field: 'fanoutId', value: fanoutId }
          : {
              op: 'and',
              args: [
                { op: 'eq', field: 'fanoutId', value: fanoutId },
                { op: 'gt', field: 'id', value: cursor },
              ],
            },
      order: [{ field: 'id', direction: 'asc' }],
      limit: 64,
      authority: 'owner',
    });
    for (const row of rows) {
      ids.push(readFanoutChildRow(row).recordId);
    }
    if (rows.length < 64) {
      return ids.sort();
    }
    const last = rows[rows.length - 1];
    if (last === undefined) {
      throw new Error('unreachable empty full page in test drain');
    }
    cursor = last.id as string;
  }
}

describe('t34-f5 membership: exact frozen set, both spellings', () => {
  for (const size of [499, 500, 501, 1000]) {
    it(`M1 whole-model ${size} identities freeze exactly (bounded pages)`, async () => {
      const { store, owner } = await setup();
      const ids = idsOf(size, 'c');
      await seedRecords(store, MODEL, ids);
      const revBefore = await store.readRevision();
      const outcome = await freezeFanoutMembership({
        store,
        cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
        cohort: { kind: 'model', owner, model: MODEL },
        owner,
        bounds: BOUNDS,
        meta: META,
      });
      assert.equal(outcome.ok, true);
      if (!outcome.ok) {
        return;
      }
      // Exact cutoff evidence: the freeze fenced at the pre-freeze revision.
      assert.equal(outcome.frozen.cutoffRevision, revBefore);
      assert.equal(outcome.frozen.replayed, false);
      assert.deepEqual([...outcome.frozen.members].sort(), [...ids].sort());
      // The committed intent row reads clean through the REAL F2 reader.
      const intentRow = await store.load(
        FANOUT_INTENT_MODEL as ModelName,
        outcome.frozen.fanoutId as RecordId,
      );
      assert.ok(intentRow !== null);
      const realIntent = fns.readFanoutIntentRow(intentRow);
      assert.equal(realIntent.memberCount, size);
      assert.deepEqual([...realIntent.members].sort(), [...ids].sort());
      // Every admitted identity has a child row (drained, id-sorted).
      assert.deepEqual(await drainChildIds(store, outcome.frozen.fanoutId), [...ids].sort());
      // Enumeration fully admitted: cursor null.
      const checkpointRow = await store.load(
        FANOUT_CHECKPOINT_MODEL as ModelName,
        outcome.frozen.fanoutId as RecordId,
      );
      assert.ok(checkpointRow !== null);
      assert.equal(fns.readFanoutCheckpointRow(checkpointRow).cursor, null);
      assert.deepEqual(fns.readFanoutCheckpointRow(checkpointRow).completed, []);
    });
  }

  it('M1 anchored-collection freezes exactly the pinned parent children', async () => {
    const { store, owner } = await setup();
    const revision = await store.readRevision();
    await store.commit(
      makeBatch(revision as number, {
        writes: [
          {
            kind: 'insert',
            model: asModel(PARENT_MODEL),
            row: makeRow({ id: 'opp-1', data: { venue: 'hall' } }),
          },
          {
            kind: 'insert',
            model: asModel(PARENT_MODEL),
            row: makeRow({ id: 'opp-2', data: { venue: 'park' } }),
          },
        ],
      }),
    );
    const mine = idsOf(37, 'mine');
    const other = idsOf(41, 'other');
    const parentOf = (parentId: string) => ({
      model: asModel(PARENT_MODEL),
      id: asId(parentId),
    });
    const revChildren = await store.readRevision();
    await store.commit(
      makeBatch(revChildren as number, {
        writes: [
          ...mine.map((id) => ({
            kind: 'insert' as const,
            model: asModel(CHILD_MODEL),
            row: { ...makeRow({ id, data: { state: 'registered' } }), parent: parentOf('opp-1') },
          })),
          ...other.map((id) => ({
            kind: 'insert' as const,
            model: asModel(CHILD_MODEL),
            row: { ...makeRow({ id, data: { state: 'registered' } }), parent: parentOf('opp-2') },
          })),
          // Unparented decoy: never a member of the anchored cohort.
          {
            kind: 'insert' as const,
            model: asModel(CHILD_MODEL),
            row: makeRow({ id: 'orphan-1', data: { state: 'registered' } }),
          },
        ],
      }),
    );
    const outcome = await freezeFanoutMembership({
      store,
      cutoff: { sourceOccurrence: SOURCE, handler: 'Volunteer.cancel_signup' },
      cohort: {
        kind: 'anchored-collection',
        owner,
        model: CHILD_MODEL,
        parent: { model: PARENT_MODEL, id: 'opp-1' },
      },
      owner,
      bounds: { pageLimit: 7, chunkSize: 9, maxAttempts: 5 },
      meta: META,
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) {
      return;
    }
    assert.deepEqual([...outcome.frozen.members].sort(), [...mine].sort());
    assert.deepEqual(await drainChildIds(store, outcome.frozen.fanoutId), [...mine].sort());
  });

  it('C9 chunk size is not cohort size: tiny pages/chunks freeze identically', async () => {
    const { store, owner } = await setup();
    const ids = idsOf(501, 'k');
    await seedRecords(store, MODEL, ids);
    for (const bounds of [
      { pageLimit: 3, chunkSize: 5, maxAttempts: 5 },
      { pageLimit: 500, chunkSize: 501, maxAttempts: 5 },
    ] satisfies FanoutFreezeBounds[]) {
      const tag = `occ-${bounds.pageLimit}-${bounds.chunkSize}`;
      const outcome = await freezeFanoutMembership({
        store,
        cutoff: { sourceOccurrence: tag, handler: HANDLER },
        cohort: { kind: 'model', owner, model: MODEL },
        owner,
        bounds,
        meta: META,
      });
      assert.equal(outcome.ok, true);
      if (!outcome.ok) {
        return;
      }
      assert.deepEqual([...outcome.frozen.members].sort(), [...ids].sort());
      assert.deepEqual(await drainChildIds(store, outcome.frozen.fanoutId), [...ids].sort());
    }
  });

  it('M4 late inserts are excluded from the occurrence', async () => {
    const { store, owner } = await setup();
    await seedRecords(store, MODEL, idsOf(120, 'base'));
    const outcome = await freezeFanoutMembership({
      store,
      cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
      cohort: { kind: 'model', owner, model: MODEL },
      owner,
      bounds: BOUNDS,
      meta: META,
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) {
      return;
    }
    assert.equal(outcome.frozen.members.length, 120);
    // Late insert lands after the cutoff: excluded structurally.
    await seedRecords(store, MODEL, ['late-1', 'late-2']);
    assert.ok(!outcome.frozen.members.includes('late-1'));
    const lateRow = await store.load(
      FANOUT_CHILD_MODEL as ModelName,
      fanoutChildRowId(SOURCE, HANDLER, 'late-1') as RecordId,
    );
    assert.equal(lateRow, null);
    const intentRow = await store.load(
      FANOUT_INTENT_MODEL as ModelName,
      outcome.frozen.fanoutId as RecordId,
    );
    assert.ok(intentRow !== null);
    assert.equal(readFanoutIntentRow(intentRow).memberCount, 120);
  });

  it('M4 concurrent insert mid-enumeration retries to an exact set', async () => {
    const { store, owner } = await setup();
    await seedRecords(store, MODEL, idsOf(200, 'r'));
    // Scripted rival: inject exactly one insert between pages 1 and 2 of
    // the FIRST enumeration attempt, then stay quiet. The freeze must
    // retry and freeze the exact post-insert set.
    let queries = 0;
    let injected = false;
    const racing: StoragePort = {
      ...store,
      query: async (spec) => {
        const rows = await store.query(spec);
        queries += 1;
        if (!injected && queries === 1) {
          injected = true;
          const revision = await store.readRevision();
          await store.commit(
            makeBatch(revision as number, {
              writes: [
                {
                  kind: 'insert',
                  model: asModel(MODEL),
                  row: makeRow({ id: 'rival-1', data: { label: 'rival' } }),
                },
              ],
            }),
          );
        }
        return rows;
      },
    };
    const outcome = await freezeFanoutMembership({
      store: racing,
      cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
      cohort: { kind: 'model', owner, model: MODEL },
      owner,
      bounds: { pageLimit: 64, chunkSize: 100, maxAttempts: 5 },
      meta: META,
    });
    assert.equal(injected, true);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) {
      return;
    }
    assert.equal(outcome.frozen.members.length, 201);
    assert.ok(outcome.frozen.members.includes('rival-1'));
    assert.deepEqual(await drainChildIds(store, outcome.frozen.fanoutId), [
      ...outcome.frozen.members,
    ].sort());
  });

  it('M4 concurrent delete mid-enumeration retries to an exact set', async () => {
    const { store, owner } = await setup();
    await seedRecords(store, MODEL, idsOf(200, 'd'));
    let queries = 0;
    let injected = false;
    const racing: StoragePort = {
      ...store,
      query: async (spec) => {
        const rows = await store.query(spec);
        queries += 1;
        if (!injected && queries === 1) {
          injected = true;
          const victim = await store.load(asModel(MODEL), asId('d-0100'));
          assert.ok(victim !== null);
          const revision = await store.readRevision();
          await store.commit(
            makeBatch(revision as number, {
              writes: [
                {
                  kind: 'remove',
                  model: asModel(MODEL),
                  id: asId('d-0100'),
                  expectedVersion: victim.version,
                },
              ],
            }),
          );
        }
        return rows;
      },
    };
    const outcome = await freezeFanoutMembership({
      store: racing,
      cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
      cohort: { kind: 'model', owner, model: MODEL },
      owner,
      bounds: { pageLimit: 64, chunkSize: 100, maxAttempts: 5 },
      meta: META,
    });
    assert.equal(injected, true);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) {
      return;
    }
    assert.equal(outcome.frozen.members.length, 199);
    assert.ok(!outcome.frozen.members.includes('d-0100'));
  });
});

describe('t34-f5 membership: failure posture (diagnose, never partial)', () => {
  it('fence exhaustion diagnoses membership-unavailable, freezing nothing', async () => {
    const { store, owner } = await setup();
    await seedRecords(store, MODEL, idsOf(50, 'x'));
    // Every commit attempt loses the fence: a rival write lands first.
    const contended: StoragePort = {
      ...store,
      commit: async (batch) => {
        const revision = await store.readRevision();
        await store.commit(
          makeBatch(revision as number, {
            writes: [
              {
                kind: 'insert',
                model: asModel(MODEL),
                row: makeRow({ id: `rival-${revision}`, data: {} }),
              },
            ],
          }),
        );
        return store.commit(batch);
      },
    };
    const outcome = await freezeFanoutMembership({
      store: contended,
      cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
      cohort: { kind: 'model', owner, model: MODEL },
      owner,
      bounds: { pageLimit: 64, chunkSize: 100, maxAttempts: 3 },
      meta: META,
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) {
      return;
    }
    assert.equal(outcome.diagnosis.kind, 'membership-unavailable');
    // Nothing froze: no intent row exists for the cutoff.
    const fanoutId = fanoutIntentRowId(SOURCE, HANDLER, 'model');
    assert.equal(await store.load(FANOUT_INTENT_MODEL as ModelName, fanoutId as RecordId), null);
  });

  it('infra failure during enumeration diagnoses membership-unavailable', async () => {
    const { store, owner } = await setup();
    await seedRecords(store, MODEL, idsOf(10, 'i'));
    const failing: StoragePort = {
      ...store,
      query: async () => {
        throw new Error('boom: storage offline');
      },
    };
    const outcome = await freezeFanoutMembership({
      store: failing,
      cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
      cohort: { kind: 'model', owner, model: MODEL },
      owner,
      bounds: BOUNDS,
      meta: META,
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) {
      return;
    }
    assert.equal(outcome.diagnosis.kind, 'membership-unavailable');
  });

  it('duplicate freeze replays the stored set, minting nothing', async () => {
    const { store, owner } = await setup();
    await seedRecords(store, MODEL, idsOf(150, 'dup'));
    const first = await freezeFanoutMembership({
      store,
      cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
      cohort: { kind: 'model', owner, model: MODEL },
      owner,
      bounds: { pageLimit: 64, chunkSize: 40, maxAttempts: 5 },
      meta: META,
    });
    assert.equal(first.ok, true);
    if (!first.ok) {
      return;
    }
    assert.equal(first.frozen.replayed, false);
    // A late insert between the freeze and the duplicate delivery must
    // NOT join the replayed set: replay never re-enumerates.
    await seedRecords(store, MODEL, ['dup-late-1']);
    const second = await freezeFanoutMembership({
      store,
      cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
      cohort: { kind: 'model', owner, model: MODEL },
      owner,
      bounds: { pageLimit: 64, chunkSize: 40, maxAttempts: 5 },
      meta: META,
    });
    assert.equal(second.ok, true);
    if (!second.ok) {
      return;
    }
    assert.equal(second.frozen.replayed, true);
    assert.deepEqual(second.frozen.members, first.frozen.members);
    assert.equal(second.frozen.members.length, 150);
    assert.deepEqual(await drainChildIds(store, second.frozen.fanoutId), [
      ...first.frozen.members,
    ].sort());
  });

  it('crash between chunks resumes via re-freezing (cursor-gated)', async () => {
    const { store, owner } = await setup();
    await seedRecords(store, MODEL, idsOf(120, 'crash'));
    let commits = 0;
    const crashing: StoragePort = {
      ...store,
      commit: async (batch) => {
        commits += 1;
        if (commits === 2) {
          // The crash: commit 1 (intent + checkpoint + chunk 0) is
          // durable; the chunk-1 commit never lands.
          throw new Error('boom: process died mid-admission');
        }
        return store.commit(batch);
      },
    };
    const crashed = await freezeFanoutMembership({
      store: crashing,
      cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
      cohort: { kind: 'model', owner, model: MODEL },
      owner,
      bounds: { pageLimit: 64, chunkSize: 50, maxAttempts: 5 },
      meta: META,
    });
    assert.equal(crashed.ok, false);
    // The partial state is honest: non-null cursor, only chunk 0 admitted.
    const fanoutId = fanoutIntentRowId(SOURCE, HANDLER, 'model');
    const checkpointRow = await store.load(FANOUT_CHECKPOINT_MODEL as ModelName, fanoutId as RecordId);
    assert.ok(checkpointRow !== null);
    assert.notEqual(readFanoutCheckpointRow(checkpointRow).cursor, null);
    assert.equal((await drainChildIds(store, fanoutId)).length, 50);
    // Re-freezing replays the stored set and admits the remainder.
    const resumed = await freezeFanoutMembership({
      store,
      cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
      cohort: { kind: 'model', owner, model: MODEL },
      owner,
      bounds: { pageLimit: 64, chunkSize: 50, maxAttempts: 5 },
      meta: META,
    });
    assert.equal(resumed.ok, true);
    if (!resumed.ok) {
      return;
    }
    assert.equal(resumed.frozen.replayed, true);
    assert.equal(resumed.frozen.members.length, 120);
    assert.equal((await drainChildIds(store, fanoutId)).length, 120);
    const finished = await store.load(FANOUT_CHECKPOINT_MODEL as ModelName, fanoutId as RecordId);
    assert.ok(finished !== null);
    assert.equal(readFanoutCheckpointRow(finished).cursor, null);
  });

  it('unknown anchor diagnoses membership-unavailable (never silent empty)', async () => {
    const { store, owner } = await setup();
    await seedRecords(store, CHILD_MODEL, idsOf(5, 'kid'));
    const outcome = await freezeFanoutMembership({
      store,
      cutoff: { sourceOccurrence: SOURCE, handler: 'Volunteer.cancel_signup' },
      cohort: {
        kind: 'anchored-collection',
        owner,
        model: CHILD_MODEL,
        parent: { model: PARENT_MODEL, id: 'opp-ghost' },
      },
      owner,
      bounds: BOUNDS,
      meta: META,
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) {
      return;
    }
    assert.equal(outcome.diagnosis.kind, 'membership-unavailable');
  });

  it('deleted anchor with an empty collection freezes empty-complete', async () => {
    const { store, owner } = await setup();
    const parent = await (async () => {
      const revision = await store.readRevision();
      const row = makeRow({ id: 'opp-dead', data: {} });
      await store.commit(
        makeBatch(revision as number, {
          writes: [{ kind: 'insert', model: asModel(PARENT_MODEL), row }],
        }),
      );
      return row;
    })();
    const revision = await store.readRevision();
    const removed = {
      ...parent,
      version: 2,
      archivedAt: FIXED_NOW,
      data: { ...parent.data },
    } as StoredRow;
    await store.commit(
      makeBatch(revision as number, {
        writes: [
          {
            kind: 'update',
            model: asModel(PARENT_MODEL),
            id: asId('opp-dead'),
            expectedVersion: parent.version,
            row: removed,
          },
        ],
        history: [
          {
            model: asModel(PARENT_MODEL),
            recordId: asId('opp-dead'),
            version: removed.version,
            operation: 'Acme.remove' as never,
            operationId: 'op-1' as never,
            actor: ACTOR,
            at: FIXED_NOW,
            change: 'archive',
            before: {},
            after: {},
          },
        ],
      }),
    );
    const outcome = await freezeFanoutMembership({
      store,
      cutoff: { sourceOccurrence: SOURCE, handler: 'Volunteer.cancel_signup' },
      cohort: {
        kind: 'anchored-collection',
        owner,
        model: CHILD_MODEL,
        parent: { model: PARENT_MODEL, id: 'opp-dead' },
      },
      owner,
      bounds: BOUNDS,
      meta: META,
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) {
      return;
    }
    assert.deepEqual(outcome.frozen.members, []);
  });

  it('unknown model diagnoses unsupported-cohort (guarded callers)', async () => {
    const { store, owner } = await setup();
    const outcome = await freezeFanoutMembership({
      store,
      cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
      cohort: { kind: 'model', owner, model: 'Acme.Ghost' },
      owner,
      bounds: BOUNDS,
      meta: META,
      hasModel: (model) => model === MODEL,
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) {
      return;
    }
    assert.equal(outcome.diagnosis.kind, 'unsupported-cohort');
  });

  it('cross-owner cohort diagnoses cross-owner-cohort', async () => {
    const { store, owner } = await setup();
    const outcome = await freezeFanoutMembership({
      store,
      cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
      cohort: { kind: 'model', owner: 'team-elsewhere', model: MODEL },
      owner,
      bounds: BOUNDS,
      meta: META,
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) {
      return;
    }
    assert.equal(outcome.diagnosis.kind, 'cross-owner-cohort');
  });

  it('empty model freezes empty-complete', async () => {
    const { store, owner } = await setup();
    const outcome = await freezeFanoutMembership({
      store,
      cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
      cohort: { kind: 'model', owner, model: MODEL },
      owner,
      bounds: BOUNDS,
      meta: META,
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) {
      return;
    }
    assert.deepEqual(outcome.frozen.members, []);
    const checkpointRow = await store.load(
      FANOUT_CHECKPOINT_MODEL as ModelName,
      outcome.frozen.fanoutId as RecordId,
    );
    assert.ok(checkpointRow !== null);
    assert.equal(readFanoutCheckpointRow(checkpointRow).cursor, null);
  });
});

describe('t34-f5 membership: F2 byte-compatibility (both directions)', () => {
  it('model literals match the F2 table identities', () => {
    assert.equal(FANOUT_INTENT_MODEL, fns.WORK_FANOUT_INTENT_MODEL);
    assert.equal(FANOUT_CHECKPOINT_MODEL, fns.WORK_FANOUT_CHECKPOINT_MODEL);
    assert.equal(FANOUT_CHILD_MODEL, fns.WORK_FANOUT_CHILD_MODEL);
  });

  it('row-id derivations are byte-identical to F2', () => {
    const cohorts: FanoutCohortKind[] = ['model', 'anchored-collection'];
    for (const cohort of cohorts) {
      assert.equal(
        fanoutIntentRowId('occ/1?a', 'H/h', cohort),
        fns.fanoutIntentRowId('occ/1?a', 'H/h', cohort),
      );
    }
    assert.equal(
      fanoutChildRowId('occ/1', 'H/h', 'rec?1'),
      fns.fanoutChildRowId('occ/1', 'H/h', 'rec?1'),
    );
  });

  it('state-staged rows read clean through the REAL F2 readers', () => {
    const intent = newFanoutIntentRow(
      { sourceOccurrence: SOURCE, handler: HANDLER, cohort: 'model', members: ['b', 'a'] },
      META,
    );
    const realIntent = fns.readFanoutIntentRow(intent);
    assert.deepEqual(realIntent.members, ['a', 'b']);
    assert.equal(realIntent.memberCount, 2);
    const checkpoint = newFanoutCheckpointRow({ fanoutId: realIntent.fanoutId }, META);
    assert.deepEqual(fns.readFanoutCheckpointRow(checkpoint).completed, []);
    const child = newFanoutChildRow(
      {
        fanoutId: realIntent.fanoutId,
        parentOccurrence: SOURCE,
        handler: HANDLER,
        recordId: 'a',
      },
      META,
    );
    const realChild = fns.readFanoutChildRow(child);
    assert.equal(realChild.state, 'pending');
    assert.equal(realChild.attempts, 0);
    const advanced = nextFanoutCheckpointData(
      { fanoutId: realIntent.fanoutId, completed: [], cursor: 'admit/1' },
      ['a'],
      null,
    );
    assert.deepEqual(
      fns.nextFanoutCheckpointData(
        { fanoutId: realIntent.fanoutId, completed: [], cursor: 'admit/1' },
        ['a'],
        null,
      ),
      advanced,
    );
  });

  it('F2-constructed rows read clean through the state readers', () => {
    const intent = fns.newFanoutIntentRow(
      { sourceOccurrence: SOURCE, handler: HANDLER, cohort: 'anchored-collection', members: ['z'] },
      META,
    );
    assert.deepEqual(readFanoutIntentRow(intent).members, ['z']);
    const checkpoint = fns.newFanoutCheckpointRow(
      { fanoutId: fns.fanoutIntentRowId(SOURCE, HANDLER, 'anchored-collection') },
      META,
    );
    assert.deepEqual(readFanoutCheckpointRow(checkpoint).completed, []);
    const child = fns.newFanoutChildRow(
      {
        fanoutId: fns.fanoutIntentRowId(SOURCE, HANDLER, 'anchored-collection'),
        parentOccurrence: SOURCE,
        handler: HANDLER,
        recordId: 'z',
      },
      META,
    );
    assert.equal(readFanoutChildRow(child).state, 'pending');
  });

  it('malformed rows fail closed on both sides', () => {
    const bad = newFanoutChildRow(
      { fanoutId: 'fanout/v1/o/h/model', parentOccurrence: 'o', handler: 'h', recordId: 'r' },
      META,
    );
    const tampered: StoredRow = { ...bad, data: { ...(bad.data as Record<string, unknown>), state: 'bogus' } };
    assert.throws(() => readFanoutChildRow(tampered), StateError);
    assert.throws(() => fns.readFanoutChildRow(tampered), Error);
  });
});
