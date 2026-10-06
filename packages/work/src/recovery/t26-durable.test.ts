/**
 * T26 durable proofs: REAL kill/restart resume on file-backed local D1
 * (miniflare) and workerd DO SQLite, reached through the state-owned
 * harness patterns (the miniflare anchor plus the `do-test-worker.js`
 * StoragePort proxy, reused read-only) with per-test persist dirs.
 *
 * Each case commits pre-crash association pairs (T26 rows), DISPOSES
 * its miniflare instance (the kill: workerd torn down, uncommitted
 * work lost), boots a FRESH instance over the SAME persist dir (the
 * restart), then plans (`planRelatedProgressResume`) and resumes
 * purely from durable truth. That is actual restart, not two live
 * handles.
 *
 * miniflare itself is NOT a `@canlang/work` dependency: this suite
 * loads it through the require anchored at `@canlang/state`, which
 * owns the durable harness. If that anchor ever stops resolving,
 * these tests fail loudly instead of silently falling back to
 * memory — durability is never claimed off a weaker substrate.
 *
 * Honest boundaries (what this suite does NOT claim):
 * - The T26 rows ride a TEST-ONLY model (`test.t26_progress`); the
 *   production receipt tables are the L3 join's (T25-L3 precedent).
 *   Only the ROWS are durable here: correlation, gating and
 *   notifications are the pure work kernels under test.
 * - The commit driver below is TEST-ONLY (single-owner fenced
 *   batches, no contention); it models the committing store, which
 *   persists kernel outputs inside its own fence.
 * - Claim instants and guard verdicts do not exist in this slice:
 *   resume decides from retained status alone.
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
  AssociatedReceipt,
  ProgressTerminalNotification,
  ReceiptAssociation,
} from '../../../contracts/src/work.js';
import type {
  CommitBatch,
  DomainWrite,
  ModelName,
  RecordId,
  RecordVersion,
  StoragePort,
  StoredRow,
} from '../../../contracts/src/state.js';
import { createD1Storage, ensureSchema } from '../../../state/dist/state/src/storage/d1.js';
import { StorageConstraintError } from '../../../state/dist/state/src/storage/port.js';
import {
  applyRelatedProgress,
  cancelRelatedProgress,
  isKnownProgressRelation,
} from '../observation/association.ts';
import type { RelatedReceiptProgress } from '../observation/association.ts';
import { observeRelatedProgress } from '../observation/observation.ts';
import type { StoredReceipt } from '../observation/observation.ts';
import { TestOnlyAllowAllGrants, TestOnlyAvailabilityMap } from '../observation/ports.ts';
import { planRelatedProgressResume } from './index.ts';
import type { RelatedProgressRowView } from './index.ts';

const ACTOR = 't26-durable';
const T0 = 1_758_000_000_000;
const NOW = 1_791_120_000_000;
const SOURCE = 'Testprogress.send';

/** One T13a and one T13b relation: independent durable coverage. */
const RELATION_A = 'std.EmailV1.send';
const RELATION_B = 'std.TextGenerationV1.generate';

/* -- miniflare loads through the state-owned harness anchor. -- */

const stateRequire = createRequire(import.meta.resolve('../../../state/package.json'));

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
  new URL('../../../state/test/storage/do-test-worker.js', import.meta.url),
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
const stateDirPath = fileURLToPath(new URL('../../../state/', import.meta.url));
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
  const dir = await mkdtemp(join(tmpdir(), `t26-${kind}-${label}-`));
  const sub = await openRestartable(kind, dir);
  try {
    await fn(sub);
  } finally {
    await sub.kill().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

/* -- TEST-ONLY driver over a TEST-ONLY model (see header). -- */

const T26_MODEL = 'test.t26_progress' as ModelName;

function rowId(deliveryId: string): RecordId {
  return `t26/${deliveryId}` as RecordId;
}

interface T26RowData {
  relation: string;
  association: ReceiptAssociation;
  receipt: AssociatedReceipt;
}

function newT26Row(data: T26RowData, nowMs: number): StoredRow {
  return {
    id: rowId(data.association.deliveryId),
    version: 1 as RecordVersion,
    created: nowMs,
    updated: nowMs,
    createdBy: ACTOR,
    updatedBy: ACTOR,
    archivedAt: null,
    parent: null,
    data: structuredClone(data) as unknown as Record<string, unknown>,
  };
}

function nextT26Row(row: StoredRow, data: T26RowData, nowMs: number): StoredRow {
  return {
    ...row,
    version: (row.version + 1) as RecordVersion,
    updated: nowMs,
    updatedBy: ACTOR,
    data: structuredClone(data) as unknown as Record<string, unknown>,
  };
}

function readT26Row(row: StoredRow): T26RowData {
  const data = row.data as unknown as Record<string, unknown>;
  const relation: unknown = data['relation'];
  const association = data['association'] as ReceiptAssociation;
  const receipt = data['receipt'] as AssociatedReceipt;
  assert.equal(isKnownProgressRelation(relation), true);
  assert.equal(association.deliveryId, receipt.deliveryId);
  assert.equal(association.revision, receipt.revision);
  return { relation: relation as string, association, receipt };
}

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

function pendingPair(deliveryId: string, field: string): T26RowData {
  const association: ReceiptAssociation = {
    locator: { recordId: `rec_${deliveryId}`, field },
    deliveryId,
    source: SOURCE,
    revision: 0,
  };
  const receipt: AssociatedReceipt = {
    deliveryId,
    revision: 0,
    status: 'pending',
    result: null,
    error: null,
  };
  return {
    relation: deliveryId.startsWith('b_') ? RELATION_B : RELATION_A,
    association,
    receipt,
  };
}

function terminalEnvelope(pair: T26RowData, revision: number): RelatedReceiptProgress {
  return {
    relation: pair.relation,
    delivery_id: pair.association.deliveryId,
    source: SOURCE,
    revision,
    status: 'succeeded',
    result: { relation: pair.relation, marker: 'durable-ok' },
    error: null,
  };
}

async function loadPair(store: StoragePort, deliveryId: string): Promise<T26RowData> {
  const row = await store.load(T26_MODEL, rowId(deliveryId));
  assert.ok(row !== null, `durable row for ${deliveryId} must survive restart`);
  return readT26Row(row);
}

/** Pending pairs resume to terminal exactly; terminal rows never re-drive. */
async function progressResumeCase(sub: Restartable): Promise<void> {
  const notifications: ProgressTerminalNotification[] = [];
  const preA = pendingPair('a_pending', 'notification');
  const preB = pendingPair('b_pending', 'summary');

  let store = await sub.start();
  await commitWrites(store, [
    { kind: 'insert', model: T26_MODEL, row: newT26Row(preA, T0) },
    { kind: 'insert', model: T26_MODEL, row: newT26Row(preB, T0) },
  ]);
  await sub.kill();

  store = await sub.start();
  const durableA = await loadPair(store, 'a_pending');
  const durableB = await loadPair(store, 'b_pending');
  assert.deepEqual(durableA, preA);
  assert.deepEqual(durableB, preB);

  const viewOf = (pair: T26RowData): RelatedProgressRowView => ({
    relation: pair.relation,
    association: pair.association,
    receipt: pair.receipt,
  });
  assert.deepEqual(planRelatedProgressResume({ relation: RELATION_A, rows: [viewOf(durableA)] }), {
    relation: RELATION_A,
    resume: ['a_pending'],
    settled: [],
  });
  assert.deepEqual(planRelatedProgressResume({ relation: RELATION_B, rows: [viewOf(durableB)] }), {
    relation: RELATION_B,
    resume: ['b_pending'],
    settled: [],
  });
  assert.throws(
    () =>
      planRelatedProgressResume({
        relation: RELATION_A,
        rows: [viewOf(durableA), viewOf(durableB)],
      }),
    /carries relation/,
  );

  const appliedA = applyRelatedProgress(
    RELATION_A,
    durableA.association,
    durableA.receipt,
    terminalEnvelope(durableA, 1),
  );
  assert.equal(appliedA.applied, true);
  assert.ok(appliedA.applied);
  assert.deepEqual(appliedA.notification, {
    relation: RELATION_A,
    deliveryId: 'a_pending',
    revision: 1,
    status: 'succeeded',
  });
  if (appliedA.notification !== null) {
    notifications.push(appliedA.notification);
  }
  const rowA = await store.load(T26_MODEL, rowId('a_pending'));
  assert.ok(rowA !== null);
  await commitWrites(store, [
    {
      kind: 'update',
      model: T26_MODEL,
      id: rowA.id,
      expectedVersion: rowA.version,
      row: nextT26Row(
        rowA,
        { relation: RELATION_A, association: appliedA.association, receipt: appliedA.receipt },
        T0 + 1,
      ),
    },
  ]);
  await sub.kill();

  store = await sub.start();
  const retainedA = await loadPair(store, 'a_pending');
  assert.equal(retainedA.receipt.status, 'succeeded');
  assert.deepEqual(retainedA.receipt.result, {
    relation: RELATION_A,
    marker: 'durable-ok',
  });
  assert.deepEqual(
    planRelatedProgressResume({ relation: RELATION_A, rows: [viewOf(retainedA)] }),
    { relation: RELATION_A, resume: [], settled: ['a_pending'] },
  );

  const hostile = applyRelatedProgress(
    RELATION_A,
    retainedA.association,
    retainedA.receipt,
    {
      ...terminalEnvelope(retainedA, 2),
      status: 'failed',
      result: null,
      error: { code: 'hostile', message: 'rewritten' },
    },
  );
  assert.deepEqual(hostile, { applied: false, reason: 'terminal-immutable' });
  const replay = applyRelatedProgress(
    RELATION_A,
    retainedA.association,
    retainedA.receipt,
    terminalEnvelope(retainedA, 1),
  );
  assert.deepEqual(replay, {
    applied: true,
    association: retainedA.association,
    receipt: retainedA.receipt,
    notification: null,
    replay: true,
  });
  assert.equal(notifications.length, 1);

  const late = observeRelatedProgress({
    relation: RELATION_A,
    locator: { record: { id: 'rec_a_pending' }, field: 'notification' },
    selected: ['id', 'status', 'result', 'error'],
    association: retainedA.association,
    receipt: { ...retainedA.receipt, contentRef: null } satisfies StoredReceipt,
    grants: new TestOnlyAllowAllGrants(),
    content: new TestOnlyAvailabilityMap(),
    nowMs: NOW,
  });
  assert.deepEqual(late, {
    outcome: 'observed',
    relation: RELATION_A,
    projection: {
      id: 'a_pending',
      status: 'succeeded',
      result: { relation: RELATION_A, marker: 'durable-ok' },
      error: null,
    },
    fenceRevision: 1,
  });

  const retainedB = await loadPair(store, 'b_pending');
  assert.equal(retainedB.receipt.status, 'pending');
  assert.deepEqual(planRelatedProgressResume({ relation: RELATION_B, rows: [viewOf(retainedB)] }), {
    relation: RELATION_B,
    resume: ['b_pending'],
    settled: [],
  });
}

/** A cancelled pair stays void across restart and never re-emits. */
async function cancelVoidCase(sub: Restartable): Promise<void> {
  const pre = pendingPair('a_cancel', 'notification');
  let store = await sub.start();
  await commitWrites(store, [{ kind: 'insert', model: T26_MODEL, row: newT26Row(pre, T0) }]);

  const voided = cancelRelatedProgress({
    relation: RELATION_A,
    association: pre.association,
    receipt: pre.receipt,
    revision: 1,
  });
  assert.equal(voided.cancelled, true);
  assert.ok(voided.cancelled);
  assert.deepEqual(voided.notification, {
    relation: RELATION_A,
    deliveryId: 'a_cancel',
    revision: 1,
    status: 'skipped',
  });
  const row = await store.load(T26_MODEL, rowId('a_cancel'));
  assert.ok(row !== null);
  await commitWrites(store, [
    {
      kind: 'update',
      model: T26_MODEL,
      id: row.id,
      expectedVersion: row.version,
      row: nextT26Row(
        row,
        { relation: RELATION_A, association: voided.association, receipt: voided.receipt },
        T0 + 1,
      ),
    },
  ]);
  await sub.kill();

  store = await sub.start();
  const retained = await loadPair(store, 'a_cancel');
  assert.equal(retained.receipt.status, 'skipped');
  assert.deepEqual(retained.receipt.result, null);
  assert.deepEqual(retained.receipt.error, null);
  assert.deepEqual(
    planRelatedProgressResume({
      relation: RELATION_A,
      rows: [
        { relation: retained.relation, association: retained.association, receipt: retained.receipt },
      ],
    }),
    { relation: RELATION_A, resume: [], settled: ['a_cancel'] },
  );
  assert.deepEqual(
    cancelRelatedProgress({
      relation: RELATION_A,
      association: retained.association,
      receipt: retained.receipt,
      revision: 2,
    }),
    { cancelled: false, reason: 'terminal-immutable' },
  );
  assert.deepEqual(
    applyRelatedProgress(
      RELATION_A,
      retained.association,
      retained.receipt,
      terminalEnvelope(retained, 2),
    ),
    { applied: false, reason: 'terminal-immutable' },
  );
}

function durableRestartSuite(kind: SubstrateKind): void {
  const name = kind === 'd1' ? 'real D1' : 'real DO SQLite';
  describe(`t26 durable restart on ${name}`, () => {
    it('pending pairs resume to terminal exactly; terminal rows never re-drive', async () => {
      await withRestart(kind, 'resume', (sub) => progressResumeCase(sub));
    });
    it('a cancelled pair stays void across restart and never re-emits', async () => {
      await withRestart(kind, 'cancel', (sub) => cancelVoidCase(sub));
    });
  });
}

durableRestartSuite('d1');
durableRestartSuite('do');
