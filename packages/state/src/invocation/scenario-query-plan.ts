/** Finite checked query projections and their saved disclosure closure. */
import type {
  ArtifactModel, ArtifactModelField, CanTypeId, ModelName, ProjectedRecord,
  ScenarioReceiptQueryObservation, ScenarioReceiptQueryPlan, ScenarioReceiptQueryProjection,
  ScenarioResultDisclosurePlan, StoredRow,
} from '@canlang/contracts';
import {
  compareInt, compareDecimal, compareMoney, decodeValue, encodeValue,
  parseTypeId, printTypeId, validateValue, type Decimal, type MoneyValue,
  type NormalizedSchema,
} from '@canlang/values';
import { StateError } from '../errors.js';
import { deepFreeze } from '../internal/own-data.js';
import { stableStringify } from './replay.js';

const MAX = 200;
const fail = (message: string): never => { throw new StateError('validation', `Saved scenario query: ${message}`); };
const same = (left: unknown, right: unknown): boolean => stableStringify(left) === stableStringify(right);
const fieldName = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return fail('direct declared field required.');
  return value;
};
const text = (value: unknown): string => typeof value === 'string' && value.length > 0 && value.length <= 4096
  ? value : fail('bounded nonempty identity required.');

/** Reject accessors, cycles, sparse arrays and exotic objects before inspection. */
function copy(value: unknown): unknown {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (part: unknown, depth: number): unknown => {
    if (++nodes > 20000 || depth > 32) return fail('own data budget exceeded.');
    if (part === null || typeof part === 'string' || typeof part === 'boolean') return part;
    if (typeof part === 'number' && Number.isFinite(part)) return part;
    if (typeof part !== 'object' || part === null || seen.has(part) ||
        (!Array.isArray(part) && ![Object.prototype, null].includes(Object.getPrototypeOf(part)))) return fail('own JSON data required.');
    seen.add(part);
    const result: Record<string, unknown> | unknown[] = Array.isArray(part) ? [] : {};
    for (const key of Reflect.ownKeys(part)) {
      if (Array.isArray(part) && key === 'length') continue;
      const member = Object.getOwnPropertyDescriptor(part, key);
      if (typeof key !== 'string' || member === undefined || !('value' in member) || !member.enumerable ||
          (Array.isArray(part) && !/^(0|[1-9]\d*)$/.test(key))) return fail('own enumerable data required.');
      Object.defineProperty(result, key, { value: visit(member.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    if (Array.isArray(part) && Object.keys(result).length !== part.length) return fail('dense arrays required.');
    seen.delete(part); return result;
  };
  return visit(value, 0);
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length ||
      keys.some(key => { const member = Object.getOwnPropertyDescriptor(value, key);
        return member === undefined || !('value' in member) || !member.enumerable; })) return fail('closed own shape required.');
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > MAX) return fail('bounded array required.');
  return value;
}
function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) fail('duplicate identity.');
}
function source(value: unknown): void {
  const item = object(value, ['path', 'sha256', 'module']); text(item.path); text(item.module);
  if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) fail('exact source digest required.');
}
function checkedType(value: unknown, nominal = false): CanTypeId {
  if (typeof value !== 'string') return fail('canonical type required.');
  try {
    const type = parseTypeId(value);
    if (printTypeId(type) !== value || type.requiredArray ||
        !(type.base.kind === 'enum' || /^(int|datetime|text|bool|decimal|money|date|duration|user)(\[\])?\??$/.test(value) ||
          nominal && type.base.kind === 'nominal' && !type.array && value !== 'void')) return fail('unsupported query type.');
  } catch (error) { if (error instanceof StateError) throw error; return fail('invalid canonical type.'); }
  return value as CanTypeId;
}

export function checkQueries(value: unknown): readonly ScenarioReceiptQueryPlan[] {
  const queries = list(copy(value));
  const ids: string[] = [];
  const dependencyIds = new Map<string, string>();
  for (const value of queries) {
    const query = object(value, ['id', 'source', 'model', 'order', 'limit', 'archived', 'dependencies']);
    ids.push(text(query.id)); text(query.model); source(query.source);
    if (query.limit !== null && (!Number.isSafeInteger(query.limit) || (query.limit as number) < 0 || (query.limit as number) > MAX)) fail('bounded query limit required.');
    if (query.archived !== 'exclude' && query.archived !== 'include') fail('closed archive selection required.');
    const order = list(query.order);
    if (order.length > 8) fail('order budget exceeded.');
    const fields: string[] = [];
    for (const value of order) {
      const term = object(value, ['field', 'direction']); fields.push(fieldName(term.field));
      if (term.direction !== 'asc' && term.direction !== 'desc') fail('closed order direction required.');
    }
    unique(fields);
    const local: string[] = [];
    for (const value of list(query.dependencies)) {
      const dep = object(value, ['id', 'source', 'role', 'field', 'type']);
      const id = text(dep.id); local.push(id); source(dep.source); fieldName(dep.field); checkedType(dep.type, true);
      if (['id', 'version', 'created', 'updated', 'createdBy', 'updatedBy', 'archivedAt', 'parent'].includes(String(dep.field))) fail('declared metadata-named query fields require a separate owning path join.');
      if (dep.role !== 'data' && dep.role !== 'control') fail('closed query dependency role required.');
      const encoded = stableStringify(dep);
      if (dependencyIds.has(id) && dependencyIds.get(id) !== encoded) fail('query dependency identity drifts.');
      dependencyIds.set(id, encoded);
    }
    unique(local);
  }
  unique(ids);
  if (dependencyIds.size > MAX) fail('query dependency budget exceeded.');
  return deepFreeze(queries as unknown as ScenarioReceiptQueryPlan[]);
}

export function checkQueryProjection(returned: Record<string, unknown>, queries: readonly ScenarioReceiptQueryPlan[]): void {
  returned = copy(returned) as Record<string, unknown>;
  const influences = list(returned.influences);
  if (!Object.hasOwn(returned, 'projection')) {
    if (influences.length !== 0) fail('query/absence return influence is unsupported; defining provenance/current-authority join required.');
    return;
  }
  const projection = object(copy(returned.projection), ['kind', 'queryId', 'source', 'fields']);
  if (projection.kind !== 'query-contract-array') fail('unsupported query projection.');
  source(projection.source);
  const query = queries.find(query => query.id === projection.queryId) ?? fail('projection must name its checked query.');
  const names: string[] = []; const kinds = new Set<string>();
  for (const value of list(projection.fields)) {
    const kind = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).kind : undefined;
    const field = object(value, ['name', 'kind', ...(kind === 'field' ? ['field'] : [])]);
    names.push(fieldName(field.name));
    if (!['reference', 'version', 'field'].includes(String(kind))) fail('closed projection mapping required.');
    kinds.add(kind as string);
    if (kind === 'field' && !query.dependencies.some(dep => dep.role === 'data' && dep.field === fieldName(field.field))) fail('projected field requires its actual data dependency.');
  }
  unique(names);
  if (!kinds.has('reference') || !kinds.has('version')) fail('reference and original version projections required.');
  const ids: string[] = []; const influenceKinds = new Set<string>();
  for (const value of influences) {
    const influence = object(value, ['id', 'kind', 'queryId']); ids.push(text(influence.id));
    if (!['query-existence', 'query-cardinality', 'query-membership', 'query-order'].includes(String(influence.kind)) || influence.queryId !== query.id) fail('foreign or unsupported query influence.');
    influenceKinds.add(influence.kind as string);
  }
  unique(ids);
  if (influenceKinds.size !== 4) fail('complete query influence closure required.');
}

export function disclosureType(type: unknown, plan: ScenarioResultDisclosurePlan): CanTypeId {
  if (!plan.returns.some(returned => returned.projection !== undefined)) return type === 'void' ? type as CanTypeId : checkedType(type);
  if (!plan.returns.every(returned => returned.projection !== undefined) || typeof type !== 'string') return fail('every return requires the same contract-array disclosure profile.');
  try {
    const parsed = parseTypeId(type);
    if (printTypeId(parsed) !== type || parsed.base.kind !== 'nominal' || !parsed.array || parsed.nullable || parsed.requiredArray) fail('ordinary nonnullable nominal contract array required.');
  } catch (error) { if (error instanceof StateError) throw error; return fail('invalid contract-array type.'); }
  return type as CanTypeId;
}

function artifactType(field: ArtifactModelField, models: readonly ArtifactModel[], schema?: NormalizedSchema): CanTypeId {
  const tag = field.field;
  const primitive = ({ string: 'text', integer: 'int', decimal: 'decimal', money: 'money', datetime: 'datetime',
    boolean: 'bool', date: 'date', duration: 'duration', user: 'user' } as Record<string, string>)[tag.kind];
  const base = primitive ?? (tag.kind === 'ref' ? tag.model : tag.kind === 'enum' ? `enum(${tag.values.join(',')})` : undefined);
  if (base === undefined) return fail('unsupported owning query field.');
  const type = checkedType(field.valueType ?? `${base}${field.array === undefined ? '' : '[]'}${field.nullable === true ? '?' : ''}`, true);
  const parsed = parseTypeId(type);
  if (parsed.array !== (field.array !== undefined) || parsed.nullable !== (field.nullable === true)) fail('owning field markers disagree with canonical type.');
  const leaf = printTypeId({ ...parsed, array: false, nullable: false, requiredArray: false });
  if (tag.kind === 'ref') {
    if (leaf !== tag.model || !models.some(model => model.name === tag.model) ||
        schema && (Object.hasOwn(schema.contracts, leaf) || Object.hasOwn(schema.enums, leaf) || Object.hasOwn(schema.aliases ?? {}, leaf))) fail('actual native model reference required.');
  } else if (tag.kind === 'enum') {
    if (parsed.base.kind === 'enum') { if (!same(parsed.base.cases, tag.values)) fail('enum cases disagree.'); }
    else if (parsed.base.kind !== 'nominal' || schema === undefined || !Object.hasOwn(schema.enums, leaf) || !same(schema.enums[leaf]!.cases, tag.values)) fail('exact owning nominal enum required.');
  } else if (leaf !== primitive) fail('canonical field type disagrees with owning scalar tag.');
  return type;
}

export function checkQueryInventory(plan: ScenarioResultDisclosurePlan, type: CanTypeId,
  models: readonly ArtifactModel[], schema?: NormalizedSchema): void {
  unique(models.map(model => text(model.name)));
  for (const model of models) unique(model.fields.map(field => fieldName(field.name)));
  const queries = checkQueries(plan.queries ?? []);
  for (const query of queries) {
    const model = models.find(model => model.name === query.model) ?? fail('query requires its owning model inventory.');
    for (const dependency of query.dependencies) {
      const field = model.fields.find(field => field.name === dependency.field);
      if (field === undefined || artifactType(field, models, schema) !== dependency.type) fail('query dependency disagrees with owning field.');
    }
    for (const term of query.order) {
      if (['id', 'version', 'created', 'updated', 'createdBy', 'updatedBy', 'archivedAt'].includes(term.field)) continue;
      if (!query.dependencies.some(dep => dep.role === 'control' && dep.field === term.field)) fail('ordering requires its actual control dependency.');
    }
  }
  if (!plan.returns.some(returned => returned.projection !== undefined)) return;
  disclosureType(type, plan);
  const parsed = parseTypeId(type);
  if (parsed.base.kind !== 'nominal' || schema === undefined || !Object.hasOwn(schema.contracts, parsed.base.path)) return fail('actual normalized result contract required.');
  const fields = schema.contracts[parsed.base.path]!.fields;
  for (const returned of plan.returns) {
    checkQueryProjection(returned as unknown as Record<string, unknown>, queries);
    const projection = returned.projection!; const query = queries.find(query => query.id === projection.queryId)!;
    if (!same(Object.keys(fields).sort(), projection.fields.map(field => field.name).sort())) fail('projection must cover exactly its owning contract fields.');
    for (const mapping of projection.fields) {
      if (!Object.hasOwn(fields, mapping.name)) fail('own contract field required.');
      const actual = fields[mapping.name]!;
      if (mapping.kind === 'version') { if (actual.typeId !== 'int') fail('original version requires int contract field.'); }
      else if (mapping.kind === 'reference') {
        if (actual.typeId !== query.model || actual.type.base.kind !== 'nominal' || actual.type.array || actual.type.nullable ||
            Object.hasOwn(schema.contracts, query.model) || Object.hasOwn(schema.enums, query.model) || Object.hasOwn(schema.aliases ?? {}, query.model)) fail('reference must be the singular versioned native query model.');
      } else if (!query.dependencies.some(dep => dep.role === 'data' && dep.field === mapping.field && dep.type === actual.typeId)) fail('contract field type must match its actual queried data field.');
    }
  }
}

type Candidate = Pick<ScenarioReceiptQueryObservation['candidates'][number], 'row' | 'record'>;
export function queryProjectionWire(projection: ScenarioReceiptQueryProjection, queryPlan: ScenarioReceiptQueryPlan,
  candidates: readonly Candidate[], selectedIndices: readonly number[]): unknown[] {
  if (projection.queryId !== queryPlan.id) return fail('projection query identity differs.');
  return selectedIndices.map(index => {
    const candidate = candidates[index];
    if (candidate === undefined || !Number.isSafeInteger(index) || index < 0) return fail('selected candidate index required.');
    const out: Record<string, unknown> = {};
    for (const mapping of projection.fields) {
      let value: unknown;
      if (mapping.kind === 'reference') value = { id: candidate.row.id, version: String(candidate.row.version) };
      else if (mapping.kind === 'version') value = String(candidate.row.version);
      else {
        if (mapping.field === undefined || !Object.hasOwn(candidate.record.data, mapping.field)) return fail('selected projected field is missing.');
        value = candidate.record.data[mapping.field];
      }
      Object.defineProperty(out, mapping.name, { value: copy(value), enumerable: true, writable: true, configurable: true });
    }
    return out;
  });
}

function row(value: unknown, projected = false): StoredRow {
  const item = object(value, ['id', 'version', 'created', 'updated', 'createdBy', 'updatedBy', 'archivedAt', 'data',
    ...(projected || typeof value === 'object' && value !== null && Object.hasOwn(value, 'parent') ? ['parent'] : [])]);
  text(item.id);
  if (!Number.isSafeInteger(item.version) || (item.version as number) < 1 ||
      typeof item.created !== 'number' || !Number.isFinite(item.created) || typeof item.updated !== 'number' || !Number.isFinite(item.updated) ||
      typeof item.createdBy !== 'string' || typeof item.updatedBy !== 'string' ||
      item.archivedAt !== null && (typeof item.archivedAt !== 'number' || !Number.isFinite(item.archivedAt)) ||
      typeof item.data !== 'object' || item.data === null || Array.isArray(item.data)) fail('invalid saved row.');
  if (item.parent !== undefined && item.parent !== null) {
    const parent = object(item.parent, ['model', 'id']); text(parent.model); text(parent.id);
  }
  return item as unknown as StoredRow;
}
function subset(projected: unknown, original: unknown): boolean {
  if (Array.isArray(projected)) return Array.isArray(original) && same(projected, original);
  if (typeof projected === 'object' && projected !== null) {
    if (typeof original !== 'object' || original === null || Array.isArray(original)) return false;
    return Object.keys(projected).every(key => Object.hasOwn(original, key) &&
      subset((projected as Record<string, unknown>)[key], (original as Record<string, unknown>)[key]));
  }
  return same(projected, original);
}
function canonicalWire(type: CanTypeId, value: unknown, schema?: NormalizedSchema): void {
  try {
    // Transport reading has no owning enum registry. Preserve its string
    // observation for exact current-schema validation at disclosure time.
    const parsed = parseTypeId(type);
    if (schema === undefined && parsed.base.kind === 'nominal' && !parsed.array && typeof value === 'string') return;
    const decoded = schema === undefined ? decodeValue(type, value) : validateValue(schema, type, value, 'create');
    if (!same(encodeValue(type, decoded), value)) fail('saved wire is not canonical.');
  } catch (error) { if (error instanceof StateError) throw error; fail('invalid saved canonical wire.'); }
}
function orderValue(record: ProjectedRecord, field: string): unknown {
  return ['id', 'version', 'created', 'updated', 'createdBy', 'updatedBy', 'archivedAt'].includes(field)
    ? (record as unknown as Record<string, unknown>)[field] : record.data[field];
}
function compare(left: Candidate, right: Candidate, query: ScenarioReceiptQueryPlan): number {
  const order = query.order.length === 0 ? [{ field: 'created', direction: 'asc' }] : query.order;
  for (const term of order) {
    const a = orderValue(left.record, term.field), b = orderValue(right.record, term.field);
    let compared = 0;
    if (a === null || a === undefined || b === null || b === undefined) compared = a == null && b == null ? 0 : a == null ? -1 : 1;
    else {
      const type = query.dependencies.find(dep => dep.field === term.field)?.type.replace(/\?$/, '');
      if (type === 'int') compared = compareInt(decodeValue(type, a) as bigint, decodeValue(type, b) as bigint);
      else if (type === 'decimal') compared = compareDecimal(decodeValue(type, a) as Decimal, decodeValue(type, b) as Decimal);
      else if (type === 'money') compared = compareMoney(decodeValue(type, a) as MoneyValue, decodeValue(type, b) as MoneyValue);
      else {
        const x = typeof a === 'boolean' ? Number(a) : a, y = typeof b === 'boolean' ? Number(b) : b;
        if (typeof x === 'number' && typeof y === 'number') compared = x === y ? 0 : x < y ? -1 : 1;
        else if (typeof x === 'string' && typeof y === 'string') compared = x === y ? 0 : x < y ? -1 : 1;
        else if (typeof x !== typeof y) { const rank = (value: unknown) => typeof value === 'number' ? 0 : typeof value === 'string' ? 1 : 2; compared = rank(x) < rank(y) ? -1 : 1; }
      }
    }
    if (compared !== 0) return term.direction === 'desc' ? -compared : compared;
  }
  return left.row.id === right.row.id ? 0 : left.row.id < right.row.id ? -1 : 1;
}

export function checkSavedQueries(plan: ScenarioResultDisclosurePlan,
  returned: ScenarioResultDisclosurePlan['returns'][number], value: unknown, result: unknown, schema?: NormalizedSchema): void {
  if (returned.projection === undefined) { if (value !== undefined && list(copy(value)).length !== 0) fail('scalar return has foreign query observations.'); return; }
  const queries = list(copy(value));
  if (queries.length !== 1) fail('exact selected query association required, including empty domains.');
  const observed = object(queries[0], ['queryId', 'revision', 'candidates', 'selectedIndices']);
  const query = plan.queries?.find(query => query.id === returned.projection!.queryId) ?? fail('saved query identity differs.');
  if (observed.queryId !== query.id || !Number.isSafeInteger(observed.revision) || (observed.revision as number) < 0) fail('saved query identity/revision differs.');
  const candidates = list(observed.candidates); const identities: string[] = [];
  for (const value of candidates) {
    const candidate = object(value, ['row', 'record', 'secretFields', 'matched', 'dependencies']);
    const original = row(candidate.row), projected = row(candidate.record, true);
    identities.push(original.id);
    if (typeof candidate.matched !== 'boolean') fail('saved match must be boolean.');
    if (query.archived === 'exclude' && original.archivedAt !== null) fail('saved archive selection differs.');
    const secrets = list(candidate.secretFields).map(text); unique(secrets);
    const metadata = (value: StoredRow) => ({ ...value, parent: value.parent ?? null, data: null });
    if (!same(metadata(original), metadata(projected)) || !subset(projected.data, original.data)) fail('saved projection differs from original scan row.');
    const ids = list(candidate.dependencies).map(text); unique(ids);
    if (ids.some(id => !query.dependencies.some(dep => dep.id === id))) fail('foreign observed query dependency.');
    for (const dependency of query.dependencies) {
      const required = dependency.role === 'control' || candidate.matched;
      if (!required) continue;
      if (!ids.includes(dependency.id) || !Object.hasOwn(projected.data, dependency.field)) fail('complete false-domain control and selected data observations required.');
      canonicalWire(dependency.type, projected.data[dependency.field], schema);
    }
  }
  unique(identities);
  const selected = list(observed.selectedIndices);
  if (selected.some(index => !Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= candidates.length) ||
      new Set(selected).size !== selected.length) fail('unique selected candidate indices required.');
  const typed = candidates as unknown as ScenarioReceiptQueryObservation['candidates'];
  if (typed.some((candidate, index) => candidate.matched !== selected.includes(index))) fail('selected indices must contain every and only matched candidate.');
  if (query.limit !== null && selected.length > query.limit) fail('saved query overflow.');
  for (let index = 1; index < selected.length; index++) {
    if (compare(typed[selected[index - 1] as number]!, typed[selected[index] as number]!, query) > 0) fail('saved selected order differs from checked query.');
  }
  if (!same(copy(result), queryProjectionWire(returned.projection, query, typed, selected as number[]))) fail('saved result differs from actual selected projection.');
}

export async function savedQueriesReadable(bound: {
  readonly plan: ScenarioResultDisclosurePlan; readonly type: CanTypeId; readonly valueSchema?: NormalizedSchema | undefined;
  readonly artifactModels: ReadonlyMap<ModelName, ArtifactModel>;
}, association: { readonly plan: ScenarioResultDisclosurePlan; readonly returnId: string; readonly queries?: readonly ScenarioReceiptQueryObservation[] },
result: unknown, savedProjection: (model: ModelName, row: StoredRow, secrets: readonly string[], blocked: readonly string[]) => Promise<ProjectedRecord | null>): Promise<boolean> {
  const returned = association.plan.returns.find(returned => returned.id === association.returnId);
  if (returned === undefined) return false;
  if (returned.projection === undefined) return true;
  try {
    if (!same(bound.plan, association.plan)) return false;
    checkQueryInventory(bound.plan, bound.type, [...bound.artifactModels.values()], bound.valueSchema);
    checkSavedQueries(association.plan, returned, association.queries, result, bound.valueSchema);
    canonicalWire(bound.type, result, bound.valueSchema);
    const query = bound.plan.queries!.find(query => query.id === returned.projection!.queryId)!;
    const observed = association.queries![0]!;
    for (const candidate of observed.candidates) {
      const projected = await savedProjection(query.model, candidate.row, candidate.secretFields, []);
      if (projected === null || projected.id !== candidate.row.id || projected.version !== candidate.row.version) return false;
      for (const dependency of query.dependencies) {
        if (dependency.role !== 'control' && !candidate.matched) continue;
        if (!Object.hasOwn(projected.data, dependency.field) || !same(projected.data[dependency.field], candidate.record.data[dependency.field])) return false;
        canonicalWire(dependency.type, projected.data[dependency.field], bound.valueSchema);
      }
    }
    return true;
  } catch (error) { if (error instanceof StateError) return false; throw error; }
}
