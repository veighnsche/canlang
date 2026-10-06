/**
 * C1 production MCP `derivedFor` mirror (colocated vitest): the
 * worker-side `SchemaCatalog` serves the E1 binding-visibility
 * channel from deploy-baked data (never re-derived), so production
 * MCP dispatch runs the same bound checker as HTTP.
 *
 * Parity is by construction: the baked map comes from the REAL
 * interfaces derivation (`catalogFromArtifactOperations`, dist
 * import — the same call the P-B deploy join makes), and these
 * tests prove the worker serves it verbatim (T19a shapes + T19b
 * delivery/file depth) while skew fails loud. The delivery fixture
 * below is the verbatim T15b-pinned T19b descriptor.
 */
import { describe, expect, it } from "vitest";
import type { CompileArtifact, DerivedOperationInputs } from "@canlang/contracts";
import { catalogFromArtifactOperations } from "../../interfaces/dist/interfaces/src/http/operations.js";
import {
  createArtifactCatalog,
  type BakedDerivedInputs,
} from "../src/runtime/mcp-registry.js";

const artifact = {
  artifact_version: 1,
  callables: [],
  operations: [
    {
      name: "acme.Todo.create",
      kind: "create",
      description: "Create a todo.",
      inputs: {
        fields: [
          { name: "title", field: { kind: "string" }, required: true },
          { name: "priority", field: { kind: "enum", values: ["low", "high"] }, required: false },
        ],
      },
    },
    {
      name: "Receipts.retry",
      kind: "scenario",
      description: "",
      inputs: {
        fields: [
          { name: "note", field: { kind: "string" }, required: true },
          {
            name: "attempt",
            field: {
              kind: "delivery",
              capability: "std.EmailV1",
              operation: "send",
              version: 1,
              result: { name: "EmailAccepted", fields: [{ name: "reference", type: "text" }] },
            },
            required: false,
            nullable: true,
          },
          { name: "attachment", field: { kind: "file" }, required: false },
        ],
      },
    },
  ],
} as unknown as CompileArtifact;

function bake(): BakedDerivedInputs {
  const catalog = catalogFromArtifactOperations(artifact);
  const baked: Record<string, DerivedOperationInputs> = {};
  for (const op of artifact.operations ?? []) {
    const derived = catalog.derivedFor(op.name);
    if (derived === null) throw new Error(`no derivation for ${op.name}`);
    baked[op.name] = derived;
  }
  return baked;
}

describe("artifact catalog derived channel (C1 mirror)", () => {
  it("is framing-only without baked data (E1 legacy shape, byte-identical)", () => {
    const catalog = createArtifactCatalog(artifact);
    expect("derivedFor" in catalog).toBe(false);
    expect(catalog.shapeFor("acme.Todo.create")).toEqual({
      allowed: ["title", "priority"],
      required: ["title"],
    });
    // Framing is exactly the submittable allowlist (T19b parity:
    // `deriveOperationShape` excludes delivery members on both
    // transports): the receipt binding never appears, baked or not.
    expect(catalog.shapeFor("Receipts.retry")).toEqual({
      allowed: ["note", "attachment"],
      required: ["note"],
    });
  });

  it("serves baked derivations verbatim (T19a + T19b depth parity)", () => {
    const catalog = createArtifactCatalog(artifact, bake());
    const real = catalogFromArtifactOperations(artifact);
    for (const name of ["acme.Todo.create", "Receipts.retry"]) {
      expect(catalog.derivedFor?.(name)).toEqual(real.derivedFor(name));
    }
    // T19b depth rides the mirror (not just the T19a surface).
    const retry = catalog.derivedFor?.("Receipts.retry");
    expect(retry?.inputs.some((input) => input.kind === "delivery")).toBe(true);
    expect(retry?.inputs.some((input) => input.kind === "file")).toBe(true);
    // Framing shapes are untouched by the channel (and exclude the
    // receipt binding, T19b parity — the binding rides `derivedFor`).
    expect(catalog.shapeFor("Receipts.retry")).toEqual({
      allowed: ["note", "attachment"],
      required: ["note"],
    });
    expect(catalog.shapeFor("acme.Nope")).toBeNull();
    expect(catalog.derivedFor?.("acme.Nope")).toBeNull();
  });

  it("serves an empty bake for operation-less artifacts", () => {
    const bare = { artifact_version: 1, callables: [] } as unknown as CompileArtifact;
    const catalog = createArtifactCatalog(bare, {});
    expect(catalog.shapeFor("acme.Todo.create")).toBeNull();
    expect(catalog.derivedFor?.("acme.Todo.create")).toBeNull();
  });

  it("fails loud on bake skew (never serves a mismatched channel)", () => {
    const good = bake();
    // Unknown operation in the bake.
    expect(() =>
      createArtifactCatalog(artifact, {
        ...good,
        "acme.Ghost": { ...good["acme.Todo.create"]!, operation: "acme.Ghost" },
      }),
    ).toThrow(/names no operation in the staged artifact/);
    // Missing derivation for a staged operation.
    expect(() => createArtifactCatalog(artifact, { "acme.Todo.create": good["acme.Todo.create"]! })).toThrow(
      /missing derivation for a staged operation/,
    );
    // Stale derivation version.
    const stale = structuredClone(good);
    stale["acme.Todo.create"]!.artifactVersion = 999;
    expect(() => createArtifactCatalog(artifact, stale)).toThrow(/stale derivation/);
    // Malformed entry shapes.
    expect(() => createArtifactCatalog(artifact, null as unknown as BakedDerivedInputs)).toThrow(
      /must be an object keyed by operation/,
    );
    expect(() =>
      createArtifactCatalog(artifact, { "acme.Todo.create": 42 } as unknown as BakedDerivedInputs),
    ).toThrow(/must be an object/);
    const badInputs = structuredClone(good);
    (badInputs["acme.Todo.create"] as unknown as Record<string, unknown>)["inputs"] = "title";
    expect(() => createArtifactCatalog(artifact, badInputs)).toThrow(/\.inputs.*must be an array/);
  });
});
