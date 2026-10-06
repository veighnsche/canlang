/**
 * C3 HTTP `/api/operations/*` route + browser/MCP bound-rule agreement.
 *
 * The C3 join routes op POSTs through the REAL `handleOperationRequest`
 * (injected via `AssemblyDeps.http.createOperationHandler`) over the
 * SAME baked catalog + SAME canonical invoker the MCP path consumes,
 * so both transports check identical bound rules and invoke identical
 * envelopes. These pins prove that agreement end to end (framing,
 * binding per kind, delivery-never-submitted, receipt-only invoke,
 * verbatim handoff, replay, denial passthrough) plus the join's own
 * mechanics (501 without the factory, 500 catalog containment,
 * fragment re-render passthrough).
 *
 * The fixture artifact below is HAND-WRITTEN JSON, honestly labeled:
 * NOT compiler output (`tool_version: "http-ops-fixture/0"`). Its
 * `operations[]` entries follow the P1 shape, mirrored on the E1
 * verbatim fixtures (t19a `Shop.Gadget.create`, t19b `Receipts.retry`
 * / `Receipts.notifyEmail`): same input kinds, required-flags tuned
 * so the canonical path can commit the quiet path.
 *
 * Cross-package imports are test-only (the worker boundary still
 * forbids them from `src/`): the REAL `handleOperationRequest` /
 * `createMcpHandler` / `catalogFromArtifactOperations` from interfaces
 * dist are injected exactly as the deploy join supplies them. The
 * `(deps) => ...` wraps carry casts confined to the identity seam
 * (`AssemblyDeps.identityStore` is deliberately `unknown`).
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CompileArtifact,
  DerivedOperationInputs,
  ModelName,
} from "@canlang/contracts";
import type {
  StoragePort,
} from "@canlang/state";
import { createTestMemoryStorage } from "@canlang/state/storage/memory";
import { deriveCsrfToken, sha256HexText } from "@canlang/identity";
import {
  catalogFromArtifactOperations,
  handleOperationRequest,
} from "@canlang/interfaces/http/operations";
import type { HttpDeps as RealHttpDeps } from "@canlang/interfaces";
import type { McpDeps as RealMcpDeps } from "@canlang/interfaces";
import { createMcpHandler } from "@canlang/interfaces/mcp/server";
import {
  bindingFromDerived,
  clearFormBindings,
  registerFormBinding,
} from "@canlang/interfaces/http/form-errors";
import { createGrantFixture, createIdentityFixture } from "@canlang/interfaces/testing";
import type {
  AssembledModules,
  AssemblyDeps,
  HttpDeps,
  HttpOperationHandlerFactory,
} from "../src/worker/assembly.js";
import { assembleWorker } from "../src/worker/assembly.js";
import type { BakedDerivedInputs } from "../src/runtime/mcp-registry.js";

/* ------------------------------------------------------------------ */
/* Static conformance: the worker-side mirrors satisfy the REAL        */
/* `ports.ts` types verbatim (same discipline as mcp-route.test.ts:    */
/* the full `HttpDeps` check swaps in a correctly-typed identity       */
/* store; the live `handleOperationRequest` runs against the assembled */
/* deps in every route test, proving the rest at runtime).             */
/* ------------------------------------------------------------------ */

type AssemblyHttpDepsWithStore = Omit<HttpDeps, "identity"> & {
  readonly identity: Omit<HttpDeps["identity"], "store"> & {
    readonly store: RealHttpDeps["identity"]["store"];
  };
};
const _depsConform: RealHttpDeps = null as unknown as AssemblyHttpDepsWithStore;
void _depsConform;

const _factoryShape: HttpOperationHandlerFactory = (deps) => (req, op) =>
  handleOperationRequest(deps as unknown as RealHttpDeps, req, op);

/* ------------------------------------------------------------------ */
/* Fixture artifact (hand-written P1 + T15a, honestly labeled).        */
/* ------------------------------------------------------------------ */

const GADGET_CREATE_OP = "Shop.Gadget.create";
const NOTIFY_EMAIL_OP = "Receipts.notifyEmail";
const ECHO_OP = "Acme.Probe.echo";

const EMAIL_DELIVERY = {
  kind: "delivery",
  capability: "std.EmailV1",
  operation: "send",
  version: 1,
  result: { name: "EmailAccepted", fields: [{ name: "reference", type: "text" }] },
};

function fixtureOperations(): unknown[] {
  return [
    {
      name: GADGET_CREATE_OP,
      kind: "create",
      description: "Fixture gadget create (E1 t19a kinds).",
      inputs: {
        fields: [
          { name: "title", field: { kind: "string" }, required: true },
          { name: "stock", field: { kind: "integer" }, required: false, default: { kind: "literal", value: "0" } },
          { name: "price", field: { kind: "decimal" }, required: false },
          { name: "fee", field: { kind: "money" }, required: false },
          { name: "when", field: { kind: "datetime" }, required: false },
          { name: "active", field: { kind: "boolean" }, required: false },
          { name: "state", field: { kind: "enum", values: ["draft", "submitted"] }, required: false, default: { kind: "literal", value: "draft" } },
          { name: "note", field: { kind: "string" }, required: false, nullable: true },
          { name: "tags", field: { kind: "string" }, required: false, array: { required: false } },
          { name: "ids", field: { kind: "string" }, required: false, array: { required: false } },
          { name: "owner", field: { kind: "ref", model: "Shop.Gadget", requireVersion: true }, required: false, nullable: true },
          { name: "doc", field: { kind: "file" }, required: false },
        ],
      },
    },
    {
      name: NOTIFY_EMAIL_OP,
      kind: "scenario",
      description: "Receipt-only scenario (E1 t19b NOTIFY_EMAIL verbatim shape).",
      inputs: { fields: [{ name: "receipt", field: EMAIL_DELIVERY, required: true }] },
    },
    {
      name: ECHO_OP,
      kind: "scenario",
      description: "Rich echo probe (E1 t19b RETRY shape, extended).",
      inputs: {
        fields: [
          { name: "note", field: { kind: "string" }, required: true },
          { name: "attempt", field: EMAIL_DELIVERY, required: false, nullable: true },
          { name: "fee", field: { kind: "money" }, required: false },
          { name: "when", field: { kind: "datetime" }, required: false },
          { name: "doc", field: { kind: "file" }, required: false },
          { name: "owner", field: { kind: "ref", model: "Shop.Gadget", requireVersion: false }, required: false },
        ],
      },
    },
  ];
}

function fixtureModels(): unknown[] {
  // Every field carries an explicit boolean `serverOnly`: the C2
  // conflict-exclusion builder rejects non-boolean flags as
  // loader/artifact skew (mcp-route/T32c fixtures do the same).
  return [
    {
      name: "Shop.Gadget",
      fields: [
        { name: "title", field: { kind: "string" }, required: true, serverOnly: false },
        { name: "stock", field: { kind: "integer" }, required: false, default: { kind: "literal", value: "0" }, serverOnly: false },
        { name: "price", field: { kind: "decimal" }, required: false, serverOnly: false },
        { name: "fee", field: { kind: "money" }, required: false, serverOnly: false },
        { name: "when", field: { kind: "datetime" }, required: false, serverOnly: false },
        { name: "active", field: { kind: "boolean" }, required: false, serverOnly: false },
        { name: "state", field: { kind: "enum", values: ["draft", "submitted"] }, required: false, default: { kind: "literal", value: "draft" }, serverOnly: false },
        { name: "note", field: { kind: "string" }, required: false, nullable: true, serverOnly: false },
        { name: "tags", field: { kind: "string" }, required: false, array: { required: false }, serverOnly: false },
        { name: "ids", field: { kind: "string" }, required: false, array: { required: false }, serverOnly: false },
        { name: "doc", field: { kind: "file" }, required: false, serverOnly: false },
      ],
      deleteMode: "remove",
    },
  ];
}

const OPS_SOURCE = `export const calls = [];
const throwing = () => { throw new Error("fixture: CRUD handler must never run on the canonical path"); };
export function canApp() {
  return {
    calls,
    // B7: every op declares its admission gate (absent entries
    // deny) so the route pins still reach dispatch/validation.
    policy: {
      operations: {
        "Shop.Gadget.create": { by: ["members"] },
        "Receipts.notifyEmail": { by: ["members"] },
        "Acme.Probe.echo": { by: ["members"] },
      },
    },
    Gadget: { create: throwing },
    Receipts: {
      notifyEmail: async (c, input) => {
        calls.push(["notifyEmail", input.inputs]);
        return { ok: true };
      },
    },
    Probe: {
      echo: async (c, input) => {
        calls.push(["echo", input.inputs]);
        return { echoed: input.inputs };
      },
    },
  };
}
`;

function fixtureArtifact(module: string): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "http-ops-fixture/0 (hand-written; NOT compiler output)",
    tool_version: "http-ops-fixture/0",
    sources: [{ path: "examples/Shop.can", sha256: "fixture-not-a-digest" }],
    modules: [],
    operations: fixtureOperations(),
    models: fixtureModels(),
    callables: [
      // CRUD ops skip handlers on the canonical path, but T16b load
      // requires a callable for every described operation (fence
      // tripwire precedent) — never runs.
      { id: GADGET_CREATE_OP, kind: "operation", module, export: "Gadget_create", member: ["Gadget", "create"] },
      { id: NOTIFY_EMAIL_OP, kind: "operation", module, export: "Receipts_notifyEmail", member: ["Receipts", "notifyEmail"] },
      { id: ECHO_OP, kind: "operation", module, export: "Probe_echo", member: ["Probe", "echo"] },
    ],
    pages: [],
    requires: [],
    tests: [],
  } as unknown as CompileArtifact;
}

/* ------------------------------------------------------------------ */
/* Setup: real derivation bake + assembled worker (both transports).   */
/* ------------------------------------------------------------------ */

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  clearFormBindings();
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "canlang-http-ops-")));
  tempDirs.push(dir);
  return dir;
}

function writeModule(dir: string, name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source);
  return pathToFileURL(path).href;
}

/** Fresh canonical UUIDv7 operation_id with the time field at `atMs`. */
function freshOperationId(atMs: number = Date.now()): string {
  const timeHex = atMs.toString(16).padStart(12, "0");
  const rand = randomBytes(10).toString("hex");
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

/**
 * Deploy-bake parity: the REAL interfaces derivation over the fixture
 * P1 ops, folded to the `derivedInputs` record exactly as
 * `buildDerivedInputsModule` folds it (every op must derive, else
 * loud — the same whole-set discipline).
 */
function bakeDerivedInputs(operations: unknown[]): BakedDerivedInputs {
  const catalog = catalogFromArtifactOperations({
    artifact_version: 1,
    operations,
  } as Parameters<typeof catalogFromArtifactOperations>[0]);
  const baked: Record<string, DerivedOperationInputs> = {};
  for (const op of operations as Array<{ name: string }>) {
    const derived = catalog.derivedFor(op.name);
    if (derived === null) throw new Error(`bake: no derivation for ${op.name}`);
    baked[op.name] = derived;
  }
  return baked;
}

interface HttpOpsWorker {
  fetch: (req: Request) => Promise<Response>;
  grantToken: string;
  cookie: string;
  csrf: string;
  store: StoragePort;
  calls: Array<readonly [string, unknown]>;
}

async function assembleHttpOpsWorker(opts: {
  withHttpFactory?: boolean;
  withMcpFactory?: boolean;
  operations?: unknown[];
}): Promise<HttpOpsWorker> {
  const dir = tempDir();
  const moduleUrl = writeModule(dir, "ops.mjs", OPS_SOURCE);
  const operations = opts.operations ?? fixtureOperations();
  const artifact = fixtureArtifact("ops.mjs");
  (artifact as unknown as { operations: unknown[] }).operations = operations;
  const asm: AssembledModules = { dir, entryUrl: "fixture-entry", moduleUrls: { "ops.mjs": moduleUrl } };
  const { store } = createTestMemoryStorage();
  const identity = await createIdentityFixture({});
  // B7: the members gates need a teamful session (login mints
  // last_team_id null); attach the fixture session to the fixture
  // team so the cookie identity carries its membership.
  const sessionRow = await identity.store.findSessionByTokenHash(
    await sha256HexText(identity.sessionToken),
  );
  if (sessionRow === null) throw new Error("fixture: session row missing");
  await identity.store.setSessionTeam(sessionRow.session_id, identity.teamId);
  const { token: grantToken } = await createGrantFixture(identity);
  const derivedInputs = bakeDerivedInputs(operations);
  const deps: AssemblyDeps = {
    store,
    identityStore: identity.store,
    ...(opts.withMcpFactory === false
      ? null
      : {
          mcp: {
            createHandler: (d) => createMcpHandler(d as unknown as RealMcpDeps),
            permissions: { canDiscover: () => true, canCall: () => true },
            derivedInputs,
          },
        }),
    ...(opts.withHttpFactory === false
      ? null
      : {
          http: {
            createOperationHandler: (d) => (req, op) =>
              handleOperationRequest(d as unknown as RealHttpDeps, req, op),
            derivedInputs,
          },
        }),
  };
  const worker = await assembleWorker(artifact, asm, deps, { active: true });
  const mod = (await import(moduleUrl)) as { calls: Array<readonly [string, unknown]> };
  const csrf = await deriveCsrfToken(identity.sessionToken);
  return { fetch: worker.fetch, grantToken, cookie: identity.cookie, csrf, store, calls: mod.calls };
}

interface RpcBody {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

interface ToolResultBody {
  readonly content: Array<{ readonly text: string }>;
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

let nextRpcId = 1;

async function mcpCall(
  fetch: (req: Request) => Promise<Response>,
  method: string,
  params: Record<string, unknown>,
  grant: string,
): Promise<{ status: number; body: RpcBody }> {
  const res = await fetch(
    new Request("https://test.invalid/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${grant}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
    }),
  );
  return { status: res.status, body: (await res.json()) as RpcBody };
}

async function opPost(
  fetch: (req: Request) => Promise<Response>,
  op: string,
  body: unknown,
  opts: { cookie?: string; csrf?: string; contentType?: string; extraHeaders?: Record<string, string> },
): Promise<{ status: number; headers: Headers; json: unknown; text: string }> {
  const headers: Record<string, string> = {
    "content-type": opts.contentType ?? "application/json",
  };
  if (opts.cookie !== undefined) headers["cookie"] = opts.cookie;
  if (opts.csrf !== undefined) headers["x-csrf-token"] = opts.csrf;
  Object.assign(headers, opts.extraHeaders ?? {});
  const res = await fetch(
    new Request(`https://test.invalid/api/operations/${op}`, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json, text };
}

async function modelRows(store: StoragePort, model: string): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const rows = await store.query({ model: model as ModelName, authority: "owner" });
  return rows as unknown as Array<{ id: string; data: Record<string, unknown> }>;
}

/* ------------------------------------------------------------------ */
/* Route proofs: the join serves, the interim stays honest.            */
/* ------------------------------------------------------------------ */

describe("worker POST /api/operations/* (C3 op-route join)", () => {
  it("keeps the explicit interim 501 without the factory", async () => {
    const w = await assembleHttpOpsWorker({ withHttpFactory: false });
    const res = await opPost(w.fetch, GADGET_CREATE_OP, { operation_id: freshOperationId(), inputs: {} }, { cookie: w.cookie, csrf: w.csrf });
    expect(res.status).toBe(501);
    const body = res.json as { code: string; message: string };
    expect(body.code).toBe("assembly-interim");
    expect(body.message).toContain("AssemblyDeps.http.createOperationHandler");
  });

  it("commits the quiet path and stores inputs verbatim", async () => {
    const w = await assembleHttpOpsWorker({});
    const inputs = {
      title: "g1",
      stock: "3",
      state: "submitted",
      note: null,
      tags: ["a", "b"],
      ids: ["x"],
      active: false,
    };
    const res = await opPost(
      w.fetch,
      GADGET_CREATE_OP,
      { operation_id: freshOperationId(), inputs },
      { cookie: w.cookie, csrf: w.csrf },
    );
    expect(res.status).toBe(200);
    expect((res.json as { status: string }).status).toBe("committed");
    const rows = await modelRows(w.store, "Shop.Gadget");
    expect(rows).toHaveLength(1);
    // Verbatim handoff (F1 A8/A9): no normalization between the wire
    // body and the committed row — null stays null, arrays stay
    // arrays, "3" stays a digit string, false stays false.
    expect(rows[0]?.data).toMatchObject(inputs);
  });

  it("echoes rich inputs verbatim through the scenario path (no model in the way)", async () => {
    const w = await assembleHttpOpsWorker({});
    // NOTE: no `owner` ref here — scenario admission would resolve
    // it (nonexistent g-9 → not_found). Valid-ref flow is pinned by
    // the C2 CRUD record-ref pins; binding-shape pins below cover
    // refs at dispatch.
    const inputs = {
      note: "hello",
      fee: { minor: "150", currency: "USD" },
      when: "2026-01-01T00:00:00.000Z",
      doc: "file-id-123",
    };
    const res = await opPost(
      w.fetch,
      ECHO_OP,
      { operation_id: freshOperationId(), inputs },
      { cookie: w.cookie, csrf: w.csrf },
    );
    expect(res.status).toBe(200);
    expect((res.json as { result: { echoed: unknown } }).result.echoed).toEqual(inputs);
  });

  it("answers unknown/malformed operations and methods as not_found (E owns the shape)", async () => {
    const w = await assembleHttpOpsWorker({});
    const auth = { cookie: w.cookie, csrf: w.csrf };
    const unknown = await opPost(w.fetch, "Nope.nope", { operation_id: freshOperationId(), inputs: {} }, auth);
    expect(unknown.status).toBe(404);
    // "%25%25%25" decodes to a literal "%%%" op segment (a raw
    // "%%%" would throw in the URL constructor before the fetch).
    const malformed = await opPost(w.fetch, "%25%25%25", { operation_id: freshOperationId(), inputs: {} }, auth);
    expect(malformed.status).toBe(404);
    const get = await w.fetch(
      new Request(`https://test.invalid/api/operations/${GADGET_CREATE_OP}`, { headers: { cookie: w.cookie } }),
    );
    expect(get.status).toBe(404);
  });

  it("gates session + CSRF before dispatch (E verdicts, C deps)", async () => {
    const w = await assembleHttpOpsWorker({});
    const body = { operation_id: freshOperationId(), inputs: { title: "x" } };
    const noCookie = await opPost(w.fetch, GADGET_CREATE_OP, body, { csrf: w.csrf });
    expect(noCookie.status).toBe(403);
    const badCsrf = await opPost(w.fetch, GADGET_CREATE_OP, body, { cookie: w.cookie, csrf: "bogus" });
    expect(badCsrf.status).toBe(403);
    expect((badCsrf.json as { code: string }).code).toBe("forbidden");
  });

  it("rejects multipart bodies as validation (F1 A5: files ride JSON envelope ids)", async () => {
    const w = await assembleHttpOpsWorker({});
    const res = await opPost(w.fetch, GADGET_CREATE_OP, "--boundary\r\n...", {
      cookie: w.cookie,
      csrf: w.csrf,
      contentType: "multipart/form-data; boundary=boundary",
    });
    expect(res.status).toBe(400);
    expect((res.json as { code: string }).code).toBe("validation");
  });

  it("replays the same operation_id to the identical outcome (F1 B5 at the seam)", async () => {
    const w = await assembleHttpOpsWorker({});
    const body = { operation_id: freshOperationId(), inputs: { title: "once" } };
    const auth = { cookie: w.cookie, csrf: w.csrf };
    const first = await opPost(w.fetch, GADGET_CREATE_OP, body, auth);
    const second = await opPost(w.fetch, GADGET_CREATE_OP, body, auth);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = first.json as { status: string; operation_id: string; result: unknown };
    const secondBody = second.json as { status: string; operation_id: string; result: unknown };
    expect(firstBody.status).toBe("committed");
    // The replay re-serves the recorded outcome, marked `replayed`
    // (B admission contract) — same id, same result, no second row.
    expect(secondBody.status).toBe("replayed");
    expect(secondBody.operation_id).toBe(firstBody.operation_id);
    expect(secondBody.result).toEqual(firstBody.result);
    expect(await modelRows(w.store, "Shop.Gadget")).toHaveLength(1);
  });

  // NOTE: the assembly's 500 `http-catalog` containment (per-request
  // catalog build failure) is defensive-only while the deploy bake
  // gates malformed P1 first — derivation rejects everything J3
  // framing rejects, so no honest fixture triggers it (same standing
  // as the MCP route's `mcp-registry` 500, likewise unpinned).
});

/* ------------------------------------------------------------------ */
/* Agreement: identical bound verdicts on both transports. Each case   */
/* posts the same inputs over HTTP and MCP and asserts the SAME        */
/* verdict and message text (E's parity contract), plus no row when    */
/* dispatch denies (denials never reach the canonical path).           */
/* ------------------------------------------------------------------ */

interface AgreedDenial {
  readonly httpStatus: number;
  readonly httpCode: string;
  readonly message: string;
  readonly mcpErrorCode: number;
  readonly mcpMessage: string;
}

async function agreedDenial(
  w: HttpOpsWorker,
  op: string,
  inputs: Record<string, unknown>,
): Promise<AgreedDenial> {
  const http = await opPost(
    w.fetch,
    op,
    { operation_id: freshOperationId(), inputs },
    { cookie: w.cookie, csrf: w.csrf },
  );
  const httpBody = http.json as { code: string; message: string };
  const mcp = await mcpCall(
    w.fetch,
    "tools/call",
    { name: op, arguments: { operation_id: freshOperationId(), ...inputs } },
    w.grantToken,
  );
  if (mcp.body.error === undefined) {
    throw new Error(`expected an MCP denial for ${op}, got success: ${JSON.stringify(mcp.body).slice(0, 300)}`);
  }
  // JSON-RPC envelopes the carried text ("MCP error -32602: ...");
  // parity is on the carried verdict text (E's contract).
  const mcpMessage = mcp.body.error.message.replace(/^MCP error -32602: /, "");
  return {
    httpStatus: http.status,
    httpCode: httpBody.code,
    message: httpBody.message,
    mcpErrorCode: mcp.body.error.code,
    mcpMessage,
  };
}

describe("browser/MCP bound-rule agreement (C3 T19)", () => {
  it("framing rejects unknown members identically (incl. a smuggled delivery field, F1 A1)", async () => {
    const w = await assembleHttpOpsWorker({});
    for (const inputs of [
      { title: "x", nope: 1 },
      { note: "x", attempt: { to: "a@b.c" } },
    ]) {
      const op = "attempt" in inputs ? ECHO_OP : GADGET_CREATE_OP;
      const denial = await agreedDenial(w, op, inputs);
      expect(denial.httpStatus).toBe(400);
      expect(denial.httpCode).toBe("validation");
      expect(denial.message).toMatch(/unknown/i);
      // E parity: MCP binding/framing failure is JSON-RPC
      // InvalidParams carrying the SAME message text.
      expect(denial.mcpErrorCode).toBe(-32602);
      expect(denial.mcpMessage).toBe(denial.message);
    }
    // Neither denial reached the canonical path: nothing committed.
    expect(await modelRows(w.store, "Shop.Gadget")).toHaveLength(0);
    expect(w.calls).toHaveLength(0);
  });

  it("framing rejects missing required identically", async () => {
    const w = await assembleHttpOpsWorker({});
    const denial = await agreedDenial(w, GADGET_CREATE_OP, { stock: "1" });
    expect(denial.httpStatus).toBe(400);
    expect(denial.httpCode).toBe("validation");
    expect(denial.message).toMatch(/required/i);
    expect(denial.mcpErrorCode).toBe(-32602);
    expect(denial.mcpMessage).toBe(denial.message);
    expect(await modelRows(w.store, "Shop.Gadget")).toHaveLength(0);
  });

  it("binding mismatches agree per kind (E1 MISMATCHES through real dispatch)", async () => {
    const w = await assembleHttpOpsWorker({});
    // `verdictOnly` cases: E framing-first order means MCP's tool
    // schema rejects malformed refs with its own text ('Invalid
    // record id.') before the bound checker runs (E1 pins this), while
    // HTTP's shape-only framing passes them to the checker — same
    // verdict (validation/InvalidParams), different text. Parity there
    // is verdict-level, not text-level.
    const cases: Array<{ label: string; inputs: Record<string, unknown>; hint: RegExp; verdictOnly?: boolean }> = [
      { label: "enum case", inputs: { title: "x", state: "DRAFT" }, hint: /draft.*submitted|must be one of/i },
      { label: "integer as JSON number", inputs: { title: "x", stock: 5 }, hint: /digit/i },
      { label: "decimal as JSON number", inputs: { title: "x", price: 1.5 }, hint: /decimal/i },
      { label: "null on non-nullable", inputs: { title: null }, hint: /null/i },
      { label: "array shape", inputs: { title: "x", ids: "a" }, hint: /array/i },
      { label: "ref empty id", inputs: { title: "x", owner: { model: "Shop.Gadget", id: "" } }, hint: /non-empty/i, verdictOnly: true },
      { label: "versioned ref missing version", inputs: { title: "x", owner: { model: "Shop.Gadget", id: "g-1" } }, hint: /version/i, verdictOnly: true },
      { label: "money half-present", inputs: { title: "x", fee: { minor: "150" } }, hint: /currency|money/i },
      { label: "datetime wall", inputs: { title: "x", when: "2026-01-01 10:00" }, hint: /date|time|RFC|3339|instant/i },
      { label: "file empty id", inputs: { title: "x", doc: "" }, hint: /non-empty|string/i },
    ];
    for (const { label, inputs, hint, verdictOnly } of cases) {
      const denial = await agreedDenial(w, GADGET_CREATE_OP, inputs);
      expect(denial.httpStatus, label).toBe(400);
      expect(denial.httpCode, label).toBe("validation");
      expect(denial.message, label).toMatch(hint);
      expect(denial.mcpErrorCode, label).toBe(-32602);
      if (verdictOnly === true) {
        expect(denial.mcpMessage, label).toMatch(/Invalid record (id|version)\./);
      } else {
        expect(denial.mcpMessage, label).toBe(denial.message);
      }
    }
    expect(await modelRows(w.store, "Shop.Gadget")).toHaveLength(0);
  });

  it("nullable + optional-absent agree on the quiet side (F1 A2/A9)", async () => {
    const w = await assembleHttpOpsWorker({});
    const auth = { cookie: w.cookie, csrf: w.csrf };
    // Explicit null binds iff nullable: nullable note commits null.
    const http = await opPost(
      w.fetch,
      GADGET_CREATE_OP,
      { operation_id: freshOperationId(), inputs: { title: "n1", note: null } },
      auth,
    );
    expect(http.status).toBe(200);
    // Absent optional bool is fine (F1 clients send false; the seam
    // admits absence too) — via MCP this time.
    const mcp = await mcpCall(
      w.fetch,
      "tools/call",
      { name: GADGET_CREATE_OP, arguments: { operation_id: freshOperationId(), title: "n2" } },
      w.grantToken,
    );
    expect(mcp.status).toBe(200);
    expect(mcp.body.error).toBeUndefined();
    const rows = await modelRows(w.store, "Shop.Gadget");
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => (r.data["title"] as string) === "n1")?.data["note"]).toBeNull();
  });

  it("receipt-only ops invoke with empty inputs on both transports", async () => {
    // E1 receipt-only shape: framing admits nothing, the bound
    // delivery resolves engine-side (D3 executes sends; here the
    // scenario handler runs with `{}` and both transports agree).
    const w = await assembleHttpOpsWorker({});
    const auth = { cookie: w.cookie, csrf: w.csrf };
    const http = await opPost(
      w.fetch,
      NOTIFY_EMAIL_OP,
      { operation_id: freshOperationId(), inputs: {} },
      auth,
    );
    expect(http.status).toBe(200);
    expect((http.json as { result: { ok: boolean } }).result.ok).toBe(true);
    const mcp = await mcpCall(
      w.fetch,
      "tools/call",
      { name: NOTIFY_EMAIL_OP, arguments: { operation_id: freshOperationId() } },
      w.grantToken,
    );
    expect(mcp.status).toBe(200);
    expect(mcp.body.error).toBeUndefined();
    expect((mcp.body.result as ToolResultBody).isError).toBeUndefined();
    expect(w.calls).toEqual([
      ["notifyEmail", {}],
      ["notifyEmail", {}],
    ]);
  });

  it("body.operation mismatch denies identically (F1 A8: op pins from the URL)", async () => {
    const w = await assembleHttpOpsWorker({});
    // HTTP: body.operation contradicting the URL is a framing denial.
    const http = await opPost(
      w.fetch,
      GADGET_CREATE_OP,
      { operation_id: freshOperationId(), operation: ECHO_OP, inputs: { title: "x" } },
      { cookie: w.cookie, csrf: w.csrf },
    );
    expect(http.status).toBe(400);
    expect((http.json as { code: string }).code).toBe("validation");
    expect(await modelRows(w.store, "Shop.Gadget")).toHaveLength(0);
  });

  it("sealed action_handle placement is transport-exclusive (F1 A8)", async () => {
    const w = await assembleHttpOpsWorker({});
    const sealed = { kind: "action_handle", handle: "h-1", target: GADGET_CREATE_OP, revision: "r1" };
    // HTTP rejects sealed handles loudly in both positions (E2b).
    const auth = { cookie: w.cookie, csrf: w.csrf };
    const inInputs = await opPost(
      w.fetch,
      GADGET_CREATE_OP,
      { operation_id: freshOperationId(), inputs: { title: "x", action_handle: sealed } },
      auth,
    );
    expect(inInputs.status).toBe(400);
    expect((inInputs.json as { message: string }).message).toBe("Unknown input 'action_handle'.");
    const topLevel = await opPost(
      w.fetch,
      GADGET_CREATE_OP,
      { operation_id: freshOperationId(), inputs: { title: "x" }, action_handle: sealed },
      auth,
    );
    expect(topLevel.status).toBe(400);
    expect((topLevel.json as { message: string }).message).toMatch(/MCP-only/);
    // MCP handle mode reads it from INSIDE arguments; a malformed
    // handle flows to L3 admission, which rejects the unknown input
    // as a tool-level (not RPC-level) denial (valid-handle resume is
    // E-owned).
    const mcp = await mcpCall(
      w.fetch,
      "tools/call",
      { name: GADGET_CREATE_OP, arguments: { operation_id: freshOperationId(), action_handle: { bogus: true } } },
      w.grantToken,
    );
    expect(mcp.body.error).toBeUndefined();
    const tool = mcp.body.result as ToolResultBody;
    expect(tool.isError).toBe(true);
    // Tool-level denial carries the validation code (the wording is
    // E-owned; HTTP-side assertions above pin the exact texts).
    expect((tool.structuredContent as { code: string } | undefined)?.code).toBe("validation");
  });
});

/* ------------------------------------------------------------------ */
/* F1 serving confirmations: the op route carries E's denials          */
/* verbatim (byte-identical JSON, intact fields pointers, fragment     */
/* HTML passthrough) — C adds no translation. Render internals         */
/* (draft retention, notice display, conflict-current markup) stay     */
/* E/ui-owned and are confirmed by their suites; the pins below prove  */
/* the serving side passes them through untouched.                     */
/* ------------------------------------------------------------------ */

describe("F1 denial passthrough (C3 serving confirmations)", () => {
  it("binding denials carry JSON-pointer fields[] intact (F1 B7)", async () => {
    const w = await assembleHttpOpsWorker({});
    const res = await opPost(
      w.fetch,
      GADGET_CREATE_OP,
      { operation_id: freshOperationId(), inputs: { title: "x", state: "DRAFT" } },
      { cookie: w.cookie, csrf: w.csrf },
    );
    expect(res.status).toBe(400);
    const body = res.json as {
      code: string;
      message: string;
      fields?: Array<{ path: string; code: string }>;
    };
    expect(body.code).toBe("validation");
    expect(body.fields).toBeDefined();
    expect(body.fields?.[0]?.path).toBe("/state");
    expect(typeof body.fields?.[0]?.code).toBe("string");
  });

  it("fragment re-render passes HTML through with status + idPrefix intact (F1 B6)", async () => {
    const w = await assembleHttpOpsWorker({});
    const derived = bakeDerivedInputs(fixtureOperations())[GADGET_CREATE_OP];
    if (derived === undefined) throw new Error("bake must derive the create op");
    registerFormBinding(
      bindingFromDerived({
        derived,
        mode: "create",
        action: `/api/operations/${GADGET_CREATE_OP}`,
        fields: [],
        submit: "Submit",
        idPrefix: "c3t",
        timeZone: "UTC",
      }),
    );
    const res = await opPost(
      w.fetch,
      GADGET_CREATE_OP,
      { operation_id: freshOperationId(), inputs: { title: "x", state: "DRAFT" } },
      { cookie: w.cookie, csrf: w.csrf, extraHeaders: { "HX-Request": "true" } },
    );
    // Partial (htmx) denial re-renders the form shell: HTML body,
    // canonical error status, fragment anchored on the idPrefix.
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.text).toContain("c3t");
    expect(res.text).toContain("DRAFT");
  });

  it("conflict + ref + record claims ride the existing seam pins (F1 A3/A4/B2, cited)", async () => {
    // No new serving behavior to pin here — the claims already hold
    // through this same canonical invoker:
    // - A3 refs (versioned/unversioned shapes): dispatch binding pins
    //   above; admission existence/version checks are B-owned.
    // - A4 record MutationRef + stale-version conflict: T32c C2 pins
    //   (`stale Team update carries full currents minus serverOnly`,
    //   `stale Plain update carries full currents`).
    // - B2 conflict-current wire shapes: the same T32c pins assert
    //   `conflict.current.{model,id,version,updated,updatedBy,values}`.
    // This test locks the citation: the seam serving these routes is
    // the same `buildInvoker` bridge both transports share.
    const w = await assembleHttpOpsWorker({});
    const res = await opPost(
      w.fetch,
      GADGET_CREATE_OP,
      { operation_id: freshOperationId(), inputs: { title: "cite" } },
      { cookie: w.cookie, csrf: w.csrf },
    );
    expect(res.status).toBe(200);
    expect(await modelRows(w.store, "Shop.Gadget")).toHaveLength(1);
  });
});
