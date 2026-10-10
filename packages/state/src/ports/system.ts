/**
 * Lane 03 S6: privileged fenced system commands WITHOUT raw store access.
 *
 * S6 DECISIONS (final, documented inline at each site):
 * - Command stage contexts are READERS ONLY: bound `load`/`query` with NO
 *   commit/store key, so command authors cannot write around the fence — a
 *   structural guarantee, not a convention.
 * - `SystemRunContext.operationId` is the caller-supplied idempotency key
 *   for the run: non-empty, within the id bound, NO UUID requirement
 *   (commands are operator-driven). Staged intents' `operationId` must
 *   equal it (enforced by `stageOutboxIntents`).
 * - Receiptless interim: runs commit with `receipt: null`; idempotency
 *   comes from arg-shape (ack/cancel/replace are naturally idempotent).
 * - Single-shot fenced commit (expectedRevision); fence conflicts map via
 *   `storageToStateError` to retryable `busy`. Absent staged `result`
 *   reads as null.
 * - Command names are dot-namespaced (`outbox.ack`, `schedule.cancel`,
 *   `schedule.replace`); unknown names are `validation` errors.
 */

import type {
  CommitResult,
  DomainWrite,
  HistoryEntry,
  OutboxIntent,
  RetainedOutboxIntent,
  Revision,
  ScheduleOp,
  StoragePort,
  UniqueClaim,
  UniqueRelease,
} from '@canlang/contracts';
import { StateError, storageToStateError } from '../errors.js';
import { jsonClone } from '../internal/json.js';
import { deepFreeze } from '../internal/own-data.js';
import {
  STAGING_MAX_ID_LENGTH,
  stageOutboxIntents,
  stageScheduleOps,
} from '../effects/staging.js';

/** Staged command outcome: fenced-commit inputs plus the caller result. */
export interface SystemStaging {
  readonly writes?: ReadonlyArray<DomainWrite>;
  readonly history?: ReadonlyArray<HistoryEntry>;
  readonly outbox?: ReadonlyArray<OutboxIntent>;
  readonly schedules?: ReadonlyArray<ScheduleOp>;
  readonly uniqueClaims?: ReadonlyArray<UniqueClaim>;
  readonly uniqueReleases?: ReadonlyArray<UniqueRelease>;
  readonly outboxAck?: ReadonlyArray<string>;
  readonly result?: unknown;
}

/**
 * Command stage context: READERS ONLY. `load`/`query` are the bound store
 * readers; there is deliberately no commit/store key.
 */
export interface SystemCommandContext {
  readonly actor: string;
  readonly now: number;
  readonly operation: string;
  readonly load: StoragePort['load'];
  readonly query: StoragePort['query'];
}

/** Actual registry-issued staging capability, separate from caller context. */
interface SystemStageLedger {
  readonly revision: Revision;
  readonly readOutbox: StoragePort['outboxGet'];
  readonly checks: Array<() => boolean | Promise<boolean>>;
  phase: 'stage' | 'checks' | 'closed';
  pendingReads: number;
  poisoned: boolean;
}
const systemStages = new WeakMap<SystemCommandContext, SystemStageLedger>();
const stageReaders = new WeakMap<object, SystemStageLedger>();
const MAX_SYSTEM_COMMIT_CHECKS = 128;
function stageFailure(ledger: SystemStageLedger | undefined, message: string): never {
  if (ledger !== undefined) ledger.poisoned = true;
  throw new StateError('validation', message);
}
function actualStage(ctx: SystemCommandContext): SystemStageLedger {
  if (typeof ctx !== 'object' || ctx === null) return stageFailure(undefined, 'System stage context was not issued by the registry.');
  const ledger = systemStages.get(ctx);
  if (ledger === undefined) {
    // A copied issued reader must not let a caught provenance failure leave
    // its original run healthy. Inspect own values without executing getters.
    for (const name of ['load', 'query']) {
      const value = Object.getOwnPropertyDescriptor(ctx, name);
      if (value !== undefined && 'value' in value && typeof value.value === 'function') {
        const original = stageReaders.get(value.value);
        if (original !== undefined) original.poisoned = true;
      }
    }
    return stageFailure(undefined, 'System stage context was not issued by the registry.');
  }
  if (ledger.poisoned || ledger.phase !== 'stage') return stageFailure(ledger, 'System stage context is closed or poisoned.');
  return ledger;
}
/** The original physical checkpoint; this grants neither a store nor authority. */
export function systemCommandStageRevision(ctx: SystemCommandContext): Revision {
  return actualStage(ctx).revision;
}
/** Original retained carrier through this issued stage's tracked reader.
 * No new context member, store handle, source grant or reconstructed stamp.
 */
export function readSystemCommandRetainedOutbox(ctx: SystemCommandContext,
  intentId: string): Promise<RetainedOutboxIntent | null> {
  const ledger = actualStage(ctx);
  if (typeof intentId !== 'string' || intentId === '' || intentId.length > STAGING_MAX_ID_LENGTH) {
    return stageFailure(ledger, 'System retained outbox reader requires a bounded intent identity.');
  }
  return ledger.readOutbox(intentId);
}
/** Enroll only during this actual stage. Registry closes and consumes once. */
export function enrollSystemCommandCommitCheck(ctx: SystemCommandContext,
  check: () => boolean | Promise<boolean>): void {
  const ledger = actualStage(ctx);
  if (typeof check !== 'function' || ledger.checks.length >= MAX_SYSTEM_COMMIT_CHECKS) {
    return stageFailure(ledger, 'System stage requires a bounded commit check function.');
  }
  ledger.checks.push(check);
}
function stageHealthy(ledger: SystemStageLedger): void {
  if (ledger.poisoned) stageFailure(ledger, 'System stage context is poisoned.');
}

/** Privileged command definition: validated name plus staging function. */
export interface SystemCommandDef {
  readonly name: string;
  readonly stage: (
    args: Readonly<Record<string, unknown>>,
    ctx: SystemCommandContext,
  ) => SystemStaging | Promise<SystemStaging>;
}

/** Define one system command. Empty names are programmer bugs (lane-authored). */
export function defineSystemCommand(input: {
  readonly name: string;
  readonly stage: SystemCommandDef['stage'];
}): SystemCommandDef {
  if (typeof input.name !== 'string' || input.name === '') {
    throw new Error('System commands need a non-empty name.');
  }
  return { name: input.name, stage: input.stage };
}

/** Caller context for a command run; `actor`/`operation` are opaque strings. */
export interface SystemRunContext {
  readonly actor: string;
  readonly now: number;
  readonly operation: string;
  readonly operationId: string;
}

/** Command run outcome: the post-commit fence revision plus staged result. */
export interface SystemRunResult {
  readonly revision: Revision;
  readonly result: unknown;
}

/** Bound command registry: run by name over a caller-supplied store. */
export interface SystemRegistry {
  run(
    name: string,
    args: unknown,
    ctx: SystemRunContext,
    deps: { readonly store: StoragePort },
  ): Promise<SystemRunResult>;
}

/** Pass-through staged arrays must at least be arrays (fail closed). */
function checkStagedArray<T>(value: unknown, what: string): ReadonlyArray<T> {
  if (!Array.isArray(value)) {
    throw new StateError('validation', `System staging ${what} must be an array.`);
  }
  return value as ReadonlyArray<T>;
}

/** Ack ids are validated fail-closed against the staging id bound. */
function checkOutboxAck(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    throw new StateError('validation', 'System staging outboxAck must be an array.');
  }
  for (const id of value) {
    if (typeof id !== 'string' || id === '' || id.length > STAGING_MAX_ID_LENGTH) {
      throw new StateError('validation', 'Outbox ack ids must be non-empty strings.');
    }
  }
  return value as ReadonlyArray<string>;
}

/**
 * Create the command registry. Duplicate names are programmer bugs
 * (commands are lane-authored and registered once).
 */
export function createSystemRegistry(commands: ReadonlyArray<SystemCommandDef>): SystemRegistry {
  const byName = new Map<string, SystemCommandDef>();
  for (const command of commands) {
    if (byName.has(command.name)) {
      throw new Error(`Duplicate system command ${JSON.stringify(command.name)}.`);
    }
    byName.set(command.name, command);
  }
  return {
    run: async (name, args, ctx, deps) => {
      const command = byName.get(name);
      if (command === undefined) {
        throw new StateError('validation', `Unknown system command ${JSON.stringify(name)}.`);
      }
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        throw new StateError('validation', 'System command args must be an object.');
      }
      const clonedArgs = jsonClone(args as Record<string, unknown>, 'System command args');
      if (
        typeof ctx.operationId !== 'string' ||
        ctx.operationId === '' ||
        ctx.operationId.length > STAGING_MAX_ID_LENGTH
      ) {
        throw new StateError('validation', 'System runs need a non-empty operation identity.');
      }
      const revision = await deps.store.readRevision();
      const ledger: SystemStageLedger = { revision, checks: [], phase: 'stage', pendingReads: 0, poisoned: false,
        readOutbox: (intentId) => read(() => deps.store.outboxGet(intentId)) };
      const read = async <T>(work: () => Promise<T>): Promise<T> => {
        if (ledger.phase !== 'stage' || ledger.poisoned) return stageFailure(ledger, 'System reader crossed its original stage.');
        ledger.pendingReads++;
        try {
          const value = await work();
          if (ledger.phase !== 'stage' || ledger.poisoned) return stageFailure(ledger, 'System reader crossed its original stage.');
          return value;
        } finally { ledger.pendingReads--; }
      };
      const stageContext: SystemCommandContext = Object.freeze<SystemCommandContext>({
        actor: ctx.actor, now: ctx.now, operation: ctx.operation,
        load: (model, id) => read(() => deps.store.load(model, id)),
        query: (spec) => read(() => deps.store.query(spec)),
      });
      systemStages.set(stageContext, ledger);
      stageReaders.set(stageContext.load, ledger); stageReaders.set(stageContext.query, ledger);
      let staged: SystemStaging;
      try { staged = await command.stage(clonedArgs, stageContext); }
      catch (error) { ledger.poisoned = true; ledger.phase = 'closed'; throw error; }
      ledger.phase = 'checks';
      if (ledger.pendingReads !== 0) return stageFailure(ledger, 'System stage left an unawaited reader.');
      stageHealthy(ledger);
      try {
        if (typeof staged !== 'object' || staged === null || Array.isArray(staged)) {
          throw new StateError('validation', 'System command staging must be an object.');
        }
        const outbox = stageOutboxIntents(staged.outbox ?? [], { operationId: ctx.operationId });
        const schedules = stageScheduleOps(staged.schedules ?? []);
        const outboxAck = checkOutboxAck(staged.outboxAck ?? []);
        const result = ledger.checks.length === 0 ? staged.result ?? null
          : jsonClone(staged.result ?? null, 'System staging result');
        // Detach exact staged effects before any retained callback can await or
        // mutate the producer's output. All existing owning validators still run.
        const batch = deepFreeze(jsonClone({
          expectedRevision: revision,
          writes: checkStagedArray<DomainWrite>(staged.writes ?? [], 'writes'),
          history: checkStagedArray<HistoryEntry>(staged.history ?? [], 'history'),
          receipt: null, outbox, schedules,
          uniqueClaims: checkStagedArray<UniqueClaim>(staged.uniqueClaims ?? [], 'uniqueClaims'),
          uniqueReleases: checkStagedArray<UniqueRelease>(staged.uniqueReleases ?? [], 'uniqueReleases'),
          outboxAck,
        }, 'System staging effects'));
        for (const check of ledger.checks) {
          stageHealthy(ledger);
          const verdict = check();
          const accepted = typeof verdict === 'boolean' ? verdict : await verdict;
          stageHealthy(ledger);
          if (typeof accepted !== 'boolean') return stageFailure(ledger, 'System commit check must return a boolean.');
          if (!accepted) throw new StateError('forbidden', 'System commit evidence or current authority changed.');
        }
        stageHealthy(ledger);
        let committed: CommitResult;
        try { committed = await deps.store.commit(batch); }
        catch (error) { throw storageToStateError(error); }
        return { revision: committed.revision, result };
      } finally { ledger.phase = 'closed'; }

    },
  };
}

/** Bounded id-list check shared by the ack/cancel commands. */
function checkIdList(value: unknown, what: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new StateError(
      'validation',
      allowEmpty ? `${what} must be an array.` : `${what} must be a non-empty array.`,
    );
  }
  for (const id of value) {
    if (typeof id !== 'string' || id === '' || id.length > STAGING_MAX_ID_LENGTH) {
      throw new StateError('validation', `${what} entries must be non-empty strings.`);
    }
  }
  return [...value];
}

/**
 * Acknowledge dispatched outbox intents (`{ intentIds }`). Ack is idempotent
 * (unknown or already-dispatched ids are a no-op), so repeats of one run
 * are safe.
 */
export const outboxAckCommand: SystemCommandDef = defineSystemCommand({
  name: 'outbox.ack',
  stage: (args) => {
    const intentIds = checkIdList(args['intentIds'], 'intentIds', false);
    return { outboxAck: intentIds, result: { requested: intentIds.length } };
  },
});

/**
 * Cancel scheduled entries (`{ keys }`). Empty keys commits a no-op batch
 * (allowed; contrast ack, which the spec requires non-empty). Naturally
 * idempotent: canceling an absent key is a no-op.
 */
export const scheduleCancelCommand: SystemCommandDef = defineSystemCommand({
  name: 'schedule.cancel',
  stage: (args) => {
    const keys = checkIdList(args['keys'], 'keys', true);
    return {
      schedules: keys.map((key): ScheduleOp => ({ op: 'cancel', key })),
      result: { requested: keys.length },
    };
  },
});

/**
 * Replace one scheduled entry (`{ key, at, event, payload }`), validated
 * EXACTLY like staging by delegating to `stageScheduleOps`; `run()`
 * re-validates the staged op (idempotent).
 */
export const scheduleReplaceCommand: SystemCommandDef = defineSystemCommand({
  name: 'schedule.replace',
  stage: (args) => {
    const schedules = stageScheduleOps([
      {
        op: 'replace',
        key: args['key'],
        at: args['at'],
        event: args['event'],
        payload: args['payload'],
      } as ScheduleOp,
    ]);
    const first = schedules[0];
    if (first === undefined || first.op !== 'replace') {
      // Unreachable: one replace in, one replace out — staging maps 1:1.
      throw new StateError('validation', 'Schedule replace needs { key, at, event, payload }.');
    }
    return { schedules, result: { key: first.key } };
  },
});
