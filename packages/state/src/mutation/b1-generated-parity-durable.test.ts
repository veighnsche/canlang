/**
 * B1 generated-descriptor parity durable proofs (colocated): the
 * CRUD-vs-scenario agreement from `b1-generated-parity.test.ts` against
 * REAL local durable substrates — miniflare D1 and workerd Durable
 * Object SQLite — never memory doubles. Per substrate: a Team.create
 * through `invoke` and a scenario-shaped one-write staging agree on
 * engine-filled data plus receipt defaults (modulo the per-execution
 * secret and the T18-pinned admission input-fill split), and a
 * Member.create agrees on parent linkage plus parent-path defaults.
 *
 * Only the membership reader stays a memory double (same boundary as
 * the T18 durable suite). Process-restart survival is UNCLAIMED here;
 * restart read proofs ride in the B2 suite.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact } from '../../../contracts/src/artifact.js';
import type {
  ModelName,
  OperationName,
  Receipt,
  ReceiptIdentity,
  RecordId,
  StoragePort,
  StoredRow,
} from '../../../contracts/src/state.js';
import type { MutationResult } from '../../../contracts/src/wire.js';
import {
  loadArtifactDescriptors,
  type ArtifactDescriptorSlice,
  type LoadedArtifactDescriptors,
} from '../invocation/registry.js';
import { buildModelTableFromCanonical, type ModelTable } from './models.js';
import { generatedCrudExecute } from './crud.js';
import { runMutationWrites } from './pipeline.js';
import { invoke } from '../invocation/invoke.js';
import { receiptIdentityFor } from '../invocation/admission.js';
import { buildContext } from '../invocation/context.js';
import { createD1Storage, ensureSchema } from '../storage/d1.js';
import {
  FIXED_NOW,
  createMemoryIdentityStore,
  makeBatch,
  makeEnvelope,
  makeIdentity,
  seedMember,
  uuidv7,
  type SeededMember,
  type TestMembershipStore,
} from '../../test/invocation/fixtures.js';
import { T18_SHOP_ARTIFACT_JSON } from './t18-shop.artifact.js';

const APP = 'acme-app';
const TEAM = 'Shop.Team';
const MEMBER = 'Shop.Member';
const TEAM_CREATE = 'Shop.Team.create';
const MEMBER_CREATE = 'Shop.Member.create';
const EXPECTED_ISO = new Date(FIXED_NOW).toISOString();
const HEX64 = /^[0-9a-f]{64}$/;

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
  new URL('../../../../test/storage/do-test-worker.js', import.meta.url),
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

/* -- B1 durable world over one substrate handle. -- */

function loadShop(): LoadedArtifactDescriptors {
  const artifact = JSON.parse(T18_SHOP_ARTIFACT_JSON) as CompileArtifact;
  const { operations, models } = artifact;
  assert.ok(Array.isArray(operations) && operations.length > 0);
  assert.ok(Array.isArray(models) && models.length > 0);
  const slice: ArtifactDescriptorSlice = {
    artifact_version: artifact.artifact_version,
    operations,
    models,
  };
  return loadArtifactDescriptors(slice, { by: 'members' });
}

interface B1DurableWorld {
  readonly store: StoragePort;
  readonly memberships: TestMembershipStore;
  readonly alice: SeededMember;
  readonly loaded: LoadedArtifactDescriptors;
  readonly table: ModelTable;
}

async function setupDurableWorld(store: StoragePort): Promise<B1DurableWorld> {
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const loaded = loadShop();
  const table = buildModelTableFromCanonical(loaded.models, {
    refs: loaded.refs,
    serverInits: loaded.serverInits,
    nullableFields: loaded.nullableFields,
    // B5: durable agreements hold under declared ownership too.
    containment: loaded.containment,
  });
  return { store, memberships, alice, loaded, table };
}

let b1dSeq = 20000;

function nextOperationId(): string {
  b1dSeq += 1;
  return uuidv7(FIXED_NOW, b1dSeq);
}

function minimalTeamInputs(): Record<string, unknown> {
  return { name: 'team-one', owner: { id: 'u-boss' }, flags: ['f1'] };
}

function invokeOn(
  world: B1DurableWorld,
  operation: string,
  inputs: Record<string, unknown>,
  operationId: string,
): Promise<MutationResult> {
  return invoke({
    registry: world.loaded.registry,
    envelope: makeEnvelope(operation, operationId, inputs),
    identity: makeIdentity({ membership: world.alice.membership, email: world.alice.user.email }),
    app: APP,
    source: 'test',
    store: world.store,
    memberships: world.memberships,
    clock: { nowMs: () => FIXED_NOW },
    execute: generatedCrudExecute({ table: world.table, store: world.store }),
  });
}

async function scenarioStage(
  world: B1DurableWorld,
  write: {
    readonly op: 'create' | 'update' | 'remove';
    readonly model: ModelName;
    readonly id: RecordId;
    readonly parent?: { readonly model: ModelName; readonly id: RecordId };
    readonly data?: Record<string, unknown>;
  },
) {
  const context = buildContext({
    identity: makeIdentity({ membership: world.alice.membership, email: world.alice.user.email }),
    operation: 'Shop.RunScenario' as OperationName,
    operationId: nextOperationId(),
    app: APP,
    source: 'test',
    now: FIXED_NOW,
  });
  return runMutationWrites({
    table: world.table,
    writes: [write],
    context,
    store: world.store,
    gateArchivedTargets: true,
  });
}

async function commitStaged(
  world: B1DurableWorld,
  output: Awaited<ReturnType<typeof scenarioStage>>,
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

async function crudReceipt(
  world: B1DurableWorld,
  operation: string,
  operationId: string,
): Promise<Receipt> {
  const context = buildContext({
    identity: makeIdentity({ membership: world.alice.membership, email: world.alice.user.email }),
    operation: operation as OperationName,
    operationId,
    app: APP,
    source: 'test',
    now: FIXED_NOW,
  });
  const identity: ReceiptIdentity = receiptIdentityFor(context);
  const receipt = await world.store.readReceipt(identity);
  assert.ok(receipt !== null, `CRUD receipt for ${operation} ${operationId} committed`);
  return receipt;
}

for (const substrate of [
  { name: 'd1', open: () => createD1Storage(d1db), reset: resetD1 },
  { name: 'durable-object', open: () => doProxy(), reset: resetDO },
] as const) {
  describe(`B1 generated parity durable (${substrate.name})`, () => {
    it('Team.create data + persisted receipt agree CRUD-vs-scenario', async () => {
      await substrate.reset();
      const crud = await setupDurableWorld(substrate.open());
      const scen = await setupDurableWorld(substrate.open());
      const opId = nextOperationId();
      const created = await invokeOn(crud, TEAM_CREATE, minimalTeamInputs(), opId);
      assert.equal(created.status, 'committed');
      const crudRow = created.result as StoredRow;
      const staged = await scenarioStage(scen, {
        op: 'create',
        model: TEAM as ModelName,
        id: 'team-s1' as RecordId,
        data: minimalTeamInputs(),
      });
      const stagedWrite = staged.writes[0];
      assert.ok(stagedWrite !== undefined && stagedWrite.kind === 'insert');
      await commitStaged(scen, staged);
      // Both rows persist through the durable fence with identical fills.
      const crudStored = await crud.store.load(TEAM as ModelName, crudRow.id);
      const scenStored = await scen.store.load(TEAM as ModelName, 'team-s1' as RecordId);
      assert.ok(crudStored !== null && scenStored !== null);
      for (const [field, expected] of [
        ['name', 'team-one'],
        ['stock', '0'],
        ['kind', 'home'],
        ['note', null],
        ['made', EXPECTED_ISO],
      ] as const) {
        assert.deepEqual(crudStored.data[field], expected, `CRUD ${field}`);
        assert.deepEqual(scenStored.data[field], expected, `scenario ${field}`);
      }
      assert.match(String(crudStored.data['token']), HEX64);
      assert.match(String(scenStored.data['token']), HEX64);
      const receipt = await crudReceipt(crud, TEAM_CREATE, opId);
      const { token: _crudToken, ...crudDefaults } = receipt.resolvedDefaults;
      const { token: _scenToken, tags: _scenTags, ...scenDefaults } = staged.resolvedDefaults;
      assert.deepEqual(scenDefaults, crudDefaults);
    });

    it('Member.create parent linkage agrees CRUD-vs-scenario', async () => {
      await substrate.reset();
      const crud = await setupDurableWorld(substrate.open());
      const scen = await setupDurableWorld(substrate.open());
      const crudTeam = (
        await invokeOn(crud, TEAM_CREATE, minimalTeamInputs(), nextOperationId())
      ).result as StoredRow;
      const scenTeamStaged = await scenarioStage(scen, {
        op: 'create',
        model: TEAM as ModelName,
        id: 'team-s1' as RecordId,
        data: minimalTeamInputs(),
      });
      await commitStaged(scen, scenTeamStaged);
      const crudMember = (
        await invokeOn(
          crud,
          MEMBER_CREATE,
          { name: 'mem-one', parent: { id: crudTeam.id } },
          nextOperationId(),
        )
      ).result as StoredRow;
      const scenMemberStaged = await scenarioStage(scen, {
        op: 'create',
        model: MEMBER as ModelName,
        id: 'mem-s1' as RecordId,
        parent: { model: TEAM as ModelName, id: 'team-s1' as RecordId },
        data: { name: 'mem-one' },
      });
      await commitStaged(scen, scenMemberStaged);
      const scenMember = await scen.store.load(MEMBER as ModelName, 'mem-s1' as RecordId);
      assert.ok(scenMember !== null);
      assert.deepEqual(crudMember.parent, { model: TEAM, id: crudTeam.id });
      assert.deepEqual(scenMember.parent, { model: TEAM, id: 'team-s1' });
      assert.deepEqual(crudMember.data['buddy'], { id: 'u-boss' });
      assert.deepEqual(scenMember.data['buddy'], { id: 'u-boss' });
      assert.equal(scenMember.data['seen'], EXPECTED_ISO);
    });
  });
}
