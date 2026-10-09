import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { CompileArtifact } from "@canlang/contracts";
import { distribution as valuesDistribution } from "@canlang/values/distribution";
import {
  loadInstalledExampleTestkit,
  runCompiledExamples,
  type CompiledExampleInput,
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
