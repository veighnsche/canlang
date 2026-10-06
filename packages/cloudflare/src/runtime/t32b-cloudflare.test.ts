/**
 * T32b cloudflare integration (colocated): the checkpoint fence wired
 * through the REAL serving seam, memory-store proofs.
 *
 * Site (a): `runScenarioSeam`/`stageWrite` attach the seam's
 * guards/readings to `CanonicalExecutionEffects` (flowing into state
 * `ExecutionEffects` and the commit-time revalidation) and forward
 * the checkpoint point as the pipeline `trigger`; CRUD + scenario
 * paths inherit BOTH commit sites (success + rejected-receipt)
 * through `invokeMutationCanonical` -> state invoke. Mid-flight
 * races land through fixture `hooks.midway` callbacks (set test-side
 * on the imported fixture module, so they reach the real store and
 * the real identity store): revocation, role flips, and intervening
 * commits via nested `place` invocations.
 *
 * Site (b): `driveDispatchIntent` with `fence` consults the REAL
 * injected work `attemptDispatch` (dynamic work-source import, T24b
 * precedent — `@canlang/work` has no dist build, so a literal
 * specifier would fail `tsc -b`) with the committed guard ordering
 * (inherited-scope -> supersession -> guard -> revocation -> claim),
 * returning REAL `claimed` / `refused-revoked` /
 * `refused-inherited-scope` verdicts. No doubles for the refused-*
 * proofs (doubles appear ONLY as unreachable-path tripwires).
 *
 * Durable-substrate proofs live in `t32b-cloudflare-durable.test.ts`;
 * restarts are explicitly UNCLAIMED (ephemeral harnesses).
 *
 * Run from dist: root build, then
 * `node --test dist/runtime/t32b-cloudflare.test.js`.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import type {
  CompileArtifact,
  ModelName,
  MutationEnvelope,
  MutationResult,
  OperationId,
  OperationName,
  RecordId,
  ResolvedIdentity,
  StoragePort,
  StoredRow,
  OutboxIntent,
} from "@canlang/contracts";
import { resolveIdentity, sha256HexText } from "@canlang/identity";
import { createFrozenClock, createMemoryIdentityStore } from "@canlang/identity/testing";
import { createTestMemoryStorage } from "../../../state/dist/state/src/storage/memory.js";
import { T18_SHOP_ARTIFACT_JSON } from "../../../state/dist/state/src/mutation/t18-shop.artifact.js";
import { buildInvoker } from "../worker/assembly.js";
import type { AssembledModules } from "../worker/assembly.js";
import { assembleDispatchCommands } from "../worker/assembly.js";
import {
  createWorkerDispatchJoinPort,
  createWorkerDispatchRegistry,
  driveDispatchIntent,
  loadDispatchSystemProducers,
  readDispatchExecutionRow,
  seamTriggerPoint,
  stageDispatchBatch,
  withDispatchJoinPort,
} from "./invoke.js";
import type {
  DispatchFailureClassifier,
  DispatchJoinPort,
  DispatchProviderCaller,
  DispatchProviderOutcome,
  DispatchStageIntentInput,
  DispatchSystemRegistry,
  DispatchWorkerCommand,
  DriveDispatchFenceInput,
  FenceAttemptDispatchFn,
} from "./invoke.js";

/* ------------------------------------------------------------------ */
/* Site (a): trigger-point forwarding units.                           */
/*                                                                     */
/* Canonical descriptors carry no hooks, so no hook body can observe   */
/* the trigger through the real seam — these units pin the derivation  */
/* (`seamTriggerPoint`, used by `stageWrite`) and the pass-through is  */
/* pinned by read of the `stageWrite` call site.                       */
/* ------------------------------------------------------------------ */

describe("T32b seam trigger point (checkpoint -> pipeline trigger)", () => {
  it("derives revision + owner from a checkpointed call, undefined without", () => {
    const base = { context: {}, def: {}, inputs: {} };
    assert.equal(seamTriggerPoint(base as never), undefined);
    assert.deepEqual(
      seamTriggerPoint({ ...base, checkpoint: { revision: 3, owner: "team-1" } } as never),
      { revision: 3, owner: "team-1" },
    );
  });

  it("refuses misshapen checkpoints loud (invoke/dist skew)", () => {
    const base = { context: {}, def: {}, inputs: {} };
    assert.throws(() => seamTriggerPoint({ ...base, checkpoint: "x" } as never), /not a record/);
    assert.throws(
      () => seamTriggerPoint({ ...base, checkpoint: { revision: -1, owner: "t" } } as never),
      /not a valid revision/,
    );
    assert.throws(
      () => seamTriggerPoint({ ...base, checkpoint: { revision: 1, owner: "" } } as never),
      /non-empty string/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Site (a): scenario/CRUD seam fixtures.                              */
/* ------------------------------------------------------------------ */

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = mkdtempSync(join(here, "t32b-fix-"));
  tempDirs.push(dir);
  return dir;
}

function writeModule(dir: string, name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source);
  return pathToFileURL(path).href;
}

/** Fresh canonical UUIDv7 operation_id with the time field at `atMs`. */
function freshOperationId(atMs: number): string {
  const timeHex = atMs.toString(16).padStart(12, "0");
  const rand = randomBytes(10).toString("hex");
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

function stubAsm(dir: string, moduleUrls: Record<string, string>): AssembledModules {
  return { dir, entryUrl: "fixture-entry", moduleUrls };
}

interface SeededIdentity {
  readonly now: number;
  readonly store: ReturnType<typeof createMemoryIdentityStore>;
  readonly teamId: string;
  readonly ownerId: string;
  readonly memberId: string;
  readonly memberMembershipId: string;
  readonly memberToken: string;
}

/** One team: owner + plain member (member holds zero roles). */
async function seedIdentity(): Promise<SeededIdentity> {
  const now = Date.now();
  const clock = createFrozenClock(now);
  const store = createMemoryIdentityStore({ clock });
  const team = await store.createTeam({});
  const owner = await store.createUser({
    email: "owner@t32b.test",
    password_hash: "x",
    email_verified: true,
  });
  await store.createMembership({
    team_id: team.team_id,
    user_id: owner.user_id,
    is_owner: true,
    roles: [],
  });
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
  return {
    now,
    store,
    teamId: team.team_id,
    ownerId: owner.user_id,
    memberId: member.user_id,
    memberMembershipId: memberMembership.membership_id,
    memberToken,
  };
}

async function identityFor(seed: SeededIdentity, token: string): Promise<ResolvedIdentity> {
  return resolveIdentity(
    seed.store,
    { session_token: token },
    { clock: { nowMs: () => seed.now } },
  );
}

function anonymousIdentity(): ResolvedIdentity {
  return {
    actor: null,
    team: null,
    membership: null,
    binding: { kind: "none" },
    admitted_at: new Date(Date.now()).toISOString(),
  };
}

function mutationEnvelope(operation: string, operationId: string, inputs: Record<string, unknown>): MutationEnvelope {
  return { operation, operation_id: operationId as OperationId, inputs };
}

/**
 * Fixture handlers import the COMPILED stdlib relatively (T17b
 * precedent). `hooks.midway` is set TEST-side on the imported module
 * (same module instance the runtime imports by URL) so mid-flight
 * races reach the real store + identity store; `calls` records every
 * handler run for retry counting.
 */
const FENCE_MODULE = `import { create, set, records } from "../stdlib.js";
export const hooks = { midway: null };
export const calls = [];
const throwing = () => { throw new Error("t32b-proof: CRUD handler must never run on the canonical path"); };
export function canApp() {
  return {
    calls,
    policy: {
      operations: { "acme.Todo.create": { by: ["members"] } },
      models: {}
    },
    Todo: { create: throwing },
    Shop: {
      place: async (c, input) => {
        calls.push("place");
        const row = await create(c, "acme.Todo", { id: input.inputs.key, data: { title: input.inputs.title } });
        const updated = await set(c, "acme.Todo", row.id, { done: true });
        const seen = await records(c, "acme.Todo");
        return { id: updated.id, version: updated.version, seen: seen.map((r) => r.data.title) };
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

/** Hand-written T15a-shaped artifact (NOT compiler output). */
function fenceArtifact(module: string): CompileArtifact {
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

async function fenceSetup(): Promise<{
  url: string;
  asm: AssembledModules;
  artifact: CompileArtifact;
  store: StoragePort;
  seed: SeededIdentity;
  mod: FixtureModule;
}> {
  const dir = tempDir();
  const url = writeModule(dir, "ops.mjs", FENCE_MODULE);
  const asm = stubAsm(dir, { "ops.mjs": url });
  const artifact = fenceArtifact("ops.mjs");
  const { store } = createTestMemoryStorage();
  const seed = await seedIdentity();
  const mod = (await import(url)) as FixtureModule;
  return { url, asm, artifact, store, seed, mod };
}

async function modelRows(store: StoragePort, model: string): Promise<StoredRow[]> {
  return [...(await store.query({ model: model as ModelName, authority: "owner" }))];
}

/* ------------------------------------------------------------------ */
/* Site (a): scenario path through the real seam.                      */
/*                                                                     */
/* Scenarios admit `public` at the canonical gate, so the mechanism's  */
/* revocation check skips (by-aware projection) and the SEAM's         */
/* `caller.roles` guard is the membership tripwire — revocation and    */
/* role flips void with `forbidden` naming the guard.                  */
/* ------------------------------------------------------------------ */

describe("T32b scenario seam (guards + readings + revision fence)", () => {
  it("commits the quiet path with guards/readings attached (no bar trip)", async () => {
    const { asm, artifact, store, seed } = await fenceSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const operationId = freshOperationId(seed.now);
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.place", operationId, { key: "t-1", title: "quiet" }),
      identity,
    );
    assert.ok("result" in outcome, `want result, got ${JSON.stringify(outcome)}`);
    const committed = outcome.result as MutationResult;
    assert.equal(committed.status, "committed");
    assert.deepEqual(committed.result, { id: "t-1", version: 2, seen: ["quiet"] });
    assert.equal(await store.readRevision(), 1);
    const receipt = await store.readReceipt({
      app: "TeamTasks",
      owner: seed.teamId,
      principal: seed.memberId,
      operation: "acme.Shop.place" as OperationName,
      operationId: operationId as OperationId,
    });
    assert.ok(receipt !== null, "scenario receipt must be persisted");
    assert.equal(receipt?.outcome.status, "committed");
    assert.equal((await modelRows(store, "acme.Todo")).length, 1);
  });

  it("commits for anonymous callers (no guard attached, nothing to re-read)", async () => {
    const { asm, artifact, store, seed } = await fenceSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.place", freshOperationId(seed.now), { key: "t-anon", title: "open" }),
      anonymousIdentity(),
    );
    assert.ok("result" in outcome, `want result, got ${JSON.stringify(outcome)}`);
    assert.equal((outcome.result as MutationResult).status, "committed");
    assert.equal(await store.readRevision(), 1);
  });

  it("voids with forbidden naming caller.roles on mid-flight revocation; nothing commits", async () => {
    const { asm, artifact, store, seed, mod } = await fenceSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    mod.hooks.midway = async () => {
      await seed.store.removeMembership(seed.memberMembershipId);
    };
    const operationId = freshOperationId(seed.now);
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.hooked", operationId, { key: "t-rev", title: "revoked" }),
      identity,
    );
    assert.ok("error" in outcome, "revocation must void the commit");
    assert.equal(outcome.error.code, "forbidden");
    assert.match(outcome.error.message, /caller\.roles/);
    // Void leaves no trace: no receipt, revision unmoved, no rows.
    assert.equal(await store.readRevision(), 0);
    assert.equal(
      await store.readReceipt({
        app: "TeamTasks",
        owner: seed.teamId,
        principal: seed.memberId,
        operation: "acme.Shop.hooked" as OperationName,
        operationId: operationId as OperationId,
      }),
      null,
    );
    assert.equal((await modelRows(store, "acme.Todo")).length, 0);
    assert.deepEqual(mod.calls, ["hooked"]);
  });

  it("voids with forbidden naming caller.roles on a mid-flight role flip (permission intact)", async () => {
    const { asm, artifact, store, seed, mod } = await fenceSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    mod.hooks.midway = async () => {
      // Still an active member (permission intact) — but the handler
      // branched on the admitted (empty) roles, so the flip voids.
      await seed.store.setMembershipRoles(seed.memberMembershipId, [
        {
          role: "acme.Clerk",
          granted_at: new Date(seed.now).toISOString(),
          granted_by: seed.ownerId as never,
        },
      ]);
    };
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.hooked", freshOperationId(seed.now), { key: "t-flip", title: "flipped" }),
      identity,
    );
    assert.ok("error" in outcome, "role flip must void the commit");
    assert.equal(outcome.error.code, "forbidden");
    assert.match(outcome.error.message, /caller\.roles/);
    assert.equal(await store.readRevision(), 0);
    assert.equal((await modelRows(store, "acme.Todo")).length, 0);
  });

  it("retries an intervening commit, then commits (revision fence through the seam)", async () => {
    const { asm, artifact, store, seed, mod } = await fenceSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    let fired = false;
    mod.hooks.midway = async () => {
      if (fired) return;
      fired = true;
      // A REAL intervening change: a nested scenario op committing
      // between the outer admission and the outer commit.
      const inner = await invoker.invokeMutation(
        mutationEnvelope("acme.Shop.place", freshOperationId(seed.now), { key: "inner-1", title: "intervening" }),
        identity,
      );
      assert.ok("result" in inner, `inner must commit, got ${JSON.stringify(inner)}`);
    };
    const operationId = freshOperationId(seed.now);
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.hooked", operationId, { key: "t-outer", title: "outer" }),
      identity,
    );
    assert.ok("result" in outcome, `want result, got ${JSON.stringify(outcome)}`);
    assert.equal((outcome.result as MutationResult).status, "committed");
    // Outer ran, inner landed, outer re-ran and committed: two revisions.
    assert.deepEqual(mod.calls, ["hooked", "place", "hooked"]);
    assert.equal(await store.readRevision(), 2);
    const receipt = await store.readReceipt({
      app: "TeamTasks",
      owner: seed.teamId,
      principal: seed.memberId,
      operation: "acme.Shop.hooked" as OperationName,
      operationId: operationId as OperationId,
    });
    assert.equal(receipt?.outcome.status, "committed");
    assert.equal((await modelRows(store, "acme.Todo")).length, 2);
  });
});

describe("T32b scenario rejected-receipt site (executor threw + fence raced)", () => {
  it("records the rejection with the ORIGINAL error when revocation raced the throw", async () => {
    const { asm, artifact, store, seed, mod } = await fenceSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    mod.hooks.midway = async () => {
      await seed.store.removeMembership(seed.memberMembershipId);
    };
    const operationId = freshOperationId(seed.now);
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.boomThrow", operationId, { key: "t-boom", title: "doomed" }),
      identity,
    );
    assert.ok("error" in outcome, "throwing handler must surface its error");
    // The ORIGINAL handler error — never the fence's forbidden: the
    // verdict was decided on admitted authority and a rejected
    // receipt carries zero writes.
    assert.equal(outcome.error.code, "rule_failed");
    assert.match(outcome.error.message, /boom-after-stage/);
    const receipt = await store.readReceipt({
      app: "TeamTasks",
      owner: seed.teamId,
      principal: seed.memberId,
      operation: "acme.Shop.boomThrow" as OperationName,
      operationId: operationId as OperationId,
    });
    assert.deepEqual(receipt?.outcome, {
      status: "rejected",
      code: "rule_failed",
      message: outcome.error.message,
    });
    assert.equal(await store.readRevision(), 1);
    assert.equal((await modelRows(store, "acme.Todo")).length, 0);
    assert.deepEqual(mod.calls, ["boomThrow"]);
  });

  it("retries a rejection that raced an intervening commit, then records it", async () => {
    const { asm, artifact, store, seed, mod } = await fenceSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    let fired = false;
    mod.hooks.midway = async () => {
      if (fired) return;
      fired = true;
      const inner = await invoker.invokeMutation(
        mutationEnvelope("acme.Shop.place", freshOperationId(seed.now), { key: "inner-2", title: "intervening" }),
        identity,
      );
      assert.ok("result" in inner, `inner must commit, got ${JSON.stringify(inner)}`);
    };
    const operationId = freshOperationId(seed.now);
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.boomThrow", operationId, { key: "t-boom2", title: "doomed" }),
      identity,
    );
    assert.ok("error" in outcome, "throwing handler must surface its error");
    assert.equal(outcome.error.code, "rule_failed");
    // The moved revision retried the whole pass (handler ran twice),
    // then the rejection recorded at the new revision.
    assert.deepEqual(mod.calls, ["boomThrow", "place", "boomThrow"]);
    assert.equal(await store.readRevision(), 2);
    const receipt = await store.readReceipt({
      app: "TeamTasks",
      owner: seed.teamId,
      principal: seed.memberId,
      operation: "acme.Shop.boomThrow" as OperationName,
      operationId: operationId as OperationId,
    });
    assert.equal(receipt?.outcome.status, "rejected");
    // Only the inner op's row survived; the rejected pass wrote none.
    assert.equal((await modelRows(store, "acme.Todo")).length, 1);
  });
});

/* ------------------------------------------------------------------ */
/* Site (a): CRUD path through the real seam.                          */
/*                                                                     */
/* CRUD executors run no handler code, so mid-flight races land        */
/* through a counting membership reader: admission's read passes       */
/* through, the commit-time re-read observes revocation. The reader    */
/* call count is asserted exactly (admit 1 + revalidate 1 — no other   */
/* invoke-time membership reads exist for `members`-gated CRUD), so a  */
/* miscount fails loud instead of silently testing the wrong race.     */
/*                                                                     */
/* CRUD has no executor-throw input through the real seam (CRUD        */
/* failures are admission-time or commit-time), so the rejected-       */
/* receipt site is pinned via the scenario path above; CRUD inherits   */
/* it structurally through the same state invoke.                      */
/* ------------------------------------------------------------------ */

describe("T32b CRUD path (commit-time revalidation inheritance)", () => {
  it("voids a members-gated create on commit-time revocation; nothing commits", async () => {
    const { asm, artifact, store, seed } = await fenceSetup();
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
    const identity = await identityFor(seed, seed.memberToken);
    const operationId = freshOperationId(seed.now);
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Todo.create", operationId, { title: "counted" }),
      identity,
    );
    assert.ok("error" in outcome, "revocation must void the CRUD commit");
    // The MECHANISM's revocation verdict (not the seam guard — the
    // state executor offers no guards): live authority is gone.
    assert.equal(outcome.error.code, "forbidden");
    assert.match(outcome.error.message, /revoked/);
    assert.equal(membershipReads, 2);
    assert.equal(await store.readRevision(), 0);
    assert.equal(
      await store.readReceipt({
        app: "TeamTasks",
        owner: seed.teamId,
        principal: seed.memberId,
        operation: "acme.Todo.create" as OperationName,
        operationId: operationId as OperationId,
      }),
      null,
    );
    assert.equal((await modelRows(store, "acme.Todo")).length, 0);
  });

  it("commits a members-gated create on the quiet path (control)", async () => {
    const { asm, artifact, store, seed } = await fenceSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const operationId = freshOperationId(seed.now);
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Todo.create", operationId, { title: "quiet-crud" }),
      identity,
    );
    assert.ok("result" in outcome, `want result, got ${JSON.stringify(outcome)}`);
    assert.equal((outcome.result as MutationResult).status, "committed");
    assert.equal(await store.readRevision(), 1);
    assert.equal((await modelRows(store, "acme.Todo")).length, 1);
  });
});

/* ------------------------------------------------------------------ */
/* Site (b): fenced dispatch drives (REAL kernel verdicts).            */
/*                                                                     */
/* Work sources load via NON-LITERAL dynamic import (tsc-blind) — see  */
/* `t24b-dispatch-execution.test.ts` for why a literal fails `tsc -b`. */
/* ------------------------------------------------------------------ */

const NOW = 1_758_000_000_000;
const ACTOR = "t32b-test";
const MAX_AGE = 60_000;

let runSeq = 0;
let claimSeq = 0;

interface WorkProducers {
  readonly WORK_SYSTEM_COMMANDS: ReadonlyArray<DispatchWorkerCommand>;
  readonly WORK_DISPATCH_STAGE_COMMANDS: ReadonlyArray<DispatchWorkerCommand>;
  readonly WORK_DISPATCH_MODEL: string;
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
  const receipt = await import(workSpecifier("receipt/index.ts"));
  if (!Array.isArray(commands["WORK_SYSTEM_COMMANDS"])) {
    throw new Error("t32b test: work commands.ts lacks WORK_SYSTEM_COMMANDS.");
  }
  if (!Array.isArray(commands["WORK_DISPATCH_STAGE_COMMANDS"])) {
    throw new Error("t32b test: work commands.ts lacks WORK_DISPATCH_STAGE_COMMANDS.");
  }
  if (typeof tables["WORK_DISPATCH_MODEL"] !== "string") {
    throw new Error("t32b test: work tables.ts lacks WORK_DISPATCH_MODEL.");
  }
  if (typeof receipt["classifyFailure"] !== "function") {
    throw new Error("t32b test: work receipt/index.ts lacks classifyFailure.");
  }
  cachedWork = {
    WORK_SYSTEM_COMMANDS: commands["WORK_SYSTEM_COMMANDS"],
    WORK_DISPATCH_STAGE_COMMANDS: commands["WORK_DISPATCH_STAGE_COMMANDS"],
    WORK_DISPATCH_MODEL: tables["WORK_DISPATCH_MODEL"],
    classifyFailure: receipt["classifyFailure"],
  };
  return cachedWork;
}

let cachedAttemptDispatch: FenceAttemptDispatchFn | null = null;

/** The REAL work `attemptDispatch` kernel (never a double). */
async function loadAttemptDispatch(): Promise<FenceAttemptDispatchFn> {
  if (cachedAttemptDispatch !== null) return cachedAttemptDispatch;
  const mod = await import(workSpecifier("dispatch/index.ts"));
  const fn: unknown = mod["attemptDispatch"];
  assert.equal(typeof fn, "function", "work dispatch/index.ts must export attemptDispatch");
  cachedAttemptDispatch = fn as FenceAttemptDispatchFn;
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

async function pendingIds(stack: WorkerStack): Promise<string[]> {
  return (await stack.joined.outboxPending()).map((intent) => intent.intentId).sort();
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

/** A LIVE authority re-read over the real identity store (never cached). */
function liveAuthority(seed: SeededIdentity): () => Promise<boolean> {
  return async () => {
    const membership = await seed.store.findMembership(seed.teamId, seed.memberId);
    return membership !== null && membership.status === "active";
  };
}

describe("T32b fenced dispatch drives (real kernel verdicts)", () => {
  it("drives a quiet transitive dispatch through claimed to recorded", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    const seed = await seedIdentity();
    const attemptDispatch = await loadAttemptDispatch();
    await stageIntents(stack, [stageInput({ intentId: "obx_q1" })]);
    const intent = await pendingIntent(stack, "obx_q1");
    let providerCalls = 0;
    const outcome = await driveDispatchIntent({
      ...driveDefaults(stack, intent),
      callProvider: (async () => {
        providerCalls += 1;
        return deliveredOutcome({ accepted: true });
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
    assert.equal(outcome.state, "delivered");
    assert.equal(outcome.attempts, 1);
    const data = readDispatchExecutionRow(await dispatchRow(stack, "obx_q1"));
    assert.equal(data.state, "delivered");
    assert.equal(data.attempts, 1);
    assert.deepEqual(await pendingIds(stack), []);
  });

  it("skips through the kernel with the shared ceremony (guard inside, acked)", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    const seed = await seedIdentity();
    const attemptDispatch = await loadAttemptDispatch();
    await stageIntents(stack, [
      stageInput({ intentId: "obx_g1", guard: "eligible()", guardVerdict: true }),
    ]);
    const intent = await pendingIntent(stack, "obx_g1");
    let providerCalls = 0;
    const outcome = await driveDispatchIntent({
      ...driveDefaults(stack, intent),
      evaluateGuard: () => false,
      readStateSnapshot: () => ({ eligible: false }),
      callProvider: (async () => {
        providerCalls += 1;
        return deliveredOutcome();
      }) as DispatchProviderCaller,
      fence: {
        owner: seed.teamId,
        revalidateAuthority: liveAuthority(seed),
        attemptDispatch,
      },
    });
    assert.equal(outcome.status, "skipped");
    if (outcome.status !== "skipped") throw new Error("unreachable");
    assert.equal(outcome.guard, "eligible()");
    assert.equal(providerCalls, 0);
    const data = readDispatchExecutionRow(await dispatchRow(stack, "obx_g1"));
    assert.equal(data.state, "pending");
    assert.equal(data.guardVerdict, false);
    assert.equal(data.attempts, 0);
    assert.deepEqual(await pendingIds(stack), []);
  });

  it("refuses a revoked authority AFTER the guard passes (live re-read, no call/record/ack)", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    const seed = await seedIdentity();
    const attemptDispatch = await loadAttemptDispatch();
    await stageIntents(stack, [stageInput({ intentId: "obx_r1" })]);
    const intent = await pendingIntent(stack, "obx_r1");
    await seed.store.removeMembership(seed.memberMembershipId);
    const revisionBefore = await store.readRevision();
    let providerCalls = 0;
    const outcome = await driveDispatchIntent({
      ...driveDefaults(stack, intent),
      callProvider: (async () => {
        providerCalls += 1;
        return deliveredOutcome();
      }) as DispatchProviderCaller,
      fence: {
        owner: seed.teamId,
        revalidateAuthority: liveAuthority(seed),
        attemptDispatch,
      },
    });
    assert.equal(outcome.status, "refused-revoked");
    if (outcome.status !== "refused-revoked") throw new Error("unreachable");
    assert.equal(providerCalls, 0);
    // The echo names the FRESH checkpoint (post-claim revision) under
    // the fenced owner; no trigger was named (direct dispatch).
    assert.deepEqual(outcome.fence, {
      checkpoint: { revision: revisionBefore + 1, owner: seed.teamId },
      triggerRevision: null,
    });
    // Nothing recorded, nothing acked, claim still held for re-drive.
    const data = readDispatchExecutionRow(await dispatchRow(stack, "obx_r1"));
    assert.equal(data.state, "claimed");
    assert.equal(data.claimId, outcome.claimId);
    assert.equal(data.attempts, 0);
    assert.deepEqual(await pendingIds(stack), ["obx_r1"]);
    assert.equal(await store.readRevision(), revisionBefore + 1);
  });

  it("observes a revocation landing in the snapshot pull (fence-time liveness, guard ran first)", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    const seed = await seedIdentity();
    const attemptDispatch = await loadAttemptDispatch();
    await stageIntents(stack, [
      stageInput({ intentId: "obx_r2", guard: "eligible()", guardVerdict: true }),
    ]);
    const intent = await pendingIntent(stack, "obx_r2");
    let guardEvals = 0;
    let providerCalls = 0;
    const outcome = await driveDispatchIntent({
      ...driveDefaults(stack, intent),
      evaluateGuard: () => {
        guardEvals += 1;
        return true;
      },
      // Async reader (the drive awaits the pull): the revocation
      // lands AFTER the claim won, INSIDE the snapshot pull — only a
      // fence-time live re-read can observe it.
      readStateSnapshot: async () => {
        await seed.store.removeMembership(seed.memberMembershipId);
        return { eligible: true };
      },
      callProvider: (async () => {
        providerCalls += 1;
        return deliveredOutcome();
      }) as DispatchProviderCaller,
      fence: {
        owner: seed.teamId,
        revalidateAuthority: liveAuthority(seed),
        attemptDispatch,
      },
    });
    assert.equal(outcome.status, "refused-revoked");
    // Committed order: the guard evaluated (and passed) BEFORE the
    // revocation verdict — the verdict never authorizes alone.
    assert.equal(guardEvals, 1);
    assert.equal(providerCalls, 0);
    const data = readDispatchExecutionRow(await dispatchRow(stack, "obx_r2"));
    assert.equal(data.state, "claimed");
    assert.equal(data.attempts, 0);
    assert.deepEqual(await pendingIds(stack), ["obx_r2"]);
  });

  it("refuses an inherited trigger checkpoint (structural bar, self-verifying echo)", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    const seed = await seedIdentity();
    const attemptDispatch = await loadAttemptDispatch();
    await stageIntents(stack, [stageInput({ intentId: "obx_i1" })]);
    const intent = await pendingIntent(stack, "obx_i1");
    const revisionBefore = await store.readRevision();
    let snapshotPulls = 0;
    let providerCalls = 0;
    const outcome = await driveDispatchIntent({
      ...driveDefaults(stack, intent),
      readStateSnapshot: () => {
        snapshotPulls += 1;
        return null;
      },
      callProvider: (async () => {
        providerCalls += 1;
        return deliveredOutcome();
      }) as DispatchProviderCaller,
      fence: {
        owner: seed.teamId,
        // An inheriting caller presenting the CURRENT revision as its
        // trigger point (the claim run commits exactly one batch).
        triggerRevision: { revision: revisionBefore + 1 },
        revalidateAuthority: liveAuthority(seed),
        attemptDispatch,
      },
    });
    assert.equal(outcome.status, "refused-inherited-scope");
    if (outcome.status !== "refused-inherited-scope") throw new Error("unreachable");
    // The echo self-verifies the refusal: fresh checkpoint revision
    // EQUALS the presented trigger revision.
    assert.equal(outcome.fence.checkpoint.revision, revisionBefore + 1);
    assert.deepEqual(outcome.fence.triggerRevision, { revision: revisionBefore + 1 });
    assert.equal(outcome.fence.checkpoint.owner, seed.teamId);
    // Unguarded dispatches skip the snapshot pull (unfenced parity).
    assert.equal(snapshotPulls, 0);
    assert.equal(providerCalls, 0);
    const data = readDispatchExecutionRow(await dispatchRow(stack, "obx_i1"));
    assert.equal(data.state, "claimed");
    assert.equal(data.claimId, outcome.claimId);
    assert.equal(data.attempts, 0);
    assert.deepEqual(await pendingIds(stack), ["obx_i1"]);
  });

  it("refuses inherited-scope BEFORE the guard (committed ordering beats a false guard)", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    const seed = await seedIdentity();
    const attemptDispatch = await loadAttemptDispatch();
    await stageIntents(stack, [
      stageInput({ intentId: "obx_i2", guard: "eligible()", guardVerdict: true }),
    ]);
    const intent = await pendingIntent(stack, "obx_i2");
    const revisionBefore = await store.readRevision();
    let guardEvals = 0;
    let providerCalls = 0;
    const outcome = await driveDispatchIntent({
      ...driveDefaults(stack, intent),
      evaluateGuard: () => {
        guardEvals += 1;
        return false;
      },
      readStateSnapshot: () => ({ eligible: false }),
      callProvider: (async () => {
        providerCalls += 1;
        return deliveredOutcome();
      }) as DispatchProviderCaller,
      fence: {
        owner: seed.teamId,
        triggerRevision: { revision: revisionBefore + 1 },
        revalidateAuthority: liveAuthority(seed),
        attemptDispatch,
      },
    });
    // Inherited-scope precedes the guard: refused, NOT skipped — and
    // the guard NEVER evaluated.
    assert.equal(outcome.status, "refused-inherited-scope");
    assert.equal(guardEvals, 0);
    assert.equal(providerCalls, 0);
    // A skip would ack and pin guardVerdict false; the refusal does
    // neither (the stage-time pin stands as recorded history).
    assert.deepEqual(await pendingIds(stack), ["obx_i2"]);
    const data = readDispatchExecutionRow(await dispatchRow(stack, "obx_i2"));
    assert.equal(data.guardVerdict, true);
    assert.equal(data.attempts, 0);
  });

  it("ignores authority without a fence (exact pre-T32b behavior)", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    const seed = await seedIdentity();
    await stageIntents(stack, [stageInput({ intentId: "obx_u1" })]);
    const intent = await pendingIntent(stack, "obx_u1");
    await seed.store.removeMembership(seed.memberMembershipId);
    let providerCalls = 0;
    const outcome = await driveDispatchIntent({
      ...driveDefaults(stack, intent),
      callProvider: (async () => {
        providerCalls += 1;
        return deliveredOutcome();
      }) as DispatchProviderCaller,
    });
    assert.equal(outcome.status, "recorded");
    assert.equal(providerCalls, 1);
  });

  it("fails loud on unreachable kernel verdicts and malformed fence inputs (tripwires)", async () => {
    const { store } = createTestMemoryStorage();
    const stack = await workerStack(store);
    const seed = await seedIdentity();
    const attemptDispatch = await loadAttemptDispatch();
    await stageIntents(stack, [
      stageInput({ intentId: "obx_t1", occurrenceIndex: 0 }),
      stageInput({ intentId: "obx_t2", occurrenceIndex: 1 }),
      stageInput({ intentId: "obx_t3", occurrenceIndex: 2 }),
      stageInput({ intentId: "obx_t4", occurrenceIndex: 3 }),
    ]);
    // A kernel minting anything but the held claim is producer skew.
    await assert.rejects(
      driveDispatchIntent({
        ...driveDefaults(stack, await pendingIntent(stack, "obx_t1")),
        fence: {
          owner: seed.teamId,
          revalidateAuthority: liveAuthority(seed),
          attemptDispatch: (() => ({
            status: "claimed",
            claim: { outboxId: "obx_t1", claimId: "claim_WRONG", claimedAt: NOW },
          })) as unknown as FenceAttemptDispatchFn,
        },
      }),
      /not the held claim/,
    );
    // Attested-unreachable statuses never drive.
    await assert.rejects(
      driveDispatchIntent({
        ...driveDefaults(stack, await pendingIntent(stack, "obx_t2")),
        fence: {
          owner: seed.teamId,
          revalidateAuthority: liveAuthority(seed),
          attemptDispatch: (() => ({ status: "superseded" })) as unknown as FenceAttemptDispatchFn,
        },
      }),
      /unreachable/,
    );
    // Malformed fence inputs refuse before the kernel runs.
    await assert.rejects(
      driveDispatchIntent({
        ...driveDefaults(stack, await pendingIntent(stack, "obx_t3")),
        fence: {
          owner: "",
          revalidateAuthority: liveAuthority(seed),
          attemptDispatch,
        },
      }),
      /non-empty checkpoint owner/,
    );
    await assert.rejects(
      driveDispatchIntent({
        ...driveDefaults(stack, await pendingIntent(stack, "obx_t4")),
        fence: {
          owner: seed.teamId,
          revalidateAuthority: liveAuthority(seed),
        } as unknown as DriveDispatchFenceInput,
      }),
      /needs revalidateAuthority/,
    );
  });
});

/* ------------------------------------------------------------------ */
/* T32c C2 production joins (T18/read threading through the seam).      */
/*                                                                     */
/* The fence artifact above is hand-written T15a shape; these pins run */
/* the REAL production T18 shop slice (server inits, nullable fields,  */
/* containment, archive deleteMode, serverOnly fields) plus one        */
/* serverOnly-free model and three probe scenarios through the REAL    */
/* serving seam:                                                       */
/*  - site 1+5: serverInits/nullableFields/containment reach the       */
/*    model-table build (nullable fill, server resolution,             */
/*    missing-parent verdict);                                         */
/*  - site 2: gateArchivedTargets on scenario stageWrite;              */
/*  - site 3+4: ConflictServerOnly threading + assembly                */
/*    toBusinessError conflict mirror (bb1ca7a);                       */
/*  - self-cancel netting verdict (B1): create+remove commits (never   */
/*    throws); archive-mode pairs persist an archived stub.            */
/* CRUD ops run the canonical mechanism path (module CRUD exports are  */
/* tripwires, fence precedent); scenario probes use the cloudflare     */
/* stdlib shape (create/set/deleteRecord with explicit model+id).      */
/* ------------------------------------------------------------------ */

const C2_MODULE = `import { create, set, deleteRecord } from "../stdlib.js";
export const hooks = { midway: null };
export const calls = [];
const throwing = () => { throw new Error("t32c-proof: CRUD handler must never run on the canonical path"); };
export function canApp() {
  return {
    calls,
    policy: {
      roles: [],
      models: {
        "Shop.Team": { read: ["Team.read.1"] },
        "Shop.Member": { read: ["Member.read.1"] },
        "acme.Plain": { read: ["Plain.read.1"] },
      },
      operations: {
        "Shop.Team.create": { by: ["members"] },
        "Shop.Team.update": { by: ["members"] },
        "Shop.Team.delete": { by: ["members"] },
        "Shop.Member.create": { by: ["members"] },
        "Shop.Member.update": { by: ["members"] },
        "Shop.Member.delete": { by: ["members"] },
        "acme.Plain.create": { by: ["members"] },
        "acme.Plain.update": { by: ["members"] },
      },
    },
    read: {
      "Team.read.1": (c, row) => true,
      "Member.read.1": (c, row) => true,
      "Plain.read.1": (c, row) => true,
    },
    createTeam: throwing,
    updateTeam: throwing,
    deleteTeam: throwing,
    createMember: throwing,
    updateMember: throwing,
    deleteMember: throwing,
    createPlain: throwing,
    updatePlain: throwing,
    Probe: {
      selfCancel: async (c, input) => {
        calls.push("selfCancel");
        const row = await create(c, "Shop.Team", {
          id: input.inputs.key,
          data: { name: "tmp-" + input.inputs.key, owner: input.inputs.owner, flags: [] },
        });
        await deleteRecord(c, "Shop.Team", row.id);
        return { id: row.id };
      },
      archiveTouch: async (c, input) => {
        calls.push("archiveTouch");
        const row = await set(c, "Shop.Team", input.inputs.id, { name: "touched" });
        return { id: row.id, version: row.version };
      },
      orphanMember: async (c, input) => {
        calls.push("orphanMember");
        const row = await create(c, "Shop.Member", {
          id: input.inputs.key,
          data: { name: "orphan-" + input.inputs.key, buddy: input.inputs.owner },
        });
        return { id: row.id };
      },
      ghostMember: async (c, input) => {
        calls.push("ghostMember");
        const row = await create(c, "Shop.Member", {
          id: input.inputs.key,
          data: { name: "ghost-" + input.inputs.key, buddy: input.inputs.owner },
          parent: { model: "Shop.Team", id: "ghost-" + input.inputs.key },
        });
        return { id: row.id };
      },
    },
  };
}
`;

/**
 * Production T18 shop slice (ops + models verbatim from the REAL
 * compiler artifact JSON) plus a serverOnly-free model (empty
 * exclusion-set proof) and the probe scenarios. Callables point at
 * the C2 fixture module (top-level CRUD tripwires, nested probes).
 */
function c2Artifact(module: string): CompileArtifact {
  const t18 = JSON.parse(T18_SHOP_ARTIFACT_JSON) as CompileArtifact;
  const keepOps = new Set([
    "Shop.Team.create",
    "Shop.Team.update",
    "Shop.Team.delete",
    "Shop.Member.create",
    "Shop.Member.update",
    "Shop.Member.delete",
  ]);
  const t18Operations = t18.operations ?? [];
  assert.ok(t18Operations.length > 0, "T18 slice needs operations");
  const operations = [
    ...t18Operations.filter((op) => keepOps.has(op.name as string)),
    {
      name: "acme.Plain.create",
      kind: "create",
      description: "",
      inputs: { fields: [{ name: "title", field: { kind: "string" }, required: true }] },
    },
    {
      name: "acme.Plain.update",
      kind: "update",
      description: "",
      inputs: {
        fields: [
          {
            name: "record",
            field: { kind: "ref", model: "acme.Plain", requireVersion: true },
            required: true,
          },
          { name: "title", field: { kind: "string" }, required: false },
        ],
      },
    },
    {
      name: "acme.Probe.selfCancel",
      kind: "scenario",
      description: "",
      inputs: { fields: [strInput("key", true), strInput("owner", true)] },
    },
    {
      name: "acme.Probe.archiveTouch",
      kind: "scenario",
      description: "",
      inputs: { fields: [strInput("id", true)] },
    },
    {
      name: "acme.Probe.orphanMember",
      kind: "scenario",
      description: "",
      inputs: { fields: [strInput("key", true), strInput("owner", true)] },
    },
    {
      name: "acme.Probe.ghostMember",
      kind: "scenario",
      description: "",
      inputs: { fields: [strInput("key", true), strInput("owner", true)] },
    },
  ];
  const t18Models = t18.models ?? [];
  assert.ok(t18Models.length > 0, "T18 slice needs models");
  const models = [
    ...t18Models,
    {
      name: "acme.Plain",
      fields: [{ name: "title", field: { kind: "string" }, required: true, serverOnly: false }],
      deleteMode: "remove",
    },
  ];
  const crudTripwire = (id: string, member: string) => ({
    id,
    kind: "operation",
    module,
    export: `C2_${member}`,
    member: [member],
  });
  const callables = [
    crudTripwire("Shop.Team.create", "createTeam"),
    crudTripwire("Shop.Team.update", "updateTeam"),
    crudTripwire("Shop.Team.delete", "deleteTeam"),
    crudTripwire("Shop.Member.create", "createMember"),
    crudTripwire("Shop.Member.update", "updateMember"),
    crudTripwire("Shop.Member.delete", "deleteMember"),
    crudTripwire("acme.Plain.create", "createPlain"),
    crudTripwire("acme.Plain.update", "updatePlain"),
    { id: "acme.Probe.selfCancel", kind: "operation", module, export: "Probe_selfCancel", member: ["Probe", "selfCancel"] },
    { id: "acme.Probe.archiveTouch", kind: "operation", module, export: "Probe_archiveTouch", member: ["Probe", "archiveTouch"] },
    { id: "acme.Probe.orphanMember", kind: "operation", module, export: "Probe_orphanMember", member: ["Probe", "orphanMember"] },
    { id: "acme.Probe.ghostMember", kind: "operation", module, export: "Probe_ghostMember", member: ["Probe", "ghostMember"] },
  ];
  return {
    artifact_version: 1,
    language_version: t18.language_version,
    tool_version: t18.tool_version,
    sources: t18.sources,
    modules: [],
    callables,
    pages: [],
    requires: t18.requires,
    tests: [],
    operations,
    models,
  } as unknown as CompileArtifact;
}

async function c2Setup(): Promise<{
  url: string;
  asm: AssembledModules;
  artifact: CompileArtifact;
  store: StoragePort;
  seed: SeededIdentity;
  mod: FixtureModule;
}> {
  const dir = tempDir();
  const url = writeModule(dir, "c2ops.mjs", C2_MODULE);
  const asm = stubAsm(dir, { "c2ops.mjs": url });
  const artifact = c2Artifact("c2ops.mjs");
  const { store } = createTestMemoryStorage();
  const seed = await seedIdentity();
  const mod = (await import(url)) as FixtureModule;
  return { url, asm, artifact, store, seed, mod };
}

/** Structural read of the carried conflict (contracts-dist agnostic). */
function carriedConflict(error: unknown): {
  readonly message: string;
  readonly current: {
    readonly model: string;
    readonly id: string;
    readonly version: number;
    readonly updated: string;
    readonly updatedBy: string;
    readonly values: { readonly [fieldPath: string]: unknown };
  };
} | undefined {
  const holder = error as unknown as { conflict?: unknown };
  return holder.conflict as
    | {
        readonly message: string;
        readonly current: {
          readonly model: string;
          readonly id: string;
          readonly version: number;
          readonly updated: string;
          readonly updatedBy: string;
          readonly values: { readonly [fieldPath: string]: unknown };
        };
      }
    | undefined;
}

describe("T32c C2 site 1+5 (serverInits + nullable fill through CRUD create)", () => {
  it("resolves server inits and fills omitted nullable on the quiet path", async () => {
    const { asm, artifact, store, seed } = await c2Setup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("Shop.Team.create", freshOperationId(seed.now), {
        name: "alpha",
        owner: seed.memberId,
        flags: [],
      }),
      identity,
    );
    assert.ok(!("error" in outcome), `create must commit: ${JSON.stringify(outcome)}`);
    const rows = await modelRows(store, "Shop.Team");
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row !== undefined);
    assert.equal(row.version, 1);
    // Nullable channel: omitted nullable stores EXPLICIT null.
    assert.equal(row.data["note"], null);
    // Server-init channel: now/actor/random_secret resolve at creation.
    assert.equal(row.data["made"], new Date(seed.now).toISOString());
    assert.deepEqual(row.data["by"], { id: seed.memberId });
    assert.match(row.data["token"] as string, /^[0-9a-f]{64}$/);
  });
});

describe("T32c C2 site 3+4 (conflict currents + assembly mirror, bb1ca7a)", () => {
  it("stale Team update carries full currents minus serverOnly minus secrets", async () => {
    const { asm, artifact, store, seed } = await c2Setup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const created = await invoker.invokeMutation(
      mutationEnvelope("Shop.Team.create", freshOperationId(seed.now), {
        name: "alpha",
        owner: seed.memberId,
        flags: [],
      }),
      identity,
    );
    assert.ok(!("error" in created), `create must commit: ${JSON.stringify(created)}`);
    const rows = await modelRows(store, "Shop.Team");
    const first = rows[0];
    assert.ok(first !== undefined);
    const id = first.id;
    const v2 = await invoker.invokeMutation(
      mutationEnvelope("Shop.Team.update", freshOperationId(seed.now), {
        record: { id, version: "1" },
        name: "bravo",
      }),
      identity,
    );
    assert.ok(!("error" in v2), `fresh update must commit: ${JSON.stringify(v2)}`);
    const stale = await invoker.invokeMutation(
      mutationEnvelope("Shop.Team.update", freshOperationId(seed.now), {
        record: { id, version: "1" },
        name: "charlie",
      }),
      identity,
    );
    assert.ok("error" in stale, "stale version must conflict");
    assert.equal(stale.error.code, "conflict");
    const conflict = carriedConflict(stale.error);
    assert.ok(conflict !== undefined && conflict !== null, "conflict must carry the current row");
    assert.equal(conflict.current.model, "Shop.Team");
    assert.equal(conflict.current.id, id);
    assert.equal(conflict.current.version, 2);
    // submitted∩row minus serverOnly (made/by) minus secrets (token):
    // the submitted field with its CURRENT value, plus the admitted
    // normalization (absent optional arrays fill []).
    assert.deepEqual(conflict.current.values, { name: "bravo", tags: [] });
    assert.ok(typeof conflict.current.updated === "string" && conflict.current.updated !== "");
    assert.ok(typeof conflict.current.updatedBy === "string" && conflict.current.updatedBy !== "");
    assert.ok(typeof conflict.message === "string" && conflict.message !== "");
  });

  it("stale Plain update carries full currents (empty exclusion set)", async () => {
    const { asm, artifact, store, seed } = await c2Setup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const created = await invoker.invokeMutation(
      mutationEnvelope("acme.Plain.create", freshOperationId(seed.now), { title: "p1" }),
      identity,
    );
    assert.ok(!("error" in created), `create must commit: ${JSON.stringify(created)}`);
    const rows = await modelRows(store, "acme.Plain");
    const first = rows[0];
    assert.ok(first !== undefined);
    const id = first.id;
    const v2 = await invoker.invokeMutation(
      mutationEnvelope("acme.Plain.update", freshOperationId(seed.now), {
        record: { id, version: "1" },
        title: "p2",
      }),
      identity,
    );
    assert.ok(!("error" in v2), `fresh update must commit: ${JSON.stringify(v2)}`);
    const stale = await invoker.invokeMutation(
      mutationEnvelope("acme.Plain.update", freshOperationId(seed.now), {
        record: { id, version: "1" },
        title: "p3",
      }),
      identity,
    );
    assert.ok("error" in stale, "stale version must conflict");
    assert.equal(stale.error.code, "conflict");
    // A serverOnly-free model MUST still hold an (empty) exclusion
    // entry: a missing entry degrades to metadata-only values.
    const conflict = carriedConflict(stale.error);
    assert.ok(conflict !== undefined && conflict !== null, "conflict must carry the current row");
    assert.deepEqual(conflict.current.values, { title: "p2" });
  });
});

describe("T32c C2 site 2 (scenario archive gate on stageWrite)", () => {
  it("scenario set() on an archived row fails EXACTLY like admission", async () => {
    const { asm, artifact, store, seed, mod } = await c2Setup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const created = await invoker.invokeMutation(
      mutationEnvelope("Shop.Team.create", freshOperationId(seed.now), {
        name: "doomed",
        owner: seed.memberId,
        flags: [],
      }),
      identity,
    );
    assert.ok(!("error" in created), `create must commit: ${JSON.stringify(created)}`);
    const rows = await modelRows(store, "Shop.Team");
    const first = rows[0];
    assert.ok(first !== undefined);
    const id = first.id;
    const deleted = await invoker.invokeMutation(
      mutationEnvelope("Shop.Team.delete", freshOperationId(seed.now), {
        record: { id, version: "1" },
      }),
      identity,
    );
    assert.ok(!("error" in deleted), `archive delete must commit: ${JSON.stringify(deleted)}`);
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Probe.archiveTouch", freshOperationId(seed.now), { id }),
      identity,
    );
    assert.ok("error" in outcome, "touching an archived row must fail");
    assert.equal(outcome.error.code, "validation");
    assert.equal(outcome.error.message, "Archived records cannot be used here.");
    assert.deepEqual(mod.calls, ["archiveTouch"]);
  });
});

describe("T32c C2 site 1+5 (containment enforcement on the child model)", () => {
  it("parents link (defaults + nullable) while orphans fail missing-parent", async () => {
    const { asm, artifact, store, seed, mod } = await c2Setup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const created = await invoker.invokeMutation(
      mutationEnvelope("Shop.Team.create", freshOperationId(seed.now), {
        name: "parent",
        owner: seed.memberId,
        flags: [],
      }),
      identity,
    );
    assert.ok(!("error" in created), `parent create must commit: ${JSON.stringify(created)}`);
    const teams = await modelRows(store, "Shop.Team");
    const team = teams[0];
    assert.ok(team !== undefined);
    const membered = await invoker.invokeMutation(
      mutationEnvelope("Shop.Member.create", freshOperationId(seed.now), {
        name: "m1",
        parent: { model: "Shop.Team", id: team.id },
      }),
      identity,
    );
    assert.ok(!("error" in membered), `child create must commit: ${JSON.stringify(membered)}`);
    const members = await modelRows(store, "Shop.Member");
    assert.equal(members.length, 1);
    const member = members[0];
    assert.ok(member !== undefined);
    assert.deepEqual(member.parent, { model: "Shop.Team", id: team.id });
    assert.equal(member.data["buddy"], seed.memberId);
    assert.equal(member.data["nick"], null);
    assert.equal(member.data["seen"], new Date(seed.now).toISOString());
    const orphan = await invoker.invokeMutation(
      mutationEnvelope("acme.Probe.orphanMember", freshOperationId(seed.now), {
        key: "o1",
        owner: seed.memberId,
      }),
      identity,
    );
    assert.ok("error" in orphan, "parentless child create must fail");
    assert.equal(orphan.error.code, "validation");
    assert.match(orphan.error.message, /Missing required parent/);
    assert.equal((await modelRows(store, "Shop.Member")).length, 1);
    const ghost = await invoker.invokeMutation(
      mutationEnvelope("Shop.Member.create", freshOperationId(seed.now), {
        name: "g1",
        parent: { model: "Shop.Team", id: "ghost-1" },
      }),
      identity,
    );
    assert.ok("error" in ghost, "ghost-parent child create must fail");
    // CRUD path: admission resolves the parent ref input first —
    // existence-hiding lookup surfaces as not_found.
    assert.equal(ghost.error.code, "not_found");
    assert.match(ghost.error.message, /Record not found/);
    assert.equal((await modelRows(store, "Shop.Member")).length, 1);
    const scenarioGhost = await invoker.invokeMutation(
      mutationEnvelope("acme.Probe.ghostMember", freshOperationId(seed.now), {
        key: "g2",
        owner: seed.memberId,
      }),
      identity,
    );
    assert.ok("error" in scenarioGhost, "scenario ghost-parent create must fail");
    // Scenario path: no per-write admission — the pipeline's
    // containment branch reports the engine validation.
    assert.equal(scenarioGhost.error.code, "validation");
    assert.match(scenarioGhost.error.message, /Parent record not found/);
    assert.equal((await modelRows(store, "Shop.Member")).length, 1);
    assert.deepEqual(mod.calls, ["orphanMember", "ghostMember"]);
  });
});

describe("T32c C2 self-cancel netting verdict (B1, production shape)", () => {
  it("create+remove of an archive-mode record commits an archived stub (no throw)", async () => {
    // B1 nets same-batch self-canceling writes in the pipeline
    // (pipeline.ts:285): the scenario-seam "verdict" for a
    // self-canceling scenario is a COMMIT, never an authoring-call
    // throw. Archive-mode pairs persist an archived stub with a
    // create+archive trail (T17b memoCycle proves the interim shape;
    // this pins the production T18 shape through the same seam).
    const { asm, artifact, store, seed, mod } = await c2Setup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Probe.selfCancel", freshOperationId(seed.now), {
        key: "tmp-1",
        owner: seed.memberId,
      }),
      identity,
    );
    assert.ok("result" in outcome, `self-cancel must commit: ${JSON.stringify(outcome)}`);
    assert.equal((outcome.result as MutationResult).status, "committed");
    const row = await store.load("Shop.Team" as ModelName, "tmp-1" as RecordId);
    assert.ok(row !== null);
    assert.equal(row.archivedAt, seed.now);
    const trail = await store.historyFor("Shop.Team" as ModelName, "tmp-1" as RecordId);
    assert.deepEqual(
      trail.map((entry) => entry.change),
      ["create", "archive"],
    );
    assert.deepEqual(mod.calls, ["selfCancel"]);
  });
});
