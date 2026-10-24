/**
 * Portable dispatch staging join. Returns effects for the caller's existing
 * fenced commit; this module never opens a transaction or sends a request.
 */
import type {
  DomainWrite, OperationId, OperationName, OutboxIntent, RecordId,
  OccurrenceId, OutboxId, DeliveryRef,
  FrameworkFilePayloadOrigin, StoredRow,
} from '@canlang/contracts';
import type { SystemCommandContext, SystemCommandDef, SystemStaging } from '@canlang/state';
import { makeDeliveryRef } from '@canlang/values';
import { checkArgs, argString, argNullableString, argRecord } from './arguments.js';
import type { FanoutLineage } from '../intent/index.js';
import { stageOutboxIntentAsync } from '../intent/staging.js';
import type { StageOutboxIntentInput, StagedOutboxIntent } from '../intent/staging.js';
import {
  KernelTableError, snapshotKernelJsonValue, WORK_DISPATCH_MODEL, newDispatchRow, readDispatchRow,
  DISPATCH_IMAGE_CORRELATION_FIELDS, readDispatchImageCorrelation, type DispatchImageCorrelation,
  dispatchGenerationTargetProfile, readDispatchSourceGuard, type DispatchSourceGuard,
  readWorkFilePayloadOrigin, type DispatchRowData,
} from './tables.js';

/** L3 staging bound (`STAGING_MAX_ID_LENGTH`); length is UTF-16 units. */
const STAGE_INTENT_ID_MAX_LENGTH = 128;

interface ParsedStageIntent {
  intentId: string;
  operation: string;
  originOperationId: string;
  source: string;
  occurrenceIndex: number;
  request: Record<string, unknown>;
  originOccurrence: OccurrenceId | null;
  guard: string | null;
  guardVerdict: boolean | null;
  fanout: FanoutLineage | null;
  correlation: DispatchImageCorrelation | null;
  sourceGuard: DispatchSourceGuard | null;
  filePayloadOrigin: FrameworkFilePayloadOrigin | null;
  sendInputs: Readonly<Record<string, unknown>> | null;
  sendInputsOrigin: FrameworkFilePayloadOrigin | null;
  queuePayload: Readonly<Record<string, unknown>> | null;
  queuePayloadOrigin: FrameworkFilePayloadOrigin | null;
}

function argGenerationCorrelation(record: Readonly<Record<string, unknown>>, source: string,
  request: Record<string, unknown>, what: string): DispatchImageCorrelation | null {
  if (!Object.hasOwn(record, 'correlation')) return null;
  const raw = argRecord(record, 'correlation', what);
  if (Reflect.ownKeys(raw).length !== DISPATCH_IMAGE_CORRELATION_FIELDS.length ||
      Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !DISPATCH_IMAGE_CORRELATION_FIELDS.includes(key as typeof DISPATCH_IMAGE_CORRELATION_FIELDS[number]))) {
    throw new KernelTableError(`${what}: original generation correlation has unknown or missing fields.`);
  }
  const correlation = readDispatchImageCorrelation(raw);
  const args = request['arguments'];
  const profile = dispatchGenerationTargetProfile(source);
  const control = profile?.role === 'control';
  const value = typeof args === 'object' && args !== null && !Array.isArray(args)
    ? control ? args : (args as Record<string, unknown>)['value'] : undefined;
  assertGenerationCarrier(request, correlation, profile, control, value, what);
  return correlation;
}

function assertGenerationCarrier(request: Record<string, unknown>,
  correlation: DispatchImageCorrelation | null, profile: ReturnType<typeof dispatchGenerationTargetProfile>,
  control: boolean, value: unknown, what: string): void {
  if (profile === null || correlation === null ||
      request['binding'] !== correlation.requestBinding || request['from'] !== correlation.requestFrom ||
      typeof value !== 'object' || value === null || Array.isArray(value) ||
      (control && (Reflect.ownKeys(value).length !== 2 || Reflect.ownKeys(value).some(key => key !== 'source' && key !== 'revision'))) ||
      (value as Record<string, unknown>)['source'] !== correlation.requestSource ||
      (value as Record<string, unknown>)['revision'] !== correlation.requestRevision) {
    throw new KernelTableError(`${what}: original generation correlation disagrees with its retained carrier.`);
  }
}

function argOccurrenceIndex(
  record: Readonly<Record<string, unknown>>,
  field: string,
  what: string,
): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new KernelTableError(`${what}: ${field} must be an integer >= 0.`);
  }
  return value;
}

function argGuard(
  record: Readonly<Record<string, unknown>>,
  what: string,
): { guard: string | null; verdict: boolean | null } {
  const guard = record['guard'];
  const verdict = record['guardVerdict'];
  if (guard === null || guard === undefined) {
    if (verdict !== null && verdict !== undefined) {
      throw new KernelTableError(
        `${what}: guardVerdict without a guard is incoherent (unconditional intents carry none).`,
      );
    }
    return { guard: null, verdict: null };
  }
  if (typeof guard !== 'string' || guard === '') {
    throw new KernelTableError(`${what}: guard must be a non-empty string or null.`);
  }
  if (typeof verdict !== 'boolean') {
    throw new KernelTableError(
      `${what}: guardVerdict must be a boolean when a guard is present (stage-time verdict).`,
    );
  }
  return { guard, verdict };
}

function argFanout(
  record: Readonly<Record<string, unknown>>,
  what: string,
): FanoutLineage | null {
  const fanout = record['fanout'];
  if (fanout === null || fanout === undefined) return null;
  // T33-carried lineage: shape-validated and echoed, never interpreted.
  const lineage = argRecord(record, 'fanout', what);
  const cohortId = argString(lineage, 'cohortId', `${what}.fanout`);
  const parentOccurrence = argString(lineage, 'parentOccurrence', `${what}.fanout`);
  const childIndex = argOccurrenceIndex(lineage, 'childIndex', `${what}.fanout`);
  const checkpointId = argNullableString(lineage, 'checkpointId', `${what}.fanout`);
  if (checkpointId !== null && checkpointId === '') {
    throw new KernelTableError(`${what}.fanout: checkpointId must be non-empty or null.`);
  }
  return { cohortId, parentOccurrence, childIndex, checkpointId };
}

function parseStageIntent(
  candidate: unknown,
  index: number,
  what: string,
  context: SystemCommandContext,
): ParsedStageIntent {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    throw new KernelTableError(`${what}: intents[${index}] must be an object.`);
  }
  const record = candidate as Readonly<Record<string, unknown>>;
  const item = `${what}: intents[${index}]`;
  const intentId = argString(record, 'intentId', item);
  if (intentId.length > STAGE_INTENT_ID_MAX_LENGTH) {
    throw new KernelTableError(
      `${item}: intentId exceeds ${STAGE_INTENT_ID_MAX_LENGTH} characters.`,
    );
  }
  const { guard, verdict } = argGuard(record, item);
  const source = argString(record, 'source', item);
  const request = argRecord(record, 'request', item);
  const sourceGuard = readDispatchSourceGuard(record);
  if (sourceGuard !== null && (sourceGuard.rule !== guard || verdict !== true)) {
    throw new KernelTableError(`${item}: sourceGuard requires its matching true guard verdict.`);
  }
  const filePayloadOrigin = readWorkFilePayloadOrigin(record,
    { id: intentId as RecordId, created: context.now, createdBy: context.actor },
    WORK_DISPATCH_MODEL, 'sourceGuard', 'deferred-input') ?? null;
  if ((sourceGuard === null) !== (filePayloadOrigin === null)) {
    throw new KernelTableError(`${item}: source guard requires its original atomic payload header.`);
  }
  const sendInputsOrigin = readWorkFilePayloadOrigin(record,
    { id: intentId as RecordId, created: context.now, createdBy: context.actor }, WORK_DISPATCH_MODEL, 'sendInputs', 'deferred-input', 'sendInputsOrigin') ?? null;
  const sendInputs = Object.hasOwn(record, 'sendInputs') ? snapshotKernelJsonValue(argRecord(record, 'sendInputs', item), 'SEND inputs') : null;
  if ((sendInputsOrigin === null) !== (sendInputs === null) || sendInputs !== null && !sameSendData(sendInputs, request['arguments'])) {
    throw new KernelTableError(`${item}: SEND inputs differ from their original request.`);
  }
  if (sendInputsOrigin !== null) {
    const origin = sendInputsOrigin.origin;
    if (origin.kind !== 'send-input' || origin.intent.operation !== record['operation'] ||
        !sameSendData(origin.request, { binding: request['binding'], from: request['from'] })) {
      throw new KernelTableError(`${item}: SEND inputs differ from their original binding/caller.`);
    }
  }
  const queuePayloadOrigin = readWorkFilePayloadOrigin(record,
    { id: intentId as RecordId, created: context.now, createdBy: context.actor }, WORK_DISPATCH_MODEL, 'queuePayload', 'deferred-input', 'queuePayloadOrigin') ?? null;
  const queuePayload = Object.hasOwn(record, 'queuePayload') ? snapshotKernelJsonValue(argRecord(record, 'queuePayload', item), 'queue publication') : null;
  if ((queuePayloadOrigin === null) !== (queuePayload === null) || queuePayload !== null &&
      (!source.endsWith('.publish') || !sameSendData(queuePayload, request['arguments']))) throw new KernelTableError(`${item}: queue publication differs from its original payload.`);
  return {
    intentId,
    operation: argString(record, 'operation', item),
    originOperationId: argString(record, 'originOperationId', item),
    source,
    occurrenceIndex: argOccurrenceIndex(record, 'occurrenceIndex', item),
    request,
    originOccurrence: argNullableString(record, 'originOccurrence', item) as OccurrenceId | null,
    guard,
    guardVerdict: verdict,
    fanout: argFanout(record, item),
    correlation: argGenerationCorrelation(record, source, request, item),
    sourceGuard,
    filePayloadOrigin, sendInputs, sendInputsOrigin, queuePayload, queuePayloadOrigin,
  };
}

/**
 * `work.dispatch.stage {operationId, intents[]}`: the atomic staging join
 * for the operator path. Stages each intent's L4 `work.dispatch` row
 * (with its stage-time guard verdict pinned) AND its L3 `OutboxIntent`
 * in ONE fenced batch — the registry commits `writes` + `outbox`
 * together, so a trigger rollback voids both and one fence revision
 * carries the join.
 *
 * Wiring contract (T24b): `operationId` MUST equal the run's
 * operationId — the stage has no access to it, so the assembly passes
 * the same key in both places and the registry rejects mismatches
 * fail-closed. The TRUE trigger origin rides each intent's
 * `originOperationId` onto the dispatch row; the L3 intent's
 * operationId is the run key (staging forbids cross-operation intents).
 *
 * Guard-false intents stage a pinned-`false` dispatch row (the durable
 * skip record — claims refuse `guard-false`) and NO L3 outbox intent
 * (nothing dispatchable), plus an explicit skip entry in the result.
 * Skips are never silent: every input intent appears in exactly one of
 * `staged`, `skipped` or `replayed`.
 *
 * Exactly-once staging under retried runs: an intent whose dispatch row
 * already exists replays without writes when origin + verdict match
 * (a prior run committed both halves together), and throws on mismatch
 * instead of silently adopting a foreign row.
 */
function assertReplayedIntent(data: DispatchRowData, intent: ParsedStageIntent, what: string): void {
  if (
    data.intentId !== intent.intentId ||
    data.operationId !== intent.originOperationId ||
    data.source !== intent.source ||
    data.occurrenceIndex !== intent.occurrenceIndex ||
    data.originOccurrence !== intent.originOccurrence ||
    data.guardVerdict !== intent.guardVerdict ||
    !sameSendData(data.sourceGuard ?? null, intent.sourceGuard) ||
    !sameSendData(data.filePayloadOrigin ?? null, intent.filePayloadOrigin) ||
    !sameSendData(data.sendInputs ?? null, intent.sendInputs) || !sameSendData(data.sendInputsOrigin ?? null, intent.sendInputsOrigin) ||
    !sameSendData(data.queuePayload ?? null, intent.queuePayload) || !sameSendData(data.queuePayloadOrigin ?? null, intent.queuePayloadOrigin) ||
    DISPATCH_IMAGE_CORRELATION_FIELDS.some(field => data[field] !== intent.correlation?.[field])
  ) {
    throw new KernelTableError(
      `${what}: intent ${JSON.stringify(intent.intentId)} already staged ` +
        'with a different origin or verdict.',
    );
  }
}
interface FreshIntentEffects {
  readonly writes: DomainWrite[]; readonly outbox: OutboxIntent[];
  readonly staged: unknown[]; readonly skipped: unknown[];
}
function stageFreshIntent(ctx: SystemCommandContext, operationId: string,
  intent: ParsedStageIntent, effects: FreshIntentEffects): void {
  const fresh = newDispatchRow(
    {
      intentId: intent.intentId as OutboxId,
      operationId: intent.originOperationId,
      source: intent.source,
      occurrenceIndex: intent.occurrenceIndex,
      originOccurrence: intent.originOccurrence,
      ...(intent.correlation ?? {}),
      ...(intent.sourceGuard === null ? {} : { sourceGuard: intent.sourceGuard }),
      ...(intent.filePayloadOrigin === null ? {} : { filePayloadOrigin: intent.filePayloadOrigin }),
      ...(intent.sendInputs === null ? {} : { sendInputs: intent.sendInputs, sendInputsOrigin: intent.sendInputsOrigin! }),
      ...(intent.queuePayload === null ? {} : { queuePayload: intent.queuePayload, queuePayloadOrigin: intent.queuePayloadOrigin! }),
    },
    { nowMs: ctx.now, actor: ctx.actor },
  );
  effects.writes.push({
    kind: 'insert',
    model: WORK_DISPATCH_MODEL,
    row: { ...fresh, data: { ...readDispatchRow(fresh), guardVerdict: intent.guardVerdict } },
  });
  const origin = {
    operationId: intent.originOperationId,
    source: intent.source,
    occurrenceIndex: intent.occurrenceIndex,
    originOccurrence: intent.originOccurrence,
  };
  if (intent.guardVerdict === false) {
    effects.skipped.push({
      intentId: intent.intentId,
      guard: intent.guard,
      verdict: false,
      reason: 'guard-false',
      fanout: intent.fanout,
    });
    return;
  }
  effects.outbox.push({
    intentId: intent.intentId,
    operation: intent.operation as OperationName,
    operationId: operationId as OperationId,
    target: intent.source,
    arguments: intent.request,
    occurrenceIndex: intent.occurrenceIndex,
    ...(intent.guard !== null ? { dispatchGuard: intent.guard } : {}),
  });
  effects.staged.push({ intentId: intent.intentId, origin, guard: intent.guard, fanout: intent.fanout });
}
export const workDispatchStageCommand: SystemCommandDef = {
  name: 'work.dispatch.stage',
  stage: async (args, ctx) => {
    const what = 'work.dispatch.stage';
    checkArgs(args, what);
    const operationId = argString(args, 'operationId', what);
    const rawIntents = args['intents'];
    if (!Array.isArray(rawIntents) || rawIntents.length === 0) {
      throw new KernelTableError(`${what}: intents must be a non-empty array.`);
    }
    const intents = rawIntents.map((candidate, index) => parseStageIntent(candidate, index, what, ctx));
    const seen = new Set<string>();
    for (const intent of intents) {
      if (seen.has(intent.intentId)) {
        throw new KernelTableError(
          `${what}: duplicate intent id ${JSON.stringify(intent.intentId)}.`,
        );
      }
      seen.add(intent.intentId);
    }
    const writes: DomainWrite[] = [];
    const outbox: OutboxIntent[] = [];
    const staged: unknown[] = [];
    const skipped: unknown[] = [];
    const replayed: string[] = [];
    for (const intent of intents) {
      const existing = await ctx.load(WORK_DISPATCH_MODEL, intent.intentId as RecordId);
      if (existing !== null) {
        assertReplayedIntent(readDispatchRow(existing), intent, what);
        replayed.push(intent.intentId);
        continue;
      }
      stageFreshIntent(ctx, operationId, intent, { writes, outbox, staged, skipped });
    }
    return { writes, outbox, result: { staged, skipped, replayed } };
  },
};

// Preserve the genuine producer even if a legacy caller replaces the exported command method.
const stageCanonicalDispatch = workDispatchStageCommand.stage;

/** One provisional delivery and its effects; neither is committed here. */
export interface CanonicalSendStaging {
  readonly effects: SystemStaging;
  readonly delivery: DeliveryRef;
}

/** Correlation is supplied only by the genuine checked request/scope producer. */
export interface CanonicalSendInput extends StageOutboxIntentInput {
  readonly correlation?: DispatchImageCorrelation;
  readonly sourceGuard?: DispatchSourceGuard;
}

/** Literal source-verified native adapter; State prepares the actual atomic
 * typed lexical payload header and genuine receiving File observations. */
export interface CanonicalSendGuardOriginProducer {
  readonly prepareSendInputsOrigin?: (row: Readonly<StoredRow>, intent: Readonly<OutboxIntent>) => Promise<FrameworkFilePayloadOrigin | undefined>;
  readonly prepareQueuePayloadOrigin?: (row: Readonly<StoredRow>, intent: Readonly<OutboxIntent>) => Promise<FrameworkFilePayloadOrigin>;
  readonly prepareSourceGuardOrigin?: (row: Readonly<StoredRow>,
    intent: Readonly<OutboxIntent>) => Promise<FrameworkFilePayloadOrigin>;
}

interface CanonicalSendSeal {
  readonly input: CanonicalSendInput;
  readonly context: SystemCommandContext;
  readonly inputSnapshot: unknown;
  readonly contextSnapshot: Readonly<SystemCommandContext>;
}
const canonicalSendSeals = new WeakMap<object, CanonicalSendSeal>();

const isSendPrimitive = (item: unknown): boolean => item === null || typeof item === 'string' ||
  typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item);
const checkSendArrayShape = (source: object, names: string[]): boolean => {
  const length = Object.getOwnPropertyDescriptor(source, 'length');
  if (length === undefined || !('value' in length) || typeof length.value !== 'number') return false;
  const count: number = length.value;
  if (names.length !== count + 1) return false;
  return !names.some(key => key !== 'length' &&
    (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= count));
};
/** Strict iterative own-JSON copy: shared subgraphs are harmless; cycles are not. */
function copySendData(value: unknown, requireFrozen: boolean): { readonly value: unknown } | null {
  const primitive = isSendPrimitive;
  if (primitive(value)) return { value };
  type Frame = { source: object; target: object; keys: string[]; index: number };
  const copies = new Map<object, object>(), active = new Set<object>();
  const prepare = (source: unknown): Frame | null => {
    if (typeof source !== 'object' || source === null || requireFrozen && !Object.isFrozen(source)) return null;
    const proto = Object.getPrototypeOf(source);
    const array = Array.isArray(source);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return null;
    const keys = Reflect.ownKeys(source);
    if (keys.some(key => typeof key !== 'string')) return null;
    const names = keys as string[];
    if (array && !checkSendArrayShape(source, names)) return null;
    const fields = array ? names.filter(key => key !== 'length') : names;
    for (const key of fields) {
      const member = Object.getOwnPropertyDescriptor(source, key);
      if (member === undefined || !('value' in member) || !member.enumerable) return null;
    }
    const target: object = array ? [] : Object.create(proto) as object;
    copies.set(source, target); active.add(source);
    return { source, target, keys: fields, index: 0 };
  };
  const first = prepare(value); if (first === null) return null;
  const stack = [first];
  while (stack.length !== 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.index === frame.keys.length) {
      Object.freeze(frame.target); active.delete(frame.source); stack.pop(); continue;
    }
    const key = frame.keys[frame.index++]!;
    const member = Object.getOwnPropertyDescriptor(frame.source, key);
    if (member === undefined || !('value' in member) || !member.enumerable) return null;
    let copied: unknown = member.value;
    if (!primitive(copied)) {
      if (typeof copied !== 'object' || copied === null || active.has(copied)) return null;
      const previous = copies.get(copied);
      if (previous !== undefined) copied = previous;
      else {
        const child = prepare(copied); if (child === null) return null;
        copied = child.target; stack.push(child);
      }
    }
    Object.defineProperty(frame.target, key, { value: copied, enumerable: true });
  }
  return { value: first.target };
}

/** Exact original SEND correspondence, shared by retained reads and acknowledgement. */
export function readRetainedSendInputs(row: StoredRow, supplied: OutboxIntent): {
  readonly inputs: Readonly<Record<string, unknown>>; readonly binding: FrameworkFilePayloadOrigin;
} {
  const intent = snapshotKernelJsonValue(supplied, 'retained SEND intent');
  const data = readDispatchRow(row), binding = data.sendInputsOrigin;
  if (row.archivedAt !== null || binding === undefined || data.sendInputs === undefined || binding.origin.kind !== 'send-input' ||
      Object.keys(intent.arguments).length !== 3 ||
      !sameSendData(data.sendInputs, intent.arguments['arguments']) ||
      !sameSendData(binding.origin.intent, { intentId: intent.intentId, operation: intent.operation,
        operationId: intent.operationId, target: intent.target, occurrenceIndex: intent.occurrenceIndex }) ||
      !sameSendData(binding.origin.request, { binding: intent.arguments['binding'], from: intent.arguments['from'] })) {
    throw new KernelTableError('Retained SEND requires its exact original atomic inputs, binding and intent.');
  }
  return { inputs: data.sendInputs, binding };
}

function sameSendData(left: unknown, right: unknown): boolean {
  const pending: Array<[unknown, unknown]> = [[left, right]];
  const compared = new Map<object, Set<object>>();
  while (pending.length !== 0) {
    const [a, b] = pending.pop()!;
    if (Object.is(a, b)) continue;
    if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null ||
        Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    const visited = compared.get(a) ?? new Set<object>();
    if (visited.has(b)) continue;
    visited.add(b); compared.set(a, visited);
    const keys = Reflect.ownKeys(a), other = new Set(Reflect.ownKeys(b));
    if (keys.length !== other.size || keys.some(key => !other.has(key))) return false;
    for (const key of keys) {
      const x = Object.getOwnPropertyDescriptor(a, key), y = Object.getOwnPropertyDescriptor(b, key);
      if (x === undefined || y === undefined || !('value' in x) || !('value' in y) || x.enumerable !== y.enumerable) return false;
      pending.push([x.value, y.value]);
    }
  }
  return true;
}

function captureCanonicalSend(input: CanonicalSendInput, context: SystemCommandContext): CanonicalSendSeal | null {
  try {
    return captureCanonicalSendData(input, context);
  } catch {
    // Exotic/refused descriptors cannot grant provenance or alter legacy staging eligibility.
    return null;
  }
}

const checkCanonicalInputKeys = (input: CanonicalSendInput, copied: object): boolean => {
  const keys = Reflect.ownKeys(copied);
  const required = ['operationId', 'source', 'occurrenceIndex', 'request', 'originOccurrence'];
  if (required.some(key => !keys.includes(key)) || keys.some(key => !required.includes(key as string) && key !== 'correlation' && key !== 'sourceGuard')) return false;
  if (!keys.includes('correlation') && Reflect.has(input, 'correlation')) return false;
  if (!keys.includes('sourceGuard') && Reflect.has(input, 'sourceGuard')) return false;
  readDispatchSourceGuard(input as unknown as Readonly<Record<string, unknown>>);
  return true;
};
const snapshotCanonicalContext = (context: SystemCommandContext): Record<string, unknown> | null => {
  if (typeof context !== 'object' || context === null || !Object.isFrozen(context) ||
      (Object.getPrototypeOf(context) !== Object.prototype && Object.getPrototypeOf(context) !== null)) return null;
  const contextKeys = ['actor', 'now', 'operation', 'load', 'query'];
  if (Reflect.ownKeys(context).length !== contextKeys.length) return null;
  const snapshot = Object.create(Object.getPrototypeOf(context)) as Record<string, unknown>;
  for (const key of contextKeys) {
    const member = Object.getOwnPropertyDescriptor(context, key);
    if (member === undefined || !('value' in member) || !member.enumerable) return null;
    Object.defineProperty(snapshot, key, { value: member.value, enumerable: true });
  }
  if (typeof snapshot['actor'] !== 'string' || snapshot['actor'] === '' ||
      typeof snapshot['operation'] !== 'string' || snapshot['operation'] === '' ||
      typeof snapshot['now'] !== 'number' || !Number.isFinite(snapshot['now']) || snapshot['now'] < 0 ||
      typeof snapshot['load'] !== 'function' || typeof snapshot['query'] !== 'function') return null;
  return snapshot;
};
function captureCanonicalSendData(input: CanonicalSendInput, context: SystemCommandContext): CanonicalSendSeal | null {
  const inputCopy = copySendData(input, true);
  if (inputCopy === null || typeof inputCopy.value !== 'object' || inputCopy.value === null || Array.isArray(inputCopy.value)) return null;
  if (!checkCanonicalInputKeys(input, inputCopy.value)) return null;
  const snapshot = snapshotCanonicalContext(context);
  if (snapshot === null) return null;
  return { input, context, inputSnapshot: inputCopy.value,
    contextSnapshot: Object.freeze(snapshot) as unknown as SystemCommandContext };
}

/**
 * Read and consume genuine Work staging from the exact original input/context.
 * Positive evidence requires a fully frozen own-data input and a frozen context
 * with its exact reader functions; mutable legacy calls remain unsealed.
 * State owns active invocation lifetime, storage authority and the fenced commit.
 */
export function readCanonicalSendStaging(
  value: unknown, expectedInput: CanonicalSendInput, expectedContext: SystemCommandContext,
): CanonicalSendStaging | null {
  if (typeof value !== 'object' || value === null) return null;
  const seal = canonicalSendSeals.get(value);
  if (seal === undefined || seal.input !== expectedInput || seal.context !== expectedContext) return null;
  const current = captureCanonicalSend(expectedInput, expectedContext);
  if (current === null || !sameSendData(current.inputSnapshot, seal.inputSnapshot) ||
      !sameSendData(current.contextSnapshot, seal.contextSnapshot)) return null;
  canonicalSendSeals.delete(value);
  return value as CanonicalSendStaging;
}

/**
 * Stage one checked bound send in the admitted scenario's
 * existing transaction. The caller resolves the exact compiler binding,
 * checks and wire-encodes its request, and allocates the occurrence index in
 * evaluation order. `input.source` is the checked capability operation;
 * `ctx.operation` and `input.operationId` are the admitted business origin.
 * Bound sends carry the Contracts `BoundCapabilityRequest` in `input.request`
 * so the exact logical binding and deployment route survive persistence.
 *
 * An optional sourceGuard retains the verified source-stage true declaration
 * and encoded lexical inputs separately from provider arguments. Shape grants
 * no execution authority; source-stage false bypass belongs to State.
 *
 * Only readers are accepted. The caller collects these writes/outbox effects
 * alongside domain writes, history and uniques for ONE fenced State commit;
 * a failed scenario drops them all. No binding or request schema is inferred
 * here, and no transport, registry run or separate commit occurs.
 */
type GuardOriginPrepare = NonNullable<CanonicalSendGuardOriginProducer['prepareSourceGuardOrigin']>;
type SendInputsOriginPrepare = NonNullable<CanonicalSendGuardOriginProducer['prepareSendInputsOrigin']>;
type QueueOriginPrepare = NonNullable<CanonicalSendGuardOriginProducer['prepareQueuePayloadOrigin']>;
type CanonicalStagedItem = StagedOutboxIntent['item'];
const readCanonicalSendProducers = (input: CanonicalSendInput, guardOrigin: CanonicalSendGuardOriginProducer | undefined) => {
  const sourceGuard = readDispatchSourceGuard(input as unknown as Readonly<Record<string, unknown>>);
  const descriptor = guardOrigin === undefined ? undefined : Object.getOwnPropertyDescriptor(guardOrigin, 'prepareSourceGuardOrigin');
  const prepare = descriptor !== undefined && 'value' in descriptor && descriptor.enumerable ? descriptor.value : undefined;
  if (sourceGuard !== null && (typeof prepare !== 'function' || guardOrigin === undefined ||
      !Object.hasOwn(guardOrigin, 'prepareSourceGuardOrigin'))) {
    throw new KernelTableError('Guarded canonical send requires its installed original payload producer.');
  }
  if (guardOrigin !== undefined && Reflect.ownKeys(guardOrigin).some(key => key !== 'prepareSourceGuardOrigin' && key !== 'prepareQueuePayloadOrigin' && key !== 'prepareSendInputsOrigin')) throw new KernelTableError('Canonical send received an unknown origin producer.');
  const queueDescriptor = guardOrigin === undefined ? undefined : Object.getOwnPropertyDescriptor(guardOrigin, 'prepareQueuePayloadOrigin');
  const prepareQueue = queueDescriptor !== undefined && 'value' in queueDescriptor && queueDescriptor.enumerable ? queueDescriptor.value : undefined;
  if (queueDescriptor !== undefined && typeof prepareQueue !== 'function') throw new KernelTableError('Queue publication needs its actual installed origin producer.');
  if (sourceGuard === null && descriptor !== undefined) {
    throw new KernelTableError('Unguarded send cannot acquire an orphan guard origin.');
  }
  const inputsDescriptor = guardOrigin === undefined ? undefined : Object.getOwnPropertyDescriptor(guardOrigin, 'prepareSendInputsOrigin');
  const prepareInputs = inputsDescriptor !== undefined && 'value' in inputsDescriptor && inputsDescriptor.enumerable ? inputsDescriptor.value : undefined;
  if (inputsDescriptor !== undefined && typeof prepareInputs !== 'function') throw new KernelTableError('SEND inputs need their actual installed origin producer.');
  return { sourceGuard, prepare: prepare as GuardOriginPrepare | undefined, prepareQueue: prepareQueue as QueueOriginPrepare | undefined, prepareInputs: prepareInputs as SendInputsOriginPrepare | undefined };
};
const readSendCorrelation = (input: CanonicalSendInput): DispatchImageCorrelation | undefined => {
  if (input.correlation === undefined) return undefined;
  if (Reflect.ownKeys(input.correlation).length !== DISPATCH_IMAGE_CORRELATION_FIELDS.length) {
    throw new KernelTableError('Canonical send original generation correlation has unknown or missing fields.');
  }
  const correlation = readDispatchImageCorrelation(input.correlation) ?? undefined;
  if (correlation === undefined) throw new KernelTableError('Canonical send original generation correlation is missing.');
  return correlation;
};
const prepareGuardedOrigin = async (prepare: GuardOriginPrepare, ctx: SystemCommandContext,
  item: CanonicalStagedItem, sourceGuard: DispatchSourceGuard,
  correlation: DispatchImageCorrelation | undefined): Promise<FrameworkFilePayloadOrigin> => {
  const row = newDispatchRow({ intentId: item.id as OutboxId, operationId: item.operationId,
    source: item.source, occurrenceIndex: item.occurrenceIndex, originOccurrence: item.originOccurrence,
    sourceGuard, ...(correlation === undefined ? {} : correlation) }, { nowMs: ctx.now, actor: ctx.actor });
  const intent: OutboxIntent = { intentId: item.id, operation: ctx.operation as OperationName,
    operationId: item.operationId as OperationId, target: item.source, arguments: item.request,
    occurrenceIndex: item.occurrenceIndex, dispatchGuard: sourceGuard.rule };
  const guarded = { ...row, data: { ...row.data, guardVerdict: true } };
  const filePayloadOrigin = await prepare(guarded, intent);
  readDispatchRow({ ...guarded, data: { ...guarded.data, filePayloadOrigin } });
  return filePayloadOrigin;
};
const prepareSendInputs = async (prepare: SendInputsOriginPrepare, ctx: SystemCommandContext,
  item: CanonicalStagedItem, sourceGuard: DispatchSourceGuard | null,
  filePayloadOrigin: FrameworkFilePayloadOrigin | undefined) => {
  const sendInputs = snapshotKernelJsonValue(argRecord(item.request, 'arguments', 'SEND inputs'), 'SEND inputs');
  const row = newDispatchRow({ intentId: item.id as OutboxId, operationId: item.operationId, source: item.source,
    occurrenceIndex: item.occurrenceIndex, originOccurrence: item.originOccurrence,
    ...(sourceGuard === null ? {} : { sourceGuard }), ...(filePayloadOrigin === undefined ? {} : { filePayloadOrigin }) }, { nowMs: ctx.now, actor: ctx.actor });
  const intent: OutboxIntent = { intentId: item.id as OutboxId, operation: ctx.operation as OperationName,
    operationId: item.operationId as OperationId, target: item.source, arguments: item.request,
    occurrenceIndex: item.occurrenceIndex, ...(sourceGuard === null ? {} : { dispatchGuard: sourceGuard.rule }) };
  const sendInputsOrigin = await prepare({ ...row, data: { ...row.data, sendInputs, ...(sourceGuard === null ? {} : { guardVerdict: true }) } }, intent);
  if (sendInputsOrigin === undefined) return undefined;
  const complete = { ...row, data: { ...row.data, sendInputs, sendInputsOrigin, ...(sourceGuard === null ? {} : { guardVerdict: true }) } };
  readDispatchRow(complete);
  const origin = sendInputsOrigin.origin;
  if (origin.kind !== 'send-input' || !sameSendData(origin.intent, { intentId: intent.intentId, operation: intent.operation,
    operationId: intent.operationId, target: intent.target, occurrenceIndex: intent.occurrenceIndex }) ||
      !sameSendData(origin.request, { binding: item.request.binding, from: item.request.from })) {
    throw new KernelTableError('SEND inputs require their exact original intent and binding.');
  }
  return { sendInputs, sendInputsOrigin };
};
const prepareQueuePublication = async (prepareQueue: QueueOriginPrepare, ctx: SystemCommandContext,
  item: CanonicalStagedItem, sourceGuard: DispatchSourceGuard | null,
  filePayloadOrigin: FrameworkFilePayloadOrigin | undefined) => {
  if (!item.source.endsWith('.publish')) throw new KernelTableError('Queue publication requires its original publish target.');
  const queuePayload = snapshotKernelJsonValue(argRecord(item.request, 'arguments', 'queue publication'), 'queue publication payload');
  const row = newDispatchRow({ intentId: item.id as OutboxId, operationId: item.operationId, source: item.source,
    occurrenceIndex: item.occurrenceIndex, originOccurrence: item.originOccurrence,
    ...(sourceGuard === null ? {} : { sourceGuard }), ...(filePayloadOrigin === undefined ? {} : { filePayloadOrigin }) }, { nowMs: ctx.now, actor: ctx.actor });
  const intent: OutboxIntent = { intentId: item.id, operation: ctx.operation as OperationName, operationId: item.operationId as OperationId,
    target: item.source, arguments: item.request, occurrenceIndex: item.occurrenceIndex, ...(sourceGuard === null ? {} : { dispatchGuard: sourceGuard.rule }) };
  const queuePayloadOrigin = await prepareQueue({ ...row, data: { ...row.data, queuePayload, ...(sourceGuard === null ? {} : { guardVerdict: true }) } }, intent);
  readWorkFilePayloadOrigin({ queuePayloadOrigin }, row, WORK_DISPATCH_MODEL, 'queuePayload', 'deferred-input', 'queuePayloadOrigin');
  return { queuePayload, queuePayloadOrigin };
};
const sealCanonicalStaging = (seal: CanonicalSendSeal | null, input: CanonicalSendInput,
  ctx: SystemCommandContext, effects: SystemStaging, delivery: DeliveryRef): CanonicalSendStaging => {
  if (seal !== null) {
    const current = captureCanonicalSend(input, ctx);
    if (current !== null && sameSendData(current.inputSnapshot, seal.inputSnapshot) &&
        sameSendData(current.contextSnapshot, seal.contextSnapshot)) {
      const copied = copySendData(effects, false);
      if (copied !== null) {
        const carrier = Object.freeze({ effects: copied.value as SystemStaging, delivery });
        canonicalSendSeals.set(carrier, seal);
        return carrier;
      }
    }
  }
  // Legacy staging remains structural; only the strict immutable profile is sealed.
  return { effects, delivery };
};
export async function stageCanonicalSend(
  input: CanonicalSendInput,
  ctx: SystemCommandContext,
  guardOrigin?: CanonicalSendGuardOriginProducer,
): Promise<CanonicalSendStaging> {
  const { sourceGuard, prepare, prepareQueue, prepareInputs } = readCanonicalSendProducers(input, guardOrigin);
  const seal = captureCanonicalSend(input, ctx);
  const stageContext = { ...ctx };
  const correlation = readSendCorrelation(input);
  const staged = await stageOutboxIntentAsync(input);
  const item = staged.item;
  const filePayloadOrigin = sourceGuard === null ? undefined
    : await prepareGuardedOrigin(prepare!, ctx, item, sourceGuard, correlation);
  const inputs = prepareInputs === undefined ? undefined
    : await prepareSendInputs(prepareInputs, stageContext, item, sourceGuard, filePayloadOrigin);
  const queued = prepareQueue === undefined ? undefined
    : await prepareQueuePublication(prepareQueue, ctx, item, sourceGuard, filePayloadOrigin);
  const effects = await stageCanonicalDispatch({
    operationId: item.operationId,
    intents: [{
      intentId: item.id,
      operation: stageContext.operation,
      originOperationId: item.operationId,
      source: item.source,
      occurrenceIndex: item.occurrenceIndex,
      request: item.request,
      originOccurrence: item.originOccurrence,
      guard: sourceGuard?.rule ?? null,
      guardVerdict: sourceGuard === null ? null : true,
      ...(sourceGuard === null ? {} : { sourceGuard }),
      ...(filePayloadOrigin === undefined ? {} : { filePayloadOrigin }),
      ...(queued === undefined ? {} : queued),
      ...(inputs === undefined ? {} : inputs),
      ...(correlation === undefined ? {} : { correlation }),
    }],
  }, stageContext);
  const delivery = makeDeliveryRef(item.id, item.source);
  return sealCanonicalStaging(seal, input, ctx, effects, delivery);
}
