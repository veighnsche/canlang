/**
 * T34-F7 durable fanout child store: the production replacement for
 * F3's in-memory test store over the existing StoragePort
 * (D1 + DO, consumed as-is). Row reads/writes run through the explicitly
 * selected Work kernel (`deps.kernel`, default TS); one operation joins
 * caller-supplied checkpoint/domain/history/replay effects atomically
 * with the child transition (`input.join`, default child-row-only).
 *
 * Decision order is identical to F3 (L4 dispatch slice): terminal
 * replay -> running held -> stale check -> inherited-scope -> guard
 * on the CURRENT snapshot -> revoked -> claim. Replay, held and stale
 * touch neither fence nor guard; inherited-scope never runs the guard;
 * a revoked authority mints no claim even when the guard passes. The
 * pure shapes (F1 outcomes, F2 rows, progress) are reused unchanged
 * from `./index.js` and `../kernel/tables.js` — only persistence moves
 * from the serialized memory map to fenced conditional updates.
 *
 * Fencing: every transition commits `pending/running -> next` as ONE
 * atomic batch fenced on BOTH the store revision (`expectedRevision`)
 * and the row version (`expectedVersion: observed version`). Exactly
 * one concurrent winner lands; losers catch the fence/version
 * conflict, reload, and observe the winner (replayed terminal, held
 * running, or refused-stale) instead of minting a duplicate. A
 * revision-only conflict against an otherwise unchanged row retries
 * the decision once on fresh truth; a row-version conflict always
 * resolves to the loser view. Attempts increment for executed records
 * only, never for skips or refusals (F3/T24 precedent, preserved).
 *
 * Deliberately absent (same as F3): no membership enumeration (F5),
 * no recovery scanning (F4), no quota, no authoring syntax. Claim and
 * record are separate atomic units: the retry gap between them is the
 * crash-restart resume point (a committed `running` row survives the
 * harness kill; its unit never did, so nothing partial exists).
 */

import type {
  DomainWrite,
  FanoutChildId,
  FanoutChildOutcome,
  FanoutFailedReason,
  FanoutId,
  FanoutProgress,
  FanoutSkippedReason,
  HistoryEntry,
  OutboxIntent,
  RecordId,
  RetryPolicy,
  Receipt,
  ScheduleOp,
  StoragePort,
  StoredRow,
  UniqueClaim,
  UniqueRelease,
} from '@canlang/contracts';
import {
  FenceConflictError,
  StorageConstraintError,
} from '@canlang/state/storage/port';
import { createWorkKernel, tsWorkKernel, type WorkKernel, type WorkKernelOptions } from '@canlang/work-kernel';
import type { ClockPort } from '../ports.js';
import {
  WORK_FANOUT_CHECKPOINT_MODEL,
  WORK_FANOUT_CHILD_MODEL,
  fanoutCheckpointRowId,
  fanoutChildPageQuery,
  fanoutChildPageResult,
  fanoutChildRowId,
  nextFanoutCheckpointData,
  readFanoutCheckpointRow,
  readFanoutChildRow,
  withRowData,
  type FanoutChildRowData,
} from '../kernel/tables.js';
import {
  FANOUT_T32_REFUSAL_REASON,
  fanoutChildOutcomeFromRow,
  summarizeFanoutChildren,
  type FanoutChildClaimInput,
  type FanoutChildClaimOutcome,
  type FanoutChildRecordInput,
  type FanoutChildRecordOutcome,
  type GuardEvaluator,
} from './index.js';

/** Actor stamp for durable store writes (callers supply the real actor). */
export interface DurableFanoutChildStoreDeps {
  readonly store: StoragePort;
  readonly clock: ClockPort;
  /** Non-empty writer identity stamped on created/updated metadata. */
  readonly actor: string;
  /**
   * Explicit kernel selection for every row read/write in this store.
   * Defaults to the TS kernel (existing behavior); production passes the
   * selected kernel (e.g. the installed Wasm backend) explicitly.
   */
  readonly kernel?: WorkKernel;
}

/**
 * Effects joined atomically with one child-row transition in the same
 * fenced batch: extra domain writes (e.g. the parent fanout checkpoint),
 * history entries, a receipt, outbox/schedule effects, or unique
 * claim/release swaps. Absent means child-row-only (existing behavior).
 * The batch still fences on store revision + row version, so joined
 * effects land whole with the transition or roll back with it.
 */
export interface DurableJoinEffects {
  readonly writes?: ReadonlyArray<DomainWrite>;
  readonly history?: ReadonlyArray<HistoryEntry>;
  readonly receipt?: Receipt | null;
  readonly outbox?: ReadonlyArray<OutboxIntent>;
  readonly schedules?: ReadonlyArray<ScheduleOp>;
  readonly uniqueClaims?: ReadonlyArray<UniqueClaim>;
  readonly uniqueReleases?: ReadonlyArray<UniqueRelease>;
}

/** Per-operation joined effects for one claim or record call. */
export interface DurableJoin {
  readonly join?: DurableJoinEffects;
}

const FANOUT_TERMINAL_FAILED_REASONS: ReadonlySet<string> = new Set([
  'business-rejection',
  'terminal',
  'missing-record',
  'inaccessible-record',
  'infra-read-failure',
]);

function assertRetryPolicy(policy: RetryPolicy): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError('t34-f7: policy.maxAttempts must be an integer >= 1');
  }
  if (!Number.isFinite(policy.horizonMs) || policy.horizonMs <= 0) {
    throw new RangeError('t34-f7: policy.horizonMs must be finite and > 0');
  }
}

/**
 * Production durable fanout child store. Async throughout (the
 * StoragePort is async); the injected guard stays synchronous per the
 * frozen F3 seam. At most one commit per call except a single
 * revision-contention re-decision on unchanged rows.
 */
export class DurableFanoutChildStore {
  private readonly store: StoragePort;
  private readonly clock: ClockPort;
  private readonly actor: string;
  private readonly kernel: WorkKernel;

  constructor(deps: DurableFanoutChildStoreDeps) {
    if (typeof deps.actor !== 'string' || deps.actor === '') {
      throw new Error('t34-f7: actor must be a non-empty string.');
    }
    this.store = deps.store;
    this.clock = deps.clock;
    this.actor = deps.actor;
    this.kernel = deps.kernel ?? tsWorkKernel;
  }

  private rowId(child: FanoutChildId): RecordId {
    return fanoutChildRowId(
      child.parentOccurrence,
      child.handler,
      child.recordId,
      this.kernel,
    ) as RecordId;
  }

  /** Admit one child row for setup (duplicate insert throws, like a PK conflict). */
  async insert(row: StoredRow): Promise<void> {
    const data = readFanoutChildRow(row, this.kernel);
    const key = fanoutChildRowId(data.parentOccurrence, data.handler, data.recordId, this.kernel);
    if (key !== (row.id as string)) {
      throw new Error('t34-f7: insert row id must equal its parent+handler+record derivation.');
    }
    const existing = await this.store.load(WORK_FANOUT_CHILD_MODEL, key as RecordId);
    if (existing !== null) {
      throw new Error(`t34-f7: duplicate fanout child row ${JSON.stringify(key)}.`);
    }
    const revision = await this.store.readRevision();
    // A concurrent insert racing this commit surfaces as the adapter's
    // unique-constraint signal (the durable PK conflict); it propagates.
    await this.store.commit({
      expectedRevision: revision,
      writes: [{ kind: 'insert', model: WORK_FANOUT_CHILD_MODEL, row }],
      history: [],
      receipt: null,
      outbox: [],
      schedules: [],
      uniqueClaims: [],
      uniqueReleases: [],
    });
  }

  async get(child: FanoutChildId): Promise<StoredRow | null> {
    return this.store.load(WORK_FANOUT_CHILD_MODEL, this.rowId(child));
  }

  /**
   * One atomic fenced row transition: `expectedVersion` pins the exact
   * observed row and the store revision fences the batch, so concurrent
   * writers serialize and only one winner lands. Caller-supplied joined
   * effects ride the same batch (child/checkpoint/domain/history/replay):
   * they land whole with the transition or roll back with it.
   */
  private async commitRow(
    current: StoredRow,
    data: FanoutChildRowData,
    join?: DurableJoinEffects,
  ): Promise<StoredRow> {
    const next = withRowData(
      current,
      { ...data },
      { nowMs: this.clock.nowMs(), actor: this.actor },
      'work.fanout_child',
      this.kernel,
    );
    const revision = await this.store.readRevision();
    await this.store.commit({
      expectedRevision: revision,
      writes: [{
        kind: 'update',
        model: WORK_FANOUT_CHILD_MODEL,
        id: current.id,
        expectedVersion: current.version,
        row: next,
      }, ...(join?.writes ?? [])],
      history: join?.history ?? [],
      receipt: join?.receipt ?? null,
      outbox: join?.outbox ?? [],
      schedules: join?.schedules ?? [],
      uniqueClaims: join?.uniqueClaims ?? [],
      uniqueReleases: join?.uniqueReleases ?? [],
    });
    return next;
  }

  /**
   * Checkpoint cover for one terminal child transition: the parent
   * fanout checkpoint's staged completed set gains this record id,
   * computed through the selected kernel. A terminal outcome without
   * same-fanout checkpoint cover (or cover without its outcome) is
   * refused downstream — never acknowledged unfinished, never
   * checkpointed apart. Absent checkpoint rows stay absent (bare-child
   * behavior, unchanged); a caller-joined checkpoint write wins over
   * the derived one, so the same row is never covered twice.
   */
  private async checkpointCover(
    data: FanoutChildRowData,
    join?: DurableJoinEffects,
  ): Promise<DomainWrite | null> {
    if (join?.writes?.some((write) => write.model === WORK_FANOUT_CHECKPOINT_MODEL) === true) {
      return null;
    }
    const checkpointId = fanoutCheckpointRowId(data.fanoutId, this.kernel);
    const current = await this.store.load(WORK_FANOUT_CHECKPOINT_MODEL, checkpointId as RecordId);
    if (current === null) {
      return null;
    }
    const checkpoint = readFanoutCheckpointRow(current, this.kernel);
    if (checkpoint.fanoutId !== data.fanoutId) {
      throw new Error(
        `t34-f7: checkpoint ${JSON.stringify(checkpointId)} covers ${JSON.stringify(checkpoint.fanoutId)}; ` +
          `child belongs to ${JSON.stringify(data.fanoutId)}.`,
      );
    }
    const advanced = nextFanoutCheckpointData(checkpoint, [data.recordId], checkpoint.cursor, this.kernel);
    const next = withRowData(
      current,
      { ...advanced },
      { nowMs: this.clock.nowMs(), actor: this.actor },
      'work.fanout_checkpoint',
      this.kernel,
    );
    return {
      kind: 'update',
      model: WORK_FANOUT_CHECKPOINT_MODEL,
      id: current.id,
      expectedVersion: current.version,
      row: next,
    };
  }

  /** Derived checkpoint cover rides ahead of caller-joined writes. */
  private static withCover(
    cover: DomainWrite | null,
    join?: DurableJoinEffects,
  ): DurableJoinEffects | undefined {
    if (cover === null) return join;
    return { ...join, writes: [cover, ...(join?.writes ?? [])] };
  }

  private static isFenceSignal(error: unknown): boolean {
    return error instanceof FenceConflictError ||
      (error instanceof StorageConstraintError && error.kind === 'version');
  }

  /**
   * Resolve a commit conflict to the loser view: reload the winner and
   * replay/hold/refuse against fresh truth. Returns null only for pure
   * revision contention (the row is byte-identical to the observed one),
   * where the caller re-decides once instead of refusing honestly live
   * data. Any other error propagates untouched.
   */
  private async claimLoserView(
    child: FanoutChildId,
    observed: StoredRow,
    error: unknown,
  ): Promise<FanoutChildClaimOutcome | null> {
    if (!DurableFanoutChildStore.isFenceSignal(error)) {
      throw error;
    }
    const fresh = await this.store.load(WORK_FANOUT_CHILD_MODEL, this.rowId(child));
    if (fresh === null) {
      throw error;
    }
    if (fresh.version === observed.version) {
      const freshData = readFanoutChildRow(fresh, this.kernel);
      const observedData = readFanoutChildRow(observed, this.kernel);
      if (freshData.state === observedData.state) {
        return null;
      }
    }
    const data = readFanoutChildRow(fresh, this.kernel);
    const terminal = fanoutChildOutcomeFromRow(data);
    if (terminal !== null) {
      return { status: 'replayed', outcome: terminal, row: fresh };
    }
    if (data.state === 'running') {
      return { status: 'held', row: fresh, child };
    }
    return { status: 'refused-stale', row: fresh, child };
  }

  private loadOrThrow(row: StoredRow | null, key: string): StoredRow {
    if (row === null) {
      throw new Error(
        `t34-f7: no fanout child row for ${JSON.stringify(key)} (producer write missing).`,
      );
    }
    return row;
  }

  /**
   * Claim one child: terminal replays, running holds, stale refuses,
   * then inherited-scope -> guard-on-current -> revoked -> claim.
   * Later checks never run once an earlier one decides.
   */
  async claim(
    evaluateGuard: GuardEvaluator,
    input: FanoutChildClaimInput & DurableJoin,
  ): Promise<FanoutChildClaimOutcome> {
    const key = fanoutChildRowId(
      input.child.parentOccurrence,
      input.child.handler,
      input.child.recordId,
      this.kernel,
    );
    // At most one re-decision on pure revision contention; a changed
    // row resolves to the loser view inside the loop.
    for (let pass = 0; pass < 2; pass += 1) {
      const current = this.loadOrThrow(
        await this.store.load(WORK_FANOUT_CHILD_MODEL, key as RecordId),
        key,
      );
      const data = readFanoutChildRow(current, this.kernel);
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
        try {
          const cover = await this.checkpointCover(data, input.join);
          const failed = await this.commitRow(current, {
            ...data,
            state: 'failed',
            causeKind: 'failed',
            causeReason: FANOUT_T32_REFUSAL_REASON,
          }, DurableFanoutChildStore.withCover(cover, input.join));
          return {
            status: 'refused-inherited-scope',
            outcome: this.terminalOrThrow(failed, 'refused-inherited-scope'),
            row: failed,
          };
        } catch (error) {
          const loser = await this.claimLoserView(input.child, current, error);
          if (loser !== null) {
            return loser;
          }
          continue;
        }
      }
      const predicate = input.guard.predicate;
      if (predicate !== null) {
        const currentSnapshot = input.readCurrentSnapshot();
        const result = evaluateGuard(predicate, input.frozenInputs, currentSnapshot);
        if (result !== true) {
          try {
            const cover = await this.checkpointCover(data, input.join);
            const skipped = await this.commitRow(current, {
              ...data,
              state: 'skipped',
              causeKind: 'skipped',
              causeReason: 'non-applicable',
            }, DurableFanoutChildStore.withCover(cover, input.join));
            return {
              status: 'skipped',
              outcome: this.terminalOrThrow(skipped, 'guard-false skip'),
              row: skipped,
            };
          } catch (error) {
            const loser = await this.claimLoserView(input.child, current, error);
            if (loser !== null) {
              return loser;
            }
            continue;
          }
        }
      }
      if (fence?.revalidateAuthority !== undefined && fence.revalidateAuthority() !== true) {
        try {
          const cover = await this.checkpointCover(data, input.join);
          const failed = await this.commitRow(current, {
            ...data,
            state: 'failed',
            causeKind: 'failed',
            causeReason: FANOUT_T32_REFUSAL_REASON,
          }, DurableFanoutChildStore.withCover(cover, input.join));
          return {
            status: 'refused-revoked',
            outcome: this.terminalOrThrow(failed, 'refused-revoked'),
            row: failed,
          };
        } catch (error) {
          const loser = await this.claimLoserView(input.child, current, error);
          if (loser !== null) {
            return loser;
          }
          continue;
        }
      }
      try {
        const running = await this.commitRow(current, { ...data, state: 'running' }, input.join);
        return { status: 'claimed', row: running, child: input.child };
      } catch (error) {
        const loser = await this.claimLoserView(input.child, current, error);
        if (loser !== null) {
          return loser;
        }
      }
    }
    throw new Error('t34-f7: unreachable: claim contention retry exhausted.');
  }

  private terminalOrThrow(row: StoredRow, what: string): FanoutChildOutcome {
    const outcome = fanoutChildOutcomeFromRow(readFanoutChildRow(row, this.kernel));
    if (outcome === null) {
      throw new Error(`t34-f7: unreachable: ${what} produced a live row.`);
    }
    return outcome;
  }

  /**
   * Record one executed attempt: terminal replays, live-but-idle
   * throws (record needs a running claim), then completed/skipped/
   * failed record terminally while transient retries within budget
   * (same row, attempts++) or exhausts to failed/exhausted
   * (dead-letter visible, never retried).
   */
  async record(input: FanoutChildRecordInput & DurableJoin): Promise<FanoutChildRecordOutcome> {
    assertRetryPolicy(input.policy);
    if (!Number.isFinite(input.nowMs) || input.nowMs < 0) {
      throw new RangeError('t34-f7: nowMs must be finite and >= 0');
    }
    if (!Number.isFinite(input.firstAttemptAtMs) || input.firstAttemptAtMs < 0) {
      throw new RangeError('t34-f7: firstAttemptAtMs must be finite and >= 0');
    }
    const key = fanoutChildRowId(
      input.child.parentOccurrence,
      input.child.handler,
      input.child.recordId,
      this.kernel,
    );
    const current = this.loadOrThrow(
      await this.store.load(WORK_FANOUT_CHILD_MODEL, key as RecordId),
      key,
    );
    const data = readFanoutChildRow(current, this.kernel);
    const terminal = fanoutChildOutcomeFromRow(data);
    if (terminal !== null) {
      return { status: 'replayed', outcome: terminal, row: current };
    }
    if (data.state !== 'running') {
      throw new Error(
        `t34-f7: record applies to running children only; ${JSON.stringify(key)} is ${data.state}.`,
      );
    }
    const result = input.result;
    if (result.kind === 'completed') {
      return this.commitRecorded(current, {
        ...data,
        state: 'completed',
        attempts: data.attempts + 1,
        causeKind: 'completed',
        causeReason: null,
      }, input.join);
    }
    if (result.kind === 'skipped') {
      if (result.reason !== 'deleted' && result.reason !== 'non-applicable') {
        throw new Error(
          `t34-f7: skipped reason must be deleted or non-applicable, got ${JSON.stringify(result.reason)}.`,
        );
      }
      return this.commitRecorded(current, {
        ...data,
        state: 'skipped',
        causeKind: 'skipped',
        causeReason: result.reason as FanoutSkippedReason,
      }, input.join);
    }
    if (result.kind === 'failed') {
      if ((result.reason as string) === 'exhausted') {
        throw new Error('t34-f7: exhausted is derived by the horizon, never supplied.');
      }
      if (!FANOUT_TERMINAL_FAILED_REASONS.has(result.reason)) {
        throw new Error(
          `t34-f7: failed reason is unknown: ${JSON.stringify(result.reason)}.`,
        );
      }
      return this.commitRecorded(current, {
        ...data,
        state: 'failed',
        attempts: data.attempts + 1,
        causeKind: 'failed',
        causeReason: result.reason as FanoutFailedReason,
      }, input.join);
    }
    const newAttempts = data.attempts + 1;
    const attemptsExhausted = newAttempts >= input.policy.maxAttempts;
    const horizonExceeded = input.nowMs - input.firstAttemptAtMs >= input.policy.horizonMs;
    if (attemptsExhausted || horizonExceeded) {
      return this.commitRecorded(current, {
        ...data,
        state: 'failed',
        attempts: newAttempts,
        causeKind: 'failed',
        causeReason: 'exhausted',
      }, input.join);
    }
    const next = await this.commitRow(current, {
      ...data,
      state: 'pending',
      attempts: newAttempts,
      causeKind: null,
      causeReason: null,
    }, input.join);
    return { status: 'retried', row: next };
  }

  /**
   * Commit one record transition. A fence conflict here means a
   * concurrent writer moved the row: terminal winners replay, any
   * other contention surfaces loudly (the drive retries) instead of
   * guessing which attempt executed.
   */
  private async commitRecorded(
    current: StoredRow,
    data: FanoutChildRowData,
    join?: DurableJoinEffects,
  ): Promise<FanoutChildRecordOutcome> {
    let next: StoredRow;
    try {
      // Every recorded outcome is terminal: cover it with the parent
      // checkpoint in the same atomic batch (absent checkpoints stay
      // absent; caller-joined checkpoint writes win). Identity never
      // changes across the transition, so the staged data carries it.
      const cover = await this.checkpointCover(data, join);
      next = await this.commitRow(current, data, DurableFanoutChildStore.withCover(cover, join));
    } catch (error) {
      if (DurableFanoutChildStore.isFenceSignal(error)) {
        const fresh = await this.store.load(WORK_FANOUT_CHILD_MODEL, current.id as RecordId);
        if (fresh !== null) {
          const outcome = fanoutChildOutcomeFromRow(readFanoutChildRow(fresh, this.kernel));
          if (outcome !== null) {
            return { status: 'replayed', outcome, row: fresh };
          }
        }
      }
      throw error;
    }
    return {
      status: 'recorded',
      outcome: this.terminalOrThrow(next, 'recorded'),
      row: next,
    };
  }

  /**
   * Counts-only progress over one fanout's admitted rows, paged through
   * the bounded child-page query (data-minimized operator view: no
   * child rows leak). Fully terminal with failures means attention,
   * never success.
   */
  async progress(fanoutId: FanoutId): Promise<FanoutProgress> {
    if (typeof fanoutId !== 'string' || fanoutId === '') {
      throw new Error('t34-f7: fanoutId must be a non-empty string.');
    }
    const rows: StoredRow[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await this.store.query(fanoutChildPageQuery(fanoutId, { cursor, limit: 64 }, this.kernel));
      rows.push(...page);
      const folded = fanoutChildPageResult(page, 64, this.kernel);
      if (folded.done) {
        return summarizeFanoutChildren(fanoutId, rows, this.kernel);
      }
      cursor = folded.cursor;
    }
  }
}

/**
 * Production entrypoint: build the durable child store over explicit
 * kernel selection. A supplied kernel instance wins; otherwise the
 * backend options select one now via `createWorkKernel` (default TS).
 * Either way every row read/write in the store runs through the one
 * selected kernel — never a hidden default beside the caller's choice.
 */
export function createDurableFanoutChildStore(
  deps: DurableFanoutChildStoreDeps & { readonly kernelOptions?: WorkKernelOptions },
): DurableFanoutChildStore {
  return new DurableFanoutChildStore({
    store: deps.store,
    clock: deps.clock,
    actor: deps.actor,
    kernel: deps.kernel ?? createWorkKernel(deps.kernelOptions ?? { backend: 'ts' }),
  });
}
