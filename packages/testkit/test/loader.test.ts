import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReportValue, ResolvedCaller } from "@canlang/contracts";
import { loadExampleFixtures, type FixtureBindings } from "../src/runner/loader.js";
import type { RowScope } from "../src/runner/table.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "loader-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  delete (globalThis as Record<string, unknown>).__loaderTestBindings;
});

async function writeModule(name: string, source: string): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, source);
  return pathToFileURL(file).href;
}

const fakeScope: RowScope = {
  snapshot: async (): Promise<ReportValue> => null,
  dispose: async () => {},
};

const fakeCaller: ResolvedCaller = { account: "a", team: null, roles: [], authenticated: false };

describe("loadExampleFixtures", () => {
  it("maps two emitted examples to rows and forwards bindings", async () => {
    const url = await writeModule(
      "suite.mjs",
      `export function exampleFixtures(bindings) {
        globalThis.__loaderTestBindings = bindings;
        return {
          fixtures: { author: { dependencies: [], value: async () => ({}) } },
          examples: [
            { operation: "Todo.create", dependencies: ["author"] },
            { operation: "Todo.create", dependencies: [] },
          ],
        };
      }`,
    );
    const bindings: FixtureBindings = { self: { id: "s" }, other: { id: "o" }, imported: {} };
    const rows = await loadExampleFixtures(url, bindings);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.rowIndex)).toEqual([0, 1]);
    expect(rows.map((row) => row.caller)).toEqual([{ kind: "self" }, { kind: "self" }]);
    expect(rows.map((row) => row.seed)).toEqual([["author"], []]);
    for (const row of rows) {
      expect(row.expected).toEqual({ values: [], observations: [] });
      await expect(row.setup(fakeScope, rowAccounts())).resolves.toBeUndefined();
      await expect(row.observe(fakeScope)).resolves.toEqual([]);
      await expect(row.invoke(fakeScope, fakeCaller)).resolves.toEqual({
        ok: false,
        unsupported: true,
        detail: expect.any(String),
      });
    }
    expect((globalThis as Record<string, unknown>).__loaderTestBindings).toEqual(bindings);
  });

  it("throws a precise error when the module has no exampleFixtures export", async () => {
    const url = await writeModule("no-export.mjs", `export const x = 1;`);
    await expect(loadExampleFixtures(url, bindings())).rejects.toThrow(
      /does not export exampleFixtures/,
    );
  });

  it("throws a precise error when exampleFixtures is not a function", async () => {
    const url = await writeModule("not-fn.mjs", `export const exampleFixtures = 42;`);
    await expect(loadExampleFixtures(url, bindings())).rejects.toThrow(/not a function/);
  });

  it("throws precise errors on bad factory shapes", async () => {
    const cases: Array<[string, string, RegExp]> = [
      ["missing-keys", `export function exampleFixtures() { return {}; }`, /fixtures an object/],
      [
        "null-fixtures",
        `export function exampleFixtures() { return { fixtures: null, examples: [] }; }`,
        /fixtures an object/,
      ],
      [
        "non-array-examples",
        `export function exampleFixtures() { return { fixtures: {}, examples: {} }; }`,
        /examples an array/,
      ],
      [
        "non-object-example",
        `export function exampleFixtures() { return { fixtures: {}, examples: [null] }; }`,
        /example at index 0 is not an object/,
      ],
      [
        "bad-dependencies",
        `export function exampleFixtures() {
          return { fixtures: {}, examples: [{ dependencies: "author" }] };
        }`,
        /dependencies that are not an array/,
      ],
    ];
    for (const [name, source, pattern] of cases) {
      const url = await writeModule(`${name}.mjs`, source);
      await expect(loadExampleFixtures(url, bindings())).rejects.toThrow(pattern);
    }
  });

  it("throws a precise error when the module cannot be imported", async () => {
    const url = pathToFileURL(join(dir, "missing.mjs")).href;
    await expect(loadExampleFixtures(url, bindings())).rejects.toThrow(/cannot import/);
  });
});

function bindings(): FixtureBindings {
  return { self: null, other: null, imported: null };
}

function rowAccounts() {
  return { self: "s", other: "o", outsider: "x", users: {} };
}
