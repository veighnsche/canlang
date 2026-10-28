/** Worker Files host: bounded kernel working sets, fenced D1 metadata and immutable R2 publication. */
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { DatetimeValue, FilePolicy, FileRetentionPolicy } from '@canlang/contracts';
import { decodeValue, encodeValue } from '@canlang/values';
import type { BlobStorePort, ClockPort, FinalizedStorePort, IntentStorePort, StoredFileRecord, UploadIntentRecord } from '@canlang/files/ports';
import { assertSafeBlobKey } from '@canlang/files/ports';
import { freezeFinalized } from '@canlang/files/provenance';
import { DEFAULT_FILE_POLICY, appendUploadContentAtOffset, completeUploadContent, createUploadIntent, sha256Hex, stagingKeyForIntent } from '@canlang/files/upload';
import type { CreateIntentInput, UploadDeps } from '@canlang/files/upload';
import { authorizeAttach, blobKeyForFile, finalizeUpload, observeFinalizedFile, readCurrentFinalizedSnapshot, readFinalizedBytes, readFinalizedFile, recordAttachment, revalidateRetainedFinalizedFile } from '@canlang/files/finalize';
import type { FinalizeDeps, FinalizeInput } from '@canlang/files/finalize';
import type { ReceivingContext } from '@canlang/files/provenance';

export interface R2FileOptions {
  readonly db: D1Database;
  readonly bucket: R2Bucket;
  /** Actual compiler-owned app/binding identity. */
  readonly namespace: string;
  readonly clock: ClockPort;
  readonly urlBase: string;
  readonly intentTtlMs: number;
  readonly allowInsecureLoopback?: true;
  readonly policy?: FilePolicy;
}
interface Pointer { readonly objectKey: string; readonly bytes: number; readonly digest: string }
interface Root { readonly revision: number }
interface Journal { readonly id: string; readonly created: number; readonly state: 'prepared' | 'committed' | 'aborted'; readonly objects: string; readonly retired: string }
const MAX_ATTEMPTS = 5;
function encodeFile(record: StoredFileRecord): string {
  return JSON.stringify({ ...record, file: { ...record.file, finalizedAt: encodeValue('datetime', record.file.finalizedAt) } });
}
function decodeFile(json: string): StoredFileRecord {
  const record = JSON.parse(json) as Omit<StoredFileRecord, 'file'> & { file: Omit<StoredFileRecord['file'], 'finalizedAt'> & { finalizedAt: string } };
  return { ...record, file: freezeFinalized({ ...record.file, finalizedAt: decodeValue('datetime', record.file.finalizedAt) as DatetimeValue }) };
}
const copy = <T>(value: T): T => structuredClone(value);
/** SQLite/D1 phrase every uniqueness violation (UNIQUE and PRIMARY KEY) this way; workerd D1 prefixes it. */
function isUniquenessViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE constraint failed');
}
function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Files host requires positive finite limits.');
  return value;
}

/** Bind and re-open the actual metadata/byte allocation before constructing State owner authority. */
export async function resolveR2FileStoreIdentity({ db, bucket, namespace }: Pick<R2FileOptions, 'db' | 'bucket' | 'namespace'>): Promise<string> {
  if (typeof namespace !== 'string' || namespace.length === 0 || namespace.length > 500) throw new Error('Files host requires its owning namespace.');
  const prefix = `can-files/v1/${sha256Hex(new TextEncoder().encode(namespace))}/`;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS can_files_roots (ns TEXT PRIMARY KEY, revision INTEGER NOT NULL, token TEXT, cleanup_cursor TEXT, file_store_id TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS can_files_intents (ns TEXT NOT NULL, id TEXT NOT NULL, retry_id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(ns,id), UNIQUE(ns,retry_id))'),
    db.prepare('CREATE TABLE IF NOT EXISTS can_files_finalized (ns TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(ns,id))'),
    db.prepare('CREATE TABLE IF NOT EXISTS can_files_blobs (ns TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(ns,id))'),
    db.prepare("CREATE INDEX IF NOT EXISTS can_files_object_keys ON can_files_blobs(ns,json_extract(json,'$.objectKey'))"),
    db.prepare("CREATE TABLE IF NOT EXISTS can_files_publications (ns TEXT NOT NULL, id TEXT NOT NULL, created INTEGER NOT NULL, state TEXT NOT NULL, objects TEXT NOT NULL, retired TEXT NOT NULL, PRIMARY KEY(ns,id))"),
    db.prepare('INSERT OR IGNORE INTO can_files_roots(ns,revision,token,file_store_id) VALUES (?,0,NULL,?)').bind(namespace, crypto.randomUUID()),
  ]);
  const allocation = await db.prepare('SELECT revision,file_store_id FROM can_files_roots WHERE ns=?').bind(namespace).first<{ revision: number; file_store_id: string }>();
  if (allocation === null || typeof allocation.file_store_id !== 'string' || !/^[0-9a-f-]{36}$/.test(allocation.file_store_id)) throw new Error('Files lost its persisted physical allocation.');
  const fileStoreId = allocation.file_store_id, markerKey = `${prefix}allocation.json`;
  let marker = await bucket.get(markerKey);
  if (marker === null) {
    if (allocation.revision !== 0) throw new Error('Files R2 allocation marker is absent for existing metadata.');
    await bucket.put(markerKey, JSON.stringify({ version: 1, fileStoreId }), { onlyIf: { etagDoesNotMatch: '*' } });
    marker = await bucket.get(markerKey);
  }
  if (marker === null || marker.size > 200 || await marker.text() !== JSON.stringify({ version: 1, fileStoreId })) throw new Error('Files D1 and R2 physical allocations do not correspond.');
  return fileStoreId;
}

export async function createR2FileBindings(input: R2FileOptions) {
  const options = Object.freeze({ ...input });
  const { db, bucket, namespace, clock } = options;
  if (typeof namespace !== 'string' || namespace.length === 0 || namespace.length > 500) throw new Error('Files host requires its owning namespace.');
  positive(options.intentTtlMs);
  const policy = Object.freeze({ ...(options.policy ?? DEFAULT_FILE_POLICY), types: [...(options.policy ?? DEFAULT_FILE_POLICY).types] });
  positive(policy.maxBytes);
  const prefix = `can-files/v1/${sha256Hex(new TextEncoder().encode(namespace))}/`;
  const fileStoreId = await resolveR2FileStoreIdentity({ db, bucket, namespace });
  const root = async () => {
    const row = await db.prepare('SELECT revision FROM can_files_roots WHERE ns=?').bind(namespace).first<Root>();
    if (row === null || !Number.isSafeInteger(row.revision) || row.revision < 0) throw new Error('Files metadata lost its revision.');
    return row.revision;
  };
  const row = async (table: string, id: string): Promise<string | null> => {
    const found = await db.prepare(`SELECT json FROM ${table} WHERE ns=? AND id=?`).bind(namespace, id).first<{ json: string }>();
    return found?.json ?? null;
  };
  const physicalFiles = Object.freeze({ async get(ref: string): Promise<StoredFileRecord | null> {
    assertSafeBlobKey(ref);
    const json = await row('can_files_finalized', ref);
    return json === null ? null : decodeFile(json);
  } });
  const loadBlobContent = async (key: string, pointers: Map<string, Pointer | null>, bytes: Map<string, Uint8Array | null>): Promise<void> => {
    const json = await row('can_files_blobs', key), pointer = json === null ? null : JSON.parse(json) as Pointer;
    pointers.set(key, pointer);
    if (pointer === null) { bytes.set(key, null); return; }
    if (!pointer.objectKey.startsWith(prefix) || !Number.isSafeInteger(pointer.bytes) || pointer.bytes < 0 || pointer.bytes > policy.maxBytes) throw new Error('Files byte pointer exceeds its owning scope or policy.');
    const object = await bucket.get(pointer.objectKey);
    if (object === null || object.size !== pointer.bytes) throw new Error('Files metadata points at unavailable bytes.');
    const content = new Uint8Array(await object.arrayBuffer());
    if (content.length !== pointer.bytes || sha256Hex(content) !== pointer.digest) throw new Error('Files stored bytes differ from their immutable pointer.');
    bytes.set(key, content);
  };
  const publishBlobWrites = async (blobWrites: Map<string, Uint8Array | null>, pointers: Map<string, Pointer | null>,
    token: string, now: number): Promise<Map<string, Pointer | null>> => {
    const published = new Map<string, Pointer | null>(), objects: string[] = [], retired: string[] = [];
    for (const [key, value] of blobWrites) {
      const previous = pointers.get(key);
      if (previous != null) retired.push(previous.objectKey);
      if (value === null) { published.set(key, null); continue; }
      const pointer = { objectKey: `${prefix}${token}/${encodeURIComponent(key)}`, bytes: value.length, digest: sha256Hex(value) };
      objects.push(pointer.objectKey); published.set(key, pointer);
    }
    await db.prepare("INSERT INTO can_files_publications(ns,id,created,state,objects,retired) VALUES (?,?,?,'prepared',?,?)").bind(namespace, token, now, JSON.stringify(objects), JSON.stringify(retired)).run();
    for (const [key, value] of blobWrites) {
      if (value === null) continue;
      await bucket.put(published.get(key)!.objectKey, value);
    }
    return published;
  };
  const commitPublished = async (revision: number, token: string,
    intentWrite: UploadIntentRecord | undefined, fileWrite: StoredFileRecord | undefined,
    published: Map<string, Pointer | null>): Promise<boolean> => {
    const condition = 'EXISTS(SELECT 1 FROM can_files_roots WHERE ns=? AND token=?)';
    const batch = [db.prepare("UPDATE can_files_roots SET revision=revision+1,token=? WHERE ns=? AND revision=? AND EXISTS(SELECT 1 FROM can_files_publications WHERE ns=? AND id=? AND state='prepared')").bind(token, namespace, revision, namespace, token)];
    if (intentWrite !== undefined) batch.push(db.prepare(`INSERT INTO can_files_intents(ns,id,retry_id,json) SELECT ?,?,?,? WHERE ${condition} ON CONFLICT(ns,id) DO UPDATE SET retry_id=excluded.retry_id,json=excluded.json`).bind(namespace, intentWrite.intentId, intentWrite.retryId, JSON.stringify(intentWrite), namespace, token));
    if (fileWrite !== undefined) batch.push(db.prepare(`INSERT INTO can_files_finalized(ns,id,json) SELECT ?,?,? WHERE ${condition} ON CONFLICT(ns,id) DO UPDATE SET json=excluded.json`).bind(namespace, fileWrite.file.id, encodeFile(fileWrite), namespace, token));
    for (const [key, pointer] of published) batch.push(pointer === null
      ? db.prepare(`DELETE FROM can_files_blobs WHERE ns=? AND id=? AND ${condition}`).bind(namespace, key, namespace, token)
      : db.prepare(`INSERT INTO can_files_blobs(ns,id,json) SELECT ?,?,? WHERE ${condition} ON CONFLICT(ns,id) DO UPDATE SET json=excluded.json`).bind(namespace, key, JSON.stringify(pointer), namespace, token));
    batch.push(db.prepare(`UPDATE can_files_publications SET state='committed' WHERE ns=? AND id=? AND ${condition}`).bind(namespace, token, namespace, token));
    // D1 owns this entire conditional batch. A lost response is resolved through its durable journal.
    // A uniqueness violation is the same-intent race, not a defect: a
    // concurrent call committed this retry identity first, so this
    // attempt retries and converges on the winner's duplicate/conflict
    // path. The batch is atomic, so our journal row is still prepared
    // and the sweeper later reclaims our orphaned R2 objects.
    try { await db.batch(batch); } catch (error) {
      const saved = await db.prepare('SELECT state FROM can_files_publications WHERE ns=? AND id=?').bind(namespace, token).first<{ state: string }>();
      if (saved?.state === 'committed') return true;
      if (isUniquenessViolation(error)) return false;
      throw error;
    }
    const saved = await db.prepare('SELECT state FROM can_files_publications WHERE ns=? AND id=?').bind(namespace, token).first<{ state: string }>();
    if (saved?.state === 'committed') return true;
    await db.prepare("UPDATE can_files_publications SET state='aborted' WHERE ns=? AND id=? AND state='prepared'").bind(namespace, token).run();
    return false;
  };
  const sweepJournalEntry = async (entry: Journal, beforeMs: number): Promise<number> => {
    if (entry.created > beforeMs) return 0;
    if (entry.state === 'prepared') await db.prepare("UPDATE can_files_publications SET state='aborted' WHERE ns=? AND id=? AND state='prepared'").bind(namespace, entry.id).run();
    const current = await db.prepare('SELECT state FROM can_files_publications WHERE ns=? AND id=?').bind(namespace, entry.id).first<{ state: string }>();
    const keys = JSON.parse(current?.state === 'committed' ? entry.retired : entry.objects) as string[];
    if (!Array.isArray(keys) || keys.length > 3 || keys.some(key => typeof key !== 'string' || !key.startsWith(prefix))) throw new Error('Files cleanup journal lost its private object census.');
    let removed = 0;
    for (const key of keys) {
      const live = await db.prepare("SELECT id FROM can_files_blobs WHERE ns=? AND json_extract(json,'$.objectKey')=? LIMIT 1").bind(namespace, key).first();
      if (live !== null) continue;
      await bucket.delete(key); removed++;
    }
    return removed;
  };
  interface AttemptState {
    revision: number;
    intent: UploadIntentRecord | null;
    ref: string | undefined;
    stored: StoredFileRecord | null;
    intentKeys: Set<string>;
    fileKeys: Set<string>;
    blobKeys: Set<string>;
  }
  const loadAttemptState = async (select: { intentId?: string; retryId?: string; ref?: string },
    mintedIntent: string, mintedFile: string): Promise<AttemptState> => {
    const revision = await root();
    const intentJson = select.intentId !== undefined ? await row('can_files_intents', select.intentId)
      : select.retryId === undefined ? null : (await db.prepare('SELECT json FROM can_files_intents WHERE ns=? AND retry_id=?').bind(namespace, select.retryId).first<{ json: string }>())?.json ?? null;
    const intent = intentJson === null ? null : JSON.parse(intentJson) as UploadIntentRecord;
    const ref = select.ref ?? intent?.finalizedRef ?? intent?.pendingFinalization?.ref;
    const storedJson = ref == null ? null : await row('can_files_finalized', ref);
    const stored = storedJson === null ? null : decodeFile(storedJson);
    const intentKeys = new Set([mintedIntent, ...(select.intentId === undefined ? [] : [select.intentId]), ...(intent === null ? [] : [intent.intentId])]);
    const fileKeys = new Set([mintedFile, ...(ref == null ? [] : [ref])]);
    const blobKeys = new Set([blobKeyForFile(mintedFile), ...(ref == null ? [] : [blobKeyForFile(ref)]), ...(intent === null ? [] : [stagingKeyForIntent(intent.intentId)])]);
    return { revision, intent, ref, stored, intentKeys, fileKeys, blobKeys };
  };
  interface AttemptWrites {
    intentWrite: UploadIntentRecord | undefined;
    fileWrite: StoredFileRecord | undefined;
    blobWrites: Map<string, Uint8Array | null>;
  }
  const makeAttemptStores = (select: { intentId?: string; retryId?: string; ref?: string }, loaded: AttemptState,
    bytes: Map<string, Uint8Array | null>, writes: AttemptWrites): { intents: IntentStorePort; files: FinalizedStorePort; blobs: BlobStorePort } => {
    const { intent, stored, intentKeys, fileKeys, blobKeys } = loaded;
    const check = (keys: Set<string>, key: string) => { assertSafeBlobKey(key); if (!keys.has(key)) throw new Error('Files kernel exceeded its selected bounded working set.'); };
    const intents: IntentStorePort = {
      get(id) { check(intentKeys, id); return intent !== null && intent.intentId === id ? copy(intent) : null; },
      getByRetryId(id) { if (id !== select.retryId) throw new Error('Files kernel exceeded its selected retry identity.'); return intent === null ? null : copy(intent); },
      put(record) { check(intentKeys, record.intentId); writes.intentWrite = copy(record); },
      listAll() { throw new Error('Files host requires explicitly bounded traversal.'); },
    };
    const files: FinalizedStorePort = {
      get(id) { check(fileKeys, id); return writes.fileWrite?.file.id === id ? copy(writes.fileWrite) : stored?.file.id === id ? copy(stored) : null; },
      put(record) { check(fileKeys, record.file.id); writes.fileWrite = copy(record); },
      listAll() { throw new Error('Files host requires explicitly bounded traversal.'); },
    };
    const blobs: BlobStorePort = {
      read(key) { check(blobKeys, key); const current = writes.blobWrites.has(key) ? writes.blobWrites.get(key) : bytes.get(key); return current == null ? null : new Uint8Array(current); },
      write(key, value) { check(blobKeys, key); if (value.length > policy.maxBytes) throw new Error('Files byte write exceeds its receiving policy.'); writes.blobWrites.set(key, new Uint8Array(value)); },
      append(key, chunk) { const current = blobs.read(key) ?? new Uint8Array(); const result = new Uint8Array(current.length + chunk.length); result.set(current); result.set(chunk, current.length); blobs.write(key, result); },
      // Removing an already-absent key records nothing: repeat and
      // loser retries converge without committing, so one finalize
      // wave costs exactly one D1 batch instead of one per caller.
      remove(key) {
        check(blobKeys, key);
        if (writes.blobWrites.has(key)) {
          if (bytes.get(key) == null) writes.blobWrites.delete(key);
          else writes.blobWrites.set(key, null);
        } else if (bytes.get(key) != null) {
          writes.blobWrites.set(key, null);
        }
      },
      sizeOf(key) { return blobs.read(key)?.length ?? null; },
    };
    return { intents, files, blobs };
  };
  /**
   * TECH-F01 same-intent serialization primitive: every journey call
   * loads its bounded working set, runs the pure kernel, stages R2
   * bytes behind a prepared journal row, and commits one conditional
   * D1 batch (roots-revision CAS plus journal gate). Concurrent calls
   * for one intent/publication converge: losers retry on the winner's
   * committed state (duplicate/conflict/repeat paths) instead of
   * publishing twice. Interruption between R2 staging and D1 commit
   * leaves a prepared journal row whose orphaned objects the sweeper
   * reclaims; interruption before staging leaves nothing. Retries
   * reuse this call's minted identities; bounded attempts keep a hot
   * loop loud.
   */
  async function run<T>(select: { intentId?: string; retryId?: string; ref?: string }, body: (upload: UploadDeps, final: FinalizeDeps) => T,
    revalidate?: () => Promise<void>): Promise<T> {
    // These minted identities belong to this actual call and survive its CAS retries.
    const mintedIntent = crypto.randomUUID(), mintedFile = crypto.randomUUID();
    const now = clock.nowMs();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const loaded = await loadAttemptState(select, mintedIntent, mintedFile);
      const pointers = new Map<string, Pointer | null>(), bytes = new Map<string, Uint8Array | null>();
      for (const key of loaded.blobKeys) {
        await loadBlobContent(key, pointers, bytes);
      }
      if (await root() !== loaded.revision) continue;
      const writes: AttemptWrites = { intentWrite: undefined, fileWrite: undefined, blobWrites: new Map<string, Uint8Array | null>() };
      const { intents, files, blobs } = makeAttemptStores(select, loaded, bytes, writes);
      const callClock = { nowMs: () => now };
      const upload: UploadDeps = { clock: callClock, policy, intentTtlMs: options.intentTtlMs, urlBase: options.urlBase,
        intentIds: { nextIntentId: () => mintedIntent }, intents, blobs,
        ...(options.allowInsecureLoopback === true ? { allowInsecureLoopback: true as const } : {}) };
      const final: FinalizeDeps = { clock: callClock, fileIds: { nextFileId: () => mintedFile }, intents, files, blobs };
      const result = body(upload, final);
      if (writes.intentWrite === undefined && writes.fileWrite === undefined && writes.blobWrites.size === 0) {
        await revalidate?.();
        if (await root() === loaded.revision) return result;
        continue;
      }
      const token = crypto.randomUUID();
      const published = await publishBlobWrites(writes.blobWrites, pointers, token, now);
      await revalidate?.();
      if (await commitPublished(loaded.revision, token, writes.intentWrite, writes.fileWrite, published)) return result;
    }
    throw new Error('Concurrent Files changes require retry.');
  }
  return Object.freeze({
    maxBytes: policy.maxBytes,
    fileStoreId,
    physicalFiles,
    createIntent: (input: CreateIntentInput & { readonly revalidate?: () => Promise<void> }) =>
      run({ retryId: input.request.upload_id }, upload => createUploadIntent(upload, input), input.revalidate),
    append: (intentId: string, caller: ReceivingContext, chunk: Uint8Array, expectedOffset: number) => run({ intentId }, upload => appendUploadContentAtOffset(upload, intentId, caller, chunk, expectedOffset)),
    complete: (intentId: string, caller: ReceivingContext) => run({ intentId }, upload => completeUploadContent(upload, intentId, caller)),
    finalize: (input: FinalizeInput) => run({ intentId: input.intentId }, (_, final) => finalizeUpload(final, input)),
    readProvenance: (ref: string, caller: ReceivingContext) => run({ ref }, (_, final) => readFinalizedFile(final, ref, caller)),
    authorizeAttach: (ref: string, caller: ReceivingContext) => run({ ref }, (_, final) => authorizeAttach(final, ref, caller)),
    recordAttachment: (ref: string, recordRef: string, caller: ReceivingContext) => run({ ref }, (_, final) => recordAttachment(final, ref, recordRef, caller)),
    readBytes: (ref: string, caller: ReceivingContext) => run({ ref }, (_, final) => readFinalizedBytes(final, ref, caller)),
    readCurrentBytes: async (ref: string, caller: ReceivingContext, retention: FileRetentionPolicy) => (await run({ ref }, (_, final) => readCurrentFinalizedSnapshot(final, ref, caller, { policy, retention })))?.bytes ?? null,
    readCurrentSnapshot: (ref: string, caller: ReceivingContext, retention: FileRetentionPolicy) => run({ ref }, (_, final) => readCurrentFinalizedSnapshot(final, ref, caller, { policy, retention })),
    observeFile: (ref: string, caller: ReceivingContext, retention: FileRetentionPolicy) => run({ ref }, (_, final) => observeFinalizedFile(final, ref, caller, { policy, retention })),
    revalidateFile: (saved: unknown, caller: ReceivingContext, retention: FileRetentionPolicy) => {
      const ref = typeof saved === 'object' && saved !== null ? (saved as { ref?: unknown }).ref : undefined;
      if (typeof ref !== 'string') return Promise.resolve(false);
      return run({ ref }, (_, final) => revalidateRetainedFinalizedFile(final, saved, caller, { policy, retention }));
    },
    /** Journal tombstones remain: a suspended aborted publisher can finish a late put; later sweeps delete it again. */
    async cleanup({ beforeMs, limit = 100, cursor }: { beforeMs: number; limit?: number; cursor?: string | null }) {
      if (!Number.isSafeInteger(beforeMs) || beforeMs < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Files cleanup requires bounded time/page inputs.');
      const after = cursor === undefined ? (await db.prepare('SELECT cleanup_cursor FROM can_files_roots WHERE ns=?').bind(namespace).first<{ cleanup_cursor: string | null }>())?.cleanup_cursor ?? null : cursor;
      const page = await db.prepare('SELECT id,created,state,objects,retired FROM can_files_publications WHERE ns=? AND id>? ORDER BY id LIMIT ?').bind(namespace, after ?? '', limit).all<Journal>();
      let removed = 0;
      for (const entry of page.results) {
        removed += await sweepJournalEntry(entry, beforeMs);
      }
      const next = page.results.length === limit ? page.results.at(-1)!.id : null;
      if (cursor === undefined) await db.prepare('UPDATE can_files_roots SET cleanup_cursor=? WHERE ns=?').bind(next, namespace).run();
      return { visited: page.results.length, removed, cursor: next };
    },
  });
}
