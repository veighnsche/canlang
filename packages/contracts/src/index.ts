/**
 * Export assembly (lane 07). Producer lanes own their boundary module bodies;
 * this file only re-exports them once they land. Still to land: `values`
 * (L2), `work`/`services`/`files` (L4).
 *
 * KNOWN CONFLICT (handoff to L3+L6, see lane-07 status): `state.ts` and
 * `wire.ts` both export `OperationId` with different definitions (branded
 * vs plain string). The explicit re-export below is the interim pick: the
 * branded form narrows to the plain string, so it satisfies both use sites.
 * The owners must still reconcile to one canonical definition.
 */
export const CONTRACTS_VERSION = 1;

export * from "./artifact.js";
export * from "./deployment.js";
export * from "./diagnostic.js";
export * from "./examples.js";
export * from "./identity.js";
export * from "./presentation.js";
export * from "./state.js";
export * from "./wire.js";
export type { OperationId } from "./state.js";
