/** Worker-safe SQLite Files core. Metadata and bytes share one real transaction. */
import type { DatetimeValue, FilePolicy, FileRetentionPolicy, FileReferenceStoragePort, FileRetirementAuthority } from '@canlang/contracts';
import { decodeValue, encodeValue } from '@canlang/values';
import type { BlobStorePort, ClockPort, EventIngestClaimStorePort, FinalizedFileDeletionRecord, PagedFinalizedStorePort, PagedIntentStorePort, StoredFileRecord, UploadIntentRecord } from '../ports.js';
import { assertSafeBlobKey } from '../ports.js';
import { freezeFinalized } from '../provenance/index.js';
import type { ReceivingContext } from '../provenance/index.js';
import { DEFAULT_FILE_POLICY, createUploadIntent, appendUploadContentAtOffset, completeUploadContent } from '../upload/index.js';
import type { CreateIntentInput, UploadDeps } from '../upload/index.js';
import { decodeEventIngestClaim, finalizeUpload, finalizeProviderOutput, ingestVerifiedEventFile, readFinalizedFile, authorizeAttach, recordAttachment, readFinalizedBytes, readCurrentFinalizedBytes, readCurrentFinalizedSnapshot, observeFinalizedFile, revalidateRetainedFinalizedFile } from '../finalize/index.js';
import type { EventIngestDeps, EventIngestInput, FinalizeDeps, FinalizeInput, ProviderOutputInput } from '../finalize/index.js';
import { MAX_RETENTION_BATCH_ROWS, runRetention, runRetentionBatch, describeForReceipt, checkedFileCleanupAuthority, checkedFileCleanupRecord, createFinalizedFileCleanup } from '../retention/index.js';
import type { RetentionConfig, RetentionBatchOptions } from '../retention/index.js';

/** The existing synchronous Files kernel requires synchronous SQLite transactions. */
export type FileSqlValue = string | number | null | Uint8Array;
export interface FileSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...parameters: FileSqlValue[]): void;
    get(...parameters: FileSqlValue[]): Record<string, unknown> | undefined;
    all(...parameters: FileSqlValue[]): Record<string, unknown>[];
  };
  transaction<T>(body: () => T): T;
  close(): void;
}
const randomUUID = (): string => globalThis.crypto.randomUUID();
// Workerd SQLite limits individual rows; the Files policy still permits 10 MiB.
const BLOB_CHUNK_BYTES = 64 * 1024;

/** Retain existing Node stores when adopting the row-bounded blob layout. */
function migrateLegacyBlobs(db: FileSqliteDatabase): void {
  const columns = db.prepare('PRAGMA table_info(files_blobs)').all().map(row => row.name);
  if (!columns.includes('bytes')) return;
  if (columns.length !== 2 || !columns.includes('key')) throw new Error('Invalid legacy SQLite blob schema.');
  db.transaction(() => {
    db.exec('ALTER TABLE files_blobs RENAME TO files_blobs_legacy');
    db.exec('CREATE TABLE files_blobs (key TEXT PRIMARY KEY, size INTEGER NOT NULL CHECK(size >= 0))');
    for (const row of db.prepare('SELECT key, bytes FROM files_blobs_legacy').all()) {
      if (typeof row.key !== 'string' || !(row.bytes instanceof Uint8Array)) {
        throw new Error('Invalid legacy SQLite file bytes.');
      }
      assertSafeBlobKey(row.key);
      db.prepare('INSERT INTO files_blobs (key, size) VALUES (?, ?)').run(row.key, row.bytes.byteLength);
      for (let offset = 0; offset < row.bytes.byteLength; offset += BLOB_CHUNK_BYTES) {
        db.prepare('INSERT INTO files_blob_chunks (blob_key, chunk_index, bytes) VALUES (?, ?, ?)')
          .run(row.key, offset / BLOB_CHUNK_BYTES, row.bytes.subarray(offset, offset + BLOB_CHUNK_BYTES));
      }
    }
    db.exec('DROP TABLE files_blobs_legacy');
  });
}

export interface SqliteFileStore {
  /** Stable persisted physical identity; it grants no State issuance. */
  readonly fileStoreId: string;
  readonly intents: PagedIntentStorePort;
  readonly files: PagedFinalizedStorePort;
  readonly blobs: BlobStorePort;
  readonly claims: EventIngestClaimStorePort;
  /** Wrap the existing synchronous kernel call; a thrown error rolls back every port. */
  transaction<T>(body: () => T): T;
  hasFileRetirementAuthority(): boolean;
  /** Trusted deployment composition only, never request-supplied storage/DTOs.
   * Permanently pins the first authority; captures the actual original lookup.
   * Genuine State guard/profile qualification remains a host prerequisite. */
  bindFileRetirement(storage: FileReferenceStoragePort, options: {
    readonly clock: ClockPort; readonly policy: FilePolicy; readonly retention: FileRetentionPolicy;
  }): (ref: string) => Promise<'deleted' | 'already-deleted'>;
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

function checkRetentionPage(after: string | null, limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RETENTION_BATCH_ROWS) {
    throw new RangeError(`Retention page limit must be a safe integer between 1 and ${MAX_RETENTION_BATCH_ROWS}.`);
  }
  if (after !== null) assertSafeBlobKey(after);
}

/** Use a real host database; never substitute memory storage for this core. */
export function createSqliteFileStoreFromDatabase(db: FileSqliteDatabase): SqliteFileStore {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS files_upload_intents (
        id TEXT PRIMARY KEY, retry_id TEXT NOT NULL UNIQUE, json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files_finalized (
        id TEXT PRIMARY KEY, json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files_blobs (
        key TEXT PRIMARY KEY, size INTEGER NOT NULL CHECK(size >= 0)
      );
      CREATE TABLE IF NOT EXISTS files_blob_chunks (
        blob_key TEXT NOT NULL, chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
        bytes BLOB NOT NULL CHECK(length(bytes) <= 65536),
        PRIMARY KEY(blob_key, chunk_index)
      );
      CREATE TABLE IF NOT EXISTS files_store_identity (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        file_store_id TEXT NOT NULL, authority_json TEXT
      );
      CREATE TABLE IF NOT EXISTS files_retirement_journal (
        id TEXT PRIMARY KEY, json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files_event_claims (
        id TEXT PRIMARY KEY, json TEXT NOT NULL
      );
    `);
    migrateLegacyBlobs(db);
    db.prepare('INSERT OR IGNORE INTO files_store_identity (singleton, file_store_id) VALUES (1, ?)').run(randomUUID());
  } catch (error) {
    db.close();
    throw error;
  }
  const identity = db.prepare('SELECT file_store_id FROM files_store_identity WHERE singleton = 1').get();
  if (typeof identity?.file_store_id !== 'string' || identity.file_store_id.length === 0) {
    db.close(); throw new Error('Invalid persisted physical Files identity.');
  }
  const fileStoreId = identity.file_store_id;
  function readAuthority(): FileRetirementAuthority | null {
    const row = db.prepare('SELECT file_store_id, authority_json FROM files_store_identity WHERE singleton = 1').get();
    if (row?.file_store_id !== fileStoreId) throw new Error('Persisted physical Files identity changed.');
    if (row.authority_json === null) {
      if (db.prepare('SELECT id FROM files_retirement_journal LIMIT 1').get() !== undefined) {
        throw new Error('Permanent Files journal has no authority assignment.');
      }
      return null;
    }
    if (typeof row.authority_json !== 'string') throw new Error('Invalid persisted Files authority.');
    const authority = checkedFileCleanupAuthority(JSON.parse(row.authority_json));
    if (authority.fileStoreId !== fileStoreId) throw new Error('Persisted Files authority has a foreign physical identity.');
    return authority;
  }
  function journalJson(ref: string): string | null {
    return text(db.prepare('SELECT json FROM files_retirement_journal WHERE id = ?').get(ref));
  }
  function putFile(record: StoredFileRecord): void {
    db.prepare(`INSERT INTO files_finalized (id, json) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET json = excluded.json`).run(record.file.id, encodeFile(record));
  }
  function assertReceiver(record: StoredFileRecord, authority: FileRetirementAuthority): void {
    if (record.owner.app !== authority.receiver.app || record.owner.team !== authority.receiver.team ||
        record.owner.owner !== authority.receiver.owner) throw new Error('Foreign physical Files receiver.');
  }
  function immutableKey(record: StoredFileRecord): string {
    return encodeFile({ file: record.file, owner: record.owner, finalizedAtMs: record.finalizedAtMs,
      state: 'finalized', attachedRecord: null });
  }
  function protectFinalKey(key: string): void {
    const authority = readAuthority();
    if (authority === null || !key.startsWith('f_') || !key.endsWith('.bin')) return;
    const ref = key.slice(2, -4);
    if (journalJson(ref) !== null || db.prepare('SELECT id FROM files_finalized WHERE id = ?').get(ref) !== undefined) {
      throw new Error('Published Files bytes require the original State retirement cleanup.');
    }
  }
  let inTransaction = false;
  const mutate = <T>(body: () => T): T => inTransaction ? body() : transaction(body);
  const intents: PagedIntentStorePort = {
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
    listAfter(after, limit) {
      checkRetentionPage(after, limit);
      const rows = after === null
        ? db.prepare('SELECT json FROM files_upload_intents ORDER BY id LIMIT ?').all(limit)
        : db.prepare('SELECT json FROM files_upload_intents WHERE id > ? ORDER BY id LIMIT ?').all(after, limit);
      return rows.map(row => JSON.parse(text(row)!) as UploadIntentRecord);
    },
    listAll() {
      return db.prepare('SELECT json FROM files_upload_intents ORDER BY id').all()
        .map(row => JSON.parse(text(row)!) as UploadIntentRecord);
    },
  };
  const files: PagedFinalizedStorePort = {
    get(id) {
      const json = text(db.prepare('SELECT json FROM files_finalized WHERE id = ?').get(id));
      return json === null ? null : decodeFile(json);
    },
    put(record) {
      mutate(() => {
        const authority = readAuthority();
        if (authority !== null) {
          record = checkedFileCleanupRecord(record);
          assertReceiver(record, authority);
          if (record.state === 'orphaned' || record.state === 'expired' || journalJson(record.file.id) !== null) {
            throw new Error('Files terminal state requires the original State retirement cleanup.');
          }
          const old = files.get(record.file.id);
          if (old !== null && (old.state === 'orphaned' || old.state === 'expired' ||
              immutableKey(checkedFileCleanupRecord(old)) !== immutableKey(record))) {
            throw new Error('Pinned finalized Files identity cannot change or revive.');
          }
          if (old !== null && (old.state === 'attached' && record.state !== 'attached' ||
              old.attachedRecord !== null && record.attachedRecord === null ||
              old.attachedAtMs !== undefined && old.attachedAtMs !== record.attachedAtMs)) {
            throw new Error('Pinned Files attachment and original time cannot regress.');
          }
        }
        putFile(record);
      });
    },
    listAfter(after, limit) {
      checkRetentionPage(after, limit);
      const rows = after === null
        ? db.prepare('SELECT json FROM files_finalized ORDER BY id LIMIT ?').all(limit)
        : db.prepare('SELECT json FROM files_finalized WHERE id > ? ORDER BY id LIMIT ?').all(after, limit);
      return rows.map(row => decodeFile(text(row)!));
    },
    listAll() {
      return db.prepare('SELECT json FROM files_finalized ORDER BY id').all().map(row => decodeFile(text(row)!));
    },
  };
  function deleteBlob(key: string): void {
    db.prepare('DELETE FROM files_blob_chunks WHERE blob_key = ?').run(key);
    db.prepare('DELETE FROM files_blobs WHERE key = ?').run(key);
  }
  function blobSize(key: string): number | null {
    const row = db.prepare('SELECT size FROM files_blobs WHERE key = ?').get(key);
    if (row === undefined) return null;
    if (typeof row.size !== 'number' || !Number.isSafeInteger(row.size) || row.size < 0) {
      throw new Error('Invalid SQLite file byte count.');
    }
    return row.size;
  }
  const putChunk = (key: string, index: number, bytes: Uint8Array): void => {
    db.prepare(`INSERT INTO files_blob_chunks (blob_key, chunk_index, bytes) VALUES (?, ?, ?)
      ON CONFLICT(blob_key, chunk_index) DO UPDATE SET bytes = excluded.bytes`).run(key, index, bytes);
  };
  const blobs: BlobStorePort = {
    write(key, bytes) {
      assertSafeBlobKey(key);
      mutate(() => {
        protectFinalKey(key);
        deleteBlob(key);
        db.prepare('INSERT INTO files_blobs (key, size) VALUES (?, ?)').run(key, bytes.byteLength);
        for (let offset = 0; offset < bytes.byteLength; offset += BLOB_CHUNK_BYTES) {
          putChunk(key, offset / BLOB_CHUNK_BYTES, bytes.subarray(offset, offset + BLOB_CHUNK_BYTES));
        }
      });
    },
    append(key, chunk) {
      assertSafeBlobKey(key);
      mutate(() => {
        protectFinalKey(key);
        const previous = blobSize(key);
        const oldSize = previous ?? 0;
        if (previous === null) db.prepare('INSERT INTO files_blobs (key, size) VALUES (?, 0)').run(key);
        let consumed = 0;
        const tailSize = oldSize % BLOB_CHUNK_BYTES;
        if (tailSize !== 0 && chunk.byteLength !== 0) {
          const index = Math.floor(oldSize / BLOB_CHUNK_BYTES);
          const tail = db.prepare('SELECT bytes FROM files_blob_chunks WHERE blob_key = ? AND chunk_index = ?').get(key, index);
          if (!(tail?.bytes instanceof Uint8Array) || tail.bytes.byteLength !== tailSize) {
            throw new Error('Invalid SQLite file chunk.');
          }
          consumed = Math.min(BLOB_CHUNK_BYTES - tailSize, chunk.byteLength);
          const bytes = new Uint8Array(tailSize + consumed);
          bytes.set(tail.bytes); bytes.set(chunk.subarray(0, consumed), tailSize);
          putChunk(key, index, bytes);
        }
        while (consumed < chunk.byteLength) {
          const end = Math.min(consumed + BLOB_CHUNK_BYTES, chunk.byteLength);
          putChunk(key, Math.floor((oldSize + consumed) / BLOB_CHUNK_BYTES), chunk.subarray(consumed, end));
          consumed = end;
        }
        db.prepare('UPDATE files_blobs SET size = ? WHERE key = ?').run(oldSize + chunk.byteLength, key);
      });
    },
    read(key) {
      assertSafeBlobKey(key);
      // Size and chunks describe one physical read, including other Node connections.
      return mutate(() => {
        const size = blobSize(key);
        if (size === null) return null;
        const bytes = new Uint8Array(size);
        const chunks = db.prepare('SELECT chunk_index, bytes FROM files_blob_chunks WHERE blob_key = ? ORDER BY chunk_index').all(key);
        if (chunks.length !== Math.ceil(size / BLOB_CHUNK_BYTES)) throw new Error('Invalid SQLite file chunk count.');
        for (const [index, chunk] of chunks.entries()) {
          const offset = index * BLOB_CHUNK_BYTES;
          if (chunk.chunk_index !== index || !(chunk.bytes instanceof Uint8Array) ||
              chunk.bytes.byteLength !== Math.min(BLOB_CHUNK_BYTES, size - offset)) {
            throw new Error('Invalid SQLite file chunk.');
          }
          bytes.set(chunk.bytes, offset);
        }
        return bytes;
      });
    },
    remove(key) {
      assertSafeBlobKey(key);
      mutate(() => { protectFinalKey(key); deleteBlob(key); });
    },
    sizeOf(key) { assertSafeBlobKey(key); return blobSize(key); },
  };
  function transaction<T>(body: () => T): T {
    if (inTransaction) throw new Error('Nested file transactions are not supported.');
    if (Object.prototype.toString.call(body) === '[object AsyncFunction]') {
      throw new TypeError('File transactions require a synchronous callback.');
    }
    return db.transaction(() => {
      inTransaction = true;
      try {
        const result = body();
        if (result !== null && (typeof result === 'object' || typeof result === 'function') &&
            typeof (result as { then?: unknown }).then === 'function') {
          throw new TypeError('File transactions require a synchronous callback.');
        }
        return result;
      } finally {
        inTransaction = false;
      }
    });
  }

  const claims: EventIngestClaimStorePort = {
    get(id) {
      assertSafeBlobKey(id);
      const json = text(db.prepare('SELECT json FROM files_event_claims WHERE id = ?').get(id));
      return json === null ? null : decodeEventIngestClaim(json);
    },
    put(record) {
      assertSafeBlobKey(record.identityHash);
      // Plain insert, deliberately no upsert: the claim key is the
      // cross-caller uniqueness anchor.
      db.prepare('INSERT INTO files_event_claims (id, json) VALUES (?, ?)')
        .run(record.identityHash, JSON.stringify(record));
    },
  };
  return {
    fileStoreId, intents, files, blobs, claims, transaction,
    hasFileRetirementAuthority: () => readAuthority() !== null,
    bindFileRetirement(storage, options) {
      const authority = checkedFileCleanupAuthority(storage.fileRetirementAuthority);
      if (authority.fileStoreId !== fileStoreId) throw new Error('State binding names a foreign physical Files store.');
      transaction(() => {
        const current = readAuthority();
        if (current !== null && JSON.stringify(current) !== JSON.stringify(authority)) {
          throw new Error('Permanent Files authority cannot be repinned.');
        }
        // First assignment rejects pre-existing foreign receiver metadata.
        // This is physical profile installation, not a State reference census.
        if (current === null) {
          for (const record of files.listAll()) assertReceiver(checkedFileCleanupRecord(record), authority);
          db.prepare('UPDATE files_store_identity SET authority_json = ? WHERE singleton = 1').run(JSON.stringify(authority));
        }
      });
      return createFinalizedFileCleanup({
        clock: options.clock, readAuthority, transaction,
        files: { ...files, put: putFile },
        blobs: { ...blobs, remove(key) {
          assertSafeBlobKey(key);
          deleteBlob(key);
        } },
        readDeletion(ref) {
          const json = journalJson(ref);
          if (json === null) return null;
          const value = JSON.parse(json) as { retirement: FinalizedFileDeletionRecord['retirement']; tombstone: string };
          if (Object.keys(value).sort().join(',') !== 'retirement,tombstone' || typeof value.tombstone !== 'string') {
            throw new Error('Invalid permanent Files cleanup journal.');
          }
          return { retirement: value.retirement, tombstone: decodeFile(value.tombstone) };
        },
        saveDeletion(record) {
          db.prepare('INSERT INTO files_retirement_journal (id, json) VALUES (?, ?)')
            .run(record.retirement.file.ref, JSON.stringify({ retirement: record.retirement, tombstone: encodeFile(record.tombstone) }));
        },
      }, storage, options);
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
  /** Actual trusted deployment State instance, never wire data or a copied DTO. */
  readonly fileRetirement?: { readonly storage: FileReferenceStoragePort; readonly retention: FileRetentionPolicy };
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
  const event: EventIngestDeps = {
    clock: options.clock, files: store.files, blobs: store.blobs, claims: store.claims,
    fileIds: { nextFileId: () => randomUUID() },
  };
  const cleanup = options.fileRetirement === undefined ? null : store.bindFileRetirement(options.fileRetirement.storage,
    { clock: options.clock, policy, retention: options.fileRetirement.retention });
  const legacyRetention = () => {
    if (store.hasFileRetirementAuthority()) throw new Error('Pinned Files require original State retirement cleanup.');
  };
  return {
    maxBytes: policy.maxBytes,
    deleteRetiredFile(ref: string): Promise<'deleted' | 'already-deleted'> {
      if (cleanup === null) return Promise.reject(new Error('Original State retirement binding is required.'));
      return cleanup(ref);
    },
    createIntent: (input: CreateIntentInput) => store.transaction(() => createUploadIntent(upload, input)),
    append: (intentId: string, caller: ReceivingContext, chunk: Uint8Array, expectedOffset: number) =>
      store.transaction(() => appendUploadContentAtOffset(upload, intentId, caller, chunk, expectedOffset)),
    complete: (intentId: string, caller: ReceivingContext) =>
      store.transaction(() => completeUploadContent(upload, intentId, caller)),
    finalize: (input: FinalizeInput) => store.transaction(() => finalizeUpload(finalize, input)),
    finalizeProviderOutput: (input: ProviderOutputInput) =>
      store.transaction(() => finalizeProviderOutput(upload, finalize, input)),
    ingestEventFile: (input: EventIngestInput) =>
      store.transaction(() => ingestVerifiedEventFile(event, input)),
    readProvenance: (ref: string, caller: ReceivingContext) => readFinalizedFile(finalize, ref, caller),
    authorizeAttach: (ref: string, caller: ReceivingContext) => authorizeAttach(finalize, ref, caller),
    recordAttachment: (ref: string, recordRef: string, caller: ReceivingContext) =>
      store.transaction(() => recordAttachment(finalize, ref, recordRef, caller)),
    readBytes: (ref: string, caller: ReceivingContext) => readFinalizedBytes(finalize, ref, caller),
    /** Same physical byte snapshot checked under the current File policy/lifetime. */
    readCurrentBytes: (ref: string, caller: ReceivingContext, retention: FileRetentionPolicy) =>
      store.transaction(() => readCurrentFinalizedBytes(finalize, ref, caller, { policy, retention })),
    /** Immutable current facts and their detached validated bytes from one read. */
    readCurrentSnapshot: (ref: string, caller: ReceivingContext, retention: FileRetentionPolicy) =>
      store.transaction(() => readCurrentFinalizedSnapshot(finalize, ref, caller, { policy, retention })),
    /** Consistent real byte/metadata observation; facts alone grant no row or read access. */
    observeFile: (ref: string, caller: ReceivingContext, retention: FileRetentionPolicy) =>
      store.transaction(() => observeFinalizedFile(finalize, ref, caller, { policy, retention })),
    revalidateFile: (saved: unknown, caller: ReceivingContext, retention: FileRetentionPolicy) =>
      store.transaction(() => revalidateRetainedFinalizedFile(finalize, saved, caller, { policy, retention })),
    /** Explicit receiving policy; the full sweep rolls back on interrupted cleanup. */
    runRetention: (config: RetentionConfig) => store.transaction(() => { legacyRetention(); return runRetention({
      clock: options.clock, intents: store.intents, files: store.files, blobs: store.blobs,
    }, config); }),
    /** Bounded retention shares the same metadata and byte transaction. */
    runRetentionBatch: (config: RetentionConfig, batch: RetentionBatchOptions) => store.transaction(() => { legacyRetention(); return runRetentionBatch({
      clock: options.clock, intents: store.intents, files: store.files, blobs: store.blobs,
    }, config, batch); }),
    describeForReceipt: (ref: string) => describeForReceipt({ files: store.files, blobs: store.blobs }, ref),
  };
}
