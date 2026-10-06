/**
 * T34-F4 durable proofs: REAL kill/restart resume on file-backed local D1
 * (miniflare) and workerd DO SQLite, reached through the state-owned
 * harness patterns (the miniflare anchor plus the `do-test-worker.js`
 * StoragePort proxy, reused read-only) with per-test persist dirs.
 *
 * Each case commits pre-crash fanout rows (F2 shapes), DISPOSES its
 * miniflare instance (the kill: workerd torn down, uncommitted work
 * lost), boots a FRESH instance over the SAME persist dir (the
 * restart), then plans (`planFanoutRecoveryScan`) and resumes purely
 * from durable truth. That is actual restart, not two live handles.
 *
 * miniflare itself is NOT a `@canlang/work` dependency: this suite
 * loads it through the require anchored at `@canlang/state`, which
 * owns the durable harness. If that anchor ever stops resolving,
 * these tests fail loudly instead of silently falling back to
 * memory — durability is never claimed off a weaker substrate.
 *
 * Honest boundaries (what this suite does NOT claim):
 * - Guard verdicts, lifecycle lookups and first-attempt anchors are
 *   injected test doubles for the F3/F5 producers (the scan consumes
 *   them read-only); only the ROWS are durable here.
 * - Terminal recording (outcome + checkpoint + effect marker in one
 *   owner batch) is a TEST-ONLY driver modeling the F5-owned atomic
 *   child commit (§C5); F4 ships the scan, never the writes.
 * - Claim instants ride the running rows' `updated` stamps (logical
 *   test clock); the substrates persist them as ordinary metadata.
 * - Single-owner scope only: cross-store atomicity is NOT claimed.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CommitBatch,
  DomainWrite,
  ModelName,
  RecordId,
  RecordVersion,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import type {
  FanoutFailedReason,
  FanoutSkippedReason,
  RetryPolicy,
} from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { StorageConstraintError } from '@canlang/state/storage/port';
import {
  WORK_FANOUT_CHECKPOINT_MODEL,
  WORK_FANOUT_CHILD_MODEL,
  WORK_FANOUT_INTENT_MODEL,
  fanoutChildPageQuery,
  fanoutChildPageResult,
  fanoutChildRowId,
  fanoutIntentRowId,
  newFanoutCheckpointRow,
  newFanoutChildRow,
  newFanoutIntentRow,
  nextFanoutCheckpointData,
  readFanoutCheckpointRow,
  readFanoutChildRow,
  readFanoutIntentRow,
  withRowData,
} from '../kernel/tables.js';
import { planFanoutRecoveryScan } from './index.js';
import type { FanoutChildLifecycle, FanoutRecoverableRow } from './index.js';

const ACTOR = 't34-f4-durable';
const META = { nowMs: 1_758_000_000_000, actor: ACTOR };
const T0 = META.nowMs;
const MAX_AGE = 1000;
const POLICY: RetryPolicy = { maxAttempts: 3, horizonMs: 60_000 };
const HANDLER = 'Shift.review_commitment';

/* -- miniflare is declared by the owning work test package. -- */

const stateRequire = createRequire(import.meta.url);

interface MiniflareHandle {
  getD1Database(name: string): Promise<unknown>;
  dispatchFetch(
    input: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ json(): Promise<unknown> }>;
  dispose(): Promise<void>;
}

type MiniflareCtor = new (opts: Record<string, unknown>) => MiniflareHandle;

const { Miniflare } = stateRequire('miniflare') as { Miniflare: MiniflareCtor };

type D1Handle = Parameters<typeof createD1Storage>[0];

/** State-owned DO proxy worker, reused read-only (never edited here). */
const doWorkerPath = fileURLToPath(
  new URL(import.meta.resolve('@canlang/state/testing/storage/do-test-worker')),
);

/**
 * workerd mounts its module filesystem at the miniflare host's
 * process CWD (the F2-verified lesson: `rootPath` does NOT move it).
 * This suite anchors the process CWD at the state package for the
 * run and restores it afterwards. node:test runs each file in its
 * own process, so the anchor cannot leak into other suites; every
 * path here is import.meta-derived absolute, so the anchor moves
 * nothing but the workerd mount.
 */
const stateDirPath = fileURLToPath(new URL('../../', import.meta.resolve('@canlang/state/distribution')));
const entryCwd = process.cwd();

before(() => {
  process.chdir(stateDirPath);
});

after(() => {
  process.chdir(entryCwd);
});

interface WorkerErrorJson {
  readonly name: string;
  readonly message: string;
  readonly kind?: string;
  readonly detail?: string;
}

function rehydrate(error: WorkerErrorJson): Error {
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

async function doPost(
  mf: MiniflareHandle,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await mf.dispatchFetch(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

async function doCall<T>(
  mf: MiniflareHandle,
  method: string,
  ...args: ReadonlyArray<unknown>
): Promise<T> {
  const data = await doPost(mf, '/call', { method, args });
  if (data['ok'] !== true) {
    throw rehydrate(data['error'] as unknown as WorkerErrorJson);
  }
  return data['value'] as T;
}

function doProxy(mf: MiniflareHandle): StoragePort {
  return {
    readRevision: () => doCall(mf, 'readRevision'),
    load: (model: ModelName, id: RecordId) => doCall(mf, 'load', model, id),
    query: (spec: Parameters<StoragePort['query']>[0]) => doCall(mf, 'query', spec),
    commit: (batch: CommitBatch) => doCall(mf, 'commit', batch),
  } as StoragePort;
}

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
  let mf: MiniflareHandle | undefined;
  const start = async (): Promise<StoragePort> => {
    if (kind === 'd1') {
      mf = new Miniflare({
        modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        d1Databases: ['DB'],
        d1Persist: join(dir, 'd1'),
      });
      const db = (await mf.getD1Database('DB')) as D1Handle;
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
  const dir = await mkdtemp(join(tmpdir(), `t34f4-${kind}-${label}-`));
  const sub = await openRestartable(kind, dir);
  try {
    await fn(sub);
  } finally {
    await sub.kill().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

/* -- Commit + drain helpers (the F2 durable shape). -- */

async function commitWrites(
  store: StoragePort,
  writes: ReadonlyArray<DomainWrite>,
): Promise<void> {
  const batch: CommitBatch = {
    expectedRevision: await store.readRevision(),
    writes,
    history: [],
    receipt: null,
    outbox: [],
    schedules: [],
    uniqueClaims: [],
    uniqueReleases: [],
  };
  await store.commit(batch);
}

async function drainChildren(store: StoragePort, fanoutId: string): Promise<StoredRow[]> {
  let cursor: string | null = null;
  const rows: StoredRow[] = [];
  for (;;) {
    const page = fanoutChildPageResult(
      await store.query(fanoutChildPageQuery(fanoutId, { cursor, limit: 64 })),
      64,
    );
    rows.push(...page.rows);
    if (page.done) {
      return rows;
    }
    cursor = page.cursor;
  }
}

/* -- TEST-ONLY driver: models the F5-owned atomic child commit (§C5). -- */

const EFFECT_MODEL = 'test.fanout_effect' as ModelName;

function effectRowId(childId: string): string {
  return `effect/${childId}`;
}

function newEffectRow(childId: string, nowMs: number): StoredRow {
  return {
    id: effectRowId(childId) as RecordId,
    version: 1 as RecordVersion,
    created: nowMs,
    updated: nowMs,
    createdBy: ACTOR,
    updatedBy: ACTOR,
    archivedAt: null,
    parent: null,
    data: { childId, recordedAtMs: nowMs },
  };
}

async function effectExists(store: StoragePort, childId: string): Promise<boolean> {
  return (
    (await store.load(EFFECT_MODEL, effectRowId(childId) as RecordId)) !== null
  );
}

interface FanoutCtx {
  readonly occurrence: string;
  readonly fanoutId: string;
}

function fanoutCtx(occurrence: string): FanoutCtx {
  return { occurrence, fanoutId: fanoutIntentRowId(occurrence, HANDLER, 'model') };
}

function childIdOf(ctx: FanoutCtx, recordId: string): string {
  return fanoutChildRowId(ctx.occurrence, HANDLER, recordId);
}

/** Commit the intent + initial checkpoint (enumeration cursor open). */
async function commitIntent(
  store: StoragePort,
  ctx: FanoutCtx,
  members: ReadonlyArray<string>,
  nowMs: number,
): Promise<void> {
  await commitWrites(store, [
    {
      kind: 'insert',
      model: WORK_FANOUT_INTENT_MODEL,
      row: newFanoutIntentRow(
        { sourceOccurrence: ctx.occurrence, handler: HANDLER, cohort: 'model', members },
        { nowMs, actor: ACTOR },
      ),
    },
    {
      kind: 'insert',
      model: WORK_FANOUT_CHECKPOINT_MODEL,
      row: newFanoutCheckpointRow(
        { fanoutId: ctx.fanoutId, cursor: 'start' },
        { nowMs, actor: ACTOR },
      ),
    },
  ]);
}

/** Admit one member + advance the enumeration cursor, atomically. */
async function admitMember(
  store: StoragePort,
  ctx: FanoutCtx,
  recordId: string,
  nowMs: number,
): Promise<void> {
  const checkpointRow = await store.load(
    WORK_FANOUT_CHECKPOINT_MODEL,
    ctx.fanoutId as RecordId,
  );
  assert.ok(checkpointRow !== null, 'checkpoint row must exist before admission');
  const next = withRowData(
    checkpointRow,
    { ...nextFanoutCheckpointData(readFanoutCheckpointRow(checkpointRow), [], recordId) },
    { nowMs, actor: ACTOR },
    'work.fanout_checkpoint',
  );
  await commitWrites(store, [
    {
      kind: 'insert',
      model: WORK_FANOUT_CHILD_MODEL,
      row: newFanoutChildRow(
        { fanoutId: ctx.fanoutId, parentOccurrence: ctx.occurrence, handler: HANDLER, recordId },
        { nowMs, actor: ACTOR },
      ),
    },
    {
      kind: 'update',
      model: WORK_FANOUT_CHECKPOINT_MODEL,
      id: checkpointRow.id,
      expectedVersion: checkpointRow.version,
      row: next,
    },
  ]);
}

/** Null the enumeration cursor once admission is provably complete. */
async function finishEnumeration(store: StoragePort, ctx: FanoutCtx, nowMs: number): Promise<void> {
  const checkpointRow = await store.load(
    WORK_FANOUT_CHECKPOINT_MODEL,
    ctx.fanoutId as RecordId,
  );
  assert.ok(checkpointRow !== null);
  const next = withRowData(
    checkpointRow,
    { ...nextFanoutCheckpointData(readFanoutCheckpointRow(checkpointRow), [], null) },
    { nowMs, actor: ACTOR },
    'work.fanout_checkpoint',
  );
  await commitWrites(store, [
    {
      kind: 'update',
      model: WORK_FANOUT_CHECKPOINT_MODEL,
      id: checkpointRow.id,
      expectedVersion: checkpointRow.version,
      row: next,
    },
  ]);
}

/** F3 claim shape: pending -> running, attempts unchanged. */
async function claimChild(
  store: StoragePort,
  childId: string,
  nowMs: number,
): Promise<StoredRow> {
  const current = await store.load(WORK_FANOUT_CHILD_MODEL, childId as RecordId);
  assert.ok(current !== null);
  const data = readFanoutChildRow(current);
  assert.equal(data.state, 'pending');
  const next = withRowData(
    current,
    { ...data, state: 'running' },
    { nowMs, actor: ACTOR },
    'work.fanout_child',
  );
  await commitWrites(store, [
    {
      kind: 'update',
      model: WORK_FANOUT_CHILD_MODEL,
      id: current.id,
      expectedVersion: current.version,
      row: next,
    },
  ]);
  return next;
}

/** Recovery release: running -> pending, attempts unchanged. */
async function releaseChild(
  store: StoragePort,
  childId: string,
  nowMs: number,
): Promise<StoredRow> {
  const current = await store.load(WORK_FANOUT_CHILD_MODEL, childId as RecordId);
  assert.ok(current !== null);
  const data = readFanoutChildRow(current);
  assert.equal(data.state, 'running');
  const next = withRowData(
    current,
    { ...data, state: 'pending' },
    { nowMs, actor: ACTOR },
    'work.fanout_child',
  );
  await commitWrites(store, [
    {
      kind: 'update',
      model: WORK_FANOUT_CHILD_MODEL,
      id: current.id,
      expectedVersion: current.version,
      row: next,
    },
  ]);
  return next;
}

type TerminalKind =
  | { readonly kind: 'completed' }
  | { readonly kind: 'skipped'; readonly reason: FanoutSkippedReason }
  | { readonly kind: 'failed'; readonly reason: FanoutFailedReason };

/**
 * C5 atomic unit: terminal outcome + checkpoint advance (+ effect
 * marker for completed only) commit in ONE owner batch. Skips never
 * increment attempts; completed/failed do (F3 record shapes).
 */
async function recordTerminal(
  store: StoragePort,
  ctx: FanoutCtx,
  childId: string,
  terminal: TerminalKind,
  nowMs: number,
): Promise<StoredRow> {
  const current = await store.load(WORK_FANOUT_CHILD_MODEL, childId as RecordId);
  assert.ok(current !== null);
  const data = readFanoutChildRow(current);
  assert.equal(data.state, 'running');
  const checkpointRow = await store.load(
    WORK_FANOUT_CHECKPOINT_MODEL,
    ctx.fanoutId as RecordId,
  );
  assert.ok(checkpointRow !== null);
  const terminalData =
    terminal.kind === 'completed'
      ? {
          ...data,
          state: 'completed' as const,
          attempts: data.attempts + 1,
          causeKind: 'completed' as const,
          causeReason: null,
        }
      : terminal.kind === 'skipped'
        ? {
            ...data,
            state: 'skipped' as const,
            causeKind: 'skipped' as const,
            causeReason: terminal.reason,
          }
        : {
            ...data,
            state: 'failed' as const,
            attempts: data.attempts + 1,
            causeKind: 'failed' as const,
            causeReason: terminal.reason,
          };
  const nextChild = withRowData(current, terminalData, { nowMs, actor: ACTOR }, 'work.fanout_child');
  const nextCheckpoint = withRowData(
    checkpointRow,
    {
      ...nextFanoutCheckpointData(
        readFanoutCheckpointRow(checkpointRow),
        [data.recordId],
        readFanoutCheckpointRow(checkpointRow).cursor,
      ),
    },
    { nowMs, actor: ACTOR },
    'work.fanout_checkpoint',
  );
  const writes: DomainWrite[] = [
    {
      kind: 'update',
      model: WORK_FANOUT_CHILD_MODEL,
      id: current.id,
      expectedVersion: current.version,
      row: nextChild,
    },
    {
      kind: 'update',
      model: WORK_FANOUT_CHECKPOINT_MODEL,
      id: checkpointRow.id,
      expectedVersion: checkpointRow.version,
      row: nextCheckpoint,
    },
  ];
  if (terminal.kind === 'completed') {
    writes.push({ kind: 'insert', model: EFFECT_MODEL, row: newEffectRow(childId, nowMs) });
  }
  await commitWrites(store, writes);
  return nextChild;
}

/* -- Scan assembly from durable rows + injected producer views. -- */

interface ProducerViews {
  guard?: ReadonlyMap<string, boolean | null>;
  lifecycle?: ReadonlyMap<string, FanoutChildLifecycle>;
  firstAttempt?: ReadonlyMap<string, number | null>;
}

async function planFromDurable(
  store: StoragePort,
  ctx: FanoutCtx,
  nowMs: number,
  views: ProducerViews = {},
): Promise<ReturnType<typeof planFanoutRecoveryScan>> {
  const intentRow = await store.load(WORK_FANOUT_INTENT_MODEL, ctx.fanoutId as RecordId);
  const checkpointRow = await store.load(WORK_FANOUT_CHECKPOINT_MODEL, ctx.fanoutId as RecordId);
  assert.ok(intentRow !== null && checkpointRow !== null);
  const rows: FanoutRecoverableRow[] = [];
  for (const row of await drainChildren(store, ctx.fanoutId)) {
    const data = readFanoutChildRow(row);
    rows.push({
      child: data,
      // The claim instant is the running row's `updated` stamp (F3's
      // claim write); pending rows carry null (unclaimed).
      claimedAtMs: data.state === 'running' ? row.updated : null,
      guardVerdict: views.guard?.get(data.recordId) ?? null,
      firstAttemptAtMs: views.firstAttempt?.get(data.recordId) ?? null,
      lifecycle: views.lifecycle?.get(data.recordId) ?? { status: 'present' },
    });
  }
  return planFanoutRecoveryScan({
    fanoutId: ctx.fanoutId,
    intent: readFanoutIntentRow(intentRow),
    checkpoint: readFanoutCheckpointRow(checkpointRow),
    rows,
    nowMs,
    maxClaimAgeMs: MAX_AGE,
    policy: POLICY,
  });
}

function assertPlanSilent(
  plan: ReturnType<typeof planFanoutRecoveryScan>,
  what: string,
): void {
  assert.deepEqual(plan.resume, [], `${what}: resume must be silent`);
  assert.deepEqual(plan.skipped, [], `${what}: skipped must be silent`);
  assert.deepEqual(plan.dead, [], `${what}: dead must be silent`);
  assert.deepEqual(plan.failed, [], `${what}: failed must be silent`);
  assert.deepEqual(plan.admit, [], `${what}: admit must be silent`);
  assert.deepEqual(plan.uncertain, [], `${what}: uncertain must be silent`);
  assert.deepEqual(plan.phantoms, [], `${what}: phantoms must be silent`);
  assert.deepEqual(plan.checkpointGaps, [], `${what}: gaps must be silent`);
  assert.equal(plan.finishEnumeration, false, `${what}: enumeration must read finished`);
}

/**
 * C5 shaping invariant over durable truth: terminal ⟺ checkpointed,
 * and completed ⟺ effect marker. Any mid-batch crash state would
 * break one direction loudly.
 */
async function assertAtomicShaping(
  store: StoragePort,
  ctx: FanoutCtx,
  recordIds: ReadonlyArray<string>,
): Promise<void> {
  const checkpointRow = await store.load(
    WORK_FANOUT_CHECKPOINT_MODEL,
    ctx.fanoutId as RecordId,
  );
  assert.ok(checkpointRow !== null);
  const completed = new Set(readFanoutCheckpointRow(checkpointRow).completed);
  for (const recordId of recordIds) {
    const row = await store.load(
      WORK_FANOUT_CHILD_MODEL,
      childIdOf(ctx, recordId) as RecordId,
    );
    assert.ok(row !== null, `child row must exist for ${recordId}`);
    const data = readFanoutChildRow(row);
    const terminal = data.state === 'completed' || data.state === 'skipped' || data.state === 'failed';
    assert.equal(
      completed.has(recordId),
      terminal,
      `checkpoint membership must match terminal state for ${recordId}`,
    );
    assert.equal(
      await effectExists(store, data.childId),
      data.state === 'completed',
      `effect marker must match completed state for ${recordId}`,
    );
  }
}

async function loadChild(
  store: StoragePort,
  childId: string,
): Promise<{ row: StoredRow; data: ReturnType<typeof readFanoutChildRow> }> {
  const row = await store.load(WORK_FANOUT_CHILD_MODEL, childId as RecordId);
  assert.ok(row !== null, `child row must exist for ${childId}`);
  return { row, data: readFanoutChildRow(row) };
}

async function loadCheckpointCompleted(
  store: StoragePort,
  ctx: FanoutCtx,
): Promise<{ completed: ReadonlyArray<string>; cursor: string | null }> {
  const row = await store.load(WORK_FANOUT_CHECKPOINT_MODEL, ctx.fanoutId as RecordId);
  assert.ok(row !== null);
  const data = readFanoutCheckpointRow(row);
  return { completed: data.completed, cursor: data.cursor };
}

/**
 * Recovery pin for live-but-unclaimed rows: pending -> terminal +
 * checkpoint advance in ONE batch (F3's claim-time guard-false shape:
 * no running intermediate, skips never increment attempts).
 */
async function pinTerminal(
  store: StoragePort,
  ctx: FanoutCtx,
  childId: string,
  terminal: Exclude<TerminalKind, { readonly kind: 'completed' }>,
  nowMs: number,
): Promise<void> {
  const current = await store.load(WORK_FANOUT_CHILD_MODEL, childId as RecordId);
  assert.ok(current !== null);
  const data = readFanoutChildRow(current);
  assert.equal(data.state, 'pending');
  const checkpointRow = await store.load(
    WORK_FANOUT_CHECKPOINT_MODEL,
    ctx.fanoutId as RecordId,
  );
  assert.ok(checkpointRow !== null);
  const terminalData =
    terminal.kind === 'skipped'
      ? {
          ...data,
          state: 'skipped' as const,
          causeKind: 'skipped' as const,
          causeReason: terminal.reason,
        }
      : {
          ...data,
          state: 'failed' as const,
          attempts: data.attempts + 1,
          causeKind: 'failed' as const,
          causeReason: terminal.reason,
        };
  const nextChild = withRowData(current, terminalData, { nowMs, actor: ACTOR }, 'work.fanout_child');
  const nextCheckpoint = withRowData(
    checkpointRow,
    {
      ...nextFanoutCheckpointData(
        readFanoutCheckpointRow(checkpointRow),
        [data.recordId],
        readFanoutCheckpointRow(checkpointRow).cursor,
      ),
    },
    { nowMs, actor: ACTOR },
    'work.fanout_checkpoint',
  );
  await commitWrites(store, [
    {
      kind: 'update',
      model: WORK_FANOUT_CHILD_MODEL,
      id: current.id,
      expectedVersion: current.version,
      row: nextChild,
    },
    {
      kind: 'update',
      model: WORK_FANOUT_CHECKPOINT_MODEL,
      id: checkpointRow.id,
      expectedVersion: checkpointRow.version,
      row: nextCheckpoint,
    },
  ]);
}

/* -- M2 kill/restart cases: one crash boundary each. -- */

async function midEnumerationCase(sub: Restartable, tag: string): Promise<void> {
  const ctx = fanoutCtx(`occ_f4_enum_${tag}`);
  const members = ['e0', 'e1', 'e2', 'e3', 'e4'];
  let store = await sub.start();
  await commitIntent(store, ctx, members, T0);
  await admitMember(store, ctx, 'e0', T0 + 1);
  await admitMember(store, ctx, 'e1', T0 + 2);
  await admitMember(store, ctx, 'e2', T0 + 3);
  await sub.kill();
  store = await sub.start();
  const nowMs = T0 + MAX_AGE + 5000;
  const plan = await planFromDurable(store, ctx, nowMs);
  assert.deepEqual(plan.admit, ['e3', 'e4']);
  assert.deepEqual(plan.checkpointGaps, []);
  assert.deepEqual(plan.phantoms, []);
  assert.equal(plan.finishEnumeration, false);
  await admitMember(store, ctx, 'e3', nowMs + 1);
  await admitMember(store, ctx, 'e4', nowMs + 2);
  const admitted = await planFromDurable(store, ctx, nowMs + 3);
  assert.deepEqual(admitted.admit, []);
  assert.equal(admitted.finishEnumeration, true);
  await finishEnumeration(store, ctx, nowMs + 4);
  for (const member of members) {
    await claimChild(store, childIdOf(ctx, member), nowMs + 10);
    await recordTerminal(store, ctx, childIdOf(ctx, member), { kind: 'completed' }, nowMs + 11);
  }
  const rows = await drainChildren(store, ctx.fanoutId);
  assert.equal(rows.length, 5);
  for (const row of rows) {
    const data = readFanoutChildRow(row);
    assert.equal(data.state, 'completed');
    assert.equal(data.attempts, 1);
    assert.equal(await effectExists(store, data.childId), true);
  }
  assert.deepEqual(await loadCheckpointCompleted(store, ctx), {
    completed: members,
    cursor: null,
  });
  await assertAtomicShaping(store, ctx, members);
  assertPlanSilent(await planFromDurable(store, ctx, nowMs + 20), 'enum');
}

async function midClaimCase(sub: Restartable, tag: string): Promise<void> {
  const ctx = fanoutCtx(`occ_f4_claim_${tag}`);
  const members = ['c0', 'c1'];
  const claimAt = T0 + 4;
  let store = await sub.start();
  await commitIntent(store, ctx, members, T0);
  await admitMember(store, ctx, 'c0', T0 + 1);
  await admitMember(store, ctx, 'c1', T0 + 2);
  await finishEnumeration(store, ctx, T0 + 3);
  await claimChild(store, childIdOf(ctx, 'c0'), claimAt);
  const c0version = (await loadChild(store, childIdOf(ctx, 'c0'))).row.version;
  await sub.kill();
  store = await sub.start();
  // Fresh restart: the claim lease still holds — uncertain, untouched.
  const fresh = await planFromDurable(store, ctx, claimAt + MAX_AGE - 100);
  assert.deepEqual(fresh.uncertain, [childIdOf(ctx, 'c0')]);
  assert.deepEqual(fresh.resume, []);
  // The sibling completes while c0's claim is live; c0 must not move.
  await claimChild(store, childIdOf(ctx, 'c1'), claimAt + MAX_AGE - 50);
  await recordTerminal(store, ctx, childIdOf(ctx, 'c1'), { kind: 'completed' }, claimAt + MAX_AGE - 40);
  assert.equal((await loadChild(store, childIdOf(ctx, 'c0'))).row.version, c0version);
  assert.equal(await effectExists(store, childIdOf(ctx, 'c0')), false);
  await sub.kill();
  store = await sub.start();
  // Aged restart: the claim is stale — resume exactly c0.
  const nowMs = claimAt + MAX_AGE + 1;
  const stale = await planFromDurable(store, ctx, nowMs, {
    firstAttempt: new Map([['c0', claimAt]]),
  });
  assert.deepEqual(stale.resume, [childIdOf(ctx, 'c0')]);
  assert.deepEqual(stale.uncertain, []);
  await releaseChild(store, childIdOf(ctx, 'c0'), nowMs + 1);
  await claimChild(store, childIdOf(ctx, 'c0'), nowMs + 2);
  await recordTerminal(store, ctx, childIdOf(ctx, 'c0'), { kind: 'completed' }, nowMs + 3);
  const done = await loadChild(store, childIdOf(ctx, 'c0'));
  assert.equal(done.data.attempts, 1);
  assert.equal(await effectExists(store, childIdOf(ctx, 'c0')), true);
  await assertAtomicShaping(store, ctx, members);
  assertPlanSilent(await planFromDurable(store, ctx, nowMs + 10), 'claim');
}

async function midEffectCase(sub: Restartable, tag: string): Promise<void> {
  const ctx = fanoutCtx(`occ_f4_effect_${tag}`);
  const members = ['a', 'b'];
  const claimAt = T0 + 12;
  let store = await sub.start();
  await commitIntent(store, ctx, members, T0);
  await admitMember(store, ctx, 'a', T0 + 1);
  await admitMember(store, ctx, 'b', T0 + 2);
  await finishEnumeration(store, ctx, T0 + 3);
  await claimChild(store, childIdOf(ctx, 'b'), T0 + 10);
  await recordTerminal(store, ctx, childIdOf(ctx, 'b'), { kind: 'completed' }, T0 + 11);
  const bVersion = (await loadChild(store, childIdOf(ctx, 'b'))).row.version;
  await claimChild(store, childIdOf(ctx, 'a'), claimAt);
  await sub.kill();
  store = await sub.start();
  const nowMs = claimAt + MAX_AGE + 1;
  const plan = await planFromDurable(store, ctx, nowMs, {
    firstAttempt: new Map([['a', claimAt]]),
  });
  // At most the un-checkpointed child replays: b is terminal-immune.
  assert.deepEqual(plan.resume, [childIdOf(ctx, 'a')]);
  assert.deepEqual(plan.uncertain, []);
  await assertAtomicShaping(store, ctx, members);
  await releaseChild(store, childIdOf(ctx, 'a'), nowMs + 1);
  await claimChild(store, childIdOf(ctx, 'a'), nowMs + 2);
  await recordTerminal(store, ctx, childIdOf(ctx, 'a'), { kind: 'completed' }, nowMs + 3);
  const a = await loadChild(store, childIdOf(ctx, 'a'));
  assert.equal(a.data.attempts, 1);
  assert.equal(await effectExists(store, childIdOf(ctx, 'a')), true);
  const b = await loadChild(store, childIdOf(ctx, 'b'));
  assert.equal(b.row.version, bVersion);
  assert.equal(b.data.attempts, 1);
  assert.equal(await effectExists(store, childIdOf(ctx, 'b')), true);
  await assertAtomicShaping(store, ctx, members);
  assertPlanSilent(await planFromDurable(store, ctx, nowMs + 10), 'effect');
}

async function midCheckpointCase(sub: Restartable, tag: string): Promise<void> {
  const ctx = fanoutCtx(`occ_f4_ckpt_${tag}`);
  const members = ['c', 'd'];
  const claimAt = T0 + 12;
  let store = await sub.start();
  await commitIntent(store, ctx, members, T0);
  await admitMember(store, ctx, 'c', T0 + 1);
  await admitMember(store, ctx, 'd', T0 + 2);
  await finishEnumeration(store, ctx, T0 + 3);
  await claimChild(store, childIdOf(ctx, 'c'), T0 + 10);
  // The terminal batch (outcome + checkpoint + marker) commits; the
  // driver "dies" before noting it — acknowledgment-side crash.
  await recordTerminal(store, ctx, childIdOf(ctx, 'c'), { kind: 'completed' }, T0 + 11);
  const cVersion = (await loadChild(store, childIdOf(ctx, 'c'))).row.version;
  await claimChild(store, childIdOf(ctx, 'd'), claimAt);
  await sub.kill();
  store = await sub.start();
  const nowMs = claimAt + MAX_AGE + 1;
  // Post-restart the driver re-derives everything from durable truth.
  const plan = await planFromDurable(store, ctx, nowMs, {
    firstAttempt: new Map([['d', claimAt]]),
  });
  assert.deepEqual(plan.resume, [childIdOf(ctx, 'd')]);
  assert.deepEqual(plan.checkpointGaps, []);
  await assertAtomicShaping(store, ctx, members);
  await releaseChild(store, childIdOf(ctx, 'd'), nowMs + 1);
  await claimChild(store, childIdOf(ctx, 'd'), nowMs + 2);
  await recordTerminal(store, ctx, childIdOf(ctx, 'd'), { kind: 'completed' }, nowMs + 3);
  const c = await loadChild(store, childIdOf(ctx, 'c'));
  assert.equal(c.row.version, cVersion);
  assert.equal(await effectExists(store, childIdOf(ctx, 'c')), true);
  await assertAtomicShaping(store, ctx, members);
  assertPlanSilent(await planFromDurable(store, ctx, nowMs + 10), 'checkpoint');
}

async function duplicateDeliveryCase(sub: Restartable, tag: string): Promise<void> {
  const ctx = fanoutCtx(`occ_f4_dup_${tag}`);
  const members = ['x', 'y'];
  let store = await sub.start();
  await commitIntent(store, ctx, members, T0);
  // The duplicate delivery replays: the frozen set is insert-once.
  await assert.rejects(
    commitIntent(store, ctx, members, T0 + 1),
    (error: unknown) => error instanceof StorageConstraintError,
  );
  await sub.kill();
  store = await sub.start();
  const intentRow = await store.load(WORK_FANOUT_INTENT_MODEL, ctx.fanoutId as RecordId);
  assert.ok(intentRow !== null);
  assert.deepEqual([...readFanoutIntentRow(intentRow).members], members);
  assert.equal((await drainChildren(store, ctx.fanoutId)).length, 0);
  const nowMs = T0 + MAX_AGE + 5000;
  const plan = await planFromDurable(store, ctx, nowMs);
  assert.deepEqual(plan.admit, ['x', 'y']);
  await admitMember(store, ctx, 'x', nowMs + 1);
  await admitMember(store, ctx, 'y', nowMs + 2);
  await finishEnumeration(store, ctx, nowMs + 3);
  for (const member of members) {
    await claimChild(store, childIdOf(ctx, member), nowMs + 10);
    await recordTerminal(store, ctx, childIdOf(ctx, member), { kind: 'completed' }, nowMs + 11);
  }
  assert.equal((await drainChildren(store, ctx.fanoutId)).length, 2);
  await assertAtomicShaping(store, ctx, members);
  assertPlanSilent(await planFromDurable(store, ctx, nowMs + 20), 'duplicate');
}

async function lifecycleCase(sub: Restartable, tag: string): Promise<void> {
  const ctx = fanoutCtx(`occ_f4_life_${tag}`);
  const members = ['a', 'b', 'c', 'd', 'e'];
  let store = await sub.start();
  await commitIntent(store, ctx, members, T0);
  for (const [index, member] of members.entries()) {
    await admitMember(store, ctx, member, T0 + 1 + index);
  }
  await finishEnumeration(store, ctx, T0 + 10);
  await claimChild(store, childIdOf(ctx, 'a'), T0 + 11);
  await recordTerminal(store, ctx, childIdOf(ctx, 'a'), { kind: 'completed' }, T0 + 12);
  const aVersion = (await loadChild(store, childIdOf(ctx, 'a'))).row.version;
  await sub.kill();
  store = await sub.start();
  const nowMs = T0 + 12 + MAX_AGE + 1;
  const views: ProducerViews = {
    lifecycle: new Map<string, FanoutChildLifecycle>([
      ['b', { status: 'deleted' }],
      ['c', { status: 'moved' }],
      ['d', { status: 'moved' }],
      ['e', { status: 'unknown', reason: 'missing-record' }],
    ]),
    guard: new Map([
      ['c', false],
      ['d', true],
    ]),
  };
  const plan = await planFromDurable(store, ctx, nowMs, views);
  assert.deepEqual(plan.skipped, [
    { childId: childIdOf(ctx, 'b'), reason: 'deleted' },
    { childId: childIdOf(ctx, 'c'), reason: 'non-applicable' },
  ]);
  assert.deepEqual(plan.failed, [{ childId: childIdOf(ctx, 'e'), reason: 'missing-record' }]);
  assert.deepEqual(plan.resume, []);
  assert.deepEqual(plan.admit, []);
  assert.deepEqual(plan.phantoms, []);
  await pinTerminal(store, ctx, childIdOf(ctx, 'b'), { kind: 'skipped', reason: 'deleted' }, nowMs + 1);
  await pinTerminal(
    store,
    ctx,
    childIdOf(ctx, 'c'),
    { kind: 'skipped', reason: 'non-applicable' },
    nowMs + 2,
  );
  await pinTerminal(
    store,
    ctx,
    childIdOf(ctx, 'e'),
    { kind: 'failed', reason: 'missing-record' },
    nowMs + 3,
  );
  await claimChild(store, childIdOf(ctx, 'd'), nowMs + 4);
  await recordTerminal(store, ctx, childIdOf(ctx, 'd'), { kind: 'completed' }, nowMs + 5);
  const b = await loadChild(store, childIdOf(ctx, 'b'));
  assert.deepEqual([b.data.state, b.data.causeReason, b.data.attempts], ['skipped', 'deleted', 0]);
  const c = await loadChild(store, childIdOf(ctx, 'c'));
  assert.deepEqual(
    [c.data.state, c.data.causeReason, c.data.attempts],
    ['skipped', 'non-applicable', 0],
  );
  const e = await loadChild(store, childIdOf(ctx, 'e'));
  assert.deepEqual(
    [e.data.state, e.data.causeReason, e.data.attempts],
    ['failed', 'missing-record', 1],
  );
  assert.equal(await effectExists(store, childIdOf(ctx, 'b')), false);
  assert.equal(await effectExists(store, childIdOf(ctx, 'c')), false);
  assert.equal(await effectExists(store, childIdOf(ctx, 'e')), false);
  assert.equal(await effectExists(store, childIdOf(ctx, 'd')), true);
  const a = await loadChild(store, childIdOf(ctx, 'a'));
  assert.equal(a.row.version, aVersion);
  // Late insert past the cutoff is excluded: never admitted, never a row.
  assert.equal(
    await store.load(WORK_FANOUT_CHILD_MODEL, childIdOf(ctx, 'f') as RecordId),
    null,
  );
  assert.deepEqual(await loadCheckpointCompleted(store, ctx), {
    completed: members,
    cursor: null,
  });
  await assertAtomicShaping(store, ctx, members);
  // Terminal immunity on durable truth: the same hostile views pin nothing now.
  assertPlanSilent(await planFromDurable(store, ctx, nowMs + 10, views), 'lifecycle');
}

async function twoOccurrencesCase(sub: Restartable, tag: string): Promise<void> {
  const ctx1 = fanoutCtx(`occ_f4_m7a_${tag}`);
  const ctx2 = fanoutCtx(`occ_f4_m7b_${tag}`);
  const members1 = ['r1', 'r2'];
  const members2 = ['r2', 'r3'];
  assert.notEqual(ctx1.fanoutId, ctx2.fanoutId);
  const claimAt = T0 + 20;
  let store = await sub.start();
  await commitIntent(store, ctx1, members1, T0);
  await commitIntent(store, ctx2, members2, T0 + 1);
  await admitMember(store, ctx1, 'r1', T0 + 2);
  await admitMember(store, ctx1, 'r2', T0 + 3);
  await admitMember(store, ctx2, 'r2', T0 + 4);
  await admitMember(store, ctx2, 'r3', T0 + 5);
  await finishEnumeration(store, ctx1, T0 + 6);
  await finishEnumeration(store, ctx2, T0 + 7);
  await claimChild(store, childIdOf(ctx1, 'r1'), T0 + 10);
  await recordTerminal(store, ctx1, childIdOf(ctx1, 'r1'), { kind: 'completed' }, T0 + 11);
  const r1version = (await loadChild(store, childIdOf(ctx1, 'r1'))).row.version;
  await claimChild(store, childIdOf(ctx1, 'r2'), claimAt);
  await claimChild(store, childIdOf(ctx2, 'r2'), claimAt);
  await sub.kill();
  store = await sub.start();
  const nowMs = claimAt + MAX_AGE + 1;
  // Each occurrence plans under its own fanout: no shared checkpoint.
  const plan1 = await planFromDurable(store, ctx1, nowMs, {
    firstAttempt: new Map([['r2', claimAt]]),
  });
  const plan2 = await planFromDurable(store, ctx2, nowMs, {
    firstAttempt: new Map([['r2', claimAt]]),
  });
  assert.deepEqual(plan1.resume, [childIdOf(ctx1, 'r2')]);
  assert.deepEqual(plan2.resume, [childIdOf(ctx2, 'r2')]);
  assert.notEqual(childIdOf(ctx1, 'r2'), childIdOf(ctx2, 'r2'));
  await assertAtomicShaping(store, ctx1, members1);
  await assertAtomicShaping(store, ctx2, members2);
  await releaseChild(store, childIdOf(ctx1, 'r2'), nowMs + 1);
  await claimChild(store, childIdOf(ctx1, 'r2'), nowMs + 2);
  await recordTerminal(store, ctx1, childIdOf(ctx1, 'r2'), { kind: 'completed' }, nowMs + 3);
  await releaseChild(store, childIdOf(ctx2, 'r2'), nowMs + 4);
  await claimChild(store, childIdOf(ctx2, 'r2'), nowMs + 5);
  await recordTerminal(store, ctx2, childIdOf(ctx2, 'r2'), { kind: 'completed' }, nowMs + 6);
  await claimChild(store, childIdOf(ctx2, 'r3'), nowMs + 7);
  await recordTerminal(store, ctx2, childIdOf(ctx2, 'r3'), { kind: 'completed' }, nowMs + 8);
  // Overlapping record, independent rows: both occurrences retain coverage.
  const r2a = await loadChild(store, childIdOf(ctx1, 'r2'));
  const r2b = await loadChild(store, childIdOf(ctx2, 'r2'));
  assert.equal(r2a.data.state, 'completed');
  assert.equal(r2b.data.state, 'completed');
  assert.equal(r2a.data.parentOccurrence, ctx1.occurrence);
  assert.equal(r2b.data.parentOccurrence, ctx2.occurrence);
  assert.equal((await loadChild(store, childIdOf(ctx1, 'r1'))).row.version, r1version);
  assert.deepEqual(await loadCheckpointCompleted(store, ctx1), {
    completed: members1,
    cursor: null,
  });
  assert.deepEqual(await loadCheckpointCompleted(store, ctx2), {
    completed: members2,
    cursor: null,
  });
  await assertAtomicShaping(store, ctx1, members1);
  await assertAtomicShaping(store, ctx2, members2);
  assertPlanSilent(await planFromDurable(store, ctx1, nowMs + 10), 'm7a');
  assertPlanSilent(await planFromDurable(store, ctx2, nowMs + 10), 'm7b');
}

function durableRestartSuite(kind: SubstrateKind): void {
  const name = kind === 'd1' ? 'real D1' : 'real DO SQLite';
  describe(`t34-f4 durable restart on ${name}`, () => {
    it('M2 mid-enumeration kill resumes admission exactly', async () => {
      await withRestart(kind, 'enum', (sub) => midEnumerationCase(sub, kind));
    });
    it('M2 mid-claim kill holds the lease, then resumes exactly', async () => {
      await withRestart(kind, 'claim', (sub) => midClaimCase(sub, kind));
    });
    it('M2 mid-effect kill replays at most the un-checkpointed child', async () => {
      await withRestart(kind, 'effect', (sub) => midEffectCase(sub, kind));
    });
    it('M2 mid-checkpoint kill never re-executes committed effects', async () => {
      await withRestart(kind, 'ckpt', (sub) => midCheckpointCase(sub, kind));
    });
    it('M3 duplicate occurrence delivery replays without new rows', async () => {
      await withRestart(kind, 'dup', (sub) => duplicateDeliveryCase(sub, kind));
    });
    it('M4 insert/move/delete across restart follows the lifecycle policy', async () => {
      await withRestart(kind, 'life', (sub) => lifecycleCase(sub, kind));
    });
    it('M7 two occurrences complete independently across restart', async () => {
      await withRestart(kind, 'm7', (sub) => twoOccurrencesCase(sub, kind));
    });
  });
}

durableRestartSuite('d1');
durableRestartSuite('do');


