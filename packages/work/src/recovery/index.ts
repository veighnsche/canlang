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
  DispatchClaim,
  OutboxId,
  OutboxItem,
  PendingWorkInventory,
  RetryClass,
  RetryPolicy,
  ScheduledOccurrence,
} from '../../../contracts/src/work.js';
import type { WorkInventoryItem } from '../../../contracts/src/state.js';
import { DEFAULT_RETRY_POLICY, classifyFailure } from '../receipt/index.ts';
import type { FailureCause, ReconcileEvidence } from '../receipt/index.ts';

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
