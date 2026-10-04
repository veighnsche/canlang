/**
 * @canlang/state entry: the one authoritative commit engine (internal package).
 * Generated programs import the thin `@canlang/stdlib` facade instead; that
 * assembly re-exports producer surfaces and must never be imported back here.
 */
export { stateCatalog, STATE_ENGINE_VERSION, type StateCatalog } from './catalog.js';
export { StateError, isStateError, ruleFailed } from './errors.js';
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
} from './query/index.js';
export { STATE_CONTRACT_VERSION } from '../../contracts/src/state.js';
export type {
  StateErrorCode,
  RecordId,
  RecordVersion,
  Revision,
  OperationId,
  OperationName,
  ModelName,
  AdmissionKind,
  Principal,
  TeamScope,
  InvocationContext,
  ReceiptIdentity,
  ReceiptOutcome,
  Receipt,
  ReadAuthority,
  QueryPredicate,
  OrderTerm,
  QuerySpec,
  StoredRow,
  RecordParent,
  DeleteMode,
  DomainWrite,
  HistoryEntry,
  OutboxIntent,
  ScheduleOp,
  CommitBatch,
  CommitResult,
  FenceConflict,
  StoragePort,
  FieldPath,
  AggregateOp,
  AggregateSpec,
  AggregateResult,
  ProjectedRecord,
  AuthorizedRecordsResult,
  AuthorityRowsResult,
} from '../../contracts/src/state.js';
export {
  buildModelTable,
  isParentPathDefault,
  runMutationWrites,
  CRUD_MAX_ID_LENGTH,
  crudDefs,
  crudExecute,
  type InterimFieldDef,
  type InterimHook,
  type InterimHookContext,
  type InterimHookOp,
  type InterimInvariant,
  type InterimInvariantView,
  type InterimLock,
  type InterimModelDef,
  type InterimParentPathDefault,
  type InterimRefDef,
  type ModelTable,
  type MutationWrite,
  type MutationWritesInput,
  type MutationWritesResult,
  type CrudDefs,
  type CrudDefsOptions,
  type CrudExecuteInput,
  type CrudOperationDef,
} from './mutation/index.js';
export { checkJsonSafe, jsonClone } from './internal/json.js';
export {
  STAGING_MAX_ID_LENGTH,
  outboxIntentId,
  stageEffectsStaging,
  stageOutboxIntents,
  stageScheduleOps,
  type StagingContext,
} from './effects/staging.js';
export {
  createInvoker,
  createReadPort,
  createSystemRegistry,
  createTransactionPort,
  defineSystemCommand,
  outboxAckCommand,
  scheduleCancelCommand,
  scheduleReplaceCommand,
  type BoundInvoker,
  type InvokerInput,
  type InvokeArgs,
  type ReadAggregateArgs,
  type ReadOwnerRecordsArgs,
  type ReadPort,
  type ReadPortInput,
  type ReadViewerRecordsArgs,
  type SystemCommandContext,
  type SystemCommandDef,
  type SystemRegistry,
  type SystemRunContext,
  type SystemRunResult,
  type SystemStaging,
  type TransactionPort,
} from './ports/index.js';
export type { MembershipReader } from './policy/roles.js';
export type { PolicyTable } from './policy/grants.js';
export type { OperationRegistry } from './invocation/registry.js';
export type { ClockPort } from './invocation/context.js';
export type { ExecuteHandler } from './invocation/invoke.js';
