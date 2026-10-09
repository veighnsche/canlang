/**
 * Lane 03 S2: Durable Object SQLite storage adapter.
 *
 * Same SQL and fence semantics as the D1 adapter, executed through the
 * synchronous `storage.sql` API (`SqlStorage.exec(query, ...bindings)` takes
 * exactly one statement per call and returns a cursor). Commit atomicity
 * comes from `storage.transactionSync`, which rolls the transaction back when
 * its closure throws; environments without it are rejected loudly. The fence-correctness
 * argument is the same as for D1 (see d1.ts): the leading `fence_log` INSERT
 * turns any stale `expectedRevision` into a PRIMARY KEY error that aborts the
 * whole transaction. Record UPDATEs/DELETEs stay unconditional on version
 * inside the transaction itself; stale or missing rows fail up front with
 * kind 'version' during the pre-commit version check.
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
import type { DurableObjectStorage } from '@cloudflare/workers-types';
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
export async function ensureSchema(storage: DurableObjectStorage): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    storage.sql.exec(statement);
  }
  // B3: backfill the outbox contract column on pre-B3 databases; fresh
  // databases (and re-runs) already have it, so duplicate-column is fine.
  try {
    storage.sql.exec(ALTER_OUTBOX_HANDLER_CONTRACT);
  } catch (error) {
    if (!isDuplicateColumnError(error)) {
      throw error;
    }
  }
}

/**
 * Run `fn` atomically. `transactionSync` is the documented DO primitive and
 * the only supported path: every workerd/miniflare environment provides it,
 * and an untestable BEGIN/COMMIT fallback must not silently carry atomicity.
 */
function transact<T>(storage: DurableObjectStorage, fn: () => T): T {
  if (typeof storage.transactionSync !== 'function') {
    throw new Error('Durable Object storage requires transactionSync for atomic commits');
  }
  return storage.transactionSync(fn);
}

/**
 * S7: validate a fenced migration write's expected revision the way commit
 * does: malformed values are a programmer bug (plain Error), future values
 * break revision density (FenceConflictError up front — the fence INSERT
 * below cannot see a skip ahead). Runs synchronously with zero awaits, so
 * there is no check-to-transaction interleaving window.
 */
function checkMigrationExpected(
  storage: DurableObjectStorage,
  expectedRevision: Revision,
): void {
  const expected = expectedRevision as number;
  if (!Number.isInteger(expected) || expected < 0) {
    throw new Error(`Invalid expectedRevision: ${JSON.stringify(expectedRevision)}`);
  }
  const current = readRevisionInner(storage);
  if (expected > (current as number)) {
    throw new FenceConflictError(expectedRevision, current);
  }
}

/**
 * Enforce per-row `expectedVersion` for updates/removes before opening the
 * transaction. Stale or missing rows fail with kind 'version'. There is no
 * check-to-transaction interleaving window: this runs fully synchronously
 * with zero awaits, and the fence INSERT inside the transaction aborts on
 * any revision the check did not see.
 */
function checkWriteVersions(storage: DurableObjectStorage, batch: CommitBatch): void {
  for (const write of batch.writes) {
    if (write.kind !== 'update' && write.kind !== 'remove') {
      continue;
    }
    const rows = storage.sql
      .exec<{ version: number; updated: number; updated_by: string }>(
        'SELECT version, updated, updated_by FROM records WHERE model = ? AND id = ?',
        write.model as string,
        write.id as string,
      )
      .toArray();
    const row = rows[0] ?? null;
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

function readRevisionInner(storage: DurableObjectStorage): Revision {
  const rows = storage.sql
    .exec<{ revision: number }>('SELECT revision FROM fence WHERE id = ?', FENCE_ROW_ID)
    .toArray();
  const row = rows[0] ?? null;
  if (row === null) {
    throw new Error('schema not initialized: fence row is missing (run ensureSchema first)');
  }
  return row.revision as Revision;
}

/** Map a failed-transaction error to the storage error classes. Never throws. */
function toCommitError(
  storage: DurableObjectStorage,
  expected: Revision,
  error: unknown,
): FenceConflictError | StorageConstraintError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('fence_log')) {
    let actual: Revision | null = null;
    try {
      actual = readRevisionInner(storage);
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

/** One parameterized statement inside a commit transaction. */
interface PlannedStatement {
  readonly sql: string;
  readonly bindings: ReadonlyArray<unknown>;
}

function planCommit(batch: CommitBatch, next: number, at: number, operation: string): PlannedStatement[] {
  const statements: PlannedStatement[] = [
    {
      sql: 'INSERT INTO fence_log(revision, at, operation) VALUES (?, ?, ?)',
      bindings: [next, at, operation],
    },
    {
      sql: 'UPDATE fence SET revision = ? WHERE id = ?',
      bindings: [next, FENCE_ROW_ID],
    },
  ];
  for (const write of batch.writes) {
    if (write.kind === 'insert') {
      statements.push({
        sql:
          'INSERT INTO records(model, id, version, created, updated, created_by, ' +
          'updated_by, archived_at, owner, parent_model, parent_id, data) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        bindings: [
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
        ],
      });
    } else if (write.kind === 'update') {
      // Unconditional on version inside the transaction: expectedVersion was
      // pre-validated before it opened, and the fence INSERT serializes
      // writers, so a concurrent change aborts the whole transaction first.
      statements.push({
        sql:
          'UPDATE records SET version = ?, updated = ?, updated_by = ?, ' +
          'archived_at = ?, parent_model = ?, parent_id = ?, data = ? ' +
          'WHERE model = ? AND id = ?',
        bindings: [
          write.row.version as number,
          write.row.updated,
          write.row.updatedBy,
          write.row.archivedAt,
          // S5: persist whatever parent the row carries (the engine keeps it
          // immutable by carrying before.parent; see contracts).
          (write.row.parent?.model as string | undefined) ?? null,
          (write.row.parent?.id as string | undefined) ?? null,
          JSON.stringify(write.row.data),
          write.model as string,
          write.id as string,
        ],
      });
    } else {
      statements.push({
        sql: 'DELETE FROM records WHERE model = ? AND id = ?',
        bindings: [write.model as string, write.id as string],
      });
    }
  }
  // Releases run before claims so a key can move between records (or be
  // re-claimed) within one batch without a transient PK collision.
  for (const release of batch.uniqueReleases) {
    statements.push({
      sql: 'DELETE FROM unique_claims WHERE model = ? AND key_name = ? AND key_value = ?',
      bindings: [release.model as string, release.keyName, release.keyValue],
    });
  }
  for (const claim of batch.uniqueClaims) {
    statements.push({
      sql:
        'INSERT INTO unique_claims(model, key_name, key_value, record_id) ' +
        'VALUES (?, ?, ?, ?)',
      bindings: [
        claim.model as string,
        claim.keyName,
        claim.keyValue,
        claim.recordId as string,
      ],
    });
  }
  for (const entry of batch.history) {
    statements.push({
      sql:
        'INSERT INTO history(model, record_id, version, operation, operation_id, ' +
        'actor, at, change, "before", "after") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      bindings: [
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
      ],
    });
  }
  if (batch.receipt !== null) {
    const receipt = batch.receipt;
    statements.push({
      sql:
        'INSERT INTO receipts(app, owner, principal, operation, operation_id, ' +
        'input_hash, resolved_defaults, outcome, committed_revision, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      bindings: [
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
      ],
    });
  }
  for (const intent of batch.outbox) {
    statements.push({
      sql:
        'INSERT INTO outbox(intent_id, operation, operation_id, target, arguments, ' +
          'occurrence_index, dispatch_guard, handler_contract, status, created_at) ' +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
      bindings: [
        intent.intentId,
        intent.operation as string,
        intent.operationId as string,
        intent.target,
        JSON.stringify(intent.arguments),
        intent.occurrenceIndex,
        intent.dispatchGuard ?? null,
        intent.handlerContract ?? null,
        at,
      ],
    });
  }
  // S6: acks run AFTER the intent inserts in this same atomic transaction,
  // so acking an id staged in this SAME batch marks it dispatched. One
  // UPDATE per id; unknown, dispatched, or skipped ids match zero rows
  // (idempotent no-op — dispatchers retry at-least-once). `undefined` is [].
  for (const intentId of batch.outboxAck ?? []) {
    statements.push({
      sql: "UPDATE outbox SET status = 'dispatched' WHERE intent_id = ? AND status = 'pending'",
      bindings: [intentId],
    });
  }
  for (const schedule of batch.schedules) {
    if (schedule.op === 'replace') {
      statements.push({
        sql: 'INSERT OR REPLACE INTO schedules("key", at, event, payload) VALUES (?, ?, ?, ?)',
        bindings: [
          schedule.key,
          schedule.at,
          schedule.event as string,
          JSON.stringify(schedule.payload),
        ],
      });
    } else {
      statements.push({
        sql: 'DELETE FROM schedules WHERE "key" = ?',
        bindings: [schedule.key],
      });
    }
  }
  return statements;
}

/**
 * S7: plan one fenced staging write: fence + revision + staged-row upserts
 * (idempotent restage) + progress upsert, all in one transaction.
 */
function planStage(input: StageMigrationChunk, next: number, at: number): PlannedStatement[] {
  const statements: PlannedStatement[] = [
    {
      sql: 'INSERT INTO fence_log(revision, at, operation) VALUES (?, ?, ?)',
      bindings: [next, at, `migration:stage:${input.migrationId}`],
    },
    {
      sql: 'UPDATE fence SET revision = ? WHERE id = ?',
      bindings: [next, FENCE_ROW_ID],
    },
  ];
  for (const row of input.rows) {
    statements.push({
      sql:
        'INSERT OR REPLACE INTO migration_staging(migration_id, target_model, ' +
        'record_id, version, data, parent, converted, created, created_by, ' +
        'archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      bindings: [
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
      ],
    });
  }
  statements.push({
    sql:
      'INSERT OR REPLACE INTO migration_progress(migration_id, phase, staged_cursor, ' +
      'publish_cursor, updated_revision) VALUES (?, ?, ?, ?, ?)',
    bindings: [
      input.migrationId,
      input.progress.phase,
      input.progress.stagedCursor === null ? null : JSON.stringify(input.progress.stagedCursor),
      input.progress.publishCursor === null ? null : JSON.stringify(input.progress.publishCursor),
      input.progress.updatedRevision as number,
    ],
  });
  return statements;
}

/**
 * S7: plan one fenced publish write. `existing` carries the pre-read live
 * rows for metadata carry-over (read synchronously before the transaction;
 * the fence INSERT aborts on any revision the reads did not see).
 */
function planPublish(
  input: PublishMigrationChunk,
  next: number,
  at: number,
  existing: ReadonlyMap<string, RecordRow | null>,
): PlannedStatement[] {
  const statements: PlannedStatement[] = [
    {
      sql: 'INSERT INTO fence_log(revision, at, operation) VALUES (?, ?, ?)',
      bindings: [next, at, `migration:publish:${input.migrationId}`],
    },
    {
      sql: 'UPDATE fence SET revision = ? WHERE id = ?',
      bindings: [next, FENCE_ROW_ID],
    },
  ];
  for (const row of input.rows) {
    const key = `${row.targetModel as string}\0${row.recordId as string}`;
    const merged = mergePublishedColumns(row, existing.get(key) ?? null, input.history);
    statements.push({
      sql:
        'INSERT OR REPLACE INTO records(model, id, version, created, updated, created_by, ' +
        'updated_by, archived_at, owner, parent_model, parent_id, data) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      bindings: [
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
      ],
    });
  }
  for (const entry of input.history) {
    statements.push({
      sql:
        'INSERT INTO history(model, record_id, version, operation, operation_id, ' +
        'actor, at, change, "before", "after") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      bindings: [
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
      ],
    });
  }
  for (const drop of input.drops) {
    statements.push({
      sql: 'DELETE FROM records WHERE model = ? AND id = ?',
      bindings: [drop.model as string, drop.recordId as string],
    });
    statements.push({
      sql:
        'INSERT INTO history(model, record_id, version, operation, operation_id, ' +
        'actor, at, change, "before", "after") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      bindings: [
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
      ],
    });
  }
  // Claim moves ride the same transaction: releases before claims, mirroring
  // commit, so a model rename moves keys between models atomically.
  for (const release of input.uniqueReleases ?? []) {
    statements.push({
      sql: 'DELETE FROM unique_claims WHERE model = ? AND key_name = ? AND key_value = ?',
      bindings: [release.model as string, release.keyName, release.keyValue],
    });
  }
  for (const claim of input.uniqueClaims ?? []) {
    statements.push({
      sql:
        'INSERT INTO unique_claims(model, key_name, key_value, record_id) ' +
        'VALUES (?, ?, ?, ?)',
      bindings: [
        claim.model as string,
        claim.keyName,
        claim.keyValue,
        claim.recordId as string,
      ],
    });
  }
  statements.push({
    sql:
      'INSERT OR REPLACE INTO migration_progress(migration_id, phase, staged_cursor, ' +
      'publish_cursor, updated_revision) VALUES (?, ?, ?, ?, ?)',
    bindings: [
      input.migrationId,
      input.progress.phase,
      input.progress.stagedCursor === null ? null : JSON.stringify(input.progress.stagedCursor),
      input.progress.publishCursor === null ? null : JSON.stringify(input.progress.publishCursor),
      input.progress.updatedRevision as number,
    ],
  });
  return statements;
}

/**
 * S7: plan the final fenced flip: pointer install (+ rename-source removal)
 * or pointer deletion (removal flip), pending-only skip updates, outcome
 * inserts, and the cursor-preserving progress-to-active upsert (missing
 * progress is created active).
 */
function planFlip(input: FlipInstalledSnapshot, next: number, at: number): PlannedStatement[] {
  const snapshotStatement: PlannedStatement =
    input.snapshot === null
      ? {
          sql: 'DELETE FROM snapshots WHERE owner = ?',
          bindings: [input.owner],
        }
      : {
          sql:
            'INSERT OR REPLACE INTO snapshots(owner, snapshot_id, digest, installed_revision, ' +
            'installed_at) VALUES (?, ?, ?, ?, ?)',
          bindings: [
            input.snapshot.owner,
            input.snapshot.snapshotId,
            input.snapshot.digest,
            // The engine cannot know the flip revision pre-commit: record actual.
            next,
            input.snapshot.installedAt,
          ],
        };
  const statements: PlannedStatement[] = [
    {
      sql: 'INSERT INTO fence_log(revision, at, operation) VALUES (?, ?, ?)',
      bindings: [next, at, `migration:flip:${input.migrationId}`],
    },
    {
      sql: 'UPDATE fence SET revision = ? WHERE id = ?',
      bindings: [next, FENCE_ROW_ID],
    },
    snapshotStatement,
  ];
  if (input.renameFromOwner !== null) {
    statements.push({
      sql: 'DELETE FROM snapshots WHERE owner = ?',
      bindings: [input.renameFromOwner],
    });
  }
  for (const intentId of input.invalidatedIntentIds) {
    // Pending-only: unknown, dispatched, or skipped ids match zero rows
    // (idempotent no-op), and a dispatched intent is never rewritten.
    statements.push({
      sql: "UPDATE outbox SET status = 'skipped' WHERE intent_id = ? AND status = 'pending'",
      bindings: [intentId],
    });
  }
  for (const outcome of input.outcomes) {
    statements.push({
      sql:
        'INSERT INTO migration_outcomes(migration_id, kind, intent_id, handler_contract) ' +
        'VALUES (?, ?, ?, ?)',
      bindings: [input.migrationId, outcome.kind, outcome.intentId, outcome.handlerContract],
    });
  }
  statements.push({
    sql:
      'INSERT INTO migration_progress(migration_id, phase, staged_cursor, publish_cursor, ' +
      'updated_revision) VALUES (?, ?, NULL, NULL, ?) ' +
      'ON CONFLICT(migration_id) DO UPDATE SET phase = ?, updated_revision = ?',
    bindings: [input.migrationId, 'active', next, 'active', next],
  });
  return statements;
}

/**
 * B3: plan one fenced failure write: mark progress failed (cursors carried
 * from the input) plus the durable failure row. Re-recording a failure
 * replaces the row (latest error wins); progress keeps failed.
 */
function planFailureRecord(input: RecordMigrationFailure, next: number, at: number): PlannedStatement[] {
  return [
    {
      sql: 'INSERT INTO fence_log(revision, at, operation) VALUES (?, ?, ?)',
      bindings: [next, at, `migration:failed:${input.migrationId}`],
    },
    {
      sql: 'UPDATE fence SET revision = ? WHERE id = ?',
      bindings: [next, FENCE_ROW_ID],
    },
    {
      sql:
        'INSERT OR REPLACE INTO migration_progress(migration_id, phase, staged_cursor, ' +
        'publish_cursor, updated_revision) VALUES (?, ?, ?, ?, ?)',
      bindings: [
        input.migrationId,
        'failed',
        input.stagedCursor === null ? null : JSON.stringify(input.stagedCursor),
        input.publishCursor === null ? null : JSON.stringify(input.publishCursor),
        next,
      ],
    },
    {
      sql:
        'INSERT OR REPLACE INTO migration_failures(migration_id, leg, prior_phase, ' +
        'staged_cursor, publish_cursor, error, at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      bindings: [
        input.migrationId,
        input.leg,
        input.priorPhase,
        input.stagedCursor === null ? null : JSON.stringify(input.stagedCursor),
        input.publishCursor === null ? null : JSON.stringify(input.publishCursor),
        input.error,
        input.at,
        next,
      ],
    },
  ];
}

/**
 * B3: plan one fenced pre-flip discard: delete staged rows plus the
 * progress row. The failure row (when any) is untouched — audit survives.
 */
function planDiscardStaged(input: DiscardStagedRows, next: number, at: number): PlannedStatement[] {
  return [
    {
      sql: 'INSERT INTO fence_log(revision, at, operation) VALUES (?, ?, ?)',
      bindings: [next, at, `migration:discard:${input.migrationId}`],
    },
    {
      sql: 'UPDATE fence SET revision = ? WHERE id = ?',
      bindings: [next, FENCE_ROW_ID],
    },
    {
      sql: 'DELETE FROM migration_staging WHERE migration_id = ?',
      bindings: [input.migrationId],
    },
    {
      sql: 'DELETE FROM migration_progress WHERE migration_id = ?',
      bindings: [input.migrationId],
    },
  ];
}

/**
 * Durable Object SQLite-backed `StoragePort`. Call `ensureSchema(storage)`
 * once before first use.
 */
export function createDOStorage(storage: DurableObjectStorage): StoragePort {
  return {
    async readRevision(): Promise<Revision> {
      return readRevisionInner(storage);
    },

    async load(model: ModelName, id: RecordId): Promise<StoredRow | null> {
      const rows = storage.sql
        .exec<RecordRow>(
          `SELECT ${RECORD_COLUMNS} FROM records WHERE model = ? AND id = ?`,
          model as string,
          id as string,
        )
        .toArray();
      const row = rows[0] ?? null;
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
      const rows = storage.sql.exec<RecordRow>(sql, ...bindings).toArray();
      return rows.map(toStoredRow);
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
      const current = readRevisionInner(storage);
      if (expected > (current as number)) {
        throw new FenceConflictError(batch.expectedRevision, current);
      }
      checkWriteVersions(storage, batch);
      const next = expected + 1;
      // fence_log/outbox timestamps come from the receipt when the batch
      // carries one; receipt-less batches (tests, bookkeeping) use now.
      const at = batch.receipt?.createdAt ?? Date.now();
      const operation =
        batch.receipt === null ? 'unknown' : (batch.receipt.identity.operation as string);
      const statements = planCommit(batch, next, at, operation);
      try {
        transact(storage, () => {
          for (const statement of statements) {
            storage.sql.exec(statement.sql, ...statement.bindings);
          }
        });
      } catch (error) {
        throw toCommitError(storage, batch.expectedRevision, error);
      }
      return { revision: next as Revision };
    },

    async readReceipt(identity: ReceiptIdentity): Promise<Receipt | null> {
      const rows = storage.sql
        .exec<ReceiptRow>(
          `SELECT ${RECEIPT_COLUMNS} FROM receipts WHERE app = ? AND owner = ? AND ` +
            'principal = ? AND operation = ? AND operation_id = ?',
          identity.app,
          identity.owner,
          identity.principal,
          identity.operation as string,
          identity.operationId as string,
        )
        .toArray();
      const row = rows[0] ?? null;
      return row === null ? null : toReceipt(row);
    },

    async outboxPending(): Promise<ReadonlyArray<OutboxIntent>> {
      // S6: pending only, deterministic (created_at, intent_id) order —
      // identical ordering to the memory adapter's comparator.
      const rows = storage.sql
        .exec<OutboxRow>(
          `SELECT ${OUTBOX_COLUMNS} FROM outbox WHERE status = 'pending' ` +
            'ORDER BY created_at, intent_id',
        )
        .toArray();
      return rows.map(toOutboxIntent);
    },

    async outboxGet(intentId: string): Promise<RetainedOutboxIntent | null> {
      const rows = storage.sql
        .exec<RetainedOutboxRow>(
          `SELECT ${OUTBOX_COLUMNS}, status FROM outbox WHERE intent_id = ?`, intentId,
        )
        .toArray();
      const row = rows[0] ?? null;
      return row === null ? null : toRetainedOutboxIntent(row);
    },

    async scheduleGet(key: string): Promise<ScheduleEntry | null> {
      const rows = storage.sql
        .exec<ScheduleRow>(`SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE "key" = ?`, key)
        .toArray();
      const row = rows[0] ?? null;
      return row === null ? null : toScheduleEntry(row);
    },

    async schedulesDue(now: number, limit: number): Promise<ReadonlyArray<ScheduleEntry>> {
      checkSchedulesLimit(limit);
      const rows = storage.sql
        .exec<ScheduleRow>(
          `SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE at <= ? ORDER BY at, "key" LIMIT ?`,
          now,
          limit,
        )
        .toArray();
      return rows.map(toScheduleEntry);
    },

    async historyFor(model: ModelName, recordId: RecordId): Promise<ReadonlyArray<HistoryEntry>> {
      const rows = storage.sql
        .exec<HistoryRow>(
          `SELECT ${HISTORY_COLUMNS} FROM history WHERE model = ? AND record_id = ? ` +
            // S6 review: `seq` tiebreaks duplicate versions (reachable only via
            // direct unstaged commits); fenced writes carry unique versions.
            'ORDER BY version, seq',
          model as string,
          recordId as string,
        )
        .toArray();
      return rows.map(toHistoryEntry);
    },

    async readInstalledSnapshot(owner: string): Promise<InstalledSnapshot | null> {
      // S7: null when the owner was never installed (fresh installs take a
      // separate path and never apply transitions).
      const rows = storage.sql
        .exec<SnapshotRow>(`SELECT ${SNAPSHOT_COLUMNS} FROM snapshots WHERE owner = ?`, owner)
        .toArray();
      const row = rows[0] ?? null;
      return row === null ? null : toInstalledSnapshot(row);
    },

    async readMigrationProgress(migrationId: string): Promise<MigrationProgress | null> {
      // S7: null when the migration never staged anything.
      const rows = storage.sql
        .exec<ProgressRow>(
          `SELECT ${PROGRESS_COLUMNS} FROM migration_progress WHERE migration_id = ?`,
          migrationId,
        )
        .toArray();
      const row = rows[0] ?? null;
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
      const rows = storage.sql.exec<StagingRow>(sql, ...bindings).toArray();
      return rows.map(toStagedRow);
    },

    async stageMigrationRows(input: StageMigrationChunk): Promise<CommitResult> {
      // S7: ONE fenced transaction: upsert staged rows (idempotent restage)
      // plus the progress row, atomically.
      checkMigrationExpected(storage, input.expectedRevision);
      const next = (input.expectedRevision as number) + 1;
      const at = Date.now();
      const statements = planStage(input, next, at);
      try {
        transact(storage, () => {
          for (const statement of statements) {
            storage.sql.exec(statement.sql, ...statement.bindings);
          }
        });
      } catch (error) {
        throw toCommitError(storage, input.expectedRevision, error);
      }
      return { revision: next as Revision };
    },

    async publishMigrationChunk(input: PublishMigrationChunk): Promise<CommitResult> {
      // S7: ONE fenced transaction: upsert live records, insert history,
      // dispose drops, upsert progress — atomically. Live rows are pre-read
      // for metadata carry-over, synchronously with zero awaits.
      checkMigrationExpected(storage, input.expectedRevision);
      const next = (input.expectedRevision as number) + 1;
      const at = Date.now();
      const existing = new Map<string, RecordRow | null>();
      for (const row of input.rows) {
        const found =
          storage.sql
            .exec<RecordRow>(
              `SELECT ${RECORD_COLUMNS} FROM records WHERE model = ? AND id = ?`,
              row.targetModel as string,
              row.recordId as string,
            )
            .toArray()[0] ?? null;
        existing.set(`${row.targetModel as string}\0${row.recordId as string}`, found);
      }
      const statements = planPublish(input, next, at, existing);
      try {
        transact(storage, () => {
          for (const statement of statements) {
            storage.sql.exec(statement.sql, ...statement.bindings);
          }
        });
      } catch (error) {
        throw toCommitError(storage, input.expectedRevision, error);
      }
      return { revision: next as Revision };
    },

    async flipInstalledSnapshot(input: FlipInstalledSnapshot): Promise<FlipResult> {
      // S7: idempotent activation. A null snapshot is an owner REMOVAL flip
      // (dropOwner): the pointer is deleted instead of installed; a removal
      // against an already-absent pointer is a no-op success. Otherwise ONE
      // fenced transaction, as planned by planFlip.
      if (input.snapshot === null && input.renameFromOwner !== null) {
        throw new Error('flipInstalledSnapshot: a removal flip renames nothing.');
      }
      if (input.snapshot !== null && input.snapshot.owner !== input.owner) {
        throw new Error('flipInstalledSnapshot: snapshot.owner must equal the flip owner.');
      }
      const installed =
        storage.sql
          .exec<SnapshotRow>(
            `SELECT ${SNAPSHOT_COLUMNS} FROM snapshots WHERE owner = ?`,
            input.owner,
          )
          .toArray()[0] ?? null;
      if (input.snapshot === null) {
        if (installed === null) {
          return { revision: readRevisionInner(storage), flipped: false };
        }
      } else if (
        installed !== null &&
        installed.snapshot_id === input.snapshot.snapshotId &&
        installed.digest === input.snapshot.digest
      ) {
        return { revision: readRevisionInner(storage), flipped: false };
      }
      checkMigrationExpected(storage, input.expectedRevision);
      const next = (input.expectedRevision as number) + 1;
      const at = Date.now();
      const statements = planFlip(input, next, at);
      try {
        transact(storage, () => {
          for (const statement of statements) {
            storage.sql.exec(statement.sql, ...statement.bindings);
          }
        });
      } catch (error) {
        throw toCommitError(storage, input.expectedRevision, error);
      }
      return { revision: next as Revision, flipped: true };
    },

    async readMigrationOutcomes(migrationId: string): Promise<ReadonlyArray<MigrationOutcome>> {
      // S7: recorded skips in record (seq) order.
      const rows = storage.sql
        .exec<OutcomeRow>(
          `SELECT ${OUTCOME_COLUMNS} FROM migration_outcomes WHERE migration_id = ? ORDER BY seq`,
          migrationId,
        )
        .toArray();
      return rows.map(toMigrationOutcome);
    },

    async recordMigrationFailure(input: RecordMigrationFailure): Promise<CommitResult> {
      // B3: ONE fenced transaction: failed mark plus the durable failure
      // row. Marking an active migration failed is a caller error.
      checkRecoveryInput(input.migrationId, input.leg);
      if (typeof input.error !== 'string' || input.error === '') {
        throw new Error('recordMigrationFailure: error must be a non-empty string.');
      }
      const current =
        storage.sql
          .exec<ProgressRow>(
            `SELECT ${PROGRESS_COLUMNS} FROM migration_progress WHERE migration_id = ?`,
            input.migrationId,
          )
          .toArray()[0] ?? null;
      if (current !== null && current.phase === 'active') {
        throw new Error('recordMigrationFailure: migration is already active.');
      }
      checkMigrationExpected(storage, input.expectedRevision);
      const next = (input.expectedRevision as number) + 1;
      const at = Date.now();
      const statements = planFailureRecord(input, next, at);
      try {
        transact(storage, () => {
          for (const statement of statements) {
            storage.sql.exec(statement.sql, ...statement.bindings);
          }
        });
      } catch (error) {
        throw toCommitError(storage, input.expectedRevision, error);
      }
      return { revision: next as Revision };
    },

    async discardStagedRows(input: DiscardStagedRows): Promise<CommitResult> {
      // B3: ONE fenced transaction: staged rows plus the progress row go;
      // the failure record stays. Active progress refuses (no rollback
      // past the flip).
      checkRecoveryInput(input.migrationId);
      const current =
        storage.sql
          .exec<ProgressRow>(
            `SELECT ${PROGRESS_COLUMNS} FROM migration_progress WHERE migration_id = ?`,
            input.migrationId,
          )
          .toArray()[0] ?? null;
      if (current !== null && current.phase === 'active') {
        throw new Error('discardStagedRows: migration is already active.');
      }
      checkMigrationExpected(storage, input.expectedRevision);
      const next = (input.expectedRevision as number) + 1;
      const at = Date.now();
      const statements = planDiscardStaged(input, next, at);
      try {
        transact(storage, () => {
          for (const statement of statements) {
            storage.sql.exec(statement.sql, ...statement.bindings);
          }
        });
      } catch (error) {
        throw toCommitError(storage, input.expectedRevision, error);
      }
      return { revision: next as Revision };
    },

    async readMigrationFailure(migrationId: string): Promise<MigrationFailure | null> {
      // B3: null when the migration never failed.
      const rows = storage.sql
        .exec<FailureRow>(
          `SELECT ${FAILURE_COLUMNS} FROM migration_failures WHERE migration_id = ?`,
          migrationId,
        )
        .toArray();
      const row = rows[0] ?? null;
      return row === null ? null : toMigrationFailure(row);
    },
  };
}
