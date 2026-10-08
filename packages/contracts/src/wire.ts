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

/** Closed typed JSON object: declared own keys (including `__proto__`) are
 * data members; unknown members fail validation. */
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
/**
 * L3-carried conflict current (E2b/F1 Q3 join): the current row behind a
 * `conflict` (409) denial, so the re-render path — which cannot query
 * rows by design — can still show what changed. `values` is keyed by
 * GENERATED dot-path (`title`, `address.zip`), deliberately NOT JSON
 * Pointers, so entries cannot mis-join with `fields[].path` (which
 * points into submitted inputs).
 *
 * Population rules (fail-closed): `values` = submitted-input fields
 * intersect row data, MINUS serverOnly fields (exclusions threaded
 * from the table/descriptor holder) MINUS secret-kind values by shape
 * (defense-in-depth); absent keys are never null-guessed. Admission
 * populates full currents (row in hand, zero extra reads);
 * commit-race populates metadata + empty `values` (re-reading there
 * would be TOCTOU-indicative); fence-moved and receipt-reuse
 * conflicts leave `conflict` ABSENT (no row). `updatedBy` is
 * projection-visible metadata already — no new disclosure.
 */
export interface ConflictCurrent {
  readonly message: string;
  readonly current: {
    readonly model: string;
    readonly id: string;
    readonly version: number;
    readonly updated: string;
    readonly updatedBy: string;
    readonly values: { readonly [fieldPath: string]: unknown };
  };
}

export interface BusinessError {
  readonly code: BusinessErrorCode;
  readonly message: string;
  readonly operation_id?: OperationId;
  readonly fields?: readonly FieldError[];
  /** True when repeating the identical envelope may succeed
   * (e.g. `busy` contention, `delivery_unknown` reconciliation; DESIGN
   * section 7 retry/replay rules). Lane-06 authored member. */
  readonly retryable?: boolean;
  /** Present only on `conflict` denials with a carried row (see
   * `ConflictCurrent`); absent otherwise. Rendered by state
   * `toBusinessError` and every transport assembly mirror. */
  readonly conflict?: ConflictCurrent;
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
 * members of L1 `ArtifactOperationField` exactly.
 *
 * T19b adds `delivery` (bound provider receipts): the derived entry
 * carries the validated T13/T14 binding (capability + operation
 * identity, fenced version, declared result leaves) as an
 * engine-resolved declaration — never a submitted value.
 */
export type DerivedInputKind =
  | 'ref'
  | 'string'
  | 'integer'
  | 'decimal'
  | 'money'
  | 'datetime'
  | 'duration'
  | 'user'
  | 'boolean'
  | 'file'
  | 'enum'
  | 'delivery';

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
 * Operation-owned optional candidate assistance. The read declaration owns
 * the bounded model[] result and its schema; this binding copies neither.
 * Each argument is rooted in an owning operation input (empty path selects
 * that input directly). An absent draft prerequisite performs no lookup.
 *
 * Intake must explicitly reject unknown versions, unservable results,
 * unsupported paths, unknown argument mappings, dependency cycles, and
 * mutation/provider operations. Values must be scalar/ref compatible with
 * the assisted input; label fields must be readable candidate model leaves.
 * The picker assists an existing opaque input and preserves its original
 * defaults and final canonical checks; this shape grants no authority.
 * Grammar, checking and runtime intake are separate owning implementations.
 */
export interface InputChoiceBinding {
  readonly version: 1;
  readonly readOperation: FqOperationName;
  readonly arguments: Readonly<Record<string, {
    readonly input: string;
    readonly path: readonly string[];
  }>>;
  readonly value: { readonly kind: 'record' } | { readonly kind: 'field'; readonly field: string };
  readonly labels: readonly string[];
}

/**
 * T19a one derived writable input: a single caller-suppliable member of
 * an operation's closed envelope. `model`+`versioned` are present exactly
 * for `ref` (`versioned` selects the `MutationRef` `{id, version}` shape;
 * unversioned refs take the `ReadRef` `{id}` shape); `enumValues` is
 * present exactly for `enum`, in declaration order; `array` marks array
 * inputs (element kind in `kind`; ordinary omits to empty, required
 * rejects omission); `nullable` marks explicit-null acceptance.
 *
 * T19b: `delivery` is present exactly for `delivery` (the validated
 * provider-receipt binding, engine-resolved — never submitted);
 * `file` is present exactly for `file` (the interface-claimable
 * provenance/finalization boundary; everything else stays runtime-owned).
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
  readonly delivery?: DerivedDeliveryBinding;
  readonly file?: DerivedFileClaim;
  readonly description?: string;
  /** Checked operation-owned assistance; input type/default admission remains unchanged. */
  readonly choices?: InputChoiceBinding;
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
 *
 * T19b: `delivery` entries are declared bindings, not submittable
 * members — the closed envelope member set is the non-`delivery`
 * names. A submitted `delivery` member fails `validation` exactly
 * like an unknown member: receipts resolve engine-side and no
 * contract admits a caller-supplied receipt value.
 */
export interface DerivedOperationInputs {
  readonly operation: FqOperationName;
  readonly kind: 'read' | 'create' | 'update' | 'delete' | 'scenario';
  readonly artifactVersion: number;
  readonly inputs: readonly DerivedWritableInput[];
}

/* ------------------------------------------------------------------ */
/* T19b interface depth: delivery bindings, exact decimals, file       */
/* claims, bound arguments. Types and pinned rules only; the L6       */
/* derivation builders live in @canlang/interfaces (`mcp/schemas.ts`  */
/* shared core, `http/operations.ts` projection). Part of             */
/* WIRE_CONTRACT_VERSION 1 (additive).                                 */
/*                                                                     */
/* Delivery rule (pinned here, implemented there): a `delivery`        */
/* operation input derives to its validated provider-receipt binding   */
/* — capability + operation target identity against the T13            */
/* capability contracts, the frozen capability version fenced exact   */
/* (T04a §7, never negotiated), and the declared result nominal with  */
/* its T13c leaves — carried as an engine-resolved declaration. The   */
/* interface validates the descriptor fully and submits nothing for   */
/* it: no contract admits a caller-supplied receipt value (a          */
/* `SelectedReceiptProjection` cannot be submitted, a locator         */
/* carries store-minted identity — `work.ts`), so `delivery` names    */
/* stay out of the submittable allowlist on both transports. Unknown  */
/* capabilities, undeclared operations, version mismatch, undeclared  */
/* result nominals, and undeclared leaves reject the whole            */
/* descriptor precisely; bound-local deliveries have no T13 identity  */
/* and never take this shape.                                          */
/*                                                                     */
/* Decimal rule: derivation carries decimals as canonical decimal     */
/* strings end to end, never binary Numbers. `literal` defaults on    */
/* `integer`/`decimal`/`money` inputs validate at derivation:         */
/* integers are canonical digit strings in int64 range (the L2 wire   */
/* shape; the checker fences wider spellings with E3001); decimals    */
/* parse exact with at most 38 significant digits and 18 fractional   */
/* digits, spelling preserved (T11 — including R16 integral spellings */
/* with no int64 narrowing); money is exactly `{minor, currency}`    */
/* with a canonical int64 minor string. JSON numbers, malformed text, */
/* and out-of-range spellings reject precisely — the T11              */
/* range/ambiguity negatives stay rejected at the interface instead   */
/* of failing later at admission.                                      */
/*                                                                     */
/* File rule: the interface may claim exactly the file input slot,    */
/* the `can-file` schema format, and the submitted-value shape (one   */
/* opaque finalized file id string). Everything else stays            */
/* runtime-owned: intent minting, byte intake, content validation,    */
/* finalization, provenance binding (`FileProvenance`), lifecycle     */
/* (`StoredObjectState`), and attach authority (a finalized upload   */
/* owned by the current app/team/principal, or a readable existing   */
/* attachment, under rechecked destination limits — DESIGN section   */
/* 8, `files.ts`). The interface never validates content, never      */
/* mints provenance, and never reads past the opaque string.          */
/*                                                                     */
/* Bound-argument rule: a submitted value binds to its declared input */
/* before admission. Refs bind to ReadRef/MutationRef shape by the    */
/* `versioned` flag with canonical digit-string versions; enums bind  */
/* to declared-case membership; files bind to the opaque-string       */
/* shape; numerics bind to their canonical wire shapes; delivery      */
/* binds to nothing — any submitted value rejects. Binding mismatch   */
/* is `validation`; version staleness against the current admitted    */
/* version stays L3-owned (`conflict`). Strings, booleans, and        */
/* array-element nullability carry no declared set to bind and pass   */
/* through to L3 admission untouched. Datetimes are decoded at the   */
/* dispatcher boundary with the canonical values-wire decode (E2b):  */
/* millis-pinned RFC3339 UTC; L3 judges presence only.                */
/* ------------------------------------------------------------------ */

/**
 * T19b one declared provider-result leaf: the verbatim T13c spelling
 * (`name` + declared `type` text such as `text?`, `file[]`,
 * `enum(a,b)`, nominal refs) — carried, never re-interpreted
 * (T04b-p Decision 2: no structured tag vocabulary is grounded).
 */
export interface DerivedDeliveryLeaf {
  readonly name: string;
  readonly type: string;
}

/**
 * T19b declared provider result: the source nominal spelling (e.g.
 * `ImageRun`, never a TS wire alias) with its declared leaves.
 */
export interface DerivedDeliveryResult {
  readonly name: string;
  readonly leaves: readonly DerivedDeliveryLeaf[];
}

/**
 * T19b validated provider-receipt binding for one `delivery` input:
 * the T13 send-target identity (`capability` + `operation`), the
 * frozen capability contract version it fenced against, the declared
 * result, and the `delivery:<target>` recipe key (`DeliveryRecipeKey`
 * format, `state.ts`). Engine-resolved: documents what receipt the
 * engine supplies; the caller submits no value for it.
 */
export type DerivedDeliveryBinding = {
  readonly capability: string;
  readonly operation: string;
  readonly result: DerivedDeliveryResult;
  readonly recipe: string;
} & (
  | { readonly judgment?: false; readonly version: number }
  | { readonly judgment: true; readonly version: string }
);

/**
 * T19b interface-claimable file boundary for one `file` input: the
 * submitted value is exactly one opaque finalized file id string
 * (`OpaqueFileId`), rendered with the `can-file` schema format. All
 * provenance, finalization, content, lifecycle, and authority facts
 * stay runtime-owned (see the file rule above).
 */
export interface DerivedFileClaim {
  readonly valueShape: 'opaque-file-id';
  readonly format: typeof CAN_FILE_SCHEMA_FORMAT;
}

/** Freeze one leaf list (table construction only). */
function freezeDeliveryLeaves(leaves: DerivedDeliveryLeaf[]): readonly DerivedDeliveryLeaf[] {
  for (const leaf of leaves) Object.freeze(leaf);
  return Object.freeze(leaves);
}

/**
 * T19b declared provider-result leaves per result nominal: verbatim
 * transcription of the T13c `nominal_schema` leaf sets
 * (`compiler/src/analysis/catalog.rs` `T13A/B_NOMINAL_LEAVES`) for
 * exactly the eight result nominals the sixteen T13 send targets
 * declare — the only nominals a `delivery_descriptor` can render.
 * Producer order; frozen. Per-entry cites name the frozen
 * `services.ts` producer interface (mirroring the catalog cites).
 * Convergence: this table must stay char-identical to the catalog
 * rows; drift fails derivation against real emission.
 */
export const DELIVERY_RESULT_LEAVES: Readonly<Record<string, readonly DerivedDeliveryLeaf[]>> =
  Object.freeze({
    // `EmailAccepted` (services.ts:184).
    EmailAccepted: freezeDeliveryLeaves([{ name: 'reference', type: 'text' }]),
    // `ErrorAccepted` (services.ts:262).
    ErrorAccepted: freezeDeliveryLeaves([{ name: 'reference', type: 'text' }]),
    // `PaymentState` (services.ts:209).
    PaymentState: freezeDeliveryLeaves([
      { name: 'reference', type: 'text' },
      { name: 'revision', type: 'int' },
      { name: 'provider_reference', type: 'text?' },
      { name: 'amount', type: 'money' },
      { name: 'status', type: 'enum(pending,unknown,succeeded,failed)' },
      { name: 'checkout_url', type: 'url?' },
      { name: 'failure', type: 'enum(transient,action_required,permanent,cancelled)?' },
    ]),
    // `TextRun` (services.ts:806).
    TextRun: freezeDeliveryLeaves([
      { name: 'source', type: 'text' },
      { name: 'revision', type: 'int' },
      { name: 'sequence', type: 'int' },
      { name: 'state', type: 'enum(queued,running,succeeded,failed,unknown,cancelled)' },
      { name: 'content', type: 'text' },
      { name: 'used_tokens', type: 'int?' },
      { name: 'detail', type: 'text?' },
    ]),
    // `WorkflowInspection` (services.ts:857).
    WorkflowInspection: freezeDeliveryLeaves([{ name: 'fields', type: 'WorkflowField[]' }]),
    // `WorkflowValidation` (services.ts:867).
    WorkflowValidation: freezeDeliveryLeaves([
      { name: 'valid', type: 'bool' },
      { name: 'digest', type: 'text?' },
      { name: 'detail', type: 'text?' },
    ]),
    // Source `ImageRun` transcribes TS `ImageRunProgress`
    // (services.ts:919); `GeneratedImage` transcribes
    // `ImageFileOutput` (services.ts:902).
    ImageRun: freezeDeliveryLeaves([
      { name: 'source', type: 'text' },
      { name: 'revision', type: 'int' },
      { name: 'sequence', type: 'int' },
      { name: 'state', type: 'enum(queued,running,succeeded,failed,unknown,cancelled)' },
      { name: 'outputs', type: 'GeneratedImage[]' },
      { name: 'charged_jobs', type: 'int?' },
      { name: 'detail', type: 'text?' },
    ]),
    // `MailReplyOutcome` (services.ts:987).
    MailReplyOutcome: freezeDeliveryLeaves([
      { name: 'source', type: 'text' },
      { name: 'state', type: 'enum(accepted,not_sent,unknown)' },
      { name: 'reference', type: 'text?' },
      { name: 'detail', type: 'text?' },
    ]),
  });

/**
 * T19b declared leaves for one result nominal, or null when the
 * nominal declares nothing (unknown nominal — the derivation rejects
 * it as an undeclared result instead of deriving an empty set).
 */
export function deliveryResultLeaves(nominal: string): readonly DerivedDeliveryLeaf[] | null {
  if (!Object.hasOwn(DELIVERY_RESULT_LEAVES, nominal)) return null;
  return DELIVERY_RESULT_LEAVES[nominal] ?? null;
}
