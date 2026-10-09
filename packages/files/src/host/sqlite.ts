/** Explicit Node host storage. Metadata and bytes share one SQLite transaction. */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { DatetimeValue, FilePolicy } from '@canlang/contracts';
import { decodeValue, encodeValue } from '@canlang/values';
import type { BlobStorePort, ClockPort, FinalizedStorePort, IntentStorePort, StoredFileRecord, UploadIntentRecord } from '../ports.js';
import { assertSafeBlobKey } from '../ports.js';
import { freezeFinalized } from '../provenance/index.js';
import type { ReceivingContext } from '../provenance/index.js';
import { DEFAULT_FILE_POLICY, createUploadIntent, appendUploadContent, completeUploadContent } from '../upload/index.js';
import type { CreateIntentInput, UploadDeps } from '../upload/index.js';
import { finalizeUpload, finalizeProviderOutput, readFinalizedFile, authorizeAttach, recordAttachment, readFinalizedBytes } from '../finalize/index.js';
import type { FinalizeDeps, FinalizeInput, ProviderOutputInput } from '../finalize/index.js';
import { runRetention, describeForReceipt } from '../retention/index.js';
import type { RetentionConfig } from '../retention/index.js';

export interface SqliteFileStore {
  readonly intents: IntentStorePort;
  readonly files: FinalizedStorePort;
  readonly blobs: BlobStorePort;
  /** Wrap the existing synchronous kernel call; a thrown error rolls back every port. */
  transaction<T>(body: () => T): T;
  close(): void;
}

type WireFileRecord = Omit<StoredFileRecord, 'file'> & {
  file: Omit<StoredFileRecord['file'], 'finalizedAt'> & { finalizedAt: string };
};

function encodeFile(record: StoredFileRecord): string {
  const finalizedAt = encodeValue('datetime', record.file.finalizedAt);
  if (typeof finalizedAt !== 'string') throw new TypeError('Invalid finalized file datetime.');
  return JSON.stringify({ ...record, file: { ...record.file, finalizedAt } } satisfies WireFileRecord);
}

function decodeFile(json: string): StoredFileRecord {
  const record = JSON.parse(json) as WireFileRecord;
  return { ...record, file: freezeFinalized({ ...record.file,
    finalizedAt: decodeValue('datetime', record.file.finalizedAt) as DatetimeValue }) };
}

function text(row: Record<string, unknown> | undefined): string | null {
  if (row === undefined) return null;
  if (typeof row.json !== 'string') throw new Error('Invalid SQLite file metadata.');
  return row.json;
}

/** Node 24 SQLite leaf; not imported by the portable Files root or Worker. */
export function createSqliteFileStore(path: string): SqliteFileStore {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS files_upload_intents (
        id TEXT PRIMARY KEY, retry_id TEXT NOT NULL UNIQUE, json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files_finalized (
        id TEXT PRIMARY KEY, json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files_blobs (
        key TEXT PRIMARY KEY, bytes BLOB NOT NULL
      );
    `);
  } catch (error) {
    db.close();
    throw error;
  }
  let inTransaction = false;
  const intents: IntentStorePort = {
    get(id) {
      const json = text(db.prepare('SELECT json FROM files_upload_intents WHERE id = ?').get(id));
      return json === null ? null : JSON.parse(json) as UploadIntentRecord;
    },
    getByRetryId(id) {
      const json = text(db.prepare('SELECT json FROM files_upload_intents WHERE retry_id = ?').get(id));
      return json === null ? null : JSON.parse(json) as UploadIntentRecord;
    },
    put(record) {
      db.prepare(`INSERT INTO files_upload_intents (id, retry_id, json) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET retry_id = excluded.retry_id, json = excluded.json`)
        .run(record.intentId, record.retryId, JSON.stringify(record));
    },
    listAll() {
      return db.prepare('SELECT json FROM files_upload_intents ORDER BY id').all()
        .map(row => JSON.parse(text(row)!) as UploadIntentRecord);
    },
  };
  const files: FinalizedStorePort = {
    get(id) {
      const json = text(db.prepare('SELECT json FROM files_finalized WHERE id = ?').get(id));
      return json === null ? null : decodeFile(json);
    },
    put(record) {
      db.prepare(`INSERT INTO files_finalized (id, json) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET json = excluded.json`).run(record.file.id, encodeFile(record));
    },
    listAll() {
      return db.prepare('SELECT json FROM files_finalized ORDER BY id').all().map(row => decodeFile(text(row)!));
    },
  };
  const blobs: BlobStorePort = {
    write(key, bytes) {
      assertSafeBlobKey(key);
      db.prepare(`INSERT INTO files_blobs (key, bytes) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET bytes = excluded.bytes`).run(key, bytes);
    },
    append(key, chunk) {
      assertSafeBlobKey(key);
      db.prepare(`INSERT INTO files_blobs (key, bytes) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET bytes = CAST(files_blobs.bytes || excluded.bytes AS BLOB)`).run(key, chunk);
    },
    read(key) {
      assertSafeBlobKey(key);
      const row = db.prepare('SELECT bytes FROM files_blobs WHERE key = ?').get(key);
      if (row === undefined) return null;
      if (!(row.bytes instanceof Uint8Array)) throw new Error('Invalid SQLite file bytes.');
      return new Uint8Array(row.bytes);
    },
    remove(key) {
      assertSafeBlobKey(key);
      db.prepare('DELETE FROM files_blobs WHERE key = ?').run(key);
    },
    sizeOf(key) {
      assertSafeBlobKey(key);
      const row = db.prepare('SELECT length(bytes) AS size FROM files_blobs WHERE key = ?').get(key);
      if (row === undefined) return null;
      if (typeof row.size !== 'number') throw new Error('Invalid SQLite file byte count.');
      return row.size;
    },
  };
  return {
    intents, files, blobs,
    transaction<T>(body: () => T): T {
      if (inTransaction) throw new Error('Nested file transactions are not supported.');
      if (Object.prototype.toString.call(body) === '[object AsyncFunction]') {
        throw new TypeError('File transactions require a synchronous callback.');
      }
      db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      try {
        const result = body();
        if (result !== null && (typeof result === 'object' || typeof result === 'function') &&
            typeof (result as { then?: unknown }).then === 'function') {
          throw new TypeError('File transactions require a synchronous callback.');
        }
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    close() {
      if (inTransaction) throw new Error('Cannot close an active file transaction.');
      db.close();
    },
  };
}

export interface SqliteFileBindingOptions {
  readonly clock: ClockPort;
  readonly intentTtlMs: number;
  readonly urlBase: string;
  readonly policy?: FilePolicy;
}

/** Existing file journey methods, with each synchronous mutation committed atomically. */
export function createSqliteFileBindings(store: SqliteFileStore, options: SqliteFileBindingOptions) {
  const policy = options.policy ?? DEFAULT_FILE_POLICY;
  const upload: UploadDeps = {
    clock: options.clock, intents: store.intents, blobs: store.blobs, policy,
    intentTtlMs: options.intentTtlMs, urlBase: options.urlBase,
    intentIds: { nextIntentId: () => randomUUID() },
  };
  const finalize: FinalizeDeps = {
    clock: options.clock, intents: store.intents, files: store.files, blobs: store.blobs,
    fileIds: { nextFileId: () => randomUUID() },
  };
  return {
    maxBytes: policy.maxBytes,
    createIntent: (input: CreateIntentInput) => store.transaction(() => createUploadIntent(upload, input)),
    append: (intentId: string, caller: ReceivingContext, chunk: Uint8Array) =>
      store.transaction(() => appendUploadContent(upload, intentId, caller, chunk)),
    complete: (intentId: string, caller: ReceivingContext) =>
      store.transaction(() => completeUploadContent(upload, intentId, caller)),
    finalize: (input: FinalizeInput) => store.transaction(() => finalizeUpload(finalize, input)),
    finalizeProviderOutput: (input: ProviderOutputInput) =>
      store.transaction(() => finalizeProviderOutput(upload, finalize, input)),
    readProvenance: (ref: string, caller: ReceivingContext) => readFinalizedFile(finalize, ref, caller),
    authorizeAttach: (ref: string, caller: ReceivingContext) => authorizeAttach(finalize, ref, caller),
    recordAttachment: (ref: string, recordRef: string, caller: ReceivingContext) =>
      store.transaction(() => recordAttachment(finalize, ref, recordRef, caller)),
    readBytes: (ref: string, caller: ReceivingContext) => readFinalizedBytes(finalize, ref, caller),
    /** Explicit receiving policy; the full sweep rolls back on interrupted cleanup. */
    runRetention: (config: RetentionConfig) => store.transaction(() => runRetention({
      clock: options.clock, intents: store.intents, files: store.files, blobs: store.blobs,
    }, config)),
    describeForReceipt: (ref: string) => describeForReceipt({ files: store.files, blobs: store.blobs }, ref),
  };
}
