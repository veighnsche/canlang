/** Explicit native-facade catalog for the Compiler's existing catalog input. */
export const distribution = {
  nativeCatalog: new URL('./native-catalog.json', import.meta.url),
} as const;
