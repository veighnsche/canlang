/** Rich progress for a verified original bound TextGeneration attempt. */
import type { AssociatedReceipt, DomainWrite, ModelName, OutboxIntent, ProgressTerminalNotification, ReceiptError,
  ReceiptResultContext, RecordId } from '@canlang/contracts';
import type { SystemCommandContext, SystemStaging } from '@canlang/state';
import { StateError } from '@canlang/state/errors';
import {
  RECEIPT_ASSOCIATION_MODEL, RECEIPT_MODEL, readAssociationRow, readReceiptRow,
  withAssociationRowData, withReceiptRowData, isTextRunReceiptContext, isTextRunReceiptPayload,
  readTextRunResult,
} from '@canlang/state/receipt/tables';
import { applyRelatedProgress, applyRetainedRelatedProgress } from '@canlang/work/observation/association';
import { decodeValue, encodeValue, isDeliveryRef } from '@canlang/values';
import type { TextRunWire } from './bound-text-generation.js';
import { stageCheckedDeliveryProgress } from './invoke.js';
import type { CheckedDeliveryProgressProducer, DispatchReconcileEvidence } from './invoke.js';

interface TextGenerationProgressBase {
  readonly intent: OutboxIntent;
  /** Owning result declaration and frozen business request, verified by the bound adapter. */
  readonly context: ReceiptResultContext;
  readonly revision: number;
  /** Concrete assembly and the admitted original drive fence, never receipt payload metadata. */
  readonly progressed?: { readonly producer: CheckedDeliveryProgressProducer; readonly owner: string };
}

export type TextGenerationProgressInput = TextGenerationProgressBase & (
  | { readonly progress: TextRunWire; readonly outcome?: never }
  | { readonly outcome: { readonly kind: 'failed'; readonly error: ReceiptError }; readonly progress?: never }
);

export type TextGenerationProgressStaging = SystemStaging & {
  readonly result: { readonly notification: ProgressTerminalNotification | null };
};

function refuse(): never {
  throw new StateError('validation', 'Text generation receipt progress cannot be staged.');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns conditional writes for the caller's existing owner fence; never commits. */
export async function stageTextGenerationProgress(input: TextGenerationProgressInput,
  ctx: SystemCommandContext): Promise<TextGenerationProgressStaging> {
  const { intent, context, revision } = input;
  const withOccurrences = async (staged: TextGenerationProgressStaging): Promise<TextGenerationProgressStaging> => {
    if ((staged.writes?.length ?? 0) === 0 || input.progressed === undefined) return staged;
    const events = await stageCheckedDeliveryProgress(input.progressed.producer, intent, input.progressed.owner, ctx);
    return { ...staged, writes: [...staged.writes ?? [], ...events.writes ?? []],
      schedules: [...staged.schedules ?? [], ...events.schedules ?? []] };
  };
  const target = 'std.TextGenerationV1.generate';
  if (intent.target !== target || intent.intentId === '' || context.source !== target ||
      !isTextRunReceiptContext(context) || context.request === undefined ||
      !Number.isSafeInteger(revision) || revision < 0) refuse();
  const carrier = intent.arguments;
  if (!record(carrier) || Object.keys(carrier).length !== 3 || typeof carrier.binding !== 'string' ||
      carrier.binding === '' || typeof carrier.from !== 'string' || carrier.from === '' ||
      !record(carrier.arguments) || !record(carrier.arguments.value)) refuse();
  const request = carrier.arguments.value;
  if (request.source !== context.request.source || request.revision !== context.request.revision ||
      encodeValue('int', decodeValue('int', request.revision)) !== context.request.revision) refuse();
  const receiptRow = await ctx.load(RECEIPT_MODEL as ModelName, intent.intentId as RecordId);
  if (receiptRow === null) refuse();
  const retained = readReceiptRow(receiptRow, context);
  if (retained.receipt.deliveryId !== intent.intentId) refuse();
  const progress = input.progress;
  const failure = input.outcome;
  if ((progress === undefined) === (failure === undefined)) refuse();
  const status = progress === undefined ? 'failed' : progress.state === 'queued' || progress.state === 'running' ? 'pending'
    : progress.state === 'unknown' ? 'unknown' : 'succeeded';
  if (progress !== undefined && !isTextRunReceiptPayload(status, progress, null, context)) refuse();
  const envelope = { relation: target, delivery_id: intent.intentId, source: target, revision,
    status, result: progress ?? null, error: failure?.error ?? null };
  const rows = await ctx.query({ model: RECEIPT_ASSOCIATION_MODEL as ModelName,
    where: { op: 'eq', field: 'deliveryId', value: intent.intentId }, authority: 'owner' });
  const meta = { actor: ctx.actor, nowMs: ctx.now };
  if (rows.length === 0) {
    const applied = applyRetainedRelatedProgress(target, retained.receipt, envelope, context);
    if (!applied.applied) refuse();
    if (applied.replay) return { writes: [], result: { notification: null } };
    return withOccurrences({ writes: [{ kind: 'update', model: RECEIPT_MODEL as ModelName, id: receiptRow.id,
      expectedVersion: receiptRow.version, row: withReceiptRowData(receiptRow, { ...applied.receipt,
        contentRef: retained.contentRef, resultExpiresAtMs: retained.resultExpiresAtMs }, meta, context) }],
      result: { notification: applied.notification } });
  }
  const writes: DomainWrite[] = [];
  let notification: ProgressTerminalNotification | null = null;
  let nextReceipt = retained.receipt;
  for (const row of rows) {
    const association = readAssociationRow(row);
    const model = row.data.recordModel;
    if (typeof model !== 'string' || association.deliveryId !== intent.intentId || association.source !== target) refuse();
    const owner = await ctx.load(model as ModelName, association.locator.recordId as RecordId);
    if (owner === null || owner.archivedAt !== null) refuse();
    const delivery = decodeValue(`delivery(${target})`, owner.data[association.locator.field]);
    if (!isDeliveryRef(delivery) || delivery.id !== intent.intentId || delivery.operation !== target) refuse();
    const applied = applyRelatedProgress(target, association, retained.receipt, envelope, context);
    if (!applied.applied) refuse();
    if (applied.replay) continue;
    nextReceipt = applied.receipt;
    notification = applied.notification;
    writes.push({ kind: 'update', model: RECEIPT_ASSOCIATION_MODEL as ModelName, id: row.id,
      expectedVersion: row.version, row: withAssociationRowData(row, { recordModel: model,
        recordId: association.locator.recordId, field: association.locator.field,
        deliveryId: applied.association.deliveryId, source: applied.association.source,
        revision: applied.association.revision }, meta) });
  }
  if (writes.length !== 0) writes.push({ kind: 'update', model: RECEIPT_MODEL as ModelName, id: receiptRow.id,
    expectedVersion: receiptRow.version, row: withReceiptRowData(receiptRow, { ...nextReceipt,
      contentRef: retained.contentRef, resultExpiresAtMs: retained.resultExpiresAtMs }, meta, context) });
  return withOccurrences({ writes, result: { notification } });
}

/** Read the original checked receipt without requiring a terminal outcome. */
export async function readRetainedTextGenerationReceipt(
  input: { readonly intent: OutboxIntent; readonly context: ReceiptResultContext },
  ctx: SystemCommandContext,
): Promise<AssociatedReceipt | null> {
  const { intent, context } = input;
  const target = 'std.TextGenerationV1.generate';
  if (intent.target !== target || intent.intentId === '' || context.source !== target ||
      !isTextRunReceiptContext(context) || context.request === undefined) refuse();
  const carrier = intent.arguments;
  if (!record(carrier) || Object.keys(carrier).length !== 3 || typeof carrier.binding !== 'string' ||
      carrier.binding === '' || typeof carrier.from !== 'string' || carrier.from === '' ||
      !record(carrier.arguments) || !record(carrier.arguments.value)) refuse();
  const request = carrier.arguments.value;
  if (request.source !== context.request.source || request.revision !== context.request.revision ||
      encodeValue('int', decodeValue('int', request.revision)) !== context.request.revision) refuse();
  const row = await ctx.load(RECEIPT_MODEL as ModelName, intent.intentId as RecordId);
  if (row === null) return null;
  const { receipt } = readReceiptRow(row, context);
  if (receipt.deliveryId !== intent.intentId) refuse();
  return receipt;
}

/** Read definitive progress retained before a lost Work acknowledgement. */
export async function readRetainedTextGenerationEvidence(
  input: { readonly intent: OutboxIntent; readonly context: ReceiptResultContext },
  ctx: SystemCommandContext,
): Promise<DispatchReconcileEvidence | null> {
  const receipt = await readRetainedTextGenerationReceipt(input, ctx);
  if (receipt === null) return null;
  if (receipt.status === 'failed') {
    // The owning row reader already checked the closed error and null result.
    if (receipt.error === null) refuse();
    return { kind: 'failed', code: receipt.error.code, message: receipt.error.message };
  }
  if (receipt.status !== 'succeeded' || receipt.result === null) return null;
  const run = readTextRunResult(receipt.result, input.context.declaredResult);
  if (run === null) refuse();
  if (!['succeeded', 'failed', 'cancelled'].includes(run.fields.state!)) return null;
  return { kind: 'delivered', result: receipt.result };
}
