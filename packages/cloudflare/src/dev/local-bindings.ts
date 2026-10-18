/** Source-owned local resources. Metadata inspection never executes app imports. */
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { parse } from "acorn";
import type { ArtifactRuntimeBinding, CompileArtifact, EnvironmentSelection, ResourceBindingRequirement } from "@canlang/contracts";
import type { LocalDev, LocalDevOptions, LocalWorkerOptions } from "./local-run.js";

type Node = { type: string; [key: string]: unknown };
export class LocalBindingAdmissionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "LocalBindingAdmissionError"; }
}
function invalid(message: string): never { throw new LocalBindingAdmissionError("RUNTIME_BINDINGS_INVALID", message); }
function node(value: unknown): Node {
  if (value === null || typeof value !== "object" || typeof (value as Node).type !== "string") invalid("compiled runtime metadata is not a static expression");
  return value as Node;
}
function properties(value: unknown): Map<string, Node> {
  const object = node(value);
  if (object.type !== "ObjectExpression" || !Array.isArray(object.properties)) invalid("compiled runtime metadata must be an object literal");
  const result = new Map<string, Node>();
  for (const raw of object.properties) {
    const property = node(raw), key = node(property.key);
    if (property.type !== "Property" || property.computed || property.method || property.kind !== "init") invalid("compiled runtime metadata cannot contain computed keys, spreads or getters");
    const name = key.type === "Identifier" ? key.name : key.type === "Literal" ? key.value : undefined;
    if (typeof name !== "string" || result.has(name)) invalid("compiled runtime metadata contains an invalid or duplicate key");
    result.set(name, node(property.value));
  }
  return result;
}
function literal(value: Node): unknown {
  if (value.type === "Literal" && (value.value === null || ["string", "number", "boolean"].includes(typeof value.value))) return value.value;
  if (value.type === "ArrayExpression" && Array.isArray(value.elements)) return value.elements.map(element => literal(node(element)));
  if (value.type === "ObjectExpression") return Object.fromEntries([...properties(value)].map(([key, member]) => [key, literal(member)]));
  invalid("compiled runtime metadata must contain only literal data");
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, member]) => `${JSON.stringify(key)}:${canonical(member)}`).join(",")}}`;
  return JSON.stringify(value);
}
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === "string" && item.length > 0) && new Set(value).size === value.length; }
function checkBindingEntry(entry: unknown, seen: Set<string>): void {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) invalid("runtime binding declaration must be an object");
  const binding = entry as ArtifactRuntimeBinding;
  if (typeof binding.owner !== "string" || !binding.owner || typeof binding.name !== "string" || !binding.name ||
      typeof binding.binding !== "string" || binding.binding !== (binding.kind === "r2" ? "FILES" : `${binding.owner}.${binding.name}`)) invalid("runtime binding must retain its canonical source owner and name");
  const identity = `${binding.owner}:${binding.binding}`;
  if (seen.has(identity)) invalid("runtime binding inventory contains a duplicate declaration");
  seen.add(identity);
  checkBindingKind(binding);
}

function checkBindingKind(binding: ArtifactRuntimeBinding): void {
  switch (binding.kind) {
    case "r2": if (binding.implicit !== true || binding.name !== "FILES") invalid("FILES must be an implicit R2 declaration"); break;
    case "durable-object": if (typeof binding.key !== "string" || !binding.key) invalid("Durable Object declaration has no root key"); break;
    case "queue": checkQueueBinding(binding); break;
    case "kv": if (typeof binding.ttlMilliseconds !== "string" || !/^\d+$/.test(binding.ttlMilliseconds)) invalid("KV declaration has invalid source TTL"); break;
    case "service": checkServiceBinding(binding); break;
    case "analytics-engine": checkAnalyticsBinding(binding); break;
    default: invalid("runtime binding kind is not supported by the local runtime");
  }
}

function checkQueueBinding(binding: Extract<ArtifactRuntimeBinding, { kind: "queue" }>): void {
  if (typeof binding.type !== "string" || !binding.type || !strings(binding.handlers)) invalid("queue declaration has invalid message type or handlers");
}

function checkServiceBinding(binding: Extract<ArtifactRuntimeBinding, { kind: "service" }>): void {
  if (typeof binding.from !== "string" || !binding.from || typeof binding.capability !== "string" || !binding.capability) invalid("service declaration has no implementation origin or capability");
}

function checkAnalyticsBinding(binding: Extract<ArtifactRuntimeBinding, { kind: "analytics-engine" }>): void {
  if (!Array.isArray(binding.schema) || binding.schema.some(field => !field || typeof field.name !== "string" || !field.name || typeof field.type !== "string" || !field.type) || new Set(binding.schema.map(field => field.name)).size !== binding.schema.length) invalid("analytics declaration has invalid schema");
}

function inventory(value: unknown): ArtifactRuntimeBinding[] {
  if (!Array.isArray(value)) invalid("runtime binding inventory must be an array");
  const seen = new Set<string>();
  for (const entry of value) checkBindingEntry(entry, seen);
  return value as ArtifactRuntimeBinding[];
}
export interface LocalBindingPlan {
  readonly app: string | null;
  readonly bindings: readonly ArtifactRuntimeBinding[];
  readonly requirements: readonly ResourceBindingRequirement[];
  readonly queueHandlers: readonly string[];
  /** Model-free effects still belong to their checked caller's State owner. */
  readonly noModelStorageMode?: "global" | "team";
}

function scanEntryExports(source: string): { definition: Map<string, Node> | undefined; exports: Map<string, Node> } {
  let parsed: Node;
  try { parsed = parse(source, { ecmaVersion: "latest", sourceType: "module" }) as unknown as Node; }
  catch { invalid("original compiled entry is not valid JavaScript"); }
  let definition: Map<string, Node> | undefined;
  const exports = new Map<string, Node>();
  for (const statement of parsed.body as unknown[]) {
    const exported = node(statement);
    if (exported.type !== "ExportNamedDeclaration" || exported.declaration === null) continue;
    const declaration = node(exported.declaration);
    if (declaration.type !== "VariableDeclaration") continue;
    for (const raw of declaration.declarations as unknown[]) {
      const binding = node(raw), id = node(binding.id);
      if (id.type !== "Identifier" || typeof id.name !== "string") continue;
      if (binding.init !== null) exports.set(id.name, node(binding.init));
      if (id.name !== "appDefinition") continue;
      if (definition !== undefined || declaration.kind !== "const") invalid("compiled entry must export one constant appDefinition");
      definition = properties(binding.init);
    }
  }
  return { definition, exports };
}

function resolveBindingOwners(definition: Map<string, Node>, app: string, entryApp: string): { selectedDefinition: Map<string, Node>; owners: unknown } {
  let selectedDefinition = definition;
  let ownersNode = definition.get("runtimeBindingOwners");
  if (app !== entryApp) {
    const compositions = definition.get("compositions");
    const selected = compositions === undefined ? undefined : properties(compositions).get(app);
    if (selected === undefined) invalid(`compiled app composition ${app} is absent`);
    selectedDefinition = properties(selected);
    ownersNode = selectedDefinition.get("runtimeBindingOwners");
  }
  return { selectedDefinition, owners: ownersNode === undefined ? undefined : literal(ownersNode) };
}

function checkQueueHandlerBinding(artifact: CompileArtifact, definition: Map<string, Node>, exports: Map<string, Node>,
  queueBinding: string, queueType: string, handler: string): void {
  const reference = (artifact.callables ?? []).filter(callable => callable.id === handler);
  if (reference.length !== 1 || reference[0]!.kind !== "handler" || reference[0]!.module !== artifact.modules[0]!.path ||
      reference[0]!.member.length !== 1 || reference[0]!.member[0] !== handler || !exports.has(reference[0]!.export) ||
      literal(exports.get(reference[0]!.export)!) !== handler) invalid(`queue handler ${handler} has no matching compiled callable reference`);
  checkQueueHandlerDeclaration(definition, queueBinding, queueType, handler);
}

function checkQueueHandlerDeclaration(definition: Map<string, Node>, queueBinding: string, queueType: string, handler: string): void {
  const operations = definition.get("operations"), events = definition.get("events");
  const operation = operations === undefined ? undefined : properties(operations).get(handler);
  const event = events === undefined ? undefined : properties(events).get(queueBinding);
  if (operation === undefined || event === undefined) invalid(`queue handler ${handler} has no original invocation/event declaration`);
  const metadata = properties(operation), eventInputs = properties(event).get("inputs");
  const invocation = metadata.get("invocation");
  const target = invocation === undefined ? undefined : literal(invocation) as {name?:unknown;kind?:unknown;inputs?:{fields?:Array<{name?:unknown;valueType?:unknown;required?:unknown}>}};
  const value = eventInputs === undefined ? undefined : properties(eventInputs).get("value");
  const declaredType = value === undefined ? undefined : properties(value).get("type");
  if (!queueInvocationMatches(metadata, target, declaredType, handler, queueBinding, queueType)) invalid(`queue handler ${handler} disagrees with its source queue and invocation schema`);
}

function queueInvocationMatches(metadata: Map<string, Node>,
  target: { name?: unknown; kind?: unknown; inputs?: { fields?: Array<{ name?: unknown; valueType?: unknown; required?: unknown }> } } | undefined,
  declaredType: Node | undefined, handler: string, queueBinding: string, queueType: string): boolean {
  return metadata.has("handler") && literal(metadata.get("handler")!) === handler && metadata.has("event") && literal(metadata.get("event")!) === queueBinding &&
      metadata.has("read") && literal(metadata.get("read")!) === false && target?.name === handler && target.kind === "scenario" &&
      target.inputs?.fields?.length === 1 && target.inputs.fields[0]!.name === "value" && target.inputs.fields[0]!.valueType === queueType &&
      target.inputs.fields[0]!.required === true && declaredType !== undefined && literal(declaredType) === queueType;
}

function collectOperationStorageMode(policies: Map<string, Node>, owners: string[],
  operation: NonNullable<CompileArtifact["operations"]>[number], modes: Set<"global" | "team">): void {
  if (!owners.some(owner => operation.name.startsWith(`${owner}.`))) return;
  const original = policies.get(operation.name), metadata = original === undefined ? undefined : properties(original);
  const by = metadata?.get("by"), selectors = by === undefined ? [] : literal(by);
  if (!Array.isArray(selectors) || selectors.length === 0 ||
      selectors.some(selector => typeof selector !== "string" || selector.length === 0) ||
      [metadata?.get("gated"), metadata?.get("when")].some(value => value !== undefined && literal(value) === true)) {
    throw new LocalBindingAdmissionError("MODEL_FREE_OWNER_PROFILE_UNSUPPORTED", "model-free preview requires explicit ordinary caller selectors");
  }
  for (const selector of selectors) modes.add(selector === "public" || selector === "authenticated" ? "global" : "team");
}

function resolveNoModelStorageMode(artifact: CompileArtifact, selectedDefinition: Map<string, Node>,
  owners: string[], bindings: readonly ArtifactRuntimeBinding[]): "global" | "team" | undefined {
  if (artifact.models?.length !== 0 || bindings.length === 0 || (artifact.operations?.length ?? 0) === 0) return undefined;
  const policy = selectedDefinition.get("policy");
  const operations = policy === undefined ? undefined : properties(policy).get("operations");
  if (operations === undefined) invalid("model-free resources require their original operation policy");
  const policies = properties(operations), modes = new Set<"global" | "team">();
  for (const operation of artifact.operations ?? []) {
    collectOperationStorageMode(policies, owners, operation, modes);
  }
  if (modes.size > 1) throw new LocalBindingAdmissionError("MIXED_OWNER_PROFILE_UNSUPPORTED", "mixed app/team model-free preview requires an owning operation storage-selection API");
  if (modes.has("global")) throw new LocalBindingAdmissionError("MODEL_FREE_OWNER_PROFILE_UNSUPPORTED", "model-free public/authenticated resources require an explicit global State owner-selection API; use the supported team-owned profile or an app-scoped model");
  return modes.has("team") ? "team" : "global";
}

/** Read the compiler's complete inventory and exact selected owner closure. */
export function planLocalBindings(artifact: CompileArtifact, selectedApp?: string): LocalBindingPlan {
  const declared = artifact.runtimeBindings;
  const source = artifact.modules?.[0]?.js;
  if (source === undefined) {
    if (declared === undefined) return { app: null, bindings: [], requirements: [], queueHandlers: [] };
    invalid("runtime binding inventory requires the original compiled entry module");
  }
  const { definition, exports } = scanEntryExports(source);
  if (definition === undefined || !definition.has("runtimeBindings")) {
    if (declared === undefined) return { app: null, bindings: [], requirements: [], queueHandlers: [] };
    invalid("compiled entry runtime binding inventory is missing");
  }
  const full = inventory(declared ?? []), emitted = inventory(literal(definition.get("runtimeBindings")!));
  if (canonical(full) !== canonical(emitted)) invalid("artifact runtime binding inventory disagrees with original compiled entry");
  const entryApp = definition.has("id") ? literal(definition.get("id")!) : undefined;
  if (typeof entryApp !== "string" || !entryApp) invalid("compiled entry has no app identity");
  const app = selectedApp ?? entryApp;
  const { selectedDefinition, owners } = resolveBindingOwners(definition, app, entryApp);
  if (!strings(owners) || !owners.includes(app)) invalid("compiled app runtime owner closure is missing or invalid");
  const selected = full.filter(binding => owners.includes(binding.owner));
  const bindings = selected.filter((binding, index) => binding.kind !== "r2" || selected.findIndex(candidate => candidate.kind === "r2") === index);
  if (new Set(bindings.map(binding => binding.binding)).size !== bindings.length) invalid("selected runtime bindings alias the same environment key");
  const queueHandlers: string[] = [];
  for (const queue of bindings.filter(binding => binding.kind === "queue")) {
    for (const handler of queue.handlers) {
      checkQueueHandlerBinding(artifact, definition, exports, queue.binding, queue.type, handler);
      queueHandlers.push(handler);
    }
  }
  const noModelStorageMode = resolveNoModelStorageMode(artifact, selectedDefinition, owners, bindings);
  return { app, bindings: structuredClone(bindings), queueHandlers,
    ...(noModelStorageMode === undefined ? {} : { noModelStorageMode }),
    requirements: bindings.map(binding => ({ binding: binding.binding, kind: binding.kind, logicalName: binding.binding })) };
}

export interface LocalBindingImplementations {
  /** Trusted real dependency workers keyed by the authored service origin. */
  readonly services?: Readonly<Record<string, LocalWorkerOptions>>;
  /** Actual class exports supplied by the root-authority producer. */
  readonly durableObjects?: Readonly<Record<string, { className: string; scriptName?: string }>>;
}
export interface LocalBindingConfiguration {
  readonly worker: Partial<LocalDevOptions>;
  readonly resources: EnvironmentSelection["resources"];
}
function resourceId(binding: string): string { return `can-local-${createHash("sha256").update(binding).digest("hex").slice(0, 24)}`; }

function configureBindingWorker(worker: Partial<LocalDevOptions>, binding: ArtifactRuntimeBinding, persistence: string,
  implementations: LocalBindingImplementations, preflight: boolean, companions: Map<string, LocalWorkerOptions>,
  queueBindings: Record<string, string>): string {
  let id = resourceId(binding.binding);
  switch (binding.kind) {
    case "r2": worker.r2Buckets = [...(worker.r2Buckets ?? []), { binding: binding.binding, id }]; worker.r2Persist = join(persistence, "r2"); break;
    case "kv": worker.kvNamespaces = [...(worker.kvNamespaces ?? []), { binding: binding.binding, id }]; worker.kvPersist = join(persistence, "kv"); break;
    case "analytics-engine": worker.analyticsEngineDatasets = [...(worker.analyticsEngineDatasets ?? []), { binding: binding.binding, dataset: id }]; worker.analyticsEnginePersist = join(persistence, "analytics"); break;
    case "queue":
      worker.queueProducers = { ...worker.queueProducers, [binding.binding]: id };
      if (binding.handlers.length > 0 && !preflight) worker.queueConsumers = { ...worker.queueConsumers, [id]: { maxBatchSize: 1, maxBatchTimeout: 0 } };
      queueBindings[id] = binding.binding;
      break;
    case "durable-object": {
      if (!preflight) {
        const implementation = implementations.durableObjects?.[binding.binding] ?? { className: "CanRootAuthority" };
        worker.durableObjects = [...(worker.durableObjects ?? []), { binding: binding.binding, ...implementation, useSQLite: true }];
        worker.durableObjectsPersist = join(persistence, "durable-objects");
      }
      break;
    }
    case "service": {
      const implementation = implementations.services?.[binding.from];
      if (implementation === undefined) throw new LocalBindingAdmissionError("SERVICE_IMPLEMENTATION_UNAVAILABLE", `service ${binding.binding} requires the real implementation of ${binding.from}`);
      const prior = companions.get(implementation.workerName);
      if (prior !== undefined && prior !== implementation) invalid("different local service implementations share a worker name");
      companions.set(implementation.workerName, implementation);
      worker.serviceBindings = { ...worker.serviceBindings, [binding.binding]: implementation.workerName };
      id = implementation.workerName;
      break;
    }
  }
  return id;
}

/** Private paths and resource IDs are derived; no second user manifest exists. */
export function configureLocalBindings(plan: LocalBindingPlan, persistence: string, implementations: LocalBindingImplementations = {}, preflight = false): LocalBindingConfiguration {
  const worker: Partial<LocalDevOptions> = {};
  const companions = new Map<string, LocalWorkerOptions>();
  const resources: Array<EnvironmentSelection["resources"][number]> = [];
  const queueBindings: Record<string, string> = {};
  for (const binding of plan.bindings) {
    const id = configureBindingWorker(worker, binding, persistence, implementations, preflight, companions, queueBindings);
    resources.push({ requirement: { binding: binding.binding, kind: binding.kind, logicalName: binding.binding }, resourceId: id });
  }
  if (companions.size > 0) worker.companionWorkers = [...companions.values()];
  if (Object.keys(queueBindings).length > 0) worker.vars = { CAN_LOCAL_QUEUE_BINDINGS: queueBindings };
  return { worker, resources };
}

/** Exercise the actual R2 producer before the protected preview is offered. */
export async function probeLocalR2(dev: LocalDev, plan: LocalBindingPlan): Promise<void> {
  for (const binding of plan.bindings.filter(binding => binding.kind === "r2")) {
    const bucket = await dev.getR2Bucket(binding.binding), key = `.can-preview-probe/${randomUUID()}`, value = randomUUID();
    let failure: unknown;
    try {
      await bucket.put(key, value);
      if (await (await bucket.get(key))?.text() !== value) throw new Error("R2 did not retain exact probe bytes");
    } catch (error) { failure = error; }
    try { await bucket.delete(key); } catch (error) { failure ??= error; }
    if (failure !== undefined) throw new LocalBindingAdmissionError("R2_UNAVAILABLE", `local bucket ${binding.binding} failed its private put/get/delete probe: ${String(failure)}`);
    if (await bucket.get(key) !== null) throw new LocalBindingAdmissionError("R2_UNAVAILABLE", `local bucket ${binding.binding} did not delete its private probe`);
  }
}
