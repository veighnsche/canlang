// W02.4 — Dispatch/fanout/receipt batch-linkage assertions, extracted
// from the state transact + receipt donors. Pure pre-store guards:
// each assert runs BEFORE the batch touches the store and fails closed
// with StateError validation. Row-identity reads go through the shared
// kernel readers (rows.ts state direction for fanout, receipt.ts for
// receipt rows), preserving the donor's ReceiptTableError-to-StateError
// wrap via same-module instanceof. Cursor-only checkpoint maintenance
// commits through the plain store port, never here: this module pins
// outcome-bearing linkage only. No consumer adoption: donors keep
// serving callers; conformance/fixtures/receipts/linkage.json holds
// frozen independent originals captured from the live donors.

import type { CommitBatch, DomainWrite, OutboxIntent } from '@canlang/contracts';
import {
  FANOUT_CHECKPOINT_MODEL,
  FANOUT_CHILD_MODEL,
  FANOUT_INTENT_MODEL,
  RowsStateError,
  readFanoutCheckpointRow,
  readFanoutChildRow,
  readFanoutIntentRow,
} from './rows.js';
import {
  RECEIPT_ASSOCIATION_MODEL,
  RECEIPT_MODEL,
  ReceiptTableError,
  readAssociationRow,
  readReceiptRow,
} from './receipt.js';

function failValidation(message: string): never {
  throw new RowsStateError(message);
}

export const DISPATCH_JOIN_MODEL = 'work.dispatch';

/**
 * One dispatch-row insert participating in the join: the row id plus the
 * linkage fields the assertion reads structurally.
 */
export interface DispatchJoinRow {
  readonly id: string;
  readonly intentId: string;
  /** Pinned stage-time guard verdict; false marks a recorded skip. */
  readonly guardVerdict: boolean | null;
}

function readDispatchJoinRow(write: DomainWrite & { readonly kind: 'insert' }): DispatchJoinRow {
  const data = write.row.data as Readonly<Record<string, unknown>> | null;
  const intentId = data?.['intentId'];
  const guardVerdict = data?.['guardVerdict'];
  if (typeof intentId !== 'string' || intentId === '') {
    failValidation(
      'Dispatch join: work.dispatch inserts must carry a non-empty data.intentId.',
    );
  }
  if (guardVerdict !== null && typeof guardVerdict !== 'boolean') {
    failValidation(
      'Dispatch join: work.dispatch data.guardVerdict must be boolean or null.',
    );
  }
  return { id: write.row.id as string, intentId, guardVerdict };
}

/**
 * Assert the dispatch-join linkage for one commit batch BEFORE it
 * touches the store (fail closed, `StateError` validation):
 *
 * - Every staged outbox intent has EXACTLY ONE `work.dispatch` insert
 *   with row id AND `data.intentId` equal to the intent id: the claim
 *   lifecycle row stages atomically with its intent, never apart.
 * - Every `work.dispatch` insert with a non-false pinned verdict has
 *   its outbox intent: a deliverable row without its L3 half is a
 *   broken join.
 * - `work.dispatch` inserts pinned guard-false with NO outbox intent
 *   are recorded skips (allowed, never dispatchable).
 * - Outbox intent ids and dispatch-row ids are each unique.
 *
 * Claim/recovery batches (conditional UPDATES, no outbox intents) pass
 * trivially: only inserts participate. Ordinary batches with neither
 * half pass trivially, so non-dispatch callers are unaffected.
 */
export function assertDispatchJoin(batch: CommitBatch): void {
  const intents: ReadonlyArray<OutboxIntent> = batch.outbox ?? [];
  const intentIds = new Set<string>();
  for (const intent of intents) {
    if (intentIds.has(intent.intentId)) {
      failValidation(
        `Dispatch join: duplicate outbox intent id ${JSON.stringify(intent.intentId)}.`,
      );
    }
    intentIds.add(intent.intentId);
  }
  const rowByIntent = new Map<string, DispatchJoinRow>();
  for (const write of batch.writes ?? []) {
    if (write.kind !== 'insert' || (write.model as string) !== DISPATCH_JOIN_MODEL) {
      continue;
    }
    const row = readDispatchJoinRow(write);
    if (row.id !== row.intentId) {
      failValidation(
        `Dispatch join: work.dispatch row id ${JSON.stringify(row.id)} ` +
          `must equal its data.intentId ${JSON.stringify(row.intentId)}.`,
      );
    }
    if (rowByIntent.has(row.intentId)) {
      failValidation(
        `Dispatch join: duplicate work.dispatch row for ${JSON.stringify(row.intentId)}.`,
      );
    }
    rowByIntent.set(row.intentId, row);
  }
  for (const intentId of intentIds) {
    if (!rowByIntent.has(intentId)) {
      failValidation(
        `Dispatch join: outbox intent ${JSON.stringify(intentId)} ` +
          'has no work.dispatch row in this batch.',
      );
    }
  }
  for (const row of rowByIntent.values()) {
    if (row.guardVerdict !== false && !intentIds.has(row.intentId)) {
      failValidation(
        `Dispatch join: work.dispatch row ${JSON.stringify(row.intentId)} ` +
          'has no outbox intent in this batch (only guard-false skips stage row-only).',
      );
    }
  }
}

/**
 * One terminal child outcome update participating in the join: the
 * staged row's fanout scope plus its terminal record identity.
 */
export interface FanoutChildJoinOutcome {
  readonly fanoutId: string;
  readonly recordId: string;
}

/**
 * Assert the fanout child-unit linkage for one commit batch BEFORE it
 * touches the store (fail closed, `StateError` validation). The child
 * unit — child domain/history/replay/outbox/schedule effects plus the
 * terminal outcome plus the checkpoint advance — commits in ONE owner
 * transaction; this assertion pins the fanout halves together:
 *
 * - Row-identity linkage: every fanout insert/update stages a row whose
 *   id equals its derivation (intent id = cutoff+cohort, child id =
 *   parent+handler+record, checkpoint id = fanout id), validated
 *   through the state-direction row mirrors (closed states, closed
 *   causes, memberCount agreement).
 * - No fabricated completion: child inserts stage pending with zero
 *   attempts and null cause; checkpoint inserts carry an EMPTY
 *   completed set; intent rows are insert-only (the frozen set is never
 *   redefined); fanout rows are never removed (terminal records stand).
 * - Outcome/checkpoint co-commit: every TERMINAL child update's
 *   recordId appears in a SAME-FANOUT checkpoint update's staged
 *   completed set in the same batch, and every checkpoint update
 *   co-occurs with at least one terminal child update. An outcome
 *   without checkpoint cover, or a checkpoint advance without its
 *   outcome, is refused — never acknowledged unfinished, never
 *   checkpointed apart.
 * - Non-terminal child updates (pending/running claim transitions,
 *   attempts bumps) and intent inserts pass under the row-identity
 *   rules only: claims are F3-driven and carry no completion.
 * - Batches with no fanout writes pass trivially, so non-fanout callers
 *   are unaffected.
 *
 * Cursor-only checkpoint maintenance (freeze final-chunk nulling,
 * recovery finish) commits through the PLAIN store port, never here:
 * this assertion is exclusively for outcome-bearing child units.
 */
export function assertFanoutChildJoin(batch: CommitBatch): void {
  const childIds = new Set<string>();
  const checkpointIds = new Set<string>();
  const terminalOutcomes: FanoutChildJoinOutcome[] = [];
  const checkpointCovers = new Map<string, Set<string>>();
  for (const write of batch.writes ?? []) {
    const model = write.model as string;
    if (model === FANOUT_INTENT_MODEL) {
      if (write.kind !== 'insert') {
        failValidation(
          'Fanout child join: work.fanout_intent rows are insert-only (the frozen set is never redefined).',
        );
      }
      readFanoutIntentRow(write.row, 'state');
      continue;
    }
    if (model === FANOUT_CHILD_MODEL) {
      if (write.kind === 'remove') {
        failValidation(
          'Fanout child join: work.fanout_child rows are never removed (terminal records stand).',
        );
      }
      if (write.kind === 'insert') {
        const data = readFanoutChildRow(write.row, 'state');
        if (data.state !== 'pending' || data.attempts !== 0) {
          failValidation(
            'Fanout child join: work.fanout_child inserts stage pending with zero attempts ' +
              '(no fabricated claims or outcomes).',
          );
        }
        if (childIds.has(data.childId)) {
          failValidation(
            `Fanout child join: duplicate work.fanout_child row ${JSON.stringify(data.childId)}.`,
          );
        }
        childIds.add(data.childId);
        continue;
      }
      const data = readFanoutChildRow(write.row, 'state');
      if (childIds.has(data.childId)) {
        failValidation(
          `Fanout child join: duplicate work.fanout_child row ${JSON.stringify(data.childId)}.`,
        );
      }
      childIds.add(data.childId);
      if (data.state === 'completed' || data.state === 'skipped' || data.state === 'failed') {
        terminalOutcomes.push({ fanoutId: data.fanoutId, recordId: data.recordId });
      }
      continue;
    }
    if (model === FANOUT_CHECKPOINT_MODEL) {
      if (write.kind === 'remove') {
        failValidation(
          'Fanout child join: work.fanout_checkpoint rows are never removed.',
        );
      }
      if (write.kind === 'insert') {
        const data = readFanoutCheckpointRow(write.row, 'state');
        if (data.completed.length > 0) {
          failValidation(
            'Fanout child join: work.fanout_checkpoint inserts carry an empty completed set ' +
              '(no fabricated completion).',
          );
        }
        if (checkpointIds.has(data.fanoutId)) {
          failValidation(
            `Fanout child join: duplicate work.fanout_checkpoint row ${JSON.stringify(data.fanoutId)}.`,
          );
        }
        checkpointIds.add(data.fanoutId);
        continue;
      }
      const data = readFanoutCheckpointRow(write.row, 'state');
      if (checkpointIds.has(data.fanoutId)) {
        failValidation(
          `Fanout child join: duplicate work.fanout_checkpoint row ${JSON.stringify(data.fanoutId)}.`,
        );
      }
      checkpointIds.add(data.fanoutId);
      checkpointCovers.set(data.fanoutId, new Set(data.completed));
      continue;
    }
  }
  for (const outcome of terminalOutcomes) {
    const cover = checkpointCovers.get(outcome.fanoutId);
    if (cover === undefined || !cover.has(outcome.recordId)) {
      failValidation(
        `Fanout child join: terminal outcome for ${JSON.stringify(outcome.recordId)} ` +
          'has no same-fanout checkpoint cover in this batch.',
      );
    }
  }
  if (checkpointCovers.size > 0 && terminalOutcomes.length === 0) {
    failValidation(
      'Fanout child join: checkpoint updates carry no terminal outcome in this batch ' +
        '(cursor-only maintenance uses the plain store port).',
    );
  }
}

interface JoinWrite {
  readonly model: string;
  readonly id: string;
  readonly deliveryId: string;
  readonly revision: number;
}

function readJoinWrite(
  model: string,
  row: Parameters<typeof readAssociationRow>[0],
  updateId: string | null,
): JoinWrite {
  if (updateId !== null && updateId !== row.id) {
    failValidation(
      `Receipt join: ${model} update id ${JSON.stringify(updateId)} ` +
        `must equal its row id ${JSON.stringify(row.id)}.`,
    );
  }
  try {
    if (model === RECEIPT_ASSOCIATION_MODEL) {
      const association = readAssociationRow(row);
      return {
        model,
        id: row.id as string,
        deliveryId: association.deliveryId,
        revision: association.revision,
      };
    }
    const stored = readReceiptRow(row);
    return {
      model,
      id: row.id as string,
      deliveryId: stored.receipt.deliveryId,
      revision: stored.receipt.revision,
    };
  } catch (error) {
    if (error instanceof ReceiptTableError) {
      throw new RowsStateError(`Receipt join: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Assert the receipt-join linkage for one commit batch BEFORE it touches
 * the store (fail closed, `StateError` validation):
 *
 * - Every association insert/update carries a receipt insert/update for
 *   the SAME delivery id at the SAME revision in the same batch: the
 *   current-attempt pair advances together, never apart. Initial
 *   association, replacement (new delivery id + new pending receipt)
 *   and current-attempt progress all stage both halves.
 * - Receipt-only writes are allowed: superseded attempts update their
 *   own receipt rows without touching the current association, and
 *   fixtures may provision receipt rows before associating them.
 * - Same-batch duplicate writes to one row and update id/row id
 *   mismatches fail closed.
 *
 * Ordinary batches with neither half pass trivially, so non-receipt
 * callers are unaffected. Claim-style conditional updates on other
 * models pass trivially too.
 */
export function assertReceiptJoin(batch: CommitBatch): void {
  const associations = new Map<string, JoinWrite>();
  const receipts = new Map<string, JoinWrite>();
  const seen = new Set<string>();
  for (const write of batch.writes ?? []) {
    const model = write.model as string;
    if (model !== RECEIPT_ASSOCIATION_MODEL && model !== RECEIPT_MODEL) {
      continue;
    }
    if (write.kind === 'remove') {
      continue;
    }
    const rowId = (write.kind === 'insert' ? write.row.id : write.id) as string;
    const key = `${model}\0${rowId}`;
    if (seen.has(key)) {
      failValidation(
        `Receipt join: duplicate ${model} write for ${JSON.stringify(rowId)}.`,
      );
    }
    seen.add(key);
    const join =
      write.kind === 'insert'
        ? readJoinWrite(model, write.row, null)
        : readJoinWrite(model, write.row, write.id as string);
    if (model === RECEIPT_ASSOCIATION_MODEL) {
      associations.set(join.deliveryId, join);
    } else {
      receipts.set(join.deliveryId, join);
    }
  }
  for (const association of associations.values()) {
    const receipt = receipts.get(association.deliveryId);
    if (receipt === undefined) {
      failValidation(
        `Receipt join: association for ${JSON.stringify(association.deliveryId)} ` +
          'has no receipt row in this batch.',
      );
    }
    if (receipt.revision !== association.revision) {
      failValidation(
        `Receipt join: receipt revision ${receipt.revision} disagrees with ` +
          `association revision ${association.revision} for ` +
          `${JSON.stringify(association.deliveryId)}.`,
      );
    }
  }
}
