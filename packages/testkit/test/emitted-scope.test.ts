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
  it("applies fixture-field row cells before the rejection snapshot", async () => {
    const url = await writeModule("fixture-cells.mjs", `
export function exampleFixtures() {
  const job={model:"demo.Job",dependencies:[],value:async()=>({status:"idle"})};
  return {fixtures:{job},examples:[{
    operation:"demo.queue",dependencies:[job],inputs:async(c,s)=>({job:s.job}),
    selectors:["as","job.status"],observations:[async(c,s)=>s.job.status],
    rows:[
      {dependencies:[],values:async()=>["members","idle"],expected:async()=>["queued"]},
      {dependencies:[],values:async()=>["members","queued"],error:"rule_failed"}
    ]
  }]};
}`);
    const seen: string[] = [];
    const suite = await loadExampleSuite(url, bindings(), {
      prepareFixtures: async () => new Map([["job", { id: "job-1", version: 1n, status: "idle" }]]),
      prepareRowCells: async ({ fixtures, baselineInputs, inputs, selectors, cells }) => {
        expect(selectors).toEqual(["as", "job.status"]);
        expect((baselineInputs as { job: unknown }).job).toBe(fixtures.get("job"));
        const updated = { ...(inputs as { job: object }).job, version: 2n, status: cells[1] };
        seen.push(`seed:${String(updated.status)}`);
        return { fixtures: new Map([["job", updated]]), inputs: { job: updated } };
      },
      invokeCall: async ({ inputs }) => {
        const job = (inputs as { job: { status: string; version: bigint } }).job;
        expect(job.version).toBe(2n);
        seen.push(`call:${job.status}`);
        return job.status === "queued" ? { ok: false, error: "rule_failed" } : { ok: true };
      },
      observeScope: async (_scope, stashed) => new Map([["job", {
        ...(stashed.fixtures.get("job") as object), status: "queued",
      }]]),
    });
    const result = await runTable({ operation: "demo.queue", userFixtures: suite.userFixtures,
      createScope: async () => new MemoryScope(), rows: suite.rows });
    expect(result.rows.map(row => row.outcome)).toEqual(["passed", "passed"]);
    expect(seen).toEqual(["seed:idle", "call:idle", "seed:queued", "call:queued"]);
  });

  it("materializes a stored fixture before CRUD cells and keeps request overrides separate", async () => {
    const url = await writeModule("prepared-update.mjs", `
export function exampleFixtures() {
  const editable={model:"todo.Task",dependencies:[],value:async()=>({name:"Paper",quantity:4n})};
  return {fixtures:{editable},examples:[{
    operation:"todo.Task.update",dependencies:[editable],
    inputs:async(c,s)=>({record:s.editable}),
    selectors:["changes.name","changes.quantity","request.record.version"],
    observations:[async(c,s)=>s.editable.name,async(c,s)=>s.editable.quantity],
    rows:[{dependencies:[],values:async()=>["A4 paper",8n,1n],expected:async()=>["A4 paper",8n]}]
  }]};
}`);
    const calls: unknown[] = [];
    const suite = await loadExampleSuite(url, bindings(), {
      prepareFixtures: async (_scope, fields, required) => {
        expect(required).toEqual([{ name: "editable", kind: "model", label: "todo.Task" }]);
        expect(fields.get("editable")).toEqual({ name: "Paper", quantity: 4n });
        return new Map([["editable", { id: "stored-1", version: 1n, name: "Paper", quantity: 4n }]]);
      },
      invokeCall: async (call) => {
        calls.push({ inputs: call.inputs, request: call.request });
        return { ok: true };
      },
      observeScope: async () => new Map([["editable", { name: "A4 paper", quantity: 8n }]]),
    });
    const result = await runTable({ operation: "todo.Task.update", userFixtures: suite.userFixtures,
      createScope: async () => new MemoryScope(), rows: suite.rows });
    expect(result.rows.map(row => row.outcome)).toEqual(["passed"]);
    expect(calls).toEqual([{ inputs: { record: { id: "stored-1", version: 1n, name: "Paper", quantity: 4n },
      changes: { name: "A4 paper", quantity: 8n } }, request: { record: { version: 1n } } }]);
  });

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
