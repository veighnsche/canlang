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
  CommitBatch,
  CommitResult,
  DomainWrite,
  OutboxIntent,
  Revision,
  StoragePort,
} from '../../../contracts/src/state.js';
import type { ResolvedIdentity } from '../../../contracts/src/identity.js';
import type {
  MutationEnvelope,
  MutationResult,
  ReadEnvelope,
} from '../../../contracts/src/wire.js';
import { StateError, storageToStateError } from '../errors.js';
import { invoke, invokeRead, type ExecuteHandler } from '../invocation/invoke.js';
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
    });
}

/** Engine dependencies bound once at read-invoker creation. */
export interface ReadInvokerInput {
  readonly registry: OperationRegistry;
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
  return (args) =>
    invokeRead({
      registry: input.registry,
      policy: input.policy,
      store: input.store,
      memberships: input.memberships,
      envelope: args.envelope,
      identity: args.identity,
      ...(args.kind !== undefined ? { kind: args.kind } : {}),
      ...(args.trustedSource !== undefined ? { trustedSource: args.trustedSource } : {}),
    });
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
