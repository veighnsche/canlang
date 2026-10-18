import assert from "node:assert/strict";
import test from "node:test";
import type { ArtifactTestModule } from "@canlang/contracts";
import { resolveExampleFixtureImports } from "./example-fixture-imports.js";

function inventory(scope: string): ArtifactTestModule {
  return { scope, fixtures: [scope], module: { path: scope, js: "", map: {
    version: 3, file: scope, sources: [], sourcesContent: [], names: [], mappings: "",
  } } };
}
function descriptor(key: string): object {
  const dot = key.lastIndexOf(".");
  return { provider: key.slice(0, dot), member: key.slice(dot + 1), alias: key };
}

test("canonical providers share diamond recipes once, preserving live bindings and dependency identity", async () => {
  const keys = ["site.same", "employee.same", "customer.same", "crm.run"];
  const tests = keys.map(inventory);
  const urls = Object.fromEntries(keys.map(key => [key, key]));
  const calls: string[] = [];
  let actor = "initial";
  const bindings = { get self() { return actor; }, imported: {} };
  const modules: Record<string, Record<string, unknown>> = {};
  function provider(key: string, dependencies: string[]): Record<string, unknown> {
    return {
      exampleImports: dependencies.map(descriptor),
      exampleFixtures: (c: typeof bindings) => {
        calls.push(key);
        const imported = c.imported as Record<string, object>;
        const recipe = { model: key, dependencies: dependencies.map(dep => imported[dep]),
          value: (_caller: unknown, s: Record<string, unknown>) =>
            ({ actor: c.self, dependencies: dependencies.map(dep => s[dep]) }) };
        return { fixtures: { ...imported, [key]: recipe }, examples: [] };
      },
    };
  }
  modules["site.same"] = provider("site.same", []);
  modules["employee.same"] = provider("employee.same", ["site.same"]);
  modules["customer.same"] = provider("customer.same", ["site.same"]);
  modules["crm.run"] = { exampleImports: ["employee.same", "customer.same"].map(descriptor) };
  const result = await resolveExampleFixtureImports(tests, urls, tests[3]!, bindings,
    async url => modules[url]!) as Record<string, { dependencies: unknown[]; value: Function }>;
  assert.deepEqual(calls, ["site.same", "employee.same", "customer.same"]);
  assert.deepEqual(Object.keys(result), keys.slice(0, 3));
  assert.equal(result["employee.same"]!.dependencies[0], result["site.same"]);
  assert.equal(result["customer.same"]!.dependencies[0], result["site.same"]);
  actor = "current";
  assert.deepEqual(result["customer.same"]!.value(null, { "site.same": "materialized" }),
    { actor: "current", dependencies: ["materialized"] });
  const second = await resolveExampleFixtureImports(tests, urls, tests[3]!, bindings,
    async url => modules[url]!) as Record<string, unknown>;
  assert.notEqual(second["site.same"], result["site.same"], "a separate suite gets a separate recipe context");
  await assert.rejects(resolveExampleFixtureImports(tests, urls, tests[3]!,
    { imported: { "site.same": {} } }, async url => modules[url]!), /caller binding conflicts/);
});

test("invalid import graphs refuse before any row setup", async () => {
  const root = inventory("crm.run");
  const a = inventory("a.fixture");
  const b = inventory("b.fixture");
  const tests = [root, a, b];
  const urls = Object.fromEntries(tests.map(entry => [entry.module.path, entry.module.path]));
  let factories = 0;
  const modules: Record<string, Record<string, unknown>> = {
    "crm.run": { exampleImports: [descriptor("a.fixture")] },
    "a.fixture": { exampleImports: [descriptor("b.fixture")] },
    "b.fixture": { exampleImports: [descriptor("a.fixture")] },
  };
  for (const key of ["a.fixture", "b.fixture"]) modules[key]!["exampleFixtures"] = () => {
    factories += 1;
    return { fixtures: {}, examples: [] };
  };
  const run = (entries = tests) => resolveExampleFixtureImports(entries, urls, root,
    { imported: {} }, async url => modules[url]!);
  await assert.rejects(run(), /cyclic provider dependency/);
  assert.equal(factories, 0);
  modules["crm.run"]!["exampleImports"] = [descriptor("missing.fixture")];
  await assert.rejects(run(), /expected one provider.*found 0/);
  modules["crm.run"]!["exampleImports"] = [descriptor("a.fixture")];
  await assert.rejects(run([...tests, a]), /expected one provider.*found 2/);
  for (const imports of [null, [{ provider: "a", member: "fixture", alias: "lexical" }],
    [descriptor("a.fixture"), descriptor("a.fixture")]]) {
    modules["crm.run"]!["exampleImports"] = imports;
    await assert.rejects(run(), /exampleImports|descriptor|duplicate import/);
  }
  modules["crm.run"]!["exampleImports"] = [descriptor("a.fixture")];
  modules["a.fixture"] = { exampleImports: [], exampleFixtures: () =>
    ({ fixtures: { "a.fixture": {}, "foreign.recipe": {} }, examples: [] }) };
  await assert.rejects(run(), /returned foreign recipe/);
  modules["a.fixture"] = { exampleImports: [], exampleFixtures: () =>
    ({ fixtures: { "a.fixture": {} }, examples: ["not recipe-only"] }) };
  await assert.rejects(run(), /invalid recipe-only provider/);
  modules["b.fixture"] = { exampleImports: [], exampleFixtures: () =>
    ({ fixtures: { "b.fixture": {} }, examples: [] }) };
  modules["a.fixture"] = { exampleImports: [descriptor("b.fixture")], exampleFixtures: () =>
    ({ fixtures: { "a.fixture": {}, "b.fixture": {} }, examples: [] }) };
  await assert.rejects(run(), /returned foreign recipe/);
  modules["a.fixture"] = { exampleImports: [descriptor("b.fixture")],
    exampleFixtures: (c: { imported: Record<string, object> }) =>
      ({ fixtures: { ...c.imported, "a.fixture": c.imported["b.fixture"] }, examples: [] }) };
  await assert.rejects(run(), /recipe object for a.fixture already belongs to b.fixture/);
  modules["crm.run"] = {};
  const legacy = {};
  assert.equal(await resolveExampleFixtureImports(tests, urls, root, { imported: legacy },
    async url => modules[url]!), legacy);
});
