/**
 * T31 (Rule A) staged hook writes: durable proofs on REAL substrates.
 *
 * Extends the T17a miniflare-D1 + workerd-DO harness patterns (admit →
 * pipeline → fenced commit over the real SQLite substrates; only the
 * membership reader stays a memory double — the durable claim covers the
 * state store, not identity). Proves per substrate: one-revision atomic
 * commit of a staged set, atomic rollback on staged failure, staged-target
 * conflict (fence + version layers, nothing partial), and history/replay
 * of a staged set. Process-restart survival is explicitly UNCLAIMED (the
 * harness holds ephemeral instances; no persist channel is asserted).
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
import { StateError } from '../../src/errors.js';
import {
  buildModelTable,
  crudDefs,
  crudExecute,
  type InterimModelDef,
} from '../../src/mutation/index.js';
import { runMutationWrites } from '../../src/mutation/pipeline.js';
import type { ExecuteHandler } from '../../src/invocation/invoke.js';
import type { OperationRegistry } from '../../src/invocation/registry.js';
import { createInvoker } from '../../src/ports/transact.js';
import { createD1Storage, ensureSchema } from '../../src/storage/d1.js';
import { FenceConflictError, StorageConstraintError } from '../../src/storage/port.js';
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
} from '../invocation/fixtures.js';
import {
  field,
  hook,
  invariant,
  modelDef,
  mustLoad,
  pipelineContext,
} from './fixtures.js';

const APP = 'acme-app';
const CHECK = 'Acme.Check';
const TRANSITION = 'Acme.Transition';

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

/* -- Staging world bound over one durable store. -- */

interface StagingWorld {
  readonly store: StoragePort;
  readonly secondHandle: () => StoragePort;
  readonly alice: SeededMember;
  readonly mutate: (
    operation: string,
    inputs: Record<string, unknown>,
    operationId: string,
  ) => Promise<MutationResult>;
}

async function setupStagingWorld(
  store: StoragePort,
  secondHandle: () => StoragePort,
  models: ReadonlyArray<InterimModelDef>,
): Promise<StagingWorld> {
  const memberships: TestMembershipStore = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
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
  const invoker = createInvoker({
    registry,
    store,
    memberships,
    clock: { nowMs: () => FIXED_NOW },
  });
  const identity = makeIdentity({ membership: alice.membership, email: alice.user.email });
  return {
    store,
    secondHandle,
    alice,
    mutate: (operation, inputs, operationId) =>
      invoker({
        envelope: makeEnvelope(operation, operationId, inputs),
        identity,
        app: APP,
        source: 'test',
        execute,
      }),
  };
}

async function captureFailure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected failure, got success.');
}

let opSeq = 9000;

/** Fresh deterministic operation id per durable call (stable across suites). */
function durableOperationId(): string {
  opSeq += 1;
  return uuidv7(FIXED_NOW, opSeq);
}

function checkDef(
  opts: Parameters<typeof modelDef>[1] = {},
): ReturnType<typeof modelDef> {
  return modelDef(CHECK, { fields: { state: field() }, ...opts });
}

function transitionDef(
  opts: Parameters<typeof modelDef>[1] = {},
): ReturnType<typeof modelDef> {
  return modelDef(TRANSITION, { fields: { note: field() }, ...opts });
}

function durableSuite(
  name: string,
  handles: () => Promise<{
    store: StoragePort;
    secondHandle: () => StoragePort;
    reset: () => Promise<void>;
  }>,
): void {
  describe(`T31 staged writes durable (${name})`, () => {
    it('commits trigger + staged set + timers in one revision', async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const stageAll = hook('stage-all', ['update'], (candidate, ctx) => {
        ctx.stage({
          op: 'create',
          model: asModel(TRANSITION),
          id: asId('t-d1'),
          parent: { model: ctx.triggerModel, id: ctx.triggerId },
          data: { note: 'durable-child' },
        });
        ctx.schedule({
          key: 'deadline:c-d1',
          at: FIXED_NOW + 1000,
          event: asOperation(`${CHECK}.deadline`),
          payload: {},
        });
        return { ...candidate, state: 'configured' };
      });
      const world = await setupStagingWorld(store, secondHandle, [
        checkDef({ hooks: [stageAll] }),
        transitionDef(),
      ]);
      const created = await world.mutate(
        `${CHECK}.create`,
        { id: 'c-d1', data: { state: 'initial' } },
        durableOperationId(),
      );
      assert.equal(created.status, 'committed');
      assert.equal(await store.readRevision(), 1);
      const updated = await world.mutate(
        `${CHECK}.update`,
        { ref: { id: 'c-d1', version: '1' }, patch: {} },
        durableOperationId(),
      );
      assert.equal(updated.status, 'committed');
      // One fence revision for the whole staged set (real batch boundary).
      assert.equal(await store.readRevision(), 2);
      const check = await mustLoad(store, asModel(CHECK), 'c-d1');
      assert.equal(check.version, 2);
      // Cross-handle read-back: the staged child + timer are durable.
      const peer = secondHandle();
      const child = await mustLoad(peer, asModel(TRANSITION), 't-d1');
      assert.equal(child.version, 1);
      assert.deepEqual(child.parent, { model: CHECK, id: 'c-d1' });
      assert.deepEqual((await peer.scheduleGet('deadline:c-d1'))?.key, 'deadline:c-d1');
      // History for both rows shares the triggering operation identity.
      const triggerHistory = await peer.historyFor(asModel(CHECK), asId('c-d1'));
      const childHistory = await peer.historyFor(asModel(TRANSITION), asId('t-d1'));
      assert.equal(triggerHistory.length, 2);
      assert.equal(childHistory.length, 1);
      assert.equal(childHistory[0]?.operationId, triggerHistory[1]?.operationId);
      assert.equal(childHistory[0]?.operation, `${CHECK}.update`);
      const receipt = await peer.readReceipt({
        app: APP,
        owner: world.alice.team.team_id,
        principal: world.alice.user.user_id,
        operation: asOperation(`${CHECK}.update`),
        operationId: asOperationId(updated.operation_id),
      });
      assert.deepEqual(
        receipt?.outcome.status === 'committed' ? receipt.outcome.recordVersions : null,
        [
          { model: CHECK, id: 'c-d1', version: 2 },
          { model: TRANSITION, id: 't-d1', version: 1 },
        ],
      );
    });

    it('rolls the whole staged set back when a staged invariant fails', async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const stageDoomed = hook('stage-doomed', ['update'], (candidate, ctx) => {
        ctx.stage({
          op: 'create',
          model: asModel(TRANSITION),
          id: asId('t-doomed'),
          parent: { model: ctx.triggerModel, id: ctx.triggerId },
          data: { note: 'doomed' },
        });
        ctx.schedule({
          key: 'deadline:c-doomed',
          at: FIXED_NOW,
          event: asOperation(`${CHECK}.deadline`),
          payload: {},
        });
        return { ...candidate, state: 'configured' };
      });
      const world = await setupStagingWorld(store, secondHandle, [
        checkDef({ hooks: [stageDoomed] }),
        transitionDef({
          invariants: [
            invariant('no-doomed', () => {
              throw new StateError('rule_failed', 'Doomed children rejected.');
            }),
          ],
        }),
      ]);
      await world.mutate(
        `${CHECK}.create`,
        { id: 'c-doomed', data: { state: 'initial' } },
        durableOperationId(),
      );
      const revisionBefore = await store.readRevision();
      const failed = await captureStateError(
        world.mutate(
          `${CHECK}.update`,
          { ref: { id: 'c-doomed', version: '1' }, patch: {} },
          durableOperationId(),
        ),
      );
      assert.equal(failed.code, 'rule_failed');
      // Exactly one fence step: the rejected-only receipt. No trigger write,
      // no child row, no timer, no history for the failed attempt.
      assert.equal(await store.readRevision(), (revisionBefore as number) + 1);
      const peer = secondHandle();
      const check = await mustLoad(peer, asModel(CHECK), 'c-doomed');
      assert.equal(check.version, 1);
      assert.deepEqual(check.data, { state: 'initial' });
      assert.equal(await peer.load(asModel(TRANSITION), asId('t-doomed')), null);
      assert.equal(await peer.scheduleGet('deadline:c-doomed'), null);
      assert.equal((await peer.historyFor(asModel(CHECK), asId('c-doomed'))).length, 1);
      assert.deepEqual(await peer.historyFor(asModel(TRANSITION), asId('t-doomed')), []);
    });

    it('voids the staged batch on a concurrent staged-target change (fence + version)', async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const bumpTarget = hook('bump-target', ['update'], (candidate, ctx) => {
        ctx.stage({
          op: 'update',
          model: asModel(TRANSITION),
          id: asId('t-race'),
          data: { note: 'staged-bump' },
        });
        return candidate;
      });
      const world = await setupStagingWorld(store, secondHandle, [
        checkDef({ hooks: [bumpTarget] }),
        transitionDef(),
      ]);
      await world.mutate(
        `${CHECK}.create`,
        { id: 'c-race', data: { state: 'initial' } },
        durableOperationId(),
      );
      await world.mutate(
        `${TRANSITION}.create`,
        { id: 't-race', data: { note: 'v1' } },
        durableOperationId(),
      );
      const table = buildModelTable([
        checkDef({ hooks: [bumpTarget] }),
        transitionDef(),
      ]);
      const effects = await runMutationWrites({
        table,
        writes: [
          { op: 'update', model: asModel(CHECK), id: asId('c-race'), data: {} },
        ],
        context: pipelineContext({ operation: `${CHECK}.update` }),
        store,
      });
      assert.equal(effects.writes.length, 2);
      const fence = await store.readRevision();
      // Intervene through the second handle: bump the staged target.
      const peer = secondHandle();
      const target = await mustLoad(peer, asModel(TRANSITION), 't-race');
      const bumped: StoredRow = {
        ...target,
        version: 2 as StoredRow['version'],
        updated: FIXED_NOW + 1,
      };
      await peer.commit({
        expectedRevision: fence,
        writes: [
          {
            kind: 'update',
            model: asModel(TRANSITION),
            id: asId('t-race'),
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
      // The pre-intervention batch can no longer commit: D1 and DO
      // pre-check row versions before the fence INSERT, so the stale
      // staged-target version fails first (the memory adapter checks the
      // fence first — either order fails closed; staged.test.ts pins the
      // memory order). DO-proxy errors rehydrate into the real classes.
      const versionFailure = await captureFailure(
        store.commit({
          expectedRevision: fence,
          writes: effects.writes,
          history: effects.history,
          receipt: null,
          outbox: [],
          schedules: effects.schedules,
          uniqueClaims: effects.uniqueClaims,
          uniqueReleases: effects.uniqueReleases,
        }),
      );
      if (!(versionFailure instanceof StorageConstraintError)) {
        throw new Error(`Expected a version conflict, got ${versionFailure.name}.`);
      }
      assert.equal(versionFailure.kind, 'version');
      // The pure fence layer: a freshly built batch (current versions, so
      // version pre-checks pass) committed at the stale fence loses the
      // fence on both substrates.
      const fresh = await runMutationWrites({
        table,
        writes: [
          { op: 'update', model: asModel(CHECK), id: asId('c-race'), data: {} },
        ],
        context: pipelineContext({ operation: `${CHECK}.update` }),
        store,
      });
      const fenceFailure = await captureFailure(
        store.commit({
          expectedRevision: fence,
          writes: fresh.writes,
          history: fresh.history,
          receipt: null,
          outbox: [],
          schedules: fresh.schedules,
          uniqueClaims: fresh.uniqueClaims,
          uniqueReleases: fresh.uniqueReleases,
        }),
      );
      assert.equal(fenceFailure.name, 'FenceConflictError');
      // Nothing from the staged batch persisted on either handle.
      assert.equal(await store.readRevision(), (fence as number) + 1);
      assert.equal((await mustLoad(peer, asModel(CHECK), 'c-race')).version, 1);
      assert.deepEqual((await mustLoad(peer, asModel(TRANSITION), 't-race')).data, {
        note: 'v1',
      });
    });

    it('replays the staged set by operation identity with cross-handle read-back', async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const stageChild = hook('stage-child', ['update'], (candidate, ctx) => {
        ctx.stage({
          op: 'create',
          model: asModel(TRANSITION),
          id: asId('t-re'),
          parent: { model: ctx.triggerModel, id: ctx.triggerId },
          data: { note: 'replayable' },
        });
        return { ...candidate, state: 'configured' };
      });
      const world = await setupStagingWorld(store, secondHandle, [
        checkDef({ hooks: [stageChild] }),
        transitionDef(),
      ]);
      await world.mutate(
        `${CHECK}.create`,
        { id: 'c-re', data: { state: 'initial' } },
        durableOperationId(),
      );
      const inputs = { ref: { id: 'c-re', version: '1' }, patch: {} };
      const operationId = durableOperationId();
      const first = await world.mutate(
        `${CHECK}.update`,
        structuredClone(inputs),
        operationId,
      );
      assert.equal(first.status, 'committed');
      const revisionAfterCommit = await store.readRevision();
      const replayed = await world.mutate(
        `${CHECK}.update`,
        structuredClone(inputs),
        operationId,
      );
      assert.equal(replayed.status, 'replayed');
      assert.deepEqual(replayed.result, first.result);
      assert.equal(await store.readRevision(), revisionAfterCommit);
      const peer = secondHandle();
      assert.equal((await mustLoad(peer, asModel(CHECK), 'c-re')).version, 2);
      assert.equal((await mustLoad(peer, asModel(TRANSITION), 't-re')).version, 1);
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
