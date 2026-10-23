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
  executeScenarioReceiptSourceCopy, readScenarioReceiptOwnerBounds, beginScenarioReceiptMutation, observeScenarioInputComputedDefault, type ScenarioReceiptMutationInput,
  executeScenarioReceiptEventNoticeFormat, materializeScenarioReceiptEventNoticeAudit,
  bindScenarioSourceRequireFrame, executeScenarioReceiptRequire, type ScenarioReceiptRequireSource, type ScenarioReceiptRequireObserver,
  executeScenarioReceiptEventDecision,
  executeScenarioReceiptSuccessRenewalDecision,
  executeScenarioReceiptTermDecision,
  executeScenarioReceiptLeaveRequestDecision,
  executeScenarioReceiptLeaveDecideDecision,
  executeScenarioReceiptReferRejectDecision,
  executeScenarioReceiptMemberRetryDecision,
  executeScenarioReceiptRentMovementRefundDecision,
  executeScenarioReceiptInvoiceCollectDecision,
  executeScenarioReceiptInvoiceIssueDecision,
  executeScenarioReceiptRentNoticeDecision,
  prepareObserveVenueScanQuery,
  bindScenarioReceiptFrameworkProducer, stageScenarioReceiptSend, stageScenarioReceiptDelivery,
  bindScenarioReceiptCallProducer, invokeScenarioReceiptCall, assertScenarioReceiptCallExecution, type ScenarioReceiptCallSite,
  noteDueWorkAdmission, type DueWorkAdmission,
  noteRetainedEventAdmission, type RetainedEventAdmission,
  noteRetainedGuardedHandlerAdmission, type RetainedGuardedHandlerAdmission,
  bindScenarioReceiptMembershipSource, type ScenarioReceiptMembershipSourceAssociation,
  bindScenarioReceiptMembershipProducer, evaluateScenarioReceiptMembership,
  bindScenarioReceiptSendMembershipProducer, evaluateScenarioReceiptSendMembership,
  type ScenarioReceiptMembershipProducer, type ScenarioReceiptMembershipSite, type ScenarioReceiptMembershipHandle,
  type ScenarioReceiptCallProducer, type ScenarioReceiptCallFrame,
  bindScenarioReceiptQueryProducer, executeScenarioReceiptQuery, observeScenarioReceiptQueryDependency, bindScenarioReceiptQueryResult,
  executeScenarioReceiptPurchaseAll, selectScenarioReceiptQueryFirstRow, bindScenarioReceiptQueryCount, bindScenarioReceiptQuerySelection, readScenarioReceiptQueryParentRow, readScenarioReceiptStoredReferenceRow, readScenarioReceiptNullableStoredReferenceRow,
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
  type ExecuteHandler,
  type ExecutionEffects,
  type CommittedReceiptOutcome,
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

export { bindScenarioSourceCreatedRoots, readScenarioSourceCreatedRoot, bindScenarioSourceLoopProducer, executeScenarioSourceLoop, executeScenarioSourceLoopItem, bindScenarioSourceSendDataProducer, executeScenarioSourceSendData, executeScenarioSourceSendQuery, type ScenarioSourceCreatedRoot, type ScenarioSourceBodyLoop, type ScenarioSourceBodyLoopPlan, type ScenarioSourceSendDataSource } from "./scenario-receipt.js";

export { bindScenarioSourceEmitDataProducer, executeScenarioSourceEmitData, executeScenarioSourceEmitQuery, consumeScenarioSourceEmitData, type ScenarioSourceEmitDataSource } from './scenario-receipt.js';

export { bindScenarioSourceLetDataProducer, executeScenarioSourceLetData, type ScenarioSourceLetDataSource } from "./scenario-receipt.js";

export {
  type EventNoticeAuditPlan,
  type EventDecisionPlan,
  type SuccessRenewalDecisionPlan,
  type TermDecisionPlan,
  type LeaveRequestDecisionPlan,
  type LeaveDecideDecisionPlan,
  type ReferRejectDecisionPlan,
  type MemberRetryDecisionPlan,
  type RentMovementRefundDecisionPlan,
  type InvoiceCollectDecisionPlan,
  type InvoiceIssueDecisionPlan,
  type RentNoticeDecisionPlan,
  type ObserveVenueDecisionPlan,
} from './scenario-plan.js';

export {
  readGeneratedCrudAssociation, projectGeneratedCrudReceipt,
  type GeneratedCrudReceiptAssociation, type ProjectGeneratedCrudReceiptInput,
} from './crud-receipt.js';
