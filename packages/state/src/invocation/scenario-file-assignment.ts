/** File assignments join owning declarations and authenticated live Files facts.
 * Retained JSON facts are evidence only; they never mint a live observation. */
import type { ArtifactModel, CanonicalModelDescriptor, CanTypeId, FinalizedFileReceiver,
  ModelName, RetainedFinalizedFile } from '@canlang/contracts';
import { readFinalizedFileObservation } from '@canlang/files/finalize';
import { assertSafeBlobKey } from '@canlang/files/ports';
import { decodeValue, encodeValue, parseTypeId, printTypeId, validateValue } from '@canlang/values';
import { StateError } from '../errors.js';
import { deepFreeze } from '../internal/own-data.js';
import { modelFieldConstraintSchema } from '../mutation/models.js';

const invalid = (message: string): never => { throw new StateError('validation', `Saved scenario File: ${message}`); };
const MAX_REFS = 200;

/** Shared finite-copy budget (one top-level detach). */
interface OwnDataBudget {
  nodes: number;
  readonly active: Set<object>;
}

/** One entry in descriptor order: dense-array or own-enumerable-object member. */
function copyOwnDataEntries(
  out: unknown[] | Record<string, unknown>,
  part: object,
  keys: readonly (string | symbol)[],
  array: boolean,
  length: number,
  depth: number,
  budget: OwnDataBudget,
): void {
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(part, key);
    if (typeof key !== 'string' || descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable ||
        array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)) return invalid('own enumerable data required.');
    Object.defineProperty(out, key, { value: copyOwnDataPart(descriptor.value, depth + 1, budget), enumerable: true, writable: true, configurable: true });
  }
}

/** Dense finite array length for one detached node. */
function ownDataArrayLength(part: object, keys: readonly (string | symbol)[]): number {
  const descriptor = Object.getOwnPropertyDescriptor(part, 'length');
  if (descriptor === undefined || !('value' in descriptor) || !Number.isSafeInteger(descriptor.value) ||
      descriptor.value < 0 || descriptor.value > 20_000 || keys.length !== descriptor.value + 1) {
    return invalid('dense finite arrays required.');
  }
  return descriptor.value as number;
}

/** One detached node: primitives pass through, plain objects/arrays recurse. */
function copyOwnDataPart(part: unknown, depth: number, budget: OwnDataBudget): unknown {
  if (++budget.nodes > 20_000 || depth > 32) return invalid('data exceeds its finite budget.');
  if (part === null || typeof part === 'string' || typeof part === 'boolean') return part;
  if (typeof part === 'number' && Number.isFinite(part)) return part;
  if (typeof part !== 'object' || part === null || budget.active.has(part)) return invalid('own JSON data required.');
  const array = Array.isArray(part);
  const prototype = Object.getPrototypeOf(part);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    return invalid('own JSON data required.');
  }
  budget.active.add(part);
  const keys = Reflect.ownKeys(part);
  if (keys.length > 20_000 - budget.nodes) return invalid('data exceeds its finite budget.');
  const out: unknown[] | Record<string, unknown> = array ? [] : {};
  const length = array ? ownDataArrayLength(part, keys) : 0;
  copyOwnDataEntries(out, part, keys, array, length, depth, budget);
  budget.active.delete(part);
  return out;
}

/** Inspect descriptors before reading values, and detach the entire finite JSON tree. */
function copyData(value: unknown): unknown {
  try { return copyOwnDataPart(value, 0, { nodes: 0, active: new Set<object>() }); }
  catch (error) { if (error instanceof StateError) throw error; return invalid('own JSON data required.'); }
}

// State's current committed-slot consumer shares this same own-data boundary.
export { copyData as copyScenarioFileData };

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    return invalid('closed data shape required.');
  }
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : invalid('nonempty identity required.');
}
function integer(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid('nonnegative safe integer required.');
}
function ref(value: unknown): string {
  const id = text(value);
  try { assertSafeBlobKey(id); } catch { return invalid('safe File reference required.'); }
  return id;
}
function receiver(value: unknown): FinalizedFileReceiver {
  const record = object(value, ['app', 'team', 'owner', 'principal']);
  return { app: text(record['app']), team: text(record['team']), owner: text(record['owner']), principal: text(record['principal']) };
}
function sameReceiver(left: FinalizedFileReceiver, right: FinalizedFileReceiver): boolean {
  return left.app === right.app && left.team === right.team && left.owner === right.owner && left.principal === right.principal;
}

export function checkRetainedScenarioFile(value: unknown): RetainedFinalizedFile {
  const record = object(copyData(value), ['ref', 'receiver', 'provenance', 'contentType', 'sizeBytes', 'bytesDigest', 'finalizedAtMs', 'retention']);
  const receiving = receiver(record['receiver']);
  const raw = record['provenance'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return invalid('File provenance required.');
  const kind = (raw as Record<string, unknown>)['kind'];
  let provenance: RetainedFinalizedFile['provenance'];
  if (kind === 'request') {
    const source = object(raw, ['kind', 'app', 'team', 'owner', 'principal', 'adapter', 'deliveryId', 'resultPath']);
    provenance = { kind, app: text(source['app']), team: text(source['team']), owner: text(source['owner']),
      principal: text(source['principal']), adapter: text(source['adapter']), deliveryId: text(source['deliveryId']), resultPath: text(source['resultPath']) };
    if (!sameReceiver(provenance, receiving)) return invalid('request provenance differs from its receiver.');
  } else if (kind === 'event') {
    const source = object(raw, ['kind', 'source', 'adapter', 'occurrenceId', 'fieldPath', 'itemIndex']);
    provenance = { kind, source: text(source['source']), adapter: text(source['adapter']), occurrenceId: text(source['occurrenceId']),
      fieldPath: text(source['fieldPath']), itemIndex: integer(source['itemIndex']) };
  } else return invalid('supported File provenance required.');
  const retention = record['retention'];
  const retainsAttached = typeof retention === 'object' && retention !== null && Object.hasOwn(retention, 'retainAttached');
  const policy = object(retention, ['unattachedHorizonMs', 'retentionMs', ...(retainsAttached ? ['retainAttached'] : [])]);
  if (retainsAttached && policy['retainAttached'] !== true) return invalid('retainAttached must be the explicit true policy.');
  const digest = record['bytesDigest'];
  if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) return invalid('exact File bytes digest required.');
  return deepFreeze({ ref: ref(record['ref']), receiver: receiving, provenance, contentType: text(record['contentType']),
    sizeBytes: integer(record['sizeBytes']), bytesDigest: digest, finalizedAtMs: integer(record['finalizedAtMs']),
    retention: { unattachedHorizonMs: integer(policy['unattachedHorizonMs']), retentionMs: integer(policy['retentionMs']),
      ...(retainsAttached ? { retainAttached: true as const } : {}) } });
}

export function readLiveScenarioFile(observation: unknown, expectedReceiver: FinalizedFileReceiver): RetainedFinalizedFile | null {
  // WeakMap lookup is the only operation on the untrusted handle, including proxies.
  const live = readFinalizedFileObservation(observation);
  if (live === null) return null;
  try {
    const checked = checkRetainedScenarioFile(live);
    const expected = receiver(copyData(expectedReceiver));
    return sameReceiver(checked.receiver, expected) ? checked : null;
  } catch { return null; }
}

export interface ScenarioFileFieldProfile {
  readonly type: CanTypeId;
  readonly array: boolean;
  readonly nullable: boolean;
}
const constraints = new WeakMap<ScenarioFileFieldProfile, ReturnType<typeof modelFieldConstraintSchema>>();

/** Owning File declaration pair: detached canonical and authored descriptors. */
function findScenarioFileDeclaration(
  inventory: { readonly artifactModels: ReadonlyMap<ModelName, ArtifactModel>;
    readonly canonicalModels: readonly CanonicalModelDescriptor[] },
  model: ModelName,
  field: string,
): { canonical: CanonicalModelDescriptor['fields'][string]; authored: ArtifactModel['fields'][number] } {
  const declarations = inventory.canonicalModels.filter(candidate => candidate.name === model);
  const artifact = inventory.artifactModels.get(model);
  const candidates = artifact?.fields.filter(candidate => candidate.name === field) ?? [];
  if (declarations.length !== 1 || artifact?.name !== model || candidates.length !== 1) return invalid('exact owning File declaration required.');
  const declaration = declarations[0]!;
  if (!Object.hasOwn(declaration.fields, field)) return invalid('stored File field missing.');
  const canonical = copyData(declaration.fields[field]) as CanonicalModelDescriptor['fields'][string];
  const authored = copyData(candidates[0]) as ArtifactModel['fields'][number];
  if (typeof canonical !== 'object' || canonical === null || Array.isArray(canonical) ||
      typeof authored !== 'object' || authored === null || Array.isArray(authored)) return invalid('owning File descriptors required.');
  checkScenarioFileTag(authored, canonical);
  return { canonical, authored };
}

/** File tag with matching non-derived value type on both descriptors. */
function checkScenarioFileTag(
  authored: ArtifactModel['fields'][number],
  canonical: CanonicalModelDescriptor['fields'][string],
): void {
  const tag = object(authored.field, ['kind']);
  if (tag['kind'] !== 'file' || canonical.default?.kind === 'derived' || authored.default?.kind === 'derived' ||
      canonical.valueType === undefined || authored.valueType !== canonical.valueType) return invalid('checked stored File profile required.');
}

/** File type agreement with owning markers (parse, kind, array, nullability). */
function checkScenarioFileType(
  canonical: CanonicalModelDescriptor['fields'][string],
  authored: ArtifactModel['fields'][number],
): { type: CanTypeId; array: boolean; nullable: boolean } {
  const type = canonical.valueType as CanTypeId;
  const parsed = parseTypeId(type);
  if (parsed.base.kind !== 'file' || parsed.requiredArray || printTypeId(parsed) !== type ||
      parsed.array !== Object.hasOwn(canonical, 'array') || parsed.array !== Object.hasOwn(authored, 'array') ||
      parsed.nullable !== (canonical.nullable === true) || parsed.nullable !== (authored.nullable === true)) {
    return invalid('File type disagrees with owning markers.');
  }
  if (typeof canonical.required !== 'boolean' || typeof canonical.serverOnly !== 'boolean') return invalid('checked stored field markers required.');
  for (const key of ['required', 'serverOnly', 'nullable', 'array', 'trim', 'min', 'max'] as const) {
    if (Object.hasOwn(canonical, key) !== Object.hasOwn(authored, key) || JSON.stringify(canonical[key]) !== JSON.stringify(authored[key])) {
      return invalid('File declarations disagree with owning markers or constraints.');
    }
  }
  if (canonical.array !== undefined) {
    const marker = object(canonical.array, ['required']);
    if (typeof marker['required'] !== 'boolean') return invalid('checked array marker required.');
  }
  if (Object.hasOwn(canonical, 'nullable') && typeof canonical.nullable !== 'boolean') return invalid('checked nullable marker required.');
  return { type, array: parsed.array, nullable: parsed.nullable };
}

export function scenarioFileField(inventory: { readonly artifactModels: ReadonlyMap<ModelName, ArtifactModel>;
  readonly canonicalModels: readonly CanonicalModelDescriptor[] }, model: ModelName, field: string): ScenarioFileFieldProfile {
  if (typeof field !== 'string' || field.length === 0 || field.includes('.') ||
      ['id', 'version', 'created', 'updated', 'createdBy', 'updatedBy', 'archivedAt', 'parent'].includes(field)) {
    return invalid('declared stored File field required.');
  }
  const found = findScenarioFileDeclaration(inventory, model, field);
  try {
    const { type, array, nullable } = checkScenarioFileType(found.canonical, found.authored);
    const constraint = modelFieldConstraintSchema(found.canonical);
    const profile = Object.freeze({ type, array, nullable });
    constraints.set(profile, constraint);
    return profile;
  } catch (error) { if (error instanceof StateError) throw error; return invalid('invalid owning File profile or constraint.'); }
}

export function scenarioFileWireRefs(profile: ScenarioFileFieldProfile, wire: unknown): readonly string[] {
  if (!constraints.has(profile)) return invalid('owning File field profile required.');
  const saved = copyData(wire);
  const refs: string[] = [];
  if (saved === null) {
    if (!profile.nullable) return invalid('nonnullable File field cannot contain null.');
  } else if (profile.array) {
    if (!Array.isArray(saved) || saved.length > MAX_REFS) return invalid('bounded File array required.');
    for (const item of saved) refs.push(ref(object(item, ['id'])['id']));
  } else refs.push(ref(object(saved, ['id'])['id']));
  try {
    const decoded = decodeValue(profile.type, saved);
    if (JSON.stringify(encodeValue(profile.type, decoded)) !== JSON.stringify(saved)) return invalid('canonical stored File wire required.');
    const constraint = constraints.get(profile);
    if (constraint !== undefined) validateValue(constraint.schema, constraint.type, { value: saved }, 'create');
  } catch (error) { if (error instanceof StateError) throw error; return invalid('File wire violates its owning value profile or constraints.'); }
  return Object.freeze(refs);
}
