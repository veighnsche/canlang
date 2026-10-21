/** Historical opaque declaration correspondence. This component supplies typed
 * traversal, never a source issuer, admission, disclosure or File grant. */
import type {
  ArtifactOperationInput, CanTypeId, CanonicalInputDef, CanonicalNominalLeaf, ModelName, WireValue,
  FrameworkFilePayloadOrigin, FrameworkOpaqueCallable, FrameworkOpaqueDeclaration,
  FrameworkOpaqueDeclarationSet, FrameworkOpaqueDeliveryContext, FrameworkOpaqueDeliveryProfile, FrameworkOpaqueEventDeclaration,
  FrameworkOpaqueEventInputOrigin, FrameworkOpaquePayloadOrigin, FrameworkOpaqueSourceRoute,
  FrameworkOpaqueSendGuardDeclaration,
  FrameworkOpaqueValueDefault, FrameworkOpaqueValueProjection, ScenarioReceiptSourceOrigin,
} from '@canlang/contracts';
import { decodeValue, encodeValue, normalizeSchema, normalizeValueTypes, parseTypeId, printTypeBase, printTypeId, validateValue,
  type NormalizedField, type NormalizedSchema } from '@canlang/values';
import { StateError } from '../errors.js';
import { deepFreeze } from '../internal/own-data.js';
import { stableStringify } from '../invocation/replay.js';
import { bindDeclaredFileReferenceProfile, bindFileReferenceProfile, fileReferenceOccurrences,
  type FileReferenceProfile, type FileReferenceProfileBound } from '../ports/file-reference-profile.js';
import { bindModelLexicalSnapshotProfile, modelLexicalSnapshotOccurrences,
  type ModelLexicalSnapshotProfile } from '../ports/model-lexical-snapshot.js';
import { createJudgmentReceiptContext, readJudgmentResult } from '../receipt/tables.js';

export interface BoundOpaqueDeclarations {
  readonly declarationSet: FrameworkOpaqueDeclarationSet;
}
interface BoundInput {
  readonly declaration: CanonicalInputDef;
  readonly profile: FileReferenceProfile;
  readonly modelSnapshot?: ModelLexicalSnapshotProfile;
}
interface BoundDeclaration {
  readonly declaration: FrameworkOpaqueDeclaration;
  readonly inputs?: ReadonlyMap<string, BoundInput>;
  readonly result?: FileReferenceProfile;
}
interface BoundValueDefault {
  readonly original: FrameworkOpaqueValueDefault;
  readonly profile: FileReferenceProfile;
  readonly validatedWire: WireValue;
}
interface Owner {
  readonly values: FileReferenceProfileBound;
  readonly declarations: ReadonlyMap<string, BoundDeclaration>;
  readonly valueDefaults: ReadonlyMap<string, BoundValueDefault>;
}
const owners = new WeakMap<BoundOpaqueDeclarations, Owner>();
const refuse = (message: string): never => { throw new StateError('validation', `Opaque File declarations: ${message}`); };
const MAX_NODES = 20_000, MAX_DEPTH = 32, MAX_TEXT = 2_000_000;

/** Detached, dense own JSON with one shared budget across the complete value. */
function closedJSON(value: unknown): unknown {
  let nodes = 0, text = 0;
  const active = new Set<object>();
  const visit = (part: unknown, depth: number): unknown => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return refuse('finite JSON budget exceeded.');
    if (part === null || typeof part === 'boolean') return part;
    if (typeof part === 'string') {
      if ((text += part.length) > MAX_TEXT) return refuse('JSON text budget exceeded.');
      return part;
    }
    if (typeof part === 'number' && Number.isFinite(part)) return part;
    if (typeof part !== 'object' || active.has(part)) return refuse('own JSON data required.');
    const array = Array.isArray(part), keys = Reflect.ownKeys(part), prototype = Object.getPrototypeOf(part);
    if (array ? prototype !== Array.prototype || keys.length !== part.length + 1 : prototype !== Object.prototype && prototype !== null) {
      return refuse('dense own JSON required.');
    }
    const output: unknown[] | Record<string, unknown> = array ? [] : {};
    active.add(part);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= (part as unknown[]).length)) {
        return refuse('own JSON keys required.');
      }
      const descriptor = Object.getOwnPropertyDescriptor(part, key);
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) return refuse('own enumerable data required.');
      if ((text += key.length) > MAX_TEXT) return refuse('JSON text budget exceeded.');
      Object.defineProperty(output, key, { enumerable: true, configurable: true, writable: true, value: visit(descriptor.value, depth + 1) });
    }
    active.delete(part);
    return output;
  };
  return visit(value, 0);
}
function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return refuse('closed object required.');
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    return refuse('incomplete or extended declaration/origin.');
  }
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || value === '') return refuse('nonempty identity required.');
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return refuse('nonnegative exact integer required.');
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return refuse('boolean marker required.');
  return value;
}
function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) return refuse('complete array required.');
  return value;
}
function same(a: unknown, b: unknown): void {
  if (stableStringify(a) !== stableStringify(b)) return refuse('original declarations or identities disagree.');
}
function optionalSame(a: object, b: object, key: string): void {
  if (Object.hasOwn(a, key) !== Object.hasOwn(b, key)) return refuse('declaration presence disagrees.');
  if (Object.hasOwn(a, key)) same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]);
}
function owner(bound: BoundOpaqueDeclarations): Owner {
  return owners.get(bound) ?? refuse('authentic bound declaration closure required.');
}
function source(set: FrameworkOpaqueDeclarationSet, value: ScenarioReceiptSourceOrigin): void {
  const item = record(value, ['path', 'sha256', 'module']);
  string(item.module);
  if (typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256) ||
      !set.sources.some(candidate => candidate.path === item.path && candidate.sha256 === item.sha256)) return refuse('complete original source membership required.');
}
function callableShape(value: FrameworkOpaqueCallable['callable']): void {
  const item = record(value, ['id', 'kind', 'module', 'export', 'member'], ['inputStyle', 'source']);
  for (const key of ['id', 'module', 'export']) string(item[key]);
  if (!['operation', 'pure', 'rule', 'handler', 'migration'].includes(String(item.kind)) ||
      array(item.member).length === 0 || array(item.member).some(part => typeof part !== 'string' || part === '') ||
      Object.hasOwn(item, 'inputStyle') && item.inputStyle !== 'parameters' ||
      Object.hasOwn(item, 'source') && (typeof item.source !== 'string' || item.source === '')) return refuse('exact callable declaration required.');
}
function sourceEqual(a: FrameworkOpaqueDeclaration['source'], b: FrameworkOpaqueDeclaration['source']): boolean {
  return stableStringify(a) === stableStringify(b);
}
function guardIdentity(value: unknown): string {
  const result = string(value);
  if (result.length > 4096 || /[\u0000-\u001f\u007f]/.test(result)) return refuse('bounded send-guard identity required.');
  try { encodeURIComponent(result); } catch { return refuse('valid send-guard identity required.'); }
  return result;
}
function sendGuard(set: FrameworkOpaqueDeclarationSet, value: FrameworkOpaqueSendGuardDeclaration, tagged = false): void {
  record(value, ['rule', 'source', 'owner', 'node', 'binding', 'target', 'inputs', ...(tagged ? ['kind'] : [])]);
  for (const key of ['rule', 'owner', 'binding', 'target'] as const) guardIdentity(value[key]);
  source(set, value.source); guardIdentity(value.source.path); guardIdentity(value.source.module);
  record(value.node, ['start', 'end']);
  if (integer(value.node.end) <= integer(value.node.start)) return refuse('nonempty original send-guard interval required.');
  const names = new Set<string>();
  for (const input of array(value.inputs)) {
    const item = record(input, ['name', 'type']), name = guardIdentity(item.name);
    if (names.has(name)) return refuse('complete unique send-guard lexical inputs required.');
    names.add(name); guardIdentity(item.type); type(item.type);
  }
}
function declaration(bound: BoundOpaqueDeclarations, id: string, kind?: FrameworkOpaqueDeclaration['profile']['kind']): BoundDeclaration {
  const found = owner(bound).declarations.get(string(id));
  if (found === undefined || kind !== undefined && found.declaration.profile.kind !== kind) return refuse('exact original declaration ID and profile required.');
  return found;
}
function type(value: unknown): CanTypeId {
  const claim = string(value), parsed = parseTypeId(claim);
  if (printTypeId(parsed) !== claim) return refuse('canonical original type required.');
  return claim as CanTypeId;
}
function defaultShape(value: unknown): void {
  const kind = (value as { kind?: unknown } | null)?.kind;
  const item = record(value, kind === 'literal' || kind === 'context' ? ['kind', 'value'] : kind === 'parent' ? ['kind', 'path'] : ['kind']);
  if (!['literal', 'parent', 'context', 'server', 'derived'].includes(String(kind))) return refuse('checked default declaration required.');
  if (kind === 'parent') string(item.path);
  if (kind === 'context' && item.value !== 'actor') return refuse('exact actor context default required.');
}
const scalarTypes: Readonly<Record<string, string>> = {
  string: 'text', integer: 'int', decimal: 'decimal', money: 'money', datetime: 'datetime',
  duration: 'duration', user: 'user', boolean: 'bool', file: 'file',
};
function boundInput(values: FileReferenceProfileBound, canonical: CanonicalInputDef, artifact: Readonly<ArtifactOperationInput>, sendOnly = false): BoundInput {
  const input = record(canonical, ['name', 'kind', 'required'], ['model', 'versioned', 'valueType', 'enumValues',
    'delivery', 'array', 'nullable', 'min', 'max', 'default', 'computedDefault']);
  const authored = record(artifact, ['name', 'field', 'required'], ['valueType', 'nullable', 'array', 'min', 'max',
    'default', 'computedDefault', 'choices', 'description']);
  string(input.name); boolean(input.required); same(input.name, authored.name); same(input.required, authored.required);
  for (const key of ['min', 'max', 'default', 'computedDefault']) optionalSame(input, authored, key);
  if (Object.hasOwn(input, 'default')) defaultShape(input.default);
  if (Object.hasOwn(input, 'computedDefault') && (input.computedDefault !== true || input.required !== false || Object.hasOwn(input, 'default'))) {
    return refuse('closed computed default marker required.');
  }
  const tag = record(authored.field, ['kind'], ['model', 'requireVersion', 'values', 'name', 'capability', 'operation', 'version', 'result', 'judgment']);
  same(input.kind, tag.kind);
  let original: CanTypeId;
  if (input.kind === 'ref') {
    record(input, ['name', 'kind', 'required', 'model', 'versioned'], ['computedDefault', 'array', 'nullable', 'min', 'max', 'default']);
    record(tag, ['kind', 'model', 'requireVersion']);
    same(input.model, tag.model); same(input.versioned, tag.requireVersion); boolean(input.versioned);
    const model = string(input.model);
    if (!values.canonicalModels.some(candidate => candidate.name === model)) return refuse('same-load reference model required.');
    optionalSame(input, authored, 'array'); optionalSame(input, authored, 'nullable');
    const marker = input.array === undefined ? undefined : record(input.array, ['required']);
    if (marker !== undefined) boolean(marker.required);
    if (input.nullable !== undefined) boolean(input.nullable);
    original = type(`${model}${marker === undefined ? '' : marker.required ? '[]!' : '[]'}${input.nullable === true ? '?' : ''}`);
    if (Object.hasOwn(authored, 'valueType')) same(original, authored.valueType);
  } else if (input.kind === 'delivery') {
    record(input, ['name', 'kind', 'required', 'delivery'], ['min', 'max', 'default']);
    same(input.delivery, tag);
    const delivery = input.delivery as FrameworkOpaqueDeliveryContext['canonical'];
    original = type(`delivery(${string(delivery.capability)}.${string(delivery.operation)})`);
    if (Object.hasOwn(authored, 'valueType')) same(original, authored.valueType);
  } else {
    if (!['nominal', 'enum', ...Object.keys(scalarTypes)].includes(String(input.kind))) return refuse('checked input kind required.');
    record(input, ['name', 'kind', 'required', 'valueType'], ['computedDefault', 'enumValues', 'min', 'max', 'default', 'nullable']);
    original = type(input.valueType);
    if (Object.hasOwn(authored, 'valueType')) same(original, authored.valueType);
    const ast = parseTypeId(original), base = printTypeBase(ast.base);
    const marker = authored.array === undefined ? undefined : record(authored.array, ['required']);
    if (marker !== undefined) boolean(marker.required);
    if (ast.array !== (marker !== undefined) || ast.requiredArray !== (marker?.required === true) ||
        ast.nullable !== (authored.nullable === true)) return refuse('input type/container correspondence required.');
    if (Object.hasOwn(authored, 'nullable')) boolean(authored.nullable);
    if (input.kind === 'nominal') {
      record(tag, ['kind', 'name']);
      if (ast.base.kind !== 'nominal' || tag.name !== ast.base.path) return refuse('actual nominal source tag required.');
    } else if (input.kind === 'enum') {
      record(tag, ['kind', 'values']); same(input.enumValues, tag.values);
      if (ast.base.kind === 'enum') same(ast.base.cases, tag.values);
      else if (ast.base.kind === 'nominal') {
        const name = ast.base.path;
        const cases = values.valueTypes?.enums?.find(item => item.name === name)?.cases;
        if (cases === undefined) return refuse('owning named enum required.');
        same(cases, tag.values);
      } else return refuse('actual enum type required.');
    } else {
      record(tag, ['kind']);
      if (!Object.hasOwn(authored, 'valueType') && base !== scalarTypes[String(input.kind)]) {
        return refuse('collapsed scalar source requires its exact type claim.');
      }
      if (Object.hasOwn(input, 'enumValues') || !(base === scalarTypes[String(input.kind)] ||
          input.kind === 'string' && ['date', 'email', 'timezone', 'currency'].includes(base))) return refuse('actual scalar source type required.');
    }
  }
  if ((input.default as { kind?: unknown } | undefined)?.kind === 'context' &&
      (input.kind !== 'user' || input.required !== false || original !== 'user' && original !== 'user?' || input.computedDefault === true)) {
    return refuse('ordinary singular User context default required.');
  }
  const profile = bindDeclaredFileReferenceProfile(values, original, canonical);
  if ((canonical as { default?: { kind: string; value?: unknown } }).default?.kind === 'literal') {
    fileReferenceOccurrences(profile, (canonical as { default: { value: unknown } }).default.value);
  }
  // Nullable model slots retain their canonical ModelRef/null wire profile.
  // Only a nonnull lexical model row carries an owning stored-row snapshot.
  const modelSnapshot = sendOnly && !parseTypeId(original).nullable
    ? bindModelLexicalSnapshotProfile(values, original) : undefined;
  return { declaration: canonical, profile, ...(modelSnapshot === undefined ? {} : { modelSnapshot }) };
}
function nominalResult(values: FileReferenceProfileBound, canonical: unknown, artifact: unknown): FileReferenceProfile {
  same(canonical, artifact);
  const result = record(canonical, ['name', 'fields']);
  const name = type(result.name), saved = values.valueTypes?.contracts.find(item => item.name === name);
  if (saved === undefined) return refuse('actual provider result contract required.');
  same(result, saved);
  return bindDeclaredFileReferenceProfile(values, name);
}
function deliveryContext(bound: BoundOpaqueDeclarations, context: FrameworkOpaqueDeliveryProfile, installed = false): void {
  const kind = context.kind;
  record(context, kind === 'generation' ? ['kind', 'canonical', 'artifact', 'request'] : kind === 'judgment' ?
    ['kind', 'canonical', 'artifact', 'specification', 'order', 'valueTypes'] : ['kind', 'canonical', 'artifact']);
  if (!['capability', 'generation', 'judgment', ...(installed ? ['generation-profile'] : [])].includes(kind)) return refuse('actual delivery context required.');
  same(context.canonical, context.artifact);
  const original = record(context.canonical, kind === 'judgment' ? ['kind', 'judgment', 'capability', 'operation', 'version', 'result'] :
    ['kind', 'capability', 'operation', 'version', 'result']);
  if (original.kind !== 'delivery') return refuse('actual provider delivery declaration required.');
  string(original.capability); string(original.operation);
  nominalResult(owner(bound).values, original.result, context.artifact.result);
  if (kind === 'judgment' && context.kind === 'judgment') {
    if (original.judgment !== true || original.operation !== 'evaluate' || original.version !== context.specification.version ||
        original.capability !== context.specification.declaration) return refuse('original Judgment specification identity required.');
    const values = owner(bound).values;
    const schema = values.valueSchema ?? normalizeValueTypes(values.valueTypes!, values.canonicalModels.map(model => model.name)).valueSchema;
    const specification = validateValue(schema, 'std.JudgmentSpec', context.specification, 'create');
    same(encodeValue('std.JudgmentSpec', specification), context.specification);
    createJudgmentReceiptContext(context.canonical, specification as unknown as Parameters<typeof createJudgmentReceiptContext>[1], context.valueTypes);
    const questions = [...context.specification.noul, ...context.specification.choice, ...context.specification.score].map(question => question.id);
    const order = array(context.order).map(string);
    if (new Set(order).size !== order.length || order.length !== questions.length || questions.some(id => !order.includes(id))) return refuse('complete original interleaved Judgment order required.');
    same(context.canonical.result.fields.slice(0, order.length).map(field => field.name), order);
    const ownTypes = normalizeValueTypes(context.valueTypes).valueTypes;
    for (const contract of ownTypes.contracts) same(contract, values.valueTypes?.contracts.find(item => item.name === contract.name));
    for (const enumeration of ownTypes.enums ?? []) same(enumeration, values.valueTypes?.enums?.find(item => item.name === enumeration.name));
    for (const alias of ownTypes.aliases ?? []) same(alias, values.valueTypes?.aliases?.find(item => item.name === alias.name));
  } else {
    integer(original.version);
    if (kind === 'generation' && context.kind === 'generation') {
      record(context.request, ['source', 'revision']); string(context.request.source); string(context.request.revision);
      const revision = bindDeclaredFileReferenceProfile(owner(bound).values, 'int' as CanTypeId);
      fileReferenceOccurrences(revision, context.request.revision);
      if (context.request.revision.startsWith('-')) return refuse('nonnegative generation request revision required.');
    }
  }
}

/** Internal correspondence only; authentic installed producer/origin and scope
 * checks remain mandatory. Runtime origins never contain the static profile. */
export function assertOpaqueDeliveryProfileMatch(profile: FrameworkOpaqueDeliveryProfile,
  instance: FrameworkOpaqueDeliveryContext): void {
  if (profile.kind === 'generation-profile') {
    record(profile, ['kind', 'canonical', 'artifact']);
    if (instance.kind !== 'generation') return refuse('static Generation profile requires its original runtime generation instance.');
    record(instance, ['kind', 'canonical', 'artifact', 'request']);
    record(instance.request, ['source', 'revision']);
    string(instance.request.source); string(instance.request.revision);
    const revision = decodeValue('int', instance.request.revision);
    same(encodeValue('int', revision), instance.request.revision);
    if (typeof revision !== 'bigint' || revision < 0n) return refuse('original nonnegative generation request revision required.');
    same(profile.canonical, instance.canonical); same(profile.artifact, instance.artifact);
  } else same(profile, instance);
}

/** Select from the complete original header, never from an extra request tuple.
 * The same origin validator checks IDs, source, intent/association and event
 * correlation before even a no-result projection can consume the profile. */
function originalDeliveryInstance(bound: BoundOpaqueDeclarations, selected: FrameworkOpaqueDeclaration,
  binding: FrameworkFilePayloadOrigin | undefined): FrameworkOpaqueDeliveryContext {
  if (binding === undefined || selected.source.kind !== 'delivery') return refuse('original runtime origin required for static Generation projection.');
  const captured = closedJSON(binding) as FrameworkFilePayloadOrigin;
  validateOpaqueFileOrigin(bound, captured);
  const original = captured.origin;
  let context: FrameworkOpaqueDeliveryContext, source: ScenarioReceiptSourceOrigin, ids: readonly string[];
  if (original.kind === 'delivery-result' || original.kind === 'delivery-skipped') {
    context = original.declaration; source = original.caller.source; ids = [original.resultDeclarationId];
  } else {
    const event = original.kind === 'standard-completion' ? original.declaration
      : original.kind === 'event-input' ? original.declaration
      : original.kind === 'handler-result' ? original.event.declaration
      : original.kind === 'scheduled-handler-result' ? original.event.declaration
      : original.kind === 'source-routing' && (original.recipe.kind === 'scheduled-cohorts' || original.recipe.kind === 'scheduled-routes')
        ? original.recipe.event.declaration : undefined;
    if (event?.kind !== 'standard-completion') return refuse('original delivery instance is absent from this payload origin.');
    context = event.delivery; source = event.source;
    ids = [event.resultDeclarationId, event.sourceInputsDeclarationId];
  }
  if (!ids.includes(selected.id)) return refuse('static Generation projection differs from its original declaration ID.');
  same(selected.source.source, source);
  assertOpaqueDeliveryProfileMatch(selected.source.context, context);
  return context;
}

/** Root supplies complete model/artifact correspondence from its actual loader. */
export function bindOpaqueFileDeclarations(sets: readonly FrameworkOpaqueDeclarationSet[],
  validateModels: (set: FrameworkOpaqueDeclarationSet) => void): ReadonlyMap<string, BoundOpaqueDeclarations> {
  // Freeze this already-detached own-data cohort before any profile binding;
  // its pure schema preparation can then be reused across every declaration.
  const detached = deepFreeze(closedJSON(sets)) as readonly FrameworkOpaqueDeclarationSet[];
  const output = new Map<string, BoundOpaqueDeclarations>();
  for (const set of detached) {
    record(set, ['id', 'inventory', 'snapshot', 'sources', 'canonicalModels', 'artifactModels', 'valueTypes', 'originalContracts', 'valueDefaults', 'declarations']);
    const id = string(set.id);
    if (output.has(id)) return refuse('duplicate historical declaration set.');
    record(set.inventory, ['owner', 'snapshotId', 'digest']);
    for (const value of Object.values(set.inventory)) string(value);
    record(set.snapshot, ['owner', 'snapshotId', 'digest', 'installedRevision', 'installedAt']);
    for (const key of ['owner', 'snapshotId', 'digest'] as const) same(set.snapshot[key], set.inventory[key]);
    integer(set.snapshot.installedRevision); integer(set.snapshot.installedAt);
    const sources = new Set<string>();
    for (const item of array(set.sources) as FrameworkOpaqueDeclarationSet['sources']) {
      record(item, ['path', 'sha256']); string(item.path);
      if (!/^[0-9a-f]{64}$/.test(item.sha256) || sources.has(item.path)) return refuse('complete unique source inventory required.');
      sources.add(item.path);
    }
    array(set.canonicalModels); array(set.artifactModels); array(set.valueDefaults); array(set.declarations);
    validateModels(set);
    const normalized = normalizeValueTypes(set.valueTypes, set.canonicalModels.map(model => model.name));
    same(normalized.valueTypes, set.valueTypes);
    const values: FileReferenceProfileBound = { canonicalModels: set.canonicalModels,
      artifactModels: new Map(set.artifactModels.map(model => [model.name as ModelName, model])), valueTypes: set.valueTypes,
      valueSchema: normalized.valueSchema };
    // Check every original value declaration, including unused union arms; a
    // missing nominal is not a model-reference or File-free fallback.
    for (const entry of [...set.valueTypes.contracts, ...(set.valueTypes.enums ?? []), ...(set.valueTypes.aliases ?? [])]) {
      bindDeclaredFileReferenceProfile(values, type(entry.name));
    }
    const valueDefaults = bindOriginalValueDefaults(set, values, normalized.valueSchema);
    const bound = Object.freeze({ declarationSet: deepFreeze(set) });
    const declarations = new Map<string, BoundDeclaration>();
    owners.set(bound, { values, declarations, valueDefaults });
    for (const item of set.declarations) {
      record(item, ['id', 'source', 'profile']);
      if (declarations.has(string(item.id))) return refuse('duplicate original declaration ID.');
      const from = item.source;
      record(from, from.kind === 'callable' ? ['kind', 'source', 'callable'] : from.kind === 'event' ?
        ['kind', 'source', 'event'] : from.kind === 'send-guard' ?
          ['kind', 'rule', 'source', 'owner', 'node', 'binding', 'target', 'inputs'] : ['kind', 'source', 'context']);
      source(set, from.source);
      if (from.kind === 'callable') {
        callableShape(from.callable);
        if (from.callable.module !== from.source.module) return refuse('original source/callable module correspondence required.');
      } else if (from.kind === 'event') string(from.event);
      else if (from.kind === 'delivery') {
        deliveryContext(bound, from.context, true);
      }
      else if (from.kind === 'send-guard') sendGuard(set, from, true);
      else return refuse('checked source kind required.');
      const profile = item.profile;
      record(profile, ['kind', 'canonical', 'artifact']);
      let inputs: ReadonlyMap<string, BoundInput> | undefined, result: FileReferenceProfile | undefined;
      if (profile.kind === 'inputs') {
        const canonical = array(profile.canonical), artifact = array(profile.artifact);
        if (canonical.length !== artifact.length) return refuse('complete ordered original inputs required.');
        if (from.kind === 'send-guard' && canonical.length !== from.inputs.length) return refuse('complete original send-guard inputs required.');
        const members = new Map<string, BoundInput>();
        for (let index = 0; index < canonical.length; index++) {
          const input = boundInput(values, canonical[index] as CanonicalInputDef, artifact[index] as ArtifactOperationInput, from.kind === 'send-guard');
          if (from.kind === 'send-guard') {
            const expected = from.inputs[index]!;
            if (input.declaration.name !== expected.name || input.profile.type !== expected.type || input.declaration.required !== true ||
                ['default', 'computedDefault'].some(key => Object.hasOwn(canonical[index]!, key) || Object.hasOwn(artifact[index]!, key))) {
              return refuse('exact ordered send-guard lexical input profile without defaults required.');
            }
          }
          if (members.has(input.declaration.name)) return refuse('duplicate original input.');
          members.set(input.declaration.name, input);
        }
        inputs = members;
      } else if (profile.kind === 'result') {
        record(profile.canonical, ['type'], ['disclosure']); record(profile.artifact, ['type'], ['disclosure']);
        same(profile.canonical, profile.artifact);
        if (profile.canonical.type === 'void' || from.kind !== 'callable') return refuse('actual callable result or explicit void profile required.');
        result = bindDeclaredFileReferenceProfile(values, type(profile.canonical.type));
      } else if (profile.kind === 'provider-result') {
        result = nominalResult(values, profile.canonical, profile.artifact);
        if (from.kind !== 'delivery') return refuse('provider result must own its actual delivery source.');
        same(profile.canonical, from.context.canonical.result);
      } else if (profile.kind === 'void') {
        record(profile.canonical, ['type'], ['disclosure']); record(profile.artifact, ['type'], ['disclosure']);
        same(profile.canonical, profile.artifact);
        if (profile.canonical.type !== 'void' || profile.artifact.type !== 'void' || from.kind !== 'callable') return refuse('explicit source-declared void required.');
      } else return refuse('complete original profile required.');
      declarations.set(item.id, { declaration: item, ...(inputs === undefined ? {} : { inputs }), ...(result === undefined ? {} : { result }) });
    }
    output.set(id, bound);
  }
  return output;
}

/** The value argument is the actual value selected at projection.path by root. */
export function resolveOpaqueFileProjection(bound: BoundOpaqueDeclarations, projection: FrameworkOpaqueValueProjection,
  value: unknown, binding?: FrameworkFilePayloadOrigin): readonly { readonly path: readonly (string | number)[]; readonly ref: string }[] {
  const picked = closedJSON(projection) as FrameworkOpaqueValueProjection;
  const wire = closedJSON(value);
  record(picked, picked.kind === 'default' ? ['path', 'kind', 'owner'] : picked.kind === 'result' ?
    ['path', 'kind', 'declarationId', 'presence'] : ['path', 'kind', 'declarationId']);
  if (array(picked.path).some(part => typeof part === 'string' ? part === '' : typeof part !== 'number' || !Number.isSafeInteger(part) || part < 0)) return refuse('exact projection path required.');
  if (picked.kind === 'inputs') {
    const selected = declaration(bound, picked.declarationId, 'inputs');
    if (selected.declaration.source.kind === 'delivery' && selected.declaration.source.context.kind === 'generation-profile') {
      originalDeliveryInstance(bound, selected.declaration, binding);
    }
    if (selected.declaration.source.kind === 'send-guard') {
      const queued = binding?.origin.kind === 'source-routing' && binding.origin.recipe.kind === 'queued-routes'
        ? binding.origin.recipe : undefined;
      if (queued?.guard !== undefined && queued.guard.inputsDeclarationId === picked.declarationId) {
        validateOpaqueFileOrigin(bound, binding!);
        same(queued.guard.declaration, (() => { const { kind: _kind, ...original } = selected.declaration.source; return original; })());
        same(picked.path, ['origin', 'dispatch', 'sourceGuard', 'inputs']);
      } else same(picked.path, ['inputs']);
    }
    const inputs = selected.inputs!;
    const data = record(wire, [], [...inputs.keys()]);
    const found: { path: readonly (string | number)[]; ref: string }[] = [];
    for (const [name, input] of inputs) {
      if (!Object.hasOwn(data, name)) {
        if (input.declaration.required) return refuse('required original admitted input missing.');
        continue;
      }
      const member = data[name];
      if (input.modelSnapshot === undefined && input.declaration.kind === 'ref' && input.declaration.versioned) {
        for (const ref of input.profile.array && member !== null ? array(member) : member === null ? [] : [member]) {
          if (typeof ref !== 'object' || ref === null || !Object.hasOwn(ref, 'version')) return refuse('original admitted reference version required.');
        }
      }
      for (const item of input.modelSnapshot === undefined ? fileReferenceOccurrences(input.profile, member)
        : modelLexicalSnapshotOccurrences(input.modelSnapshot, member)) found.push({ path: [name, ...item.path], ref: item.ref });
    }
    return deepFreeze(found);
  }
  if (picked.kind === 'result') {
    const selected = declaration(bound, picked.declarationId);
    if (!['result', 'provider-result', 'void'].includes(selected.declaration.profile.kind)) return refuse('actual result declaration required.');
    const from = selected.declaration.source;
    const context = from.kind !== 'delivery' ? undefined : from.context.kind === 'generation-profile'
      ? originalDeliveryInstance(bound, selected.declaration, binding) : from.context;
    if (picked.presence === 'no-result') {
      if (wire !== null) return refuse('no-result projection requires actual null.');
      return Object.freeze([]);
    }
    if (picked.presence !== 'value' || selected.result === undefined) return refuse('explicit void cannot contain a value.');
    if (context !== undefined) {
      if (context.kind === 'generation') {
        const result = record(wire, ['source', 'revision'], context.canonical.result.fields.map(field => field.name));
        same(result.source, context.request.source); same(result.revision, context.request.revision);
      } else if (context.kind === 'judgment') {
        const values = owner(bound).values;
        const specification = validateValue(values.valueSchema!, 'std.JudgmentSpec', context.specification, 'create');
        const actual = createJudgmentReceiptContext(context.canonical, specification as unknown as Parameters<typeof createJudgmentReceiptContext>[1], context.valueTypes);
        if (readJudgmentResult(wire, actual) === null) return refuse('result violates original Judgment specification.');
      }
    }
    return fileReferenceOccurrences(selected.result, wire);
  }
  if (picked.kind !== 'default') return refuse('typed projection kind required.');
  const owning = picked.owner, values = owner(bound).values;
  record(owning, owning.kind === 'input' ? ['kind', 'declarationId', 'input'] : owning.kind === 'model-field' ?
    ['kind', 'model', 'field'] : ['kind', 'contract', 'field']);
  let profile: FileReferenceProfile;
  if (owning.kind === 'input') {
    const input = declaration(bound, owning.declarationId, 'inputs').inputs!.get(string(owning.input));
    if (input === undefined) return refuse('actual original default input required.');
    if (input.declaration.default?.kind !== 'literal') return refuse('actual original literal input default required.');
    same(wire, input.declaration.default.value);
    profile = input.profile;
  } else if (owning.kind === 'model-field') {
    const field = values.canonicalModels.find(model => model.name === owning.model)?.fields[string(owning.field)];
    if (field?.default?.kind !== 'literal') return refuse('actual original literal model default required.');
    same(wire, field.default.value);
    profile = bindFileReferenceProfile(values, owning.model, string(owning.field));
  } else if (owning.kind === 'value-field') {
    const original = owner(bound).valueDefaults.get(valueDefaultKey(string(owning.contract), string(owning.field)));
    if (original === undefined) return refuse('exact original value-field literal default required.');
    same(wire, original.original.value);
    return valueDefaultOccurrences(original, wire);
  } else return refuse('actual default owner required.');
  return fileReferenceOccurrences(profile, wire);
}

function valueDefaultKey(contract: string, field: string): string {
  return stableStringify([contract, field]);
}
function leafProfile(values: FileReferenceProfileBound, field: CanonicalNominalLeaf): FileReferenceProfile {
  return bindDeclaredFileReferenceProfile(values, type(field.type), {
    valueType: type(field.type), ...(Object.hasOwn(field, 'trim') ? { trim: field.trim } : {}),
    ...(Object.hasOwn(field, 'min') ? { min: field.min } : {}), ...(Object.hasOwn(field, 'max') ? { max: field.max } : {}),
  });
}
/** Compare full original declarations through Values, independently of the
 * supplied default table. Default presence and raw literals survive normalization. */
function bindOriginalValueDefaults(set: FrameworkOpaqueDeclarationSet, values: FileReferenceProfileBound,
  canonicalSchema: NormalizedSchema): ReadonlyMap<string, BoundValueDefault> {
  const contracts = record(set.originalContracts, set.valueTypes.contracts.map(contract => contract.name));
  const originalForSchema: Record<string, unknown> = Object.create(null);
  const reusable: Record<string, unknown> = Object.create(null);
  const expected = new Map<string, { readonly field: CanonicalNominalLeaf; readonly value: WireValue }>();
  for (const contract of set.valueTypes.contracts) {
    // The compiler contract declaration carries its long-standing
    // visibility and caption wire alongside the fields; field
    // correspondence below is unchanged.
    const original = record(contracts[contract.name], ['fields'], ['exported', 'label']);
    if (Object.hasOwn(original, 'exported') && typeof original.exported !== 'boolean') {
      return refuse('original contract visibility marker required.');
    }
    if (Object.hasOwn(original, 'label') && !(typeof original.label === 'string' ||
        (typeof original.label === 'object' && original.label !== null && !Array.isArray(original.label)))) {
      return refuse('original contract caption wire required.');
    }
    const fields = record(original.fields, contract.fields.map(field => field.name));
    const reusedFields: Record<string, unknown> = Object.create(null);
    const originalFields: Record<string, unknown> = Object.create(null);
    for (const field of contract.fields) {
      const raw = record(fields[field.name], ['type'], ['array', 'nullable', 'trim', 'min', 'max', 'format', 'distinctBy', 'excludedIds',
        'default', 'server', 'derived', 'label']);
      if (Object.hasOwn(raw, 'label') && !(typeof raw.label === 'string' ||
          (typeof raw.label === 'object' && raw.label !== null && !Array.isArray(raw.label)))) {
        return refuse('original contract field caption wire required.');
      }
      const array = Object.hasOwn(raw, 'array') ? boolean(raw.array) : undefined;
      const nullable = Object.hasOwn(raw, 'nullable') ? boolean(raw.nullable) : undefined;
      const spelling = `${string(raw.type)}${array === true ? '[]' : ''}${nullable === true ? '?' : ''}`;
      const parsed = parseTypeId(spelling), canonicalType = printTypeId(parsed), base = parsed.base;
      if (canonicalType !== spelling || array === false && parsed.array || nullable === false && parsed.nullable) {
        return refuse('canonical original type wrappers required.');
      }
      same(canonicalType, field.type);
      const lengthBound = parsed.array || base.kind === 'stringlike' || base.kind === 'scalar' && base.name === 'text' ||
        base.kind === 'nominal' && Object.hasOwn(canonicalSchema.aliases ?? {}, base.path);
      // Native wrappers remain in the original journal; Values owns their
      // grammar through the equivalent type spelling in this local schema.
      // Display captions are compiler wire, never schema: strip them here.
      const { array: _array, nullable: _nullable, label: _label, ...schemaField } = raw;
      const forSchema: Record<string, unknown> = { ...schemaField, type: canonicalType };
      // Native integer metadata retains its int64 wire in the journal. Values'
      // schema API takes exact numeric lengths; decode only those bounds here.
      if (lengthBound) for (const key of ['min', 'max'] as const) if (typeof raw[key] === 'string') {
        const bound = decodeValue('int', raw[key]);
        same(encodeValue('int', bound), raw[key]);
        if (typeof bound !== 'bigint' || bound < 0n || bound > BigInt(Number.MAX_SAFE_INTEGER)) {
          return refuse('exact safe original length bound required.');
        }
        forSchema[key] = Number(bound);
      }
      originalFields[field.name] = forSchema;
      // Field reuse deliberately drops creation metadata, but no constraints.
      const { default: _default, server: _server, derived: _derived, ...reused } = forSchema;
      reusedFields[field.name] = reused;
      if (Object.hasOwn(raw, 'default')) expected.set(valueDefaultKey(contract.name, field.name),
        { field, value: raw.default as WireValue });
    }
    reusable[contract.name] = { fields: reusedFields };
    originalForSchema[contract.name] = { fields: originalFields };
  }
  const common = { enums: canonicalSchema.enums,
    ...(set.valueTypes.aliases === undefined ? {} : { aliases: Object.fromEntries(set.valueTypes.aliases.map(alias => {
      const { name, ...descriptor } = alias; return [name, descriptor];
    })) }) };
  const originalSchema = normalizeSchema({ contracts: originalForSchema, ...common });
  const reusedSchema = normalizeSchema({ contracts: reusable, ...common });
  const signature = (field: NormalizedField): unknown => {
    const { type: parsed, valueMin, valueMax, ...rest } = field;
    return { ...rest,
      ...(valueMin === undefined ? {} : { valueMin: encodeValue(printTypeBase(parsed.base), valueMin) }),
      ...(valueMax === undefined ? {} : { valueMax: encodeValue(printTypeBase(parsed.base), valueMax) }) };
  };
  for (const contract of set.valueTypes.contracts) for (const field of contract.fields) {
    same(signature(reusedSchema.contracts[contract.name]!.fields[field.name]!),
      signature(canonicalSchema.contracts[contract.name]!.fields[field.name]!));
  }
  const defaults = new Map<string, BoundValueDefault>();
  for (const original of set.valueDefaults) {
    record(original, ['contract', 'field', 'value']);
    const key = valueDefaultKey(string(original.contract), string(original.field)), raw = expected.get(key);
    if (raw === undefined || defaults.has(key)) return refuse('one exact original own value-field default required.');
    same(original.value, raw.value);
    const validated = originalSchema.contracts[original.contract]!.fields[original.field]!;
    if (!validated.hasDefault || validated.default === undefined) return refuse('owning literal default validation required.');
    const item = { original, profile: leafProfile(values, raw.field),
      validatedWire: encodeValue(raw.field.type, validated.default, undefined, originalSchema) };
    valueDefaultOccurrences(item, original.value);
    defaults.set(key, item);
  }
  if (defaults.size !== expected.size) return refuse('complete original own value-field default census required.');
  return defaults;
}

/** Values may normalize text in a legal default. Keep the original raw literal,
 * traverse its validated value, and require every File at its actual raw path. */
function valueDefaultOccurrences(item: BoundValueDefault, wire: unknown):
  readonly { readonly path: readonly (string | number)[]; readonly ref: string }[] {
  same(wire, item.original.value);
  const found = fileReferenceOccurrences(item.profile, item.validatedWire);
  for (const occurrence of found) {
    let raw: unknown = wire;
    for (const part of occurrence.path) {
      if (typeof raw !== 'object' || raw === null || !Object.hasOwn(raw, part)) return refuse('original raw File path required.');
      raw = (raw as Record<string | number, unknown>)[part];
    }
    same(raw, { id: occurrence.ref });
  }
  return found;
}

function callable(bound: BoundOpaqueDeclarations, value: FrameworkOpaqueCallable): void {
  record(value, ['source', 'callable', 'canonical', 'artifact', 'resultDeclarationId']);
  source(bound.declarationSet, value.source); callableShape(value.callable);
  record(value.canonical, ['name', 'kind', 'inputs'], ['result']);
  record(value.artifact, ['name', 'kind', 'description', 'inputs'], ['result', 'rootAuthority']);
  if (value.artifact.rootAuthority !== undefined) {
    const root = record(value.artifact.rootAuthority, ['binding', 'model'], ['createsRoot']);
    string(root.binding); string(root.model);
    if (!bound.declarationSet.canonicalModels.some(model => model.name === root.model)) return refuse('actual original root model required.');
    if (Object.hasOwn(root, 'createsRoot') && root.createsRoot !== true) return refuse('actual checked root creation marker required.');
  }
  if (value.callable.module !== value.source.module || value.callable.id !== value.canonical.name ||
      value.callable.id !== value.artifact.name || value.canonical.kind !== value.artifact.kind) return refuse('complete original callable identity required.');
  if (typeof value.artifact.description !== 'string' || !['read', 'create', 'update', 'delete', 'scenario'].includes(value.canonical.kind)) return refuse('actual original callable descriptor required.');
  const sourceClaim: FrameworkOpaqueDeclaration['source'] = { kind: 'callable', source: value.source, callable: value.callable };
  const inputs = [...owner(bound).declarations.values()].filter(item => item.declaration.profile.kind === 'inputs' && sourceEqual(item.declaration.source, sourceClaim));
  if (inputs.length !== 1) return refuse('one complete original callable input declaration required.');
  const profile = inputs[0]!.declaration.profile;
  if (profile.kind !== 'inputs') return refuse('original input declaration required.');
  record(value.artifact.inputs, ['fields']);
  same(profile.canonical, value.canonical.inputs); same(profile.artifact, value.artifact.inputs.fields);
  const result = declaration(bound, value.resultDeclarationId);
  if (!sourceEqual(result.declaration.source, sourceClaim)) return refuse('original callable result source required.');
  if (result.declaration.profile.kind === 'void') {
    if (value.canonical.result !== undefined || value.artifact.result !== undefined) {
      same(value.canonical.result, result.declaration.profile.canonical); same(value.artifact.result, result.declaration.profile.artifact);
    }
  } else if (result.declaration.profile.kind === 'result') {
    same(value.canonical.result, result.declaration.profile.canonical); same(value.artifact.result, result.declaration.profile.artifact);
  } else return refuse('actual original callable result or explicit void required.');
}
function eventDeclaration(bound: BoundOpaqueDeclarations, value: FrameworkOpaqueEventDeclaration): void {
  source(bound.declarationSet, value.source);
  if (value.kind === 'declared-event') {
    record(value, ['kind', 'source', 'event', 'inputsDeclarationId']);
    const input = declaration(bound, value.inputsDeclarationId, 'inputs').declaration;
    same(input.source, { kind: 'event', source: value.source, event: value.event });
  } else if (value.kind === 'committed-change') {
    record(value, ['kind', 'source', 'descriptor', 'change', 'projectionInputsDeclarationId']);
    committedDescriptor(bound, value.source, value.descriptor);
    record(value.change, ['recordId', 'owner', 'version', 'occurrenceId']);
    string(value.change.recordId); string(value.change.owner); integer(value.change.version); string(value.change.occurrenceId);
    const input = declaration(bound, value.projectionInputsDeclarationId, 'inputs').declaration;
    if (input.source.kind === 'callable') {
      if (input.source.callable.kind !== 'handler' || !value.descriptor.handlers.includes(input.source.callable.id)) return refuse('actual private committed handler input declaration required.');
    } else same(input.source, { kind: 'event', source: value.source, event: value.descriptor.source });
  } else if (value.kind === 'standard-completion') {
    record(value, ['kind', 'source', 'event', 'providerSource', 'binding', 'from', 'sourceInputsDeclarationId',
      'inputsDeclarationId', 'resultDeclarationId', 'delivery']);
    deliveryContext(bound, value.delivery); string(value.binding); string(value.from); string(value.event);
    if (value.providerSource !== `${value.delivery.canonical.capability}.${value.delivery.canonical.operation}`) return refuse('original provider completion source required.');
    const input = declaration(bound, value.inputsDeclarationId, 'inputs').declaration;
    same(input.source, { kind: 'event', source: value.source, event: value.event });
    const original = declaration(bound, value.sourceInputsDeclarationId, 'inputs').declaration;
    if (original.source.kind === 'delivery') {
      same(original.source.source, value.source);
      assertOpaqueDeliveryProfileMatch(original.source.context, value.delivery);
    }
    else if (original.source.kind !== 'callable' || original.source.callable.id !== value.providerSource) return refuse('actual original provider input declaration required.');
    const result = declaration(bound, value.resultDeclarationId, 'provider-result').declaration;
    if (result.source.kind !== 'delivery') return refuse('actual original provider result source required.');
    same(result.source.source, value.source);
    assertOpaqueDeliveryProfileMatch(result.source.context, value.delivery);
  } else return refuse('actual event declaration required.');
}
function eventOrigin(bound: BoundOpaqueDeclarations, value: FrameworkOpaqueEventInputOrigin): void {
  record(value, ['kind', 'occurrenceId', 'sourceOccurrence', 'declaration', 'lineage', 'target']);
  if (value.kind !== 'event-input') return refuse('original event input origin required.');
  string(value.occurrenceId); string(value.sourceOccurrence); eventDeclaration(bound, value.declaration);
  if (value.lineage.kind === 'schedule') {
    record(value.lineage, ['kind', 'key', 'replaces']); string(value.lineage.key);
    if (value.lineage.replaces !== null) string(value.lineage.replaces);
  } else if (value.lineage.kind === 'source') {
    record(value.lineage, ['kind', 'sourceOccurrence']); same(value.lineage.sourceOccurrence, value.sourceOccurrence);
  } else return refuse('original event lineage required.');
  if (value.target.kind === 'handler') {
    record(value.target, ['kind', 'handler']); callable(bound, value.target.handler);
    if (value.declaration.kind === 'committed-change') {
      if (!value.declaration.descriptor.handlers.includes(value.target.handler.callable.id)) return refuse('original matching committed handler required.');
      const projected = declaration(bound, value.declaration.projectionInputsDeclarationId, 'inputs').declaration;
      if (projected.source.kind === 'callable') {
        same(projected.source.callable, value.target.handler.callable);
        if (projected.profile.kind !== 'inputs') return refuse('actual committed handler inputs required.');
        same(projected.profile.canonical, value.target.handler.canonical.inputs);
      }
    }
  } else if (value.target.kind === 'queue-publication') {
    record(value.target, ['kind', 'intent']);
    record(value.target.intent, ['intentId', 'operation', 'operationId', 'target', 'occurrenceIndex']);
    for (const key of ['intentId', 'operation', 'operationId', 'target'] as const) string(value.target.intent[key]);
    integer(value.target.intent.occurrenceIndex);
    if (value.declaration.kind !== 'declared-event' || value.lineage.kind !== 'source') return refuse('queue publication requires its original declared event/source.');
    same(value.occurrenceId, value.target.intent.intentId); same(value.sourceOccurrence, value.target.intent.intentId);
    same(value.target.intent.target, `${value.declaration.event}.publish`);
  } else if (value.target.kind === 'schedule') record(value.target, ['kind']);
  else return refuse('actual event target required.');
}
function committedDescriptor(bound: BoundOpaqueDeclarations, origin: ScenarioReceiptSourceOrigin,
  descriptor: { source: string; model: string; change: string; handlers: readonly string[] }): void {
  source(bound.declarationSet, origin); record(descriptor, ['source', 'model', 'change', 'handlers']);
  const event = { create: 'created', update: 'updated', delete: 'deleted' }[descriptor.change as 'create' | 'update' | 'delete'];
  if (descriptor.source !== `${descriptor.model}.${event}`) return refuse('actual committed event identity required.');
  if (!bound.declarationSet.canonicalModels.some(model => model.name === descriptor.model) ||
      !['create', 'update', 'delete'].includes(descriptor.change)) return refuse('actual original committed model/change required.');
  const handlers = array(descriptor.handlers).map(string);
  if (new Set(handlers).size !== handlers.length) return refuse('complete unique committed handlers required.');
  for (const id of handlers) {
    if (![...owner(bound).declarations.values()].some(item => item.declaration.source.kind === 'callable' &&
        item.declaration.source.callable.id === id && item.declaration.source.callable.kind === 'handler')) return refuse('original source-declared handler required.');
  }
}
function routes(bound: BoundOpaqueDeclarations, values: readonly FrameworkOpaqueSourceRoute[]): void {
  for (const route of array(values) as readonly FrameworkOpaqueSourceRoute[]) {
    callable(bound, route.handler);
    if (route.kind === 'ordinary') {
      record(route, ['kind', 'handler', 'occurrenceId']); string(route.occurrenceId);
    } else if (route.kind === 'fanout') {
      record(route, ['kind', 'handler', 'cohort', 'fanoutId', 'members', 'memberCount', 'firstChunkCount', 'cursor']);
      const cohort = route.cohort;
      record(cohort, cohort.kind === 'model' ? ['kind', 'owner', 'model'] : ['kind', 'owner', 'model', 'parent']);
      string(cohort.owner); string(route.fanoutId);
      if (!bound.declarationSet.canonicalModels.some(model => model.name === cohort.model)) return refuse('same historical cohort model required.');
      if (cohort.kind === 'anchored-collection') {
        record(cohort.parent, ['model', 'id']); string(cohort.parent.id);
        const model = bound.declarationSet.artifactModels.find(model => model.name === cohort.model);
        if (model?.parent !== cohort.parent.model) return refuse('actual anchored collection parent required.');
      } else if (cohort.kind !== 'model') return refuse('actual cohort kind required.');
      const members = array(route.members).map(string);
      if (new Set(members).size !== members.length || integer(route.memberCount) !== members.length ||
          integer(route.firstChunkCount) > members.length || route.cursor !== null && typeof route.cursor !== 'string') return refuse('complete original fanout membership required.');
    } else return refuse('actual source route required.');
  }
}
function bounds(value: unknown): void {
  const item = record(value, ['maxSources', 'maxHandlers', 'maxMembers', 'chunkSize']);
  if (Object.values(item).some(value => integer(value) === 0)) return refuse('positive source routing bounds required.');
}
function origin(bound: BoundOpaqueDeclarations, value: FrameworkOpaquePayloadOrigin): void {
  if (value.kind === 'send-guard') {
    record(value, ['kind', 'intent', 'declaration', 'inputsDeclarationId']);
    sendGuard(bound.declarationSet, value.declaration);
    record(value.intent, ['intentId', 'operation', 'operationId', 'target', 'occurrenceIndex', 'dispatchGuard']);
    for (const key of ['intentId', 'operation', 'operationId', 'target', 'dispatchGuard'] as const) guardIdentity(value.intent[key]);
    integer(value.intent.occurrenceIndex);
    if (value.intent.dispatchGuard !== value.declaration.rule || value.intent.operation !== value.declaration.owner ||
        value.intent.target !== value.declaration.target) return refuse('actual original send-guard intent required.');
    const selected = declaration(bound, value.inputsDeclarationId, 'inputs').declaration;
    if (!sourceEqual(selected.source, { kind: 'send-guard', ...value.declaration })) return refuse('exact original send-guard input source required.');
  } else if (value.kind === 'delivery-skipped') {
    record(value, ['kind', 'deliveryId', 'send', 'request', 'caller', 'association', 'guard', 'declaration', 'resultDeclarationId']);
    string(value.deliveryId); callable(bound, value.caller); deliveryContext(bound, value.declaration);
    sendGuard(bound.declarationSet, value.guard);
    record(value.send, ['operation', 'operationId', 'target', 'occurrenceIndex']);
    for (const key of ['operation', 'operationId', 'target'] as const) string(value.send[key]);
    integer(value.send.occurrenceIndex);
    record(value.request, ['binding', 'from']); string(value.request.binding); string(value.request.from);
    same(value.send.operation, value.caller.callable.id); same(value.send.operation, value.guard.owner);
    same(value.send.target, value.guard.target); same(value.request.binding, value.guard.binding);
    same(value.guard.source, value.caller.source);
    if (value.send.target !== `${value.declaration.canonical.capability}.${value.declaration.canonical.operation}`) return refuse('actual skipped provider target required.');
    const guards = [...owner(bound).declarations.values()].filter(item => item.declaration.source.kind === 'send-guard' &&
      sourceEqual(item.declaration.source, { kind: 'send-guard', ...value.guard }));
    if (guards.length !== 1 || guards[0]!.declaration.profile.kind !== 'inputs') return refuse('one complete original skipped SEND guard required.');
    record(value.association, ['model', 'recordId', 'field']); string(value.association.recordId);
    const field = bound.declarationSet.canonicalModels.find(model => model.name === value.association.model)?.fields[value.association.field];
    if (field?.delivery === undefined || field.array !== undefined) return refuse('actual skipped owning delivery association required.');
    same(field.delivery, value.declaration.canonical);
    const result = declaration(bound, value.resultDeclarationId).declaration;
    if (!['provider-result', 'void'].includes(result.profile.kind) || result.source.kind !== 'delivery') return refuse('original skipped provider result source required.');
    assertOpaqueDeliveryProfileMatch(result.source.context, value.declaration); same(result.source.source, value.caller.source);
  } else if (value.kind === 'delivery-result') {
    record(value, ['kind', 'deliveryId', 'intent', 'request', 'caller', 'association', 'declaration', 'resultDeclarationId']);
    callable(bound, value.caller); deliveryContext(bound, value.declaration);
    record(value.intent, ['intentId', 'operation', 'operationId', 'target', 'occurrenceIndex']);
    for (const key of ['intentId', 'operation', 'operationId', 'target'] as const) string(value.intent[key]);
    integer(value.intent.occurrenceIndex);
    record(value.request, ['binding', 'from']); string(value.request.binding); string(value.request.from);
    same(value.deliveryId, value.intent.intentId); same(value.caller.callable.id, value.intent.operation);
    if (value.intent.target !== `${value.declaration.canonical.capability}.${value.declaration.canonical.operation}`) return refuse('actual provider dispatch target required.');
    record(value.association, ['model', 'recordId', 'field']); string(value.association.recordId);
    const field = bound.declarationSet.canonicalModels.find(model => model.name === value.association.model)?.fields[value.association.field];
    if (field?.delivery === undefined) return refuse('actual owning delivery association required.');
    same(field.delivery, value.declaration.canonical);
    const result = declaration(bound, value.resultDeclarationId, 'provider-result').declaration;
    if (result.source.kind !== 'delivery') return refuse('original delivery result source required.');
    assertOpaqueDeliveryProfileMatch(result.source.context, value.declaration); same(result.source.source, value.caller.source);
  } else if (value.kind === 'event-input') eventOrigin(bound, value);
  else if (value.kind === 'handler-result') {
    record(value, ['kind', 'occurrenceId', 'operationId', 'handler', 'event']);
    string(value.occurrenceId); string(value.operationId); callable(bound, value.handler); eventOrigin(bound, value.event);
    same(value.occurrenceId, value.event.occurrenceId);
    if (value.event.target.kind !== 'handler') return refuse('actual handler input target required.');
    same(value.handler, value.event.target.handler);
  } else if (value.kind === 'scheduled-handler-result') {
    record(value, ['kind', 'occurrenceId', 'operationId', 'handler', 'event', 'terminal']);
    string(value.occurrenceId); string(value.operationId); callable(bound, value.handler); eventOrigin(bound, value.event);
    if (value.handler.callable.kind !== 'handler' || value.event.target.kind !== 'schedule' ||
        value.event.lineage.kind !== 'schedule' || value.event.declaration.kind !== 'declared-event') {
      return refuse('direct due result requires its original scheduled declared event and handler.');
    }
    same(value.occurrenceId, value.event.occurrenceId);
    same(value.occurrenceId, value.event.sourceOccurrence);
    same(value.handler.source, value.event.declaration.source);
    const inputs = declaration(bound, value.event.declaration.inputsDeclarationId, 'inputs').declaration;
    if (inputs.profile.kind !== 'inputs' || value.handler.canonical.kind !== 'scenario' ||
        value.handler.artifact.kind !== 'scenario' ||
        declaration(bound, value.handler.resultDeclarationId).declaration.profile.kind !== 'void') {
      return refuse('direct due result requires the original void scenario handler and event inputs.');
    }
    same(inputs.profile.canonical, value.handler.canonical.inputs);
    same(inputs.profile.artifact, value.handler.artifact.inputs.fields);
    record(value.terminal, ['status', 'result', 'code', 'message']);
    if (value.terminal.result !== null ||
        value.terminal.status !== 'completed' && value.terminal.status !== 'failed' ||
        value.terminal.code !== null && typeof value.terminal.code !== 'string' ||
        value.terminal.message !== null && typeof value.terminal.message !== 'string' ||
        value.terminal.status === 'completed' && (value.terminal.code !== null || value.terminal.message !== null) ||
        value.terminal.status === 'failed' && (value.terminal.code === null || value.terminal.message === null)) {
      return refuse('direct due result requires its exact void terminal outcome.');
    }
  } else if (value.kind === 'source-routing') {
    record(value, ['kind', 'occurrenceId', 'revision', 'recipe']); string(value.occurrenceId); integer(value.revision);
    const recipe = value.recipe;
    if (recipe.kind === 'committed-model') {
      record(recipe, ['kind', 'source', 'descriptor', 'change', 'payload', 'context', 'bounds', 'routes']);
      committedDescriptor(bound, recipe.source, recipe.descriptor);
      record(recipe.change, ['model', 'recordId', 'version', 'kind']);
      same(recipe.change.model, recipe.descriptor.model); string(recipe.change.recordId); integer(recipe.change.version);
      same(recipe.change.kind, { create: 'created', update: 'updated', delete: 'deleted' }[recipe.descriptor.change]);
      record(recipe.payload, ['recordId', 'owner', 'version', 'occurrenceId']);
      same(recipe.payload.recordId, recipe.change.recordId); same(recipe.payload.version, recipe.change.version);
      same(recipe.payload.occurrenceId, value.occurrenceId); string(recipe.payload.owner);
      record(recipe.context, ['kind', 'app', 'actor', 'team', 'operation', 'operationId', 'source', 'now'], ['trustedSource']);
      for (const key of ['app', 'operation', 'operationId', 'source'] as const) string(recipe.context[key]);
      integer(recipe.context.now); bounds(recipe.bounds);
      for (const route of recipe.routes) if (!recipe.descriptor.handlers.includes(route.handler.callable.id)) return refuse('actual committed-model route handler required.');
      routes(bound, recipe.routes);
    } else if (recipe.kind === 'queued-routes') {
      record(recipe, ['kind', 'declaration', 'originalIntent', 'originalCommit', 'routes'], ['guard']);
      eventDeclaration(bound, recipe.declaration);
      record(recipe.originalIntent, ['intentId', 'operation', 'operationId', 'target', 'occurrenceIndex']);
      for (const key of ['intentId', 'operation', 'operationId', 'target'] as const) string(recipe.originalIntent[key]);
      integer(recipe.originalIntent.occurrenceIndex);
      same(recipe.originalIntent.target, `${recipe.declaration.event}.publish`);
      same(value.occurrenceId, `queue/v1/${encodeURIComponent(recipe.originalIntent.intentId)}`);
      record(recipe.originalCommit, ['revision', 'createdAt']); integer(recipe.originalCommit.revision); integer(recipe.originalCommit.createdAt);
      if (recipe.originalCommit.revision >= value.revision) return refuse('queue publication must precede its intake.');
      if (recipe.guard !== undefined) {
        origin(bound, recipe.guard);
        const { dispatchGuard: _rule, ...originalIntent } = recipe.guard.intent;
        same(originalIntent, recipe.originalIntent);
      }
      routes(bound, recipe.routes);
      if (recipe.routes.some(route => route.kind !== 'ordinary')) return refuse('queue requires exact ordinary handler routes.');
    } else if (recipe.kind === 'scheduled-cohorts' || recipe.kind === 'scheduled-routes') {
      record(recipe, ['kind', 'event', 'bounds', 'routes']); eventOrigin(bound, recipe.event);
      record(recipe.bounds, ['pageLimit', 'chunkSize']);
      if (integer(recipe.bounds.pageLimit) === 0 || integer(recipe.bounds.chunkSize) === 0) return refuse('positive scheduled bounds required.');
      same(recipe.event.occurrenceId, value.occurrenceId); routes(bound, recipe.routes);
      if (recipe.kind === 'scheduled-cohorts' && recipe.routes.some(route => route.kind !== 'fanout')) return refuse('actual scheduled cohort routes required.');
    } else return refuse('actual source routing recipe required.');
  } else if (value.kind === 'standard-completion') {
    record(value, ['kind', 'occurrenceId', 'declaration', 'originalIntent', 'originalCommit', 'dispatch', 'terminal', 'revision', 'bounds', 'routes']);
    string(value.occurrenceId); eventDeclaration(bound, value.declaration); integer(value.revision);
    record(value.originalIntent, ['intentId', 'operation', 'operationId', 'target', 'occurrenceIndex']);
    for (const key of ['intentId', 'operation', 'operationId', 'target'] as const) string(value.originalIntent[key]);
    integer(value.originalIntent.occurrenceIndex);
    same(value.originalIntent.target, value.declaration.providerSource);
    record(value.originalCommit, ['revision', 'createdAt']); integer(value.originalCommit.revision); integer(value.originalCommit.createdAt);
    const dispatch = value.dispatch;
    record(dispatch, ['operationId', 'source', 'occurrenceIndex', 'originOccurrence', 'created', 'actor', 'kind'], dispatch.kind === 'generation' ? ['correlation'] : []);
    string(dispatch.operationId); same(dispatch.source, value.originalIntent.target);
    same(dispatch.occurrenceIndex, value.originalIntent.occurrenceIndex);
    if (integer(dispatch.created) > value.originalCommit.createdAt) return refuse('actual original dispatch chronology required.');
    string(dispatch.actor); if (dispatch.originOccurrence !== null) string(dispatch.originOccurrence);
    if (dispatch.kind === 'generation') {
      if (value.declaration.delivery.kind !== 'generation') return refuse('original generation declaration required.');
      record(dispatch.correlation, ['requestSource', 'requestRevision', 'requestBinding', 'requestFrom', 'requestApp', 'requestOwner']);
      for (const part of Object.values(dispatch.correlation)) string(part);
      same(dispatch.correlation.requestSource, value.declaration.delivery.request.source);
      same(dispatch.correlation.requestRevision, value.declaration.delivery.request.revision);
      same(dispatch.correlation.requestBinding, value.declaration.binding); same(dispatch.correlation.requestFrom, value.declaration.from);
    } else if (dispatch.kind !== 'capability' || value.declaration.delivery.kind === 'generation') return refuse('actual completion dispatch variant required.');
    record(value.terminal, ['revision', 'status', 'error']); integer(value.terminal.revision);
    if (value.terminal.revision < value.originalCommit.revision || value.revision < value.terminal.revision) return refuse('original terminal/source chronology required.');
    if (!['succeeded', 'failed', 'skipped'].includes(value.terminal.status)) return refuse('actual terminal phase required.');
    if (value.terminal.error !== null) {
      record(value.terminal.error, ['code', 'message']); string(value.terminal.error.code); string(value.terminal.error.message);
    }
    if ((value.terminal.status === 'failed') !== (value.terminal.error !== null)) return refuse('terminal status/error correspondence required.');
    bounds(value.bounds); routes(bound, value.routes);
  } else return refuse('actual original opaque payload origin required.');
}

/** Root independently checks the header slot/scope and physical receiving facts. */
export function validateOpaqueFileOrigin(bound: BoundOpaqueDeclarations, binding: FrameworkFilePayloadOrigin): void {
  owner(bound);
  const detached = closedJSON(binding) as FrameworkFilePayloadOrigin;
  if (detached.declarationSetId !== bound.declarationSet.id) return refuse('selected historical declaration set required.');
  same(detached.inventory, bound.declarationSet.inventory);
  origin(bound, detached.origin);
  if (detached.origin.kind === 'standard-completion' && detached.origin.dispatch.kind === 'generation') {
    same(detached.origin.dispatch.correlation.requestApp, detached.scope.app);
    same(detached.origin.dispatch.correlation.requestOwner, detached.scope.owner);
  }
}
