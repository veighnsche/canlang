/** Saved scenario disclosure. Compiler supplies the complete checked return
 * closure; the native host reports only actually evaluated private bindings.
 * Capture is available only during invoke, never from a request envelope.
 * This version supports scalar Values profiles, declared scalar fields and
 * explicitly checked admitted intrinsics (operation id/primitive input/original ref version).
 * Nominal/model/container/File/Delivery, query influence and absent-reference
 * claims require their defining joins. Empty field observations prove none of
 * those facts. Every site is scoped by its checked source return/digest/module.
 */
import type { ArtifactModel, CanonicalInputDef, CanTypeId, ModelName, ProjectedRecord,
  Receipt, ScenarioReceiptAssociation, ScenarioReceiptIntrinsicDependency, ScenarioResultDisclosurePlan, StoragePort, StoredRow } from '@canlang/contracts';
import { decodeValue, encodeValue, parseTypeId, printTypeId, validateValue, type NormalizedSchema } from '@canlang/values';
import { StateError } from '../errors.js';
import { deepFreeze, getDataPath } from '../internal/own-data.js';
import type { PolicyTable } from '../policy/grants.js';
import { evaluateBy, type MembershipReader } from '../policy/roles.js';
import { projectSavedRecordForViewer } from '../query/engine.js';
import type { ResolvedIdentity } from '@canlang/contracts';
import type { AdmittedCall } from './admission.js';
import { assertScenarioReceiptExecution, type ExecutionEffects } from './invoke.js';
import { beginOwnerMutation, type OwnerMutationInput, type OwnerMutationReadView,
  type OwnerMutationSession, type MutationWritesResult } from '../mutation/pipeline.js';
import type { GeneratedOperationDef, OperationRegistry } from './registry.js';
import { stableStringify } from './replay.js';

const MAX_ITEMS = 200;
const invalid = (message: string): never => { throw new StateError('validation', `Saved scenario: ${message}`); };

/** Own JSON data only: no accessors, prototypes, aliasing, cycles or unbounded trees. */
function dataCopy<T>(value: T): T {
  let nodes = 0;
  const seen = new Set<object>();
  const copy = (part: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 32) return invalid('data exceeds its finite budget.');
    if (part === null || typeof part === 'string' || typeof part === 'boolean') return part;
    if (typeof part === 'number' && Number.isFinite(part)) return part;
    if (typeof part !== 'object' || part === null || seen.has(part) ||
        (!Array.isArray(part) && ![Object.prototype, null].includes(Object.getPrototypeOf(part)))) {
      return invalid('own JSON data is required.');
    }
    seen.add(part);
    const out: unknown[] | Record<string, unknown> = Array.isArray(part) ? [] : {};
    for (const key of Reflect.ownKeys(part)) {
      if (Array.isArray(part) && key === 'length') continue;
      const member = Object.getOwnPropertyDescriptor(part, key);
      if (typeof key !== 'string' || member === undefined || !('value' in member) || !member.enumerable ||
          (Array.isArray(part) && !/^(0|[1-9]\d*)$/.test(key))) return invalid('own enumerable data is required.');
      Object.defineProperty(out, key, { value: copy(member.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    if (Array.isArray(part) && Object.keys(out).length !== part.length) return invalid('sparse arrays are unsupported.');
    seen.delete(part); return out;
  };
  return copy(value, 0) as T;
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return invalid('closed shape required.');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : invalid('nonempty identity required.');
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) && value.length <= MAX_ITEMS ? value : invalid('bounded array required.');
}
function paths(value: unknown): string[] {
  const fields = list(value).map(text);
  if (new Set(fields).size !== fields.length || fields.some(field => field.split('.').some(part => part === ''))) {
    return invalid('unique field paths required.');
  }
  return fields;
}
function scalarType(type: unknown): CanTypeId {
  if (typeof type !== 'string') return invalid('declared scalar type required.');
  if (type === 'void') return type as CanTypeId;
  try {
    const parsed = parseTypeId(type);
    if (printTypeId(parsed) !== type || parsed.requiredArray ||
        !(parsed.base.kind === 'enum' || /^(int|datetime|text|bool|decimal|money|date|duration|user)(\[\])?\??$/.test(type))) {
      return invalid(`unsupported disclosure type ${JSON.stringify(type)}; defining composite/lifetime join required.`);
    }
  } catch (error) {
    if (error instanceof StateError) throw error;
    return invalid('invalid scalar type.');
  }
  return type as CanTypeId;
}
function scalarWire(type: CanTypeId, value: unknown): void {
  if (type === 'void') { if (value !== null) invalid('void receipt result must be null.'); return; }
  try { decodeValue(type, value); } catch { invalid(`invalid saved ${type} wire value.`); }
}
function origin(value: unknown): void {
  const source = object(value, ['path', 'sha256', 'module']);
  text(source['path']); text(source['module']);
  if (typeof source['sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(source['sha256'])) return invalid('exact source digest required.');
}

/** Loader checker; callers cannot turn this data into a bound generated def. */
export function checkScenarioResultDisclosurePlan(value: unknown): ScenarioResultDisclosurePlan {
  const plan = object(dataCopy(value), ['version', 'source', 'returns']);
  if (plan['version'] !== 1) return invalid('unsupported dependency plan version.');
  origin(plan['source']);
  const returns = list(plan['returns']);
  if (returns.length === 0) return invalid('at least one checked return path required.');
  const ids = new Set<string>(); const dependencies = new Map<string, string>();
  for (const entry of returns) {
    const returned = object(entry, ['id', 'source', 'dependencies', 'influences',
      ...(typeof entry === 'object' && entry !== null && Object.hasOwn(entry, 'intrinsics') ? ['intrinsics'] : [])]); const id = text(returned['id']);
    origin(returned['source']);
    if (ids.has(id)) return invalid('duplicate return identity.'); ids.add(id);
    const influences = list(returned['influences']);
    for (const item of influences) {
      const influence = object(item, ['id', 'kind']); text(influence['id']);
      if (!['query-existence', 'query-cardinality', 'query-membership', 'query-order', 'absent-reference'].includes(text(influence['kind']))) {
        return invalid('unknown return influence.');
      }
    }
    if (influences.length !== 0) return invalid('query/absence return influence is unsupported; defining provenance/current-authority join required.');
    const local = new Set<string>();
    for (const item of list(returned['dependencies'])) {
      const dependency = object(item, ['id', 'source', 'role', 'model', 'field', 'type']);
      origin(dependency['source']);
      const depId = text(dependency['id']); text(dependency['model']);
      if (dependency['role'] !== 'data' && dependency['role'] !== 'control') return invalid('unknown dependency role.');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text(dependency['field']))) return invalid('only declared direct scalar fields are supported.');
      scalarType(dependency['type']);
      const encoded = stableStringify(dependency);
      if (local.has(depId) || (dependencies.has(depId) && dependencies.get(depId) !== encoded)) return invalid('dependency identity drifts.');
      local.add(depId); dependencies.set(depId, encoded);
    }
    for (const item of list(Object.hasOwn(returned, 'intrinsics') ? returned['intrinsics'] : [])) {
      const kind = (item as Record<string, unknown>)?.['kind'];
      const dependency = object(item, ['id', 'source', 'role', 'type', 'kind',
        ...(kind === 'admitted-reference-version' ? ['parameter', 'model'] : kind === 'admitted-input' ? ['parameter'] : [])]);
      origin(dependency['source']); const depId = text(dependency['id']);
      if (dependency['role'] !== 'data' && dependency['role'] !== 'control') return invalid('unknown intrinsic role.');
      if (kind === 'operation-id') {
        if (dependency['type'] !== 'text') return invalid('operation identity requires text wire.');
      } else if (kind === 'admitted-input') {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text(dependency['parameter'])) || !primitiveInputType(dependency['type'])) {
          return invalid('admitted input requires a direct parameter and supported primitive type.');
        }
      } else if (kind === 'admitted-reference-version') {
        text(dependency['model']);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text(dependency['parameter'])) || dependency['type'] !== 'int') {
          return invalid('original reference version requires a direct parameter and int wire.');
        }
      } else return invalid('unsupported intrinsic dependency.');
      const encoded = stableStringify(dependency);
      if (local.has(depId) || (dependencies.has(depId) && dependencies.get(depId) !== encoded)) return invalid('dependency identity drifts.');
      local.add(depId); dependencies.set(depId, encoded);
    }
  }
  if (dependencies.size > MAX_ITEMS) return invalid('dependency closure exceeds its finite budget.');
  return deepFreeze(plan as unknown as ScenarioResultDisclosurePlan);
}

interface ModelInventory {
  readonly fields: ReadonlyMap<string, CanTypeId | null>;
  readonly secrets: readonly string[];
  readonly withheld: readonly string[];
}
interface BoundPlan {
  readonly plan: ScenarioResultDisclosurePlan; readonly type: CanTypeId; readonly models: ReadonlyMap<ModelName, ModelInventory>;
  readonly inputs: readonly CanonicalInputDef[];
  readonly arrays: GeneratedOperationDef['inputArrays']; readonly nullableRefs: NonNullable<GeneratedOperationDef['inputNullableRefs']>;
  readonly valueSchema: NormalizedSchema | undefined; readonly parameterStyle: boolean;
}
const boundPlans = new WeakMap<GeneratedOperationDef, BoundPlan>();

/** Registry-owned registration after exact artifact source/callable checking. */
export function bindScenarioReceiptPlan(def: GeneratedOperationDef, models: readonly ArtifactModel[],
  defaults: { readonly parameterStyle: boolean; readonly valueSchema?: NormalizedSchema }): void {
  const claim = def.descriptor.result?.disclosure;
  if (claim === undefined) return;
  if (def.kind !== 'scenario') return invalid('dependency plans belong to mutation scenarios.');
  const plan = checkScenarioResultDisclosurePlan(claim); const type = scalarType(def.descriptor.result!.type);
  const inventory = new Map<ModelName, ModelInventory>();
  for (const model of models) {
    const fields = new Map<string, CanTypeId | null>(); const secrets: string[] = []; const withheld: string[] = [];
    for (const field of model.fields) {
      const tag = field.field;
      const base = ({ string: 'text', integer: 'int', decimal: 'decimal', money: 'money', datetime: 'datetime',
        boolean: 'bool', date: 'date', duration: 'duration', user: 'user' } as Record<string, string>)[tag.kind];
      let fieldType: CanTypeId | null = null;
      if (tag.kind === 'secret') secrets.push(field.name);
      if (base !== undefined || tag.kind === 'enum') {
        const canonical = field.valueType ?? `${base ?? `enum(${tag.kind === 'enum' ? tag.values.join(',') : ''})`}${field.array === undefined ? '' : '[]'}${field.nullable === true ? '?' : ''}`;
        try { fieldType = scalarType(canonical); } catch { /* Explicitly withheld unsupported field profile. */ }
      }
      if (fieldType === null) withheld.push(field.name);
      fields.set(field.name, fieldType);
    }
    inventory.set(model.name as ModelName, { fields, secrets: Object.freeze(secrets), withheld: Object.freeze(withheld) });
  }
  for (const returned of plan.returns) for (const dep of returned.dependencies) {
    if (inventory.get(dep.model)?.fields.get(dep.field) !== dep.type) return invalid('dependency disagrees with declared model field/type inventory.');
  }
  for (const returned of plan.returns) for (const dep of returned.intrinsics ?? []) {
    if (dep.kind === 'admitted-reference-version' && (!inventory.has(dep.model) || !versionedReferenceInput(def, dep))) {
      return invalid('original version requires its declared required singular versioned reference input.');
    }
    if (dep.kind === 'admitted-input' && !primitiveInput(def, dep)) return invalid('intrinsic input disagrees with its required singular primitive declaration.');
  }
  boundPlans.set(def, { plan, type, models: inventory, inputs: deepFreeze(dataCopy(def.descriptor.inputs)),
    arrays: deepFreeze(dataCopy(def.inputArrays)), nullableRefs: deepFreeze(dataCopy(def.inputNullableRefs ?? {})),
    valueSchema: defaults.valueSchema, parameterStyle: defaults.parameterStyle });
}

function primitiveInputType(type: unknown): type is CanTypeId {
  return typeof type === 'string' && /^(text|bool|int|date|datetime|decimal|money|duration|user)$/.test(type);
}

function primitiveInput(def: GeneratedOperationDef, dependency: ScenarioReceiptIntrinsicDependency): boolean {
  if (dependency.kind !== 'admitted-input') return false;
  const input = def.descriptor.inputs.find(field => field.name === dependency.parameter);
  if (input === undefined || input.kind === 'ref' || input.kind === 'nominal' || input.kind === 'delivery' ||
      !input.required || input.default !== undefined || input.computedDefault === true ||
      def.inputArrays[dependency.parameter] !== undefined) return false;
  const types: Partial<Record<typeof input.kind, string>> = { string: 'text', boolean: 'bool', integer: 'int',
    datetime: 'datetime', decimal: 'decimal', money: 'money', duration: 'duration', user: 'user' };
  // A collapsed legacy string tag proves neither text nor nullability.
  // Artifact intake derives unambiguous builtin associations, while canonical
  // producers must supply the exact owning checked type for this new claim.
  const base = types[input.kind], type = input.valueType;
  return base !== undefined && primitiveInputType(type) && type === dependency.type &&
    (type === base || input.kind === 'string' && type === 'date');
}

function versionedReferenceInput(def: GeneratedOperationDef, dependency: ScenarioReceiptIntrinsicDependency): boolean {
  if (dependency.kind !== 'admitted-reference-version') return false;
  const input = def.descriptor.inputs.find(field => field.name === dependency.parameter);
  return input?.kind === 'ref' && input.model === dependency.model && input.required && input.versioned &&
    def.inputArrays[dependency.parameter] === undefined && def.inputNullableRefs?.[dependency.parameter] !== true;
}

type IntrinsicObservation = NonNullable<ScenarioReceiptAssociation['intrinsics']>[number];

interface Capture {
  readonly bound: BoundPlan;
  returnId: string | null;
  poisoned: boolean;
  pending: number;
  readonly observations: Array<ScenarioReceiptAssociation['observations'][number] & {
    readonly stored: boolean; readonly ownerSession: boolean;
  }>;
  readonly intrinsics: IntrinsicObservation[];
}
const captures = new WeakMap<AdmittedCall, Capture>();
function capture(call: AdmittedCall, store: StoragePort): Capture {
  try {
    assertScenarioReceiptExecution(call, store);
    const bound = boundPlans.get(call.def as GeneratedOperationDef);
    if (bound === undefined) return invalid('no loader-verified source dependency plan.');
    let value = captures.get(call);
    if (value === undefined) { value = { bound, returnId: null, poisoned: false, pending: 0, observations: [], intrinsics: [] }; captures.set(call, value); }
    if (value.poisoned) return invalid('capture is poisoned.');
    return value;
  } catch (error) {
    const state = captures.get(call); if (state !== undefined) state.poisoned = true;
    throw error;
  }
}

export type ScenarioReceiptMutationInput = Omit<OwnerMutationInput, 'context' | 'store' | 'trigger' | 'gateArchivedTargets'>;
interface ReceiptOwnerSession {
  readonly call: AdmittedCall;
  readonly store: StoragePort;
  readonly capture: Capture;
  stage: number;
  busy: boolean;
  closed: boolean;
  finalized: MutationWritesResult | null;
  readonly inputDefaults: Record<string, unknown>;
  readonly computedDefaults: readonly CanonicalInputDef[];
  computedIndex: number;
}
const ownerSessions = new WeakMap<AdmittedCall, ReceiptOwnerSession>();
const ownerRows = new WeakMap<StoredRow, {
  readonly session: ReceiptOwnerSession; readonly stage: number; readonly model: ModelName;
}>();

function inputDefaultWire(bound: BoundPlan, field: CanonicalInputDef, wire: unknown): unknown {
  const saved = dataCopy(wire);
  if (field.kind === 'delivery' || field.kind === 'ref') return invalid('value default requires its owning declared type.');
  if (field.kind === 'enum' && field.valueType === undefined) {
    if (typeof saved !== 'string' || !field.enumValues?.includes(saved)) return invalid('computed enum default is outside its declared cases.');
    return saved;
  }
  if (field.valueType === undefined) return invalid('input default lacks its owning value type.');
  try {
    const value = bound.valueSchema === undefined ? decodeValue(field.valueType, saved)
      : validateValue(bound.valueSchema, field.valueType, saved, 'create');
    return dataCopy(encodeValue(field.valueType, value));
  } catch { return invalid('input default disagrees with its owning Values type/schema.'); }
}

function inputDefaultSlots(call: AdmittedCall, bound: BoundPlan): {
  inputDefaults: Record<string, unknown>; computedDefaults: readonly CanonicalInputDef[];
} {
  const inputDefaults: Record<string, unknown> = {};
  const computedDefaults: CanonicalInputDef[] = [];
  if (bound.parameterStyle) for (const field of bound.inputs) {
    // Default-eligible omissions survive admission. Defaultless ordinary
    // arrays filled by admission never become native default contributions.
    if (Object.hasOwn(call.inputs, field.name) || field.kind === 'delivery') continue;
    if (field.computedDefault === true) computedDefaults.push(field);
    else if (field.kind !== 'ref' && field.valueType !== undefined) {
      if (field.default?.kind === 'literal') Object.defineProperty(inputDefaults, field.name, {
        value: inputDefaultWire(bound, field, field.default.value), enumerable: true });
      else if (field.valueType.endsWith('?')) Object.defineProperty(inputDefaults, field.name, { value: null, enumerable: true });
    }
  }
  return { inputDefaults, computedDefaults: Object.freeze(computedDefaults) };
}

/** Called only by the actual verified generated default observer. State owns
 * omitted slots/type/order/lifetime, while Dev owns expression execution and
 * private native reference identity. A bulk map or type/module claim cannot
 * contribute defaults. This API does not itself attest computed arithmetic.
 */
export function observeScenarioInputComputedDefault(call: AdmittedCall, store: StoragePort,
  report: { readonly name: string; readonly wire: unknown }): void {
  const owner = ownerSessions.get(call);
  try {
    capture(call, store);
    if (owner === undefined || owner.store !== store) return invalid('computed default requires its actual admitted owner session.');
    ownerHealthy(owner);
    if (owner.busy || owner.capture.pending !== 0) return invalid('computed default cannot overlap an owner operation.');
    const observed = object(dataCopy(report), ['name', 'wire']);
    const field = owner.computedDefaults[owner.computedIndex];
    if (field === undefined || observed['name'] !== field.name) return invalid('computed defaults require every omitted slot exactly once in declaration order.');
    let wire: unknown;
    if (field.kind === 'ref') {
      if (Object.hasOwn(owner.capture.bound.arrays, field.name) || Object.hasOwn(owner.capture.bound.nullableRefs, field.name)) {
        return invalid('computed reference requires a singular nonnullable owning slot.');
      }
      const candidate = object(observed['wire'], ['id', 'version']);
      const index = owner.capture.bound.inputs.indexOf(field);
      const seed = call.recordRefs.find(ref => {
        const seedIndex = owner.capture.bound.inputs.findIndex(input => input.name === ref.param);
        const input = owner.capture.bound.inputs[seedIndex];
        return seedIndex >= 0 && seedIndex < index && input?.kind === 'ref' && input.model === field.model &&
          ref.model === field.model && !Object.hasOwn(owner.capture.bound.arrays, input.name) &&
          !Object.hasOwn(owner.capture.bound.nullableRefs, input.name) && candidate['id'] === ref.row.id &&
          candidate['version'] === String(ref.row.version);
      });
      if (seed === undefined) return invalid('computed reference requires an earlier admitted singular nonnullable same-model seed.');
      try { wire = dataCopy(encodeValue(field.model, decodeValue(field.model, candidate))); }
      catch { return invalid('invalid computed reference wire.'); }
    } else wire = inputDefaultWire(owner.capture.bound, field, observed['wire']);
    Object.defineProperty(owner.inputDefaults, field.name, { value: deepFreeze(wire), enumerable: true });
    owner.computedIndex += 1;
  } catch (error) {
    if (owner !== undefined) owner.capture.poisoned = true;
    const state = captures.get(call); if (state !== undefined) state.poisoned = true;
    throw error;
  }
}

function finalizedDefaults(owner: ReceiptOwnerSession, modelDefaults: Record<string, unknown>): Record<string, unknown> {
  if (owner.computedIndex !== owner.computedDefaults.length) return invalid('generated handler omitted a required computed-default contribution.');
  const union: Record<string, unknown> = dataCopy(modelDefaults);
  for (const [name, value] of Object.entries(owner.inputDefaults)) {
    if (Object.hasOwn(union, name)) return invalid('input and model default identities collide.');
    Object.defineProperty(union, name, { value: dataCopy(value), enumerable: true });
  }
  return union;
}

function ownerHealthy(owner: ReceiptOwnerSession): void {
  assertScenarioReceiptExecution(owner.call, owner.store);
  if (owner.closed || owner.finalized !== null || owner.capture.poisoned) return invalid('owner session is closed, finalized or poisoned.');
}
async function ownerOperation<T>(owner: ReceiptOwnerSession, execute: () => Promise<T>): Promise<T> {
  let acquired = false;
  try {
    ownerHealthy(owner);
    if (owner.busy || owner.capture.pending !== 0) return invalid('concurrent owner session operations are forbidden.');
    owner.busy = true; acquired = true;
    const result = await execute();
    ownerHealthy(owner);
    const revision = await owner.store.readRevision();
    ownerHealthy(owner);
    if (revision !== owner.call.revision) throw new StateError('conflict', 'Scenario owner session moved beyond its admitted revision.');
    return result;
  } catch (error) { owner.capture.poisoned = true; throw error; }
  finally { if (acquired) owner.busy = false; }
}

/** Positive producer for one real admitted scenario execution. The physical
 * store, context and trigger come from Invoke; no overlay or proof token is
 * accepted. Only this session's current-stage immutable reads can establish
 * intermediate provenance. Its actual finalized effects must reach Invoke.
 */
export async function beginScenarioReceiptMutation(call: AdmittedCall, store: StoragePort,
  input: ScenarioReceiptMutationInput): Promise<OwnerMutationSession> {
  const state = capture(call, store);
  try {
    if (ownerSessions.has(call) || state.pending !== 0 || state.observations.length !== 0 || state.intrinsics.length !== 0 || state.returnId !== null) return invalid('one owner session must begin before scenario observations/return completion.');
    if (typeof input !== 'object' || input === null || Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
        Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['table', 'bounds', 'policies', 'encodeField'].includes(key) ||
          !('value' in Object.getOwnPropertyDescriptor(input, key)!))) return invalid('owner session accepts only its defining mutation options.');
    if (typeof input.bounds !== 'object' || input.bounds === null || Array.isArray(input.bounds)) return invalid('owner session requires finite bounds.');
    const bounds = object(dataCopy(input.bounds), ['maxWork', 'maxRows']);
    if (!Number.isSafeInteger(bounds['maxRows']) || (bounds['maxRows'] as number) < 1 ||
        (bounds['maxRows'] as number) > MAX_ITEMS) return invalid('owner row bound exceeds the saved disclosure budget.');
    const owner: ReceiptOwnerSession = { call, store, capture: state, stage: 0, busy: false, closed: false, finalized: null,
      ...inputDefaultSlots(call, state.bound), computedIndex: 0 };
    ownerSessions.set(call, owner);
    const session = await ownerOperation(owner, () => beginOwnerMutation({ ...input, context: call.context, store,
      trigger: { revision: call.revision, owner: call.checkpoint?.owner ?? call.context.team?.teamId ?? call.context.app },
      gateArchivedTargets: true }));
    const issue = (model: ModelName, row: StoredRow | null): StoredRow | null => {
      if (row !== null) ownerRows.set(row, { session: owner, stage: owner.stage, model });
      return row;
    };
    const view = (source: OwnerMutationReadView, current: boolean): OwnerMutationReadView => Object.freeze<OwnerMutationReadView>({
      get: (model, id) => ownerOperation(owner, async () => {
        const row = await source.get(model, id);
        return current ? issue(model, row) : row;
      }),
      // Query influence remains unsupported by disclosure v1. Individual
      // current rows still come from the real bounded owner read.
      query: spec => ownerOperation(owner, async () => {
        const selection = deepFreeze(dataCopy(spec));
        const rows = await source.query(selection);
        if (current) for (const row of rows) issue(selection.model, row);
        return rows;
      }),
    });
    const final = view(session.views.final, true);
    const views = Object.freeze({ context: session.views.context, maxRows: session.views.maxRows,
      entry: view(session.views.entry, false), final,
      consumeWork: (amount?: number) => {
        try {
          ownerHealthy(owner);
          if (owner.busy || state.pending !== 0) return invalid('concurrent owner session operations are forbidden.');
          session.views.consumeWork(amount);
        } catch (error) { state.poisoned = true; throw error; }
      },
    });
    return Object.freeze<OwnerMutationSession>({ views, read: final.get,
      stage: (writes, options) => ownerOperation(owner, async () => {
        if (options?.cause !== 'scenario') return invalid('receipt owner staging requires the actual scenario cause.');
        await session.stage(writes, options);
        owner.stage += 1;
      }),
      finalize: async () => {
        try {
          if (owner.computedIndex !== owner.computedDefaults.length) return invalid('generated handler omitted a required computed-default contribution.');
          const result = await ownerOperation(owner, () => session.finalize());
          if (result.writes.length > MAX_ITEMS) return invalid('changed snapshot budget exceeded.');
          // The actual seal must not alias mutable output from the ordinary
          // model pipeline; both consumer and retention receive this copy.
          owner.finalized = deepFreeze(dataCopy({ ...result, resolvedDefaults: finalizedDefaults(owner, result.resolvedDefaults) }));
          return owner.finalized;
        } catch (error) { state.poisoned = true; throw error; }
      },
    });
  } catch (error) { state.poisoned = true; throw error; }
}

/** Invoke closes carriers even when the executor throws or returns early. */
export function closeScenarioReceiptExecution(call: AdmittedCall): void {
  const owner = ownerSessions.get(call);
  if (owner !== undefined) {
    owner.closed = true;
    if (owner.busy || owner.finalized === null) owner.capture.poisoned = true;
  }
  const state = captures.get(call);
  if (state !== undefined && state.pending !== 0) state.poisoned = true;
}

/** Snapshot the claimed scenario's own effects once while execution is live.
 * Receipt correspondence and the eventual commit consume this same immutable
 * carrier. Guard evaluators remain callbacks; their identity/name are captured
 * without evaluating accessors or retaining mutable effect arrays.
 */
export function snapshotScenarioReceiptEffects(call: AdmittedCall, effects: ExecutionEffects): ExecutionEffects {
  if (!boundPlans.has(call.def as GeneratedOperationDef)) return effects;
  const required = ['writes', 'history', 'outbox', 'schedules', 'uniqueClaims', 'uniqueReleases', 'resolvedDefaults', 'result'];
  const allowed = [...required, 'generatedCrud', 'guards', 'readings', 'fileAssignments'];
  const snapshot: Record<string, unknown> = {};
  if (typeof effects !== 'object' || effects === null || Array.isArray(effects) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(effects)) ||
      required.some(key => !Object.hasOwn(effects, key))) return invalid('own complete execution effects required.');
  for (const key of Reflect.ownKeys(effects)) {
    const member = Object.getOwnPropertyDescriptor(effects, key)!;
    if (typeof key !== 'string' || !allowed.includes(key) || !('value' in member) || !member.enumerable) {
      return invalid('execution effects require own enumerable data and cannot supply a scenario association.');
    }
    if (member.value === undefined && !required.includes(key) && key !== 'fileAssignments') continue;
    if (key === 'fileAssignments') {
      if (!Array.isArray(member.value) || member.value.length !== 0) return invalid('file assignments require the defining File/lifetime join.');
      snapshot[key] = dataCopy(member.value);
    } else if (key === 'guards') {
      const guards = list(member.value);
      if (Reflect.ownKeys(guards).length !== guards.length + 1) return invalid('own dense guard array required.');
      snapshot[key] = Array.from({ length: guards.length }, (_, index) => {
        const entry = Object.getOwnPropertyDescriptor(guards, String(index));
        if (entry === undefined || !('value' in entry) || !entry.enumerable) return invalid('guard array cannot contain accessors or holes.');
        const value: unknown = entry.value;
        if (typeof value !== 'object' || value === null || Array.isArray(value) ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
            Reflect.ownKeys(value).length !== 2 || !Object.hasOwn(value, 'name') || !Object.hasOwn(value, 'evaluate')) {
          return invalid('own closed guard carrier required.');
        }
        const name = Object.getOwnPropertyDescriptor(value, 'name')!, evaluate = Object.getOwnPropertyDescriptor(value, 'evaluate')!;
        if (!('value' in name) || !('value' in evaluate) || !name.enumerable || !evaluate.enumerable ||
            typeof evaluate.value !== 'function') return invalid('guard callbacks cannot be accessors.');
        return Object.freeze({ name: text(name.value), evaluate: evaluate.value as () => boolean | Promise<boolean> });
      });
    } else snapshot[key] = dataCopy(member.value);
  }
  return deepFreeze(snapshot) as unknown as ExecutionEffects;
}

/** Native host supplies its actual protected binding. For a receipt owner
 * session it must preserve the exact issued row, including its stage. Copies,
 * host overlays and final-row coincidence cannot establish intermediate proof.
 */
export async function observeScenarioReceiptDependency(call: AdmittedCall, store: StoragePort, input: {
  readonly dependencyId: string; readonly model: ModelName; readonly row: StoredRow; readonly field: string;
}): Promise<void> {
  let state: Capture;
  try { state = capture(call, store); }
  catch (error) {
    const carrier = typeof input === 'object' && input !== null ? Object.getOwnPropertyDescriptor(input, 'row') : undefined;
    if (carrier !== undefined && 'value' in carrier) {
      const issuing = ownerRows.get(carrier.value as StoredRow);
      if (issuing !== undefined) issuing.session.capture.poisoned = true;
    }
    throw error;
  }
  const owner = ownerSessions.get(call);
  let acquired = false;
  try {
    if (state.pending !== 0) return invalid('concurrent observations are forbidden.');
    if (state.returnId !== null) return invalid('observation cannot follow the selected return.');
    const observed = dataCopy(input);
    object(observed, ['dependencyId', 'model', 'row', 'field']);
    const dependency = state.bound.plan.returns.flatMap(entry => entry.dependencies).find(dep => dep.id === observed.dependencyId);
    if (dependency === undefined || dependency.model !== observed.model || dependency.field !== observed.field) return invalid('native observation disagrees with its checked dependency.');
    if (state.observations.length + state.intrinsics.length >= MAX_ITEMS) return invalid('observation budget exceeded.');
    const row = checkedRow(observed.row); scalarWire(dependency.type, getDataPath(row.data, dependency.field));
    if (row.archivedAt !== null) return invalid('cannot observe an archived row.');
    if (owner !== undefined) {
      ownerHealthy(owner);
      const issued = ownerRows.get(input.row);
      if (owner.busy || issued?.session !== owner || issued.stage !== owner.stage || issued.model !== observed.model) {
        return invalid('observation requires the actual current-stage owner row.');
      }
      owner.busy = true;
    }
    state.pending += 1; acquired = true;
    const current = await store.load(observed.model, row.id);
    capture(call, store);
    const revision = await store.readRevision();
    capture(call, store);
    if (state.returnId !== null) return invalid('observation must complete before return selection.');
    if (revision !== call.revision) throw new StateError('conflict', 'Scenario observation moved beyond its admitted revision.');
    const secrets = state.bound.models.get(observed.model)!.secrets;
    if (secrets.length > MAX_ITEMS) return invalid('original secrecy inventory exceeds its finite budget.');
    state.observations.push({ dependencyId: dependency.id, model: observed.model, row,
      secretFields: [...secrets],
      stored: current !== null && stableStringify(current) === stableStringify(row), ownerSession: owner !== undefined });
  } catch (error) { state.poisoned = true; throw error; }
  finally { if (acquired) { state.pending -= 1; if (owner !== undefined) owner.busy = false; } }
}

export type ScenarioReceiptIntrinsicInput = {
  readonly dependencyId: string; readonly kind: 'operation-id'; readonly wire: string;
} | {
  readonly dependencyId: string; readonly kind: 'admitted-input'; readonly wire: unknown;
} | {
  readonly dependencyId: string; readonly kind: 'admitted-reference-version'; readonly wire: string;
  /** Exact original admitted slot, selected only after the host checks its
   * private native binding. Copies and current-stage rows are not this slot. */
  readonly reference: AdmittedCall['recordRefs'][number];
};

/** Host reports an actually evaluated checked intrinsic site. State derives
 * identity/version from its protected admission and checks the host's encoded
 * value. This does not attest native evaluation: the verified generated host
 * must check its actual operation/ref binding before calling this producer.
 */
export async function observeScenarioReceiptIntrinsic(call: AdmittedCall, store: StoragePort,
  input: ScenarioReceiptIntrinsicInput): Promise<void> {
  const state = capture(call, store); const owner = ownerSessions.get(call);
  let acquired = false;
  try {
    if (state.pending !== 0 || owner?.busy === true) return invalid('concurrent observations are forbidden.');
    if (state.returnId !== null) return invalid('observation cannot follow the selected return.');
    if (owner !== undefined) ownerHealthy(owner);
    const observed = dataCopy(input);
    const kind = typeof observed === 'object' && observed !== null ? observed.kind : undefined;
    object(observed, ['dependencyId', 'kind', 'wire',
      ...(kind === 'admitted-reference-version' ? ['reference'] : [])]);
    const dependency = state.bound.plan.returns.flatMap(entry => entry.intrinsics ?? [])
      .find(dep => dep.id === observed.dependencyId);
    if (dependency === undefined || dependency.kind !== observed.kind) return invalid('native intrinsic disagrees with its checked dependency.');
    if (state.observations.length + state.intrinsics.length >= MAX_ITEMS) return invalid('observation budget exceeded.');
    let observation: IntrinsicObservation;
    if (dependency.kind === 'operation-id') {
      if (observed.wire !== call.context.operationId) return invalid('intrinsic identity differs from the admitted operation.');
      observation = { dependencyId: dependency.id, kind: dependency.kind, wire: call.context.operationId };
    } else if (dependency.kind === 'admitted-input') {
      const member = Object.getOwnPropertyDescriptor(call.inputs, dependency.parameter);
      if (member === undefined || !('value' in member) || !member.enumerable) return invalid('intrinsic input must be an own supplied admitted slot.');
      const wire = dataCopy(member.value); scalarWire(dependency.type, wire);
      if (stableStringify(wire) !== stableStringify(observed.wire) ||
          stableStringify(encodeValue(dependency.type, decodeValue(dependency.type, wire))) !== stableStringify(wire)) {
        return invalid('intrinsic input differs from its original canonical admitted wire.');
      }
      observation = { dependencyId: dependency.id, kind: dependency.kind, wire };
    } else {
      const member = Object.getOwnPropertyDescriptor(input, 'reference');
      const reference = call.recordRefs.find(ref => ref.param === dependency.parameter);
      if (member === undefined || !('value' in member) || reference === undefined || member.value !== reference ||
          reference.model !== dependency.model || reference.id !== reference.row.id ||
          reference.expectedVersion !== reference.row.version || observed.wire !== String(reference.row.version)) {
        return invalid('intrinsic version requires its exact original admitted reference and wire.');
      }
      const row = checkedRow(dataCopy(reference.row));
      if (row.archivedAt !== null) return invalid('cannot observe an archived reference.');
      const secrets = state.bound.models.get(reference.model)!.secrets;
      if (secrets.length > MAX_ITEMS) return invalid('original secrecy inventory exceeds its finite budget.');
      observation = { dependencyId: dependency.id, kind: dependency.kind, wire: String(row.version),
        model: reference.model, row, secretFields: [...secrets] };
    }
    if (owner !== undefined) owner.busy = true;
    state.pending += 1; acquired = true;
    if (observation.kind === 'admitted-reference-version') {
      const current = await store.load(observation.model, observation.row.id);
      capture(call, store);
      if (current === null || stableStringify(dataCopy(current)) !== stableStringify(observation.row)) {
        return invalid('original admitted reference moved before intrinsic capture.');
      }
    }
    const revision = await store.readRevision(); capture(call, store);
    if (revision !== call.revision) throw new StateError('conflict', 'Scenario intrinsic moved beyond its admitted revision.');
    scalarWire(dependency.type, observation.wire);
    state.intrinsics.push(observation);
  } catch (error) { state.poisoned = true; throw error; }
  finally { if (acquired) { state.pending -= 1; if (owner !== undefined) owner.busy = false; } }
}

/** The emitted selected return path determines required reads; unrelated private
 * decision-only reads do not become dependencies of literal/input results.
 */
export function selectScenarioReceiptReturn(call: AdmittedCall, store: StoragePort, returnId: string): void {
  const state = capture(call, store);
  try {
    if (state.pending !== 0 || ownerSessions.get(call)?.busy === true) { state.poisoned = true; return invalid('return selection cannot precede pending owner reads/observations.'); }
    const returned = state.bound.plan.returns.find(entry => entry.id === returnId);
    if (state.returnId !== null || returned === undefined) return invalid('one actual checked return path required.');
    if (returned.dependencies.some(dep => !state.observations.some(entry => entry.dependencyId === dep.id)) ||
        returned.intrinsics?.some(dep => !state.intrinsics.some(entry => entry.dependencyId === dep.id))) {
      return invalid('required observations must complete before selecting the actual return.');
    }
    state.returnId = returnId;
  } catch (error) { state.poisoned = true; throw error; }
}

function checkedRow(value: unknown): StoredRow {
  const row = value as StoredRow;
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      typeof row.id !== 'string' || row.id === '' || !Number.isSafeInteger(row.version) || row.version < 1 ||
      !Number.isFinite(row.created) || !Number.isFinite(row.updated) || typeof row.createdBy !== 'string' || typeof row.updatedBy !== 'string' ||
      (row.archivedAt !== null && !Number.isFinite(row.archivedAt)) ||
      typeof row.data !== 'object' || row.data === null || Array.isArray(row.data) ||
      (row.parent !== undefined && row.parent !== null &&
        (typeof row.parent.model !== 'string' || typeof row.parent.id !== 'string'))) return invalid('invalid saved row snapshot.');
  return row;
}

/** Invoke alone calls this after execution; no executor-supplied association is accepted. */
export function retainScenarioReceipt(call: AdmittedCall, effects: ExecutionEffects): ScenarioReceiptAssociation | undefined {
  let state = captures.get(call); captures.delete(call);
  const owner = ownerSessions.get(call); ownerSessions.delete(call);
  if (owner !== undefined) {
    if (!owner.closed || owner.finalized === null || owner.capture.poisoned || owner.capture.pending !== 0) {
      return invalid('owner session must finalize successfully inside its actual execution.');
    }
    for (const key of ['writes', 'history', 'uniqueClaims', 'uniqueReleases', 'resolvedDefaults'] as const) {
      if (stableStringify(dataCopy(effects[key])) !== stableStringify(owner.finalized[key])) {
        return invalid(`executor ${key} differ from the actual finalized owner effects.`);
      }
    }
    // Duplicate schedule keys use last-operation-wins semantics. An extra
    // cancel/replacement on an owned key would override actual owner effects.
    const keys = new Set(owner.finalized.schedules.map(schedule => schedule.key));
    const owned = effects.schedules.filter(schedule => keys.has(schedule.key));
    if (stableStringify(owned) !== stableStringify(owner.finalized.schedules)) return invalid('executor omitted, changed or overrode an owned schedule.');
  }
  const { writes, result } = effects;
  const bound = boundPlans.get(call.def as GeneratedOperationDef);
  if (bound === undefined) return undefined;
  // One checked empty path permits the ordinary implicit void return. Its
  // success receipt carries no business result and still saves changed rows.
  if (bound.type === 'void' && bound.plan.returns.length === 1 && bound.plan.returns[0]!.dependencies.length === 0 &&
      (bound.plan.returns[0]!.intrinsics?.length ?? 0) === 0) {
    state ??= { bound, returnId: null, poisoned: false, pending: 0, observations: [], intrinsics: [] };
    state.returnId ??= bound.plan.returns[0]!.id;
  }
  if (state === undefined || state.returnId === null) return invalid('checked scenario omitted its actual return capture.');
  if (state.poisoned || state.pending !== 0) return invalid('capture is poisoned or unfinished.');
  scalarWire(bound.type, dataCopy(result));
  const returned = bound.plan.returns.find(entry => entry.id === state.returnId)!;
  const required = new Set(returned.dependencies.map(dep => dep.id));
  const observed = state.observations.filter(entry => required.has(entry.dependencyId));
  if (returned.dependencies.some(dep => !observed.some(entry => entry.dependencyId === dep.id))) return invalid('required return dependency was not evaluated/captured.');
  const intrinsicIds = new Set(returned.intrinsics?.map(dep => dep.id));
  const intrinsics = state.intrinsics.filter(entry => intrinsicIds.has(entry.dependencyId));
  if (returned.intrinsics?.some(dep => !intrinsics.some(entry => entry.dependencyId === dep.id))) return invalid('required intrinsic was not evaluated/captured.');
  if (writes.length > MAX_ITEMS) return invalid('changed snapshot budget exceeded.');
  const changed: ScenarioReceiptAssociation['changed'][number][] = [];
  const identities = new Set<string>();
  for (const write of writes) {
    const id = write.kind === 'insert' ? write.row.id : write.id; const key = `${write.model}/${id}`;
    if (identities.has(key)) return invalid('only final net writes can establish changed snapshots.'); identities.add(key);
    if (write.kind === 'remove') continue;
    const model = bound.models.get(write.model);
    if (model === undefined) return invalid('changed row has no defining model inventory.');
    if (model.fields.size > MAX_ITEMS) return invalid('original field inventory exceeds its finite budget.');
    const row = checkedRow(dataCopy(write.row));
    if (row.id !== id) return invalid('changed snapshot identity disagrees with its net write.');
    changed.push({ model: write.model, row, secretFields: [...model.secrets],
      withheldFields: [...new Set([...model.withheld, ...Object.keys(row.data).filter(field => !model.fields.has(field))])],
      fieldTypes: Object.fromEntries(model.fields) });
  }
  for (const entry of observed) if (!entry.stored && !entry.ownerSession && !changed.some(change => change.model === entry.model &&
      stableStringify(change.row) === stableStringify(entry.row))) {
    return invalid('provisional read is not the final committed own-row snapshot; owner-session join required.');
  }
  return deepFreeze(dataCopy({ kind: 'scenario-result/v1' as const, plan: bound.plan, resultType: bound.type,
    returnId: state.returnId, observations: observed.map(({ stored: _stored, ownerSession: _ownerSession, ...entry }) => entry),
    ...(returned.intrinsics === undefined ? {} : { intrinsics }), changed }));
}

/** Legacy receipts are unassociated; malformed recognized metadata refuses. */
export function readScenarioReceiptAssociation(receipt: Receipt): ScenarioReceiptAssociation | null {
  receipt = dataCopy(receipt);
  if (!Object.hasOwn(receipt.outcome, 'scenario')) return null;
  if (receipt.outcome.status !== 'committed') return invalid('association requires a committed outcome.');
  const scenario = dataCopy(receipt.outcome.scenario);
  const value = object(scenario, ['kind', 'plan', 'resultType', 'returnId', 'observations', 'changed',
    ...(typeof scenario === 'object' && scenario !== null && Object.hasOwn(scenario, 'intrinsics') ? ['intrinsics'] : [])]);
  if (value['kind'] !== 'scenario-result/v1') return invalid('unknown association version.');
  const plan = checkScenarioResultDisclosurePlan(value['plan']); const resultType = scalarType(value['resultType']);
  const returned = plan.returns.find(entry => entry.id === value['returnId']);
  if (returned === undefined) return invalid('unknown selected return path.');
  scalarWire(resultType, receipt.outcome.result);
  const observations = list(value['observations']);
  for (const entry of observations) {
    const observation = object(entry, ['dependencyId', 'model', 'row', 'secretFields']);
    const dependency = returned.dependencies.find(dep => dep.id === observation['dependencyId']);
    if (dependency === undefined || dependency.model !== observation['model']) return invalid('foreign saved dependency.');
    const row = checkedRow(observation['row']); scalarWire(dependency.type, getDataPath(row.data, dependency.field)); paths(observation['secretFields']);
  }
  if (returned.dependencies.some(dep => !observations.some(entry => (entry as Record<string, unknown>)['dependencyId'] === dep.id))) return invalid('missing saved dependency.');
  const intrinsics = list(Object.hasOwn(value, 'intrinsics') ? value['intrinsics'] : []);
  if (observations.length + intrinsics.length > MAX_ITEMS) return invalid('observation budget exceeded.');
  for (const entry of intrinsics) {
    const kind = (entry as Record<string, unknown>)?.['kind'];
    const observation = object(entry, ['dependencyId', 'kind', 'wire',
      ...(kind === 'admitted-reference-version' ? ['model', 'row', 'secretFields'] : [])]);
    const dependency = returned.intrinsics?.find(dep => dep.id === observation['dependencyId']);
    if (dependency === undefined || dependency.kind !== kind) return invalid('foreign saved intrinsic.');
    scalarWire(dependency.type, observation['wire']);
    if (kind === 'operation-id') {
      if (observation['wire'] !== receipt.identity.operationId) return invalid('saved intrinsic identity differs from its receipt.');
    } else if (kind === 'admitted-input') {
      if (stableStringify(encodeValue(dependency.type, decodeValue(dependency.type, observation['wire']))) !==
          stableStringify(observation['wire'])) return invalid('invalid saved canonical input wire.');
    } else {
      const row = checkedRow(observation['row']); paths(observation['secretFields']);
      if (dependency.kind !== 'admitted-reference-version' || dependency.model !== observation['model'] ||
          row.archivedAt !== null || observation['wire'] !== String(row.version)) return invalid('invalid saved original reference version.');
    }
  }
  if (returned.intrinsics?.some(dep => !intrinsics.some(entry => (entry as Record<string, unknown>)['dependencyId'] === dep.id))) {
    return invalid('missing saved intrinsic.');
  }
  const changed = list(value['changed']); const identities = new Set<string>();
  for (const entry of changed) {
    const change = object(entry, ['model', 'row', 'secretFields', 'withheldFields', 'fieldTypes']); text(change['model']);
    const row = checkedRow(change['row']); paths(change['secretFields']); paths(change['withheldFields']);
    const types = change['fieldTypes'];
    if (typeof types !== 'object' || types === null || Array.isArray(types) || Object.keys(types).length > MAX_ITEMS) return invalid('bounded original field inventory required.');
    for (const type of Object.values(types)) if (type !== null) scalarType(type);
    const key = `${change['model']}/${row.id}`;
    if (identities.has(key) || !receipt.outcome.recordVersions.some(version => version.model === change['model'] &&
        version.id === row.id && version.version === row.version)) return invalid('changed snapshot disagrees with committed identities.');
    identities.add(key);
  }
  if (changed.length !== receipt.outcome.recordVersions.length) return invalid('incomplete committed changed snapshots.');
  return deepFreeze(value as unknown as ScenarioReceiptAssociation);
}

export interface ProjectScenarioReceiptInput {
  readonly receipt: Receipt; readonly registry: OperationRegistry; readonly policy: PolicyTable;
  readonly app: string; readonly identity: ResolvedIdentity; readonly store: StoragePort; readonly memberships: MembershipReader;
}

/** Current authority masks saved values, without re-execution or substitution.
 * Missing required influence access withholds result and changed records. This
 * version has no field-level influence map; readable changes cannot launder
 * private data/control. Unknown current inventory fails closed.
 */
export async function projectScenarioReceipt(input: ProjectScenarioReceiptInput): Promise<{
  readonly result: unknown; readonly records: readonly ProjectedRecord[];
}> {
  const receipt = dataCopy(input.receipt); const association = readScenarioReceiptAssociation(receipt);
  if (association === null) return invalid('no supported saved scenario association.');
  const actorUserId = input.identity.actor?.user_id ?? null, teamId = input.identity.team?.team_id ?? null;
  if (receipt.identity.app !== input.app || receipt.identity.owner !== (teamId ?? 'app') ||
      receipt.identity.principal !== (actorUserId ?? 'public')) throw new StateError('forbidden', 'Saved scenario scope does not match the caller.');
  const def = input.registry.get(receipt.identity.operation); const currentBound = boundPlans.get(def as GeneratedOperationDef);
  if (def === undefined || def.name !== receipt.identity.operation || currentBound === undefined) return invalid('current checked scenario inventory required.');
  const revision = await input.store.readRevision();
  const retained = await input.store.readReceipt(receipt.identity);
  if (retained === null || stableStringify(dataCopy(retained)) !== stableStringify(receipt)) return invalid('exact retained receipt required.');
  const authorityFacts = new Map<string, { teamId: string; userId: string; snapshot: string }>();
  let authorityDrift = false;
  const memberships: MembershipReader = {
    async findMembership(team, user) {
      const current = await input.memberships.findMembership(team, user);
      const key = stableStringify([team, user]), snapshot = stableStringify(dataCopy(current));
      const previous = authorityFacts.get(key);
      if (previous !== undefined && previous.snapshot !== snapshot) authorityDrift = true;
      if (previous === undefined) {
        if (authorityFacts.size >= MAX_ITEMS) return invalid('authority observation budget exceeded.');
        authorityFacts.set(key, { teamId: team, userId: user, snapshot });
      }
      return current;
    },
  };
  const membership = () => actorUserId !== null && teamId !== null
    ? memberships.findMembership(teamId, actorUserId) : Promise.resolve(null);
  const live = await membership(); const membershipSnapshot = stableStringify(dataCopy(live));
  const withheld = { result: null, records: [] } as const;
  const project = async (member: Awaited<ReturnType<typeof membership>>) => {
    const context = { actorUserId, teamId, membership: member, memberships };
    if (!await evaluateBy(def.by, context)) return withheld;
    const savedProjection = async (model: ModelName, saved: StoredRow, originalSecrets: readonly string[], blocked: readonly string[]) => {
      const current = await input.store.load(model, saved.id); const inventory = currentBound.models.get(model);
      if (inventory === undefined || current === null || current.archivedAt !== null || current.version < saved.version ||
          current.created !== saved.created || current.createdBy !== saved.createdBy ||
          (current.parent?.model ?? null) !== (saved.parent?.model ?? null) ||
          (current.parent?.id ?? null) !== (saved.parent?.id ?? null)) return null;
      return projectSavedRecordForViewer({ policy: input.policy.get(model), context, current, saved,
        originalSecretFields: [...originalSecrets, ...blocked, ...inventory.secrets, ...inventory.withheld] });
    };
    let dependenciesReadable = true;
    const returned = association.plan.returns.find(entry => entry.id === association.returnId)!;
    for (const observation of association.observations) {
      const dependency = returned.dependencies.find(dep => dep.id === observation.dependencyId)!;
      const projection = await savedProjection(observation.model, observation.row, observation.secretFields, []);
      if (currentBound.models.get(observation.model)?.fields.get(dependency.field) !== dependency.type || projection === null ||
          !Object.hasOwn(projection.data, dependency.field) ||
          stableStringify(projection.data[dependency.field]) !== stableStringify(observation.row.data[dependency.field])) dependenciesReadable = false;
    }
    for (const observation of association.intrinsics ?? []) {
      const dependency = returned.intrinsics!.find(dep => dep.id === observation.dependencyId)!;
      // Operation id belongs to this exact retained invocation and current
      // operation authority above; it does not confer business-row access.
      if (observation.kind === 'operation-id') continue;
      if (observation.kind === 'admitted-input') {
        if (!primitiveInput(def as GeneratedOperationDef, dependency)) dependenciesReadable = false;
        continue;
      }
      if (!versionedReferenceInput(def as GeneratedOperationDef, dependency)) { dependenciesReadable = false; continue; }
      const projection = await savedProjection(observation.model, observation.row, observation.secretFields, []);
      if (projection === null || String(projection.version) !== observation.wire) dependenciesReadable = false;
    }
    const records: ProjectedRecord[] = [];
    for (const changed of association.changed) {
      const fields = currentBound.models.get(changed.model)?.fields;
      const drifted = Object.keys(changed.row.data).filter(field =>
        !Object.hasOwn(changed.fieldTypes, field) || fields?.get(field) !== changed.fieldTypes[field]);
      const record = await savedProjection(changed.model, changed.row, changed.secretFields, [...changed.withheldFields, ...drifted]);
      if (record !== null && dependenciesReadable) records.push(record);
    }
    return { result: dependenciesReadable && association.resultType === currentBound.type && receipt.outcome.status === 'committed'
      ? dataCopy(receipt.outcome.result) : null, records };
  };
  const first = await project(live);
  // Individual Identity reads cannot certify a jointly authorized point for
  // different subjects, even when repeated snapshots compare equal (ABA).
  // Keep that profile unavailable until its owning coherent snapshot join.
  if (authorityFacts.size > 1) return withheld;
  if (await input.store.readRevision() !== revision) return withheld;
  const secondMembership = await membership();
  if (stableStringify(dataCopy(secondMembership)) !== membershipSnapshot ||
      stableStringify(await project(secondMembership)) !== stableStringify(first) || await input.store.readRevision() !== revision) return withheld;
  // Identity storage has its own lifetime: a State revision cannot fence a
  // caller or subject-role revocation during the final projection's reads.
  for (const fact of authorityFacts.values()) {
    if (stableStringify(dataCopy(await input.memberships.findMembership(fact.teamId, fact.userId))) !== fact.snapshot) return withheld;
  }
  if (authorityDrift || await input.store.readRevision() !== revision) return withheld;
  return first;
}
