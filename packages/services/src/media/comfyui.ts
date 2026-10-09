/**
 * `ai.ImagesV1` adapter over native ComfyUI HTTP (verified routes:
 * `POST /prompt`, `GET /history/{id}`, `GET /view`, `POST
 * /api/jobs/{id}/cancel`).
 *
 * - Submit substitutes business inputs into the pinned graph through
 *   the versioned workflow map (digest-checked, scalar slots only),
 *   then queues with a caller-owned or minted prompt id. Acceptance
 *   returns the provider job reference; the run stays queued.
 * - Reconcile polls history: `{}` (or 404) means no entry — queued,
 *   running, or unknown id — and stays an honest `unknown` run
 *   state; `success` downloads declared-node outputs; `error`
 *   preserves partial outputs as failed-run data. Delivery success
 *   stays distinct from image-run success throughout.
 * - Cancel is a best-effort request followed by reconcile: a no-op
 *   for finished/unknown jobs proves nothing, so the post-cancel
 *   observation is the answer. Servers without targeted cancel (older
 *   releases answer 404) report `unsupported` and still reconcile.
 *   Native polling exposes no `cancelled` marker, so native cancel
 *   never fabricates that state.
 * - Output bytes are downloaded bounded per file and handed to the
 *   files flow at the S8 join; provider URLs are never treated as
 *   authorized attachments, and transport content-types are claims
 *   only (bytes win at files validation).
 */
import type {
  ApiGraph,
  CapabilityCompletion,
  DeliveryError,
  GeneratedImage,
  ImageAccepted,
  ImageGenerateInput,
  ImageRequest,
  ImageRun,
  ImageRunState,
  ProviderBinding,
  WorkflowDefinition,
  WorkflowNodeMapping,
} from '@canlang/contracts';
import {
  assertValidHttpConfig,
  httpRequest,
  httpRequestBinary,
} from '../http/client.js';
import type { HttpClientConfig } from '../http/client.js';
import {
  HttpBodyLimitError,
  HttpRedirectError,
  HttpStatusError,
  HttpTooManyRedirectsError,
  HttpTransportError,
} from '../http/errors.js';
import { assertValidCompletion } from '../mail/adapter.js';
import { deliveryError, specificOrGeneric } from '../mail/redact.js';
import { uniqueIds } from '../ports.js';
import type { DeliveryIds, InstalledImages, InstalledImageOptions, MediaPort } from '../ports.js';
import {
  MappingValidationError,
  stableStringify,
  substituteAndValidate,
} from './mapping.js';

export interface ComfyUINativeConfig {
  /** Fixed provider endpoint origin. */
  readonly baseUrl: string;
  /** Single deadline per request (submit, poll, download, cancel). */
  readonly timeoutMs: number;
  /** Response cap for JSON routes (prompt/history/cancel). */
  readonly maxBodyBytes: number;
  /** Literal `Authorization` header value; server-only, never logged. */
  readonly authorization?: string;
  /** Pinned API-format graph artifact content. */
  readonly graph: ApiGraph;
  /** Versioned workflow map reviewed against the graph digest. */
  readonly mapping: WorkflowNodeMapping;
  /** Stable client id for this deployment binding. */
  readonly clientId: string;
  /** Per-output download cap; over-cap bytes are unavailable, never cut. */
  readonly maxDownloadBytes: number;
  /** Total outputs cap per run; over-cap runs fail visibly, never truncate. */
  readonly maxOutputs: number;
  /** Prompt id mint; defaults to random UUIDs. */
  readonly jobIds?: DeliveryIds;
}

export interface ComfyUIImagesInstallation {
  readonly binding: ProviderBinding;
  /** Finalized artifact id and four destinations must match the actual adapter map. */
  readonly workflow: WorkflowDefinition;
  /** Explicit deployment policy: std source has no seed field. */
  readonly seed: { readonly kind: 'fixed'; readonly value: number };
  /** Finite cancel/reconcile window ceiling; defaults to the transport timeout. */
  readonly maxObservationDurationMs?: number;
}

interface ImageBudget {
  readonly deadlineMs: number;
  readonly monotonicDeadline: number;
  readonly maxOutputs: number;
}

function budgetHttp(http: HttpClientConfig, budget?: ImageBudget): HttpClientConfig {
  if (budget === undefined) return http;
  const remaining = Math.floor(Math.min(
    budget.deadlineMs - Date.now(),
    budget.monotonicDeadline - performance.now(),
    http.timeoutMs,
  ));
  if (remaining <= 0) throw new HttpTransportError('timeout');
  return { ...http, timeoutMs: remaining };
}

function frozenCopy<T>(value: T): T {
  const copied = JSON.parse(JSON.stringify(value)) as T;
  const freeze = (entry: unknown): void => {
    if (typeof entry !== 'object' || entry === null) return;
    for (const child of Object.values(entry)) freeze(child);
    Object.freeze(entry);
  };
  freeze(copied);
  return copied;
}

function exactFields(value: unknown, fields: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

const WORKFLOW_FIELDS = ['graph', 'prompt', 'negative', 'width', 'height'] as const;
const REQUEST_FIELDS = ['source', 'revision', 'workflow', 'validation', 'prompt', 'negative', 'width', 'height', 'max_outputs', 'max_duration'] as const;

const PROMPT_PATH = '/prompt';
const HISTORY_PREFIX = '/history/';
const VIEW_PATH = '/view';
const CANCEL_PREFIX = '/api/jobs/';
const CANCEL_SUFFIX = '/cancel';

const GENERIC = {
  rejected: 'Image provider rejected the request.',
  promptRejected: 'Image provider rejected the prompt; fix the workflow.',
  rateLimited: 'Image provider rate-limited the request; outcome unknown.',
  clientTimeout:
    'Image provider timed out waiting for the request; outcome unknown.',
  transient: 'Image provider returned a transient error; outcome unknown.',
  timeout: 'Image request timed out; outcome unknown.',
  unreachable: 'Image provider unreachable; outcome unknown.',
  redirectRefused:
    'Image provider redirected off the configured endpoint; outcome unknown.',
  redirectLoop:
    'Image provider redirected repeatedly without answering; outcome unknown.',
  invalidResponse: 'Image provider returned an invalid response.',
  runFailed: 'Image provider reported run failure.',
} as const;

const NO_ENTRY_DETAIL =
  'No history entry for this job (queued, running, or unknown id).';
const DOWNLOAD_GAP_DETAIL =
  'Some output bytes were unavailable; preserved outputs are partial evidence.';
const OUTPUT_CAP_DETAIL =
  'Run produced more outputs than the binding allows; refusing to truncate.';

function succeededImageCompletion<R>(
  deliveryId: string,
  result: R,
): CapabilityCompletion<R> {
  return { delivery_id: deliveryId, status: 'succeeded', result, error: null };
}

function failedImageCompletion<R>(
  deliveryId: string,
  error: DeliveryError,
): CapabilityCompletion<R> {
  return { delivery_id: deliveryId, status: 'failed', result: null, error };
}

function unknownImageCompletion<R>(
  deliveryId: string,
  error: DeliveryError | null,
): CapabilityCompletion<R> {
  return { delivery_id: deliveryId, status: 'unknown', result: null, error };
}

/** Map a submit outcome by status code. */
export function mapSubmitResponse(
  deliveryId: string,
  status: number,
  bodyText: string,
): CapabilityCompletion<ImageAccepted> {
  if (status >= 200 && status <= 299) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return failedImageCompletion(
        deliveryId,
        deliveryError('invalid_response', GENERIC.invalidResponse),
      );
    }
    const record = parsed as Record<string, unknown>;
    const nodeErrors = record['node_errors'];
    if (
      (typeof record['error'] === 'string' &&
        record['error'].length > 0) ||
      (typeof nodeErrors === 'object' &&
        nodeErrors !== null &&
        Object.keys(nodeErrors).length > 0)
    ) {
      return failedImageCompletion(
        deliveryId,
        deliveryError('provider_rejected', GENERIC.promptRejected),
      );
    }
    const job = record['prompt_id'];
    if (typeof job !== 'string' || job.length === 0) {
      return failedImageCompletion(
        deliveryId,
        deliveryError('invalid_response', GENERIC.invalidResponse),
      );
    }
    return succeededImageCompletion(deliveryId, { job });
  }
  if (status === 408 || status === 429) {
    return unknownImageCompletion(
      deliveryId,
      deliveryError(
        status === 429 ? 'provider_rate_limited' : 'provider_client_timeout',
        status === 429 ? GENERIC.rateLimited : GENERIC.clientTimeout,
      ),
    );
  }
  if (status >= 400 && status <= 499) {
    return failedImageCompletion(
      deliveryId,
      deliveryError('provider_rejected', GENERIC.rejected),
    );
  }
  if (status >= 500 && status <= 599) {
    return unknownImageCompletion(
      deliveryId,
      deliveryError('provider_transient', GENERIC.transient),
    );
  }
  return failedImageCompletion(
    deliveryId,
    deliveryError('invalid_response', GENERIC.invalidResponse),
  );
}

/** Map a submit transport failure; rethrows non-HTTP errors. */
export function mapSubmitError(
  deliveryId: string,
  err: unknown,
): CapabilityCompletion<ImageAccepted> {
  if (err instanceof HttpStatusError) {
    return mapSubmitResponse(deliveryId, err.status, err.bodyText);
  }
  if (err instanceof HttpBodyLimitError) {
    if (err.status >= 200 && err.status <= 299) {
      return failedImageCompletion(
        deliveryId,
        deliveryError('invalid_response', GENERIC.invalidResponse),
      );
    }
    return mapSubmitResponse(deliveryId, err.status, '');
  }
  if (err instanceof HttpTransportError) {
    return err.kind === 'timeout'
      ? unknownImageCompletion(
          deliveryId,
          deliveryError('transport_timeout', GENERIC.timeout),
        )
      : unknownImageCompletion(
          deliveryId,
          deliveryError('transport_unreachable', GENERIC.unreachable),
        );
  }
  if (err instanceof HttpRedirectError) {
    return unknownImageCompletion(
      deliveryId,
      deliveryError('redirect_refused', GENERIC.redirectRefused),
    );
  }
  if (err instanceof HttpTooManyRedirectsError) {
    return unknownImageCompletion(
      deliveryId,
      deliveryError('too_many_redirects', GENERIC.redirectLoop),
    );
  }
  throw err;
}

export interface HistoryImageDescriptor {
  readonly node: string;
  readonly filename: string;
  readonly subfolder: string;
  readonly type: string;
}

export interface HistoryRunEvidence {
  readonly statusStr: string;
  readonly failureDetail: string | null;
  readonly images: HistoryImageDescriptor[];
}

/**
 * Read one history entry for `job`: status marker, failure detail and
 * declared-node image descriptors. Returns `'absent'` when the entry
 * is missing (queued, running, or unknown id) and null when the
 * entry is present but uninterpretable.
 */
export function readHistoryRun(
  value: unknown,
  job: string,
  outputNodes: readonly string[],
): HistoryRunEvidence | 'absent' | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const entry = (value as Record<string, unknown>)[job];
  if (entry === undefined) {
    return 'absent';
  }
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const status = record['status'];
  if (typeof status !== 'object' || status === null || Array.isArray(status)) {
    return null;
  }
  const statusStr = (status as Record<string, unknown>)['status_str'];
  if (typeof statusStr !== 'string') {
    return null;
  }
  let failureDetail: string | null = null;
  if (statusStr === 'error') {
    failureDetail = GENERIC.runFailed;
    const messages = (status as Record<string, unknown>)['messages'];
    if (Array.isArray(messages)) {
      for (const message of messages) {
        if (typeof message === 'string' && message.length > 0) {
          const specific = specificOrGeneric(message, GENERIC.runFailed);
          failureDetail = specific;
          break;
        }
      }
    }
  } else if (statusStr !== 'success' && statusStr !== 'executing') {
    return null;
  }
  const outputs = record['outputs'];
  if (outputs !== undefined && (typeof outputs !== 'object' || outputs === null || Array.isArray(outputs))) {
    return null;
  }
  const outputRecord = (outputs ?? {}) as Record<string, unknown>;
  const images: HistoryImageDescriptor[] = [];
  for (const node of outputNodes) {
    const nodeOutput = outputRecord[node];
    if (nodeOutput === undefined) {
      continue;
    }
    if (typeof nodeOutput !== 'object' || nodeOutput === null) {
      return null;
    }
    const list = (nodeOutput as Record<string, unknown>)['images'];
    if (list === undefined) {
      continue;
    }
    if (!Array.isArray(list)) {
      return null;
    }
    for (const image of list) {
      if (
        typeof image !== 'object' ||
        image === null ||
        typeof (image as Record<string, unknown>)['filename'] !== 'string' ||
        ((image as Record<string, unknown>)['filename'] as string).length === 0 ||
        typeof (image as Record<string, unknown>)['subfolder'] !== 'string' ||
        typeof (image as Record<string, unknown>)['type'] !== 'string' ||
        ((image as Record<string, unknown>)['type'] as string).length === 0
      ) {
        return null;
      }
      const descriptor = image as Record<string, string>;
      images.push({
        node,
        filename: descriptor['filename'] as string,
        subfolder: descriptor['subfolder'] as string,
        type: descriptor['type'] as string,
      });
    }
  }
  return { statusStr, failureDetail, images };
}

/** Map an observation (poll/download/cancel) transport failure. */
function mapObservationError(
  deliveryId: string,
  err: unknown,
): CapabilityCompletion<ImageRun> {
  if (err instanceof HttpStatusError) {
    if (err.status === 408 || err.status === 429) {
      return unknownImageCompletion(
        deliveryId,
        deliveryError(
          err.status === 429 ? 'provider_rate_limited' : 'provider_client_timeout',
          err.status === 429 ? GENERIC.rateLimited : GENERIC.clientTimeout,
        ),
      );
    }
    if (err.status >= 400 && err.status <= 499) {
      return failedImageCompletion(
        deliveryId,
        deliveryError('provider_rejected', GENERIC.rejected),
      );
    }
    return unknownImageCompletion(
      deliveryId,
      deliveryError('provider_transient', GENERIC.transient),
    );
  }
  if (err instanceof HttpTransportError) {
    return err.kind === 'timeout'
      ? unknownImageCompletion(
          deliveryId,
          deliveryError('transport_timeout', GENERIC.timeout),
        )
      : unknownImageCompletion(
          deliveryId,
          deliveryError('transport_unreachable', GENERIC.unreachable),
        );
  }
  if (err instanceof HttpRedirectError) {
    return unknownImageCompletion(
      deliveryId,
      deliveryError('redirect_refused', GENERIC.redirectRefused),
    );
  }
  if (err instanceof HttpTooManyRedirectsError) {
    return unknownImageCompletion(
      deliveryId,
      deliveryError('too_many_redirects', GENERIC.redirectLoop),
    );
  }
  throw err;
}

export class ComfyUINativeAdapter implements MediaPort {
  private readonly http: HttpClientConfig;
  private readonly downloadHttp: HttpClientConfig;
  private readonly graph: ApiGraph;
  private readonly mapping: WorkflowNodeMapping;
  private readonly clientId: string;
  private readonly maxOutputs: number;
  private readonly jobIds: DeliveryIds;

  constructor(config: ComfyUINativeConfig) {
    assertValidHttpConfig({
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      maxBodyBytes: config.maxBodyBytes,
    });
    if (typeof config.clientId !== 'string' || config.clientId.length === 0) {
      throw new RangeError('clientId must be a non-empty string');
    }
    if (
      !Number.isInteger(config.maxDownloadBytes) ||
      config.maxDownloadBytes <= 0
    ) {
      throw new RangeError('maxDownloadBytes must be a positive integer');
    }
    if (!Number.isInteger(config.maxOutputs) || config.maxOutputs <= 0) {
      throw new RangeError('maxOutputs must be a positive integer');
    }
    this.http = {
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      maxBodyBytes: config.maxBodyBytes,
      ...(config.authorization === undefined
        ? {}
        : { authorization: config.authorization }),
    };
    this.downloadHttp = { ...this.http, maxBodyBytes: config.maxDownloadBytes };
    this.graph = config.graph;
    this.mapping = config.mapping;
    this.clientId = config.clientId;
    this.maxOutputs = config.maxOutputs;
    this.jobIds = config.jobIds ?? uniqueIds('job');
  }

  /**
   * Thin full-request installation over this actual graph/map and transport.
   * Caller persistence of the original request, IDs, generation deadline and
   * any control window is required; this stateless adapter cannot prove when
   * submission began or detect caller renewal of a retained window.
   * Late observation needs its own finite window. Neither deadline proves
   * that GPU work stopped.
   */
  installImages(config: ComfyUIImagesInstallation): InstalledImages {
    const binding = config.binding;
    if (
      typeof binding !== 'object' || binding === null ||
      binding.capability !== 'std.ImagesV1' || binding.capabilityVersion !== 1 ||
      typeof binding.deployment !== 'string' || binding.deployment.length === 0 ||
      typeof binding.account !== 'string' || binding.account.length === 0
    ) {
      throw new MappingValidationError('Installation must bind exact std.ImagesV1 version 1');
    }
    if (
      !exactFields(config.seed, ['kind', 'value']) || config.seed.kind !== 'fixed' ||
      !Number.isSafeInteger(config.seed.value) || config.seed.value < 0
    ) {
      throw new MappingValidationError('Installation requires an explicit safe fixed seed policy');
    }
    if (
      !Number.isSafeInteger(this.http.timeoutMs) || this.http.timeoutMs > 2_147_483_647 ||
      !Number.isSafeInteger(this.maxOutputs) ||
      !Number.isSafeInteger(this.downloadHttp.maxBodyBytes)
    ) {
      throw new MappingValidationError('Installation requires supported finite adapter ceilings');
    }
    const maxObservationDurationMs = Object.hasOwn(config, 'maxObservationDurationMs')
      ? config.maxObservationDurationMs : this.http.timeoutMs;
    if (typeof maxObservationDurationMs !== 'number' || !Number.isSafeInteger(maxObservationDurationMs) ||
        maxObservationDurationMs <= 0 || maxObservationDurationMs > 2_147_483_647) {
      throw new MappingValidationError('Installation requires a supported finite observation ceiling');
    }
    const graph = frozenCopy(this.graph);
    const mapping = frozenCopy(this.mapping);
    // Validate the exact pinned map/digest once; this is not arbitrary graph inspection.
    substituteAndValidate(graph, mapping, { prompt: '', negative: '', width: 1, height: 1, seed: config.seed.value });
    const definitionMatches = (definition: WorkflowDefinition): boolean =>
      exactFields(definition, WORKFLOW_FIELDS) && definition.graph === mapping.workflow &&
      (['prompt', 'negative', 'width', 'height'] as const).every((field) =>
        exactFields(definition[field], ['node', 'key']) &&
        definition[field].node === mapping.inputs[field].node &&
        definition[field].key === mapping.inputs[field].key);
    if (!definitionMatches(config.workflow)) {
      throw new MappingValidationError('Installed workflow must match the actual graph artifact and four mapped destinations');
    }
    const workflow = frozenCopy(config.workflow);
    const seed = frozenCopy(config.seed);
    const lower = new ComfyUINativeAdapter({
      ...this.http,
      graph,
      mapping,
      clientId: this.clientId,
      maxDownloadBytes: this.downloadHttp.maxBodyBytes,
      maxOutputs: this.maxOutputs,
    });
    const prepare = (input: ImageRequest, options: InstalledImageOptions, control = false) => {
      const startedAt = performance.now();
      const now = Date.now();
      if (!exactFields(input, REQUEST_FIELDS)) {
        throw new MappingValidationError('Image request must contain exactly the full std fields, without a source seed');
      }
      if (
        typeof input.source !== 'string' || input.source.length === 0 ||
        !Number.isSafeInteger(input.revision) || input.revision < 0
      ) {
        throw new MappingValidationError('Image request requires source and a safe non-negative revision');
      }
      if (!definitionMatches(input.workflow) || stableStringify(input.workflow) !== stableStringify(workflow) || input.validation !== mapping.graphDigest) {
        throw new MappingValidationError('Image request workflow and validation must match the immutable installation');
      }
      if (
        typeof input.prompt !== 'string' || typeof input.negative !== 'string' ||
        !Number.isSafeInteger(input.width) || input.width <= 0 ||
        !Number.isSafeInteger(input.height) || input.height <= 0
      ) {
        throw new MappingValidationError('Image request requires string prompts and safe positive dimensions');
      }
      if (
        !Number.isSafeInteger(input.max_outputs) || input.max_outputs <= 0 || input.max_outputs > lower.maxOutputs ||
        typeof input.max_duration !== 'bigint' || input.max_duration <= 0n || input.max_duration > BigInt(lower.http.timeoutMs)
      ) {
        throw new MappingValidationError('Image request budgets exceed or do not fit the installation');
      }
      if (
        !exactFields(options, Object.hasOwn(options ?? {}, 'observation')
          ? ['deliveryId', 'jobId', 'deadlineMs', 'observation'] : ['deliveryId', 'jobId', 'deadlineMs']) ||
        typeof options.deliveryId !== 'string' || options.deliveryId.length === 0 ||
        typeof options.jobId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.jobId) ||
        !Number.isSafeInteger(options.deadlineMs) || options.deadlineMs <= 0 ||
        options.deadlineMs - now > Number(input.max_duration)
      ) {
        throw new MappingValidationError('Image lifecycle requires original delivery/UUID job identities and a supported finite generation deadline');
      }
      let deadlineMs = options.deadlineMs;
      if (Object.hasOwn(options, 'observation')) {
        const observation = options.observation;
        if (!control || observation === undefined || !exactFields(observation, ['startedAtMs', 'deadlineMs']) ||
            Reflect.ownKeys(observation).length !== 2 ||
            !Number.isSafeInteger(observation.startedAtMs) || observation.startedAtMs < 0 || observation.startedAtMs > now ||
            !Number.isSafeInteger(observation.deadlineMs) || observation.deadlineMs <= now ||
            observation.deadlineMs - observation.startedAtMs > maxObservationDurationMs) {
          throw new MappingValidationError('Image control requires an original bounded observation window; submit cannot override its deadline');
        }
        deadlineMs = observation.deadlineMs;
      } else if (deadlineMs <= now) {
        throw new MappingValidationError('Image lifecycle requires an unexpired deadline or an explicit control observation window');
      }
      const budget: ImageBudget = {
        deadlineMs,
        monotonicDeadline: startedAt + (deadlineMs - now),
        maxOutputs: input.max_outputs,
      };
      const original = { deliveryId: options.deliveryId, jobId: options.jobId };
      const projected = {
        prompt: input.prompt, negative: input.negative, width: input.width, height: input.height, seed: seed.value,
      };
      return { budget, original, projected };
    };
    return Object.freeze({
      binding: frozenCopy(binding),
      workflow,
      validation: mapping.graphDigest,
      policy: Object.freeze({ seed, maxOutputs: lower.maxOutputs, maxDurationMs: lower.http.timeoutMs, maxObservationDurationMs, maxOutputBytes: lower.downloadHttp.maxBodyBytes }),
      images: Object.freeze({
        submit: async (input: ImageRequest, options: InstalledImageOptions) => {
          const { budget, original, projected } = prepare(input, options);
          const completion = await lower.submitWithBudget(projected, original, budget);
          if (completion.status === 'succeeded' && completion.result?.job !== original.jobId) {
            // A different provider id cannot become this original caller-owned job.
            return unknownImageCompletion<ImageAccepted>(original.deliveryId, deliveryError('invalid_response', GENERIC.invalidResponse));
          }
          return completion;
        },
        reconcile: (input: ImageRequest, options: InstalledImageOptions) => {
          const { budget, original } = prepare(input, options, true);
          return lower.reconcileWithBudget(original.jobId, original, budget);
        },
        cancel: (input: ImageRequest, options: InstalledImageOptions) => {
          const { budget, original } = prepare(input, options, true);
          return lower.cancelWithBudget(original.jobId, original, budget);
        },
      }),
    });
  }

  /**
   * Submit a generation. The caller may supply its own job id for
   * crash recovery (an unknown submit with a known id is pollable);
   * otherwise the adapter mints one. Mapping failures throw before
   * anything is sent.
   */
  async submit(
    input: ImageGenerateInput,
    options: { readonly deliveryId: string; readonly jobId?: string },
  ): Promise<CapabilityCompletion<ImageAccepted>> {
    return this.submitWithBudget(input, options);
  }

  private async submitWithBudget(
    input: ImageGenerateInput,
    options: { readonly deliveryId: string; readonly jobId?: string },
    budget?: ImageBudget,
  ): Promise<CapabilityCompletion<ImageAccepted>> {
    const deliveryId = options.deliveryId;
    if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
      throw new MappingValidationError('deliveryId must be a non-empty string');
    }
    let jobId = options.jobId;
    if (jobId !== undefined && (typeof jobId !== 'string' || jobId.length === 0)) {
      throw new MappingValidationError('jobId must be a non-empty string');
    }
    if (jobId === undefined) {
      jobId = this.jobIds.next();
    }
    const substituted = substituteAndValidate(this.graph, this.mapping, input);
    const wireBody = JSON.stringify({
      prompt: substituted.graph,
      client_id: this.clientId,
      prompt_id: jobId,
    });
    let completion: CapabilityCompletion<ImageAccepted>;
    try {
      const response = await httpRequest(budgetHttp(this.http, budget), {
        method: 'POST',
        path: PROMPT_PATH,
        body: wireBody,
      });
      completion = mapSubmitResponse(
        deliveryId,
        response.status,
        response.bodyText,
      );
    } catch (err) {
      completion = mapSubmitError(deliveryId, err);
    }
    assertValidCompletion(completion);
    return completion;
  }

  /**
   * Observe one job by polling history and downloading declared
   * outputs. A succeeded completion carries the observed run (which
   * may itself be failed or unknown); completion failure means the
   * observation itself failed.
   */
  async reconcile(
    job: string,
    options: { readonly deliveryId: string },
  ): Promise<CapabilityCompletion<ImageRun>> {
    return this.reconcileWithBudget(job, options);
  }

  private async reconcileWithBudget(
    job: string,
    options: { readonly deliveryId: string },
    budget?: ImageBudget,
  ): Promise<CapabilityCompletion<ImageRun>> {
    const deliveryId = options.deliveryId;
    if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
      throw new MappingValidationError('deliveryId must be a non-empty string');
    }
    if (typeof job !== 'string' || job.length === 0) {
      throw new MappingValidationError('job must be a non-empty string');
    }
    let bodyText: string;
    try {
      const response = await httpRequest(budgetHttp(this.http, budget), {
        method: 'GET',
        path: `${HISTORY_PREFIX}${encodeURIComponent(job)}`,
      });
      bodyText = response.bodyText;
    } catch (err) {
      if (err instanceof HttpBodyLimitError && err.status >= 200 && err.status <= 299) {
        return failedImageCompletion(
          deliveryId,
          deliveryError('invalid_response', GENERIC.invalidResponse),
        );
      }
      // Native answers unknown ids with `{}` (handled below), so a
      // 404 here means a wrong binding, and fails loudly as rejected.
      const completion = mapObservationError(deliveryId, err);
      assertValidCompletion(completion);
      return completion;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = undefined;
    }
    const evidence = readHistoryRun(parsed, job, this.mapping.outputs);
    if (evidence === null) {
      return failedImageCompletion(
        deliveryId,
        deliveryError('invalid_response', GENERIC.invalidResponse),
      );
    }
    if (evidence === 'absent') {
      return succeededImageCompletion(deliveryId, {
        job,
        state: 'unknown',
        outputs: [],
        detail: NO_ENTRY_DETAIL,
      });
    }
    if (evidence.statusStr === 'executing') {
      return succeededImageCompletion(deliveryId, {
        job,
        state: 'running',
        outputs: [],
        detail: null,
      });
    }
    if (evidence.images.length > (budget?.maxOutputs ?? this.maxOutputs)) {
      return succeededImageCompletion(deliveryId, {
        job,
        state: 'failed',
        outputs: [],
        detail: OUTPUT_CAP_DETAIL,
      });
    }
    const downloaded = await this.downloadImages(evidence.images, budget);
    if (evidence.statusStr === 'error') {
      return succeededImageCompletion(deliveryId, {
        job,
        state: 'failed',
        outputs: downloaded.images,
        detail: downloaded.complete
          ? evidence.failureDetail
          : `${evidence.failureDetail ?? GENERIC.runFailed}; ${DOWNLOAD_GAP_DETAIL}`,
      });
    }
    if (!downloaded.complete) {
      return succeededImageCompletion(deliveryId, {
        job,
        state: 'unknown',
        outputs: downloaded.images,
        detail: DOWNLOAD_GAP_DETAIL,
      });
    }
    return succeededImageCompletion(deliveryId, {
      job,
      state: 'succeeded',
      outputs: downloaded.images,
      detail: null,
    });
  }

  /**
   * Request cancellation, then reconcile: the post-cancel observation
   * is the answer, since a no-op for finished/unknown jobs proves
   * nothing. Servers without targeted cancel report `unsupported`
   * and still reconcile.
   */
  async cancel(
    job: string,
    options: { readonly deliveryId: string },
  ): Promise<CapabilityCompletion<ImageRun>> {
    return this.cancelWithBudget(job, options);
  }

  private async cancelWithBudget(
    job: string,
    options: { readonly deliveryId: string },
    budget?: ImageBudget,
  ): Promise<CapabilityCompletion<ImageRun>> {
    if (typeof job !== 'string' || job.length === 0) {
      throw new MappingValidationError('job must be a non-empty string');
    }
    const deliveryId = options.deliveryId;
    if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
      throw new MappingValidationError('deliveryId must be a non-empty string');
    }
    let attempt: 'requested' | 'unsupported' | 'uncertain';
    try {
      await httpRequest(budgetHttp(this.http, budget), {
        method: 'POST',
        path: `${CANCEL_PREFIX}${encodeURIComponent(job)}${CANCEL_SUFFIX}`,
      });
      attempt = 'requested';
    } catch (err) {
      if (err instanceof HttpStatusError && err.status === 404) {
        attempt = 'unsupported';
      } else {
        attempt = 'uncertain';
      }
    }
    const observed = await this.reconcileWithBudget(job, options, budget);
    if (observed.status !== 'succeeded' || observed.result === null) {
      return observed;
    }
    const note =
      attempt === 'requested'
        ? 'Cancellation requested; observation follows.'
        : attempt === 'unsupported'
          ? 'Targeted cancel unsupported by this server release; observation follows.'
          : 'Cancel outcome uncertain; observation follows.';
    const detail =
      observed.result.detail === null
        ? note
        : `${note} (${observed.result.detail})`;
    return succeededImageCompletion(options.deliveryId, {
      ...observed.result,
      detail,
    });
  }

  private async downloadImages(
    images: readonly HistoryImageDescriptor[],
    budget?: ImageBudget,
  ): Promise<{ images: GeneratedImage[]; complete: boolean }> {
    const collected: GeneratedImage[] = [];
    const positions = new Map<string, number>();
    for (const image of images) {
      const position = positions.get(image.node) ?? 0;
      positions.set(image.node, position + 1);
      const params = new URLSearchParams({
        filename: image.filename,
        subfolder: image.subfolder,
        type: image.type,
      });
      let bytes: Uint8Array;
      let contentType: string | null;
      try {
        const response = await httpRequestBinary(budgetHttp(this.downloadHttp, budget), {
          method: 'GET',
          path: `${VIEW_PATH}?${params.toString()}`,
        });
        bytes = response.bytes;
        contentType = response.contentType;
      } catch {
        return { images: collected, complete: false };
      }
      if (bytes.length === 0) {
        return { images: collected, complete: false };
      }
      collected.push({
        node: image.node,
        position,
        contentType: contentType ?? 'application/octet-stream',
        sizeBytes: bytes.length,
        bytes,
      });
    }
    return { images: collected, complete: true };
  }
}
