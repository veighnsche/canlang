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
} from './admission.js';
export { stableStringify, hashInputs } from './replay.js';
export {
  MAX_ADMISSION_ATTEMPTS,
  invoke,
  type ExecuteHandler,
  type ExecutionEffects,
} from './invoke.js';
export {
  type InterimInputDef,
  type InterimOperationDef,
  type OperationRegistry,
} from './registry.js';
