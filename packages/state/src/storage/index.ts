/**
 * Lane 03 S2: storage barrel. The D1 and DO modules each export their own
 * `ensureSchema`, aliased here per backend.
 */

export { FenceConflictError, StorageConstraintError } from './port.js';
export type { StorageConstraintKind, StoragePort } from './port.js';
export { createD1Storage, ensureSchema as ensureD1Schema } from './d1.js';
export { createDOStorage, ensureSchema as ensureDOSchema } from './durable-object.js';
export { createMemoryStorage, createTestMemoryStorage } from './memory.js';
export type { MemoryStoreProbe } from './memory.js';
export {
  FENCE_ROW_ID,
  INITIAL_REVISION,
  SCHEMA_SQL,
  SCHEMA_STATEMENTS,
} from './schema.js';
