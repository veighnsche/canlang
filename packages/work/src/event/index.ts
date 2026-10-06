/**
 * Occurrence admission: idempotent execution keyed by runtime-minted
 * occurrence id.
 *
 * Each handler receives an independent stable occurrence identity, and
 * duplicate deliveries replay its recorded receipt instead of re-executing
 * (DESIGN section 6). Completed and terminal-failed outcomes are recorded;
 * a thrown error is a transient runtime failure that propagates WITHOUT
 * recording, so the same occurrence can be retried later.
 *
 * Committed-change payloads carry immutable identities only (record id,
 * owner, version, occurrence id) — never an implicit record snapshot. The
 * current authority state is loaded from the owner on first delivery via an
 * injected loader; duplicates replay without loading or handling.
 */
import type { CommittedChangeEvent, OccurrenceId } from '@canlang/contracts';
import type { ClockPort, OccurrenceReceipt, OccurrenceStorePort } from '../ports.js';

export interface EventDeps {
  occurrences: OccurrenceStorePort;
  clock: ClockPort;
}

/**
 * Terminal handler outcome. Returning (rather than throwing) records the
 * outcome: `completed` for success, `failed` for a terminal business failure
 * such as a false authored `require`. Closed error only — no details.
 */
export type OccurrenceOutcome =
  | { status: 'completed'; result: unknown }
  | { status: 'failed'; code: string; message: string };

export interface OccurrenceAdmission {
  occurrenceId: OccurrenceId;
  /** True when a previously recorded receipt was replayed. */
  duplicate: boolean;
  /** Freshly recorded receipt, or the replayed one for duplicates. */
  receipt: OccurrenceReceipt;
}

/**
 * Admit one occurrence: execute exactly once per occurrence id. Duplicate
 * deliveries replay the recorded receipt and never invoke `execute` again.
 * A throw from `execute` propagates with nothing recorded (transient: the
 * same occurrence retries later).
 */
export function admitOccurrence(
  deps: EventDeps,
  occurrenceId: OccurrenceId,
  execute: () => OccurrenceOutcome,
): OccurrenceAdmission {
  if (typeof occurrenceId !== 'string' || occurrenceId.length === 0) {
    throw new RangeError('admitOccurrence: occurrenceId must be a non-empty string');
  }
  const replayed = deps.occurrences.getReceipt(occurrenceId);
  if (replayed !== null) {
    return { occurrenceId, duplicate: true, receipt: replayed };
  }
  const outcome = execute();
  const receipt: OccurrenceReceipt = {
    occurrenceId,
    status: outcome.status,
    result: outcome.status === 'completed' ? outcome.result : null,
    code: outcome.status === 'failed' ? outcome.code : null,
    message: outcome.status === 'failed' ? outcome.message : null,
    recordedAtMs: deps.clock.nowMs(),
  };
  deps.occurrences.putReceipt(receipt);
  return { occurrenceId, duplicate: false, receipt };
}

export interface CommittedChangeHandling<TState> {
  event: CommittedChangeEvent;
  /** Current authority state loaded from the owner; null when absent. */
  current: TState | null;
}

function assertCommittedChangeEvent(event: CommittedChangeEvent): void {
  if (typeof event.recordId !== 'string' || event.recordId.length === 0) {
    throw new RangeError('admitCommittedChange: event.recordId must be a non-empty string');
  }
  if (typeof event.owner !== 'string' || event.owner.length === 0) {
    throw new RangeError('admitCommittedChange: event.owner must be a non-empty string');
  }
  if (!Number.isInteger(event.version) || event.version < 0) {
    throw new RangeError('admitCommittedChange: event.version must be a non-negative integer');
  }
  if (typeof event.occurrenceId !== 'string' || event.occurrenceId.length === 0) {
    throw new RangeError('admitCommittedChange: event.occurrenceId must be a non-empty string');
  }
}

/**
 * Admit one committed-change delivery. Admission is keyed by
 * `event.occurrenceId`; on first delivery the current authority state is
 * loaded via `loadCurrent` and passed with the immutable event identities to
 * `handle`. Duplicates replay the receipt without loading or handling.
 */
export function admitCommittedChange<TState>(
  deps: EventDeps,
  event: CommittedChangeEvent,
  loadCurrent: (event: CommittedChangeEvent) => TState | null,
  handle: (handling: CommittedChangeHandling<TState>) => OccurrenceOutcome,
): OccurrenceAdmission {
  assertCommittedChangeEvent(event);
  return admitOccurrence(deps, event.occurrenceId, () =>
    handle({ event, current: loadCurrent(event) }),
  );
}
