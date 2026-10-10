/**
 * Lane 03 S3: invocation/admission barrel.
 *
 * Role predicates stay in their single home at `policy/roles.js` and are
 * intentionally not re-exported here.
 */

export {
  OPERATION_ID_MAX_AGE_MS,
  OPERATION_ID_FUTURE_TOLERANCE_MS,
  operationIdTimestampMs,
  buildContext,
  type ClockPort,
  type RandomPort,
} from './context.js';
export {
  admit,
  receiptIdentityFor,
  type AdmittedCall,
  type ConflictServerOnly,
} from './admission.js';
export { stableStringify, hashInputs } from './replay.js';
export {
  bindScenarioReceiptFileProducer, observeScenarioReceiptFileAssignment,
  type ScenarioReceiptFileProducer, type ScenarioReceiptFileAssignmentLocator, type ScenarioReceiptFileAssignmentInput,
  observeScenarioReceiptDependency, observeScenarioReceiptIntrinsic, type ScenarioReceiptIntrinsicInput, selectScenarioReceiptReturn,
  beginScenarioReceiptMutation, observeScenarioInputComputedDefault, type ScenarioReceiptMutationInput,
  bindScenarioReceiptFrameworkProducer, stageScenarioReceiptSend, stageScenarioReceiptDelivery,
  bindScenarioReceiptCallProducer, invokeScenarioReceiptCall, assertScenarioReceiptCallExecution, type ScenarioReceiptCallSite,
  bindScenarioReceiptMembershipProducer, evaluateScenarioReceiptMembership,
  type ScenarioReceiptMembershipProducer, type ScenarioReceiptMembershipSite, type ScenarioReceiptMembershipHandle,
  type ScenarioReceiptCallProducer, type ScenarioReceiptCallFrame,
  bindScenarioReceiptQueryProducer, executeScenarioReceiptQuery, observeScenarioReceiptQueryDependency, bindScenarioReceiptQueryResult,
  type ScenarioReceiptQueryProducer, type ScenarioReceiptQueryResult, type ScenarioReceiptQuerySlot, type ScenarioReceiptQueryHandle,
  type ScenarioReceiptFrameworkProducer, type ScenarioReceiptSendProducerInput, type ScenarioReceiptSendStaging,
  type ScenarioReceiptMutationEffects, type ScenarioReceiptMutationSession,
  readScenarioReceiptAssociation, projectScenarioReceipt, type ProjectScenarioReceiptInput,
} from './scenario-receipt.js';
export {
  MAX_ADMISSION_ATTEMPTS,
  invoke,
  invokeRetainedReceiptOnly,
  type InvokeMutationInput,
  readGeneratedCrudAssociation,
  projectGeneratedCrudReceipt,
  type ExecuteHandler,
  type ExecutionEffects,
  type CommittedReceiptOutcome,
  type GeneratedCrudReceiptAssociation,
  type ProjectGeneratedCrudReceiptInput,
} from './invoke.js';
export {
  type InterimInputDef,
  type InterimOperationDef,
  type OperationRegistry,
} from './registry.js';
export { bindScenarioDispatchMembershipProducer,
  type ScenarioDispatchMembershipPorts, type ScenarioDispatchMembershipProducer,
  type ScenarioDispatchMembershipExecution, type ScenarioDispatchMembershipHandle,
} from './dispatch-membership.js';

export { projectReadScenarioQueryResult } from './scenario-receipt.js';
