/**
 * Envelope framing validators: operation IDs and closed inputs (lane 06, S3).
 *
 * Framing only: UUIDv7 shape/plausibility for `operation_id` and closed-member
 * / required-presence checks for business inputs. Full JSON-schema validation
 * of business inputs stays with the canonical invocation (L3); see ports.ts.
 *
 * Validators return `BusinessError | null` (`null` = valid) and never throw
 * on caller input. `Error` is thrown only for programmer misuse.
 */
import type { BusinessError, ClosedInputs } from '@canlang/contracts';
import type { InterfacesClock, OperationInputShape } from '../ports.js';
import { systemInterfacesClock } from '../ports.js';
import { buildBusinessError } from '../errors/envelope.js';

/**
 * Canonical UUIDv7 text shape: version nibble `7`, variant `8/9/a/b`
 * (lowercase hex, matching the wire fixtures). No `/g` flag: this pattern
 * is shared across `.test` calls and must stay stateless.
 */
export const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * DESIGN section 7 pinned bound: operation identities older than 24 hours
 * are rejected.
 */
export const OPERATION_ID_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * DESIGN section 7 pinned bound: five minutes of future clock tolerance
 * for operation identities.
 */
export const OPERATION_ID_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Extract the 48-bit unix-epoch-milliseconds timestamp from a UUIDv7 text
 * form (the `time_hi` field: first two hyphen groups). Returns `null` on
 * any shape mismatch, never throws.
 */
export function extractUuidV7Ms(id: string): number | null {
  if (typeof id !== 'string' || !UUID_V7_PATTERN.test(id)) {
    return null;
  }
  const hex = id.slice(0, 8) + id.slice(9, 13);
  const ms = Number.parseInt(hex, 16);
  return Number.isSafeInteger(ms) ? ms : null;
}

/**
 * Validate an `operation_id` for shape and time plausibility.
 *
 * DESIGN section 7 ordering note: the runtime checks for an existing
 * receipt BEFORE enforcing age for an unseen identity, and receipts are
 * owned by L3. This validator therefore checks shape/plausibility only
 * (malformed -> invalid; older than 24h -> expired; more than 5min in the
 * future -> future); it never consults receipts.
 */
export function validateOperationId(
  id: unknown,
  clock: InterfacesClock = systemInterfacesClock,
): BusinessError | null {
  if (typeof id !== 'string' || !UUID_V7_PATTERN.test(id)) {
    return buildBusinessError('validation', 'Invalid operation_id.');
  }
  // Non-null: the pattern already matched; guarded defensively (never throw).
  const issued = extractUuidV7Ms(id);
  if (issued === null) {
    return buildBusinessError('validation', 'Invalid operation_id.');
  }
  const now = (clock ?? systemInterfacesClock).nowMs();
  if (now - issued > OPERATION_ID_MAX_AGE_MS) {
    return buildBusinessError('validation', 'Expired operation_id.');
  }
  if (issued - now > OPERATION_ID_FUTURE_TOLERANCE_MS) {
    return buildBusinessError('validation', 'operation_id is from the future.');
  }
  return null;
}

/** Escape one JSON Pointer reference token (`~` -> `~0`, `/` -> `~1`). */
function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Check closed inputs against one operation's shape: unknown members fail
 * (naming the FIRST unknown key in submission order), then missing required
 * members fail (naming the first missing key in shape order). Required uses
 * presence, distinguishing omission from an explicit null. The reflected key
 * is caller input echoed for diagnostics; it is safe (never executed).
 */
export function checkClosedInputs(
  inputs: ClosedInputs,
  shape: OperationInputShape,
): BusinessError | null {
  if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) {
    return buildBusinessError('validation', 'Invalid inputs.');
  }
  for (const key of Object.keys(inputs)) {
    if (!shape.allowed.includes(key)) {
      const message = `Unknown input '${key}'.`;
      return buildBusinessError('validation', message, {
        fields: [{ path: `/${escapePointerSegment(key)}`, code: 'unknown', message }],
      });
    }
  }
  for (const key of shape.required) {
    if (!Object.prototype.hasOwnProperty.call(inputs, key)) {
      const message = `Missing required input '${key}'.`;
      return buildBusinessError('validation', message, {
        fields: [{ path: `/${escapePointerSegment(key)}`, code: 'required', message }],
      });
    }
  }
  return null;
}
