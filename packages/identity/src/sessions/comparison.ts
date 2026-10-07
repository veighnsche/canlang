import { nativeCompare } from '#identity-byte-compare';

/** Length rejection precedes the host primitive; only that primitive is timing-safe. */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  return nativeCompare(a, b);
}
