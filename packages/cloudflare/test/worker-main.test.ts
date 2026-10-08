/**
 * Deploy worker main tests (`src/worker/main.ts`, MCP-deploy P-A).
 *
 * The default export is the deploy main P-B bundles (`dist/worker/main.js`):
 * the REAL `createWorkerApp` binding gate (loaded via dynamic import, like
 * P2's `loadSiblingFn` pattern) in front of the REAL `assembleWorker`
 * dispatch, plus the `POST /mcp/grants` route to P-C's pinned
 * `handleMcpGrant`.
 *
 * Loader injection (`createMainFetch`) covers the joins that have not
 * landed yet: the P-B staged deployment (`./artifact.js`) and MCP bundle
 * (`./mcp-handler.js`), and P-C's `buildProductionDeps`
 * (`../runtime/env-assembly.js`) and `handleMcpGrant`
 * (`../runtime/grant-route.js`). Tests use the REAL entry/assembly
 * siblings (they exist) and inject only the missing joins — except the
 * fail-loud tests, which exercise the real default loaders against the
 * missing files on purpose.
 *
 * Fixture artifacts are HAND-WRITTEN JSON, honestly labeled: NOT
 * compiler output (`tool_version: "worker-main-fixture/0"`). Stub page
 * modules are temp `.mjs` files holding hand-written descriptors (the
 * `assembly.test.ts` precedent).
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ActivationVerdict,
  CompileArtifact,
  StoragePort,
} from "@canlang/contracts";
import { handlePageRequest } from "@canlang/interfaces";
import workerMain, {
  createMainFetch,
  REQUIRED_BINDINGS,
  type MainLoaders,
  type ProductionDeps,
  type StagedDeployment,
} from "../src/worker/main.js";
import {
  assembleWorker,
  type AssembledModules,
  type HttpPageHandlerFactory,
  type McpHandlerFactory,
} from "../src/worker/assembly.js";

// Hand-written app declaration, independent of the source filename.
const APP_MODULE = "fixture-app.mjs";
const APP_SOURCE = 'export const appDefinition = { id: "TeamTasks" };\n';
const pageFactory: HttpPageHandlerFactory = deps => request =>
  handlePageRequest(deps as Parameters<typeof handlePageRequest>[0], request);

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "canlang-worker-main-")));
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

function stubAsm(dir: string, moduleUrls: Record<string, string>): AssembledModules {
  const entryUrl = writeModule(dir, APP_MODULE, APP_SOURCE);
  return { dir, entryUrl, moduleUrls: { [APP_MODULE]: entryUrl, ...moduleUrls } };
}

function fixtureArtifact(
  pages: CompileArtifact["pages"],
  callables: CompileArtifact["callables"],
): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "worker-main-fixture/0 (hand-written; NOT compiler output)",
    tool_version: "worker-main-fixture/0",
    sources: [{ path: "examples/UnrelatedFixture.can", sha256: "fixture-not-a-digest" }],
    modules: [{ path: APP_MODULE, js: APP_SOURCE,
      map: { version: 3, file: APP_MODULE, sources: [], sourcesContent: [], names: [], mappings: "" } }],
    callables,
    pages,
    requires: [],
    tests: [],
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

const ACTIVE_VERDICT: ActivationVerdict = { active: true };

function stagedDeployment(): StagedDeployment {
  const dir = tempDir();
  const url = writeModule(dir, "home.mjs", VALID_PAGE_SOURCE);
  return {
    artifact: fixtureArtifact(
      [{ owner: "fixture", path: "/", module: "home.mjs", export: "home" }],
      [],
    ),
    modules: stubAsm(dir, { "home.mjs": url }),
    verdict: ACTIVE_VERDICT,
  };
}

/** Production deps with a caller-held identity store (identity asserted with `toBe`). */
function productionDeps(identityStore: Record<string, unknown>): ProductionDeps {
  return { store: stubStore(), identityStore };
}

/** Injected loaders for the joins that have not landed; entry/assembly stay real. */
function testLoaders(overrides: MainLoaders = {}): MainLoaders {
  const staged = stagedDeployment();
  const identityStore = {};
  return {
    loadStagedDeployment: async () => staged,
    loadProductionDeps: async () => productionDeps(identityStore),
    loadHttpPageFactory: async () => pageFactory,
    ...overrides,
  };
}

function fullEnv(): Record<string, unknown> {
  return { DB: { batch: async () => [] } };
}

describe("deploy worker main", () => {
  it("default-exports a fetch handler (the P-B deploy main)", () => {
    expect(typeof workerMain.fetch).toBe("function");
  });

  it("requires exactly the DB binding", () => {
    expect([...REQUIRED_BINDINGS]).toEqual(["DB"]);
  });

  it("default export answers missing-binding 500 when DB is absent", async () => {
    const res = await workerMain.fetch(new Request("http://localhost/"), {});
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; binding: string };
    expect(body.code).toBe("missing-binding");
    expect(body.binding).toBe("DB");
  });

  it("serves pages through the binding gate", async () => {
    const fetch = createMainFetch(testLoaders());
    const ok = await fetch(new Request("http://localhost/"), fullEnv());
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("fixture-home");

    const gated = await fetch(new Request("http://localhost/"), {});
    expect(gated.status).toBe(500);
    expect(((await gated.json()) as { code: string }).code).toBe("missing-binding");
  });

  it("/mcp without createHandler answers the assembly interim 501, exactly as today", async () => {
    // No loadMcpHandlerFactory injected: the real default loader finds no
    // ./mcp-handler.js and main passes no factory — assembly's own 501.
    const staged = stagedDeployment();
    const deps = productionDeps({});
    const fetch = createMainFetch({
      loadStagedDeployment: async () => staged,
      loadProductionDeps: async () => deps,
      loadHttpPageFactory: async () => pageFactory,
    });
    const res = await fetch(new Request("http://localhost/mcp", { method: "POST" }), fullEnv());
    expect(res.status).toBe(501);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("assembly-interim");
    expect(body.message).toContain("AssemblyDeps.mcp.createHandler");

    // Byte-parity with calling assembleWorker directly (no factory).
    const direct = await assembleWorker(staged.artifact, staged.modules, { ...deps, http: { createPageHandler: pageFactory } }, ACTIVE_VERDICT);
    const expected = await direct.fetch(new Request("http://localhost/mcp", { method: "POST" }));
    expect(expected.status).toBe(res.status);
    expect(await expected.json()).toEqual(body);
  });

  it("/mcp with an injected createHandler delegates to it", async () => {
    let factoryCalls = 0;
    const factory: McpHandlerFactory = (deps) => {
      factoryCalls += 1;
      return async () =>
        Response.json({
          handled: true,
          appId: deps.app.appId,
          hasInvoker: typeof deps.invoker.invokeMutation === "function",
        });
    };
    const fetch = createMainFetch(testLoaders({ loadMcpHandlerFactory: async () => factory }));
    const res = await fetch(new Request("http://localhost/mcp", { method: "POST" }), fullEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handled: true, appId: "TeamTasks", hasInvoker: true });
    expect(factoryCalls).toBe(1);
  });

  it("POST /mcp/grants routes to the grant handler with the production identityStore", async () => {
    const identityStore = { marker: "prod-identity-store" };
    const staged = stagedDeployment();
    const seen: Array<{ req: Request; ctx: { identityStore: unknown } }> = [];
    const fetch = createMainFetch({
      loadStagedDeployment: async () => staged,
      loadProductionDeps: async () => ({ store: stubStore(), identityStore }),
      loadGrantHandler: async () => async (req, ctx) => {
        seen.push({ req, ctx });
        return Response.json({ grant: "g1" });
      },
    });
    const res = await fetch(
      new Request("http://localhost/mcp/grants", { method: "POST", body: "{}" }),
      fullEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ grant: "g1" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.req.url).toBe("http://localhost/mcp/grants");
    expect(seen[0]?.ctx.identityStore).toBe(identityStore);
  });

  it("grants route sits behind the binding gate", async () => {
    let grantCalls = 0;
    const fetch = createMainFetch(
      testLoaders({
        loadGrantHandler: async () => async () => {
          grantCalls += 1;
          return Response.json({ grant: "g1" });
        },
      }),
    );
    const res = await fetch(new Request("http://localhost/mcp/grants", { method: "POST" }), {});
    expect(res.status).toBe(500);
    expect(((await res.json()) as { code: string }).code).toBe("missing-binding");
    expect(grantCalls).toBe(0);
  });

  it("GET /mcp/grants falls through to assembly (not_found)", async () => {
    const fetch = createMainFetch(testLoaders());
    const res = await fetch(new Request("http://localhost/mcp/grants"), fullEnv());
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("not_found");
  });

  it("POST /mcp/grants without the grant join answers 501 naming it", async () => {
    // P-C landed, so absence is simulated explicitly: the loader
    // resolves undefined exactly as the default loader does when
    // ../runtime/grant-route.js is missing from the bundle.
    const fetch = createMainFetch(
      testLoaders({ loadGrantHandler: async () => undefined }),
    );
    const res = await fetch(new Request("http://localhost/mcp/grants", { method: "POST" }), fullEnv());
    expect(res.status).toBe(501);
    const body = (await res.json()) as { code: string; route: string; message: string };
    expect(body.code).toBe("deploy-join-pending");
    expect(body.route).toBe("/mcp/grants");
    expect(body.message).toContain("handleMcpGrant");
    expect(body.message).toContain("grant-route");
  });

  it("missing staged deployment fails loud naming ./artifact.js (default export)", async () => {
    // No ./artifact.js staged in this boot: the default export must fail
    // loud naming the file, never serve an empty worker.
    const res = await workerMain.fetch(new Request("http://localhost/"), fullEnv());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("deploy-join-missing");
    expect(body.message).toContain("./artifact.js");
  });

  it("missing production deps fail loud naming buildProductionDeps", async () => {
    // P-C's ../runtime/env-assembly.js is in flight: inject only the
    // staged deployment so the real default deps loader runs and fails.
    const staged = stagedDeployment();
    const fetch = createMainFetch({ loadStagedDeployment: async () => staged });
    const res = await fetch(new Request("http://localhost/"), fullEnv());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("deploy-join-missing");
    expect(body.message).toContain("env-assembly.js");
    expect(body.message).toContain("buildProductionDeps");
  });

  it("malformed staged deployment fails loud naming the bad export", async () => {
    const staged = stagedDeployment();
    const bad = { ...staged, verdict: { active: "yes" } as unknown as ActivationVerdict };
    const fetch = createMainFetch(testLoaders({ loadStagedDeployment: async () => bad }));
    const res = await fetch(new Request("http://localhost/"), fullEnv());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("worker-assembly-failed");
    expect(body.message).toContain("verdict");
  });

  it("assembles once per env object", async () => {
    let stagedCalls = 0;
    let depsCalls = 0;
    let assembleCalls = 0;
    const base = testLoaders();
    const staged = await base.loadStagedDeployment?.();
    const deps = await base.loadProductionDeps?.(fullEnv());
    const fetch = createMainFetch({
      loadHttpPageFactory: async () => pageFactory,
      loadStagedDeployment: async () => {
        stagedCalls += 1;
        return staged as StagedDeployment;
      },
      loadProductionDeps: async () => {
        depsCalls += 1;
        return deps as ProductionDeps;
      },
      loadAssembleWorker: async () => {
        assembleCalls += 1;
        const { assembleWorker: real } = await import("../src/worker/assembly.js");
        return real;
      },
    });
    const env = fullEnv();
    expect((await fetch(new Request("http://localhost/"), env)).status).toBe(200);
    expect((await fetch(new Request("http://localhost/"), env)).status).toBe(200);
    expect(stagedCalls).toBe(1);
    expect(depsCalls).toBe(1);
    expect(assembleCalls).toBe(1);

    expect((await fetch(new Request("http://localhost/"), fullEnv())).status).toBe(200);
    expect(stagedCalls).toBe(1);
    expect(depsCalls).toBe(2);
    expect(assembleCalls).toBe(1);
  });
});
