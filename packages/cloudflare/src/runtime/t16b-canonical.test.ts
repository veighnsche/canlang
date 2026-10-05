/**
 * T16b L7 join: generated invocation through canonical admission.
 *
 * Generated artifacts (T15a `operations[]` + `models[]`) invoke
 * mutations through the canonical state path (admit -> execute ->
 * receipt): CRUD operations execute through T16a's pipeline adapter
 * (their emitted handlers NEVER run — the stubs below throw to prove
 * it), scenarios run their emitted handler as the execute seam, reads
 * refuse with the query-port pointer, and identical envelopes replay
 * instead of duplicating. Descriptor-less artifacts keep the interim
 * direct path byte-identically (existing suites pin it).
 *
 * T17b pin updates (attributed inline): generated reads now SERVE
 * through `invokeReadCanonical` (the read-envelope refusal became a
 * serving pin; the mutation-envelope read-guard pin is unchanged),
 * the commit-guard message names the landed staged rule (the guard
 * still trips for direct commits), and descriptor-less artifacts now
 * REFUSE on both envelopes (the byte-identity pin became a refusal
 * pin). Every other pin is unchanged — what changed and why is
 * stated at each site; nothing was silently weakened.
 *
 * No-bypass proof strategy: canonical-only result shapes
 * (`MutationResult` with status/operation_id, impossible on the
 * direct path) + receipts in the store + single-execution counts +
 * generated-artifact-with-direct-only-store failing LOUD (the direct
 * path would have succeeded) + router unit coverage.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import type {
  CompileArtifact,
  ModelName,
  MutationEnvelope,
  MutationResult,
  OperationId,
  OperationName,
  RecordId,
  ResolvedIdentity,
  Revision,
  StoragePort,
} from "@canlang/contracts";
import { resolveIdentity, sha256HexText } from "@canlang/identity";
import { createFrozenClock, createMemoryIdentityStore } from "@canlang/identity/testing";
import { createTestMemoryStorage } from "../../../state/dist/state/src/storage/memory.js";
import { assembleWorker, buildInvoker } from "../worker/assembly.js";
import type { AssembledModules, AssemblyDeps } from "../worker/assembly.js";
import {
  assertRequiresFulfilled,
  assertT04aContractPins,
  isGeneratedArtifact,
  loadCanonicalDescriptors,
  loadContractVersions,
  mapCrudPolicyToBy,
  readOperationPolicyEntry,
  withCanonicalCommitGuard,
} from "./invoke.js";

/* ------------------------------------------------------------------ */
/* Fixture builders.                                                   */
/* ------------------------------------------------------------------ */

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "canlang-t16b-"));
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

const OPS_MODULE = `const calls = [];
export function canApp() {
  return {
    calls,
    policy: { operations: {
      "acme.Todo.create": { by: ["members"] },
      "acme.Todo.update": { by: ["owner"] },
      "acme.Todo.delete": { by: ["acme.Clerk"] }
    } },
    Todo: {
      create: async () => { throw new Error("t16b-proof: CRUD handler must never run on the canonical path"); },
      update: async () => { throw new Error("t16b-proof: CRUD handler must never run on the canonical path"); },
      delete: async () => { throw new Error("t16b-proof: CRUD handler must never run on the canonical path"); }
    },
    Shop: {
      restock: async (c, input) => {
        calls.push({ caller: c.caller.userId, roles: [...c.caller.roles], memberships: [...c.memberships], input });
        return { restocked: input.inputs.sku, tags: input.inputs.tags === undefined ? null : input.inputs.tags };
      }
    }
  };
}
`;

const COMMIT_MODULE = `const calls = [];
export function canApp() {
  return {
    calls,
    policy: { operations: {} },
    Shop: {
      restock: async (c, input) => {
        calls.push("commit-attempt");
        await c.store.commit({ expectedRevision: 0, writes: [], history: [], receipt: null, outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [] });
        return { never: true };
      }
    }
  };
}
`;

function policyModule(policyJson: string): string {
  return `export function canApp() {
  return {
    policy: { operations: ${policyJson} },
    Todo: {
      create: async () => ({ unreachable: true })
    }
  };
}
`;
}

const LEGACY_MODULE = `export function canApp() {
  return {
    echo: async (c, input) => ({ echoed: input.operation_id, caller: c.caller.userId })
  };
}
`;

function todoModel(): unknown {
  return {
    name: "acme.Todo",
    fields: [
      { name: "title", required: true, serverOnly: false, field: { kind: "string" } },
      { name: "done", required: false, serverOnly: false, field: { kind: "boolean" } },
    ],
    deleteMode: "remove",
  };
}

function shopOperations(): unknown[] {
  return [
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
    {
      name: "acme.Todo.update",
      kind: "update",
      description: "",
      inputs: {
        fields: [
          {
            name: "record",
            field: { kind: "ref", model: "acme.Todo", requireVersion: true },
            required: true,
          },
          { name: "title", field: { kind: "string" }, required: false },
        ],
      },
    },
    {
      name: "acme.Todo.delete",
      kind: "delete",
      description: "",
      inputs: {
        fields: [
          {
            name: "record",
            field: { kind: "ref", model: "acme.Todo", requireVersion: true },
            required: true,
          },
        ],
      },
    },
    {
      name: "acme.Shop.restock",
      kind: "scenario",
      description: "",
      inputs: {
        fields: [
          { name: "sku", field: { kind: "string" }, required: true },
          {
            name: "tags",
            field: { kind: "string" },
            required: false,
            array: { required: false },
          },
        ],
      },
    },
    { name: "acme.Todo.read", kind: "read", description: "", inputs: { fields: [] } },
  ];
}

function shopCallables(module: string): unknown[] {
  return [
    { id: "acme.Todo.create", kind: "operation", module, export: "Todo_create", member: ["Todo", "create"] },
    { id: "acme.Todo.update", kind: "operation", module, export: "Todo_update", member: ["Todo", "update"] },
    { id: "acme.Todo.delete", kind: "operation", module, export: "Todo_delete", member: ["Todo", "delete"] },
    { id: "acme.Shop.restock", kind: "operation", module, export: "Shop_restock", member: ["Shop", "restock"] },
  ];
}

/** Hand-written T15a-shaped artifact (NOT compiler output): descriptors + callables + requires. */
function generatedArtifact(module: string, overrides: Record<string, unknown> = {}): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "t16b-fixture/0 (hand-written T15a shape; NOT compiler output)",
    tool_version: "t16b-fixture/0",
    sources: [{ path: "examples/TeamTasks.can", sha256: "fixture-not-a-digest" }],
    modules: [],
    callables: shopCallables(module),
    pages: [],
    requires: [
      { capability: "canlang.builtins", min_version: 2 },
      { capability: "state", min_version: 1 },
    ],
    tests: [],
    operations: shopOperations(),
    models: [todoModel()],
    ...overrides,
  } as unknown as CompileArtifact;
}

/** Descriptor-less artifact (pre-T15a shape): the interim direct path serves it. */
function legacyArtifact(module: string): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "t16b-fixture/0 (hand-written legacy shape)",
    tool_version: "t16b-fixture/0",
    sources: [{ path: "examples/TeamTasks.can", sha256: "fixture-not-a-digest" }],
    modules: [],
    callables: [
      { id: "fixture.echo", kind: "operation", module, export: "echo", member: ["echo"] },
    ],
    pages: [],
    requires: [],
    tests: [],
  } as unknown as CompileArtifact;
}

function stubAsm(dir: string, moduleUrls: Record<string, string>): AssembledModules {
  return { dir, entryUrl: "fixture-entry", moduleUrls };
}

interface SeededIdentity {
  readonly now: number;
  readonly store: ReturnType<typeof createMemoryIdentityStore>;
  readonly teamId: string;
  readonly ownerId: string;
  readonly clerkId: string;
  readonly memberId: string;
  readonly outsiderId: string;
  readonly clerkMembershipId: string;
  readonly memberMembershipId: string;
  readonly ownerToken: string;
  readonly clerkToken: string;
  readonly memberToken: string;
  readonly outsiderToken: string;
}

/** One team: owner (no grants), clerk (declared role grant), plain member, outsider. */
async function seedIdentity(): Promise<SeededIdentity> {
  const now = Date.now();
  const clock = createFrozenClock(now);
  const store = createMemoryIdentityStore({ clock });
  const iso = (ms: number): string => new Date(ms).toISOString();
  const team = await store.createTeam({});
  const owner = await store.createUser({
    email: "owner@t16b.test",
    password_hash: "x",
    email_verified: true,
  });
  await store.createMembership({
    team_id: team.team_id,
    user_id: owner.user_id,
    is_owner: true,
    roles: [],
  });
  const clerk = await store.createUser({
    email: "clerk@t16b.test",
    password_hash: "x",
    email_verified: true,
  });
  const clerkMembership = await store.createMembership({
    team_id: team.team_id,
    user_id: clerk.user_id,
    is_owner: false,
    roles: [{ role: "acme.Clerk", granted_at: iso(now), granted_by: owner.user_id }],
  });
  const member = await store.createUser({
    email: "member@t16b.test",
    password_hash: "x",
    email_verified: true,
  });
  const memberMembership = await store.createMembership({
    team_id: team.team_id,
    user_id: member.user_id,
    is_owner: false,
    roles: [],
  });
  const outsider = await store.createUser({
    email: "outsider@t16b.test",
    password_hash: "x",
    email_verified: true,
  });
  const sessionFor = async (userId: string, token: string): Promise<void> => {
    await store.createSession({
      user_id: userId,
      token_sha256: await sha256HexText(token),
      expires_at: iso(now + 3600_000),
      last_team_id: team.team_id,
    });
  };
  const ownerToken = `owner-token-${randomBytes(8).toString("hex")}`;
  const clerkToken = `clerk-token-${randomBytes(8).toString("hex")}`;
  const memberToken = `member-token-${randomBytes(8).toString("hex")}`;
  const outsiderToken = `outsider-token-${randomBytes(8).toString("hex")}`;
  await sessionFor(owner.user_id, ownerToken);
  await sessionFor(clerk.user_id, clerkToken);
  await sessionFor(member.user_id, memberToken);
  await sessionFor(outsider.user_id, outsiderToken);
  return {
    now,
    store,
    teamId: team.team_id,
    ownerId: owner.user_id,
    clerkId: clerk.user_id,
    memberId: member.user_id,
    outsiderId: outsider.user_id,
    clerkMembershipId: clerkMembership.membership_id,
    memberMembershipId: memberMembership.membership_id,
    ownerToken,
    clerkToken,
    memberToken,
    outsiderToken,
  };
}

async function identityFor(seed: SeededIdentity, token: string): Promise<ResolvedIdentity> {
  return resolveIdentity(
    seed.store,
    { session_token: token },
    { clock: { nowMs: () => seed.now } },
  );
}

function mutationEnvelope(operation: string, operationId: string, inputs: Record<string, unknown>): MutationEnvelope {
  return { operation, operation_id: operationId as OperationId, inputs };
}

async function captureError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof Error, `want Error, got ${String(error)}`);
    return error;
  }
  assert.fail("expected a throw");
}

async function todoRows(store: StoragePort): Promise<ReadonlyArray<{ id: string } & Record<string, unknown>>> {
  const rows = await store.query({ model: "acme.Todo" as ModelName, authority: "owner" });
  return rows as unknown as ReadonlyArray<{ id: string } & Record<string, unknown>>;
}

describe("T16b router (generated vs interim)", () => {
  it("routes canonical iff BOTH descriptor keys are present", () => {
    assert.equal(isGeneratedArtifact(generatedArtifact("ops.mjs")), true);
    assert.equal(isGeneratedArtifact(legacyArtifact("ops.mjs")), false);
    assert.equal(
      isGeneratedArtifact({} as unknown as CompileArtifact),
      false,
    );
    assert.equal(
      isGeneratedArtifact({ operations: [] } as unknown as CompileArtifact),
      false,
    );
    assert.equal(
      isGeneratedArtifact({ models: [] } as unknown as CompileArtifact),
      false,
    );
    assert.equal(
      isGeneratedArtifact({ operations: [], models: [] } as unknown as CompileArtifact),
      true,
    );
  });
});

describe("T16b policy transcription (CRUD gates)", () => {
  it("maps the established subset; refuses the rest LOUD naming T04b", () => {
    assert.equal(mapCrudPolicyToBy("op", undefined), "public");
    assert.equal(mapCrudPolicyToBy("op", { by: ["members"] }), "members");
    assert.equal(mapCrudPolicyToBy("op", { by: ["owner"] }), "owner");
    assert.deepEqual(mapCrudPolicyToBy("op", { by: ["acme.Clerk"] }), { role: "acme.Clerk" });
    assert.deepEqual(mapCrudPolicyToBy("op", { by: ["members", "owner"] }), {
      and: ["members", "owner"],
    });
    for (const entry of [
      { by: ["members"], gated: true },
      { by: ["members"], when: true },
      { by: ["members"], requires: 2 },
      {},
      { by: [] },
      { by: [""] },
      { by: "members" },
      { by: ["members"], audit: true },
      "by-members",
    ]) {
      assert.throws(() => mapCrudPolicyToBy("acme.Todo.create", entry), /T04b|malformed|unknown policy member/);
    }
    assert.throws(
      () => mapCrudPolicyToBy("acme.Todo.create", { by: ["members"], gated: true }),
      /T04b carries generated policy/,
    );
  });

  it("reads manifest entries defensively; malformed shapes fail loud", () => {
    assert.equal(readOperationPolicyEntry({}, "op"), undefined);
    assert.equal(readOperationPolicyEntry({ policy: null }, "op"), undefined);
    assert.equal(readOperationPolicyEntry({ policy: { operations: {} } }, "op"), undefined);
    assert.deepEqual(
      readOperationPolicyEntry({ policy: { operations: { op: { by: ["members"] } } } }, "op"),
      { by: ["members"] },
    );
    assert.throws(() => readOperationPolicyEntry(null, "op"), /not an object/);
    assert.throws(() => readOperationPolicyEntry({ policy: 7 }, "op"), /not an object/);
    assert.throws(
      () => readOperationPolicyEntry({ policy: { operations: [] } }, "op"),
      /not an object/,
    );
  });
});

describe("T16b commit guard (scenario seam store)", () => {
  // T17b: message updated (was /T17 stdlib migration/ — the migration
  // LANDED, so the guard now names the staged rule). The guard still
  // refuses direct commits; only the pointer text changed.
  it("delegates reads and refuses commits LOUD with the staged rule", async () => {
    const { store } = createTestMemoryStorage();
    const guarded = withCanonicalCommitGuard(store, "acme.Shop.restock");
    assert.equal(await guarded.readRevision(), 0);
    assert.equal(await guarded.load("acme.Todo" as ModelName, "nope" as RecordId), null);
    assert.deepEqual(
      await guarded.query({ model: "acme.Todo" as ModelName, authority: "owner" }),
      [],
    );
    await assert.rejects(
      async () =>
        guarded.commit({
          expectedRevision: 0 as Revision,
          writes: [],
          history: [],
          receipt: null,
          outbox: [],
          schedules: [],
          uniqueClaims: [],
          uniqueReleases: [],
        }),
      /stage through the stdlib data plane/,
    );
  });
});

describe("T16b version fulfillment (pins + requires)", () => {
  it("loads the real contracts pins (all v1) and asserts them exactly", async () => {
    const versions = await loadContractVersions();
    assert.deepEqual(versions, {
      execution: 1,
      artifact: 1,
      state: 1,
      values: 1,
      identity: 1,
      wire: 1,
      examples: 1,
    });
    assertT04aContractPins(versions);
    assert.throws(
      () => assertT04aContractPins({ ...versions, examples: 2 }),
      /incompatible contract versions \(examples v2 \(want v1\)\)/,
    );
    assert.throws(
      () => assertT04aContractPins({ ...versions, state: 2, wire: 0 }),
      /state v2 \(want v1\), wire v0 \(want v1\)/,
    );
  });

  it("fulfills pin-mapped requires exactly; unknown ids and drift reject", () => {
    const provided = { state: 1, values: 1 };
    assertRequiresFulfilled([], provided);
    assertRequiresFulfilled(
      [
        { capability: "state", min_version: 1 },
        { capability: "values.decimal", min_version: 1 },
      ],
      provided,
    );
    // canlang.builtins pins the catalog major (no runtime constant to
    // match — T16c gap): skipped, never silently fulfilled.
    assertRequiresFulfilled([{ capability: "canlang.builtins", min_version: 99 }], provided);
    assert.throws(
      () => assertRequiresFulfilled([{ capability: "values.decimal", min_version: 2 }], provided),
      /provides v1 — refusing to serve/,
    );
    assert.throws(
      () => assertRequiresFulfilled([{ capability: "teleport.v1", min_version: 1 }], provided),
      /unknown capability "teleport\.v1"/,
    );
  });
});

describe("T16b canonical CRUD (pipeline executes; handlers never run)", () => {
  it("creates through the pipeline with record id = operation id", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", OPS_MODULE);
    const asm = stubAsm(dir, { "ops.mjs": url });
    const artifact = generatedArtifact("ops.mjs");
    const { store } = createTestMemoryStorage();
    const seed = await seedIdentity();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const operationId = freshOperationId(seed.now);
    const identity = await identityFor(seed, seed.memberToken);
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Todo.create", operationId, { title: "buy milk" }),
      identity,
    );
    assert.ok("result" in outcome, `want result, got ${JSON.stringify(outcome)}`);
    const result = outcome.result as MutationResult;
    assert.equal(result.status, "committed");
    assert.equal(result.operation_id, operationId);
    const row = result.result as { id: string; version: number; data: Record<string, unknown> };
    assert.equal(row.id, operationId);
    assert.equal(row.version, 1);
    assert.deepEqual(row.data, { title: "buy milk" });
    // Receipt persisted under the canonical identity (app from the
    // artifact stem, team owner, user principal).
    const receipt = await store.readReceipt({
      app: "TeamTasks",
      owner: seed.teamId,
      principal: seed.memberId,
      operation: "acme.Todo.create" as OperationName,
      operationId: operationId as OperationId,
    });
    assert.ok(receipt !== null, "canonical receipt must be persisted");
    assert.equal(receipt?.outcome.status, "committed");
    assert.equal((await todoRows(store)).length, 1);
  });

  it("replays identical envelopes instead of duplicating", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", OPS_MODULE);
    const asm = stubAsm(dir, { "ops.mjs": url });
    const artifact = generatedArtifact("ops.mjs");
    const { store } = createTestMemoryStorage();
    const seed = await seedIdentity();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const operationId = freshOperationId(seed.now);
    const identity = await identityFor(seed, seed.memberToken);
    const envelope = mutationEnvelope("acme.Todo.create", operationId, { title: "once" });
    const first = await invoker.invokeMutation(envelope, identity);
    assert.ok("result" in first, `want result, got ${JSON.stringify(first)}`);
    assert.equal((first.result as MutationResult).status, "committed");
    const revisionAfterCommit = await store.readRevision();
    const second = await invoker.invokeMutation(envelope, identity);
    assert.ok("result" in second, `want replayed result, got ${JSON.stringify(second)}`);
    const replayed = second.result as MutationResult;
    assert.equal(replayed.status, "replayed");
    assert.equal(replayed.operation_id, operationId);
    assert.deepEqual(replayed.result, (first.result as MutationResult).result);
    assert.equal(await store.readRevision(), revisionAfterCommit);
    assert.equal((await todoRows(store)).length, 1);
  });

  it("updates with version fencing and deletes through the pipeline", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", OPS_MODULE);
    const asm = stubAsm(dir, { "ops.mjs": url });
    const artifact = generatedArtifact("ops.mjs");
    const { store } = createTestMemoryStorage();
    const seed = await seedIdentity();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const ownerIdentity = await identityFor(seed, seed.ownerToken);
    // Update is owner-gated: the owner admits (the interim deny-all on
    // `by owner` is fixed by the join).
    const created = await invoker.invokeMutation(
      mutationEnvelope("acme.Todo.create", freshOperationId(seed.now), { title: "v1" }),
      ownerIdentity,
    );
    assert.ok("result" in created, `want result, got ${JSON.stringify(created)}`);
    const id = ((created.result as MutationResult).result as { id: string }).id;
    const updated = await invoker.invokeMutation(
      mutationEnvelope("acme.Todo.update", freshOperationId(seed.now), {
        record: { id, version: "1" },
        title: "v2",
      }),
      ownerIdentity,
    );
    assert.ok("result" in updated, `want result, got ${JSON.stringify(updated)}`);
    const updatedRow = (updated.result as MutationResult).result as {
      version: number;
      data: Record<string, unknown>;
    };
    assert.equal(updatedRow.version, 2);
    assert.deepEqual(updatedRow.data, { title: "v2" });
    // Stale version conflicts; the delete (clerk-gated) removes the row.
    const stale = await invoker.invokeMutation(
      mutationEnvelope("acme.Todo.update", freshOperationId(seed.now), {
        record: { id, version: "1" },
        title: "stale",
      }),
      ownerIdentity,
    );
    assert.ok("error" in stale, "stale version must conflict");
    assert.equal(stale.error.code, "conflict");
    const clerkIdentity = await identityFor(seed, seed.clerkToken);
    const deleted = await invoker.invokeMutation(
      mutationEnvelope("acme.Todo.delete", freshOperationId(seed.now), {
        record: { id, version: "2" },
      }),
      clerkIdentity,
    );
    assert.ok("result" in deleted, `want result, got ${JSON.stringify(deleted)}`);
    assert.equal(await store.load("acme.Todo" as ModelName, id as RecordId), null);
  });
});

describe("T16b canonical scenario (handler as the execute seam)", () => {
  it("runs the handler once with admitted inputs; replays without re-running", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", OPS_MODULE);
    const asm = stubAsm(dir, { "ops.mjs": url });
    const artifact = generatedArtifact("ops.mjs");
    const { store } = createTestMemoryStorage();
    const seed = await seedIdentity();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const operationId = freshOperationId(seed.now);
    const identity = await identityFor(seed, seed.memberToken);
    const envelope = mutationEnvelope("acme.Shop.restock", operationId, { sku: "s-1" });
    const first = await invoker.invokeMutation(envelope, identity);
    assert.ok("result" in first, `want result, got ${JSON.stringify(first)}`);
    const committed = first.result as MutationResult;
    assert.equal(committed.status, "committed");
    // Omitted ordinary-array input arrives filled (T16 honors the marker).
    assert.deepEqual(committed.result, { restocked: "s-1", tags: [] });
    const registry = (await import(url)) as { canApp(): { calls: unknown[] } };
    assert.equal(registry.canApp().calls.length, 1);
    const call = registry.canApp().calls[0] as {
      caller: string;
      memberships: string[];
      input: { operation_id: string; inputs: Record<string, unknown> };
    };
    assert.equal(call.caller, seed.memberId);
    assert.equal(call.input.operation_id, operationId);
    assert.deepEqual(call.input.inputs, { sku: "s-1", tags: [] });
    const revisionAfterCommit = await store.readRevision();
    const second = await invoker.invokeMutation(envelope, identity);
    assert.ok("result" in second, `want replayed result, got ${JSON.stringify(second)}`);
    assert.equal((second.result as MutationResult).status, "replayed");
    assert.equal(registry.canApp().calls.length, 1);
    assert.equal(await store.readRevision(), revisionAfterCommit);
  });

  it("serves public callers on ungated scenarios with zero memberships", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", OPS_MODULE);
    const asm = stubAsm(dir, { "ops.mjs": url });
    const artifact = generatedArtifact("ops.mjs");
    const { store } = createTestMemoryStorage();
    const seed = await seedIdentity();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.outsiderToken);
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.restock", freshOperationId(seed.now), { sku: "pub" }),
      identity,
    );
    assert.ok("result" in outcome, `want result, got ${JSON.stringify(outcome)}`);
    assert.equal((outcome.result as MutationResult).status, "committed");
    const registry = (await import(url)) as {
      canApp(): { calls: Array<{ caller: string; memberships: string[] }> };
    };
    const calls = registry.canApp().calls;
    const last = calls[calls.length - 1];
    assert.ok(last !== undefined);
    assert.equal(last.caller, seed.outsiderId);
    assert.deepEqual(last.memberships, []);
  });
});

describe("T16b canonical negatives (codes + unchanged state)", () => {
  it("unknown operations reject validation and mutate nothing", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", OPS_MODULE);
    const asm = stubAsm(dir, { "ops.mjs": url });
    const artifact = generatedArtifact("ops.mjs");
    const { store } = createTestMemoryStorage();
    const seed = await seedIdentity();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const revisionBefore = await store.readRevision();
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Nope.missing", freshOperationId(seed.now), {}),
      identity,
    );
    assert.ok("error" in outcome, "unknown operation must reject");
    assert.equal(outcome.error.code, "validation");
    assert.match(outcome.error.message, /Unknown operation "acme\.Nope\.missing"/);
    assert.equal(await store.readRevision(), revisionBefore);
    assert.equal((await todoRows(store)).length, 0);
  });

  it("closed-shape violations reject validation and mutate nothing", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", OPS_MODULE);
    const asm = stubAsm(dir, { "ops.mjs": url });
    const artifact = generatedArtifact("ops.mjs");
    const { store } = createTestMemoryStorage();
    const seed = await seedIdentity();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const revisionBefore = await store.readRevision();
    const bogus = await invoker.invokeMutation(
      mutationEnvelope("acme.Todo.create", freshOperationId(seed.now), {
        title: "x",
        bogus: 1,
      }),
      identity,
    );
    assert.ok("error" in bogus, "unknown input must reject");
    assert.equal(bogus.error.code, "validation");
    const missing = await invoker.invokeMutation(
      mutationEnvelope("acme.Todo.create", freshOperationId(seed.now), {}),
      identity,
    );
    assert.ok("error" in missing, "missing required input must reject");
    assert.equal(missing.error.code, "validation");
    assert.equal(await store.readRevision(), revisionBefore);
    assert.equal((await todoRows(store)).length, 0);
  });

  it("unauthorized callers fail forbidden and mutate nothing", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", OPS_MODULE);
    const asm = stubAsm(dir, { "ops.mjs": url });
    const artifact = generatedArtifact("ops.mjs");
    const { store } = createTestMemoryStorage();
    const seed = await seedIdentity();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const revisionBefore = await store.readRevision();
    // Outsider (no membership) on the members-gated create.
    const outsiderIdentity = await identityFor(seed, seed.outsiderToken);
    const outsider = await invoker.invokeMutation(
      mutationEnvelope("acme.Todo.create", freshOperationId(seed.now), { title: "no" }),
      outsiderIdentity,
    );
    assert.ok("error" in outsider, "outsider must be denied");
    assert.equal(outsider.error.code, "forbidden");
    // Plain member (no owner flag, no clerk grant) on the owner-gated update.
    const memberIdentity = await identityFor(seed, seed.memberToken);
    const created = await invoker.invokeMutation(
      mutationEnvelope("acme.Todo.create", freshOperationId(seed.now), { title: "t" }),
      memberIdentity,
    );
    assert.ok("result" in created, `member creates, got ${JSON.stringify(created)}`);
    const id = ((created.result as MutationResult).result as { id: string }).id;
    const memberUpdate = await invoker.invokeMutation(
      mutationEnvelope("acme.Todo.update", freshOperationId(seed.now), {
        record: { id, version: "1" },
        title: "member-edit",
      }),
      memberIdentity,
    );
    assert.ok("error" in memberUpdate, "non-owner member must be denied the owner gate");
    assert.equal(memberUpdate.error.code, "forbidden");
    // Owner (no declared-role grant) on the clerk-gated delete: owners
    // never implicitly hold declared roles.
    const ownerIdentity = await identityFor(seed, seed.ownerToken);
    const ownerDelete = await invoker.invokeMutation(
      mutationEnvelope("acme.Todo.delete", freshOperationId(seed.now), {
        record: { id, version: "1" },
      }),
      ownerIdentity,
    );
    assert.ok("error" in ownerDelete, "owner without the grant must be denied");
    assert.equal(ownerDelete.error.code, "forbidden");
    // The one committed create stands; every denial changed nothing.
    assert.equal((await todoRows(store)).length, 1);
    assert.equal(await store.readRevision(), revisionBefore + 1);
  });

  it("live store wins: removal after resolve denies the held identity", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", OPS_MODULE);
    const asm = stubAsm(dir, { "ops.mjs": url });
    const artifact = generatedArtifact("ops.mjs");
    const { store } = createTestMemoryStorage();
    const seed = await seedIdentity();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const held = await identityFor(seed, seed.memberToken);
    const first = await invoker.invokeMutation(
      mutationEnvelope("acme.Todo.create", freshOperationId(seed.now), { title: "before" }),
      held,
    );
    assert.ok("result" in first, `member admits first, got ${JSON.stringify(first)}`);
    const revisionAfterCommit = await store.readRevision();
    await seed.store.removeMembership(seed.memberMembershipId);
    // The SAME resolved identity object (claims still say member) now denies.
    const second = await invoker.invokeMutation(
      mutationEnvelope("acme.Todo.create", freshOperationId(seed.now), { title: "after" }),
      held,
    );
    assert.ok("error" in second, "removed member must be denied");
    assert.equal(second.error.code, "forbidden");
    assert.equal(await store.readRevision(), revisionAfterCommit);
    assert.equal((await todoRows(store)).length, 1);
  });

  it("forged credentials fail at resolution before anything invokes", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", OPS_MODULE);
    const asm = stubAsm(dir, { "ops.mjs": url });
    const artifact = generatedArtifact("ops.mjs");
    const { store } = createTestMemoryStorage();
    const seed = await seedIdentity();
    const error = await captureError(() =>
      resolveIdentity(seed.store, { session_token: "forged-token" }, { clock: { nowMs: () => seed.now } }),
    );
    assert.match(error.message, /Session expired or revoked/);
    void asm;
    void artifact;
    assert.equal(await store.readRevision(), 0);
    assert.equal((await todoRows(store)).length, 0);
  });
});

describe("T16b read-envelope closure (query port owns reads in T17)", () => {
  // T17b: the read-envelope refusal became a SERVING pin — generated
  // reads route onto `invokeReadCanonical` (the T16b refusal stub is
  // retired). What changed: `readViaRead` now serves projected
  // records (committing nothing) instead of refusing. Unchanged: the
  // mutation-envelope read-guard pin (/query port/ — engine behavior,
  // still enforced by `invoke`), and the envelope-mismatch pins
  // (/mutation envelope/, /Unknown operation/ — now served by
  // delegation to `invokeRead`, same codes and texts).
  it("serves reads and still rejects envelope mismatches with precise validation", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", OPS_MODULE);
    const asm = stubAsm(dir, { "ops.mjs": url });
    const artifact = generatedArtifact("ops.mjs");
    const { store } = createTestMemoryStorage();
    const seed = await seedIdentity();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const revisionBefore = await store.readRevision();
    // Read operation through the mutation envelope: the canonical read-guard rejects.
    const readViaMutation = await invoker.invokeMutation(
      mutationEnvelope("acme.Todo.read", freshOperationId(seed.now), {}),
      identity,
    );
    assert.ok("error" in readViaMutation, "read via invoke must reject");
    assert.equal(readViaMutation.error.code, "validation");
    assert.match(readViaMutation.error.message, /query port/);
    // One committed row, then the read envelope SERVES it (projected
    // records at the fence revision, committing nothing).
    const created = await invoker.invokeMutation(
      mutationEnvelope("acme.Todo.create", freshOperationId(seed.now), { title: "readable" }),
      identity,
    );
    assert.ok("result" in created, `want result, got ${JSON.stringify(created)}`);
    const id = ((created.result as MutationResult).result as { id: string }).id;
    const revisionAfterCommit = await store.readRevision();
    const readViaRead = await invoker.invokeRead({ operation: "acme.Todo.read", inputs: {} }, identity);
    assert.ok("result" in readViaRead, `want served reads, got ${JSON.stringify(readViaRead)}`);
    assert.deepEqual(readViaRead.result, {
      records: [
        {
          id,
          version: 1,
          created: seed.now,
          updated: seed.now,
          createdBy: seed.memberId,
          updatedBy: seed.memberId,
          archivedAt: null,
          parent: null,
          data: { title: "readable" },
        },
      ],
      revision: revisionAfterCommit,
    });
    assert.equal(await store.readRevision(), revisionAfterCommit);
    // Envelope mismatches still reject precisely (served by delegation
    // to `invokeRead`: same codes, same texts as the retired stub).
    const createViaRead = await invoker.invokeRead(
      { operation: "acme.Todo.create", inputs: { title: "x" } },
      identity,
    );
    assert.ok("error" in createViaRead, "mutation via read envelope must reject");
    assert.equal(createViaRead.error.code, "validation");
    assert.match(createViaRead.error.message, /mutation envelope/);
    const unknownViaRead = await invoker.invokeRead({ operation: "acme.Nope.missing", inputs: {} }, identity);
    assert.ok("error" in unknownViaRead, "unknown op via read envelope must reject");
    assert.equal(unknownViaRead.error.code, "validation");
    assert.match(unknownViaRead.error.message, /Unknown operation/);
    assert.equal(await store.readRevision(), revisionAfterCommit);
    assert.equal(revisionBefore, 0);
  });
});

describe("T16b committing scenario (guard fails loud, rejection replays)", () => {
  // T17b: message updated at both asserts below (was /T17 stdlib
  // migration/ — the migration LANDED, so the guard now names the
  // staged rule). Behavior unchanged: direct commits still trip the
  // guard, still receipt as rejections, still replay.
  it("receipts the guard trip as a rejection; domain state never mutates", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", COMMIT_MODULE);
    const asm = stubAsm(dir, { "ops.mjs": url });
    // Commit module serves only the scenario: descriptors trimmed to it.
    const artifact = generatedArtifact("ops.mjs", {
      operations: (shopOperations() as Array<Record<string, unknown>>).filter(
        (op) => op["name"] === "acme.Shop.restock",
      ),
      callables: (shopCallables("ops.mjs") as Array<Record<string, unknown>>).filter(
        (callable) => callable["id"] === "acme.Shop.restock",
      ),
    });
    const { store } = createTestMemoryStorage();
    const seed = await seedIdentity();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const operationId = freshOperationId(seed.now);
    const identity = await identityFor(seed, seed.memberToken);
    const envelope = mutationEnvelope("acme.Shop.restock", operationId, { sku: "s-9" });
    const revisionBefore = await store.readRevision();
    const first = await invoker.invokeMutation(envelope, identity);
    assert.ok("error" in first, "committing handler must fail");
    assert.equal(first.error.code, "rule_failed");
    assert.match(first.error.message, /stage through the stdlib data plane/);
    // Rejected receipt persisted (revision +1 for bookkeeping only);
    // the identical envelope replays the rejection without re-running.
    assert.equal(await store.readRevision(), revisionBefore + 1);
    assert.equal((await todoRows(store)).length, 0);
    const second = await invoker.invokeMutation(envelope, identity);
    assert.ok("error" in second, "rejection must replay");
    assert.equal(second.error.code, "rule_failed");
    assert.match(second.error.message, /stage through the stdlib data plane/);
    assert.equal(await store.readRevision(), revisionBefore + 1);
    const registry = (await import(url)) as { canApp(): { calls: unknown[] } };
    assert.equal(registry.canApp().calls.length, 1);
  });
});

describe("T16b policy refusal (untranscribable gates block the set)", () => {
  it("refuses gated/when manifests at preload and at the invoker", async () => {
    for (const [name, policy] of [
      ["gated", `{ "acme.Todo.create": { by: ["members"], gated: true } }`],
      ["when", `{ "acme.Todo.create": { by: ["members"], when: true } }`],
    ] as const) {
      const dir = tempDir();
      const url = writeModule(dir, "ops.mjs", policyModule(policy));
      const asm = stubAsm(dir, { "ops.mjs": url });
      const artifact = generatedArtifact("ops.mjs", {
        operations: (shopOperations() as Array<Record<string, unknown>>).filter(
          (op) => op["name"] === "acme.Todo.create",
        ),
        callables: (shopCallables("ops.mjs") as Array<Record<string, unknown>>).filter(
          (callable) => callable["id"] === "acme.Todo.create",
        ),
      });
      const { store } = createTestMemoryStorage();
      const seed = await seedIdentity();
      const preloadError = await captureError(() => loadCanonicalDescriptors(asm, artifact));
      assert.match(
        preloadError.message,
        /T04b carries generated policy/,
        `${name} manifest must refuse at preload`,
      );
      const invoker = buildInvoker(artifact, asm, store, {
        memberships: seed.store,
        now: () => seed.now,
      });
      const identity = await identityFor(seed, seed.memberToken);
      const outcome = await invoker.invokeMutation(
        mutationEnvelope("acme.Todo.create", freshOperationId(seed.now), { title: "x" }),
        identity,
      );
      assert.ok("error" in outcome, `${name} manifest must refuse at the invoker`);
      assert.equal(outcome.error.code, "rule_failed");
      assert.match(outcome.error.message, /T04b carries generated policy/);
      assert.equal(await store.readRevision(), 0);
      void url;
    }
  });

  it("refuses CRUD operations whose callable module is missing", async () => {
    const dir = tempDir();
    const asm = stubAsm(dir, {});
    const artifact = generatedArtifact("ops.mjs", {
      operations: (shopOperations() as Array<Record<string, unknown>>).filter(
        (op) => op["name"] === "acme.Todo.create",
      ),
      callables: (shopCallables("ops.mjs") as Array<Record<string, unknown>>).filter(
        (callable) => callable["id"] === "acme.Todo.create",
      ),
    });
    const error = await captureError(() => loadCanonicalDescriptors(asm, artifact));
    assert.match(error.message, /no assembled module URL/);
  });
});

describe("T16b no-bypass proof (generated implies canonical)", () => {
  it("generated artifacts never take the direct path (direct-only store fails LOUD)", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", OPS_MODULE);
    const asm = stubAsm(dir, { "ops.mjs": url });
    const artifact = generatedArtifact("ops.mjs");
    // The interim direct path never touches the store for pure
    // handlers — it would SUCCEED here. Canonical demands a real port.
    const directOnlyStore = { readRevision: async () => 0 } as unknown as StoragePort;
    const seed = await seedIdentity();
    const invoker = buildInvoker(artifact, asm, directOnlyStore, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.restock", freshOperationId(seed.now), { sku: "s-1" }),
      identity,
    );
    assert.ok("error" in outcome, "canonical must demand a real store");
    assert.equal(outcome.error.code, "rule_failed");
    assert.match(outcome.error.message, /needs a StoragePort/);
  });

  it("generated artifacts without memberships refuse instead of admitting blind", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", OPS_MODULE);
    const asm = stubAsm(dir, { "ops.mjs": url });
    const artifact = generatedArtifact("ops.mjs");
    const { store } = createTestMemoryStorage();
    const seed = await seedIdentity();
    const invoker = buildInvoker(artifact, asm, store, { now: () => seed.now });
    const identity = await identityFor(seed, seed.memberToken);
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Todo.create", freshOperationId(seed.now), { title: "x" }),
      identity,
    );
    assert.ok("error" in outcome, "canonical must demand live membership");
    assert.equal(outcome.error.code, "rule_failed");
    assert.match(outcome.error.message, /needs a MembershipReader/);
  });

  // T17b: the byte-identity pin became a REFUSAL pin — the interim
  // direct path is retired, so descriptor-less artifacts refuse on
  // both envelopes (nothing served, staged, or committed) instead of
  // serving raw handler values. What changed and why: no descriptors
  // means no admission registry, and synthesizing descriptors would
  // invent gates — see the T17b release report. The `directOnlyStore`
  // stays (the refusal path never touches the store at all).
  it("descriptor-less artifacts refuse on both envelopes (interim path retired)", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", LEGACY_MODULE);
    const asm = stubAsm(dir, { "ops.mjs": url });
    const artifact = legacyArtifact("ops.mjs");
    const directOnlyStore = { readRevision: async () => 0 } as unknown as StoragePort;
    const seed = await seedIdentity();
    const invoker = buildInvoker(artifact, asm, directOnlyStore);
    const operationId = freshOperationId(seed.now);
    const identity = await identityFor(seed, seed.memberToken);
    const mutation = await invoker.invokeMutation(
      mutationEnvelope("fixture.echo", operationId, {}),
      identity,
    );
    assert.ok("error" in mutation, "descriptor-less mutation must refuse");
    assert.equal(mutation.error.code, "validation");
    assert.match(mutation.error.message, /descriptor-less artifacts were retired in T17/);
    assert.equal(mutation.error.operation_id, operationId);
    const read = await invoker.invokeRead({ operation: "fixture.echo", inputs: {} }, identity);
    assert.ok("error" in read, "descriptor-less read must refuse");
    assert.equal(read.error.code, "validation");
    assert.match(read.error.message, /descriptor-less artifacts were retired in T17/);
    void url;
  });
});

describe("T16b assembly gates (pins + requires + preload)", () => {
  it("serves generated artifacts with realistic requires (builtins 2 + state 1)", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", OPS_MODULE);
    const asm = stubAsm(dir, { "ops.mjs": url });
    const artifact = generatedArtifact("ops.mjs");
    const { store } = createTestMemoryStorage();
    const seed = await seedIdentity();
    const deps: AssemblyDeps = { store, identityStore: seed.store, now: () => seed.now };
    const assembled = await assembleWorker(artifact, asm, deps, { active: true });
    assert.equal(assembled.pageCount, 0);
    assert.equal(assembled.opCount, 4);
    void url;
  });

  it("rejects unknown requires capabilities at compat", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", OPS_MODULE);
    const asm = stubAsm(dir, { "ops.mjs": url });
    const artifact = generatedArtifact("ops.mjs", {
      requires: [{ capability: "teleport.v1", min_version: 1 }],
    });
    const { store } = createTestMemoryStorage();
    const seed = await seedIdentity();
    const deps: AssemblyDeps = { store, identityStore: seed.store, now: () => seed.now };
    const error = await captureError(() => assembleWorker(artifact, asm, deps, { active: true }));
    assert.match(error.message, /requires unknown capability "teleport\.v1"/);
  });

  it("rejects unmet requires versions at the serving-contracts gate", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", OPS_MODULE);
    const asm = stubAsm(dir, { "ops.mjs": url });
    const artifact = generatedArtifact("ops.mjs", {
      requires: [{ capability: "values.decimal", min_version: 2 }],
    });
    const { store } = createTestMemoryStorage();
    const seed = await seedIdentity();
    const deps: AssemblyDeps = { store, identityStore: seed.store, now: () => seed.now };
    const error = await captureError(() => assembleWorker(artifact, asm, deps, { active: true }));
    assert.match(error.message, /provides v1 — refusing to serve/);
  });

  it("refuses incompatible descriptors at preload, before serving", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", OPS_MODULE);
    const asm = stubAsm(dir, { "ops.mjs": url });
    const broken = (shopOperations() as Array<Record<string, unknown>>).map((op) => ({ ...op }));
    const first = broken[0];
    assert.ok(first !== undefined);
    first["kind"] = "teleport";
    const artifact = generatedArtifact("ops.mjs", { operations: broken });
    const { store } = createTestMemoryStorage();
    const seed = await seedIdentity();
    const deps: AssemblyDeps = { store, identityStore: seed.store, now: () => seed.now };
    const error = await captureError(() => assembleWorker(artifact, asm, deps, { active: true }));
    assert.match(error.message, /Unknown operation kind "teleport"/);
  });
});





