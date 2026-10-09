/**
 * T24a dispatch join: durable proofs on REAL substrates.
 *
 * Extends the T31 miniflare-D1 + workerd-DO harness patterns (fenced
 * commits over the real SQLite substrates through the linkage-asserted
 * join port). Proves per substrate: one-revision atomic commit of the
 * trigger batch plus outbox intents plus dispatch rows, atomic rollback
 * on a concurrent trigger change, exactly-once claim under concurrent
 * delivery, and recovery resumption of an interrupted claim with
 * cross-handle read-back. Process-restart survival is explicitly
 * UNCLAIMED (the harness holds ephemeral instances; no persist channel
 * is asserted). Single-owner scope only: cross-store atomicity is NOT
 * claimed and must not be inferred.
 *
 * Dispatch rows are structural literals (this compiled suite cannot
 * runtime-import `@canlang/work` sources); the model pin lives
 * work-side in `t24a-staging-join.test.ts`.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type {
  CommitBatch,
  HistoryEntry,
  ModelName,
  OperationName,
  OutboxIntent,
  RecordId,
  RecordVersion,
  Revision,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import {
  DISPATCH_JOIN_MODEL,
  createDispatchJoinPort,
} from '../../src/ports/transact.js';
import { createD1Storage, ensureSchema } from '../../src/storage/d1.js';
import { FenceConflictError, StorageConstraintError } from '../../src/storage/port.js';
import { FIXED_NOW, asId, asModel } from '../invocation/fixtures.js';

const WIDGET_MODEL = 'Acme.Widget';
const DISPATCH_MODEL = DISPATCH_JOIN_MODEL as ModelName;

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

/* -- Structural join literals (mirroring the lane-4 row shape). -- */

function dispatchRow(intentId: string, over: Record<string, unknown> = {}): StoredRow {
  return {
    id: intentId as RecordId,
    version: 1 as RecordVersion,
    created: FIXED_NOW,
    updated: FIXED_NOW,
    createdBy: 't24a-durable',
    updatedBy: 't24a-durable',
    archivedAt: null,
    parent: null,
    data: {
      intentId,
      operationId: 'op_trigger',
      source: 'std.EmailV1.send',
      occurrenceIndex: 0,
      originOccurrence: null,
      state: 'pending',
      attempts: 0,
      claimId: null,
      claimedAtMs: null,
      guardVerdict: null,
      deliveryId: null,
      errorCode: null,
      errorMessage: null,
      availableAtMs: null,
      firstAttemptAtMs: null,
      retryClass: null,
      ...over,
    },
  };
}

function widgetRow(id: string): StoredRow {
  return {
    id: id as RecordId,
    version: 1 as RecordVersion,
    created: FIXED_NOW,
    updated: FIXED_NOW,
    createdBy: 't24a-durable',
    updatedBy: 't24a-durable',
    archivedAt: null,
    parent: null,
    data: { title: 'Durable' },
  };
}

function joinIntent(intentId: string, operationId: string): OutboxIntent {
  return {
    intentId,
    operation: 'Acme.send' as OperationName,
    operationId: operationId as OutboxIntent['operationId'],
    target: 'std.EmailV1.send',
    arguments: { to: 'a@example.com' },
    occurrenceIndex: 0,
  };
}

function historyFor(recordId: string, operationId: string): HistoryEntry {
  return {
    model: asModel(WIDGET_MODEL),
    recordId: asId(recordId),
    version: 1 as RecordVersion,
    operation: 'Acme.send' as OperationName,
    operationId: operationId as HistoryEntry['operationId'],
    actor: 't24a-durable',
    at: FIXED_NOW,
    change: 'create',
    before: null,
    after: { title: 'Durable' },
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

function durableSuite(
  name: string,
  handles: () => Promise<{
    store: StoragePort;
    secondHandle: () => StoragePort;
    reset: () => Promise<void>;
  }>,
): void {
  describe(`T24a dispatch join durable (${name})`, () => {
    it('commits trigger + history + outbox + dispatch rows in one revision', async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const port = createDispatchJoinPort({ store });
      const operationId = 'op_dl_join';
      const committed = await port.commitJoin({
        expectedRevision: await store.readRevision(),
        writes: [
          { kind: 'insert', model: asModel(WIDGET_MODEL), row: widgetRow('dj-w1') },
          { kind: 'insert', model: DISPATCH_MODEL, row: dispatchRow('dj-i1') },
        ],
        history: [historyFor('dj-w1', operationId)],
        receipt: null,
        outbox: [joinIntent('dj-i1', operationId)],
        schedules: [],
        uniqueClaims: [],
        uniqueReleases: [],
      });
      assert.equal(committed.revision, 1);
      assert.equal(await store.readRevision(), 1);
      // Cross-handle read-back: every half of the join is durable.
      const peer = secondHandle();
      assert.deepEqual((await peer.load(asModel(WIDGET_MODEL), asId('dj-w1')))?.data, {
        title: 'Durable',
      });
      assert.deepEqual(
        (await peer.outboxPending()).map((intent) => intent.intentId),
        ['dj-i1'],
      );
      const row = await peer.load(DISPATCH_MODEL, asId('dj-i1'));
      assert.ok(row !== null);
      assert.equal((row!.data as Record<string, unknown>)['state'], 'pending');
      assert.equal((await peer.historyFor(asModel(WIDGET_MODEL), asId('dj-w1'))).length, 1);
    });

    it('voids the join on a concurrent trigger change (fence)', async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const port = createDispatchJoinPort({ store });
      const fence = await store.readRevision();
      // Intervene through the second handle: the fence moves first.
      const peer = secondHandle();
      await peer.commit({
        expectedRevision: fence,
        writes: [{ kind: 'insert', model: asModel(WIDGET_MODEL), row: widgetRow('dj-decoy') }],
        history: [],
        receipt: null,
        outbox: [],
        schedules: [],
        uniqueClaims: [],
        uniqueReleases: [],
      });
      const failure = await captureFailure(
        port.commitJoin({
          expectedRevision: fence,
          writes: [
            { kind: 'insert', model: asModel(WIDGET_MODEL), row: widgetRow('dj-w2') },
            { kind: 'insert', model: DISPATCH_MODEL, row: dispatchRow('dj-i2') },
          ],
          history: [historyFor('dj-w2', 'op_dl_void')],
          receipt: null,
          outbox: [joinIntent('dj-i2', 'op_dl_void')],
          schedules: [],
          uniqueClaims: [],
          uniqueReleases: [],
        }),
      );
      // The port maps fence conflicts to retryable busy; either layer name
      // proves the join lost atomically (D1 direct vs DO rehydration).
      assert.match(failure.name, /FenceConflictError|StateError/);
      assert.equal(await store.readRevision(), (fence as number) + 1);
      assert.equal(await peer.load(asModel(WIDGET_MODEL), asId('dj-w2')), null);
      assert.deepEqual(await peer.outboxPending(), []);
      assert.equal(await peer.load(DISPATCH_MODEL, asId('dj-i2')), null);
      assert.deepEqual(await peer.historyFor(asModel(WIDGET_MODEL), asId('dj-w2')), []);
    });

    it('grants exactly one winner under concurrent claim delivery', async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const port = createDispatchJoinPort({ store });
      await port.commitJoin({
        expectedRevision: await store.readRevision(),
        writes: [{ kind: 'insert', model: DISPATCH_MODEL, row: dispatchRow('dj-race') }],
        history: [],
        receipt: null,
        outbox: [joinIntent('dj-race', 'op_dl_race')],
        schedules: [],
        uniqueClaims: [],
        uniqueReleases: [],
      });
      const fence = await store.readRevision();
      const claimBatch = (claimId: string): CommitBatch => ({
        expectedRevision: fence,
        writes: [
          {
            kind: 'update',
            model: DISPATCH_MODEL,
            id: asId('dj-race'),
            expectedVersion: 1 as RecordVersion,
            row: {
              ...dispatchRow('dj-race'),
              version: 2 as RecordVersion,
              updated: FIXED_NOW + 1,
              data: {
                ...(dispatchRow('dj-race').data as Record<string, unknown>),
                state: 'claimed',
                claimId,
                claimedAtMs: FIXED_NOW,
              },
            },
          },
        ],
        history: [],
        receipt: null,
        outbox: [],
        schedules: [],
        uniqueClaims: [],
        uniqueReleases: [],
      });
      // Both claimants build from the same fence + row version, then race.
      // The fence_log INSERT inside the atomic batch serializes them.
      const raced = await Promise.allSettled([
        store.commit(claimBatch('claim_A')),
        store.commit(claimBatch('claim_B')),
      ]);
      const winners = raced.filter((outcome) => outcome.status === 'fulfilled');
      const losers = raced.filter((outcome) => outcome.status === 'rejected');
      assert.equal(winners.length, 1);
      assert.equal(losers.length, 1);
      const loser = losers[0] as PromiseRejectedResult;
      assert.match((loser.reason as Error).name, /FenceConflictError|StorageConstraintError/);
      // Exactly one fence step for the race; the winner's claim is durable.
      assert.equal(await store.readRevision(), (fence as number) + 1);
      const peer = secondHandle();
      const row = await peer.load(DISPATCH_MODEL, asId('dj-race'));
      assert.ok(row !== null);
      const data = row!.data as Record<string, unknown>;
      assert.equal(data['state'], 'claimed');
      assert.ok(data['claimId'] === 'claim_A' || data['claimId'] === 'claim_B');
    });

    it('resumes an interrupted claim through release plus reclaim', async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const port = createDispatchJoinPort({ store });
      await port.commitJoin({
        expectedRevision: await store.readRevision(),
        writes: [{ kind: 'insert', model: DISPATCH_MODEL, row: dispatchRow('dj-rec') }],
        history: [],
        receipt: null,
        outbox: [joinIntent('dj-rec', 'op_dl_rec')],
        schedules: [],
        uniqueClaims: [],
        uniqueReleases: [],
      });
      const claim = async (claimId: string, at: number): Promise<void> => {
        const current = await store.load(DISPATCH_MODEL, asId('dj-rec'));
        assert.ok(current !== null);
        await store.commit({
          expectedRevision: await store.readRevision(),
          writes: [
            {
              kind: 'update',
              model: DISPATCH_MODEL,
              id: asId('dj-rec'),
              expectedVersion: current!.version,
              row: {
                ...current!,
                version: ((current!.version as number) + 1) as RecordVersion,
                updated: at,
                data: {
                  ...(current!.data as Record<string, unknown>),
                  state: 'claimed',
                  claimId,
                  claimedAtMs: at,
                },
              },
            },
          ],
          history: [],
          receipt: null,
          outbox: [],
          schedules: [],
          uniqueClaims: [],
          uniqueReleases: [],
        });
      };
      await claim('claim_old', FIXED_NOW);
      // Recovery releases the stale claim back to pending (the fenced
      // recover path), then a fresh worker reclaims the same intent.
      const held = await store.load(DISPATCH_MODEL, asId('dj-rec'));
      assert.ok(held !== null);
      await store.commit({
        expectedRevision: await store.readRevision(),
        writes: [
          {
            kind: 'update',
            model: DISPATCH_MODEL,
            id: asId('dj-rec'),
            expectedVersion: held!.version,
            row: {
              ...held!,
              version: ((held!.version as number) + 1) as RecordVersion,
              updated: FIXED_NOW + 61_000,
              data: {
                ...(held!.data as Record<string, unknown>),
                state: 'pending',
                claimId: null,
                claimedAtMs: null,
              },
            },
          },
        ],
        history: [],
        receipt: null,
        outbox: [],
        schedules: [],
        uniqueClaims: [],
        uniqueReleases: [],
      });
      await claim('claim_new', FIXED_NOW + 61_000);
      const peer = secondHandle();
      const row = await peer.load(DISPATCH_MODEL, asId('dj-rec'));
      assert.ok(row !== null);
      const data = row!.data as Record<string, unknown>;
      assert.equal(data['state'], 'claimed');
      assert.equal(data['claimId'], 'claim_new');
      assert.equal(data['claimedAtMs'], FIXED_NOW + 61_000);
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
