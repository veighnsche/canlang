/**
 * Portable dispatch staging join. Returns effects for the caller's existing
 * fenced commit; this module never opens a transaction or sends a request.
 */
import type {
  DomainWrite, OperationId, OperationName, OutboxIntent, RecordId,
  OccurrenceId, OutboxId, DeliveryRef,
} from '@canlang/contracts';
import type { SystemCommandContext, SystemCommandDef, SystemStaging } from '@canlang/state';
import { makeDeliveryRef } from '@canlang/values';
import { checkArgs, argString, argNullableString, argRecord } from './arguments.js';
import type { FanoutLineage } from '../intent/index.js';
import { stageOutboxIntentAsync } from '../intent/staging.js';
import type { StageOutboxIntentInput } from '../intent/staging.js';
import {
  KernelTableError, WORK_DISPATCH_MODEL, newDispatchRow, readDispatchRow,
  DISPATCH_IMAGE_CORRELATION_FIELDS, readDispatchImageCorrelation, type DispatchImageCorrelation,
  dispatchGenerationTargetProfile,
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
  if (profile === null || correlation === null ||
      request['binding'] !== correlation.requestBinding || request['from'] !== correlation.requestFrom ||
      typeof value !== 'object' || value === null || Array.isArray(value) ||
      (control && (Reflect.ownKeys(value).length !== 2 || Reflect.ownKeys(value).some(key => key !== 'source' && key !== 'revision'))) ||
      (value as Record<string, unknown>)['source'] !== correlation.requestSource ||
      (value as Record<string, unknown>)['revision'] !== correlation.requestRevision) {
    throw new KernelTableError(`${what}: original generation correlation disagrees with its retained carrier.`);
  }
  return correlation;
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
    const intents = rawIntents.map((candidate, index) => parseStageIntent(candidate, index, what));
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
        const data = readDispatchRow(existing);
        if (
          data.intentId !== intent.intentId ||
          data.operationId !== intent.originOperationId ||
          data.source !== intent.source ||
          data.occurrenceIndex !== intent.occurrenceIndex ||
          data.originOccurrence !== intent.originOccurrence ||
          data.guardVerdict !== intent.guardVerdict ||
          DISPATCH_IMAGE_CORRELATION_FIELDS.some(field => data[field] !== intent.correlation?.[field])
        ) {
          throw new KernelTableError(
            `${what}: intent ${JSON.stringify(intent.intentId)} already staged ` +
              'with a different origin or verdict.',
          );
        }
        replayed.push(intent.intentId);
        continue;
      }
      const fresh = newDispatchRow(
        {
          intentId: intent.intentId as OutboxId,
          operationId: intent.originOperationId,
          source: intent.source,
          occurrenceIndex: intent.occurrenceIndex,
          originOccurrence: intent.originOccurrence,
          ...(intent.correlation ?? {}),
        },
        { nowMs: ctx.now, actor: ctx.actor },
      );
      writes.push({
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
        skipped.push({
          intentId: intent.intentId,
          guard: intent.guard,
          verdict: false,
          reason: 'guard-false',
          fanout: intent.fanout,
        });
        continue;
      }
      outbox.push({
        intentId: intent.intentId,
        operation: intent.operation as OperationName,
        operationId: operationId as OperationId,
        target: intent.source,
        arguments: intent.request,
        occurrenceIndex: intent.occurrenceIndex,
        ...(intent.guard !== null ? { dispatchGuard: intent.guard } : {}),
      });
      staged.push({ intentId: intent.intentId, origin, guard: intent.guard, fanout: intent.fanout });
    }
    return { writes, outbox, result: { staged, skipped, replayed } };
  },
};

/** One provisional delivery and its effects; neither is committed here. */
export interface CanonicalSendStaging {
  readonly effects: SystemStaging;
  readonly delivery: DeliveryRef;
}

/** Correlation is supplied only by the genuine checked request/scope producer. */
export interface CanonicalSendInput extends StageOutboxIntentInput {
  readonly correlation?: DispatchImageCorrelation;
}

/**
 * Stage one unconditional checked bound send in the admitted scenario's
 * existing transaction. The caller resolves the exact compiler binding,
 * checks and wire-encodes its request, and allocates the occurrence index in
 * evaluation order. `input.source` is the checked capability operation;
 * `ctx.operation` and `input.operationId` are the admitted business origin.
 * Bound sends carry the Contracts `BoundCapabilityRequest` in `input.request`
 * so the exact logical binding and deployment route survive persistence.
 *
 * Only readers are accepted. The caller collects these writes/outbox effects
 * alongside domain writes, history and uniques for ONE fenced State commit;
 * a failed scenario drops them all. No binding or request schema is inferred
 * here, and no transport, registry run or separate commit occurs.
 */
export async function stageCanonicalSend(
  input: CanonicalSendInput,
  ctx: SystemCommandContext,
): Promise<CanonicalSendStaging> {
  const stageContext = { ...ctx };
  let correlation: DispatchImageCorrelation | undefined;
  if (input.correlation !== undefined) {
    if (Reflect.ownKeys(input.correlation).length !== DISPATCH_IMAGE_CORRELATION_FIELDS.length) {
      throw new KernelTableError('Canonical send original generation correlation has unknown or missing fields.');
    }
    correlation = readDispatchImageCorrelation(input.correlation) ?? undefined;
    if (correlation === undefined) throw new KernelTableError('Canonical send original generation correlation is missing.');
  }
  const staged = await stageOutboxIntentAsync(input);
  const item = staged.item;
  const effects = await workDispatchStageCommand.stage({
    operationId: item.operationId,
    intents: [{
      intentId: item.id,
      operation: stageContext.operation,
      originOperationId: item.operationId,
      source: item.source,
      occurrenceIndex: item.occurrenceIndex,
      request: item.request,
      originOccurrence: item.originOccurrence,
      guard: null,
      guardVerdict: null,
      ...(correlation === undefined ? {} : { correlation }),
    }],
  }, stageContext);
  return { effects, delivery: makeDeliveryRef(item.id, item.source) };
}
