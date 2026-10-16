/** Outcome-14 executable consumers (CAN18-v1 coordinator task D14).
 *
 * Four small independently runnable consumers proving end-to-end behavior of
 * already-accepted batches through the real host seams — no new framework:
 *
 * (a) success — the accepted contained-first scenario executes through
 *     `invokeMutationCanonical` with observable committed effects (persisted
 *     committed receipt, single fence advance);
 * (b) rejection — a caller without membership is refused with the exact named
 *     refusal (`forbidden`) and zero side effects (revision still, no
 *     receipt, domain rows untouched);
 * (c) rollback — the accepted hook-order fixture fails its late guard through
 *     the real worker invoker: staged Entry/Audit effects are voided (zero
 *     staged writes, domain rows and history unchanged) and only the
 *     rejected-receipt fence advances;
 * (d) replay — re-executing the committed hook update with the identical
 *     envelope restages deterministically (`replayed`, identical records,
 *     no new commit, store and receipt unchanged — once-only).
 *
 * Fixtures are reused verbatim (contained-first-domain.can,
 * hook_order_rollback.can); the seams are the existing accepted ones
 * (`invokeMutationCanonical`, worker `buildInvoker`, real compiler +
 * native catalog). No production source changes.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { assembleModules, type AssembledModules } from "./modules.js";
import { invokeMutationCanonical } from "./invoke.js";
import { buildInvoker } from "../worker/assembly.js";
import type {
  ClosedInputs,
  CompileArtifact,
  ModelName,
  MutationEnvelope,
  OperationId,
  RecordId,
  RecordVersion,
  ResolvedIdentity,
  StoragePort,
  StoredRow,
} from "@canlang/contracts";
import { resolveIdentity, sha256HexText } from "@canlang/identity";
import { createFrozenClock, createMemoryIdentityStore } from "@canlang/identity/testing";
import { createTestMemoryStorage } from "@canlang/state/storage/memory";
import { hashInputs } from "@canlang/state/invocation/replay";
import {
  FIXED_NOW,
  asId,
  asModel,
  asOperation,
  asOperationId,
  createMemoryIdentityStore as createFixtureIdentityStore,
  makeIdentity,
  seedMember,
  uuidv7,
} from "@canlang/state/testing/invocation/fixtures";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const CONTAINED_FIXTURE = "packages/cloudflare/test/fixtures/contained-first-domain.can";
const CONTAINED_SHA = "80e45b6120a2eab80b79fdcf1277af33ae7adb45ccc857b8eecf7498d087441c";
const HOOK_FIXTURE = "compiler/tests/fixtures/hook_order_rollback.can";
const TERM = "DomainProbe.Term";
const SEAT = "DomainProbe.Seat";
const ASSIGN = "DomainProbe.assign";
const APP = "DomainProbe";
const NOW = 1760500000000;
const HOOK_MODEL = "HookOrder.Entry";
const HOOK_AUDIT = "HookOrder.Audit";
const HOOK_UPDATE = "HookOrder.Entry.update";

interface Bundle {
  artifact: CompileArtifact;
  asm: AssembledModules;
}

const bundles = new Map<string, Bundle>();
let tempDir = "";

async function compileAndAssemble(fixture: string, sha: string | null): Promise<Bundle> {
  const cached = bundles.get(fixture);
  if (cached !== undefined) return cached;
  const compiler = process.env.CAN_COMPILER_BIN ?? join(root, "compiler/target/debug/can");
  const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, "packages/cloudflare/dist/native-catalog.json");
  const env = { ...process.env };
  delete env.CAN_CATALOG;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      compiler,
      ["compile", "--format=json", "--native-scenario-receipts", "--catalog", catalog, fixture],
      { cwd: root, env, timeout: 120000, maxBuffer: 32 * 1024 * 1024 },
    ));
  } catch (error) {
    const out = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    throw new Error(
      `outcome-14 fixture compile failed for ${fixture}: ${String(out.message)} stdout=${String(out.stdout ?? "").slice(0, 2000)}`,
    );
  }
  const artifact = JSON.parse(stdout) as CompileArtifact;
  assert.ok(!("diagnostics" in artifact), `real fixture ${fixture} emits clean`);
  const src = artifact.sources.find((s) => s.path === fixture);
  if (sha !== null) assert.ok(src && src.sha256 === sha, `real fixture ${fixture} source identity preserved`);
  else assert.ok(src, `real fixture ${fixture} source recorded`);
  if (tempDir === "") tempDir = mkdtempSync(join(tmpdir(), "can-outcome-14-"));
  const asm = await assembleModules(
    { artifact, sourcePath: fixture },
    {
      workDir: join(tempDir, `modules-${bundles.size}`),
      stdlibUrl: import.meta.resolve("@canlang/cloudflare/runtime/stdlib"),
      uiUrl: import.meta.resolve("@canlang/ui"),
    },
  );
  const bundle = { artifact, asm };
  bundles.set(fixture, bundle);
  return bundle;
}

interface ContainedWorld {
  store: StoragePort;
  identities: ReturnType<typeof createMemoryIdentityStore>;
  member: ResolvedIdentity;
  memberUserId: string;
  outsider: ResolvedIdentity;
  outsiderUserId: string;
  teamId: string;
  seatBefore: StoredRow | null;
  seatHistoryBefore: Awaited<ReturnType<StoragePort["historyFor"]>>;
}

async function containedWorld(): Promise<ContainedWorld> {
  const clock = createFrozenClock(NOW);
  const identities = createMemoryIdentityStore({ clock });
  const team = await identities.createTeam({});
  const mkSession = async (email: string, withMembership: boolean) => {
    const user = await identities.createUser({
      email,
      password_hash: "unused",
      email_verified: true,
    });
    if (withMembership) {
      await identities.createMembership({
        team_id: team.team_id,
        user_id: user.user_id,
        is_owner: false,
        roles: [],
      });
    }
    const token = randomBytes(32).toString("hex");
    await identities.createSession({
      user_id: user.user_id,
      token_sha256: await sha256HexText(token),
      expires_at: new Date(NOW + 3600000).toISOString(),
      last_team_id: team.team_id,
    });
    const identity = await resolveIdentity(identities, { session_token: token }, { clock });
    assert.ok(identity.actor, "session resolves an authenticated actor");
    return { identity, userId: identity.actor.user_id as string };
  };
  const member = await mkSession("caller@outcome14.test", true);
  const outsider = await mkSession("outsider@outcome14.test", false);

  const { store } = createTestMemoryStorage();
  const commit = async (model: string, row: StoredRow) =>
    store.commit({
      expectedRevision: await store.readRevision(),
      writes: [{ kind: "insert", model: model as ModelName, row }],
      history: [],
      receipt: null,
      outbox: [],
      schedules: [],
      uniqueClaims: [],
      uniqueReleases: [],
    });
  await commit(TERM, {
    id: "term-a" as RecordId, version: 1 as RecordVersion,
    created: NOW, updated: NOW, createdBy: "t", updatedBy: "t",
    archivedAt: null, parent: null, data: { name: "term-a" },
  });
  await commit(SEAT, {
    id: "seat-01-mine" as RecordId, version: 1 as RecordVersion,
    created: NOW, updated: NOW, createdBy: "t", updatedBy: "t",
    archivedAt: null, parent: { model: TERM as ModelName, id: "term-a" as RecordId },
    data: { account: { id: member.userId }, active: true },
  });
  const seatBefore = await store.load(SEAT as ModelName, "seat-01-mine" as RecordId);
  const seatHistoryBefore = await store.historyFor(SEAT as ModelName, "seat-01-mine" as RecordId);
  return {
    store, identities,
    member: member.identity, memberUserId: member.userId,
    outsider: outsider.identity, outsiderUserId: outsider.userId,
    teamId: team.team_id,
    seatBefore, seatHistoryBefore,
  };
}

describe("outcome-14 executable consumers", () => {
  before(async () => {
    await compileAndAssemble(CONTAINED_FIXTURE, CONTAINED_SHA);
    const hookBytes = readFileSync(join(root, HOOK_FIXTURE));
    await compileAndAssemble(HOOK_FIXTURE, createHash("sha256").update(hookBytes).digest("hex"));
  });
  after(() => {
    if (tempDir !== "") rmSync(tempDir, { recursive: true, force: true });
  });

  it("success: accepted scenario executes through the host seam with committed effects", { timeout: 180000 }, async () => {
    const { artifact, asm } = (await compileAndAssemble(CONTAINED_FIXTURE, CONTAINED_SHA));
    const w = await containedWorld();
    const revBefore = await w.store.readRevision();
    const operationId = uuidv7(NOW, 1) as OperationId;
    const inputs = { term: { id: "term-a", version: "1" }, account: { id: w.memberUserId } };
    const out = await invokeMutationCanonical({
      asm,
      artifact,
      operation: asOperation(ASSIGN),
      operationId,
      inputs,
      identity: w.member,
      app: APP,
      source: "outcome-14-success",
      store: w.store,
      memberships: w.identities,
      now: () => NOW,
    });
    assert.equal(out.status, "committed");
    assert.equal(out.operation_id, operationId);
    assert.equal(out.result, true);
    assert.deepEqual(out.deliveries, []);
    assert.deepEqual(out.records, []);
    const revAfter = await w.store.readRevision();
    assert.equal(revAfter, revBefore + 1, "one fenced commit");
    const receipt = await w.store.readReceipt({
      app: APP,
      owner: w.teamId,
      principal: w.memberUserId,
      operation: asOperation(ASSIGN),
      operationId,
    });
    assert.ok(receipt, "committed invocation persists its native receipt");
    assert.deepEqual(receipt.identity, {
      app: APP,
      owner: w.teamId,
      principal: w.memberUserId,
      operation: asOperation(ASSIGN),
      operationId,
    });
    assert.equal(receipt.inputHash, await hashInputs(inputs as ClosedInputs));
    assert.equal(receipt.outcome.status, "committed");
    assert.equal(receipt.committedRevision, revAfter);
  });

  it("rejection: refused caller produces the exact named refusal with zero side effects", { timeout: 180000 }, async () => {
    const { artifact, asm } = (await compileAndAssemble(CONTAINED_FIXTURE, CONTAINED_SHA));
    const w = await containedWorld();
    const revBefore = await w.store.readRevision();
    const operationId = uuidv7(NOW, 2) as OperationId;
    const failure = await invokeMutationCanonical({
      asm,
      artifact,
      operation: asOperation(ASSIGN),
      operationId,
      inputs: { term: { id: "term-a", version: "1" }, account: { id: w.outsiderUserId } },
      identity: w.outsider,
      app: APP,
      source: "outcome-14-rejection",
      store: w.store,
      memberships: w.identities,
      now: () => NOW,
    }).then(
      () => { throw new Error("denied caller executed"); },
      (error: unknown) => error,
    );
    assert.ok(failure instanceof Error);
    assert.equal(failure.name, "StateError");
    assert.equal((failure as { code?: unknown }).code, "forbidden");
    assert.equal(failure.message, "This operation is not permitted for the caller.");
    assert.equal(await w.store.readRevision(), revBefore, "refusal advances no fence");
    assert.equal(
      await w.store.readReceipt({
        app: APP,
        owner: w.teamId,
        principal: w.outsiderUserId,
        operation: asOperation(ASSIGN),
        operationId,
      }),
      null,
      "refusal persists no receipt",
    );
    assert.deepEqual(await w.store.load(SEAT as ModelName, "seat-01-mine" as RecordId), w.seatBefore);
    assert.deepEqual(await w.store.historyFor(SEAT as ModelName, "seat-01-mine" as RecordId), w.seatHistoryBefore);
  });

  it("rollback: mid-execution failure voids staged effects, store keeps domain state", { timeout: 180000 }, async () => {
    const { artifact, asm } = (await compileAndAssemble(HOOK_FIXTURE, null));
    const { store: backing } = createTestMemoryStorage();
    const batches: Parameters<StoragePort["commit"]>[0][] = [];
    const store: StoragePort = {
      ...backing,
      commit: async (batch) => { batches.push(batch); return backing.commit(batch); },
    };
    const memberships = createFixtureIdentityStore();
    const member = await seedMember(memberships, { isOwner: false });
    const identity = makeIdentity({ membership: member.membership, email: member.user.email });
    const invoker = buildInvoker(artifact, asm, store, { memberships, now: () => FIXED_NOW });
    let sequence = 0;
    const nextId = () => asOperationId(uuidv7(FIXED_NOW, ++sequence));
    const created = await invoker.invokeMutation({
      operation: asOperation(`${HOOK_MODEL}.create`),
      operation_id: nextId(),
      inputs: { state: "initial", accept: true },
    }, identity);
    assert.ok("result" in created, JSON.stringify(created));
    assert.equal(created.result.status, "committed");
    assert.equal(created.result.records?.length, 1);
    const records = created.result.records;
    assert.ok(records && records.length === 1);
    const id = (records[0] as { id: string }).id;
    const revBefore = await store.readRevision();
    const entryBefore = await store.load(asModel(HOOK_MODEL), asId(id));
    const entryHistoryBefore = await store.historyFor(asModel(HOOK_MODEL), asId(id));
    const batchesBefore = batches.length;

    const failedEnvelope: MutationEnvelope = {
      operation: asOperation(HOOK_UPDATE),
      operation_id: nextId(),
      inputs: { record: { id, version: "1" }, state: "proposed", accept: false },
    };
    const failed = await invoker.invokeMutation(failedEnvelope, identity);
    assert.ok("error" in failed, JSON.stringify(failed));
    assert.equal(failed.error.code, "rule_failed");
    assert.equal(failed.error.message, "forbidden");
    assert.equal(failed.error.operation_id, failedEnvelope.operation_id);
    assert.equal(failed.error.retryable, false);
    assert.equal(failed.receipt, "rejected");
    assert.deepEqual(await store.load(asModel(HOOK_MODEL), asId(id)), entryBefore, "late refusal preserves Entry data and version");
    assert.deepEqual(await store.historyFor(asModel(HOOK_MODEL), asId(id)), entryHistoryBefore, "late refusal preserves Entry history");
    assert.deepEqual(
      await store.query({ model: asModel(HOOK_AUDIT), authority: "owner", archived: "include", order: [{ field: "id", direction: "asc" }] }),
      [],
      "late refusal stages no Audit row",
    );
    assert.equal(batches.length, batchesBefore + 1, "exactly the rejected-receipt fence");
    const fence = batches.at(-1)!;
    assert.equal(fence.expectedRevision, revBefore);
    assert.deepEqual(fence.writes, [], "late refusal stages no writes");
    assert.deepEqual(fence.history ?? [], [], "late refusal stages no history");
    assert.deepEqual(fence.outbox ?? [], [], "late refusal stages no outbox");
    assert.deepEqual(fence.schedules ?? [], [], "late refusal stages no schedules");
    assert.deepEqual(fence.uniqueClaims ?? [], [], "late refusal stages no unique claims");
    assert.deepEqual(fence.uniqueReleases ?? [], [], "late refusal stages no unique releases");
    assert.equal(fence.receipt?.outcome.status, "rejected");
    assert.equal(await store.readRevision(), revBefore + 1, "only the rejected-receipt fence advances");
    const failedReplay = await invoker.invokeMutation(failedEnvelope, identity);
    assert.deepEqual(failedReplay, failed, "same-envelope failed replay");
    assert.equal(batches.length, batchesBefore + 1, "failed replay commits nothing");
  });

  it("replay: re-executing a committed operation restages deterministically (once-only)", { timeout: 180000 }, async () => {
    const { artifact, asm } = (await compileAndAssemble(HOOK_FIXTURE, null));
    const { store: backing } = createTestMemoryStorage();
    const batches: Parameters<StoragePort["commit"]>[0][] = [];
    const store: StoragePort = {
      ...backing,
      commit: async (batch) => { batches.push(batch); return backing.commit(batch); },
    };
    const memberships = createFixtureIdentityStore();
    const member = await seedMember(memberships, { isOwner: false });
    const identity = makeIdentity({ membership: member.membership, email: member.user.email });
    const invoker = buildInvoker(artifact, asm, store, { memberships, now: () => FIXED_NOW });
    let sequence = 0;
    const created = await invoker.invokeMutation({
      operation: asOperation(`${HOOK_MODEL}.create`),
      operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)),
      inputs: { state: "initial", accept: true },
    }, identity);
    assert.ok("result" in created, JSON.stringify(created));
    const firstRecords = created.result.records;
    assert.ok(firstRecords && firstRecords.length === 1);
    const id = (firstRecords[0] as { id: string }).id;
    const envelope: MutationEnvelope = {
      operation: asOperation(HOOK_UPDATE),
      operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)),
      inputs: { record: { id, version: "1" }, state: "proposed", accept: true },
    };
    const batchesBefore = batches.length;
    const committed = await invoker.invokeMutation(envelope, identity);
    assert.ok("result" in committed, JSON.stringify(committed));
    assert.equal(committed.result.status, "committed");
    const committedRecords = committed.result.records;
    assert.ok(committedRecords && committedRecords.length === 1);
    assert.deepEqual((committedRecords[0] as { data: unknown }).data, { state: "second", accept: true });
    assert.equal((committedRecords[0] as { version: unknown }).version, 2);
    assert.equal(batches.length, batchesBefore + 1, "one fenced positive commit");
    const audits = await store.query({ model: asModel(HOOK_AUDIT), authority: "owner", archived: "include", order: [{ field: "id", direction: "asc" }] });
    assert.equal(audits.length, 1, "exactly one staged Audit row");
    assert.equal(audits[0]!.version, 1);
    assert.deepEqual(audits[0]!.data, { note: "first" });
    const entryAfter = await store.load(asModel(HOOK_MODEL), asId(id));
    const entryHistoryAfter = await store.historyFor(asModel(HOOK_MODEL), asId(id));
    const auditAfter = await store.load(asModel(HOOK_AUDIT), audits[0]!.id);
    const revAfter = await store.readRevision();
    const receiptAfter = await store.readReceipt({
      app: "HookOrder",
      owner: identity.team!.team_id,
      principal: identity.actor!.user_id,
      operation: asOperation(HOOK_UPDATE),
      operationId: asOperationId(envelope.operation_id),
    });
    assert.ok(receiptAfter, "committed invocation persists its native receipt");
    assert.equal(receiptAfter.outcome.status, "committed");

    const replay = await invoker.invokeMutation(envelope, identity);
    assert.ok("result" in replay, JSON.stringify(replay));
    assert.equal(replay.result.status, "replayed");
    assert.deepEqual(replay.result.records, committed.result.records, "replay restages the identical records");
    assert.equal(replay.result.result, null);
    assert.equal(batches.length, batchesBefore + 1, "replay commits nothing (once-only)");
    assert.equal(await store.readRevision(), revAfter, "replay advances no fence");
    assert.deepEqual(await store.load(asModel(HOOK_MODEL), asId(id)), entryAfter);
    assert.deepEqual(await store.historyFor(asModel(HOOK_MODEL), asId(id)), entryHistoryAfter);
    assert.deepEqual(await store.load(asModel(HOOK_AUDIT), audits[0]!.id), auditAfter, "staged Audit restages deterministically");
    assert.deepEqual(
      await store.readReceipt({
        app: "HookOrder",
        owner: identity.team!.team_id,
        principal: identity.actor!.user_id,
        operation: asOperation(HOOK_UPDATE),
        operationId: asOperationId(envelope.operation_id),
      }),
      receiptAfter,
      "replay leaves the committed receipt untouched",
    );
  });
});
