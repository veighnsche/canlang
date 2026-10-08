import type { AssociatedReceipt, DomainWrite, ModelName, OutboxIntent, ReceiptError, RecordId } from '@canlang/contracts';
import type { SystemCommandContext, SystemStaging } from '@canlang/state';
import {
  RECEIPT_ASSOCIATION_MODEL, RECEIPT_MODEL, readAssociationRow, readReceiptRow,
  withAssociationRowData, withReceiptRowData,
} from '@canlang/state/receipt/tables';
import { applyReceiptProgress } from '@canlang/work/observation/association';
import { isConsistentCompletion, isTerminalReceiptStatus } from '@canlang/work/receipt';
import { decodeValue, isDeliveryRef } from '@canlang/values';

export interface ReceiptProgressInput {
  /** Original intent whose bound carrier and Email completion the adapter verified. */
  readonly intent: OutboxIntent;
  readonly outcome: { readonly kind: 'delivered'; readonly result: unknown }
    | { readonly kind: 'failed'; readonly error: ReceiptError };
  /** Revision of the single owner fence receiving these effects. */
  readonly revision: number;
}

/** Stage retained receipt progress; callers join these writes to their existing fence. */
export async function stageReceiptProgress(input: ReceiptProgressInput, ctx: SystemCommandContext): Promise<SystemStaging> {
  const { intent, outcome, revision } = input;
  if (intent.target !== 'std.EmailV1.send' || typeof intent.intentId !== 'string' || intent.intentId === '') {
    throw new Error('Receipt progress requires the verified original Email intent.');
  }
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Receipt progress requires a commit revision.');
  const receiptRow = await ctx.load(RECEIPT_MODEL as ModelName, intent.intentId as RecordId);
  if (receiptRow === null) return {};
  const retained = readReceiptRow(receiptRow);
  if (retained.receipt.deliveryId !== intent.intentId) throw new Error('Receipt progress intent identity disagrees.');
  const status = outcome.kind === 'delivered' ? 'succeeded' : 'failed';
  const result = outcome.kind === 'delivered' ? outcome.result : null;
  const error = outcome.kind === 'failed' ? outcome.error : null;
  if (!isConsistentCompletion(status, result, error)) throw new Error('Receipt progress requires a closed decisive completion.');
  if (isTerminalReceiptStatus(retained.receipt.status)) return {};
  if (retained.receipt.status !== 'pending') throw new Error('Receipt progress requires a pending receipt.');
  if (revision <= retained.receipt.revision) throw new Error('Receipt progress revision must advance.');
  const rows = await ctx.query({ model: RECEIPT_ASSOCIATION_MODEL as ModelName,
    where: { op: 'eq', field: 'deliveryId', value: intent.intentId }, authority: 'owner' });
  const meta = { nowMs: ctx.now, actor: ctx.actor };
  const writes: DomainWrite[] = [];
  let nextReceipt: AssociatedReceipt = { ...retained.receipt, revision, status, result, error };
  for (const row of rows) {
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
    const progress = applyReceiptProgress(association, retained.receipt, {
      delivery_id: intent.intentId, source: intent.target, revision, status, result, error,
    });
    if (!progress.applied) throw new Error(`Receipt progress refused: ${progress.reason}.`);
    nextReceipt = progress.receipt;
    writes.push({ kind: 'update', model: RECEIPT_ASSOCIATION_MODEL as ModelName, id: row.id,
      expectedVersion: row.version, row: withAssociationRowData(row, {
        recordModel, recordId: association.locator.recordId, field: association.locator.field,
        deliveryId: progress.association.deliveryId, source: progress.association.source,
        revision: progress.association.revision,
      }, meta) });
  }
  // Superseded/cleared sends retain their original receipt without selecting a new association.
  writes.push({ kind: 'update', model: RECEIPT_MODEL as ModelName, id: receiptRow.id,
    expectedVersion: receiptRow.version, row: withReceiptRowData(receiptRow, {
      ...nextReceipt, contentRef: retained.contentRef, resultExpiresAtMs: retained.resultExpiresAtMs,
    }, meta) });
  return { writes };
}
