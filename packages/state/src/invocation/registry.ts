/**
 * Lane 03 S3: INTERIM engine-local operation registry.
 *
 * The L1 artifact carries no operation descriptors yet, so admission consumes
 * these interim descriptors. This module is replaced outright at the L1
 * codegen join; nothing outside admission may depend on its shape.
 */

import type { ModelName, OperationName } from '../../../contracts/src/state.js';
import type { ByPredicate } from '../policy/roles.js';

/**
 * INTERIM input descriptor. Scalar bounds arrive with S5/L2; S3 validates
 * presence, shape, and closedness only.
 */
export type InterimInputDef =
  | { type: 'record'; model: ModelName; versioned: boolean; required: boolean }
  | { type: 'scalar'; required: boolean };

/** INTERIM operation descriptor: admission policy plus input shapes. */
export interface InterimOperationDef {
  name: OperationName;
  kind: 'scenario' | 'crud.create' | 'crud.update' | 'crud.delete' | 'read';
  by: ByPredicate;
  inputs: Record<string, InterimInputDef>;
}

/** INTERIM registry: fully qualified operation name to descriptor. */
export type OperationRegistry = ReadonlyMap<string, InterimOperationDef>;
