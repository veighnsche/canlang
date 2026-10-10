import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { CompileArtifact, ModelName } from "@canlang/contracts";
import { distribution as valuesDistribution } from "@canlang/values/distribution";
import {
  loadInstalledExampleTestkit,
  runCompiledExamples,
  type CompiledExampleInput,
  type ExampleRuntimeHooks,
} from "./example-runner.js";

const compiler = join(process.cwd(), "compiler/target/debug/can");
const catalog = fileURLToPath(valuesDistribution.catalog);
function compiled(source: string): CompileArtifact {
  const root = mkdtempSync(join(tmpdir(), "can-example-runner-"));
  try {
    const sourcePath = join(root, "RunnerProbe.can");
    writeFileSync(sourcePath, source);
    return JSON.parse(execFileSync(compiler, ["compile", "--format=json", `--catalog=${catalog}`, sourcePath], {
      encoding: "utf8",
    })) as CompileArtifact;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testModule(scope: string, js: string) {
  return {
    scope,
    fixtures: [],
    module: {
      path: `tests/${scope.replaceAll(".", "-")}.mjs`,
      map: { version: 3 as const, file: "example.mjs", sources: ["RunnerProbe.can"], sourcesContent: [null], names: [], mappings: "" },
      js,
    },
  };
}

async function input(artifact: CompileArtifact): Promise<CompiledExampleInput> {
  const testkit = await loadInstalledExampleTestkit(process.cwd());
  return {
    artifactBytes: Buffer.from(JSON.stringify(artifact)), artifactLabel: "RunnerProbe.artifact.json",
    sourceRevision: "example-runner-source", workerName: `example-runner-${randomUUID()}`,
    worker: { mainModule: "main.mjs", modules: { "main.mjs": "export default {fetch(){return new Response(null,{status:404})}};" } },
    compatibilityDate: "2026-07-15", d1Binding: "DB", testkit,
  };
}

test("default adapter routes public calls through the current team and preserves member denial", async () => {
  const artifact = compiled(`app RunnerProbe
Given
 Item { seen:bool }
 policy Item read=public
When
 scenario publicCheck(entry:Item) by=public
  do set entry {seen=actor==null}
 scenario memberCheck(entry:Item) by=members
  do set entry {seen=true}
Then
`);
  artifact.tests = [
    testModule("RunnerProbe.publicCheck", `const entry={model:"RunnerProbe.Item",dependencies:[],value:async()=>({seen:false})};
      export function exampleFixtures() { return {fixtures:{entry},examples:[{operation:"RunnerProbe.publicCheck",
        dependencies:[entry],inputs:async(_b,s)=>({entry:s.entry}),selectors:["as"],
        observations:[async(_b,s)=>s.entry.seen],rows:[{dependencies:[entry],values:async()=>["public"],
          expected:async()=>[true]}]}]}; }`),
    testModule("RunnerProbe.memberCheck", `const entry={model:"RunnerProbe.Item",dependencies:[],value:async()=>({seen:false})};
      export function exampleFixtures() { return {fixtures:{entry},examples:[{operation:"RunnerProbe.memberCheck",
        dependencies:[entry],inputs:async(_b,s)=>({entry:s.entry}),selectors:["as"],observations:[],
        rows:[{dependencies:[entry],values:async()=>["public"],error:"forbidden"}]}]}; }`),
  ];

  const result = await runCompiledExamples(await input(artifact));
  assert.equal(result.ok, true, JSON.stringify(result.report));
  assert.equal(result.executed, 2);
  const publicCase = result.report.cases[0];
  const memberCase = result.report.cases[1];
  assert.equal(publicCase?.kind, "table");
  assert.equal(memberCase?.kind, "table");
  if (publicCase?.kind !== "table" || memberCase?.kind !== "table") throw new Error("expected table cases");
  assert.equal(publicCase.rows[0]?.outcome, "passed");
  assert.equal(memberCase.rows[0]?.rejection?.error, "forbidden");
});

test("default canonical adapter runs a freshly compiled model-free scenario", async () => {
  const artifact = compiled(`app RunnerProbe
Given
When
 scenario publicText() -> bool by=public
  do
   require actor==null
   return true
Then
`);
  artifact.tests = [testModule("RunnerProbe.publicText", `export function exampleFixtures() {
    return {fixtures:{},examples:[{operation:"RunnerProbe.publicText",dependencies:[],inputs:async()=>({}),
      selectors:["as"],observations:[],rows:[{dependencies:[],values:async()=>["public"],expected:async()=>[]}]}]};
  }`)];

  const result = await runCompiledExamples(await input(artifact));
  assert.equal(result.ok, true, JSON.stringify(result.report));
  assert.equal(result.executed, 1);
  const exampleCase = result.report.cases[0];
  assert.equal(exampleCase?.kind, "table");
  if (exampleCase?.kind !== "table") throw new Error("expected a table case");
  assert.equal(exampleCase.rows[0]?.outcome, "passed");
});

test("default adapter respects input, request and caller selector channels for stored fixtures", async () => {
  const artifact = compiled(`app RunnerProbe
Given
 Item { seen:bool }
 policy Item read=public
When
 scenario inputCheck(request:Item) by=members
  do require request.seen
 scenario wireCheck(request:Item,seen:bool) by=members
  do
   require not request.seen
   require seen
Then
`);
  // These table modules exercise the consumer port over real compiled
  // operations. Compiler owns qualification of generated channel metadata.
  artifact.tests = [
    testModule("RunnerProbe.inputCheck", `const entry={model:"RunnerProbe.Item",dependencies:[],value:async()=>({seen:false})};
      export function exampleFixtures() { return {fixtures:{entry},examples:[{operation:"RunnerProbe.inputCheck",
        dependencies:[entry],inputs:async(_b,s)=>({request:s.entry}),selectors:["as","request.seen"],
        selectorChannels:["caller","input"],observations:[async(_b,s)=>s.entry.seen],
        rows:[{dependencies:[entry],values:async()=>["self",true],expected:async()=>[true]}]}]}; }`),
    testModule("RunnerProbe.wireCheck", `const entry={model:"RunnerProbe.Item",dependencies:[],value:async()=>({seen:false})};
      export function exampleFixtures() { return {fixtures:{entry},examples:[{operation:"RunnerProbe.wireCheck",
        dependencies:[entry],inputs:async(_b,s)=>({request:s.entry,seen:false}),selectors:["as","request.seen"],
        selectorChannels:["caller","request"],observations:[async(_b,s)=>s.entry.seen],
        rows:[{dependencies:[entry],values:async()=>["self",true],expected:async()=>[false]}]}]}; }`),
  ];

  const runtimeInput = await input(artifact);
  const installedLoader = runtimeInput.testkit.loadExampleSuite;
  type PrepareRowCells = NonNullable<ExampleRuntimeHooks["prepareRowCells"]>;
  const channelsSeen: string[][] = [];
  const record = (value: unknown): Record<string, unknown> => {
    assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
    return value as Record<string, unknown>;
  };
  const result = await runCompiledExamples({
    ...runtimeInput,
    testkit: {
      ...runtimeInput.testkit,
      // Delegate all setup, invocation and outcomes to the installed loader
      // and default adapter; inspect only the genuine preparation boundary.
      loadExampleSuite: (url: string, bindings: unknown, hooks: { readonly prepareRowCells?: PrepareRowCells }) => {
        assert.ok(hooks.prepareRowCells);
        const prepare = hooks.prepareRowCells;
        return installedLoader(url, bindings, {
          ...hooks,
          prepareRowCells: async (args: Parameters<PrepareRowCells>[0]) => {
            const channels = args.selectorChannels;
            assert.ok(channels, "installed loader must forward declared selector channels");
            assert.deepEqual(args.selectors, ["as", "request.seen"]);
            assert.deepEqual(args.cells, ["self", true]);
            assert.equal(channels[0], "caller");
            const channel = channels[1];
            assert.ok(channel === "input" || channel === "request");
            channelsSeen.push([...channels]);
            const fixture = record(args.fixtures.get("entry"));
            assert.equal(record(args.baselineInputs).request, fixture);
            const query = { model: "RunnerProbe.Item" as ModelName, authority: "owner" as const };
            const beforeRows = await args.scope.store.query(query);
            assert.equal(beforeRows.length, 1);
            const beforeRow = beforeRows[0]!;
            assert.equal(beforeRow.id, fixture.id);
            assert.equal(BigInt(beforeRow.version), fixture.version);
            assert.equal(beforeRow.data.seen, false);
            const beforeRevision = await args.scope.store.readRevision();
            const before = record(await args.scope.snapshot());

            const prepared = await prepare(args);

            const afterRows = await args.scope.store.query(query);
            assert.equal(afterRows.length, 1);
            const afterRow = afterRows[0]!;
            const afterRevision = await args.scope.store.readRevision();
            const after = record(await args.scope.snapshot());
            const currentFixture = record(prepared.fixtures.get("entry"));
            assert.equal(record(prepared.inputs).request, currentFixture);
            assert.equal(currentFixture.id, fixture.id);
            assert.equal(currentFixture.version, BigInt(afterRow.version));
            if (channel === "request") {
              assert.equal(currentFixture, fixture);
              assert.deepEqual(afterRow, beforeRow);
              assert.equal(afterRevision, beforeRevision);
              assert.deepEqual(after, before);
            } else {
              assert.notEqual(currentFixture, fixture);
              assert.equal(afterRevision, beforeRevision + 1);
              assert.deepEqual(afterRow, { ...beforeRow, version: beforeRow.version + 1,
                updated: afterRow.updated, updatedBy: args.scope.fixtureActorId,
                data: { ...beforeRow.data, seen: true } });
              assert.equal(currentFixture.seen, true);
              assert.deepEqual(Object.keys(after), Object.keys(before));
              for (const binding of Object.keys(before)) {
                if (binding !== "CAN_EXAMPLE_STATE_CURRENT") {
                  assert.deepEqual(after[binding], before[binding]);
                  continue;
                }
                const oldTables = record(before[binding]);
                const newTables = record(after[binding]);
                assert.deepEqual(Object.keys(newTables), Object.keys(oldTables));
                assert.notDeepEqual(newTables.records, oldTables.records);
                for (const table of Object.keys(oldTables)) {
                  if (table !== "records") assert.deepEqual(newTables[table], oldTables[table]);
                }
              }
            }
            return prepared;
          },
        });
      },
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result.report));
  assert.equal(result.executed, 2);
  assert.deepEqual(channelsSeen, [["caller", "input"], ["caller", "request"]]);
  assert.equal(result.report.cases.length, 2);
  for (const exampleCase of result.report.cases) {
    assert.equal(exampleCase.kind, "table");
    if (exampleCase.kind !== "table") throw new Error("expected a table case");
    assert.equal(exampleCase.rows[0]?.outcome, "passed");
  }
});
