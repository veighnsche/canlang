import type { DomainWrite, RecordId, OccurrenceId } from '@canlang/contracts';
import type { SystemCommandDef } from '@canlang/state';
import { checkArgs, argString, argNullableString, argInstant } from './arguments.js';
import {
  KernelTableError,
  WORK_OCCURRENCE_MODEL,
  newOccurrenceRow,
  readOccurrenceRow,
} from './tables.js';

/**
 * `work.occurrence.put-receipt {occurrenceId, status, result?, code?,
 * message?, recordedAtMs?}`: put-if-absent receipt recording. Losers
 * replay the winner's receipt and never re-execute.
 */
export const workOccurrencePutReceiptCommand: SystemCommandDef = {
  name: 'work.occurrence.put-receipt',
  stage: async (args, ctx) => {
    const what = 'work.occurrence.put-receipt';
    checkArgs(args, what);
    const occurrenceId = argString(args, 'occurrenceId', what);
    const status = args['status'];
    if (status !== 'completed' && status !== 'failed') {
      throw new KernelTableError(
        `${what}: status must be completed or failed.`,
      );
    }
    const existing = await ctx.load(
      WORK_OCCURRENCE_MODEL,
      occurrenceId as RecordId,
    );
    if (existing !== null) {
      return {
        result: { duplicate: true, receipt: readOccurrenceRow(existing) },
      };
    }
    const recordedAtMs =
      args['recordedAtMs'] === undefined ? ctx.now : argInstant(args, 'recordedAtMs', what);
    const result = args['result'] ?? null;
    const row = newOccurrenceRow(
      {
        occurrenceId: occurrenceId as OccurrenceId,
        status,
        result,
        code: argNullableString(args, 'code', what),
        message: argNullableString(args, 'message', what),
        recordedAtMs,
      },
      { nowMs: ctx.now, actor: ctx.actor },
    );
    const writes: DomainWrite[] = [
      { kind: 'insert', model: WORK_OCCURRENCE_MODEL, row },
    ];
    return { writes, result: { duplicate: false, occurrenceId } };
  },
};
