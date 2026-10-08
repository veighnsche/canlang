/**
 * Lane-04-owned system commands (S9b-2): occurrence/dispatch lifecycle
 * transitions as fenced `SystemCommandDef` stages.
 *
 * The registry (`createSystemRegistry`) and commit engine stay L3-owned;
 * this module only authors the lane-04 command array for assembly
 * composition (`[...l3Commands, ...WORK_SYSTEM_COMMANDS]`). Every stage
 * is type-conformant to the landed L3 S6 `SystemCommandDef` (verified by
 * `tsc`, type-only import — no runtime dependency on `@canlang/state`).
 *
 * Fence-correctness rules honored here:
 * - Readers-only contexts: stages use `load`/`query` and return staged
 *   writes; no raw store access exists to abuse.
 * - Conditional updates: every mutation stages `update` with
 *   `expectedVersion` read in-stage, so concurrent claimants serialize
 *   and exactly one wins.
 * - Query results are re-filtered exactly in-stage; predicates only
 *   narrow scans.
 * - Stages throw `KernelTableError` (plain `Error`) on invalid input or
 *   missing rows. Verified: the registry propagates stage errors raw
 *   (it maps commit errors only), so no `StateError` import is needed
 *   or used.
 * - Refusals that are business outcomes (superseded, settled, fresh
 *   claim held elsewhere, idempotent no-ops) return `result` payloads
 *   with NO writes — never errors.
 */
import type {
  DomainWrite,
  RecordId,
  StoredRow,
} from '@canlang/contracts';
import type {
  SystemCommandDef,
} from '@canlang/state';
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
  WORK_OCCURRENCE_MODEL,
  WORK_SUPERSESSION_MODEL,
  dispatchByStateQuery,
  everySlotRowId,
  newEverySlotRow,
  newOccurrenceRow,
  readDispatchRow,
  readEverySlotRow,
  readOccurrenceRow,
} from './tables.js';
import { checkArgs, argString, argNullableString, argRecord, argInstant } from './arguments.js';
import { workDispatchStageCommand } from './dispatch-staging.js';
export { workDispatchStageCommand } from './dispatch-staging.js';
import type {
  DispatchRowData,
  EverySlotRowData,
} from './tables.js';
import { isClaimStale } from '../recovery/index.js';
import {
  RootRecurrenceNotSupportedError,
  everyScopeKey,
} from '../schedule/every.js';
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

/**
 * Build the existing claim stage with an optional installed-target gate.
 * Existing lifecycle refusals precede availability. The callback sees the
 * authoritative row identity/target exactly once before any claim writes;
 * a missing target refuses without consuming a provider attempt.
 */
export function createWorkDispatchClaimCommand(
  availability?: DispatchClaimAvailability,
): SystemCommandDef {
  return {
    name: 'work.dispatch.claim',
    stage: async (args, ctx) => {
      const what = 'work.dispatch.claim';
      checkArgs(args, what);
      const intentId = argString(args, 'intentId', what);
      const claimId = argString(args, 'claimId', what) as ClaimId;
      const claimedAtMs = argInstant(args, 'claimedAtMs', what);
      const maxClaimAgeMs = argInstant(args, 'maxClaimAgeMs', what);
      const { row, data } = await loadDispatchRow(ctx, intentId, what);
      const superseded = await ctx.load(WORK_SUPERSESSION_MODEL, intentId as RecordId);
      if (superseded !== null) {
        return { result: { claimed: false, reason: 'superseded', intentId } };
      }
      let reclaimed = false;
      if (data.state === 'pending') {
        if (data.guardVerdict === false) {
          return { result: { claimed: false, reason: 'guard-false', intentId } };
        }
        if (data.availableAtMs !== null && data.availableAtMs > ctx.now) {
          return {
            result: { claimed: false, reason: 'deferred', intentId, availableAtMs: data.availableAtMs },
          };
        }
      } else if (data.state === 'claimed') {
        if (data.claimId === null || data.claimedAtMs === null || !isClaimStale(
          { outboxId: intentId as OutboxId, claimId: data.claimId, claimedAt: data.claimedAtMs },
          ctx.now,
          maxClaimAgeMs,
        )) {
          return { result: { claimed: false, reason: 'claimed', intentId, claimId: data.claimId } };
        }
        reclaimed = true;
      } else {
        return { result: { claimed: false, reason: 'settled', intentId, state: data.state } };
      }
      if (availability !== undefined && availability(intentId as OutboxId, data.source) !== true) {
        return { result: { claimed: false, reason: 'unavailable', intentId, target: data.source } };
      }
      const writes = [updateWrite(
        row,
        { ...data, state: 'claimed', claimId, claimedAtMs },
        ctx,
        WORK_DISPATCH_MODEL,
        what,
      )];
      return { writes, result: { claimed: true, ...(reclaimed ? { reclaimed: true } : {}), intentId, claimId } };
    },
  };
}

/** Default claim command preserves the existing registry's unknown-availability profile. */
export const workDispatchClaimCommand: SystemCommandDef = createWorkDispatchClaimCommand();

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
      next = {
        ...data,
        state: 'pending',
        guardVerdict: false,
        claimId: null,
        claimedAtMs: null,
      };
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
 * claimed row (exact `isClaimStale` boundary; rows without a recorded
 * claim stay claimed) back to `pending` in ONE fenced batch, in stable
 * intent-id order after the `resumeAfter` cursor. `done: false` with a
 * fresh `resumeAfter` means unvisited rows remain: resume instead of
 * silently truncating. Uncertain rows are OBSERVED (read-only ids for
 * the T24b reconciling sweeper), never touched: unknown stays unknown
 * until provider evidence arrives. Failed-row retry stays per-intent
 * `requeue` (it needs the caller's retry policy); the pure
 * `planRecoveryScan` decision table drives that half.
 */
export const workDispatchRecoverCommand: SystemCommandDef = {
  name: 'work.dispatch.recover',
  stage: async (args, ctx) => {
    const what = 'work.dispatch.recover';
    checkArgs(args, what);
    const maxClaimAgeMs = argInstant(args, 'maxClaimAgeMs', what);
    const limitValue = args['limit'];
    if (typeof limitValue !== 'number' || !Number.isInteger(limitValue) || limitValue < 1) {
      throw new KernelTableError(`${what}: limit must be an integer >= 1.`);
    }
    const resumeAfter = argNullableString(args, 'resumeAfter', what);
    const claimed = await ctx.query(dispatchByStateQuery('claimed'));
    const candidates: Array<{ row: StoredRow; intentId: string }> = [];
    const seen = new Set<string>();
    for (const row of claimed) {
      // Exact re-filter: claimed state, first sighting, after the cursor.
      const data = readDispatchRow(row);
      if (data.state !== 'claimed') continue;
      if (seen.has(data.intentId)) continue;
      seen.add(data.intentId);
      if (resumeAfter !== null && data.intentId <= resumeAfter) continue;
      candidates.push({ row, intentId: data.intentId });
    }
    candidates.sort((a, b) => compareIds(a.intentId, b.intentId));
    const writes: DomainWrite[] = [];
    const released: OutboxId[] = [];
    let visited = 0;
    for (const candidate of candidates) {
      if (released.length >= limitValue) break;
      visited += 1;
      const data = readDispatchRow(candidate.row);
      if (
        data.claimId !== null &&
        data.claimedAtMs !== null &&
        isClaimStale(
          {
            outboxId: candidate.intentId as OutboxId,
            claimId: data.claimId,
            claimedAt: data.claimedAtMs,
          },
          ctx.now,
          maxClaimAgeMs,
        )
      ) {
        writes.push(
          updateWrite(
            candidate.row,
            { ...data, state: 'pending', claimId: null, claimedAtMs: null },
            ctx,
            WORK_DISPATCH_MODEL,
            what,
          ),
        );
        released.push(candidate.intentId as OutboxId);
      }
    }
    const done = visited >= candidates.length;
    const next = candidates[visited - 1]?.intentId ?? null;
    const uncertainRows = await ctx.query(dispatchByStateQuery('uncertain'));
    const uncertain: string[] = [];
    const uncertainSeen = new Set<string>();
    for (const row of uncertainRows) {
      const data = readDispatchRow(row);
      if (data.state !== 'uncertain') continue;
      if (uncertainSeen.has(data.intentId)) continue;
      uncertainSeen.add(data.intentId);
      uncertain.push(data.intentId);
    }
    uncertain.sort(compareIds);
    const uncertainTruncated = uncertain.length > limitValue;
    return {
      writes,
      result: {
        released,
        resumeAfter: done ? null : next,
        done,
        uncertain: uncertain.slice(0, limitValue),
        uncertainTruncated,
      },
    };
  },
};

/**
 * T24a staging-join commands for assembly composition. T24b wires these
 * alongside `WORK_SYSTEM_COMMANDS`
 * (`[...l3Commands, ...WORK_SYSTEM_COMMANDS, ...WORK_DISPATCH_STAGE_COMMANDS]`)
 * and bumps the registry-shape count pin in `kernel-commands.test.ts`
 * from 9 to 11; until then this array stays the T24a composition unit
 * (verified composed-with-L3 in `t24a-staging-join.test.ts`).
 */
export const WORK_DISPATCH_STAGE_COMMANDS: readonly SystemCommandDef[] = [
  workDispatchStageCommand,
  workDispatchRecoverCommand,
];
