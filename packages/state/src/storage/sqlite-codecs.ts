import type {
  CohortIdentityPageRequest,
  CohortRowLoadRequest,
  CohortRowPageRequest,
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
  RetainedOutboxIntent,
  RecordId,
  RecordParent,
  RecordVersion,
  Revision,
  ScheduleEntry,
  StagedRow,
  StagedRowCursor,
  StoredRow,
} from '@canlang/contracts';
import { StateError } from '../errors.js';

// The selected original private-cohort profile; ordinary codecs stay unbounded.
const COHORT_NODES = 20_000;
const COHORT_DEPTH = 32;
const COHORT_TEXT = 2_000_000;
const COHORT_BYTES = 6 * COHORT_TEXT + 32 * COHORT_NODES;
function cohortLimit(): never {
  throw new StateError('limit', 'Cohort representation exceeds its resource limit.', null, { retryable: false });
}
function cohortInvalid(): never { throw new StateError('validation', 'Invalid cohort storage input.'); }
function cohortIdentity(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) cohortInvalid();
  if (value.length > maximum) cohortLimit();
  try { encodeURIComponent(value); } catch { cohortInvalid(); }
}

/** Capture only the selected own fields; accessors cannot change SQL bounds. */
export function captureCohortRequest<T extends CohortIdentityPageRequest | CohortRowLoadRequest | CohortRowPageRequest>(
  input: T, mode: 'identity' | 'load' | 'rows' | 'anchor',
): T {
  const record = (value: unknown): object => {
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) cohortInvalid();
    return value;
  };
  const own = (value: object, key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) cohortInvalid();
    return descriptor.value;
  };
  const original = record(input);
  const captured: Record<string, unknown> = { model: own(original, 'model'), expectedRevision: own(original, 'expectedRevision') };
  if (mode === 'load' || mode === 'anchor') captured['id'] = own(original, 'id');
  else {
    captured['after'] = own(original, 'after'); captured['limit'] = own(original, 'limit');
    if (mode === 'rows') captured['fanoutId'] = own(original, 'fanoutId');
    else {
      const descriptor = Object.getOwnPropertyDescriptor(original, 'parent');
      if (descriptor !== undefined) {
        if (!('value' in descriptor)) cohortInvalid();
        if (descriptor.value !== undefined) {
          const parent = record(descriptor.value);
          captured['parent'] = Object.freeze({ model: own(parent, 'model'), id: own(parent, 'id') });
        }
      }
    }
  }
  const result = Object.freeze(captured) as unknown as T;
  checkCohortRequest(result, mode);
  return result;
}

export function checkCohortRequest(
  input: CohortIdentityPageRequest | CohortRowLoadRequest | CohortRowPageRequest,
  mode: 'identity' | 'load' | 'rows' | 'anchor',
): void {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) cohortInvalid();
  cohortIdentity(input.model, 200);
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) cohortInvalid();
  if (mode === 'load' || mode === 'anchor') {
    cohortIdentity((input as CohortRowLoadRequest).id, mode === 'anchor' ? 200 : 6000);
  } else {
    const page = input as CohortIdentityPageRequest | CohortRowPageRequest;
    if (!Number.isInteger(page.limit) || page.limit < 1) cohortInvalid();
    if (page.limit > 100) cohortLimit();
    if (page.after !== null) cohortIdentity(page.after, mode === 'identity' ? 200 : 6000);
    if (mode === 'rows') cohortIdentity((page as CohortRowPageRequest).fanoutId, 6000);
    else if ('parent' in page && page.parent !== undefined) {
      if (typeof page.parent !== 'object' || page.parent === null) cohortInvalid();
      cohortIdentity(page.parent.model, 200); cohortIdentity(page.parent.id, 200);
    }
  }
}

export function compileCohortIdentityPage(input: CohortIdentityPageRequest): { sql: string; bindings: unknown[] } {
  input = captureCohortRequest(input, 'identity');
  const bindings: unknown[] = [input.model];
  let where = 'model = ?';
  if (input.parent !== undefined) { where += ' AND parent_model = ? AND parent_id = ?'; bindings.push(input.parent.model, input.parent.id); }
  if (input.after !== null) { where += ' AND id > ?'; bindings.push(input.after); }
  bindings.push(input.limit);
  // No data/metadata/history payload is selected. SQL prevents an enormous
  // stored id from reaching the host; UTF16/domain validation follows below.
  return { sql: `SELECT CASE WHEN length(CAST(id AS BLOB)) <= 800 THEN id ELSE NULL END AS id FROM records WHERE ${where} ORDER BY records.id ASC LIMIT ?`, bindings };
}

export function checkCohortIdentityRows(rows: readonly { readonly id: string | null }[], limit: number): readonly RecordId[] {
  if (rows.length > limit) cohortLimit();
  return rows.map(row => { if (row.id === null) cohortLimit(); cohortIdentity(row.id, 200); return row.id as RecordId; });
}

/** Null data is a SQL resource sentinel, never a stored JSON null. */
export type CohortRecordRow = Omit<RecordRow, 'data'> & { readonly data: string | null };
function cohortRowSql(where: string, bindings: unknown[], limit: number): { sql: string; bindings: unknown[] } {
  // SQLite affinity is not a type guarantee: even numeric metadata can hold
  // large text/blobs. Count and withhold every returned column before the host.
  const rawColumns = RECORD_COLUMNS.split(', ');
  const rawSize = rawColumns.map(column => `COALESCE(length(CAST(r.${column} AS BLOB)), 0)`).join(' + ');
  const gate = `(SELECT COALESCE(SUM(${rawSize}), 0) FROM records r JOIN selected s ON r.model = s.model AND r.id = s.id) <= ${COHORT_BYTES}`;
  const columns = rawColumns.map(column =>
    `CASE WHEN ${gate} THEN r.${column} ELSE NULL END AS ${column}`).join(', ');
  // Select bounded identities first. Gate the complete page's raw payload
  // before D1 .all()/DO .toArray() materializes any host payload strings.
  return { sql: `WITH selected AS (SELECT model, id FROM records WHERE ${where} ORDER BY id ASC LIMIT ?) SELECT ${columns} FROM records r JOIN selected s ON r.model = s.model AND r.id = s.id ORDER BY r.id ASC`, bindings: [...bindings, limit] };
}

export function compileCohortRowLoad(input: CohortRowLoadRequest): { sql: string; bindings: unknown[] } {
  input = captureCohortRequest(input, 'load');
  return cohortRowSql('model = ? AND id = ?', [input.model, input.id], 1);
}
export function compileCohortRowPage(input: CohortRowPageRequest): { sql: string; bindings: unknown[] } {
  input = captureCohortRequest(input, 'rows');
  const bindings: unknown[] = [input.model, input.fanoutId];
  let where = "model = ? AND archived_at IS NULL AND json_extract(data, '$.fanoutId') = ?";
  if (input.after !== null) { where += ' AND id > ?'; bindings.push(input.after); }
  return cohortRowSql(where, bindings, input.limit);
}

class CohortBudget {
  nodes = 0;
  text = 0;
  visit(depth: number): void { if (depth > COHORT_DEPTH || ++this.nodes > COHORT_NODES) cohortLimit(); }
  addText(units: number): void { this.text += units; if (this.text > COHORT_TEXT) cohortLimit(); }
}

/** Count raw bytes without allocating an encoding buffer before its cap. */
function checkCohortRawBytes(raw: string): void {
  if (raw.length > COHORT_BYTES) cohortLimit();
  let bytes = 0;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && raw.charCodeAt(i + 1) >= 0xdc00 && raw.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
    if (bytes > COHORT_BYTES) cohortLimit();
  }
}

/** Validate/count JSON tokens before JSON.parse can grow the retained tree. */
function checkCohortJson(raw: string, budget: CohortBudget, rootDepth: number): void {
  checkCohortRawBytes(raw);
  let at = 0;
  const invalid = (): never => { throw new SyntaxError('Invalid cohort JSON.'); };
  const space = (): void => { while (raw[at] === ' ' || raw[at] === '\n' || raw[at] === '\r' || raw[at] === '\t') at++; };
  const string = (): void => {
    if (raw[at++] !== '"') invalid();
    for (;;) {
      const char = raw[at++];
      if (char === undefined) throw new SyntaxError('Invalid cohort JSON.');
      if (char === '"') return;
      if (char === '\\') {
        const escaped = raw[at++];
        if (escaped === 'u') {
          for (let n = 0; n < 4; n++) if (!/[0-9a-fA-F]/.test(raw[at++] ?? '')) invalid();
        } else if (escaped === undefined || !'"\\/bfnrt'.includes(escaped)) invalid();
      } else if (char.charCodeAt(0) < 0x20) invalid();
      budget.addText(1);
    }
  };
  const value = (depth: number): void => {
    space(); budget.visit(depth);
    const char = raw[at];
    if (char === '"') { string(); return; }
    if (char === '{' || char === '[') {
      const array = char === '['; at++; space();
      const end = array ? ']' : '}';
      if (raw[at] === end) { at++; return; }
      let index = 0;
      for (;;) {
        if (array) budget.addText(String(index++).length);
        else { string(); space(); if (raw[at++] !== ':') invalid(); }
        value(depth + 1); space();
        if (raw[at] === end) { at++; return; }
        if (raw[at++] !== ',') invalid(); space();
      }
    }
    for (const literal of ['true', 'false', 'null']) {
      if (raw.startsWith(literal, at)) { at += literal.length; return; }
    }
    const start = at;
    if (raw[at] === '-') at++;
    if (raw[at] === '0') at++;
    else { if (!/[1-9]/.test(raw[at] ?? '')) invalid(); while (/[0-9]/.test(raw[at] ?? '')) at++; }
    if (raw[at] === '.') { at++; if (!/[0-9]/.test(raw[at] ?? '')) invalid(); while (/[0-9]/.test(raw[at] ?? '')) at++; }
    if (raw[at] === 'e' || raw[at] === 'E') { at++; if (raw[at] === '+' || raw[at] === '-') at++; if (!/[0-9]/.test(raw[at] ?? '')) invalid(); while (/[0-9]/.test(raw[at] ?? '')) at++; }
    if (!Number.isFinite(Number(raw.slice(start, at)))) cohortInvalid();
  };
  value(rootDepth); space(); if (at !== raw.length) invalid();
}

function captureCohort(value: unknown, budget: CohortBudget, depth: number, active: Set<object>): unknown {
  budget.visit(depth);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') { budget.addText(value.length); return value; }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null || active.has(value)) cohortInvalid();
  const array = Array.isArray(value);
  if (array ? Object.getPrototypeOf(value) !== Array.prototype :
    Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) cohortInvalid();
  if (array && value.length > COHORT_NODES - budget.nodes) cohortLimit();
  const keys = Reflect.ownKeys(value);
  if (keys.length > COHORT_NODES - budget.nodes + (array ? 1 : 0)) cohortLimit();
  if (array && keys.length !== value.length + 1) cohortInvalid();
  const result: Record<string, unknown> | unknown[] = array ? [] : {};
  active.add(value);
  for (const key of keys) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string') cohortInvalid();
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) cohortInvalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) cohortInvalid();
    budget.addText(key.length);
    Object.defineProperty(result, key, { value: captureCohort(descriptor.value, budget, depth + 1, active), enumerable: true, writable: true, configurable: true });
  }
  active.delete(value);
  if (array && (result as unknown[]).length !== value.length) cohortInvalid();
  return result;
}

export function captureCohortRow(row: StoredRow): StoredRow {
  cohortIdentity(row.id, 6000);
  return captureCohort(row, new CohortBudget(), 0, new Set()) as StoredRow;
}
export function captureCohortRows(rows: readonly StoredRow[]): readonly StoredRow[] {
  if (rows.length > 100) cohortLimit();
  for (const row of rows) cohortIdentity(row.id, 6000);
  return captureCohort(rows, new CohortBudget(), 0, new Set()) as StoredRow[];
}

function prepareCohortRow(row: CohortRecordRow, budget: CohortBudget, depth: number): Omit<StoredRow, 'data'> {
  if (row.data === null) cohortLimit();
  cohortIdentity(row.id, 6000);
  // Keep the exact ordinary codec's parent/null and metadata shape. The data
  // token walk shares this same row/page budget, before any JSON.parse.
  const parent = row.parent_model === null || row.parent_id === null ? null : { model: row.parent_model as ModelName, id: row.parent_id as RecordId };
  const metadata = { id: row.id as RecordId, version: row.version as RecordVersion,
    created: row.created, updated: row.updated, createdBy: row.created_by, updatedBy: row.updated_by,
    archivedAt: row.archived_at, parent };
  const copied = captureCohort(metadata, budget, depth, new Set()) as Omit<StoredRow, 'data'>;
  budget.addText(4); // the owning data key; its value is counted by raw tokens
  checkCohortJson(row.data, budget, depth + 1);
  return copied;
}
export function toCohortStoredRow(row: CohortRecordRow): StoredRow {
  const metadata = prepareCohortRow(row, new CohortBudget(), 0);
  return { ...metadata, data: JSON.parse(row.data!) as Record<string, unknown> };
}
export function toCohortStoredRows(rows: readonly CohortRecordRow[]): readonly StoredRow[] {
  if (rows.length > 100) cohortLimit();
  const budget = new CohortBudget(); budget.visit(0);
  const metadata = rows.map((row, index) => { budget.addText(String(index).length); return prepareCohortRow(row, budget, 1); });
  return rows.map((row, index) => ({ ...metadata[index]!, data: JSON.parse(row.data!) as Record<string, unknown> }));
}

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
  const column = Object.hasOwn(COLUMN_FIELDS, field) ? COLUMN_FIELDS[field] : undefined;
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

export type RetainedOutboxRow = OutboxRow & {
  readonly status: RetainedOutboxIntent['status'];
  readonly committed_revision: number | null;
  readonly created_at: number;
};

export function toRetainedOutboxIntent(row: RetainedOutboxRow): RetainedOutboxIntent {
  // A pre-provenance row retains its creation time but has no original
  // publication revision. Never infer one from the later store fence.
  if (row.committed_revision !== null &&
      (!Number.isInteger(row.committed_revision) || row.committed_revision < 1 || !Number.isFinite(row.created_at))) {
    throw new Error('Retained outbox original commit provenance is invalid.');
  }
  return { intent: toOutboxIntent(row), status: row.status,
    ...(row.committed_revision === null ? {} : {
      originalCommit: { revision: row.committed_revision as Revision, createdAt: row.created_at },
    }) };

}

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
