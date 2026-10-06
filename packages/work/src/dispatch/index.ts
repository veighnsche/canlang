/**
 * Dispatch: atomic-order guard evaluation and claim issuance.
 *
 * Dispatch checks, in order: commit marker -> supersession -> pending state
 * -> target availability -> guard -> claim (DESIGN section 6). A missing
 * commit marker refuses without sending; a superseded intent refuses
 * before the guard runs; a settled item refuses before guard evaluation;
 * an unavailable target (D3, where deployment availability is injected)
 * refuses explicitly before guard evaluation; a false guard yields
 * `skipped` with its verdict; otherwise a pending item receives a claim
 * carrying an injected claim id and timestamp.
 *
 * Guard evaluation itself is an INJECTED pure function: the predicate is
 * authored Can source compiled by lane 1 (emission), and this kernel runs
 * it at claim time, applying the boolean verdict to frozen inputs plus a
 * current state snapshot.
 *
 * This function computes the decision purely; it performs no store writes.
 * The real dispatcher must persist `pending` -> `claimed` with the claim
 * record in one fenced batch that re-verifies marker, pending state,
 * non-supersession and the guard verdict (see ports.ts).
 */
import type {
  ClaimId,
  DispatchClaim,
  DispatchGuardRef,
  GuardVerdict,
  OutboxId,
  OutboxItemState,
} from '../../../contracts/src/work.js';
import type { ClaimIdPort, ClockPort, SupersessionPort } from '../ports.ts';
import type { AnyOutboxIntent } from '../intent/index.ts';

/* -- T34-F3 additive imports: F1 fanout vocabulary + F2 row shapes. -- */
import type {
  FanoutChildId,
  FanoutChildOutcome,
  FanoutFailedReason,
  FanoutId,
  FanoutProgress,
  FanoutSkippedReason,
  RetryPolicy,
} from '../../../contracts/src/work.js';
import type { StoredRow } from '../../../contracts/src/state.js';
import type { FanoutChildRowData } from '../kernel/tables.ts';
import {
  fanoutChildRowId,
  readFanoutChildRow,
  withRowData,
} from '../kernel/tables.ts';

/**
 * Injected pure guard evaluator: predicate reference plus frozen retained
 * inputs plus a current owner-state snapshot produce a boolean verdict.
 * Must be total, deterministic and side-effect free. Unresolvable
 * predicate references must throw or return false — never a silent
 * true (unknown stays unknown; only an absent guard is unconditional).
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
  /**
   * D3: deployment target availability, injected where the runtime
   * knows it. Absent means unknown (existing behavior: no check).
   * Present means enforced: sends to unavailable targets refuse
   * explicitly instead of claiming or silently skipping.
   */
  availability?: TargetAvailabilityPort;
}

/**
 * D3: deployment-known send-target availability. The key is the
 * intent item's `source` path (capability operation path or
 * queue/event target — the runtime constructs it as the dispatch
 * target). Implementations answer from deployment bindings; the
 * kernel only matches, never resolves providers itself.
 */
export interface TargetAvailabilityPort {
  isTargetAvailable(target: string): boolean;
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
  /**
   * T32b claim-time fence. Optional: attempts without one keep the exact
   * pre-T32b behavior. Transitive (hook/handler-triggered) dispatches
   * carry their OWN fresh checkpoint here — never the triggering read's
   * snapshot — plus a claim-time authority revalidation so no cached
   * snapshot authorizes the spend.
   */
  fence?: DispatchFence;
}

/**
 * T32b claim-time fence for one dispatch attempt. `checkpoint` is the
 * dispatch's own owner checkpoint (transitive effects open a fresh one
 * via the state's `openTransitiveScope`; the revision/owner pair names
 * it). `triggerRevision` names the triggering read's checkpoint when
 * this dispatch is transitive: presenting the trigger's own revision
 * back is inheriting its snapshot and is refused. `revalidateAuthority`
 * re-reads live authority at claim time (after the guard passes, before
 * the claim issues): a revocation landing between trigger and handler
 * denies the transitive effect.
 */
export interface DispatchFence {
  readonly checkpoint: { readonly revision: number; readonly owner: string };
  readonly triggerRevision?: { readonly revision: number };
  readonly revalidateAuthority?: () => boolean;
}

export type DispatchOutcome =
  /** Staged but uncommitted: commit failure causes no send. */
  | { status: 'refused-uncommitted'; outboxId: OutboxId }
  /** Occurrence superseded or cancelled before dispatch. */
  | { status: 'superseded'; outboxId: OutboxId }
  /** Guard evaluated false. */
  | { status: 'skipped'; verdict: GuardVerdict }
  /**
   * Settled item refused before guard evaluation: settled items never
   *   produce guard verdicts, since `skipped` means undispatched work.
   */
  | { status: 'refused-state'; outboxId: OutboxId; state: OutboxItemState }
  /**
   * T32b: transitive dispatch inherited its trigger's checkpoint instead
   * of opening a fresh scope — refused before supersession or guard.
   */
  | { status: 'refused-inherited-scope'; outboxId: OutboxId }
  /**
   * T32b: live authority revalidation failed at claim time (revoked
   * between trigger and handler) — the guard verdict never authorizes
   * the spend on its own.
   */
  | { status: 'refused-revoked'; outboxId: OutboxId }
  /**
   * D3: the send's target is unavailable in this deployment
   * (unbound provider, scoped-out capability). Checked after
   * lifecycle (committed/scoped/live) and before guard evaluation,
   * so unavailable targets never evaluate guards and never claim.
   * `target` echoes the intent item's source path. Terminal and
   * explicit: the runtime surfaces this as a terminal business
   * error (never re-driven like refused-*, never retried —
   * repeating the identical send fails identically until the
   * deployment changes). Transport mapping is runtime-owned.
   */
  | { status: 'unavailable'; outboxId: OutboxId; target: string }
  /** Claim issued for one provider-call attempt. */
  | { status: 'claimed'; claim: DispatchClaim };

/**
 * Attempt one dispatch, evaluating inherited-scope -> supersession ->
 * state -> availability -> guard -> revocation -> claim in order. Later
 * checks never run once an earlier one refuses: superseded intents
 * never evaluate the guard, uncommitted intents touch nothing,
 * unavailable targets never evaluate guards or mint claims, and a
 * revoked authority never mints a claim even when the guard passes (no
 * cached snapshot authorizes a spend — the claim-time revalidation is
 * the authorization).
 */
export function attemptDispatch(deps: DispatchDeps, attempt: DispatchAttempt): DispatchOutcome {
  const item = attempt.intent.item;
  if (attempt.intent.commit === null) {
    return { status: 'refused-uncommitted', outboxId: item.id };
  }
  // T32b: a transitive dispatch presenting its trigger's own checkpoint
  // revision inherited the triggering snapshot instead of opening a fresh
  // scope — structurally refused before supersession or guard.
  const fence = attempt.fence;
  if (
    fence !== undefined &&
    fence.triggerRevision !== undefined &&
    fence.triggerRevision.revision === fence.checkpoint.revision
  ) {
    return { status: 'refused-inherited-scope', outboxId: item.id };
  }
  if (deps.supersessions.isSuperseded(item.id)) {
    return { status: 'superseded', outboxId: item.id };
  }
  if (item.state !== 'pending') {
    return { status: 'refused-state', outboxId: item.id, state: item.state };
  }
  // D3: deployment-static admission before dynamic evaluation — an
  // unavailable target refuses explicitly without consulting guards,
  // authority, or claim ids. Absent availability means unknown (no
  // check); fanout child claims carry no send target (untouched).
  if (deps.availability !== undefined && !deps.availability.isTargetAvailable(item.source)) {
    return { status: 'unavailable', outboxId: item.id, target: item.source };
  }
  const predicate = attempt.guard.predicate;
  if (predicate !== null) {
    const result = deps.evaluateGuard(predicate, attempt.frozenInputs, attempt.stateSnapshot);
    if (result !== true) {
      return { status: 'skipped', verdict: { outboxId: item.id, result: false } };
    }
  }
  // T32b: claim-time authority revalidation — revocation landing between
  // trigger and handler denies the transitive effect. The guard verdict
  // above never authorizes the claim on its own.
  if (fence?.revalidateAuthority !== undefined && fence.revalidateAuthority() !== true) {
    return { status: 'refused-revoked', outboxId: item.id };
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

/* -- T24a claim identity: exactly-once claim per intent. -- */

/**
 * Exactly-once claim rule. One claim generation admits exactly one
 * winning claim id per intent: concurrent claimants serialize on the
 * fenced `pending` -> `claimed` conditional update and losers observe
 * the winner's claim (the fenced claim refusal carries the held
 * claim id). A redelivered worker presenting the WINNING claim id
 * replays its own claim (idempotent); any other presented id is held
 * elsewhere and refused. Claim ids are opaque mints (`ClaimIdPort`);
 * callers never compare them for ordering, only equality here.
 */
export type ClaimIdentityVerdict =
  /** No claim recorded: the intent is claimable (subject to the fence). */
  | 'unclaimed'
  /** The presented id is the recorded winner: idempotent replay. */
  | 'held-by-caller'
  /** A different claim id holds the intent: refuse. */
  | 'held-elsewhere';

export function matchClaimIdentity(
  held: DispatchClaim | null,
  presentedClaimId: ClaimId,
): ClaimIdentityVerdict {
  if (held === null) {
    return 'unclaimed';
  }
  return held.claimId === presentedClaimId ? 'held-by-caller' : 'held-elsewhere';
}

/* -- T34-F3 fanout child claim/record (L4 dispatch slice). -- */

/**
 * Adopted T33-A dispatch slice for durable per-child fanout (both
 * cohort spellings). Pure claim/record/progress/scheduling decisions
 * over the committed F1 vocabulary (`contracts/work.ts` T34-F1
 * section) and F2 durable rows (`kernel/tables.ts` T34-F2 section),
 * plus a TEST-ONLY serialized memory store proving
 * exactly-one-winner under concurrency.
 *
 * Ordering (claim): terminal-replay -> running-held -> stale-check
 * -> inherited-scope -> guard-on-current -> revoked -> claim. Replay
 * and held bypass the fence: they are idempotent reads of recorded
 * state, not admission (T32a completed-replay precedent: saved
 * outcomes replay even though submitted versions are stale). The
 * fence gates admission (pending -> running) only, reusing the T32b
 * seam verbatim: `DispatchFence` type, inherited-before-guard and
 * revoked-after-guard, same equality condition as `attemptDispatch`.
 *
 * Refusal preservation (M5): both T32-wire refusals record terminal
 * `failed` with `FANOUT_T32_REFUSAL_REASON` (`inaccessible-record`:
 * an authority failure, never deletion, never a retryable pending).
 * F1 carries no distinct refused-* reasons, so the closed
 * authority-failure reason is reused and pinned here — no new
 * reason invented. Guard-false records terminal `skipped` with
 * `non-applicable` (current body conditions do not apply, C7).
 * Attempts increment for executed attempts only (completed, failed,
 * transient), never for skips or refusals (T24 skips-never-increment
 * precedent).
 *
 * Retry horizon (M6): `attempts++` on the same row identity;
 * exhaustion (attempt cap OR time horizon) records terminal
 * `failed`/`exhausted` (dead-letter visible in progress counts).
 * The time horizon needs a caller-supplied `firstAttemptAtMs`: F2
 * child rows carry `attempts` but no first-attempt timestamp, so
 * durable anchoring rides the F7 scheduler (StoredRow.created or
 * equivalent), not a new F2 field. Bounds are explicit per call
 * (`RetryPolicy` required, no default, no quota field).
 *
 * Progress (M5/C6): counts only (data-minimized, no child rows);
 * terminal-with-failures means attention, never success.
 * Scheduling (M8/C9): pending-only, id-sorted, bounded cursor pages;
 * chunk size bounds one turn only, never the cohort. Every admitted
 * identity progresses exactly once per sweep (no starvation).
 *
 * Deliberately absent: no membership enumeration (F5), no recovery
 * scanning (F4), no quota/capacity field, no authoring syntax, no
 * skipping/suppression rule. Duplicate delivery replays the
 * recorded outcome and mints nothing.
 */

/** Actor stamp for TEST-ONLY store writes (production F7 supplies the real actor). */
const FANOUT_STORE_ACTOR = 't34-f3-dispatch';

/**
 * F1 mapping for T32-wire refusals at fanout claim. Both
 * `refused-inherited-scope` and `refused-revoked` are authority
 * failures: the record may exist, but current authority does not
 * admit this child. `inaccessible-record` is the closed F1 reason
 * for exactly that (distinct from `missing-record` deletion and
 * `infra-read-failure`). Recorded terminal, never retried.
 */
export const FANOUT_T32_REFUSAL_REASON: FanoutFailedReason = 'inaccessible-record';

/** Stable claim key for one child: the F2 parent+handler+record row id. */
export function fanoutChildIdentityKey(child: FanoutChildId): string {
  return fanoutChildRowId(child.parentOccurrence, child.handler, child.recordId);
}

/**
 * Project the recorded terminal outcome from a child row, or null
 * when the child is still live (pending/running). Carries only the
 * child's own identity — never sibling data.
 */
export function fanoutChildOutcomeFromRow(
  data: FanoutChildRowData,
): FanoutChildOutcome | null {
  if (data.state === 'pending' || data.state === 'running') {
    return null;
  }
  const child: FanoutChildId = {
    parentOccurrence: data.parentOccurrence,
    handler: data.handler,
    recordId: data.recordId,
  };
  if (data.state === 'completed') {
    return {
      child,
      state: 'completed',
      attempts: data.attempts,
      cause: { kind: 'completed' },
    };
  }
  if (data.state === 'skipped') {
    return {
      child,
      state: 'skipped',
      attempts: data.attempts,
      cause: { kind: 'skipped', reason: data.causeReason as FanoutSkippedReason },
    };
  }
  return {
    child,
    state: 'failed',
    attempts: data.attempts,
    cause: { kind: 'failed', reason: data.causeReason as FanoutFailedReason },
  };
}

function assertFanoutRetryPolicy(policy: RetryPolicy): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError('t34-f3: policy.maxAttempts must be an integer >= 1');
  }
  if (!Number.isFinite(policy.horizonMs) || policy.horizonMs <= 0) {
    throw new RangeError('t34-f3: policy.horizonMs must be finite and > 0');
  }
}

function terminalOutcomeOrThrow(row: StoredRow, what: string): FanoutChildOutcome {
  const outcome = fanoutChildOutcomeFromRow(readFanoutChildRow(row));
  if (outcome === null) {
    throw new Error(`t34-f3: unreachable: ${what} produced a live row.`);
  }
  return outcome;
}

/** One claim attempt against a single admitted child. */
export interface FanoutChildClaimInput {
  /** Parent+handler+record identity to claim (handler prevents collisions). */
  child: FanoutChildId;
  /**
   * Caller's observed `StoredRow.version`, or null for an
   * unconditional attempt (no staleness check). A mismatch refuses
   * as stale without admitting: stale reads never win.
   */
  snapshotVersion: number | null;
  /** Body/filter guard; null predicate means unconditional. */
  guard: DispatchGuardRef;
  /** Retained frozen lexical inputs for the guard. */
  frozenInputs: unknown;
  /**
   * CURRENT owner-state snapshot thunk, invoked at claim time
   * (after the inherited-scope check, before guard evaluation).
   * The guard always sees this fresh value, never a carried one.
   */
  readCurrentSnapshot: () => unknown;
  /** T32b claim-time fence (same seam as `attemptDispatch`). */
  fence?: DispatchFence;
}

export type FanoutChildClaimOutcome =
  /** Winner: pending -> running, version bumped, attempts unchanged. */
  | { status: 'claimed'; row: StoredRow; child: FanoutChildId }
  /** Already running: existing claim returned, no mutation, no duplicate. */
  | { status: 'held'; row: StoredRow; child: FanoutChildId }
  /** Already terminal: recorded outcome replayed, minting nothing. */
  | { status: 'replayed'; outcome: FanoutChildOutcome; row: StoredRow }
  /** Stale snapshot: current row returned, nothing admitted, guard not run. */
  | { status: 'refused-stale'; row: StoredRow; child: FanoutChildId }
  /** T32 inherited scope: recorded failed, guard never ran. */
  | { status: 'refused-inherited-scope'; outcome: FanoutChildOutcome; row: StoredRow }
  /** T32 revoked authority: recorded failed, guard already ran. */
  | { status: 'refused-revoked'; outcome: FanoutChildOutcome; row: StoredRow }
  /** Guard-false on the current snapshot: recorded skipped/non-applicable. */
  | { status: 'skipped'; outcome: FanoutChildOutcome; row: StoredRow };

/**
 * One executed attempt result entering record. `exhausted` is never
 * supplied: the horizon derives it from attempts/time. Transient
 * carries no provider details (closed, detail-free).
 */
export type FanoutChildAttemptResult =
  | { kind: 'completed' }
  | { kind: 'skipped'; reason: FanoutSkippedReason }
  | { kind: 'failed'; reason: Exclude<FanoutFailedReason, 'exhausted'> }
  | { kind: 'transient' };

/** One record attempt against a running child. */
export interface FanoutChildRecordInput {
  child: FanoutChildId;
  result: FanoutChildAttemptResult;
  /** Claim/record instant as UTC epoch ms (also anchors the horizon check). */
  nowMs: number;
  /** UTC epoch ms of the first attempt, anchoring the retry horizon. */
  firstAttemptAtMs: number;
  /** Explicit per-call bounds (no default, no quota field). */
  policy: RetryPolicy;
}

export type FanoutChildRecordOutcome =
  /** Terminal recorded (completed/skipped/failed incl. exhausted dead-letter). */
  | { status: 'recorded'; outcome: FanoutChildOutcome; row: StoredRow }
  /** Transient within budget: back to pending, attempts++ on the same row. */
  | { status: 'retried'; row: StoredRow }
  /** Already terminal: recorded outcome replayed, minting nothing. */
  | { status: 'replayed'; outcome: FanoutChildOutcome; row: StoredRow };

const FANOUT_TERMINAL_FAILED_REASONS: ReadonlySet<string> = new Set([
  'business-rejection',
  'terminal',
  'missing-record',
  'inaccessible-record',
  'infra-read-failure',
]);

/**
 * TEST-ONLY serialized in-memory fanout child store. Single-owner,
 * non-durable, non-atomic across processes: concurrent claimants
 * serialize because each method runs its read-decide-write
 * synchronously (no await between load and store), so exactly one
 * wins and losers observe the winner. Production F7 replaces this
 * with fenced conditional updates on the durable substrate; the
 * pure shapes (F1 outcomes, F2 rows, progress, turns) stay identical.
 */
export class TestOnlyMemoryFanoutChildStore {
  private readonly rows = new Map<string, StoredRow>();
  private readonly clock: ClockPort;

  constructor(clock: ClockPort) {
    this.clock = clock;
  }

  /** Admit one child row for setup (duplicate insert throws, like a PK conflict). */
  insert(row: StoredRow): void {
    const data = readFanoutChildRow(row);
    const key = fanoutChildRowId(data.parentOccurrence, data.handler, data.recordId);
    if (key !== (row.id as string)) {
      throw new Error('t34-f3: insert row id must equal its parent+handler+record derivation.');
    }
    if (this.rows.has(key)) {
      throw new Error(`t34-f3: duplicate fanout child row ${JSON.stringify(key)}.`);
    }
    this.rows.set(key, row);
  }

  get(child: FanoutChildId): StoredRow | null {
    return this.rows.get(fanoutChildRowId(child.parentOccurrence, child.handler, child.recordId)) ?? null;
  }

  /** All admitted rows in stable id order. */
  listAll(): StoredRow[] {
    return [...this.rows.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
  }

  /**
   * Claim one child: terminal replays, running holds, stale refuses,
   * then inherited-scope -> guard-on-current -> revoked -> claim.
   * Later checks never run once an earlier one decides: replayed/
   * held/stale touch neither fence nor guard; inherited-scope never
   * runs the guard; revoked mints no claim even when the guard passes.
   */
  claim(
    evaluateGuard: GuardEvaluator,
    input: FanoutChildClaimInput,
  ): FanoutChildClaimOutcome {
    const key = fanoutChildRowId(
      input.child.parentOccurrence,
      input.child.handler,
      input.child.recordId,
    );
    const current = this.rows.get(key) ?? null;
    if (current === null) {
      throw new Error(
        `t34-f3: no fanout child row for ${JSON.stringify(key)} (producer write missing).`,
      );
    }
    const data = readFanoutChildRow(current);
    const terminal = fanoutChildOutcomeFromRow(data);
    if (terminal !== null) {
      return { status: 'replayed', outcome: terminal, row: current };
    }
    if (data.state === 'running') {
      return { status: 'held', row: current, child: input.child };
    }
    if (input.snapshotVersion !== null && input.snapshotVersion !== current.version) {
      return { status: 'refused-stale', row: current, child: input.child };
    }
    const fence = input.fence;
    if (
      fence !== undefined &&
      fence.triggerRevision !== undefined &&
      fence.triggerRevision.revision === fence.checkpoint.revision
    ) {
      const failed = withRowData(
        current,
        {
          ...data,
          state: 'failed',
          causeKind: 'failed',
          causeReason: FANOUT_T32_REFUSAL_REASON,
        },
        { nowMs: this.clock.nowMs(), actor: FANOUT_STORE_ACTOR },
        'work.fanout_child',
      );
      this.rows.set(key, failed);
      return {
        status: 'refused-inherited-scope',
        outcome: terminalOutcomeOrThrow(failed, 'refused-inherited-scope'),
        row: failed,
      };
    }
    const predicate = input.guard.predicate;
    if (predicate !== null) {
      const currentSnapshot = input.readCurrentSnapshot();
      const result = evaluateGuard(predicate, input.frozenInputs, currentSnapshot);
      if (result !== true) {
        const skipped = withRowData(
          current,
          {
            ...data,
            state: 'skipped',
            causeKind: 'skipped',
            causeReason: 'non-applicable',
          },
          { nowMs: this.clock.nowMs(), actor: FANOUT_STORE_ACTOR },
          'work.fanout_child',
        );
        this.rows.set(key, skipped);
        return {
          status: 'skipped',
          outcome: terminalOutcomeOrThrow(skipped, 'guard-false skip'),
          row: skipped,
        };
      }
    }
    if (fence?.revalidateAuthority !== undefined && fence.revalidateAuthority() !== true) {
      const failed = withRowData(
        current,
        {
          ...data,
          state: 'failed',
          causeKind: 'failed',
          causeReason: FANOUT_T32_REFUSAL_REASON,
        },
        { nowMs: this.clock.nowMs(), actor: FANOUT_STORE_ACTOR },
        'work.fanout_child',
      );
      this.rows.set(key, failed);
      return {
        status: 'refused-revoked',
        outcome: terminalOutcomeOrThrow(failed, 'refused-revoked'),
        row: failed,
      };
    }
    const running = withRowData(
      current,
      { ...data, state: 'running' },
      { nowMs: this.clock.nowMs(), actor: FANOUT_STORE_ACTOR },
      'work.fanout_child',
    );
    this.rows.set(key, running);
    return { status: 'claimed', row: running, child: input.child };
  }

  /**
   * Record one executed attempt: terminal replays, live-but-idle
   * throws (record needs a running claim), then completed/skipped/
   * failed record terminally while transient retries within budget
   * (same row, attempts++) or exhausts to failed/exhausted
   * (dead-letter visible, never retried).
   */
  record(input: FanoutChildRecordInput): FanoutChildRecordOutcome {
    assertFanoutRetryPolicy(input.policy);
    if (!Number.isFinite(input.nowMs) || input.nowMs < 0) {
      throw new RangeError('t34-f3: nowMs must be finite and >= 0');
    }
    if (!Number.isFinite(input.firstAttemptAtMs) || input.firstAttemptAtMs < 0) {
      throw new RangeError('t34-f3: firstAttemptAtMs must be finite and >= 0');
    }
    const key = fanoutChildRowId(
      input.child.parentOccurrence,
      input.child.handler,
      input.child.recordId,
    );
    const current = this.rows.get(key) ?? null;
    if (current === null) {
      throw new Error(
        `t34-f3: no fanout child row for ${JSON.stringify(key)} (producer write missing).`,
      );
    }
    const data = readFanoutChildRow(current);
    const terminal = fanoutChildOutcomeFromRow(data);
    if (terminal !== null) {
      return { status: 'replayed', outcome: terminal, row: current };
    }
    if (data.state !== 'running') {
      throw new Error(
        `t34-f3: record applies to running children only; ${JSON.stringify(key)} is ${data.state}.`,
      );
    }
    const meta = { nowMs: input.nowMs, actor: FANOUT_STORE_ACTOR };
    const result = input.result;
    if (result.kind === 'completed') {
      const next = withRowData(
        current,
        {
          ...data,
          state: 'completed',
          attempts: data.attempts + 1,
          causeKind: 'completed',
          causeReason: null,
        },
        meta,
        'work.fanout_child',
      );
      this.rows.set(key, next);
      return {
        status: 'recorded',
        outcome: terminalOutcomeOrThrow(next, 'completed'),
        row: next,
      };
    }
    if (result.kind === 'skipped') {
      if (result.reason !== 'deleted' && result.reason !== 'non-applicable') {
        throw new Error(
          `t34-f3: skipped reason must be deleted or non-applicable, got ${JSON.stringify(result.reason)}.`,
        );
      }
      const next = withRowData(
        current,
        {
          ...data,
          state: 'skipped',
          causeKind: 'skipped',
          causeReason: result.reason,
        },
        meta,
        'work.fanout_child',
      );
      this.rows.set(key, next);
      return {
        status: 'recorded',
        outcome: terminalOutcomeOrThrow(next, 'skipped'),
        row: next,
      };
    }
    if (result.kind === 'failed') {
      if ((result.reason as string) === 'exhausted') {
        throw new Error('t34-f3: exhausted is derived by the horizon, never supplied.');
      }
      if (!FANOUT_TERMINAL_FAILED_REASONS.has(result.reason)) {
        throw new Error(
          `t34-f3: failed reason is unknown: ${JSON.stringify(result.reason)}.`,
        );
      }
      const next = withRowData(
        current,
        {
          ...data,
          state: 'failed',
          attempts: data.attempts + 1,
          causeKind: 'failed',
          causeReason: result.reason,
        },
        meta,
        'work.fanout_child',
      );
      this.rows.set(key, next);
      return {
        status: 'recorded',
        outcome: terminalOutcomeOrThrow(next, 'failed'),
        row: next,
      };
    }
    const newAttempts = data.attempts + 1;
    const attemptsExhausted = newAttempts >= input.policy.maxAttempts;
    const horizonExceeded = input.nowMs - input.firstAttemptAtMs >= input.policy.horizonMs;
    if (attemptsExhausted || horizonExceeded) {
      const next = withRowData(
        current,
        {
          ...data,
          state: 'failed',
          attempts: newAttempts,
          causeKind: 'failed',
          causeReason: 'exhausted',
        },
        meta,
        'work.fanout_child',
      );
      this.rows.set(key, next);
      return {
        status: 'recorded',
        outcome: terminalOutcomeOrThrow(next, 'exhausted'),
        row: next,
      };
    }
    const next = withRowData(
      current,
      {
        ...data,
        state: 'pending',
        attempts: newAttempts,
        causeKind: null,
        causeReason: null,
      },
      meta,
      'work.fanout_child',
    );
    this.rows.set(key, next);
    return { status: 'retried', row: next };
  }
}

/**
 * Aggregate one fanout's progress from its admitted child rows.
 * Counts only (data-minimized operator view: no child rows leak).
 * Fully terminal with failures means attention, never success.
 */
export function summarizeFanoutChildren(
  fanoutId: FanoutId,
  rows: ReadonlyArray<StoredRow>,
): FanoutProgress {
  if (typeof fanoutId !== 'string' || fanoutId === '') {
    throw new Error('t34-f3: fanoutId must be a non-empty string.');
  }
  let pending = 0;
  let running = 0;
  let completed = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows) {
    const data = readFanoutChildRow(row);
    if (data.fanoutId !== fanoutId) {
      throw new Error('t34-f3: progress rows must share one fanoutId (no cross-fanout leak).');
    }
    switch (data.state) {
      case 'pending':
        pending += 1;
        break;
      case 'running':
        running += 1;
        break;
      case 'completed':
        completed += 1;
        break;
      case 'skipped':
        skipped += 1;
        break;
      case 'failed':
        failed += 1;
        break;
    }
  }
  const terminal = pending === 0 && running === 0;
  return {
    fanoutId,
    pending,
    running,
    completed,
    skipped,
    failed,
    terminal,
    attention: terminal && failed > 0,
  };
}

/** One bounded scheduling turn over admitted children. */
export interface FanoutTurnInput {
  /** Admitted child rows (any state; only pending schedules). */
  rows: ReadonlyArray<StoredRow>;
  /** Last-seen child row id (exclusive lower bound); null starts at the head. */
  cursor: string | null;
  /**
   * Page transport bound (>= 1). Bounds one turn only (chunk size
   * is not cohort size); the admitted set never changes with it.
   */
  limit: number;
}

/** One bounded turn: the next pending batch plus the honest resume signal. */
export interface FanoutTurn {
  /** Next pending rows in id-sorted order (at most the limit). */
  batch: StoredRow[];
  /** Resume cursor (last id) when done:false; null when done:true. */
  cursor: string | null;
  /** True only when no further pending row remains. */
  done: boolean;
}

/**
 * Plan one bounded fair turn: the next pending children in
 * id-sorted order after the cursor. Every admitted identity
 * progresses exactly once per sweep in a stable order, so no
 * stalled child starves the rest: a retry returns its row to
 * pending under the same id, and the sweep continues past it.
 */
export function planFanoutTurn(input: FanoutTurnInput): FanoutTurn {
  if (!Number.isInteger(input.limit) || input.limit < 1) {
    throw new RangeError('t34-f3: turn limit must be an integer >= 1.');
  }
  if (input.cursor !== null && input.cursor === '') {
    throw new Error('t34-f3: turn cursor must be non-empty or null.');
  }
  const pending: StoredRow[] = [];
  for (const row of input.rows) {
    if (readFanoutChildRow(row).state === 'pending') {
      pending.push(row);
    }
  }
  pending.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const after: StoredRow[] = [];
  for (const row of pending) {
    const id = row.id as string;
    if (input.cursor === null || id > input.cursor) {
      after.push(row);
    }
  }
  const batch = after.slice(0, input.limit);
  if (after.length - batch.length > 0) {
    const last = batch[batch.length - 1];
    if (last === undefined) {
      throw new Error('t34-f3: unreachable: pending remainder with an empty batch.');
    }
    return { batch, cursor: last.id as string, done: false };
  }
  return { batch, cursor: null, done: true };
}
