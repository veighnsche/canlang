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
  CanonicalOwnerModelPolicies,
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
import { beginOwnerMutation, type OwnerMutationSession } from '../mutation/pipeline.js';
import { bindOwnerModelPolicies } from '../mutation/model-policies.js';
import type { ExecuteHandler } from '../invocation/invoke.js';
import { pipelineContext } from '../../test/mutation/fixtures.js';
import { createD1Storage, ensureSchema } from './d1.js';
import { FenceConflictError, StorageConstraintError } from './port.js';
import { StateError } from '../errors.js';
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
  makeBatch,
  makeReceipt,
  seedRow,
  seedMember,
  uuidv7,
  type SeededMember,
  type TestMembershipStore,
} from '../../test/invocation/fixtures.js';

const APP = 'acme-app';
const GADGET = 'Shop.Gadget';
const LINK = asModel('Shop.Link');

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
    outboxGet: (intentId) => doCall('outboxGet', intentId),
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

/** Native owner-policy seam over the same real adapters and canonical invoker. */
async function setupOwnerSessionPlane(store: StoragePort, secondHandle: () => StoragePort) {
  const plane = await setupDurablePlane(store, secondHandle);
  const slice = durableSlice();
  assert.ok(slice.models);
  const loaded = loadArtifactDescriptors({ ...slice,
    operations: [{ name: 'Shop.change', kind: 'scenario', description: '', inputs: { fields: [] } }],
    models: [...slice.models.map(model => ({ ...model, deleteMode: 'remove' as const })),
      { name: LINK, fields: [{ name: 'target', field: { kind: 'ref' as const, model: GADGET },
        required: true, serverOnly: false }], deleteMode: 'remove' as const }],
  }, { by: 'members' });
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs });
  const invoker = createInvoker({ registry: loaded.registry, store, memberships: plane.memberships,
    clock: { nowMs: () => FIXED_NOW } });
  const identity = makeIdentity({ membership: plane.alice.membership, email: plane.alice.user.email });
  const descriptor: CanonicalOwnerModelPolicies = { abi: 'state.owner-model-policies@1',
    model: asModel(GADGET), module: 'owner.mjs', ownerPackage: 'Shop', hooks: [],
    rules: [{ kind: 'invariant', id: 'balanced', dependencies: [{ id: 'link-owners', model: LINK, maxTargets: 2 }] }] };
  const bindingIdentity = { model: asModel(GADGET), module: descriptor.module, ownerPackage: descriptor.ownerPackage };
  let overflow = false;
  const dependencies: Array<readonly [unknown, unknown]> = [];
  const evaluated: string[] = [];
  const policies = bindOwnerModelPolicies({ table, descriptors: [descriptor], bindings: [
    { ...bindingIdentity, kind: 'invariant', id: 'balanced', evaluate: async ({ read }, row) => {
      evaluated.push(row.id);
      const links = await read.query({ model: LINK, authority: 'owner', limit: 2,
        where: { op: 'eq', field: 'target.id', value: row.id } });
      return row.data.title === row.data.code && Number(row.data.stock) === links.length;
    } },
    { ...bindingIdentity, kind: 'dependency', id: 'link-owners', select: (_views, change) => {
      const before = (change.before?.data.target as { id: string } | undefined)?.id ?? null;
      const after = (change.after?.data.target as { id: string } | undefined)?.id ?? null;
      dependencies.push([before, after]);
      return (overflow ? ['gadget', 'extra', 'overflow'] : [...new Set([before, after])].filter(id => id !== null))
        .map(id => ({ model: asModel(GADGET), id: asId(id!) }));
    } },
  ] });
  const receiptIdentity = (operationId: string) => ({ app: APP, owner: plane.alice.team.team_id,
    principal: plane.alice.user.user_id, operation: asOperation('Shop.change'), operationId: asOperationId(operationId) });
  return { table, policies, dependencies, evaluated, receiptIdentity,
    overflow: () => { overflow = true; },
    run: (operationId: string, execute: ExecuteHandler) => invoker({ app: APP, source: 'test', identity,
      envelope: makeEnvelope('Shop.change', operationId, {}), execute }),
  };
}

function durableSuite(
  name: string,
  handles: () => Promise<{ store: StoragePort; secondHandle: () => StoragePort; reset: () => Promise<void> }>,
): void {
  describe(`T17a durable data plane (${name})`, () => {
    it('owner session commits final net effects and reference co-removal with checked reverse dependencies', async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const plane = await setupOwnerSessionPlane(store, secondHandle);
      const model = asModel(GADGET), id = asId('gadget');
      await seedRow(store, model, { id, data: { title: 'entry', code: 'entry', stock: '0' } });
      await store.commit(makeBatch(await store.readRevision(), {
        uniqueClaims: [{ model, recordId: id, keyName: 'code', keyValue: 'entry' }],
      }));
      const entry = await store.load(model, id);
      assert.ok(entry);
      const operationId = uuidv7(FIXED_NOW, 9501);
      const committed = await plane.run(operationId, async call => {
        const session = await beginOwnerMutation({ table: plane.table, store, context: call.context,
          policies: plane.policies, bounds: { maxRows: 4, maxWork: 300 } });
        await session.stage({ op: 'update', model, id, data: { title: 'final' } }, { cause: 'scenario' });
        assert.deepEqual(await session.views.entry.get(model, id), entry);
        assert.equal((await session.read(model, id))?.version, 2);
        assert.deepEqual((await session.views.entry.query({ model, authority: 'owner', limit: 4,
          where: { op: 'eq', field: 'title', value: 'entry' } })).map(row => row.id), [id]);
        assert.deepEqual((await session.views.final.query({ model, authority: 'owner', limit: 4,
          where: { op: 'eq', field: 'title', value: 'final' } })).map(row => row.id), [id]);
        assert.deepEqual(plane.evaluated, []);
        await session.stage({ op: 'create', model: LINK, id: asId('link'), data: { target: { id } } }, { cause: 'scenario' });
        await session.stage({ op: 'update', model, id, data: { code: 'final', stock: '1' } }, { cause: 'scenario' });
        const result = await session.read(model, id);
        const effects = await session.finalize();
        assert.equal(effects.writes.length, 2);
        assert.equal(effects.history.filter(row => row.model === model).length, 1);
        assert.equal(effects.history.find(row => row.model === model)?.version, 2);
        assert.deepEqual(effects.uniqueReleases, [{ model, keyName: 'code', keyValue: 'entry' }]);
        assert.deepEqual(effects.uniqueClaims, [{ model, recordId: id, keyName: 'code', keyValue: 'final' }]);
        assert.deepEqual(await store.load(model, id), entry);
        return { ...effects, outbox: [], result };
      });
      assert.equal(committed.status, 'committed');
      assert.deepEqual(plane.evaluated, [id]);
      assert.deepEqual(plane.dependencies, [[null, id]]);
      const other = secondHandle();
      assert.deepEqual((await other.load(model, id))?.data, { title: 'final', code: 'final', stock: '1' });
      assert.equal((await other.load(model, id))?.version, 2);
      const history = await other.historyFor(model, id);
      assert.equal(history.length, 1);
      assert.deepEqual(history[0]?.before, entry.data);
      assert.equal(history[0]?.operationId, operationId);
      assert.equal((await other.readReceipt(plane.receiptIdentity(operationId)))?.outcome.status, 'committed');
      const removedId = uuidv7(FIXED_NOW, 9502);
      await plane.run(removedId, async call => {
        const session = await beginOwnerMutation({ table: plane.table, store, context: call.context,
          policies: plane.policies, bounds: { maxRows: 4, maxWork: 300 } });
        // Target-first staging is temporarily invalid; final co-removal disposes it.
        await session.stage({ op: 'remove', model, id }, { cause: 'scenario' });
        await session.stage({ op: 'remove', model: LINK, id: asId('link') }, { cause: 'scenario' });
        assert.equal(await session.views.final.get(model, id), null);
        assert.equal((await session.views.entry.get(model, id))?.version, 2);
        return { ...await session.finalize(), outbox: [], result: null };
      });
      assert.deepEqual(plane.dependencies, [[null, id], [id, null]]);
      assert.equal(await other.load(model, id), null);
      assert.equal(await other.load(LINK, asId('link')), null);
      assert.deepEqual((await other.historyFor(model, id)).map(row => [row.change, row.version]), [['update', 2], ['remove', 3]]);
      assert.equal((await other.readReceipt(plane.receiptIdentity(removedId)))?.outcome.status, 'committed');
    });

    it('owner session bounded dependency refusals and stale fence commits preserve durable domain and history', async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const plane = await setupOwnerSessionPlane(store, secondHandle);
      const model = asModel(GADGET), id = asId('gadget');
      await seedRow(store, model, { id, data: { title: 'entry', code: 'entry', stock: '0' } });
      const entry = await store.load(model, id);
      assert.ok(entry);
      for (const [sequence, budget] of [[9601, 1], [9602, 300]] as const) {
        if (budget > 1) plane.overflow();
        const operationId = uuidv7(FIXED_NOW, sequence);
        let session: OwnerMutationSession | undefined;
        const error = await captureStateError(plane.run(operationId, async call => {
          session = await beginOwnerMutation({ table: plane.table, store, context: call.context,
            policies: plane.policies, bounds: { maxRows: 4, maxWork: budget } });
          await session.stage({ op: 'create', model: LINK, id: asId('refused'), data: { target: { id } } }, { cause: 'scenario' });
          return { ...await session.finalize(), outbox: [], result: null };
        }));
        assert.equal(error.code, 'validation');
        assert.match(error.message, budget === 1 ? /work budget/ : /dependency work.*bound/);
        await assert.rejects(session!.read(model, id), /poisoned/);
        assert.equal((await store.readReceipt(plane.receiptIdentity(operationId)))?.outcome.status, 'rejected');
        assert.deepEqual(await secondHandle().load(model, id), entry);
        assert.equal(await store.load(LINK, asId('refused')), null);
        assert.deepEqual(await store.historyFor(model, id), []);
        assert.deepEqual(await store.historyFor(LINK, asId('refused')), []);
      }
      const expectedRevision = await store.readRevision();
      const staleId = uuidv7(FIXED_NOW, 9603);
      const session = await beginOwnerMutation({ table: plane.table, store,
        context: pipelineContext({ operation: 'Shop.change', operationId: staleId }),
        policies: plane.policies, bounds: { maxRows: 4, maxWork: 300 } });
      await session.stage({ op: 'update', model, id, data: { title: 'stale', code: 'stale' } }, { cause: 'scenario' });
      const effects = await session.finalize();
      // A genuine second adapter moves the owning fence after finalization.
      await secondHandle().commit(makeBatch(expectedRevision));
      const receipt = makeReceipt({ ...plane.receiptIdentity(staleId), committedRevision: expectedRevision + 1 });
      await assert.rejects(store.commit(makeBatch(expectedRevision, { ...effects, receipt })), FenceConflictError);
      assert.deepEqual(await store.load(model, id), entry);
      assert.deepEqual(await store.historyFor(model, id), []);
      assert.equal(await store.readReceipt(plane.receiptIdentity(staleId)), null);
      assert.equal(await store.readRevision(), expectedRevision + 1);
    });

    it('retained-receipt-only recovers exact retained outcomes and refuses unseen, conflicting or revoked calls', async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const plane = await setupDurablePlane(store, secondHandle);
      const operation = `${GADGET}.create`;
      const operationId = uuidv7(FIXED_NOW, 9091);
      const inputs = { title: 'retained', code: 'D-retained' };
      const first = await plane.mutate(operation, inputs, operationId);
      const identity = makeIdentity({ membership: plane.alice.membership, email: plane.alice.user.email });
      const loaded = loadArtifactDescriptors(durableSlice(), { by: 'members' });
      const rejectedEnvelope = makeEnvelope(operation, uuidv7(FIXED_NOW, 9092), inputs);
      const originalInvoker = createInvoker({ registry: loaded.registry, store, memberships: plane.memberships,
        clock: { nowMs: () => FIXED_NOW } });
      const rejected = await captureStateError(originalInvoker({ app: APP, source: 'test', identity,
        envelope: rejectedEnvelope, execute: async () => { throw new StateError('rule_failed', 'Retained rejection.'); },
      }));
      const revision = await store.readRevision();
      let now = FIXED_NOW, executions = 0, commits = 0;
      const other = secondHandle();
      const recovery = createInvoker({ registry: loaded.registry,
        store: { ...other, commit: async batch => { commits += 1; return other.commit(batch); } },
        memberships: plane.memberships, clock: { nowMs: () => now },
      });
      const args = { app: APP, source: 'test', identity, admissionMode: 'retained-receipt-only' as const,
        envelope: makeEnvelope(operation, operationId, inputs),
        execute: async (call: Parameters<ReturnType<typeof generatedCrudExecute>>[0]) => {
          executions += 1; return generatedCrudExecute({ table: plane.table, store: other })(call);
        },
      };
      for (const elapsed of [16 * 60 * 1000, 24 * 60 * 60 * 1000]) {
        now = FIXED_NOW + elapsed;
        const replayed = await recovery(args);
        assert.equal(replayed.status, 'replayed');
        assert.deepEqual(replayed.result, first.result);
      }
      for (const override of [
        { envelope: { ...args.envelope, operation_id: uuidv7(now, 9093) } },
        { envelope: { ...args.envelope, operation_id: uuidv7(now - 25 * 60 * 60 * 1000, 9094) } },
        { app: 'foreign-app' },
        { identity: makeIdentity({ team: identity.team, userId: 'foreign-user' }) },
        { identity: makeIdentity({ actor: identity.actor, teamId: 'foreign-team' }) },
        { envelope: makeEnvelope(`${GADGET}.update`, operationId, inputs) },
      ]) {
        assert.equal((await captureStateError(recovery({ ...args, ...override }))).code, 'not_found');
      }
      assert.equal((await captureStateError(recovery({ ...args,
        envelope: { ...args.envelope, inputs: { ...inputs, title: 'changed' } },
      }))).code, 'conflict');
      const replayedRejection = await captureStateError(recovery({ ...args, envelope: rejectedEnvelope }));
      assert.equal(replayedRejection.code, rejected.code);
      assert.equal(replayedRejection.message, rejected.message);
      await plane.memberships.removeMembership(plane.alice.membership.membership_id);
      assert.equal((await captureStateError(recovery(args))).code, 'forbidden');
      assert.equal(executions, 0);
      assert.equal(commits, 0);
      assert.equal(await store.readRevision(), revision);
      assert.equal((await store.query({ model: asModel(GADGET), authority: 'owner' })).length, 1);
      assert.equal((await store.historyFor(asModel(GADGET), (first.result as StoredRow).id)).length, 1);
    });

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
