/**
 * Recovery: pending-work inventory, bounded due-work scans and stale-claim
 * expiry for status/recovery hooks (lane 7).
 *
 * - The inventory counts pending/claimed/uncertain/dead outbox items and due
 *   occurrences, plus the oldest uncertain commit time. `OutboxItem` carries
 *   no commit timestamp in contracts, so commit times arrive via an injected
 *   resolver.
 * - Due-work scans run as bounded batches over an injected row supplier with
 *   a limit and a resume cursor. Suppliers must return a cursor whenever
 *   unreturned rows remain; the kernel surfaces `done: false` so callers
 *   resume instead of silently truncating.
 * - Claims older than the max age expire so their items can be re-driven;
 *   only items whose recorded claim is provably stale are released.
 * - Live outbox work enumerates as L3 `WorkInventoryItem`s for the
 *   upgrade-orchestrator inventory gate, with an injected
 *   handler-contract vocabulary (L3 trusts that attestation).
 */
import type {
  AssociatedReceipt,
  DispatchClaim,
  FanoutFailedReason,
  FanoutId,
  FanoutSkippedReason,
  OutboxId,
  OutboxItem,
  PendingWorkInventory,
  ReceiptAssociation,
  ReceiptStatus,
  RetryClass,
  RetryPolicy,
  ScheduledOccurrence,
} from '../../../contracts/src/work.js';
import type { WorkInventoryItem } from '../../../contracts/src/state.js';
import type {
  FanoutCheckpointRowData,
  FanoutChildRowData,
  FanoutIntentRowData,
} from '../kernel/tables.ts';
import { DEFAULT_RETRY_POLICY, classifyFailure } from '../receipt/index.ts';
import type { FailureCause, ReconcileEvidence } from '../receipt/index.ts';
import { isTerminalReceiptStatus } from '../receipt/index.ts';
import { assertKnownProgressRelation } from '../observation/association.ts';

export interface InventoryInput {
  outboxItems: readonly OutboxItem[];
  dueOccurrences: readonly ScheduledOccurrence[];
  /** Commit instant (UTC epoch ms) per outbox id; null when unknown. */
  committedAtMs: (id: OutboxId) => number | null;
}

/** Build the pending-work inventory: counts plus oldest uncertain commit. */
export function buildInventory(input: InventoryInput): PendingWorkInventory {
  let outboxPending = 0;
  let outboxClaimed = 0;
  let outboxUncertain = 0;
  let outboxDead = 0;
  let oldestUncertainAt: number | null = null;
  for (const item of input.outboxItems) {
    switch (item.state) {
      case 'pending':
        outboxPending += 1;
        break;
      case 'claimed':
        outboxClaimed += 1;
        break;
      case 'uncertain': {
        outboxUncertain += 1;
        const committed = input.committedAtMs(item.id);
        if (
          committed !== null &&
          Number.isFinite(committed) &&
          (oldestUncertainAt === null || committed < oldestUncertainAt)
        ) {
          oldestUncertainAt = committed;
        }
        break;
      }
      case 'dead':
        outboxDead += 1;
        break;
      default:
        break;
    }
  }
  return {
    outboxPending,
    outboxClaimed,
    outboxUncertain,
    outboxDead,
    dueOccurrences: input.dueOccurrences.length,
    oldestUncertainAt,
  };
}

export interface WorkInventoryInput {
  /** Live outbox snapshot; terminal items are omitted, never reported. */
  outboxItems: readonly OutboxItem[];
  /**
   * Handler-contract vocabulary for the deployment: must return the same
   * strings the migration plan pins in `invalidate` directives. Null or
   * empty means the assembly cannot map the item — enumeration throws
   * listing the unmapped ids rather than emit an attestation L3 would
   * trust but no directive could match.
   */
  handlerContractFor: (item: OutboxItem) => string | null;
}

/**
 * Enumerate live outbox work as L3 `WorkInventoryItem`s for the
 * upgrade-orchestrator inventory gate (`checkActivationInventory`).
 * `pending` maps to `undispatched`, `claimed` to `inflight`,
 * `uncertain` to `uncertain`; `delivered`/`failed`/`dead` are settled
 * and omitted (reporting them would fail the still-pending presence
 * check or block activation forever). Anything else throws as shape
 * drift. Output is intent-id sorted for stable evidence. This builder
 * never emits `accepted`: that state is produced by the draining side
 * when it takes responsibility for an item.
 */
export function buildWorkInventory(input: WorkInventoryInput): WorkInventoryItem[] {
  const items: WorkInventoryItem[] = [];
  const unmapped: string[] = [];
  for (const item of input.outboxItems) {
    if (item.state === 'delivered' || item.state === 'failed' || item.state === 'dead') {
      continue;
    }
    let state: WorkInventoryItem['state'];
    if (item.state === 'pending') {
      state = 'undispatched';
    } else if (item.state === 'claimed') {
      state = 'inflight';
    } else if (item.state === 'uncertain') {
      state = 'uncertain';
    } else {
      throw new Error(
        `buildWorkInventory: item ${JSON.stringify(item.id)} has unknown state ` +
          `${JSON.stringify(item.state)}.`,
      );
    }
    const contract = input.handlerContractFor(item);
    if (typeof contract !== 'string' || contract === '') {
      unmapped.push(item.id);
      continue;
    }
    items.push({ intentId: item.id, handlerContract: contract, state });
  }
  if (unmapped.length > 0) {
    unmapped.sort();
    throw new Error(
      'buildWorkInventory: no handler-contract mapping for ' +
        `${unmapped.map((id) => JSON.stringify(id)).join(', ')} ` +
        '(the assembly must supply the deployment vocabulary).',
    );
  }
  items.sort((a, b) => (a.intentId < b.intentId ? -1 : a.intentId > b.intentId ? 1 : 0));
  return items;
}

/** One supplier page: rows plus the opaque resume cursor, if more remain. */
export interface DueScanPage<TRow> {
  rows: TRow[];
  nextCursor: string | null;
}

/**
 * Injected due-row supplier. Must return `nextCursor` whenever unreturned
 * rows remain, and never more than `limit` rows per call.
 */
export type DueRowSupplier<TRow> = (cursor: string | null, limit: number) => DueScanPage<TRow>;

export interface DueScanOptions {
  cursor?: string | null;
  limit: number;
}

export interface DueScanResult<TRow> {
  rows: TRow[];
  nextCursor: string | null;
  /** False means unreturned rows remain: resume with `nextCursor`. */
  done: boolean;
}

/**
 * Fetch one bounded due-work batch. Over-delivery (more rows than the limit)
 * throws loudly; a missing cursor with remaining rows is a supplier contract
 * violation the caller cannot detect, so suppliers must always set it.
 */
export function scanDueBatch<TRow>(
  supplier: DueRowSupplier<TRow>,
  options: DueScanOptions,
): DueScanResult<TRow> {
  const { limit } = options;
  const cursor = options.cursor ?? null;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('scanDueBatch: limit must be an integer >= 1');
  }
  const page = supplier(cursor, limit);
  if (page.rows.length > limit) {
    throw new RangeError(
      `scanDueBatch: supplier over-delivered ${page.rows.length} rows for limit ${limit}`,
    );
  }
  const nextCursor = page.nextCursor ?? null;
  return { rows: [...page.rows], nextCursor, done: nextCursor === null };
}

export interface DrainDueScanOptions {
  limit: number;
  /** Safety cap on batches per drain; hitting it returns explicit `done: false`. */
  maxBatches: number;
  startCursor?: string | null;
}

export interface DrainDueScanResult<TRow> {
  rows: TRow[];
  nextCursor: string | null;
  done: boolean;
  batches: number;
}

/**
 * Drain due rows up to `maxBatches` batches. Never silently truncates: when
 * the cap stops the drain, `done` is false and `nextCursor` resumes exactly
 * where it stopped.
 */
export function drainDueScan<TRow>(
  supplier: DueRowSupplier<TRow>,
  options: DrainDueScanOptions,
): DrainDueScanResult<TRow> {
  if (!Number.isInteger(options.maxBatches) || options.maxBatches < 1) {
    throw new RangeError('drainDueScan: maxBatches must be an integer >= 1');
  }
  const rows: TRow[] = [];
  let cursor: string | null = options.startCursor ?? null;
  let batches = 0;
  for (;;) {
    const page = scanDueBatch(supplier, { cursor, limit: options.limit });
    batches += 1;
    rows.push(...page.rows);
    cursor = page.nextCursor;
    if (page.done || batches >= options.maxBatches) {
      return { rows, nextCursor: cursor, done: page.done, batches };
    }
  }
}

/** A claim is stale once its age reaches the max age (boundary inclusive). */
export function isClaimStale(
  claim: DispatchClaim,
  nowMs: number,
  maxClaimAgeMs: number,
): boolean {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new RangeError('isClaimStale: nowMs must be finite and >= 0');
  }
  if (!Number.isFinite(maxClaimAgeMs) || maxClaimAgeMs < 0) {
    throw new RangeError('isClaimStale: maxClaimAgeMs must be finite and >= 0');
  }
  return claim.claimedAt + maxClaimAgeMs <= nowMs;
}

/** Stale claims in stable claim-id order. */
export function findStaleClaims(
  claims: readonly DispatchClaim[],
  nowMs: number,
  maxClaimAgeMs: number,
): DispatchClaim[] {
  return claims
    .filter((claim) => isClaimStale(claim, nowMs, maxClaimAgeMs))
    .sort((a, b) => (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0));
}

export interface ReleaseStaleResult {
  /** Items with stale-claim releases applied (`claimed` -> `pending`). */
  items: OutboxItem[];
  /** Released item ids in stable order. */
  releasedIds: OutboxId[];
}

/**
 * Release claimed items whose recorded claim is stale back to `pending` so
 * recovery can re-drive them. Items without a recorded claim stay claimed
 * (a live dispatcher may hold them); non-claimed items are untouched.
 *
 * Precondition (ports.ts claim-expiry rule): callers must exclude items with
 * a completion or reconcile record first, and the real release re-verifies
 * staleness plus that exclusion in one fenced batch. This helper checks
 * claim age only.
 */
export function releaseStaleClaims(
  outboxItems: readonly OutboxItem[],
  claims: readonly DispatchClaim[],
  nowMs: number,
  maxClaimAgeMs: number,
): ReleaseStaleResult {
  const byOutbox = new Map<OutboxId, DispatchClaim>();
  for (const claim of claims) {
    byOutbox.set(claim.outboxId, claim);
  }
  const items: OutboxItem[] = [];
  const releasedIds: OutboxId[] = [];
  for (const item of outboxItems) {
    const claim = item.state === 'claimed' ? byOutbox.get(item.id) : undefined;
    if (item.state === 'claimed' && claim !== undefined && isClaimStale(claim, nowMs, maxClaimAgeMs)) {
      items.push({ ...item, state: 'pending' });
      releasedIds.push(item.id);
    } else {
      items.push(item);
    }
  }
  releasedIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { items, releasedIds };
}

/* -- T24a staging-layer failure dispositions and recovery scans. -- */

/**
 * Staging-layer disposition for one recorded failure. Mirrors
 * `recordOutcome` exactly (same classification, same attempt-cap OR
 * horizon exhaustion): transient failures within budget return to
 * `pending` for retry; exhausted transient failures dead-letter;
 * terminal business failures are final. Recovery EXECUTION (driving
 * retries, reconciling providers) is T24b's; this layer only records
 * the disposition the sweeper acts on.
 */
export type StagingDisposition = 'retry' | 'dead' | 'terminal';

export interface RecordStagingFailureInput {
  /** Live item (`pending` or `claimed`); anything else throws. */
  item: OutboxItem;
  cause: FailureCause;
  nowMs: number;
  /** UTC epoch ms of the first attempt, anchoring the retry horizon. */
  firstAttemptAtMs: number;
  policy?: RetryPolicy;
}

export interface RecordedStagingFailure {
  item: OutboxItem;
  disposition: StagingDisposition;
  retryClass: RetryClass;
  retryable: boolean;
}

export function recordStagingFailure(input: RecordStagingFailureInput): RecordedStagingFailure {
  const { item, cause } = input;
  if (item.state !== 'pending' && item.state !== 'claimed') {
    throw new Error(
      `recordStagingFailure: item ${item.id} is ${item.state}; ` +
        'failures apply to pending/claimed items only',
    );
  }
  if (!Number.isFinite(input.nowMs) || input.nowMs < 0) {
    throw new RangeError('recordStagingFailure: nowMs must be finite and >= 0');
  }
  if (!Number.isFinite(input.firstAttemptAtMs) || input.firstAttemptAtMs < 0) {
    throw new RangeError('recordStagingFailure: firstAttemptAtMs must be finite and >= 0');
  }
  const policy = input.policy ?? DEFAULT_RETRY_POLICY;
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError('recordStagingFailure: policy.maxAttempts must be an integer >= 1');
  }
  if (!Number.isFinite(policy.horizonMs) || policy.horizonMs <= 0) {
    throw new RangeError('recordStagingFailure: policy.horizonMs must be finite and > 0');
  }
  const retryClass = classifyFailure(cause);
  const attempts = item.attempts + 1;
  if (retryClass === 'terminal') {
    return {
      item: { ...item, attempts, state: 'failed' },
      disposition: 'terminal',
      retryClass,
      retryable: false,
    };
  }
  if (attempts >= policy.maxAttempts || input.nowMs - input.firstAttemptAtMs >= policy.horizonMs) {
    return {
      item: { ...item, attempts, state: 'dead' },
      disposition: 'dead',
      retryClass,
      retryable: false,
    };
  }
  return {
    item: { ...item, attempts, state: 'pending' },
    disposition: 'retry',
    retryClass,
    retryable: true,
  };
}

/**
 * One row entering the recovery scan: the outbox item plus the
 * dispatch-row fields the scan decides on (pinned guard verdict, first
 * attempt anchor, recorded failure classification). The caller assembles
 * views from stored dispatch rows; `OutboxItem` alone cannot carry them.
 */
export interface RecoverableRow {
  readonly item: OutboxItem;
  /** Last guard verdict; false pins the item undispatched (skipped). */
  readonly guardVerdict: boolean | null;
  /** First provider-attempt start, if any attempt has run. */
  readonly firstAttemptAtMs: number | null;
  /** Recorded classification; only `failed` rows carry one. */
  readonly retryClass: RetryClass | null;
}

export interface RecoveryScanInput {
  readonly rows: ReadonlyArray<RecoverableRow>;
  /** Recorded claims by outbox id (the rows' current claim, if any). */
  readonly claims: ReadonlyArray<DispatchClaim>;
  /**
   * Reconcile evidence lookup for uncertain rows: proof of what the
   * provider did, or null when unknown (unknown stays unknown).
   */
  readonly evidence: (id: OutboxId) => ReconcileEvidence | null;
  readonly nowMs: number;
  readonly maxClaimAgeMs: number;
  readonly policy?: RetryPolicy;
}

/**
 * Recovery plan: every actionable row lands in exactly one list; rows
 * needing no action (fresh claims, delivered, dead) appear in none.
 * Execution is T24b's — `resume` releases drive through the fenced
 * release/recover path, `retry` through requeue, `reconcile` through
 * the record-attempt path with provider evidence.
 */
export interface RecoveryPlan {
  /** Stale-claim rows to release back to `pending` for re-drive. */
  readonly resume: OutboxId[];
  /** Retryable rows: failed-transient within budget, uncertain not-found. */
  readonly retry: OutboxId[];
  /** Uncertain rows with decisive delivered/failed evidence to reconcile. */
  readonly reconcile: OutboxId[];
  /** Uncertain rows without evidence: untouched until evidence arrives. */
  readonly awaiting: OutboxId[];
  /** Guard-false pinned rows: never dispatched, listed never silent. */
  readonly skipped: OutboxId[];
  /** Failed-terminal (or unclassified) rows: final, never retried. */
  readonly terminal: OutboxId[];
  /** Failed-transient rows past budget: dead-letter via requeue. */
  readonly dead: OutboxId[];
}

function compareOutboxIds(a: OutboxId, b: OutboxId): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Plan one bounded recovery scan over dispatch-row views. Decision table
 * (mirrors the fenced requeue/release rules exactly):
 *
 * - `claimed` + recorded claim stale -> `resume`; fresh or unrecorded
 *   claims are untouched (a live dispatcher may hold them).
 * - `pending` + guard-false pin -> `skipped`; other pending rows need
 *   no recovery action.
 * - `failed` + transient within attempt/horizon budget -> `retry`;
 *   exhausted -> `dead`; terminal or unclassified -> `terminal`.
 * - `uncertain` + not-found evidence -> `retry`; delivered/failed
 *   evidence -> `reconcile`; no evidence -> `awaiting`.
 * - `delivered`/`dead` are settled: no action.
 *
 * All lists are id-sorted for stable evidence.
 */
export function planRecoveryScan(input: RecoveryScanInput): RecoveryPlan {
  if (!Number.isFinite(input.nowMs) || input.nowMs < 0) {
    throw new RangeError('planRecoveryScan: nowMs must be finite and >= 0');
  }
  if (!Number.isFinite(input.maxClaimAgeMs) || input.maxClaimAgeMs < 0) {
    throw new RangeError('planRecoveryScan: maxClaimAgeMs must be finite and >= 0');
  }
  const policy = input.policy ?? DEFAULT_RETRY_POLICY;
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError('planRecoveryScan: policy.maxAttempts must be an integer >= 1');
  }
  if (!Number.isFinite(policy.horizonMs) || policy.horizonMs <= 0) {
    throw new RangeError('planRecoveryScan: policy.horizonMs must be finite and > 0');
  }
  const byOutbox = new Map<OutboxId, DispatchClaim>();
  for (const claim of input.claims) {
    byOutbox.set(claim.outboxId, claim);
  }
  const resume: OutboxId[] = [];
  const retry: OutboxId[] = [];
  const reconcile: OutboxId[] = [];
  const awaiting: OutboxId[] = [];
  const skipped: OutboxId[] = [];
  const terminal: OutboxId[] = [];
  const dead: OutboxId[] = [];
  for (const row of input.rows) {
    const item = row.item;
    switch (item.state) {
      case 'pending':
        if (row.guardVerdict === false) {
          skipped.push(item.id);
        }
        break;
      case 'claimed': {
        const claim = byOutbox.get(item.id);
        if (claim !== undefined && isClaimStale(claim, input.nowMs, input.maxClaimAgeMs)) {
          resume.push(item.id);
        }
        break;
      }
      case 'failed':
        if (row.retryClass !== 'transient') {
          terminal.push(item.id);
        } else if (
          item.attempts >= policy.maxAttempts ||
          (row.firstAttemptAtMs !== null &&
            input.nowMs - row.firstAttemptAtMs >= policy.horizonMs)
        ) {
          dead.push(item.id);
        } else {
          retry.push(item.id);
        }
        break;
      case 'uncertain': {
        const evidence = input.evidence(item.id);
        if (evidence === null) {
          awaiting.push(item.id);
        } else if (evidence.kind === 'not-found') {
          retry.push(item.id);
        } else {
          reconcile.push(item.id);
        }
        break;
      }
      default:
        break;
    }
  }
  resume.sort(compareOutboxIds);
  retry.sort(compareOutboxIds);
  reconcile.sort(compareOutboxIds);
  awaiting.sort(compareOutboxIds);
  skipped.sort(compareOutboxIds);
  terminal.sort(compareOutboxIds);
  dead.sort(compareOutboxIds);
  return { resume, retry, reconcile, awaiting, skipped, terminal, dead };
}

/* -- T34-F4 fanout recovery + enumeration resume (L4 work-kernel slice). -- */

/**
 * Current lifecycle lookup for one admitted child, supplied read-only
 * by the authoritative membership producer (F5 owns production; this
 * scan only consumes). `present`/`moved` records live under current
 * state; `deleted` is DEMONSTRABLE deletion only; `unknown` (lookup
 * miss or authority failure) carries its closed failed reason and can
 * never masquerade as deletion (adopted contract §C7).
 */
export type FanoutChildLifecycle =
  | { readonly status: 'present' }
  | { readonly status: 'deleted' }
  | { readonly status: 'moved' }
  | {
      readonly status: 'unknown';
      readonly reason: Extract<
        FanoutFailedReason,
        'missing-record' | 'inaccessible-record' | 'infra-read-failure'
      >;
    };

/**
 * One child row entering the fanout recovery scan. The caller assembles
 * views from stored F2 child rows (T24 `RecoverableRow` precedent):
 * `FanoutChildRowData` alone cannot carry the claim instant, the
 * current guard verdict, the first-attempt anchor, or the lifecycle
 * lookup, and F3 records no separate claim row (its claim IS the
 * pending -> running row transition, read here read-only).
 */
export interface FanoutRecoverableRow {
  /** F2 child row data (caller reads via `readFanoutChildRow`). */
  readonly child: FanoutChildRowData;
  /**
   * Claim instant (UTC epoch ms): the running row's `updated` stamp
   * written by F3's pending -> running claim. Null when unclaimed or
   * unknown. Pending rows ignore it (T24 precedent: the pending path
   * never consults claims); running rows with null age are uncertain.
   */
  readonly claimedAtMs: number | null;
  /**
   * Current guard re-evaluation against current state; false pins the
   * child undispatched (skipped/non-applicable). Moved records are
   * re-evaluated through this verdict, never auto-kept or auto-cut.
   */
  readonly guardVerdict: boolean | null;
  /** First-attempt anchor for the retry horizon; null when none ran. */
  readonly firstAttemptAtMs: number | null;
  /** Current lifecycle lookup (read-only membership-producer view). */
  readonly lifecycle: FanoutChildLifecycle;
}

export interface FanoutRecoveryScanInput {
  /** Fanout under recovery; intent, checkpoint and rows must carry it. */
  readonly fanoutId: FanoutId;
  readonly intent: FanoutIntentRowData;
  readonly checkpoint: FanoutCheckpointRowData;
  /**
   * Drained child-row views for this fanout (F2 bounded id-sorted
   * pages). Row actions are per-row safe, but admit/phantom/gap
   * detection needs the drained set: a windowed subset would mistake
   * unpaged members for missing ones.
   */
  readonly rows: ReadonlyArray<FanoutRecoverableRow>;
  readonly nowMs: number;
  readonly maxClaimAgeMs: number;
  readonly policy?: RetryPolicy;
}

/** Record terminal `skipped` with its closed reason (attempts unchanged). */
export interface FanoutSkippedAction {
  readonly childId: string;
  readonly reason: FanoutSkippedReason;
}

/** Record terminal `failed` with its closed reason (attempts + 1). */
export interface FanoutFailedAction {
  readonly childId: string;
  readonly reason: FanoutFailedReason;
}

/**
 * Fanout recovery plan: every actionable row lands in exactly one
 * action list; rows needing no action (fresh claims, dispatched
 * pendings, terminal rows) appear in none — except running rows with
 * an unprovable claim, which are observed read-only under `uncertain`.
 * Execution is the owning driver's (F5/F7): `resume` releases drive
 * through the fenced pending -> running re-claim, terminal actions
 * commit outcome + checkpoint advance atomically (adopted §C5), and
 * `admit` inserts flow through the membership producer. Terminal
 * child rows NEVER appear in any action list: committed effects are
 * never re-executed and no unfinished effect is ever acknowledged.
 */
export interface FanoutRecoveryPlan {
  /** Running + stale within budget: release to pending for re-drive. */
  readonly resume: string[];
  /** Deleted / guard-false: record terminal skipped (attempts unchanged). */
  readonly skipped: FanoutSkippedAction[];
  /** Running + stale + exhausted: record terminal failed/exhausted. */
  readonly dead: string[];
  /** Unknown lookup/authority: record terminal failed (never deleted). */
  readonly failed: FanoutFailedAction[];
  /** Frozen members with no child row and no completion: admit. */
  readonly admit: string[];
  /** Running + fresh/unproven claim: observed read-only, never touched. */
  readonly uncertain: string[];
  /** Rows outside the frozen member set: attention, never driven. */
  readonly phantoms: string[];
  /** Completions without a terminal row: attention, never re-touched. */
  readonly checkpointGaps: string[];
  /**
   * True only when the cursor is non-null yet enumeration is provably
   * complete (nothing to admit, no gaps): the lost cursor-null is the
   * only unfinished write. Gaps force false — a partial checkpoint
   * must never read complete.
   */
  readonly finishEnumeration: boolean;
}

/** A fanout claim is stale once its age reaches the max age (boundary inclusive). */
export function isFanoutClaimStale(
  claimedAtMs: number,
  nowMs: number,
  maxClaimAgeMs: number,
): boolean {
  if (!Number.isFinite(claimedAtMs) || claimedAtMs < 0) {
    throw new RangeError('isFanoutClaimStale: claimedAtMs must be finite and >= 0');
  }
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new RangeError('isFanoutClaimStale: nowMs must be finite and >= 0');
  }
  if (!Number.isFinite(maxClaimAgeMs) || maxClaimAgeMs < 0) {
    throw new RangeError('isFanoutClaimStale: maxClaimAgeMs must be finite and >= 0');
  }
  return claimedAtMs + maxClaimAgeMs <= nowMs;
}

/**
 * Exhaustion on RECORDED attempts: the cap is reached, or the anchored
 * horizon elapsed. A null first-attempt anchor checks attempts only
 * (the horizon never started); record-time enforcement (F3) still
 * applies its required anchor, so the scan can only under-claim
 * exhaustion, never over-claim it.
 */
export function isFanoutChildExhausted(
  attempts: number,
  firstAttemptAtMs: number | null,
  nowMs: number,
  policy: RetryPolicy,
): boolean {
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new RangeError('isFanoutChildExhausted: attempts must be an integer >= 0');
  }
  if (firstAttemptAtMs !== null && (!Number.isFinite(firstAttemptAtMs) || firstAttemptAtMs < 0)) {
    throw new RangeError('isFanoutChildExhausted: firstAttemptAtMs must be finite and >= 0');
  }
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new RangeError('isFanoutChildExhausted: nowMs must be finite and >= 0');
  }
  assertFanoutRetryPolicy(policy, 'isFanoutChildExhausted');
  return (
    attempts >= policy.maxAttempts ||
    (firstAttemptAtMs !== null && nowMs - firstAttemptAtMs >= policy.horizonMs)
  );
}

function assertFanoutRetryPolicy(policy: RetryPolicy, what: string): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError(`${what}: policy.maxAttempts must be an integer >= 1`);
  }
  if (!Number.isFinite(policy.horizonMs) || policy.horizonMs <= 0) {
    throw new RangeError(`${what}: policy.horizonMs must be finite and > 0`);
  }
}

function compareChildIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const FANOUT_RECOVERABLE_STATES: ReadonlySet<string> = new Set([
  'pending',
  'running',
  'completed',
  'skipped',
  'failed',
]);

const FANOUT_UNKNOWN_LIFECYCLE_REASONS: ReadonlySet<string> = new Set([
  'missing-record',
  'inaccessible-record',
  'infra-read-failure',
]);

/**
 * Plan one recovery scan over a drained fanout row set. Decision table:
 *
 * - `running` + null/fresh claim -> `uncertain` (a live worker may
 *   hold it; T24 read-only posture — lifecycle and guard must not
 *   race a live claim).
 * - `running` + stale claim -> lifecycle first: `deleted` pins
 *   skipped/deleted, `unknown` pins failed (never deleted), then
 *   guard-false pins skipped/non-applicable (moved records resolve
 *   here), then exhaustion pins `dead` (failed/exhausted), else
 *   `resume`.
 * - `pending` + deleted/unknown/guard-false -> the same terminal
 *   pins; other pending rows need no recovery action (normal
 *   dispatch drives them).
 * - `completed`/`skipped`/`failed` are terminal: never listed, never
 *   re-executed, even when guard or lifecycle now disagree — the
 *   recorded outcome stands.
 * - Members with no row and no completion -> `admit`; rows outside
 *   the frozen set -> `phantoms`; completions without a terminal
 *   row -> `checkpointGaps`. Gaps are attention-only: the scan
 *   neither re-executes the member nor completes the row.
 *
 * One fanout per call: intent, checkpoint and rows must all carry
 * `fanoutId`, so two independent source occurrences can never share
 * a checkpoint (adopted §C8 no-supersession default). All lists are
 * id-sorted for stable evidence.
 */
export function planFanoutRecoveryScan(input: FanoutRecoveryScanInput): FanoutRecoveryPlan {
  if (typeof input.fanoutId !== 'string' || input.fanoutId === '') {
    throw new Error('planFanoutRecoveryScan: fanoutId must be a non-empty string.');
  }
  if (input.intent.fanoutId !== input.fanoutId) {
    throw new Error('planFanoutRecoveryScan: intent carries a different fanoutId.');
  }
  if (input.checkpoint.fanoutId !== input.fanoutId) {
    throw new Error('planFanoutRecoveryScan: checkpoint carries a different fanoutId.');
  }
  if (!Number.isFinite(input.nowMs) || input.nowMs < 0) {
    throw new RangeError('planFanoutRecoveryScan: nowMs must be finite and >= 0');
  }
  if (!Number.isFinite(input.maxClaimAgeMs) || input.maxClaimAgeMs < 0) {
    throw new RangeError('planFanoutRecoveryScan: maxClaimAgeMs must be finite and >= 0');
  }
  const policy = input.policy ?? DEFAULT_RETRY_POLICY;
  assertFanoutRetryPolicy(policy, 'planFanoutRecoveryScan');
  const resume: string[] = [];
  const skipped: FanoutSkippedAction[] = [];
  const dead: string[] = [];
  const failed: FanoutFailedAction[] = [];
  const uncertain: string[] = [];
  const phantoms: string[] = [];
  const memberSet = new Set<string>(input.intent.members);
  const completedSet = new Set<string>(input.checkpoint.completed);
  const rowRecordIds = new Set<string>();
  const terminalRecordIds = new Set<string>();
  for (const row of input.rows) {
    const child = row.child;
    if (child.fanoutId !== input.fanoutId) {
      throw new Error('planFanoutRecoveryScan: child row carries a different fanoutId.');
    }
    if (!FANOUT_RECOVERABLE_STATES.has(child.state)) {
      throw new Error(
        `planFanoutRecoveryScan: child ${JSON.stringify(child.childId)} has unknown state ` +
          `${JSON.stringify(child.state)}.`,
      );
    }
    if (
      row.claimedAtMs !== null &&
      (!Number.isFinite(row.claimedAtMs) || row.claimedAtMs < 0)
    ) {
      throw new RangeError('planFanoutRecoveryScan: claimedAtMs must be finite and >= 0');
    }
    if (
      row.firstAttemptAtMs !== null &&
      (!Number.isFinite(row.firstAttemptAtMs) || row.firstAttemptAtMs < 0)
    ) {
      throw new RangeError('planFanoutRecoveryScan: firstAttemptAtMs must be finite and >= 0');
    }
    const lifecycle = row.lifecycle.status;
    if (lifecycle !== 'present' && lifecycle !== 'deleted' && lifecycle !== 'moved' && lifecycle !== 'unknown') {
      throw new Error(
        `planFanoutRecoveryScan: child ${JSON.stringify(child.childId)} has unknown lifecycle ` +
          `${JSON.stringify(lifecycle)}.`,
      );
    }
    if (
      row.lifecycle.status === 'unknown' &&
      !FANOUT_UNKNOWN_LIFECYCLE_REASONS.has(row.lifecycle.reason)
    ) {
      throw new Error(
        `planFanoutRecoveryScan: child ${JSON.stringify(child.childId)} has unknown lifecycle ` +
          `reason ${JSON.stringify(row.lifecycle.reason)}.`,
      );
    }
    rowRecordIds.add(child.recordId);
    if (!memberSet.has(child.recordId)) {
      phantoms.push(child.childId);
    }
    if (child.state === 'completed' || child.state === 'skipped' || child.state === 'failed') {
      terminalRecordIds.add(child.recordId);
      continue;
    }
    if (child.state === 'running') {
      if (
        row.claimedAtMs === null ||
        !isFanoutClaimStale(row.claimedAtMs, input.nowMs, input.maxClaimAgeMs)
      ) {
        uncertain.push(child.childId);
        continue;
      }
    }
    if (row.lifecycle.status === 'deleted') {
      skipped.push({ childId: child.childId, reason: 'deleted' });
      continue;
    }
    if (row.lifecycle.status === 'unknown') {
      failed.push({ childId: child.childId, reason: row.lifecycle.reason });
      continue;
    }
    if (row.guardVerdict === false) {
      skipped.push({ childId: child.childId, reason: 'non-applicable' });
      continue;
    }
    if (child.state === 'pending') {
      continue;
    }
    if (isFanoutChildExhausted(child.attempts, row.firstAttemptAtMs, input.nowMs, policy)) {
      dead.push(child.childId);
    } else {
      resume.push(child.childId);
    }
  }
  const admit = input.intent.members.filter(
    (member) => !rowRecordIds.has(member) && !completedSet.has(member),
  );
  const checkpointGaps = input.checkpoint.completed.filter(
    (recordId) => !terminalRecordIds.has(recordId),
  );
  resume.sort(compareChildIds);
  skipped.sort((a, b) => compareChildIds(a.childId, b.childId));
  dead.sort(compareChildIds);
  failed.sort((a, b) => compareChildIds(a.childId, b.childId));
  admit.sort(compareChildIds);
  uncertain.sort(compareChildIds);
  phantoms.sort(compareChildIds);
  checkpointGaps.sort(compareChildIds);
  return {
    resume,
    skipped,
    dead,
    failed,
    admit,
    uncertain,
    phantoms,
    checkpointGaps,
    finishEnumeration: input.checkpoint.cursor !== null && admit.length === 0 && checkpointGaps.length === 0,
  };
}

/* -- T26 related-progress resume: restart re-drives only unfinished rows. -- */

/**
 * One retained association pair entering the resume scan. The caller
 * assembles views from durable rows (T24 `RecoverableRow` precedent);
 * the scan decides purely from them and writes nothing.
 */
export interface RelatedProgressRowView {
  /** Trusted relation binding persisted with the pair. */
  readonly relation: string;
  readonly association: ReceiptAssociation;
  readonly receipt: AssociatedReceipt;
}

export interface RelatedProgressResumeInput {
  /** Relation under resume; every row must carry it (no cross-relation scan). */
  readonly relation: string;
  readonly rows: ReadonlyArray<RelatedProgressRowView>;
}

/**
 * Resume plan for one relation: unfinished attempts to re-drive from
 * durable truth, terminal attempts to leave untouched. Execution is
 * the owning driver's: `resume` rows re-enter progress correlation,
 * `settled` rows are read-only retained outcomes. Both lists are
 * delivery-id sorted for stable evidence.
 */
export interface RelatedProgressResumePlan {
  readonly relation: string;
  /** `pending`/`unknown` attempts: re-drive from durable truth. */
  readonly resume: string[];
  /** Terminal attempts: retained, never re-driven. */
  readonly settled: string[];
}

const KNOWN_RESUME_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'succeeded',
  'failed',
  'unknown',
  'skipped',
]);

/**
 * Plan one relation's resume from retained rows. Decision table:
 *
 * - `pending`/`unknown` → `resume` (no outcome yet, or uncertain until
 *   reconciled);
 * - `succeeded`/`failed`/`skipped` → `settled` (terminal immutability:
 *   never re-driven, even when the driver restarts mid-sequence).
 *
 * One relation per call: rows carrying any other relation throw (F3
 * one-fanout precedent), so two relations can never resume through
 * one scan. Corrupt rows (unknown relation, unknown status, foreign
 * receipt, revision skew) throw loudly instead of planning around
 * them. The scan writes nothing; the driver commits resumed progress
 * through the fenced apply path.
 */
export function planRelatedProgressResume(
  input: RelatedProgressResumeInput,
): RelatedProgressResumePlan {
  const caller = 'planRelatedProgressResume';
  const bound = assertKnownProgressRelation(input.relation, caller);
  const resume: string[] = [];
  const settled: string[] = [];
  for (const row of input.rows) {
    assertKnownProgressRelation(row.relation, caller);
    if (row.relation !== bound) {
      throw new Error(
        `${caller}: row for ${JSON.stringify(row.association.deliveryId)} carries relation ` +
          `${JSON.stringify(row.relation)}, expected ${JSON.stringify(bound)}.`,
      );
    }
    if (!KNOWN_RESUME_STATUSES.has(row.receipt.status)) {
      throw new Error(
        `${caller}: row for ${JSON.stringify(row.association.deliveryId)} has unknown status ` +
          `${JSON.stringify(row.receipt.status)}.`,
      );
    }
    if (row.association.deliveryId !== row.receipt.deliveryId) {
      throw new Error(
        `${caller}: receipt ${JSON.stringify(row.receipt.deliveryId)} does not belong to ` +
          `association ${JSON.stringify(row.association.deliveryId)}.`,
      );
    }
    if (row.association.revision !== row.receipt.revision) {
      throw new Error(
        `${caller}: association revision ${row.association.revision} disagrees with receipt ` +
          `revision ${row.receipt.revision}.`,
      );
    }
    const status: ReceiptStatus = row.receipt.status;
    if (isTerminalReceiptStatus(status)) {
      settled.push(row.association.deliveryId);
    } else {
      resume.push(row.association.deliveryId);
    }
  }
  const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  resume.sort(byId);
  settled.sort(byId);
  return { relation: bound, resume, settled };
}
