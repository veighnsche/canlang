/** Target-only operations: Rust supplies authority, identities, origin and lifetime. */
import { projectBusinessRefusal, type FailureContext } from "./failure-occurrence.js";
import { PUBLIC_ERROR_MESSAGES, isBusinessErrorCode } from "@canlang/interfaces";
import { capturedRuntimeInputsAreCurrent } from "./source-capture.js";
import { runtimeConstruct } from "./runtime-host-construct.js";
import { serializeExampleRecipe, parseExampleRecipe, exampleProjections, exampleArtifactDigest } from "./runtime-host-examples.js";
import { parseArtifactText } from "../runtime/artifact.js";
import { DevCleanupError } from "./cleanup.js";
import { createInstalledLocalPreviewBuilder } from "./preview-host.js";
import { assertInstalledCatalog, installedBrowserQualificationInputs, installedLocalPreviewInputInventory } from "./preview-inputs.js";
import { loadInstalledExampleTestkit, runCompiledExamples } from "./example-runner.js";
import { createInstalledFirstProfileQualification, type FirstProfileConstructQualificationRequest } from "./first-profile-qualification.js";
import type { LocalPreviewBuilder, LocalPreviewWithActors } from "./preview-builder.js";
import type { PreviewRefusal } from "./preview-bridge.js";
import { parsePreviewRoles } from "./preview-roles.js";
import { consumeRuntimeFiles, parseRuntimeCapture, readRuntimeFile, runtimeObject, runtimeString, writeRuntimeFile,
  type RuntimeAllocation, type RuntimeRequest } from "./runtime-host-protocol.js";

interface Generation {
  id: string;
  allocation: RuntimeAllocation;
  controller: AbortController;
  pending?: Promise<unknown>;
  releasing?: Promise<{ released: boolean }>;
  dispose?: () => Promise<void>;
  builder?: LocalPreviewBuilder;
  preview?: LocalPreviewWithActors;
  capture?: ReturnType<typeof parseRuntimeCapture>;
  refusals: PreviewRefusal[];
  dropped: number;
  unavailable: number;
  unsubscribe?: () => void;
}
export class RuntimeTargets {
  private readonly generations = new Map<string, Generation>();
  private readonly operations = new Map<string, { controller: AbortController; generationId: string | null; done: Promise<void> }>();
  private preparing = false;
  private readonly held = new Map<string, { generationId: string | null; dispose: () => Promise<void> }>();
  private readonly qualify = createInstalledFirstProfileQualification();
  private qualificationJobs = 0;
  constructor(private readonly directory: string) {}
  allocation(id: string | null): RuntimeAllocation {
    if ([...this.held.values()].some(item => item.generationId === id)) return "release_failed";
    return id === null ? "none" : this.generations.get(id)?.allocation ?? "none";
  }
  async execute(request: RuntimeRequest): Promise<unknown> {
    if (request.command === "cancel") return this.cancel(request);
    if (request.command === "release" || request.command === "retry") return this.retry(request);
    if (this.operations.has(request.operationId)) throw new Error("runtime operation is already active");
    const controller = new AbortController();
    let settled!: () => void;
    const done = new Promise<void>(resolve => { settled = resolve; });
    this.operations.set(request.operationId, { controller, generationId: request.generationId, done });
    try { return await this.dispatch(request, controller); }
    catch (error) {
      if (error instanceof DevCleanupError && request.command !== "prepare") {
        this.held.set(request.operationId, { generationId: request.generationId, dispose: error.dispose });
      }
      throw error;
    }
    finally { this.operations.delete(request.operationId); settled(); }
  }
  private async dispatch(request: RuntimeRequest, controller: AbortController): Promise<unknown> {
    switch (request.command) {
      case "inventory": return this.inventory(request.payload);
      case "consume": await consumeRuntimeFiles(this.directory, request.payload.files); return { consumed: true };
      case "prepare": return this.prepare(request, controller);
      case "probe": await this.ready(request).preview!.probeRuntime!(); return { readiness: true };
      case "actors": {
        if (request.payload.discloseLocalCredentials !== true) throw new Error("local actor disclosure must be explicit");
        return { actors: this.ready(request).preview!.issueLocalActors() };
      }
      case "examples": return this.examples(request, controller.signal);
      case "qualify": return this.qualification(request, controller.signal);
      case "construct": {
        const capture = parseRuntimeCapture(await readRuntimeFile(request.payload.capture));
        controller.signal.throwIfAborted();
        const result = await runtimeConstruct(capture, request.payload);
        controller.signal.throwIfAborted();
        return { construct: await writeRuntimeFile(this.directory, result) };
      }
      case "refusals": return this.refusals(this.generation(request), request.payload);
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
    if (this.preparing || this.held.size > 0 || this.generations.has(id) || [...this.generations.values()].some(item => item.allocation === "release_failed")) {
      throw new Error("runtime preparation requires released prior work");
    }
    this.boundGenerations();
    this.preparing = true;
    const generation: Generation = { id, allocation: "owned", controller, refusals: [], dropped: 0, unavailable: 0 };
    this.generations.set(id, generation);
    const pending = this.build(request, generation);
    generation.pending = pending;
    try { return await pending; }
    catch (error) {
      if (error instanceof DevCleanupError) { generation.dispose = error.dispose; generation.allocation = "release_failed"; }
      else if (generation.dispose !== undefined) {
        try { await generation.dispose(); await generation.builder?.dispose(); generation.allocation = "released"; }
        catch { generation.allocation = "release_failed"; }
      } else generation.allocation = "released";
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
    const recipe = await writeRuntimeFile(this.directory, serializeExampleRecipe(preview.exampleInput()));
    return { id: request.generationId, origin: preview.origin, backend: preview.runtimeBackend!(), readiness: true, recipe };
  }
  private observe(generation: Generation, event: PreviewRefusal): void {
    if (generation.refusals.length === 128) { generation.refusals.shift(); generation.dropped += 1; }
    if (!isBusinessErrorCode(event.error.code)) { generation.unavailable += 1; return; }
    generation.refusals.push({ requestId: event.requestId, status: event.status,
      error: { code: event.error.code, message: PUBLIC_ERROR_MESSAGES[event.error.code], ...(event.error.retryable === undefined ? {} : { retryable: event.error.retryable }) },
      ...(event.transport === undefined ? {} : { transport: event.transport }) });
  }
  private async refusals(generation: Generation, payload: Record<string, unknown>) {
    const context = runtimeObject(payload.context) as unknown as FailureContext;
    const projections = [];
    for (const event of generation.refusals) {
      try { projections.push(projectBusinessRefusal({ ...event, context, phase: "unknown" })); }
      catch { generation.unavailable += 1; }
    }
    const result = await writeRuntimeFile(this.directory, { projections, dropped: generation.dropped, unavailable: generation.unavailable });
    generation.refusals = []; generation.dropped = 0; generation.unavailable = 0;
    return { refusals: result };
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
  private async cancel(request: RuntimeRequest) {
    const operationId = runtimeString(request.payload.operationId), operation = this.operations.get(operationId);
    if (operation !== undefined && operation.generationId !== request.generationId) throw new Error("runtime cancellation generation mismatch");
        operation?.controller.abort();
    if (operation !== undefined) {
      const generation = request.generationId === null ? undefined : this.generations.get(request.generationId);
      if (generation !== undefined && generation.controller === operation.controller) await this.release(generation);
      await operation.done;
    }
    return { cancelled: operation !== undefined };
  }
  private async retry(request: RuntimeRequest) {
    const generation = request.generationId === null ? undefined : this.generations.get(request.generationId);
    if (generation !== undefined) await this.release(generation);
    for (const [id, item] of this.held) {
      if (item.generationId === request.generationId) { await item.dispose(); this.held.delete(id); }
    }
    return { released: true, ...(generation === undefined || request.payload.context === undefined ? {}
      : await this.refusals(generation, request.payload)) };
  }
  private release(generation: Generation): Promise<{ released: boolean }> {
    return generation.releasing ??= this.releaseGeneration(generation).catch(error => {
      delete generation.releasing;
      throw error;
    });
  }
  private async releaseGeneration(generation: Generation) {
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
      delete generation.builder; delete generation.unsubscribe;
      return { released: true };
    } catch (error) { generation.allocation = "release_failed"; throw error; }
  }
  private async examples(request: RuntimeRequest, signal: AbortSignal) {
    if (this.held.size > 0) throw new Error("example cleanup remains owned");
    const capture = parseRuntimeCapture(await readRuntimeFile(request.payload.capture));
    const recipe = parseExampleRecipe(JSON.parse((await readRuntimeFile(request.payload.recipe)).toString("utf8")));
    if (recipe.sourceRevision !== capture.sourceRevision) throw new Error("example recipe source differs from capture");
    const current = async () => {
      signal.throwIfAborted();
      if (!(await capturedRuntimeInputsAreCurrent(capture))) throw new Error("captured example runtime changed");
      signal.throwIfAborted();
    };
    await current();
    const testkit = await loadInstalledExampleTestkit(capture.root);
    await current();
    const selected = request.payload.selectedRow;
    const runId = runtimeString(request.payload.runId);
    const result = await runCompiledExamples({ ...recipe, testkit, signal, runId,
      ...(selected === undefined ? {} : { selectedRow: selected as { operation: string; rowIndex: number } }) });
    await current();
    const context = runtimeObject(request.payload.context) as unknown as FailureContext;
    if (context.sourceRevision !== capture.sourceRevision) throw new Error("example context source mismatch");
    return { report: await writeRuntimeFile(this.directory, { ...result, artifactDigest: exampleArtifactDigest(recipe),
      projections: exampleProjections(context, runId, result) }) };
  }
  private async qualification(request: RuntimeRequest, signal: AbortSignal) {
    if (this.held.size > 0) throw new Error("qualification cleanup remains owned");
    if (this.qualificationJobs >= 4) throw new Error("runtime qualification limit reached");
    this.qualificationJobs += 1;
    try {
      const payload = runtimeObject(JSON.parse((await readRuntimeFile(request.payload.request)).toString("utf8")));
      const capture = parseRuntimeCapture(await readRuntimeFile(request.payload.capture));
      const result = await this.qualify({ ...payload, capture } as unknown as FirstProfileConstructQualificationRequest, signal);
      return { qualification: await writeRuntimeFile(this.directory, result) };
    } finally { this.qualificationJobs -= 1; }
  }
  async close(): Promise<void> {
    for (const operation of this.operations.values()) operation.controller.abort();
    const results = await Promise.allSettled([...this.generations.values()].map(generation => this.release(generation)));
    await Promise.all([...this.operations.values()].map(operation => operation.done));
    for (const [id, item] of this.held) {
      try { await item.dispose(); this.held.delete(id); } catch { /* Retain uncertain ownership. */ }
    }
    if (this.held.size > 0 || results.some(result => result.status === "rejected")) throw new Error("runtime resources remain owned");
  }
}
