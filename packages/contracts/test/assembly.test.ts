import { describe, expect, it } from "vitest";
import type * as barrel from "../src/index.js";
import type * as files from "../src/files.js";
import type * as presentation from "../src/presentation.js";
import type * as services from "../src/services.js";
import type * as state from "../src/state.js";
import type * as wire from "../src/wire.js";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

// Interim conflict picks (see index.ts header + lane-07 status handoffs).
// Each line fails to compile if its barrel pick drifts; DELETE the line
// (not the pins) when the owning lanes reconcile the definition.
const operationIdIsState: Equal<barrel.OperationId, state.OperationId> = true;
const deliveryStatusIsServices: Equal<barrel.DeliveryStatus, services.DeliveryStatus> = true;

// Reconciled identities (L4 S8): files.ts re-exports both names from wire,
// so the barrel needs no explicit line — but if either side ever diverges
// again, the name silently drops from the barrel. Each pair fails loudly.
const fileTransferMetaIsWire: Equal<barrel.FileTransferMeta, wire.FileTransferMeta> = true;
const fileTransferMetaIsFiles: Equal<barrel.FileTransferMeta, files.FileTransferMeta> = true;
const uploadIntentRequestIsWire: Equal<barrel.UploadIntentRequest, wire.UploadIntentRequest> = true;
const uploadIntentRequestIsFiles: Equal<barrel.UploadIntentRequest, files.UploadIntentRequest> = true;

// Re-export identities (L5 S4): presentation re-exports these wire types.
// Same-symbol re-exports are NOT ambiguous under `export *` (identical
// resolutions collapse), so the barrel needs no explicit line — but if L5
// ever replaces a re-export with a divergent local definition, the name
// silently drops from the barrel. Each pair fails loudly on that day.
const businessErrorIsWire: Equal<barrel.BusinessError, wire.BusinessError> = true;
const businessErrorIsPresentation: Equal<barrel.BusinessError, presentation.BusinessError> = true;
const fieldErrorIsWire: Equal<barrel.FieldError, wire.FieldError> = true;
const fieldErrorIsPresentation: Equal<barrel.FieldError, presentation.FieldError> = true;
const mutationRefIsWire: Equal<barrel.MutationRef, wire.MutationRef> = true;
const mutationRefIsPresentation: Equal<barrel.MutationRef, presentation.MutationRef> = true;
const sealedHandleIsWire: Equal<barrel.SealedActionHandle, wire.SealedActionHandle> = true;
const sealedHandleIsPresentation: Equal<barrel.SealedActionHandle, presentation.SealedActionHandle> =
  true;

// Re-export identity (L5 C8): presentation re-exports HistoryEntry from state
// (same symbol, collapses under `export *` — pinned so a future divergent
// local definition fails loudly instead of silently dropping the name).
const historyEntryIsState: Equal<barrel.HistoryEntry, state.HistoryEntry> = true;
const historyEntryIsPresentation: Equal<barrel.HistoryEntry, presentation.HistoryEntry> = true;

describe("assembly conflict picks", () => {
  it("pins interim picks until owners reconcile", () => {
    expect([
      operationIdIsState,
      deliveryStatusIsServices,
      fileTransferMetaIsWire,
      fileTransferMetaIsFiles,
      uploadIntentRequestIsWire,
      uploadIntentRequestIsFiles,
      businessErrorIsWire,
      businessErrorIsPresentation,
      fieldErrorIsWire,
      fieldErrorIsPresentation,
      mutationRefIsWire,
      mutationRefIsPresentation,
      sealedHandleIsWire,
      sealedHandleIsPresentation,
      historyEntryIsState,
      historyEntryIsPresentation,
    ]).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });


});
