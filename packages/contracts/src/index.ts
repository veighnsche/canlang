/**
 * Export assembly (lane 07). Producer lanes add their owned boundary modules
 * here (`artifact`, `diagnostic`, `values`, `state`, `work`, `services`,
 * `files`, `presentation`, `identity`, `wire`); only lane-07 modules exist
 * so far.
 */
export const CONTRACTS_VERSION = 1;

export * from "./deployment.js";
export * from "./examples.js";
