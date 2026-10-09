/**
 * Lane 03 S6: fenced transaction port plus the bound mutation-invocation port.
 *
 * `createTransactionPort` is a single-shot fenced commit (NO retry — callers
 * decide); storage errors map via `storageToStateError` (fence conflicts
 * surface as retryable `busy`). `createInvoker` binds the canonical `invoke`
 * engine for L7/UI/MCP: same engine, less plumbing. Defined here in
 * `@canlang/state`; S8 re-exports the thin selection via stdlib.
 */

import type {
  AdmissionKind,
  AuthorizedRecordsResult,
  CanonicalModelDescriptor,
  CommitBatch,
  CommitResult,
  DomainWrite,
  MutationAdmissionMode,
  OutboxIntent,
  Revision,
  StoragePort,
} from '@canlang/contracts';
import type { ResolvedIdentity } from '@canlang/contracts';
import type {
  MutationEnvelope,
  MutationResult,
  ReadEnvelope,
} from '@canlang/contracts';
import { StateError, storageToStateError } from '../errors.js';
import {
  FANOUT_CHECKPOINT_MODEL,
  FANOUT_CHILD_MODEL,
  FANOUT_INTENT_MODEL,
  readFanoutCheckpointRow,
  readFanoutChildRow,
  readFanoutIntentRow,
} from '../fanout/tables.js';
import {
  invoke, invokeRead, invokeReadScenario, invokeReadPage,
  type ExecuteHandler, type ReadSelection,
  type ReadScenarioHandler, type ReadScenarioResult,
  type InvokeReadPageInput, type ViewerPageResult, type ViewerPageTransform,
} from '../invocation/invoke.js';
import type { InterimContainment } from '../mutation/models.js';
import type { OperationRegistry } from '../invocation/registry.js';
import type { ClockPort } from '../invocation/context.js';
import type { MembershipReader } from '../policy/roles.js';
import type { PolicyTable } from '../policy/grants.js';

/**
 * Single-shot fenced commit surface. The `expectedRevision` intersection
 * restates the fence requirement: every commit asserts it, and any failure
 * rolls the batch back. No retry happens here.
 */
export interface TransactionPort {
  commit(batch: CommitBatch & { expectedRevision: Revision }): Promise<CommitResult>;
  readRevision(): Promise<Revision>;
}

/** Create the single-shot transaction port over one store. */
export function createTransactionPort(input: { readonly store: StoragePort }): TransactionPort {
  return {
    commit: async (batch) => {
      try {
        return await input.store.commit(batch);
      } catch (error) {
        throw storageToStateError(error);
      }
    },
    readRevision: () => input.store.readRevision(),
  };
}

/** Engine dependencies bound once at invoker creation. */
export interface InvokerInput {
  readonly registry: OperationRegistry;
  readonly store: StoragePort;
  readonly memberships: MembershipReader;
  readonly clock: ClockPort;
}

/** Per-call invocation args: envelope, identity, app/source, and handler. */
export interface InvokeArgs {
  readonly envelope: MutationEnvelope;
  readonly identity: ResolvedIdentity;
  readonly app: string;
  readonly source: string;
  readonly kind?: AdmissionKind;
  readonly trustedSource?: string;
  readonly execute: ExecuteHandler;
  readonly admissionMode?: MutationAdmissionMode;
}

/** Bound mutation port: the canonical engine with dependencies fixed. */
export type BoundInvoker = (args: InvokeArgs) => Promise<MutationResult>;

/** Create the bound mutation port for L7/UI/MCP callers. */
export function createInvoker(input: InvokerInput): BoundInvoker {
  return (args) =>
    invoke({
      registry: input.registry,
      store: input.store,
      memberships: input.memberships,
      clock: input.clock,
      envelope: args.envelope,
      identity: args.identity,
      app: args.app,
      source: args.source,
      ...(args.kind !== undefined ? { kind: args.kind } : {}),
      ...(args.trustedSource !== undefined ? { trustedSource: args.trustedSource } : {}),
      execute: args.execute,
      ...(args.admissionMode === undefined ? {} : { admissionMode: args.admissionMode }),
    });
}

/** Engine dependencies bound once at read-invoker creation. */
export interface ReadInvokerInput {
  readonly registry: OperationRegistry;
  /** Checked model declarations supplied by the owning host, outside per-call selection. */
  readonly models?: ReadonlyArray<CanonicalModelDescriptor>;
  readonly policy: PolicyTable;
  readonly store: StoragePort;
  readonly memberships: MembershipReader;
}

/** Per-call read args: envelope, identity, and admission kind. */
export interface ReadInvokeArgs {
  readonly envelope: ReadEnvelope;
  readonly identity: ResolvedIdentity;
  readonly kind?: AdmissionKind;
  readonly trustedSource?: string;
  /** Internal viewer predicate/result bound; it does not change admission. */
  readonly selection?: ReadSelection;
}

/** Bound read port: canonical generated-read serving with dependencies fixed. */
export type BoundReadInvoker = (args: ReadInvokeArgs) => Promise<AuthorizedRecordsResult>;

/**
 * T17a: create the bound read port for L7 callers. T17b routes assembly
 * `invokeRead` here, retiring the interim direct `records()` path (direct
 * store queries with owner rows and no admission). Reads admit through the
 * registry def and serve viewer-projected records at the fence revision;
 * they commit nothing and receipt nothing.
 */
export function createReadInvoker(input: ReadInvokerInput): BoundReadInvoker {
  const models = input.models === undefined ? undefined : structuredClone(input.models);
  return (args) =>
    invokeRead({
      registry: input.registry,
      ...(models !== undefined ? { models } : {}),
      policy: input.policy,
      store: input.store,
      memberships: input.memberships,
      envelope: args.envelope,
      identity: args.identity,
      ...(args.kind !== undefined ? { kind: args.kind } : {}),
      ...(args.trustedSource !== undefined ? { trustedSource: args.trustedSource } : {}),
      ...(args.selection !== undefined ? { selection: args.selection } : {}),
    });
}

/** Per-call read source handler over the bound viewer dependencies. */
export interface ReadScenarioInvokeArgs extends Omit<ReadInvokeArgs, 'selection'> {
  readonly execute: ReadScenarioHandler;
}

export type BoundReadScenarioInvoker = (args: ReadScenarioInvokeArgs) => Promise<ReadScenarioResult>;

export function createReadScenarioInvoker(input: ReadInvokerInput): BoundReadScenarioInvoker {
  return (args) => invokeReadScenario({ ...args, ...input });
}

export interface ReadPageInvokerInput extends ReadInvokerInput {
  readonly containment: ReadonlyMap<import('@canlang/contracts').ModelName, InterimContainment>;
}

export type ReadPageInvokeArgs = Pick<InvokeReadPageInput, 'envelope' | 'identity' | 'selection' | 'generatedPredicate'>;

export interface BoundReadPageInvoker {
  (args: ReadPageInvokeArgs): Promise<ViewerPageResult>;
  <Result>(args: ReadPageInvokeArgs, transform: ViewerPageTransform<Result>): Promise<Result>;
}

/** Bound metadata is detached once; call selection cannot replace dependencies. */
export function createReadPageInvoker(input: ReadPageInvokerInput): BoundReadPageInvoker {
  const models = input.models === undefined ? undefined : structuredClone(input.models);
  const containment = new Map([...input.containment].map(([model, relation]) => [model, structuredClone(relation)]));
  function read(args: ReadPageInvokeArgs): Promise<ViewerPageResult>;
  function read<Result>(args: ReadPageInvokeArgs, transform: ViewerPageTransform<Result>): Promise<Result>;
  function read(args: ReadPageInvokeArgs, transform?: ViewerPageTransform<unknown>): Promise<unknown> {
    const call: InvokeReadPageInput = {
      registry: input.registry, policy: input.policy, store: input.store, memberships: input.memberships,
      ...(models === undefined ? {} : { models }), containment,
      envelope: args.envelope, identity: args.identity,
      ...(args.selection === undefined ? {} : { selection: args.selection }),
      ...(args.generatedPredicate === undefined ? {} : { generatedPredicate: args.generatedPredicate }),
    };
    return transform === undefined ? invokeReadPage(call) : invokeReadPage(call, transform);
  }
  return read;
}

/* -- T24a dispatch-join port (ADDITIVE; existing ports untouched). -- */

/**
 * Lane-4 dispatch-row model joined against staged outbox intents. A
 * STRUCTURAL literal, not an import: lane 3 must not runtime-import
 * lane 4 (`@canlang/work` owns the table), so the join matches rows by
 * model name plus the `intentId`/`guardVerdict` data fields. A
 * work-side conformance test pins this literal against
 * `WORK_DISPATCH_MODEL`; any rename must update both plus that test.
 */
export const DISPATCH_JOIN_MODEL = 'work.dispatch';

/**
 * One dispatch-row insert participating in the join: the row id plus the
 * linkage fields the assertion reads structurally.
 */
export interface DispatchJoinRow {
  readonly id: string;
  readonly intentId: string;
  /** Pinned stage-time guard verdict; false marks a recorded skip. */
  readonly guardVerdict: boolean | null;
}

function readDispatchJoinRow(write: DomainWrite & { readonly kind: 'insert' }): DispatchJoinRow {
  const data = write.row.data as Readonly<Record<string, unknown>> | null;
  const intentId = data?.['intentId'];
  const guardVerdict = data?.['guardVerdict'];
  if (typeof intentId !== 'string' || intentId === '') {
    throw new StateError(
      'validation',
      'Dispatch join: work.dispatch inserts must carry a non-empty data.intentId.',
    );
  }
  if (guardVerdict !== null && typeof guardVerdict !== 'boolean') {
    throw new StateError(
      'validation',
      'Dispatch join: work.dispatch data.guardVerdict must be boolean or null.',
    );
  }
  return { id: write.row.id as string, intentId, guardVerdict };
}

/**
 * Assert the dispatch-join linkage for one commit batch BEFORE it
 * touches the store (fail closed, `StateError` validation):
 *
 * - Every staged outbox intent has EXACTLY ONE `work.dispatch` insert
 *   with row id AND `data.intentId` equal to the intent id: the claim
 *   lifecycle row stages atomically with its intent, never apart.
 * - Every `work.dispatch` insert with a non-false pinned verdict has
 *   its outbox intent: a deliverable row without its L3 half is a
 *   broken join.
 * - `work.dispatch` inserts pinned guard-false with NO outbox intent
 *   are recorded skips (allowed, never dispatchable).
 * - Outbox intent ids and dispatch-row ids are each unique.
 *
 * Claim/recovery batches (conditional UPDATES, no outbox intents) pass
 * trivially: only inserts participate. Ordinary batches with neither
 * half pass trivially, so non-dispatch callers are unaffected.
 */
export function assertDispatchJoin(batch: CommitBatch): void {
  const intents: ReadonlyArray<OutboxIntent> = batch.outbox ?? [];
  const intentIds = new Set<string>();
  for (const intent of intents) {
    if (intentIds.has(intent.intentId)) {
      throw new StateError(
        'validation',
        `Dispatch join: duplicate outbox intent id ${JSON.stringify(intent.intentId)}.`,
      );
    }
    intentIds.add(intent.intentId);
  }
  const rowByIntent = new Map<string, DispatchJoinRow>();
  for (const write of batch.writes ?? []) {
    if (write.kind !== 'insert' || (write.model as string) !== DISPATCH_JOIN_MODEL) {
      continue;
    }
    const row = readDispatchJoinRow(write);
    if (row.id !== row.intentId) {
      throw new StateError(
        'validation',
        `Dispatch join: work.dispatch row id ${JSON.stringify(row.id)} ` +
          `must equal its data.intentId ${JSON.stringify(row.intentId)}.`,
      );
    }
    if (rowByIntent.has(row.intentId)) {
      throw new StateError(
        'validation',
        `Dispatch join: duplicate work.dispatch row for ${JSON.stringify(row.intentId)}.`,
      );
    }
    rowByIntent.set(row.intentId, row);
  }
  for (const intentId of intentIds) {
    if (!rowByIntent.has(intentId)) {
      throw new StateError(
        'validation',
        `Dispatch join: outbox intent ${JSON.stringify(intentId)} ` +
          'has no work.dispatch row in this batch.',
      );
    }
  }
  for (const row of rowByIntent.values()) {
    if (row.guardVerdict !== false && !intentIds.has(row.intentId)) {
      throw new StateError(
        'validation',
        `Dispatch join: work.dispatch row ${JSON.stringify(row.intentId)} ` +
          'has no outbox intent in this batch (only guard-false skips stage row-only).',
      );
    }
  }
}

/** Single-shot dispatch-join commit surface (no retry — callers decide). */
export interface DispatchJoinPort {
  commitJoin(batch: CommitBatch & { expectedRevision: Revision }): Promise<CommitResult>;
}

/**
 * Create the dispatch-join port over one store: linkage-asserted,
 * single-shot fenced commit. Storage errors map via
 * `storageToStateError` (fence conflicts surface as retryable `busy`),
 * mirroring `createTransactionPort`. T24b wires worker claim/recovery
 * execution through this port plus the fenced work commands.
 */
export function createDispatchJoinPort(input: { readonly store: StoragePort }): DispatchJoinPort {
  return {
    commitJoin: async (batch) => {
      assertDispatchJoin(batch);
      try {
        return await input.store.commit(batch);
      } catch (error) {
        throw storageToStateError(error);
      }
    },
  };
}

/* -- T34-F5 fanout child-join port (ADDITIVE; existing ports untouched). -- */

/**
 * One terminal child outcome update participating in the join: the
 * staged row's fanout scope plus its terminal record identity.
 */
export interface FanoutChildJoinOutcome {
  readonly fanoutId: string;
  readonly recordId: string;
}

/**
 * Assert the fanout child-unit linkage for one commit batch BEFORE it
 * touches the store (fail closed, `StateError` validation). The child
 * unit — child domain/history/replay/outbox/schedule effects plus the
 * terminal outcome plus the checkpoint advance — commits in ONE owner
 * transaction; this assertion pins the fanout halves together:
 *
 * - Row-identity linkage: every fanout insert/update stages a row whose
 *   id equals its derivation (intent id = cutoff+cohort, child id =
 *   parent+handler+record, checkpoint id = fanout id), validated
 *   through the state-owned F2 mirrors (closed states, closed causes,
 *   memberCount agreement).
 * - No fabricated completion: child inserts stage pending with zero
 *   attempts and null cause; checkpoint inserts carry an EMPTY
 *   completed set; intent rows are insert-only (the frozen set is never
 *   redefined); fanout rows are never removed (terminal records stand).
 * - Outcome/checkpoint co-commit: every TERMINAL child update's
 *   recordId appears in a SAME-FANOUT checkpoint update's staged
 *   completed set in the same batch, and every checkpoint update
 *   co-occurs with at least one SAME-FANOUT terminal child update. An outcome
 *   without checkpoint cover, or a checkpoint advance without its
 *   outcome, is refused — never acknowledged unfinished, never
 *   checkpointed apart.
 * - Non-terminal child updates (pending/running claim transitions,
 *   attempts bumps) and intent inserts pass under the row-identity
 *   rules only: claims are F3-driven and carry no completion.
 * - Batches with no fanout writes pass trivially, so non-fanout callers
 *   are unaffected.
 *
 * Cursor-only checkpoint maintenance (freeze final-chunk nulling,
 * recovery finish) commits through the PLAIN store port, never here:
 * this port is exclusively for outcome-bearing child units.
 */
export function assertFanoutChildJoin(batch: CommitBatch): void {
  const childIds = new Set<string>();
  const checkpointIds = new Set<string>();
  const terminalOutcomes: FanoutChildJoinOutcome[] = [];
  const checkpointCovers = new Map<string, Set<string>>();
  for (const write of batch.writes ?? []) {
    const model = write.model as string;
    if (model === FANOUT_INTENT_MODEL) {
      if (write.kind !== 'insert') {
        throw new StateError(
          'validation',
          'Fanout child join: work.fanout_intent rows are insert-only (the frozen set is never redefined).',
        );
      }
      readFanoutIntentRow(write.row);
      continue;
    }
    if (model === FANOUT_CHILD_MODEL) {
      if (write.kind === 'remove') {
        throw new StateError(
          'validation',
          'Fanout child join: work.fanout_child rows are never removed (terminal records stand).',
        );
      }
      if (write.kind === 'insert') {
        const data = readFanoutChildRow(write.row);
        if (data.state !== 'pending' || data.attempts !== 0) {
          throw new StateError(
            'validation',
            'Fanout child join: work.fanout_child inserts stage pending with zero attempts ' +
              '(no fabricated claims or outcomes).',
          );
        }
        if (childIds.has(data.childId)) {
          throw new StateError(
            'validation',
            `Fanout child join: duplicate work.fanout_child row ${JSON.stringify(data.childId)}.`,
          );
        }
        childIds.add(data.childId);
        continue;
      }
      const data = readFanoutChildRow(write.row);
      if (childIds.has(data.childId)) {
        throw new StateError(
          'validation',
          `Fanout child join: duplicate work.fanout_child row ${JSON.stringify(data.childId)}.`,
        );
      }
      childIds.add(data.childId);
      if (data.state === 'completed' || data.state === 'skipped' || data.state === 'failed') {
        terminalOutcomes.push({ fanoutId: data.fanoutId, recordId: data.recordId });
      }
      continue;
    }
    if (model === FANOUT_CHECKPOINT_MODEL) {
      if (write.kind === 'remove') {
        throw new StateError(
          'validation',
          'Fanout child join: work.fanout_checkpoint rows are never removed.',
        );
      }
      if (write.kind === 'insert') {
        const data = readFanoutCheckpointRow(write.row);
        if (data.completed.length > 0) {
          throw new StateError(
            'validation',
            'Fanout child join: work.fanout_checkpoint inserts carry an empty completed set ' +
              '(no fabricated completion).',
          );
        }
        if (checkpointIds.has(data.fanoutId)) {
          throw new StateError(
            'validation',
            `Fanout child join: duplicate work.fanout_checkpoint row ${JSON.stringify(data.fanoutId)}.`,
          );
        }
        checkpointIds.add(data.fanoutId);
        continue;
      }
      const data = readFanoutCheckpointRow(write.row);
      if (checkpointIds.has(data.fanoutId)) {
        throw new StateError(
          'validation',
          `Fanout child join: duplicate work.fanout_checkpoint row ${JSON.stringify(data.fanoutId)}.`,
        );
      }
      checkpointIds.add(data.fanoutId);
      checkpointCovers.set(data.fanoutId, new Set(data.completed));
      continue;
    }
  }
  const coveredFanoutIds = new Set<string>();
  for (const outcome of terminalOutcomes) {
    const cover = checkpointCovers.get(outcome.fanoutId);
    if (cover === undefined || !cover.has(outcome.recordId)) {
      throw new StateError(
        'validation',
        `Fanout child join: terminal outcome for ${JSON.stringify(outcome.recordId)} ` +
          'has no same-fanout checkpoint cover in this batch.',
      );
    }
    coveredFanoutIds.add(outcome.fanoutId);
  }
  for (const fanoutId of checkpointCovers.keys()) {
    if (!coveredFanoutIds.has(fanoutId)) {
      throw new StateError(
        'validation',
        `Fanout child join: checkpoint updates carry no terminal outcome for ${JSON.stringify(fanoutId)} in this batch ` +
          '(cursor-only maintenance uses the plain store port).',
      );
    }
  }
}

/** Single-shot fanout child-join commit surface (no retry — callers decide). */
export interface FanoutChildJoinPort {
  commitJoin(batch: CommitBatch & { expectedRevision: Revision }): Promise<CommitResult>;
}

/**
 * Create the fanout child-join port over one store: linkage-asserted,
 * single-shot fenced commit. Storage errors map via
 * `storageToStateError` (fence conflicts surface as retryable `busy`),
 * mirroring `createTransactionPort`. Outcome-bearing child units commit
 * here; freeze inserts and cursor-only maintenance use the plain port.
 */
export function createFanoutChildJoinPort(input: {
  readonly store: StoragePort;
}): FanoutChildJoinPort {
  return {
    commitJoin: async (batch) => {
      assertFanoutChildJoin(batch);
      try {
        return await input.store.commit(batch);
      } catch (error) {
        throw storageToStateError(error);
      }
    },
  };
}
