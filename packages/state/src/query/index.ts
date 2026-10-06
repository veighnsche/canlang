/**
 * Lane 03 S4: authorized query barrel. Re-exports the engine API plus every
 * type needed to call it (engine inputs/results, policy table shapes, and the
 * S4 contract query types) so one import covers query callers.
 */

export {
  queryRecords,
  queryAggregate,
  type AggregateQueryResult,
  type BaseQueryInput,
  type OwnerRecordsInput,
  type QueryAggregateInput,
  type QueryCallerContext,
  type QueryRecordsInput,
  type ViewerRecordsInput,
} from './engine.js';
export type {
  ByContext,
  InterimGrant,
  InterimModelPolicy,
  PolicyTable,
} from '../policy/grants.js';
export type {
  FieldPath,
  AggregateOp,
  AggregateSpec,
  AggregateResult,
  ProjectedRecord,
  AuthorizedRecordsResult,
  AuthorityRowsResult,
} from '@canlang/contracts';
