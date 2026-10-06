/**
 * Invocation-wire contracts: the one typed operation envelope, errors, and
 * upload/action transport shared by HTTP and MCP.
 *
 * Lane 06 producer file. Types and pinned wire facts only; no execution
 * engine. DESIGN.md sections 5, 7, 8, 10 are the normative sources; comments
 * cite the exact rule each shape implements.
 *
 * Import note: same as identity.ts — relative test-only imports until L7
 * join J1 assembles @canlang/contracts.
 */

import type { InstantString } from './identity.js';

/** Contract version. Bump only with a breaking shape change + owner handoff. */
export const WIRE_CONTRACT_VERSION = 1;

/**
 * Fully qualified canonical operation identity, e.g. "TeamTasks.Todo.create"
 * or "TeamTasks.complete". The business operation registry is the only
 * source of these identities (DESIGN sections 8, 10).
 */
export type FqOperationName = string;

/**
 * Stable UUIDv7 operation identity (DESIGN section 7). Caller-generated for
 * MCP; runtime-generated for browser forms. Retried/replayed submissions
 * reuse it; identities older than 24h are rejected with 5 minutes of future
 * clock tolerance.
 */
export type OperationId = string;

/** Stable caller-generated retry identity for one upload attempt, separate
 * from the later business operation_id (DESIGN section 8). */
export type UploadId = string;

/** Opaque completed-file reference. Possession alone grants nothing; only a
 * finalized upload owned by the current app/team/principal (or a readable
 * existing attachment) can attach, under rechecked destination limits
 * (DESIGN section 8). */
export type OpaqueFileId = string;

/** Opaque pagination cursor. Identity/team/query-bound; never hand-written. */
export type OpaqueCursor = string;

/**
 * Canonical decimal string: exact integer/decimal/money-minor/record-version
 * transport. Never a JSON number; never locale-formatted (DESIGN section 10:
 * "there is no magnitude-dependent wire type").
 */
export type DecimalString = string;

/** Reference input for reads: identity only (DESIGN section 10). */
export interface ReadRef {
  readonly id: string;
}

/**
 * Reference input for mutations: identity plus the expected admitted version
 * (DESIGN sections 5, 7, 10). Stale submitted versions yield `conflict`.
 */
export interface MutationRef {
  readonly id: string;
  readonly version: DecimalString;
}

/** Closed typed JSON object: unknown members fail validation. */
export type ClosedInputs = Record<string, unknown>;

/**
 * Canonical mutation invocation envelope: the HTTP-body and invocation-record
 * form shared by browser POST and CSV-row confirmations. MCP tool calls carry
 * a flat per-tool projection of this envelope instead: the operation is the
 * tool name, CRUD update args are `{record,changes,operation_id}`, and
 * scenario business inputs are named alongside `operation_id` (DESIGN
 * section 10). The S5 MCP adapter owns that projection; both forms admit
 * through the same canonical invocation with equal authority.
 */
export interface MutationEnvelope {
  readonly operation: FqOperationName;
  readonly operation_id: OperationId;
  /** Named business inputs per the owning operation schema, including
   * MutationRef values for record parameters. Identity, roles, and team
   * grants can never be arguments (DESIGN section 10). */
  readonly inputs: ClosedInputs;
}

/** Canonical read invocation envelope. Reads carry no operation_id. */
export interface ReadEnvelope {
  readonly operation: FqOperationName;
  readonly inputs: ClosedInputs;
}

/**
 * Business error codes. Closed set pinned by DESIGN section 10; the exact
 * observation semantics come from DESIGN section 5.1:
 * denied `by` -> forbidden; missing/foreign/expired refs -> not_found;
 * stale versions -> conflict; out-of-bounds valid inputs -> validation;
 * authored guards/invariants/locks -> rule_failed unless the production
 * contract specifies another safe code.
 */
export const BUSINESS_ERROR_CODES = [
  'validation',
  'forbidden',
  'not_found',
  'conflict',
  'rule_failed',
  'busy',
  'limit',
  'delivery_unknown',
] as const;

export type BusinessErrorCode = (typeof BUSINESS_ERROR_CODES)[number];

/** One safe field-level failure inside a business error. */
export interface FieldError {
  /** JSON Pointer into the submitted inputs, e.g. "/changes/title". */
  readonly path: string;
  readonly code: string;
  /** Safe, actionable, localized-eligible message. Never carries secrets,
   * tokens, SQL diagnostics, or confidential values. */
  readonly message: string;
}

/**
 * Business error envelope. Same meaning over HTTP, HTMX fragments, and MCP
 * (MCP: `isError=true`); protocol errors stay JSON-RPC errors (DESIGN
 * section 10). Existence-hiding lookups surface as `not_found`.
 */
export interface BusinessError {
  readonly code: BusinessErrorCode;
  readonly message: string;
  readonly operation_id?: OperationId;
  readonly fields?: readonly FieldError[];
  /** True when repeating the identical envelope may succeed
   * (e.g. `busy` contention, `delivery_unknown` reconciliation; DESIGN
   * section 7 retry/replay rules). Lane-06 authored member. */
  readonly retryable?: boolean;
}

/**
 * Canonical HTTP status per business error code. Both transports and every
 * future transport use this one table so rejection meaning never drifts.
 * Lane-06 authored mapping (DESIGN pins the codes, not the statuses):
 * rule_failed is 422 (well-formed but semantically rejected; distinct from
 * malformed-input 400); busy is 503; limit is 429; delivery_unknown is 502
 * (upstream accepted-or-not is uncertain; reconcile via operation_id).
 */
export const BUSINESS_ERROR_HTTP_STATUS: Record<BusinessErrorCode, number> = {
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
 * Delivery receipt summary shape, structurally pinned by DESIGN section 8
 * (DeliveryResult {id, status}; DeliveryError {code, message}, both required
 * non-null, no details/retryable/provider-response fields). Lane 04 owns the
 * delivery lifecycle; this restatement exists only so the mutation result
 * envelope below is closed, and must converge with lane-04 services.ts at
 * join J6 instead of drifting.
 */
export type DeliveryStatus = 'pending' | 'succeeded' | 'failed' | 'unknown' | 'skipped';

export interface DeliveryReceipt {
  readonly id: string;
  readonly status: DeliveryStatus;
}

/**
 * Every mutation result has {status,operation_id,records,deliveries,result}
 * with applicable members present (DESIGN section 10). `result` uses the
 * declared type made nullable for absent/expired/withheld content; replayed
 * responses may carry result=null when content expired or access withholds
 * it — never a synthesized partial result (DESIGN section 7).
 */
export type MutationOutcomeStatus = 'committed' | 'replayed';

export interface MutationResult {
  readonly status: MutationOutcomeStatus;
  readonly operation_id: OperationId;
  /** Authorized changed-record projections under current access/lifetime. */
  readonly records?: readonly unknown[];
  readonly deliveries?: readonly DeliveryReceipt[];
  readonly result?: unknown;
}

/** Pure reads return their declared shape (DESIGN section 10). */
export type ReadResult = unknown;

/**
 * Closed discriminated action reference (DESIGN section 10). The target is
 * always one of the compiled canonical operations; the protected binding is
 * runtime-owned. Remote references carry an opaque handle whose contents
 * clients cannot edit. Changed interface revisions invalidate sealed handles
 * rather than rewriting their authority (DESIGN section 11.3). Only the
 * opaque-handle and revision-invalidation semantics are DESIGN-pinned; the
 * inner `{kind,handle,target,revision}` member spelling is lane-06's.
 */
export interface SealedActionHandle {
  readonly kind: 'action_handle';
  readonly handle: string;
  readonly target: FqOperationName;
  /** Owning interface revision the handle was sealed against. */
  readonly revision: string;
}

/**
 * Canonical handle-mode invocation record where ordinary and handle
 * invocation are both exposed (DESIGN section 10). Handle mode carries the
 * sealed handle + operation_id + all non-record canonical inputs, omitting
 * every protected record input; the MCP tool projection flattens these to
 * sibling arguments (`action_handle`, `operation_id`, named inputs). An
 * ordinary remote mode requires its own declared delegated access; an
 * action handle does not authorize that mode.
 */
export interface ActionHandleInvocation {
  readonly action_handle: SealedActionHandle;
  readonly operation_id: OperationId;
  /** Non-record canonical inputs only. Record overrides fail. */
  readonly inputs: ClosedInputs;
}

/**
 * Upload intent request: POST /files/intents receives exactly
 * {upload_id,operation,field,arguments,name,type,size} (DESIGN section 8).
 * `field` is a JSON Pointer to the writable file input, including a CRUD
 * changes slot. `arguments` holds available canonical operation arguments
 * plus protected action-handle context with the selected file slot absent;
 * it may omit unfinished ordinary inputs but cannot invent inputs, override
 * protected bindings, or treat missing values as passing checks. `size` is
 * a canonical nonnegative integer string.
 */
export interface UploadIntentRequest {
  readonly upload_id: UploadId;
  readonly operation: FqOperationName;
  readonly field: string;
  readonly arguments: ClosedInputs;
  readonly name: string;
  readonly type: string;
  readonly size: DecimalString;
}

/**
 * Upload intent response: opaque intent identity plus generated same-origin
 * HTTPS destinations — never storage credentials. Filename and claimed
 * MIME/size stay untrusted metadata (DESIGN section 8).
 */
export interface UploadIntentResponse {
  readonly intent_id: string;
  readonly content: string;
  readonly finalize: string;
  readonly expires_at: InstantString;
}

/** Finalize response: the immutable opaque file reference (DESIGN section 8).
 * Repeating the same completed intent returns the same reference;
 * conflicting retry identity/context or replacement bytes fail. */
export interface UploadFinalizeResponse {
  readonly file: OpaqueFileId;
}

/**
 * MCP initialization advertises the byte-upload bridge once in
 * _meta["org.canlang/fileTransfer"] as {version:1,intents:...} when selected
 * runtime declarations use files. Can extension via MCP's metadata
 * mechanism, not a standard MCP byte-upload capability (DESIGN section 8).
 */
export interface FileTransferMeta {
  readonly version: 1;
  /** Same-origin HTTPS URL of POST /files/intents for the selected app. */
  readonly intents: string;
}

export const FILE_TRANSFER_META_KEY = 'org.canlang/fileTransfer';

/** Format annotation on file-valued generated JSON schema string slots.
 * Identifies the kind of input, not authority (DESIGN section 8). */
export const CAN_FILE_SCHEMA_FORMAT = 'can-file';

/**
 * Business tool definition generated from the owning operation registry:
 * stable names (package.Model.read/.list/.create/.update/.delete,
 * package.scenario), attached `#` descriptions, closed typed JSON schemas
 * (DESIGN section 10). `##` never leaves the source.
 */
export interface BusinessToolDefinition {
  readonly name: string;
  readonly description: string;
  /** Closed JSON Schema object: unknown arguments fail. */
  readonly inputSchema: Record<string, unknown>;
}

/** Bounded collection request: typed filters/order/cursor/limit constrained
 * by readable fields, plus a parent reference for children (DESIGN
 * sections 9, 10). Defaults: 25 rows, max 100. */
export interface CollectionRequest {
  readonly cursor?: OpaqueCursor;
  readonly limit?: number;
  readonly filters?: ClosedInputs;
  readonly order?: readonly string[];
  readonly parent?: ReadRef;
}

/** Pinned collection/page bounds (DESIGN section 9). */
export const COLLECTION_DEFAULT_LIMIT = 25;
export const COLLECTION_MAX_LIMIT = 100;
export const PAGE_MAX_RECORDS = 500;
/** 1 MiB response content cap per page render. */
export const PAGE_MAX_RESPONSE_BYTES = 1048576;

/** Pinned default upload policy (DESIGN section 8; REQUIREMENTS packages).
 * Baseline only: it never grants upload/download access. */
export const DEFAULT_UPLOAD_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'text/plain',
] as const;
export const DEFAULT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

/** Pinned CSV intake bounds (DESIGN section 9). */
export const CSV_IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const CSV_IMPORT_MAX_ROWS = 1000;

/* ------------------------------------------------------------------ */
/* T19a derived writable inputs: the interface-visible projection of   */
/* checked operation descriptors (L1 `ArtifactOperation`, T15a/T18     */
/* emission). Types and pinned rules only; the L6 derivation builders  */
/* live in @canlang/interfaces (`http/operations.ts`, `mcp/schemas.ts`,*/
/* `mcp/tools.ts`). Part of WIRE_CONTRACT_VERSION 1 (additive).       */
/*                                                                     */
/* Derivation rule (pinned here, implemented there): the writable      */
/* allowlist for one operation is exactly its emitted input names, in  */
/* emission order — nothing else is caller-suppliable. Server-owned    */
/* fields are engine-resolved (T18 R27) and NEVER derivable as inputs: */
/* the emitter excludes them from operation inputs, and a descriptor   */
/* carrying a `server`/`derived` input default is not a real emission  */
/* — derivation rejects it fail-closed instead of deriving a slot.    */
/* `literal`/`parent` defaults are documented optionality only: the    */
/* interface pins them verbatim for display/forms and submits exactly  */
/* what the caller supplied; omission always defers to the engine      */
/* (creates fill model-level defaults in the pipeline, scenario        */
/* defaults stay with the emitted callable — L3 admission fills no     */
/* operation-input defaults). The interface never invents fill values. */
/* ------------------------------------------------------------------ */

/**
 * T19a closed pilot input-kind vocabulary. Mirrors the non-`delivery`
 * members of L1 `ArtifactOperationField` exactly; `delivery` (bound
 * provider receipts) is T19b and derivation rejects it precisely.
 */
export type DerivedInputKind =
  | 'ref'
  | 'string'
  | 'integer'
  | 'decimal'
  | 'money'
  | 'datetime'
  | 'boolean'
  | 'file'
  | 'enum';

/**
 * T19a interface-visible default: the `literal`/`parent` subset of the
 * source default vocabulary, pinned verbatim. `literal` carries the
 * wire-encoded JSON value (ints/decimals as canonical decimal strings,
 * money as `{minor, currency}`); `parent` carries the dot path off the
 * loaded parent row (create only, leading `parent.` stripped).
 * `server`/`derived` can never appear here (see the rule above).
 */
export type DerivedInputDefault =
  | { readonly kind: 'literal'; readonly value: unknown }
  | { readonly kind: 'parent'; readonly path: string };

/**
 * T19a one derived writable input: a single caller-suppliable member of
 * an operation's closed envelope. `model`+`versioned` are present exactly
 * for `ref` (`versioned` selects the `MutationRef` `{id, version}` shape;
 * unversioned refs take the `ReadRef` `{id}` shape); `enumValues` is
 * present exactly for `enum`, in declaration order; `array` marks array
 * inputs (element kind in `kind`; ordinary omits to empty, required
 * rejects omission); `nullable` marks explicit-null acceptance.
 */
export interface DerivedWritableInput {
  readonly name: string;
  readonly kind: DerivedInputKind;
  readonly required: boolean;
  readonly nullable?: boolean;
  readonly array?: { readonly required: boolean };
  readonly default?: DerivedInputDefault;
  readonly model?: string;
  readonly versioned?: boolean;
  readonly enumValues?: readonly string[];
  readonly description?: string;
}

/**
 * T19a derived operation inputs: the writable allowlist plus documented
 * optionality for one checked operation. Envelope conformance: `inputs`
 * names are exactly the closed member set the `MutationEnvelope` /
 * `ReadEnvelope` `inputs` object may carry for `operation` (unknown
 * members fail `validation`); `required` names must be present;
 * versioned refs carry `MutationRef` versions whose staleness yields
 * `conflict`. `artifactVersion` is the artifact contract version the
 * derivation was validated against (always `ARTIFACT_VERSION`).
 */
export interface DerivedOperationInputs {
  readonly operation: FqOperationName;
  readonly kind: 'read' | 'create' | 'update' | 'delete' | 'scenario';
  readonly artifactVersion: number;
  readonly inputs: readonly DerivedWritableInput[];
}
