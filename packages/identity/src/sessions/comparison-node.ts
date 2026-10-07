import { timingSafeEqual } from 'node:crypto';

export function nativeCompare(a: Uint8Array, b: Uint8Array): boolean {
  return timingSafeEqual(a, b);
}
