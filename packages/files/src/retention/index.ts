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
} from '../../../contracts/src/files.js';
import type {
  BlobStorePort,
  ClockPort,
  FinalizedStorePort,
  IntentStorePort,
} from '../ports.ts';
import { blobKeyForFile } from '../finalize/index.ts';
import { stagingKeyForIntent } from '../upload/index.ts';

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

/**
 * Run one retention pass: sweep expired intents (staging deleted),
 * orphan unattached objects past the horizon (bytes deleted), and expire
 * records past retention. The report lists every transition in stable
 * order; the pass is idempotent.
 */
export function runRetention(
  deps: RetentionDeps,
  config: RetentionConfig,
): RetentionReport {
  if (
    !Number.isFinite(config.unattachedHorizonMs) ||
    config.unattachedHorizonMs < 0 ||
    !Number.isFinite(config.retentionMs) ||
    config.retentionMs < 0
  ) {
    throw new RangeError('runRetention: horizons must be finite and >= 0');
  }
  const nowMs = deps.clock.nowMs();
  const orphaned: FinalizedFileRef[] = [];
  const expired: FinalizedFileRef[] = [];
  const sweptIntents: UploadIntentId[] = [];

  for (const record of deps.intents.listAll()) {
    if (
      (record.state === 'open' || record.state === 'complete') &&
      nowMs >= record.expiresAtMs
    ) {
      record.state = 'expired';
      record.receivedBytes = 0;
      record.bytesDigest = null;
      record.detectedType = null;
      deps.blobs.remove(stagingKeyForIntent(record.intentId));
      deps.intents.put(record);
      sweptIntents.push(record.intentId);
    }
  }

  for (const stored of deps.files.listAll()) {
    const horizonElapsed = nowMs >= stored.finalizedAtMs + config.unattachedHorizonMs;
    const retentionElapsed = nowMs >= stored.finalizedAtMs + config.retentionMs;
    if (stored.state === 'orphaned') {
      if (retentionElapsed) {
        stored.state = 'expired';
        deps.files.put(stored);
        expired.push(stored.file.id);
      }
      continue;
    }
    if (stored.state === 'expired') {
      continue;
    }
    if (retentionElapsed) {
      deps.blobs.remove(blobKeyForFile(stored.file.id));
      stored.state = 'expired';
      deps.files.put(stored);
      expired.push(stored.file.id);
      continue;
    }
    if (stored.state === 'finalized' && horizonElapsed) {
      deps.blobs.remove(blobKeyForFile(stored.file.id));
      stored.state = 'orphaned';
      deps.files.put(stored);
      orphaned.push(stored.file.id);
    }
  }

  orphaned.sort(compareStrings);
  expired.sort(compareStrings);
  sweptIntents.sort(compareStrings);
  return { orphaned, expired, sweptIntents };
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
