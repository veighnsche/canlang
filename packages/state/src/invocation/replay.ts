/**
 * Lane 03 S3: stable input hashing for receipt identity and replay.
 *
 * Key presence distinguishes omission from null, so JSON-unsafe values fail
 * closed instead of collapsing distinct inputs onto one hash.
 */

import type { ClosedInputs } from '../../../contracts/src/wire.js';
import { StateError } from '../errors.js';

function failClosed(what: string): never {
  throw new StateError('validation', `Invalid operation inputs: ${what} is not supported.`);
}

/**
 * Canonical JSON serialization with recursively sorted keys. Throws a
 * `validation` StateError on BigInt, undefined values, functions, symbols,
 * NaN, and Infinity.
 */
export function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value) as string;
    case 'number':
      if (!Number.isFinite(value)) failClosed('non-finite number');
      return JSON.stringify(value) as string;
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return failClosed('bigint');
    case 'undefined':
      return failClosed('undefined');
    case 'function':
      return failClosed('function');
    case 'symbol':
      return failClosed('symbol');
    case 'object': {
      if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
        return stableStringify((value as { toJSON: () => unknown }).toJSON());
      }
      if (Array.isArray(value)) {
        const parts: string[] = [];
        for (let index = 0; index < value.length; index += 1) {
          parts.push(stableStringify(value[index]));
        }
        return `[${parts.join(',')}]`;
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        return failClosed('symbol key');
      }
      const parts: string[] = [];
      for (const key of Object.keys(value).sort()) {
        parts.push(
          `${JSON.stringify(key) as string}:${stableStringify((value as Record<string, unknown>)[key])}`,
        );
      }
      return `{${parts.join(',')}}`;
    }
  }
  return failClosed('value');
}

/** SHA-256 over the stable encoding, as lowercase hex. */
export async function hashInputs(inputs: ClosedInputs): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(inputs));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}
