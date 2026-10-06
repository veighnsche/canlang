/**
 * Lane 03 S2: shared SQLite schema for the revision-fenced state store.
 *
 * Valid for both D1 and Durable Object SQLite. Every adapter commits through
 * the same fence protocol (DESIGN §7):
 *
 * 1. `INSERT INTO fence_log(revision, at, operation) VALUES (expected + 1, …)`.
 *    Revisions are dense from 1, so any stale `expected` revision collides
 *    with an existing `fence_log` row and the whole batch aborts with a SQL
 *    PRIMARY KEY error. This SQL-error assertion is the fence; a zero-row
 *    UPDATE would be insufficient.
 * 2. `UPDATE fence SET revision = expected + 1 WHERE id = 1`.
 * 3. All record/claim/history/receipt/outbox/schedule writes in the same
 *    atomic batch (D1 batch) or transaction (DO `transactionSync`).
 *
 * `records.data` holds the JSON-encoded domain fields only; reserved metadata
 * lives in columns. `owner` still takes the default (`''`); S5 persists
 * `StoredRow.parent` into `parent_model`/`parent_id` (absent reads as NULL),
 * so parent-scoped queries match positively.
 */

import type { Revision } from '@canlang/contracts';

/** The fence table holds exactly one row, always with id 1. */
export const FENCE_ROW_ID = 1;

/** Revision of a freshly initialized store, before any commit. */
export const INITIAL_REVISION: Revision = 0 as Revision;

/**
 * Ordered, idempotent schema statements. Each entry is exactly ONE statement
 * on ONE line (no trailing semicolon, no newlines): D1 `.exec()` and DO
 * `sql.exec()` accept a single statement per call, so adapters run these
 * sequentially, not as one script. Single-line is load-bearing: D1 `exec()`
 * rejects multi-line input with `incomplete input` on the local test backend.
 */
export const SCHEMA_STATEMENTS: ReadonlyArray<string> = [
  'CREATE TABLE IF NOT EXISTS fence(id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL)',
  'INSERT OR IGNORE INTO fence(id, revision) VALUES (1, 0)',
  'CREATE TABLE IF NOT EXISTS fence_log(revision INTEGER PRIMARY KEY, at INTEGER NOT NULL, operation TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS records(model TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, created_by TEXT NOT NULL, updated_by TEXT NOT NULL, archived_at INTEGER NULL, owner TEXT NOT NULL DEFAULT \'\', parent_model TEXT NULL, parent_id TEXT NULL, data TEXT NOT NULL, PRIMARY KEY(model, id))',
  'CREATE TABLE IF NOT EXISTS receipts(app TEXT NOT NULL, owner TEXT NOT NULL, principal TEXT NOT NULL, operation TEXT NOT NULL, operation_id TEXT NOT NULL, input_hash TEXT NOT NULL, resolved_defaults TEXT NOT NULL, outcome TEXT NOT NULL, committed_revision INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(app, owner, principal, operation, operation_id))',
  'CREATE TABLE IF NOT EXISTS history(seq INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT NOT NULL, record_id TEXT NOT NULL, version INTEGER NOT NULL, operation TEXT NOT NULL, operation_id TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL, change TEXT NOT NULL, "before" TEXT NULL, "after" TEXT NULL)',
  'CREATE TABLE IF NOT EXISTS outbox(intent_id TEXT PRIMARY KEY, operation TEXT NOT NULL, operation_id TEXT NOT NULL, target TEXT NOT NULL, arguments TEXT NOT NULL, occurrence_index INTEGER NOT NULL, dispatch_guard TEXT NULL, handler_contract TEXT NULL, status TEXT NOT NULL DEFAULT \'pending\', created_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS schedules("key" TEXT PRIMARY KEY, at INTEGER NOT NULL, event TEXT NOT NULL, payload TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS unique_claims(model TEXT NOT NULL, key_name TEXT NOT NULL, key_value TEXT NOT NULL, record_id TEXT NOT NULL, PRIMARY KEY(model, key_name, key_value))',
  'CREATE TABLE IF NOT EXISTS snapshots(owner TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL, digest TEXT NOT NULL, installed_revision INTEGER NOT NULL, installed_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS migration_staging(migration_id TEXT NOT NULL, target_model TEXT NOT NULL, record_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, parent TEXT NULL, converted INTEGER NOT NULL, created INTEGER NULL, created_by TEXT NULL, archived_at INTEGER NULL, PRIMARY KEY(migration_id, target_model, record_id))',
  'CREATE TABLE IF NOT EXISTS migration_progress(migration_id TEXT PRIMARY KEY, phase TEXT NOT NULL, staged_cursor TEXT NULL, publish_cursor TEXT NULL, updated_revision INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS migration_outcomes(migration_id TEXT NOT NULL, seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, intent_id TEXT NOT NULL, handler_contract TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS migration_failures(migration_id TEXT PRIMARY KEY, leg TEXT NOT NULL, prior_phase TEXT NOT NULL, staged_cursor TEXT NULL, publish_cursor TEXT NULL, error TEXT NOT NULL, at INTEGER NOT NULL, revision INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_migration_outcomes_migration ON migration_outcomes(migration_id)',
  'CREATE INDEX IF NOT EXISTS idx_records_owner_model ON records(owner, model)',
  'CREATE INDEX IF NOT EXISTS idx_history_model_record ON history(model, record_id)',
  'CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status)',
];

/**
 * Whole schema as one multi-statement script, derived from SCHEMA_STATEMENTS.
 * For documentation and migration tooling; adapters must run SCHEMA_STATEMENTS
 * sequentially because neither D1 `.exec()` nor DO `sql.exec()` runs scripts.
 */
export const SCHEMA_SQL: string = SCHEMA_STATEMENTS.map((s) => `${s};`).join('\n');

/**
 * B3: additive column for databases created before the outbox contract
 * field (CREATE TABLE IF NOT EXISTS never alters them). Adapters run this
 * best-effort from `ensureSchema` and swallow only the duplicate-column
 * error, so re-runs and fresh databases stay idempotent.
 */
export const ALTER_OUTBOX_HANDLER_CONTRACT: string =
  'ALTER TABLE outbox ADD COLUMN handler_contract TEXT NULL';

/** True when an ALTER failure is just "column already exists". */
export function isDuplicateColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('duplicate column name');
}
