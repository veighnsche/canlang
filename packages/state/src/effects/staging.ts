/**
 * Lane 03 S6: fail-closed validation for fenced outbox/schedule staging.
 *
 * Every failure below is a `StateError` validation — deterministic and
 * replayable as rejected receipts. Staging deep-clones valid input and
 * rebuilds fresh objects (unknown extra keys are dropped, never passed
 * through), so staged effects are engine-owned and adapter-safe.
 *
 * S6 DECISIONS (final, documented inline at each site):
 * - Intent `operationId` MUST equal the invoking operation: cross-operation
 *   staging is forbidden interim (intents belong to their operation).
 * - Intent ids are unique within one batch; duplicates are validation errors.
 * - Duplicate schedule keys in one batch are ALLOWED and apply in array
 *   order: last op for a key wins at the store (VERIFIED: the memory
 *   adapter loops the batch sequentially, set/delete per op).
 * - Schedule `at` is a finite number >= 0; past times are allowed (the
 *   scheduler fires overdue entries).
 */

import type {
  OperationId,
  OperationName,
  OutboxIntent,
  ScheduleOp,
} from '../../../contracts/src/state.js';
import { StateError } from '../errors.js';
import { checkJsonSafe, jsonClone } from '../internal/json.js';

/** Max length for staged intent ids, schedule keys, and run identities. */
export const STAGING_MAX_ID_LENGTH = 128;

/**
 * Recommended deterministic intent-id builder:
 * `${operationId}#${occurrenceIndex}`. The id format itself is free-form —
 * only non-emptiness and the length bound are enforced.
 */
export function outboxIntentId(operationId: string, occurrenceIndex: number): string {
  return `${operationId}#${occurrenceIndex}`;
}

/** Staging context: the invoking operation's identity. */
export interface StagingContext {
  readonly operationId: string;
}

/** Non-empty string within the staging id bound. */
function checkIdString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new StateError('validation', `${what} must be a non-empty string.`);
  }
  if (value.length > STAGING_MAX_ID_LENGTH) {
    throw new StateError(
      'validation',
      `${what} must be at most ${STAGING_MAX_ID_LENGTH} characters.`,
    );
  }
  return value;
}

/** Non-empty string with no length bound (operation/target/event names). */
function checkNonEmptyString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new StateError('validation', `${what} must be a non-empty string.`);
  }
  return value;
}

/** Plain data object: arrays and null are rejected, never coerced. */
function checkPlainObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StateError('validation', `${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Validate and deep-clone one batch of outbox intents. Per intent: `intentId`
 * non-empty within the bound, `operation`/`target` non-empty,
 * `arguments` a plain JSON-safe object, `occurrenceIndex` an integer >= 0,
 * `dispatchGuard` non-empty when present. The intent `operationId` MUST
 * equal `ctx.operationId` (cross-operation staging forbidden interim), and
 * intent ids must be unique within the batch.
 */
export function stageOutboxIntents(
  intents: ReadonlyArray<OutboxIntent>,
  ctx: StagingContext,
): OutboxIntent[] {
  if (!Array.isArray(intents)) {
    throw new StateError('validation', 'Staged outbox must be an array.');
  }
  if (typeof ctx?.operationId !== 'string' || ctx.operationId === '') {
    throw new StateError('validation', 'Staging needs a non-empty operation identity.');
  }
  const seen = new Set<string>();
  const staged: OutboxIntent[] = [];
  for (const intent of intents) {
    if (typeof intent !== 'object' || intent === null || Array.isArray(intent)) {
      throw new StateError('validation', 'Staged outbox intents must be objects.');
    }
    const candidate = intent as Readonly<Record<string, unknown>>;
    const intentId = checkIdString(candidate['intentId'], 'Outbox intent id');
    const operation = checkNonEmptyString(candidate['operation'], 'Outbox intent operation');
    if (candidate['operationId'] !== ctx.operationId) {
      throw new StateError(
        'validation',
        'Outbox intents belong to the invoking operation; cross-operation staging is forbidden.',
      );
    }
    const target = checkNonEmptyString(candidate['target'], 'Outbox intent target');
    const clonedArgs = jsonClone(
      checkPlainObject(candidate['arguments'], 'Outbox intent arguments'),
      'Outbox intent arguments',
    );
    checkJsonSafe(clonedArgs, 'Outbox intent arguments');
    const occurrenceIndex = candidate['occurrenceIndex'];
    if (
      typeof occurrenceIndex !== 'number' ||
      !Number.isInteger(occurrenceIndex) ||
      occurrenceIndex < 0
    ) {
      throw new StateError('validation', 'Outbox occurrence index must be an integer >= 0.');
    }
    const rawGuard = candidate['dispatchGuard'];
    let dispatchGuard: string | undefined;
    if (rawGuard === undefined) {
      dispatchGuard = undefined;
    } else if (typeof rawGuard === 'string' && rawGuard !== '') {
      dispatchGuard = rawGuard;
    } else {
      throw new StateError('validation', 'Outbox dispatch guard must be a non-empty string.');
    }
    if (seen.has(intentId)) {
      throw new StateError('validation', `Duplicate outbox intent id ${JSON.stringify(intentId)}.`);
    }
    seen.add(intentId);
    staged.push({
      intentId,
      operation: operation as OperationName,
      operationId: ctx.operationId as OperationId,
      target,
      arguments: clonedArgs,
      occurrenceIndex,
      ...(dispatchGuard !== undefined ? { dispatchGuard } : {}),
    });
  }
  return staged;
}

/**
 * Validate and deep-clone one batch of schedule ops. Replace ops carry a
 * bounded non-empty key, a finite `at` >= 0 (past allowed: the scheduler
 * fires overdue entries), a non-empty event, and a plain JSON-safe payload;
 * cancel ops carry a bounded non-empty key. Duplicate keys in one batch are
 * allowed and apply in array order (last op for a key wins at the store).
 */
export function stageScheduleOps(ops: ReadonlyArray<ScheduleOp>): ScheduleOp[] {
  if (!Array.isArray(ops)) {
    throw new StateError('validation', 'Staged schedules must be an array.');
  }
  const staged: ScheduleOp[] = [];
  for (const op of ops) {
    if (typeof op !== 'object' || op === null || Array.isArray(op)) {
      throw new StateError('validation', 'Staged schedule ops must be objects.');
    }
    const candidate = op as Readonly<Record<string, unknown>>;
    if (candidate['op'] === 'replace') {
      const key = checkIdString(candidate['key'], 'Schedule key');
      const at = candidate['at'];
      if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) {
        throw new StateError('validation', 'Schedule time must be a finite number >= 0.');
      }
      const event = checkNonEmptyString(candidate['event'], 'Schedule event');
      const clonedPayload = jsonClone(
        checkPlainObject(candidate['payload'], 'Schedule payload'),
        'Schedule payload',
      );
      checkJsonSafe(clonedPayload, 'Schedule payload');
      staged.push({ op: 'replace', key, at, event: event as OperationName, payload: clonedPayload });
    } else if (candidate['op'] === 'cancel') {
      const key = checkIdString(candidate['key'], 'Schedule key');
      staged.push({ op: 'cancel', key });
    } else {
      throw new StateError('validation', 'Schedule ops must be replace or cancel.');
    }
  }
  return staged;
}

/**
 * Validate ExecutionEffects-shaped staging (`{ outbox, schedules }`).
 * `crudExecute`'s empty arrays pass trivially.
 */
export function stageEffectsStaging(
  effects: {
    readonly outbox: ReadonlyArray<OutboxIntent>;
    readonly schedules: ReadonlyArray<ScheduleOp>;
  },
  ctx: StagingContext,
): { readonly outbox: OutboxIntent[]; readonly schedules: ScheduleOp[] } {
  if (typeof effects !== 'object' || effects === null || Array.isArray(effects)) {
    throw new StateError('validation', 'Staged effects must be an object.');
  }
  return {
    outbox: stageOutboxIntents(effects.outbox, ctx),
    schedules: stageScheduleOps(effects.schedules),
  };
}
