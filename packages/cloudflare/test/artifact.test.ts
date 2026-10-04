import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadArtifactFile } from "../src/runtime/artifact.js";

const TEST_MODULE = {
  path: "out/tests.js",
  js: "export {};",
  map: {
    version: 3,
    file: "tests.js",
    sources: ["app.can"],
    sourcesContent: [null],
    names: [],
    mappings: "",
  },
};

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
      { id: "app.Thing.create", kind: "operation", module: "out/app.js", export: "create", member: ["createThing"] },
    ],
    pages: [{ owner: "app", path: "/", module: "out/app.js", export: "IndexPage" }],
    requires: [{ capability: "values.decimal", min_version: 2 }],
    tests: [{ scope: "app.Thing", module: TEST_MODULE, fixtures: ["app.Thing/basic"] }],
  };
}

function writeArtifact(contents: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "artifact-")), "artifact.json");
  writeFileSync(file, contents);
  return file;
}

function mutate(mutator: (artifact: Record<string, unknown>) => void): string {
  const artifact = validArtifact();
  mutator(artifact);
  return writeArtifact(JSON.stringify(artifact));
}

describe("loadArtifactFile", () => {
  it("loads a valid minimal artifact", () => {
    const file = writeArtifact(JSON.stringify(validArtifact()));
    const loaded = loadArtifactFile(file);
    expect(loaded.sourcePath).toBe(file);
    expect(loaded.artifact.artifact_version).toBe(1);
    expect(loaded.artifact.modules[0]?.path).toBe("out/app.js");
    expect(loaded.artifact.callables).toHaveLength(1);
  });

  it("accepts min_version 0 (real 0.x producer requirement)", () => {
    const file = mutate(
      (a) => void (a.requires = [{ capability: "canlang.builtins", min_version: 0 }]),
    );
    const loaded = loadArtifactFile(file);
    expect(loaded.artifact.requires).toHaveLength(1);
  });

  it.each([
    ["artifact_version", mutate((a) => void (a.artifact_version = 2)), /artifact_version/],
    ["language_version", mutate((a) => void delete a.language_version), /language_version/],
    ["tool_version", mutate((a) => void (a.tool_version = "")), /tool_version/],
    ["sources empty", mutate((a) => void (a.sources = [])), /sources must be a non-empty array/],
    [
      "sources[0].sha256",
      mutate((a) => void (a.sources = [{ path: "src/app.can", sha256: "ZZZ" }])),
      /sources\[0\]\.sha256/,
    ],
    ["modules empty", mutate((a) => void (a.modules = [])), /modules must be a non-empty array/],
    [
      "modules[0].map.version",
      mutate((a) => {
        const module = (a.modules as Record<string, unknown>[])[0];
        const map = module?.["map"] as Record<string, unknown>;
        if (map) map.version = 2;
      }),
      /modules\[0\]\.map\.version must be 3/,
    ],
    [
      "callables kind",
      mutate(
        (a) => void (a.callables = [{ id: "app.Thing.create", kind: "spell", module: "m", export: "e" }]),
      ),
      /callables\[0\]\.kind/,
    ],
    [
      "callables id",
      mutate((a) => void (a.callables = [{ kind: "operation", module: "out/app.js", export: "e" }])),
      /callables\[0\]\.id must be a non-empty string/,
    ],
    [
      "callables module cross-ref",
      mutate(
        (a) =>
          void (a.callables = [{ id: "app.Thing.create", kind: "operation", module: "out/gone.js", export: "e" }]),
      ),
      /callables\[0\]\.module "out\/gone\.js" names no modules\[\] entry/,
    ],
    [
      "pages module cross-ref",
      mutate(
        (a) => void (a.pages = [{ owner: "app", path: "/", module: "out/gone.js", export: "e" }]),
      ),
      /pages\[0\]\.module "out\/gone\.js" names no modules\[\] entry/,
    ],
    [
      "callables member missing",
      mutate((a) => {
        const callables = a.callables as Record<string, unknown>[];
        if (callables[0]) delete callables[0]["member"];
      }),
      /callables\[0\]\.member for callable "app\.Thing\.create" must be a non-empty array/,
    ],
    [
      "callables member empty",
      mutate((a) => {
        const callables = a.callables as Record<string, unknown>[];
        if (callables[0]) callables[0]["member"] = [];
      }),
      /callables\[0\]\.member for callable "app\.Thing\.create" must be a non-empty array/,
    ],
    [
      "callables member bad segment",
      mutate((a) => {
        const callables = a.callables as Record<string, unknown>[];
        if (callables[0]) callables[0]["member"] = ["ok", ""];
      }),
      /callables\[0\]\.member for callable "app\.Thing\.create" must be a non-empty array/,
    ],
    [
      "pages owner",
      mutate((a) => void (a.pages = [{ path: "/", module: "m", export: "e" }])),
      /pages\[0\]\.owner/,
    ],
    [
      "requires min_version",
      mutate((a) => void (a.requires = [{ capability: "values.decimal", min_version: -1 }])),
      /requires\[0\]\.min_version/,
    ],
    [
      "tests scope",
      mutate((a) => void (a.tests = [{ module: TEST_MODULE, fixtures: [] }])),
      /tests\[0\]\.scope/,
    ],
    ["invalid JSON", writeArtifact("{nope"), /invalid JSON/],
  ])("throws a precise error for %s", (_name, file, pattern) => {
    expect(() => loadArtifactFile(file as string)).toThrowError(pattern as RegExp);
  });
});
