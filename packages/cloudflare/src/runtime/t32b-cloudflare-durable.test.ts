/**
 * T32b cloudflare integration: durable proofs on REAL substrates.
 *
 * The fenced serving paths (scenario guards/revision/rejected-site +
 * CRUD inheritance + fenced dispatch drives with REAL `attemptDispatch`
 * verdicts) run against real miniflare-D1 and real workerd-DO SQLite
 * with cross-handle read-back. Only the membership reader stays a
 * memory double (the durable claim covers the state store, not
 * identity — same scope as the T17b/T24b durable suites).
 *
 * Process-restart survival is explicitly UNCLAIMED (the harness holds
 * ephemeral instances; no persist channel is asserted). Single-owner
 * scope only: cross-store atomicity is NOT claimed.
 *
 * Work sources load via NON-LITERAL dynamic import (tsc-blind) — see
 * `t24b-dispatch-execution.test.ts` for why a literal fails `tsc -b`.
 *
 * Run from dist FROM THE REPO ROOT: root build, then
 * `node --test packages/cloudflare/dist/runtime/t32b-cloudflare-durable.test.js`.
 * (Miniflare mounts worker modules under the CWD, so the CWD must be an
 * ancestor of the state package that owns the DO test worker.)
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import type {
  CompileArtifact,
  ModelName,
  MutationResult,
  OperationId,
  OperationName,
  RecordId,
  ResolvedIdentity,
  Revision,
  StoragePort,
  StoredRow,
  OutboxIntent,
} from "@canlang/contracts";
import { resolveIdentity, sha256HexText } from "@canlang/identity";
import { createFrozenClock, createMemoryIdentityStore } from "@canlang/identity/testing";
import { createD1Storage, ensureSchema } from "@canlang/state/storage/d1";
import { FenceConflictError, StorageConstraintError } from "@canlang/state/storage/port";
import { buildInvoker } from "../worker/assembly.js";
import type { AssembledModules } from "../worker/assembly.js";
import { assembleDispatchCommands } from "../worker/assembly.js";
import {
  createWorkerDispatchJoinPort,
  createWorkerDispatchRegistry,
  driveDispatchIntent,
  loadDispatchSystemProducers,
  readDispatchExecutionRow,
  stageDispatchBatch,
  withDispatchJoinPort,
} from "./invoke.js";
import type {
  DispatchFailureClassifier,
  DispatchJoinPort,
  DispatchProviderCaller,
  DispatchStageIntentInput,
  DispatchSystemRegistry,
  DispatchWorkerCommand,
  FenceAttemptDispatchFn,
} from "./invoke.js";

const NOW = 1_758_000_000_000;
const ACTOR = "t32b-durable";
const MAX_AGE = 60_000;

let runSeq = 0;
let claimSeq = 0;

/* ------------------------------------------------------------------ */
/* Compact fixtures (self-contained: no cross-test imports).            */
/* ------------------------------------------------------------------ */

const tempDirs: string[] = [];
async function cleanupTempDirs(): Promise<void> {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function tempDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = mkdtempSync(join(here, "t32b-dfix-"));
  tempDirs.push(dir);
  return dir;
}

function writeModule(dir: string, name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source);
  return pathToFileURL(path).href;
}

function freshOperationId(atMs: number): string {
  const timeHex = atMs.toString(16).padStart(12, "0");
  const rand = randomBytes(10).toString("hex");
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

const DURABLE_MODULE = `import { create, set, records } from "../stdlib.js";
export const hooks = { midway: null };
export const calls = [];
const throwing = () => { throw new Error("t32b-proof: CRUD handler must never run"); };
export function canApp() {
  return {
    calls,
    policy: {
      operations: {
        "acme.Todo.create": { by: ["members"] },
        "acme.Shop.place": { by: ["members"] },
        "acme.Shop.hooked": { by: ["members"] },
        "acme.Shop.boomThrow": { by: ["members"] }
      },
      models: {
        "acme.Todo": { read: ["Todo.read.1"], public: ["Todo.read.1"] }
      }
    },
    Todo: { create: throwing },
    Shop: {
      place: async (c, input) => {
        calls.push("place");
        const row = await create(c, "acme.Todo", { id: input.inputs.key, data: { title: input.inputs.title } });
        const updated = await set(c, "acme.Todo", row.id, { done: true });
        const seen = await records(c, "acme.Todo");
        return { id: updated.id, version: updated.version, count: seen.length };
      },
      hooked: async (c, input) => {
        calls.push("hooked");
        const row = await create(c, "acme.Todo", { id: input.inputs.key, data: { title: input.inputs.title } });
        if (hooks.midway !== null && hooks.midway !== undefined) await hooks.midway();
        const seen = await records(c, "acme.Todo");
        return { id: row.id, seen: seen.length };
      },
      boomThrow: async (c, input) => {
        calls.push("boomThrow");
        await create(c, "acme.Todo", { id: input.inputs.key, data: { title: input.inputs.title } });
        if (hooks.midway !== null && hooks.midway !== undefined) await hooks.midway();
        throw new Error("boom-after-stage");
      }
    }
  };
}
`;

interface FixtureModule {
  readonly hooks: { midway: (() => Promise<void>) | null };
  readonly calls: string[];
}

function strInput(name: string, required: boolean): unknown {
  return { name, field: { kind: "string" }, required };
}

function durableArtifact(module: string): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "t32b-fixture/0 (hand-written T15a shape; NOT compiler output)",
    tool_version: "t32b-fixture/0",
    sources: [{ path: "examples/TeamTasks.can", sha256: "fixture-not-a-digest" }],
    modules: [],
    callables: [
      { id: "acme.Todo.create", kind: "operation", module, export: "Todo_create", member: ["Todo", "create"] },
      { id: "acme.Shop.place", kind: "operation", module, export: "Shop_place", member: ["Shop", "place"] },
      { id: "acme.Shop.hooked", kind: "operation", module, export: "Shop_hooked", member: ["Shop", "hooked"] },
      { id: "acme.Shop.boomThrow", kind: "operation", module, export: "Shop_boomThrow", member: ["Shop", "boomThrow"] },
    ],
    pages: [],
    requires: [
      { capability: "canlang.builtins", min_version: 2 },
      { capability: "state", min_version: 1 },
    ],
    tests: [],
    operations: [
      {
        name: "acme.Todo.create",
        kind: "create",
        description: "",
        inputs: {
          fields: [
            { name: "title", field: { kind: "string" }, required: true },
            { name: "done", field: { kind: "boolean" }, required: false },
          ],
        },
      },
      { name: "acme.Todo.read", kind: "read", description: "", inputs: { fields: [] } },
      {
        name: "acme.Shop.place",
        kind: "scenario",
        description: "",
        inputs: { fields: [strInput("key", true), strInput("title", true)] },
      },
      {
        name: "acme.Shop.hooked",
        kind: "scenario",
        description: "",
        inputs: { fields: [strInput("key", true), strInput("title", true)] },
      },
      {
        name: "acme.Shop.boomThrow",
        kind: "scenario",
        description: "",
        inputs: { fields: [strInput("key", true), strInput("title", true)] },
      },
    ],
    models: [
      {
        name: "acme.Todo",
        fields: [
          { name: "title", required: true, serverOnly: false, field: { kind: "string" } },
          { name: "done", required: false, serverOnly: false, field: { kind: "boolean" } },
        ],
        deleteMode: "remove",
      },
    ],
  } as unknown as CompileArtifact;
}

interface SeededIdentity {
  readonly now: number;
  readonly store: ReturnType<typeof createMemoryIdentityStore>;
  readonly teamId: string;
  readonly memberId: string;
  readonly memberMembershipId: string;
  readonly memberToken: string;
}

async function seedIdentity(): Promise<SeededIdentity> {
  const now = Date.now();
  const clock = createFrozenClock(now);
  const store = createMemoryIdentityStore({ clock });
  const team = await store.createTeam({});
  const member = await store.createUser({
    email: "member@t32b.test",
    password_hash: "x",
    email_verified: true,
  });
  const memberMembership = await store.createMembership({
    team_id: team.team_id,
    user_id: member.user_id,
    is_owner: false,
    roles: [],
  });
  const memberToken = `member-token-${randomBytes(8).toString("hex")}`;
  await store.createSession({
    user_id: member.user_id,
    token_sha256: await sha256HexText(memberToken),
    expires_at: new Date(now + 3600_000).toISOString(),
    last_team_id: team.team_id,
  });
  return { now, store, teamId: team.team_id, memberId: member.user_id, memberMembershipId: memberMembership.membership_id, memberToken };
}

async function modelRows(store: StoragePort, model: string): Promise<StoredRow[]> {
  return [...(await store.query({ model: model as ModelName, authority: "owner" }))];
}

/* ------------------------------------------------------------------ */
/* Substrate handles: real local D1 + real workerd DO SQLite.          */
/* ------------------------------------------------------------------ */

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
    outboxGet: (intentId) => doCall("outboxGet", intentId),
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
  await cleanupTempDirs();
  if (d1mf !== undefined) {
    await d1mf.dispose();
    d1mf = undefined;
  }
  if (doMf !== undefined) {
    await doMf.dispose();
    doMf = undefined;
  }
});

/* ------------------------------------------------------------------ */
/* Dispatch wiring helpers (worker seam over durable stores).          */
/* ------------------------------------------------------------------ */

interface WorkProducers {
  readonly WORK_SYSTEM_COMMANDS: ReadonlyArray<DispatchWorkerCommand>;
  readonly WORK_DISPATCH_STAGE_COMMANDS: ReadonlyArray<DispatchWorkerCommand>;
  readonly WORK_DISPATCH_MODEL: string;
  readonly classifyFailure: DispatchFailureClassifier;
}

function workSpecifier(path: string): string {
  return "@canlang/work/" + path.replace(/\.ts$/, "").replace(/\/index$/, "");
}

let cachedWork: WorkProducers | null = null;

async function loadWorkProducers(): Promise<WorkProducers> {
  if (cachedWork !== null) return cachedWork;
  const commands = await import(workSpecifier("kernel/commands.ts"));
  const tables = await import(workSpecifier("kernel/tables.ts"));
  const receipt = await import(workSpecifier("receipt/index.ts"));
  cachedWork = {
    WORK_SYSTEM_COMMANDS: commands["WORK_SYSTEM_COMMANDS"],
    WORK_DISPATCH_STAGE_COMMANDS: commands["WORK_DISPATCH_STAGE_COMMANDS"],
    WORK_DISPATCH_MODEL: tables["WORK_DISPATCH_MODEL"],
    classifyFailure: receipt["classifyFailure"],
  };
  return cachedWork;
}

let cachedAttemptDispatch: FenceAttemptDispatchFn | null = null;

async function loadAttemptDispatch(): Promise<FenceAttemptDispatchFn> {
  if (cachedAttemptDispatch !== null) return cachedAttemptDispatch;
  const mod = await import(workSpecifier("dispatch/index.ts"));
  cachedAttemptDispatch = mod["attemptDispatch"] as FenceAttemptDispatchFn;
  return cachedAttemptDispatch;
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
    callProvider: (async () => ({ kind: "delivered", result: null })) as DispatchProviderCaller,
    classifyFailure: stack.work.classifyFailure,
  };
}

function liveAuthority(seed: SeededIdentity): () => Promise<boolean> {
  return async () => {
    const membership = await seed.store.findMembership(seed.teamId, seed.memberId);
    return membership !== null && membership.status === "active";
  };
}

async function scenarioSetup(): Promise<{
  asm: AssembledModules;
  artifact: CompileArtifact;
  seed: SeededIdentity;
  mod: FixtureModule;
}> {
  const dir = tempDir();
  const url = writeModule(dir, "ops.mjs", DURABLE_MODULE);
  const asm: AssembledModules = { dir, entryUrl: "fixture-entry", moduleUrls: { "ops.mjs": url } };
  const artifact = durableArtifact("ops.mjs");
  const seed = await seedIdentity();
  const mod = (await import(url)) as FixtureModule;
  return { asm, artifact, seed, mod };
}

/* ------------------------------------------------------------------ */
/* D1 durable proofs.                                                  */
/* ------------------------------------------------------------------ */

describe("T32b durable D1 (fenced seam + drives on real SQLite)", () => {
  it("voids a scenario on mid-flight revocation; cross-handle reads see nothing", async () => {
    await resetD1();
    await cleanupTempDirs();
    const store: StoragePort = createD1Storage(d1db);
    const { asm, artifact, seed, mod } = await scenarioSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity: ResolvedIdentity = await resolveIdentity(
      seed.store,
      { session_token: seed.memberToken },
      { clock: { nowMs: () => seed.now } },
    );
    mod.hooks.midway = async () => {
      await seed.store.removeMembership(seed.memberMembershipId);
    };
    const operationId = freshOperationId(seed.now);
    const outcome = await invoker.invokeMutation(
      {
        operation: "acme.Shop.hooked",
        operation_id: operationId as OperationId,
        inputs: { key: "t-d1rev", title: "revoked" },
      },
      identity,
    );
    assert.ok("error" in outcome, "revocation must void the commit");
    assert.equal(outcome.error.code, "forbidden");
    // B7 residual (joint B4xB7 void vocabulary): the members-gated
    // scenario voids through the state-side authority check
    // ("Authority revoked ..."), not the seam's caller.roles guard
    // — mirroring the sibling CRUD pin below.
    assert.match(outcome.error.message, /revoked/);
    // Cross-handle read-back over a FRESH D1 handle.
    const cross: StoragePort = createD1Storage(d1db);
    assert.equal(await cross.readRevision(), 0);
    assert.equal(
      await cross.readReceipt({
        app: "TeamTasks",
        owner: seed.teamId,
        principal: seed.memberId,
        operation: "acme.Shop.hooked" as OperationName,
        operationId: operationId as OperationId,
      }),
      null,
    );
    assert.equal((await modelRows(cross, "acme.Todo")).length, 0);
  });

  it("voids a members-gated CRUD create on commit-time revocation (cross-handle)", async () => {
    await resetD1();
    await cleanupTempDirs();
    const store: StoragePort = createD1Storage(d1db);
    const { asm, artifact, seed } = await scenarioSetup();
    let membershipReads = 0;
    const countingMemberships = {
      findMembership: async (teamId: string, userId: string) => {
        membershipReads += 1;
        if (membershipReads > 1) return null;
        return seed.store.findMembership(teamId, userId);
      },
    };
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: countingMemberships as never,
      now: () => seed.now,
    });
    const identity: ResolvedIdentity = await resolveIdentity(
      seed.store,
      { session_token: seed.memberToken },
      { clock: { nowMs: () => seed.now } },
    );
    const operationId = freshOperationId(seed.now);
    const outcome = await invoker.invokeMutation(
      {
        operation: "acme.Todo.create",
        operation_id: operationId as OperationId,
        inputs: { title: "d1-crud" },
      },
      identity,
    );
    assert.ok("error" in outcome, "revocation must void the CRUD commit");
    assert.equal(outcome.error.code, "forbidden");
    assert.match(outcome.error.message, /revoked/);
    assert.equal(membershipReads, 2);
    const cross: StoragePort = createD1Storage(d1db);
    assert.equal(await cross.readRevision(), 0);
    assert.equal(
      await cross.readReceipt({
        app: "TeamTasks",
        owner: seed.teamId,
        principal: seed.memberId,
        operation: "acme.Todo.create" as OperationName,
        operationId: operationId as OperationId,
      }),
      null,
    );
  });

  it("refuses revoked + inherited dispatches with REAL kernel verdicts (cross-handle)", async () => {
    await resetD1();
    const store: StoragePort = createD1Storage(d1db);
    const stack = await workerStack(store);
    const seed = await seedIdentity();
    const attemptDispatch = await loadAttemptDispatch();
    await stageIntents(stack, [
      stageInput({ intentId: "obx_dr1", occurrenceIndex: 0 }),
      stageInput({ intentId: "obx_di1", occurrenceIndex: 1 }),
    ]);
    let providerCalls = 0;
    const countingProvider = (async () => {
      providerCalls += 1;
      return { kind: "delivered", result: null };
    }) as DispatchProviderCaller;
    // Revoked: the live re-read observes the removal.
    await seed.store.removeMembership(seed.memberMembershipId);
    const revokedRevision = await store.readRevision();
    const revoked = await driveDispatchIntent({
      ...driveDefaults(stack, await pendingIntent(stack, "obx_dr1")),
      callProvider: countingProvider,
      fence: {
        owner: seed.teamId,
        revalidateAuthority: liveAuthority(seed),
        attemptDispatch,
      },
    });
    assert.equal(revoked.status, "refused-revoked");
    if (revoked.status !== "refused-revoked") throw new Error("unreachable");
    assert.deepEqual(revoked.fence, {
      checkpoint: { revision: revokedRevision + 1, owner: seed.teamId },
      triggerRevision: null,
    });
    // Inherited: the trigger point equals the fresh checkpoint.
    const inheritedRevision = await store.readRevision();
    const inherited = await driveDispatchIntent({
      ...driveDefaults(stack, await pendingIntent(stack, "obx_di1")),
      callProvider: countingProvider,
      fence: {
        owner: seed.teamId,
        triggerRevision: { revision: inheritedRevision + 1 },
        revalidateAuthority: () => true,
        attemptDispatch,
      },
    });
    assert.equal(inherited.status, "refused-inherited-scope");
    assert.equal(providerCalls, 0);
    // Cross-handle read-back: both rows claimed with zero attempts,
    // both intents still pending.
    const cross: StoragePort = createD1Storage(d1db);
    const crossStack = await workerStack(cross);
    for (const intentId of ["obx_dr1", "obx_di1"]) {
      const data = readDispatchExecutionRow(await dispatchRow(crossStack, intentId));
      assert.equal(data.state, "claimed");
      assert.equal(data.attempts, 0);
    }
    assert.deepEqual(
      (await cross.outboxPending()).map((intent) => intent.intentId).sort(),
      ["obx_di1", "obx_dr1"],
    );
  });
});

/* ------------------------------------------------------------------ */
/* workerd-DO durable proofs.                                          */
/* ------------------------------------------------------------------ */

describe("T32b durable DO (fenced seam + drives on real DO SQLite)", () => {
  it("retries an intervening commit, then commits (cross-handle)", async () => {
    await resetDO();
    await cleanupTempDirs();
    const store: StoragePort = doProxy();
    const { asm, artifact, seed, mod } = await scenarioSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity: ResolvedIdentity = await resolveIdentity(
      seed.store,
      { session_token: seed.memberToken },
      { clock: { nowMs: () => seed.now } },
    );
    let fired = false;
    mod.hooks.midway = async () => {
      if (fired) return;
      fired = true;
      const inner = await invoker.invokeMutation(
        {
          operation: "acme.Shop.place",
          operation_id: freshOperationId(seed.now) as OperationId,
          inputs: { key: "inner-do", title: "intervening" },
        },
        identity,
      );
      assert.ok("result" in inner, `inner must commit, got ${JSON.stringify(inner)}`);
    };
    const operationId = freshOperationId(seed.now);
    const outcome = await invoker.invokeMutation(
      {
        operation: "acme.Shop.hooked",
        operation_id: operationId as OperationId,
        inputs: { key: "t-door", title: "outer" },
      },
      identity,
    );
    assert.ok("result" in outcome, `want result, got ${JSON.stringify(outcome)}`);
    assert.equal((outcome.result as MutationResult).status, "committed");
    assert.deepEqual(mod.calls, ["hooked", "place", "hooked"]);
    const cross: StoragePort = doProxy();
    assert.equal(await cross.readRevision(), 2);
    const receipt = await cross.readReceipt({
      app: "TeamTasks",
      owner: seed.teamId,
      principal: seed.memberId,
      operation: "acme.Shop.hooked" as OperationName,
      operationId: operationId as OperationId,
    });
    assert.equal(receipt?.outcome.status, "committed");
    assert.equal((await modelRows(cross, "acme.Todo")).length, 2);
  });

  it("records a rejection with the ORIGINAL error when revocation raced the throw (cross-handle)", async () => {
    await resetDO();
    await cleanupTempDirs();
    const store: StoragePort = doProxy();
    const { asm, artifact, seed, mod } = await scenarioSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity: ResolvedIdentity = await resolveIdentity(
      seed.store,
      { session_token: seed.memberToken },
      { clock: { nowMs: () => seed.now } },
    );
    mod.hooks.midway = async () => {
      await seed.store.removeMembership(seed.memberMembershipId);
    };
    const operationId = freshOperationId(seed.now);
    const outcome = await invoker.invokeMutation(
      {
        operation: "acme.Shop.boomThrow",
        operation_id: operationId as OperationId,
        inputs: { key: "t-doboom", title: "doomed" },
      },
      identity,
    );
    assert.ok("error" in outcome, "throwing handler must surface its error");
    assert.equal(outcome.error.code, "rule_failed");
    assert.match(outcome.error.message, /boom-after-stage/);
    const cross: StoragePort = doProxy();
    assert.equal(await cross.readRevision(), 1);
    const receipt = await cross.readReceipt({
      app: "TeamTasks",
      owner: seed.teamId,
      principal: seed.memberId,
      operation: "acme.Shop.boomThrow" as OperationName,
      operationId: operationId as OperationId,
    });
    assert.equal(receipt?.outcome.status, "rejected");
    assert.equal((await modelRows(cross, "acme.Todo")).length, 0);
  });

  it("drives a quiet transitive dispatch through claimed to recorded (cross-handle)", async () => {
    await resetDO();
    const store: StoragePort = doProxy();
    const stack = await workerStack(store);
    const seed = await seedIdentity();
    const attemptDispatch = await loadAttemptDispatch();
    await stageIntents(stack, [stageInput({ intentId: "obx_dq1" })]);
    let providerCalls = 0;
    const outcome = await driveDispatchIntent({
      ...driveDefaults(stack, await pendingIntent(stack, "obx_dq1")),
      callProvider: (async () => {
        providerCalls += 1;
        return { kind: "delivered", result: { accepted: true } };
      }) as DispatchProviderCaller,
      fence: {
        owner: seed.teamId,
        triggerRevision: { revision: 0 },
        revalidateAuthority: liveAuthority(seed),
        attemptDispatch,
      },
    });
    assert.equal(outcome.status, "recorded");
    assert.equal(providerCalls, 1);
    if (outcome.status !== "recorded") throw new Error("unreachable");
    assert.equal(outcome.attempts, 1);
    const cross: StoragePort = doProxy();
    const crossStack = await workerStack(cross);
    const data = readDispatchExecutionRow(await dispatchRow(crossStack, "obx_dq1"));
    assert.equal(data.state, "delivered");
    assert.equal(data.attempts, 1);
    assert.deepEqual(await cross.outboxPending(), []);
  });
});
