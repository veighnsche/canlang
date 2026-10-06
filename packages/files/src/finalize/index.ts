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
import type { UploadIntentRequest } from '../../../contracts/src/wire.js';
import {
  freezeFinalized,
  isSameReceiver,
  requestProvenanceMatches,
  validateEventProvenance,
  type ReceivingContext,
  type RequestProvenanceBinding,
} from '../provenance/index.ts';
import {
  appendUploadContent,
  checkContent,
  completeUploadContent,
  createUploadIntent,
  sha256Hex,
  stagingKeyForIntent,
  type UploadDeps,
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
    finalizedAt: { kind: 'datetime', ms: BigInt(finalizedAtMs) },
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
      const appended = appendUploadContent(
        upload,
        record.intentId,
        input.receiver,
        input.bytes.slice(received),
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
