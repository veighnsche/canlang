/** Saved scenario disclosure. Compiler supplies the complete checked return
 * closure; the native host reports only actually evaluated private bindings.
 * Capture is available only during invoke, never from a request envelope.
 * This version supports scalar Values profiles and declared scalar fields.
 * Nominal/model/container/File/Delivery, query influence and absent-reference
 * claims require their defining joins. Empty field observations prove none of
 * those facts. Every site is scoped by its checked source return/digest/module.
 */
import type { ArtifactModel, CanTypeId, DomainWrite, ModelName, ProjectedRecord,
  Receipt, ScenarioReceiptAssociation, ScenarioResultDisclosurePlan, StoragePort, StoredRow } from '@canlang/contracts';
import { decodeValue, parseTypeId, printTypeId } from '@canlang/values';
import { StateError } from '../errors.js';
import { deepFreeze, getDataPath } from '../internal/own-data.js';
import type { PolicyTable } from '../policy/grants.js';
import { evaluateBy, type MembershipReader } from '../policy/roles.js';
import { projectSavedRecordForViewer } from '../query/engine.js';
import type { ResolvedIdentity } from '@canlang/contracts';
import type { AdmittedCall } from './admission.js';
import { assertScenarioReceiptExecution } from './invoke.js';
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
    const returned = object(entry, ['id', 'source', 'dependencies', 'influences']); const id = text(returned['id']);
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
  }
  if (dependencies.size > MAX_ITEMS) return invalid('dependency closure exceeds its finite budget.');
  return deepFreeze(plan as unknown as ScenarioResultDisclosurePlan);
}

interface ModelInventory {
  readonly fields: ReadonlyMap<string, CanTypeId | null>;
  readonly secrets: readonly string[];
  readonly withheld: readonly string[];
}
interface BoundPlan { readonly plan: ScenarioResultDisclosurePlan; readonly type: CanTypeId; readonly models: ReadonlyMap<ModelName, ModelInventory> }
const boundPlans = new WeakMap<GeneratedOperationDef, BoundPlan>();

/** Registry-owned registration after exact artifact source/callable checking. */
export function bindScenarioReceiptPlan(def: GeneratedOperationDef, models: readonly ArtifactModel[]): void {
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
  boundPlans.set(def, { plan, type, models: inventory });
}

interface Capture {
  readonly bound: BoundPlan;
  returnId: string | null;
  readonly observations: Array<ScenarioReceiptAssociation['observations'][number] & { readonly stored: boolean }>;
}
const captures = new WeakMap<AdmittedCall, Capture>();
function capture(call: AdmittedCall, store: StoragePort): Capture {
  assertScenarioReceiptExecution(call, store);
  const bound = boundPlans.get(call.def as GeneratedOperationDef);
  if (bound === undefined) return invalid('no loader-verified source dependency plan.');
  let value = captures.get(call);
  if (value === undefined) { value = { bound, returnId: null, observations: [] }; captures.set(call, value); }
  return value;
}

/** Native host supplies its actual protected binding, not a wire reference.
 * Store-matching reads and final own-write snapshots are supported. Intermediate
 * provisional snapshots require the defining owner-session observation join.
 */
export async function observeScenarioReceiptDependency(call: AdmittedCall, store: StoragePort, input: {
  readonly dependencyId: string; readonly model: ModelName; readonly row: StoredRow; readonly field: string;
}): Promise<void> {
  const state = capture(call, store);
  if (state.returnId !== null) return invalid('observation cannot follow the selected return.');
  const observed = dataCopy(input);
  object(observed, ['dependencyId', 'model', 'row', 'field']);
  const dependency = state.bound.plan.returns.flatMap(entry => entry.dependencies).find(dep => dep.id === observed.dependencyId);
  if (dependency === undefined || dependency.model !== observed.model || dependency.field !== observed.field) return invalid('native observation disagrees with its checked dependency.');
  if (state.observations.length >= MAX_ITEMS) return invalid('observation budget exceeded.');
  const row = checkedRow(observed.row); scalarWire(dependency.type, getDataPath(row.data, dependency.field));
  if (row.archivedAt !== null) return invalid('cannot observe an archived row.');
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
    stored: current !== null && stableStringify(current) === stableStringify(row) });
}

/** The emitted selected return path determines required reads; unrelated private
 * decision-only reads do not become dependencies of literal/input results.
 */
export function selectScenarioReceiptReturn(call: AdmittedCall, store: StoragePort, returnId: string): void {
  const state = capture(call, store);
  const returned = state.bound.plan.returns.find(entry => entry.id === returnId);
  if (state.returnId !== null || returned === undefined) return invalid('one actual checked return path required.');
  if (returned.dependencies.some(dep => !state.observations.some(entry => entry.dependencyId === dep.id))) {
    return invalid('required observations must complete before selecting the actual return.');
  }
  state.returnId = returnId;
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
export function retainScenarioReceipt(call: AdmittedCall, writes: readonly DomainWrite[], result: unknown): ScenarioReceiptAssociation | undefined {
  let state = captures.get(call); captures.delete(call);
  const bound = boundPlans.get(call.def as GeneratedOperationDef);
  if (bound === undefined) return undefined;
  // One checked empty path permits the ordinary implicit void return. Its
  // success receipt carries no business result and still saves changed rows.
  if (bound.type === 'void' && bound.plan.returns.length === 1 && bound.plan.returns[0]!.dependencies.length === 0) {
    state ??= { bound, returnId: null, observations: [] };
    state.returnId ??= bound.plan.returns[0]!.id;
  }
  if (state === undefined || state.returnId === null) return invalid('checked scenario omitted its actual return capture.');
  scalarWire(bound.type, dataCopy(result));
  const returned = bound.plan.returns.find(entry => entry.id === state.returnId)!;
  const required = new Set(returned.dependencies.map(dep => dep.id));
  const observed = state.observations.filter(entry => required.has(entry.dependencyId));
  if (returned.dependencies.some(dep => !observed.some(entry => entry.dependencyId === dep.id))) return invalid('required return dependency was not evaluated/captured.');
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
  for (const entry of observed) if (!entry.stored && !changed.some(change => change.model === entry.model &&
      stableStringify(change.row) === stableStringify(entry.row))) {
    return invalid('provisional read is not the final committed own-row snapshot; owner-session join required.');
  }
  return deepFreeze(dataCopy({ kind: 'scenario-result/v1' as const, plan: bound.plan, resultType: bound.type,
    returnId: state.returnId, observations: observed.map(({ stored: _stored, ...entry }) => entry), changed }));
}

/** Legacy receipts are unassociated; malformed recognized metadata refuses. */
export function readScenarioReceiptAssociation(receipt: Receipt): ScenarioReceiptAssociation | null {
  receipt = dataCopy(receipt);
  if (!Object.hasOwn(receipt.outcome, 'scenario')) return null;
  if (receipt.outcome.status !== 'committed') return invalid('association requires a committed outcome.');
  const value = object(dataCopy(receipt.outcome.scenario), ['kind', 'plan', 'resultType', 'returnId', 'observations', 'changed']);
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
 * Missing required access withholds the entire typed result as null; changed
 * records are independently projected. Unknown current inventory fails closed.
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
  const membership = () => actorUserId !== null && teamId !== null
    ? input.memberships.findMembership(teamId, actorUserId) : Promise.resolve(null);
  const live = await membership(); const membershipSnapshot = stableStringify(dataCopy(live));
  const withheld = { result: null, records: [] } as const;
  const project = async (member: Awaited<ReturnType<typeof membership>>) => {
    const context = { actorUserId, teamId, membership: member, memberships: input.memberships };
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
    let readable = association.resultType === currentBound.type;
    const returned = association.plan.returns.find(entry => entry.id === association.returnId)!;
    for (const observation of association.observations) {
      const dependency = returned.dependencies.find(dep => dep.id === observation.dependencyId)!;
      const projection = await savedProjection(observation.model, observation.row, observation.secretFields, []);
      if (currentBound.models.get(observation.model)?.fields.get(dependency.field) !== dependency.type || projection === null ||
          !Object.hasOwn(projection.data, dependency.field) ||
          stableStringify(projection.data[dependency.field]) !== stableStringify(observation.row.data[dependency.field])) readable = false;
    }
    const records: ProjectedRecord[] = [];
    for (const changed of association.changed) {
      const fields = currentBound.models.get(changed.model)?.fields;
      const drifted = Object.keys(changed.row.data).filter(field =>
        !Object.hasOwn(changed.fieldTypes, field) || fields?.get(field) !== changed.fieldTypes[field]);
      const record = await savedProjection(changed.model, changed.row, changed.secretFields, [...changed.withheldFields, ...drifted]);
      if (record !== null) records.push(record);
    }
    return { result: readable && receipt.outcome.status === 'committed' ? dataCopy(receipt.outcome.result) : null, records };
  };
  const first = await project(live);
  if (await input.store.readRevision() !== revision) return withheld;
  const secondMembership = await membership();
  if (stableStringify(dataCopy(secondMembership)) !== membershipSnapshot ||
      stableStringify(await project(secondMembership)) !== stableStringify(first) || await input.store.readRevision() !== revision) return withheld;
  return first;
}
