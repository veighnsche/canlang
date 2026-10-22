/** Backend-neutral validation only. Durable issuance belongs to the adapter's
 * original transaction, never this module or a copied fact. */
import type { FileReferenceInventory, FileRetirementAuthority, FinalizedFileIdentity,
  FinalizedFileRetirement, InstallFileReferenceInventory, InstalledFileReferenceInventory,
  InstalledSnapshot, ModelName, RetireFinalizedFile, RetainedFinalizedFile, Revision, StoredRow, CanonicalFieldDef, FrameworkFileReferenceProducer, FrameworkFileReferenceModel, FrameworkFilePayloadOrigin, FrameworkOpaqueFieldResolution, FileReferenceStoragePort, StoragePort } from '@canlang/contracts';
import { assertSafeBlobKey } from '@canlang/files/ports';
import { readFinalizedFileObservation } from '@canlang/files/finalize';
import { normalizeValueTypes, parseTypeId, printTypeId } from '@canlang/values';
import { checkRetainedScenarioFile, copyScenarioFileData } from '../invocation/scenario-file-assignment.js';
import { stableStringify } from '../invocation/replay.js';
import { deepFreeze } from '../internal/own-data.js';
import { bindFileReferenceProfile, fileReferenceOccurrences, type FileReferenceProfile } from '../ports/file-reference-profile.js';
import { StorageConstraintError } from './port.js';
import { bindOpaqueFileDeclarations, resolveOpaqueFileProjection, validateOpaqueFileOrigin,
  type BoundOpaqueDeclarations } from './opaque-file-declarations.js';

export const FILE_GUARD_MAX_ROWS = 100_000;
export const FILE_GUARD_MAX_REFERENCES = 1_000_000;
export interface FileGuardRow { readonly model: string; readonly row: StoredRow }
export interface FileGuardMigration { readonly migrationId: string; readonly inventory: FileReferenceInventory }
export interface FileGuardPublication { readonly model: string; readonly id: string; readonly migrationId: string }
export interface FileGuardOpaqueLifetime {
  readonly binding: Omit<FrameworkFilePayloadOrigin, 'files'>;
  /** First accepted facts survive removal from the current typed payload. */
  readonly files: readonly RetainedFinalizedFile[];
}
export interface FileGuardState {
  readonly authority: FileRetirementAuthority | null;
  readonly inventories: readonly InstalledFileReferenceInventory[];
  readonly migrations: readonly FileGuardMigration[];
  /** The exact rows actually published with target declarations. Shadow rows
   * alone never establish a live target interpretation. */
  readonly publications: readonly FileGuardPublication[];
  readonly retirements: readonly FinalizedFileRetirement[];
  readonly opaqueLifetimes: readonly FileGuardOpaqueLifetime[];
}
export function emptyFileGuard(): FileGuardState {
  return { authority: null, inventories: [], migrations: [], publications: [], retirements: [], opaqueLifetimes: [] };
}
const refuse = (message: string): never => { throw new StorageConstraintError('reference', `File retirement: ${message}`); };
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return refuse('own object required');
  return value as Record<string, unknown>;
}
function keys(value: unknown, expected: readonly string[]): void {
  if (stableStringify(Object.keys(object(value)).sort()) !== stableStringify([...expected].sort())) return refuse('closed metadata required');
}
const detachedFileData = new WeakSet<object>();
export function fileGuardCopy<T>(value: T): T {
  try {
    const detached = deepFreeze(copyScenarioFileData(value) as T);
    if (typeof detached === 'object' && detached !== null) detachedFileData.add(detached);
    return detached;
  }
  catch { return refuse('bounded own canonical data required'); }
}
export function fileGuardEqual(left: unknown, right: unknown): boolean { return stableStringify(left) === stableStringify(right); }
export function checkedFileAuthority(input: FileRetirementAuthority): FileRetirementAuthority {
  const value = fileGuardCopy(input);
  keys(value, ['app', 'stateOwner', 'stateStoreId', 'fileStoreId', 'receiver']);
  keys(value.receiver, ['app', 'team', 'owner']);
  if (![value.app, value.stateOwner, value.stateStoreId, value.fileStoreId, value.receiver.app,
    value.receiver.team, value.receiver.owner].every(text) || value.app !== value.receiver.app) return refuse('resolved permanent assignment required');
  return value;
}
export function checkFileBinding(state: FileGuardState, binding?: FileRetirementAuthority): void {
  if (state.authority === null) {
    if (state.inventories.length || state.migrations.length || state.publications.length || state.retirements.length || state.opaqueLifetimes.length) return refuse('durable facts have no permanent assignment');
    return;
  }
  checkedFileAuthority(state.authority);
  if (state.authority !== null && binding !== undefined && !fileGuardEqual(state.authority, binding)) return refuse('persisted assignment mismatch');
  if (!Array.isArray(state.opaqueLifetimes) || state.opaqueLifetimes.length > FILE_GUARD_MAX_ROWS) return refuse('bounded durable opaque lifetimes required');
  const lifetimes = new Set<string>();
  const files = { count: 0 };
  for (const lifetime of state.opaqueLifetimes) {
    checkOpaqueLifetime(state, lifetime, lifetimes, files);
  }
  for (const installed of state.inventories) {
    if (!fileGuardEqual(installed.authority, state.authority)) return refuse('inventory belongs to foreign assignment');
    snapshotIdentity(installed.snapshot, installed.inventory);
  }
  const retired = new Set<string>();
  for (const fact of state.retirements) {
    checkRetirementFact(state, fact, retired);
  }
}

/** One durable opaque lifetime: slot scope, uniqueness and File facts. */
function checkOpaqueLifetime(
  state: FileGuardState,
  lifetime: FileGuardState['opaqueLifetimes'][number],
  lifetimes: Set<string>,
  files: { count: number },
): void {
  keys(lifetime, ['binding', 'files']);
  const original = lifetime.binding;
  keys(original, ['version', 'inventory', 'declarationSetId', 'slot', 'scope', 'origin']);
  keys(original.inventory, ['owner', 'snapshotId', 'digest']); identity(original.inventory);
  keys(original.slot, ['model', 'id', 'created', 'createdBy', 'field', 'role']);
  keys(original.scope, ['app', 'ownerPackage', 'owner']);
  if (original.version !== 1 || !text(original.declarationSetId) ||
      ![original.slot.model, original.slot.id, original.slot.createdBy, original.slot.field].every(text) ||
      !Number.isFinite(original.slot.created) || !['retained-result', 'deferred-input'].includes(original.slot.role) ||
      !fileGuardEqual(original.scope, { app: state.authority!.app, ownerPackage: original.inventory.owner,
        owner: state.authority!.receiver.owner }) || !Array.isArray(lifetime.files)) return refuse('complete original opaque lifetime required');
  const key = stableStringify(original.slot);
  if (lifetimes.has(key)) return refuse('duplicate durable opaque lifetime');
  lifetimes.add(key);
  const references = new Set<string>();
  for (const file of lifetime.files) {
    if (++files.count > FILE_GUARD_MAX_REFERENCES) return refuse('durable original File facts exceed bound');
    const { retention: _retention, ...physical } = checkRetainedScenarioFile(file);
    checkedFile(physical, state.authority!);
    if (references.has(file.ref)) return refuse('duplicate original opaque File facts');
    references.add(file.ref);
  }
}

/** One permanent retirement fact: retention, identity and revision seal. */
function checkRetirementFact(
  state: FileGuardState,
  fact: FileGuardState['retirements'][number],
  retired: Set<string>,
): void {
  keys(fact, ['retirementId', 'authority', 'file', 'snapshot', 'censusRevision', 'retiredRevision', 'retiredAtMs', 'disposition', 'retention']);
  checkedFile(fact.file, state.authority!);
  keys(fact.retention, ['unattachedHorizonMs', 'retentionMs', ...(Object.hasOwn(fact.retention, 'retainAttached') ? ['retainAttached'] : [])]);
  if (Object.hasOwn(fact.retention, 'retainAttached') && fact.retention.retainAttached !== true) return refuse('invalid attached File retention policy');
  if (fact.retention.retainAttached === true && fact.disposition === 'expired') return refuse('retained attached Files require explicit orphan retirement');
  identity(fact.snapshot);
  checkRetirementFactSeal(state, fact, retired);
  retired.add(fact.file.ref);
}

/** Identity, revision and retention seal for one retirement fact. */
function checkRetirementFactSeal(
  state: FileGuardState,
  fact: FileGuardState['retirements'][number],
  retired: Set<string>,
): void {
  if (!fileGuardEqual(fact.authority, state.authority) || !text(fact.retirementId) || retired.has(fact.file.ref) ||
      !Number.isSafeInteger(fact.censusRevision) || fact.censusRevision < 0 || fact.retiredRevision !== fact.censusRevision + 1 ||
      !Number.isSafeInteger(fact.retiredRevision) || !Number.isSafeInteger(fact.snapshot.installedRevision) || fact.snapshot.installedRevision < 0 ||
      fact.snapshot.installedRevision > fact.censusRevision || !Number.isFinite(fact.snapshot.installedAt) ||
      ![fact.retention.unattachedHorizonMs, fact.retention.retentionMs].every(value => Number.isSafeInteger(value) && value >= 0) ||
      !Number.isSafeInteger(fact.retiredAtMs) || fact.retiredAtMs < fact.file.finalizedAtMs ||
      fact.disposition !== 'orphaned' && fact.disposition !== 'expired') return refuse('invalid permanent retirement facts');
}
export function checkFileGuardSnapshots(state: FileGuardState, snapshots: readonly InstalledSnapshot[]): void {
  for (const installed of state.inventories) {
    const actual = snapshots.find(snapshot => snapshot.owner === installed.snapshot.owner);
    if (actual === undefined || !fileGuardEqual(actual, installed.snapshot)) return refuse('durable installed pointer correspondence changed');
  }
}
function identity(input: { readonly owner: string; readonly snapshotId: string; readonly digest: string }): void {
  if (![input.owner, input.snapshotId, input.digest].every(text)) return refuse('installed declaration identity required');
}
function snapshotIdentity(snapshot: InstalledSnapshot, inventory: FileReferenceInventory): void {
  identity(snapshot); identity(inventory);
  if (snapshot.owner !== inventory.owner || snapshot.snapshotId !== inventory.snapshotId || snapshot.digest !== inventory.digest) return refuse('snapshot and declaration identity disagree');
}
interface BoundFrameworkModel {
  readonly declaration: FrameworkFileReferenceModel;
  readonly family: readonly string[];
  readonly validateRow: (model: ModelName, row: StoredRow) => void;
  readonly resolveOpaqueField?: NonNullable<FrameworkFileReferenceProducer['resolveOpaqueField']>;
}
export type FileFrameworkBinding = ReadonlyMap<string, BoundFrameworkModel>;
const EMPTY_FRAMEWORK: FileFrameworkBinding = new Map();
const owningFrameworkBindings = new WeakSet<object>([EMPTY_FRAMEWORK]);
// This association carries only the actual constructor-captured validators for
// same-load migration validation. Permanent issuance remains the persisted
// assignment/census/revision/retirement transaction; this map never proves it.
const frameworkAdapters = new WeakMap<StoragePort, FileFrameworkBinding>();
export function registerFileFrameworkStorage<T extends StoragePort>(store: T, framework: FileFrameworkBinding): T {
  if (frameworkAdapters.has(store)) return refuse('framework adapter binding already registered');
  frameworkAdapters.set(store, framework);
  return store;
}
export function checkedFileInventoryForStorage(store: StoragePort, input: FileReferenceInventory): FileReferenceInventory {
  return checkedFileInventory(input, frameworkAdapters.get(store) ?? EMPTY_FRAMEWORK);
}

export interface FrameworkFilePayloadOriginInput {
  readonly expectedRevision: Revision;
  readonly inventoryOwner: string;
  readonly declarationSetId: string;
  readonly model: ModelName;
  /** Actual owning staged row. The final commit still checks its exact lifetime. */
  readonly row: StoredRow;
  readonly field: string;
  readonly scope: FrameworkFilePayloadOrigin['scope'];
  /** Derived by the source-verified native loader, never from a public request. */
  readonly origin: FrameworkFilePayloadOrigin['origin'];
  readonly files: readonly { readonly path: readonly (string | number)[]; readonly observation: unknown }[];
}

/** Trusted native producer bridge. Capture genuine Files observations before
 * yielding; check the actual installed port/declarations and original revision.
 * This evidence grants no execution, disclosure or reuse authority. The final
 * owning commit independently validates every actual row and typed position. */
export async function prepareFrameworkFilePayloadOrigin(store: FileReferenceStoragePort,
  input: FrameworkFilePayloadOriginInput): Promise<FrameworkFilePayloadOrigin> {
  const names = ['expectedRevision', 'inventoryOwner', 'declarationSetId', 'model', 'row', 'field', 'scope', 'origin', 'files'];
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).length !== names.length || names.some(name =>
        descriptors[name] === undefined || !('value' in descriptors[name]!) || !descriptors[name]!.enumerable)) return refuse('own original producer inputs required');
  const files = checkProducerFileObservations(descriptors);
  const captured = fileGuardCopy(Object.fromEntries(names.filter(name => name !== 'files').map(name =>
    [name, descriptors[name]!.value]))) as Omit<FrameworkFilePayloadOriginInput, 'files'>;
  return bindProducerPayloadOrigin(store, captured, files);
}

/** Dense genuine File observations with retained scenario facts. */
function checkProducerFileObservations(
  descriptors: Record<string, PropertyDescriptor>,
): FrameworkFilePayloadOrigin['files'][number][] {
  const rawFiles = descriptors.files!.value as unknown;
  if (!Array.isArray(rawFiles) || Object.getPrototypeOf(rawFiles) !== Array.prototype ||
      rawFiles.length > FILE_GUARD_MAX_REFERENCES || Reflect.ownKeys(rawFiles).length !== rawFiles.length + 1) return refuse('dense genuine File observations required');
  const files: FrameworkFilePayloadOrigin['files'][number][] = [];
  for (let index = 0; index < rawFiles.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(rawFiles, String(index));
    if (entry === undefined || !('value' in entry) || !entry.enumerable) return refuse('own genuine File observation required');
    const observation = Object.getOwnPropertyDescriptor(entry.value, 'observation');
    const path = Object.getOwnPropertyDescriptor(entry.value, 'path');
    if (![Object.prototype, null].includes(Object.getPrototypeOf(entry.value)) || Reflect.ownKeys(entry.value).length !== 2 ||
        observation === undefined || !('value' in observation) || !observation.enumerable ||
        path === undefined || !('value' in path) || !path.enumerable) return refuse('closed own genuine File observation required');
    const fact = readFinalizedFileObservation(observation.value);
    if (fact === null) return refuse('actual Files observation required; copied facts are not observations');
    files.push({ path: checkedPath(fileGuardCopy(path.value)), file: checkRetainedScenarioFile(fact) });
  }
  return files;
}

/** Installed opaque slot binding with producer-row and census proof. */
async function bindProducerPayloadOrigin(
  store: FileReferenceStoragePort,
  captured: Omit<FrameworkFilePayloadOriginInput, 'files'>,
  files: FrameworkFilePayloadOrigin['files'][number][],
): Promise<FrameworkFilePayloadOrigin> {
  const framework = frameworkAdapters.get(store), bound = framework?.get(captured.model);
  if (framework === undefined || bound === undefined || bound.resolveOpaqueField === undefined ||
      !Number.isSafeInteger(captured.expectedRevision) || captured.expectedRevision < 0 || !text(captured.inventoryOwner)) return refuse('actual registered producer port and original revision required');
  const installed = await store.readFileReferenceInventory(captured.inventoryOwner);
  if (installed === null || await store.readRevision() !== captured.expectedRevision) return refuse('original installed inventory or revision moved');
  const profile = modelProfiles([installed], framework).get(captured.model);
  if (profile?.kind !== 'framework') return refuse('actual installed owning opaque model required');
  const set = profile.opaque.get(captured.declarationSetId);
  if (set === undefined) return refuse('actual retained declaration set required');
  const descriptor = bound.declaration.fields[captured.field];
  if (descriptor?.kind !== 'opaque' || descriptor.role === 'payload-origin') return refuse('actual retained payload slot required');
  const header = Object.entries(bound.declaration.fields).find(([, declaration]) => declaration.kind === 'opaque' &&
    declaration.role === 'payload-origin' && declaration.payloadField === captured.field)?.[0];
  if (header === undefined) return refuse('actual owning payload header required');
  const binding: FrameworkFilePayloadOrigin = fileGuardCopy({ version: 1, inventory: set.declarationSet.inventory,
    declarationSetId: captured.declarationSetId, slot: { model: captured.model, id: captured.row.id,
      created: captured.row.created, createdBy: captured.row.createdBy, field: captured.field, role: descriptor.role },
    scope: captured.scope, origin: captured.origin, files });
  const row = { ...captured.row, data: { ...captured.row.data, [header]: binding } };
  try { bound.validateRow(captured.model, row); }
  catch { return refuse('actual owning producer row refused'); }
  opaqueOccurrences({ ...emptyFileGuard(), authority: installed.authority, inventories: [installed] },
    captured.model, row, captured.field, descriptor.role, profile, profile);
  return binding;
}

/** Only the trusted same-load host passes actual owning exports here. The
 * persisted source tags are compared evidence, never producer authentication. */
export function bindFileFrameworkProducers(producers: readonly FrameworkFileReferenceProducer[] = []): FileFrameworkBinding {
  if (!Array.isArray(producers) || producers.length > 200) return refuse('bounded actual framework producers required');
  const bound = new Map<string, BoundFrameworkModel>();
  for (const producer of producers) {
    bindOneFrameworkProducer(bound, producer);
  }
  owningFrameworkBindings.add(bound);
  return bound;
}

/** One producer's owning family with per-model validator binding. */
function bindOneFrameworkProducer(bound: Map<string, BoundFrameworkModel>, producer: FrameworkFileReferenceProducer): void {
  const models = Object.getOwnPropertyDescriptor(producer, 'models');
  const validator = Object.getOwnPropertyDescriptor(producer, 'validateRow');
  const resolver = Object.getOwnPropertyDescriptor(producer, 'resolveOpaqueField');
  if (models === undefined || !('value' in models) || validator === undefined || !('value' in validator) ||
      typeof validator.value !== 'function') return refuse('actual own framework export required');
  if (resolver !== undefined && (!('value' in resolver) || typeof resolver.value !== 'function') ||
      resolver === undefined && 'resolveOpaqueField' in producer) return refuse('actual own synchronous opaque resolver required');
  const declarations = fileGuardCopy(models.value) as readonly FrameworkFileReferenceModel[];
  if (!Array.isArray(declarations) || declarations.length === 0 || declarations.length > 200) return refuse('complete owning framework family required');
  const family = Object.freeze(declarations.map(model => model.model as string));
  for (const declaration of declarations) {
    checkFrameworkDeclaration(declaration);
    if (bound.has(declaration.model)) return refuse('duplicate bound framework model');
    bound.set(declaration.model, Object.freeze({ declaration, family, validateRow: (validator.value as (...args: never[]) => void).bind(producer) as BoundFrameworkModel['validateRow'],
      ...(resolver === undefined ? {} : { resolveOpaqueField: (resolver.value as (...args: never[]) => unknown).bind(producer) as NonNullable<BoundFrameworkModel['resolveOpaqueField']> }) }));
  }
}
/** One framework field: opaque header/role or closed control shape. */
function checkFrameworkField(declaration: FrameworkFileReferenceModel, name: string, field: unknown): void {
  if (!text(name)) return refuse('framework field identity required');
  const value = object(field);
  if (value.kind === 'opaque') {
    if (value.role === 'payload-origin') {
      checkOpaqueHeaderLink(declaration, value);
    } else {
      keys(value, ['kind', 'role', ...(Object.hasOwn(value, 'optional') ? ['optional'] : [])]);
      if (value.role !== 'retained-result' && value.role !== 'deferred-input') return refuse('owning opaque role required');
      if (Object.hasOwn(value, 'optional') && (value.role !== 'deferred-input' || value.optional !== true)) return refuse('only deferred inputs may be absent');
    }
  } else if (value.kind === 'control') {
    checkFrameworkControl(value);
  } else return refuse('classified framework field required');
}

/** Opaque header link against its owning payload field. */
function checkOpaqueHeaderLink(declaration: FrameworkFileReferenceModel, value: Record<string, unknown>): void {
  keys(value, ['kind', 'role', 'payloadField', 'optional']);
  const payload = object(declaration.fields)[value.payloadField as string];
  if (!text(value.payloadField) || value.optional !== true || payload === undefined ||
      object(payload).kind !== 'opaque' || !['retained-result', 'deferred-input'].includes(object(payload).role as string)) return refuse('exact owning opaque header link required');
}

/** Closed control shape with required string children for objects. */
function checkFrameworkControl(value: Record<string, unknown>): void {
  keys(value, ['kind', 'value', ...(value.value === 'object' ? ['fields'] : []), ...(Object.hasOwn(value, 'nullable') ? ['nullable'] : []), ...(Object.hasOwn(value, 'optional') ? ['optional'] : [])]);
  if (!['string', 'number', 'boolean', 'string-array', 'object'].includes(value.value as string) ||
      Object.hasOwn(value, 'nullable') && value.nullable !== true || Object.hasOwn(value, 'optional') && value.optional !== true) return refuse('closed framework control declaration required');
  if (value.value === 'object') {
    for (const [name, child] of Object.entries(object(value.fields))) {
      keys(child, ['kind', 'value']);
      if (!text(name) || object(child).kind !== 'control' || object(child).value !== 'string') return refuse('closed required owning string controls required');
    }
  }
}

function checkFrameworkDeclaration(declaration: FrameworkFileReferenceModel): void {
  keys(declaration, ['model', 'source', 'fields']);
  keys(declaration.source, ['package', 'module', 'export']);
  if (![declaration.model, declaration.source.package, declaration.source.module, declaration.source.export].every(text)) return refuse('owning framework source identity required');
  const type = parseTypeId(declaration.model);
  if (type.base.kind !== 'nominal' || type.array || type.nullable || printTypeId(type) !== declaration.model) return refuse('canonical framework model required');
  for (const [name, field] of Object.entries(object(declaration.fields))) {
    checkFrameworkField(declaration, name, field);
  }
  const headers = Object.values(declaration.fields).filter(field => field.kind === 'opaque' && field.role === 'payload-origin');
  if (new Set(headers.map(field => field.kind === 'opaque' && field.role === 'payload-origin' ? field.payloadField : '')).size !== headers.length) return refuse('duplicate owning opaque header link');
}
interface DomainProfile { readonly kind: 'domain'; readonly fields: ReadonlyMap<string, FileReferenceProfile>; readonly required: ReadonlySet<string> }
interface FrameworkProfile { readonly kind: 'framework'; readonly bound: BoundFrameworkModel;
  readonly inventory: FileReferenceInventory; readonly opaque: ReadonlyMap<string, BoundOpaqueDeclarations>;
  readonly installed?: InstalledFileReferenceInventory;
  /** Shared framework tables retain each package's independently installed closure. */
  readonly owners?: ReadonlyMap<string, FrameworkProfile> }
type ModelProfile = DomainProfile | FrameworkProfile;
/** One domain model: unique correspondence with bound field profiles. */
function bindDomainProfile(
  inventory: FileReferenceInventory,
  artifacts: Map<ModelName, FileReferenceInventory['artifactModels'][number]>,
  valueSchema: ReturnType<typeof normalizeValueTypes>['valueSchema'],
  result: Map<string, ModelProfile>,
  model: FileReferenceInventory['canonicalModels'][number],
): void {
  const artifact = artifacts.get(model.name);
  const type = parseTypeId(model.name);
  if (!text(model.name) || type.base.kind !== 'nominal' || type.array || type.nullable || printTypeId(type) !== model.name ||
      result.has(model.name) || artifact === undefined || artifact.deleteMode !== model.deleteMode ||
      artifact.fields.length !== Object.keys(model.fields).length) return refuse('complete unique model correspondence required');
  const fields = new Map<string, FileReferenceProfile>(), required = new Set<string>();
  for (const [field, declaration] of Object.entries(model.fields) as [string, CanonicalFieldDef][]) {
    fields.set(field, bindFileReferenceProfile({ canonicalModels: inventory.canonicalModels, artifactModels: artifacts,
      valueTypes: inventory.valueTypes, valueSchema }, model.name, field));
    if (declaration.required) required.add(field);
  }
  result.set(model.name, { kind: 'domain', fields, required });
}

/** One framework model: same-load correspondence with its opaque closure. */
function bindFrameworkProfile(
  inventory: FileReferenceInventory,
  framework: FileFrameworkBinding,
  opaque: ReadonlyMap<string, BoundOpaqueDeclarations>,
  declared: ReadonlySet<string>,
  result: Map<string, ModelProfile>,
  declaration: FileReferenceInventory['frameworkModels'][number],
): void {
  checkFrameworkDeclaration(declaration);
  const bound = framework.get(declaration.model);
  if (result.has(declaration.model) || bound === undefined || !fileGuardEqual(bound.declaration, declaration) ||
      bound.family.some(model => !declared.has(model))) return refuse('complete same-load owning framework correspondence required');
  result.set(declaration.model, { kind: 'framework', bound, inventory, opaque });
}

// Only this module's detached, recursively frozen own data can retain a
// successful binding. Persisted/reopened or caller-owned data is checked afresh.
// Framework maps remain mutable Maps, so also compare their complete entry
// identities; each actual bound producer entry itself is frozen at creation.
const preparedFileProfiles = new WeakMap<object, WeakMap<object, {
  readonly entries: readonly (readonly [string, BoundFrameworkModel])[];
  readonly profiles: ReadonlyMap<string, ModelProfile>;
}>>();
function profiles(input: FileReferenceInventory, framework: FileFrameworkBinding = EMPTY_FRAMEWORK): ReadonlyMap<string, ModelProfile> {
  const reusable = detachedFileData.has(input) && owningFrameworkBindings.has(framework);
  const prepared = reusable ? preparedFileProfiles.get(input)?.get(framework) : undefined;
  if (prepared !== undefined && framework.size === prepared.entries.length &&
      prepared.entries.every(([name, entry]) => framework.get(name) === entry)) return prepared.profiles;
  const inventory = fileGuardCopy(input);
  keys(inventory, ['owner', 'snapshotId', 'digest', 'canonicalModels', 'artifactModels', 'valueTypes', 'frameworkModels',
    ...(Object.hasOwn(inventory, 'opaqueDeclarationSets') ? ['opaqueDeclarationSets'] : [])]);
  identity(inventory);
  if (!Array.isArray(inventory.canonicalModels) || !Array.isArray(inventory.artifactModels) ||
      inventory.canonicalModels.length !== inventory.artifactModels.length || inventory.canonicalModels.length > 200 ||
      !Array.isArray(inventory.valueTypes?.contracts) || !Array.isArray(inventory.frameworkModels) || inventory.frameworkModels.length > 200) return refuse('complete explicit declarations required');
  const artifacts = new Map(inventory.artifactModels.map(model => [model.name as ModelName, model]));
  if (artifacts.size !== inventory.artifactModels.length) return refuse('duplicate artifact model');
  const result = new Map<string, ModelProfile>();
  try {
    const opaque = bindOpaqueFileDeclarations(inventory.opaqueDeclarationSets ?? [], set => {
      profiles({ ...set.inventory, canonicalModels: set.canonicalModels, artifactModels: set.artifactModels,
        valueTypes: set.valueTypes, frameworkModels: [] });
    });
    const original = (inventory.opaqueDeclarationSets ?? []).find(set => fileGuardEqual(set.inventory,
      { owner: inventory.owner, snapshotId: inventory.snapshotId, digest: inventory.digest }));
    // An installed package owns only its domain rows, but field validation
    // still needs the exact checked imported models from its original closure.
    if (original !== undefined && !fileGuardEqual(inventory.valueTypes, original.valueTypes)) return refuse('owned value types differ from original schema closure');
    const schema = original === undefined ? inventory : { ...inventory,
      canonicalModels: original.canonicalModels, artifactModels: original.artifactModels };
    const schemaArtifacts = original === undefined ? artifacts :
      new Map(schema.artifactModels.map(model => [model.name as ModelName, model]));
    const valueSchema = normalizeValueTypes(inventory.valueTypes, schema.canonicalModels.map(model => model.name)).valueSchema;
    for (const model of inventory.canonicalModels) {
      if (original !== undefined && (!fileGuardEqual(schema.canonicalModels.find(item => item.name === model.name), model) ||
          !fileGuardEqual(schemaArtifacts.get(model.name), artifacts.get(model.name)))) return refuse('owned model differs from original schema closure');
      bindDomainProfile(schema, schemaArtifacts, valueSchema, result, model);
    }
    const declared = new Set(inventory.frameworkModels.map(model => model.model as string));
    for (const declaration of inventory.frameworkModels) {
      bindFrameworkProfile(inventory, framework, opaque, declared, result, declaration);
    }
  } catch (error) {
    if (error instanceof StorageConstraintError) throw error;
    return refuse('invalid complete declaration correspondence');
  }
  if (reusable) {
    const bindings = preparedFileProfiles.get(input) ?? new WeakMap();
    bindings.set(framework, { entries: [...framework], profiles: result });
    preparedFileProfiles.set(input, bindings);
  }
  return result;
}
export function checkedFileInventory(input: FileReferenceInventory, framework: FileFrameworkBinding = EMPTY_FRAMEWORK): FileReferenceInventory {
  const value = fileGuardCopy(input); profiles(value, framework); return value;
}
export function checkFileFrameworkBinding(state: FileGuardState, framework: FileFrameworkBinding): void {
  modelProfiles(state.inventories, framework);
  for (const migration of state.migrations) profiles(migration.inventory, framework);
}
function modelProfiles(inventories: readonly InstalledFileReferenceInventory[], framework: FileFrameworkBinding): Map<string, ModelProfile> {
  const result = new Map<string, ModelProfile>(), owners = new Set<string>();
  for (const installed of inventories) {
    snapshotIdentity(installed.snapshot, installed.inventory);
    for (const set of installed.inventory.opaqueDeclarationSets ?? []) {
      if (fileGuardEqual(set.inventory, { owner: installed.inventory.owner, snapshotId: installed.inventory.snapshotId,
        digest: installed.inventory.digest }) && !fileGuardEqual(set.snapshot, installed.snapshot)) return refuse('original declaration set installation facts disagree');
    }
    if (owners.has(installed.inventory.owner)) return refuse('duplicate installed owner');
    owners.add(installed.inventory.owner);
    for (const [name, profile] of profiles(installed.inventory, framework)) {
      const previous = result.get(name);
      const current = profile.kind === 'framework' ? { ...profile, installed } : profile;
      if (previous !== undefined) {
        if (previous.kind !== 'framework' || current.kind !== 'framework' || previous.bound !== current.bound ||
            !fileGuardEqual(previous.bound.declaration, current.bound.declaration)) return refuse('colliding installed model declarations');
        const shared = new Map(previous.owners ?? [[previous.inventory.owner, previous]]);
        if (shared.has(installed.inventory.owner)) return refuse('duplicate framework inventory owner');
        shared.set(installed.inventory.owner, current);
        result.set(name, { ...previous, owners: shared });
      } else result.set(name, current);
    }
  }
  return result;
}
interface Occurrence { readonly ref: string; readonly key: string }
interface OpaqueOccurrence { readonly ref: string; readonly path: readonly (string | number)[] }
function checkedPath(input: unknown): readonly (string | number)[] {
  if (!Array.isArray(input) || input.length > 32 || input.some(part =>
    typeof part === 'string' ? part.length === 0 : !Number.isSafeInteger(part) || part < 0)) return refuse('bounded exact typed path required');
  return input;
}
function projectionValue(payload: unknown, path: readonly (string | number)[]): unknown {
  let value = payload;
  for (const part of path) {
    if (typeof value !== 'object' || value === null ||
        (Array.isArray(value) ? typeof part !== 'number' : typeof part !== 'string') ||
        !Object.hasOwn(value, part)) return refuse('typed projection is absent from actual payload');
    value = (value as Record<string | number, unknown>)[part];
  }
  return value;
}
function opaqueOccurrences(state: FileGuardState, model: string, row: StoredRow, field: string,
  role: 'retained-result' | 'deferred-input', profile: FrameworkProfile, original: ModelProfile | undefined): readonly OpaqueOccurrence[] {
  const headers = Object.entries(profile.bound.declaration.fields).filter(([, descriptor]) =>
    descriptor.kind === 'opaque' && descriptor.role === 'payload-origin' && descriptor.payloadField === field);
  if (headers.length !== 1 || !Object.hasOwn(row.data, headers[0]![0]) ||
      profile.bound.resolveOpaqueField === undefined || state.authority === null) return refuse('opaque framework payload requires its actual source-bound resolver and header');
  const binding = fileGuardCopy(row.data[headers[0]![0]]) as unknown as FrameworkFilePayloadOrigin;
  keys(binding, ['version', 'inventory', 'declarationSetId', 'slot', 'scope', 'origin', 'files']);
  keys(binding.inventory, ['owner', 'snapshotId', 'digest']);
  keys(binding.slot, ['model', 'id', 'created', 'createdBy', 'field', 'role']);
  keys(binding.scope, ['app', 'ownerPackage', 'owner']);
  if (binding.version !== 1 || !text(binding.declarationSetId) ||
      !fileGuardEqual(binding.slot, { model, id: row.id, created: row.created, createdBy: row.createdBy, field, role }) ||
      !fileGuardEqual(binding.scope, { app: state.authority.app, ownerPackage: binding.inventory.owner,
        owner: state.authority.receiver.owner })) return refuse('original opaque slot lifetime and permanent scope disagree');
  identity(binding.inventory);
  if (profile.owners !== undefined) {
    const owning = profile.owners.get(binding.inventory.owner);
    if (owning === undefined) return refuse('opaque framework package has no installed inventory');
    profile = owning;
  }
  if (original?.kind === 'framework' && original.owners !== undefined) original = original.owners.get(binding.inventory.owner);
  const historical = profile.opaque.get(binding.declarationSetId);
  if (historical === undefined || !fileGuardEqual(binding.inventory, historical.declarationSet.inventory)) return refuse('complete original historical declarations required');
  try { validateOpaqueFileOrigin(historical, binding); }
  catch { return refuse('original opaque source/declaration recipe disagrees'); }
  if (binding.origin.kind === 'scheduled-handler-result' &&
      (model !== 'work.occurrence' || field !== 'result' || role !== 'retained-result' ||
        row.id !== binding.origin.occurrenceId ||
        !fileGuardEqual({ status: row.data['status'], result: row.data['result'],
          code: row.data['code'], message: row.data['message'] }, binding.origin.terminal))) {
    return refuse('direct due result differs from its genuine terminal Work receipt.');
  }
  const found = collectOpaqueProjections(profile, original, historical, binding, model, row, field, state);
  const facts = collectOpaqueFacts(binding, state);
  if (found.length !== facts.size || found.some(reference => facts.get(stableStringify(reference.path)) !== reference.ref)) return refuse('typed File positions and original receiving facts disagree');
  return found;
}

/** Installed assignment with the exact synchronous opaque resolution. */
function checkOpaqueResolution(
  profile: FrameworkProfile,
  original: ModelProfile | undefined,
  historical: BoundOpaqueDeclarations,
  binding: FrameworkFilePayloadOrigin,
  model: string,
  row: StoredRow,
  field: string,
): FrameworkOpaqueFieldResolution {
  const backing = profile.installed ?? (original?.kind === 'framework' ? original.installed : undefined);
  if (backing === undefined) return refuse('actual installed framework assignment required');
  const installed = profile.installed ?? { ...backing, inventory: profile.inventory };
  let resolution: FrameworkOpaqueFieldResolution;
  try {
    resolution = fileGuardCopy(profile.bound.resolveOpaqueField!(model as ModelName, row, field, { installed, binding }));
  } catch { return refuse('actual owning synchronous opaque resolver refused'); }
  keys(resolution, ['binding', 'values']);
  if (!fileGuardEqual(resolution.binding, binding) || !Array.isArray(resolution.values) || resolution.values.length > 20_000) return refuse('exact original opaque resolution required');
  return resolution;
}

/** Typed projection occurrences with overlap refusal in path order. */
function collectOpaqueProjections(
  profile: FrameworkProfile,
  original: ModelProfile | undefined,
  historical: BoundOpaqueDeclarations,
  binding: FrameworkFilePayloadOrigin,
  model: string,
  row: StoredRow,
  field: string,
  state: FileGuardState,
): OpaqueOccurrence[] {
  const resolution = checkOpaqueResolution(profile, original, historical, binding, model, row, field);
  const paths: (readonly (string | number)[])[] = [];
  const found: OpaqueOccurrence[] = [];
  for (const projection of resolution.values) {
    const path = checkedPath(projection.path);
    if (paths.some(prior => prior.length <= path.length && prior.every((part, index) => part === path[index]) ||
        path.length <= prior.length && path.every((part, index) => part === prior[index]))) return refuse('duplicate or overlapping typed projections');
    paths.push(path);
    let references: readonly OpaqueOccurrence[];
    try { references = resolveOpaqueFileProjection(historical, projection, projectionValue(row.data[field], path), binding); }
    catch { return refuse('actual opaque value violates complete original declarations'); }
    for (const reference of references) found.push({ ref: reference.ref, path: [...path, ...checkedPath(reference.path)] });
  }
  return found;
}

/** Original receiving File facts keyed by typed path. */
function collectOpaqueFacts(
  binding: FrameworkFilePayloadOrigin,
  state: FileGuardState,
): Map<string, string> {
  if (!Array.isArray(binding.files) || binding.files.length > FILE_GUARD_MAX_REFERENCES) return refuse('bounded original receiving facts required');
  const facts = new Map<string, string>();
  const byRef = new Map<string, unknown>();
  for (const evidence of binding.files) {
    keys(evidence, ['path', 'file']);
    const path = checkedPath(evidence.path);
    let file;
    try { file = checkRetainedScenarioFile(evidence.file); }
    catch { return refuse('complete immutable original receiving File facts required'); }
    const { retention: _retention, ...physical } = file;
    checkedFile(physical, state.authority!);
    const key = stableStringify(path);
    if (facts.has(key) || byRef.has(file.ref) && !fileGuardEqual(byRef.get(file.ref), file)) return refuse('duplicate or conflicting original File facts');
    facts.set(key, file.ref); byRef.set(file.ref, file);
  }
  return facts;
}
/** Complete live rows include archived data. Missing optional fields are absent;
 * explicit nullable values and every nested/collection position are validated. */
function census(state: FileGuardState, rows: readonly FileGuardRow[], maxRows: number, maxReferences: number, framework: FileFrameworkBinding): readonly Occurrence[] {
  if (rows.length > maxRows) return refuse('complete row census exceeds bound');
  const installed = modelProfiles(state.inventories, framework);
  const targets = new Map(state.migrations.map(migration => [migration.migrationId, profiles(migration.inventory, framework)]));
  if (targets.size !== state.migrations.length) return refuse('duplicate migration declaration identity');
  const published = new Map(state.publications.map(row => [stableStringify([row.model, row.id]), row.migrationId]));
  if (published.size !== state.publications.length) return refuse('duplicate published row identity');
  const found: Occurrence[] = [], seen = new Set<string>();
  for (const entry of rows) {
    censusOneRow(state, entry, installed, targets, published, found, seen, maxReferences);
  }
  return found;
}

/** One live row in census order: identity, then framework or domain fields. */
function censusOneRow(
  state: FileGuardState,
  entry: FileGuardRow,
  installed: Map<string, ModelProfile>,
  targets: Map<string, ReadonlyMap<string, ModelProfile>>,
  published: Map<string, string>,
  found: Occurrence[],
  seen: Set<string>,
  maxReferences: number,
): void {
  const row = fileGuardCopy(entry.row), rowKey = stableStringify([entry.model, row.id]);
  if (seen.has(rowKey)) return refuse('duplicate live row');
  seen.add(rowKey);
  if (!text(row.id) || !Number.isSafeInteger(row.version) || row.version < 1 || !Number.isFinite(row.created) ||
      !Number.isFinite(row.updated) || !text(row.createdBy) || !text(row.updatedBy) ||
      row.archivedAt !== null && !Number.isFinite(row.archivedAt)) return refuse('actual stored row required');
  const migration = published.get(rowKey);
  const profile = migration === undefined ? installed.get(entry.model) : targets.get(migration)?.get(entry.model);
  if (profile === undefined) return refuse('unknown or uncovered live model declaration');
  const data = object(row.data);
  if (profile.kind === 'framework') {
    censusFrameworkRow(state, entry, row, data, profile, installed, found, maxReferences);
    return;
  }
  censusDomainRow(entry, row, data, profile, found, maxReferences);
}

/** Framework row: closed fields, validator, then opaque occurrences. */
function censusFrameworkRow(
  state: FileGuardState,
  entry: FileGuardRow,
  row: StoredRow,
  data: Record<string, unknown>,
  profile: FrameworkProfile,
  installed: Map<string, ModelProfile>,
  found: Occurrence[],
  maxReferences: number,
): void {
  const declaration = profile.bound.declaration;
  if (Object.keys(data).some(field => !Object.hasOwn(declaration.fields, field))) return refuse('unknown owning framework field');
  for (const [field, descriptor] of Object.entries(declaration.fields)) {
    censusOneFrameworkField(data, field, descriptor);
  }
  try { profile.bound.validateRow(entry.model as ModelName, row); }
  catch { return refuse('actual owning framework validator refused row'); }
  for (const [field, descriptor] of Object.entries(declaration.fields)) {
    if (descriptor.kind !== 'opaque' || descriptor.role === 'payload-origin') continue;
    if (descriptor.role === 'deferred-input' && descriptor.optional === true && !Object.hasOwn(data, field)) continue;
    const references = opaqueOccurrences(state, entry.model, row, field, descriptor.role, profile,
      installed.get(entry.model));
    for (const reference of references) {
      if (found.length === maxReferences) return refuse('complete File census exceeds bound');
      found.push({ ref: reference.ref, key: stableStringify([entry.model, row.id, row.created, row.createdBy,
        field, reference.path, reference.ref]) });
    }
  }
}

/** One owning framework field: presence, opaque link, or control shape. */
function censusOneFrameworkField(
  data: Record<string, unknown>,
  field: string,
  descriptor: FrameworkFileReferenceModel['fields'][string],
): void {
  if (!Object.hasOwn(data, field)) {
    if (descriptor.kind === 'control' && descriptor.optional === true ||
        descriptor.kind === 'opaque' && (descriptor.role === 'payload-origin' || descriptor.role === 'deferred-input') && descriptor.optional === true) return;
    return refuse('required owning framework field absent');
  }
  if (descriptor.kind === 'opaque') {
    if (descriptor.role === 'payload-origin' && !Object.hasOwn(data, descriptor.payloadField)) return refuse('orphan opaque payload origin');
    return;
  }
  const value = data[field];
  if (value === null && descriptor.nullable === true) return;
  if (descriptor.value === 'object') {
    keys(value, Object.keys(descriptor.fields));
    if (Object.values(object(value)).some(member => typeof member !== 'string')) return refuse('closed owning structured controls disagree');
    return;
  }
  if (descriptor.value === 'string-array' ? !Array.isArray(value) || value.some(item => typeof item !== 'string') :
      typeof value !== descriptor.value || descriptor.value === 'number' && !Number.isFinite(value)) return refuse('owning framework control shape disagrees');
}

/** Domain row: required fields, then per-field File occurrences. */
function censusDomainRow(
  entry: FileGuardRow,
  row: StoredRow,
  data: Record<string, unknown>,
  profile: DomainProfile,
  found: Occurrence[],
  maxReferences: number,
): void {
  for (const required of profile.required) if (!Object.hasOwn(data, required)) return refuse('required stored field absent');
  for (const [field, wire] of Object.entries(data)) {
    const fieldProfile = profile.fields.get(field);
    if (fieldProfile === undefined) return refuse('unknown stored field');
    let occurrences;
    try { occurrences = fileReferenceOccurrences(fieldProfile, wire); }
    catch { return refuse('stored value violates owning declarations'); }
    for (const occurrence of occurrences) {
      if (found.length === maxReferences) return refuse('complete File census exceeds bound');
      found.push({ ref: occurrence.ref, key: stableStringify([entry.model, row.id, row.created, row.createdBy, field, occurrence.path, occurrence.ref]) });
    }
  }
}
function retainOpaqueLifetimes(state: FileGuardState, rows: readonly FileGuardRow[], framework: FileFrameworkBinding): FileGuardState {
  const lifetimes = new Map(state.opaqueLifetimes.map(lifetime => [stableStringify(lifetime.binding.slot), lifetime]));
  let changed = false, count = state.opaqueLifetimes.reduce((sum, lifetime) => sum + lifetime.files.length, 0);
  // Only called after the complete owning census has validated these actual
  // headers and all typed positions. Historical facts are not a reference pin.
  for (const entry of rows) {
    const declaration = framework.get(entry.model)?.declaration;
    if (declaration === undefined) continue;
    for (const [field, descriptor] of Object.entries(declaration.fields)) {
      if (descriptor.kind !== 'opaque' || descriptor.role !== 'payload-origin') continue;
      const header = entry.row.data[field];
      if (header === undefined) continue;
      const { files: current, ...binding } = fileGuardCopy(header) as unknown as FrameworkFilePayloadOrigin;
      const key = stableStringify(binding.slot), previous = lifetimes.get(key);
      if (previous !== undefined && !fileGuardEqual(previous.binding, binding)) return refuse('original opaque lifetime binding cannot be replaced');
      if (previous === undefined && lifetimes.size === FILE_GUARD_MAX_ROWS) return refuse('durable opaque lifetimes exceed bound');
      const facts = new Map((previous?.files ?? []).map(file => [file.ref, file]));
      let added = previous === undefined;
      for (const evidence of current) {
        const original = facts.get(evidence.file.ref);
        if (original !== undefined) {
          if (!fileGuardEqual(original, evidence.file)) return refuse('original receiving File facts cannot be renewed');
        } else {
          if (++count > FILE_GUARD_MAX_REFERENCES) return refuse('durable original File facts exceed bound');
          facts.set(evidence.file.ref, evidence.file); added = true;
        }
      }
      if (added) {
        lifetimes.set(key, { binding, files: [...facts.values()] }); changed = true;
      }
    }
  }
  return changed ? { ...state, opaqueLifetimes: fileGuardCopy([...lifetimes.values()]) } : state;
}
/** One surviving row: opaque lifetime bindings stay attached and unrenewed. */
function checkBarrierEntry(
  prior: ReadonlyMap<string, StoredRow>,
  entry: FileGuardRow,
  framework: FileFrameworkBinding,
): void {
  const old = prior.get(stableStringify([entry.model, entry.row.id, entry.row.created, entry.row.createdBy]));
  if (old === undefined) return;
  const declaration = framework.get(entry.model)?.declaration;
  if (declaration === undefined) return;
  for (const [field, descriptor] of Object.entries(declaration.fields)) {
    if (descriptor.kind !== 'opaque' || descriptor.role !== 'payload-origin') continue;
    checkBarrierField(old, entry, field);
  }
}

/** One payload-origin field: attach/remove refused, facts never renewed. */
function checkBarrierField(old: StoredRow, entry: FileGuardRow, field: string): void {
  const previous = old.data[field], next = entry.row.data[field];
  if (previous === undefined && next === undefined) return;
  if (previous === undefined || next === undefined) return refuse('original opaque lifetime binding cannot be attached or removed');
  const left = fileGuardCopy(previous) as unknown as FrameworkFilePayloadOrigin;
  const right = fileGuardCopy(next) as unknown as FrameworkFilePayloadOrigin;
  const { files: oldFiles, ...oldIdentity } = left;
  const { files: newFiles, ...newIdentity } = right;
  if (!fileGuardEqual(oldIdentity, newIdentity) || !Array.isArray(oldFiles) || !Array.isArray(newFiles)) return refuse('original opaque lifetime binding cannot be replaced');
  // A keyed schedule's event arguments are the due handler's private source.
  // Its state/version can advance to admitted, but the original payload must
  // remain the bytes captured with the installed event-input header.
  if (oldIdentity.origin.kind === 'event-input' && oldIdentity.origin.target.kind === 'schedule' &&
      oldIdentity.slot.model === 'work.schedule' && oldIdentity.slot.field === 'payload' &&
      !fileGuardEqual(old.data['payload'], entry.row.data['payload'])) {
    return refuse('original scheduled event payload cannot change within its retained lifetime');
  }
  const retained = new Map(oldFiles.map(evidence => [evidence.file.ref, evidence.file]));
  for (const evidence of newFiles) if (retained.has(evidence.file.ref) &&
      !fileGuardEqual(retained.get(evidence.file.ref), evidence.file)) return refuse('original receiving File facts cannot be renewed');
}

function barrier(state: FileGuardState, before: readonly FileGuardRow[], afterState: FileGuardState, after: readonly FileGuardRow[], framework: FileFrameworkBinding): FileGuardState {
  // Version/phase changes may replace typed values, but cannot replace the
  // original lifetime/source or renew the original facts of a retained File.
  const prior = new Map(before.map(entry => [stableStringify([entry.model, entry.row.id,
    entry.row.created, entry.row.createdBy]), entry.row]));
  for (const entry of after) {
    checkBarrierEntry(prior, entry, framework);
  }
  const old = new Set(census(state, before, FILE_GUARD_MAX_ROWS, FILE_GUARD_MAX_REFERENCES, framework).map(ref => ref.key));
  const retired = new Set(state.retirements.map(fact => fact.file.ref));
  for (const occurrence of census(afterState, after, FILE_GUARD_MAX_ROWS, FILE_GUARD_MAX_REFERENCES, framework)) {
    if (retired.has(occurrence.ref) && !old.has(occurrence.key)) return refuse('permanently retired File reference cannot be introduced');
  }
  // Retain the first facts even when a File, payload or row disappears. A later
  // genuine observation cannot renew the same original slot lifetime.
  return retainOpaqueLifetimes(retainOpaqueLifetimes(afterState, before, framework), after, framework);
}
export function guardFileCommit(state: FileGuardState, binding: FileRetirementAuthority | undefined,
  before: readonly FileGuardRow[], after: readonly FileGuardRow[], framework: FileFrameworkBinding = EMPTY_FRAMEWORK): FileGuardState {
  checkFileBinding(state, binding);
  checkFileFrameworkBinding(state, framework);
  if (state.authority === null) return state;
  // Published chunks can mix two shapes of the same model. Ordinary writers
  // cannot choose a reinterpretation while that activation remains unfinished.
  if (state.migrations.length > 0 && !fileGuardEqual(before, after)) return refuse('migration publication is not yet activated');
  return barrier(state, before, state, after, framework);
}
export interface FileInstallPlan { readonly state: FileGuardState; readonly snapshot: InstalledSnapshot; readonly changed: boolean }
export function planFileInstall(state: FileGuardState, binding: FileRetirementAuthority, input: InstallFileReferenceInventory,
  snapshots: readonly InstalledSnapshot[], rows: readonly FileGuardRow[], nextRevision: Revision, framework: FileFrameworkBinding = EMPTY_FRAMEWORK): FileInstallPlan {
  const request = fileGuardCopy(input), authority = checkedFileAuthority(request.authority);
  if (!fileGuardEqual(authority, binding)) return refuse('installation uses foreign assignment');
  checkFileBinding(state, binding);
  checkFileFrameworkBinding(state, framework);
  const inventory = checkedFileInventory(request.inventory, framework);
  snapshotIdentity(request.snapshot, inventory);
  if (!Number.isFinite(request.snapshot.installedAt) || !Number.isSafeInteger(request.snapshot.installedRevision) || request.snapshot.installedRevision < 0) return refuse('valid installed snapshot facts required');
  if (state.migrations.length > 0) return refuse('unfinished migration declarations');
  const existing = snapshots.find(snapshot => snapshot.owner === inventory.owner);
  if (existing !== undefined) snapshotIdentity(existing, inventory);
  const previous = state.inventories.find(item => item.inventory.owner === inventory.owner);
  if (previous !== undefined && !fileGuardEqual(previous.inventory, inventory)) return refuse('installed declarations cannot be replaced without migration');
  const snapshot = existing ?? { ...request.snapshot, installedRevision: nextRevision };
  if (previous !== undefined && !fileGuardEqual(previous.snapshot, snapshot)) return refuse('original installation facts disagree');
  const installed = { authority, snapshot, inventory };
  let next: FileGuardState = { ...state, authority, inventories: [...state.inventories.filter(item => item.inventory.owner !== inventory.owner), installed] };
  if (state.authority === null) {
    census(next, rows, FILE_GUARD_MAX_ROWS, FILE_GUARD_MAX_REFERENCES, framework);
    next = retainOpaqueLifetimes(next, rows, framework);
  } else next = barrier(state, rows, next, rows, framework);
  return { state: next, snapshot, changed: state.authority === null || previous === undefined };
}
export function guardFilePublish(state: FileGuardState, binding: FileRetirementAuthority | undefined, migrationId: string,
  inventoryInput: FileReferenceInventory | undefined, before: readonly FileGuardRow[], after: readonly FileGuardRow[],
  published: readonly { readonly model: string; readonly id: string }[], dropped: readonly { readonly model: string; readonly id: string }[], framework: FileFrameworkBinding = EMPTY_FRAMEWORK): FileGuardState {
  checkFileBinding(state, binding);
  checkFileFrameworkBinding(state, framework);
  if (state.authority === null) return state;
  if (!text(migrationId) || inventoryInput === undefined) return refuse('published target declarations required');
  const inventory = checkedFileInventory(inventoryInput, framework), previous = state.migrations.find(item => item.migrationId === migrationId);
  if (previous !== undefined && !fileGuardEqual(previous.inventory, inventory)) return refuse('migration target declarations changed');
  if (state.migrations.some(item => item.migrationId !== migrationId)) return refuse('another declaration migration is unfinished');
  const publications = new Map(state.publications.map(item => [stableStringify([item.model, item.id]), item]));
  for (const row of published) publications.set(stableStringify([row.model, row.id]), { ...row, migrationId });
  for (const row of dropped) publications.delete(stableStringify([row.model, row.id]));
  const next = { ...state, migrations: [{ migrationId, inventory }], publications: [...publications.values()] };
  return barrier(state, before, next, after, framework);
}
export function guardFileFlip(state: FileGuardState, binding: FileRetirementAuthority | undefined, input: {
  readonly owner: string; readonly migrationId: string; readonly snapshot: InstalledSnapshot | null;
  readonly renameFromOwner: string | null; readonly fileReferenceInventory?: FileReferenceInventory | null;
}, rows: readonly FileGuardRow[], nextRevision: Revision, existing: InstalledSnapshot | null, framework: FileFrameworkBinding = EMPTY_FRAMEWORK): FileGuardState {
  checkFileBinding(state, binding);
  checkFileFrameworkBinding(state, framework);
  if (state.authority === null) return state;
  if (!Object.hasOwn(input, 'fileReferenceInventory')) return refuse('activation declarations required');
  const target = state.migrations.find(item => item.migrationId === input.migrationId);
  let inventories = state.inventories.filter(item => item.inventory.owner !== input.owner && item.inventory.owner !== input.renameFromOwner);
  if (input.snapshot === null) {
    if (input.fileReferenceInventory !== null || input.renameFromOwner !== null) return refuse('closed owner removal required');
  } else {
    if (input.fileReferenceInventory == null) return refuse('complete activation declarations required');
    const inventory = checkedFileInventory(input.fileReferenceInventory, framework);
    snapshotIdentity(input.snapshot, inventory);
    const current = state.inventories.find(item => item.inventory.owner === input.owner);
    const same = existing !== null && existing.snapshotId === input.snapshot.snapshotId && existing.digest === input.snapshot.digest;
    if (same) {
      if (state.migrations.length || state.publications.length) return refuse('pending migration cannot use idempotent activation shortcut');
      if (current === undefined || !fileGuardEqual(current.inventory, inventory) || !fileGuardEqual(current.snapshot, existing)) return refuse('idempotent activation declarations disagree');
    } else if (target === undefined || !fileGuardEqual(target.inventory, inventory)) return refuse('exact published target declarations required');
    inventories = [...inventories, { authority: state.authority, inventory, snapshot: same ? existing : { ...input.snapshot, installedRevision: nextRevision } }];
  }
  if (state.migrations.some(item => item.migrationId !== input.migrationId)) return refuse('mixed activation declarations');
  const next = { ...state, inventories, migrations: [], publications: [] };
  return barrier(state, rows, next, rows, framework);
}
function checkedFile(input: FinalizedFileIdentity, authority: FileRetirementAuthority): FinalizedFileIdentity {
  const file = fileGuardCopy(input);
  keys(file, ['ref', 'receiver', 'provenance', 'contentType', 'sizeBytes', 'bytesDigest', 'finalizedAtMs']);
  keys(file.receiver, ['app', 'team', 'owner', 'principal']);
  if (!text(file.ref) || !text(file.contentType) || !text(file.bytesDigest) || !text(file.receiver.principal) ||
      !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || !Number.isSafeInteger(file.finalizedAtMs) || file.finalizedAtMs < 0 ||
      !fileGuardEqual({ app: file.receiver.app, team: file.receiver.team, owner: file.receiver.owner }, authority.receiver)) return refuse('immutable physical File identity required');
  try { assertSafeBlobKey(file.ref); } catch { return refuse('safe File identity required'); }
  if (file.provenance.kind === 'request') {
    keys(file.provenance, ['kind', 'app', 'team', 'owner', 'principal', 'adapter', 'deliveryId', 'resultPath']);
    if (!fileGuardEqual({ app: file.provenance.app, team: file.provenance.team, owner: file.provenance.owner, principal: file.provenance.principal }, file.receiver) ||
        ![file.provenance.adapter, file.provenance.deliveryId, file.provenance.resultPath].every(text)) return refuse('original request provenance required');
  } else if (file.provenance.kind === 'event') {
    keys(file.provenance, ['kind', 'source', 'adapter', 'occurrenceId', 'fieldPath', 'itemIndex']);
    if (![file.provenance.source, file.provenance.adapter, file.provenance.occurrenceId, file.provenance.fieldPath].every(text) ||
        !Number.isSafeInteger(file.provenance.itemIndex) || file.provenance.itemIndex < 0) return refuse('original event provenance required');
  } else return refuse('original finalized provenance required');
  return file;
}
/** Copied retirement request with checked File and retention policy. */
function checkRetirementRequest(
  input: RetireFinalizedFile,
  binding: FileRetirementAuthority,
): { request: RetireFinalizedFile; file: FinalizedFileIdentity } {
  const request = fileGuardCopy(input), file = checkedFile(request.file, binding);
  keys(request.retention, ['unattachedHorizonMs', 'retentionMs', ...(Object.hasOwn(request.retention, 'retainAttached') ? ['retainAttached'] : [])]);
  if (Object.hasOwn(request.retention, 'retainAttached') && request.retention.retainAttached !== true) return refuse('invalid attached File retention policy');
  if (request.retention.retainAttached === true && request.disposition === 'expired') return refuse('retained attached Files require explicit orphan retirement');
  if (![request.retention.unattachedHorizonMs, request.retention.retentionMs, request.atMs].every(value => Number.isSafeInteger(value) && value >= 0) ||
      ![request.maxRows, request.maxReferences].every(value => Number.isSafeInteger(value) && value > 0) ||
      request.disposition !== 'orphaned' && request.disposition !== 'expired') return refuse('finite original retention and complete bounds required');
  return { request, file };
}

/** Existing permanent identity must agree before returning it unchanged. */
function checkRetirementPrevious(
  previous: FinalizedFileRetirement,
  file: FinalizedFileIdentity,
  request: RetireFinalizedFile,
): void {
  if (!fileGuardEqual(previous.file, file) || !fileGuardEqual(previous.retention, request.retention) || previous.disposition !== request.disposition ||
      previous.snapshot.owner !== request.inventory.owner || previous.snapshot.snapshotId !== request.inventory.snapshotId || previous.snapshot.digest !== request.inventory.digest) {
    return refuse('permanent retirement identity cannot be replaced');
  }
}

/** Existing decisions are returned unchanged without reopening admission. */
export function planFileRetirement(state: FileGuardState, binding: FileRetirementAuthority, input: RetireFinalizedFile,
  rows: readonly FileGuardRow[], nextRevision: Revision, framework: FileFrameworkBinding = EMPTY_FRAMEWORK): { readonly fact: FinalizedFileRetirement; readonly fresh: boolean } {
  checkFileBinding(state, binding);
  checkFileFrameworkBinding(state, framework);
  if (state.authority === null) return refuse('persisted authoritative assignment required');
  const { request, file } = checkRetirementRequest(input, binding);
  identity(request.inventory);
  const previous = state.retirements.find(fact => fact.file.ref === file.ref);
  if (previous !== undefined) {
    checkRetirementPrevious(previous, file, request);
    return { fact: fileGuardCopy(previous), fresh: false };
  }
  if (state.migrations.length > 0 || state.publications.length > 0) return refuse('mixed migration census cannot retire a File');
  const installed = state.inventories.find(item => item.inventory.owner === request.inventory.owner);
  if (installed === undefined || installed.inventory.snapshotId !== request.inventory.snapshotId || installed.inventory.digest !== request.inventory.digest) return refuse('exact original installed inventory required');
  const references = census(state, rows, request.maxRows, request.maxReferences, framework);
  const horizon = file.finalizedAtMs + (request.disposition === 'orphaned' ? request.retention.unattachedHorizonMs : request.retention.retentionMs);
  if (!Number.isSafeInteger(horizon) || request.atMs < horizon) return refuse('original retention horizon has not elapsed');
  if (request.disposition === 'orphaned' && references.some(occurrence => occurrence.ref === file.ref)) return refuse('committed references prevent orphan retirement');
  return { fresh: true, fact: fileGuardCopy({ retirementId: `state-file-retirement/v1/${encodeURIComponent(binding.stateStoreId)}/${encodeURIComponent(binding.fileStoreId)}/${encodeURIComponent(file.ref)}/${nextRevision}`,
    authority: binding, file, snapshot: installed.snapshot, censusRevision: request.expectedRevision,
    retiredRevision: nextRevision, retiredAtMs: request.atMs, disposition: request.disposition, retention: request.retention }) };
}
