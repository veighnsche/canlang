/**
 * Worker assembly tests (`src/worker/assembly.ts`).
 *
 * The fixture artifacts below are HAND-WRITTEN JSON, honestly labeled: NOT
 * compiler output (`tool_version: "assembly-fixture/0"`). Stub page modules
 * are temp `.mjs` files holding hand-written descriptors.
 *
 * The journey suite is the opposite: the REAL L4 file kernel behind the
 * REAL interfaces upload routes (cross-package source imports are
 * test-only — the worker boundary still forbids them from `src/`).
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CompileArtifact,
  MutationResult,
  OperationId,
  ResolvedIdentity,
  StoragePort,
} from "@canlang/contracts";
// `@canlang/identity` resolves via workspace link to its built dist (root
// `build` builds it before typecheck/test). Test-only: `src/` stays
// boundary-clean.
import { deriveCsrfToken, resolveIdentity, sha256HexText } from "@canlang/identity";
import { createFrozenClock, createMemoryIdentityStore } from "@canlang/identity/testing";
import { createTestMemoryStorage } from "../../state/dist/state/src/storage/memory.js";
import {
  assembleWorker,
  buildInvoker,
  type AssembledModules,
  type AssemblyDeps,
  type InterimFilesBinding,
  type MutationOutcome,
} from "../src/worker/assembly.js";
// Cross-package journey tests import interfaces DIST (never src): src imports
// would drag pre-existing producer strictness gaps into this lane-07 check
// program. Root `build` builds interfaces dist first (see package.json).
import {
  createFileJourneyKernel,
  type FileJourneyBindings,
} from "../../interfaces/dist/interfaces/src/uploads/kernel.js";
import { receiverFromIdentity } from "../../interfaces/dist/interfaces/src/uploads/principals.js";
import { handleUploadRequest } from "../../interfaces/dist/interfaces/src/uploads/routes.js";
import { createTestUploadDeps, testRequest } from "../../interfaces/dist/interfaces/src/testing.js";
import {
  TestOnlyCounterFileIds,
  TestOnlyCounterIntentIds,
  TestOnlyManualClock,
  TestOnlyMemoryBlobStore,
  TestOnlyMemoryFinalizedStore,
  TestOnlyMemoryIntentStore,
} from "../../files/src/ports.ts";
import {
  appendUploadContent,
  completeUploadContent,
  createUploadIntent,
  DEFAULT_FILE_POLICY,
  sha256Hex,
  type UploadDeps,
} from "../../files/src/upload/index.ts";
import {
  authorizeAttach,
  finalizeUpload,
  readFinalizedBytes,
  readFinalizedFile,
  recordAttachment,
  type FinalizeDeps,
} from "../../files/src/finalize/index.ts";

const FIXED_NOW = 1767225600000;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  // realpath: macOS tmpdir() is a /var symlink; resolve it so module URLs
  // are canonical for every loader.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "canlang-assembly-")));
  tempDirs.push(dir);
  return dir;
}

function writeModule(dir: string, name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source);
  return pathToFileURL(path).href;
}

function stubStore(): StoragePort {
  return { readRevision: async () => 0 } as unknown as StoragePort;
}

function stubDeps(): AssemblyDeps {
  return { store: stubStore(), identityStore: {}, now: () => FIXED_NOW };
}

function stubAsm(dir: string, moduleUrls: Record<string, string>): AssembledModules {
  return { dir, entryUrl: "fixture-entry", moduleUrls };
}

function fixtureArtifact(
  pages: CompileArtifact["pages"],
  callables: CompileArtifact["callables"],
): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "assembly-fixture/0 (hand-written; NOT compiler output)",
    tool_version: "assembly-fixture/0",
    sources: [{ path: "examples/TeamTasks.can", sha256: "fixture-not-a-digest" }],
    modules: [],
    callables,
    pages,
    requires: [],
    tests: [],
  };
}

function anonymousIdentity(): ResolvedIdentity {
  return {
    actor: null,
    team: null,
    membership: null,
    binding: { kind: "none" },
    admitted_at: "2026-01-01T00:00:00.000Z",
  };
}

const VALID_PAGE_SOURCE = `export const home = {
  owner: "fixture",
  path: "/",
  title: "Home",
  admit: async () => ({}),
  render: async () => "<h1>fixture-home</h1>",
};
`;

async function expectPageModuleFailure(
  assembly: Promise<unknown>,
  pagePath: string,
  module: string,
): Promise<void> {
  await expect(assembly).rejects.toThrow(`page "${pagePath}" module "${module}"`);
}

describe("assembleWorker", () => {
  it("assembles a 1-page/1-op fixture and serves the page", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "home.mjs", VALID_PAGE_SOURCE);
    const artifact = fixtureArtifact(
      [{ owner: "fixture", path: "/", module: "home.mjs", export: "home" }],
      [{ id: "fixture.demo", kind: "operation", module: "ops.mjs", export: "demo", member: ["demo"] }],
    );
    const assembled = await assembleWorker(
      artifact,
      stubAsm(dir, { "home.mjs": url }),
      stubDeps(),
      { active: true },
    );

    expect(assembled.pageCount).toBe(1);
    expect(assembled.opCount).toBe(1);
    expect(typeof assembled.fetch).toBe("function");

    const get = await assembled.fetch(new Request("http://localhost/"));
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toContain("text/html");
    expect(await get.text()).toContain("fixture-home");

    const head = await assembled.fetch(new Request("http://localhost/", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const missing = await assembled.fetch(new Request("http://localhost/nope"));
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe("not_found");

    const slashed = await assembled.fetch(new Request("http://localhost/nope/?a=1"));
    expect(slashed.status).toBe(308);
    expect(slashed.headers.get("location")).toBe("/nope?a=1");
  });

  it("fails loud naming page+module when the module URL is missing", async () => {
    const dir = tempDir();
    const artifact = fixtureArtifact(
      [{ owner: "fixture", path: "/gone", module: "gone.mjs", export: "page" }],
      [],
    );
    await expectPageModuleFailure(
      assembleWorker(artifact, stubAsm(dir, {}), stubDeps(), { active: true }),
      "/gone",
      "gone.mjs",
    );
  });

  it("fails loud naming page+module when the export binding is missing", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "other.mjs", `export const other = {};\n`);
    const artifact = fixtureArtifact(
      [{ owner: "fixture", path: "/gone", module: "other.mjs", export: "page" }],
      [],
    );
    await expectPageModuleFailure(
      assembleWorker(artifact, stubAsm(dir, { "other.mjs": url }), stubDeps(), { active: true }),
      "/gone",
      "other.mjs",
    );
  });

  it("fails loud naming page+module on owner mismatch", async () => {
    const dir = tempDir();
    const url = writeModule(
      dir,
      "owner.mjs",
      `export const page = { owner: "other-owner", path: "/wrong-owner", title: "x", admit: async () => ({}), render: async () => "x" };\n`,
    );
    const artifact = fixtureArtifact(
      [{ owner: "fixture", path: "/wrong-owner", module: "owner.mjs", export: "page" }],
      [],
    );
    await expectPageModuleFailure(
      assembleWorker(artifact, stubAsm(dir, { "owner.mjs": url }), stubDeps(), { active: true }),
      "/wrong-owner",
      "owner.mjs",
    );
  });

  it("fails loud naming page+module when render-shape is wrong", async () => {
    const dir = tempDir();
    const url = writeModule(
      dir,
      "render.mjs",
      `export const page = { owner: "fixture", path: "/no-render", title: "x", admit: async () => ({}) };\n`,
    );
    const artifact = fixtureArtifact(
      [{ owner: "fixture", path: "/no-render", module: "render.mjs", export: "page" }],
      [],
    );
    await expectPageModuleFailure(
      assembleWorker(artifact, stubAsm(dir, { "render.mjs": url }), stubDeps(), { active: true }),
      "/no-render",
      "render.mjs",
    );
  });

  it("rejects unsupported artifact versions precisely", async () => {
    const dir = tempDir();
    // Deliberately mistyped input: the assembly must reject it at runtime.
    const artifact = {
      ...fixtureArtifact([], []),
      artifact_version: 2,
    } as unknown as CompileArtifact;
    await expect(
      assembleWorker(artifact, stubAsm(dir, {}), stubDeps(), { active: true }),
    ).rejects.toThrow("unsupported artifact_version");
  });

  it("rejects unknown callable kinds precisely", async () => {
    const dir = tempDir();
    // Deliberately mistyped input: the assembly must reject it at runtime.
    const weird = { id: "fixture.weird", kind: "spell", module: "x.mjs", export: "y" };
    const artifact = fixtureArtifact([], [weird] as unknown as CompileArtifact["callables"]);
    await expect(assembleWorker(artifact, stubAsm(dir, {}), stubDeps(), { active: true })).rejects.toThrow(
      "unknown callable kind",
    );
  });

  it("requires deps.store and deps.identityStore", async () => {
    const dir = tempDir();
    const artifact = fixtureArtifact([], []);
    await expect(
      assembleWorker(
        artifact,
        stubAsm(dir, {}),
        {
          store: null as unknown as StoragePort,
          identityStore: {},
        },
        { active: true },
      ),
    ).rejects.toThrow("deps.store is required");
    await expect(
      assembleWorker(
        artifact,
        stubAsm(dir, {}),
        { store: stubStore(), identityStore: null },
        { active: true },
      ),
    ).rejects.toThrow("deps.identityStore is required");
  });

  it("counts only operation callables toward opCount", async () => {
    const dir = tempDir();
    const artifact = fixtureArtifact([], [
      { id: "fixture.a", kind: "operation", module: "a.mjs", export: "a", member: ["a"] },
      { id: "fixture.b", kind: "operation", module: "b.mjs", export: "b", member: ["b"] },
      { id: "fixture.p", kind: "pure", module: "p.mjs", export: "p", member: ["p"] },
      { id: "fixture.r", kind: "rule", module: "r.mjs", export: "r", member: ["r"] },
    ]);
    const assembled = await assembleWorker(artifact, stubAsm(dir, {}), stubDeps(), { active: true });
    expect(assembled.pageCount).toBe(0);
    expect(assembled.opCount).toBe(2);
  });

  it("answers unjoined surfaces with an explicit interim 501", async () => {
    const dir = tempDir();
    const assembled = await assembleWorker(fixtureArtifact([], []), stubAsm(dir, {}), stubDeps(), { active: true });

    const op = await assembled.fetch(
      new Request("http://localhost/api/operations/demo.op", { method: "POST" }),
    );
    expect(op.status).toBe(501);
    const opBody = (await op.json()) as { code: string; message: string };
    expect(opBody.code).toBe("assembly-interim");
    expect(opBody.message).toContain("interfaces join");

    const auth = await assembled.fetch(new Request("http://localhost/auth/login"));
    expect(auth.status).toBe(501);
    expect(((await auth.json()) as { code: string }).code).toBe("assembly-interim");
  });
});

/* ------------------------------------------------------------------ */
/* T17c canonical invoker fixtures (buildInvoker pins only).           */
/*                                                                     */
/* T17 retired the interim direct bridge: descriptor-less artifacts    */
/* now refuse with `validation` on both envelopes. These pins prove    */
/* the SAME behaviors through canonical staging over a memory store    */
/* with a memory identity store for live membership reads.             */
/* ------------------------------------------------------------------ */

/** Fresh canonical UUIDv7 operation_id with the time field at `atMs`. */
function freshOperationId(atMs: number): string {
  const timeHex = atMs.toString(16).padStart(12, "0");
  const rand = randomBytes(10).toString("hex");
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

function canonicalModel(): unknown {
  return {
    name: "acme.Todo",
    fields: [{ name: "title", required: true, serverOnly: false, field: { kind: "string" } }],
    deleteMode: "remove",
  };
}

/** Hand-written T15a-shaped artifact (NOT compiler output): descriptors + callables. */
function scenarioArtifact(
  module: string,
  scenarios: ReadonlyArray<{ op: string; fn: string; params: ReadonlyArray<string> }>,
): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "t17c-fixture/0 (hand-written T15a shape; NOT compiler output)",
    tool_version: "t17c-fixture/0",
    sources: [{ path: "examples/TeamTasks.can", sha256: "fixture-not-a-digest" }],
    modules: [],
    callables: scenarios.map((s) => ({
      id: s.op,
      kind: "operation",
      module,
      export: `Shop_${s.fn}`,
      member: ["Shop", s.fn],
    })),
    pages: [],
    requires: [],
    tests: [],
    operations: scenarios.map((s) => ({
      name: s.op,
      kind: "scenario",
      description: "",
      inputs: {
        fields: s.params.map((name) => ({ name, field: { kind: "string" }, required: true })),
      },
    })),
    models: [canonicalModel()],
  } as unknown as CompileArtifact;
}

function mustResult(outcome: MutationOutcome): MutationResult {
  if ("result" in outcome) return outcome.result;
  throw new Error(`want result, got ${JSON.stringify(outcome)}`);
}

describe("buildInvoker", () => {
  it("success path threads identity facts and the live membership projection", async () => {
    // T17c (rule a): was the interim direct bridge (a fixed projection
    // array built from identity claims); now the canonical scenario
    // seam re-reads LIVE memberships. SAME behavior: the admitted
    // caller id + role facts reach the handler. The outcome now wraps
    // the handler value in the canonical `MutationResult`.
    const dir = tempDir();
    const url = writeModule(
      dir,
      "ops.mjs",
      `export function canApp() {
        return {
          // B7: the op declares its admission gate (absent policy
          // entries deny) so the member success path still commits.
          policy: { operations: { "fixture.echo": { by: ["members"] } } },
          Shop: { echo: async (c, input) => ({ echoed: input.operation_id, caller: c.caller.userId, member: c.memberships.includes("members") }) } };
      }`,
    );
    const artifact = scenarioArtifact("ops.mjs", [{ op: "fixture.echo", fn: "echo", params: [] }]);
    const now = Date.now();
    const clock = createFrozenClock(now);
    const idStore = createMemoryIdentityStore({ clock });
    const team = await idStore.createTeam({});
    const owner = await idStore.createUser({
      email: "owner@t17c.test",
      password_hash: "x",
      email_verified: true,
    });
    await idStore.createMembership({
      team_id: team.team_id,
      user_id: owner.user_id,
      is_owner: true,
      roles: [],
    });
    const member = await idStore.createUser({
      email: "member@t17c.test",
      password_hash: "x",
      email_verified: true,
    });
    await idStore.createMembership({
      team_id: team.team_id,
      user_id: member.user_id,
      is_owner: false,
      roles: [{ role: "members", granted_at: new Date(now).toISOString(), granted_by: owner.user_id }],
    });
    const token = `t17c-session-${randomBytes(8).toString("hex")}`;
    await idStore.createSession({
      user_id: member.user_id,
      token_sha256: await sha256HexText(token),
      expires_at: new Date(now + 3600_000).toISOString(),
      last_team_id: team.team_id,
    });
    const identity = await resolveIdentity(
      idStore,
      { session_token: token },
      { clock: { nowMs: () => now } },
    );
    const { store } = createTestMemoryStorage();
    const invoker = buildInvoker(artifact, stubAsm(dir, { "ops.mjs": url }), store, {
      memberships: idStore,
      now: () => now,
    });
    const operationId = freshOperationId(now);
    const committed = mustResult(
      await invoker.invokeMutation(
        { operation: "fixture.echo", operation_id: operationId as OperationId, inputs: {} },
        identity,
      ),
    );
    expect(committed.status).toBe("committed");
    expect(committed.result).toEqual({ echoed: operationId, caller: member.user_id, member: true });
  });

  it("gateless operations deny anonymous callers with typed denial", async () => {
    // B7 flip (joint decision overturns interim-exact ungated
    // admission): the op declares NO gate, so the absent entry
    // transcribes to {not: public} and the anonymous caller is
    // denied with the engine's owning reason — the handler never
    // runs, nothing commits. (The labeled-anonymous identity
    // mapping itself is unchanged; admission now refuses first.)
    const dir = tempDir();
    const url = writeModule(
      dir,
      "ops.mjs",
      `export function canApp() {
        return { Shop: { echo: async () => ({ never: true }) } };
      }`,
    );
    const artifact = scenarioArtifact("ops.mjs", [{ op: "fixture.echo", fn: "echo", params: [] }]);
    const now = Date.now();
    const idStore = createMemoryIdentityStore({ clock: createFrozenClock(now) });
    const { store } = createTestMemoryStorage();
    const invoker = buildInvoker(artifact, stubAsm(dir, { "ops.mjs": url }), store, {
      memberships: idStore,
      now: () => now,
    });
    const operationId = freshOperationId(now);
    const outcome = await invoker.invokeMutation(
      {
        operation: "fixture.echo",
        operation_id: operationId as OperationId,
        inputs: {},
      },
      anonymousIdentity(),
    );
    expect(outcome).toMatchObject({
      error: {
        code: "forbidden",
        message: "This operation is not permitted for the caller.",
        operation_id: operationId,
        retryable: false,
      },
    });
    expect(await store.readRevision()).toBe(0);
  });

  it("unknown operation rejects validation naming the operation", async () => {
    // T17c (rule a): was interim `rule_failed` naming the unknown
    // callable; the canonical registry rejects unknown operations with
    // `validation` naming the operation (engine text `Unknown
    // operation "X".`). The artifact stays generated so the registry
    // (not the descriptor-less refusal) answers.
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", `export function canApp() { return { Shop: {} }; }\n`);
    const artifact = scenarioArtifact("ops.mjs", [{ op: "fixture.echo", fn: "echo", params: [] }]);
    const now = Date.now();
    const idStore = createMemoryIdentityStore({ clock: createFrozenClock(now) });
    const { store } = createTestMemoryStorage();
    const invoker = buildInvoker(artifact, stubAsm(dir, { "ops.mjs": url }), store, {
      memberships: idStore,
      now: () => now,
    });
    const operationId = freshOperationId(now);
    const outcome = await invoker.invokeMutation(
      { operation: "fixture.demo", operation_id: operationId as OperationId, inputs: {} },
      anonymousIdentity(),
    );
    expect(outcome).toMatchObject({
      error: { code: "validation", operation_id: operationId, retryable: false },
    });
    expect((outcome as { error: { message: string } }).error.message).toContain(
      'Unknown operation "fixture.demo"',
    );
  });
});

// T17c: the INTERIM_DDL pin is DELETED with the artifact (rule b) — T17b
// retired the hand-written per-model demo DDL (see the
// `src/worker/assembly.ts` retirement note): the engine stores every
// model in its generic `records` table, so there is no DDL left to pin.

describe("interim files dispatch", () => {
  function spyFilesBinding(usesFiles: boolean): InterimFilesBinding & { calls: string[] } {
    const calls: string[] = [];
    const boom = (name: string): never => {
      calls.push(name);
      throw new Error(`spy kernel: ${name} must never be called by interim dispatch`);
    };
    return {
      calls,
      usesFiles,
      kernel: {
        maxBytes: () => boom("maxBytes"),
        createIntent: async () => boom("createIntent"),
        append: async () => boom("append"),
        complete: async () => boom("complete"),
        finalize: async () => boom("finalize"),
      },
    };
  }

  async function assembleWithFiles(files?: InterimFilesBinding) {
    const dir = tempDir();
    return assembleWorker(
      fixtureArtifact([], []),
      stubAsm(dir, {}),
      {
        ...stubDeps(),
        ...(files === undefined ? {} : { files }),
      },
      { active: true },
    );
  }

  function knownRoutes(): Request[] {
    return [
      new Request("http://localhost/files/intents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      new Request("http://localhost/files/content/intent-1", {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: "abcd",
      }),
      new Request("http://localhost/files/finalize/intent-1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    ];
  }

  it("known file routes without the binding answer 501 naming the files join", async () => {
    const assembled = await assembleWithFiles();
    for (const req of knownRoutes()) {
      const res = await assembled.fetch(req);
      expect(res.status).toBe(501);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("assembly-interim");
      expect(body.message).toContain("files join");
    }
  });

  it("known file routes with the binding answer 501 naming the identity join, kernel untouched", async () => {
    const binding = spyFilesBinding(true);
    const assembled = await assembleWithFiles(binding);
    for (const req of knownRoutes()) {
      const res = await assembled.fetch(req);
      expect(res.status).toBe(501);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("assembly-interim");
      expect(body.message).toContain("identity join");
    }
    expect(binding.calls).toEqual([]);
  });

  it("usesFiles=false answers not_found on all three routes, kernel untouched", async () => {
    const binding = spyFilesBinding(false);
    const assembled = await assembleWithFiles(binding);
    for (const req of knownRoutes()) {
      const res = await assembled.fetch(req);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("not_found");
      expect(body.message).toBe("Uploads unavailable.");
    }
    expect(binding.calls).toEqual([]);
  });

  it("a half-bound files binding still names the files join", async () => {
    // Deliberately mistyped input: the dispatcher must fail loud on it.
    const half = { usesFiles: true } as unknown as InterimFilesBinding;
    const assembled = await assembleWithFiles(half);
    const res = await assembled.fetch(
      new Request("http://localhost/files/intents", { method: "POST" }),
    );
    expect(res.status).toBe(501);
    expect(((await res.json()) as { message: string }).message).toContain("files join");
  });

  it("unknown /files paths and wrong methods are not_found without touching the kernel", async () => {
    const binding = spyFilesBinding(true);
    const assembled = await assembleWithFiles(binding);
    const reqs = [
      new Request("http://localhost/files/intents", { method: "GET" }),
      new Request("http://localhost/files/intents", { method: "PUT", body: "x" }),
      new Request("http://localhost/files/content/x", { method: "POST", body: "x" }),
      new Request("http://localhost/files/content/x", { method: "GET" }),
      new Request("http://localhost/files/finalize/x", { method: "PUT", body: "x" }),
      new Request("http://localhost/files/finalize/x", { method: "GET" }),
      new Request("http://localhost/files/nope", { method: "POST", body: "{}" }),
      new Request("http://localhost/files/content/", { method: "PUT", body: "x" }),
      new Request("http://localhost/files/content/a/b", { method: "PUT", body: "x" }),
      new Request("http://localhost/files/content/%E0%A4", { method: "PUT", body: "x" }),
    ];
    for (const req of reqs) {
      const res = await assembled.fetch(req);
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe("not_found");
    }
    expect(binding.calls).toEqual([]);
  });
});

describe("interim presentation mirror", () => {
  it("derives isPartial from HX-Request and mirrors context semantics", async () => {
    const dir = tempDir();
    const url = writeModule(
      dir,
      "cap.mjs",
      `export const page = {
        owner: "fixture",
        path: "/cap",
        title: "cap",
        admit: async () => ({}),
        render: async (ctx) => JSON.stringify({
          partial: ctx.isPartial,
          csrf: ctx.csrfToken,
          path: ctx.path,
          locales: ctx.preferredLocales,
          theme: ctx.theme.mode,
          anon: ctx.principal.actor === null,
          same: ctx.principal === ctx.invocation,
        }),
      };\n`,
    );
    const artifact = fixtureArtifact(
      [{ owner: "fixture", path: "/cap", module: "cap.mjs", export: "page" }],
      [],
    );
    const assembled = await assembleWorker(
      artifact,
      stubAsm(dir, { "cap.mjs": url }),
      stubDeps(),
      { active: true },
    );

    const full = await assembled.fetch(
      new Request("http://localhost/cap", { headers: { "accept-language": "fr-CA, fr;q=0.8" } }),
    );
    expect(full.status).toBe(200);
    expect(await full.json()).toEqual({
      partial: false,
      csrf: "",
      path: "/cap",
      locales: ["fr-CA", "fr"],
      theme: "system",
      anon: true,
      same: true,
    });

    const partial = await assembled.fetch(
      new Request("http://localhost/cap", { headers: { "HX-Request": "true" } }),
    );
    expect(partial.status).toBe(200);
    expect(((await partial.json()) as { partial: boolean }).partial).toBe(true);
  });
});

describe("real finalized-file journey (files -> uploads -> worker seams)", () => {
  const PDF = new TextEncoder().encode("%PDF-1.4\ntrailer\n");

  async function setupJourney() {
    const t = await createTestUploadDeps({});
    const csrf = await deriveCsrfToken(t.identity.sessionToken);
    const clock = new TestOnlyManualClock(Date.now());
    const intents = new TestOnlyMemoryIntentStore();
    const blobs = new TestOnlyMemoryBlobStore();
    const files = new TestOnlyMemoryFinalizedStore();
    const upload: UploadDeps = {
      clock,
      intentIds: new TestOnlyCounterIntentIds(),
      intents,
      blobs,
      policy: DEFAULT_FILE_POLICY,
      intentTtlMs: 15 * 60 * 1000,
      urlBase: "https://test.invalid",
    };
    const finalize: FinalizeDeps = {
      clock,
      fileIds: new TestOnlyCounterFileIds(),
      intents,
      blobs,
      files,
    };
    // Annotated: this is the J6 compile-time forcing function — the real
    // L4 entry points must satisfy the structural binding table.
    const bindings: FileJourneyBindings = {
      maxBytes: DEFAULT_FILE_POLICY.maxBytes,
      createIntent: (input) => createUploadIntent(upload, input),
      append: (intentId, caller, chunk) => appendUploadContent(upload, intentId, caller, chunk),
      complete: (intentId, caller) => completeUploadContent(upload, intentId, caller),
      finalize: (input) => finalizeUpload(finalize, input),
      readProvenance: (ref, caller) => readFinalizedFile(finalize, ref, caller),
      authorizeAttach: (ref, caller) => authorizeAttach(finalize, ref, caller),
      recordAttachment: (ref, recordRef, caller) =>
        recordAttachment(finalize, ref, recordRef, caller),
      readBytes: (ref, caller) => readFinalizedBytes(finalize, ref, caller),
    };
    const kernel = createFileJourneyKernel(bindings);
    return { t, deps: { ...t.deps, kernel }, kernel, csrf };
  }

  function intentBody(uploadId: string, size: number): Record<string, unknown> {
    return {
      upload_id: uploadId,
      operation: "shop.Order.create",
      field: "/attachment",
      arguments: {},
      name: "receipt.pdf",
      type: "application/pdf",
      size: String(size),
    };
  }

  async function postIntent(
    ctx: Awaited<ReturnType<typeof setupJourney>>,
    uploadId: string,
    size: number,
  ): Promise<{ intent_id: string; content: string; finalize: string; expires_at: string }> {
    const res = await handleUploadRequest(
      ctx.deps,
      testRequest("/files/intents", {
        method: "POST",
        cookie: ctx.t.identity.cookie,
        headers: { "content-type": "application/json", "x-csrf-token": ctx.csrf },
        body: JSON.stringify(intentBody(uploadId, size)),
      }),
    );
    expect(res.status).toBe(200);
    return (await res.json()) as {
      intent_id: string;
      content: string;
      finalize: string;
      expires_at: string;
    };
  }

  it("runs intent -> bytes -> finalize -> provenance -> attach/read with real bytes", async () => {
    const ctx = await setupJourney();
    const grant = await postIntent(ctx, "up-journey-1", PDF.length);
    expect(grant.content).toBe(`https://test.invalid/files/content/${grant.intent_id}`);
    expect(grant.finalize).toBe(`https://test.invalid/files/finalize/${grant.intent_id}`);

    const put = await handleUploadRequest(
      ctx.deps,
      testRequest(`/files/content/${grant.intent_id}`, {
        method: "PUT",
        cookie: ctx.t.identity.cookie,
        headers: { "content-type": "application/octet-stream", "x-csrf-token": ctx.csrf },
        body: PDF,
      }),
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({
      received_bytes: PDF.length,
      complete: true,
      check: { verdict: "accepted", detectedType: "application/pdf" },
    });

    const fin = await handleUploadRequest(
      ctx.deps,
      testRequest(`/files/finalize/${grant.intent_id}`, {
        method: "POST",
        cookie: ctx.t.identity.cookie,
        headers: { "content-type": "application/json", "x-csrf-token": ctx.csrf },
        body: JSON.stringify({ upload_id: "up-journey-1", bytes_digest: sha256Hex(PDF) }),
      }),
    );
    expect(fin.status).toBe(200);
    const { file: ref } = (await fin.json()) as { file: string };
    expect(typeof ref).toBe("string");

    const identity = await resolveIdentity(ctx.t.deps.identity.store, {
      session_token: ctx.t.identity.sessionToken,
    });
    const receiver = receiverFromIdentity("test-app", identity);

    const file = await ctx.kernel.readProvenance(ref, receiver);
    expect(file).not.toBeNull();
    expect(file?.provenance).toMatchObject({
      kind: "request",
      app: "test-app",
      principal: ctx.t.identity.userId,
      adapter: "bridge-v1",
      deliveryId: "up-journey-1",
      resultPath: "/attachment",
    });
    expect(Object.isFrozen(file)).toBe(true);
    expect(Object.isFrozen(file?.provenance)).toBe(true);

    await expect(ctx.kernel.authorizeAttach(ref, receiver)).resolves.toEqual({
      status: "authorized",
      ref,
    });
    await expect(ctx.kernel.recordAttachment(ref, "Expense_1", receiver)).resolves.toEqual({
      status: "attached",
      ref,
    });
    await expect(ctx.kernel.readBytes(ref, receiver)).resolves.toEqual(PDF);
  });

  it("fails loud at every unmet seam: invented intent, wrong digest, foreign reads, oversize", async () => {
    const ctx = await setupJourney();
    const session = {
      cookie: ctx.t.identity.cookie,
      headers: { "content-type": "application/json", "x-csrf-token": ctx.csrf },
    };

    // An invented intent finalizes as not_found and mints no reference.
    const invented = await handleUploadRequest(
      ctx.deps,
      testRequest("/files/finalize/no-such-intent", {
        method: "POST",
        ...session,
        body: JSON.stringify({ upload_id: "up-ghost", bytes_digest: "sha256:0" }),
      }),
    );
    expect(invented.status).toBe(404);
    const inventedBody = (await invented.json()) as Record<string, unknown>;
    expect(inventedBody["code"]).toBe("not_found");
    expect("file" in inventedBody).toBe(false);

    // A declared size over the policy ceiling is rejected before any intent exists.
    const oversized = await handleUploadRequest(
      ctx.deps,
      testRequest("/files/intents", {
        method: "POST",
        ...session,
        body: JSON.stringify(intentBody("up-big", DEFAULT_FILE_POLICY.maxBytes + 1)),
      }),
    );
    expect(oversized.status).toBe(429);
    expect(((await oversized.json()) as { code: string }).code).toBe("limit");

    // Real bytes, wrong digest: conflict, no file.
    const grant = await postIntent(ctx, "up-journey-2", PDF.length);
    await handleUploadRequest(
      ctx.deps,
      testRequest(`/files/content/${grant.intent_id}`, {
        method: "PUT",
        cookie: ctx.t.identity.cookie,
        headers: { "content-type": "application/octet-stream", "x-csrf-token": ctx.csrf },
        body: PDF,
      }),
    );
    const conflict = await handleUploadRequest(
      ctx.deps,
      testRequest(`/files/finalize/${grant.intent_id}`, {
        method: "POST",
        ...session,
        body: JSON.stringify({ upload_id: "up-journey-2", bytes_digest: "sha256:wrong" }),
      }),
    );
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { code: string }).code).toBe("conflict");

    // The same transfer finalizes honestly with the right digest.
    const fin = await handleUploadRequest(
      ctx.deps,
      testRequest(`/files/finalize/${grant.intent_id}`, {
        method: "POST",
        ...session,
        body: JSON.stringify({ upload_id: "up-journey-2", bytes_digest: sha256Hex(PDF) }),
      }),
    );
    expect(fin.status).toBe(200);
    const { file: ref } = (await fin.json()) as { file: string };

    const identity = await resolveIdentity(ctx.t.deps.identity.store, {
      session_token: ctx.t.identity.sessionToken,
    });
    const receiver = receiverFromIdentity("test-app", identity);
    const foreign = { ...receiver, principal: "user-intruder" };

    // Foreign callers and unknown references fail closed with no echo.
    await expect(ctx.kernel.readProvenance(ref, foreign)).resolves.toBeNull();
    await expect(ctx.kernel.readBytes(ref, foreign)).resolves.toBeNull();
    await expect(ctx.kernel.authorizeAttach(ref, foreign)).resolves.toEqual({
      status: "failed",
      reason: "foreign",
    });
    await expect(ctx.kernel.readProvenance("file-ghost", receiver)).resolves.toBeNull();
  });
});
