type NativeSubtleCrypto = SubtleCrypto & {
  timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean;
};

export function nativeCompare(a: Uint8Array, b: Uint8Array): boolean {
  const subtle = globalThis.crypto?.subtle as NativeSubtleCrypto | undefined;
  if (typeof subtle?.timingSafeEqual !== 'function') {
    throw new Error('Identity host does not provide a native timing-safe comparison.');
  }
  return subtle.timingSafeEqual(a, b);
}
