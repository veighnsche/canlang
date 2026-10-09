/** Native installed Images composition; Work and Files own durable boundaries. */
import { STD_IMAGES_V1_VERSION, deliveryResultLeaves } from '@canlang/contracts';
import type { GeneratedImage, ImageRequest, ImageRun, OutboxIntent, ProviderBinding,
  ReceiptResultContext, WorkflowDefinition } from '@canlang/contracts';
import type { InstalledImages, InstalledImageOptions, ResolveInstalledImages } from '@canlang/services';
import type { ProviderOutputOutcome } from '@canlang/files/finalize';
import { deriveOutboxId } from '@canlang/work/intent';
import type { DispatchImageCorrelation } from '@canlang/work/kernel/tables';
import { decodeValue, encodeValue, normalizeSchema, validateOperationInput } from '@canlang/values';
import type { SchemaDescriptor } from '@canlang/values';
import { isImageRunReceiptPayload } from '@canlang/state/receipt/tables';
import type { DispatchProviderOutcome, DispatchReconcileEvidence } from './invoke.js';

const CAPABILITY = 'std.ImagesV1';
const TARGET = `${CAPABILITY}.submit`;
const STATES = new Set(['queued', 'running', 'succeeded', 'failed', 'unknown', 'cancelled']);

export interface ImageRunWire {
  readonly source: string;
  readonly revision: string;
  readonly sequence: string;
  readonly state: string;
  readonly outputs: readonly { readonly position: string; readonly image: { readonly id: string } }[];
  readonly charged_jobs: string | null;
  readonly detail: string | null;
}

export interface BoundImagesOptions {
  readonly appDefinition: unknown;
  readonly binding: ProviderBinding;
  readonly resolveInstalledImages: ResolveInstalledImages;
  /** Actual owning Files finalization, inside its durable byte/metadata transaction. */
  readonly finalizeOutput: (input: { readonly intent: OutboxIntent; readonly output: GeneratedImage;
    readonly resultPath: string; readonly originalScope?: { readonly app: string; readonly owner: string; readonly principal: string } }) => Promise<ProviderOutputOutcome>;
}

export interface BoundImagesCallOptions {
  /** Original committed work.dispatch row.created; never a new attempt timestamp. */
  readonly stagedAtMs: number;
  /** Must durably commit this queued snapshot before provider transport. */
  readonly onQueued: (progress: ImageRunWire) => Promise<void>;
  readonly onProgress: (progress: ImageRunWire) => Promise<void>;
  /** Latest retained receipt sequence, supplied by the owning fenced reader on recovery. */
  readonly sequence?: string;
  readonly originalScope?: { readonly app: string; readonly owner: string; readonly principal: string };
}

export interface BoundImagesControlCallOptions extends BoundImagesCallOptions {
  /** Original committed CONTROL row.created; never renewed by retry/recovery. */
  readonly observation: { readonly startedAtMs: number; readonly deadlineMs: number };
  readonly originalScope: { readonly app: string; readonly owner: string; readonly principal: string };
  /** Recovery observes the original job; it never blindly repeats cancellation. */
  readonly recovering?: boolean;
}

export interface BoundImagesAdapter {
  available(intent: OutboxIntent): boolean;
  resultContext(intent: OutboxIntent): ReceiptResultContext | null;
  callProvider(intent: OutboxIntent, options: BoundImagesCallOptions): Promise<DispatchProviderOutcome>;
  reconcile(intent: OutboxIntent, options: BoundImagesCallOptions): Promise<DispatchReconcileEvidence | null>;
  cancel(intent: OutboxIntent, options: BoundImagesCallOptions): Promise<DispatchProviderOutcome | null>;
  controlCorrelation(intent: OutboxIntent, owner: string): DispatchImageCorrelation | null;
  controlObservation(intent: OutboxIntent, startedAtMs: number): InstalledImageOptions['observation'] | null;
  observeControl(control: OutboxIntent, original: OutboxIntent, options: BoundImagesControlCallOptions): Promise<DispatchProviderOutcome>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function member(value: unknown, key: string): unknown {
  return record(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}
function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function safeInt(value: unknown, min: number): number {
  if (typeof value !== 'bigint' || value < BigInt(min) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Image request integer is outside the installed safe range.');
  }
  return Number(value);
}
interface Resolved {
  readonly installed: InstalledImages;
  readonly input: ImageRequest;
  readonly context: ReceiptResultContext;
}

export function createBoundImagesAdapter(options: BoundImagesOptions): BoundImagesAdapter {
  const expected = Object.freeze({ ...options.binding });
  const resolveControl = (intent: OutboxIntent) => {
    try {
      if (!['std.ImagesV1.cancel', 'std.ImagesV1.reconcile'].includes(intent.target) || intent.intentId === '' ||
          !closed(intent.arguments, ['binding', 'from', 'arguments'])) return null;
      const carrier = intent.arguments;
      if (typeof carrier.binding !== 'string' || carrier.from !== expected.deployment || !record(carrier.arguments)) return null;
      const app = member(options.appDefinition, 'id');
      const binding = member(member(options.appDefinition, 'bindings'), carrier.binding);
      const capability = member(member(options.appDefinition, 'capabilities'), CAPABILITY);
      const version = member(capability, 'version');
      const operation = member(member(capability, 'operations'), intent.target.slice(`${CAPABILITY}.`.length));
      const inputs = member(operation, 'inputs');
      const contracts = member(options.appDefinition, 'contracts');
      const enums = member(options.appDefinition, 'enums') ?? {};
      const leaves = deliveryResultLeaves('ImageRun');
      const fields = member(member(contracts, 'ImageRun'), 'fields');
      if (typeof app !== 'string' || app === '' ||
          member(member(options.appDefinition, 'operations'), intent.operation) === undefined ||
          member(binding, 'capability') !== CAPABILITY || member(binding, 'from') !== carrier.from ||
          expected.capability !== CAPABILITY || expected.capabilityVersion !== STD_IMAGES_V1_VERSION ||
          expected.account === '' || expected.deployment === '' ||
          (version !== STD_IMAGES_V1_VERSION && version !== BigInt(STD_IMAGES_V1_VERSION)) ||
          member(member(operation, 'result'), 'type') !== 'ImageRun' || !record(inputs) ||
          Object.keys(inputs).length !== 2 || member(member(inputs, 'source'), 'type') !== 'text' ||
          member(member(inputs, 'revision'), 'type') !== 'int' || !record(contracts) || !record(enums) ||
          leaves === null || !record(fields) || Object.keys(fields).length !== leaves.length ||
          !leaves.every(leaf => member(member(fields, leaf.name), 'type') === leaf.type)) return null;
      const schema = normalizeSchema({ contracts, enums, operations: { [intent.target]: { inputs } } } as SchemaDescriptor);
      const checked = validateOperationInput(schema, intent.target, carrier.arguments);
      if (typeof checked.source !== 'string' || checked.source === '') return null;
      const revision = encodeValue('int', BigInt(safeInt(checked.revision, 0))) as string;
      const installed = options.resolveInstalledImages(expected.deployment);
      if (installed === null || installed.binding.deployment !== expected.deployment || installed.binding.account !== expected.account ||
          installed.binding.capability !== CAPABILITY || installed.binding.capabilityVersion !== expected.capabilityVersion ||
          !Number.isSafeInteger(installed.policy.maxObservationDurationMs) || installed.policy.maxObservationDurationMs <= 0 ||
          typeof installed.images.cancel !== 'function' || typeof installed.images.reconcile !== 'function') return null;
      return { app, binding: carrier.binding, from: carrier.from,
        context: Object.freeze({ source: intent.target, declaredResult: Object.freeze({ name: 'ImageRun', fields: leaves }),
          request: Object.freeze({ source: checked.source, revision }) }) satisfies ReceiptResultContext };
    } catch { return null; }
  };
  const resolve = (intent: OutboxIntent): Resolved | null => {
    try {
      if (intent.target !== TARGET || intent.intentId === '' || !closed(intent.arguments, ['binding', 'from', 'arguments'])) return null;
      const carrier = intent.arguments;
      if (typeof carrier.binding !== 'string' || carrier.from !== expected.deployment || !record(carrier.arguments)) return null;
      const declared = member(member(options.appDefinition, 'bindings'), carrier.binding);
      if (member(declared, 'capability') !== CAPABILITY || member(declared, 'from') !== carrier.from ||
          expected.capability !== CAPABILITY || expected.capabilityVersion !== STD_IMAGES_V1_VERSION ||
          expected.account === '' || expected.deployment === '') return null;
      const capability = member(member(options.appDefinition, 'capabilities'), CAPABILITY);
      const version = member(capability, 'version');
      if (version !== STD_IMAGES_V1_VERSION && version !== BigInt(STD_IMAGES_V1_VERSION)) return null;
      const operation = member(member(capability, 'operations'), 'submit');
      if (member(member(operation, 'result'), 'type') !== 'ImageRun') return null;
      const inputs = member(operation, 'inputs');
      const contracts = member(options.appDefinition, 'contracts');
      const enums = member(options.appDefinition, 'enums') ?? {};
      const leaves = deliveryResultLeaves('ImageRun');
      const fields = member(member(contracts, 'ImageRun'), 'fields');
      if (!record(inputs) || !record(contracts) || !record(enums) || leaves === null || !record(fields) ||
          Object.keys(fields).length !== leaves.length ||
          !leaves.every(leaf => member(member(fields, leaf.name), 'type') === leaf.type)) return null;
      const schema = normalizeSchema({ contracts, enums, operations: { [TARGET]: { inputs } } } as SchemaDescriptor);
      const value = validateOperationInput(schema, TARGET, carrier.arguments)['value'];
      if (!record(value) || typeof value.source !== 'string' || value.source === '' ||
          typeof value.validation !== 'string' || typeof value.prompt !== 'string' || typeof value.negative !== 'string' ||
          !record(value.workflow) || typeof value.max_duration !== 'bigint' || value.max_duration <= 0n) return null;
      const workflow = value.workflow;
      const destination = (name: string) => {
        const slot = workflow[name];
        if (!closed(slot, ['node', 'key']) || typeof slot.node !== 'string' || typeof slot.key !== 'string') {
          throw new Error('Image workflow destination is malformed.');
        }
        return { node: slot.node, key: slot.key };
      };
      const graph = encodeValue('file', workflow.graph as Parameters<typeof encodeValue>[1]);
      if (!record(graph) || typeof graph.id !== 'string') return null;
      const input: ImageRequest = {
        source: value.source, revision: safeInt(value.revision, 0),
        workflow: { graph: graph.id, prompt: destination('prompt'), negative: destination('negative'),
          width: destination('width'), height: destination('height') } satisfies WorkflowDefinition,
        validation: value.validation, prompt: value.prompt, negative: value.negative,
        width: safeInt(value.width, 1), height: safeInt(value.height, 1), max_outputs: safeInt(value.max_outputs, 1),
        max_duration: value.max_duration,
      };
      const installed = options.resolveInstalledImages(expected.deployment);
      if (installed === null || installed.binding.deployment !== expected.deployment ||
          installed.binding.capability !== CAPABILITY || installed.binding.capabilityVersion !== expected.capabilityVersion ||
          installed.binding.account !== expected.account || input.validation !== installed.validation ||
          input.workflow.graph !== installed.workflow.graph ||
          !(['prompt', 'negative', 'width', 'height'] as const).every(name =>
            input.workflow[name].node === installed.workflow[name].node && input.workflow[name].key === installed.workflow[name].key) ||
          input.max_outputs > installed.policy.maxOutputs || input.max_duration > BigInt(installed.policy.maxDurationMs) ||
          !Number.isSafeInteger(installed.policy.maxOutputBytes) || installed.policy.maxOutputBytes <= 0 ||
          typeof installed.images.submit !== 'function' || typeof installed.images.reconcile !== 'function' ||
          typeof installed.images.cancel !== 'function') return null;
      return { installed, input, context: Object.freeze({ source: TARGET,
        declaredResult: Object.freeze({ name: 'ImageRun', fields: leaves }),
        request: Object.freeze({ source: input.source, revision: encodeValue('int', BigInt(input.revision)) as string }) }) };
    } catch { return null; }
  };
  const lifecycle = (intent: OutboxIntent, resolved: Resolved, call: BoundImagesCallOptions,
    retainedObservation?: InstalledImageOptions['observation']): InstalledImageOptions => {
    const duration = safeInt(resolved.input.max_duration, 1);
    const deadlineMs = call.stagedAtMs + duration;
    if (!Number.isSafeInteger(call.stagedAtMs) || call.stagedAtMs < 0 || !Number.isSafeInteger(deadlineMs) ||
        (retainedObservation === undefined && deadlineMs <= Date.now())) throw new Error('Original image request deadline is unavailable or expired.');
    let observation: InstalledImageOptions['observation'];
    if (retainedObservation !== undefined) {
      const { startedAtMs, deadlineMs: observationDeadline } = retainedObservation;
      if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 0 || startedAtMs > Date.now() ||
          !Number.isSafeInteger(observationDeadline) || observationDeadline <= Date.now() ||
          observationDeadline <= startedAtMs || observationDeadline - startedAtMs > resolved.installed.policy.maxObservationDurationMs) {
        throw new Error('Original image control observation window is unavailable or expired.');
      }
      observation = Object.freeze({ startedAtMs, deadlineMs: observationDeadline });
    }
    const hex = deriveOutboxId(intent.intentId, TARGET, 0).slice('obx_'.length, 'obx_'.length + 32);
    // UUIDv8 retains the pinned digest identity with RFC version/variant bits.
    const variant = ((parseInt(hex[16]!, 16) & 3) | 8).toString(16);
    const jobId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
    return { deliveryId: intent.intentId, jobId, deadlineMs, ...(observation === undefined ? {} : { observation }) };
  };
  const observe = async (intent: OutboxIntent, resolved: Resolved, original: InstalledImageOptions,
    call: BoundImagesCallOptions, method: 'reconcile' | 'cancel'): Promise<DispatchProviderOutcome> => {
    const completion = await resolved.installed.images[method](resolved.input, original);
    if (completion.delivery_id !== intent.intentId || completion.status !== 'succeeded' || completion.error !== null ||
        completion.result === null) return { kind: 'uncertain' };
    const run: ImageRun = completion.result;
    if (run.job !== original.jobId || !STATES.has(run.state) || !Array.isArray(run.outputs) ||
        run.outputs.length > resolved.input.max_outputs ||
        (run.detail !== null && typeof run.detail !== 'string')) return { kind: 'uncertain' };
    let totalBytes = 0;
    for (const output of run.outputs) {
      if (!(output.bytes instanceof Uint8Array)) return { kind: 'uncertain' };
      totalBytes += output.bytes.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > resolved.installed.policy.maxOutputBytes) {
        return { kind: 'uncertain' };
      }
    }
    const outputs: ImageRunWire['outputs'][number][] = [];
    const slots = new Set<string>();
    for (const output of run.outputs) {
      if (typeof output.node !== 'string' || output.node === '' || !Number.isSafeInteger(output.position) || output.position < 0 ||
          !(output.bytes instanceof Uint8Array) || output.bytes.byteLength !== output.sizeBytes ||
          output.sizeBytes > resolved.installed.policy.maxOutputBytes) return { kind: 'uncertain' };
      const slot = `${output.node}/${output.position}`;
      if (slots.has(slot)) return { kind: 'uncertain' };
      slots.add(slot);
      const resultPath = `outputs/${encodeURIComponent(output.node)}/${output.position}`;
      const finalized = await options.finalizeOutput({ intent, output, resultPath,
        ...(call.originalScope === undefined ? {} : { originalScope: call.originalScope }) });
      if (finalized.status !== 'finalized' && finalized.status !== 'repeated') return { kind: 'uncertain' };
      const file = finalized.file;
      if (file.id !== finalized.result.file || file.provenance.kind !== 'request' ||
          file.provenance.adapter !== expected.deployment || file.provenance.deliveryId !== intent.intentId ||
          file.provenance.resultPath !== resultPath || file.sizeBytes !== output.bytes.byteLength) return { kind: 'uncertain' };
      if (call.originalScope !== undefined && (file.provenance.app !== call.originalScope.app ||
          file.provenance.owner !== call.originalScope.owner || file.provenance.principal !== call.originalScope.principal)) {
        return { kind: 'uncertain' };
      }
      outputs.push({ position: encodeValue('int', BigInt(output.position)) as string,
        image: encodeValue('file', decodeValue('file', { id: finalized.result.file })) as { id: string } });
    }
    const prior = call.sequence === undefined ? 0n : decodeValue('int', call.sequence);
    if (typeof prior !== 'bigint' || prior < 0n) return { kind: 'uncertain' };
    const progress: ImageRunWire = Object.freeze({ source: resolved.input.source,
      revision: resolved.context.request!.revision, sequence: encodeValue('int', prior + 1n) as string,
      state: run.state, outputs, charged_jobs: null, detail: run.detail });
    const status = run.state === 'queued' || run.state === 'running' ? 'pending' : run.state === 'unknown' ? 'unknown' : 'succeeded';
    if (!isImageRunReceiptPayload(status, progress, null, resolved.context)) return { kind: 'uncertain' };
    await call.onProgress(progress);
    return status === 'succeeded' ? { kind: 'delivered', result: progress } : { kind: 'uncertain' };
  };
  return {
    available: intent => resolve(intent) !== null || resolveControl(intent) !== null,
    resultContext: intent => resolve(intent)?.context ?? resolveControl(intent)?.context ?? null,
    controlCorrelation(intent, owner) {
      const control = resolveControl(intent);
      if (control === null || typeof owner !== 'string' || owner === '') return null;
      return Object.freeze({ requestSource: control.context.request!.source, requestRevision: control.context.request!.revision,
        requestBinding: control.binding, requestFrom: control.from, requestApp: control.app, requestOwner: owner });
    },
    controlObservation(intent, startedAtMs) {
      if (resolveControl(intent) === null) return null;
      const installed = options.resolveInstalledImages(expected.deployment);
      const deadlineMs = startedAtMs + installed!.policy.maxObservationDurationMs;
      return Number.isSafeInteger(startedAtMs) && startedAtMs >= 0 && Number.isSafeInteger(deadlineMs)
        ? Object.freeze({ startedAtMs, deadlineMs }) : null;
    },
    async observeControl(control, original, call) {
      const invocation = resolveControl(control), resolved = resolve(original);
      if (invocation === null || resolved === null || control.intentId === original.intentId ||
          call.originalScope.app !== invocation.app || call.originalScope.owner === '' || call.originalScope.principal === '' ||
          invocation.context.request!.source !== resolved.context.request!.source ||
          invocation.context.request!.revision !== resolved.context.request!.revision ||
          control.arguments['binding'] !== original.arguments['binding'] ||
          control.arguments['from'] !== original.arguments['from']) return { kind: 'uncertain' };
      try {
        return await observe(original, resolved, lifecycle(original, resolved, call, call.observation), call,
          control.target === 'std.ImagesV1.cancel' && call.recovering !== true ? 'cancel' : 'reconcile');
      } catch { return { kind: 'uncertain' }; }
    },
    async callProvider(intent, call) {
      const resolved = resolve(intent);
      if (resolved === null) return { kind: 'uncertain' };
      try {
        const original = lifecycle(intent, resolved, call);
        const queued: ImageRunWire = Object.freeze({ source: resolved.input.source, revision: resolved.context.request!.revision,
          sequence: '0', state: 'queued', outputs: [], charged_jobs: null, detail: null });
        await call.onQueued(queued);
        const accepted = await resolved.installed.images.submit(resolved.input, original);
        if (accepted.delivery_id !== intent.intentId || accepted.status !== 'succeeded' || accepted.error !== null ||
            accepted.result?.job !== original.jobId) return { kind: 'uncertain' };
        return await observe(intent, resolved, original, call, 'reconcile');
      } catch { return { kind: 'uncertain' }; }
    },
    async reconcile(intent, call) {
      const resolved = resolve(intent);
      if (resolved === null) return null;
      try {
        const outcome = await observe(intent, resolved, lifecycle(intent, resolved, call), call, 'reconcile');
        return outcome.kind === 'delivered' ? outcome : null;
      } catch { return null; }
    },
    async cancel(intent, call) {
      const resolved = resolve(intent);
      if (resolved === null) return null;
      try { return await observe(intent, resolved, lifecycle(intent, resolved, call), call, 'cancel'); }
      catch { return null; }
    },
  };
}
