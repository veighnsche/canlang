/**
 * T17b durable L7 tests (colocated): the migrated serving path
 * (scenario staging + `invokeRead` + receipts/history/replay) running
 * against REAL miniflare D1 — never memory doubles. The fence, the
 * batch atomicity, and the stored rows/history/receipts below are the
 * real SQLite substrate; only the membership reader stays a memory
 * double (the durable claim covers the state store, not identity —
 * same scope as the T17a durable suite, which additionally proves DO
 * SQLite at the engine level).
 *
 * Per T17 acceptance: memory doubles prove nothing durable, so the
 * L7 durable claim rests SOLELY on this file. Process-restart
 * survival is explicitly UNCLAIMED (the harness holds an ephemeral
 * miniflare instance; no persist channel is asserted).
 *
 * Run from dist: root build, then
 * `node --test dist/runtime/t17b-durable.test.js`.
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
  MutationEnvelope,
  MutationResult,
  OperationId,
  OperationName,
  RecordId,
  ResolvedIdentity,
  StoragePort,
} from "@canlang/contracts";
import { resolveIdentity, sha256HexText } from "@canlang/identity";
import { createFrozenClock, createMemoryIdentityStore } from "@canlang/identity/testing";
import { createD1Storage, ensureSchema } from "../../../state/dist/state/src/storage/d1.js";
import { buildInvoker } from "../worker/assembly.js";
import type { AssembledModules } from "../worker/assembly.js";

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
  const dir = mkdtempSync(join(here, "t17b-dfix-"));
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
export function canApp() {
  return {
    policy: {
      operations: {
        "acme.Todo.create": { by: ["members"] },
        "acme.Shop.place": { by: ["members"] }
      },
      models: {
        "acme.Todo": { read: ["Todo.read.1"], public: ["Todo.read.1"] },
        "acme.Sealed": { read: ["Sealed.read.1"] }
      }
    },
    Todo: {
      create: async () => { throw new Error("t17b-proof: CRUD handler must never run"); }
    },
    Shop: {
      place: async (c, input) => {
        const row = await create(c, "acme.Todo", { id: input.inputs.key, data: { title: input.inputs.title } });
        const updated = await set(c, "acme.Todo", row.id, { done: true });
        const seen = await records(c, "acme.Todo");
        return { id: updated.id, version: updated.version, count: seen.length };
      }
    }
  };
}
`;

function durableArtifact(module: string): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "t17b-fixture/0 (hand-written T15a shape; NOT compiler output)",
    tool_version: "t17b-fixture/0",
    sources: [{ path: "examples/TeamTasks.can", sha256: "fixture-not-a-digest" }],
    modules: [],
    callables: [
      { id: "acme.Todo.create", kind: "operation", module, export: "Todo_create", member: ["Todo", "create"] },
      { id: "acme.Shop.place", kind: "operation", module, export: "Shop_place", member: ["Shop", "place"] },
    ],
    pages: [],
    requires: [],
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
      { name: "acme.Sealed.read", kind: "read", description: "", inputs: { fields: [] } },
      {
        name: "acme.Shop.place",
        kind: "scenario",
        description: "",
        inputs: {
          fields: [
            { name: "key", field: { kind: "string" }, required: true },
            { name: "title", field: { kind: "string" }, required: true },
          ],
        },
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
      {
        name: "acme.Sealed",
        fields: [{ name: "title", required: true, serverOnly: false, field: { kind: "string" } }],
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
  readonly memberToken: string;
}

async function seedIdentity(): Promise<SeededIdentity> {
  const now = Date.now();
  const clock = createFrozenClock(now);
  const store = createMemoryIdentityStore({ clock });
  const team = await store.createTeam({});
  const member = await store.createUser({
    email: "member@t17b.test",
    password_hash: "x",
    email_verified: true,
  });
  await store.createMembership({
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
  return { now, store, teamId: team.team_id, memberId: member.user_id, memberToken };
}

/* ------------------------------------------------------------------ */
/* Miniflare D1 lifecycle (T17a durable pattern).                       */
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

before(async () => {
  d1mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: ["DB"],
  });
  d1db = await d1mf.getD1Database("DB");
  await ensureSchema(d1db);
});

after(async () => {
  await cleanupTempDirs();
  if (d1mf !== undefined) {
    await d1mf.dispose();
    d1mf = undefined;
  }
});

describe("T17b durable L7 (scenario staging + reads on real D1)", () => {
  it("persists staged writes, receipt, and history with cross-handle read-back", async () => {
    await resetD1();
    await cleanupTempDirs();
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", DURABLE_MODULE);
    const asm: AssembledModules = { dir, entryUrl: "fixture-entry", moduleUrls: { "ops.mjs": url } };
    const artifact = durableArtifact("ops.mjs");
    const store: StoragePort = createD1Storage(d1db);
    const seed = await seedIdentity();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity: ResolvedIdentity = await resolveIdentity(
      seed.store,
      { session_token: seed.memberToken },
      { clock: { nowMs: () => seed.now } },
    );
    const operationId = freshOperationId(seed.now);
    const envelope: MutationEnvelope = {
      operation: "acme.Shop.place",
      operation_id: operationId as OperationId,
      inputs: { key: "t-d1", title: "durable" },
    };
    const outcome = await invoker.invokeMutation(envelope, identity);
    assert.ok("result" in outcome, `want result, got ${JSON.stringify(outcome)}`);
    assert.equal((outcome.result as MutationResult).status, "committed");
    assert.deepEqual((outcome.result as MutationResult).result, {
      id: "t-d1",
      version: 2,
      count: 1,
    });
    // Cross-handle read-back: a FRESH storage handle over the same D1
    // observes the rows, the receipt, the history, and the served
    // read — the persist-channel proof (not the writer's cache).
    const fresh: StoragePort = createD1Storage(d1db);
    const row = await fresh.load("acme.Todo" as ModelName, "t-d1" as RecordId);
    assert.equal(row?.version, 2);
    assert.deepEqual(row?.data, { title: "durable", done: true });
    const receipt = await fresh.readReceipt({
      app: "TeamTasks",
      owner: seed.teamId,
      principal: seed.memberId,
      operation: "acme.Shop.place" as OperationName,
      operationId: operationId as OperationId,
    });
    assert.ok(receipt !== null, "durable receipt must be readable cross-handle");
    assert.equal(receipt?.outcome.status, "committed");
    const trail = await fresh.historyFor("acme.Todo" as ModelName, "t-d1" as RecordId);
    assert.deepEqual(
      trail.map((entry) => [entry.change, entry.version, entry.operationId]),
      [
        ["create", 1, operationId],
        ["update", 2, operationId],
      ],
    );
    const freshInvoker = buildInvoker(artifact, asm, fresh, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const served = await freshInvoker.invokeRead({ operation: "acme.Todo.read", inputs: {} }, identity);
    assert.ok("result" in served, `want served reads, got ${JSON.stringify(served)}`);
    const result = served.result as { records: Array<{ data: Record<string, unknown> }>; revision: number };
    assert.equal(result.records.length, 1);
    assert.deepEqual(result.records[0]?.data, { title: "durable", done: true });
    assert.equal(result.revision, 1);
    assert.equal(await fresh.readRevision(), 1);
  });

  it("replays duplicate scenario delivery exactly once on D1", async () => {
    await resetD1();
    await cleanupTempDirs();
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", DURABLE_MODULE);
    const asm: AssembledModules = { dir, entryUrl: "fixture-entry", moduleUrls: { "ops.mjs": url } };
    const artifact = durableArtifact("ops.mjs");
    const store: StoragePort = createD1Storage(d1db);
    const seed = await seedIdentity();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity: ResolvedIdentity = await resolveIdentity(
      seed.store,
      { session_token: seed.memberToken },
      { clock: { nowMs: () => seed.now } },
    );
    const operationId = freshOperationId(seed.now);
    const envelope: MutationEnvelope = {
      operation: "acme.Shop.place",
      operation_id: operationId as OperationId,
      inputs: { key: "t-race", title: "once" },
    };
    const [first, second] = await Promise.all([
      invoker.invokeMutation(envelope, identity),
      invoker.invokeMutation(envelope, identity),
    ]);
    assert.ok("result" in first && "result" in second, "both deliveries answer");
    assert.deepEqual(
      [(first.result as MutationResult).status, (second.result as MutationResult).status].sort(),
      ["committed", "replayed"],
    );
    const fresh: StoragePort = createD1Storage(d1db);
    const rows = await fresh.query({ model: "acme.Todo" as ModelName, authority: "owner" });
    assert.equal(rows.length, 1);
    assert.equal(await fresh.readRevision(), 1);
  });

  it("refuses ruled-model reads on the durable path without touching revisions", async () => {
    await resetD1();
    await cleanupTempDirs();
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", DURABLE_MODULE);
    const asm: AssembledModules = { dir, entryUrl: "fixture-entry", moduleUrls: { "ops.mjs": url } };
    const artifact = durableArtifact("ops.mjs");
    const store: StoragePort = createD1Storage(d1db);
    const seed = await seedIdentity();
    const invoker = buildInvoker(artifact, asm, store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const identity: ResolvedIdentity = await resolveIdentity(
      seed.store,
      { session_token: seed.memberToken },
      { clock: { nowMs: () => seed.now } },
    );
    const outcome = await invoker.invokeRead({ operation: "acme.Sealed.read", inputs: {} }, identity);
    assert.ok("error" in outcome, "ruled read must refuse");
    assert.equal(outcome.error.code, "validation");
    assert.match(outcome.error.message, /T04b carries generated policy/);
    assert.equal(await store.readRevision(), 0);
  });
});
