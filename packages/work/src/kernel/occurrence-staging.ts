import type { DomainWrite, RecordId, OccurrenceId } from '@canlang/contracts';
import type { SystemCommandDef } from '@canlang/state';
import { checkArgs, argString, argNullableString, argInstant } from './arguments.js';
import {
  KernelTableError,
  WORK_OCCURRENCE_MODEL,
  newOccurrenceRow,
  readOccurrenceRow,
  readWorkFilePayloadOrigin,
  requireWorkFilePayloadOriginReplay,
  snapshotKernelJsonValue,
  snapshotWorkFilePayloadOrigin,
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
    // Capture both original wire value and metadata before the first suspension.
    const captured = snapshotKernelJsonValue({
      result: args['result'] ?? null,
      ...snapshotWorkFilePayloadOrigin(args),
    }, what);
    const recordedAtMs =
      args['recordedAtMs'] === undefined ? ctx.now : argInstant(args, 'recordedAtMs', what);
    const code = argNullableString(args, 'code', what);
    const message = argNullableString(args, 'message', what);
    const existing = await ctx.load(
      WORK_OCCURRENCE_MODEL,
      occurrenceId as RecordId,
    );
    if (existing !== null) {
      const receipt = readOccurrenceRow(existing);
      requireWorkFilePayloadOriginReplay(readWorkFilePayloadOrigin(captured, existing,
        WORK_OCCURRENCE_MODEL, 'result', 'retained-result'), receipt.filePayloadOrigin);
      return {
        result: { duplicate: true, receipt },
      };
    }
    const filePayloadOrigin = readWorkFilePayloadOrigin(captured,
      { id: occurrenceId as RecordId, created: ctx.now, createdBy: ctx.actor },
      WORK_OCCURRENCE_MODEL, 'result', 'retained-result');
    const row = newOccurrenceRow(
      {
        occurrenceId: occurrenceId as OccurrenceId,
        status,
        result: captured.result,
        ...(filePayloadOrigin === undefined ? {} : { filePayloadOrigin }),
        code,
        message,
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
