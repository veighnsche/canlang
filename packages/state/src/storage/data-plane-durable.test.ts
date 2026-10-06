/**
 * T17a durable data-plane tests (colocated): the migrated data plane
 * (canonical invoke + `invokeRead` + receipts/history/replay) running
 * against REAL local durable substrates — miniflare D1 and workerd
 * Durable Object SQLite — never memory doubles. The fence, the batch
 * atomicity, and the stored rows/history/receipts below are the real
 * SQLite substrates'; only the membership reader stays a memory double
 * (the durable claim covers the state store, not identity).
 *
 * Per substrate: end-to-end migration (create/read/update/delete/replay/
 * history/projection with cross-handle read-back), fence exactly-once
 * under concurrent duplicate delivery, commit-failure rollback, and
 * rejected-only bookkeeping. Process-restart survival is explicitly
 * UNCLAIMED in this slice (the harness holds ephemeral instances; no
 * persist channel is asserted).
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type {
  ArtifactModel,
  ArtifactOperation,
  ArtifactOperationInput,
} from '@canlang/contracts';
import type {
  ModelName,
  RecordId,
  Revision,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import {
  loadArtifactDescriptors,
  type ArtifactDescriptorSlice,
  type LoadDescriptorSetOptions,
} from '../invocation/registry.js';
import { buildModelTableFromCanonical, type ModelTable } from '../mutation/models.js';
import { generatedCrudExecute } from '../mutation/crud.js';
import { createD1Storage, ensureSchema } from './d1.js';
import { FenceConflictError, StorageConstraintError } from './port.js';
import { createInvoker, createReadInvoker } from '../ports/transact.js';
import { buildPolicyTable, type PolicyTable } from '../policy/grants.js';
import {
  FIXED_NOW,
  asId,
  asModel,
  asOperation,
  asOperationId,
  captureStateError,
  createMemoryIdentityStore,
  makeEnvelope,
  makeIdentity,
  seedMember,
  uuidv7,
  type SeededMember,
  type TestMembershipStore,
} from '../../test/invocation/fixtures.js';

const APP = 'acme-app';
const GADGET = 'Shop.Gadget';

/* -- Compact Gadget slice (CRUD + no-input read, unique code, archive). -- */

function scalarInput(name: string, kind: 'string' | 'integer', required: boolean) {
  return { name, field: { kind }, required } as ArtifactOperationInput;
}

function durableSlice(): ArtifactDescriptorSlice {
  const gadget: ArtifactModel = {
    name: GADGET,
    fields: [
      { name: 'title', field: { kind: 'string' }, required: true, serverOnly: false },
      {
        name: 'stock',
        field: { kind: 'integer' },
        required: false,
        serverOnly: false,
        default: { kind: 'literal', value: '0' },
      },
      { name: 'code', field: { kind: 'string' }, required: true, serverOnly: false },
    ],
    deleteMode: 'archive',
    uniqueKeys: ['code'],
  };
  const gadgetInputs: ArtifactOperationInput[] = [
    scalarInput('title', 'string', true),
    scalarInput('stock', 'integer', false),
    scalarInput('code', 'string', true),
  ];
  const operations: ArtifactOperation[] = [
    { name: `${GADGET}.create`, kind: 'create', description: '', inputs: { fields: gadgetInputs } },
    {
      name: `${GADGET}.update`,
      kind: 'update',
      description: '',
      inputs: {
        fields: [
          { name: 'record', field: { kind: 'ref', model: GADGET, requireVersion: true }, required: true },
          ...gadgetInputs.map((field) => ({ ...field, required: false })),
        ],
      },
    },
    {
      name: `${GADGET}.delete`,
      kind: 'delete',
      description: '',
      inputs: {
        fields: [
          { name: 'record', field: { kind: 'ref', model: GADGET, requireVersion: true }, required: true },
        ],
      },
    },
    { name: `${GADGET}.read`, kind: 'read', description: '', inputs: { fields: [] } },
  ];
  return { artifact_version: 1, operations, models: [gadget] };
}

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
  readonly kind?: string;
  readonly detail?: string;
  readonly expected?: number;
  readonly actual?: number | null;
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

/* -- Data plane bound over one durable store. -- */

interface DurablePlane {
  store: StoragePort;
  secondHandle: () => StoragePort;
  memberships: TestMembershipStore;
  alice: SeededMember;
  table: ModelTable;
  mutate: (
    operation: string,
    inputs: Record<string, unknown>,
    operationId: string,
  ) => Promise<{ status: string; operation_id: string; result: unknown }>;
  read: () => Promise<{ records: Array<{ id: unknown; data: unknown }>; revision: number }>;
}

async function setupDurablePlane(
  store: StoragePort,
  secondHandle: () => StoragePort,
  when?: LoadDescriptorSetOptions['when'],
): Promise<DurablePlane> {
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const loaded = loadArtifactDescriptors(durableSlice(), {
    by: 'members',
    ...(when !== undefined ? { when } : {}),
  });
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs });
  const policy: PolicyTable = buildPolicyTable([
    {
      model: asModel(GADGET),
      secretFields: [],
      grants: [{ by: 'members', fields: ['title', 'code', 'stock'] }],
    },
  ]);
  const execute = generatedCrudExecute({ table, store });
  const invoker = createInvoker({
    registry: loaded.registry,
    store,
    memberships,
    clock: { nowMs: () => FIXED_NOW },
  });
  const reader = createReadInvoker({ registry: loaded.registry, policy, store, memberships });
  const identity = makeIdentity({ membership: alice.membership, email: alice.user.email });
  return {
    store,
    secondHandle,
    memberships,
    alice,
    table,
    mutate: async (operation, inputs, operationId) => {
      const result = await invoker({
        envelope: makeEnvelope(operation, operationId, inputs),
        identity,
        app: APP,
        source: 'test',
        execute,
      });
      return {
        status: result.status,
        operation_id: result.operation_id as string,
        result: result.result,
      };
    },
    read: async () => {
      const served = await reader({ envelope: { operation: `${GADGET}.read`, inputs: {} }, identity });
      return {
        records: served.records.map((record) => ({ id: record.id, data: record.data })),
        revision: served.revision as number,
      };
    },
  };
}

function durableSuite(
  name: string,
  handles: () => Promise<{ store: StoragePort; secondHandle: () => StoragePort; reset: () => Promise<void> }>,
): void {
  describe(`T17a durable data plane (${name})`, () => {
    it('migrates end to end on the real substrate with cross-handle read-back', async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const plane = await setupDurablePlane(store, secondHandle);
      const created = await plane.mutate(
        `${GADGET}.create`,
        { title: 'drill', code: 'D-1' },
        uuidv7(FIXED_NOW, 9101),
      );
      assert.equal(created.status, 'committed');
      const id = (created.result as StoredRow).id as string;

      const seen = await plane.read();
      assert.equal(seen.revision, 1);
      assert.deepEqual(seen.records, [{ id, data: { title: 'drill', code: 'D-1', stock: '0' } }]);

      // The SUBSTRATE holds the state: a second adapter handle over the
      // same database reads the committed row, revision, and receipt.
      const other = secondHandle();
      assert.equal(await other.readRevision(), 1);
      const reread = await other.load(asModel(GADGET), asId(id));
      assert.equal(reread?.version, 1);
      assert.deepEqual(reread?.data, { title: 'drill', code: 'D-1', stock: '0' });
      const receipt = await other.readReceipt({
        app: APP,
        owner: plane.alice.team.team_id,
        principal: plane.alice.user.user_id,
        operation: asOperation(`${GADGET}.create`),
        operationId: asOperationId(created.operation_id),
      });
      assert.ok(receipt);
      assert.equal(receipt.outcome.status, 'committed');

      const updated = await plane.mutate(
        `${GADGET}.update`,
        { record: { id, version: '1' }, stock: '7' },
        uuidv7(FIXED_NOW, 9102),
      );
      assert.equal((updated.result as StoredRow).version, 2);
      const removed = await plane.mutate(
        `${GADGET}.delete`,
        { record: { id, version: '2' } },
        uuidv7(FIXED_NOW, 9103),
      );
      assert.equal((removed.result as StoredRow).archivedAt, FIXED_NOW);

      const replayed = await plane.mutate(
        `${GADGET}.create`,
        { title: 'drill', code: 'D-1' },
        created.operation_id,
      );
      assert.equal(replayed.status, 'replayed');
      assert.deepEqual(replayed.result, created.result);
      assert.equal(await store.readRevision(), 3);

      const trail = await store.historyFor(asModel(GADGET), asId(id));
      assert.deepEqual(
        trail.map((entry) => [entry.change, entry.version]),
        [
          ['create', 1],
          ['update', 2],
          ['archive', 3],
        ],
      );
      assert.deepEqual(await store.outboxPending(), []);
    });

    it('admits exactly one winner under concurrent duplicate delivery', async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const plane = await setupDurablePlane(store, secondHandle);
      const operationId = uuidv7(FIXED_NOW, 9201);
      const inputs = { title: 'race', code: 'D-2' };
      const [one, two] = await Promise.all([
        plane.mutate(`${GADGET}.create`, inputs, operationId),
        plane.mutate(`${GADGET}.create`, inputs, operationId),
      ]);
      assert.deepEqual([one.status, two.status].sort(), ['committed', 'replayed']);
      const committed = one.status === 'committed' ? one : two;
      const replayed = one.status === 'replayed' ? one : two;
      assert.deepEqual(replayed.result, committed.result);
      assert.equal(await store.readRevision(), 1);
      const rows = await store.query({ model: asModel(GADGET), authority: 'owner' });
      assert.equal(rows.length, 1);
    });

    it('rolls commit-time unique conflicts back with nothing persisted', async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const plane = await setupDurablePlane(store, secondHandle);
      await plane.mutate(`${GADGET}.create`, { title: 'a', code: 'D-3' }, uuidv7(FIXED_NOW, 9301));
      const revisionBefore = await store.readRevision();

      const operationId = uuidv7(FIXED_NOW, 9302);
      const dupe = await captureStateError(
        plane.mutate(`${GADGET}.create`, { title: 'b', code: 'D-3' }, operationId),
      );
      assert.equal(dupe.code, 'conflict');
      assert.equal(await store.readRevision(), revisionBefore);
      const rows = await store.query({ model: asModel(GADGET), authority: 'owner' });
      assert.equal(rows.length, 1);
      assert.equal(
        await store.readReceipt({
          app: APP,
          owner: plane.alice.team.team_id,
          principal: plane.alice.user.user_id,
          operation: asOperation(`${GADGET}.create`),
          operationId: asOperationId(operationId),
        }),
        null,
      );
    });

    it('persists rejected-only bookkeeping for execute-time rejections', async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const plane = await setupDurablePlane(store, secondHandle, (op) =>
        (op.name as string) === `${GADGET}.update`
          ? { op: 'eq', field: 'stock', value: '0' }
          : undefined,
      );
      const created = await plane.mutate(
        `${GADGET}.create`,
        { title: 'drill', code: 'D-4', stock: '5' },
        uuidv7(FIXED_NOW, 9401),
      );
      const id = (created.result as StoredRow).id as string;
      const revisionBefore = await store.readRevision();

      const operationId = uuidv7(FIXED_NOW, 9402);
      const failed = await captureStateError(
        plane.mutate(
          `${GADGET}.update`,
          { record: { id, version: '1' }, title: 'still-five' },
          operationId,
        ),
      );
      assert.equal(failed.code, 'rule_failed');
      assert.equal(await store.readRevision(), (revisionBefore as number) + 1);
      // Domain row and history unchanged; only the rejected receipt landed.
      const row = await store.load(asModel(GADGET), asId(id));
      assert.equal(row?.version, 1);
      assert.deepEqual(row?.data, { title: 'drill', code: 'D-4', stock: '5' });
      const trail = await store.historyFor(asModel(GADGET), asId(id));
      assert.equal(trail.length, 1);
      const receipt = await store.readReceipt({
        app: APP,
        owner: plane.alice.team.team_id,
        principal: plane.alice.user.user_id,
        operation: asOperation(`${GADGET}.update`),
        operationId: asOperationId(operationId),
      });
      assert.deepEqual(receipt?.outcome, {
        status: 'rejected',
        code: 'rule_failed',
        message: failed.message,
      });
    });
  });
}

durableSuite('d1', async () => ({
  store: createD1Storage(d1db),
  secondHandle: () => createD1Storage(d1db),
  reset: resetD1,
}));

durableSuite('do', async () => ({
  store: doProxy(),
  secondHandle: () => doProxy(),
  reset: resetDO,
}));
