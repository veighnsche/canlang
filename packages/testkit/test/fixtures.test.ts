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
import {
  fixtureValuesOf,
  loadExampleSuite,
  stashedRowOf,
  type FixtureBindings,
} from "../src/runner/loader.js";
import type { ExampleHooks, StepCall } from "../src/runner/steps.js";
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
           examples: [{
             operation: "Expense.create",
             dependencies: [claim],
             inputs: async (c, s) => ({}),
             selectors: [],
             observations: [],
             rows: [{ dependencies: [author], values: async (c, s) => [], expected: async (c, s) => [] }],
           }],
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
      a: { dependencies: [], value: async () => ({ n: 1 }) },
      b: {
        dependencies: ["a"],
        value: async (_c: unknown, provisioned: ReadonlyMap<string, unknown>) => ({
          n: (provisioned.get("a") as { n: number }).n + 1,
        }),
      },
    });
    const values = await provisionFixtureValues(["a", "b"], suite, null);
    expect(values.get("b")).toEqual({ n: 2 });
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

function ids(): FixtureBindings {
  return { self: "s1", other: "o1", imported: {} };
}

const TABLE_MODULE = `const author = { dependencies: [], value: async (c, s) => ({ name: "seed" }) };
export function exampleFixtures(bindings) {
  return {
    fixtures: { author },
    examples: [{
      operation: "Todo.create",
      dependencies: ["author"],
      inputs: async (c, s) => ({ title: "t", author: s.author }),
      selectors: ["as", "author.name"],
      observations: [async (c, s) => s.get("author")],
      rows: [
        { dependencies: ["author"], values: async (c, s) => ["members", "a"], expected: async (c, s) => [{ name: "a" }] },
        { dependencies: [], values: async (c, s) => [c.self, "a"], error: "rule_failed" },
      ],
    }],
  };
}`;

describe("table row expansion", () => {
  it("expands rows with mapped callers and setup-assigned expectations", async () => {
    const suite = await loadExampleSuite(await writeModule("table.mjs", TABLE_MODULE), ids());
    expect(suite.rows.map((row) => row.rowIndex)).toEqual([0, 1]);
    expect(suite.rows.map((row) => row.caller)).toEqual([
      { kind: "membership", roles: ["members"] },
      { kind: "self" },
    ]);
    expect(suite.rows[0]?.seed).toEqual(["author"]);
    expect(suite.rows[1]?.seed).toEqual(["author"]);
    const first = suite.rows[0];
    const second = suite.rows[1];
    if (first === undefined || second === undefined) {
      throw new Error("expected two rows");
    }
    const scope = new MemoryScope();
    await first.setup(scope, memoryAccounts());
    expect(first.expected).toEqual({ values: [{ name: "a" }], observations: [] });
    // Input cells apply along selector paths; the provisioned fixture the
    // inputs were built from stays pristine (no aliasing).
    expect(stashedRowOf(scope)?.inputs).toEqual({ title: "t", author: { name: "a" } });
    expect(stashedRowOf(scope)?.cells).toEqual(["members", "a"]);
    expect(fixtureValuesOf(scope)?.get("author")).toEqual({ name: "seed" });
    // Baseline stash: pre-application roots for live fixture matching.
    expect(stashedRowOf(scope)?.baselineInputs).toEqual({ title: "t", author: { name: "seed" } });
    await second.setup(new MemoryScope(), memoryAccounts());
    expect(second.expected).toEqual({ error: "rule_failed" });
  });

  it("executes rows through hooks and judges observations", async () => {
    const calls: StepCall[] = [];
    const hooks: ExampleHooks = {
      invokeCall: async (call) => {
        calls.push(call);
        return call.by === "members" ? { ok: true } : { ok: false, error: "rule_failed" };
      },
      // Live rows reflect the applied inputs (genuine live-read posture);
      // the static provisioned seed ("seed") must NOT leak through.
      observeScope: async (_scope, stashed) =>
        new Map([["author", (stashed.inputs as { author: unknown }).author]]),
    };
    const suite = await loadExampleSuite(await writeModule("run.mjs", TABLE_MODULE), ids(), hooks);
    const report = await runTable<RowScope>({
      operation: "Todo.create",
      rows: suite.rows,
      userFixtures: suite.userFixtures,
      createScope: async () => new MemoryScope(),
    });
    expect(report.rows.map((row) => row.outcome)).toEqual(["passed", "passed"]);
    expect(report.rows[1]?.rejection).toEqual({ error: "rule_failed", sideEffectsAbsent: true });
    expect(calls.map((call) => [call.operation, call.by])).toEqual([
      ["Todo.create", "members"],
      ["Todo.create", "s1"],
    ]);
    expect(calls[0]?.inputs).toEqual({ title: "t", author: { name: "a" } });
  });

  it("fails deliberately broken expectations with mismatches", async () => {
    const broken = TABLE_MODULE.replace('[{ name: "a" }] }', '[{ name: "WRONG" }] }');
    const suite = await loadExampleSuite(await writeModule("broken-table.mjs", broken), ids(), {
      invokeCall: async () => ({ ok: true }),
    });
    const report = await runTable<RowScope>({
      operation: "Todo.create",
      rows: suite.rows.slice(0, 1),
      createScope: async () => new MemoryScope(),
    });
    expect(report.rows[0]?.outcome).toBe("failed");
    expect(report.rows[0]?.mismatches?.length).toBeGreaterThan(0);
  });

  it("maps live user-recipe as-cells to fixture callers and runs them", async () => {
    const url = await writeModule(
      "fixture-caller.mjs",
      `const reviewer = { dependencies: [], user: async (c, s) => ({ roles: ["reviewer"] }) };
       export function exampleFixtures(bindings) {
         return {
           fixtures: { reviewer },
           examples: [{
             operation: "Todo.create",
             dependencies: [],
             inputs: async (c, s) => ({}),
             selectors: ["as"],
             observations: [async (c, s) => s.get("reviewer").roles],
             rows: [{ dependencies: ["reviewer"], values: async (c, s) => [reviewer], expected: async (c, s) => [["reviewer"]] }],
           }],
         };
       }`,
    );
    const suite = await loadExampleSuite(url, ids(), { invokeCall: async () => ({ ok: true }) });
    expect(suite.rows[0]?.caller).toEqual({ kind: "fixture", fixture: "reviewer" });
    const report = await runTable<RowScope>({
      operation: "Todo.create",
      rows: suite.rows,
      userFixtures: suite.userFixtures,
      createScope: async () => new MemoryScope(),
    });
    expect(report.rows[0]?.outcome).toBe("passed");
  });

  it("refuses malformed tables loud", async () => {
    const cases: Array<readonly [string, string, RegExp]> = [
      ["both", `[{ dependencies: [], values: async () => [], expected: async () => [], error: "x" }]`, /both or neither/],
      ["neither", `[{ dependencies: [], values: async () => [] }]`, /both or neither/],
      ["values", `[{ dependencies: [], values: [], error: "x" }]`, /values that are not a function/],
      ["rows", `"nope"`, /rows that are not an array/],
    ];
    for (const [name, rows, pattern] of cases) {
      const url = await writeModule(
        `bad-${name}.mjs`,
        `export function exampleFixtures(bindings) {
           return { fixtures: {}, examples: [{ operation: "op", dependencies: [], inputs: async () => ({}), selectors: [], observations: [], rows: ${rows} }] };
         }`,
      );
      await expect(loadExampleSuite(url, ids())).rejects.toThrow(pattern);
    }
    const noOp = await writeModule(
      "bad-noop.mjs",
      `export function exampleFixtures(bindings) {
         return { fixtures: {}, examples: [{ dependencies: [], inputs: async () => ({}), selectors: [], observations: [], rows: [{ dependencies: [], values: async () => [], error: "x" }] }] };
       }`,
    );
    await expect(loadExampleSuite(noOp, ids())).rejects.toThrow(/no operation identity/);
    const badCaller = await writeModule(
      "bad-caller.mjs",
      `export function exampleFixtures(bindings) {
         return { fixtures: {}, examples: [{ operation: "op", dependencies: [], inputs: async () => ({}), selectors: ["as"], observations: [], rows: [{ dependencies: [], values: async () => [42], error: "x" }] }] };
       }`,
    );
    await expect(loadExampleSuite(badCaller, ids())).rejects.toThrow(/as-cell value is not a caller/);
    const foreignCaller = await writeModule(
      "bad-foreign.mjs",
      `export function exampleFixtures(bindings) {
         return { fixtures: {}, examples: [{ operation: "op", dependencies: [], inputs: async () => ({}), selectors: ["as"], observations: [], rows: [{ dependencies: [], values: async () => [{}], error: "x" }] }] };
       }`,
    );
    await expect(loadExampleSuite(foreignCaller, ids())).rejects.toThrow(/as-cell names no caller/);
  });
});

const SEQUENCE_MODULE = `const doc = { dependencies: [], value: async (c, s) => ({ title: "d" }) };
export function exampleFixtures(bindings) {
  const seq = (steps) => ({ operation: "Doc.flow", dependencies: ["doc"], sequence: steps });
  return {
    fixtures: { doc },
    examples: [
      seq([
        { operation: "Good.create", by: async (c, s, b) => "members", inputs: async (c, s, b) => ({ title: "d" }), bind: "created" },
        { let: "flag", value: async (c, s, b) => true },
        { observations: async (c, s, b) => [b.get("flag"), b.get("created").ok], expected: async (c, s, b) => [true, true] },
      ]),
      seq([{ operation: "Bad.delete", by: async (c, s, b) => "members", inputs: async (c, s, b) => ({}), error: "forbidden" }]),
      seq([{ operation: "Bad.delete", by: async (c, s, b) => "members", inputs: async (c, s, b) => ({}), error: "forbidden", bind: undefined }]),
    ],
  };
}`;

describe("sequence execution", () => {
  it("runs calls, bindings, and assertions with prior commits", async () => {
    const calls: StepCall[] = [];
    const suite = await loadExampleSuite(await writeModule("seq.mjs", SEQUENCE_MODULE), ids(), {
      invokeCall: async (call) => {
        calls.push(call);
        return call.operation === "Bad.delete" ? { ok: false, error: "forbidden" } : { ok: true };
      },
    });
    expect(suite.rows).toHaveLength(3);
    const report = await runTable<RowScope>({
      operation: "Doc.flow",
      rows: suite.rows,
      createScope: async () => new MemoryScope(),
    });
    // Call/bind/assert passes; both error-steps match.
    expect(report.rows.map((row) => row.outcome)).toEqual(["passed", "passed", "passed"]);
    expect(calls.map((call) => [call.operation, call.by])).toEqual([
      ["Good.create", "members"],
      ["Bad.delete", "members"],
      ["Bad.delete", "members"],
    ]);
    expect(calls[0]?.inputs).toEqual({ title: "d" });
  });

  it("fails assertion mismatches, wrong errors, and unexpected rejections", async () => {
    const url = await writeModule(
      "seq-fail.mjs",
      `export function exampleFixtures(bindings) {
         const seq = (steps) => ({ operation: "op", dependencies: [], sequence: steps });
         return {
           fixtures: {},
           examples: [
             seq([{ observations: async () => [1], expected: async () => [2] }]),
             seq([{ operation: "Bad.delete", by: async () => "m", inputs: async () => ({}), error: "forbidden" }]),
             seq([{ operation: "Bad.ok", by: async () => "m", inputs: async () => ({}), error: "forbidden" }]),
             seq([{ operation: "Bad.delete", by: async () => "m", inputs: async () => ({}) }]),
             seq([{ operation: "Missing.op", by: async () => "m", inputs: async () => ({}) }]),
           ],
         };
       }`,
    );
    const suite = await loadExampleSuite(url, ids(), {
      invokeCall: async (call) => {
        if (call.operation === "Missing.op") {
          return { ok: false, unsupported: true, detail: "no such capability" };
        }
        if (call.operation === "Bad.ok") {
          return { ok: true };
        }
        return { ok: false, error: "other" };
      },
    });
    const report = await runTable<RowScope>({
      operation: "op",
      rows: suite.rows,
      createScope: async () => new MemoryScope(),
    });
    expect(report.rows.map((row) => row.outcome)).toEqual([
      "failed",
      "failed",
      "failed",
      "failed",
      "unsupported",
    ]);
    expect(report.rows[0]?.detail).toMatch(/sequence assertion failed/);
    expect(report.rows[1]?.detail).toMatch(/expected error\(forbidden\) but got error\(other\)/);
    expect(report.rows[2]?.detail).toMatch(/expected error\(forbidden\) but the call succeeded/);
    expect(report.rows[3]?.detail).toMatch(/unexpected rejection error\(other\)/);
  });

  it("refuses malformed sequences loud", async () => {
    const badStep = await writeModule(
      "bad-step.mjs",
      `export function exampleFixtures(bindings) {
         return { fixtures: {}, examples: [{ operation: "op", dependencies: [], sequence: [{ nope: 1 }] }] };
       }`,
    );
    await expect(loadExampleSuite(badStep, ids())).rejects.toThrow(/neither a call, binding, nor assertion/);
    const both = await writeModule(
      "bad-both.mjs",
      `export function exampleFixtures(bindings) {
         return { fixtures: {}, examples: [{ operation: "op", dependencies: [], sequence: [], rows: [] }] };
       }`,
    );
    await expect(loadExampleSuite(both, ids())).rejects.toThrow(/both sequence and rows/);
    const notArray = await writeModule(
      "bad-seqshape.mjs",
      `export function exampleFixtures(bindings) {
         return { fixtures: {}, examples: [{ operation: "op", dependencies: [], sequence: {} }] };
       }`,
    );
    await expect(loadExampleSuite(notArray, ids())).rejects.toThrow(/sequence that is not an array/);
  });
});

describe("file/delivery recipe validation", () => {
  it("provisions well-formed file and delivery fixtures", async () => {
    const suite = readRecipeSuite({
      receipt: { dependencies: [], file: async () => ({ slot: "a", shape: "pdf" }) },
      notice: {
        dependencies: [],
        delivery: "std.EmailV1.send",
        values: async () => ({ request: { to: "a" }, status: "queued" }),
      },
    });
    const values = await provisionFixtureValues(["receipt", "notice"], suite, null);
    expect(values.get("receipt")).toEqual({ slot: "a", shape: "pdf" });
    expect(values.get("notice")).toEqual({ request: { to: "a" }, status: "queued" });
  });

  it("rejects malformed file, delivery, and model values", async () => {
    const scalar = readRecipeSuite({ f: { dependencies: [], file: async () => "nope" } });
    await expect(provisionFixtureValues(["f"], scalar, null)).rejects.toThrow(
      /"f": file fixture must provision a fields record/,
    );
    const noRequest = readRecipeSuite({
      d: { dependencies: [], delivery: "op", values: async () => ({ status: "x" }) },
    });
    await expect(provisionFixtureValues(["d"], noRequest, null)).rejects.toThrow(
      /"d": delivery fixture must provision \{request/,
    );
    expect(() => readRecipeSuite({ d: { dependencies: [], values: async () => ({}) } })).toThrow(
      /"d": delivery recipe must declare its operation identity/,
    );
    const scalarModel = readRecipeSuite({ m: { dependencies: [], value: async () => 7 } });
    await expect(provisionFixtureValues(["m"], scalarModel, null)).rejects.toThrow(
      /"m": model fixture must provision a fields record/,
    );
  });
});
