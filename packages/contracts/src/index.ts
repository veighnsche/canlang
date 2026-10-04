/**
 * Export assembly (lane 07). Producer lanes own their boundary module bodies;
 * this file only re-exports them once they land. Still to land: `values`
 * (L2), `work`/`services`/`files` (L4), `presentation` (L5),
 * `identity`/`wire` (L6).
 */
export const CONTRACTS_VERSION = 1;

export * from "./artifact.js";
export * from "./deployment.js";
export * from "./diagnostic.js";
export * from "./examples.js";
export * from "./state.js";
