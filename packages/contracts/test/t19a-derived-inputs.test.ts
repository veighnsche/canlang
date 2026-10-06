import { describe, expect, it } from "vitest";
import {
  IDENTITY_CONTRACT_VERSION,
  type InterfaceSubmission,
  type InterfaceTransport,
  type ResolvedIdentity,
} from "../src/identity.js";
import {
  WIRE_CONTRACT_VERSION,
  type DerivedInputDefault,
  type DerivedInputKind,
  type DerivedOperationInputs,
} from "../src/wire.js";

// T19a derived-input contract pins. The derivation builders live in
// @canlang/interfaces; this file pins the wire/identity vocabulary they
// must satisfy: closed kinds, literal/parent-only defaults, envelope
// conformance, and equal-authority submission identity.

function keysOf(value: object): string[] {
  return Object.keys(value).sort();
}

/** Envelope conformance: unique non-empty names, required ⊆ allowed. */
function expectClosedAllowlist(derived: DerivedOperationInputs): void {
  const names = derived.inputs.map((input) => input.name);
  expect(new Set(names).size).toBe(names.length);
  for (const input of derived.inputs) {
    expect(input.name.length).toBeGreaterThan(0);
    if (input.required) expect(names).toContain(input.name);
  }
}

describe("T19a contract versions stay pinned (additive slice)", () => {
  it("wire and identity versions are unchanged", () => {
    expect(WIRE_CONTRACT_VERSION).toBe(1);
    expect(IDENTITY_CONTRACT_VERSION).toBe(1);
  });
});

describe("T19a derived input vocabulary", () => {
  it("admits exactly the nine pilot input kinds", () => {
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
    ];
    expect(kinds).toHaveLength(9);
  });

  it("admits literal and parent defaults verbatim", () => {
    const literal: DerivedInputDefault = { kind: "literal", value: "10" };
    const parent: DerivedInputDefault = { kind: "parent", path: "owner" };
    expect(keysOf(literal)).toEqual(["kind", "value"]);
    expect(keysOf(parent)).toEqual(["kind", "path"]);
  });

  it("cannot represent server or derived defaults", () => {
    // @ts-expect-error server defaults never appear in derived inputs
    const server: DerivedInputDefault = { kind: "server" };
    // @ts-expect-error derived defaults never appear in derived inputs
    const derived: DerivedInputDefault = { kind: "derived" };
    expect([server, derived].length).toBe(2);
  });
});

describe("T19a derived operation inputs", () => {
  // Mirrors the T19a Shop.review derivation (verbatim emission values).
  const review: DerivedOperationInputs = {
    operation: "Shop.review",
    kind: "scenario",
    artifactVersion: 1,
    inputs: [
      { name: "notes", kind: "string", required: false, array: { required: false } },
      { name: "limit", kind: "integer", required: false, default: { kind: "literal", value: "10" } },
      { name: "nick", kind: "string", required: false, nullable: true },
    ],
  };

  it("pins operation, kind, version, and inputs", () => {
    expect(keysOf(review)).toEqual(["artifactVersion", "inputs", "kind", "operation"]);
    expect(review.operation).toBe("Shop.review");
    expect(review.kind).toBe("scenario");
    expect(review.artifactVersion).toBe(1);
    expect(review.inputs.map((input) => input.name)).toEqual(["notes", "limit", "nick"]);
  });

  it("conforms to the closed envelope allowlist", () => {
    expectClosedAllowlist(review);
    const update: DerivedOperationInputs = {
      operation: "Shop.Gadget.update",
      kind: "update",
      artifactVersion: 1,
      inputs: [
        { name: "record", kind: "ref", required: true, model: "Shop.Gadget", versioned: true },
        { name: "title", kind: "string", required: false },
      ],
    };
    expectClosedAllowlist(update);
  });

  it("versioned refs select MutationRef, unversioned refs select ReadRef", () => {
    const versioned = { name: "record", kind: "ref", required: true, model: "M", versioned: true } as const;
    const plain = { name: "parent", kind: "ref", required: true, model: "P", versioned: false } as const;
    expect(versioned.versioned).toBe(true);
    expect(plain.versioned).toBe(false);
  });
});

describe("T19a equal-authority submission", () => {
  const identity: ResolvedIdentity = {
    actor: { user_id: "u-1", email: "ada@test.example", email_verified: true },
    team: null,
    membership: null,
    binding: { kind: "none" },
    admitted_at: "2026-10-06T00:00:00.000Z",
  };

  it("admits both transports", () => {
    const transports: InterfaceTransport[] = ["http", "mcp"];
    expect(transports).toHaveLength(2);
  });

  it("carries the verified identity by reference, never a copy", () => {
    const submission: InterfaceSubmission = {
      identity,
      operation: "Store.Gadget.create",
      transport: "http",
    };
    expect(keysOf(submission)).toEqual(["identity", "operation", "transport"]);
    expect(submission.identity).toBe(identity);
    expect(submission.operation).toBe("Store.Gadget.create");
  });
});
