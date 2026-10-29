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
  FilePolicy,
  FileReferenceStoragePort,
  FileRetirementAuthority,
  FileRetentionPolicy,
  FinalizedFileIdentity,
  FinalizedFileRetirement,
  FinalizedFileRef,
  Revision,
  UploadIntentId,
} from '@canlang/contracts';
import type {
  BlobStorePort,
  ClockPort,
  FinalizedStorePort,
  FinalizedFileDeletionRecord,
  IntentStorePort,
  PagedFinalizedStorePort,
  PagedIntentStorePort,
  StoredFileRecord,
  UploadIntentRecord,
} from '../ports.js';
import { assertSafeBlobKey } from '../ports.js';
import { blobKeyForFile } from '../finalize/index.js';
import { stagingKeyForIntent } from '../upload/index.js';
import { checkContent, sha256Hex } from '../upload/index.js';
import { freezeFinalized } from '../provenance/index.js';

const cleanupRefuse = (message: string): never => { throw new Error(`File retirement cleanup: ${message}`); };
function closedData(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return cleanupRefuse('closed own data required');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return cleanupRefuse('plain own data required');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) ||
      required.some(key => !Object.hasOwn(descriptors, key))) return cleanupRefuse('closed metadata required');
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) return cleanupRefuse('own enumerable data required');
    result[key] = descriptor.value;
  }
  return result;
}
function cleanupText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return cleanupRefuse('nonempty identity required');
  return value;
}
function cleanupTime(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return cleanupRefuse('safe nonnegative integer required');
  return value;
}
function cleanupReceiver(value: unknown) {
  const row = closedData(value, ['app', 'team', 'owner', 'principal']);
  return Object.freeze({ app: cleanupText(row.app), team: cleanupText(row.team),
    owner: cleanupText(row.owner), principal: cleanupText(row.principal) });
}
function cleanupRetention(value: unknown): FileRetentionPolicy {
  const row = closedData(value, ['unattachedHorizonMs', 'retentionMs'], ['retainAttached']);
  if (Object.hasOwn(row, 'retainAttached') && row.retainAttached !== true) return cleanupRefuse('invalid attached retention');
  return Object.freeze({ unattachedHorizonMs: cleanupTime(row.unattachedHorizonMs), retentionMs: cleanupTime(row.retentionMs),
    ...(row.retainAttached === true ? { retainAttached: true as const } : {}) });
}
/** Closed detached correspondence facts only; this does not authenticate State. */
export function checkedFileCleanupAuthority(value: unknown): FileRetirementAuthority {
  const row = closedData(value, ['app', 'stateOwner', 'stateStoreId', 'fileStoreId', 'receiver']);
  const receiver = closedData(row.receiver, ['app', 'team', 'owner']);
  const result = Object.freeze({ app: cleanupText(row.app), stateOwner: cleanupText(row.stateOwner),
    stateStoreId: cleanupText(row.stateStoreId), fileStoreId: cleanupText(row.fileStoreId),
    receiver: Object.freeze({ app: cleanupText(receiver.app), team: cleanupText(receiver.team), owner: cleanupText(receiver.owner) }) });
  if (result.app !== result.receiver.app) return cleanupRefuse('receiving app mismatch');
  return result;
}
function cleanupIdentity(value: unknown): FinalizedFileIdentity {
  const row = closedData(value, ['ref', 'receiver', 'provenance', 'contentType', 'sizeBytes', 'bytesDigest', 'finalizedAtMs']);
  const ref = cleanupText(row.ref);
  assertSafeBlobKey(blobKeyForFile(ref));
  const receiver = cleanupReceiver(row.receiver);
  const kind = typeof row.provenance === 'object' && row.provenance !== null
    ? Object.getOwnPropertyDescriptor(row.provenance, 'kind') : undefined;
  if (kind === undefined || !('value' in kind)) return cleanupRefuse('own provenance required');
  let provenance: FinalizedFileIdentity['provenance'];
  if (kind.value === 'request') {
    const p = closedData(row.provenance, ['kind', 'app', 'team', 'owner', 'principal', 'adapter', 'deliveryId', 'resultPath']);
    provenance = Object.freeze({ kind: 'request', app: cleanupText(p.app), team: cleanupText(p.team),
      owner: cleanupText(p.owner), principal: cleanupText(p.principal), adapter: cleanupText(p.adapter),
      deliveryId: cleanupText(p.deliveryId), resultPath: cleanupText(p.resultPath) });
    if (provenance.app !== receiver.app || provenance.team !== receiver.team || provenance.owner !== receiver.owner ||
        provenance.principal !== receiver.principal) return cleanupRefuse('original request receiver mismatch');
  } else if (kind.value === 'event') {
    const p = closedData(row.provenance, ['kind', 'source', 'adapter', 'occurrenceId', 'fieldPath', 'itemIndex']);
    provenance = Object.freeze({ kind: 'event', source: cleanupText(p.source), adapter: cleanupText(p.adapter),
      occurrenceId: cleanupText(p.occurrenceId), fieldPath: cleanupText(p.fieldPath), itemIndex: cleanupTime(p.itemIndex) });
  } else return cleanupRefuse('original provenance required');
  const bytesDigest = cleanupText(row.bytesDigest);
  if (!/^sha256:[0-9a-f]{64}$/.test(bytesDigest)) return cleanupRefuse('original digest required');
  return Object.freeze({ ref, receiver, provenance, contentType: cleanupText(row.contentType),
    sizeBytes: cleanupTime(row.sizeBytes), bytesDigest, finalizedAtMs: cleanupTime(row.finalizedAtMs) });
}
/** Snapshot a complete physical row without invoking getters or trusting casts. */
export function checkedFileCleanupRecord(value: unknown): StoredFileRecord {
  const row = closedData(value, ['file', 'owner', 'finalizedAtMs', 'state', 'attachedRecord'], ['attachedAtMs']);
  const f = closedData(row.file, ['id', 'provenance', 'contentType', 'sizeBytes', 'bytesDigest', 'finalizedAt']);
  const date = closedData(f.finalizedAt, ['kind', 'ms']);
  const identity = cleanupIdentity({ ref: f.id, receiver: row.owner, provenance: f.provenance,
    contentType: f.contentType, sizeBytes: f.sizeBytes, bytesDigest: f.bytesDigest, finalizedAtMs: row.finalizedAtMs });
  if (date.kind !== 'datetime' || typeof date.ms !== 'bigint' || date.ms !== BigInt(identity.finalizedAtMs) ||
      !['finalized', 'attached', 'orphaned', 'expired'].includes(row.state as string) ||
      row.attachedRecord !== null && (typeof row.attachedRecord !== 'string' || row.attachedRecord.length === 0) ||
      row.state === 'attached' && row.attachedRecord === null) return cleanupRefuse('physical lifecycle/time mismatch');
  const attachedAtMs = Object.hasOwn(row, 'attachedAtMs') ? cleanupTime(row.attachedAtMs) : undefined;
  if (row.state === 'finalized' && (row.attachedRecord !== null || attachedAtMs !== undefined)) {
    return cleanupRefuse('unattached lifecycle mismatch');
  }
  if (attachedAtMs !== undefined && (row.attachedRecord === null || attachedAtMs < identity.finalizedAtMs)) {
    return cleanupRefuse('attachment time mismatch');
  }
  return Object.freeze({ file: freezeFinalized({ id: identity.ref, provenance: { ...identity.provenance },
    contentType: identity.contentType, sizeBytes: identity.sizeBytes, bytesDigest: identity.bytesDigest,
    finalizedAt: { kind: 'datetime', ms: BigInt(identity.finalizedAtMs) } }), owner: identity.receiver,
    finalizedAtMs: identity.finalizedAtMs, state: row.state as StoredFileRecord['state'],
    attachedRecord: row.attachedRecord as string | null, ...(attachedAtMs === undefined ? {} : { attachedAtMs }) });
}
function identityOf(record: StoredFileRecord): FinalizedFileIdentity {
  return cleanupIdentity({ ref: record.file.id, receiver: record.owner, provenance: record.file.provenance,
    contentType: record.file.contentType, sizeBytes: record.file.sizeBytes, bytesDigest: record.file.bytesDigest,
    finalizedAtMs: record.finalizedAtMs });
}
function cleanupDecision(value: unknown): FinalizedFileRetirement {
  const row = closedData(value, ['retirementId', 'authority', 'file', 'snapshot', 'censusRevision', 'retiredRevision', 'retiredAtMs', 'disposition', 'retention']);
  const snapshot = closedData(row.snapshot, ['owner', 'snapshotId', 'digest', 'installedRevision', 'installedAt']);
  const censusRevision = cleanupTime(row.censusRevision), retiredRevision = cleanupTime(row.retiredRevision);
  const installedRevision = cleanupTime(snapshot.installedRevision);
  if (typeof snapshot.installedAt !== 'number' || !Number.isFinite(snapshot.installedAt)) return cleanupRefuse('finite installed time required');
  const installedAt = snapshot.installedAt;
  const file = cleanupIdentity(row.file), retention = cleanupRetention(row.retention), retiredAtMs = cleanupTime(row.retiredAtMs);
  if (retiredRevision !== censusRevision + 1 || installedRevision > censusRevision || retiredAtMs < file.finalizedAtMs ||
      row.disposition !== 'orphaned' && row.disposition !== 'expired') return cleanupRefuse('original decision/revision mismatch');
  const elapsed = BigInt(retiredAtMs) - BigInt(file.finalizedAtMs);
  if (retention.retainAttached === true && row.disposition === 'expired' || elapsed < BigInt(row.disposition === 'expired' ? retention.retentionMs : retention.unattachedHorizonMs)) {
    return cleanupRefuse('original retirement is not due');
  }
  return Object.freeze({ retirementId: cleanupText(row.retirementId), authority: checkedFileCleanupAuthority(row.authority), file,
    snapshot: Object.freeze({ owner: cleanupText(snapshot.owner), snapshotId: cleanupText(snapshot.snapshotId),
      digest: cleanupText(snapshot.digest), installedRevision: installedRevision as Revision, installedAt }),
    censusRevision: censusRevision as Revision, retiredRevision: retiredRevision as Revision,
    retiredAtMs, disposition: row.disposition, retention });
}
const cleanupEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function sameCleanupRecord(left: StoredFileRecord, right: StoredFileRecord): boolean {
  return cleanupEqual(identityOf(left), identityOf(right)) && left.state === right.state &&
    left.attachedRecord === right.attachedRecord && left.attachedAtMs === right.attachedAtMs;
}

/** Trusted host mechanics; journal/transaction implementations are not issuers. */
export interface FinalizedFileCleanupDeps {
  readonly clock: ClockPort;
  readonly files: FinalizedStorePort;
  readonly blobs: BlobStorePort;
  readAuthority(): FileRetirementAuthority | null;
  readDeletion(ref: FinalizedFileRef): FinalizedFileDeletionRecord | null;
  saveDeletion(record: FinalizedFileDeletionRecord): void;
  transaction<T>(body: () => T): T;
}

/** Bind the actual original State owner port outside request data. Capture its
 * lookup once; accept only a ref, never a caller DTO/census/issuer callback.
 * Shape checks and copies establish correspondence, not durable issuance.
 * The host must supply the genuine port after State guard/profile qualification. */
/**
 * Snapshot the CURRENT content policy before the async issuer lookup;
 * later mutation cannot change the policy half of the call's physical
 * decision. Throws (refuses) unless the policy is bounded own data.
 */
function snapshotCleanupContentPolicy(current: FilePolicy): FilePolicy {
  const p = closedData(current, ['types', 'maxBytes']);
  if (!Array.isArray(p.types) || p.types.length > 100) return cleanupRefuse('bounded current content policy required');
  const types = Object.getOwnPropertyDescriptors(p.types);
  if (Reflect.ownKeys(types).length !== p.types.length + 1 || Object.getPrototypeOf(p.types) !== Array.prototype) {
    return cleanupRefuse('own dense current content types required');
  }
  const policy: FilePolicy = { maxBytes: cleanupTime(p.maxBytes), types: [] };
  for (let i = 0; i < p.types.length; i++) {
    const d = types[String(i)];
    if (d === undefined || !('value' in d) || !d.enumerable) return cleanupRefuse('own current content type required');
    policy.types.push(cleanupText(d.value));
  }
  return policy;
}

interface CleanupDeleteScope {
  readonly ref: FinalizedFileRef;
  readonly authority: FileRetirementAuthority;
  readonly decision: FinalizedFileRetirement;
  readonly retention: FileRetentionPolicy;
  readonly policy: FilePolicy;
  readonly before: StoredFileRecord;
  readonly readAuthority: () => FileRetirementAuthority | null;
  readonly readDeletion: (ref: FinalizedFileRef) => FinalizedFileDeletionRecord | null;
  readonly saveDeletion: (record: FinalizedFileDeletionRecord) => void;
  readonly get: (ref: FinalizedFileRef) => StoredFileRecord | null;
  readonly put: (record: StoredFileRecord) => void;
  readonly read: (key: string) => Uint8Array | null;
  readonly remove: (key: string) => void;
  readonly nowMs: () => number;
}

/**
 * Run the deleting transaction: recheck the persisted assignment,
 * the current content policy and retirement due-ness, then the original
 * physical metadata/journal/bytes before deleting. Called inside the
 * host's transaction by the cleanup closure, preserving its atomicity.
 */
function runCleanupDelete(scope: CleanupDeleteScope): 'deleted' | 'already-deleted' {
  const { ref, authority, decision, retention, before } = scope;
  if (!cleanupEqual(authority, checkedFileCleanupAuthority(scope.readAuthority())) || !cleanupEqual(decision.authority, authority) ||
      decision.file.ref !== ref || decision.file.receiver.app !== authority.receiver.app ||
      decision.file.receiver.team !== authority.receiver.team || decision.file.receiver.owner !== authority.receiver.owner) {
    return cleanupRefuse('issuer/physical assignment mismatch');
  }
  const now = cleanupTime(scope.nowMs());
  if (decision.file.sizeBytes > scope.policy.maxBytes || !scope.policy.types.includes(decision.file.contentType)) {
    return cleanupRefuse('current content policy refuses');
  }
  if (retention.retainAttached === true && decision.disposition === 'expired' || now < decision.retiredAtMs || BigInt(now) - BigInt(decision.file.finalizedAtMs) <
      BigInt(decision.disposition === 'expired' ? retention.retentionMs : retention.unattachedHorizonMs)) {
    return cleanupRefuse('current retirement is not due');
  }
  const stored = checkedFileCleanupRecord(scope.get(ref));
  if (!sameCleanupRecord(stored, before) || !cleanupEqual(identityOf(stored), decision.file) ||
      stored.attachedAtMs !== undefined && stored.attachedAtMs > now) {
    return cleanupRefuse('original physical metadata mismatch');
  }
  const saved = scope.readDeletion(ref);
  verifyCleanupJournal(decision, stored, saved);
  const detached = readCleanupBytes(scope, decision, saved);
  if (detached === 'already-deleted') {
    return 'already-deleted';
  }
  if (saved === null) {
    const tombstone = { ...stored, state: decision.disposition };
    scope.saveDeletion({ retirement: decision, tombstone });
    scope.put(tombstone);
  }
  scope.remove(blobKeyForFile(ref));
  return 'deleted';
}

/**
 * Check the original terminal journal against the decision and stored
 * row. Terminal rows without a journal refuse; mismatches refuse.
 */
function verifyCleanupJournal(
  decision: FinalizedFileRetirement,
  stored: StoredFileRecord,
  saved: FinalizedFileDeletionRecord | null,
): void {
  if (saved !== null) {
    const journal = closedData(saved, ['retirement', 'tombstone']);
    const original = cleanupDecision(journal.retirement), tombstone = checkedFileCleanupRecord(journal.tombstone);
    if (!cleanupEqual(original, decision) || tombstone.state !== decision.disposition || stored.state !== decision.disposition ||
        !cleanupEqual(identityOf(tombstone), identityOf(stored)) || tombstone.attachedRecord !== stored.attachedRecord ||
        tombstone.attachedAtMs !== stored.attachedAtMs) return cleanupRefuse('original terminal journal mismatch');
  } else if (stored.state === 'orphaned' || stored.state === 'expired') {
    return cleanupRefuse('terminal row has no original journal');
  }
}

/**
 * Read and validate the original physical bytes. Missing bytes behind a
 * journaled deletion report `already-deleted`; anything else that does
 * not match the decision refuses.
 */
function readCleanupBytes(
  scope: CleanupDeleteScope,
  decision: FinalizedFileRetirement,
  saved: FinalizedFileDeletionRecord | null,
): Uint8Array | 'already-deleted' {
  const bytes = scope.read(blobKeyForFile(scope.ref));
  if (bytes === null) {
    if (saved === null) return cleanupRefuse('missing bytes have no original terminal journal');
    return 'already-deleted';
  }
  const detached = new Uint8Array(bytes);
  if (detached.byteLength !== decision.file.sizeBytes || sha256Hex(detached) !== decision.file.bytesDigest) {
    return cleanupRefuse('original physical bytes mismatch');
  }
  const content = checkContent(scope.policy, decision.file.contentType, detached);
  if (content.verdict !== 'accepted' || content.detectedType !== decision.file.contentType || content.sizeBytes !== decision.file.sizeBytes) {
    return cleanupRefuse('current content policy refuses');
  }
  return detached;
}

export function createFinalizedFileCleanup(
  deps: FinalizedFileCleanupDeps,
  storage: FileReferenceStoragePort,
  options: { readonly policy: FilePolicy; readonly retention: FileRetentionPolicy },
): (ref: FinalizedFileRef) => Promise<'deleted' | 'already-deleted'> {
  const authority = checkedFileCleanupAuthority(storage.fileRetirementAuthority);
  const readRetirement = storage.readFinalizedFileRetirement.bind(storage);
  const readAuthority = deps.readAuthority.bind(deps), readDeletion = deps.readDeletion.bind(deps);
  const saveDeletion = deps.saveDeletion.bind(deps), transaction = deps.transaction.bind(deps);
  const get = deps.files.get.bind(deps.files), put = deps.files.put.bind(deps.files);
  const read = deps.blobs.read.bind(deps.blobs), remove = deps.blobs.remove.bind(deps.blobs), nowMs = deps.clock.nowMs.bind(deps.clock);
  if (!cleanupEqual(authority, checkedFileCleanupAuthority(readAuthority()))) return cleanupRefuse('persisted physical assignment mismatch');
  return async ref => {
    assertSafeBlobKey(ref);
    assertSafeBlobKey(blobKeyForFile(ref));
    // Snapshot CURRENT policy before the async issuer lookup; later mutation
    // cannot change the policy half of this call's physical decision.
    const retention = cleanupRetention(options.retention);
    const policy = snapshotCleanupContentPolicy(options.policy);
    const before = transaction(() => {
      if (!cleanupEqual(authority, checkedFileCleanupAuthority(readAuthority()))) return cleanupRefuse('persisted physical assignment mismatch');
      return checkedFileCleanupRecord(get(ref));
    });
    const decision = cleanupDecision(await readRetirement(ref));
    const scope: CleanupDeleteScope = { ref, authority, decision, retention, policy, before,
      readAuthority, readDeletion, saveDeletion, get, put, read, remove, nowMs };
    return transaction(() => runCleanupDelete(scope));
  };
}

export interface RetentionDeps {
  readonly clock: ClockPort;
  readonly blobs: BlobStorePort;
  readonly files: FinalizedStorePort;
  readonly intents: IntentStorePort;
}

export interface RetentionConfig {
  readonly retainAttached?: true;
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

/**
 * Expire one composed intent past its deadline (mark expired, drop
 * identifying transfer state, remove staging and unpublished final
 * bytes) or finish staging cleanup for settled intents. Hosts with
 * conditional-commit stores apply this per record inside their own
 * transaction rather than through the whole-store batch entry.
 */
export function sweepIntent(
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
  if (retentionElapsed && !(config.retainAttached === true && stored.state === 'attached' &&
      typeof stored.attachedAtMs === 'number' && Number.isSafeInteger(stored.attachedAtMs) &&
      stored.attachedAtMs >= stored.finalizedAtMs && stored.attachedAtMs <= nowMs &&
      stored.attachedAtMs - stored.finalizedAtMs < config.unattachedHorizonMs)) {
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
