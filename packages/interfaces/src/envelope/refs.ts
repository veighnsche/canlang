/**
 * Reference codecs: closed `{id}` / `{id, version}` record references
 * (lane 06, S3; DESIGN section 10: reads take `{id}`, mutations take
 * `{id, version}`, versions are canonical decimal strings).
 *
 * Parsers return `{ref} | {error}` and never throw on caller input.
 */
import type { BusinessError, MutationRef, ReadRef } from '@canlang/contracts';
import { buildBusinessError } from '../errors/envelope.js';

/**
 * Maximum accepted record-id length. Lane-06 authored transport bound
 * (DESIGN pins canonical values, not id length): rejects absurd inputs
 * before they reach storage lookups.
 */
export const MAX_ID_LENGTH = 256;

/** Canonical decimal integer: digits only (rejects negatives, decimals, whitespace). */
const VERSION_PATTERN = /^[0-9]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Escape one JSON Pointer reference token (`~` -> `~0`, `/` -> `~1`). */
function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function checkId(id: unknown): string | null {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH ? id : null;
}

/**
 * Parse a read reference: an object with a non-empty string `id`
 * (`length <= MAX_ID_LENGTH`) and no other members.
 */
export function parseReadRef(value: unknown): { ref: ReadRef } | { error: BusinessError } {
  if (!isRecord(value)) {
    return { error: buildBusinessError('validation', 'Invalid record reference.') };
  }
  const id = checkId(value['id']);
  if (id === null) {
    const message = 'Invalid record id.';
    return {
      error: buildBusinessError('validation', message, {
        fields: [{ path: '/id', code: 'invalid', message }],
      }),
    };
  }
  for (const key of Object.keys(value)) {
    if (key !== 'id') {
      const message = `Unknown member '${key}'.`;
      return {
        error: buildBusinessError('validation', message, {
          fields: [{ path: `/${escapePointerSegment(key)}`, code: 'unknown', message }],
        }),
      };
    }
  }
  return { ref: { id } };
}

/**
 * Parse a mutation reference: `id` as for reads plus a `version` that must
 * be a non-empty canonical decimal-integer STRING (JSON numbers fail, as do
 * negatives, decimals, and whitespace), and no members beyond `id`/`version`.
 * `fieldPath` is the pointer to the reference value itself (default
 * `/record`); member errors hang beneath it.
 */
export function parseMutationRef(
  value: unknown,
  fieldPath = '/record',
): { ref: MutationRef } | { error: BusinessError } {
  if (!isRecord(value)) {
    return { error: buildBusinessError('validation', 'Invalid record reference.') };
  }
  const id = checkId(value['id']);
  if (id === null) {
    const message = 'Invalid record id.';
    return {
      error: buildBusinessError('validation', message, {
        fields: [{ path: `${fieldPath}/id`, code: 'invalid', message }],
      }),
    };
  }
  const version: unknown = value['version'];
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    const message = 'Invalid record version.';
    return {
      error: buildBusinessError('validation', message, {
        fields: [{ path: `${fieldPath}/version`, code: 'invalid', message }],
      }),
    };
  }
  for (const key of Object.keys(value)) {
    if (key !== 'id' && key !== 'version') {
      const message = `Unknown member '${key}'.`;
      return {
        error: buildBusinessError('validation', message, {
          fields: [{ path: `${fieldPath}/${escapePointerSegment(key)}`, code: 'unknown', message }],
        }),
      };
    }
  }
  return { ref: { id, version } };
}
