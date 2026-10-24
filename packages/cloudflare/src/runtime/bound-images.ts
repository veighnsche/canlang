/** Native installed Images composition; Work and Files own durable boundaries. */
import { STD_IMAGES_V1_VERSION, deliveryResultLeaves } from '@canlang/contracts';
import type { GeneratedImage, ImageRequest, ImageRun, OutboxIntent, ProviderBinding,
  ReceiptResultContext, WorkflowDefinition, RetainedFinalizedFile, CanValue } from '@canlang/contracts';
import type { InstalledImages, InstalledImageOptions, ResolveInstalledImages } from '@canlang/services';
import { readFinalizedFileObservation } from '@canlang/files/finalize';
import type { FrameworkFilePayloadOriginInput } from '@canlang/state/storage';
import type { ProviderOutputOutcome } from '@canlang/files/finalize';
import { deriveOutboxId } from '@canlang/work/intent';
import type { DispatchImageCorrelation } from '@canlang/work/kernel/tables';
import { decodeValue, encodeValue, normalizeSchema, validateOperationInput, validateValue } from '@canlang/values';
import type { SchemaDescriptor } from '@canlang/values';
import { stableStringify } from '@canlang/state/invocation';
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

type FinalizeOutputInput = { readonly intent: OutboxIntent; readonly output: GeneratedImage;
  readonly resultPath: string; readonly originalScope?: { readonly app: string; readonly owner: string; readonly principal: string } };
type OutputFiles = FrameworkFilePayloadOriginInput['files'];

export interface BoundImagesOptions {
  readonly appDefinition: unknown;
  readonly binding: ProviderBinding;
  readonly resolveInstalledImages: ResolveInstalledImages;
  /** Genuine retained SEND-input File consumer; no authority comes from ref alone. */
  readonly readWorkflowGraph?: (intent: OutboxIntent, ref: string) => Promise<Uint8Array | null>;
  /** Actual owning Files finalization, inside its durable byte/metadata transaction. */
  readonly finalizeOutput: (input: FinalizeOutputInput) => Promise<ProviderOutputOutcome>;
  /** Trusted host pair with finalizeOutput. Uses its SAME actual receiver and
   * explicit retention; technical actor-null dispatch supplies no new grant. */
  readonly observeOutput?: (input: FinalizeOutputInput, outcome: Extract<ProviderOutputOutcome,
    { readonly status: 'finalized' | 'repeated' }>) => Promise<unknown | null>;
  readonly revalidateOutput?: (saved: RetainedFinalizedFile) => Promise<boolean>;
}

export interface BoundImagesCallOptions {
  /** Original committed work.dispatch row.created; never a new attempt timestamp. */
  readonly stagedAtMs: number;
  /** Must durably commit this queued snapshot before provider transport. */
  readonly onQueued: (progress: ImageRunWire) => Promise<void>;
  readonly onProgress: (progress: ImageRunWire, files?: OutputFiles) => Promise<void>;
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
  revalidateOutput?(observation: unknown): Promise<boolean>;
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

type FinalizedOutput = Extract<ProviderOutputOutcome, { readonly status: 'finalized' | 'repeated' }>;

export function createBoundImagesAdapter(options: BoundImagesOptions): BoundImagesAdapter {
  const expected = Object.freeze({ ...options.binding });
  const finalizeOutput = options.finalizeOutput, observeOutput = options.observeOutput, revalidateOutput = options.revalidateOutput;
  const readWorkflowGraph = options.readWorkflowGraph;
  const resolveInstalledImages = options.resolveInstalledImages;
  const issued = new WeakSet<object>();
  const originalOutputPorts = (): boolean => options.finalizeOutput === finalizeOutput && options.observeOutput === observeOutput &&
    options.revalidateOutput === revalidateOutput;
  const readControlDeclaration = (intent: OutboxIntent, bindingName: string) => {
    const app = member(options.appDefinition, 'id');
    const binding = member(member(options.appDefinition, 'bindings'), bindingName);
    const capability = member(member(options.appDefinition, 'capabilities'), CAPABILITY);
    const version = member(capability, 'version');
    const operation = member(member(capability, 'operations'), intent.target.slice(`${CAPABILITY}.`.length));
    const inputs = member(operation, 'inputs');
    const contracts = member(options.appDefinition, 'contracts');
    const enums = member(options.appDefinition, 'enums') ?? {};
    const leaves = deliveryResultLeaves('ImageRun');
    const fields = member(member(contracts, 'ImageRun'), 'fields');
    return { app, binding, capability, version, operation, inputs, contracts, enums, leaves, fields };
  };
  const checkControlIdentity = (
    intent: OutboxIntent, carrier: OutboxIntent['arguments'], reads: ReturnType<typeof readControlDeclaration>,
  ): boolean => {
    if (typeof reads.app !== 'string' || reads.app === '' ||
        member(member(options.appDefinition, 'operations'), intent.operation) === undefined ||
        member(reads.binding, 'capability') !== CAPABILITY || member(reads.binding, 'from') !== carrier.from ||
        expected.capability !== CAPABILITY || expected.capabilityVersion !== STD_IMAGES_V1_VERSION ||
        expected.account === '' || expected.deployment === '' ||
        (reads.version !== STD_IMAGES_V1_VERSION && reads.version !== BigInt(STD_IMAGES_V1_VERSION))) return false;
    return true;
  };
  const checkControlShape = (reads: ReturnType<typeof readControlDeclaration>): boolean => {
    if (member(member(reads.operation, 'result'), 'type') !== 'ImageRun' || !record(reads.inputs) ||
        Object.keys(reads.inputs).length !== 2 || member(member(reads.inputs, 'source'), 'type') !== 'text' ||
        member(member(reads.inputs, 'revision'), 'type') !== 'int' || !record(reads.contracts) || !record(reads.enums) ||
        reads.leaves === null || !record(reads.fields) || Object.keys(reads.fields).length !== reads.leaves.length ||
        !reads.leaves.every(leaf => member(member(reads.fields, leaf.name), 'type') === leaf.type)) return false;
    return true;
  };
  const checkControlDeclaration = (
    intent: OutboxIntent, carrier: OutboxIntent['arguments'], reads: ReturnType<typeof readControlDeclaration>,
  ): boolean => checkControlIdentity(intent, carrier, reads) && checkControlShape(reads);
  const checkControlInstalled = (installed: ReturnType<ResolveInstalledImages>): boolean => {
    if (installed === null || installed.binding.deployment !== expected.deployment || installed.binding.account !== expected.account ||
        installed.binding.capability !== CAPABILITY || installed.binding.capabilityVersion !== expected.capabilityVersion ||
        !Number.isSafeInteger(installed.policy.maxObservationDurationMs) || installed.policy.maxObservationDurationMs <= 0 ||
        typeof installed.images.cancel !== 'function' || typeof installed.images.reconcile !== 'function') return false;
    return true;
  };
  const resolveControl = (intent: OutboxIntent) => {
    try {
      if (!['std.ImagesV1.cancel', 'std.ImagesV1.reconcile'].includes(intent.target) || intent.intentId === '' ||
          !closed(intent.arguments, ['binding', 'from', 'arguments'])) return null;
      const carrier = intent.arguments;
      if (typeof carrier.binding !== 'string' || carrier.from !== expected.deployment || !record(carrier.arguments)) return null;
      const reads = readControlDeclaration(intent, carrier.binding);
      if (!checkControlDeclaration(intent, carrier, reads)) return null;
      // Type narrowing only; all conditions were already rejected above.
      if (typeof reads.app !== 'string' || reads.leaves === null ||
          !record(reads.contracts) || !record(reads.inputs)) return null;
      const schema = normalizeSchema({ contracts: reads.contracts, enums: reads.enums,
        operations: { [intent.target]: { inputs: reads.inputs } } } as SchemaDescriptor);
      const checked = validateOperationInput(schema, intent.target, carrier.arguments);
      if (typeof checked.source !== 'string' || checked.source === '') return null;
      const revision = encodeValue('int', BigInt(safeInt(checked.revision, 0))) as string;
      const installed = options.resolveInstalledImages(expected.deployment);
      if (!checkControlInstalled(installed)) return null;
      return { app: reads.app, binding: carrier.binding, from: carrier.from,
        context: Object.freeze({ source: intent.target,
          declaredResult: Object.freeze({ name: 'ImageRun', fields: reads.leaves }),
          request: Object.freeze({ source: checked.source, revision }) }) satisfies ReceiptResultContext };
    } catch { return null; }
  };
  const readSubmitBinding = (bindingName: string) =>
    member(member(options.appDefinition, 'bindings'), bindingName);
  const checkSubmitBinding = (
    carrier: OutboxIntent['arguments'], declared: ReturnType<typeof readSubmitBinding>,
  ): boolean => {
    if (member(declared, 'capability') !== CAPABILITY || member(declared, 'from') !== carrier.from ||
        expected.capability !== CAPABILITY || expected.capabilityVersion !== STD_IMAGES_V1_VERSION ||
        expected.account === '' || expected.deployment === '') return false;
    return true;
  };
  const readSubmitCapability = () => {
    const capability = member(member(options.appDefinition, 'capabilities'), CAPABILITY);
    return { capability, version: member(capability, 'version') };
  };
  const checkSubmitVersion = (reads: ReturnType<typeof readSubmitCapability>): boolean =>
    reads.version === STD_IMAGES_V1_VERSION || reads.version === BigInt(STD_IMAGES_V1_VERSION);
  const readSubmitResult = (capability: unknown) => {
    const operation = member(member(capability, 'operations'), 'submit');
    return { operation, resultType: member(member(operation, 'result'), 'type') };
  };
  const checkSubmitResult = (reads: ReturnType<typeof readSubmitResult>): boolean => reads.resultType === 'ImageRun';
  const readSubmitDescriptor = (operation: unknown) => {
    const inputs = member(operation, 'inputs');
    const contracts = member(options.appDefinition, 'contracts');
    const enums = member(options.appDefinition, 'enums') ?? {};
    const leaves = deliveryResultLeaves('ImageRun');
    const fields = member(member(contracts, 'ImageRun'), 'fields');
    return { inputs, contracts, enums, leaves, fields };
  };
  const checkSubmitDescriptor = (reads: ReturnType<typeof readSubmitDescriptor>): boolean => {
    if (!record(reads.inputs) || !record(reads.contracts) || !record(reads.enums) || reads.leaves === null || !record(reads.fields) ||
        Object.keys(reads.fields).length !== reads.leaves.length ||
        !reads.leaves.every(leaf => member(member(reads.fields, leaf.name), 'type') === leaf.type)) return false;
    return true;
  };
  interface CheckedSubmitValue {
    readonly source: string;
    readonly validation: string;
    readonly prompt: string;
    readonly negative: string;
    readonly workflow: Record<string, unknown>;
    readonly max_duration: bigint;
    readonly revision: unknown;
    readonly width: unknown;
    readonly height: unknown;
    readonly max_outputs: unknown;
  }
  const readSubmitValue = (
    carrier: OutboxIntent['arguments'], contracts: Record<string, unknown>, enums: unknown,
    inputs: Record<string, unknown>,
  ): CheckedSubmitValue | null => {
    const schema = normalizeSchema({ contracts, enums,
      operations: { [TARGET]: { inputs } } } as SchemaDescriptor);
    const value = validateOperationInput(schema, TARGET, carrier.arguments)['value'];
    if (!record(value) || typeof value.source !== 'string' || value.source === '' ||
        typeof value.validation !== 'string' || typeof value.prompt !== 'string' || typeof value.negative !== 'string' ||
        !record(value.workflow) || typeof value.max_duration !== 'bigint' || value.max_duration <= 0n) return null;
    return value as unknown as CheckedSubmitValue;
  };
  const buildImageRequest = (value: CheckedSubmitValue): ImageRequest | null => {
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
    return {
      source: value.source, revision: safeInt(value.revision, 0),
      workflow: { graph: graph.id, prompt: destination('prompt'), negative: destination('negative'),
        width: destination('width'), height: destination('height') } satisfies WorkflowDefinition,
      validation: value.validation, prompt: value.prompt, negative: value.negative,
      width: safeInt(value.width, 1), height: safeInt(value.height, 1), max_outputs: safeInt(value.max_outputs, 1),
      max_duration: value.max_duration,
    };
  };
  const checkSubmitInstalled = (installed: ReturnType<ResolveInstalledImages>, input: ImageRequest): boolean => {
    if (installed === null || installed.binding.deployment !== expected.deployment ||
        installed.binding.capability !== CAPABILITY || installed.binding.capabilityVersion !== expected.capabilityVersion ||
        installed.binding.account !== expected.account || input.validation !== installed.validation ||
        input.workflow.graph !== installed.workflow.graph ||
        !(['prompt', 'negative', 'width', 'height'] as const).every(name =>
          input.workflow[name].node === installed.workflow[name].node && input.workflow[name].key === installed.workflow[name].key) ||
        input.max_outputs > installed.policy.maxOutputs || input.max_duration > BigInt(installed.policy.maxDurationMs) ||
        !Number.isSafeInteger(installed.policy.maxOutputBytes) || installed.policy.maxOutputBytes <= 0 ||
        typeof installed.images.submit !== 'function' || typeof installed.images.reconcile !== 'function' ||
        typeof installed.images.cancel !== 'function') return false;
    return true;
  };
  const resolve = (intent: OutboxIntent): Resolved | null => {
    try {
      if (intent.target !== TARGET || intent.intentId === '' || !closed(intent.arguments, ['binding', 'from', 'arguments'])) return null;
      const carrier = intent.arguments;
      if (typeof carrier.binding !== 'string' || carrier.from !== expected.deployment || !record(carrier.arguments)) return null;
      const declared = readSubmitBinding(carrier.binding);
      if (!checkSubmitBinding(carrier, declared)) return null;
      const capabilityReads = readSubmitCapability();
      if (!checkSubmitVersion(capabilityReads)) return null;
      const resultReads = readSubmitResult(capabilityReads.capability);
      if (!checkSubmitResult(resultReads)) return null;
      const descriptor = readSubmitDescriptor(resultReads.operation);
      if (!checkSubmitDescriptor(descriptor)) return null;
      // Type narrowing only; all three conditions were already rejected above.
      if (!record(descriptor.contracts) || !record(descriptor.inputs) || descriptor.leaves === null) return null;
      const value = readSubmitValue(carrier, descriptor.contracts, descriptor.enums, descriptor.inputs);
      if (value === null) return null;
      const input = buildImageRequest(value);
      if (input === null) return null;
      const installed = options.resolveInstalledImages(expected.deployment);
      if (installed === null || !checkSubmitInstalled(installed, input)) return null;
      return { installed, input, context: Object.freeze({ source: TARGET,
        declaredResult: Object.freeze({ name: 'ImageRun', fields: descriptor.leaves }),
        request: Object.freeze({ source: input.source, revision: encodeValue('int', BigInt(input.revision)) as string }) }) };
    } catch { return null; }
  };
  const resolveReview = (intent: OutboxIntent) => {
    try {
      const operationName = intent.target === `${CAPABILITY}.inspect` ? 'inspect'
        : intent.target === `${CAPABILITY}.validate` ? 'validate' : null;
      if (operationName === null || readWorkflowGraph === undefined || options.readWorkflowGraph !== readWorkflowGraph ||
          options.resolveInstalledImages !== resolveInstalledImages || intent.intentId === '' ||
          !closed(intent.arguments, ['binding', 'from', 'arguments'])) return null;
      const carrier = intent.arguments;
      if (typeof carrier.binding !== 'string' || carrier.from !== expected.deployment || !record(carrier.arguments) ||
          typeof member(options.appDefinition, 'id') !== 'string' || member(options.appDefinition, 'id') === '' ||
          member(member(options.appDefinition, 'operations'), intent.operation) === undefined ||
          !checkSubmitBinding(carrier, readSubmitBinding(carrier.binding))) return null;
      const capability = readSubmitCapability();
      if (!checkSubmitVersion(capability)) return null;
      const operation = member(member(capability.capability, 'operations'), operationName);
      const resultName = operationName === 'inspect' ? 'WorkflowInspection' : 'WorkflowValidation';
      if (member(member(operation, 'result'), 'type') !== resultName) return null;
      const inputs = member(operation, 'inputs'), contracts = member(options.appDefinition, 'contracts');
      const enums = member(options.appDefinition, 'enums') ?? {}, leaves = deliveryResultLeaves(resultName);
      const fields = member(member(contracts, resultName), 'fields');
      const inputName = operationName === 'inspect' ? 'graph' : 'value';
      if (!closed(inputs, [inputName]) || member(inputs[inputName], 'type') !== (operationName === 'inspect' ? 'file' : 'WorkflowDefinition') ||
          !record(contracts) || !record(enums) || leaves === null || !record(fields) || Object.keys(fields).length !== leaves.length ||
          !leaves.every(leaf => member(member(fields, leaf.name), 'type') === leaf.type)) return null;
      const schema = normalizeSchema({ contracts, enums, operations: { [intent.target]: { inputs } } } as SchemaDescriptor);
      const checked = validateOperationInput(schema, intent.target, carrier.arguments);
      const definition = operationName === 'validate' ? checked.value : null;
      const selected = encodeValue('file', (operationName === 'inspect' ? checked.graph : member(definition, 'graph')) as CanValue);
      if (!closed(selected, ['id']) || typeof selected.id !== 'string' || selected.id === '') return null;
      let workflow: WorkflowDefinition | null = null;
      if (operationName === 'validate') {
        if (!closed(definition, ['graph', 'prompt', 'negative', 'width', 'height'])) return null;
        const destination = (name: string) => {
          const value = definition[name];
          if (!closed(value, ['node', 'key']) || typeof value.node !== 'string' || typeof value.key !== 'string') throw new Error('Invalid workflow destination.');
          return Object.freeze({ node: value.node, key: value.key });
        };
        workflow = Object.freeze({ graph: selected.id, prompt: destination('prompt'), negative: destination('negative'),
          width: destination('width'), height: destination('height') });
      }
      const installed = resolveInstalledImages(expected.deployment), workflows = installed?.workflows;
      if (installed === null || workflows === undefined || installed.binding.capability !== CAPABILITY ||
          installed.binding.capabilityVersion !== expected.capabilityVersion || installed.binding.account !== expected.account ||
          installed.binding.deployment !== expected.deployment || typeof workflows.inspect !== 'function' ||
          typeof workflows.validate !== 'function' || typeof workflows.matchesGraph !== 'function' ||
          !Number.isSafeInteger(workflows.maxGraphBytes) || workflows.maxGraphBytes < 1) return null;
      return { installed, workflows, inspect: workflows.inspect, validate: workflows.validate, matchesGraph: workflows.matchesGraph,
        maxGraphBytes: workflows.maxGraphBytes, validation: installed.validation, operationName, ref: selected.id, workflow, schema, context: Object.freeze({ source: intent.target,
          declaredResult: Object.freeze({ name: resultName, fields: leaves }) }) satisfies ReceiptResultContext };
    } catch { return null; }
  };
  const review = async (intent: OutboxIntent): Promise<DispatchReconcileEvidence | null> => {
    const resolved = resolveReview(intent);
    if (resolved === null || readWorkflowGraph === undefined) return null;
    const original = stableStringify(intent);
    const current = (): boolean => {
      const next = resolveReview(intent);
      return stableStringify(intent) === original && next !== null && next.installed === resolved.installed &&
        next.workflows === resolved.workflows && next.inspect === resolved.inspect && next.validate === resolved.validate &&
        next.matchesGraph === resolved.matchesGraph && next.maxGraphBytes === resolved.maxGraphBytes &&
        next.validation === resolved.validation && next.ref === resolved.ref &&
        stableStringify(next.workflow) === stableStringify(resolved.workflow) &&
        stableStringify(next.context) === stableStringify(resolved.context) && stableStringify(next.schema) === stableStringify(resolved.schema);
    };
    const bytes = await readWorkflowGraph(intent, resolved.ref);
    if (!current()) return null;
    if (bytes === null || bytes.byteLength > resolved.maxGraphBytes || !resolved.matchesGraph.call(resolved.workflows, bytes)) return {
      kind: 'failed', code: 'workflow_unavailable', message: 'Workflow graph is unavailable or differs from its reviewed installation.' };
    if (!current()) return null;
    const completion = resolved.operationName === 'inspect'
      ? await resolved.inspect.call(resolved.workflows, resolved.ref, { deliveryId: intent.intentId })
      : await resolved.validate.call(resolved.workflows, resolved.workflow!, { deliveryId: intent.intentId });
    if (!current() || completion.delivery_id !== intent.intentId) return null;
    if (completion.status === 'failed' && completion.result === null && closed(completion.error, ['code', 'message']) &&
        typeof completion.error.code === 'string' && typeof completion.error.message === 'string') {
      return { kind: 'failed', code: completion.error.code, message: completion.error.message };
    }
    if (completion.status !== 'succeeded' || completion.error !== null) return null;
    if (resolved.operationName === 'validate') {
      const result = completion.result;
      if (!closed(result, ['valid', 'digest', 'detail']) || typeof result.valid !== 'boolean' ||
          (result.valid ? result.digest !== resolved.validation : result.digest !== null)) return null;
    }
    const wire = encodeValue(resolved.context.declaredResult.name, completion.result as unknown as CanValue, undefined, resolved.schema);
    validateValue(resolved.schema, resolved.context.declaredResult.name, wire, 'create');
    return { kind: 'delivered', result: wire };
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
  const readRunCompletion = async (
    intent: OutboxIntent, resolved: Resolved, original: InstalledImageOptions, method: 'reconcile' | 'cancel',
  ): Promise<ImageRun | null> => {
    const completion = await resolved.installed.images[method](resolved.input, original);
    if (completion.delivery_id !== intent.intentId || completion.status !== 'succeeded' || completion.error !== null ||
        completion.result === null) return null;
    const run: ImageRun = completion.result;
    if (run.job !== original.jobId || !STATES.has(run.state) || !Array.isArray(run.outputs) ||
        run.outputs.length > resolved.input.max_outputs ||
        (run.detail !== null && typeof run.detail !== 'string')) return null;
    return run;
  };
  const totalRunBytes = (run: ImageRun, resolved: Resolved): number | null => {
    let totalBytes = 0;
    for (const output of run.outputs) {
      if (!(output.bytes instanceof Uint8Array)) return null;
      totalBytes += output.bytes.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > resolved.installed.policy.maxOutputBytes) return null;
    }
    return totalBytes;
  };
  const checkRunOutputShape = (
    output: ImageRun['outputs'][number], resolved: Resolved, slots: Set<string>,
  ): string | null => {
    if (typeof output.node !== 'string' || output.node === '' || !Number.isSafeInteger(output.position) || output.position < 0 ||
        !(output.bytes instanceof Uint8Array) || output.bytes.byteLength !== output.sizeBytes ||
        output.sizeBytes > resolved.installed.policy.maxOutputBytes) return null;
    const slot = `${output.node}/${output.position}`;
    if (slots.has(slot)) return null;
    slots.add(slot);
    return `outputs/${encodeURIComponent(output.node)}/${output.position}`;
  };
  const verifyFinalizedFile = (
    intent: OutboxIntent, resolved: Resolved, call: BoundImagesCallOptions,
    output: ImageRun['outputs'][number], resultPath: string, finalized: FinalizedOutput,
    file: FinalizedOutput['file'],
  ): boolean => {
    if (file.id !== finalized.result.file || file.provenance.kind !== 'request' ||
        file.provenance.adapter !== expected.deployment || file.provenance.deliveryId !== intent.intentId ||
        file.provenance.resultPath !== resultPath || file.sizeBytes !== output.bytes.byteLength) return false;
    if (call.originalScope !== undefined && (file.provenance.app !== call.originalScope.app ||
        file.provenance.owner !== call.originalScope.owner || file.provenance.principal !== call.originalScope.principal)) {
      return false;
    }
    return true;
  };
  const observeFinalizedOutput = async (
    finalization: FinalizeOutputInput, finalized: FinalizedOutput, file: FinalizedOutput['file'],
    outputs: ImageRunWire['outputs'][number][],
    files: { path: readonly (string | number)[]; observation: unknown }[],
  ): Promise<void> => {
    if (observeOutput === undefined) return;
    if (revalidateOutput === undefined || !originalOutputPorts()) throw new Error('Images output receiving port changed.');
    const observation = await observeOutput(finalization, finalized);
    const saved = readFinalizedFileObservation(observation);
    if (!originalOutputPorts() || saved === null || saved.ref !== file.id ||
        saved.contentType !== file.contentType || saved.sizeBytes !== file.sizeBytes ||
        saved.bytesDigest !== file.bytesDigest || stableStringify(saved.provenance) !== stableStringify(file.provenance)) {
      throw new Error('Images output requires its genuine original Files observation.');
    }
    issued.add(observation as object);
    files.push(Object.freeze({ path: Object.freeze(['outputs', outputs.length, 'image']), observation }));
  };
  const finalizeRunOutput = async (
    intent: OutboxIntent, resolved: Resolved, call: BoundImagesCallOptions,
    output: ImageRun['outputs'][number], slots: Set<string>,
    outputs: ImageRunWire['outputs'][number][],
    files: { path: readonly (string | number)[]; observation: unknown }[],
  ): Promise<boolean> => {
    const resultPath = checkRunOutputShape(output, resolved, slots);
    if (resultPath === null) return false;
    const finalization = Object.freeze({ intent, output, resultPath,
      ...(call.originalScope === undefined ? {} : { originalScope: call.originalScope }) });
    if (observeOutput !== undefined && !originalOutputPorts()) throw new Error('Images output receiving port changed.');
    const finalized = await finalizeOutput(finalization);
    if (finalized.status !== 'finalized' && finalized.status !== 'repeated') return false;
    const file = finalized.file;
    if (!verifyFinalizedFile(intent, resolved, call, output, resultPath, finalized, file)) return false;
    await observeFinalizedOutput(finalization, finalized, file, outputs, files);
    outputs.push({ position: encodeValue('int', BigInt(output.position)) as string,
      image: encodeValue('file', decodeValue('file', { id: finalized.result.file })) as { id: string } });
    return true;
  };
  const observe = async (intent: OutboxIntent, resolved: Resolved, original: InstalledImageOptions,
    call: BoundImagesCallOptions, method: 'reconcile' | 'cancel'): Promise<DispatchProviderOutcome> => {
    const run = await readRunCompletion(intent, resolved, original, method);
    if (run === null) return { kind: 'uncertain' };
    if (totalRunBytes(run, resolved) === null) return { kind: 'uncertain' };
    const outputs: ImageRunWire['outputs'][number][] = [];
    const files: { path: readonly (string | number)[]; observation: unknown }[] = [];
    const slots = new Set<string>();
    for (const output of run.outputs) {
      if (!await finalizeRunOutput(intent, resolved, call, output, slots, outputs, files)) return { kind: 'uncertain' };
    }
    const prior = call.sequence === undefined ? 0n : decodeValue('int', call.sequence);
    if (typeof prior !== 'bigint' || prior < 0n) return { kind: 'uncertain' };
    const progress: ImageRunWire = Object.freeze({ source: resolved.input.source,
      revision: resolved.context.request!.revision, sequence: encodeValue('int', prior + 1n) as string,
      state: run.state, outputs, charged_jobs: null, detail: run.detail });
    const status = run.state === 'queued' || run.state === 'running' ? 'pending' : run.state === 'unknown' ? 'unknown' : 'succeeded';
    if (!isImageRunReceiptPayload(status, progress, null, resolved.context)) return { kind: 'uncertain' };
    await call.onProgress(progress, Object.freeze(files));
    return status === 'succeeded' ? { kind: 'delivered', result: progress } : { kind: 'uncertain' };
  };
  return {
    ...(observeOutput === undefined ? {} : { revalidateOutput: async (observation: unknown): Promise<boolean> => {
      if (typeof observation !== 'object' || observation === null || !issued.has(observation) ||
          revalidateOutput === undefined || !originalOutputPorts()) return false;
      const saved = readFinalizedFileObservation(observation);
      return saved !== null && await revalidateOutput(saved) && originalOutputPorts();
    } }),
    available: intent => resolveReview(intent) !== null || resolve(intent) !== null || resolveControl(intent) !== null,
    resultContext: intent => resolveReview(intent)?.context ?? resolve(intent)?.context ?? resolveControl(intent)?.context ?? null,
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
      if (intent.target === `${CAPABILITY}.inspect` || intent.target === `${CAPABILITY}.validate`) {
        try {
          const outcome = await review(intent);
          return outcome?.kind === 'delivered' ? outcome : outcome?.kind === 'failed'
            ? { kind: 'failed', cause: { kind: 'permanent', code: outcome.code, message: outcome.message } } : { kind: 'uncertain' };
        } catch { return { kind: 'uncertain' }; }
      }
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
      if (intent.target === `${CAPABILITY}.inspect` || intent.target === `${CAPABILITY}.validate`) {
        try { return await review(intent); } catch { return null; }
      }
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
