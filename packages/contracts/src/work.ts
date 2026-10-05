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
 * file uses opaque string keys for scope components. Timeouts and backoff
 * arithmetic live in `@canlang/work`. Dispatch-guard predicates are
 * compiled by lane 1 (emission) and run at claim time in `@canlang/work`
 * through an injected evaluator (settled L3/L4 split: L1 compiles,
 * L4 runs; L3 carries the opaque name only and executes nothing).
 */

/**
 * This contract's version. Added by T13a alongside
 * `SERVICES_CONTRACT_VERSION`; the delivery-observable schemas below
 * carry their owning capability versions per entry.
 */
export const WORK_CONTRACT_VERSION = 1;

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

/**
 * Lifecycle of one keyed scheduled occurrence. "Due" is a temporal
 * condition (pending with `at` reached), not a persisted state.
 */
export type ScheduledOccurrenceState =
  | 'pending'
  | 'admitted'
  | 'superseded'
  | 'cancelled';

/**
 * Keyed schedule entry. The key is unique within app/owner/package and
 * independent of the calling operation; replacement and cancellation commit
 * with business changes (DESIGN section 6). `occurrenceId` identifies this
 * occurrence record: a replacement mints a new id while the superseded
 * record keeps its own, so supersession scopes exactly per occurrence.
 */
export interface ScheduledOccurrence {
  occurrenceId: OccurrenceId;
  key: string;
  scope: WorkScope;
  /** Scheduled instant as UTC epoch milliseconds. */
  at: number;
  /** Declared event path the occurrence carries. */
  event: string;
  /**
   * Frozen event payload record declared at schedule time. Always a
   * plain JSON record (the lane-3 `ScheduleOp.replace.payload` shape);
   * non-records are rejected at put and callers cannot mutate the
   * stored copy after the call.
   */
  payload: Readonly<Record<string, unknown>>;
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
  /**
   * Frozen provider inputs record; versions frozen at commit. Always a
   * plain JSON record (the lane-3 `OutboxIntent.arguments` shape);
   * non-records are rejected at staging and never commit.
   */
  request: Readonly<Record<string, unknown>>;
  /**
   * Originating scheduled/recurring occurrence, stamped by the runtime when
   * the intent is staged during an occurrence execution; null for direct
   * business-operation sends. Supersession joins on this id, never on the
   * event path, so same-event keys stay isolated (DESIGN section 6).
   */
  originOccurrence: OccurrenceId | null;
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
 * Reference to a send's optional `when` dispatch guard. The predicate is
 * authored Can source compiled by lane 1 (emission); this lane carries
 * the reference and runs it at claim time through an injected
 * evaluator, applying the boolean verdict.
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
 * record and exact grants; a text id alone grants no lookup. `id` is the
 * association property; completion envelopes carry it as `delivery_id`.
 */
export interface ReceiptObservation {
  id: string;
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

/**
 * Selectable receipt properties for authorized observation: the value-leaf
 * selectors of the Oct-04 status-only receipt-permissions decision. Leaf
 * selectors cannot traverse other records or expose siblings.
 */
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

/* -- T13a canonical delivery-observable schemas (L4 producer slice). -- */

/**
 * One T13a delivery-observable declaration: a qualified send target
 * observed as a `delivery(Target)` association. Status/result/error are
 * read through the containing record and exact grants at the owner
 * checkpoint (`ReceiptObservation`); a text id alone grants no lookup.
 * T13b rich relations (images/judgment/mailbox/knowledge) are out of
 * this slice and add no entries here.
 */
export interface DeliveryObservableDecl {
  /** Qualified send target, e.g. `std.EmailV1.send`. */
  target: string;
  /** Owning capability contract version (the `STD_*_VERSION`). */
  version: number;
  /** Selectable association leaves; the closed T13a set. */
  leaves: readonly ReceiptProperty[];
}

/**
 * T13a common delivery observables: the six send targets of the T13a
 * capability contracts (`services.ts`). Every entry observes the same
 * closed leaf set (`id`, `status`, `result`, `error`); the declared
 * typed result per target lives on its capability operation (`send` ->
 * `EmailAccepted`, `report` -> `ErrorAccepted`, Payments ops ->
 * `PaymentState`). Receipt summary shape is `DeliveryResult`
 * (`services.ts`); observation mechanics stay in `@canlang/work`.
 */
export const T13A_DELIVERY_OBSERVABLES: readonly DeliveryObservableDecl[] = [
  { target: 'std.EmailV1.send', version: 1, leaves: ['id', 'status', 'result', 'error'] },
  { target: 'std.ErrorsV1.report', version: 1, leaves: ['id', 'status', 'result', 'error'] },
  { target: 'std.PaymentsV1.collect', version: 1, leaves: ['id', 'status', 'result', 'error'] },
  { target: 'std.PaymentsV1.refund', version: 1, leaves: ['id', 'status', 'result', 'error'] },
  { target: 'std.PaymentsV1.cancel', version: 1, leaves: ['id', 'status', 'result', 'error'] },
  { target: 'std.PaymentsV1.reconcile', version: 1, leaves: ['id', 'status', 'result', 'error'] },
];
