import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import type { ArtifactRuntimeBinding, CompileArtifact } from "@canlang/contracts";
import { configureLocalBindings, planLocalBindings, probeLocalR2 } from "../src/dev/local-bindings.js";
import { startLocalDev } from "../src/dev/local-run.js";

const bindings: ArtifactRuntimeBinding[] = [
  { owner: "Data", name: "cache", binding: "Data.cache", kind: "kv", ttlMilliseconds: "60000" },
  { owner: "Data", name: "jobs", binding: "Data.jobs", kind: "queue", type: "Data.Job", handlers: ["Data.deliver"] },
  { owner: "Data", name: "events", binding: "Data.events", kind: "analytics-engine", schema: [{ name: "count", type: "Number" }] },
  { owner: "Other", name: "cache", binding: "Other.cache", kind: "kv", ttlMilliseconds: "1000" },
  { owner: "App", name: "FILES", binding: "FILES", kind: "r2", implicit: true },
  { owner: "Combined", name: "FILES", binding: "FILES", kind: "r2", implicit: true },
  { owner: "RemoteCapability", name: "actor", binding: "RemoteCapability.actor", kind: "durable-object", key: "RemoteCapability.Root.id" },
];
function artifact(inventory: ArtifactRuntimeBinding[] = bindings): CompileArtifact {
  const queues = inventory.filter(binding => binding.kind === "queue");
  const handlers = queues.flatMap(queue => queue.handlers.map(handler => ({ queue, handler })));
  const events = Object.fromEntries(queues.map(queue => [queue.binding, { inputs: { value: { type: queue.type } } }]));
  const operations = Object.fromEntries(handlers.map(({ queue, handler }) => [handler, { handler, event: queue.binding, read: false,
    invocation: { name: handler, kind: "scenario", inputs: { fields: [{ name: "value", valueType: queue.type, required: true, field: { kind: "nominal", name: queue.type } }] } } }]));
  return { runtimeBindings: structuredClone(inventory), callables: handlers.map(({ handler }, index) => ({ id: handler, kind: "handler", module: "app.js", export: `handler${index}`, member: [handler] })),
    modules: [{ path: "app.js", js:
    `throw new Error("metadata inspection must not execute imports or code");\n${handlers.map(({ handler }, index) => `export const handler${index}=${JSON.stringify(handler)};`).join("\n")}\nexport const appDefinition = { id: "App", runtimeBindingOwners: ["App", "Data"], runtimeBindings: ${JSON.stringify(inventory)}, operations: ${JSON.stringify(operations)}, events: ${JSON.stringify(events)}, compositions: { Combined: {runtimeBindingOwners: ["Combined", "App", "Data"]} } };` }],
  } as CompileArtifact;
}

it("selects only the compiler-owned closure and coalesces implicit FILES across composition", () => {
  const plan = planLocalBindings(artifact());
  expect(plan.app).toBe("App");
  expect(plan.bindings.map(binding => binding.binding)).toEqual(["Data.cache", "Data.jobs", "Data.events", "FILES"]);
  expect(plan.bindings.some(binding => binding.owner === "RemoteCapability" || binding.owner === "Other")).toBe(false);
  const composition = planLocalBindings(artifact(), "Combined");
  expect(composition.bindings.filter(binding => binding.kind === "r2")).toHaveLength(1);
  expect(() => planLocalBindings(artifact(), "Missing")).toThrow(/composition Missing is absent/);
});

it("routes model-free member effects through team State and refuses mixed owner profiles", () => {
  const make = (by: unknown[]) => {
    const value = artifact([bindings[4]!]);
    value.models = [];
    value.operations = [{ name: "App.submit", kind: "scenario", description: "", inputs: { fields: [] } }];
    value.modules[0]!.js = value.modules[0]!.js.replace('id: "App",',
      `id: "App", policy: ${JSON.stringify({ operations: { "App.submit": { by } } })},`);
    return value;
  };
  expect(planLocalBindings(make(["members"])).noModelStorageMode).toBe("team");
  expect(planLocalBindings(make(["App.editor"])).noModelStorageMode).toBe("team");
  expect(() => planLocalBindings(make(["public"]))).toThrow(/global State owner-selection API/);
  expect(() => planLocalBindings(make(["authenticated"]))).toThrow(/global State owner-selection API/);
  expect(() => planLocalBindings(make(["members", "public"]))).toThrow(/mixed app\/team/);
  expect(() => planLocalBindings(make([]))).toThrow(/ordinary caller selectors/);
  expect(() => planLocalBindings(make([{ roleSubject: { role: "members", person: "person" } }]))).toThrow(/ordinary caller selectors/);
  const compound = make(["members"]);
  compound.modules[0]!.js = compound.modules[0]!.js.replace('"by":["members"]', '"by":["members"],"gated":true');
  expect(() => planLocalBindings(compound)).toThrow(/ordinary caller selectors/);
  const modelOwned = make(["members"]);
  modelOwned.models = [{ name: "App.Settings", scope: "app", fields: [] }];
  expect(planLocalBindings(modelOwned).noModelStorageMode).toBeUndefined();
});

it("refuses missing, changed, dynamic, and duplicate compiled metadata before evaluation", () => {
  const mismatch = artifact(); mismatch.runtimeBindings = [];
  expect(() => planLocalBindings(mismatch)).toThrow(/disagrees/);
  const missing = artifact(); delete missing.runtimeBindings;
  expect(() => planLocalBindings(missing)).toThrow(/disagrees/);
  for (const source of [
    'export const appDefinition = {id:"App",runtimeBindings: (() => {throw new Error("never");})(),runtimeBindingOwners:["App"]};',
    'export const appDefinition = {id:"App",runtimeBindings:[],runtimeBindings:[],runtimeBindingOwners:["App"]};',
    'export const appDefinition = {id:"App",runtimeBindings:[],get runtimeBindingOwners(){ throw new Error("never"); }};',
  ]) {
    const dynamic = artifact([]); dynamic.modules[0]!.js = source;
    expect(() => planLocalBindings(dynamic)).toThrow(/literal data|duplicate key|computed keys/);
  }
  const closure = artifact([]); closure.modules[0]!.js = 'export const appDefinition={id:"App",runtimeBindings:[]};';
  expect(() => planLocalBindings(closure)).toThrow(/owner closure/);
});

it("keeps legacy omission and rejects malformed source-owned declarations", () => {
  expect(planLocalBindings({ modules: [{ js: "export const appDefinition={id:'Legacy'};" }] } as CompileArtifact).bindings).toEqual([]);
  for (const changed of [
    { ...bindings[0], binding: "FILES" }, { ...bindings[0], ttlMilliseconds: "-1" },
    { ...bindings[1], handlers: ["Data.deliver", "Data.deliver"] },
  ]) expect(() => planLocalBindings(artifact([changed as ArtifactRuntimeBinding]))).toThrow(/canonical|TTL|handlers/);
  expect(() => planLocalBindings(artifact([bindings[0]!, bindings[0]!]))).toThrow(/duplicate declaration/);
});

it("derives real mappings, physical queue routing, and private storage paths without a second manifest", () => {
  const plan = planLocalBindings(artifact());
  const configured = configureLocalBindings(plan, "/private/preview");
  expect(configured.resources.map(resource => resource.requirement)).toEqual(plan.requirements);
  expect(configured.worker.kvPersist).toBe("/private/preview/kv");
  expect(configured.worker.r2Persist).toBe("/private/preview/r2");
  expect(configured.worker.analyticsEnginePersist).toBe("/private/preview/analytics");
  expect(configured.worker.r2Buckets).toHaveLength(1);
  const physical = configured.worker.queueProducers!["Data.jobs"] as string;
  expect(configured.worker.queueConsumers).toHaveProperty(physical);
  expect(configured.worker.vars).toEqual({ CAN_LOCAL_QUEUE_BINDINGS: { [physical]: "Data.jobs" } });
  expect(configureLocalBindings(plan, "/private/second").worker.kvNamespaces).toEqual(configured.worker.kvNamespaces);
  expect(configureLocalBindings(plan, "/private/preflight", {}, true).worker.queueConsumers).toBeUndefined();
});

it("requires real services and selects the installed root class only for the final serving worker", () => {
  const source: ArtifactRuntimeBinding[] = [
    { owner: "App", name: "Mailer", binding: "App.Mailer", kind: "service", from: "mail-service", capability: "Mail.send" },
    { owner: "App", name: "roots", binding: "App.roots", kind: "durable-object", key: "App.Root.id" },
  ];
  const plan = planLocalBindings(artifact(source));
  expect(() => configureLocalBindings(plan, "/private/local")).toThrow(/requires the real docs/implementation/);
  const implementation = { workerName: "mailer", compatibilityDate: "2026-07-15", mainModule: "service.js", modules: { "service.js": 'export default {fetch(){return new Response("real");}};' } };
  const providers = { services: { "mail-service": implementation } };
  const configured = configureLocalBindings(plan, "/private/local", providers);
  expect(configured.worker.companionWorkers).toEqual([implementation]);
  expect(configured.worker.serviceBindings).toEqual({ "App.Mailer": "mailer" });
  expect(configured.worker.durableObjects).toEqual([{ binding: "App.roots", className: "CanRootAuthority", useSQLite: true }]);
  expect(configureLocalBindings(plan, "/private/local", providers, true).worker.durableObjects).toBeUndefined();
});

it("probes the actual scoped R2 producer and removes its private object", async () => {
  const plan = planLocalBindings(artifact(bindings.filter(binding => binding.kind === "r2")));
  const root = mkdtempSync(join(tmpdir(), "can-binding-probe-"));
  const configured = configureLocalBindings(plan, root);
  const dev = await startLocalDev({ ...configured.worker, workerName: "probe", compatibilityDate: "2026-07-15", mainModule: "main.js", modules: { "main.js": "export default {fetch(){return new Response(null,{status:404})}};" } });
  try {
    await probeLocalR2(dev, plan);
    expect((await (await dev.getR2Bucket("FILES")).list()).objects).toEqual([]);
  } finally { await dev.dispose(); rmSync(root, { recursive: true, force: true }); }
});

it("admits only the exact source queue handler callable and private invocation schema", () => {
  const original = artifact();
  expect(planLocalBindings(original).queueHandlers).toEqual(["Data.deliver"]);
  const wrongCallable = artifact(); wrongCallable.callables[0]!.kind = "operation";
  expect(() => planLocalBindings(wrongCallable)).toThrow(/matching compiled callable/);
  const wrongEvent = artifact(); wrongEvent.modules[0]!.js = wrongEvent.modules[0]!.js.replace('"event":"Data.jobs"', '"event":"Other.jobs"');
  expect(() => planLocalBindings(wrongEvent)).toThrow(/disagrees with its source queue/);
  const wrongType = artifact(); wrongType.modules[0]!.js = wrongType.modules[0]!.js.replace('"valueType":"Data.Job"', '"valueType":"Other.Job"');
  expect(() => planLocalBindings(wrongType)).toThrow(/disagrees with its source queue/);
});
