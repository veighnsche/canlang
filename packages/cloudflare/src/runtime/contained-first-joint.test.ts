/** Contained-first joint: actual compiled .can fixture executed through the
 * real host seam. Compiles contained-first-domain.can with the real compiler,
 * assembles the real emitted assembly, and executes the emitted scenario
 * handler via invokeMutationCanonical (canonical State admission, real
 * identity/membership, real envelope). No mirrored handler, no copied AST. */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { assembleModules, type AssembledModules } from "./modules.js";
import { invokeMutationCanonical } from "./invoke.js";
import { AssemblyCorrespondenceError } from "./assembly-verification.js";
import type {
  CompileArtifact,
  ModelName,
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
import { uuidv7 } from "@canlang/state/testing/invocation/fixtures";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const FIXTURE = "packages/cloudflare/test/fixtures/contained-first-domain.can";
const FIXTURE_SHA = "80e45b6120a2eab80b79fdcf1277af33ae7adb45ccc857b8eecf7498d087441c";
const TERM = "DomainProbe.Term";
const SEAT = "DomainProbe.Seat";
const OP = "DomainProbe.assign";
const APP = "DomainProbe";
const NOW = 1760500000000;
let sequence = 0;

interface Shared {
  artifact: CompileArtifact;
  asm: AssembledModules;
  workDir: string;
}
let shared: Shared | undefined;
let tempDir = "";

async function compileAndAssemble(): Promise<Shared> {
  if (shared !== undefined) return shared;
  const compiler = process.env.CAN_COMPILER_BIN ?? join(root, "compiler/target/debug/can");
  const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, "packages/cloudflare/dist/native-catalog.json");
  const env = { ...process.env };
  delete env.CAN_CATALOG;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      compiler,
      ["compile", "--format=json", "--native-scenario-receipts", "--catalog", catalog, FIXTURE],
      { cwd: root, env, timeout: 120000, maxBuffer: 32 * 1024 * 1024 },
    ));
  } catch (error) {
    const out = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    throw new Error(
      `contained-first fixture compile failed: ${String(out.message)} stdout=${String(out.stdout ?? "").slice(0, 2000)}`,
    );
  }
  const artifact = JSON.parse(stdout) as CompileArtifact;
  assert.ok(!("diagnostics" in artifact), "real fixture emits clean (E6008 gone for this path)");
  const src = artifact.sources.find((s) => s.path === FIXTURE);
  assert.ok(src && src.sha256 === FIXTURE_SHA, "real fixture source identity preserved");
  tempDir = mkdtempSync(join(tmpdir(), "can-contained-first-"));
  const workDir = join(tempDir, "modules");
  const asm = await assembleModules(
    { artifact, sourcePath: "contained-first-joint" },
    {
      workDir,
      stdlibUrl: import.meta.resolve("@canlang/cloudflare/runtime/stdlib"),
      uiUrl: import.meta.resolve("@canlang/ui"),
    },
  );
  shared = { artifact, asm, workDir };
  return shared;
}

interface WorldUser {
  identity: ResolvedIdentity;
  userId: string;
}

interface World {
  store: StoragePort;
  identities: ReturnType<typeof createMemoryIdentityStore>;
  member: WorldUser;
  outsider: WorldUser;
}

async function world(): Promise<World> {
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
  const member = await mkSession("caller@contained.test", true);
  const outsider = await mkSession("outsider@contained.test", false);

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
  for (const id of ["term-a", "term-b", "term-c"]) {
    await commit(TERM, {
      id: id as RecordId, version: 1 as RecordVersion,
      created: NOW, updated: NOW, createdBy: "t", updatedBy: "t",
      archivedAt: null, parent: null, data: { name: id },
    });
  }
  const seat = (id: string, parent: string, account: string, active: boolean) =>
    commit(SEAT, {
      id: id as RecordId, version: 1 as RecordVersion,
      created: NOW, updated: NOW, createdBy: "t", updatedBy: "t",
      archivedAt: null, parent: { model: TERM as ModelName, id: parent as RecordId },
      data: { account: { id: account }, active },
    });
  await seat("seat-00-foreign", "term-b", member.userId, false);
  await seat("seat-00-other", "term-a", outsider.userId, true);
  await seat("seat-01-mine", "term-a", member.userId, true);
  await seat("seat-02-rest", "term-a", member.userId, false);
  return { store, identities, member, outsider };
}

async function assign(
  asm: AssembledModules,
  artifact: CompileArtifact,
  w: World,
  termId: string,
  account: string,
  asMember: boolean,
) {
  return invokeMutationCanonical({
    asm,
    artifact,
    operation: OP,
    operationId: uuidv7(NOW, ++sequence) as OperationId,
    inputs: { term: { id: termId, version: "1" }, account: { id: account } },
    identity: asMember ? w.member.identity : w.outsider.identity,
    app: APP,
    source: "contained-first-joint",
    store: w.store,
    memberships: w.identities,
    now: () => NOW,
  });
}

function ruleFailed(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "rule_failed";
}

describe("contained first joint (real emitted handler through the host seam)", () => {
  let asm: AssembledModules;
  let artifact: CompileArtifact;
  before(async () => {
    ({ artifact, asm } = await compileAndAssemble());
  });
  after(() => {
    if (tempDir !== "") rmSync(tempDir, { recursive: true, force: true });
  });

  it("member grant serves the contained seat for the owning term", async () => {
    const w = await world();
    const out = await assign(asm, artifact, w, "term-a", w.member.userId, true);
    assert.ok(out !== null && typeof out === "object" && "result" in out, JSON.stringify(out));
    assert.equal((out as { result: unknown }).result, true);
  });

  it("term-b binds its own domain and refuses the inactive foreign seat", async () => {
    const w = await world();
    await assert.rejects(
      assign(asm, artifact, w, "term-b", w.member.userId, true),
      ruleFailed,
    );
  });

  it("empty domain refuses with rule_failed", async () => {
    const w = await world();
    await assert.rejects(
      assign(asm, artifact, w, "term-c", w.member.userId, true),
      ruleFailed,
    );
  });

  it("denied caller refuses before any decision read", async () => {
    const w = await world();
    await assert.rejects(assign(asm, artifact, w, "term-a", w.outsider.userId, false));
  });

  it("tampered checked source refuses instead of serving", async () => {
    const w = await world();
    const tampered = JSON.parse(JSON.stringify(artifact)) as CompileArtifact;
    assert.ok(tampered.sources[0]);
    tampered.sources[0].sha256 = "0".repeat(64);
    await assert.rejects(
      assign(asm, tampered, w, "term-a", w.member.userId, true),
      AssemblyCorrespondenceError,
    );
  });
});
