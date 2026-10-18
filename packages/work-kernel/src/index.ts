// Public facts and explicit selected recovery whole-call facade. Other
// registered decision candidates retain their separate adoption gates.

export const WORK_KERNEL_VERSION = '0.1.0' as const;

export { createRecoveryPlanner } from '../bindings/recovery-planner.js';
export type { RecoveryPlanner, RecoveryPlannerOptions } from '../bindings/recovery-planner.js';
export { createWorkKernel, tsWorkKernel } from '../bindings/work-kernel.js';
export type { WorkKernel, WorkKernelOptions } from '../bindings/work-kernel.js';
export type { RecoverableRow, RecoveryPlan, RecoveryScanInput } from './recovery.js';

export {
  DECISION_PROFILES,
  PRESENCE_TAGS,
  TRANSPORT_REJECTIONS,
  TRANSPORT_VERSION,
  validateCount,
  validatePayloadRef,
  validateVersions,
} from './facts.js';
export type {
  ConditionalVersion,
  DecisionProfile,
  ErrorEnvelope,
  F64Bits,
  FactProvenance,
  OrderedFact,
  PayloadRef,
  PresenceTag,
  RangedCount,
  Rejection,
  ResultEnvelope,
  TransportRejection,
  TransportVersion,
  U32Range,
  Utf16Text,
  VersionDeclaration,
} from './facts.js';
