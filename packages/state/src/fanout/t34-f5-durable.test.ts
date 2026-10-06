/**
 * T34-F5 durable proofs: REAL kill/restart on file-backed local D1
 * (miniflare) and workerd DO SQLite, reached through the state-owned
 * harness patterns (the miniflare CWD anchor plus the
 * `do-test-worker.js` StoragePort proxy, reused read-only) with
 * per-test persist dirs.
 *
 * Each case commits pre-crash fanout truth through the REAL F5 joins
 * (freeze, child-unit drive), DISPOSES its miniflare instance (the
 * kill: workerd torn down, uncommitted work lost), boots a FRESH
 * instance over the SAME persist dir (the restart), then verifies
 * purely from durable truth via crash-observers, re-freezing, and the
 * REAL F4 recovery scan. That is actual restart, not two live handles.
 *
 * Proves durable (M1/M2/M4/M5/C4/C5/C6): 501-identity freeze exactness
 * with late-insert exclusion across restart; enumeration-crash resume
 * to a fully admitted cursor-null checkpoint; child-unit atomicity
 * across restart (complete stays complete, unclaimed stays absent,
 * mid-claim stays held-then-resumable); the per-child fence re-reading
 * live authority post-restart (revoked child fails
 * inaccessible-record); and minimized terminal+attention progress.
 *
 * Single-owner scope only: cross-store atomicity is NOT claimed.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type {
  ModelName,
  RecordId,
  Revision,
  StoragePort,
  StoredRow,
} from '../../../contracts/src/state.js';
import type { ResolvedIdentity } from '../../../contracts/src/identity.js';
import type { RetryPolicy } from '../../../contracts/src/work.js';
import { createD1Storage, ensureSchema } from '../storage/d1.js';
import { FenceConflictError, StorageConstraintError } from '../storage/port.js';
import type { OperationRegistry } from '../invocation/registry.js';
import type { MembershipReader } from '../policy/roles.js';
import {
  FANOUT_CHECKPOINT_MODEL,
  FANOUT_CHILD_MODEL,
  FANOUT_INTENT_MODEL,
  fanoutChildRowId,
  fanoutIntentRowId,
  readFanoutCheckpointRow,
  readFanoutChildRow,
  withFanoutRowData,
} from './tables.js';
import { freezeFanoutMembership } from './membership.js';
import { classifyFanoutChildLifecycle } from './lifecycle.js';
import { readFanoutProgress } from './progress.js';
import { driveFanoutChild, observeFanoutUnit } from './test-driver.js';
import { loadWorkFanoutFns, type WorkFanoutFns } from './work-loader.js';
import {
  FIXED_NOW,
  asId,
  asModel,
  asOperation,
  createMemoryIdentityStore,
  makeBatch,
  makeDef,
  makeIdentity,
  makeRow,
  seedMember,
  uuidv7,
  type TestMembershipStore,
} from '../../test/invocation/fixtures.js';

const MODEL = 'Acme.Commitment';
const HANDLER = 'Shift.review_commitment';
const SOURCE = 'occ-dur-1';
const APP = 'acme-app';
const CHILD_OP = 'Acme.review_child';
const ACTOR = 't34-f5-durable';
const META = { nowMs: FIXED_NOW, actor: ACTOR };
const POLICY: RetryPolicy = { maxAttempts: 3, horizonMs: 60_000 };

const fns: WorkFanoutFns = await loadWorkFanoutFns();

/**
 * CWD anchor (the F2/F4 lesson): workerd mounts its module filesystem
 * at the miniflare host's process CWD, and the reused DO worker's
 * relative adapter import resolves under `@canlang/state`. Anchor the
 * process CWD at the state package for the run and restore it
 * afterwards; node:test runs each file in its own process, so the
 * anchor cannot leak into other suites. Every path here is
 * import.meta-derived absolute, so the anchor moves nothing but the
 * workerd mount.
 */
const stateDirPath = fileURLToPath(new URL('../../../../', import.meta.url));
const entryCwd = process.cwd();
process.chdir(stateDirPath);

after(() => {
  process.chdir(entryCwd);
});

/** State-owned DO proxy worker, reused read-only (never edited here). */
const doWorkerPath = fileURLToPath(
  new URL('../../../../test/storage/do-test-worker.js', import.meta.url),
);

/* -- Restartable substrate: boot -> kill (dispose) -> reboot (same dir). -- */

type SubstrateKind = 'd1' | 'do';

interface Restartable {
  readonly kind: SubstrateKind;
  /** Boot a fresh instance over the persist dir; returns its store. */
  start: () => Promise<StoragePort>;
  /** The kill: dispose the instance; uncommitted work is lost. */
  kill: () => Promise<void>;
}

interface WorkerErrorJson {
  readonly name: string;
  readonly message: string;
  readonly kind?: string;
  readonly detail?: string;
  readonly expected?: number;
  readonly actual?: number | null;
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

function doProxy(mf: Miniflare): StoragePort {
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const response = await mf.dispatchFetch(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await response.json()) as Record<string, unknown>;
  };
  const call = async <T>(method: string, ...args: ReadonlyArray<unknown>): Promise<T> => {
    const data = await post('/call', { method, args });
    if (data['ok'] !== true) {
      throw rehydrate(data['error'] as unknown as WorkerErrorJson);
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
    readStagedRows: (migrationId, cursor, limit) => call('readStagedRows', migrationId, cursor, limit),
    stageMigrationRows: (input) => call('stageMigrationRows', input),
    publishMigrationChunk: (input) => call('publishMigrationChunk', input),
    flipInstalledSnapshot: (input) => call('flipInstalledSnapshot', input),
    readMigrationOutcomes: (migrationId) => call('readMigrationOutcomes', migrationId),
    recordMigrationFailure: (input) => call('recordMigrationFailure', input),
    discardStagedRows: (input) => call('discardStagedRows', input),
    readMigrationFailure: (migrationId) => call('readMigrationFailure', migrationId),
  };
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
      const db = (await mf.getD1Database('DB')) as D1Database;
      await ensureSchema(db);
      return createD1Storage(db);
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
    return doProxy(mf);
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
  const dir = await mkdtemp(join(tmpdir(), `t34f5-${kind}-${label}-`));
  const sub = await openRestartable(kind, dir);
  try {
    await fn(sub);
  } finally {
    await sub.kill().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

/* -- Shared durable world + helpers. -- */

interface DurableWorld {
  readonly memberships: TestMembershipStore;
  readonly registry: OperationRegistry;
  readonly identity: ResolvedIdentity;
  readonly owner: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly clock: { nowMs(): number };
}

async function setupDurableWorld(): Promise<DurableWorld> {
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const registry: OperationRegistry = new Map();
  (registry as Map<string, unknown>).set(
    CHILD_OP,
    makeDef({
      name: asOperation(CHILD_OP),
      by: 'members',
      inputs: {
        record: { type: 'record', model: asModel(MODEL), versioned: false, required: true },
      },
    }),
  );
  return {
    memberships,
    registry,
    identity: makeIdentity({ membership: alice.membership }),
    owner: alice.team.team_id as string,
    userId: alice.user.user_id as string,
    membershipId: alice.membership.membership_id as string,
    clock: { nowMs: () => FIXED_NOW },
  };
}

async function seedRecords(
  store: StoragePort,
  model: string,
  ids: ReadonlyArray<string>,
  chunk = 100,
): Promise<void> {
  for (let index = 0; index < ids.length; index += chunk) {
    const slice = ids.slice(index, index + chunk);
    const revision = await store.readRevision();
    await store.commit(
      makeBatch(revision as number, {
        writes: slice.map((id) => ({
          kind: 'insert' as const,
          model: asModel(model),
          row: makeRow({ id, data: { label: id } }),
        })),
      }),
    );
  }
}

async function drainChildIds(store: StoragePort, fanoutId: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const rows = await store.query({
      model: FANOUT_CHILD_MODEL as ModelName,
      where:
        cursor === null
          ? { op: 'eq', field: 'fanoutId', value: fanoutId }
          : {
              op: 'and',
              args: [
                { op: 'eq', field: 'fanoutId', value: fanoutId },
                { op: 'gt', field: 'id', value: cursor },
              ],
            },
      order: [{ field: 'id', direction: 'asc' }],
      limit: 64,
      authority: 'owner',
    });
    for (const row of rows) {
      ids.push(readFanoutChildRow(row).recordId);
    }
    if (rows.length < 64) {
      return ids.sort();
    }
    const last = rows[rows.length - 1];
    if (last === undefined) {
      throw new Error('unreachable empty full page in test drain');
    }
    cursor = last.id as string;
  }
}

function markBody() {
  return async (row: StoredRow) => {
    const next: StoredRow = {
      ...row,
      version: (row.version + 1) as StoredRow['version'],
      updated: FIXED_NOW,
      updatedBy: ACTOR,
      data: { ...(row.data as Record<string, unknown>), reviewed: true },
    };
    return {
      writes: [
        {
          kind: 'update' as const,
          model: asModel(MODEL),
          id: row.id,
          expectedVersion: row.version,
          row: next,
        },
      ],
      history: [
        {
          model: asModel(MODEL),
          recordId: row.id,
          version: next.version,
          operation: asOperation(CHILD_OP),
          operationId: 'op-body' as never,
          actor: ACTOR,
          at: FIXED_NOW,
          change: 'update' as const,
          before: row.data as Record<string, unknown>,
          after: next.data as Record<string, unknown>,
        },
      ],
      outbox: [],
      schedules: [],
      result: { kind: 'completed' as const },
    };
  };
}

async function driveOn(
  world: DurableWorld,
  store: StoragePort,
  fanoutId: string,
  recordId: string,
  operationId: string,
): Promise<ReturnType<typeof driveFanoutChild>> {
  return driveFanoutChild({
    store,
    memberships: world.memberships as MembershipReader,
    registry: world.registry,
    clock: world.clock,
    identity: world.identity,
    app: APP,
    source: 'test.fanout',
    childOperation: CHILD_OP,
    operationId,
    refInput: 'record',
    driven: {
      child: { parentOccurrence: SOURCE, handler: HANDLER, recordId },
      fanoutId,
      model: MODEL,
      recordId,
    },
    guard: () => true,
    body: markBody(),
    nowMs: FIXED_NOW,
    firstAttemptAtMs: FIXED_NOW,
    policy: POLICY,
    meta: META,
  });
}

/* -- Per-substrate durable cases. -- */

for (const kind of ['d1', 'do'] as const satisfies ReadonlyArray<SubstrateKind>) {
  describe(`t34-f5 durable on ${kind}`, () => {
    it('M1/M4 freeze exact at 501 + late-insert exclusion across restart', async () => {
      await withRestart(kind, 'freeze', async (sub) => {
        const world = await setupDurableWorld();
        const store = await sub.start();
        const ids = Array.from({ length: 501 }, (_, index) => `w-${String(index).padStart(4, '0')}`);
        await seedRecords(store, MODEL, ids);
        const outcome = await freezeFanoutMembership({
          store,
          cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
          cohort: { kind: 'model', owner: world.owner, model: MODEL },
          owner: world.owner,
          bounds: { pageLimit: 64, chunkSize: 100, maxAttempts: 5 },
          meta: META,
        });
        assert.equal(outcome.ok, true);
        if (!outcome.ok) {
          return;
        }
        assert.equal(outcome.frozen.members.length, 501);
        // THE KILL + RESTART.
        await sub.kill();
        const rebooted = await sub.start();
        // Durable truth survives: the intent reads through the REAL F2
        // reader, all 501 children drain, the cursor is null.
        const intentRow = await rebooted.load(
          FANOUT_INTENT_MODEL as ModelName,
          outcome.frozen.fanoutId as RecordId,
        );
        assert.ok(intentRow !== null);
        assert.equal(fns.readFanoutIntentRow(intentRow).memberCount, 501);
        assert.deepEqual(await drainChildIds(rebooted, outcome.frozen.fanoutId), [...ids].sort());
        const checkpointRow = await rebooted.load(
          FANOUT_CHECKPOINT_MODEL as ModelName,
          outcome.frozen.fanoutId as RecordId,
        );
        assert.ok(checkpointRow !== null);
        assert.equal(readFanoutCheckpointRow(checkpointRow).cursor, null);
        // Late insert post-restart: excluded from the occurrence.
        await seedRecords(rebooted, MODEL, ['late-durable-1']);
        assert.ok(!outcome.frozen.members.includes('late-durable-1'));
        assert.equal(
          await rebooted.load(
            FANOUT_CHILD_MODEL as ModelName,
            fanoutChildRowId(SOURCE, HANDLER, 'late-durable-1') as RecordId,
          ),
          null,
        );
      });
    });

    it('M2 enumeration crash resumes to fully admitted across restart', async () => {
      await withRestart(kind, 'enum-crash', async (sub) => {
        const world = await setupDurableWorld();
        const store = await sub.start();
        const ids = Array.from({ length: 150 }, (_, index) => `e-${String(index).padStart(4, '0')}`);
        await seedRecords(store, MODEL, ids);
        let commits = 0;
        const crashing: StoragePort = {
          ...store,
          commit: async (batch) => {
            commits += 1;
            if (commits === 2) {
              throw new Error('boom: process died mid-admission');
            }
            return store.commit(batch);
          },
        };
        const crashed = await freezeFanoutMembership({
          store: crashing,
          cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
          cohort: { kind: 'model', owner: world.owner, model: MODEL },
          owner: world.owner,
          bounds: { pageLimit: 64, chunkSize: 50, maxAttempts: 5 },
          meta: META,
        });
        assert.equal(crashed.ok, false);
        const fanoutId = fanoutIntentRowId(SOURCE, HANDLER, 'model');
        // THE KILL + RESTART (the partial admission is durable truth now).
        await sub.kill();
        const rebooted = await sub.start();
        const partial = await rebooted.load(
          FANOUT_CHECKPOINT_MODEL as ModelName,
          fanoutId as RecordId,
        );
        assert.ok(partial !== null);
        assert.notEqual(readFanoutCheckpointRow(partial).cursor, null);
        // Re-freezing replays the stored set and admits the remainder.
        const resumed = await freezeFanoutMembership({
          store: rebooted,
          cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
          cohort: { kind: 'model', owner: world.owner, model: MODEL },
          owner: world.owner,
          bounds: { pageLimit: 64, chunkSize: 50, maxAttempts: 5 },
          meta: META,
        });
        assert.equal(resumed.ok, true);
        if (!resumed.ok) {
          return;
        }
        assert.equal(resumed.frozen.replayed, true);
        assert.deepEqual([...resumed.frozen.members].sort(), [...ids].sort());
        assert.deepEqual(await drainChildIds(rebooted, fanoutId), [...ids].sort());
        const finished = await rebooted.load(
          FANOUT_CHECKPOINT_MODEL as ModelName,
          fanoutId as RecordId,
        );
        assert.ok(finished !== null);
        assert.equal(readFanoutCheckpointRow(finished).cursor, null);
      });
    });

    it('M2/M5/C4/C5/C6 child unit + claim crash + fence, then terminal+attention', async () => {
      await withRestart(kind, 'unit-fence', async (sub) => {
        const world = await setupDurableWorld();
        const store = await sub.start();
        await seedRecords(store, MODEL, ['u-a', 'u-b', 'u-c', 'u-d']);
        const frozen = await freezeFanoutMembership({
          store,
          cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
          cohort: { kind: 'model', owner: world.owner, model: MODEL },
          owner: world.owner,
          bounds: { pageLimit: 16, chunkSize: 16, maxAttempts: 5 },
          meta: META,
        });
        assert.equal(frozen.ok, true);
        if (!frozen.ok) {
          return;
        }
        const fanoutId = frozen.frozen.fanoutId;
        // Child A drives to a full unit pre-crash.
        const opA = uuidv7(FIXED_NOW, 101);
        assert.equal((await driveOn(world, store, fanoutId, 'u-a', opA)).status, 'recorded');
        // Child B claims (pending→running) and the process dies before
        // its unit commit: the claim instant rides `updated`.
        const childB = fanoutChildRowId(SOURCE, HANDLER, 'u-b');
        const pendingB = await store.load(FANOUT_CHILD_MODEL as ModelName, childB as RecordId);
        assert.ok(pendingB !== null);
        const revClaim = await store.readRevision();
        await store.commit(
          makeBatch(revClaim as number, {
            writes: [
              {
                kind: 'update',
                model: FANOUT_CHILD_MODEL as ModelName,
                id: childB as RecordId,
                expectedVersion: pendingB.version,
                row: withFanoutRowData(
                  pendingB,
                  { ...readFanoutChildRow(pendingB), state: 'running' },
                  { nowMs: FIXED_NOW, actor: ACTOR },
                ),
              },
            ],
          }),
        );
        // Revocation lands pre-crash too: the post-restart fence must see it.
        await world.memberships.removeMembership(world.membershipId);
        // THE KILL + RESTART.
        await sub.kill();
        const rebooted = await sub.start();
        // Crash-observers on durable truth: A is complete (survived
        // whole); B has NO outcome and NO checkpoint cover (its claim
        // committed, its unit never did — nothing partial); C/D absent.
        assert.deepEqual(
          await observeFanoutUnit({
            store: rebooted,
            fanoutId,
            child: { parentOccurrence: SOURCE, handler: HANDLER, recordId: 'u-a' },
            domain: { model: MODEL, id: 'u-a', marker: 'reviewed' },
            receipt: {
              app: APP,
              owner: world.owner,
              principal: world.userId,
              operation: CHILD_OP,
              operationId: opA,
            },
            outboxIntentId: null,
            scheduleKey: null,
          }),
          { verdict: 'complete' },
        );
        assert.deepEqual(
          await observeFanoutUnit({
            store: rebooted,
            fanoutId,
            child: { parentOccurrence: SOURCE, handler: HANDLER, recordId: 'u-b' },
            domain: { model: MODEL, id: 'u-b', marker: 'reviewed' },
            receipt: null,
            outboxIntentId: null,
            scheduleKey: null,
          }),
          { verdict: 'absent' },
        );
        // The REAL F4 scan plans B's resume: running + stale claim +
        // present lifecycle + guard-true within budget → resume.
        const storedIntent = await rebooted.load(FANOUT_INTENT_MODEL as ModelName, fanoutId as RecordId);
        const storedCheckpoint = await rebooted.load(
          FANOUT_CHECKPOINT_MODEL as ModelName,
          fanoutId as RecordId,
        );
        const storedB = await rebooted.load(FANOUT_CHILD_MODEL as ModelName, childB as RecordId);
        assert.ok(storedIntent !== null && storedCheckpoint !== null && storedB !== null);
        const lifecycleB = await classifyFanoutChildLifecycle({
          store: rebooted,
          model: MODEL,
          recordId: 'u-b',
        });
        assert.deepEqual(lifecycleB, { status: 'present' });
        const plan = fns.planFanoutRecoveryScan({
          fanoutId,
          intent: fns.readFanoutIntentRow(storedIntent),
          checkpoint: fns.readFanoutCheckpointRow(storedCheckpoint),
          rows: [
            {
              child: fns.readFanoutChildRow(storedB),
              claimedAtMs: storedB.updated,
              guardVerdict: true,
              firstAttemptAtMs: null,
              lifecycle: lifecycleB,
            },
          ],
          nowMs: FIXED_NOW + 5000,
          maxClaimAgeMs: 1000,
          policy: POLICY,
        });
        assert.deepEqual(plan.resume, [childB as string]);
        // Execute the planned resume (running→pending), then drive B:
        // the post-restart fence sees the revocation and refuses.
        const revResume = await rebooted.readRevision();
        await rebooted.commit(
          makeBatch(revResume as number, {
            writes: [
              {
                kind: 'update',
                model: FANOUT_CHILD_MODEL as ModelName,
                id: childB as RecordId,
                expectedVersion: storedB.version,
                row: withFanoutRowData(
                  storedB,
                  { ...readFanoutChildRow(storedB), state: 'pending' },
                  META,
                ),
              },
            ],
          }),
        );
        const refusedB = await driveOn(world, rebooted, fanoutId, 'u-b', uuidv7(FIXED_NOW, 102));
        assert.equal(refusedB.status, 'recorded');
        const rowB = await rebooted.load(FANOUT_CHILD_MODEL as ModelName, childB as RecordId);
        assert.ok(rowB !== null);
        assert.equal(readFanoutChildRow(rowB).state, 'failed');
        assert.equal(readFanoutChildRow(rowB).causeReason, 'inaccessible-record');
        // Re-grant; C and D complete. Progress: terminal + attention.
        await world.memberships.createMembership({
          team_id: world.owner as never,
          user_id: world.userId as never,
          is_owner: false,
          roles: [],
        });
        assert.equal(
          (await driveOn(world, rebooted, fanoutId, 'u-c', uuidv7(FIXED_NOW, 103))).status,
          'recorded',
        );
        assert.equal(
          (await driveOn(world, rebooted, fanoutId, 'u-d', uuidv7(FIXED_NOW, 104))).status,
          'recorded',
        );
        const progress = await readFanoutProgress({ store: rebooted, fanoutId, pageLimit: 2 });
        assert.deepEqual(progress, {
          fanoutId,
          pending: 0,
          running: 0,
          completed: 3,
          skipped: 0,
          failed: 1,
          terminal: true,
          attention: true,
        });
        assert.deepEqual(Object.keys(progress).sort(), [
          'attention',
          'completed',
          'failed',
          'fanoutId',
          'pending',
          'running',
          'skipped',
          'terminal',
        ]);
      });
    });
  });
}
