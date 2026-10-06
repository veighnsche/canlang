/**
 * T25-L3 receipt join: durable proofs on REAL substrates.
 *
 * Reuses the T31/T24a miniflare-D1 + workerd-DO harness patterns
 * (fenced commits over the real SQLite substrates through the
 * linkage-asserted join port; the real T25a mechanism loaded
 * dynamically, as in `t25-receipt-join.test.ts`). Proves per
 * substrate: durable persist of the association + receipt pair with
 * cross-handle selected observation (status-only recipient grant,
 * exact-leaf projection, fence enrollment), and the fence void when
 * receipt progress lands concurrently (stale-scope reads conflict;
 * enrolled observations void their commit). Process-restart survival
 * is explicitly UNCLAIMED (the harness holds ephemeral instances; no
 * persist channel is asserted). Single-owner scope only: cross-store
 * atomicity is NOT claimed and must not be inferred.
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
} from '../../../contracts/src/state.js';
import { StateError } from '../errors.js';
import {
  openFenceScope,
  revalidateCommitForFence,
} from '../invocation/admission.js';
import {
  FIXED_NOW,
  asId,
  asModel,
  makeBatch,
  makeRow,
} from '../../test/invocation/fixtures.js';
import {
  grant,
  modelPolicy,
  policyTable,
  seedStandardTeam,
} from '../../test/query/fixtures.js';
import type { TestMembershipStore } from '../../test/query/fixtures.js';
import type { SeededMember } from '../../test/invocation/fixtures.js';
import type { PolicyTable } from '../policy/grants.js';
import { createD1Storage, ensureSchema } from '../storage/d1.js';
import { FenceConflictError, StorageConstraintError } from '../storage/port.js';
import {
  RECEIPT_ASSOCIATION_MODEL,
  RECEIPT_MODEL,
  associationRowId,
  createReceiptJoinPort,
  newAssociationRow,
  newReceiptRow,
  readAssociationRow,
  readReceiptRow,
  withAssociationRowData,
  withReceiptRowData,
} from './tables.js';
import { createDeliverySchema, type DeliveryFieldSchema } from './grants.js';
import {
  observeSelectedReceiptJoin,
  type SelectedReceiptJoinInput,
} from './join.js';
import { loadWorkReceiptFns, type WorkReceiptFns } from './work-loader.js';

const ITEM = 'Acme.Item';
const ITEM_MODEL = asModel(ITEM);
const SOURCE = 'mailroom.Mail.send';
const ACTOR = 't25-durable';

const fns: WorkReceiptFns = await loadWorkReceiptFns();

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

// Same depth as the test/ports suites: dist/state/src/receipt/ is four
// levels below the package root, so this reaches the source worker.
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

/* -- Durable join world: owner + pair persist, progress, observe. -- */

interface DurableWorld {
  readonly memberships: TestMembershipStore;
  readonly teamId: string;
  readonly alice: SeededMember;
  readonly schema: DeliveryFieldSchema;
  readonly policy: PolicyTable;
}

async function setupDurableWorld(): Promise<DurableWorld> {
  const team = await seedStandardTeam();
  return {
    memberships: team.memberships,
    teamId: team.team.team_id,
    alice: team.alice,
    schema: createDeliverySchema([[ITEM, ['notification']]]),
    policy: policyTable(
      modelPolicy(ITEM_MODEL, {
        grants: [grant('members', ['service', 'notice_state', 'notification.status'])],
      }),
    ),
  };
}

async function seedDurableOwner(store: StoragePort): Promise<void> {
  const revision = await store.readRevision();
  await store.commit(
    makeBatch(revision as number, {
      writes: [
        {
          kind: 'insert',
          model: ITEM_MODEL,
          row: makeRow({
            id: 'item-1',
            data: { service: 'svc-1', notice_state: 'pending', notification: 'decoy-id' },
          }),
        },
      ],
    }),
  );
}

async function associateDurable(store: StoragePort): Promise<void> {
  const port = createReceiptJoinPort({ store });
  const revision = await store.readRevision();
  await port.commitJoin(
    makeBatch(revision as number, {
      writes: [
        {
          kind: 'insert',
          model: RECEIPT_ASSOCIATION_MODEL as ModelName,
          row: newAssociationRow(
            {
              recordModel: ITEM,
              recordId: 'item-1',
              field: 'notification',
              deliveryId: 'del_1',
              source: SOURCE,
              revision: 0,
            },
            { nowMs: FIXED_NOW, actor: ACTOR },
          ),
        },
        {
          kind: 'insert',
          model: RECEIPT_MODEL as ModelName,
          row: newReceiptRow(
            {
              deliveryId: 'del_1',
              revision: 0,
              status: 'pending',
              result: null,
              error: null,
              contentRef: null,
              resultExpiresAtMs: null,
            },
            { nowMs: FIXED_NOW, actor: ACTOR },
          ),
        },
      ],
    }),
  );
}

/** Durable progress: the real applier decides, the join port persists. */
async function progressDurable(store: StoragePort): Promise<void> {
  const assocRow = await store.load(
    RECEIPT_ASSOCIATION_MODEL as ModelName,
    associationRowId(ITEM, 'item-1', 'notification') as RecordId,
  );
  const receiptRow = await store.load(RECEIPT_MODEL as ModelName, asId('del_1'));
  assert.ok(assocRow !== null && receiptRow !== null);
  const verdict = fns.applyReceiptProgress(
    readAssociationRow(assocRow),
    readReceiptRow(receiptRow).receipt,
    {
      delivery_id: 'del_1',
      source: SOURCE,
      revision: 1,
      status: 'succeeded',
      result: { reference: 'durable' },
      error: null,
    },
  );
  assert.equal(verdict.applied, true);
  if (!verdict.applied) {
    return;
  }
  const port = createReceiptJoinPort({ store });
  const revision = await store.readRevision();
  await port.commitJoin(
    makeBatch(revision as number, {
      writes: [
        {
          kind: 'update',
          model: RECEIPT_ASSOCIATION_MODEL as ModelName,
          id: assocRow.id,
          expectedVersion: assocRow.version,
          row: withAssociationRowData(
            assocRow,
            {
              recordModel: ITEM,
              recordId: 'item-1',
              field: 'notification',
              deliveryId: verdict.association.deliveryId,
              source: verdict.association.source,
              revision: verdict.association.revision,
            },
            { nowMs: FIXED_NOW, actor: ACTOR },
          ),
        },
        {
          kind: 'update',
          model: RECEIPT_MODEL as ModelName,
          id: receiptRow.id,
          expectedVersion: receiptRow.version,
          row: withReceiptRowData(
            receiptRow,
            {
              deliveryId: verdict.receipt.deliveryId,
              revision: verdict.receipt.revision,
              status: verdict.receipt.status,
              result: verdict.receipt.result,
              error: verdict.receipt.error,
              contentRef: null,
              resultExpiresAtMs: null,
            },
            { nowMs: FIXED_NOW, actor: ACTOR },
          ),
        },
      ],
    }),
  );
}

function durableInput(
  world: DurableWorld,
  store: StoragePort,
  over: Partial<SelectedReceiptJoinInput> = {},
): SelectedReceiptJoinInput {
  return {
    locator: { record: { id: 'item-1' }, field: 'notification' },
    selected: ['status'],
    model: ITEM_MODEL,
    schema: world.schema,
    policy: world.policy,
    caller: { actorUserId: world.alice.user.user_id, teamId: world.teamId },
    memberships: world.memberships,
    store,
    nowMs: FIXED_NOW,
    observeSelected: fns.observeSelectedReceipt,
    ...over,
  };
}

function durableSuite(
  name: string,
  handles: () => Promise<{
    store: StoragePort;
    secondHandle: () => StoragePort;
    reset: () => Promise<void>;
  }>,
): void {
  describe(`T25 receipt join durable (${name})`, () => {
    it('persists the pair and observes the status leaf across handles', async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const world = await setupDurableWorld();
      await seedDurableOwner(store);
      await associateDurable(store);
      await progressDurable(store);
      // Cross-handle observation: the peer resolves the stored pair
      // internally (the decoy row value is never trusted) and projects
      // exactly the granted leaf.
      const peer = secondHandle();
      const scope = openFenceScope(await peer.readRevision(), world.teamId);
      const outcome = await observeSelectedReceiptJoin(durableInput(world, peer, { fence: scope }));
      assert.equal(outcome.outcome, 'observed');
      if (outcome.outcome !== 'observed') {
        return;
      }
      assert.deepEqual(outcome.projection, { status: 'succeeded' });
      assert.equal(outcome.fenceRevision, 1);
      assert.equal(scope.dependencies.length, 1);
      const enrolled = scope.dependencies[0];
      assert.deepEqual(enrolled, {
        kind: 'record',
        model: RECEIPT_MODEL,
        id: 'del_1',
        version: (await peer.load(RECEIPT_MODEL as ModelName, asId('del_1')))?.version,
      });
      // The owner row is untouched by receipt progress: same version,
      // same decoy, no domain write.
      const owner = await peer.load(ITEM_MODEL, asId('item-1'));
      assert.ok(owner !== null);
      assert.equal(owner.version, 1);
      assert.equal((owner.data as Record<string, unknown>)['notification'], 'decoy-id');
    });

    it('voids concurrent observations when receipt progress lands first', async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const world = await setupDurableWorld();
      await seedDurableOwner(store);
      await associateDurable(store);
      const scope = openFenceScope(await store.readRevision(), world.teamId);
      const observed = await observeSelectedReceiptJoin(durableInput(world, store, { fence: scope }));
      assert.equal(observed.outcome, 'observed');
      // Intervene through the second handle: progress moves the fence.
      await progressDurable(secondHandle());
      await assert.rejects(
        observeSelectedReceiptJoin(durableInput(world, store, { fence: scope })),
        (error: unknown) =>
          error instanceof StateError &&
          error.code === 'conflict' &&
          /Fence checkpoint moved before this read/.test(error.message),
      );
      await assert.rejects(
        revalidateCommitForFence({
          checkpoint: scope.snapshot(),
          by: 'members',
          guards: [],
          actorUserId: world.alice.user.user_id,
          teamId: world.teamId,
          kind: 'user',
          store,
          memberships: world.memberships,
        }),
        (error: unknown) =>
          error instanceof StateError &&
          error.code === 'conflict' &&
          /Checkpoint moved during the operation/.test(error.message),
      );
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
