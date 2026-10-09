/**
 * Upload intents and content transfer (DESIGN section 8, bridge v1 steps
 * 1-2: `POST /files/intents`, content append/complete).
 *
 * Intent creation resolves the receiving app/user/team and operation
 * authority from the runtime-resolved receiver; it never establishes
 * acceptance. Content appends accumulate staging bytes behind the blob
 * port with an incremental oversize guard; completion validates the
 * actual bytes (magic-byte detection against the effective policy, never
 * MIME labels) and records digest evidence. A partial, rejected,
 * oversized or malformed transfer yields no usable file.
 *
 * Schema-aware argument validation (invented inputs, protected bindings,
 * business guards over incomplete inputs) needs the owning operation
 * schemas and stays an S8 join with L1/L6; this module enforces only the
 * structural request shape plus the absent-file-slot rule.
 */
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import type {
  ContentCheck,
  FilePolicy,
  UploadIntentGrant,
  UploadIntentId,
} from '@canlang/contracts';
import type { UploadIntentRequest } from '@canlang/contracts';
import type {
  BlobStorePort,
  ClockPort,
  IntentIdPort,
  IntentStorePort,
  UploadIntentRecord,
} from '../ports.js';
import {
  bindRequestProvenance,
  requestProvenanceMatches,
  type ReceivingContext,
  type RequestProvenanceBinding,
} from '../provenance/index.js';

/**
 * Language-version-pinned baseline policy (DESIGN section 8). Values
 * mirror the lane-6 wire defaults (`DEFAULT_UPLOAD_TYPES`,
 * `DEFAULT_UPLOAD_MAX_BYTES`); standalone TS-source tests cannot
 * runtime-import contracts values, so a runtime equality pin belongs
 * in L7's assembly test (handoff filed), and full value convergence
 * awaits the `@canlang/contracts` workspace join. A `files` context
 * declaration supplies only deviations. Policy values never grant
 * access.
 */
export const DEFAULT_FILE_POLICY: FilePolicy = {
  types: ['application/pdf', 'image/png', 'image/jpeg', 'text/plain'],
  maxBytes: 10 * 1024 * 1024,
};

export interface UploadDeps {
  readonly clock: ClockPort;
  readonly intentIds: IntentIdPort;
  readonly intents: IntentStorePort;
  readonly blobs: BlobStorePort;
  readonly policy: FilePolicy;
  readonly intentTtlMs: number;
  /**
   * Validated same-origin HTTPS base (no trailing slash) used to mint
   * grant destinations. The bridge always overrides this with its own
   * validated origin, so grants can never carry a model-supplied
   * endpoint; direct callers must pass a validated base.
   */
  readonly urlBase: string;
}

export interface CreateIntentInput {
  readonly request: UploadIntentRequest;
  readonly receiver: ReceivingContext;
  readonly binding: RequestProvenanceBinding;
}

export type CreateIntentOutcome =
  | { readonly status: 'granted'; readonly grant: UploadIntentGrant; readonly intentId: UploadIntentId }
  | { readonly status: 'duplicate'; readonly grant: UploadIntentGrant; readonly intentId: UploadIntentId }
  | { readonly status: 'rejected'; readonly reason: 'invalid-request' | 'conflict' | 'oversized' };

export type AppendOutcome =
  | { readonly status: 'appended'; readonly receivedBytes: number }
  | { readonly status: 'failed'; readonly reason: 'foreign' | 'closed' | 'expired' | 'oversized' };

export type CompleteOutcome =
  | { readonly status: 'completed'; readonly check: ContentCheck }
  | { readonly status: 'failed'; readonly reason: 'foreign' | 'closed' | 'expired' | 'partial' | 'oversized' }
  | { readonly status: 'failed'; readonly reason: 'malformed' | 'rejected'; readonly check: ContentCheck };

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff]);

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function startsWith(bytes: Uint8Array, magic: Uint8Array): boolean {
  if (bytes.length < magic.length) {
    return false;
  }
  for (let i = 0; i < magic.length; i += 1) {
    if (bytes[i] !== magic[i]) {
      return false;
    }
  }
  return true;
}

function isPlainText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) {
    return false;
  }
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0) {
      return false;
    }
  }
  try {
    strictUtf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the content type from actual bytes. Binary magics win over text
 * (ambiguous content resolves to the structured format); anything else is
 * text/plain only when it is non-empty, NUL-free, valid UTF-8. This is
 * magic-byte detection, not a format parser: full structural parsing is
 * out of scope.
 */
export function detectContentType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, PDF_MAGIC)) {
    return 'application/pdf';
  }
  if (startsWith(bytes, PNG_MAGIC)) {
    return 'image/png';
  }
  if (startsWith(bytes, JPEG_MAGIC)) {
    return 'image/jpeg';
  }
  if (isPlainText(bytes)) {
    return 'text/plain';
  }
  return null;
}

/**
 * Validate bytes against the effective policy. The verdict follows the
 * detected bytes only; the claimed label is recorded as evidence and
 * never trusted.
 */
export function checkContent(
  policy: FilePolicy,
  claimedType: string,
  bytes: Uint8Array,
): ContentCheck {
  const detectedType = detectContentType(bytes);
  const sizeBytes = bytes.length;
  const verdict =
    detectedType !== null &&
    policy.types.includes(detectedType) &&
    sizeBytes <= policy.maxBytes
      ? 'accepted'
      : 'rejected';
  return { claimedType, detectedType, sizeBytes, verdict };
}

/** Digest of immutable bytes for conflict detection (`sha256:` hex). */
export function sha256Hex(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Staging blob key for an intent. Callers must pass the stored id. */
export function stagingKeyForIntent(intentId: UploadIntentId): string {
  return `u_${intentId}.part`;
}

function isCanonicalSize(value: string): boolean {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
}

function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * True when the file slot addressed by `field` is absent from `args`: the
 * pointer must be a well-formed JSON Pointer into objects, and its final
 * token must not exist. CRUD changes slots (`/changes/attachment`) walk
 * through the parent object instead of rejecting the whole `changes` arg.
 */
function fileSlotAbsent(args: Record<string, unknown>, field: string): boolean {
  if (typeof field !== 'string' || !field.startsWith('/') || field === '/') {
    return false;
  }
  const tokens = field.split('/').slice(1).map(unescapePointerToken);
  if (tokens.some((token) => token.length === 0)) {
    return false;
  }
  let current: unknown = args;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return true;
    }
    const next = (current as Record<string, unknown>)[tokens[i] as string];
    if (next === undefined) {
      return true;
    }
    current = next;
  }
  if (typeof current !== 'object' || current === null || Array.isArray(current)) {
    return true;
  }
  return !((tokens[tokens.length - 1] as string) in current);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b || typeof a !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const aKeys = Object.keys(a as Record<string, unknown>).sort();
  const bKeys = Object.keys(b as Record<string, unknown>).sort();
  if (aKeys.length !== bKeys.length || aKeys.some((key, index) => key !== bKeys[index])) {
    return false;
  }
  return aKeys.every((key) =>
    deepEqual(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
    ),
  );
}

function cloneArgs(args: Record<string, unknown>): Record<string, unknown> | null {
  try {
    return JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function sameIntentContext(
  record: UploadIntentRecord,
  request: UploadIntentRequest,
  declaredSize: number,
  receiver: ReceivingContext,
): boolean {
  if (record.provenance.kind !== 'request') {
    return false;
  }
  return (
    record.operation === request.operation &&
    record.field === request.field &&
    deepEqual(record.args, request.arguments) &&
    record.name === request.name &&
    record.claimedType === request.type &&
    record.declaredSize === declaredSize &&
    requestProvenanceMatches(record.provenance, receiver)
  );
}

function storedGrant(record: UploadIntentRecord): UploadIntentGrant {
  return {
    intent_id: record.intentId,
    content: record.contentUrl,
    finalize: record.finalizeUrl,
    expires_at: record.expiresAt,
  };
}

function sweepExpiredIntent(
  deps: UploadDeps,
  record: UploadIntentRecord,
): void {
  record.state = 'expired';
  record.receivedBytes = 0;
  record.bytesDigest = null;
  record.detectedType = null;
  deps.blobs.remove(stagingKeyForIntent(record.intentId));
  deps.intents.put(record);
}

function callerOwnsIntent(record: UploadIntentRecord, caller: ReceivingContext): boolean {
  return (
    record.provenance.kind === 'request' &&
    requestProvenanceMatches(record.provenance, caller)
  );
}

/**
 * Mint an upload intent (bridge v1 step 1). Repeating the identical
 * request under the same stable retry identity returns the same grant;
 * the same retry identity with conflicting operation/field/arguments or
 * a conflicting receiver fails. Grant destinations are minted from the
 * configured origin only.
 */
export function createUploadIntent(
  deps: UploadDeps,
  input: CreateIntentInput,
): CreateIntentOutcome {
  const { request, receiver, binding } = input;
  const provenance = bindRequestProvenance(receiver, binding);
  if (provenance === null) {
    return { status: 'rejected', reason: 'invalid-request' };
  }
  if (
    typeof request !== 'object' ||
    request === null ||
    typeof request.upload_id !== 'string' ||
    request.upload_id.length === 0 ||
    typeof request.operation !== 'string' ||
    request.operation.length === 0 ||
    typeof request.field !== 'string' ||
    typeof request.name !== 'string' ||
    request.name.length === 0 ||
    typeof request.type !== 'string' ||
    request.type.length === 0 ||
    typeof request.arguments !== 'object' ||
    request.arguments === null ||
    Array.isArray(request.arguments) ||
    !isCanonicalSize(request.size)
  ) {
    return { status: 'rejected', reason: 'invalid-request' };
  }
  if (!fileSlotAbsent(request.arguments, request.field)) {
    return { status: 'rejected', reason: 'invalid-request' };
  }
  if (
    typeof deps.urlBase !== 'string' ||
    !deps.urlBase.startsWith('https://') ||
    deps.urlBase.endsWith('/')
  ) {
    return { status: 'rejected', reason: 'invalid-request' };
  }
  const declaredSize = Number(request.size);
  if (!Number.isSafeInteger(declaredSize)) {
    return { status: 'rejected', reason: 'invalid-request' };
  }
  if (declaredSize > deps.policy.maxBytes) {
    return { status: 'rejected', reason: 'oversized' };
  }
  const existing = deps.intents.getByRetryId(request.upload_id);
  if (existing !== null) {
    if (!sameIntentContext(existing, request, declaredSize, receiver)) {
      return { status: 'rejected', reason: 'conflict' };
    }
    return { status: 'duplicate', grant: storedGrant(existing), intentId: existing.intentId };
  }
  const nowMs = deps.clock.nowMs();
  const expiresAtMs = nowMs + deps.intentTtlMs;
  const intentId = deps.intentIds.nextIntentId();
  const args = cloneArgs(request.arguments);
  if (args === null) {
    return { status: 'rejected', reason: 'invalid-request' };
  }
  const record: UploadIntentRecord = {
    intentId,
    retryId: request.upload_id,
    operation: request.operation,
    field: request.field,
    args,
    name: request.name,
    claimedType: request.type,
    declaredSize,
    provenance,
    contentUrl: `${deps.urlBase}/files/content/${encodeURIComponent(intentId)}`,
    finalizeUrl: `${deps.urlBase}/files/finalize/${encodeURIComponent(intentId)}`,
    createdAtMs: nowMs,
    expiresAtMs,
    expiresAt: new Date(expiresAtMs).toISOString(),
    state: 'open',
    receivedBytes: 0,
    bytesDigest: null,
    detectedType: null,
    finalizedRef: null,
  };
  deps.intents.put(record);
  return { status: 'granted', grant: storedGrant(record), intentId };
}

/**
 * Append one content chunk to an open intent. Oversize trips the
 * incremental guard: the intent is rejected and partial bytes are
 * deleted, so no file can result. The guard trips on both the policy
 * ceiling and the declared transfer size (completion requires an exact
 * byte count, so over-declared sends can never complete and fail fast
 * here instead of stalling as partial). Unknown intents and foreign
 * callers share the `foreign` outcome (no existence oracle).
 * Staging must agree with the persisted count before another append:
 * interrupted writes cannot be retried as fresh chunks. A mismatch
 * rejects the intent rather than guessing which bytes were committed.
 */
export function appendUploadContent(
  deps: UploadDeps,
  intentId: UploadIntentId,
  caller: ReceivingContext,
  chunk: Uint8Array,
): AppendOutcome {
  const record = deps.intents.get(intentId);
  if (record === null || !callerOwnsIntent(record, caller)) {
    return { status: 'failed', reason: 'foreign' };
  }
  if (record.state === 'expired' || deps.clock.nowMs() >= record.expiresAtMs) {
    if (record.state !== 'expired') {
      sweepExpiredIntent(deps, record);
    }
    return { status: 'failed', reason: 'expired' };
  }
  if (record.state !== 'open') {
    return { status: 'failed', reason: 'closed' };
  }
  if (
    record.receivedBytes + chunk.length > deps.policy.maxBytes ||
    record.receivedBytes + chunk.length > record.declaredSize
  ) {
    record.state = 'rejected';
    record.receivedBytes = 0;
    record.bytesDigest = null;
    record.detectedType = null;
    deps.blobs.remove(stagingKeyForIntent(record.intentId));
    deps.intents.put(record);
    return { status: 'failed', reason: 'oversized' };
  }
  const stagingKey = stagingKeyForIntent(record.intentId);
  if ((deps.blobs.sizeOf(stagingKey) ?? 0) !== record.receivedBytes) {
    record.state = 'rejected';
    record.receivedBytes = 0;
    record.bytesDigest = null;
    record.detectedType = null;
    deps.blobs.remove(stagingKey);
    deps.intents.put(record);
    return { status: 'failed', reason: 'closed' };
  }
  if (chunk.length > 0) {
    deps.blobs.append(stagingKey, chunk);
    record.receivedBytes += chunk.length;
    deps.intents.put(record);
  }
  return { status: 'appended', receivedBytes: record.receivedBytes };
}

/**
 * Mark a transfer complete and validate the actual bytes. Short reads
 * stay open for resume (`partial`, bytes kept); oversize and malformed
 * transfers are rejected with their staging bytes deleted. Either way a
 * failed completion yields no file.
 */
export function completeUploadContent(
  deps: UploadDeps,
  intentId: UploadIntentId,
  caller: ReceivingContext,
): CompleteOutcome {
  const record = deps.intents.get(intentId);
  if (record === null || !callerOwnsIntent(record, caller)) {
    return { status: 'failed', reason: 'foreign' };
  }
  if (record.state === 'expired' || deps.clock.nowMs() >= record.expiresAtMs) {
    if (record.state !== 'expired') {
      sweepExpiredIntent(deps, record);
    }
    return { status: 'failed', reason: 'expired' };
  }
  if (record.state !== 'open') {
    return { status: 'failed', reason: 'closed' };
  }
  if (record.receivedBytes !== record.declaredSize) {
    return { status: 'failed', reason: 'partial' };
  }
  if (record.receivedBytes > deps.policy.maxBytes) {
    record.state = 'rejected';
    record.receivedBytes = 0;
    deps.blobs.remove(stagingKeyForIntent(record.intentId));
    deps.intents.put(record);
    return { status: 'failed', reason: 'oversized' };
  }
  const stored = deps.blobs.read(stagingKeyForIntent(record.intentId));
  const bytes = stored ?? new Uint8Array(0);
  if (stored === null && record.receivedBytes > 0) {
    // Staging vanished under a counted transfer: fail closed, no file.
    record.state = 'rejected';
    record.receivedBytes = 0;
    deps.intents.put(record);
    const check = checkContent(deps.policy, record.claimedType, bytes);
    return { status: 'failed', reason: 'malformed', check };
  }
  if (bytes.byteLength > record.declaredSize || bytes.byteLength > deps.policy.maxBytes) {
    record.state = 'rejected';
    record.receivedBytes = 0;
    deps.blobs.remove(stagingKeyForIntent(record.intentId));
    deps.intents.put(record);
    return { status: 'failed', reason: 'oversized' };
  }
  if (bytes.byteLength < record.declaredSize) {
    return { status: 'failed', reason: 'partial' };
  }
  const check = checkContent(deps.policy, record.claimedType, bytes);
  if (check.verdict === 'rejected') {
    record.state = 'rejected';
    record.receivedBytes = 0;
    record.bytesDigest = null;
    record.detectedType = null;
    deps.blobs.remove(stagingKeyForIntent(record.intentId));
    deps.intents.put(record);
    // Undetectable bytes are malformed; detected-but-excluded bytes are
    // policy-rejected. Both delete staging and yield no file.
    const reason = check.detectedType === null ? 'malformed' : 'rejected';
    return { status: 'failed', reason, check };
  }
  record.state = 'complete';
  record.bytesDigest = sha256Hex(bytes);
  record.detectedType = check.detectedType;
  deps.intents.put(record);
  return { status: 'completed', check };
}
