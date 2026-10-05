/**
 * Staged delivery intents: stable outbox identity, frozen requests and the
 * explicit commit gate.
 *
 * An intent is *staged* while its originating mutation evaluates and becomes
 * *committed* only when the lane-3 owner fence persists it with a commit
 * marker in one batch (DESIGN section 7). Staging alone never sends:
 * dispatch refuses any intent whose `commit` is null. This module models that
 * gate; it does not implement the fence.
 */
import { createHash } from 'node:crypto';
import type {
  OccurrenceId,
  OutboxId,
  OutboxItem,
} from '../../../contracts/src/work.js';
import type { GuardEvaluator } from '../dispatch/index.ts';

/**
 * Stable outbox identity derived from the originating operation id, the
 * declaring source and the deterministic occurrence index (DESIGN section 7).
 * Pure and total over valid inputs; identical inputs always derive the
 * identical id so replays collapse onto one item.
 */
export function deriveOutboxId(
  operationId: string,
  source: string,
  occurrenceIndex: number,
): OutboxId {
  if (typeof operationId !== 'string' || operationId.length === 0) {
    throw new RangeError('deriveOutboxId: operationId must be a non-empty string');
  }
  if (typeof source !== 'string' || source.length === 0) {
    throw new RangeError('deriveOutboxId: source must be a non-empty string');
  }
  if (!Number.isInteger(occurrenceIndex) || occurrenceIndex < 0) {
    throw new RangeError('deriveOutboxId: occurrenceIndex must be a non-negative integer');
  }
  const digest = createHash('sha256')
    .update(
      `can-work/outbox-id/v1\0${operationId}\0${source}\0${occurrenceIndex}`,
      'utf8',
    )
    .digest('hex');
  return `obx_${digest}`;
}

/**
 * Build the frozen provider request captured at commit: versions and inputs
 * are cloned (so later caller mutation cannot leak in) and deep-frozen (so
 * later dispatch-time reads cannot mutate them either). Cycle-safe.
 *
 * Only plain JSON records are accepted: the staged request is the lane-3
 * `OutboxIntent.arguments` shape, so arrays, primitives, null and
 * uncloneable inputs (functions, symbols) throw instead of staging a row
 * the fence cannot carry.
 */
export function freezeRequest(
  request: unknown,
): Readonly<Record<string, unknown>> {
  const clone: unknown = structuredClone(request);
  if (typeof clone !== 'object' || clone === null || Array.isArray(clone)) {
    throw new TypeError('freezeRequest: request must be a plain JSON record');
  }
  const record = clone as Record<string, unknown>;
  deepFreezeInPlace(record, new Set());
  return record;
}

function deepFreezeInPlace(value: unknown, seen: Set<object>): void {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return;
  }
  const target = value as object;
  if (seen.has(target)) {
    return;
  }
  seen.add(target);
  for (const key of Reflect.ownKeys(target)) {
    deepFreezeInPlace((target as Record<PropertyKey, unknown>)[key], seen);
  }
  Object.freeze(target);
}

/**
 * Marker the owner fence produced when it committed the intent: the fence
 * revision and the commit instant (UTC epoch ms). Opaque to this package;
 * lane 3 mints it.
 */
export interface OutboxCommitMarker {
  revision: number;
  committedAtMs: number;
}

/** An intent staged during evaluation; not yet dispatchable. */
export interface StagedOutboxIntent {
  item: OutboxItem;
  commit: null;
}

/** An intent committed with its originating state; dispatchable. */
export interface CommittedOutboxIntent {
  item: OutboxItem;
  commit: OutboxCommitMarker;
}

export type AnyOutboxIntent = StagedOutboxIntent | CommittedOutboxIntent;

export interface StageOutboxIntentInput {
  operationId: string;
  source: string;
  occurrenceIndex: number;
  /** Provider inputs; must be a plain JSON record (non-records rejected). */
  request: unknown;
  /**
   * Originating occurrence stamped by the runtime when staging during an
   * occurrence execution; null for direct business-operation sends.
   */
  originOccurrence: OccurrenceId | null;
}

/** Stage one intent during evaluation. The result is never dispatchable. */
export function stageOutboxIntent(input: StageOutboxIntentInput): StagedOutboxIntent {
  const id = deriveOutboxId(input.operationId, input.source, input.occurrenceIndex);
  const item: OutboxItem = {
    id,
    operationId: input.operationId,
    source: input.source,
    occurrenceIndex: input.occurrenceIndex,
    request: freezeRequest(input.request),
    originOccurrence: input.originOccurrence,
    attempts: 0,
    state: 'pending',
  };
  return { item, commit: null };
}

/**
 * Attach the fence-produced commit marker to a staged intent. A pure modeling
 * helper for tests and kernel logic — NOT a commit implementation. The real
 * commit is the lane-3 fenced batch, which persists marker and intent
 * atomically; nothing here opens a transaction.
 */
export function commitOutboxIntent(
  staged: StagedOutboxIntent,
  marker: OutboxCommitMarker,
): CommittedOutboxIntent {
  if (!Number.isInteger(marker.revision) || marker.revision < 1) {
    throw new RangeError('commitOutboxIntent: marker.revision must be an integer >= 1');
  }
  if (!Number.isFinite(marker.committedAtMs) || marker.committedAtMs < 0) {
    throw new RangeError('commitOutboxIntent: marker.committedAtMs must be finite and >= 0');
  }
  return { item: staged.item, commit: { ...marker } };
}

/** True only for intents carrying a commit marker. */
export function isCommitted(intent: AnyOutboxIntent): intent is CommittedOutboxIntent {
  return intent.commit !== null;
}

/* -- T24a staging join: origins, stage-time guards, recorded skips. -- */

/**
 * Which operation/effect produced one staged intent. The four fields are
 * exactly the stable identity inputs (`deriveOutboxId`) plus the stamped
 * origin occurrence, restated as one record so producers, skip records
 * and recovery evidence name the producer identically.
 */
export interface IntentOrigin {
  readonly operationId: string;
  readonly source: string;
  readonly occurrenceIndex: number;
  readonly originOccurrence: OccurrenceId | null;
}

/** Read the producing origin back off any staged or committed intent. */
export function originOfIntent(intent: AnyOutboxIntent): IntentOrigin {
  return {
    operationId: intent.item.operationId,
    source: intent.item.source,
    occurrenceIndex: intent.item.occurrenceIndex,
    originOccurrence: intent.item.originOccurrence,
  };
}

/**
 * T33-carried fanout lineage. The fanout POLICY is undecided
 * (evidence/fanout-decision.md adopts nothing); these fields are opaque
 * carriers only — cohort identity, parent occurrence, per-cohort child
 * index and the checkpoint the child belongs to, if any. Staging
 * validates their shape and echoes them through plans, command results
 * and skip records, but applies NO fanout rule: two effects sharing a
 * cohort stage, skip and dispatch as independent intents.
 */
export interface FanoutLineage {
  readonly cohortId: string;
  readonly parentOccurrence: OccurrenceId;
  readonly childIndex: number;
  readonly checkpointId: string | null;
}

/**
 * One generated effect entering the staging join: the provider inputs
 * plus the origin, the optional `when` guard reference with its frozen
 * lexical inputs, and optional T33-carried fanout lineage. The guard
 * predicate is evaluated AT STAGE TIME against `stateSnapshot` (the
 * producer's stage-time owner snapshot); the claim-time re-check stays
 * the dispatch fence and is unaffected.
 */
export interface GeneratedEffect {
  readonly operationId: string;
  readonly source: string;
  readonly occurrenceIndex: number;
  /** Provider inputs; must be a plain JSON record (non-records rejected). */
  readonly request: unknown;
  readonly originOccurrence: OccurrenceId | null;
  /** Null predicate means unconditional: the effect always stages. */
  readonly guard: string | null;
  readonly frozenInputs?: unknown;
  readonly fanout?: FanoutLineage | null;
}

/**
 * Recorded skip: a guard-false effect that staged NOTHING dispatchable.
 * Skips are first-class plan outputs — a guard-false effect appears here,
 * never silently vanishes — and the fenced stage path persists a
 * guard-pinned dispatch row for each one so the skip survives the batch.
 */
export interface SkipRecord {
  readonly outboxId: OutboxId;
  readonly origin: IntentOrigin;
  /** Predicate that evaluated false at stage time. */
  readonly guard: string;
  readonly verdict: false;
  readonly reason: 'guard-false';
  readonly fanout: FanoutLineage | null;
}

/**
 * Stage-time plan for one batch of generated effects. Every input effect
 * lands in exactly one list: `staged` (dispatchable once its batch
 * commits) or `skipped` (guard-false, recorded). The caller commits the
 * staged intents atomically with the triggering domain/history/replay
 * batch — one fence revision — and a trigger rollback voids them.
 */
export interface DispatchStagePlan {
  readonly staged: StagedOutboxIntent[];
  readonly skipped: SkipRecord[];
}

export interface PlanDispatchStagingDeps {
  evaluateGuard: GuardEvaluator;
}

export interface PlanDispatchStagingInput {
  readonly effects: ReadonlyArray<GeneratedEffect>;
  /** Producer's stage-time owner snapshot for guard evaluation. */
  readonly stateSnapshot: unknown;
}

function checkFanoutLineage(fanout: FanoutLineage, effect: string): FanoutLineage {
  if (typeof fanout.cohortId !== 'string' || fanout.cohortId === '') {
    throw new RangeError(`${effect}: fanout.cohortId must be a non-empty string`);
  }
  if (typeof fanout.parentOccurrence !== 'string' || fanout.parentOccurrence === '') {
    throw new RangeError(`${effect}: fanout.parentOccurrence must be a non-empty string`);
  }
  if (!Number.isInteger(fanout.childIndex) || fanout.childIndex < 0) {
    throw new RangeError(`${effect}: fanout.childIndex must be a non-negative integer`);
  }
  if (
    fanout.checkpointId !== null &&
    (typeof fanout.checkpointId !== 'string' || fanout.checkpointId === '')
  ) {
    throw new RangeError(`${effect}: fanout.checkpointId must be a non-empty string or null`);
  }
  return {
    cohortId: fanout.cohortId,
    parentOccurrence: fanout.parentOccurrence,
    childIndex: fanout.childIndex,
    checkpointId: fanout.checkpointId,
  };
}

/**
 * Plan one batch of generated effects into staged intents plus recorded
 * skips. Guards evaluate at stage time: unconditional and guard-true
 * effects stage; guard-false effects record skips. Fail-closed for the
 * whole batch: duplicate derived ids, malformed requests, malformed
 * lineage, incoherent guards (non-string predicates) and evaluator
 * throws all reject the plan, so the caller stages nothing and the
 * trigger batch rolls back instead of half-staging.
 */
export function planDispatchStaging(
  deps: PlanDispatchStagingDeps,
  input: PlanDispatchStagingInput,
): DispatchStagePlan {
  const staged: StagedOutboxIntent[] = [];
  const skipped: SkipRecord[] = [];
  const seen = new Set<string>();
  for (const effect of input.effects) {
    const what = `planDispatchStaging: effect ${effect.source}#${effect.occurrenceIndex}`;
    if (effect.guard !== null && (typeof effect.guard !== 'string' || effect.guard === '')) {
      throw new RangeError(`${what}: guard must be a non-empty string or null`);
    }
    const fanout =
      effect.fanout === undefined || effect.fanout === null
        ? null
        : checkFanoutLineage(effect.fanout, what);
    const id = deriveOutboxId(effect.operationId, effect.source, effect.occurrenceIndex);
    if (seen.has(id)) {
      throw new RangeError(`${what}: duplicate staged outbox id ${JSON.stringify(id)}`);
    }
    seen.add(id);
    const request = freezeRequest(effect.request);
    const origin: IntentOrigin = {
      operationId: effect.operationId,
      source: effect.source,
      occurrenceIndex: effect.occurrenceIndex,
      originOccurrence: effect.originOccurrence,
    };
    if (effect.guard !== null) {
      // Stage-time verdict. Only an explicit true stages: false, throws
      // and any non-boolean are fail-closed (skip or propagate).
      const verdict = deps.evaluateGuard(effect.guard, effect.frozenInputs, input.stateSnapshot);
      if (verdict !== true) {
        skipped.push({ outboxId: id, origin, guard: effect.guard, verdict: false, reason: 'guard-false', fanout });
        continue;
      }
    }
    staged.push({
      item: {
        id,
        operationId: effect.operationId,
        source: effect.source,
        occurrenceIndex: effect.occurrenceIndex,
        request,
        originOccurrence: effect.originOccurrence,
        attempts: 0,
        state: 'pending',
      },
      commit: null,
    });
  }
  return { staged, skipped };
}

/* -- T24a intent lifecycle: staged -> claimed -> done/failed/skipped. -- */

/**
 * Coarse staging-layer lifecycle over the persisted outbox state plus the
 * pinned guard verdict. `uncertain` maps to `claimed`: the intent is
 * still in flight awaiting reconcile evidence (recovery resumes it, it
 * is neither done nor failed). A pending item pinned guard-false is
 * `skipped`, never silently pending.
 */
export type IntentLifecycle = 'staged' | 'claimed' | 'done' | 'failed' | 'skipped';

export function lifecycleOf(item: OutboxItem, guardVerdict: boolean | null): IntentLifecycle {
  switch (item.state) {
    case 'pending':
      return guardVerdict === false ? 'skipped' : 'staged';
    case 'claimed':
    case 'uncertain':
      return 'claimed';
    case 'delivered':
      return 'done';
    case 'failed':
    case 'dead':
      return 'failed';
  }
}

/** Terminal lifecycles never dispatch again: done, failed or skipped. */
export function isTerminalLifecycle(lifecycle: IntentLifecycle): boolean {
  return lifecycle === 'done' || lifecycle === 'failed' || lifecycle === 'skipped';
}

/**
 * The explicit commit gate: returns the intent when committed, throws when
 * staged-but-uncommitted. Dispatch uses the equivalent status check so a
 * commit failure causes no send.
 */
export function requireCommitted(intent: AnyOutboxIntent): CommittedOutboxIntent {
  if (intent.commit === null) {
    throw new Error(
      `work: outbox intent ${intent.item.id} is staged but not committed; dispatch refused`,
    );
  }
  return intent;
}
