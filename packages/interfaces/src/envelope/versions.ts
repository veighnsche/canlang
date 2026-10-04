/**
 * Expected-version (optimistic concurrency) check (lane 06, S3; DESIGN
 * sections 5, 7, 10: stale submitted versions yield `conflict`).
 *
 * Returns `BusinessError | null` (`null` = versions agree), never throws
 * on caller input.
 */
import type { BusinessError } from '@canlang/contracts';
import { buildBusinessError } from '../errors/envelope.js';

/** Canonical decimal integer: digits only (same rule as the ref codecs). */
const CANONICAL_VERSION_PATTERN = /^[0-9]+$/;

/**
 * Compare a submitted expected version against the current admitted
 * version. Both are already-validated canonical decimal-integer strings;
 * comparison is numeric via BigInt, so arbitrary magnitudes (e.g. 2^100)
 * compare exactly. A mismatch is a `conflict` naming both versions.
 *
 * Defensive layers (callers pre-validate; this never throws): the canonical
 * shape is rechecked first because BigInt's own string grammar is looser
 * than canonical decimal (`BigInt('')` is `0n`, whitespace trims, and
 * `0x`/`0b`/`0o` prefixes parse), and the conversion itself stays wrapped
 * in try/catch so non-string misuse still fails as `validation`.
 */
export function checkExpectedVersion(
  submitted: string,
  current: string,
  fieldPath = '/record/version',
): BusinessError | null {
  if (
    typeof submitted !== 'string' ||
    typeof current !== 'string' ||
    !CANONICAL_VERSION_PATTERN.test(submitted) ||
    !CANONICAL_VERSION_PATTERN.test(current)
  ) {
    return buildBusinessError('validation', 'Invalid version.');
  }
  let submittedVersion: bigint;
  let currentVersion: bigint;
  try {
    submittedVersion = BigInt(submitted);
    currentVersion = BigInt(current);
  } catch {
    return buildBusinessError('validation', 'Invalid version.');
  }
  if (submittedVersion !== currentVersion) {
    return buildBusinessError('conflict', 'Record changed since it was read.', {
      fields: [
        {
          path: fieldPath,
          code: 'stale',
          message: `Expected version ${submitted}; current version is ${current}.`,
        },
      ],
    });
  }
  return null;
}
