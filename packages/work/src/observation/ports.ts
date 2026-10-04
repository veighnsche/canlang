/**
 * Observation ports: receipt leaf grants and result-content availability.
 *
 * The interfaces below (`GrantPort`, `ContentPolicyPort`) are the seam where
 * lane-3 authorization and retention checks plug into receipt observation.
 * Both are synchronous pure decisions over supplied values: the kernel never
 * fetches records, clocks or policy implicitly.
 *
 * The `TestOnly*` classes are TEST-ONLY in-memory doubles that back unit
 * tests. They encode no real authorization or retention rule and must never
 * ship in production code.
 */
import type { ReceiptProperty } from '../../../contracts/src/work.js';

/** Scoping context for one leaf-grant decision. */
export interface ObservationGrantContext {
  /** Association delivery id under observation. */
  deliveryId: string;
  /** Owner checkpoint revision enrolling this observation in the read fence. */
  revision: number;
}

/**
 * Per-leaf receipt grant check. The kernel consults this only for requested
 * nullable leaves (`result`/`error`); `id` and `status` are always truthful
 * summary fields (see `observation.ts`) and are never consulted here.
 */
export interface GrantPort {
  mayObserve(property: ReceiptProperty, context: ObservationGrantContext): boolean;
}

/**
 * Result-content availability: expiry/withholding of the stored result
 * payload, independent of the retained status summary. Consulted only for a
 * granted requested non-null result with a non-null content ref.
 */
export interface ContentPolicyPort {
  isResultAvailable(contentRef: string, nowMs: number): boolean;
}

/** TEST-ONLY grants that allow every leaf. See file header. */
export class TestOnlyAllowAllGrants implements GrantPort {
  mayObserve(property: ReceiptProperty, context: ObservationGrantContext): boolean {
    void property;
    void context;
    return true;
  }
}

/** TEST-ONLY grants that deny every leaf. See file header. */
export class TestOnlyDenyAllGrants implements GrantPort {
  mayObserve(property: ReceiptProperty, context: ObservationGrantContext): boolean {
    void property;
    void context;
    return false;
  }
}

/** TEST-ONLY grants allowing exactly the listed leaves. See file header. */
export class TestOnlyGrantSet implements GrantPort {
  private readonly granted: ReadonlySet<ReceiptProperty>;

  constructor(granted: readonly ReceiptProperty[]) {
    this.granted = new Set(granted);
  }

  mayObserve(property: ReceiptProperty, context: ObservationGrantContext): boolean {
    void context;
    return this.granted.has(property);
  }
}

/**
 * TEST-ONLY scripted availability. Replays the script, then repeats its last
 * value so multi-call flows stay deterministic. See file header.
 */
export class TestOnlyScriptedAvailability implements ContentPolicyPort {
  private index = 0;
  private readonly values: readonly boolean[];

  constructor(values: readonly boolean[]) {
    if (values.length === 0) {
      throw new RangeError('TestOnlyScriptedAvailability: script must not be empty');
    }
    this.values = values;
  }

  isResultAvailable(contentRef: string, nowMs: number): boolean {
    void contentRef;
    void nowMs;
    const value = this.values[Math.min(this.index, this.values.length - 1)];
    this.index += 1;
    return value;
  }
}

/**
 * TEST-ONLY per-ref availability map. Refs absent from the map read as
 * unavailable (fail closed). See file header.
 */
export class TestOnlyAvailabilityMap implements ContentPolicyPort {
  private readonly available: Readonly<Record<string, boolean>>;

  constructor(available: Readonly<Record<string, boolean>> = {}) {
    this.available = available;
  }

  isResultAvailable(contentRef: string, nowMs: number): boolean {
    void nowMs;
    return this.available[contentRef] ?? false;
  }
}
