/**
 * B1 worker assembly: `CompileArtifact` + assembled modules -> serving worker.
 *
 * Owns the artifact join: compat validation, page-descriptor loading from the
 * assembled module URLs (fail loud on the first bad descriptor, naming page +
 * module), the `OperationInvoker` callable bridge, and the worker-entry
 * wiring. The entry wiring delegates to the REAL `createWorkerApp`
 * (`./entry.js`, loaded via dynamic import) exactly the way `entry.ts` wires
 * it (`{ requiredBindings, fetch }`); this module never re-implements it.
 *
 * Worker-boundary compliant: static `import type` only (this package's
 * `@canlang/contracts` dependency); every runtime module — page modules,
 * `./entry.js`, the `runtime/` siblings — loads via dynamic `import()`.
 *
 * INTERIM dispatch: `@canlang/interfaces` (the real `createHttpHandler` +
 * sub-handlers) is not a dependency of this package, so page GETs run
 * through a minimal interim dispatcher below (anonymous identity, the real
 * descriptor `admit`/`render`, no shell, exact paths only). The interfaces
 * join replaces it. Mutations/auth are 501 until that join. `/files/*`
 * routes match explicitly (a documented mirror of the uploads routes):
 * unknown paths/methods are `not_found`, and known routes are 501 naming
 * the exact unmet seam (files binding vs identity join) — never fake
 * bytes. Nothing here may be mistaken for the production dispatcher.
 *
 * P2 MCP route: `POST /mcp` IS served (not interim-501) once
 * `AssemblyDeps.mcp.createHandler` is supplied — the real
 * `createMcpHandler`, injected by the deploy join exactly as tests inject
 * it from interfaces dist. The assembly builds the REAL `McpDeps`
 * (registry + catalog from the artifact via `runtime/mcp-registry.ts`,
 * the SAME `buildInvoker` bridge HTTP will use, grant identity from
 * `deps.identityStore`) and delegates the request. Permissions default
 * to the deny-closed interim adapter (join J2 pending) unless
 * `AssemblyDeps.mcp.permissions` is supplied. Without the factory,
 * `/mcp` answers the explicit interim 501 naming the join.
 */

import type {
  ActivationVerdict,
  AdmittedBindings,
  ArtifactPage,
  BusinessError,
  BusinessErrorCode,
  CompileArtifact,
  ContentCheck,
  FinalizeResult,
  FinalizedFile,
  MutationEnvelope,
  MutationResult,
  PageDescriptor,
  PresentationContext,
  ReadEnvelope,
  ReadResult,
  ResolvedIdentity,
  RowQueryRunner,
  StoragePort,
  ThemeTokens,
  UploadIntentGrant,
  UploadIntentRequest,
} from "@canlang/contracts";
import type { AssembledModules } from "../runtime/modules.js";
import type { CallerInfo, HandlerContext } from "../runtime/context.js";
import type {
  McpPermissions,
  OperationRegistry,
  SchemaCatalog,
} from "../runtime/mcp-registry.js";

/* ------------------------------------------------------------------ */
/* Structural mirrors. Each cites the verified owner; the named join   */
/* replaces the mirror with the real import. No invented type names.   */
/* ------------------------------------------------------------------ */

/**
 * Real `AssembledModules` (`src/runtime/modules.ts`; joined at B1
 * integration). Re-exported so worker consumers keep one import site.
 */
export type { AssembledModules };

/**
 * Mirror of `AppInfo` (`packages/interfaces/src/ports.ts:66`). Replaced by
 * the real import at the interfaces join.
 */
export interface AppInfo {
  readonly appId: string;
  readonly brand: string;
  readonly appDefaultLocale: string;
  readonly ownerLabels: ReadonlyMap<string, string>;
}

/**
 * Mirror of `PageRegistry` (`packages/interfaces/src/ports.ts:76`).
 * Replaced by the real import at the interfaces join.
 */
export interface PageRegistry {
  descriptors(): readonly PageDescriptor[];
}

/** Mirror of `MutationOutcome` (`packages/interfaces/src/ports.ts:81`). */
export type MutationOutcome = { result: MutationResult } | { error: BusinessError };

/** Mirror of `ReadOutcome` (`packages/interfaces/src/ports.ts:82`). */
export type ReadOutcome = { result: ReadResult } | { error: BusinessError };

/**
 * Mirror of `OperationInvoker` (`packages/interfaces/src/ports.ts:85`).
 * Replaced by the real import at the interfaces join.
 */
export interface OperationInvoker {
  invokeMutation(envelope: MutationEnvelope, identity: ResolvedIdentity): Promise<MutationOutcome>;
  invokeRead(envelope: ReadEnvelope, identity: ResolvedIdentity): Promise<ReadOutcome>;
}

/**
 * Real MCP mirrors (`src/runtime/mcp-registry.ts`; joined at P2). The
 * registry, catalog, and permissions shapes live there as the single
 * source of truth; re-exported so worker consumers keep one import site.
 */
export type { McpPermissions, OperationRegistry, SchemaCatalog };

/** Mirror of `LogLevel` (`packages/interfaces/src/ports.ts:16`). */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Mirror of `Logger` (`packages/interfaces/src/ports.ts:20`). Replaced
 * by the real import at the interfaces join.
 */
export interface Logger {
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
}

/**
 * Mirror of `InterfacesClock` (`packages/interfaces/src/ports.ts:10`;
 * identical to the identity `Clock`). Replaced by the real import at
 * the interfaces join.
 */
export interface InterfacesClock {
  nowMs(): number;
}

/**
 * Mirror of `MailPort` (`packages/identity/src/ports.ts:82`). The MCP
 * path never sends mail; the assembly binds a fail-closed thrower.
 */
export interface MailPort {
  sendMail(to: string, subject: string, body_text: string): Promise<void>;
}

/**
 * Mirror of `IdentityDeps` (`packages/interfaces/src/ports.ts:101`).
 * Replaced by the real import at the interfaces join. One honest
 * widening: `store` is `unknown` (see `AssemblyDeps.identityStore`) —
 * the deploy join binds the real `IdentityStore`.
 */
export interface IdentityDeps {
  readonly store: unknown;
  readonly mail: MailPort;
  readonly clock: InterfacesClock;
  readonly verifyBaseUrl: string;
  readonly recoveryBaseUrl: string;
  readonly inviteBaseUrl: string;
  readonly sessionMaxAgeSeconds: number;
}

/**
 * Mirror of `McpFilesInfo` (`packages/interfaces/src/ports.ts:216`).
 * Replaced by the real import at the interfaces join. The `app`
 * parameters are `unknown` for the same reason as
 * `OperationRegistry.list` (single-app artifact; the real `AppInfo`
 * cannot be named here).
 */
export interface McpFilesInfo {
  usesFiles(app: unknown): boolean;
  intentsUrl(app: unknown): string;
}

/**
 * Mirror of `McpDeps` (`packages/interfaces/src/ports.ts:221`). The P2
 * worker assembly constructs these per `/mcp` request; the interfaces
 * join replaces the mirror with the real import. Widenings are confined
 * to the three documented seams (`identity.store`,
 * app-accepting-but-ignoring `registry`/`files`, and `brand`/
 * `ownerLabels` narrowed to `string` — runtime-safe since
 * `MessageValue = string | …`).
 */
export interface McpDeps {
  readonly app: AppInfo;
  readonly registry: OperationRegistry;
  readonly permissions: McpPermissions;
  readonly invoker: OperationInvoker;
  readonly catalog: SchemaCatalog;
  readonly files: McpFilesInfo;
  readonly identity: IdentityDeps;
  readonly logger: Logger;
  readonly clock: InterfacesClock;
}

/**
 * Mirror of `createMcpHandler`
 * (`packages/interfaces/src/mcp/server.ts:397`): grant-authed MCP
 * handler factory over assembled deps. Injected through
 * `AssemblyDeps.mcp` because `@canlang/interfaces` is not a dependency
 * of this package; the deploy join supplies the real factory (bundled
 * for workerd), exactly as tests supply it from interfaces dist.
 */
export type McpHandlerFactory = (deps: McpDeps) => (request: Request) => Promise<Response>;

/**
 * MCP join inputs. `createHandler` absent -> `/mcp` answers the explicit
 * interim 501 naming the interfaces join. `permissions` absent -> the
 * deny-closed interim adapter (join J2 pending; see
 * `createDenyClosedMcpPermissions`).
 */
export interface McpJoin {
  readonly createHandler?: McpHandlerFactory;
  readonly permissions?: McpPermissions;
}

/**
 * Mirror of `UploadReceiver` (`packages/interfaces/src/ports.ts:259`).
 * Replaced by the real import at the interfaces join.
 */
export interface InterimUploadReceiver {
  readonly app: string;
  readonly team: string;
  readonly owner: string;
  readonly principal: string;
}

/**
 * Mirror of `UploadBinding` (`packages/interfaces/src/ports.ts:272`).
 * Replaced by the real import at the interfaces join.
 */
export interface InterimUploadBinding {
  readonly adapter: string;
  readonly deliveryId: string;
  readonly resultPath: string;
}

/** Mirror of `KernelCreateOutcome` (`packages/interfaces/src/ports.ts:279`). */
export type InterimKernelCreateOutcome =
  | { readonly status: "granted"; readonly grant: UploadIntentGrant; readonly intentId: string }
  | { readonly status: "duplicate"; readonly grant: UploadIntentGrant; readonly intentId: string }
  | { readonly status: "rejected"; readonly reason: "invalid-request" | "conflict" | "oversized" | "unauthorized" };

/** Mirror of `KernelAppendOutcome` (`packages/interfaces/src/ports.ts:285`). */
export type InterimKernelAppendOutcome =
  | { readonly status: "appended"; readonly receivedBytes: number }
  | { readonly status: "failed"; readonly reason: "foreign" | "closed" | "expired" | "oversized" };

/** Mirror of `KernelCompleteOutcome` (`packages/interfaces/src/ports.ts:289`). */
export type InterimKernelCompleteOutcome =
  | { readonly status: "completed"; readonly check: ContentCheck }
  | { readonly status: "failed"; readonly reason: "foreign" | "closed" | "expired" | "partial" | "oversized" }
  | { readonly status: "failed"; readonly reason: "malformed" | "rejected"; readonly check: ContentCheck };

/** Mirror of `KernelFinalizeOutcome` (`packages/interfaces/src/ports.ts:296`). */
export type InterimKernelFinalizeOutcome =
  | { readonly status: "finalized"; readonly result: FinalizeResult; readonly file: FinalizedFile }
  | { readonly status: "repeated"; readonly result: FinalizeResult; readonly file: FinalizedFile }
  | { readonly status: "failed"; readonly reason: "foreign" | "partial" | "conflict" | "expired" };

/**
 * Mirror of `FileKernel` (`packages/interfaces/src/ports.ts:302`): the L4
 * file-kernel entry points behind the lane-06 principal binding.
 * Replaced by the real import at the interfaces join.
 */
export interface InterimFileKernel {
  maxBytes(): number | Promise<number>;
  createIntent(input: {
    request: UploadIntentRequest;
    receiver: InterimUploadReceiver;
    binding: InterimUploadBinding;
  }): Promise<InterimKernelCreateOutcome>;
  append(
    intentId: string,
    caller: InterimUploadReceiver,
    chunk: Uint8Array,
  ): Promise<InterimKernelAppendOutcome>;
  complete(
    intentId: string,
    caller: InterimUploadReceiver,
  ): Promise<InterimKernelCompleteOutcome>;
  finalize(input: {
    intentId: string;
    retryId: string;
    bytesDigest: string;
    caller: InterimUploadReceiver;
  }): Promise<InterimKernelFinalizeOutcome>;
}

/**
 * Interim files binding: `usesFiles` mirrors `FileUseInfo`
 * (`packages/interfaces/src/ports.ts:211`); `kernel` is the interim file
 * kernel above. The interfaces join replaces both with the real
 * `HttpDeps.uploads` bindings. Absent until the files join lands.
 */
export interface InterimFilesBinding {
  readonly usesFiles: boolean;
  readonly kernel: InterimFileKernel;
}

/**
 * Real `HandlerContext` (`src/runtime/context.ts`; joined at B1
 * integration). Re-exported so worker consumers keep one import site.
 */
export type { HandlerContext };

/** Sibling `invokeCallable` outcome (`src/runtime/invoke.ts`; landed). */
interface InvokeOutcome {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: unknown;
}

/**
 * Sibling `invokeCallable(asm, artifact, id, ctx, args?)`
 * (`src/runtime/invoke.ts`; landed). `args` is an ARRAY (spread into
 * `fn(ctx, ...args)`); passing a projection object here throws a
 * TypeError inside invoke and surfaces as a misleading rule_failed.
 */
type InvokeCallable = (
  asm: AssembledModules,
  artifact: CompileArtifact,
  id: string,
  ctx: HandlerContext,
  args?: unknown[],
) => Promise<InvokeOutcome>;

/** Sibling `createContext({ caller, store, memberships? })` (`src/runtime/context.ts`; landed). */
type CreateContext = (input: {
  readonly caller: CallerInfo;
  readonly store: StoragePort;
  readonly memberships?: string[];
}) => HandlerContext | Promise<HandlerContext>;

/** Sibling `createArtifactRegistry(artifact)` (`src/runtime/mcp-registry.ts`; P2). */
type CreateArtifactRegistry = (artifact: CompileArtifact) => OperationRegistry;

/** Sibling `createArtifactCatalog(artifact)` (`src/runtime/mcp-registry.ts`; P2). */
type CreateArtifactCatalog = (artifact: CompileArtifact) => SchemaCatalog;

/** Sibling `createDenyClosedMcpPermissions()` (`src/runtime/mcp-registry.ts`; P2). */
type CreateDenyClosedMcpPermissions = () => McpPermissions;

/* ------------------------------------------------------------------ */
/* Assembly inputs/outputs.                                            */
/* ------------------------------------------------------------------ */

/**
 * Worker assembly dependencies.
 *
 * `store` is the real `StoragePort` (defined in
 * `@canlang/contracts`, `contracts/src/state.ts:357`, re-exported by
 * `@canlang/state`'s index; imported here from contracts because
 * `@canlang/state` is not a declared dependency of this package).
 *
 * `identityStore` is `unknown` on purpose. Verified: neither
 * `createWorkerApp` (takes `WorkerAppOptions { requiredBindings, fetch }`,
 * `src/worker/entry.ts:9`) nor `startLocalDev` (takes `LocalDevOptions`,
 * `src/dev/local-run.ts:12`) takes an identity store, and
 * `@canlang/identity` is not resolvable from this package. The real type at
 * the join is `IdentityStore` (`packages/identity/src/ports.ts:95`), bound
 * as `HttpDeps.identity.store`.
 */
export interface AssemblyDeps {
  store: StoragePort;
  identityStore: unknown;
  now?: () => number;
  /**
   * Interim files binding for `/files/*` dispatch. Absent until the
   * files join lands; while absent, known file routes answer an
   * explicit interim 501 naming the join (never fake bytes).
   */
  files?: InterimFilesBinding;
  /**
   * P2 MCP join inputs. Absent until the interfaces join lands; while
   * absent (or without `createHandler`), `/mcp` answers an explicit
   * interim 501 naming the join.
   */
  mcp?: McpJoin;
}

/** Assembled worker: serving fetch plus registry counts. */
export interface AssembledWorker {
  fetch: (req: Request) => Promise<Response>;
  pageCount: number;
  opCount: number;
}

/* ------------------------------------------------------------------ */
/* INTERIM_DDL (coordinator decision R2: interim path).                 */
/*                                                                     */
/* Derived DDL is impossible today, verified by reading the sources:    */
/* (1) `CompileArtifact` (`contracts/src/artifact.ts:92`) carries NO    */
/* model descriptors — only sources/modules/callables/pages/requires.  */
/* (2) `buildModelTable` (`state/src/mutation/models.ts:174`) builds   */
/* an in-memory INTERIM enforcement table, not SQL.                    */
/* (3) The real engine stores every model in ONE generic `records`     */
/* table (model as a column, domain fields as JSON) created by         */
/* `ensureSchema` (`state/src/storage/d1.ts:53` + `schema.ts`), so     */
/* per-model DDL is not even the engine's shape.                       */
/*                                                                     */
/* Until L1 emits model descriptors, these hand-written statements     */
/* cover EXACTLY the demo models and must not be extended. The         */
/* deploy/migrate packet (D1 owner) applies them; `assembleWorker`     */
/* cannot — `StoragePort` has no DDL surface.                          */
/*                                                                     */
/* What L1 must emit to replace this: per-model table descriptors      */
/* derived from the Given model blocks (model name, columns, column    */
/* types, nullability/defaults, refs, unique keys) plus a DDL renderer */
/* (or versioned migration statements) the B1 assembly can derive      */
/* `CREATE TABLE` from.                                                */
/*                                                                     */
/* Shape: one single-line statement per entry, no trailing semicolon — */
/* the proven `db.exec` shape (`tests/e2e/.../teamtasks.ts:44`).       */
/* ------------------------------------------------------------------ */

/** Todo columns mirror `TEAMTASKS_D1_SCHEMA` verbatim (title/done/assignee). */
const INTERIM_TODO_DDL =
  "CREATE TABLE IF NOT EXISTS todo (id TEXT PRIMARY KEY, title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, assignee TEXT NULL, version INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL)";

/**
 * Note follows the `examples/TeamTasks.can` source (`Note { title, content }`),
 * not Todo's columns: same bookkeeping (id/version/created), own fields.
 */
const INTERIM_NOTE_DDL =
  "CREATE TABLE IF NOT EXISTS note (id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NULL, version INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL)";

export const INTERIM_DDL: readonly string[] = [INTERIM_TODO_DDL, INTERIM_NOTE_DDL];

/* ------------------------------------------------------------------ */
/* Artifact compatibility (artifact.ts v1 contract).                    */
/* ------------------------------------------------------------------ */

/** `ARTIFACT_VERSION` (`contracts/src/artifact.ts:14`) restated: 1. */
const SUPPORTED_ARTIFACT_VERSION = 1;

/** `ArtifactCallable` kinds (`contracts/src/artifact.ts:73`). */
const KNOWN_CALLABLE_KINDS: ReadonlySet<string> = new Set([
  "operation",
  "pure",
  "rule",
  "handler",
  "migration",
]);

function assertArtifactCompatible(artifact: CompileArtifact): void {
  if (artifact.artifact_version !== SUPPORTED_ARTIFACT_VERSION) {
    throw new Error(
      `assembly: unsupported artifact_version ${String(artifact.artifact_version)} (want 1)`,
    );
  }
  for (const callable of artifact.callables) {
    if (!KNOWN_CALLABLE_KINDS.has(callable.kind)) {
      throw new Error(
        `assembly: unknown callable kind ${JSON.stringify(callable.kind)} for ${JSON.stringify(callable.id)}`,
      );
    }
    const member: unknown = callable.member;
    if (
      !Array.isArray(member) ||
      member.length === 0 ||
      !member.every((segment) => typeof segment === "string" && segment.length > 0)
    ) {
      throw new Error(
        `assembly: callable ${JSON.stringify(callable.id)} has no valid member path ` +
          `(non-empty array of non-empty strings into canApp()); ` +
          "recompile with the fixed `can compile`",
      );
    }
  }
  for (const requirement of artifact.requires) {
    if (typeof requirement.capability !== "string" || requirement.capability.length === 0) {
      throw new Error("assembly: requires entry with empty capability");
    }
    if (typeof requirement.min_version !== "number" || !Number.isFinite(requirement.min_version)) {
      throw new Error(
        `assembly: requires entry ${JSON.stringify(requirement.capability)} has non-numeric min_version`,
      );
    }
  }
  // NOTE: no `modules[0]` entrypoint check — entry resolution moved to
  // `AssembledModules.entryUrl`, which is authoritative for module URLs.
}

/* ------------------------------------------------------------------ */
/* Page registry loading (fail loud, naming page + module).            */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assertArtifactPageShape(page: ArtifactPage, index: number): void {
  for (const field of ["owner", "path", "module", "export"] as const) {
    const value: unknown = page[field];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `assembly: artifact page #${index} has empty ${field} (not a usable page reference)`,
      );
    }
  }
}

async function loadPageDescriptor(page: ArtifactPage, asm: AssembledModules): Promise<PageDescriptor> {
  const where = `page "${page.path}" module "${page.module}"`;
  const url: unknown = Object.hasOwn(asm.moduleUrls, page.module)
    ? asm.moduleUrls[page.module]
    : undefined;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(`assembly: ${where} has no assembled module URL`);
  }
  let mod: unknown;
  try {
    mod = await import(url);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`assembly: ${where} failed to import (${reason})`);
  }
  if (!isRecord(mod)) {
    throw new Error(`assembly: ${where} imported a non-module namespace`);
  }
  const candidate: unknown = mod[page.export];
  if (candidate === undefined) {
    throw new Error(`assembly: ${where} has no export "${page.export}"`);
  }
  if (!isRecord(candidate)) {
    throw new Error(`assembly: ${where} export "${page.export}" is not an object`);
  }
  if (candidate["owner"] !== page.owner) {
    throw new Error(
      `assembly: ${where} owner mismatch (artifact ${JSON.stringify(page.owner)}, descriptor ${JSON.stringify(candidate["owner"])})`,
    );
  }
  if (candidate["path"] !== page.path) {
    throw new Error(
      `assembly: ${where} path mismatch (artifact ${JSON.stringify(page.path)}, descriptor ${JSON.stringify(candidate["path"])})`,
    );
  }
  if (typeof candidate["admit"] !== "function" || typeof candidate["render"] !== "function") {
    throw new Error(
      `assembly: ${where} export "${page.export}" is not a page descriptor (admit/render must be functions)`,
    );
  }
  return candidate as unknown as PageDescriptor;
}

async function loadPageRegistry(
  artifact: CompileArtifact,
  asm: AssembledModules,
): Promise<{ registry: PageRegistry; descriptors: readonly PageDescriptor[] }> {
  const descriptors: PageDescriptor[] = [];
  for (const [index, page] of artifact.pages.entries()) {
    assertArtifactPageShape(page, index);
    descriptors.push(await loadPageDescriptor(page, asm));
  }
  const frozen = Object.freeze([...descriptors]);
  return { registry: { descriptors: () => frozen }, descriptors: frozen };
}

/* ------------------------------------------------------------------ */
/* Operation invoker: (id, caller, args) core + envelope adapters.     */
/* ------------------------------------------------------------------ */

/** `BUSINESS_ERROR_CODES` (`contracts/src/wire.ts:102`) restated. */
const KNOWN_BUSINESS_CODES: readonly BusinessErrorCode[] = [
  "validation",
  "forbidden",
  "not_found",
  "conflict",
  "rule_failed",
  "busy",
  "limit",
  "delivery_unknown",
];

/**
 * Mirror of `BUSINESS_ERROR_HTTP_STATUS` (`contracts/src/wire.ts`). Interim:
 * the envelope join replaces this with the real table import.
 */
const INTERIM_STATUS_FOR_CODE: Record<BusinessErrorCode, number> = {
  validation: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rule_failed: 422,
  busy: 503,
  limit: 429,
  delivery_unknown: 502,
};

/**
 * Interim generic rejection text. Intentionally distinct from
 * `PUBLIC_ERROR_MESSAGES` (`interfaces/src/errors/safe.ts:14`) so no test
 * can mistake interim output for the canonical envelope; the envelope join
 * replaces it with the real `fromUnknown`/`buildBusinessError`.
 */
const INTERIM_REJECTION_MESSAGE = "The operation was rejected.";

function isBusinessErrorLike(value: unknown): value is BusinessError {
  if (!isRecord(value)) return false;
  const code: unknown = value["code"];
  const message: unknown = value["message"];
  return (
    typeof code === "string" &&
    (KNOWN_BUSINESS_CODES as readonly string[]).includes(code) &&
    typeof message === "string"
  );
}

/**
 * Normalize a sibling `!ok` error to a `BusinessError`. Business-shaped
 * values pass through (code + message); anything else becomes `rule_failed`,
 * mirroring the `fromUnknown` rule (`interfaces/src/errors/envelope.ts:99`:
 * unexpected failures are `rule_failed`, `retryable: false`, no leak).
 * Interim narrowing: `fields` are dropped until the envelope join.
 */
function toBusinessError(error: unknown, operationId?: string): BusinessError {
  const base: { code: BusinessErrorCode; message: string } = isBusinessErrorLike(error)
    ? { code: error.code, message: error.message }
    : typeof error === "string" && error !== ""
      ? { code: "rule_failed", message: error }
      : error instanceof Error
        ? { code: "rule_failed", message: error.message }
        : { code: "rule_failed", message: INTERIM_REJECTION_MESSAGE };
  if (operationId === undefined || operationId === "") {
    return { ...base, retryable: false };
  }
  // `BusinessError.operation_id` is the wire-plain `OperationId` (an alias
  // for `string`), so no brand cast is needed here.
  return { ...base, operation_id: operationId, retryable: false };
}

async function loadSiblingFn<T>(specifier: string, file: string, binding: string): Promise<T> {
  // Worker-boundary rule: static `import type` only; runtime siblings load
  // lazily via dynamic import, resolved relative to this module's compiled
  // location (`dist/worker/assembly.js`). Fails loud when the sibling is
  // not built.
  let mod: unknown;
  try {
    mod = await import(specifier);
  } catch {
    throw new Error(
      `assembly: worker sibling ${specifier} (${file}, ${binding}) is not assembled yet; operations cannot run until that packet lands`,
    );
  }
  if (!isRecord(mod) || typeof mod[binding] !== "function") {
    throw new Error(
      `assembly: worker sibling ${specifier} (${file}) has no function export "${binding}"`,
    );
  }
  return mod[binding] as T;
}

/**
 * Map a resolved identity onto handler-context caller facts. Explicit,
 * never by accident: a null actor (DESIGN §4 unauthenticated public
 * request) becomes the labeled `"anonymous"` caller with no roles; a
 * present actor contributes its user id; memberships come from the
 * membership's role grants (absent membership = no roles). Guarded
 * operations stay fail-closed for anonymous callers because `hasRole`
 * tests these memberships.
 */
function callerFor(identity: ResolvedIdentity): { caller: CallerInfo; memberships: string[] } {
  const grants = identity.membership?.roles.map((grant) => grant.role) ?? [];
  if (identity.actor === null) {
    return { caller: { userId: "anonymous", roles: [] }, memberships: [] };
  }
  return { caller: { userId: identity.actor.user_id, roles: grants }, memberships: grants };
}

/**
 * Invoker core: `(id, identity, args) => createContext({ caller, store,
 * memberships })` + `invokeCallable`. The sibling `invoke`/`context`
 * modules load lazily per the worker-boundary rule; invoking an
 * operation while a sibling is not built fails loud naming the missing
 * module.
 */
async function invokeOperationCore(
  asm: AssembledModules,
  artifact: CompileArtifact,
  store: StoragePort,
  id: string,
  identity: ResolvedIdentity,
  args: unknown[],
): Promise<InvokeOutcome> {
  const createContext = await loadSiblingFn<CreateContext>("../runtime/context.js", "runtime/context.ts", "createContext");
  const invokeCallable = await loadSiblingFn<InvokeCallable>("../runtime/invoke.js", "runtime/invoke.ts", "invokeCallable");
  const { caller, memberships } = callerFor(identity);
  const ctx = await createContext({ caller, store, memberships });
  return invokeCallable(asm, artifact, id, ctx, args);
}

/**
 * Build the `OperationInvoker` callable bridge. Exported as the join seam:
 * the interfaces join feeds it into `HttpDeps`; invoking an operation
 * while a sibling is not built fails loud naming the missing module.
 */
export function buildInvoker(
  artifact: CompileArtifact,
  asm: AssembledModules,
  store: StoragePort,
): OperationInvoker {
  return {
    invokeMutation: async (envelope, identity): Promise<MutationOutcome> => {
      // Interim envelope->args projection (the sibling join owns the
      // canonical one): business inputs plus the receipt identity, as a
      // single handler argument (invoke spreads an ARRAY).
      const outcome = await invokeOperationCore(asm, artifact, store, envelope.operation, identity, [
        {
          operation_id: envelope.operation_id,
          inputs: envelope.inputs,
        },
      ]);
      if (!outcome.ok) {
        return { error: toBusinessError(outcome.error, envelope.operation_id) };
      }
      if (!isRecord(outcome.value)) {
        return { error: toBusinessError(outcome.value, envelope.operation_id) };
      }
      return { result: outcome.value as unknown as MutationResult };
    },
    invokeRead: async (envelope, identity): Promise<ReadOutcome> => {
      const outcome = await invokeOperationCore(asm, artifact, store, envelope.operation, identity, [
        { inputs: envelope.inputs },
      ]);
      if (!outcome.ok) {
        return { error: toBusinessError(outcome.error) };
      }
      return { result: outcome.value };
    },
  };
}

/* ------------------------------------------------------------------ */
/* INTERIM page + files dispatch (replaced by the interfaces join).     */
/*                                                                     */
/* Serves GET/HEAD page routes through the REAL descriptor admit/render */
/* under an anonymous identity. Fail-closed by construction: admission */
/* is still enforced by each descriptor's own `admit`, so authed pages */
/* deny; only public-admitting pages render. No shell, no discovery,   */
/* no session/CSRF, no in-render reads, exact paths only (dynamic      */
/* `{Token}` patterns 404 until the join).                             */
/*                                                                     */
/* `/files/*` routes match explicitly (a mirror of the uploads `match`), */
/* but nothing is servable yet: unknown paths/methods are `not_found`, */
/* `usesFiles: false` is `not_found`, and known routes are 501 naming  */
/* the exact unmet seam (files binding vs identity join). The kernel   */
/* is never touched and no bytes are ever fabricated.                  */
/* ------------------------------------------------------------------ */

/** Structural `DEFAULT_THEME` value (`contracts/src/presentation.ts:107`). */
const INTERIM_THEME: ThemeTokens = { mode: "system", accent: "blue", density: "comfortable" };

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Authored unknown response: `not_found`, mirroring routes/pages dispatch. */
function notFoundResponse(): Response {
  const error: BusinessError = { code: "not_found", message: "Not found.", retryable: false };
  return jsonResponse(error, INTERIM_STATUS_FOR_CODE["not_found"]);
}

/** Interim 501: explicitly NOT a BusinessError; names the unmet join. */
function interimUnavailable(message: string): Response {
  return jsonResponse({ code: "assembly-interim", message }, 501);
}

/** Interim mirror of `isPartialRequest` (`interfaces/src/http/fragments.ts`); the join deletes it. */
function isInterimPartialRequest(req: Request): boolean {
  return req.headers.has("HX-Request");
}

const INTERIM_INTENTS_PATH = "/files/intents";
const INTERIM_CONTENT_PREFIX = "/files/content/";
const INTERIM_FINALIZE_PREFIX = "/files/finalize/";

type InterimFilesRoute =
  | { readonly kind: "intents" }
  | { readonly kind: "content"; readonly intentId: string }
  | { readonly kind: "finalize"; readonly intentId: string };

/**
 * Interim mirror of `matchUploadRoute`
 * (`interfaces/src/uploads/routes.ts`): the path id is a single
 * non-empty segment; undecodable or empty ids, extra segments, unknown
 * paths, and method mismatches all return null (`not_found`, never a
 * 405 oracle). The join deletes it.
 */
function matchInterimFilesRoute(pathname: string, method: string): InterimFilesRoute | null {
  if (pathname === INTERIM_INTENTS_PATH) {
    return method === "POST" ? { kind: "intents" } : null;
  }
  let rest: string | null = null;
  let kind: "content" | "finalize" | null = null;
  if (pathname.startsWith(INTERIM_CONTENT_PREFIX)) {
    rest = pathname.slice(INTERIM_CONTENT_PREFIX.length);
    kind = "content";
  } else if (pathname.startsWith(INTERIM_FINALIZE_PREFIX)) {
    rest = pathname.slice(INTERIM_FINALIZE_PREFIX.length);
    kind = "finalize";
  }
  if (rest === null || kind === null) return null;
  if (rest === "" || rest.includes("/")) return null;
  let intentId: string;
  try {
    intentId = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (intentId === "") return null;
  if (kind === "content" && method !== "PUT") return null;
  if (kind === "finalize" && method !== "POST") return null;
  return { kind, intentId };
}

/**
 * Interim `/files/*` dispatch. Mirrors the uploads order (match ->
 * `usesFiles` gate -> auth), but every known route still ends loud:
 * without the files binding the kernel seam is named; with it, the
 * identity seam is named (the interim dispatcher runs anonymous and
 * uploads never admit public, so no receiver can be derived). The
 * kernel is never called here.
 */
function interimFilesResponse(
  pathname: string,
  method: string,
  files: InterimFilesBinding | undefined,
): Response {
  const route = matchInterimFilesRoute(pathname, method);
  if (route === null) return notFoundResponse();
  if (
    files === undefined ||
    typeof files.usesFiles !== "boolean" ||
    files.kernel === null ||
    files.kernel === undefined
  ) {
    return interimUnavailable(
      "file upload needs the files join (AssemblyDeps.files: usesFiles + the bound FileKernel); " +
        "no intent, byte, or finalize step can run until it lands",
    );
  }
  if (!files.usesFiles) {
    const error: BusinessError = { code: "not_found", message: "Uploads unavailable.", retryable: false };
    return jsonResponse(error, INTERIM_STATUS_FOR_CODE["not_found"]);
  }
  return interimUnavailable(
    `file upload needs the identity join (an authenticated receiver for ${route.kind}); ` +
      "the interim dispatcher runs anonymous and uploads never admit public",
  );
}

/** Tiny Accept-Language parse, mirroring pages.ts (split, strip params). */
function parseAcceptLanguage(header: string | null): readonly string[] {
  if (header === null) return [];
  return header
    .split(",", 10)
    .map((part) => {
      const semi = part.indexOf(";");
      return (semi === -1 ? part : part.slice(0, semi)).trim();
    })
    .filter((tag) => tag.length > 0);
}

const interimQuery: RowQueryRunner = async () => {
  throw new Error(
    "assembly interim: in-render reads need the interfaces join (bound RowQueryRunner); rows are supplied, never queried",
  );
};

function anonymousIdentity(nowMs: number): ResolvedIdentity {
  return {
    actor: null,
    team: null,
    membership: null,
    binding: { kind: "none" },
    admitted_at: new Date(nowMs).toISOString(),
  };
}

/** Interim app facts: L1 binds the real `AppInfo` from appDefinition. */
function interimAppInfo(artifact: CompileArtifact): AppInfo {
  const first = artifact.sources[0];
  const path = first?.path ?? "";
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  const stem = dot === -1 ? base : base.slice(0, dot);
  const appId = stem === "" ? "app" : stem;
  return { appId, brand: appId, appDefaultLocale: "en", ownerLabels: new Map() };
}

/**
 * Interim dispatch context: everything the dispatcher closes over. The
 * MCP route needs the artifact join (artifact + modules + store +
 * identity) while page GETs need only descriptors + app; one context
 * carries both.
 */
interface InterimDispatchContext {
  readonly app: AppInfo;
  readonly now: () => number;
  readonly files: InterimFilesBinding | undefined;
  readonly artifact: CompileArtifact;
  readonly asm: AssembledModules;
  readonly store: StoragePort;
  readonly identityStore: unknown;
  readonly mcp: McpJoin | undefined;
}

/** Same-origin upload-intents path advertised in the MCP `_meta` block. */
const INTERIM_MCP_INTENTS_URL = "/files/intents";

/**
 * P2 `/mcp` route: assemble the real `McpDeps` and delegate to the
 * injected `createMcpHandler`. Every method on exactly `/mcp` delegates
 * (the MCP handler owns method semantics); without the factory the
 * route answers the explicit interim 501. Registry/catalog build
 * failures (malformed P1 entries, unbuilt sibling) are contained here
 * as a 500 naming the entry — pages keep serving.
 */
async function handleMcpRequest(req: Request, ctx: InterimDispatchContext): Promise<Response> {
  const factory = ctx.mcp?.createHandler;
  if (factory === undefined || typeof factory !== "function") {
    return interimUnavailable(
      "MCP actions need the interfaces join (AssemblyDeps.mcp.createHandler: the deployed createMcpHandler); " +
        "the worker serves pages only until it lands",
    );
  }
  let registry: OperationRegistry;
  let catalog: SchemaCatalog;
  let permissions: McpPermissions;
  try {
    const createArtifactRegistry = await loadSiblingFn<CreateArtifactRegistry>(
      "../runtime/mcp-registry.js",
      "runtime/mcp-registry.ts",
      "createArtifactRegistry",
    );
    const createArtifactCatalog = await loadSiblingFn<CreateArtifactCatalog>(
      "../runtime/mcp-registry.js",
      "runtime/mcp-registry.ts",
      "createArtifactCatalog",
    );
    registry = createArtifactRegistry(ctx.artifact);
    catalog = createArtifactCatalog(ctx.artifact);
    if (ctx.mcp?.permissions !== undefined) {
      permissions = ctx.mcp.permissions;
    } else {
      const createDenyClosed = await loadSiblingFn<CreateDenyClosedMcpPermissions>(
        "../runtime/mcp-registry.js",
        "runtime/mcp-registry.ts",
        "createDenyClosedMcpPermissions",
      );
      permissions = createDenyClosed();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ code: "mcp-registry", message }, 500);
  }
  const usesFiles = ctx.files?.usesFiles ?? false;
  const now = ctx.now;
  const deps: McpDeps = {
    app: ctx.app,
    registry,
    permissions,
    // THE same bridge HTTP consumes at the join: one invoker, both transports.
    invoker: buildInvoker(ctx.artifact, ctx.asm, ctx.store),
    catalog,
    files: {
      usesFiles: (_app: unknown): boolean => {
        void _app;
        return usesFiles;
      },
      intentsUrl: (_app: unknown): string => {
        void _app;
        return INTERIM_MCP_INTENTS_URL;
      },
    },
    identity: {
      store: ctx.identityStore,
      mail: {
        sendMail: async (): Promise<void> => {
          throw new Error("assembly: mail is unbound on the MCP path (no MCP flow sends mail)");
        },
      },
      clock: { nowMs: () => now() },
      // Unused on the MCP path (grant auth derives its challenge origin
      // from the request URL); the HTTP/auth join binds real origins.
      verifyBaseUrl: "",
      recoveryBaseUrl: "",
      inviteBaseUrl: "",
      sessionMaxAgeSeconds: 0,
    },
    // No log sink join yet: incident + denial entries go to the worker
    // console (fields are safe-envelope members only, per the MCP server).
    logger: {
      log: (level: LogLevel, message: string, fields?: Record<string, unknown>): void => {
        if (fields === undefined) console.log(`[mcp] ${level} ${message}`);
        else console.log(`[mcp] ${level} ${message}`, fields);
      },
    },
    clock: { nowMs: () => now() },
  };
  return factory(deps)(req);
}

function buildInterimFetch(
  descriptors: readonly PageDescriptor[],
  ctx: InterimDispatchContext,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const pathname = url.pathname;

    if (pathname === "/mcp") {
      return handleMcpRequest(req, ctx);
    }
    if (pathname.startsWith("/api/operations/")) {
      return interimUnavailable(
        "operation invocation needs the interfaces join (handleOperationRequest) and the worker invoke/context siblings",
      );
    }
    if (pathname.startsWith("/auth/")) {
      return interimUnavailable("auth routes need the interfaces join (handleAuthRequest)");
    }
    if (pathname.startsWith("/files/")) {
      return interimFilesResponse(pathname, method, ctx.files);
    }
    if (method !== "GET" && method !== "HEAD") return notFoundResponse();
    if (pathname.length > 1 && pathname.endsWith("/")) {
      const stripped = pathname.replace(/\/+$/, "");
      const target = `${stripped.length === 0 ? "/" : stripped}${url.search}`;
      return new Response(null, { status: 308, headers: { location: target } });
    }

    let match: PageDescriptor | null = null;
    for (const descriptor of descriptors) {
      if (descriptor.path === pathname) {
        match = descriptor;
        break;
      }
    }
    if (match === null) return notFoundResponse();

    const identity = anonymousIdentity(ctx.now());
    let bindings: AdmittedBindings;
    try {
      bindings = await match.admit(identity, {});
    } catch (err) {
      if (isBusinessErrorLike(err)) {
        return jsonResponse(err, INTERIM_STATUS_FOR_CODE[err.code]);
      }
      return jsonResponse(
        { code: "rule_failed", message: INTERIM_REJECTION_MESSAGE, retryable: false },
        INTERIM_STATUS_FOR_CODE["rule_failed"],
      );
    }

    // Interim mirror of `buildPresentationContext`
    // (`interfaces/src/http/presentation.ts`): same field semantics —
    // locales from Accept-Language, app default locale, default theme,
    // exact path, partial from the HX-Request header (as pages.ts
    // derives it via `isPartialRequest`), empty CSRF while anonymous,
    // identity as principal+invocation, throwing query runner (the join
    // binds the real RowQueryRunner). The join deletes it.
    const context: PresentationContext = {
      preferredLocales: parseAcceptLanguage(req.headers.get("accept-language")),
      appDefaultLocale: ctx.app.appDefaultLocale,
      theme: INTERIM_THEME,
      path: pathname,
      isPartial: isInterimPartialRequest(req),
      csrfToken: "",
      principal: identity,
      invocation: identity,
      query: interimQuery,
    };
    let html: unknown;
    try {
      html = (await match.render(context, bindings)) as unknown;
    } catch (err) {
      if (isBusinessErrorLike(err)) {
        return jsonResponse(err, INTERIM_STATUS_FOR_CODE[err.code]);
      }
      return jsonResponse(
        { code: "rule_failed", message: INTERIM_REJECTION_MESSAGE, retryable: false },
        INTERIM_STATUS_FOR_CODE["rule_failed"],
      );
    }
    if (typeof html !== "string") {
      return jsonResponse(
        { code: "rule_failed", message: INTERIM_REJECTION_MESSAGE, retryable: false },
        INTERIM_STATUS_FOR_CODE["rule_failed"],
      );
    }
    // No shell until the ui join: descriptor HTML is served directly.
    return new Response(method === "HEAD" ? null : html, {
      status: 200,
      headers: { "content-type": "text/html;charset=utf-8" },
    });
  };
}

/* ------------------------------------------------------------------ */
/* assembleWorker                                                      */
/* ------------------------------------------------------------------ */

/**
 * B3-I6 activation refusal: a worker assembled with a failed verdict
 * serves NOTHING. Every request — known routes, unknown paths, any
 * method — gets the same 500 `activation-refused` envelope naming the
 * FIRST reason (deterministic; the deployer reads the full verdict off
 * the activation path, not here). Deliberately distinct from the
 * interim 501 (`assembly-interim`: unmet join, retry-after-join) and
 * from 404 routing: a refused worker is a deployment state, not a
 * missing page or an unlanded seam.
 */
function buildRefusalFetch(verdict: Extract<ActivationVerdict, { active: false }>): AssembledWorker {
  const first = verdict.reasons[0];
  const body =
    first === undefined
      ? { code: "activation-refused", reason: "unknown", detail: "activation refused (no reason given)" }
      : { code: "activation-refused", reason: first.code, detail: first.detail };
  return {
    fetch: async (): Promise<Response> => jsonResponse(body, 500),
    pageCount: 0,
    opCount: 0,
  };
}

/**
 * Assemble a serving worker from a compiled artifact and its assembled
 * modules. Builds the `PageRegistry` (every page module imported, its
 * `export` binding verified for owner/path/render-shape, fail loud on the
 * first bad descriptor) and the `OperationInvoker` (`(id, caller, args)`
 * core: `createContext({ caller, store })` + `invokeCallable`), then wraps
 * the interim dispatcher in the real `createWorkerApp` entry wiring.
 *
 * `verdict` is the B3-I6 activation gate: unless it is active, assembly
 * short-circuits to the refusal worker (no page module is imported).
 * Programmer bugs (bad deps) still throw before the gate so a broken
 * assembly can never hide behind a refusal.
 *
 * `requiredBindings` is `[]`: this signature is env-less (the store is
 * already injected), so there are no bindings to validate here — binding
 * validation stays with the deploy join that owns `env`.
 */
export async function assembleWorker(
  artifact: CompileArtifact,
  asm: AssembledModules,
  deps: AssemblyDeps,
  verdict: ActivationVerdict,
): Promise<AssembledWorker> {
  if (!isRecord(deps.store)) {
    throw new Error("assembly: deps.store is required (a StoragePort)");
  }
  if (deps.identityStore === null || deps.identityStore === undefined) {
    throw new Error(
      "assembly: deps.identityStore is required (reserved for HttpDeps.identity.store at the identity join)",
    );
  }
  if (!verdict.active) {
    return buildRefusalFetch(verdict);
  }
  assertArtifactCompatible(artifact);

  const { descriptors } = await loadPageRegistry(artifact, asm);

  const now = deps.now ?? Date.now;
  const innerFetch = buildInterimFetch(descriptors, {
    app: interimAppInfo(artifact),
    now,
    files: deps.files,
    artifact,
    asm,
    store: deps.store,
    identityStore: deps.identityStore,
    mcp: deps.mcp,
  });

  // Real entry wiring (mirrors entry.ts; not a fork): dynamic import keeps
  // the worker boundary (static `import type` only).
  const { createWorkerApp } = await import("./entry.js");
  const app = createWorkerApp({ requiredBindings: [], fetch: (request) => innerFetch(request) });

  let opCount = 0;
  for (const callable of artifact.callables) {
    if (callable.kind === "operation") opCount += 1;
  }
  return {
    fetch: async (req: Request): Promise<Response> => app.fetch(req, {}),
    pageCount: descriptors.length,
    opCount,
  };
}
