import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReportValue } from "@canlang/contracts";
import {
  FixtureSetupError,
  extractSuiteUsers,
  normalizeSuiteDependencies,
  provisionFixtureValues,
  readRecipeSuite,
  resolveFixtureOrder,
} from "../src/fixtures/recipes.js";
import { fixtureValuesOf, loadExampleSuite, type FixtureBindings } from "../src/runner/loader.js";
import { runTable, type RowScope, type TableRowSpec } from "../src/runner/table.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fixtures-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeModule(name: string, source: string): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, source);
  return pathToFileURL(file).href;
}

function bindings(): FixtureBindings {
  return { self: null, other: null, imported: null };
}

/** TEST-ONLY in-memory scope. Exercises setup/provisioning, not storage. */
class MemoryScope implements RowScope {
  async snapshot(): Promise<ReportValue> {
    return null;
  }

  async dispose(): Promise<void> {}
}

function memoryAccounts() {
  return { self: "s", other: "o", outsider: "x", users: {} };
}

describe("readRecipeSuite", () => {
  it("rejects malformed recipe maps with fixture identity", () => {
    expect(() => readRecipeSuite(null)).toThrowError(FixtureSetupError);
    expect(() => readRecipeSuite({})).not.toThrow();
    expect(() => readRecipeSuite({ a: null })).toThrow(/fixture setup "a": fixture recipe is not an object/);
    expect(() => readRecipeSuite({ a: { dependencies: "x", value: async () => ({}) } })).toThrow(
      /fixture setup "a": fixture dependencies is not an array/,
    );
    expect(() => readRecipeSuite({ a: { dependencies: [] } })).toThrow(/no provisioner/);
    expect(() =>
      readRecipeSuite({ a: { dependencies: [], value: async () => ({}), user: async () => ({}) } }),
    ).toThrow(/more than one provisioner/);
    expect(() => readRecipeSuite({ a: { dependencies: [], value: 42 } })).toThrow(
      /provisioner "value" is not a function/,
    );
  });

  it("accepts all four emitted recipe kinds", () => {
    const suite = readRecipeSuite({
      m: { model: "Todo", dependencies: [], value: async () => ({}) },
      u: { dependencies: [], user: async () => ({ roles: ["r"] }) },
      f: { dependencies: [], file: async () => ({}) },
      d: { dependencies: [], delivery: "Mail.send", values: async () => ({}) },
    });
    expect(suite.recipes.get("m")?.kind).toBe("model");
    expect(suite.recipes.get("u")?.kind).toBe("user");
    expect(suite.recipes.get("f")?.kind).toBe("file");
    expect(suite.recipes.get("d")?.kind).toBe("delivery");
    expect(suite.recipes.get("m")?.label).toBe("Todo");
  });
});

describe("resolveFixtureOrder", () => {
  it("orders diamonds dependencies-first and reports cycles with paths", () => {
    const suite = readRecipeSuite({
      a: { dependencies: [], value: async () => "a" },
      b: { dependencies: ["a"], value: async () => "b" },
      c: { dependencies: ["a"], value: async () => "c" },
      d: { dependencies: ["b", "c"], value: async () => "d" },
    });
    const adjacency = normalizeSuiteDependencies(suite);
    const order = resolveFixtureOrder(["d"], adjacency);
    expect(order[0]).toBe("a");
    expect(order[order.length - 1]).toBe("d");
    expect([...order].sort()).toEqual(["a", "b", "c", "d"]);
    expect(() => resolveFixtureOrder(["nope"], adjacency)).toThrow(
      /"nope": example depends on an unknown fixture/,
    );
  });

  it("fails genuine cycles, including self-references", () => {
    const pair = readRecipeSuite({
      a: { dependencies: ["b"], value: async () => ({}) },
      b: { dependencies: ["a"], value: async () => ({}) },
    });
    expect(() => resolveFixtureOrder(["a"], normalizeSuiteDependencies(pair))).toThrow(
      /fixture dependency cycle: "a" -> "b" -> "a"/,
    );
    const loop = readRecipeSuite({ a: { dependencies: ["a"], value: async () => ({}) } });
    expect(() => resolveFixtureOrder(["a"], normalizeSuiteDependencies(loop))).toThrow(
      /fixture dependency cycle: "a" -> "a"/,
    );
  });

  it("rejects unknown and malformed dependencies", () => {
    const unknown = readRecipeSuite({ a: { dependencies: ["ghost"], value: async () => ({}) } });
    expect(() => normalizeSuiteDependencies(unknown)).toThrow(
      /"a": unknown fixture dependency "ghost"/,
    );
    const foreign = readRecipeSuite({ a: { dependencies: [{}], value: async () => ({}) } });
    expect(() => normalizeSuiteDependencies(foreign)).toThrow(/matches no recipe in this suite/);
    const numeric = readRecipeSuite({ a: { dependencies: [1], value: async () => ({}) } });
    expect(() => normalizeSuiteDependencies(numeric)).toThrow(
      /neither a fixture name nor a recipe reference/,
    );
  });
});

describe("extractSuiteUsers", () => {
  it("extracts roles and rejects malformed user values", async () => {
    const suite = readRecipeSuite({
      reviewer: { dependencies: [], user: async () => ({ roles: ["reviewer"] }) },
      plain: { dependencies: [], user: async () => ({ roles: [] }) },
    });
    const { users, values } = await extractSuiteUsers(suite, null);
    expect(users).toEqual([
      { name: "reviewer", roles: ["reviewer"] },
      { name: "plain", roles: [] },
    ]);
    expect(values.get("reviewer")).toEqual({ roles: ["reviewer"] });
    const bad = readRecipeSuite({ u: { dependencies: [], user: async () => ({ roles: "x" }) } });
    await expect(extractSuiteUsers(bad, null)).rejects.toThrow(
      /"u": user fixture must provision \{roles: string\[\]\}/,
    );
    const throwing = readRecipeSuite({
      u: {
        dependencies: [],
        user: async () => {
          throw new Error("boom");
        },
      },
    });
    await expect(extractSuiteUsers(throwing, null)).rejects.toThrow(
      /"u": user fixture provisioning failed: boom/,
    );
  });
});

describe("loadExampleSuite", () => {
  it("loads the real emitted shape: live refs, row deps, user grants", async () => {
    const url = await writeModule(
      "suite.mjs",
      `const reviewer = { dependencies: [], user: async (c, s) => ({ roles: ["reviewer"] }) };
       const author = { dependencies: [], value: async (c, s) => ({ name: "a" }) };
       const claim = { model: "Expense", dependencies: [author], value: async (c, s) => ({ by: "a" }) };
       export function exampleFixtures(bindings) {
         return {
           fixtures: { reviewer, author, claim },
           examples: [
             { operation: "Expense.create", dependencies: [claim], rows: [{ dependencies: [author] }] },
           ],
         };
       }`,
    );
    const suite = await loadExampleSuite(url, bindings());
    expect(suite.userFixtures).toEqual([{ name: "reviewer", roles: ["reviewer"] }]);
    expect(suite.rows).toHaveLength(1);
    const row = suite.rows[0];
    if (row === undefined) {
      throw new Error("expected one row");
    }
    expect([...row.seed].sort()).toEqual(["author", "claim"]);
    const scope = new MemoryScope();
    await row.setup(scope, memoryAccounts());
    const values = fixtureValuesOf(scope);
    expect(values?.get("author")).toEqual({ name: "a" });
    expect(values?.get("claim")).toEqual({ by: "a" });
    // Out-of-closure users provision accounts (see userFixtures above), not
    // row values: the map holds exactly the row's dependency closure.
    expect(values?.has("reviewer")).toBe(false);
  });

  it("evaluates user fixtures once across load and row setup", async () => {
    const url = await writeModule(
      "count.mjs",
      `let calls = 0;
       const u = { dependencies: [], user: async (c, s) => { calls += 1; return { roles: [] }; } };
       export function exampleFixtures(bindings) {
         globalThis.__userCalls = () => calls;
         return { fixtures: { u }, examples: [{ operation: "op", dependencies: ["u"] }] };
       }`,
    );
    const suite = await loadExampleSuite(url, bindings());
    const row = suite.rows[0];
    if (row === undefined) {
      throw new Error("expected one row");
    }
    const scope = new MemoryScope();
    await row.setup(scope, memoryAccounts());
    const calls = (globalThis as Record<string, unknown>).__userCalls as () => number;
    expect(calls()).toBe(1);
    expect(fixtureValuesOf(scope)?.get("u")).toEqual({ roles: [] });
    delete (globalThis as Record<string, unknown>).__userCalls;
  });

  it("fails the suite load on unknown example dependencies and cycles", async () => {
    const unknown = await writeModule(
      "unknown.mjs",
      `export function exampleFixtures(bindings) {
         return { fixtures: {}, examples: [{ operation: "op", dependencies: ["ghost"] }] };
       }`,
    );
    await expect(loadExampleSuite(unknown, bindings())).rejects.toThrow(
      /example at index 0: unknown fixture dependency "ghost"/,
    );
    const cyclic = await writeModule(
      "cyclic.mjs",
      `export function exampleFixtures(bindings) {
         return {
           fixtures: {
             a: { dependencies: ["b"], value: async () => ({}) },
             b: { dependencies: ["a"], value: async () => ({}) },
           },
           examples: [{ operation: "op", dependencies: [] }],
         };
       }`,
    );
    await expect(loadExampleSuite(cyclic, bindings())).rejects.toThrow(/fixture dependency cycle/);
  });
});

describe("provisionFixtureValues", () => {
  it("threads values through and wraps shell throws with fixture identity", async () => {
    const suite = readRecipeSuite({
      a: { dependencies: [], value: async () => 1 },
      b: {
        dependencies: ["a"],
        value: async (_c: unknown, provisioned: ReadonlyMap<string, unknown>) =>
          (provisioned.get("a") as number) + 1,
      },
    });
    const values = await provisionFixtureValues(["a", "b"], suite, null);
    expect(values.get("b")).toBe(2);
    const shell = readRecipeSuite({
      x: {
        model: "Todo",
        dependencies: [],
        value: async () => {
          throw new Error("unchecked fixture recipe: x");
        },
      },
    });
    await expect(provisionFixtureValues(["x"], shell, null)).rejects.toThrow(
      /"x": fixture provisioning failed: unchecked fixture recipe: x/,
    );
  });
});

describe("setup failure versus business rejection (T22a acceptance)", () => {
  async function brokenRow(): Promise<TableRowSpec<RowScope>> {
    const url = await writeModule(
      "broken.mjs",
      `export function exampleFixtures(bindings) {
         return {
           fixtures: {
             author: {
               dependencies: [],
               value: async () => { throw new Error("seed store offline"); },
             },
           },
           examples: [{ operation: "Todo.create", dependencies: ["author"] }],
         };
       }`,
    );
    const suite = await loadExampleSuite(url, bindings());
    const row = suite.rows[0];
    if (row === undefined) {
      throw new Error("expected one row");
    }
    return row;
  }

  it("reports setup-failed (never passed) when setup breaks on an error-expecting row", async () => {
    const row = await brokenRow();
    const scope = new MemoryScope();
    const report = await runTable<RowScope>({
      operation: "Todo.create",
      createScope: async () => scope,
      rows: [{ ...row, expected: { error: "rule_failed" } }],
    });
    const first = report.rows[0];
    if (first === undefined) {
      throw new Error("expected one row result");
    }
    expect(first.outcome).toBe("setup-failed");
    expect(first.rejection).toBeUndefined();
    expect(first.detail).toMatch(/"author": fixture provisioning failed: seed store offline/);
    expect(fixtureValuesOf(scope)).toBeUndefined();
  });

  it("still honors an exact business rejection when setup succeeds (control)", async () => {
    const row = await brokenRow();
    const working: TableRowSpec<RowScope> = {
      ...row,
      setup: async () => {},
      invoke: async () => ({ ok: false, error: "rule_failed" }),
      expected: { error: "rule_failed" },
    };
    const report = await runTable<RowScope>({
      operation: "Todo.create",
      createScope: async () => new MemoryScope(),
      rows: [working],
    });
    const first = report.rows[0];
    if (first === undefined) {
      throw new Error("expected one row result");
    }
    expect(first.outcome).toBe("passed");
    expect(first.rejection).toEqual({ error: "rule_failed", sideEffectsAbsent: true });
  });
});
