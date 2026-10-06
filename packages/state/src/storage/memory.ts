/**
 * TEST-ONLY — never a production backend. In-memory `StoragePort` mirroring
 * the SQL adapters' fence, version/unique/receipt-constraint, query, and
 * receipt semantics (conformance-verified, including multi-touch batch order
 * and three-valued predicates), so upper-layer unit tests run without a
 * worker runtime.
 *
 * Parity notes: rows are JSON-normalized on write and deep-copied on every
 * read (matching the SQL JSON round-trip); predicate evaluation mirrors
 * SQLite three-valued logic (NULL comparisons filter out; booleans compare as
 * 1/0; NULLs sort first in ASC); commits validate all constraints before
 * mutating anything, so failures leave no partial state.
 */

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
  OperationName,
  OrderTerm,
  OutboxIntent,
  PublishMigrationChunk,
  QueryPredicate,
  QuerySpec,
  Receipt,
  ReceiptIdentity,
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
import { INITIAL_REVISION } from './schema.js';

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function jsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function recordKey(model: string, id: string): string {
  return `${model}\0${id}`;
}

function receiptKey(identity: ReceiptIdentity): string {
  return (
    `${identity.app}\0${identity.owner}\0${identity.principal}\0` +
    `${identity.operation as string}\0${identity.operationId as string}`
  );
}

function claimKey(model: string, keyName: string, keyValue: string): string {
  return `${model}\0${keyName}\0${keyValue}`;
}

/**
 * S6: dispatch status of a staged outbox intent. S7 adds `skipped` for
 * migration-invalidated intents; `outboxPending` still reads pending only.
 */
type OutboxStatus = 'pending' | 'dispatched' | 'skipped';

/** Stored record: S5 rows persist `parent` inline (round-tripped as-is). */
interface MemoryRecord {
  readonly model: string;
  readonly row: StoredRow;
}

interface MemoryState {
  revision: number;
  fenceLog: Map<number, { readonly at: number; readonly operation: string }>;
  records: Map<string, MemoryRecord>;
  receipts: Map<string, Receipt>;
  history: Array<{ readonly seq: number; readonly entry: unknown }>;
  // S6: outbox rows carry a dispatch status (default 'pending' on insert),
  // mirroring the SQL `status` column; ack flips it to 'dispatched'.
  outbox: Map<
    string,
    { readonly intent: unknown; readonly createdAt: number; readonly status: OutboxStatus }
  >;
  schedules: Map<string, { readonly at: number; readonly event: string; readonly payload: unknown }>;
  uniqueClaims: Map<string, string>;
  historySeq: number;
  // S7: installed owner snapshots, shadow-staged migration rows (never read
  // by load/query), resumable progress, and recorded skip outcomes.
  snapshots: Map<string, InstalledSnapshot>;
  staging: Map<string, Map<string, StagedRow>>;
  progress: Map<string, MigrationProgress>;
  outcomes: Map<string, MigrationOutcome[]>;
  // B3: durable failure records (survive abort as operator audit).
  failures: Map<string, MigrationFailure>;
}

function freshState(): MemoryState {
  return {
    revision: INITIAL_REVISION as number,
    fenceLog: new Map(),
    records: new Map(),
    receipts: new Map(),
    history: [],
    outbox: new Map(),
    schedules: new Map(),
    uniqueClaims: new Map(),
    historySeq: 0,
    snapshots: new Map(),
    staging: new Map(),
    progress: new Map(),
    outcomes: new Map(),
    failures: new Map(),
  };
}

function checkField(field: string): void {
  switch (field) {
    case 'id':
    case 'version':
    case 'created':
    case 'updated':
    case 'archived_at':
      return;
    default: {
      if (!FIELD_NAME.test(field)) {
        throw new Error(`Invalid query field: ${JSON.stringify(field)}`);
      }
    }
  }
}

function checkPredicateFields(predicate: QueryPredicate): void {
  switch (predicate.op) {
    case 'and':
    case 'or':
      for (const arg of predicate.args) {
        checkPredicateFields(arg);
      }
      return;
    case 'not':
      checkPredicateFields(predicate.arg);
      return;
    default: {
      const maybe = predicate as { readonly field?: unknown; readonly op?: unknown };
      if (typeof maybe.field !== 'string') {
        throw new Error(`Unknown query predicate: ${JSON.stringify(maybe.op)}`);
      }
      checkField(maybe.field);
    }
  }
}

function fieldValue(row: StoredRow, field: string): unknown {
  switch (field) {
    case 'id':
      return row.id;
    case 'version':
      return row.version;
    case 'created':
      return row.created;
    case 'updated':
      return row.updated;
    case 'archived_at':
      return row.archivedAt;
    default: {
      checkField(field);
      const data = row.data as Record<string, unknown>;
      return Object.hasOwn(data, field) ? (data[field] ?? null) : null;
    }
  }
}

/** Normalize a comparison operand the way SQLite sees it. */
function normOperand(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  return value;
}

/** SQLite storage-class rank for ordering: numbers, then text, then rest. */
function orderRank(value: unknown): number {
  if (typeof value === 'number') {
    return 0;
  }
  if (typeof value === 'string') {
    return 1;
  }
  return 2;
}

/**
 * Three-valued comparison: null when either side is NULL (filters the row
 * out), otherwise -1/0/1 following SQLite ordering.
 */
function compareValues(left: unknown, right: unknown): number | null {
  const a = normOperand(left);
  const b = normOperand(right);
  if (a === null || b === null) {
    return null;
  }
  const rankA = orderRank(a);
  const rankB = orderRank(b);
  if (rankA !== rankB) {
    return rankA < rankB ? -1 : 1;
  }
  if (a === b) {
    return 0;
  }
  return (a as number | string) < (b as number | string) ? -1 : 1;
}

/**
 * Three-valued predicate evaluation mirroring SQLite: comparisons against
 * NULL yield NULL (which filters the row out, including under `not`), while
 * `eq`/`ne` with a NULL literal compile to IS NULL / IS NOT NULL exactly
 * like the SQL adapters. A row matches only when the top level is TRUE.
 */
function evalPredicate(predicate: QueryPredicate, row: StoredRow): boolean | null {
  switch (predicate.op) {
    case 'and': {
      let sawNull = false;
      for (const arg of predicate.args) {
        const value = evalPredicate(arg, row);
        if (value === false) {
          return false;
        }
        if (value === null) {
          sawNull = true;
        }
      }
      return sawNull ? null : true;
    }
    case 'or': {
      let sawNull = false;
      for (const arg of predicate.args) {
        const value = evalPredicate(arg, row);
        if (value === true) {
          return true;
        }
        if (value === null) {
          sawNull = true;
        }
      }
      return sawNull ? null : false;
    }
    case 'not': {
      const value = evalPredicate(predicate.arg, row);
      return value === null ? null : !value;
    }
    case 'eq': {
      if (normOperand(predicate.value) === null) {
        return normOperand(fieldValue(row, predicate.field)) === null;
      }
      const compared = compareValues(fieldValue(row, predicate.field), predicate.value);
      return compared === null ? null : compared === 0;
    }
    case 'ne': {
      if (normOperand(predicate.value) === null) {
        return normOperand(fieldValue(row, predicate.field)) !== null;
      }
      const compared = compareValues(fieldValue(row, predicate.field), predicate.value);
      return compared === null ? null : compared !== 0;
    }
    case 'lt': {
      const compared = compareValues(fieldValue(row, predicate.field), predicate.value);
      return compared === null ? null : compared === -1;
    }
    case 'lte': {
      const compared = compareValues(fieldValue(row, predicate.field), predicate.value);
      return compared === null ? null : compared <= 0;
    }
    case 'gt': {
      const compared = compareValues(fieldValue(row, predicate.field), predicate.value);
      return compared === null ? null : compared > 0;
    }
    case 'gte': {
      const compared = compareValues(fieldValue(row, predicate.field), predicate.value);
      return compared === null ? null : compared >= 0;
    }
    case 'between': {
      const field = fieldValue(row, predicate.field);
      const lo = compareValues(field, predicate.lo);
      const hi = compareValues(field, predicate.hi);
      // SQL BETWEEN is (field >= lo) AND (field <= hi) with three-valued AND:
      // FALSE AND NULL is FALSE, so NOT BETWEEN with a NULL bound can match.
      const ge = lo === null ? null : lo >= 0;
      const le = hi === null ? null : hi <= 0;
      if (ge === false || le === false) {
        return false;
      }
      if (ge === null || le === null) {
        return null;
      }
      return true;
    }
    case 'is_null': {
      return normOperand(fieldValue(row, predicate.field)) === null;
    }
    case 'not_null': {
      return normOperand(fieldValue(row, predicate.field)) !== null;
    }
    default: {
      const op = (predicate as QueryPredicate).op;
      throw new Error(`Unknown query predicate: ${JSON.stringify(op)}`);
    }
  }
}

function checkOrderTerms(order: ReadonlyArray<OrderTerm> | undefined): ReadonlyArray<OrderTerm> {
  for (const term of order ?? []) {
    if (term.direction !== 'asc' && term.direction !== 'desc') {
      throw new Error(`Invalid order direction: ${JSON.stringify(term.direction)}`);
    }
    checkField(term.field);
  }
  return order ?? [];
}

/** ORDER BY comparator: NULLs first in ASC, explicit terms, then id ASC. */
function compareRows(
  left: StoredRow,
  right: StoredRow,
  terms: ReadonlyArray<OrderTerm>,
): number {
  const effective = terms.length === 0 ? [{ field: 'created', direction: 'asc' as const }] : terms;
  for (const term of effective) {
    const a = normOperand(fieldValue(left, term.field));
    const b = normOperand(fieldValue(right, term.field));
    let compared: number;
    if (a === null && b === null) {
      compared = 0;
    } else if (a === null) {
      compared = -1;
    } else if (b === null) {
      compared = 1;
    } else {
      const rankA = orderRank(a);
      const rankB = orderRank(b);
      if (rankA !== rankB) {
        compared = rankA < rankB ? -1 : 1;
      } else if (a === b) {
        compared = 0;
      } else {
        compared = (a as number | string) < (b as number | string) ? -1 : 1;
      }
    }
    if (compared !== 0) {
      return term.direction === 'desc' ? -compared : compared;
    }
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
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
 * S7: `readStagedRows` limit must be an integer >= 1. Plain Error
 * (programmer bug), mirroring `checkSchedulesLimit` style exactly.
 */
function checkStagedRowsLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Invalid staged rows limit: ${JSON.stringify(limit)}`);
  }
}

/** S7: (model, record id) order, matching the SQL `ORDER BY` scan. */
function compareStagedRows(left: StagedRow, right: StagedRow): number {
  const leftModel = left.targetModel as string;
  const rightModel = right.targetModel as string;
  if (leftModel !== rightModel) {
    return leftModel < rightModel ? -1 : 1;
  }
  const leftId = left.recordId as string;
  const rightId = right.recordId as string;
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

/** S7: true when the staged row sorts strictly after the cursor. */
function isAfterCursor(row: StagedRow, cursor: StagedRowCursor): boolean {
  const model = row.targetModel as string;
  if (model !== cursor.model) {
    return model > cursor.model;
  }
  return (row.recordId as string) > cursor.recordId;
}

/**
 * S7: merge one staged row onto its live target. Version/data/parent always
 * come from the staged row; staged creation metadata (copied by the engine
 * from the live before-row) wins so renames preserve it, then the existing
 * live row carries over. The matching history entry (same model + record id,
 * first in chunk order) supplies updated/updatedBy — and, for rows with no
 * other source, created/createdBy as well; with no source at all the
 * metadata falls back to 0/''/null. Publish never unarchives.
 */
function mergePublishedRow(
  staged: StagedRow,
  existing: StoredRow | null,
  history: ReadonlyArray<HistoryEntry>,
): StoredRow {
  const match = history.find(
    (entry) =>
      (entry.model as string) === (staged.targetModel as string) &&
      (entry.recordId as string) === (staged.recordId as string),
  );
  return {
    id: staged.recordId,
    version: staged.version,
    created: staged.created ?? existing?.created ?? match?.at ?? 0,
    updated: match?.at ?? existing?.updated ?? 0,
    createdBy: staged.createdBy ?? existing?.createdBy ?? match?.actor ?? '',
    updatedBy: match?.actor ?? existing?.updatedBy ?? '',
    archivedAt: staged.archivedAt ?? existing?.archivedAt ?? null,
    parent: staged.parent,
    data: staged.data,
  };
}

/** S7: validate a fenced migration write's expected revision, like commit. */
function checkFencedExpected(expectedRevision: Revision, current: number): void {
  const expected = expectedRevision as number;
  if (!Number.isInteger(expected) || expected < 0) {
    throw new Error(`Invalid expectedRevision: ${JSON.stringify(expectedRevision)}`);
  }
  if (expected !== current) {
    throw new FenceConflictError(expectedRevision, current as Revision);
  }
}

/** S6: build a schedule read row; payload is deep-copied, never a live ref. */
function toScheduleEntry(
  key: string,
  row: { readonly at: number; readonly event: string; readonly payload: unknown },
): ScheduleEntry {
  return {
    key,
    at: row.at,
    event: row.event as OperationName,
    payload: jsonCopy(row.payload as Record<string, unknown>),
  };
}

/** Test-only read probe for staged state the port cannot read. */
export interface MemoryStoreProbe {
  historyFor(model: ModelName, recordId: RecordId): ReadonlyArray<HistoryEntry>;
  outboxAll(): ReadonlyArray<OutboxIntent>;
  scheduleGet(key: string): {
    readonly key: string;
    readonly at: number;
    readonly event: string;
    readonly payload: unknown;
  } | null;
}

function buildMemoryStorage(state: MemoryState): StoragePort {
  return {
    async readRevision(): Promise<Revision> {
      return state.revision as Revision;
    },

    async load(model: ModelName, id: RecordId): Promise<StoredRow | null> {
      const found = state.records.get(recordKey(model as string, id as string)) ?? null;
      if (found === null || found.model !== (model as string)) {
        return null;
      }
      return jsonCopy(found.row);
    },

    async query(spec: QuerySpec): Promise<ReadonlyArray<StoredRow>> {
      const terms = checkOrderTerms(spec.order);
      if (spec.limit !== undefined) {
        checkLimit(spec.limit);
      }
      // Validate predicate fields eagerly so malformed fields throw even
      // when no rows exist (matching the SQL adapters, which compile first).
      if (spec.where !== undefined) {
        checkPredicateFields(spec.where);
      }
      const matched: StoredRow[] = [];
      for (const record of state.records.values()) {
        if (record.model !== (spec.model as string)) {
          continue;
        }
        if (spec.parent !== undefined) {
          // S5: rows carry parent linkage (undefined counts as NULL, matching
          // the SQL NULL-column filter); only rows parented to the scoped
          // identity match.
          const parent = record.row.parent ?? null;
          if (
            parent === null ||
            (parent.model as string) !== (spec.parent.model as string) ||
            (parent.id as string) !== (spec.parent.id as string)
          ) {
            continue;
          }
        }
        if (spec.archived !== 'include' && record.row.archivedAt !== null) {
          continue;
        }
        if (spec.where !== undefined && evalPredicate(spec.where, record.row) !== true) {
          continue;
        }
        matched.push(record.row);
      }
      matched.sort((a, b) => compareRows(a, b, terms));
      const limited = spec.limit === undefined ? matched : matched.slice(0, spec.limit);
      return limited.map((row) => jsonCopy(row));
    },

    async commit(batch: CommitBatch): Promise<CommitResult> {
      const expected = batch.expectedRevision as number;
      if (!Number.isInteger(expected) || expected < 0) {
        throw new Error(`Invalid expectedRevision: ${JSON.stringify(batch.expectedRevision)}`);
      }
      if (expected !== state.revision) {
        throw new FenceConflictError(batch.expectedRevision, state.revision as Revision);
      }
      // Deep-copy every batch input FIRST: serialization failures (BigInt,
      // circular structures) must surface before anything mutates, mirroring
      // the SQL adapters, which stringify while building pre-batch statements.
      // All validation and application below run against these copies.
      const writes = batch.writes.map((write) =>
        write.kind === 'remove' ? write : { ...write, row: jsonCopy(write.row) },
      );
      const history = batch.history.map((entry) => jsonCopy(entry));
      const receipt = batch.receipt === null ? null : jsonCopy(batch.receipt);
      const outbox = batch.outbox.map((intent) => jsonCopy(intent));
      const schedules = batch.schedules.map((schedule) => jsonCopy(schedule));
      const uniqueClaims = batch.uniqueClaims.map((claim) => ({ ...claim }));
      const uniqueReleases = batch.uniqueReleases.map((release) => ({ ...release }));
      // Validate every constraint before mutating anything: a failure must
      // leave no partial state, like the rolled-back SQL batches.
      if (receipt !== null && state.receipts.has(receiptKey(receipt.identity))) {
        throw new StorageConstraintError(
          'receipt_reuse',
          `receipt ${receiptKey(receipt.identity)} already exists`,
        );
      }
      for (const write of writes) {
        if (write.kind === 'insert') {
          continue;
        }
        const current =
          state.records.get(recordKey(write.model as string, write.id as string)) ?? null;
        const expectedVersion = write.expectedVersion as number;
        const where = `${write.model as string}/${write.id as string}`;
        if (current === null) {
          throw new StorageConstraintError(
            'version',
            `version mismatch for ${where}: expected ${expectedVersion}, row is missing`,
          );
        }
        if ((current.row.version as number) !== expectedVersion) {
          throw new StorageConstraintError(
            'version',
            `version mismatch for ${where}: expected ${expectedVersion}, ` +
              `stored ${current.row.version as number}`,
            {
              model: write.model as string,
              id: write.id as string,
              version: current.row.version as number,
              updated: current.row.updated,
              updatedBy: current.row.updatedBy,
            },
          );
        }
      }
      // Releases apply before claims, mirroring the SQL statement order, so a
      // key can move between records within one batch.
      const claims = new Map(state.uniqueClaims);
      for (const release of uniqueReleases) {
        claims.delete(claimKey(release.model as string, release.keyName, release.keyValue));
      }
      for (const claim of uniqueClaims) {
        const key = claimKey(claim.model as string, claim.keyName, claim.keyValue);
        if (claims.has(key)) {
          throw new StorageConstraintError(
            'unique',
            `unique_claims ${claim.model as string}/${claim.keyName}=${claim.keyValue} already claimed`,
          );
        }
        claims.set(key, claim.recordId as string);
      }
      // Apply record writes sequentially to a scratch map with SQL semantics:
      // a same-batch duplicate insert throws (SQL PK error), update touches
      // only a present row (SQL UPDATE hits 0 rows after a same-batch remove),
      // and remove-then-insert resurrects with the new row.
      const records = new Map(state.records);
      for (const write of writes) {
        const key = recordKey(
          write.model as string,
          (write.kind === 'insert' ? write.row.id : write.id) as string,
        );
        // S5: normalize absent linkage to explicit null so memory reads match
        // the SQL backends (which return explicit null for NULL parents).
        const storedRow =
          write.kind === 'remove' ? null : { ...write.row, parent: write.row.parent ?? null };
        if (write.kind === 'insert') {
          if (records.has(key)) {
            const where = `${write.model as string}/${write.row.id as string}`;
            throw new StorageConstraintError('unknown', `record ${where} already exists`);
          }
          records.set(key, { model: write.model as string, row: storedRow as StoredRow });
        } else if (write.kind === 'update') {
          if (records.has(key)) {
            records.set(key, { model: write.model as string, row: storedRow as StoredRow });
          }
        } else {
          records.delete(key);
        }
      }
      const outboxState = new Map(state.outbox);
      const next = expected + 1;
      const at = receipt?.createdAt ?? Date.now();
      const operation = receipt === null ? 'unknown' : (receipt.identity.operation as string);
      for (const intent of outbox) {
        if (outboxState.has(intent.intentId)) {
          // S6: duplicate intent ids are uniqueness conflicts (plan: `conflict`),
          // never `unknown` — callers catch StateError, not storage errors.
          throw new StorageConstraintError(
            'unique',
            `outbox intent ${intent.intentId} already exists`,
          );
        }
        outboxState.set(intent.intentId, { intent, createdAt: at, status: 'pending' });
      }
      // S6: acks apply AFTER inserts in the same atomic commit, so acking an
      // id staged in this SAME batch marks it dispatched. Idempotent no-op on
      // unknown or already-dispatched ids (dispatchers retry at-least-once).
      // `undefined` counts as `[]` (pre-S6 batches carry no acks).
      for (const intentId of batch.outboxAck ?? []) {
        const staged = outboxState.get(intentId);
        if (staged !== undefined && staged.status === 'pending') {
          outboxState.set(intentId, { ...staged, status: 'dispatched' });
        }
      }
      const scheduleState = new Map(state.schedules);
      for (const schedule of schedules) {
        if (schedule.op === 'replace') {
          scheduleState.set(schedule.key, {
            at: schedule.at,
            event: schedule.event as string,
            payload: schedule.payload,
          });
        } else {
          scheduleState.delete(schedule.key);
        }
      }

      state.revision = next;
      state.fenceLog.set(next, { at, operation });
      state.records = records;
      state.uniqueClaims = claims;
      state.outbox = outboxState;
      state.schedules = scheduleState;
      for (const entry of history) {
        state.historySeq += 1;
        state.history.push({ seq: state.historySeq, entry });
      }
      if (receipt !== null) {
        state.receipts.set(receiptKey(receipt.identity), receipt);
      }
      return { revision: next as Revision };
    },

    async readReceipt(identity: ReceiptIdentity): Promise<Receipt | null> {
      const found = state.receipts.get(receiptKey(identity)) ?? null;
      return found === null ? null : jsonCopy(found);
    },

    async outboxPending(): Promise<ReadonlyArray<OutboxIntent>> {
      // S6: committed state only, deep copies, deterministic (createdAt,
      // intentId) order — identical to the SQL `ORDER BY created_at,
      // intent_id`. Dispatched rows are invisible here (probe still sees all).
      const pending: Array<{ readonly intent: OutboxIntent; readonly createdAt: number }> = [];
      for (const row of state.outbox.values()) {
        if (row.status === 'pending') {
          pending.push({ intent: row.intent as OutboxIntent, createdAt: row.createdAt });
        }
      }
      pending.sort(
        (a, b) =>
          a.createdAt - b.createdAt ||
          (a.intent.intentId < b.intent.intentId
            ? -1
            : a.intent.intentId > b.intent.intentId
              ? 1
              : 0),
      );
      return pending.map((row) => jsonCopy(row.intent));
    },

    async scheduleGet(key: string): Promise<ScheduleEntry | null> {
      const found = state.schedules.get(key) ?? null;
      return found === null ? null : toScheduleEntry(key, found);
    },

    async schedulesDue(now: number, limit: number): Promise<ReadonlyArray<ScheduleEntry>> {
      // S6: `at <= now`, deterministic (at, key) order matching the SQL
      // `ORDER BY at, "key"`, then the limit slice.
      checkSchedulesLimit(limit);
      const due: ScheduleEntry[] = [];
      for (const [key, row] of state.schedules) {
        if (row.at <= now) {
          due.push(toScheduleEntry(key, row));
        }
      }
      due.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return due.slice(0, limit);
    },

    async historyFor(model: ModelName, recordId: RecordId): Promise<ReadonlyArray<HistoryEntry>> {
      // S6: (version, seq) ascending, matching the SQL `ORDER BY version,
      // seq` — the seq tiebreak orders duplicate versions by insertion
      // (reachable only via direct unstaged commits). Never assume order.
      const matched = state.history.filter(
        (row) =>
          ((row.entry as HistoryEntry).model as string) === (model as string) &&
          ((row.entry as HistoryEntry).recordId as string) === (recordId as string),
      );
      matched.sort(
        (a, b) =>
          ((a.entry as HistoryEntry).version as number) -
            ((b.entry as HistoryEntry).version as number) || a.seq - b.seq,
      );
      return matched.map((row) => jsonCopy(row.entry as HistoryEntry));
    },

    async readInstalledSnapshot(owner: string): Promise<InstalledSnapshot | null> {
      // S7: null when the owner was never installed (fresh installs take a
      // separate path and never apply transitions). Deep copy, like all reads.
      const found = state.snapshots.get(owner) ?? null;
      return found === null ? null : jsonCopy(found);
    },

    async readMigrationProgress(migrationId: string): Promise<MigrationProgress | null> {
      // S7: null when the migration never staged anything.
      const found = state.progress.get(migrationId) ?? null;
      return found === null ? null : jsonCopy(found);
    },

    async readStagedRows(
      migrationId: string,
      cursor: StagedRowCursor | null,
      limit: number,
    ): Promise<ReadonlyArray<StagedRow>> {
      // S7: (model, record id) order after the cursor, capped at limit.
      checkStagedRowsLimit(limit);
      const staged = state.staging.get(migrationId);
      if (staged === undefined) {
        return [];
      }
      const rows = [...staged.values()].sort(compareStagedRows);
      const after = cursor === null ? rows : rows.filter((row) => isAfterCursor(row, cursor));
      return after.slice(0, limit).map((row) => jsonCopy(row));
    },

    async stageMigrationRows(input: StageMigrationChunk): Promise<CommitResult> {
      // S7: ONE fenced write: upsert staged rows (idempotent restage by
      // migration/model/id key) plus the progress row, atomically. Validate
      // everything before mutating anything, like commit.
      checkFencedExpected(input.expectedRevision, state.revision);
      const rows = input.rows.map((row) => jsonCopy(row));
      const progress = jsonCopy(input.progress);
      const next = state.revision + 1;
      let staged = state.staging.get(input.migrationId);
      if (staged === undefined) {
        staged = new Map();
        state.staging.set(input.migrationId, staged);
      }
      for (const row of rows) {
        staged.set(
          recordKey(row.targetModel as string, row.recordId as string),
          row,
        );
      }
      state.progress.set(input.migrationId, progress);
      state.revision = next;
      state.fenceLog.set(next, { at: Date.now(), operation: `migration:stage:${input.migrationId}` });
      return { revision: next as Revision };
    },

    async publishMigrationChunk(input: PublishMigrationChunk): Promise<CommitResult> {
      // S7: ONE fenced write: upsert live records from staged rows at their
      // target versions, insert history, dispose drops (remove + drop
      // history), and upsert progress — atomically. Validate (fence plus
      // JSON-serializability) before mutating anything.
      checkFencedExpected(input.expectedRevision, state.revision);
      const rows = input.rows.map((row) => jsonCopy(row));
      const history = input.history.map((entry) => jsonCopy(entry));
      const drops = input.drops.map((drop) => jsonCopy(drop));
      const progress = jsonCopy(input.progress);
      const next = state.revision + 1;
      const records = new Map(state.records);
      for (const row of rows) {
        const key = recordKey(row.targetModel as string, row.recordId as string);
        const existing = records.get(key) ?? null;
        const merged = mergePublishedRow(
          row,
          existing === null ? null : existing.row,
          history,
        );
        records.set(key, { model: row.targetModel as string, row: merged });
      }
      for (const drop of drops) {
        records.delete(recordKey(drop.model as string, drop.recordId as string));
      }
      // Claim moves ride the same write: releases before claims, mirroring
      // commit, so a model rename moves keys between models atomically.
      const claims = new Map(state.uniqueClaims);
      for (const release of input.uniqueReleases ?? []) {
        claims.delete(claimKey(release.model as string, release.keyName, release.keyValue));
      }
      for (const claim of input.uniqueClaims ?? []) {
        const key = claimKey(claim.model as string, claim.keyName, claim.keyValue);
        if (claims.has(key)) {
          throw new StorageConstraintError(
            'unique',
            `unique_claims ${claim.model as string}/${claim.keyName}=${claim.keyValue} already claimed`,
          );
        }
        claims.set(key, claim.recordId as string);
      }
      state.records = records;
      state.uniqueClaims = claims;
      for (const entry of history) {
        state.historySeq += 1;
        state.history.push({ seq: state.historySeq, entry });
      }
      for (const drop of drops) {
        state.historySeq += 1;
        state.history.push({ seq: state.historySeq, entry: drop.history });
      }
      state.progress.set(input.migrationId, progress);
      state.revision = next;
      state.fenceLog.set(next, {
        at: Date.now(),
        operation: `migration:publish:${input.migrationId}`,
      });
      return { revision: next as Revision };
    },

    async flipInstalledSnapshot(input: FlipInstalledSnapshot): Promise<FlipResult> {
      // S7: idempotent activation. A null snapshot is an owner REMOVAL flip
      // (dropOwner): the pointer is deleted instead of installed. Removal
      // renames nothing and installs nothing, so contradictory inputs are
      // programmer bugs. Otherwise ONE fenced write: install the pointer,
      // remove the renamed-away owner pointer, mark invalidated intents
      // skipped, record outcomes, and mark progress active — atomically.
      if (input.snapshot === null && input.renameFromOwner !== null) {
        throw new Error('flipInstalledSnapshot: a removal flip renames nothing.');
      }
      if (
        input.snapshot !== null &&
        (input.snapshot.owner as string) !== (input.owner as string)
      ) {
        throw new Error('flipInstalledSnapshot: snapshot.owner must equal the flip owner.');
      }
      const installed = state.snapshots.get(input.owner) ?? null;
      if (input.snapshot === null) {
        if (installed === null) {
          return { revision: state.revision as Revision, flipped: false };
        }
      } else if (
        installed !== null &&
        installed.snapshotId === input.snapshot.snapshotId &&
        installed.digest === input.snapshot.digest
      ) {
        return { revision: state.revision as Revision, flipped: false };
      }
      checkFencedExpected(input.expectedRevision, state.revision);
      const outcomes = input.outcomes.map((outcome) => jsonCopy(outcome));
      const next = state.revision + 1;
      if (input.snapshot === null) {
        state.snapshots.delete(input.owner);
      } else {
        const snapshot = jsonCopy(input.snapshot);
        // The engine cannot know the flip revision pre-commit: record actual.
        state.snapshots.set(input.owner, {
          ...snapshot,
          installedRevision: next as Revision,
        });
      }
      if (input.renameFromOwner !== null) {
        state.snapshots.delete(input.renameFromOwner);
      }
      for (const intentId of input.invalidatedIntentIds) {
        const staged = state.outbox.get(intentId);
        // Pending-only: unknown or already-dispatched ids are a no-op, and a
        // dispatched intent is never rewritten to skipped.
        if (staged !== undefined && staged.status === 'pending') {
          state.outbox.set(intentId, { ...staged, status: 'skipped' });
        }
      }
      const recorded = state.outcomes.get(input.migrationId) ?? [];
      recorded.push(...outcomes);
      state.outcomes.set(input.migrationId, recorded);
      const previous = state.progress.get(input.migrationId);
      state.progress.set(input.migrationId, {
        migrationId: input.migrationId,
        phase: 'active',
        stagedCursor: previous?.stagedCursor ?? null,
        publishCursor: previous?.publishCursor ?? null,
        updatedRevision: next as Revision,
      });
      state.revision = next;
      state.fenceLog.set(next, { at: Date.now(), operation: `migration:flip:${input.migrationId}` });
      return { revision: next as Revision, flipped: true };
    },

    async readMigrationOutcomes(migrationId: string): Promise<ReadonlyArray<MigrationOutcome>> {
      // S7: recorded skips in record (insertion) order. Deep copies.
      const recorded = state.outcomes.get(migrationId) ?? [];
      return recorded.map((outcome) => jsonCopy(outcome));
    },

    async recordMigrationFailure(input: RecordMigrationFailure): Promise<CommitResult> {
      // B3: ONE fenced write: mark progress failed (cursors preserved from
      // the input) plus the durable failure row, atomically. Marking an
      // active migration failed is a caller error, never a rewrite.
      checkRecoveryInput(input.migrationId, input.leg);
      checkFencedExpected(input.expectedRevision, state.revision);
      const current = state.progress.get(input.migrationId) ?? null;
      if (current !== null && current.phase === 'active') {
        throw new Error('recordMigrationFailure: migration is already active.');
      }
      if (typeof input.error !== 'string' || input.error === '') {
        throw new Error('recordMigrationFailure: error must be a non-empty string.');
      }
      const next = state.revision + 1;
      state.progress.set(input.migrationId, {
        migrationId: input.migrationId,
        phase: 'failed',
        stagedCursor: jsonCopy(input.stagedCursor),
        publishCursor: jsonCopy(input.publishCursor),
        updatedRevision: next as Revision,
      });
      state.failures.set(input.migrationId, {
        migrationId: input.migrationId,
        leg: input.leg,
        priorPhase: input.priorPhase,
        stagedCursor: jsonCopy(input.stagedCursor),
        publishCursor: jsonCopy(input.publishCursor),
        error: input.error,
        at: input.at,
        revision: next as Revision,
      });
      state.revision = next;
      state.fenceLog.set(next, {
        at: Date.now(),
        operation: `migration:failed:${input.migrationId}`,
      });
      return { revision: next as Revision };
    },

    async discardStagedRows(input: DiscardStagedRows): Promise<CommitResult> {
      // B3: ONE fenced write: delete staged rows plus the progress row, so
      // a retry restages from scratch. The failure record (when any)
      // survives as audit. Active progress refuses: no destructive
      // rollback past the flip.
      checkRecoveryInput(input.migrationId);
      checkFencedExpected(input.expectedRevision, state.revision);
      const current = state.progress.get(input.migrationId) ?? null;
      if (current !== null && current.phase === 'active') {
        throw new Error('discardStagedRows: migration is already active.');
      }
      const next = state.revision + 1;
      state.staging.delete(input.migrationId);
      state.progress.delete(input.migrationId);
      state.revision = next;
      state.fenceLog.set(next, {
        at: Date.now(),
        operation: `migration:discard:${input.migrationId}`,
      });
      return { revision: next as Revision };
    },

    async readMigrationFailure(migrationId: string): Promise<MigrationFailure | null> {
      // B3: null when the migration never failed. Deep copy, like all reads.
      const found = state.failures.get(migrationId) ?? null;
      return found === null ? null : jsonCopy(found);
    },
  };
}

/** Fresh isolated TEST-ONLY store; every instance starts at revision 0. */
export function createMemoryStorage(): StoragePort {
  return buildMemoryStorage(freshState());
}

/** TEST-ONLY store plus a probe over history/outbox/schedules for conformance. */
export function createTestMemoryStorage(): {
  readonly store: StoragePort;
  readonly probe: MemoryStoreProbe;
} {
  const state = freshState();
  return {
    store: buildMemoryStorage(state),
    probe: {
      historyFor(model: ModelName, recordId: RecordId): ReadonlyArray<HistoryEntry> {
        return state.history
          .map((row) => row.entry as HistoryEntry)
          .filter(
            (entry) =>
              (entry.model as string) === (model as string) &&
              (entry.recordId as string) === (recordId as string),
          )
          .map((entry) => jsonCopy(entry));
      },
      outboxAll(): ReadonlyArray<OutboxIntent> {
        return [...state.outbox.values()]
          .map((row) => jsonCopy(row.intent as OutboxIntent))
          .sort((a, b) => (a.intentId < b.intentId ? -1 : a.intentId > b.intentId ? 1 : 0));
      },
      scheduleGet(
        key: string,
      ): {
        readonly key: string;
        readonly at: number;
        readonly event: string;
        readonly payload: unknown;
      } | null {
        const found = state.schedules.get(key) ?? null;
        return found === null
          ? null
          : { key, at: found.at, event: found.event, payload: jsonCopy(found.payload) };
      },
    },
  };
}
