/**
 * Q2 observer seam (colocated): `Receipt.read` serving resolves its
 * selected-receipt observer in order — injected `opts.observer` >
 * B's worker-safe observer module > the TEST-ONLY work-loader leg —
 * loud at the end, never a silent fallback.
 *
 * Pins (B's module is not landed yet, so the production leg is
 * driven through injection): an injected observer serves the exact
 * observed projection end-to-end through the REAL join; the
 * uninjected path serves byte-identical output through the
 * work-loader fallback (no behavior change); pre-join refusals
 * short-circuit before any observer runs. The injected binding
 * shape IS the B-half contract (`StateReceiptObserverProducer`
 * return): `{ observeSelectedReceipt }`.
 *
 * Run from dist: root build, then
 * `node --test dist/runtime/d3b-observer-seam.test.js`.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
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
import { createTestMemoryStorage } from "../../../state/dist/state/src/storage/memory.js";
import {
  RECEIPT_ASSOCIATION_MODEL,
  RECEIPT_MODEL,
  newAssociationRow,
  newReceiptRow,
} from "../../../state/dist/state/src/receipt/tables.js";
import { loadWorkReceiptFns } from "../../../state/dist/state/src/receipt/work-loader.js";
import type { AssembledModules } from "../worker/assembly.js";
import {
  RECEIPT_READ_OPERATION,
  invokeReadCanonical,
  invokeSelectedReceiptRead,
  isObserverModuleAbsent,
} from "./invoke.js";
import type { SelectedReceiptObserverBinding } from "./invoke.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "canlang-d3b-seam-"));
  tempDirs.push(dir);
  return dir;
}

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

function receiptArtifact(): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "d3b-seam-fixture/0 (hand-written T15a shape; NOT compiler output)",
    tool_version: "d3b-seam-fixture/0",
    sources: [{ path: "examples/TeamTasks.can", sha256: "fixture-not-a-digest" }],
    modules: [],
    callables: [],
    pages: [],
    requires: [],
    tests: [],
    operations: [
      {
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
      },
    ],
    models: [
      {
        name: "acme.Item",
        fields: [
          { name: "title", required: true, serverOnly: false, field: { kind: "string" } },
          { name: "notification", required: false, serverOnly: false, field: deliveryTag() },
        ],
        deleteMode: "remove",
      },
    ],
  } as unknown as CompileArtifact;
}

interface SeededIdentity {
  readonly now: number;
  readonly store: ReturnType<typeof createMemoryIdentityStore>;
  readonly memberToken: string;
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
  return { now, store, memberToken };
}

async function identityFor(seed: SeededIdentity, token: string): Promise<ResolvedIdentity> {
  return resolveIdentity(
    seed.store,
    { session_token: token },
    { clock: { nowMs: () => seed.now } },
  );
}

interface SeamSetup {
  readonly asm: AssembledModules;
  readonly artifact: CompileArtifact;
  readonly store: StoragePort;
  readonly seed: SeededIdentity;
}

async function seamSetup(): Promise<SeamSetup> {
  const dir = tempDir();
  const opsPath = join(dir, "ops.mjs");
  writeFileSync(opsPath, OPS_MODULE);
  const asm: AssembledModules = {
    dir,
    entryUrl: "fixture-entry",
    moduleUrls: { "ops.mjs": pathToFileURL(opsPath).href },
  };
  const { store } = createTestMemoryStorage();
  const seed = await seedIdentity();
  return { asm, artifact: receiptArtifact(), store, seed };
}

async function seedWorld(store: StoragePort, now: number): Promise<void> {
  await store.commit({
    expectedRevision: await store.readRevision(),
    writes: [
      {
        kind: "insert",
        model: "acme.Item" as ModelName,
        row: {
          id: "item-1" as RecordId,
          version: 1 as RecordVersion,
          created: now,
          updated: now,
          createdBy: "member@d3b.test",
          updatedBy: "member@d3b.test",
          archivedAt: null,
          parent: null,
          data: { title: "item-1", notification: "decoy-id" },
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
  const meta = { nowMs: now, actor: "member@d3b.test" };
  await store.commit({
    expectedRevision: await store.readRevision(),
    writes: [
      {
        kind: "insert",
        model: RECEIPT_ASSOCIATION_MODEL as ModelName,
        row: newAssociationRow(
          {
            recordModel: "acme.Item",
            recordId: "item-1",
            field: "notification",
            deliveryId: "del_1",
            source: "mailroom.Mail.send",
            revision: 3,
          },
          meta,
        ),
      },
      {
        kind: "insert",
        model: RECEIPT_MODEL as ModelName,
        row: newReceiptRow(
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
        ),
      },
    ],
    history: [],
    receipt: null,
    outbox: [],
    schedules: [],
    uniqueClaims: [],
    uniqueReleases: [],
  });
}

/**
 * The B-half contract shape, fed by the real observer behind a
 * recorder: serving must call THROUGH this binding (production leg)
 * and serve the exact observed projection.
 */
async function recordingBinding(calls: unknown[]): Promise<SelectedReceiptObserverBinding> {
  const { observeSelectedReceipt } = await loadWorkReceiptFns();
  const real = observeSelectedReceipt as (input: unknown) => unknown;
  return {
    observeSelectedReceipt: (input: unknown) => {
      calls.push(input);
      return real(input);
    },
  };
}

const READ_INPUTS = { recordId: "item-1", field: "notification", selected: ["status", "result"] };

describe("Q2 observer seam (injected production leg + work-loader fallback)", () => {
  it("serves the exact observed projection through an injected observer", async () => {
    const s = await seamSetup();
    await seedWorld(s.store, s.seed.now);
    const calls: unknown[] = [];
    const served = await invokeSelectedReceiptRead({
      asm: s.asm,
      artifact: s.artifact,
      operation: RECEIPT_READ_OPERATION,
      inputs: { ...READ_INPUTS },
      identity: await identityFor(s.seed, s.seed.memberToken),
      store: s.store,
      memberships: s.seed.store,
      now: () => s.seed.now,
      observer: await recordingBinding(calls),
    });
    assert.equal(served.outcome, "observed");
    if (served.outcome !== "observed") throw new Error("unreachable");
    assert.deepEqual(served.projection, { status: "succeeded", result: { ok: 1 } });
    assert.ok(calls.length >= 1, "injected observer must be called through");
    const first = calls[0] as Record<string, unknown>;
    assert.deepEqual(first["selected"], ["status", "result"]);
  });

  it("serves deep-equal output through the work-loader fallback when nothing is injected", async () => {
    const injected = await seamSetup();
    await seedWorld(injected.store, injected.seed.now);
    const injectedCalls: unknown[] = [];
    const viaInjection = await invokeSelectedReceiptRead({
      asm: injected.asm,
      artifact: injected.artifact,
      operation: RECEIPT_READ_OPERATION,
      inputs: { ...READ_INPUTS },
      identity: await identityFor(injected.seed, injected.seed.memberToken),
      store: injected.store,
      memberships: injected.seed.store,
      now: () => injected.seed.now,
      observer: await recordingBinding(injectedCalls),
    });
    const fallback = await seamSetup();
    await seedWorld(fallback.store, fallback.seed.now);
    const viaFallback = await invokeSelectedReceiptRead({
      asm: fallback.asm,
      artifact: fallback.artifact,
      operation: RECEIPT_READ_OPERATION,
      inputs: { ...READ_INPUTS },
      identity: await identityFor(fallback.seed, fallback.seed.memberToken),
      store: fallback.store,
      memberships: fallback.seed.store,
      now: () => fallback.seed.now,
    });
    assert.deepEqual(viaFallback, viaInjection);
  });

  it("D1: absent-module ONLY falls back — broken-B shapes stay loud", () => {
    const absent = new Error(
      "Cannot find module '/repo/packages/state/dist/state/src/receipt/observer.js' imported from '/repo/packages/cloudflare/dist/runtime/invoke.js'",
    ) as Error & { code: string };
    absent.code = "ERR_MODULE_NOT_FOUND";
    assert.equal(isObserverModuleAbsent(absent), true);
    // Nested missing dep inside a PRESENT observer.js: observer.js is
    // the importer, not the missing module — broken, never absent.
    const nested = new Error(
      "Cannot find module '/repo/packages/state/dist/state/src/receipt/helpers.js' imported from '/repo/packages/state/dist/state/src/receipt/observer.js'",
    ) as Error & { code: string };
    nested.code = "ERR_MODULE_NOT_FOUND";
    assert.equal(isObserverModuleAbsent(nested), false);
    // Same file name in another directory: anchored out (N-R1).
    const namesake = new Error(
      "Cannot find module '/repo/packages/state/dist/state/src/billing/observer.js' imported from '/repo/packages/cloudflare/dist/runtime/invoke.js'",
    ) as Error & { code: string };
    namesake.code = "ERR_MODULE_NOT_FOUND";
    assert.equal(isObserverModuleAbsent(namesake), false);
    // Wrong code, unshaped, and primitive errors: all loud.
    assert.equal(isObserverModuleAbsent(new Error("boom")), false);
    assert.equal(isObserverModuleAbsent({ code: "ERR_MODULE_NOT_FOUND" }), false);
    assert.equal(isObserverModuleAbsent(null), false);
    assert.equal(isObserverModuleAbsent("ERR_MODULE_NOT_FOUND"), false);
  });

  it("D2: the canonical read path carries an injected observer to Receipt.read serving", async () => {
    const s = await seamSetup();
    await seedWorld(s.store, s.seed.now);
    const calls: unknown[] = [];
    const served = await invokeReadCanonical({
      asm: s.asm,
      artifact: s.artifact,
      operation: RECEIPT_READ_OPERATION,
      inputs: { ...READ_INPUTS },
      identity: await identityFor(s.seed, s.seed.memberToken),
      store: s.store,
      memberships: s.seed.store,
      observer: await recordingBinding(calls),
    });
    assert.equal((served as { outcome: string }).outcome, "observed");
    assert.deepEqual((served as { projection: unknown }).projection, {
      status: "succeeded",
      result: { ok: 1 },
    });
    assert.ok(calls.length >= 1, "canonical path must reach the injected observer");
  });

  it("pre-join refusals short-circuit before any injected observer runs", async () => {
    const s = await seamSetup();
    await seedWorld(s.store, s.seed.now);
    const calls: unknown[] = [];
    await assert.rejects(
      invokeSelectedReceiptRead({
        asm: s.asm,
        artifact: s.artifact,
        operation: RECEIPT_READ_OPERATION,
        inputs: { recordId: "missing-item", field: "notification", selected: ["status"] },
        identity: await identityFor(s.seed, s.seed.memberToken),
        store: s.store,
        memberships: s.seed.store,
        now: () => s.seed.now,
        observer: await recordingBinding(calls),
      }),
      /Receipt owner record not found/,
    );
    assert.equal(calls.length, 0);
  });
});
