/**
 * Worker assembly tests (`src/worker/assembly.ts`).
 *
 * The fixture artifacts below are HAND-WRITTEN JSON, honestly labeled: NOT
 * compiler output (`tool_version: "assembly-fixture/0"`). Stub page modules
 * are temp `.mjs` files holding hand-written descriptors.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CompileArtifact,
  OperationId,
  ResolvedIdentity,
  StoragePort,
} from "@canlang/contracts";
import {
  INTERIM_DDL,
  assembleWorker,
  buildInvoker,
  type AssembledModules,
  type AssemblyDeps,
} from "../src/worker/assembly.js";

const FIXED_NOW = 1767225600000;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  // realpath: macOS tmpdir() is a /var symlink; resolve it so module URLs
  // are canonical for every loader.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "canlang-assembly-")));
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

function stubDeps(): AssemblyDeps {
  return { store: stubStore(), identityStore: {}, now: () => FIXED_NOW };
}

function stubAsm(dir: string, moduleUrls: Record<string, string>): AssembledModules {
  return { dir, entryUrl: "fixture-entry", moduleUrls };
}

function fixtureArtifact(
  pages: CompileArtifact["pages"],
  callables: CompileArtifact["callables"],
): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "assembly-fixture/0 (hand-written; NOT compiler output)",
    tool_version: "assembly-fixture/0",
    sources: [{ path: "examples/TeamTasks.can", sha256: "fixture-not-a-digest" }],
    modules: [],
    callables,
    pages,
    requires: [],
    tests: [],
  };
}

function anonymousIdentity(): ResolvedIdentity {
  return {
    actor: null,
    team: null,
    membership: null,
    binding: { kind: "none" },
    admitted_at: "2026-01-01T00:00:00.000Z",
  };
}

const VALID_PAGE_SOURCE = `export const home = {
  owner: "fixture",
  path: "/",
  title: "Home",
  admit: async () => ({}),
  render: async () => "<h1>fixture-home</h1>",
};
`;

async function expectPageModuleFailure(
  assembly: Promise<unknown>,
  pagePath: string,
  module: string,
): Promise<void> {
  await expect(assembly).rejects.toThrow(`page "${pagePath}" module "${module}"`);
}

describe("assembleWorker", () => {
  it("assembles a 1-page/1-op fixture and serves the page", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "home.mjs", VALID_PAGE_SOURCE);
    const artifact = fixtureArtifact(
      [{ owner: "fixture", path: "/", module: "home.mjs", export: "home" }],
      [{ id: "fixture.demo", kind: "operation", module: "ops.mjs", export: "demo", member: ["demo"] }],
    );
    const assembled = await assembleWorker(
      artifact,
      stubAsm(dir, { "home.mjs": url }),
      stubDeps(),
    );

    expect(assembled.pageCount).toBe(1);
    expect(assembled.opCount).toBe(1);
    expect(typeof assembled.fetch).toBe("function");

    const get = await assembled.fetch(new Request("http://localhost/"));
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toContain("text/html");
    expect(await get.text()).toContain("fixture-home");

    const head = await assembled.fetch(new Request("http://localhost/", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    const missing = await assembled.fetch(new Request("http://localhost/nope"));
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe("not_found");

    const slashed = await assembled.fetch(new Request("http://localhost/nope/?a=1"));
    expect(slashed.status).toBe(308);
    expect(slashed.headers.get("location")).toBe("/nope?a=1");
  });

  it("fails loud naming page+module when the module URL is missing", async () => {
    const dir = tempDir();
    const artifact = fixtureArtifact(
      [{ owner: "fixture", path: "/gone", module: "gone.mjs", export: "page" }],
      [],
    );
    await expectPageModuleFailure(
      assembleWorker(artifact, stubAsm(dir, {}), stubDeps()),
      "/gone",
      "gone.mjs",
    );
  });

  it("fails loud naming page+module when the export binding is missing", async () => {
    const dir = tempDir();
    const url = writeModule(dir, "other.mjs", `export const other = {};\n`);
    const artifact = fixtureArtifact(
      [{ owner: "fixture", path: "/gone", module: "other.mjs", export: "page" }],
      [],
    );
    await expectPageModuleFailure(
      assembleWorker(artifact, stubAsm(dir, { "other.mjs": url }), stubDeps()),
      "/gone",
      "other.mjs",
    );
  });

  it("fails loud naming page+module on owner mismatch", async () => {
    const dir = tempDir();
    const url = writeModule(
      dir,
      "owner.mjs",
      `export const page = { owner: "other-owner", path: "/wrong-owner", title: "x", admit: async () => ({}), render: async () => "x" };\n`,
    );
    const artifact = fixtureArtifact(
      [{ owner: "fixture", path: "/wrong-owner", module: "owner.mjs", export: "page" }],
      [],
    );
    await expectPageModuleFailure(
      assembleWorker(artifact, stubAsm(dir, { "owner.mjs": url }), stubDeps()),
      "/wrong-owner",
      "owner.mjs",
    );
  });

  it("fails loud naming page+module when render-shape is wrong", async () => {
    const dir = tempDir();
    const url = writeModule(
      dir,
      "render.mjs",
      `export const page = { owner: "fixture", path: "/no-render", title: "x", admit: async () => ({}) };\n`,
    );
    const artifact = fixtureArtifact(
      [{ owner: "fixture", path: "/no-render", module: "render.mjs", export: "page" }],
      [],
    );
    await expectPageModuleFailure(
      assembleWorker(artifact, stubAsm(dir, { "render.mjs": url }), stubDeps()),
      "/no-render",
      "render.mjs",
    );
  });

  it("rejects unsupported artifact versions precisely", async () => {
    const dir = tempDir();
    // Deliberately mistyped input: the assembly must reject it at runtime.
    const artifact = {
      ...fixtureArtifact([], []),
      artifact_version: 2,
    } as unknown as CompileArtifact;
    await expect(
      assembleWorker(artifact, stubAsm(dir, {}), stubDeps()),
    ).rejects.toThrow("unsupported artifact_version");
  });

  it("rejects unknown callable kinds precisely", async () => {
    const dir = tempDir();
    // Deliberately mistyped input: the assembly must reject it at runtime.
    const weird = { id: "fixture.weird", kind: "spell", module: "x.mjs", export: "y" };
    const artifact = fixtureArtifact([], [weird] as unknown as CompileArtifact["callables"]);
    await expect(assembleWorker(artifact, stubAsm(dir, {}), stubDeps())).rejects.toThrow(
      "unknown callable kind",
    );
  });

  it("requires deps.store and deps.identityStore", async () => {
    const dir = tempDir();
    const artifact = fixtureArtifact([], []);
    await expect(
      assembleWorker(artifact, stubAsm(dir, {}), {
        store: null as unknown as StoragePort,
        identityStore: {},
      }),
    ).rejects.toThrow("deps.store is required");
    await expect(
      assembleWorker(artifact, stubAsm(dir, {}), { store: stubStore(), identityStore: null }),
    ).rejects.toThrow("deps.identityStore is required");
  });

  it("counts only operation callables toward opCount", async () => {
    const dir = tempDir();
    const artifact = fixtureArtifact([], [
      { id: "fixture.a", kind: "operation", module: "a.mjs", export: "a", member: ["a"] },
      { id: "fixture.b", kind: "operation", module: "b.mjs", export: "b", member: ["b"] },
      { id: "fixture.p", kind: "pure", module: "p.mjs", export: "p", member: ["p"] },
      { id: "fixture.r", kind: "rule", module: "r.mjs", export: "r", member: ["r"] },
    ]);
    const assembled = await assembleWorker(artifact, stubAsm(dir, {}), stubDeps());
    expect(assembled.pageCount).toBe(0);
    expect(assembled.opCount).toBe(2);
  });

  it("answers unjoined surfaces with an explicit interim 501", async () => {
    const dir = tempDir();
    const assembled = await assembleWorker(fixtureArtifact([], []), stubAsm(dir, {}), stubDeps());

    const op = await assembled.fetch(
      new Request("http://localhost/api/operations/demo.op", { method: "POST" }),
    );
    expect(op.status).toBe(501);
    const opBody = (await op.json()) as { code: string; message: string };
    expect(opBody.code).toBe("assembly-interim");
    expect(opBody.message).toContain("interfaces join");

    const auth = await assembled.fetch(new Request("http://localhost/auth/login"));
    expect(auth.status).toBe(501);
    expect(((await auth.json()) as { code: string }).code).toBe("assembly-interim");
  });
});

describe("buildInvoker", () => {
  it("success path threads identity facts and the projection array", async () => {
    const dir = tempDir();
    const url = writeModule(
      dir,
      "ops.mjs",
      `export function canApp() {
        return { echo: async (c, input) => ({ echoed: input.operation_id, caller: c.caller.userId, member: c.memberships.includes("members") }) };
      }`,
    );
    const artifact = fixtureArtifact(
      [],
      [{ id: "fixture.echo", kind: "operation", module: "ops.mjs", export: "echo", member: ["echo"] }],
    );
    const invoker = buildInvoker(artifact, stubAsm(dir, { "ops.mjs": url }), stubStore());
    const operationId = "0193c1f0-0000-7000-8000-000000000001" as OperationId;
    const outcome = await invoker.invokeMutation(
      { operation: "fixture.echo", operation_id: operationId, inputs: {} },
      {
        actor: { user_id: "u1", email: "u1@example.test", email_verified: true },
        team: null,
        membership: {
          membership_id: "m1",
          team_id: "t1",
          user_id: "u1",
          is_owner: false,
          roles: [{ role: "members", granted_at: "2026-01-01T00:00:00.000Z", granted_by: "u0" }],
          status: "active",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
        binding: { kind: "none" },
        admitted_at: "2026-01-01T00:00:00.000Z",
      },
    );
    expect(outcome).toEqual({ result: { echoed: operationId, caller: "u1", member: true } });
  });

  it("anonymous caller maps to the labeled anonymous identity", async () => {
    const dir = tempDir();
    const url = writeModule(
      dir,
      "ops.mjs",
      `export function canApp() {
        return { echo: async (c, input) => ({ caller: c.caller.userId, roles: c.caller.roles.length, member: c.memberships.length }) };
      }`,
    );
    const artifact = fixtureArtifact(
      [],
      [{ id: "fixture.echo", kind: "operation", module: "ops.mjs", export: "echo", member: ["echo"] }],
    );
    const invoker = buildInvoker(artifact, stubAsm(dir, { "ops.mjs": url }), stubStore());
    const outcome = await invoker.invokeMutation(
      {
        operation: "fixture.echo",
        operation_id: "0193c1f0-0000-7000-8000-000000000002" as OperationId,
        inputs: {},
      },
      anonymousIdentity(),
    );
    expect(outcome).toEqual({ result: { caller: "anonymous", roles: 0, member: 0 } });
  });

  it("unknown operation resolves a rule_failed error naming the callable", async () => {
    const dir = tempDir();
    const artifact = fixtureArtifact([], []);
    const invoker = buildInvoker(artifact, stubAsm(dir, {}), stubStore());
    const operationId = "0193c1f0-0000-7000-8000-000000000000" as OperationId;
    const outcome = await invoker.invokeMutation(
      { operation: "fixture.demo", operation_id: operationId, inputs: {} },
      anonymousIdentity(),
    );
    expect(outcome).toMatchObject({
      error: { code: "rule_failed", operation_id: operationId, retryable: false },
    });
    expect((outcome as { error: { message: string } }).error.message).toContain(
      'unknown callable "fixture.demo"',
    );
  });
});

describe("INTERIM_DDL", () => {
  it("covers exactly the demo models as single-line exec statements", () => {
    expect(INTERIM_DDL).toHaveLength(2);
    const [todo, note] = INTERIM_DDL;
    expect(todo).toContain("CREATE TABLE IF NOT EXISTS todo");
    expect(todo).toContain("title");
    expect(note).toContain("CREATE TABLE IF NOT EXISTS note");
    expect(note).toContain("content");
    for (const statement of INTERIM_DDL) {
      expect(statement).not.toContain("\n");
      expect(statement.endsWith(";")).toBe(false);
    }
  });
});
