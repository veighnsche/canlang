import type { CanTypeId, WireValue } from './values.js';

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
 * owners' explicit handoff per implementation/CONTRACTS.md.
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
  | { readonly op: 'is_null' | 'not_null'; readonly field: string };

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
export interface StoragePort {
  /** Read the current fence revision before state-dependent reads. */
  readRevision(): Promise<Revision>;
  /** Load one stored row by identity (authority checks happen above). */
  load(model: ModelName, id: RecordId): Promise<StoredRow | null>;
  /** Execute an authorized query at the current checkpoint. */
  query(spec: QuerySpec): Promise<ReadonlyArray<StoredRow>>;
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
   * sequence as the tiebreak (duplicate versions are reachable only via
   * direct unstaged commits; fenced writes carry unique versions).
   */
  historyFor(model: ModelName, recordId: RecordId): Promise<ReadonlyArray<HistoryEntry>>;
  /**
   * S7: installed owner snapshot, or null when the owner was never installed
   * (fresh installs take a separate path and never apply transitions).
   */
  readInstalledSnapshot(owner: string): Promise<InstalledSnapshot | null>;
  /** S7: resumable migration progress, or null when the migration never staged. */
  readMigrationProgress(migrationId: string): Promise<MigrationProgress | null>;
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

/** S7: resumable migration phase (maps to L7 UpgradeState; see migration/index). */
export type MigrationPhase = 'staging' | 'staged' | 'publishing' | 'active' | 'failed';

/** S7: ordered scan position in (model, record id) space, or null at the start. */
export interface StagedRowCursor {
  readonly model: string;
  readonly recordId: string;
}

/**
 * S7: resumable progress, stored under the fence and advanced atomically
 * with the chunk it describes. `stagedCursor` bounds staging scans;
 * `publishCursor` bounds publishing (both null at their phase start).
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
 * `implementation/challenge-audit-run/evidence/execution-contract.md`.
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
 * (T18 execution), never by the caller.
 */
export type CanonicalFieldDefault =
  | { readonly kind: 'literal'; readonly value: unknown }
  | { readonly kind: 'parent'; readonly path: string }
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
      readonly default?: CanonicalFieldDefault;
    }
  | {
      readonly name: string;
      readonly kind: 'nominal';
      /** Resolves only against this set's checked valueTypes, never a stored model by spelling. */
      readonly valueType: CanTypeId;
      readonly computedDefault?: true;
      readonly required: boolean;
      readonly default?: CanonicalFieldDefault;
    }
  | {
      readonly name: string;
      readonly kind: 'delivery';
      readonly delivery: CanonicalDeliveryDescriptor | CanonicalJudgmentDeliveryDescriptor;
      readonly required: boolean;
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
  readonly result?: { readonly type: CanTypeId };
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
 * `implementation/challenge-audit-run/evidence/execution-contract.md`
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
  /** Value constraints survive source field-type reuse; defaults and authority do not. */
  readonly min?: number;
  readonly max?: number;
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

/** The one checked nominal schema inventory carried by an artifact. */
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
