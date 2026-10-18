/** Current committed File relationships, independent of Files' attachment marker.
 * A relationship is retention evidence; only a current whole-field State grant
 * authorizes the wrapped read. Physical byte validity remains Files-owned. */
import type { ArtifactModel, CanonicalModelDescriptor, CanonicalValueTypes, FinalizedFileReceiver,
  ModelName, RecordId, RecordVersion, Revision, StoragePort, StoredRow } from '@canlang/contracts';
import { assertSafeBlobKey } from '@canlang/files/ports';
import { normalizeValueTypes, type NormalizedSchema } from '@canlang/values';
import { StateError } from '../errors.js';
import { deepFreeze } from '../internal/own-data.js';
import { copyScenarioFileData } from '../invocation/scenario-file-assignment.js';
import { bindFileReferenceProfile, fileReferenceOccurrences, type FileReferenceProfile } from './file-reference-profile.js';
import { isGeneratedOperationDef, type GeneratedOperationDef, type OperationRegistry } from '../invocation/registry.js';
import { openFenceScope } from '../invocation/admission.js';
import { stableStringify } from '../invocation/replay.js';
import { evalPredicateForRow, isEqualOrUnder, type InterimModelPolicy, type PolicyTable, type ByContext } from '../policy/grants.js';
import { observeRowGrantAuthority } from '../policy/membership-facts.js';
import { evaluateBy, type MembershipReader } from '../policy/roles.js';
import { projectCurrentRecordForViewerPolicy } from '../query/engine.js';

export interface CommittedFileReference {
  readonly model: ModelName;
  readonly recordId: RecordId;
  readonly rowVersion: RecordVersion;
  readonly field: string;
  /** Arrays retain every authored position, including duplicate references. */
  readonly index: number | null;
  /** Relative canonical wire path preserves nested fields and array positions. */
  readonly path: readonly (string | number)[];
  readonly ref: string;
  readonly archived: boolean;
}
export interface CurrentFileSlot {
  readonly model: ModelName;
  readonly recordId: RecordId;
  readonly rowVersion: RecordVersion;
  readonly field: string;
  readonly ref: string;
}
export interface FileSlotLocator {
  readonly model: ModelName;
  readonly recordId: RecordId;
  readonly field: string;
  readonly ref: string;
}
export interface CommittedFileReferences {
  readonly scope: Readonly<Omit<FinalizedFileReceiver, 'principal'>>;
  readonly complete: true;
  readonly revision: Revision;
  readonly references: readonly CommittedFileReference[];
  /** Checks the ORIGINAL State checkpoint. It is no cross-store lock. */
  revalidate(): Promise<void>;
}
export interface FileReferenceConsumer {
  /** Complete committed relationships, including archived rows until disposal.
   * Trusted retention wiring only; this inventory grants no disclosure. */
  observeReferences(ref: string): Promise<CommittedFileReferences>;
  /** Run the owning physical reader once within current State authority. Null
   * hides absent/withheld slots; drift refuses after the awaited read. */
  read(locator: FileSlotLocator, caller: FinalizedFileReceiver,
    consume: (slot: Readonly<CurrentFileSlot>) => Uint8Array | null | Promise<Uint8Array | null>): Promise<Uint8Array | null>;
}
export interface FileReferenceConsumerInput {
  /** Trusted host routing to this exact app/team/owner's State store. */
  readonly scope: Omit<FinalizedFileReceiver, 'principal'>;
  readonly store: StoragePort;
  readonly policy: PolicyTable;
  readonly memberships: MembershipReader;
  readonly canonicalModels: readonly CanonicalModelDescriptor[];
  readonly artifactModels: readonly ArtifactModel[];
  /** The same loaded declaration inventory, including nested contract fields. */
  readonly valueTypes?: CanonicalValueTypes;
  readonly registry: OperationRegistry;
  readonly maxRows: number;
  readonly maxReferences: number;
}
const invalid = (message: string): never => { throw new StateError('validation', `File references: ${message}`); };
const busy = (): never => { throw new StateError('busy', 'Complete File reference inventory exceeds its bound.'); };
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function fileRef(value: unknown): string {
  if (!text(value)) return invalid('nonempty File reference required.');
  try { assertSafeBlobKey(value); } catch { return invalid('safe File reference required.'); }
  return value;
}
function row(value: StoredRow): StoredRow {
  const saved = copyScenarioFileData(value) as StoredRow;
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved) || !text(saved.id) || !Number.isSafeInteger(saved.version) || saved.version < 1 ||
      !Number.isFinite(saved.created) || !Number.isFinite(saved.updated) ||
      !text(saved.createdBy) || !text(saved.updatedBy) ||
      saved.archivedAt !== null && !Number.isFinite(saved.archivedAt) ||
      typeof saved.data !== 'object' || saved.data === null || Array.isArray(saved.data) ||
      saved.parent != null && (!text(saved.parent.model) || !text(saved.parent.id))) {
    return invalid('actual committed row required.');
  }
  return deepFreeze(saved);
}
interface ModelFiles {
  readonly fields: ReadonlyMap<string, FileReferenceProfile>;
  readonly artifact: ArtifactModel;
}

interface ReadParent {
  readonly model: ModelName;
  readonly row: StoredRow;
  readonly def: GeneratedOperationDef;
}

function bindConsumerFields(
  canonical: CanonicalModelDescriptor,
  artifact: ArtifactModel,
  artifactModels: ReadonlyMap<ModelName, ArtifactModel>,
  canonicalModels: readonly CanonicalModelDescriptor[],
  valueSchema: NormalizedSchema | undefined,
): Map<string, FileReferenceProfile> {
  const fields = new Map<string, FileReferenceProfile>();
  for (const name of Object.keys(canonical.fields)) {
    const authored = artifact.fields.filter(candidate => candidate.name === name);
    if (authored.length !== 1) return invalid('complete owning field correspondence required.');
    const profile = bindFileReferenceProfile({ artifactModels, canonicalModels,
      ...(valueSchema === undefined ? {} : { valueSchema }) }, canonical.name, name);
    if (profile.fileBearing) fields.set(name, profile);
  }
  return fields;
}

function bindConsumerModels(
  canonicalModels: readonly CanonicalModelDescriptor[],
  artifactModels: ReadonlyMap<ModelName, ArtifactModel>,
  valueSchema: NormalizedSchema | undefined,
): Map<ModelName, ModelFiles> {
  const declared = new Set<ModelName>();
  const models = new Map<ModelName, ModelFiles>();
  for (const canonical of canonicalModels) {
    const artifact = artifactModels.get(canonical.name);
    if (artifact === undefined || declared.has(canonical.name)) {
      return invalid('complete unique same-load owning models required.');
    }
    if (artifact.fields.length !== Object.keys(canonical.fields).length) {
      return invalid('complete owning field correspondence required.');
    }
    declared.add(canonical.name);
    models.set(canonical.name, { fields: bindConsumerFields(canonical, artifact,
      artifactModels, canonicalModels, valueSchema), artifact });
  }
  return models;
}

function checkReadParties(
  locator: FileSlotLocator,
  caller: FinalizedFileReceiver,
  scope: Omit<FinalizedFileReceiver, 'principal'>,
  consume: unknown,
): boolean {
  return typeof locator === 'object' && locator !== null && !Array.isArray(locator) &&
    typeof caller === 'object' && caller !== null && !Array.isArray(caller) &&
    Object.keys(locator).length === 4 && !!text(locator.model) && !!text(locator.recordId) && !!text(locator.field) &&
    Object.keys(caller).length === 4 && !!text(caller.principal) && caller.app === scope.app &&
    caller.team === scope.team && caller.owner === scope.owner && typeof consume === 'function';
}

async function climbReadParents(
  store: StoragePort,
  models: ReadonlyMap<ModelName, ModelFiles>,
  readDef: (model: ModelName) => GeneratedOperationDef | null,
  locator: FileSlotLocator,
  original: StoredRow,
  definition: ModelFiles,
): Promise<ReadParent[] | null> {
  const parents: ReadParent[] = [];
  let selected = original, selectedDefinition = definition;
  const visited = new Set<ModelName>([locator.model]);
  while (selectedDefinition.artifact.parent !== undefined || selected.parent != null) {
    const parent = selected.parent, model = selectedDefinition.artifact.parent as ModelName | undefined;
    if (model === undefined || parent == null || parent.model !== model || visited.has(model) || parents.length >= 32) return null;
    const parentDefinition = models.get(model), parentDef = readDef(model);
    if (parentDefinition === undefined || parentDef === null) return null;
    const loadedParent = await store.load(model, parent.id);
    if (loadedParent === null) return null;
    selected = row(loadedParent); selectedDefinition = parentDefinition;
    if (selected.id !== parent.id || selected.archivedAt !== null) return null;
    parents.push({ model, row: selected, def: parentDef }); visited.add(model);
  }
  return parents;
}

function readAuthorityPredicate(
  parents: readonly ReadParent[],
  policies: ReadonlyMap<ModelName, InterimModelPolicy | undefined>,
  locator: FileSlotLocator,
  def: GeneratedOperationDef,
  original: StoredRow,
  wire: unknown,
): (current: ByContext) => Promise<boolean> {
  return async current => {
    for (const parent of parents) {
      if (!await evaluateBy(parent.def.by, current) ||
          (await projectCurrentRecordForViewerPolicy({ policy: policies.get(parent.model), context: current, row: parent.row })).record === null) return false;
    }
    const policy = policies.get(locator.model);
    if (policy === undefined || policy.secretFields.some(secret =>
      isEqualOrUnder(secret, locator.field) || isEqualOrUnder(locator.field, secret)) || !await evaluateBy(def.by, current)) return false;
    const projected = await projectCurrentRecordForViewerPolicy({ policy, context: current, row: original });
    return projected.record !== null && projected.allowed.some((allowed, index) =>
      allowed && policy.grants[index]!.fields.includes(locator.field) &&
      (policy.grants[index]!.when === undefined || evalPredicateForRow(policy.grants[index]!.when!, original))) &&
      stableStringify(projected.record.data[locator.field]) === stableStringify(wire);
  };
}

interface ReadSlotBindings {
  readonly locator: FileSlotLocator;
  readonly def: GeneratedOperationDef;
  readonly parents: readonly ReadParent[];
  readonly policies: ReadonlyMap<ModelName, InterimModelPolicy | undefined>;
  readonly original: StoredRow;
  readonly revision: Revision;
  readonly authority: { readonly revalidate: () => Promise<void> };
}

function makeReadRevalidator(
  bindings: ReadSlotBindings,
  checkInventory: () => void,
  assertRevision: (revision: Revision) => Promise<void>,
  readDef: (model: ModelName) => GeneratedOperationDef | null,
  policy: PolicyTable,
  store: StoragePort,
): { readonly checkBindings: () => void; readonly revalidate: () => Promise<void> } {
  const checkBindings = () => {
    checkInventory();
    if ([{ model: bindings.locator.model, def: bindings.def }, ...bindings.parents].some(entry => readDef(entry.model) !== entry.def) ||
        [...bindings.policies].some(([model, captured]) => policy.get(model) !== captured)) {
      throw new StateError('forbidden', 'Current File slot operation or policy changed.');
    }
  };
  const revalidate = async () => {
    checkBindings();
    for (const entry of [{ model: bindings.locator.model, row: bindings.original, def: bindings.def }, ...bindings.parents]) {
      const current = await store.load(entry.model, entry.row.id);
      if (readDef(entry.model) !== entry.def || current === null || stableStringify(row(current)) !== stableStringify(entry.row)) {
        throw new StateError('forbidden', 'Current File slot or owning row lifetime changed.');
      }
    }
    await bindings.authority.revalidate();
    await assertRevision(bindings.revision);
    checkBindings();
  };
  return { checkBindings, revalidate };
}

function checkConsumerScope(input: FileReferenceConsumerInput): FileReferenceConsumerInput['scope'] {
  const scope = deepFreeze(copyScenarioFileData(input.scope) as FileReferenceConsumerInput['scope']);
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope) ||
      Object.keys(scope).length !== 3 || !text(scope.app) || !text(scope.team) || !text(scope.owner)) {
    return invalid('exact receiving app/team/owner required.');
  }
  return scope;
}

function indexConsumerArtifacts(
  artifacts: readonly ArtifactModel[],
  canonicalModels: readonly CanonicalModelDescriptor[],
): Map<ModelName, ArtifactModel> {
  if (canonicalModels.length !== artifacts.length || artifacts.length > 200) {
    return invalid('complete same-load owning models required.');
  }
  const artifactModels = new Map<ModelName, ArtifactModel>();
  for (const artifact of artifacts) {
    if (!text(artifact.name) || artifactModels.has(artifact.name as ModelName)) return invalid('unique owning models required.');
    artifactModels.set(artifact.name as ModelName, artifact);
  }
  return artifactModels;
}

function loadConsumerValueSchema(
  valueTypes: CanonicalValueTypes | undefined,
  canonicalModels: readonly CanonicalModelDescriptor[],
): NormalizedSchema | undefined {
  try {
    return valueTypes === undefined ? undefined :
      normalizeValueTypes(valueTypes, canonicalModels.map(model => model.name)).valueSchema;
  } catch {
    return invalid('complete same-load value declarations required.');
  }
}

/** Installed State-only consumer. Caller JSON never selects an owner store,
 * substitutes declarations, supplies grants or mints a retained observation. */
export function createFileReferenceConsumer(input: FileReferenceConsumerInput): FileReferenceConsumer {
  const { store, policy, memberships, registry, maxRows, maxReferences } = input;
  const scope = checkConsumerScope(input);
  for (const bound of [maxRows, maxReferences]) {
    if (!Number.isSafeInteger(bound) || bound < 1 || bound > 20_000) return invalid('finite positive bounds required.');
  }
  const canonicalModels = deepFreeze(copyScenarioFileData(input.canonicalModels) as readonly CanonicalModelDescriptor[]);
  const artifacts = deepFreeze(copyScenarioFileData(input.artifactModels) as readonly ArtifactModel[]);
  const artifactModels = indexConsumerArtifacts(artifacts, canonicalModels);
  const models = new Map<ModelName, ModelFiles>();
  const valueTypes = input.valueTypes === undefined ? undefined :
    deepFreeze(copyScenarioFileData(input.valueTypes) as CanonicalValueTypes);
  const valueSchema = loadConsumerValueSchema(valueTypes, canonicalModels);
  for (const [name, files] of bindConsumerModels(canonicalModels, artifactModels, valueSchema)) {
    models.set(name, files);
  }
  const inventory = stableStringify({ canonicalModels, artifacts, valueTypes: valueTypes ?? null });
  const checkInventory = () => {
    if (inventory !== stableStringify({ canonicalModels: copyScenarioFileData(input.canonicalModels),
      artifacts: copyScenarioFileData(input.artifactModels),
      valueTypes: input.valueTypes === undefined ? null : copyScenarioFileData(input.valueTypes) })) return invalid('owning declarations changed; rebind the installed consumer.');
  };
  const assertRevision = async (revision: Revision) => {
    if (await store.readRevision() !== revision) throw new StateError('conflict', 'File reference State checkpoint changed.');
    checkInventory();
  };
  const readDef = (model: ModelName): GeneratedOperationDef | null => {
    const def = registry.get(`${model}.read`);
    return def !== undefined && isGeneratedOperationDef(def) && def.name === `${model}.read` &&
      def.descriptor.name === def.name && def.kind === 'read' && def.descriptor.kind === 'read' ? def : null;
  };
  return {
    observeReferences: async ref => {
      fileRef(ref); checkInventory();
      const revision = await store.readRevision(), fence = openFenceScope(revision, scope.owner);
      const references: CommittedFileReference[] = [];
      let count = 0, referenceCount = 0;
      for (const [model, definition] of models) {
        if (definition.fields.size === 0) continue;
        fence.enroll({ kind: 'query', model, authority: 'owner' });
        const records = await store.query({ model, authority: 'owner', archived: 'include',
          order: [{ field: 'id', direction: 'asc' }], limit: maxRows - count + 1 });
        count += records.length; if (count > maxRows) return busy();
        const seen = new Set<RecordId>();
        for (const actual of records) {
          const saved = row(actual);
          if (seen.has(saved.id)) return invalid('duplicate committed row identity.');
          seen.add(saved.id);
          for (const [field, profile] of definition.fields) {
            if (!Object.hasOwn(saved.data, field)) {
              const descriptor = canonicalModels.find(candidate => candidate.name === model)!.fields[field]!;
              if (descriptor.required) return invalid('required committed File slot is missing.');
              continue;
            }
            const occurrences = fileReferenceOccurrences(profile, saved.data[field]);
            referenceCount += occurrences.length; if (referenceCount > maxReferences) return busy();
            occurrences.forEach(occurrence => {
              if (occurrence.ref === ref) references.push(deepFreeze({ model, recordId: saved.id, rowVersion: saved.version,
                field, index: profile.array && typeof occurrence.path[0] === 'number' ? occurrence.path[0] : null,
                path: occurrence.path, ref, archived: saved.archivedAt !== null }));
            });
          }
        }
      }
      await assertRevision(revision);
      return Object.freeze({ scope, complete: true, revision, references: Object.freeze(references), revalidate: () => assertRevision(revision) });
    },
    read: async (rawLocator, rawCaller, consume) => {
      const locator = copyScenarioFileData(rawLocator) as FileSlotLocator;
      const caller = copyScenarioFileData(rawCaller) as FinalizedFileReceiver;
      if (!checkReadParties(locator, caller, scope, consume)) return null;
      fileRef(locator.ref); checkInventory();
      const definition = models.get(locator.model), profile = definition?.fields.get(locator.field), def = readDef(locator.model);
      if (definition === undefined || profile === undefined || def === null) return null;
      const revision = await store.readRevision(), fence = openFenceScope(revision, scope.owner);
      const loaded = await store.load(locator.model, locator.recordId);
      if (loaded === null) return null;
      const original = row(loaded);
      if (original.id !== locator.recordId || original.archivedAt !== null || !Object.hasOwn(original.data, locator.field)) return null;
      const wire = original.data[locator.field];
      if (!fileReferenceOccurrences(profile, wire).some(occurrence => occurrence.ref === locator.ref)) return null;
      const parents = await climbReadParents(store, models, readDef, locator, original, definition);
      if (parents === null) return null;
      const context: ByContext = { actorUserId: caller.principal === 'public' ? null : caller.principal,
        teamId: caller.team, membership: caller.principal === 'public' ? null :
          await memberships.findMembership(caller.team, caller.principal), memberships: memberships };
      if (context.actorUserId !== null) fence.enroll({ kind: 'membership', teamId: caller.team, userId: context.actorUserId });
      fence.enroll({ kind: 'record', model: locator.model, id: original.id, version: original.version });
      const policies = new Map([locator.model, ...parents.map(parent => parent.model)].map(model => [model, policy.get(model)]));
      const authority = await observeRowGrantAuthority(context,
        readAuthorityPredicate(parents, policies, locator, def, original, wire));
      if (!authority.value) return null;
      const { revalidate } = makeReadRevalidator(
        { locator, def, parents, policies, original, revision, authority },
        checkInventory, assertRevision, readDef, policy, store);
      await revalidate();
      const result = await consume(Object.freeze({ model: locator.model, recordId: original.id,
        rowVersion: original.version, field: locator.field, ref: locator.ref }));
      if (result !== null && !(result instanceof Uint8Array)) return invalid('physical reader must return bytes or null.');
      const bytes = result === null ? null : new Uint8Array(result);
      await revalidate();
      return bytes;
    },
  };
}
