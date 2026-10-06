/**
 * B5 canonical-containment durable proofs (colocated): the declared-parent
 * enforcement from `b5-contained-parity.test.ts` against REAL local
 * durable substrates — miniflare D1 and workerd Durable Object SQLite —
 * never memory doubles. Per substrate: a same-batch imported parent+child
 * (`expenses.Expense in employee.Employee`) co-commits atomically with a
 * resolvable reverse parent collection, and a wrong-model parent fails
 * `validation` with NOTHING committed (parent rolled back at the durable
 * fence, not just in memory).
 *
 * Only the membership reader stays a memory double (same boundary as the
 * T18/B1 durable suites). Process-restart survival is UNCLAIMED here;
 * restart read proofs ride in the B2 suite.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type {
  ModelName,
  OperationName,
  RecordId,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import { buildModelTable, type ModelTable } from './models.js';
import { runMutationWrites, type MutationWritesResult } from './pipeline.js';
import { buildContext } from '../invocation/context.js';
import { createD1Storage, ensureSchema } from '../storage/d1.js';
import {
  FIXED_NOW,
  asModel,
  captureStateError,
  createMemoryIdentityStore,
  makeBatch,
  makeIdentity,
  seedMember,
  uuidv7,
  type SeededMember,
  type TestMembershipStore,
} from '../../test/invocation/fixtures.js';
import { field, modelDef } from '../../test/mutation/fixtures.js';

const APP = 'acme-app';
const EMPLOYEE = asModel('employee.Employee');
const EXPENSE = asModel('expenses.Expense');
const CHECKLIST = asModel('onboard.Checklist');

/* -- Substrate handles: real local D1 + real workerd DO SQLite. -- */

let d1mf: Miniflare | undefined;
let d1db: D1Database;

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
  await d1db.batch([
    ...D1_TABLES.map((table) => d1db.prepare(`DELETE FROM ${table}`)),
    d1db.prepare('DELETE FROM fence_log'),
    d1db.prepare('UPDATE fence SET revision = 0 WHERE id = 1'),
  ]);
}

const doWorkerPath = fileURLToPath(
  new URL('../../../test/storage/do-test-worker.js', import.meta.url),
);

let doMf: Miniflare | undefined;

interface WorkerErrorJson {
  readonly name: string;
  readonly message: string;
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

function rehydrate(error: WorkerErrorJson): Error {
  const rebuilt = new Error(error.message);
  rebuilt.name = error.name;
  return rebuilt;
}

async function doCall<T>(method: string, ...args: ReadonlyArray<unknown>): Promise<T> {
  const data = await doPost('/call', { method, args });
  if (data['ok'] !== true) {
    throw rehydrate(data['error'] as unknown as WorkerErrorJson);
  }
  return data['value'] as T;
}

function doProxy(): StoragePort {
  return {
    readRevision: () => doCall('readRevision'),
    load: (model: ModelName, id: RecordId) => doCall('load', model, id),
    query: (spec) => doCall('query', spec),
    commit: (batch) => doCall('commit', batch),
    readReceipt: (identity) => doCall('readReceipt', identity),
    outboxPending: () => doCall('outboxPending'),
    scheduleGet: (key) => doCall('scheduleGet', key),
    schedulesDue: (now, limit) => doCall('schedulesDue', now, limit),
    historyFor: (model, recordId) => doCall('historyFor', model, recordId),
    readInstalledSnapshot: (owner) => doCall('readInstalledSnapshot', owner),
    readMigrationProgress: (migrationId) => doCall('readMigrationProgress', migrationId),
    readStagedRows: (migrationId, cursor, limit) =>
      doCall('readStagedRows', migrationId, cursor, limit),
    stageMigrationRows: (input) => doCall('stageMigrationRows', input),
    publishMigrationChunk: (input) => doCall('publishMigrationChunk', input),
    flipInstalledSnapshot: (input) => doCall('flipInstalledSnapshot', input),
    readMigrationOutcomes: (migrationId) => doCall('readMigrationOutcomes', migrationId),
    recordMigrationFailure: (input) => doCall('recordMigrationFailure', input),
    discardStagedRows: (input) => doCall('discardStagedRows', input),
    readMigrationFailure: (migrationId) => doCall('readMigrationFailure', migrationId),
  };
}

async function resetDO(): Promise<void> {
  const data = await doPost('/reset', {});
  if (data['ok'] !== true) {
    throw rehydrate(data['error'] as unknown as WorkerErrorJson);
  }
}

before(async () => {
  d1mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: ['DB'],
  });
  d1db = await d1mf.getD1Database('DB');
  await ensureSchema(d1db);

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
  if (d1mf !== undefined) {
    await d1mf.dispose();
    d1mf = undefined;
  }
  if (doMf !== undefined) {
    await doMf.dispose();
    doMf = undefined;
  }
});

/* -- B5 durable world over one substrate handle. -- */

function importedTable(): ModelTable {
  return buildModelTable([
    {
      ...modelDef('employee.Employee', { fields: { name: field() } }),
      containment: {},
    },
    {
      ...modelDef('expenses.Expense', { fields: { title: field() } }),
      containment: { parent: EMPLOYEE },
    },
    {
      ...modelDef('onboard.Checklist', { fields: { title: field() } }),
      containment: { parent: EMPLOYEE },
    },
  ]);
}

interface B5DurableWorld {
  readonly store: StoragePort;
  readonly memberships: TestMembershipStore;
  readonly alice: SeededMember;
  readonly table: ModelTable;
}

async function setupDurableWorld(store: StoragePort): Promise<B5DurableWorld> {
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  return { store, memberships, alice, table: importedTable() };
}

let b5dSeq = 32000;

function nextOperationId(): string {
  b5dSeq += 1;
  return uuidv7(FIXED_NOW, b5dSeq);
}

async function stageBatch(
  world: B5DurableWorld,
  writes: [
    {
      readonly op: 'create';
      readonly model: ModelName;
      readonly id: RecordId;
      readonly parent?: { readonly model: ModelName; readonly id: RecordId };
      readonly data?: Record<string, unknown>;
    },
    ...Array<{
      readonly op: 'create';
      readonly model: ModelName;
      readonly id: RecordId;
      readonly parent?: { readonly model: ModelName; readonly id: RecordId };
      readonly data?: Record<string, unknown>;
    }>,
  ],
): Promise<MutationWritesResult> {
  const context = buildContext({
    identity: makeIdentity({ membership: world.alice.membership, email: world.alice.user.email }),
    operation: 'Acme.RunScenario' as OperationName,
    operationId: nextOperationId(),
    app: APP,
    source: 'test',
    now: FIXED_NOW,
  });
  return runMutationWrites({ table: world.table, writes, context, store: world.store });
}

async function commitStaged(
  world: B5DurableWorld,
  output: MutationWritesResult,
): Promise<void> {
  const revision = await world.store.readRevision();
  await world.store.commit(
    makeBatch(revision as number, {
      writes: [...output.writes],
      history: [...output.history],
      uniqueClaims: [...output.uniqueClaims],
      uniqueReleases: [...output.uniqueReleases],
    }),
  );
}

for (const substrate of [
  { name: 'd1', open: () => createD1Storage(d1db), reset: resetD1 },
  { name: 'durable-object', open: () => doProxy(), reset: resetDO },
] as const) {
  describe(`B5 contained parity durable (${substrate.name})`, () => {
    it('co-commits an imported parent+child batch with a resolvable collection', async () => {
      await substrate.reset();
      const world = await setupDurableWorld(substrate.open());
      const output = await stageBatch(world, [
        { op: 'create', model: EMPLOYEE, id: 'e-1' as RecordId, data: { name: 'ada' } },
        {
          op: 'create',
          model: EXPENSE,
          id: 'x-1' as RecordId,
          parent: { model: EMPLOYEE, id: 'e-1' as RecordId },
          data: { title: 'lunch' },
        },
      ]);
      await commitStaged(world, output);
      const parent = await world.store.load(EMPLOYEE, 'e-1' as RecordId);
      const child = (await world.store.load(EXPENSE, 'x-1' as RecordId)) as StoredRow;
      assert.ok(parent !== null);
      assert.deepEqual(child.parent, { model: EMPLOYEE, id: 'e-1' });
      const children = await world.store.query({
        model: EXPENSE,
        parent: { model: EMPLOYEE, id: 'e-1' as RecordId },
        authority: 'owner',
      });
      assert.deepEqual(
        children.map((row) => row.id),
        ['x-1'],
      );
    });

    it('rejects a wrong-model parent with nothing committed', async () => {
      await substrate.reset();
      const world = await setupDurableWorld(substrate.open());
      const error = await captureStateError(
        stageBatch(world, [
          { op: 'create', model: EMPLOYEE, id: 'e-1' as RecordId, data: { name: 'ada' } },
          {
            op: 'create',
            model: EXPENSE,
            id: 'x-1' as RecordId,
            parent: { model: CHECKLIST, id: 'c-9' as RecordId },
            data: { title: 'lunch' },
          },
        ]),
      );
      assert.equal(error.code, 'validation');
      assert.equal(
        error.message,
        'Invalid parent for model "expenses.Expense": expected parent model "employee.Employee".',
      );
      assert.equal(await world.store.load(EMPLOYEE, 'e-1' as RecordId), null);
    });
  });
}
