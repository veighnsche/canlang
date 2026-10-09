/**
 * Lane 03 S5: mutation barrel (INTERIM model table, write pipeline, CRUD).
 */

export {
  buildModelTable,
  isParentPathDefault,
  type InterimFieldDef,
  type InterimHook,
  type InterimHookContext,
  type InterimHookTransitive,
  type InterimHookOp,
  type InterimInvariant,
  type InterimInvariantView,
  type InterimLock,
  type InterimModelDef,
  type InterimParentPathDefault,
  type InterimRefDef,
  type ModelTable,
} from './models.js';
export {
  assertOwnerMutationHookContext,
  beginOwnerMutation,
  runMutationWrites,
  type OwnerMutationChange,
  type OwnerMutationHookContext,
  type OwnerMutationInput,
  type OwnerMutationQuery,
  type OwnerMutationReadView,
  type OwnerMutationSession,
  type OwnerMutationStageOptions,
  type OwnerMutationViews,
  type MutationWrite,
  type MutationWritesInput,
  type MutationWritesResult,
} from './pipeline.js';
export {
  CRUD_MAX_ID_LENGTH,
  crudDefs,
  crudExecute,
  type CrudDefs,
  type CrudDefsOptions,
  type CrudExecuteInput,
  type CrudOperationDef,
} from './crud.js';
export {
  bindOwnerModelPolicies,
  assertCheckedOwnerModelPolicies,
  type CheckedOwnerModelPolicies,
  type OwnerModelChange,
  type OwnerModelReadView,
  type OwnerModelPolicyViews,
  type OwnerModelPolicyBinding,
  type OwnerRuleContext,
} from './model-policies.js';
