/** Typed frozen SEND lexical snapshots; traversal facts never grant live authority. */
import type { CanTypeId, ModelName } from '@canlang/contracts';
import { parseTypeId, printTypeId } from '@canlang/values';
import { StateError } from '../errors.js';
import { copyScenarioFileData } from '../invocation/scenario-file-assignment.js';
import { stableStringify } from '../invocation/replay.js';
import { deepFreeze } from '../internal/own-data.js';
import { bindDeclaredFileReferenceProfile, bindFileReferenceProfile, fileReferenceOccurrences,
  type FileReferenceProfile, type FileReferenceProfileBound, type FileReferenceOccurrence } from './file-reference-profile.js';

export interface ModelLexicalSnapshotProfile { readonly type: CanTypeId; readonly model: ModelName }
const profiles = new WeakMap<ModelLexicalSnapshotProfile, {
  readonly parent: string | undefined;
  readonly fields: ReadonlyMap<string, FileReferenceProfile | Error>;
}>();
const refuse = (message: string): never => { throw new StateError('validation', `Model lexical snapshot: ${message}`); };
function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      keys !== undefined && (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)))) {
    return refuse('closed owning object required.');
  }
  return value as Record<string, unknown>;
}
function identity(value: unknown): string {
  return typeof value === 'string' && value !== '' && !/[\u0000-\u001f\u007f]/.test(value)
    ? value : refuse('nonempty safe identity required.');
}
function integer(value: unknown, minimum = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
    ? value : refuse('canonical nonnegative integer required.');
}

export function bindModelLexicalSnapshotProfile(bound: FileReferenceProfileBound,
  type: CanTypeId): ModelLexicalSnapshotProfile | undefined {
  const ast = parseTypeId(type);
  if (printTypeId(ast) !== type) return refuse('canonical type required.');
  if (ast.base.kind !== 'nominal') return undefined;
  const model = ast.base.path as ModelName;
  const declarations = bound.canonicalModels.filter(declaration => declaration.name === model);
  const original = bound.artifactModels.get(model);
  if (declarations.length === 0 && original === undefined) return undefined;
  if (ast.array || ast.nullable || !model.includes('.') || declarations.length !== 1 || original?.name !== model) {
    return refuse('exact singular qualified same-load model required.');
  }
  // This existing binder verifies complete same-load inventories and namespace collisions.
  bindDeclaredFileReferenceProfile(bound, type);
  const canonical = copyScenarioFileData(declarations[0]!) as typeof declarations[number];
  const artifact = copyScenarioFileData(original) as typeof original;
  const names = artifact.fields.map(field => field.name);
  if (new Set(names).size !== names.length || names.length !== Object.keys(canonical.fields).length ||
      names.some(name => !Object.hasOwn(canonical.fields, name))) return refuse('complete matching owning field inventory required.');
  const parent = artifact.parent;
  if (parent !== undefined && (artifact.scope !== undefined || parent === model || !bound.artifactModels.has(parent as ModelName))) {
    return refuse('actual owning containment declaration required.');
  }
  if (artifact.deleteMode !== canonical.deleteMode) return refuse('owning model declarations disagree.');
  const fields = new Map<string, FileReferenceProfile | Error>();
  for (const field of artifact.fields) {
    const declared = canonical.fields[field.name]!;
    for (const key of ['required', 'serverOnly', 'array', 'nullable', 'trim', 'min', 'max', 'default'] as const) {
      if (Object.hasOwn(declared, key) !== Object.hasOwn(field, key) ||
          Object.hasOwn(declared, key) && stableStringify(declared[key]) !== stableStringify(field[key])) {
        return refuse('owning field declarations disagree.');
      }
    }
    if (field.field.kind === 'secret') {
      fields.set(field.name, new StateError('validation', 'Model lexical snapshot: secret field is unavailable.'));
      continue;
    }
    fields.set(field.name, bindFileReferenceProfile(bound, model, field.name));
  }
  const profile = Object.freeze({ type, model });
  profiles.set(profile, { parent, fields });
  return profile;
}

export function modelLexicalSnapshotOccurrences(profile: ModelLexicalSnapshotProfile,
  wire: unknown): readonly FileReferenceOccurrence[] {
  const owner = profiles.get(profile) ?? refuse('authentic owning snapshot profile required.');
  const row = object(copyScenarioFileData(wire),
    ['id', 'version', 'created', 'updated', 'createdBy', 'updatedBy', 'archivedAt', 'parent', 'data']);
  identity(row.id); integer(row.version, 1); integer(row.created); integer(row.updated);
  identity(row.createdBy); identity(row.updatedBy);
  if (row.archivedAt !== null) return refuse('only live lexical snapshots are supported.');
  if (owner.parent === undefined) {
    if (row.parent !== null) return refuse('root snapshot cannot acquire containment.');
  } else {
    const parent = object(row.parent, ['model', 'id']);
    if (parent.model !== owner.parent) return refuse('snapshot parent differs from owning containment.');
    identity(parent.id);
  }
  const data = object(row.data), found: FileReferenceOccurrence[] = [];
  for (const [field, value] of Object.entries(data)) {
    const declared = owner.fields.get(field);
    if (declared === undefined) return refuse('undeclared projected data field.');
    if (declared instanceof Error) throw declared;
    for (const occurrence of fileReferenceOccurrences(declared, value)) {
      found.push({ path: ['data', field, ...occurrence.path], ref: occurrence.ref });
    }
  }
  return deepFreeze(found);
}
