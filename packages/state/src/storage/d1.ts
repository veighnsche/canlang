/**
 * Lane 03 S2: D1 storage adapter.
 *
 * Fence-correctness argument (DESIGN §7): D1 offers no interactive
 * read/branch/write transaction, so every commit is ONE `db.batch()` that
 * starts with `INSERT INTO fence_log(revision, …) VALUES (expected + 1, …)`.
 * Revisions are dense from 1, so a stale `expected` always collides with an
 * existing `fence_log` row; the batch then fails atomically and nothing is
 * applied. Any concurrent committer bumps the revision first and aborts our
 * fence INSERT, so the version pre-checks below cannot be silently
 * overwritten either: a row validated here can only change under a newer
 * revision, which fails the fence. Record UPDATEs/DELETEs are therefore
 * unconditional on version inside the batch itself (there is no post-batch
 * hook that could abort before the writes land); stale or missing rows fail
 * the batch up front with kind 'version', never as silent overwrites.
 */

import {
  RECORD_COLUMNS,
  RECEIPT_COLUMNS,
  OUTBOX_COLUMNS,
  SCHEDULE_COLUMNS,
  HISTORY_COLUMNS,
  SNAPSHOT_COLUMNS,
  STAGING_COLUMNS,
  PROGRESS_COLUMNS,
  OUTCOME_COLUMNS,
  FAILURE_COLUMNS,
  toStoredRow,
  compilePredicate,
  compileOrder,
  recoveryRecordTable,
  checkLimit,
  checkSchedulesLimit,
  checkStagedRowsLimit,
  toReceipt,
  toOutboxIntent,
  toRetainedOutboxIntent,
  toScheduleEntry,
  toHistoryEntry,
  captureHistoryRequest,
  compileBoundedHistory,
  toBoundedHistory,
  type BoundedHistoryRow,
  toInstalledSnapshot,
  toStagedRow,
  toMigrationProgress,
  toMigrationOutcome,
  toMigrationFailure,
  mergePublishedColumns,
  compileCohortIdentityPage,
  compileCohortRowLoad,
  compileCohortRowPage,
  captureCohortRequest,
  checkCohortIdentityRows,
  toCohortStoredRow,
  toCohortStoredRows,
  captureBoundedOutboxRequest, compileBoundedOutbox, toBoundedRetainedOutbox,
  type BoundedRetainedOutboxRow,
} from './sqlite-codecs.js';
import type { CohortRecordRow } from './sqlite-codecs.js';
import type { RecordRow, ReceiptRow, OutboxRow, RetainedOutboxRow, ScheduleRow, HistoryRow, SnapshotRow, StagingRow, ProgressRow, OutcomeRow, FailureRow } from './sqlite-codecs.js';
import type { D1Database } from '@cloudflare/workers-types';
import type {
  CohortIdentityPageRequest,
  CohortRowLoadRequest,
  CohortRowPageRequest,
  CohortAnchorFact,
  CommitBatch,
  CommitResult,
  DiscardStagedRows,
  FlipInstalledSnapshot,
  FlipResult,
  HistoryEntry,
  InstalledSnapshot,
  MigrationFailure,
  MigrationOutcome,
  MigrationProgress,
  ModelName,
  OutboxIntent,
  PublishMigrationChunk,
  QuerySpec,
  Receipt,
  ReceiptIdentity,
  RetainedOutboxIntent,
  RecordId,
  RecordMigrationFailure,
  Revision,
  ScheduleEntry,
  StageMigrationChunk,
  StagedRow,
  StagedRowCursor,
  StoredRow,
} from '@canlang/contracts';
import { FenceConflictError, StorageConstraintError, checkRecoveryInput } from './port.js';
import type { StoragePort } from './port.js';
import { FILE_GUARD_MAX_ROWS, bindFileFrameworkProducers, registerFileFrameworkStorage, checkedFileAuthority, checkFileBinding, checkFileFrameworkBinding, checkFileGuardSnapshots, fileGuardCopy, guardFileCommit, guardFilePublish, guardFileFlip, planFileInstall, planFileRetirement } from './file-retirement.js';
import { deepFreeze } from '../internal/own-data.js';
import type { FileGuardState, FileGuardRow, FileFrameworkBinding } from './file-retirement.js';
import type { FrameworkFileReferenceProducer, FileRetirementAuthority, FileReferenceStoragePort, FileReferencePublishMigrationChunk, FileReferenceFlipInstalledSnapshot, InstallFileReferenceInventory, InstalledFileReferenceInventory, RetireFinalizedFile, FinalizedFileRetirement, FinalizedFileRef } from '@canlang/contracts';
import {
  ALTER_OUTBOX_HANDLER_CONTRACT,
  ALTER_OUTBOX_COMMITTED_REVISION,
  ALTER_HISTORY_AUDIT_PROJECTION,
  ALTER_FILE_REFERENCE_OPAQUE_LIFETIMES,
  FENCE_ROW_ID,
  SCHEMA_STATEMENTS,
  isDuplicateColumnError,
} from './schema.js';

/** Run each schema statement sequentially; idempotent, safe to re-run. */
export async function ensureSchema(db: D1Database): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    await db.exec(statement);
  }
  // Add missing columns without reconstructing legacy publication facts.
  // A legacy original revision remains NULL; only new fenced inserts fill it.
  for (const alteration of [ALTER_OUTBOX_HANDLER_CONTRACT, ALTER_OUTBOX_COMMITTED_REVISION, ALTER_FILE_REFERENCE_OPAQUE_LIFETIMES, ALTER_HISTORY_AUDIT_PROJECTION]) {
    try {
      await db.exec(alteration);
    } catch (error) {
      if (!isDuplicateColumnError(error)) throw error;
    }
  }
}

/**
 * S7: validate a fenced migration write's expected revision the way commit
 * does: malformed values are a programmer bug (plain Error), future values
 * break revision density (FenceConflictError up front — the fence INSERT
 * below cannot see a skip ahead). Returns the current revision.
 */
async function checkMigrationExpected(
  db: D1Database,
  expectedRevision: Revision,
): Promise<Revision> {
  const expected = expectedRevision as number;
  if (!Number.isInteger(expected) || expected < 0) {
    throw new Error(`Invalid expectedRevision: ${JSON.stringify(expectedRevision)}`);
  }
  const current = await readRevisionInner(db);
  if (expected > (current as number)) {
    throw new FenceConflictError(expectedRevision, current);
  }
  return current;
}

/**
 * Enforce per-row `expectedVersion` for updates/removes before building the
 * batch. These reads run outside the batch (D1 has no interactive
 * transaction), but a concurrent commit between check and batch bumps the
 * revision and aborts our fence INSERT, so validated rows cannot be silently
 * overwritten. Stale or missing rows fail with kind 'version'.
 */
async function checkWriteVersions(db: D1Database, batch: CommitBatch): Promise<void> {
  for (const write of batch.writes) {
    if (write.kind !== 'update' && write.kind !== 'remove') {
      continue;
    }
    const row = await db
      .prepare('SELECT version, updated, updated_by FROM records WHERE model = ? AND id = ?')
      .bind(write.model as string, write.id as string)
      .first<{ version: number; updated: number; updated_by: string }>();
    const expected = write.expectedVersion as number;
    const where = `${write.model as string}/${write.id as string}`;
    if (row === null) {
      throw new StorageConstraintError(
        'version',
        `version mismatch for ${where}: expected ${expected}, row is missing`,
      );
    }
    if ((row.version as number) !== expected) {
      throw new StorageConstraintError(
        'version',
        `version mismatch for ${where}: expected ${expected}, stored ${row.version as number}`,
        {
          model: write.model as string,
          id: write.id as string,
          version: row.version as number,
          updated: row.updated as number,
          updatedBy: row.updated_by as string,
        },
      );
    }
  }
}

// Only fixed SQL/bindings and their private executor are reused. Every call
// still reads the live fence; neither revisions nor failures are cached.
const revisionQueries = new WeakMap<D1Database, () => Promise<{ revision: number } | null>>();
async function readRevisionInner(db: D1Database): Promise<Revision> {
  let read = revisionQueries.get(db);
  if (read === undefined) {
    const statement = db.prepare('SELECT revision FROM fence WHERE id = ?').bind(FENCE_ROW_ID);
    read = (statement.first<{ revision: number }>).bind(statement);
    revisionQueries.set(db, read);
  }
  const row = await read();
  if (row === null) {
    throw new Error('schema not initialized: fence row is missing (run ensureSchema first)');
  }
  return row.revision as Revision;
}

/** Map a failed-batch error to the storage error classes. Never throws. */
async function toCommitError(
  db: D1Database,
  expected: Revision,
  error: unknown,
): Promise<FenceConflictError | StorageConstraintError> {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('fence_log')) {
    let actual: Revision | null = null;
    try {
      actual = await readRevisionInner(db);
    } catch {
      actual = null;
    }
    return new FenceConflictError(expected, actual);
  }
  if (message.includes('unique_claims') || message.includes('outbox')) {
    return new StorageConstraintError('unique', message);
  }
  if (message.includes('receipts')) {
    return new StorageConstraintError('receipt_reuse', message);
  }
  return new StorageConstraintError('unknown', message);
}

/** Immutable preparation for one D1 file guard. The expensive derivation
 * (parse/copy/bind/checks/row-mapping) is a pure function of one coherent
 * batch read. Every call still executes the full live batch and compares
 * every read byte; the derivation is reused only when the live inputs are
 * proven identical, and any drift re-derives with complete checks. Entries
 * are retained per database connection and released with it. Retained
 * preparation is deep-frozen after all validations succeed, so no consumer
 * can mutate a shared hit into changed output; egress paths already copy.
 *
 * D1 digest domain: the eight statements are fixed text issued to one driver
 * in one batch, and the driver materializes every row object with identical
 * key order for identical queries. JSON.stringify over those row arrays is
 * therefore an exact equality test inside this domain (not a general claim
 * about stringify as byte equality): equal strings mean byte-identical
 * reads, and any content, order, row-count or limit difference changes the
 * digest and forces complete re-derivation. */
interface PreparedFileGuard {
  readonly binding: FileRetirementAuthority | undefined;
  readonly framework: FileFrameworkBinding;
  readonly raw: string;
  readonly state: FileGuardState;
  readonly rows: FileGuardRow[];
  readonly snapshots: InstalledSnapshot[];
}
const preparedFileGuards = new WeakMap<D1Database, PreparedFileGuard>();

/** One read-only D1 batch obtains a coherent revision and complete durable guard. */
async function readFileGuard(db: D1Database, binding: FileRetirementAuthority | undefined,
  framework: FileFrameworkBinding, maxRows = FILE_GUARD_MAX_ROWS) {
  const results = await db.batch([
    db.prepare('SELECT revision FROM fence WHERE id = 1'),
    db.prepare('SELECT authority, opaque_lifetimes FROM file_reference_authority WHERE id = 1'),
    db.prepare('SELECT installed FROM file_reference_inventories ORDER BY owner'),
    db.prepare('SELECT migration_id, inventory FROM file_reference_migrations ORDER BY migration_id'),
    db.prepare('SELECT model, id, migration_id FROM file_reference_publications ORDER BY model, id'),
    db.prepare('SELECT retirement FROM file_retirements ORDER BY ref'),
    db.prepare(`SELECT ${RECORD_COLUMNS} FROM records ORDER BY model, id LIMIT ?`).bind(maxRows + 1),
    db.prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM snapshots ORDER BY owner`),
  ]);
  const revisionRow = results[0]!.results[0] as { revision: number } | undefined;
  if (revisionRow === undefined) throw new Error('schema not initialized: fence row is missing (run ensureSchema first)');
  // The driver returns identical key order for identical queries, so this
  // digest is an exact byte comparison of everything derivation consumes.
  const raw = JSON.stringify(results.map(result => result.results));
  const prepared = preparedFileGuards.get(db);
  if (prepared !== undefined && prepared.binding === binding && prepared.framework === framework && prepared.raw === raw) {
    return { revision: revisionRow.revision as Revision, state: prepared.state, rows: prepared.rows, snapshots: prepared.snapshots };
  }
  const assignment = results[1]!.results[0] as { authority: string; opaque_lifetimes: string } | undefined;
  const state: FileGuardState = {
    authority: assignment === undefined ? null : checkedFileAuthority(JSON.parse(assignment.authority)),
    opaqueLifetimes: assignment === undefined ? [] : fileGuardCopy(JSON.parse(assignment.opaque_lifetimes)),
    inventories: results[2]!.results.map(raw => fileGuardCopy(JSON.parse((raw as { installed: string }).installed) as InstalledFileReferenceInventory)),
    migrations: results[3]!.results.map(raw => { const row = raw as { migration_id: string; inventory: string }; return { migrationId: row.migration_id, inventory: fileGuardCopy(JSON.parse(row.inventory)) }; }),
    publications: results[4]!.results.map(raw => { const row = raw as { model: string; id: string; migration_id: string }; return { model: row.model, id: row.id, migrationId: row.migration_id }; }),
    retirements: results[5]!.results.map(raw => fileGuardCopy(JSON.parse((raw as { retirement: string }).retirement) as FinalizedFileRetirement)),
  };
  checkFileBinding(state, binding);
  checkFileFrameworkBinding(state, framework);
  const rows: FileGuardRow[] = (state.authority === null && binding === undefined ? [] : results[6]!.results).map(raw => { const row = raw as RecordRow; return { model: row.model, row: toStoredRow(row) }; });
  const snapshots = results[7]!.results.map(raw => toInstalledSnapshot(raw as SnapshotRow));
  checkFileGuardSnapshots(state, snapshots);
  const output = { revision: revisionRow.revision as Revision, state, rows, snapshots };
  deepFreeze(state);
  deepFreeze(rows);
  deepFreeze(snapshots);
  preparedFileGuards.set(db, { binding, framework, raw, state, rows, snapshots });
  return output;
}
function requireFileRevision(expected: Revision, actual: Revision): void {
  if (!Number.isSafeInteger(expected) || expected < 0) throw new Error(`Invalid expectedRevision: ${JSON.stringify(expected)}`);
  if (expected !== actual) throw new FenceConflictError(expected, actual);
}
function captureFileInput<T>(input: T): { value?: T; error?: unknown } {
  try { return { value: fileGuardCopy(input) }; } catch (error) { return { error }; }
}
function guardedFileInput<T>(input: T, captured: { value?: T; error?: unknown }, guarded: boolean): T {
  if (!guarded) return input;
  if (captured.error !== undefined) throw captured.error;
  return captured.value!;
}
function fileGuardStatements(db: D1Database, state: FileGuardState) {
  const statements = [];
  if (state.authority !== null) {
    statements.push(db.prepare('INSERT OR IGNORE INTO file_reference_authority(id, authority, opaque_lifetimes) VALUES (1, ?, ?)')
      .bind(JSON.stringify(state.authority), JSON.stringify(state.opaqueLifetimes)));
    statements.push(db.prepare('UPDATE file_reference_authority SET opaque_lifetimes = ? WHERE id = 1')
      .bind(JSON.stringify(state.opaqueLifetimes)));
  }
  statements.push(db.prepare('DELETE FROM file_reference_inventories'), db.prepare('DELETE FROM file_reference_migrations'), db.prepare('DELETE FROM file_reference_publications'));
  for (const installed of state.inventories) statements.push(db.prepare('INSERT INTO file_reference_inventories(owner, installed) VALUES (?, ?)').bind(installed.inventory.owner, JSON.stringify(installed)));
  for (const migration of state.migrations) statements.push(db.prepare('INSERT INTO file_reference_migrations(migration_id, inventory) VALUES (?, ?)').bind(migration.migrationId, JSON.stringify(migration.inventory)));
  for (const row of state.publications) statements.push(db.prepare('INSERT INTO file_reference_publications(model, id, migration_id) VALUES (?, ?, ?)').bind(row.model, row.id, row.migrationId));
  return statements;
}
function commitFileRows(before: readonly FileGuardRow[], batch: CommitBatch): FileGuardRow[] {
  const rows = new Map(before.map(entry => [JSON.stringify([entry.model, entry.row.id]), entry]));
  for (const write of batch.writes) {
    const id = write.kind === 'insert' ? write.row.id : write.id;
    const key = JSON.stringify([write.model, id]);
    if (write.kind === 'remove') rows.delete(key);
    else if (write.kind === 'insert') rows.set(key, { model: write.model, row: write.row });
    else {
      const original = rows.get(key);
      // SQL UPDATE preserves the live identity and creation metadata.
      if (original !== undefined) rows.set(key, { model: write.model, row: {
        ...write.row, id: original.row.id, created: original.row.created, createdBy: original.row.createdBy,
      } });
    }
  }
  return [...rows.values()];
}

/** D1-backed `StoragePort`. Call `ensureSchema(db)` once before first use. */
export function createD1Storage(db: D1Database, authority: FileRetirementAuthority, producers?: readonly FrameworkFileReferenceProducer[]): FileReferenceStoragePort;
export function createD1Storage(db: D1Database, authority?: undefined, producers?: readonly FrameworkFileReferenceProducer[]): StoragePort;
export function createD1Storage(db: D1Database, authority?: FileRetirementAuthority,
  producers: readonly FrameworkFileReferenceProducer[] = []): StoragePort | FileReferenceStoragePort {
  const framework = bindFileFrameworkProducers(producers);
  const binding = authority === undefined ? undefined : checkedFileAuthority(authority);
  const storage: StoragePort = {
    cohortIdOrder: 'utf8-binary',
    async readRevision(): Promise<Revision> {
      return readRevisionInner(db);
    },
    async uniqueOwner(model, keyName, keyValue): Promise<RecordId | null> {
      const claim = await db.prepare('SELECT record_id FROM unique_claims WHERE model = ? AND key_name = ? AND key_value = ?')
        .bind(model, keyName, keyValue).first<{ record_id: string }>();
      return claim === null ? null : claim.record_id as RecordId;
    },

    async cohortIdentityPage(input: CohortIdentityPageRequest): Promise<ReadonlyArray<RecordId>> {
      input = captureCohortRequest(input, 'identity');
      const { sql, bindings } = compileCohortIdentityPage(input);
      const { expectedRevision, limit } = input;
      const before = await readRevisionInner(db);
      if (before !== expectedRevision) throw new FenceConflictError(expectedRevision, before);
      const rows = await db.prepare(sql).bind(...bindings).all<{ id: string | null }>();
      const after = await readRevisionInner(db);
      if (after !== expectedRevision) throw new FenceConflictError(expectedRevision, after);
      return checkCohortIdentityRows(rows.results, limit);
    },

    async cohortLoad(input: CohortRowLoadRequest): Promise<StoredRow | null> {
      input = captureCohortRequest(input, 'load');
      const { sql, bindings } = compileCohortRowLoad(input);
      const expectedRevision = input.expectedRevision;
      const before = await readRevisionInner(db);
      if (before !== expectedRevision) throw new FenceConflictError(expectedRevision, before);
      const row = await db.prepare(sql).bind(...bindings).first<CohortRecordRow>();
      const after = await readRevisionInner(db);
      if (after !== expectedRevision) throw new FenceConflictError(expectedRevision, after);
      return row === null ? null : toCohortStoredRow(row);
    },

    async cohortRowPage(input: CohortRowPageRequest): Promise<ReadonlyArray<StoredRow>> {
      input = captureCohortRequest(input, 'rows');
      const { sql, bindings } = compileCohortRowPage(input);
      const expectedRevision = input.expectedRevision;
      const before = await readRevisionInner(db);
      if (before !== expectedRevision) throw new FenceConflictError(expectedRevision, before);
      const rows = await db.prepare(sql).bind(...bindings).all<CohortRecordRow>();
      const after = await readRevisionInner(db);
      if (after !== expectedRevision) throw new FenceConflictError(expectedRevision, after);
      return toCohortStoredRows(rows.results);
    },

    async cohortAnchorFact(input: CohortRowLoadRequest): Promise<CohortAnchorFact> {
      input = captureCohortRequest(input, 'anchor');
      const { model, id, expectedRevision } = input;
      const before = await readRevisionInner(db);
      if (before !== expectedRevision) throw new FenceConflictError(expectedRevision, before);
      const row = await db.prepare("SELECT CASE WHEN EXISTS (SELECT 1 FROM records WHERE model = ? AND id = ?) THEN 'present' " +
        "WHEN EXISTS (SELECT 1 FROM history WHERE model = ? AND record_id = ? AND change IN ('remove', 'archive')) " +
        "THEN 'disposed' ELSE 'unknown' END AS fact").bind(model, id, model, id).first<{ fact: string }>();
      const after = await readRevisionInner(db);
      if (after !== expectedRevision) throw new FenceConflictError(expectedRevision, after);
      if (row?.fact !== 'present' && row?.fact !== 'disposed' && row?.fact !== 'unknown') throw new Error('Invalid cohort anchor fact.');
      return row.fact;
    },

    async load(model: ModelName, id: RecordId): Promise<StoredRow | null> {
      const row = await db
        .prepare(`SELECT ${RECORD_COLUMNS} FROM records WHERE model = ? AND id = ?`)
        .bind(model as string, id as string)
        .first<RecordRow>();
      return row === null ? null : toStoredRow(row);
    },

    async query(spec: QuerySpec): Promise<ReadonlyArray<StoredRow>> {
      const bindings: unknown[] = [spec.model as string];
      let sql = `SELECT ${RECORD_COLUMNS} FROM ${recoveryRecordTable(spec)} WHERE model = ?`;
      if (spec.parent !== undefined) {
        // S5: parent_* columns carry the linkage StoredRow.parent persists, so
        // this filter scopes positively; NULL-parent rows never match it.
        sql += ' AND parent_model = ? AND parent_id = ?';
        bindings.push(spec.parent.model as string, spec.parent.id as string);
      }
      // S2 excludes archived rows only; content expiry is a later slice.
      if (spec.archived !== 'include') {
        sql += ' AND archived_at IS NULL';
      }
      if (spec.where !== undefined) {
        sql += ` AND ${compilePredicate(spec.where, bindings)}`;
      }
      sql += ` ORDER BY ${compileOrder(spec.order)}`;
      if (spec.limit !== undefined) {
        checkLimit(spec.limit);
        sql += ' LIMIT ?';
        bindings.push(spec.limit);
      }
      const result = await db.prepare(sql).bind(...bindings).all<RecordRow>();
      return result.results.map(toStoredRow);
    },

    async commit(batch: CommitBatch): Promise<CommitResult> {
      const captured = captureFileInput(batch);
      const guard = await readFileGuard(db, binding, framework);
      batch = guardedFileInput(batch, captured, guard.state.authority !== null || binding !== undefined);
      let nextGuard = guard.state;
      if (guard.state.authority !== null) {
        requireFileRevision(batch.expectedRevision, guard.revision);
        nextGuard = guardFileCommit(guard.state, binding, guard.rows, commitFileRows(guard.rows, batch), framework);
      }
      const expected = batch.expectedRevision as number;
      if (!Number.isInteger(expected) || expected < 0) {
        throw new Error(`Invalid expectedRevision: ${JSON.stringify(batch.expectedRevision)}`);
      }
      // The fence INSERT below only proves `expected + 1` is fresh; it cannot
      // see a *future* expected revision skipping ahead and breaking the
      // density the scheme rests on. Reject those up front. Race-safe with
      // zero honest false-positives: revisions are monotonic, so an honest
      // `expected` (current at read time) can never exceed current later.
      const current = guard.revision;
      if (expected > (current as number)) {
        throw new FenceConflictError(batch.expectedRevision, current);
      }
      await checkWriteVersions(db, batch);
      const next = expected + 1;
      // fence_log/outbox timestamps come from the receipt when the batch
      // carries one; receipt-less batches (tests, bookkeeping) use now.
      const at = batch.receipt?.createdAt ?? Date.now();
      const operation =
        batch.receipt === null
          ? 'unknown'
          : (batch.receipt.identity.operation as string);
      const statements = [
        db
          .prepare('INSERT INTO fence_log(revision, at, operation) VALUES (?, ?, ?)')
          .bind(next, at, operation),
        db.prepare('UPDATE fence SET revision = ? WHERE id = ?').bind(next, FENCE_ROW_ID),
      ];
      if (nextGuard.authority !== null) {
        statements.push(db.prepare('UPDATE file_reference_authority SET opaque_lifetimes = ? WHERE id = 1')
          .bind(JSON.stringify(nextGuard.opaqueLifetimes)));
      }
      for (const write of batch.writes) {
        if (write.kind === 'insert') {
          statements.push(
            db
              .prepare(
                'INSERT INTO records(model, id, version, created, updated, created_by, ' +
                  'updated_by, archived_at, owner, parent_model, parent_id, data) ' +
                  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
              )
              .bind(
                write.model as string,
                write.row.id as string,
                write.row.version as number,
                write.row.created,
                write.row.updated,
                write.row.createdBy,
                write.row.updatedBy,
                write.row.archivedAt,
                '',
                // S5: persist row.parent (undefined counts as NULL, like null).
                (write.row.parent?.model as string | undefined) ?? null,
                (write.row.parent?.id as string | undefined) ?? null,
                JSON.stringify(write.row.data),
              ),
          );
        } else if (write.kind === 'update') {
          // Unconditional on version inside the batch: expectedVersion was
          // pre-validated above, and the fence INSERT serializes writers, so
          // a concurrent change aborts the whole batch first.
          statements.push(
            db
              .prepare(
                'UPDATE records SET version = ?, updated = ?, updated_by = ?, ' +
                  'archived_at = ?, parent_model = ?, parent_id = ?, data = ? ' +
                  'WHERE model = ? AND id = ?',
              )
              .bind(
                write.row.version as number,
                write.row.updated,
                write.row.updatedBy,
                write.row.archivedAt,
                // S5: persist whatever parent the row carries (the engine keeps
                // it immutable by carrying before.parent; see contracts).
                (write.row.parent?.model as string | undefined) ?? null,
                (write.row.parent?.id as string | undefined) ?? null,
                JSON.stringify(write.row.data),
                write.model as string,
                write.id as string,
              ),
          );
        } else {
          statements.push(
            db
              .prepare('DELETE FROM records WHERE model = ? AND id = ?')
              .bind(write.model as string, write.id as string),
          );
        }
      }
      // Releases run before claims so a key can move between records (or be
      // re-claimed) within one batch without a transient PK collision.
      for (const release of batch.uniqueReleases) {
        statements.push(
          db
            .prepare('DELETE FROM unique_claims WHERE model = ? AND key_name = ? AND key_value = ?')
            .bind(
              release.model as string,
              release.keyName,
              release.keyValue,
            ),
        );
      }
      for (const claim of batch.uniqueClaims) {
        statements.push(
          db
            .prepare(
              'INSERT INTO unique_claims(model, key_name, key_value, record_id) ' +
                'VALUES (?, ?, ?, ?)',
            )
            .bind(
              claim.model as string,
              claim.keyName,
              claim.keyValue,
              claim.recordId as string,
            ),
        );
      }
      for (const entry of batch.history) {
        statements.push(
          db
            .prepare(
              'INSERT INTO history(model, record_id, version, operation, operation_id, ' +
                'actor, at, change, "before", "after", audit_projection) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .bind(
              entry.model as string,
              entry.recordId as string,
              entry.version as number,
              entry.operation as string,
              entry.operationId as string,
              entry.actor,
              entry.at,
              entry.change,
              entry.before === null ? null : JSON.stringify(entry.before),
              entry.after === null ? null : JSON.stringify(entry.after),
              entry.auditProjection === undefined ? null : JSON.stringify(entry.auditProjection),
            ),
        );
      }
      if (batch.receipt !== null) {
        const receipt = batch.receipt;
        statements.push(
          db
            .prepare(
              'INSERT INTO receipts(app, owner, principal, operation, operation_id, ' +
                'input_hash, resolved_defaults, outcome, committed_revision, created_at) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .bind(
              receipt.identity.app,
              receipt.identity.owner,
              receipt.identity.principal,
              receipt.identity.operation as string,
              receipt.identity.operationId as string,
              receipt.inputHash,
              JSON.stringify(receipt.resolvedDefaults),
              JSON.stringify(receipt.outcome),
              receipt.committedRevision as number,
              receipt.createdAt,
            ),
        );
      }
      for (const intent of batch.outbox) {
        statements.push(
          db
            .prepare(
              'INSERT INTO outbox(intent_id, operation, operation_id, target, arguments, ' +
                'occurrence_index, dispatch_guard, handler_contract, status, created_at, committed_revision) ' +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
            )
            .bind(
              intent.intentId,
              intent.operation as string,
              intent.operationId as string,
              intent.target,
              JSON.stringify(intent.arguments),
              intent.occurrenceIndex,
              intent.dispatchGuard ?? null,
              intent.handlerContract ?? null,
              at,
              next,
            ),
        );
      }
      // S6: acks run AFTER the intent inserts in this same atomic batch, so
      // acking an id staged in this SAME batch marks it dispatched. One UPDATE
      // per id; unknown, dispatched, or skipped ids match zero rows (idempotent
      // no-op — dispatchers retry at-least-once). `undefined` counts as `[]`.
      for (const intentId of batch.outboxAck ?? []) {
        statements.push(
          db
            .prepare("UPDATE outbox SET status = 'dispatched' WHERE intent_id = ? AND status = 'pending'")
            .bind(intentId),
        );
      }
      for (const schedule of batch.schedules) {
        if (schedule.op === 'replace') {
          statements.push(
            db
              .prepare('INSERT OR REPLACE INTO schedules("key", at, event, payload) VALUES (?, ?, ?, ?)')
              .bind(
                schedule.key,
                schedule.at,
                schedule.event as string,
                JSON.stringify(schedule.payload),
              ),
          );
        } else {
          statements.push(
            db.prepare('DELETE FROM schedules WHERE "key" = ?').bind(schedule.key),
          );
        }
      }
      try {
        await db.batch(statements);
      } catch (error) {
        throw await toCommitError(db, batch.expectedRevision, error);
      }
      return { revision: next as Revision };
    },

    async readReceipt(identity: ReceiptIdentity): Promise<Receipt | null> {
      const row = await db
        .prepare(
          `SELECT ${RECEIPT_COLUMNS} FROM receipts WHERE app = ? AND owner = ? AND ` +
            'principal = ? AND operation = ? AND operation_id = ?',
        )
        .bind(
          identity.app,
          identity.owner,
          identity.principal,
          identity.operation as string,
          identity.operationId as string,
        )
        .first<ReceiptRow>();
      return row === null ? null : toReceipt(row);
    },

    async outboxPending(): Promise<ReadonlyArray<OutboxIntent>> {
      // S6: pending only, deterministic (created_at, intent_id) order —
      // identical ordering to the memory adapter's comparator.
      const result = await db
        .prepare(
          `SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE status = 'pending' ` +
            'ORDER BY created_at, intent_id',
        )
        .all<OutboxRow>();
      return result.results.map(toOutboxIntent);
    },

    async outboxGet(intentId: string): Promise<RetainedOutboxIntent | null> {
      const row = await db
        .prepare(`SELECT ${OUTBOX_COLUMNS}, status, committed_revision, created_at FROM outbox WHERE intent_id = ?`)
        .bind(intentId)
        .first<RetainedOutboxRow>();
      return row === null ? null : toRetainedOutboxIntent(row);
    },

    async outboxGetBounded(request): Promise<RetainedOutboxIntent | null> {
      const input = captureBoundedOutboxRequest(request);
      const { sql, bindings } = compileBoundedOutbox(input);
      const before = await readRevisionInner(db);
      if (before !== input.expectedRevision) throw new FenceConflictError(input.expectedRevision, before);
      const row = await db.prepare(sql).bind(...bindings).first<BoundedRetainedOutboxRow>();
      const after = await readRevisionInner(db);
      if (after !== input.expectedRevision) throw new FenceConflictError(input.expectedRevision, after);
      return row === null ? null : toBoundedRetainedOutbox(row);
    },

    async scheduleGet(key: string): Promise<ScheduleEntry | null> {
      const row = await db
        .prepare(`SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE "key" = ?`)
        .bind(key)
        .first<ScheduleRow>();
      return row === null ? null : toScheduleEntry(row);
    },

    async schedulesDue(now: number, limit: number): Promise<ReadonlyArray<ScheduleEntry>> {
      checkSchedulesLimit(limit);
      const result = await db
        .prepare(
          `SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE at <= ? ORDER BY at, "key" LIMIT ?`,
        )
        .bind(now, limit)
        .all<ScheduleRow>();
      return result.results.map(toScheduleEntry);
    },

    async historyReadBounded(request): Promise<ReadonlyArray<HistoryEntry>> {
      const input = captureHistoryRequest(request);
      const before = await readRevisionInner(db);
      if (before !== input.expectedRevision) throw new FenceConflictError(input.expectedRevision, before);
      const { sql, bindings } = compileBoundedHistory(input);
      const rows = await db.prepare(sql).bind(...bindings).all<BoundedHistoryRow>();
      const after = await readRevisionInner(db);
      if (after !== input.expectedRevision) throw new FenceConflictError(input.expectedRevision, after);
      return toBoundedHistory(rows.results, input.limit);
    },

    async historyFor(model: ModelName, recordId: RecordId): Promise<ReadonlyArray<HistoryEntry>> {
      const result = await db
        .prepare(
          `SELECT ${HISTORY_COLUMNS} FROM history WHERE model = ? AND record_id = ? ` +
            // Actual owner-session stages share a reserved version; seq
            // preserves their original insertion/source order.
            'ORDER BY version, seq',
        )
        .bind(model as string, recordId as string)
        .all<HistoryRow>();
      return result.results.map(toHistoryEntry);
    },

    async readInstalledSnapshot(owner: string): Promise<InstalledSnapshot | null> {
      // S7: null when the owner was never installed (fresh installs take a
      // separate path and never apply transitions).
      const row = await db
        .prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM snapshots WHERE owner = ?`)
        .bind(owner)
        .first<SnapshotRow>();
      return row === null ? null : toInstalledSnapshot(row);
    },

    async readMigrationProgress(migrationId: string): Promise<MigrationProgress | null> {
      // S7: null when the migration never staged anything.
      const row = await db
        .prepare(`SELECT ${PROGRESS_COLUMNS} FROM migration_progress WHERE migration_id = ?`)
        .bind(migrationId)
        .first<ProgressRow>();
      return row === null ? null : toMigrationProgress(row);
    },

    async readStagedRows(
      migrationId: string,
      cursor: StagedRowCursor | null,
      limit: number,
    ): Promise<ReadonlyArray<StagedRow>> {
      // S7: (model, record id) order after the cursor, capped at limit.
      checkStagedRowsLimit(limit);
      const bindings: unknown[] = [migrationId];
      let sql = `SELECT ${STAGING_COLUMNS} FROM migration_staging WHERE migration_id = ?`;
      if (cursor !== null) {
        sql += ' AND (target_model > ? OR (target_model = ? AND record_id > ?))';
        bindings.push(cursor.model, cursor.model, cursor.recordId);
      }
      sql += ' ORDER BY target_model, record_id LIMIT ?';
      bindings.push(limit);
      const result = await db.prepare(sql).bind(...bindings).all<StagingRow>();
      return result.results.map(toStagedRow);
    },

    async stageMigrationRows(input: StageMigrationChunk): Promise<CommitResult> {
      // S7: ONE fenced batch: upsert staged rows (idempotent restage by
      // migration/model/id key) plus the progress row, atomically. The fence
      // INSERT is the same serialization point as commit's.
      await checkMigrationExpected(db, input.expectedRevision);
      const next = (input.expectedRevision as number) + 1;
      const at = Date.now();
      const statements = [
        db
          .prepare('INSERT INTO fence_log(revision, at, operation) VALUES (?, ?, ?)')
          .bind(next, at, `migration:stage:${input.migrationId}`),
        db.prepare('UPDATE fence SET revision = ? WHERE id = ?').bind(next, FENCE_ROW_ID),
      ];
      for (const row of input.rows) {
        statements.push(
          db
            .prepare(
              'INSERT OR REPLACE INTO migration_staging(migration_id, target_model, ' +
                'record_id, version, data, parent, converted, created, created_by, ' +
                'archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .bind(
              input.migrationId,
              row.targetModel as string,
              row.recordId as string,
              row.version as number,
              JSON.stringify(row.data),
              row.parent === null ? null : JSON.stringify(row.parent),
              row.converted ? 1 : 0,
              row.created ?? null,
              row.createdBy ?? null,
              row.archivedAt ?? null,
            ),
        );
      }
      statements.push(
        db
          .prepare(
            'INSERT OR REPLACE INTO migration_progress(migration_id, phase, staged_cursor, ' +
              'publish_cursor, updated_revision) VALUES (?, ?, ?, ?, ?)',
          )
          .bind(
            input.migrationId,
            input.progress.phase,
            input.progress.stagedCursor === null
              ? null
              : JSON.stringify(input.progress.stagedCursor),
            input.progress.publishCursor === null
              ? null
              : JSON.stringify(input.progress.publishCursor),
            input.progress.updatedRevision as number,
          ),
      );
      try {
        await db.batch(statements);
      } catch (error) {
        throw await toCommitError(db, input.expectedRevision, error);
      }
      return { revision: next as Revision };
    },

    async publishMigrationChunk(input: PublishMigrationChunk): Promise<CommitResult> {
      const captured = captureFileInput(input);
      const guard = await readFileGuard(db, binding, framework);
      input = guardedFileInput(input, captured, guard.state.authority !== null || binding !== undefined);
      // S7: ONE fenced batch: upsert live records from staged rows at their
      // target versions, insert history, dispose drops (remove + drop
      // history), and upsert progress — atomically. Existing live rows are
      // pre-read for metadata carry-over (same fence-serialized safety as
      // checkWriteVersions: a concurrent commit aborts our fence INSERT).
      await checkMigrationExpected(db, input.expectedRevision);
      if (guard.state.authority !== null) requireFileRevision(input.expectedRevision, guard.revision);
      const next = (input.expectedRevision as number) + 1;
      const at = Date.now();
      const existing = new Map<string, RecordRow | null>();
      for (const row of input.rows) {
        const found = await db
          .prepare(`SELECT ${RECORD_COLUMNS} FROM records WHERE model = ? AND id = ?`)
          .bind(row.targetModel as string, row.recordId as string)
          .first<RecordRow>();
        existing.set(`${row.targetModel as string}\0${row.recordId as string}`, found);
      }
      const mergedRows = input.rows.map(row => {
        const merged = mergePublishedColumns(row, existing.get(`${row.targetModel as string}\0${row.recordId as string}`) ?? null, input.history);
        return { model: row.targetModel as string, row: { id: row.recordId, version: row.version, ...merged, parent: row.parent, data: row.data } };
      });
      const after = new Map(guard.rows.map(entry => [JSON.stringify([entry.model, entry.row.id]), entry]));
      for (const row of mergedRows) after.set(JSON.stringify([row.model, row.row.id]), row);
      for (const drop of input.drops) after.delete(JSON.stringify([drop.model, drop.recordId]));
      const guardedState = guardFilePublish(guard.state, binding, input.migrationId,
        (input as FileReferencePublishMigrationChunk).fileReferenceInventory, guard.rows, [...after.values()],
        mergedRows.map(entry => ({ model: entry.model, id: entry.row.id as string })),
        input.drops.map(drop => ({ model: drop.model as string, id: drop.recordId as string })), framework);
      const statements = [
        db
          .prepare('INSERT INTO fence_log(revision, at, operation) VALUES (?, ?, ?)')
          .bind(next, at, `migration:publish:${input.migrationId}`),
        db.prepare('UPDATE fence SET revision = ? WHERE id = ?').bind(next, FENCE_ROW_ID),
      ];
      for (const row of input.rows) {
        const key = `${row.targetModel as string}\0${row.recordId as string}`;
        const merged = mergePublishedColumns(row, existing.get(key) ?? null, input.history);
        statements.push(
          db
            .prepare(
              'INSERT OR REPLACE INTO records(model, id, version, created, updated, created_by, ' +
                'updated_by, archived_at, owner, parent_model, parent_id, data) ' +
                'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .bind(
              row.targetModel as string,
              row.recordId as string,
              row.version as number,
              merged.created,
              merged.updated,
              merged.createdBy,
              merged.updatedBy,
              merged.archivedAt,
              '',
              (row.parent?.model as string | undefined) ?? null,
              (row.parent?.id as string | undefined) ?? null,
              JSON.stringify(row.data),
            ),
        );
      }
      for (const entry of input.history) {
        statements.push(
          db
            .prepare(
              'INSERT INTO history(model, record_id, version, operation, operation_id, ' +
                'actor, at, change, "before", "after", audit_projection) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .bind(
              entry.model as string,
              entry.recordId as string,
              entry.version as number,
              entry.operation as string,
              entry.operationId as string,
              entry.actor,
              entry.at,
              entry.change,
              entry.before === null ? null : JSON.stringify(entry.before),
              entry.after === null ? null : JSON.stringify(entry.after),
              entry.auditProjection === undefined ? null : JSON.stringify(entry.auditProjection),
            ),
        );
      }
      for (const drop of input.drops) {
        statements.push(
          db
            .prepare('DELETE FROM records WHERE model = ? AND id = ?')
            .bind(drop.model as string, drop.recordId as string),
        );
        statements.push(
          db
            .prepare(
              'INSERT INTO history(model, record_id, version, operation, operation_id, ' +
                'actor, at, change, "before", "after", audit_projection) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .bind(
              drop.history.model as string,
              drop.history.recordId as string,
              drop.history.version as number,
              drop.history.operation as string,
              drop.history.operationId as string,
              drop.history.actor,
              drop.history.at,
              drop.history.change,
              drop.history.before === null ? null : JSON.stringify(drop.history.before),
              drop.history.after === null ? null : JSON.stringify(drop.history.after),
              drop.history.auditProjection === undefined ? null : JSON.stringify(drop.history.auditProjection),
            ),
        );
      }
      // Claim moves ride the same batch: releases before claims, mirroring
      // commit, so a model rename moves keys between models atomically.
      for (const release of input.uniqueReleases ?? []) {
        statements.push(
          db
            .prepare('DELETE FROM unique_claims WHERE model = ? AND key_name = ? AND key_value = ?')
            .bind(
              release.model as string,
              release.keyName,
              release.keyValue,
            ),
        );
      }
      for (const claim of input.uniqueClaims ?? []) {
        statements.push(
          db
            .prepare(
              'INSERT INTO unique_claims(model, key_name, key_value, record_id) ' +
                'VALUES (?, ?, ?, ?)',
            )
            .bind(
              claim.model as string,
              claim.keyName,
              claim.keyValue,
              claim.recordId as string,
            ),
        );
      }
      statements.push(
        db
          .prepare(
            'INSERT OR REPLACE INTO migration_progress(migration_id, phase, staged_cursor, ' +
              'publish_cursor, updated_revision) VALUES (?, ?, ?, ?, ?)',
          )
          .bind(
            input.migrationId,
            input.progress.phase,
            input.progress.stagedCursor === null
              ? null
              : JSON.stringify(input.progress.stagedCursor),
            input.progress.publishCursor === null
              ? null
              : JSON.stringify(input.progress.publishCursor),
            input.progress.updatedRevision as number,
          ),
      );
      if (guard.state.authority !== null) statements.push(...fileGuardStatements(db, guardedState));
      try {
        await db.batch(statements);
      } catch (error) {
        throw await toCommitError(db, input.expectedRevision, error);
      }
      return { revision: next as Revision };
    },

    async flipInstalledSnapshot(input: FlipInstalledSnapshot): Promise<FlipResult> {
      const captured = captureFileInput(input);
      const guard = await readFileGuard(db, binding, framework);
      input = guardedFileInput(input, captured, guard.state.authority !== null || binding !== undefined);
      // S7: idempotent activation. A null snapshot is an owner REMOVAL flip
      // (dropOwner): the pointer is deleted instead of installed; a removal
      // against an already-absent pointer is a no-op success. Otherwise ONE
      // fenced batch: install the pointer, remove the renamed-away owner
      // pointer, mark invalidated intents skipped, record outcomes, and mark
      // progress active — atomically.
      if (input.snapshot === null && input.renameFromOwner !== null) {
        throw new Error('flipInstalledSnapshot: a removal flip renames nothing.');
      }
      if (input.snapshot !== null && input.snapshot.owner !== input.owner) {
        throw new Error('flipInstalledSnapshot: snapshot.owner must equal the flip owner.');
      }
      const installed = await db
        .prepare(`SELECT ${SNAPSHOT_COLUMNS} FROM snapshots WHERE owner = ?`)
        .bind(input.owner)
        .first<SnapshotRow>();
      const guardedState = guardFileFlip(guard.state, binding, input as FileReferenceFlipInstalledSnapshot,
        guard.rows, ((input.expectedRevision as number) + 1) as Revision,
        installed === null ? null : toInstalledSnapshot(installed), framework);
      if (input.snapshot === null) {
        if (installed === null) {
          const revision = await readRevisionInner(db);
          if (guard.state.authority !== null) requireFileRevision(guard.revision, revision);
          return { revision, flipped: false };
        }
      } else if (
        installed !== null &&
        installed.snapshot_id === input.snapshot.snapshotId &&
        installed.digest === input.snapshot.digest
      ) {
        const revision = await readRevisionInner(db);
        if (guard.state.authority !== null) requireFileRevision(guard.revision, revision);
        return { revision, flipped: false };
      }
      await checkMigrationExpected(db, input.expectedRevision);
      if (guard.state.authority !== null) requireFileRevision(input.expectedRevision, guard.revision);
      const next = (input.expectedRevision as number) + 1;
      const at = Date.now();
      const snapshotStatement =
        input.snapshot === null
          ? db.prepare('DELETE FROM snapshots WHERE owner = ?').bind(input.owner)
          : db
              .prepare(
                'INSERT OR REPLACE INTO snapshots(owner, snapshot_id, digest, installed_revision, ' +
                  'installed_at) VALUES (?, ?, ?, ?, ?)',
              )
              .bind(
                input.snapshot.owner,
                input.snapshot.snapshotId,
                input.snapshot.digest,
                // The engine cannot know the flip revision pre-commit: record actual.
                next,
                input.snapshot.installedAt,
              );
      const statements = [
        db
          .prepare('INSERT INTO fence_log(revision, at, operation) VALUES (?, ?, ?)')
          .bind(next, at, `migration:flip:${input.migrationId}`),
        db.prepare('UPDATE fence SET revision = ? WHERE id = ?').bind(next, FENCE_ROW_ID),
        snapshotStatement,
      ];
      if (input.renameFromOwner !== null) {
        statements.push(
          db.prepare('DELETE FROM snapshots WHERE owner = ?').bind(input.renameFromOwner),
        );
      }
      for (const intentId of input.invalidatedIntentIds) {
        // Pending-only: unknown, dispatched, or skipped ids match zero rows
        // (idempotent no-op), and a dispatched intent is never rewritten.
        statements.push(
          db
            .prepare("UPDATE outbox SET status = 'skipped' WHERE intent_id = ? AND status = 'pending'")
            .bind(intentId),
        );
      }
      for (const outcome of input.outcomes) {
        statements.push(
          db
            .prepare(
              'INSERT INTO migration_outcomes(migration_id, kind, intent_id, handler_contract) ' +
                'VALUES (?, ?, ?, ?)',
            )
            .bind(
              input.migrationId,
              outcome.kind,
              outcome.intentId,
              outcome.handlerContract,
            ),
        );
      }
      // Upsert that preserves cursors: only phase + updated_revision advance.
      // Missing progress (a rowless migration) is created active.
      statements.push(
        db
          .prepare(
            'INSERT INTO migration_progress(migration_id, phase, staged_cursor, publish_cursor, ' +
              'updated_revision) VALUES (?, ?, NULL, NULL, ?) ' +
              'ON CONFLICT(migration_id) DO UPDATE SET phase = ?, updated_revision = ?',
          )
          .bind(input.migrationId, 'active', next, 'active', next),
      );
      if (guard.state.authority !== null) statements.push(...fileGuardStatements(db, guardedState));
      try {
        await db.batch(statements);
      } catch (error) {
        throw await toCommitError(db, input.expectedRevision, error);
      }
      return { revision: next as Revision, flipped: true };
    },

    async readMigrationOutcomes(migrationId: string): Promise<ReadonlyArray<MigrationOutcome>> {
      // S7: recorded skips in record (seq) order.
      const result = await db
        .prepare(
          `SELECT ${OUTCOME_COLUMNS} FROM migration_outcomes WHERE migration_id = ? ORDER BY seq`,
        )
        .bind(migrationId)
        .all<OutcomeRow>();
      return result.results.map(toMigrationOutcome);
    },

    async recordMigrationFailure(input: RecordMigrationFailure): Promise<CommitResult> {
      // B3: ONE fenced batch: failed mark plus the durable failure row.
      // Marking an active migration failed is a caller error.
      checkRecoveryInput(input.migrationId, input.leg);
      if (typeof input.error !== 'string' || input.error === '') {
        throw new Error('recordMigrationFailure: error must be a non-empty string.');
      }
      const current = await db
        .prepare(`SELECT ${PROGRESS_COLUMNS} FROM migration_progress WHERE migration_id = ?`)
        .bind(input.migrationId)
        .first<ProgressRow>();
      if (current !== null && current.phase === 'active') {
        throw new Error('recordMigrationFailure: migration is already active.');
      }
      await checkMigrationExpected(db, input.expectedRevision);
      const next = (input.expectedRevision as number) + 1;
      const at = Date.now();
      try {
        await db.batch([
          db
            .prepare('INSERT INTO fence_log(revision, at, operation) VALUES (?, ?, ?)')
            .bind(next, at, `migration:failed:${input.migrationId}`),
          db.prepare('UPDATE fence SET revision = ? WHERE id = ?').bind(next, FENCE_ROW_ID),
          db
            .prepare(
              'INSERT OR REPLACE INTO migration_progress(migration_id, phase, staged_cursor, ' +
                'publish_cursor, updated_revision) VALUES (?, ?, ?, ?, ?)',
            )
            .bind(
              input.migrationId,
              'failed',
              input.stagedCursor === null ? null : JSON.stringify(input.stagedCursor),
              input.publishCursor === null ? null : JSON.stringify(input.publishCursor),
              next,
            ),
          db
            .prepare(
              'INSERT OR REPLACE INTO migration_failures(migration_id, leg, prior_phase, ' +
                'staged_cursor, publish_cursor, error, at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .bind(
              input.migrationId,
              input.leg,
              input.priorPhase,
              input.stagedCursor === null ? null : JSON.stringify(input.stagedCursor),
              input.publishCursor === null ? null : JSON.stringify(input.publishCursor),
              input.error,
              input.at,
              next,
            ),
        ]);
      } catch (error) {
        throw await toCommitError(db, input.expectedRevision, error);
      }
      return { revision: next as Revision };
    },

    async discardStagedRows(input: DiscardStagedRows): Promise<CommitResult> {
      // B3: ONE fenced batch: staged rows plus the progress row go; the
      // failure record stays. Active progress refuses (no rollback past
      // the flip).
      checkRecoveryInput(input.migrationId);
      const current = await db
        .prepare(`SELECT ${PROGRESS_COLUMNS} FROM migration_progress WHERE migration_id = ?`)
        .bind(input.migrationId)
        .first<ProgressRow>();
      if (current !== null && current.phase === 'active') {
        throw new Error('discardStagedRows: migration is already active.');
      }
      await checkMigrationExpected(db, input.expectedRevision);
      const next = (input.expectedRevision as number) + 1;
      const at = Date.now();
      try {
        await db.batch([
          db
            .prepare('INSERT INTO fence_log(revision, at, operation) VALUES (?, ?, ?)')
            .bind(next, at, `migration:discard:${input.migrationId}`),
          db.prepare('UPDATE fence SET revision = ? WHERE id = ?').bind(next, FENCE_ROW_ID),
          db.prepare('DELETE FROM migration_staging WHERE migration_id = ?').bind(input.migrationId),
          db.prepare('DELETE FROM migration_progress WHERE migration_id = ?').bind(input.migrationId),
        ]);
      } catch (error) {
        throw await toCommitError(db, input.expectedRevision, error);
      }
      return { revision: next as Revision };
    },

    async readMigrationFailure(migrationId: string): Promise<MigrationFailure | null> {
      // B3: null when the migration never failed.
      const row = await db
        .prepare(`SELECT ${FAILURE_COLUMNS} FROM migration_failures WHERE migration_id = ?`)
        .bind(migrationId)
        .first<FailureRow>();
      return row === null ? null : toMigrationFailure(row);
    },
  };
  if (binding === undefined) return registerFileFrameworkStorage(storage, framework);
  // Reads and bookkeeping recheck the assignment and complete persisted framework inventory.
  const checkedStorage = Object.fromEntries(Object.entries(storage).map(([name, method]) => typeof method !== 'function' ? [name, method] : [name,
    async (...args: unknown[]) => {
      const captured = fileGuardCopy(args);
      await readFileGuard(db, binding, framework);
      return (method as (...values: unknown[]) => Promise<unknown>)(...captured);
    },
  ])) as unknown as StoragePort;
  const extension: FileReferenceStoragePort = {
    ...checkedStorage,
    fileRetirementAuthority: binding,
    async installFileReferenceInventory(request: InstallFileReferenceInventory): Promise<CommitResult> {
      const input = fileGuardCopy(request);
      const guard = await readFileGuard(db, binding, framework);
      requireFileRevision(input.expectedRevision, guard.revision);
      const next = ((input.expectedRevision as number) + 1) as Revision;
      const plan = planFileInstall(guard.state, binding, input, guard.snapshots, guard.rows, next, framework);
      if (!plan.changed) {
        requireFileRevision(guard.revision, await readRevisionInner(db));
        return { revision: guard.revision };
      }
      try {
        await db.batch([
          db.prepare('INSERT INTO fence_log(revision, at, operation) VALUES (?, ?, ?)').bind(next, Date.now(), 'file:install'),
          db.prepare('UPDATE fence SET revision = ? WHERE id = ?').bind(next, FENCE_ROW_ID),
          db.prepare('INSERT OR REPLACE INTO snapshots(owner, snapshot_id, digest, installed_revision, installed_at) VALUES (?, ?, ?, ?, ?)')
            .bind(plan.snapshot.owner, plan.snapshot.snapshotId, plan.snapshot.digest, plan.snapshot.installedRevision, plan.snapshot.installedAt),
          ...fileGuardStatements(db, plan.state),
        ]);
      } catch (error) { throw await toCommitError(db, input.expectedRevision, error); }
      return { revision: next };
    },
    async readFileReferenceInventory(owner: string): Promise<InstalledFileReferenceInventory | null> {
      const checkedOwner = fileGuardCopy(owner);
      const guard = await readFileGuard(db, binding, framework);
      return fileGuardCopy(guard.state.inventories.find(item => item.inventory.owner === checkedOwner) ?? null);
    },
    async retireFinalizedFile(request: RetireFinalizedFile): Promise<FinalizedFileRetirement> {
      const input = fileGuardCopy(request);
      if (!Number.isSafeInteger(input.maxRows) || input.maxRows < 1) throw new StorageConstraintError('reference', 'File retirement: positive complete census bound required');
      const guard = await readFileGuard(db, binding, framework, input.maxRows);
      if (!guard.state.retirements.some(fact => fact.file.ref === input.file.ref)) requireFileRevision(input.expectedRevision, guard.revision);
      const next = ((guard.revision as number) + 1) as Revision;
      const plan = planFileRetirement(guard.state, binding, input, guard.rows, next, framework);
      if (!plan.fresh) {
        requireFileRevision(guard.revision, await readRevisionInner(db));
        return fileGuardCopy(plan.fact);
      }
      requireFileRevision(input.expectedRevision, guard.revision);
      try {
        await db.batch([
          db.prepare('INSERT INTO fence_log(revision, at, operation) VALUES (?, ?, ?)').bind(next, input.atMs, 'file:retire'),
          db.prepare('UPDATE fence SET revision = ? WHERE id = ?').bind(next, FENCE_ROW_ID),
          db.prepare('INSERT INTO file_retirements(ref, retirement) VALUES (?, ?)').bind(plan.fact.file.ref, JSON.stringify(plan.fact)),
        ]);
      } catch (error) { throw await toCommitError(db, input.expectedRevision, error); }
      return fileGuardCopy(plan.fact);
    },
    async readFinalizedFileRetirement(ref: FinalizedFileRef): Promise<FinalizedFileRetirement | null> {
      const checkedRef = fileGuardCopy(ref);
      const guard = await readFileGuard(db, binding, framework);
      return fileGuardCopy(guard.state.retirements.find(fact => fact.file.ref === checkedRef) ?? null);
    },
    publishMigrationChunk: checkedStorage.publishMigrationChunk,
    flipInstalledSnapshot: checkedStorage.flipInstalledSnapshot,
  };
  return registerFileFrameworkStorage(extension, framework);
}
