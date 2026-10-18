/**
 * Finalization, attachment authorization and finalized-byte reads
 * (DESIGN section 8, bridge v1 step 3).
 *
 * Finalization re-verifies the completed transfer (retry identity plus
 * byte digest) and mints one immutable `FinalizedFile` whose provenance
 * is frozen: repeating a completed intent with identical evidence
 * returns the same reference, while conflicting retry identity/context
 * or replacement bytes fail. Finalization creates no business record;
 * attachment authority belongs to lane 3, which records attachments
 * through `recordAttachment` at the join. Foreign IDs and URLs can never
 * attach: unknown references, provenance mismatches and hostile shapes
 * share one `foreign` outcome that echoes nothing, and this package
 * performs no URL fetching at all.
 *
 * Controlled provider output (T27, e.g. generated images) finalizes
 * through the same intent lifecycle via `finalizeProviderOutput`: the
 * S8 join hands downloaded provider bytes (never a provider URL) to
 * this module, which drives one deterministic retry identity per
 * (adapter, delivery, result path) slot through create/append/complete/
 * finalize and returns the receiving-app finalized file.
 */
import type {
  ContentCheck,
  FilePolicy,
  FinalizeResult,
  FinalizedFile,
  FinalizedFileObservation,
  FinalizedFileRef,
  FileRetentionPolicy,
  RetainedFinalizedFile,
  StoredObjectState,
  UploadIntentId,
  UploadRetryId,
} from '@canlang/contracts';
import type {
  BlobStorePort,
  ClockPort,
  FileIdPort,
  FinalizedStorePort,
  IntentStorePort,
  StoredFileRecord,
  UploadIntentRecord,
} from '../ports.js';
import { assertSafeBlobKey } from '../ports.js';
import type { UploadIntentRequest } from '@canlang/contracts';
import {
  freezeFinalized,
  isSameReceiver,
  requestProvenanceMatches,
  validateEventProvenance,
  type ReceivingContext,
  type RequestProvenanceBinding,
} from '../provenance/index.js';
import {
  appendUploadContentAtOffset,
  checkContent,
  completeUploadContent,
  createUploadIntent,
  sha256Hex,
  stagingKeyForIntent,
  type UploadDeps,
} from '../upload/index.js';

export interface FinalizeDeps {
  readonly clock: ClockPort;
  readonly fileIds: FileIdPort;
  readonly intents: IntentStorePort;
  readonly blobs: BlobStorePort;
  readonly files: FinalizedStorePort;
}

export interface FinalizedFileObservationOptions {
  readonly policy: FilePolicy;
  /** Captured receiving policy; deadlines remain anchored to finalization. */
  readonly retention: FileRetentionPolicy;
}

type ObservationDeps = Pick<FinalizeDeps, 'files' | 'blobs' | 'clock'>;

/** One current physical read; immutable nongrant facts and detached mutable bytes. */
export interface CurrentFinalizedFileSnapshot {
  readonly facts: RetainedFinalizedFile;
  readonly bytes: Uint8Array;
}

// Identity, rather than an inspectable brand or saved object shape, authenticates
// live observations. Persistent facts must be joined to the owning receipt and
// current row authority by State; this module supplies neither of those grants.
const observations = new WeakMap<object, RetainedFinalizedFile>();

function ownData(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || names.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function milliseconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function snapshotReceiver(value: unknown): ReceivingContext | null {
  const record = ownData(value, ['app', 'team', 'owner', 'principal']);
  if (record === null || !nonempty(record.app) || !nonempty(record.team) ||
      !nonempty(record.owner) || !nonempty(record.principal)) return null;
  return Object.freeze({ app: record.app, team: record.team, owner: record.owner, principal: record.principal });
}

function snapshotRetention(value: unknown): FileRetentionPolicy | null {
  const extended = typeof value === 'object' && value !== null && Object.hasOwn(value, 'retainAttached');
  const record = ownData(value, ['unattachedHorizonMs', 'retentionMs', ...(extended ? ['retainAttached'] : [])]);
  if (record === null || !milliseconds(record.unattachedHorizonMs) || !milliseconds(record.retentionMs) || extended && record.retainAttached !== true) return null;
  return Object.freeze({ unattachedHorizonMs: record.unattachedHorizonMs, retentionMs: record.retentionMs,
    ...(extended ? { retainAttached: true as const } : {}) });
}

function snapshotProvenance(value: unknown): RetainedFinalizedFile['provenance'] | null {
  if (typeof value !== 'object' || value === null) return null;
  const kind = Object.getOwnPropertyDescriptor(value, 'kind');
  if (kind === undefined || !('value' in kind)) return null;
  if (kind.value === 'request') {
    const record = ownData(value, ['kind', 'app', 'team', 'owner', 'principal', 'adapter', 'deliveryId', 'resultPath']);
    if (record === null || !nonempty(record.app) || !nonempty(record.team) || !nonempty(record.owner) ||
        !nonempty(record.principal) || !nonempty(record.adapter) || !nonempty(record.deliveryId) ||
        !nonempty(record.resultPath)) return null;
    return Object.freeze({ kind: 'request', app: record.app, team: record.team, owner: record.owner,
      principal: record.principal, adapter: record.adapter, deliveryId: record.deliveryId, resultPath: record.resultPath });
  }
  if (kind.value === 'event') {
    const record = ownData(value, ['kind', 'source', 'adapter', 'occurrenceId', 'fieldPath', 'itemIndex']);
    const provenance = record === null ? null : validateEventProvenance(record);
    return provenance === null ? null : Object.freeze(provenance);
  }
  return null;
}

function snapshotRetained(value: unknown): RetainedFinalizedFile | null {
  const record = ownData(value, ['ref', 'receiver', 'provenance', 'contentType', 'sizeBytes', 'bytesDigest', 'finalizedAtMs', 'retention']);
  if (record === null || !nonempty(record.ref) || !nonempty(record.contentType) ||
      !milliseconds(record.sizeBytes) || !milliseconds(record.finalizedAtMs) ||
      typeof record.bytesDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(record.bytesDigest)) return null;
  assertSafeBlobKey(record.ref);
  assertSafeBlobKey(blobKeyForFile(record.ref));
  const receiver = snapshotReceiver(record.receiver);
  const provenance = snapshotProvenance(record.provenance);
  const retention = snapshotRetention(record.retention);
  if (receiver === null || provenance === null || retention === null ||
      (provenance.kind === 'request' && !requestProvenanceMatches(provenance, receiver))) return null;
  return Object.freeze({ ref: record.ref, receiver, provenance, contentType: record.contentType,
    sizeBytes: record.sizeBytes, bytesDigest: record.bytesDigest, finalizedAtMs: record.finalizedAtMs, retention });
}

function withinFileLifetime(stored: StoredFileRecord, now: number, retention: FileRetentionPolicy): boolean {
  const elapsed = BigInt(now) - BigInt(stored.finalizedAtMs);
  if (elapsed < 0n) return false;
  const timelyAttachment = stored.state === 'attached' && milliseconds(stored.attachedAtMs) &&
    stored.attachedAtMs >= stored.finalizedAtMs && stored.attachedAtMs <= now &&
    BigInt(stored.attachedAtMs) - BigInt(stored.finalizedAtMs) < BigInt(retention.unattachedHorizonMs);
  if (retention.retainAttached === true && timelyAttachment) return true;
  if (elapsed >= BigInt(retention.retentionMs)) return false;
  if (elapsed < BigInt(retention.unattachedHorizonMs)) return true;
  // The marker alone cannot prove a timely attachment. Clockless legacy marks
  // and marks made at/after the deadline do not revive an expired file profile.
  return stored.state === 'attached' && milliseconds(stored.attachedAtMs) &&
    stored.attachedAtMs >= stored.finalizedAtMs && stored.attachedAtMs <= now &&
    BigInt(stored.attachedAtMs) - BigInt(stored.finalizedAtMs) < BigInt(retention.unattachedHorizonMs);
}

/**
 * Load the stored row behind `ref` with its file/finalization identity
 * established. Returns null unless the row is a live finalized/attached
 * record whose file id and finalization instant agree.
 */
function loadStoredFileForRead(
  deps: ObservationDeps,
  ref: FinalizedFileRef,
): { stored: StoredFileRecord; file: Record<string, unknown> } | null {
  const stored = deps.files.get(ref);
  if (stored === null || (stored.state !== 'finalized' && stored.state !== 'attached') ||
      (stored.state === 'attached' && !nonempty(stored.attachedRecord)) ||
      !milliseconds(stored.finalizedAtMs)) return null;
  const file = ownData(stored.file, ['id', 'provenance', 'contentType', 'sizeBytes', 'bytesDigest', 'finalizedAt']);
  if (file === null || file.id !== ref) return null;
  const finalizedAt = ownData(file.finalizedAt, ['kind', 'ms']);
  if (finalizedAt === null || finalizedAt.kind !== 'datetime' || finalizedAt.ms !== BigInt(stored.finalizedAtMs)) return null;
  return { stored, file };
}

function currentFileRead(
  deps: ObservationDeps,
  ref: FinalizedFileRef,
  caller: ReceivingContext,
  options: FinalizedFileObservationOptions,
  originalRetention?: FileRetentionPolicy,
): CurrentFinalizedFileSnapshot | null {
  assertSafeBlobKey(ref);
  assertSafeBlobKey(blobKeyForFile(ref));
  const receiver = snapshotReceiver(caller);
  const retention = snapshotRetention(options.retention);
  const now = deps.clock.nowMs();
  if (receiver === null || retention === null || !milliseconds(now)) return null;
  const loaded = loadStoredFileForRead(deps, ref);
  if (loaded === null) return null;
  const { stored, file } = loaded;
  const facts = snapshotRetained({ ref, receiver: stored.owner, provenance: file.provenance,
    contentType: file.contentType, sizeBytes: file.sizeBytes, bytesDigest: file.bytesDigest,
    finalizedAtMs: stored.finalizedAtMs, retention });
  if (facts === null || !isSameReceiver(facts.receiver, receiver) || !withinFileLifetime(stored, now, retention) ||
      (originalRetention !== undefined && !withinFileLifetime(stored, now, originalRetention))) return null;
  const storedBytes = deps.blobs.read(blobKeyForFile(ref));
  if (storedBytes === null || storedBytes.byteLength !== facts.sizeBytes) return null;
  const bytes = new Uint8Array(storedBytes);
  if (sha256Hex(bytes) !== facts.bytesDigest) return null;
  const check = checkContent(options.policy, facts.contentType, bytes);
  if (check.verdict !== 'accepted' || check.detectedType !== facts.contentType || check.sizeBytes !== facts.sizeBytes) return null;
  return { facts, bytes };
}

/**
 * Return metadata and the exact bytes checked together by the current validator.
 * The wrapper and facts are frozen; bytes are detached from physical storage.
 * This is not an observation handle or a State disclosure/attachment grant.
 */
export function readCurrentFinalizedSnapshot(
  deps: ObservationDeps,
  ref: FinalizedFileRef,
  caller: ReceivingContext,
  options: FinalizedFileObservationOptions,
): CurrentFinalizedFileSnapshot | null {
  try {
    const current = currentFileRead(deps, ref, caller, options);
    return current === null ? null : Object.freeze(current);
  } catch { return null; }
}

/**
 * Read the exact physical byte snapshot validated against the current receiver,
 * File policy and finalization-anchored lifetime. State must separately check
 * the current whole-field grant and occurrence before and after async host reads.
 * This producer grants no business-row access and does not infer shared references.
 */
export function readCurrentFinalizedBytes(
  deps: ObservationDeps,
  ref: FinalizedFileRef,
  caller: ReceivingContext,
  options: FinalizedFileObservationOptions,
): Uint8Array | null {
  try { return currentFileRead(deps, ref, caller, options)?.bytes ?? null; }
  catch { return null; }
}

/** Observe real live bytes and immutable metadata without changing any port. */
export function observeFinalizedFile(
  deps: ObservationDeps,
  ref: FinalizedFileRef,
  caller: ReceivingContext,
  options: FinalizedFileObservationOptions,
): FinalizedFileObservation | null {
  try {
    const current = currentFileRead(deps, ref, caller, options);
    if (current === null) return null;
    const handle = Object.freeze(Object.create(null)) as FinalizedFileObservation;
    observations.set(handle, current.facts);
    return handle;
  } catch { return null; }
}

/** Extract only genuine live identity; never inspect an untrusted handle's shape. */
export function readFinalizedFileObservation(handle: unknown): RetainedFinalizedFile | null {
  return typeof handle === 'object' && handle !== null ? observations.get(handle) ?? null : null;
}

/**
 * Verify retained nongrant facts against current physical storage and receiving
 * policy. No handle is minted from saved facts. State must bind these facts to
 * its own receipt, checked assignment and current row authority before use.
 */
export function revalidateRetainedFinalizedFile(
  deps: ObservationDeps,
  retained: unknown,
  caller: ReceivingContext,
  options: FinalizedFileObservationOptions,
): boolean {
  try {
    const saved = snapshotRetained(retained);
    if (saved === null) return false;
    const current = currentFileRead(deps, saved.ref, caller, options, saved.retention)?.facts;
    return current !== undefined && current.ref === saved.ref && isSameReceiver(current.receiver, saved.receiver) &&
      JSON.stringify(current.provenance) === JSON.stringify(saved.provenance) &&
      current.contentType === saved.contentType && current.sizeBytes === saved.sizeBytes &&
      current.bytesDigest === saved.bytesDigest && current.finalizedAtMs === saved.finalizedAtMs;
  } catch { return false; }
}

export interface FinalizeInput {
  readonly intentId: UploadIntentId;
  readonly retryId: UploadRetryId;
  /** Digest of the bytes the caller believes it transferred. */
  readonly bytesDigest: string;
  readonly caller: ReceivingContext;
}

export type FinalizeOutcome =
  | { readonly status: 'finalized'; readonly result: FinalizeResult; readonly file: FinalizedFile }
  | { readonly status: 'repeated'; readonly result: FinalizeResult; readonly file: FinalizedFile }
  | { readonly status: 'failed'; readonly reason: 'foreign' | 'partial' | 'conflict' | 'expired' };

export interface EventIngestInput {
  /** Unvalidated event provenance from the verified-ingress path. */
  readonly provenance: unknown;
  /** Receiving app/team/owner/principal that owns the verified event. */
  readonly receiver: ReceivingContext;
  readonly claimedType: string;
  readonly bytes: Uint8Array;
  readonly policy: FilePolicy;
}

export type EventIngestOutcome =
  | { readonly status: 'finalized'; readonly result: FinalizeResult; readonly file: FinalizedFile }
  | { readonly status: 'rejected'; readonly reason: 'invalid-provenance' | 'oversized' }
  | { readonly status: 'rejected'; readonly reason: 'malformed' | 'rejected'; readonly check: ContentCheck };

export type AttachOutcome =
  | { readonly status: 'authorized'; readonly ref: FinalizedFileRef }
  | { readonly status: 'failed'; readonly reason: 'foreign' | 'expired' };

export type RecordAttachmentOutcome =
  | { readonly status: 'attached'; readonly ref: FinalizedFileRef }
  | { readonly status: 'failed'; readonly reason: 'foreign' | 'expired' };

/** Final blob key for a finalized reference. Callers pass the stored id. */
export function blobKeyForFile(ref: FinalizedFileRef): string {
  return `f_${ref}.bin`;
}

function callerOwnsIntent(record: UploadIntentRecord, caller: ReceivingContext): boolean {
  return (
    record.provenance.kind === 'request' &&
    requestProvenanceMatches(record.provenance, caller)
  );
}

function publishedFileMatchesIntent(
  stored: StoredFileRecord,
  record: UploadIntentRecord,
  ref: FinalizedFileRef,
  caller: ReceivingContext,
): boolean {
  const provenance = stored.file.provenance;
  return (
    record.provenance.kind === 'request' &&
    provenance.kind === 'request' &&
    stored.file.id === ref &&
    stored.file.sizeBytes === record.declaredSize &&
    stored.file.sizeBytes === record.receivedBytes &&
    stored.file.bytesDigest === record.bytesDigest &&
    stored.file.contentType === record.detectedType &&
    Number.isSafeInteger(stored.finalizedAtMs) &&
    stored.finalizedAtMs >= 0 &&
    stored.file.finalizedAt.ms === BigInt(stored.finalizedAtMs) &&
    (record.pendingFinalization === undefined ||
      (record.pendingFinalization.ref === ref &&
        record.pendingFinalization.finalizedAtMs === stored.finalizedAtMs)) &&
    requestProvenanceMatches(provenance, caller) &&
    isSameReceiver(stored.owner, caller) &&
    provenance.adapter === record.provenance.adapter &&
    provenance.deliveryId === record.provenance.deliveryId &&
    provenance.resultPath === record.provenance.resultPath
  );
}

function sweepExpiredIntent(deps: FinalizeDeps, record: UploadIntentRecord): void {
  record.state = 'expired';
  record.receivedBytes = 0;
  record.bytesDigest = null;
  record.detectedType = null;
  deps.blobs.remove(stagingKeyForIntent(record.intentId));
  deps.intents.put(record);
}

/**
 * Finalize a completed transfer. Repeat calls with identical evidence
 * return the same immutable reference; conflicting retry identity,
 * replacement bytes, or bytes that drifted under the completion digest
 * fail with no file. Repeating after retention still returns the same
 * reference (byte availability is a separate concern for reads and
 * receipt projections).
 * Save the publication reference/time before final bytes, publish the
 * immutable row and intent pointer before removing staging, and reuse
 * that identity after interruption. These ordered phases recover serial
 * calls with separately persisted ports; hosts must serialize competing
 * callers. The SQLite binding wraps all phases in its own transaction.
 */
/**
 * Settle a repeat finalize against the already published row. The durable
 * pointer may have committed before staging cleanup; a repeat settles
 * that cleanup, including after byte collection, and must never
 * republish final bytes from the retained staging copy.
 */
function repeatFinalize(deps: FinalizeDeps, record: UploadIntentRecord, input: FinalizeInput): FinalizeOutcome {
  if (input.retryId !== record.retryId || input.bytesDigest !== record.bytesDigest) {
    return { status: 'failed', reason: 'conflict' };
  }
  const stored =
    record.finalizedRef === null ? null : deps.files.get(record.finalizedRef);
  if (stored === null) {
    return { status: 'failed', reason: 'expired' };
  }
  if (!publishedFileMatchesIntent(stored, record, record.finalizedRef!, input.caller)) {
    return { status: 'failed', reason: 'conflict' };
  }
  deps.blobs.remove(stagingKeyForIntent(record.intentId));
  return {
    status: 'repeated',
    result: { file: stored.file.id },
    file: stored.file,
  };
}

/**
 * Check transfer lifecycle and retry identity before touching bytes.
 * Returns the terminal outcome when a guard decides, else null.
 */
function checkFinalizeEligibility(
  deps: FinalizeDeps,
  record: UploadIntentRecord,
  input: FinalizeInput,
): FinalizeOutcome | null {
  if (record.state === 'expired' || deps.clock.nowMs() >= record.expiresAtMs) {
    if (record.state !== 'expired') {
      sweepExpiredIntent(deps, record);
    }
    return { status: 'failed', reason: 'expired' };
  }
  if (record.state !== 'complete') {
    // Open transfers are partial; rejected transfers likewise yield no
    // usable file (contracts: "an incomplete or rejected transfer yields
    // no usable file").
    return { status: 'failed', reason: 'partial' };
  }
  if (input.retryId !== record.retryId) {
    return { status: 'failed', reason: 'conflict' };
  }
  return null;
}

/**
 * Read and validate staging against the completion digest, assigning the
 * durable pending-finalization identity on first pass. Returns the
 * terminal outcome when validation decides, else the staging bytes with
 * the publication identity.
 */
function readFinalizeStaging(
  deps: FinalizeDeps,
  record: UploadIntentRecord,
  input: FinalizeInput,
): FinalizeOutcome | { staging: Uint8Array; ref: FinalizedFileRef; finalizedAtMs: number; actualDigest: string; detectedType: string } {
  const staging = deps.blobs.read(stagingKeyForIntent(record.intentId));
  if (
    staging === null ||
    staging.byteLength !== record.receivedBytes ||
    record.receivedBytes !== record.declaredSize
  ) {
    return { status: 'failed', reason: 'conflict' };
  }
  const actualDigest = sha256Hex(staging);
  if (actualDigest !== record.bytesDigest || input.bytesDigest !== record.bytesDigest) {
    return { status: 'failed', reason: 'conflict' };
  }
  if (record.detectedType === null) {
    return { status: 'failed', reason: 'conflict' };
  }
  if (record.pendingFinalization === undefined) {
    const finalizedAtMs = deps.clock.nowMs();
    if (!Number.isSafeInteger(finalizedAtMs) || finalizedAtMs < 0) {
      return { status: 'failed', reason: 'conflict' };
    }
    record.pendingFinalization = {
      ref: deps.fileIds.nextFileId(),
      finalizedAtMs,
    };
    deps.intents.put(record);
  }
  const { ref, finalizedAtMs } = record.pendingFinalization;
  if (!Number.isSafeInteger(finalizedAtMs) || finalizedAtMs < 0) {
    return { status: 'failed', reason: 'conflict' };
  }
  const detectedType: string = record.detectedType;
  return { staging, ref, finalizedAtMs, actualDigest, detectedType };
}

/**
 * Publish the immutable row and intent pointer before removing staging,
 * reusing that identity after interruption. Save the publication
 * reference/time before final bytes.
 */
function publishFinalizedFile(
  deps: FinalizeDeps,
  record: UploadIntentRecord,
  input: FinalizeInput,
  staging: Uint8Array,
  ref: FinalizedFileRef,
  finalizedAtMs: number,
  actualDigest: string,
  detectedType: string,
  provenance: Extract<UploadIntentRecord['provenance'], { kind: 'request' }>,
): FinalizeOutcome {
  const file = freezeFinalized({
    id: ref,
    provenance,
    contentType: detectedType,
    sizeBytes: record.receivedBytes,
    bytesDigest: actualDigest,
    finalizedAt: { kind: 'datetime', ms: BigInt(finalizedAtMs) },
  });
  const prior = deps.files.get(ref);
  if (prior !== null) {
    if (prior.state === 'orphaned' || prior.state === 'expired') {
      return { status: 'failed', reason: 'expired' };
    }
    if (
      !publishedFileMatchesIntent(prior, record, ref, input.caller) ||
      prior.finalizedAtMs !== finalizedAtMs ||
      prior.file.finalizedAt.ms !== file.finalizedAt.ms
    ) {
      return { status: 'failed', reason: 'conflict' };
    }
  }
  const finalKey = blobKeyForFile(ref);
  const published = deps.blobs.read(finalKey);
  if (published !== null && !bytesEqual(published, staging)) {
    // Never overwrite bytes under an immutable publication identity.
    return { status: 'failed', reason: 'conflict' };
  }
  if (published === null) {
    if (prior !== null) {
      // Missing bytes behind a published row are not a resumable write.
      return { status: 'failed', reason: 'expired' };
    }
    deps.blobs.write(finalKey, staging);
  }
  if (prior === null) deps.files.put({
    file,
    owner: {
      app: provenance.app,
      team: provenance.team,
      owner: provenance.owner,
      principal: provenance.principal,
    },
    finalizedAtMs,
    state: 'finalized',
    attachedRecord: null,
  });
  record.state = 'finalized';
  record.finalizedRef = ref;
  deps.intents.put(record);
  deps.blobs.remove(stagingKeyForIntent(record.intentId));
  return { status: 'finalized', result: { file: ref }, file };
}

export function finalizeUpload(deps: FinalizeDeps, input: FinalizeInput): FinalizeOutcome {
  const record = deps.intents.get(input.intentId);
  if (record === null || !callerOwnsIntent(record, input.caller)) {
    return { status: 'failed', reason: 'foreign' };
  }
  if (record.state === 'finalized') {
    return repeatFinalize(deps, record, input);
  }
  const eligibility = checkFinalizeEligibility(deps, record, input);
  if (eligibility !== null) {
    return eligibility;
  }
  const staged = readFinalizeStaging(deps, record, input);
  if ('status' in staged) {
    return staged;
  }
  const provenance = record.provenance;
  if (provenance.kind !== 'request') {
    return { status: 'failed', reason: 'foreign' };
  }
  return publishFinalizedFile(deps, record, input, staged.staging, staged.ref, staged.finalizedAtMs, staged.actualDigest, staged.detectedType, provenance);
}

/**
 * Finalize bytes that arrived through a verified capability event
 * (including incoming email attachments). The ingress path must already
 * be authenticated; this function validates the provenance shape, the
 * policy and the actual bytes, then finalizes directly with no intent.
 */
export function ingestVerifiedEventBytes(
  deps: FinalizeDeps,
  input: EventIngestInput,
): EventIngestOutcome {
  const provenance = validateEventProvenance(input.provenance);
  const receiver = input.receiver;
  if (
    provenance === null ||
    typeof receiver !== 'object' ||
    receiver === null ||
    receiver.app.length === 0 ||
    receiver.team.length === 0 ||
    receiver.owner.length === 0 ||
    receiver.principal.length === 0 ||
    typeof input.claimedType !== 'string' ||
    input.claimedType.length === 0
  ) {
    return { status: 'rejected', reason: 'invalid-provenance' };
  }
  if (input.bytes.length > input.policy.maxBytes) {
    return { status: 'rejected', reason: 'oversized' };
  }
  const check = checkContent(input.policy, input.claimedType, input.bytes);
  if (check.verdict === 'rejected' || check.detectedType === null) {
    const reason = check.detectedType === null ? 'malformed' : 'rejected';
    return { status: 'rejected', reason, check };
  }
  const ref = deps.fileIds.nextFileId();
  const finalizedAtMs = deps.clock.nowMs();
  const file = freezeFinalized({
    id: ref,
    provenance,
    contentType: check.detectedType,
    sizeBytes: input.bytes.length,
    bytesDigest: sha256Hex(input.bytes),
    finalizedAt: { kind: 'datetime', ms: BigInt(finalizedAtMs) },
  });
  deps.blobs.write(blobKeyForFile(ref), input.bytes);
  deps.files.put({
    file,
    owner: {
      app: receiver.app,
      team: receiver.team,
      owner: receiver.owner,
      principal: receiver.principal,
    },
    finalizedAtMs,
    state: 'finalized',
    attachedRecord: null,
  });
  return { status: 'finalized', result: { file: ref }, file };
}

/**
 * Pure attach pre-check: the reference must exist, retain bytes, and be
 * owned by the caller. Unknown, foreign-shaped and other-owner
 * references share `foreign` with no echo; collected references report
 * `expired`.
 */
export function authorizeAttach(
  deps: Pick<FinalizeDeps, 'files'>,
  ref: FinalizedFileRef,
  caller: ReceivingContext,
): AttachOutcome {
  const stored = deps.files.get(ref);
  if (stored === null) {
    return { status: 'failed', reason: 'foreign' };
  }
  if (stored.state === 'orphaned' || stored.state === 'expired') {
    return { status: 'failed', reason: 'expired' };
  }
  if (!isSameReceiver(stored.owner, caller)) {
    return { status: 'failed', reason: 'foreign' };
  }
  return { status: 'authorized', ref: stored.file.id };
}

/**
 * Record a lane-3 attachment against a finalized reference. The join
 * seam for attachment authority: until lane 3 calls this, finalized
 * objects stay unattached and fall to GC after the horizon. Re-marks
 * are last-write-wins; S8 refines this with lane-3 authority rules.
 * An owning clock stamps the first attachment time; retries never renew it.
 * Clockless legacy calls retain their old marker behavior but cannot prove a
 * timely attachment to the retained-file observation profile.
 */
export function recordAttachment(
  deps: Pick<FinalizeDeps, 'files'> & Partial<Pick<FinalizeDeps, 'clock'>>,
  ref: FinalizedFileRef,
  recordRef: string,
  caller: ReceivingContext,
): RecordAttachmentOutcome {
  if (typeof recordRef !== 'string' || recordRef.length === 0) {
    throw new RangeError('recordAttachment: recordRef must be a non-empty string');
  }
  const decision = authorizeAttach(deps, ref, caller);
  if (decision.status === 'failed') {
    return decision;
  }
  const stored = deps.files.get(decision.ref);
  if (stored === null) {
    return { status: 'failed', reason: 'foreign' };
  }
  if (deps.clock !== undefined) {
    const now = deps.clock.nowMs();
    if (!milliseconds(now) || !milliseconds(stored.finalizedAtMs) || now < stored.finalizedAtMs ||
        (stored.attachedAtMs !== undefined && (!milliseconds(stored.attachedAtMs) ||
          stored.attachedAtMs < stored.finalizedAtMs || stored.attachedAtMs > now))) {
      return { status: 'failed', reason: 'expired' };
    }
    // Retrying or moving a marker cannot renew the first clocked attachment.
    if (stored.attachedAtMs === undefined) stored.attachedAtMs = now;
  }
  stored.state = 'attached';
  stored.attachedRecord = recordRef;
  deps.files.put(stored);
  return { status: 'attached', ref: stored.file.id };
}

/**
 * Read finalized bytes. Returns null for every denial (unknown ref,
 * foreign caller, collected bytes, missing blob): existence-hiding,
 * fail-closed reads.
 */
export function readFinalizedBytes(
  deps: Pick<FinalizeDeps, 'files' | 'blobs'>,
  ref: FinalizedFileRef,
  caller: ReceivingContext,
): Uint8Array | null {
  const stored = deps.files.get(ref);
  if (stored === null) {
    return null;
  }
  if (stored.state !== 'finalized' && stored.state !== 'attached') {
    return null;
  }
  if (!isSameReceiver(stored.owner, caller)) {
    return null;
  }
  return deps.blobs.read(blobKeyForFile(stored.file.id));
}

/**
 * Read finalized metadata with its frozen provenance. Fail-closed and
 * existence-hiding like `readFinalizedBytes`: unknown references,
 * foreign callers and collected objects all read as null. The returned
 * record is the frozen immutable file (see `freezeFinalized`); callers
 * must never mutate it.
 *
 * This is the journey "provenance" step: attach/read callers verify the
 * bound provenance through this instead of raw store gets, which skip
 * the ownership check. Attachment authority itself stays with lane 3,
 * which records attachments through `recordAttachment` at the join.
 */
export function readFinalizedFile(
  deps: Pick<FinalizeDeps, 'files'>,
  ref: FinalizedFileRef,
  caller: ReceivingContext,
): FinalizedFile | null {
  const stored = deps.files.get(ref);
  if (stored === null) {
    return null;
  }
  if (stored.state !== 'finalized' && stored.state !== 'attached') {
    return null;
  }
  if (!isSameReceiver(stored.owner, caller)) {
    return null;
  }
  return stored.file;
}

/** Current stored-object state, or null for unknown references. */
export function storedState(
  deps: Pick<FinalizeDeps, 'files'>,
  ref: FinalizedFileRef,
): StoredObjectState | null {
  return deps.files.get(ref)?.state ?? null;
}

/* -- T27 controlled provider output through the intent lifecycle. -- */

/**
 * Stable retry identity for one provider-output slot. Derived
 * deterministically from the provenance binding so repeats of the same
 * (adapter, delivery, result path) address the same intent while any
 * other slot addresses its own. Binding validation stays with intent
 * creation (`bindRequestProvenance`); this derivation never throws.
 * The S8 join and its tests share this derivation; nothing else mints
 * provider retry identities.
 */
export function providerRetryId(binding: RequestProvenanceBinding): UploadRetryId {
  return `provider:${binding.adapter}:${binding.deliveryId}:${binding.resultPath}`;
}

export interface ProviderOutputInput {
  /** Receiving app/team/owner/principal that will own the finalized file. */
  readonly receiver: ReceivingContext;
  /**
   * Controlled-provider binding: `adapter` names the provider
   * deployment binding (e.g. `deployment.comfyui`), `deliveryId` the
   * delivery association, `resultPath` the output path within the run
   * (e.g. `outputs/0`). Frozen into the file provenance verbatim.
   */
  readonly binding: RequestProvenanceBinding;
  /**
   * File-slot triple binding the delivery result path: the generating
   * operation (e.g. `std.ImagesV1.submit`), the result path as a JSON
   * pointer absent from `args` (e.g. `/outputs/0`), and the frozen slot
   * arguments (`{}` when the delivery carries none).
   */
  readonly operation: string;
  readonly field: string;
  readonly args: Record<string, unknown>;
  /** Untrusted filename metadata (provider filename, never a path). */
  readonly name: string;
  /** Transport content-type claim; detected bytes win. */
  readonly claimedType: string;
  /** Downloaded provider bytes, bounded by the adapter. */
  readonly bytes: Uint8Array;
}

export type ProviderOutputOutcome =
  | { readonly status: 'finalized'; readonly result: FinalizeResult; readonly file: FinalizedFile }
  | { readonly status: 'repeated'; readonly result: FinalizeResult; readonly file: FinalizedFile }
  | {
      readonly status: 'failed';
      readonly reason:
        | 'invalid-request'
        | 'conflict'
        | 'expired'
        | 'oversized'
        | 'malformed'
        | 'rejected';
    };

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function finalizeSlotIntent(
  files: FinalizeDeps,
  record: UploadIntentRecord,
  retryId: UploadRetryId,
  bytes: Uint8Array,
  receiver: ReceivingContext,
): ProviderOutputOutcome {
  const outcome = finalizeUpload(files, {
    intentId: record.intentId,
    retryId,
    bytesDigest: sha256Hex(bytes),
    caller: receiver,
  });
  if (outcome.status === 'finalized' || outcome.status === 'repeated') {
    return { status: outcome.status, result: outcome.result, file: outcome.file };
  }
  if (outcome.reason === 'conflict' || outcome.reason === 'expired') {
    return { status: 'failed', reason: outcome.reason };
  }
  // Unreachable: the same receiver owns the slot from creation
  // (`foreign` impossible), and the slot is complete/finalized
  // (`partial` impossible).
  throw new Error(
    `finalizeProviderOutput: unreachable finalize outcome ${outcome.reason}`,
  );
}

function completeSlotIntent(
  upload: UploadDeps,
  files: FinalizeDeps,
  record: UploadIntentRecord,
  retryId: UploadRetryId,
  input: ProviderOutputInput,
): ProviderOutputOutcome {
  const completed = completeUploadContent(upload, record.intentId, input.receiver);
  if (completed.status === 'completed') {
    return finalizeSlotIntent(files, record, retryId, input.bytes, input.receiver);
  }
  if (
    completed.reason === 'expired' ||
    completed.reason === 'malformed' ||
    completed.reason === 'rejected'
  ) {
    return { status: 'failed', reason: completed.reason };
  }
  // Unreachable: the slot is open with exactly the declared bytes under
  // the owning receiver within policy (`foreign`/`closed`/`partial`/
  // `oversized` impossible).
  throw new Error(
    `finalizeProviderOutput: unreachable complete outcome ${completed.reason}`,
  );
}

function rederiveRejectedVerdict(
  upload: UploadDeps,
  input: ProviderOutputInput,
): ProviderOutputOutcome {
  const check = checkContent(upload.policy, input.claimedType, input.bytes);
  if (check.verdict === 'accepted') {
    // Same slot, same declared size, but bytes that now validate: they
    // differ from the rejected transfer's bytes (validation is
    // deterministic), so this is conflicting content for the slot.
    return { status: 'failed', reason: 'conflict' };
  }
  return { status: 'failed', reason: check.detectedType === null ? 'malformed' : 'rejected' };
}

/**
 * Finalize one controlled provider output through the receiving-app
 * intent lifecycle. The caller supplies downloaded bytes plus the slot
 * identity; this join derives the stable retry identity, drives
 * create/append/complete/finalize, and returns the finalized file.
 * Provider URLs are unrepresentable here: the input carries bytes
 * only, and blob keys stay runtime-minted.
 *
 * Slot behavior by intent state: `finalized` repeats the same
 * reference for identical bytes and conflicts otherwise (including
 * after retention collects the bytes: the row tombstone still
 * answers); `complete` finalizes or conflicts on digest mismatch;
 * `open` appends the missing suffix after verifying the staged
 * prefix, then completes; `rejected` re-derives the deterministic
 * verdict without touching the record; `expired` fails. A different
 * receiver, operation, field, arguments, name, claimed type or
 * declared size for the same slot conflicts at creation.
 */
export function finalizeProviderOutput(
  upload: UploadDeps,
  files: FinalizeDeps,
  input: ProviderOutputInput,
): ProviderOutputOutcome {
  if (!(input.bytes instanceof Uint8Array)) {
    throw new TypeError('finalizeProviderOutput: bytes must be a Uint8Array');
  }
  const retryId = providerRetryId(input.binding);
  const request: UploadIntentRequest = {
    upload_id: retryId,
    operation: input.operation,
    field: input.field,
    arguments: input.args,
    name: input.name,
    type: input.claimedType,
    size: String(input.bytes.length),
  };
  const created = createUploadIntent(upload, {
    request,
    receiver: input.receiver,
    binding: input.binding,
  });
  if (created.status === 'rejected') {
    return { status: 'failed', reason: created.reason };
  }
  const record = upload.intents.get(created.intentId);
  if (record === null) {
    throw new Error('finalizeProviderOutput: slot intent missing after create');
  }
  switch (record.state) {
    case 'finalized':
    case 'complete':
      return finalizeSlotIntent(files, record, retryId, input.bytes, input.receiver);
    case 'expired':
      return { status: 'failed', reason: 'expired' };
    case 'rejected':
      return rederiveRejectedVerdict(upload, input);
    case 'open': {
      const received = record.receivedBytes;
      if (received > input.bytes.length) {
        throw new Error('finalizeProviderOutput: staged bytes exceed the declared size');
      }
      if (received === input.bytes.length) {
        return completeSlotIntent(upload, files, record, retryId, input);
      }
      const staged = upload.blobs.read(stagingKeyForIntent(record.intentId)) ?? new Uint8Array(0);
      if (staged.length !== received || !bytesEqual(staged, input.bytes.slice(0, received))) {
        // Unverifiable resume: missing staging, stale bytes under a
        // fresh slot, or a prefix that is not this transfer's. Fail
        // closed without touching the record; expiry settles the slot.
        return { status: 'failed', reason: 'conflict' };
      }
      const appended = appendUploadContentAtOffset(
        upload,
        record.intentId,
        input.receiver,
        input.bytes.slice(received),
        received,
      );
      if (appended.status === 'failed') {
        if (appended.reason === 'expired') {
          return { status: 'failed', reason: 'expired' };
        }
        // Unreachable: the slot is open under the owning receiver and
        // the suffix lands exactly on the declared size within policy
        // (`closed`/`foreign`/`oversized` impossible).
        throw new Error(
          `finalizeProviderOutput: unreachable append outcome ${appended.reason}`,
        );
      }
      return completeSlotIntent(upload, files, record, retryId, input);
    }
  }
}
