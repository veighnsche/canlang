/** Operation-owned assistance over current canonical viewer reads. */
import { COLLECTION_MAX_LIMIT } from '@canlang/contracts';
import type { ArtifactModelField, ClosedInputs, DerivedOperationInputs,
  ProjectedRecord } from '@canlang/contracts';
import type { InputChoiceResult } from '@canlang/interfaces';
import { catalogFromArtifactOperations } from '@canlang/interfaces/http/operations';
import { checkBoundArgument, checkBoundArguments } from '@canlang/interfaces';
import { StateError } from '@canlang/state/errors';
import { decodeValue, encodeValue, isRecordRef } from '@canlang/values';
import { invokeReadCanonical, loadCanonicalDescriptors } from './invoke.js';
import type { CanonicalReadOpts } from './invoke.js';

export type InputChoicesCanonicalOpts = Omit<CanonicalReadOpts, 'operation' | 'inputs' | 'selection'> & {
  readonly derived: DerivedOperationInputs;
  readonly input: string;
  readonly inputs: ClosedInputs;
};

const absent = (value: unknown): boolean => value === undefined || value === null || value === '';

export async function lookupInputChoicesCanonical(opts: InputChoicesCanonicalOpts): Promise<InputChoiceResult> {
  const { derived: supplied, input, inputs, ...readOpts } = opts;
  const derived = catalogFromArtifactOperations(opts.artifact).derivedFor(supplied.operation);
  if (derived === null || derived === undefined || JSON.stringify(derived) !== JSON.stringify(supplied)) {
    throw new StateError('validation', 'Input assistance must match its owning artifact declaration.');
  }
  const assisted = derived.inputs.find(field => field.name === input);
  const binding = assisted?.choices;
  if (assisted === undefined || binding === undefined) throw new StateError('validation', 'Unknown input assistance.');
  const allowed = new Set(derived.inputs.filter(field => field.kind !== 'delivery').map(field => field.name));
  if (Object.keys(inputs).some(name => !allowed.has(name))) throw new StateError('validation', 'Unknown draft input.');
  // Unfinished draft prerequisites perform no canonical or domain read.
  for (const mapping of Object.values(binding.arguments)) {
    if (!Object.hasOwn(inputs, mapping.input) || absent(inputs[mapping.input])) return { state: 'absent', choices: [] };
  }
  const draftError = checkBoundArguments(derived, inputs);
  if (draftError !== null) throw new StateError('validation', draftError.message);
  const loaded = await loadCanonicalDescriptors(opts.asm, opts.artifact);
  const declared = opts.artifact.operations?.find(operation => operation.name === binding.readOperation);
  const candidateModel = loaded.models.find(model => `${model.name}[]` === declared?.result?.type);
  const def = loaded.registry.get(binding.readOperation) as {
    readonly generated?: unknown; readonly descriptor?: { readonly kind?: unknown; readonly result?: { readonly type?: unknown } };
  } | undefined;
  if (declared?.kind !== 'read' || candidateModel === undefined || def?.generated !== true ||
      def.descriptor?.kind !== 'read' || def.descriptor.result?.type !== `${candidateModel.name}[]`) {
    throw new StateError('validation', 'Input assistance requires a checked nonnullable model-array read.');
  }
  const candidateDeclaration = opts.artifact.models?.find(model => model.name === candidateModel.name);
  if (candidateDeclaration === undefined) throw new StateError('validation', 'Unknown candidate model.');
  const revision = await opts.store.readRevision();
  const identitySnapshot = JSON.stringify(opts.identity);
  const actor = opts.identity.actor?.user_id;
  const team = opts.identity.team?.team_id;
  const membership = () => actor === undefined || team === undefined ? Promise.resolve(null)
    : opts.memberships.findMembership(team, actor);
  const membershipSnapshot = JSON.stringify(await membership());
  const checkpoint = async () => {
    if (await opts.store.readRevision() !== revision) throw new StateError('conflict', 'State changed during input assistance.');
  };
  const finish = async (result: InputChoiceResult): Promise<InputChoiceResult> => {
    await checkpoint();
    if (JSON.stringify(opts.identity) !== identitySnapshot || JSON.stringify(await membership()) !== membershipSnapshot) {
      throw new StateError('forbidden', 'Caller authority changed during input assistance.');
    }
    await checkpoint();
    return result;
  };
  const readRows = async (model: string, ids: readonly string[]): Promise<readonly ProjectedRecord[]> => {
    if (!loaded.models.some(entry => entry.name === model) || ids.length > COLLECTION_MAX_LIMIT) {
      throw new StateError('validation', 'Unsupported input assistance model selection.');
    }
    await checkpoint();
    const served = await invokeReadCanonical({ ...readOpts, operation: `${model}.read`, inputs: {},
      selection: { where: ids.length === 1 ? { op: 'eq', field: 'id', value: ids[0] }
        : { op: 'or', args: ids.map(id => ({ op: 'eq' as const, field: 'id', value: id })) },
      limit: COLLECTION_MAX_LIMIT } });
    if (!('records' in served) || served.revision !== revision) throw new StateError('conflict', 'Candidate read checkpoint changed.');
    await checkpoint();
    return served.records;
  };
  const resolveRef = async (model: string, wire: unknown): Promise<ProjectedRecord> => {
    const ref = decodeValue(model, wire);
    if (!isRecordRef(ref) || ref.model !== model) throw new StateError('validation', 'Input path requires its declared record reference.');
    const rows = await readRows(model, [ref.id]);
    const row = rows.find(record => record.id === ref.id);
    if (row === undefined) throw new StateError('not_found', 'Input path record not found.');
    if (ref.version !== undefined && ref.version !== BigInt(row.version)) {
      throw new StateError('conflict', 'Input path record version changed.');
    }
    return row;
  };
  const currentRefWire = async (model: string, wire: unknown, versioned: boolean) => {
    const row = await resolveRef(model, wire);
    return versioned ? { id: row.id, version: String(row.version) } : { id: row.id };
  };
  const readDerived = catalogFromArtifactOperations(opts.artifact).derivedFor(binding.readOperation);
  if (readDerived === null || readDerived === undefined) throw new StateError('validation', 'Unknown candidate read.');
  const argumentsWire: ClosedInputs = Object.create(null);
  for (const [parameter, mapping] of Object.entries(binding.arguments)) {
    const source = derived.inputs.find(field => field.name === mapping.input)!;
    const target = readDerived.inputs.find(field => field.name === parameter);
    if (target === undefined) throw new StateError('validation', 'Unknown mapped read argument.');
    let value: unknown = inputs[mapping.input];
    let model = source.kind === 'ref' ? source.model : undefined;
    for (const segment of mapping.path) {
      if (absent(value)) return finish({ state: 'absent', choices: [] });
      if (model === undefined) throw new StateError('validation', 'Input paths require declared singular references.');
      const row = await resolveRef(model, value);
      const owner = opts.artifact.models?.find(entry => entry.name === model);
      const field = owner?.fields.find(entry => entry.name === segment);
      if (field !== undefined) {
        if (!Object.hasOwn(row.data, segment)) throw new StateError('forbidden', 'Input path leaf is not granted.');
        value = row.data[segment];
        model = field.field.kind === 'ref' && field.array === undefined ? field.field.model : undefined;
      } else if (segment === 'parent' && owner?.parent !== undefined) {
        if (row.parent === null || row.parent.model !== owner.parent) throw new StateError('not_found', 'Input path parent not found.');
        value = { id: row.parent.id }; model = owner.parent;
      } else throw new StateError('validation', 'Unknown declared input path.');
    }
    if (absent(value)) return finish({ state: 'absent', choices: [] });
    if (target.kind === 'ref') {
      if (model !== target.model || target.model === undefined) throw new StateError('validation', 'Mapped reference model disagreement.');
      value = await currentRefWire(target.model, value, target.versioned === true);
    }
    const error = checkBoundArgument(target, value);
    if (error !== null) throw new StateError('validation', error.message);
    argumentsWire[parameter] = value;
  }
  await checkpoint();
  const served = await invokeReadCanonical({ ...readOpts, operation: binding.readOperation, inputs: argumentsWire });
  if (!('result' in served) || served.revision !== revision || !Array.isArray(served.result) || served.result.length > COLLECTION_MAX_LIMIT) {
    throw new StateError('validation', 'Candidate read must return its bounded model-array wire result.');
  }
  const references = served.result.map(wire => {
    const ref = decodeValue(candidateModel.name, wire);
    if (!isRecordRef(ref) || ref.model !== candidateModel.name) throw new StateError('validation', 'Candidate result model disagreement.');
    return ref;
  });
  const candidates = references.length === 0 ? [] : await readRows(candidateModel.name, [...new Set(references.map(ref => ref.id))]);
  const grantedField = (row: ProjectedRecord, name: string): { declaration: ArtifactModelField; wire: unknown } => {
    const declaration = candidateDeclaration.fields.find(field => field.name === name);
    if (declaration === undefined || !Object.hasOwn(row.data, name)) throw new StateError('forbidden', 'Candidate leaf is not granted.');
    const wire = row.data[name];
    if (declaration.valueType !== undefined) encodeValue(declaration.valueType, decodeValue(declaration.valueType, wire));
    return { declaration, wire };
  };
  const label = (row: ProjectedRecord, name: string): string => {
    const { declaration, wire } = grantedField(row, name);
    if (wire === null) return '';
    if (declaration.field.kind === 'ref') {
      const ref = decodeValue(declaration.field.model, wire);
      if (!isRecordRef(ref)) throw new StateError('validation', 'Invalid candidate reference label.');
      return ref.id;
    }
    if (declaration.field.kind === 'user') {
      const user = decodeValue('user', wire) as { readonly id: string };
      return user.id;
    }
    const text = typeof wire === 'string' ? wire : JSON.stringify(wire);
    if (typeof text !== 'string') throw new StateError('validation', 'Invalid candidate label value.');
    return text;
  };
  const choices: { value: unknown; labels: string[] }[] = [];
  for (const reference of references) {
    const row = candidates.find(candidate => candidate.id === reference.id);
    if (row === undefined) throw new StateError('not_found', 'Candidate record not found.');
    if (reference.version !== undefined && reference.version !== BigInt(row.version)) throw new StateError('conflict', 'Candidate record version changed.');
    let value: unknown;
    if (binding.value.kind === 'record') {
      value = assisted.versioned === true ? { id: row.id, version: String(row.version) } : { id: row.id };
    } else {
      const leaf = grantedField(row, binding.value.field);
      value = leaf.wire;
      if (leaf.declaration.field.kind === 'ref' && value !== null) {
        const ref = decodeValue(leaf.declaration.field.model, value);
        if (!isRecordRef(ref)) throw new StateError('validation', 'Invalid candidate reference value.');
        // An opaque granted ID gains no related-row fields. A required current
        // version additionally needs that related model's own viewer read.
        if (assisted.versioned === true) value = await currentRefWire(leaf.declaration.field.model, value, true);
      }
    }
    const error = checkBoundArgument(assisted, value);
    if (error !== null) throw new StateError('validation', error.message);
    choices.push({ value, labels: binding.labels.map(name => label(row, name)) });
  }
  return finish({ state: 'ready', choices });
}
