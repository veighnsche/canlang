/**
 * Genuine-suite scope convention: the L1 BDD emitter lowers fixture
 * references to PROPERTY reads on the scope argument (`s.open_task`,
 * `member_of("s", ...)` in codegen/ir.rs) — never `Map.get`. Every closure
 * boundary (recipe provision, table inputs/values/expected, observations
 * over live state, sequence `(c,s,b)` steps) must honor that convention or
 * genuine suites read `undefined` where doubles (which ignore `s`) pass.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReportValue } from "@canlang/contracts";
import { loadExampleSuite, type FixtureBindings } from "../src/runner/loader.js";
import type { ExampleHooks } from "../src/runner/steps.js";
import { runTable, type CallOutcome, type RowScope } from "../src/runner/table.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "emitted-scope-test-"));
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

class MemoryScope implements RowScope {
  async snapshot(): Promise<ReportValue> {
    return null;
  }

  async dispose(): Promise<void> {}
}

const TABLE_MODULE = `const test_worker = { model: "employee.Employee", dependencies: [], value: async (c, s) => ({ role: "operator" }) };
const open_task = { model: "todo.Task", dependencies: [], value: async (c, s) => ({ title: "Opening checks", done: false }) };
export function exampleFixtures({ self, other, imported }) {
  void self; void other; void imported;
  return {
    fixtures: { test_worker, open_task },
    examples: [{
      operation: "todo.complete",
      dependencies: [test_worker, open_task],
      inputs: async (c, s) => ({ task: s.open_task }),
      selectors: ["task.done"],
      observations: [async (c, s) => s.open_task.done],
      rows: [
        { dependencies: [], values: async (c, s) => [s.open_task.done], expected: async (c, s) => [true] },
        { dependencies: [], values: async (c, s) => [true], error: "rule_failed" },
      ],
    }],
  };
}
`;

const SEQUENCE_MODULE = `const base = { model: "todo.Task", dependencies: [], value: async (c, s) => ({ n: 1 }) };
export function exampleFixtures({ self, other, imported }) {
  void self; void other; void imported;
  return {
    fixtures: { base },
    examples: [{
      operation: "todo.Task.create",
      dependencies: [base],
      sequence: [
        { let: "n", value: async (c, s, b) => s.base.n },
        { observations: async (c, s, b) => [b.get("n")], expected: async (c, s, b) => [s.base.n], types: ["int"] },
      ],
    }],
  };
}
`;

describe("genuine emitted scope convention", () => {
  it("table closures read fixtures as scope properties through live state", async () => {
    const url = await writeModule("table.mjs", TABLE_MODULE);
    const seenInputs: unknown[] = [];
    const hooks: ExampleHooks = {
      // Models `complete`: an already-done task rejects `rule_failed`.
      invokeCall: async (call) => {
        seenInputs.push(call.inputs);
        const task = (call.inputs as { task: { done: boolean } }).task;
        return task.done ? { ok: false, error: "rule_failed" } : { ok: true };
      },
      // Live state arrives as a Map (producer read ports) carrying the
      // post-invoke row; observations must still read it as properties.
      observeScope: async (_scope, stashed) =>
        new Map([...stashed.fixtures, ["open_task", { ...(stashed.inputs as { task: object }).task, done: true }]]),
    };
    const suite = await loadExampleSuite(url, bindings(), hooks);
    const result = await runTable({
      operation: "todo.complete",
      userFixtures: suite.userFixtures,
      createScope: async () => new MemoryScope(),
      rows: suite.rows,
    });
    // Input cells apply along selector paths (row 1 done=false, row 2
    // done=true); the provisioned seed stays pristine in both rows.
    expect(seenInputs).toEqual([
      { task: { title: "Opening checks", done: false } },
      { task: { title: "Opening checks", done: true } },
    ]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((row) => row.outcome)).toEqual(["passed", "passed"]);
    expect(result.rows[1]?.rejection).toEqual({ error: "rule_failed", sideEffectsAbsent: true });
  });

  it("rejects unsafe selector segments loud", async () => {
    const url = await writeModule(
      "unsafe.mjs",
      `export function exampleFixtures({ self, other, imported }) {
        void self; void other; void imported;
        return {
          fixtures: {},
          examples: [{
            operation: "todo.Task.create",
            dependencies: [],
            inputs: async (c, s) => ({ task: {} }),
            selectors: ["task.__proto__"],
            observations: [],
            rows: [{ dependencies: [], values: async (c, s) => [{}], expected: async (c, s) => [] }],
          }],
        };
      }
      `,
    );
    const suite = await loadExampleSuite(url, bindings(), {});
    const row = suite.rows[0];
    if (row === undefined) throw new Error("expected one row");
    await expect(
      row.setup(new MemoryScope(), { self: "s", other: "o", outsider: "x", users: {} }),
    ).rejects.toThrow(/unsafe segment "__proto__"/);
  });

  it("sequence closures read fixtures as scope properties", async () => {
    const url = await writeModule("sequence.mjs", SEQUENCE_MODULE);
    const invoke: ExampleHooks["invokeCall"] = async (): Promise<CallOutcome> => ({ ok: true });
    const suite = await loadExampleSuite(url, bindings(), { invokeCall: invoke });
    const result = await runTable({
      operation: "todo.Task.create",
      userFixtures: suite.userFixtures,
      createScope: async () => new MemoryScope(),
      rows: suite.rows,
    });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.outcome).toBe("passed");
  });
});
