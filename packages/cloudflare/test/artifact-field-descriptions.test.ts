/**
 * MCP P4 artifact-compat: `inputs.fields[].description` is additive.
 *
 * Old artifacts WITHOUT the key must still load. Artifacts WITH the key
 * carry it through verbatim; a present-but-not-a-string key is rejected
 * loudly, naming the dotted field path.
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
    callables: [],
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
              description: "The gadget to approve.",
            },
            { name: "note", field: { kind: "string" }, required: false },
          ],
        },
      },
    ],
    pages: [],
    requires: [],
    tests: [],
  };
}

function writeArtifact(contents: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "artifact-desc-")), "artifact.json");
  writeFileSync(file, contents);
  return file;
}

function mutate(mutator: (artifact: Record<string, unknown>) => void): string {
  const artifact = validArtifact();
  mutator(artifact);
  return writeArtifact(JSON.stringify(artifact));
}

function firstField(artifact: Record<string, unknown>): Record<string, unknown> {
  const operation = (artifact.operations as Record<string, unknown>[])[0] as Record<string, unknown>;
  const inputs = operation.inputs as Record<string, unknown>;
  return (inputs.fields as Record<string, unknown>[])[0] as Record<string, unknown>;
}

describe("loadArtifactFile inputs.fields[].description", () => {
  it("loads old artifacts without field descriptions (additive)", () => {
    const file = mutate((a) => void delete firstField(a).description);
    const loaded = loadArtifactFile(file);
    const field = loaded.artifact.operations?.[0]?.inputs.fields[0];
    expect(field).toMatchObject({ name: "gadget", required: true });
    expect(field).toBeDefined();
    expect("description" in (field as unknown as Record<string, unknown>)).toBe(false);
  });

  it("loads and preserves authored field descriptions verbatim", () => {
    const file = writeArtifact(JSON.stringify(validArtifact()));
    const loaded = loadArtifactFile(file);
    expect(loaded.artifact.operations?.[0]?.inputs.fields[0]).toMatchObject({
      name: "gadget",
      description: "The gadget to approve.",
    });
    expect(loaded.artifact.operations?.[0]?.inputs.fields[1]).toMatchObject({
      name: "note",
    });
  });

  it("rejects non-string field descriptions loudly", () => {
    const file = mutate((a) => void (firstField(a).description = 42));
    expect(() => loadArtifactFile(file)).toThrow(
      /operations\[0\]\.inputs\.fields\[0\]\.description must be a string/,
    );
  });
});
