import type {
  HistoryEntry,
  InstalledSnapshot,
  MigrationFailure,
  MigrationFailureLeg,
  MigrationOutcome,
  MigrationProgress,
  ModelName,
  OperationId,
  OperationName,
  OrderTerm,
  OutboxIntent,
  QueryPredicate,
  Receipt,
  RecordId,
  RecordParent,
  RecordVersion,
  Revision,
  ScheduleEntry,
  StagedRow,
  StagedRowCursor,
  StoredRow,
} from '@canlang/contracts';

/** Raw `records` row as D1 returns it (snake_case columns). */
export type RecordRow = {
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

export const RECORD_COLUMNS =
  'model, id, version, created, updated, created_by, updated_by, archived_at, ' +
  'parent_model, parent_id, data';

export function toStoredRow(row: RecordRow): StoredRow {
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

export function compilePredicate(predicate: QueryPredicate, bindings: unknown[]): string {
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

export function compileOrder(order: ReadonlyArray<OrderTerm> | undefined): string {
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

export function checkLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`Invalid query limit: ${JSON.stringify(limit)}`);
  }
}

/**
 * S6: `schedulesDue` limit must be an integer >= 1. Plain Error (programmer
 * bug), mirroring `checkLimit` style. Zero is rejected here (unlike query
 * limit) because a scheduler page must return at least one row to make sense.
 */
export function checkSchedulesLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Invalid schedules limit: ${JSON.stringify(limit)}`);
  }
}

/**
 * S7: `readStagedRows` limit must be an integer >= 1. Plain Error (programmer
 * bug), mirroring `checkSchedulesLimit` style exactly.
 */
export function checkStagedRowsLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Invalid staged rows limit: ${JSON.stringify(limit)}`);
  }
}

/** Raw `receipts` row as D1 returns it. */
export type ReceiptRow = {
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

export const RECEIPT_COLUMNS =
  'app, owner, principal, operation, operation_id, input_hash, ' +
  'resolved_defaults, outcome, committed_revision, created_at';

export function toReceipt(row: ReceiptRow): Receipt {
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

/** S6: raw `outbox` row as D1 returns it (snake_case columns). */
export type OutboxRow = {
  readonly intent_id: string;
  readonly operation: string;
  readonly operation_id: string;
  readonly target: string;
  readonly arguments: string;
  readonly occurrence_index: number;
  readonly dispatch_guard: string | null;
  readonly handler_contract: string | null;
};

export const OUTBOX_COLUMNS =
  'intent_id, operation, operation_id, target, arguments, occurrence_index, dispatch_guard, ' +
  'handler_contract';

export function toOutboxIntent(row: OutboxRow): OutboxIntent {
  return {
    intentId: row.intent_id,
    operation: row.operation as OperationName,
    operationId: row.operation_id as OperationId,
    target: row.target,
    arguments: JSON.parse(row.arguments) as Record<string, unknown>,
    occurrenceIndex: row.occurrence_index,
    // NULL guard stays absent (never explicit undefined: exactOptionalPropertyTypes).
    ...(row.dispatch_guard === null ? {} : { dispatchGuard: row.dispatch_guard }),
    // B3: NULL contract stays absent (pre-B3 rows attest at the boundary).
    ...(row.handler_contract === null ? {} : { handlerContract: row.handler_contract }),
  };
}

/** S6: raw `schedules` row as D1 returns it. */
export type ScheduleRow = {
  readonly key: string;
  readonly at: number;
  readonly event: string;
  readonly payload: string;
};

export const SCHEDULE_COLUMNS = '"key", at, event, payload';

export function toScheduleEntry(row: ScheduleRow): ScheduleEntry {
  return {
    key: row.key,
    at: row.at,
    event: row.event as OperationName,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  };
}

/** S6: raw `history` row as D1 returns it (snake_case columns). */
export type HistoryRow = {
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

export const HISTORY_COLUMNS =
  'model, record_id, version, operation, operation_id, actor, at, change, "before", "after"';

export function toHistoryEntry(row: HistoryRow): HistoryEntry {
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

/** S7: raw `snapshots` row as D1 returns it (snake_case columns). */
export type SnapshotRow = {
  readonly owner: string;
  readonly snapshot_id: string;
  readonly digest: string;
  readonly installed_revision: number;
  readonly installed_at: number;
}

export const SNAPSHOT_COLUMNS = 'owner, snapshot_id, digest, installed_revision, installed_at';

export function toInstalledSnapshot(row: SnapshotRow): InstalledSnapshot {
  return {
    owner: row.owner,
    snapshotId: row.snapshot_id,
    digest: row.digest,
    installedRevision: row.installed_revision as Revision,
    installedAt: row.installed_at,
  };
}

/** S7: raw `migration_staging` row as D1 returns it. */
export type StagingRow = {
  readonly target_model: string;
  readonly record_id: string;
  readonly version: number;
  readonly data: string;
  readonly parent: string | null;
  readonly converted: number;
  readonly created: number | null;
  readonly created_by: string | null;
  readonly archived_at: number | null;
}

export const STAGING_COLUMNS =
  'target_model, record_id, version, data, parent, converted, created, created_by, archived_at';

export function toStagedRow(row: StagingRow): StagedRow {
  return {
    targetModel: row.target_model as ModelName,
    recordId: row.record_id as RecordId,
    version: row.version as RecordVersion,
    data: JSON.parse(row.data) as Record<string, unknown>,
    parent: row.parent === null ? null : (JSON.parse(row.parent) as RecordParent),
    converted: row.converted === 1,
    // NULL stays absent (never explicit undefined: exactOptionalPropertyTypes).
    ...(row.created === null ? {} : { created: row.created }),
    ...(row.created_by === null ? {} : { createdBy: row.created_by }),
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
  };
}

/** S7: raw `migration_progress` row as D1 returns it. */
export type ProgressRow = {
  readonly migration_id: string;
  readonly phase: string;
  readonly staged_cursor: string | null;
  readonly publish_cursor: string | null;
  readonly updated_revision: number;
}

export const PROGRESS_COLUMNS = 'migration_id, phase, staged_cursor, publish_cursor, updated_revision';

export function toMigrationProgress(row: ProgressRow): MigrationProgress {
  return {
    migrationId: row.migration_id,
    phase: row.phase as MigrationProgress['phase'],
    stagedCursor:
      row.staged_cursor === null ? null : (JSON.parse(row.staged_cursor) as StagedRowCursor),
    publishCursor:
      row.publish_cursor === null ? null : (JSON.parse(row.publish_cursor) as StagedRowCursor),
    updatedRevision: row.updated_revision as Revision,
  };
}

/** S7: raw `migration_outcomes` row as D1 returns it. */
export type OutcomeRow = {
  readonly migration_id: string;
  readonly kind: string;
  readonly intent_id: string;
  readonly handler_contract: string;
}

export const OUTCOME_COLUMNS = 'migration_id, kind, intent_id, handler_contract';

export function toMigrationOutcome(row: OutcomeRow): MigrationOutcome {
  return {
    migrationId: row.migration_id,
    kind: row.kind as MigrationOutcome['kind'],
    intentId: row.intent_id,
    handlerContract: row.handler_contract,
  };
}

/** B3: raw `migration_failures` row as D1 returns it. */
export type FailureRow = {
  readonly migration_id: string;
  readonly leg: string;
  readonly prior_phase: string;
  readonly staged_cursor: string | null;
  readonly publish_cursor: string | null;
  readonly error: string;
  readonly at: number;
  readonly revision: number;
};

export const FAILURE_COLUMNS =
  'migration_id, leg, prior_phase, staged_cursor, publish_cursor, error, at, revision';

export function toMigrationFailure(row: FailureRow): MigrationFailure {
  return {
    migrationId: row.migration_id,
    leg: row.leg as MigrationFailureLeg,
    priorPhase: row.prior_phase as MigrationFailure['priorPhase'],
    stagedCursor:
      row.staged_cursor === null ? null : (JSON.parse(row.staged_cursor) as StagedRowCursor),
    publishCursor:
      row.publish_cursor === null ? null : (JSON.parse(row.publish_cursor) as StagedRowCursor),
    error: row.error,
    at: row.at,
    revision: row.revision as Revision,
  };
}

/**
 * S7: merge one staged row onto its live target, mirroring the memory
 * adapter exactly. Version/data/parent come from the staged row; creation
 * metadata carries over from the existing live row when present; the
 * matching history entry (same model + record id, first in chunk order)
 * supplies updated/updatedBy — and created/createdBy for rows with no live
 * predecessor. Fallback is 0/''; archivedAt carries over (never unarchives).
 */
export function mergePublishedColumns(
  staged: StagedRow,
  existing: RecordRow | null,
  history: ReadonlyArray<HistoryEntry>,
): {
  readonly created: number;
  readonly updated: number;
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly archivedAt: number | null;
} {
  const match = history.find(
    (entry) =>
      (entry.model as string) === (staged.targetModel as string) &&
      (entry.recordId as string) === (staged.recordId as string),
  );
  return {
    created: staged.created ?? existing?.created ?? match?.at ?? 0,
    updated: match?.at ?? existing?.updated ?? 0,
    createdBy: staged.createdBy ?? existing?.created_by ?? match?.actor ?? '',
    updatedBy: match?.actor ?? existing?.updated_by ?? '',
    archivedAt: staged.archivedAt ?? existing?.archived_at ?? null,
  };
}
