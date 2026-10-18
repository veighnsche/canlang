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
import type { PageCursorCodec, createPageCursorCodec } from '../runtime/page-cursor.js';
import type { StateTeamBinding, StateTeamBindings } from '../runtime/env-assembly.js';
import type { PagePreferenceStore, ExportDownloadStore, caughtToBusinessError, isBusinessThrow, jsonErrorResponse,
  httpStatusFor, logInternalError } from '@canlang/interfaces';
import type { createD1OwnerRouter } from '@canlang/state/storage/owner-router';
import type { AssembledModules } from "../runtime/modules.js";
import type { BakedDerivedInputs } from "../runtime/mcp-registry.js";
import type {
  AssembledWorker,
  CohortTickBinding,
  AssemblyDeps,
  BrowserAssetsHandler,
  HttpOperationHandlerFactory,
  HttpCsvHandlerFactory,
  HttpExportHandlerFactory,
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
 * `docs/implementation/evidence/mcpd-a.md`).
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
  readonly deploymentBase?: string;
  /** Explicit trusted host configuration; no production default limiter or mail binding. */
  readonly auth?: HttpAuthConfiguration;
  readonly store: StoragePort;
  readonly identityStore: unknown;
  readonly preferences?: PagePreferenceStore;
  readonly exportDownloads?: ExportDownloadStore;
  readonly stateTeam?: StateTeamBinding;
  readonly stateTeams?: StateTeamBindings;
  /** Target-owned Files kernel and team boundary share the actual receiving issuer. */
  readonly files?: AssemblyDeps["files"];
  readonly ownerStorage?: TeamOwnerStorageBoundary;
}

/**
 * P-C `buildProductionDeps` (`runtime/env-assembly.ts`): `env` (with
 * `DB`) -> production `{ store, identityStore }`, running the engine
 * schema ensures (T17c: the INTERIM_DDL migrate step was retired).
 */
export type BuildProductionDepsFn = (env: Record<string, unknown>, composition?: { readonly store: StoragePort | 'unavailable' }) => Promise<ProductionDeps>;

/** P-C `handleMcpGrant` context: `{ identityStore }`. */
export interface GrantContext {
  readonly identityStore: unknown;
  readonly authOrigin?: string;
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
export type WorkerFetch = (request: Request, env: Record<string, unknown>, context?: { waitUntil(task: Promise<unknown>): void }) => Promise<Response>;
export type WorkerScheduled = (controller: { readonly scheduledTime: number; readonly cron: string },
  env: Record<string, unknown>, context: { waitUntil(task: Promise<unknown>): void }) => Promise<void>;
export interface MainHandlers { readonly fetch: WorkerFetch; readonly scheduled: WorkerScheduled;
  readonly queue: (batch: import('../runtime/resource-host.js').ResourceBatch, env: Record<string, unknown>, context: { waitUntil(task: Promise<unknown>): void }) => Promise<void>;
}
export type CreateCohortTickFn = (input: { readonly artifact: CompileArtifact; readonly asm: AssembledModules;
  readonly identities: IdentityStore; readonly ownerStorage: TeamOwnerStorageBoundary;
  readonly scope: WorkScope; readonly now: () => number }) => Promise<CohortTickBinding>;
// This worker configuration selects ordinary StoragePort routes. The trusted
// Node File host separately consumes the authority-preserving generic ports.
type CreateOwnerRouterFn = (input: Parameters<typeof createD1OwnerRouter>[0]) => ReturnType<typeof createD1OwnerRouter>;
type CreateOwnerStorageFn = (input: Parameters<typeof import('./assembly.js').createTeamOwnerStorageBoundary>[0]) => Promise<TeamOwnerStorageBoundary>;

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
  /** Absent bundle or CSV export retains assembly's unavailable CSV join. */
  readonly loadHttpCsvFactory?: () => Promise<HttpCsvHandlerFactory | undefined>;
  readonly loadHttpExportFactory?: () => Promise<HttpExportHandlerFactory | undefined>;
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

async function defaultLoadProductionDeps(env: Record<string, unknown>, composition?: { readonly store: StoragePort | 'unavailable' }): Promise<ProductionDeps> {
  const build = await loadSiblingFn<BuildProductionDepsFn>(
    ENV_ASSEMBLY_SPECIFIER,
    "runtime/env-assembly.ts",
    "buildProductionDeps",
  );
  return build(env, composition);
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
      JSON.stringify(handler["paths"]) !== JSON.stringify(manifest.resources.map((row) => `/assets/${row.key.split("/").map(part => encodeURIComponent(part).replace(/[!'()*]/g, character => "%" + character.charCodeAt(0).toString(16).toUpperCase())).join("/")}`))) {
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

async function defaultLoadHttpCsvFactory(): Promise<HttpCsvHandlerFactory | undefined> {
  let mod: unknown;
  try { mod = await import(HTTP_OPERATIONS_SPECIFIER); }
  catch { return undefined; }
  if (!isRecord(mod)) {
    throw new Error('deploy main: worker sibling ./http-operations.js imported a non-module namespace');
  }
  if (!Object.hasOwn(mod, 'handleCsvRequest')) return undefined;
  const handle = mod['handleCsvRequest'];
  if (typeof handle !== 'function') {
    throw new Error('deploy main: worker sibling ./http-operations.js has no function export "handleCsvRequest"');
  }
  const chain = handle as (deps: unknown, request: Request) => Promise<Response>;
  return deps => request => chain(deps, request);
}

async function defaultLoadHttpExportFactory(): Promise<HttpExportHandlerFactory | undefined> {
  let mod: unknown;
  try { mod = await import(HTTP_OPERATIONS_SPECIFIER); }
  catch { return undefined; }
  if (!isRecord(mod)) throw new Error('deploy main: HTTP sibling imported a non-module namespace');
  if (!Object.hasOwn(mod, 'handleExportRequest')) return undefined;
  const handle = mod['handleExportRequest'];
  if (typeof handle !== 'function') throw new Error('deploy main: HTTP sibling has no function export "handleExportRequest"');
  const chain = handle as (deps: unknown, request: Request) => Promise<Response>;
  return deps => request => chain(deps, request);
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
  if (!isRecord(mod)) {
    throw new Error('deploy main: worker sibling ./http-operations.js imported a non-module namespace');
  }
  for (const name of ['handlePageRequest', 'handlePagePreferencePost', 'caughtToBusinessError',
    'isBusinessThrow', 'jsonErrorResponse', 'httpStatusFor', 'logInternalError']) {
    if (typeof mod[name] !== 'function') {
      throw new Error(`deploy main: worker sibling ./http-operations.js has no function export "${name}"`);
    }
  }
  const handle = mod["handlePageRequest"] as (deps: unknown, request: Request) => Promise<Response>;
  const post = mod['handlePagePreferencePost'] as typeof handle;
  const caught = mod['caughtToBusinessError'] as typeof caughtToBusinessError;
  const business = mod['isBusinessThrow'] as typeof isBusinessThrow;
  const errorResponse = mod['jsonErrorResponse'] as typeof jsonErrorResponse;
  const statusFor = mod['httpStatusFor'] as typeof httpStatusFor;
  const logInternal = mod['logInternalError'] as typeof logInternalError;
  return deps => async request => {
    if (request.method.toUpperCase() !== 'POST') return handle(deps, request);
    try { return await post(deps, request); }
    catch (err) {
      // Preference POST uses the same owning refusal projection as the
      // Interfaces router; GET/HEAD retain the page handler's own mapping.
      const error = caught(err);
      if (!business(err)) logInternal(deps.logger, err, {
        method: request.method, path: new URL(request.url).pathname,
      });
      return errorResponse(error, statusFor(error.code));
    }
  };
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
  if (Object.hasOwn(staged, "browserAssets")) validateSelectedBrowserAssets(staged.browserAssets);
}

/** Exact canonical shared resources plus the existing optional development leaf. */
function selectedBrowserResourceKeys(resources: unknown[]): string[] {
  const keys = ["browser/bootstrap.js", "browser/can-style.css", "browser/polling.js"];
  if (resources.some(row => isRecord(row) && row["key"] === "development/update-client.js")) {
    keys.push("development/update-client.js");
  }
  return keys;
}
function resourceDigest(value: unknown): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function validateSelectedBrowserResource(row: unknown, key: string | undefined): void {
  if (!isRecord(row) || Object.keys(row).sort().join(",") !== "bytes,contentType,key,sha256" ||
      row["key"] !== key || row["contentType"] !== (key?.endsWith(".css") ? "text/css" : "application/javascript") ||
      !Number.isSafeInteger(row["bytes"]) || (row["bytes"] as number) < 0 || !resourceDigest(row["sha256"])) {
    throw new AssemblyFailedError("deploy main: invalid selected browser resource entry");
  }
}
function validateSelectedBrowserAssets(marker: unknown): void {
  if (!isRecord(marker) || Object.keys(marker).sort().join(",") !== "module,resources,resourcesSha256,version" ||
      marker["version"] !== 1 || marker["module"] !== HTTP_ASSETS_SPECIFIER ||
      !resourceDigest(marker["resourcesSha256"]) || !Array.isArray(marker["resources"])) {
    throw new AssemblyFailedError("deploy main: invalid selected browser assets marker");
  }
  const keys = selectedBrowserResourceKeys(marker["resources"]);
  if (marker["resources"].length !== keys.length) {
    throw new AssemblyFailedError("deploy main: invalid selected browser assets marker");
  }
  for (const [index, row] of marker["resources"].entries()) validateSelectedBrowserResource(row, keys[index]);
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
  const loadHttpCsv = loaders.loadHttpCsvFactory ?? defaultLoadHttpCsvFactory;
  const loadHttpExport = loaders.loadHttpExportFactory ?? defaultLoadHttpExportFactory;
  const loadHttpAuth = loaders.loadHttpAuthJoin ?? defaultLoadHttpAuthJoin;
  const loadHttpPages = loaders.loadHttpPageFactory ?? defaultLoadHttpPageFactory;
  const loadFormBindings = loaders.loadSourceFormBindingsFactory ?? defaultLoadSourceFormBindingsFactory;

  const prodDepsByEnv = new WeakMap<object, Promise<ProductionDeps>>();
  const workerByEnv = new WeakMap<object, Promise<AssembledWorker>>();
  const originalRequests = new WeakMap<object, Request>();
  const resourceHostsByEnv = new WeakMap<object, readonly Awaited<ReturnType<typeof import('../runtime/resource-host.js').createResourceHost>>[]>();

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
  const getHttpCsvFactory = memoize(() => loadHttpCsv());
  const getHttpExportFactory = memoize(() => loadHttpExport());
  const getHttpAuthJoin = memoize(() => loadHttpAuth());
  const getHttpPageFactory = memoize(() => loadHttpPages());
  const getFormBindingsFactory = memoize(() => loadFormBindings());
  const getAssemble = memoize(() => loadAssemble());
  const getCohortTickFactory = memoize(() => loadCohortTick());
  const getOwnerRouterFactory = memoize(() => loadOwnerRouter());
  const getOwnerStorageFactory = memoize(() => loadOwnerStorage());

  function prodDepsFor(env: Record<string, unknown>): Promise<ProductionDeps> {
    return keyedPromise(prodDepsByEnv, env, async (selected: Record<string, unknown>) => {
      const staged = await getStaged();
      if (!staged.artifact.runtimeBindings?.some(binding => binding.kind === 'durable-object')) return loadProdDeps(selected);
      const { rootExecutionForEnv } = await import('../runtime/root-authority.js');
      const execution = rootExecutionForEnv(selected);
      const rootedModels = new Set(staged.artifact.runtimeBindings.filter(binding => binding.kind === 'durable-object').map(binding => binding.key));
      const models = new Map((staged.artifact.models ?? []).map(model => [model.name, model]));
      const allRooted = [...models.values()].every(model => {
        let current: typeof model | undefined = model;
        const seen = new Set<string>();
        while (current !== undefined && !seen.has(current.name)) {
          seen.add(current.name); if (rootedModels.has(current.name)) return true;
          current = current.parent === undefined ? undefined : models.get(current.parent);
        }
        return false;
      });
      return loadProdDeps(selected, execution === undefined ? allRooted ? { store: 'unavailable' } : undefined : { store: execution.store });
    });
  }

  async function buildWorker(env: Record<string, unknown>): Promise<AssembledWorker> {
    // Staged deployment first: no store is constructed (no DDL migrate)
    // for a deploy whose payload never staged.
    const staged = await getStaged();
    validateStagedDeployment(staged);
    async function loadFormBindingsForEnv(): Promise<SourceFormBindings | undefined> {
      if (env["CAN_FORM_BINDING_KEY"] === undefined) return undefined;
      const key = env["CAN_FORM_BINDING_KEY"];
      if (typeof key !== "string" && !(key instanceof Uint8Array)) {
        throw new Error("deploy main: CAN_FORM_BINDING_KEY must be a 32-byte key or its canonical base64url encoding");
      }
      const createFormBindings = await getFormBindingsFactory();
      try { return await createFormBindings(key, sourceFormRevision(staged.artifact)); }
      catch { throw new Error("deploy main: invalid CAN_FORM_BINDING_KEY configuration"); }
    }
    const formBindings = await loadFormBindingsForEnv();
    const deps = await prodDepsFor(env);
    const deploymentBase = deps.deploymentBase;
    const factory = await getMcpFactory();
    const httpFactory = await getHttpOpsFactory();
    const csvFactory = await getHttpCsvFactory();
    const exportFactory = await getHttpExportFactory();
    const pageFactory = await getHttpPageFactory();
    const authJoin = await getHttpAuthJoin();
    const permFactory = factory === undefined ? undefined : await getPermsFactory();
    async function loadDerivedInputsIfNeeded() {
      if (factory === undefined && httpFactory === undefined && csvFactory === undefined && exportFactory === undefined && pageFactory === undefined) return undefined;
      return getDerivedInputs();
    }
    const derivedInputs = await loadDerivedInputsIfNeeded();
    const assembleWorker = await getAssemble();
    const browserAssets = staged.browserAssets;
    const cohortRequirement = staged.artifact.requires.find(requirement => requirement.capability === 'state.cohorts');
    if (cohortRequirement !== undefined && cohortRequirement.min_version !== 1) {
      throw new Error('deploy main: installed cohort tick requires exact state.cohorts version 1');
    }
    async function verifyStateScope(cohort: unknown): Promise<void> {
      if (deps.stateTeam !== undefined && deps.stateTeams !== undefined) {
        throw new Error('deploy main: selected State has both legacy and multi-owner routes');
      }
      if (deps.stateTeams !== undefined) {
        if (cohort !== undefined) {
          throw new Error('deploy main: multi-owner State does not support cohort or scheduled handler scope');
        }
        const handlers = staged.artifact.callables.filter(callable => callable.kind === 'handler');
        if (handlers.length > 0) {
          // Checked CRUD hooks run inside the selected original owner mutation.
          // They do not require a separately selected scheduled/cohort scope.
          const check = await loadSiblingFn<typeof import('../runtime/invoke.js').nativeHandlersUseOwnerMutationScope>(
            '../runtime/invoke.js', 'runtime/invoke.ts', 'nativeHandlersUseOwnerMutationScope');
          const ownerHooks = await check(staged.modules, staged.artifact);
          if (!ownerHooks) throw new Error('deploy main: multi-owner State does not support cohort or scheduled handler scope');
        }
      }
      if (staged.verdict.active && cohort !== undefined && deps.stateTeam === undefined) {
        throw new Error('deploy main: installed cohort tick requires explicit CAN_STATE_OWNER and separate STATE_DB');
      }
    }
    await verifyStateScope(cohortRequirement);
    let ownerStorage: TeamOwnerStorageBoundary | undefined = deps.ownerStorage;
    let pageReads: AssemblyDeps['pageReads'];
    let scope: WorkScope | undefined;
    const rootHost = staged.artifact.runtimeBindings?.some(binding => binding.kind === 'durable-object') ?? false;
    const rootRuntime = rootHost ? await import('../runtime/root-authority.js') : undefined;
    const rootExecution = rootRuntime?.rootExecutionForEnv(env);
    if (rootExecution === undefined && rootRuntime !== undefined && !Object.isFrozen(deps.store)) rootRuntime.rejectRootModelsInD1(deps.store, staged.artifact);
    let rootBoundary: AssemblyDeps['rootBoundary'];
    async function configureRootBoundary(): Promise<void> {
      if (!rootHost) return;
      const entry: unknown = await import(staged.modules.entryUrl);
      const definition = isRecord(entry) ? entry['appDefinition'] : undefined;
      if (!isRecord(definition) || typeof definition['id'] !== 'string') throw new Error('Root authority requires its actual declared app.');
      const original = originalRequests.get(env);
      const helper = await import('../runtime/root-authority-http.js');
      if (original !== undefined) rootBoundary = helper.createRootOperationBoundary({ artifact: staged.artifact, app: definition['id'], request: original, env });
      if (rootExecution !== undefined) {
        const execution = rootExecution;
        ownerStorage = Object.freeze({ app: definition['id'],
          async forIdentity(identity: import('@canlang/contracts').ResolvedIdentity) {
            const current = helper.rootIdentity(definition['id'] as string, identity);
            if (current.app !== execution.scope.app || current.owner !== execution.scope.owner || current.principal !== execution.scope.principal) throw new Error('Root identity differs from its authenticated owner.');
            return execution.store;
          },
          async forTrustedScope() { throw new Error('Root scheduled work requires its retained owning invocation.'); },
        });
      }
    }
    await configureRootBoundary();
    async function configureStateTeamScope(): Promise<void> {
      if (rootExecution !== undefined || (deps.stateTeam === undefined && deps.stateTeams === undefined)) return;
      const selected = deps.stateTeam;
      const routes = deps.stateTeams ?? (selected === undefined ? [] : [selected]);
      if (routes.length === 0 || routes.length > 16 || new Set(routes.map(route => route.owner)).size !== routes.length ||
          new Set(routes.map(route => route.db)).size !== routes.length) {
        throw new Error('deploy main: selected State requires distinct nonempty owner routes');
      }
      const entry: unknown = await import(staged.modules.entryUrl);
      const definition = isRecord(entry) ? entry['appDefinition'] : undefined;
      if (!isRecord(definition) || typeof definition['id'] !== 'string' || definition['id'] === '' ||
          !isRecord(definition['packages']) || !Object.hasOwn(definition['packages'], definition['id'])) {
        throw new Error('deploy main: selected State requires its actual declared app and owning package');
      }
      const app = definition['id'];
      const declaredAppOwners = definition['runtimeBindingOwners'];
      const createRouter = await getOwnerRouterFactory();
      const byOwner = new Map(routes.map(route => [route.owner, Object.freeze({ ...route })]));
      const router = createRouter({ resolveBinding: requested => {
        if (requested.app !== app) return null;
        const route = byOwner.get(requested.owner);
        return route === undefined ? null : { app, owner: route.owner, db: route.db,
          ...(route.initializeFresh === true ? { initializeFresh: true } : {}) };
      } });
      ownerStorage ??= await (await getOwnerStorageFactory())({ artifact: staged.artifact, asm: staged.modules,
        app, identities: deps.identityStore as IdentityStore, router });
      async function installStateTeamFileStack(storage: TeamOwnerStorageBoundary): Promise<void> {
        if ((staged.artifact.runtimeBindings?.length ?? 0) === 0) return;
        const [{ d1FileAuthority, runtimeFileReferenceProducers }, { installNativeFileInventory }] = await Promise.all([
          import('../runtime/d1-file-inventory.js'), import('../runtime/file-inventory.js'),
        ]);
        const hasFiles = staged.artifact.runtimeBindings?.some(binding => binding.kind === 'r2' && binding.owner === app);
        const fileStoreId = deps.files?.fileStoreId ?? (hasFiles ? await (await import('../runtime/r2-files.js')).resolveR2FileStoreIdentity({
          db: env['DB'] as import('@cloudflare/workers-types').D1Database,
          bucket: env['FILES'] as import('@cloudflare/workers-types').R2Bucket, namespace: `${app}/FILES`,
        }) : `no-files:${app}`);
        const authorities = new Map<string, import('@canlang/contracts').FileRetirementAuthority>();
        for (const route of routes) {
          // Pin/verify the configured physical team before installing any declaration metadata.
          await storage.forTrustedScope({ app, owner: route.owner, ownerPackage: app }, Date.now());
          authorities.set(route.owner, await d1FileAuthority(route.db, { app, owner: route.owner, ownerPackage: app }, fileStoreId));
        }
        const fileRouter = createRouter({ resolveBinding: requested => {
          if (requested.app !== app) return null;
          const route = byOwner.get(requested.owner), authority = authorities.get(requested.owner);
          return route === undefined || authority === undefined ? null : { app, owner: route.owner, db: route.db,
            fileRetirementAuthority: authority, fileReferenceProducers: runtimeFileReferenceProducers };
        } });
        ownerStorage = await (await getOwnerStorageFactory())({ artifact: staged.artifact, asm: staged.modules,
          app, identities: deps.identityStore as IdentityStore, router: fileRouter });
        const declaredOwners = declaredAppOwners;
        const inventoryOwners = Array.isArray(declaredOwners) ? declaredOwners.filter((owner): owner is string => typeof owner === 'string') : [app];
        for (const route of routes) {
          const boundary = ownerStorage;
          const physical = (await boundary.forTrustedScope({ app, owner: route.owner, ownerPackage: app }, Date.now())).store;
          for (const ownerPackage of inventoryOwners) await installNativeFileInventory({ artifact: staged.artifact, asm: staged.modules,
            scope: { app, owner: route.owner, ownerPackage },
            store: physical as import('@canlang/contracts').FileReferenceStoragePort,
            authority: authorities.get(route.owner)!, now: Date.now,
            verifyOwner: async () => { await boundary.forTrustedScope({ app, owner: route.owner, ownerPackage }, Date.now()); },
          });
        }
      }
      await installStateTeamFileStack(ownerStorage);
      async function configureStateTeamReads(): Promise<void> {
        let cursors: PageCursorCodec | undefined;
        if (env['CAN_FORM_BINDING_KEY'] !== undefined) {
          const createCodec = await loadSiblingFn<typeof createPageCursorCodec>(
            '../runtime/page-cursor.js', 'runtime/page-cursor.ts', 'createPageCursorCodec');
          // The existing codec owns its distinct cryptographic protocol domain.
          cursors = await createCodec(env['CAN_FORM_BINDING_KEY'] as Uint8Array | string);
        }
        const sourceIdentity = sourceFormRevision(staged.artifact);
        pageReads = identity => {
          const owner = identity.team?.team_id;
          if (owner === undefined || !byOwner.has(owner)) {
            throw { code: 'forbidden', message: 'Page storage binding is unavailable.', retryable: false };
          }
          return Object.freeze({ scope: Object.freeze({ app, owner, ownerPackage: app }), sourceIdentity,
            ...(cursors === undefined ? {} : { cursors }) });
        };
        if (selected !== undefined) scope = { app, owner: selected.owner, ownerPackage: app };
      }
      await configureStateTeamReads();
    }
    await configureStateTeamScope();
    let hostStore = rootExecution?.store ?? deps.store;
    const hasDefaultD1Models = (staged.artifact.models ?? []).some(model => rootRuntime?.modelUsesRoot(staged.artifact, model.name) !== true);
    async function loadDefaultD1App(): Promise<{ app: string; owners: unknown } | undefined> {
      if (staged.artifact.models?.length === 0 && (staged.artifact.operations?.length ?? 0) !== 0 && ownerStorage === undefined &&
          (staged.artifact.runtimeBindings?.length ?? 0) !== 0) {
        throw new Error('Model-free resource applications require an explicitly configured team State owner; global owner routing is unsupported.');
      }
      if (rootExecution !== undefined || ownerStorage !== undefined || (rootHost && !hasDefaultD1Models) || (staged.artifact.runtimeBindings?.length ?? 0) === 0) return undefined;
      const entry: unknown = await import(staged.modules.entryUrl);
      const definition = isRecord(entry) ? entry['appDefinition'] : undefined;
      if (!isRecord(definition) || typeof definition['id'] !== 'string') throw new Error('State declarations require their actual app.');
      return { app: definition['id'], owners: definition['runtimeBindingOwners'] };
    }
    async function configureDefaultD1Store(): Promise<void> {
      const loaded = await loadDefaultD1App();
      if (loaded === undefined) return;
      const { app, owners } = loaded;
      const [{ d1FileAuthority, runtimeFileReferenceProducers }, { installNativeFileInventory }, { createD1Storage }] = await Promise.all([
        import('../runtime/d1-file-inventory.js'), import('../runtime/file-inventory.js'), import('@canlang/state/storage/d1'),
      ]);
      const db = env['DB'] as import('@cloudflare/workers-types').D1Database;
      const fileStoreId = staged.artifact.runtimeBindings?.some(binding => binding.kind === 'r2' && binding.owner === app)
        ? await (await import('../runtime/r2-files.js')).resolveR2FileStoreIdentity({ db,
            bucket: env['FILES'] as import('@cloudflare/workers-types').R2Bucket, namespace: `${app}/FILES` }) : `no-files:${app}`;
      const selectedScope = { app, owner: 'app', ownerPackage: app };
      const authority = await d1FileAuthority(db, selectedScope, fileStoreId);
      const physical = createD1Storage(db, authority, runtimeFileReferenceProducers);
      if (rootRuntime !== undefined) rootRuntime.rejectRootModelsInD1(physical, staged.artifact);
      for (const ownerPackage of Array.isArray(owners) ? owners as string[] : [app]) await installNativeFileInventory({
        artifact: staged.artifact, asm: staged.modules, scope: { ...selectedScope, ownerPackage },
        store: physical, authority, now: Date.now, verifyOwner: async () => {
          if (env['DB'] !== db) throw new Error('Configured app State binding changed.');
        },
      });
      hostStore = physical;
    }
    await configureDefaultD1Store();
    async function loadWorkerFilesForEnv() {
      if (deps.files !== undefined) return deps.files;
      if (env['CAN_LOCAL_FILES'] !== true) return undefined;
      return (await import('../runtime/worker-files.js')).createWorkerFiles({
        artifact: staged.artifact, asm: staged.modules, env,
        store: hostStore, identities: deps.identityStore as IdentityStore,
        ...(ownerStorage === undefined ? {} : { ownerStorage }),
        origin: deploymentBase ?? (() => { throw new Error('Local Files require the selected preview origin.'); })(),
        intentTtlMs: 60 * 60 * 1000,
        retention: { unattachedHorizonMs: 24 * 60 * 60 * 1000, retentionMs: 24 * 60 * 60 * 1000, retainAttached: true },
        localLoopback: true,
      });
    }
    const files = await loadWorkerFilesForEnv();
    async function loadCohortTickers() {
      const queueHandlers = new Set((staged.artifact.runtimeBindings ?? []).flatMap(binding => binding.kind === 'queue' ? binding.handlers : []));
      const needsTick = cohortRequirement !== undefined || staged.artifact.callables.some(callable => callable.kind === 'handler' && !queueHandlers.has(callable.id));
      if (!staged.verdict.active || !needsTick || ownerStorage === undefined || scope === undefined) return undefined;
      return (await getCohortTickFactory())({ artifact: staged.artifact, asm: staged.modules,
        identities: deps.identityStore as IdentityStore, ownerStorage, scope, now: Date.now,
        ...(files?.canonical === undefined ? {} : { files: files.canonical }),
        ...(deploymentBase === undefined ? {} : { deploymentBase }) });
    }
    const cohorts = await loadCohortTickers();
    async function configureResourceHosts(): Promise<Awaited<ReturnType<typeof import('../runtime/resource-host.js').createResourceHost>>[]> {
      const resourceBindings = (staged.artifact.runtimeBindings ?? []).filter(binding => binding.kind === 'queue' || binding.kind === 'analytics-engine');
      const resourceHosts: Awaited<ReturnType<typeof import('../runtime/resource-host.js').createResourceHost>>[] = [];
      if (resourceBindings.length === 0) return resourceHosts;
      const { createResourceHost } = await import('../runtime/resource-host.js');
      const entry: unknown = await import(staged.modules.entryUrl);
      const definition = isRecord(entry) ? entry['appDefinition'] : undefined;
      if (!isRecord(definition) || typeof definition['id'] !== 'string') throw new Error('Resources require the actual declared app.');
      const app = definition['id'];
      const routes = deps.stateTeams ?? (deps.stateTeam === undefined ? [] : [deps.stateTeam]);
      // Root actors recover retained work through their own alarm/system-owner composition.
      if (rootExecution === undefined && ownerStorage !== undefined && routes.length !== 0) {
        for (const route of routes) {
          const selectedScope = { app, owner: route.owner, ownerPackage: app };
          const selected = await ownerStorage.forTrustedScope(selectedScope, Date.now());
          resourceHosts.push(await createResourceHost({ artifact: staged.artifact, asm: staged.modules, env,
            store: selected.store, identities: deps.identityStore as IdentityStore, scope: selectedScope,
            ...(files?.canonical === undefined ? {} : { files: files.canonical }) }));
        }
      } else if (rootExecution === undefined && (!rootHost || hasDefaultD1Models)) {
        resourceHosts.push(await createResourceHost({ artifact: staged.artifact, asm: staged.modules, env,
          store: hostStore, identities: deps.identityStore as IdentityStore, scope: { app, owner: 'app', ownerPackage: app },
          ...(files?.canonical === undefined ? {} : { files: files.canonical }) }));
      }
      return resourceHosts;
    }
    const resourceHosts = await configureResourceHosts();
    resourceHostsByEnv.set(env, resourceHosts);
    function buildMcpSection() {
      if (factory === undefined) return null;
      return {
        mcp: {
          createHandler: factory,
          ...(permFactory === undefined
            ? null
            : { permissions: permFactory(staged.artifact) }),
          ...(derivedInputs === undefined ? null : { derivedInputs }),
        },
      };
    }
    function buildHttpSection() {
      if (httpFactory === undefined && csvFactory === undefined && exportFactory === undefined && pageFactory === undefined && authJoin === undefined && browserAssets === undefined) return null;
      return {
        http: {
          ...(deps.auth === undefined ? {} : { auth: deps.auth }),
          ...(deps.preferences === undefined ? {} : { preferences: deps.preferences }),
          ...(deps.exportDownloads === undefined ? {} : { exportDownloads: deps.exportDownloads }),
          ...(authJoin === undefined ? {} : { authHandler: authJoin }),
          ...(formBindings === undefined ? {} : { formBindings }),
          ...(httpFactory === undefined ? {} : { createOperationHandler: httpFactory }),
          ...(csvFactory === undefined ? {} : { createCsvHandler: csvFactory }),
          ...(exportFactory === undefined ? {} : { createExportHandler: exportFactory }),
          ...(pageFactory === undefined ? {} : { createPageHandler: pageFactory }),
          ...(derivedInputs === undefined ? null : { derivedInputs }),
          ...(browserAssets === undefined ? {} : {
            loadBrowserAssets: (pages: readonly PageDescriptor[]) => loadBrowserAssetsHandler(browserAssets, pages),
          }),
        },
      };
    }
    function buildAssemblyDeps(): AssemblyDeps {
      return {
        ...(files === undefined ? {} : { files }),
        ...(deploymentBase === undefined ? {} : { deploymentBase }),
        store: hostStore,
        ...(rootBoundary === undefined ? {} : { rootBoundary }),
        ...(staged.artifact.runtimeBindings === undefined ? {} : { runtimeBindings: 1 as const }),
        ...(rootExecution === undefined ? {} : { allocateRecordId: rootExecution.allocateId }),
        identityStore: deps.identityStore,
        ...(ownerStorage === undefined ? {} : { ownerStorage }),
        ...(pageReads === undefined ? {} : { pageReads }),
        ...(cohorts === undefined ? {} : { cohorts }),
        ...(buildMcpSection()),
        ...(buildHttpSection()),
      };
    }
    const assemblyDeps: AssemblyDeps = buildAssemblyDeps();
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
    const staged = await getStaged();
    validateStagedDeployment(staged);
    if (!staged.verdict.active) {
      return jsonResponse({ code: "activation-refused", reasons: staged.verdict.reasons }, 503);
    }
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
    return grant(req, { identityStore: deps.identityStore,
      ...(deps.auth === undefined ? {} : { authOrigin: deps.auth.origin }) });
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
    if (url.pathname.startsWith('/files/read/') || url.pathname.startsWith('/files/preview/')) {
      const staged = await getStaged();
      if (staged.verdict.active && staged.artifact.runtimeBindings?.some(binding => binding.kind === 'durable-object')) {
        await prodDepsFor(env);
        const entry: unknown = await import(staged.modules.entryUrl);
        const definition = isRecord(entry) ? entry['appDefinition'] : undefined;
        if (!isRecord(definition) || typeof definition['id'] !== 'string') throw new Error('Protected root Files require the actual declared app.');
        const { routeRootFileRequest } = await import('../runtime/root-authority-http.js');
        const response = await routeRootFileRequest({ artifact: staged.artifact, app: definition['id'], request, env });
        if (response !== null) return response;
      }
    }
    return assemblyResponse(request, env);
  }

  const fetch: WorkerFetch = async (request, env, context) => {
    let safeEnv: Record<string, unknown> = isRecord(env) ? env : {};
    let app: WorkerApp;
    try {
      const staged = await getStaged();
      if (staged.artifact.runtimeBindings?.some(binding => binding.kind === 'durable-object')) {
        const { rootExecutionForEnv } = await import('../runtime/root-authority.js');
        if (rootExecutionForEnv(safeEnv) === undefined) safeEnv = { ...safeEnv };
        originalRequests.set(safeEnv, request.clone());
      }
      app = await getApp();
    } catch (err) {
      return joinMissingResponse(err);
    }
    const response = await app.fetch(request, safeEnv);
    const hosts = resourceHostsByEnv.get(safeEnv) ?? [];
    const task = Promise.all(hosts.map(host => host.drain()));
    if (context !== undefined) context.waitUntil(task);
    else await task;
    return response;
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
      const hosts = resourceHostsByEnv.get(safeEnv) ?? [];
      if (worker.tick === undefined && hosts.length === 0) {
        const staged = await getStaged();
        if (!staged.artifact.runtimeBindings?.some(binding => binding.kind === 'durable-object')) throw new Error('The installed worker has no background work binding.');
      }
      if (worker.tick !== undefined) await worker.tick();
      for (const host of hosts) await host.drain();
    })();
    context.waitUntil(task);
    await task;
  };
  const queue: MainHandlers['queue'] = async (batch, env, context) => {
    await workerFor(env);
    const hosts = resourceHostsByEnv.get(env) ?? [];
    const task = (async () => {
      for (const message of batch.messages) {
        const body = message.body;
        const selected = isRecord(body) ? hosts.find(host => host.scope.app === body['app'] && host.scope.owner === body['owner'] &&
          JSON.stringify(host.locator) === JSON.stringify(body['locator'])) : undefined;
        if (selected === undefined && isRecord(body) && isRecord(body['locator'])) {
          const locator = body['locator'];
          const staged = await getStaged();
          const binding = staged.artifact.runtimeBindings?.find(binding => binding.kind === 'durable-object' && binding.binding === locator['binding']);
          const { rootIdOfRecord } = await import('../runtime/root-authority.js');
          if (binding === undefined || typeof locator['rootId'] !== 'string' || rootIdOfRecord(locator['rootId']) !== locator['rootId'] ||
              typeof body['eventId'] !== 'string' || typeof body['source'] !== 'string') throw new Error('Queue root locator is invalid.');
          const namespace = env[binding.binding] as import('@cloudflare/workers-types').DurableObjectNamespace | undefined;
          if (namespace === undefined) throw new Error('Queue root namespace is unavailable.');
          const response = await namespace.get(namespace.idFromName(locator['rootId'])).fetch('http://can-root.internal/resources', {
            method: 'POST', headers: { 'content-type': 'application/x-can-root-resources+json' },
            body: JSON.stringify({ eventId: body['eventId'], binding: body['source'].replace(/\.publish$/, ''), rootId: locator['rootId'] }),
          });
          if (!response.ok || (await response.json() as { completed?: boolean }).completed !== true) message.retry();
          else message.ack();
          continue;
        }
        if (selected === undefined) throw new Error('Queue message has no configured physical owner.');
        await selected.consume({ queue: batch.queue, messages: [message] });
      }
    })();
    context.waitUntil(task);
    await task;
  };
  return { fetch, scheduled, queue };
}

/** Existing fetch consumers retain the same API and joins. */
export function createMainFetch(loaders: MainLoaders = {}): WorkerFetch {
  return createMainHandlers(loaders).fetch;
}

/** Deploy main: fetch and the actual scheduled entry share one bound worker. */
const workerMain: MainHandlers = createMainHandlers();

export default workerMain;

/** The only production actor export; executes the same original HTTP/MCP main. */
export class CanRootAuthority {
  private readonly actor: Promise<{ fetch(request: Request): Promise<Response>; alarm(): Promise<void> }>;
  constructor(state: import('@cloudflare/workers-types').DurableObjectState, env: Record<string, unknown>) {
    this.actor = (async () => {
      const staged = await defaultLoadStagedDeployment();
      validateStagedDeployment(staged);
      if (!staged.verdict.active) throw new Error('Root authority activation was refused.');
      const entry: unknown = await import(staged.modules.entryUrl);
      const definition = isRecord(entry) ? entry['appDefinition'] : undefined;
      if (!isRecord(definition) || typeof definition['id'] !== 'string') throw new Error('Root authority requires its actual declared app.');
      const app = definition['id'];
      const inventoryOwners: unknown = Object.getOwnPropertyDescriptor(definition, 'runtimeBindingOwners')?.value;
      if (!Array.isArray(inventoryOwners) || inventoryOwners.length === 0 || inventoryOwners.some(owner => typeof owner !== 'string' || owner === '') ||
          !inventoryOwners.includes(app) || new Set(inventoryOwners).size !== inventoryOwners.length) throw new Error('Root authority requires its actual selected declaration owners.');
      const [{ createRootAuthorityClass, createRootRecordAllocator }, { authenticateRootRequest }, { createD1RootDirectory }] = await Promise.all([
        import('../runtime/root-authority.js'), import('../runtime/root-authority-http.js'), import('../runtime/root-authority-directory.js'),
      ]);
      const [{ runtimeFileReferenceProducers }, { installNativeFileInventory }, { createD1IdentityStore }] = await Promise.all([
        import('../runtime/d1-file-inventory.js'), import('../runtime/file-inventory.js'), import('@canlang/identity'),
      ]);
      const fileStoreId = staged.artifact.runtimeBindings?.some(binding => binding.kind === 'r2' && binding.implicit)
        ? await (await import('../runtime/r2-files.js')).resolveR2FileStoreIdentity({
            db: env.DB as import('@cloudflare/workers-types').D1Database,
            bucket: env.FILES as import('@cloudflare/workers-types').R2Bucket, namespace: `${app}/FILES`,
          }) : `no-files:${app}`;
      const { parseBoundFileReadRequest } = await import('../runtime/bound-files.js');
      const Actor = createRootAuthorityClass({ artifact: staged.artifact,
        locateFile: parseBoundFileReadRequest,
        fileReferences: {
          producers: runtimeFileReferenceProducers,
          authority(_selected, scope, stateId) { return { app: scope.app, stateOwner: scope.app,
            stateStoreId: `do:${stateId}`, fileStoreId,
            receiver: { app: scope.app, team: scope.owner, owner: scope.owner } }; },
          async prepare(selected, store, scope) {
            const identities = createD1IdentityStore(selected.DB as import('@cloudflare/workers-types').D1Database);
            for (const ownerPackage of inventoryOwners as string[]) await installNativeFileInventory({ artifact: staged.artifact, asm: staged.modules, store,
              authority: store.fileRetirementAuthority, scope: { app: scope.app, owner: scope.owner, ownerPackage }, now: Date.now,
              async verifyOwner() { if ((await identities.findTeamById(scope.owner))?.team_id !== scope.owner) throw new Error('Root declaration inventory requires its current actual Identity owner.'); },
            });
          },
        },
        authenticate: (request, selected) => authenticateRootRequest(request, selected, app),
        execute: (request, selected) => workerMain.fetch(request, selected),
        directory: selected => createD1RootDirectory(selected.DB as import('@cloudflare/workers-types').D1Database),
        async recover(selected, store, scope, event) {
          const [{ createResourceHost }, { createD1IdentityStore, resolveIdentity }] = await Promise.all([
            import('../runtime/resource-host.js'), import('@canlang/identity'),
          ]);
          const identities = createD1IdentityStore(selected.DB as import('@cloudflare/workers-types').D1Database);
          const current = await resolveIdentity(identities, { team_id: scope.owner });
          if (current.actor !== null || current.team?.team_id !== scope.owner) throw new Error('Root recovery requires its current actual Identity owner.');
          const files = selected.CAN_LOCAL_FILES === true ? await (await import('../runtime/worker-files.js')).createWorkerFiles({
            artifact: staged.artifact, asm: staged.modules, env: selected, store, identities,
            origin: typeof selected.CAN_DEPLOYMENT_BASE === 'string' ? selected.CAN_DEPLOYMENT_BASE : (() => { throw new Error('Root Files require their actual deployment origin.'); })(),
            intentTtlMs: 3_600_000, retention: { unattachedHorizonMs: 86_400_000, retentionMs: 86_400_000, retainAttached: true }, localLoopback: true,
          }) : undefined;
          const host = await createResourceHost({ artifact: staged.artifact, asm: staged.modules, env: selected, store, identities,
            ...(files?.canonical === undefined ? {} : { files: files.canonical }),
            scope: { app: scope.app, owner: scope.owner, ownerPackage: scope.app }, locator: { binding: scope.binding, rootId: scope.rootId },
            createRecordAllocator: (operation, operationId) => createRootRecordAllocator(staged.artifact, scope,
              { operation, operation_id: operationId, inputs: {} }),
          });
          const consumed = event === undefined ? undefined : await host.consumeEvent(event.binding, event.eventId);
          await host.drain();
          return { pending: await host.pending(), ...(consumed === undefined ? {} : { completed: consumed.status === 'completed' }) };
        },
      });
      return new Actor(state, env);
    })();
  }
  async fetch(request: Request): Promise<Response> { return (await this.actor).fetch(request); }
  async alarm(): Promise<void> { return (await this.actor).alarm(); }
}
