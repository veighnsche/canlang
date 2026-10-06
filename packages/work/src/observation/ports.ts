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
import type { ReceiptProperty } from '@canlang/contracts';

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

/* -- T25a selected-receipt grants (field-scoped, null-capable). -- */

/**
 * Scoping context for one selected-leaf grant decision. Exact leaf grants
 * are field-scoped (`notification.status` grants nothing on `notice`), so
 * the declared delivery field travels with every check. A null association
 * still consults grants — null means an actually null association, never
 * denied access — with a null delivery binding; the join binds the owning
 * record and actor by closing over them per read.
 */
export interface SelectedGrantContext {
  /** Declared delivery field under observation. */
  field: string;
  /** Current delivery id, or null when the field holds no association. */
  deliveryId: string | null;
  /** Association observation revision, or null when unassociated. */
  revision: number | null;
}

/**
 * Per-leaf selected-receipt grant check. The selected entry consults this
 * exactly once per unique selected leaf — including `id` and `status` —
 * before branching on association presence, so a denied read reveals
 * nothing about whether an association exists.
 */
export interface SelectedGrantPort {
  mayObserve(property: ReceiptProperty, context: SelectedGrantContext): boolean;
}

/**
 * Result-content availability: expiry/withholding of the stored result
 * payload, independent of the retained status summary. Consulted only for a
 * granted requested non-null result with a non-null content ref.
 */
export interface ContentPolicyPort {
  isResultAvailable(contentRef: string, nowMs: number): boolean;
}

/** TEST-ONLY grants that allow every leaf. Serves both grant ports. See file header. */
export class TestOnlyAllowAllGrants implements GrantPort, SelectedGrantPort {
  mayObserve(
    property: ReceiptProperty,
    context: ObservationGrantContext | SelectedGrantContext,
  ): boolean {
    void property;
    void context;
    return true;
  }
}

/** TEST-ONLY grants that deny every leaf. Serves both grant ports. See file header. */
export class TestOnlyDenyAllGrants implements GrantPort, SelectedGrantPort {
  mayObserve(
    property: ReceiptProperty,
    context: ObservationGrantContext | SelectedGrantContext,
  ): boolean {
    void property;
    void context;
    return false;
  }
}

/**
 * TEST-ONLY grants allowing exactly the listed leaves. Serves both grant
 * ports. See file header.
 */
export class TestOnlyGrantSet implements GrantPort, SelectedGrantPort {
  private readonly granted: ReadonlySet<ReceiptProperty>;

  constructor(granted: readonly ReceiptProperty[]) {
    this.granted = new Set(granted);
  }

  mayObserve(
    property: ReceiptProperty,
    context: ObservationGrantContext | SelectedGrantContext,
  ): boolean {
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
    return value ?? false;
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
