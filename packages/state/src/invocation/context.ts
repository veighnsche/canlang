/**
 * Lane 03 S3: canonical invocation context construction.
 *
 * Validates the UUIDv7 operation identity shape and freezes the admission
 * clock. Operation-AGE enforcement lives in `admit`, after the receipt
 * check: DESIGN §7 orders "first check for an existing receipt, then
 * enforce age for an unseen identity," so a live receipt replays even when
 * its identity is older than 24h. The `validation` mapping for age is
 * L3-authored (wire codes are closed; L6 to confirm).
 */

import type {
  AdmissionKind,
  InvocationContext,
  OperationId,
  OperationName,
  Principal,
  TeamScope,
} from '@canlang/contracts';
import type { ResolvedIdentity } from '@canlang/contracts';
import { StateError } from '../errors.js';

/** Operation identities older than 24h are rejected (DESIGN §7). */
export const OPERATION_ID_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Future clock tolerance for operation identities (DESIGN §7). */
export const OPERATION_ID_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Minimal structural clock port. L6 owns the canonical Clock/RandomSource
 * ports (identity/ports.ts); these converge with them at the join.
 */
export interface ClockPort {
  nowMs(): number;
}

/**
 * Minimal structural randomness port, reserved for generated IDs/values.
 * Unused in S3; converges with the L6 RandomSource at the join.
 */
export interface RandomPort {
  randomUUID(): string;
}

/**
 * UUIDv7 structural check: hex shape with the version nibble set to 7.
 * Variant bits are intentionally not enforced; the admission property we
 * need is the embedded timestamp, and rejecting on variant alone would
 * turn well-formed test fixtures into false negatives.
 */
const UUIDV7_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Extract the Unix-epoch-milliseconds timestamp from the first 48 bits of a
 * UUIDv7 operation identity, or null when the value is not a UUIDv7.
 */
export function operationIdTimestampMs(operationId: string): number | null {
  if (!UUIDV7_RE.test(operationId)) return null;
  return Number.parseInt(operationId.slice(0, 8) + operationId.slice(9, 13), 16);
}

/**
 * Enforce the operation-identity age window for an UNSEEN identity (call
 * only after the receipt check misses). Identities older than 24h or more
 * than 5 minutes in the future are rejected with `validation`.
 */
export function assertOperationIdAge(operationId: string, now: number): void {
  const timestampMs = operationIdTimestampMs(operationId);
  if (timestampMs === null) {
    throw new StateError('validation', 'Invalid operation_id; a UUIDv7 identity is required.');
  }
  if (now - timestampMs > OPERATION_ID_MAX_AGE_MS) {
    throw new StateError('validation', 'Rejected: operation identity is older than 24 hours.');
  }
  if (timestampMs - now > OPERATION_ID_FUTURE_TOLERANCE_MS) {
    throw new StateError('validation', 'Rejected: operation identity is too far in the future.');
  }
}

/**
 * Build the frozen canonical invocation context. `now` is supplied by the
 * caller (frozen once across internal retries). `kind` defaults to `user`;
 * `trusted` requires a verified non-empty trusted source and always maps
 * `actor` to null; `test` is admitted uniformly with every other kind and
 * its isolation is enforced by the caller/testkit, not here.
 *
 * Validates the identity SHAPE only; age is enforced by `admit` after the
 * receipt check (see `assertOperationIdAge`).
 */
export function buildContext(input: {
  identity: ResolvedIdentity;
  operation: OperationName;
  operationId: string;
  source: string;
  now: number;
  kind?: AdmissionKind;
  trustedSource?: string;
  /** INTERIM: deployment app name, supplied by L1 codegen at the join. */
  app?: string;
}): InvocationContext {
  const kind = input.kind ?? 'user';
  if (operationIdTimestampMs(input.operationId) === null) {
    throw new StateError('validation', 'Invalid operation_id; a UUIDv7 identity is required.');
  }
  if (kind === 'trusted' && (input.trustedSource === undefined || input.trustedSource === '')) {
    throw new StateError('validation', 'Trusted invocations require a verified trusted source.');
  }
  const rawActor = input.identity.actor;
  const actor: Principal | null =
    kind === 'trusted' || rawActor === null
      ? null
      : {
          userId: rawActor.user_id,
          email: rawActor.email,
          emailVerified: rawActor.email_verified,
        };
  const rawTeam = input.identity.team;
  const team: TeamScope | null =
    rawTeam === null ? null : { teamId: rawTeam.team_id, timezone: rawTeam.timezone };
  return {
    kind,
    app: input.app ?? '',
    actor,
    team,
    operation: input.operation,
    operationId: input.operationId as OperationId,
    source: input.source,
    now: input.now,
    ...(input.trustedSource !== undefined && input.trustedSource !== ''
      ? { trustedSource: input.trustedSource }
      : {}),
  };
}
