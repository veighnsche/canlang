/**
 * Lane 04 durable-work contracts: intents, occurrences, outbox, claims,
 * dispatch guards, receipts and recovery inventory.
 *
 * Normative basis: DESIGN sections 6 (handlers/events), 7 (storage,
 * consistency, retries) and 8.1 (associated typed deliveries); DECISIONS
 * delivery-association, receipt-leaf and fixture entries (Oct 4, 2026).
 *
 * Type-only boundary. No execution engine, no storage access, no clock.
 * Rich principal/team/owner identity resolution belongs to lanes 3/6; this
 * file uses opaque string keys for scope components. Timeouts, backoff
 * arithmetic and guard evaluation live in `@canlang/work`.
 */

/** Opaque stable identity minted by the runtime. Never caller-supplied. */
export type OccurrenceId = string;

/** Opaque committed outbox item identity. */
export type OutboxId = string;

/** Opaque dispatch-claim identity for one provider-call attempt. */
export type ClaimId = string;

/**
 * Scope key components for keyed schedules and occurrences. Plain keys, not
 * the lane-3 verified identity: the runtime resolves them to an authorized
 * owner before admission.
 */
export interface WorkScope {
  /** Selected app name. */
  app: string;
  /** Owning package name for schedule keys (DESIGN section 6). */
  ownerPackage: string;
  /** Storage owner key (team D1 id or app scope marker). */
  owner: string;
}

/**
 * Committed change event payload identity (DESIGN section 6). Immutable
 * identities only, never an implicit record snapshot.
 */
export interface CommittedChangeEvent {
  recordId: string;
  /** Storage owner key; current authority state is loaded from it. */
  owner: string;
  /** Resulting record version at commit. */
  version: number;
  occurrenceId: OccurrenceId;
}

/** Lifecycle of one keyed scheduled occurrence. */
export type ScheduledOccurrenceState =
  | 'pending'
  | 'admitted'
  | 'superseded'
  | 'cancelled'
  | 'due';

/**
 * Keyed schedule entry. The key is unique within app/owner/package and
 * independent of the calling operation; replacement and cancellation commit
 * with business changes (DESIGN section 6).
 */
export interface ScheduledOccurrence {
  key: string;
  scope: WorkScope;
  /** Scheduled instant as UTC epoch milliseconds. */
  at: number;
  /** Declared event path the occurrence carries. */
  event: string;
  /** Frozen event payload declared at schedule time. */
  payload: unknown;
  state: ScheduledOccurrenceState;
}

/** Recurring `every` fanout scopes supported in v1 (DESIGN section 6). */
export type RecurringScope = 'team' | 'app';

/**
 * Admitted recurring occurrence. Identity is app + handler contract +
 * concrete owner + UTC epoch slot; missed slots coalesce per scope and
 * compatible releases mint no duplicates (DESIGN section 6).
 */
export interface RecurringOccurrence {
  occurrenceId: OccurrenceId;
  app: string;
  /** Canonical handler contract identity. */
  handler: string;
  scope: RecurringScope;
  /** Concrete verified owner key (team id or app marker). */
  owner: string;
  /** UTC epoch slot in seconds. */
  slot: number;
}

/**
 * Durable outbox item: one external effect committed with its originating
 * state. Identity derives from operation id, source declaration and
 * deterministic occurrence index (DESIGN section 7).
 */
export interface OutboxItem {
  id: OutboxId;
  /** Stable UUIDv7 operation id of the originating mutation. */
  operationId: string;
  /** Declaring source: capability operation path or queue/event target. */
  source: string;
  /** Deterministic index of this effect within its operation. */
  occurrenceIndex: number;
  /** Frozen provider inputs; versions frozen at commit. */
  request: unknown;
  /** Completed provider attempts so far. */
  attempts: number;
  state: OutboxItemState;
}

/** Persisted outbox lifecycle. Uncertain stays uncertain until reconciled. */
export type OutboxItemState =
  | 'pending'
  | 'claimed'
  | 'delivered'
  | 'failed'
  | 'uncertain'
  | 'dead';

/**
 * Dispatch claim for one provider-call attempt. Dispatch atomically checks
 * supersession and the guard before claiming (DESIGN section 6).
 */
export interface DispatchClaim {
  outboxId: OutboxId;
  claimId: ClaimId;
  /** UTC epoch milliseconds when the claim was taken. */
  claimedAt: number;
}

/**
 * Reference to a send's optional `when` dispatch guard. The predicate itself
 * is authored Can source evaluated by lanes 1/3; this lane only carries the
 * reference and the boolean verdict at dispatch time.
 */
export interface DispatchGuardRef {
  /** Absent guard means unconditional delivery of the committed event. */
  predicate: string | null;
}

/** Verdict of one guard evaluation at dispatch. False means skipped. */
export interface GuardVerdict {
  outboxId: OutboxId;
  result: boolean;
}

/**
 * Retry classification. A false authored handler `require` is a terminal
 * business failure; a transient runtime failure retries the same occurrence.
 * Neither error field proves that no remote effect occurred (DESIGN
 * sections 6-8).
 */
export type RetryClass = 'transient' | 'terminal';

/** Retry policy shape. Defaults live in `@canlang/work`, not here. */
export interface RetryPolicy {
  maxAttempts: number;
  /** UTC milliseconds from first attempt to the retry horizon. */
  horizonMs: number;
}

/**
 * Immutable authorized receipt observation at the current owner checkpoint
 * (DESIGN section 8.1). Status/result/error are read through the containing
 * record and exact grants; a text id alone grants no lookup.
 */
export interface ReceiptObservation {
  deliveryId: string;
  /** Owner checkpoint revision enrolling this observation in the read fence. */
  revision: number;
  status: ReceiptStatus;
  /** Declared typed result, or null when failed/unknown/skipped/withheld. */
  result: unknown;
  /** Safe closed error, or null when not failed. */
  error: ReceiptError | null;
}

/** Receipt status values shared with `DeliveryResult.status`. */
export type ReceiptStatus =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'skipped';

/** Closed safe error; no details, retryable or provider-response fields. */
export interface ReceiptError {
  code: string;
  message: string;
}

/** Selectable receipt properties for authorized observation. */
export type ReceiptProperty = 'id' | 'status' | 'result' | 'error';

/**
 * Pending-work inventory for lane-7 status/recovery hooks. Counts only;
 * content redaction and authorization stay with the owning reads.
 */
export interface PendingWorkInventory {
  outboxPending: number;
  outboxClaimed: number;
  outboxUncertain: number;
  outboxDead: number;
  dueOccurrences: number;
  /** Oldest uncertain item commit time, UTC epoch ms, if any. */
  oldestUncertainAt: number | null;
}
