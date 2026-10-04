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
 */
import type {
  ContentCheck,
  FilePolicy,
  FinalizeResult,
  FinalizedFile,
  FinalizedFileRef,
  StoredObjectState,
  UploadIntentId,
  UploadRetryId,
} from '../../../contracts/src/files.js';
import type {
  BlobStorePort,
  ClockPort,
  FileIdPort,
  FinalizedStorePort,
  IntentStorePort,
  UploadIntentRecord,
} from '../ports.ts';
import {
  freezeFinalized,
  isSameReceiver,
  requestProvenanceMatches,
  validateEventProvenance,
  type ReceivingContext,
} from '../provenance/index.ts';
import {
  checkContent,
  sha256Hex,
  stagingKeyForIntent,
} from '../upload/index.ts';

export interface FinalizeDeps {
  readonly clock: ClockPort;
  readonly fileIds: FileIdPort;
  readonly intents: IntentStorePort;
  readonly blobs: BlobStorePort;
  readonly files: FinalizedStorePort;
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
 */
export function finalizeUpload(deps: FinalizeDeps, input: FinalizeInput): FinalizeOutcome {
  const record = deps.intents.get(input.intentId);
  if (record === null || !callerOwnsIntent(record, input.caller)) {
    return { status: 'failed', reason: 'foreign' };
  }
  if (record.state === 'finalized') {
    if (input.retryId !== record.retryId || input.bytesDigest !== record.bytesDigest) {
      return { status: 'failed', reason: 'conflict' };
    }
    const stored =
      record.finalizedRef === null ? null : deps.files.get(record.finalizedRef);
    if (stored === null) {
      return { status: 'failed', reason: 'expired' };
    }
    return {
      status: 'repeated',
      result: { file: stored.file.id },
      file: stored.file,
    };
  }
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
  const staging = deps.blobs.read(stagingKeyForIntent(record.intentId));
  if (staging === null) {
    return { status: 'failed', reason: 'conflict' };
  }
  const actualDigest = sha256Hex(staging);
  if (actualDigest !== record.bytesDigest || input.bytesDigest !== record.bytesDigest) {
    return { status: 'failed', reason: 'conflict' };
  }
  if (record.detectedType === null) {
    return { status: 'failed', reason: 'conflict' };
  }
  const ref = deps.fileIds.nextFileId();
  const finalizedAtMs = deps.clock.nowMs();
  const provenance = record.provenance;
  if (provenance.kind !== 'request') {
    return { status: 'failed', reason: 'foreign' };
  }
  const file = freezeFinalized({
    id: ref,
    provenance,
    contentType: record.detectedType,
    sizeBytes: record.receivedBytes,
    bytesDigest: actualDigest,
    finalizedAt: new Date(finalizedAtMs).toISOString(),
  });
  deps.blobs.write(blobKeyForFile(ref), staging);
  deps.blobs.remove(stagingKeyForIntent(record.intentId));
  deps.files.put({
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
  return { status: 'finalized', result: { file: ref }, file };
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
    finalizedAt: new Date(finalizedAtMs).toISOString(),
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
 */
export function recordAttachment(
  deps: Pick<FinalizeDeps, 'files'>,
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

/** Current stored-object state, or null for unknown references. */
export function storedState(
  deps: Pick<FinalizeDeps, 'files'>,
  ref: FinalizedFileRef,
): StoredObjectState | null {
  return deps.files.get(ref)?.state ?? null;
}
