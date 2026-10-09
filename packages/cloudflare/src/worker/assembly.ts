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
 * join replaces it. Auth stays 501 until that join; C3 joins POST
 * `/api/operations/*` through the real `handleOperationRequest`
 * (`AssemblyDeps.http.createOperationHandler`, same catalog + invoker
 * as MCP). `/files/*`
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
 *
 * T16b canonical routing (additive): generated artifacts (T15a
 * descriptors present) invoke mutations through the canonical state
 * path (`runtime/invoke.ts` `invokeMutationCanonical`) and refuse
 * reads with precise `validation` errors; descriptor-less artifacts
 * keep the interim direct bridge untouched. Assembly additionally
 * gates on the T04a contract pins, `requires[]` fulfillment, and a
 * descriptor preload for generated artifacts — all fail-loud before
 * serving.
 *
 * T17b flip + retirements (this file): generated reads route onto
 * `runtime/invoke.ts` `invokeReadCanonical` (the query-port refusal
 * stub is retired — reads serve with admission + grant projection);
 * descriptor-less artifacts REFUSE on both envelopes (the interim
 * direct bridge is retired: no descriptors means no admission
 * registry, and synthesizing descriptors would invent gates — see the
 * T17b release report for the refuse-vs-synthesize decision); and
 * `INTERIM_DDL` is retired (the engine stores every model in its
 * generic `records` table — per-model demo DDL is dead).
 *
 * T24b dispatch composition (this file): the worker assembly seam for
 * system commands. `assembleDispatchCommands` composes the ONE serving
 * registry shape `[...l3Commands, ...WORK_SYSTEM_COMMANDS,
 * ...WORK_DISPATCH_STAGE_COMMANDS]` from injected segments — L3 ships
 * in state dist (the runtime loads it dynamically), while the work
 * segments are injected by the caller because `@canlang/work` has no
 * dist build (the deploy join supplies the real arrays exactly as
 * tests supply them from work sources). The seam enforces order +
 * unique names only; engine array sizes stay engine-owned (pinned by
 * the kernel-commands registry-shape test, not here). Execution
 * (claim -> provider -> record, sweeps, claim-time guard re-eval)
 * lives in `runtime/invoke.ts` and runs through the composed registry
 * over the dispatch-join port.
 *
 * T34-F7 fanout serving surface (this file, additive): the worker
 * assembly seam for the fanout join. `assembleFanoutServingSurface`
 * composes the six injected runtime entries (trigger join, durable
 * claim/record, scheduler turn, progress, provider cancel) into the
 * ONE frozen serving surface, failing loud on missing entries.
 */

import type {
  ActivationVerdict,
  ArtifactPage,
  BusinessError,
  BusinessErrorCode,
  CompileArtifact,
  ClosedInputs,
  DerivedOperationInputs,
  ConflictCurrent,
  ContentCheck,
  FinalizeResult,
  FinalizedFile,
  MutationEnvelope,
  MutationResult,
  PageDescriptor,
  PageReadScope,
  ReadEnvelope,
  ReadResult,
  ResolvedIdentity,
  RowQueryRunner,
  StoragePort,
  UploadIntentGrant,
  UploadIntentRequest,
  VerifiedIngressEnvelope,
} from "@canlang/contracts";
import type { AssembledModules } from "../runtime/modules.js";
import type { InputChoiceLookup, PagePreferenceStore } from '@canlang/interfaces';
import type { IdentityStore } from '@canlang/identity';
import type { WorkScope } from '@canlang/contracts';
import type { createD1OwnerRouter } from '@canlang/state/storage/owner-router';
import type { HandlerContext } from "../runtime/context.js";
import type { CanonicalFileBinding } from '../runtime/file-staging.js';
import type { PageReadsBinding } from '../runtime/page-cursor.js';
import type {
  CanonicalMembershipReader,
  CanonicalMutationOpts,
  CanonicalReadOpts,
  ContractVersionSet,
  RequiresProvidedVersions,
  SelectedReceiptObserverBinding,
} from "../runtime/invoke.js";
import type {
  BakedDerivedInputs,
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

/** Host-owned restoration consumer, separate from ordinary transport dispatch. */
export interface RetainedOperationInvoker extends OperationInvoker {
  invokeRetainedMutation(envelope: MutationEnvelope, identity: ResolvedIdentity): Promise<MutationOutcome>;
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
 * `createDenyClosedMcpPermissions`). `derivedInputs` absent -> the
 * catalog serves framing shapes only (E1 legacy; bound checking
 * stays off on the MCP path until the P-B join stages the data).
 */
export interface McpJoin {
  readonly createHandler?: McpHandlerFactory;
  readonly permissions?: McpPermissions;
  /** C1 deploy-baked E1 channel (`worker/derived-inputs.js` via the P-B join). */
  readonly derivedInputs?: BakedDerivedInputs;
}

/** Mirror of `RateLimitDecision` (`packages/interfaces/src/ports.ts:103`). */
export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
}

/** Mirror of `RateLimiter` (`packages/interfaces/src/ports.ts:108`). */
export interface RateLimiter {
  check(key: string, limit: number, windowMs: number): Promise<RateLimitDecision>;
}

/** Mirror of `FileUseInfo` (`packages/interfaces/src/ports.ts:225`). */
export interface FileUseInfo {
  usesFiles(app: AppInfo): boolean;
}

/** Mirror of `IngressBinding` (`packages/interfaces/src/ports.ts:360`). */
export interface IngressBinding {
  readonly namespace: string;
  readonly adapter: string;
  readonly team: string;
  readonly owner: string;
}

/** Mirror of `IngressBindings` (`packages/interfaces/src/ports.ts:367`). */
export interface IngressBindings {
  bindingFor(namespace: string): IngressBinding | null;
}

/** Mirror of `IngressVerifier` (`packages/interfaces/src/ports.ts:376`). */
export interface IngressVerifier {
  verify(
    binding: IngressBinding,
    input: { headers: Record<string, string>; body: Uint8Array },
  ): Promise<VerifiedIngressEnvelope | null>;
}

/** Mirror of `DelegatedContext` (`packages/interfaces/src/ports.ts:388`). */
export interface DelegatedContext {
  readonly actor: null;
  readonly team: string;
  readonly owner: string;
  readonly namespace: string;
  readonly causation: VerifiedIngressEnvelope;
}

/** Mirror of `IngressSink` (`packages/interfaces/src/ports.ts:397`). */
export interface IngressSink {
  accept(context: DelegatedContext, event: unknown): Promise<{ accepted: boolean }>;
}

/**
 * Mirror of `HttpDeps` (`packages/interfaces/src/ports.ts:128`). The C3
 * worker assembly constructs these per `/api/operations/*` request; the
 * interfaces join replaces the mirror with the real import. Same three
 * documented seams as `McpDeps` (`identity.store`, single-app
 * `registry`/`files` widenings, `string` brand/labels). Members the op
 * route never touches (pages, limiter, secureCookies, uploads, ingress)
 * bind interim fail-closed stubs — the op handler reads exactly app,
 * invoker, catalog, logger, clock, and identity (see
 * `handleOperationRequest`), so the stubs never execute there.
 */
/** Structural mirror of the owning Interfaces source-form binding port. */
export interface SourceFormBindingContext {
  readonly appId: string;
  readonly sessionToken: string;
  readonly identity: ResolvedIdentity;
  readonly derived: DerivedOperationInputs;
  readonly operationId: string;
  readonly nowMs: number;
  readonly occurrence?: string;
}
export interface SourceFormBindingProof {
  readonly token: string;
  readonly identity: string;
  readonly draftIdentity: string;
}
export interface SourceFormBindings {
  seal(context: SourceFormBindingContext, bound: ClosedInputs, editable: readonly string[]): Promise<SourceFormBindingProof>;
  restore(context: SourceFormBindingContext, token: string, inputs: ClosedInputs): Promise<ClosedInputs | null>;
  restoreRetained?(context: SourceFormBindingContext, token: string, inputs: ClosedInputs): Promise<ClosedInputs | null>;
}

export interface HttpDeps {
  readonly formBindings?: SourceFormBindings;
  readonly inputChoices?: InputChoiceLookup;
  readonly app: AppInfo;
  readonly pages: PageRegistry;
  readonly invoker: OperationInvoker;
  readonly catalog: SchemaCatalog;
  readonly limiter: RateLimiter;
  readonly logger: Logger;
  readonly clock: InterfacesClock;
  readonly identity: IdentityDeps;
  readonly secureCookies: boolean;
  readonly uploads: {
    readonly files: FileUseInfo;
    readonly kernel: InterimFileKernel;
  };
  readonly ingress: {
    readonly bindings: IngressBindings;
    readonly verifier: IngressVerifier;
    readonly sink: IngressSink;
  };
}

/**
 * Mirror of `handleOperationRequest`
 * (`packages/interfaces/src/http/operations.ts:168`): the real POST
 * `/api/operations/<operation>` chain over assembled deps. Injected
 * through `AssemblyDeps.http` because `@canlang/interfaces` is not a
 * dependency of this package; the deploy join supplies the real
 * function (bundled for workerd), exactly as tests supply it from
 * interfaces dist.
 */
export type HttpOperationHandlerFactory = (
  deps: HttpDeps,
) => (req: Request, op: string) => Promise<Response>;
export type VersionedHttpOperationHandlerFactory = HttpOperationHandlerFactory & { readonly inputChoicesVersion?: number };

/**
 * HTTP op-route join inputs. `createOperationHandler` absent ->
 * `/api/operations/*` keeps the explicit interim 501 naming the
 * interfaces join. `derivedInputs` absent -> the catalog serves
 * framing shapes only (E1 legacy; bound checking stays off on the
 * HTTP path until the P-B join stages the data) — the SAME bake the
 * MCP path consumes, so browser/MCP bound rules agree by
 * construction.
 */
/** Narrow defining page-handler dependencies (Interfaces PageHttpDeps). */
export interface PageHttpDeps {
  readonly formBindings?: SourceFormBindings;
  readonly preferences?: PagePreferenceStore;
  readonly app: AppInfo;
  readonly pages: PageRegistry;
  readonly catalog?: SchemaCatalog;
  readonly logger: Logger;
  readonly clock: InterfacesClock;
  readonly identity: { readonly store: unknown };
  readonly query: RowQueryRunner;
  readonly createReadScope?: (identity: ResolvedIdentity) => PageReadScope | Promise<PageReadScope>;
}
export type HttpPageHandlerFactory = (deps: PageHttpDeps) => (request: Request) => Promise<Response>;

/** Trusted host auth inputs; no request-derived origin or implicit limiter. */
export interface HttpAuthConfiguration {
  readonly limiter: RateLimiter;
  readonly origin: string;
  readonly secureCookies: boolean;
  readonly mail?: MailPort;
}
export interface AuthHttpDeps {
  readonly identity: Omit<IdentityDeps, 'mail'> & { readonly mail?: MailPort };
  readonly limiter: RateLimiter;
  readonly logger: Logger;
  readonly clock: InterfacesClock;
  readonly secureCookies: boolean;
}
export type HttpAuthHandlerFactory = (deps: AuthHttpDeps) => (request: Request) => Promise<Response>;
export interface HttpAuthJoin {
  readonly createHandler: HttpAuthHandlerFactory;
  /** Owning Identity session lifetime, released by the same auth bundle. */
  readonly sessionExpiresMs: number;
}

export interface HttpJoin {
  readonly auth?: HttpAuthConfiguration;
  readonly authHandler?: HttpAuthJoin;
  readonly formBindings?: SourceFormBindings;
  readonly preferences?: PagePreferenceStore;
  readonly createPageHandler?: HttpPageHandlerFactory;
  readonly createOperationHandler?: VersionedHttpOperationHandlerFactory;
  /** C1 deploy-baked E1 channel, shared verbatim with the MCP path. */
  readonly derivedInputs?: BakedDerivedInputs;
  /** Selected static resources load only after the existing serving gates. */
  readonly loadBrowserAssets?: (pages: readonly PageDescriptor[]) => Promise<BrowserAssetsHandler>;
}

/** Finite generated static-resource join; no filesystem or session access. */
export interface BrowserAssetsHandler {
  readonly paths: readonly string[];
  readonly fetch: (request: Request) => Response;
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
  /** Selected real host transport, including current-grant finalized reads. */
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly canonical?: CanonicalFileBinding;
}

/**
 * Real `HandlerContext` (`src/runtime/context.ts`; joined at B1
 * integration). Re-exported so worker consumers keep one import site.
 */
export type { HandlerContext };

/** Sibling `createArtifactRegistry(artifact)` (`src/runtime/mcp-registry.ts`; P2). */
type CreateArtifactRegistry = (artifact: CompileArtifact) => OperationRegistry;

/** Sibling `createArtifactCatalog(artifact, baked?)` (`src/runtime/mcp-registry.ts`; P2 + C1 derived channel). */
type CreateArtifactCatalog = (artifact: CompileArtifact, baked?: BakedDerivedInputs) => SchemaCatalog;

/** Sibling `createDenyClosedMcpPermissions()` (`src/runtime/mcp-registry.ts`; P2). */
type CreateDenyClosedMcpPermissions = () => McpPermissions;

/** Sibling `isGeneratedArtifact(artifact)` (`src/runtime/invoke.ts`; T16b). */
type IsGeneratedArtifact = (artifact: CompileArtifact) => boolean;

/** Sibling `invokeMutationCanonical(opts)` (`src/runtime/invoke.ts`; T16b). */
type InvokeMutationCanonical = (opts: CanonicalMutationOpts) => Promise<MutationResult>;

/** Sibling `invokeReadCanonical(opts)` (`src/runtime/invoke.ts`; T17b). */
type InvokeReadCanonical = (opts: CanonicalReadOpts) => Promise<ReadResult>;

/** Sibling `loadCanonicalDescriptors(asm, artifact)` (`src/runtime/invoke.ts`; T16b). */
type LoadCanonicalDescriptors = (
  asm: AssembledModules,
  artifact: CompileArtifact,
) => Promise<unknown>;

/** Sibling `loadContractVersions()` (`src/runtime/invoke.ts`; T16b). */
type LoadContractVersions = () => Promise<ContractVersionSet>;

/** Sibling `assertT04aContractPins(provided)` (`src/runtime/invoke.ts`; T16b). */
type AssertT04aContractPins = (provided: ContractVersionSet) => void;

/** Sibling `assertRequiresFulfilled(requires, provided)` (`src/runtime/invoke.ts`; T16b). */
type AssertRequiresFulfilled = (
  requires: ReadonlyArray<{ readonly capability: string; readonly min_version: number }>,
  provided: RequiresProvidedVersions,
) => void;

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
/** Actual installed cohort scheduler; v1 is fulfilled only by this bound consumer. */
export interface CohortTickBinding {
  readonly version: 1;
  tick(): Promise<unknown>;
}

export interface AssemblyDeps {
  store: StoragePort;
  identityStore: unknown;
  now?: () => number;
  cohorts?: CohortTickBinding;
  ownerStorage?: TeamOwnerStorageBoundary;
  /** Explicit qualified host page binding; the production owner routing gate still applies. */
  pageReads?: PageReadsBinding;
  /** Installed owning Work observer for generated selected delivery reads. */
  selectedReceiptObserver?: SelectedReceiptObserverBinding;
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
  /**
   * C3 HTTP op-route join inputs. Absent until the op-route join
   * lands; while absent (or without `createOperationHandler`),
   * `/api/operations/*` keeps the explicit interim 501 naming the
   * join. Auth/pages/uploads/ingress stay interim regardless — this
   * join covers operation POSTs only.
   */
  http?: HttpJoin;
}

/** Assembled worker: serving fetch plus registry counts. */
export interface AssembledWorker {
  fetch: (req: Request) => Promise<Response>;
  pageCount: number;
  opCount: number;
  tick?: () => Promise<unknown>;
}

/* ------------------------------------------------------------------ */
/* INTERIM_DDL: RETIRED in T17b (was: coordinator decision R2).         */
/*                                                                     */
/* The hand-written per-model demo DDL (`todo`, `note`) is deleted      */
/* with its `env-assembly.ts` applier: the engine stores every model   */
/* in ONE generic `records` table (model as a column, domain fields    */
/* as JSON) created by `ensureSchema`, so per-model DDL was never the  */
/* engine's shape and nothing reads those tables (`StoragePort` has    */
/* no raw-SQL surface). When the D1 owner lands a real migrate step,   */
/* that step owns schema — there is no interim DDL left to supersede.  */
/* ------------------------------------------------------------------ */

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

/**
 * T16b restated requires vocabulary (transcribes `compute_requires` in
 * `compiler/src/codegen/artifact.rs`, `KNOWN_CAPABILITIES` in
 * `src/deploy/installed.ts`, and `REQUIRES_CAPABILITY_MAP` in
 * `src/deploy/activate.ts`): the six producer capability ids; the
 * version-fulfillment twin lives in `src/runtime/invoke.ts`
 * (`assertRequiresFulfilled`) and must stay in sync with this set.
 */
const T16B_KNOWN_REQUIRES_IDS: ReadonlySet<string> = new Set([
  "canlang.builtins",
  "state",
  "state.machines",
  "state.parameters",
  "state.cohorts",
  "interfaces.input-choices",
  "values.decimal",
  "values.int64",
  "values.money",
  "values.temporal",
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
    if (callable.inputStyle !== undefined &&
        (callable.inputStyle !== "parameters" || callable.kind !== "operation" ||
         !artifact.requires.some((requirement) => requirement.capability === "state.parameters" && requirement.min_version >= 1) ||
         !artifact.operations?.some((operation) => operation.name === callable.id &&
           (operation.kind === "scenario" || operation.kind === "read")))) {
      throw new Error(`assembly: invalid inputStyle for callable ${JSON.stringify(callable.id)}`);
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
    // T16b (T04a §7): unknown capability ids reject at assembly (never
    // silently treated as supported); version fulfillment runs in
    // `assertServingContracts` once the contracts copy loads.
    if (!T16B_KNOWN_REQUIRES_IDS.has(requirement.capability)) {
      throw new Error(
        `assembly: artifact requires unknown capability ${JSON.stringify(requirement.capability)} ` +
          `(min_version ${requirement.min_version}); known: ` +
          `canlang.builtins, state, state.machines, state.parameters, values.decimal, values.int64, values.money, values.temporal`,
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
 * C2/B2 (Q3): a carried `conflict` current renders through (mirror of
 * state `toBusinessError` — present only on `conflict` denials with a
 * carried row); absent everywhere else. Never throws (an error renderer
 * must not mask the error it renders).
 */
function toBusinessError(error: unknown, operationId?: string): BusinessError {
  const base: { code: BusinessErrorCode; message: string } = isBusinessErrorLike(error)
    ? { code: error.code, message: error.message }
    : typeof error === "string" && error !== ""
      ? { code: "rule_failed", message: error }
      : error instanceof Error
        ? { code: "rule_failed", message: error.message }
        : { code: "rule_failed", message: INTERIM_REJECTION_MESSAGE };
  const conflict: unknown = isRecord(error) ? error["conflict"] : undefined;
  const carried = conflict !== undefined ? { conflict: conflict as ConflictCurrent } : {};
  if (operationId === undefined || operationId === "") {
    return { ...base, retryable: false, ...carried };
  }
  // `BusinessError.operation_id` is the wire-plain `OperationId` (an alias
  // for `string`), so no brand cast is needed here.
  return { ...base, operation_id: operationId, retryable: false, ...carried };
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
 * Canonical invoker options (T16b 4th parameter; T17b: the interim
 * direct path is retired, so every artifact either routes canonical
 * or refuses — there is no third path).
 */
export interface TeamOwnerStorageBoundary {
  readonly app: string;
  readonly forIdentity: (identity: ResolvedIdentity) => Promise<StoragePort>;
  /** Trusted host only; a Work scope is not a public identity credential. */
  readonly forTrustedScope: (scope: WorkScope, now: number) => Promise<{
    readonly identity: ResolvedIdentity;
    readonly store: StoragePort;
  }>;
}

/** Selected team-only fixture boundary; no app/global storage fallback. */
export async function createTeamOwnerStorageBoundary(input: {
  readonly artifact: CompileArtifact;
  readonly asm: AssembledModules;
  readonly app: string;
  readonly identities: IdentityStore;
  readonly router: ReturnType<typeof createD1OwnerRouter>;
}): Promise<TeamOwnerStorageBoundary> {
  const { app, identities, router } = input;
  const models = input.artifact.models;
  if (models === undefined || models.length === 0) throw new Error('assembly: owner routing requires declared team models');
  const byName = new Map(models.map(model => [model.name, model]));
  if (byName.size !== models.length) throw new Error('assembly: owner routing requires unique declared models');
  const complete = new Set<string>();
  const visiting = new Set<string>();
  const teamRoot = (name: string): void => {
    if (complete.has(name)) return;
    const model = byName.get(name);
    if (model === undefined || visiting.has(name)) throw new Error('assembly: missing or cyclic model owner root');
    if (model.scope !== undefined) throw new Error('assembly: owner routing supports team roots only');
    visiting.add(name);
    if (model.parent !== undefined) teamRoot(model.parent);
    visiting.delete(name);
    complete.add(name);
  };
  for (const model of models) teamRoot(model.name);
  const first = input.artifact.modules[0];
  const url = first === undefined ? undefined : input.asm.moduleUrls[first.path];
  if (url === undefined) throw new Error('assembly: owner routing entry module is missing');
  const module: unknown = await import(url);
  const definition = isRecord(module) ? module['appDefinition'] : undefined;
  if (!isRecord(definition) || definition['id'] !== app || !isRecord(definition['packages'])) {
    throw new Error('assembly: owner routing requires the exact declared app and packages');
  }
  const packages = new Set(Object.keys(definition['packages']));
  const forIdentity = async (identity: ResolvedIdentity): Promise<StoragePort> => {
    const team = identity.team;
    if (team === null || typeof team?.team_id !== 'string' || team.team_id === '' ||
        await identities.findTeamById(team.team_id) === null) {
      throw new Error('assembly: owner routing requires a current concrete Identity team');
    }
    return router.ownerScopedStoragePort({ app, owner: team.team_id });
  };
  return Object.freeze({ app, forIdentity,
    async forTrustedScope(scope: WorkScope, now: number) {
      if (scope.app !== app || !packages.has(scope.ownerPackage) || scope.owner === 'app' ||
          typeof scope.owner !== 'string' || scope.owner === '' || !Number.isFinite(now)) {
        throw new Error('assembly: trusted owner routing requires the exact declared team Work scope');
      }
      const { resolveIdentity } = await import('@canlang/identity');
      const identity = await resolveIdentity(identities, { team_id: scope.owner }, { clock: { nowMs: () => now } });
      if (identity.actor !== null || identity.team?.team_id !== scope.owner) {
        throw new Error('assembly: trusted owner routing identity disagrees with Work scope');
      }
      return { identity, store: await forIdentity(identity) };
    },
  });
}

export interface CanonicalInvokerOpts {
  /**
   * Membership reader for canonical admission (the IdentityStore,
   * validated structurally at the canonical boundary). REQUIRED for
   * generated artifacts; unused on the descriptor-less refusal path.
   */
  readonly memberships?: CanonicalMembershipReader;
  /** Serving-source label; defaults to `worker` (the MCP path passes `mcp`). */
  readonly source?: string;
  /** Admission clock; defaults to `Date.now`. */
  readonly now?: () => number;
  readonly appId?: string;
  /** Host-owned checked selected-app metadata, shared with page serving. */
  readonly appInfo?: AppInfo;
  readonly selectedReceiptObserver?: SelectedReceiptObserverBinding;
  readonly files?: CanonicalFileBinding;
  /** Host-injected selected team boundary, shared with trusted Work admission. */
  readonly ownerStorage?: TeamOwnerStorageBoundary;
}

/**
 * T17b descriptor-less refusal (both envelopes): without T15a
 * descriptors there is no admission registry — no operation defs to
 * admit through, no input shapes to validate closed, no gates to
 * transcribe. Synthesizing descriptors would invent all three (the
 * rejected alternative — see the T17b release report), so the router
 * refuses with a precise `validation` error instead. Per-call (not a
 * `buildInvoker` throw) so transports render the established
 * envelope; nothing is served, staged, or committed.
 */
function descriptorLessRefusal(operation: string): BusinessError {
  return {
    code: "validation",
    message:
      `Operation ${JSON.stringify(operation)} cannot run: descriptor-less artifacts were ` +
      `retired in T17 (no operation descriptors, so no admission registry); recompile with ` +
      `T15a descriptors to serve through the canonical path.`,
    retryable: false,
  };
}

/**
 * Build the `OperationInvoker` callable bridge. Exported as the join seam:
 * the interfaces join feeds it into `HttpDeps`; invoking an operation
 * while a sibling is not built fails loud naming the missing module.
 *
 * T17b routing: generated artifacts (T15a descriptors present) execute
 * mutations through the canonical state path (admit -> execute ->
 * receipt) and serve reads through the canonical read path (admit ->
 * grant-project); descriptor-less artifacts REFUSE on both envelopes
 * (the interim direct bridge is retired).
 */
export function buildInvoker(
  artifact: CompileArtifact,
  asm: AssembledModules,
  store: StoragePort,
  opts: CanonicalInvokerOpts = {},
): RetainedOperationInvoker {
  const mutate = async (envelope: MutationEnvelope, identity: ResolvedIdentity, receiptOnly: boolean): Promise<MutationOutcome> => {
      const isGeneratedArtifact = await loadSiblingFn<IsGeneratedArtifact>(
        "../runtime/invoke.js",
        "runtime/invoke.ts",
        "isGeneratedArtifact",
      );
      if (!isGeneratedArtifact(artifact)) {
        return {
          error: { ...descriptorLessRefusal(envelope.operation), operation_id: envelope.operation_id },
        };
      }
      try {
        const invokeCanonical = await loadSiblingFn<InvokeMutationCanonical>(
          "../runtime/invoke.js",
          "runtime/invoke.ts",
          receiptOnly ? "invokeRetainedMutationCanonical" : "invokeMutationCanonical",
        );
        const selectedApp = opts.appInfo ?? (opts.appId === undefined ? await loadAppInfo(artifact, asm) : undefined);
        const app = selectedApp?.appId ?? opts.appId!;
        if (opts.ownerStorage !== undefined && opts.ownerStorage.app !== app) throw new Error('assembly: owner storage app disagrees');
        const selectedStore = opts.ownerStorage === undefined ? store : await opts.ownerStorage.forIdentity(identity);
        const result = await invokeCanonical({
          asm,
          artifact,
          operation: envelope.operation,
          operationId: envelope.operation_id,
          inputs: envelope.inputs,
          identity,
          app,
          ...(selectedApp === undefined ? {} : { formatting: { appDefault: selectedApp.appDefaultLocale } }),
          source: opts.source ?? "worker",
          store: selectedStore,
          memberships: opts.memberships as CanonicalMembershipReader,
          now: opts.now ?? Date.now,
          ...(opts.selectedReceiptObserver === undefined ? {} : { observer: opts.selectedReceiptObserver }),
          ...(opts.files === undefined ? {} : { files: opts.files }),
        });
        return { result };
      } catch (error) {
        return { error: toBusinessError(error, envelope.operation_id) };
      }
    };
  return {
    invokeMutation: (envelope, identity) => mutate(envelope, identity, false),
    invokeRetainedMutation: (envelope, identity) => mutate(envelope, identity, true),
    invokeRead: async (envelope, identity): Promise<ReadOutcome> => {
      const isGeneratedArtifact = await loadSiblingFn<IsGeneratedArtifact>(
        "../runtime/invoke.js",
        "runtime/invoke.ts",
        "isGeneratedArtifact",
      );
      if (!isGeneratedArtifact(artifact)) {
        return { error: descriptorLessRefusal(envelope.operation) };
      }
      try {
        const invokeCanonical = await loadSiblingFn<InvokeReadCanonical>(
          "../runtime/invoke.js",
          "runtime/invoke.ts",
          "invokeReadCanonical",
        );
        const isReadScenario = artifact.operations?.some(op => op.name === envelope.operation && op.kind === 'read') &&
          artifact.callables.some(callable => callable.id === envelope.operation);
        const selectedApp = opts.appInfo ?? ((isReadScenario || opts.ownerStorage !== undefined) && opts.appId === undefined ? await loadAppInfo(artifact, asm) : undefined);
        if (opts.ownerStorage !== undefined && (selectedApp?.appId ?? opts.appId) !== opts.ownerStorage.app) {
          throw new Error('assembly: owner storage app disagrees');
        }
        const selectedStore = opts.ownerStorage === undefined ? store : await opts.ownerStorage.forIdentity(identity);
        const result = await invokeCanonical({
          asm,
          artifact,
          operation: envelope.operation,
          inputs: envelope.inputs,
          identity,
          store: selectedStore,
          source: opts.source ?? 'worker',
          now: opts.now ?? Date.now,
          ...(selectedApp === undefined ? {} : { formatting: { appDefault: selectedApp.appDefaultLocale } }),
          memberships: opts.memberships as CanonicalMembershipReader,
          ...(opts.selectedReceiptObserver === undefined ? {} : { observer: opts.selectedReceiptObserver }),
        });
        return { result };
      } catch (error) {
        return { error: toBusinessError(error) };
      }
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

/** The CompileArtifact first program entry owns app identity, never a filename. */
async function loadAppInfo(artifact: CompileArtifact, asm: AssembledModules): Promise<AppInfo> {
  const first = artifact.modules[0];
  const url = first === undefined ? undefined : asm.moduleUrls[first.path];
  if (url === undefined) throw new Error("assembly: selected app entry module is missing");
  const mod: unknown = await import(url);
  const definition = isRecord(mod) ? mod["appDefinition"] : undefined;
  if (!isRecord(definition) || typeof definition["id"] !== "string" || definition["id"] === "") {
    throw new Error("assembly: selected app entry has no defining appDefinition.id");
  }
  let appDefaultLocale = "en";
  if (Object.prototype.hasOwnProperty.call(definition, "appDefaultLocale")) {
    const claimedLocale = definition["appDefaultLocale"];
    try {
      if (typeof claimedLocale !== "string" || Intl.getCanonicalLocales(claimedLocale).length !== 1) {
        throw new Error("invalid locale");
      }
      appDefaultLocale = claimedLocale;
    } catch {
      throw new Error("assembly: selected app entry has invalid appDefinition.appDefaultLocale");
    }
  }
  return { appId: definition["id"], brand: definition["id"], appDefaultLocale, ownerLabels: new Map() };
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
  readonly ownerStorage?: TeamOwnerStorageBoundary;
  readonly selectedReceiptObserver?: SelectedReceiptObserverBinding;
  readonly mcp: McpJoin | undefined;
  readonly http: HttpJoin | undefined;
  readonly browserAssets?: BrowserAssetsHandler;
  readonly pageHandler?: (request: Request) => Promise<Response>;
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
    catalog = createArtifactCatalog(ctx.artifact, ctx.mcp?.derivedInputs);
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
    // T16b: the MCP path threads canonical admission deps (the live
    // identity store, the source label, the worker clock). T17b: the
    // interim direct path is retired — descriptor-less artifacts refuse.
    invoker: buildInvoker(ctx.artifact, ctx.asm, ctx.store, {
      memberships: ctx.identityStore as CanonicalMembershipReader,
      source: "mcp",
      appInfo: ctx.app,
      now,
      ...(ctx.ownerStorage === undefined ? {} : { ownerStorage: ctx.ownerStorage }),
      ...(ctx.selectedReceiptObserver === undefined ? {} : { selectedReceiptObserver: ctx.selectedReceiptObserver }),
      ...(ctx.files?.canonical === undefined ? {} : { files: ctx.files.canonical }),
    }),
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

/** C3 `/api/operations/` prefix (mirrors `OPERATIONS_PREFIX` in interfaces routing). */
/** Shared HTTP sink; Interfaces owns redaction before journal delivery. */
const httpLogger: Logger = {
  log: (level, message, fields): void => {
    if (fields === undefined) console.log(`[http] ${level} ${message}`);
    else console.log(`[http] ${level} ${message}`, fields);
  },
};

const HTTP_OPERATIONS_PREFIX = "/api/operations/";

/**
 * C3 `/api/operations/*` route: assemble the real `HttpDeps` and
 * delegate to the injected op handler (the real
 * `handleOperationRequest`). Every method delegates (the handler owns
 * method semantics: non-POST is `not_found`); without the factory the
 * route keeps the explicit interim 501. Catalog build failures are
 * contained here as a 500 naming the entry — pages keep serving.
 *
 * The catalog serves the SAME baked `derivedInputs` the MCP path
 * consumes, and the invoker is THE same `buildInvoker` bridge, so
 * browser/MCP bound rules and invocation agree by construction.
 * Members the op handler never touches (pages, limiter,
 * secureCookies, uploads, ingress) bind interim fail-closed stubs.
 */
async function handleHttpOperationRequest(
  req: Request,
  ctx: InterimDispatchContext,
  pathname: string,
): Promise<Response> {
  const factory = ctx.http?.createOperationHandler;
  if (factory === undefined || typeof factory !== "function") {
    return interimUnavailable(
      "operation invocation needs the interfaces join (handleOperationRequest via " +
        "AssemblyDeps.http.createOperationHandler); the worker serves pages only until it lands",
    );
  }
  let catalog: SchemaCatalog;
  try {
    const createArtifactCatalog = await loadSiblingFn<CreateArtifactCatalog>(
      "../runtime/mcp-registry.js",
      "runtime/mcp-registry.ts",
      "createArtifactCatalog",
    );
    catalog = createArtifactCatalog(ctx.artifact, ctx.http?.derivedInputs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ code: "http-catalog", message }, 500);
  }
  const now = ctx.now;
  const unjoined = (family: string): never => {
    throw new Error(`assembly: ${family} is unbound until its join lands (unreachable on the op route)`);
  };
  const deps: HttpDeps = {
    ...(ctx.http?.formBindings === undefined ? {} : { formBindings: ctx.http.formBindings }),
    inputChoices: async ({ identity, ...draft }) => {
      const lookup = await loadSiblingFn<typeof import('../runtime/input-choices.js').lookupInputChoicesCanonical>(
        '../runtime/input-choices.js', 'runtime/input-choices.ts', 'lookupInputChoicesCanonical',
      );
      const store = ctx.ownerStorage === undefined ? ctx.store : await ctx.ownerStorage.forIdentity(identity);
      return lookup({ ...draft, identity, artifact: ctx.artifact, asm: ctx.asm, store,
        memberships: ctx.identityStore as CanonicalMembershipReader, source: 'http', now,
        formatting: { appDefault: ctx.app.appDefaultLocale } });
    },
    app: ctx.app,
    pages: { descriptors: (): readonly PageDescriptor[] => [] },
    invoker: buildInvoker(ctx.artifact, ctx.asm, ctx.store, {
      memberships: ctx.identityStore as CanonicalMembershipReader,
      source: "http",
      appInfo: ctx.app,
      now,
      ...(ctx.ownerStorage === undefined ? {} : { ownerStorage: ctx.ownerStorage }),
      ...(ctx.selectedReceiptObserver === undefined ? {} : { selectedReceiptObserver: ctx.selectedReceiptObserver }),
      ...(ctx.files?.canonical === undefined ? {} : { files: ctx.files.canonical }),
    }),
    catalog,
    limiter: {
      check: async (): Promise<RateLimitDecision> => unjoined("rate limiter"),
    },
    logger: httpLogger,
    clock: { nowMs: () => now() },
    identity: {
      store: ctx.identityStore,
      mail: {
        sendMail: async (): Promise<void> => {
          throw new Error("assembly: mail is unbound on the HTTP op path (no op flow sends mail)");
        },
      },
      clock: { nowMs: () => now() },
      verifyBaseUrl: "",
      recoveryBaseUrl: "",
      inviteBaseUrl: "",
      sessionMaxAgeSeconds: 0,
    },
    // The op handler never writes cookies (identity resolves from the
    // request); the auth join owns the real deployment flag.
    secureCookies: false,
    uploads: {
      files: {
        usesFiles: (_app: AppInfo): boolean => {
          void _app;
          return ctx.files?.usesFiles ?? false;
        },
      },
      kernel: ctx.files?.kernel ?? {
        maxBytes: (): number => unjoined("file kernel"),
        createIntent: async (): Promise<InterimKernelCreateOutcome> => unjoined("file kernel"),
        append: async (): Promise<InterimKernelAppendOutcome> => unjoined("file kernel"),
        complete: async (): Promise<InterimKernelCompleteOutcome> => unjoined("file kernel"),
        finalize: async (): Promise<InterimKernelFinalizeOutcome> => unjoined("file kernel"),
      },
    },
    ingress: {
      bindings: { bindingFor: (): IngressBinding | null => unjoined("ingress bindings") },
      verifier: { verify: async (): Promise<VerifiedIngressEnvelope | null> => unjoined("ingress verifier") },
      sink: { accept: async (): Promise<{ accepted: boolean }> => unjoined("ingress sink") },
    },
  };
  let op = pathname.slice(HTTP_OPERATIONS_PREFIX.length);
  try {
    op = decodeURIComponent(op);
  } catch {
    // Malformed escape: pass through raw — the handler's operation
    // shape check answers `not_found` (never a 500).
  }
  return factory(deps)(req, op);
}

function buildInterimFetch(
  ctx: InterimDispatchContext,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const pathname = url.pathname;

    if (ctx.browserAssets?.paths.includes(pathname)) {
      return ctx.browserAssets.fetch(req);
    }

    if (pathname === "/mcp") {
      return handleMcpRequest(req, ctx);
    }
    if (pathname.startsWith(HTTP_OPERATIONS_PREFIX)) {
      return handleHttpOperationRequest(req, ctx, pathname);
    }
    if (pathname.startsWith("/auth/")) {
      const config = ctx.http?.auth;
      const join = ctx.http?.authHandler;
      if (join === undefined) {
        return interimUnavailable('auth routes need the defining handleAuthRequest join');
      }
      if (config === undefined || typeof config.limiter?.check !== 'function') {
        return jsonResponse({ code: 'auth-configuration',
          message: 'Authentication requires CAN_AUTH_ORIGIN or explicit trusted host auth configuration.' }, 500);
      }
      let origin: URL;
      try { origin = new URL(config.origin); }
      catch { return jsonResponse({ code: 'auth-configuration', message: 'Invalid host authentication configuration.' }, 500); }
      if (origin.origin !== config.origin || !['https:', 'http:'].includes(origin.protocol) ||
          typeof config.secureCookies !== 'boolean' || (origin.protocol === 'https:' && !config.secureCookies) ||
          !Number.isSafeInteger(join.sessionExpiresMs) || join.sessionExpiresMs <= 0) {
        return jsonResponse({ code: 'auth-configuration', message: 'Invalid host authentication configuration.' }, 500);
      }
      return join.createHandler({
        identity: { store: ctx.identityStore, clock: { nowMs: ctx.now },
          ...(config.mail === undefined ? {} : { mail: config.mail }),
          verifyBaseUrl: new URL('/auth/verify', origin).href,
          recoveryBaseUrl: new URL('/auth/recover', origin).href,
          inviteBaseUrl: new URL('/auth/invite', origin).href,
          sessionMaxAgeSeconds: join.sessionExpiresMs / 1000 },
        limiter: config.limiter, logger: httpLogger, clock: { nowMs: ctx.now }, secureCookies: config.secureCookies,
      })(req);
    }
    if (pathname.startsWith("/files/")) {
      if (ctx.files?.fetch !== undefined) return ctx.files.fetch(req);
      return interimFilesResponse(pathname, method, ctx.files);
    }
    if (ctx.pageHandler === undefined) return notFoundResponse();
    return ctx.pageHandler(req);
  };
}

/* ------------------------------------------------------------------ */
/* T24b dispatch system-command composition (worker assembly seam).     */
/*                                                                      */
/* The composition exists ONLY here: every other mention                */
/* (`[...l3Commands, ...WORK_SYSTEM_COMMANDS,                           */
/* ...WORK_DISPATCH_STAGE_COMMANDS]`) is a doc shape citing this seam.  */
/* Segments arrive injected (see the file header): the worker boundary  */
/* forbids even a type import from `@canlang/state`/`@canlang/work`,    */
/* so the seam is generic over the command type and reads `name` only.  */
/* Order is load-bearing (L3 first, then lane-04 lifecycle, then the    */
/* staging join) and names must be unique — the registry rejects        */
/* duplicates, so the seam fails loud here instead of shipping a        */
/* registry that cannot construct. Engine array sizes stay              */
/* engine-owned and are pinned work-side, never here.                   */
/* ------------------------------------------------------------------ */

/** T24b: the composable surface of one system command (structural). */
export interface DispatchComposedCommand {
  readonly name: string;
}

/** T24b: the three injected composition segments, in registry order. */
export interface DispatchCommandSegments<
  TCommand extends DispatchComposedCommand = DispatchComposedCommand,
> {
  /** L3 commands (`outbox.ack`, `schedule.*` — state dist). */
  readonly l3Commands: ReadonlyArray<TCommand>;
  /** Lane-04 lifecycle commands (`WORK_SYSTEM_COMMANDS` — injected). */
  readonly workCommands: ReadonlyArray<TCommand>;
  /** Staging-join commands (`WORK_DISPATCH_STAGE_COMMANDS` — injected). */
  readonly stageCommands: ReadonlyArray<TCommand>;
}

/**
 * T24b: compose the ONE serving registry shape
 * `[...l3Commands, ...workCommands, ...stageCommands]`. Pure and total
 * over well-formed segments: empty names and duplicate names fail loud
 * (a registry built from either could never construct). Returns a
 * frozen array; callers feed it to `createSystemRegistry` with a
 * dispatch-join-wrapped store (see `runtime/invoke.ts`).
 */
export function assembleDispatchCommands<
  TCommand extends DispatchComposedCommand = DispatchComposedCommand,
>(
  segments: DispatchCommandSegments<TCommand>,
): ReadonlyArray<TCommand> {
  const composed = [
    ...segments.l3Commands,
    ...segments.workCommands,
    ...segments.stageCommands,
  ];
  const seen = new Set<string>();
  for (const command of composed) {
    const name: unknown = command.name;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(
        "t24b: cannot assemble dispatch commands (a segment carries an empty command name)",
      );
    }
    if (seen.has(name)) {
      throw new Error(
        `t24b: cannot assemble dispatch commands (duplicate command ${JSON.stringify(name)})`,
      );
    }
    seen.add(name);
  }
  return Object.freeze(composed);
}

/* ------------------------------------------------------------------ */
/* T34-F7 fanout serving surface (worker assembly seam).               */
/*                                                                     */
/* The composition exists ONLY here: the deploy join binds the six     */
/* runtime entries (`runtime/invoke.ts` T34-F7 section) into the ONE   */
/* frozen serving surface the worker's fanout driver consumes.         */
/* Segments arrive injected (the worker boundary forbids even a type   */
/* import from `@canlang/state`/`@canlang/work`, so the seam is        */
/* generic over the entry types and checks callability only): the      */
/* deploy join supplies the real entries exactly as tests supply them  */
/* from runtime dist. Every segment is REQUIRED — a missing entry      */
/* fails loud here instead of shipping a surface that throws at        */
/* drive time.                                                         */
/* ------------------------------------------------------------------ */

/** T34-F7: the six injected fanout serving entries, in serving order. */
export interface FanoutServingSegments {
  /** Atomic trigger/intent staging (`stageFanoutTriggerJoin`). */
  readonly stageTriggerJoin: unknown;
  /** Durable fenced claim (`claimFanoutChild`). */
  readonly claimChild: unknown;
  /** Durable fenced record (`recordFanoutChildAttempt`). */
  readonly recordAttempt: unknown;
  /** Fair scheduler turn (`runFanoutSchedulerTurn`). */
  readonly runSchedulerTurn: unknown;
  /** Operator progress (`readFanoutSchedulerProgress`). */
  readonly readProgress: unknown;
  /** Provider cancellation (`requestFanoutProviderCancel`). */
  readonly requestCancel: unknown;
}

/**
 * T34-F7: compose the ONE fanout serving surface. Pure and total
 * over well-formed segments: missing or non-function entries fail
 * loud, naming the segment. Returns a frozen surface; callers keep
 * their entry types through the generic.
 */
export function assembleFanoutServingSurface<TSegments extends FanoutServingSegments>(
  segments: TSegments,
): Readonly<TSegments> {
  const entries = segments as unknown as Record<string, unknown>;
  for (const key of [
    "stageTriggerJoin",
    "claimChild",
    "recordAttempt",
    "runSchedulerTurn",
    "readProgress",
    "requestCancel",
  ] as const) {
    if (typeof entries[key] !== "function") {
      throw new Error(
        `t34-f7: cannot assemble fanout serving surface (segment ${JSON.stringify(key)} is not a function)`,
      );
    }
  }
  return Object.freeze({ ...segments });
}

/* ------------------------------------------------------------------ */
/* assembleWorker                                                      */
/* ------------------------------------------------------------------ */

/**
 * T16b serve-time contract gate (T04a §7): the loaded contracts copy
 * must carry exactly the T04a v1 pins, and the artifact's `requires[]`
 * must be fulfilled by this runtime — precise throws, never silent
 * fallback. Runs for EVERY artifact (pins and requires are
 * artifact-universal); fixtures with empty `requires[]` pass
 * trivially.
 */
async function assertServingContracts(artifact: CompileArtifact, http?: HttpJoin, cohorts?: CohortTickBinding): Promise<void> {
  const loadVersions = await loadSiblingFn<LoadContractVersions>(
    "../runtime/invoke.js",
    "runtime/invoke.ts",
    "loadContractVersions",
  );
  const assertPins = await loadSiblingFn<AssertT04aContractPins>(
    "../runtime/invoke.js",
    "runtime/invoke.ts",
    "assertT04aContractPins",
  );
  const assertRequires = await loadSiblingFn<AssertRequiresFulfilled>(
    "../runtime/invoke.js",
    "runtime/invoke.ts",
    "assertRequiresFulfilled",
  );
  const versions = await loadVersions();
  assertPins(versions);
  assertRequires(artifact.requires, { state: versions.state, values: versions.values,
    ...(cohorts?.version === 1 && typeof cohorts.tick === 'function' ? { cohorts: 1 } : {}),
    ...(http?.createOperationHandler?.inputChoicesVersion === undefined ? {} :
      { inputChoices: http.createOperationHandler.inputChoicesVersion }) });
}

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
    tick: async () => { throw Object.assign(new Error('activation-refused'), body); },
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
  const cohorts = deps.cohorts;
  if (cohorts !== undefined && (cohorts.version !== 1 || typeof cohorts.tick !== 'function')) {
    throw new Error('assembly: cohort tick needs its actual v1 binding.');
  }
  await assertServingContracts(artifact, deps.http, cohorts);
  const generatedArtifact = await loadSiblingFn<IsGeneratedArtifact>(
    "../runtime/invoke.js",
    "runtime/invoke.ts",
    "isGeneratedArtifact",
  );
  if (generatedArtifact(artifact)) {
    // Preload (and refuse) before serving: incompatible descriptors or
    // untranscribable gates throw here, and the per-artifact load warms
    // for every later invocation this worker serves.
    const preload = await loadSiblingFn<LoadCanonicalDescriptors>(
      "../runtime/invoke.js",
      "runtime/invoke.ts",
      "loadCanonicalDescriptors",
    );
    await preload(asm, artifact);
  }

  const { descriptors } = await loadPageRegistry(artifact, asm);
  if (deps.ownerStorage !== undefined && descriptors.length !== 0) {
    throw new Error('assembly: selected team owner storage has no qualified page routing boundary.');
  }

  const browserAssets = await deps.http?.loadBrowserAssets?.(descriptors);
  if (descriptors.length > 0 && deps.http?.createPageHandler === undefined) {
    throw new Error("assembly: selected pages require the defining handlePageRequest join");
  }

  const now = deps.now ?? Date.now;
  const appInfo = await loadAppInfo(artifact, asm);
  if (deps.ownerStorage !== undefined && deps.ownerStorage.app !== appInfo.appId) {
    throw new Error('assembly: selected owner storage disagrees with its declared app.');
  }
  let pageHandler: ((request: Request) => Promise<Response>) | undefined;
  if (deps.http?.createPageHandler !== undefined) {
    const createArtifactCatalog = await loadSiblingFn<CreateArtifactCatalog>(
      "../runtime/mcp-registry.js", "runtime/mcp-registry.ts", "createArtifactCatalog",
    );
    const queryRows = await loadSiblingFn<
      typeof import("../runtime/invoke.js").queryPageRowsCanonical
    >("../runtime/invoke.js", "runtime/invoke.ts", "queryPageRowsCanonical");
    const createReadScope = await loadSiblingFn<
      typeof import("../runtime/invoke.js").createPageReadScopeCanonical
    >("../runtime/invoke.js", "runtime/invoke.ts", "createPageReadScopeCanonical");
    pageHandler = deps.http.createPageHandler({
      ...(deps.http.formBindings === undefined ? {} : { formBindings: deps.http.formBindings }),
      ...(deps.http.preferences === undefined ? {} : { preferences: deps.http.preferences }),
      app: appInfo, pages: { descriptors: () => descriptors },
      catalog: createArtifactCatalog(artifact, deps.http.derivedInputs),
      logger: httpLogger,
      clock: { nowMs: now }, identity: { store: deps.identityStore },
      createReadScope: identity => createReadScope({
        asm, artifact, identity, store: deps.store,
        memberships: deps.identityStore as CanonicalMembershipReader, now,
        ...(deps.pageReads === undefined ? {} : { pageReads: deps.pageReads }),
        ...(deps.selectedReceiptObserver === undefined ? {} : { observer: deps.selectedReceiptObserver }),
      }),
      query: async (invocation, model, args) => {
        return queryRows({ asm, artifact, model, args, identity: invocation as ResolvedIdentity,
          store: deps.store, memberships: deps.identityStore as CanonicalMembershipReader, now,
          ...(deps.pageReads === undefined ? {} : { pageReads: deps.pageReads }) });
      },
    });
  }
  const innerFetch = buildInterimFetch({
    app: appInfo,
    now,
    files: deps.files,
    artifact,
    asm,
    store: deps.store,
    identityStore: deps.identityStore,
    ...(deps.ownerStorage === undefined ? {} : { ownerStorage: deps.ownerStorage }),
    ...(deps.selectedReceiptObserver === undefined ? {} : { selectedReceiptObserver: deps.selectedReceiptObserver }),
    mcp: deps.mcp,
    http: deps.http,
    ...(browserAssets === undefined ? {} : { browserAssets }),
    ...(pageHandler === undefined ? {} : { pageHandler }),
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
    ...(cohorts === undefined ? {} : { tick: () => cohorts.tick() }),
  };
}
