/**
 * TEST-ONLY fanout driver: the F5-owned half of one child's execution
 * (claim → lifecycle → guard → admit → record), shared by the fanout
 * join proofs. Production scheduling/driving is F7's; this driver
 * exists so every F5 proof runs the REAL staging/transact/invoke/
 * admission/pipeline joins on the REAL store.
 *
 * Driver order (mirrors the F3/F4 decision order):
 * terminal row → replay (never re-invoke) → lifecycle deleted/unknown →
 * pin without invoking → guard-false → pin without invoking → claim
 * (pending→running, loser observes the winner) → `invokeFanoutChild`
 * (fresh fence; the body stages domain effects + the terminal outcome +
 * the checkpoint advance in ONE unit) → `forbidden` maps to
 * failed/inaccessible-record, `rule_failed` to failed/business-rejection,
 * contention to a retry signal, anything else to a loud throw.
 *
 * Claim-time pins (deleted/unknown/guard-false) transition pending→
 * terminal directly in one join-port commit with the checkpoint advance;
 * executed children transition running→terminal inside `invoke`'s unit
 * commit. Attempts increment for executed records only, never for pins.
 */

import type {
  CommitBatch,
  DomainWrite,
  HistoryEntry,
  ModelName,
  OperationId,
  OperationName,
  OutboxIntent,
  RecordId,
  ScheduleOp,
  StoragePort,
  StoredRow,
} from '../../../contracts/src/state.js';
import type { ResolvedIdentity } from '../../../contracts/src/identity.js';
import type {
  FanoutChildId,
  FanoutFailedReason,
  FanoutId,
  FanoutSkippedReason,
  RetryPolicy,
} from '../../../contracts/src/work.js';
import type { OperationRegistry } from '../invocation/registry.js';
import type { ClockPort } from '../invocation/context.js';
import { invokeFanoutChild, type ExecuteHandler } from '../invocation/invoke.js';
import type { MembershipReader } from '../policy/roles.js';
import { StateError } from '../errors.js';
import { FenceConflictError, StorageConstraintError } from '../storage/port.js';
import { assertFanoutChildJoin, createFanoutChildJoinPort } from '../ports/transact.js';
import {
  fanoutChildRowId,
  readFanoutCheckpointRow,
  readFanoutChildRow,
  withFanoutRowData,
} from './tables.js';
import type { FanoutRowMeta } from './tables.js';
import {
  classifyFanoutChildLifecycle,
  refusedFanoutLifecycle,
  type FanoutChildLifecycle,
} from './lifecycle.js';
import {
  FANOUT_T32_REFUSAL_REASON,
  stageFanoutCheckpointAdvanceWrite,
  stageFanoutChildOutcomeWrite,
  type FanoutChildAttemptResult,
} from './outcome.js';

/** One driven child: stable identity plus its cohort record. */
export interface DrivenChild {
  readonly child: FanoutChildId;
  readonly fanoutId: FanoutId;
  readonly model: string;
  readonly recordId: string;
  readonly anchor?: { readonly model: string; readonly id: string };
}

/**
 * Child body contract (injected per test): evaluates the CURRENT domain
 * row and returns staged domain effects plus the attempt result, or
 * throws `StateError` (business rejection → failed/business-rejection).
 */
export type DrivenBody = (row: StoredRow) => Promise<{
  readonly writes: DomainWrite[];
  readonly history: HistoryEntry[];
  readonly outbox: OutboxIntent[];
  readonly schedules: ScheduleOp[];
  readonly result: FanoutChildAttemptResult;
}>;

/** One drive request for a single admitted child. */
export interface DriveFanoutChildInput {
  readonly store: StoragePort;
  readonly memberships: MembershipReader;
  readonly registry: OperationRegistry;
  readonly clock: ClockPort;
  readonly identity: ResolvedIdentity;
  readonly app: string;
  readonly source: string;
  readonly childOperation: string;
  readonly operationId: string;
  /** Child record ref input name in the def (the version-fenced ref). */
  readonly refInput: string;
  readonly driven: DrivenChild;
  /** Current-state body guard (null-or-match filters live here in tests). */
  readonly guard: (row: StoredRow) => boolean;
  readonly body: DrivenBody;
  readonly nowMs: number;
  readonly firstAttemptAtMs: number;
  readonly policy: RetryPolicy;
  readonly meta: FanoutRowMeta;
}

export type DriveFanoutChildOutcome =
  | { readonly status: 'recorded'; readonly lifecycle: FanoutChildLifecycle }
  | { readonly status: 'replayed' }
  | { readonly status: 'held' }
  | { readonly status: 'lost' }
  | { readonly status: 'retry' };

async function pinTerminal(
  input: DriveFanoutChildInput,
  childRow: StoredRow,
  result: FanoutChildAttemptResult,
): Promise<void> {
  const checkpointRow = await input.store.load(
    'work.fanout_checkpoint' as ModelName,
    input.driven.fanoutId as RecordId,
  );
  if (checkpointRow === null) {
    throw new Error('fanout test driver: checkpoint row missing for a terminal pin.');
  }
  const checkpoint = readFanoutCheckpointRow(checkpointRow);
  const staged = stageFanoutChildOutcomeWrite({
    row: childRow,
    result,
    nowMs: input.nowMs,
    firstAttemptAtMs: input.firstAttemptAtMs,
    policy: input.policy,
    meta: input.meta,
  });
  const advance = stageFanoutCheckpointAdvanceWrite({
    row: checkpointRow,
    recordId: staged.recordId,
    cursor: checkpoint.cursor,
    meta: input.meta,
  });
  const port = createFanoutChildJoinPort({ store: input.store });
  const batch: CommitBatch & { expectedRevision: Awaited<ReturnType<StoragePort['readRevision']>> } = {
    expectedRevision: await input.store.readRevision(),
    writes: [staged.write, advance],
    history: [],
    receipt: null,
    outbox: [],
    schedules: [],
    uniqueClaims: [],
    uniqueReleases: [],
  };
  await port.commitJoin(batch);
}

/**
 * Drive one admitted child through the F5 joins. See the module header
 * for the order and mappings.
 */
export async function driveFanoutChild(input: DriveFanoutChildInput): Promise<DriveFanoutChildOutcome> {
  const childRowId = fanoutChildRowId(
    input.driven.child.parentOccurrence,
    input.driven.child.handler,
    input.driven.child.recordId,
  );
  const loaded = await input.store.load('work.fanout_child' as ModelName, childRowId as RecordId);
  if (loaded === null) {
    throw new Error(
      `fanout test driver: no fanout child row for ${JSON.stringify(childRowId)} (producer write missing).`,
    );
  }
  const data = readFanoutChildRow(loaded);
  if (data.state === 'completed' || data.state === 'skipped' || data.state === 'failed') {
    return { status: 'replayed' };
  }
  if (data.state === 'running') {
    return { status: 'held' };
  }
  const lifecycle = await classifyFanoutChildLifecycle({
    store: input.store,
    model: input.driven.model,
    recordId: input.driven.recordId,
    ...(input.driven.anchor !== undefined ? { anchor: input.driven.anchor } : {}),
  });
  if (lifecycle.status === 'deleted') {
    await pinTerminal(input, loaded, { kind: 'skipped', reason: 'deleted' satisfies FanoutSkippedReason });
    return { status: 'recorded', lifecycle };
  }
  if (lifecycle.status === 'unknown') {
    await pinTerminal(input, loaded, { kind: 'failed', reason: lifecycle.reason });
    return { status: 'recorded', lifecycle };
  }
  const domainRow = await input.store.load(
    input.driven.model as ModelName,
    input.driven.recordId as RecordId,
  );
  if (domainRow === null || domainRow.archivedAt !== null) {
    // Raced disposal between classification and the guard read:
    // re-classify once and pin — never execute a dead row.
    const raced = await classifyFanoutChildLifecycle({
      store: input.store,
      model: input.driven.model,
      recordId: input.driven.recordId,
      ...(input.driven.anchor !== undefined ? { anchor: input.driven.anchor } : {}),
    });
    if (raced.status === 'deleted') {
      await pinTerminal(input, loaded, { kind: 'skipped', reason: 'deleted' });
      return { status: 'recorded', lifecycle: raced };
    }
    if (raced.status === 'unknown') {
      await pinTerminal(input, loaded, { kind: 'failed', reason: raced.reason });
      return { status: 'recorded', lifecycle: raced };
    }
    return { status: 'retry' };
  }
  if (!input.guard(domainRow)) {
    await pinTerminal(input, loaded, { kind: 'skipped', reason: 'non-applicable' });
    return { status: 'recorded', lifecycle };
  }
  // Claim: pending→running under the live version. A lost race observes
  // the winner (never double-claims).
  const claimed = await (async (): Promise<StoredRow | null> => {
    const current = await input.store.load(
      'work.fanout_child' as ModelName,
      childRowId as RecordId,
    );
    if (current === null) {
      throw new Error('fanout test driver: child row vanished before the claim.');
    }
    const currentData = readFanoutChildRow(current);
    if (currentData.state !== 'pending') {
      return null;
    }
    const next = withFanoutRowData(
      current,
      { ...currentData, state: 'running' },
      input.meta,
    );
    try {
      await input.store.commit({
        expectedRevision: await input.store.readRevision(),
        writes: [
          {
            kind: 'update',
            model: 'work.fanout_child' as ModelName,
            id: childRowId as RecordId,
            expectedVersion: current.version,
            row: next,
          },
        ],
        history: [],
        receipt: null,
        outbox: [],
        schedules: [],
        uniqueClaims: [],
        uniqueReleases: [],
      });
    } catch (error) {
      if (error instanceof FenceConflictError || error instanceof StorageConstraintError) {
        return null;
      }
      throw error;
    }
    return next;
  })();
  if (claimed === null) {
    return { status: 'lost' };
  }
  const execute: ExecuteHandler = async (call) => {
    const effects = await input.body(domainRow);
    // Fresh fanout rows per execution (invoke retries re-execute, so
    // versions re-read — never carried across attempts).
    const childNow = await input.store.load(
      'work.fanout_child' as ModelName,
      childRowId as RecordId,
    );
    const checkpointNow = await input.store.load(
      'work.fanout_checkpoint' as ModelName,
      input.driven.fanoutId as RecordId,
    );
    if (childNow === null || checkpointNow === null) {
      throw new Error('fanout test driver: fanout rows vanished before the unit commit.');
    }
    const staged = stageFanoutChildOutcomeWrite({
      row: childNow,
      result: effects.result,
      nowMs: input.nowMs,
      firstAttemptAtMs: input.firstAttemptAtMs,
      policy: input.policy,
      meta: input.meta,
    });
    const advance = stageFanoutCheckpointAdvanceWrite({
      row: checkpointNow,
      recordId: staged.recordId,
      cursor: readFanoutCheckpointRow(checkpointNow).cursor,
      meta: input.meta,
    });
    void call;
    return {
      writes: [...effects.writes, staged.write, advance],
      history: effects.history,
      outbox: effects.outbox,
      schedules: effects.schedules,
      uniqueClaims: [],
      uniqueReleases: [],
      resolvedDefaults: {},
      result: { child: input.driven.child.recordId },
    };
  };
  try {
    await invokeFanoutChild({
      registry: input.registry,
      store: input.store,
      memberships: input.memberships,
      clock: input.clock,
      childOperation: input.childOperation,
      child: input.driven.child,
      operationId: input.operationId,
      identity: input.identity,
      app: input.app,
      source: input.source,
      inputs: { [input.refInput]: { id: input.driven.recordId } },
      execute,
      assertJoin: assertFanoutChildJoin,
    });
  } catch (error) {
    if (error instanceof StateError && error.code === 'forbidden') {
      // Claim-time T32 refusal: record failed/inaccessible-record (the
      // F3 mapping), attempts unchanged — the claim never executed.
      // Reload the running row: the refused attempt committed nothing.
      const refused = await input.store.load(
        'work.fanout_child' as ModelName,
        childRowId as RecordId,
      );
      if (refused === null) {
        throw new Error('fanout test driver: child row vanished after a refusal.');
      }
      const refusedData = readFanoutChildRow(refused);
      if (
        refusedData.state === 'completed' ||
        refusedData.state === 'skipped' ||
        refusedData.state === 'failed'
      ) {
        return { status: 'replayed' };
      }
      // A refused claim returns to pending first (one plain commit —
      // claims carry no completion), then pins terminal with the
      // checkpoint in the join port. Attempts unchanged throughout.
      const back = withFanoutRowData(refused, { ...refusedData, state: 'pending' }, input.meta);
      await input.store.commit({
        expectedRevision: await input.store.readRevision(),
        writes: [
          {
            kind: 'update',
            model: 'work.fanout_child' as ModelName,
            id: childRowId as RecordId,
            expectedVersion: refused.version,
            row: back,
          },
        ],
        history: [],
        receipt: null,
        outbox: [],
        schedules: [],
        uniqueClaims: [],
        uniqueReleases: [],
      });
      await pinTerminal(input, back, {
        kind: 'failed',
        reason: FANOUT_T32_REFUSAL_REASON as Exclude<FanoutFailedReason, 'exhausted'>,
      });
      return { status: 'recorded', lifecycle: refusedFanoutLifecycle() };
    }
    if (
      error instanceof StateError &&
      (error.code === 'busy' || error.code === 'conflict')
    ) {
      return { status: 'retry' };
    }
    if (error instanceof StateError && error.code === 'rule_failed') {
      const rejected = await input.store.load(
        'work.fanout_child' as ModelName,
        childRowId as RecordId,
      );
      if (rejected === null) {
        throw new Error('fanout test driver: child row vanished after a rejection.');
      }
      const rejectedData = readFanoutChildRow(rejected);
      if (
        rejectedData.state === 'completed' ||
        rejectedData.state === 'skipped' ||
        rejectedData.state === 'failed'
      ) {
        return { status: 'replayed' };
      }
      await pinTerminal(input, rejected, { kind: 'failed', reason: 'business-rejection' });
      return { status: 'recorded', lifecycle };
    }
    throw error;
  }
  return { status: 'recorded', lifecycle };
}

/**
 * Crash-observer for one child unit: reads every unit part (domain row,
 * history, attempt receipt, outbox, schedules, child outcome,
 * checkpoint cover) and reports `absent` (nothing committed),
 * `complete` (every part committed), or the exact partial split (which
 * must NEVER occur — any partial is an atomicity violation).
 */
export interface ObserveFanoutUnitInput {
  readonly store: StoragePort;
  readonly fanoutId: FanoutId;
  readonly child: FanoutChildId;
  /** Domain row the body updates (null when the body stages none). */
  readonly domain:
    | { readonly model: string; readonly id: string; readonly marker: string }
    | null;
  /** Attempt receipt identity parts (app/owner/principal/operation/operationId). */
  readonly receipt: {
    readonly app: string;
    readonly owner: string;
    readonly principal: string;
    readonly operation: string;
    readonly operationId: string;
  } | null;
  /** Outbox intent id the body stages (null when none). */
  readonly outboxIntentId: string | null;
  /** Schedule key the body stages (null when none). */
  readonly scheduleKey: string | null;
}

export type ObserveFanoutUnitOutcome =
  | { readonly verdict: 'absent' }
  | { readonly verdict: 'complete' }
  | { readonly verdict: 'partial'; readonly present: ReadonlyArray<string>; readonly missing: ReadonlyArray<string> };

export async function observeFanoutUnit(
  input: ObserveFanoutUnitInput,
): Promise<ObserveFanoutUnitOutcome> {
  const parts: Array<{ readonly name: string; readonly present: boolean }> = [];
  const childRowId = fanoutChildRowId(
    input.child.parentOccurrence,
    input.child.handler,
    input.child.recordId,
  );
  const childRow = await input.store.load('work.fanout_child' as ModelName, childRowId as RecordId);
  const childData = childRow === null ? null : readFanoutChildRow(childRow);
  const terminal =
    childData !== null &&
    (childData.state === 'completed' || childData.state === 'skipped' || childData.state === 'failed');
  parts.push({ name: 'outcome', present: terminal });
  const checkpointRow = await input.store.load(
    'work.fanout_checkpoint' as ModelName,
    input.fanoutId as RecordId,
  );
  const checkpoint = checkpointRow === null ? null : readFanoutCheckpointRow(checkpointRow);
  parts.push({
    name: 'checkpoint',
    present: checkpoint !== null && checkpoint.completed.includes(input.child.recordId),
  });
  if (input.domain !== null) {
    const domainRow = await input.store.load(
      input.domain.model as ModelName,
      input.domain.id as RecordId,
    );
    const marked =
      domainRow !== null &&
      (domainRow.data as Record<string, unknown>)[input.domain.marker] === true;
    parts.push({ name: 'domain', present: marked });
    const history = await input.store.historyFor(
      input.domain.model as ModelName,
      input.domain.id as RecordId,
    );
    parts.push({ name: 'history', present: history.length > 0 });
  }
  if (input.receipt !== null) {
    const receipt = await input.store.readReceipt({
      app: input.receipt.app,
      owner: input.receipt.owner,
      principal: input.receipt.principal,
      operation: input.receipt.operation as OperationName,
      operationId: input.receipt.operationId as OperationId,
    });
    parts.push({ name: 'receipt', present: receipt !== null });
  }
  if (input.outboxIntentId !== null) {
    const pending = await input.store.outboxPending();
    parts.push({
      name: 'outbox',
      present: pending.some((intent) => intent.intentId === input.outboxIntentId),
    });
  }
  if (input.scheduleKey !== null) {
    parts.push({
      name: 'schedule',
      present: (await input.store.scheduleGet(input.scheduleKey)) !== null,
    });
  }
  const present = parts.filter((part) => part.present).map((part) => part.name);
  const missing = parts.filter((part) => !part.present).map((part) => part.name);
  if (missing.length === 0) {
    return { verdict: 'complete' };
  }
  if (present.length === 0) {
    return { verdict: 'absent' };
  }
  return { verdict: 'partial', present, missing };
}
