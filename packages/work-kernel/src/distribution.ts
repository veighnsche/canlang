/** Producer-owned compiled module inventory for portable Worker staging.
 *  The dist root (not dist/src): the root facade imports the sibling
 *  wasm-backend planner across, so the real distribution closure needs
 *  `src/` and `bindings/` together with their relative links intact.
 *  Emitted conformance/host test modules are excluded from the Worker
 *  map by the deploy bundle's exact test-only key set. */
export const distribution = {
  modules: new URL('../', import.meta.url),
  /** Explicit build:wasm output; ordinary package preparation does not activate it. */
  recoveryWasm: new URL('../native/recovery.wasm', import.meta.url),
} as const;
