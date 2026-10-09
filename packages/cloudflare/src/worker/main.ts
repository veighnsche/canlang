/**
 * Deploy worker main (`@canlang/cloudflare/worker/main`). Runs inside
 * workerd; P-B bundles the compiled `dist/worker/main.js` as the deploy
 * main.
 *
 * The default-export `fetch` is the REAL `createWorkerApp` binding gate
 * (`./entry.js`, loaded via dynamic import) in front of the REAL
 * `assembleWorker` dispatch (`./assembly.js`, loaded via dynamic import
 * exactly like P2's `loadSiblingFn` pattern):
 *
 * - `POST /mcp/grants` routes to P-C's pinned `handleMcpGrant(req,
 *   { identityStore })` (`../runtime/grant-route.js`, dynamic import).
 * - Every other path delegates to the assembled worker (pages, `/mcp`,
 *   `/files/*`, `/api/*`, `/auth/*` — assembly owns their semantics).
 *
 * Worker-boundary compliant: static `import type` only (this package's
 * `@canlang/contracts` dependency plus sibling types); every runtime
 * module loads via dynamic `import()`, enforced by
 * `test/worker-boundary.test.ts`.
 *
 * Sibling-join map (specifiers resolve relative to this module's compiled
 * location, `dist/worker/main.js`; P-B keeps them runtime-resolvable):
 *
 * | specifier                    | export(s)                              | packet |
 * |------------------------------|----------------------------------------|--------|
 * | `./entry.js`                 | `createWorkerApp`                      | P-A    |
 * | `./assembly.js`              | `assembleWorker`                       | P-A    |
 * | `./artifact.js`              | `artifact`, `modules`, `verdict`       | P-B    |
 * | `./mcp-handler.js`           | `createHandler` (default accepted)     | P-B    |
 * | `./http-operations.js`       | `handleOperationRequest` (default)     | C3     |
 * | `./derived-inputs.js`        | `derivedInputs`                        | P-B    |
 * | `../runtime/env-assembly.js` | `buildProductionDeps`                  | P-C    |
 * | `../runtime/grant-route.js`  | `handleMcpGrant`                       | P-C    |
 *
 * Absent optional joins degrade to the documented 501s: no
 * `./mcp-handler.js` means main passes no `createHandler`, so `/mcp`
 * answers assembly's own interim 501 naming the join, exactly as today;
 * no `../runtime/grant-route.js` means `POST /mcp/grants` answers
 * `deploy-join-pending`. Absent REQUIRED joins (`./entry.js`,
 * `./assembly.js`, `./artifact.js`, `../runtime/env-assembly.js`) fail
 * loud as 500 `deploy-join-missing` naming the specifier — never an
 * empty worker. A present-but-wrong export (import succeeds, no
 * function) is always loud 500: that is a bundler bug, not an absent
 * join. A sibling whose import rejects is indistinguishable from a
 * missing file (no filesystem in workerd), so import rejections on the
 * OPTIONAL siblings read as absent; deploy-time checks own that gap.
 *
 * `AssemblyDeps.mcp.permissions` comes from P-C's
 * `createMemberMcpPermissions` (`runtime/mcp-permissions.ts`), built over
 * the staged artifact. Absent module -> `undefined` -> assembly's
 * deny-closed interim (safe, serves empty discovery); present-but-wrong
 * export -> loud 500.
 *
 * `AssemblyDeps.mcp.derivedInputs` comes from the staged
 * `./derived-inputs.js` (`derivedInputs` export, baked at deploy by
 * the REAL interfaces derivation). Absent module -> `undefined` ->
 * the catalog serves framing shapes only (E1 legacy); present-but-
 * wrong export -> loud 500. C3 feeds the SAME bake to
 * `AssemblyDeps.http.derivedInputs`, so both transports check the
 * same bound rules.
 */

import type { ActivationVerdict, CompileArtifact, PageDescriptor, StoragePort, WorkScope } from "@canlang/contracts";
import type { IdentityStore } from '@canlang/identity';
import type { StateTeamBinding } from '../runtime/env-assembly.js';
import type { PagePreferenceStore } from '@canlang/interfaces';
import type { createD1OwnerRouter } from '@canlang/state/storage/owner-router';
import type { AssembledModules } from "../runtime/modules.js";
import type { BakedDerivedInputs } from "../runtime/mcp-registry.js";
import type {
  AssembledWorker,
  CohortTickBinding,
  AssemblyDeps,
  BrowserAssetsHandler,
  HttpOperationHandlerFactory,
  HttpAuthConfiguration,
  HttpAuthJoin,
  HttpPageHandlerFactory,
  McpHandlerFactory,
  McpPermissions,
  SourceFormBindings,
  TeamOwnerStorageBoundary,
} from "./assembly.js";
import type { WorkerApp, WorkerAppOptions } from "./entry.js";

/* ------------------------------------------------------------------ */
/* Pinned join contracts. Structural mirrors of the sibling packets'  */
/* exports (P-B `./artifact.js` + `./mcp-handler.js`, P-C             */
/* `buildProductionDeps` + `handleMcpGrant`); each cites its owner.   */
/* ------------------------------------------------------------------ */

/**
 * Bindings that must be present on the production `env`, enforced by the
 * REAL `createWorkerApp` gate before any route runs.
 *
 * - `DB` (D1 database): consumed by P-C's `buildProductionDeps(env)`
 *   (`runtime/env-assembly.ts`) via `createD1Storage(db)`
 *   (`packages/state/src/storage/d1.ts`). The store, the D1-backed
 *   identity store, and the engine schema ensures all hang off it
 *   (T17c: the INTERIM_DDL migrate step was retired with `INTERIM_DDL`
 *   — the engine stores every model in its generic `records` table).
 *
 * No other binding is needed today: P-C's `handleMcpGrant` takes the
 * already-built `identityStore`, not `env`. If P-C's deps constructor
 * grows further `env` reads, this list grows with it (join note in
 * `implementation/evidence/mcpd-a.md`).
 */
export const REQUIRED_BINDINGS: readonly string[] = ["DB"];

/**
 * P-B staged deployment (`./artifact.js` next to the bundled main):
 * the compiled artifact, its PORTABLE module map (workerd-loadable
 * URLs — never node file-URLs), and the deploy-time activation verdict
 * (computed by `activate` at deploy; `active: false` keeps serving the
 * refusal worker through the same main).
 */
export interface StagedDeployment {
  readonly artifact: CompileArtifact;
  readonly modules: AssembledModules;
  readonly verdict: ActivationVerdict;
  /** Producer-verified finite resources; absent means no static mount. */
  readonly browserAssets?: BrowserAssetsManifest;
}

interface BrowserAssetsManifest {
  readonly version: 1;
  readonly module: "./http-assets.js";
  readonly resourcesSha256: string;
  readonly resources: readonly {
    readonly key: string;
    readonly contentType: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
}

/** P-C `buildProductionDeps(env)` result: `{ store, identityStore }`. */
export interface ProductionDeps {
  /** Explicit trusted host configuration; no production default limiter or mail binding. */
  readonly auth?: HttpAuthConfiguration;
  readonly store: StoragePort;
  readonly identityStore: unknown;
  readonly preferences?: PagePreferenceStore;
  readonly stateTeam?: StateTeamBinding;
}

/**
 * P-C `buildProductionDeps` (`runtime/env-assembly.ts`): `env` (with
 * `DB`) -> production `{ store, identityStore }`, running the engine
 * schema ensures (T17c: the INTERIM_DDL migrate step was retired).
 */
export type BuildProductionDepsFn = (env: Record<string, unknown>) => Promise<ProductionDeps>;

/** P-C `handleMcpGrant` context: `{ identityStore }`. */
export interface GrantContext {
  readonly identityStore: unknown;
}

/**
 * P-C `handleMcpGrant` (`runtime/grant-route.ts`): production
 * grant-issuance route behind `POST /mcp/grants`.
 */
export type HandleMcpGrantFn = (req: Request, ctx: GrantContext) => Response | Promise<Response>;

/**
 * P-C `createMemberMcpPermissions` (`runtime/mcp-permissions.ts`):
 * artifact -> member permissions (active team members admitted on known
 * operations, everything else denied).
 */
export type CreateMemberMcpPermissionsFn = (artifact: CompileArtifact) => McpPermissions;

/** `assembleWorker` (`worker/assembly.ts:1150`). */
export type AssembleWorkerFn = (
  artifact: CompileArtifact,
  asm: AssembledModules,
  deps: AssemblyDeps,
  verdict: ActivationVerdict,
) => Promise<AssembledWorker>;

/** `createWorkerApp` (`worker/entry.ts:20`). */
export type CreateWorkerAppFn = (options: WorkerAppOptions) => WorkerApp;

/** Serving fetch: workerd `(request, env)` shape. */
export type WorkerFetch = (request: Request, env: Record<string, unknown>) => Promise<Response>;
export type WorkerScheduled = (controller: { readonly scheduledTime: number; readonly cron: string },
  env: Record<string, unknown>, context: { waitUntil(task: Promise<unknown>): void }) => Promise<void>;
export interface MainHandlers { readonly fetch: WorkerFetch; readonly scheduled: WorkerScheduled }
export type CreateCohortTickFn = (input: { readonly artifact: CompileArtifact; readonly asm: AssembledModules;
  readonly identities: IdentityStore; readonly ownerStorage: TeamOwnerStorageBoundary;
  readonly scope: WorkScope; readonly now: () => number }) => Promise<CohortTickBinding>;
type CreateOwnerRouterFn = typeof createD1OwnerRouter;
type CreateOwnerStorageFn = typeof import('./assembly.js').createTeamOwnerStorageBoundary;

/**
 * Join loaders. Every field defaults to the production dynamic import;
 * tests inject the joins that have not landed (staged deployment, MCP
 * bundle, production deps, grant route) while keeping the REAL
 * entry/assembly siblings.
 */
export type CreateSourceFormBindingsFn = (key: Uint8Array | string, revision: string) => Promise<SourceFormBindings>;

export interface MainLoaders {
  readonly loadSourceFormBindingsFactory?: () => Promise<CreateSourceFormBindingsFn>;
  readonly loadEntry?: () => Promise<CreateWorkerAppFn>;
  readonly loadAssembleWorker?: () => Promise<AssembleWorkerFn>;
  readonly loadStagedDeployment?: () => Promise<StagedDeployment>;
  readonly loadProductionDeps?: (env: Record<string, unknown>) => Promise<ProductionDeps>;
  /** Resolves `undefined` when `./mcp-handler.js` is absent (-> assembly 501). */
  readonly loadMcpHandlerFactory?: () => Promise<McpHandlerFactory | undefined>;
  /** Resolves `undefined` when `../runtime/grant-route.js` is absent (-> 501). */
  readonly loadGrantHandler?: () => Promise<HandleMcpGrantFn | undefined>;
  /** Resolves `undefined` when `../runtime/mcp-permissions.js` is absent (-> deny-closed). */
  readonly loadMcpPermissions?: () => Promise<CreateMemberMcpPermissionsFn | undefined>;
  /** Resolves `undefined` when `./derived-inputs.js` is absent (-> framing-only catalog). */
  readonly loadDerivedInputs?: () => Promise<BakedDerivedInputs | undefined>;
  /** Resolves `undefined` when `./http-operations.js` is absent (-> assembly 501 on the op route). */
  readonly loadHttpOperationsFactory?: () => Promise<HttpOperationHandlerFactory | undefined>;
  readonly loadHttpAuthJoin?: () => Promise<HttpAuthJoin | undefined>;
  readonly loadHttpPageFactory?: () => Promise<HttpPageHandlerFactory | undefined>;
  readonly loadCohortTickFactory?: () => Promise<CreateCohortTickFn>;
  readonly loadOwnerRouterFactory?: () => Promise<CreateOwnerRouterFn>;
  readonly loadOwnerStorageFactory?: () => Promise<CreateOwnerStorageFn>;
}

/* ------------------------------------------------------------------ */
/* Small shared helpers (mirrors of the assembly.ts originals).       */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** A required join stage failed to load — 500 naming the specifier. */
function joinMissingResponse(err: unknown): Response {
  return jsonResponse({ code: "deploy-join-missing", message: messageOf(err) }, 500);
}

/** The staged deployment loaded but assembly threw — 500 naming the cause. */
function assemblyFailedResponse(message: string): Response {
  return jsonResponse({ code: "worker-assembly-failed", message }, 500);
}

/** `POST /mcp/grants` before the P-C grant join lands — 501 naming it. */
function grantPendingResponse(): Response {
  return jsonResponse(
    {
      code: "deploy-join-pending",
      route: GRANTS_PATH,
      message:
        "grant issuance needs the production grant join (runtime/grant-route.ts handleMcpGrant); " +
        "POST /mcp/grants is not servable until it lands",
    },
    501,
  );
}

/** Marks staged-validation and `assembleWorker` failures for the 500 above. */
class AssemblyFailedError extends Error {}

/* ------------------------------------------------------------------ */
/* Default loaders: the production dynamic imports.                   */
/* ------------------------------------------------------------------ */

const GRANTS_PATH = "/mcp/grants";

/**
 * Sibling specifiers as constants (never inline literals): `tsc` resolves
 * literal `import()` specifiers at check time and the P-B/P-C siblings
 * do not exist yet, while bundlers must ALSO leave these as runtime
 * imports (P-B emits the siblings next to the bundle). Importing via a
 * `string` keeps both honest.
 */
const ENTRY_SPECIFIER: string = "./entry.js";
const ASSEMBLY_SPECIFIER: string = "./assembly.js";
const STAGED_SPECIFIER: string = "./artifact.js";
const MCP_HANDLER_SPECIFIER: string = "./mcp-handler.js";
const HTTP_OPERATIONS_SPECIFIER: string = "./http-operations.js";
const HTTP_ASSETS_SPECIFIER: string = "./http-assets.js";
const ENV_ASSEMBLY_SPECIFIER: string = "../runtime/env-assembly.js";
const GRANT_ROUTE_SPECIFIER: string = "../runtime/grant-route.js";
const MCP_PERMISSIONS_SPECIFIER: string = "../runtime/mcp-permissions.js";
const DERIVED_INPUTS_SPECIFIER: string = "./derived-inputs.js";

/**
 * Mirror of `loadSiblingFn` (`worker/assembly.ts:634`): static
 * `import type` only, so runtime siblings load lazily via dynamic
 * import. Fails loud naming the missing sibling and its packet.
 */
async function loadSiblingFn<T>(specifier: string, file: string, binding: string): Promise<T> {
  let mod: unknown;
  try {
    mod = await import(specifier);
  } catch {
    throw new Error(
      `deploy main: worker sibling ${specifier} (${file}, ${binding}) is not deployed yet; the worker cannot serve until that packet lands`,
    );
  }
  if (!isRecord(mod) || typeof mod[binding] !== "function") {
    throw new Error(
      `deploy main: worker sibling ${specifier} (${file}) has no function export "${binding}"`,
    );
  }
  return mod[binding] as T;
}

async function defaultLoadCohortTickFactory(): Promise<CreateCohortTickFn> {
  return loadSiblingFn('../runtime/cohort-tick.js', 'runtime/cohort-tick.ts', 'createBoundCohortTick');
}

async function defaultLoadOwnerRouterFactory(): Promise<CreateOwnerRouterFn> {
  return loadSiblingFn('@canlang/state/storage/owner-router', 'state/storage/owner-router.ts', 'createD1OwnerRouter');
}

async function defaultLoadOwnerStorageFactory(): Promise<CreateOwnerStorageFn> {
  return loadSiblingFn('./assembly.js', 'worker/assembly.ts', 'createTeamOwnerStorageBoundary');
}

async function defaultLoadEntry(): Promise<CreateWorkerAppFn> {
  return loadSiblingFn<CreateWorkerAppFn>(ENTRY_SPECIFIER, "worker/entry.ts", "createWorkerApp");
}

async function defaultLoadAssembleWorker(): Promise<AssembleWorkerFn> {
  return loadSiblingFn<AssembleWorkerFn>(ASSEMBLY_SPECIFIER, "worker/assembly.ts", "assembleWorker");
}

async function defaultLoadStagedDeployment(): Promise<StagedDeployment> {
  let mod: unknown;
  try {
    mod = await import(STAGED_SPECIFIER);
  } catch {
    throw new Error(
      "deploy main: worker sibling ./artifact.js (P-B staged deployment: artifact, modules, verdict) " +
        "is not deployed yet; the worker cannot serve until the deploy bundler stages it",
    );
  }
  if (!isRecord(mod)) {
    throw new Error("deploy main: worker sibling ./artifact.js imported a non-module namespace");
  }
  return {
    artifact: mod["artifact"] as CompileArtifact,
    modules: mod["modules"] as AssembledModules,
    verdict: mod["verdict"] as ActivationVerdict,
    ...(Object.hasOwn(mod, "browserAssets") ? { browserAssets: mod["browserAssets"] as BrowserAssetsManifest } : {}),
  };
}

async function defaultLoadProductionDeps(env: Record<string, unknown>): Promise<ProductionDeps> {
  const build = await loadSiblingFn<BuildProductionDepsFn>(
    ENV_ASSEMBLY_SPECIFIER,
    "runtime/env-assembly.ts",
    "buildProductionDeps",
  );
  return build(env);
}

async function loadBrowserAssetsHandler(
  manifest: BrowserAssetsManifest,
  pages: readonly PageDescriptor[],
): Promise<BrowserAssetsHandler> {
  let mod: unknown;
  try {
    mod = await import(HTTP_ASSETS_SPECIFIER);
  } catch {
    throw new Error("deploy main: selected browser assets module is missing or failed to import");
  }
  if (!isRecord(mod) || typeof mod["createHandler"] !== "function") {
    throw new Error("deploy main: selected browser assets module has no createHandler function");
  }
  const handler: unknown = await (mod["createHandler"] as (
    pages: readonly PageDescriptor[], manifest: BrowserAssetsManifest,
  ) => Promise<BrowserAssetsHandler>)(pages, manifest);
  if (!isRecord(handler) || typeof handler["fetch"] !== "function" || !Array.isArray(handler["paths"]) ||
      JSON.stringify(handler["paths"]) !== JSON.stringify(manifest.resources.map((row) => `/assets/${row.key}`))) {
    throw new Error("deploy main: selected browser assets handler has invalid canonical paths or fetch");
  }
  return handler as unknown as BrowserAssetsHandler;
}

async function defaultLoadMcpHandlerFactory(): Promise<McpHandlerFactory | undefined> {
  let mod: unknown;
  try {
    mod = await import(MCP_HANDLER_SPECIFIER);
  } catch {
    // Absent bundle: main passes no factory and /mcp answers assembly's
    // own interim 501 naming the join, exactly as today.
    return undefined;
  }
  if (!isRecord(mod)) {
    throw new Error("deploy main: worker sibling ./mcp-handler.js imported a non-module namespace");
  }
  const factory: unknown = mod["createHandler"] ?? mod["default"];
  if (typeof factory !== "function") {
    throw new Error(
      'deploy main: worker sibling ./mcp-handler.js (P-B MCP bundle) has no function export "createHandler" (or default)',
    );
  }
  return factory as McpHandlerFactory;
}

async function defaultLoadGrantHandler(): Promise<HandleMcpGrantFn | undefined> {
  let mod: unknown;
  try {
    mod = await import(GRANT_ROUTE_SPECIFIER);
  } catch {
    // Absent join (P-C in flight): POST /mcp/grants answers 501 naming it.
    return undefined;
  }
  if (!isRecord(mod)) {
    throw new Error(
      "deploy main: worker sibling ../runtime/grant-route.js imported a non-module namespace",
    );
  }
  const handler: unknown = mod["handleMcpGrant"];
  if (typeof handler !== "function") {
    throw new Error(
      'deploy main: worker sibling ../runtime/grant-route.js has no function export "handleMcpGrant"',
    );
  }
  return handler as HandleMcpGrantFn;
}

async function defaultLoadMcpPermissions(): Promise<CreateMemberMcpPermissionsFn | undefined> {
  let mod: unknown;
  try {
    mod = await import(MCP_PERMISSIONS_SPECIFIER);
  } catch {
    // Absent join: assembly falls back to the deny-closed interim
    // (safe empty discovery; the with-DB boot test pins the staged file).
    return undefined;
  }
  if (!isRecord(mod)) {
    throw new Error(
      "deploy main: worker sibling ../runtime/mcp-permissions.js imported a non-module namespace",
    );
  }
  const factory: unknown = mod["createMemberMcpPermissions"];
  if (typeof factory !== "function") {
    throw new Error(
      'deploy main: worker sibling ../runtime/mcp-permissions.js has no function export "createMemberMcpPermissions"',
    );
  }
  return factory as CreateMemberMcpPermissionsFn;
}

async function defaultLoadHttpOperationsFactory(): Promise<HttpOperationHandlerFactory | undefined> {
  let mod: unknown;
  try {
    mod = await import(HTTP_OPERATIONS_SPECIFIER);
  } catch {
    // Absent bundle: main passes no factory and `/api/operations/*`
    // keeps assembly's own interim 501 naming the join.
    return undefined;
  }
  if (!isRecord(mod)) {
    throw new Error(
      "deploy main: worker sibling ./http-operations.js imported a non-module namespace",
    );
  }
  const chain: unknown = mod["handleOperationRequest"] ?? mod["default"];
  if (typeof chain !== "function") {
    throw new Error(
      'deploy main: worker sibling ./http-operations.js has no function export "handleOperationRequest"',
    );
  }
  // Join-contract curry (arity adaptation only, identical behavior):
  // the bundle stays a pure re-export so no entry-path comment leaks
  // the tmpdir (bundle determinism); this stable source does the rest.
  const handle = chain as (deps: unknown, req: Request, op: string) => Promise<Response>;
  return Object.assign(((deps) => (req, op) => handle(deps, req, op)) as HttpOperationHandlerFactory,
    typeof mod['INPUT_CHOICES_VERSION'] === 'number' ? { inputChoicesVersion: mod['INPUT_CHOICES_VERSION'] } : {});
}

async function defaultLoadSourceFormBindingsFactory(): Promise<CreateSourceFormBindingsFn> {
  return loadSiblingFn<CreateSourceFormBindingsFn>(
    HTTP_OPERATIONS_SPECIFIER, "interfaces/http/operations", "createSourceFormBindings",
  );
}

/** Source provenance only; the defining service hashes this stable revision. */
function sourceFormRevision(artifact: CompileArtifact): string {
  return JSON.stringify({
    artifact_version: artifact.artifact_version,
    language_version: artifact.language_version,
    sources: artifact.sources.map(({ path, sha256 }) => ({ path, sha256 }))
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0),
  });
}

async function defaultLoadHttpAuthJoin(): Promise<HttpAuthJoin | undefined> {
  let mod: unknown;
  try { mod = await import(HTTP_OPERATIONS_SPECIFIER); }
  catch { return undefined; }
  if (!isRecord(mod) || typeof mod['handleAuthRequest'] !== 'function' ||
      typeof mod['SESSION_EXPIRES_MS'] !== 'number') {
    throw new Error('deploy main: worker sibling ./http-operations.js lacks owning auth handler/session lifetime');
  }
  const handle = mod['handleAuthRequest'] as (deps: unknown, request: Request) => Promise<Response>;
  return { createHandler: deps => request => handle(deps, request), sessionExpiresMs: mod['SESSION_EXPIRES_MS'] };
}

async function defaultLoadHttpPageFactory(): Promise<HttpPageHandlerFactory | undefined> {
  let mod: unknown;
  try { mod = await import(HTTP_OPERATIONS_SPECIFIER); }
  catch { return undefined; }
  if (!isRecord(mod) || typeof mod["handlePageRequest"] !== "function") {
    throw new Error('deploy main: worker sibling ./http-operations.js has no function export "handlePageRequest"');
  }
  const handle = mod["handlePageRequest"] as (deps: unknown, request: Request) => Promise<Response>;
  return deps => request => handle(deps, request);
}

async function defaultLoadDerivedInputs(): Promise<BakedDerivedInputs | undefined> {
  let mod: unknown;
  try {
    mod = await import(DERIVED_INPUTS_SPECIFIER);
  } catch {
    // Absent bake: the catalog serves framing shapes only (E1
    // legacy; bound checking stays off on the MCP path).
    return undefined;
  }
  if (!isRecord(mod)) {
    throw new Error(
      "deploy main: worker sibling ./derived-inputs.js imported a non-module namespace",
    );
  }
  const baked: unknown = mod["derivedInputs"];
  if (!isRecord(baked)) {
    throw new Error(
      'deploy main: worker sibling ./derived-inputs.js has no object export "derivedInputs"',
    );
  }
  return baked as BakedDerivedInputs;
}

/**
 * Fail-fast shape check on the staged deployment (production `./artifact.js`
 * or an injected loader — garbage fails loud either way, naming the bad
 * export). `assembleWorker` still owns the deep compat check.
 */
function validateStagedDeployment(staged: StagedDeployment): void {
  if (!isRecord(staged)) {
    throw new AssemblyFailedError("deploy main: staged deployment (./artifact.js) is not an object");
  }
  const artifact: unknown = staged.artifact;
  if (!isRecord(artifact) || !Array.isArray(artifact["pages"]) || !Array.isArray(artifact["callables"])) {
    throw new AssemblyFailedError(
      'deploy main: staged deployment (./artifact.js) export "artifact" is not a CompileArtifact (needs pages[] and callables[])',
    );
  }
  const modules: unknown = staged.modules;
  if (!isRecord(modules) || !isRecord(modules["moduleUrls"])) {
    throw new AssemblyFailedError(
      'deploy main: staged deployment (./artifact.js) export "modules" is not an AssembledModules map (needs moduleUrls)',
    );
  }
  const verdict: unknown = staged.verdict;
  if (!isRecord(verdict) || typeof verdict["active"] !== "boolean") {
    throw new AssemblyFailedError(
      'deploy main: staged deployment (./artifact.js) export "verdict" is not an ActivationVerdict (needs boolean "active")',
    );
  }
  if (Object.hasOwn(staged, "browserAssets")) {
    const marker: unknown = staged.browserAssets;
    const keys = ["browser/bootstrap.js", "browser/can-style.css", "browser/polling.js"];
    const digest = (value: unknown): boolean => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    if (!isRecord(marker) || Object.keys(marker).sort().join(",") !== "module,resources,resourcesSha256,version" ||
        marker["version"] !== 1 || marker["module"] !== HTTP_ASSETS_SPECIFIER ||
        !digest(marker["resourcesSha256"]) || !Array.isArray(marker["resources"]) || marker["resources"].length !== 3) {
      throw new AssemblyFailedError("deploy main: invalid selected browser assets marker");
    }
    for (const [index, row] of marker["resources"].entries()) {
      if (!isRecord(row) || Object.keys(row).sort().join(",") !== "bytes,contentType,key,sha256" ||
          row["key"] !== keys[index] || row["contentType"] !== (keys[index]?.endsWith(".css") ? "text/css" : "application/javascript") ||
          !Number.isSafeInteger(row["bytes"]) || (row["bytes"] as number) < 0 || !digest(row["sha256"])) {
        throw new AssemblyFailedError("deploy main: invalid selected browser resource entry");
      }
    }
  }
}

/**
 * Memoize a loader promise, evicting rejections so the next request
 * retries instead of pinning a failure for the isolate's lifetime.
 */
function memoize<T>(run: () => Promise<T>): () => Promise<T> {
  let current: Promise<T> | null = null;
  return () => {
    if (current === null) {
      const tracked: Promise<T> = run().then(
        (value) => value,
        (err: unknown) => {
          if (current === tracked) current = null;
          throw err;
        },
      );
      current = tracked;
    }
    return current;
  };
}

function keyedPromise<K extends object, T>(
  cache: WeakMap<K, Promise<T>>,
  key: K,
  run: (key: K) => Promise<T>,
): Promise<T> {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const tracked = run(key).then(
    (value) => value,
    (err: unknown) => {
      if (cache.get(key) === tracked) cache.delete(key);
      throw err;
    },
  );
  cache.set(key, tracked);
  return tracked;
}

/**
 * Build the serving fetch: binding gate outermost, `POST /mcp/grants`
 * routed to the grant join, everything else delegated to the assembled
 * worker. Assembly is cached per `env` object (the production isolate
 * reuses one `env`, so it assembles once); loader failures evict so a
 * later request retries.
 */
export function createMainHandlers(loaders: MainLoaders = {}): MainHandlers {
  const loadEntry = loaders.loadEntry ?? defaultLoadEntry;
  const loadCohortTick = loaders.loadCohortTickFactory ?? defaultLoadCohortTickFactory;
  const loadOwnerRouter = loaders.loadOwnerRouterFactory ?? defaultLoadOwnerRouterFactory;
  const loadOwnerStorage = loaders.loadOwnerStorageFactory ?? defaultLoadOwnerStorageFactory;
  const loadAssemble = loaders.loadAssembleWorker ?? defaultLoadAssembleWorker;
  const loadStaged = loaders.loadStagedDeployment ?? defaultLoadStagedDeployment;
  const loadProdDeps = loaders.loadProductionDeps ?? defaultLoadProductionDeps;
  const loadMcp = loaders.loadMcpHandlerFactory ?? defaultLoadMcpHandlerFactory;
  const loadGrant = loaders.loadGrantHandler ?? defaultLoadGrantHandler;
  const loadPerms = loaders.loadMcpPermissions ?? defaultLoadMcpPermissions;
  const loadDerived = loaders.loadDerivedInputs ?? defaultLoadDerivedInputs;
  const loadHttpOps = loaders.loadHttpOperationsFactory ?? defaultLoadHttpOperationsFactory;
  const loadHttpAuth = loaders.loadHttpAuthJoin ?? defaultLoadHttpAuthJoin;
  const loadHttpPages = loaders.loadHttpPageFactory ?? defaultLoadHttpPageFactory;
  const loadFormBindings = loaders.loadSourceFormBindingsFactory ?? defaultLoadSourceFormBindingsFactory;

  const prodDepsByEnv = new WeakMap<object, Promise<ProductionDeps>>();
  const workerByEnv = new WeakMap<object, Promise<AssembledWorker>>();

  const getApp = memoize(async (): Promise<WorkerApp> => {
    const createWorkerApp = await loadEntry();
    return createWorkerApp({ requiredBindings: REQUIRED_BINDINGS, fetch: innerFetch });
  });
  const getStaged = memoize(() => loadStaged());
  const getMcpFactory = memoize(() => loadMcp());
  const getGrantHandler = memoize(() => loadGrant());
  const getPermsFactory = memoize(() => loadPerms());
  const getDerivedInputs = memoize(() => loadDerived());
  const getHttpOpsFactory = memoize(() => loadHttpOps());
  const getHttpAuthJoin = memoize(() => loadHttpAuth());
  const getHttpPageFactory = memoize(() => loadHttpPages());
  const getFormBindingsFactory = memoize(() => loadFormBindings());
  const getAssemble = memoize(() => loadAssemble());
  const getCohortTickFactory = memoize(() => loadCohortTick());
  const getOwnerRouterFactory = memoize(() => loadOwnerRouter());
  const getOwnerStorageFactory = memoize(() => loadOwnerStorage());

  function prodDepsFor(env: Record<string, unknown>): Promise<ProductionDeps> {
    return keyedPromise(prodDepsByEnv, env, loadProdDeps);
  }

  async function buildWorker(env: Record<string, unknown>): Promise<AssembledWorker> {
    // Staged deployment first: no store is constructed (no DDL migrate)
    // for a deploy whose payload never staged.
    const staged = await getStaged();
    validateStagedDeployment(staged);
    let formBindings: SourceFormBindings | undefined;
    if (env["CAN_FORM_BINDING_KEY"] !== undefined) {
      const key = env["CAN_FORM_BINDING_KEY"];
      if (typeof key !== "string" && !(key instanceof Uint8Array)) {
        throw new Error("deploy main: CAN_FORM_BINDING_KEY must be a 32-byte key or its canonical base64url encoding");
      }
      const createFormBindings = await getFormBindingsFactory();
      try { formBindings = await createFormBindings(key, sourceFormRevision(staged.artifact)); }
      catch { throw new Error("deploy main: invalid CAN_FORM_BINDING_KEY configuration"); }
    }
    const deps = await prodDepsFor(env);
    const factory = await getMcpFactory();
    const httpFactory = await getHttpOpsFactory();
    const pageFactory = await getHttpPageFactory();
    const authJoin = await getHttpAuthJoin();
    const permFactory = factory === undefined ? undefined : await getPermsFactory();
    const derivedInputs =
      factory === undefined && httpFactory === undefined && pageFactory === undefined ? undefined : await getDerivedInputs();
    const assembleWorker = await getAssemble();
    const browserAssets = staged.browserAssets;
    const cohortRequirement = staged.artifact.requires.find(requirement => requirement.capability === 'state.cohorts');
    if (cohortRequirement !== undefined && cohortRequirement.min_version !== 1) {
      throw new Error('deploy main: installed cohort tick requires exact state.cohorts version 1');
    }
    if (staged.verdict.active && cohortRequirement !== undefined && deps.stateTeam === undefined) {
      throw new Error('deploy main: installed cohort tick requires explicit CAN_STATE_OWNER and separate STATE_DB');
    }
    let ownerStorage: TeamOwnerStorageBoundary | undefined;
    let scope: WorkScope | undefined;
    if (deps.stateTeam !== undefined) {
      const selected = Object.freeze({ ...deps.stateTeam });
      const entry: unknown = await import(staged.modules.entryUrl);
      const definition = isRecord(entry) ? entry['appDefinition'] : undefined;
      if (!isRecord(definition) || typeof definition['id'] !== 'string' || definition['id'] === '' ||
          !isRecord(definition['packages']) || !Object.hasOwn(definition['packages'], definition['id'])) {
        throw new Error('deploy main: selected State requires its actual declared app and owning package');
      }
      const app = definition['id'];
      const createRouter = await getOwnerRouterFactory();
      const router = createRouter({ resolveBinding: requested => requested.app === app && requested.owner === selected.owner
        ? { app, owner: selected.owner, db: selected.db,
            ...(selected.initializeFresh === true ? { initializeFresh: true } : {}) }
        : null });
      ownerStorage = await (await getOwnerStorageFactory())({ artifact: staged.artifact, asm: staged.modules,
        app, identities: deps.identityStore as IdentityStore, router });
      scope = { app, owner: selected.owner, ownerPackage: app };
    }
    const needsTick = cohortRequirement !== undefined || staged.artifact.callables.some(callable => callable.kind === 'handler');
    const cohorts = staged.verdict.active && needsTick && ownerStorage !== undefined && scope !== undefined
      ? await (await getCohortTickFactory())({ artifact: staged.artifact, asm: staged.modules,
          identities: deps.identityStore as IdentityStore, ownerStorage, scope, now: Date.now })
      : undefined;
    const assemblyDeps: AssemblyDeps = {
      store: deps.store,
      identityStore: deps.identityStore,
      ...(ownerStorage === undefined ? {} : { ownerStorage }),
      ...(cohorts === undefined ? {} : { cohorts }),
      ...(factory === undefined
        ? null
        : {
            mcp: {
              createHandler: factory,
              ...(permFactory === undefined
                ? null
                : { permissions: permFactory(staged.artifact) }),
              ...(derivedInputs === undefined ? null : { derivedInputs }),
            },
          }),
      ...(httpFactory === undefined && pageFactory === undefined && authJoin === undefined && browserAssets === undefined
        ? null
        : {
            http: {
              ...(deps.auth === undefined ? {} : { auth: deps.auth }),
              ...(deps.preferences === undefined ? {} : { preferences: deps.preferences }),
              ...(authJoin === undefined ? {} : { authHandler: authJoin }),
              ...(formBindings === undefined ? {} : { formBindings }),
              ...(httpFactory === undefined ? {} : { createOperationHandler: httpFactory }),
              ...(pageFactory === undefined ? {} : { createPageHandler: pageFactory }),
              ...(derivedInputs === undefined ? null : { derivedInputs }),
              ...(browserAssets === undefined ? {} : {
                loadBrowserAssets: (pages: readonly PageDescriptor[]) => loadBrowserAssetsHandler(browserAssets, pages),
              }),
            },
          }),
    };
    try {
      return await assembleWorker(staged.artifact, staged.modules, assemblyDeps, staged.verdict);
    } catch (err) {
      throw new AssemblyFailedError(`deploy main: assembleWorker threw (${messageOf(err)})`);
    }
  }

  function workerFor(env: Record<string, unknown>): Promise<AssembledWorker> {
    return keyedPromise(workerByEnv, env, buildWorker);
  }

  async function grantsResponse(req: Request, env: Record<string, unknown>): Promise<Response> {
    let deps: ProductionDeps;
    try {
      deps = await prodDepsFor(env);
    } catch (err) {
      return joinMissingResponse(err);
    }
    let grant: HandleMcpGrantFn | undefined;
    try {
      grant = await getGrantHandler();
    } catch (err) {
      return joinMissingResponse(err);
    }
    if (grant === undefined) return grantPendingResponse();
    return grant(req, { identityStore: deps.identityStore });
  }

  async function assemblyResponse(req: Request, env: Record<string, unknown>): Promise<Response> {
    let worker: AssembledWorker;
    try {
      worker = await workerFor(env);
    } catch (err) {
      return err instanceof AssemblyFailedError
        ? assemblyFailedResponse(messageOf(err))
        : joinMissingResponse(err);
    }
    return worker.fetch(req);
  }

  async function innerFetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    const url = new URL(request.url);
    if (request.method.toUpperCase() === "POST" && url.pathname === GRANTS_PATH) {
      return grantsResponse(request, env);
    }
    return assemblyResponse(request, env);
  }

  const fetch: WorkerFetch = async (request, env) => {
    const safeEnv: Record<string, unknown> = isRecord(env) ? env : {};
    let app: WorkerApp;
    try {
      app = await getApp();
    } catch (err) {
      return joinMissingResponse(err);
    }
    return app.fetch(request, safeEnv);
  };
  const scheduled: WorkerScheduled = async (_controller, env, context) => {
    const safeEnv: Record<string, unknown> = isRecord(env) ? env : {};
    for (const binding of REQUIRED_BINDINGS) {
      if (safeEnv[binding] === undefined || safeEnv[binding] === null) {
        throw Object.assign(new Error(`Missing required binding ${binding}.`), { code: 'missing-binding', binding });
      }
    }
    const task = (async () => {
      const worker = await workerFor(safeEnv);
      if (worker.tick === undefined) throw new Error('The installed worker has no cohort tick binding.');
      return worker.tick();
    })();
    context.waitUntil(task);
    await task;
  };
  return { fetch, scheduled };
}

/** Existing fetch consumers retain the same API and joins. */
export function createMainFetch(loaders: MainLoaders = {}): WorkerFetch {
  return createMainHandlers(loaders).fetch;
}

/** Deploy main: fetch and the actual scheduled entry share one bound worker. */
const workerMain: MainHandlers = createMainHandlers();

export default workerMain;
