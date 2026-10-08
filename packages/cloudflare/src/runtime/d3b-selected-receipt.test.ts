/**
 * D3b selected-receipt serving (colocated): `Receipt.read` routes
 * through the REAL T25 join with the REAL work observer (loaded per
 * call via the state work-loader — no doubles for the join proofs).
 *
 * Seams: registry routing (unknown-op / wrong-kind / reserved
 * collision), the closed-envelope validation table (C1/C7), model
 * binding (undeclared / ambiguous delivery fields), existence-hiding
 * not_found, fence conflict-before-rows + enrollment, and the join
 * contract (observed / null-association 1:1, denied-as-data mapping
 * units). Denied-as-data is mechanism-pinned by D's 9/9 and
 * unreachable through phase-1 serving (public transcription observes
 * or hides — member-scoped row grants arrive with T04b), so the
 * denied arm pins at the exported mapper unit instead.
 *
 * Run from dist: root build, then
 * `node --test dist/runtime/d3b-selected-receipt.test.js`.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import type {
  CompileArtifact,
  ModelName,
  RecordId,
  RecordVersion,
  ResolvedIdentity,
  StoragePort,
  StoredRow,
} from "@canlang/contracts";
import { resolveIdentity, sha256HexText } from "@canlang/identity";
import { createFrozenClock, createMemoryIdentityStore } from "@canlang/identity/testing";
import { createTestMemoryStorage } from "@canlang/state/storage/memory";
import {
  RECEIPT_ASSOCIATION_MODEL,
  RECEIPT_MODEL,
  newAssociationRow,
  newReceiptRow,
} from "@canlang/state/receipt/tables";
import { buildInvoker } from "../worker/assembly.js";
import type { AssembledModules, ReadOutcome } from "../worker/assembly.js";
import {
  RECEIPT_READ_OPERATION,
  invokeSelectedReceiptRead,
  mapReceiptJoinOutcome,
} from "./invoke.js";
import type { SelectedReceiptFence, SelectedReceiptServed } from "./invoke.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "canlang-d3b-"));
  tempDirs.push(dir);
  return dir;
}

function writeModule(dir: string, name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source);
  return pathToFileURL(path).href;
}

function stubAsm(dir: string, moduleUrls: Record<string, string>): AssembledModules {
  return { dir, entryUrl: "fixture-entry", moduleUrls };
}

const OPS_DECLARATIONS = `const modelPolicy = {
  "acme.Item": { read: ["Item.read.1"], public: ["Item.read.1"] },
};
export const appDefinition = {
  id: "ReceiptUnit",
  models: {
    "acme.Item": {
      readGrants: [{ rule: "Item.read.1", by: ["public"] }],
      fields: { title: { type: "text" }, notification: { type: "delivery", operation: "std.EmailV1.send", nullable: true } },
    },
  },
  policy: { operations: {}, models: modelPolicy },
};
const readRules = { "Item.read.1": () => true };
`;

const OPS_MODULE = `${OPS_DECLARATIONS}
export function canApp() {
  return {
    policy: appDefinition.policy,
    read: readRules,
  };
}
`;

/** T15b delivery tag (registry B3 shape): marks a model field as a delivery field. */
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

function secondModel(): unknown {
  return {
    name: "acme.Second",
    fields: [
      { name: "title", required: true, serverOnly: false, field: { kind: "string" } },
      { name: "notification", required: false, serverOnly: false, field: deliveryTag() },
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

/** Hand-written T15a-shaped artifact (NOT compiler output). */
function receiptArtifact(opts: {
  models?: unknown[];
  operations?: unknown[];
  callables?: unknown[];
  source?: string;
} = {}): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "d3b-fixture/0 (hand-written T15a shape; NOT compiler output)",
    tool_version: "d3b-fixture/0",
    sources: [{ path: "ops.mjs", sha256: createHash("sha256").update(opts.source ?? OPS_MODULE, "utf8").digest("hex") }],
    modules: [],
    callables: opts.callables ?? [],
    pages: [],
    requires: [],
    tests: [],
    operations: opts.operations ?? [receiptReadOp()],
    models: opts.models ?? [itemModel()],
  } as unknown as CompileArtifact;
}

interface SeededIdentity {
  readonly now: number;
  readonly store: ReturnType<typeof createMemoryIdentityStore>;
  readonly teamId: string;
  readonly memberId: string;
  readonly memberToken: string;
  readonly outsiderToken: string;
}

async function seedIdentity(): Promise<SeededIdentity> {
  const now = Date.now();
  const clock = createFrozenClock(now);
  const store = createMemoryIdentityStore({ clock });
  const team = await store.createTeam({});
  const member = await store.createUser({
    email: "member@d3b.test",
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
  const outsider = await store.createUser({
    email: "outsider@d3b.test",
    password_hash: "x",
    email_verified: true,
  });
  const outsiderToken = `outsider-token-${randomBytes(8).toString("hex")}`;
  await store.createSession({
    user_id: outsider.user_id,
    token_sha256: await sha256HexText(outsiderToken),
    expires_at: new Date(now + 3600_000).toISOString(),
    last_team_id: null,
  });
  return { now, store, teamId: team.team_id, memberId: member.user_id, memberToken, outsiderToken };
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

interface ReceiptSetup {
  readonly asm: AssembledModules;
  readonly artifact: CompileArtifact;
  readonly store: StoragePort;
  readonly seed: SeededIdentity;
}

async function receiptSetup(artifact: CompileArtifact): Promise<ReceiptSetup> {
  const dir = tempDir();
  const url = writeModule(dir, "ops.mjs", OPS_MODULE);
  const asm = stubAsm(dir, { "ops.mjs": url });
  const { store } = createTestMemoryStorage();
  const seed = await seedIdentity();
  return { asm, artifact, store, seed };
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
    data: { title: id, notification: null },
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
  const owner = await store.load(input.model as ModelName, input.recordId as RecordId);
  assert.ok(owner);
  const meta = { nowMs: now, actor: "member@d3b.test" };
  const association = newAssociationRow(
    {
      recordModel: input.model,
      recordId: input.recordId,
      field: input.field,
      deliveryId: "del_1",
      source: "std.EmailV1.send",
      revision: 3,
    },
    meta,
  );
  const receipt = newReceiptRow(
    {
      deliveryId: "del_1",
      revision: 3,
      status: "succeeded",
      result: { reference: "accepted-1" },
      error: null,
      contentRef: null,
      resultExpiresAtMs: null,
    },
    meta,
  );
  await store.commit({
    expectedRevision: await store.readRevision(),
    writes: [
      { kind: "update", model: input.model as ModelName, id: owner.id, expectedVersion: owner.version,
        row: { ...owner, version: (owner.version + 1) as RecordVersion, updated: now,
          data: { ...owner.data, [input.field]: { id: "del_1", operation: "std.EmailV1.send" } } } },
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

function recordingFence(revision: number): SelectedReceiptFence & {
  readonly enrollments: Array<{ kind: string; model: string; id: string; version: number }>;
} {
  const enrollments: Array<{ kind: string; model: string; id: string; version: number }> = [];
  return {
    revision,
    enrollments,
    enroll(dependency: { kind: "record"; model: string; id: string; version: number }): void {
      enrollments.push({ ...dependency });
    },
  };
}

function mustError(outcome: ReadOutcome): { code: string; message: string } {
  if ("error" in outcome) return outcome.error;
  throw new Error(`want error, got ${JSON.stringify(outcome)}`);
}

describe("D3b receipt routing (read-def anchors routing + admission)", () => {
  it("rejects unknown operations with the engine's exact text", async () => {
    const s = await receiptSetup(receiptArtifact({ operations: [] }));
    const invoker = buildInvoker(s.artifact, s.asm, s.store, {
      memberships: s.seed.store,
      now: () => s.seed.now,
    });
    const outcome = await invoker.invokeRead(
      {
        operation: RECEIPT_READ_OPERATION,
        inputs: { recordId: "item-1", field: "notification", selected: ["status"] },
      },
      await identityFor(s.seed, s.seed.memberToken),
    );
    assert.deepEqual(mustError(outcome), {
      code: "validation",
      message: 'Unknown operation "Receipt.read".',
      retryable: false,
    });
  });

  it("serves null-association end to end through the invoker bridge", async () => {
    const s = await receiptSetup(receiptArtifact());
    await seedOwnerRow(s.store, "acme.Item", "item-1", s.seed.now);
    const invoker = buildInvoker(s.artifact, s.asm, s.store, {
      memberships: s.seed.store,
      now: () => s.seed.now,
    });
    const outcome = await invoker.invokeRead(
      {
        operation: RECEIPT_READ_OPERATION,
        inputs: { recordId: "item-1", field: "notification", selected: ["status"] },
      },
      await identityFor(s.seed, s.seed.memberToken),
    );
    assert.ok("result" in outcome, `want result, got ${JSON.stringify(outcome)}`);
    assert.deepEqual(outcome.result, { outcome: "null-association", readRevision: 1 });
  });

  it("serves anonymous callers on public models (gate-public + public grants)", async () => {
    const s = await receiptSetup(receiptArtifact());
    await seedOwnerRow(s.store, "acme.Item", "item-1", s.seed.now);
    const invoker = buildInvoker(s.artifact, s.asm, s.store, {
      memberships: s.seed.store,
      now: () => s.seed.now,
    });
    const outcome = await invoker.invokeRead(
      {
        operation: RECEIPT_READ_OPERATION,
        inputs: { recordId: "item-1", field: "notification", selected: ["id"] },
      },
      anonymousIdentity(),
    );
    assert.ok("result" in outcome, `want result, got ${JSON.stringify(outcome)}`);
    assert.deepEqual(outcome.result, { outcome: "null-association", readRevision: 1 });
  });

  it("refuses a non-read Receipt.read def loud (loader skew, never mis-served)", async () => {
    const dir = tempDir();
    const source = `${OPS_DECLARATIONS}
      export function canApp() {
        return {
          read: readRules,
          policy: {
            operations: { "Receipt.read": { by: ["members"] } },
            models: modelPolicy,
          },
          Shop: { probe: async () => ({ never: true }) },
        };
      }`;
    const url = writeModule(dir, "ops.mjs", source);
    const asm = stubAsm(dir, { "ops.mjs": url });
    const artifact = receiptArtifact({
      source,
      operations: [{ name: "Receipt.read", kind: "scenario", description: "", inputs: { fields: [] } }],
      callables: [
        { id: "Receipt.read", kind: "operation", module: "ops.mjs", export: "Shop_probe", member: ["Shop", "probe"] },
      ],
    });
    const { store } = createTestMemoryStorage();
    const seed = await seedIdentity();
    await assert.rejects(
      invokeSelectedReceiptRead({
        asm,
        artifact,
        operation: RECEIPT_READ_OPERATION,
        inputs: { recordId: "item-1", field: "notification", selected: ["status"] },
        identity: await identityFor(seed, seed.memberToken),
        store,
        memberships: seed.store,
      }),
      /not a read def/,
    );
  });

  it("refuses a model named Receipt alongside the op loud (reserved collision)", async () => {
    const receiptModel = {
      name: "Receipt",
      fields: [{ name: "title", required: true, serverOnly: false, field: { kind: "string" } }],
      deleteMode: "remove",
    };
    const s = await receiptSetup(receiptArtifact({ models: [itemModel(), receiptModel] }));
    await assert.rejects(
      invokeSelectedReceiptRead({
        asm: s.asm,
        artifact: s.artifact,
        operation: RECEIPT_READ_OPERATION,
        inputs: { recordId: "item-1", field: "notification", selected: ["status"] },
        identity: await identityFor(s.seed, s.seed.memberToken),
        store: s.store,
        memberships: s.seed.store,
      }),
      /reserved collision/,
    );
  });
});

describe("D3b receipt envelope validation (closed shape, C1/C7)", () => {
  it("rejects every malformation as validation with the store untouched", async () => {
    const s = await receiptSetup(receiptArtifact());
    const identity = await identityFor(s.seed, s.seed.memberToken);
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ["model key", { recordId: "item-1", field: "notification", selected: ["status"], model: "acme.Item" }, /must not carry model/],
      ["unknown key", { recordId: "item-1", field: "notification", selected: ["status"], extra: 1 }, /unknown key/],
      ["missing recordId", { field: "notification", selected: ["status"] }, /recordId must be/],
      ["empty recordId", { recordId: "", field: "notification", selected: ["status"] }, /recordId must be/],
      ["non-string recordId", { recordId: 7, field: "notification", selected: ["status"] }, /recordId must be/],
      ["missing field", { recordId: "item-1", selected: ["status"] }, /field must be/],
      ["empty field", { recordId: "item-1", field: "", selected: ["status"] }, /field must be/],
      ["traversal field", { recordId: "item-1", field: "a.b", selected: ["status"] }, /never traversal/],
      ["missing selected", { recordId: "item-1", field: "notification" }, /selected must be/],
      ["non-array selected", { recordId: "item-1", field: "notification", selected: "status" }, /selected must be/],
      ["empty selected", { recordId: "item-1", field: "notification", selected: [] }, /must not be empty/],
      ["unknown leaf", { recordId: "item-1", field: "notification", selected: ["bogus"] }, /unknown property/],
      ["undeclared field", { recordId: "item-1", field: "bogus", selected: ["status"] }, /not a declared delivery field/],
    ];
    for (const [name, inputs, pattern] of cases) {
      const invoker = buildInvoker(s.artifact, s.asm, s.store, {
        memberships: s.seed.store,
        now: () => s.seed.now,
      });
      const outcome = await invoker.invokeRead({ operation: RECEIPT_READ_OPERATION, inputs }, identity);
      const error = mustError(outcome);
      assert.equal(error.code, "validation", name);
      assert.match(error.message, pattern, name);
    }
    assert.equal(await s.store.readRevision(), 0);
  });

  it("refuses ambiguous delivery fields loud (fail-closed, never probed across)", async () => {
    const s = await receiptSetup(receiptArtifact({ models: [itemModel(), secondModel()] }));
    const outcome = await buildInvoker(s.artifact, s.asm, s.store, {
      memberships: s.seed.store,
      now: () => s.seed.now,
    }).invokeRead(
      {
        operation: RECEIPT_READ_OPERATION,
        inputs: { recordId: "item-1", field: "notification", selected: ["status"] },
      },
      await identityFor(s.seed, s.seed.memberToken),
    );
    const error = mustError(outcome);
    assert.equal(error.code, "validation");
    assert.match(error.message, /multiple models/);
    assert.equal(await s.store.readRevision(), 0);
  });
});

describe("D3b receipt existence-hiding (denied-vs-missing never leaks)", () => {
  it("hides missing rows and grantless models behind identical not_found", async () => {
    const s = await receiptSetup(receiptArtifact({ models: [itemModel(), sealedModel()] }));
    await seedOwnerRow(s.store, "acme.Sealed", "sealed-1", s.seed.now);
    const invoker = buildInvoker(s.artifact, s.asm, s.store, {
      memberships: s.seed.store,
      now: () => s.seed.now,
    });
    const identity = await identityFor(s.seed, s.seed.memberToken);
    const missing = mustError(
      await invoker.invokeRead(
        {
          operation: RECEIPT_READ_OPERATION,
          inputs: { recordId: "item-9", field: "notification", selected: ["status"] },
        },
        identity,
      ),
    );
    const grantless = mustError(
      await invoker.invokeRead(
        {
          operation: RECEIPT_READ_OPERATION,
          inputs: { recordId: "sealed-1", field: "notice", selected: ["status"] },
        },
        identity,
      ),
    );
    assert.deepEqual(missing, grantless);
    assert.deepEqual(missing, {
      code: "not_found",
      message: "Receipt owner record not found.",
      retryable: false,
    });
  });
});

describe("D3b receipt join contract (real join + real observer)", () => {
  it("refuses a decoy owner field even when its protected association exists", async () => {
    const s = await receiptSetup(receiptArtifact());
    await seedOwnerRow(s.store, "acme.Item", "item-1", s.seed.now);
    await seedAssociationAndReceipt(s.store,
      { model: "acme.Item", recordId: "item-1", field: "notification" }, s.seed.now);
    const owner = await s.store.load("acme.Item" as ModelName, "item-1" as RecordId);
    assert.ok(owner);
    await s.store.commit({ expectedRevision: await s.store.readRevision(),
      writes: [{ kind: "update", model: "acme.Item" as ModelName, id: owner.id,
        expectedVersion: owner.version, row: { ...owner,
          version: (owner.version + 1) as RecordVersion,
          data: { ...owner.data, notification: "decoy-id" } } }],
      history: [], receipt: null, outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [],
    });
    await assert.rejects(invokeSelectedReceiptRead({
      asm: s.asm, artifact: s.artifact, operation: RECEIPT_READ_OPERATION,
      inputs: { recordId: "item-1", field: "notification", selected: ["status", "result"] },
      identity: await identityFor(s.seed, s.seed.memberToken), store: s.store,
      memberships: s.seed.store, now: () => s.seed.now,
    }), /current owner delivery/);
  });

  it("observes exact selected leaves with fence + read revisions as numbers", async () => {
    const s = await receiptSetup(receiptArtifact());
    await seedOwnerRow(s.store, "acme.Item", "item-1", s.seed.now);
    await seedAssociationAndReceipt(
      s.store,
      { model: "acme.Item", recordId: "item-1", field: "notification" },
      s.seed.now,
    );
    const served = await invokeSelectedReceiptRead({
      asm: s.asm,
      artifact: s.artifact,
      operation: RECEIPT_READ_OPERATION,
      inputs: { recordId: "item-1", field: "notification", selected: ["status", "result"] },
      identity: await identityFor(s.seed, s.seed.memberToken),
      store: s.store,
      memberships: s.seed.store,
      now: () => s.seed.now,
    });
    assert.deepEqual(served, {
      outcome: "observed",
      projection: { status: "succeeded", result: { reference: "accepted-1" } },
      fenceRevision: 3,
      readRevision: 2,
    });
    assert.equal(typeof served.readRevision, "number");
    if (served.outcome !== "observed") throw new Error("unreachable");
    assert.equal(typeof served.fenceRevision, "number");
    // Duplicate leaves collapse (kernel order); store untouched by reads.
    const duped = await invokeSelectedReceiptRead({
      asm: s.asm,
      artifact: s.artifact,
      operation: RECEIPT_READ_OPERATION,
      inputs: { recordId: "item-1", field: "notification", selected: ["status", "status", "result"] },
      identity: await identityFor(s.seed, s.seed.memberToken),
      store: s.store,
      memberships: s.seed.store,
      now: () => s.seed.now,
    });
    assert.deepEqual(duped, served);
    assert.equal(await s.store.readRevision(), 2);
  });

  it("reads id-only without a fence revision", async () => {
    const s = await receiptSetup(receiptArtifact());
    await seedOwnerRow(s.store, "acme.Item", "item-1", s.seed.now);
    await seedAssociationAndReceipt(
      s.store,
      { model: "acme.Item", recordId: "item-1", field: "notification" },
      s.seed.now,
    );
    const served = await invokeSelectedReceiptRead({
      asm: s.asm,
      artifact: s.artifact,
      operation: RECEIPT_READ_OPERATION,
      inputs: { recordId: "item-1", field: "notification", selected: ["id"] },
      identity: await identityFor(s.seed, s.seed.memberToken),
      store: s.store,
      memberships: s.seed.store,
      now: () => s.seed.now,
    });
    assert.deepEqual(served, {
      outcome: "observed",
      projection: { id: "del_1" },
      fenceRevision: null,
      readRevision: 2,
    });
  });

  it("serves null-association with the discriminator (never denial-shaped)", async () => {
    const s = await receiptSetup(receiptArtifact());
    await seedOwnerRow(s.store, "acme.Item", "item-1", s.seed.now);
    const served = await invokeSelectedReceiptRead({
      asm: s.asm,
      artifact: s.artifact,
      operation: RECEIPT_READ_OPERATION,
      inputs: { recordId: "item-1", field: "notification", selected: ["status"] },
      identity: await identityFor(s.seed, s.seed.memberToken),
      store: s.store,
      memberships: s.seed.store,
      now: () => s.seed.now,
    });
    assert.deepEqual(served, { outcome: "null-association", readRevision: 1 });
  });

  it("maps denied-as-data 1:1 at the outcome unit (phase-1 unreachable via serving)", async () => {
    // Denied needs member-scoped row grants (T04b): public
    // transcription observes-or-hides, so the denied arm pins here
    // (t16b mapper-unit precedent) while D's 9/9 pin the mechanism.
    assert.deepEqual(
      mapReceiptJoinOutcome({ outcome: "denied", denied: ["status", "result"], readRevision: 4 }),
      { outcome: "denied", denied: ["status", "result"], readRevision: 4 },
    );
    assert.deepEqual(
      mapReceiptJoinOutcome({
        outcome: "observed",
        projection: { status: "succeeded" },
        fenceRevision: 3,
        readRevision: 2,
      }),
      {
        outcome: "observed",
        projection: { status: "succeeded" },
        fenceRevision: 3,
        readRevision: 2,
      },
    );
    assert.deepEqual(
      mapReceiptJoinOutcome({ outcome: "null-association", readRevision: 2 }),
      { outcome: "null-association", readRevision: 2 },
    );
    for (const [name, outcome] of [
      ["no discriminator", { readRevision: 1 }],
      ["unknown discriminator", { outcome: "maybe", readRevision: 1 }],
      ["non-numeric readRevision", { outcome: "null-association", readRevision: "2" }],
      ["non-object projection", { outcome: "observed", projection: 7, fenceRevision: null, readRevision: 1 }],
      ["unknown projection key", { outcome: "observed", projection: { wat: 1 }, fenceRevision: null, readRevision: 1 }],
      ["non-numeric fenceRevision", { outcome: "observed", projection: {}, fenceRevision: "3", readRevision: 1 }],
      ["empty denied set", { outcome: "denied", denied: [], readRevision: 1 }],
      ["unknown denied leaf", { outcome: "denied", denied: ["bogus"], readRevision: 1 }],
    ] as Array<[string, unknown]>) {
      assert.throws(() => mapReceiptJoinOutcome(outcome), /d3b: join served/, name);
    }
  });
});

describe("D3b receipt fence (conflict-before-rows + enrollment)", () => {
  it("conflicts on a moved nested checkpoint before any row is consulted", async () => {
    const s = await receiptSetup(receiptArtifact());
    await seedOwnerRow(s.store, "acme.Item", "item-1", s.seed.now);
    const fence = recordingFence(0);
    await assert.rejects(
      invokeSelectedReceiptRead({
        asm: s.asm,
        artifact: s.artifact,
        operation: RECEIPT_READ_OPERATION,
        inputs: { recordId: "item-1", field: "notification", selected: ["status"] },
        identity: await identityFor(s.seed, s.seed.memberToken),
        store: s.store,
        memberships: s.seed.store,
        fence,
        now: () => s.seed.now,
      }),
      (error: unknown) => {
        const err = error as { code?: unknown; message?: unknown };
        assert.equal(err.code, "conflict");
        assert.match(String(err.message), /Fence checkpoint moved/);
        return true;
      },
    );
    assert.deepEqual(fence.enrollments, []);
    assert.equal(await s.store.readRevision(), 1);
  });

  it("enrolls the owner pre-load plus the observed receipt row, in order", async () => {
    const s = await receiptSetup(receiptArtifact());
    await seedOwnerRow(s.store, "acme.Item", "item-1", s.seed.now);
    await seedAssociationAndReceipt(
      s.store,
      { model: "acme.Item", recordId: "item-1", field: "notification" },
      s.seed.now,
    );
    const fence = recordingFence(2);
    const served = await invokeSelectedReceiptRead({
      asm: s.asm,
      artifact: s.artifact,
      operation: RECEIPT_READ_OPERATION,
      inputs: { recordId: "item-1", field: "notification", selected: ["status"] },
      identity: await identityFor(s.seed, s.seed.memberToken),
      store: s.store,
      memberships: s.seed.store,
      fence,
      now: () => s.seed.now,
    });
    assert.equal(served.outcome, "observed");
    assert.deepEqual(fence.enrollments, [
      { kind: "record", model: "acme.Item", id: "item-1", version: 2 },
      { kind: "record", model: "work.receipt", id: "del_1", version: 1 },
    ]);
  });

  it("enrolls only the pre-load on id-only and null reads (no receipt enrollment)", async () => {
    const s = await receiptSetup(receiptArtifact());
    await seedOwnerRow(s.store, "acme.Item", "item-1", s.seed.now);
    await seedAssociationAndReceipt(
      s.store,
      { model: "acme.Item", recordId: "item-1", field: "notification" },
      s.seed.now,
    );
    const idFence = recordingFence(2);
    const idOnly = await invokeSelectedReceiptRead({
      asm: s.asm,
      artifact: s.artifact,
      operation: RECEIPT_READ_OPERATION,
      inputs: { recordId: "item-1", field: "notification", selected: ["id"] },
      identity: await identityFor(s.seed, s.seed.memberToken),
      store: s.store,
      memberships: s.seed.store,
      fence: idFence,
      now: () => s.seed.now,
    });
    assert.equal(idOnly.outcome, "observed");
    assert.deepEqual(idFence.enrollments, [
      { kind: "record", model: "acme.Item", id: "item-1", version: 2 },
    ]);
    await seedOwnerRow(s.store, "acme.Item", "item-2", s.seed.now);
    const nullFence = recordingFence(3);
    const nulled = await invokeSelectedReceiptRead({
      asm: s.asm,
      artifact: s.artifact,
      operation: RECEIPT_READ_OPERATION,
      inputs: { recordId: "item-2", field: "notification", selected: ["status"] },
      identity: await identityFor(s.seed, s.seed.memberToken),
      store: s.store,
      memberships: s.seed.store,
      fence: nullFence,
      now: () => s.seed.now,
    });
    assert.equal(nulled.outcome, "null-association");
    assert.deepEqual(
      nullFence.enrollments,
      [{ kind: "record", model: "acme.Item", id: "item-2", version: 1 }],
      "null reads enroll the pre-load only",
    );
  });
});

describe("D3b receipt public consumer (observed through the invoker bridge)", () => {
  it("serves the 1:1 observed outcome per E's envelope", async () => {
    const s = await receiptSetup(receiptArtifact());
    await seedOwnerRow(s.store, "acme.Item", "item-1", s.seed.now);
    await seedAssociationAndReceipt(
      s.store,
      { model: "acme.Item", recordId: "item-1", field: "notification" },
      s.seed.now,
    );
    const outcome = await buildInvoker(s.artifact, s.asm, s.store, {
      memberships: s.seed.store,
      now: () => s.seed.now,
    }).invokeRead(
      {
        operation: RECEIPT_READ_OPERATION,
        inputs: { recordId: "item-1", field: "notification", selected: ["status", "result"] },
      },
      await identityFor(s.seed, s.seed.memberToken),
    );
    assert.ok("result" in outcome, `want result, got ${JSON.stringify(outcome)}`);
    assert.deepEqual(outcome.result, {
      outcome: "observed",
      projection: { status: "succeeded", result: { reference: "accepted-1" } },
      fenceRevision: 3,
      readRevision: 2,
    } satisfies SelectedReceiptServed);
  });
});
