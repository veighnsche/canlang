/**
 * Export assembly (lane 07). Producer lanes own their boundary module bodies;
 * this file only re-exports them. All 12 modules landed; `assembly.test.ts`
 * pins the interim conflict picks plus the re-export identities (L5 S4
 * wire set, L4 S8 files set) and the S8b runtime policy pin.
 *
 * KNOWN CONFLICTS (handoffs to L3/L4/L6, see lane-07 status): several
 * producer modules export the same name with different definitions, which
 * is a TS2308 error under `export *`. The explicit re-exports below are
 * interim picks only; the owners must reconcile to one canonical
 * definition (or a rename for accidental collisions) each.
 * - `OperationId` (state branded vs wire plain): state; narrows to string.
 * - `DeliveryStatus` (services vs wire, identical text): services; L4 owns
 *   the outcome vocabulary.
 *
 * Resolved: `DeliveryError` (L2 PR2 deduplicated; services owns it now).
 * Resolved: `FileTransferMeta` + `UploadIntentRequest` (L4 S8 re-exports
 * both from wire; same symbol, no ambiguity — pinned as identities in
 * `assembly.test.ts` instead of interim picks).
 */
export const CONTRACTS_VERSION = 1;

export * from "./artifact.js";
export * from "./deployment.js";
export * from "./diagnostic.js";
export * from "./examples.js";
export * from "./files.js";
export * from "./identity.js";
export * from "./presentation.js";
export * from "./services.js";
export * from "./state.js";
export * from "./values.js";
export * from "./wire.js";
export * from "./work.js";
export type { OperationId } from "./state.js";
export type { DeliveryStatus } from "./services.js";
