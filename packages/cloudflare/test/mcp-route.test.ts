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
 * `operations[]` entries follow the P1 shape (`/tmp/mcp-scope.md` §c-P1:
 * {name, kind, description, inputs}) which `CompileArtifact` does not
 * carry yet — hence the documented cast. The day P1 lands, the cast goes
 * away and this fixture must match P1's emitter field-for-field.
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
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CompileArtifact,
  MutationEnvelope,
  OperationId,
  ResolvedIdentity,
  StoragePort,
} from "@canlang/contracts";
import { resolveIdentity } from "@canlang/identity";
// Cross-package journey imports: interfaces DIST (never src), per the
// assembly.test.ts precedent. Root `build` builds interfaces dist first.
import { createMcpHandler } from "../../interfaces/dist/interfaces/src/mcp/server.js";
import {
  createGrantFixture,
  createIdentityFixture,
} from "../../interfaces/dist/interfaces/src/testing.js";
import type {
  McpDeps as RealMcpDeps,
  McpPermissions as RealMcpPermissions,
  OperationRegistry as RealOperationRegistry,
  SchemaCatalog as RealSchemaCatalog,
} from "../../interfaces/dist/interfaces/src/ports.js";
import {
  assembleWorker,
  buildInvoker,
  type AssembledModules,
  type AssemblyDeps,
  type McpDeps as AssemblyMcpDeps,
  type McpHandlerFactory,
} from "../src/worker/assembly.js";
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
const _permissionsConform: RealMcpPermissions = createDenyClosedMcpPermissions();
void _registryConforms;
void _catalogConforms;
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
    sources: [{ path: "examples/TeamTasks.can", sha256: "fixture-not-a-digest" }],
    modules: [],
    callables: [
      { id: READ_OP, kind: "operation", module: "ops.mjs", export: "todoRead", member: ["todoRead"] },
      { id: MUT_OP, kind: "operation", module: "ops.mjs", export: "todoCreate", member: ["todoCreate"] },
    ],
    pages: [],
    requires: [],
    tests: [],
    // P1 field (`CompileArtifact.operations`, §c-P1): present at runtime
    // once the sibling packet lands; until then this cast carries it.
    operations: fixtureOperations(),
  } as unknown as CompileArtifact;
}

const OPS_SOURCE = `export function canApp() {
  return {
    todoRead: async (c, input) => ({ rows: [{ id: "t1", title: "fixture" }], caller: c.caller.userId, inputs: input.inputs }),
    todoCreate: async (c, input) => ({ status: "committed", operation_id: input.operation_id, title: input.inputs.title, caller: c.caller.userId }),
  };
}
`;

async function assembleMcpWorker(opts: {
  ops?: unknown[];
  permissions?: AssemblyDeps["mcp"] extends { permissions?: infer P } | undefined ? P : never;
  withFactory?: boolean;
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
  const asm: AssembledModules = { dir, entryUrl: "fixture-entry", moduleUrls: { "ops.mjs": url } };
  const artifact = fixtureArtifact();
  if (opts.ops !== undefined) {
    (artifact as unknown as { operations: unknown[] }).operations = opts.ops;
  }
  const identity = await createIdentityFixture({});
  const { token: grantToken } = await createGrantFixture(identity);
  const deps: AssemblyDeps = {
    store: stubStore(),
    identityStore: identity.store,
    ...(opts.withFactory === false
      ? {}
      : {
          mcp: {
            createHandler: _factoryShape,
            ...(opts.permissions === undefined ? {} : { permissions: opts.permissions }),
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

  it("calls a read op through the worker invoker, threading the grant identity", async () => {
    const { fetch, grantToken } = await assembleMcpWorker({ permissions: allowAllPermissions() });
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
    const payload = JSON.parse(result.content[0]?.text ?? "null") as Record<string, unknown>;
    expect(payload["rows"]).toEqual([{ id: "t1", title: "fixture" }]);
    // The grant identity (not anonymous) reached the operation callable.
    expect(typeof payload["caller"]).toBe("string");
    expect(payload["caller"]).not.toBe("anonymous");
    expect(result.structuredContent).toMatchObject({ rows: [{ id: "t1", title: "fixture" }] });
  });

  it("calls a mutation op with operation_id framing", async () => {
    const { fetch, grantToken } = await assembleMcpWorker({ permissions: allowAllPermissions() });
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
    const payload = JSON.parse(result.content[0]?.text ?? "null") as Record<string, unknown>;
    expect(payload).toMatchObject({ status: "committed", operation_id: operationId, title: "buy milk" });
  });

  it("executes tools/call via the SAME invoker as HTTP (buildInvoker parity)", async () => {
    const { fetch, grantToken, store, asm, artifact, identityStore } = await assembleMcpWorker({
      permissions: allowAllPermissions(),
    });
    const operationId = freshOperationId();
    const { body } = await mcpCall(
      fetch,
      "tools/call",
      { name: MUT_OP, arguments: { operation_id: operationId, title: "parity" } },
      { grant: grantToken },
    );
    const mcpResult = body.result as ToolResultBody;
    expect(mcpResult.isError).toBeUndefined();
    const mcpPayload = JSON.parse(mcpResult.content[0]?.text ?? "null") as Record<string, unknown>;

    // Direct invocation through the same bridge `HttpDeps` will consume
    // at the HTTP join: same envelope, same resolved grant identity.
    const invoker = buildInvoker(artifact, asm, store);
    const grantIdentity: ResolvedIdentity = await resolveIdentity(identityStore, {
      mcp_grant_token: grantToken,
    });
    const envelope: MutationEnvelope = {
      operation: MUT_OP,
      operation_id: operationId as OperationId,
      inputs: { title: "parity" },
    };
    const direct = await invoker.invokeMutation(envelope, grantIdentity);
    expect(direct).toEqual({ result: mcpPayload });
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
      { dir, entryUrl: "fixture-entry", moduleUrls: { "ops.mjs": url } },
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
      `export const home = { owner: "fixture", path: "/", title: "Home", admit: async () => ({}), render: async () => "<h1>ok</h1>" };\n`,
    );
    const artifact = fixtureArtifact();
    (artifact as unknown as { pages: CompileArtifact["pages"] }).pages = [
      { owner: "fixture", path: "/", module: "home.mjs", export: "home" },
    ];
    const identity = await createIdentityFixture({});
    const assembled = await assembleWorker(
      artifact,
      { dir, entryUrl: "fixture-entry", moduleUrls: { "home.mjs": url } },
      { store: stubStore(), identityStore: identity.store, mcp: { createHandler: _factoryShape } },
      { active: true },
    );
    expect(assembled.pageCount).toBe(1);
    expect(assembled.opCount).toBe(2);
    const page = await assembled.fetch(new Request("http://localhost/"));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("ok");
  });
});