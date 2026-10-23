/** Genuine loader -> ordinary TS serving plans. No source owner is minted
 * from artifact shape or a request revision. The existing assembler verifies
 * its actual installed closure; its imported owning declarations are captured
 * and rechecked through the final HTTP admission await. */
import type { ArtifactModel, ArtifactOperation, CompileArtifact } from '@canlang/contracts';
import type { CanValue } from '@canlang/contracts/values';
import { sha256HexText } from '@canlang/identity';
import { catalogFromArtifactOperations, createSourceValidationCatalog, encodeServingLiteral } from '@canlang/interfaces/http/operations';
import type { SchemaCatalog } from '@canlang/interfaces';
import { Decimal, decodeValue, encodeValue, parseTypeId, printTypeId, type FieldDescriptor, type SchemaDescriptor } from '@canlang/values';
import type { AssembledModules } from './modules.js';
import { AssemblyCorrespondenceError, importVerifiedAssemblyModule, verifyAssemblerModuleCapability } from './assembly-verification.js';

const refuse = (message: string): never => { throw new AssemblyCorrespondenceError(`HTTP validation source: ${message}`); };
type ArtifactInputField = NonNullable<CompileArtifact['operations']>[number]['inputs']['fields'][number] |
  NonNullable<CompileArtifact['models']>[number]['fields'][number];
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return refuse('requires own declaration data');
  return value as Record<string, unknown>;
}
function member(value: unknown, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record(value), key);
  if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) return refuse(`missing own ${key}`);
  return descriptor.value;
}
/** Capture only compiler declaration data, never callbacks or arbitrary wire
 * objects. Reject getters, aliases with cycles, exotic containers and symbols.
 * Declaration/field/array order is retained. */
function capture(value: unknown, active = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Decimal) return new Decimal(value.coef, value.scale);
  if (typeof value !== 'object' || value === null || active.has(value)) return refuse('invalid declaration data');
  const array = Array.isArray(value);
  if (!array) record(value);
  else if (Object.getPrototypeOf(value) !== Array.prototype) return refuse('invalid declaration array');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  const length = array ? descriptors.length?.value as number : 0;
  if (array && (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1)) return refuse('non-dense declaration array');
  const out: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
  active.add(value);
  try {
    for (const key of array ? Array.from({ length }, (_, index) => String(index)) : keys) {
      if (typeof key !== 'string') return refuse('symbol declaration key');
      const descriptor = descriptors[key];
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) return refuse('non-data declaration member');
      Object.defineProperty(out, key, { value: capture(descriptor.value, active), enumerable: true, writable: true, configurable: true });
    }
    return Object.freeze(out);
  } finally { active.delete(value); }
}

/** Unambiguous internal comparison/hash domain, including native literal
 * bigint/Decimal metadata. It is not a wire carrier or issuer. */
function stamp(value: unknown): unknown {
  if (value instanceof Decimal) return ['decimal', String(value.coef), value.scale];
  if (typeof value === 'bigint') return ['bigint', String(value)];
  if (Array.isArray(value)) return ['array', value.map(stamp)];
  if (value !== null && typeof value === 'object') return ['object', Object.entries(value).map(([key, member]) => [key, stamp(member)])];
  return [typeof value, value];
}
const sealedData = (value: unknown): string => JSON.stringify(stamp(value));

function wireLengthBound(value: unknown): unknown {
  if (typeof value !== 'bigint') return value;
  // Compiler model declarations retain native Can integers. Values length
  // metadata uses descriptor numbers, unlike scalar bounds and defaults.
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return refuse('length bound has no exact descriptor number');
  return Number(value);
}

function wireField(value: unknown): FieldDescriptor {
  const field = record(capture(value)), type = member(field, 'type');
  if (typeof type !== 'string') return refuse('field has no owning type');
  // Model enum declarations keep their cases beside the leaf type. Join the
  // exact original list before applying wrappers or encoding creation defaults.
  let base = parseTypeId(type);
  if (type === 'enum' && Object.hasOwn(field, 'cases')) {
    const cases = field.cases;
    if (!Array.isArray(cases) || cases.some(item => typeof item !== 'string')) return refuse('invalid enum cases');
    base = parseTypeId(`enum(${cases.join(',')})`);
    if (base.base.kind !== 'enum' || sealedData(base.base.cases) !== sealedData(cases)) return refuse('invalid enum cases');
  }
  // Model declarations keep wrappers beside the leaf type; contract/parameter
  // declarations may already carry the complete type ID. Encode defaults only
  // after joining those exact owning wrappers.
  for (const key of ['array', 'requiredArray', 'nullable'] as const) {
    if (Object.hasOwn(field, key) && typeof field[key] !== 'boolean') return refuse(`invalid ${key} wrapper`);
    if (field[key] === false && base[key]) return refuse(`conflicting ${key} wrapper`);
  }
  const parsed = { ...base, array: base.array || field.array === true,
    requiredArray: base.requiredArray || field.requiredArray === true,
    nullable: base.nullable || field.nullable === true };
  if (parsed.requiredArray && !parsed.array) return refuse('required array wrapper lacks its array');
  const owningType = printTypeId(parsed), out: Record<string, unknown> = { type: owningType };
  for (const key of ['min', 'max', 'trim', 'format', 'distinctBy', 'excludedIds']) if (Object.hasOwn(field, key)) {
    const length = parsed.array || parsed.base.kind === 'stringlike' || parsed.base.kind === 'scalar' && parsed.base.name === 'text';
    out[key] = key === 'min' || key === 'max'
      ? length ? wireLengthBound(field[key]) : encodeServingLiteral(owningType, field[key] as CanValue)
      : field[key];
  }
  if (Object.hasOwn(field, 'default')) out.default = encodeServingLiteral(owningType, field.default as CanValue);
  if (Object.hasOwn(field, 'server')) out.server = true;
  if (Object.hasOwn(field, 'derived') || Object.hasOwn(field, 'derive')) out.derived = true;
  if (field.computedDefault === true) out.server = true;
  return Object.freeze(out) as unknown as FieldDescriptor;
}

/** Create containment is declared by the model, separately from its writable
 * domain-field allowlist. Join that same source fact to the complete input. */
function createParentField(definition: unknown, model: ArtifactModel, operation: ArtifactOperation,
  artifact: CompileArtifact): Readonly<{ type: string }> | undefined {
  const models = record(member(definition, 'models')), source = record(member(models, model.name));
  const parent = Object.hasOwn(source, 'parent') ? member(source, 'parent') : undefined;
  if (parent !== model.parent) return refuse('model containment differs from its checked declaration');
  if (operation.kind !== 'create') return undefined;
  const inputs = operation.inputs.fields.filter(field => field.name === 'parent');
  if (parent === undefined) {
    if (inputs.length !== 0) return refuse('uncontained create added a parent input');
    return undefined;
  }
  if (typeof parent !== 'string' || !Object.hasOwn(models, parent) ||
      artifact.models?.filter(candidate => candidate.name === parent).length !== 1) {
    return refuse('create parent lacks its owning model');
  }
  const input = inputs[0];
  if (inputs.length !== 1 || input === undefined || input.field.kind !== 'ref' ||
      input.field.model !== parent || input.field.requireVersion !== false || input.required !== true ||
      input.nullable !== undefined || input.array !== undefined || input.default !== undefined) {
    return refuse('create parent differs from its checked reference');
  }
  return Object.freeze({ type: parent });
}

function sourceData(definition: unknown, operation: string, artifact: CompileArtifact) {
  const app = member(definition, 'id');
  if (typeof app !== 'string' || app === '' || !Object.hasOwn(record(member(definition, 'packages')), app)) return refuse('missing owning application');
  const declared = record(member(member(definition, 'operations'), operation));
  const contracts = record(member(definition, 'contracts'));
  const enums = Object.hasOwn(record(definition), 'enums') ? record(member(definition, 'enums')) : {};
  const inputs = record(member(declared, 'inputs'));
  const model = typeof declared.model === 'string' ? member(member(definition, 'models'), declared.model) : null;
  const fields = model === null ? inputs : record(member(model, 'fields'));
  const owning = artifact.operations?.find(entry => entry.name === operation);
  if (owning === undefined || member(declared, 'handler') !== operation) return refuse('missing owning operation');
  const artifactModel = typeof declared.model === 'string' ? artifact.models?.find(entry => entry.name === declared.model) : undefined;
  const parent = artifactModel === undefined ? undefined : createParentField(definition, artifactModel, owning, artifact);
  const names = model === null ? Object.keys(fields) : owning.kind === 'create' ? member(inputs, 'fields') :
    owning.kind === 'update' ? member(member(inputs, 'changes'), 'fields') : [];
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string')) return refuse('missing writable input inventory');
  const selected: Record<string, FieldDescriptor> = Object.create(null);
  if (owning.kind === 'update' || owning.kind === 'delete') selected.record = wireField(member(inputs, 'record'));
  for (const name of names) {
    const field = wireField(member(fields, name));
    // Update's owning operation omits model creation defaults. Its HTTP
    // evaluator keeps the original optional changes semantics separately.
    if (owning.kind === 'update') {
      const { default: _creationDefault, ...update } = field;
      void _creationDefault;
      selected[name] = update;
    } else selected[name] = field;
  }
  if (parent !== undefined) selected.parent = wireField(parent);
  const descriptor: SchemaDescriptor = {
    contracts: Object.fromEntries(Object.keys(contracts).map(name => [name, { fields:
      Object.fromEntries(Object.entries(record(member(contracts[name], 'fields'))).map(([key, field]) => [key, wireField(field)])) }])),
    enums: Object.fromEntries(Object.keys(enums).map(name => [name, { cases: member(enums[name], 'cases') as readonly string[] }])),
    ...(Object.hasOwn(record(definition), 'aliases') ? { aliases: member(definition, 'aliases') as NonNullable<SchemaDescriptor['aliases']> } : {}),
    operations: { [operation]: { inputs: selected, mutation: owning.kind !== 'read' } },
  };
  // CRUD inputs are model allowlists, not Values operation field maps.
  // State retains model defaults/update omission/ref authority; HTTP retains
  // its existing checked derived binding plan. Parameter operations have the
  // actual owning Values field declarations directly.
  return capture({ app, descriptor, operation: declared, model }) as {
    app: string; descriptor: SchemaDescriptor; operation: Record<string, unknown>; model: unknown;
  };
}

/** Match each actual source field against the already checked artifact's
 * complete transport declaration before it can acquire owner provenance. */
function assertFieldPair(source: unknown, expected: ArtifactInputField, enums: Record<string, unknown>): void {
  const original = record(source), field = wireField(original), parsed = parseTypeId(field.type);
  const base = parsed.base, tag = expected.field;
  const names: Record<string, string> = { string: 'text', integer: 'int', boolean: 'bool', decimal: 'decimal', duration: 'duration', datetime: 'datetime', money: 'money', user: 'user', file: 'file' };
  let matches = expected.valueType !== undefined ? field.type === expected.valueType :
    tag.kind === 'ref' ? base.kind === 'nominal' && base.path === tag.model :
    tag.kind === 'nominal' ? base.kind === 'nominal' && base.path === tag.name :
    tag.kind === 'enum' ? sealedData(base.kind === 'enum' ? base.cases : base.kind === 'nominal' && Object.hasOwn(enums, base.path) ? member(enums[base.path], 'cases') : null) === sealedData(tag.values) :
    tag.kind === 'user' || tag.kind === 'file' ? base.kind === tag.kind :
    base.kind === 'scalar' && base.name === names[tag.kind];
  matches = matches && parsed.nullable === (expected.nullable === true) && Boolean(parsed.array) === (expected.array !== undefined) &&
    (!parsed.array || parsed.requiredArray === (expected.array?.required === true));
  if (!matches) return refuse(`input ${expected.name} differs from its checked type`);
  if (parsed.array) for (const key of ['min', 'max'] as const) if (field[key] !== expected[key]) return refuse(`input ${expected.name} differs from its checked bound`);
  const computedInput = 'computedDefault' in expected && expected.computedDefault === true;
  const computed = computedInput || expected.default?.kind === 'parent';
  if ((original.computedDefault === true) !== computed) return refuse(`input ${expected.name} differs from its checked deferred default`);
  if (computedInput) {
    if (expected.default !== undefined || Object.hasOwn(original, 'default')) return refuse(`input ${expected.name} added a conflicting default`);
  } else if (expected.default?.kind === 'literal') {
    if (!Object.hasOwn(original, 'default') ||
        JSON.stringify(encodeValue(field.type, original.default as CanValue)) !== JSON.stringify(encodeValue(field.type, decodeValue(field.type, expected.default.value)))) {
      return refuse(`input ${expected.name} differs from its checked default`);
    }
  } else if (expected.default?.kind === 'parent') {
    if (original.computedDefault !== true) return refuse(`input ${expected.name} lost its deferred default`);
  } else if (expected.default?.kind === 'server') {
    if (original.server !== expected.default.init) return refuse(`input ${expected.name} differs from its server default`);
  } else if (expected.default?.kind === 'derived') {
    if (original.derive === undefined && original.derived === undefined) return refuse(`input ${expected.name} lost its derived field`);
  } else if (Object.hasOwn(original, 'default') || original.computedDefault === true) return refuse(`input ${expected.name} added an undeclared default`);
}

function assertDeclarationPair(definition: unknown, operation: string, artifact: CompileArtifact): void {
  const declared = record(member(member(definition, 'operations'), operation)), inputs = record(member(declared, 'inputs'));
  const owning = artifact.operations!.find(entry => entry.name === operation)!;
  const enums = Object.hasOwn(record(definition), 'enums') ? record(member(definition, 'enums')) : {};
  const model = typeof declared.model === 'string' ? artifact.models?.find(entry => entry.name === declared.model) : undefined;
  if (typeof declared.model === 'string' && (model === undefined || operation.slice(0, operation.lastIndexOf('.')) !== declared.model)) return refuse('CRUD names a different owning model');
  const fields = model === undefined ? inputs : record(member(member(member(definition, 'models'), model.name), 'fields'));
  const expected = model === undefined ? owning.inputs.fields : model.fields;
  if (model === undefined && sealedData(Object.keys(fields)) !== sealedData(expected.map(field => field.name))) return refuse('input census differs from its owning operation');
  if (model !== undefined && sealedData(Object.keys(fields)) !== sealedData(expected.map(field => field.name))) return refuse('model field census differs from its owning declaration');
  for (const field of expected) assertFieldPair(member(fields, field.name), field, enums);
  if (model !== undefined) {
    const parent = createParentField(definition, model, owning, artifact);
    const createFields = owning.kind === 'create' ? capture(member(inputs, 'fields')) : undefined;
    if (owning.kind === 'create' && (!Array.isArray(createFields) || createFields.some(field => typeof field !== 'string'))) {
      return refuse('missing writable input inventory');
    }
    const names = owning.kind === 'create' ? [...(createFields as string[]), ...(parent === undefined ? [] : ['parent'])] : owning.kind === 'update'
      ? ['record', ...(capture(member(member(inputs, 'changes'), 'fields')) as string[])] : ['record'];
    if (sealedData(names) !== sealedData(owning.inputs.fields.map(field => field.name))) return refuse('operation writable input census differs from its checked declaration');
    for (const field of owning.inputs.fields) {
      const source = field.name === 'record' ? member(inputs, 'record') :
        field.name === 'parent' && parent !== undefined ? parent : member(fields, field.name);
      if (owning.kind === 'update' && field.name !== 'record') {
        const { default: _default, ...change } = record(capture(source));
        void _default;
        assertFieldPair(change, field, enums);
      } else assertFieldPair(source, field, enums);
    }
  }
  const inventory = artifact.valueTypes;
  if (inventory !== undefined) {
    const contracts = record(member(definition, 'contracts'));
    if (sealedData(Object.keys(contracts)) !== sealedData(inventory.contracts.map(contract => contract.name))) return refuse('contract census differs from its owning inventory');
    for (const contract of inventory.contracts) {
      const actual = record(member(contracts[contract.name], 'fields'));
      if (sealedData(Object.keys(actual)) !== sealedData(contract.fields.map(field => field.name))) return refuse('contract field census differs from its owning inventory');
      for (const field of contract.fields) {
        const original = wireField(member(actual, field.name));
        if (original.type !== field.type) return refuse('contract field type differs from its owning inventory');
        const parsed = parseTypeId(field.type);
        for (const key of ['min', 'max', 'format', 'distinctBy', 'excludedIds'] as const) {
          const lhs = original[key], rhs = field[key];
          const scalar = (key === 'min' || key === 'max') && !parsed.array && parsed.base.kind === 'scalar' && parsed.base.name !== 'text';
          const canonical = (value: unknown): unknown => value === undefined ? null : scalar
            ? encodeValue(field.type, decodeValue(field.type, parsed.base.kind === 'scalar' && parsed.base.name === 'int' && typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value)) : value;
          if (sealedData(canonical(lhs)) !== sealedData(canonical(rhs))) return refuse('contract constraint differs from its owning inventory');
        }
      }
    }
    if (sealedData(Object.keys(enums)) !== sealedData((inventory.enums ?? []).map(enumeration => enumeration.name))) return refuse('enum census differs from its owning inventory');
    for (const enumeration of inventory.enums ?? []) if (sealedData(member(enums[enumeration.name], 'cases')) !== sealedData(enumeration.cases)) return refuse('enum differs from its owning inventory');
  }
}

/** Existing profile exclusions are decided before registration, never by
 * catching a failed plan or switching a native backend. Canonical HTTP/State
 * still own aliases/NAME/keyed arrays without claiming a prepared Values plan. */
function unsupportedProfile(descriptor: SchemaDescriptor): boolean {
  // Values permits engine-resolved fields on contracts only. Computed
  // operation defaults retain canonical HTTP omission and State evaluation.
  return Object.hasOwn(descriptor, 'aliases') ||
    Object.values(descriptor.operations ?? {}).some(operation =>
      Object.values(operation.inputs).some(field => field.server === true || field.derived === true)) || [
    ...Object.values(descriptor.contracts ?? {}).map(contract => contract.fields),
    ...Object.values(descriptor.operations ?? {}).map(operation => operation.inputs),
  ].some(fields => Object.values(fields).some(field =>
    ['format', 'distinctBy', 'excludedIds'].some(key => Object.hasOwn(field, key))));
}

export async function createPreparedValidationCatalog(artifact: CompileArtifact,
  asm: AssembledModules, base: SchemaCatalog, expectedApp: string): Promise<SchemaCatalog> {
  // Framing-only/older artifacts remain exactly that. They neither claim a
  // complete Values declaration profile nor issue an owner-bound plan.
  if (base.derivedFor === undefined) return base;
  await verifyAssemblerModuleCapability(asm, artifact);
  const expected = catalogFromArtifactOperations(artifact);
  return createSourceValidationCatalog(base, async operation => {
    await verifyAssemblerModuleCapability(asm, artifact);
    const candidates = artifact.callables.filter(callable => callable.id === operation && callable.kind === 'operation');
    const callable = candidates[0];
    if (candidates.length !== 1 || callable === undefined || callable.member.length !== 1 || callable.member[0] !== operation) return refuse('operation lacks its unique owning callable');
    const namespace = await importVerifiedAssemblyModule(asm, callable.module, artifact);
    const definition = member(namespace, 'appDefinition');
    assertDeclarationPair(definition, operation, artifact);
    const original = sourceData(definition, operation, artifact), sealed = sealedData(original);
    if (original.app !== expectedApp) return refuse('source belongs to a different receiving application');
    const owning = artifact.operations?.find(entry => entry.name === operation);
    const sourceKind = original.operation.kind ?? (original.operation.read === true ? 'read' : 'scenario');
    if (owning === undefined || owning.kind !== sourceKind || !Object.hasOwn(record(member(definition, 'packages')),
        owning.kind === 'scenario' || owning.kind === 'read' ? operation.slice(0, operation.lastIndexOf('.')) :
          String(original.operation.model).slice(0, String(original.operation.model).lastIndexOf('.')))) return refuse('operation differs from its declaring owner');
    const derived = expected.derivedFor(operation);
    if (derived === null || JSON.stringify(base.derivedFor?.(operation)) !== JSON.stringify(derived)) return refuse('catalog differs from its checked owning operation');
    const revision = await sha256HexText(JSON.stringify({ app: original.app, operation, module: callable.module,
      artifact_version: artifact.artifact_version, language_version: artifact.language_version, sources: artifact.sources, declarations: stamp(original) }));
    const assertStable = (): void => {
      assertDeclarationPair(definition, operation, artifact);
      if (sealedData(sourceData(definition, operation, artifact)) !== sealed ||
          JSON.stringify(base.derivedFor?.(operation)) !== JSON.stringify(derived)) return refuse('owning descriptor or catalog changed');
    };
    const assertCurrent = async (): Promise<void> => {
      await verifyAssemblerModuleCapability(asm, artifact);
      assertStable();
    };
    await assertCurrent();
    return { ownerRevision: revision, descriptor: unsupportedProfile(original.descriptor) ? null : original.descriptor, assertCurrent, assertStable };
  });
}
