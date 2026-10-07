import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SourceMap } from "@canlang/contracts";
import { decodeMappings, lookup } from "../src/runtime/sourcemap.js";

type Observation = { value?: unknown; error?: { name: string; message: string } };
type Case = {
  id: string;
  category: string;
  map: SourceMap;
  decode: Observation;
  lookups: Array<Observation & { line: number; column: number }>;
};
const fixture = JSON.parse(readFileSync(new URL("./fixtures/raw-source-map-contract.json", import.meta.url), "utf8")) as {
  oracle: { sha256: string };
  cases: Case[];
};

function observe(action: () => unknown): Observation {
  try {
    return { value: action() };
  } catch (error) {
    const failure = error as Error;
    return { error: { name: failure.name, message: failure.message } };
  }
}

// Expectations were frozen from the exact original mapper before importing candidates.
// This corpus deliberately preserves accepted odd numeric/order behavior as well as errors.
describe("raw source-map frozen compatibility contract", () => {
  for (const entry of fixture.cases) {
    it(`${entry.category}: ${entry.id}`, () => {
      expect(observe(() => decodeMappings(entry.map.mappings))).toEqual(entry.decode);
      for (const { line, column, ...expected } of entry.lookups) {
        expect(observe(() => lookup(entry.map, line, column))).toEqual(expected);
      }
    });
  }

  it("keeps signed-zero accumulators positive zero", () => {
    const segment = decodeMappings("BBBBB")[0]?.[0];
    for (const field of [segment?.genCol, segment?.src, segment?.srcLine, segment?.srcCol, segment?.name]) {
      expect(Object.is(field, 0)).toBe(true);
      expect(Object.is(field, -0)).toBe(false);
    }
  });

  it("rejects invalid query coordinates before reading or decoding map data", () => {
    const unreadable = {
      get mappings(): string {
        throw new Error("must not read mappings");
      },
    } as SourceMap;
    const invalid = [NaN, Infinity, -Infinity, -1, 0.5];
    for (const line of [...invalid, 0]) expect(lookup(unreadable, line, 0)).toBeNull();
    for (const column of invalid) expect(lookup(unreadable, 1, column)).toBeNull();
    expect(lookup(null as unknown as SourceMap, 0, 0)).toBeNull();
  });

  it("preserves native type failures for valid queries and their invalid-query bypass", () => {
    for (const mappings of [undefined, null, 3, {}, [], true]) {
      const map = { mappings } as unknown as SourceMap;
      expect(() => lookup(map, 1, 0)).toThrow(TypeError);
      expect(lookup(map, 0, 0)).toBeNull();
      expect(lookup(map, 1, -1)).toBeNull();
    }
    expect(() => lookup(null as unknown as SourceMap, 1, 0)).toThrow(TypeError);
  });

  it("decodes the whole map before line bounds or source/name validation", () => {
    const map = { mappings: "AAAA;!", sources: null, names: null } as unknown as SourceMap;
    for (const line of [1, 99]) {
      expect(observe(() => lookup(map, line, 0))).toEqual({
        error: { name: "Error", message: 'sourcemap: bad VLQ character "!"' },
      });
    }
  });

  it("reads every mutation immediately, including failed-to-valid and valid-to-failed maps", () => {
    const map: SourceMap = { version: 3, file: "a.js", sources: ["before.can"], sourcesContent: [], names: [], mappings: "!" };
    expect(() => lookup(map, 1, 0)).toThrow('sourcemap: bad VLQ character "!"');
    const mutable = map as { mappings: string; sources: string[]; names: unknown[] };
    mutable.mappings = "AAAAA";
    expect(lookup(map, 1, 0)).toEqual({ source: "before.can", line: 1, column: 1 });
    mutable.sources[0] = "../raw/./after.can?x#y";
    mutable.names[0] = "";
    expect(lookup(map, 1, 0)).toEqual({ source: "../raw/./after.can?x#y", line: 1, column: 1, name: "" });
    mutable.sources = ["replacement.can"];
    mutable.names = [17];
    mutable.mappings = "AACA";
    const position = lookup(map, 1, 0);
    expect(position).toEqual({ source: "replacement.can", line: 2, column: 1 });
    expect(Object.hasOwn(position ?? {}, "name")).toBe(false);
    mutable.mappings = "AAAAA";
    mutable.names = ["replacement"];
    expect(lookup(map, 1, 0)?.name).toBe("replacement");
    mutable.mappings = "g";
    expect(() => lookup(map, 1, 0)).toThrow("sourcemap: truncated VLQ value");
  });

  it("returns fresh mutable decoded objects without caching returned changes", () => {
    const decoded = decodeMappings("AAAA");
    const mutable = decoded as Array<Array<{ genCol: number; src: number; srcLine: number; srcCol: number }>>;
    mutable[0]![0]!.srcLine = 999;
    mutable[0]!.push({ genCol: 1, src: 0, srcLine: 999, srcCol: 0 });
    expect(decodeMappings("AAAA")).toEqual([[{ genCol: 0, src: 0, srcLine: 0, srcCol: 0 }]]);
  });

  it("retains ordinary array-property access for negative source and name indexes", () => {
    const sources = ["unused"] as string[] & { "-1": string };
    const names = ["unused"] as string[] & { "-1": string };
    sources["-1"] = "raw-negative.can";
    names["-1"] = "negative-name";
    const map = { version: 3, file: "a.js", sources, names, sourcesContent: [], mappings: "ADAAD" } as SourceMap;
    expect(lookup(map, 1, 0)).toEqual({ source: "raw-negative.can", line: 1, column: 1, name: "negative-name" });
  });
});
