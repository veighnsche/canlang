/**
 * T18 defaults + server-init durable proofs (colocated): the REAL `can
 * compile` artifact for `t18-shop.can` (same embedded stdout as the memory
 * suite) through the real load → admit → invoke path against REAL local
 * durable substrates — miniflare D1 and workerd Durable Object SQLite —
 * never memory doubles. Per substrate: a minimal create resolves and
 * persists the full engine fill (literal/null/array/server), a child
 * create persists linkage plus parent-path defaults, and an identical
 * envelope replays the committed server values (no re-mint).
 *
 * Only the membership reader stays a memory double (the durable claim
 * covers the state store, not identity — same boundary as the T17a/T31
 * durable suites). Process-restart survival is explicitly UNCLAIMED (the
 * harness holds ephemeral instances; no persist channel is asserted).
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact } from '@canlang/contracts';
import type {
  ModelName,
  RecordId,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import type { MutationResult } from '@canlang/contracts';
import {
  loadArtifactDescriptors,
  type ArtifactDescriptorSlice,
  type LoadedArtifactDescriptors,
} from '../invocation/registry.js';
import {
  buildModelTableFromCanonical,
  type ModelTable,
} from './models.js';
import { generatedCrudExecute } from './crud.js';
import { invoke } from '../invocation/invoke.js';
import { createD1Storage, ensureSchema } from '../storage/d1.js';
import {
  FIXED_NOW,
  asOperation,
  asOperationId,
  createMemoryIdentityStore,
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

/* -- T18 world over one durable store. -- */

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

interface T18DurableWorld {
  readonly store: StoragePort;
  readonly secondHandle: () => StoragePort;
  readonly memberships: TestMembershipStore;
  readonly alice: SeededMember;
  readonly loaded: LoadedArtifactDescriptors;
  readonly table: ModelTable;
}

async function setupDurableWorld(secondHandle: () => StoragePort): Promise<T18DurableWorld> {
  const store = secondHandle();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const loaded = loadShop();
  const table = buildModelTableFromCanonical(loaded.models, {
    refs: loaded.refs,
    serverInits: loaded.serverInits,
    nullableFields: loaded.nullableFields,
  });
  return { store, secondHandle, memberships, alice, loaded, table };
}

function invokeOn(world: T18DurableWorld, operation: string, inputs: Record<string, unknown>, operationId: string): Promise<MutationResult> {
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

let durableSeq = 81000;

function durableOperationId(): string {
  durableSeq += 1;
  return uuidv7(FIXED_NOW, durableSeq);
}

function minimalTeamInputs(): Record<string, unknown> {
  return { name: 'team-d', owner: { id: 'u-boss' }, flags: ['f1'] };
}

function durableSuite(
  name: string,
  handles: () => Promise<{ secondHandle: () => StoragePort; reset: () => Promise<void> }>,
): void {
  describe(`T18 durable (${name})`, () => {
    it('persists the full engine fill on a minimal create', async () => {
      const { secondHandle, reset } = await handles();
      await reset();
      const world = await setupDurableWorld(secondHandle);
      const operationId = durableOperationId();
      const outcome = await invokeOn(world, TEAM_CREATE, minimalTeamInputs(), operationId);
      assert.equal(outcome.status, 'committed');
      const row = outcome.result as StoredRow;
      assert.deepEqual(row.data['stock'], '0');
      assert.deepEqual(row.data['kind'], 'home');
      assert.equal(row.data['note'], null);
      assert.deepEqual(row.data['tags'], []);
      assert.equal(row.data['made'], EXPECTED_ISO);
      assert.deepEqual(row.data['by'], { id: world.alice.membership.user_id });
      const token = row.data['token'];
      assert.ok(typeof token === 'string' && HEX64.test(token));
      // The fill survives a cross-handle durable re-read (real SQLite).
      const peer = secondHandle();
      const reread = await peer.load(TEAM as ModelName, row.id);
      assert.ok(reread !== null);
      assert.deepEqual(reread.data, row.data);
      const receipt = await peer.readReceipt({
        app: APP,
        owner: world.alice.team.team_id,
        principal: world.alice.user.user_id,
        operation: asOperation(TEAM_CREATE),
        operationId: asOperationId(operationId),
      });
      assert.ok(receipt !== null && receipt.outcome.status === 'committed');
      assert.equal(receipt.resolvedDefaults['made'], EXPECTED_ISO);
      assert.equal(receipt.resolvedDefaults['token'], token);
    });

    it('persists child linkage plus parent-path defaults', async () => {
      const { secondHandle, reset } = await handles();
      await reset();
      const world = await setupDurableWorld(secondHandle);
      const team = (
        await invokeOn(world, TEAM_CREATE, minimalTeamInputs(), durableOperationId())
      ).result as StoredRow;
      const outcome = await invokeOn(
        world,
        MEMBER_CREATE,
        { name: 'mem-d', parent: { id: team.id } },
        durableOperationId(),
      );
      assert.equal(outcome.status, 'committed');
      const row = outcome.result as StoredRow;
      assert.deepEqual(row.parent, { model: TEAM, id: team.id });
      assert.deepEqual(row.data['buddy'], { id: 'u-boss' });
      assert.equal(row.data['seen'], EXPECTED_ISO);
      const peer = secondHandle();
      const reread = await peer.load(MEMBER as ModelName, row.id);
      assert.ok(reread !== null);
      assert.deepEqual(reread.parent, { model: TEAM, id: team.id });
      assert.deepEqual(reread.data['buddy'], { id: 'u-boss' });
    });

    it('replays the committed server values without re-minting', async () => {
      const { secondHandle, reset } = await handles();
      await reset();
      const world = await setupDurableWorld(secondHandle);
      const operationId = durableOperationId();
      const first = await invokeOn(world, TEAM_CREATE, minimalTeamInputs(), operationId);
      assert.equal(first.status, 'committed');
      const committed = first.result as StoredRow;
      const second = await invokeOn(world, TEAM_CREATE, minimalTeamInputs(), operationId);
      assert.equal(second.status, 'replayed');
      assert.deepEqual(second.result, committed);
    });
  });
}

durableSuite('miniflare D1', async () => ({
  secondHandle: () => createD1Storage(d1db),
  reset: resetD1,
}));

durableSuite('workerd DO', async () => ({
  secondHandle: () => doProxy(),
  reset: resetDO,
}));
