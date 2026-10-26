/** Closed persisted scenario decoding. Installed source budgets are selected
 * by the receipt owner; this module cannot issue live observations or authority. */
import type { CanTypeId, FinalizedFileReceiver, ModelName, Receipt, RecordId, ScenarioReceiptAssociation, ScenarioReceiptQueryObservation, ScenarioResultDisclosurePlan, StoredRow } from '@canlang/contracts';
import { decodeValue, encodeValue, parseTypeId, printTypeId } from '@canlang/values';
import { deepFreeze, getDataPath } from '../internal/own-data.js';
import { stableStringify } from './replay.js';
import { MAX_ITEMS, invalid, dataCopy, object, text, list, scalarType, checkScenarioResultDisclosurePlan } from './scenario-plan.js';
import { disclosureType, checkSavedQueries, returnQueryIds, checkQueryOccurrence, savedAggregateSelections, aggregateReceiptLimits, type AggregateReceiptLimits } from './scenario-query-plan.js';
import { checkRetainedScenarioFile } from './scenario-file-assignment.js';
import { storedNominalType, savedNominalWire } from './scenario-stored-value.js';

type DependencyObservation = ScenarioReceiptAssociation['observations'][number];

/** Only the owning receipt module supplies these installed-source decisions.
 * Keep them lazy: data allowance precedes copying, while the changed-row
 * allowance is checked after the saved observations, at its original point. */
interface SavedScenarioReceiptBudgets {
  readonly dataBudget: (receipt: Receipt) => number;
  readonly changedMaximum: (receipt: Receipt) => number | undefined;
  readonly aggregateLimits?: (receipt: Receipt) => AggregateReceiptLimits | undefined;
}

function receiptList(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid('saved receipt exceeds its installed source census.');
  return value;
}

export function decodeScenarioReceiptAssociation(receipt: Receipt,
  budgets: SavedScenarioReceiptBudgets): ScenarioReceiptAssociation | null {
  return readSavedScenarioAssociation(receipt, undefined, budgets);
}

function paths(value: unknown): string[] {
  const fields = list(value).map(text);
  if (new Set(fields).size !== fields.length || fields.some(field => field.split('.').some(part => part === ''))) {
    return invalid('unique field paths required.');
  }
  return fields;
}

export function savedDependencyWire(type: CanTypeId, wire: unknown): void {
  if (type === 'file' || type === 'file?' || type === 'file[]') { savedFileRefs(type, wire); return; }
  try { scalarType(type); }
  catch { savedNominalWire(type, wire); return; }
  scalarWire(type, wire);
}

export function dependencyObservedWire(dependency: ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number], row: StoredRow): unknown {
  if (dependency.field === 'id' && dependency.type === 'text') return row.id;
  // Only a nominal, singular parent dependency reads containment metadata.
  // The privately bound profile still proves the actual declaration later.
  const type = parseTypeId(dependency.type);
  if (dependency.field === 'parent' && type.base.kind === 'nominal' && !type.array && !type.nullable) {
    const parent = object(row.parent, ['model', 'id']);
    if (parent['model'] !== type.base.path) return invalid('saved parent differs from its declared containment.');
    return { id: text(parent['id']) };
  }
  return getDataPath(row.data, dependency.field);
}

export function scalarWire(type: CanTypeId, value: unknown): void {
  if (type === 'void') { if (value !== null) invalid('void receipt result must be null.'); return; }
  try { decodeValue(type, value); } catch { invalid(`invalid saved ${type} wire value.`); }
}

/** Candidate syntax is never enough: binding also checks both owning model
 * inventories and the value namespace; saved decoding needs a committed row. */
export function modelResultType(type: unknown): ModelName | undefined {
  if (typeof type !== 'string') return undefined;
  try {
    const parsed = parseTypeId(type);
    return printTypeId(parsed) === type && parsed.base.kind === 'nominal' && parsed.base.path.includes('.') &&
      !parsed.array && !parsed.nullable && !parsed.requiredArray ? type as ModelName : undefined;
  } catch { return undefined; }
}

export function modelResultWire(result: unknown): RecordId {
  return text(object(result, ['id'])['id']) as RecordId;
}

export function fileReceiver(app: string, actor: string | null, team: string | null): FinalizedFileReceiver {
  if (actor === null) return invalid('File receiving identity requires an admitted actor.');
  return Object.freeze({ app, team: team ?? actor, owner: team ?? actor, principal: actor });
}

/** Finite source-copy budgets compose actual checked child plans. The caller
 * SET aliases the child's created result; it adds no second row identity. */
export function sourceCopyLimits(plan:ScenarioResultDisclosurePlan,children:readonly {
  readonly name:string;readonly result:string|undefined;readonly plan:ScenarioResultDisclosurePlan;
}[]):{readonly maxRows:number;readonly maxWork:number;readonly maxWrites:number}|undefined{
  const own=plan.sourceLoops;
  if(own===undefined||!own.loops.some(loop=>loop.copy!==undefined))return undefined;
  const [copyLoop]=own.loops,copy=copyLoop?.copy;
  if(own.loops.length!==1||copyLoop===undefined||copy===undefined||children.length!==1)return invalid('Source copy budget requires its exact sole constructor loop and child.');
  const [child]=children,loops=child?.plan.sourceLoops;
  const [updated]=loops?.loops??[];
  if(child===undefined||child.name!==copy.target||child.result!==copyLoop.parentModel||loops?.owner!==child.name
      ||loops.loops.length!==1||updated===undefined||updated.copy!==undefined||updated.model!==copyLoop.parentModel){
    return invalid('Source copy budget lacks its complete original update/create child.');
  }
  const repeated=copyLoop.maximum+updated.maximum;
  return Object.freeze({maxRows:MAX_ITEMS+repeated,maxWork:(MAX_ITEMS+repeated)*MAX_ITEMS*2,maxWrites:repeated+2});
}

function checkSavedLinkedDependencies(plan:ScenarioResultDisclosurePlan,returned: ScenarioResultDisclosurePlan['returns'][number],
  observations: readonly DependencyObservation[], queries: readonly ScenarioReceiptQueryObservation[],roots:ScenarioReceiptAssociation['sourceLoopRoots']): void {
  const selections=savedAggregateSelections(plan,roots);
  const occurrenceKey=(value:DependencyObservation['occurrence'])=>value===undefined?'ordinary':`${value.loop}:${value.ordinal}`;
  for (const dependency of returned.dependencies) {
    const actual = observations.filter(observation => observation.dependencyId === dependency.id);
    if (dependency.queryId === undefined) {
      const loop=plan.sourceLoops?.loops.find(loop=>loop.aggregate?.dependencies.includes(dependency.id));
      if(loop===undefined){if(actual.length===0||actual.some(value=>value.occurrence!==undefined))return invalid('missing or foreign saved dependency.');}
      else{
        const selected=selections.get(loop.id);if(selected===undefined||actual.length!==selected.length)return invalid('saved item DATA omitted its complete original selection.');
        for(const [ordinal,row]of selected.entries())if(actual.filter(value=>value.occurrence?.loop===loop.id&&value.occurrence.ordinal===ordinal&&value.model===loop.model&&value.row.id===row.id&&value.row.created===row.created&&value.row.createdBy===row.createdBy&&stableStringify(value.row.parent)===stableStringify(row.parent)).length!==1)return invalid('saved item DATA differs from its genuine original occurrence.');
      }
      continue;
    }
    const executed=queries.filter(query=>query.queryId===dependency.queryId),queryPlan=plan.queries?.find(query=>query.id===dependency.queryId);
    if(queryPlan===undefined||!returnQueryIds(returned).includes(queryPlan.id))return invalid('missing saved candidate-only query.');
    if(queryPlan.iteration===undefined&&executed.length!==1)return invalid('one actual saved ordinary query required.');
    const occurrences=new Map<string,DependencyObservation[]>();
    for(const observed of actual){const key=occurrenceKey(observed.occurrence),group=occurrences.get(key);if(group===undefined)occurrences.set(key,[observed]);else group.push(observed);}
    let total=0;
    for(const query of executed){
      if(dependency.role==='data'&&query.candidates.some(candidate=>candidate.dependencies.includes(dependency.id)!==candidate.matched))return invalid('saved selected DATA must match every and only selected candidate.');
      const candidates=query.candidates.filter(candidate=>candidate.dependencies.includes(dependency.id)),matching=occurrences.get(occurrenceKey(query.occurrence))??[];
      if(matching.length!==candidates.length)return invalid('saved query candidates differ from their retained ordinary observations.');
      if(queryPlan.iteration!==undefined){
        const rows=new Map<string,number>();
        for(const observed of matching){const key=`${observed.model}:${stableStringify(observed.row)}`;rows.set(key,(rows.get(key)??0)+1);}
        if(candidates.some(candidate=>rows.get(`${queryPlan.model}:${stableStringify(candidate.row)}`)!==1))return invalid('saved query DATA borrowed another item occurrence.');
      }
      total+=matching.length;
    }
    if(total!==actual.length)return invalid('saved query DATA has a foreign item occurrence.');
  }
}

export function modelResultObservedRow(returned: ScenarioResultDisclosurePlan['returns'][number],
  observations: ScenarioReceiptAssociation['observations'], model: ModelName, id: RecordId): StoredRow | undefined {
  const identities = new Set(returned.dependencies.filter(dependency => dependency.role === 'data' &&
    dependency.model === model && dependency.field === 'id' && dependency.type === 'text').map(dependency => dependency.id));
  return observations.find(observation => identities.has(observation.dependencyId) && observation.model === model &&
    observation.row.id === id && observation.row.archivedAt === null)?.row;
}

/** Saved form of the replay lifetime above: the retained influence-linked
 * query's actually selected candidate row, still present and unarchived.
 * Current grants are rechecked by the saved projection, never here. */
export function firstSelectedSavedRow(plan: ScenarioResultDisclosurePlan,
  returned: ScenarioResultDisclosurePlan['returns'][number],
  queries: readonly ScenarioReceiptQueryObservation[],
  model: string, id: RecordId): StoredRow | undefined {
  for (const queryId of returnQueryIds(returned)) {
    if (plan.queries?.find(query => query.id === queryId)?.model !== model) continue;
    const saved = queries.find(query => query.queryId === queryId);
    if (saved === undefined) continue;
    const selected = saved.selectedIndices[0];
    const candidate = selected === undefined ? undefined : saved.candidates[selected];
    if (candidate === undefined || candidate.row.id !== id || candidate.row.archivedAt !== null) continue;
    return candidate.row;
  }
  return undefined;
}

export function checkedRow(value: unknown): StoredRow {
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

/** Saved type association closes nullable/array wire shapes before any current
 * declaration or physical Files authority is consulted. */
function savedFileRefs(type: CanTypeId, wire: unknown): readonly string[] {
  if (!/^file(\[\])?\??$/.test(type)) return invalid('saved owning File type required.');
  if (wire === null) return type.endsWith('?') ? [] : invalid('nonnullable saved File field.');
  const values = type.includes('[]') ? list(wire) : [wire];
  return values.map(value => text(object(value, ['id'])['id']));
}

export function isAssignmentType(type: unknown): type is CanTypeId {
  if (typeof type !== 'string') return false;
  if (/^file(\[\])?\??$/.test(type)) return true;
  try { storedNominalType(type); return true; } catch { return false; }
}

/** Nominal persistence establishes whole syntax only. Its refs require the
 * genuine current owning schema, never a schema-free JSON traversal. */
function savedAssignmentRefs(type: CanTypeId, wire: unknown): readonly string[] | null {
  if (/^file(\[\])?\??$/.test(type)) return savedFileRefs(type, wire);
  savedNominalWire(type, wire); return null;
}

function readSavedScenarioAssociation(receipt: Receipt,
  enclosingChanges?: ScenarioReceiptAssociation['changed'],budgets?: SavedScenarioReceiptBudgets): ScenarioReceiptAssociation | null {
  const dataBudget=budgets?.dataBudget(receipt)??20_000;
  receipt = dataCopy(receipt,false,dataBudget);
  if (!Object.hasOwn(receipt.outcome, 'scenario')) return null;
  if (receipt.outcome.status !== 'committed') return invalid('association requires a committed outcome.');
  const scenario = dataCopy(receipt.outcome.scenario,false,dataBudget);
  const value = object(scenario, ['kind', 'plan', 'resultType', 'returnId', 'observations', 'changed',
    ...(typeof scenario === 'object' && scenario !== null && Object.hasOwn(scenario, 'fileAssignments') ? ['fileAssignments'] : []),
    ...(typeof scenario === 'object' && scenario !== null && Object.hasOwn(scenario, 'calls') ? ['calls'] : []),
    ...(typeof scenario === 'object' && scenario !== null && Object.hasOwn(scenario, 'intrinsics') ? ['intrinsics'] : []),
    ...(typeof scenario === 'object' && scenario !== null && Object.hasOwn(scenario, 'queries') ? ['queries'] : []),
    ...(typeof scenario === 'object' && scenario !== null && Object.hasOwn(scenario, 'sourceLoopRoots') ? ['sourceLoopRoots'] : [])]);
  if (value['kind'] !== 'scenario-result/v1') return invalid('unknown association version.');
  const plan = checkScenarioResultDisclosurePlan(value['plan']), resultModel = modelResultType(value['resultType']);
  const installedLimits=budgets?.aggregateLimits?.(receipt), planLimits=aggregateReceiptLimits(plan);
  if(planLimits===undefined?installedLimits!==undefined:(installedLimits===undefined||stableStringify(installedLimits)!==stableStringify(planLimits)||dataBudget<planLimits.maxNodes)){
    return invalid('Aggregate receipt budgets require their current independently bound original producer.');
  }
  const resultType = resultModel === undefined ? disclosureType(value['resultType'], plan) : resultModel as CanTypeId;
  const returned = plan.returns.find(entry => entry.id === value['returnId']);
  if (returned === undefined) return invalid('unknown selected return path.');
  if (resultModel !== undefined) {
    if (plan.returns.some(returned => returned.projection !== undefined)) return invalid('saved model result requires its singular source profile.');
    modelResultWire(receipt.outcome.result);
    checkSavedQueries(plan, returned, value['queries'], receipt.outcome.result,undefined,value['sourceLoopRoots']as ScenarioReceiptAssociation['sourceLoopRoots']);
  } else if (returned.projection === undefined) {
    // Same pure-control profile as registration: no stored reads, or only
    // stored CONTROL-role decision reads, means the influences are execution
    // gating only (admitted intrinsics are recorded replay-stable inputs),
    // and the saved queries below revalidate the gating snapshot. Void
    // results carry no value to shape (the wire demands null), so the
    // demand applies only to value-bearing returns, mirroring registration.
    if (resultType !== 'void' && returned.influences.length !== 0 && !returned.dependencies.every(dependency => dependency.role === 'control'))
      return invalid('saved scalar query influences require their defining profile.');
    scalarWire(resultType, receipt.outcome.result); checkSavedQueries(plan, returned, value['queries'], receipt.outcome.result,undefined,value['sourceLoopRoots']as ScenarioReceiptAssociation['sourceLoopRoots']); }
  else checkSavedQueries(plan, returned, value['queries'], receipt.outcome.result,undefined,value['sourceLoopRoots']as ScenarioReceiptAssociation['sourceLoopRoots']);
  const observations = receiptList(value['observations'],installedLimits?.maxObservations??MAX_ITEMS);
  for (const entry of observations) {
    const observation = object(entry, ['dependencyId', 'model', 'row', 'secretFields',
      ...(typeof entry === 'object' && entry !== null && Object.hasOwn(entry, 'files') ? ['files'] : []),...(typeof entry==='object'&&entry!==null&&Object.hasOwn(entry,'occurrence')?['occurrence']:[])]);
    const dependency = returned.dependencies.find(dep => dep.id === observation['dependencyId']);
    if (dependency === undefined || dependency.model !== observation['model']) return invalid('foreign saved dependency.');
    if(Object.hasOwn(observation,'occurrence'))checkQueryOccurrence(observation['occurrence']);
    const row = checkedRow(observation['row']), wire = dependencyObservedWire(dependency, row);
    const query = dependency.queryId === undefined ? undefined : plan.queries?.find(query => query.id === dependency.queryId);
    const messageRole = dependency.role === 'data' && dependency.field === 'role' &&
      (dependency.type === 'TextMessage.role' || dependency.type === 'std.TextMessage.role') &&
      query?.model === dependency.model && stableStringify(query.source) === stableStringify(dependency.source) &&
      query.dependencies.some(entry => entry.role === 'data' && entry.field === dependency.field && entry.type === dependency.type &&
        stableStringify(entry.source) === stableStringify(dependency.source)) &&
      (wire === 'system' || wire === 'user' || wire === 'assistant');
    if (!messageRole) savedDependencyWire(dependency.type, wire);
    paths(observation['secretFields']);
    const fileDependency = dependency.type === 'file' || dependency.type === 'file?' || dependency.type === 'file[]';
    if (fileDependency || Object.hasOwn(observation, 'files')) {
      const refs = fileDependency ? new Set(savedFileRefs(dependency.type, dependencyObservedWire(dependency, row))) : null;
      if (refs === null) savedNominalWire(dependency.type, dependencyObservedWire(dependency, row));
      const files = list(observation['files']).map(checkRetainedScenarioFile);
      if (new Set(files.map(file => file.ref)).size !== files.length || refs !== null &&
          (files.length !== refs.size || files.some(file => !refs.has(file.ref)))) {
        return invalid('saved stored File dependency omitted its exact distinct File census.');
      }
      for (const file of files) {
        const expected = fileReceiver(receipt.identity.app, receipt.identity.principal === 'public' ? null : receipt.identity.principal,
          file.receiver.team === receipt.identity.principal && receipt.identity.owner === 'app' ? null : receipt.identity.owner);
        if (stableStringify(file.receiver) !== stableStringify(expected)) return invalid('stored File dependency receiver differs from its receipt.');
      }
    }
  }
  checkSavedLinkedDependencies(plan,returned, observations as DependencyObservation[],
    (value['queries'] ?? []) as ScenarioReceiptQueryObservation[],value['sourceLoopRoots']as ScenarioReceiptAssociation['sourceLoopRoots']);
  for (const saved of (value['queries'] ?? []) as readonly ScenarioReceiptQueryObservation[]) {
    const query = plan.queries!.find(query => query.id === saved.queryId)!;
    if (query.parent?.origin.kind !== 'stored-reference') continue;
    const dependencyId = query.parent.origin.dependencyId;
    const dependency = returned.dependencies.find(dependency => dependency.id === dependencyId);
    const selected = observations.filter(entry => (entry as DependencyObservation).dependencyId === dependencyId) as DependencyObservation[];
    if (dependency === undefined || selected.length !== 1 || saved.parent === undefined || dependency.type !== saved.parent.model ||
        stableStringify(dependencyObservedWire(dependency, selected[0]!.row)) !== stableStringify({ id: saved.parent.row.id })) {
      return invalid('saved query parent differs from its original stored reference observation.');
    }
  }
  const intrinsics = list(Object.hasOwn(value, 'intrinsics') ? value['intrinsics'] : []);
  if (observations.length + intrinsics.length > (installedLimits?.maxObservations??MAX_ITEMS) ||
      observations.filter(entry=>!Object.hasOwn(entry as object,'occurrence')).length+intrinsics.length>MAX_ITEMS) return invalid('observation budget exceeded.');
  for (const entry of intrinsics) {
    const kind = (entry as Record<string, unknown>)?.['kind'];
    const observation = object(entry, ['dependencyId', 'kind', 'wire',
      ...(kind === 'created-model-version'?['model','row','secretFields','stage']:kind === 'admitted-reference-version' ? ['model', 'row', 'secretFields'] : [])]);
    const dependency = returned.intrinsics?.find(dep => dep.id === observation['dependencyId']);
    if (dependency === undefined || dependency.kind !== kind) return invalid('foreign saved intrinsic.');
    scalarWire(dependency.type, observation['wire']);
    if (kind === 'operation-id') {
      if (observation['wire'] !== receipt.identity.operationId) return invalid('saved intrinsic identity differs from its receipt.');
    } else if (kind === 'admitted-input') {
      if (stableStringify(encodeValue(dependency.type, decodeValue(dependency.type, observation['wire']))) !==
          stableStringify(observation['wire'])) return invalid('invalid saved canonical input wire.');
    } else if(kind==='created-model-version'){
      const row=checkedRow(observation['row']);paths(observation['secretFields']);
      if(dependency.kind!=='created-model-version'||dependency.created.model!==observation['model']
          ||!Number.isSafeInteger(observation['stage'])||Number(observation['stage'])<=dependency.created.stage
          ||row.archivedAt!==null||row.parent?.model!==dependency.created.parentModel
          ||observation['wire']!==String(row.version)
          ||!list(value['changed']).some(raw=>{const change=raw as Record<string,unknown>;if(change['model']!==observation['model'])return false;const created=checkedRow(change['row']);return created.id===row.id&&created.created===row.created&&created.createdBy===row.createdBy&&stableStringify(created.parent)===stableStringify(row.parent);}))return invalid('invalid saved original created version.');
    } else {
      const row = checkedRow(observation['row']); paths(observation['secretFields']);
      if (dependency.kind !== 'admitted-reference-version' || dependency.model !== observation['model'] ||
          row.archivedAt !== null || observation['wire'] !== String(row.version)) return invalid('invalid saved original reference version.');
    }
  }
  if (returned.intrinsics?.some(dep => !intrinsics.some(entry => (entry as Record<string, unknown>)['dependencyId'] === dep.id))) {
    return invalid('missing saved intrinsic.');
  }
  let changedMaximum=budgets?.changedMaximum(receipt)??MAX_ITEMS;
  if(plan.sourceLoops?.loops.some(loop=>loop.copy!==undefined)){
    const children=list(value['calls']??[]).map(entry=>{
      const saved=entry as Record<string,unknown>,scenario=saved['scenario'] as Record<string,unknown>|undefined;
      if(scenario===undefined)return invalid('Saved source copy lacks its original child scenario receipt.');
      const childPlan=checkScenarioResultDisclosurePlan(scenario['plan']);
      return {name:text(saved['target']),result:text(scenario['resultType']),plan:childPlan};
    });
    changedMaximum=sourceCopyLimits(plan,children)!.maxWrites;
  }
  if(!Array.isArray(value['changed'])||value['changed'].length>changedMaximum)return invalid('changed snapshot exceeds its original source budget.');
  const roots=list(value['sourceLoopRoots']??[]).map(raw=>{
    const root=object(raw,['loop','parameter','model','row',...(typeof raw==='object'&&raw!==null&&Object.hasOwn(raw,'selection')?['selection']:[])]),loop=plan.sourceLoops?.loops.find(loop=>loop.id===root['loop']);
    const row=checkedRow(root['row']);
    if((loop?.copy===undefined&&loop?.aggregate===undefined)||loop===undefined||root['parameter']!==loop.parameter||root['model']!==loop.parentModel||row.archivedAt!==null){
      return invalid('Saved source loop root differs from its original admitted parameter census.');
    }
    return {loop:loop.id,model:loop.parentModel,row};
  });
  if(new Set(roots.map(root=>root.loop)).size!==roots.length)return invalid('Duplicate original source loop root.');
  savedAggregateSelections(plan,value['sourceLoopRoots']);
  const changed = value['changed'] as unknown[]; const identities = new Set<string>(),copySources=new Set<string>(); let fileFieldCount = 0;
  for (const entry of changed) {
    const change = object(entry, ['model', 'row', 'secretFields', 'withheldFields', 'fieldTypes',
      ...(Object.hasOwn(entry as object,'sourceCopy')?['sourceCopy']:[])]); text(change['model']);
    const row = checkedRow(change['row']); paths(change['secretFields']); paths(change['withheldFields']);
    const types = change['fieldTypes'];
    if (typeof types !== 'object' || types === null || Array.isArray(types) || Object.keys(types).length > MAX_ITEMS) return invalid('bounded original field inventory required.');
    for (const [field, type] of Object.entries(types)) {
      if (isAssignmentType(type)) {
        if (++fileFieldCount > MAX_ITEMS) return invalid('saved File field budget exceeded.');
        if (!Object.hasOwn(value, 'fileAssignments') || !Object.hasOwn(row.data, field) ||
            (change['withheldFields'] as string[]).includes(field)) return invalid('saved File field omitted its checked assignment closure.');
        savedAssignmentRefs(type, row.data[field]);
      } else if (type !== null) scalarType(type);
    }
    if(Object.hasOwn(change,'sourceCopy')){
      const saved=object(change['sourceCopy'],['loop','row']),loop=plan.sourceLoops?.loops.find(loop=>loop.id===saved['loop']),copy=loop?.copy;
      const source=checkedRow(saved['row']),root=roots.find(root=>root.loop===saved['loop']);
      const sourceKey=stableStringify([saved['loop'],source.id]);
      const child=(value['calls'] as ScenarioReceiptAssociation['calls'])?.find(child=>child.target===copy?.target&&child.caller===plan.sourceLoops?.owner);
      if(copy===undefined||copy.model!==change['model']||source.archivedAt!==null||source.parent?.model!==loop!.parentModel
          ||root===undefined||source.parent?.id!==root.row.id||source.id===row.id||child===undefined||row.parent?.model!==loop!.parentModel||row.parent.id!==modelResultWire(child.result)
          ||copySources.has(sourceKey)||copySources.size>=loop!.maximum||copy.fields.some(field=>!Object.hasOwn(source.data,field.name)
            ||stableStringify(source.data[field.name])!==stableStringify(row.data[field.name])
            ||(types as Record<string,unknown>)[field.name]!==field.type))return invalid('Saved copy differs from its original field/target census.');
      for(const field of copy.fields)scalarWire(field.type as CanTypeId,source.data[field.name]);
      copySources.add(sourceKey);
    }else if(plan.sourceLoops?.loops.some(loop=>loop.copy?.model===change['model']))return invalid('Saved copied Item omitted its original source DATA association.');
    const key = `${change['model']}/${row.id}`;
    if (identities.has(key) || !receipt.outcome.recordVersions.some(version => version.model === change['model'] &&
        version.id === row.id && version.version === row.version)) return invalid('changed snapshot disagrees with committed identities.');
    identities.add(key);
  }
  if (changed.length !== receipt.outcome.recordVersions.length) return invalid('incomplete committed changed snapshots.');
  const witnesses = enclosingChanges ?? changed as ScenarioReceiptAssociation['changed'];
  if (resultModel !== undefined) {
    const id = modelResultWire(receipt.outcome.result);
    const matches = witnesses.filter(change => change.model === resultModel && change.row.id === id);
    const observed = modelResultObservedRow(returned, observations as ScenarioReceiptAssociation['observations'], resultModel, id) ??
      firstSelectedSavedRow(plan, returned, (value['queries'] ?? []) as ScenarioReceiptQueryObservation[], resultModel, id);
    if (matches.length > 0 ? matches.length !== 1 || matches[0]!.row.archivedAt !== null : observed === undefined) {
      return invalid('saved model result lacks its enclosing surviving committed row.');
    }
  }
  const assignments = list(value['fileAssignments'] ?? []); const assignmentKeys = new Set<string>();
  for (const raw of assignments) {
    const assignment = object(raw, ['model', 'recordId', 'rowVersion', 'field', 'file']);
    const model = text(assignment['model']), id = text(assignment['recordId']), field = text(assignment['field']);
    const file = checkRetainedScenarioFile(assignment['file']);
    const change = changed.find(entry => (entry as Record<string, unknown>)['model'] === model &&
      ((entry as Record<string, unknown>)['row'] as StoredRow).id === id) as ScenarioReceiptAssociation['changed'][number] | undefined;
    const type = change?.fieldTypes[field];
    if (change === undefined || assignment['rowVersion'] !== change.row.version || !isAssignmentType(type) ||
        !Object.hasOwn(change.row.data, field) || change.withheldFields.includes(field) ||
        savedAssignmentRefs(type, change.row.data[field])?.includes(file.ref) === false) {
      return invalid('saved File assignment differs from its committed owning field.');
    }
    const expected = fileReceiver(receipt.identity.app, receipt.identity.principal === 'public' ? null : receipt.identity.principal,
      file.receiver.team === receipt.identity.principal && receipt.identity.owner === 'app' ? null : receipt.identity.owner);
    if (stableStringify(file.receiver) !== stableStringify(expected)) return invalid('saved File receiver differs from its receipt.');
    const key = stableStringify([model, id, field, file.ref]);
    if (assignmentKeys.has(key)) return invalid('duplicate saved File assignment.'); assignmentKeys.add(key);
  }
  for (const raw of changed) {
    const change = raw as ScenarioReceiptAssociation['changed'][number];
    for (const [field, type] of Object.entries(change.fieldTypes)) if (typeof type === 'string' && /^file(\[\])?\??$/.test(type)) {
      for (const ref of new Set(savedFileRefs(type as CanTypeId, change.row.data[field]))) {
        if (!assignmentKeys.has(stableStringify([change.model, change.row.id, field, ref]))) return invalid('incomplete saved File assignment closure.');
      }
    }
  }
  for (const entry of list(value['calls'] ?? [])) {
    const saved = object(entry, ['site', 'caller', 'target', 'targetInterface', 'references', 'result',
      ...(typeof entry === 'object' && entry !== null && Object.hasOwn(entry, 'scenario') ? ['scenario'] : [])]);
    text(saved['site']); text(saved['caller']); text(saved['target']); text(saved['targetInterface']);
    for (const reference of list(saved['references'])) {
      const ref = object(reference, ['model', 'row', 'secretFields']); text(ref['model']); checkedRow(ref['row']); paths(ref['secretFields']);
    }
    if (saved['scenario'] !== undefined) {
      const child = object(saved['scenario'], ['kind', 'plan', 'resultType', 'returnId', 'observations',
        ...(Object.hasOwn(saved['scenario'] as object, 'intrinsics') ? ['intrinsics'] : []),
        ...(Object.hasOwn(saved['scenario'] as object, 'queries') ? ['queries'] : []),
        ...(Object.hasOwn(saved['scenario'] as object, 'sourceLoopRoots') ? ['sourceLoopRoots'] : [])]);
      readSavedScenarioAssociation({ ...receipt, identity: { ...receipt.identity, operation: saved['target'] as Receipt['identity']['operation'] },
        outcome: { status: 'committed', result: saved['result'], recordVersions: [],
          scenario: { ...child, changed: [] } as unknown as ScenarioReceiptAssociation } }, witnesses,budgets);
    }
  }
  return deepFreeze(value as unknown as ScenarioReceiptAssociation);
}
