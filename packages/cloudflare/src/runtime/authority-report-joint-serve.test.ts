/**
 * Outcome 9 family E joint serve proof (Lane C): the REAL emitted
 * authority-report artifact through the REAL host seam.
 *
 * The committed fixture pair
 * (`test/fixtures/authority-report-{shop,helpers}.can`) compiles with the
 * shared-target debug/can binary + the real native catalog +
 * `--native-scenario-receipts` to exit 0 with zero diagnostics. The
 * verified assembly (`assembleModules`, assembler-owned capability) stages
 * the emitted `modules[][path/js]` under an owned dist-adjacent dir,
 * rewriting bare `@canlang/stdlib` to the real B1 data-plane runtime
 * stdlib — the emitted artifact is never hand-edited. `callable.module`
 * selects the staged URL through `importVerifiedAssemblyModule`.
 *
 * Five probes: member grant serves, viewer reads stay filtered,
 * by-denied callers refuse before any decision read, tampered checked
 * sources refuse, and moved decision rows void the grant.
 *
 * Run from dist: root build, then
 * `node --test dist/runtime/authority-report-joint-serve.test.js`.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
import { distribution } from "@canlang/values/distribution";
import { assembleModules, type AssembledModules } from "./modules.js";
import { importVerifiedAssemblyModule } from "./assembly-verification.js";
import { invokeReadCanonical } from "./invoke.js";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const SHOP_FIXTURE = "packages/cloudflare/test/fixtures/authority-report-shop.can";
const HELPERS_FIXTURE = "packages/cloudflare/test/fixtures/authority-report-helpers.can";
const SHOP_SHA256 = "ed67eb52e80ec44faccc64c28e8820499447bc59385ac9ed4edd2fa934d60871";
const HELPERS_SHA256 = "b5e988a3b1d0f75e952f137cd22ea78359300ffeebe19f3daa9f2f2aa3b39fc4";
const DESCRIPTION = "Confidential totals granted to members.";

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  // Stage beside the compiled test (dist-adjacent, owned); the assembler
  // versions the complete staged closure beneath it.
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = mkdtempSync(join(here, "authority-joint-serve-"));
  tempDirs.push(dir);
  return dir;
}

interface Shared {
  readonly artifact: CompileArtifact;
  readonly asm: AssembledModules;
  readonly workDir: string;
}

let shared: Shared | undefined;

async function compileAndAssemble(): Promise<Shared> {
  if (shared !== undefined) return shared;
  const compiler = process.env.CAN_COMPILER_BIN ?? join(root, "compiler/target/debug/can");
  const catalog = fileURLToPath(distribution.catalog);
  const env = { ...process.env };
  delete env.CAN_CATALOG;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      compiler,
      ["compile", "--format=json", "--native-scenario-receipts", "--catalog", catalog, SHOP_FIXTURE, HELPERS_FIXTURE],
      { cwd: root, env, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
    ));
  } catch (error) {
    const out = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    throw new Error(
      `joint-serve fixture compile failed: ${String(out.message)} stdout=${String(out.stdout ?? "").slice(0, 2000)}`,
    );
  }
  const parsed: unknown = JSON.parse(stdout);
  assert.ok(typeof parsed === "object" && parsed !== null);
  // Exit 0 prints the artifact envelope; diagnostics print instead with a
  // non-zero exit (so execFile would have rejected above).
  assert.ok(!("diagnostics" in parsed), "zero diagnostics on the real native catalog compile");
  assert.equal((parsed as { artifact_version?: unknown }).artifact_version, 1);
  const artifact = parsed as CompileArtifact;
  assert.ok(artifact.modules.length > 0, "real emitted modules present");
  const workDir = join(tempDir(), "modules");
  const asm = await assembleModules(
    { artifact, sourcePath: "authority-report-joint-serve" },
    {
      workDir,
      stdlibUrl: import.meta.resolve("@canlang/cloudflare/runtime/stdlib"),
      uiUrl: import.meta.resolve("@canlang/ui"),
    },
  );
  shared = { artifact, asm, workDir };
  return shared;
}

before(async () => {
  await compileAndAssemble();
});

function readOptions(setup: { asm: AssembledModules; artifact: CompileArtifact; store: StoragePort; seed: SeededIdentity }, operation: string) {
  return {
    asm: setup.asm,
    artifact: setup.artifact,
    operation,
    inputs: {},
    store: setup.store,
    memberships: setup.seed.store,
  };
}

interface SeededIdentity {
  readonly now: number;
  readonly store: ReturnType<typeof createMemoryIdentityStore>;
  readonly memberToken: string;
  readonly outsiderToken: string;
}

async function seedIdentity(): Promise<SeededIdentity> {
  const now = Date.now();
  const clock = createFrozenClock(now);
  const store = createMemoryIdentityStore({ clock });
  const team = await store.createTeam({});
  const member = await store.createUser({
    email: "member@authority.test",
    password_hash: "x",
    email_verified: true,
  });
  await store.createMembership({
    team_id: team.team_id,
    user_id: member.user_id,
    is_owner: false,
    roles: [],
  });
  const outsider = await store.createUser({
    email: "outsider@authority.test",
    password_hash: "x",
    email_verified: true,
  });
  const memberToken = `member-token-${randomBytes(8).toString("hex")}`;
  const outsiderToken = `outsider-token-${randomBytes(8).toString("hex")}`;
  const sessionFor = async (userId: string, token: string): Promise<void> => {
    await store.createSession({
      user_id: userId,
      token_sha256: await sha256HexText(token),
      expires_at: new Date(now + 3600_000).toISOString(),
      last_team_id: team.team_id,
    });
  };
  await sessionFor(member.user_id, memberToken);
  await sessionFor(outsider.user_id, outsiderToken);
  return { now, store, memberToken, outsiderToken };
}

async function identityFor(seed: SeededIdentity, token: string): Promise<ResolvedIdentity> {
  return resolveIdentity(
    seed.store,
    { session_token: token },
    { clock: { nowMs: () => seed.now } },
  );
}

async function seedGadget(store: StoragePort, now: number, id: string, title: string, stock: string): Promise<StoredRow> {
  const revision = await store.readRevision();
  await store.commit({
    expectedRevision: revision,
    writes: [
      {
        kind: "insert",
        model: "Shop.Gadget" as ModelName,
        row: {
          id: id as RecordId,
          version: 1 as RecordVersion,
          created: now,
          updated: now,
          createdBy: "member@authority.test",
          updatedBy: "member@authority.test",
          archivedAt: null,
          parent: null,
          data: { title, stock },
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
  const row = await store.load("Shop.Gadget" as ModelName, id as RecordId);
  assert.ok(row !== null);
  return row;
}

async function captureError(fn: () => Promise<unknown>): Promise<Error & { code?: unknown }> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof Error, `want Error, got ${String(error)}`);
    return error as Error & { code?: unknown };
  }
  assert.fail("expected a throw");
}

describe("authority report joint serve (real emission through the host seam)", () => {
  it("emits the fixture pair with zero diagnostics and the checked grant descriptor", { timeout: 120_000 }, async () => {
    const { artifact, asm } = await compileAndAssemble();
    const byPath = new Map(artifact.sources.map((entry) => [entry.path, entry.sha256]));
    assert.equal(byPath.get(SHOP_FIXTURE), SHOP_SHA256);
    assert.equal(byPath.get(HELPERS_FIXTURE), HELPERS_SHA256);
    const totals = artifact.operations?.find((entry) => entry.name === "Shop.totals");
    assert.ok(totals !== undefined && totals.kind === "read");
    assert.equal(totals.description, DESCRIPTION);
    assert.ok(totals.result !== undefined, "grant result declared");
    const callableIds = new Set(artifact.callables.map((entry) => `${entry.kind}:${entry.id}`));
    assert.ok(callableIds.has("operation:Shop.totals"));
    assert.ok(callableIds.has("pure:Shop.bump"), "local helper dual-emitted");
    assert.ok(callableIds.has("pure:helpers.bump"), "imported helper dual-emitted");
    // The staged module carries the checked §13 origin beside the marker;
    // callable.module selects its URL (never a hand-edited copy).
    const callable = artifact.callables.find((entry) => entry.id === "Shop.totals");
    assert.ok(callable !== undefined);
    const namespace = await importVerifiedAssemblyModule(asm, callable.module, artifact) as Record<string, unknown>;
    const appDefinition = namespace["appDefinition"] as { operations: Record<string, Record<string, unknown>> };
    const staged = appDefinition.operations["Shop.totals"];
    assert.ok(staged !== undefined, "staged Shop.totals descriptor present");
    assert.equal(staged["scope"], "authority");
    assert.equal(staged["by"], "members");
    assert.equal(staged["read"], true);
    assert.deepEqual(staged["source"], { module: "Shop", path: SHOP_FIXTURE, sha256: SHOP_SHA256 });
    assert.ok(staged["result"] !== undefined);
    assert.ok(typeof staged["description"] === "object", "description message descriptor staged");
  });

  it("serves the member grant computed from decision rows", { timeout: 120_000 }, async () => {
    const { artifact, asm } = await compileAndAssemble();
    const { store } = createTestMemoryStorage();
    const seed = await seedIdentity();
    await seedGadget(store, seed.now, "first", "item-first", "3");
    await seedGadget(store, seed.now, "second", "item-second", "4");
    const served = (await invokeReadCanonical({
      ...readOptions({ asm, artifact, store, seed }, "Shop.totals"),
      identity: await identityFor(seed, seed.memberToken),
    })) as { result: unknown };
    // count(2) + 1 + count(2) + 1 through the local + imported helpers.
    assert.deepEqual(served.result, { total: "6" });
  });

  it("leaves viewer reads filtered without a grant", { timeout: 120_000 }, async () => {
    const { artifact, asm } = await compileAndAssemble();
    const { store } = createTestMemoryStorage();
    const seed = await seedIdentity();
    await seedGadget(store, seed.now, "only", "item-only", "9");
    const viewer = (await invokeReadCanonical({
      ...readOptions({ asm, artifact, store, seed }, "Shop.Gadget.read"),
      identity: await identityFor(seed, seed.memberToken),
    })) as { records: Array<{ data: Record<string, unknown> }> };
    assert.equal(viewer.records.length, 1);
    assert.deepEqual(viewer.records[0]?.data, { title: "item-only" });
  });

  it("refuses by-denied callers before any decision read", { timeout: 120_000 }, async () => {
    const { artifact, asm } = await compileAndAssemble();
    const { store } = createTestMemoryStorage();
    const seed = await seedIdentity();
    await seedGadget(store, seed.now, "hidden", "item-hidden", "5");
    const error = await captureError(async () =>
      invokeReadCanonical({
        ...readOptions({ asm, artifact, store, seed }, "Shop.totals"),
        identity: await identityFor(seed, seed.outsiderToken),
      }),
    );
    assert.equal(error.code, "forbidden");
  });

  it("refuses a tampered checked source instead of serving the grant", { timeout: 120_000 }, async () => {
    const { artifact, workDir } = await compileAndAssemble();
    const tampered = JSON.parse(JSON.stringify(artifact)) as CompileArtifact;
    tampered.sources = tampered.sources.map((entry) =>
      entry.path === SHOP_FIXTURE ? { ...entry, sha256: "a".repeat(64) } : entry,
    );
    const asm = await assembleModules(
      { artifact: tampered, sourcePath: "authority-report-joint-serve-tampered" },
      {
        workDir,
        stdlibUrl: import.meta.resolve("@canlang/cloudflare/runtime/stdlib"),
        uiUrl: import.meta.resolve("@canlang/ui"),
      },
    );
    const { store } = createTestMemoryStorage();
    const seed = await seedIdentity();
    await seedGadget(store, seed.now, "hidden", "item-hidden", "5");
    const error = await captureError(async () =>
      invokeReadCanonical({
        ...readOptions({ asm, artifact: tampered, store, seed }, "Shop.totals"),
        identity: await identityFor(seed, seed.memberToken),
      }),
    );
    assert.equal(error.code, "validation");
    assert.match(error.message, /tampered checked source origin/);
  });

  it("voids the grant when decision rows move during evaluation", { timeout: 120_000 }, async () => {
    const { artifact, asm } = await compileAndAssemble();
    const { store: inner } = createTestMemoryStorage();
    const seed = await seedIdentity();
    await seedGadget(inner, seed.now, "roles", "item-roles", "1");
    let queries = 0;
    const drifted: StoragePort = {
      ...inner,
      query: (async (spec: Parameters<StoragePort["query"]>[0]) => {
        queries += 1;
        const rows = await inner.query(spec);
        if (queries === 1) return rows;
        return rows.map((row) => ({ ...row, data: { ...row.data, stock: "30" } }));
      }) as StoragePort["query"],
    };
    const error = await captureError(async () =>
      invokeReadCanonical({
        ...readOptions({ asm, artifact, store: drifted, seed }, "Shop.totals"),
        identity: await identityFor(seed, seed.memberToken),
      }),
    );
    assert.ok(queries > 1, "decision read ran before the drift");
    assert.equal(error.code, "forbidden");
    assert.match(error.message, /authority changed/);
  });
});
