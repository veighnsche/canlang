/**
 * T34-F7 durable proofs: the production `DurableFanoutChildStore`
 * (packages/work/src/dispatch/durable.ts) over REAL file-backed local
 * D1 (miniflare) and workerd DO SQLite, reached through the
 * state-owned harness patterns (the miniflare CWD anchor plus the
 * `do-test-worker.js` StoragePort proxy, reused read-only) with
 * per-test persist dirs.
 *
 * Each case admits rows through the REAL durable insert, drives the
 * REAL fenced claim/record joins, DISPOSES its miniflare instance
 * (the kill: workerd torn down, uncommitted work lost), boots a FRESH
 * instance over the SAME persist dir (the restart), then verifies
 * purely from durable truth. That is actual restart, not two live
 * handles — except the exactly-one-wins case, which deliberately
 * uses two live handles over one backend (cross-handle concurrency).
 *
 * Proves durable (F7 seam): fenced claim with exactly-one-winner
 * across handles (stale loser refuses, live loser holds, one version
 * bump, attempts untouched); T32 refusal preservation
 * (inherited-scope + revoked record terminal failed/
 * inaccessible-record); guard-false skipped/non-applicable; atomic
 * claim+outcome units (each transition lands whole or not at all:
 * claim+outcome survive the kill, mid-claim stays resumable);
 * transient retry within budget and exhausted dead-letters; and
 * counts-only progress with terminal+attention.
 *
 * Single-owner scope only: cross-store atomicity is NOT claimed.
 *
 * Run from dist FROM THE REPO ROOT: root build, then
 * `node --test packages/work/dist/test/dispatch/t34-f7-durable.test.js`.
 * (Miniflare mounts worker modules under the CWD, so the CWD must be
 * an ancestor of the state package that owns the DO test worker.)
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
  FanoutChildId,
  ModelName,
  RecordId,
  Revision,
  StateErrorCode,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import type { RetryPolicy } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { FenceConflictError, StorageConstraintError } from '@canlang/state/storage/port';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { StateError } from '@canlang/state/errors';
import {
  WORK_FANOUT_CHILD_MODEL,
  fanoutChildRowId,
  fanoutIntentRowId,
  newFanoutChildRow,
  readFanoutChildRow,
} from '../../src/kernel/tables.js';
import {
  TestOnlyMemoryFanoutChildStore,
  type GuardEvaluator,
} from '../../src/dispatch/index.js';
import { TestOnlyManualClock } from '../../src/ports.js';
import { DurableFanoutChildStore } from '../../src/dispatch/durable.js';

const OCC = 'occ-f7-durable';
const HANDLER = 'Shift.review_commitment';
const FANOUT = fanoutIntentRowId(OCC, HANDLER, 'model');
const ACTOR = 't34-f7-durable';
const NOW = 1_758_000_000_000;
const META = { nowMs: NOW, actor: ACTOR };
const POLICY: RetryPolicy = { maxAttempts: 3, horizonMs: 60_000 };
const FENCE = {
  checkpoint: { revision: 7, owner: 'owner-1' },
};

const fnsNow = () => NOW;

function durableOver(port: StoragePort): DurableFanoutChildStore {
  return new DurableFanoutChildStore({ store: port, clock: { nowMs: fnsNow }, actor: ACTOR });
}

function child(recordId: string): FanoutChildId {
  return { parentOccurrence: OCC, handler: HANDLER, recordId };
}

function admittedRow(recordId: string): StoredRow {
  return newFanoutChildRow(
    { fanoutId: FANOUT, parentOccurrence: OCC, handler: HANDLER, recordId },
    META,
  );
}

const unconditional = { predicate: null };
const currentOf = (snapshot: unknown) => () => snapshot;
const evaluateTrue: GuardEvaluator = () => true;

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
const stateDirPath = fileURLToPath(new URL('../../', import.meta.resolve('@canlang/state/distribution')));
const entryCwd = process.cwd();
process.chdir(stateDirPath);

after(() => {
  process.chdir(entryCwd);
});

/** State-owned DO proxy worker, reused read-only (never edited here). */
const doWorkerPath = fileURLToPath(
  new URL(import.meta.resolve('@canlang/state/testing/storage/do-test-worker')),
);

/* -- Restartable substrate: boot -> kill (dispose) -> reboot (same dir). -- */

type SubstrateKind = 'd1' | 'do';

interface Restartable {
  readonly kind: SubstrateKind;
  /** Boot a fresh instance over the persist dir; returns its store. */
  start: () => Promise<StoragePort>;
  /** Open a second live handle over the SAME backend (cross-handle races). */
  second: () => Promise<StoragePort>;
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
  readonly code?: StateErrorCode;
  readonly retryable?: boolean;
}

function rehydrate(error: WorkerErrorJson): Error {
  if (error.name === 'StateError' && error.code !== undefined) {
    return new StateError(error.code, error.message, null,
      error.retryable === undefined ? undefined : { retryable: error.retryable });
  }
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
    cohortIdOrder: 'utf8-binary',
    readRevision: () => call('readRevision'),
    load: (model: ModelName, id: RecordId) => call('load', model, id),
    query: (spec) => call('query', spec),
    cohortIdentityPage: (input) => call('cohortIdentityPage', input),
    cohortLoad: (input) => call('cohortLoad', input),
    cohortRowPage: (input) => call('cohortRowPage', input),
    cohortAnchorFact: (input) => call('cohortAnchorFact', input),
    commit: (batch) => call('commit', batch),
    readReceipt: (identity) => call('readReceipt', identity),
    outboxPending: () => call('outboxPending'),
    outboxGet: (intentId) => call('outboxGet', intentId),
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
  let db: D1Database | undefined;
  const start = async (): Promise<StoragePort> => {
    if (kind === 'd1') {
      mf = new Miniflare({
        modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        d1Databases: ['DB'],
        d1Persist: join(dir, 'd1'),
      });
      db = (await mf.getD1Database('DB')) as D1Database;
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
  const second = async (): Promise<StoragePort> => {
    if (kind === 'd1') {
      if (db === undefined) {
        throw new Error('t34-f7 tests: second handle needs a started D1 backend.');
      }
      return createD1Storage(db);
    }
    if (mf === undefined) {
      throw new Error('t34-f7 tests: second handle needs a started DO backend.');
    }
    return doProxy(mf);
  };
  const kill = async (): Promise<void> => {
    if (mf !== undefined) {
      await mf.dispose();
      mf = undefined;
      db = undefined;
    }
  };
  return { kind, start, second, kill };
}

async function withRestart(
  kind: SubstrateKind,
  label: string,
  fn: (sub: Restartable) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), `t34f7-${kind}-${label}-`));
  const sub = await openRestartable(kind, dir);
  try {
    await fn(sub);
  } finally {
    await sub.kill().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

/* -- Per-substrate durable cases. -- */

for (const kind of ['d1', 'do'] as const satisfies ReadonlyArray<SubstrateKind>) {
  describe(`t34-f7 durable on ${kind}`, () => {
    it('fenced claim: exactly-one-wins across handles, loser observes winner', async () => {
      await withRestart(kind, 'race', async (sub) => {
        const first = durableOver(await sub.start());
        const secondStore = durableOver(await sub.second());
        await first.insert(admittedRow('rec-1'));
        const id = child('rec-1');
        const opened = await secondStore.get(id);
        assert.ok(opened !== null);
        assert.equal(opened.version, 1);
        // First handle wins the fence with its observed version.
        const won = await first.claim(evaluateTrue, {
          child: id,
          snapshotVersion: opened.version,
          guard: unconditional,
          frozenInputs: {},
          readCurrentSnapshot: currentOf({}),
        });
        assert.equal(won.status, 'claimed');
        assert.equal(won.row.version, 2);
        assert.equal(readFanoutChildRow(won.row).state, 'running');
        assert.equal(readFanoutChildRow(won.row).attempts, 0);
        // Stale snapshot against the live claim still observes the
        // winner (F3 order: running-hold precedes stale-refusal, so a
        // stale read can never win admission); guard never ran.
        let guardRan = false;
        const stale = await secondStore.claim(() => {
          guardRan = true;
          return true;
        }, {
          child: id,
          snapshotVersion: opened.version,
          guard: { predicate: 'late' },
          frozenInputs: {},
          readCurrentSnapshot: currentOf({}),
        });
        assert.equal(stale.status, 'held');
        assert.equal(guardRan, false);
        assert.equal(stale.row.version, 2);
        assert.equal(readFanoutChildRow(stale.row).state, 'running');
        // Live loser without a snapshot holds the existing claim.
        const held = await secondStore.claim(evaluateTrue, {
          child: id,
          snapshotVersion: null,
          guard: unconditional,
          frozenInputs: {},
          readCurrentSnapshot: currentOf({}),
        });
        assert.equal(held.status, 'held');
        assert.equal(held.row.version, 2);
        assert.equal(held.row.id, won.row.id);
      });
    });

    it('null-snapshot racers: one claimed, one held, one version bump', async () => {
      await withRestart(kind, 'racers', async (sub) => {
        const first = durableOver(await sub.start());
        const secondStore = durableOver(await sub.second());
        await first.insert(admittedRow('rec-race'));
        const id = child('rec-race');
        const attempt = {
          child: id,
          snapshotVersion: null,
          guard: unconditional,
          frozenInputs: {},
          readCurrentSnapshot: currentOf({}),
        } as const;
        const raced = await Promise.all([
          first.claim(evaluateTrue, { ...attempt }),
          secondStore.claim(evaluateTrue, { ...attempt }),
        ]);
        const claimed = raced.filter((outcome) => outcome.status === 'claimed');
        const held = raced.filter((outcome) => outcome.status === 'held');
        assert.equal(claimed.length, 1);
        assert.equal(held.length, 1);
        assert.equal(claimed[0]?.row.version, 2);
        assert.equal(held[0]?.row.version, 2);
        assert.equal(held[0]?.row.id, claimed[0]?.row.id);
        assert.equal(readFanoutChildRow(held[0]?.row as StoredRow).attempts, 0);
      });
    });

    it('refusals record terminal failed/inaccessible-record without attempts', async () => {
      await withRestart(kind, 'refusals', async (sub) => {
        const store = durableOver(await sub.start());
        await store.insert(admittedRow('rec-scope'));
        await store.insert(admittedRow('rec-revoked'));
        // Inherited scope never runs the guard.
        let guardRan = false;
        const inherited = await store.claim(() => {
          guardRan = true;
          return true;
        }, {
          child: child('rec-scope'),
          snapshotVersion: null,
          guard: { predicate: 'late' },
          frozenInputs: {},
          readCurrentSnapshot: currentOf({}),
          fence: {
            checkpoint: { revision: 7, owner: 'owner-1' },
            triggerRevision: { revision: 7 },
          },
        });
        assert.equal(inherited.status, 'refused-inherited-scope');
        assert.equal(guardRan, false);
        assert.equal(inherited.outcome.state, 'failed');
        assert.equal(readFanoutChildRow(inherited.row).causeReason, 'inaccessible-record');
        assert.equal(readFanoutChildRow(inherited.row).attempts, 0);
        // Revoked authority mints no claim even when the guard passes.
        const revoked = await store.claim(evaluateTrue, {
          child: child('rec-revoked'),
          snapshotVersion: null,
          guard: unconditional,
          frozenInputs: {},
          readCurrentSnapshot: currentOf({}),
          fence: { ...FENCE, revalidateAuthority: () => false },
        });
        assert.equal(revoked.status, 'refused-revoked');
        assert.equal(revoked.outcome.state, 'failed');
        assert.equal(readFanoutChildRow(revoked.row).causeReason, 'inaccessible-record');
        assert.equal(readFanoutChildRow(revoked.row).attempts, 0);
        // Both refusals replay their terminal outcomes; nothing retries.
        const replay = await store.claim(evaluateTrue, {
          child: child('rec-revoked'),
          snapshotVersion: null,
          guard: unconditional,
          frozenInputs: {},
          readCurrentSnapshot: currentOf({}),
          fence: FENCE,
        });
        assert.equal(replay.status, 'replayed');
        assert.deepEqual(replay.outcome, revoked.outcome);
      });
    });

    it('guard-false records skipped/non-applicable on the current snapshot', async () => {
      await withRestart(kind, 'guard', async (sub) => {
        const store = durableOver(await sub.start());
        await store.insert(admittedRow('rec-guard'));
        let seenSnapshot: unknown = null;
        const skipped = await store.claim((predicate, frozen, snapshot) => {
          seenSnapshot = snapshot;
          assert.equal(predicate, 'applies');
          return false;
        }, {
          child: child('rec-guard'),
          snapshotVersion: null,
          guard: { predicate: 'applies' },
          frozenInputs: { keep: true },
          readCurrentSnapshot: currentOf({ live: 1 }),
        });
        assert.equal(skipped.status, 'skipped');
        assert.deepEqual(seenSnapshot, { live: 1 });
        assert.equal(skipped.outcome.state, 'skipped');
        assert.equal(readFanoutChildRow(skipped.row).causeReason, 'non-applicable');
        assert.equal(readFanoutChildRow(skipped.row).attempts, 0);
      });
    });

    it('record completes atomically; duplicates replay; idle record throws', async () => {
      await withRestart(kind, 'record', async (sub) => {
        const store = durableOver(await sub.start());
        await store.insert(admittedRow('rec-done'));
        await store.insert(admittedRow('rec-idle'));
        const id = child('rec-done');
        const claimed = await store.claim(evaluateTrue, {
          child: id,
          snapshotVersion: null,
          guard: unconditional,
          frozenInputs: {},
          readCurrentSnapshot: currentOf({}),
        });
        assert.equal(claimed.status, 'claimed');
        const recorded = await store.record({
          child: id,
          result: { kind: 'completed' },
          nowMs: NOW,
          firstAttemptAtMs: NOW,
          policy: POLICY,
        });
        assert.equal(recorded.status, 'recorded');
        assert.equal(recorded.outcome.state, 'completed');
        assert.equal(recorded.outcome.attempts, 1);
        assert.equal(recorded.row.version, 3);
        // Duplicate delivery replays the recorded outcome, minting nothing.
        const replay = await store.record({
          child: id,
          result: { kind: 'completed' },
          nowMs: NOW,
          firstAttemptAtMs: NOW,
          policy: POLICY,
        });
        assert.equal(replay.status, 'replayed');
        assert.deepEqual(replay.outcome, recorded.outcome);
        assert.equal(replay.row.version, 3);
        // Record needs a running claim: idle pending rows throw loudly.
        await assert.rejects(
          store.record({
            child: child('rec-idle'),
            result: { kind: 'completed' },
            nowMs: NOW,
            firstAttemptAtMs: NOW,
            policy: POLICY,
          }),
          /running children only/,
        );
      });
    });

    it('transient retries within budget; exhaustion dead-letters visibly', async () => {
      await withRestart(kind, 'retry', async (sub) => {
        const store = durableOver(await sub.start());
        await store.insert(admittedRow('rec-retry'));
        await store.insert(admittedRow('rec-horizon'));
        const claimInput = (recordId: string) => ({
          child: child(recordId),
          snapshotVersion: null as number | null,
          guard: unconditional,
          frozenInputs: {},
          readCurrentSnapshot: currentOf({}),
        });
        const tight: RetryPolicy = { maxAttempts: 2, horizonMs: 60_000 };
        assert.equal((await store.claim(evaluateTrue, claimInput('rec-retry'))).status, 'claimed');
        const retried = await store.record({
          child: child('rec-retry'),
          result: { kind: 'transient' },
          nowMs: NOW,
          firstAttemptAtMs: NOW,
          policy: tight,
        });
        assert.equal(retried.status, 'retried');
        assert.equal(readFanoutChildRow(retried.row).state, 'pending');
        assert.equal(readFanoutChildRow(retried.row).attempts, 1);
        // A stale snapshot against the still-pending row refuses: stale
        // reads never win admission, and the guard never runs.
        let staleGuardRan = false;
        const stalePending = await store.claim(() => {
          staleGuardRan = true;
          return true;
        }, {
          ...claimInput('rec-retry'),
          snapshotVersion: 2,
          guard: { predicate: 'late' },
        });
        assert.equal(stalePending.status, 'refused-stale');
        assert.equal(staleGuardRan, false);
        assert.equal(stalePending.row.version, 3);
        assert.equal(readFanoutChildRow(stalePending.row).state, 'pending');
        // Same row identity retries, then the cap dead-letters.
        assert.equal((await store.claim(evaluateTrue, claimInput('rec-retry'))).status, 'claimed');
        const exhausted = await store.record({
          child: child('rec-retry'),
          result: { kind: 'transient' },
          nowMs: NOW + 1_000,
          firstAttemptAtMs: NOW,
          policy: tight,
        });
        assert.equal(exhausted.status, 'recorded');
        assert.equal(exhausted.outcome.state, 'failed');
        assert.equal(readFanoutChildRow(exhausted.row).causeReason, 'exhausted');
        assert.equal(exhausted.outcome.attempts, 2);
        // The time horizon dead-letters even far under the attempt cap.
        assert.equal((await store.claim(evaluateTrue, claimInput('rec-horizon'))).status, 'claimed');
        const timedOut = await store.record({
          child: child('rec-horizon'),
          result: { kind: 'transient' },
          nowMs: NOW,
          firstAttemptAtMs: NOW - 60_000,
          policy: { maxAttempts: 10, horizonMs: 60_000 },
        });
        assert.equal(timedOut.status, 'recorded');
        assert.equal(readFanoutChildRow(timedOut.row).causeReason, 'exhausted');
      });
    });

    it('kill/restart: units survive whole, mid-claim resumes, progress settles', async () => {
      await withRestart(kind, 'restart', async (sub) => {
        const store = durableOver(await sub.start());
        for (const recordId of ['u-a', 'u-b', 'u-c', 'u-d']) {
          await store.insert(admittedRow(recordId));
        }
        const claimInput = (recordId: string) => ({
          child: child(recordId),
          snapshotVersion: null as number | null,
          guard: unconditional,
          frozenInputs: {},
          readCurrentSnapshot: currentOf({}),
        });
        // Child A completes its full unit pre-crash.
        assert.equal((await store.claim(evaluateTrue, claimInput('u-a'))).status, 'claimed');
        assert.equal((await store.record({
          child: child('u-a'),
          result: { kind: 'completed' },
          nowMs: NOW,
          firstAttemptAtMs: NOW,
          policy: POLICY,
        })).status, 'recorded');
        // Child B claims (pending->running) and the process dies before
        // its outcome commit: the claim instant is durable, the unit
        // never ran, so nothing partial exists.
        assert.equal((await store.claim(evaluateTrue, claimInput('u-b'))).status, 'claimed');
        // Child D pins skipped pre-crash.
        const pinned = await store.claim(() => false, {
          ...claimInput('u-d'),
          guard: { predicate: 'applies' },
        });
        assert.equal(pinned.status, 'skipped');
        // THE KILL + RESTART.
        await sub.kill();
        const rebooted = durableOver(await sub.start());
        // Durable truth survives whole: A complete, B running with no
        // outcome, C still pending, D skipped.
        const rowA = await rebooted.get(child('u-a'));
        const rowB = await rebooted.get(child('u-b'));
        const rowC = await rebooted.get(child('u-c'));
        const rowD = await rebooted.get(child('u-d'));
        assert.ok(rowA !== null && rowB !== null && rowC !== null && rowD !== null);
        assert.equal(readFanoutChildRow(rowA).state, 'completed');
        assert.equal(readFanoutChildRow(rowB).state, 'running');
        assert.equal(readFanoutChildRow(rowB).attempts, 0);
        assert.equal(readFanoutChildRow(rowC).state, 'pending');
        assert.equal(readFanoutChildRow(rowD).state, 'skipped');
        // B resumes post-restart: its running claim records completed.
        const resumedB = await rebooted.record({
          child: child('u-b'),
          result: { kind: 'completed' },
          nowMs: NOW + 5_000,
          firstAttemptAtMs: NOW,
          policy: POLICY,
        });
        assert.equal(resumedB.status, 'recorded');
        assert.equal(resumedB.outcome.attempts, 1);
        // C claims fresh post-restart, then fails terminally.
        assert.equal((await rebooted.claim(evaluateTrue, claimInput('u-c'))).status, 'claimed');
        const failedC = await rebooted.record({
          child: child('u-c'),
          result: { kind: 'failed', reason: 'business-rejection' },
          nowMs: NOW + 5_000,
          firstAttemptAtMs: NOW,
          policy: POLICY,
        });
        assert.equal(failedC.status, 'recorded');
        assert.equal(readFanoutChildRow(failedC.row).causeReason, 'business-rejection');
        // Progress settles terminal with attention (one failure present).
        assert.deepEqual(await rebooted.progress(FANOUT), {
          fanoutId: FANOUT,
          pending: 0,
          running: 0,
          completed: 2,
          skipped: 1,
          failed: 1,
          terminal: true,
          attention: true,
        });
      });
    });

    it('duplicate insert throws like a PK conflict', async () => {
      await withRestart(kind, 'dup', async (sub) => {
        const store = durableOver(await sub.start());
        await store.insert(admittedRow('rec-dup'));
        await assert.rejects(store.insert(admittedRow('rec-dup')), /duplicate fanout child row/);
      });
    });
  });
}

/* -- Substrate-free differential: durable matches the F3 memory oracle. -- */

describe('t34-f7 differential against the F3 memory store', () => {
  it('claim/record sequences agree on status, state, attempts and causes', async () => {
    const memory = new TestOnlyMemoryFanoutChildStore(new TestOnlyManualClock(NOW));
    const durable = durableOver(createMemoryStorage());
    for (const store of [memory, durable] as const) {
      await store.insert(admittedRow('rec-x'));
      await store.insert(admittedRow('rec-y'));
    }
    const claimInput = (recordId: string) => ({
      child: child(recordId),
      snapshotVersion: null as number | null,
      guard: unconditional,
      frozenInputs: {},
      readCurrentSnapshot: currentOf({}),
    });
    const memClaim = memory.claim(evaluateTrue, claimInput('rec-x'));
    const durClaim = await durable.claim(evaluateTrue, claimInput('rec-x'));
    assert.equal(durClaim.status, memClaim.status);
    assert.equal(readFanoutChildRow(durClaim.row as StoredRow).state, 'running');
    assert.equal((durClaim.row as StoredRow).version, (memClaim.row as StoredRow).version);
    const memRecord = memory.record({
      child: child('rec-x'),
      result: { kind: 'completed' },
      nowMs: NOW,
      firstAttemptAtMs: NOW,
      policy: POLICY,
    });
    const durRecord = await durable.record({
      child: child('rec-x'),
      result: { kind: 'completed' },
      nowMs: NOW,
      firstAttemptAtMs: NOW,
      policy: POLICY,
    });
    assert.equal(durRecord.status, memRecord.status);
    assert.deepEqual(
      ((x) => ({ state: x.state, attempts: x.attempts, cause: x.causeReason }))(
        readFanoutChildRow(durRecord.row as StoredRow),
      ),
      ((x) => ({ state: x.state, attempts: x.attempts, cause: x.causeReason }))(
        readFanoutChildRow(memRecord.row as StoredRow),
      ),
    );
    // Guard-false pins agree too.
    const memSkip = memory.claim(() => false, {
      ...claimInput('rec-y'),
      guard: { predicate: 'applies' },
    });
    const durSkip = await durable.claim(() => false, {
      ...claimInput('rec-y'),
      guard: { predicate: 'applies' },
    });
    assert.equal(durSkip.status, memSkip.status);
    assert.equal(
      readFanoutChildRow((durSkip as { row: StoredRow }).row).causeReason,
      readFanoutChildRow((memSkip as { row: StoredRow }).row).causeReason,
    );
  });
});
