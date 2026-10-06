/**
 * T32b-wire durable proofs (colocated): the WIRED fence path running against
 * REAL local durable substrates — miniflare D1 and workerd Durable Object
 * SQLite — never memory doubles. Per substrate, through REAL invoke() /
 * pipeline execution: an intervening-change conflict retries then commits
 * (cross-handle), a mid-flight revocation voids with nothing persisted, and
 * a hook transitive re-read opens fresh with zero inherited deps.
 *
 * The fence, the batch atomicity, and the stored rows/receipts below are the
 * real SQLite substrates'; only the membership reader stays a memory double
 * (the durable claim covers the state store, not identity — same boundary
 * as the T17a/T31 durable suites). Process-restart survival is explicitly
 * UNCLAIMED (the harness holds ephemeral instances; no persist channel is
 * asserted).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type {
  ModelName,
  RecordId,
  Revision,
  StoragePort,
  StoredRow,
} from '../../../contracts/src/state.js';
import type { MutationResult } from '../../../contracts/src/wire.js';
import {
  buildModelTable,
  crudDefs,
  crudExecute,
  type InterimModelDef,
} from './index.js';
import { runMutationWrites } from './pipeline.js';
import type { ExecuteHandler, ExecutionEffects } from '../invocation/invoke.js';
import type { OperationRegistry } from '../invocation/registry.js';
import { createInvoker } from '../ports/transact.js';
import { createD1Storage, ensureSchema } from '../storage/d1.js';
import {
  FIXED_NOW,
  asId,
  asModel,
  asOperation,
  asOperationId,
  captureStateError,
  createMemoryIdentityStore,
  makeDef,
  makeEnvelope,
  makeIdentity,
  seedMember,
  uuidv7,
  type SeededMember,
  type TestMembershipStore,
} from '../../test/invocation/fixtures.js';
import {
  field,
  hook,
  modelDef,
  mustLoad,
  pipelineContext,
} from '../../test/mutation/fixtures.js';

const APP = 'acme-app';
const OPERATION = 'Acme.approve';
const GADGET = 'Acme.Gadget';

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

/* -- Wire world bound over one durable store. -- */

interface WireWorld {
  readonly store: StoragePort;
  readonly secondHandle: () => StoragePort;
  readonly memberships: TestMembershipStore;
  readonly alice: SeededMember;
  readonly invokeWith: (
    execute: ExecuteHandler,
    registry: OperationRegistry,
    operation: string,
    inputs: Record<string, unknown>,
    operationId: string,
  ) => Promise<MutationResult>;
}

async function setupWireWorld(
  store: StoragePort,
  secondHandle: () => StoragePort,
): Promise<WireWorld> {
  const memberships: TestMembershipStore = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const identity = makeIdentity({ membership: alice.membership, email: alice.user.email });
  return {
    store,
    secondHandle,
    memberships,
    alice,
    invokeWith: (execute, registry, operation, inputs, operationId) =>
      createInvoker({ registry, store, memberships, clock: { nowMs: () => FIXED_NOW } })({
        envelope: makeEnvelope(operation, operationId, inputs),
        identity,
        app: APP,
        source: 'test',
        execute,
      }),
  };
}

function bareEffects(overrides: Partial<ExecutionEffects> = {}): ExecutionEffects {
  return {
    writes: [],
    history: [],
    outbox: [],
    schedules: [],
    uniqueClaims: [],
    uniqueReleases: [],
    resolvedDefaults: {},
    result: null,
    ...overrides,
  };
}

function crudWorld(store: StoragePort, models: ReadonlyArray<InterimModelDef>): {
  registry: OperationRegistry;
  execute: ExecuteHandler;
} {
  const table = buildModelTable(models);
  const registry: OperationRegistry = new Map();
  const executors = new Map<string, ExecuteHandler>();
  for (const def of models) {
    const triple = crudDefs(def.model, { by: 'members' });
    (registry as Map<string, unknown>).set(triple.create.name as string, triple.create);
    (registry as Map<string, unknown>).set(triple.update.name as string, triple.update);
    (registry as Map<string, unknown>).set(triple.remove.name as string, triple.remove);
    executors.set(def.model as string, crudExecute({ table, model: def.model, store }));
  }
  const execute: ExecuteHandler = (call) => {
    const name = call.def.name as string;
    const owner = name.slice(0, name.lastIndexOf('.'));
    const routed = executors.get(owner);
    if (routed === undefined) {
      throw new Error(`No CRUD executor for operation ${JSON.stringify(name)}.`);
    }
    return routed(call);
  };
  return { registry, execute };
}

let opSeq = 71000;

/** Fresh deterministic operation id per durable call (stable across suites). */
function durableOperationId(): string {
  opSeq += 1;
  return uuidv7(FIXED_NOW, opSeq);
}

function durableSuite(
  name: string,
  handles: () => Promise<{
    store: StoragePort;
    secondHandle: () => StoragePort;
    reset: () => Promise<void>;
  }>,
): void {
  describe(`T32b-wire durable (${name})`, () => {
    it('retries an intervening change through a second handle, then commits', async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const world = await setupWireWorld(store, secondHandle);
      const def = makeDef();
      const registry: OperationRegistry = new Map([[def.name as string, def]]);
      const operationId = durableOperationId();
      let calls = 0;
      const execute: ExecuteHandler = async () => {
        calls += 1;
        if (calls === 1) {
          // Intervening write through a SECOND handle lands between
          // admission and commit on the first handle.
          const peer = secondHandle();
          await peer.commit({
            expectedRevision: await peer.readRevision(),
            writes: [],
            history: [],
            receipt: null,
            outbox: [],
            schedules: [],
            uniqueClaims: [],
            uniqueReleases: [],
          });
        }
        return bareEffects({ result: { wired: true } });
      };
      const outcome = await world.invokeWith(execute, registry, OPERATION, {}, operationId);
      assert.equal(outcome.status, 'committed');
      assert.deepEqual(outcome.result, { wired: true });
      assert.equal(calls, 2);
      // Intervening commit + the retried commit: two revisions, visible on
      // both handles with the receipt readable cross-handle.
      assert.equal(await store.readRevision(), 2);
      const peer = secondHandle();
      assert.equal(await peer.readRevision(), 2);
      const receipt = await peer.readReceipt({
        app: APP,
        owner: world.alice.team.team_id,
        principal: world.alice.user.user_id,
        operation: asOperation(OPERATION),
        operationId: asOperationId(operationId),
      });
      assert.ok(receipt);
      assert.equal(receipt.outcome.status, 'committed');
    });

    it('voids a mid-flight revocation with nothing persisted on either handle', async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const world = await setupWireWorld(store, secondHandle);
      const def = makeDef();
      const registry: OperationRegistry = new Map([[def.name as string, def]]);
      const operationId = durableOperationId();
      const execute: ExecuteHandler = async () => {
        // Revocation (memory double — the durable claim covers the state
        // store, not identity) lands between checkpoint and commit.
        await world.memberships.removeMembership(world.alice.membership.membership_id);
        return bareEffects({ result: { wired: true } });
      };
      const error = await captureStateError(
        world.invokeWith(execute, registry, OPERATION, {}, operationId),
      );
      assert.equal(error.code, 'forbidden');
      assert.match(error.message, /revoked/);
      assert.equal(await store.readRevision(), 0);
      const peer = secondHandle();
      assert.equal(await peer.readRevision(), 0);
      assert.equal(
        await peer.readReceipt({
          app: APP,
          owner: world.alice.team.team_id,
          principal: world.alice.user.user_id,
          operation: asOperation(OPERATION),
          operationId: asOperationId(operationId),
        }),
        null,
      );
    });

    it('hook transitive re-read opens fresh with zero inherited deps', async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const world = await setupWireWorld(store, secondHandle);
      const seen: Array<{
        triggerRevision: unknown;
        scopeRevision: unknown;
        depsAtOpen: unknown;
        rowVersion: unknown;
      }> = [];
      const transitive = hook('transitive', ['update'], async (candidate, ctx) => {
        const scope = await ctx.transitive.openScope();
        const atOpen = scope.snapshot().dependencies;
        const row = await ctx.transitive.load(scope, asModel(GADGET), ctx.triggerId);
        seen.push({
          triggerRevision: ctx.transitive.triggerRevision,
          scopeRevision: scope.revision,
          depsAtOpen: atOpen,
          rowVersion: row?.version,
        });
        return candidate;
      });
      const gadget = modelDef(GADGET, { fields: { title: field() }, hooks: [transitive] });
      const { registry, execute } = crudWorld(store, [gadget]);
      await world.invokeWith(
        execute,
        registry,
        `${GADGET}.create`,
        { id: 'g-d', data: { title: 'durable' } },
        durableOperationId(),
      );
      const triggerRevision = (await store.readRevision()) as number;
      // Intervening commit through the second handle moves the durable
      // fence before the pipeline runs.
      const peer = secondHandle();
      const target = await mustLoad(peer, asModel(GADGET), 'g-d');
      const bumped: StoredRow = { ...target, version: 2 as StoredRow['version'] };
      await peer.commit({
        expectedRevision: (await peer.readRevision()) as Revision,
        writes: [
          {
            kind: 'update',
            model: asModel(GADGET),
            id: target.id,
            expectedVersion: target.version,
            row: bumped,
          },
        ],
        history: [],
        receipt: null,
        outbox: [],
        schedules: [],
        uniqueClaims: [],
        uniqueReleases: [],
      });
      const table = buildModelTable([gadget]);
      await runMutationWrites({
        table,
        writes: [
          {
            op: 'update',
            model: asModel(GADGET),
            id: asId('g-d'),
            data: { title: 'durable-pending' },
          },
        ],
        context: pipelineContext({
          operation: `${GADGET}.update`,
          teamId: world.alice.team.team_id,
        }),
        store,
        trigger: { revision: triggerRevision as Revision, owner: world.alice.team.team_id },
      });
      assert.equal(seen.length, 1);
      const seen0 = seen[0];
      assert.ok(seen0);
      assert.equal(seen0.triggerRevision, triggerRevision);
      assert.equal(seen0.scopeRevision, triggerRevision + 1);
      assert.deepEqual(seen0.depsAtOpen, []);
      // The re-read observes the intervening committed version (2) —
      // cross-handle confirmed — never the pending candidate.
      assert.equal(seen0.rowVersion, 2);
      assert.equal((await mustLoad(peer, asModel(GADGET), 'g-d')).version, 2);
    });
  });
}

durableSuite('miniflare D1', async () => ({
  store: createD1Storage(d1db),
  secondHandle: () => createD1Storage(d1db),
  reset: resetD1,
}));

durableSuite('workerd DO', async () => ({
  store: doProxy(),
  secondHandle: () => doProxy(),
  reset: resetDO,
}));
