/** State's finite source-installed predicate receiver. This hand-built source
 * producer does not qualify Compiler/CF factory or imported-helper sealing. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, ModelName, Receipt, StoredRow } from '@canlang/contracts';
import { makeUserRef } from '@canlang/values';
import type { ScenarioReceiptMembershipSite } from '../../src/invocation/scenario-membership-plan.js';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { StateError } from '../../src/errors.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { buildModelTableFromCanonical } from '../../src/mutation/models.js';
import { buildPolicyTable } from '../../src/policy/grants.js';
import { readRecordsAtSourceObservation, type ViewerSourceReadPolicy } from '../../src/query/source-policy.js';
import type { AdmittedCall } from '../../src/invocation/admission.js';
import { invoke } from '../../src/invocation/invoke.js';
import { loadArtifactDescriptors, isGeneratedOperationDef, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { beginScenarioReceiptMutation, bindScenarioReceiptReferenceProducer, bindScenarioReceiptQueryProducer, executeScenarioReceiptAny,
  observeScenarioReceiptQueryDependency, bindScenarioReceiptModelResult, selectScenarioReceiptReturn,
  readScenarioReceiptAssociation, projectScenarioReceipt, bindScenarioReceiptMembershipProducer,
  evaluateScenarioReceiptMembership, type ScenarioReceiptAnyPredicate } from '../../src/invocation/scenario-receipt.js';
import { bindScenarioQueryAny, checkSavedScenarioQueryAny } from '../../src/invocation/scenario-query-any.js';
import { asId, asModel, FIXED_NOW, makeBatch, makeEnvelope, makeIdentity, makeRow, uuidv7 } from './fixtures.js';

const EMPLOYEE = asModel('Predicate.Employee'), LOCATION = asModel('Predicate.Location'), RESULT = asModel('Predicate.Result');
const APP = 'predicate-any', OP = 'Predicate.check', QUERY = 'work-query';
const source = { path: 'predicate.can', module: 'predicate.mjs', sha256: 'a'.repeat(64) };
const controls = [ ['user', 'user'], ['active', 'bool'], ['operator_wide', 'bool'], ['home', LOCATION], ['locations', `${LOCATION}[]`] ] as const;
const dependencyIds = controls.map(([name]) => `control-${name}`);
const metadata = { kind: 'predicate' as const, queryId: QUERY, dependencyIds };
const helper = { path: 'helper.can', module: 'helper.mjs', sha256: 'b'.repeat(64) };
const frame = { source, node: { start: 1, end: 9 }, derive: 'Helper.can_work' };
const sites: readonly ScenarioReceiptMembershipSite[] = [{ version: 1, source, owner: OP,
  node: { start: 1, end: 9 }, statement: { start: 0, end: 10 }, stage: 'leading-require', position: [{ kind: 'guard', index: 0 }], calls: [
    { source, node: frame.node, target: { kind: 'derive', name: frame.derive },
      arguments: [{ node: { start: 2, end: 3 }, type: 'user' }], slots: [0], defaults: [], chain: [] },
    { source: helper, node: { start: 10, end: 90 }, target: { kind: 'builtin', id: 'any', overload: 0 },
      arguments: [{ node: { start: 11, end: 20 }, type: `${EMPLOYEE}[]` }, { node: { start: 21, end: 89 }, type: 'bool' }],
      slots: [0, 1], defaults: [], chain: [frame] },
    { source: helper, node: { start: 30, end: 40 }, target: { kind: 'builtin', id: 'active_member', overload: 0 },
      arguments: [{ node: { start: 31, end: 32 }, type: 'user' }, { node: { start: 33, end: 34 }, type: 'Team' }],
      slots: [0, 1], defaults: [], chain: [frame] },
  ] }];
const importedMetadata = { ...metadata, sourceCall: { siteIndex: 0, callIndex: 1 } };
type Association = 'valid' | 'missing-owner' | 'missing-capture' | 'site-index' | 'call-index' | 'path' | 'hash' | 'module' | 'chain' | 'slots' | 'domain' | 'stage';
let sequence = 160000;
type Mode = 'normal' | 'wrong-pointer' | 'copied-call' | 'foreign-store' | 'wrong-query' | 'closed' | 'repeat' | 'missing-marker' | 'wrong-first' | 'failure' | 'skip';
async function world(allFalse = false, corruption?: 'source' | 'census' | 'type' | 'import', denySuffix = true, association?: Association, nativeUser = false, controlDomain = false, guardOnly = false, bodyRequire = false) {
  const dependencies = controls.map(([field, type], index) => ({ id: dependencyIds[index]!, source, role: 'control' as const, field, type: type as CanTypeId }));
  const slice: ArtifactDescriptorSlice = { artifact_version: 1, sources: [{ path: source.path, sha256: source.sha256 }],
    modules: [{ path: source.module, js: 'export const identity="Predicate.check";', map: { version: 3, file: source.module,
      sources: [source.path], sourcesContent: [null], names: [], mappings: '' } }],
    callables: [{ id: OP, kind: 'operation', module: source.module, export: 'identity', member: ['check'] }],
    valueTypes: { contracts: [] }, models: [
      { name: EMPLOYEE, deleteMode: controlDomain ? 'remove' : 'archive', fields: controls.map(([name, type]) => ({ name, valueType: type as CanTypeId,
        field: name === 'user' ? { kind: 'user' as const } : name === 'home' || name === 'locations'
          ? { kind: 'ref' as const, model: LOCATION } : { kind: 'boolean' as const },
        ...(name === 'locations' ? { array: { required: false } } : {}), required: true, serverOnly: false })) },
      { name: LOCATION, deleteMode: 'archive', fields: [] },
      { name: RESULT, deleteMode: 'archive', fields: [{ name: 'allowed', field: { kind: 'boolean' }, valueType: 'bool' as CanTypeId, required: true, serverOnly: false }] },
    ], operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [] }, result: { type: RESULT as CanTypeId,
      disclosure: { version: 1, source, queries: [{ id: QUERY, source, model: EMPLOYEE, order: [], limit: null, archived: 'exclude', dependencies }],
        returns: [{ id: 'result', source, dependencies: [], influences: (['query-existence', 'query-cardinality', 'query-membership', 'query-order'] as const)
          .map(kind => ({ id: kind, kind, queryId: QUERY })) }] } } }] };
  if (guardOnly) Object.assign(slice.operations![0]!.result!.disclosure!.returns[0]!, { influences: [] });
  if (nativeUser) delete (slice.models![0]!.fields[0] as { valueType?: CanTypeId }).valueType;
  if (corruption === 'import' || association !== undefined) {
    const imported = { ...helper, module: source.module,
      ...(association === 'path' ? { path: 'foreign.can' } : {}),
      ...(association === 'hash' ? { sha256: 'c'.repeat(64) } : {}),
      ...(association === 'module' ? { module: helper.module } : {}) };
    Object.assign(slice, { sources: [...slice.sources!, { path: imported.path, sha256: imported.sha256 }],
      modules: [...slice.modules!, { path: helper.module, js: 'export const helper=true;', map: { version: 3,
        file: helper.module, sources: [imported.path], sourcesContent: [null], names: [], mappings: '' } }] });
    Object.assign(slice.operations![0]!.result!.disclosure!.queries![0]!, { source: imported,
      dependencies: dependencies.map(dependency => ({ ...dependency, source: imported })) });
  }
  if (corruption === 'source') Object.assign(dependencies[0]!, { source: { ...source, sha256: 'c'.repeat(64) } });
  if (corruption === 'type') Object.assign(dependencies[0]!, { type: 'bool' });
  const loaded = loadArtifactDescriptors(slice, { by: 'members' }), def = loaded.registry.get(OP);
  assert.ok(def && isGeneratedOperationDef(def));
  const store = createMemoryStorage(), memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const team = await memberships.createTeam({ timezone: 'UTC' });
  const user = await memberships.createUser({ email: 'predicate@example.test', password_hash: 'unused', email_verified: true });
  const reader = await memberships.createUser({ email: 'authority@example.test', password_hash: 'unused', email_verified: true });
  const caller = await memberships.createMembership({ team_id: team.team_id, user_id: user.user_id, roles: [], is_owner: false });
  const authority = await memberships.createMembership({ team_id: team.team_id, user_id: reader.user_id, roles: [], is_owner: false });
  const person = makeUserRef(association === undefined ? user.user_id : reader.user_id);
  const access = { fields: true }, scanned = new Set<string>();
  const policy = buildPolicyTable([], loaded.models), readPolicies = new Map<ModelName, ViewerSourceReadPolicy>();
  readPolicies.set(EMPLOYEE, { fields: controls.map(([field]) => field), secretFields: [], grants: [
    { fields: ['id', 'user'], read: async ({ context, row }) => { scanned.add(row.id); return context.membership?.status === 'active' &&
      (await context.memberships.findMembership(team.team_id, reader.user_id))?.status === 'active'; } },
    { fields: ['active', 'operator_wide', 'home', 'locations'], read: async observation => {
      const { context, row } = observation;
      if (!access.fields || denySuffix && row.id === 'c' || context.membership?.status !== 'active') return false;
      if (!controlDomain) return true;
      const domain = await readRecordsAtSourceObservation({ observation, store, model: EMPLOYEE, readPolicies, policy });
      assert.deepEqual(domain.map(candidate => candidate.record.id), [...domain.map(candidate => candidate.record.id)].sort());
      return domain.some(candidate => candidate.record.data.operator_wide === true);
    } },
  ] });
  readPolicies.set(RESULT, { fields: ['allowed'], secretFields: [], grants: [{ fields: ['id', 'allowed'], read: async ({ context }) => context.membership?.status === 'active' }] });
  let pending: { readonly call: AdmittedCall; readonly predicate: ScenarioReceiptAnyPredicate } | null = null, captures = 0;
  const capture = (call: AdmittedCall, queryId: string) => {
    assert.ok(pending && pending.call === call && queryId === QUERY, 'actual live source closure required');
    const actual = pending.predicate; pending = null; captures++; return actual;
  };
  const actualSites = structuredClone(sites) as unknown as ScenarioReceiptMembershipSite[];
  if (bodyRequire) Object.assign(actualSites[0]!, { stage: 'body-require', position: [{ kind: 'body', index: 0 }, { kind: 'then', index: 0 }] });
  if (association === 'chain') Object.assign(actualSites[0]!.calls[1]!.chain[0]!, { node: { start: 2, end: 9 } });
  if (association === 'slots') Object.assign(actualSites[0]!.calls[1]!, { slots: [1, 0] });
  if (association === 'domain') Object.assign(actualSites[0]!.calls[1]!.arguments[0]!, { type: `${LOCATION}[]` });
  if (association === 'stage') Object.assign(actualSites[0]!, { stage: 'body-condition' });
  const sourceFacts = { owner: OP, source, sites: actualSites };
  const associated = { ...importedMetadata, sourceCall: { siteIndex: association === 'site-index' ? 1 : 0,
    callIndex: association === 'call-index' ? 0 : 1 } };
  const supplied = association !== undefined ? associated : corruption === 'census' ? { ...metadata, dependencyIds: [...dependencyIds].reverse() } : metadata;
  let membershipCall: AdmittedCall | undefined;
  const handles = association === undefined || association === 'missing-owner' ? [] : bindScenarioReceiptMembershipProducer(def, {
    source, app: APP, sites: actualSites, capture: call => {
      assert.equal(membershipCall, call); membershipCall = undefined;
      return { person, team: call.context.team! };
    },
  });
  bindScenarioReceiptReferenceProducer(def, { source, app: APP, policy, readPolicies });
  bindScenarioReceiptQueryProducer(def, { source, app: APP, policy, readPolicies, any: [supplied], ...(association === 'missing-capture' ? {} : { captureAnyPredicate: capture }) });
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, containment: loaded.containment,
    ...(loaded.valueSchema === undefined ? {} : { valueSchema: loaded.valueSchema }) });
  const rows: [ModelName, StoredRow][] = [ [LOCATION, makeRow({ id: 'site' })] ];
  for (const id of ['c', 'b', 'a']) rows.push([EMPLOYEE, makeRow({ id, created: FIXED_NOW,
    data: { user: { id: person.id }, active: id !== 'a', operator_wide: controlDomain && id === 'c',
      home: { id: id === 'b' && !allFalse ? 'site' : 'elsewhere' }, locations: [] } })]);
  await store.commit(makeBatch(await store.readRevision(), { writes: rows.map(([model, row]) => ({ kind: 'insert', model, row })) }));
  const plan = def.descriptor.result!.disclosure!;
  const profileBound = { plan, artifactModels: new Map(slice.models!.map(model => [asModel(model.name), model])),
    canonicalModels: loaded.models, ...(loaded.valueSchema === undefined ? {} : { valueSchema: loaded.valueSchema }) };
  const profile = bindScenarioQueryAny(profileBound, supplied, association === undefined ? undefined : sourceFacts);
  return { store, memberships, caller, authority, access, scanned, table, policy, readPolicies, profile, profileBound, def, guardOnly,
    sourceFacts, associated, membership: async (call: AdmittedCall) => {
      if (association === undefined) return true;
      assert.equal(membershipCall, undefined); membershipCall = call;
      return evaluateScenarioReceiptMembership(call, store, { site: handles[0]! });
    },
    registry: loaded.registry, app: APP, source: 'component', clock: { nowMs: () => FIXED_NOW },
    identity: makeIdentity({ team, userId: user.user_id, membership: caller }), envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence)),
    activate: (call: AdmittedCall, predicate: ScenarioReceiptAnyPredicate) => { assert.equal(pending, null); pending = { call, predicate }; },
    deactivate: () => { pending = null; }, captures: () => captures, person: person.id };
}
type World = Awaited<ReturnType<typeof world>>;
function execution(w: World, mode: Mode = 'normal', after?: (session: Awaited<ReturnType<typeof beginScenarioReceiptMutation>>) => Promise<void> | void) {
  let receipt: Receipt | undefined, activeCall: AdmittedCall | undefined, late: ScenarioReceiptAnyPredicate | undefined;
  const visited: string[] = [];
  const request = { ...w, observeCommittedReceipt: (value: Receipt) => { receipt = value; }, execute: async (call: AdmittedCall) => {
    activeCall = call;
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds: { maxRows: 10, maxWork: 1000 } });
    const predicate: ScenarioReceiptAnyPredicate = async ({ slot, record }) => {
      assert.deepEqual([...w.scanned].sort(), ['a', 'b', 'c']); visited.push(record.id);
      if (mode === 'failure') throw new StateError('rule_failed', 'Exact predicate failure');
      const read = (field: string) => { const value = record.data[field];
        if (mode !== 'missing-marker') observeScenarioReceiptQueryDependency(call, w.store, { slot, dependencyId: `control-${field}` }); return value; };
      if (mode === 'wrong-first') read('active');
      return (read('user') as { id: string }).id === w.person && read('active') === true && await w.membership(call) &&
        (read('operator_wide') === true || (read('home') as { id: string }).id === 'site' ||
          (read('locations') as { id: string }[]).some(location => location.id === 'site'));
    };
    late = predicate; if (mode !== 'skip') w.activate(call, predicate); if (mode === 'closed') w.deactivate();
    const invokeAny = () => executeScenarioReceiptAny(mode === 'copied-call' ? { ...call } : call,
      mode === 'foreign-store' ? { ...w.store } : w.store, { queryId: mode === 'wrong-query' ? 'foreign-query' : QUERY,
        predicate: mode === 'wrong-pointer' ? candidate => predicate(candidate) : predicate });
    const allowed = mode === 'skip' ? true : await invokeAny();
    if (w.guardOnly && !allowed) throw new StateError('rule_failed', 'Original helper Require failed');
    if (mode === 'repeat') { await assert.rejects(invokeAny()); throw new StateError('validation', 'Repeat refused'); }
    await after?.(session);
    await session.stage({ op: 'create', model: RESULT, id: asId('result'), data: { allowed: w.guardOnly ? true : allowed } }, { cause: 'scenario' });
    const row = await session.read(RESULT, asId('result')); assert.ok(row);
    const result = await bindScenarioReceiptModelResult(call, w.store, { returnId: 'result', row });
    selectScenarioReceiptReturn(call, w.store, 'result'); return { ...await session.finalize(), result, outbox: [] };
  } };
  return { request, visited, receipt: () => { assert.ok(receipt); return receipt; }, late: () => {
    assert.ok(activeCall && late); return executeScenarioReceiptAny(activeCall, w.store, { queryId: QUERY, predicate: late });
  } };
}

test('captured predicate ANY preserves root viewer domain, lazy first-true fields, saved prefix and current authority', async () => {
  const w = await world(), ex = execution(w);
  assert.equal((await invoke(ex.request)).status, 'committed'); assert.deepEqual(ex.visited, ['a', 'b']); assert.equal(w.captures(), 1);
  const saved = readScenarioReceiptAssociation(ex.receipt())!;
  assert.equal(checkSavedScenarioQueryAny(w.profile, saved.queries![0]!), true);
  assert.deepEqual(saved.queries![0]!.candidates[2]!.dependencies, []);
  assert.throws(() => checkSavedScenarioQueryAny({ ...w.profile }, saved.queries![0]!));
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt: ex.receipt() })).result, { id: 'result' });
  await assert.rejects(ex.late());
  await w.memberships.removeMembership(w.authority.membership_id);
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt: ex.receipt() }), { result: null, records: [] });
});

test('captured predicate ANY retains a complete all-false prefix without inventing a selected row', async () => {
  const w = await world(true, undefined, false), ex = execution(w);
  assert.equal((await invoke(ex.request)).status, 'committed');
  assert.deepEqual(ex.visited, ['a', 'b', 'c']);
  assert.equal((await w.store.load(RESULT, asId('result')))!.data.allowed, false);
  const saved = readScenarioReceiptAssociation(ex.receipt())!;
  assert.equal(checkSavedScenarioQueryAny(w.profile, saved.queries![0]!), false);
  assert.deepEqual(saved.queries![0]!.selectedIndices, []);
});

test('predicate ANY refuses unsealed callbacks, wrong lifetimes, markers, first reads and exact source corruption', async () => {
  for (const mode of ['wrong-pointer', 'copied-call', 'foreign-store', 'wrong-query', 'closed', 'repeat', 'missing-marker', 'wrong-first'] as const) {
    const w = await world(), ex = execution(w, mode);
    await assert.rejects(invoke(ex.request), error => {
      if (mode === 'closed') return error instanceof assert.AssertionError && /actual live source closure/.test(error.message);
      if (!(error instanceof StateError)) return false;
      if (mode === 'wrong-pointer') return /exact once-captured active source callback/.test(error.message);
      if (mode === 'wrong-first') return /proved first read/.test(error.message);
      if (mode === 'copied-call' || mode === 'foreign-store') return error.code === 'forbidden';
      return error.code === 'validation';
    });
    assert.equal(await w.store.load(RESULT, asId('result')), null);
  }
  for (const corruption of ['census', 'import', 'source', 'type'] as const) await assert.rejects(world(false, corruption));
  const defensive = await world(); let getterReads = 0;
  const accessorMetadata = Object.defineProperty({ queryId: QUERY, dependencyIds }, 'kind', {
    enumerable: true, get: () => { getterReads++; throw new Error('must not read discriminator accessor'); },
  });
  assert.throws(() => bindScenarioQueryAny(defensive.profileBound, accessorMetadata as unknown as typeof metadata), StateError);
  assert.equal(getterReads, 0);
  const w = await world(), ex = execution(w, 'failure');
  await assert.rejects(invoke(ex.request), error => error instanceof StateError && error.code === 'rule_failed' && error.message === 'Exact predicate failure');
});

test('predicate ANY requires only reached viewer fields, and rechecks late field and membership loss', async () => {
  const withheld = await world(true), reached = execution(withheld);
  await assert.rejects(invoke(reached.request), error => error instanceof StateError && error.code === 'forbidden');
  assert.deepEqual(reached.visited, ['a', 'b', 'c']);
  assert.equal(await withheld.store.load(RESULT, asId('result')), null);
  for (const loss of ['fields', 'authority', 'caller'] as const) {
    const w = await world(), ex = execution(w, 'normal', async () => {
      if (loss === 'fields') w.access.fields = false;
      else await w.memberships.removeMembership(loss === 'authority' ? w.authority.membership_id : w.caller.membership_id);
    });
    await assert.rejects(invoke(ex.request)); assert.equal(await w.store.load(RESULT, asId('result')), null);
  }
});


test('imported predicate ANY joins the private owner census to transported helper origin and retains lazy membership', async () => {
  const w = await world(false, undefined, true, 'valid'), ex = execution(w);
  assert.equal((await invoke(ex.request)).status, 'committed');
  assert.deepEqual(ex.visited, ['a', 'b']);
  const saved = readScenarioReceiptAssociation(ex.receipt())!;
  assert.equal(checkSavedScenarioQueryAny(w.profile, saved.queries![0]!), true);
  assert.deepEqual(saved.queries![0]!.candidates[2]!.dependencies, []);
  await assert.rejects(ex.late());
  await w.memberships.removeMembership(w.authority.membership_id);
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt: ex.receipt() }), { result: null, records: [] });
  for (const mode of ['wrong-pointer', 'copied-call', 'wrong-query', 'closed', 'repeat'] as const) {
    const invalid = await world(false, undefined, true, 'valid'), attempt = execution(invalid, mode);
    await assert.rejects(invoke(attempt.request));
    assert.equal(await invalid.store.load(RESULT, asId('result')), null);
  }
  for (const loss of ['fields', 'authority', 'caller'] as const) {
    const current = await world(false, undefined, true, 'valid');
    const executionLoss = execution(current, 'normal', async () => {
      if (loss === 'fields') current.access.fields = false;
      else await current.memberships.removeMembership((loss === 'authority' ? current.authority : current.caller).membership_id);
    });
    await assert.rejects(invoke(executionLoss.request), StateError);
    assert.equal(await current.store.load(RESULT, asId('result')), null);
  }
});

test('imported predicate association refuses absent private producers and forged source, chain, slots or selector', async () => {
  for (const association of ['missing-owner', 'missing-capture', 'site-index', 'call-index', 'path', 'hash', 'module', 'chain', 'slots', 'domain'] as const)
    await assert.rejects(world(false, undefined, true, association), error => error instanceof StateError && error.code === 'validation', association);
  const w = await world(false, undefined, true, 'valid');
  assert.throws(() => bindScenarioQueryAny(w.profileBound, w.associated), StateError);
  assert.throws(() => bindScenarioQueryAny(w.profileBound, w.associated, { ...w.sourceFacts, owner: 'Foreign.owner' }), StateError);
  let reads = 0;
  const facts = Object.defineProperty({ owner: OP, source }, 'sites', { enumerable: true,
    get: () => { reads++; throw new Error('must not inspect source accessor'); } });
  assert.throws(() => bindScenarioQueryAny(w.profileBound, w.associated, facts as typeof w.sourceFacts), StateError);
  assert.equal(reads, 0);
});


test('predicate ANY consumes the compiler singular User tag without a redundant artifact valueType', async () => {
  const w = await world(false, undefined, true, 'valid', true), ex = execution(w);
  const artifactUser = w.profileBound.artifactModels.get(EMPLOYEE)!.fields.find(field => field.name === 'user')!;
  assert.deepEqual(artifactUser.field, { kind: 'user' });
  assert.equal(Object.hasOwn(artifactUser, 'valueType'), false);
  assert.equal(w.profileBound.canonicalModels.find(model => model.name === EMPLOYEE)!.fields.user!.valueType, 'user');
  assert.equal((await invoke(ex.request)).status, 'committed');
  assert.deepEqual(ex.visited, ['a', 'b']);
  const saved = readScenarioReceiptAssociation(ex.receipt())!;
  assert.deepEqual(saved.queries![0]!.selectedIndices, [1]);
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt: ex.receipt() })).result, { id: 'result' });
});

test('native User predicate declaration refuses wrong claims, native kinds, wrappers and accessors', async () => {
  const w = await world(false, undefined, true, 'valid', true);
  const original = w.profileBound.artifactModels.get(EMPLOYEE)!;
  const user = original.fields.find(field => field.name === 'user')!;
  let getters = 0;
  const malformed: unknown[] = [
    { ...user, valueType: 'bool' },
    { ...user, valueType: 'user', field: { kind: 'string' } },
    { ...user, valueType: 'user', field: { kind: 'boolean' } },
    { ...user, field: { kind: 'ref', model: LOCATION } },
    { ...user, array: { required: false } },
    { ...user, nullable: true },
    { ...user, field: { kind: 'user', extra: true } },
    Object.defineProperty({ ...user }, 'valueType', { enumerable: true, get() { getters++; return 'user'; } }),
    Object.defineProperty({ ...user }, 'field', { enumerable: true, get() { getters++; return { kind: 'user' }; } }),
  ];
  for (const invalid of malformed) {
    const artifactModels = new Map(w.profileBound.artifactModels);
    artifactModels.set(EMPLOYEE, { ...original, fields: original.fields.map(field => field.name === 'user' ? invalid as typeof user : field) });
    assert.throws(() => bindScenarioQueryAny({ ...w.profileBound, artifactModels }, w.associated, w.sourceFacts), StateError);
  }
  assert.equal(getters, 0);
});


test('root predicate policies retain their private stage domain and current saved recovery', async () => {
  const w = await world(false, undefined, true, 'valid', true, true), ex = execution(w);
  assert.equal((await invoke(ex.request)).status, 'committed');
  assert.deepEqual(ex.visited, ['a', 'b']);
  const saved = readScenarioReceiptAssociation(ex.receipt())!;
  assert.deepEqual(saved.queries![0]!.candidates.map(candidate => candidate.row.id), ['a', 'b', 'c']);
  assert.deepEqual(saved.queries![0]!.selectedIndices, [1]);
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt: ex.receipt() })).result, { id: 'result' });
  await w.memberships.removeMembership(w.authority.membership_id);
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt: ex.receipt() }), { result: null, records: [] });
});

test('final root policy authority sees own updates and removals of another domain row', async () => {
  for (const change of ['update', 'remove'] as const) {
    const w = await world(false, undefined, true, 'valid', true, true), original = await w.store.load(EMPLOYEE, asId('c'));
    assert.ok(original);
    const ex = execution(w, 'normal', async session => {
      await session.stage(change === 'update'
        ? { op: 'update', model: EMPLOYEE, id: original.id, data: { operator_wide: false } }
        : { op: 'remove', model: EMPLOYEE, id: original.id }, { cause: 'scenario' });
    });
    await assert.rejects(invoke(ex.request), error => error instanceof StateError && error.code === 'forbidden');
    assert.deepEqual(await w.store.load(EMPLOYEE, original.id), original);
    assert.equal(await w.store.load(RESULT, asId('result')), null);
  }
});

test('final root policy includes new own rows while the original query guard retains its intermediate domain', async () => {
  const w = await world(false, undefined, true, 'valid', true, true);
  const ex = execution(w, 'normal', async session => {
    await session.stage({ op: 'update', model: EMPLOYEE, id: asId('c'), data: { operator_wide: false } }, { cause: 'scenario' });
    await session.stage({ op: 'create', model: EMPLOYEE, id: asId('d'), data: {
      user: { id: w.person }, active: true, operator_wide: true, home: { id: 'site' }, locations: [],
    } }, { cause: 'scenario' });
  });
  assert.equal((await invoke(ex.request)).status, 'committed');
  assert.deepEqual(ex.visited, ['a', 'b']);
  const saved = readScenarioReceiptAssociation(ex.receipt())!, query = saved.queries![0]!;
  assert.deepEqual(query.candidates.map(candidate => candidate.row.id), ['a', 'b', 'c']);
  assert.deepEqual(query.selectedIndices, [1]);
  assert.equal(query.candidates[2]!.row.data.operator_wide, true);
  assert.equal((await w.store.load(EMPLOYEE, asId('c')))!.data.operator_wide, false);
  assert.equal((await w.store.load(EMPLOYEE, asId('d')))!.data.operator_wide, true);
});


test('new final root control rows retain the existing owner domain bound', async () => {
  const w = await world(false, undefined, true, 'valid', true, true);
  const ex = execution(w, 'normal', async session => {
    for (let index = 0; index < 8; index++) await session.stage({ op: 'create', model: EMPLOYEE, id: asId(`new-${index}`), data: {
      user: { id: w.person }, active: true, operator_wide: true, home: { id: 'site' }, locations: [],
    } }, { cause: 'scenario' });
  });
  await assert.rejects(invoke(ex.request), error => error instanceof StateError && error.code === 'validation');
  assert.equal((await w.store.query({ model: EMPLOYEE, authority: 'owner' })).length, 3);
  assert.equal(await w.store.load(RESULT, asId('result')), null);
});


test('verified Require-only ANY commits and replays an independent Model return without saving query disclosure', async () => {
  const w = await world(false, undefined, true, 'valid', true, false, true), ex = execution(w);
  assert.equal((await invoke(ex.request)).status, 'committed');
  assert.deepEqual(ex.visited, ['a', 'b']); assert.equal(w.captures(), 1);
  const saved = readScenarioReceiptAssociation(ex.receipt())!;
  assert.equal(saved.queries, undefined);
  assert.deepEqual(saved.plan.returns[0]!.influences, []);
  assert.deepEqual((await w.store.load(RESULT, asId('result')))!.data, { allowed: true });
  assert.equal((await invoke(ex.request)).status, 'replayed'); assert.equal(w.captures(), 1); assert.deepEqual(ex.visited, ['a', 'b']);
  // Execution CONTROL does not become output disclosure dependency.
  w.access.fields = false;
  await w.memberships.removeMembership(w.authority.membership_id);
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt: ex.receipt() })).result, { id: 'result' });
  await w.memberships.removeMembership(w.caller.membership_id);
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt: ex.receipt() }), { result: null, records: [] });
});

test('Require-only ANY retains late field and membership guards and refuses wrong callbacks or false Require', async () => {
  for (const loss of ['fields', 'authority', 'caller'] as const) {
    const w = await world(false, undefined, true, 'valid', true, false, true);
    const ex = execution(w, 'normal', async () => {
      if (loss === 'fields') w.access.fields = false;
      else await w.memberships.removeMembership((loss === 'authority' ? w.authority : w.caller).membership_id);
    });
    await assert.rejects(invoke(ex.request), StateError);
    assert.equal(await w.store.load(RESULT, asId('result')), null);
  }
  const mismatch = await world(false, undefined, true, 'valid', true, false, true), wrong = execution(mismatch, 'wrong-pointer');
  await assert.rejects(invoke(wrong.request), /exact once-captured active source callback/);
  assert.equal(await mismatch.store.load(RESULT, asId('result')), null);
  const falseGuard = await world(true, undefined, false, 'valid', true, false, true), rejected = execution(falseGuard);
  await assert.rejects(invoke(rejected.request), error => error instanceof StateError && error.code === 'rule_failed' && error.message === 'Original helper Require failed');
  assert.equal(await falseGuard.store.load(RESULT, asId('result')), null);
});

test('execution-only ANY requires private Require sourceCall proof and does not force skipped body execution', async () => {
  await assert.rejects(world(false, undefined, true, undefined, true, false, true), /actual CONTROL influence/);
  for (const association of ['missing-owner', 'missing-capture', 'site-index', 'call-index', 'path', 'hash', 'module', 'chain', 'slots', 'domain', 'stage'] as const) {
    await assert.rejects(world(false, undefined, true, association, true, false, true));
  }
  const w = await world(false, undefined, true, 'valid', true, false, true, true), ex = execution(w, 'skip');
  assert.equal((await invoke(ex.request)).status, 'committed');
  assert.deepEqual(ex.visited, []); assert.equal(w.captures(), 0);
  assert.equal(readScenarioReceiptAssociation(ex.receipt())!.queries, undefined);
  assert.equal((await invoke(ex.request)).status, 'replayed'); assert.equal(w.captures(), 0);
});
