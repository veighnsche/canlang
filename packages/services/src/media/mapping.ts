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
 *   edge/setting byte-for-byte.
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

/** Canonical digest of an API-format graph. */
export function digestGraph(graph: ApiGraph): string {
  return sha256Hex(stableStringify(graph));
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
export function substituteAndValidate(
  graph: ApiGraph,
  mapping: WorkflowNodeMapping,
  input: ImageGenerateInput,
): SubstitutedGraph {
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
  const digest = digestGraph(graph);
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
    if (!isRecord(graph[nodeId])) {
      throw new MappingValidationError(
        `Output node '${nodeId}' does not exist in the graph`,
      );
    }
  }
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
  const substituted: ApiGraph = JSON.parse(JSON.stringify(graph)) as ApiGraph;
  for (const field of IMAGE_INPUT_FIELDS) {
    const destination = mapping.inputs[field] as
      | { node: string; key: string }
      | undefined;
    if (
      destination === undefined ||
      typeof destination.node !== 'string' ||
      typeof destination.key !== 'string'
    ) {
      throw new MappingValidationError(
        `Workflow mapping destination for '${field}' must name a node and key`,
      );
    }
    const node = substituted[destination.node];
    if (node === undefined || !isRecord(node.inputs)) {
      throw new MappingValidationError(
        `Workflow mapping destination node '${destination.node}' for '${field}' does not exist`,
      );
    }
    if (!(destination.key in node.inputs)) {
      throw new MappingValidationError(
        `Workflow mapping destination '${destination.node}.${destination.key}' for '${field}' does not exist`,
      );
    }
    const current = node.inputs[destination.key];
    const next = values[field];
    if (typeof current !== typeof next) {
      throw new MappingValidationError(
        `Workflow mapping destination '${destination.node}.${destination.key}' holds ${Array.isArray(current) ? 'a link' : typeof current}; cannot substitute ${typeof next}`,
      );
    }
    if (typeof current !== 'string' && typeof current !== 'number') {
      throw new MappingValidationError(
        `Workflow mapping destination '${destination.node}.${destination.key}' is not a scalar slot`,
      );
    }
    node.inputs[destination.key] = next;
  }
  return { graph: freezeGraph(substituted), digest };
}
