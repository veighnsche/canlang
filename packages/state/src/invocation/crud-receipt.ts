/** Retained CRUD projection using original receipt data and current viewer authority. */
import type { ModelName, Membership, ProjectedRecord, Receipt, ReceiptOutcome, RecordId, RecordVersion, StoragePort, StoredRow } from '@canlang/contracts';
import type { ResolvedIdentity } from '@canlang/contracts';
import type { OperationRegistry } from './registry.js';
import { isGeneratedOperationDef } from './registry.js';
import type { MembershipReader } from '../policy/roles.js';
import { evaluateBy } from '../policy/roles.js';
import { observeRowGrantAuthority } from '../policy/membership-facts.js';
import type { PolicyTable } from '../policy/grants.js';
import { projectSavedRecordForViewer, projectSourceRowFields } from '../query/engine.js';
import { captureSourceReadPolicies, projectInstalledSourceRowAndAncestors, type ViewerSourceReadPolicy } from '../query/source-policy.js';
import { StateError } from '../errors.js';
import { FenceConflictError } from '../storage/port.js';
/** Execution-owned association retained in the existing receipt outcome JSON. */
export interface GeneratedCrudReceiptAssociation {
  readonly kind: 'generated-crud/v1';
  readonly model: ModelName;
  readonly record: { readonly id: RecordId; readonly version: RecordVersion } | null;
  readonly secretFields?: readonly string[];
}

/** Legacy outcomes have no association; recognized malformed metadata refuses. */
export function readGeneratedCrudAssociation(outcome: ReceiptOutcome): GeneratedCrudReceiptAssociation | null {
  if (!Object.hasOwn(outcome, 'generatedCrud')) return null;
  const value = savedDataMember(outcome, 'generatedCrud');
  const object = (candidate: unknown): candidate is Record<string, unknown> =>
    typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
  const invalid = (): never => { throw new Error('Invalid generated CRUD receipt association.'); };
  const model = savedDataMember(value, 'model'), record = savedDataMember(value, 'record');
  if (outcome.status !== 'committed' || !object(value) ||
      savedDataMember(value, 'kind') !== 'generated-crud/v1' ||
      typeof model !== 'string' || model === '' || record === undefined) return invalid();
  const id = savedDataMember(record, 'id'), version = savedDataMember(record, 'version');
  if (record !== null && (!object(record) ||
      Object.keys(record).length !== 2 || typeof id !== 'string' || id === '' ||
      typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1)) return invalid();
  if (Object.keys(value).some(key => !['kind', 'model', 'record', 'secretFields'].includes(key))) return invalid();
  let fields: string[] | undefined;
  if (Object.hasOwn(value, 'secretFields')) {
    const source = savedDataMember(value, 'secretFields');
    if (!Array.isArray(source)) return invalid();
    fields = [];
    for (let index = 0; index < source.length; index += 1) {
      const slot = Object.getOwnPropertyDescriptor(source, String(index));
      if (slot === undefined || !('value' in slot) || typeof slot.value !== 'string' ||
          slot.value.split('.').some((part: string) => part === '')) return invalid();
      fields.push(slot.value);
    }
  }
  return {
    kind: 'generated-crud/v1', model: model as ModelName,
    record: record === null ? null : { id: id as RecordId, version: version as RecordVersion },
    ...(fields === undefined ? {} : { secretFields: fields }),
  };
}

/** Public disclosure of an execution-associated CRUD outcome; never admission. */
export interface ProjectGeneratedCrudReceiptInput {
  readonly receipt: Receipt;
  readonly registry: OperationRegistry;
  readonly policy: PolicyTable;
  /** Fresh verified model/ancestor source policies from the owning host.
   * Absence preserves the existing static-policy projection. */
  readonly sourceReadPolicies?: ReadonlyMap<ModelName, ViewerSourceReadPolicy>;
  readonly app: string;
  readonly identity: ResolvedIdentity;
  /** The host's already selected owning store, also used by the mutation. */
  readonly store: StoragePort;
  readonly memberships: MembershipReader;
}

/** Read a known envelope member without invoking a caller-supplied accessor. */
function savedDataMember(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const member = Object.getOwnPropertyDescriptor(value, key);
  return member !== undefined && 'value' in member ? member.value : undefined;
}

function savedCrudRow(value: unknown): value is StoredRow {
  const id = savedDataMember(value, 'id'), version = savedDataMember(value, 'version');
  const created = savedDataMember(value, 'created'), updated = savedDataMember(value, 'updated');
  const archived = savedDataMember(value, 'archivedAt'), data = savedDataMember(value, 'data');
  const parent = savedDataMember(value, 'parent');
  if (typeof value !== 'object' || value === null ||
      (Object.hasOwn(value, 'parent') && !('value' in Object.getOwnPropertyDescriptor(value, 'parent')!))) return false;
  return typeof id === 'string' && id !== '' && typeof version === 'number' &&
    Number.isSafeInteger(version) && version >= 1 &&
    typeof created === 'number' && Number.isFinite(created) &&
    typeof updated === 'number' && Number.isFinite(updated) &&
    typeof savedDataMember(value, 'createdBy') === 'string' &&
    typeof savedDataMember(value, 'updatedBy') === 'string' &&
    (archived === null || (typeof archived === 'number' && Number.isFinite(archived))) &&
    typeof data === 'object' && data !== null && !Array.isArray(data) &&
    (parent === undefined || parent === null ||
      (typeof savedDataMember(parent, 'model') === 'string' && typeof savedDataMember(parent, 'id') === 'string'));
}

/**
 * Finite CRUD-only boundary. Current authority chooses masks; all disclosed
 * values and metadata come from the receipt. The source path keeps one actual
 * owning-store checkpoint for the current target, ancestors and Identity.
 */
export async function projectGeneratedCrudReceipt(
  input: ProjectGeneratedCrudReceiptInput,
): Promise<{ readonly result: null; readonly records: ReadonlyArray<ProjectedRecord> }> {
  const invalid = (message: string): never => { throw new StateError('validation', message); };
  // Capture the original selectors before any asynchronous read can change
  // them. Callback decisions remain live; the map supplies no row authority.
  const sourceReadPolicies = input.sourceReadPolicies === undefined ? undefined : captureSourceReadPolicies(input.sourceReadPolicies);
  const sourcePolicy = sourceReadPolicies === undefined ? undefined : new Map(input.policy);
  const { receipt } = input;
  const actorUserId = input.identity.actor?.user_id ?? null;
  const teamId = input.identity.team?.team_id ?? null;
  if (receipt.identity.app !== input.app || receipt.identity.owner !== (teamId ?? 'app') ||
      receipt.identity.principal !== (actorUserId ?? 'public')) {
    throw new StateError('forbidden', 'Saved mutation scope does not match the caller.');
  }
  if (receipt.outcome.status !== 'committed') return invalid('Saved mutation is not a committed CRUD outcome.');
  let association: GeneratedCrudReceiptAssociation | null;
  try { association = readGeneratedCrudAssociation(receipt.outcome); }
  catch { return invalid('Invalid generated CRUD receipt association.'); }
  if (association === null) return invalid('Saved mutation has no supported execution association.');
  if (association.secretFields === undefined) return invalid('Saved CRUD outcome has no original secret metadata.');
  const def = input.registry.get(receipt.identity.operation);
  if (def === undefined || !isGeneratedOperationDef(def) || def.name !== receipt.identity.operation ||
      def.descriptor.name !== receipt.identity.operation) return invalid('Saved CRUD operation has no matching checked declaration.');
  const kind = def.descriptor.kind;
  const target = def.descriptor.inputs.find(field => field.name === 'record' && field.kind === 'ref' && field.versioned);
  const model = kind === 'create' && def.descriptor.name.endsWith('.create')
    ? def.descriptor.name.slice(0, -'.create'.length)
    : kind === 'update' || kind === 'delete'
      ? target?.kind === 'ref' ? target.model : undefined
      : undefined;
  if (model !== association.model) return invalid('Saved CRUD association disagrees with the checked operation model.');
  const saved = receipt.outcome.result;
  if (association.record === null) {
    // Removal has no surviving target. Other genuine writes, including Work
    // source/handler receipts, still retain their versions in the same fence.
    // They do not enter this target-only disclosure projection.
    if (kind !== 'delete' || saved !== null) {
      return invalid('Saved CRUD removal disagrees with its committed outcome.');
    }
  } else if (!savedCrudRow(saved) || saved.id !== association.record.id ||
      saved.version !== association.record.version || !receipt.outcome.recordVersions.some(record =>
        record.model === association.model && record.id === association.record!.id &&
        record.version === association.record!.version)) {
    return invalid('Saved CRUD row disagrees with its committed record identity.');
  }
  const revision = await input.store.readRevision();
  const readMembership = () => actorUserId !== null && teamId !== null
    ? input.memberships.findMembership(teamId, actorUserId) : Promise.resolve(null);
  const membership = await readMembership();
  const membershipSnapshot = JSON.stringify(membership);
  const project = async (live: Membership | null): Promise<ReadonlyArray<ProjectedRecord>> => {
    const context = { actorUserId, teamId, membership: live, memberships: input.memberships };
    if (sourceReadPolicies !== undefined) {
      try {
        const authority = await observeRowGrantAuthority(context, async coherent => {
          if (!await evaluateBy(def.by, coherent) || association.record === null) return [];
          const current = await input.store.cohortLoad({ model: association.model, id: association.record.id, expectedRevision: revision });
          if (current === null || current.id !== association.record.id || current.archivedAt !== null ||
              current.version < association.record.version || !savedCrudRow(saved) ||
              current.created !== saved.created || current.createdBy !== saved.createdBy ||
              (current.parent?.model ?? null) !== (saved.parent?.model ?? null) ||
              (current.parent?.id ?? null) !== (saved.parent?.id ?? null)) return [];
          const read = sourceReadPolicies.get(association.model);
          if (read === undefined) return [];
          const source = await projectInstalledSourceRowAndAncestors({ model: association.model, row: current,
            readPolicies: sourceReadPolicies, policy: sourcePolicy!, context: coherent, revision, fence: undefined,
            store: input.store, rows: new Map([[`${association.model}\0${current.id}`, current]]) });
          if (source.record === null) return [];
          // Current rules choose the mask; the response retains only the
          // original receipt image and both original/current secret census.
          const projected = 'grants' in read ? projectSourceRowFields(saved, source.grants,
            [...association.secretFields!, ...read.secretFields, ...(sourcePolicy!.get(association.model)?.secretFields ?? [])])
            : await projectSavedRecordForViewer({ policy: sourcePolicy!.get(association.model), context: coherent,
              current, saved, originalSecretFields: association.secretFields!, coherentContext: true });
          return projected === null ? [] : [projected];
        });
        await authority.revalidate();
        return authority.value;
      } catch (error) {
        if (error instanceof FenceConflictError || error instanceof StateError && error.code === 'forbidden') return [];
        throw error;
      }
    }
    if (!await evaluateBy(def.by, context) || association.record === null) return [];
    const current = await input.store.load(association.model, association.record.id);
    // Versions may advance; a different parent or an older generation cannot
    // establish disclosure of this receipt's original row.
    if (current === null || current.id !== association.record.id || current.archivedAt !== null ||
        current.version < association.record.version || !savedCrudRow(saved) ||
        (current.parent?.model ?? null) !== (saved.parent?.model ?? null) ||
        (current.parent?.id ?? null) !== (saved.parent?.id ?? null)) return [];
    const projected = await projectSavedRecordForViewer({
      policy: input.policy.get(association.model), context, current, saved,
      originalSecretFields: association.secretFields!,
    });
    return projected === null ? [] : [projected];
  };
  const withheld = { result: null, records: [] } as const;
  const records = await project(membership);
  if (await input.store.readRevision() !== revision) return withheld;
  const live = await readMembership();
  if (JSON.stringify(live) !== membershipSnapshot || JSON.stringify(await project(live)) !== JSON.stringify(records)) {
    return withheld;
  }
  if (await input.store.readRevision() !== revision) return withheld;
  return { result: null, records };
}
