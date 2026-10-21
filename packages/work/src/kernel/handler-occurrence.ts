/** Retained ordinary-handler routes, staged in the existing owner fence. */
import type { FrameworkFilePayloadOrigin, ModelName, QuerySpec, RecordId, RecordVersion, StoredRow, WorkScope } from '@canlang/contracts';
import type { SystemCommandContext, SystemStaging } from '@canlang/state';
import { freezeRequest } from '../intent/staging.js';
import { argRecord, argString, checkArgs } from './arguments.js';
import { workOccurrencePutReceiptCommand } from './occurrence-staging.js';
import { updateWrite } from './staging-support.js';
import { KernelTableError, WORK_OCCURRENCE_MODEL, readOccurrenceRow, withRowData,
  readWorkFilePayloadOrigin, requireWorkFilePayloadOriginReplay, snapshotKernelJsonValue,
  snapshotWorkFilePayloadOrigin } from './tables.js';
import type { OccurrenceRowData } from './tables.js';

export const WORK_HANDLER_OCCURRENCE_MODEL = 'work.handler_occurrence' as ModelName;

/** Host-checked immutable intake; these facts carry no authority themselves. */
export interface HandlerOccurrenceSource {
  readonly occurrenceId: string;
  readonly event: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly filePayloadOrigin?: FrameworkFilePayloadOrigin;
  readonly scope: WorkScope;
}

export interface HandlerOccurrenceSelector {
  readonly sourceOccurrence: string;
  /** Exact canonical handler identity checked against the owning declaration. */
  readonly handler: string;
  readonly event: string;
  readonly scope: WorkScope;
  readonly filePayloadOrigin?: FrameworkFilePayloadOrigin;
}

export interface HandlerOccurrenceRowData {
  readonly occurrenceId: string;
  readonly sourceOccurrence: string;
  readonly handler: string;
  readonly event: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly filePayloadOrigin?: FrameworkFilePayloadOrigin;
  readonly scopeApp: string;
  readonly scopeOwner: string;
  readonly scopeOwnerPackage: string;
  readonly state: 'pending' | 'completed' | 'failed';
}

function scopeOf(args: Readonly<Record<string, unknown>>, what: string): WorkScope {
  const scope = argRecord(args, 'scope', what);
  return Object.freeze({ app: argString(scope, 'app', what),
    owner: argString(scope, 'owner', what), ownerPackage: argString(scope, 'ownerPackage', what) });
}

function selectorOf(input: HandlerOccurrenceSelector): HandlerOccurrenceSelector {
  const args = input as unknown as Readonly<Record<string, unknown>>;
  checkArgs(args, 'handler occurrence selector');
  const captured = snapshotWorkFilePayloadOrigin(args);
  return { sourceOccurrence: argString(args, 'sourceOccurrence', 'handler occurrence selector'),
    handler: argString(args, 'handler', 'handler occurrence selector'),
    event: argString(args, 'event', 'handler occurrence selector'), scope: scopeOf(args, 'handler occurrence selector'),
    ...(Object.hasOwn(captured, 'filePayloadOrigin') ? {
      filePayloadOrigin: captured['filePayloadOrigin'] as FrameworkFilePayloadOrigin,
    } : {}) };
}

/** Independent of event names, sibling order, schedule keys or later heads. */
export function handlerOccurrenceRowId(sourceOccurrence: string, handler: string): string {
  const args = { sourceOccurrence, handler };
  argString(args, 'sourceOccurrence', 'handlerOccurrenceRowId');
  argString(args, 'handler', 'handlerOccurrenceRowId');
  return `handler/v1/${encodeURIComponent(sourceOccurrence)}/${encodeURIComponent(handler)}`;
}

/** Exact own JSON facts, validated through the existing Work row codec. */
export function readHandlerOccurrenceRow(row: StoredRow): HandlerOccurrenceRowData {
  const what = 'work.handler_occurrence';
  checkArgs(row.data, what);
  for (const field of ['occurrenceId', 'sourceOccurrence', 'handler', 'event', 'payload',
    'scopeApp', 'scopeOwner', 'scopeOwnerPackage', 'state']) {
    if (!Object.hasOwn(row.data, field)) throw new KernelTableError(`${what}: missing own ${field}.`);
  }
  if (!Number.isInteger(row.version) || row.version < 1) {
    throw new KernelTableError(`${what}: version must be an integer >= 1.`);
  }
  const filePayloadOrigin = readWorkFilePayloadOrigin(row.data, row, WORK_HANDLER_OCCURRENCE_MODEL, 'payload', 'deferred-input');
  // Reuse the JSON-safety/clone gate; this replacement is never staged.
  const data = withRowData(row, row.data, { nowMs: row.updated, actor: row.updatedBy }, what).data;
  if (!sameJson(data, JSON.parse(JSON.stringify(data)))) {
    throw new KernelTableError(`${what}: data must preserve its JSON facts.`);
  }
  const state = data['state'];
  if (state !== 'pending' && state !== 'completed' && state !== 'failed') {
    throw new KernelTableError(`${what}: unknown state.`);
  }
  const occurrence: HandlerOccurrenceRowData = {
    ...(filePayloadOrigin === undefined ? {} : { filePayloadOrigin }),
    occurrenceId: argString(data, 'occurrenceId', what),
    sourceOccurrence: argString(data, 'sourceOccurrence', what),
    handler: argString(data, 'handler', what), event: argString(data, 'event', what),
    payload: freezeRequest(argRecord(data, 'payload', what)),
    scopeApp: argString(data, 'scopeApp', what), scopeOwner: argString(data, 'scopeOwner', what),
    scopeOwnerPackage: argString(data, 'scopeOwnerPackage', what), state,
  };
  if (row.id !== occurrence.occurrenceId ||
      occurrence.occurrenceId !== handlerOccurrenceRowId(occurrence.sourceOccurrence, occurrence.handler)) {
    throw new KernelTableError(`${what}: mismatched derived identity.`);
  }
  return Object.freeze(occurrence);
}

/** Bind an ordinary route produced by the same owner finalizer to its exact
 * declared-event File source. The route is still an insert: this preserves
 * every byte of its identity, lifetime and typed payload. */
export function withHandlerOccurrenceFilePayloadOrigin(
  row: StoredRow, filePayloadOrigin: FrameworkFilePayloadOrigin,
): StoredRow {
  const original = readHandlerOccurrenceRow(row);
  const expectedFields = ['event', 'handler', 'occurrenceId', 'payload', 'scopeApp',
    'scopeOwner', 'scopeOwnerPackage', 'sourceOccurrence', 'state'];
  if (original.state !== 'pending' || original.filePayloadOrigin !== undefined ||
      row.version !== 1 || row.archivedAt !== null || row.parent !== null ||
      row.created !== row.updated || row.createdBy !== row.updatedBy ||
      !sameJson(Object.keys(row.data).sort(), expectedFields)) {
    throw new KernelTableError('Declared event route needs its original unbound pending insert.');
  }
  const header = readWorkFilePayloadOrigin({ filePayloadOrigin }, row,
    WORK_HANDLER_OCCURRENCE_MODEL, 'payload', 'deferred-input');
  const origin = header?.origin;
  if (header === undefined || origin?.kind !== 'event-input' || origin.occurrenceId !== row.id ||
      origin.sourceOccurrence !== original.sourceOccurrence ||
      origin.lineage.kind !== 'source' ||
      origin.lineage.sourceOccurrence !== original.sourceOccurrence ||
      origin.declaration.kind !== 'declared-event' || origin.declaration.event !== original.event ||
      origin.target.kind !== 'handler' || origin.target.handler.callable.id !== original.handler ||
      header.scope.app !== original.scopeApp || header.scope.owner !== original.scopeOwner ||
      header.scope.ownerPackage !== original.scopeOwnerPackage ||
      header.inventory.owner !== original.scopeOwnerPackage) {
    throw new KernelTableError('Declared event route header differs from its original Work source and handler.');
  }
  const data = snapshotKernelJsonValue({ ...row.data, filePayloadOrigin: header },
    'declared event handler route');
  const bound: StoredRow = Object.freeze({ id: row.id, version: row.version,
    created: row.created, updated: row.updated, createdBy: row.createdBy,
    updatedBy: row.updatedBy, archivedAt: row.archivedAt, parent: row.parent, data });
  const checked = readHandlerOccurrenceRow(bound);
  if (checked.filePayloadOrigin === undefined ||
      !sameJson({ ...checked, filePayloadOrigin: undefined },
        { ...original, filePayloadOrigin: undefined })) {
    throw new KernelTableError('Declared event route binding changed the original route.');
  }
  return bound;
}

function matches(data: HandlerOccurrenceRowData, input: HandlerOccurrenceSelector): boolean {
  return data.sourceOccurrence === input.sourceOccurrence && data.handler === input.handler &&
    data.event === input.event && data.scopeApp === input.scope.app &&
    data.scopeOwner === input.scope.owner && data.scopeOwnerPackage === input.scope.ownerPackage;
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a).sort();
  const right = Object.keys(b).sort();
  return left.length === right.length && left.every((key, index) => key === right[index] &&
    sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

type Refused = { readonly status: 'refused'; readonly reason: string };
type Route = { readonly row: StoredRow; readonly occurrence: HandlerOccurrenceRowData };

export type HandlerOccurrenceStageResult = Refused |
  (Route & { readonly status: 'ready' | 'replayed'; readonly effects: SystemStaging });

/**
 * Capture one checked route before any await. The caller combines ALL routes,
 * the frozen cohort cut and source consumption in one revision-fenced batch.
 * No bodies execute here; ordinary authored refusal cannot reject that source.
 * Replay returns only matching retained facts and never recaptures membership.
 */
export async function stageHandlerOccurrence(
  input: { readonly source: HandlerOccurrenceSource; readonly handler: string;
    /** Original host-issued binding for this handler row, never a source-row copy. */
    readonly filePayloadOrigin?: FrameworkFilePayloadOrigin },
  ctx: SystemCommandContext,
): Promise<HandlerOccurrenceStageResult> {
  const what = 'stageHandlerOccurrence';
  const args = input as unknown as Readonly<Record<string, unknown>>;
  checkArgs(args, what);
  const source = argRecord(args, 'source', what);
  const selector = selectorOf({ sourceOccurrence: argString(source, 'occurrenceId', what),
    event: argString(source, 'event', what), handler: argString(args, 'handler', what), scope: scopeOf(source, what) });
  const captured = snapshotWorkFilePayloadOrigin(args);
  if (Object.hasOwn(source, 'filePayloadOrigin') && !Object.hasOwn(captured, 'filePayloadOrigin')) {
    throw new KernelTableError(`${what}: bound source requires its own supplied handler origin.`);
  }
  const id = handlerOccurrenceRowId(selector.sourceOccurrence, selector.handler);
  const data: HandlerOccurrenceRowData = { occurrenceId: id,
    sourceOccurrence: selector.sourceOccurrence, handler: selector.handler, event: selector.event,
    payload: freezeRequest(argRecord(source, 'payload', what)), scopeApp: selector.scope.app,
    scopeOwner: selector.scope.owner, scopeOwnerPackage: selector.scope.ownerPackage, state: 'pending' };
  const existing = await ctx.load(WORK_HANDLER_OCCURRENCE_MODEL, id as RecordId);
  if (existing !== null) {
    const retained = readHandlerOccurrenceRow(existing);
    requireWorkFilePayloadOriginReplay(readWorkFilePayloadOrigin(captured, existing,
      WORK_HANDLER_OCCURRENCE_MODEL, 'payload', 'deferred-input'), retained.filePayloadOrigin);
    if (!matches(retained, selector) || !sameJson(retained.payload, data.payload)) {
      return { status: 'refused', reason: 'mismatched' };
    }
    const checked = await retainedResult(existing, retained, ctx);
    if (checked.status === 'refused') return checked;
    return { status: 'replayed', row: existing, occurrence: retained, effects: {} };
  }
  const filePayloadOrigin = readWorkFilePayloadOrigin(captured,
    { id: id as RecordId, created: ctx.now, createdBy: ctx.actor },
    WORK_HANDLER_OCCURRENCE_MODEL, 'payload', 'deferred-input');
  const capturedData = { ...data, ...(filePayloadOrigin === undefined ? {} : { filePayloadOrigin }) };
  // The zero-version base is not stored; the shared codec produces version 1.
  const row = withRowData({ id: data.occurrenceId as RecordId, version: 0 as RecordVersion,
    created: ctx.now, updated: ctx.now, createdBy: ctx.actor, updatedBy: ctx.actor,
    archivedAt: null, parent: null, data: {} }, capturedData as unknown as Readonly<Record<string, unknown>>,
    { nowMs: ctx.now, actor: ctx.actor }, what);
  const occurrence = readHandlerOccurrenceRow(row);
  if (await ctx.load(WORK_OCCURRENCE_MODEL, row.id) !== null) {
    return { status: 'refused', reason: 'orphan-receipt' };
  }
  return { status: 'ready', row, occurrence,
    effects: { writes: [{ kind: 'insert', model: WORK_HANDLER_OCCURRENCE_MODEL, row }] } };
}

export type RetainedHandlerOccurrenceResult = Refused |
  (Route & { readonly status: 'ready' }) |
  { readonly status: 'replayed'; readonly receipt: OccurrenceRowData };

/** Read the retained runnable facts; the host rechecks current authority. */
export async function stageRetainedHandlerOccurrence(
  input: HandlerOccurrenceSelector, ctx: SystemCommandContext,
): Promise<RetainedHandlerOccurrenceResult> {
  const selector = selectorOf(input);
  const id = handlerOccurrenceRowId(selector.sourceOccurrence, selector.handler) as RecordId;
  const row = await ctx.load(WORK_HANDLER_OCCURRENCE_MODEL, id);
  if (row === null) return { status: 'refused', reason: 'missing' };
  const occurrence = readHandlerOccurrenceRow(row);
  requireWorkFilePayloadOriginReplay(readWorkFilePayloadOrigin(selector as unknown as Readonly<Record<string, unknown>>,
    row, WORK_HANDLER_OCCURRENCE_MODEL, 'payload', 'deferred-input'), occurrence.filePayloadOrigin);
  if (!matches(occurrence, selector)) return { status: 'refused', reason: 'mismatched' };
  return retainedResult(row, occurrence, ctx);
}

async function retainedResult(
  row: StoredRow, occurrence: HandlerOccurrenceRowData, ctx: SystemCommandContext,
): Promise<RetainedHandlerOccurrenceResult> {
  const id = row.id;
  const receiptRow = await ctx.load(WORK_OCCURRENCE_MODEL, id);
  if (receiptRow !== null) {
    const receipt = readOccurrenceRow(receiptRow);
    if (receiptRow.id !== id || receipt.occurrenceId !== id || occurrence.state !== receipt.status) {
      return { status: 'refused', reason: 'mismatched-receipt' };
    }
    return { status: 'replayed', receipt };
  }
  if (occurrence.state !== 'pending') return { status: 'refused', reason: 'missing-receipt' };
  return { status: 'ready', row, occurrence };
}

export interface HandlerOccurrenceTerminalInput extends HandlerOccurrenceSelector {
  readonly expectedVersion: number;
  readonly receipt: Omit<OccurrenceRowData, 'occurrenceId'>;
}

export type HandlerOccurrenceTerminalResult = Refused |
  { readonly status: 'replayed'; readonly receipt: OccurrenceRowData } |
  { readonly status: 'ready'; readonly effects: SystemStaging };

/** Join one independent body's effects with this row update and existing receipt. */
export async function stageHandlerOccurrenceTerminal(
  input: HandlerOccurrenceTerminalInput, ctx: SystemCommandContext,
): Promise<HandlerOccurrenceTerminalResult> {
  const selector = selectorOf(input);
  const expectedVersion = input.expectedVersion;
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new KernelTableError('stageHandlerOccurrenceTerminal: expectedVersion must be an integer >= 1.');
  }
  const receipt = snapshotKernelJsonValue(input.receipt, 'stageHandlerOccurrenceTerminal.receipt');
  const retained = await stageRetainedHandlerOccurrence(selector, ctx);
  if (retained.status === 'replayed') {
    // Reuse the owning receipt duplicate gate, including its actual row lifetime.
    await workOccurrencePutReceiptCommand.stage({ ...receipt,
      occurrenceId: handlerOccurrenceRowId(selector.sourceOccurrence, selector.handler) }, ctx);
    return retained;
  }
  if (retained.status !== 'ready') return retained;
  if (retained.row.version !== expectedVersion) return { status: 'refused', reason: 'stale' };
  const terminal = await workOccurrencePutReceiptCommand.stage({ ...receipt,
    occurrenceId: retained.occurrence.occurrenceId }, ctx);
  // A winner observed after the route read cannot be joined with a new update.
  if ((terminal.writes?.length ?? 0) !== 1) return { status: 'refused', reason: 'mismatched-receipt' };
  return { status: 'ready', effects: { ...terminal, writes: [
    updateWrite(retained.row, { ...retained.occurrence, state: receipt['status'] }, ctx,
      WORK_HANDLER_OCCURRENCE_MODEL, 'stageHandlerOccurrenceTerminal'), ...terminal.writes ?? [] ] } };
}

/**
 * One bounded owner page, ascending by stable identity. The caller must read
 * each returned row and re-filter exact scope, pending state and cursor;
 * page exhaustion is navigation only, never an occurrence outcome.
 */
export function handlerOccurrencePendingQuery(
  scope: WorkScope, opts: { readonly cursor: string | null; readonly limit: number },
): QuerySpec {
  const checked = scopeOf({ scope }, 'handlerOccurrencePendingQuery');
  if ((opts.cursor !== null && (typeof opts.cursor !== 'string' || opts.cursor === '')) ||
      !Number.isSafeInteger(opts.limit) || opts.limit < 1) {
    throw new KernelTableError('handlerOccurrencePendingQuery: invalid cursor or limit.');
  }
  return { model: WORK_HANDLER_OCCURRENCE_MODEL, authority: 'owner', where: { op: 'and', args: [
    { op: 'eq', field: 'scopeApp', value: checked.app },
    { op: 'eq', field: 'scopeOwner', value: checked.owner },
    { op: 'eq', field: 'scopeOwnerPackage', value: checked.ownerPackage },
    { op: 'eq', field: 'state', value: 'pending' },
    ...(opts.cursor === null ? [] : [{ op: 'gt' as const, field: 'id', value: opts.cursor }]),
  ] }, order: [{ field: 'id', direction: 'asc' }], limit: opts.limit };
}
