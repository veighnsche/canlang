/**
 * D3b JOIN ASSEMBLY (C owns this file): E's committed `Receipt.read`
 * wire-half (framing/binding/outcomes/gates per
 * `packages/interfaces/test/d3b-receipt-read.test.ts` on main) with the
 * stub reads replaced by REAL C serving — `buildInvoker` over the real
 * store, real grants, the REAL T25 join and the REAL work observer.
 *
 * Identity is single-store end to end: the MCP pipeline resolves the
 * grant against E's fixture identity store, and the SAME store backs
 * the invoker's live membership resolution (no identity bridging).
 *
 * Pins: a valid selected-receipt read through framing + real join +
 * observer (numeric revisions), null-association through the wire,
 * denied-identical-to-missing, stale-fence conflict, closed-input
 * rejections at both layers (E framing refuses with -32602 before
 * dispatch; shapes that pass E's binding but violate C's closed
 * envelope refuse as validation past dispatch), and E's gates
 * (anonymous 401, forbidden) never reaching real serving.
 *
 * Run from dist: root build, then
 * `node --test dist/runtime/d3b-join-assembly.test.js`.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ARTIFACT_VERSION,
  type ArtifactOperation,
  type CompileArtifact,
  type ModelName,
  type ReadEnvelope,
  type RecordId,
  type RecordVersion,
  type ResolvedIdentity,
  type StoragePort,
  type StoredRow,
} from "@canlang/contracts";
import { catalogFromArtifactOperations } from "@canlang/interfaces";
import { registryFromArtifactOperations } from "@canlang/interfaces";
import { createMcpHandler } from "@canlang/interfaces";
import {
  createTestApp,
  createTestMcpDeps,
  testRequest,
} from "../../../interfaces/dist/interfaces/src/testing.js";
import { createTestMemoryStorage } from "../../../state/dist/state/src/storage/memory.js";
import {
  RECEIPT_ASSOCIATION_MODEL,
  RECEIPT_MODEL,
  newAssociationRow,
  newReceiptRow,
} from "../../../state/dist/state/src/receipt/tables.js";
import { buildInvoker } from "../worker/assembly.js";
import type { ReadOutcome } from "../worker/assembly.js";
import { RECEIPT_READ_OPERATION, invokeSelectedReceiptRead } from "./invoke.js";

/* E-authored joint contract, mirrored verbatim from E's seam file
 * (packages/interfaces/test/d3b-receipt-read.test.ts). Only the
 * operation's existence is authored; everything else derives through
 * the real checked chain on both sides. */
const RECEIPT_READ: ArtifactOperation = {
  name: "Receipt.read",
  kind: "read",
  description: "Serve selected receipt leaves for an owner record field.",
  inputs: {
    fields: [
      { name: "recordId", field: { kind: "string" }, required: true },
      { name: "field", field: { kind: "string" }, required: true },
      {
        name: "selected",
        field: { kind: "enum", values: ["id", "status", "result", "error"] },
        required: true,
        array: { required: true },
      },
    ],
  },
};

const D3B_SLICE = { artifact_version: ARTIFACT_VERSION, operations: [RECEIPT_READ] };
const OP = "Receipt.read";
const VALID_ARGS = { recordId: "item-1", field: "notification", selected: ["status"] };

type McpHandler = (request: Request) => Promise<Response>;

interface RpcBody {
  readonly result?: {
    readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
    readonly structuredContent?: unknown;
    readonly isError?: boolean;
  };
  readonly error?: { readonly code: number; readonly message: string };
}

async function mcpCall(
  handler: McpHandler,
  method: string,
  params: Record<string, unknown>,
  grant?: string,
): Promise<{ status: number; body: RpcBody }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (grant !== undefined) headers["authorization"] = `Bearer ${grant}`;
  const res = await handler(
    testRequest("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  return { status: res.status, body: (await res.json()) as RpcBody };
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "canlang-d3b-asm-"));
  tempDirs.push(dir);
  return dir;
}

function writeModule(dir: string, name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source);
  return pathToFileURL(path).href;
}

/* Fixtures below mirror d3b-selected-receipt.test.ts (same T15b
 * delivery tags, same owner/association/receipt seeds); the serving
 * file stays untouched. */
const OPS_MODULE = `export function canApp() {
  return {
    policy: {
      operations: {},
      models: {
        "acme.Item": { read: ["Item.read.1"], public: ["Item.read.1"] },
      },
    },
  };
}
`;

function deliveryTag(): unknown {
  return {
    kind: "delivery",
    capability: "std.EmailV1",
    operation: "send",
    version: 1,
    result: { name: "EmailAccepted", fields: [{ name: "reference", type: "text" }] },
  };
}

function itemModel(): unknown {
  return {
    name: "acme.Item",
    fields: [
      { name: "title", required: true, serverOnly: false, field: { kind: "string" } },
      { name: "notification", required: false, serverOnly: false, field: deliveryTag() },
    ],
    deleteMode: "remove",
  };
}

function sealedModel(): unknown {
  return {
    name: "acme.Sealed",
    fields: [
      { name: "title", required: true, serverOnly: false, field: { kind: "string" } },
      { name: "notice", required: false, serverOnly: false, field: deliveryTag() },
    ],
    deleteMode: "remove",
  };
}

function receiptReadOp(): unknown {
  return {
    name: "Receipt.read",
    kind: "read",
    description: "",
    inputs: {
      fields: [
        { name: "recordId", field: { kind: "string" }, required: true },
        { name: "field", field: { kind: "string" }, required: true },
        { name: "selected", field: { kind: "string" }, required: true, array: { required: true } },
      ],
    },
  };
}

function receiptArtifact(models: unknown[]): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "d3b-fixture/0 (hand-written T15a shape; NOT compiler output)",
    tool_version: "d3b-fixture/0",
    sources: [{ path: "examples/TeamTasks.can", sha256: "fixture-not-a-digest" }],
    modules: [],
    callables: [],
    pages: [],
    requires: [],
    tests: [],
    operations: [receiptReadOp()],
    models,
  } as unknown as CompileArtifact;
}

function ownerRow(id: string, now: number): StoredRow {
  return {
    id: id as RecordId,
    version: 1 as RecordVersion,
    created: now,
    updated: now,
    createdBy: "member@d3b.test",
    updatedBy: "member@d3b.test",
    archivedAt: null,
    parent: null,
    data: { title: id, notification: "decoy-id" },
  } as StoredRow;
}

async function seedOwnerRow(store: StoragePort, model: string, id: string, now: number): Promise<void> {
  await store.commit({
    expectedRevision: await store.readRevision(),
    writes: [{ kind: "insert", model: model as ModelName, row: ownerRow(id, now) }],
    history: [],
    receipt: null,
    outbox: [],
    schedules: [],
    uniqueClaims: [],
    uniqueReleases: [],
  });
}

async function seedAssociationAndReceipt(
  store: StoragePort,
  input: { model: string; recordId: string; field: string },
  now: number,
): Promise<void> {
  const meta = { nowMs: now, actor: "member@d3b.test" };
  const association = newAssociationRow(
    {
      recordModel: input.model,
      recordId: input.recordId,
      field: input.field,
      deliveryId: "del_1",
      source: "mailroom.Mail.send",
      revision: 3,
    },
    meta,
  );
  const receipt = newReceiptRow(
    {
      deliveryId: "del_1",
      revision: 3,
      status: "succeeded",
      result: { ok: 1 },
      error: null,
      contentRef: null,
      resultExpiresAtMs: null,
    },
    meta,
  );
  await store.commit({
    expectedRevision: await store.readRevision(),
    writes: [
      { kind: "insert", model: RECEIPT_ASSOCIATION_MODEL as ModelName, row: association },
      { kind: "insert", model: RECEIPT_MODEL as ModelName, row: receipt },
    ],
    history: [],
    receipt: null,
    outbox: [],
    schedules: [],
    uniqueClaims: [],
    uniqueReleases: [],
  });
}

interface Assembly {
  readonly handler: McpHandler;
  readonly grant: string;
  readonly store: StoragePort;
  readonly dispatched: { count: number };
}

/**
 * E's seam setup with REAL C serving behind it: the MCP registry +
 * catalog derive from the joint slice through E's real derivation,
 * and the `Receipt.read` read routes to `buildInvoker` (real store,
 * real grants, real join, real observer). `readWith` overrides the
 * read implementation per test (fence-conflict only); the dispatch
 * counter proves gates never reach serving.
 */
async function assemblySetup(
  models: unknown[],
  readWith?: (
    envelope: ReadEnvelope,
    identity: ResolvedIdentity,
  ) => Promise<ReadOutcome>,
): Promise<Assembly> {
  const dir = tempDir();
  const url = writeModule(dir, "ops.mjs", OPS_MODULE);
  const asm = { dir, entryUrl: "fixture-entry", moduleUrls: { "ops.mjs": url } };
  const artifact = receiptArtifact(models);
  const { store } = createTestMemoryStorage();
  const dispatched = { count: 0 };
  const t = await createTestMcpDeps({
    descriptors: registryFromArtifactOperations(D3B_SLICE).list(createTestApp()),
    reads: {
      [OP]: async (envelope: ReadEnvelope, identity: ResolvedIdentity): Promise<ReadOutcome> => {
        dispatched.count += 1;
        if (readWith !== undefined) return readWith(envelope, identity);
        /* SAME store E's pipeline resolved the grant against: the
         * pipeline identity resolves membership live here. */
        const invoker = buildInvoker(artifact, asm, store, {
          memberships: t.identity.store,
          now: () => Date.now(),
        });
        return invoker.invokeRead(
          { operation: RECEIPT_READ_OPERATION, inputs: envelope.inputs as Record<string, unknown> },
          identity,
        );
      },
    },
  });
  const deps = { ...t.deps, catalog: catalogFromArtifactOperations(D3B_SLICE) };
  return { handler: createMcpHandler(deps), grant: t.grantToken, store, dispatched };
}

describe("D3b join assembly (E wire + real C serving)", () => {
  it("serves a valid selected-receipt read through framing + real join + observer", async () => {
    const a = await assemblySetup([itemModel()]);
    const now = Date.now();
    await seedOwnerRow(a.store, "acme.Item", "item-1", now);
    await seedAssociationAndReceipt(
      a.store,
      { model: "acme.Item", recordId: "item-1", field: "notification" },
      now,
    );
    const res = await mcpCall(a.handler, "tools/call", { name: OP, arguments: VALID_ARGS }, a.grant);
    assert.equal(res.status, 200);
    assert.equal(res.body.error, undefined);
    assert.equal(res.body.result?.isError, undefined);
    assert.deepEqual(res.body.result?.structuredContent, {
      outcome: "observed",
      projection: { status: "succeeded" },
      fenceRevision: 3,
      readRevision: 2,
    });
    const structured = res.body.result?.structuredContent as {
      readRevision: unknown;
      fenceRevision: unknown;
    };
    assert.equal(typeof structured.readRevision, "number");
    assert.equal(typeof structured.fenceRevision, "number");
    assert.equal(a.dispatched.count, 1);
    assert.equal(await a.store.readRevision(), 2);
  });

  it("serves null-association through the wire with its discriminator", async () => {
    const a = await assemblySetup([itemModel()]);
    await seedOwnerRow(a.store, "acme.Item", "item-1", Date.now());
    const res = await mcpCall(a.handler, "tools/call", { name: OP, arguments: VALID_ARGS }, a.grant);
    assert.equal(res.body.error, undefined);
    assert.deepEqual(res.body.result?.structuredContent, {
      outcome: "null-association",
      readRevision: 1,
    });
    assert.ok(res.body.result?.content[0]?.text.includes("null-association"));
  });

  it("denied reads are identical to missing reads through the wire", async () => {
    const a = await assemblySetup([itemModel(), sealedModel()]);
    await seedOwnerRow(a.store, "acme.Sealed", "sealed-1", Date.now());
    const missing = await mcpCall(
      a.handler,
      "tools/call",
      { name: OP, arguments: { recordId: "item-9", field: "notification", selected: ["status"] } },
      a.grant,
    );
    const grantless = await mcpCall(
      a.handler,
      "tools/call",
      { name: OP, arguments: { recordId: "sealed-1", field: "notice", selected: ["status"] } },
      a.grant,
    );
    assert.equal(missing.body.result?.isError, true);
    assert.equal(grantless.body.result?.isError, true);
    assert.deepEqual(missing.body.result?.structuredContent, grantless.body.result?.structuredContent);
    assert.deepEqual(missing.body.result?.structuredContent, {
      code: "not_found",
      message: "Receipt owner record not found.",
      retryable: false,
    });
  });

  it("a stale fence conflicts through the wire before any row is consulted", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", OPS_MODULE);
    const asm = { dir, entryUrl: "fixture-entry", moduleUrls: { "ops.mjs": url } };
    const artifact = receiptArtifact([itemModel()]);
    const { store } = createTestMemoryStorage();
    const now = Date.now();
    await seedOwnerRow(store, "acme.Item", "item-1", now);
    await seedAssociationAndReceipt(
      store,
      { model: "acme.Item", recordId: "item-1", field: "notification" },
      now,
    );
    const dispatched = { count: 0 };
    /* invokeRead carries no fence, so this arm calls real serving
     * directly with a stale fence. The StateError→BusinessError shape
     * mirrored here ({code, message, retryable:false}) is pinned
     * through the REAL invoker at serving level; this test pins the
     * real conflict × E's isError carriage. */
    const t = await createTestMcpDeps({
      descriptors: registryFromArtifactOperations(D3B_SLICE).list(createTestApp()),
      reads: {
        [OP]: async (envelope: ReadEnvelope, identity: ResolvedIdentity): Promise<ReadOutcome> => {
          dispatched.count += 1;
          try {
            const result = await invokeSelectedReceiptRead({
              asm,
              artifact,
              operation: RECEIPT_READ_OPERATION,
              inputs: envelope.inputs as Record<string, unknown>,
              identity,
              store,
              memberships: t.identity.store,
              fence: { revision: 0, enroll: () => {} },
              now: () => now,
            });
            return { result };
          } catch (error) {
            const code = (error as { code?: unknown }).code;
            const message = (error as { message?: unknown }).message;
            assert.equal(code, "conflict");
            assert.equal(typeof message, "string");
            return {
              error: { code: "conflict", message: message as string, retryable: false },
            };
          }
        },
      },
    });
    const handler = createMcpHandler({
      ...t.deps,
      catalog: catalogFromArtifactOperations(D3B_SLICE),
    });
    const res = await mcpCall(handler, "tools/call", { name: OP, arguments: VALID_ARGS }, t.grantToken);
    assert.equal(res.body.result?.isError, true);
    const structured = res.body.result?.structuredContent as { code: string; message: string };
    assert.equal(structured.code, "conflict");
    assert.match(structured.message, /moved/);
    assert.equal(dispatched.count, 1);
    assert.equal(await store.readRevision(), 2);
  });

  it("closed inputs reject at both layers (framing first, then serving)", async () => {
    const a = await assemblySetup([itemModel()]);
    await seedOwnerRow(a.store, "acme.Item", "item-1", Date.now());
    /* E framing refuses before dispatch (never reaches serving). */
    const framed: Array<[string, Record<string, unknown>, string]> = [
      ["unknown input", { ...VALID_ARGS, model: "acme.Item" }, "Unknown input 'model'"],
      ["missing selected", { recordId: "item-1", field: "notification" }, "Missing required input 'selected'"],
      ["bad leaf", { ...VALID_ARGS, selected: ["id", "bogus"] }, '"id", "status", "result", "error"'],
      ["non-array", { ...VALID_ARGS, selected: "status" }, "array inputs take arrays"],
    ];
    for (const [name, args, text] of framed) {
      const res = await mcpCall(a.handler, "tools/call", { name: OP, arguments: args }, a.grant);
      assert.equal(res.body.error?.code, -32602, name);
      assert.ok(res.body.error?.message.includes(text), name);
    }
    assert.equal(a.dispatched.count, 0);
    /* Past E's binding, C's closed envelope still refuses. */
    const empty = await mcpCall(
      a.handler,
      "tools/call",
      { name: OP, arguments: { ...VALID_ARGS, selected: [] } },
      a.grant,
    );
    assert.equal(empty.body.result?.isError, true);
    assert.equal((empty.body.result?.structuredContent as { code: string }).code, "validation");
    assert.match(
      (empty.body.result?.structuredContent as { message: string }).message,
      /must not be empty/,
    );
    const undeclared = await mcpCall(
      a.handler,
      "tools/call",
      { name: OP, arguments: { ...VALID_ARGS, field: "bogus" } },
      a.grant,
    );
    assert.equal(undeclared.body.result?.isError, true);
    assert.match(
      (undeclared.body.result?.structuredContent as { message: string }).message,
      /not a declared delivery field/,
    );
    assert.equal(a.dispatched.count, 2);
  });

  it("anonymous and forbidden reads never reach real serving", async () => {
    const a = await assemblySetup([itemModel()]);
    const anon = await mcpCall(a.handler, "tools/call", { name: OP, arguments: VALID_ARGS });
    assert.equal(anon.status, 401);
    assert.equal(a.dispatched.count, 0);

    const dir = tempDir();
    const url = writeModule(dir, "ops.mjs", OPS_MODULE);
    const asm = { dir, entryUrl: "fixture-entry", moduleUrls: { "ops.mjs": url } };
    const artifact = receiptArtifact([itemModel()]);
    const { store } = createTestMemoryStorage();
    const dispatched = { count: 0 };
    const t = await createTestMcpDeps({
      descriptors: registryFromArtifactOperations(D3B_SLICE).list(createTestApp()),
      reads: {
        [OP]: async (envelope: ReadEnvelope, identity: ResolvedIdentity): Promise<ReadOutcome> => {
          dispatched.count += 1;
          return buildInvoker(artifact, asm, store, {
            memberships: t.identity.store,
            now: () => Date.now(),
          }).invokeRead(
            { operation: RECEIPT_READ_OPERATION, inputs: envelope.inputs as Record<string, unknown> },
            identity,
          );
        },
      },
      call: { [OP]: false },
    });
    const denied = await mcpCall(
      createMcpHandler({ ...t.deps, catalog: catalogFromArtifactOperations(D3B_SLICE) }),
      "tools/call",
      { name: OP, arguments: VALID_ARGS },
      t.grantToken,
    );
    assert.equal(denied.body.result?.isError, true);
    const structured = denied.body.result?.structuredContent as { code: string; message: string };
    assert.equal(structured.code, "forbidden");
    assert.equal(structured.message, "You do not have permission to perform this action.");
    assert.equal(dispatched.count, 0);
  });
});
