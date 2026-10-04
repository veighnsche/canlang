import { describe, expect, it } from "vitest";
import type * as barrel from "../src/index.js";
import type * as files from "../src/files.js";
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
const fileTransferMetaIsWire: Equal<barrel.FileTransferMeta, wire.FileTransferMeta> = true;
const uploadIntentRequestIsFiles: Equal<barrel.UploadIntentRequest, files.UploadIntentRequest> = true;

describe("assembly conflict picks", () => {
  it("pins interim picks until owners reconcile", () => {
    expect([
      operationIdIsState,
      deliveryStatusIsServices,
      fileTransferMetaIsWire,
      uploadIntentRequestIsFiles,
    ]).toEqual([true, true, true, true]);
  });
});
