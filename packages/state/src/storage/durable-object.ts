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

import type { DurableObjectStorage } from '@cloudflare/workers-types';
import type {
  CommitBatch,
  CommitResult,
  HistoryEntry,
  ModelName,
  OperationId,
  OperationName,
  OrderTerm,
  OutboxIntent,
  QueryPredicate,
  QuerySpec,
  Receipt,
  ReceiptIdentity,
  RecordId,
  RecordVersion,
  Revision,
  ScheduleEntry,
  StoredRow,
} from '../../../contracts/src/state.js';
import { FenceConflictError, StorageConstraintError } from './port.js';
import type { StoragePort } from './port.js';
import { FENCE_ROW_ID, SCHEMA_STATEMENTS } from './schema.js';

/** Run each schema statement sequentially; idempotent, safe to re-run. */
export async function ensureSchema(storage: DurableObjectStorage): Promise<void> {
  for (const statement of SCHEMA_STATEMENTS) {
    storage.sql.exec(statement);
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

/** Raw `records` row as `sql.exec` returns it (snake_case columns). */
type RecordRow = {
  readonly model: string;
  readonly id: string;
  readonly version: number;
  readonly created: number;
  readonly updated: number;
  readonly created_by: string;
  readonly updated_by: string;
  readonly archived_at: number | null;
  readonly parent_model: string | null;
  readonly parent_id: string | null;
  readonly data: string;
}

const RECORD_COLUMNS =
  'model, id, version, created, updated, created_by, updated_by, archived_at, ' +
  'parent_model, parent_id, data';

function toStoredRow(row: RecordRow): StoredRow {
  // S5: NULL parent columns read back as explicit null (never undefined), so
  // SQL reads match memory-adapter rows the engine wrote with `parent: null`.
  const parent =
    row.parent_model === null || row.parent_id === null
      ? null
      : { model: row.parent_model as ModelName, id: row.parent_id as RecordId };
  return {
    id: row.id as RecordId,
    version: row.version as RecordVersion,
    created: row.created,
    updated: row.updated,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    archivedAt: row.archived_at,
    parent,
    data: JSON.parse(row.data) as Record<string, unknown>,
  };
}

/** Predicate fields that compare as real columns; all others use `data`. */
const COLUMN_FIELDS: Readonly<Record<string, string>> = {
  id: 'id',
  version: 'version',
  created: 'created',
  updated: 'updated',
  archived_at: 'archived_at',
};

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function fieldExpr(field: string): string {
  const column = COLUMN_FIELDS[field];
  if (column !== undefined) {
    return column;
  }
  if (!FIELD_NAME.test(field)) {
    throw new Error(`Invalid query field: ${JSON.stringify(field)}`);
  }
  return `json_extract(data, '$.${field}')`;
}

/**
 * Encode a predicate value for binding. Booleans become 1/0 (SQLite has no
 * boolean storage; JSON true compares equal to 1) and undefined becomes NULL;
 * every other value binds as-is.
 */
function bindValue(value: unknown): unknown {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (value === undefined) {
    return null;
  }
  return value;
}

function compilePredicate(predicate: QueryPredicate, bindings: unknown[]): string {
  switch (predicate.op) {
    case 'and': {
      if (predicate.args.length === 0) {
        return '(1 = 1)';
      }
      return `(${predicate.args.map((arg) => compilePredicate(arg, bindings)).join(' AND ')})`;
    }
    case 'or': {
      if (predicate.args.length === 0) {
        return '(1 = 0)';
      }
      return `(${predicate.args.map((arg) => compilePredicate(arg, bindings)).join(' OR ')})`;
    }
    case 'not': {
      return `(NOT ${compilePredicate(predicate.arg, bindings)})`;
    }
    case 'eq': {
      const expr = fieldExpr(predicate.field);
      if (predicate.value === null || predicate.value === undefined) {
        return `(${expr} IS NULL)`;
      }
      bindings.push(bindValue(predicate.value));
      return `(${expr} = ?)`;
    }
    case 'ne': {
      const expr = fieldExpr(predicate.field);
      if (predicate.value === null || predicate.value === undefined) {
        return `(${expr} IS NOT NULL)`;
      }
      bindings.push(bindValue(predicate.value));
      return `(${expr} <> ?)`;
    }
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      const sqlOp =
        predicate.op === 'lt'
          ? '<'
          : predicate.op === 'lte'
            ? '<='
            : predicate.op === 'gt'
              ? '>'
              : '>=';
      bindings.push(bindValue(predicate.value));
      return `(${fieldExpr(predicate.field)} ${sqlOp} ?)`;
    }
    case 'between': {
      bindings.push(bindValue(predicate.lo), bindValue(predicate.hi));
      return `(${fieldExpr(predicate.field)} BETWEEN ? AND ?)`;
    }
    case 'is_null': {
      return `(${fieldExpr(predicate.field)} IS NULL)`;
    }
    case 'not_null': {
      return `(${fieldExpr(predicate.field)} IS NOT NULL)`;
    }
    default: {
      const op = (predicate as QueryPredicate).op;
      throw new Error(`Unknown query predicate: ${JSON.stringify(op)}`);
    }
  }
}

function compileOrder(order: ReadonlyArray<OrderTerm> | undefined): string {
  const terms = (order ?? []).map((term) => {
    if (term.direction !== 'asc' && term.direction !== 'desc') {
      throw new Error(`Invalid order direction: ${JSON.stringify(term.direction)}`);
    }
    return `${fieldExpr(term.field)} ${term.direction === 'asc' ? 'ASC' : 'DESC'}`;
  });
  if (terms.length === 0) {
    return 'created ASC, id ASC';
  }
  return `${terms.join(', ')}, id ASC`;
}

function checkLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`Invalid query limit: ${JSON.stringify(limit)}`);
  }
}

/**
 * S6: `schedulesDue` limit must be an integer >= 1. Plain Error (programmer
 * bug), mirroring `checkLimit` style. Zero is rejected here (unlike query
 * limit) because a scheduler page must return at least one row to make sense.
 */
function checkSchedulesLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Invalid schedules limit: ${JSON.stringify(limit)}`);
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
      .exec<{ version: number }>(
        'SELECT version FROM records WHERE model = ? AND id = ?',
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

/** Raw `receipts` row as `sql.exec` returns it. */
type ReceiptRow = {
  readonly app: string;
  readonly owner: string;
  readonly principal: string;
  readonly operation: string;
  readonly operation_id: string;
  readonly input_hash: string;
  readonly resolved_defaults: string;
  readonly outcome: string;
  readonly committed_revision: number;
  readonly created_at: number;
}

const RECEIPT_COLUMNS =
  'app, owner, principal, operation, operation_id, input_hash, ' +
  'resolved_defaults, outcome, committed_revision, created_at';

function toReceipt(row: ReceiptRow): Receipt {
  return {
    identity: {
      app: row.app,
      owner: row.owner,
      principal: row.principal,
      operation: row.operation as Receipt['identity']['operation'],
      operationId: row.operation_id as Receipt['identity']['operationId'],
    },
    inputHash: row.input_hash,
    resolvedDefaults: JSON.parse(row.resolved_defaults) as Record<string, unknown>,
    outcome: JSON.parse(row.outcome) as Receipt['outcome'],
    committedRevision: row.committed_revision as Revision,
    createdAt: row.created_at,
  };
}

/** S6: raw `outbox` row as `sql.exec` returns it (snake_case columns). */
type OutboxRow = {
  readonly intent_id: string;
  readonly operation: string;
  readonly operation_id: string;
  readonly target: string;
  readonly arguments: string;
  readonly occurrence_index: number;
  readonly dispatch_guard: string | null;
};

const OUTBOX_COLUMNS =
  'intent_id, operation, operation_id, target, arguments, occurrence_index, dispatch_guard';

function toOutboxIntent(row: OutboxRow): OutboxIntent {
  return {
    intentId: row.intent_id,
    operation: row.operation as OperationName,
    operationId: row.operation_id as OperationId,
    target: row.target,
    arguments: JSON.parse(row.arguments) as Record<string, unknown>,
    occurrenceIndex: row.occurrence_index,
    // NULL guard stays absent (never explicit undefined: exactOptionalPropertyTypes).
    ...(row.dispatch_guard === null ? {} : { dispatchGuard: row.dispatch_guard }),
  };
}

/** S6: raw `schedules` row as `sql.exec` returns it. */
type ScheduleRow = {
  readonly key: string;
  readonly at: number;
  readonly event: string;
  readonly payload: string;
};

const SCHEDULE_COLUMNS = '"key", at, event, payload';

function toScheduleEntry(row: ScheduleRow): ScheduleEntry {
  return {
    key: row.key,
    at: row.at,
    event: row.event as OperationName,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  };
}

/** S6: raw `history` row as `sql.exec` returns it (snake_case columns). */
type HistoryRow = {
  readonly model: string;
  readonly record_id: string;
  readonly version: number;
  readonly operation: string;
  readonly operation_id: string;
  readonly actor: string;
  readonly at: number;
  readonly change: string;
  readonly before: string | null;
  readonly after: string | null;
};

const HISTORY_COLUMNS =
  'model, record_id, version, operation, operation_id, actor, at, change, "before", "after"';

function toHistoryEntry(row: HistoryRow): HistoryEntry {
  return {
    model: row.model as ModelName,
    recordId: row.record_id as RecordId,
    version: row.version as RecordVersion,
    operation: row.operation as OperationName,
    operationId: row.operation_id as OperationId,
    actor: row.actor,
    at: row.at,
    change: row.change as HistoryEntry['change'],
    before: row.before === null ? null : (JSON.parse(row.before) as Record<string, unknown>),
    after: row.after === null ? null : (JSON.parse(row.after) as Record<string, unknown>),
  };
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
          'occurrence_index, dispatch_guard, status, created_at) ' +
          "VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
      bindings: [
        intent.intentId,
        intent.operation as string,
        intent.operationId as string,
        intent.target,
        JSON.stringify(intent.arguments),
        intent.occurrenceIndex,
        intent.dispatchGuard ?? null,
        at,
      ],
    });
  }
  // S6: acks run AFTER the intent inserts in this same atomic transaction,
  // so acking an id staged in this SAME batch marks it dispatched. One
  // UPDATE per id; unknown or already-dispatched ids match zero rows
  // (idempotent no-op — dispatchers retry at-least-once). `undefined` is [].
  for (const intentId of batch.outboxAck ?? []) {
    statements.push({
      sql: "UPDATE outbox SET status = 'dispatched' WHERE intent_id = ?",
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
            'ORDER BY version',
          model as string,
          recordId as string,
        )
        .toArray();
      return rows.map(toHistoryEntry);
    },
  };
}
