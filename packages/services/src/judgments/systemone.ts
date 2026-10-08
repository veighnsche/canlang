/**
 * `ai.SystemOneV1` judgment adapter over the System One API.
 *
 * Wire evidence: `tools/jev.py` (endpoint shape, Bearer auth, exact
 * answer-key/type/choice validation) plus documented answer shapes —
 * noul `{type, noul}`, choice `{type, choice, probabilities,
 * confidence}`, score `{type, score, legend, probabilities,
 * confidence}` with string-indexed level maps, and
 * `usage.{input_tokens, output_tokens}`.
 *
 * The adapter normalizes exact typed answers: finite numbers and
 * ranges, exact question and option sets, unique ordered levels,
 * complete legends, distribution sums within wire tolerance, score
 * consistency, selected labels, model identity and usage. Anything
 * else is `invalid_response`, never a partial business fact. NOUL
 * carries no confidence field; distributions are preserved as-is
 * (never rounded into booleans); thresholds and routing are business
 * policy and live nowhere in this module.
 *
 * Provider limits are deployment validation, not inferred
 * compatibility: the binding declares the supported choice/level
 * bounds (JEV allows up to 255 options / 10 levels; local System One
 * documents 2–26 for both) and the request byte cap (local
 * documents 64 KiB). Out-of-contract requests are rejected before
 * anything is sent. Like chat, System One documents no run lookup,
 * so uncertain batches honestly stay `unknown` on reconcile.
 */
import type {
  CapabilityCompletion,
  ChoiceAnswer,
  DeliveryError,
  JudgmentAnswer,
  JudgmentBatchInput,
  JudgmentBatchResult,
  JudgmentQuestion,
  NoulAnswer,
  ScoreAnswer,
  ScoreLevel,
  JudgmentEvaluationResult,
  JudgmentSpec,
  DecimalValue,
} from '@canlang/contracts';
import { int64, parseDecimal, scalarLength } from '@canlang/values';
import { assertValidHttpConfig, httpRequest } from '../http/client.js';
import type { HttpClientConfig } from '../http/client.js';
import {
  HttpBodyLimitError,
  HttpRedirectError,
  HttpStatusError,
  HttpTooManyRedirectsError,
  HttpTransportError,
} from '../http/errors.js';
import { assertValidCompletion } from '../mail/adapter.js';
import { deliveryError } from '../mail/redact.js';
import { systemClock } from '../ports.js';
import type { Clock, InstalledJudgment, JudgmentEvaluationInput, JudgmentPort } from '../ports.js';
import { freezeJudgmentSource } from './specification.js';
import type { StaticJudgmentQuestion } from './specification.js';

export interface SystemOneConfig {
  /** Fixed provider endpoint origin. */
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
  /** Literal `Authorization` header value; server-only, never logged. */
  readonly authorization?: string;
  /** Bound model ids/aliases; requests name one of these exactly. */
  readonly models: readonly string[];
  /** Supported choice-option bounds for this binding. */
  readonly minChoiceOptions: number;
  readonly maxChoiceOptions: number;
  /** Supported score-level bounds for this binding. */
  readonly minScoreLevels: number;
  readonly maxScoreLevels: number;
  /**
   * Serialized request byte cap (local System One documents 64 KiB);
   * `null` means the deployment declares no cap.
   */
  readonly maxRequestBytes: number | null;
  /** Injected for deterministic tests; defaults to wall clock. */
  readonly clock?: Clock;
}

export interface FrozenJudgmentRequest {
  readonly deliveryId: string;
  readonly model: string;
  readonly state: Record<string, unknown>;
  readonly questions: readonly JudgmentQuestion[];
  readonly createdAt: number;
}

export interface FrozenJudgmentRequestContext {
  readonly deliveryId: string;
  readonly createdAt: number;
  readonly models: readonly string[];
  readonly minChoiceOptions: number;
  readonly maxChoiceOptions: number;
  readonly minScoreLevels: number;
  readonly maxScoreLevels: number;
  readonly maxRequestBytes: number | null;
}

export class JudgmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgmentValidationError';
  }
}

/**
 * Wire float-artifact allowance for distribution sums and score
 * consistency. Wire probabilities are decimal-rounded floats; sums
 * must land within this distance of 1.
 */
export const WIRE_PROBABILITY_TOLERANCE = 1e-6;

const SYSTEMONE_PATH = '/v1/systemone';

const GENERIC = {
  rejected: 'Judgment provider rejected the batch.',
  unauthorized: 'Judgment provider refused authentication.',
  rateLimited: 'Judgment provider rate-limited the batch; outcome unknown.',
  clientTimeout:
    'Judgment provider timed out waiting for the batch; outcome unknown.',
  transient: 'Judgment provider returned a transient error; outcome unknown.',
  timeout: 'Judgment batch timed out; outcome unknown.',
  unreachable: 'Judgment provider unreachable; outcome unknown.',
  redirectRefused:
    'Judgment provider redirected off the configured endpoint; outcome unknown.',
  redirectLoop:
    'Judgment provider redirected repeatedly without answering; outcome unknown.',
  invalidResponse: 'Judgment provider returned an invalid response.',
  noResume:
    'System One documents no batch lookup; this uncertain batch cannot be reconciled.',
} as const;

function isProbability(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const seen = new Set(a);
  if (seen.size !== a.length) {
    return false;
  }
  return b.every((item) => seen.has(item));
}

/**
 * Freeze model/state/questions and enforce the binding's supported
 * contract. Unknown models, duplicate ids, out-of-bounds option or
 * level counts, non-serializable state and over-cap requests are
 * rejected before anything is sent.
 */
export function buildFrozenJudgmentRequest(
  input: JudgmentBatchInput,
  ctx: FrozenJudgmentRequestContext,
): FrozenJudgmentRequest {
  if (typeof input !== 'object' || input === null) {
    throw new JudgmentValidationError('Judgment input must be an object');
  }
  const { model, state, questions } = input;
  if (!isNonEmptyString(model)) {
    throw new JudgmentValidationError(
      'Judgment model must be a non-empty string',
    );
  }
  if (!ctx.models.includes(model)) {
    throw new JudgmentValidationError(
      `Judgment model '${model}' is not bound to this deployment`,
    );
  }
  if (
    typeof state !== 'object' ||
    state === null ||
    Array.isArray(state)
  ) {
    throw new JudgmentValidationError('Judgment state must be an object');
  }
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new JudgmentValidationError(
      'Judgment questions must be a non-empty array',
    );
  }
  const ids = new Set<string>();
  for (const question of questions) {
    if (typeof question !== 'object' || question === null) {
      throw new JudgmentValidationError('Judgment questions must be objects');
    }
    if (!isNonEmptyString(question.id)) {
      throw new JudgmentValidationError(
        'Judgment question ids must be non-empty strings',
      );
    }
    if (ids.has(question.id)) {
      throw new JudgmentValidationError(
        `Duplicate judgment question id '${question.id}'`,
      );
    }
    ids.add(question.id);
    const questionId = question.id;
    if (!isNonEmptyString(question.instructions)) {
      throw new JudgmentValidationError(
        `Judgment question '${questionId}' needs instructions`,
      );
    }
    switch (question.kind) {
      case 'noul':
        break;
      case 'choice': {
        if (
          typeof question.options !== 'object' ||
          question.options === null ||
          Array.isArray(question.options)
        ) {
          throw new JudgmentValidationError(
            `Choice question '${question.id}' needs an options object`,
          );
        }
        const optionIds = Object.keys(question.options);
        if (
          optionIds.length < ctx.minChoiceOptions ||
          optionIds.length > ctx.maxChoiceOptions
        ) {
          throw new JudgmentValidationError(
            `Choice question '${question.id}' has ${optionIds.length} options; binding supports ${ctx.minChoiceOptions}..${ctx.maxChoiceOptions}`,
          );
        }
        for (const optionId of optionIds) {
          if (
            optionId.length === 0 ||
            typeof question.options[optionId] !== 'string'
          ) {
            throw new JudgmentValidationError(
              `Choice question '${question.id}' has a malformed option`,
            );
          }
        }
        break;
      }
      case 'score': {
        if (!Array.isArray(question.levels)) {
          throw new JudgmentValidationError(
            `Score question '${question.id}' needs an ordered level list`,
          );
        }
        if (
          question.levels.length < ctx.minScoreLevels ||
          question.levels.length > ctx.maxScoreLevels
        ) {
          throw new JudgmentValidationError(
            `Score question '${question.id}' has ${question.levels.length} levels; binding supports ${ctx.minScoreLevels}..${ctx.maxScoreLevels}`,
          );
        }
        for (const level of question.levels) {
          if (typeof level !== 'string' || level.length === 0) {
            throw new JudgmentValidationError(
              `Score question '${question.id}' has a malformed level`,
            );
          }
        }
        break;
      }
      default:
        throw new JudgmentValidationError(
          `Judgment question '${questionId}' has an unknown kind`,
        );
    }
  }
  let serialized: string;
  try {
    serialized = JSON.stringify({
      model,
      state,
      questions: serializeQuestions(questions),
    });
  } catch {
    throw new JudgmentValidationError(
      'Judgment state and questions must be JSON-serializable',
    );
  }
  if (ctx.maxRequestBytes !== null) {
    const requestBytes = new TextEncoder().encode(serialized).byteLength;
    if (requestBytes > ctx.maxRequestBytes) {
      throw new JudgmentValidationError(
        `Judgment request is ${requestBytes} bytes; binding allows ${ctx.maxRequestBytes}`,
      );
    }
  }
  const frozen: FrozenJudgmentRequest = {
    deliveryId: ctx.deliveryId,
    model,
    state: JSON.parse(JSON.stringify(state)) as Record<string, unknown>,
    questions: Object.freeze(
      questions.map((question) => Object.freeze(structuredClone(question))),
    ),
    createdAt: ctx.createdAt,
  };
  return Object.freeze(frozen);
}

function serializeQuestions(
  questions: readonly JudgmentQuestion[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const question of questions) {
    switch (question.kind) {
      case 'noul':
        out[question.id] = {
          type: 'noul',
          instructions: question.instructions,
        };
        break;
      case 'choice':
        out[question.id] = {
          type: 'choice',
          instructions: question.instructions,
          criteria: { ...question.options },
        };
        break;
      case 'score':
        out[question.id] = {
          type: 'score',
          instructions: question.instructions,
          criteria: [...question.levels],
        };
        break;
    }
  }
  return out;
}

export function serializeJudgmentBody(request: FrozenJudgmentRequest): string {
  return JSON.stringify({
    model: request.model,
    state: request.state,
    questions: serializeQuestions(request.questions),
  });
}

function succeededJudgmentCompletion(
  deliveryId: string,
  result: JudgmentBatchResult,
): CapabilityCompletion<JudgmentBatchResult> {
  return { delivery_id: deliveryId, status: 'succeeded', result, error: null };
}

function failedJudgmentCompletion(
  deliveryId: string,
  error: DeliveryError,
): CapabilityCompletion<JudgmentBatchResult> {
  return { delivery_id: deliveryId, status: 'failed', result: null, error };
}

function unknownJudgmentCompletion(
  deliveryId: string,
  error: DeliveryError | null,
): CapabilityCompletion<JudgmentBatchResult> {
  return { delivery_id: deliveryId, status: 'unknown', result: null, error };
}

function readNoulAnswer(value: unknown): NoulAnswer | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const probability = (value as Record<string, unknown>)['noul'];
  return isProbability(probability) ? { probability } : null;
}

function readChoiceAnswer(
  value: unknown,
  options: Record<string, string>,
): ChoiceAnswer | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const choice = record['choice'];
  const probabilities = record['probabilities'];
  const confidence = record['confidence'];
  if (typeof choice !== 'string' || !(choice in options)) {
    return null;
  }
  if (
    typeof probabilities !== 'object' ||
    probabilities === null ||
    Array.isArray(probabilities)
  ) {
    return null;
  }
  const entries = Object.entries(probabilities as Record<string, unknown>);
  if (!sameStringSet(entries.map(([key]) => key), Object.keys(options))) {
    return null;
  }
  const distribution: Record<string, number> = {};
  let sum = 0;
  for (const [key, probability] of entries) {
    if (!isProbability(probability)) {
      return null;
    }
    distribution[key] = probability;
    sum += probability;
  }
  if (Math.abs(sum - 1) > WIRE_PROBABILITY_TOLERANCE) {
    return null;
  }
  if (!isProbability(confidence)) {
    return null;
  }
  return { choice, probabilities: distribution, confidence };
}

function readScoreAnswer(
  value: unknown,
  levelCount: number,
): ScoreAnswer | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const score = record['score'];
  const legend = record['legend'];
  const probabilities = record['probabilities'];
  const confidence = record['confidence'];
  if (
    typeof score !== 'number' ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > levelCount - 1
  ) {
    return null;
  }
  if (
    typeof legend !== 'object' ||
    legend === null ||
    Array.isArray(legend) ||
    typeof probabilities !== 'object' ||
    probabilities === null ||
    Array.isArray(probabilities)
  ) {
    return null;
  }
  const expectedKeys: string[] = [];
  for (let index = 0; index < levelCount; index += 1) {
    expectedKeys.push(String(index));
  }
  const legendRecord = legend as Record<string, unknown>;
  const probabilityRecord = probabilities as Record<string, unknown>;
  if (
    !sameStringSet(Object.keys(legendRecord), expectedKeys) ||
    !sameStringSet(Object.keys(probabilityRecord), expectedKeys)
  ) {
    return null;
  }
  const levels: ScoreLevel[] = [];
  let sum = 0;
  let weighted = 0;
  for (let index = 0; index < levelCount; index += 1) {
    const key = String(index);
    const description = legendRecord[key];
    const probability = probabilityRecord[key];
    if (!isNonEmptyString(description) || !isProbability(probability)) {
      return null;
    }
    levels.push({ index, description, probability });
    sum += probability;
    weighted += index * probability;
  }
  if (Math.abs(sum - 1) > WIRE_PROBABILITY_TOLERANCE) {
    return null;
  }
  if (Math.abs(weighted - score) > WIRE_PROBABILITY_TOLERANCE) {
    return null;
  }
  if (!isProbability(confidence)) {
    return null;
  }
  return { score, levels, confidence };
}

function readUsageCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Validate one batch payload: answering model, exact answer-key set,
 * per-question type match, and full distribution/legend/consistency
 * checks. Returns null for anything that is not a complete valid
 * batch — never a partial result.
 */
export function readJudgmentBatchResult(
  value: unknown,
  questions: readonly JudgmentQuestion[],
): JudgmentBatchResult | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!isNonEmptyString(record['model'])) {
    return null;
  }
  const answers = record['answers'];
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) {
    return null;
  }
  const answerRecord = answers as Record<string, unknown>;
  if (
    !sameStringSet(
      Object.keys(answerRecord),
      questions.map((question) => question.id),
    )
  ) {
    return null;
  }
  const normalized: JudgmentAnswer[] = [];
  for (const question of questions) {
    const answer = answerRecord[question.id];
    if (
      typeof answer !== 'object' ||
      answer === null ||
      (answer as Record<string, unknown>)['type'] !== question.kind
    ) {
      return null;
    }
    switch (question.kind) {
      case 'noul': {
        const noul = readNoulAnswer(answer);
        if (noul === null) {
          return null;
        }
        normalized.push({ kind: 'noul', id: question.id, answer: noul });
        break;
      }
      case 'choice': {
        const choice = readChoiceAnswer(answer, question.options);
        if (choice === null) {
          return null;
        }
        normalized.push({ kind: 'choice', id: question.id, answer: choice });
        break;
      }
      case 'score': {
        const score = readScoreAnswer(answer, question.levels.length);
        if (score === null) {
          return null;
        }
        normalized.push({ kind: 'score', id: question.id, answer: score });
        break;
      }
    }
  }
  const usage = record['usage'];
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  if (usage !== undefined) {
    if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) {
      return null;
    }
    const usageRecord = usage as Record<string, unknown>;
    const input = readUsageCount(usageRecord['input_tokens']);
    const output = readUsageCount(usageRecord['output_tokens']);
    if (input === null || output === null) {
      return null;
    }
    inputTokens = input;
    outputTokens = output;
  }
  return {
    model: record['model'] as string,
    answers: normalized,
    inputTokens,
    outputTokens,
  };
}

/** Map a batch outcome by status code. */
export function mapJudgmentResponse(
  deliveryId: string,
  status: number,
  bodyText: string,
  questions: readonly JudgmentQuestion[],
): CapabilityCompletion<JudgmentBatchResult> {
  if (status >= 200 && status <= 299) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = undefined;
    }
    const result = readJudgmentBatchResult(parsed, questions);
    if (result === null) {
      return failedJudgmentCompletion(
        deliveryId,
        deliveryError('invalid_response', GENERIC.invalidResponse),
      );
    }
    return succeededJudgmentCompletion(deliveryId, result);
  }
  if (status === 408 || status === 429) {
    return unknownJudgmentCompletion(
      deliveryId,
      deliveryError(
        status === 429 ? 'provider_rate_limited' : 'provider_client_timeout',
        status === 429 ? GENERIC.rateLimited : GENERIC.clientTimeout,
      ),
    );
  }
  if (status === 401 || status === 403) {
    return failedJudgmentCompletion(
      deliveryId,
      deliveryError('provider_unauthorized', GENERIC.unauthorized),
    );
  }
  if (status >= 400 && status <= 499) {
    return failedJudgmentCompletion(
      deliveryId,
      deliveryError('provider_rejected', GENERIC.rejected),
    );
  }
  if (status >= 500 && status <= 599) {
    return unknownJudgmentCompletion(
      deliveryId,
      deliveryError('provider_transient', GENERIC.transient),
    );
  }
  return failedJudgmentCompletion(
    deliveryId,
    deliveryError('invalid_response', GENERIC.invalidResponse),
  );
}

/** Map a batch transport failure; rethrows non-HTTP errors. */
export function mapJudgmentError(
  deliveryId: string,
  err: unknown,
  questions: readonly JudgmentQuestion[],
): CapabilityCompletion<JudgmentBatchResult> {
  if (err instanceof HttpStatusError) {
    return mapJudgmentResponse(deliveryId, err.status, err.bodyText, questions);
  }
  if (err instanceof HttpBodyLimitError) {
    if (err.status >= 200 && err.status <= 299) {
      return failedJudgmentCompletion(
        deliveryId,
        deliveryError('invalid_response', GENERIC.invalidResponse),
      );
    }
    return mapJudgmentResponse(deliveryId, err.status, '', questions);
  }
  if (err instanceof HttpTransportError) {
    return err.kind === 'timeout'
      ? unknownJudgmentCompletion(
          deliveryId,
          deliveryError('transport_timeout', GENERIC.timeout),
        )
      : unknownJudgmentCompletion(
          deliveryId,
          deliveryError('transport_unreachable', GENERIC.unreachable),
        );
  }
  if (err instanceof HttpRedirectError) {
    return unknownJudgmentCompletion(
      deliveryId,
      deliveryError('redirect_refused', GENERIC.redirectRefused),
    );
  }
  if (err instanceof HttpTooManyRedirectsError) {
    return unknownJudgmentCompletion(
      deliveryId,
      deliveryError('too_many_redirects', GENERIC.redirectLoop),
    );
  }
  throw err;
}

/** JSON.parse supplies original numeric spelling; Number is never a canonical value. */
const WIRE_NUMBER = Symbol('System One numeric lexeme');
interface WireNumber { readonly [WIRE_NUMBER]: string }

function exactJson(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value !== 'number') return value;
    if (typeof context?.source !== 'string') throw new Error('Numeric source lexemes unavailable');
    return { [WIRE_NUMBER]: context.source } satisfies WireNumber;
  });
}

function wireDecimal(value: unknown): DecimalValue {
  if (typeof value !== 'object' || value === null || !(WIRE_NUMBER in value)) throw new Error('Expected JSON number');
  const text = (value as WireNumber)[WIRE_NUMBER];
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (match === null) throw new Error('Invalid numeric lexeme');
  const fraction = match[3] ?? '';
  const exponent = BigInt(match[4] ?? '0');
  const scale = BigInt(fraction.length) - exponent;
  // Bound before constructing strings; this is exact decimal expansion, never rounding.
  if (scale > 18n || scale < -38n) throw new Error('Decimal outside portable precision');
  const digits = (match[2] + fraction).replace(/^0+(?=\d)/, '');
  let plain: string;
  if (scale <= 0n) plain = digits + '0'.repeat(Number(-scale));
  else {
    const padded = digits.padStart(Number(scale) + 1, '0');
    plain = `${padded.slice(0, -Number(scale))}.${padded.slice(-Number(scale))}`;
  }
  return parseDecimal(match[1] + plain);
}

const DECIMAL_UNIT = 10n ** 18n;
const DECIMAL_TOLERANCE = 10n ** 12n;
function units(value: DecimalValue): bigint { return value.coef * 10n ** BigInt(18 - value.scale); }
function within(a: bigint, b: bigint): boolean { const delta = a - b; return delta >= -DECIMAL_TOLERANCE && delta <= DECIMAL_TOLERANCE; }
function probability(value: unknown): DecimalValue {
  const decimal = wireDecimal(value), scaled = units(decimal);
  if (scaled < 0n || scaled > DECIMAL_UNIT) throw new Error('Invalid probability');
  return decimal;
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected object');
  return value as Record<string, unknown>;
}
function usageCount(value: unknown): bigint {
  const decimal = wireDecimal(value), divisor = 10n ** BigInt(decimal.scale);
  if (decimal.coef % divisor !== 0n) throw new Error('Expected integer token count');
  const count = int64(decimal.coef / divisor);
  if (count < 0n) throw new Error('Negative token count');
  return count;
}

function staticResult(bodyText: string, spec: JudgmentSpec, order: readonly string[]): JudgmentEvaluationResult | null {
  try {
    const body = record(exactJson(bodyText)), answers = record(body['answers']), usage = record(body['usage']);
    if (!isNonEmptyString(body['model']) || !sameStringSet(Object.keys(answers), order)) return null;
    const result: Record<string, JudgmentEvaluationResult[string]> = Object.assign(Object.create(null), {
      specification_revision: spec.revision, model: body['model'],
      input_tokens: usageCount(usage['input_tokens']), output_tokens: usageCount(usage['output_tokens']),
    });
    const questions = new Map<string,
      | { readonly kind: 'noul'; readonly question: JudgmentSpec['noul'][number] }
      | { readonly kind: 'choice'; readonly question: JudgmentSpec['choice'][number] }
      | { readonly kind: 'score'; readonly question: JudgmentSpec['score'][number] }
    >([
      ...spec.noul.map(q => [q.id, { kind: 'noul' as const, question: q }] as const),
      ...spec.choice.map(q => [q.id, { kind: 'choice' as const, question: q }] as const),
      ...spec.score.map(q => [q.id, { kind: 'score' as const, question: q }] as const),
    ]);
    for (const id of order) {
      const entry = questions.get(id)!, answer = record(answers[id]);
      if (answer['type'] !== entry.kind) return null;
      if (entry.kind === 'noul') result[id] = { probability: probability(answer['noul']) };
      else if (entry.kind === 'choice') {
        const options = entry.question.options, distribution = record(answer['probabilities']);
        if (!sameStringSet(Object.keys(distribution), options.map(o => o.id)) ||
            typeof answer['choice'] !== 'string' || !options.some(o => o.id === answer['choice'])) return null;
        const probabilities = options.map(o => ({ option: o.id, probability: probability(distribution[o.id]) }));
        const sum = probabilities.reduce((sum, p) => sum + units(p.probability), 0n);
        const selected = probabilities.find(p => p.option === answer['choice'])!;
        if (!within(sum, DECIMAL_UNIT) || probabilities.some(p => units(p.probability) - units(selected.probability) > DECIMAL_TOLERANCE)) return null;
        result[id] = { choice: answer['choice'], probabilities, confidence: probability(answer['confidence']) };
      } else {
        const sourceLevels = entry.question.levels, distribution = record(answer['probabilities']), legend = record(answer['legend']);
        const indices = sourceLevels.map((_, index) => String(index));
        if (!sameStringSet(Object.keys(distribution), indices) || !sameStringSet(Object.keys(legend), indices)) return null;
        const levels = sourceLevels.map((level, index) => {
          if (legend[String(index)] !== level.description) throw new Error('Legend differs from source');
          return { level: level.id, index: BigInt(index), description: level.description, probability: probability(distribution[String(index)]) };
        });
        const score = wireDecimal(answer['score']), scaledScore = units(score);
        const sum = levels.reduce((sum, level) => sum + units(level.probability), 0n);
        const weighted = levels.reduce((sum, level) => sum + level.index * units(level.probability), 0n);
        if (scaledScore < 0n || scaledScore > BigInt(levels.length - 1) * DECIMAL_UNIT ||
            !within(sum, DECIMAL_UNIT) || !within(weighted, scaledScore)) return null;
        result[id] = { score, levels, confidence: probability(answer['confidence']) };
      }
    }
    return result as unknown as JudgmentEvaluationResult;
  } catch { return null; }
}

/** Rebuild from source values to validate revision, ordering, portable bounds and ownership. */
function staticRequest(input: JudgmentEvaluationInput, binding: InstalledJudgment['binding'], model: string): {
  readonly body: string; readonly specification: JudgmentSpec; readonly order: readonly string[];
} {
  const fail = (): never => { throw new JudgmentValidationError('Invalid static judgment request'); };
  const source = input?.source, spec = source?.specification;
  if (!spec || spec.declaration !== binding.judgment || spec.version !== binding.version ||
      typeof input.state !== 'string' || scalarLength(input.state) > 40000n || !Array.isArray(source.order) ||
      !Array.isArray(spec.noul) || !Array.isArray(spec.choice) || !Array.isArray(spec.score)) fail();
  const questions = new Map<string, StaticJudgmentQuestion>();
  const add = (question: StaticJudgmentQuestion): void => { if (questions.has(question.name)) fail(); questions.set(question.name, question); };
  for (const q of spec.noul) {
    if ((q.yes === null) !== (q.no === null) ||
        (q.yes !== null && typeof q.yes !== 'string') || (q.no !== null && typeof q.no !== 'string')) fail();
    add({ name: q.id, kind: 'noul', instructions: q.instructions,
      ...(q.yes === null ? {} : { yes: q.yes, no: q.no! }) });
  }
  for (const q of spec.choice) add({ name: q.id, kind: 'choice', instructions: q.instructions, options: q.options });
  for (const q of spec.score) add({ name: q.id, kind: 'score', instructions: q.instructions, levels: q.levels });
  if (!sameStringSet(source.order, [...questions.keys()])) fail();
  const frozen = freezeJudgmentSource(spec.declaration, { version: spec.version, questions: source.order.map(id => questions.get(id)!) }, spec.language);
  // A revision is trusted only after deriving it from the exact source declaration.
  if (frozen.specification.revision !== spec.revision ||
      !sameOrderedIds(frozen.specification.noul, spec.noul) || !sameOrderedIds(frozen.specification.choice, spec.choice) ||
      !sameOrderedIds(frozen.specification.score, spec.score)) fail();
  const wire: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const byId = new Map<string, unknown>();
  for (const q of frozen.specification.noul) byId.set(q.id, { type: 'noul', instructions: q.instructions,
    ...(q.yes === null ? {} : { criteria: { true: q.yes, false: q.no } }) });
  for (const q of frozen.specification.choice) byId.set(q.id, { type: 'choice', instructions: q.instructions,
    criteria: Object.fromEntries(q.options.map(o => [o.id, o.description])) });
  for (const q of frozen.specification.score) byId.set(q.id, { type: 'score', instructions: q.instructions,
    criteria: q.levels.map(l => l.description) });
  for (const id of frozen.order) wire[id] = byId.get(id);
  return { body: JSON.stringify({ model, state: input.state, questions: wire }), specification: frozen.specification, order: frozen.order };
}
function sameOrderedIds(a: readonly { readonly id: string }[], b: readonly { readonly id: string }[]): boolean {
  return a.length === b.length && a.every((q, index) => q.id === b[index].id);
}
function canonicalFailure(completion: CapabilityCompletion<JudgmentBatchResult>): CapabilityCompletion<JudgmentEvaluationResult> {
  if (completion.status === 'succeeded') return { delivery_id: completion.delivery_id, status: 'failed', result: null,
    error: deliveryError('invalid_response', GENERIC.invalidResponse) };
  return { delivery_id: completion.delivery_id, status: completion.status, result: null, error: completion.error };
}

/** Deployment-owned model and tokenizer; no implicit alias, budget estimate or discovery. */
export function createInstalledSystemOneJudgment(
  config: SystemOneConfig,
  binding: InstalledJudgment['binding'],
  profile: { readonly model: string; readonly maxInputTokens: number; readonly countInputTokens: (exactSerializedBody: string) => number },
): InstalledJudgment {
  if (!binding || !isNonEmptyString(binding.judgment) || !isNonEmptyString(binding.deployment) || !isNonEmptyString(binding.account) ||
      typeof binding.version !== 'bigint' || binding.version < 0n || int64(binding.version) !== binding.version ||
      !isNonEmptyString(profile.model) || !config.models.includes(profile.model) ||
      !Number.isSafeInteger(profile.maxInputTokens) || profile.maxInputTokens <= 0 || typeof profile.countInputTokens !== 'function') {
    throw new JudgmentValidationError('Invalid installed judgment binding or model profile');
  }
  const adapter = new SystemOneAdapter(config), frozenBinding = Object.freeze({ ...binding });
  const model = profile.model, maxInputTokens = profile.maxInputTokens, countInputTokens = profile.countInputTokens;
  return Object.freeze({ binding: frozenBinding,
    profile: Object.freeze({ provider: 'systemone', model, maxInputTokens, inputTokenization: 'deployment' as const }),
    judgment: Object.freeze({
      evaluate: (input: JudgmentEvaluationInput, options: { readonly deliveryId: string }) =>
        adapter.evaluateStatic(input, options, frozenBinding, { model, maxInputTokens, countInputTokens }),
      reconcile: async (deliveryId: string) => canonicalFailure(await adapter.reconcile(deliveryId)),
    }),
  });
}

export class SystemOneAdapter implements JudgmentPort {
  private readonly http: HttpClientConfig;
  private readonly models: readonly string[];
  private readonly minChoiceOptions: number;
  private readonly maxChoiceOptions: number;
  private readonly minScoreLevels: number;
  private readonly maxScoreLevels: number;
  private readonly maxRequestBytes: number | null;
  private readonly clock: Clock;

  constructor(config: SystemOneConfig) {
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
    for (const [name, value] of [
      ['minChoiceOptions', config.minChoiceOptions],
      ['maxChoiceOptions', config.maxChoiceOptions],
      ['minScoreLevels', config.minScoreLevels],
      ['maxScoreLevels', config.maxScoreLevels],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive integer`);
      }
    }
    if (config.minChoiceOptions > config.maxChoiceOptions) {
      throw new RangeError('minChoiceOptions must not exceed maxChoiceOptions');
    }
    if (config.minScoreLevels > config.maxScoreLevels) {
      throw new RangeError('minScoreLevels must not exceed maxScoreLevels');
    }
    if (
      config.maxRequestBytes !== null &&
      (!Number.isInteger(config.maxRequestBytes) || config.maxRequestBytes <= 0)
    ) {
      throw new RangeError('maxRequestBytes must be a positive integer or null');
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
    this.minChoiceOptions = config.minChoiceOptions;
    this.maxChoiceOptions = config.maxChoiceOptions;
    this.minScoreLevels = config.minScoreLevels;
    this.maxScoreLevels = config.maxScoreLevels;
    this.maxRequestBytes = config.maxRequestBytes;
    this.clock = config.clock ?? systemClock();
  }

  async evaluate(
    input: JudgmentBatchInput,
    options: { readonly deliveryId: string },
  ): Promise<CapabilityCompletion<JudgmentBatchResult>> {
    const deliveryId = options.deliveryId;
    if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
      throw new JudgmentValidationError(
        'deliveryId must be a non-empty string',
      );
    }
    const request = buildFrozenJudgmentRequest(input, {
      deliveryId,
      createdAt: this.clock.now(),
      models: this.models,
      minChoiceOptions: this.minChoiceOptions,
      maxChoiceOptions: this.maxChoiceOptions,
      minScoreLevels: this.minScoreLevels,
      maxScoreLevels: this.maxScoreLevels,
      maxRequestBytes: this.maxRequestBytes,
    });
    return this.send(serializeJudgmentBody(request), request.deliveryId,
      response => mapJudgmentResponse(request.deliveryId, response.status, response.bodyText, request.questions),
      err => mapJudgmentError(request.deliveryId, err, request.questions));
  }

  /** Canonical authored TEXT evaluation, separate from the legacy object-state batch API. */
  async evaluateStatic(
    input: JudgmentEvaluationInput,
    options: { readonly deliveryId: string },
    binding: InstalledJudgment['binding'],
    profile: { readonly model: string; readonly maxInputTokens: number; readonly countInputTokens: (body: string) => number },
  ): Promise<CapabilityCompletion<JudgmentEvaluationResult>> {
    const deliveryId = options.deliveryId;
    if (!isNonEmptyString(deliveryId)) throw new JudgmentValidationError('deliveryId must be a non-empty string');
    const request = staticRequest(input, binding, profile.model);
    if (!this.models.includes(profile.model)) throw new JudgmentValidationError('Static model is not bound');
    for (const q of request.specification.choice) {
      if (q.options.length < this.minChoiceOptions || q.options.length > this.maxChoiceOptions)
        throw new JudgmentValidationError('Static choice is unsupported by the deployment');
    }
    for (const q of request.specification.score) {
      if (q.levels.length < this.minScoreLevels || q.levels.length > this.maxScoreLevels)
        throw new JudgmentValidationError('Static score is unsupported by the deployment');
    }
    if (this.maxRequestBytes !== null && new TextEncoder().encode(request.body).byteLength > this.maxRequestBytes)
      throw new JudgmentValidationError('Static judgment exceeds the deployment byte budget');
    let tokens: number;
    try { tokens = profile.countInputTokens(request.body); }
    catch { throw new JudgmentValidationError('Deployment input tokenization unavailable'); }
    if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > profile.maxInputTokens)
      throw new JudgmentValidationError('Static judgment exceeds the deployment token budget');
    return this.send(request.body, deliveryId, response => {
      if (response.status < 200 || response.status > 299)
        return canonicalFailure(mapJudgmentResponse(deliveryId, response.status, response.bodyText, []));
      const result = staticResult(response.bodyText, request.specification, request.order);
      return result === null
        ? { delivery_id: deliveryId, status: 'failed', result: null, error: deliveryError('invalid_response', GENERIC.invalidResponse) }
        : { delivery_id: deliveryId, status: 'succeeded', result, error: null };
    }, err => canonicalFailure(mapJudgmentError(deliveryId, err, [])));
  }

  /** Shared transport, failure classification and completion validation for both surfaces. */
  private async send<T>(
    body: string,
    deliveryId: string,
    normalize: (response: { readonly status: number; readonly bodyText: string }) => CapabilityCompletion<T>,
    failure: (err: unknown) => CapabilityCompletion<T>,
  ): Promise<CapabilityCompletion<T>> {
    let completion: CapabilityCompletion<T>;
    try {
      const response = await httpRequest(this.http, {
        method: 'POST',
        path: SYSTEMONE_PATH,
        body,
      });
      completion = normalize(response);
    } catch (err) {
      completion = failure(err);
    }
    if (completion.delivery_id !== deliveryId) throw new Error('Judgment completion identity mismatch');
    assertValidCompletion(completion);
    return completion;
  }

  /**
   * Reconcile an uncertain batch. System One documents no batch
   * lookup, so this honestly stays `unknown` instead of inventing one.
   */
  async reconcile(
    deliveryId: string,
  ): Promise<CapabilityCompletion<JudgmentBatchResult>> {
    if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
      throw new JudgmentValidationError(
        'deliveryId must be a non-empty string',
      );
    }
    return unknownJudgmentCompletion(
      deliveryId,
      deliveryError('no_run_resume', GENERIC.noResume),
    );
  }
}
