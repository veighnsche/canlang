// W02.4 — Receipt decisions + stored receipt rows, extracted from the
// work receipt donor (remainder after W02.3) and the state receipt
// tables donor. Pure: type-only contract imports (plus shared row
// metadata), no clock/RNG/evidence/host calls. Wrapper-specific
// faults are preserved per direction: work remainder throws
// RangeError plain failures; stored rows throw ReceiptTableError on
// corruption; batch linkage (linkage.ts) throws StateError
// validation. Results pass through by host reference, never cloned
// or minted here. No consumer adoption: donors keep serving callers;
// conformance/fixtures/receipts/receipt.json holds frozen independent
// originals captured from the live donors.

import type {
  AssociatedReceipt,
  OutboxItem,
  ReceiptAssociation,
  ReceiptError,
  ReceiptObservation,
  ReceiptStatus,
} from '@canlang/contracts';
import type { RecordId, RecordVersion, StoredRow } from '@canlang/contracts';
import type { NewRowMeta } from './rows.js';

/** Minimal global structuredClone shape (Node >= 22 runtime). */
declare const structuredClone: <T>(value: T) => T;

/* -- Work remainder: dead-letter, completion consistency, observation. -- */

/**
 * Dead-letter listing: every `dead` item, in stable id order, for visible
 * operator review. Projection and authorization stay with the owning reads.
 */
export function listDeadLetter(items: readonly OutboxItem[]): OutboxItem[] {
  return items
    .filter((item) => item.state === 'dead')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface RecordedReceiptFields {
  status: ReceiptStatus;
  result: unknown;
  error: ReceiptError | null;
}

/**
 * A completion envelope is consistent when its status and payload agree:
 * `succeeded` carries the declared result with a null error; `failed`
 * carries a null result with a non-null closed error; `unknown` carries a
 * null result with a diagnostic error or null; `skipped` carries nulls.
 * `pending` is a receipt, never a completion. Missing (`undefined`) payload
 * keys read as null (transport serialization drops them); anything else
 * must match exactly. Result SHAPE against the declared operation type is
 * the checker's job (L1), not this kernel's. The error shape checked here
 * is the closed `{code,message}` string pair only; redaction stays with
 * the admitting adapter.
 *
 * Never throws: completions arrive from callback paths and may be
 * arbitrarily shaped, so every check is a predicate.
 */
export function isConsistentCompletion(status: unknown, result: unknown, error: unknown): boolean {
  const payload = result === undefined ? null : result;
  const failure = error === undefined ? null : error;
  if (status === 'succeeded') {
    return failure === null;
  }
  if (status === 'failed') {
    return payload === null && isClosedErrorShape(failure);
  }
  if (status === 'unknown') {
    return payload === null && (failure === null || isClosedErrorShape(failure));
  }
  if (status === 'skipped') {
    return payload === null && failure === null;
  }
  return false;
}

function isClosedErrorShape(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as Record<string, unknown>;
  // Closed DeliveryError: exactly {code, message}, no details/retryable/
  // provider-response extras. Two string-typed code/message keys imply the
  // key set is exactly the pair. Never throws: predicate over adversary input.
  if (Object.keys(candidate).length !== 2) {
    return false;
  }
  return typeof candidate['code'] === 'string' && typeof candidate['message'] === 'string';
}

/**
 * True exactly for the terminal receipt states (`succeeded`, `failed`,
 * `skipped`). A receipt in a terminal state keeps its retained outcome
 * under every later progress envelope, cancellation and re-drive; only
 * `pending` (no outcome yet) and `unknown` (uncertain until reconciled)
 * still advance. Total over the `ReceiptStatus` vocabulary: unknown
 * strings are a shape-drift bug at the call site, never a silent
 * non-terminal verdict — callers validate stored rows first.
 */
export function isTerminalReceiptStatus(status: ReceiptStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'skipped';
}

/**
 * Assemble an authorized receipt observation from recorded fields. The
 * delivery association id and owner-checkpoint revision come from the
 * committing store; this kernel never mints them. Result and error pass
 * through by host reference.
 */
export function toReceiptObservation(
  deliveryId: string,
  revision: number,
  recorded: RecordedReceiptFields,
): ReceiptObservation {
  if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
    throw new RangeError('toReceiptObservation: deliveryId must be a non-empty string');
  }
  if (!Number.isInteger(revision) || revision < 0) {
    throw new RangeError('toReceiptObservation: revision must be a non-negative integer');
  }
  return {
    id: deliveryId,
    revision,
    status: recorded.status,
    result: recorded.result,
    error: recorded.error,
  };
}

/* -- Stored association/receipt rows (state direction). -- */

/** Fail-closed table errors; stored corruption surfaces loudly, never guessed. */
export class ReceiptTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptTableError';
  }
}

/** Stored current-attempt association rows (structural literal). */
export const RECEIPT_ASSOCIATION_MODEL = 'work.receipt_association';

/** Retained receipt rows, one per delivery attempt. */
export const RECEIPT_MODEL = 'work.receipt';

/** Current-attempt association for one (record, delivery field). Flat. */
export interface AssociationRowData {
  readonly recordModel: string;
  readonly recordId: string;
  readonly field: string;
  /** Current attempt's delivery id; completions carry it as `delivery_id`. */
  readonly deliveryId: string;
  /** Canonical source identity (declaration/binding of the send). */
  readonly source: string;
  /** Owner checkpoint revision of the latest applied receipt progress. */
  readonly revision: number;
}

/**
 * Retained receipt row: the T25a `AssociatedReceipt` plus result
 * retention. `contentRef` is null when no separately-retained content
 * exists (inline/genuinely-null result); `resultExpiresAtMs` is the
 * instant the separately-retained result expires, or null when the
 * result is retained with the summary.
 */
export interface ReceiptRowData {
  readonly deliveryId: string;
  readonly revision: number;
  readonly status: ReceiptStatus;
  readonly result: unknown;
  readonly error: ReceiptError | null;
  readonly contentRef: string | null;
  readonly resultExpiresAtMs: number | null;
}

const RECEIPT_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'succeeded',
  'failed',
  'unknown',
  'skipped',
]);

/**
 * Deterministic association row id under owner model + record + field.
 * Components are encoded so `/` separators stay unambiguous. One row
 * per locator: a second insert for the same locator collides on the
 * store primary key.
 */
export function associationRowId(model: string, recordId: string, field: string): string {
  if (model === '' || recordId === '' || field === '') {
    throw new ReceiptTableError(
      'associationRowId needs a non-empty model, recordId and field.',
    );
  }
  return `receipt-assoc/v1/${encodeURIComponent(model)}/${encodeURIComponent(recordId)}/${encodeURIComponent(field)}`;
}

function checkRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReceiptTableError(`${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function checkString(record: Record<string, unknown>, field: string, what: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value === '') {
    throw new ReceiptTableError(`${what}.${field} must be a non-empty string.`);
  }
  return value;
}

function checkRevision(record: Record<string, unknown>, field: string, what: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ReceiptTableError(`${what}.${field} must be an integer >= 0.`);
  }
  return value;
}

function checkStatus(record: Record<string, unknown>): ReceiptStatus {
  const value = record['status'];
  if (typeof value !== 'string' || !RECEIPT_STATUSES.has(value)) {
    throw new ReceiptTableError(
      `work.receipt.status is unknown: ${JSON.stringify(value)}.`,
    );
  }
  return value as ReceiptStatus;
}

function checkNullableContentRef(record: Record<string, unknown>): string | null {
  const value = record['contentRef'];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value === '') {
    throw new ReceiptTableError('work.receipt.contentRef must be a non-empty string or null.');
  }
  return value;
}

function checkNullableExpiry(record: Record<string, unknown>): number | null {
  const value = record['resultExpiresAtMs'];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ReceiptTableError(
      'work.receipt.resultExpiresAtMs must be finite epoch ms or null.',
    );
  }
  return value;
}

/** Deep JSON-safety: row data must survive the store JSON round-trip. */
function checkJsonSafe(value: unknown, what: string): void {
  const seen = new Set<object>();
  const visit = (node: unknown, path: string): void => {
    if (node === null) {
      return;
    }
    switch (typeof node) {
      case 'string':
      case 'boolean':
        return;
      case 'number':
        if (!Number.isFinite(node)) {
          throw new ReceiptTableError(`${what}${path} must be finite JSON.`);
        }
        return;
      case 'undefined':
      case 'function':
      case 'symbol':
      case 'bigint':
        throw new ReceiptTableError(`${what}${path} is not JSON-safe.`);
      case 'object': {
        if (seen.has(node)) {
          throw new ReceiptTableError(`${what}${path} is cyclic.`);
        }
        seen.add(node);
        if (Array.isArray(node)) {
          node.forEach((entry, index) => visit(entry, `${path}[${index}]`));
          return;
        }
        for (const [key, entry] of Object.entries(node)) {
          visit(entry, `${path}.${key}`);
        }
        return;
      }
    }
  };
  visit(value, '');
}

/**
 * Stored receipt-payload consistency (DESIGN section 8.0): a structural
 * mirror of the work-side completion check, EXTENDED with the pending
 * receipt rule (`pending` is a stored receipt, never progress): pending
 * carries no payload; succeeded carries no error; failed carries a
 * closed error and no result; unknown carries no result and at most a
 * closed diagnostic; skipped carries nothing. Never throws: predicate
 * over stored/caller input.
 */
export function isStoredReceiptPayload(
  status: unknown,
  result: unknown,
  error: unknown,
): boolean {
  const payload = result === undefined ? null : result;
  const failure = error === undefined ? null : error;
  if (status === 'pending') {
    return payload === null && failure === null;
  }
  if (status === 'succeeded') {
    return failure === null;
  }
  if (status === 'failed') {
    return payload === null && isClosedErrorShape(failure);
  }
  if (status === 'unknown') {
    return payload === null && (failure === null || isClosedErrorShape(failure));
  }
  if (status === 'skipped') {
    return payload === null && failure === null;
  }
  return false;
}

/** Read one association row's data, failing closed on any shape drift. */
export function readAssociationRow(row: StoredRow): ReceiptAssociation {
  const data = checkRecord(row.data, 'work.receipt_association data');
  const recordModel = checkString(data, 'recordModel', 'work.receipt_association');
  const recordId = checkString(data, 'recordId', 'work.receipt_association');
  const field = checkString(data, 'field', 'work.receipt_association');
  const deliveryId = checkString(data, 'deliveryId', 'work.receipt_association');
  const source = checkString(data, 'source', 'work.receipt_association');
  const revision = checkRevision(data, 'revision', 'work.receipt_association');
  if (row.id !== associationRowId(recordModel, recordId, field)) {
    throw new ReceiptTableError(
      'work.receipt_association row id must equal its model/record/field derivation.',
    );
  }
  return { locator: { recordId, field }, deliveryId, source, revision };
}

/** One receipt row's data: the retained receipt plus its retention binding. */
export interface StoredReceiptRow {
  readonly receipt: AssociatedReceipt;
  readonly contentRef: string | null;
  readonly resultExpiresAtMs: number | null;
}

/** Read one receipt row's data, failing closed on any shape drift. */
export function readReceiptRow(row: StoredRow): StoredReceiptRow {
  const data = checkRecord(row.data, 'work.receipt data');
  const deliveryId = checkString(data, 'deliveryId', 'work.receipt');
  const revision = checkRevision(data, 'revision', 'work.receipt');
  const status = checkStatus(data);
  const result = data['result'] === undefined ? null : data['result'];
  const error = data['error'] === undefined ? null : data['error'];
  if (!isStoredReceiptPayload(status, result, error)) {
    throw new ReceiptTableError(
      `work.receipt payload is inconsistent for status ${JSON.stringify(status)}.`,
    );
  }
  if (row.id !== deliveryId) {
    throw new ReceiptTableError('work.receipt row id must equal its deliveryId.');
  }
  return {
    receipt: {
      deliveryId,
      revision,
      status,
      result,
      error: error as ReceiptError | null,
    },
    contentRef: checkNullableContentRef(data),
    resultExpiresAtMs: checkNullableExpiry(data),
  };
}

function newRow(
  id: string,
  data: Readonly<Record<string, unknown>>,
  meta: NewRowMeta,
  what: string,
): StoredRow {
  if (!Number.isFinite(meta.nowMs) || meta.nowMs < 0) {
    throw new ReceiptTableError(`${what}: nowMs must be finite epoch ms >= 0.`);
  }
  if (typeof meta.actor !== 'string' || meta.actor === '') {
    throw new ReceiptTableError(`${what}: actor must be a non-empty string.`);
  }
  checkJsonSafe(data, `${what} data`);
  return {
    id: id as RecordId,
    version: 1 as RecordVersion,
    created: meta.nowMs,
    updated: meta.nowMs,
    createdBy: meta.actor,
    updatedBy: meta.actor,
    archivedAt: null,
    parent: null,
    // Deep clone: staged rows must not alias caller-owned nested data.
    data: structuredClone(data),
  };
}

/**
 * Replacement row for a conditional update: version + 1 with fresh
 * updated metadata. The observation revision must advance
 * monotonically (equal revisions are idempotent replays); a decreased
 * revision is stale progress and refused here, before the store. Callers
 * stage the result with `expectedVersion: row.version`.
 */
function withRowData(
  row: StoredRow,
  data: Readonly<Record<string, unknown>>,
  revision: number,
  meta: NewRowMeta,
  what: string,
): StoredRow {
  if (!Number.isFinite(meta.nowMs) || meta.nowMs < 0) {
    throw new ReceiptTableError(`${what}: nowMs must be finite epoch ms >= 0.`);
  }
  if (typeof meta.actor !== 'string' || meta.actor === '') {
    throw new ReceiptTableError(`${what}: actor must be a non-empty string.`);
  }
  const current = (row.data as Readonly<Record<string, unknown>>)['revision'];
  if (typeof current === 'number' && revision < current) {
    throw new ReceiptTableError(
      `${what}: stale revision ${revision} under current ${current}.`,
    );
  }
  checkJsonSafe(data, `${what} data`);
  return {
    ...row,
    version: (row.version + 1) as RecordVersion,
    updated: meta.nowMs,
    updatedBy: meta.actor,
    // Deep clone: staged rows must not alias caller-owned nested data.
    data: structuredClone(data),
  };
}

/** Producer-side insert: the current-attempt association for one locator. */
export function newAssociationRow(input: AssociationRowData, meta: NewRowMeta): StoredRow {
  const row = newRow(
    associationRowId(input.recordModel, input.recordId, input.field),
    input as unknown as Readonly<Record<string, unknown>>,
    meta,
    'work.receipt_association',
  );
  // The constructor validates shape, never linkage: fail fast here so a
  // malformed association never stages.
  readAssociationRow(row);
  return row;
}

/** Producer-side insert: the retained receipt row for one delivery attempt. */
export function newReceiptRow(input: ReceiptRowData, meta: NewRowMeta): StoredRow {
  const row = newRow(
    input.deliveryId,
    input as unknown as Readonly<Record<string, unknown>>,
    meta,
    'work.receipt',
  );
  readReceiptRow(row);
  return row;
}

/** Conditional-update replacement for one association row (see `withRowData`). */
export function withAssociationRowData(
  row: StoredRow,
  data: AssociationRowData,
  meta: NewRowMeta,
): StoredRow {
  const next = withRowData(
    row,
    data as unknown as Readonly<Record<string, unknown>>,
    data.revision,
    meta,
    'work.receipt_association',
  );
  readAssociationRow(next);
  return next;
}

/** Conditional-update replacement for one receipt row (see `withRowData`). */
export function withReceiptRowData(
  row: StoredRow,
  data: ReceiptRowData,
  meta: NewRowMeta,
): StoredRow {
  const next = withRowData(
    row,
    data as unknown as Readonly<Record<string, unknown>>,
    data.revision,
    meta,
    'work.receipt',
  );
  readReceiptRow(next);
  return next;
}
