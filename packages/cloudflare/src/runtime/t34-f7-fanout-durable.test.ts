/**
 * T34-F7 fanout join: durable proofs on REAL substrates.
 *
 * Extends the T24b miniflare-D1 + workerd-DO harness (ephemeral
 * handles, cross-handle read-back) with the F5 real-restart pattern
 * (per-test persist dir, dispose = kill, fresh boot over the same
 * dir = restart). Proves per substrate: atomic trigger/intent
 * commits with exact revision steps, exactly-one-winner claim and
 * record races across handles, multi-chunk admission + sweeps to
 * terminal through the real path, chunk!=cohort through the real
 * path, REAL-restart resume without re-execution, stale-claim resume
 * after restart, and the retry horizon enforced from durable truth
 * across restart. Single-owner scope only: cross-store atomicity is
 * NOT claimed and must not be inferred.
 *
 * Run from dist: root build, then
 * `node --test packages/cloudflare/dist/runtime/t34-f7-fanout-durable.test.js`.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import type {
  ModelName,
  RecordId,
  ResolvedIdentity,
  RetryPolicy,
  Revision,
  StoragePort,
  StoredRow,
} from "@canlang/contracts";
import { createD1Storage, ensureSchema } from "@canlang/state/storage/d1";
import {
  FenceConflictError,
  StorageConstraintError,
} from "@canlang/state/storage/port";
import type { OperationRegistry } from "@canlang/state/invocation/registry";
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
} from "@canlang/state/testing/invocation/fixtures";
import type { TestMembershipStore } from "@canlang/state/testing/invocation/fixtures";
import {
  T34F7_FANOUT_CHECKPOINT_MODEL,
  T34F7_FANOUT_CHILD_MODEL,
  T34F7_FANOUT_INTENT_MODEL,
  claimFanoutChild,
  loadFanoutStateProducers,
  readFanoutSchedulerProgress,
  recordFanoutChildAttempt,
  runFanoutSchedulerTurn,
  stageFanoutTriggerJoin,
} from "./invoke.js";
import type {
  FanoutSchedulerBodyPort,
  FanoutSchedulerTurnBounds,
  FanoutStateProducers,
  RunFanoutSchedulerTurnOpts,
} from "./invoke.js";

const MODEL = "Acme.Commitment";
const HANDLER = "Shift.review_commitment";
const APP = "acme-app";
const CHILD_OP = "Acme.review_child";
const ACTOR = "t34-f7-durable";
const NOW = FIXED_NOW;
const POLICY: RetryPolicy = { maxAttempts: 3, horizonMs: 60_000 };
const MAX_AGE = 60_000;

const producers: FanoutStateProducers = await loadFanoutStateProducers();

/**
 * CWD anchor (the F2/F4 lesson, F5-exact): workerd mounts its module
 * filesystem at the miniflare host's process CWD, and the reused DO
 * worker's relative adapter import resolves under `@canlang/state`.
 * Anchor the process CWD at the state package for the run and restore
 * it afterwards; node:test runs each file in its own process, so the
 * anchor cannot leak into other suites. Every path here is
 * import.meta-derived absolute, so the anchor moves nothing but the
 * workerd mount.
 */
const stateDirPath = fileURLToPath(new URL("../../", import.meta.resolve("@canlang/state/distribution")));
const entryCwd = process.cwd();
process.chdir(stateDirPath);

let opSeq = 1000;
function nextOpId(): string {
  opSeq += 1;
  return uuidv7(NOW, opSeq);
}

/* -- Substrate handles: real local D1 + real workerd DO SQLite. -- */

let d1mf: Miniflare | undefined;
let d1db: D1Database;

const D1_TABLES = [
  "records",
  "history",
  "receipts",
  "outbox",
  "schedules",
  "unique_claims",
  "snapshots",
  "migration_staging",
  "migration_progress",
  "migration_outcomes",
];

async function resetD1(): Promise<void> {
  await d1db.batch([
    ...D1_TABLES.map((table) => d1db.prepare(`DELETE FROM ${table}`)),
    d1db.prepare("DELETE FROM fence_log"),
    d1db.prepare("UPDATE fence SET revision = 0 WHERE id = 1"),
  ]);
}

const doWorkerPath = fileURLToPath(
  new URL(import.meta.resolve("@canlang/state/testing/storage/do-test-worker")),
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

function rehydrate(error: WorkerErrorJson): Error {
  if (error.name === "FenceConflictError") {
    return new FenceConflictError(
      error.expected as unknown as Revision,
      (error.actual ?? null) as unknown as Revision | null,
    );
  }
  if (error.name === "StorageConstraintError") {
    return new StorageConstraintError(
      (error.kind ?? "unknown") as StorageConstraintError["kind"],
      error.detail ?? error.message,
    );
  }
  const rebuilt = new Error(error.message);
  rebuilt.name = error.name;
  return rebuilt;
}

async function doPost(mf: Miniflare, path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await mf.dispatchFetch(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

async function doCall<T>(mf: Miniflare, method: string, ...args: ReadonlyArray<unknown>): Promise<T> {
  const data = await doPost(mf, "/call", { method, args });
  if (data["ok"] !== true) {
    throw rehydrate(data["error"] as unknown as WorkerErrorJson);
  }
  return data["value"] as T;
}

function doProxy(mf: Miniflare): StoragePort {
  return {
    readRevision: () => doCall(mf, "readRevision"),
    load: (model: ModelName, id: RecordId) => doCall(mf, "load", model, id),
    query: (spec) => doCall(mf, "query", spec),
    commit: (batch) => doCall(mf, "commit", batch),
    readReceipt: (identity) => doCall(mf, "readReceipt", identity),
    outboxPending: () => doCall(mf, "outboxPending"),
    scheduleGet: (key) => doCall(mf, "scheduleGet", key),
    schedulesDue: (now, limit) => doCall(mf, "schedulesDue", now, limit),
    historyFor: (model, recordId) => doCall(mf, "historyFor", model, recordId),
    readInstalledSnapshot: (owner) => doCall(mf, "readInstalledSnapshot", owner),
    readMigrationProgress: (migrationId) => doCall(mf, "readMigrationProgress", migrationId),
    readStagedRows: (migrationId, cursor, limit) =>
      doCall(mf, "readStagedRows", migrationId, cursor, limit),
    stageMigrationRows: (input) => doCall(mf, "stageMigrationRows", input),
    publishMigrationChunk: (input) => doCall(mf, "publishMigrationChunk", input),
    flipInstalledSnapshot: (input) => doCall(mf, "flipInstalledSnapshot", input),
    readMigrationOutcomes: (migrationId) => doCall(mf, "readMigrationOutcomes", migrationId),
    recordMigrationFailure: (input) => doCall(mf, "recordMigrationFailure", input),
    discardStagedRows: (input) => doCall(mf, "discardStagedRows", input),
    readMigrationFailure: (migrationId) => doCall(mf, "readMigrationFailure", migrationId),
  };
}

async function resetDO(mf: Miniflare): Promise<void> {
  const data = await doPost(mf, "/reset", {});
  if (data["ok"] !== true) {
    throw rehydrate(data["error"] as unknown as WorkerErrorJson);
  }
}

before(async () => {
  d1mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: ["DB"],
  });
  d1db = await d1mf.getD1Database("DB");
  await ensureSchema(d1db);

  doMf = new Miniflare({
    modules: true,
    scriptPath: doWorkerPath,
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    compatibilityDate: "2025-01-01",
    durableObjects: {
      TEST_DO: { className: "TestDO", useSQLite: true, unsafePreventEviction: true },
    },
  });
  await resetDO(doMf);
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
  process.chdir(entryCwd);
});

/* -- Restartable substrate: boot -> kill (dispose) -> reboot (same dir). -- */

type SubstrateKind = "d1" | "do";

interface Restartable {
  readonly kind: SubstrateKind;
  start: () => Promise<StoragePort>;
  kill: () => Promise<void>;
}

async function openRestartable(kind: SubstrateKind, dir: string): Promise<Restartable> {
  let mf: Miniflare | undefined;
  const start = async (): Promise<StoragePort> => {
    if (kind === "d1") {
      mf = new Miniflare({
        modules: true,
        script: 'export default { fetch() { return new Response("ok"); } }',
        d1Databases: ["DB"],
        d1Persist: join(dir, "d1"),
      });
      const db = (await mf.getD1Database("DB")) as D1Database;
      await ensureSchema(db);
      return createD1Storage(db);
    }
    mf = new Miniflare({
      modules: true,
      scriptPath: doWorkerPath,
      modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
      compatibilityDate: "2025-01-01",
      durableObjectsPersist: join(dir, "do"),
      durableObjects: {
        TEST_DO: { className: "TestDO", useSQLite: true, unsafePreventEviction: true },
      },
    });
    const instance = mf;
    return doProxy(instance);
  };
  const kill = async (): Promise<void> => {
    if (mf !== undefined) {
      await mf.dispose();
      mf = undefined;
    }
  };
  return { kind, start, kill };
}

/* -- World setup (substrate store + memory-side registry/memberships). -- */

interface World {
  readonly store: StoragePort;
  readonly memberships: TestMembershipStore;
  readonly registry: OperationRegistry;
  readonly identity: ResolvedIdentity;
  readonly owner: string;
  readonly clock: { nowMs(): number };
}

async function setupWorld(store: StoragePort, nowMs: number = NOW): Promise<World> {
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const registry: OperationRegistry = new Map();
  (registry as Map<string, unknown>).set(
    CHILD_OP,
    makeDef({
      name: asOperation(CHILD_OP),
      by: "members",
      inputs: {
        record: { type: "record", model: asModel(MODEL), versioned: false, required: true },
      },
    }),
  );
  return {
    store,
    memberships,
    registry,
    identity: makeIdentity({ membership: alice.membership }),
    owner: alice.team.team_id as string,
    clock: { nowMs: () => nowMs },
  };
}

async function seedDomain(store: StoragePort, model: string, ids: ReadonlyArray<string>): Promise<void> {
  if (ids.length === 0) return;
  const revision = await store.readRevision();
  await store.commit(
    makeBatch(revision as number, {
      writes: ids.map((id) => ({
        kind: "insert",
        model: asModel(model),
        row: makeRow({ id, data: { label: id } }),
      })),
    }),
  );
}

async function triggerJoin(
  world: World,
  source: string,
  bounds: { readonly pageLimit: number; readonly chunkSize: number } = { pageLimit: 10, chunkSize: 10 },
  meta: { readonly nowMs: number; readonly actor: string } = { nowMs: NOW, actor: ACTOR },
) {
  return stageFanoutTriggerJoin({
    store: world.store,
    cutoff: { sourceOccurrence: source, handler: HANDLER },
    cohort: { kind: "model", owner: world.owner, model: MODEL },
    owner: world.owner,
    bounds,
    meta,
    stageSource: () => ({
      writes: [],
      history: [],
      receipt: null,
      outbox: [],
      schedules: [],
      uniqueClaims: [],
      uniqueReleases: [],
    }),
    hasModel: (model: string) => model === MODEL,
    producers,
  });
}

function turnOpts(
  world: World,
  fanoutId: string,
  cursor: string | null,
  bounds: FanoutSchedulerTurnBounds,
  body: FanoutSchedulerBodyPort,
  over: Partial<RunFanoutSchedulerTurnOpts> = {},
): RunFanoutSchedulerTurnOpts {
  return {
    store: world.store,
    fanoutId,
    cursor,
    bounds,
    policy: POLICY,
    meta: { nowMs: NOW, actor: ACTOR },
    maxClaimAgeMs: MAX_AGE,
    cohort: { model: MODEL },
    guard: { predicate: null, frozenInputs: null },
    evaluateGuard: () => true,
    readSnapshot: () => ({}),
    fenceFor: () => ({ owner: world.owner, revalidateAuthority: () => true }),
    body,
    invoke: {
      registry: world.registry,
      memberships: world.memberships,
      clock: world.clock,
      identity: world.identity,
      app: APP,
      source: "test",
      childOperation: CHILD_OP,
      refInput: "record",
      operationIdFor: () => nextOpId(),
    },
    producers,
    ...over,
  };
}

async function sweepToTerminal(
  makeTurn: (cursor: string | null) => Promise<RunFanoutSchedulerTurnOpts>,
): Promise<void> {
  let cursor: string | null = null;
  let turns = 0;
  for (;;) {
    const result = await runFanoutSchedulerTurn(await makeTurn(cursor));
    assert.equal(result.status, "turn");
    if (result.status !== "turn") throw new Error("unreachable");
    turns += 1;
    if (turns > 60) throw new Error("sweep did not terminate (60 turns).");
    if (result.done) {
      if (result.progress.terminal) return;
      cursor = null;
    } else {
      cursor = result.cursor;
    }
  }
}

async function drainChildren(store: StoragePort, fanoutId: string): Promise<StoredRow[]> {
  const rows: StoredRow[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = producers.tables.fanoutChildPageResult(
      await store.query(producers.tables.fanoutChildPageQuery(fanoutId, { cursor, limit: 50 })),
      50,
    );
    rows.push(...page.rows);
    if (page.done) return rows;
    cursor = page.cursor;
  }
}

/** Completing body with a durable per-record execution counter (re-execution witness). */
function countingBody(): FanoutSchedulerBodyPort {
  return async (_child, domainRow) => {
    const data = domainRow.data as Record<string, unknown>;
    const count = typeof data["count"] === "number" ? (data["count"] as number) : 0;
    const next: StoredRow = {
      ...domainRow,
      version: (domainRow.version + 1) as StoredRow["version"],
      updated: NOW,
      updatedBy: ACTOR,
      data: { ...data, reviewed: true, count: count + 1 },
    };
    return {
      writes: [
        {
          kind: "update",
          model: asModel(MODEL),
          id: domainRow.id,
          expectedVersion: domainRow.version,
          row: next,
        },
      ],
      history: [],
      outbox: [],
      schedules: [],
      result: { kind: "completed" },
    };
  };
}

function freezeSpec(world: World, source: string) {
  return {
    cutoff: { sourceOccurrence: source, handler: HANDLER },
    cohort: { kind: "model" as const, owner: world.owner, model: MODEL },
    owner: world.owner,
    bounds: { pageLimit: 2, chunkSize: 2, maxAttempts: 3 },
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
  describe(`T34-F7 fanout durable (${name})`, () => {
    it("trigger join commits atomically with exact revisions + cross-handle read-back", async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const world = await setupWorld(store);
      await seedDomain(store, MODEL, ["c1", "c2", "c3"]);
      const before = await store.readRevision();
      const joined = await triggerJoin(world, "occ-atomic");
      assert.equal(joined.ok, true);
      if (!joined.ok) throw new Error("unreachable");
      assert.equal(joined.cutoffRevision, before);
      assert.equal(joined.commitRevision, (before as number) + 1);
      assert.equal(await store.readRevision(), (before as number) + 1);
      const peer = secondHandle();
      const intent = await peer.load(T34F7_FANOUT_INTENT_MODEL, joined.fanoutId as RecordId);
      assert.ok(intent !== null);
      assert.deepEqual(producers.tables.readFanoutIntentRow(intent).members, ["c1", "c2", "c3"]);
      const checkpoint = await peer.load(
        T34F7_FANOUT_CHECKPOINT_MODEL,
        joined.fanoutId as RecordId,
      );
      assert.ok(checkpoint !== null);
      assert.deepEqual(producers.tables.readFanoutCheckpointRow(checkpoint).completed, []);
      assert.equal((await drainChildren(peer, joined.fanoutId)).length, 3);
    });

    it("claim race: exactly one winner across handles, losers hold", async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const world = await setupWorld(store);
      await seedDomain(store, MODEL, ["c1"]);
      const joined = await triggerJoin(world, "occ-race");
      assert.equal(joined.ok, true);
      if (!joined.ok) throw new Error("unreachable");
      const peer = secondHandle();
      const stores = [store, peer];
      const racers = Array.from({ length: 8 }, (_, i) =>
        claimFanoutChild({
          store: stores[i % 2] as StoragePort,
          child: { parentOccurrence: "occ-race", handler: HANDLER, recordId: "c1" },
          snapshotVersion: null,
          guard: { predicate: null },
          frozenInputs: null,
          readCurrentSnapshot: () => ({}),
          evaluateGuard: () => true,
          policy: POLICY,
          meta: { nowMs: NOW, actor: `${ACTOR}-racer-${i}` },
          producers,
        }),
      );
      const outcomes = await Promise.all(racers);
      const claimed = outcomes.filter((o) => o.status === "claimed");
      const held = outcomes.filter((o) => o.status === "held");
      assert.equal(claimed.length, 1);
      assert.equal(held.length, 7);
      const winner = claimed[0];
      assert.ok(winner !== undefined && winner.status === "claimed");
      assert.equal(winner.row.version, 2);
      for (const loser of held) {
        assert.ok(loser.status === "held");
        assert.equal(loser.row.version, 2);
      }
      const stored = await peer.load(
        T34F7_FANOUT_CHILD_MODEL,
        producers.tables.fanoutChildRowId("occ-race", HANDLER, "c1") as RecordId,
      );
      assert.ok(stored !== null);
      assert.equal(producers.tables.readFanoutChildRow(stored).state, "running");
      assert.equal(producers.tables.readFanoutChildRow(stored).attempts, 0);
    });

    it("record race: fence loser throws, version loser replays the winner", async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const world = await setupWorld(store);
      await seedDomain(store, MODEL, ["c1", "c2"]);
      const claimBoth = async (source: string, record: string): Promise<void> => {
        const won = await claimFanoutChild({
          store,
          child: { parentOccurrence: source, handler: HANDLER, recordId: record },
          snapshotVersion: null,
          guard: { predicate: null },
          frozenInputs: null,
          readCurrentSnapshot: () => ({}),
          evaluateGuard: () => true,
          policy: POLICY,
          meta: { nowMs: NOW, actor: ACTOR },
          producers,
        });
        assert.equal(won.status, "claimed");
      };
      // Concurrent race: both read the same fence, the winner moves
      // it, the loser throws FenceConflict (single-shot: callers
      // decide — the fence always propagates out of record).
      const joinedRace = await triggerJoin(world, "occ-record-fence");
      assert.equal(joinedRace.ok, true);
      if (!joinedRace.ok) throw new Error("unreachable");
      await claimBoth("occ-record-fence", "c1");
      const peer = secondHandle();
      const recordArgs = (target: StoragePort) => ({
        store: target,
        child: { parentOccurrence: "occ-record-fence", handler: HANDLER, recordId: "c1" },
        result: { kind: "completed" } as const,
        nowMs: NOW,
        policy: POLICY,
        meta: { nowMs: NOW, actor: ACTOR },
        producers,
      });
      const [first, second] = await Promise.allSettled([
        recordFanoutChildAttempt(recordArgs(store)),
        recordFanoutChildAttempt(recordArgs(peer)),
      ]);
      const fulfilled = [first, second].filter((o) => o.status === "fulfilled");
      const rejected = [first, second].filter((o) => o.status === "rejected");
      // Exactly one winner records. The loser either throws fence
      // conflict or replays the winner — substrate timing decides
      // which interleave wins (D1 deterministically throws; DO may
      // load after the winner's commit and replay). Both are honest
      // contention outcomes: no duplicate record, winner's outcome
      // kept. (T24b accepted-variance precedent.)
      const recorded = fulfilled.filter((o) => o.status === "fulfilled" && o.value.status === "recorded");
      assert.equal(recorded.length, 1);
      const win = recorded[0];
      assert.ok(win !== undefined && win.status === "fulfilled" && win.value.status === "recorded");
      for (const entry of fulfilled) {
        assert.ok(entry.status === "fulfilled");
        if (entry.value.status === "replayed") {
          assert.deepEqual(entry.value.outcome, win.value.outcome);
        } else {
          assert.equal(entry.value.status, "recorded");
        }
      }
      for (const loss of rejected) {
        assert.ok(loss.status === "rejected");
        const reason: unknown = loss.reason;
        assert.ok(
          reason instanceof FenceConflictError ||
            (typeof reason === "object" &&
              reason !== null &&
              (reason as { name?: unknown }).name === "FenceConflictError"),
        );
      }
      assert.equal(fulfilled.length + rejected.length, 2);
      // Version race, deterministically interleaved: the loser loads
      // + stages BEFORE the winner commits (its fence read gates on
      // the winner), then commits under the fresh fence and loses on
      // the row versions — replaying the winner's outcome.
      const joinedReplay = await triggerJoin(world, "occ-record-replay");
      assert.equal(joinedReplay.ok, true);
      if (!joinedReplay.ok) throw new Error("unreachable");
      await claimBoth("occ-record-replay", "c2");
      let releaseFence: (() => void) | null = null;
      const fenceGate = new Promise<void>((resolve) => {
        releaseFence = resolve;
      });
      let fenceReads = 0;
      const gatedPeer: StoragePort = {
        ...peer,
        readRevision: async () => {
          fenceReads += 1;
          if (fenceReads === 1) await fenceGate;
          return peer.readRevision();
        },
      };
      const loser = recordFanoutChildAttempt({
        store: gatedPeer,
        child: { parentOccurrence: "occ-record-replay", handler: HANDLER, recordId: "c2" },
        result: { kind: "completed" },
        nowMs: NOW,
        policy: POLICY,
        meta: { nowMs: NOW, actor: ACTOR },
        producers,
      });
      // Let the loser load + stage up to its fence read, then win.
      for (let i = 0; i < 400 && fenceReads === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(fenceReads, 1);
      const wonRecord = await recordFanoutChildAttempt({
        store,
        child: { parentOccurrence: "occ-record-replay", handler: HANDLER, recordId: "c2" },
        result: { kind: "completed" },
        nowMs: NOW,
        policy: POLICY,
        meta: { nowMs: NOW, actor: ACTOR },
        producers,
      });
      assert.equal(wonRecord.status, "recorded");
      // The Promise executor above runs synchronously, so the gate is
      // always armed here; the cast defeats the `= null` initializer
      // narrowing (TS cannot see the closure assignment, and any
      // guard/assert on the narrowed `null` collapses to `never`).
      const release = releaseFence as (() => void) | null;
      assert.ok(release !== null, "unreachable: fence gate never armed");
      release();
      const lostRecord = await loser;
      assert.equal(lostRecord.status, "replayed");
      if (lostRecord.status !== "replayed") throw new Error("unreachable");
      assert.equal(lostRecord.outcome.state, "completed");
      assert.equal(lostRecord.row.version, 3);
      assert.equal(wonRecord.status === "recorded" ? wonRecord.row.version : -1, 3);
    });

    it("multi-chunk admission + sweep reaches terminal through the real path", async () => {
      const { store, reset } = await handles();
      await reset();
      const world = await setupWorld(store);
      await seedDomain(store, MODEL, ["c1", "c2", "c3", "c4", "c5"]);
      const joined = await triggerJoin(world, "occ-sweep", { pageLimit: 2, chunkSize: 2 });
      assert.equal(joined.ok, true);
      if (!joined.ok) throw new Error("unreachable");
      assert.equal(joined.chunksTotal, 3);
      assert.equal((await drainChildren(store, joined.fanoutId)).length, 2);
      await sweepToTerminal(async (cursor) =>
        turnOpts(world, joined.fanoutId, cursor, { pageLimit: 2, maxDrives: 2 }, countingBody(), {
          freeze: freezeSpec(world, "occ-sweep"),
        }),
      );
      const rows = await drainChildren(store, joined.fanoutId);
      assert.equal(rows.length, 5);
      for (const row of rows) {
        assert.equal(producers.tables.readFanoutChildRow(row).state, "completed");
      }
      const progress = await readFanoutSchedulerProgress({
        store,
        fanoutId: joined.fanoutId,
        pageLimit: 2,
        producers,
      });
      assert.deepEqual([progress.completed, progress.terminal, progress.attention], [5, true, false]);
      for (const id of ["c1", "c2", "c3", "c4", "c5"]) {
        const domain = await store.load(asModel(MODEL), asId(id));
        assert.ok(domain !== null);
        assert.equal((domain.data as Record<string, unknown>)["count"], 1);
      }
    });

    it("chunk != cohort through the real path (varying bounds, identical sets)", async () => {
      const finals: string[] = [];
      const boundSets: ReadonlyArray<FanoutSchedulerTurnBounds> = [
        { pageLimit: 1, maxDrives: 1 },
        { pageLimit: 3, maxDrives: 2 },
      ];
      for (const [index, bounds] of boundSets.entries()) {
        const { store, reset } = await handles();
        await reset();
        const world = await setupWorld(store);
        await seedDomain(store, MODEL, ["c1", "c2", "c3", "c4"]);
        const source = `occ-chunk-${index}`;
        const joined = await triggerJoin(world, source, { pageLimit: 2, chunkSize: 2 });
        assert.equal(joined.ok, true);
        if (!joined.ok) throw new Error("unreachable");
        await sweepToTerminal(async (cursor) =>
          turnOpts(world, joined.fanoutId, cursor, bounds, countingBody(), {
            freeze: freezeSpec(world, source),
          }),
        );
        const rows = await drainChildren(store, joined.fanoutId);
        finals.push(
          rows
            .map((row) => {
              const d = producers.tables.readFanoutChildRow(row);
              return `${d.recordId}:${d.state}:${d.attempts}`;
            })
            .sort()
            .join("|"),
        );
      }
      assert.equal(finals[0], finals[1]);
      assert.equal(finals[0], "c1:completed:1|c2:completed:1|c3:completed:1|c4:completed:1");
    });
  });
}

function restartSuite(kind: SubstrateKind, label: string): void {
  describe(`T34-F7 fanout real restart (${label})`, () => {
    it("crash mid-sweep resumes to terminal without re-execution", async () => {
      const dir = await mkdtemp(join(tmpdir(), "t34-f7-restart-"));
      try {
        const rt = await openRestartable(kind, dir);
        const source = "occ-restart-1";
        let fanoutId: string;
        {
          const store = await rt.start();
          const world = await setupWorld(store);
          await seedDomain(store, MODEL, ["c1", "c2", "c3"]);
          const joined = await triggerJoin(world, source, { pageLimit: 2, chunkSize: 2 });
          assert.equal(joined.ok, true);
          if (!joined.ok) throw new Error("unreachable");
          fanoutId = joined.fanoutId;
          // One partial turn, then the kill.
          const first = await runFanoutSchedulerTurn(
            turnOpts(world, fanoutId, null, { pageLimit: 2, maxDrives: 1 }, countingBody(), {
              freeze: freezeSpec(world, source),
            }),
          );
          assert.equal(first.status, "turn");
          if (first.status !== "turn") throw new Error("unreachable");
          assert.equal(first.driven.length, 1);
          await rt.kill();
        }
        {
          // Fresh boot over the same persist dir: membership
          // survives, the completed child never re-executes.
          const store = await rt.start();
          const world = await setupWorld(store);
          const intent = await store.load(T34F7_FANOUT_INTENT_MODEL, fanoutId as RecordId);
          assert.ok(intent !== null);
          assert.deepEqual(producers.tables.readFanoutIntentRow(intent).members, ["c1", "c2", "c3"]);
          await sweepToTerminal(async (cursor) =>
            turnOpts(world, fanoutId, cursor, { pageLimit: 2, maxDrives: 2 }, countingBody(), {
              freeze: freezeSpec(world, source),
            }),
          );
          const rows = await drainChildren(store, fanoutId);
          assert.equal(rows.length, 3);
          for (const row of rows) {
            assert.equal(producers.tables.readFanoutChildRow(row).state, "completed");
          }
          for (const id of ["c1", "c2", "c3"]) {
            const domain = await store.load(asModel(MODEL), asId(id));
            assert.ok(domain !== null);
            assert.equal((domain.data as Record<string, unknown>)["count"], 1);
          }
          await rt.kill();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("stale running claim resumes after restart (release + re-drive)", async () => {
      const dir = await mkdtemp(join(tmpdir(), "t34-f7-stale-"));
      try {
        const rt = await openRestartable(kind, dir);
        const source = "occ-restart-2";
        let fanoutId: string;
        {
          const store = await rt.start();
          const world = await setupWorld(store);
          await seedDomain(store, MODEL, ["c1"]);
          const joined = await triggerJoin(world, source);
          assert.equal(joined.ok, true);
          if (!joined.ok) throw new Error("unreachable");
          fanoutId = joined.fanoutId;
          // A claim whose worker died with it: old stamp, never recorded.
          const won = await claimFanoutChild({
            store,
            child: { parentOccurrence: source, handler: HANDLER, recordId: "c1" },
            snapshotVersion: null,
            guard: { predicate: null },
            frozenInputs: null,
            readCurrentSnapshot: () => ({}),
            evaluateGuard: () => true,
            policy: POLICY,
            meta: { nowMs: NOW - MAX_AGE - 1, actor: ACTOR },
            producers,
          });
          assert.equal(won.status, "claimed");
          await rt.kill();
        }
        {
          const store = await rt.start();
          const world = await setupWorld(store);
          const result = await runFanoutSchedulerTurn(
            turnOpts(world, fanoutId, null, { pageLimit: 10, maxDrives: 10 }, countingBody()),
          );
          assert.equal(result.status, "turn");
          if (result.status !== "turn") throw new Error("unreachable");
          assert.equal(result.released.length, 1);
          assert.equal(result.driven.length, 1);
          const only = result.driven[0];
          assert.ok(only !== undefined);
          assert.equal(only.status, "recorded");
          assert.equal(only.detail, "completed");
          const domain = await store.load(asModel(MODEL), asId("c1"));
          assert.ok(domain !== null);
          assert.equal((domain.data as Record<string, unknown>)["count"], 1);
          await rt.kill();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("retry horizon enforces from durable truth across restart", async () => {
      const dir = await mkdtemp(join(tmpdir(), "t34-f7-horizon-"));
      try {
        const rt = await openRestartable(kind, dir);
        const source = "occ-restart-3";
        let fanoutId: string;
        {
          const store = await rt.start();
          const world = await setupWorld(store);
          await seedDomain(store, MODEL, ["c1"]);
          // Backdated admission: the horizon already elapsed at kill time.
          const joined = await triggerJoin(world, source, { pageLimit: 10, chunkSize: 10 }, {
            nowMs: NOW - POLICY.horizonMs - 1,
            actor: ACTOR,
          });
          assert.equal(joined.ok, true);
          if (!joined.ok) throw new Error("unreachable");
          fanoutId = joined.fanoutId;
          await rt.kill();
        }
        {
          const store = await rt.start();
          const world = await setupWorld(store);
          const transient: FanoutSchedulerBodyPort = async () => ({
            writes: [],
            history: [],
            outbox: [],
            schedules: [],
            result: { kind: "transient" },
          });
          const result = await runFanoutSchedulerTurn(
            turnOpts(world, fanoutId, null, { pageLimit: 10, maxDrives: 10 }, transient),
          );
          assert.equal(result.status, "turn");
          if (result.status !== "turn") throw new Error("unreachable");
          assert.equal(result.driven.length, 1);
          const only = result.driven[0];
          assert.ok(only !== undefined);
          assert.equal(only.status, "recorded");
          assert.equal(only.detail, "failed/exhausted");
          const row = await store.load(
            T34F7_FANOUT_CHILD_MODEL,
            producers.tables.fanoutChildRowId(source, HANDLER, "c1") as RecordId,
          );
          assert.ok(row !== null);
          assert.equal(row.created, NOW - POLICY.horizonMs - 1);
          assert.equal(producers.tables.readFanoutChildRow(row).attempts, 1);
          await rt.kill();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
}

durableSuite("miniflare D1", async () => ({
  store: createD1Storage(d1db),
  secondHandle: () => createD1Storage(d1db),
  reset: resetD1,
}));

durableSuite("workerd DO", async () => {
  if (doMf === undefined) throw new Error("do miniflare is not started");
  const mf = doMf;
  return {
    store: doProxy(mf),
    secondHandle: () => doProxy(mf),
    reset: () => resetDO(mf),
  };
});

restartSuite("d1", "miniflare D1");
restartSuite("do", "workerd DO");
