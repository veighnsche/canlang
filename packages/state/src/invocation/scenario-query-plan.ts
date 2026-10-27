/** Finite checked query projections and their saved disclosure closure. */
import type {
  ArtifactModel, ArtifactModelField, CanTypeId, ModelName, ProjectedRecord,
  ScenarioReceiptQueryObservation, ScenarioReceiptQueryOccurrence, ScenarioReceiptQueryPlan, ScenarioReceiptQueryProjection, ScenarioReceiptCreatedRoot,
  ScenarioResultDisclosurePlan, ScenarioReceiptAssociation, StoredRow,
} from '@canlang/contracts';
import {
  compareInt, compareDecimal, compareMoney, decodeValue, encodeValue,
  normalizeValueTypes, parseTypeId, printTypeId, validateValue, type Decimal, type MoneyValue,
  type NormalizedSchema,
} from '@canlang/values';
import { StateError } from '../errors.js';
import { assertSafeBlobKey } from '@canlang/files/ports';
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
function copy(value: unknown, maximum = 20000): unknown {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (part: unknown, depth: number): unknown => {
    if (++nodes > maximum || depth > 32) return fail('own data budget exceeded.');
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
function list(value: unknown, maximum = MAX): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return fail('bounded array required.');
  return value;
}
function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) fail('duplicate identity.');
}

export interface AggregateReceiptLimits {
  readonly maxQueries: number;
  readonly maxRows: number;
  readonly maxObservations: number;
  readonly maxNodes: number;
}

/** Counts retained executions, never authority. Callers select this only from
 * their independently checked original owner plan; persisted headers cannot
 * authorize a larger decoding budget. Every payload retains the existing
 * own-data allowance inside the source's finite execution census. */
const aggregateReceiptLimitCache = new WeakMap<ScenarioResultDisclosurePlan, AggregateReceiptLimits | undefined>();
export function aggregateReceiptLimits(plan: ScenarioResultDisclosurePlan): AggregateReceiptLimits | undefined {
  // Budgets are cached only for deeply frozen installed plans. A mutable
  // plan object may change after the first lookup and must never reuse
  // prior budgets, so unfrozen inputs bypass the cache and revalidate
  // fully on every call. Replay decodes a fresh plan object per call and
  // always recomputes; failures are never cached.
  if (!Object.isFrozen(plan)) return computeAggregateReceiptLimits(plan);
  if (aggregateReceiptLimitCache.has(plan)) return aggregateReceiptLimitCache.get(plan);
  const limits = computeAggregateReceiptLimits(plan);
  aggregateReceiptLimitCache.set(plan, limits);
  return limits;
}

/** Pure budget derivation over one plan snapshot; the memoized wrapper above
 * shares this single computation per deeply frozen installed plan object.
 * Failures are never cached so fail-closed paths refuse identically every
 * time. */
function computeAggregateReceiptLimits(plan: ScenarioResultDisclosurePlan): AggregateReceiptLimits | undefined {
  const loops = plan.sourceLoops?.loops.filter(loop => loop.aggregate !== undefined) ?? [];
  if (loops.length === 0) return undefined;
  const queries = checkQueries(plan.queries ?? []);
  let maximum = 0;
  const ids = new Set<string>();
  for (const loop of loops) {
    if (ids.has(loop.id) || !Number.isSafeInteger(loop.maximum) || loop.maximum < 1 || loop.maximum > 1000 ||
        loop.writes !== 1 || loop.sends !== 0) fail('aggregate receipt lost its original finite execution census.');
    ids.add(loop.id); maximum += loop.maximum;
    const owned = queries.filter(query => query.iteration === loop.id);
    if (owned.length === 0 || owned.length !== loop.aggregate!.queries.length ||
        new Set(loop.aggregate!.queries).size !== owned.length ||
        loop.aggregate!.queries.some(id => !owned.some(query => query.id === id))) fail('aggregate receipt query census differs.');
  }
  if (maximum > 1000 || queries.some(query => query.iteration !== undefined && !ids.has(query.iteration))) {
    fail('aggregate receipt has a foreign or unbounded iteration.');
  }
  const maxRows = MAX + loops.reduce((total, loop) => total + loop.maximum * (loop.writes! + 1), 0);
  let maxQueries = queries.filter(query => query.iteration === undefined).length;
  let maxObservations = MAX;
  for (const loop of loops) {
    const owned = queries.filter(query => query.iteration === loop.id);
    const linked = new Set(plan.returns.flatMap(returned => returned.dependencies)
      .filter(dependency => owned.some(query => query.id === dependency.queryId)).map(dependency => dependency.id));
    maxQueries += loop.maximum * owned.length;
    maxObservations += loop.maximum * (loop.aggregate!.dependencies.length + maxRows * linked.size);
  }
  // Each candidate retains both its source row and its granted projection;
  // each execution may retain a parent, and ordinary/item observations retain
  // their own rows. Preserve the existing allowance for each bounded payload.
  const maxNodes = 20000 * (1 + maxRows + maxObservations + maxQueries * (2 * maxRows + 1));
  if (![maxQueries, maxRows, maxObservations, maxNodes].every(value => Number.isSafeInteger(value) && value > 0)) {
    fail('aggregate receipt execution budget overflow.');
  }
  return Object.freeze({ maxQueries, maxRows, maxObservations, maxNodes });
}
function source(value: unknown): void {
  const item = object(value, ['path', 'sha256', 'module']); text(item.path); text(item.module);
  if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) fail('exact source digest required.');
}
function checkedType(value: unknown, nominal = false, files = false): CanTypeId {
  if (typeof value !== 'string') return fail('canonical type required.');
  try {
    const type = parseTypeId(value);
    if (printTypeId(type) !== value || type.requiredArray ||
        !(files && value === 'file[]' || type.base.kind === 'enum' || /^(int|datetime|text|bool|decimal|money|date|duration|currency|user)(\[\])?\??$/.test(value) ||
          nominal && type.base.kind === 'nominal' && value !== 'void')) return fail('unsupported query type.');
  } catch (error) { if (error instanceof StateError) throw error; return fail('invalid canonical type.'); }
  return value as CanTypeId;
}

/** Shared closed identity of one genuine selected item. The checked plan and
 * saved complete selection below supply its source and lifetime witnesses. */
export function checkQueryOccurrence(value:unknown):ScenarioReceiptQueryOccurrence{
 const raw=object(copy(value),['loop','ordinal']);
 if(!/^[a-f0-9]{64}$/.test(text(raw.loop))||!Number.isSafeInteger(raw.ordinal)||(raw.ordinal as number)<0||(raw.ordinal as number)>=1000)fail('original bounded loop item occurrence required.');
 return deepFreeze(raw)as unknown as ScenarioReceiptQueryOccurrence;
}
function createdQueryRoot(value:unknown):ScenarioReceiptCreatedRoot{
 const raw=object(value,['id','node','stage','binding','model','parentParameter','parentModel']),node=object(raw.node,['start','end']);
 if(!/^[a-f0-9]{64}$/.test(text(raw.id))||!Number.isSafeInteger(raw.stage)||(raw.stage as number)<0||(raw.stage as number)>=MAX||!Number.isSafeInteger(node.start)||!Number.isSafeInteger(node.end)||(node.start as number)<0||(node.start as number)>=(node.end as number))fail('exact original created query parent required.');
 for(const key of ['binding','model','parentParameter','parentModel'])text(raw[key]);
 return raw as unknown as ScenarioReceiptCreatedRoot;
}

export function checkQueries(value: unknown): readonly ScenarioReceiptQueryPlan[] {
  const queries = list(copy(value));
  const ids: string[] = [];
  const dependencyIds = new Map<string, string>();
  for (const value of queries) {
    const query = object(value, ['id', 'source', 'model', 'order', 'limit', 'archived', 'dependencies',
      ...(typeof value === 'object' && value !== null && Object.hasOwn(value, 'parent') ? ['parent'] : []),
      ...(typeof value === 'object' && value !== null && Object.hasOwn(value,'iteration')?['iteration']:[])]);
    if(Object.hasOwn(query,'iteration')&&!/^[a-f0-9]{64}$/.test(text(query.iteration)))fail('exact original query iteration required.');
    ids.push(text(query.id)); text(query.model); source(query.source);
    if (Object.hasOwn(query, 'parent')) {
      const parent = object(query.parent, ['source', 'model', 'origin']);
      source(parent.source); text(parent.model);
      const kind = typeof parent.origin === 'object' && parent.origin !== null
        ? (parent.origin as Record<string, unknown>).kind : undefined;
      if (kind !== 'admitted-reference' && kind !== 'stored-reference' && kind !== 'created-reference') fail('closed parent origin required.');
      const origin = object(parent.origin, ['kind', kind === 'admitted-reference' ? 'parameter' : kind==='created-reference'?'created':'dependencyId']);
      if (kind === 'admitted-reference') fieldName(origin.parameter);
      else if(kind==='created-reference'){if(createdQueryRoot(origin.created).model!==parent.model)fail('created query parent model differs.');}
      else text(origin.dependencyId);
    }
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
      const id = text(dep.id); local.push(id); source(dep.source); fieldName(dep.field); checkedType(dep.type, true, dep.role === 'data');
      if (dep.type === 'file[]' && order.some(term => (term as Record<string, unknown>).field === dep.field)) fail('File data cannot order a query.');
      if (['id', 'version', 'created', 'updated', 'createdBy', 'updatedBy', 'archivedAt'].includes(String(dep.field))) fail('declared metadata-named query fields require a separate owning path join.');
      if (dep.field === 'parent') {
        const type = parseTypeId(dep.type as string);
        if (type.base.kind !== 'nominal' || type.array || type.nullable) fail('parent requires a required singular owning model reference.');
      }
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
  const projection = Object.hasOwn(returned, 'projection') ? checkProjection(returned.projection, queries) : undefined;
  const ids: string[] = []; const influenceKinds = new Map<string, Set<string>>();
  for (const value of influences) {
    const influence = object(value, ['id', 'kind', 'queryId']); ids.push(text(influence.id));
    const queryId = text(influence.queryId);
    if (!['query-existence', 'query-cardinality', 'query-membership', 'query-order'].includes(String(influence.kind)) ||
        !queries.some(query => query.id === queryId) || projection !== undefined && queryId !== projection.queryId) fail('foreign or unsupported query influence.');
    const kinds = influenceKinds.get(queryId) ?? new Set<string>();
    if (kinds.has(influence.kind as string)) fail('duplicate query influence kind.');
    kinds.add(influence.kind as string); influenceKinds.set(queryId, kinds);
  }
  unique(ids);
  if (projection !== undefined && !influenceKinds.has(projection.queryId) ||
      [...influenceKinds.values()].some(kinds => kinds.size !== 4)) fail('complete query influence closure required.');
  const dependencies = list(returned.dependencies);
  for (const value of dependencies) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('ordinary dependency requires an own object.');
    const dependency = value as ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number];
    if (!Object.hasOwn(dependency, 'queryId')) continue;
    const query = queries.find(query => query.id === text(dependency.queryId));
    if (query === undefined || !influenceKinds.has(query.id) || !same(dependency.source, query.source)) {
      fail('ordinary dependency requires its exact consumed query and source.');
    }
    if (queries.some(query => query.dependencies.some(observed => observed.id === dependency.id))) {
      fail('ordinary query-linked dependency identity conflicts with a query field dependency.');
    }
  }
}

/** The existing return influence closure names exactly the retained queries. */
export function returnQueryIds(returned: ScenarioResultDisclosurePlan['returns'][number]): readonly string[] {
  return [...new Set(returned.influences.map(influence => influence.queryId!))];
}

/** Actual candidate IDs may include these ordinary reads, without requiring
 * every candidate to take a lazy branch. Their rows remain ordinary observations. */
export function queryLinkedReturnDependencies(returned: ScenarioResultDisclosurePlan['returns'][number],
  query: ScenarioReceiptQueryPlan): ScenarioResultDisclosurePlan['returns'][number]['dependencies'] {
  const dependencies = returned.dependencies.filter(dependency => dependency.queryId === query.id);
  if (dependencies.length > 0 && (!returnQueryIds(returned).includes(query.id) ||
      dependencies.some(dependency => !same(dependency.source, query.source)))) {
    fail('ordinary dependency requires its exact consumed query and source.');
  }
  return dependencies;
}

function checkProjection(value: unknown, queries: readonly ScenarioReceiptQueryPlan[]): ScenarioReceiptQueryProjection {
  const projection = object(copy(value), ['kind', 'queryId', 'source', 'fields']);
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
  return projection as unknown as ScenarioReceiptQueryProjection;
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
  const primitive = tag.kind === 'string' && field.valueType?.replace(/\[\]|\?/g, '') === 'currency' ? 'currency' :
    ({ string: 'text', integer: 'int', decimal: 'decimal', money: 'money', datetime: 'datetime',
    boolean: 'bool', date: 'date', duration: 'duration', user: 'user' } as Record<string, string>)[tag.kind];
  const base = primitive ?? (tag.kind === 'ref' ? tag.model : tag.kind === 'enum' ? `enum(${tag.values.join(',')})`
    : tag.kind === 'nominal' ? tag.name : tag.kind === 'file' ? 'file' : undefined);
  if (base === undefined) return fail('unsupported owning query field.');
  const type = checkedType(field.valueType ?? `${base}${field.array === undefined ? '' : '[]'}${field.nullable === true ? '?' : ''}`, true, tag.kind === 'file');
  const parsed = parseTypeId(type);
  if (parsed.array !== (field.array !== undefined) || parsed.nullable !== (field.nullable === true)) fail('owning field markers disagree with canonical type.');
  const leaf = printTypeId({ ...parsed, array: false, nullable: false, requiredArray: false });
  if (tag.kind === 'file') {
    if (type !== 'file[]' || field.valueType !== type || field.nullable === true || field.array === undefined || field.array.required !== false ||
        Object.keys(field.array).length !== 1 || Object.keys(tag).length !== 1 ||
        typeof field.required !== 'boolean' || typeof field.serverOnly !== 'boolean') fail('ordinary owning nonnullable File array required.');
  } else if (tag.kind === 'ref') {
    if (leaf !== tag.model || !models.some(model => model.name === tag.model) ||
        schema && (Object.hasOwn(schema.contracts, leaf) || Object.hasOwn(schema.enums, leaf) || Object.hasOwn(schema.aliases ?? {}, leaf))) fail('actual native model reference required.');
  } else if (tag.kind === 'nominal') {
    if (parsed.base.kind !== 'nominal' || leaf !== tag.name || schema === undefined ||
        !Object.hasOwn(schema.enums, leaf) || Object.hasOwn(schema.contracts, leaf) ||
        Object.hasOwn(schema.aliases ?? {}, leaf) || models.some(model => model.name === leaf)) fail('exact owning nominal enum required.');
  } else if (tag.kind === 'enum') {
    if (parsed.base.kind === 'enum') { if (!same(parsed.base.cases, tag.values)) fail('enum cases disagree.'); }
    else if (parsed.base.kind !== 'nominal' || schema === undefined || !Object.hasOwn(schema.enums, leaf) || !same(schema.enums[leaf]!.cases, tag.values)) fail('exact owning nominal enum required.');
  } else if (leaf !== primitive) fail('canonical field type disagrees with owning scalar tag.');
  // A direct query enum uses its case-list wire identity even when reuse also
  // publishes the field as nominal. Validate that owning nominal schema above
  // before normalizing; nullable/array and reference identities stay explicit.
  if (!parsed.array && !parsed.nullable && (tag.kind === 'enum' || tag.kind === 'nominal')) {
    const cases = tag.kind === 'enum' ? tag.values : schema!.enums[leaf]!.cases;
    return checkedType(`enum(${cases.join(',')})`, true);
  }
  return type;
}

export function checkQueryInventory(plan: ScenarioResultDisclosurePlan, type: CanTypeId,
  models: readonly ArtifactModel[], schema?: NormalizedSchema): void {
  unique(models.map(model => text(model.name)));
  for (const model of models) unique(model.fields.map(field => fieldName(field.name)));
  const queries = checkQueries(plan.queries ?? []);
  const linkedIdentities = new Map<string, { encoded: string; linked: boolean }>();
  for (const returned of plan.returns) {
    checkQueryProjection(returned as unknown as Record<string, unknown>, queries);
    for (const dependency of returned.dependencies) {
      const encoded = stableStringify(dependency);
      const previous = linkedIdentities.get(dependency.id), linked = dependency.queryId !== undefined;
      if (previous !== undefined && previous.encoded !== encoded && (previous.linked || linked)) {
        fail('ordinary query-linked dependency drifts across returns.');
      }
      linkedIdentities.set(dependency.id, { encoded, linked });
    }
  }
  for (const query of queries) {
    const model = models.find(model => model.name === query.model) ?? fail('query requires its owning model inventory.');
    if(query.iteration!==undefined){const loop=plan.sourceLoops?.loops.find(loop=>loop.id===query.iteration);if(loop?.aggregate===undefined||!loop.aggregate.queries.includes(query.id)||!same(plan.sourceLoops!.source,plan.source))fail('repeated query requires its exact original aggregate loop association.');}
    if (query.parent !== undefined) {
      const parentModel = query.parent.model;
      if (model.fields.some(field => field.name === 'parent') || Object.hasOwn(model, 'scope') || model.parent !== parentModel ||
          !models.some(parent => parent.name === parentModel) || schema &&
          (Object.hasOwn(schema.contracts, parentModel) || Object.hasOwn(schema.enums, parentModel) ||
            Object.hasOwn(schema.aliases ?? {}, parentModel))) fail('scoped query requires unshadowed declared parent containment.');
      if(query.parent.origin.kind==='created-reference'){
        const created=query.parent.origin.created,owner=models.find(model=>model.name===created.model);
        if(owner===undefined||owner.parent!==created.parentModel||created.model!==parentModel||!models.some(model=>model.name===created.parentModel)||!same(query.parent.source,plan.source))fail('created query parent differs from its original declared containment.');
      }
      if (query.parent.origin.kind === 'stored-reference') {
        const dependencyId = query.parent.origin.dependencyId;
        const consumers = plan.returns.filter(returned => returnQueryIds(returned).includes(query.id));
        const dependencies = consumers.map(returned => returned.dependencies.find(dependency => dependency.id === dependencyId));
        if (consumers.length === 0 || dependencies.some(dependency => dependency === undefined)) fail('scoped stored parent requires its ordinary return dependency.');
        for (const dependency of dependencies) {
          if (dependency === undefined) return fail('scoped stored parent dependency is missing.');
          if (dependency.queryId !== undefined) fail('scoped stored parent must be observed before its query.');
          source(dependency.source);
          const owner = models.find(model => model.name === dependency.model) ?? fail('stored parent requires its owning model inventory.');
          const field = owner?.fields.find(field => field.name === dependency.field);
          if (owner === undefined || dependency.type !== parentModel) fail('stored parent requires its exact required singular native reference.');
          if (dependency.field === 'parent') {
            if (field !== undefined || Object.hasOwn(owner, 'scope') || owner.parent !== parentModel) fail('stored parent requires unshadowed declared parent metadata.');
          } else if (field === undefined || field.field.kind !== 'ref' || field.array !== undefined || field.nullable === true ||
              artifactType(field, models, schema) !== parentModel) fail('stored parent requires its owning required singular model reference.');
        }
        if (dependencies.some(dependency => !same(dependency, dependencies[0]))) fail('scoped stored parent dependency drifts across returns.');
      }
    }
    for (const dependency of query.dependencies) {
      const field = model.fields.find(field => field.name === dependency.field);
      if (dependency.field === 'parent') {
        if (field !== undefined || Object.hasOwn(model, 'scope') || model.parent !== dependency.type ||
            !models.some(parent => parent.name === model.parent) || schema &&
            (Object.hasOwn(schema.contracts, dependency.type) || Object.hasOwn(schema.enums, dependency.type) ||
              Object.hasOwn(schema.aliases ?? {}, dependency.type))) fail('unshadowed declared parent containment required.');
        continue;
      }
      if (field === undefined || artifactType(field, models, schema) !== dependency.type) fail('query dependency disagrees with owning field.');
      const parsed = parseTypeId(dependency.type);
      if (parsed.base.kind === 'nominal' && parsed.array &&
          (dependency.role !== 'control' || field?.field.kind !== 'ref')) fail('nominal query arrays require owning Model-reference CONTROL fields.');
    }
    for (const term of query.order) {
      if (term.field === 'parent') fail('parent metadata is not an ordered business field.');
      if (['id', 'version', 'created', 'updated', 'createdBy', 'updatedBy', 'archivedAt'].includes(term.field)) continue;
      if (!query.dependencies.some(dep => dep.role === 'control' && dep.field === term.field)) fail('ordering requires its actual control dependency.');
    }
  }
  for(const loop of plan.sourceLoops?.loops??[]){
    if(loop.aggregate===undefined)continue;
    const owned=queries.filter(query=>query.iteration===loop.id);
    if(owned.length!==loop.aggregate.queries.length||loop.aggregate.queries.some(id=>!owned.some(query=>query.id===id)))fail('aggregate loop differs from its complete original query census.');
    for(const id of loop.aggregate.dependencies)if(!plan.returns.some(returned=>returned.dependencies.some(dependency=>dependency.id===id&&dependency.queryId===undefined)))fail('aggregate loop has a foreign original item DATA dependency.');
    if(!models.some(model=>model.name===loop.model&&model.parent===loop.parentModel))fail('aggregate loop lost its declared original item containment.');
    const parent=models.find(model=>model.name===type),write=models.find(model=>model.name===loop.aggregate!.write.model);
    if(parent?.parent!==loop.parentModel||write?.parent!==parent.name||
        loop.aggregate.write.fields.some(name=>!write.fields.some(field=>field.name===name))||
        owned.some(query=>query.parent?.origin.kind==='created-reference'&&query.parent.origin.created.binding!==loop.aggregate!.write.parent)){
      fail('aggregate constructor differs from its declared result parent and owning fields.');
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
      } else if (!query.dependencies.some(dep => {
        if (dep.role !== 'data' || dep.field !== mapping.field) return false;
        if (dep.type === actual.typeId) return true;
        const field = models.find(model => model.name === query.model)?.fields.find(field => field.name === mapping.field);
        // Keep the exact declaring nominal identity in the projected Contract,
        // while the already-checked query dependency uses its enum case wire.
        const declared = field?.valueType ?? (field?.field.kind === 'nominal' ? field.field.name : undefined);
        return field !== undefined && declared === actual.typeId && artifactType(field, models, schema) === dep.type;
      })) fail('contract field type must match its actual queried data field.');
    }
  }
}

function dependencyWire(record: ProjectedRecord, dependency: ScenarioReceiptQueryPlan['dependencies'][number]): unknown {
  if (dependency.field === 'parent') {
    if (record.parent === null || record.parent.model !== dependency.type) return fail('exact declared parent metadata required.');
    return { id: record.parent.id };
  }
  if (!Object.hasOwn(record.data, dependency.field)) return fail('actual query observation field is missing.');
  return record.data[dependency.field];
}
function checkDependencyWire(record: ProjectedRecord, dependency: ScenarioReceiptQueryPlan['dependencies'][number], schema?: NormalizedSchema): unknown {
  const wire = dependencyWire(record, dependency);
  if (dependency.type === 'file[]') {
    for (const value of list(wire)) {
      const file = object(value, ['id']);
      if (typeof file.id !== 'string') fail('canonical File identity required.');
      try { assertSafeBlobKey(file.id as string); }
      catch { fail('safe canonical File identity required.'); }
    }
  }
  // Stored containment is a model wire, never a nominal contract or a data field.
  canonicalWire(dependency.type, wire, dependency.field === 'parent' && schema === undefined
    ? normalizeValueTypes({ contracts: [] }, [dependency.type]).valueSchema : schema);
  return wire;
}
type Candidate = { readonly row: Pick<StoredRow, 'id' | 'version'>; readonly record: ProjectedRecord };
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
        const dependency = queryPlan.dependencies.find(dep => dep.role === 'data' && dep.field === mapping.field);
        if (dependency === undefined) return fail('selected projected field is missing.');
        value = dependencyWire(candidate.record, dependency);
      }
      Object.defineProperty(out, mapping.name, { value: copy(value), enumerable: true, writable: true, configurable: true });
    }
    return out;
  });
}

/** Pure fresh-read wire conversion. The caller owns viewer selection and current
 * authorization; this creates no receipt, source evidence or owner authority. */
export function projectReadQueryProjectionWire(projection: ScenarioReceiptQueryProjection,
  query: ScenarioReceiptQueryPlan, selected: readonly ProjectedRecord[]): unknown[] {
  const checked = checkQueries([query])[0]!;
  const mapping = checkProjection(projection, [checked]);
  const records = list(copy(selected)).map(value => row(value, true) as ProjectedRecord);
  if (checked.limit !== null && records.length > checked.limit) fail('fresh query overflow.');
  unique(records.map(record => record.id));
  for (const record of records) {
    if (checked.archived === 'exclude' && record.archivedAt !== null) fail('fresh archive selection differs.');
    for (const field of mapping.fields) {
      if (field.kind !== 'field') continue;
      const dependency = checked.dependencies.find(dep => dep.role === 'data' && dep.field === field.field)!;
      checkDependencyWire(record, dependency);
    }
  }
  return queryProjectionWire(mapping, checked,
    records.map(record => ({ row: { id: record.id, version: record.version }, record })),
    records.map((_, index) => index));
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
    if (!same(encodeValue(type, decoded, undefined, schema), value)) fail('saved wire is not canonical.');
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

/** The complete original selection makes zero executions meaningful and
 * prevents a retained iteration from borrowing another item's DATA witness. */
export function savedAggregateSelections(plan:ScenarioResultDisclosurePlan,value:unknown):ReadonlyMap<string,readonly StoredRow[]>{
 const output=new Map<string,readonly StoredRow[]>();
 const limits=aggregateReceiptLimits(plan);
 for(const raw of list(copy(value??[],limits?.maxNodes))){
  const root=object(raw,['loop','parameter','model','row',...(Object.hasOwn(raw as object,'selection')?['selection']:[])]);
  const loop=plan.sourceLoops?.loops.find(loop=>loop.id===root.loop);
  if(loop?.aggregate===undefined){if(Object.hasOwn(root,'selection'))fail('foreign saved aggregate selection.');continue;}
  if(root.parameter!==loop.parameter||root.model!==loop.parentModel||output.has(loop.id))fail('aggregate selection differs from its original parent.');
  const parent=row(root.row),selection=root.selection;
  if(parent.archivedAt!==null||!Array.isArray(selection)||selection.length>loop.maximum)fail('complete finite aggregate item selection required.');
  const selected=(selection as readonly unknown[]).map(value=>row(value)),ids=selected.map(value=>value.id);unique(ids);
  for(const value of selected)if(value.archivedAt!==null||value.parent?.model!==loop.parentModel||value.parent.id!==parent.id)fail('aggregate item differs from its genuine contained parent.');
  const order=loop.aggregate.order[0]??fail('aggregate selection lacks its original order.');
  for(let index=1;index<selected.length;index++){
   const left=selected[index-1]!,right=selected[index]!;
   if(order.field==='created'&&left.created>right.created||(order.field==='id'||left.created===right.created)&&left.id>right.id)fail('aggregate item selection changed its original order.');
  }
  output.set(loop.id,Object.freeze(selected));
 }
 return output;
}

export function checkSavedQueries(plan: ScenarioResultDisclosurePlan,
  returned: ScenarioResultDisclosurePlan['returns'][number], value: unknown, result: unknown, schema?: NormalizedSchema, roots?:ScenarioReceiptAssociation['sourceLoopRoots']): void {
  checkQueryProjection(returned as unknown as Record<string, unknown>, checkQueries(plan.queries ?? []));
  const required = returnQueryIds(returned);
  if (required.length === 0) { if (value !== undefined && list(copy(value)).length !== 0) fail('return has foreign query observations.'); return; }
  const limits=aggregateReceiptLimits(plan);
  const queries = list(copy(value,limits?.maxNodes),limits?.maxQueries);
  const selections=savedAggregateSelections(plan,roots);
  const count=required.reduce((total,id)=>{const query=plan.queries?.find(query=>query.id===id);if(query?.iteration===undefined)return total+1;const selected=selections.get(query.iteration)??fail('repeated query lacks its actual complete item selection.');return total+selected.length;},0);
  if (queries.length !== count) fail('exact selected query associations required, including empty domains.');
  const savedIds: string[] = [],next=new Map<string,number>();
  for (const saved of queries) {
    const observed = object(saved, ['queryId', 'revision', 'candidates', 'selectedIndices',
      ...(typeof saved === 'object' && saved !== null && Object.hasOwn(saved, 'parent') ? ['parent'] : []),
      ...(typeof saved === 'object' && saved !== null && Object.hasOwn(saved,'occurrence')?['occurrence']:[])]);
    const query = plan.queries?.find(query => query.id === observed.queryId && required.includes(query.id)) ?? fail('saved query identity differs.');
    if(query.iteration===undefined){if(Object.hasOwn(observed,'occurrence'))fail('ordinary query has a foreign repeated occurrence.');savedIds.push(query.id);}
    else{
      const occurrence=checkQueryOccurrence(observed.occurrence),selection=selections.get(query.iteration);
      if(occurrence.loop!==query.iteration||selection?.[occurrence.ordinal]===undefined||occurrence.ordinal!==(next.get(query.id)??0))fail('saved query occurrence differs from its actual selected item.');
      next.set(query.id,occurrence.ordinal+1);savedIds.push(`${query.id}:${occurrence.ordinal}`);
    }
    if (observed.queryId !== query.id || !Number.isSafeInteger(observed.revision) || (observed.revision as number) < 0) fail('saved query identity/revision differs.');
    let parentRow: StoredRow | undefined;
    if (query.parent !== undefined) {
      const parent = object(observed.parent, ['model', 'row', 'secretFields']);
      if (parent.model !== query.parent.model) fail('saved parent model differs from checked scope.');
      parentRow = row(parent.row);
      if (parentRow.archivedAt !== null) fail('saved scoped parent is archived.');
      unique(list(parent.secretFields).map(text));
    } else if (Object.hasOwn(observed, 'parent')) fail('unscoped query has a foreign parent witness.');
    const rowMaximum=query.iteration===undefined?MAX:limits!.maxRows;
    const candidates = list(observed.candidates,rowMaximum); const identities: string[] = [];
    const linkedDependencies = queryLinkedReturnDependencies(returned, query);
    for (const value of candidates) {
      const candidate = object(value, ['row', 'record', 'secretFields', 'matched', 'dependencies']);
      const original = row(candidate.row), projected = row(candidate.record, true);
      if (parentRow !== undefined && (original.parent?.model !== query.parent!.model || original.parent.id !== parentRow.id)) fail('saved candidate differs from its parent scope.');
      identities.push(original.id);
      if (typeof candidate.matched !== 'boolean') fail('saved match must be boolean.');
      if (query.archived === 'exclude' && original.archivedAt !== null) fail('saved archive selection differs.');
      const secrets = list(candidate.secretFields).map(text); unique(secrets);
      const metadata = (value: StoredRow) => ({ ...value, parent: value.parent ?? null, data: null });
      if (!same(metadata(original), metadata(projected)) || !subset(projected.data, original.data)) fail('saved projection differs from original scan row.');
      const ids = list(candidate.dependencies).map(text); unique(ids);
      if (ids.some(id => !query.dependencies.some(dep => dep.id === id) &&
          !linkedDependencies.some(dep => dep.id === id))) fail('foreign observed query dependency.');
      for (const dependency of query.dependencies) {
        // State closes actual predicate read/marker correspondence before
        // producing these IDs. Skipped branches have no executed observation;
        // selected projection and engine order remain mandatory separately.
        const required = candidate.matched && (dependency.role === 'data' || query.order.some(term => term.field === dependency.field));
        if (required && !ids.includes(dependency.id)) fail('complete selected data and order observations required.');
        if (!ids.includes(dependency.id)) continue;
        checkDependencyWire(projected as ProjectedRecord, dependency, schema);
      }
    }
    unique(identities);
    const selected = list(observed.selectedIndices,rowMaximum);
    if (selected.some(index => !Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= candidates.length) ||
        new Set(selected).size !== selected.length) fail('unique selected candidate indices required.');
    const selectedSet = new Set(selected as number[]);
    const typed = candidates as unknown as ScenarioReceiptQueryObservation['candidates'];
    if (typed.some((candidate, index) => candidate.matched !== selectedSet.has(index))) fail('selected indices must contain every and only matched candidate.');
    if (query.limit !== null && selected.length > query.limit) fail('saved query overflow.');
    for (let index = 1; index < selected.length; index++) {
      if (compare(typed[selected[index - 1] as number]!, typed[selected[index] as number]!, query) > 0) fail('saved selected order differs from checked query.');
    }
    if (returned.projection !== undefined && !same(copy(result), queryProjectionWire(returned.projection, query, typed, selected as number[]))) fail('saved result differs from actual selected projection.');
  }
  unique(savedIds);
  if(limits!==undefined){
    const expected=required.flatMap(id=>{
      const query=plan.queries!.find(query=>query.id===id)!;
      return query.iteration===undefined?[id]:(selections.get(query.iteration)??fail('missing original aggregate item selection.')).map((_,ordinal)=>`${id}:${ordinal}`);
    });
    if(!same(savedIds,expected))fail('saved aggregate query groups changed their original execution order.');
  }
}

export async function savedQueriesReadable(bound: {
  readonly plan: ScenarioResultDisclosurePlan; readonly type: CanTypeId; readonly valueSchema?: NormalizedSchema | undefined;
  readonly artifactModels: ReadonlyMap<ModelName, ArtifactModel>;
}, association: { readonly plan: ScenarioResultDisclosurePlan; readonly returnId: string; readonly queries?: readonly ScenarioReceiptQueryObservation[];readonly sourceLoopRoots?:ScenarioReceiptAssociation['sourceLoopRoots'] },
result: unknown, savedProjection: (model: ModelName, row: StoredRow, secrets: readonly string[], blocked: readonly string[]) => Promise<ProjectedRecord | null>): Promise<boolean> {
  const returned = association.plan.returns.find(returned => returned.id === association.returnId);
  if (returned === undefined) return false;
  if (returnQueryIds(returned).length === 0) return true;
  try {
    if (!same(bound.plan, association.plan)) return false;
    checkQueryInventory(bound.plan, bound.type, [...bound.artifactModels.values()], bound.valueSchema);
    checkSavedQueries(association.plan, returned, association.queries, result, bound.valueSchema,association.sourceLoopRoots);
    if (returned.projection !== undefined) canonicalWire(bound.type, result, bound.valueSchema);
    for (const observed of association.queries!) {
      const query = bound.plan.queries!.find(query => query.id === observed.queryId)!;
      if (observed.parent !== undefined) {
        const parent = observed.parent;
        const projected = await savedProjection(parent.model, parent.row, parent.secretFields, []);
        // The parent establishes collection identity and current authority;
        // partial business-field grants do not deny that linkage.
        if (projected === null || !same({ ...projected, parent: projected.parent ?? null, data: null },
          { ...parent.row, parent: parent.row.parent ?? null, data: null })) return false;
      }
      for (const candidate of observed.candidates) {
        const projected = await savedProjection(query.model, candidate.row, candidate.secretFields, []);
        if (projected === null || projected.id !== candidate.row.id || projected.version !== candidate.row.version) return false;
        for (const dependency of query.dependencies) {
          if (!candidate.dependencies.includes(dependency.id)) continue;
          if (!same(checkDependencyWire(projected, dependency, bound.valueSchema),
            dependencyWire(candidate.record, dependency))) return false;
        }
      }
    }
    return true;
  } catch (error) { if (error instanceof StateError) return false; throw error; }
}
