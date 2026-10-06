/**
 * MCP P1 artifact-compat: `operations[]` descriptors are additive.
 *
 * Old artifacts WITHOUT `operations` must still load (additive change).
 * Artifacts WITH `operations` validate strictly: every entry is
 * `{name, kind, description, inputs}` with closed typed fields, mirroring
 * `packages/contracts/src/artifact.ts` (`ArtifactOperation`) and the
 * `OperationDescriptor` JSON shape in `@canlang/interfaces` ports.ts.
 * Unknown kinds are rejected loudly, never treated as supported.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadArtifactFile } from "../src/runtime/artifact.js";

function validArtifact(): Record<string, unknown> {
  return {
    artifact_version: 1,
    language_version: "1.0.0",
    tool_version: "0.1.0",
    sources: [{ path: "src/app.can", sha256: "a".repeat(64) }],
    modules: [
      {
        path: "out/app.js",
        js: "export {};",
        map: {
          version: 3,
          file: "app.js",
          sources: ["app.can"],
          sourcesContent: [null],
          names: [],
          mappings: "",
        },
      },
    ],
    callables: [
      { id: "app.approve", kind: "operation", module: "out/app.js", export: "approve", member: ["approve"] },
    ],
    operations: [
      {
        name: "app.approve",
        kind: "scenario",
        description: "Approve a widget.",
        inputs: {
          fields: [
            {
              name: "gadget",
              field: { kind: "ref", model: "app.Gadget", requireVersion: true },
              required: true,
            },
            { name: "note", field: { kind: "string" }, required: false },
            { name: "mode", field: { kind: "enum", values: ["fast", "slow"] }, required: true },
          ],
        },
      },
      {
        name: "app.Gadget.create",
        kind: "create",
        description: "",
        inputs: { fields: [{ name: "title", field: { kind: "string" }, required: true }] },
      },
    ],
    pages: [],
    requires: [],
    tests: [],
  };
}

function writeArtifact(contents: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "artifact-ops-")), "artifact.json");
  writeFileSync(file, contents);
  return file;
}

function mutate(mutator: (artifact: Record<string, unknown>) => void): string {
  const artifact = validArtifact();
  mutator(artifact);
  return writeArtifact(JSON.stringify(artifact));
}

function firstOperation(artifact: Record<string, unknown>): Record<string, unknown> {
  return (artifact.operations as Record<string, unknown>[])[0] as Record<string, unknown>;
}

function firstField(artifact: Record<string, unknown>): Record<string, unknown> {
  const inputs = firstOperation(artifact).inputs as Record<string, unknown>;
  return (inputs.fields as Record<string, unknown>[])[0] as Record<string, unknown>;
}

/** Verbatim T15b-pinned delivery descriptor (`t19b-depth.test.ts` RETRY attempt). */
function deliveryDescriptor(): Record<string, unknown> {
  return {
    kind: "delivery",
    capability: "std.EmailV1",
    operation: "send",
    version: 1,
    result: { name: "EmailAccepted", fields: [{ name: "reference", type: "text" }] },
  };
}

function withDelivery(tamper: (descriptor: Record<string, unknown>) => void): string {
  return mutate((a) => {
    const inputs = firstOperation(a).inputs as Record<string, unknown>;
    const fields = inputs.fields as Record<string, unknown>[];
    const descriptor = deliveryDescriptor();
    tamper(descriptor);
    fields.push({ name: "attempt", field: descriptor, required: false });
  });
}

describe("loadArtifactFile operations[]", () => {
  it("loads old artifacts without operations (additive)", () => {
    const file = mutate((a) => void delete a.operations);
    const loaded = loadArtifactFile(file);
    expect(loaded.artifact.operations).toBeUndefined();
  });

  it("loads and preserves valid operations[]", () => {
    const file = writeArtifact(JSON.stringify(validArtifact()));
    const loaded = loadArtifactFile(file);
    expect(loaded.artifact.operations).toHaveLength(2);
    expect(loaded.artifact.operations?.[0]).toMatchObject({
      name: "app.approve",
      kind: "scenario",
      description: "Approve a widget.",
    });
    expect(loaded.artifact.operations?.[0]?.inputs.fields).toHaveLength(3);
  });

  it("loads T15b delivery fields (carried through for framing + derived channel)", () => {
    const file = withDelivery(() => {});
    const loaded = loadArtifactFile(file);
    expect(loaded.artifact.operations?.[0]?.inputs.fields).toHaveLength(4);
    expect(loaded.artifact.operations?.[0]?.inputs.fields[3]).toMatchObject({
      name: "attempt",
      field: { kind: "delivery", capability: "std.EmailV1" },
    });
  });

  it.each([
    ["not an array", mutate((a) => void (a.operations = {})), /operations must be an array/],
    [
      "entry not an object",
      mutate((a) => void (a.operations = ["app.approve"])),
      /operations\[0\] must be an object/,
    ],
    [
      "missing name",
      mutate((a) => void delete firstOperation(a).name),
      /operations\[0\]\.name must be a non-empty string/,
    ],
    [
      "unknown kind",
      mutate((a) => void (firstOperation(a).kind = "spell")),
      /operations\[0\]\.kind must be one of/,
    ],
    [
      "missing kind",
      mutate((a) => void delete firstOperation(a).kind),
      /operations\[0\]\.kind must be one of/,
    ],
    [
      "non-string description",
      mutate((a) => void (firstOperation(a).description = 42)),
      /operations\[0\]\.description must be a string/,
    ],
    [
      "inputs not an object",
      mutate((a) => void (firstOperation(a).inputs = [])),
      /operations\[0\]\.inputs must be an object/,
    ],
    [
      "fields not an array",
      mutate((a) => {
        (firstOperation(a).inputs as Record<string, unknown>).fields = {};
      }),
      /operations\[0\]\.inputs\.fields must be an array/,
    ],
    [
      "field missing name",
      mutate((a) => void delete firstField(a).name),
      /operations\[0\]\.inputs\.fields\[0\]\.name must be a non-empty string/,
    ],
    [
      "field required not boolean",
      mutate((a) => void (firstField(a).required = "yes")),
      /operations\[0\]\.inputs\.fields\[0\]\.required must be a boolean/,
    ],
    [
      "field schema missing",
      mutate((a) => void delete firstField(a).field),
      /operations\[0\]\.inputs\.fields\[0\]\.field must be an object/,
    ],
    [
      "unknown field kind",
      mutate((a) => {
        (firstField(a).field as Record<string, unknown>).kind = "object";
      }),
      /operations\[0\]\.inputs\.fields\[0\]\.field\.kind must be one of/,
    ],
    [
      "ref missing model",
      mutate((a) => {
        const field = firstField(a).field as Record<string, unknown>;
        delete field.model;
      }),
      /operations\[0\]\.inputs\.fields\[0\]\.field\.model must be a non-empty string/,
    ],
    [
      "ref requireVersion not boolean",
      mutate((a) => {
        (firstField(a).field as Record<string, unknown>).requireVersion = 1;
      }),
      /operations\[0\]\.inputs\.fields\[0\]\.field\.requireVersion must be a boolean/,
    ],
    [
      "enum values not string array",
      mutate((a) => {
        const inputs = firstOperation(a).inputs as Record<string, unknown>;
        const fields = inputs.fields as Record<string, unknown>[];
        ((fields[2] as Record<string, unknown>).field as Record<string, unknown>).values = ["fast", 7];
      }),
      /operations\[0\]\.inputs\.fields\[2\]\.field\.values must be a non-empty array of strings/,
    ],
    [
      "enum values empty",
      mutate((a) => {
        const inputs = firstOperation(a).inputs as Record<string, unknown>;
        const fields = inputs.fields as Record<string, unknown>[];
        ((fields[2] as Record<string, unknown>).field as Record<string, unknown>).values = [];
      }),
      /operations\[0\]\.inputs\.fields\[2\]\.field\.values must be a non-empty array of strings/,
    ],
    [
      "duplicate operation name",
      mutate((a) => {
        const operations = a.operations as Record<string, unknown>[];
        operations.push({ ...operations[1], name: operations[0]?.name });
      }),
      /operations repeats operation "app\.approve"/,
    ],
    [
      "duplicate input name",
      mutate((a) => {
        const inputs = firstOperation(a).inputs as Record<string, unknown>;
        const fields = inputs.fields as Record<string, unknown>[];
        fields.push({ ...(fields[1] as Record<string, unknown>) });
      }),
      /operations\[0\] repeats input "note"/,
    ],
    [
      "delivery missing capability",
      withDelivery((d) => void delete d.capability),
      /operations\[0\]\.inputs\.fields\[3\]\.field\.capability must be a non-empty string/,
    ],
    [
      "delivery version not a number",
      withDelivery((d) => void (d.version = "1")),
      /operations\[0\]\.inputs\.fields\[3\]\.field\.version must be a number/,
    ],
    [
      "delivery result leaves malformed",
      withDelivery((d) => {
        (d.result as Record<string, unknown>).fields = [{ name: "reference" }];
      }),
      /operations\[0\]\.inputs\.fields\[3\]\.field\.result\.fields must be an array of \{name, type\} leaves/,
    ],
  ])("rejects %s", (_label, file, pattern) => {
    expect(() => loadArtifactFile(file)).toThrow(pattern);
  });
});
