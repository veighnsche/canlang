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

/* -- T13b canonical delivery-observable schemas (L4 producer slice). -- */

/**
 * T13b rich delivery observables: the ten send targets of the T13b
 * capability contracts (`services.ts`: `STD_TEXT_GENERATION_V1_`,
 * `STD_IMAGES_V1_`, `STD_MAILBOX_V1_CONTRACT`). Same closed leaf
 * set as T13a; the declared typed result per target lives on its
 * capability operation (`generate`/`cancel`/`reconcile` ->
 * `TextRun`; `inspect` -> `WorkflowInspection`; `validate` ->
 * `WorkflowValidation`; `submit`/`cancel`/`reconcile` ->
 * `ImageRun`; `reply`/`reconcile` -> `MailReplyOutcome`).
 *
 * Progress reads the current typed result: drafts derive
 * `request?.progress?.state/content/detail` (CanChat.can:17-19,
 * CanCreative.can:19-20) and drive progress assertions by varying
 * the fixture `result` (CanChat.can:169-174,
 * CanCreative.can:173-179), so `.progress` needs no separate
 * payload type — it is the latest observed result snapshot.
 *
 * In-corpus send targets (`Judge.evaluate`, `Writer.draft`,
 * `Handbook.*`) need no entries here: their observables derive
 * from source declarations owned by the declaring package (B12 /
 * T28), not from L4 canonical contracts. `JudgmentSpec`,
 * `KnowledgeRequest` and `IndexState` are value-only shapes with
 * no std send ops, hence no observables (T13a `DeliveryResult` /
 * `OperationOutcome` precedent).
 */
export const T13B_DELIVERY_OBSERVABLES: readonly DeliveryObservableDecl[] = [
  { target: 'std.TextGenerationV1.generate', version: 1, leaves: ['id', 'status', 'result', 'error'] },
  { target: 'std.TextGenerationV1.cancel', version: 1, leaves: ['id', 'status', 'result', 'error'] },
  { target: 'std.TextGenerationV1.reconcile', version: 1, leaves: ['id', 'status', 'result', 'error'] },
  { target: 'std.ImagesV1.inspect', version: 1, leaves: ['id', 'status', 'result', 'error'] },
  { target: 'std.ImagesV1.validate', version: 1, leaves: ['id', 'status', 'result', 'error'] },
  { target: 'std.ImagesV1.submit', version: 1, leaves: ['id', 'status', 'result', 'error'] },
  { target: 'std.ImagesV1.cancel', version: 1, leaves: ['id', 'status', 'result', 'error'] },
  { target: 'std.ImagesV1.reconcile', version: 1, leaves: ['id', 'status', 'result', 'error'] },
  { target: 'std.MailboxV1.reply', version: 1, leaves: ['id', 'status', 'result', 'error'] },
  { target: 'std.MailboxV1.reconcile', version: 1, leaves: ['id', 'status', 'result', 'error'] },
];

/* -- T25a selected-receipt mechanism contract (L4 mechanism slice). -- */

/**
 * Static locator key for one stored delivery association: the owning record
 * plus one declared delivery field. The runtime resolves the live record
 * internally (the desired `delivery(c, {record, field}, [...])` helper);
 * the stored key carries the committing store's record identity, never a
 * caller-supplied lookup string. `field` is a plain declared
 * delivery-field name: traversal (`a.b`) is rejected, never resolved.
 * Stored ID correlation uses this same locator; current-send and
 * provisioned-fixture immutable IDs keep their originating authority.
 */
export interface SelectedReceiptLocator {
  /** Owning-record identity minted by the committing store. */
  recordId: string;
  /** One declared delivery field on that record. */
  field: string;
}

/**
 * Stored current-attempt association for one locator. Replacement (an
 * ordinary versioned domain write) selects a new delivery id without
 * cancelling or erasing the old attempt; the superseded attempt keeps its
 * own retained receipt row and can never overwrite this record again.
 */
export interface ReceiptAssociation {
  locator: SelectedReceiptLocator;
  /** Current attempt's delivery id; completions carry it as `delivery_id`. */
  deliveryId: string;
  /** Canonical source identity (declaration/binding of the send). */
  source: string;
  /** Owner checkpoint revision of the latest applied receipt progress. */
  revision: number;
}

/**
 * Retained receipt row for one delivery attempt. Status/result/error follow
 * the DESIGN section 8.0 completion-consistency rules; only progress naming
 * this row's delivery id at a monotone revision may update it.
 */
export interface AssociatedReceipt {
  deliveryId: string;
  /** Owner checkpoint revision of the latest applied progress. */
  revision: number;
  status: ReceiptStatus;
  /** Declared typed result, or null when failed/unknown/skipped/withheld. */
  result: unknown;
  /** Safe closed error, or null when not failed. */
  error: ReceiptError | null;
}

/**
 * Immutable selected receipt projection: contains EXACTLY the selected
 * leaves, nothing more. Not a handle: it carries no locator, cannot be
 * assigned, submitted or used for receipt lookup, and cannot become an
 * observation locator. Unselected leaves are absent keys, never null
 * placeholders; a granted selected result/error withheld by
 * content/lifetime checks reads null under its present key.
 */
export interface SelectedReceiptProjection {
  id?: string;
  status?: ReceiptStatus;
  result?: unknown;
  error?: ReceiptError | null;
}

/* -- T34-F1 fanout contract records (L4, first implementation slice). -- */

/**
 * T34-F1 closed record vocabulary for the adopted T33-A durable
 * per-child fanout contract (both cohort spellings). Type-only boundary:
 * fanout intent, checkpoint, child identity, child outcome/progress and
 * cohort-admission diagnosis shapes only. No quota or capacity field
 * (resolution forbids), no authoring syntax, no skipping/suppression
 * rule (no successor-supersession rule is adopted), no execution
 * engine, no storage access, no clock. Durable rows ride F2; dispatch
 * claim/record rides F3; recovery resume rides F4.
 */

/** Opaque fanout intent identity minted by the runtime at trigger commit. */
export type FanoutId = string;

/**
 * Explicit source-occurrence/handler admission cutoff (C1). Membership
 * is frozen under this cutoff; late inserts are excluded from the
 * occurrence.
 */
export interface FanoutCutoff {
  sourceOccurrence: OccurrenceId;
  /** Canonical handler contract identity admitting this cohort. */
  handler: string;
}

/**
 * Adopted cohort spellings: whole-model enumeration or one parent's
 * contained reverse collection. No other spelling is admitted here;
 * anything else stays diagnosed (`FanoutCohortDiagnosis`).
 */
export type FanoutCohortKind = 'model' | 'anchored-collection';

/**
 * Committed fanout intent (C1/C2): frozen cohort membership set plus
 * cutoff marker plus source occurrence. Committed atomically with the
 * source's own domain truth; child progress is separate and never
 * redefines source success.
 */
export interface FanoutIntent {
  id: FanoutId;
  cutoff: FanoutCutoff;
  cohort: FanoutCohortKind;
  /**
   * Frozen canonical record identities admitted at the cutoff. The
   * complete set for this occurrence; never truncated, never extended
   * by late inserts.
   */
  members: readonly string[];
}

/**
 * Stable child occurrence identity (C3): parent/source occurrence plus
 * canonical handler identity plus canonical record identity. The
 * handler component prevents Commitment/Swap or other handlers on one
 * source event from colliding. Duplicate delivery replays the existing
 * parent/child outcomes under this identity and mints nothing new.
 */
export interface FanoutChildId {
  parentOccurrence: OccurrenceId;
  /** Canonical handler contract identity. */
  handler: string;
  /** Canonical record identity within the frozen cohort. */
  recordId: string;
}

/**
 * Durable fanout checkpoint (M2/C5): completed-child set plus
 * enumeration cursor. Advancement commits in the same owner
 * transaction as each child's effects; a crash replays at most the
 * un-checkpointed child.
 */
export interface FanoutCheckpoint {
  fanoutId: FanoutId;
  /**
   * Canonical record ids with a recorded terminal child outcome,
   * scoped by `fanoutId` (parent occurrence + handler join via the
   * intent's cutoff). Never re-executed after recovery.
   */
  completed: readonly string[];
  /**
   * Opaque enumeration cursor; null only when enumeration is fully
   * admitted. A non-null cursor means resume, never silent truncation.
   */
  cursor: string | null;
}

/** Per-child lifecycle states (C6). */
export type FanoutChildState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'skipped'
  | 'failed';

/** Terminal per-child states: every admitted identity ends in one. */
export type FanoutChildTerminalState = 'completed' | 'skipped' | 'failed';

/**
 * Closed skipped-outcome attribution (C7). A demonstrably deleted child
 * records `deleted`; a moved record re-evaluated against current
 * parent/body conditions records `non-applicable` when the body does
 * not apply. Unknown lookup or authority failure is never deletion
 * (see `FanoutFailedReason`); no successor-suppression reason exists.
 */
export type FanoutSkippedReason = 'deleted' | 'non-applicable';

/**
 * Closed failed-outcome attribution (C6/M6). Business rejection and
 * terminal failure are isolated from siblings; `exhausted` marks a
 * spent bounded-retry budget under the same child identity.
 * Missing/inaccessible records and infrastructure read failures stay
 * three distinct reasons; no silent successful skip.
 */
export type FanoutFailedReason =
  | 'business-rejection'
  | 'terminal'
  | 'exhausted'
  | 'missing-record'
  | 'inaccessible-record'
  | 'infra-read-failure';

/** Terminal attribution for a completed child: no further reason. */
export interface FanoutCompletedCause {
  kind: 'completed';
}

/** Terminal attribution for a skipped child (C7). */
export interface FanoutSkippedCause {
  kind: 'skipped';
  reason: FanoutSkippedReason;
}

/** Terminal attribution for a failed child (C6/M6). */
export interface FanoutFailedCause {
  kind: 'failed';
  reason: FanoutFailedReason;
}

/**
 * Closed per-child terminal attribution. `kind` always matches the
 * outcome `state`.
 */
export type FanoutChildCause =
  | FanoutCompletedCause
  | FanoutSkippedCause
  | FanoutFailedCause;

/**
 * Per-child terminal outcome record (C6/C7/M6): terminal state plus
 * retry/exhaustion attribution. Retries reuse the same `child`
 * identity; one child's outcome never rewrites a sibling's.
 */
export interface FanoutChildOutcome {
  child: FanoutChildId;
  state: FanoutChildTerminalState;
  /** Committed child attempts so far (M6). */
  attempts: number;
  cause: FanoutChildCause;
}

/**
 * Fanout progress projection (C6): retained per-state counts plus the
 * aggregate attention input. Fully terminal with failures means
 * attention, not successful completion. Data-minimized counts (C7):
 * operator progress carries no child rows.
 */
export interface FanoutProgress {
  fanoutId: FanoutId;
  pending: number;
  running: number;
  completed: number;
  skipped: number;
  failed: number;
  /** True only when every admitted identity has a terminal outcome. */
  terminal: boolean;
  /** True only when terminal with one or more failures. */
  attention: boolean;
}

/**
 * Closed cohort-admission diagnosis kinds (C9/M10): the cohort form is
 * outside the adopted contract, spans an owner boundary the child
 * transaction cannot cross, or the authoritative membership producer
 * is unavailable (a capability/admission failure, never partial
 * success).
 */
export type FanoutCohortDiagnosisKind =
  | 'unsupported-cohort'
  | 'cross-owner-cohort'
  | 'membership-unavailable';

/**
 * Cohort admission diagnosis (C9/M10). Invalid/cross-owner/
 * unimplemented cohort forms stay diagnosed until complete
 * producer/checker/runtime joins exist. Closed kinds; no silent skip,
 * no fabricated grant, no membership data.
 */
export interface FanoutCohortDiagnosis {
  kind: FanoutCohortDiagnosisKind;
  /** Stable diagnostic code for this kind. */
  code: string;
  /** Safe human-readable message. */
  message: string;
}
