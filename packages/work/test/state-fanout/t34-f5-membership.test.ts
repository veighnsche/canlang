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
import { FenceConflictError } from '@canlang/state/storage/port';
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
  withFanoutRowData,
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
      { pageLimit: 100, chunkSize: 100, maxAttempts: 5 },
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
      cohortIdentityPage: async (spec) => {
        const rows = await store.cohortIdentityPage(spec);
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
      cohortIdentityPage: async (spec) => {
        const rows = await store.cohortIdentityPage(spec);
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
  it('captures caller source fields once and preserves Unicode members in Memory order', async () => {
    const { store, owner } = await setup();
    const ids = ['a', '\u{1f600}', '\ue000'];
    await seedRecords(store, MODEL, ids);
    assert.equal(store.cohortIdOrder, 'utf16');
    const cutoff = { sourceOccurrence: SOURCE, handler: HANDLER };
    const cohort = { kind: 'model' as const, owner, model: MODEL };
    let changed = false;
    const capturing: StoragePort = { ...store, cohortIdentityPage: async input => {
      const page = await store.cohortIdentityPage(input);
      if (!changed) {
        changed = true;
        cutoff.sourceOccurrence = 'changed-caller-source';
        cutoff.handler = 'changed-caller-handler';
        cohort.model = 'Changed.CallerModel';
      }
      return page;
    } };
    const result = await freezeFanoutMembership({ store: capturing, cutoff, cohort, owner,
      bounds: { pageLimit: 1, chunkSize: 1, maxAttempts: 3 }, meta: META });
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error('captured original source must freeze');
    assert.deepEqual(result.frozen.members, [...ids].sort());
    assert.equal(result.frozen.fanoutId, fanoutIntentRowId(SOURCE, HANDLER, 'model'));
    assert.deepEqual(await drainChildIds(store, result.frozen.fanoutId), [...ids].sort());
    for (const id of ids) {
      const child = readFanoutChildRow((await store.load(FANOUT_CHILD_MODEL as ModelName,
        fanoutChildRowId(SOURCE, HANDLER, id) as RecordId))!);
      assert.equal(child.parentOccurrence, SOURCE);
      assert.equal(child.handler, HANDLER);
    }
  });

  it('refuses over-return, nonascending and nonadvancing identity pages before fanout effects', async () => {
    for (const fault of ['over-return', 'nonascending', 'nonadvancing']) {
      const { store, owner } = await setup();
      await seedRecords(store, MODEL, ['a', 'b', 'c']);
      const revision = await store.readRevision();
      let calls = 0, commits = 0;
      let first: readonly RecordId[] = [];
      const broken: StoragePort = { ...store,
        cohortIdentityPage: async input => {
          calls += 1;
          const ids = await store.cohortIdentityPage(fault === 'over-return' ? { ...input, limit: 3 } : input);
          if (fault === 'nonascending') return [...ids].reverse();
          if (fault === 'nonadvancing') {
            if (calls === 1) first = ids;
            else return first;
          }
          return ids;
        },
        commit: async batch => { commits += 1; return store.commit(batch); },
      };
      await assert.rejects(freezeFanoutMembership({ store: broken,
        cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
        cohort: { kind: 'model', owner, model: MODEL }, owner,
        bounds: { pageLimit: 2, chunkSize: 2, maxAttempts: 1 }, meta: META }),
      error => error instanceof StateError && error.code === 'validation' && error.retryable !== true);
      assert.equal(calls, fault === 'nonadvancing' ? 2 : 1);
      assert.equal(commits, 0);
      assert.equal(await store.readRevision(), revision);
      const fanoutId = fanoutIntentRowId(SOURCE, HANDLER, 'model');
      assert.equal(await store.load(FANOUT_INTENT_MODEL as ModelName, fanoutId as RecordId), null);
      assert.equal(await store.load(FANOUT_CHECKPOINT_MODEL as ModelName, fanoutId as RecordId), null);
      assert.deepEqual(await store.query({ model: FANOUT_CHILD_MODEL as ModelName, authority: 'owner', limit: 100 }), []);
    }
  });

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
      cohortIdentityPage: async () => {
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

  it('retries retained row-page fence contention finitely without recapturing membership or writing', async () => {
    const { store, owner } = await setup();
    const ids = ['retained-a', 'retained-b', 'retained-c'];
    await seedRecords(store, MODEL, ids);
    const input = { store, cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
      cohort: { kind: 'model' as const, owner, model: MODEL }, owner,
      bounds: { pageLimit: 100, chunkSize: 100, maxAttempts: 3 }, meta: META };
    const original = await freezeFanoutMembership(input);
    assert.equal(original.ok, true);
    if (!original.ok) throw new Error('expected original retained cohort');
    const fanoutId = original.frozen.fanoutId;
    const checkpoint = await store.load(FANOUT_CHECKPOINT_MODEL as ModelName, fanoutId as RecordId);
    assert.ok(checkpoint !== null);
    assert.equal(readFanoutCheckpointRow(checkpoint).cursor, null);
    const revision = await store.readRevision();
    for (const persistent of [false, true]) {
      let pages = 0, domainPages = 0, commits = 0;
      const contended: StoragePort = { ...store,
        cohortIdentityPage: async () => { domainPages += 1; throw new Error('retained replay must not enumerate the domain'); },
        cohortRowPage: async request => {
          pages += 1;
          if (persistent || pages === 1) throw new FenceConflictError(request.expectedRevision, null);
          return store.cohortRowPage(request);
        },
        commit: async batch => { commits += 1; return store.commit(batch); },
      };
      const replay = await freezeFanoutMembership({ ...input, store: contended });
      if (persistent) {
        assert.equal(replay.ok, false);
        if (replay.ok) throw new Error('expected exhausted retained fence retries');
        assert.equal(replay.diagnosis.kind, 'membership-unavailable');
        assert.equal(pages, input.bounds.maxAttempts);
      } else {
        assert.equal(replay.ok, true);
        if (!replay.ok) throw new Error('expected recovered retained replay');
        assert.equal(replay.frozen.replayed, true);
        assert.deepEqual(replay.frozen.members, original.frozen.members);
        assert.equal(pages, 2);
      }
      assert.equal(domainPages, 0);
      assert.equal(commits, 0);
      assert.equal(await store.readRevision(), revision);
      assert.deepEqual(await store.load(FANOUT_CHECKPOINT_MODEL as ModelName, fanoutId as RecordId), checkpoint);
      assert.deepEqual(await drainChildIds(store, fanoutId), ids);
    }
  });

  it('keeps retained intent correspondence and child coverage fenced across an external drain race', async () => {
    for (const race of ['replace-intent', 'remove-child']) {
      const { store, owner } = await setup();
      const ids = ['a', 'b', 'c'];
      await seedRecords(store, MODEL, ids);
      const input = { cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
        cohort: { kind: 'model' as const, owner, model: MODEL }, owner,
        bounds: { pageLimit: 100, chunkSize: 1, maxAttempts: 3 }, meta: META };
      const interrupted = await freezeFanoutMembership({ ...input, store: { ...store,
        commit: async batch => {
          if (batch.writes.some(write => write.kind === 'insert' && write.model === FANOUT_CHILD_MODEL &&
            readFanoutChildRow(write.row).recordId === 'b')) throw new Error('retain original first chunk');
          return store.commit(batch);
        } } });
      assert.equal(interrupted.ok, false);
      const fanoutId = fanoutIntentRowId(SOURCE, HANDLER, 'model');
      const originalIntent = (await store.load(FANOUT_INTENT_MODEL as ModelName, fanoutId as RecordId))!;
      const checkpoint = (await store.load(FANOUT_CHECKPOINT_MODEL as ModelName, fanoutId as RecordId))!;
      assert.equal(readFanoutCheckpointRow(checkpoint).cursor, 'admit/1');
      let raced = false, externalCommits = 0, consumerCommits = 0, clearChecks = 0, pages = 0;
      const replayStore: StoragePort = { ...store,
        load: async () => { throw new Error('replay must use fenced cohort loads'); },
        query: async () => { throw new Error('replay must use bounded cohort pages'); },
        historyFor: async () => { throw new Error('replay must not drain history'); },
        cohortIdentityPage: async () => { throw new Error('retained source must not be recaptured'); },
        cohortRowPage: async request => {
          pages += 1;
          const rows = await store.cohortRowPage(request);
          if (!raced) {
            raced = true;
            const revision = await store.readRevision();
            if (race === 'replace-intent') {
              await store.commit(makeBatch(revision as number, { writes: [{ kind: 'update',
                model: FANOUT_INTENT_MODEL as ModelName, id: originalIntent.id,
                expectedVersion: originalIntent.version, row: withFanoutRowData(originalIntent,
                  { ...readFanoutIntentRow(originalIntent), members: ['a', 'foreign'], memberCount: 2 }, META) }] }));
            } else {
              const child = (await store.load(FANOUT_CHILD_MODEL as ModelName,
                fanoutChildRowId(SOURCE, HANDLER, 'a') as RecordId))!;
              await store.commit(makeBatch(revision as number, { writes: [{ kind: 'remove',
                model: FANOUT_CHILD_MODEL as ModelName, id: child.id, expectedVersion: child.version }] }));
            }
            externalCommits += 1;
          }
          return rows;
        },
        commit: async batch => {
          const clears = batch.writes.some(write => write.kind === 'update' &&
            write.model === FANOUT_CHECKPOINT_MODEL && readFanoutCheckpointRow(write.row).cursor === null);
          const result = await store.commit(batch);
          consumerCommits += 1;
          if (clears) {
            clearChecks += 1;
            for (const id of ids) assert.ok(await store.load(FANOUT_CHILD_MODEL as ModelName,
              fanoutChildRowId(SOURCE, HANDLER, id) as RecordId), 'cursor clearing requires complete current child coverage');
          }
          return result;
        },
      };
      const replay = await freezeFanoutMembership({ ...input, store: replayStore });
      assert.equal(externalCommits, 1);
      if (race === 'replace-intent') {
        assert.equal(replay.ok, false);
        if (replay.ok) throw new Error('replaced retained source must refuse');
        assert.equal(replay.diagnosis.kind, 'membership-unavailable');
        assert.equal(consumerCommits, 0);
        assert.equal(clearChecks, 0);
        assert.deepEqual(await store.load(FANOUT_CHECKPOINT_MODEL as ModelName, fanoutId as RecordId), checkpoint);
        assert.deepEqual(await drainChildIds(store, fanoutId), ['a']);
        const replaced = readFanoutIntentRow((await store.load(FANOUT_INTENT_MODEL as ModelName, fanoutId as RecordId))!);
        assert.equal(replaced.sourceOccurrence, SOURCE);
        assert.equal(replaced.handler, HANDLER);
        assert.deepEqual(replaced.members, ['a', 'foreign']);
      } else {
        assert.equal(replay.ok, true);
        if (!replay.ok) throw new Error('removed child must be recovered under a coherent fence');
        assert.deepEqual(replay.frozen.members, ids);
        assert.ok(pages >= 2 && pages <= input.bounds.maxAttempts);
        assert.ok(consumerCommits > 0);
        assert.equal(clearChecks, 1);
        assert.deepEqual(await drainChildIds(store, fanoutId), ids);
        assert.equal(readFanoutCheckpointRow((await store.load(FANOUT_CHECKPOINT_MODEL as ModelName,
          fanoutId as RecordId))!).cursor, null);
      }
    }
  });

  it('refuses fresh intermediate intent replacement before minting another stale-source child', async () => {
    const { store, owner } = await setup();
    await seedRecords(store, MODEL, ['a', 'b', 'c']);
    const fanoutId = fanoutIntentRowId(SOURCE, HANDLER, 'model');
    let consumerCommits = 0, externalCommits = 0;
    const racing: StoragePort = { ...store,
      load: async () => { throw new Error('fresh chunks must use fenced cohort loads'); },
      query: async () => { throw new Error('fresh capture must use bounded cohort pages'); },
      historyFor: async () => { throw new Error('fresh capture must not drain history'); },
      commit: async batch => {
      const result = await store.commit(batch);
      consumerCommits += 1;
      if (consumerCommits === 1) {
        const intent = (await store.load(FANOUT_INTENT_MODEL as ModelName, fanoutId as RecordId))!;
        await store.commit(makeBatch((await store.readRevision()) as number, { writes: [{ kind: 'update',
          model: FANOUT_INTENT_MODEL as ModelName, id: intent.id, expectedVersion: intent.version,
          row: withFanoutRowData(intent, { ...readFanoutIntentRow(intent),
            members: ['a', 'foreign'], memberCount: 2 }, META) }] }));
        externalCommits += 1;
      }
      return result;
    } };
    const outcome = await freezeFanoutMembership({ store: racing,
      cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
      cohort: { kind: 'model', owner, model: MODEL }, owner,
      bounds: { pageLimit: 100, chunkSize: 1, maxAttempts: 3 }, meta: META });
    assert.equal(outcome.ok, false);
    if (outcome.ok) throw new Error('fresh source replacement must refuse');
    assert.equal(outcome.diagnosis.kind, 'membership-unavailable');
    assert.equal(externalCommits, 1);
    assert.equal(consumerCommits, 1);
    assert.deepEqual(await drainChildIds(store, fanoutId), ['a']);
    const checkpoint = (await store.load(FANOUT_CHECKPOINT_MODEL as ModelName, fanoutId as RecordId))!;
    assert.equal(readFanoutCheckpointRow(checkpoint).cursor, 'admit/1');
    const replaced = readFanoutIntentRow((await store.load(FANOUT_INTENT_MODEL as ModelName, fanoutId as RecordId))!);
    assert.equal(replaced.sourceOccurrence, SOURCE);
    assert.equal(replaced.handler, HANDLER);
    assert.deepEqual(replaced.members, ['a', 'foreign']);
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
    let legacyTouches = 0;
    const outcome = await freezeFanoutMembership({
      store: { ...store,
        load: async () => { legacyTouches += 1; throw new Error('anchor classification must not load full rows'); },
        query: async () => { legacyTouches += 1; throw new Error('cohort capture must not query full rows'); },
        historyFor: async () => { legacyTouches += 1; throw new Error('anchor classification must not drain history'); } },
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
    assert.equal(legacyTouches, 0);
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
    const bounded: StoragePort = { ...store,
      load: async () => { throw new Error('anchor classification must not load full rows'); },
      query: async () => { throw new Error('cohort capture must not query full rows'); },
      historyFor: async () => { throw new Error('anchor classification must not drain history'); },
    };
    const outcome = await freezeFanoutMembership({
      store: bounded,
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
    const checkpoint = await store.load(FANOUT_CHECKPOINT_MODEL as ModelName,
      outcome.frozen.fanoutId as RecordId);
    assert.ok(checkpoint !== null);
    assert.equal(readFanoutCheckpointRow(checkpoint).cursor, null);

    // Physical removal is classified from the genuine disposal history,
    // independently of the archived-present occurrence above.
    await store.commit(makeBatch((await store.readRevision()) as number, {
      writes: [{ kind: 'remove', model: asModel(PARENT_MODEL), id: removed.id,
        expectedVersion: removed.version }],
      history: [{ model: asModel(PARENT_MODEL), recordId: removed.id, version: removed.version,
        operation: 'Acme.remove' as never, operationId: 'op-2' as never, actor: ACTOR,
        at: FIXED_NOW, change: 'remove', before: {}, after: {} }],
    }));
    assert.equal(await store.load(asModel(PARENT_MODEL), removed.id), null);
    const disposed = await freezeFanoutMembership({ store: bounded,
      cutoff: { sourceOccurrence: `${SOURCE}-disposed`, handler: 'Volunteer.cancel_signup' },
      cohort: { kind: 'anchored-collection', owner, model: CHILD_MODEL,
        parent: { model: PARENT_MODEL, id: 'opp-dead' } }, owner, bounds: BOUNDS, meta: META });
    assert.equal(disposed.ok, true);
    if (!disposed.ok) throw new Error('expected known physical disposal');
    assert.deepEqual(disposed.frozen.members, []);
    const disposedCheckpoint = await store.load(FANOUT_CHECKPOINT_MODEL as ModelName,
      disposed.frozen.fanoutId as RecordId);
    assert.ok(disposedCheckpoint !== null);
    assert.equal(readFanoutCheckpointRow(disposedCheckpoint).cursor, null);
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
