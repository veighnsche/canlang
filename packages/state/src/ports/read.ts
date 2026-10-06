/**
 * Lane 03 S6: bound read port — the lane-facing constrained query surface.
 *
 * Binds `policy`/`store`/`memberships` once so lane callers pass only
 * per-call args; authority is still chosen per call (viewer projected,
 * owner full). Defined here in `@canlang/state`; S8 re-exports the thin
 * selection via stdlib.
 */

import type {
  AuthorizedRecordsResult,
  AuthorityRowsResult,
  Receipt,
  ReceiptIdentity,
  Revision,
  StoragePort,
} from '@canlang/contracts';
import {
  queryAggregate as engineQueryAggregate,
  queryRecords as engineQueryRecords,
  type AggregateQueryResult,
  type OwnerRecordsInput,
  type PolicyTable,
  type QueryAggregateInput,
  type ViewerRecordsInput,
} from '../query/index.js';
// T32b eventual surface lives on the engine module directly (the query
// barrel is owned elsewhere; this port must not widen it).
import {
  queryEventualRecords as engineQueryEventualRecords,
  type EventualRecordsResult,
} from '../query/engine.js';
import type { MembershipReader } from '../policy/roles.js';

/** Engine dependencies bound once at port creation. */
export interface ReadPortInput {
  readonly policy: PolicyTable;
  readonly store: StoragePort;
  readonly memberships: MembershipReader;
}

/** Bound keys supplied at creation, omitted from per-call args. */
type ReadBoundKeys = 'policy' | 'store' | 'memberships';

/** Per-call viewer record args: the engine input minus bound dependencies. */
export type ReadViewerRecordsArgs = Omit<ViewerRecordsInput, ReadBoundKeys>;

/** Per-call owner record args: the engine input minus bound dependencies. */
export type ReadOwnerRecordsArgs = Omit<OwnerRecordsInput, ReadBoundKeys>;

/** Per-call aggregate args: the engine input minus bound dependencies. */
export type ReadAggregateArgs = Omit<QueryAggregateInput, ReadBoundKeys>;

/**
 * Bound read surface: authorized queries plus receipt/revision reads.
 *
 * TRUST BOUNDARY: `authority: 'owner'` performs no membership check — the
 * engine treats authority as a caller-supplied capability. Owner queries must
 * only be issued through admitted paths (canonical admission gates who may
 * claim owner authority); never expose this input directly to callers.
 */
export interface ReadPort {
  queryRecords(args: ReadViewerRecordsArgs): Promise<AuthorizedRecordsResult>;
  queryRecords(args: ReadOwnerRecordsArgs): Promise<AuthorityRowsResult>;
  queryAggregate(args: ReadAggregateArgs): Promise<AggregateQueryResult>;
  /**
   * T32b display-only eventual read: same authorized pipeline, enrolled
   * in NO fence. The marked wrapper can never feed authorization or a
   * spend (`requireAuthorizingRead` refuses it). Fenced reads pass
   * `fence` through `queryRecords`/`queryAggregate` args instead.
   */
  queryEventualRecords(
    args: ReadViewerRecordsArgs | ReadOwnerRecordsArgs,
  ): Promise<EventualRecordsResult>;
  readReceipt(identity: ReceiptIdentity): Promise<Receipt | null>;
  readRevision(): Promise<Revision>;
}

/** Bind one overload-preserving `queryRecords` over fixed dependencies. */
function bindQueryRecords(bound: {
  readonly policy: PolicyTable;
  readonly store: StoragePort;
  readonly memberships: MembershipReader;
}): ReadPort['queryRecords'] {
  function queryRecords(args: ReadViewerRecordsArgs): Promise<AuthorizedRecordsResult>;
  function queryRecords(args: ReadOwnerRecordsArgs): Promise<AuthorityRowsResult>;
  function queryRecords(
    args: ReadViewerRecordsArgs | ReadOwnerRecordsArgs,
  ): Promise<AuthorizedRecordsResult | AuthorityRowsResult> {
    // One arm: overload selection is compile-time; bound deps always win.
    return engineQueryRecords({ ...args, ...bound });
  }
  return queryRecords;
}

/** Create the bound read port over one policy, store, and membership reader. */
export function createReadPort(input: ReadPortInput): ReadPort {
  const bound = { policy: input.policy, store: input.store, memberships: input.memberships };
  return {
    queryRecords: bindQueryRecords(bound),
    queryAggregate: (args) => engineQueryAggregate({ ...args, ...bound }),
    queryEventualRecords: (args) => {
      if (args.authority === 'viewer') {
        return engineQueryEventualRecords({ ...args, ...bound, authority: 'viewer' });
      }
      return engineQueryEventualRecords({ ...args, ...bound, authority: 'owner' });
    },
    readReceipt: (identity) => input.store.readReceipt(identity),
    readRevision: () => input.store.readRevision(),
  };
}
