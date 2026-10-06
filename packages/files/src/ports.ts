/**
 * Port interfaces and TEST-ONLY doubles for `@canlang/files`.
 *
 * The interfaces below (`ClockPort`, `IntentIdPort`, `FileIdPort`,
 * `BlobStorePort`, `IntentStorePort`, `FinalizedStorePort`,
 * `PrincipalResolverPort`) are the seams where the real lane-3/lane-6
 * bindings plug in:
 *
 * - Identity mint (`IntentIdPort`, `FileIdPort`): the real binding mints
 *   unguessable runtime identities. Counter doubles are predictable and
 *   TEST-ONLY.
 * - `BlobStorePort`: the journey implementation is the FS-backed store in
 *   `upload/fs-blob-store.ts` (scoped local directory, no live R2). The
 *   R2 binding behind this same port is an S8 join through the L7 runner.
 * - `IntentStorePort` / `FinalizedStorePort`: the real binding stages
 *   intent/finalized rows in the lane-3 commit kernel (atomic with the
 *   owner fence); the memory doubles below are single-owner, non-durable,
 *   non-atomic and unbounded.
 * - `PrincipalResolverPort`: the real binding resolves the L6 identity
 *   context (same-principal/team); the fixed double stands in for tests.
 *
 * The `TestOnly*` classes are TEST-ONLY doubles. They must never ship in
 * production code. In particular they are NOT durable storage and NOT a
 * commit engine: no revision fencing, no batching, no contention handling.
 * Unmet joins fail loudly (missing rows read as absent and refuse closed)
 * rather than being papered over by these doubles.
 */
import type {
  FileProvenance,
  FinalizedFile,
  FinalizedFileRef,
  StoredObjectState,
  UploadIntentId,
  UploadRetryId,
} from '@canlang/contracts';
import type { ReceivingContext } from './provenance/index.js';

/**
 * Upload-intent lifecycle state (implementation-internal). Intent-phase
 * objects correspond to `StoredObjectState` `'uploading'`; stored bytes
 * carry a `StoredObjectState` on `StoredFileRecord` instead.
 */
export type UploadIntentState =
  | 'open'
  | 'complete'
  | 'finalized'
  | 'rejected'
  | 'expired';

/**
 * Stored upload-intent row. Identity fields are immutable; progress fields
 * advance through the intent -> content -> finalize state machine and are
 * persisted via `IntentStorePort.put`.
 */
export interface UploadIntentRecord {
  readonly intentId: UploadIntentId;
  readonly retryId: UploadRetryId;
  readonly operation: string;
  readonly field: string;
  /** Frozen canonical arguments with the selected file slot absent. */
  readonly args: Record<string, unknown>;
  /** Untrusted filename metadata. */
  readonly name: string;
  /** Untrusted claimed MIME type; detected bytes win. */
  readonly claimedType: string;
  readonly declaredSize: number;
  /** Receiving-app provenance bound at intent creation. */
  readonly provenance: FileProvenance;
  readonly contentUrl: string;
  readonly finalizeUrl: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly expiresAt: string;
  state: UploadIntentState;
  receivedBytes: number;
  /** Digest of the validated bytes; set when the transfer completes. */
  bytesDigest: string | null;
  /** Detected content type of the validated bytes; set on completion. */
  detectedType: string | null;
  /** Immutable reference; set once the intent finalizes. */
  finalizedRef: FinalizedFileRef | null;
}

/**
 * Stored finalized-file row. `file` is frozen at finalization and never
 * mutated; only `state` / `attachedRecord` advance under retention and the
 * lane-3 attachment join.
 */
export interface StoredFileRecord {
  readonly file: FinalizedFile;
  /** Receiving app/team/owner/principal that owns these bytes. */
  readonly owner: ReceivingContext;
  readonly finalizedAtMs: number;
  state: StoredObjectState;
  /** Lane-3 record reference once an attachment is recorded, else null. */
  attachedRecord: string | null;
}

/** Minimal wall-clock seam. The file kernel never reads time implicitly. */
export interface ClockPort {
  /** Current time as UTC epoch milliseconds. */
  nowMs(): number;
}

/** Runtime-minted opaque upload-intent identity. */
export interface IntentIdPort {
  nextIntentId(): UploadIntentId;
}

/** Runtime-minted opaque finalized-file identity. */
export interface FileIdPort {
  nextFileId(): FinalizedFileRef;
}

/**
 * Byte storage seam. Keys are runtime-minted from stored intent/file ids
 * (never caller-controlled paths); every implementation MUST reject keys
 * outside `assertSafeBlobKey`. Reads return copies; implementations never
 * alias caller buffers.
 */
export interface BlobStorePort {
  /** Overwrite `key` with `bytes`. */
  write(key: string, bytes: Uint8Array): void;
  /** Append `chunk` to `key`, creating it when absent. */
  append(key: string, chunk: Uint8Array): void;
  /** Stored bytes, or null when absent. */
  read(key: string): Uint8Array | null;
  /** Delete `key`; absent keys are a no-op. */
  remove(key: string): void;
  /** Stored byte count, or null when absent. */
  sizeOf(key: string): number | null;
}

/** Upload-intent row storage. */
export interface IntentStorePort {
  get(intentId: UploadIntentId): UploadIntentRecord | null;
  getByRetryId(retryId: UploadRetryId): UploadIntentRecord | null;
  put(record: UploadIntentRecord): void;
  listAll(): UploadIntentRecord[];
}

/** Finalized-file row storage. */
export interface FinalizedStorePort {
  get(ref: FinalizedFileRef): StoredFileRecord | null;
  put(record: StoredFileRecord): void;
  listAll(): StoredFileRecord[];
}

/**
 * Receiving-identity resolver. The real binding reads the L6 identity
 * context (S8 join); tests use `TestOnlyFixedPrincipal`. A null result
 * means unauthenticated and every handler fails closed.
 */
export interface PrincipalResolverPort {
  resolve(caller: unknown): ReceivingContext | null;
}

const SAFE_BLOB_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Fail-closed blob-key gate shared by every `BlobStorePort`
 * implementation. Rejects separators, traversal, NUL/control bytes and
 * overlong keys; callers must only ever pass runtime-minted keys.
 */
export function assertSafeBlobKey(key: string): void {
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > 256 ||
    key.includes('..') ||
    !SAFE_BLOB_KEY.test(key)
  ) {
    throw new RangeError('unsafe blob key');
  }
}

/** TEST-ONLY manually advanced clock. See file header. */
export class TestOnlyManualClock implements ClockPort {
  private current: number;

  constructor(initialMs = 0) {
    if (!Number.isFinite(initialMs) || initialMs < 0) {
      throw new RangeError('TestOnlyManualClock: initialMs must be finite and >= 0');
    }
    this.current = initialMs;
  }

  nowMs(): number {
    return this.current;
  }

  setNowMs(value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError('TestOnlyManualClock: value must be finite and >= 0');
    }
    this.current = value;
  }

  advanceBy(deltaMs: number): void {
    if (!Number.isFinite(deltaMs)) {
      throw new RangeError('TestOnlyManualClock: deltaMs must be finite');
    }
    this.current += deltaMs;
  }
}

/** TEST-ONLY counter-based intent id mint. Predictable; see file header. */
export class TestOnlyCounterIntentIds implements IntentIdPort {
  private next = 1;
  private readonly prefix: string;

  constructor(prefix = 'intent') {
    this.prefix = prefix;
  }

  nextIntentId(): UploadIntentId {
    const id = `${this.prefix}_${this.next}`;
    this.next += 1;
    return id;
  }
}

/** TEST-ONLY counter-based file id mint. Predictable; see file header. */
export class TestOnlyCounterFileIds implements FileIdPort {
  private next = 1;
  private readonly prefix: string;

  constructor(prefix = 'file') {
    this.prefix = prefix;
  }

  nextFileId(): FinalizedFileRef {
    const id = `${this.prefix}_${this.next}`;
    this.next += 1;
    return id;
  }
}

/** TEST-ONLY in-memory byte store. Non-durable; see file header. */
export class TestOnlyMemoryBlobStore implements BlobStorePort {
  private readonly blobs = new Map<string, Uint8Array>();

  write(key: string, bytes: Uint8Array): void {
    assertSafeBlobKey(key);
    this.blobs.set(key, new Uint8Array(bytes));
  }

  append(key: string, chunk: Uint8Array): void {
    assertSafeBlobKey(key);
    const existing = this.blobs.get(key);
    if (existing === undefined) {
      this.blobs.set(key, new Uint8Array(chunk));
      return;
    }
    const merged = new Uint8Array(existing.length + chunk.length);
    merged.set(existing, 0);
    merged.set(chunk, existing.length);
    this.blobs.set(key, merged);
  }

  read(key: string): Uint8Array | null {
    assertSafeBlobKey(key);
    const found = this.blobs.get(key);
    return found === undefined ? null : new Uint8Array(found);
  }

  remove(key: string): void {
    assertSafeBlobKey(key);
    this.blobs.delete(key);
  }

  sizeOf(key: string): number | null {
    assertSafeBlobKey(key);
    const found = this.blobs.get(key);
    return found === undefined ? null : found.length;
  }
}

/** TEST-ONLY in-memory intent store. Non-durable; see file header. */
export class TestOnlyMemoryIntentStore implements IntentStorePort {
  private readonly byIntent = new Map<UploadIntentId, UploadIntentRecord>();
  private readonly byRetry = new Map<UploadRetryId, UploadIntentRecord>();

  get(intentId: UploadIntentId): UploadIntentRecord | null {
    return this.byIntent.get(intentId) ?? null;
  }

  getByRetryId(retryId: UploadRetryId): UploadIntentRecord | null {
    return this.byRetry.get(retryId) ?? null;
  }

  put(record: UploadIntentRecord): void {
    this.byIntent.set(record.intentId, record);
    this.byRetry.set(record.retryId, record);
  }

  listAll(): UploadIntentRecord[] {
    return [...this.byIntent.values()].sort((a, b) =>
      a.intentId < b.intentId ? -1 : a.intentId > b.intentId ? 1 : 0,
    );
  }
}

/** TEST-ONLY in-memory finalized store. Non-durable; see file header. */
export class TestOnlyMemoryFinalizedStore implements FinalizedStorePort {
  private readonly records = new Map<FinalizedFileRef, StoredFileRecord>();

  get(ref: FinalizedFileRef): StoredFileRecord | null {
    return this.records.get(ref) ?? null;
  }

  put(record: StoredFileRecord): void {
    this.records.set(record.file.id, record);
  }

  listAll(): StoredFileRecord[] {
    return [...this.records.values()].sort((a, b) =>
      a.file.id < b.file.id ? -1 : a.file.id > b.file.id ? 1 : 0,
    );
  }
}

/**
 * TEST-ONLY fixed principal resolver. Returns the configured receiving
 * context (or null for the unauthenticated case) for every caller.
 */
export class TestOnlyFixedPrincipal implements PrincipalResolverPort {
  private readonly context: ReceivingContext | null;

  constructor(context: ReceivingContext | null) {
    this.context = context;
  }

  resolve(_caller: unknown): ReceivingContext | null {
    return this.context;
  }
}
