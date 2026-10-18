import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { CompileArtifact, ModelName, StoredRow } from "@canlang/contracts";
import { distribution as valuesDistribution } from "@canlang/values/distribution";
import {
  loadInstalledExampleTestkit,
  runCompiledExamples,
  type CompiledExampleInput,
  type ExampleRowScope,
  type ExampleRuntimeHooks,
} from "./example-bindings.test-support.js";

const compiler = join(process.cwd(), "compiler/target/debug/can");
const catalog = fileURLToPath(valuesDistribution.catalog);
function compiled(source: string, fileName = "RunnerProbe.can"): CompileArtifact {
  const root = mkdtempSync(join(tmpdir(), "can-example-runner-"));
  try {
    const sourcePath = join(root, fileName);
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

test('field validation protects privileged fixture seeding and row-cell overrides after native trim', async () => {
  for (const mode of ['valid', 'invalid-seed', 'invalid-override'] as const) {
    const artifact = compiled(`app RunnerProbe
Given
 Item {code:text trim min=1 max=100}
 policy Item read=members
When
 scenario inspect(entry:Item) by=members
  do require entry.code!=""
Then
`);
    const js = 'export function check(value) { return new TextEncoder().encode(value).byteLength <= 128; }';
    const { sha256HexText } = await import('@canlang/identity');
    artifact.modules.push({ path: 'can.generated/budget/server.js', js,
      map: { version: 3, file: 'server.js', sources: [], sourcesContent: [], names: [], mappings: '' } });
    artifact.requires.push({ capability: 'state.field-validation', min_version: 1 });
    artifact.givenContracts = { keywords: [], traits: [{
      id: 'RunnerProbe.Item.code#budget', owner: 'RunnerProbe', inline: false, trait: 'budget',
      anchor: 'RunnerProbe:trait:budget:', unitId: 'budget', target: 'RunnerProbe.Item.code',
      fields: [{ name: 'value', type: 'text', trim: false }], order: 0, fingerprint: '0'.repeat(64),
      validation: { producer: 'state.field-validation@1', export: 'check', lifecycle: 'validate-fields',
        input: { name: 'value', type: 'text' }, result: { type: 'bool' }, reads: [], effects: [], authority: [],
        fingerprint: await sha256HexText(js) },
    }] };
    const code = mode === 'invalid-seed' ? 'é'.repeat(65) : '  Valid  ';
    const override = mode === 'invalid-override';
    artifact.tests = [testModule('RunnerProbe.inspect', `
const entry={model:"RunnerProbe.Item",dependencies:[],value:async()=>({code:${JSON.stringify(code)}})};
export function exampleFixtures(){return {fixtures:{entry},examples:[{operation:"RunnerProbe.inspect",
 dependencies:[entry],inputs:async(_b,s)=>({entry:s.entry}),selectors:${JSON.stringify(override ? ['as', 'entry.code'] : ['as'])},
 selectorChannels:${JSON.stringify(override ? ['caller', 'input'] : ['caller'])},observations:[async(_b,s)=>s.entry.code],
 rows:[{dependencies:[entry],values:async()=>${JSON.stringify(override ? ['self', 'é'.repeat(65)] : ['self'])},expected:async()=>["Valid"]}]}]};}
`)];
    const result = await runCompiledExamples(await input(artifact));
    assert.equal(result.ok, mode === 'valid', `${mode}: ${JSON.stringify(result.report)}`);
    if (mode !== 'valid') assert.match(JSON.stringify(result.report), /field validation failed/);
  }
});

test("authored self other and outsider bindings use each row's provisioned native users and clock", async () => {
  const artifact = compiled(`app RunnerProbe
Given
 Item {owner:user server=actor,seen:user?=null,stamp:datetime?=null}
 policy Item read=members
 fixture delegated=Item {owner=other}
 fixture foreign_owned=Item {owner=outsider}
When
 scenario inspect(item:Item) by=members
  do set item {seen=actor,stamp=now}
  examples item=delegated
   as -> item.owner,item.seen,item.stamp
   self -> other,self,now
   other -> other,other,now
   outsider -> error(forbidden)
  examples item=foreign_owned
   as -> item.owner,item.seen,item.stamp
   self -> outsider,self,now
Then
`);
  const result = await runCompiledExamples(await input(artifact));
  assert.equal(result.ok, true, JSON.stringify(result.report));
  assert.equal(result.executed, 4);
});

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

test("native record observations use the canonical caller projection and typed predicates", async () => {
  const artifact = compiled(`app RunnerProbe
Given
 Entry {name:text}
 policy Entry read=members
When
 crud Entry by=public fields=name
  examples create
   as,name -> count(Entry),count(Entry as entry where entry.name=="First")
   members,"First" -> 1,1
   public,"First" -> 0,0
Then
`);
  const result = await runCompiledExamples(await input(artifact));
  assert.equal(result.ok, true, JSON.stringify(result.report));
  assert.equal(result.executed, 2);
});

test("source result observations expose returned records through caller reads and decode primitive and nullable values", async () => {
  const artifact = compiled(`app RunnerProbe
Given
 Entry {name:text}
 policy Entry read=members
When
 scenario make(name:text) by=public -> Entry
  do
   create Entry {name} as entry
   return entry
  examples
   as,name -> result.name
   members,"Visible" -> "Visible"
 scenario number() by=members -> int
  do return 9007199254740993
  examples
   as -> result
   members -> 9007199254740993
 scenario readNumber() read=true by=members -> int
  do return 7
  examples
   as -> result
   members -> 7
 scenario empty() read=true by=members -> text?
  do return null
  examples
   as -> result
   members -> null
Then
`);
  // A successful public call may create the row without receiving its
  // private result. The observation adapter must retain that canonical null.
  artifact.tests.push(testModule("RunnerProbe.make", `export function exampleFixtures() {
    return {fixtures:{},examples:[{operation:"RunnerProbe.make",dependencies:[],inputs:async()=>({name:"Private"}),
      selectors:["as"],observations:[async(_b,s)=>s.result],
      rows:[{dependencies:[],values:async()=>["public"],expected:async()=>[null]}]}]};
  }`));
  // Give the additional test module its own path; its operation remains the
  // same checked source declaration as the authored member row above.
  artifact.tests[artifact.tests.length - 1]!.module.path = "tests/private-result.mjs";
  const result = await runCompiledExamples(await input(artifact));
  assert.equal(result.ok, true, JSON.stringify(result.report));
  assert.equal(result.executed, 5);
});

test("returned record observations select their identity beyond the default first page", async () => {
  const artifact = compiled(`app RunnerProbe
Given
 Entry {name:text}
 policy Entry read=members
When
 scenario echo(entry:Entry) read=true by=members -> Entry
  do return entry
Then
`);
  artifact.tests = [testModule("RunnerProbe.echo", `
import {same} from "@canlang/stdlib";
const entries=Array.from({length:30},(_,i)=>({model:"RunnerProbe.Entry",dependencies:[],value:async()=>({name:"Entry "+i})}));
const selected=s=>Array.from({length:30},(_,i)=>s["f"+i]).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).at(-1);
export function exampleFixtures(){return {fixtures:Object.fromEntries(entries.map((entry,i)=>["f"+i,entry])),examples:[{
 operation:"RunnerProbe.echo",dependencies:entries,inputs:async(_b,s)=>({entry:selected(s)}),selectors:["as"],
 observations:[async(_b,s)=>s.result.name,async(_b,s)=>same(s.result,selected(s)),
 async(_b,s)=>{try{same({...s.result},selected(s));return false;}catch{return true;}}],rows:[{dependencies:entries,values:async()=>["members"],
 expected:async(_b,s)=>[selected(s).name,true,true]}]}]};}
`)];
  const result = await runCompiledExamples(await input(artifact));
  assert.equal(result.ok, true, JSON.stringify(result.report));
  assert.equal(result.executed, 1);
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
              assert.deepEqual(afterRow, { ...beforeRow, data: { ...beforeRow.data, seen: true } });
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

test("unchanged native emitted tables separate lexical request inputs from wire metadata", async () => {
  const source = `app RequestBinding
Given
 Task {title:text}
 policy Task read=members
 fixture one=Task {title="fixture"}
When
 scenario dotted(request:Task,note:text) by=members
  do
   require request.title=="row"
   set request {title=note}
  examples request=one note="changed"
   as,request.title -> request.title
   members,"row" -> "changed"
 scenario whole(request:Task,note:text) by=members
  do
   require request.title=="fixture"
   set request {title=note}
  examples seed=[one] note="changed"
   as,request -> one.title
   members,one -> "changed"
 scenario wire(task:Task,note:text) by=members
  do
   require task.title=="fixture"
   set task {title=note}
  examples task=one note="baseline"
   as,request.note -> one.title
   members,"changed" -> "changed"
Then
`;
  const artifact = compiled(source, "RequestBinding.can");
  assert.ok(artifact.modules.some(module => module.map.sourcesContent?.includes(source)));
  const unchangedArtifact = JSON.stringify(artifact);
  const runtimeInput = await input(artifact);
  const installedLoader = runtimeInput.testkit.loadExampleSuite;
  type Prepare = NonNullable<ExampleRuntimeHooks["prepareRowCells"]>;
  type Observe = (scope: ExampleRowScope, stashed: { readonly fixtures: ReadonlyMap<string, unknown> }) => Promise<unknown>;
  const record = (value: unknown): Record<string, unknown> => {
    assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
    return value as Record<string, unknown>;
  };
  const array = (value: unknown): Record<string, unknown>[] => {
    assert.ok(Array.isArray(value));
    return value.map(record);
  };
  const snapshot = async (scope: ExampleRowScope) => {
    const db = await scope.dev.getD1Database("CAN_EXAMPLE_STATE_CURRENT");
    return { resources: record(await scope.snapshot()),
      fence: (await db.prepare("SELECT * FROM fence ORDER BY id").all()).results,
      log: (await db.prepare("SELECT * FROM fence_log ORDER BY revision").all()).results };
  };
  type Snapshot = Awaited<ReturnType<typeof snapshot>>;
  const assertResourceChanges = (before: Snapshot, after: Snapshot, allowed: readonly string[]) => {
    assert.deepEqual(Object.keys(after.resources), Object.keys(before.resources));
    for (const binding of Object.keys(before.resources)) {
      if (binding !== "CAN_EXAMPLE_STATE_CURRENT") {
        assert.deepEqual(after.resources[binding], before.resources[binding]);
        continue;
      }
      const oldTables = record(before.resources[binding]), newTables = record(after.resources[binding]);
      assert.deepEqual(Object.keys(newTables), Object.keys(oldTables));
      for (const table of Object.keys(oldTables)) {
        if (!allowed.includes(table)) assert.deepEqual(newTables[table], oldTables[table]);
      }
    }
  };
  const query = { model: "RequestBinding.Task" as ModelName, authority: "owner" as const };
  const preparedScopes = new WeakMap<ExampleRowScope, { selector: string; row: StoredRow; snapshot: Snapshot; revision: number }>();
  const preparedSelectors: string[] = [], observedSelectors: string[] = [];
  const result = await runCompiledExamples({
    ...runtimeInput, artifactLabel: "RequestBinding.artifact.json",
    testkit: { ...runtimeInput.testkit,
      loadExampleSuite: (url: string, bindings: unknown, hooks: { readonly prepareRowCells?: Prepare; readonly observeScope?: Observe }) => {
        assert.ok(hooks.prepareRowCells);
        assert.ok(hooks.observeScope);
        const prepare = hooks.prepareRowCells, observe = hooks.observeScope;
        return installedLoader(url, bindings, { ...hooks,
          prepareRowCells: async (args: Parameters<Prepare>[0]) => {
            const selector = args.selectors[1];
            assert.ok(selector === "request.title" || selector === "request" || selector === "request.note");
            assert.deepEqual(args.selectors, ["as", selector]);
            assert.deepEqual(args.selectorChannels, ["caller", selector === "request.note" ? "request" : "input"]);
            assert.equal(Object.keys(args.selectorChannels!).length, args.selectors.length);
            assert.equal(args.cells[0], "members");
            const fixture = record(args.fixtures.get("RequestBinding.one"));
            const baseline = record(args.baselineInputs);
            if (selector === "request") {
              assert.equal(Object.hasOwn(baseline, "request"), false);
              assert.equal(args.cells[1], fixture);
            } else {
              assert.equal(baseline[selector === "request.title" ? "request" : "task"], fixture);
              assert.equal(args.cells[1], selector === "request.title" ? "row" : "changed");
            }
            assert.equal(record(args.inputs).note, selector === "request.note" ? "baseline" : "changed");
            const beforeRows = await args.scope.store.query(query);
            assert.equal(beforeRows.length, 1);
            const beforeRow = beforeRows[0]!;
            assert.equal(beforeRow.id, fixture.id);
            assert.equal(BigInt(beforeRow.version), fixture.version);
            assert.equal(beforeRow.data.title, "fixture");
            const beforeRevision = await args.scope.store.readRevision(), before = await snapshot(args.scope);
            const prepared = await prepare(args);
            const afterRows = await args.scope.store.query(query);
            assert.equal(afterRows.length, 1);
            const afterRow = afterRows[0]!;
            const afterRevision = await args.scope.store.readRevision(), after = await snapshot(args.scope);
            const currentFixture = record(prepared.fixtures.get("RequestBinding.one"));
            assert.equal(record(prepared.inputs)[selector === "request.note" ? "task" : "request"], currentFixture);
            assert.equal(record(prepared.inputs).note, selector === "request.note" ? "baseline" : "changed");
            assert.equal(currentFixture.id, fixture.id);
            assert.equal(currentFixture.version, BigInt(afterRow.version));
            if (selector === "request.title") {
              assert.notEqual(currentFixture, fixture);
              assert.equal(currentFixture.title, "row");
              assert.equal(afterRevision, beforeRevision + 1);
              assert.deepEqual(afterRow, { ...beforeRow, data: { ...beforeRow.data, title: "row" } });
              assertResourceChanges(before, after, ["records"]);
              assert.equal(after.log.length, before.log.length + 1);
              assert.deepEqual(after.log.slice(0, -1), before.log);
              assert.deepEqual(after.fence, [{ id: 1, revision: afterRevision }]);
              assert.equal(after.log.at(-1)?.revision, afterRevision);
              assert.equal(after.log.at(-1)?.operation, "unknown");
            } else {
              assert.equal(currentFixture, fixture);
              assert.deepEqual(afterRow, beforeRow);
              assert.equal(afterRevision, beforeRevision);
              assert.deepEqual(after, before);
            }
            preparedSelectors.push(selector);
            preparedScopes.set(args.scope, { selector, row: afterRow, snapshot: after, revision: afterRevision });
            return prepared;
          },
          observeScope: async (scope: ExampleRowScope, stashed: Parameters<Observe>[1]) => {
            const prepared = preparedScopes.get(scope);
            assert.ok(prepared, "the real generated table must prepare its row before execution");
            const live = await observe(scope, stashed);
            assert.ok(live instanceof Map);
            const rows = await scope.store.query(query);
            assert.equal(rows.length, 1);
            const row = rows[0]!;
            const view = record(live.get("RequestBinding.one"));
            assert.equal(view.id, prepared.row.id);
            assert.equal(view.version, BigInt(row.version));
            assert.equal(view.title, "changed");
            assert.deepEqual(row, { ...prepared.row, version: prepared.row.version + 1,
              updated: row.updated, updatedBy: row.updatedBy, data: { ...prepared.row.data, title: "changed" } });
            const revision = await scope.store.readRevision(), after = await snapshot(scope);
            assert.equal(revision, prepared.revision + 1);
            assertResourceChanges(prepared.snapshot, after, ["records", "history", "receipts"]);
            const oldTables = record(prepared.snapshot.resources.CAN_EXAMPLE_STATE_CURRENT);
            const tables = record(after.resources.CAN_EXAMPLE_STATE_CURRENT);
            const receipts = array(tables.receipts), history = array(tables.history);
            assert.equal(receipts.length, array(oldTables.receipts).length + 1);
            assert.equal(history.length, array(oldTables.history).length + 1);
            const receipt = receipts.at(-1)!, entry = history.at(-1)!;
            const operation = `RequestBinding.${prepared.selector === "request.title" ? "dotted" : prepared.selector === "request" ? "whole" : "wire"}`;
            assert.equal(receipt.operation, operation);
            assert.equal(record(JSON.parse(String(receipt.outcome))).status, "committed");
            assert.equal(receipt.committed_revision, revision);
            assert.equal(typeof receipt.operation_id, "string");
            assert.match(receipt.operation_id as string, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
            assert.equal(entry.operation, operation);
            assert.equal(entry.operation_id, receipt.operation_id);
            assert.equal(entry.model, query.model);
            assert.equal(entry.record_id, row.id);
            assert.equal(entry.version, row.version);
            assert.equal(after.log.length, prepared.snapshot.log.length + 1);
            assert.deepEqual(after.log.slice(0, -1), prepared.snapshot.log);
            assert.deepEqual(after.fence, [{ id: 1, revision }]);
            assert.equal(after.log.at(-1)?.revision, revision);
            assert.equal(after.log.at(-1)?.operation, operation);
            observedSelectors.push(prepared.selector);
            return live;
          },
        });
      },
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result.report));
  assert.equal(result.executed, 3);
  const selectors = ["request.title", "request", "request.note"];
  assert.deepEqual(preparedSelectors, selectors);
  assert.deepEqual(observedSelectors, selectors);
  assert.equal(result.report.cases.length, 3);
  for (const exampleCase of result.report.cases) {
    assert.equal(exampleCase.kind, "table");
    if (exampleCase.kind !== "table") throw new Error("expected a table case");
    assert.equal(exampleCase.rows.length, 1);
    assert.equal(exampleCase.rows[0]?.outcome, "passed");
  }
  assert.equal(JSON.stringify(artifact), unchangedArtifact, "compiled source, modules and tests remain unchanged");
});

test('canonical fixture snapshots allow only absent or null optional singular Files while preserving schema and invariants', async () => {
  for (const mode of ['absent', 'null', 'nonnull', 'required-missing', 'required-null', 'array', 'invariant'] as const) {
    const type = mode.startsWith('required-') ? 'file' : mode === 'array' ? 'file[]' : 'file?';
    const artifact = compiled(`app RunnerProbe
Given
 Employee {name:text,document:${type}}
 policy Employee read=members fields=name
 invariant Employee: row.name!="invalid"
When
 scenario inspect(entry:Employee) by=members
  do require entry.name!=""
Then
`);
    const fields = { name: mode === 'invariant' ? 'invalid' : 'Employee',
      ...(mode === 'null' || mode === 'required-null' ? { document: null }
        : mode === 'nonnull' ? { document: 'fabricated-file' }
        : mode === 'array' ? { document: [] } : {}) };
    artifact.tests = [testModule('RunnerProbe.inspect', `
const entry={model:"RunnerProbe.Employee",dependencies:[],value:async()=>(${JSON.stringify(fields)})};
export function exampleFixtures(){return {fixtures:{entry},examples:[{operation:"RunnerProbe.inspect",
 dependencies:[entry],inputs:async(_b,s)=>({entry:s.entry}),selectors:["as"],
 observations:[async(_b,s)=>s.entry.name],rows:[{dependencies:[entry],values:async()=>["members"],expected:async()=>["Employee"]}]}]};}
`)];
    const result = await runCompiledExamples(await input(artifact));
    assert.equal(result.ok, mode === 'absent' || mode === 'null', `${mode}: ${JSON.stringify(result.report)}`);
    assert.equal(result.executed, 1);
    if (mode === 'array') assert.match(JSON.stringify(result.report), /explicit resource materialization profile/);
  }
});
