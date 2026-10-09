import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createReport, fixtureValuesOf, loadExampleSuite, runTable } from "../../testkit/src/index.js";
import { runCompiledExamples } from "../src/dev/example-runner.js";

const map = (file: string) => ({
  version: 3, file, sources: ["Office.can"], sourcesContent: [null], names: [], mappings: "",
});

describe("compiled example row expectations", () => {
  it("uses expectations evaluated during real Testkit setup for success and denial rows", async () => {
    const artifact = {
      artifact_version: 1, language_version: "1.0", tool_version: "0.1.0",
      sources: [{ path: "Office.can", sha256: "a".repeat(64) }],
      modules: [{ path: "app.mjs", js: "export {};", map: map("app.mjs") }],
      callables: [], pages: [], requires: [],
      tests: [{ scope: "Office.Supply.update", fixtures: [], module: {
        path: "tests/row.mjs", map: map("tests/row.mjs"),
        js: `export function exampleFixtures({other}) {
          return {fixtures:{},examples:[{
            operation:"Office.Supply.update",dependencies:[],inputs:async()=>({}),
            selectors:["as"],observations:[async()=>"saved"],rows:[
              {dependencies:[],values:async()=>[other],expected:async()=>["saved"]},
              {dependencies:[],values:async()=>["outsider"],error:"forbidden"}
            ]
          }]};
        }`,
      } }],
    };
    const result = await runCompiledExamples({
      artifactBytes: Buffer.from(JSON.stringify(artifact)), artifactLabel: "Office.artifact.json",
      sourceRevision: "source-1", workerName: `example-expectation-${randomUUID()}`,
      worker: { mainModule: "main.mjs", modules: { "main.mjs": "export default {fetch(){return new Response(null,{status:404})}};" } },
      compatibilityDate: "2026-07-15", d1Binding: "DB",
      testkit: { loadExampleSuite, runTable, createReport, fixtureValuesOf },
      hooks: {
        materializeFixtures: async ({ fixtures }) => ({ materialized: [], values: new Map(fixtures) }),
        invoke: async ({ call }) => call.by === "outsider" ? { ok: false, error: "forbidden" } : { ok: true },
        observeLive: async () => new Map(),
      },
    });
    expect(result.ok).toBe(true);
    expect(result.executed).toBe(2);
    expect(result.report.cases[0]).toMatchObject({ kind: "table", rows: [
      { rowIndex: 0, outcome: "passed", caller: { account: "row-0-other" } },
      { rowIndex: 1, outcome: "passed", caller: { account: "row-1-outsider" },
        rejection: { error: "forbidden", sideEffectsAbsent: true } },
    ] });
  }, 120000);
});
