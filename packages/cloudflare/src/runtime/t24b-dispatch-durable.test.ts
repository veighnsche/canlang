/**
 * T24b dispatch execution: durable proofs on REAL substrates.
 *
 * Extends the T24a miniflare-D1 + workerd-DO harness patterns (plus the
 * T17b colocated durable precedent): the worker wiring (composed
 * registry over the join-wrapped store, drives, sweeps) runs against
 * real SQLite substrates with cross-handle read-back. Proves per
 * substrate: execution atomicity with exact revision steps, run-key
 * mismatch voids, exactly-once claims under concurrent delivery,
 * stale-claim sweep resumption, atomic reconcile, stale-fence voiding
 * of execution batches, dead-lettering, and claim-time guard skips.
 * Process-restart survival is explicitly UNCLAIMED (the harness holds
 * ephemeral instances; no persist channel is asserted). Single-owner
 * scope only: cross-store atomicity is NOT claimed and must not be
 * inferred.
 *
 * Work sources load via NON-LITERAL dynamic import (tsc-blind) — see
 * `t24b-dispatch-execution.test.ts` for why a literal fails `tsc -b`.
 *
 * Run from dist FROM THE REPO ROOT: root build, then
 * `node --test packages/cloudflare/dist/runtime/t24b-dispatch-durable.test.js`.
 * (Miniflare mounts worker modules under the CWD, so the CWD must be an
 * ancestor of the state package that owns the DO test worker.)
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import type {
  ModelName,
  OutboxIntent,
  RecordId,
  RecordVersion,
  Revision,
  StoragePort,
} from "@canlang/contracts";
import { createD1Storage, ensureSchema } from "../../../state/dist/state/src/storage/d1.js";
import { FenceConflictError, StorageConstraintError } from "../../../state/dist/state/src/storage/port.js";
import { assembleDispatchCommands } from "../worker/assembly.js";
import {
  createWorkerDispatchJoinPort,
  createWorkerDispatchRegistry,
  driveDispatchIntent,
  loadDispatchSystemProducers,
  readDispatchExecutionRow,
  runRecoverySweep,
  stageDispatchBatch,
  withDispatchJoinPort,
} from "./invoke.js";
import type {
  DispatchEvidenceReader,
  DispatchFailureClassifier,
  DispatchJoinPort,
  DispatchProviderCaller,
  DispatchRecoveryPlanner,
  DispatchStageIntentInput,
  DispatchSystemRegistry,
  DispatchWorkerCommand,
} from "./invoke.js";

const NOW = 1_758_000_000_000;
const ACTOR = "t24b-durable";
const MAX_AGE = 60_000;
const POLICY = { maxAttempts: 3, horizonMs: 3_600_000 };

let runSeq = 0;
let claimSeq = 0;

/* -- Real-producer loading (state dist + work sources; self-contained). -- */

interface WorkProducers {
  readonly WORK_SYSTEM_COMMANDS: ReadonlyArray<DispatchWorkerCommand>;
  readonly WORK_DISPATCH_STAGE_COMMANDS: ReadonlyArray<DispatchWorkerCommand>;
  readonly WORK_DISPATCH_MODEL: string;
  readonly planRecoveryScan: DispatchRecoveryPlanner;
  readonly classifyFailure: DispatchFailureClassifier;
}

function workSpecifier(path: string): string {
  return ["..", "..", "..", "work", "src", path].join("/");
}

let cachedWork: WorkProducers | null = null;

async function loadWorkProducers(): Promise<WorkProducers> {
  if (cachedWork !== null) return cachedWork;
  const commands = await import(workSpecifier("kernel/commands.ts"));
  const tables = await import(workSpecifier("kernel/tables.ts"));
  const recovery = await import(workSpecifier("recovery/index.ts"));
  const receipt = await import(workSpecifier("receipt/index.ts"));
  if (!Array.isArray(commands["WORK_SYSTEM_COMMANDS"])) {
    throw new Error("t24b durable: work commands.ts lacks WORK_SYSTEM_COMMANDS.");
  }
  if (!Array.isArray(commands["WORK_DISPATCH_STAGE_COMMANDS"])) {
    throw new Error("t24b durable: work commands.ts lacks WORK_DISPATCH_STAGE_COMMANDS.");
  }
  cachedWork = {
    WORK_SYSTEM_COMMANDS: commands["WORK_SYSTEM_COMMANDS"],
    WORK_DISPATCH_STAGE_COMMANDS: commands["WORK_DISPATCH_STAGE_COMMANDS"],
    WORK_DISPATCH_MODEL: tables["WORK_DISPATCH_MODEL"],
    planRecoveryScan: recovery["planRecoveryScan"],
    classifyFailure: receipt["classifyFailure"],
  };
  return cachedWork;
}

interface WorkerStack {
  readonly registry: DispatchSystemRegistry;
  readonly joinPort: DispatchJoinPort;
  readonly joined: StoragePort;
  readonly work: WorkProducers;
}

async function workerStack(store: StoragePort): Promise<WorkerStack> {
  const work = await loadWorkProducers();
  const producers = await loadDispatchSystemProducers();
  const composed = assembleDispatchCommands({
    l3Commands: producers.l3Commands,
    workCommands: work.WORK_SYSTEM_COMMANDS,
    stageCommands: work.WORK_DISPATCH_STAGE_COMMANDS,
  });
  const registry = await createWorkerDispatchRegistry(composed);
  const joinPort = await createWorkerDispatchJoinPort(store);
  return { registry, joinPort, joined: withDispatchJoinPort(store, joinPort), work };
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
  new URL("../../../state/test/storage/do-test-worker.js", import.meta.url),
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
    throw new Error("do miniflare is not started");
  }
  const response = await doMf.dispatchFetch(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
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

async function doCall<T>(method: string, ...args: ReadonlyArray<unknown>): Promise<T> {
  const data = await doPost("/call", { method, args });
  if (data["ok"] !== true) {
    throw rehydrate(data["error"] as unknown as WorkerErrorJson);
  }
  return data["value"] as T;
}

function doProxy(): StoragePort {
  return {
    readRevision: () => doCall("readRevision"),
    load: (model: ModelName, id: RecordId) => doCall("load", model, id),
    query: (spec) => doCall("query", spec),
    commit: (batch) => doCall("commit", batch),
    readReceipt: (identity) => doCall("readReceipt", identity),
    outboxPending: () => doCall("outboxPending"),
    scheduleGet: (key) => doCall("scheduleGet", key),
    schedulesDue: (now, limit) => doCall("schedulesDue", now, limit),
    historyFor: (model, recordId) => doCall("historyFor", model, recordId),
    readInstalledSnapshot: (owner) => doCall("readInstalledSnapshot", owner),
    readMigrationProgress: (migrationId) => doCall("readMigrationProgress", migrationId),
    readStagedRows: (migrationId, cursor, limit) =>
      doCall("readStagedRows", migrationId, cursor, limit),
    stageMigrationRows: (input) => doCall("stageMigrationRows", input),
    publishMigrationChunk: (input) => doCall("publishMigrationChunk", input),
    flipInstalledSnapshot: (input) => doCall("flipInstalledSnapshot", input),
    readMigrationOutcomes: (migrationId) => doCall("readMigrationOutcomes", migrationId),
    recordMigrationFailure: (input) => doCall("recordMigrationFailure", input),
    discardStagedRows: (input) => doCall("discardStagedRows", input),
    readMigrationFailure: (migrationId) => doCall("readMigrationFailure", migrationId),
  };
}

async function resetDO(): Promise<void> {
  const data = await doPost("/reset", {});
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

/* -- Wiring helpers (stage/drive/sweep through the worker seam). -- */

function stageInput(over: Partial<DispatchStageIntentInput> = {}): DispatchStageIntentInput {
  return {
    intentId: "obx_d1",
    operation: "Acme.send",
    originOperationId: "op_trigger",
    source: "std.EmailV1.send",
    occurrenceIndex: 0,
    request: { to: "a@example.com" },
    originOccurrence: null,
    guard: null,
    guardVerdict: null,
    ...over,
  };
}

async function pendingIntent(stack: WorkerStack, intentId: string): Promise<OutboxIntent> {
  const intents = await stack.joined.outboxPending();
  const found = intents.find((intent) => intent.intentId === intentId);
  assert.ok(found !== undefined, `expected a pending intent ${intentId}`);
  return found;
}

function driveOpts(
  stack: WorkerStack,
  intent: OutboxIntent,
  provider: DispatchProviderCaller,
  nowMs: () => number = () => NOW,
): Parameters<typeof driveDispatchIntent>[0] {
  claimSeq += 1;
  runSeq += 2;
  return {
    registry: stack.registry,
    store: stack.joined,
    intent,
    actor: ACTOR,
    operation: "test.drive",
    nowMs,
    nextClaimId: () => `claim_${claimSeq}`,
    maxClaimAgeMs: MAX_AGE,
    claimOperationId: `run_claim_${runSeq - 1}`,
    recordOperationId: `run_record_${runSeq}`,
    evaluateGuard: () => true,
    readStateSnapshot: () => null,
    callProvider: provider,
    classifyFailure: stack.work.classifyFailure,
  };
}

const deliveredProvider = (async () => ({
  kind: "delivered",
  result: null,
})) as DispatchProviderCaller;

const transientProvider = (async () => ({
  kind: "failed",
  cause: { kind: "transient", code: "timeout", message: "provider timed out" },
})) as DispatchProviderCaller;

function sweepOpts(
  stack: WorkerStack,
  over: Partial<Parameters<typeof runRecoverySweep>[0]> = {},
): Parameters<typeof runRecoverySweep>[0] {
  return {
    registry: stack.registry,
    store: stack.joined,
    joinPort: stack.joinPort,
    actor: ACTOR,
    operation: "test.sweep",
    nowMs: () => NOW,
    maxClaimAgeMs: MAX_AGE,
    policy: { ...POLICY },
    limit: 10,
    operationIdForStep: (step, intentId) => {
      runSeq += 1;
      return intentId === undefined ? `run_${step}_${runSeq}` : `run_${step}_${intentId}_${runSeq}`;
    },
    planRecoveryScan: stack.work.planRecoveryScan,
    readEvidence: (() => null) as DispatchEvidenceReader,
    ...over,
  };
}

async function captureFailure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected failure, got success.");
}

function durableSuite(
  name: string,
  handles: () => Promise<{
    store: StoragePort;
    secondHandle: () => StoragePort;
    reset: () => Promise<void>;
  }>,
): void {
  describe(`T24b dispatch execution durable (${name})`, () => {
    it("commits stage -> claim -> record in exact fence steps with cross-handle read-back", async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const stack = await workerStack(store);
      runSeq += 1;
      const staged = await stageDispatchBatch({
        registry: stack.registry,
        store: stack.joined,
        actor: ACTOR,
        now: NOW,
        operation: "test.join",
        runKey: "run_d_join",
        intents: [stageInput({ intentId: "obx_exec" })],
      });
      assert.equal(staged.revision, 1);
      const outcome = await driveDispatchIntent(
        driveOpts(stack, await pendingIntent(stack, "obx_exec"), deliveredProvider),
      );
      assert.equal(outcome.status, "recorded");
      assert.equal(await store.readRevision(), 3);
      const peer = secondHandle();
      const row = await peer.load(
        stack.work.WORK_DISPATCH_MODEL as ModelName,
        "obx_exec" as RecordId,
      );
      assert.ok(row !== null);
      const data = readDispatchExecutionRow(row);
      assert.equal(data.state, "delivered");
      assert.equal(data.attempts, 1);
      assert.equal(data.firstAttemptAtMs, NOW);
      assert.deepEqual(await peer.outboxPending(), []);
    });

    it("voids the join when the run key mismatches (nothing durable)", async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const stack = await workerStack(store);
      const failure = await captureFailure(
        stack.registry.run(
          "work.dispatch.stage",
          { operationId: "run_wrong", intents: [stageInput({ intentId: "obx_void" })] },
          { actor: ACTOR, now: NOW, operation: "test.join", operationId: "run_d_void" },
          { store: stack.joined },
        ),
      );
      assert.match(failure.message, /belong to the invoking operation/);
      assert.equal(await store.readRevision(), 0);
      const peer = secondHandle();
      assert.equal(
        await peer.load(stack.work.WORK_DISPATCH_MODEL as ModelName, "obx_void" as RecordId),
        null,
      );
      assert.deepEqual(await peer.outboxPending(), []);
    });

    it("grants exactly one winner under concurrent claims", async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const stack = await workerStack(store);
      await stageDispatchBatch({
        registry: stack.registry,
        store: stack.joined,
        actor: ACTOR,
        now: NOW,
        operation: "test.join",
        runKey: "run_d_race_0",
        intents: [stageInput({ intentId: "obx_race" })],
      });
      const claim = (claimId: string, runKey: string) =>
        stack.registry.run(
          "work.dispatch.claim",
          { intentId: "obx_race", claimId, claimedAtMs: NOW, maxClaimAgeMs: MAX_AGE },
          { actor: ACTOR, now: NOW, operation: "test.race", operationId: runKey },
          { store: stack.joined },
        );
      const raced = await Promise.allSettled([
        claim("claim_A", "run_d_race_A"),
        claim("claim_B", "run_d_race_B"),
      ]);
      const winners = raced.filter(
        (outcome) =>
          outcome.status === "fulfilled" &&
          (outcome.value.result as { claimed: boolean }).claimed === true,
      );
      assert.equal(winners.length, 1);
      // Substrate timing decides the loser shape: fenced out at the
      // revision fence (busy) or at the row-version pre-check
      // (`conflict`: the SQL adapters validate versions before the
      // fence INSERT), or staged after the win (claimed:false) —
      // never half-claimed either way.
      const nonWinners = raced.filter(
        (outcome) =>
          !(
            outcome.status === "fulfilled" &&
            (outcome.value.result as { claimed: boolean }).claimed === true
          ),
      );
      assert.equal(nonWinners.length, 1);
      const loser = nonWinners[0] as
        | PromiseFulfilledResult<{ result: unknown }>
        | PromiseRejectedResult;
      if (loser.status === "rejected") {
        assert.match(
          String((loser.reason as Error)?.message ?? loser.reason),
          /contention|busy|stale record version|version mismatch/i,
        );
      } else {
        assert.equal((loser.value.result as { claimed: boolean }).claimed, false);
      }
      const peer = secondHandle();
      const row = await peer.load(
        stack.work.WORK_DISPATCH_MODEL as ModelName,
        "obx_race" as RecordId,
      );
      assert.ok(row !== null);
      const data = readDispatchExecutionRow(row);
      assert.equal(data.state, "claimed");
      assert.ok(data.claimId === "claim_A" || data.claimId === "claim_B");
    });

    it("resumes an interrupted claim through sweep release plus reclaim", async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const stack = await workerStack(store);
      await stageDispatchBatch({
        registry: stack.registry,
        store: stack.joined,
        actor: ACTOR,
        now: NOW,
        operation: "test.join",
        runKey: "run_d_rec_0",
        intents: [stageInput({ intentId: "obx_rec" })],
      });
      runSeq += 1;
      await stack.registry.run(
        "work.dispatch.claim",
        { intentId: "obx_rec", claimId: "claim_old", claimedAtMs: NOW, maxClaimAgeMs: MAX_AGE },
        { actor: ACTOR, now: NOW, operation: "test.claim", operationId: `run_d_c_${runSeq}` },
        { store: stack.joined },
      );
      const sweep = await runRecoverySweep(sweepOpts(stack, { nowMs: () => NOW + MAX_AGE + 1 }));
      assert.deepEqual(sweep.released, ["obx_rec"]);
      const reclaimed = await driveDispatchIntent(
        driveOpts(
          stack,
          await pendingIntent(stack, "obx_rec"),
          deliveredProvider,
          () => NOW + MAX_AGE + 1,
        ),
      );
      assert.equal(reclaimed.status, "recorded");
      const peer = secondHandle();
      const row = await peer.load(
        stack.work.WORK_DISPATCH_MODEL as ModelName,
        "obx_rec" as RecordId,
      );
      assert.ok(row !== null);
      assert.equal(readDispatchExecutionRow(row).state, "delivered");
    });

    it("reconciles decisive evidence atomically (update + ack, one revision)", async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const stack = await workerStack(store);
      await stageDispatchBatch({
        registry: stack.registry,
        store: stack.joined,
        actor: ACTOR,
        now: NOW,
        operation: "test.join",
        runKey: "run_d_con_0",
        intents: [stageInput({ intentId: "obx_con" })],
      });
      const uncertain = await driveDispatchIntent(
        driveOpts(
          stack,
          await pendingIntent(stack, "obx_con"),
          (async () => ({ kind: "uncertain" })) as DispatchProviderCaller,
        ),
      );
      assert.equal(uncertain.status, "recorded");
      const revisionBefore = await store.readRevision();
      const sweep = await runRecoverySweep(
        sweepOpts(stack, {
          readEvidence: ((id: string) =>
            id === "obx_con" ? { kind: "delivered", result: "mail_9" } : null) as DispatchEvidenceReader,
        }),
      );
      assert.deepEqual(sweep.reconciled, [{ intentId: "obx_con", state: "delivered" }]);
      // Recover commits once even with nothing to release; the
      // reconcile commits update + ack atomically right after.
      assert.equal(await store.readRevision(), (revisionBefore as number) + 2);
      const peer = secondHandle();
      const row = await peer.load(
        stack.work.WORK_DISPATCH_MODEL as ModelName,
        "obx_con" as RecordId,
      );
      assert.ok(row !== null);
      const data = readDispatchExecutionRow(row);
      assert.equal(data.state, "delivered");
      assert.equal(data.attempts, 1);
      assert.deepEqual(await peer.outboxPending(), []);
    });

    it("voids an execution batch on an intervening change (stale fence)", async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const stack = await workerStack(store);
      await stageDispatchBatch({
        registry: stack.registry,
        store: stack.joined,
        actor: ACTOR,
        now: NOW,
        operation: "test.join",
        runKey: "run_d_fence_0",
        intents: [stageInput({ intentId: "obx_fence" })],
      });
      const uncertain = await driveDispatchIntent(
        driveOpts(
          stack,
          await pendingIntent(stack, "obx_fence"),
          (async () => ({ kind: "uncertain" })) as DispatchProviderCaller,
        ),
      );
      assert.equal(uncertain.status, "recorded");
      // Build the reconcile-shaped batch (update + ack) against the
      // current fence, then move the fence through a second handle.
      const row = await store.load(
        stack.work.WORK_DISPATCH_MODEL as ModelName,
        "obx_fence" as RecordId,
      );
      assert.ok(row !== null);
      const data = readDispatchExecutionRow(row);
      const fence = await store.readRevision();
      const peer = secondHandle();
      await peer.commit({
        expectedRevision: fence,
        writes: [],
        history: [],
        receipt: null,
        outbox: [],
        schedules: [],
        uniqueClaims: [],
        uniqueReleases: [],
      });
      const failure = await captureFailure(
        stack.joinPort.commitJoin({
          expectedRevision: fence,
          writes: [
            {
              kind: "update",
              model: stack.work.WORK_DISPATCH_MODEL as ModelName,
              id: row.id,
              expectedVersion: row.version,
              row: {
                ...row,
                version: ((row.version as number) + 1) as RecordVersion,
                updated: NOW,
                updatedBy: ACTOR,
                data: { ...data, state: "delivered" },
              },
            },
          ],
          history: [],
          receipt: null,
          outbox: [],
          schedules: [],
          uniqueClaims: [],
          uniqueReleases: [],
          outboxAck: ["obx_fence"],
        }),
      );
      assert.match(failure.message, /contention|busy/i);
      assert.equal(failure.name, "StateError");
      assert.equal(await store.readRevision(), (fence as number) + 1);
      // The voided batch left NO trace: row still uncertain, intent
      // still pending (cross-handle).
      const held = await peer.load(
        stack.work.WORK_DISPATCH_MODEL as ModelName,
        "obx_fence" as RecordId,
      );
      assert.ok(held !== null);
      assert.equal(readDispatchExecutionRow(held).state, "uncertain");
      assert.deepEqual(
        (await peer.outboxPending()).map((intent) => intent.intentId),
        ["obx_fence"],
      );
    });

    it("dead-letters exhausted failures with cross-handle read-back", async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const stack = await workerStack(store);
      await stageDispatchBatch({
        registry: stack.registry,
        store: stack.joined,
        actor: ACTOR,
        now: NOW,
        operation: "test.join",
        runKey: "run_d_dead_0",
        intents: [stageInput({ intentId: "obx_dead" })],
      });
      const intent = await pendingIntent(stack, "obx_dead");
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const outcome = await driveDispatchIntent(
          driveOpts(stack, intent, transientProvider),
        );
        assert.equal(outcome.status, "recorded");
        if (attempt < 2) {
          runSeq += 1;
          await stack.registry.run(
            "work.dispatch.requeue",
            { intentId: "obx_dead", maxAttempts: 3, horizonMs: 3_600_000 },
            { actor: ACTOR, now: NOW, operation: "test.seed", operationId: `run_d_seed_${runSeq}` },
            { store: stack.joined },
          );
        }
      }
      const sweep = await runRecoverySweep(sweepOpts(stack));
      assert.deepEqual(sweep.deadLettered, [{ intentId: "obx_dead", requeued: false, dead: true }]);
      const peer = secondHandle();
      const row = await peer.load(
        stack.work.WORK_DISPATCH_MODEL as ModelName,
        "obx_dead" as RecordId,
      );
      assert.ok(row !== null);
      assert.equal(readDispatchExecutionRow(row).state, "dead");
    });

    it("skips on claim-time guard-false with cross-handle read-back", async () => {
      const { store, secondHandle, reset } = await handles();
      await reset();
      const stack = await workerStack(store);
      await stageDispatchBatch({
        registry: stack.registry,
        store: stack.joined,
        actor: ACTOR,
        now: NOW,
        operation: "test.join",
        runKey: "run_d_guard_0",
        intents: [stageInput({ intentId: "obx_guard", guard: "eligible()", guardVerdict: true })],
      });
      const intent = await pendingIntent(stack, "obx_guard");
      assert.equal(intent.dispatchGuard, "eligible()");
      const skipped = await driveDispatchIntent({
        ...driveOpts(stack, intent, deliveredProvider),
        evaluateGuard: () => false,
        readStateSnapshot: () => ({ eligible: false }),
      });
      assert.equal(skipped.status, "skipped");
      const peer = secondHandle();
      const row = await peer.load(
        stack.work.WORK_DISPATCH_MODEL as ModelName,
        "obx_guard" as RecordId,
      );
      assert.ok(row !== null);
      const data = readDispatchExecutionRow(row);
      assert.equal(data.state, "pending");
      assert.equal(data.guardVerdict, false);
      assert.equal(data.attempts, 0);
      assert.deepEqual(await peer.outboxPending(), []);
    });
  });
}

durableSuite("miniflare D1", async () => ({
  store: createD1Storage(d1db),
  secondHandle: () => createD1Storage(d1db),
  reset: resetD1,
}));

durableSuite("workerd DO", async () => ({
  store: doProxy(),
  secondHandle: () => doProxy(),
  reset: resetDO,
}));
