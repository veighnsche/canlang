/** Producer-owned compiled module inventory for portable Worker staging. */
export const distribution = {
  modules: new URL('./', import.meta.url),
  /** Explicit build:wasm output; ordinary package preparation does not activate it. */
  recoveryWasm: new URL('../native/recovery.wasm', import.meta.url),
} as const;
