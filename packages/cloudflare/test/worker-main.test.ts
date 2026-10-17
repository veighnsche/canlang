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
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import type {
  ActivationVerdict,
  CompileArtifact,
  StoragePort,
} from "@canlang/contracts";
import { handlePageRequest } from "@canlang/interfaces";
import type { PagePreferenceKey, PagePreferenceStore } from "@canlang/interfaces";
import { createIdentityFixture } from "@canlang/interfaces/testing";
import { deriveCsrfToken } from "@canlang/identity";
import ts from "typescript";
import { buildHttpOperationsBundle } from "../src/deploy/bundle.js";
import { createWorkerApp } from "../src/worker/entry.js";
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
  it("loads the deployed export handler and forwards the exact durable backend without a fallback", async () => {
    // Loader/forwarding controls only; physical D1 and authorized bodies have separate owning cases.
    for (const control of [
      { source: undefined, available: false },
      { source: 'export const legacy = true;', available: false },
      { source: 'export const handleExportRequest = 42;', invalid: true },
      { source: 'export async function handleExportRequest(deps,request){return new Response((await deps.exportDownloads.read("probe"))+":"+new URL(request.url).pathname);}', available: true },
    ]) {
      const dir = tempDir();
      const source = ts.transpileModule(readFileSync(new URL('../src/worker/main.ts', import.meta.url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText;
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      if (control.source !== undefined) writeFileSync(join(dir, 'http-operations.js'), control.source);
      const deployed = await import(/* @vite-ignore */ writeModule(dir, 'export-main.mjs', source)) as typeof import('../src/worker/main.js');
      const staged = stagedDeployment(); staged.artifact.pages = [];
      const backend = { read: async () => 'installed-backend' };
      const baked = {};
      let assembled = false;
      const fetch = deployed.createMainFetch({
        loadEntry: async () => createWorkerApp,
        loadStagedDeployment: async () => staged,
        loadProductionDeps: async () => ({ ...productionDeps({}), exportDownloads: backend as never }),
        loadMcpHandlerFactory: async () => undefined,
        loadHttpOperationsFactory: async () => undefined,
        loadHttpCsvFactory: async () => undefined,
        loadHttpPageFactory: async () => undefined,
        loadHttpAuthJoin: async () => undefined,
        loadDerivedInputs: async () => baked,
        loadAssembleWorker: async () => async (_artifact, _modules, deps) => {
          assembled = true;
          expect(deps.http?.exportDownloads).toBe(control.available ? backend : undefined);
          expect(deps.http?.derivedInputs).toBe(control.available ? baked : undefined);
          const handler = deps.http?.createExportHandler;
          return { pageCount: 0, opCount: 0, fetch: handler === undefined
            ? async () => new Response('export join absent', { status: 501 })
            : handler({ exportDownloads: backend } as never) };
        },
      });
      const result = await fetch(new Request('http://localhost/api/exports/status/probe'), fullEnv());
      expect(result.status).toBe(control.invalid ? 500 : control.available ? 200 : 501);
      expect(assembled).toBe(!control.invalid);
      if (control.invalid) expect(await result.json()).toMatchObject({ code: 'deploy-join-missing', message: expect.stringContaining('handleExportRequest') });
      else expect(await result.text()).toBe(control.available ? 'installed-backend:/api/exports/status/probe' : 'export join absent');
    }
  });

  it("loads the deployed CSV export, preserves absent legacy joins and refuses malformed exports", async () => {
    // Hand-written loader controls only; these responses make no CSV or native business claim.
    const controls = [
      { source: undefined, available: false },
      { source: 'export const legacy = true;', available: false },
      { source: 'export const handleCsvRequest = 42;', invalid: true },
      { source: 'export async function handleCsvRequest(deps,request){return new Response(deps.marker+":"+new URL(request.url).pathname);}', available: true },
    ];
    for (const control of controls) {
      const dir = tempDir();
      const source = ts.transpileModule(readFileSync(new URL('../src/worker/main.ts', import.meta.url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText;
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      if (control.source !== undefined) writeFileSync(join(dir, 'http-operations.js'), control.source);
      const deployed = await import(/* @vite-ignore */ writeModule(dir, 'main.mjs', source)) as typeof import('../src/worker/main.js');
      const staged = stagedDeployment();
      staged.artifact.pages = [];
      const baked = {};
      let derivedLoads = 0, assembled = false;
      const fetch = deployed.createMainFetch({
        loadEntry: async () => createWorkerApp,
        loadStagedDeployment: async () => staged,
        loadProductionDeps: async () => productionDeps({}),
        loadMcpHandlerFactory: async () => undefined,
        loadHttpOperationsFactory: async () => undefined,
        loadHttpPageFactory: async () => undefined,
        loadHttpAuthJoin: async () => undefined,
        loadDerivedInputs: async () => { derivedLoads++; return baked; },
        loadAssembleWorker: async () => async (_artifact, _modules, deps) => {
          assembled = true;
          expect(deps.http?.createOperationHandler).toBeUndefined();
          const csv = deps.http?.createCsvHandler;
          expect(typeof csv).toBe(control.available ? 'function' : 'undefined');
          expect(deps.http?.derivedInputs).toBe(control.available ? baked : undefined);
          return { pageCount: 0, opCount: 0,
            fetch: csv === undefined ? async () => new Response('CSV join absent', { status: 501 })
              : csv({ marker: 'installed-csv' } as never) };
        },
      });
      const response = await fetch(new Request('http://localhost/api/csv/preview', { method: 'POST' }), fullEnv());
      if (control.invalid) {
        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({ code: 'deploy-join-missing',
          message: expect.stringContaining('handleCsvRequest') });
        expect(assembled).toBe(false); expect(derivedLoads).toBe(0);
      } else {
        expect(assembled).toBe(true);
        expect(derivedLoads).toBe(control.available ? 1 : 0);
        expect(response.status).toBe(control.available ? 200 : 501);
        expect(await response.text()).toBe(control.available ? 'installed-csv:/api/csv/preview' : 'CSV join absent');
      }
    }
  });

  it("passes distinct trusted multi-owner bindings to one router and no cohort scope", async () => {
    const dir = tempDir();
    const entryUrl = writeModule(dir, "multi-app.mjs",
      'export const appDefinition = { id: "TeamTasks", packages: { TeamTasks: {} } };');
    const staged: StagedDeployment = {
      artifact: fixtureArtifact([], []),
      modules: { dir, entryUrl, moduleUrls: {} },
      verdict: ACTIVE_VERDICT,
    };
    const cedarDb = { name: "cedar" };
    const oakDb = { name: "oak" };
    const routes = [
      { owner: "cedar", db: cedarDb, initializeFresh: true },
      { owner: "oak", db: oakDb, initializeFresh: true },
    ] as unknown as NonNullable<ProductionDeps["stateTeams"]>;
    let resolve: ((scope: { app: string; owner: string }) => unknown) | undefined;
    let routed = false;
    let assembled = false;
    const fetch = createMainFetch({
      loadStagedDeployment: async () => staged,
      loadProductionDeps: async () => ({ store: stubStore(), identityStore: {}, stateTeams: routes }),
      loadOwnerRouterFactory: async () => input => {
        resolve = input.resolveBinding;
        return { ownerScopedStoragePort: async () => stubStore() };
      },
      loadOwnerStorageFactory: async () => async input => {
        routed = true;
        expect(input.app).toBe("TeamTasks");
        return { app: input.app, forIdentity: async () => stubStore(),
          forTrustedScope: async () => ({ identity: {} as never, store: stubStore() }) };
      },
      loadAssembleWorker: async () => async (_artifact, _modules, deps) => {
        assembled = true;
        expect(deps.ownerStorage?.app).toBe("TeamTasks");
        expect(typeof deps.pageReads).toBe("function");
        if (typeof deps.pageReads !== "function") throw new Error("missing owner page factory");
        const pageReads = deps.pageReads;
        const sourceIdentity = pageReads({ team: { team_id: "cedar" } } as never, stubStore()).sourceIdentity;
        for (const owner of ["cedar", "oak"]) {
          expect(pageReads({ team: { team_id: owner } } as never, stubStore())).toEqual({
            scope: { app: "TeamTasks", ownerPackage: "TeamTasks", owner }, sourceIdentity,
          });
        }
        expect(JSON.parse(sourceIdentity).sources).toEqual(staged.artifact.sources);
        expect(() => pageReads({ team: { team_id: "other" } } as never, stubStore())).toThrow();
        expect(deps.cohorts).toBeUndefined();
        return { fetch: async () => new Response("ready"), pageCount: 0, opCount: 0 };
      },
    });
    expect((await fetch(new Request("http://localhost/"), fullEnv())).status).toBe(200);
    expect(routed && assembled).toBe(true);
    expect(resolve?.({ app: "TeamTasks", owner: "cedar" })).toMatchObject({ owner: "cedar", db: cedarDb, initializeFresh: true });
    expect(resolve?.({ app: "TeamTasks", owner: "oak" })).toMatchObject({ owner: "oak", db: oakDb, initializeFresh: true });
    expect(resolve?.({ app: "TeamTasks", owner: "other" })).toBeNull();
    expect(resolve?.({ app: "OtherApp", owner: "cedar" })).toBeNull();
  });

  it("refuses multi-owner scheduled/cohort work before building an owner router", async () => {
    const dir = tempDir();
    const entryUrl = writeModule(dir, "multi-app.mjs",
      'export const appDefinition = { id: "TeamTasks", packages: { TeamTasks: {} } };');
    let routed = false;
    const artifact = fixtureArtifact([], []);
    artifact.requires.push({ capability: "state.cohorts", min_version: 1 });
    const fetch = createMainFetch({
      loadStagedDeployment: async () => ({ artifact, modules: { dir, entryUrl, moduleUrls: {} }, verdict: ACTIVE_VERDICT }),
      loadProductionDeps: async () => ({ store: stubStore(), identityStore: {},
        stateTeams: [{ owner: "cedar", db: {} as never }] }),
      loadOwnerRouterFactory: async () => { routed = true; throw new Error("unexpected owner router"); },
    });
    const result = await fetch(new Request("http://localhost/"), fullEnv());
    expect(result.status).toBe(500);
    expect(JSON.stringify(await result.json())).toContain("multi-owner State does not support cohort");
    expect(routed).toBe(false);
  });

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

  it("loads the real HTTP bundle and saves bound preferences through the deployed page route", async () => {
    // The browser-targeted bundle selects Identity's workerd comparator.
    // Supply that native host extension with Node's real primitive here;
    // CSRF derivation and verification still run through the owning bundle.
    const subtle = globalThis.crypto.subtle;
    const comparison = Object.getOwnPropertyDescriptor(subtle, 'timingSafeEqual');
    Object.defineProperty(subtle, 'timingSafeEqual', { configurable: true, value: timingSafeEqual });
    onTestFinished(() => {
      if (comparison === undefined) Reflect.deleteProperty(subtle, 'timingSafeEqual');
      else Object.defineProperty(subtle, 'timingSafeEqual', comparison);
    });
    const dir = tempDir();
    // Privately transpile current main source so its unoverridden default
    // loader resolves the real deployed sibling, without writing shared dist.
    const main = ts.transpileModule(readFileSync(new URL('../src/worker/main.ts', import.meta.url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, 'http-operations.js'), buildHttpOperationsBundle());
    const url = writeModule(dir, 'main.mjs', main);
    const deployed = await import(/* @vite-ignore */ url) as typeof import('../src/worker/main.js');
    const identity = await createIdentityFixture();
    const teamB = await identity.store.createTeam({});
    await identity.store.createMembership({ team_id: teamB.team_id, user_id: identity.userId, is_owner: true, roles: [] });
    const deniedTeam = await identity.store.createTeam({});
    await identity.store.createMembership({ team_id: deniedTeam.team_id, user_id: identity.userId, is_owner: false, roles: [] });
    const rows = new Map<string, { value: string; version: string }>();
    const keyOf = (key: PagePreferenceKey) => JSON.stringify({ appId: key.appId, actorUserId: key.actorUserId,
      teamId: key.teamId, owner: key.owner, field: key.field });
    const preferences: PagePreferenceStore = {
      async read(key) { return rows.get(keyOf(key)) ?? null; },
      async save(input) {
        const key = keyOf(input);
        if ((rows.get(key)?.version ?? '0') !== input.expectedVersion) return false;
        rows.set(key, { value: input.value, version: String(BigInt(input.expectedVersion) + 1n) });
        return true;
      },
    };
    const pageUrl = writeModule(dir, 'preference-page.mjs', `export const home = {
      owner: "fixture", path: "/", title: "Preferences",
      preferenceFields: [{ name: "view", options: ["all", "available", "restock"], defaultValue: "all" }],
      admit: async source => {
        if (!source.canonical.builtinRoles.includes("owner")) throw { code: "forbidden", message: "Owner required.", retryable: false };
        return {};
      },
      render: async context => "<p>" + context.preferences.fixture.view + ":" + context.preferenceVersions.fixture.view + "</p>",
    };`);
    const staged: StagedDeployment = { artifact: fixtureArtifact([
      { owner: 'fixture', path: '/', module: 'preference-page.mjs', export: 'home' },
    ], []), modules: stubAsm(dir, { 'preference-page.mjs': pageUrl }), verdict: ACTIVE_VERDICT };
    const fetch = deployed.createMainFetch({
      loadEntry: async () => createWorkerApp,
      loadAssembleWorker: async () => assembleWorker,
      loadStagedDeployment: async () => staged,
      loadProductionDeps: async () => ({ store: stubStore(), identityStore: identity.store, preferences }),
    });
    const env = { ...fullEnv(), CAN_FORM_BINDING_KEY: new Uint8Array(32) };
    const path = (team = identity.teamId) => `/?team=${team}&q=paper`;
    const get = (team = identity.teamId, method = 'GET') => new Request(`http://localhost${path(team)}`, {
      method, headers: { cookie: identity.cookie, 'hx-request': 'true' },
    });
    const csrf = await deriveCsrfToken(identity.sessionToken);
    const post = (value: string, version: string, opts: { team?: string; csrf?: string; cookie?: string; extra?: string } = {}) =>
      new Request(`http://localhost${path(opts.team)}`, { method: 'POST', headers: {
        cookie: opts.cookie ?? identity.cookie, 'content-type': 'application/x-www-form-urlencoded',
      }, body: new URLSearchParams({ _csrf: opts.csrf ?? csrf, _version: version, view: value }).toString() + (opts.extra ?? '') });
    const initial = await fetch(get(), env);
    expect(initial.status).toBe(200);
    expect(await initial.text()).toContain('<p>all:0</p>');
    expect((await fetch(post('available', '0', { csrf: 'bad' }), env)).status).toBe(403);
    expect((await fetch(post('available', '0', { cookie: '' }), env)).status).toBe(403);
    expect((await fetch(post('available', '0', { extra: '&_version=0' }), env)).status).toBe(400);
    expect((await fetch(post('foreign', '0'), env)).status).toBe(400);
    expect(rows.size).toBe(0);
    const saved = await fetch(post('available', '0'), env);
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe(path());
    expect(await (await fetch(get(), env)).text()).toContain('<p>available:1</p>');
    const head = await fetch(get(identity.teamId, 'HEAD'), env);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(await (await fetch(get(teamB.team_id), env)).text()).toContain('<p>all:0</p>');
    expect((await fetch(post('restock', '0', { team: teamB.team_id }), env)).status).toBe(303);
    expect(rows.get(keyOf({ appId: 'TeamTasks', actorUserId: identity.userId,
      teamId: identity.teamId, owner: 'fixture', field: 'view' }))).toEqual({ value: 'available', version: '1' });
    expect(await (await fetch(get(teamB.team_id), env)).text()).toContain('<p>restock:1</p>');
    const beforeRefusals = [...rows];
    expect((await fetch(post('restock', '0'), env)).status).toBe(409);
    expect((await fetch(post('available', '0', { team: deniedTeam.team_id }), env)).status).toBe(403);
    const membership = await identity.store.findMembership(identity.teamId, identity.userId);
    expect(membership).not.toBeNull();
    await identity.store.removeMembership(membership!.membership_id);
    expect((await fetch(post('restock', '1'), env)).status).toBe(403);
    expect([...rows]).toEqual(beforeRefusals);
    expect((await fetch(get(teamB.team_id, 'PUT'), env)).status).toBe(404);
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

  it("POST /mcp/grants routes with the production identityStore and explicit trusted auth origin", async () => {
    const identityStore = { marker: "prod-identity-store" };
    const authOrigin = 'https://auth.example';
    const staged = stagedDeployment();
    const seen: Array<{ req: Request; ctx: { identityStore: unknown; authOrigin?: string } }> = [];
    const fetch = createMainFetch({
      loadStagedDeployment: async () => staged,
      loadProductionDeps: async () => ({ store: stubStore(), identityStore,
        auth: { origin: authOrigin, secureCookies: true,
          limiter: { check: async () => { throw new Error('grant routing does not consume auth limiter'); } } },
        deploymentBase: 'https://deploy.example/app/' }),
      loadGrantHandler: async () => async (req, ctx) => {
        seen.push({ req, ctx });
        return Response.json({ grant: "g1" });
      },
    });
    const res = await fetch(
      new Request("http://localhost/mcp/grants", { method: "POST", body: "{}", headers: { host: 'untrusted.example' } }),
      fullEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ grant: "g1" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.req.url).toBe("http://localhost/mcp/grants");
    expect(seen[0]?.ctx.identityStore).toBe(identityStore);
    expect(seen[0]?.req.headers.get('host')).toBe('untrusted.example');
    expect(seen[0]?.ctx.authOrigin).toBe(authOrigin);
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

  it("inactive deployments cannot initialize Identity or issue MCP grants", async () => {
    const staged = { ...stagedDeployment(), verdict: { active: false, reasons: [
      { code: "blocked-work", detail: "required recovery is incomplete" },
    ] } as ActivationVerdict };
    const fetch = createMainFetch(testLoaders({
      loadStagedDeployment: async () => staged,
      loadProductionDeps: async () => { throw new Error("Identity must not initialize"); },
      loadGrantHandler: async () => { throw new Error("Grant issuer must not load"); },
    }));
    const response = await fetch(new Request("http://localhost/mcp/grants", { method: "POST" }), fullEnv());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "activation-refused" });
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


it("forwards the original explicit production deployment base without a request-origin fallback", async () => {
  const deploymentBase = "https://DEPLOY.example/";
  let observed: string | undefined;
  const fetch = createMainFetch({
    loadEntry: async () => createWorkerApp,
    loadStagedDeployment: async () => stagedDeployment(),
    loadProductionDeps: async () => ({ ...productionDeps({}), deploymentBase }),
    loadMcpHandlerFactory: async () => undefined,
    loadHttpOperationsFactory: async () => undefined,
    loadHttpCsvFactory: async () => undefined,
    loadHttpPageFactory: async () => undefined,
    loadHttpAuthJoin: async () => undefined,
    loadDerivedInputs: async () => undefined,
    loadAssembleWorker: async () => async (_artifact, _modules, deps) => {
      observed = deps.deploymentBase;
      return { pageCount: 0, opCount: 0, fetch: async () => new Response("configured") };
    },
  });
  const response = await fetch(new Request("https://untrusted-request.example/"), fullEnv());
  expect(response.status).toBe(200);
  expect(observed).toBe(deploymentBase);
});
