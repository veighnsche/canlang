import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { compileFunction, constants } from "node:vm";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CommitBatch,
  CommitResult,
  CompileArtifact,
  ModelName,
  MutationResult,
  OperationId,
  QuerySpec,
  RecordId,
  ResolvedIdentity,
  Revision,
  StoragePort,
  StoredRow,
} from "@canlang/contracts";
import { datetime } from "@canlang/values";
import { resolveIdentity, sha256HexText } from "@canlang/identity";
import { createFrozenClock, createMemoryIdentityStore } from "@canlang/identity/testing";
import { createTestMemoryStorage } from "@canlang/state/storage/memory";
import { createContext, type HandlerContext } from "../src/runtime/context.js";
import {
  cancel,
  check,
  count,
  delivery,
  emit,
  hasRole,
  require as guardRequire,
  schedule,
  secretEqual,
  send,
} from "../src/runtime/stdlib.js";
import type { AssembledModules, MutationOutcome } from "../src/worker/assembly.js";

// Native import preserves the emitted module's data-property namespace. Vitest
// rewrites ordinary imports to accessor namespaces, which canonical metadata
// intentionally refuses. This fixture exercises the actual emitted consumer.
const importNativeModule = compileFunction("return import(url)", ["url"], {
  importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
}) as
  (url: string) => Promise<typeof import("../src/worker/assembly.js")>;
const { buildInvoker } = await importNativeModule(
  pathToFileURL(createRequire(import.meta.url).resolve("@canlang/cloudflare/worker/assembly")).href,
);

interface Fake {
  port: StoragePort;
  revisions: number;
  loads: Array<{ model: string; id: string }>;
  specs: QuerySpec[];
  batches: CommitBatch[];
  rows: Map<string, StoredRow>;
}

function fakeStore(seed: StoredRow[] = []): Fake {
  const fake: Fake = {
    port: null as unknown as StoragePort,
    revisions: 0,
    loads: [],
    specs: [],
    batches: [],
    rows: new Map(seed.map((r) => [`${"Todo"}${r.id as string}`, r])),
  };
  const unused = (): Promise<never> => {
    throw new Error("unused StoragePort method");
  };
  fake.port = {
    readRevision: async (): Promise<Revision> => {
      fake.revisions += 1;
      return 7 as Revision;
    },
    load: async (model: ModelName, id: RecordId): Promise<StoredRow | null> => {
      fake.loads.push({ model: model as string, id: id as string });
      return fake.rows.get(`${model as string}${id as string}`) ?? null;
    },
    query: async (spec: QuerySpec): Promise<ReadonlyArray<StoredRow>> => {
      fake.specs.push(spec);
      return [...fake.rows.values()];
    },
    commit: async (batch: CommitBatch): Promise<CommitResult> => {
      fake.batches.push(batch);
      return { revision: 8 as Revision };
    },
    readReceipt: unused,
    outboxPending: unused,
    scheduleGet: unused,
    schedulesDue: unused,
    historyFor: unused,
    readInstalledSnapshot: unused,
    readMigrationProgress: unused,
    readStagedRows: unused,
    stageMigrationRows: unused,
    publishMigrationChunk: unused,
    flipInstalledSnapshot: unused,
    readMigrationOutcomes: unused,
    recordMigrationFailure: unused,
    discardStagedRows: unused,
    readMigrationFailure: unused,
  };
  return fake;
}

function contextFor(fake: Fake): HandlerContext {
  return createContext({
    caller: { userId: "u1", roles: ["member"] },
    store: fake.port,
    clock: () => 1700000000000,
  });
}

/* ------------------------------------------------------------------ */
/* T17c canonical fixtures: stdlib behavior through staging.           */
/*                                                                     */
/* T17 retired the direct-commit/query stdlib paths (`requireScope`    */
/* throws without a canonical scope), so these pins drive the SAME     */
/* behaviors through scenario handlers over a memory store: each       */
/* scenario exercises one stdlib path, the pipeline stages it, and     */
/* the ONE fenced commit carries the scenario receipt. Fixture         */
/* handlers import the COMPILED stdlib via an absolute dist file URL   */
/* (the T17b flip-test precedent stages fixtures under the compiled   */
/* test dir with a relative `../stdlib.js`; vitest stages these in    */
/* the OS temp dir, so the URL is absolute). Its normal owning imports */
/* remain in the native emitted graph, with metadata guards preserved. */
/* ------------------------------------------------------------------ */

const STDLIB_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "../dist/runtime/stdlib.js"),
).href;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "canlang-stdlib-t17c-"));
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

const OPS_SOURCE = `import { create, set, deleteRecord, records } from ${JSON.stringify(STDLIB_URL)};
const policy = {
      operations: {
        "acme.Shop.mkCreate": { by: ["members"] },
        "acme.Shop.mkParent": { by: ["members"] },
        "acme.Shop.mkSet": { by: ["members"] },
        "acme.Shop.setMissing": { by: ["members"] },
        "acme.Shop.mkRemove": { by: ["members"] },
        "acme.Shop.removeMissing": { by: ["members"] },
        "acme.Shop.mkRecords": { by: ["members"] },
        "acme.Shop.mkRecordsBare": { by: ["members"] },
      },
      models: {
        "acme.Todo": { read: ["Todo.read.1"], public: ["Todo.read.1"] },
      },
    };
export const appDefinition = { id: "acme", policy, models: {
  "acme.Todo": { fields: { title: { type: "text" }, done: { type: "bool" } }, readGrants: [{ rule: "Todo.read.1", by: ["public"] }] },
  "acme.Sub": { fields: { title: { type: "text" } }, parent: "acme.Todo" },
} };
export function canApp() {
  return {
    // B7: every scenario declares its admission gate (absent
    // entries deny) and Todo carries explicit-public read
    // provenance (absent reads serve zero grants) so the stdlib
    // behavior pins below still stage through the handlers.
    policy,
    read: { "Todo.read.1": () => true },
    Shop: {
      mkCreate: async (c, input) => {
        return create(c, "acme.Todo", { id: input.inputs.key, data: { title: input.inputs.title } });
      },
      mkParent: async (c, input) => {
        await create(c, "acme.Todo", { id: input.inputs.parent, data: { title: "parent" } });
        return create(c, "acme.Sub", {
          id: input.inputs.child,
          data: { title: "child" },
          parent: { model: "acme.Todo", id: input.inputs.parent },
        });
      },
      mkSet: async (c, input) => {
        await create(c, "acme.Todo", { id: input.inputs.key, data: { title: "old", done: false } });
        return set(c, "acme.Todo", input.inputs.key, { done: true });
      },
      setMissing: async (c, input) => {
        await set(c, "acme.Todo", input.inputs.key, { done: true });
        return { never: true };
      },
      mkRemove: async (c, input) => {
        await create(c, "acme.Todo", { id: input.inputs.key, data: { title: "gone" } });
        await deleteRecord(c, "acme.Todo", input.inputs.key);
        const seen = await records(c, "acme.Todo");
        const stored = await c.store.load("acme.Todo", input.inputs.key);
        return { visible: seen.length, stored: stored === null ? null : stored.id };
      },
      removeMissing: async (c, input) => {
        await deleteRecord(c, "acme.Todo", input.inputs.key);
        return { never: true };
      },
      mkRecords: async (c) => {
        await create(c, "acme.Todo", { id: "t1", data: { title: "a" } });
        await create(c, "acme.Todo", { id: "t2", data: { title: "b" } });
        return records(c, "acme.Todo");
      },
      mkRecordsBare: async (c) => {
        await create(c, "acme.Todo", { id: "t1", data: { title: "a" } });
        return records(c, "acme.Todo");
      },
    },
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

// B5 declared ownership: linkage needs a DECLARED child (ad-hoc
// parents on the parentless Todo root are refused); the T17c
// pass-through pin stages through this child.
function subModel(): unknown {
  return {
    name: "acme.Sub",
    fields: [
      { name: "title", required: true, serverOnly: false, field: { kind: "string" } },
    ],
    deleteMode: "remove",
    parent: "acme.Todo",
  };
}

const SCENARIOS: ReadonlyArray<{ op: string; fn: string; params: ReadonlyArray<string> }> = [
  { op: "acme.Shop.mkCreate", fn: "mkCreate", params: ["key", "title"] },
  { op: "acme.Shop.mkParent", fn: "mkParent", params: ["parent", "child"] },
  { op: "acme.Shop.mkSet", fn: "mkSet", params: ["key"] },
  { op: "acme.Shop.setMissing", fn: "setMissing", params: ["key"] },
  { op: "acme.Shop.mkRemove", fn: "mkRemove", params: ["key"] },
  { op: "acme.Shop.removeMissing", fn: "removeMissing", params: ["key"] },
  { op: "acme.Shop.mkRecords", fn: "mkRecords", params: [] },
  { op: "acme.Shop.mkRecordsBare", fn: "mkRecordsBare", params: [] },
];

/** Hand-written T15a-shaped artifact (NOT compiler output): descriptors + callables. */
function shopArtifact(module: string): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "t17c-fixture/0 (hand-written T15a shape; NOT compiler output)",
    tool_version: "t17c-fixture/0",
    sources: [{ path: module, sha256: createHash("sha256").update(OPS_SOURCE).digest("hex") }],
    modules: [{ path: module, js: OPS_SOURCE, map: { version: 3, file: module,
      sources: [module], sourcesContent: [OPS_SOURCE], names: [], mappings: "" } }],
    callables: SCENARIOS.map((s) => ({
      id: s.op,
      kind: "operation",
      module,
      export: `Shop_${s.fn}`,
      member: ["Shop", s.fn],
    })),
    pages: [],
    requires: [],
    tests: [],
    // Fresh inputs per artifact (no shared mutable structure across loads).
    // The read descriptor serves `records()` (readModel invokes
    // `acme.Todo.read`); its owning selector callable is canApp().read.
    operations: [
      { name: "acme.Todo.read", kind: "read", description: "", inputs: { fields: [] } },
      ...SCENARIOS.map((s) => ({
        name: s.op,
        kind: "scenario",
        description: "",
        inputs: {
          fields: s.params.map((name) => ({ name, field: { kind: "string" }, required: true })),
        },
      })),
    ],
    models: [todoModel(), subModel()],
  } as unknown as CompileArtifact;
}

interface CanonicalSetup {
  readonly now: number;
  readonly store: StoragePort;
  readonly userId: string;
  readonly teamId: string;
  readonly identity: ResolvedIdentity;
  readonly invoker: ReturnType<typeof buildInvoker>;
}

async function canonicalSetup(): Promise<CanonicalSetup> {
  const dir = tempDir();
  const url = writeModule(dir, "ops.mjs", OPS_SOURCE);
  const asm: AssembledModules = { dir, entryUrl: url, moduleUrls: { "ops.mjs": url } };
  const artifact = shopArtifact("ops.mjs");
  const { store } = createTestMemoryStorage();
  const now = Date.now();
  const clock = createFrozenClock(now);
  const idStore = createMemoryIdentityStore({ clock });
  const team = await idStore.createTeam({});
  const user = await idStore.createUser({
    email: "member@t17c.test",
    password_hash: "x",
    email_verified: true,
  });
  await idStore.createMembership({
    team_id: team.team_id,
    user_id: user.user_id,
    is_owner: true,
    roles: [],
  });
  const token = `t17c-session-${randomBytes(8).toString("hex")}`;
  await idStore.createSession({
    user_id: user.user_id,
    token_sha256: await sha256HexText(token),
    expires_at: new Date(now + 3600_000).toISOString(),
    last_team_id: team.team_id,
  });
  const identity = await resolveIdentity(
    idStore,
    { session_token: token },
    { clock: { nowMs: () => now } },
  );
  const invoker = buildInvoker(artifact, asm, store, { memberships: idStore, now: () => now });
  return { now, store, userId: user.user_id, teamId: team.team_id, identity, invoker };
}

function mustResult(outcome: MutationOutcome): MutationResult {
  if ("result" in outcome) return outcome.result;
  throw new Error(`want result, got ${JSON.stringify(outcome)}`);
}

function mustError(outcome: MutationOutcome): { code: string; message: string } {
  if ("error" in outcome) return outcome.error;
  throw new Error(`want error, got ${JSON.stringify(outcome)}`);
}

describe("create", () => {
  it("stages an insert through the pipeline and commits it once with the scenario receipt", async () => {
    // T17c (rule a): retired the direct-commit batch pin (per-call
    // batches/fences are gone); the SAME insert behavior now stages
    // through the canonical pipeline and commits once with the scenario
    // receipt. Row shape, version 1, frozen-clock timestamps, and
    // admitted attribution are pinned on the staged row AND the
    // committed row, plus the single revision.
    const s = await canonicalSetup();
    const operationId = freshOperationId(s.now);
    const committed = mustResult(
      await s.invoker.invokeMutation(
        {
          operation: "acme.Shop.mkCreate",
          operation_id: operationId as OperationId,
          inputs: { key: "t1", title: "write tests" },
        },
        s.identity,
      ),
    );
    expect(committed.status).toBe("committed");
    expect(committed.operation_id).toBe(operationId);
    expect(committed.result).toEqual({
      id: "t1",
      version: 1,
      created: s.now,
      updated: s.now,
      createdBy: s.userId,
      updatedBy: s.userId,
      archivedAt: null,
      parent: null,
      data: { title: "write tests" },
    });
    expect(await s.store.load("acme.Todo" as ModelName, "t1" as RecordId)).toEqual(
      committed.result,
    );
    expect(await s.store.readRevision()).toBe(1);
  });

  it("passes a parent link through to the staged row", async () => {
    // T17c (rule a): SAME parent-linkage behavior through staging (was
    // asserted on the direct insert batch row).
    const s = await canonicalSetup();
    const committed = mustResult(
      await s.invoker.invokeMutation(
        {
          operation: "acme.Shop.mkParent",
          operation_id: freshOperationId(s.now) as OperationId,
          inputs: { parent: "t1", child: "t2" },
        },
        s.identity,
      ),
    );
    expect(committed.status).toBe("committed");
    expect((committed.result as { parent: unknown }).parent).toEqual({
      model: "acme.Todo",
      id: "t1",
    });
    const stored = await s.store.load("acme.Sub" as ModelName, "t2" as RecordId);
    expect(stored?.parent).toEqual({ model: "acme.Todo", id: "t1" });
  });
});

describe("set", () => {
  it("merges the patch over the staged row and keeps a new row at version 1", async () => {
    // T17c (rule a): was load + merge + commit at stored version 3->4
    // via direct calls; now create (v1) + set merge through the
    // pipeline with read-your-write over the staged overlay, committed
    // once (v1). A newly created row shares its transaction reservation.
    const s = await canonicalSetup();
    const committed = mustResult(
      await s.invoker.invokeMutation(
        {
          operation: "acme.Shop.mkSet",
          operation_id: freshOperationId(s.now) as OperationId,
          inputs: { key: "t1" },
        },
        s.identity,
      ),
    );
    expect(committed.status).toBe("committed");
    expect(committed.result).toEqual({
      id: "t1",
      version: 1,
      created: s.now,
      updated: s.now,
      createdBy: s.userId,
      updatedBy: s.userId,
      archivedAt: null,
      parent: null,
      data: { title: "old", done: true },
    });
    const stored = await s.store.load("acme.Todo" as ModelName, "t1" as RecordId);
    // Create and its later staged update share one owner transaction;
    // the newly created row remains at version 1 (DESIGN §2).
    expect(stored?.version).toBe(1 as StoredRow["version"]);
    expect(stored?.data).toEqual({ title: "old", done: true });
    expect(await s.store.readRevision()).toBe(1);
  });

  it("rejects a patch on a missing record with the engine not_found", async () => {
    // T17c (rule a): was a direct-call throw matching /record not
    // found/ with no commit; the pipeline stages nothing and the seam
    // attributes the propagated engine failure message-exactly, so the
    // rejection carries the TRUE `not_found` code (engine text "Record
    // not found."). Bookkeeping only: the rejected receipt commits a
    // receipt-only revision; no rows, no history.
    const s = await canonicalSetup();
    const err = mustError(
      await s.invoker.invokeMutation(
        {
          operation: "acme.Shop.setMissing",
          operation_id: freshOperationId(s.now) as OperationId,
          inputs: { key: "missing" },
        },
        s.identity,
      ),
    );
    expect(err.code).toBe("not_found");
    expect(err.message).toContain("Record not found");
    expect(await s.store.readRevision()).toBe(1);
    expect(await s.store.load("acme.Todo" as ModelName, "missing" as RecordId)).toBeNull();
  });
});

describe("deleteRecord", () => {
  it("stages a remove honoring the model delete mode and commits it once", async () => {
    // T17c (rule a): was a version-fenced direct remove batch; now the
    // remove stages through the pipeline (deleteMode `remove`
    // hard-removes) with read-your-write masking in-scenario, committed
    // once. SAME removal behavior, observed staged AND committed.
    const s = await canonicalSetup();
    const committed = mustResult(
      await s.invoker.invokeMutation(
        {
          operation: "acme.Shop.mkRemove",
          operation_id: freshOperationId(s.now) as OperationId,
          inputs: { key: "t1" },
        },
        s.identity,
      ),
    );
    expect(committed.status).toBe("committed");
    expect(committed.result).toEqual({ visible: 0, stored: null });
    expect(await s.store.load("acme.Todo" as ModelName, "t1" as RecordId)).toBeNull();
    expect(await s.store.readRevision()).toBe(1);
  });

  it("rejects a remove on a missing record with the engine not_found", async () => {
    // T17c (rule a): was a direct-call throw matching /record not
    // found/ with no commit; the rejection now carries the TRUE
    // `not_found` code with a receipt-only revision (see setMissing).
    const s = await canonicalSetup();
    const err = mustError(
      await s.invoker.invokeMutation(
        {
          operation: "acme.Shop.removeMissing",
          operation_id: freshOperationId(s.now) as OperationId,
          inputs: { key: "missing" },
        },
        s.identity,
      ),
    );
    expect(err.code).toBe("not_found");
    expect(err.message).toContain("Record not found");
    expect(await s.store.readRevision()).toBe(1);
    expect(await s.store.load("acme.Todo" as ModelName, "missing" as RecordId)).toBeNull();
  });
});

describe("records", () => {
  it("serves the whole model through invokeRead over the staged overlay", async () => {
    // T17c (rule a): was direct store passthrough of where/order/limit
    // (unservable shapes that now refuse LOUD with `validation` —
    // pinned in the T17b flip suite, not duplicated here); the SAME
    // whole-model read now serves through `invokeRead` over the staged
    // overlay, so handler reads see handler writes, viewer-projected.
    const s = await canonicalSetup();
    const committed = mustResult(
      await s.invoker.invokeMutation(
        {
          operation: "acme.Shop.mkRecords",
          operation_id: freshOperationId(s.now) as OperationId,
          inputs: {},
        },
        s.identity,
      ),
    );
    expect(committed.status).toBe("committed");
    const seen = (committed.result as ReadonlyArray<{ id: string; data: unknown }>)
      .map((r) => ({ id: r.id, data: r.data }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(seen).toEqual([
      { id: "t1", data: { title: "a" } },
      { id: "t2", data: { title: "b" } },
    ]);
    // Staged AND committed: the store holds both rows at one revision.
    expect(await s.store.load("acme.Todo" as ModelName, "t1" as RecordId)).not.toBeNull();
    expect(await s.store.load("acme.Todo" as ModelName, "t2" as RecordId)).not.toBeNull();
    expect(await s.store.readRevision()).toBe(1);
  });

  it("defaults to the bare whole-model viewer read with the full projected envelope", async () => {
    // T17c (rule a): was a bare owner-authority store spec; the owner
    // bypass stays engine-internal (an explicit `authority: 'owner'`
    // now refuses LOUD — flip-pinned), and the bare read serves
    // viewer-projected. The full `ProjectedRecord` envelope is pinned.
    const s = await canonicalSetup();
    const committed = mustResult(
      await s.invoker.invokeMutation(
        {
          operation: "acme.Shop.mkRecordsBare",
          operation_id: freshOperationId(s.now) as OperationId,
          inputs: {},
        },
        s.identity,
      ),
    );
    expect(committed.status).toBe("committed");
    expect(committed.result).toEqual([
      {
        id: "t1",
        version: 1,
        created: s.now,
        updated: s.now,
        createdBy: s.userId,
        updatedBy: s.userId,
        archivedAt: null,
        parent: null,
        data: { title: "a" },
      },
    ]);
  });
});

describe("effect refusals without canonical scope", () => {
  const c = contextFor(fakeStore());
  const cases: Array<[string, (ctx: HandlerContext) => unknown]> = [
    ["send", (ctx) => send(ctx, "Mail.deliver", {})],
    ["emit", (ctx) => emit(ctx)],
    ["schedule", (ctx) => schedule(ctx, "test-key", datetime("2026-10-09T00:00:00Z"), "test-event", {})],
    ["cancel", (ctx) => cancel(ctx, "test-key")],
    ["check", (ctx) => check(ctx)],
    ["delivery", (ctx) => delivery(ctx, { record: "test-record", field: "sent" }, ["status"])],
    ["secretEqual", (ctx) => secretEqual(ctx)],
  ];
  for (const [name, call] of cases) {
    it(name === "delivery" ? "delivery rejects without canonical receipt observation scope" : `${name} refuses unsupported(${name})`, async () => {
      if (["send", "schedule", "cancel", "delivery"].includes(name)) {
        await expect(call(c)).rejects.toThrow(name === "delivery"
          ? "delivery requires canonical receipt observation scope."
          : new RegExp(`unsupported\\(${name}\\)`));
      } else {
        expect(() => call(c)).toThrow(new RegExp(`unsupported\\(${name}\\)`));
      }
    });
  }
});

describe("guards", () => {
  it("require passes truthy, throws the emitted code otherwise", () => {
    expect(() => guardRequire(true, "forbidden")).not.toThrow();
    expect(() => guardRequire(false, "forbidden")).toThrow("forbidden");
    expect(() => guardRequire(0)).toThrow("forbidden");
  });

  it("hasRole tests the context memberships (anonymous denies)", () => {
    const member = createContext({
      caller: { userId: "u1", roles: ["member"] },
      store: fakeStore().port,
      memberships: ["members"],
    });
    expect(hasRole(member, "members")).toBe(true);
    expect(hasRole(member, "admins")).toBe(false);
    expect(hasRole(contextFor(fakeStore()), "members")).toBe(false);
  });

  it("hasRole with a subject throws instead of widening the guard", () => {
    const member = createContext({
      caller: { userId: "u1", roles: ["member"] },
      store: fakeStore().port,
      memberships: ["members"],
    });
    expect(() => hasRole(member, "members", { userId: "u2" })).toThrow(
      /unsupported\(hasRole-subject\)/,
    );
  });
});

describe("count", () => {
  it("mirrors values count (bigint length, loud on non-array)", () => {
    expect(count([1, 2, 3])).toBe(3n);
    expect(count([])).toBe(0n);
    expect(() => count("nope" as unknown as ReadonlyArray<unknown>)).toThrow(
      "count: domain must be an array",
    );
  });
});

describe('canonical builtin admission predicates', () => {
  it('uses only the live canonical predicate snapshot while preserving declared grants', () => {
    const deps = { caller: { userId: 'user', roles: ['Images.operator'] }, store: fakeStore().port, memberships: ['Images.operator'] };
    const canonical = { operation: 'Images.generate', operationId: 'request', builtinRoles: ['public', 'authenticated', 'members'], stageWrite: async () => null, readModel: async () => [] };
    const c = createContext({ ...deps, canonical });
    expect(hasRole(c, 'public')).toBe(true);
    expect(hasRole(c, 'authenticated')).toBe(true);
    expect(hasRole(c, 'members')).toBe(true);
    expect(hasRole(c, 'owner')).toBe(false);
    expect(hasRole(c, 'Images.operator')).toBe(true);
    const publicContext = createContext({ ...deps, canonical: { ...canonical, builtinRoles: ['public'] } });
    expect(hasRole(publicContext, 'public')).toBe(true);
    expect(hasRole(publicContext, 'authenticated')).toBe(false);
    expect(hasRole(publicContext, 'members')).toBe(false);
    expect(hasRole(publicContext, 'Images.operator')).toBe(true);
  });
});
