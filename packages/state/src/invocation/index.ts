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
  bindScenarioReceiptReferenceProducer, bindScenarioReceiptModelResult, type ScenarioReceiptReferenceProducer,
  observeScenarioReceiptDependency, observeScenarioReceiptRowId, type ScenarioReceiptRowIdInput, observeScenarioReceiptIntrinsic, type ScenarioReceiptIntrinsicInput, selectScenarioReceiptReturn,
  beginScenarioReceiptMutation, observeScenarioInputComputedDefault, type ScenarioReceiptMutationInput,
  executeScenarioReceiptRequire, type ScenarioReceiptRequireSource, type ScenarioReceiptRequireObserver,
  executeScenarioReceiptEventDecision, type EventDecisionPlan,
  executeScenarioReceiptTermDecision, type TermDecisionPlan,
  executeScenarioReceiptLeaveRequestDecision, type LeaveRequestDecisionPlan,
  executeScenarioReceiptLeaveDecideDecision, type LeaveDecideDecisionPlan,
  executeScenarioReceiptReferRejectDecision, type ReferRejectDecisionPlan,
  executeScenarioReceiptMemberRetryDecision, type MemberRetryDecisionPlan,
  executeScenarioReceiptInvoiceOverdueDecision, type InvoiceOverdueDecisionPlan,
  executeScenarioReceiptRentMovementRefundDecision, type RentMovementRefundDecisionPlan,
  executeScenarioReceiptInvoiceCollectDecision, type InvoiceCollectDecisionPlan,
  executeScenarioReceiptInvoiceIssueDecision, type InvoiceIssueDecisionPlan,
  executeScenarioReceiptRentNoticeDecision, type RentNoticeDecisionPlan,
  prepareObserveVenueScanQuery,
  type ObserveVenueDecisionPlan,
  bindScenarioReceiptFrameworkProducer, stageScenarioReceiptSend, stageScenarioReceiptDelivery,
  bindScenarioReceiptCallProducer, invokeScenarioReceiptCall, assertScenarioReceiptCallExecution, type ScenarioReceiptCallSite,
  noteDueWorkAdmission, type DueWorkAdmission,
  noteRetainedEventAdmission, type RetainedEventAdmission,
  bindScenarioReceiptMembershipSource, type ScenarioReceiptMembershipSourceAssociation,
  bindScenarioReceiptMembershipProducer, evaluateScenarioReceiptMembership,
  bindScenarioReceiptSendMembershipProducer, evaluateScenarioReceiptSendMembership,
  type ScenarioReceiptMembershipProducer, type ScenarioReceiptMembershipSite, type ScenarioReceiptMembershipHandle,
  type ScenarioReceiptCallProducer, type ScenarioReceiptCallFrame,
  bindScenarioReceiptQueryProducer, executeScenarioReceiptQuery, observeScenarioReceiptQueryDependency, bindScenarioReceiptQueryResult,
  selectScenarioReceiptQueryFirstRow, bindScenarioReceiptQueryCount, bindScenarioReceiptQuerySelection, readScenarioReceiptQueryParentRow, readScenarioReceiptStoredReferenceRow, readScenarioReceiptNullableStoredReferenceRow,
  type ScenarioReceiptQueryProducer, type ScenarioReceiptAnyPredicate, type ScenarioReceiptQueryResult, type ScenarioReceiptQuerySlot, type ScenarioReceiptQueryHandle,
  type ScenarioReceiptFrameworkProducer, type ScenarioReceiptDeliveryOriginFrame, type ScenarioReceiptSendProducerInput, type ScenarioReceiptSendStaging,
  type ScenarioReceiptSendGuard, type ScenarioReceiptSendGuardFrame, type ScenarioReceiptSourceSendGuard,
  type ScenarioReceiptMutationEffects, type ScenarioReceiptMutationSession,
  readScenarioReceiptAssociation, projectScenarioReceipt, type ProjectScenarioReceiptInput,
} from './scenario-receipt.js';
export { checkScenarioReceiptMembershipSites } from './scenario-membership-plan.js';
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
