/**
 * Lane-04-owned system commands (S9b-2): occurrence/dispatch lifecycle
 * transitions as fenced `SystemCommandDef` stages.
 *
 * The registry (`createSystemRegistry`) and commit engine stay L3-owned;
 * this module only authors the lane-04 command array for assembly
 * composition (`[...l3Commands, ...WORK_SYSTEM_COMMANDS]`). Every stage
 * is type-conformant to the landed L3 S6 `SystemCommandDef` (verified by
 * `tsc`). The Images pending-stop stage reuses the declared State dependency
 * for its owning receipt codec; it never opens a transaction.
 *
 * Fence-correctness rules honored here:
 * - Readers-only contexts: stages use `load`/`query` and return staged
 *   writes; no raw store access exists to abuse.
 * - Conditional updates: every mutation stages `update` with
 *   `expectedVersion` read in-stage, so concurrent claimants serialize
 *   and exactly one wins.
 * - Query results are re-filtered exactly in-stage; predicates only
 *   narrow scans.
 * - Stages throw owning table errors (plain `Error`) on invalid input or
 *   missing rows. Verified: the registry propagates stage errors raw
 *   (it maps commit errors only), so no `StateError` import is needed
 *   or used.
 * - Refusals that are business outcomes (superseded, settled, fresh
 *   claim held elsewhere, idempotent no-ops) return `result` payloads
 *   with NO writes — never errors.
 */
import type {
  DomainWrite,
  ModelName,
  ReceiptResultContext,
  RecordId,
  Revision,
  StoredRow,
} from '@canlang/contracts';
import { DELIVERY_RESULT_LEAVES } from '@canlang/contracts';
import { RECEIPT_MODEL, readReceiptRow, withReceiptRowData } from '@canlang/state/receipt/tables';
export { createStandardCompletionSourceCommand } from './standard-completion-source.js';
export type { StandardCompletionDeclaration, StandardCompletionSourceBounds, StandardCompletionSourceOptions } from './standard-completion-source.js';
import type {
  SystemCommandContext,
  SystemCommandDef,
} from '@canlang/state';
import { enrollSystemCommandCommitCheck, systemCommandStageRevision } from '@canlang/state';
import { transferDispatchGuardPhase, type DispatchGuardPhase } from '../dispatch/index.js';
import { freezeRequest } from '../intent/staging.js';
import type {
  ClaimId,
  OccurrenceId,
  OutboxId,
  OutboxItemState,
  RetryClass,
} from '@canlang/contracts';
import {
  KernelTableError,
  WORK_DISPATCH_MODEL,
  WORK_EVERY_SLOT_MODEL,
  WORK_SUPERSESSION_MODEL,
  dispatchByStateQuery,
  dispatchRecoveryPageQuery,
  everySlotRowId,
  newEverySlotRow,
  readDispatchRow,
  readDispatchImageCorrelation,
  readDispatchImageControlPin,
  readDispatchMailRecipientPin,
  dispatchGenerationTargetProfile,
  DISPATCH_IMAGE_CORRELATION_FIELDS,
  readEverySlotRow,
} from './tables.js';
import { checkArgs, argString, argNullableString, argRecord, argInstant } from './arguments.js';
import { workDispatchStageCommand } from './dispatch-staging.js';
export { workDispatchStageCommand } from './dispatch-staging.js';
import { workOccurrencePutReceiptCommand } from './occurrence-staging.js';
export { workOccurrencePutReceiptCommand } from './occurrence-staging.js';
import type {
  DispatchRowData,
  EverySlotRowData,
} from './tables.js';
import { isClaimStale } from '../recovery/index.js';
import {
  RootRecurrenceNotSupportedError,
  everyScopeKey,
} from '../schedule/every-scope.js';
import type { RecurringScope } from '@canlang/contracts';

import { compareIds, markOriginSuperseded, updateWrite } from './staging-support.js';
import type { StageContext } from './staging-support.js';
import { workSchedulePutCommand, workScheduleCancelCommand } from './schedule-staging.js';
export { workSchedulePutCommand, workScheduleCancelCommand } from './schedule-staging.js';

function argBoolean(
  args: Readonly<Record<string, unknown>>,
  field: string,
  what: string,
): boolean {
  const value = args[field];
  if (typeof value !== 'boolean') {
    throw new KernelTableError(`${what}: ${field} must be a boolean.`);
  }
  return value;
}

async function loadDispatchRow(
  ctx: StageContext,
  intentId: string,
  what: string,
): Promise<{ row: StoredRow; data: DispatchRowData }> {
  const row = await ctx.load(WORK_DISPATCH_MODEL, intentId as RecordId);
  if (row === null) {
    throw new KernelTableError(
      `${what}: no dispatch row for ${JSON.stringify(intentId)} (producer write missing).`,
    );
  }
  return { row, data: readDispatchRow(row) };
}

/** Deployment-static, exact-intent availability; never transport or authority. */
export type DispatchClaimAvailability = (intentId: OutboxId, target: string) => boolean;

/** Installed synchronous allocator; called only when an eligible stage claims. */
export type DispatchClaimIdAllocator = () => ClaimId;

/** Installed source adapter only. Work supplies the actual eligible row and
 * original State stage; Dev owns source/lexical/owner correspondence. */
export interface DispatchClaimGuardInput {
  readonly row: StoredRow;
  readonly data: DispatchRowData;
  readonly context: SystemCommandContext;
  readonly revision: Revision;
}
export interface DispatchClaimGuardResult {
  readonly phase: DispatchGuardPhase;
  readonly currentAuthority: () => boolean | Promise<boolean>;
}
export type DispatchClaimGuard = (input: DispatchClaimGuardInput) =>
  DispatchClaimGuardResult | Promise<DispatchClaimGuardResult>;

function guardFalseDispatchData(data: DispatchRowData): DispatchRowData & Record<string, unknown> {
  return { ...data, state: 'pending', guardVerdict: false, claimId: null, claimedAtMs: null };
}

/**
 * Build the existing claim stage with optional installed target, guard and ID hooks.
 * Existing lifecycle refusals precede availability. The callback sees the
 * authoritative row identity/target exactly once before any claim writes;
 * a missing target refuses without consuming a provider attempt. An installed
 * allocator requires omitted claimId arguments and runs only after eligibility
 * and a successful true guard phase, before staging the claim write. Its ID
 * may be consumed even when the subsequent fenced commit fails.
 */
export function createWorkDispatchClaimCommand(
  availability?: DispatchClaimAvailability,
  guard?: DispatchClaimGuard,
  claimIdAllocator?: DispatchClaimIdAllocator,
): SystemCommandDef {
  if (guard !== undefined && typeof guard !== 'function') {
    throw new TypeError('dispatch claim guard must be an installed function');
  }
  if (claimIdAllocator !== undefined && typeof claimIdAllocator !== 'function') {
    throw new TypeError('dispatch claim ID allocator must be an installed function');
  }
  const readClaimState = (
    data: DispatchRowData, intentId: string, ctx: SystemCommandContext, maxClaimAgeMs: number, what: string,
  ): { reclaimed: boolean } | { result: { claimed: false; reason: string; intentId: string } } => {
    if (data.state === 'pending') {
      if (data.guardVerdict === false) {
        return { result: { claimed: false, reason: 'guard-false', intentId } };
      }
      if (data.availableAtMs !== null && data.availableAtMs > ctx.now) {
        return {
          result: { claimed: false, reason: 'deferred', intentId, availableAtMs: data.availableAtMs },
        } as { result: { claimed: false; reason: string; intentId: string } };
      }
      return { reclaimed: false };
    }
    if (data.state === 'claimed') {
      if (data.claimId === null || data.claimedAtMs === null || !isClaimStale(
        { outboxId: intentId as OutboxId, claimId: data.claimId, claimedAt: data.claimedAtMs },
        ctx.now,
        maxClaimAgeMs,
      )) {
        return { result: { claimed: false, reason: 'claimed', intentId, claimId: data.claimId } } as unknown as { result: { claimed: false; reason: string; intentId: string } };
      }
      return { reclaimed: true };
    }
    return { result: { claimed: false, reason: 'settled', intentId, state: data.state } } as unknown as { result: { claimed: false; reason: string; intentId: string } };
  };
  const assertGuardPhase = (
    phase: ReturnType<typeof transferDispatchGuardPhase>, ctx: SystemCommandContext,
    intentId: string, data: DispatchRowData, revision: number, what: string,
  ): void => {
    const original = phase.context.intent;
    if (typeof phase.context.predicate !== 'string' || phase.context.predicate === '' ||
        phase.context.checkpoint?.revision !== revision ||
        typeof phase.context.checkpoint.owner !== 'string' || phase.context.checkpoint.owner === '' ||
        typeof original.commit !== 'object' || original.commit === null ||
        !Number.isInteger(original.commit.revision) || original.commit.revision < 1 ||
        original.commit.revision > revision || !Number.isFinite(original.commit.committedAtMs) ||
        original.commit.committedAtMs < 0 || original.item.id !== intentId ||
        original.item.operationId !== data.operationId || original.item.source !== data.source ||
        original.item.occurrenceIndex !== data.occurrenceIndex ||
        original.item.originOccurrence !== data.originOccurrence) {
      throw new KernelTableError(`${what}: guard phase must match the original stage and eligible intent.`);
    }
  };
  const runClaimGuard = async (
    row: StoredRow, data: DispatchRowData, intentId: string, ctx: SystemCommandContext, what: string,
  ) => {
    const revision = systemCommandStageRevision(ctx);
    const snapshot = freezeRequest(row) as unknown as StoredRow;
    const guarded = await guard!(Object.freeze({ row: snapshot,
      data: Object.freeze(readDispatchRow(snapshot)), context: ctx, revision }));
    const authorityDescriptor = guarded !== null && typeof guarded === 'object'
      ? Object.getOwnPropertyDescriptor(guarded, 'currentAuthority') : undefined;
    const phaseDescriptor = guarded !== null && typeof guarded === 'object'
      ? Object.getOwnPropertyDescriptor(guarded, 'phase') : undefined;
    if (authorityDescriptor === undefined || !('value' in authorityDescriptor) ||
        typeof authorityDescriptor.value !== 'function' || phaseDescriptor === undefined ||
        !('value' in phaseDescriptor)) {
      throw new KernelTableError(`${what}: actual closed guard phase and current authority required.`);
    }
    const phase = transferDispatchGuardPhase(phaseDescriptor.value as DispatchGuardPhase, ctx);
    assertGuardPhase(phase, ctx, intentId, data, revision, what);
    const currentAuthority = authorityDescriptor.value as DispatchClaimGuardResult['currentAuthority'];
    enrollSystemCommandCommitCheck(ctx, phase.revalidate);
    enrollSystemCommandCommitCheck(ctx, () => currentAuthority.call(guarded));
    enrollSystemCommandCommitCheck(ctx, () => { phase.assertHealthy(); return true; });
    if (!phase.result) {
      return { writes: [updateWrite(row, guardFalseDispatchData(data), ctx, WORK_DISPATCH_MODEL, what)],
        outboxAck: [intentId], result: { claimed: false, reason: 'guard-false', intentId } };
    }
    return null;
  };
  return {
    name: 'work.dispatch.claim',
    stage: async (args, ctx) => {
      const what = 'work.dispatch.claim';
      checkArgs(args, what);
      const intentId = argString(args, 'intentId', what);
      if (claimIdAllocator !== undefined && Object.hasOwn(args, 'claimId')) {
        throw new KernelTableError(`${what}: claimId must be omitted with an installed allocator.`);
      }
      const suppliedClaimId = claimIdAllocator === undefined
        ? argString(args, 'claimId', what) as ClaimId : undefined;
      const claimedAtMs = argInstant(args, 'claimedAtMs', what);
      const maxClaimAgeMs = argInstant(args, 'maxClaimAgeMs', what);
      const { row, data } = await loadDispatchRow(ctx, intentId, what);
      const superseded = await ctx.load(WORK_SUPERSESSION_MODEL, intentId as RecordId);
      if (superseded !== null) {
        return { result: { claimed: false, reason: 'superseded', intentId } };
      }
      const state = readClaimState(data, intentId, ctx, maxClaimAgeMs, what);
      if (!('reclaimed' in state)) {
        return state;
      }
      if (availability !== undefined && availability(intentId as OutboxId, data.source) !== true) {
        return { result: { claimed: false, reason: 'unavailable', intentId, target: data.source } };
      }
      if (guard !== undefined) {
        const guarded = await runClaimGuard(row, data, intentId, ctx, what);
        if (guarded !== null) {
          return guarded;
        }
      }
      const claimId = claimIdAllocator === undefined ? suppliedClaimId as ClaimId
        : argString({ claimId: claimIdAllocator() }, 'claimId', what) as ClaimId;
      const writes = [updateWrite(
        row,
        { ...data, state: 'claimed', claimId, claimedAtMs },
        ctx,
        WORK_DISPATCH_MODEL,
        what,
      )];
      return { writes, result: { claimed: true, ...(state.reclaimed ? { reclaimed: true } : {}), intentId, claimId } };
    },
  };
}

/** Default claim command preserves the existing registry's unknown-availability profile. */
export const workDispatchClaimCommand: SystemCommandDef = createWorkDispatchClaimCommand();

/**
 * Stop an ORIGINAL Images submit or TextGeneration generate before its first queued receipt commits.
 * The caller joins these effects, the current association and control outcome
 * in its existing owner fence. `revision` is that batch's owner checkpoint.
 * A held provider claim is revoked; its later progress cannot hold the claim.
 * A queued result is evidence of transport admission and is never skippable.
 */
const readStopPendingRequest = (args: Readonly<Record<string, unknown>>, what: string) => {
  checkArgs(args, what);
  if (Reflect.ownKeys(args).length !== 3 ||
      Reflect.ownKeys(args).some(key => !['intentId', 'correlation', 'revision'].includes(key as string))) {
    throw new KernelTableError(`${what}: requires exactly intentId, correlation and revision.`);
  }
  const intentId = argString(args, 'intentId', what);
  const revision = args['revision'];
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    throw new KernelTableError(`${what}: revision must be a safe positive owner checkpoint.`);
  }
  const expected = argRecord(args, 'correlation', what);
  if (Reflect.ownKeys(expected).length !== DISPATCH_IMAGE_CORRELATION_FIELDS.length ||
      Reflect.ownKeys(expected).some(key => typeof key !== 'string' ||
        !DISPATCH_IMAGE_CORRELATION_FIELDS.includes(key as typeof DISPATCH_IMAGE_CORRELATION_FIELDS[number]))) {
    throw new KernelTableError(`${what}: requires exactly the original generation correlation.`);
  }
  return { intentId, revision, correlation: readDispatchImageCorrelation(expected) };
};
const loadStopReceipt = async (
  ctx: SystemCommandContext, intentId: string, data: DispatchRowData,
  retained: NonNullable<ReturnType<typeof readDispatchImageCorrelation>>,
  profile: NonNullable<ReturnType<typeof dispatchGenerationTargetProfile>>, what: string,
) => {
  const receiptRow = await ctx.load(RECEIPT_MODEL as ModelName, intentId as RecordId);
  if (receiptRow === null || receiptRow.archivedAt !== null) {
    throw new KernelTableError(`${what}: original receipt is missing.`);
  }
  const context: ReceiptResultContext = {
    source: data.source,
    declaredResult: { name: profile.resultName, fields: DELIVERY_RESULT_LEAVES[profile.resultName]! },
    request: { source: retained.requestSource, revision: retained.requestRevision },
  };
  const stored = readReceiptRow(receiptRow, context);
  // State's generic reader normalizes omitted nulls; this defining boundary
  // requires actual retained fields before asserting transport never began.
  if (!Object.hasOwn(receiptRow.data, 'result') || !Object.hasOwn(receiptRow.data, 'error')) {
    throw new KernelTableError(`${what}: original receipt must retain result and error explicitly.`);
  }
  return { receiptRow, stored, receipt: stored.receipt, context };
};
export const workDispatchStopPendingCommand: SystemCommandDef = {
  name: 'work.dispatch.stop-pending',
  stage: async (args, ctx) => {
    const what = 'work.dispatch.stop-pending';
    const { intentId, revision, correlation } = readStopPendingRequest(args, what);
    const { row, data } = await loadDispatchRow(ctx, intentId, what);
    const retained = readDispatchImageCorrelation(data);
    const profile = dispatchGenerationTargetProfile(data.source);
    if (row.id !== intentId || data.intentId !== intentId || row.archivedAt !== null ||
        profile?.role !== 'original' || correlation === null || retained === null ||
        DISPATCH_IMAGE_CORRELATION_FIELDS.some(field => correlation[field] !== retained[field])) {
      throw new KernelTableError(`${what}: original submit identity or retained correlation disagrees.`);
    }
    const { receiptRow, stored, context } = await loadStopReceipt(ctx, intentId, data, retained, profile, what);
    const settled = readStopEligibility(data, stored, receiptRow, intentId, revision, what);
    if (settled !== null) return settled;
    return buildStopWrites(row, data, receiptRow, intentId, revision, ctx, context, what);
  },
};
type StopStoredReceipt = ReturnType<typeof readReceiptRow>;
const readStopEligibility = (
  data: DispatchRowData, stored: StopStoredReceipt, receiptRow: StoredRow,
  intentId: string, revision: number, what: string,
) => {
  const receipt = stored.receipt;
  const noOp = (reason: string) => ({ result: { stopped: false, reason, intentId,
    state: data.state, receiptStatus: receipt.status } });
  if (data.guardVerdict === false && receipt.status === 'skipped' && receipt.result === null) return noOp('already-stopped');
  if (receipt.result !== null) return noOp('receipt-started');
  if (receipt.status !== 'pending') return noOp('receipt-settled');
  if (data.state !== 'pending' && data.state !== 'claimed') return noOp('settled');
  if (data.attempts !== 0 || data.firstAttemptAtMs !== null) return noOp('attempted');
  if ((data.state === 'claimed' && (data.claimId === null || data.claimedAtMs === null)) ||
      receipt.error !== null || stored.contentRef !== null || stored.resultExpiresAtMs !== null ||
      receiptRow.data['result'] !== null || receiptRow.data['error'] !== null) {
    throw new KernelTableError(`${what}: original pre-transport claim or receipt is inconsistent.`);
  }
  if (revision <= receipt.revision) {
    throw new KernelTableError(`${what}: owner checkpoint must advance the original receipt.`);
  }
  return null;
};
const buildStopWrites = (
  row: StoredRow, data: DispatchRowData, receiptRow: StoredRow, intentId: string,
  revision: number, ctx: SystemCommandContext, context: ReceiptResultContext, what: string,
) => {
  const nextReceipt = withReceiptRowData(receiptRow, {
    deliveryId: intentId, revision, status: 'skipped', result: null, error: null,
    contentRef: null, resultExpiresAtMs: null,
  }, { nowMs: ctx.now, actor: ctx.actor }, context);
  const writes: DomainWrite[] = [
    updateWrite(row, { ...data, state: 'pending', guardVerdict: false,
      claimId: null, claimedAtMs: null }, ctx, WORK_DISPATCH_MODEL, what),
    { kind: 'update', model: RECEIPT_MODEL as ModelName, id: receiptRow.id,
      expectedVersion: receiptRow.version, row: nextReceipt },
  ];
  return {
    writes,
    outboxAck: [intentId],
    result: { stopped: true, intentId, receiptRevision: revision },
  };
};

/** Pin a private recipient under the original held claim before any provider request. */
export const workDispatchPinMailRecipientCommand: SystemCommandDef = {
  name: 'work.dispatch.pin-mail-recipient',
  async stage(args, ctx) {
    const what = 'work.dispatch.pin-mail-recipient';
    checkArgs(args, what);
    const keys = ['intentId', 'claimId', 'mailRecipientUser', 'mailRecipientTeam', 'mailRecipientEmail'];
    if (Reflect.ownKeys(args).length !== keys.length || Reflect.ownKeys(args).some(key => !keys.includes(key as string))) {
      throw new KernelTableError('Private mail pin requires its exact original identity.');
    }
    const intentId = argString(args, 'intentId', what), claimId = argString(args, 'claimId', what);
    const pin = readDispatchMailRecipientPin(args);
    const { row, data } = await loadDispatchRow(ctx, intentId, what);
    if (pin === null || row.archivedAt !== null || row.id !== intentId || data.intentId !== intentId ||
        data.source !== 'std.EmailV1.send_user' || data.state !== 'claimed' || data.claimId !== claimId || data.claimedAtMs === null) {
      throw new KernelTableError('Private mail pin requires its original held user send.');
    }
    const saved = readDispatchMailRecipientPin(data);
    if (saved !== null && (saved.mailRecipientUser !== pin.mailRecipientUser || saved.mailRecipientTeam !== pin.mailRecipientTeam ||
        saved.mailRecipientEmail !== pin.mailRecipientEmail)) throw new KernelTableError('Private mail recipient cannot be replaced.');
    return { ...(saved !== null ? {} : { writes: [updateWrite(row, { ...data, ...pin }, ctx, WORK_DISPATCH_MODEL, what)] }),
      result: { pinned: true, existing: saved !== null, intentId } };
  },
};

/** Persist an immutable per-control original submit/window under its holding claim before HTTP. */
const readPinImageControlRequest = (args: Readonly<Record<string, unknown>>, what: string) => {
  checkArgs(args, what);
  const keys = ['intentId', 'claimId', 'originalIntentId', 'correlation', 'observation'];
  if (Reflect.ownKeys(args).length !== keys.length || Reflect.ownKeys(args).some(key => !keys.includes(key as string))) {
    throw new KernelTableError(`${what}: requires exact control identity, claim, original identity, correlation and observation.`);
  }
  const intentId = argString(args, 'intentId', what), claimId = argString(args, 'claimId', what);
  const originalIntentId = argString(args, 'originalIntentId', what);
  const expected = argRecord(args, 'correlation', what);
  if (Reflect.ownKeys(expected).length !== DISPATCH_IMAGE_CORRELATION_FIELDS.length ||
      Reflect.ownKeys(expected).some(key => typeof key !== 'string' ||
        !DISPATCH_IMAGE_CORRELATION_FIELDS.includes(key as typeof DISPATCH_IMAGE_CORRELATION_FIELDS[number]))) {
    throw new KernelTableError(`${what}: requires exactly the original generation correlation.`);
  }
  const correlation = readDispatchImageCorrelation(expected);
  const observation = argRecord(args, 'observation', what);
  if (Reflect.ownKeys(observation).length !== 2 || Reflect.ownKeys(observation).some(key => key !== 'startedAtMs' && key !== 'deadlineMs')) {
    throw new KernelTableError(`${what}: observation requires exactly startedAtMs and deadlineMs.`);
  }
  const started = Object.getOwnPropertyDescriptor(observation, 'startedAtMs');
  const deadline = Object.getOwnPropertyDescriptor(observation, 'deadlineMs');
  if (started === undefined || !('value' in started) || deadline === undefined || !('value' in deadline)) {
    throw new KernelTableError(`${what}: observation requires retained own data, without accessors.`);
  }
  const pin = readDispatchImageControlPin({ originalIntentId,
    observationStartedAtMs: started.value, observationDeadlineMs: deadline.value });
  return { intentId, claimId, originalIntentId, correlation, pin };
};
export const workDispatchPinImageControlCommand: SystemCommandDef = {
  name: 'work.dispatch.pin-image-control',
  stage: async (args, ctx) => {
    const what = 'work.dispatch.pin-image-control';
    const { intentId, claimId, originalIntentId, correlation, pin } = readPinImageControlRequest(args, what);
    const { row, data } = await loadDispatchRow(ctx, intentId, what);
    const controlCorrelation = readDispatchImageCorrelation(data);
    const original = await loadDispatchRow(ctx, originalIntentId, what);
    const originalCorrelation = readDispatchImageCorrelation(original.data);
    const profile = dispatchGenerationTargetProfile(data.source);
    assertControlIdentities(intentId, originalIntentId, row, data, original, profile,
      correlation, controlCorrelation, originalCorrelation, what);
    if (data.state !== 'claimed' || data.claimId !== claimId || data.claimedAtMs === null) {
      throw new KernelTableError(`${what}: claim does not hold the original generation control.`);
    }
    return stageImageControlPin(row, data, pin, intentId, ctx, what);
  },
};
const assertControlIdentities = (
  intentId: string, originalIntentId: string, row: StoredRow, data: DispatchRowData,
  original: { row: StoredRow; data: DispatchRowData },
  profile: ReturnType<typeof dispatchGenerationTargetProfile>,
  correlation: ReturnType<typeof readDispatchImageCorrelation>,
  controlCorrelation: ReturnType<typeof readDispatchImageCorrelation>,
  originalCorrelation: ReturnType<typeof readDispatchImageCorrelation>, what: string,
): void => {
  if (intentId === originalIntentId || row.id !== intentId || data.intentId !== intentId || row.archivedAt !== null ||
      profile?.role !== 'control' ||
      original.row.id !== originalIntentId || original.data.intentId !== originalIntentId || original.row.archivedAt !== null ||
      original.data.source !== profile.originalSource || correlation === null || controlCorrelation === null || originalCorrelation === null ||
      DISPATCH_IMAGE_CORRELATION_FIELDS.some(field => correlation[field] !== controlCorrelation[field] || correlation[field] !== originalCorrelation[field])) {
    throw new KernelTableError(`${what}: retained control/original identities and correlation disagree.`);
  }
};
const stageImageControlPin = (
  row: StoredRow, data: DispatchRowData, pin: ReturnType<typeof readDispatchImageControlPin>,
  intentId: string, ctx: SystemCommandContext, what: string,
) => {
  const retained = readDispatchImageControlPin(data);
  if (pin === null || pin.observationStartedAtMs !== row.created) {
    throw new KernelTableError(`${what}: observation must start at the original control creation.`);
  }
  if (retained !== null) {
    if (retained.originalIntentId !== pin.originalIntentId || retained.observationStartedAtMs !== pin.observationStartedAtMs ||
        retained.observationDeadlineMs !== pin.observationDeadlineMs) {
      throw new KernelTableError(`${what}: retained original/window cannot be renewed or replaced.`);
    }
    return { result: { pinned: true, existing: true, intentId, ...retained } };
  }
  if (pin.observationStartedAtMs > ctx.now || pin.observationDeadlineMs <= ctx.now) {
    throw new KernelTableError(`${what}: original control observation window is not active.`);
  }
  return { writes: [updateWrite(row, { ...data, ...pin }, ctx, WORK_DISPATCH_MODEL, what)],
    result: { pinned: true, existing: false, intentId, ...pin } };
};

const TERMINAL_ATTEMPT_STATES: ReadonlySet<string> = new Set([
  'delivered',
  'failed',
  'uncertain',
  'dead',
]);

/**
 * `work.dispatch.record-attempt {intentId, claimId, outcome, ack}`: record
 * one completed provider attempt (or a guard-false skip) under the holding
 * claim. Attempts increment only for provider attempts, never for skips.
 * `ack` marks the L3 intent dispatched when no further attempts follow.
 * Failed outcomes must carry `retryClass` (transient/terminal, mirroring
 * `classifyFailure`); `requeue` retries transient failures only.
 */
export const workDispatchRecordAttemptCommand: SystemCommandDef = {
  name: 'work.dispatch.record-attempt',
  stage: async (args, ctx) => {
    const what = 'work.dispatch.record-attempt';
    checkArgs(args, what);
    const intentId = argString(args, 'intentId', what);
    const claimId = argString(args, 'claimId', what);
    const outcome = argRecord(args, 'outcome', what);
    const ack = argBoolean(args, 'ack', what);
    const { row, data } = await loadDispatchRow(ctx, intentId, what);
    if (data.state !== 'claimed' || data.claimId !== claimId) {
      throw new KernelTableError(
        `${what}: claim ${JSON.stringify(claimId)} does not hold ${JSON.stringify(intentId)}.`,
      );
    }
    const stateValue = outcome['state'];
    if (typeof stateValue !== 'string') {
      throw new KernelTableError(`${what}: outcome.state must be a string.`);
    }
    const guardVerdict = outcome['guardVerdict'];
    if (guardVerdict !== undefined && typeof guardVerdict !== 'boolean') {
      throw new KernelTableError(`${what}: outcome.guardVerdict must be a boolean.`);
    }
    // No interface annotation: the inferred object-literal type stays
    // assignable to the staged record shape.
    let next: { state: string; attempts: number } & Record<string, unknown>;
    if (stateValue === 'pending') {
      // Guard-false skip: the row stays pending but pins undispatched.
      if (guardVerdict !== false) {
        throw new KernelTableError(
          `${what}: pending outcomes require guardVerdict false.`,
        );
      }
      next = guardFalseDispatchData(data);
    } else {
      if (!TERMINAL_ATTEMPT_STATES.has(stateValue)) {
        throw new KernelTableError(
          `${what}: outcome.state must be pending, delivered, failed, uncertain or dead.`,
        );
      }
      // Failed outcomes must classify the failure: `requeue` retries
      // transient failures and refuses terminal ones, so an
      // unclassified failure could never retry safely. Non-failed
      // outcomes carry no classification.
      let retryClass: RetryClass | null = null;
      if (stateValue === 'failed') {
        const retryValue = outcome['retryClass'];
        if (retryValue !== 'transient' && retryValue !== 'terminal') {
          throw new KernelTableError(
            `${what}: outcome.retryClass must be transient or terminal.`,
          );
        }
        retryClass = retryValue;
      }
      next = {
        ...data,
        state: stateValue as OutboxItemState,
        attempts: data.attempts + 1,
        // First attempt start anchors the retry horizon; later attempts keep it.
        firstAttemptAtMs: data.firstAttemptAtMs ?? data.claimedAtMs ?? ctx.now,
        claimId: null,
        claimedAtMs: null,
        retryClass,
        ...(guardVerdict !== undefined ? { guardVerdict } : {}),
        deliveryId: argNullableString(outcome, 'deliveryId', what),
        errorCode: argNullableString(outcome, 'errorCode', what),
        errorMessage: argNullableString(outcome, 'errorMessage', what),
        availableAtMs:
          outcome['availableAtMs'] === undefined || outcome['availableAtMs'] === null
            ? null
            : argInstant(outcome, 'availableAtMs', what),
      };
    }
    return {
      writes: [updateWrite(row, next, ctx, WORK_DISPATCH_MODEL, what)],
      ...(ack ? { outboxAck: [intentId] } : {}),
      result: { recorded: true, intentId, state: next.state, attempts: next.attempts },
    };
  },
};

/**
 * `work.dispatch.requeue {intentId, maxAttempts, horizonMs, notFound?}`:
 * return a retryable row to pending for its next attempt, or
 * dead-letter it when the retry budget is exhausted. Exhaustion
 * mirrors `computeBackoff` exactly (attempt cap OR horizon reached);
 * deferrals hold until `availableAtMs`. Dead-lettering here keeps
 * `dead` a visible fenced outcome rather than dispatcher-side
 * mutation.
 *
 * Sweeper rule, mirroring `recordOutcome`/`reconcileUncertain`:
 * terminal (or unclassified) failures never retry — only rows whose
 * recorded `retryClass` is transient return to pending. Uncertain
 * rows retry only when the caller attests `notFound: true`, i.e. it
 * reconciled against the provider and found no trace of the attempt
 * (the fenced equivalent of not-found evidence); unknown stays
 * unknown until that authoritative evidence arrives.
 */
export const workDispatchRequeueCommand: SystemCommandDef = {
  name: 'work.dispatch.requeue',
  stage: async (args, ctx) => {
    const what = 'work.dispatch.requeue';
    checkArgs(args, what);
    const intentId = argString(args, 'intentId', what);
    const maxAttemptsValue = args['maxAttempts'];
    if (
      typeof maxAttemptsValue !== 'number' ||
      !Number.isInteger(maxAttemptsValue) ||
      maxAttemptsValue < 1
    ) {
      throw new KernelTableError(`${what}: maxAttempts must be an integer >= 1.`);
    }
    const horizonMs = argInstant(args, 'horizonMs', what);
    const notFoundValue = args['notFound'];
    if (notFoundValue !== undefined && typeof notFoundValue !== 'boolean') {
      throw new KernelTableError(`${what}: notFound must be a boolean.`);
    }
    const { row, data } = await loadDispatchRow(ctx, intentId, what);
    if (data.state !== 'uncertain' && data.state !== 'failed') {
      return {
        result: {
          requeued: false,
          dead: false,
          intentId,
          reason: 'not-retryable',
          state: data.state,
        },
      };
    }
    if (data.state === 'failed' && data.retryClass !== 'transient') {
      // Terminal business failures (and unclassified legacy rows) are
      // final: refusing here keeps the sweeper from resurrecting them.
      return {
        result: {
          requeued: false,
          dead: false,
          intentId,
          reason: 'terminal',
          state: data.state,
        },
      };
    }
    if (data.state === 'uncertain' && notFoundValue !== true) {
      // Unknown stays unknown until the reconciling sweeper attests
      // it found no trace of the attempt at the provider.
      return {
        result: {
          requeued: false,
          dead: false,
          intentId,
          reason: 'needs-evidence',
        },
      };
    }
    const exhausted =
      data.attempts >= maxAttemptsValue ||
      (data.firstAttemptAtMs !== null &&
        ctx.now - data.firstAttemptAtMs >= horizonMs);
    if (exhausted) {
      return {
        writes: [
          updateWrite(
            row,
            { ...data, state: 'dead' },
            ctx,
            WORK_DISPATCH_MODEL,
            what,
          ),
        ],
        result: { requeued: false, dead: true, intentId, attempts: data.attempts },
      };
    }
    if (data.availableAtMs !== null && data.availableAtMs > ctx.now) {
      return {
        result: {
          requeued: false,
          dead: false,
          intentId,
          reason: 'deferred',
          availableAtMs: data.availableAtMs,
        },
      };
    }
    return {
      writes: [
        updateWrite(
          row,
          {
            ...data,
            state: 'pending',
            deliveryId: null,
            errorCode: null,
            errorMessage: null,
            availableAtMs: null,
            // Fresh attempt: the next failure classifies itself.
            retryClass: null,
          },
          ctx,
          WORK_DISPATCH_MODEL,
          what,
        ),
      ],
      result: { requeued: true, dead: false, intentId, attempts: data.attempts },
    };
  },
};

/**
 * `work.dispatch.release {intentId, maxClaimAgeMs}`: release a stale
 * claim back to pending. Applies the exact `isClaimStale` boundary;
 * rows without a recorded claim stay claimed (a live dispatcher may
 * hold them) and non-claimed rows are untouched.
 */
export const workDispatchReleaseCommand: SystemCommandDef = {
  name: 'work.dispatch.release',
  stage: async (args, ctx) => {
    const what = 'work.dispatch.release';
    checkArgs(args, what);
    const intentId = argString(args, 'intentId', what);
    const maxClaimAgeMs = argInstant(args, 'maxClaimAgeMs', what);
    const { row, data } = await loadDispatchRow(ctx, intentId, what);
    if (
      data.state === 'claimed' &&
      data.claimId !== null &&
      data.claimedAtMs !== null &&
      isClaimStale(
        {
          outboxId: intentId as OutboxId,
          claimId: data.claimId,
          claimedAt: data.claimedAtMs,
        },
        ctx.now,
        maxClaimAgeMs,
      )
    ) {
      return {
        writes: [
          updateWrite(
            row,
            { ...data, state: 'pending', claimId: null, claimedAtMs: null },
            ctx,
            WORK_DISPATCH_MODEL,
            what,
          ),
        ],
        result: { released: true, intentId },
      };
    }
    return {
      result: {
        released: false,
        intentId,
        reason: data.state === 'claimed' ? 'claim-fresh' : 'not-claimed',
      },
    };
  },
};

/**
 * `work.dispatch.supersede {originOccurrence, byOccurrenceId?}`: mark
 * every still-pending intent stamped with one origin occurrence.
 * Claimed, uncertain or settled rows are never touched.
 */
export const workDispatchSupersedeCommand: SystemCommandDef = {
  name: 'work.dispatch.supersede',
  stage: async (args, ctx) => {
    const what = 'work.dispatch.supersede';
    checkArgs(args, what);
    const originOccurrence = argString(args, 'originOccurrence', what);
    const byOccurrenceId = argNullableString(args, 'byOccurrenceId', what);
    const { writes, superseded } = await markOriginSuperseded(
      ctx,
      originOccurrence,
      byOccurrenceId as OccurrenceId | null,
      what,
    );
    return { writes, result: { superseded } };
  },
};

/**
 * `work.every.advance-slot {app, handler, scope, owner, slot}`:
 * conditional slot advance for one fanout scope. Absent rows initialize
 * (new scopes admit nothing until the next slot, per `admitEveryTick`);
 * older slots advance; current-or-newer slots no-op. Root scopes throw
 * exactly like admission. The tracker id qualifies the scope key with
 * app and handler, matching `admitEveryTick`'s per-pair coalescing.
 */
export const workEveryAdvanceSlotCommand: SystemCommandDef = {
  name: 'work.every.advance-slot',
  stage: async (args, ctx) => {
    const what = 'work.every.advance-slot';
    checkArgs(args, what);
    const app = argString(args, 'app', what);
    const handler = argString(args, 'handler', what);
    const scopeValue = argString(args, 'scope', what);
    if (scopeValue !== 'team' && scopeValue !== 'app') {
      throw new RootRecurrenceNotSupportedError(scopeValue);
    }
    const scope = scopeValue as RecurringScope;
    const owner = argString(args, 'owner', what);
    const slotValue = args['slot'];
    if (typeof slotValue !== 'number' || !Number.isInteger(slotValue) || slotValue < 0) {
      throw new KernelTableError(`${what}: slot must be an integer >= 0.`);
    }
    const scopeKey = everyScopeKey(scope, owner);
    const trackerId = everySlotRowId(app, handler, scope, owner);
    const existing = await ctx.load(WORK_EVERY_SLOT_MODEL, trackerId as RecordId);
    if (existing === null) {
      const writes: DomainWrite[] = [
        {
          kind: 'insert',
          model: WORK_EVERY_SLOT_MODEL,
          row: newEverySlotRow(
            { scopeKey, app, handler, scope, owner, slot: slotValue },
            { nowMs: ctx.now, actor: ctx.actor },
          ),
        },
      ];
      return { writes, result: { advanced: true, previous: null, slot: slotValue } };
    }
    const data: EverySlotRowData = readEverySlotRow(existing);
    if (data.slot >= slotValue) {
      return { result: { advanced: false, previous: data.slot, slot: slotValue } };
    }
    return {
      writes: [
        updateWrite(
          existing,
          { ...data, slot: slotValue },
          ctx,
          WORK_EVERY_SLOT_MODEL,
          what,
        ),
      ],
      result: { advanced: true, previous: data.slot, slot: slotValue },
    };
  },
};

/**
 * Lane-04-owned system commands for assembly composition. Register
 * alongside the L3 commands; names are dot-namespaced per the S6
 * convention and unique across the composed registry.
 */
export const WORK_SYSTEM_COMMANDS: readonly SystemCommandDef[] = [
  workDispatchClaimCommand,
  workDispatchStopPendingCommand,
  workDispatchPinImageControlCommand,
  workDispatchPinMailRecipientCommand,
  workDispatchRecordAttemptCommand,
  workDispatchRequeueCommand,
  workDispatchReleaseCommand,
  workDispatchSupersedeCommand,
  workOccurrencePutReceiptCommand,
  workSchedulePutCommand,
  workScheduleCancelCommand,
  workEveryAdvanceSlotCommand,
];

/* -- T24a staging join: atomic dispatch staging + batch recovery. -- */

/**
 * `work.dispatch.recover {maxClaimAgeMs, limit, resumeAfter?}`: bounded
 * batch recovery resuming interrupted claims. Releases every stale
 * claimed row visited within the shared row budget (exact `isClaimStale`
 * boundary; rows without a recorded claim stay claimed) back to `pending` in ONE fenced batch, in stable
 * intent-id order after the `resumeAfter` cursor. Fresh and uncertain rows
 * consume the same visit budget; at most two `limit+1` windows are loaded.
 * `done: false` with a fresh `resumeAfter` means unvisited rows remain: resume instead of
 * silently truncating. Uncertain rows are OBSERVED (read-only ids for
 * the T24b reconciling sweeper), never touched: unknown stays unknown
 * until provider evidence arrives. Failed-row retry stays per-intent
 * `requeue` (it needs the caller's retry policy); the pure
 * `planRecoveryScan` decision table drives that half.
 */
type RecoveryCandidate = {row: StoredRow; data: ReturnType<typeof readDispatchRow>; intentId: string};
const readRecoverRequest = (args: Readonly<Record<string, unknown>>, ctx: SystemCommandContext, what: string) => {
  checkArgs(args, what);
  const maxClaimAgeMs = argInstant(args, 'maxClaimAgeMs', what);
  const limitValue = args['limit'];
  if (typeof limitValue !== 'number' || !Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue === Number.MAX_SAFE_INTEGER) {
    throw new KernelTableError(`${what}: limit must be an integer >= 1 with a safe bounded lookahead.`);
  }
  const resumeAfter = argNullableString(args, 'resumeAfter', what);
  if (ctx.cohortIdOrder !== undefined && ctx.cohortIdOrder !== 'utf16' && ctx.cohortIdOrder !== 'utf8-binary') {
    throw new KernelTableError(`${what}: unsupported owning query id order.`);
  }
  const encoder = new TextEncoder();
  const compare = ctx.cohortIdOrder === 'utf8-binary' ? (a: string, b: string): number => {
    const left = encoder.encode(a), right = encoder.encode(b);
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      if (left[i] !== right[i]) return left[i]! - right[i]!;
    }
    return left.length - right.length;
  } : compareIds;
  return { maxClaimAgeMs, limitValue, resumeAfter, compare };
};
const collectRecoveryPage = (
  rows: readonly StoredRow[], state: 'claimed' | 'uncertain',
  compare: (a: string, b: string) => number, resumeAfter: string | null,
  seen: Map<string, 'claimed' | 'uncertain'>, candidates: RecoveryCandidate[], what: string,
): void => {
  // Validate this reader before opening the next one: an earlier malformed
  // claimed row keeps precedence over a later uncertain-reader failure.
  for (const row of rows) {
    const data = readDispatchRow(row);
    if (data.state !== state) throw new KernelTableError(`${what}: storage reader returned a foreign lifecycle state.`);
    if (row.id !== data.intentId) throw new KernelTableError(`${what}: dispatch identity differs from its row key.`);
    if (resumeAfter !== null && compare(data.intentId, resumeAfter) <= 0) {
      throw new KernelTableError(`${what}: storage reader crossed its resume boundary.`);
    }
    const priorState = seen.get(data.intentId);
    if (priorState === state) throw new KernelTableError(`${what}: storage reader duplicated a recovery identity.`);
    // A transition between the two reads is a normal race. Keep the first
    // sample; the registry's original revision fence rejects publication.
    if (priorState !== undefined) continue;
    seen.set(data.intentId, state); candidates.push({row, data, intentId: data.intentId});
  }
};
const collectRecoveryCandidates = async (
  ctx: SystemCommandContext, compare: (a: string, b: string) => number,
  resumeAfter: string | null, windowLimit: number, what: string,
): Promise<RecoveryCandidate[]> => {
  // Two bounded indexed windows include one lookahead each. The shared
  // visit budget includes fresh claims and uncertain rows, not just releases.
  const list: RecoveryCandidate[] = [];
  const seen = new Map<string, 'claimed' | 'uncertain'>();
  for (const state of ['claimed', 'uncertain'] as const) {
    const rows = await ctx.query(dispatchRecoveryPageQuery(state, windowLimit, resumeAfter));
    if (rows.length > windowLimit) throw new KernelTableError(`${what}: storage reader exceeded its bounded window.`);
    collectRecoveryPage(rows, state, compare, resumeAfter, seen, list, what);
  }
  list.sort((a, b) => compare(a.intentId, b.intentId));
  return list;
};
export const workDispatchRecoverCommand: SystemCommandDef = {
  name: 'work.dispatch.recover',
  stage: async (args, ctx) => {
    const what = 'work.dispatch.recover';
    const { maxClaimAgeMs, limitValue, resumeAfter, compare } = readRecoverRequest(args, ctx, what);
    // Two bounded indexed windows include one lookahead each. The shared
    // visit budget includes fresh claims and uncertain rows, not just releases.
    const windowLimit = limitValue + 1;
    const candidates = await collectRecoveryCandidates(ctx, compare, resumeAfter, windowLimit, what);
    const writes: DomainWrite[] = [], released: OutboxId[] = [], uncertain: string[] = [];
    const visited = Math.min(limitValue, candidates.length);
    for (const candidate of candidates.slice(0, visited)) {
      const data = candidate.data;
      if (data.state === 'uncertain') {uncertain.push(candidate.intentId); continue;}
      if (data.claimId !== null && data.claimedAtMs !== null && isClaimStale({
        outboxId: candidate.intentId as OutboxId, claimId: data.claimId, claimedAt: data.claimedAtMs,
      }, ctx.now, maxClaimAgeMs)) {
        writes.push(updateWrite(candidate.row, {...data, state: 'pending', claimId: null, claimedAtMs: null},
          ctx, WORK_DISPATCH_MODEL, what));
        released.push(candidate.intentId as OutboxId);
      }
    }
    const done = visited === candidates.length;
    const next = candidates[visited - 1]?.intentId ?? null;
    const uncertainTruncated = candidates.slice(visited).some(candidate => candidate.data.state === 'uncertain');
    return {
      writes,
      result: {
        released,
        resumeAfter: done ? null : next,
        done,
        uncertain,
        uncertainTruncated,
      },
    };
  },
};

/**
 * T24a staging-join commands for assembly composition. T24b wires these
 * alongside `WORK_SYSTEM_COMMANDS`
 * (`[...l3Commands, ...WORK_SYSTEM_COMMANDS, ...WORK_DISPATCH_STAGE_COMMANDS]`)
 * plus the Images stop/pin commands yield 13 composed Work commands;
 * this array stays the T24a composition unit
 * (verified composed-with-L3 in `t24a-staging-join.test.ts`).
 */
export const WORK_DISPATCH_STAGE_COMMANDS: readonly SystemCommandDef[] = [
  workDispatchStageCommand,
  workDispatchRecoverCommand,
];
