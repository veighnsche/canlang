import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SourceMap } from "@canlang/contracts";
import { encode } from "@jridgewell/sourcemap-codec";
import { composeModuleMap } from "../src/deploy/module-maps.js";
import { rewriteModuleImports, type ImportTransformMap } from "../src/deploy/module-imports.js";
import { lookup } from "../src/runtime/sourcemap.js";

type Sequence = { id: string; js: string; token: string; replacements: string[]; map: SourceMap; expected: unknown };
type Odd = { id: string; map: SourceMap; queries: Array<{ column: number; expected: unknown }> };
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/map-composition-contract.json", import.meta.url), "utf8")) as {
  sequences: Sequence[];
  odds: Odd[];
  malformed: Array<{ mappings: string; error: string }>;
};
const js = "import x from './something.js'; throw Error('boom');";

describe("derived module map composition", () => {
  for (const entry of fixtures.sequences) {
    it(`maps same-line ${entry.id} edits newest-to-oldest without mutating raw identity`, () => {
      const before = JSON.stringify(entry.map);
      let edited = entry.js;
      const stages: ImportTransformMap[] = [];
      for (const replacement of entry.replacements) {
        const result = rewriteModuleImports(edited, "main.js", () => replacement);
        expect(result.changed).toBe(true);
        stages.unshift(result.map!);
        edited = result.js;
      }
      const view = composeModuleMap(entry.map, stages, entry.js);
      expect(view.status).toBe("composed");
      expect(lookup(view.map!, 1, edited.indexOf(entry.token))).toEqual(entry.expected);
      expect(JSON.stringify(entry.map)).toBe(before);
      expect(view.map!.sources).toBe(entry.map.sources);
      expect(view.map!.names).toBe(entry.map.names);
      expect(view.map!.sourcesContent).toBe(entry.map.sourcesContent);
      expect(view.map!.file).toBe(entry.map.file);
      expect((view.map as unknown as { sourceRoot: string }).sourceRoot).toBe((entry.map as unknown as { sourceRoot: string }).sourceRoot);
    });
  }

  const identityStage: ImportTransformMap = {
    version: 3, file: "edited", sources: ["previous"], names: [],
    mappings: encode([Array.from({ length: 64 }, (_, column): [number, number, number, number] => [column, 0, 0, column])]),
  };
  for (const entry of fixtures.odds) {
    it(`keeps original raw lookup semantics for ${entry.id}`, () => {
      const view = composeModuleMap(entry.map, [identityStage], js);
      expect(view.status).toBe("composed");
      for (const query of entry.queries) expect(lookup(view.map!, 1, query.column)).toEqual(query.expected);
    });
  }

  it("passes through no edits without reading even malformed mappings", () => {
    const map = { get mappings(): string { throw new Error("must not read"); } } as SourceMap;
    const view = composeModuleMap(map, [], js);
    expect(view.map).toBe(map);
    expect(view.status).toBe("unchanged");
    const unchanged = rewriteModuleImports(js, "main.js", (specifier) => specifier);
    expect(unchanged.js).toBe(js);
    expect(unchanged.map).toBeUndefined();
  });

  it("keeps absent maps absent when edits occur", () => {
    expect(composeModuleMap(undefined, [identityStage], js)).toEqual({ map: undefined, status: "absent" });
  });

  for (const entry of fixtures.malformed) {
    it(`retains explicit invalid diagnostic view for ${JSON.stringify(entry.mappings)}`, () => {
      const map = { ...fixtures.sequences[0]!.map, mappings: entry.mappings };
      expect(composeModuleMap(map, [], js).map).toBe(map);
      const view = composeModuleMap(map, [identityStage], js);
      expect(view).toEqual({ map, status: "invalid", error: entry.error });
      expect(view.map).toBe(map);
      expect(() => lookup(view.map!, 1, 0)).toThrow(entry.error);
    });
  }

  it("never discloses absent content or adds absent file/root metadata", () => {
    const map = { version: 3, sources: [""], names: [""], mappings: "AAAAA" };
    const view = composeModuleMap(map, [identityStage], js);
    expect(Object.keys(view.map!).sort()).toEqual(Object.keys(map).sort());
    expect(view.map!.sources).toBe(map.sources);
    expect(view.map!.names).toBe(map.names);
    expect(lookup(view.map as SourceMap, 1, 0)).toEqual({ source: "", line: 1, column: 1, name: "" });
  });

  it("retains raw non-BMP and lone-surrogate source/name identities", () => {
    const map = { version: 3, sources: ["raw/😀/\ud800.can"], names: ["\udc00"], mappings: "AAAAA" };
    const view = composeModuleMap(map, [identityStage], js);
    expect(lookup(view.map as SourceMap, 1, 0)).toEqual({ source: "raw/😀/\ud800.can", line: 1, column: 1, name: "\udc00" });
  });

  it("keeps wrong-type raw source tables unmapped and invalid names omitted", () => {
    const base = fixtures.sequences[0]!.map;
    const invalidSources = { ...base, sources: { 0: "not-an-array.can" }, mappings: "AAAA" } as unknown as SourceMap;
    const invalidNames = { ...base, names: { 0: "not-an-array" }, mappings: "AAAAA" } as unknown as SourceMap;
    expect(lookup(composeModuleMap(invalidSources, [identityStage], js).map!, 1, 0)).toBeNull();
    expect(lookup(composeModuleMap(invalidNames, [identityStage], js).map!, 1, 0)).toEqual({ source: base.sources[0], line: 1, column: 1 });
  });

  it("keeps empty and missing original lines unmapped after mapped lines", () => {
    const originalJs = "import x from './something.js';\nthrow Error('boom');";
    const stage = rewriteModuleImports(originalJs, "main.js", () => "./longer/path.js");
    for (const mappings of ["AAAA;", "AAAA"]) {
      const map = { ...fixtures.sequences[0]!.map, mappings };
      const view = composeModuleMap(map, [stage.map!], originalJs);
      expect(lookup(view.map!, 2, 0)).toBeNull();
      expect(lookup(view.map!, 2, stage.js.split("\n")[1]!.indexOf("Error"))).toBeNull();
    }
  });
});
