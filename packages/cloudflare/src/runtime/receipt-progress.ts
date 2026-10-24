import type { AssociatedReceipt, DomainWrite, ModelName, OutboxIntent, ReceiptError, ReceiptResultContext, RecordId } from '@canlang/contracts';
import type { SystemCommandContext, SystemStaging } from '@canlang/state';
import { systemCommandStageRevision } from '@canlang/state';
import {
  RECEIPT_ASSOCIATION_MODEL, RECEIPT_MODEL, readAssociationRow, readReceiptRow,
  withAssociationRowData, withReceiptRowData, isJudgmentReceiptContext, isJudgmentReceiptPayload,
  isTextRunReceiptContext, isImageRunReceiptContext, isWorkflowReviewReceiptContext, isWorkflowReviewReceiptPayload,
} from '@canlang/state/receipt/tables';
import { applyReceiptProgress } from '@canlang/work/observation/association';
import { isConsistentCompletion, isTerminalReceiptStatus } from '@canlang/work/receipt';
import { decodeValue, isDeliveryRef } from '@canlang/values';

export interface ReceiptProgressInput {
  /** Original intent whose bound carrier and Email completion the adapter verified. */
  readonly intent: OutboxIntent;
  readonly outcome: { readonly kind: 'delivered'; readonly result: unknown }
    | { readonly kind: 'failed'; readonly error: ReceiptError }
    | { readonly kind: 'skipped' };
  /** Actual original context verified by the installed Judgment/generation adapter. */
  readonly context?: ReceiptResultContext;
  /** Revision of the single owner fence receiving these effects. */
  readonly revision: number;
}

function checkReceiptProgressRevision(skipping: boolean, revision: number, ctx: SystemCommandContext): void {
  if (skipping && revision !== systemCommandStageRevision(ctx) + 1) {
    throw new Error('Skipped receipt requires the actual claim stage commit revision.');
  }
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Receipt progress requires a commit revision.');
}

function readReceiptProgressOutcome(
  outcome: ReceiptProgressInput['outcome'],
  skipping: boolean,
): { readonly status: 'succeeded' | 'skipped' | 'failed'; readonly result: unknown; readonly error: ReceiptError | null } {
  const status = outcome.kind === 'delivered' ? 'succeeded' : skipping ? 'skipped' : 'failed';
  const result = outcome.kind === 'delivered' ? outcome.result : null;
  const error = outcome.kind === 'failed' ? outcome.error : null;
  return { status, result, error };
}

function checkReceiptProgressIntent(
  intent: ReceiptProgressInput['intent'],
  outcome: ReceiptProgressInput['outcome'],
  context: ReceiptProgressInput['context'],
  revision: number,
  ctx: SystemCommandContext,
): { readonly judgment: boolean; readonly workflow: boolean; readonly skipping: boolean; readonly status: 'succeeded' | 'skipped' | 'failed'; readonly result: unknown; readonly error: ReceiptError | null } {
  const judgment = isJudgmentReceiptContext(context) && context!.source === intent.target;
  const skipping = outcome.kind === 'skipped';
  const workflow = isWorkflowReviewReceiptContext(context) && context!.source === intent.target;
  // Original empty generation receipts use the adapter's real request context.
  // Run progress and cleanup controls keep their separate owning writers.
  const generation = skipping && context?.source === intent.target && context.request !== undefined &&
    (intent.target === 'std.TextGenerationV1.generate' && isTextRunReceiptContext(context) ||
      intent.target === 'std.ImagesV1.submit' && isImageRunReceiptContext(context));
  if ((!['std.EmailV1.send', 'std.EmailV1.send_user'].includes(intent.target) && !judgment && !generation && !workflow) ||
      (context !== undefined && !judgment && !generation && !workflow) || typeof intent.intentId !== 'string' || intent.intentId === '') {
    throw new Error('Receipt progress requires the verified original Email, Judgment or empty generation intent.');
  }
  checkReceiptProgressRevision(skipping, revision, ctx);
  const { status, result, error } = readReceiptProgressOutcome(outcome, skipping);
  return { judgment, workflow, skipping, status, result, error };
}

type ReceiptProgressGate = ReturnType<typeof checkReceiptProgressIntent>;

async function stageAssociationProgressRow(
  ctx: SystemCommandContext,
  row: Awaited<ReturnType<SystemCommandContext['query']>>[number],
  intent: ReceiptProgressInput['intent'],
  receipt: ReturnType<typeof readReceiptRow>['receipt'],
  revision: number,
  status: ReceiptProgressGate['status'],
  result: ReceiptProgressGate['result'],
  error: ReceiptProgressGate['error'],
  context: ReceiptProgressInput['context'],
  meta: { readonly nowMs: number; readonly actor: string },
): Promise<{ readonly receipt: AssociatedReceipt; readonly write: DomainWrite }> {
  const association = readAssociationRow(row);
  if (association.deliveryId !== intent.intentId || association.source !== intent.target) {
    throw new Error('Receipt association disagrees with the verified original intent.');
  }
  const recordModel = row.data['recordModel'];
  // readAssociationRow already validates this stored model and protected locator ID.
  if (typeof recordModel !== 'string') throw new Error('Receipt owner model is missing.');
  const owner = await ctx.load(recordModel as ModelName, association.locator.recordId as RecordId);
  if (owner === null || owner.archivedAt !== null) throw new Error('Receipt current owner is unavailable.');
  const delivery = decodeValue(`delivery(${intent.target})`, owner.data[association.locator.field]);
  if (!isDeliveryRef(delivery) || delivery.id !== association.deliveryId || delivery.operation !== association.source) {
    throw new Error('Receipt current owner field disagrees with its association.');
  }
  const progress = applyReceiptProgress(association, receipt, {
    delivery_id: intent.intentId, source: intent.target, revision, status, result, error,
  }, context);
  if (!progress.applied) throw new Error(`Receipt progress refused: ${progress.reason}.`);
  return { receipt: progress.receipt, write: { kind: 'update', model: RECEIPT_ASSOCIATION_MODEL as ModelName, id: row.id,
    expectedVersion: row.version, row: withAssociationRowData(row, {
      recordModel, recordId: association.locator.recordId, field: association.locator.field,
      deliveryId: progress.association.deliveryId, source: progress.association.source,
      revision: progress.association.revision,
    }, meta) } };
}

/** Stage retained receipt progress; callers join these writes to their existing fence. */
export async function stageReceiptProgress(input: ReceiptProgressInput, ctx: SystemCommandContext): Promise<SystemStaging> {
  const { intent, outcome, revision, context } = input;
  const { judgment, workflow, skipping, status, result, error } = checkReceiptProgressIntent(intent, outcome, context, revision, ctx);
  const receiptRow = await ctx.load(RECEIPT_MODEL as ModelName, intent.intentId as RecordId);
  if (receiptRow === null) return {};
  const retained = readReceiptRow(receiptRow, context);
  if (retained.receipt.deliveryId !== intent.intentId) throw new Error('Receipt progress intent identity disagrees.');
  if (workflow ? !isWorkflowReviewReceiptPayload(status, result, error, context) : judgment ? !isJudgmentReceiptPayload(status, result, error, context)
    : !isConsistentCompletion(status, result, error)) throw new Error('Receipt progress requires a closed decisive completion.');
  if (skipping && (isTerminalReceiptStatus(retained.receipt.status) || retained.receipt.status !== 'pending' ||
      retained.receipt.result !== null || retained.receipt.error !== null || retained.contentRef !== null ||
      retained.resultExpiresAtMs !== null)) {
    throw new Error('Skipped receipt requires its untouched pending original payload.');
  }
  if (isTerminalReceiptStatus(retained.receipt.status)) return {};
  if (retained.receipt.status !== 'pending') throw new Error('Receipt progress requires a pending receipt.');
  if (revision <= retained.receipt.revision) throw new Error('Receipt progress revision must advance.');
  const rows = await ctx.query({ model: RECEIPT_ASSOCIATION_MODEL as ModelName,
    where: { op: 'eq', field: 'deliveryId', value: intent.intentId }, authority: 'owner' });
  if (skipping && rows.length === 0) throw new Error('Skipped receipt requires its current original association.');
  const meta = { nowMs: ctx.now, actor: ctx.actor };
  const writes: DomainWrite[] = [];
  let nextReceipt: AssociatedReceipt = { ...retained.receipt, revision, status, result, error };
  for (const row of rows) {
    const staged = await stageAssociationProgressRow(ctx, row, intent, retained.receipt, revision,
      status, result, error, context, meta);
    nextReceipt = staged.receipt;
    writes.push(staged.write);
  }
  // Superseded/cleared sends retain their original receipt without selecting a new association.
  writes.push({ kind: 'update', model: RECEIPT_MODEL as ModelName, id: receiptRow.id,
    expectedVersion: receiptRow.version, row: withReceiptRowData(receiptRow, {
      ...nextReceipt, contentRef: retained.contentRef, resultExpiresAtMs: retained.resultExpiresAtMs,
      ...(retained.filePayloadOrigin === undefined ? {} : { filePayloadOrigin: retained.filePayloadOrigin }),
    }, meta, context) });
  return { writes };
}
