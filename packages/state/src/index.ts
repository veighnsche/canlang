/**
 * @canlang/state entry: the one authoritative commit engine (internal package).
 * Generated programs import the thin `@canlang/stdlib` facade instead; that
 * assembly re-exports producer surfaces and must never be imported back here.
 */
export { stateCatalog, STATE_ENGINE_VERSION, type StateCatalog } from './catalog.js';
export { StateError, isStateError, ruleFailed } from './errors.js';
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
  DomainWrite,
  HistoryEntry,
  OutboxIntent,
  ScheduleOp,
  CommitBatch,
  CommitResult,
  FenceConflict,
  StoragePort,
} from '../../contracts/src/state.js';
