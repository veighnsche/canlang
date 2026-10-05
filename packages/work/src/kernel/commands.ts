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
  ModelName,
  OperationId,
  OperationName,
  OutboxIntent,
  RecordId,
  ScheduleOp,
  StoredRow,
} from '../../../contracts/src/state.js';
import type {
  SystemCommandContext,
  SystemCommandDef,
} from '../../../state/src/ports/system.ts';
import type {
  ClaimId,
  OccurrenceId,
  OutboxId,
  OutboxItemState,
  RetryClass,
  WorkScope,
} from '../../../contracts/src/work.js';
import {
  KernelTableError,
  WORK_DISPATCH_MODEL,
  WORK_EVERY_SLOT_MODEL,
  WORK_OCCURRENCE_MODEL,
  WORK_SCHEDULE_MODEL,
  WORK_SUPERSESSION_MODEL,
  dispatchByOriginQuery,
  dispatchByStateQuery,
  everySlotRowId,
  newDispatchRow,
  newEverySlotRow,
  newOccurrenceRow,
  newScheduleRow,
  newSupersessionRow,
  readDispatchRow,
  readEverySlotRow,
  readOccurrenceRow,
  readScheduleRow,
  scheduleByKeyQuery,
  withRowData,
} from './tables.ts';
import type { FanoutLineage } from '../intent/index.ts';
import type {
  DispatchRowData,
  EverySlotRowData,
  ScheduleRowData,
} from './tables.ts';
import { isClaimStale } from '../recovery/index.ts';
import {
  RootRecurrenceNotSupportedError,
  everyScopeKey,
} from '../schedule/every.ts';
import type { RecurringScope } from '../../../contracts/src/work.js';

type StageContext = Pick<SystemCommandContext, 'actor' | 'now' | 'load' | 'query'>;

function checkArgs(args: Readonly<Record<string, unknown>>, what: string): void {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new KernelTableError(`${what}: args must be an object.`);
  }
}

function argString(
  args: Readonly<Record<string, unknown>>,
  field: string,
  what: string,
): string {
  const value = args[field];
  if (typeof value !== 'string' || value === '') {
    throw new KernelTableError(`${what}: ${field} must be a non-empty string.`);
  }
  return value;
}

function argNullableString(
  args: Readonly<Record<string, unknown>>,
  field: string,
  what: string,
): string | null {
  const value = args[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new KernelTableError(`${what}: ${field} must be a string or null.`);
  }
  return value;
}

function argInstant(
  args: Readonly<Record<string, unknown>>,
  field: string,
  what: string,
): number {
  const value = args[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new KernelTableError(`${what}: ${field} must be finite epoch ms >= 0.`);
  }
  return value;
}

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

function argRecord(
  args: Readonly<Record<string, unknown>>,
  field: string,
  what: string,
): Record<string, unknown> {
  const value = args[field];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KernelTableError(`${what}: ${field} must be an object.`);
  }
  return value as Record<string, unknown>;
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

function updateWrite(
  row: StoredRow,
  data: Readonly<Record<string, unknown>>,
  ctx: StageContext,
  model: ModelName,
  what: string,
): DomainWrite {
  return {
    kind: 'update',
    model,
    id: row.id,
    expectedVersion: row.version,
    row: withRowData(row, data, { nowMs: ctx.now, actor: ctx.actor }, what),
  };
}

/**
 * `work.dispatch.claim {intentId, claimId, claimedAtMs, maxClaimAgeMs}`:
 * conditional claim issuance. Mirrors `attemptDispatch` ordering
 * (supersession -> settled -> guard pin -> claim) with `expectedVersion`
 * fencing so concurrent claimants serialize and exactly one wins.
 */
export const workDispatchClaimCommand: SystemCommandDef = {
  name: 'work.dispatch.claim',
  stage: async (args, ctx) => {
    const what = 'work.dispatch.claim';
    checkArgs(args, what);
    const intentId = argString(args, 'intentId', what);
    const claimId = argString(args, 'claimId', what) as ClaimId;
    const claimedAtMs = argInstant(args, 'claimedAtMs', what);
    const maxClaimAgeMs = argInstant(args, 'maxClaimAgeMs', what);
    const { row, data } = await loadDispatchRow(ctx, intentId, what);
    const superseded = await ctx.load(
      WORK_SUPERSESSION_MODEL,
      intentId as RecordId,
    );
    if (superseded !== null) {
      return { result: { claimed: false, reason: 'superseded', intentId } };
    }
    if (data.state === 'pending') {
      // Guard pins are pending-row business: settled rows report
      // `settled` below even when they recorded a false verdict.
      if (data.guardVerdict === false) {
        return { result: { claimed: false, reason: 'guard-false', intentId } };
      }
      // Defensive: pending rows normally carry no deferral (requeue
      // clears it), but a future path must never jump the backoff.
      if (data.availableAtMs !== null && data.availableAtMs > ctx.now) {
        return {
          result: {
            claimed: false,
            reason: 'deferred',
            intentId,
            availableAtMs: data.availableAtMs,
          },
        };
      }
      const writes = [
        updateWrite(
          row,
          { ...data, state: 'claimed', claimId, claimedAtMs },
          ctx,
          WORK_DISPATCH_MODEL,
          what,
        ),
      ];
      return { writes, result: { claimed: true, intentId, claimId } };
    }
    if (
      data.state === 'claimed' &&
      data.claimId !== null &&
      data.claimedAtMs !== null &&
      isClaimStale(
        { outboxId: intentId as OutboxId, claimId: data.claimId, claimedAt: data.claimedAtMs },
        ctx.now,
        maxClaimAgeMs,
      )
    ) {
      const writes = [
        updateWrite(
          row,
          { ...data, claimId, claimedAtMs },
          ctx,
          WORK_DISPATCH_MODEL,
          what,
        ),
      ];
      return { writes, result: { claimed: true, reclaimed: true, intentId, claimId } };
    }
    if (data.state === 'claimed') {
      return {
        result: {
          claimed: false,
          reason: 'claimed',
          intentId,
          claimId: data.claimId,
        },
      };
    }
    return {
      result: { claimed: false, reason: 'settled', intentId, state: data.state },
    };
  },
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
 * Insert supersession marks for undispatched intents of one origin,
 * skipping already-marked ids (idempotent). Mirrors
 * `collectUndispatchedIntents`: pending rows only, exact origin match.
 */
async function markOriginSuperseded(
  ctx: StageContext,
  originOccurrence: string,
  byOccurrenceId: OccurrenceId | null,
  what: string,
): Promise<{ writes: DomainWrite[]; superseded: OutboxId[] }> {
  const rows = await ctx.query(dispatchByOriginQuery(originOccurrence as OccurrenceId));
  const writes: DomainWrite[] = [];
  const superseded: OutboxId[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const data = readDispatchRow(row);
    // Exact re-filter: origin match, pending state, first sighting.
    if (data.originOccurrence !== originOccurrence || data.state !== 'pending') {
      continue;
    }
    if (seen.has(data.intentId)) continue;
    seen.add(data.intentId);
    const existing = await ctx.load(WORK_SUPERSESSION_MODEL, data.intentId as RecordId);
    if (existing !== null) continue;
    writes.push({
      kind: 'insert',
      model: WORK_SUPERSESSION_MODEL,
      row: newSupersessionRow(
        {
          outboxId: data.intentId,
          byOccurrenceId,
          markedAtMs: ctx.now,
        },
        { nowMs: ctx.now, actor: ctx.actor },
      ),
    });
    superseded.push(data.intentId);
  }
  superseded.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { writes, superseded };
}

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

function argScope(
  args: Readonly<Record<string, unknown>>,
  what: string,
): WorkScope {
  const scope = argRecord(args, 'scope', what);
  return {
    app: argString(scope, 'app', `${what}.scope`),
    owner: argString(scope, 'owner', `${what}.scope`),
    ownerPackage: argString(scope, 'ownerPackage', `${what}.scope`),
  };
}

interface KeyedSchedule {
  row: StoredRow;
  data: ScheduleRowData;
}

/**
 * Every lineage entry under one key within one scope, exactly
 * re-filtered. Occurrence ids are opaque, so the head resolves
 * through `replaces` linkage (see `selectScheduleHead`) — never by
 * id comparison.
 */
async function loadKeyedSchedules(
  ctx: StageContext,
  scope: WorkScope,
  key: string,
): Promise<KeyedSchedule[]> {
  const rows = await ctx.query(scheduleByKeyQuery(scope, key));
  const found: KeyedSchedule[] = [];
  for (const row of rows) {
    const data = readScheduleRow(row);
    if (
      data.key !== key ||
      data.scopeApp !== scope.app ||
      data.scopeOwner !== scope.owner ||
      data.scopeOwnerPackage !== scope.ownerPackage
    ) {
      continue;
    }
    found.push({ row, data });
  }
  return found;
}

/**
 * Lineage head: the entry no other entry replaces. Concurrent puts
 * can race twin heads (both observed the same predecessor); the
 * deterministic id tiebreak picks one, and the next put/cancel
 * converges the twins, so no pending entry is ever stranded. The
 * no-head fallback is defensive only: `replaces` always points at a
 * row that predates the insert, so cycles cannot form.
 */
function selectScheduleHead(entries: readonly KeyedSchedule[]): KeyedSchedule | null {
  if (entries.length === 0) return null;
  const replaced = new Set<string>();
  for (const entry of entries) {
    if (entry.data.replaces !== null) replaced.add(entry.data.replaces);
  }
  const heads = entries.filter((entry) => !replaced.has(entry.data.occurrenceId));
  const candidates = heads.length > 0 ? heads : entries;
  let head: KeyedSchedule | null = null;
  for (const entry of candidates) {
    if (head === null || entry.data.occurrenceId > head.data.occurrenceId) {
      head = entry;
    }
  }
  return head;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Move `first` to the front, keeping the rest id-sorted. */
function headFirst(ids: OccurrenceId[], first: OccurrenceId): OccurrenceId[] {
  return [first, ...ids.filter((id) => id !== first).sort(compareIds)];
}

/** L3 staging bound (`STAGING_MAX_ID_LENGTH`); length is UTF-16 units. */
const SCHEDULE_KEY_MAX_LENGTH = 128;

/**
 * L3-visible schedule key for one scoped key, per the settled L3/L4
 * convention (L3 S9b addendum): slash-joined percent-encoded
 * `app/ownerPackage/owner/key`. L3 stores keys opaquely in a
 * key-global map, so producers embed the scope; lineage rows keep the
 * bare key plus flat scope fields and never decode. Total length over
 * 128 throws fail-closed (never truncate); L1 codegen must apply the
 * identical layout.
 */
function embedScheduleKey(scope: WorkScope, key: string, what: string): string {
  const embedded = [
    encodeURIComponent(scope.app),
    encodeURIComponent(scope.ownerPackage),
    encodeURIComponent(scope.owner),
    encodeURIComponent(key),
  ].join('/');
  if (embedded.length > SCHEDULE_KEY_MAX_LENGTH) {
    throw new KernelTableError(
      `${what}: embedded schedule key exceeds ${SCHEDULE_KEY_MAX_LENGTH} characters.`,
    );
  }
  return embedded;
}

/**
 * `work.schedule.put {key, scope, at, event, payload, occurrenceId}`:
 * insert-or-replace one keyed occurrence. Mirrors `putSchedule`: a
 * pending predecessor is superseded with its undispatched intents;
 * anything else stays to complete while the key moves on. Every
 * still-pending entry is superseded, not just the head, so racing
 * twin heads converge here instead of stranding a twin. Stages the
 * lineage row AND the L3 `ScheduleOp` in one fenced batch.
 */
export const workSchedulePutCommand: SystemCommandDef = {
  name: 'work.schedule.put',
  stage: async (args, ctx) => {
    const what = 'work.schedule.put';
    checkArgs(args, what);
    const key = argString(args, 'key', what);
    const scope = argScope(args, what);
    const at = argInstant(args, 'at', what);
    const event = argString(args, 'event', what);
    const payload = argRecord(args, 'payload', what);
    const occurrenceId = argString(args, 'occurrenceId', what);
    const l3Key = embedScheduleKey(scope, key, what);
    const entries = await loadKeyedSchedules(ctx, scope, key);
    const previous = selectScheduleHead(entries);
    const writes: DomainWrite[] = [];
    let affectedOutboxIds: OutboxId[] = [];
    let supersededIds: OccurrenceId[] = [];
    const pending = entries
      .filter((entry) => entry.data.state === 'pending')
      .sort((a, b) => compareIds(a.data.occurrenceId, b.data.occurrenceId));
    for (const entry of pending) {
      writes.push(
        updateWrite(
          entry.row,
          { ...entry.data, state: 'superseded' },
          ctx,
          WORK_SCHEDULE_MODEL,
          what,
        ),
      );
      const marked = await markOriginSuperseded(
        ctx,
        entry.data.occurrenceId,
        occurrenceId as OccurrenceId,
        what,
      );
      writes.push(...marked.writes);
      affectedOutboxIds = affectedOutboxIds.concat(marked.superseded);
      supersededIds.push(entry.data.occurrenceId);
    }
    affectedOutboxIds.sort(compareIds);
    const supersededId =
      previous !== null && previous.data.state === 'pending'
        ? previous.data.occurrenceId
        : null;
    if (supersededId !== null) {
      supersededIds = headFirst(supersededIds, supersededId);
    }
    writes.push({
      kind: 'insert',
      model: WORK_SCHEDULE_MODEL,
      row: newScheduleRow(
        {
          occurrenceId: occurrenceId as OccurrenceId,
          key,
          scopeApp: scope.app,
          scopeOwner: scope.owner,
          scopeOwnerPackage: scope.ownerPackage,
          at,
          event,
          payload,
          replaces: previous?.data.occurrenceId ?? null,
          state: 'pending',
        },
        { nowMs: ctx.now, actor: ctx.actor },
      ),
    });
    // The L3 op carries the scope-embedded key (settled convention);
    // the lineage row above keeps the bare key plus flat scope fields.
    const replace: ScheduleOp = {
      op: 'replace',
      key: l3Key,
      at,
      event: event as OperationName,
      payload,
    };
    return {
      writes,
      schedules: [replace],
      result: { admitted: occurrenceId, supersededId, supersededIds, affectedOutboxIds },
    };
  },
};

/**
 * `work.schedule.cancel {key, scope}`: cancel the keyed occurrence.
 * Mirrors `cancelSchedule`: pending/admitted entries cancel with their
 * undispatched intents superseded; missing/terminal keys no-op. Every
 * live entry cancels, not just the head, so racing twin heads
 * converge here instead of stranding a twin.
 */
export const workScheduleCancelCommand: SystemCommandDef = {
  name: 'work.schedule.cancel',
  stage: async (args, ctx) => {
    const what = 'work.schedule.cancel';
    checkArgs(args, what);
    const key = argString(args, 'key', what);
    const scope = argScope(args, what);
    const l3Key = embedScheduleKey(scope, key, what);
    const entries = await loadKeyedSchedules(ctx, scope, key);
    const previous = selectScheduleHead(entries);
    const live = entries
      .filter(
        (entry) =>
          entry.data.state === 'pending' || entry.data.state === 'admitted',
      )
      .sort((a, b) => compareIds(a.data.occurrenceId, b.data.occurrenceId));
    if (live.length === 0) {
      return {
        result: {
          cancelled: previous?.data.occurrenceId ?? null,
          cancelledIds: [],
          affectedOutboxIds: [],
        },
      };
    }
    const writes: DomainWrite[] = [];
    let affectedOutboxIds: OutboxId[] = [];
    let cancelledIds: OccurrenceId[] = [];
    for (const entry of live) {
      writes.push(
        updateWrite(
          entry.row,
          { ...entry.data, state: 'cancelled' },
          ctx,
          WORK_SCHEDULE_MODEL,
          what,
        ),
      );
      const marked = await markOriginSuperseded(
        ctx,
        entry.data.occurrenceId,
        null,
        what,
      );
      writes.push(...marked.writes);
      affectedOutboxIds = affectedOutboxIds.concat(marked.superseded);
      cancelledIds.push(entry.data.occurrenceId);
    }
    affectedOutboxIds.sort(compareIds);
    const cancelled =
      previous !== null &&
      (previous.data.state === 'pending' || previous.data.state === 'admitted')
        ? previous.data.occurrenceId
        : null;
    if (cancelled !== null) {
      cancelledIds = headFirst(cancelledIds, cancelled);
    }
    const cancel: ScheduleOp = { op: 'cancel', key: l3Key };
    return {
      writes,
      schedules: [cancel],
      result: { cancelled, cancelledIds, affectedOutboxIds },
    };
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
  return {
    intentId,
    operation: argString(record, 'operation', item),
    originOperationId: argString(record, 'originOperationId', item),
    source: argString(record, 'source', item),
    occurrenceIndex: argOccurrenceIndex(record, 'occurrenceIndex', item),
    request: argRecord(record, 'request', item),
    originOccurrence: argNullableString(record, 'originOccurrence', item) as OccurrenceId | null,
    guard,
    guardVerdict: verdict,
    fanout: argFanout(record, item),
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
          data.guardVerdict !== intent.guardVerdict
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
