// W03.1 — Frozen ordered facts and policy-specific ABI types.
// Transport v0 per shared C03 transport-contracts.json. Pure module:
// no imports, no clock/RNG/evidence/host calls. Every fact carries
// producer provenance; every count is range-validated BEFORE any
// fixed-width conversion (never coerce-then-check).

// ---- Transport and profile versions --------------------------------

/** Frozen transport major. Unknown versions never fall through. */
export const TRANSPORT_VERSION = 'v0' as const;
export type TransportVersion = typeof TRANSPORT_VERSION;

/** Work-transition decision profiles. One selection per call/job. */
export const DECISION_PROFILES = [
  'wt.rows/v0',
  'wt.policy/v0',
  'wt.receipts/v0',
] as const;
export type DecisionProfile = (typeof DECISION_PROFILES)[number];

/** Peers declare transport + profile versions up front. */
export interface VersionDeclaration {
  readonly transport: string;
  readonly profile: string;
}

// ---- Presence --------------------------------------------------------
// Presence is explicit on the wire; each profile interprets tags per
// its frozen rule (rows: JSON-safety-traversal-then-clone vs clone-only
// stay distinct; policy/receipts: own-presence per frozen rule).

/** Explicit presence tags. Absent-vs-undefined conflation forbidden. */
export const PRESENCE_TAGS = [
  'missing',
  'own-null',
  'own-undefined',
  'inherited',
  'accessor-backed',
] as const;
export type PresenceTag = (typeof PRESENCE_TAGS)[number];

// ---- Text (lossless UTF-16) -------------------------------------------

/**
 * Text/keys as lossless UTF-16 code units. Lone surrogates, controls,
 * and own `__proto__` data preserved exactly. Ordinary conversion to
 * Rust String (which can replace unpaired surrogates) is forbidden on
 * the compat path — use code-unit operations or a proved lossless route.
 */
export interface Utf16Text {
  readonly units: readonly number[];
}

// ---- f64 (exact bits) --------------------------------------------------

/**
 * IEEE-754 value with exact bits preserved, including -0, nonfinite
 * values, huge rounded JSON integers, and 1e400-style overflow
 * spellings. Numeric outcomes are never pre-collapsed by transport.
 */
export interface F64Bits {
  /** Lower 32 bits of the IEEE-754 representation. */
  readonly lo: number;
  /** Upper 32 bits of the IEEE-754 representation. */
  readonly hi: number;
}

// ---- Counts and ranges --------------------------------------------------
// Fixed-width counts/ranges are validated before conversion; overflow
// rejects before coercion.

/** Closed u32 range used for declared lengths and counts. */
export interface U32Range {
  readonly min: number;
  readonly max: number;
}

/** Declared-length/count carrier with its validated range. */
export interface RangedCount {
  readonly value: number;
  readonly range: U32Range;
}

// ---- Conditional versions (revision freshness) ---------------------------

/**
 * Stored revision/version pair for conditional facts. Freshness is a
 * host behavior; the fact carries the pair, never the verdict.
 */
export interface ConditionalVersion {
  readonly expectedRevision: number;
  readonly observedRevision: number;
  readonly version: number;
}

// ---- Opaque payload refs (call-local, never capabilities) ------------------

/**
 * Call-local opaque reference: an index/handle valid only within its
 * originating call/session. Stale, foreign, and cross-call indices are
 * rejected. Opaque refs are not authority capabilities.
 */
export interface PayloadRef {
  readonly callToken: string;
  readonly index: number;
}

// ---- Producer provenance ----------------------------------------------------

/** Which producer emitted the fact and from what source. */
export interface FactProvenance {
  readonly producer: 'ts-current' | 'ts-prepared' | 'wasm';
  /** Fixture, observation, or corpus id the fact derives from. */
  readonly source: string;
}

/** Base shape: every ordered fact carries provenance. */
export interface OrderedFact {
  readonly provenance: FactProvenance;
}

// ---- Envelopes -------------------------------------------------------------------------

/** Ordered tagged result: profile id, request token, presence-explicit payload, stage. */
export interface ResultEnvelope<T> extends OrderedFact {
  readonly profile: DecisionProfile;
  readonly requestToken: string;
  readonly payload: T;
  readonly presence: PresenceTag;
  readonly stage: 'preview' | 'confirmed';
}

/** Ordered tagged error: profile, machine code, ordered reasons, failure stage. */
export interface ErrorEnvelope extends OrderedFact {
  readonly profile: DecisionProfile;
  readonly requestToken: string;
  readonly code: string;
  readonly reasons: readonly string[];
  readonly stage: 'transport' | 'semantic';
  readonly transportError: boolean;
}

// ---- Rejection (transport before semantic) ------------------------------------------------

/** Machine-readable transport rejection codes. */
export const TRANSPORT_REJECTIONS = [
  'foreign-fact',
  'unknown-transport-version',
  'unknown-profile',
  'profile-mismatch',
  'bad-declared-length',
  'truncated-frame',
  'oversized-frame',
  'short-frame',
  'count-overflow',
  'stale-ref',
  'foreign-ref',
  'cross-call-ref',
  'token-mismatch',
  'token-replay',
] as const;
export type TransportRejection = (typeof TRANSPORT_REJECTIONS)[number];

/** A rejection verdict: code + ordered human reasons. */
export interface Rejection {
  readonly code: TransportRejection;
  readonly reasons: readonly string[];
}

/**
 * Validate a peer version declaration. Unknown versions never fall
 * through to a default profile; mismatch refuses before evaluation.
 */
export function validateVersions(decl: VersionDeclaration): Rejection | null {
  if (decl.transport !== TRANSPORT_VERSION) {
    return {
      code: 'unknown-transport-version',
      reasons: [`transport '${decl.transport}' is not '${TRANSPORT_VERSION}'`],
    };
  }
  if ((DECISION_PROFILES as readonly string[]).includes(decl.profile) === false) {
    return {
      code: 'unknown-profile',
      reasons: [`profile '${decl.profile}' is not a frozen decision profile`],
    };
  }
  return null;
}

/**
 * Validate a declared count against its range BEFORE fixed-width
 * conversion. Overflow rejects before coercion (never coerce-then-check).
 * Non-integers and nonfinite values reject: counts are exact.
 */
export function validateCount(count: RangedCount): Rejection | null {
  const { value, range } = count;
  if (Number.isInteger(value) === false || Number.isFinite(value) === false) {
    return {
      code: 'count-overflow',
      reasons: ['count is not a finite integer'],
    };
  }
  if (value < range.min || value > range.max) {
    return {
      code: 'count-overflow',
      reasons: [`count ${value} outside [${range.min}, ${range.max}]`],
    };
  }
  return null;
}

/**
 * Validate that a payload ref belongs to the current call. Stale,
 * foreign, and cross-call indices are rejected; refs are never
 * authority capabilities.
 */
export function validatePayloadRef(
  ref: PayloadRef,
  currentCallToken: string,
  liveIndices: ReadonlySet<number>,
): Rejection | null {
  if (ref.callToken !== currentCallToken) {
    return {
      code: 'cross-call-ref',
      reasons: ['payload ref belongs to a different call'],
    };
  }
  if (liveIndices.has(ref.index) === false) {
    return {
      code: 'stale-ref',
      reasons: [`payload index ${ref.index} is not live in this call`],
    };
  }
  return null;
}
