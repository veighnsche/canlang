/** Installed ordinary source policies share the actual State row, Identity and checkpoint observation. */
import type { ModelName, ProjectedRecord, RecordId, Revision, StoragePort, StoredRow } from '@canlang/contracts';
import { StateError } from '../errors.js';
import { deepFreeze } from '../internal/own-data.js';
import { jsonClone } from '../internal/json.js';
import { checkedMembershipFact, observeRowGrantAuthority } from '../policy/membership-facts.js';
import { isEqualOrUnder, isMetadataPath, withPolicyRow, type ByContext, type PolicyTable } from '../policy/grants.js';
import { evaluateBy, validateByPredicate } from '../policy/roles.js';
import { FenceConflictError } from '../storage/port.js';
import { evaluateInstalledReadPolicy } from '../receipt/read-policy-membership.js';
import { projectCurrentRecordForViewerPolicy, projectSourceRowFields,
  type BaseQueryInput, type ViewerPageParentPolicy } from './engine.js';

export interface ViewerGenerationCallbackReadObservation {
  readonly context: ByContext;
  readonly row: StoredRow;
  readonly revision: Revision;
  readonly fence: BaseQueryInput['fence'];
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
}): Promise<InstalledSourceRowProjection> {
  const { read, observation, store } = input;
  const allowed: boolean[] = [], grants: { readonly fields: readonly string[] }[] = [];
  for (const grant of read.grants) {
    const before = await store.readRevision();
    if (before !== observation.revision) throw new FenceConflictError(observation.revision, before);
    const verdict = await evaluateInstalledReadPolicy(grant.read, observation, store);
    if (typeof verdict !== 'boolean') invalid();
    const after = await store.readRevision();
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

/** Internal containment join; target and every ancestor share the supplied tracked context. */
export async function projectInstalledSourceRowAndAncestors(input: {
  readonly model: ModelName;
  readonly row: StoredRow;
  readonly readPolicies: ReadonlyMap<ModelName, ViewerSourceReadPolicy>;
  readonly policy: PolicyTable;
  readonly context: ByContext;
  readonly revision: Revision;
  readonly fence: BaseQueryInput['fence'];
  readonly store: StoragePort;
  readonly rows: Map<string, StoredRow>;
}): Promise<InstalledSourceRowProjection & { readonly decisions: readonly InstalledSourceRowDecision[] }> {
  const { readPolicies, policy, context, revision, fence, store, rows } = input;
  const decisions: InstalledSourceRowDecision[] = [], visited = new Set<string>();
  let model = input.model, row = input.row, target: InstalledSourceRowProjection | undefined;
  const denied = () => deepFreeze({ record: null, allowed: target?.allowed ?? [], grants: target?.grants ?? [], decisions });
  while (true) {
    const key = `${model}\0${row.id}`;
    if (visited.has(key) || visited.size >= 100) invalid();
    visited.add(key);
    const read = readPolicies.get(model);
    if (read === undefined || row.archivedAt !== null) return denied();
    const observation = Object.freeze({ context: Object.freeze({ ...context }), row, revision, fence });
    let projected: InstalledSourceRowProjection;
    if ('grants' in read) projected = await projectInstalledSourceRow({ read, observation, store });
    else {
      const rowPolicy = policy.get(model);
      if (rowPolicy === undefined || !(await evaluateBy(read.by, withPolicyRow(rowPolicy, context, row)))) return denied();
      const legacy = await projectCurrentRecordForViewerPolicy({ policy: rowPolicy, context, row });
      projected = { ...legacy, grants: [] };
    }
    if (target === undefined) target = projected;
    decisions.push({ model, id: row.id, allowed: projected.allowed, projection: projected.record });
    if (projected.record === null) return denied();
    fence?.enroll({ kind: 'record', model, id: row.id, version: row.version });
    const parent = row.parent ?? null;
    if (read.parent === undefined ? parent !== null : parent === null || parent.model !== read.parent) return denied();
    if (parent === null) return deepFreeze({ ...target, decisions });
    model = parent.model;
    const parentKey = `${model}\0${parent.id}`;
    if (!rows.has(parentKey)) {
      const loaded = await store.cohortLoad({ model, id: parent.id, expectedRevision: revision });
      if (loaded === null) return denied();
      if (loaded.id !== parent.id) invalid();
      rows.set(parentKey, loaded);
    }
    row = rows.get(parentKey)!;
    if (row.id !== parent.id) invalid();
  }
}

export interface CurrentRecordSourcePolicyInput extends Pick<BaseQueryInput, 'context' | 'memberships' | 'policy' | 'store' | 'fence'> {
  readonly model: ModelName;
  readonly id: RecordId;
  readonly readPolicies: ReadonlyMap<ModelName, ViewerSourceReadPolicy>;
}
export interface CurrentRecordSourcePolicyResult {
  readonly record: ProjectedRecord | null;
  readonly revision: Revision;
}

export function projectCurrentRecordForViewerSourcePolicies(input: CurrentRecordSourcePolicyInput): Promise<CurrentRecordSourcePolicyResult>;
export function projectCurrentRecordForViewerSourcePolicies<Result>(input: CurrentRecordSourcePolicyInput,
  transform: (result: Readonly<CurrentRecordSourcePolicyResult>, allowed: readonly boolean[]) => Result | Promise<Result>): Promise<Result>;
/** Reader-owned current load and final checks; callers supply neither raw rows nor a live observation. */
export async function projectCurrentRecordForViewerSourcePolicies(input: CurrentRecordSourcePolicyInput,
  transform?: (result: Readonly<CurrentRecordSourcePolicyResult>, allowed: readonly boolean[]) => unknown | Promise<unknown>): Promise<unknown> {
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
  const membership = context.actorUserId === null || context.teamId === null ? null :
    checkedMembershipFact(await memberships.findMembership(context.teamId, context.actorUserId), context.teamId, context.actorUserId);
  if (context.actorUserId !== null && context.teamId !== null) fence?.enroll({ kind: 'membership', teamId: context.teamId, userId: context.actorUserId });
  fence?.enroll({ kind: 'query', model, authority: 'viewer' });
  const rows = new Map<string, StoredRow>();
  if (row !== null) rows.set(`${model}\0${id}`, row);
  const authority = await observeRowGrantAuthority({ ...context, membership, memberships }, async coherent =>
    row === null ? { record: null, allowed: [], grants: [], decisions: [] } : projectInstalledSourceRowAndAncestors({
      model, row, readPolicies: reads, policy, context: coherent, revision, fence, store, rows,
    }));
  const result = deepFreeze({ record: authority.value.record, revision });
  const output = transform === undefined ? result : await transform(result, authority.value.allowed);
  await authority.revalidate();
  const actual = await store.readRevision();
  if (actual !== revision) throw new FenceConflictError(revision, actual);
  if (fence !== undefined && fence.revision !== revision) throw new FenceConflictError(fence.revision, revision);
  return output;
}
