/** Producer-owned compiled module inventory for portable Worker staging. */
export const distribution = {
  modules: new URL('./', import.meta.url),
  browser: new URL('../browser/', import.meta.url),
} as const;
