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
  CommitBatch,
  CommitResult,
  Revision,
  StoragePort,
} from '../../../contracts/src/state.js';
import type { ResolvedIdentity } from '../../../contracts/src/identity.js';
import type { MutationEnvelope, MutationResult } from '../../../contracts/src/wire.js';
import { storageToStateError } from '../errors.js';
import { invoke, type ExecuteHandler } from '../invocation/invoke.js';
import type { OperationRegistry } from '../invocation/registry.js';
import type { ClockPort } from '../invocation/context.js';
import type { MembershipReader } from '../policy/roles.js';

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
