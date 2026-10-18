/** Finite current-authorized audit read for one canonical model/row. */
import type { HistoryEntry, ModelName, RecordId, Revision, StoredRow } from '@canlang/contracts';
import { StateError } from '../errors.js';
import { FenceConflictError } from '../storage/port.js';
import { captureHistoryRequest, copyBoundedHistory } from '../storage/sqlite-codecs.js';
import { deepFreeze } from '../internal/own-data.js';
import { stableStringify } from '../invocation/replay.js';
import { checkedMembershipFact, observeRowGrantAuthority } from '../policy/membership-facts.js';
import { evaluateBy } from '../policy/roles.js';
import { type ByContext } from '../policy/grants.js';
import { prepareViewerHistoryProjection, projectCurrentRecordForViewerPolicy,
  type BaseQueryInput, type ViewerPageParentPolicy } from './engine.js';

export interface ViewerHistoryInput extends Pick<BaseQueryInput,
  'policy' | 'context' | 'memberships' | 'store' | 'fence'> {
  readonly model: ModelName;
  readonly recordId: RecordId;
  readonly limit?: number;
  /** Complete checked model read/containment facts from the owning source. */
  readonly readPolicies: ReadonlyMap<ModelName, ViewerPageParentPolicy>;
}
export interface ViewerHistoryResult {
  readonly revision: Revision;
  /** Internal writer provenance is withheld from presentation. */
  readonly entries: ReadonlyArray<Omit<HistoryEntry, 'auditProjection'>>;
}

function unsupported(): never {
  throw new StateError('validation', 'History has no supported complete lifetime and original-secret evidence.');
}
function notFound(): never { throw new StateError('not_found', 'Record not found.'); }

/** Entry/proof shape must bind the stored row before chain checks run. */
function checkedOriginalProof(entry: HistoryEntry, row: StoredRow,
  model: ModelName): NonNullable<HistoryEntry['auditProjection']> {
  if (typeof entry !== 'object' || entry === null) return unsupported();
  const proof = entry.auditProjection;
  if (entry.model !== model || entry.recordId !== row.id || typeof proof !== 'object' || proof === null ||
      proof.created !== row.created || proof.createdBy !== row.createdBy ||
      !Array.isArray(proof.secretFields)) return unsupported();
  return proof;
}

/** Version/clock/actor/operation/payload shape carries no chain meaning. */
function assertOriginalEntryFields(entry: HistoryEntry): void {
  if (!Number.isSafeInteger(entry.version) || entry.version < 1 ||
      !Number.isFinite(entry.at) || typeof entry.actor !== 'string' ||
      typeof entry.operation !== 'string' || typeof entry.operationId !== 'string' ||
      typeof entry.after !== 'object' || entry.after === null || Array.isArray(entry.after) ||
      entry.before !== null && (typeof entry.before !== 'object' || Array.isArray(entry.before))) return unsupported();
}

/** Secret paths stay non-empty dot segments; contract types may lie at runtime. */
function collectOriginalSecret(path: unknown, secrets: Set<string>): void {
  if (typeof path !== 'string' || path === '' || path.split('.').some(part => part === '')) return unsupported();
  secrets.add(path);
}

/** Create-then-monotone-version links with exact before/after continuity. */
function assertOriginalChainLink(entry: HistoryEntry, previous: HistoryEntry | undefined, row: StoredRow): void {
  if (previous === undefined) {
    if (entry.change !== 'create' || entry.before !== null || entry.after === null ||
        entry.version !== 1 || entry.at !== row.created || entry.actor !== row.createdBy) return unsupported();
  } else if ((entry.change !== 'update' && entry.change !== 'archive') ||
      entry.before === null || entry.after === null ||
      entry.version < previous.version || entry.version > previous.version + 1 ||
      previous.change === 'create' && entry.version !== previous.version + 1 ||
      stableStringify(entry.before) !== stableStringify(previous.after)) return unsupported();
}

/** The tip must land exactly on the stored row version/clock/actor/data. */
function assertOriginalChainTip(entry: HistoryEntry, row: StoredRow): void {
  if (entry.version !== row.version || entry.at !== row.updated || entry.actor !== row.updatedBy ||
      stableStringify(entry.after) !== stableStringify(row.data) ||
      (row.archivedAt === null ? entry.change === 'archive' :
        entry.change !== 'archive' || row.archivedAt !== entry.at)) return unsupported();
}

/** Legacy, recreated, missing-stage or migration-discontinuous chains refuse. */
function originalSecrets(entries: readonly HistoryEntry[], row: StoredRow,
  model: ModelName): readonly string[] {
  if (entries.length === 0) return unsupported();
  const secrets = new Set<string>();
  let previous: HistoryEntry | undefined;
  for (const entry of entries) {
    const proof = checkedOriginalProof(entry, row, model);
    assertOriginalEntryFields(entry);
    for (const path of proof.secretFields) collectOriginalSecret(path, secrets);
    assertOriginalChainLink(entry, previous, row);
    previous = entry;
  }
  assertOriginalChainTip(previous!, row);
  return Object.freeze([...secrets]);
}

/** No owner fallback, raw history materialization or synthetic empty history. */
export async function queryRecordHistoryForViewer(input: ViewerHistoryInput): Promise<ViewerHistoryResult> {
  const { store, memberships, fence } = input;
  const readHistory = store.historyReadBounded;
  const load = store.cohortLoad;
  if (typeof readHistory !== 'function' || typeof load !== 'function') {
    throw new StateError('validation', 'This store has no bounded viewer-history read.');
  }
  const policy = new Map(input.policy);
  const readPolicies = new Map(input.readPolicies);
  const context = Object.freeze({ ...input.context });
  const selection = captureHistoryRequest({ model: input.model, recordId: input.recordId,
    limit: input.limit ?? 100, expectedRevision: 0 as Revision });
  const revision = await store.readRevision();
  const request = { ...selection, expectedRevision: revision };
  if (fence !== undefined && fence.revision !== revision) throw new FenceConflictError(fence.revision, revision);
  const checkRevision = async (): Promise<void> => {
    const actual = await store.readRevision();
    if (actual !== revision) throw new FenceConflictError(revision, actual);
  };
  const membership = context.actorUserId === null || context.teamId === null ? null :
    checkedMembershipFact(await memberships.findMembership(context.teamId, context.actorUserId), context.teamId, context.actorUserId);
  const byContext: ByContext = { ...context, membership, memberships };
  const current = await load.call(store, { model: request.model, id: request.recordId, expectedRevision: revision });
  if (current === null) return notFound();
  fence?.enroll({ kind: 'record', model: request.model, id: current.id, version: current.version });
  fence?.enroll({ kind: 'query', model: request.model, authority: 'viewer' });
  if (context.actorUserId !== null && context.teamId !== null) {
    fence?.enroll({ kind: 'membership', teamId: context.teamId, userId: context.actorUserId });
  }
  // These are original live rows at one State fence, reused by coherent replay.
  const rows = new Map<ModelName, StoredRow>([[request.model, current]]);
  let history: readonly HistoryEntry[] | undefined;
  let secrets: readonly string[] | undefined;
  const authority = await observeRowGrantAuthority(byContext, async coherent => {
    const decisions: unknown[] = [];
    let model = request.model;
    let row = current;
    const visited = new Set<ModelName>();
    while (true) {
      if (visited.has(model) || visited.size >= 100) throw new StateError('validation', 'Unsupported history containment scope.');
      visited.add(model);
      const read = readPolicies.get(model);
      if (read === undefined) throw new StateError('validation', 'History requires its checked model read and containment facts.');
      if (!(await evaluateBy(read.by, coherent))) return notFound();
      const granted = await projectCurrentRecordForViewerPolicy({ policy: policy.get(model), context: coherent, row });
      if (granted.record === null || model !== request.model && row.archivedAt !== null) return notFound();
      decisions.push({ model, allowed: granted.allowed, record: granted.record });
      const parent = row.parent ?? null;
      if (read.parent === undefined ? parent !== null : parent === null || parent.model !== read.parent) return notFound();
      if (parent === null) break;
      model = parent.model;
      if (!rows.has(model)) {
        const loaded = await load.call(store, { model, id: parent.id, expectedRevision: revision });
        if (loaded === null) return notFound();
        rows.set(model, loaded);
        fence?.enroll({ kind: 'record', model, id: loaded.id, version: loaded.version });
      }
      row = rows.get(model)!;
      if (row.id !== parent.id) return notFound();
    }
    const projection = await prepareViewerHistoryProjection({ policy: policy.get(request.model),
      context: coherent, current, coherentContext: true });
    if (projection === null) return notFound();
    if (history === undefined) {
      history = deepFreeze(copyBoundedHistory(await readHistory.call(store, { ...request }), request.limit));
      secrets = originalSecrets(history, current, request.model);
    }
    const entries = history.map(entry => {
      const { auditProjection: _internal, ...metadata } = entry;
      return { ...metadata, before: projection.project(entry.before, secrets!), after: projection.project(entry.after, secrets!) };
    });
    return { entries, decisions, allowed: projection.allowed };
  });
  await authority.revalidate();
  await checkRevision();
  return deepFreeze({ revision, entries: authority.value.entries });
}
