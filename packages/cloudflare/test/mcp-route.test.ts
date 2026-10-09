/**
 * P2 worker `/mcp` route tests (`src/worker/assembly.ts` + `src/runtime/mcp-registry.ts`).
 *
 * Raw JSON-RPC POSTs through the ASSEMBLED worker: initialize/list/call,
 * 401 without a grant, unknown tool -> InvalidParams, and the
 * same-invoker proof (MCP `tools/call` executes via the `buildInvoker`
 * bridge HTTP will use at the join).
 *
 * The fixture artifact below is HAND-WRITTEN JSON, honestly labeled: NOT
 * compiler output (`tool_version: "mcp-route-fixture/0"`). Its
 * `operations[]` entries follow the P1 shape (`compiler/tests/mcp_p1.rs`
 * golden: {name, kind, description, inputs}); the documented cast carries
 * the `unknown[]` fixture entries into the typed artifact.
 *
 * Cross-package imports are test-only (the worker boundary still forbids
 * them from `src/`): the REAL `createMcpHandler` from interfaces dist is
 * injected through `AssemblyDeps.mcp.createHandler`, exactly as the
 * deploy join will supply it once `@canlang/interfaces` is bundled for
 * workerd. The `(deps) => createMcpHandler(...)` wrap carries a cast
 * confined to the identity seam: `AssemblyDeps.identityStore` is
 * deliberately `unknown` (worker-boundary design), while the real
 * `McpDeps.identity.store` is an `IdentityStore`.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { compileFunction, constants as vmConstants } from "node:vm";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CompileArtifact,
  DerivedOperationInputs,
  ModelName,
  MutationEnvelope,
  OperationId,
  OperationName,
  ResolvedIdentity,
  StoragePort,
} from "@canlang/contracts";
import { resolveIdentity } from "@canlang/identity";
import { createTestMemoryStorage } from "@canlang/state/storage/memory";
// Cross-package journey imports: interfaces DIST (never src), per the
// assembly.test.ts precedent. Root `build` builds interfaces dist first.
import { createMcpHandler } from "@canlang/interfaces/mcp/server";
import { handlePageRequest } from "@canlang/interfaces";
import { catalogFromArtifactOperations } from "@canlang/interfaces/http/operations";
import {
  createGrantFixture,
  createIdentityFixture,
} from "@canlang/interfaces/testing";
import type {
  McpDeps as RealMcpDeps,
  McpPermissions as RealMcpPermissions,
  OperationRegistry as RealOperationRegistry,
  SchemaCatalog as RealSchemaCatalog,
} from "@canlang/interfaces";
import {
  type AssembledModules,
  type AssemblyDeps,
  type McpDeps as AssemblyMcpDeps,
  type McpHandlerFactory,
} from "../src/worker/assembly.js";
// Native installed producer imports preserve ESM own-data metadata; Vitest proxies expose getters.
const { assembleWorker, buildInvoker } = await compileFunction("return import(url)", ["url"], {
  importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
})(
  pathToFileURL(createRequire(import.meta.url).resolve("@canlang/cloudflare/worker/assembly")).href,
) as typeof import("../src/worker/assembly.js");
import {
  createArtifactCatalog,
  createArtifactRegistry,
  createDenyClosedMcpPermissions,
} from "../src/runtime/mcp-registry.js";

/* ------------------------------------------------------------------ */
/* Static conformance: the worker-side mirrors satisfy the REAL        */
/* `ports.ts` types verbatim. These assertions compile only when the   */
/* adapter shapes match `@canlang/interfaces` exactly; they emit no    */
/* runtime code. (The full `McpDeps` check is impossible here by       */
/* design: `AssemblyDeps.identityStore` is `unknown`, so the           */
/* `createHandler` injection below casts that one seam. The live       */
/* `createMcpHandler` runs against the assembled deps in every route   */
/* test, proving the rest at runtime.)                                 */
/* ------------------------------------------------------------------ */

function fixtureArtifactForTypes(): CompileArtifact {
  return { callables: [] } as unknown as CompileArtifact;
}

const _registryConforms: RealOperationRegistry = createArtifactRegistry(fixtureArtifactForTypes());
const _catalogConforms: RealSchemaCatalog = createArtifactCatalog(fixtureArtifactForTypes());
// E1 channel mirror: a derived-carrying catalog also satisfies the real catalog type.
const _catalogDerivedConforms: RealSchemaCatalog = createArtifactCatalog(fixtureArtifactForTypes(), {});
const _permissionsConform: RealMcpPermissions = createDenyClosedMcpPermissions();
void _registryConforms;
void _catalogConforms;
void _catalogDerivedConforms;
void _permissionsConform;

// The assembled `McpDeps` mirror matches the real one in every member
// except the identity store seam (see above): prove it structurally by
// swapping in a correctly-typed store.
type AssemblyMcpDepsWithStore = Omit<AssemblyMcpDeps, "identity"> & {
  readonly identity: Omit<AssemblyMcpDeps["identity"], "store"> & {
    readonly store: RealMcpDeps["identity"]["store"];
  };
};
const _depsConform: RealMcpDeps = null as unknown as AssemblyMcpDepsWithStore;
void _depsConform;

const _factoryShape: McpHandlerFactory = (deps) =>
  createMcpHandler(deps as unknown as RealMcpDeps);

/* ------------------------------------------------------------------ */
/* Fixtures.                                                           */
/* ------------------------------------------------------------------ */

const READ_OP = "acme.Todo.read";
const MUT_OP = "acme.Todo.create";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "canlang-mcp-route-")));
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

/**
 * P1-shaped operation entries (hand-written; NOT compiler output).
 * Shape confirmed against the sibling's `compiler/tests/mcp_p1.rs`
 * golden: entries carry exactly {name, kind, description, inputs} with
 * `inputs = {fields: [{name, field, required}]}`.
 */
function fixtureOperations(): unknown[] {
  return [
    { name: READ_OP, kind: "read", description: "Read todos.", inputs: { fields: [] } },
    {
      name: MUT_OP,
      kind: "create",
      description: "Create a todo.",
      inputs: {
        fields: [
          { name: "title", field: { kind: "string" }, required: true },
          { name: "done", field: { kind: "boolean" }, required: false },
        ],
      },
    },
  ];
}

function fixtureArtifact(): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "mcp-route-fixture/0 (hand-written; NOT compiler output)",
    tool_version: "mcp-route-fixture/0",
    sources: [{ path: "ops.mjs", sha256: createHash("sha256").update(OPS_SOURCE, "utf8").digest("hex") }],
    modules: [{ path: "ops.mjs", js: OPS_SOURCE }],
    callables: [
      { id: READ_OP, kind: "operation", module: "ops.mjs", export: "todoRead", member: ["todoRead"] },
      { id: MUT_OP, kind: "operation", module: "ops.mjs", export: "todoCreate", member: ["todoCreate"] },
    ],
    pages: [],
    requires: [],
    tests: [],
    // P1 field (`CompileArtifact.operations`): the `unknown[]` fixture
    // entries ride the cast at the end of this literal.
    operations: fixtureOperations(),
  } as unknown as CompileArtifact;
}

// Source-owned canonical fixture; the historical discovery fixtures below remain handwritten.
const CANONICAL_SOURCE = `app acme
Given
 Todo { title:text, done:bool?, priority:text? }
 policy Todo read=public
When
 crud Todo by=members fields=title,done,priority delete=remove
Then
`;

const OPS_SOURCE = `export const appDefinition = {
  id: "acme",
  policy: {
    operations: { "acme.Todo.create": { by: ["members"] } },
    models: { "acme.Todo": { read: ["Todo.read.1"], public: ["Todo.read.1"] } },
  },
};
export function canApp() {
  return {
    // B7: the create declares its admission gate (absent entries
    // deny) and Todo carries explicit-public read provenance
    // (absent reads serve zero grants) so the canonical pins
    // still commit and read back.
    policy: appDefinition.policy,
    todoRead: async (c, input) => ({ rows: [{ id: "t1", title: "fixture" }], caller: c.caller.userId, inputs: input.inputs }),
    todoCreate: async (c, input) => ({ status: "committed", operation_id: input.operation_id, title: input.inputs.title, caller: c.caller.userId }),
  };
}
`;
// T17c: CRUD operations SKIP their handlers on the canonical path (the
// pipeline executes), so the echoes above never run for converted pins
// — the module still must export canApp() for policy transcription
// (B7: absent policy now DENIES, so the fixture declares its gates).

async function assembleMcpWorker(opts: {
  ops?: unknown[];
  permissions?: AssemblyDeps["mcp"] extends { permissions?: infer P } | undefined ? P : never;
  withFactory?: boolean;
  canonical?: boolean;
  withDerivedInputs?: boolean;
  canonicalSource?: string;
}): Promise<{
  fetch: (req: Request) => Promise<Response>;
  grantToken: string;
  store: StoragePort;
  asm: AssembledModules;
  artifact: CompileArtifact;
  identityStore: Parameters<typeof resolveIdentity>[0];
}> {
  const dir = tempDir();
  const url = writeModule(dir, "ops.mjs", OPS_SOURCE);
  let asm: AssembledModules = { dir, entryUrl: url, moduleUrls: { "ops.mjs": url } };
  let artifact = fixtureArtifact();
  if (opts.ops !== undefined) {
    (artifact as unknown as { operations: unknown[] }).operations = opts.ops;
  }
  // T17c: canonical pins get model descriptors (generated artifact) plus
  // a real memory store — the canonical path needs both; everything
  // else keeps the stub store + descriptor-less shape.
  const store = opts.canonical === true ? createTestMemoryStorage().store : stubStore();
  if (opts.canonical === true) {
    const sourcePath = join(dir, "canonical.can");
    writeFileSync(sourcePath, opts.canonicalSource ?? CANONICAL_SOURCE);
    artifact = JSON.parse(execFileSync(resolve("compiler/target/debug/can"),
      ["compile", "--format=json", sourcePath], { encoding: "utf8" })) as CompileArtifact;
    const { assembleModules } = await compileFunction("return import(url)", ["url"], {
      importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    })(pathToFileURL(createRequire(import.meta.url).resolve("@canlang/cloudflare/runtime/modules")).href
    ) as typeof import("../src/runtime/modules.js");
    asm = await assembleModules({ artifact, sourcePath }, { workDir: join(dir, "compiled"),
      stdlibUrl: pathToFileURL(createRequire(import.meta.url).resolve("@canlang/cloudflare/runtime/stdlib")).href });
  }
  const derivedInputs: Record<string, DerivedOperationInputs> | undefined = opts.withDerivedInputs === true ? {} : undefined;
  if (derivedInputs !== undefined) {
    const catalog = catalogFromArtifactOperations(artifact);
    for (const operation of artifact.operations ?? []) {
      const derived = catalog.derivedFor(operation.name);
      if (derived === null) throw new Error(`no derivation for ${operation.name}`);
      derivedInputs[operation.name] = derived;
    }
  }
  const identity = await createIdentityFixture({});
  const { token: grantToken } = await createGrantFixture(identity);
  const deps: AssemblyDeps = {
    store,
    identityStore: identity.store,
    ...(opts.withFactory === false
      ? {}
      : {
          mcp: {
            createHandler: _factoryShape,
            ...(opts.permissions === undefined ? {} : { permissions: opts.permissions }),
            ...(derivedInputs === undefined ? {} : { derivedInputs }),
          },
        }),
  };
  const assembled = await assembleWorker(artifact, asm, deps, { active: true });
  return {
    fetch: assembled.fetch,
    grantToken,
    store: deps.store,
    asm,
    artifact,
    identityStore: identity.store,
  };
}

/** Fresh canonical UUIDv7 operation_id with the time field at `atMs`. */
function freshOperationId(atMs: number = Date.now()): string {
  const timeHex = atMs.toString(16).padStart(12, "0");
  const rand = randomBytes(10).toString("hex");
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

const INIT_PARAMS = {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "mcp-route-test", version: "0.0.0" },
};

interface RpcErrorBody {
  readonly code: number;
  readonly message: string;
}

interface RpcBody {
  readonly result?: unknown;
  readonly error?: RpcErrorBody;
}

interface ToolResultBody {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

let nextId = 1;

async function mcpCall(
  fetch: (req: Request) => Promise<Response>,
  method: string,
  params: Record<string, unknown>,
  opts: { grant?: string } = {},
): Promise<{ status: number; body: RpcBody; headers: Headers }> {
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
  return { status: res.status, body: (await res.json()) as RpcBody, headers: res.headers };
}

function allowAllPermissions(): NonNullable<NonNullable<AssemblyDeps["mcp"]>["permissions"]> {
  return {
    canDiscover: () => true,
    canCall: () => true,
  };
}

/* ------------------------------------------------------------------ */
/* Route proofs.                                                       */
/* ------------------------------------------------------------------ */

describe("worker POST /mcp", () => {
  it("answers initialize with the can-mcp server info", async () => {
    const { fetch, grantToken } = await assembleMcpWorker({ permissions: allowAllPermissions() });
    const { status, body } = await mcpCall(fetch, "initialize", INIT_PARAMS, { grant: grantToken });
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    const result = body.result as { serverInfo: { name: string; version: string }; protocolVersion: string };
    expect(result.serverInfo.name).toBe("can-mcp");
    expect(typeof result.serverInfo.version).toBe("string");
    expect(result.protocolVersion).toBe("2025-11-25");
  });

  it("lists the artifact operations as tools, descriptions verbatim", async () => {
    const { fetch, grantToken } = await assembleMcpWorker({ permissions: allowAllPermissions() });
    const { status, body } = await mcpCall(fetch, "tools/list", {}, { grant: grantToken });
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    const tools = (body.result as { tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([MUT_OP, READ_OP].sort());
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get(READ_OP)?.description).toBe("Read todos.");
    expect(byName.get(MUT_OP)?.description).toBe("Create a todo.");
    // Read op: plain closed schema.
    const readSchema = byName.get(READ_OP)?.inputSchema as Record<string, unknown>;
    expect(readSchema["type"]).toBe("object");
    expect(readSchema["additionalProperties"]).toBe(false);
    // Mutation op: anyOf ordinary/handle branches, operation_id required.
    const mutSchema = byName.get(MUT_OP)?.inputSchema as {
      type: string;
      anyOf: Array<{ properties: Record<string, unknown>; required: string[] }>;
    };
    expect(mutSchema.type).toBe("object");
    expect(mutSchema.anyOf).toHaveLength(2);
    const ordinary = mutSchema.anyOf[0];
    expect(ordinary === undefined ? [] : ordinary.required).toContain("operation_id");
    expect(ordinary === undefined ? [] : ordinary.required).toContain("title");
  });

  it("carries @{desc} field descriptions into tools/list inputSchema", async () => {
    const ops: unknown[] = [
      {
        name: MUT_OP,
        kind: "create",
        description: "Create a todo.",
        inputs: {
          fields: [
            {
              name: "title",
              field: { kind: "string" },
              required: true,
              description: "The todo title.",
            },
            { name: "done", field: { kind: "boolean" }, required: false },
          ],
        },
      },
    ];
    const { fetch, grantToken } = await assembleMcpWorker({ ops, permissions: allowAllPermissions() });
    const { status, body } = await mcpCall(fetch, "tools/list", {}, { grant: grantToken });
    expect(status).toBe(200);
    const tools = (
      body.result as {
        tools: Array<{
          name: string;
          inputSchema: { anyOf: Array<{ properties: Record<string, Record<string, unknown>> }> };
        }>;
      }
    ).tools;
    const tool = tools.find((t) => t.name === MUT_OP);
    expect(tool).toBeDefined();
    const ordinary = tool?.inputSchema.anyOf[0]?.properties;
    expect(ordinary?.["title"]?.["description"]).toBe("The todo title.");
    expect("description" in (ordinary?.["done"] ?? {})).toBe(false);
  });

  it("calls a read op through the worker invoker, threading the grant identity", async () => {
    // T17c (rule a): was the interim direct bridge (handler echo with
    // the caller id); now the canonical read path (admit ->
    // grant-project), which serves rows instead of echoing. SAME
    // behavior proven end to end: a row created AS the grant user via
    // tools/call serves back carrying that user's id in `createdBy`
    // (not anonymous), and the row really committed.
    const { fetch, grantToken, store, identityStore } = await assembleMcpWorker({
      permissions: allowAllPermissions(),
      canonical: true,
    });
    const created = await mcpCall(
      fetch,
      "tools/call",
      { name: MUT_OP, arguments: { operation_id: freshOperationId(), title: "fixture" } },
      { grant: grantToken },
    );
    expect(created.status).toBe(200);
    expect((created.body.result as ToolResultBody).isError).toBeUndefined();
    const { status, body } = await mcpCall(
      fetch,
      "tools/call",
      { name: READ_OP, arguments: {} },
      { grant: grantToken },
    );
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    const result = body.result as ToolResultBody;
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]?.text ?? "null") as {
      records: Array<{ id: string; data: Record<string, unknown>; createdBy: string }>;
    };
    expect(payload.records.length).toBe(1);
    expect(payload.records[0]?.data).toEqual({ title: "fixture", done: null, priority: null });
    // The grant identity (not anonymous) reached the canonical path.
    const grantIdentity: ResolvedIdentity = await resolveIdentity(identityStore, {
      mcp_grant_token: grantToken,
    });
    const grantUserId = grantIdentity.actor?.user_id;
    expect(typeof grantUserId).toBe("string");
    expect(payload.records[0]?.createdBy).toBe(grantUserId);
    expect(result.structuredContent).toMatchObject({ records: [{ data: { title: "fixture" } }] });
    expect(
      await store.query({ model: "acme.Todo" as ModelName, authority: "owner" }),
    ).toHaveLength(1);
  });

  it("calls a mutation op with operation_id framing", async () => {
    // T17c (rule a): was the interim echo (framing proved, nothing
    // committed); now a canonical CRUD create: framing is still
    // validated at the MCP boundary, and the envelope COMMITS (row id
    // === operation_id by the create convention).
    const { fetch, grantToken, store } = await assembleMcpWorker({
      permissions: allowAllPermissions(),
      canonical: true,
    });
    const operationId = freshOperationId();
    const { status, body } = await mcpCall(
      fetch,
      "tools/call",
      { name: MUT_OP, arguments: { operation_id: operationId, title: "buy milk" } },
      { grant: grantToken },
    );
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    const result = body.result as ToolResultBody;
    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]?.text ?? "null") as {
      status: string;
      operation_id: string;
      result: null; records: Array<{ id: string; version: number; data: Record<string, unknown> }>;
    };
    expect(payload.status).toBe("committed");
    expect(payload.result).toBeNull();
    expect(payload.operation_id).toBe(operationId);
    expect(payload.records[0]!.id).toBe(operationId);
    expect(payload.records[0]!.version).toBe(1);
    expect(payload.records[0]!.data).toEqual({ title: "buy milk", done: null, priority: null });
    expect(
      await store.query({ model: "acme.Todo" as ModelName, authority: "owner" }),
    ).toHaveLength(1);
  });

  it("executes tools/call via the SAME invoker as HTTP (buildInvoker parity)", async () => {
    // T17c (rule a): was the interim bridge with ONE shared envelope;
    // canonical envelopes are idempotent (the same envelope would
    // replay), so the two transports use DISTINCT ids over the SAME
    // store + artifact: both commit through the one `buildInvoker`
    // bridge with equal row data.
    const { fetch, grantToken, store, asm, artifact, identityStore } = await assembleMcpWorker({
      permissions: allowAllPermissions(),
      canonical: true,
    });
    const mcpOperationId = freshOperationId();
    const { body } = await mcpCall(
      fetch,
      "tools/call",
      { name: MUT_OP, arguments: { operation_id: mcpOperationId, title: "parity" } },
      { grant: grantToken },
    );
    const mcpResult = body.result as ToolResultBody;
    expect(mcpResult.isError).toBeUndefined();
    const mcpPayload = JSON.parse(mcpResult.content[0]?.text ?? "null") as {
      status: string;
      operation_id: string;
      result: null; records: Array<{ id: string; data: Record<string, unknown> }>;
    };
    expect(mcpPayload.status).toBe("committed");
    expect(mcpPayload.result).toBeNull();
    expect(mcpPayload.records[0]!.id).toBe(mcpOperationId);

    // Direct invocation through the same bridge `HttpDeps` will consume
    // at the HTTP join: same artifact + store, same resolved grant
    // identity, distinct idempotent envelope.
    const invoker = buildInvoker(artifact, asm, store, { memberships: identityStore });
    const grantIdentity: ResolvedIdentity = await resolveIdentity(identityStore, {
      mcp_grant_token: grantToken,
    });
    const httpOperationId = freshOperationId();
    const envelope: MutationEnvelope = {
      operation: MUT_OP,
      operation_id: httpOperationId as OperationId,
      inputs: { title: "parity" },
    };
    const direct = await invoker.invokeMutation(envelope, grantIdentity);
    if (!("result" in direct)) {
      throw new Error(`want result, got ${JSON.stringify(direct)}`);
    }
    expect(direct.result.status).toBe("committed");
    expect(direct.result.result).toBeNull();
    const directRow = direct.result.records![0] as { id: string; data: Record<string, unknown> };
    expect(directRow.id).toBe(httpOperationId);
    expect(directRow.data).toEqual({ title: "parity", done: null, priority: null });
    expect(mcpPayload.records[0]!.data).toEqual(directRow.data);
  });

  it("401s without a grant and on a bogus token", async () => {
    const { fetch } = await assembleMcpWorker({ permissions: allowAllPermissions() });
    const anon = await mcpCall(fetch, "initialize", INIT_PARAMS);
    expect(anon.status).toBe(401);
    const anonBody = anon.body as unknown as { error: { code: string; message: string } };
    expect(anonBody.error.code).toBe("forbidden");
    expect(anon.headers.get("www-authenticate")).toContain("Bearer");

    const bogus = await mcpCall(fetch, "tools/list", {}, { grant: "bogus-grant-token" });
    expect(bogus.status).toBe(401);
  });

  it("answers an unknown tool with InvalidParams (-32602)", async () => {
    const { fetch, grantToken } = await assembleMcpWorker({ permissions: allowAllPermissions() });
    const { status, body } = await mcpCall(
      fetch,
      "tools/call",
      { name: "nope.unknown", arguments: {} },
      { grant: grantToken },
    );
    expect(status).toBe(200);
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toContain("Unknown tool");
  });

  it("answers framing violations with InvalidParams", async () => {
    const { fetch, grantToken } = await assembleMcpWorker({ permissions: allowAllPermissions() });
    // Missing required input.
    const missing = await mcpCall(
      fetch,
      "tools/call",
      { name: MUT_OP, arguments: { operation_id: freshOperationId() } },
      { grant: grantToken },
    );
    expect(missing.body.error?.code).toBe(-32602);
    // Unknown member (closed inputs).
    const extra = await mcpCall(
      fetch,
      "tools/call",
      { name: MUT_OP, arguments: { operation_id: freshOperationId(), title: "x", nope: 1 } },
      { grant: grantToken },
    );
    expect(extra.body.error?.code).toBe(-32602);
    // Missing operation_id on a mutation.
    const noId = await mcpCall(fetch, "tools/call", { name: MUT_OP, arguments: { title: "x" } }, {
      grant: grantToken,
    });
    expect(noId.body.error?.code).toBe(-32602);
  });

  it("bound-checks MCP calls when derived inputs are joined (C1 mirror)", async () => {
    // The old handwritten fixture let transport metadata contradict the model.
    // A genuine enum refuses invalid values even without transport-derived inputs.
    const canonicalSource = CANONICAL_SOURCE.replace("priority:text?", "priority:enum(low,high)?");
    const { fetch, grantToken } = await assembleMcpWorker({
      permissions: allowAllPermissions(), canonical: true, canonicalSource, withDerivedInputs: true,
    });
    const bad = await mcpCall(
      fetch,
      "tools/call",
      {
        name: MUT_OP,
        arguments: { operation_id: freshOperationId(), title: "x", priority: "urgent" },
      },
      { grant: grantToken },
    );
    expect(bad.body.error?.code).toBe(-32602);
    expect(bad.body.error?.message).toContain('Invalid value for input "priority"');

    const good = await mcpCall(
      fetch,
      "tools/call",
      {
        name: MUT_OP,
        arguments: { operation_id: freshOperationId(), title: "x", priority: "high" },
      },
      { grant: grantToken },
    );
    expect(good.body.error).toBeUndefined();
    const committed = JSON.parse(
      ((good.body.result as ToolResultBody).content[0]?.text ?? "null") as string,
    ) as { status: string; result: null; records: Array<{ data: Record<string, unknown> }> };
    expect(committed.status).toBe("committed");
    expect(committed.result).toBeNull();
    expect(committed.records[0]!.data).toEqual({ title: "x", done: null, priority: "high" });

    const legacy = await assembleMcpWorker({ permissions: allowAllPermissions(), canonical: true, canonicalSource });
    const unboundOperationId = freshOperationId();
    const unbound = await mcpCall(
      legacy.fetch,
      "tools/call",
      {
        name: MUT_OP,
        arguments: { operation_id: unboundOperationId, title: "x", priority: "urgent" },
      },
      { grant: legacy.grantToken },
    );
    expect(unbound.body.error).toBeUndefined();
    const canonicalRefusal = unbound.body.result as ToolResultBody;
    expect(canonicalRefusal.isError).toBe(true);
    expect(canonicalRefusal.structuredContent).toMatchObject({ code: "validation" });
    const identity = await resolveIdentity(legacy.identityStore, { mcp_grant_token: legacy.grantToken });
    const receipt = await legacy.store.readReceipt({ app: "acme", owner: identity.team!.team_id,
      principal: identity.actor!.user_id, operation: MUT_OP as OperationName,
      operationId: unboundOperationId as OperationId });
    expect(receipt?.outcome).toMatchObject({ status: "rejected", code: "validation" });
    expect(await legacy.store.query({ model: "acme.Todo" as ModelName, authority: "owner" })).toEqual([]);
    expect(await legacy.store.outboxPending()).toEqual([]);
    expect(await legacy.store.schedulesDue(Number.MAX_SAFE_INTEGER, 1)).toEqual([]);
  });

  it("deny-closed by default: empty list, forbidden calls, no oracle", async () => {
    const { fetch, grantToken } = await assembleMcpWorker({});
    const list = await mcpCall(fetch, "tools/list", {}, { grant: grantToken });
    expect(list.status).toBe(200);
    expect((list.body.result as { tools: unknown[] }).tools).toEqual([]);
    const call = await mcpCall(fetch, "tools/call", { name: READ_OP, arguments: {} }, {
      grant: grantToken,
    });
    expect(call.status).toBe(200);
    expect(call.body.error).toBeUndefined();
    const result = call.body.result as ToolResultBody;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "forbidden" });
  });

  it("501s naming the join when no MCP handler factory is supplied", async () => {
    const { fetch, grantToken } = await assembleMcpWorker({ withFactory: false });
    const res = await fetch(
      new Request("https://test.invalid/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${grantToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: INIT_PARAMS }),
      }),
    );
    expect(res.status).toBe(501);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("assembly-interim");
    expect(body.message).toContain("interfaces join");
  });

  it("contains malformed operations to a 500 on /mcp, naming the entry", async () => {
    const { fetch, grantToken } = await assembleMcpWorker({
      permissions: allowAllPermissions(),
      ops: [{ name: "bad.op", kind: "spell", description: "x", inputs: { fields: [] } }],
    });
    const { status, body } = await mcpCall(fetch, "tools/list", {}, { grant: grantToken });
    expect(status).toBe(500);
    const err = body as unknown as { code: string; message: string };
    expect(err.code).toBe("mcp-registry");
    expect(err.message).toContain("operations[0].kind");
  });

  it("serves an empty tool list when the artifact predates operations[]", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", OPS_SOURCE);
    const artifact = fixtureArtifact();
    delete (artifact as unknown as { operations?: unknown }).operations;
    const identity = await createIdentityFixture({});
    const { token: grantToken } = await createGrantFixture(identity);
    const assembled = await assembleWorker(
      artifact,
      { dir, entryUrl: url, moduleUrls: { "ops.mjs": url } },
      {
        store: stubStore(),
        identityStore: identity.store,
        mcp: { createHandler: _factoryShape, permissions: allowAllPermissions() },
      },
      { active: true },
    );
    const { status, body } = await mcpCall(assembled.fetch, "tools/list", {}, { grant: grantToken });
    expect(status).toBe(200);
    expect((body.result as { tools: unknown[] }).tools).toEqual([]);
  });

  it("leaves page serving and op counts untouched", async () => {
    const dir = tempDir();
    const url = writeModule(
      dir,
      "home.mjs",
      `export const appDefinition = { id: "acme" };
export const home = { owner: "fixture", path: "/", title: "Home", admit: async () => ({}), render: async () => "<h1>ok</h1>" };\n`,
    );
    const artifact = fixtureArtifact();
    (artifact as unknown as { modules: unknown[] }).modules = [{ path: "home.mjs" }];
    (artifact as unknown as { pages: CompileArtifact["pages"] }).pages = [
      { owner: "fixture", path: "/", module: "home.mjs", export: "home" },
    ];
    const identity = await createIdentityFixture({});
    const assembled = await assembleWorker(
      artifact,
      { dir, entryUrl: url, moduleUrls: { "home.mjs": url } },
      { store: stubStore(), identityStore: identity.store, mcp: { createHandler: _factoryShape },
        http: { createPageHandler: deps => request => handlePageRequest(deps as unknown as Parameters<typeof handlePageRequest>[0], request) } },
      { active: true },
    );
    expect(assembled.pageCount).toBe(1);
    expect(assembled.opCount).toBe(2);
    const page = await assembled.fetch(new Request("http://localhost/"));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("ok");
  });
});
describe("genuine compiled MCP operations through native Worker and D1", () => {
  it("discovers source tools and preserves canonical defaults, replay and live membership denial", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { Miniflare } = await import("miniflare");
    const { hashPassword, loginWithPassword, sha256HexText, issueMcpGrant } = await import("@canlang/identity");
    const { buildDeployBundleWithAssets, writeDeployBundleWithAssets, DEPLOY_MAIN_MODULE } = await import("../src/deploy/bundle.js");
    const artifact = JSON.parse(readFileSync(resolve("packages/cloudflare/test/fixtures/typed-operation-forms.json"), "utf8")) as CompileArtifact;
    const bundle = buildDeployBundleWithAssets(artifact, { verdict: { active: true }, assets: { browser: false } });
    const dir = tempDir();
    writeDeployBundleWithAssets(bundle, dir);
    const worker = new Miniflare({ compatibilityDate: "2026-07-15", modulesRoot: "/",
      modules: [DEPLOY_MAIN_MODULE, ...Object.keys(bundle.modules).filter(path => path !== DEPLOY_MAIN_MODULE)].map(path => ({
        type: "ESModule" as const, path: `/${path}`, contents: bundle.modules[path]!,
      })), d1Databases: { DB: "actual-mcp-forms" } });
    try {
      const DB = await worker.getD1Database("DB");
      const stagedUrl = pathToFileURL(join(dir, "runtime/env-assembly.js")).href;
      const { buildProductionDeps } = await import(/* @vite-ignore */ stagedUrl);
      const deps = await buildProductionDeps({ DB });
      const password = "mcp-source-password";
      const user = await deps.identityStore.createUser({ email: "mcp-source@example.test",
        password_hash: await hashPassword(password), email_verified: true });
      const team = await deps.identityStore.createTeam({ timezone: "Europe/Brussels" });
      const membership = await deps.identityStore.createMembership({ team_id: team.team_id,
        user_id: user.user_id, is_owner: false, roles: [] });
      const { token } = await loginWithPassword(deps.identityStore, { email: user.email, password });
      const session = await deps.identityStore.findSessionByTokenHash(await sha256HexText(token));
      expect(session).not.toBeNull();
      await deps.identityStore.setSessionTeam(session.session_id, team.team_id);
      const authenticated = await resolveIdentity(deps.identityStore, { session_token: token });
      expect(authenticated.actor?.user_id).toBe(user.user_id);
      expect(authenticated.team?.team_id).toBe(team.team_id);
      // The public issuance helper receives a genuinely authenticated selected-team caller.
      const { token: grant } = await issueMcpGrant(deps.identityStore, {
        user_id: authenticated.actor!.user_id, team_id: authenticated.team!.team_id,
        client_id: "native-source-consumer",
      });
      const nativeFetch = async (request: Request) => worker.dispatchFetch(request.url, {
        method: request.method, headers: request.headers, body: await request.text(),
      });
      const initialized = await mcpCall(nativeFetch, "initialize", INIT_PARAMS, { grant });
      expect(initialized.status).toBe(200);
      expect(initialized.body.error).toBeUndefined();
      const listed = await mcpCall(nativeFetch, "tools/list", {}, { grant });
      expect(listed.status).toBe(200);
      expect(listed.body.error).toBeUndefined();
      const tools = (listed.body.result as { tools: Array<{ name: string; inputSchema: {
        anyOf: Array<{ properties: Record<string, unknown>; required: string[] }>;
      } }> }).tools;
      const createTool = tools.find(tool => tool.name === "TypedOperationForms.Entry.create")!;
      const renameTool = tools.find(tool => tool.name === "TypedOperationForms.rename")!;
      expect(createTool).toBeDefined(); expect(renameTool).toBeDefined();
      expect(createTool.inputSchema.anyOf[0]!.properties).toHaveProperty("label");
      expect(createTool.inputSchema.anyOf[0]!.properties).toHaveProperty("count");
      expect(createTool.inputSchema.anyOf[0]!.properties).not.toHaveProperty("owner");
      expect(createTool.inputSchema.anyOf[0]!.required).toContain("label");
      expect(renameTool.inputSchema.anyOf[0]!.properties).toHaveProperty("entry");
      expect(renameTool.inputSchema.anyOf[0]!.properties).toHaveProperty("delta");
      const operationId = freshOperationId();
      const createArguments = { operation_id: operationId, label: "From MCP" };
      const created = await mcpCall(nativeFetch, "tools/call", {
        name: createTool.name, arguments: createArguments,
      }, { grant });
      expect(created.status).toBe(200); expect(created.body.error).toBeUndefined();
      const createResult = created.body.result as ToolResultBody;
      expect(createResult.isError).toBeUndefined();
      const born = JSON.parse(createResult.content[0]!.text) as {
        status: string; result: null; records: Array<{ id: string; version: number; data: Record<string, unknown> }>;
      };
      expect(born.status).toBe("committed");
      expect(born.result).toBeNull();
      expect(born.records[0]!.version).toBe(1);
      expect(born.records[0]!.data).toEqual({ label: "From MCP", count: "1", owner: { id: user.user_id } });
      const receipt = await deps.store.readReceipt({ app: "TypedOperationForms", owner: team.team_id,
        principal: user.user_id, operation: createTool.name, operationId });
      expect(receipt.resolvedDefaults).toEqual({ count: "1", owner: { id: user.user_id } });
      const renamed = await mcpCall(nativeFetch, "tools/call", { name: renameTool.name,
        arguments: { operation_id: freshOperationId(), entry: { id: born.records[0]!.id, version: "1" }, newLabel: "Renamed MCP" },
      }, { grant });
      expect(renamed.status).toBe(200); expect(renamed.body.error).toBeUndefined();
      const renameResult = renamed.body.result as ToolResultBody;
      expect(renameResult.isError).toBeUndefined();
      expect(JSON.parse(renameResult.content[0]!.text)).toMatchObject({ status: "committed", result: "2" });
      const model = "TypedOperationForms.Entry";
      const rows = await deps.store.query({ model, authority: "owner" });
      expect(rows).toHaveLength(1);
      expect(rows[0].version).toBe(2);
      expect(rows[0].data).toEqual({ label: "Renamed MCP", count: "2", owner: { id: user.user_id } });
      const history = await deps.store.historyFor(model, born.records[0]!.id);
      const revision = await deps.store.readRevision();
      const replayed = await mcpCall(nativeFetch, "tools/call", { name: createTool.name,
        arguments: createArguments }, { grant });
      expect(replayed.status).toBe(200); expect(replayed.body.error).toBeUndefined();
      const replayResult = replayed.body.result as ToolResultBody;
      expect(replayResult.isError).toBeUndefined();
      expect(JSON.parse(replayResult.content[0]!.text)).toMatchObject({ status: "replayed", result: null, records: born.records });
      const invalid = await mcpCall(nativeFetch, "tools/call", { name: createTool.name,
        arguments: { operation_id: freshOperationId(), label: "Invalid", count: "1.5" } }, { grant });
      expect(invalid.status).toBe(200);
      expect(invalid.body.error?.code).toBe(-32602);
      expect(invalid.body.error?.message).toContain('Invalid value for input "count"');
      expect(await deps.store.readRevision()).toBe(revision);
      expect(await deps.store.query({ model, authority: "owner" })).toEqual(rows);
      expect(await deps.store.historyFor(model, born.records[0]!.id)).toEqual(history);
      expect(await deps.store.outboxPending()).toEqual([]);
      expect(await deps.store.schedulesDue(Date.now(), 100)).toEqual([]);
      await deps.identityStore.removeMembership(membership.membership_id);
      const revoked = await mcpCall(nativeFetch, "tools/call", { name: createTool.name,
        arguments: { operation_id: freshOperationId(), label: "After removal", count: "malformed" } }, { grant });
      expect(revoked.status).toBe(401);
      expect(revoked.body).toMatchObject({ error: { code: "forbidden" } });
      expect(await deps.store.readRevision()).toBe(revision);
      expect(await deps.store.query({ model, authority: "owner" })).toEqual(rows);
      expect(await deps.store.historyFor(model, born.records[0]!.id)).toEqual(history);
    } finally { await worker.dispose(); }
  }, 60_000);
});
