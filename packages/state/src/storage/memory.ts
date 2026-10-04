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
  HistoryEntry,
  ModelName,
  OrderTerm,
  OutboxIntent,
  QueryPredicate,
  QuerySpec,
  Receipt,
  ReceiptIdentity,
  RecordId,
  Revision,
  StoredRow,
} from '../../../contracts/src/state.js';
import { FenceConflictError, StorageConstraintError } from './port.js';
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

/** Stored record: S2 rows store no parent linkage yet. */
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
  outbox: Map<string, { readonly intent: unknown; readonly createdAt: number }>;
  schedules: Map<string, { readonly at: number; readonly event: string; readonly payload: unknown }>;
  uniqueClaims: Map<string, string>;
  historySeq: number;
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
          // S2 stores no parent linkage yet, so a scoped query matches
          // nothing (mirroring the SQL NULL-column filter); a later slice
          // stores the linkage and enables positive scoping.
          continue;
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
        if (write.kind === 'insert') {
          if (records.has(key)) {
            const where = `${write.model as string}/${write.row.id as string}`;
            throw new StorageConstraintError('unknown', `record ${where} already exists`);
          }
          records.set(key, { model: write.model as string, row: write.row });
        } else if (write.kind === 'update') {
          if (records.has(key)) {
            records.set(key, { model: write.model as string, row: write.row });
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
          throw new StorageConstraintError(
            'unknown',
            `outbox intent ${intent.intentId} already exists`,
          );
        }
        outboxState.set(intent.intentId, { intent, createdAt: at });
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
