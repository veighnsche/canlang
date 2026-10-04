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
