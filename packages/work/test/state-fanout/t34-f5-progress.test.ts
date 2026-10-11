/**
 * T34-F5 progress proofs (memory substrate): the data-minimized operator
 * projection — counts only, terminal-with-failures meaning attention.
 *
 * Proves (M5/C6/C7): exact per-state counts over bounded pages;
 * terminal/attention semantics (all-terminal clean → terminal without
 * attention; all-terminal with failures → attention; anything live →
 * non-terminal); members with no child row counting as pending
 * (admission outstanding, never silently complete); the returned shape
 * carrying NO rows (exact key set); and count agreement with the REAL
 * F3 progress summary over the same admitted rows.
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
import { createFanoutChildJoinPort } from '@canlang/state/ports/transact';
import {
  FANOUT_CHECKPOINT_MODEL,
  FANOUT_CHILD_MODEL,
  FANOUT_INTENT_MODEL,
  fanoutChildRowId,
  newFanoutChildRow,
  readFanoutCheckpointRow,
  readFanoutChildRow,
  withFanoutRowData,
} from '@canlang/state/fanout/tables';
import { freezeFanoutMembership } from '@canlang/state/fanout/membership';
import {
  stageFanoutCheckpointAdvanceWrite,
  stageFanoutChildOutcomeWrite,
} from '@canlang/state/fanout/outcome';
import { readFanoutProgress } from '@canlang/state/fanout/progress';
import { loadWorkFanoutFns, type WorkFanoutFns } from './work-loader.js';
import {
  FIXED_NOW,
  asId,
  asModel,
  createMemoryIdentityStore,
  makeBatch,
  makeRow,
  seedMember,
} from '@canlang/state/testing/invocation/fixtures';

const MODEL = 'Acme.Commitment';
const HANDLER = 'Shift.review_commitment';
const SOURCE = 'occ-prog-1';
const ACTOR = 't34-f5-progress';
const META = { nowMs: FIXED_NOW, actor: ACTOR };
const POLICY: RetryPolicy = { maxAttempts: 3, horizonMs: 60_000 };

const fns: WorkFanoutFns = await loadWorkFanoutFns();

async function setup() {
  const store = createMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  return { store, owner: alice.team.team_id as string };
}

async function frozenCohort(
  store: StoragePort,
  owner: string,
  ids: ReadonlyArray<string>,
): Promise<string> {
  const revision = await store.readRevision();
  await store.commit(
    makeBatch(revision as number, {
      writes: ids.map((id) => ({
        kind: 'insert' as const,
        model: asModel(MODEL),
        row: makeRow({ id, data: {} }),
      })),
    }),
  );
  const outcome = await freezeFanoutMembership({
    store,
    cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
    cohort: { kind: 'model', owner, model: MODEL },
    owner,
    bounds: { pageLimit: 4, chunkSize: 4, maxAttempts: 5 },
    meta: META,
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) {
    throw new Error('freeze failed in test setup');
  }
  return outcome.frozen.fanoutId;
}

/** Record one child terminal through the join port (claim → record + advance). */
async function recordTerminal(
  store: StoragePort,
  fanoutId: string,
  recordId: string,
  result:
    | { readonly kind: 'completed' }
    | { readonly kind: 'skipped'; readonly reason: 'deleted' | 'non-applicable' }
    | { readonly kind: 'failed'; readonly reason: 'terminal' | 'business-rejection' },
): Promise<void> {
  const childId = fanoutChildRowId(SOURCE, HANDLER, recordId);
  const pending = await store.load(FANOUT_CHILD_MODEL as ModelName, childId as RecordId);
  assert.ok(pending !== null);
  const running = withFanoutRowData(
    pending,
    { ...readFanoutChildRow(pending), state: 'running' },
    META,
  );
  // The claim and the record land as two commits here (test-only
  // sequencing); the OUTCOME and the CHECKPOINT co-commit atomically,
  // which is the asserted unit.
  const revClaim = await store.readRevision();
  await store.commit(
    makeBatch(revClaim as number, {
      writes: [
        {
          kind: 'update',
          model: FANOUT_CHILD_MODEL as ModelName,
          id: childId as RecordId,
          expectedVersion: pending.version,
          row: running,
        },
      ],
    }),
  );
  const checkpointRow = await store.load(FANOUT_CHECKPOINT_MODEL as ModelName, fanoutId as RecordId);
  assert.ok(checkpointRow !== null);
  const restaged = stageFanoutChildOutcomeWrite({
    row: running,
    result,
    nowMs: FIXED_NOW,
    firstAttemptAtMs: FIXED_NOW,
    policy: POLICY,
    meta: META,
  });
  const advance = stageFanoutCheckpointAdvanceWrite({
    row: checkpointRow,
    recordId,
    cursor: readFanoutCheckpointRow(checkpointRow).cursor,
    meta: META,
  });
  const port = createFanoutChildJoinPort({ store });
  const revUnit = await store.readRevision();
  await port.commitJoin({
    ...makeBatch(revUnit as number, { writes: [restaged.write, advance] }),
    expectedRevision: revUnit,
  });
}

/** Hold one child in running (a live claim) without recording. */
async function holdRunning(store: StoragePort, recordId: string): Promise<void> {
  const childId = fanoutChildRowId(SOURCE, HANDLER, recordId);
  const pending = await store.load(FANOUT_CHILD_MODEL as ModelName, childId as RecordId);
  assert.ok(pending !== null);
  const revision = await store.readRevision();
  await store.commit(
    makeBatch(revision as number, {
      writes: [
        {
          kind: 'update',
          model: FANOUT_CHILD_MODEL as ModelName,
          id: childId as RecordId,
          expectedVersion: pending.version,
          row: withFanoutRowData(
            pending,
            { ...readFanoutChildRow(pending), state: 'running' },
            META,
          ),
        },
      ],
    }),
  );
}

async function drainChildRows(store: StoragePort, fanoutId: string): Promise<StoredRow[]> {
  const rows: StoredRow[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await store.query({
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
      limit: 4,
      authority: 'owner',
    });
    rows.push(...page);
    if (page.length < 4) {
      return rows;
    }
    const last = page[page.length - 1];
    if (last === undefined) {
      throw new Error('unreachable empty full page in test drain');
    }
    cursor = last.id as string;
  }
}

describe('t34-f5 progress: counts, terminality, attention', () => {
  it('private progress bounds refuse before storage and retained member traversal', async () => {
    const { store, owner } = await setup();
    const fanoutId = await frozenCohort(store, owner, ['p-bound']);
    let touches = 0;
    const untouched: StoragePort = { ...store,
      readRevision: async () => { touches += 1; return store.readRevision(); },
      cohortLoad: async input => { touches += 1; return store.cohortLoad(input); },
      cohortRowPage: async input => { touches += 1; return store.cohortRowPage(input); },
    };
    const limit = (error: unknown) => error instanceof StateError && error.code === 'limit' && error.retryable === false;
    await assert.rejects(readFanoutProgress({ store: untouched, fanoutId, pageLimit: 101 }), limit);
    await assert.rejects(readFanoutProgress({ store: untouched, fanoutId: 'x'.repeat(6001), pageLimit: 100 }), limit);
    let boundAccesses = 0;
    await assert.rejects(readFanoutProgress({ store: untouched, fanoutId,
      get pageLimit() { boundAccesses += 1; return 100; } }),
      (error: unknown) => error instanceof StateError && error.code === 'validation');
    assert.equal(boundAccesses, 0);
    assert.equal(touches, 0);
    const retained = await store.load(FANOUT_INTENT_MODEL as ModelName, fanoutId as RecordId);
    assert.ok(retained);
    let reads = 0;
    const members = new Array(1001);
    Object.defineProperty(members, '0', { enumerable: true, get: () => { reads += 1; return 'p-bound'; } });
    const oversized: StoragePort = { ...store,
      cohortLoad: async () => ({ ...retained, data: { ...retained.data, members, memberCount: 1001 } }),
      cohortRowPage: async () => { touches += 1; return []; },
    };
    await assert.rejects(readFanoutProgress({ store: oversized, fanoutId, pageLimit: 100 }), limit);
    assert.equal(reads, 0);
    assert.equal(touches, 0);
  });

  it('private progress counts unmatched raw rows and refuses the overflow before decoding', async () => {
    const { store, owner } = await setup();
    const fanoutId = await frozenCohort(store, owner, ['p-raw']);
    const foreign = Array.from({ length: 1000 }, (_, index) => newFanoutChildRow({
      fanoutId: 'fanout/v1/other/handler/model', parentOccurrence: 'other', handler: HANDLER,
      recordId: `raw-${String(index).padStart(4, '0')}`,
    }, META));
    for (const overflow of [false, true]) {
      let calls = 0;
      let decodedOverflow = 0;
      const extra = { ...foreign[999]!, id: 'z-overflow' as RecordId };
      Object.defineProperty(extra, 'data', { enumerable: true, get: () => { decodedOverflow += 1; throw new Error('overflow decoded'); } });
      const rows = overflow ? [...foreign, extra] : foreign;
      const bounded: StoragePort = { ...store, cohortRowPage: async input => {
        calls += 1;
        assert.equal(input.expectedRevision, await store.readRevision());
        assert.equal(input.limit, calls <= 10 ? 100 : 1);
        return rows.filter(row => input.after === null || row.id > input.after).slice(0, input.limit);
      } };
      if (overflow) {
        await assert.rejects(readFanoutProgress({ store: bounded, fanoutId, pageLimit: 100 }),
          (error: unknown) => error instanceof StateError && error.code === 'limit' && error.retryable === false);
      } else {
        const progress = await readFanoutProgress({ store: bounded, fanoutId, pageLimit: 100 });
        assert.equal(progress.pending, 1);
        assert.equal(progress.terminal, false);
      }
      assert.equal(calls, 11);
      assert.equal(decodedOverflow, 0);
    }
  });

  it('private progress rejects over-return, nonadvancing pages and foreign frozen children', async () => {
    const { store, owner } = await setup();
    const fanoutId = await frozenCohort(store, owner, ['p-shape']);
    const row = await store.load(FANOUT_CHILD_MODEL as ModelName,
      fanoutChildRowId(SOURCE, HANDLER, 'p-shape') as RecordId);
    assert.ok(row);
    for (const fault of ['over-return', 'nonadvancing', 'wrong-member'] as const) {
      let calls = 0;
      const faulty: StoragePort = { ...store, cohortRowPage: async () => {
        calls += 1;
        if (fault === 'over-return') return [row, row];
        if (fault === 'nonadvancing') return [row];
        return [newFanoutChildRow({ fanoutId, parentOccurrence: SOURCE, handler: HANDLER,
          recordId: 'outside-membership' }, META)];
      } };
      await assert.rejects(readFanoutProgress({ store: faulty, fanoutId, pageLimit: 1 }),
        (error: unknown) => error instanceof StateError && error.code === 'validation');
      assert.equal(calls, fault === 'nonadvancing' ? 2 : 1);
    }
    const good = await readFanoutProgress({ store, fanoutId, pageLimit: 1 });
    assert.equal(good.pending, 1);
    assert.equal(good.terminal, false);
  });

  it('mixed states fold to exact counts (non-terminal)', async () => {
    const { store, owner } = await setup();
    const fanoutId = await frozenCohort(store, owner, ['p-0', 'p-1', 'p-2', 'p-3', 'p-4', 'p-5']);
    await recordTerminal(store, fanoutId, 'p-0', { kind: 'completed' });
    await recordTerminal(store, fanoutId, 'p-1', { kind: 'skipped', reason: 'non-applicable' });
    await recordTerminal(store, fanoutId, 'p-2', { kind: 'failed', reason: 'terminal' });
    await holdRunning(store, 'p-3');
    // p-4, p-5 stay pending.
    const progress = await readFanoutProgress({ store, fanoutId, pageLimit: 2 });
    assert.deepEqual(progress, {
      fanoutId,
      pending: 2,
      running: 1,
      completed: 1,
      skipped: 1,
      failed: 1,
      terminal: false,
      attention: false,
    });
    // REAL F3 summary agrees over the same admitted rows.
    const rows = await drainChildRows(store, fanoutId);
    assert.equal(rows.length, 6);
    assert.deepEqual(fns.summarizeFanoutChildren(fanoutId, rows), progress);
  });

  it('all-terminal clean reads terminal without attention', async () => {
    const { store, owner } = await setup();
    const fanoutId = await frozenCohort(store, owner, ['c-0', 'c-1', 'c-2']);
    await recordTerminal(store, fanoutId, 'c-0', { kind: 'completed' });
    await recordTerminal(store, fanoutId, 'c-1', { kind: 'completed' });
    await recordTerminal(store, fanoutId, 'c-2', { kind: 'skipped', reason: 'deleted' });
    const progress = await readFanoutProgress({ store, fanoutId, pageLimit: 2 });
    assert.equal(progress.terminal, true);
    assert.equal(progress.attention, false);
    assert.deepEqual(
      [progress.pending, progress.running, progress.completed, progress.skipped, progress.failed],
      [0, 0, 2, 1, 0],
    );
  });

  it('all-terminal with failures reads attention (never success)', async () => {
    const { store, owner } = await setup();
    const fanoutId = await frozenCohort(store, owner, ['f-0', 'f-1']);
    await recordTerminal(store, fanoutId, 'f-0', { kind: 'completed' });
    await recordTerminal(store, fanoutId, 'f-1', { kind: 'failed', reason: 'business-rejection' });
    const progress = await readFanoutProgress({ store, fanoutId, pageLimit: 8 });
    assert.equal(progress.terminal, true);
    assert.equal(progress.attention, true);
  });

  it('members with no child row count as pending (never silently complete)', async () => {
    const { store, owner } = await setup();
    const revision = await store.readRevision();
    await store.commit(
      makeBatch(revision as number, {
        writes: [
          { kind: 'insert', model: asModel(MODEL), row: makeRow({ id: 'm-0', data: {} }) },
          { kind: 'insert', model: asModel(MODEL), row: makeRow({ id: 'm-1', data: {} }) },
        ],
      }),
    );
    const outcome = await freezeFanoutMembership({
      store,
      cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
      cohort: { kind: 'model', owner, model: MODEL },
      owner,
      bounds: { pageLimit: 4, chunkSize: 1, maxAttempts: 5 },
      meta: META,
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) {
      return;
    }
    // Simulate crash-mid-admission: remove one child row directly (the
    // store allows it; production never removes — this models the
    // pre-crash absence the admit path covers).
    const victimId = fanoutChildRowId(SOURCE, HANDLER, 'm-1');
    const victim = await store.load(FANOUT_CHILD_MODEL as ModelName, victimId as RecordId);
    assert.ok(victim !== null);
    const revRemove = await store.readRevision();
    await store.commit(
      makeBatch(revRemove as number, {
        writes: [
          {
            kind: 'remove',
            model: FANOUT_CHILD_MODEL as ModelName,
            id: victimId as RecordId,
            expectedVersion: victim.version,
          },
        ],
      }),
    );
    const progress = await readFanoutProgress({ store, fanoutId: outcome.frozen.fanoutId, pageLimit: 4 });
    assert.equal(progress.pending, 2);
    assert.equal(progress.terminal, false);
  });

  it('empty cohort reads terminal zeros without attention', async () => {
    const { store, owner } = await setup();
    const fanoutId = await frozenCohort(store, owner, []);
    const progress = await readFanoutProgress({ store, fanoutId, pageLimit: 4 });
    assert.deepEqual(progress, {
      fanoutId,
      pending: 0,
      running: 0,
      completed: 0,
      skipped: 0,
      failed: 0,
      terminal: true,
      attention: false,
    });
  });

  it('progress carries no rows (exact minimized key set)', async () => {
    const { store, owner } = await setup();
    const fanoutId = await frozenCohort(store, owner, ['k-0']);
    const progress = await readFanoutProgress({ store, fanoutId, pageLimit: 4 });
    assert.deepEqual(Object.keys(progress).sort(), [
      'attention',
      'completed',
      'failed',
      'fanoutId',
      'pending',
      'running',
      'skipped',
      'terminal',
    ]);
    const serialized = JSON.stringify(progress);
    assert.ok(!serialized.includes('k-0'));
    assert.ok(!serialized.includes('reviewed'));
  });

  it('missing intent is not_found (no invented progress)', async () => {
    const { store } = await setup();
    await assert.rejects(
      readFanoutProgress({ store, fanoutId: 'fanout/v1/ghost/h/model', pageLimit: 4 }),
      (error: unknown) => error instanceof StateError && error.code === 'not_found',
    );
  });

  it('intent row is readable (sanity: progress joins the frozen set)', async () => {
    const { store, owner } = await setup();
    const fanoutId = await frozenCohort(store, owner, ['s-0']);
    const intentRow = await store.load(FANOUT_INTENT_MODEL as ModelName, fanoutId as RecordId);
    assert.ok(intentRow !== null);
    assert.equal(fns.readFanoutIntentRow(intentRow).memberCount, 1);
  });
});
