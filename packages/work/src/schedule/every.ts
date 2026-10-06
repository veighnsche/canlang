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

/** Typed rejection for non-team/app recurring scopes (notably root). */
export class RootRecurrenceNotSupportedError extends Error {
  readonly code = 'ROOT_RECURRING_UNSUPPORTED' as const;
  readonly scope: string;

  constructor(scope: string) {
    super(
      `work: recurring every() fanout covers team/app scopes only; rejected scope ` +
        `'${scope}' (root recurrence uses explicit record-bound schedule)`,
    );
    this.name = 'RootRecurrenceNotSupportedError';
    this.scope = scope;
  }
}

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

/** Map key joining one fanout scope to its last admitted slot. */
export function everyScopeKey(scope: RecurringScope, owner: string): string {
  return `${scope}:${owner}`;
}

export interface EverySlot {
  slot: number;
  slotStartMs: number;
}

/** UTC-epoch aligned slot containing `nowMs`. Pure. */
export function computeEverySlot(nowMs: number, periodMs: number): EverySlot {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new RangeError('computeEverySlot: nowMs must be finite UTC epoch ms >= 0');
  }
  if (!Number.isInteger(periodMs) || periodMs <= 0 || periodMs % 1000 !== 0) {
    throw new RangeError(
      'computeEverySlot: periodMs must be a positive integer multiple of 1000',
    );
  }
  const slotStartMs = Math.floor(nowMs / periodMs) * periodMs;
  return { slot: slotStartMs / 1000, slotStartMs };
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

function assertScope(input: EveryScopeInput): RecurringScope {
  if (input.scope !== 'team' && input.scope !== 'app') {
    throw new RootRecurrenceNotSupportedError(input.scope);
  }
  if (typeof input.owner !== 'string' || input.owner.length === 0) {
    throw new RangeError('admitEveryTick: scope owner must be a non-empty string');
  }
  return input.scope;
}

/**
 * Admit one `every` tick. Returns the current slot and the coalesced
 * occurrence set: at most one occurrence per eligible pre-existing scope at
 * the current slot. New scopes admit nothing until the next slot; removed
 * scopes and already-admitted slots admit nothing.
 */
export function admitEveryTick(input: EveryTickInput): EveryTickResult {
  if (typeof input.app !== 'string' || input.app.length === 0) {
    throw new RangeError('admitEveryTick: app must be a non-empty string');
  }
  if (typeof input.handler !== 'string' || input.handler.length === 0) {
    throw new RangeError('admitEveryTick: handler must be a non-empty string');
  }
  const { slot, slotStartMs } = computeEverySlot(input.nowMs, input.periodMs);
  const seen = new Set<string>();
  const admitted: RecurringOccurrence[] = [];
  for (const scopeInput of input.scopes) {
    const scope = assertScope(scopeInput);
    const key = everyScopeKey(scope, scopeInput.owner);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const previous = input.previousSlots[key];
    if (previous === undefined) {
      // New scope: begins at the next slot, nothing admitted now.
      continue;
    }
    if (!Number.isInteger(previous) || previous < 0) {
      throw new RangeError(`admitEveryTick: previous slot for ${key} must be a non-negative integer`);
    }
    if (previous >= slot) {
      // Already admitted (duplicate tick or clock standing still).
      continue;
    }
    // Missed slots coalesce: one occurrence at the current slot.
    admitted.push({
      occurrenceId: deriveRecurringOccurrenceId(
        input.app,
        input.handler,
        scope,
        scopeInput.owner,
        slot,
      ),
      app: input.app,
      handler: input.handler,
      scope,
      owner: scopeInput.owner,
      slot,
    });
  }
  admitted.sort((a, b) =>
    a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0,
  );
  return { slot, slotStartMs, admitted };
}
