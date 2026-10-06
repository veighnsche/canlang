/**
 * T34-F2 durable proofs on REAL substrates: the fanout intent,
 * checkpoint and child-row shapes commit, conflict, upsert and page
 * identically on real local D1 (miniflare) and real workerd DO
 * SQLite, reached through the established state-side harness
 * patterns (the T24a-durable/T31 miniflare-D1 setup plus the
 * `do-test-worker.js` StoragePort proxy, reused read-only).
 *
 * miniflare itself is NOT a `@canlang/work` dependency: this suite
 * loads it through a require anchored at the `@canlang/state`
 * package, which owns the durable harness. If that anchor ever
 * stops resolving, these tests fail loudly instead of silently
 * falling back to memory — durability is never claimed off a
 * weaker substrate.
 *
 * Process-restart survival is explicitly UNCLAIMED (the harness
 * holds ephemeral instances; no persist channel is asserted):
 * crash-at-boundary resume belongs to F4/F8 (M2). Single-owner
 * scope only: cross-store atomicity is NOT claimed and must not be
 * inferred.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type {
  CommitBatch,
  DomainWrite,
  ModelName,
  QuerySpec,
  RecordId,
  Revision,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import {
  FenceConflictError,
  StorageConstraintError,
} from '@canlang/state/storage/port';
import {
  WORK_FANOUT_CHECKPOINT_MODEL,
  WORK_FANOUT_CHILD_MODEL,
  WORK_FANOUT_INTENT_MODEL,
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
} from './tables.js';

const META = { nowMs: 1_758_000_000_000, actor: 't34-f2-durable' };
const OCC = 'occ_durable_1';
const HANDLER_COMMITMENT = 'Shift.review_commitment';
const HANDLER_SWAP = 'Shift.review_swap';

/* -- miniflare is declared by the owning work test package. -- */

const stateRequire = createRequire(import.meta.url);

interface MiniflareHandle {
  getD1Database(name: string): Promise<unknown>;
  dispatchFetch(
    input: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ json(): Promise<unknown> }>;
  dispose(): Promise<void>;
}

type MiniflareCtor = new (opts: Record<string, unknown>) => MiniflareHandle;

const { Miniflare } = stateRequire('miniflare') as { Miniflare: MiniflareCtor };

type D1Handle = Parameters<typeof createD1Storage>[0];

/* -- Substrate handles: real local D1 + real workerd DO SQLite. -- */

let d1mf: MiniflareHandle | undefined;
let d1db: D1Handle;

const D1_TABLES = [
  'records',
  'history',
  'receipts',
  'outbox',
  'schedules',
  'unique_claims',
  'snapshots',
  'migration_staging',
  'migration_progress',
  'migration_outcomes',
];

async function resetD1(): Promise<void> {
  const db = d1db as {
    batch(statements: unknown[]): Promise<unknown>;
    prepare(sql: string): unknown;
  };
  await db.batch([
    ...D1_TABLES.map((table) => db.prepare(`DELETE FROM ${table}`)),
    db.prepare('DELETE FROM fence_log'),
    db.prepare('UPDATE fence SET revision = 0 WHERE id = 1'),
  ]);
}

/** State-owned DO proxy worker, reused read-only (never edited here). */
const doWorkerPath = fileURLToPath(
  new URL(import.meta.resolve('@canlang/state/testing/storage/do-test-worker')),
);

/**
 * workerd mounts its module filesystem at the miniflare host's
 * process CWD (the `rootPath` option does NOT move it — verified by
 * probe: only the CWD decides). The reused DO worker's relative
 * `../../dist/...` adapter import resolves under `@canlang/state`,
 * so this suite anchors the process CWD at the state package for
 * the run and restores it afterwards. node:test runs each file in
 * its own process, so the anchor cannot leak into other suites;
 * every path in this file is import.meta-derived absolute, so the
 * anchor moves nothing but the workerd mount. Without it workerd
 * fatals with "can't use .. to break out of starting directory"
 * whenever the suite is invoked from `@canlang/work`.
 */
const stateDirPath = fileURLToPath(new URL('../../', import.meta.resolve('@canlang/state/distribution')));
const entryCwd = process.cwd();

let doMf: MiniflareHandle | undefined;

interface WorkerErrorJson {
  readonly name: string;
  readonly message: string;
  readonly kind?: string;
  readonly detail?: string;
  readonly expected?: number;
  readonly actual?: number | null;
}

function rehydrate(error: WorkerErrorJson): Error {
  if (error.name === 'FenceConflictError') {
    return new FenceConflictError(
      error.expected as unknown as Revision,
      (error.actual ?? null) as unknown as Revision | null,
    );
  }
  if (error.name === 'StorageConstraintError') {
    return new StorageConstraintError(
      (error.kind ?? 'unknown') as StorageConstraintError['kind'],
      error.detail ?? error.message,
    );
  }
  const rebuilt = new Error(error.message);
  rebuilt.name = error.name;
  return rebuilt;
}

async function doPost(path: string, body: unknown): Promise<Record<string, unknown>> {
  if (doMf === undefined) {
    throw new Error('do miniflare is not started');
  }
  const response = await doMf.dispatchFetch(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

async function doCall<T>(method: string, ...args: ReadonlyArray<unknown>): Promise<T> {
  const data = await doPost('/call', { method, args });
  if (data['ok'] !== true) {
    throw rehydrate(data['error'] as unknown as WorkerErrorJson);
  }
  return data['value'] as T;
}

async function resetDO(): Promise<void> {
  const data = await doPost('/reset', {});
  if (data['ok'] !== true) {
    throw rehydrate(data['error'] as unknown as WorkerErrorJson);
  }
}

function doProxy(): StoragePort {
  return {
    readRevision: () => doCall('readRevision'),
    load: (model: ModelName, id: RecordId) => doCall('load', model, id),
    query: (spec: QuerySpec) => doCall('query', spec),
    commit: (batch: CommitBatch) => doCall('commit', batch),
  } as StoragePort;
}

before(async () => {
  process.chdir(stateDirPath);
  d1mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: ['DB'],
  });
  d1db = (await d1mf.getD1Database('DB')) as D1Handle;
  await ensureSchema(d1db);
  await resetD1();

  doMf = new Miniflare({
    modules: true,
    scriptPath: doWorkerPath,
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    compatibilityDate: '2025-01-01',
    durableObjects: {
      TEST_DO: { className: 'TestDO', useSQLite: true, unsafePreventEviction: true },
    },
  });
  await resetDO();
});

after(async () => {
  try {
    if (doMf !== undefined) {
      await doMf.dispose();
      doMf = undefined;
    }
    if (d1mf !== undefined) {
      await d1mf.dispose();
      d1mf = undefined;
    }
  } finally {
    process.chdir(entryCwd);
  }
});

/* -- Shared per-substrate suite. -- */

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

function isUnknownConstraint(error: unknown): boolean {
  return error instanceof StorageConstraintError && error.kind === 'unknown';
}

function durableSuite(name: string, setup: () => Promise<{ store: StoragePort; reset: () => Promise<void> }>): void {
  describe(`t34-f2 durable fanout tables on ${name}`, () => {
    it('commits the intent once and refuses any redefinition of the frozen set', async () => {
      const { store, reset } = await setup();
      await reset();
      const members = ['m-1', 'm-2', 'm-3'];
      const row = newFanoutIntentRow(
        { sourceOccurrence: OCC, handler: HANDLER_COMMITMENT, cohort: 'model', members },
        META,
      );
      await commitWrites(store, [{ kind: 'insert', model: WORK_FANOUT_INTENT_MODEL, row }]);
      const loaded = await store.load(WORK_FANOUT_INTENT_MODEL, row.id);
      assert.ok(loaded !== null);
      assert.deepEqual(readFanoutIntentRow(loaded).members, members);
      await assert.rejects(
        commitWrites(store, [{ kind: 'insert', model: WORK_FANOUT_INTENT_MODEL, row }]),
        isUnknownConstraint,
      );
      const redefined = newFanoutIntentRow(
        { sourceOccurrence: OCC, handler: HANDLER_COMMITMENT, cohort: 'model', members: ['m-9'] },
        META,
      );
      await assert.rejects(
        commitWrites(store, [{ kind: 'insert', model: WORK_FANOUT_INTENT_MODEL, row: redefined }]),
        isUnknownConstraint,
      );
      const still = await store.load(WORK_FANOUT_INTENT_MODEL, row.id);
      assert.ok(still !== null);
      assert.deepEqual(readFanoutIntentRow(still).members, members);
    });

    it('upserts the checkpoint: completed-set plus cursor under the version fence', async () => {
      const { store, reset } = await setup();
      await reset();
      const fanoutId = fanoutIntentRowId(OCC, HANDLER_COMMITMENT, 'model');
      const row = newFanoutCheckpointRow({ fanoutId }, META);
      await commitWrites(store, [{ kind: 'insert', model: WORK_FANOUT_CHECKPOINT_MODEL, row }]);
      await assert.rejects(
        commitWrites(store, [{ kind: 'insert', model: WORK_FANOUT_CHECKPOINT_MODEL, row }]),
        isUnknownConstraint,
      );
      const advance = async (add: string[], cursor: string | null): Promise<StoredRow> => {
        const current = await store.load(WORK_FANOUT_CHECKPOINT_MODEL, fanoutId as RecordId);
        assert.ok(current !== null);
        const next = withRowData(
          current,
          { ...nextFanoutCheckpointData(readFanoutCheckpointRow(current), add, cursor) },
          { nowMs: META.nowMs + 1, actor: 't34-f2-durable' },
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
      assert.deepEqual(readFanoutCheckpointRow(first).completed, ['c-1', 'c-2']);
      const second = await advance(['c-3'], null);
      assert.deepEqual(readFanoutCheckpointRow(second), {
        fanoutId,
        completed: ['c-1', 'c-2', 'c-3'],
        cursor: null,
      });
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

    it('keys child rows by the full parent+handler+record identity', async () => {
      const { store, reset } = await setup();
      await reset();
      const fanoutId = fanoutIntentRowId(OCC, HANDLER_COMMITMENT, 'model');
      const row = newFanoutChildRow(
        { fanoutId, parentOccurrence: OCC, handler: HANDLER_COMMITMENT, recordId: 'rec-1' },
        META,
      );
      await commitWrites(store, [{ kind: 'insert', model: WORK_FANOUT_CHILD_MODEL, row }]);
      await assert.rejects(
        commitWrites(store, [{ kind: 'insert', model: WORK_FANOUT_CHILD_MODEL, row }]),
        isUnknownConstraint,
      );
      // Same parent+record under the sibling handler is a distinct durable row.
      const sibling = newFanoutChildRow(
        { fanoutId, parentOccurrence: OCC, handler: HANDLER_SWAP, recordId: 'rec-1' },
        META,
      );
      assert.notEqual(
        fanoutChildRowId(OCC, HANDLER_COMMITMENT, 'rec-1'),
        fanoutChildRowId(OCC, HANDLER_SWAP, 'rec-1'),
      );
      await commitWrites(store, [{ kind: 'insert', model: WORK_FANOUT_CHILD_MODEL, row: sibling }]);
      const loaded = await store.load(WORK_FANOUT_CHILD_MODEL, row.id);
      assert.ok(loaded !== null);
      assert.deepEqual(readFanoutChildRow(loaded).recordId, 'rec-1');
    });

    it('M1 proof cohorts 499/500/501/1000 page completely with one row each', async () => {
      const { store, reset } = await setup();
      for (const count of [499, 500, 501, 1000]) {
        await reset();
        const parent = `occ_m1_${name}_${count}`;
        const fanoutId = fanoutIntentRowId(parent, HANDLER_COMMITMENT, 'model');
        const rows = childRows(fanoutId, parent, HANDLER_COMMITMENT, count);
        await commitInserts(store, WORK_FANOUT_CHILD_MODEL, rows, 250);
        const { ids, pages } = await collectChildIds(store, fanoutId, 128);
        assert.equal(ids.length, count);
        assert.equal(new Set(ids).size, count);
        assert.deepEqual(ids, [...ids].sort());
        assert.ok(pages > 1, `${name} cohort ${count} must span pages at chunk 128`);
        assert.deepEqual(new Set(ids), new Set(rows.map((row) => row.id as string)));
      }
    });

    it('done:false means resume across the exact-multiple boundary', async () => {
      const { store, reset } = await setup();
      await reset();
      const fanoutId = fanoutIntentRowId(`occ_exact_${name}`, HANDLER_COMMITMENT, 'model');
      await commitInserts(
        store,
        WORK_FANOUT_CHILD_MODEL,
        childRows(fanoutId, `occ_exact_${name}`, HANDLER_COMMITMENT, 4),
        10,
      );
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
      assert.deepEqual([second.done, second.rows.length], [false, 2]);
      assert.ok(second.cursor !== null);
      const third = fanoutChildPageResult(
        await store.query(fanoutChildPageQuery(fanoutId, { cursor: second.cursor, limit: 2 })),
        2,
      );
      assert.deepEqual([third.done, third.rows.length, third.cursor], [true, 0, null]);
    });

    it('§C9 chunk size is not cohort size on this substrate', async () => {
      const { store, reset } = await setup();
      await reset();
      const fanoutId = fanoutIntentRowId(`occ_chunk_${name}`, HANDLER_COMMITMENT, 'model');
      await commitInserts(
        store,
        WORK_FANOUT_CHILD_MODEL,
        childRows(fanoutId, `occ_chunk_${name}`, HANDLER_COMMITMENT, 501),
        250,
      );
      const byOne = await collectChildIds(store, fanoutId, 1);
      const bySeven = await collectChildIds(store, fanoutId, 7);
      const byWhole = await collectChildIds(store, fanoutId, 5000);
      assert.equal(byOne.ids.length, 501);
      assert.deepEqual(bySeven.ids, byOne.ids);
      assert.deepEqual(byWhole.ids, byOne.ids);
    });

    it('scopes pages per fanout: sibling handlers never leak rows', async () => {
      const { store, reset } = await setup();
      await reset();
      const commitmentFanout = fanoutIntentRowId(`occ_scope_${name}`, HANDLER_COMMITMENT, 'model');
      const swapFanout = fanoutIntentRowId(`occ_scope_${name}`, HANDLER_SWAP, 'model');
      await commitInserts(
        store,
        WORK_FANOUT_CHILD_MODEL,
        [
          ...childRows(commitmentFanout, `occ_scope_${name}`, HANDLER_COMMITMENT, 5),
          ...childRows(swapFanout, `occ_scope_${name}`, HANDLER_SWAP, 5),
        ],
        10,
      );
      const commitment = await collectChildIds(store, commitmentFanout, 128);
      const swap = await collectChildIds(store, swapFanout, 128);
      assert.equal(commitment.ids.length, 5);
      assert.equal(swap.ids.length, 5);
      assert.equal(new Set([...commitment.ids, ...swap.ids]).size, 10);
    });
  });
}

durableSuite('real D1', async () => ({ store: createD1Storage(d1db), reset: resetD1 }));
durableSuite('real DO SQLite', async () => ({ store: doProxy(), reset: resetDO }));
