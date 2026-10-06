/**
 * T34-F2 kernel fanout tables: durable intent/checkpoint/child shapes,
 * insert-once identity, checkpoint upsert, child-row identity (incl.
 * handler-collision prevention), bounded id-sorted paging, done:false
 * means resume, and chunk-size-is-not-cohort-size (§C9).
 *
 * Store-backed proofs below run on the compiled memory adapter (the
 * T24a work-side pattern: `@canlang/work` sources under node type
 * stripping cannot resolve state's `.js`-suffixed source imports, so
 * the suite imports the COMPILED `@canlang/state` dist — run the
 * state build first; the root `pretest` does). REAL D1/DO substrate
 * proofs live in `t34-f2-durable.test.ts`.
 *
 * Scope: table shapes only. No quota/capacity field exists (the
 * adopted contract forbids a fabricated numeric deployment quota),
 * no authoring syntax, no suppression rule, no dispatch claim,
 * recovery scan, membership, or compiler logic (F3–F6 own those).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  CommitBatch,
  DomainWrite,
  RecordId,
  Revision,
  StoragePort,
  StoredRow,
} from '../../../contracts/src/state.js';
import { createTestMemoryStorage } from '../../../state/dist/state/src/storage/memory.js';
import { StorageConstraintError } from '../../../state/dist/state/src/storage/port.js';
import {
  KernelTableError,
  WORK_FANOUT_CHECKPOINT_MODEL,
  WORK_FANOUT_CHILD_MODEL,
  WORK_FANOUT_INTENT_MODEL,
  fanoutCheckpointRowId,
  fanoutChildIdOf,
  fanoutChildPageQuery,
  fanoutChildPageResult,
  fanoutChildRowId,
  fanoutIntentRowId,
  newFanoutCheckpointRow,
  newFanoutChildRow,
  newFanoutIntentRow,
  nextFanoutCheckpointData,
  readFanoutCheckpointRow,
  readFanoutChildRow,
  readFanoutIntentRow,
  withRowData,
} from './tables.ts';

const META = { nowMs: 1_758_000_000_000, actor: 't34-f2-test' };
const OCC = 'occ_source_1';
const HANDLER_COMMITMENT = 'Shift.review_commitment';
const HANDLER_SWAP = 'Shift.review_swap';

function rowWithData(data: unknown, id = 'row_1'): StoredRow {
  return {
    id: id as StoredRow['id'],
    version: 1 as StoredRow['version'],
    created: META.nowMs,
    updated: META.nowMs,
    createdBy: META.actor,
    updatedBy: META.actor,
    archivedAt: null,
    parent: null,
    data: data as StoredRow['data'],
  };
}

async function commitWrites(
  store: StoragePort,
  writes: ReadonlyArray<DomainWrite>,
): Promise<Revision> {
  const batch: CommitBatch = {
    expectedRevision: await store.readRevision(),
    writes,
    history: [],
    receipt: null,
    outbox: [],
    schedules: [],
    uniqueClaims: [],
    uniqueReleases: [],
  };
  return (await store.commit(batch)).revision;
}

async function commitInserts(
  store: StoragePort,
  model: DomainWrite['model'],
  rows: ReadonlyArray<StoredRow>,
  chunkSize: number,
): Promise<void> {
  for (let start = 0; start < rows.length; start += chunkSize) {
    const writes: DomainWrite[] = rows
      .slice(start, start + chunkSize)
      .map((row) => ({ kind: 'insert', model, row }));
    await commitWrites(store, writes);
  }
}

async function collectChildIds(
  store: StoragePort,
  fanoutId: string,
  limit: number,
): Promise<{ ids: string[]; pages: number }> {
  let cursor: string | null = null;
  const ids: string[] = [];
  let pages = 0;
  for (;;) {
    const rows = await store.query(fanoutChildPageQuery(fanoutId, { cursor, limit }));
    const page = fanoutChildPageResult(rows, limit);
    pages += 1;
    for (const row of page.rows) {
      ids.push(row.id as string);
    }
    if (page.done) {
      assert.equal(page.cursor, null);
      return { ids, pages };
    }
    assert.notEqual(page.cursor, null);
    cursor = page.cursor;
  }
}

describe('t34-f2 intent rows', () => {
  it('round-trips both cohort spellings with a frozen sorted member set', () => {
    for (const cohort of ['model', 'anchored-collection'] as const) {
      const row = newFanoutIntentRow(
        { sourceOccurrence: OCC, handler: HANDLER_COMMITMENT, cohort, members: ['m-2', 'm-1'] },
        META,
      );
      assert.equal(row.id, fanoutIntentRowId(OCC, HANDLER_COMMITMENT, cohort));
      assert.deepEqual(readFanoutIntentRow(row), {
        fanoutId: fanoutIntentRowId(OCC, HANDLER_COMMITMENT, cohort),
        sourceOccurrence: OCC,
        handler: HANDLER_COMMITMENT,
        cohort,
        members: ['m-1', 'm-2'],
        memberCount: 2,
      });
    }
  });

  it('allows an empty frozen set: an admitted-empty cohort still commits', () => {
    const row = newFanoutIntentRow(
      { sourceOccurrence: OCC, handler: HANDLER_COMMITMENT, cohort: 'model', members: [] },
      META,
    );
    assert.deepEqual(readFanoutIntentRow(row).members, []);
    assert.equal(readFanoutIntentRow(row).memberCount, 0);
  });

  it('derives the intent id deterministically under cutoff+cohort', () => {
    const first = fanoutIntentRowId(OCC, HANDLER_COMMITMENT, 'model');
    const second = fanoutIntentRowId(OCC, HANDLER_COMMITMENT, 'model');
    assert.equal(first, second);
    assert.equal(first, `fanout/v1/${OCC}/${encodeURIComponent(HANDLER_COMMITMENT)}/model`);
    assert.notEqual(first, fanoutIntentRowId(OCC, HANDLER_SWAP, 'model'));
    assert.notEqual(first, fanoutIntentRowId(OCC, HANDLER_COMMITMENT, 'anchored-collection'));
    assert.notEqual(first, fanoutIntentRowId('occ_other', HANDLER_COMMITMENT, 'model'));
    // Exact escaping pin: `/` in components must not collide with separators.
    assert.equal(
      fanoutIntentRowId('o/1', 'h/2', 'model'),
      'fanout/v1/o%2F1/h%2F2/model',
    );
    assert.notEqual(fanoutIntentRowId('a/b', 'c', 'model'), fanoutIntentRowId('a', 'b/c', 'model'));
  });

  it('rejects bad cohorts, members, counts and id derivations', () => {
    assert.throws(
      () =>
        newFanoutIntentRow(
          { sourceOccurrence: OCC, handler: 'h', cohort: 'whole-model' as 'model', members: [] },
          META,
        ),
      KernelTableError,
    );
    assert.throws(
      () =>
        newFanoutIntentRow(
          { sourceOccurrence: OCC, handler: 'h', cohort: 'model', members: ['m', 'm'] },
          META,
        ),
      /duplicate identity/,
    );
    assert.throws(
      () =>
        newFanoutIntentRow(
          { sourceOccurrence: OCC, handler: 'h', cohort: 'model', members: [''] },
          META,
        ),
      /non-empty strings/,
    );
    assert.throws(() => fanoutIntentRowId('', 'h', 'model'), KernelTableError);
    assert.throws(() => fanoutIntentRowId('o', '', 'model'), KernelTableError);
    const good = readFanoutIntentRow(
      newFanoutIntentRow(
        { sourceOccurrence: OCC, handler: 'h', cohort: 'model', members: ['m-1'] },
        META,
      ),
    );
    const fanoutId = fanoutIntentRowId(OCC, 'h', 'model');
    assert.throws(
      () => readFanoutIntentRow(rowWithData({ ...good, memberCount: 2 }, fanoutId)),
      /memberCount/,
    );
    assert.throws(
      () => readFanoutIntentRow(rowWithData({ ...good, members: ['m-1', 'm-1'] }, fanoutId)),
      /duplicate identity/,
    );
    assert.throws(
      () =>
        readFanoutIntentRow(
          rowWithData({ ...good, fanoutId: 'fanout/v1/o/h/model' }, 'fanout/v1/o/h/model'),
        ),
      /cutoff\+cohort/,
    );
    assert.throws(
      () => readFanoutIntentRow(rowWithData({ ...good }, 'wrong-id')),
      /row id must equal/,
    );
  });
});

describe('t34-f2 checkpoint rows', () => {
  it('round-trips the completed set plus cursor', () => {
    const fanoutId = fanoutIntentRowId(OCC, HANDLER_COMMITMENT, 'model');
    const row = newFanoutCheckpointRow({ fanoutId }, META);
    assert.equal(row.id, fanoutCheckpointRowId(fanoutId));
    assert.equal(row.id, fanoutId);
    assert.deepEqual(readFanoutCheckpointRow(row), { fanoutId, completed: [], cursor: null });
    const seeded = newFanoutCheckpointRow(
      { fanoutId, completed: ['c-2', 'c-1'], cursor: 'cursor-9' },
      META,
    );
    assert.deepEqual(readFanoutCheckpointRow(seeded), {
      fanoutId,
      completed: ['c-1', 'c-2'],
      cursor: 'cursor-9',
    });
  });

  it('advances the completed set purely: merge, dedupe, sorted, cursor carried', () => {
    const fanoutId = fanoutIntentRowId(OCC, HANDLER_COMMITMENT, 'model');
    const current = readFanoutCheckpointRow(newFanoutCheckpointRow({ fanoutId }, META));
    const next = nextFanoutCheckpointData(current, ['c-2', 'c-1'], 'cursor-1');
    assert.deepEqual(next, { fanoutId, completed: ['c-1', 'c-2'], cursor: 'cursor-1' });
    // Re-adding an already completed identity is a no-op merge, not a duplicate.
    const again = nextFanoutCheckpointData(next, ['c-1', 'c-3'], null);
    assert.deepEqual(again, { fanoutId, completed: ['c-1', 'c-2', 'c-3'], cursor: null });
    // The input is never mutated.
    assert.deepEqual(current.completed, []);
    assert.throws(() => nextFanoutCheckpointData(current, [], ''), /cursor/);
    // Duplicates inside one advance collapse under union semantics, not an error.
    assert.deepEqual(nextFanoutCheckpointData(current, ['c-1', 'c-1'], null).completed, ['c-1']);
    assert.throws(
      () => nextFanoutCheckpointData(current, [''], null),
      /non-empty strings/,
    );
  });

  it('rejects empty cursors, duplicate completed ids and row-id drift', () => {
    const fanoutId = fanoutIntentRowId(OCC, HANDLER_COMMITMENT, 'model');
    assert.throws(
      () => newFanoutCheckpointRow({ fanoutId, cursor: '' }, META),
      /cursor/,
    );
    assert.throws(
      () => newFanoutCheckpointRow({ fanoutId, completed: ['c', 'c'] }, META),
      /duplicate identity/,
    );
    assert.throws(() => fanoutCheckpointRowId(''), KernelTableError);
    const good = readFanoutCheckpointRow(newFanoutCheckpointRow({ fanoutId }, META));
    assert.throws(
      () => readFanoutCheckpointRow(rowWithData({ ...good, cursor: '' }, fanoutId)),
      /cursor/,
    );
    assert.throws(
      () => readFanoutCheckpointRow(rowWithData({ ...good }, 'wrong-id')),
      /row id must equal/,
    );
  });
});

describe('t34-f2 child rows', () => {
  const fanoutId = fanoutIntentRowId(OCC, HANDLER_COMMITMENT, 'model');

  it('round-trips every lifecycle state with its closed cause', () => {
    const pending = readFanoutChildRow(
      newFanoutChildRow({ fanoutId, parentOccurrence: OCC, handler: 'h', recordId: 'r-1' }, META),
    );
    assert.deepEqual(
      [pending.state, pending.attempts, pending.causeKind, pending.causeReason],
      ['pending', 0, null, null],
    );
    const running = readFanoutChildRow(
      newFanoutChildRow(
        { fanoutId, parentOccurrence: OCC, handler: 'h', recordId: 'r-2', state: 'running', attempts: 1 },
        META,
      ),
    );
    assert.deepEqual(
      [running.state, running.attempts, running.causeKind, running.causeReason],
      ['running', 1, null, null],
    );
    const completed = readFanoutChildRow(
      newFanoutChildRow(
        {
          fanoutId, parentOccurrence: OCC, handler: 'h', recordId: 'r-3',
          state: 'completed', attempts: 2, causeKind: 'completed',
        },
        META,
      ),
    );
    assert.deepEqual(
      [completed.state, completed.causeKind, completed.causeReason],
      ['completed', 'completed', null],
    );
    for (const reason of ['deleted', 'non-applicable'] as const) {
      const skipped = readFanoutChildRow(
        newFanoutChildRow(
          {
            fanoutId, parentOccurrence: OCC, handler: 'h', recordId: `s-${reason}`,
            state: 'skipped', causeKind: 'skipped', causeReason: reason,
          },
          META,
        ),
      );
      assert.deepEqual([skipped.state, skipped.causeKind, skipped.causeReason], ['skipped', 'skipped', reason]);
    }
    for (const reason of [
      'business-rejection', 'terminal', 'exhausted',
      'missing-record', 'inaccessible-record', 'infra-read-failure',
    ] as const) {
      const failed = readFanoutChildRow(
        newFanoutChildRow(
          {
            fanoutId, parentOccurrence: OCC, handler: 'h', recordId: `f-${reason}`,
            state: 'failed', attempts: 3, causeKind: 'failed', causeReason: reason,
          },
          META,
        ),
      );
      assert.deepEqual([failed.state, failed.causeKind, failed.causeReason], ['failed', 'failed', reason]);
    }
  });

  it('keys rows by the full parent+handler+record identity', () => {
    const row = newFanoutChildRow(
      { fanoutId, parentOccurrence: OCC, handler: HANDLER_COMMITMENT, recordId: 'rec-7' },
      META,
    );
    const expected = `fanout-child/v1/${OCC}/${encodeURIComponent(HANDLER_COMMITMENT)}/rec-7`;
    assert.equal(row.id, expected);
    assert.equal(row.id, fanoutChildRowId(OCC, HANDLER_COMMITMENT, 'rec-7'));
    assert.equal(readFanoutChildRow(row).childId, expected);
    assert.deepEqual(fanoutChildIdOf(readFanoutChildRow(row)), {
      parentOccurrence: OCC,
      handler: HANDLER_COMMITMENT,
      recordId: 'rec-7',
    });
    // Same triple, same id: retries reuse the row, duplicates replay.
    assert.equal(
      fanoutChildRowId(OCC, HANDLER_COMMITMENT, 'rec-7'),
      fanoutChildRowId(OCC, HANDLER_COMMITMENT, 'rec-7'),
    );
  });

  it('prevents handler collisions: Commitment/Swap on one source never share a row', () => {
    const commitment = fanoutChildRowId(OCC, HANDLER_COMMITMENT, 'rec-1');
    const swap = fanoutChildRowId(OCC, HANDLER_SWAP, 'rec-1');
    assert.notEqual(commitment, swap);
    assert.notEqual(
      fanoutChildRowId(OCC, HANDLER_COMMITMENT, 'rec-1'),
      fanoutChildRowId(OCC, HANDLER_COMMITMENT, 'rec-2'),
    );
    assert.notEqual(
      fanoutChildRowId(OCC, HANDLER_COMMITMENT, 'rec-1'),
      fanoutChildRowId('occ_other', HANDLER_COMMITMENT, 'rec-1'),
    );
    // Exact escaping pin: `/` inside one component never merges with separators.
    assert.equal(fanoutChildRowId('o', 'h/1', 'r'), 'fanout-child/v1/o/h%2F1/r');
    assert.notEqual(fanoutChildRowId('o', 'a/b', 'c'), fanoutChildRowId('o', 'a', 'b/c'));
    assert.throws(() => fanoutChildRowId('', 'h', 'r'), KernelTableError);
    assert.throws(() => fanoutChildRowId('o', '', 'r'), KernelTableError);
    assert.throws(() => fanoutChildRowId('o', 'h', ''), KernelTableError);
  });

  it('rejects unknown states, open causes and id drift', () => {
    const base = {
      fanoutId, parentOccurrence: OCC, handler: 'h', recordId: 'r-1',
    } as const;
    assert.throws(
      () => newFanoutChildRow({ ...base, state: 'waiting' as 'pending' }, META),
      /state is unknown/,
    );
    assert.throws(() => newFanoutChildRow({ ...base, attempts: -1 }, META), /attempts/);
    assert.throws(
      () => newFanoutChildRow({ ...base, causeKind: 'completed' }, META),
      /until terminal/,
    );
    assert.throws(
      () =>
        newFanoutChildRow(
          { ...base, state: 'completed', causeKind: 'completed', causeReason: 'deleted' },
          META,
        ),
      /no reason/,
    );
    assert.throws(
      () => newFanoutChildRow({ ...base, state: 'skipped', causeKind: 'skipped' }, META),
      /closed reason/,
    );
    assert.throws(
      () =>
        newFanoutChildRow(
          { ...base, state: 'skipped', causeKind: 'skipped', causeReason: 'exhausted' },
          META,
        ),
      /closed reason/,
    );
    assert.throws(
      () =>
        newFanoutChildRow(
          { ...base, state: 'failed', causeKind: 'failed', causeReason: 'deleted' },
          META,
        ),
      /closed reason/,
    );
    const good = readFanoutChildRow(newFanoutChildRow(base, META));
    const childId = fanoutChildRowId(OCC, 'h', 'r-1');
    assert.throws(
      () => readFanoutChildRow(rowWithData({ ...good, state: 'waiting' }, childId)),
      /state is unknown/,
    );
    assert.throws(
      () => readFanoutChildRow(rowWithData({ ...good, causeKind: 'done' }, childId)),
      /causeKind is unknown/,
    );
    assert.throws(
      () =>
        readFanoutChildRow(
          rowWithData({ ...good, handler: 'other' }, childId),
        ),
      /parent\+handler\+record/,
    );
    assert.throws(
      () => readFanoutChildRow(rowWithData({ ...good }, 'wrong-id')),
      /row id must equal/,
    );
  });
});

describe('t34-f2 page queries', () => {
  const fanoutId = fanoutIntentRowId(OCC, HANDLER_COMMITMENT, 'model');

  it('builds bounded id-sorted page specs with and without a cursor', () => {
    assert.deepEqual(fanoutChildPageQuery(fanoutId, { cursor: null, limit: 128 }), {
      model: WORK_FANOUT_CHILD_MODEL,
      where: { op: 'eq', field: 'fanoutId', value: fanoutId },
      order: [{ field: 'id', direction: 'asc' }],
      limit: 128,
      authority: 'owner',
    });
    assert.deepEqual(fanoutChildPageQuery(fanoutId, { cursor: 'fanout-child/v1/a', limit: 7 }), {
      model: WORK_FANOUT_CHILD_MODEL,
      where: {
        op: 'and',
        args: [
          { op: 'eq', field: 'fanoutId', value: fanoutId },
          { op: 'gt', field: 'id', value: 'fanout-child/v1/a' },
        ],
      },
      order: [{ field: 'id', direction: 'asc' }],
      limit: 7,
      authority: 'owner',
    });
    assert.throws(() => fanoutChildPageQuery('', { cursor: null, limit: 10 }), KernelTableError);
    assert.throws(() => fanoutChildPageQuery(fanoutId, { cursor: '', limit: 10 }), /cursor/);
    assert.throws(() => fanoutChildPageQuery(fanoutId, { cursor: null, limit: 0 }), /limit/);
    assert.throws(() => fanoutChildPageQuery(fanoutId, { cursor: null, limit: 1.5 }), /limit/);
  });

  it('folds pages honestly: done only on a short page, resume otherwise', () => {
    const rows = (n: number): StoredRow[] =>
      Array.from({ length: n }, (_, index) => rowWithData({}, `id-${index}`));
    const short = fanoutChildPageResult(rows(3), 10);
    assert.deepEqual([short.done, short.cursor, short.rows.length], [true, null, 3]);
    const empty = fanoutChildPageResult([], 10);
    assert.deepEqual([empty.done, empty.cursor, empty.rows.length], [true, null, 0]);
    // A full page is NEVER complete: done:false means resume with the last id.
    const full = fanoutChildPageResult(rows(10), 10);
    assert.deepEqual([full.done, full.cursor, full.rows.length], [false, 'id-9', 10]);
    assert.throws(() => fanoutChildPageResult(rows(11), 10), /past limit/);
    assert.throws(() => fanoutChildPageResult(rows(1), 0), /limit/);
    assert.equal(WORK_FANOUT_INTENT_MODEL, 'work.fanout_intent');
    assert.equal(WORK_FANOUT_CHECKPOINT_MODEL, 'work.fanout_checkpoint');
    assert.equal(WORK_FANOUT_CHILD_MODEL, 'work.fanout_child');
  });
});

describe('t34-f2 memory store: intent insert-once', () => {
  it('commits the intent once and refuses any redefinition', async () => {
    const { store } = createTestMemoryStorage();
    const members = ['m-1', 'm-2', 'm-3'];
    const row = newFanoutIntentRow(
      { sourceOccurrence: OCC, handler: HANDLER_COMMITMENT, cohort: 'model', members },
      META,
    );
    await commitWrites(store, [{ kind: 'insert', model: WORK_FANOUT_INTENT_MODEL, row }]);
    const loaded = await store.load(WORK_FANOUT_INTENT_MODEL, row.id as RecordId);
    assert.ok(loaded !== null);
    assert.deepEqual(readFanoutIntentRow(loaded).members, members);
    // Same cutoff+cohort, same members: duplicate delivery replays, never mints.
    await assert.rejects(
      commitWrites(store, [{ kind: 'insert', model: WORK_FANOUT_INTENT_MODEL, row }]),
      (error: unknown) =>
        error instanceof StorageConstraintError && error.kind === 'unknown',
    );
    // Same cutoff+cohort, DIFFERENT members: the frozen set cannot be redefined.
    const redefined = newFanoutIntentRow(
      { sourceOccurrence: OCC, handler: HANDLER_COMMITMENT, cohort: 'model', members: ['m-9'] },
      META,
    );
    await assert.rejects(
      commitWrites(store, [{ kind: 'insert', model: WORK_FANOUT_INTENT_MODEL, row: redefined }]),
      StorageConstraintError,
    );
    const still = await store.load(WORK_FANOUT_INTENT_MODEL, row.id as RecordId);
    assert.ok(still !== null);
    assert.deepEqual(readFanoutIntentRow(still).members, members);
  });

  it('keeps distinct cutoffs, handlers and cohorts independent', async () => {
    const { store } = createTestMemoryStorage();
    const rows = [
      newFanoutIntentRow(
        { sourceOccurrence: OCC, handler: HANDLER_COMMITMENT, cohort: 'model', members: ['m-1'] },
        META,
      ),
      newFanoutIntentRow(
        { sourceOccurrence: OCC, handler: HANDLER_SWAP, cohort: 'model', members: ['m-1'] },
        META,
      ),
      newFanoutIntentRow(
        { sourceOccurrence: OCC, handler: HANDLER_COMMITMENT, cohort: 'anchored-collection', members: ['m-1'] },
        META,
      ),
      newFanoutIntentRow(
        { sourceOccurrence: 'occ_other', handler: HANDLER_COMMITMENT, cohort: 'model', members: ['m-1'] },
        META,
      ),
    ];
    await commitInserts(store, WORK_FANOUT_INTENT_MODEL, rows, 10);
    for (const row of rows) {
      const loaded = await store.load(WORK_FANOUT_INTENT_MODEL, row.id as RecordId);
      assert.ok(loaded !== null);
      assert.deepEqual(readFanoutIntentRow(loaded).fanoutId, row.id as string);
    }
  });
});

describe('t34-f2 memory store: checkpoint upsert', () => {
  it('inserts once then advances the completed set plus cursor by conditional update', async () => {
    const { store } = createTestMemoryStorage();
    const fanoutId = fanoutIntentRowId(OCC, HANDLER_COMMITMENT, 'model');
    const row = newFanoutCheckpointRow({ fanoutId }, META);
    await commitWrites(store, [{ kind: 'insert', model: WORK_FANOUT_CHECKPOINT_MODEL, row }]);
    await assert.rejects(
      commitWrites(store, [{ kind: 'insert', model: WORK_FANOUT_CHECKPOINT_MODEL, row }]),
      StorageConstraintError,
    );
    const advance = async (add: string[], cursor: string | null): Promise<StoredRow> => {
      const current = await store.load(WORK_FANOUT_CHECKPOINT_MODEL, fanoutId as RecordId);
      assert.ok(current !== null);
      const next = withRowData(
        current,
        { ...nextFanoutCheckpointData(readFanoutCheckpointRow(current), add, cursor) },
        { nowMs: META.nowMs + 1, actor: 't34-f2-test' },
        'work.fanout_checkpoint',
      );
      await commitWrites(store, [
        {
          kind: 'update',
          model: WORK_FANOUT_CHECKPOINT_MODEL,
          id: current.id,
          expectedVersion: current.version,
          row: next,
        },
      ]);
      return next;
    };
    const first = await advance(['c-2', 'c-1'], 'cursor-1');
    assert.deepEqual(readFanoutCheckpointRow(first), {
      fanoutId,
      completed: ['c-1', 'c-2'],
      cursor: 'cursor-1',
    });
    const second = await advance(['c-1', 'c-3'], null);
    assert.deepEqual(readFanoutCheckpointRow(second), {
      fanoutId,
      completed: ['c-1', 'c-2', 'c-3'],
      cursor: null,
    });
    // A stale expectedVersion loses the fence instead of silently merging.
    await assert.rejects(
      commitWrites(store, [
        {
          kind: 'update',
          model: WORK_FANOUT_CHECKPOINT_MODEL,
          id: first.id,
          expectedVersion: first.version,
          row: first,
        },
      ]),
      (error: unknown) =>
        error instanceof StorageConstraintError && error.kind === 'version',
    );
  });
});

describe('t34-f2 memory store: child rows and bounded paging', () => {
  function childRows(fanoutId: string, parent: string, handler: string, count: number): StoredRow[] {
    return Array.from({ length: count }, (_, index) =>
      newFanoutChildRow(
        {
          fanoutId,
          parentOccurrence: parent,
          handler,
          recordId: `rec-${String(index).padStart(4, '0')}`,
        },
        META,
      ),
    );
  }

  it('M1 proof cohorts 499/500/501/1000: every admitted identity visited exactly once', async () => {
    for (const count of [499, 500, 501, 1000]) {
      const { store } = createTestMemoryStorage();
      const fanoutId = fanoutIntentRowId(`occ_m1_${count}`, HANDLER_COMMITMENT, 'model');
      const rows = childRows(fanoutId, `occ_m1_${count}`, HANDLER_COMMITMENT, count);
      await commitInserts(store, WORK_FANOUT_CHILD_MODEL, rows, 250);
      const { ids, pages } = await collectChildIds(store, fanoutId, 128);
      assert.equal(ids.length, count);
      assert.equal(new Set(ids).size, count);
      assert.deepEqual(ids, [...ids].sort());
      assert.ok(pages > 1, `cohort ${count} must span pages at chunk 128`);
      // One row per admitted identity: the visited set equals the inserted set.
      assert.deepEqual(new Set(ids), new Set(rows.map((row) => row.id as string)));
    }
  });

  it('done:false means resume: an exact-multiple cohort ends with an honest empty page', async () => {
    const { store } = createTestMemoryStorage();
    const fanoutId = fanoutIntentRowId('occ_exact', HANDLER_COMMITMENT, 'model');
    await commitInserts(store, WORK_FANOUT_CHILD_MODEL, childRows(fanoutId, 'occ_exact', HANDLER_COMMITMENT, 4), 10);
    const first = fanoutChildPageResult(
      await store.query(fanoutChildPageQuery(fanoutId, { cursor: null, limit: 2 })),
      2,
    );
    assert.deepEqual([first.done, first.rows.length], [false, 2]);
    assert.ok(first.cursor !== null);
    const second = fanoutChildPageResult(
      await store.query(fanoutChildPageQuery(fanoutId, { cursor: first.cursor, limit: 2 })),
      2,
    );
    // Full but not last-known: still resume, never a complete label.
    assert.deepEqual([second.done, second.rows.length], [false, 2]);
    assert.ok(second.cursor !== null);
    const third = fanoutChildPageResult(
      await store.query(fanoutChildPageQuery(fanoutId, { cursor: second.cursor, limit: 2 })),
      2,
    );
    assert.deepEqual([third.done, third.rows.length, third.cursor], [true, 0, null]);
  });

  it('§C9 chunk size is not cohort size: every chunking visits the same identities', async () => {
    const { store } = createTestMemoryStorage();
    const fanoutId = fanoutIntentRowId('occ_chunk', HANDLER_COMMITMENT, 'model');
    await commitInserts(store, WORK_FANOUT_CHILD_MODEL, childRows(fanoutId, 'occ_chunk', HANDLER_COMMITMENT, 501), 250);
    const byOne = await collectChildIds(store, fanoutId, 1);
    const bySeven = await collectChildIds(store, fanoutId, 7);
    const byWhole = await collectChildIds(store, fanoutId, 5000);
    assert.equal(byOne.ids.length, 501);
    assert.deepEqual(bySeven.ids, byOne.ids);
    assert.deepEqual(byWhole.ids, byOne.ids);
    assert.deepEqual([byOne.pages > 500, byWhole.pages], [true, 1]);
  });

  it('scopes pages per fanout: sibling handlers and fanouts never leak rows', async () => {
    const { store } = createTestMemoryStorage();
    const commitmentFanout = fanoutIntentRowId(OCC, HANDLER_COMMITMENT, 'model');
    const swapFanout = fanoutIntentRowId(OCC, HANDLER_SWAP, 'model');
    await commitInserts(
      store,
      WORK_FANOUT_CHILD_MODEL,
      [
        ...childRows(commitmentFanout, OCC, HANDLER_COMMITMENT, 5),
        ...childRows(swapFanout, OCC, HANDLER_SWAP, 5),
      ],
      10,
    );
    const commitment = await collectChildIds(store, commitmentFanout, 128);
    const swap = await collectChildIds(store, swapFanout, 128);
    assert.equal(commitment.ids.length, 5);
    assert.equal(swap.ids.length, 5);
    assert.equal(new Set([...commitment.ids, ...swap.ids]).size, 10);
    for (const id of commitment.ids) {
      assert.ok(id.includes(encodeURIComponent(HANDLER_COMMITMENT)));
    }
  });

  it('rejects a duplicate child row under the same full identity', async () => {
    const { store } = createTestMemoryStorage();
    const fanoutId = fanoutIntentRowId(OCC, HANDLER_COMMITMENT, 'model');
    const row = newFanoutChildRow(
      { fanoutId, parentOccurrence: OCC, handler: HANDLER_COMMITMENT, recordId: 'rec-1' },
      META,
    );
    await commitWrites(store, [{ kind: 'insert', model: WORK_FANOUT_CHILD_MODEL, row }]);
    await assert.rejects(
      commitWrites(store, [{ kind: 'insert', model: WORK_FANOUT_CHILD_MODEL, row }]),
      StorageConstraintError,
    );
    // Same parent+record under the sibling handler is a distinct row.
    const sibling = newFanoutChildRow(
      { fanoutId, parentOccurrence: OCC, handler: HANDLER_SWAP, recordId: 'rec-1' },
      META,
    );
    await commitWrites(store, [{ kind: 'insert', model: WORK_FANOUT_CHILD_MODEL, row: sibling }]);
    const loaded = await store.load(WORK_FANOUT_CHILD_MODEL, row.id);
    assert.ok(loaded !== null);
    assert.equal(loaded.version, 1);
  });
});
