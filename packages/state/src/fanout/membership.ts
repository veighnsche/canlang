/**
 * T34-F5 authoritative membership: freeze the complete sorted canonical
 * identity set at an explicit source-occurrence/handler cutoff in the
 * OWNING store, for both cohort spellings.
 *
 * Mechanism (Q4: retained frozen identity set): bounded id-sorted
 * enumeration pages under one fence revision, committed with the intent
 * + checkpoint rows in a single owner transaction fenced at the
 * enumeration revision. Any concurrent write between the first page and
 * the commit moves the revision and voids the commit (fence conflict →
 * bounded retry from scratch); only a revision-stable enumeration
 * freezes. Late inserts land after the cutoff revision and are excluded
 * from the occurrence structurally — membership is the frozen intent
 * set, never a live directory read.
 *
 * Admission shape: the intent + checkpoint rows commit first (fenced at
 * the enumeration revision); admitted child rows materialize in bounded
 * chunks; the final chunk nulls the enumeration cursor. A crash between
 * chunks leaves a non-null cursor with missing rows, which re-freezing
 * (same cutoff+cohort) resumes idempotently: the retained intent is loaded
 * before live enumeration, its frozen set replays, missing rows admit, and the cursor
 * nulls only when fully admitted. Re-freezing NEVER re-enumerates.
 *
 * Failure posture: every failure here is a capability/admission failure
 * (`FanoutCohortDiagnosis`), never partial enumeration. Unknown anchors,
 * unknown models, infra failures, and exhausted fence contention all
 * diagnose; nothing freezes half a set.
 */

import type {
  CommitBatch,
  ModelName,
  RecordId,
  Revision,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import type {
  FanoutCohortDiagnosis,
  FanoutCohortKind,
  FanoutId,
} from '@canlang/contracts';
import { StateError } from '../errors.js';
import { FenceConflictError, StorageConstraintError } from '../storage/port.js';
import { stageFanoutMembership } from '../effects/staging.js';
import {
  FANOUT_CHECKPOINT_MODEL,
  FANOUT_CHILD_MODEL,
  FANOUT_INTENT_MODEL,
  fanoutChildRowId,
  fanoutIntentRowId,
  newFanoutCheckpointRow,
  newFanoutChildRow,
  newFanoutIntentRow,
  readFanoutCheckpointRow,
  readFanoutChildRow,
  readFanoutIntentRow,
  withFanoutRowData,
  type FanoutCheckpointData,
  type FanoutChildData,
  type FanoutIntentData,
  type FanoutRowMeta,
} from './tables.js';
import {
  checkCohortSpec,
  checkCutoffSpec,
  diagnoseCohort,
  type FanoutCohortSpec,
  type FanoutCutoffSpec,
} from './cohort.js';

/** Selected private consumer profile; persisted formats and public codecs stay unchanged. */
export const PRIVATE_FANOUT_LIMITS = Object.freeze({
  members: 1000, page: 100, identity: 200, compound: 6000,
});

function privateFanoutLimit(message: string): never {
  throw new StateError('limit', message, null, { retryable: false });
}

export function checkPrivateFanoutIdentity(value: unknown, compound = false): string {
  if (typeof value !== 'string' || value === '') {
    throw new StateError('validation', 'Fanout identity must be a non-empty string.');
  }
  if (value.length > (compound ? PRIVATE_FANOUT_LIMITS.compound : PRIVATE_FANOUT_LIMITS.identity)) {
    privateFanoutLimit('Fanout identity exceeds the private identity bound.');
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new StateError('validation', 'Fanout identity contains a control character.');
  }
  try { encodeURIComponent(value); } catch {
    throw new StateError('validation', 'Fanout identity has invalid URI encoding.');
  }
  return value;
}

export function checkPrivateFanoutIdOrder(value: unknown): 'utf16' | 'utf8-binary' {
  if (value !== 'utf16' && value !== 'utf8-binary') {
    throw new StateError('validation', 'Fanout storage must declare its original cohort id order.');
  }
  return value;
}

/** SQLite BINARY compares well-formed Unicode by code point; Memory uses UTF16. */
export function comparePrivateFanoutIds(a: string, b: string, order: 'utf16' | 'utf8-binary'): number {
  if (order === 'utf16') return a < b ? -1 : a > b ? 1 : 0;
  let left = 0, right = 0;
  while (left < a.length && right < b.length) {
    const x = a.codePointAt(left)!;
    const y = b.codePointAt(right)!;
    if (x !== y) return x < y ? -1 : 1;
    left += x > 0xffff ? 2 : 1;
    right += y > 0xffff ? 2 : 1;
  }
  return left < a.length ? 1 : right < b.length ? -1 : 0;
}

/** Inspect consumed fields without invoking a captured row's accessors. */
function ownField(record: unknown, field: string): unknown {
  if (typeof record !== 'object' || record === null || Array.isArray(record) ||
      (Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null)) {
    throw new StateError('validation', 'Fanout retained data must be an own-data object.');
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw new StateError('validation', 'Fanout retained field must be an enumerable own-data value.');
  }
  return descriptor.value;
}

/** Bound before the existing codec allocates its canonical Set and sorted copy. */
function checkPrivateIdentityArray(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new StateError('validation', 'Fanout retained identities must be an array.');
  }
  if (value.length > PRIVATE_FANOUT_LIMITS.members) {
    privateFanoutLimit('Fanout retained membership exceeds the private member bound.');
  }
  if (Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertyDescriptor(value, Symbol.iterator) !== undefined) {
    throw new StateError('validation', 'Fanout retained identities require an ordinary dense array.');
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new StateError('validation', 'Fanout retained identities require own-data array entries.');
    }
    checkPrivateFanoutIdentity(descriptor.value);
  }
}

export function readPrivateFanoutIntentRow(row: StoredRow): FanoutIntentData {
  checkPrivateFanoutIdentity(ownField(row, 'id'), true);
  const data = ownField(row, 'data');
  checkPrivateFanoutIdentity(ownField(data, 'fanoutId'), true);
  checkPrivateFanoutIdentity(ownField(data, 'sourceOccurrence'));
  checkPrivateFanoutIdentity(ownField(data, 'handler'));
  const cohort = ownField(data, 'cohort');
  if (cohort !== 'model' && cohort !== 'anchored-collection') {
    throw new StateError('validation', 'Fanout retained cohort must use an adopted spelling.');
  }
  ownField(data, 'memberCount');
  checkPrivateIdentityArray(ownField(data, 'members'));
  return readFanoutIntentRow(row);
}

export function readPrivateFanoutCheckpointRow(row: StoredRow): FanoutCheckpointData {
  checkPrivateFanoutIdentity(ownField(row, 'id'), true);
  const data = ownField(row, 'data');
  checkPrivateFanoutIdentity(ownField(data, 'fanoutId'), true);
  checkPrivateIdentityArray(ownField(data, 'completed'));
  const cursor = ownField(data, 'cursor');
  if (cursor !== null) checkPrivateFanoutIdentity(cursor, true);
  return readFanoutCheckpointRow(row);
}

export function readPrivateFanoutChildRow(row: StoredRow): FanoutChildData {
  checkPrivateFanoutIdentity(ownField(row, 'id'), true);
  const data = ownField(row, 'data');
  for (const field of ['fanoutId', 'childId']) checkPrivateFanoutIdentity(ownField(data, field), true);
  for (const field of ['parentOccurrence', 'handler', 'recordId']) checkPrivateFanoutIdentity(ownField(data, field));
  const state = ownField(data, 'state');
  const causeKind = ownField(data, 'causeKind');
  const causeReason = ownField(data, 'causeReason');
  if (!['pending', 'running', 'completed', 'skipped', 'failed'].includes(state as string) ||
      (causeKind !== null && !['completed', 'skipped', 'failed'].includes(causeKind as string)) ||
      (causeReason !== null && !['deleted', 'non-applicable', 'business-rejection', 'terminal', 'exhausted',
        'missing-record', 'inaccessible-record', 'infra-read-failure'].includes(causeReason as string))) {
    throw new StateError('validation', 'Fanout retained child state or cause is outside its closed contract.');
  }
  ownField(data, 'attempts');
  return readFanoutChildRow(row);
}

function checkCheckpointMembership(checkpoint: FanoutCheckpointData, intent: FanoutIntentData): void {
  const members = new Set(intent.members);
  if (checkpoint.fanoutId !== intent.fanoutId || checkpoint.completed.some(id => !members.has(id))) {
    throw new StateError('validation', 'Fanout checkpoint disagrees with the frozen membership.');
  }
}

interface RetainedIntentCapture {
  readonly version: StoredRow['version'];
  readonly data: FanoutIntentData;
}

function captureRetainedIntent(row: StoredRow): RetainedIntentCapture {
  const data = readPrivateFanoutIntentRow(row);
  liveAdmissionRow(row);
  return { version: row.version, data };
}

function sameRetainedIntent(row: StoredRow, data: FanoutIntentData, captured: RetainedIntentCapture): boolean {
  return row.version === captured.version && data.fanoutId === captured.data.fanoutId &&
    data.sourceOccurrence === captured.data.sourceOccurrence && data.handler === captured.data.handler &&
    data.cohort === captured.data.cohort && data.members.length === captured.data.members.length &&
    data.members.every((member, index) => member === captured.data.members[index]);
}

function changedRetainedIntent(): FreezeMembershipOutcome {
  return { ok: false, diagnosis: diagnoseCohort('membership-unavailable',
    'Fanout retained intent changed during admission; refusing to replace frozen membership.') };
}

/**
 * Explicit freeze bounds (no defaults, no quota field): page transport
 * bound, child-admission chunk bound, and freeze-attempt bound. Chunk
 * size is not cohort size (§C9): varying these never changes which
 * identities freeze.
 */
export interface FanoutFreezeBounds {
  readonly pageLimit: number;
  readonly chunkSize: number;
  readonly maxAttempts: number;
}

function checkBounds(bounds: FanoutFreezeBounds): FanoutFreezeBounds {
  if (typeof bounds !== 'object' || bounds === null || Array.isArray(bounds)) {
    throw new StateError('validation', 'Fanout freeze bounds must be an object.');
  }
  const captured = { pageLimit: ownField(bounds, 'pageLimit'),
    chunkSize: ownField(bounds, 'chunkSize'), maxAttempts: ownField(bounds, 'maxAttempts') };
  for (const field of ['pageLimit', 'chunkSize', 'maxAttempts'] as const) {
    const value = captured[field];
    if (typeof value !== 'number') {
      throw new StateError('validation', `Fanout freeze ${field} must be an integer >= 1.`);
    }
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new StateError('validation', `Fanout freeze ${field} must be an integer >= 1.`);
    }
    if (field !== 'maxAttempts' && value > PRIVATE_FANOUT_LIMITS.page) {
      privateFanoutLimit('Fanout freeze page or chunk exceeds the private page bound.');
    }
  }
  return captured as FanoutFreezeBounds;
}

/** One membership freeze request against the owning store. */
export interface FreezeMembershipInput {
  readonly store: StoragePort;
  readonly cutoff: FanoutCutoffSpec;
  readonly cohort: FanoutCohortSpec;
  /** Operating owner (the checkpoint owner); specs naming another owner diagnose. */
  readonly owner: string;
  readonly bounds: FanoutFreezeBounds;
  readonly meta: FanoutRowMeta;
  /**
   * Known-model guard (injected by the caller; production wires the
   * model table, tests wire a test set). When present and the cohort
   * model is unknown, the freeze diagnoses `unsupported-cohort` instead
   * of silently freezing an empty set over a mis-specified model. When
   * absent the guard is skipped (documented at the call site).
   */
  readonly hasModel?: (model: string) => boolean;
}

/** Native source staging captures the same complete identities before its owning commit. */
export interface CapturePrivateFanoutIdentitiesInput {
  readonly store: StoragePort;
  readonly cohort: FanoutCohortSpec;
  readonly pageLimit: number;
  readonly expectedRevision: Revision;
}

function capturePrivateCohortSpec(spec: FanoutCohortSpec): FanoutCohortSpec {
  const kind = ownField(spec, 'kind');
  const owner = checkPrivateFanoutIdentity(ownField(spec, 'owner'));
  const model = checkPrivateFanoutIdentity(ownField(spec, 'model'));
  if (kind === 'model') return { kind, owner, model };
  if (kind === 'anchored-collection') {
    const parent = ownField(spec, 'parent');
    return { kind, owner, model, parent: {
      model: checkPrivateFanoutIdentity(ownField(parent, 'model')),
      id: checkPrivateFanoutIdentity(ownField(parent, 'id')),
    } };
  }
  throw new StateError('validation', 'Fanout cohort must use an adopted spelling.');
}

/** No commit/anchor authority: callers retain their original source fence and final canonical sort. */
export async function capturePrivateFanoutIdentities(
  input: CapturePrivateFanoutIdentitiesInput,
): Promise<ReadonlyArray<string>> {
  const cohort = capturePrivateCohortSpec(input.cohort);
  const pageLimit = ownField(input, 'pageLimit');
  if (typeof pageLimit !== 'number' || !Number.isSafeInteger(pageLimit) || pageLimit < 1) {
    throw new StateError('validation', 'Fanout identity pageLimit must be an integer >= 1.');
  }
  if (pageLimit > PRIVATE_FANOUT_LIMITS.page) privateFanoutLimit('Fanout identity page exceeds the private page bound.');
  return drainCohortIdentities(input.store, cohort, pageLimit, input.expectedRevision);
}

/** Frozen membership: the committed intent identity plus its frozen set. */
export interface FrozenMembership {
  readonly fanoutId: FanoutId;
  /** Frozen canonical admitted record identities (sorted canonical order). */
  readonly members: ReadonlyArray<string>;
  /**
   * Fence revision the freeze committed under (fresh freeze), or the
   * revision at which the existing intent was observed (replay).
   */
  readonly cutoffRevision: Revision;
  /** True when an existing intent replayed instead of a fresh freeze. */
  readonly replayed: boolean;
}

export type FreezeMembershipOutcome =
  | { readonly ok: true; readonly frozen: FrozenMembership }
  | { readonly ok: false; readonly diagnosis: FanoutCohortDiagnosis };

/** One captured retained admission slice in the already resolved owning store. */
export interface AdmitRetainedFanoutChunkInput {
  readonly store: StoragePort;
  readonly intentRow: StoredRow;
  readonly checkpointRow: StoredRow;
  readonly chunkSize: number;
  readonly expectedRevision: Revision;
  readonly meta: FanoutRowMeta;
}

export type AdmitRetainedFanoutChunkOutcome =
  | { readonly ok: true; readonly cursor: string | null; readonly admitted: number }
  | { readonly ok: false; readonly diagnosis: FanoutCohortDiagnosis };

/**
 * v2 measures the verified immutable member prefix, independent of chunk size.
 * Legacy admit/N omitted its original chunk size: verify again from zero,
 * reusing existing children. Other opaque cursors cannot establish this prefix.
 * Existing full replay treats both versions as non-null and may still finish.
 */
function retainedAdmissionOffset(cursor: string, memberCount: number): number {
  const current = /^admit\/v2\/(0|[1-9]\d*)$/.exec(cursor);
  const legacy = /^admit\/([1-9]\d*)$/.exec(cursor);
  const encoded = current?.[1] ?? legacy?.[1];
  if (encoded === undefined || !Number.isSafeInteger(Number(encoded))) {
    throw new StateError('validation', 'Fanout retained admission cursor is unknown or malformed.');
  }
  const offset = current === null ? 0 : Number(encoded);
  // A legacy index cannot exceed member count even at the smallest old bound.
  if (offset > memberCount || (current === null && Number(encoded) > memberCount)) {
    throw new StateError('validation', 'Fanout retained admission cursor exceeds frozen membership.');
  }
  return offset;
}

function liveAdmissionRow(row: StoredRow): void {
  if (!Number.isSafeInteger(row.version) || row.version < 1 || row.archivedAt !== null ||
    (row.parent ?? null) !== null) {
    throw new StateError('validation', 'Fanout retained admission requires a live unparented versioned row.');
  }
}

/**
 * Verify/materialize exactly one bounded retained slice; never query or drain.
 * The caller first resolves actual installed ownership/source authority, then
 * captures these rows and revision in that same owner invocation fence. Neither
 * caller row text nor frozen membership grants authority. The retained intent
 * is immutable; replacement invalidates the verified-prefix contract.
 *
 * Only deterministic child point loads (at most chunkSize) are performed beyond
 * the two actual row loads. Inserts and cursor advancement share one existing
 * revision/version-fenced transaction, preserving terminal completed coverage.
 * A conflict returns for a later slice; this call never retries another chunk.
 */
function checkRetainedChunkSize(input: AdmitRetainedFanoutChunkInput): number {
  const chunkSize = ownField(input, 'chunkSize');
  if (typeof chunkSize !== 'number' || !Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new StateError('validation', 'Fanout retained admission chunkSize must be an integer >= 1.');
  }
  if (chunkSize > PRIVATE_FANOUT_LIMITS.page) {
    privateFanoutLimit('Fanout retained admission chunk exceeds the private page bound.');
  }
  return chunkSize;
}

interface RetainedCapturePair {
  readonly intent: FanoutIntentData;
  readonly checkpoint: FanoutCheckpointData;
}

function verifyRetainedCapturePair(intentRow: StoredRow, checkpointRow: StoredRow): RetainedCapturePair {
  const intent = readPrivateFanoutIntentRow(intentRow);
  const checkpoint = readPrivateFanoutCheckpointRow(checkpointRow);
  checkCheckpointMembership(checkpoint, intent);
  liveAdmissionRow(intentRow);
  liveAdmissionRow(checkpointRow);
  return { intent, checkpoint };
}

interface LiveRetainedRows extends RetainedCapturePair {
  readonly intentRow: StoredRow;
  readonly checkpointRow: StoredRow;
}

function checkStaleRetainedCapture(
  intentRow: StoredRow,
  checkpointRow: StoredRow,
  live: RetainedCapturePair,
  captured: RetainedCapturePair,
  capturedIntentRow: StoredRow,
  capturedCheckpointRow: StoredRow,
): boolean {
  const { intent, checkpoint } = live;
  return intentRow.version !== capturedIntentRow.version ||
    checkpointRow.version !== capturedCheckpointRow.version ||
    intent.fanoutId !== captured.intent.fanoutId ||
    intent.sourceOccurrence !== captured.intent.sourceOccurrence ||
    intent.handler !== captured.intent.handler || intent.cohort !== captured.intent.cohort ||
    intent.members.length !== captured.intent.members.length ||
    intent.members.some((member, index) => member !== captured.intent.members[index]) ||
    checkpoint.fanoutId !== intent.fanoutId || checkpoint.cursor !== captured.checkpoint.cursor;
}

function decodeRetainedOffset(
  checkpoint: FanoutCheckpointData,
  memberCount: number,
): { readonly offset: number } | { readonly message: string } {
  try {
    return { offset: retainedAdmissionOffset(checkpoint.cursor as string, memberCount) };
  } catch (error) {
    if (!(error instanceof StateError)) throw error;
    return { message: error.message };
  }
}

async function collectMissingChildRows(
  store: StoragePort,
  intent: FanoutIntentData,
  chunk: ReadonlyArray<string>,
  expectedRevision: Revision,
  meta: FanoutRowMeta,
): Promise<{ readonly missing: StoredRow[] } | { readonly message: string }> {
  const missing: StoredRow[] = [];
  for (const recordId of chunk) {
    const childRow = await store.cohortLoad({ model: FANOUT_CHILD_MODEL as ModelName,
      id: fanoutChildRowId(intent.sourceOccurrence, intent.handler, recordId) as RecordId,
      expectedRevision });
    if (childRow === null) {
      missing.push(newFanoutChildRow({ fanoutId: intent.fanoutId,
        parentOccurrence: intent.sourceOccurrence, handler: intent.handler, recordId }, meta));
    } else {
      liveAdmissionRow(childRow);
      const child = readPrivateFanoutChildRow(childRow);
      if (child.fanoutId !== intent.fanoutId || child.parentOccurrence !== intent.sourceOccurrence ||
        child.handler !== intent.handler || child.recordId !== recordId) {
        return { message: 'Fanout retained admission child disagrees with frozen membership.' };
      }
    }
  }
  return { missing };
}

function commitRetainedChunkSlice(
  store: StoragePort,
  expectedRevision: Revision,
  missing: ReadonlyArray<StoredRow>,
  checkpointRow: StoredRow,
  checkpoint: FanoutCheckpointData,
  cursor: string | null,
  meta: FanoutRowMeta,
): Promise<Revision> {
  return commitBatch(store, {
    expectedRevision,
    writes: [
      ...missing.map(row => ({ kind: 'insert' as const, model: FANOUT_CHILD_MODEL as ModelName, row })),
      { kind: 'update', model: FANOUT_CHECKPOINT_MODEL as ModelName, id: checkpointRow.id,
        expectedVersion: checkpointRow.version,
        row: withFanoutRowData(checkpointRow, { ...checkpoint, cursor }, meta) },
    ],
    history: [], receipt: null, outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [],
  });
}

async function loadLiveRetainedRows(
  store: StoragePort,
  intentRowId: StoredRow['id'],
  checkpointRowId: StoredRow['id'],
  expectedRevision: Revision,
): Promise<LiveRetainedRows | null> {
  const intentRow = await store.cohortLoad({ model: FANOUT_INTENT_MODEL as ModelName,
    id: intentRowId, expectedRevision });
  const checkpointRow = await store.cohortLoad({ model: FANOUT_CHECKPOINT_MODEL as ModelName,
    id: checkpointRowId, expectedRevision });
  if (intentRow === null || checkpointRow === null) return null;
  liveAdmissionRow(intentRow);
  liveAdmissionRow(checkpointRow);
  const intent = readPrivateFanoutIntentRow(intentRow);
  const checkpoint = readPrivateFanoutCheckpointRow(checkpointRow);
  checkCheckpointMembership(checkpoint, intent);
  return { intentRow, checkpointRow, intent, checkpoint };
}

export async function admitRetainedFanoutChunk(
  input: AdmitRetainedFanoutChunkInput,
): Promise<AdmitRetainedFanoutChunkOutcome> {
  const chunkSize = checkRetainedChunkSize(input);
  const captured = verifyRetainedCapturePair(input.intentRow, input.checkpointRow);
  const unavailable = (message: string): AdmitRetainedFanoutChunkOutcome => ({
    ok: false, diagnosis: diagnoseCohort('membership-unavailable', message),
  });
  if (captured.checkpoint.fanoutId !== captured.intent.fanoutId) {
    return unavailable('Fanout captured checkpoint disagrees with the retained intent.');
  }
  try {
    const live = await loadLiveRetainedRows(input.store, input.intentRow.id,
      input.checkpointRow.id, input.expectedRevision);
    if (live === null) {
      return unavailable('Fanout retained intent or checkpoint is missing during admission.');
    }
    if (checkStaleRetainedCapture(live.intentRow, live.checkpointRow,
      { intent: live.intent, checkpoint: live.checkpoint }, captured, input.intentRow, input.checkpointRow)) {
      return unavailable('Fanout retained admission capture is stale or disagrees with actual owner rows.');
    }
    const { intent, checkpoint } = live;
    if (checkpoint.cursor === null) return { ok: true, cursor: null, admitted: 0 };
    const decoded = decodeRetainedOffset(checkpoint, intent.members.length);
    if ('message' in decoded) return unavailable(decoded.message);
    const chunk = intent.members.slice(decoded.offset, decoded.offset + chunkSize);
    const collected = await collectMissingChildRows(input.store, intent, chunk,
      input.expectedRevision, input.meta);
    if ('message' in collected) return unavailable(collected.message);
    const end = decoded.offset + chunk.length;
    const cursor = end === intent.members.length ? null : `admit/v2/${end}`;
    await commitRetainedChunkSlice(input.store, input.expectedRevision, collected.missing,
      live.checkpointRow, checkpoint, cursor, input.meta);
    return { ok: true, cursor, admitted: collected.missing.length };
  } catch (error) {
    if (error instanceof StateError) throw error;
    return unavailable(`Fanout retained admission failed: ${error instanceof Error ? error.message : String(error)}.`);
  }
}

/** Opaque enumeration cursor while admission chunks remain. */
function admitCursor(nextChunkIndex: number): string {
  return `admit/${nextChunkIndex}`;
}

interface AnchorVerdict {
  /** The anchor demonstrably exists, existed, or is archived — freeze proceeds. */
  readonly known: boolean;
}

/**
 * Classify the anchored-collection anchor within the fenced window.
 * Present (even archived — archive is not delete) or tombstoned
 * (history records its disposal) anchors are KNOWN: the enumerated set
 * — possibly empty — is exact. A missing anchor with no disposal
 * history is UNKNOWN: freezing empty would bless a mis-specified cohort
 * as a complete sweep, so the freeze diagnoses instead. Infra failures
 * propagate to the unavailable diagnosis.
 */
async function classifyAnchor(
  store: StoragePort,
  parent: { readonly model: string; readonly id: string },
  expectedRevision: Revision,
): Promise<AnchorVerdict> {
  const fact = await store.cohortAnchorFact({ model: parent.model as ModelName,
    id: parent.id as RecordId, expectedRevision });
  if (fact !== 'present' && fact !== 'disposed' && fact !== 'unknown') {
    throw new StateError('validation', 'Fanout anchor returned an unknown existence fact.');
  }
  return { known: fact !== 'unknown' };
}

/**
 * Drain one cohort's member identities in bounded id-sorted pages.
 * Whole-model cohorts scan the model; anchored-collection cohorts scope
 * to the pinned parent's linkage. Archived rows INCLUDE: they freeze as
 * members and record skipped/deleted when their child executes, so every
 * stored identity gets one accounted outcome.
 */
async function drainCohortIdentities(
  store: StoragePort,
  cohort: FanoutCohortSpec,
  pageLimit: number,
  expectedRevision: Revision,
): Promise<string[]> {
  const order = checkPrivateFanoutIdOrder(store.cohortIdOrder);
  const members: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const limit = members.length === PRIVATE_FANOUT_LIMITS.members ? 1
      : Math.min(pageLimit, PRIVATE_FANOUT_LIMITS.members - members.length);
    const ids = await store.cohortIdentityPage({
      model: cohort.model as ModelName,
      ...(cohort.kind === 'anchored-collection'
        ? {
            parent: {
              model: cohort.parent.model as ModelName,
              id: cohort.parent.id as RecordId,
            },
          }
        : {}),
      after: cursor as RecordId | null,
      limit,
      expectedRevision,
    });
    if (ids.length > limit) {
      throw new StateError(
        'validation',
        `Fanout enumeration returned ${ids.length} identities past limit ${limit}.`,
      );
    }
    for (const rawId of ids) {
      if (members.length === PRIVATE_FANOUT_LIMITS.members) {
        privateFanoutLimit('Fanout membership exceeds the private member bound.');
      }
      const id = checkPrivateFanoutIdentity(rawId);
      if (cursor !== null && comparePrivateFanoutIds(id, cursor, order) <= 0) {
        throw new StateError('validation', 'Fanout membership pages must advance in ascending id order.');
      }
      members.push(id);
      cursor = id;
    }
    if (ids.length < limit) {
      return members;
    }
  }
}

/** Drain admitted child record ids for one fanout in bounded pages. */
async function drainAdmittedRecordIds(
  store: StoragePort,
  intent: FanoutIntentData,
  pageLimit: number,
  expectedRevision: Revision,
): Promise<Set<string>> {
  const order = checkPrivateFanoutIdOrder(store.cohortIdOrder);
  const admitted = new Set<string>();
  const members = new Set(intent.members);
  const fanoutId = intent.fanoutId;
  let cursor: string | null = null;
  let observed = 0;
  for (;;) {
    const limit = observed === PRIVATE_FANOUT_LIMITS.members ? 1
      : Math.min(pageLimit, PRIVATE_FANOUT_LIMITS.members - observed);
    const rows = await store.cohortRowPage({
      model: FANOUT_CHILD_MODEL as ModelName,
      fanoutId,
      after: cursor as RecordId | null,
      limit,
      expectedRevision,
    });
    if (rows.length > limit) {
      throw new StateError(
        'validation',
        `Fanout child drain returned ${rows.length} rows past limit ${limit}.`,
      );
    }
    for (const row of rows) {
      if (observed === PRIVATE_FANOUT_LIMITS.members) {
        privateFanoutLimit('Fanout admission exceeds the private child row bound.');
      }
      observed += 1;
      const id = checkPrivateFanoutIdentity(ownField(row, 'id'), true);
      if (cursor !== null && comparePrivateFanoutIds(id, cursor, order) <= 0) {
        throw new StateError('validation', 'Fanout admission child pages must advance in ascending id order.');
      }
      cursor = id;
      const child = readPrivateFanoutChildRow(row);
      if (child.fanoutId !== fanoutId || child.parentOccurrence !== intent.sourceOccurrence ||
          child.handler !== intent.handler || !members.has(child.recordId) || admitted.has(child.recordId)) {
        throw new StateError('validation', 'Fanout admitted child disagrees with the frozen membership.');
      }
      admitted.add(child.recordId);
    }
    if (rows.length < limit) {
      return admitted;
    }
  }
}

function chunkOf<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function commitBatch(store: StoragePort, batch: CommitBatch): Promise<Revision> {
  return (await store.commit(batch)).revision;
}

/**
 * Freeze one cohort's membership. See the module header for the
 * mechanism, resume, and failure posture.
 *
 * Freeze commits flow through the PLAIN store port (inserts + cursor
 * maintenance carry no terminal outcomes); outcome-bearing child units
 * commit through the linkage-asserted child-join port instead.
 */
interface NormalizedFreezeRequest {
  readonly input: FreezeMembershipInput;
  readonly cohortKind: FanoutCohortKind;
  readonly fanoutId: FanoutId;
}

function normalizeFreezeRequest(input: FreezeMembershipInput): NormalizedFreezeRequest {
  const cutoff: FanoutCutoffSpec = {
    sourceOccurrence: checkPrivateFanoutIdentity(ownField(input.cutoff, 'sourceOccurrence')),
    handler: checkPrivateFanoutIdentity(ownField(input.cutoff, 'handler')),
  };
  const owner = checkPrivateFanoutIdentity(input.owner);
  const cohort = capturePrivateCohortSpec(input.cohort);
  checkCutoffSpec(cutoff);
  const cohortKind = checkCohortSpec(cohort);
  const bounds = checkBounds(input.bounds);
  const normalized: FreezeMembershipInput = { store: input.store, cutoff, cohort, owner, bounds,
    meta: input.meta,
    ...(input.hasModel === undefined ? {} : { hasModel: input.hasModel }) };
  const fanoutId = fanoutIntentRowId(
    normalized.cutoff.sourceOccurrence,
    normalized.cutoff.handler,
    cohortKind,
  );
  checkPrivateFanoutIdentity(fanoutId, true);
  return { input: normalized, cohortKind, fanoutId };
}

function refuseForeignFreeze(input: FreezeMembershipInput): FreezeMembershipOutcome | null {
  if (input.cohort.owner !== input.owner) {
    return {
      ok: false,
      diagnosis: diagnoseCohort(
        'cross-owner-cohort',
        `Fanout cohort owner ${JSON.stringify(input.cohort.owner)} is outside operating owner ` +
          `${JSON.stringify(input.owner)}; the child transaction cannot cross owners.`,
      ),
    };
  }
  if (input.hasModel !== undefined && !input.hasModel(input.cohort.model)) {
    return {
      ok: false,
      diagnosis: diagnoseCohort(
        'unsupported-cohort',
        `Fanout cohort model ${JSON.stringify(input.cohort.model)} is not a servable model.`,
      ),
    };
  }
  return null;
}

type FreezeStep<T> =
  | { readonly retry: true }
  | { readonly outcome: FreezeMembershipOutcome }
  | { readonly value: T };

interface FreezeHead {
  readonly revision: Revision;
  readonly retainedIntent: StoredRow | null;
}

async function readFreezeHead(
  input: FreezeMembershipInput,
  fanoutId: FanoutId,
): Promise<FreezeStep<FreezeHead>> {
  try {
    const revision = await input.store.readRevision();
    const retainedIntent = await input.store.cohortLoad({ model: FANOUT_INTENT_MODEL as ModelName,
      id: fanoutId as RecordId, expectedRevision: revision });
    return { value: { revision, retainedIntent } };
  } catch (error) {
    if (error instanceof FenceConflictError) return { retry: true };
    if (error instanceof StateError) throw error;
    return {
      outcome: {
        ok: false,
        diagnosis: diagnoseCohort(
          'membership-unavailable',
          `Fanout retained intent lookup failed: ${error instanceof Error ? error.message : String(error)}.`,
        ),
      },
    };
  }
}

async function enumerateFreezeMembers(
  input: FreezeMembershipInput,
  revision: Revision,
): Promise<FreezeStep<string[]>> {
  try {
    const enumerated = await drainCohortIdentities(input.store, input.cohort, input.bounds.pageLimit, revision);
    if (input.cohort.kind === 'anchored-collection') {
      const anchor = await classifyAnchor(input.store, input.cohort.parent, revision);
      if (!anchor.known) {
        return {
          outcome: {
            ok: false,
            diagnosis: diagnoseCohort(
              'membership-unavailable',
              `Fanout anchor ${JSON.stringify(input.cohort.parent.model)}/` +
                `${JSON.stringify(input.cohort.parent.id)} is unknown; refusing to freeze ` +
                'an empty sweep over an unknowable collection.',
            ),
          },
        };
      }
    }
    return { value: enumerated };
  } catch (error) {
    if (error instanceof FenceConflictError) return { retry: true };
    if (error instanceof StateError) throw error;
    return {
      outcome: {
        ok: false,
        diagnosis: diagnoseCohort(
          'membership-unavailable',
          `Fanout enumeration failed: ${error instanceof Error ? error.message : String(error)}.`,
        ),
      },
    };
  }
}

function stageFreezeMembers(enumerated: string[]):
  | { readonly value: ReadonlyArray<string> }
  | { readonly outcome: FreezeMembershipOutcome } {
  try {
    return { value: stageFanoutMembership(enumerated, 'work.fanout_intent.members') };
  } catch (error) {
    // Duplicates under a stable revision are store disagreement —
    // an unavailable producer, never a half set.
    return {
      outcome: {
        ok: false,
        diagnosis: diagnoseCohort(
          'membership-unavailable',
          `Fanout enumeration disagrees with the store: ${error instanceof Error ? error.message : String(error)}.`,
        ),
      },
    };
  }
}

interface FreshFreezeCommit {
  readonly admissionRevision: Revision;
  readonly captured: RetainedIntentCapture;
}

async function commitFreshFreeze(
  input: FreezeMembershipInput,
  fanoutId: FanoutId,
  cohortKind: FanoutCohortKind,
  members: ReadonlyArray<string>,
  firstChunk: ReadonlyArray<string>,
  singleCommit: boolean,
  revision: Revision,
): Promise<FreezeStep<FreshFreezeCommit>> {
  const intentRow = newFanoutIntentRow(
    {
      sourceOccurrence: input.cutoff.sourceOccurrence,
      handler: input.cutoff.handler,
      cohort: cohortKind,
      members,
    },
    input.meta,
  );
  const checkpointRow = newFanoutCheckpointRow(
    {
      fanoutId,
      completed: [],
      cursor: singleCommit ? null : admitCursor(1),
    },
    input.meta,
  );
  const captured = captureRetainedIntent(intentRow);
  try {
    const admissionRevision = await commitBatch(input.store, {
      expectedRevision: revision,
      writes: [
        { kind: 'insert', model: FANOUT_INTENT_MODEL as ModelName, row: intentRow },
        { kind: 'insert', model: FANOUT_CHECKPOINT_MODEL as ModelName, row: checkpointRow },
        ...firstChunk.map((recordId) => ({
          kind: 'insert' as const,
          model: FANOUT_CHILD_MODEL as ModelName,
          row: newFanoutChildRow(
            {
              fanoutId,
              parentOccurrence: captured.data.sourceOccurrence,
              handler: captured.data.handler,
              recordId,
            },
            input.meta,
          ),
        })),
      ],
      history: [],
      receipt: null,
      outbox: [],
      schedules: [],
      uniqueClaims: [],
      uniqueReleases: [],
    });
    return { value: { admissionRevision, captured } };
  } catch (error) {
    if (error instanceof FenceConflictError) return { retry: true };
    if (error instanceof StorageConstraintError) return { outcome: await replayFreeze(input, fanoutId) };
    if (error instanceof StateError) throw error;
    return {
      outcome: {
        ok: false,
        diagnosis: diagnoseCohort(
          'membership-unavailable',
          `Fanout intent commit failed: ${error instanceof Error ? error.message : String(error)}.`,
        ),
      },
    };
  }
}

// Intent + checkpoint + first chunk are durable. Admit the
// remaining chunks; each chunk commit is atomic, and a crash
// between chunks resumes via re-freezing (replay path below).
async function admitFreshTail(
  input: FreezeMembershipInput,
  captured: RetainedIntentCapture,
  chunks: ReadonlyArray<ReadonlyArray<string>>,
  admissionRevision: Revision,
): Promise<{ readonly revision: Revision } | { readonly failed: FreezeMembershipOutcome }> {
  for (let index = 1; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk === undefined) {
      continue;
    }
    const last = index === chunks.length - 1;
    const admitted = await admitChunk(input, captured, chunk, last, admissionRevision);
    if (!admitted.ok) {
      return { failed: admitted };
    }
    admissionRevision = admitted.frozen.cutoffRevision;
  }
  return { revision: admissionRevision };
}

export async function freezeFanoutMembership(
  input: FreezeMembershipInput,
): Promise<FreezeMembershipOutcome> {
  const normalized = normalizeFreezeRequest(input);
  input = normalized.input;
  const { cohortKind, fanoutId } = normalized;
  const refusal = refuseForeignFreeze(input);
  if (refusal !== null) return refusal;

  for (let attempt = 1; attempt <= input.bounds.maxAttempts; attempt += 1) {
    const head = await readFreezeHead(input, fanoutId);
    if ('retry' in head) continue;
    if ('outcome' in head) return head.outcome;
    const { revision, retainedIntent } = head.value;
    if (retainedIntent !== null) {
      return replayFreeze(input, fanoutId, captureRetainedIntent(retainedIntent));
    }
    const drained = await enumerateFreezeMembers(input, revision);
    if ('retry' in drained) continue;
    if ('outcome' in drained) return drained.outcome;
    const staged = stageFreezeMembers(drained.value);
    if ('outcome' in staged) return staged.outcome;
    const members = staged.value;
    const chunks = chunkOf(members, input.bounds.chunkSize);
    const firstChunk = chunks[0] ?? [];
    const singleCommit = chunks.length <= 1;
    const committed = await commitFreshFreeze(input, fanoutId, cohortKind, members,
      firstChunk, singleCommit, revision);
    if ('retry' in committed) continue;
    if ('outcome' in committed) return committed.outcome;
    const tail = await admitFreshTail(input, committed.value.captured, chunks,
      committed.value.admissionRevision);
    if ('failed' in tail) return tail.failed;
    return {
      ok: true,
      frozen: { fanoutId, members, cutoffRevision: revision, replayed: false },
    };
  }
  return {
    ok: false,
    diagnosis: diagnoseCohort(
      'membership-unavailable',
      `Fanout freeze lost the fence ${input.bounds.maxAttempts} time(s); ` +
        'concurrent writes never freeze a partial set.',
    ),
  };
}

/**
 * Carry the prior successful owner commit's fence into the next chunk.
 * External writes require a new coherent retained-intent/coverage read,
 * never a fresh revision that blesses stale membership. Constraint
 * collisions re-read the admitted set and insert only missing rows.
 * The final fresh chunk nulls the cursor atomically with its inserts.
 */
async function admitChunk(
  input: FreezeMembershipInput,
  captured: RetainedIntentCapture,
  chunk: ReadonlyArray<string>,
  last: boolean,
  expectedRevision: Revision,
): Promise<FreezeMembershipOutcome> {
  const { fanoutId, members } = captured.data;
  try {
    const currentIntent = await input.store.cohortLoad({ model: FANOUT_INTENT_MODEL as ModelName,
      id: fanoutId as RecordId, expectedRevision });
    if (currentIntent === null) return changedRetainedIntent();
    const current = captureRetainedIntent(currentIntent);
    if (!sameRetainedIntent(currentIntent, current.data, captured)) return changedRetainedIntent();
    const checkpointRow = last
      ? await input.store.cohortLoad({ model: FANOUT_CHECKPOINT_MODEL as ModelName,
        id: fanoutId as RecordId, expectedRevision })
      : null;
    const checkpointData = checkpointRow === null ? null : readPrivateFanoutCheckpointRow(checkpointRow);
    if (checkpointData !== null && checkpointData.fanoutId !== fanoutId) {
      throw new StateError('validation', 'Fanout admission loaded a different checkpoint.');
    }
    if (checkpointData !== null) {
      const frozen = new Set(members);
      if (checkpointData.completed.some(id => !frozen.has(id))) {
        throw new StateError('validation', 'Fanout checkpoint disagrees with the frozen membership.');
      }
    }
    const insertRows = (ids: ReadonlyArray<string>): StoredRow[] =>
      ids.map((recordId) =>
        newFanoutChildRow(
          {
            fanoutId,
            parentOccurrence: captured.data.sourceOccurrence,
            handler: captured.data.handler,
            recordId,
          },
          input.meta,
        ),
      );
    const checkpointUpdate =
      last && checkpointRow !== null && checkpointData !== null
        ? withFanoutRowData(
            checkpointRow,
            { ...checkpointData, cursor: null },
            input.meta,
          )
        : null;
    const committedRevision = await commitBatch(input.store, {
      expectedRevision,
      writes: [
        ...insertRows(chunk).map((row) => ({
          kind: 'insert' as const,
          model: FANOUT_CHILD_MODEL as ModelName,
          row,
        })),
        ...(checkpointUpdate !== null && checkpointRow !== null
          ? [
              {
                kind: 'update' as const,
                model: FANOUT_CHECKPOINT_MODEL as ModelName,
                id: fanoutId as RecordId,
                expectedVersion: checkpointRow.version,
                row: checkpointUpdate,
              },
            ]
          : []),
      ],
      history: [],
      receipt: null,
      outbox: [],
      schedules: [],
      uniqueClaims: [],
      uniqueReleases: [],
    });
    return {
      ok: true,
      frozen: {
        fanoutId,
        members: [],
        cutoffRevision: committedRevision,
        replayed: true,
      },
    };
  } catch (error) {
    if (error instanceof FenceConflictError) {
      // Chunk chunks are idempotent: re-read and insert only missing.
      return admitMissing(input, fanoutId, last, 1, captured);
    }
    if (error instanceof StorageConstraintError) {
      return admitMissing(input, fanoutId, last, 1, captured);
    }
    if (error instanceof StateError) {
      throw error;
    }
    return {
      ok: false,
      diagnosis: diagnoseCohort(
        'membership-unavailable',
        `Fanout admission failed: ${error instanceof Error ? error.message : String(error)}.`,
      ),
    };
  }
}

/**
 * Crash-retry admission: re-read the frozen intent (NEVER re-enumerate),
 * insert only the missing member rows in bounded chunks, and null the
 * cursor only when fully admitted.
 */
interface AdmissionState {
  readonly revision: Revision;
  readonly intent: FanoutIntentData;
  readonly admitted: Set<string>;
  readonly captured: RetainedIntentCapture;
}

type AdmissionStep<T> =
  | { readonly value: T }
  | { readonly outcome: FreezeMembershipOutcome }
  | { readonly retry: true; readonly captured?: RetainedIntentCapture };

function checkCutoffAgreement(
  input: FreezeMembershipInput,
  intent: FanoutIntentData,
  fanoutId: FanoutId,
): FreezeMembershipOutcome | null {
  if (
    intent.sourceOccurrence !== input.cutoff.sourceOccurrence ||
    intent.handler !== input.cutoff.handler || intent.fanoutId !== fanoutId ||
    intent.cohort !== input.cohort.kind
  ) {
    return {
      ok: false,
      diagnosis: diagnoseCohort(
        'membership-unavailable',
        'Fanout intent disagrees with the cutoff; refusing to invent membership.',
      ),
    };
  }
  return null;
}

async function readAdmissionState(
  input: FreezeMembershipInput,
  fanoutId: FanoutId,
  attempt: number,
  captured: RetainedIntentCapture | undefined,
): Promise<AdmissionStep<AdmissionState>> {
  // HEAD pins the fresh capture (`captured ??= current`) before the
  // checkpoint/coverage reads so a FenceConflictError retry reuses the
  // exact snapshot instead of re-accepting a changed retained intent.
  let resolved: RetainedIntentCapture | undefined;
  try {
    const revision = await input.store.readRevision();
    const intentRow = await input.store.cohortLoad({ model: FANOUT_INTENT_MODEL as ModelName,
      id: fanoutId as RecordId, expectedRevision: revision });
    if (intentRow === null) {
      return {
        outcome: {
          ok: false,
          diagnosis: diagnoseCohort(
            'membership-unavailable',
            'Fanout intent is missing during admission; refusing to invent membership.',
          ),
        },
      };
    }
    const current = captureRetainedIntent(intentRow);
    const intent = current.data;
    if (captured !== undefined && !sameRetainedIntent(intentRow, intent, captured)) {
      return { outcome: changedRetainedIntent() };
    }
    resolved = captured ?? current;
    const disagreement = checkCutoffAgreement(input, intent, fanoutId);
    if (disagreement !== null) return { outcome: disagreement };
    const checkpointRow = await input.store.cohortLoad({ model: FANOUT_CHECKPOINT_MODEL as ModelName,
      id: fanoutId as RecordId, expectedRevision: revision });
    if (checkpointRow === null) {
      return { outcome: { ok: false, diagnosis: diagnoseCohort('membership-unavailable',
        'Fanout checkpoint is missing during admission; refusing to invent completion.') } };
    }
    liveAdmissionRow(checkpointRow);
    checkCheckpointMembership(readPrivateFanoutCheckpointRow(checkpointRow), intent);
    const admitted = await drainAdmittedRecordIds(input.store, intent, input.bounds.pageLimit, revision);
    return { value: { revision, intent, admitted, captured: resolved } };
  } catch (error) {
    if (error instanceof FenceConflictError) {
      if (attempt >= input.bounds.maxAttempts) return { outcome: retryExhausted(input) };
      return resolved === undefined ? { retry: true } : { retry: true, captured: resolved };
    }
    if (error instanceof StateError) throw error;
    return { outcome: { ok: false, diagnosis: diagnoseCohort('membership-unavailable',
      `Fanout admission re-read failed: ${error instanceof Error ? error.message : String(error)}.`) } };
  }
}

async function commitMissingChunk(
  input: FreezeMembershipInput,
  intent: FanoutIntentData,
  fanoutId: FanoutId,
  chunk: ReadonlyArray<string>,
  revision: Revision,
  attempt: number,
): Promise<AdmissionStep<Revision>> {
  try {
    const committed = await commitBatch(input.store, {
      expectedRevision: revision,
      writes: chunk.map((recordId) => ({
        kind: 'insert' as const,
        model: FANOUT_CHILD_MODEL as ModelName,
        row: newFanoutChildRow(
          {
            fanoutId,
            parentOccurrence: intent.sourceOccurrence,
            handler: intent.handler,
            recordId,
          },
          input.meta,
        ),
      })),
      history: [],
      receipt: null,
      outbox: [],
      schedules: [],
      uniqueClaims: [],
      uniqueReleases: [],
    });
    return { value: committed };
  } catch (error) {
    if (error instanceof FenceConflictError || error instanceof StorageConstraintError) {
      // A rival admitter won the race; re-drain and continue.
      if (attempt >= input.bounds.maxAttempts) return { outcome: retryExhausted(input) };
      return { retry: true };
    }
    if (error instanceof StateError) {
      throw error;
    }
    return {
      outcome: {
        ok: false,
        diagnosis: diagnoseCohort(
          'membership-unavailable',
          `Fanout admission failed: ${error instanceof Error ? error.message : String(error)}.`,
        ),
      },
    };
  }
}

async function admitMissing(
  input: FreezeMembershipInput,
  fanoutId: FanoutId,
  finishCursor: boolean,
  attempt = 1,
  captured?: RetainedIntentCapture,
): Promise<FreezeMembershipOutcome> {
  const read = await readAdmissionState(input, fanoutId, attempt, captured);
  if ('retry' in read) return admitMissing(input, fanoutId, finishCursor, attempt + 1, read.captured ?? captured);
  if ('outcome' in read) return read.outcome;
  let revision = read.value.revision;
  const { intent, admitted } = read.value;
  captured = read.value.captured;
  const missing = intent.members.filter((recordId) => !admitted.has(recordId));
  for (const chunk of chunkOf(missing, input.bounds.chunkSize)) {
    const committed = await commitMissingChunk(input, intent, fanoutId, chunk, revision, attempt);
    if ('retry' in committed) return admitMissing(input, fanoutId, finishCursor, attempt + 1, captured);
    if ('outcome' in committed) return committed.outcome;
    revision = committed.value;
    for (const recordId of chunk) {
      admitted.add(recordId);
    }
  }
  if (finishCursor) {
    const finish = await finishEnumerationCursor(input, captured, admitted, revision, attempt);
    if (!finish.ok) {
      return finish;
    }
    revision = finish.frozen.cutoffRevision;
  }
  return {
    ok: true,
    frozen: { fanoutId, members: intent.members, cutoffRevision: revision, replayed: true },
  };
}

/**
 * Null the enumeration cursor only when every frozen member has a child
 * row (F4 `finishEnumeration` agreement: nothing to admit, no gaps —
 * gaps force false). A partial checkpoint never reads complete.
 */
async function finishEnumerationCursor(
  input: FreezeMembershipInput,
  captured: RetainedIntentCapture,
  admitted: ReadonlySet<string>,
  expectedRevision: Revision,
  attempt = 1,
): Promise<FreezeMembershipOutcome> {
  const intent = captured.data;
  const { fanoutId, members } = intent;
  for (const recordId of members) {
    if (!admitted.has(recordId)) {
      return {
        ok: false,
        diagnosis: diagnoseCohort(
          'membership-unavailable',
          'Fanout admission is incomplete; the cursor stays non-null (resume, never complete).',
        ),
      };
    }
  }
  let committedRevision: Revision;
  try {
    const checkpointRow = await input.store.cohortLoad({ model: FANOUT_CHECKPOINT_MODEL as ModelName,
      id: fanoutId as RecordId, expectedRevision });
    if (checkpointRow === null) {
      return {
        ok: false,
        diagnosis: diagnoseCohort(
          'membership-unavailable',
          'Fanout checkpoint is missing; refusing to invent completion.',
        ),
      };
    }
    const checkpoint = readPrivateFanoutCheckpointRow(checkpointRow);
    checkCheckpointMembership(checkpoint, intent);
    if (checkpoint.cursor === null) {
      return { ok: true, frozen: { fanoutId, members, cutoffRevision: expectedRevision, replayed: true } };
    }
    committedRevision = await commitBatch(input.store, {
      expectedRevision,
      writes: [
        {
          kind: 'update',
          model: FANOUT_CHECKPOINT_MODEL as ModelName,
          id: fanoutId as RecordId,
          expectedVersion: checkpointRow.version,
          row: withFanoutRowData(checkpointRow, { ...checkpoint, cursor: null }, input.meta),
        },
      ],
      history: [],
      receipt: null,
      outbox: [],
      schedules: [],
      uniqueClaims: [],
      uniqueReleases: [],
    });
  } catch (error) {
    if (error instanceof FenceConflictError || error instanceof StorageConstraintError) {
      if (attempt >= input.bounds.maxAttempts) return retryExhausted(input);
      return admitMissing(input, fanoutId, true, attempt + 1, captured);
    }
    if (error instanceof StateError) {
      throw error;
    }
    return {
      ok: false,
      diagnosis: diagnoseCohort(
        'membership-unavailable',
        `Fanout cursor finish failed: ${error instanceof Error ? error.message : String(error)}.`,
      ),
    };
  }
  return { ok: true, frozen: { fanoutId, members, cutoffRevision: committedRevision, replayed: true } };
}

function retryExhausted(input: FreezeMembershipInput): FreezeMembershipOutcome {
  return { ok: false, diagnosis: diagnoseCohort('membership-unavailable',
    `Fanout retained admission lost the fence ${input.bounds.maxAttempts} time(s); the cursor remains resumable.`) };
}

/**
 * Retained-intent or intent-collision replay: a pre-crash attempt or
 * another freeze already committed the intent. Members are the
 * STORED set, never re-enumerated — missing rows admit, and the cursor
 * nulls only when fully admitted.
 */
async function replayFreeze(
  input: FreezeMembershipInput,
  fanoutId: FanoutId,
  captured?: RetainedIntentCapture,
): Promise<FreezeMembershipOutcome> {
  return admitMissing(input, fanoutId, true, 1, captured);
}
