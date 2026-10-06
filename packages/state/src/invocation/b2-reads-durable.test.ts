/**
 * B2 durable read proofs (colocated): REAL local durable substrates —
 * miniflare D1 and workerd Durable Object SQLite — never memory doubles.
 *
 * - Adapter version-race attachment (the Q3 SELECT widening): a stale
 *   commit carries the compared row's version/updated/updatedBy on D1
 *   (same-process values) and preserves the `version` kind on DO (the
 *   JSON test proxy drops the attachment — production workerd callers
 *   share the isolate and observe the real error; the widened SELECT
 *   executing without a SQL error is the DO proof).
 * - REAL restart: boot → write via `invoke` → read baseline → dispose
 *   → fresh boot over the SAME file-backed persist dir (the F4
 *   precedent) → reads + history byte-identical, repeats identical,
 *   archived exclusion intact.
 *
 * Only the membership reader stays a memory double (same boundary as
 * the T18/B1 durable suites).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact } from '@canlang/contracts';
import type {
  ModelName,
  RecordId,
  StoragePort,
} from '@canlang/contracts';
import {
  loadArtifactDescriptors,
  type ArtifactDescriptorSlice,
  type LoadedArtifactDescriptors,
} from './registry.js';
import { buildModelTableFromCanonical, type ModelTable } from '../mutation/models.js';
import { generatedCrudExecute } from '../mutation/crud.js';
import { invoke, invokeRead } from './invoke.js';
import { StateError, storageToStateError } from '../errors.js';
import { StorageConstraintError } from '../storage/port.js';
import { createD1Storage, ensureSchema } from '../storage/d1.js';
import { buildPolicyTable, type PolicyTable } from '../policy/grants.js';
import {
  FIXED_NOW,
  asModel,
  createMemoryIdentityStore,
  makeBatch,
  makeEnvelope,
  makeIdentity,
  seedMember,
  seedRow,
  updateRow,
  uuidv7,
  type SeededMember,
  type TestMembershipStore,
} from '../../test/invocation/fixtures.js';
import { T18_SHOP_ARTIFACT_JSON } from '../mutation/t18-shop.artifact.js';

const APP = 'acme-app';
const TEAM = 'Shop.Team';
const TEAM_CREATE = 'Shop.Team.create';
const TEAM_READ = 'Shop.Team.read';
const EXPECTED_ISO = new Date(FIXED_NOW).toISOString();

/* -- Ephemeral substrate handles (attachment proofs; no restart). -- */

let d1mf: Miniflare | undefined;
let d1db: D1Database;

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

describe('B2 durable: adapter race attachment', () => {
  it('d1 stale commits attach the compared row', async () => {
    const store = createD1Storage(d1db);
    const first = await seedRow(store, TEAM as ModelName, {
      id: 'team-attach',
      data: { name: 'team-one' },
    });
    const current = await updateRow(store, TEAM as ModelName, first, {
      data: { name: 'team-two' },
    });
    const revision = await store.readRevision();
    let thrown: unknown = null;
    try {
      await store.commit(
        makeBatch(revision as number, {
          writes: [
            {
              kind: 'update',
              model: TEAM as ModelName,
              id: 'team-attach' as RecordId,
              expectedVersion: first.version,
              row: current,
            },
          ],
        }),
      );
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof StorageConstraintError);
    assert.equal(thrown.kind, 'version');
    assert.deepEqual(thrown.conflictRow, {
      model: TEAM,
      id: 'team-attach',
      version: 2,
      updated: FIXED_NOW,
      updatedBy: 'user-alice',
    });
    const mapped = storageToStateError(thrown);
    assert.ok(mapped instanceof StateError);
    assert.ok(mapped.conflict !== undefined);
    assert.deepEqual(mapped.conflict.current.values, {});
  });

  it('durable-object stale commits preserve the version kind (proxy boundary)', async () => {
    const store = doProxy();
    const first = await seedRow(store, TEAM as ModelName, {
      id: 'team-attach-do',
      data: { name: 'team-one' },
    });
    const current = await updateRow(store, TEAM as ModelName, first, {
      data: { name: 'team-two' },
    });
    const revision = await store.readRevision();
    let thrown: unknown = null;
    try {
      await store.commit(
        makeBatch(revision as number, {
          writes: [
            {
              kind: 'update',
              model: TEAM as ModelName,
              id: 'team-attach-do' as RecordId,
              expectedVersion: first.version,
              row: current,
            },
          ],
        }),
      );
    } catch (error) {
      thrown = error;
    }
    // The JSON test proxy rehydrates name+message only: the worker-side
    // attachment does not survive the hop. The widened SELECT executing
    // (a SQL error would surface instead) plus the preserved kind is the
    // DO proof; production shares the isolate and observes the row.
    assert.ok(thrown instanceof Error);
    assert.equal(thrown.name, 'StorageConstraintError');
    assert.match(thrown.message, /^version: version mismatch/);
  });
});

/* -- Restartable substrate: boot -> kill (dispose) -> reboot (same dir). -- */

type SubstrateKind = 'd1' | 'do';

interface Restartable {
  readonly kind: SubstrateKind;
  /** Boot a fresh instance over the persist dir; returns its store. */
  start: () => Promise<StoragePort>;
  /** The kill: dispose the instance; uncommitted work is lost. */
  kill: () => Promise<void>;
}

async function openRestartable(kind: SubstrateKind, dir: string): Promise<Restartable> {
  let mf: Miniflare | undefined;
  const start = async (): Promise<StoragePort> => {
    if (kind === 'd1') {
      mf = new Miniflare({
        modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        d1Databases: ['DB'],
        d1Persist: join(dir, 'd1'),
      });
      const db = await mf.getD1Database('DB');
      await ensureSchema(db as D1Database);
      return createD1Storage(db as D1Database);
    }
    mf = new Miniflare({
      modules: true,
      scriptPath: doWorkerPath,
      modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
      compatibilityDate: '2025-01-01',
      durableObjectsPersist: join(dir, 'do'),
      durableObjects: {
        TEST_DO: { className: 'TestDO', useSQLite: true, unsafePreventEviction: true },
      },
    });
    const handle = mf;
    const call = async <T>(method: string, ...args: ReadonlyArray<unknown>): Promise<T> => {
      const response = await handle.dispatchFetch('http://localhost/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, args }),
      });
      const data = (await response.json()) as Record<string, unknown>;
      if (data['ok'] !== true) {
        const error = data['error'] as unknown as WorkerErrorJson;
        const rebuilt = new Error(error.message);
        rebuilt.name = error.name;
        throw rebuilt;
      }
      return data['value'] as T;
    };
    return {
      readRevision: () => call('readRevision'),
      load: (model: ModelName, id: RecordId) => call('load', model, id),
      query: (spec) => call('query', spec),
      commit: (batch) => call('commit', batch),
      readReceipt: (identity) => call('readReceipt', identity),
      outboxPending: () => call('outboxPending'),
      scheduleGet: (key) => call('scheduleGet', key),
      schedulesDue: (now, limit) => call('schedulesDue', now, limit),
      historyFor: (model, recordId) => call('historyFor', model, recordId),
      readInstalledSnapshot: (owner) => call('readInstalledSnapshot', owner),
      readMigrationProgress: (migrationId) => call('readMigrationProgress', migrationId),
      readStagedRows: (migrationId, cursor, limit) =>
        call('readStagedRows', migrationId, cursor, limit),
      stageMigrationRows: (input) => call('stageMigrationRows', input),
      publishMigrationChunk: (input) => call('publishMigrationChunk', input),
      flipInstalledSnapshot: (input) => call('flipInstalledSnapshot', input),
      readMigrationOutcomes: (migrationId) => call('readMigrationOutcomes', migrationId),
      recordMigrationFailure: (input) => call('recordMigrationFailure', input),
      discardStagedRows: (input) => call('discardStagedRows', input),
      readMigrationFailure: (migrationId) => call('readMigrationFailure', migrationId),
    };
  };
  const kill = async (): Promise<void> => {
    if (mf !== undefined) {
      await mf.dispose();
      mf = undefined;
    }
  };
  return { kind, start, kill };
}

async function withRestart(
  kind: SubstrateKind,
  label: string,
  fn: (sub: Restartable) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), `b2reads-${kind}-${label}-`));
  const sub = await openRestartable(kind, dir);
  try {
    await fn(sub);
  } finally {
    await sub.kill().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

interface B2DurableWorld {
  store: StoragePort;
  memberships: TestMembershipStore;
  alice: SeededMember;
  loaded: LoadedArtifactDescriptors;
  table: ModelTable;
  policy: PolicyTable;
}

async function setupWorld(
  store: StoragePort,
  memberships: TestMembershipStore,
  alice: SeededMember,
): Promise<B2DurableWorld> {
  const artifact = JSON.parse(T18_SHOP_ARTIFACT_JSON) as CompileArtifact;
  const { operations, models } = artifact;
  assert.ok(Array.isArray(operations) && operations.length > 0);
  assert.ok(Array.isArray(models) && models.length > 0);
  const slice: ArtifactDescriptorSlice = {
    artifact_version: artifact.artifact_version,
    operations,
    models,
  };
  const loaded = loadArtifactDescriptors(slice, { by: 'members' });
  const table = buildModelTableFromCanonical(loaded.models, {
    refs: loaded.refs,
    serverInits: loaded.serverInits,
    nullableFields: loaded.nullableFields,
  });
  const policy = buildPolicyTable([
    {
      model: asModel(TEAM),
      secretFields: [],
      grants: [{ by: 'members', fields: ['name', 'stock'] }],
    },
  ]);
  return { store, memberships, alice, loaded, table, policy };
}

let b2dSeq = 50000;

function teamInputs(): Record<string, unknown> {
  return { name: 'team-one', owner: { id: 'u-boss' }, flags: ['f1'] };
}

async function invokeCreate(world: B2DurableWorld) {
  b2dSeq += 1;
  return invoke({
    registry: world.loaded.registry,
    envelope: makeEnvelope(TEAM_CREATE, uuidv7(FIXED_NOW, b2dSeq), teamInputs()),
    identity: makeIdentity({
      membership: world.alice.membership,
      email: world.alice.user.email,
    }),
    app: APP,
    source: 'test',
    store: world.store,
    memberships: world.memberships,
    clock: { nowMs: () => FIXED_NOW },
    execute: generatedCrudExecute({ table: world.table, store: world.store }),
  });
}

async function invokeDelete(world: B2DurableWorld, id: string, version: string) {
  b2dSeq += 1;
  return invoke({
    registry: world.loaded.registry,
    envelope: makeEnvelope('Shop.Team.delete', uuidv7(FIXED_NOW, b2dSeq), {
      record: { id, version },
    }),
    identity: makeIdentity({
      membership: world.alice.membership,
      email: world.alice.user.email,
    }),
    app: APP,
    source: 'test',
    store: world.store,
    memberships: world.memberships,
    clock: { nowMs: () => FIXED_NOW },
    execute: generatedCrudExecute({ table: world.table, store: world.store }),
  });
}

async function readSnapshot(world: B2DurableWorld, recordId: string) {
  const served = await invokeRead({
    registry: world.loaded.registry,
    envelope: { operation: TEAM_READ, inputs: {} },
    identity: makeIdentity({
      membership: world.alice.membership,
      email: world.alice.user.email,
    }),
    policy: world.policy,
    store: world.store,
    memberships: world.memberships,
  });
  const history = await world.store.historyFor(TEAM as ModelName, recordId as RecordId);
  return { served, history };
}

for (const kind of ['d1', 'do'] as const) {
  describe(`B2 durable restart reads (${kind})`, () => {
    it('reads + history survive a real restart byte-identically', async () => {
      await withRestart(kind, 'reads', async (sub) => {
        const memberships = createMemoryIdentityStore();
        const alice = await seedMember(memberships, { isOwner: false });
        const world = await setupWorld(await sub.start(), memberships, alice);
        const created = await invokeCreate(world);
        assert.equal(created.status, 'committed');
        const id = (created.result as { id: string }).id;
        const baseline = await readSnapshot(world, id);
        assert.equal(baseline.served.records.length, 1);
        assert.equal(baseline.history.length, 1);

        await sub.kill();
        const rebooted = await setupWorld(await sub.start(), memberships, alice);
        const after = await readSnapshot(rebooted, id);
        assert.deepEqual(after, baseline);
        // Replay: repeats stay identical after the restart too.
        const again = await readSnapshot(rebooted, id);
        assert.deepEqual(again, baseline);
      });
    });

    it('archived exclusion survives a real restart', async () => {
      await withRestart(kind, 'archived', async (sub) => {
        const memberships = createMemoryIdentityStore();
        const alice = await seedMember(memberships, { isOwner: false });
        const world = await setupWorld(await sub.start(), memberships, alice);
        const created = await invokeCreate(world);
        assert.equal(created.status, 'committed');
        const id = (created.result as { id: string }).id;
        const deleted = await invokeDelete(world, id, '1');
        assert.equal(deleted.status, 'committed');
        const before = await readSnapshot(world, id);
        assert.deepEqual(before.served.records, []);

        await sub.kill();
        const rebooted = await setupWorld(await sub.start(), memberships, alice);
        const after = await readSnapshot(rebooted, id);
        assert.deepEqual(after.served.records, []);
        assert.equal(after.served.revision, before.served.revision);
        assert.deepEqual(after.history, before.history);
      });
    });
  });
}
