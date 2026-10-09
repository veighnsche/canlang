/**
 * Interfaces ports: clock, structured logging, operation input shapes.
 *
 * `SchemaCatalog` is the minimal per-operation input-shape lookup the
 * envelope validators need. The production binding reads the owning L1
 * operation registry (join J3); tests use a stub map. Full JSON-schema
 * validation of business inputs stays with the canonical invocation (L3);
 * this layer checks framing (closed members, required presence) plus
 * bound-argument binding against the derived inputs when the catalog
 * carries them (`derivedFor`, E1).
 */
import type { CanTypeId } from '@canlang/contracts/values';

export interface InterfacesClock {
  nowMs(): number;
}

export const systemInterfacesClock: InterfacesClock = { nowMs: () => Date.now() };

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured log sink. Implementations must never log secrets; use
 * `errors/redact` before journaling untrusted values. */
export interface Logger {
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
}

/** Minimal input-shape descriptor for one canonical operation. */
export interface OperationInputShape {
  /** Allowed top-level input members (closed object). */
  readonly allowed: readonly string[];
  /** Required top-level input members (subset of allowed). */
  readonly required: readonly string[];
}

export interface SchemaCatalog {
  shapeFor(operation: string): OperationInputShape | null;
  /**
   * E1 binding-visibility channel: the derived writable inputs for one
   * operation (submittable writables plus engine-resolved delivery
   * bindings), or null when the binding serves framing shapes only.
   * Dispatch invokes the pure bound checker (`checkBoundArguments`)
   * against these inputs after the framing checks; an absent channel
   * keeps framing-only behavior (legacy/test doubles).
   */
  derivedFor?(operation: string): DerivedOperationInputs | null;
}

/* ------------------------------------------------------------------ */
/* S4 HTTP dispatch ports.                                             */
/*                                                                     */
/* Production bindings: AppInfo + PageRegistry read the owning L1      */
/* artifact/registry (join J3); OperationInvoker is the L3 canonical   */
/* invocation callable (join J2); RateLimiter counters live in durable */
/* storage at B1 (memory double here is per-isolate only). Tests use    */
/* the doubles in testing.ts.                                          */
/* ------------------------------------------------------------------ */

import type {
  BusinessError,
  ClosedInputs,
  ContentCheck,
  DerivedOperationInputs,
  FinalizedFile,
  FinalizeResult,
  MessageValue,
  MutationEnvelope,
  MutationResult,
  PageDescriptor,
  PageReadScope,
  ReadEnvelope,
  ReadResult,
  ResolvedIdentity,
  RowQueryRunner,
  UploadIntentGrant,
  UploadIntentRequest,
} from '@canlang/contracts';
import type { VerifiedIngressEnvelope } from '@canlang/contracts';
export type { VerifiedIngressEnvelope };
import type { Clock, IdentityStore, MailPort } from '@canlang/identity';

/** Current request facts; session bearer stays inside the server. */
export interface SourceFormBindingContext {
  readonly appId: string;
  readonly sessionToken: string;
  readonly identity: ResolvedIdentity;
  readonly derived: DerivedOperationInputs;
  readonly operationId: string;
  readonly nowMs: number;
  /** Presentation comparison only; excluded from sealed submission authority. */
  readonly occurrence?: string;
}

/** Protects source bindings; canonical admission still decides permission. */
export interface SourceFormBindingProof {
  readonly token: string;
  /** Stable for the same binding and current context, independent of nonce/expiry. */
  readonly identity: string;
  /** Comparison-only draft compatibility; versions may change, protected tokens must refresh. */
  readonly draftIdentity: string;
}

export interface SourceFormBindings {
  seal(context: SourceFormBindingContext, bound: ClosedInputs, editable: readonly string[]): Promise<SourceFormBindingProof>;
  restore(context: SourceFormBindingContext, token: string, inputs: ClosedInputs): Promise<ClosedInputs | null>;
  /** Expired checked CRUD proof; recovered inputs require receipt-only invocation. */
  restoreRetained?(context: SourceFormBindingContext, token: string, inputs: ClosedInputs): Promise<ClosedInputs | null>;
}

/** Owning-app facts the shell needs. L1 binds from appDefinition. */
export interface AppInfo {
  /** Canonical selected-app identity (provenance `app` slot). L1 binds. */
  readonly appId: string;
  readonly brand: MessageValue;
  readonly appDefaultLocale: string;
  /** Owner labels keyed by canonical owner (package metadata). */
  readonly ownerLabels: ReadonlyMap<string, MessageValue>;
}

/** Source-derived page set, in appDefinition.pages order. L1 binds. */
export interface PageRegistry {
  descriptors(): readonly PageDescriptor[];
}

/** Canonical invocation outcome: result or safe business error. */
export type MutationOutcome = { result: MutationResult } | { error: BusinessError };
export type ReadOutcome = { result: ReadResult } | { error: BusinessError };

/** L3 canonical invocation callable (admission + commit + projection). */
export interface OperationInvoker {
  invokeMutation(envelope: MutationEnvelope, identity: ResolvedIdentity): Promise<MutationOutcome>;
  /** Current-authority saved CRUD outcome only; never executes an unseen identity. */
  invokeRetainedMutation?(envelope: MutationEnvelope, identity: ResolvedIdentity): Promise<MutationOutcome>;
  invokeRead(envelope: ReadEnvelope, identity: ResolvedIdentity): Promise<ReadOutcome>;
}

/** Candidate values use the owning input's wire type; labels are granted text only. */
export interface InputChoiceResult {
  readonly state: 'ready' | 'absent';
  readonly choices: readonly { readonly value: unknown; readonly labels: readonly string[] }[];
}

/** Canonical owner resolves mapped paths and the declared read under current authority. */
export type InputChoiceLookup = (request: {
  readonly derived: DerivedOperationInputs;
  readonly input: string;
  readonly inputs: ClosedInputs;
  readonly identity: ResolvedIdentity;
}) => Promise<InputChoiceResult>;

/** Fixed-window rate check for unauthenticated auth endpoints. */
export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
}

export interface RateLimiter {
  check(key: string, limit: number, windowMs: number): Promise<RateLimitDecision>;
}

/** Identity stack for auth routes + request identity resolution. */
export interface IdentityDeps {
  readonly store: IdentityStore;
  readonly mail: MailPort;
  readonly clock: Clock;
  /** Absolute page URLs receiving `?token=` links (browser routes). */
  readonly verifyBaseUrl: string;
  readonly recoveryBaseUrl: string;
  readonly inviteBaseUrl: string;
  readonly sessionMaxAgeSeconds: number;
}

/**
 * Assembled HTTP dependencies. The L7 worker assembly constructs these
 * from environment bindings at B1; S4 tests construct them directly.
 */
/** Page serving uses the owning identity store and authorized collection runner. */
export interface PageHttpDeps {
  readonly app: AppInfo;
  readonly pages: PageRegistry;
  readonly logger: Logger;
  readonly clock: InterfacesClock;
  readonly identity: Pick<IdentityDeps, 'store'>;
  /** Absent joins refuse queries; non-query pages need no collection backend. */
  readonly query?: RowQueryRunner;
  /** Construct once after verified page admission; the owner binds current read authority. */
  readonly createReadScope?: (identity: ResolvedIdentity) => PageReadScope | Promise<PageReadScope>;
  /** The same checked operation catalog used by canonical HTTP submission. */
  readonly catalog?: SchemaCatalog;
  /** Explicit stable host-private protection; absent leaves bound forms unavailable. */
  readonly formBindings?: SourceFormBindings;
  /** Durable actor/team scoped enum preference store; required by bound page selectors. */
  readonly preferences?: PagePreferenceStore;
}

export interface PagePreferenceKey {
  readonly appId: string;
  readonly actorUserId: string;
  readonly teamId: string;
  readonly owner: string;
  readonly field: string;
}

export interface PagePreferenceRecord {
  readonly value: string;
  /** Decimal nonnegative revision, `0` before the first save. */
  readonly version: string;
}

export interface PagePreferenceStore {
  read(key: PagePreferenceKey): Promise<PagePreferenceRecord | null>;
  /** Atomic compare-and-set; returns false when the observed version changed. */
  save(key: PagePreferenceKey & { readonly value: string; readonly expectedVersion: string }): Promise<boolean>;
}

/** Defining auth dependencies; absent mail refuses mail-producing flows before effects. */
export interface AuthHttpDeps extends Pick<HttpDeps, 'clock' | 'logger' | 'limiter' | 'secureCookies'> {
  readonly identity: Omit<IdentityDeps, 'mail'> & { readonly mail?: MailPort };
}

export interface HttpDeps extends PageHttpDeps {
  readonly invoker: OperationInvoker;
  readonly inputChoices?: InputChoiceLookup;
  readonly catalog: SchemaCatalog;
  readonly limiter: RateLimiter;
  readonly logger: Logger;
  readonly clock: InterfacesClock;
  readonly identity: IdentityDeps;
  /** Secure cookie flag; false only for local http:// development. */
  readonly secureCookies: boolean;
  /** Upload-transport bindings (S6). L7 assembles; L4 kernel at B1. */
  readonly uploads: {
    readonly files: FileUseInfo;
    readonly kernel: FileKernel;
  };
  /** Provider-ingress bindings (S7). L7 assembles; L4 verifier at S8. */
  readonly ingress: {
    readonly bindings: IngressBindings;
    readonly verifier: IngressVerifier;
    readonly sink: IngressSink;
  };
}

/* ------------------------------------------------------------------ */
/* S5 MCP server ports.                                                */
/*                                                                     */
/* Production bindings: OperationRegistry reads the owning L1          */
/* operation registry (join J3) with author descriptions and typed     */
/* input fields; McpPermissions rechecks L3 grants per call (join J2); */
/* McpFilesInfo reports L1/L7 file-upload support. Tests use the       */
/* doubles in testing.ts.                                              */
/* ------------------------------------------------------------------ */

/** Typed input field for generated MCP tool schemas (closed objects). */
export type McpSchemaField =
  | { readonly kind: 'nominal'; readonly name: string; readonly valueTypes: import('@canlang/contracts').CanonicalValueTypes }
  | { readonly kind: 'ref'; readonly model: string; readonly requireVersion: boolean }
  | { readonly kind: 'string' }
  | { readonly kind: 'integer' }
  | { readonly kind: 'decimal' }
  | { readonly kind: 'money' }
  | { readonly kind: 'datetime' }
  | { readonly kind: 'duration' }
  | { readonly kind: 'user' }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'file' }
  | { readonly kind: 'enum'; readonly values: readonly string[] };

export interface McpNamedField {
  readonly name: string;
  readonly field: McpSchemaField;
  /** Optional owning compiler claim; a bare string kind cannot establish text. */
  readonly valueType?: CanTypeId;
  readonly required: boolean;
  /** Authored `@{desc="..."}` text, verbatim; absent when not authored (MCP P4). */
  readonly description?: string;
}

/** Typed input schema for one operation; rendered closed. */
export interface McpInputSchema {
  readonly fields: readonly McpNamedField[];
}

export type McpOperationKind =
  | 'read'
  | 'list'
  | 'create'
  | 'update'
  | 'delete'
  | 'scenario'
  | 'team';

/**
 * One generated tool source: canonical operation name, authored `#`
 * description, kind, and typed inputs. Descriptions are derived once here;
 * both transports share the same registry.
 */
export interface OperationDescriptor {
  /** Canonical name: `package.Model.read`, `package.scenario`, `system.team.*`. */
  readonly name: string;
  readonly kind: McpOperationKind;
  /** Authored `#` description text, verbatim. */
  readonly description: string;
  readonly inputs: McpInputSchema;
}

/** Owning-operation registry the MCP tool list is generated from. */
export interface OperationRegistry {
  list(app: AppInfo): readonly OperationDescriptor[];
}

/**
 * Per-call permission rechecks against current identity/grants. Discovery
 * filters the tool list; invocation rechecks before every call.
 */
export interface McpPermissions {
  canDiscover(identity: ResolvedIdentity, operation: string): boolean | Promise<boolean>;
  canCall(identity: ResolvedIdentity, operation: string): boolean | Promise<boolean>;
}

/** Whether the selected app uses files (upload admission + `_meta`). */
export interface FileUseInfo {
  usesFiles(app: AppInfo): boolean;
}

/** File-upload support facts for the `_meta` capability advertisement. */
export interface McpFilesInfo extends FileUseInfo {
  intentsUrl(app: AppInfo): string;
}

/** Assembled MCP dependencies. The L7 worker assembly constructs these. */
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

/* ------------------------------------------------------------------ */
/* S6 upload-transport ports.                                          */
/*                                                                     */
/* The `FileKernel` port mirrors the real L4 file kernel entry points  */
/* (join J6): `createUploadIntent`/`appendUploadContent`/               */
/* `completeUploadContent` (packages/files/src/upload/index.ts) behind */
/* the bridge v1 wrappers `handleCreateIntent`/`handleFinalize`        */
/* (packages/files/src/bridge.ts), plus `finalizeUpload`               */
/* (packages/files/src/finalize/index.ts). @canlang/files ships no     */
/* built surface yet, so S6 cannot import its types directly; the      */
/* outcome unions below restate the L4 shapes with @canlang/contracts  */
/* file types, and B1 (real binding) is the compile-time forcing       */
/* function. The port is async: L4's current kernel is sync, but       */
/* durable stores behind it are async, so the async shape is stable    */
/* across the S8 join. S6 tests script this port (routing/auth/        */
/* mapping); kernel semantics stay covered by L4's journey tests, and  */
/* a /tmp probe exercises the real kernel through these routes.        */
/* ------------------------------------------------------------------ */

/**
 * Receiving identity for upload provenance. Structural mirror of L4
 * `ReceivingContext` (packages/files/src/provenance/index.ts): every
 * field is non-empty at the route layer (lane-06 decision: the `team`
 * slot falls back to the user id in non-team apps, so per-user uploads
 * stay expressible — L4's binder rejects empty fields).
 */
export interface UploadReceiver {
  readonly app: string;
  readonly team: string;
  readonly owner: string;
  readonly principal: string;
}

/**
 * Delivery binding for request provenance. Structural mirror of L4
 * `RequestProvenanceBinding`: adapter is the constant `bridge-v1`,
 * deliveryId the caller retry identity (`upload_id`), resultPath the
 * target field pointer.
 */
export interface UploadBinding {
  readonly adapter: string;
  readonly deliveryId: string;
  readonly resultPath: string;
}

/** Mirror of L4 `CreateIntentOutcome` (upload/index.ts). */
export type KernelCreateOutcome =
  | { readonly status: 'granted'; readonly grant: UploadIntentGrant; readonly intentId: string }
  | { readonly status: 'duplicate'; readonly grant: UploadIntentGrant; readonly intentId: string }
  | { readonly status: 'rejected'; readonly reason: 'invalid-request' | 'conflict' | 'oversized' | 'unauthorized' };

/** Mirror of L4 `AppendOutcome` (upload/index.ts). */
export type KernelAppendOutcome =
  | { readonly status: 'appended'; readonly receivedBytes: number }
  | { readonly status: 'failed'; readonly reason: 'foreign' | 'closed' | 'expired' | 'oversized' };

/** Mirror of L4 `CompleteOutcome` (upload/index.ts). */
export type KernelCompleteOutcome =
  | { readonly status: 'completed'; readonly check: ContentCheck }
  | { readonly status: 'failed'; readonly reason: 'foreign' | 'closed' | 'expired' | 'partial' | 'oversized' }
  | { readonly status: 'failed'; readonly reason: 'malformed' | 'rejected'; readonly check: ContentCheck };

/** Mirror of L4 `FinalizeOutcome` (finalize/index.ts). */
export type KernelFinalizeOutcome =
  | { readonly status: 'finalized'; readonly result: FinalizeResult; readonly file: FinalizedFile }
  | { readonly status: 'repeated'; readonly result: FinalizeResult; readonly file: FinalizedFile }
  | { readonly status: 'failed'; readonly reason: 'foreign' | 'partial' | 'conflict' | 'expired' };

/** L4 file-kernel entry points behind the lane-06 principal binding. */
export interface FileKernel {
  /** Effective per-transfer byte ceiling (L4 policy owns the value). */
  maxBytes(): number | Promise<number>;
  createIntent(input: {
    request: UploadIntentRequest;
    receiver: UploadReceiver;
    binding: UploadBinding;
  }): Promise<KernelCreateOutcome>;
  append(intentId: string, caller: UploadReceiver, chunk: Uint8Array): Promise<KernelAppendOutcome>;
  complete(intentId: string, caller: UploadReceiver): Promise<KernelCompleteOutcome>;
  finalize(input: {
    intentId: string;
    retryId: string;
    bytesDigest: string;
    caller: UploadReceiver;
  }): Promise<KernelFinalizeOutcome>;
}

/** Assembled upload-transport dependencies. */
export interface UploadDeps {
  readonly app: AppInfo;
  readonly files: FileUseInfo;
  readonly kernel: FileKernel;
  readonly identity: IdentityDeps;
  readonly logger: Logger;
  readonly clock: InterfacesClock;
}

/* ------------------------------------------------------------------ */
/* S7 provider-ingress ports.                                          */
/*                                                                     */
/* Lane 06 owns the ingress endpoint + handler-context construction;   */
/* lane 4 owns typed per-adapter verification (the `IngressVerifier`   */
/* port; no L4 verifier has landed yet, so B1/S8 binds it). No raw     */
/* request can manufacture a trusted handler context: the route only   */
/* builds one from verifier output, and the mapper takes no raw input. */
/* The consuming event kernel (L3/L7) binds `IngressSink` at B1.       */
/* ------------------------------------------------------------------ */

/**
 * Deployment-bound ingress namespace: fixes the allowed team/resource
 * namespace plus the adapter whose verifier authenticates producers.
 * Secrets stay server-side; this type carries none.
 */
export interface IngressBinding {
  readonly namespace: string;
  readonly adapter: string;
  readonly team: string;
  readonly owner: string;
}

export interface IngressBindings {
  bindingFor(namespace: string): IngressBinding | null;
}

/**
 * L4 typed verification: authenticate the producer from raw headers +
 * bytes per the binding's adapter, returning the verified causation
 * envelope or null (fail closed, no oracle detail).
 */
export interface IngressVerifier {
  verify(
    binding: IngressBinding,
    input: { headers: Record<string, string>; body: Uint8Array },
  ): Promise<VerifiedIngressEnvelope | null>;
}

/**
 * Trusted handler context for a verified provider event. `actor` is
 * always null (DESIGN section 8: the handler retains actor=null);
 * authority flows from the binding + verified causation only.
 */
export interface DelegatedContext {
  readonly actor: null;
  readonly team: string;
  readonly owner: string;
  readonly namespace: string;
  readonly causation: VerifiedIngressEnvelope;
}

/** Consuming event kernel (L3/L7 at B1). */
export interface IngressSink {
  accept(context: DelegatedContext, event: unknown): Promise<{ accepted: boolean }>;
}

/** Assembled ingress dependencies. */
export interface IngressDeps {
  readonly bindings: IngressBindings;
  readonly verifier: IngressVerifier;
  readonly sink: IngressSink;
  readonly logger: Logger;
  readonly clock: InterfacesClock;
}

/* ------------------------------------------------------------------ */
/* S7 OAuth ports.                                                     */
/*                                                                     */
/* Lane 06 is its own authorization server (public clients, PKCE S256  */
/* only, access-token = McpGrant Bearer, no refresh in v1). Metadata  */
/* origins derive per-request from the request URL (same-origin).      */
/* ------------------------------------------------------------------ */

/** Assembled OAuth dependencies (subset of HttpDeps + store). */
export interface OAuthDeps {
  readonly identity: IdentityDeps;
  readonly limiter: RateLimiter;
  readonly logger: Logger;
  readonly clock: InterfacesClock;
}
