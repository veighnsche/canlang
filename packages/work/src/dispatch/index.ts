/**
 * Dispatch: atomic-order guard evaluation and claim issuance.
 *
 * Dispatch checks, in order: commit marker -> supersession -> guard -> claim
 * (DESIGN section 6). A missing commit marker refuses without sending; a
 * superseded intent refuses before the guard runs; a false guard yields
 * `skipped` with its verdict; otherwise a pending item receives a claim
 * carrying an injected claim id and timestamp.
 *
 * Guard evaluation itself is an INJECTED pure function: the predicate is
 * authored Can source evaluated by lanes 1/3, and this kernel only applies
 * the boolean verdict to frozen inputs plus a current state snapshot.
 *
 * This function computes the decision purely; it performs no store writes.
 * The real dispatcher must persist `pending` -> `claimed` with the claim
 * record in one fenced batch that re-verifies marker, pending state,
 * non-supersession and the guard verdict (see ports.ts).
 */
import type {
  DispatchClaim,
  DispatchGuardRef,
  GuardVerdict,
  OutboxId,
  OutboxItemState,
} from '../../../contracts/src/work.js';
import type { ClaimIdPort, ClockPort, SupersessionPort } from '../ports.ts';
import type { AnyOutboxIntent } from '../intent/index.ts';

/**
 * Injected pure guard evaluator: predicate reference plus frozen retained
 * inputs plus a current owner-state snapshot produce a boolean verdict.
 * Must be total, deterministic and side-effect free.
 */
export type GuardEvaluator = (
  predicate: string,
  frozenInputs: unknown,
  stateSnapshot: unknown,
) => boolean;

export interface DispatchDeps {
  clock: ClockPort;
  claimIds: ClaimIdPort;
  supersessions: SupersessionPort;
  evaluateGuard: GuardEvaluator;
}

export interface DispatchAttempt {
  /** Intent to dispatch; must carry a commit marker to send. */
  intent: AnyOutboxIntent;
  /** Send's optional `when` guard; null predicate means unconditional. */
  guard: DispatchGuardRef;
  /** Retained frozen lexical inputs for the guard. */
  frozenInputs: unknown;
  /** Current owner state snapshot for the guard. */
  stateSnapshot: unknown;
}

export type DispatchOutcome =
  /** Staged but uncommitted: commit failure causes no send. */
  | { status: 'refused-uncommitted'; outboxId: OutboxId }
  /** Occurrence superseded or cancelled before dispatch. */
  | { status: 'superseded'; outboxId: OutboxId }
  /** Guard evaluated false. */
  | { status: 'skipped'; verdict: GuardVerdict }
  /** Guard passed (or unconditional) but the item is no longer pending. */
  | { status: 'refused-state'; outboxId: OutboxId; state: OutboxItemState }
  /** Claim issued for one provider-call attempt. */
  | { status: 'claimed'; claim: DispatchClaim };

/**
 * Attempt one dispatch, evaluating supersession -> guard -> claim in order.
 * Later checks never run once an earlier one refuses: superseded intents
 * never evaluate the guard, and uncommitted intents touch nothing.
 */
export function attemptDispatch(deps: DispatchDeps, attempt: DispatchAttempt): DispatchOutcome {
  const item = attempt.intent.item;
  if (attempt.intent.commit === null) {
    return { status: 'refused-uncommitted', outboxId: item.id };
  }
  if (deps.supersessions.isSuperseded(item.id)) {
    return { status: 'superseded', outboxId: item.id };
  }
  const predicate = attempt.guard.predicate;
  if (predicate !== null) {
    const result = deps.evaluateGuard(predicate, attempt.frozenInputs, attempt.stateSnapshot);
    if (result !== true) {
      return { status: 'skipped', verdict: { outboxId: item.id, result: false } };
    }
  }
  if (item.state !== 'pending') {
    return { status: 'refused-state', outboxId: item.id, state: item.state };
  }
  return {
    status: 'claimed',
    claim: {
      outboxId: item.id,
      claimId: deps.claimIds.nextClaimId(),
      claimedAt: deps.clock.nowMs(),
    },
  };
}
