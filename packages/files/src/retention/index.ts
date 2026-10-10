/**
 * Retention and garbage collection (DESIGN section 8).
 *
 * Completed but unreferenced objects are garbage-collected after the
 * receipt/attachment horizon (bytes deleted, record kept as an `orphaned`
 * tombstone); retention expiry moves records to `expired`. Attached
 * objects keep bytes until retention elapses. Receipts and outbox
 * projections must render through `describeForReceipt`, which redacts
 * expired bytes while retaining the safe metadata summary — redaction
 * never recalls provider copies, and bytes are never embedded in
 * projections.
 */
import type {
  FinalizedFileRef,
  UploadIntentId,
} from '@canlang/contracts';
import type {
  BlobStorePort,
  ClockPort,
  FinalizedStorePort,
  IntentStorePort,
  PagedFinalizedStorePort,
  PagedIntentStorePort,
  StoredFileRecord,
  UploadIntentRecord,
} from '../ports.js';
import { assertSafeBlobKey } from '../ports.js';
import { blobKeyForFile } from '../finalize/index.js';
import { stagingKeyForIntent } from '../upload/index.js';

export interface RetentionDeps {
  readonly clock: ClockPort;
  readonly blobs: BlobStorePort;
  readonly files: FinalizedStorePort;
  readonly intents: IntentStorePort;
}

export interface RetentionConfig {
  /** Horizon after which unattached finalized bytes are collected. */
  readonly unattachedHorizonMs: number;
  /** Retention after which records expire and bytes redact. */
  readonly retentionMs: number;
}

export interface RetentionReport {
  readonly orphaned: FinalizedFileRef[];
  readonly expired: FinalizedFileRef[];
  readonly sweptIntents: UploadIntentId[];
}

/**
 * Receipt/outbox file projection: safe metadata summary plus a byte
 * availability flag. Redacted entries carry no bytes and no byte access;
 * unknown references project to null (fail closed, no disclosure).
 */
export interface ReceiptProjection {
  readonly file: FinalizedFileRef;
  readonly status: 'available' | 'redacted';
  readonly contentType: string;
  readonly sizeBytes: number;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function removeUnpublishedFinalBytes(
  deps: RetentionDeps, record: UploadIntentRecord, onLookup?: () => void,
): void {
  const claim = record.pendingFinalization;
  if (claim !== undefined) {
    onLookup?.();
    if (deps.files.get(claim.ref) === null) deps.blobs.remove(blobKeyForFile(claim.ref));
  }
}

/** A batch bounds traversed records and their auxiliary metadata lookups. */
export const MAX_RETENTION_BATCH_ROWS = 1000;

export interface PagedRetentionDeps extends RetentionDeps {
  readonly files: PagedFinalizedStorePort;
  readonly intents: PagedIntentStorePort;
}

/** Position only; it confers no file authority or frozen sweep membership. */
export type RetentionCursor =
  | { readonly phase: 'intents'; readonly after: UploadIntentId | null }
  | { readonly phase: 'files'; readonly after: FinalizedFileRef | null };

export interface RetentionBatchOptions {
  /** Combined traversal/processing budget across both collections, 1–1000.
   * Pending intents need at most one auxiliary file lookup each, so total
   * metadata read units are bounded by twice this limit. */
  readonly limit: number;
  /** Null or omitted starts a new sweep, including previously visited rows. */
  readonly cursor?: RetentionCursor | null;
}

export interface RetentionBatchReport extends RetentionReport {
  /** Every visited record counts, including ineligible and terminal records. */
  readonly processed: number;
  /** Traversed rows plus point lookups (including absent results), <= 2 * limit.
   * Byte-size checks and idempotent deletions are separate bounded operations. */
  readonly metadataReads: number;
  /** Null ends this sweep. Persist a returned position only after success. */
  readonly next: RetentionCursor | null;
}

function retentionNow(deps: RetentionDeps, config: RetentionConfig, operation: string): number {
  if (
    !Number.isFinite(config.unattachedHorizonMs) ||
    config.unattachedHorizonMs < 0 ||
    !Number.isFinite(config.retentionMs) ||
    config.retentionMs < 0
  ) {
    throw new RangeError(`${operation}: horizons must be finite and >= 0`);
  }
  const nowMs = deps.clock.nowMs();
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new RangeError(`${operation}: clock must be finite and >= 0`);
  }
  return nowMs;
}

function newReport(): RetentionReport {
  return { orphaned: [], expired: [], sweptIntents: [] };
}

function sortReport(report: RetentionReport): void {
  report.orphaned.sort(compareStrings);
  report.expired.sort(compareStrings);
  report.sweptIntents.sort(compareStrings);
}

function sweepIntent(
  deps: RetentionDeps, record: UploadIntentRecord, nowMs: number, report: RetentionReport,
  onLookup?: () => void,
): void {
  if (record.state === 'finalized') {
    // Publication can commit before staging cleanup on a separate byte store.
    // The published file keeps its own retention policy.
    const stagingKey = stagingKeyForIntent(record.intentId);
    if (deps.blobs.sizeOf(stagingKey) !== null) deps.blobs.remove(stagingKey);
    return;
  }
  if (record.state === 'expired' || record.state === 'rejected') {
    deps.blobs.remove(stagingKeyForIntent(record.intentId));
    removeUnpublishedFinalBytes(deps, record, onLookup);
    return;
  }
  if ((record.state === 'open' || record.state === 'complete') && nowMs >= record.expiresAtMs) {
    record.state = 'expired';
    record.receivedBytes = 0;
    record.bytesDigest = null;
    record.detectedType = null;
    deps.intents.put(record);
    deps.blobs.remove(stagingKeyForIntent(record.intentId));
    removeUnpublishedFinalBytes(deps, record, onLookup);
    report.sweptIntents.push(record.intentId);
  }
}

function sweepFile(
  deps: RetentionDeps, stored: StoredFileRecord, nowMs: number,
  config: RetentionConfig, report: RetentionReport,
): void {
  const horizonElapsed = nowMs >= stored.finalizedAtMs + config.unattachedHorizonMs;
  const retentionElapsed = nowMs >= stored.finalizedAtMs + config.retentionMs;
  if (stored.state === 'orphaned') {
    if (retentionElapsed) {
      stored.state = 'expired';
      deps.files.put(stored);
      report.expired.push(stored.file.id);
    }
    deps.blobs.remove(blobKeyForFile(stored.file.id));
    return;
  }
  if (stored.state === 'expired') {
    deps.blobs.remove(blobKeyForFile(stored.file.id));
    return;
  }
  if (retentionElapsed) {
    stored.state = 'expired';
    deps.files.put(stored);
    deps.blobs.remove(blobKeyForFile(stored.file.id));
    report.expired.push(stored.file.id);
    return;
  }
  if (stored.state === 'finalized' && horizonElapsed) {
    stored.state = 'orphaned';
    deps.files.put(stored);
    deps.blobs.remove(blobKeyForFile(stored.file.id));
    report.orphaned.push(stored.file.id);
  }
}

/**
 * Legacy full-list sweep. Terminal states are saved before byte deletion;
 * later sweeps retry cleanup without reporting the same transition again.
 * This API materializes both collections and provides no bounded traversal.
 */
export function runRetention(deps: RetentionDeps, config: RetentionConfig): RetentionReport {
  const nowMs = retentionNow(deps, config, 'runRetention');
  const report = newReport();
  for (const record of deps.intents.listAll()) sweepIntent(deps, record, nowMs, report);
  for (const stored of deps.files.listAll()) sweepFile(deps, stored, nowMs, config, report);
  sortReport(report);
  return report;
}

function checkedBatch(options: RetentionBatchOptions): { limit: number; cursor: RetentionCursor } {
  const limit = options.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RETENTION_BATCH_ROWS) {
    throw new RangeError('runRetentionBatch: limit must be an integer from 1 through 1000');
  }
  const cursor = options.cursor;
  if (cursor === undefined || cursor === null) return { limit, cursor: { phase: 'intents', after: null } };
  if (typeof cursor !== 'object') throw new TypeError('runRetentionBatch: invalid cursor');
  const phase = cursor.phase;
  const after = cursor.after;
  if (phase !== 'intents' && phase !== 'files') {
    throw new TypeError('runRetentionBatch: invalid cursor phase');
  }
  if (after !== null) assertSafeBlobKey(after);
  return { limit, cursor: { phase, after } };
}

function checkPage<T>(page: T[], after: string | null, limit: number, key: (record: T) => string): void {
  if (!Array.isArray(page) || page.length > limit) throw new Error('Invalid retention storage page.');
  let previous = after;
  for (const record of page) {
    const id = key(record);
    assertSafeBlobKey(id);
    if (previous !== null && compareStrings(id, previous) <= 0) {
      throw new Error('Retention storage page is not strictly ordered after its cursor.');
    }
    previous = id;
  }
}

/**
 * Traverse/process at most `limit` rows, across intents then files. A
 * pending intent needs at most one file-record lookup to protect published
 * bytes, so total metadata read units are at most `2 * limit`. Byte-size
 * checks and deletion operations are bounded per visited row separately.
 * Both page producers must bound their queries; there is no full-list
 * fallback or lookahead row. A full page may need an empty final probe.
 *
 * Cleanup must succeed before a continuation is returned. Retry a failed
 * call with its old cursor; terminal metadata keeps separate byte cleanup
 * retryable, and the selected SQLite binding rolls the whole batch back.
 * Restart after `next === null` to revisit newly due records and insertions
 * before the cursor. Clock and membership are observed afresh per batch;
 * this does not establish a frozen sweep, concurrent filesystem fence or
 * an exact disposal deadline.
 */
export function runRetentionBatch(
  deps: PagedRetentionDeps, config: RetentionConfig, options: RetentionBatchOptions,
): RetentionBatchReport {
  const { cursor, limit } = checkedBatch(options);
  const nowMs = retentionNow(deps, config, 'runRetentionBatch');
  const report = newReport();
  let processed = 0;
  let auxiliaryLookups = 0;
  let next: RetentionCursor | null = null;
  if (cursor.phase === 'intents') {
    const page = deps.intents.listAfter(cursor.after, limit);
    checkPage(page, cursor.after, limit, record => record.intentId);
    for (const record of page) {
      sweepIntent(deps, record, nowMs, report, () => { auxiliaryLookups += 1; });
      processed += 1;
    }
    if (processed === limit) {
      next = Object.freeze({ phase: 'intents', after: page[page.length - 1]!.intentId });
    }
  }
  if (next === null) {
    const after = cursor.phase === 'files' ? cursor.after : null;
    const remaining = limit - processed;
    const page = deps.files.listAfter(after, remaining);
    checkPage(page, after, remaining, record => record.file.id);
    for (const stored of page) {
      sweepFile(deps, stored, nowMs, config, report);
      processed += 1;
    }
    if (processed === limit) {
      next = Object.freeze({ phase: 'files', after: page[page.length - 1]!.file.id });
    }
  }
  sortReport(report);
  return { ...report, processed, metadataReads: processed + auxiliaryLookups, next };
}

/**
 * Project a finalized reference for receipts/outbox. Available only
 * while the record is live and bytes are present; anything else
 * redacts. Metadata (content type, size) survives redaction as the safe
 * summary.
 */
export function describeForReceipt(
  deps: Pick<RetentionDeps, 'files' | 'blobs'>,
  ref: FinalizedFileRef,
): ReceiptProjection | null {
  const stored = deps.files.get(ref);
  if (stored === null) {
    return null;
  }
  const live = stored.state === 'finalized' || stored.state === 'attached';
  const bytesPresent =
    live && deps.blobs.sizeOf(blobKeyForFile(stored.file.id)) !== null;
  return {
    file: stored.file.id,
    status: bytesPresent ? 'available' : 'redacted',
    contentType: stored.file.contentType,
    sizeBytes: stored.file.sizeBytes,
  };
}
