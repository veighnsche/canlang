/**
 * T24b dispatch execution (colocated): the worker assembly composes
 * `[...l3Commands, ...WORK_SYSTEM_COMMANDS, ...WORK_DISPATCH_STAGE_COMMANDS]`
 * and drives claim -> claim-time guard re-eval -> provider call ->
 * record-attempt plus recovery sweeps through the composed registry over
 * the dispatch-join port. Real producers throughout: L3 + join port from
 * state dist, work commands + planner + classifier from work sources,
 * memory store. MEMORY-ONLY proofs (no persist channel); the D1/DO
 * durable proofs live in `t24b-dispatch-durable.test.ts`. Process-restart
 * survival is explicitly UNCLAIMED.
 *
 * Work sources load via NON-LITERAL dynamic import (tsc-blind) by
 * necessity: `@canlang/work` has no dist build, and the package build
 * cannot enable `allowImportingTsExtensions` (it emits) — so work
 * `.ts` loads through node type stripping at runtime only. A literal
 * specifier would fail `tsc -b` (ts5097).
 *
 * Run from dist: root build, then
 * `node --test dist/runtime/t24b-dispatch-execution.test.js`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  ModelName,
  OutboxIntent,
  RecordId,
  RecordVersion,
  StoragePort,
  StoredRow,
} from "@canlang/contracts";
import { createTestMemoryStorage } from "../../../state/dist/state/src/storage/memory.js";
import { DISPATCH_JOIN_MODEL } from "../../../state/dist/state/src/ports/transact.js";
import { WORK_DISPATCH_MODEL as EXECUTORS_DISPATCH_MODEL } from "./executors.js";
import { assembleDispatchCommands } from "../worker/assembly.js";
import {
  createWorkerDispatchJoinPort,
  createWorkerDispatchRegistry,
  dispatchExecutionByStateQuery,
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
  DispatchProviderOutcome,
  DispatchReconcileEvidence,
  DispatchRecoveryPlanner,
  DispatchStageIntentInput,
  DispatchSystemRegistry,
  DispatchWorkerCommand,
} from "./invoke.js";

const NOW = 1_758_000_000_000;
const ACTOR = "t24b-test";
const MAX_AGE = 60_000;
const POLICY = { maxAttempts: 3, horizonMs: 3_600_000 };

let runSeq = 0;
let claimSeq = 0;

/* -- Real-producer loading (state dist + work sources). -- */

interface WorkProducers {
  readonly WORK_SYSTEM_COMMANDS: ReadonlyArray<DispatchWorkerCommand>;
  readonly WORK_DISPATCH_STAGE_COMMANDS: ReadonlyArray<DispatchWorkerCommand>;
  readonly WORK_DISPATCH_MODEL: string;
  readonly readDispatchRow: (row: StoredRow) => Record<string, unknown>;
  readonly dispatchByStateQuery: (state: string) => unknown;
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
    throw new Error("t24b test: work commands.ts lacks WORK_SYSTEM_COMMANDS.");
  }
  if (!Array.isArray(commands["WORK_DISPATCH_STAGE_COMMANDS"])) {
    throw new Error("t24b test: work commands.ts lacks WORK_DISPATCH_STAGE_COMMANDS.");
  }
  if (typeof tables["WORK_DISPATCH_MODEL"] !== "string") {
    throw new Error("t24b test: work tables.ts lacks WORK_DISPATCH_MODEL.");
  }
  if (typeof tables["readDispatchRow"] !== "function") {
    throw new Error("t24b test: work tables.ts lacks readDispatchRow.");
  }
  if (typeof tables["dispatchByStateQuery"] !== "function") {
    throw new Error("t24b test: work tables.ts lacks dispatchByStateQuery.");
  }
  if (typeof recovery["planRecoveryScan"] !== "function") {
    throw new Error("t24b test: work recovery/index.ts lacks planRecoveryScan.");
  }
  if (typeof receipt["classifyFailure"] !== "function") {
    throw new Error("t24b test: work receipt/index.ts lacks classifyFailure.");
  }
  cachedWork = {
    WORK_SYSTEM_COMMANDS: commands["WORK_SYSTEM_COMMANDS"],
    WORK_DISPATCH_STAGE_COMMANDS: commands["WORK_DISPATCH_STAGE_COMMANDS"],
    WORK_DISPATCH_MODEL: tables["WORK_DISPATCH_MODEL"],
    readDispatchRow: tables["readDispatchRow"],
    dispatchByStateQuery: tables["dispatchByStateQuery"],
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

function stageInput(over: Partial<DispatchStageIntentInput> = {}): DispatchStageIntentInput {
  return {
    intentId: "obx_1",
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

async function stageIntents(
  stack: WorkerStack,
  intents: ReadonlyArray<DispatchStageIntentInput>,
): Promise<void> {
  runSeq += 1;
  await stageDispatchBatch({
    registry: stack.registry,
    store: stack.joined,
    actor: ACTOR,
    now: NOW,
    operation: "test.stage",
    runKey: `run_stage_${runSeq}`,
    intents,
  });
}

async function pendingIntent(stack: WorkerStack, intentId: string): Promise<OutboxIntent> {
  const intents = await stack.joined.outboxPending();
  const found = intents.find((intent) => intent.intentId === intentId);
  assert.ok(found !== undefined, `expected a pending intent ${intentId}`);
  return found;
}

async function dispatchRow(stack: WorkerStack, intentId: string): Promise<StoredRow> {
  const row = await stack.joined.load(
    stack.work.WORK_DISPATCH_MODEL as ModelName,
    intentId as RecordId,
  );
  assert.ok(row !== null, `expected a dispatch row for ${intentId}`);
  return row;
}

function deliveredOutcome(result: unknown = null): DispatchProviderOutcome {
  return { kind: "delivered", result };
}

describe("t24b worker assembly: dispatch command composition", () => {
  it("composes [...l3, ...work, ...stage] in order with real producers", async () => {
    const work = await loadWorkProducers();
    const producers = await loadDispatchSystemProducers();
    assert.deepEqual(
      producers.l3Commands.map((command) => command.name),
      ["outbox.ack", "schedule.cancel", "schedule.replace"],
    );
    const composed = assembleDispatchCommands({
      l3Commands: producers.l3Commands,
      workCommands: work.WORK_SYSTEM_COMMANDS,
      stageCommands: work.WORK_DISPATCH_STAGE_COMMANDS,
    });
    assert.deepEqual(
      composed.map((command) => command.name),
      [
        "outbox.ack",
        "schedule.cancel",
        "schedule.replace",
        "work.dispatch.claim",
        "work.dispatch.record-attempt",
        "work.dispatch.requeue",
        "work.dispatch.release",
        "work.dispatch.supersede",
        "work.occurrence.put-receipt",
        "work.schedule.put",
        "work.schedule.cancel",
        "work.every.advance-slot",
        "work.dispatch.stage",
        "work.dispatch.recover",
      ],
    );
    assert.equal(composed.length, 14);
    assert.ok(Object.isFrozen(composed));
  });

  it("fails loud on duplicate and empty command names", async () => {
    const work = await loadWorkProducers();
    const producers = await loadDispatchSystemProducers();
    assert.throws(
      () =>
        assembleDispatchCommands({
          l3Commands: producers.l3Commands,
          workCommands: [...work.WORK_SYSTEM_COMMANDS, ...work.WORK_DISPATCH_STAGE_COMMANDS],
          stageCommands: work.WORK_DISPATCH_STAGE_COMMANDS,
        }),
      /duplicate command "work\.dispatch\.stage"/,
    );
    assert.throws(
      () =>
        assembleDispatchCommands({
          l3Commands: [{ name: "" }],
          workCommands: [],
          stageCommands: [],
        }),
      /empty command name/,
    );
  });

  it("pins the dispatch model literal four ways (no drift by restatement)", async () => {
    const work = await loadWorkProducers();
    assert.equal(DISPATCH_JOIN_MODEL, "work.dispatch");
    assert.equal(work.WORK_DISPATCH_MODEL, DISPATCH_JOIN_MODEL);
    assert.equal(EXECUTORS_DISPATCH_MODEL, DISPATCH_JOIN_MODEL);
    // The invoke.ts mirror is private; its query spec carries the literal.
    assert.equal(
      dispatchExecutionByStateQuery("pending").model,
      DISPATCH_JOIN_MODEL,
    );
  });

  it("cross-checks the row reader and state query against the real work producers", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    await stageIntents(stack, [
      stageInput({ intentId: "obx_pin", guard: "eligible()", guardVerdict: true }),
    ]);
    for (const state of ["pending", "claimed", "delivered", "failed", "uncertain", "dead"] as const) {
      assert.deepEqual(
        dispatchExecutionByStateQuery(state),
        stack.work.dispatchByStateQuery(state),
      );
    }
    const row = await dispatchRow(stack, "obx_pin");
    assert.deepEqual(readDispatchExecutionRow(row), stack.work.readDispatchRow(row));
    assert.throws(() => readDispatchExecutionRow({ ...row, data: { ...row.data, state: "flying" } }), /unknown/);
  });
});

describe("t24b worker registry: runs over the join-wrapped store", () => {
  it("refuses unknown commands and runs live L3 commands", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    await assert.rejects(
      stack.registry.run(
        "nope.nope",
        {},
        { actor: ACTOR, now: NOW, operation: "test.nope", operationId: "run_nope" },
        { store: stack.joined },
      ),
      /Unknown system command/,
    );
    // The composed L3 segment is live, not decorative: ack + schedule
    // round-trips run through the worker registry.
    await stageIntents(stack, [stageInput({ intentId: "obx_l3" })]);
    assert.deepEqual(
      (await stack.joined.outboxPending()).map((intent) => intent.intentId),
      ["obx_l3"],
    );
    await stack.registry.run(
      "outbox.ack",
      { intentIds: ["obx_l3"] },
      { actor: ACTOR, now: NOW, operation: "test.ack", operationId: "run_ack" },
      { store: stack.joined },
    );
    assert.deepEqual(await stack.joined.outboxPending(), []);
    await stack.registry.run(
      "schedule.replace",
      { key: "k1", at: NOW, event: "acme.tick", payload: {} },
      { actor: ACTOR, now: NOW, operation: "test.sched", operationId: "run_sched_1" },
      { store: stack.joined },
    );
    assert.equal((await stack.joined.scheduleGet("k1"))?.key, "k1");
    await stack.registry.run(
      "schedule.cancel",
      { keys: ["k1"] },
      { actor: ACTOR, now: NOW, operation: "test.sched", operationId: "run_sched_2" },
      { store: stack.joined },
    );
    assert.equal(await stack.joined.scheduleGet("k1"), null);
  });

  it("commits dispatch rows plus outbox intents in one fence revision", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    runSeq += 1;
    const staged = await stageDispatchBatch({
      registry: stack.registry,
      store: stack.joined,
      actor: ACTOR,
      now: NOW,
      operation: "test.join",
      runKey: "run_join_1",
      intents: [
        stageInput({ intentId: "obx_j1", occurrenceIndex: 0 }),
        stageInput({ intentId: "obx_j2", occurrenceIndex: 1 }),
      ],
    });
    assert.equal(staged.revision, 1);
    assert.equal(await store.readRevision(), 1);
    assert.equal(staged.staged.length, 2);
    assert.deepEqual(staged.skipped, []);
    assert.deepEqual(staged.replayed, []);
    assert.deepEqual(
      (await stack.joined.outboxPending()).map((intent) => intent.intentId).sort(),
      ["obx_j1", "obx_j2"],
    );
    for (const id of ["obx_j1", "obx_j2"]) {
      assert.equal(readDispatchExecutionRow(await dispatchRow(stack, id)).state, "pending");
    }
  });

  it("voids the whole join when the run key mismatches (trigger rollback)", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    // The run-key contract: stage args.operationId MUST equal the run
    // operationId. `stageDispatchBatch` honors it by construction (one
    // key in both places); a direct mismatched run through the worker
    // registry rejects and NOTHING commits — no rows, no intents.
    await assert.rejects(
      stack.registry.run(
        "work.dispatch.stage",
        {
          operationId: "run_wrong",
          intents: [stageInput({ intentId: "obx_void", occurrenceIndex: 0 })],
        },
        { actor: ACTOR, now: NOW, operation: "test.join", operationId: "run_join_2" },
        { store: stack.joined },
      ),
      /belong to the invoking operation/,
    );
    assert.equal(await store.readRevision(), 0);
    assert.equal(
      await stack.joined.load(
        stack.work.WORK_DISPATCH_MODEL as ModelName,
        "obx_void" as RecordId,
      ),
      null,
    );
    assert.deepEqual(await stack.joined.outboxPending(), []);
  });

  it("replays already-staged intents without duplicate rows", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    await stageIntents(stack, [stageInput({ intentId: "obx_rp", occurrenceIndex: 0 })]);
    runSeq += 1;
    const replayed = await stageDispatchBatch({
      registry: stack.registry,
      store: stack.joined,
      actor: ACTOR,
      now: NOW,
      operation: "test.join",
      runKey: "run_join_rp",
      intents: [stageInput({ intentId: "obx_rp", occurrenceIndex: 0 })],
    });
    assert.deepEqual(replayed.replayed, ["obx_rp"]);
    assert.deepEqual(replayed.staged, []);
    const row = await dispatchRow(stack, "obx_rp");
    assert.equal(row.version, 1);
  });

  it("carries fanout lineage through staging without interpreting it", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    runSeq += 1;
    const staged = await stageDispatchBatch({
      registry: stack.registry,
      store: stack.joined,
      actor: ACTOR,
      now: NOW,
      operation: "test.join",
      runKey: "run_join_fo",
      intents: [
        stageInput({
          intentId: "obx_fo",
          fanout: {
            cohortId: "cohort_1",
            parentOccurrence: "occ_parent",
            childIndex: 2,
            checkpointId: null,
          },
        }),
      ],
    });
    assert.equal(staged.staged.length, 1);
    assert.deepEqual((staged.staged[0] as { fanout: unknown }).fanout, {
      cohortId: "cohort_1",
      parentOccurrence: "occ_parent",
      childIndex: 2,
      checkpointId: null,
    });
    // Carried-only: the dispatch row stores no fanout column, and the
    // L3 intent is dispatchable exactly like an unfanned one.
    assert.deepEqual(
      (await stack.joined.outboxPending()).map((intent) => intent.intentId),
      ["obx_fo"],
    );
  });

  it("commits through the asserting join port (broken joins reject)", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    const revision = await store.readRevision();
    // A deliverable dispatch row without its L3 half is a broken join.
    await assert.rejects(
      stack.joinPort.commitJoin({
        expectedRevision: revision,
        writes: [
          {
            kind: "insert",
            model: stack.work.WORK_DISPATCH_MODEL as ModelName,
            row: {
              id: "obx_broken" as RecordId,
              version: 1 as RecordVersion,
              created: NOW,
              updated: NOW,
              createdBy: ACTOR,
              updatedBy: ACTOR,
              archivedAt: null,
              data: { intentId: "obx_broken", guardVerdict: null },
            },
          },
        ],
        history: [],
        receipt: null,
        outbox: [],
        schedules: [],
        uniqueClaims: [],
        uniqueReleases: [],
      }),
      /has no outbox intent/,
    );
    assert.equal(await store.readRevision(), revision);
  });
});

function driveDefaults(
  stack: WorkerStack,
  intent: OutboxIntent,
): Parameters<typeof driveDispatchIntent>[0] {
  claimSeq += 1;
  runSeq += 2;
  return {
    registry: stack.registry,
    store: stack.joined,
    intent,
    actor: ACTOR,
    operation: "test.drive",
    nowMs: () => NOW,
    nextClaimId: () => `claim_${claimSeq}`,
    maxClaimAgeMs: MAX_AGE,
    claimOperationId: `run_claim_${runSeq - 1}`,
    recordOperationId: `run_record_${runSeq}`,
    evaluateGuard: () => true,
    readStateSnapshot: () => null,
    callProvider: (async () => deliveredOutcome()) as DispatchProviderCaller,
    classifyFailure: stack.work.classifyFailure,
  };
}

describe("t24b drive: claim -> guard -> provider -> record", () => {
  it("records delivered attempts with attempts+1 and an acked intent", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    await stageIntents(stack, [stageInput({ intentId: "obx_d1" })]);
    const intent = await pendingIntent(stack, "obx_d1");
    let calls = 0;
    const outcome = await driveDispatchIntent({
      ...driveDefaults(stack, intent),
      callProvider: (async (seen, claim) => {
        calls += 1;
        assert.equal(seen.intentId, "obx_d1");
        assert.equal(claim.outboxId, "obx_d1");
        assert.ok(claim.claimId.length > 0);
        return deliveredOutcome({ accepted: true });
      }) as DispatchProviderCaller,
    });
    assert.equal(outcome.status, "recorded");
    assert.equal(calls, 1);
    if (outcome.status !== "recorded") throw new Error("unreachable");
    assert.equal(outcome.state, "delivered");
    assert.equal(outcome.attempts, 1);
    assert.equal(outcome.retryClass, null);
    assert.deepEqual(outcome.providerOutcome, {
      kind: "delivered",
      result: { accepted: true },
    });
    const data = readDispatchExecutionRow(await dispatchRow(stack, "obx_d1"));
    assert.equal(data.state, "delivered");
    assert.equal(data.attempts, 1);
    assert.equal(data.claimId, null);
    assert.equal(data.firstAttemptAtMs, NOW);
    // The provider result is NOT persisted (no result column) and the
    // delivery association stays store-minted (null here).
    assert.equal(data.deliveryId, null);
    assert.deepEqual(await stack.joined.outboxPending(), []);
    assert.equal(await store.readRevision(), 3);
  });

  it("records transient failures unacked and terminal failures acked", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    await stageIntents(stack, [
      stageInput({ intentId: "obx_ft", occurrenceIndex: 0 }),
      stageInput({ intentId: "obx_fm", occurrenceIndex: 1 }),
      stageInput({ intentId: "obx_fr", occurrenceIndex: 2 }),
    ]);
    const transient = await driveDispatchIntent({
      ...driveDefaults(stack, await pendingIntent(stack, "obx_ft")),
      callProvider: (async () => ({
        kind: "failed",
        cause: { kind: "transient", code: "timeout", message: "provider timed out" },
      })) as DispatchProviderCaller,
    });
    assert.equal(transient.status, "recorded");
    if (transient.status !== "recorded") throw new Error("unreachable");
    assert.equal(transient.state, "failed");
    assert.equal(transient.retryClass, "transient");
    const transientRow = readDispatchExecutionRow(await dispatchRow(stack, "obx_ft"));
    assert.equal(transientRow.retryClass, "transient");
    assert.equal(transientRow.errorCode, "timeout");
    assert.equal(transientRow.errorMessage, "provider timed out");
    const permanent = await driveDispatchIntent({
      ...driveDefaults(stack, await pendingIntent(stack, "obx_fm")),
      callProvider: (async () => ({
        kind: "failed",
        cause: { kind: "permanent", code: "rejected", message: "provider refused" },
      })) as DispatchProviderCaller,
    });
    assert.equal(permanent.status, "recorded");
    if (permanent.status !== "recorded") throw new Error("unreachable");
    assert.equal(permanent.retryClass, "terminal");
    const required = await driveDispatchIntent({
      ...driveDefaults(stack, await pendingIntent(stack, "obx_fr")),
      callProvider: (async () => ({
        kind: "failed",
        cause: { kind: "handler-require-false", require: "owner()" },
      })) as DispatchProviderCaller,
    });
    assert.equal(required.status, "recorded");
    if (required.status !== "recorded") throw new Error("unreachable");
    assert.equal(required.retryClass, "terminal");
    // Closed-error mirror of the engine `closedErrorForCause`.
    const requiredRow = readDispatchExecutionRow(await dispatchRow(stack, "obx_fr"));
    assert.equal(requiredRow.errorCode, "require-false");
    assert.equal(requiredRow.errorMessage, "handler requirement rejected the occurrence");
    // Transient stays for the sweeper; terminal outcomes ack.
    assert.deepEqual(
      (await stack.joined.outboxPending()).map((intent) => intent.intentId),
      ["obx_ft"],
    );
  });

  it("records uncertain for ambiguous outcomes, throws, and incoherent answers", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    await stageIntents(stack, [
      stageInput({ intentId: "obx_u1", occurrenceIndex: 0 }),
      stageInput({ intentId: "obx_u2", occurrenceIndex: 1 }),
      stageInput({ intentId: "obx_u3", occurrenceIndex: 2 }),
    ]);
    const ambiguous = await driveDispatchIntent({
      ...driveDefaults(stack, await pendingIntent(stack, "obx_u1")),
      callProvider: (async () => ({ kind: "uncertain" })) as DispatchProviderCaller,
    });
    assert.equal(ambiguous.status, "recorded");
    if (ambiguous.status !== "recorded") throw new Error("unreachable");
    assert.equal(ambiguous.state, "uncertain");
    assert.equal(ambiguous.providerThrew, undefined);
    const threw = await driveDispatchIntent({
      ...driveDefaults(stack, await pendingIntent(stack, "obx_u2")),
      callProvider: (async () => {
        throw new Error("socket exploded");
      }) as DispatchProviderCaller,
    });
    assert.equal(threw.status, "recorded");
    if (threw.status !== "recorded") throw new Error("unreachable");
    assert.equal(threw.state, "uncertain");
    assert.equal(threw.providerThrew, "socket exploded");
    // Incoherent adapter answers are unknown too (they may have acted).
    const incoherent = await driveDispatchIntent({
      ...driveDefaults(stack, await pendingIntent(stack, "obx_u3")),
      callProvider: (async () => ({ kind: "maybe" })) as unknown as DispatchProviderCaller,
    });
    assert.equal(incoherent.status, "recorded");
    if (incoherent.status !== "recorded") throw new Error("unreachable");
    assert.equal(incoherent.state, "uncertain");
    assert.match(incoherent.providerThrew ?? "", /provider outcome kind/);
    for (const id of ["obx_u1", "obx_u2", "obx_u3"]) {
      const data = readDispatchExecutionRow(await dispatchRow(stack, id));
      assert.equal(data.state, "uncertain");
      assert.equal(data.attempts, 1);
    }
    // Uncertain outcomes never ack (reconcile evidence owns the retry).
    assert.deepEqual(
      (await stack.joined.outboxPending()).map((intent) => intent.intentId).sort(),
      ["obx_u1", "obx_u2", "obx_u3"],
    );
  });

  it("re-evaluates guards at claim time against the current snapshot", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    // Stage-time verdict TRUE (recorded history): the claim-time
    // re-eval below still decides this attempt.
    await stageIntents(stack, [
      stageInput({ intentId: "obx_gf", occurrenceIndex: 0, guard: "eligible()", guardVerdict: true }),
      stageInput({ intentId: "obx_gt", occurrenceIndex: 1, guard: "eligible()", guardVerdict: true }),
    ]);
    const seen: Array<{ predicate: string; inputs: unknown; snapshot: unknown }> = [];
    const evaluator = (predicate: string, frozenInputs: unknown, stateSnapshot: unknown): boolean => {
      seen.push({ predicate, inputs: frozenInputs, snapshot: stateSnapshot });
      return (stateSnapshot as { eligible: boolean }).eligible === true;
    };
    let providerCalls = 0;
    const countingProvider = (async () => {
      providerCalls += 1;
      return deliveredOutcome();
    }) as DispatchProviderCaller;
    // Current snapshot says ineligible: skip recorded, no attempt
    // consumed, provider never called, L3 intent acked.
    const skipped = await driveDispatchIntent({
      ...driveDefaults(stack, await pendingIntent(stack, "obx_gf")),
      evaluateGuard: evaluator,
      readStateSnapshot: () => ({ eligible: false }),
      callProvider: countingProvider,
    });
    assert.equal(skipped.status, "skipped");
    if (skipped.status !== "skipped") throw new Error("unreachable");
    assert.equal(skipped.guard, "eligible()");
    assert.equal(providerCalls, 0);
    const skipRow = readDispatchExecutionRow(await dispatchRow(stack, "obx_gf"));
    assert.equal(skipRow.state, "pending");
    assert.equal(skipRow.guardVerdict, false);
    assert.equal(skipRow.attempts, 0);
    // Current snapshot says eligible: the provider runs.
    const served = await driveDispatchIntent({
      ...driveDefaults(stack, await pendingIntent(stack, "obx_gt")),
      evaluateGuard: evaluator,
      readStateSnapshot: () => ({ eligible: true }),
      callProvider: countingProvider,
    });
    assert.equal(served.status, "recorded");
    assert.equal(providerCalls, 1);
    // The evaluator observed the CURRENT snapshots with the frozen
    // L3 arguments as inputs — never the stage-time snapshot.
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[0], {
      predicate: "eligible()",
      inputs: { to: "a@example.com" },
      snapshot: { eligible: false },
    });
    assert.deepEqual(seen[1], {
      predicate: "eligible()",
      inputs: { to: "a@example.com" },
      snapshot: { eligible: true },
    });
    assert.deepEqual(await stack.joined.outboxPending(), []);
  });

  it("holds the claim (no terminal skip) when the evaluator throws", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    await stageIntents(stack, [
      stageInput({ intentId: "obx_ge", guard: "eligible()", guardVerdict: true }),
    ]);
    const intent = await pendingIntent(stack, "obx_ge");
    await assert.rejects(
      driveDispatchIntent({
        ...driveDefaults(stack, intent),
        evaluateGuard: () => {
          throw new Error("unknown predicate eligible()");
        },
      }),
      /unknown predicate/,
    );
    // The claim is HELD (not skipped, not recorded): stale release
    // owns the retry once the evaluator is fixed.
    const held = readDispatchExecutionRow(await dispatchRow(stack, "obx_ge"));
    assert.equal(held.state, "claimed");
    assert.ok(held.claimId !== null);
    assert.equal(held.attempts, 0);
    assert.deepEqual(
      (await stack.joined.outboxPending()).map((entry) => entry.intentId),
      ["obx_ge"],
    );
  });

  it("refuses superseded, held, settled, and guard-pinned rows without provider calls", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    await stageIntents(stack, [
      stageInput({ intentId: "obx_sup", occurrenceIndex: 0, originOccurrence: "occ_1" }),
      stageInput({ intentId: "obx_held", occurrenceIndex: 1 }),
      stageInput({ intentId: "obx_done", occurrenceIndex: 2 }),
      stageInput({ intentId: "obx_pin0", occurrenceIndex: 3, guard: "eligible()", guardVerdict: false }),
    ]);
    let providerCalls = 0;
    const countingProvider = (async () => {
      providerCalls += 1;
      return deliveredOutcome();
    }) as DispatchProviderCaller;
    const driveNoGuard = (intent: OutboxIntent) =>
      driveDispatchIntent({ ...driveDefaults(stack, intent), callProvider: countingProvider });
    // Superseded refuses before anything else.
    await stack.registry.run(
      "work.dispatch.supersede",
      { originOccurrence: "occ_1" },
      { actor: ACTOR, now: NOW, operation: "test.sup", operationId: "run_sup" },
      { store: stack.joined },
    );
    const superseded = await driveNoGuard(await pendingIntent(stack, "obx_sup"));
    assert.deepEqual(superseded, { status: "not-claimed", intentId: "obx_sup", reason: "superseded" });
    // A fresh claim held elsewhere loses and observes nothing.
    await stack.registry.run(
      "work.dispatch.claim",
      { intentId: "obx_held", claimId: "winner", claimedAtMs: NOW, maxClaimAgeMs: MAX_AGE },
      { actor: ACTOR, now: NOW, operation: "test.claim", operationId: "run_win" },
      { store: stack.joined },
    );
    const held = await driveNoGuard(await pendingIntent(stack, "obx_held"));
    assert.equal(held.status, "not-claimed");
    if (held.status !== "not-claimed") throw new Error("unreachable");
    assert.equal(held.reason, "claimed");
    // Settled rows refuse with `settled` (delivered via a first
    // drive, which acks the intent — re-driving the saved object
    // refuses without touching the provider).
    const doneIntent = await pendingIntent(stack, "obx_done");
    const first = await driveNoGuard(doneIntent);
    assert.equal(first.status, "recorded");
    assert.ok(
      (await stack.joined.outboxPending()).every((entry) => entry.intentId !== "obx_done"),
    );
    const settledAgain = await driveNoGuard(doneIntent);
    assert.deepEqual(settledAgain, {
      status: "not-claimed",
      intentId: "obx_done",
      reason: "settled",
    });
    // Guard-false pins undispatched (staged skip rows carry no intent).
    const pinned = await stack.registry.run(
      "work.dispatch.claim",
      { intentId: "obx_pin0", claimId: "claim_pin", claimedAtMs: NOW, maxClaimAgeMs: MAX_AGE },
      { actor: ACTOR, now: NOW, operation: "test.claim", operationId: "run_pin" },
      { store: stack.joined },
    );
    assert.deepEqual(pinned.result, {
      claimed: false,
      reason: "guard-false",
      intentId: "obx_pin0",
    });
    assert.equal(providerCalls, 1);
  });

  it("grants exactly one winner under concurrent drives (fence voids the loser)", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    await stageIntents(stack, [stageInput({ intentId: "obx_race" })]);
    const intent = await pendingIntent(stack, "obx_race");
    const raced = await Promise.allSettled([
      driveDispatchIntent({
        ...driveDefaults(stack, intent),
        nextClaimId: () => "claim_A",
        claimOperationId: "run_race_A_claim",
        recordOperationId: "run_race_A_record",
      }),
      driveDispatchIntent({
        ...driveDefaults(stack, intent),
        nextClaimId: () => "claim_B",
        claimOperationId: "run_race_B_claim",
        recordOperationId: "run_race_B_record",
      }),
    ]);
    const winners = raced.filter((outcome) => outcome.status === "fulfilled");
    const losers = raced.filter((outcome) => outcome.status === "rejected");
    // Exactly one winner; the loser loses the fence (busy) at claim —
    // the claim fence itself is unchanged by the worker wiring.
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    const winner = winners[0] as PromiseFulfilledResult<{ status: string }>;
    assert.equal(winner.value.status, "recorded");
    const loser = losers[0] as PromiseRejectedResult;
    assert.match(String((loser.reason as Error)?.message ?? loser.reason), /contention|busy/i);
    const data = readDispatchExecutionRow(await dispatchRow(stack, "obx_race"));
    assert.equal(data.state, "delivered");
    assert.equal(data.attempts, 1);
  });
});

function sweepDefaults(stack: WorkerStack): Parameters<typeof runRecoverySweep>[0] {
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
  };
}

const transientProvider = (async () => ({
  kind: "failed",
  cause: { kind: "transient", code: "timeout", message: "provider timed out" },
})) as DispatchProviderCaller;

/** Drive `target` transient failures at `driveNow`, requeueing between attempts. */
async function exhaustAttempts(
  stack: WorkerStack,
  intentId: string,
  target: number,
  driveNow: number = NOW,
): Promise<void> {
  const intent = await pendingIntent(stack, intentId);
  for (let attempt = 0; attempt < target; attempt += 1) {
    const outcome = await driveDispatchIntent({
      ...driveDefaults(stack, intent),
      nowMs: () => driveNow,
      callProvider: transientProvider,
    });
    assert.equal(outcome.status, "recorded");
    if (attempt < target - 1) {
      runSeq += 1;
      await stack.registry.run(
        "work.dispatch.requeue",
        { intentId, maxAttempts: POLICY.maxAttempts, horizonMs: POLICY.horizonMs },
        { actor: ACTOR, now: NOW, operation: "test.seed", operationId: `run_seed_${runSeq}` },
        { store: stack.joined },
      );
    }
  }
}

describe("t24b sweep: recover -> plan -> requeue/reconcile/release", () => {
  it("requeues retryable failures and dead-letters exhausted ones", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    await stageIntents(stack, [
      stageInput({ intentId: "obx_retry", occurrenceIndex: 0 }),
      stageInput({ intentId: "obx_cap", occurrenceIndex: 1 }),
      stageInput({ intentId: "obx_hor", occurrenceIndex: 2 }),
    ]);
    await exhaustAttempts(stack, "obx_retry", 1);
    await exhaustAttempts(stack, "obx_cap", 3);
    // obx_hor fails early: its horizon (1000ms) elapses before the sweep.
    await exhaustAttempts(stack, "obx_hor", 1, NOW - 2000);
    const sweep = await runRecoverySweep({
      ...sweepDefaults(stack),
      policy: { maxAttempts: 3, horizonMs: 1000 },
    });
    assert.deepEqual(
      sweep.retried.map((act) => act.intentId),
      ["obx_retry"],
    );
    assert.deepEqual(sweep.retried[0], {
      intentId: "obx_retry",
      requeued: true,
      dead: false,
    });
    const retriedRow = readDispatchExecutionRow(await dispatchRow(stack, "obx_retry"));
    assert.equal(retriedRow.state, "pending");
    assert.equal(retriedRow.attempts, 1);
    assert.equal(retriedRow.retryClass, null);
    assert.equal(retriedRow.errorCode, null);
    assert.deepEqual(
      sweep.deadLettered.map((act) => act.intentId).sort(),
      ["obx_cap", "obx_hor"],
    );
    for (const act of sweep.deadLettered) {
      assert.equal(act.requeued, false);
      assert.equal(act.dead, true);
    }
    assert.equal(readDispatchExecutionRow(await dispatchRow(stack, "obx_cap")).state, "dead");
    assert.equal(readDispatchExecutionRow(await dispatchRow(stack, "obx_hor")).state, "dead");
    // Engine-faithful: requeue stages no ack, so dead-lettered intents
    // stay pending (operator-visible) — pinned as observed behavior.
    assert.deepEqual(
      (await stack.joined.outboxPending()).map((intent) => intent.intentId).sort(),
      ["obx_cap", "obx_hor", "obx_retry"],
    );
    assert.deepEqual(sweep.awaiting, []);
    assert.deepEqual(sweep.terminal, []);
  });

  it("never re-drives terminal, unclassified, skipped, or settled rows", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    await stageIntents(stack, [
      stageInput({ intentId: "obx_term", occurrenceIndex: 0 }),
      stageInput({ intentId: "obx_skip", occurrenceIndex: 1, guard: "eligible()", guardVerdict: false }),
      stageInput({ intentId: "obx_live", occurrenceIndex: 2 }),
    ]);
    const terminalOutcome = await driveDispatchIntent({
      ...driveDefaults(stack, await pendingIntent(stack, "obx_term")),
      callProvider: (async () => ({
        kind: "failed",
        cause: { kind: "permanent", code: "refused", message: "no" },
      })) as DispatchProviderCaller,
    });
    assert.equal(terminalOutcome.status, "recorded");
    // Legacy unclassified failed row (predates the join): hand-seeded
    // through the PLAIN store — the join port would (correctly) refuse
    // a row-only insert, and legacy rows predate the assertion.
    const legacyRevision = await store.readRevision();
    await store.commit({
      expectedRevision: legacyRevision,
      writes: [
        {
          kind: "insert",
          model: stack.work.WORK_DISPATCH_MODEL as ModelName,
          row: {
            id: "obx_legacy" as RecordId,
            version: 1 as RecordVersion,
            created: NOW,
            updated: NOW,
            createdBy: ACTOR,
            updatedBy: ACTOR,
            archivedAt: null,
            data: {
              intentId: "obx_legacy",
              operationId: "op_trigger",
              source: "std.EmailV1.send",
              occurrenceIndex: 9,
              originOccurrence: null,
              state: "failed",
              attempts: 1,
              claimId: null,
              claimedAtMs: null,
              guardVerdict: null,
              deliveryId: null,
              errorCode: "legacy",
              errorMessage: "legacy row",
              availableAtMs: null,
              firstAttemptAtMs: NOW,
              retryClass: null,
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
    const before = new Map<string, number>();
    for (const id of ["obx_term", "obx_legacy", "obx_skip", "obx_live"]) {
      before.set(id, (await dispatchRow(stack, id)).version as number);
    }
    const sweep = await runRecoverySweep(sweepDefaults(stack));
    assert.deepEqual([...sweep.terminal].sort(), ["obx_legacy", "obx_term"]);
    assert.deepEqual(sweep.skipped, ["obx_skip"]);
    assert.deepEqual(sweep.retried, []);
    assert.deepEqual(sweep.deadLettered, []);
    assert.deepEqual(sweep.reconciled, []);
    // Untouched: versions pinned, and the plain pending row appears in
    // NO list (no recovery action needed).
    for (const id of ["obx_term", "obx_legacy", "obx_skip", "obx_live"]) {
      assert.equal((await dispatchRow(stack, id)).version as number, before.get(id));
    }
    for (const list of [sweep.awaiting, sweep.skipped, sweep.terminal]) {
      assert.ok(!list.includes("obx_live"));
    }
  });

  it("reconciles decisive evidence atomically and awaits the rest", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    await stageIntents(stack, [
      stageInput({ intentId: "obx_nf", occurrenceIndex: 0 }),
      stageInput({ intentId: "obx_rd", occurrenceIndex: 1 }),
      stageInput({ intentId: "obx_rf", occurrenceIndex: 2 }),
      stageInput({ intentId: "obx_aw", occurrenceIndex: 3 }),
    ]);
    const uncertainProvider = (async () => ({ kind: "uncertain" })) as DispatchProviderCaller;
    for (const id of ["obx_nf", "obx_rd", "obx_rf", "obx_aw"]) {
      const outcome = await driveDispatchIntent({
        ...driveDefaults(stack, await pendingIntent(stack, id)),
        callProvider: uncertainProvider,
      });
      assert.equal(outcome.status, "recorded");
    }
    const evidence = new Map([
      ["obx_nf", { kind: "not-found" }],
      ["obx_rd", { kind: "delivered", result: "mail_9" }],
      ["obx_rf", { kind: "failed", code: "bounced", message: "mailbox gone" }],
    ]);
    const revisionBefore = await store.readRevision();
    const sweep = await runRecoverySweep({
      ...sweepDefaults(stack),
      readEvidence: ((id: string) => evidence.get(id) ?? null) as DispatchEvidenceReader,
    });
    // Not-found retries through requeue with the fenced attestation.
    assert.deepEqual(sweep.retried, [{ intentId: "obx_nf", requeued: true, dead: false }]);
    assert.equal(readDispatchExecutionRow(await dispatchRow(stack, "obx_nf")).state, "pending");
    // Decisive evidence reconciles: state flips, attempts UNCHANGED
    // (reconcile is not an attempt), L3 intent acked in the SAME
    // atomic batch.
    assert.deepEqual(
      sweep.reconciled.map((act) => [act.intentId, act.state]).sort(),
      [
        ["obx_rd", "delivered"],
        ["obx_rf", "failed"],
      ],
    );
    const reconciledDelivered = readDispatchExecutionRow(await dispatchRow(stack, "obx_rd"));
    assert.equal(reconciledDelivered.attempts, 1);
    const reconciledFailed = readDispatchExecutionRow(await dispatchRow(stack, "obx_rf"));
    assert.equal(reconciledFailed.attempts, 1);
    assert.equal(reconciledFailed.errorCode, "bounced");
    assert.equal(reconciledFailed.errorMessage, "mailbox gone");
    // Failed evidence carries no classification: unclassified failed
    // rows are terminal per the requeue rule (never resurrected).
    assert.equal(reconciledFailed.retryClass, null);
    // Unknown stays unknown: awaiting rows are untouched.
    assert.deepEqual(sweep.awaiting, ["obx_aw"]);
    assert.equal(readDispatchExecutionRow(await dispatchRow(stack, "obx_aw")).state, "uncertain");
    assert.deepEqual(
      (await stack.joined.outboxPending()).map((intent) => intent.intentId).sort(),
      ["obx_aw", "obx_nf"],
    );
    // One revision per committed act: recover + requeue + 2 reconciles.
    assert.equal(await store.readRevision(), (revisionBefore as number) + 4);
  });

  it("releases stale claims for re-drive and leaves fresh claims held", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    await stageIntents(stack, [
      stageInput({ intentId: "obx_stale", occurrenceIndex: 0 }),
      stageInput({ intentId: "obx_fresh", occurrenceIndex: 1 }),
    ]);
    runSeq += 1;
    await stack.registry.run(
      "work.dispatch.claim",
      { intentId: "obx_stale", claimId: "claim_old", claimedAtMs: NOW, maxClaimAgeMs: MAX_AGE },
      { actor: ACTOR, now: NOW, operation: "test.claim", operationId: `run_c_${runSeq}` },
      { store: stack.joined },
    );
    // The worker dies holding claim_old; a sweep past the stale
    // boundary releases the row, and a fresh drive reclaims it.
    const sweep = await runRecoverySweep({
      ...sweepDefaults(stack),
      nowMs: () => NOW + MAX_AGE,
    });
    assert.deepEqual(sweep.released, ["obx_stale"]);
    assert.deepEqual(sweep.resumed, []);
    assert.equal(readDispatchExecutionRow(await dispatchRow(stack, "obx_stale")).state, "pending");
    const reclaimed = await driveDispatchIntent({
      ...driveDefaults(stack, await pendingIntent(stack, "obx_stale")),
      nowMs: () => NOW + MAX_AGE,
    });
    assert.equal(reclaimed.status, "recorded");
    // A fresh claim (taken at the sweep instant) stays held.
    runSeq += 1;
    await stack.registry.run(
      "work.dispatch.claim",
      {
        intentId: "obx_fresh",
        claimId: "claim_live",
        claimedAtMs: NOW + MAX_AGE,
        maxClaimAgeMs: MAX_AGE,
      },
      { actor: ACTOR, now: NOW + MAX_AGE, operation: "test.claim", operationId: `run_c_${runSeq}` },
      { store: stack.joined },
    );
    const resweep = await runRecoverySweep({
      ...sweepDefaults(stack),
      nowMs: () => NOW + MAX_AGE,
    });
    assert.deepEqual(resweep.released, []);
    assert.deepEqual(resweep.resumed, []);
    const held = readDispatchExecutionRow(await dispatchRow(stack, "obx_fresh"));
    assert.equal(held.state, "claimed");
    assert.equal(held.claimId, "claim_live");
  });

  it("resumes truncated claimed scans across sweeps (recover cursor)", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    await stageIntents(stack, [
      stageInput({ intentId: "obx_s1", occurrenceIndex: 0 }),
      stageInput({ intentId: "obx_s2", occurrenceIndex: 1 }),
    ]);
    for (const id of ["obx_s1", "obx_s2"]) {
      runSeq += 1;
      await stack.registry.run(
        "work.dispatch.claim",
        { intentId: id, claimId: `claim_${id}`, claimedAtMs: NOW, maxClaimAgeMs: MAX_AGE },
        { actor: ACTOR, now: NOW, operation: "test.claim", operationId: `run_c_${runSeq}` },
        { store: stack.joined },
      );
    }
    const first = await runRecoverySweep({
      ...sweepDefaults(stack),
      nowMs: () => NOW + MAX_AGE + 1,
      limit: 1,
    });
    // Recover releases the first stale claim and reports truncation;
    // the planner sees the second stale claim and the sweeper
    // releases it per intent — nothing is silently dropped.
    assert.deepEqual(first.released, ["obx_s1"]);
    assert.equal(first.done, false);
    assert.equal(first.resumeAfter, "obx_s1");
    assert.deepEqual(first.resumed, [{ intentId: "obx_s2", released: true }]);
    const second = await runRecoverySweep({
      ...sweepDefaults(stack),
      nowMs: () => NOW + MAX_AGE + 1,
      limit: 1,
      resumeAfter: first.resumeAfter,
    });
    assert.deepEqual(second.released, []);
    assert.deepEqual(second.resumed, []);
    assert.equal(second.done, true);
    assert.equal(second.resumeAfter, null);
  });

  it("skips requeue and reconcile when evidence moves under the plan", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    await stageIntents(stack, [
      stageInput({ intentId: "obx_mv1", occurrenceIndex: 0 }),
      stageInput({ intentId: "obx_mv2", occurrenceIndex: 1 }),
    ]);
    const uncertainProvider = (async () => ({ kind: "uncertain" })) as DispatchProviderCaller;
    for (const id of ["obx_mv1", "obx_mv2"]) {
      const outcome = await driveDispatchIntent({
        ...driveDefaults(stack, await pendingIntent(stack, id)),
        callProvider: uncertainProvider,
      });
      assert.equal(outcome.status, "recorded");
    }
    // Plan-time answers differ from act-time re-reads: the sweeper
    // reports the race and commits nothing for these rows.
    const script = new Map<string, Array<DispatchReconcileEvidence | null>>([
      ["obx_mv1", [{ kind: "not-found" }, { kind: "delivered", result: "mail_x" }]],
      ["obx_mv2", [{ kind: "delivered", result: "mail_y" }, null]],
    ]);
    const sweep = await runRecoverySweep({
      ...sweepDefaults(stack),
      readEvidence: (id: string) => {
        const answers = script.get(id);
        if (answers === undefined || answers.length === 0) return null;
        return answers.length > 1 ? (answers.shift() ?? null) : (answers[0] ?? null);
      },
    });
    assert.deepEqual(sweep.retried, [
      { intentId: "obx_mv1", requeued: false, dead: false, reason: "evidence-changed" },
    ]);
    assert.deepEqual(sweep.reconciled, []);
    assert.deepEqual(sweep.reconcileSkipped, [
      { intentId: "obx_mv2", reason: "awaiting-evidence" },
    ]);
    for (const id of ["obx_mv1", "obx_mv2"]) {
      assert.equal(readDispatchExecutionRow(await dispatchRow(stack, id)).state, "uncertain");
    }
  });

  it("reports deferred requeues and truncated scans without forcing", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    await stageIntents(stack, [
      stageInput({ intentId: "obx_def", occurrenceIndex: 0 }),
      stageInput({ intentId: "obx_t1", occurrenceIndex: 1 }),
      stageInput({ intentId: "obx_t2", occurrenceIndex: 2 }),
      stageInput({ intentId: "obx_t3", occurrenceIndex: 3 }),
    ]);
    // Deferred row: failed-transient with a future availability,
    // recorded directly (the driver stages no deferrals itself).
    runSeq += 1;
    await stack.registry.run(
      "work.dispatch.claim",
      { intentId: "obx_def", claimId: "claim_def", claimedAtMs: NOW, maxClaimAgeMs: MAX_AGE },
      { actor: ACTOR, now: NOW, operation: "test.seed", operationId: `run_seed_${runSeq}` },
      { store: stack.joined },
    );
    runSeq += 1;
    await stack.registry.run(
      "work.dispatch.record-attempt",
      {
        intentId: "obx_def",
        claimId: "claim_def",
        outcome: {
          state: "failed",
          retryClass: "transient",
          errorCode: "timeout",
          errorMessage: "slow",
          availableAtMs: NOW + 5000,
        },
        ack: false,
      },
      { actor: ACTOR, now: NOW, operation: "test.seed", operationId: `run_seed_${runSeq}` },
      { store: stack.joined },
    );
    await exhaustAttempts(stack, "obx_t1", 1);
    await exhaustAttempts(stack, "obx_t2", 1);
    await exhaustAttempts(stack, "obx_t3", 1);
    const sweep = await runRecoverySweep({ ...sweepDefaults(stack), limit: 2 });
    assert.equal(sweep.truncated.failed, true);
    assert.equal(sweep.truncated.uncertain, false);
    // Only two of the four failed rows fit the bound (id-sorted); the
    // deferred row reports its deferral instead of jumping the backoff.
    assert.deepEqual(sweep.retried, [
      { intentId: "obx_def", requeued: false, dead: false, reason: "deferred" },
      { intentId: "obx_t1", requeued: true, dead: false },
    ]);
  });

  it("fails closed on malformed evidence and planner skew", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    await stageIntents(stack, [stageInput({ intentId: "obx_bad" })]);
    const outcome = await driveDispatchIntent({
      ...driveDefaults(stack, await pendingIntent(stack, "obx_bad")),
      callProvider: (async () => ({ kind: "uncertain" })) as DispatchProviderCaller,
    });
    assert.equal(outcome.status, "recorded");
    await assert.rejects(
      runRecoverySweep({
        ...sweepDefaults(stack),
        readEvidence: (() => ({ kind: "bogus" })) as unknown as DispatchEvidenceReader,
      }),
      /unknown kind/,
    );
    await assert.rejects(
      runRecoverySweep({
        ...sweepDefaults(stack),
        planRecoveryScan: (() => ({ resume: "nope" })) as unknown as typeof stack.work.planRecoveryScan,
      }),
      /recovery plan resume/,
    );
  });
});

