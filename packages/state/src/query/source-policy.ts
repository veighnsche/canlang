/** Installed ordinary source policies share the actual State row, Identity and checkpoint observation. */
import type { ModelName, ProjectedRecord, RecordId, Revision, StoragePort, StoredRow } from '@canlang/contracts';
import { StateError } from '../errors.js';
import { deepFreeze } from '../internal/own-data.js';
import { jsonClone } from '../internal/json.js';
import { checkedMembershipFact, observeRowGrantAuthority } from '../policy/membership-facts.js';
import { isEqualOrUnder, isMetadataPath, withPolicyRow, type ByContext, type PolicyTable } from '../policy/grants.js';
import { evaluateBy, validateByPredicate } from '../policy/roles.js';
import { FenceConflictError } from '../storage/port.js';
import { captureInstalledSourceOwnerRows, evaluateInstalledReadPolicy, withinInstalledReadObservation, withinInstalledSourceReadQuery, type InstalledSourceOwnerRows } from '../receipt/read-policy-membership.js';
import { projectCurrentRecordForViewerPolicy, projectSourceRowFields,
  type BaseQueryInput, type ViewerPageParentPolicy } from './engine.js';

export interface ViewerGenerationCallbackReadObservation {
  readonly context: ByContext;
  readonly row: StoredRow;
  readonly revision: Revision;
  readonly fence: BaseQueryInput['fence'];
  /** Private same-load field presence; names disclose no values or grants. */
  readonly sourcePresence?: readonly string[];
}
/** Reader-local adaptation of verified original ordinary read declarations.
 * Every callable evaluates its exact source rule, including where, in ordinal order.
 * Omitted selectors are expanded by the verified loader, never inferred here. */
export interface ViewerGenerationCallbackSourceReadPolicy {
  readonly parent?: ModelName;
  readonly fields: readonly string[];
  readonly secretFields: readonly string[];
  readonly grants: readonly {
    readonly fields: readonly string[];
    readonly read: (observation: Readonly<ViewerGenerationCallbackReadObservation>) => Promise<boolean>;
  }[];
}

function invalid(): never { throw new StateError('validation', 'Unsupported installed source policy.'); }
function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) return invalid();
  return descriptor.value;
}
function record(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid();
}
function text(value: unknown, limit = 200): string {
  if (typeof value !== 'string' || value === '' || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  try { encodeURIComponent(value); } catch { invalid(); }
  return value;
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const length = own(value, 'length');
  if (typeof length !== 'number' || length > maximum || Reflect.ownKeys(value).length !== length + 1) invalid();
  for (let index = 0; index < length; index++) own(value, String(index));
  return value;
}
export function captureSourceReadPolicy(value: ViewerGenerationCallbackSourceReadPolicy): ViewerGenerationCallbackSourceReadPolicy {
  record(value);
  const names = Object.freeze(array(own(value, 'fields'), 1000).map(name => text(name)));
  if (new Set(names).size !== names.length || names.some(name => name.includes('.') || /[\[\]]/.test(name))) invalid();
  const path = (value: unknown) => {
    const result = text(value), head = result.split('.')[0]!;
    if (result.split('.').some(part => part === '') || /[\[\]]/.test(result) ||
        !names.includes(head) && !isMetadataPath(result) && head !== 'parent' ||
        result.split('.').includes('callback_diagnostics')) invalid();
    return result;
  };
  const secrets = Object.freeze(array(own(value, 'secretFields'), 1000).map(path));
  const grants = Object.freeze(array(own(value, 'grants'), 1000).map(value => {
    record(value);
    if (Reflect.ownKeys(value).length !== 2) invalid();
    const fields = Object.freeze(array(own(value, 'fields'), 1000).map(path));
    const read = own(value, 'read');
    if (fields.length === 0 || new Set(fields).size !== fields.length || typeof read !== 'function' ||
        fields.some(field => secrets.some(secret => isEqualOrUnder(field, secret)))) invalid();
    return Object.freeze({ fields, read }) as ViewerGenerationCallbackSourceReadPolicy['grants'][number];
  }));
  const parent = Object.hasOwn(value, 'parent') ? text(own(value, 'parent')) as ModelName : undefined;
  if (Reflect.ownKeys(value).length !== (parent === undefined ? 3 : 4)) invalid();
  return Object.freeze({ fields: names, secretFields: secrets, grants, ...(parent === undefined ? {} : { parent }) });
}

export type ViewerSourceReadPolicy = ViewerPageParentPolicy | ViewerGenerationCallbackSourceReadPolicy;
export interface InstalledSourceRowProjection {
  readonly record: ProjectedRecord | null;
  readonly allowed: readonly boolean[];
  readonly grants: readonly { readonly fields: readonly string[] }[];
}

/** Internal capture shared by reader owners; no source execution or authority is issued. */
export function captureSourceReadPolicies(reads: ReadonlyMap<ModelName, ViewerSourceReadPolicy>): ReadonlyMap<ModelName, ViewerSourceReadPolicy> {
  return new Map<ModelName, ViewerSourceReadPolicy>([...reads].map(([model, read]) => {
    text(model); const value: unknown = read; record(value);
    if ('grants' in read) return [model, captureSourceReadPolicy(read)] as const;
    const by = deepFreeze(jsonClone(own(read, 'by'), 'Source parent predicate')) as ViewerPageParentPolicy['by'];
    validateByPredicate(by, 'source parent read');
    const parent = Object.hasOwn(read, 'parent') ? text(own(read, 'parent')) as ModelName : undefined;
    if (Reflect.ownKeys(read).length !== (parent === undefined ? 1 : 2)) invalid();
    return [model, Object.freeze({ by, ...(parent === undefined ? {} : { parent }) })] as const;
  }));
}

/** Internal row projection; its caller owns complete coherent observation and final checks. */
export async function projectInstalledSourceRow(input: {
  readonly read: ViewerGenerationCallbackSourceReadPolicy;
  readonly observation: Readonly<ViewerGenerationCallbackReadObservation>;
  readonly store: StoragePort;
  readonly owningObservation?: Readonly<ViewerGenerationCallbackReadObservation>;
  readonly ownerRows?: InstalledSourceOwnerRows;
}): Promise<InstalledSourceRowProjection> {
  const { read, observation, store } = input;
  const ownerRows = input.ownerRows === undefined ? undefined : captureInstalledSourceOwnerRows(input.ownerRows);
  ownerRows?.assertHealthy();
  const allowed: boolean[] = [], grants: { readonly fields: readonly string[] }[] = [];
  for (const grant of read.grants) {
    ownerRows?.assertHealthy();
    const before = await store.readRevision();
    ownerRows?.assertHealthy();
    if (before !== observation.revision) throw new FenceConflictError(observation.revision, before);
    const verdict = await evaluateInstalledReadPolicy(grant.read, observation, store, input.owningObservation, ownerRows);
    if (typeof verdict !== 'boolean') invalid();
    ownerRows?.assertHealthy();
    const after = await store.readRevision();
    ownerRows?.assertHealthy();
    if (after !== observation.revision) throw new FenceConflictError(observation.revision, after);
    if (observation.fence !== undefined && observation.fence.revision !== observation.revision) {
      throw new FenceConflictError(observation.revision, observation.fence.revision);
    }
    allowed.push(verdict);
    if (verdict) grants.push(Object.freeze({ fields: grant.fields }));
  }
  return deepFreeze({ record: grants.length === 0 ? null : projectSourceRowFields(observation.row, grants, read.secretFields),
    allowed, grants });
}

export interface InstalledSourceRowDecision {
  readonly model: ModelName;
  readonly id: RecordId;
  readonly allowed: readonly boolean[];
  readonly projection: ProjectedRecord | null;
}

/** Archive inclusion applies to the selected row only, never its ancestors. */
function permitsSourceRowArchive(row: StoredRow, target: StoredRow, archived: 'exclude' | 'include' | undefined): boolean {
  return row.archivedAt === null || row === target && archived === 'include';
}

/** Internal containment join; target and every ancestor share the supplied tracked context. */
export async function projectInstalledSourceRowAndAncestors(input: {
  /** Applies only to the selected target; containing ancestors must remain live. */
  readonly archived?: 'exclude' | 'include';
  readonly model: ModelName;
  readonly row: StoredRow;
  readonly readPolicies: ReadonlyMap<ModelName, ViewerSourceReadPolicy>;
  readonly policy: PolicyTable;
  readonly context: ByContext;
  readonly revision: Revision;
  readonly fence: BaseQueryInput['fence'];
  readonly store: StoragePort;
  readonly rows: Map<string, StoredRow>;
  readonly owningObservation?: Readonly<ViewerGenerationCallbackReadObservation>;
  readonly ownerRows?: InstalledSourceOwnerRows;
}): Promise<InstalledSourceRowProjection & { readonly decisions: readonly InstalledSourceRowDecision[] }> {
  const { readPolicies, policy, context, revision, fence, store, rows } = input;
  const ownerRows = input.ownerRows === undefined ? undefined : captureInstalledSourceOwnerRows(input.ownerRows);
  const checkpoint = async () => {
    ownerRows?.assertHealthy();
    const actual = await store.readRevision();
    ownerRows?.assertHealthy();
    if (actual !== revision) throw new FenceConflictError(revision, actual);
    if (fence !== undefined && fence.revision !== revision) throw new FenceConflictError(revision, fence.revision);
  };
  ownerRows?.assertHealthy();
  const decisions: InstalledSourceRowDecision[] = [], visited = new Set<string>();
  let model = input.model, row = input.row, target: InstalledSourceRowProjection | undefined;
  const denied = () => deepFreeze({ record: null, allowed: target?.allowed ?? [], grants: target?.grants ?? [], decisions });
  while (true) {
    const key = `${model}\0${row.id}`;
    if (visited.has(key) || visited.size >= 100) invalid();
    visited.add(key);
    const read = readPolicies.get(model);
    if (read === undefined || !permitsSourceRowArchive(row, input.row, input.archived)) return denied();
    const projected = await projectSourceAncestorRow(input, model, read, policy, context, revision, fence, store, ownerRows, row);
    if (projected === null) return denied();
    ownerRows?.assertHealthy();
    if (target === undefined) target = projected;
    decisions.push({ model, id: row.id, allowed: projected.allowed, projection: projected.record });
    if (projected.record === null) return denied();
    fence?.enroll({ kind: 'record', model, id: row.id, version: row.version });
    const parent = row.parent ?? null;
    if (read.parent === undefined ? parent !== null : parent === null || parent.model !== read.parent) return denied();
    if (parent === null) return deepFreeze({ ...target, decisions });
    model = parent.model;
    const loaded = await loadSourceAncestorParent(store, ownerRows, rows, model, parent.id, revision, checkpoint);
    if (loaded === null) return denied();
    row = loaded;
    if (row.id !== parent.id) invalid();
  }
}

/** One ancestor level: installed grants or legacy policy projection (null denies). */
async function projectSourceAncestorRow(
  input: { readonly owningObservation?: Readonly<ViewerGenerationCallbackReadObservation> },
  model: ModelName,
  read: ViewerSourceReadPolicy,
  policy: PolicyTable,
  context: ByContext,
  revision: Revision,
  fence: BaseQueryInput['fence'],
  store: StoragePort,
  ownerRows: InstalledSourceOwnerRows | undefined,
  row: StoredRow,
): Promise<InstalledSourceRowProjection | null> {
  const observation = Object.freeze({ context: Object.freeze({ ...context }), row, revision, fence });
  if ('grants' in read) {
    return projectInstalledSourceRow({ read, observation, store,
      ...(input.owningObservation === undefined ? {} : { owningObservation: input.owningObservation }),
      ...(ownerRows === undefined ? {} : { ownerRows }) });
  }
  const rowPolicy = policy.get(model);
  if (rowPolicy === undefined || !(await evaluateBy(read.by, withPolicyRow(rowPolicy, context, row)))) return null;
  const legacy = await projectCurrentRecordForViewerPolicy({ policy: rowPolicy, context, row });
  return { ...legacy, grants: [] };
}

/** Tracked parent load with checkpoint fences around owner reads. */
async function loadSourceAncestorParent(
  store: StoragePort,
  ownerRows: InstalledSourceOwnerRows | undefined,
  rows: Map<string, StoredRow>,
  model: ModelName,
  id: RecordId,
  revision: Revision,
  checkpoint: () => Promise<void>,
): Promise<StoredRow | null> {
  const parentKey = `${model}\0${id}`;
  if (rows.has(parentKey)) return rows.get(parentKey)!;
  if (ownerRows !== undefined) await checkpoint();
  const loaded = ownerRows === undefined
    ? await store.cohortLoad({ model, id, expectedRevision: revision })
    : await ownerRows.read(model, id);
  if (ownerRows !== undefined) await checkpoint();
  if (loaded === null) return null;
  if (loaded.id !== id) invalid();
  rows.set(parentKey, loaded);
  return loaded;
}

export interface CurrentRecordSourcePolicyInput extends Pick<BaseQueryInput, 'context' | 'memberships' | 'policy' | 'store' | 'fence'> {
  readonly model: ModelName;
  readonly id: RecordId;
  readonly readPolicies: ReadonlyMap<ModelName, ViewerSourceReadPolicy>;
  /** Exact live observation supplied to the installed source read/WHERE.
   * Nested navigation joins its tracked Identity authority and original R. */
  readonly observation?: Readonly<ViewerGenerationCallbackReadObservation>;
}
export interface CurrentRecordSourcePolicyResult {
  readonly record: ProjectedRecord | null;
  readonly revision: Revision;
}

type SourcePolicyTransform = (result: Readonly<CurrentRecordSourcePolicyResult>, allowed: readonly boolean[],
  sourcePresence: Readonly<{ fields: readonly string[] }> | null) => unknown | Promise<unknown>;

/** Borrowed live observation: policy capture, load, project, transform. */
async function projectSourcePolicyObserved(
  input: CurrentRecordSourcePolicyInput,
  transform: SourcePolicyTransform | undefined,
): Promise<unknown> {
  const observation = input.observation!;
  return withinInstalledReadObservation(observation, { store: input.store, model: input.model, id: input.id }, async (checkpoint, loadRow, ownerRows) => {
    // Capture the full supplied policy closure while the original lifetime is
    // already leased, before any async checkpoint can change its inputs.
    const store = input.store, model = text(input.model) as ModelName, id = text(input.id) as RecordId;
    const reads = captureSourceReadPolicies(input.readPolicies), policy = new Map(input.policy);
    const { context, revision, fence } = observation;
    if (input.context.actorUserId !== context.actorUserId || input.context.teamId !== context.teamId ||
        input.memberships !== context.memberships || input.fence !== undefined && input.fence !== fence ||
        typeof store.cohortLoad !== 'function' || transform !== undefined && typeof transform !== 'function') invalid();
    await checkpoint();
    const row = await loadRow(model, id);
    await checkpoint();
    if (row !== null && row.id !== id) invalid();
    const sourcePresence = row === null ? null : deepFreeze({ fields: Object.keys(row.data) });
    fence?.enroll({ kind: 'query', model, authority: 'viewer' });
    const rows = new Map<string, StoredRow>();
    if (row !== null) rows.set(`${model}\0${id}`, row);
    const projected = row === null ? { record: null, allowed: [] } : await projectInstalledSourceRowAndAncestors({
      model, row, readPolicies: reads, policy, context, revision, fence, store, rows, owningObservation: observation,
      ...(ownerRows === undefined ? {} : { ownerRows }),
    });
    await checkpoint();
    const result = deepFreeze({ record: projected.record, revision });
    const output = transform === undefined ? result : await transform(result, projected.allowed,
      result.record === null ? null : sourcePresence);
    await checkpoint();
    return output;
  });
}

/** Fresh authority: membership, load, observe, transform, revalidate. */
async function projectSourcePolicyFresh(
  input: CurrentRecordSourcePolicyInput,
  transform: SourcePolicyTransform | undefined,
): Promise<unknown> {
  const { store, memberships, fence } = input;
  const model = text(input.model) as ModelName, id = text(input.id) as RecordId;
  const reads = captureSourceReadPolicies(input.readPolicies), policy = new Map(input.policy);
  const context = Object.freeze({ actorUserId: input.context.actorUserId === null ? null : text(input.context.actorUserId),
    teamId: input.context.teamId === null ? null : text(input.context.teamId) });
  if (typeof store.cohortLoad !== 'function' || transform !== undefined && typeof transform !== 'function') invalid();
  const revision = await store.readRevision();
  if (fence !== undefined && fence.revision !== revision) throw new FenceConflictError(fence.revision, revision);
  const row = await store.cohortLoad({ model, id, expectedRevision: revision });
  if (row !== null && row.id !== id) invalid();
  const sourcePresence = row === null ? null : deepFreeze({ fields: Object.keys(row.data) });
  const membership = context.actorUserId === null || context.teamId === null ? null :
    checkedMembershipFact(await memberships.findMembership(context.teamId, context.actorUserId), context.teamId, context.actorUserId);
  if (context.actorUserId !== null && context.teamId !== null) fence?.enroll({ kind: 'membership', teamId: context.teamId, userId: context.actorUserId });
  fence?.enroll({ kind: 'query', model, authority: 'viewer' });
  const rows = new Map<string, StoredRow>();
  if (row !== null) rows.set(`${model}\0${id}`, row);
  return finishSourcePolicyFresh(transform, { store, model, reads, policy, context, membership, memberships, fence, revision, row, sourcePresence, rows });
}

/** Observed grant projection with final transform and revision fences. */
async function finishSourcePolicyFresh(
  transform: SourcePolicyTransform | undefined,
  state: { store: StoragePort; model: ModelName; reads: ReadonlyMap<ModelName, ViewerSourceReadPolicy>;
    policy: PolicyTable;
    context: { readonly actorUserId: string | null; readonly teamId: string | null };
    membership: ReturnType<typeof checkedMembershipFact> | null; memberships: CurrentRecordSourcePolicyInput['memberships'];
    fence: BaseQueryInput['fence']; revision: Revision; row: StoredRow | null;
    sourcePresence: Readonly<{ fields: readonly string[] }> | null; rows: Map<string, StoredRow> },
): Promise<unknown> {
  const { store, fence, revision } = state;
  const authority = await observeRowGrantAuthority({ ...state.context, membership: state.membership, memberships: state.memberships }, async coherent =>
    state.row === null ? { record: null, allowed: [], grants: [], decisions: [] } : projectInstalledSourceRowAndAncestors({
      model: state.model, row: state.row, readPolicies: state.reads, policy: state.policy, context: coherent,
      revision, fence, store, rows: state.rows,
    }));
  const result = deepFreeze({ record: authority.value.record, revision });
  const output = transform === undefined ? result : await transform(result, authority.value.allowed,
    result.record === null ? null : state.sourcePresence);
  await authority.revalidate();
  const actual = await store.readRevision();
  if (actual !== revision) throw new FenceConflictError(revision, actual);
  if (fence !== undefined && fence.revision !== revision) throw new FenceConflictError(fence.revision, revision);
  return output;
}

export function projectCurrentRecordForViewerSourcePolicies(input: CurrentRecordSourcePolicyInput): Promise<CurrentRecordSourcePolicyResult>;
export function projectCurrentRecordForViewerSourcePolicies<Result>(input: CurrentRecordSourcePolicyInput,
  transform: (result: Readonly<CurrentRecordSourcePolicyResult>, allowed: readonly boolean[],
    sourcePresence: Readonly<{ fields: readonly string[] }> | null) => Result | Promise<Result>): Promise<Result>;
/** Reader-owned current load and final checks. Installed source navigation can
 * borrow its actual live observation; independent reads open their own authority.
 * The trusted transform alone receives immutable field presence from that same
 * loaded row, so a staged parent needs no second committed load. Names grant no
 * field values or row authority; denied projections receive no presence. */
export async function projectCurrentRecordForViewerSourcePolicies(input: CurrentRecordSourcePolicyInput,
  transform?: (result: Readonly<CurrentRecordSourcePolicyResult>, allowed: readonly boolean[],
    sourcePresence: Readonly<{ fields: readonly string[] }> | null) => unknown | Promise<unknown>): Promise<unknown> {
  if (input.observation !== undefined) return projectSourcePolicyObserved(input, transform);
  return projectSourcePolicyFresh(input, transform);
}

/** Private source-expression input, never a request or an independent read
 * capability. The actual live observation selects policy-control authority. */
export interface SourceObservationRecordsInput {
  readonly observation: Readonly<ViewerGenerationCallbackReadObservation>;
  readonly store: StoragePort;
  readonly model: ModelName;
  readonly id?: RecordId;
  readonly parent?: Readonly<{ model: ModelName; id: RecordId }>;
  readonly readPolicies: ReadonlyMap<ModelName, ViewerSourceReadPolicy>;
  readonly policy: PolicyTable;
}
export interface SourceObservationRecord {
  readonly record: ProjectedRecord;
  readonly sourcePresence: readonly string[];
}

/** Shared source-observation scan (one candidate domain). */
interface SourceObservationScan {
  readonly input: SourceObservationRecordsInput;
  readonly model: ModelName;
  readonly id: RecordId | undefined;
  readonly parent: Readonly<{ model: ModelName; id: RecordId }> | undefined;
  readonly read: ViewerSourceReadPolicy;
  readonly control: boolean;
  readonly ownerRows: InstalledSourceOwnerRows | undefined;
  readonly reads: ReadonlyMap<ModelName, ViewerSourceReadPolicy>;
  readonly policy: PolicyTable;
  readonly store: StoragePort;
  readonly rows: Map<string, StoredRow>;
  readonly result: SourceObservationRecord[];
  readonly checkpoint: () => Promise<void>;
}

/** One candidate in domain order: project, enroll, checkpoint. */
async function projectSourceObservationRow(scan: SourceObservationScan, row: StoredRow): Promise<void> {
  const { input, model, id, parent, read, control, ownerRows, reads, policy, store, rows, result, checkpoint } = scan;
  const { observation } = input;
  if (id !== undefined && row.id !== id) invalid();
  if (row.archivedAt !== null || parent !== undefined && (row.parent?.model !== parent.model || row.parent.id !== parent.id)) return;
  const projected = control
    ? 'grants' in read ? projectSourceRowFields(row, [{ fields: read.fields }], read.secretFields) : null
    : (await projectInstalledSourceRowAndAncestors({ model, row, readPolicies: reads, policy, context: observation.context,
      revision: observation.revision, fence: observation.fence, store, rows, owningObservation: observation,
      ...(ownerRows === undefined ? {} : { ownerRows }) })).record;
  if (projected !== null) {
    observation.fence?.enroll({ kind: 'record', model, id: row.id, version: row.version });
    result.push(deepFreeze({ record: projected, sourcePresence: Object.keys(row.data) }));
  }
  await checkpoint();
}

/** Borrow one installed decision's original store, Identity context and R.
 * Viewer expressions receive current policy-projected values before any source
 * filtering/counting. Original installed policy predicates may inspect their
 * same-owner decision inputs without recursively requiring the policy they are
 * deciding; those values remain confined to that bool-returning lifetime. */
export async function readRecordsAtSourceObservation(input: SourceObservationRecordsInput): Promise<readonly SourceObservationRecord[]> {
  const { observation, store } = input;
  const model = text(input.model) as ModelName;
  const id = input.id === undefined ? undefined : text(input.id) as RecordId;
  const parent = input.parent === undefined ? undefined : Object.freeze({ model: text(input.parent.model) as ModelName, id: text(input.parent.id) as RecordId });
  return withinInstalledSourceReadQuery(observation, { store, model }, async (checkpoint, loadRow, ownerRows, control) => {
    const reads = captureSourceReadPolicies(input.readPolicies), policy = new Map(input.policy), read = reads.get(model);
    if (read === undefined) invalid();
    const policyDomain = control ? ownerRows?.policyQuery : undefined;
    if (parent !== undefined && read.parent !== parent.model) invalid();
    if (ownerRows !== undefined && id === undefined && policyDomain === undefined && ownerRows.query === undefined) {
      throw new StateError('validation', 'Source collection needs its original committed query domain.');
    }
    await checkpoint();
    const single = id === undefined ? undefined : await loadRow(model, id);
    const candidates = id === undefined ? policyDomain !== undefined ? await policyDomain(model, parent) :
      ownerRows !== undefined ? await ownerRows.query!(model, parent) :
      await store.query({ model, authority: 'viewer', order: [{ field: 'id', direction: 'asc' }], archived: 'exclude',
        ...(parent === undefined ? {} : { parent }) }) : single === null ? [] : [single!];
    await checkpoint();
    const rows = new Map<string, StoredRow>();
    for (const row of candidates) rows.set(`${model}\0${row.id}`, row);
    const result: SourceObservationRecord[] = [];
    const scan = { input, model, id, parent, read, control, ownerRows, reads, policy, store, rows, result, checkpoint };
    for (const row of candidates) {
      await projectSourceObservationRow(scan, row);
    }
    observation.fence?.enroll({ kind: 'query', model, authority: 'viewer' });
    await checkpoint();
    return Object.freeze(result);
  });
}
