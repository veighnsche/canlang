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
  /** Existing owning query-key order; no store or mutation capability. */
  readonly cohortIdOrder?: StoragePort['cohortIdOrder'];
}

/** Actual registry-issued staging capability, separate from caller context. */
interface SystemStageLedger {
  readonly revision: Revision;
  readonly readOnly: boolean;
  readonly readOutbox: StoragePort['outboxGet'];
  readonly checks: Array<() => boolean | Promise<boolean>>;
  phase: 'stage' | 'checks' | 'closed';
  pendingReads: number;
  poisoned: boolean;
}
const systemStages = new WeakMap<SystemCommandContext, SystemStageLedger>();
const stageReaders = new WeakMap<object, SystemStageLedger>();
const MAX_SYSTEM_COMMIT_CHECKS = 128;
// This is the released composed Work admission profile, not a global quota
// for operator commands or the public JSON helpers.
const BOUNDED_WORK_COMMANDS = new Set([
  'work.dispatch.claim', 'work.dispatch.stop-pending', 'work.dispatch.pin-image-control', 'work.dispatch.pin-mail-recipient',
  'work.dispatch.record-attempt', 'work.dispatch.requeue', 'work.dispatch.release',
  'work.dispatch.supersede', 'work.dispatch.stage', 'work.dispatch.recover',
  'work.occurrence.put-receipt', 'work.schedule.put', 'work.schedule.cancel',
  'work.every.advance-slot',
]);
function workArgsInvalid(): never {
  throw new StateError('validation', 'Work command args must be own finite JSON data.');
}

function workArgsExcess(): never {
  throw new StateError('limit', 'Work command args exceed the admission budget.', null, { retryable: false });
}

interface WorkArgsBudget {
  visits: number;
  text: number;
  readonly active: Set<object>;
  readonly copies: WeakMap<object, Record<string, unknown> | unknown[]>;
}

function chargeWorkText(budget: WorkArgsBudget, value: string): void {
  if (value.length > 2_000_000 - budget.text) workArgsExcess();
  budget.text += value.length;
}

function checkWorkShape(value: object, array: boolean, budget: WorkArgsBudget): void {
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    return workArgsInvalid();
  }
  if (!array) return;
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (length === undefined || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0) {
    return workArgsInvalid();
  }
  if (length.value > 20_000 - budget.visits) workArgsExcess();
}

function captureWorkEntry(
  value: object,
  index: number,
  array: boolean,
  keys: readonly (string | symbol)[],
  result: Record<string, unknown> | unknown[],
  depth: number,
  budget: WorkArgsBudget,
): void {
  const resolved = array ? String(index) : keys[index];
  if (typeof resolved !== 'string') return workArgsInvalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, resolved);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) return workArgsInvalid();
  // Work's capture profile counts every captured own key, including
  // array indices even though canonical JSON omits their names.
  chargeWorkText(budget, resolved);
  Object.defineProperty(result, resolved, { value: captureWorkValue(descriptor.value, depth + 1, budget), enumerable: true, writable: true, configurable: true });
}

function captureWorkEntries(
  value: object,
  array: boolean,
  length: number,
  keys: readonly (string | symbol)[],
  depth: number,
  budget: WorkArgsBudget,
): unknown {
  const entries = keys.length - (array ? 1 : 0);
  if (entries > 20_000 - budget.visits) workArgsExcess();
  if (array && entries !== length) return workArgsInvalid();
  budget.active.add(value);
  try {
    const result: Record<string, unknown> | unknown[] = array ? [] : {};
    const previous = budget.copies.get(value);
    if (previous === undefined) budget.copies.set(value, result);
    const count = array ? length : keys.length;
    for (let index = 0; index < count; index++) {
      captureWorkEntry(value, index, array, keys, result, depth, budget);
    }
    // Dense array indices above alone cannot account for symbol/extra keys.
    if (array && keys.some(key => key !== 'length' &&
        (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) return workArgsInvalid();
    // Repeated aliases still traverse and consume the expanded budget, while
    // the subsequent existing clone retains their original shared identity.
    return previous ?? result;
  } finally { budget.active.delete(value); }
}

function captureWorkValue(value: unknown, depth: number, budget: WorkArgsBudget): unknown {
  if (depth > 32 || ++budget.visits > 20_000) workArgsExcess();
  if (typeof value === 'string') { chargeWorkText(budget, value); return value; }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : workArgsInvalid();
  if (typeof value !== 'object') return workArgsInvalid();
  if (budget.active.has(value)) return workArgsInvalid();
  const array = Array.isArray(value);
  checkWorkShape(value, array, budget);
  const length = array ? (Object.getOwnPropertyDescriptor(value, 'length') as { value: number }).value : 0;
  return captureWorkEntries(value, array, length, Reflect.ownKeys(value), depth, budget);
}

function captureWorkArgs(args: Record<string, unknown>): Record<string, unknown> {
  return captureWorkValue(args, 0, { visits: 0, text: 0, active: new Set<object>(), copies: new WeakMap() }) as Record<string, unknown>;
}
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
  if (ledger.readOnly) return stageFailure(ledger, 'Read-only system execution cannot enroll commit checks.');
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
  /** Read an existing result in an issued context, without staging effects. */
  readonly read?: (args: Readonly<Record<string, unknown>>, ctx: SystemCommandContext) => unknown | Promise<unknown>;
}

/** Define one system command. Empty names are programmer bugs (lane-authored). */
export function defineSystemCommand(input: {
  readonly name: string;
  readonly stage: SystemCommandDef['stage'];
  readonly read?: NonNullable<SystemCommandDef['read']>;
}): SystemCommandDef {
  if (typeof input.name !== 'string' || input.name === '') {
    throw new Error('System commands need a non-empty name.');
  }
  return { name: input.name, stage: input.stage, ...(input.read === undefined ? {} : { read: input.read }) };
}

/** Caller context for a command run; `actor`/`operation` are opaque strings. */
export interface SystemRunContext {
  readonly actor: string;
  readonly now: number;
  readonly operation: string;
  readonly operationId: string;
}

/** Execution outcome: committed revision for run, original checkpoint for read. */
export interface SystemRunResult {
  readonly revision: Revision;
  readonly result: unknown;
}

/** Bound command registry: run by name over a caller-supplied store. */
export interface SystemRegistry {
  /** Original read checkpoint and detached result; never commits. */
  read(
    name: string,
    args: unknown,
    ctx: SystemRunContext,
    deps: { readonly store: StoragePort },
  ): Promise<SystemRunResult>;
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

/** Both execution modes issue exactly the same private, tracked reader context. */
function issueSystemContext(ctx: SystemRunContext, store: StoragePort, revision: Revision, readOnly: boolean) {
  const ledger: SystemStageLedger = { revision, readOnly, checks: [], phase: 'stage', pendingReads: 0, poisoned: false,
    readOutbox: (intentId) => read(() => store.outboxGet(intentId)) };
  const read = <T>(work: () => Promise<T>): Promise<T> => {
    const pending = (async () => {
      if (ledger.phase !== 'stage' || ledger.poisoned) return stageFailure(ledger, 'System reader crossed its original stage.');
      ledger.pendingReads++;
      try {
        const value = await work();
        if (ledger.phase !== 'stage' || ledger.poisoned) return stageFailure(ledger, 'System reader crossed its original stage.');
        return value;
      } catch (error) { ledger.poisoned = true; throw error; }
      finally { ledger.pendingReads--; }
    })();
    // A rejected fire-and-forget reader still poisons its execution; closing an
    // unawaited read must not create an unrelated unhandled rejection.
    void pending.catch(() => {});
    return pending;
  };
  const stageContext: SystemCommandContext = Object.freeze<SystemCommandContext>({
    actor: ctx.actor, now: ctx.now, operation: ctx.operation,
    cohortIdOrder: store.cohortIdOrder ?? 'utf16',
    load: (model, id) => read(() => store.load(model, id)),
    query: (spec) => read(() => store.query(spec)),
  });
  systemStages.set(stageContext, ledger);
  stageReaders.set(stageContext.load, ledger); stageReaders.set(stageContext.query, ledger);
  return { ledger, stageContext };
}

/**
 * Create the command registry. Duplicate names are programmer bugs
 * (commands are lane-authored and registered once).
 */
function prepareRunArgs(name: string, args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new StateError('validation', 'System command args must be an object.');
  }
  const capturedArgs = BOUNDED_WORK_COMMANDS.has(name) ? captureWorkArgs(args as Record<string, unknown>) : args;
  return jsonClone(capturedArgs as Record<string, unknown>, 'System command args');
}

function buildRunBatch(
  staged: SystemStaging,
  revision: Revision,
  operationId: string,
  checkCount: number,
): { readonly result: unknown; readonly batch: Parameters<StoragePort['commit']>[0] } {
  const outbox = stageOutboxIntents(staged.outbox ?? [], { operationId });
  const schedules = stageScheduleOps(staged.schedules ?? []);
  const outboxAck = checkOutboxAck(staged.outboxAck ?? []);
  const result = checkCount === 0 ? staged.result ?? null
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
  return { result, batch };
}

export function createSystemRegistry(commands: ReadonlyArray<SystemCommandDef>): SystemRegistry {
  const byName = new Map<string, SystemCommandDef>();
  for (const command of commands) {
    if (byName.has(command.name)) {
      throw new Error(`Duplicate system command ${JSON.stringify(command.name)}.`);
    }
    byName.set(command.name, command);
  }
  return {
    read: async (name, args, ctx, deps) => {
      const command = byName.get(name);
      if (command?.read === undefined) throw new StateError('validation', `System command ${JSON.stringify(name)} has no read-only execution.`);
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        throw new StateError('validation', 'System command args must be an object.');
      }
      const clonedArgs = jsonClone(args as Record<string, unknown>, 'System command args');
      if (typeof ctx.operationId !== 'string' || ctx.operationId === '' || ctx.operationId.length > STAGING_MAX_ID_LENGTH) {
        throw new StateError('validation', 'System runs need a non-empty operation identity.');
      }
      const revision = await deps.store.readRevision();
      const { ledger, stageContext } = issueSystemContext(ctx, deps.store, revision, true);
      try {
        const value = await command.read(clonedArgs, stageContext);
        ledger.phase = 'checks';
        if (ledger.pendingReads !== 0) return stageFailure(ledger, 'System read left an unawaited reader.');
        stageHealthy(ledger);
        if (typeof value === 'object' && value !== null &&
            ['writes', 'history', 'outbox', 'schedules', 'uniqueClaims', 'uniqueReleases', 'outboxAck'].some(key => Object.hasOwn(value, key))) {
          return stageFailure(ledger, 'Read-only system execution cannot return write staging.');
        }
        const result = deepFreeze(jsonClone(value ?? null, 'System read result'));
        if (await deps.store.readRevision() !== revision) {
          throw new StateError('busy', 'System read revision changed.', null, { retryable: true });
        }
        stageHealthy(ledger);
        return { revision, result };
      } finally { ledger.phase = 'closed'; }
    },
    run: async (name, args, ctx, deps) => {
      const command = byName.get(name);
      if (command === undefined) {
        throw new StateError('validation', `Unknown system command ${JSON.stringify(name)}.`);
      }
      const clonedArgs = prepareRunArgs(name, args);
      if (
        typeof ctx.operationId !== 'string' ||
        ctx.operationId === '' ||
        ctx.operationId.length > STAGING_MAX_ID_LENGTH
      ) {
        throw new StateError('validation', 'System runs need a non-empty operation identity.');
      }
      const revision = await deps.store.readRevision();
      const { ledger, stageContext } = issueSystemContext(ctx, deps.store, revision, false);
      let staged: SystemStaging;
      try { staged = await command.stage(clonedArgs, stageContext); }
      catch (error) { ledger.poisoned = true; ledger.phase = 'closed'; throw error; }
      ledger.phase = 'checks';
      try {
        if (ledger.pendingReads !== 0) return stageFailure(ledger, 'System stage left an unawaited reader.');
        stageHealthy(ledger);
        if (typeof staged !== 'object' || staged === null || Array.isArray(staged)) {
          throw new StateError('validation', 'System command staging must be an object.');
        }
        const { result, batch } = buildRunBatch(staged, revision, ctx.operationId, ledger.checks.length);
        // HEAD's check loop stays inline: synchronous verdicts never
        // suspend, so the final checks and the commit below share one
        // continuation; only a thenable verdict awaits.
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
