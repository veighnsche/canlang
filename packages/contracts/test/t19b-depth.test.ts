import { describe, expect, it } from "vitest";
import {
  IDENTITY_CONTRACT_VERSION,
  STD_EMAIL_V1_CONTRACT,
  STD_ERRORS_V1_CONTRACT,
  STD_IMAGES_V1_CONTRACT,
  STD_MAILBOX_V1_CONTRACT,
  STD_PAYMENTS_V1_CONTRACT,
  STD_TEXT_GENERATION_V1_CONTRACT,
  WIRE_CONTRACT_VERSION,
  deliveryResultLeaves,
  DELIVERY_RESULT_LEAVES,
  type CapabilityContract,
  type DerivedDeliveryBinding,
  type DerivedFileClaim,
  type DerivedInputKind,
  type DerivedOperationInputs,
} from "../src/index.js";

// T19b depth contract pins. The derivation builders live in
// @canlang/interfaces; this file pins the wire vocabulary they must
// satisfy: the delivery kind + binding, the file claim, the declared
// result-leaf table, and the frozen T13 join surface (targets,
// versions, declared results) the derivation fences against.

function keysOf(value: object): string[] {
  return Object.keys(value).sort();
}

describe("T19b contract versions stay pinned (additive slice)", () => {
  it("wire and identity versions are unchanged", () => {
    expect(WIRE_CONTRACT_VERSION).toBe(1);
    expect(IDENTITY_CONTRACT_VERSION).toBe(1);
  });
});

describe("T19b delivery kind and binding", () => {
  it("admits delivery as the tenth input kind", () => {
    const kinds: DerivedInputKind[] = [
      "ref",
      "string",
      "integer",
      "decimal",
      "money",
      "datetime",
      "boolean",
      "file",
      "enum",
      "delivery",
    ];
    expect(kinds).toHaveLength(10);
  });

  it("pins the binding members and recipe format", () => {
    const binding: DerivedDeliveryBinding = {
      capability: "std.EmailV1",
      operation: "send",
      version: 1,
      result: { name: "EmailAccepted", leaves: [{ name: "reference", type: "text" }] },
      recipe: "delivery:std.EmailV1.send",
    };
    expect(keysOf(binding)).toEqual(["capability", "operation", "recipe", "result", "version"]);
    expect(binding.recipe).toBe(`delivery:${binding.capability}.${binding.operation}`);
    expect(keysOf(binding.result)).toEqual(["leaves", "name"]);
    expect(keysOf(binding.result.leaves[0] as object)).toEqual(["name", "type"]);
  });

  it("carries delivery entries as declared bindings, never submitted members", () => {
    const derived: DerivedOperationInputs = {
      operation: "Receipts.retry",
      kind: "scenario",
      artifactVersion: 1,
      inputs: [
        { name: "note", kind: "string", required: true },
        {
          name: "attempt",
          kind: "delivery",
          required: false,
          nullable: true,
          delivery: {
            capability: "std.EmailV1",
            operation: "send",
            version: 1,
            result: { name: "EmailAccepted", leaves: [{ name: "reference", type: "text" }] },
            recipe: "delivery:std.EmailV1.send",
          },
        },
      ],
    };
    const submittable = derived.inputs.filter((input) => input.kind !== "delivery");
    expect(submittable.map((input) => input.name)).toEqual(["note"]);
    expect(derived.inputs.map((input) => input.name)).toEqual(["note", "attempt"]);
  });
});

describe("T19b file claim", () => {
  it("pins the opaque-id value shape and can-file format", () => {
    const claim: DerivedFileClaim = { valueShape: "opaque-file-id", format: "can-file" };
    expect(keysOf(claim)).toEqual(["format", "valueShape"]);
  });
});

describe("T19b declared result leaves", () => {
  // Verbatim T13c leaf sets (catalog.rs T13A/B_NOMINAL_LEAVES,
  // mechanically cross-checked char-for-char; see T19b report).
  const EXPECTED: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
    EmailAccepted: [["reference", "text"]],
    ErrorAccepted: [["reference", "text"]],
    PaymentState: [
      ["reference", "text"],
      ["revision", "int"],
      ["provider_reference", "text?"],
      ["amount", "money"],
      ["status", "enum(pending,unknown,succeeded,failed)"],
      ["checkout_url", "url?"],
      ["failure", "enum(transient,action_required,permanent,cancelled)?"],
    ],
    TextRun: [
      ["source", "text"],
      ["revision", "int"],
      ["sequence", "int"],
      ["state", "enum(queued,running,succeeded,failed,unknown,cancelled)"],
      ["content", "text"],
      ["used_tokens", "int?"],
      ["detail", "text?"],
    ],
    WorkflowInspection: [["fields", "WorkflowField[]"]],
    WorkflowValidation: [
      ["valid", "bool"],
      ["digest", "text?"],
      ["detail", "text?"],
    ],
    ImageRun: [
      ["source", "text"],
      ["revision", "int"],
      ["sequence", "int"],
      ["state", "enum(queued,running,succeeded,failed,unknown,cancelled)"],
      ["outputs", "GeneratedImage[]"],
      ["charged_jobs", "int?"],
      ["detail", "text?"],
    ],
    MailReplyOutcome: [
      ["source", "text"],
      ["state", "enum(accepted,not_sent,unknown)"],
      ["reference", "text?"],
      ["detail", "text?"],
    ],
  };

  it("covers exactly the eight result nominals", () => {
    expect(Object.keys(DELIVERY_RESULT_LEAVES).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it("pins every declared leaf verbatim in producer order", () => {
    for (const [nominal, leaves] of Object.entries(EXPECTED)) {
      const tabled = DELIVERY_RESULT_LEAVES[nominal] ?? [];
      expect(
        tabled.map((leaf) => [leaf.name, leaf.type]),
        nominal,
      ).toEqual(leaves.map(([name, type]) => [name, type]));
    }
  });

  it("freezes the table and every leaf", () => {
    expect(Object.isFrozen(DELIVERY_RESULT_LEAVES)).toBe(true);
    for (const leaves of Object.values(DELIVERY_RESULT_LEAVES)) {
      expect(Object.isFrozen(leaves)).toBe(true);
      for (const leaf of leaves) expect(Object.isFrozen(leaf)).toBe(true);
    }
  });

  it("looks up known nominals and nulls unknown ones", () => {
    expect(deliveryResultLeaves("EmailAccepted")).toEqual([{ name: "reference", type: "text" }]);
    expect(deliveryResultLeaves("PaymentState")).toHaveLength(7);
    expect(deliveryResultLeaves("Nope")).toBeNull();
    expect(deliveryResultLeaves("constructor")).toBeNull();
  });

  it("byte-pins the T15b EmailAccepted descriptor", () => {
    const binding: DerivedDeliveryBinding = {
      capability: "std.EmailV1",
      operation: "send",
      version: 1,
      result: {
        name: "EmailAccepted",
        leaves: [...(deliveryResultLeaves("EmailAccepted") ?? [])],
      },
      recipe: "delivery:std.EmailV1.send",
    };
    expect({
      kind: "delivery",
      capability: binding.capability,
      operation: binding.operation,
      version: binding.version,
      result: {
        name: binding.result.name,
        fields: binding.result.leaves.map((leaf) => ({ name: leaf.name, type: leaf.type })),
      },
    }).toEqual({
      kind: "delivery",
      capability: "std.EmailV1",
      operation: "send",
      version: 1,
      result: { name: "EmailAccepted", fields: [{ name: "reference", type: "text" }] },
    });
  });
});

describe("T19b frozen T13 join surface", () => {
  // The send-target identity + frozen versions + declared results the
  // derivation joins live from the capability contracts. Any L4 change
  // here must fail this pin loud (the derivation fences on it).
  const CONTRACTS: readonly CapabilityContract[] = [
    STD_EMAIL_V1_CONTRACT,
    STD_ERRORS_V1_CONTRACT,
    STD_PAYMENTS_V1_CONTRACT,
    STD_TEXT_GENERATION_V1_CONTRACT,
    STD_IMAGES_V1_CONTRACT,
    STD_MAILBOX_V1_CONTRACT,
  ];

  it("freezes six capabilities at version 1", () => {
    expect(CONTRACTS.map((contract) => [contract.name, contract.version])).toEqual([
      ["std.EmailV1", 1],
      ["std.ErrorsV1", 1],
      ["std.PaymentsV1", 1],
      ["std.TextGenerationV1", 1],
      ["std.ImagesV1", 1],
      ["std.MailboxV1", 1],
    ]);
  });

  it("declares sixteen send targets with their result nominals", () => {
    const targets = new Map<string, string>();
    for (const contract of CONTRACTS) {
      for (const op of contract.operations) targets.set(`${contract.name}.${op.name}`, op.result);
    }
    expect([...targets.entries()].sort()).toEqual(
      [
        ["std.EmailV1.send", "EmailAccepted"],
        ["std.ErrorsV1.report", "ErrorAccepted"],
        ["std.ImagesV1.cancel", "ImageRun"],
        ["std.ImagesV1.inspect", "WorkflowInspection"],
        ["std.ImagesV1.reconcile", "ImageRun"],
        ["std.ImagesV1.submit", "ImageRun"],
        ["std.ImagesV1.validate", "WorkflowValidation"],
        ["std.MailboxV1.reconcile", "MailReplyOutcome"],
        ["std.MailboxV1.reply", "MailReplyOutcome"],
        ["std.PaymentsV1.cancel", "PaymentState"],
        ["std.PaymentsV1.collect", "PaymentState"],
        ["std.PaymentsV1.reconcile", "PaymentState"],
        ["std.PaymentsV1.refund", "PaymentState"],
        ["std.TextGenerationV1.cancel", "TextRun"],
        ["std.TextGenerationV1.generate", "TextRun"],
        ["std.TextGenerationV1.reconcile", "TextRun"],
      ].sort(),
    );
  });

  it("declares leaves for every result nominal", () => {
    const nominals = new Set<string>();
    for (const contract of CONTRACTS) {
      for (const op of contract.operations) nominals.add(op.result);
    }
    expect([...nominals].sort()).toEqual([
      "EmailAccepted",
      "ErrorAccepted",
      "ImageRun",
      "MailReplyOutcome",
      "PaymentState",
      "TextRun",
      "WorkflowInspection",
      "WorkflowValidation",
    ]);
    for (const nominal of nominals) {
      expect(deliveryResultLeaves(nominal) === null, nominal).toBe(false);
      expect((deliveryResultLeaves(nominal) ?? []).length).toBeGreaterThan(0);
    }
  });
});
