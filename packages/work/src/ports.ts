/**
 * Port interfaces and TEST-ONLY doubles for the `@canlang/work` kernel.
 *
 * The interfaces below (`OutboxStorePort`, `ScheduleStorePort`,
 * `OccurrenceStorePort`, `SupersessionPort`, `ClockPort`, `ClaimIdPort`,
 * `RandomPort`) are the seam where the real lane-3 state ports plug in.
 *
 * The `TestOnly*` classes are TEST-ONLY in-memory doubles that back unit
 * tests. They are single-owner, non-durable, non-atomic and unbounded; they
 * must never ship in production code. In particular they are NOT a commit
 * engine: they perform no revision fencing, no batching and no contention
 * handling.
 *
 * Atomicity the real lane-3 implementer must provide (DESIGN section 7):
 *
 * - Owner fence: every mutating port call executes inside the caller's
 *   database-wide optimistic revision fence (read revision, evaluate, single
 *   D1 batch asserting the revision while applying writes and bumping it).
 *   Ports never open their own transactions around the fence.
 * - Commit gate: a staged outbox intent becomes dispatchable only in the same
 *   fenced batch that persists its commit marker. A crash before batch
 *   success leaves nothing dispatchable; dispatch re-checks the marker.
 * - Claim: the real dispatcher must re-verify (commit marker present, outbox
 *   state still `pending`, id absent from the supersession set, guard verdict
 *   recorded for this dispatch) and transition `pending` -> `claimed` with
 *   the claim record in ONE conditional batch. Concurrent claimants: exactly
 *   one wins; losers observe the winner's claim.
 * - Schedules: keyed put/replace/cancel state transitions and their
 *   supersession marks commit in the same batch as the originating business
 *   write. Concurrent writers to one key serialize on the fence; losers retry
 *   evaluation, never silently overwrite.
 * - Occurrence receipts: put-if-absent on `occurrenceId`. Concurrent
 *   admitters: exactly one executes the handler; losers replay the winner's
 *   receipt and never re-execute.
 * - Due scans: the row supplier reads under a revision-validated snapshot and
 *   returns an opaque resume cursor whenever unreturned rows remain. Cursors
 *   stay valid across admissions; rows admitted after a scan started may
 *   surface on resume, but rows in the scanned range are never silently
 *   dropped.
 * - Claim expiry: a `claimed` -> `pending` release happens only when the
 *   recorded claim is older than the max age AND no completion or reconcile
 *   record exists for the item, evaluated and applied in one batch.
 */
import type {
  ClaimId,
  OccurrenceId,
  OutboxId,
  OutboxItem,
  ScheduledOccurrence,
  WorkScope,
} from '@canlang/contracts';

/** Minimal wall-clock seam. The kernel never reads time implicitly. */
export interface ClockPort {
  /** Current time as UTC epoch milliseconds. */
  nowMs(): number;
}

/** Opaque dispatch-claim identity mint. */
export interface ClaimIdPort {
  nextClaimId(): ClaimId;
}

/** Runtime-minted occurrence identity for keyed schedule records. */
export interface OccurrenceIdPort {
  nextOccurrenceId(): OccurrenceId;
}

/**
 * Injected unit randomness for backoff jitter. Must yield values in [0, 1).
 * The kernel clamps defensively so documented jitter bounds always hold.
 */
export interface RandomPort {
  nextUnit(): number;
}

/** Durable outbox item storage. */
export interface OutboxStorePort {
  get(id: OutboxId): OutboxItem | null;
  put(item: OutboxItem): void;
  /** All items declared by one source, in stable id order. */
  listBySource(source: string): OutboxItem[];
  /** All items stamped with one origin occurrence, in stable id order. */
  listByOriginOccurrence(occurrenceId: OccurrenceId): OutboxItem[];
  /** All items, in stable id order. */
  listAll(): OutboxItem[];
}

/** Keyed schedule storage. Keys are unique within app/owner/package. */
export interface ScheduleStorePort {
  get(scope: WorkScope, key: string): ScheduledOccurrence | null;
  put(entry: ScheduledOccurrence): void;
  /** Pending entries with `at` reached, oldest first. */
  listDue(nowMs: number): ScheduledOccurrence[];
  /** All entries, in stable key order. */
  listAll(): ScheduledOccurrence[];
}

/** Recorded execution receipt for one admitted occurrence. */
export interface OccurrenceReceipt {
  occurrenceId: OccurrenceId;
  status: 'completed' | 'failed';
  /** Declared typed result, or null when failed. */
  result: unknown;
  /** Closed error code, or null when completed. */
  code: string | null;
  /** Closed error message, or null when completed. */
  message: string | null;
  /** UTC epoch milliseconds when the receipt was recorded. */
  recordedAtMs: number;
}

/** Occurrence receipt storage, keyed by runtime-minted occurrence id. */
export interface OccurrenceStorePort {
  getReceipt(occurrenceId: OccurrenceId): OccurrenceReceipt | null;
  hasReceipt(occurrenceId: OccurrenceId): boolean;
  /**
   * Record a receipt. The real implementation is put-if-absent; concurrent
   * admitters serialize so exactly one executes and the rest replay.
   */
  putReceipt(receipt: OccurrenceReceipt): void;
}

/**
 * Supersession registry for delivery intents whose occurrence was superseded
 * or cancelled. Dispatch checks this before the guard; the real registry is
 * written in the same fenced batch as the schedule transition.
 */
export interface SupersessionPort {
  isSuperseded(outboxId: OutboxId): boolean;
  markSuperseded(outboxIds: readonly OutboxId[]): void;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** TEST-ONLY in-memory outbox store. See file header. */
export class TestOnlyMemoryOutboxStore implements OutboxStorePort {
  private readonly items = new Map<OutboxId, OutboxItem>();

  get(id: OutboxId): OutboxItem | null {
    return this.items.get(id) ?? null;
  }

  put(item: OutboxItem): void {
    this.items.set(item.id, item);
  }

  listBySource(source: string): OutboxItem[] {
    return [...this.items.values()]
      .filter((item) => item.source === source)
      .sort((a, b) => compareStrings(a.id, b.id));
  }

  listByOriginOccurrence(occurrenceId: OccurrenceId): OutboxItem[] {
    return [...this.items.values()]
      .filter((item) => item.originOccurrence === occurrenceId)
      .sort((a, b) => compareStrings(a.id, b.id));
  }

  listAll(): OutboxItem[] {
    return [...this.items.values()].sort((a, b) => compareStrings(a.id, b.id));
  }
}

/** TEST-ONLY in-memory schedule store. See file header. */
export class TestOnlyMemoryScheduleStore implements ScheduleStorePort {
  private readonly entries = new Map<string, ScheduledOccurrence>();

  private static keyOf(scope: WorkScope, key: string): string {
    // Internal map key only; occurrence identity is the record's occurrenceId.
    return `${scope.app}\0${scope.owner}\0${scope.ownerPackage}\0${key}`;
  }

  get(scope: WorkScope, key: string): ScheduledOccurrence | null {
    return this.entries.get(TestOnlyMemoryScheduleStore.keyOf(scope, key)) ?? null;
  }

  put(entry: ScheduledOccurrence): void {
    this.entries.set(TestOnlyMemoryScheduleStore.keyOf(entry.scope, entry.key), entry);
  }

  listDue(nowMs: number): ScheduledOccurrence[] {
    return [...this.entries.values()]
      .filter((entry) => entry.state === 'pending' && entry.at <= nowMs)
      .sort(
        (a, b) => a.at - b.at || compareStrings(a.key, b.key),
      );
  }

  listAll(): ScheduledOccurrence[] {
    return [...this.entries.values()].sort((a, b) => compareStrings(a.key, b.key));
  }
}

/** TEST-ONLY in-memory occurrence receipt store. See file header. */
export class TestOnlyMemoryOccurrenceStore implements OccurrenceStorePort {
  private readonly receipts = new Map<OccurrenceId, OccurrenceReceipt>();

  getReceipt(occurrenceId: OccurrenceId): OccurrenceReceipt | null {
    return this.receipts.get(occurrenceId) ?? null;
  }

  hasReceipt(occurrenceId: OccurrenceId): boolean {
    return this.receipts.has(occurrenceId);
  }

  putReceipt(receipt: OccurrenceReceipt): void {
    // Single-threaded TEST-ONLY overwrite. Production MUST be put-if-absent
    // per the header contract; replay tests here prove idempotent handling,
    // not the concurrency guarantee.
    this.receipts.set(receipt.occurrenceId, receipt);
  }
}

/** TEST-ONLY in-memory supersession registry. See file header. */
export class TestOnlyMemorySupersession implements SupersessionPort {
  private readonly superseded = new Set<OutboxId>();

  isSuperseded(outboxId: OutboxId): boolean {
    return this.superseded.has(outboxId);
  }

  markSuperseded(outboxIds: readonly OutboxId[]): void {
    for (const id of outboxIds) {
      this.superseded.add(id);
    }
  }
}

/** TEST-ONLY manually advanced clock. See file header. */
export class TestOnlyManualClock implements ClockPort {
  private current: number;

  constructor(initialMs = 0) {
    if (!Number.isFinite(initialMs) || initialMs < 0) {
      throw new RangeError('TestOnlyManualClock: initialMs must be finite and >= 0');
    }
    this.current = initialMs;
  }

  nowMs(): number {
    return this.current;
  }

  setNowMs(value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError('TestOnlyManualClock: value must be finite and >= 0');
    }
    this.current = value;
  }

  advanceBy(deltaMs: number): void {
    if (!Number.isFinite(deltaMs)) {
      throw new RangeError('TestOnlyManualClock: deltaMs must be finite');
    }
    this.current += deltaMs;
  }
}

/** TEST-ONLY counter-based occurrence id mint. See file header. */
export class TestOnlyCounterOccurrenceIds implements OccurrenceIdPort {
  private next = 1;
  private readonly prefix: string;

  constructor(prefix = 'occ') {
    this.prefix = prefix;
  }

  nextOccurrenceId(): OccurrenceId {
    const id = `${this.prefix}_${this.next}`;
    this.next += 1;
    return id;
  }
}

/** TEST-ONLY counter-based claim id mint. See file header. */
export class TestOnlyCounterClaimIds implements ClaimIdPort {
  private next = 1;
  private readonly prefix: string;

  constructor(prefix = 'claim') {
    this.prefix = prefix;
  }

  nextClaimId(): ClaimId {
    const id = `${this.prefix}_${this.next}`;
    this.next += 1;
    return id;
  }
}

/**
 * TEST-ONLY scripted unit randomness. Replays the script, then repeats its
 * last value so multi-call flows stay deterministic. See file header.
 */
export class TestOnlyScriptedRandom implements RandomPort {
  private index = 0;
  private readonly values: readonly number[];

  constructor(values: readonly number[]) {
    this.values = values;
    if (values.length === 0) {
      throw new RangeError('TestOnlyScriptedRandom: script must not be empty');
    }
    for (const value of values) {
      if (!Number.isFinite(value) || value < 0 || value >= 1) {
        throw new RangeError('TestOnlyScriptedRandom: script values must be in [0, 1)');
      }
    }
  }

  nextUnit(): number {
    const value = this.values[Math.min(this.index, this.values.length - 1)];
    // Unreachable: the constructor rejects an empty script, so the clamped
    // index always lands in bounds. The guard satisfies noUncheckedIndexedAccess.
    if (value === undefined) throw new RangeError('TestOnlyScriptedRandom: script index out of range');
    this.index += 1;
    return value;
  }
}
