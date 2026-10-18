/**
 * Recurring `every(duration)` admission: UTC-epoch slot computation with
 * per-scope coalescing (DESIGN section 6).
 *
 * Ticks are UTC-epoch aligned; missed periods coalesce to one current
 * occurrence per scope. Each occurrence identity covers selected app,
 * canonical handler contract, concrete owner and UTC epoch slot, so
 * compatible releases mint no duplicates. New scopes begin at the next slot
 * (nothing is admitted for them on the tick they appear); removed scopes
 * admit no future work.
 *
 * V1 fanout covers team/app scopes only. A root scope is rejected with
 * `RootRecurrenceNotSupportedError`; root recurrence uses explicit
 * record-bound `schedule`.
 */
import { createHash } from 'node:crypto';
import type { OccurrenceId, RecurringOccurrence, RecurringScope } from '@canlang/contracts';

import { RootRecurrenceNotSupportedError, everyScopeKey } from './every-scope.js';
export { RootRecurrenceNotSupportedError, everyScopeKey } from './every-scope.js';
import { tsWorkKernel } from '@canlang/work-kernel';
import type { WorkKernel } from '@canlang/work-kernel';
import type { RecurringIdPort } from '@canlang/work-kernel/every';

/** One eligible fanout scope for this tick. `scope` is validated at admission. */
export interface EveryScopeInput {
  scope: string;
  /** Concrete verified owner key (team id or app marker). */
  owner: string;
}

export interface EveryTickInput {
  /** Current time as UTC epoch milliseconds. */
  nowMs: number;
  /** Recurrence period in milliseconds; must be a positive multiple of 1000. */
  periodMs: number;
  /** Selected app name. */
  app: string;
  /** Canonical handler contract identity. */
  handler: string;
  /** Currently eligible scopes. */
  scopes: readonly EveryScopeInput[];
  /**
   * Last admitted slot (seconds) per scope key from `everyScopeKey`, for
   * scopes known before this tick. Absent keys are new scopes; keys missing
   * from `scopes` are removed scopes.
   */
  previousSlots: Readonly<Record<string, number>>;
}

export interface EveryTickResult {
  /** Current UTC epoch slot in seconds. */
  slot: number;
  /** Current slot start as UTC epoch milliseconds. */
  slotStartMs: number;
  /** Admitted occurrences, in stable (scope, owner) order. */
  admitted: RecurringOccurrence[];
}

export interface EverySlot {
  slot: number;
  slotStartMs: number;
}

/**
 * UTC-epoch aligned slot containing `nowMs`. Pure. Routes through the
 * selected kernel (identical decisions); the TypeScript backend is default.
 */
export function computeEverySlot(nowMs: number, periodMs: number, kernel: WorkKernel = tsWorkKernel): EverySlot {
  return kernel.every.computeEverySlot(nowMs, periodMs);
}

/**
 * Stable occurrence identity from app, handler, scope, owner and slot.
 * Deterministic across releases: the same tick never mints a duplicate.
 */
export function deriveRecurringOccurrenceId(
  app: string,
  handler: string,
  scope: RecurringScope,
  owner: string,
  slot: number,
): OccurrenceId {
  const digest = createHash('sha256')
    .update(
      `can-work/every-id/v1\0${app}\0${handler}\0${scope}\0${owner}\0${slot}`,
      'utf8',
    )
    .digest('hex');
  return `evr_${digest}`;
}

/**
 * Admit one `every` tick. Returns the current slot and the coalesced
 * occurrence set: at most one occurrence per eligible pre-existing scope at
 * the current slot. New scopes admit nothing until the next slot; removed
 * scopes and already-admitted slots admit nothing.
 *
 * Routes through the selected kernel with the donor host mint by default
 * (identical decisions); the donor `deriveRecurringOccurrenceId` stays the
 * host authority and still mints at its original demand.
 */
export function admitEveryTick(
  input: EveryTickInput,
  deriveId: RecurringIdPort = deriveRecurringOccurrenceId,
  kernel: WorkKernel = tsWorkKernel,
): EveryTickResult {
  return kernel.every.admitEveryTick(input, deriveId);
}
