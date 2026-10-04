/**
 * Lane 03 S5: mutation barrel (INTERIM model table, write pipeline, CRUD).
 */

export {
  buildModelTable,
  isParentPathDefault,
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
} from './models.js';
export {
  runMutationWrites,
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
