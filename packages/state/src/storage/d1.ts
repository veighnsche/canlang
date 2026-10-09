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
  checkLimit,
  checkSchedulesLimit,
  checkStagedRowsLimit,
  toReceipt,
  toOutboxIntent,
  toRetainedOutboxIntent,
  toScheduleEntry,
  toHistoryEntry,
  toInstalledSnapshot,
  toStagedRow,
  toMigrationProgress,
  toMigrationOutcome,
  toMigrationFailure,
  mergePublishedColumns,
} from './sqlite-codecs.js';
import type { RecordRow, ReceiptRow, OutboxRow, RetainedOutboxRow, ScheduleRow, HistoryRow, SnapshotRow, StagingRow, ProgressRow, OutcomeRow, FailureRow } from './sqlite-codecs.js';
import type { D1Database } from '@cloudflare/workers-types';
import type {
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
import {
  ALTER_OUTBOX_HANDLER_CONTRACT,
  FENCE_ROW_ID,
  SCHEMA_STATEMENTS,
  isDuplicateColumnError,
} from './schema.js';

/** Run each schema statement sequentially; idempotent, safe to re-run. */
export async function ensureSchema(db: D1Database): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    await db.exec(statement);
  }
  // B3: backfill the outbox contract column on pre-B3 databases; fresh
  // databases (and re-runs) already have it, so duplicate-column is fine.
  try {
    await db.exec(ALTER_OUTBOX_HANDLER_CONTRACT);
  } catch (error) {
    if (!isDuplicateColumnError(error)) {
      throw error;
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

async function readRevisionInner(db: D1Database): Promise<Revision> {
  const row = await db
    .prepare('SELECT revision FROM fence WHERE id = ?')
    .bind(FENCE_ROW_ID)
    .first<{ revision: number }>();
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

/** D1-backed `StoragePort`. Call `ensureSchema(db)` once before first use. */
export function createD1Storage(db: D1Database): StoragePort {
  return {
    async readRevision(): Promise<Revision> {
      return readRevisionInner(db);
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
      let sql = `SELECT ${RECORD_COLUMNS} FROM records WHERE model = ?`;
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
      const expected = batch.expectedRevision as number;
      if (!Number.isInteger(expected) || expected < 0) {
        throw new Error(`Invalid expectedRevision: ${JSON.stringify(batch.expectedRevision)}`);
      }
      // The fence INSERT below only proves `expected + 1` is fresh; it cannot
      // see a *future* expected revision skipping ahead and breaking the
      // density the scheme rests on. Reject those up front. Race-safe with
      // zero honest false-positives: revisions are monotonic, so an honest
      // `expected` (current at read time) can never exceed current later.
      const current = await readRevisionInner(db);
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
                'actor, at, change, "before", "after") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
                'occurrence_index, dispatch_guard, handler_contract, status, created_at) ' +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
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
        .prepare(`SELECT ${OUTBOX_COLUMNS}, status FROM outbox WHERE intent_id = ?`)
        .bind(intentId)
        .first<RetainedOutboxRow>();
      return row === null ? null : toRetainedOutboxIntent(row);
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

    async historyFor(model: ModelName, recordId: RecordId): Promise<ReadonlyArray<HistoryEntry>> {
      const result = await db
        .prepare(
          `SELECT ${HISTORY_COLUMNS} FROM history WHERE model = ? AND record_id = ? ` +
            // S6 review: `seq` tiebreaks duplicate versions (reachable only via
            // direct unstaged commits); fenced writes carry unique versions.
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
      // S7: ONE fenced batch: upsert live records from staged rows at their
      // target versions, insert history, dispose drops (remove + drop
      // history), and upsert progress — atomically. Existing live rows are
      // pre-read for metadata carry-over (same fence-serialized safety as
      // checkWriteVersions: a concurrent commit aborts our fence INSERT).
      await checkMigrationExpected(db, input.expectedRevision);
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
                'actor, at, change, "before", "after") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
                'actor, at, change, "before", "after") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
      try {
        await db.batch(statements);
      } catch (error) {
        throw await toCommitError(db, input.expectedRevision, error);
      }
      return { revision: next as Revision };
    },

    async flipInstalledSnapshot(input: FlipInstalledSnapshot): Promise<FlipResult> {
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
      if (input.snapshot === null) {
        if (installed === null) {
          return { revision: await readRevisionInner(db), flipped: false };
        }
      } else if (
        installed !== null &&
        installed.snapshot_id === input.snapshot.snapshotId &&
        installed.digest === input.snapshot.digest
      ) {
        return { revision: await readRevisionInner(db), flipped: false };
      }
      await checkMigrationExpected(db, input.expectedRevision);
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
}
