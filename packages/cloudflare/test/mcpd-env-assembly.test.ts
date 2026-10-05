/**
 * P-C production McpDeps tests (`src/runtime/env-assembly.ts` +
 * `src/runtime/grant-route.ts` + `src/runtime/mcp-permissions.ts`).
 *
 * Failing-first: written before the modules existed. Drives REAL
 * workerd D1 (miniflare, via the owned `startLocalDev` seam — same
 * precedent as `tests/integration/b2-d1-fence.test.ts`) and proves:
 *
 * - `buildProductionDeps(env)` builds a working `StoragePort` from
 *   `env.DB` plus the D1-backed `IdentityStore`, applying the state
 *   schema and the identity schema (T17c: the INTERIM todo/note DDL
 *   step was retired with `INTERIM_DDL` — the engine stores every
 *   model in its generic `records` table, so the two engine ensures
 *   are the whole constructor).
 * - A real grant minted through `handleMcpGrant` over that D1 store
 *   yields a NON-EMPTY `tools/list` plus a successful `tools/call`
 *   through the ASSEMBLED worker with production member permissions
 *   (absent operations[] and deny-closed both look deployed-but-dead,
 *   so non-empty discovery is pinned, not just 200s).
 * - Unknown and revoked grants 401 with the safe
 *   `{ error: { code, message } }` shape; membership removal ends
 *   grant admission.
 * - A refused-verdict worker still serves 500 `activation-refused`
 *   on `/mcp` even with production McpDeps (activation-refusal
 *   patterns reused).
 *
 * Static conformance: the `IdentityStore` mirror in env-assembly.ts
 * is mutually assignable with the REAL identity `IdentityStore`
 * (both directions compile or the test file fails the root check),
 * and a real `D1Database` satisfies the store's minimal D1 surface.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import type {
  ActivationVerdict,
  CompileArtifact,
  StoragePort,
} from "@canlang/contracts";
import { buildSessionCookie, sha256HexText } from "@canlang/identity";
import type {
  IdentityD1Database,
  IdentityStore as RealIdentityStore,
} from "@canlang/identity";
import { createMcpHandler } from "../../interfaces/dist/interfaces/src/mcp/server.js";
import type { McpDeps as RealMcpDeps } from "../../interfaces/dist/interfaces/src/ports.js";
import { startLocalDev, type LocalDev } from "../src/dev/local-run.js";
import {
  assembleWorker,
  type AssembledModules,
  type AssemblyDeps,
  type McpHandlerFactory,
} from "../src/worker/assembly.js";
import {
  buildProductionDeps,
  type IdentityStore as MirrorIdentityStore,
} from "../src/runtime/env-assembly.js";
import { handleMcpGrant } from "../src/runtime/grant-route.js";
import { createMemberMcpPermissions } from "../src/runtime/mcp-permissions.js";

/* ------------------------------------------------------------------ */
/* Static conformance (compile-time; no runtime code).                  */
/* ------------------------------------------------------------------ */

/** The mirror accepts the real store (P-A passes the D1 store through). */
const _mirrorAcceptsReal: MirrorIdentityStore = null as unknown as RealIdentityStore;
/** The real type accepts the mirror (bundle entries feed createMcpHandler). */
const _realAcceptsMirror: RealIdentityStore = null as unknown as MirrorIdentityStore;
void _mirrorAcceptsReal;
void _realAcceptsMirror;

/** A genuine D1 binding satisfies the store's minimal D1 surface. */
function d1SatisfiesStoreSurface(db: D1Database): IdentityD1Database {
  return db;
}

const _factoryShape: McpHandlerFactory = (deps) =>
  createMcpHandler(deps as unknown as RealMcpDeps);

/* ------------------------------------------------------------------ */
/* Fixtures (hand-written; NOT compiler output).                        */
/* ------------------------------------------------------------------ */

const READ_OP = "acme.Todo.read";
const MUT_OP = "acme.Todo.create";

const tempDirs: string[] = [];
const devs: LocalDev[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const dev of devs.splice(0)) {
    await dev.dispose();
  }
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "canlang-mcpd-c-")));
  tempDirs.push(dir);
  return dir;
}

async function startD1(name: string): Promise<{ dev: LocalDev; db: D1Database }> {
  const dev = await startLocalDev({
    workerName: name,
    compatibilityDate: "2026-07-15",
    mainModule: "worker.mjs",
    modules: {
      "worker.mjs": `export default { async fetch() { return Response.json({ ready: true }); } }`,
    },
    d1Databases: [{ binding: "DB", id: name }],
  });
  devs.push(dev);
  const db = await dev.getD1Database("DB");
  // Compile-time proof the real binding fits the store surface.
  void d1SatisfiesStoreSurface(db);
  return { dev, db };
}

function fixtureArtifact(): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "mcpd-c-fixture/0 (hand-written; NOT compiler output)",
    tool_version: "mcpd-c-fixture/0",
    sources: [{ path: "examples/TeamTasks.can", sha256: "fixture-not-a-digest" }],
    modules: [],
    callables: [
      { id: READ_OP, kind: "operation", module: "ops.mjs", export: "todoRead", member: ["todoRead"] },
      { id: MUT_OP, kind: "operation", module: "ops.mjs", export: "todoCreate", member: ["todoCreate"] },
    ],
    pages: [],
    requires: [],
    tests: [],
    operations: [
      { name: READ_OP, kind: "read", description: "Read todos.", inputs: { fields: [] } },
      {
        name: MUT_OP,
        kind: "create",
        description: "Create a todo.",
        inputs: {
          fields: [{ name: "title", field: { kind: "string" }, required: true }],
        },
      },
    ],
    // T17c: T15a model descriptors (hand-written; NOT compiler output).
    // The interim bridge served descriptor-less artifacts; the canonical
    // path needs the model table, so the shared fixture carries it.
    models: [
      {
        name: "acme.Todo",
        fields: [{ name: "title", required: true, serverOnly: false, field: { kind: "string" } }],
        deleteMode: "remove",
      },
    ],
  } as unknown as CompileArtifact;
}

const OPS_SOURCE = `export function canApp() {
  return {
    todoRead: async (c, input) => ({ rows: [{ id: "t1", title: "fixture" }], caller: c.caller.userId, inputs: input.inputs }),
    todoCreate: async (c, input) => ({ status: "committed", operation_id: input.operation_id, title: input.inputs.title, caller: c.caller.userId }),
  };
}
`;
// T17c: CRUD operations SKIP their handlers on the canonical path (the
// pipeline executes), so the echoes above never run — the module still
// must export canApp() for policy transcription (absent policy admits
// public).

function stubAsm(): AssembledModules {
  const dir = tempDir();
  const file = join(dir, "ops.mjs");
  writeFileSync(file, OPS_SOURCE);
  return { dir, entryUrl: "fixture-entry", moduleUrls: { "ops.mjs": pathToFileURL(file).href } };
}

async function seedSessionTeam(
  identityStore: MirrorIdentityStore,
  email: string,
): Promise<{ userId: string; teamId: string; cookie: string }> {
  const user = await identityStore.createUser({
    email,
    password_hash: "test-hash-opaque",
    email_verified: true,
  });
  const team = await identityStore.createTeam({});
  await identityStore.createMembership({
    team_id: team.team_id,
    user_id: user.user_id,
    is_owner: true,
    roles: [],
  });
  const token = `mcpd-c-session-${email}-${randomBytes(8).toString("hex")}`;
  await identityStore.createSession({
    user_id: user.user_id,
    token_sha256: await sha256HexText(token),
    expires_at: "2030-01-01T00:00:00.000Z",
    last_team_id: team.team_id,
  });
  const cookie = buildSessionCookie(token, { maxAgeSeconds: 3600, secure: false });
  return { userId: user.user_id, teamId: team.team_id, cookie };
}

async function mintGrant(
  identityStore: MirrorIdentityStore,
  cookie: string,
): Promise<{ token: string; grant_id: string; user_id: string; team_id: string }> {
  const res = await handleMcpGrant(
    new Request("https://test.invalid/mcp/grant", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ client_id: "mcpd-c-host" }),
    }),
    { identityStore },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; grant_id: string; user_id: string; team_id: string };
}

async function assembleProductionMcp(opts: {
  store: StoragePort;
  identityStore: MirrorIdentityStore;
  artifact: CompileArtifact;
  asm: AssembledModules;
  verdict?: ActivationVerdict;
}): Promise<(req: Request) => Promise<Response>> {
  const deps: AssemblyDeps = {
    store: opts.store,
    identityStore: opts.identityStore,
    mcp: {
      createHandler: _factoryShape,
      permissions: createMemberMcpPermissions(opts.artifact),
    },
  };
  const assembled = await assembleWorker(artifactSafe(opts.artifact), opts.asm, deps, opts.verdict ?? { active: true });
  return assembled.fetch;
}

function artifactSafe(artifact: CompileArtifact): CompileArtifact {
  return artifact;
}

let nextId = 1;

async function mcpCall(
  fetch: (req: Request) => Promise<Response>,
  method: string,
  params: Record<string, unknown>,
  opts: { grant?: string } = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (opts.grant !== undefined) headers["authorization"] = `Bearer ${opts.grant}`;
  const res = await fetch(
    new Request("https://test.invalid/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers };
}

/** Fresh canonical UUIDv7 operation_id with the time field at `atMs`. */
function freshOperationId(atMs: number = Date.now()): string {
  const timeHex = atMs.toString(16).padStart(12, "0");
  const rand = randomBytes(10).toString("hex");
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

/* ------------------------------------------------------------------ */
/* Constructor proofs.                                                  */
/* ------------------------------------------------------------------ */

describe("buildProductionDeps", () => {
  it("rejects a missing or misshapen env.DB loudly", async () => {
    await expect(buildProductionDeps({})).rejects.toThrow(/env\.DB/);
    await expect(buildProductionDeps({ DB: null })).rejects.toThrow(/env\.DB/);
    await expect(buildProductionDeps({ DB: {} })).rejects.toThrow(/env\.DB/);
    await expect(buildProductionDeps({ DB: "d1://nope" })).rejects.toThrow(/env\.DB/);
  });

  it("builds a working store + identity store over real D1, schemas ensured", async () => {
    const { db } = await startD1("mcpd-c-ctor");
    const deps = await buildProductionDeps({ DB: db });

    // StoragePort wiring: revision reads on a fresh database.
    expect(await deps.store.readRevision()).toBe(0);

    // IdentityStore wiring: team round-trip through D1.
    const team = await deps.identityStore.createTeam({});
    expect((await deps.identityStore.findTeamById(team.team_id))?.team_id).toBe(team.team_id);

    // Every ensure step landed: the state engine tables and the
    // identity tables. T17c (rule b): the INTERIM demo tables (`todo`,
    // `note`) were retired with `INTERIM_DDL` — the engine stores every
    // model in its generic `records` table — so their presence pin is
    // replaced by a generic-records expectation plus absence pins.
    const tables = await db
      .prepare("SELECT name AS name FROM sqlite_master WHERE type = 'table'")
      .all<{ name: string }>();
    const names = new Set(tables.results.map((row) => row.name));
    for (const expected of ["records", "fence_log", "identity_users", "identity_mcp_grants"]) {
      expect(names.has(expected), `table ${expected} exists`).toBe(true);
    }
    for (const retired of ["todo", "note"]) {
      expect(names.has(retired), `retired table ${retired} is gone`).toBe(false);
    }

    // Idempotent: a second construction re-runs every ensure safely.
    const again = await buildProductionDeps({ DB: db });
    expect(await again.store.readRevision()).toBe(0);
    expect((await again.identityStore.findTeamById(team.team_id))?.team_id).toBe(team.team_id);
  });
});

/* ------------------------------------------------------------------ */
/* Production grant -> non-empty discovery + call.                      */
/* ------------------------------------------------------------------ */

describe("production grant through the assembled worker", () => {
  it("lists a NON-EMPTY toolset and completes a tools/call for a member grant", async () => {
    const { db } = await startD1("mcpd-c-member");
    const deps = await buildProductionDeps({ DB: db });
    const { cookie } = await seedSessionTeam(deps.identityStore, "member@test.example");
    const grant = await mintGrant(deps.identityStore, cookie);
    const artifact = fixtureArtifact();
    const fetch = await assembleProductionMcp({
      store: deps.store,
      identityStore: deps.identityStore,
      artifact,
      asm: stubAsm(),
    });

    const list = await mcpCall(fetch, "tools/list", {}, { grant: grant.token });
    expect(list.status).toBe(200);
    expect(list.body["error"]).toBeUndefined();
    const tools = (
      list.body["result"] as { tools: Array<{ name: string; description: string }> }
    ).tools;
    // PINNED: deployed-but-dead (empty discovery) is a failure, not a pass.
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((tool) => tool.name).sort()).toEqual([MUT_OP, READ_OP].sort());

    // T17c (rule a): was the interim bridge echo; now a canonical
    // CRUD create over the production D1 store (row id ===
    // operation_id by the create convention).
    const operationId = freshOperationId();
    const call = await mcpCall(
      fetch,
      "tools/call",
      { name: MUT_OP, arguments: { operation_id: operationId, title: "via-grant" } },
      { grant: grant.token },
    );
    expect(call.status).toBe(200);
    expect(call.body["error"]).toBeUndefined();
    const payload = call.body["result"] as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    expect(payload.isError).not.toBe(true);
    expect(JSON.stringify(payload)).toContain("via-grant");
    const committed = JSON.parse(payload.content[0]?.text ?? "null") as {
      status: string;
      operation_id: string;
      result: { id: string; data: Record<string, unknown> };
    };
    expect(committed.status).toBe("committed");
    expect(committed.operation_id).toBe(operationId);
    expect(committed.result.id).toBe(operationId);
    expect(committed.result.data).toEqual({ title: "via-grant" });
  });

  it("401s unknown and revoked grants with the safe error shape", async () => {
    const { db } = await startD1("mcpd-c-401");
    const deps = await buildProductionDeps({ DB: db });
    const { cookie } = await seedSessionTeam(deps.identityStore, "holder@test.example");
    const grant = await mintGrant(deps.identityStore, cookie);
    const artifact = fixtureArtifact();
    const fetch = await assembleProductionMcp({
      store: deps.store,
      identityStore: deps.identityStore,
      artifact,
      asm: stubAsm(),
    });

    const bogus = await mcpCall(fetch, "tools/list", {}, { grant: "bogus-not-a-grant" });
    expect(bogus.status).toBe(401);
    expect(bogus.body["error"]).toEqual({
      code: "forbidden",
      message: "Session expired or revoked.",
    });
    expect(bogus.headers.get("www-authenticate")).toContain("Bearer");

    await deps.identityStore.revokeMcpGrant(grant.grant_id);
    const revoked = await mcpCall(fetch, "tools/list", {}, { grant: grant.token });
    expect(revoked.status).toBe(401);
    expect(revoked.body["error"]).toEqual({
      code: "forbidden",
      message: "Session expired or revoked.",
    });
  });

  it("ends grant admission when the membership is removed", async () => {
    const { db } = await startD1("mcpd-c-removed");
    const deps = await buildProductionDeps({ DB: db });
    const { cookie, userId, teamId } = await seedSessionTeam(deps.identityStore, "leaver@test.example");
    const grant = await mintGrant(deps.identityStore, cookie);
    const artifact = fixtureArtifact();
    const fetch = await assembleProductionMcp({
      store: deps.store,
      identityStore: deps.identityStore,
      artifact,
      asm: stubAsm(),
    });

    const before = await mcpCall(fetch, "tools/list", {}, { grant: grant.token });
    expect(before.status).toBe(200);

    const membership = await deps.identityStore.findMembership(teamId, userId);
    expect(membership === null).toBe(false);
    if (membership !== null) {
      await deps.identityStore.removeMembership(membership.membership_id);
    }
    const after = await mcpCall(fetch, "tools/list", {}, { grant: grant.token });
    expect(after.status).toBe(401);
  });
});

/* ------------------------------------------------------------------ */
/* Refused verdict still refuses (activation-refusal patterns).         */
/* ------------------------------------------------------------------ */

describe("refused verdict with production McpDeps", () => {
  it("serves 500 activation-refused on /mcp, naming the FIRST reason", async () => {
    const { db } = await startD1("mcpd-c-refused");
    const deps = await buildProductionDeps({ DB: db });
    const { cookie } = await seedSessionTeam(deps.identityStore, "refused@test.example");
    const grant = await mintGrant(deps.identityStore, cookie);
    const artifact = fixtureArtifact();
    const failed: ActivationVerdict = {
      active: false,
      reasons: [
        { code: "missing-capability", detail: "values.decimal is not installed" },
        { code: "digest-mismatch", detail: "second reason stays unnamed" },
      ],
    };
    const fetch = await assembleProductionMcp({
      store: deps.store,
      identityStore: deps.identityStore,
      artifact,
      asm: stubAsm(),
      verdict: failed,
    });

    const res = await mcpCall(fetch, "tools/list", {}, { grant: grant.token });
    expect(res.status).toBe(500);
    expect(res.body["code"]).toBe("activation-refused");
    expect(res.body["reason"]).toBe("missing-capability");
    expect(res.body["detail"]).toBe("values.decimal is not installed");
    expect(JSON.stringify(res.body)).not.toContain("second reason stays unnamed");

    const page = await fetch(new Request("https://test.invalid/"));
    expect(page.status).toBe(500);
    expect(((await page.json()) as { code: string }).code).toBe("activation-refused");
  });
});
