/**
 * Internal durable scan positions, separate from admission and terminal coverage.
 * These helpers only validate rows, stage DomainWrites, and describe one bounded
 * query. The consumer supplies the existing owner store/revision fence and
 * visits only processed rows (never the unprocessed tail of a fetched page).
 * Terminal visits co-stage navigation with the real child effects; held,
 * replayed, refused, and exceptional visits may use fenced maintenance.
 * Exhaustion resets a position for a later slice; it never proves completion.
 * This is a trusted low-level contract: resolve actual owner/source before
 * reading from its privileged StoragePort. StoredRow carries no table/owner
 * authority; load these rows from their named models in that same store.
 * Caller text and these positions grant no authority. Installed-host routing,
 * bounded admission/driving, and restart fairness require the real consumer.
 */
import type {
  DomainWrite, ModelName, QuerySpec, RecordId, RecordVersion, StoredRow,
} from '@canlang/contracts';
import { StateError } from '../errors.js';
import {
  FANOUT_INTENT_MODEL, fanoutChildPageQuery, fanoutChildRowId,
  fanoutIntentRowId, readFanoutChildRow, readFanoutIntentRow,
  withFanoutRowData, type FanoutIntentData, type FanoutRowMeta,
} from './tables.js';

export const FANOUT_NAVIGATION_MODEL = 'work.fanout_navigation';
export const FANOUT_OWNER_SCAN_MODEL = 'work.fanout_owner_scan';

export interface FanoutNavigationData {
  readonly owner: string;
  readonly fanoutId: string;
  readonly sourceOccurrence: string;
  readonly handler: string;
  readonly cohort: FanoutIntentData['cohort'];
  /** The retained intent is immutable; replacement is an identity mismatch. */
  readonly intentVersion: number;
  readonly lastVisitedChildId: string | null;
}

export interface FanoutOwnerScanData {
  readonly owner: string;
  readonly lastVisitedIntentId: string | null;
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new StateError('validation', `Fanout navigation ${label} must be non-empty.`);
  }
  return value;
}

function position(value: unknown): string | null {
  return value === null ? null : nonempty(value, 'position');
}

function liveRow(row: StoredRow): void {
  if (!Number.isSafeInteger(row.version) || row.version < 1 || row.archivedAt !== null ||
    (row.parent ?? null) !== null || typeof row.data !== 'object' || row.data === null ||
    Array.isArray(row.data)) {
    throw new StateError('validation', 'Fanout navigation requires a live unparented versioned row.');
  }
}

function retainedIntent(row: StoredRow): FanoutIntentData {
  liveRow(row);
  return readFanoutIntentRow(row);
}

/** Encoded owner prevents scan positions from crossing owner identities. */
export function fanoutNavigationRowId(owner: string, fanoutId: string): string {
  return `fanout-navigation/v1/${encodeURIComponent(nonempty(owner, 'owner'))}/${encodeURIComponent(nonempty(fanoutId, 'fanoutId'))}`;
}

export function fanoutOwnerScanRowId(owner: string): string {
  return `fanout-owner-scan/v1/${encodeURIComponent(nonempty(owner, 'owner'))}`;
}

export interface FanoutNavigationBinding {
  readonly owner: string;
  /** Exact retained intent row loaded from the same operating owner store. */
  readonly intentRow: StoredRow;
}

export function readFanoutNavigationRow(
  row: StoredRow, binding: FanoutNavigationBinding,
): FanoutNavigationData {
  const intent = retainedIntent(binding.intentRow);
  liveRow(row);
  const data = row.data;
  if (row.id !== fanoutNavigationRowId(binding.owner, intent.fanoutId) ||
    data['owner'] !== binding.owner || data['fanoutId'] !== intent.fanoutId ||
    data['sourceOccurrence'] !== intent.sourceOccurrence || data['handler'] !== intent.handler ||
    data['cohort'] !== intent.cohort || data['intentVersion'] !== binding.intentRow.version) {
    throw new StateError('validation', 'Fanout navigation owner or retained intent identity disagrees.');
  }
  const lastVisitedChildId = position(data['lastVisitedChildId']);
  if (lastVisitedChildId !== null && !intent.members.some(recordId =>
    fanoutChildRowId(intent.sourceOccurrence, intent.handler, recordId) === lastVisitedChildId)) {
    throw new StateError('validation', 'Fanout navigation position is outside retained membership.');
  }
  return { owner: binding.owner, fanoutId: intent.fanoutId,
    sourceOccurrence: intent.sourceOccurrence, handler: intent.handler, cohort: intent.cohort,
    intentVersion: binding.intentRow.version, lastVisitedChildId };
}

function checkIntentPosition(id: string): void {
  try {
    const parts = id.split('/');
    if (parts.length !== 5 || parts[0] !== 'fanout' || parts[1] !== 'v1' ||
      (parts[4] !== 'model' && parts[4] !== 'anchored-collection') ||
      fanoutIntentRowId(decodeURIComponent(parts[2]!), decodeURIComponent(parts[3]!), parts[4]) !== id) {
      throw new Error('invalid position');
    }
  } catch {
    throw new StateError('validation', 'Fanout owner scan position is not a canonical intent identity.');
  }
}

export function readFanoutOwnerScanRow(row: StoredRow, owner: string): FanoutOwnerScanData {
  liveRow(row);
  if (row.id !== fanoutOwnerScanRowId(owner) || row.data['owner'] !== owner) {
    throw new StateError('validation', 'Fanout owner scan identity disagrees.');
  }
  const lastVisitedIntentId = position(row.data['lastVisitedIntentId']);
  if (lastVisitedIntentId !== null) checkIntentPosition(lastVisitedIntentId);
  return { owner, lastVisitedIntentId };
}

function write(
  model: string, id: string, current: StoredRow | null,
  data: Readonly<Record<string, unknown>>, meta: FanoutRowMeta,
): DomainWrite {
  if (current !== null) {
    return { kind: 'update', model: model as ModelName, id: current.id,
      expectedVersion: current.version, row: withFanoutRowData(current, data, meta) };
  }
  if (!Number.isFinite(meta.nowMs) || meta.nowMs < 0) {
    throw new StateError('validation', 'Fanout navigation nowMs must be finite epoch ms >= 0.');
  }
  nonempty(meta.actor, 'actor');
  return { kind: 'insert', model: model as ModelName, row: {
    id: id as RecordId, version: 1 as RecordVersion,
    created: meta.nowMs, updated: meta.nowMs, createdBy: meta.actor, updatedBy: meta.actor,
    archivedAt: null, parent: null, data: structuredClone(data),
  } };
}

/** Stage the actual visited child, or an explicit wrap (null) after exhaustion. */
export function stageFanoutNavigationWrite(input: FanoutNavigationBinding & {
  readonly row: StoredRow | null;
  readonly visitedChildRow: StoredRow | null;
  readonly meta: FanoutRowMeta;
}): DomainWrite {
  const intent = retainedIntent(input.intentRow);
  const current = input.row === null ? null : readFanoutNavigationRow(input.row, input);
  let lastVisitedChildId: string | null = null;
  if (input.visitedChildRow !== null) {
    liveRow(input.visitedChildRow);
    const child = readFanoutChildRow(input.visitedChildRow);
    if (child.fanoutId !== intent.fanoutId || child.parentOccurrence !== intent.sourceOccurrence ||
      child.handler !== intent.handler || !intent.members.includes(child.recordId)) {
      throw new StateError('validation', 'Fanout visited child disagrees with retained intent.');
    }
    lastVisitedChildId = child.childId;
    if (current !== null && current.lastVisitedChildId !== null &&
      lastVisitedChildId <= current.lastVisitedChildId) {
      throw new StateError('validation', 'Fanout child visit must advance; wrap explicitly before revisiting.');
    }
  }
  return write(FANOUT_NAVIGATION_MODEL, fanoutNavigationRowId(input.owner, intent.fanoutId),
    input.row, { owner: input.owner, fanoutId: intent.fanoutId,
      sourceOccurrence: intent.sourceOccurrence, handler: intent.handler, cohort: intent.cohort,
      intentVersion: input.intentRow.version, lastVisitedChildId }, input.meta);
}

/** Store one actually selected retained intent; null wraps only the owner scan. */
export function stageFanoutOwnerScanWrite(input: {
  readonly row: StoredRow | null;
  readonly owner: string;
  readonly visitedIntentRow: StoredRow | null;
  readonly meta: FanoutRowMeta;
}): DomainWrite {
  const current = input.row === null ? null : readFanoutOwnerScanRow(input.row, input.owner);
  const lastVisitedIntentId = input.visitedIntentRow === null
    ? null : retainedIntent(input.visitedIntentRow).fanoutId;
  if (lastVisitedIntentId !== null && current !== null && current.lastVisitedIntentId !== null &&
    lastVisitedIntentId <= current.lastVisitedIntentId) {
    throw new StateError('validation', 'Fanout intent visit must advance; wrap explicitly before revisiting.');
  }
  return write(FANOUT_OWNER_SCAN_MODEL, fanoutOwnerScanRowId(input.owner), input.row,
    { owner: input.owner, lastVisitedIntentId }, input.meta);
}

/** Exactly one bounded child query; callers decide whether a later slice wraps. */
export function fanoutNavigationChildQuery(input: FanoutNavigationBinding & {
  readonly row: StoredRow | null;
  readonly limit: number;
}): QuerySpec {
  const intent = retainedIntent(input.intentRow);
  nonempty(input.owner, 'owner');
  const cursor = input.row === null ? null : readFanoutNavigationRow(input.row, input).lastVisitedChildId;
  return fanoutChildPageQuery(intent.fanoutId, { cursor, limit: input.limit });
}

/** Intent rows are scoped by the existing owning StoragePort, not a new grant. */
export function fanoutOwnerIntentQuery(input: {
  readonly row: StoredRow | null;
  readonly owner: string;
  readonly limit: number;
}): QuerySpec {
  nonempty(input.owner, 'owner');
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
    throw new StateError('validation', 'Fanout owner scan limit must be an integer >= 1.');
  }
  const cursor = input.row === null ? null : readFanoutOwnerScanRow(input.row, input.owner).lastVisitedIntentId;
  return { model: FANOUT_INTENT_MODEL as ModelName, authority: 'owner',
    order: [{ field: 'id', direction: 'asc' }], limit: input.limit,
    ...(cursor === null ? {} : { where: { op: 'gt' as const, field: 'id', value: cursor } }),
  };
}
