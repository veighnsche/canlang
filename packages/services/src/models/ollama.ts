/**
 * `ai.ChatV1` provider adapter over Ollama `POST /api/chat`.
 *
 * Provider evidence (`design/research-ai-capabilities-20261004.md`):
 * - Chat takes model + message history with optional format/tools; the
 *   adapter sends the frozen authorized history, never a hidden
 *   provider conversation. Model selection is validated against the
 *   bound deployment allowlist before anything is sent.
 * - Streaming is NDJSON (`stream:false` selects one JSON response). A
 *   mid-stream error arrives as a later error object without changing
 *   the already-sent HTTP status: HTTP 200 plus partial text never
 *   establishes a completed reply — only `done:true` with a valid
 *   final shape does. Partial/malformed outputs are preserved as
 *   failure evidence in run snapshots, never as valid business facts.
 * - Cancellation is per-run: the adapter owns one AbortController per
 *   run (the fetch equivalent of the documented client-per-stream
 *   guidance), so aborting one run cannot cancel another user's
 *   generation. `cancelRequested` (requested) is distinct from the
 *   terminal `cancelled` snapshot (confirmed); a final that races
 *   cancellation still wins as the terminal completion.
 * - Ollama documents no durable run ID or token-resume API, so
 *   `reconcile` honestly returns `unknown` (`no_run_resume`) instead
 *   of inventing a lookup.
 * - Provider `thinking` fields are ignored: user-visible content stays
 *   separate from private reasoning output.
 */
import type {
  CapabilityCompletion,
  DeliveryError,
  ModelChatInput,
  ModelChatReply,
  ModelMessage,
  ModelRunSnapshot,
  ModelRunState,
} from '../../../contracts/src/services.js';
import {
  assertValidHttpConfig,
  httpRequest,
  httpStreamText,
} from '../http/client.ts';
import type { HttpClientConfig } from '../http/client.ts';
import {
  HttpBodyLimitError,
  HttpRedirectError,
  HttpStatusError,
  HttpTooManyRedirectsError,
  HttpTransportError,
} from '../http/errors.ts';
import { assertValidCompletion } from '../mail/adapter.ts';
import { deliveryError, specificOrGeneric } from '../mail/redact.ts';
import { systemClock } from '../ports.ts';
import type { Clock, ModelChatPort, ModelRunHandle } from '../ports.ts';

export interface OllamaChatConfig {
  /** Fixed provider endpoint origin. */
  readonly baseUrl: string;
  /** Single deadline over headers, hops and the whole (streamed) body. */
  readonly timeoutMs: number;
  /** Total response byte cap for final and streamed bodies. */
  readonly maxBodyBytes: number;
  /** Literal `Authorization` header value; server-only, never logged. */
  readonly authorization?: string;
  /** Bound model allowlist; requests name one of these exactly. */
  readonly models: readonly string[];
  /** Deployment output-token ceiling; over-budget requests are rejected, never clamped. */
  readonly maxOutputTokens: number;
  /** Injected for deterministic tests; defaults to wall clock. */
  readonly clock?: Clock;
}

export interface FrozenChatRequest {
  readonly deliveryId: string;
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly maxTokens: number;
  readonly createdAt: number;
}

export interface FrozenChatRequestContext {
  readonly deliveryId: string;
  readonly createdAt: number;
  readonly models: readonly string[];
  readonly maxOutputTokens: number;
}

export class ModelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelValidationError';
  }
}

export class ModelCompletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelCompletionError';
  }
}

const CHAT_PATH = '/api/chat';

/** Retained snapshot tail per run; sequence numbers stay dense. */
const MAX_RETAINED_SNAPSHOTS = 256;

const GENERIC = {
  rejected: 'Model provider rejected the request.',
  rateLimited: 'Model provider rate-limited the request; outcome unknown.',
  clientTimeout: 'Model provider timed out waiting for the request; outcome unknown.',
  transient: 'Model provider returned a transient error; outcome unknown.',
  timeout: 'Model request timed out; outcome unknown.',
  unreachable: 'Model provider unreachable; outcome unknown.',
  redirectRefused:
    'Model provider redirected off the configured endpoint; outcome unknown.',
  redirectLoop:
    'Model provider redirected repeatedly without answering; outcome unknown.',
  invalidResponse: 'Model provider returned an invalid response.',
  streamError: 'Model provider reported an error mid-stream.',
  incompleteStream: 'Model stream ended without a completed reply.',
  noResume:
    'Ollama documents no run lookup; this uncertain generation cannot be reconciled.',
  runCancelled: 'Run cancelled at request; no result was produced.',
} as const;

const CHAT_ROLES: ReadonlySet<string> = new Set([
  'system',
  'user',
  'assistant',
  'tool',
]);

/**
 * Freeze model/messages/budget and enforce deployment policy. Unknown
 * models, malformed messages and over-budget token requests are
 * rejected before any byte is sent.
 */
export function buildFrozenChatRequest(
  input: ModelChatInput,
  ctx: FrozenChatRequestContext,
): FrozenChatRequest {
  if (typeof input !== 'object' || input === null) {
    throw new ModelValidationError('Chat input must be an object');
  }
  const { model, messages, maxTokens } = input;
  if (typeof model !== 'string' || model.length === 0) {
    throw new ModelValidationError('Chat model must be a non-empty string');
  }
  if (!ctx.models.includes(model)) {
    throw new ModelValidationError(
      `Chat model '${model}' is not bound to this deployment`,
    );
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ModelValidationError('Chat messages must be a non-empty array');
  }
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) {
      throw new ModelValidationError('Chat messages must be objects');
    }
    if (!CHAT_ROLES.has(message.role)) {
      throw new ModelValidationError(
        'Chat message role must be system, user, assistant or tool',
      );
    }
    if (typeof message.content !== 'string') {
      throw new ModelValidationError('Chat message content must be a string');
    }
  }
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new ModelValidationError('Chat maxTokens must be a positive integer');
  }
  if (maxTokens > ctx.maxOutputTokens) {
    throw new ModelValidationError(
      `Chat maxTokens ${maxTokens} exceeds the deployment ceiling ${ctx.maxOutputTokens}`,
    );
  }
  const frozen: FrozenChatRequest = {
    deliveryId: ctx.deliveryId,
    model,
    messages: Object.freeze(
      messages.map((message) =>
        Object.freeze({ role: message.role, content: message.content }),
      ),
    ),
    maxTokens,
    createdAt: ctx.createdAt,
  };
  return Object.freeze(frozen);
}

function succeededChatCompletion(
  deliveryId: string,
  result: ModelChatReply,
): CapabilityCompletion<ModelChatReply> {
  return { delivery_id: deliveryId, status: 'succeeded', result, error: null };
}

function failedChatCompletion(
  deliveryId: string,
  error: DeliveryError,
): CapabilityCompletion<ModelChatReply> {
  return { delivery_id: deliveryId, status: 'failed', result: null, error };
}

function unknownChatCompletion(
  deliveryId: string,
  error: DeliveryError | null,
): CapabilityCompletion<ModelChatReply> {
  return { delivery_id: deliveryId, status: 'unknown', result: null, error };
}

function readUsageCount(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : null;
}

/**
 * Validate one final Ollama chat payload: `done:true`, a string
 * assistant content, a non-empty model and done reason, optional
 * non-negative usage counts. Anything else is not a completed reply.
 */
export function readFinalChatReply(
  value: unknown,
  streamedContent: string,
): ModelChatReply | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record['done'] !== true) {
    return null;
  }
  const message = record['message'];
  let content = streamedContent;
  if (message !== undefined) {
    if (typeof message !== 'object' || message === null) {
      return null;
    }
    const delta = (message as Record<string, unknown>)['content'];
    if (typeof delta !== 'string') {
      return null;
    }
    content += delta;
  }
  const model = record['model'];
  const finish = record['done_reason'];
  if (
    typeof model !== 'string' ||
    model.length === 0 ||
    typeof finish !== 'string' ||
    finish.length === 0
  ) {
    return null;
  }
  return {
    content,
    model,
    finish,
    inputTokens: readUsageCount(record['prompt_eval_count']),
    outputTokens: readUsageCount(record['eval_count']),
  };
}

/** Map a final (non-streamed) outcome by status code. */
export function mapChatResponse(
  deliveryId: string,
  status: number,
  bodyText: string,
): CapabilityCompletion<ModelChatReply> {
  if (status >= 200 && status <= 299) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = undefined;
    }
    const reply = readFinalChatReply(parsed, '');
    if (reply === null) {
      return failedChatCompletion(
        deliveryId,
        deliveryError('invalid_response', GENERIC.invalidResponse),
      );
    }
    return succeededChatCompletion(deliveryId, reply);
  }
  if (status === 408 || status === 429) {
    return unknownChatCompletion(
      deliveryId,
      deliveryError(
        status === 429 ? 'provider_rate_limited' : 'provider_client_timeout',
        status === 429 ? GENERIC.rateLimited : GENERIC.clientTimeout,
      ),
    );
  }
  if (status >= 400 && status <= 499) {
    return failedChatCompletion(
      deliveryId,
      deliveryError('provider_rejected', GENERIC.rejected),
    );
  }
  if (status >= 500 && status <= 599) {
    return unknownChatCompletion(
      deliveryId,
      deliveryError('provider_transient', GENERIC.transient),
    );
  }
  return failedChatCompletion(
    deliveryId,
    deliveryError('invalid_response', GENERIC.invalidResponse),
  );
}

/** Map a send/stream transport failure; rethrows non-HTTP errors. */
export function mapChatError(
  deliveryId: string,
  err: unknown,
): CapabilityCompletion<ModelChatReply> {
  if (err instanceof HttpStatusError) {
    return mapChatResponse(deliveryId, err.status, err.bodyText);
  }
  if (err instanceof HttpBodyLimitError) {
    if (err.status >= 200 && err.status <= 299) {
      return failedChatCompletion(
        deliveryId,
        deliveryError('invalid_response', GENERIC.invalidResponse),
      );
    }
    return mapChatResponse(deliveryId, err.status, '');
  }
  if (err instanceof HttpTransportError) {
    return err.kind === 'timeout'
      ? unknownChatCompletion(
          deliveryId,
          deliveryError('transport_timeout', GENERIC.timeout),
        )
      : unknownChatCompletion(
          deliveryId,
          deliveryError('transport_unreachable', GENERIC.unreachable),
        );
  }
  if (err instanceof HttpRedirectError) {
    return unknownChatCompletion(
      deliveryId,
      deliveryError('redirect_refused', GENERIC.redirectRefused),
    );
  }
  if (err instanceof HttpTooManyRedirectsError) {
    return unknownChatCompletion(
      deliveryId,
      deliveryError('too_many_redirects', GENERIC.redirectLoop),
    );
  }
  throw err;
}

type StreamLineVerdict =
  | { readonly kind: 'delta'; readonly content: string }
  | { readonly kind: 'final'; readonly reply: ModelChatReply }
  | { readonly kind: 'error'; readonly message: unknown }
  | { readonly kind: 'malformed' };

/**
 * Classify one NDJSON stream object. Error lines win over everything;
 * `done:true` lines must carry a valid final shape; progress lines
 * must carry a string content delta (`thinking` and other fields are
 * ignored, never surfaced).
 */
export function classifyStreamLine(
  value: unknown,
  streamedContent: string,
): StreamLineVerdict {
  if (typeof value !== 'object' || value === null) {
    return { kind: 'malformed' };
  }
  const record = value as Record<string, unknown>;
  if (typeof record['error'] === 'string' && record['error'].length > 0) {
    return { kind: 'error', message: record['error'] };
  }
  if (record['done'] === true) {
    const reply = readFinalChatReply(value, streamedContent);
    return reply === null
      ? { kind: 'malformed' }
      : { kind: 'final', reply };
  }
  const message = record['message'];
  if (typeof message !== 'object' || message === null) {
    return { kind: 'malformed' };
  }
  const delta = (message as Record<string, unknown>)['content'];
  if (typeof delta !== 'string') {
    return { kind: 'malformed' };
  }
  return { kind: 'delta', content: delta };
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

class OllamaRunHandle implements ModelRunHandle {
  readonly deliveryId: string;
  private readonly http: HttpClientConfig;
  private readonly request: FrozenChatRequest;
  private readonly onSnapshot:
    | ((snapshot: ModelRunSnapshot) => void)
    | undefined;
  private readonly aborter = new AbortController();
  private readonly snapshotsRetained: ModelRunSnapshot[] = [];
  private sequence = 0;
  private terminal: CapabilityCompletion<ModelChatReply> | null = null;
  private cancelRequestedFlag = false;
  private readonly settled: Promise<CapabilityCompletion<ModelChatReply>>;

  constructor(
    http: HttpClientConfig,
    request: FrozenChatRequest,
    onSnapshot: ((snapshot: ModelRunSnapshot) => void) | undefined,
  ) {
    this.deliveryId = request.deliveryId;
    this.http = http;
    this.request = request;
    this.onSnapshot = onSnapshot;
    this.emit('running', '');
    this.settled = this.run();
  }

  get cancelRequested(): boolean {
    return this.cancelRequestedFlag;
  }

  snapshots(): readonly ModelRunSnapshot[] {
    return this.snapshotsRetained.slice();
  }

  done(): Promise<CapabilityCompletion<ModelChatReply>> {
    return this.settled;
  }

  async cancel(): Promise<CapabilityCompletion<ModelChatReply>> {
    if (this.terminal !== null) {
      return this.terminal;
    }
    this.cancelRequestedFlag = true;
    this.aborter.abort();
    return this.settled;
  }

  private emit(state: ModelRunState, content: string): void {
    const snapshot: ModelRunSnapshot = {
      sequence: this.sequence,
      state,
      content,
    };
    this.sequence += 1;
    this.snapshotsRetained.push(snapshot);
    while (this.snapshotsRetained.length > MAX_RETAINED_SNAPSHOTS) {
      this.snapshotsRetained.shift();
    }
    if (this.onSnapshot !== undefined) {
      try {
        this.onSnapshot(snapshot);
      } catch {
        // Observers must never break generation.
      }
    }
  }

  private settle(
    completion: CapabilityCompletion<ModelChatReply>,
    terminalState: ModelRunState,
    content: string,
  ): CapabilityCompletion<ModelChatReply> {
    assertValidCompletion(completion);
    // A final that raced cancellation wins: once terminal, the first
    // outcome stands and late aborts change nothing.
    if (this.terminal === null) {
      this.terminal = completion;
      this.emit(terminalState, content);
    }
    return this.terminal;
  }

  private async run(): Promise<CapabilityCompletion<ModelChatReply>> {
    const wireBody = JSON.stringify({
      model: this.request.model,
      messages: this.request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      stream: true,
      options: { num_predict: this.request.maxTokens },
    });
    let accumulated = '';
    let buffer = '';
    const handleLine = (line: string): boolean => {
      if (line.trim().length === 0) {
        return false;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.settle(
          failedChatCompletion(
            this.deliveryId,
            deliveryError('invalid_response', GENERIC.invalidResponse),
          ),
          'failed',
          accumulated,
        );
        return true;
      }
      const verdict = classifyStreamLine(parsed, accumulated);
      switch (verdict.kind) {
        case 'delta':
          accumulated += verdict.content;
          this.emit('running', accumulated);
          return false;
        case 'final':
          this.settle(
            succeededChatCompletion(this.deliveryId, verdict.reply),
            'succeeded',
            verdict.reply.content,
          );
          return true;
        case 'error':
          this.settle(
            failedChatCompletion(
              this.deliveryId,
              deliveryError(
                'provider_error',
                specificOrGeneric(verdict.message, GENERIC.streamError),
              ),
            ),
            'failed',
            accumulated,
          );
          return true;
        case 'malformed':
          this.settle(
            failedChatCompletion(
              this.deliveryId,
              deliveryError('invalid_response', GENERIC.invalidResponse),
            ),
            'failed',
            accumulated,
          );
          return true;
      }
    };
    try {
      const stream = httpStreamText(this.http, {
        method: 'POST',
        path: CHAT_PATH,
        body: wireBody,
        signal: this.aborter.signal,
      });
      for await (const segment of stream) {
        buffer += segment.text;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (handleLine(line)) {
            // Terminal: stop consuming; breaking releases the generator.
            return this.terminal as CapabilityCompletion<ModelChatReply>;
          }
          newline = buffer.indexOf('\n');
        }
      }
      if (buffer.trim().length > 0) {
        handleLine(buffer);
        buffer = '';
      }
    } catch (err) {
      if (isAbortError(err)) {
        if (this.terminal !== null) {
          return this.terminal;
        }
        return this.settle(
          failedChatCompletion(
            this.deliveryId,
            deliveryError('run_cancelled', GENERIC.runCancelled),
          ),
          'cancelled',
          accumulated,
        );
      }
      if (this.terminal !== null) {
        return this.terminal;
      }
      const completion = mapChatError(this.deliveryId, err);
      const state: ModelRunState =
        completion.status === 'unknown' ? 'unknown' : 'failed';
      return this.settle(completion, state, accumulated);
    }
    if (this.terminal !== null) {
      return this.terminal;
    }
    // HTTP 200 plus partial text is not a completed reply.
    return this.settle(
      failedChatCompletion(
        this.deliveryId,
        deliveryError('invalid_response', GENERIC.incompleteStream),
      ),
      'failed',
      accumulated,
    );
  }
}

export class OllamaChatAdapter implements ModelChatPort {
  private readonly http: HttpClientConfig;
  private readonly models: readonly string[];
  private readonly maxOutputTokens: number;
  private readonly clock: Clock;

  constructor(config: OllamaChatConfig) {
    assertValidHttpConfig({
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      maxBodyBytes: config.maxBodyBytes,
    });
    if (config.models.length === 0) {
      throw new RangeError('models must bind at least one model id');
    }
    if (
      !config.models.every(
        (model) => typeof model === 'string' && model.length > 0,
      )
    ) {
      throw new RangeError('models must be non-empty strings');
    }
    if (
      !Number.isInteger(config.maxOutputTokens) ||
      config.maxOutputTokens <= 0
    ) {
      throw new RangeError('maxOutputTokens must be a positive integer');
    }
    this.http = {
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      maxBodyBytes: config.maxBodyBytes,
      ...(config.authorization === undefined
        ? {}
        : { authorization: config.authorization }),
    };
    this.models = config.models.slice();
    this.maxOutputTokens = config.maxOutputTokens;
    this.clock = config.clock ?? systemClock();
  }

  private frozen(
    input: ModelChatInput,
    deliveryId: string,
  ): FrozenChatRequest {
    if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
      throw new ModelValidationError(
        'deliveryId must be a non-empty string',
      );
    }
    return buildFrozenChatRequest(input, {
      deliveryId,
      createdAt: this.clock.now(),
      models: this.models,
      maxOutputTokens: this.maxOutputTokens,
    });
  }

  /** Final-only generation (`stream:false`) with validated completion. */
  async generate(
    input: ModelChatInput,
    options: { readonly deliveryId: string },
  ): Promise<CapabilityCompletion<ModelChatReply>> {
    const request = this.frozen(input, options.deliveryId);
    const wireBody = JSON.stringify({
      model: request.model,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      stream: false,
      options: { num_predict: request.maxTokens },
    });
    let completion: CapabilityCompletion<ModelChatReply>;
    try {
      const response = await httpRequest(this.http, {
        method: 'POST',
        path: CHAT_PATH,
        body: wireBody,
      });
      completion = mapChatResponse(
        request.deliveryId,
        response.status,
        response.bodyText,
      );
    } catch (err) {
      completion = mapChatError(request.deliveryId, err);
    }
    assertValidCompletion(completion);
    return completion;
  }

  /**
   * Streaming generation. Returns the run handle immediately; the run
   * proceeds until a final, an error, the deadline or `cancel()`.
   * Throws synchronously on validation failures (nothing is sent).
   */
  generateStream(
    input: ModelChatInput,
    options: {
      readonly deliveryId: string;
      readonly onSnapshot?: (snapshot: ModelRunSnapshot) => void;
    },
  ): ModelRunHandle {
    const request = this.frozen(input, options.deliveryId);
    return new OllamaRunHandle(this.http, request, options.onSnapshot);
  }

  /**
   * Reconcile an uncertain generation. Ollama documents no durable
   * run ID or token-resume API, so this honestly stays `unknown`
   * instead of inventing a lookup.
   */
  async reconcile(
    deliveryId: string,
  ): Promise<CapabilityCompletion<ModelChatReply>> {
    if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
      throw new ModelValidationError(
        'deliveryId must be a non-empty string',
      );
    }
    return unknownChatCompletion(
      deliveryId,
      deliveryError('no_run_resume', GENERIC.noResume),
    );
  }
}
