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
  Revision,
  ScheduleOp,
  StoragePort,
  UniqueClaim,
  UniqueRelease,
} from '../../../contracts/src/state.js';
import { StateError, storageToStateError } from '../errors.js';
import { jsonClone } from '../internal/json.js';
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
      const staged = await command.stage(clonedArgs, {
        actor: ctx.actor,
        now: ctx.now,
        operation: ctx.operation,
        load: (model, id) => deps.store.load(model, id),
        query: (spec) => deps.store.query(spec),
      });
      if (typeof staged !== 'object' || staged === null || Array.isArray(staged)) {
        throw new StateError('validation', 'System command staging must be an object.');
      }
      const outbox = stageOutboxIntents(staged.outbox ?? [], { operationId: ctx.operationId });
      const schedules = stageScheduleOps(staged.schedules ?? []);
      const outboxAck = checkOutboxAck(staged.outboxAck ?? []);
      let committed: CommitResult;
      try {
        committed = await deps.store.commit({
          expectedRevision: revision,
          writes: checkStagedArray<DomainWrite>(staged.writes ?? [], 'writes'),
          history: checkStagedArray<HistoryEntry>(staged.history ?? [], 'history'),
          receipt: null,
          outbox,
          schedules,
          uniqueClaims: checkStagedArray<UniqueClaim>(staged.uniqueClaims ?? [], 'uniqueClaims'),
          uniqueReleases: checkStagedArray<UniqueRelease>(
            staged.uniqueReleases ?? [],
            'uniqueReleases',
          ),
          outboxAck,
        });
      } catch (error) {
        throw storageToStateError(error);
      }
      return { revision: committed.revision, result: staged.result ?? null };
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
