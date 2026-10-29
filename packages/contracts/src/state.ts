import type { CanTypeId, WireValue } from './values.js';
import type { ArtifactCallable, ArtifactCommittedChangeDescriptor, ArtifactDeliveryDescriptor,
  ArtifactJudgmentDeliveryDescriptor, ArtifactModel, ArtifactNominalResult, ArtifactOperation,
  ArtifactOperationInput, ArtifactSource } from './artifact.js';
import type { FinalizedFileIdentity, FinalizedFileReceiver, FinalizedFileRef,
  FileRetentionPolicy, RetainedFinalizedFile } from './files.js';
import type { JudgmentSpec } from './services.js';
import type { CommittedChangeEvent, OccurrenceId, ReceiptError, TerminalReceiptStatus, WorkScope } from './work.js';

/**
 * Lane 03 producer contract: authoritative state boundary (types only).
 *
 * This file carries the shared data/type shapes for canonical invocation,
 * revision-fenced commit, authorized queries and receipts. It defines no
 * execution engine, catalog entries, or behavior. Consumers must not guess
 * imports: this is the single definition of these shapes.
 *
 * Status: v1 draft for slice S1. Storage/query ports will grow in S2/S4;
 * system-command ports land in S6. Breaking changes need the affected
 * owners' explicit handoff per docs/implementation/CONTRACTS.md.
 */

/** This contract's version. The state engine build checks it against its own. */
export const STATE_CONTRACT_VERSION = 1;

/** Stable business error codes (DESIGN §10). No other machine codes. */
export type StateErrorCode =
  | 'validation'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rule_failed'
  | 'busy'
  | 'limit'
  | 'delivery_unknown';

/** Opaque stable record identifier. */
export type RecordId = string & { readonly __brand: 'RecordId' };

/** Record version: integer >= 1, advances once per accepted row-write. */
export type RecordVersion = number & { readonly __brand: 'RecordVersion' };

/** Database-wide optimistic fence revision: integer >= 0, never resets. */
export type Revision = number & { readonly __brand: 'Revision' };

/** Stable UUIDv7 operation identity, caller- or runtime-generated. */
export type OperationId = string & { readonly __brand: 'OperationId' };

/** Fully qualified operation identity, e.g. `expenses.approve`, `TeamTasks.Todo.create`. */
export type OperationName = string & { readonly __brand: 'OperationName' };

/** Canonical model identity, e.g. `expenses.Expense`. */
export type ModelName = string & { readonly __brand: 'ModelName' };

/** How the invocation was admitted. `test` is isolated fixture authority only. */
export type AdmissionKind = 'user' | 'trusted' | 'system' | 'test';

/**
 * Host-selected mutation admission; retained recovery never executes an unseen
 * identity and rechecks current operation authority. Result disclosure still
 * belongs to the host's current grant/secret-aware projection.
 */
export type MutationAdmissionMode = 'execute-or-replay' | 'retained-receipt-only';

/** Authenticated account; stable id only, no directory fields. */
export interface Principal {
  readonly userId: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
}

/** Resolved team scope for team-owned work. */
export interface TeamScope {
  readonly teamId: string;
  readonly timezone: string;
}

/**
 * Frozen canonical invocation context. `now` (ms epoch) is fixed at admission
 * and stable across internal retries; generated IDs/random values likewise.
 * Trusted handlers have `actor: null` with verified-source attribution.
 */
export interface InvocationContext {
  readonly kind: AdmissionKind;
  readonly app: string;
  readonly actor: Principal | null;
  readonly team: TeamScope | null;
  readonly operation: OperationName;
  readonly operationId: OperationId;
  /** Invocation source, e.g. `browser`, `mcp`, `call`, `schedule`, `test`. */
  readonly source: string;
  /** Frozen admission clock, milliseconds since Unix epoch. */
  readonly now: number;
  /** Verified trusted-source attribution when `actor` is null. */
  readonly trustedSource?: string;
}

/** Receipt identity: app, owner scope, principal, operation, id. */
export interface ReceiptIdentity {
  readonly app: string;
  /** Owning scope: team id or `app` for app-scoped work. */
  readonly owner: string;
  /** Stable principal key: user id or trusted-source identity. */
  readonly principal: string;
  readonly operation: OperationName;
  readonly operationId: OperationId;
}

/** Checked source closure for one selected return evaluation path, not a grant.
 * Decision-only business checks are excluded; data and return-controlling reads
 * are required observations. Compiler owns complete branch/derive/call closure.
 */
export interface ScenarioReceiptSourceOrigin {
  readonly path: string; readonly sha256: string; readonly module: string;
}
/** Intrinsics are distinct from declared row fields. This finite profile
 * supports admitted invocation identity, an explicitly supplied required
 * singular primitive input, and a required singular versioned reference
 * parameter's ORIGINAL version, never its provisional row version.
 */
export interface ScenarioReceiptCreatedRoot {
  readonly id:string;readonly node:{readonly start:number;readonly end:number};readonly stage:number;
  readonly binding:string;readonly model:ModelName;readonly parentParameter:string;readonly parentModel:ModelName;
}
export type ScenarioReceiptIntrinsicDependency = {
  readonly id: string;
  readonly source: ScenarioReceiptSourceOrigin;
  readonly role: 'data' | 'control';
  readonly type: CanTypeId;
} & ({ readonly kind: 'operation-id' } | {
  readonly kind: 'admitted-input'; readonly parameter: string;
} | {
  readonly kind: 'admitted-reference-version'; readonly parameter: string; readonly model: ModelName;
} | { readonly kind:'created-model-version';readonly created:ScenarioReceiptCreatedRoot;
});
/** Checked query occurrence; declarations and source correspondence grant no authority. */
export interface ScenarioReceiptQueryPlan {
  readonly id: string;
  readonly source: ScenarioReceiptSourceOrigin;
  readonly model: ModelName;
  /** Optional contained domain; omission preserves existing unscoped plans.
   * `model` must match the queried ArtifactModel.parent. Compiler associates
   * the exact parent-selector source with an admitted reference parameter or
   * a prior checked stored-reference dependency, never a literal row ID.
   * State resolves it at the original owner/stage/physical store and checks
   * source, ancestors and full Identity authority before reading children. */
  readonly parent?: {
    readonly source: ScenarioReceiptSourceOrigin;
    readonly model: ModelName;
    readonly origin:
      | { readonly kind: 'admitted-reference'; readonly parameter: string }
      | { readonly kind: 'stored-reference'; readonly dependencyId: string }
      | { readonly kind: 'created-reference'; readonly created: ScenarioReceiptCreatedRoot };
  };
  /** Repeated only within this original source-owned loop. The runtime mints
   * each occurrence from its actual selected item; metadata grants no access. */
  readonly iteration?: string;
  readonly order: ReadonlyArray<OrderTerm>;
  readonly limit: number | null;
  readonly archived: 'exclude' | 'include';
  readonly dependencies: ReadonlyArray<{
    readonly id: string; readonly source: ScenarioReceiptSourceOrigin;
    readonly role: 'data' | 'control'; readonly field: string; readonly type: CanTypeId;
  }>;
}
export interface ScenarioReceiptQueryProjection {
  readonly kind: 'query-contract-array';
  readonly queryId: string;
  /** The actual local query/select occurrence, distinct from the model scan. */
  readonly source: ScenarioReceiptSourceOrigin;
  readonly fields: ReadonlyArray<{
    readonly name: string; readonly kind: 'reference' | 'version' | 'field'; readonly field?: string;
  }>;
}
export interface ScenarioReceiptQueryOccurrence {readonly loop:string;readonly ordinal:number;}
export interface ScenarioReceiptQueryObservation {
  readonly queryId: string;
  readonly occurrence?: ScenarioReceiptQueryOccurrence;
  readonly revision: Revision;
  /** Genuine retained parent witness for a scoped plan, including an empty
   * candidates array. Required exactly when the matching plan has `parent`.
   * State captures the original resolved row and secret-field evidence;
   * Dev binds that observation privately to its real owner/stage/store.
   * Recovery rechecks saved parent, ancestors and current full Identity
   * authority even when no child matched. Shape alone grants no authority. */
  readonly parent?: {
    readonly model: ModelName;
    readonly row: StoredRow;
    readonly secretFields: readonly string[];
  };
  /** Full original viewer domain, including false matches. Empty is meaningful. */
  readonly candidates: ReadonlyArray<{
    readonly row: StoredRow; readonly record: ProjectedRecord;
    readonly secretFields: readonly string[]; readonly matched: boolean;
    readonly dependencies: readonly string[];
  }>;
  readonly selectedIndices: readonly number[];
}

export interface RetainedGuardedHandlerPlan {
  /** Original reachable Model reads, sealed with this private execution closure. */
  readonly queries?: ArtifactOperation['authorityQuerySites'];
  /** Rules with an explicit checked `when_at=source` evaluation phase. */
  readonly stagedRules?: readonly string[];
  readonly source: ScenarioReceiptSourceOrigin;
  readonly owner: string;
  readonly event: string;
  readonly node: { readonly start: number; readonly end: number };
  readonly rules: readonly string[];
}

export interface ScenarioResultDisclosurePlan {
  /** Private ordinary Work source frame; no result or query authority. */
  readonly retainedGuardedHandler?: RetainedGuardedHandlerPlan;
  readonly version: 1;
  readonly source: ScenarioReceiptSourceOrigin;
  readonly rentMovementRefundDecision?: unknown;
  readonly invoiceCollectDecision?: unknown;
  readonly invoiceIssueDecision?: unknown;
  readonly rentNoticeDecision?: unknown;
  readonly observeVenueDecision?: unknown;
  readonly successRenewalDecision?: unknown;
  readonly purchaseReceiveAll?: unknown;
  readonly eventNoticeAudit?: unknown;
  /** Original contained domains; this metadata grants no generic query or effect authority. */
  readonly sourceLoops?: {
    readonly source: ScenarioReceiptSourceOrigin; readonly owner:string;
    readonly loops:readonly {readonly id:string;readonly node:{readonly start:number;readonly end:number};
      readonly domain:{readonly start:number;readonly end:number};readonly maximum:number;readonly parameter:string;
      readonly parentModel:string;readonly model:string;readonly filtered:boolean;
      readonly aggregate?:{readonly queries:readonly string[];readonly dependencies:readonly string[];readonly order:readonly OrderTerm[]};
      readonly copy?:{readonly node:{readonly start:number;readonly end:number};
        readonly call:{readonly start:number;readonly end:number};readonly parent:string;readonly model:string;
        readonly target:string;readonly fields:readonly {readonly name:string;readonly type:string;
          readonly node:{readonly start:number;readonly end:number}}[]}}[];
  };
  readonly sourceEmissions?: {
    readonly source: ScenarioReceiptSourceOrigin;
    readonly owner: string;
    readonly loops: readonly { readonly id: string; readonly node: {readonly start:number;readonly end:number};
      readonly domain: {readonly start:number;readonly end:number}; readonly maximum:number;
      readonly parameter:string; readonly parentModel:string; readonly model:string; readonly event:string; readonly handler:string|null }[];
  };
  readonly queries?: readonly ScenarioReceiptQueryPlan[];
  readonly returns: ReadonlyArray<{
    readonly id: string;
    readonly source: ScenarioReceiptSourceOrigin;
    /** Complete return-specific closure must report these facts explicitly.
     * The scalar/direct-field version refuses every nonempty influence list;
     * empty observations never certify query or absent-reference facts.
     */
    readonly influences: ReadonlyArray<{
      readonly id: string;
      readonly kind: 'query-existence' | 'query-cardinality' | 'query-membership' | 'query-order' | 'absent-reference';
      readonly queryId?: string;
    }>;
    readonly dependencies: ReadonlyArray<{
      readonly id: string;
      readonly source: ScenarioReceiptSourceOrigin;
      readonly role: 'data' | 'control';
      readonly model: ModelName;
      readonly field: string;
      readonly type: CanTypeId;
      /** Exact existing query occurrence when Compiler proves this ordinary
       * dependency is used exclusively while evaluating that query's candidates.
       * State checks the authentic source, owner, stage and store, and completed
       * candidate capture consumed by this return before accepting an absent
       * dependency observation. Every actual read stays retained and revalidated.
       * Omission keeps the ordinary dependency mandatory; this declaration grants no authority.
       */
      readonly queryId?: string;
    }>;
    /** Optional additive profile; absence preserves existing field-only plans. */
    readonly intrinsics?: ReadonlyArray<ScenarioReceiptIntrinsicDependency>;
    readonly projection?: ScenarioReceiptQueryProjection;
  }>;
}

/**
 * State captures only the actual checked final field and final write together
 * with a genuine Files observation. Persistent facts grant neither file access
 * nor row permission; current recovery must revalidate both.
 */
export interface ScenarioReceiptFileAssignment {
  readonly model: ModelName;
  readonly recordId: RecordId;
  readonly rowVersion: RecordVersion;
  readonly field: string;
  readonly file: RetainedFinalizedFile;
}

/** Execution-owned saved values; neither this data nor a plan grants access. */
export interface ScenarioReceiptAssociation {
  readonly kind: 'scenario-result/v1';
  readonly plan: ScenarioResultDisclosurePlan;
  readonly resultType: CanTypeId;
  readonly returnId: string;
  /** Optional checked file assignments; legacy omission remains absent and
   * cannot establish the file recovery profile or grant access. */
  readonly fileAssignments?: ReadonlyArray<ScenarioReceiptFileAssignment>;
  readonly queries?: readonly ScenarioReceiptQueryObservation[];
  /** Original admitted root issued once for each reached source-copy loop. */
  readonly sourceLoopRoots?:readonly {readonly loop:string;readonly parameter:string;readonly model:ModelName;readonly row:StoredRow;
    /** Only an authenticated aggregate loop retains its complete ordered item
     * selection, including empty. These snapshots grant no row or DATA access. */
    readonly selection?:readonly StoredRow[]}[];
  /** Actual same-owner calls, retained privately with the parent receipt.
   * Target metadata identifies the checked interface; it grants no authority.
   * Current projection rechecks target authority and every saved dependency. */
  readonly calls?: ReadonlyArray<{
    readonly site: string;
    readonly caller: string;
    readonly target: string;
    readonly targetInterface: string;
    readonly references: ReadonlyArray<{ readonly model: ModelName; readonly row: StoredRow; readonly secretFields: readonly string[] }>;
    readonly result: unknown;
    readonly scenario?: Omit<ScenarioReceiptAssociation, 'changed' | 'calls'>;
  }>;
  readonly observations: ReadonlyArray<{
    readonly dependencyId: string;
    readonly occurrence?: ScenarioReceiptQueryOccurrence;
    readonly model: ModelName;
    readonly row: StoredRow;
    readonly secretFields: ReadonlyArray<string>;
    /** Retained original ordered File field occurrences; the owning runtime
     * matches the whole source census and independently revalidates authority. */
    readonly files?: readonly RetainedFinalizedFile[];
  }>;
  readonly intrinsics?: ReadonlyArray<{
    readonly dependencyId: string; readonly kind: 'operation-id'; readonly wire: string;
  } | {
    readonly dependencyId: string; readonly kind: 'admitted-input'; readonly wire: unknown;
  } | {
    readonly dependencyId: string; readonly kind: 'admitted-reference-version'; readonly wire: string;
    readonly model: ModelName; readonly row: StoredRow; readonly secretFields: ReadonlyArray<string>;
  } | { readonly dependencyId:string;readonly kind:'created-model-version';readonly wire:string;readonly stage:number;
    readonly model:ModelName;readonly row:StoredRow;readonly secretFields:ReadonlyArray<string>;
  }>;
  readonly changed: ReadonlyArray<{
    readonly model: ModelName;
    readonly row: StoredRow;
    readonly secretFields: ReadonlyArray<string>;
    /** Unsupported reference/lifetime/composite fields cannot be disclosed. */
    readonly withheldFields: ReadonlyArray<string>;
    readonly fieldTypes: Readonly<Record<string, CanTypeId | null>>;
    /** Original DATA source for one source-sealed loop constructor. */
    readonly sourceCopy?: {readonly loop:string;readonly row:StoredRow};
  }>;
}

/** Saved outcome of a committed or rejected operation, for exact replay. */
export type ReceiptOutcome =
  | {
      readonly status: 'committed';
      /** Business result; may be null when content expired or is withheld. */
      readonly result: unknown;
      readonly recordVersions: ReadonlyArray<{
        readonly model: ModelName;
        readonly id: RecordId;
        readonly version: RecordVersion;
      }>;
      readonly scenario?: ScenarioReceiptAssociation;
    }
  | { readonly status: 'rejected'; readonly code: StateErrorCode; readonly message: string };

/** Durable replay receipt. */
export interface Receipt {
  readonly identity: ReceiptIdentity;
  /** Hash of normalized explicitly supplied inputs incl. submitted versions. */
  readonly inputHash: string;
  /** Originally resolved defaults, persisted separately (never rerun on replay). */
  readonly resolvedDefaults: Readonly<Record<string, unknown>>;
  readonly outcome: ReceiptOutcome;
  readonly committedRevision: Revision;
  readonly createdAt: number;
}

/** Read authority mode: viewer grants, or bounded owner authority. */
export type ReadAuthority = 'viewer' | 'owner';

/** Small JSON predicate AST for compiled `where`/filter/order inputs. */
export type QueryPredicate =
  | { readonly op: 'and'; readonly args: ReadonlyArray<QueryPredicate> }
  | { readonly op: 'or'; readonly args: ReadonlyArray<QueryPredicate> }
  | { readonly op: 'not'; readonly arg: QueryPredicate }
  | {
      readonly op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
      readonly field: string;
      readonly value: unknown;
    }
  | { readonly op: 'between'; readonly field: string; readonly lo: unknown; readonly hi: unknown }
  | { readonly op: 'is_null' | 'not_null'; readonly field: string }
  | {
      readonly op: 'derived_bool';
      /**
       * Sealed derived-bool selector identity; exactly the admitted
       * `unassigned`/`overdue` pair (field always equals expansion).
       */
      readonly field: 'unassigned' | 'overdue';
      readonly value: boolean;
      /** Pinned expansion id from the exact authored derive body. */
      readonly expansion: 'unassigned' | 'overdue';
      /**
       * Compiler-emitted owning-declaration source tuple, attached by
       * the query adapter from the page's sealed filter descriptor.
       * The Cloudflare page gate verifies it against the loaded
       * artifact's checked source census before any State admission.
       */
      readonly source: {
        readonly path: string;
        readonly sha256: string;
        readonly module: string;
        readonly node: { readonly start: number; readonly end: number };
      };
      /**
       * Trusted-time carrier for `overdue` only. The query adapter
       * attaches exactly `{ kind: 'page-query-now' }`; the Cloudflare
       * page host substitutes the cursor-pinned `queryTimeMs`
       * DatetimeValue after the receipt gate and before State
       * admission. State accepts only a genuine DatetimeValue here
       * (never the sentinel, a number, or a forged object); absent
       * for `unassigned`.
       */
      readonly time?: unknown;
    };

/** Ordering term: field path with direction. ID tie-break is implicit. */
export interface OrderTerm {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

/** Authorized record query specification (DESIGN §3/§4/§13 `records`). */
export interface QuerySpec {
  readonly model: ModelName;
  readonly parent?: { readonly model: ModelName; readonly id: RecordId };
  readonly where?: QueryPredicate;
  readonly order?: ReadonlyArray<OrderTerm>;
  readonly limit?: number;
  readonly archived?: 'exclude' | 'include';
  readonly authority: ReadAuthority;
}

/** Parent linkage for child records (S5): identity of the owning parent row. */
export interface RecordParent {
  readonly model: ModelName;
  readonly id: RecordId;
}

/** Stored row: reserved metadata plus validated domain fields. */
export interface StoredRow {
  readonly id: RecordId;
  readonly version: RecordVersion;
  readonly created: number;
  readonly updated: number;
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly archivedAt: number | null;
  /**
   * Parent linkage (S5, OPTIONAL so pre-S5 literals still compile). Adapters
   * treat `undefined` exactly like `null` (NULL columns); the mutation engine
   * always writes it explicitly and treats it as immutable.
   */
  readonly parent?: RecordParent | null;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * What a caller-asked remove does (S5): `archive` stamps `archivedAt` and
 * keeps the row (uniques reserved, refs valid); `remove` hard-deletes after a
 * disposal scan; `none` rejects deletes with `validation`.
 */
export type DeleteMode = 'archive' | 'remove' | 'none';

/** One domain write inside a fenced batch. */
export type DomainWrite =
  | {
      readonly kind: 'insert';
      readonly model: ModelName;
      readonly row: StoredRow;
    }
  | {
      readonly kind: 'update';
      readonly model: ModelName;
      readonly id: RecordId;
      /** Must equal the currently stored version or the batch fails. */
      readonly expectedVersion: RecordVersion;
      readonly row: StoredRow;
    }
  | {
      readonly kind: 'remove';
      readonly model: ModelName;
      readonly id: RecordId;
      readonly expectedVersion: RecordVersion;
    };

/** Audit/history entry committed with its originating write. */
export interface HistoryEntry {
  readonly model: ModelName;
  readonly recordId: RecordId;
  readonly version: RecordVersion;
  readonly operation: OperationName;
  readonly operationId: OperationId;
  readonly actor: string;
  readonly at: number;
  readonly change: 'create' | 'update' | 'archive' | 'remove';
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
  /**
   * Genuine writer capture for finite viewer-history projection. Legacy
   * entries remain absent; readers must never guess or backfill it. The
   * creation metadata binds the complete create-through-current chain;
   * original secrets remain hidden even after later schema/policy changes.
   * This is audit metadata, not an independent authority capability.
   */
  readonly auditProjection?: {
    readonly created: number;
    readonly createdBy: string;
    readonly secretFields: ReadonlyArray<string>;
  };
}

/** Outbox delivery intent staged atomically with its originating state. */
export interface OutboxIntent {
  readonly intentId: string;
  readonly operation: OperationName;
  readonly operationId: OperationId;
  readonly target: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** Occurrence index for deterministic identity; dispatch guard name if any. */
  readonly occurrenceIndex: number;
  readonly dispatchGuard?: string;
  /**
   * B3: stored handler contract (e.g. `acme.cleanup`) for migration
   * retention/invalidation evidence. OPTIONAL so pre-B3 literals and rows
   * still compile/read; adapters round-trip it (NULL reads as absent) and
   * the retention check trusts caller attestation only when it is absent.
   */
  readonly handlerContract?: string;
}

/**
 * Original publication facts for an outbox intent in its owning State store.
 * Both values must be persisted with that intent in its original fenced commit:
 * revision is that winning commit's revision; createdAt is the original stored
 * outbox creation time (epoch milliseconds), not the time of a later read,
 * claim, acknowledgement or retry. The revision is scoped to that same owner
 * store; it is not a global epoch or provider-payload assertion.
 */
export interface OriginalOutboxCommit {
  readonly revision: Revision;
  readonly createdAt: number;
}

/** Retained original carrier and storage status; dispatch acknowledgement is not delivery evidence. */
export interface RetainedOutboxIntent {
  readonly intent: OutboxIntent;
  readonly status: 'pending' | 'dispatched' | 'skipped';
  /**
   * Complete original provenance, retained unchanged through dispatch/skip and
   * reopen. Omitted means missing provenance (including legacy rows with only
   * created_at); neither field may be reconstructed from the current revision,
   * clock, stage or supplied payload. Consumers requiring this correspondence
   * must refuse/withhold when it is absent. No partial stamp is represented.
   */
  readonly originalCommit?: OriginalOutboxCommit;
}

/**
 * S6 storage read shape for one schedule row. Returned by `scheduleGet` and
 * `schedulesDue`; the write path stays `ScheduleOp` (replace/cancel).
 */
export interface ScheduleEntry {
  readonly key: string;
  readonly at: number;
  readonly event: OperationName;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Schedule replace/cancel staged atomically with its originating state. */
export type ScheduleOp =
  | {
      readonly op: 'replace';
      readonly key: string;
      readonly at: number;
      readonly event: OperationName;
      readonly payload: Readonly<Record<string, unknown>>;
    }
  | { readonly op: 'cancel'; readonly key: string };

/** One unique-key claim staged atomically with its originating write. */
export interface UniqueClaim {
  readonly model: ModelName;
  readonly keyName: string;
  readonly keyValue: string;
  readonly recordId: RecordId;
}

/** One unique-key release staged atomically with its originating write. */
export interface UniqueRelease {
  readonly model: ModelName;
  readonly keyName: string;
  readonly keyValue: string;
  /** Migration releases require this exact retained owner; ordinary releases omit it. */
  readonly recordId?: RecordId;
}

/** Compiler-owned normalized text-to-bool field validation binding. */
export interface StateFieldValidationProducerBinding {
  readonly abi: 'state.field-validation@1';
  readonly rule: string;
  readonly model: ModelName;
  readonly field: string;
  readonly lifecycle: 'validate-fields';
  readonly input: { readonly name: 'value'; readonly type: 'text' };
  readonly result: { readonly type: 'bool' };
  readonly implementation: {
    readonly unit: string;
    readonly export: 'check';
    readonly fingerprint: string;
  };
}

/**
 * BGI-07 `state.unique-key@1` producer binding: the checked join State
 * consumes for one compiler-bound canonical-identity rule. The
 * compiler owns the rule/field identity, the typed input/result
 * schemas and the implementation-closure fingerprint; State owns key
 * evaluation, canonical claim/release identities and the fenced
 * commit. Generated exports receive the projected text input and
 * return checked text; they hold no raw claim/store/commit authority
 * and choose no claim namespaces. Stored spelling is preserved
 * without a helper stored field.
 */
export interface StateUniqueKeyProducerBinding {
  /** Producer contract id; exact match, never negotiated. */
  readonly abi: 'state.unique-key@1';
  /** Compiler-owned rule identity (`Owner.Model.field#keyword`). */
  readonly rule: string;
  /** Canonical target model. */
  readonly model: ModelName;
  /** Bound field name (checked text). */
  readonly field: string;
  /** Fixed key semantics id (compiler-owned). */
  readonly semantics: 'nfkc-ascii-lowercase';
  /** Lifecycle binding: old/final keys around the fenced commit. */
  readonly lifecycle: 'commit-keys';
  /** Typed input binding: the bound field value as text. */
  readonly input: { readonly name: string; readonly type: 'text' };
  /** Typed result: the canonical key as text. */
  readonly result: { readonly type: 'text' };
  /** Saved implementation join: opaque unit, export and closure fingerprint. */
  readonly implementation: {
    readonly unit: string;
    readonly export: string;
    readonly fingerprint: string;
  };
}

/**
 * One atomic owner commit. The store asserts `expectedRevision`, applies all
 * writes/constraints/history/receipt/outbox/schedule work, and increments the
 * revision. Any failure (fence mismatch, constraint, validation) rolls back
 * the entire batch.
 */
export interface CommitBatch {
  readonly expectedRevision: Revision;
  readonly writes: ReadonlyArray<DomainWrite>;
  readonly history: ReadonlyArray<HistoryEntry>;
  readonly receipt: Receipt | null;
  readonly outbox: ReadonlyArray<OutboxIntent>;
  readonly schedules: ReadonlyArray<ScheduleOp>;
  readonly uniqueClaims: ReadonlyArray<UniqueClaim>;
  readonly uniqueReleases: ReadonlyArray<UniqueRelease>;
  /**
   * S6: intent ids to mark dispatched in this same atomic commit. OPTIONAL so
   * pre-S6 batch literals still compile; adapters treat `undefined` as `[]`.
   * Inserts apply first, then acks, so acking an id staged in the SAME batch
   * marks it dispatched. Ack is idempotent: unknown or already-dispatched ids
   * are a no-op (dispatchers retry at-least-once).
   */
  readonly outboxAck?: ReadonlyArray<string>;
}

/** Dot-separated path into a stored row (`data` unless a metadata name). S4. */
export type FieldPath = string;

/** Aggregate operations over an authorized matched set (S4). */
export type AggregateOp = 'count' | 'sum' | 'avg' | 'min' | 'max';

/** Aggregate request: `count` takes no field; every other op requires one. */
export interface AggregateSpec {
  readonly op: AggregateOp;
  readonly field?: string;
}

/** Aggregate outcome: the op echoed with its computed value. */
export interface AggregateResult {
  readonly op: AggregateOp;
  readonly value: unknown;
}

/**
 * Viewer-projected record: full metadata plus the partial `data` subtree
 * covered by the caller's matching grants. Denied leaves are omitted, never
 * null. Secret subtrees and secret-kind values are always omitted.
 */
export interface ProjectedRecord {
  readonly id: RecordId;
  readonly version: RecordVersion;
  readonly created: number;
  readonly updated: number;
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly archivedAt: number | null;
  /** Parent linkage (S5, required; the query engine supplies `row.parent ?? null`). */
  readonly parent: RecordParent | null;
  readonly data: Readonly<Record<string, unknown>>;
}

/** Viewer query outcome: projected records at a fence revision. */
export interface AuthorizedRecordsResult {
  readonly records: ProjectedRecord[];
  readonly revision: Revision;
}

/** Owner query outcome: full stored rows at a fence revision. */
export interface AuthorityRowsResult {
  readonly rows: StoredRow[];
  readonly revision: Revision;
}

/** Result of a successful fenced commit. */
export interface CommitResult {
  readonly revision: Revision;
}

/** Raised when the fence assertion fails; the batch was rolled back. */
export interface FenceConflict {
  readonly expected: Revision;
  readonly actual: Revision;
}

/**
 * Provider-neutral storage port. D1 (revision-fenced batch) and Durable Object
 * local SQLite implement this same language contract; there is no cross-store
 * transaction. Raw adapter writes around the fence are forbidden.
 */
/** Selected original private-cohort reads; never authority or a general query quota. */
export interface CohortIdentityPageRequest {
  readonly model: ModelName;
  readonly parent?: RecordParent;
  readonly after: RecordId | null;
  /** Integer1..100; callers use1 for the complete-cohort overflow peek. */
  readonly limit: number;
  readonly expectedRevision: Revision;
}

export interface CohortRowLoadRequest {
  readonly model: ModelName;
  readonly id: RecordId;
  readonly expectedRevision: Revision;
}

export interface CohortRowPageRequest {
  readonly model: ModelName;
  readonly fanoutId: string;
  readonly after: RecordId | null;
  readonly limit: number;
  readonly expectedRevision: Revision;
}

export type CohortAnchorFact = 'present' | 'disposed' | 'unknown';

export interface StoragePort {
  /** Original backend identity/cursor order; final frozen members retain JS sort. */
  readonly cohortIdOrder: 'utf16' | 'utf8-binary';
  /** Read the current fence revision before state-dependent reads. */
  readRevision(): Promise<Revision>;
  /** Load one stored row by identity (authority checks happen above). */
  load(model: ModelName, id: RecordId): Promise<StoredRow | null>;
  /**
   * Trusted owner lookup of an exact persisted unique claim in this backend's
   * owner namespace. Does not load or validate the owning row. State-dependent
   * consumers retain their ordinary revision fence; no source/request access.
   */
  uniqueOwner?(model: ModelName, keyName: string, keyValue: string): Promise<RecordId | null>;
  /** Execute an authorized query at the current checkpoint. */
  query(spec: QuerySpec): Promise<ReadonlyArray<StoredRow>>;
  /**
   * Include-archived identities only, in cohortIdOrder, exclusive
   * after. Components<=200 UTF16 units; limit1..100. No business data decode.
   * All selected cohort reads assert the supplied revision before and after
   * their read and throw the existing fence conflict on disagreement.
   */
  cohortIdentityPage(input: CohortIdentityPageRequest): Promise<ReadonlyArray<RecordId>>;
  /**
   * One complete retained row with compound identity<=6000, bounded before
   * JSON parsing/copy:20k expanded values, rootdepth32,2m UTF16 own keys/text,
   * conservative12,640,000 raw UTF8 bytes. Unrelated load keeps its contract.
   */
  cohortLoad(input: CohortRowLoadRequest): Promise<StoredRow | null>;
  /**
   * Live fanoutId child rows in exclusive id order, limit1..100. The complete
   * returned page shares the same representation budget as cohortLoad;
   * SQL guards aggregate raw bytes before returning payloads to the host.
   * Callers enforce total1000 visits/members and overflow peek themselves.
   */
  cohortRowPage(input: CohortRowPageRequest): Promise<ReadonlyArray<StoredRow>>;
  /**
   * Present includes archived; a missing row with remove/archive history is
   * disposed; otherwise unknown. Read only existence/change facts, without
   * decoding business data or whole history before classification.
   */
  cohortAnchorFact(input: CohortRowLoadRequest): Promise<CohortAnchorFact>;
  /** Fenced atomic commit; throws on fence conflict or constraint failure. */
  commit(batch: CommitBatch): Promise<CommitResult>;
  /** Look up a durable receipt by identity. */
  readReceipt(identity: ReceiptIdentity): Promise<Receipt | null>;
  /**
   * S6: status-pending outbox intents, ordered by (created_at, intent_id).
   * Readers observe committed state only; results are deep copies. The id
   * tiebreak is backend-defined for non-ASCII ids (JS UTF-16 order vs SQLite
   * BINARY); realistic ids are ASCII, where the orders agree.
   */
  outboxPending(): Promise<ReadonlyArray<OutboxIntent>>;
  /**
   * One retained outbox intent by exact identity, or null when absent.
   * Includes the original carrier after acknowledgement or migration skip.
   * Reads committed state only and returns a deep copy; authority stays above
   * this owner-local storage boundary, as for outboxPending.
   */
  outboxGet(intentId: string): Promise<RetainedOutboxIntent | null>;
  /** Exact original carrier at one fence; cohort representation limits apply before decode/copy. */
  outboxGetBounded?(input: { readonly intentId: string; readonly expectedRevision: Revision }): Promise<RetainedOutboxIntent | null>;
  /** S6: one schedule row by key, or null when absent. */
  scheduleGet(key: string): Promise<ScheduleEntry | null>;
  /**
   * S6: schedules with `at <= now`, ordered by (at, key), capped at `limit`.
   * `limit` must be an integer >= 1; anything else throws a plain Error. The
   * key tiebreak is backend-defined for non-ASCII keys (see outboxPending).
   */
  schedulesDue(now: number, limit: number): Promise<ReadonlyArray<ScheduleEntry>>;
  /**
   * S6: history for one record, ordered by version ascending with insertion
   * sequence as the tiebreak. Actual owner-session stages can share one
   * reserved version; their insertion/source order remains significant.
   */
  historyFor(model: ModelName, recordId: RecordId): Promise<ReadonlyArray<HistoryEntry>>;
  /**
   * Finite audit retrieval for a viewer reader. Returns the complete ordered
   * (version, insertion sequence) set or refuses overflow before decoding;
   * never falls back to historyFor. The reader still owns current grants,
   * original secrets and lifetime admission. Adapters fence both ends of the
   * read at expectedRevision. limit must be an integer in 1..100.
   * Legacy/custom stores without this capability remain unsupported.
   */
  historyReadBounded?(input: {
    readonly model: ModelName;
    readonly recordId: RecordId;
    readonly expectedRevision: Revision;
    readonly limit: number;
  }): Promise<ReadonlyArray<HistoryEntry>>;
  /**
   * S7: installed owner snapshot, or null when the owner was never installed
   * (fresh installs take a separate path and never apply transitions).
   */
  readInstalledSnapshot(owner: string): Promise<InstalledSnapshot | null>;
  /** S7: resumable migration progress, or null when the migration never staged. */
  readMigrationProgress(migrationId: string): Promise<MigrationProgress | null>;
  /** Exact retained migration row, without materializing an unbounded staged page. */
  readStagedRow(migrationId: string, model: ModelName, recordId: RecordId): Promise<StagedRow | null>;
  /**
   * S7: staged target rows for one migration in (model, record id) order,
   * bounded by `limit` after `cursor`. `limit` follows the schedulesDue rule
   * (integer >= 1, else plain Error). Deep copies.
   */
  readStagedRows(
    migrationId: string,
    cursor: StagedRowCursor | null,
    limit: number,
  ): Promise<ReadonlyArray<StagedRow>>;
  /**
   * S7: one fenced staging chunk: upsert staged rows (idempotent restage by
   * migration/model/id key) and record progress atomically. Fence loss throws
   * FenceConflictError; nothing is staged without its progress cursor.
   */
  stageMigrationRows(input: StageMigrationChunk): Promise<CommitResult>;
  /**
   * S7: one fenced publish chunk: apply staged rows to live records with
   * their history entries, dispose drops, and advance the publish cursor
   * atomically. Re-publishing an already-published cursor range is a
   * caller error (resume reads the cursor first); history is never doubled.
   */
  publishMigrationChunk(input: PublishMigrationChunk): Promise<CommitResult>;
  /**
   * S7: the final fenced flip: install the new snapshot pointer (removing
   * the renamed-away owner pointer when present), or — when `snapshot` is
   * null — remove the owner's pointer (dropOwner); either way mark
   * invalidated intents skipped, record outcomes, mark progress active.
   * Idempotent: when the installed pointer already equals the target
   * (or is already absent for a removal), returns the current revision
   * with `flipped: false` and commits nothing.
   */
  flipInstalledSnapshot(input: FlipInstalledSnapshot): Promise<FlipResult>;
  /** S7: recorded migration outcomes (invalidate skips), in record order. */
  readMigrationOutcomes(migrationId: string): Promise<ReadonlyArray<MigrationOutcome>>;
  /**
   * B3: one fenced failure write: mark progress `failed` (preserving the
   * leg's cursors) and record the durable `MigrationFailure` atomically.
   * Fence loss throws FenceConflictError; marking an `active` migration
   * failed is a caller error (no post-flip failure rewrite).
   */
  recordMigrationFailure(input: RecordMigrationFailure): Promise<CommitResult>;
  /**
   * B3: one fenced pre-flip discard: delete the migration's staged rows
   * plus its progress row atomically (a retry restages from scratch; the
   * failure record survives as audit). Refuses `active` progress (no
   * destructive rollback past the flip).
   */
  discardStagedRows(input: DiscardStagedRows): Promise<CommitResult>;
  /** B3: durable failure record, or null when the migration never failed. */
  readMigrationFailure(migrationId: string): Promise<MigrationFailure | null>;
}

/* -- S7: owner-local migration execution intake (DESIGN §11). -- */

/**
 * S7: exact installed owner snapshot (DESIGN §11.1). INTERIM execution-side
 * shape until L1 emits the canonical snapshot/plan format; the engine treats
 * `snapshotId` + `digest` as the opaque predecessor identity it must match.
 */
export interface InstalledSnapshot {
  readonly owner: string;
  readonly snapshotId: string;
  readonly digest: string;
  readonly installedRevision: Revision;
  readonly installedAt: number;
}

/** Persisted host assignments, not paths, JS handles or request claims.
 * Exactly one authoritative State store admits references to this physical
 * Files receiver/store. State owner and physical receiver owner are distinct.
 * Both stores must retain their identities across reopen; repinning refuses. */
export interface FileRetirementAuthority {
  readonly app: string;
  readonly stateOwner: string;
  readonly stateStoreId: string;
  readonly fileStoreId: string;
  readonly receiver: Readonly<Omit<FinalizedFileReceiver, 'principal'>>;
}

/** Installed declaration identity; owner is the snapshot owner, not a team ID.
 * Digest correspondence alone does not authenticate a checked declaration set. */
export interface FileReferenceInventoryIdentity {
  readonly owner: string;
  readonly snapshotId: string;
  readonly digest: string;
}

/** Owning framework fields are separate from compiler domain declarations.
 * Control values have their declared scalar/ID role, not File authority.
 * Opaque input/results are NOT File-free: without a checked declaration join,
 * census/admission refuses the row even after successful shape validation. */
export type FrameworkFileReferenceField =
  | {
      readonly kind: 'control';
      readonly value: 'string' | 'number' | 'boolean' | 'string-array';
      readonly nullable?: true;
      readonly optional?: true;
    }
  | {
      readonly kind: 'control';
      readonly value: 'object';
      /** Closed flat string fields, e.g. owning ReceiptError code/message.
       * Every declared field is required; no extra/nested/opaque JSON fields.
       * The owning producer derives keys from its actual declaration. */
      readonly fields: Readonly<Record<string, { readonly kind: 'control'; readonly value: 'string' }>>;
      readonly nullable?: true;
      readonly optional?: true;
    }
  | { readonly kind: 'opaque'; readonly role: 'retained-result' }
  | {
      readonly kind: 'opaque';
      readonly role: 'deferred-input';
      /** Absence alone is permitted for an owning optional retained input.
       * Every present value, including null/empty/File-free data, still needs
       * its genuine payload-origin binding and complete typed projection.
       * Present undefined and an orphan origin header are not absence. */
      readonly optional?: true;
    }
  | {
      /** Owning filePayloadOrigin evidence, never an arbitrary JSON control.
       * Optional only for unbound/legacy row compatibility. Bound opaque census
       * requires this exact evidence even for null, empty or File-free values.
       * State validates the complete header separately and links payloadField
       * to its actual owning retained-result/deferred-input slot. Never resolve
       * the header recursively or exempt its nested facts as arbitrary controls. */
      readonly kind: 'opaque';
      readonly role: 'payload-origin';
      readonly payloadField: string;
      readonly optional: true;
    };

/** Original checked callable and its complete private invocation descriptor.
 * Handlers need not be public operations. Missing result metadata is not void:
 * resultDeclarationId must select the actual declared return or explicit void. */
export interface FrameworkOpaqueCallable {
  readonly source: ScenarioReceiptSourceOrigin;
  readonly callable: Readonly<ArtifactCallable>;
  readonly canonical: CanonicalOperationDescriptor;
  readonly artifact: Readonly<ArtifactOperation>;
  readonly resultDeclarationId: string;
}

/** Persist the owning std.JudgmentSpec wire value: version is canonical int64
 * text, not its decoded bigint. The actual Values codec validates the complete
 * specification; interleaved question order is retained separately below. */
export type FrameworkOpaqueJudgmentSpec = Omit<JudgmentSpec, 'version'> & {
  readonly version: string;
};

/** Actual versioned provider declaration, distinct from the calling callable.
 * Generation request correlation and frozen Judgment specification are required
 * only in their closed variants; a std name or provider tag cannot select them. */
export type FrameworkOpaqueDeliveryContext =
  | { readonly kind: 'capability'; readonly canonical: CanonicalDeliveryDescriptor;
      readonly artifact: Readonly<ArtifactDeliveryDescriptor> }
  | { readonly kind: 'generation'; readonly canonical: CanonicalDeliveryDescriptor;
      readonly artifact: Readonly<ArtifactDeliveryDescriptor>;
      readonly request: { readonly source: string; readonly revision: string } }
  | { readonly kind: 'judgment'; readonly canonical: CanonicalJudgmentDeliveryDescriptor;
      readonly artifact: Readonly<ArtifactJudgmentDeliveryDescriptor>;
      readonly specification: FrameworkOpaqueJudgmentSpec; readonly order: ReadonlyArray<string>;
      readonly valueTypes: CanonicalValueTypes };

/**
 * Installed original provider profile, distinct from a request instance. Only
 * the genuine checked Generation producer may select generation-profile; a
 * provider/result name, tag or copied descriptor cannot establish eligibility.
 * Preserve its complete canonical/artifact result, source, historical schema,
 * raw defaults and original declaration-set/id correspondence. No per-request
 * inventory install or fabricated static request is permitted.
 *
 * A generation-profile matches only the original runtime kind:generation
 * context selected by that same declaration id, with exact canonical/artifact
 * and source correspondence. Its request must come from the genuine retained
 * SEND/frame/intent/association, including original binding/from and scope;
 * completion retains its existing six-field Work correlation. String equality
 * or this profile alone authenticates none of those facts. Validate that full
 * relation even for pending/null/skipped, before any no-result early return or
 * typed traversal. Rich result source/revision must match the original runtime
 * request before traversing its values. Thread that verified existing origin;
 * no additional raw request tuple or projection carrier is introduced.
 *
 * Existing capability, exact-request generation and Judgment profiles retain
 * their full exact-context checks. Runtime origins never accept the static
 * variant. Consumers without this relation must refuse it, never fall back.
 */
export type FrameworkOpaqueDeliveryProfile = FrameworkOpaqueDeliveryContext
  | { readonly kind: 'generation-profile'; readonly canonical: CanonicalDeliveryDescriptor;
      readonly artifact: Readonly<ArtifactDeliveryDescriptor> };

/** Checked original SEND predicate occurrence and complete free lexical inputs.
 * These are the actual compiler/loader declaration, not a fabricated callable
 * signature or an execution verdict. Rule, source, owning callable, span,
 * binding/target and each input name/type must correspond to that exact loaded
 * occurrence. Captured input values remain in the existing dispatch field. */
export interface FrameworkOpaqueSendGuardDeclaration {
  readonly rule: string;
  /** Omitted guards use current dispatch state; explicit source guards retain
   * the decision made by their original owning transaction. */
  readonly evaluation?: 'source';
  readonly source: ScenarioReceiptSourceOrigin;
  readonly owner: string;
  readonly node: { readonly start: number; readonly end: number };
  readonly binding: string;
  readonly target: string;
  readonly inputs: ReadonlyArray<{ readonly name: string; readonly type: CanTypeId }>;
}

/** Complete original profile. Source evidence is bound by the genuine loader;
 * copied source/callable descriptors and successful codecs authenticate nothing. */
export interface FrameworkOpaqueDeclaration {
  readonly id: string;
  readonly source:
    | { readonly kind: 'callable'; readonly source: ScenarioReceiptSourceOrigin;
        readonly callable: Readonly<ArtifactCallable> }
    | { readonly kind: 'event'; readonly source: ScenarioReceiptSourceOrigin; readonly event: string }
    | { readonly kind: 'delivery'; readonly source: ScenarioReceiptSourceOrigin;
        readonly context: FrameworkOpaqueDeliveryProfile }
    | ({ readonly kind: 'send-guard' } & FrameworkOpaqueSendGuardDeclaration);
  readonly profile:
    | { readonly kind: 'inputs'; readonly canonical: ReadonlyArray<CanonicalInputDef>;
        readonly artifact: ReadonlyArray<Readonly<ArtifactOperationInput>> }
    | { readonly kind: 'result'; readonly canonical: NonNullable<CanonicalOperationDescriptor['result']>;
        readonly artifact: NonNullable<ArtifactOperation['result']> }
    | { readonly kind: 'provider-result'; readonly canonical: CanonicalNominalResult;
        readonly artifact: Readonly<ArtifactNominalResult> }
    | { readonly kind: 'void'; readonly canonical: { readonly type: 'void' };
        readonly artifact: { readonly type: 'void' } };
}

/** One exact original own contract-field literal default, before Values schema
 * normalization. Null, empty arrays/text, false and File-free defaults remain
 * explicit entries. A copied pair/value or successful codec proves no source
 * correspondence; the actual same-load loader binds complete original capture. */
export interface FrameworkOpaqueValueDefault {
  readonly contract: string;
  readonly field: string;
  readonly value: WireValue;
}

/** Historical closure stays available after reopen and migration. Compiled
 * source SHA and installed State Revision are distinct facts. New declarations
 * with matching spellings cannot reinterpret a retained original payload. */
export interface FrameworkOpaqueDeclarationSet {
  readonly id: string;
  readonly inventory: FileReferenceInventoryIdentity;
  readonly snapshot: InstalledSnapshot;
  readonly sources: ReadonlyArray<Readonly<ArtifactSource>>;
  readonly canonicalModels: ReadonlyArray<CanonicalModelDescriptor>;
  readonly artifactModels: ReadonlyArray<ArtifactModel>;
  readonly valueTypes: CanonicalValueTypes;
  /** Complete detached original appDefinition.contracts map, descriptor-checked
   * before reading from the same verified native load as sources/snapshot.
   * Retain every contract and own field descriptor before normalization,
   * including unused/File-free fields and all raw literal defaults. State
   * compares the complete contract/field/type/constraint inventory against
   * valueTypes through the owning schema path, independently derives every
   * own default here and requires one-to-one raw equality with valueDefaults.
   * A copied map proves no source correspondence. {} proves absence only after
   * complete genuine capture; omission is incomplete. Persist this original
   * input through reopen/migration, never rebuild it from a current schema. */
  readonly originalContracts: Readonly<Record<string, WireValue>>;
  /** Complete original own contract-field defaults from the genuine retained
   * schema. CanonicalNominalLeaf deliberately drops defaults on field reuse.
   * Exact unique contract/field pairs must resolve within valueTypes; capture
   * every default, not only File-shaped values, and compare raw wires against
   * originalContracts before binding. [] means none only after that
   * complete comparison. Omission is incomplete, never an empty default set.
   * Preserve this table with the original closure through reopen/migration. */
  readonly valueDefaults: ReadonlyArray<FrameworkOpaqueValueDefault>;
  readonly declarations: ReadonlyArray<FrameworkOpaqueDeclaration>;
}

/** Raw committed change and checked handler projection are different values. */
export type FrameworkOpaqueEventDeclaration =
  | { readonly kind: 'declared-event'; readonly source: ScenarioReceiptSourceOrigin;
      readonly event: string; readonly inputsDeclarationId: string }
  | { readonly kind: 'committed-change'; readonly source: ScenarioReceiptSourceOrigin;
      readonly descriptor: Readonly<ArtifactCommittedChangeDescriptor>;
      readonly change: Readonly<CommittedChangeEvent>;
      /** Checked id/version projection; never the raw CommittedChangeEvent schema. */
      readonly projectionInputsDeclarationId: string }
  | { readonly kind: 'standard-completion'; readonly source: ScenarioReceiptSourceOrigin;
      readonly event: string; readonly providerSource: string; readonly binding: string; readonly from: string;
      readonly sourceInputsDeclarationId: string; readonly inputsDeclarationId: string;
      readonly resultDeclarationId: string; readonly delivery: FrameworkOpaqueDeliveryContext };

export interface FrameworkOpaqueEventInputOrigin {
  readonly kind: 'event-input';
  readonly occurrenceId: OccurrenceId;
  readonly sourceOccurrence: OccurrenceId;
  readonly declaration: FrameworkOpaqueEventDeclaration;
  readonly lineage:
    | { readonly kind: 'schedule'; readonly key: string; readonly replaces: OccurrenceId | null }
    | { readonly kind: 'source'; readonly sourceOccurrence: OccurrenceId };
  readonly target:
    | { readonly kind: 'schedule' }
    | { readonly kind: 'handler'; readonly handler: FrameworkOpaqueCallable }
    | { readonly kind: 'queue-publication'; readonly intent: Readonly<Pick<OutboxIntent, 'intentId' | 'operation' | 'operationId' | 'target' | 'occurrenceIndex'>> };
}

/** Exact adopted owner cohort forms; the original owner and parent are facts,
 * not current authorization. No cross-owner or partial membership inference. */
export type FrameworkOpaqueCohort =
  | { readonly kind: 'model'; readonly owner: string; readonly model: string }
  | { readonly kind: 'anchored-collection'; readonly owner: string; readonly model: string;
      readonly parent: { readonly model: string; readonly id: string } };

export interface FrameworkOpaqueSourceBounds {
  readonly maxSources: number;
  readonly maxHandlers: number;
  readonly maxMembers: number;
  readonly chunkSize: number;
}

export type FrameworkOpaqueSourceRoute =
  | { readonly kind: 'ordinary'; readonly handler: FrameworkOpaqueCallable;
      readonly occurrenceId: OccurrenceId }
  | { readonly kind: 'fanout'; readonly handler: FrameworkOpaqueCallable;
      readonly cohort: FrameworkOpaqueCohort; readonly fanoutId: string;
      readonly members: ReadonlyArray<string>; readonly memberCount: number;
      readonly firstChunkCount: number; readonly cursor: string | null };

export interface FrameworkOpaqueSourceRoutingOrigin {
  readonly kind: 'source-routing';
  readonly occurrenceId: OccurrenceId;
  readonly revision: Revision;
  readonly recipe:
    | { readonly kind: 'scheduled-cohorts'; readonly event: FrameworkOpaqueEventInputOrigin;
        readonly bounds: { readonly pageLimit: number; readonly chunkSize: number };
        readonly routes: ReadonlyArray<Extract<FrameworkOpaqueSourceRoute, { kind: 'fanout' }>> }
    | { readonly kind: 'scheduled-routes'; readonly event: FrameworkOpaqueEventInputOrigin;
        readonly bounds: { readonly pageLimit: number; readonly chunkSize: number };
        readonly routes: ReadonlyArray<FrameworkOpaqueSourceRoute> }
    | { readonly kind: 'queued-routes';
        readonly declaration: Extract<FrameworkOpaqueEventDeclaration, { kind: 'declared-event' }>;
        readonly originalIntent: Readonly<Pick<OutboxIntent, 'intentId' | 'operation' | 'operationId' | 'target' | 'occurrenceIndex'>>;
        readonly originalCommit: OriginalOutboxCommit;
        readonly guard?: FrameworkOpaqueSendGuardOrigin;
        readonly routes: ReadonlyArray<Extract<FrameworkOpaqueSourceRoute, { kind: 'ordinary' }>> }
    | { readonly kind: 'committed-model'; readonly source: ScenarioReceiptSourceOrigin;
        readonly descriptor: Readonly<ArtifactCommittedChangeDescriptor>;
        readonly change: { readonly model: ModelName; readonly recordId: RecordId;
          readonly version: RecordVersion; readonly kind: 'created' | 'updated' | 'deleted' };
        readonly payload: Readonly<CommittedChangeEvent>; readonly context: InvocationContext;
        readonly bounds: FrameworkOpaqueSourceBounds; readonly routes: ReadonlyArray<FrameworkOpaqueSourceRoute> }
    | { readonly kind: 'declared-event';
        readonly declaration: Extract<FrameworkOpaqueEventDeclaration, { kind: 'declared-event' }>;
        readonly payload: Readonly<Record<string, unknown>>; readonly context: InvocationContext;
        readonly bounds: FrameworkOpaqueSourceBounds; readonly routes: ReadonlyArray<FrameworkOpaqueSourceRoute> };
}

/** All original dispatch fields survive; generation correlation is a closed
 * variant rather than partial optional request fields or current recensus. */
export type FrameworkOpaqueCompletionDispatch = {
  readonly operationId: string;
  readonly source: string;
  readonly occurrenceIndex: number;
  readonly originOccurrence: OccurrenceId | null;
  readonly created: number;
  readonly actor: string;
} & (
  | { readonly kind: 'capability' }
  | { readonly kind: 'generation'; readonly correlation: {
      readonly requestSource: string; readonly requestRevision: string;
      readonly requestBinding: string; readonly requestFrom: string;
      readonly requestApp: string; readonly requestOwner: string;
    } }
);

export interface FrameworkOpaqueStandardCompletionOrigin {
  readonly kind: 'standard-completion';
  readonly occurrenceId: OccurrenceId;
  readonly declaration: Extract<FrameworkOpaqueEventDeclaration, { kind: 'standard-completion' }>;
  readonly originalIntent: Readonly<Pick<OutboxIntent,
    'intentId' | 'operation' | 'operationId' | 'target' | 'occurrenceIndex'>>;
  readonly originalCommit: OriginalOutboxCommit;
  readonly dispatch: FrameworkOpaqueCompletionDispatch;
  readonly terminal: { readonly revision: Revision; readonly status: TerminalReceiptStatus;
    readonly error: ReceiptError | null };
  readonly revision: Revision;
  readonly bounds: FrameworkOpaqueSourceBounds;
  readonly routes: ReadonlyArray<FrameworkOpaqueSourceRoute>;
}

/** One original bound SEND request, independent of a dispatch predicate. */
export interface FrameworkOpaqueSendInputOrigin {
  readonly kind: 'send-input';
  readonly caller: FrameworkOpaqueCallable;
  readonly intent: Readonly<Pick<OutboxIntent, 'intentId' | 'operation' | 'operationId' | 'target' | 'occurrenceIndex'>>;
  readonly request: { readonly binding: string; readonly from: string };
  readonly inputsDeclarationId: string;
}

/** Original deferred lexical capture, separate from provider request arguments.
 * The actual owning producer validates the complete sourceGuard envelope against
 * this declaration and its original dispatch/outbox intent, then resolves the
 * existing complete inputs projection at ['inputs']. The declaration selected by
 * inputsDeclarationId must be this exact send-guard source and complete original
 * name/type profile. Historical interpretation and genuine receiving File facts
 * survive progress/reopen/migration; neither current metadata nor a File-free
 * assertion can replace them. Original intent.dispatchGuard must equal both
 * declaration.rule and the physically retained sourceGuard.rule; a current
 * reconstructed rule or matching operation/target alone is insufficient.
 * No execution/current-authority grant is conveyed. */
export interface FrameworkOpaqueSendGuardOrigin {
  readonly kind: 'send-guard';
  readonly intent: Readonly<Pick<OutboxIntent,
    'intentId' | 'operation' | 'operationId' | 'target' | 'occurrenceIndex'> & {
      readonly dispatchGuard: string;
    }>;
  readonly declaration: Readonly<FrameworkOpaqueSendGuardDeclaration>;
  readonly inputsDeclarationId: string;
}

/** Original false SEND outcome: a genuine receipt and association, without an
 * OutboxIntent, Work dispatch or provider effect. These logical send facts are
 * captured from the current private owner/call and its actual semantic ordinal;
 * they are not a synthetic intent. The actual checked false-guard declaration,
 * caller, bound request and association must correspond to that exact source
 * evaluation. deliveryId is the owning skipped receipt identity, derived by its
 * original producer from operationId/target/occurrenceIndex/guard.rule.
 *
 * The owning State producer binds the standard result payload header atomically
 * with the skipped receipt/association and preserves it through reopen/migration.
 * This origin is valid only for original status skipped with result/error/
 * contentRef/resultExpiresAtMs null and no queued dispatch. Resolve the actual
 * complete provider resultDeclarationId at [] with presence no-result, retaining
 * declared nominal R and the full historical closure, defaults and receiving
 * File correspondence. Explicit provider void is unsupported by the current
 * delivery descriptors and delivery-owned result profiles; a caller's void
 * result cannot substitute for that provider declaration. Null is not a
 * control/File-free exemption. It cannot authorize provider progress, a result value, pending or
 * success, nor convey execution/current authority. Copies/hashes issue nothing. */
export interface FrameworkOpaqueSkippedDeliveryOrigin {
  readonly kind: 'delivery-skipped';
  readonly deliveryId: string;
  readonly send: {
    readonly operation: string;
    readonly operationId: OperationId;
    readonly target: string;
    readonly occurrenceIndex: number;
  };
  readonly request: { readonly binding: string; readonly from: string };
  readonly caller: FrameworkOpaqueCallable;
  readonly association: { readonly model: ModelName; readonly recordId: RecordId; readonly field: string };
  readonly guard: Readonly<FrameworkOpaqueSendGuardDeclaration>;
  readonly declaration: FrameworkOpaqueDeliveryContext;
  readonly resultDeclarationId: string;
}

/** Closed owning origins, captured at original production. The actual rich
 * payload bytes stay in their existing field. Standard completion resolution
 * covers original provider inputs, terminal R, event payload's duplicate R and
 * every physically retained typed schema default; raw committed event payloads
 * use their owning closed control schema, not fabricated handler inputs. */
export type FrameworkOpaquePayloadOrigin =
  | { readonly kind: 'delivery-result'; readonly deliveryId: string;
      readonly intent: Readonly<Pick<OutboxIntent,
        'intentId' | 'operation' | 'operationId' | 'target' | 'occurrenceIndex'>>;
      readonly request: { readonly binding: string; readonly from: string };
      readonly caller: FrameworkOpaqueCallable;
      readonly association: { readonly model: ModelName; readonly recordId: RecordId; readonly field: string };
      readonly declaration: FrameworkOpaqueDeliveryContext; readonly resultDeclarationId: string }
  /** A retained SEND without an authored delivery-typed association. The native
   * pending issuer proves the original publication/dispatch and installed
   * completion declarations. This header grants no provider progress authority. */
  | { readonly kind: 'retained-delivery-result'; readonly deliveryId: string;
      readonly intent: Readonly<Pick<OutboxIntent,
        'intentId' | 'operation' | 'operationId' | 'target' | 'occurrenceIndex'>>;
      readonly request: { readonly binding: string; readonly from: string };
      readonly caller: FrameworkOpaqueCallable;
      readonly declaration: Extract<FrameworkOpaqueDeliveryContext, {kind:'capability'}>;
      readonly resultDeclarationId: string;
      readonly completion: Extract<FrameworkOpaqueEventDeclaration, {kind:'standard-completion'}>;
      readonly originalCommit: OriginalOutboxCommit;
      readonly dispatch: Extract<FrameworkOpaqueCompletionDispatch, {kind:'capability'}> }
  | FrameworkOpaqueEventInputOrigin
  | { readonly kind: 'handler-result'; readonly occurrenceId: OccurrenceId;
      readonly operationId: OperationId; readonly handler: FrameworkOpaqueCallable;
      readonly event: FrameworkOpaqueEventInputOrigin }
  /** Direct due dispatch consumes a keyed schedule without making a separate
   * handler occurrence. Its terminal Work result is the selected void handler
   * result, bound to that exact scheduled event and receipt fields. */
  | { readonly kind: 'scheduled-handler-result'; readonly occurrenceId: OccurrenceId;
      readonly operationId: OperationId; readonly handler: FrameworkOpaqueCallable;
      readonly event: FrameworkOpaqueEventInputOrigin;
      readonly terminal: { readonly status: 'completed' | 'failed'; readonly result: null;
        readonly code: string | null; readonly message: string | null } }
  | FrameworkOpaqueSourceRoutingOrigin
  | FrameworkOpaqueStandardCompletionOrigin
  | FrameworkOpaqueSendGuardOrigin
  | FrameworkOpaqueSendInputOrigin
  | FrameworkOpaqueSkippedDeliveryOrigin;

/** One original owning row.data.filePayloadOrigin, persisted atomically with
 * its payload; updates explicitly preserve it through progress/supersession.
 * Slot created/createdBy identify lifetime. Current version/revision are fences,
 * never lifetime. Retained File facts come from original genuine observations;
 * their receiver principal and provenance resultPath differ from current reader
 * identity and typed value paths. Data/casts/copies supply no issuer or grant. */
export interface FrameworkFilePayloadOrigin {
  readonly version: 1;
  readonly inventory: FileReferenceInventoryIdentity;
  readonly declarationSetId: string;
  readonly slot: { readonly model: ModelName; readonly id: RecordId;
    readonly created: number; readonly createdBy: string; readonly field: string;
    readonly role: 'retained-result' | 'deferred-input' };
  readonly scope: Readonly<WorkScope>;
  readonly origin: FrameworkOpaquePayloadOrigin;
  readonly files: ReadonlyArray<{
    readonly path: ReadonlyArray<string | number>; readonly file: RetainedFinalizedFile;
  }>;
}

/** Full typed projections into the actual stored opaque field, not ref lists.
 * Inputs/results select original complete profiles. A no-result projection is
 * valid only for the owning closed phase/status with actual null and explicit
 * declared/void evidence; it is not a File-free shortcut. Typed defaults select
 * the exact original input, model or value-field type, including nested values.
 * Owning validation covers ALL envelope controls and typed positions; missing,
 * overlapping, duplicate or partial projections refuse. */
export type FrameworkOpaqueValueProjection = {
  readonly path: ReadonlyArray<string | number>;
} & (
  | { readonly kind: 'inputs'; readonly declarationId: string }
  | { readonly kind: 'result'; readonly declarationId: string; readonly presence: 'value' | 'no-result' }
  | { readonly kind: 'default'; readonly owner:
      | { readonly kind: 'input'; readonly declarationId: string; readonly input: string }
      | { readonly kind: 'model-field'; readonly model: ModelName; readonly field: string }
      /** Select this exact historical set's valueDefaults entry and require the
       * physically retained value to equal its original raw literal wire, then
       * independently type/check/traverse it. Current or normalized defaults
       * cannot replace this evidence; every retained default needs coverage. */
      | { readonly kind: 'value-field'; readonly contract: string; readonly field: string } }
);

export interface FrameworkOpaqueFieldResolution {
  /** Must equal the actual original persisted binding, not a replacement DTO. */
  readonly binding: FrameworkFilePayloadOrigin;
  readonly values: ReadonlyArray<FrameworkOpaqueValueProjection>;
}

/** Exact closed data fields from the actual owning row definition. Source tags
 * record correspondence; copied descriptors/tags do not authenticate a producer.
 * Unknown fields/models, domain collisions and duplicate framework names refuse.
 * The common StoredRow envelope, including archived rows, remains covered. */
export interface FrameworkFileReferenceModel {
  readonly model: ModelName;
  readonly source: { readonly package: string; readonly module: string; readonly export: string };
  readonly fields: Readonly<Record<string, FrameworkFileReferenceField>>;
}

/** Trusted host binds the actual same-load owning export, checks its full model
 * inventory against the persisted declarations and keeps the validator outside
 * persisted JSON. A structural cast or caller-supplied callback is no issuer.
 * Validation checks closed owning shape only; opaque payload reuse still needs
 * checked source/input/result correspondence and current File authority. */
export interface FrameworkFileReferenceProducer {
  readonly models: ReadonlyArray<FrameworkFileReferenceModel>;
  validateRow(model: ModelName, row: StoredRow): void;
  /** Optional for legacy compatibility; absence keeps opaque census refused.
   * The actual same-load owning export resolves EVERY retained-result and
   * deferred-input field synchronously
   * inside State's original guarded snapshot/transaction. No await/provider/File
   * observation, thenable, precomputed refs or permission verdict. Validate full
   * original slot/source/declaration/envelope correspondence, then State derives
   * all occurrences and exactly matches persisted original receiving facts.
   * installed is the actual port's persisted assignment/current or published
   * migration inventory; historical declaration sets preserve old interpretation.
   * State separately validates payload-origin evidence and its exact payloadField
   * correspondence; it never recursively resolves the header as a payload.
   * Full current execution/disclosure/reuse authority remains outside census. */
  resolveOpaqueField?(model: ModelName, row: StoredRow, field: string, context: {
    readonly installed: InstalledFileReferenceInventory;
    readonly binding: FrameworkFilePayloadOrigin;
  }): FrameworkOpaqueFieldResolution;
}

/** Complete same-load declarations, detached and persisted after validation.
 * Explicit empty arrays/valueTypes are valid; omitted evidence is not empty.
 * Storage derives every File occurrence, including nested/collection/optional/
 * nullable and archived values, from this inventory, never a caller ref list.
 * Framework models come from actual bound producer exports, not fabricated
 * domain descriptors or a namespace exemption. Missing family/source evidence,
 * colliding names and unclassified opaque payloads fail closed. */
export interface FileReferenceInventory extends FileReferenceInventoryIdentity {
  readonly canonicalModels: ReadonlyArray<CanonicalModelDescriptor>;
  readonly artifactModels: ReadonlyArray<ArtifactModel>;
  readonly valueTypes: CanonicalValueTypes;
  readonly frameworkModels: ReadonlyArray<FrameworkFileReferenceModel>;
  /** Complete original opaque declaration closures, including retained historical
   * sets. Omission is not an empty/File-free proof; legacy opaque rows refuse.
   * Runtime adoption is separately required before these fields are accepted. */
  readonly opaqueDeclarationSets?: ReadonlyArray<FrameworkOpaqueDeclarationSet>;
}

export interface InstalledFileReferenceInventory {
  readonly authority: FileRetirementAuthority;
  readonly snapshot: InstalledSnapshot;
  readonly inventory: FileReferenceInventory;
}

/** First trusted assignment only. Persist assignment, complete declarations
 * and the matching fresh snapshot in one expected-revision transaction. An
 * existing pointer must match; changing a snapshot uses checked migration.
 * Validate every existing live row; unknown legacy declarations refuse.
 * A fresh pointer's installedRevision is the actual installation revision;
 * preserve an existing matching pointer's original installation revision/time. */
export interface InstallFileReferenceInventory {
  readonly expectedRevision: Revision;
  readonly authority: FileRetirementAuthority;
  readonly snapshot: InstalledSnapshot;
  readonly inventory: FileReferenceInventory;
}

/** Trusted host requests retirement, but supplies no census or issuance proof.
 * Storage derives the complete census at expectedRevision and checks the exact
 * installed inventory. Incomplete bounds or mixed migration declarations refuse.
 * Orphaning requires no committed references; expiry uses the existing policy.
 * Positive safe-integer maxRows/maxReferences bound the complete census;
 * exhaustion refuses without publishing retirement, never truncates evidence.
 * atMs is the owning clock, not caller wire time. Captured policy is separate
 * from immutable physical identity and cannot renew original finalization. */
export interface RetireFinalizedFile {
  readonly expectedRevision: Revision;
  readonly inventory: FileReferenceInventoryIdentity;
  readonly file: FinalizedFileIdentity;
  readonly disposition: 'orphaned' | 'expired';
  readonly retention: FileRetentionPolicy;
  readonly atMs: number;
  readonly maxRows: number;
  readonly maxReferences: number;
}

/** Permanent persisted facts, not a bearer grant or a publicly minted issuer.
 * Only an authoritative lookup through the exact trusted owner storage port
 * establishes durable issuance after reopen. The original identity/evidence
 * survive retry; no lease, expiry, replacement decision or reactivation exists.
 * Files checks its persisted assignment/immutable metadata on every retry and
 * verifies bytes when present. Absent bytes succeed only with its matching
 * permanent terminal decision/tombstone, including the original retirementId;
 * absence alone is no proof of completed cleanup. Copying this DTO grants nothing. */
export interface FinalizedFileRetirement {
  readonly retirementId: string;
  readonly authority: FileRetirementAuthority;
  readonly file: FinalizedFileIdentity;
  readonly snapshot: InstalledSnapshot;
  readonly censusRevision: Revision;
  readonly retiredRevision: Revision;
  readonly retiredAtMs: number;
  readonly disposition: 'orphaned' | 'expired';
  readonly retention: FileRetentionPolicy;
}

/** Publish derives references from these exact target declarations, including
 * previously staged rows. Persist/check target inventory correspondence for the
 * migration before changing live values; omission through a legacy port refuses. */
export interface FileReferencePublishMigrationChunk extends PublishMigrationChunk {
  readonly fileReferenceInventory: FileReferenceInventory;
}

/** Activation checks exact published target declarations and every live value
 * they can reinterpret. A removal retains permanent authority/retirements and
 * cannot silently leave uncovered live rows. No idempotent pointer shortcut may
 * skip declaration/retirement correspondence. */
export type FileReferenceFlipInstalledSnapshot = FlipInstalledSnapshot & (
  | { readonly snapshot: InstalledSnapshot; readonly fileReferenceInventory: FileReferenceInventory }
  | { readonly snapshot: null; readonly fileReferenceInventory: null }
);

/** Required checked extension; generic StoragePort supplies no retirement
 * capability. These methods do not implement it. A bound adapter enforces
 * backend-derived reference admission in commit, migration publish and schema
 * activation under their SAME atomic revision fence, even when called through
 * a legacy StoragePort reference. Missing evidence refuses, never bypasses.
 * A concurrent writer either invalidates the census or loses to permanent
 * retirement without effects. References cannot be introduced after retirement.
 * Read/install returns detached facts; a structural port/record cast is no grant.
 * Multiple State stores sharing bytes remain unsupported without common atomic
 * admission. Each instance is permanently bound to exactly one authority;
 * every method validates that assignment, so ref-only lookup cannot cross stores.
 * Physical deletion is Files-owned after genuine issuer lookup. */
export interface FileReferenceStoragePort extends StoragePort {
  /** Trusted binding; install persists it once, and later calls must match the
   * reopened persisted assignment. This property's shape grants no authority. */
  readonly fileRetirementAuthority: FileRetirementAuthority;
  installFileReferenceInventory(input: InstallFileReferenceInventory): Promise<CommitResult>;
  readFileReferenceInventory(owner: string): Promise<InstalledFileReferenceInventory | null>;
  retireFinalizedFile(input: RetireFinalizedFile): Promise<FinalizedFileRetirement>;
  /** Reads the original permanent decision through this persisted owner binding.
   * Unknown identity returns null; altered/foreign authority refuses. */
  readFinalizedFileRetirement(ref: FinalizedFileRef): Promise<FinalizedFileRetirement | null>;
  publishMigrationChunk(input: FileReferencePublishMigrationChunk): Promise<CommitResult>;
  flipInstalledSnapshot(input: FileReferenceFlipInstalledSnapshot): Promise<FlipResult>;
}

/**
 * S7: structural mapping directives of one compiled per-owner transition
 * (DESIGN §11.2). INTERIM intake until L1 emits the canonical plan; the
 * engine validates directive consistency (each old model/field handled
 * exactly once, each target at most one source) before staging anything.
 */
export type MigrationDirective =
  | { readonly kind: 'renameOwner'; readonly from: string }
  | { readonly kind: 'dropOwner' }
  | { readonly kind: 'renameModel'; readonly from: string; readonly to: string }
  | {
      readonly kind: 'renameField';
      readonly model: string;
      readonly from: string;
      readonly to: string;
    }
  | { readonly kind: 'dropModel'; readonly model: string }
  | { readonly kind: 'dropField'; readonly model: string; readonly field: string }
  | { readonly kind: 'backfill'; readonly model: string }
  | { readonly kind: 'invalidate'; readonly handlerContract: string };

/**
 * S7: one compiled per-owner transition (INTERIM intake; L1 owns the
 * canonical plan format when it lands). `fromSnapshotId` + `fromDigest` must
 * match the installed snapshot exactly or the upgrade blocks; bodies are
 * content-addressed by `bodyDigest`.
 */
export interface MigrationTransition {
  readonly migrationId: string;
  readonly owner: string;
  readonly fromSnapshotId: string;
  readonly fromDigest: string;
  readonly toSnapshotId: string;
  readonly toDigest: string;
  readonly bodyDigest: string;
  readonly directives: ReadonlyArray<MigrationDirective>;
}

/** S7: old-work delivery state in the caller-supplied inventory (DESIGN §11.3). */
export type WorkItemState = 'undispatched' | 'inflight' | 'accepted' | 'uncertain';

/**
 * S7: one inventoried old-work item. Produced by L4/L7; L3 enforces:
 * `invalidate` disposes ONLY undispatched items whose handlerContract is
 * pinned by a directive — anything else blocks activation.
 */
export interface WorkInventoryItem {
  readonly intentId: string;
  readonly handlerContract: string;
  readonly state: WorkItemState;
}

/** Resumable migration phase (maps to L7 UpgradeState; see migration/index).
 * `publishing` is legacy interrupted state without a proven claim-release
 * barrier; the engine refuses it for explicit reconciliation. New publication
 * enters `publishing-rows` only after the durable release scan completes. */
export type MigrationPhase = 'staging' | 'staged' | 'releasing-claims' | 'retaining-claims' | 'publishing-rows' | 'publishing' | 'active' | 'failed';

/** S7: ordered scan position in (model, record id) space, or null at the start. */
export interface StagedRowCursor {
  readonly model: string;
  readonly recordId: string;
}

/**
 * S7: resumable progress, stored under the fence and advanced atomically
 * with the chunk it describes. `stagedCursor` bounds staging scans;
 * `publishCursor` bounds the current release, publish or retained-claim scan.
 * Each durable phase transition resets it; failure/retry preserves it.
 */
export interface MigrationProgress {
  readonly migrationId: string;
  readonly phase: MigrationPhase;
  readonly stagedCursor: StagedRowCursor | null;
  readonly publishCursor: StagedRowCursor | null;
  readonly updatedRevision: Revision;
}

/**
 * S7: one staged target row: desired model + id, target version (source
 * version for name-only, source + 1 for conversions), desired data, and the
 * retained parent link. Staged output never becomes another row's input.
 * The engine copies `created`/`createdBy`/`archivedAt` from the live
 * before-row so publish preserves creation metadata and archive state
 * through renames (DESIGN §11: protected identity/creation metadata
 * unchanged); when absent, publish falls back to live carry-over, then
 * history attribution, then 0/''/null.
 */
export interface StagedRow {
  readonly targetModel: ModelName;
  readonly recordId: RecordId;
  readonly version: RecordVersion;
  readonly data: Readonly<Record<string, unknown>>;
  readonly parent: RecordParent | null;
  readonly converted: boolean;
  readonly created?: number;
  readonly createdBy?: string;
  readonly archivedAt?: number | null;
}

/** S7: one fenced staging chunk (see `stageMigrationRows`). */
export interface StageMigrationChunk {
  readonly expectedRevision: Revision;
  readonly migrationId: string;
  readonly rows: ReadonlyArray<StagedRow>;
  readonly progress: MigrationProgress;
}

/** S7: one row disposal executed by a publish chunk (drop directives). */
export interface MigrationDrop {
  readonly model: ModelName;
  readonly recordId: RecordId;
  readonly version: RecordVersion;
  readonly history: HistoryEntry;
}

/**
 * S7: one fenced publish chunk (see `publishMigrationChunk`). Claim moves
 * ride the same batch so a model rename moves rows and their uniqueness
 * atomically; both default to [] when the chunk renames no claimed keys.
 */
export interface PublishMigrationChunk {
  readonly expectedRevision: Revision;
  readonly migrationId: string;
  readonly rows: ReadonlyArray<StagedRow>;
  readonly history: ReadonlyArray<HistoryEntry>;
  readonly drops: ReadonlyArray<MigrationDrop>;
  readonly progress: MigrationProgress;
  readonly uniqueClaims?: ReadonlyArray<UniqueClaim>;
  readonly uniqueReleases?: ReadonlyArray<UniqueRelease>;
}

/** S7: recorded skip of one invalidated intent (DESIGN §11.3 outcome). */
export interface MigrationOutcome {
  readonly migrationId: string;
  readonly kind: 'invalidated';
  readonly intentId: string;
  readonly handlerContract: string;
}

/**
 * S7: the final flip (see `flipInstalledSnapshot`). The engine cannot know
 * the flip's commit revision before it commits, so adapters OVERWRITE
 * `snapshot.installedRevision` with the actual flip revision; `installedAt`
 * is honored from the input (engine clock). A null `snapshot` is an owner
 * REMOVAL flip (dropOwner): the `owner` pointer is deleted instead of
 * installed (renameFromOwner must be null then — a removal renames
 * nothing); skips, outcomes, and the active mark still commit.
 */
export interface FlipInstalledSnapshot {
  readonly expectedRevision: Revision;
  readonly migrationId: string;
  /** Pointer key for install AND removal (equals snapshot.owner when set). */
  readonly owner: string;
  readonly snapshot: InstalledSnapshot | null;
  readonly renameFromOwner: string | null;
  readonly invalidatedIntentIds: ReadonlyArray<string>;
  readonly outcomes: ReadonlyArray<MigrationOutcome>;
}

/** S7: flip result; `flipped: false` is the idempotent already-active path. */
export interface FlipResult {
  readonly revision: Revision;
  readonly flipped: boolean;
}

/* -- B3: migration recovery + retained-work intake. -- */

/**
 * B3: which migration leg failed. `staging` covers the staging and
 * validate legs (pre-flip: abort may discard staged rows); `activation`
 * covers publish and flip (rows may have moved: forward-only retry, never
 * a destructive rollback).
 */
export type MigrationFailureLeg = 'staging' | 'activation';

/**
 * B3: durable record of one migration failure (operator evidence for the
 * abort/retry protocol). Cursors restore the exact resume position on
 * retry; the record survives abort as audit.
 */
export interface MigrationFailure {
  readonly migrationId: string;
  readonly leg: MigrationFailureLeg;
  readonly priorPhase: MigrationPhase;
  readonly stagedCursor: StagedRowCursor | null;
  readonly publishCursor: StagedRowCursor | null;
  readonly error: string;
  readonly at: number;
  readonly revision: Revision;
}

/** B3: one fenced failure write (see `recordMigrationFailure`). */
export interface RecordMigrationFailure {
  readonly expectedRevision: Revision;
  readonly migrationId: string;
  readonly leg: MigrationFailureLeg;
  readonly priorPhase: MigrationPhase;
  readonly stagedCursor: StagedRowCursor | null;
  readonly publishCursor: StagedRowCursor | null;
  readonly error: string;
  readonly at: number;
}

/** B3: one fenced pre-flip discard (see `discardStagedRows`). */
export interface DiscardStagedRows {
  readonly expectedRevision: Revision;
  readonly migrationId: string;
}

/* -- T04a: agreed generated-execution intake (frozen slice). -- */

/**
 * T04a execution-contract version. Frozen by the challenge-audit T04a slice:
 * L1 emission, L3 intake, L2 values, L6 identity/wire and L7 example
 * execution agree on this version's descriptor/invoke/observation rules.
 * Additive-only growth; T04b extends without changing these rules. Recorded
 * with producer/consumer agreement in
 * `docs/implementation/challenge-audit-run/evidence/execution-contract.md`.
 */
export const EXECUTION_CONTRACT_VERSION = 1;

/**
 * T04a pinned producer versions. Every join in this slice (L1 emission, L3
 * intake, L7 activation/loading) requires exactly these contract versions;
 * anything else is an incompatible artifact, never a silent fallback.
 */
export const T04A_PINNED_VERSIONS = {
  execution: EXECUTION_CONTRACT_VERSION,
  artifact: 1,
  state: STATE_CONTRACT_VERSION,
  values: 1,
  identity: 1,
  wire: 1,
  examples: 1,
} as const;

/**
 * T04a user-invocable operation kinds. Mirrors `ArtifactOperationKind`
 * (L1-owned `artifact.ts`); the two spellings must stay identical.
 */
export type CanonicalOperationKind = 'read' | 'create' | 'update' | 'delete' | 'scenario';

/**
 * T04a scalar input kinds. Mirrors the non-`ref` members of
 * `ArtifactOperationField` (L1-owned); L1 emission and L3 intake share this
 * closed set. Date inputs carry checked date associations beside the string kind;
 * unions and nested contracts require a richer contract.
 */
export type CanonicalScalarKind =
  | 'string'
  | 'integer'
  | 'decimal'
  | 'money'
  | 'datetime'
  | 'duration'
  | 'user'
  | 'boolean'
  | 'file'
  | 'enum';

/**
 * T04a default-input vocabulary (T09 distinctions carried into descriptors).
 * `literal` is a JSON literal evaluated at admission; `parent` resolves a
 * dot path off the loaded parent row (create only); `server` and `derived`
 * exclude the field from writable inputs and are resolved by the engine
 * (T18 execution), never by the caller. `context` is an ordinary omitted-only
 * actor default on a singular User field; supplied values remain writable.
 */
export type CanonicalFieldDefault =
  | { readonly kind: 'literal'; readonly value: unknown }
  | { readonly kind: 'parent'; readonly path: string }
  | { readonly kind: 'context'; readonly value: 'actor' }
  | { readonly kind: 'server' }
  | { readonly kind: 'derived' };

/**
 * T04a canonical operation input. `ref` inputs carry identity plus an
 * expected admitted version on mutations (L6 `MutationRef`); `versioned`
 * marks that requirement. `enumValues` is present exactly when
 * `kind === 'enum'`, in declaration order. `default` records the
 * source-declared default; admission still rejects unknown members and
 * missing required inputs (closed shape).
 *
 * T04b-p adds the `delivery` member (additive): a T14c typed `std`
 * receipt input carrying the ratified
 * {@link CanonicalDeliveryDescriptor} shared with model field tags
 * (one shape, no drift). Unknown kinds still reject the whole
 * descriptor set; loader consumption is a later T16 join.
 */
export type CanonicalInputDef =
  | {
      readonly name: string;
      readonly kind: 'ref';
      /** Optional singular nonnullable scenario/read input whose default remains host-owned. */
      readonly computedDefault?: true;
      readonly model: ModelName;
      readonly versioned: boolean;
      readonly required: boolean;
      /** Checked container metadata; reference identity remains element-owned. */
      readonly array?: { readonly required: boolean };
      readonly nullable?: boolean;
      readonly min?: number;
      readonly max?: number;
      readonly default?: CanonicalFieldDefault;
    }
  | {
      readonly name: string;
      readonly kind: CanonicalScalarKind;
      /** Checked optional scenario input whose computed default remains host-owned. */
      readonly computedDefault?: true;
      /** Checked int/datetime/text/bool/decimal/money/date/duration/user association; absence carries no type claim. */
      readonly valueType?: CanTypeId;
      readonly required: boolean;
      readonly enumValues?: ReadonlyArray<string>;
      /** Authored array lengths, associated with the checked input array marker. */
      readonly min?: number;
      readonly max?: number;
      readonly default?: CanonicalFieldDefault;
    }
  | {
      readonly name: string;
      readonly kind: 'nominal';
      /** Resolves only against this set's checked valueTypes, never a stored model by spelling. */
      readonly valueType: CanTypeId;
      readonly computedDefault?: true;
      readonly required: boolean;
      readonly min?: number;
      readonly max?: number;
      readonly default?: CanonicalFieldDefault;
    }
  | {
      readonly name: string;
      readonly kind: 'delivery';
      readonly delivery: CanonicalDeliveryDescriptor | CanonicalJudgmentDeliveryDescriptor;
      readonly required: boolean;
      readonly min?: number;
      readonly max?: number;
      readonly default?: CanonicalFieldDefault;
    };

/**
 * T04a canonical operation descriptor: the agreed L1 -> L3 intake that the
 * T16 join consumes in place of `InterimOperationDef`. Authorization
 * predicates stay engine-local until T16 maps generated policy; this
 * descriptor carries identity plus the closed input schema only.
 */
export interface CanonicalOperationDescriptor {
  readonly name: OperationName;
  readonly kind: CanonicalOperationKind;
  readonly inputs: ReadonlyArray<CanonicalInputDef>;
  /** Checked declared result; absence carries no result-type claim. */
  readonly result?: { readonly type: CanTypeId; readonly disclosure?: ScenarioResultDisclosurePlan };
}

/**
 * T04a canonical model field. `serverOnly` fields reject caller-supplied
 * values; `array` records ordinary (omit-to-empty) versus required (omission
 * rejects) arrays per T09. Absent `array` means a singular field.
 *
 * T04b-p adds the optional `delivery` member (additive): present exactly
 * when the stored field is a T14c typed `std` receipt, carrying the
 * ratified {@link CanonicalDeliveryDescriptor} shared with operation
 * inputs (one shape, no drift). T04a-era consumers ignore it.
 */
/** Flat lifecycle metadata owned by one stored enum field. Edges describe sites,
 * not actor authorization; the containing operation retains its policy. */
export interface FieldMachine {
  readonly initial: string;
  readonly states: ReadonlyArray<string>;
  readonly transitions: ReadonlyArray<{
    readonly from: string;
    readonly to: string;
    readonly operation: string;
  }>;
}

export interface CanonicalFieldDef {
  /** Checked int/datetime/text/bool/decimal/money/date/duration/user association, with optional array and nullable container suffixes. */
  readonly valueType?: CanTypeId;
  /** Checked field normalization and inclusive wire-form bounds. */
  readonly trim?: boolean;
  readonly min?: WireValue;
  readonly max?: WireValue;
  /** Type-association metadata; engine-local nullableFields still owns omission fills. */
  readonly nullable?: boolean;
  readonly machine?: FieldMachine;
  readonly required: boolean;
  readonly serverOnly: boolean;
  readonly array?: { readonly required: boolean };
  readonly default?: CanonicalFieldDefault;
  readonly delivery?: CanonicalDeliveryDescriptor | CanonicalJudgmentDeliveryDescriptor;
}

/**
 * T04a canonical model descriptor: the agreed L1 -> L3 intake that the
 * T16/T17 joins consume in place of `InterimModelDef` for the pilot scope.
 * References, hooks, invariants and locks stay engine-local interim shapes
 * until T04b extends this contract.
 */
export interface CanonicalModelDescriptor {
  readonly name: ModelName;
  readonly fields: Readonly<Record<string, CanonicalFieldDef>>;
  readonly deleteMode: DeleteMode;
  readonly uniqueKeys?: ReadonlyArray<string>;
}

/** Exact, source-ordered owning native policy ABI; missing plans never imply a scan. */
export const OWNER_MODEL_POLICY_BINDINGS_MEMBER = 'modelPolicyBindings' as const;

export interface CanonicalOwnerModelPolicies {
  readonly abi: 'state.owner-model-policies@1';
  readonly model: ModelName;
  readonly ownerPackage: string;
  /** Exact emitted ArtifactModule.path, using the ArtifactCallable.module convention. */
  readonly module: string;
  readonly rules: ReadonlyArray<
    | {
        readonly kind: 'invariant';
        readonly id: string;
        /** Every non-row dependency needs a checked reverse affected-row selector. */
        readonly dependencies: ReadonlyArray<{
          readonly id: string;
          readonly model: ModelName;
          readonly maxTargets: number;
        }>;
      }
    | { readonly kind: 'lock'; readonly id: string; readonly fields: ReadonlyArray<string> }
  >;
  readonly hooks: ReadonlyArray<{
    readonly id: string;
    readonly op: 'create' | 'update' | 'remove';
    /** Exact checked triggering CRUD identity, not an arbitrary scenario name. */
    readonly operation: OperationName;
  }>;
}

/**
 * T04a descriptor set: the versioned unit L1 emits (via artifact structures)
 * and L3 loads into its registry at the T16 join. Empty arrays are valid;
 * unknown operation kinds or input kinds reject the whole set.
 */
export interface ExecutionDescriptorSet {
  readonly contractVersion: typeof EXECUTION_CONTRACT_VERSION;
  readonly operations: ReadonlyArray<CanonicalOperationDescriptor>;
  readonly models: ReadonlyArray<CanonicalModelDescriptor>;
  /** Source-owned structural values, separate from stored record identities. */
  readonly valueTypes?: CanonicalValueTypes;
}

/**
 * T04a emitted-example state observation: examples observe committed state
 * only, through authorized queries at the committed fence revision. `query`
 * runs under the example caller's own authority (viewer projection); owner
 * reads never serve an example observation. Expected values compare with L2
 * exact-value semantics (wire encoding, never JS Number coercion); any
 * mismatch fails the row. Rejection rows additionally prove no-change via
 * the runner's snapshot comparison.
 */
export interface ExampleStateObservation {
  readonly query: QuerySpec;
  readonly revision: Revision;
}

/* -- T04b-p: provider-descriptor ratification (L3-led contract join). -- */

/**
 * T04b-p intake rule (DEFINED here; loader CONSUMPTION is a later T16
 * join, never this slice): the ratified input-kind set is `ref`, the
 * eight T04a scalars, and `delivery`. Unknown kinds reject the whole
 * descriptor set (T04a §3/§7, unchanged). The per-capability `version`
 * inside a delivery descriptor must equal the frozen capability
 * contract version exactly (T04a §7 fencing, never negotiated at
 * runtime); mismatch is an incompatible artifact with a precise error,
 * never a silent fallback. `EXECUTION_CONTRACT_VERSION` stays 1: old
 * consumers precisely reject the unknown `delivery` kind, so this
 * growth is additive-only. Ratification record:
 * `docs/implementation/challenge-audit-run/evidence/execution-contract.md`
 * §10.
 */

/**
 * T04b-p verbatim provider-result leaf. Mirrors L1 `ArtifactNominalLeaf`
 * (`artifact.ts`); the two JSON shapes must stay identical.
 *
 * `type` keeps the T13c transcribed kind spelling (`text?`, `file[]`,
 * `enum(a,b)`, nominal refs) verbatim — never a re-interpretation.
 * Ratification decision (evidence §10): no structured tag vocabulary
 * is grounded in any owner contract, so the intake carries the
 * verbatim string; any future structured vocabulary derives from
 * these leaves without loss.
 */
export interface CanonicalNominalLeaf {
  readonly name: string;
  readonly type: string;
  /** Normalization and typed wire bounds survive field reuse; defaults and authority do not. */
  readonly trim?: boolean;
  readonly min?: WireValue;
  readonly max?: WireValue;
  readonly format?: 'name';
  /** Request-local array identity constraints, independent of stored unique indexes. */
  readonly distinctBy?: 'id';
  readonly excludedIds?: ReadonlyArray<string>;
}

/**
 * T04b-p provider-result nominal. Mirrors L1 `ArtifactNominalResult`
 * (`artifact.ts`); the two JSON shapes must stay identical. `name` is
 * the source nominal spelling (e.g. `ImageRun`, never a TS wire
 * alias); `fields` are the T13c leaves in producer order.
 */
export interface CanonicalNominalResult {
  readonly name: string;
  readonly fields: ReadonlyArray<CanonicalNominalLeaf>;
}

/**
 * The one checked nominal value inventory carried by an artifact.
 * Stored model references resolve against the loader's same-load model names,
 * separately from these structural contracts, enums and aliases.
 */
export interface CanonicalValueTypes {
  readonly contracts: ReadonlyArray<CanonicalNominalResult>;
  /** Finite bounded text aliases; nominal names resolve through the checked schema. */
  readonly aliases?: ReadonlyArray<{ readonly name: string; readonly type: 'text'; readonly min: number; readonly max: number; readonly format: 'name' }>;
  readonly enums?: ReadonlyArray<{ readonly name: string; readonly cases: ReadonlyArray<string> }>;
}

/**
 * T04b-p canonical provider delivery descriptor. Mirrors L1
 * `ArtifactDeliveryDescriptor` (emitted by T15b `delivery_descriptor`
 * for T14c typed `std` receipts); the two JSON shapes must stay
 * identical — one shape shared by operation inputs
 * (`CanonicalInputDef`) and model field tags (`CanonicalFieldDef`),
 * no drift.
 *
 * `capability` + `operation` is the T13 send-target identity (the
 * `std.EmailV1.send` vocabulary); `version` is the frozen capability
 * contract version fenced per T04a §7; `result` is the declared
 * provider result with its T13c leaves. Bound-local deliveries have
 * no T13 contract identity and never take this shape.
 */
export interface CanonicalDeliveryDescriptor {
  readonly kind: 'delivery';
  readonly capability: string;
  readonly operation: string;
  readonly version: number;
  readonly result: CanonicalNominalResult;
}

/** A source-defined Judgment version is exact int64 text in the JSON artifact. */
export interface CanonicalJudgmentDeliveryDescriptor {
  readonly kind: 'delivery';
  readonly judgment: true;
  readonly capability: string;
  readonly operation: 'evaluate';
  readonly version: string;
  readonly result: CanonicalNominalResult;
}

/**
 * T04b-p ratified delivery recipe key: `delivery:<qualified-send-target>`
 * (e.g. `delivery:std.EmailV1.send`). The target is the T13 vocabulary
 * (`work.ts` observables, `catalog.rs` `delivery_observable`); the
 * `delivery:` head is the T14c/T15b recipe tag. Bound-local
 * deliveries never take this form. The module-named-`std` collision
 * rule lives in evidence §10 (declared module shadows the
 * compiler-known provider, grounded in `resolve.rs` import order).
 */
export type DeliveryRecipeKey = string & { readonly __brand: 'DeliveryRecipeKey' };
