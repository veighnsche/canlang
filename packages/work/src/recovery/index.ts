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
  ScheduledOccurrence,
} from '../../../contracts/src/work.js';
import type { WorkInventoryItem } from '../../../contracts/src/state.js';

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
