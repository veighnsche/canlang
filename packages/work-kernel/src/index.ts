// W02.1 minimal neutral entry. Semantic decision modules (rows, retry,
// every, lifecycle, receipt, recovery, linkage) arrive in W02.2-W02.4;
// backend selection and ABI facts arrive in W03/W05.

export const WORK_KERNEL_VERSION = '0.1.0' as const;

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
