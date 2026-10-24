/**
 * Workflow-node mapping: bind business image inputs onto a pinned
 * API-format graph (research: one selected workflow artifact plus one
 * map from business inputs to node inputs).
 *
 * Rules enforced here:
 * - The graph digest must equal the mapping's pinned digest, or the
 *   mapping has drifted (a workflow edit changing what a node means
 *   fails visibly instead of generating differently).
 * - Mapping destinations must name exactly the business input fields:
 *   unknown fields fail, and unmapped supplied fields fail (a prompt
 *   the user supplied is never silently dropped).
 * - Every destination must address an existing node/key holding a
 *   scalar of the same primitive kind; links, objects and kind
 *   changes fail visibly. Substitution preserves every other
 *   edge/setting as the same JSON value.
 * - Declared output nodes must exist; only their images are collected.
 *
 * This is adapter-owned typed configuration, not language syntax, and
 * not a side-effect-free publish validator for arbitrary graphs: it
 * validates one known mapping against one pinned graph at submit.
 */
import { createHash } from 'node:crypto';
import type {
  ApiGraph,
  ImageGenerateInput,
  WorkflowNodeMapping,
  WorkflowField,
  ProviderBinding,
} from '@canlang/contracts';

export class MappingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MappingValidationError';
  }
}

/** Business input fields, in stable order. */
const IMAGE_INPUT_FIELDS = [
  'prompt',
  'negative',
  'width',
  'height',
  'seed',
] as const;

type ImageInputField = (typeof IMAGE_INPUT_FIELDS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Canonical JSON with recursively sorted keys for digesting. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`,
    );
    return `{${entries.join(',')}}`;
  }
  const text = JSON.stringify(value) ?? 'null';
  return text;
}

/** Digest of immutable bytes for drift detection (`sha256:` hex). */
export function sha256Hex(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * Capture the admitted graph domain without reading accessor values or calling
 * toJSON. Shared data may repeat; cycles, executable properties and values
 * which JSON would omit/coerce are refused. This is not a sandbox for Proxy
 * traps or mutated host intrinsics.
 */
/**
 * Copy one own entry of a graph container into `result`. Array containers
 * accept only dense indexed data; every entry must be an enumerable own
 * data property.
 */
function copyGraphEntry(
  value: object,
  array: boolean,
  key: string | symbol,
  result: Record<string, unknown> | unknown[],
  copy: (value: unknown) => unknown,
): void {
  if (array && key === 'length') return;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (typeof key !== 'string' || descriptor === undefined ||
      !descriptor.enumerable || !('value' in descriptor)) {
    throw new MappingValidationError('Workflow graph requires enumerable own JSON data properties');
  }
  if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= (value as unknown[]).length)) {
    throw new MappingValidationError('Workflow graph arrays require only dense indexed data');
  }
  Object.defineProperty(result, key, {
    value: copy(descriptor.value), enumerable: true, writable: true, configurable: true,
  });
}

function copyGraphData(graph: ApiGraph): ApiGraph {
  const active = new Set<object>();
  const copy = (value: unknown): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || value === null || active.has(value)) {
      throw new MappingValidationError('Workflow graph requires finite, acyclic own JSON data');
    }
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new MappingValidationError('Workflow graph requires plain JSON objects and arrays');
    }
    const keys = Reflect.ownKeys(value);
    const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(prototype);
    active.add(value);
    try {
      let entries = 0;
      for (const key of keys) {
        if (array && key === 'length') continue;
        copyGraphEntry(value, array, key, result, copy);
        entries++;
      }
      if (array && entries !== (value as unknown[]).length) {
        throw new MappingValidationError('Workflow graph arrays must be dense');
      }
      return result;
    } finally {
      active.delete(value);
    }
  };
  if (!isRecord(graph)) throw new MappingValidationError('Workflow graph must be an object');
  return copy(graph) as ApiGraph;
}

/** Detached, deeply frozen own JSON graph for an immutable installation. */
export function snapshotGraph(graph: ApiGraph): ApiGraph {
  return freezeGraph(copyGraphData(graph));
}

/** Canonical digest of the admitted own JSON API-format graph. */
export function digestGraph(graph: ApiGraph): string {
  return sha256Hex(stableStringify(copyGraphData(graph)));
}

export interface SubstitutedGraph {
  /** Deep-frozen substituted graph, ready to submit. */
  readonly graph: ApiGraph;
  /** Digest of the unsubstituted pinned artifact. */
  readonly digest: string;
}

function freezeValue(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) freezeValue(entry);
  } else {
    for (const entry of Object.values(value)) freezeValue(entry);
  }
  Object.freeze(value);
}

function freezeGraph(graph: ApiGraph): ApiGraph {
  freezeValue(graph);
  return graph;
}

/**
 * Validate the mapping against the pinned graph and substitute the
 * business inputs. Returns the frozen substituted graph plus the
 * artifact digest; throws `MappingValidationError` naming the exact
 * breach. Pure: the input graph is never mutated.
 */
/** Copy the pinned graph and check the mapping shape/digest against it. */
function prepareSubstitutedGraph(
  graph: ApiGraph,
  mapping: WorkflowNodeMapping,
): { substituted: ApiGraph; digest: string } {
  if (!isRecord(graph)) {
    throw new MappingValidationError('Workflow graph must be an object');
  }
  if (typeof mapping !== 'object' || mapping === null) {
    throw new MappingValidationError('Workflow mapping must be an object');
  }
  if (
    typeof mapping.workflow !== 'string' ||
    mapping.workflow.length === 0
  ) {
    throw new MappingValidationError('Workflow mapping needs an artifact id');
  }
  const substituted = copyGraphData(graph);
  const digest = sha256Hex(stableStringify(substituted));
  if (mapping.graphDigest !== digest) {
    throw new MappingValidationError(
      `Workflow mapping for '${mapping.workflow}' was reviewed against ${mapping.graphDigest}; graph is ${digest}`,
    );
  }
  if (!isRecord(mapping.inputs)) {
    throw new MappingValidationError('Workflow mapping inputs must be an object');
  }
  const mappedFields = Object.keys(mapping.inputs).sort();
  const expectedFields = [...IMAGE_INPUT_FIELDS].sort();
  if (
    mappedFields.length !== expectedFields.length ||
    mappedFields.some((field, index) => field !== expectedFields[index])
  ) {
    throw new MappingValidationError(
      'Workflow mapping inputs must name exactly the business input fields',
    );
  }
  if (!Array.isArray(mapping.outputs) || mapping.outputs.length === 0) {
    throw new MappingValidationError(
      'Workflow mapping must declare at least one output node',
    );
  }
  for (const nodeId of mapping.outputs) {
    if (typeof nodeId !== 'string' || nodeId.length === 0) {
      throw new MappingValidationError('Output node ids must be non-empty strings');
    }
    if (!Object.hasOwn(substituted, nodeId) || !isRecord(substituted[nodeId])) {
      throw new MappingValidationError(
        `Output node '${nodeId}' does not exist in the graph`,
      );
    }
  }
  return { substituted, digest };
}

/** Read and range-check the business input values. */
function readImageInputValues(input: ImageGenerateInput): Record<ImageInputField, string | number> {
  if (typeof input !== 'object' || input === null) {
    throw new MappingValidationError('Image input must be an object');
  }
  const values: Record<ImageInputField, string | number> = {
    prompt: input.prompt,
    negative: input.negative,
    width: input.width,
    height: input.height,
    seed: input.seed,
  };
  if (typeof values.prompt !== 'string' || typeof values.negative !== 'string') {
    throw new MappingValidationError('Image prompt and negative must be strings');
  }
  for (const field of ['width', 'height'] as const) {
    if (!Number.isInteger(values[field]) || (values[field] as number) <= 0) {
      throw new MappingValidationError(
        `Image ${field} must be a positive integer`,
      );
    }
  }
  if (!Number.isInteger(values.seed) || (values.seed as number) < 0) {
    throw new MappingValidationError('Image seed must be a non-negative integer');
  }
  return values;
}

export function substituteAndValidate(
  graph: ApiGraph,
  mapping: WorkflowNodeMapping,
  input: ImageGenerateInput,
): SubstitutedGraph {
  const { substituted, digest } = prepareSubstitutedGraph(graph, mapping);
  const values = readImageInputValues(input);
  const usedDestinations = new Map<string, Set<string>>();
  for (const field of IMAGE_INPUT_FIELDS) {
    substituteField(substituted, mapping, field, values[field], usedDestinations);
  }
  return { graph: freezeGraph(substituted), digest };
}

/** Substitute one business input into its mapped graph destination. */
function substituteField(
  substituted: ApiGraph,
  mapping: WorkflowNodeMapping,
  field: ImageInputField,
  next: string | number,
  usedDestinations: Map<string, Set<string>>,
): void {
  const destination = mapping.inputs[field] as
    | { node: string; key: string }
    | undefined;
  const nodeId = destination === undefined ? undefined : destination.node;
  const key = typeof nodeId === 'string' ? destination!.key : undefined;
  if (
    typeof nodeId !== 'string' ||
    typeof key !== 'string'
  ) {
    throw new MappingValidationError(
      `Workflow mapping destination for '${field}' must name a node and key`,
    );
  }
  const node = substituted[nodeId];
  if (node === undefined || !isRecord(node.inputs)) {
    throw new MappingValidationError(
      `Workflow mapping destination node '${nodeId}' for '${field}' does not exist`,
    );
  }
  if (!(key in node.inputs)) {
    throw new MappingValidationError(
      `Workflow mapping destination '${nodeId}.${key}' for '${field}' does not exist`,
    );
  }
  const current = node.inputs[key];
  if (typeof current !== typeof next) {
    throw new MappingValidationError(
      `Workflow mapping destination '${nodeId}.${key}' holds ${Array.isArray(current) ? 'a link' : typeof current}; cannot substitute ${typeof next}`,
    );
  }
  if (typeof current !== 'string' && typeof current !== 'number') {
    throw new MappingValidationError(
      `Workflow mapping destination '${nodeId}.${key}' is not a scalar slot`,
    );
  }
  const usedKeys = usedDestinations.get(nodeId);
  if (usedKeys?.has(key)) {
    throw new MappingValidationError(
      `Workflow mapping destination '${nodeId}.${key}' for '${field}' is already used`,
    );
  }
  if (usedKeys === undefined) usedDestinations.set(nodeId, new Set([key]));
  else usedKeys.add(key);
  node.inputs[key] = next;
}

/** Deployment-reviewed whole-graph policy, never inferred from an uploaded graph.
 * Literal allowlists pin model/resource/settings values; only the five mapped
 * business inputs may vary. Links pin both their source and output slot. */
export type WorkflowInputPolicy =
  | { readonly kind: 'literal'; readonly values: readonly (string | number | boolean | null)[] }
  | { readonly kind: 'link'; readonly node: string; readonly output: number }
  | { readonly kind: 'text'; readonly label: string; readonly maxLength: number }
  | { readonly kind: 'integer'; readonly label: string; readonly min: number; readonly max: number };
export interface WorkflowGraphPolicy {
  readonly revision: string;
  readonly maxGraphBytes: number;
  readonly maxNodes: number;
  readonly nodes: Readonly<Record<string, { readonly classType: string; readonly inputs: Readonly<Record<string, WorkflowInputPolicy>> }>>;
  readonly outputs: readonly string[];
}

/** One immutable graph review shared by inspect, validate and actual submission.
 * This checks trusted adapter configuration; receiving File authority belongs
 * to the host. It performs no filesystem, network or generation operation. */
export function reviewWorkflowGraph(graph: ApiGraph, mapping: WorkflowNodeMapping,
  policy: WorkflowGraphPolicy, binding: ProviderBinding,
  limits: { readonly seed: number; readonly maxOutputs: number; readonly maxDurationMs: number; readonly maxOutputBytes: number; readonly maxObservationDurationMs: number; readonly maxBodyBytes: number }) {
  graph = snapshotGraph(graph);
  mapping = snapshotGraph(mapping as unknown as ApiGraph) as unknown as WorkflowNodeMapping;
  binding = snapshotGraph(binding as unknown as ApiGraph) as unknown as ProviderBinding;
  const approved = snapshotGraph(policy as unknown as ApiGraph) as unknown as WorkflowGraphPolicy;
  const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
    isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
  function refuse(): never { throw new MappingValidationError('Workflow does not satisfy its installed whole-graph policy'); }
  if (!exact(approved, ['revision', 'maxGraphBytes', 'maxNodes', 'nodes', 'outputs']) ||
      typeof approved.revision !== 'string' || approved.revision === '' || !positive(approved.maxGraphBytes) ||
      !positive(approved.maxNodes) || !isRecord(approved.nodes) || !Array.isArray(approved.outputs) ||
      new Set(approved.outputs).size !== approved.outputs.length ||
      stableStringify(approved.outputs) !== stableStringify(mapping.outputs)) refuse();
  const destinations = new Map<string, string>();
  for (const field of IMAGE_INPUT_FIELDS) {
    const destination = mapping.inputs[field];
    if (!destination) refuse();
    const key = JSON.stringify([destination.node, destination.key]);
    if (destinations.has(key)) refuse();
    destinations.set(key, field);
  }
  const fields: WorkflowField[] = [];
  const check = (candidate: ApiGraph): void => {
    const nodes = Object.keys(candidate);
    if (nodes.length === 0 || nodes.length > approved.maxNodes || !exact(approved.nodes, nodes) ||
        new TextEncoder().encode(stableStringify(candidate)).byteLength > approved.maxGraphBytes) refuse();
    for (const node of nodes) {
      const actual = candidate[node]!, rule = approved.nodes[node]!;
      if (!exact(actual, ['class_type', 'inputs']) || !exact(rule, ['classType', 'inputs']) ||
          actual.class_type !== rule.classType || typeof rule.classType !== 'string' || rule.classType === '' ||
          !isRecord(actual.inputs) || !exact(rule.inputs, Object.keys(actual.inputs))) refuse();
      for (const [key, value] of Object.entries(actual.inputs)) {
        const input = rule.inputs[key]!, field = destinations.get(JSON.stringify([node, key]));
        if (!isRecord(input)) refuse();
        if (input.kind === 'literal') {
          if (field !== undefined || !exact(input, ['kind', 'values']) || !Array.isArray(input.values) ||
              input.values.length === 0 || input.values.some(value =>
                value !== null && typeof value !== 'string' && typeof value !== 'boolean' &&
                !(typeof value === 'number' && Number.isFinite(value))) ||
              !input.values.some(allowed => allowed === value)) refuse();
        } else if (input.kind === 'link') {
          if (field !== undefined || !exact(input, ['kind', 'node', 'output']) ||
              typeof input.node !== 'string' || !Object.hasOwn(candidate, input.node) ||
              !Number.isSafeInteger(input.output) || input.output < 0 || !Array.isArray(value) ||
              value.length !== 2 || value[0] !== input.node || value[1] !== input.output) refuse();
        } else {
          if (field === undefined || typeof input.label !== 'string' || input.label === '') refuse();
          if (field === 'prompt' || field === 'negative') {
            if (input.kind !== 'text' || !exact(input, ['kind', 'label', 'maxLength']) ||
                !positive(input.maxLength) || typeof value !== 'string' || value.length > input.maxLength) refuse();
          } else if (input.kind !== 'integer' || !exact(input, ['kind', 'label', 'min', 'max']) ||
              !Number.isSafeInteger(input.min) || !Number.isSafeInteger(input.max) || input.min > input.max ||
              !Number.isSafeInteger(value) || (value as number) < input.min || (value as number) > input.max) refuse();
        }
      }
    }
    // Every mapped destination must actually have been checked, not just be
    // present in a separately asserted map.
    for (const [destination] of destinations) {
      const [node, key] = JSON.parse(destination) as [string, string];
      if (!Object.hasOwn(candidate, node) || !Object.hasOwn(candidate[node]!.inputs, key)) refuse();
    }
  };
  check(graph);
  for (const field of IMAGE_INPUT_FIELDS.filter(field => field !== 'seed')) {
    const destination = mapping.inputs[field]!;
    const input = approved.nodes[destination.node]!.inputs[destination.key]!;
    if (input.kind !== 'text' && input.kind !== 'integer') refuse();
    fields.push(Object.freeze({ node: destination.node, key: destination.key,
      kind: input.kind === 'text' ? 'text' : 'int', label: input.label }));
  }
  const digest = sha256Hex(stableStringify({ domain: 'std.ImagesV1.workflow/v1', binding,
    graph, mapping, policy: approved, limits }));
  return Object.freeze({ fields: Object.freeze(fields), digest, check });
}
