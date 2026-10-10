/** Backend-neutral validation only. Durable issuance belongs to the adapter's
 * original transaction, never this module or a copied fact. */
import type { FileReferenceInventory, FileRetirementAuthority, FinalizedFileIdentity,
  FinalizedFileRetirement, InstallFileReferenceInventory, InstalledFileReferenceInventory,
  InstalledSnapshot, ModelName, RetireFinalizedFile, Revision, StoredRow, CanonicalFieldDef } from '@canlang/contracts';
import { assertSafeBlobKey } from '@canlang/files/ports';
import { normalizeValueTypes, parseTypeId, printTypeId } from '@canlang/values';
import { copyScenarioFileData } from '../invocation/scenario-file-assignment.js';
import { stableStringify } from '../invocation/replay.js';
import { deepFreeze } from '../internal/own-data.js';
import { bindFileReferenceProfile, fileReferenceOccurrences, type FileReferenceProfile } from '../ports/file-reference-profile.js';
import { StorageConstraintError } from './port.js';

export const FILE_GUARD_MAX_ROWS = 100_000;
export const FILE_GUARD_MAX_REFERENCES = 1_000_000;
export interface FileGuardRow { readonly model: string; readonly row: StoredRow }
export interface FileGuardMigration { readonly migrationId: string; readonly inventory: FileReferenceInventory }
export interface FileGuardPublication { readonly model: string; readonly id: string; readonly migrationId: string }
export interface FileGuardState {
  readonly authority: FileRetirementAuthority | null;
  readonly inventories: readonly InstalledFileReferenceInventory[];
  readonly migrations: readonly FileGuardMigration[];
  /** The exact rows actually published with target declarations. Shadow rows
   * alone never establish a live target interpretation. */
  readonly publications: readonly FileGuardPublication[];
  readonly retirements: readonly FinalizedFileRetirement[];
}
export function emptyFileGuard(): FileGuardState {
  return { authority: null, inventories: [], migrations: [], publications: [], retirements: [] };
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
export function fileGuardCopy<T>(value: T): T {
  try { return deepFreeze(copyScenarioFileData(value) as T); }
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
    if (state.inventories.length || state.migrations.length || state.publications.length || state.retirements.length) return refuse('durable facts have no permanent assignment');
    return;
  }
  checkedFileAuthority(state.authority);
  if (state.authority !== null && binding !== undefined && !fileGuardEqual(state.authority, binding)) return refuse('persisted assignment mismatch');
  for (const installed of state.inventories) {
    if (!fileGuardEqual(installed.authority, state.authority)) return refuse('inventory belongs to foreign assignment');
    snapshotIdentity(installed.snapshot, installed.inventory);
  }
  const retired = new Set<string>();
  for (const fact of state.retirements) {
    keys(fact, ['retirementId', 'authority', 'file', 'snapshot', 'censusRevision', 'retiredRevision', 'retiredAtMs', 'disposition', 'retention']);
    checkedFile(fact.file, state.authority);
    keys(fact.retention, ['unattachedHorizonMs', 'retentionMs']);
    identity(fact.snapshot);
    if (!fileGuardEqual(fact.authority, state.authority) || !text(fact.retirementId) || retired.has(fact.file.ref) ||
        !Number.isSafeInteger(fact.censusRevision) || fact.censusRevision < 0 || fact.retiredRevision !== fact.censusRevision + 1 ||
        !Number.isSafeInteger(fact.retiredRevision) || !Number.isSafeInteger(fact.snapshot.installedRevision) || fact.snapshot.installedRevision < 0 ||
        fact.snapshot.installedRevision > fact.censusRevision || !Number.isFinite(fact.snapshot.installedAt) ||
        ![fact.retention.unattachedHorizonMs, fact.retention.retentionMs].every(value => Number.isSafeInteger(value) && value >= 0) ||
        !Number.isSafeInteger(fact.retiredAtMs) || fact.retiredAtMs < fact.file.finalizedAtMs ||
        fact.disposition !== 'orphaned' && fact.disposition !== 'expired') return refuse('invalid permanent retirement facts');
    retired.add(fact.file.ref);
  }
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
interface ModelProfile { readonly fields: ReadonlyMap<string, FileReferenceProfile>; readonly required: ReadonlySet<string> }
function profiles(input: FileReferenceInventory): ReadonlyMap<string, ModelProfile> {
  const inventory = fileGuardCopy(input);
  keys(inventory, ['owner', 'snapshotId', 'digest', 'canonicalModels', 'artifactModels', 'valueTypes']);
  identity(inventory);
  if (!Array.isArray(inventory.canonicalModels) || !Array.isArray(inventory.artifactModels) ||
      inventory.canonicalModels.length !== inventory.artifactModels.length || inventory.canonicalModels.length > 200 ||
      !Array.isArray(inventory.valueTypes?.contracts)) return refuse('complete explicit declarations required');
  const artifacts = new Map(inventory.artifactModels.map(model => [model.name as ModelName, model]));
  if (artifacts.size !== inventory.artifactModels.length) return refuse('duplicate artifact model');
  const result = new Map<string, ModelProfile>();
  try {
    const valueSchema = normalizeValueTypes(inventory.valueTypes, inventory.canonicalModels.map(model => model.name)).valueSchema;
    for (const model of inventory.canonicalModels) {
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
      result.set(model.name, { fields, required });
    }
  } catch (error) {
    if (error instanceof StorageConstraintError) throw error;
    return refuse('invalid complete declaration correspondence');
  }
  return result;
}
export function checkedFileInventory(input: FileReferenceInventory): FileReferenceInventory {
  const value = fileGuardCopy(input); profiles(value); return value;
}
function modelProfiles(inventories: readonly InstalledFileReferenceInventory[]): Map<string, ModelProfile> {
  const result = new Map<string, ModelProfile>(), owners = new Set<string>();
  for (const installed of inventories) {
    snapshotIdentity(installed.snapshot, installed.inventory);
    if (owners.has(installed.inventory.owner)) return refuse('duplicate installed owner');
    owners.add(installed.inventory.owner);
    for (const [name, profile] of profiles(installed.inventory)) {
      if (result.has(name)) return refuse('colliding installed model declarations');
      result.set(name, profile);
    }
  }
  return result;
}
interface Occurrence { readonly ref: string; readonly key: string }
/** Complete live rows include archived data. Missing optional fields are absent;
 * explicit nullable values and every nested/collection position are validated. */
function census(state: FileGuardState, rows: readonly FileGuardRow[], maxRows: number, maxReferences: number): readonly Occurrence[] {
  if (rows.length > maxRows) return refuse('complete row census exceeds bound');
  const installed = modelProfiles(state.inventories);
  const targets = new Map(state.migrations.map(migration => [migration.migrationId, profiles(migration.inventory)]));
  if (targets.size !== state.migrations.length) return refuse('duplicate migration declaration identity');
  const published = new Map(state.publications.map(row => [stableStringify([row.model, row.id]), row.migrationId]));
  if (published.size !== state.publications.length) return refuse('duplicate published row identity');
  const found: Occurrence[] = [], seen = new Set<string>();
  for (const entry of rows) {
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
  return found;
}
function barrier(state: FileGuardState, before: readonly FileGuardRow[], afterState: FileGuardState, after: readonly FileGuardRow[]): void {
  const old = new Set(census(state, before, FILE_GUARD_MAX_ROWS, FILE_GUARD_MAX_REFERENCES).map(ref => ref.key));
  const retired = new Set(state.retirements.map(fact => fact.file.ref));
  for (const occurrence of census(afterState, after, FILE_GUARD_MAX_ROWS, FILE_GUARD_MAX_REFERENCES)) {
    if (retired.has(occurrence.ref) && !old.has(occurrence.key)) return refuse('permanently retired File reference cannot be introduced');
  }
}
export function guardFileCommit(state: FileGuardState, binding: FileRetirementAuthority | undefined,
  before: readonly FileGuardRow[], after: readonly FileGuardRow[]): void {
  checkFileBinding(state, binding);
  if (state.authority === null) return;
  // Published chunks can mix two shapes of the same model. Ordinary writers
  // cannot choose a reinterpretation while that activation remains unfinished.
  if (state.migrations.length > 0 && !fileGuardEqual(before, after)) return refuse('migration publication is not yet activated');
  barrier(state, before, state, after);
}
export interface FileInstallPlan { readonly state: FileGuardState; readonly snapshot: InstalledSnapshot; readonly changed: boolean }
export function planFileInstall(state: FileGuardState, binding: FileRetirementAuthority, input: InstallFileReferenceInventory,
  snapshots: readonly InstalledSnapshot[], rows: readonly FileGuardRow[], nextRevision: Revision): FileInstallPlan {
  const request = fileGuardCopy(input), authority = checkedFileAuthority(request.authority);
  if (!fileGuardEqual(authority, binding)) return refuse('installation uses foreign assignment');
  checkFileBinding(state, binding);
  const inventory = checkedFileInventory(request.inventory);
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
  const next: FileGuardState = { ...state, authority, inventories: [...state.inventories.filter(item => item.inventory.owner !== inventory.owner), installed] };
  if (state.authority === null) census(next, rows, FILE_GUARD_MAX_ROWS, FILE_GUARD_MAX_REFERENCES);
  else barrier(state, rows, next, rows);
  return { state: next, snapshot, changed: state.authority === null || previous === undefined };
}
export function guardFilePublish(state: FileGuardState, binding: FileRetirementAuthority | undefined, migrationId: string,
  inventoryInput: FileReferenceInventory | undefined, before: readonly FileGuardRow[], after: readonly FileGuardRow[],
  published: readonly { readonly model: string; readonly id: string }[], dropped: readonly { readonly model: string; readonly id: string }[]): FileGuardState {
  checkFileBinding(state, binding);
  if (state.authority === null) return state;
  if (!text(migrationId) || inventoryInput === undefined) return refuse('published target declarations required');
  const inventory = checkedFileInventory(inventoryInput), previous = state.migrations.find(item => item.migrationId === migrationId);
  if (previous !== undefined && !fileGuardEqual(previous.inventory, inventory)) return refuse('migration target declarations changed');
  if (state.migrations.some(item => item.migrationId !== migrationId)) return refuse('another declaration migration is unfinished');
  const publications = new Map(state.publications.map(item => [stableStringify([item.model, item.id]), item]));
  for (const row of published) publications.set(stableStringify([row.model, row.id]), { ...row, migrationId });
  for (const row of dropped) publications.delete(stableStringify([row.model, row.id]));
  const next = { ...state, migrations: [{ migrationId, inventory }], publications: [...publications.values()] };
  barrier(state, before, next, after);
  return next;
}
export function guardFileFlip(state: FileGuardState, binding: FileRetirementAuthority | undefined, input: {
  readonly owner: string; readonly migrationId: string; readonly snapshot: InstalledSnapshot | null;
  readonly renameFromOwner: string | null; readonly fileReferenceInventory?: FileReferenceInventory | null;
}, rows: readonly FileGuardRow[], nextRevision: Revision, existing: InstalledSnapshot | null): FileGuardState {
  checkFileBinding(state, binding);
  if (state.authority === null) return state;
  if (!Object.hasOwn(input, 'fileReferenceInventory')) return refuse('activation declarations required');
  const target = state.migrations.find(item => item.migrationId === input.migrationId);
  let inventories = state.inventories.filter(item => item.inventory.owner !== input.owner && item.inventory.owner !== input.renameFromOwner);
  if (input.snapshot === null) {
    if (input.fileReferenceInventory !== null || input.renameFromOwner !== null) return refuse('closed owner removal required');
  } else {
    if (input.fileReferenceInventory == null) return refuse('complete activation declarations required');
    const inventory = checkedFileInventory(input.fileReferenceInventory);
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
  barrier(state, rows, next, rows);
  return next;
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
/** Existing decisions are returned unchanged without reopening admission. */
export function planFileRetirement(state: FileGuardState, binding: FileRetirementAuthority, input: RetireFinalizedFile,
  rows: readonly FileGuardRow[], nextRevision: Revision): { readonly fact: FinalizedFileRetirement; readonly fresh: boolean } {
  checkFileBinding(state, binding);
  if (state.authority === null) return refuse('persisted authoritative assignment required');
  const request = fileGuardCopy(input), file = checkedFile(request.file, binding);
  keys(request.retention, ['unattachedHorizonMs', 'retentionMs']);
  if (![request.retention.unattachedHorizonMs, request.retention.retentionMs, request.atMs].every(value => Number.isSafeInteger(value) && value >= 0) ||
      ![request.maxRows, request.maxReferences].every(value => Number.isSafeInteger(value) && value > 0) ||
      request.disposition !== 'orphaned' && request.disposition !== 'expired') return refuse('finite original retention and complete bounds required');
  identity(request.inventory);
  const previous = state.retirements.find(fact => fact.file.ref === file.ref);
  if (previous !== undefined) {
    if (!fileGuardEqual(previous.file, file) || !fileGuardEqual(previous.retention, request.retention) || previous.disposition !== request.disposition ||
        previous.snapshot.owner !== request.inventory.owner || previous.snapshot.snapshotId !== request.inventory.snapshotId || previous.snapshot.digest !== request.inventory.digest) return refuse('permanent retirement identity cannot be replaced');
    return { fact: fileGuardCopy(previous), fresh: false };
  }
  if (state.migrations.length > 0 || state.publications.length > 0) return refuse('mixed migration census cannot retire a File');
  const installed = state.inventories.find(item => item.inventory.owner === request.inventory.owner);
  if (installed === undefined || installed.inventory.snapshotId !== request.inventory.snapshotId || installed.inventory.digest !== request.inventory.digest) return refuse('exact original installed inventory required');
  const references = census(state, rows, request.maxRows, request.maxReferences);
  const horizon = file.finalizedAtMs + (request.disposition === 'orphaned' ? request.retention.unattachedHorizonMs : request.retention.retentionMs);
  if (!Number.isSafeInteger(horizon) || request.atMs < horizon) return refuse('original retention horizon has not elapsed');
  if (request.disposition === 'orphaned' && references.some(occurrence => occurrence.ref === file.ref)) return refuse('committed references prevent orphan retirement');
  return { fresh: true, fact: fileGuardCopy({ retirementId: `state-file-retirement/v1/${encodeURIComponent(binding.stateStoreId)}/${encodeURIComponent(binding.fileStoreId)}/${encodeURIComponent(file.ref)}/${nextRevision}`,
    authority: binding, file, snapshot: installed.snapshot, censusRevision: request.expectedRevision,
    retiredRevision: nextRevision, retiredAtMs: request.atMs, disposition: request.disposition, retention: request.retention }) };
}
