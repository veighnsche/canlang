/**
 * T17b cloudflare-side flip tests (colocated): the migrated L7 data
 * plane end to end through the canonical engine.
 *
 * Scenario handlers stage stdlib writes through the pipeline into the
 * scenario effects (ONE atomic fenced commit with the scenario
 * receipt + history) and serve `records()` through `invokeRead` over
 * the staged overlay; assembly reads serve through
 * `invokeReadCanonical`; descriptor-less artifacts refuse; the direct
 * paths, the router interim branch, and `INTERIM_DDL` are retired.
 * Durable-substrate proofs live in `t17b-durable.test.ts`; restarts
 * are explicitly UNCLAIMED in this slice (ephemeral harnesses).
 *
 * Fixture handlers import the COMPILED stdlib relatively
 * (`../stdlib.js` from the fixture dir): fixtures are staged under
 * the compiled test's own directory, mirroring how the real worker
 * assembles sibling modules relatively (`modules.ts` precedent). The
 * compiled stdlib carries no runtime imports (type-only contracts
 * imports erase), so the fixture graph resolves with zero vendor
 * surface. Run from dist: root build, then
 * `node --test dist/runtime/t17b-cloudflare-flip.test.js`.
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
  RecordVersion,
  ResolvedIdentity,
  Revision,
  StoragePort,
  StoredRow,
} from "@canlang/contracts";
import { resolveIdentity, sha256HexText } from "@canlang/identity";
import { createFrozenClock, createMemoryIdentityStore } from "@canlang/identity/testing";
import { createTestMemoryStorage } from "../../../state/dist/state/src/storage/memory.js";
import { buildInvoker } from "../worker/assembly.js";
import type { AssembledModules } from "../worker/assembly.js";
import {
  collapseStagedWrites,
  loadCanonicalDescriptors,
  mapReadRulesToPolicy,
  netStagedUniques,
  readModelPolicyEntry,
  withStagedOverlay,
} from "./invoke.js";
import { createContext } from "./context.js";
import { create, deleteRecord, records, set } from "./stdlib.js";

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
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = mkdtempSync(join(here, "t17b-fix-"));
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
  readonly outsiderId: string;
  readonly memberMembershipId: string;
  readonly ownerToken: string;
  readonly memberToken: string;
  readonly outsiderToken: string;
}

/** One team: owner, plain member, outsider (each with a session token). */
async function seedIdentity(): Promise<SeededIdentity> {
  const now = Date.now();
  const clock = createFrozenClock(now);
  const store = createMemoryIdentityStore({ clock });
  const iso = (ms: number): string => new Date(ms).toISOString();
  const team = await store.createTeam({});
  const owner = await store.createUser({
    email: "owner@t17b.test",
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
    email: "member@t17b.test",
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
    email: "outsider@t17b.test",
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
  const memberToken = `member-token-${randomBytes(8).toString("hex")}`;
  const outsiderToken = `outsider-token-${randomBytes(8).toString("hex")}`;
  await sessionFor(owner.user_id, ownerToken);
  await sessionFor(member.user_id, memberToken);
  await sessionFor(outsider.user_id, outsiderToken);
  return {
    now,
    store,
    teamId: team.team_id,
    ownerId: owner.user_id,
    memberId: member.user_id,
    outsiderId: outsider.user_id,
    memberMembershipId: memberMembership.membership_id,
    ownerToken,
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

async function captureError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof Error, `want Error, got ${String(error)}`);
    return error;
  }
  assert.fail("expected a throw");
}

async function modelRows(store: StoragePort, model: string): Promise<StoredRow[]> {
  return [...(await store.query({ model: model as ModelName, authority: "owner" }))];
}

/* ------------------------------------------------------------------ */
/* T17b artifact: Todo (remove) + Memo (archive) + Sku (uniques) +      */
/* Sealed (ruled reads) + Keep (delete=none), Todo CRUD, four reads,    */
/* and the scenario handlers below (each exercises one stdlib path).    */
/* ------------------------------------------------------------------ */

function strInput(name: string, required: boolean): unknown {
  return { name, field: { kind: "string" }, required };
}

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

function memoModel(): unknown {
  return {
    name: "acme.Memo",
    fields: [{ name: "title", required: true, serverOnly: false, field: { kind: "string" } }],
    deleteMode: "archive",
  };
}

function skuModel(): unknown {
  return {
    name: "acme.Sku",
    fields: [
      { name: "code", required: true, serverOnly: false, field: { kind: "string" } },
      {
        name: "stock",
        required: false,
        serverOnly: false,
        field: { kind: "integer" },
        default: { kind: "literal", value: "0" },
      },
    ],
    deleteMode: "remove",
    uniqueKeys: ["code"],
  };
}

function sealedModel(): unknown {
  return {
    name: "acme.Sealed",
    fields: [{ name: "title", required: true, serverOnly: false, field: { kind: "string" } }],
    deleteMode: "remove",
  };
}

function keepModel(): unknown {
  return {
    name: "acme.Keep",
    fields: [{ name: "title", required: true, serverOnly: false, field: { kind: "string" } }],
    deleteMode: "none",
  };
}

const SCENARIOS: ReadonlyArray<{ op: string; fn: string; inputs: unknown[] }> = [
  { op: "acme.Shop.place", fn: "place", inputs: [strInput("key", true), strInput("title", true)] },
  { op: "acme.Shop.memoCycle", fn: "memoCycle", inputs: [strInput("key", true), strInput("title", true)] },
  { op: "acme.Shop.todoRemove", fn: "todoRemove", inputs: [strInput("key", true)] },
  { op: "acme.Shop.redelete", fn: "redelete", inputs: [strInput("key", true)] },
  { op: "acme.Shop.filteredRead", fn: "filteredRead", inputs: [strInput("mode", true)] },
  { op: "acme.Shop.passThrough", fn: "passThrough", inputs: [] },
  { op: "acme.Shop.sealedPeek", fn: "sealedPeek", inputs: [] },
  { op: "acme.Shop.sealOne", fn: "sealOne", inputs: [strInput("key", true)] },
  { op: "acme.Shop.mixedCommit", fn: "mixedCommit", inputs: [strInput("key", true)] },
  { op: "acme.Shop.explode", fn: "explode", inputs: [strInput("key", true)] },
  { op: "acme.Shop.noopPatch", fn: "noopPatch", inputs: [strInput("key", true)] },
  { op: "acme.Shop.uniqueCycle", fn: "uniqueCycle", inputs: [strInput("key", true), strInput("code", true)] },
  { op: "acme.Shop.uniqueDupe", fn: "uniqueDupe", inputs: [strInput("a", true), strInput("b", true), strInput("code", true)] },
  { op: "acme.Shop.makeSku", fn: "makeSku", inputs: [strInput("key", true), strInput("code", true)] },
  { op: "acme.Shop.keepDelete", fn: "keepDelete", inputs: [strInput("key", true)] },
  { op: "acme.Shop.linkOk", fn: "linkOk", inputs: [strInput("parent", true), strInput("child", true)] },
  { op: "acme.Shop.linkGhost", fn: "linkGhost", inputs: [strInput("child", true), strInput("ghost", true)] },
  { op: "acme.Shop.setRace", fn: "setRace", inputs: [strInput("key", true), strInput("title", true)] },
];

function shopOperations(): unknown[] {
  const ops: unknown[] = [
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
  ];
  for (const model of ["acme.Todo", "acme.Memo", "acme.Sku", "acme.Sealed"]) {
    ops.push({ name: `${model}.read`, kind: "read", description: "", inputs: { fields: [] } });
  }
  for (const scenario of SCENARIOS) {
    ops.push({
      name: scenario.op,
      kind: "scenario",
      description: "",
      // Fresh inputs per artifact (the descriptors are JSON-safe): no
      // shared mutable structure across loads.
      inputs: { fields: JSON.parse(JSON.stringify(scenario.inputs)) as unknown[] },
    });
  }
  return ops;
}

function shopCallables(module: string): unknown[] {
  const callables: unknown[] = [
    { id: "acme.Todo.create", kind: "operation", module, export: "Todo_create", member: ["Todo", "create"] },
    { id: "acme.Todo.update", kind: "operation", module, export: "Todo_update", member: ["Todo", "update"] },
    { id: "acme.Todo.delete", kind: "operation", module, export: "Todo_delete", member: ["Todo", "delete"] },
  ];
  for (const scenario of SCENARIOS) {
    callables.push({
      id: scenario.op,
      kind: "operation",
      module,
      export: `Shop_${scenario.fn}`,
      member: ["Shop", scenario.fn],
    });
  }
  return callables;
}

/** Hand-written T15a-shaped artifact (NOT compiler output): descriptors + callables + requires. */
function shopArtifact(module: string, overrides: Record<string, unknown> = {}): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "t17b-fixture/0 (hand-written T15a shape; NOT compiler output)",
    tool_version: "t17b-fixture/0",
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
    models: [todoModel(), memoModel(), skuModel(), sealedModel(), keepModel()],
    ...overrides,
  } as unknown as CompileArtifact;
}

const SHOP_POLICY_JSON = JSON.stringify({
  operations: {
    "acme.Todo.create": { by: ["members"] },
    "acme.Todo.update": { by: ["owner"] },
    "acme.Todo.delete": { by: ["acme.Clerk"] },
  },
  models: {
    "acme.Sealed": { read: ["Sealed.read.1"] },
  },
});

function shopModuleSource(policyJson: string): string {
  return `import { create, set, deleteRecord, records } from "../stdlib.js";
const calls = [];
const throwing = () => { throw new Error("t17b-proof: CRUD handler must never run on the canonical path"); };
export function canApp() {
  return {
    calls,
    policy: ${policyJson},
    Todo: { create: throwing, update: throwing, delete: throwing },
    Shop: {
      place: async (c, input) => {
        calls.push("place");
        const row = await create(c, "acme.Todo", { id: input.inputs.key, data: { title: input.inputs.title } });
        const updated = await set(c, "acme.Todo", row.id, { done: true });
        const seen = await records(c, "acme.Todo");
        return {
          id: updated.id,
          version: updated.version,
          seen: seen.map((r) => ({ title: r.data.title, done: r.data.done })),
        };
      },
      memoCycle: async (c, input) => {
        await create(c, "acme.Memo", { id: input.inputs.key, data: { title: input.inputs.title } });
        await deleteRecord(c, "acme.Memo", input.inputs.key);
        const seen = await records(c, "acme.Memo");
        const stored = await c.store.load("acme.Memo", input.inputs.key);
        return { visible: seen.length, archivedAt: stored === null ? null : stored.archivedAt };
      },
      todoRemove: async (c, input) => {
        await create(c, "acme.Todo", { id: input.inputs.key, data: { title: "gone" } });
        await deleteRecord(c, "acme.Todo", input.inputs.key);
        const seen = await records(c, "acme.Todo");
        const stored = await c.store.load("acme.Todo", input.inputs.key);
        return { visible: seen.length, stored: stored === null ? null : stored.id };
      },
      redelete: async (c, input) => {
        await create(c, "acme.Memo", { id: input.inputs.key, data: { title: "twice" } });
        await deleteRecord(c, "acme.Memo", input.inputs.key);
        await deleteRecord(c, "acme.Memo", input.inputs.key);
        return { never: true };
      },
      filteredRead: async (c, input) => {
        const mode = input.inputs.mode;
        if (mode === "where") await records(c, "acme.Todo", { where: { op: "eq", field: "title", value: "x" } });
        else if (mode === "order") await records(c, "acme.Todo", { order: [{ field: "created", direction: "asc" }] });
        else if (mode === "limit") await records(c, "acme.Todo", { limit: 1 });
        else if (mode === "archived") await records(c, "acme.Todo", { archived: "include" });
        else await records(c, "acme.Todo", { authority: "owner" });
        return { never: true };
      },
      passThrough: async (c) => {
        await records(c, "acme.Todo", { where: { op: "eq", field: "title", value: "x" } });
        return { never: true };
      },
      sealedPeek: async (c) => {
        await records(c, "acme.Sealed");
        return { never: true };
      },
      sealOne: async (c, input) => {
        const row = await create(c, "acme.Sealed", { id: input.inputs.key, data: { title: "sealed" } });
        return { id: row.id };
      },
      mixedCommit: async (c, input) => {
        await create(c, "acme.Todo", { id: input.inputs.key, data: { title: "mixed" } });
        await c.store.commit({ expectedRevision: 0, writes: [], history: [], receipt: null, outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [] });
        return { never: true };
      },
      explode: async (c, input) => {
        await create(c, "acme.Todo", { id: input.inputs.key, data: { title: "doomed" } });
        throw new Error("boom-after-stage");
      },
      noopPatch: async (c, input) => {
        await create(c, "acme.Todo", { id: input.inputs.key, data: { title: "steady" } });
        const updated = await set(c, "acme.Todo", input.inputs.key, {});
        return { version: updated.version, data: updated.data };
      },
      uniqueCycle: async (c, input) => {
        await create(c, "acme.Sku", { id: input.inputs.key, data: { code: input.inputs.code } });
        await deleteRecord(c, "acme.Sku", input.inputs.key);
        return { ok: true };
      },
      uniqueDupe: async (c, input) => {
        await create(c, "acme.Sku", { id: input.inputs.a, data: { code: input.inputs.code } });
        await create(c, "acme.Sku", { id: input.inputs.b, data: { code: input.inputs.code } });
        return { never: true };
      },
      makeSku: async (c, input) => {
        const row = await create(c, "acme.Sku", { id: input.inputs.key, data: { code: input.inputs.code } });
        return { id: row.id, data: row.data };
      },
      keepDelete: async (c, input) => {
        await create(c, "acme.Keep", { id: input.inputs.key, data: { title: "kept" } });
        await deleteRecord(c, "acme.Keep", input.inputs.key);
        return { never: true };
      },
      linkOk: async (c, input) => {
        await create(c, "acme.Todo", { id: input.inputs.parent, data: { title: "parent" } });
        const child = await create(c, "acme.Todo", { id: input.inputs.child, data: { title: "child" }, parent: { model: "acme.Todo", id: input.inputs.parent } });
        return { parent: child.parent };
      },
      linkGhost: async (c, input) => {
        await create(c, "acme.Todo", { id: input.inputs.child, data: { title: "orphan" }, parent: { model: "acme.Todo", id: input.inputs.ghost } });
        return { never: true };
      },
      setRace: async (c, input) => {
        const updated = await set(c, "acme.Todo", input.inputs.key, { title: input.inputs.title });
        return { version: updated.version };
      }
    }
  };
}
`;
}

describe("T17b read-policy transcription (PolicyTable grants)", () => {
  it("transcribes absent/empty read content to public grants; rules mark ruled; malformed throws", () => {
    const fields = ["title", "done"];
    assert.deepEqual(mapReadRulesToPolicy("acme.Todo", undefined, fields), {
      ruled: false,
      input: { model: "acme.Todo", secretFields: [], grants: [{ by: "public", fields }] },
    });
    assert.deepEqual(mapReadRulesToPolicy("acme.Todo", null, fields).ruled, false);
    // Invariants/locks-only entries carry no read content: servable.
    assert.deepEqual(
      mapReadRulesToPolicy("acme.Todo", { invariants: ["Todo.require.1"] }, fields).ruled,
      false,
    );
    assert.deepEqual(mapReadRulesToPolicy("acme.Todo", { read: [] }, fields).ruled, false);
    // Well-formed rules: ruled, no table input (serve-time refusal, never served).
    assert.deepEqual(mapReadRulesToPolicy("acme.Todo", { read: ["Todo.read.1"] }, fields), {
      ruled: true,
      input: null,
    });
    for (const entry of [
      { read: ["Todo.read.1", "Todo.read.2"], locks: ["Todo.lock.1"] },
      "read-Todo",
    ]) {
      const transcribed =
        typeof entry === "string"
          ? assert.throws(
              () => mapReadRulesToPolicy("acme.Todo", entry, fields),
              /malformed policy entry/,
            )
          : mapReadRulesToPolicy("acme.Todo", entry, fields);
      if (typeof entry !== "string") {
        assert.deepEqual(transcribed, { ruled: true, input: null });
      }
    }
    for (const entry of [
      { read: "Todo.read.1" },
      { read: [""] },
      { read: [7] },
      { by: ["members"] },
      { read: ["Todo.read.1"], audit: true },
    ]) {
      assert.throws(
        () => mapReadRulesToPolicy("acme.Todo", entry, fields),
        /malformed read rules|unknown policy member/,
      );
    }
    assert.throws(
      () => mapReadRulesToPolicy("acme.Todo", { read: ["Todo.read.1"], audit: true }, fields),
      /T04b carries generated policy/,
    );
  });

  it("reads model manifest entries defensively; malformed shapes fail loud", () => {
    assert.equal(readModelPolicyEntry({}, "acme.Todo"), undefined);
    assert.equal(readModelPolicyEntry({ policy: null }, "acme.Todo"), undefined);
    assert.equal(readModelPolicyEntry({ policy: { models: {} } }, "acme.Todo"), undefined);
    assert.deepEqual(
      readModelPolicyEntry({ policy: { models: { "acme.Todo": { read: ["Todo.read.1"] } } } }, "acme.Todo"),
      { read: ["Todo.read.1"] },
    );
    assert.throws(() => readModelPolicyEntry(null, "acme.Todo"), /not an object/);
    assert.throws(() => readModelPolicyEntry({ policy: 7 }, "acme.Todo"), /not an object/);
    assert.throws(
      () => readModelPolicyEntry({ policy: { models: [] } }, "acme.Todo"),
      /not an object/,
    );
  });
});

describe("T17b staged uniques netting (per key, call order)", () => {
  const touch = (kind: "claim" | "release", keyValue: string, recordId = "r1") => ({
    kind,
    touch: { model: "acme.Sku", keyName: "code", keyValue, ...(kind === "claim" ? { recordId } : {}) },
  });

  it("nets create+remove to a bare release and keeps remove+recreate whole", () => {
    // create+remove one id: the claim dies (no ghost), the release stays (no-op free).
    assert.deepEqual(netStagedUniques([touch("claim", "K-1"), touch("release", "K-1")]), {
      claims: [],
      releases: [{ model: "acme.Sku", keyName: "code", keyValue: "K-1" }],
    });
    // remove+recreate: free then retake — both survive.
    const recreated = netStagedUniques([touch("release", "K-2"), touch("claim", "K-2")]);
    assert.equal(recreated.claims.length, 1);
    assert.equal(recreated.releases.length, 1);
    // Key move X->Y: both pairs survive (release X + claim Y).
    const moved = netStagedUniques([touch("release", "X"), touch("claim", "Y")]);
    assert.equal(moved.claims.length, 1);
    assert.equal(moved.releases.length, 1);
    // Competing live claims both survive to conflict honestly at commit.
    const dupe = netStagedUniques([touch("claim", "K-3", "a"), touch("claim", "K-3", "b")]);
    assert.equal(dupe.claims.length, 2);
    assert.equal(dupe.releases.length, 0);
  });
});

describe("T17b staged write collapse (one net write per row)", () => {
  const row = (id: string, version: number): StoredRow =>
    ({
      id: id as RecordId,
      version: version as RecordVersion,
      created: 100,
      updated: 200,
      createdBy: "u1",
      updatedBy: "u1",
      archivedAt: null,
      data: { title: id },
    }) as StoredRow;

  it("folds multi-touch sequences to the committable net shape", () => {
    // insert+update: one insert of the final row.
    assert.deepEqual(
      collapseStagedWrites([
        { kind: "insert", model: "acme.Todo", row: row("t1", 1) },
        { kind: "update", model: "acme.Todo", id: "t1", expectedVersion: 1, row: row("t1", 2) },
      ]),
      [{ kind: "insert", model: "acme.Todo", row: row("t1", 2) }],
    );
    // update+update: one update on the FIRST basis with the final row.
    assert.deepEqual(
      collapseStagedWrites([
        { kind: "update", model: "acme.Todo", id: "t1", expectedVersion: 7, row: row("t1", 8) },
        { kind: "update", model: "acme.Todo", id: "t1", expectedVersion: 8, row: row("t1", 9) },
      ]),
      [{ kind: "update", model: "acme.Todo", id: "t1", expectedVersion: 7, row: row("t1", 9) }],
    );
    // insert+remove: net nothing (created and removed in-scenario).
    assert.deepEqual(
      collapseStagedWrites([
        { kind: "insert", model: "acme.Todo", row: row("t1", 1) },
        { kind: "remove", model: "acme.Todo", id: "t1", expectedVersion: 1 },
      ]),
      [],
    );
    // update+remove: one remove on the first basis.
    assert.deepEqual(
      collapseStagedWrites([
        { kind: "update", model: "acme.Todo", id: "t1", expectedVersion: 7, row: row("t1", 8) },
        { kind: "remove", model: "acme.Todo", id: "t1", expectedVersion: 8 },
      ]),
      [{ kind: "remove", model: "acme.Todo", id: "t1", expectedVersion: 7 }],
    );
    // remove+recreate: the one legal pair (remove on basis + insert final).
    assert.deepEqual(
      collapseStagedWrites([
        { kind: "remove", model: "acme.Todo", id: "t1", expectedVersion: 7 },
        { kind: "insert", model: "acme.Todo", row: row("t1", 1) },
        { kind: "update", model: "acme.Todo", id: "t1", expectedVersion: 1, row: row("t1", 2) },
      ]),
      [
        { kind: "remove", model: "acme.Todo", id: "t1", expectedVersion: 7 },
        { kind: "insert", model: "acme.Todo", row: row("t1", 2) },
      ],
    );
    // Distinct rows fold independently, in first-touch order.
    assert.deepEqual(
      collapseStagedWrites([
        { kind: "insert", model: "acme.Todo", row: row("a", 1) },
        { kind: "insert", model: "acme.Todo", row: row("b", 1) },
        { kind: "update", model: "acme.Todo", id: "a", expectedVersion: 1, row: row("a", 2) },
      ]).map((write) => [write.kind, write.kind === "insert" ? write.row?.id : write.id]),
      [
        ["insert", "a"],
        ["insert", "b"],
      ],
    );
  });
});

describe("T17b staged overlay (staged wins, removes mask, read-only)", () => {
  it("merges staged rows over the store and refuses filtered fetches + commits", async () => {
    const { store } = createTestMemoryStorage();
    await store.commit({
      expectedRevision: 0 as Revision,
      writes: [
        {
          kind: "insert",
          model: "acme.Todo" as ModelName,
          row: {
            id: "base" as RecordId,
            version: 1 as RecordVersion,
            created: 100,
            updated: 100,
            createdBy: "seed",
            updatedBy: "seed",
            archivedAt: null,
            data: { title: "base" },
          } as StoredRow,
        },
      ],
      history: [],
      receipt: null,
      outbox: [],
      schedules: [],
      uniqueClaims: [],
      uniqueReleases: [],
    });
    const stagedRow = {
      id: "fresh" as RecordId,
      version: 1 as RecordVersion,
      created: 200,
      updated: 200,
      createdBy: "u1",
      updatedBy: "u1",
      archivedAt: null,
      data: { title: "fresh" },
    } as StoredRow;
    const stagedUpdate = {
      ...(await store.load("acme.Todo" as ModelName, "base" as RecordId)) as StoredRow,
      version: 2 as RecordVersion,
      data: { title: "edited" },
    };
    const stagedArchived = {
      id: "old" as RecordId,
      version: 2 as RecordVersion,
      created: 100,
      updated: 200,
      createdBy: "seed",
      updatedBy: "u1",
      archivedAt: 200,
      data: { title: "old" },
    } as StoredRow;
    const staged = new Map<string, StoredRow | null>([
      ["acme.Todo\0fresh", stagedRow],
      ["acme.Todo\0base", stagedUpdate],
      ["acme.Todo\0old", stagedArchived],
      ["acme.Todo\0gone", null],
      ["acme.Other\0fresh", stagedRow],
    ]);
    const overlay = withStagedOverlay(store, staged);
    assert.equal(await overlay.readRevision(), 1);
    // load: staged wins, staged removes mask, unstaged falls through.
    assert.deepEqual(await overlay.load("acme.Todo" as ModelName, "fresh" as RecordId), stagedRow);
    assert.equal((await overlay.load("acme.Todo" as ModelName, "base" as RecordId))?.version, 2);
    assert.equal(await overlay.load("acme.Todo" as ModelName, "gone" as RecordId), null);
    // query: inserts appear, updates replace, staged-archived excluded by default.
    const exclude = await overlay.query({ model: "acme.Todo" as ModelName, authority: "owner" });
    assert.deepEqual(
      exclude.map((row) => row.id as string).sort(),
      ["base", "fresh"],
    );
    const include = await overlay.query({
      model: "acme.Todo" as ModelName,
      authority: "owner",
      archived: "include",
    });
    assert.deepEqual(
      include.map((row) => row.id as string).sort(),
      ["base", "fresh", "old"],
    );
    // Other-model staged rows never leak across (the overlay serves
    // staged rows under their own ids, as production always stages).
    const other = await overlay.query({ model: "acme.Other" as ModelName, authority: "owner" });
    assert.deepEqual(
      other.map((row) => row.id as string),
      ["fresh"],
    );
    // Filtered fetches and commits refuse loud.
    await assert.rejects(
      () =>
        overlay.query({
          model: "acme.Todo" as ModelName,
          authority: "owner",
          where: { op: "eq", field: "title", value: "x" },
        }),
      /cannot serve filtered fetches/,
    );
    await assert.rejects(
      () => overlay.query({ model: "acme.Todo" as ModelName, authority: "owner", limit: 1 }),
      /cannot serve filtered fetches/,
    );
    await assert.rejects(
      async () =>
        overlay.commit({
          expectedRevision: 1 as Revision,
          writes: [],
          history: [],
          receipt: null,
          outbox: [],
          schedules: [],
          uniqueClaims: [],
          uniqueReleases: [],
        }),
      /overlay is read-only/,
    );
  });
});

describe("T17b retired direct paths (no scope fails loud)", () => {
  it("every data-plane call without a canonical scope throws naming the retirement", async () => {
    const { store } = createTestMemoryStorage();
    const c = createContext({ caller: { userId: "u1", roles: [] }, store });
    await assert.rejects(create(c, "acme.Todo", { id: "t1", data: {} }), /canonical execution scope/);
    await assert.rejects(set(c, "acme.Todo", "t1", {}), /canonical execution scope/);
    await assert.rejects(deleteRecord(c, "acme.Todo", "t1"), /canonical execution scope/);
    await assert.rejects(records(c, "acme.Todo"), /canonical execution scope/);
    assert.equal(await store.readRevision(), 0);
  });
});

async function shopSetup(policyJson: string = SHOP_POLICY_JSON): Promise<{
  dir: string;
  url: string;
  asm: AssembledModules;
  artifact: CompileArtifact;
  store: StoragePort;
  seed: SeededIdentity;
}> {
  const dir = tempDir();
  const url = writeModule(dir, "ops.mjs", shopModuleSource(policyJson));
  const asm = stubAsm(dir, { "ops.mjs": url });
  const artifact = shopArtifact("ops.mjs");
  const { store } = createTestMemoryStorage();
  const seed = await seedIdentity();
  return { dir, url, asm, artifact, store, seed };
}

describe("T17b scenario staging (one atomic commit with receipt + history)", () => {
  it("stages create+set through the pipeline; reads see staged rows; receipt + history carry the scenario identity", async () => {
    const { url, asm, artifact, store, seed } = await shopSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const operationId = freshOperationId(seed.now);
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.place", operationId, { key: "t-1", title: "staged" }),
      identity,
    );
    assert.ok("result" in outcome, `want result, got ${JSON.stringify(outcome)}`);
    const committed = outcome.result as MutationResult;
    assert.equal(committed.status, "committed");
    assert.deepEqual(committed.result, {
      id: "t-1",
      version: 2,
      seen: [{ title: "staged", done: true }],
    });
    // Receipt persisted under the SCENARIO identity (operation + id), defaults empty.
    const receipt = await store.readReceipt({
      app: "TeamTasks",
      owner: seed.teamId,
      principal: seed.memberId,
      operation: "acme.Shop.place" as OperationName,
      operationId: operationId as OperationId,
    });
    assert.ok(receipt !== null, "scenario receipt must be persisted");
    assert.equal(receipt?.outcome.status, "committed");
    assert.deepEqual(receipt?.resolvedDefaults, {});
    // History reproduces the staged trail with the scenario identity + admitted actor.
    const trail = await store.historyFor("acme.Todo" as ModelName, "t-1" as RecordId);
    assert.deepEqual(
      trail.map((entry) => [entry.change, entry.version, entry.operationId]),
      [
        ["create", 1, operationId],
        ["update", 2, operationId],
      ],
    );
    for (const entry of trail) {
      assert.equal(entry.operation, "acme.Shop.place");
      assert.equal(entry.actor, seed.memberId);
      assert.equal(entry.at, seed.now);
    }
    assert.deepEqual(trail[0]?.before, null);
    assert.deepEqual(trail[1]?.after, { title: "staged", done: true });
    // Stored row: merged data, admitted attribution, one revision for the whole scenario.
    const row = await store.load("acme.Todo" as ModelName, "t-1" as RecordId);
    assert.equal(row?.version, 2);
    assert.deepEqual(row?.data, { title: "staged", done: true });
    assert.equal(row?.createdBy, seed.memberId);
    assert.equal(await store.readRevision(), 1);
    const registry = (await import(url)) as { canApp(): { calls: unknown[] } };
    assert.equal(registry.canApp().calls.length, 1);
  });

  it("honors archive vs remove delete modes and excludes staged archives from reads", async () => {
    const { asm, artifact, store, seed } = await shopSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const archived = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.memoCycle", freshOperationId(seed.now), { key: "m-1", title: "keep" }),
      identity,
    );
    assert.ok("result" in archived, `want result, got ${JSON.stringify(archived)}`);
    assert.deepEqual((archived.result as MutationResult).result, {
      visible: 0,
      archivedAt: seed.now,
    });
    const memoTrail = await store.historyFor("acme.Memo" as ModelName, "m-1" as RecordId);
    assert.deepEqual(
      memoTrail.map((entry) => entry.change),
      ["create", "archive"],
    );
    const removed = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.todoRemove", freshOperationId(seed.now), { key: "t-gone" }),
      identity,
    );
    assert.ok("result" in removed, `want result, got ${JSON.stringify(removed)}`);
    assert.deepEqual((removed.result as MutationResult).result, { visible: 0, stored: null });
    assert.equal(await store.load("acme.Todo" as ModelName, "t-gone" as RecordId), null);
    const todoTrail = await store.historyFor("acme.Todo" as ModelName, "t-gone" as RecordId);
    assert.deepEqual(
      todoTrail.map((entry) => entry.change),
      ["create", "remove"],
    );
  });

  it("rejects re-archiving with the B1 admission-parity verdict; staged writes roll back to a receipt-only revision", async () => {
    const { asm, artifact, store, seed } = await shopSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const operationId = freshOperationId(seed.now);
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.redelete", operationId, { key: "m-2" }),
      identity,
    );
    assert.ok("error" in outcome, "re-archive must fail");
    assert.equal(outcome.error.code, "validation");
    // B1: gated callers (the scenario seam passes gateArchivedTargets)
    // report admission's verdict RATHER THAN the archive-mode engine
    // verdict (pipeline.ts, "rather than ... `already archived`").
    assert.equal(outcome.error.message, "Archived records cannot be used here.");
    // Bookkeeping only: revision +1 for the rejected receipt; no rows, no history.
    assert.equal(await store.readRevision(), 1);
    assert.equal((await modelRows(store, "acme.Memo")).length, 0);
    assert.deepEqual(await store.historyFor("acme.Memo" as ModelName, "m-2" as RecordId), []);
    const receipt = await store.readReceipt({
      app: "TeamTasks",
      owner: seed.teamId,
      principal: seed.memberId,
      operation: "acme.Shop.redelete" as OperationName,
      operationId: operationId as OperationId,
    });
    assert.equal(receipt?.outcome.status, "rejected");
  });

  it("refuses delete=none models with the engine message and persists nothing", async () => {
    const { asm, artifact, store, seed } = await shopSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.keepDelete", freshOperationId(seed.now), { key: "k-1" }),
      identity,
    );
    assert.ok("error" in outcome, "delete=none must fail");
    assert.equal(outcome.error.code, "validation");
    assert.match(outcome.error.message, /Deletes are not allowed for this model/);
    assert.equal(await store.readRevision(), 1);
    assert.equal((await modelRows(store, "acme.Keep")).length, 0);
  });
});

describe("T17b records() refusals (unservable shapes fail loud, never mis-served)", () => {
  it("refuses where/order/limit/archived-include/authority-owner with validation texts", async () => {
    const { asm, artifact, store, seed } = await shopSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const modes: ReadonlyArray<[string, RegExp]> = [
      ["where", /records\(\) with where=/],
      ["order", /records\(\) with order=/],
      ["limit", /records\(\) with limit=/],
      ["archived", /archived 'include'/],
      ["owner", /authority 'owner'/],
    ];
    const revisionBefore = await store.readRevision();
    for (const [mode, pattern] of modes) {
      const outcome = await invoker.invokeMutation(
        mutationEnvelope("acme.Shop.filteredRead", freshOperationId(seed.now), { mode }),
        identity,
      );
      assert.ok("error" in outcome, `${mode} must refuse`);
      // Uncaught engine failures attribute message-exactly at the seam
      // and receipt with their TRUE codes (parity with the CRUD path).
      assert.equal(outcome.error.code, "validation", mode);
      assert.match(outcome.error.message, pattern, mode);
    }
    // Five rejected receipts, nothing else.
    assert.equal(await store.readRevision(), revisionBefore + modes.length);
    assert.equal((await modelRows(store, "acme.Todo")).length, 0);
  });

  it("attributes propagated engine failures to their true codes on the receipt", async () => {
    const { asm, artifact, store, seed } = await shopSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const operationId = freshOperationId(seed.now);
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.passThrough", operationId, {}),
      identity,
    );
    assert.ok("error" in outcome, "pass-through must surface the engine code");
    assert.equal(outcome.error.code, "validation");
    assert.match(outcome.error.message, /records\(\) with where=/);
    const receipt = await store.readReceipt({
      app: "TeamTasks",
      owner: seed.teamId,
      principal: seed.memberId,
      operation: "acme.Shop.passThrough" as OperationName,
      operationId: operationId as OperationId,
    });
    assert.deepEqual(receipt?.outcome, {
      status: "rejected",
      code: "validation",
      message: outcome.error.message,
    });
  });
});

describe("T17b ruled reads (refuse loud; other serving stays up)", () => {
  it("refuses ruled-model reads at the router and in handlers while CRUD + rule-less reads serve", async () => {
    const { asm, artifact, store, seed } = await shopSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    // Writes to ruled models are NOT read-gated: the row lands.
    const sealed = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.sealOne", freshOperationId(seed.now), { key: "s-1" }),
      identity,
    );
    assert.ok("result" in sealed, `want result, got ${JSON.stringify(sealed)}`);
    const revisionAfterWrite = await store.readRevision();
    // …but its reads refuse LOUD (validation naming T04b), never silent empty.
    const routerRead = await invoker.invokeRead({ operation: "acme.Sealed.read", inputs: {} }, identity);
    assert.ok("error" in routerRead, "ruled router read must refuse");
    assert.equal(routerRead.error.code, "validation");
    assert.match(routerRead.error.message, /T04b carries generated policy/);
    const handlerRead = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.sealedPeek", freshOperationId(seed.now), {}),
      identity,
    );
    assert.ok("error" in handlerRead, "ruled handler read must refuse");
    assert.equal(handlerRead.error.code, "validation");
    assert.match(handlerRead.error.message, /T04b carries generated policy/);
    // Per-read blast radius only: Todo CRUD + Todo.read serve in the SAME artifact.
    const created = await invoker.invokeMutation(
      mutationEnvelope("acme.Todo.create", freshOperationId(seed.now), { title: "served" }),
      identity,
    );
    assert.ok("result" in created, `CRUD must serve, got ${JSON.stringify(created)}`);
    const served = await invoker.invokeRead({ operation: "acme.Todo.read", inputs: {} }, identity);
    assert.ok("result" in served, `rule-less read must serve, got ${JSON.stringify(served)}`);
    const result = served.result as { records: Array<{ data: Record<string, unknown> }> };
    assert.equal(result.records.length, 1);
    assert.deepEqual(result.records[0]?.data, { title: "served" });
    // The ruled router read committed nothing (revision moved only for
    // the two commits + the one handler rejection).
    assert.equal(await store.readRevision(), revisionAfterWrite + 2);
  });
});

describe("T17b commit-guard scoping (migrated calls stage; direct commits trip + roll back)", () => {
  it("trips a direct commit mid-handler and rolls the staged writes back atomically", async () => {
    const { asm, artifact, store, seed } = await shopSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const operationId = freshOperationId(seed.now);
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.mixedCommit", operationId, { key: "t-mixed" }),
      identity,
    );
    assert.ok("error" in outcome, "direct commit must trip the guard");
    assert.equal(outcome.error.code, "rule_failed");
    assert.match(outcome.error.message, /stage through the stdlib data plane/);
    // The staged create rolled back with the trip: receipt-only revision, no rows, no history.
    assert.equal(await store.readRevision(), 1);
    assert.equal((await modelRows(store, "acme.Todo")).length, 0);
    assert.deepEqual(await store.historyFor("acme.Todo" as ModelName, "t-mixed" as RecordId), []);
    const receipt = await store.readReceipt({
      app: "TeamTasks",
      owner: seed.teamId,
      principal: seed.memberId,
      operation: "acme.Shop.mixedCommit" as OperationName,
      operationId: operationId as OperationId,
    });
    assert.equal(receipt?.outcome.status, "rejected");
  });
});

describe("T17b rollback, replay, and fence convergence on the staged path", () => {
  it("rolls a mid-handler throw back to a receipt-only revision", async () => {
    const { asm, artifact, store, seed } = await shopSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const operationId = freshOperationId(seed.now);
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.explode", operationId, { key: "t-doomed" }),
      identity,
    );
    assert.ok("error" in outcome, "throw must fail");
    assert.equal(outcome.error.code, "rule_failed");
    assert.match(outcome.error.message, /boom-after-stage/);
    assert.equal(await store.readRevision(), 1);
    assert.equal((await modelRows(store, "acme.Todo")).length, 0);
    assert.deepEqual(await store.historyFor("acme.Todo" as ModelName, "t-doomed" as RecordId), []);
    const receipt = await store.readReceipt({
      app: "TeamTasks",
      owner: seed.teamId,
      principal: seed.memberId,
      operation: "acme.Shop.explode" as OperationName,
      operationId: operationId as OperationId,
    });
    assert.equal(receipt?.outcome.status, "rejected");
    // The rejection replays without re-running the handler.
    const replayed = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.explode", operationId, { key: "t-doomed" }),
      identity,
    );
    assert.ok("error" in replayed, "rejection must replay");
    assert.equal(replayed.error.code, "rule_failed");
    assert.equal(await store.readRevision(), 1);
  });

  it("replays duplicate scenario delivery without re-running or duplicating", async () => {
    const { url, asm, artifact, store, seed } = await shopSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const operationId = freshOperationId(seed.now);
    const envelope = mutationEnvelope("acme.Shop.place", operationId, { key: "t-1", title: "once" });
    const first = await invoker.invokeMutation(envelope, identity);
    assert.ok("result" in first, `want result, got ${JSON.stringify(first)}`);
    assert.equal((first.result as MutationResult).status, "committed");
    const revisionAfterCommit = await store.readRevision();
    const second = await invoker.invokeMutation(envelope, identity);
    assert.ok("result" in second, `want replayed result, got ${JSON.stringify(second)}`);
    assert.equal((second.result as MutationResult).status, "replayed");
    assert.deepEqual((second.result as MutationResult).result, (first.result as MutationResult).result);
    assert.equal(await store.readRevision(), revisionAfterCommit);
    assert.equal((await modelRows(store, "acme.Todo")).length, 1);
    const registry = (await import(url)) as { canApp(): { calls: unknown[] } };
    assert.equal(registry.canApp().calls.length, 1);
  });

  it("converges concurrent scenarios on one row through the fence (no lost update)", async () => {
    const { asm, artifact, store, seed } = await shopSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const seeded = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.place", freshOperationId(seed.now), { key: "t-race", title: "v1" }),
      identity,
    );
    assert.ok("result" in seeded, `want result, got ${JSON.stringify(seeded)}`);
    const revisionAfterSeed = await store.readRevision();
    const [left, right] = await Promise.all([
      invoker.invokeMutation(
        mutationEnvelope("acme.Shop.setRace", freshOperationId(seed.now), { key: "t-race", title: "A" }),
        identity,
      ),
      invoker.invokeMutation(
        mutationEnvelope("acme.Shop.setRace", freshOperationId(seed.now), { key: "t-race", title: "B" }),
        identity,
      ),
    ]);
    assert.ok("result" in left, `left must commit, got ${JSON.stringify(left)}`);
    assert.ok("result" in right, `right must commit, got ${JSON.stringify(right)}`);
    assert.equal((left.result as MutationResult).status, "committed");
    assert.equal((right.result as MutationResult).status, "committed");
    // One winner, one fence-retry: two revisions, version 4, both titles applied in some order.
    assert.equal(await store.readRevision(), revisionAfterSeed + 2);
    const row = await store.load("acme.Todo" as ModelName, "t-race" as RecordId);
    assert.equal(row?.version, 4);
    assert.ok((row?.data as Record<string, unknown>)["title"] === "A" || (row?.data as Record<string, unknown>)["title"] === "B");
    const trail = await store.historyFor("acme.Todo" as ModelName, "t-race" as RecordId);
    assert.deepEqual(
      trail.map((entry) => entry.version),
      [1, 2, 3, 4],
    );
    const titles = trail
      .map((entry) => (entry.after as Record<string, unknown> | null)?.["title"])
      .filter((title): title is string => typeof title === "string");
    assert.deepEqual([...titles].sort(), ["A", "B", "v1", "v1"]);
  });
});

describe("T17b no-change stability on the staged path", () => {
  it("commits empty patches cleanly with identical data and an advanced version", async () => {
    const { asm, artifact, store, seed } = await shopSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.noopPatch", freshOperationId(seed.now), { key: "t-steady" }),
      identity,
    );
    assert.ok("result" in outcome, `want result, got ${JSON.stringify(outcome)}`);
    assert.deepEqual((outcome.result as MutationResult).result, {
      version: 2,
      data: { title: "steady" },
    });
    const row = await store.load("acme.Todo" as ModelName, "t-steady" as RecordId);
    assert.deepEqual(row?.data, { title: "steady" });
  });
});

describe("T17b staged uniques (netted pairs commit clean; live dupes conflict)", () => {
  it("lands no ghost claim for create+remove pairs; a later reuse of the key commits", async () => {
    const { asm, artifact, store, seed } = await shopSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const cycled = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.uniqueCycle", freshOperationId(seed.now), { key: "s-1", code: "K-1" }),
      identity,
    );
    assert.ok("result" in cycled, `want result, got ${JSON.stringify(cycled)}`);
    assert.equal((await modelRows(store, "acme.Sku")).length, 0);
    // The freed key is claimable again — no ghost claim survived the netting.
    const reused = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.makeSku", freshOperationId(seed.now), { key: "s-2", code: "K-1" }),
      identity,
    );
    assert.ok("result" in reused, `reused key must commit, got ${JSON.stringify(reused)}`);
    assert.equal((await modelRows(store, "acme.Sku")).length, 1);
  });

  it("conflicts competing live claims at commit with no receipt and no revision move", async () => {
    const { asm, artifact, store, seed } = await shopSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const operationId = freshOperationId(seed.now);
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.uniqueDupe", operationId, { a: "s-a", b: "s-b", code: "K-9" }),
      identity,
    );
    assert.ok("error" in outcome, "competing claims must conflict");
    assert.equal(outcome.error.code, "conflict");
    // Store-level failure: nothing persisted at all.
    assert.equal(await store.readRevision(), 0);
    assert.equal((await modelRows(store, "acme.Sku")).length, 0);
    assert.equal(
      await store.readReceipt({
        app: "TeamTasks",
        owner: seed.teamId,
        principal: seed.memberId,
        operation: "acme.Shop.uniqueDupe" as OperationName,
        operationId: operationId as OperationId,
      }),
      null,
    );
  });
});

describe("T17b receipt defaults (keyed per write)", () => {
  it("records resolved defaults under <callIndex>:<model>.<field>", async () => {
    const { asm, artifact, store, seed } = await shopSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const operationId = freshOperationId(seed.now);
    const outcome = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.makeSku", operationId, { key: "s-7", code: "K-7" }),
      identity,
    );
    assert.ok("result" in outcome, `want result, got ${JSON.stringify(outcome)}`);
    assert.deepEqual((outcome.result as MutationResult).result, {
      id: "s-7",
      data: { code: "K-7", stock: "0" },
    });
    const receipt = await store.readReceipt({
      app: "TeamTasks",
      owner: seed.teamId,
      principal: seed.memberId,
      operation: "acme.Shop.makeSku" as OperationName,
      operationId: operationId as OperationId,
    });
    assert.deepEqual(receipt?.resolvedDefaults, { "0:acme.Sku.stock": "0" });
  });
});

describe("T17b parent linkage (validated, staged, attributed)", () => {
  it("declared roots refuse ad-hoc parent linkage (B5); production linkage pins live in T32c", async () => {
    // B5 declared ownership: artifact models without a `parent` member
    // are DECLARED roots (models.ts: "absent `parent` marks a DECLARED
    // root"), so ad-hoc supplied parents fail with "not allowed" —
    // the pre-B5 legacy posture (accept any supplied parent) survives
    // only for hand-built defs, never loader-built tables. Positive
    // linkage + ghost refusal on production shape are pinned by the
    // T32c C2 containment test (Shop.Member in Shop.Team).
    const { asm, artifact, store, seed } = await shopSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const linked = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.linkOk", freshOperationId(seed.now), { parent: "p-1", child: "c-1" }),
      identity,
    );
    assert.ok("error" in linked, "ad-hoc parent on a declared root must fail");
    assert.equal(linked.error.code, "validation");
    assert.equal(linked.error.message, 'Parent linkage is not allowed for model "acme.Todo".');
    const ghosted = await invoker.invokeMutation(
      mutationEnvelope("acme.Shop.linkGhost", freshOperationId(seed.now), { child: "c-2", ghost: "nope" }),
      identity,
    );
    assert.ok("error" in ghosted, "ghost parent must fail");
    assert.equal(ghosted.error.code, "validation");
    assert.equal(ghosted.error.message, 'Parent linkage is not allowed for model "acme.Todo".');
    assert.equal(await store.load("acme.Todo" as ModelName, "c-2" as RecordId), null);
  });
});

describe("T17b stale revisions conflict (CRUD path, row untouched)", () => {
  it("conflicts a stale submitted version without touching the stored row", async () => {
    const { asm, artifact, store, seed } = await shopSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const memberIdentity = await identityFor(seed, seed.memberToken);
    const ownerIdentity = await identityFor(seed, seed.ownerToken);
    const created = await invoker.invokeMutation(
      mutationEnvelope("acme.Todo.create", freshOperationId(seed.now), { title: "v1" }),
      memberIdentity,
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
    const revisionBeforeStale = await store.readRevision();
    const stale = await invoker.invokeMutation(
      mutationEnvelope("acme.Todo.update", freshOperationId(seed.now), {
        record: { id, version: "1" },
        title: "stale",
      }),
      ownerIdentity,
    );
    assert.ok("error" in stale, "stale version must conflict");
    assert.equal(stale.error.code, "conflict");
    assert.equal(await store.readRevision(), revisionBeforeStale);
    const row = await store.load("acme.Todo" as ModelName, id as RecordId);
    assert.equal(row?.version, 2);
    assert.deepEqual(row?.data, { title: "v2" });
  });
});

describe("T17b read posture (public grants serve every admitted caller; shapes validate closed)", () => {
  it("serves rule-less models to outsiders and anonymous callers with full rows", async () => {
    const { asm, artifact, store, seed } = await shopSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const memberIdentity = await identityFor(seed, seed.memberToken);
    const created = await invoker.invokeMutation(
      mutationEnvelope("acme.Todo.create", freshOperationId(seed.now), { title: "open", done: true }),
      memberIdentity,
    );
    assert.ok("result" in created, `want result, got ${JSON.stringify(created)}`);
    // Outsider (no membership) and anonymous callers both serve: rule-less
    // models transcribe to public grants (the keep-public+grants posture).
    const outsiderIdentity = await identityFor(seed, seed.outsiderToken);
    for (const [name, caller] of [
      ["outsider", outsiderIdentity],
      ["anonymous", anonymousIdentity()],
    ] as const) {
      const served = await invoker.invokeRead({ operation: "acme.Todo.read", inputs: {} }, caller);
      assert.ok("result" in served, `${name} must serve, got ${JSON.stringify(served)}`);
      const result = served.result as { records: Array<{ data: Record<string, unknown> }> };
      assert.equal(result.records.length, 1, name);
      assert.deepEqual(result.records[0]?.data, { title: "open", done: true }, name);
    }
  });

  it("rejects unknown read inputs closed-shape and refuses reads without live membership", async () => {
    const { asm, artifact, store, seed } = await shopSetup();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const bogus = await invoker.invokeRead(
      { operation: "acme.Todo.read", inputs: { bogus: 1 } },
      identity,
    );
    assert.ok("error" in bogus, "unknown input must reject");
    assert.equal(bogus.error.code, "validation");
    assert.match(bogus.error.message, /Invalid operation inputs/);
    // Reads demand live membership like mutations (never admit blind).
    const blind = buildInvoker(artifact, asm, store, { now: () => seed.now });
    const denied = await blind.invokeRead({ operation: "acme.Todo.read", inputs: {} }, identity);
    assert.ok("error" in denied, "reads must demand live membership");
    assert.equal(denied.error.code, "rule_failed");
    assert.match(denied.error.message, /needs a MembershipReader/);
  });

  it("refuses reads WITH descriptor inputs (no T04a filter vocabulary)", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", shopModuleSource(SHOP_POLICY_JSON));
    const asm = stubAsm(dir, { "ops.mjs": url });
    const operations = (shopOperations() as Array<Record<string, unknown>>).map((op) =>
      op["name"] === "acme.Todo.read"
        ? {
            ...op,
            inputs: { fields: [{ name: "q", field: { kind: "string" }, required: false }] },
          }
        : op,
    );
    const artifact = shopArtifact("ops.mjs", { operations });
    const { store } = createTestMemoryStorage();
    const seed = await seedIdentity();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity = await identityFor(seed, seed.memberToken);
    const outcome = await invoker.invokeRead(
      { operation: "acme.Todo.read", inputs: { q: "x" } },
      identity,
    );
    assert.ok("error" in outcome, "input-carrying read must refuse");
    assert.equal(outcome.error.code, "validation");
    assert.match(outcome.error.message, /T04b carries filter inputs/);
    void url;
  });
});

describe("T17b read-policy preload (malformed and contradictory manifests refuse loud)", () => {
  function readOnlyArtifact(module: string): CompileArtifact {
    return shopArtifact(module, {
      operations: [{ name: "acme.Todo.read", kind: "read", description: "", inputs: { fields: [] } }],
      callables: [],
    });
  }

  function policyModule(modelsJson: string): string {
    return `export function canApp() {
  return {
    policy: { models: ${modelsJson} }
  };
}
`;
  }

  it("refuses malformed model entries at preload", async () => {
    for (const [name, modelsJson, pattern] of [
      ["non-array read", `{ "acme.Todo": { read: "Todo.read.1" } }`, /malformed read rules/],
      ["unknown member", `{ "acme.Todo": { frobnicate: 1 } }`, /unknown policy member/],
      ["non-object models", `[]`, /malformed policy\.models map/],
    ] as const) {
      const dir = tempDir();
      const url = writeModule(dir, "ops.mjs", policyModule(modelsJson));
      const asm = stubAsm(dir, { "ops.mjs": url });
      const artifact = readOnlyArtifact("ops.mjs");
      const error = await captureError(() => loadCanonicalDescriptors(asm, artifact));
      assert.match(error.message, pattern, name);
      void url;
    }
  });

  it("refuses contradictory read policy across modules", async () => {
    const dir = tempDir();
    const first = writeModule(dir, "a.mjs", policyModule(`{ "acme.Todo": { read: ["Todo.read.1"] } }`));
    const second = writeModule(dir, "b.mjs", policyModule(`{ "acme.Todo": { read: ["Todo.read.2"] } }`));
    const asm = stubAsm(dir, { "a.mjs": first, "b.mjs": second });
    const artifact = readOnlyArtifact("a.mjs");
    const error = await captureError(() => loadCanonicalDescriptors(asm, artifact));
    assert.match(error.message, /contradictory read policy/);
  });

  it("skips modules without a canApp registry when establishing read policy", async () => {
    const dir = tempDir();
    const page = writeModule(dir, "page.mjs", `export const descriptor = { path: "/" };\n`);
    const asm = stubAsm(dir, { "page.mjs": page });
    const artifact = readOnlyArtifact("page.mjs");
    const loaded = await loadCanonicalDescriptors(asm, artifact);
    assert.equal(loaded.ruledModels.size, 0);
  });
});
