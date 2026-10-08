/**
 * T25-L3 receipt join: stored association/receipt rows (L3 side).
 *
 * Structural L3 encodings of the T25a `ReceiptAssociation` /
 * `AssociatedReceipt` shapes (contracts `work.ts`) as versioned domain
 * rows in the REAL store. Lane 3 must not runtime-import lane 4 (the
 * T24a precedent), so model names, id derivations, row shapes and the
 * completion-consistency rule are structural mirrors, never imports;
 * a work-side conformance pin is future work (T34-F2 owns
 * `work/src/kernel/tables.ts`, which carries no association/receipt
 * tables yet).
 *
 * - Association row: one per (owner model, record, delivery field); id
 *   `receipt-assoc/v1/<model>/<record>/<field>`. Replacement is an
 *   ordinary versioned update selecting a new delivery id; the
 *   superseded attempt keeps its own receipt row.
 * - Receipt row: one per delivery attempt; id = delivery id. Carries
 *   the retained status/result/error plus the result-retention fields
 *   (`contentRef`, `resultExpiresAtMs`) the join's content port reads.
 *
 * `assertReceiptJoin` runs BEFORE the store (fail closed, `StateError`
 * validation); row readers throw loud `ReceiptTableError`s on stored
 * corruption, never guesses.
 */
import type {
  AssociatedReceipt,
  ReceiptAssociation,
  ReceiptError,
  ReceiptStatus,
  ReceiptResultContext,
  CanonicalNominalResult,
  TextRunResultLeaf,
  TextRunReceiptProperty,
} from '@canlang/contracts';
import { DELIVERY_RESULT_LEAVES, GENERATED_IMAGE_FIELDS } from '@canlang/contracts';
import { decodeValue, encodeValue, normalizeSchema, validateValue } from '@canlang/values';
import type { CanValue } from '@canlang/values';
import type {
  CommitBatch,
  CommitResult,
  ModelName,
  RecordId,
  RecordVersion,
  Revision,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import { StateError, storageToStateError } from '../errors.js';

/** Fail-closed table errors; stored corruption surfaces loudly, never guessed. */
export class ReceiptTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptTableError';
  }
}

/**
 * Stored current-attempt association rows. A STRUCTURAL literal, not an
 * import: lane 3 must not runtime-import lane 4 (`@canlang/work` owns
 * the `work.*` namespace), so the join matches rows by model name plus
 * the flat data fields below.
 */
export const RECEIPT_ASSOCIATION_MODEL = 'work.receipt_association';

/** Retained receipt rows, one per delivery attempt. See above. */
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

/** Closed selectors derived from the one owning nominal declaration. */
export const TEXT_RUN_RECEIPT_PROPERTIES: readonly TextRunReceiptProperty[] = Object.freeze(
  DELIVERY_RESULT_LEAVES['TextRun']!.map(leaf => `result.${leaf.name}` as TextRunReceiptProperty),
);

export function isCanonicalTextRunDeclaration(declaration: CanonicalNominalResult | undefined): boolean {
  const leaves = DELIVERY_RESULT_LEAVES['TextRun']!;
  return declaration?.name === 'TextRun' && Array.isArray(declaration.fields) &&
    declaration.fields.length === leaves.length && leaves.every(expected =>
      declaration.fields.filter(leaf => leaf?.name === expected.name && leaf.type === expected.type).length === 1);
}

export function isTextRunReceiptContext(context: ReceiptResultContext | undefined): boolean {
  return context !== undefined &&
    ['std.TextGenerationV1.generate', 'std.TextGenerationV1.cancel', 'std.TextGenerationV1.reconcile'].includes(context.source) &&
    isCanonicalTextRunDeclaration(context.declaredResult);
}

export interface CheckedTextRunResult {
  readonly fields: Readonly<Record<TextRunResultLeaf, string | null>>;
  readonly revision: bigint;
  readonly sequence: bigint;
  readonly usedTokens: bigint | null;
}

/** Exact own data fields and the existing Values scalar codec; never invokes payload accessors. */
export function readTextRunResult(result: unknown, declaration: CanonicalNominalResult | undefined): CheckedTextRunResult | null {
  if (!isCanonicalTextRunDeclaration(declaration) || typeof result !== 'object' || result === null ||
      Array.isArray(result) || (Object.getPrototypeOf(result) !== Object.prototype && Object.getPrototypeOf(result) !== null)) return null;
  const leaves = DELIVERY_RESULT_LEAVES['TextRun']!;
  if (Reflect.ownKeys(result).length !== leaves.length) return null;
  const fields = {} as Record<TextRunResultLeaf, string | null>;
  const decoded = new Map<string, unknown>();
  try {
    for (const leaf of leaves) {
      const property = Object.getOwnPropertyDescriptor(result, leaf.name);
      if (property === undefined || !Object.hasOwn(property, 'value') || !property.enumerable) return null;
      const value: unknown = property.value;
      if (value !== null && typeof value !== 'string') return null;
      const scalar = decodeValue(leaf.type, value);
      if ((leaf.type === 'int' || leaf.type === 'int?') && encodeValue(leaf.type, scalar) !== value) return null;
      decoded.set(leaf.name, scalar);
      fields[leaf.name as TextRunResultLeaf] = value as string | null;
    }
  } catch { return null; }
  const revision = decoded.get('revision');
  const sequence = decoded.get('sequence');
  const usedTokens = decoded.get('used_tokens');
  if (typeof revision !== 'bigint' || typeof sequence !== 'bigint' || sequence < 0n ||
      (usedTokens !== null && (typeof usedTokens !== 'bigint' || usedTokens < 0n))) return null;
  return { fields, revision, sequence, usedTokens };
}

/** Rich state describes the run; receipt status describes the delivered observation. */
export function isTextRunReceiptPayload(status: unknown, result: unknown, error: unknown, context: ReceiptResultContext | undefined): boolean {
  if (!isTextRunReceiptContext(context)) return false;
  const run = readTextRunResult(result, context!.declaredResult);
  if (run === null) return false;
  if (context!.request !== undefined) {
    try {
      if (run.fields.source !== context!.request.source || run.revision !== decodeValue('int', context!.request.revision)) return false;
    } catch { return false; }
  }
  const state = run.fields.state;
  const failure = error === undefined ? null : error;
  if (state === 'queued' || state === 'running') return status === 'pending' && failure === null;
  if (state === 'unknown') return status === 'unknown' && (failure === null || isClosedErrorShape(failure));
  return status === 'succeeded' && failure === null;
}

const GENERATED_IMAGE_SCHEMA = normalizeSchema({ contracts: { GeneratedImage: {
  fields: Object.fromEntries(GENERATED_IMAGE_FIELDS.map(field => [field.name, { type: field.type }])),
} } });

export function isCanonicalImageRunDeclaration(declaration: CanonicalNominalResult | undefined): boolean {
  const leaves = DELIVERY_RESULT_LEAVES['ImageRun']!;
  return declaration?.name === 'ImageRun' && Array.isArray(declaration.fields) &&
    declaration.fields.length === leaves.length && leaves.every(expected =>
      declaration.fields.filter(leaf => leaf?.name === expected.name && leaf.type === expected.type).length === 1);
}

export function isImageRunReceiptContext(context: ReceiptResultContext | undefined): boolean {
  return context !== undefined &&
    ['std.ImagesV1.submit', 'std.ImagesV1.cancel', 'std.ImagesV1.reconcile'].includes(context.source) &&
    isCanonicalImageRunDeclaration(context.declaredResult);
}

export interface CheckedImageRunResult {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly outputs: CanValue;
  readonly revision: bigint;
  readonly sequence: bigint;
  readonly chargedJobs: bigint | null;
}

/** Bounded own-data snapshot before Values reads nested data; no getters, inherited data or omissions. */
function snapshotImageOutputData(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object' || depth > 2) throw new Error('invalid nested output data');
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new Error('invalid nested output prototype');
  }
  const keys = Reflect.ownKeys(value);
  const out: Record<string, unknown> | unknown[] = array ? [] : Object.create(null) as Record<string, unknown>;
  if (array && keys.length !== value.length + 1) throw new Error('sparse or extended output array');
  for (const key of keys) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string' || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) {
      throw new Error('invalid output key');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new Error('invalid output accessor');
    }
    (out as Record<string, unknown>)[key] = snapshotImageOutputData(descriptor.value, depth + 1);
  }
  return out;
}

/** Canonical source ImageRun, never the provider byte-result shape. File shape alone adds no authority. */
export function readImageRunResult(result: unknown, declaration: CanonicalNominalResult | undefined): CheckedImageRunResult | null {
  if (!isCanonicalImageRunDeclaration(declaration) || typeof result !== 'object' || result === null ||
      Array.isArray(result) || (Object.getPrototypeOf(result) !== Object.prototype && Object.getPrototypeOf(result) !== null)) return null;
  const leaves = DELIVERY_RESULT_LEAVES['ImageRun']!;
  if (Reflect.ownKeys(result).length !== leaves.length) return null;
  const fields: Record<string, unknown> = {};
  const decoded = new Map<string, CanValue>();
  try {
    for (const leaf of leaves) {
      const property = Object.getOwnPropertyDescriptor(result, leaf.name);
      if (property === undefined || !Object.hasOwn(property, 'value') || !property.enumerable) return null;
      const value: unknown = property.value;
      if (leaf.name === 'outputs') {
        const snapshot = snapshotImageOutputData(value);
        const outputs = validateValue(GENERATED_IMAGE_SCHEMA, leaf.type, snapshot, 'create');
        // Values decodes exact integers; require their canonical wire spelling too.
        if (!Array.isArray(outputs) || !Array.isArray(snapshot) || outputs.some((output, index) =>
          encodeValue('int', (output as Record<string, CanValue>)['position']!) !==
            (snapshot[index] as Record<string, unknown>)['position'])) return null;
        decoded.set(leaf.name, outputs);
      } else {
        if (value !== null && typeof value !== 'string') return null;
        const scalar = decodeValue(leaf.type, value);
        if ((leaf.type === 'int' || leaf.type === 'int?') && encodeValue(leaf.type, scalar) !== value) return null;
        decoded.set(leaf.name, scalar);
      }
      fields[leaf.name] = value;
    }
  } catch { return null; }
  const revision = decoded.get('revision');
  const sequence = decoded.get('sequence');
  const chargedJobs = decoded.get('charged_jobs');
  if (typeof revision !== 'bigint' || typeof sequence !== 'bigint' || sequence < 0n ||
      (chargedJobs !== null && (typeof chargedJobs !== 'bigint' || chargedJobs < 0n))) return null;
  return { fields, outputs: decoded.get('outputs')!, revision, sequence, chargedJobs };
}

export function isImageRunReceiptPayload(status: unknown, result: unknown, error: unknown, context: ReceiptResultContext | undefined): boolean {
  if (!isImageRunReceiptContext(context)) return false;
  const run = readImageRunResult(result, context!.declaredResult);
  if (run === null) return false;
  if (context!.request !== undefined) {
    try {
      const revision = decodeValue('int', context!.request.revision);
      if (encodeValue('int', revision) !== context!.request.revision ||
          run.fields.source !== context!.request.source || run.revision !== revision) return false;
    } catch { return false; }
  }
  const failure = error === undefined ? null : error;
  if (run.fields.state === 'queued' || run.fields.state === 'running') return status === 'pending' && failure === null;
  if (run.fields.state === 'unknown') return status === 'unknown' && (failure === null || isClosedErrorShape(failure));
  return status === 'succeeded' && failure === null;
}

/**
 * Deterministic association row id under owner model + record + field.
 * Components are encoded so `/` separators stay unambiguous (the
 * `everySlotRowId` precedent). One row per locator: a second insert
 * for the same locator collides on the store primary key.
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
 * Closed safe-error shape: exactly {code, message}, no extras.
 * Structural mirror of the work-side closed-error predicate.
 */
function isClosedErrorShape(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as Record<string, unknown>;
  if (Object.keys(candidate).length !== 2) {
    return false;
  }
  return typeof candidate['code'] === 'string' && typeof candidate['message'] === 'string';
}

/**
 * Stored receipt-payload consistency (DESIGN section 8.0): a structural
 * mirror of the work-side completion check. Context-free pending carries
 * no payload; checked TextRun context additionally admits pending/unknown
 * run snapshots. Succeeded carries no error; failed carries a
 * closed error and no result; unknown carries no result and at most a
 * closed diagnostic; skipped carries nothing. Never throws: predicate
 * over stored/caller input. Agreement with the work-side check over
 * every non-pending status is pinned by the join tests against the
 * real function.
 */
export function isStoredReceiptPayload(
  status: unknown,
  result: unknown,
  error: unknown,
  context?: ReceiptResultContext,
): boolean {
  const payload = result === undefined ? null : result;
  const failure = error === undefined ? null : error;
  // Explicit TextGeneration declaration context never falls through to an
  // untyped succeeded payload after a malformed rich result.
  if (payload !== null && context !== undefined && context.source.startsWith('std.TextGenerationV1.')) {
    return isTextRunReceiptPayload(status, payload, failure, context);
  }
  if (payload !== null && context !== undefined &&
      ['std.ImagesV1.submit', 'std.ImagesV1.cancel', 'std.ImagesV1.reconcile'].includes(context.source)) {
    return isImageRunReceiptPayload(status, payload, failure, context);
  }
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
export function readReceiptRow(row: StoredRow, context?: ReceiptResultContext): StoredReceiptRow {
  const data = checkRecord(row.data, 'work.receipt data');
  const deliveryId = checkString(data, 'deliveryId', 'work.receipt');
  const revision = checkRevision(data, 'revision', 'work.receipt');
  const status = checkStatus(data);
  const result = data['result'] === undefined ? null : data['result'];
  const error = data['error'] === undefined ? null : data['error'];
  if (!isStoredReceiptPayload(status, result, error, context)) {
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

export interface NewRowMeta {
  /** UTC epoch ms for created/updated. */
  readonly nowMs: number;
  /** Actor identity for createdBy/updatedBy. */
  readonly actor: string;
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
export function newReceiptRow(input: ReceiptRowData, meta: NewRowMeta, context?: ReceiptResultContext): StoredRow {
  if (input.result != null && context !== undefined && (context.source.startsWith('std.TextGenerationV1.') ||
      ['std.ImagesV1.submit', 'std.ImagesV1.cancel', 'std.ImagesV1.reconcile'].includes(context.source)) &&
      !isStoredReceiptPayload(input.status, input.result, input.error, context)) {
    throw new ReceiptTableError('work.receipt payload is inconsistent for its declared context.');
  }
  const row = newRow(
    input.deliveryId,
    input as unknown as Readonly<Record<string, unknown>>,
    meta,
    'work.receipt',
  );
  readReceiptRow(row, context);
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
  context?: ReceiptResultContext,
): StoredRow {
  if (data.result != null && context !== undefined && (context.source.startsWith('std.TextGenerationV1.') ||
      ['std.ImagesV1.submit', 'std.ImagesV1.cancel', 'std.ImagesV1.reconcile'].includes(context.source)) &&
      !isStoredReceiptPayload(data.status, data.result, data.error, context)) {
    throw new ReceiptTableError('work.receipt payload is inconsistent for its declared context.');
  }
  const next = withRowData(
    row,
    data as unknown as Readonly<Record<string, unknown>>,
    data.revision,
    meta,
    'work.receipt',
  );
  readReceiptRow(next, context);
  return next;
}

interface JoinWrite {
  readonly model: string;
  readonly id: string;
  readonly deliveryId: string;
  readonly revision: number;
}

function readJoinWrite(
  model: string,
  row: StoredRow,
  updateId: string | null,
  contexts?: ReadonlyMap<string, ReceiptResultContext>,
): JoinWrite {
  if (updateId !== null && updateId !== row.id) {
    throw new StateError(
      'validation',
      `Receipt join: ${model} update id ${JSON.stringify(updateId)} ` +
        `must equal its row id ${JSON.stringify(row.id)}.`,
    );
  }
  try {
    if (model === RECEIPT_ASSOCIATION_MODEL) {
      const association = readAssociationRow(row);
      return {
        model,
        id: row.id as string,
        deliveryId: association.deliveryId,
        revision: association.revision,
      };
    }
    const deliveryId = checkString(checkRecord(row.data, 'work.receipt data'), 'deliveryId', 'work.receipt');
    const stored = readReceiptRow(row, contexts?.get(deliveryId));
    return {
      model,
      id: row.id as string,
      deliveryId: stored.receipt.deliveryId,
      revision: stored.receipt.revision,
    };
  } catch (error) {
    if (error instanceof ReceiptTableError) {
      throw new StateError('validation', `Receipt join: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Assert the receipt-join linkage for one commit batch BEFORE it touches
 * the store (fail closed, `StateError` validation):
 *
 * - Every association insert/update carries a receipt insert/update for
 *   the SAME delivery id at the SAME revision in the same batch: the
 *   current-attempt pair advances together, never apart. Initial
 *   association, replacement (new delivery id + new pending receipt)
 *   and current-attempt progress all stage both halves.
 * - Receipt-only writes are allowed: superseded attempts update their
 *   own receipt rows without touching the current association, and
 *   fixtures may provision receipt rows before associating them.
 * - Same-batch duplicate writes to one row and update id/row id
 *   mismatches fail closed.
 *
 * Ordinary batches with neither half pass trivially, so non-receipt
 * callers are unaffected. Claim-style conditional updates on other
 * models pass trivially too.
 */
export function assertReceiptJoin(batch: CommitBatch, contexts?: ReadonlyMap<string, ReceiptResultContext>): void {
  const associations = new Map<string, JoinWrite>();
  const receipts = new Map<string, JoinWrite>();
  const seen = new Set<string>();
  for (const write of batch.writes ?? []) {
    const model = write.model as string;
    if (model !== RECEIPT_ASSOCIATION_MODEL && model !== RECEIPT_MODEL) {
      continue;
    }
    if (write.kind === 'remove') {
      continue;
    }
    const rowId = (write.kind === 'insert' ? write.row.id : write.id) as string;
    const key = `${model}\0${rowId}`;
    if (seen.has(key)) {
      throw new StateError(
        'validation',
        `Receipt join: duplicate ${model} write for ${JSON.stringify(rowId)}.`,
      );
    }
    seen.add(key);
    const join =
      write.kind === 'insert'
        ? readJoinWrite(model, write.row, null, contexts)
        : readJoinWrite(model, write.row, write.id as string, contexts);
    if (model === RECEIPT_ASSOCIATION_MODEL) {
      const context = contexts?.get(join.deliveryId);
      if (context !== undefined && readAssociationRow(write.row).source !== context.source) {
        throw new StateError('validation', 'Receipt join: declaration context disagrees with association source.');
      }
      associations.set(join.deliveryId, join);
    } else {
      receipts.set(join.deliveryId, join);
    }
  }
  for (const association of associations.values()) {
    const receipt = receipts.get(association.deliveryId);
    if (receipt === undefined) {
      throw new StateError(
        'validation',
        `Receipt join: association for ${JSON.stringify(association.deliveryId)} ` +
          'has no receipt row in this batch.',
      );
    }
    if (receipt.revision !== association.revision) {
      throw new StateError(
        'validation',
        `Receipt join: receipt revision ${receipt.revision} disagrees with ` +
          `association revision ${association.revision} for ` +
          `${JSON.stringify(association.deliveryId)}.`,
      );
    }
  }
}

/** Single-shot receipt-join commit surface (no retry — callers decide). */
export interface ReceiptJoinPort {
  commitJoin(batch: CommitBatch & { expectedRevision: Revision }): Promise<CommitResult>;
}

/**
 * Create the receipt-join port over one store: linkage-asserted,
 * single-shot fenced commit. Storage errors map via
 * `storageToStateError` (fence conflicts surface as retryable `busy`),
 * mirroring `createTransactionPort`.
 */
export function createReceiptJoinPort(input: { readonly store: StoragePort;
  readonly resultContexts?: (batch: CommitBatch) => ReadonlyMap<string, ReceiptResultContext> }): ReceiptJoinPort {
  return {
    commitJoin: async (batch) => {
      assertReceiptJoin(batch, input.resultContexts?.(batch));
      try {
        return await input.store.commit(batch);
      } catch (error) {
        throw storageToStateError(error);
      }
    },
  };
}
