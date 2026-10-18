/** Target-only operations: Rust supplies authority, identities, origin and lifetime. */
import { parseArtifactText } from "../runtime/artifact.js";
import { DevCleanupError } from "./cleanup.js";
import { createInstalledLocalPreviewBuilder } from "./preview-host.js";
import { assertInstalledCatalog, installedBrowserQualificationInputs, installedLocalPreviewInputInventory } from "./preview-inputs.js";
import { loadInstalledExampleTestkit, runCompiledExamples } from "./example-runner.js";
import { createInstalledFirstProfileQualification } from "./first-profile-qualification.js";
import type { SessionConstructQualificationRequest } from "./session-service.js";
import type { LocalPreviewBuilder, LocalPreviewWithActors } from "./preview-builder.js";
import type { PreviewRefusal } from "./preview-bridge.js";
import { parsePreviewRoles } from "./preview-roles.js";
import { parseRuntimeCapture, readRuntimeFile, runtimeObject, runtimeString, writeRuntimeFile,
  type RuntimeAllocation, type RuntimeRequest } from "./runtime-host-protocol.js";

interface Generation {
  id: string;
  allocation: RuntimeAllocation;
  controller: AbortController;
  pending?: Promise<unknown>;
  dispose?: () => Promise<void>;
  builder?: LocalPreviewBuilder;
  preview?: LocalPreviewWithActors;
  capture?: ReturnType<typeof parseRuntimeCapture>;
  refusals: PreviewRefusal[];
  dropped: number;
  unsubscribe?: () => void;
}
export class RuntimeTargets {
  private readonly generations = new Map<string, Generation>();
  private readonly operations = new Map<string, { controller: AbortController; generationId: string | null; done: Promise<void> }>();
  private preparing = false;
  private readonly qualify = createInstalledFirstProfileQualification();
  private qualificationJobs = 0;
  constructor(private readonly directory: string) {}
  allocation(id: string | null): RuntimeAllocation { return id === null ? "none" : this.generations.get(id)?.allocation ?? "none"; }
  async execute(request: RuntimeRequest): Promise<unknown> {
    if (request.command === "cancel") return this.cancel(request);
    if (request.command === "release" || request.command === "retry") return this.release(this.generation(request));
    if (this.operations.has(request.operationId)) throw new Error("runtime operation is already active");
    const controller = new AbortController();
    let settled!: () => void;
    const done = new Promise<void>(resolve => { settled = resolve; });
    this.operations.set(request.operationId, { controller, generationId: request.generationId, done });
    try { return await this.dispatch(request, controller); }
    finally { this.operations.delete(request.operationId); settled(); }
  }
  private async dispatch(request: RuntimeRequest, controller: AbortController): Promise<unknown> {
    switch (request.command) {
      case "inventory": return this.inventory(request.payload);
      case "prepare": return this.prepare(request, controller);
      case "probe": await this.ready(request).preview!.probeRuntime!(); return { readiness: true };
      case "actors": return { actors: this.ready(request).preview!.issueLocalActors() };
      case "examples": return this.examples(request, controller.signal);
      case "qualify": return this.qualification(request, controller.signal);
      case "refusals": return this.refusals(this.ready(request));
      default: throw new Error("unsupported runtime command");
    }
  }
  private async inventory(payload: Record<string, unknown>) {
    const root = runtimeString(payload.root), compiler = runtimeString(payload.compilerPath);
    assertInstalledCatalog(root, runtimeString(payload.catalogPath));
    const inventory = installedLocalPreviewInputInventory(root, compiler);
    const browser = await installedBrowserQualificationInputs(root);
    return { inventory: await writeRuntimeFile(this.directory, { ...inventory,
      extraInputPaths: [...inventory.extraInputPaths, ...browser] }) };
  }
  private async prepare(request: RuntimeRequest, controller: AbortController): Promise<unknown> {
    const id = runtimeString(request.generationId);
    if (this.preparing || this.generations.has(id) || [...this.generations.values()].some(item => item.allocation === "release_failed")) {
      throw new Error("runtime preparation requires released prior work");
    }
    this.boundGenerations();
    this.preparing = true;
    const generation: Generation = { id, allocation: "owned", controller, refusals: [], dropped: 0 };
    this.generations.set(id, generation);
    const pending = this.build(request, generation);
    generation.pending = pending;
    try { return await pending; }
    catch (error) {
      if (error instanceof DevCleanupError) { generation.dispose = error.dispose; generation.allocation = "release_failed"; }
      else generation.allocation = "released";
      throw error;
    } finally { delete generation.pending; this.preparing = false; }
  }
  private boundGenerations(): void {
    if (this.generations.size < 128) return;
    for (const [id, generation] of this.generations) {
      if (generation.allocation === "released") this.generations.delete(id);
    }
    if (this.generations.size >= 128) throw new Error("runtime generation retention limit reached");
  }
  private async build(request: RuntimeRequest, generation: Generation) {
    const capture = parseRuntimeCapture(await readRuntimeFile(request.payload.capture));
    const artifactBytes = await readRuntimeFile(request.payload.artifact);
    if (artifactBytes.length > 16 * 1024 * 1024) throw new Error("runtime artifact exceeds limit");
    const artifact = parseArtifactText(artifactBytes.toString("utf8"), capture.compilerOperand).artifact;
    const roles = parsePreviewRoles(request.payload.previewRoles === undefined ? {} : runtimeObject(request.payload.previewRoles));
    const builder = createInstalledLocalPreviewBuilder(roles, {}, {
      externalOrigin: runtimeString(request.payload.origin),
      ...(request.payload.persistenceRoot === undefined ? {} : { persistenceRoot: runtimeString(request.payload.persistenceRoot) }),
      onAllocated: dispose => { generation.dispose = dispose; generation.allocation = "owned"; },
    });
    generation.builder = builder; generation.capture = capture;
    const preview = await builder(artifact, capture, artifactBytes, { signal: generation.controller.signal });
    generation.preview = preview; generation.dispose = () => preview.dispose(); generation.allocation = "owned";
    generation.unsubscribe = preview.observeRefusals?.(event => this.observe(generation, event)) ?? (() => {});
    return { id: request.generationId, origin: preview.origin, backend: preview.runtimeBackend!(), readiness: true };
  }
  private observe(generation: Generation, event: PreviewRefusal): void {
    if (generation.refusals.length === 128) { generation.refusals.shift(); generation.dropped += 1; }
    generation.refusals.push(event);
  }
  private refusals(generation: Generation) {
    const result = { events: generation.refusals.splice(0), dropped: generation.dropped, unavailable: 0 };
    generation.dropped = 0; return result;
  }
  private generation(request: RuntimeRequest): Generation {
    const generation = this.generations.get(runtimeString(request.generationId));
    if (generation === undefined) throw new Error("unknown runtime generation");
    return generation;
  }
  private ready(request: RuntimeRequest): Generation {
    const generation = this.generation(request);
    if (generation.allocation !== "owned" || generation.preview === undefined || generation.controller.signal.aborted) {
      throw new Error("runtime generation is unavailable");
    }
    return generation;
  }
  private cancel(request: RuntimeRequest) {
    const operationId = runtimeString(request.payload.operationId), operation = this.operations.get(operationId);
    if (operation !== undefined && operation.generationId !== request.generationId) throw new Error("runtime cancellation generation mismatch");
    operation?.controller.abort(); return { cancelled: operation !== undefined };
  }
  private async release(generation: Generation) {
    generation.controller.abort(); generation.builder?.beginStop(); generation.unsubscribe?.();
    const operations = [...this.operations.values()].filter(operation => operation.generationId === generation.id);
    for (const operation of operations) operation.controller.abort();
    try {
      // Release the runtime before joining work which may need its termination.
      await generation.dispose?.();
      await generation.pending?.catch(() => {});
      await Promise.all(operations.map(operation => operation.done));
      await generation.dispose?.();
      await generation.builder?.dispose();
      generation.allocation = "released";
      delete generation.preview; delete generation.dispose; delete generation.capture;
      delete generation.builder; delete generation.unsubscribe; generation.refusals = [];
      return { released: true };
    } catch (error) { generation.allocation = "release_failed"; throw error; }
  }
  private async examples(request: RuntimeRequest, signal: AbortSignal) {
    const generation = this.ready(request);
    const testkit = await loadInstalledExampleTestkit(generation.capture!.root);
    const selected = request.payload.selectedRow;
    const result = await runCompiledExamples({ ...generation.preview!.exampleInput(), testkit, signal,
      runId: runtimeString(request.payload.runId),
      ...(selected === undefined ? {} : { selectedRow: selected as { operation: string; rowIndex: number } }) });
    return { report: await writeRuntimeFile(this.directory, result) };
  }
  private async qualification(request: RuntimeRequest, signal: AbortSignal) {
    if (this.qualificationJobs >= 4) throw new Error("runtime qualification limit reached");
    this.qualificationJobs += 1;
    try {
      const payload = runtimeObject(JSON.parse((await readRuntimeFile(request.payload.request)).toString("utf8")));
      const generation = this.ready(request);
      const result = await this.qualify({ ...payload, capture: generation.capture } as unknown as SessionConstructQualificationRequest, signal);
      return { qualification: await writeRuntimeFile(this.directory, result) };
    } finally { this.qualificationJobs -= 1; }
  }
  async close(): Promise<void> {
    for (const operation of this.operations.values()) operation.controller.abort();
    const results = await Promise.allSettled([...this.generations.values()].map(generation => this.release(generation)));
    await Promise.all([...this.operations.values()].map(operation => operation.done));
    if (results.some(result => result.status === "rejected")) throw new Error("runtime resources remain owned");
  }
}
