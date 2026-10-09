/**
 * Q4 durable e2e (colocated): D3b `Receipt.read` serving over DURABLE
 * substrates, pre-B-half.
 *
 * Path A (checkout-durable): `invokeSelectedReceiptRead` over REAL
 * miniflare D1 (`createD1Storage`) + real membership resolution +
 * the injected production observer (recording wrapper) serves the
 * exact observed projection; a second storage handle reads back the
 * seeded revisions (cross-handle durable proof). Memberships stay
 * memory doubles — the durable claim covers the state store, not
 * identity (same scope as the T17b/T24b/T32b durable suites).
 *
 * Path B (bundle fail-closed probe): the REAL `buildDeployBundle`
 * (with F's Q3 rewrite entries) boots in workerd with a DB binding;
 * statically, staged `invoke.js` carries the rewritten observer
 * specifier while the vendor map lacks `observer.js` (B not
 * landed); dynamically, a probe module importing the exact
 * rewritten target records workerd's REAL miss shape, and that
 * shape MUST read loud under `isObserverModuleAbsent` — or, if it
 * ever reads absent, the work-loader fallback leg MUST also miss
 * (its key is pinned out), so refusal is loud down every branch.
 * Full behavioral in-worker serving belongs to Q4-C post-B
 * (coordinator redirect: a blind-shaped MCP dispatch would be
 * theater; the mapping chain is checkout-covered).
 *
 * Run from dist FROM THE REPO ROOT: root build, then
 * `node --test packages/cloudflare/dist/runtime/d3b-durable-serve.test.js`.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import type {
  ActivationVerdict,
  CompileArtifact,
  ModelName,
  RecordId,
  RecordVersion,
  ResolvedIdentity,
  SourceMap,
  StoragePort,
  StoredRow,
} from "@canlang/contracts";
import { resolveIdentity, sha256HexText } from "@canlang/identity";
import { createFrozenClock, createMemoryIdentityStore } from "@canlang/identity/testing";
import { createD1Storage, ensureSchema } from "@canlang/state/storage/d1";
import {
  RECEIPT_ASSOCIATION_MODEL,
  RECEIPT_MODEL,
  newAssociationRow,
  newReceiptRow,
} from "@canlang/state/receipt/tables";
import { loadWorkReceiptFns } from "@canlang/work/receipt";
import type { AssembledModules } from "../worker/assembly.js";
import { buildDeployBundle } from "../deploy/bundle.js";
import { startLocalDev } from "../dev/local-run.js";
import {
  RECEIPT_READ_OPERATION,
  invokeSelectedReceiptRead,
  isObserverModuleAbsent,
} from "./invoke.js";
import type { SelectedReceiptObserverBinding } from "./invoke.js";

/* ------------------------------------------------------------------ */
/* Shared fixtures (self-contained: no cross-test imports).            */
/* ------------------------------------------------------------------ */

/** Owning hand-built module bytes; declarations and public read selectors agree. */
const OPS_MODULE = `const modelPolicy = {
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
export function canApp() {
  return { policy: appDefinition.policy, read: readRules };
}
`;

function receiptArtifact(): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "d3b-durable-fixture/0 (hand-written T15a shape; NOT compiler output)",
    tool_version: "d3b-durable-fixture/0",
    sources: [{ path: "ops.mjs", sha256: createHash("sha256").update(OPS_MODULE, "utf8").digest("hex") }],
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
          {
            name: "notification",
            required: false,
            serverOnly: false,
            field: {
              kind: "delivery",
              capability: "std.EmailV1",
              operation: "send",
              version: 1,
              result: { name: "EmailAccepted", fields: [{ name: "reference", type: "text" }] },
            },
          },
        ],
        deleteMode: "remove",
      },
    ],
  } as unknown as CompileArtifact;
}

function stubAsm(): AssembledModules {
  const dir = mkdtempSync(join(tmpdir(), "canlang-d3b-dur-"));
  tempDirs.push(dir);
  const opsPath = join(dir, "ops.mjs");
  writeFileSync(opsPath, OPS_MODULE);
  return {
    dir,
    entryUrl: pathToFileURL(opsPath).href,
    moduleUrls: { "ops.mjs": pathToFileURL(opsPath).href },
  };
}

const tempDirs: string[] = [];

async function seedIdentity(): Promise<{
  now: number;
  store: ReturnType<typeof createMemoryIdentityStore>;
  memberToken: string;
}> {
  const now = Date.now();
  const store = createMemoryIdentityStore({ clock: createFrozenClock(now) });
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
          data: { title: "item-1", notification: null },
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
  const owner = await store.load("acme.Item" as ModelName, "item-1" as RecordId);
  assert.ok(owner);
  const meta = { nowMs: now, actor: "member@d3b.test" };
  await store.commit({
    expectedRevision: await store.readRevision(),
    writes: [
      { kind: "update", model: "acme.Item" as ModelName, id: owner.id, expectedVersion: owner.version,
        row: { ...owner, version: (owner.version + 1) as RecordVersion, updated: now,
          data: { ...owner.data, notification: { id: "del_1", operation: "std.EmailV1.send" } } } },
      {
        kind: "insert",
        model: RECEIPT_ASSOCIATION_MODEL as ModelName,
        row: newAssociationRow(
          {
            recordModel: "acme.Item",
            recordId: "item-1",
            field: "notification",
            deliveryId: "del_1",
            source: "std.EmailV1.send",
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
            result: { reference: "accepted-1" },
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

/* ------------------------------------------------------------------ */
/* Path A: durable serving in checkout (real D1 + injected leg).       */
/* ------------------------------------------------------------------ */

describe("Q4 path A: served Receipt.read over real miniflare D1", () => {
  let d1mf: Miniflare | undefined;
  let d1db: D1Database | undefined;

  before(async () => {
    d1mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ["DB"] });
    d1db = await d1mf.getD1Database("DB");
    await ensureSchema(d1db);
  });

  after(async () => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    if (d1mf !== undefined) {
      await d1mf.dispose();
      d1mf = undefined;
    }
  });

  it("serves the observed projection with rows read back across D1 handles", async () => {
    assert.ok(d1db !== undefined);
    const store: StoragePort = createD1Storage(d1db);
    const seed = await seedIdentity();
    await seedWorld(store, seed.now);
    // Cross-handle durable proof: a second handle sees the commits.
    const cross: StoragePort = createD1Storage(d1db);
    assert.ok((await cross.readRevision()) >= 2);
    const calls: unknown[] = [];
    const served = await invokeSelectedReceiptRead({
      asm: stubAsm(),
      artifact: receiptArtifact(),
      operation: RECEIPT_READ_OPERATION,
      inputs: { recordId: "item-1", field: "notification", selected: ["status", "result"] },
      identity: await resolveIdentity(
        seed.store,
        { session_token: seed.memberToken },
        { clock: { nowMs: () => seed.now } },
      ),
      store,
      memberships: seed.store,
      now: () => seed.now,
      observer: await recordingBinding(calls),
    });
    assert.equal(served.outcome, "observed");
    if (served.outcome !== "observed") throw new Error("unreachable");
    assert.deepEqual(served.projection, { status: "succeeded", result: { reference: "accepted-1" } });
    assert.ok(calls.length >= 1);
  });
});

/* ------------------------------------------------------------------ */
/* Path B: real bundle boots; observer miss is loud in workerd.        */
/* ------------------------------------------------------------------ */

const EMPTY_MAP: SourceMap = {
  version: 3,
  file: "app/main.js",
  sources: [],
  sourcesContent: [],
  names: [],
  mappings: "",
};

/** Hand-built bundle module source, not emitted Can or a native compiler witness. */
const BUNDLE_MODULE = `export const appDefinition = { id: "ReceiptBundleFixture" };
export const descriptor = {
  owner: "test",
  path: "/main",
  title: "Main",
  admit: async () => ({}),
  render: async () => "<h1>fixture-main</h1>",
};
`;

function bundleArtifact(): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "d3b-bundle-fixture/0 (hand-written; NOT compiler output)",
    tool_version: "d3b-bundle-fixture/0",
    sources: [{ path: "app/main.js", sha256: createHash("sha256").update(BUNDLE_MODULE, "utf8").digest("hex") }],
    modules: [
      {
        path: "app/main.js",
        js: BUNDLE_MODULE,
        map: { ...EMPTY_MAP },
      },
    ],
    callables: [],
    operations: [],
    pages: [{ owner: "test", path: "/main", module: "app/main.js", export: "descriptor" }],
    requires: [],
    tests: [],
  };
}

const ACTIVE_VERDICT: ActivationVerdict = { active: true };

/** Probe main: imports the exact rewritten observer target, reports the miss shape. */
const MISS_PROBE_MAIN = `export default {
  async fetch() {
    try {
      await import("../vendor/state/receipt/observer.js");
      return Response.json({ resolved: true });
    } catch (error) {
      const record = (typeof error === "object" && error !== null) ? error : {};
      return Response.json({
        resolved: false,
        name: record.name ?? null,
        code: record.code ?? null,
        message: String(record.message ?? record),
      });
    }
  }
};
`;

describe("Q4 path B: staged bundle fail-closed pre-B", () => {
  it("stages the rewritten observer specifier with the vendor key absent (B not landed)", () => {
    const repoRoot = resolve(new URL(".", import.meta.url).pathname, "..", "..", "..", "..");
    const bundle = buildDeployBundle(bundleArtifact(), { repoRoot, verdict: ACTIVE_VERDICT });
    const invoke = bundle.modules["runtime/invoke.js"] as string | undefined;
    assert.ok(typeof invoke === "string", "staged runtime/invoke.js must exist");
    // Real Q2 const (not F's Q3 overlay): rewritten to the vendor key.
    assert.ok(invoke.includes("../vendor/state/receipt/index.js"));
    assert.ok(bundle.modules["vendor/state/receipt/index.js"]);
    assert.ok(!invoke.includes("../../../state/dist/state/src/receipt/observer.js"));
    assert.equal(bundle.modules["vendor/state/receipt/observer.js"], undefined);
  });

  it("boots the real bundle in workerd with a DB binding (gate passes, no crash)", { timeout: 120000 }, async () => {
    const repoRoot = resolve(new URL(".", import.meta.url).pathname, "..", "..", "..", "..");
    const bundle = buildDeployBundle(bundleArtifact(), { repoRoot, verdict: ACTIVE_VERDICT });
    const dev = await startLocalDev({
      workerName: "d3b-durable-boot",
      compatibilityDate: "2026-07-15",
      mainModule: bundle.mainModule,
      modules: bundle.modules,
      d1Databases: [{ binding: "DB", id: "d3b-durable-boot-db" }],
    });
    try {
      // Binding gate passes with DB present: the defining Interfaces
      // page handler renders the full shell and the exact fixture body.
      const response = await dev.dispatch("/main");
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /^text\/html(?:;|$)/);
      const html = await response.text();
      assert.match(html, /^<!DOCTYPE html>/);
      assert.match(html, /<title>Main — ReceiptBundleFixture<\/title>/);
      assert.equal(html.match(/<main id="can-main">([\s\S]*?)<\/main>/)?.[1], "<h1>fixture-main</h1>");
    } finally {
      await dev.dispose();
    }
  });

  it("workerd's real observer miss shape refuses loud down every branch", { timeout: 120000 }, async () => {
    const repoRoot = resolve(new URL(".", import.meta.url).pathname, "..", "..", "..", "..");
    const bundle = buildDeployBundle(bundleArtifact(), { repoRoot, verdict: ACTIVE_VERDICT });
    // Faithful miss: real vendor siblings staged, observer key absent.
    const modules: Record<string, string> = { "probe/main.js": MISS_PROBE_MAIN };
    for (const [key, contents] of Object.entries(bundle.modules)) {
      if (key.startsWith("vendor/state/receipt/") && typeof contents === "string") {
        modules[key] = contents;
      }
    }
    assert.ok(Object.keys(modules).some((key) => key.endsWith("receipt/join.js")));
    assert.equal(modules["vendor/state/receipt/observer.js"], undefined);
    const dev = await startLocalDev({
      workerName: "d3b-durable-miss",
      compatibilityDate: "2026-07-15",
      mainModule: "probe/main.js",
      modules,
    });
    try {
      const response = await dev.dispatch("/");
      assert.equal(response.status, 200);
      const shape = (await response.json()) as {
        resolved: boolean;
        name: string | null;
        code: string | null;
        message: string;
      };
      assert.equal(shape.resolved, false);
      assert.ok(shape.message.length > 0);
      // Empirical fail-closed: the REAL workerd miss either reads
      // loud under the predicate (direct refusal) or reads absent —
      // in which case the work-loader fallback leg misses too (its
      // key is pinned out), so refusal is loud down every branch.
      const readsAbsent = isObserverModuleAbsent({
        name: shape.name,
        code: shape.code,
        message: shape.message,
      });
      if (readsAbsent) {
        assert.equal(bundle.modules["vendor/state/receipt/work-loader.js"], undefined);
      } else {
        assert.ok(true, `workerd miss reads loud (code=${String(shape.code)})`);
      }
    } finally {
      await dev.dispose();
    }
  });
});
