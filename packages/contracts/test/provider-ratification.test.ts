import { describe, expect, it } from "vitest";
import {
  EXECUTION_CONTRACT_VERSION,
  T04A_PINNED_VERSIONS,
  type ArtifactDeliveryDescriptor,
  type CanonicalFieldDef,
  type CanonicalInputDef,
  type DeliveryRecipeKey,
  type ModelName,
} from "../src/index.js";

/**
 * T04b-p provider-ratification agreement: the T15b-emitted
 * `ArtifactDeliveryDescriptor` shape transcribes losslessly into the
 * ratified L3 intake (`CanonicalInputDef` delivery member /
 * `CanonicalFieldDef.delivery`). Fixture models the T15b
 * `std.EmailV1.send -> EmailAccepted{reference:text}` emission
 * (DESIGN §8 std.EmailV1 row).
 */
const emitted: ArtifactDeliveryDescriptor = {
  kind: "delivery",
  capability: "std.EmailV1",
  operation: "send",
  version: 1,
  result: { name: "EmailAccepted", fields: [{ name: "reference", type: "text" }] },
};

describe("provider ratification", () => {
  it("keeps the execution contract at v1 with T04a pins unchanged", () => {
    expect(EXECUTION_CONTRACT_VERSION).toBe(1);
    expect(T04A_PINNED_VERSIONS).toEqual({
      execution: 1,
      artifact: 1,
      state: 1,
      values: 1,
      identity: 1,
      wire: 1,
      examples: 1,
    });
  });

  it("transcribes an emitted descriptor into a delivery input losslessly", () => {
    const input: CanonicalInputDef = {
      name: "notice",
      kind: "delivery",
      delivery: { ...emitted, result: { ...emitted.result } },
      required: true,
    };
    expect(input.kind).toBe("delivery");
    if (input.kind !== "delivery") {
      expect.unreachable("delivery member must narrow");
    }
    expect(JSON.parse(JSON.stringify(input.delivery))).toEqual(emitted);
  });

  it("shares the identical descriptor shape with model field tags", () => {
    const field: CanonicalFieldDef = {
      required: false,
      serverOnly: false,
      delivery: { ...emitted, result: { ...emitted.result } },
    };
    expect(JSON.parse(JSON.stringify(field.delivery))).toEqual(emitted);
  });

  it("carries verbatim T13c leaf spellings char-for-char", () => {
    const leaves = [
      { name: "reference", type: "text" },
      { name: "note", type: "text?" },
      { name: "status", type: "enum(pending,unknown,succeeded,failed)" },
      { name: "failure", type: "enum(transient,action_required,permanent,cancelled)?" },
      { name: "amount", type: "money" },
      { name: "files", type: "file[]" },
    ] as const;
    const input: CanonicalInputDef = {
      name: "payment",
      kind: "delivery",
      delivery: {
        kind: "delivery",
        capability: "std.PaymentsV1",
        operation: "collect",
        version: 1,
        result: { name: "PaymentState", fields: [...leaves] },
      },
      required: false,
    };
    const revived = JSON.parse(JSON.stringify(input)) as CanonicalInputDef;
    expect(revived.kind).toBe("delivery");
    if (revived.kind !== "delivery") {
      expect.unreachable("delivery member must survive JSON round-trip");
    }
    expect(revived.delivery.result.fields).toEqual([...leaves]);
  });

  it("keys recipes as delivery:<qualified-send-target>", () => {
    const key = "delivery:std.EmailV1.send" as DeliveryRecipeKey;
    const [head, target] = (key as string).split(/:(.+)/);
    expect(head).toBe("delivery");
    expect(target).toBe("std.EmailV1.send");
    const [provider, capability, op] = (target as string).split(".");
    expect(provider).toBe("std");
    expect(capability).toBe("EmailV1");
    expect(op).toBe("send");
  });

  it("stays additive-only: T04a-era shapes carry no delivery member", () => {
    const input: CanonicalInputDef = {
      name: "todo",
      kind: "ref",
      model: "TeamTasks.Todo" as ModelName,
      versioned: true,
      required: true,
    };
    const field: CanonicalFieldDef = { required: true, serverOnly: false };
    expect("delivery" in input).toBe(false);
    expect("delivery" in field).toBe(false);
    expect(field.delivery).toBeUndefined();
  });
});
