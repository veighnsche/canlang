/** State's finite source-installed predicate receiver. This hand-built source
 * producer does not qualify Compiler/CF factory or imported-helper sealing. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, ModelName, Receipt, StoredRow } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { StateError } from '../../src/errors.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { buildModelTableFromCanonical } from '../../src/mutation/models.js';
import { buildPolicyTable } from '../../src/policy/grants.js';
import type { ViewerSourceReadPolicy } from '../../src/query/source-policy.js';
import type { AdmittedCall } from '../../src/invocation/admission.js';
import { invoke } from '../../src/invocation/invoke.js';
import { loadArtifactDescriptors, isGeneratedOperationDef, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { beginScenarioReceiptMutation, bindScenarioReceiptReferenceProducer, bindScenarioReceiptQueryProducer, executeScenarioReceiptAny,
  observeScenarioReceiptQueryDependency, bindScenarioReceiptModelResult, selectScenarioReceiptReturn,
  readScenarioReceiptAssociation, projectScenarioReceipt, type ScenarioReceiptAnyPredicate } from '../../src/invocation/scenario-receipt.js';
import { bindScenarioQueryAny, checkSavedScenarioQueryAny } from '../../src/invocation/scenario-query-any.js';
import { asId, asModel, FIXED_NOW, makeBatch, makeEnvelope, makeIdentity, makeRow, uuidv7 } from './fixtures.js';

const EMPLOYEE = asModel('Predicate.Employee'), LOCATION = asModel('Predicate.Location'), RESULT = asModel('Predicate.Result');
const APP = 'predicate-any', OP = 'Predicate.check', QUERY = 'work-query';
const source = { path: 'predicate.can', module: 'predicate.mjs', sha256: 'a'.repeat(64) };
const controls = [ ['user', 'user'], ['active', 'bool'], ['operator_wide', 'bool'], ['home', LOCATION], ['locations', `${LOCATION}[]`] ] as const;
const dependencyIds = controls.map(([name]) => `control-${name}`);
const metadata = { kind: 'predicate' as const, queryId: QUERY, dependencyIds };
let sequence = 160000;
type Mode = 'normal' | 'wrong-pointer' | 'copied-call' | 'foreign-store' | 'wrong-query' | 'closed' | 'repeat' | 'missing-marker' | 'wrong-first' | 'failure';
async function world(allFalse = false, corruption?: 'source' | 'census' | 'type' | 'import', denySuffix = true) {
  const dependencies = controls.map(([field, type], index) => ({ id: dependencyIds[index]!, source, role: 'control' as const, field, type: type as CanTypeId }));
  const slice: ArtifactDescriptorSlice = { artifact_version: 1, sources: [{ path: source.path, sha256: source.sha256 }],
    modules: [{ path: source.module, js: 'export const identity="Predicate.check";', map: { version: 3, file: source.module,
      sources: [source.path], sourcesContent: [null], names: [], mappings: '' } }],
    callables: [{ id: OP, kind: 'operation', module: source.module, export: 'identity', member: ['check'] }],
    valueTypes: { contracts: [] }, models: [
      { name: EMPLOYEE, deleteMode: 'archive', fields: controls.map(([name, type]) => ({ name, valueType: type as CanTypeId,
        field: name === 'user' ? { kind: 'user' as const } : name === 'home' || name === 'locations'
          ? { kind: 'ref' as const, model: LOCATION } : { kind: 'boolean' as const },
        ...(name === 'locations' ? { array: { required: false } } : {}), required: true, serverOnly: false })) },
      { name: LOCATION, deleteMode: 'archive', fields: [] },
      { name: RESULT, deleteMode: 'archive', fields: [{ name: 'allowed', field: { kind: 'boolean' }, valueType: 'bool' as CanTypeId, required: true, serverOnly: false }] },
    ], operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [] }, result: { type: RESULT as CanTypeId,
      disclosure: { version: 1, source, queries: [{ id: QUERY, source, model: EMPLOYEE, order: [], limit: null, archived: 'exclude', dependencies }],
        returns: [{ id: 'result', source, dependencies: [], influences: (['query-existence', 'query-cardinality', 'query-membership', 'query-order'] as const)
          .map(kind => ({ id: kind, kind, queryId: QUERY })) }] } } }] };
  if (corruption === 'import') {
    const imported = { path: 'helper.can', module: 'helper.mjs', sha256: 'b'.repeat(64) };
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
  const access = { fields: true }, scanned = new Set<string>();
  const policy = buildPolicyTable([], loaded.models), readPolicies = new Map<ModelName, ViewerSourceReadPolicy>();
  readPolicies.set(EMPLOYEE, { fields: controls.map(([field]) => field), secretFields: [], grants: [
    { fields: ['id', 'user'], read: async ({ context, row }) => { scanned.add(row.id); return context.membership?.status === 'active' &&
      (await context.memberships.findMembership(team.team_id, reader.user_id))?.status === 'active'; } },
    { fields: ['active', 'operator_wide', 'home', 'locations'], read: async ({ context, row }) => access.fields && (!denySuffix || row.id !== 'c') && context.membership?.status === 'active' },
  ] });
  readPolicies.set(RESULT, { fields: ['allowed'], secretFields: [], grants: [{ fields: ['id', 'allowed'], read: async ({ context }) => context.membership?.status === 'active' }] });
  let pending: { readonly call: AdmittedCall; readonly predicate: ScenarioReceiptAnyPredicate } | null = null, captures = 0;
  const capture = (call: AdmittedCall, queryId: string) => {
    assert.ok(pending && pending.call === call && queryId === QUERY, 'actual live source closure required');
    const actual = pending.predicate; pending = null; captures++; return actual;
  };
  const supplied = corruption === 'census' ? { ...metadata, dependencyIds: [...dependencyIds].reverse() } : metadata;
  bindScenarioReceiptReferenceProducer(def, { source, app: APP, policy, readPolicies });
  bindScenarioReceiptQueryProducer(def, { source, app: APP, policy, readPolicies, any: [supplied], captureAnyPredicate: capture });
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, containment: loaded.containment,
    ...(loaded.valueSchema === undefined ? {} : { valueSchema: loaded.valueSchema }) });
  const rows: [ModelName, StoredRow][] = [ [LOCATION, makeRow({ id: 'site' })] ];
  for (const id of ['c', 'b', 'a']) rows.push([EMPLOYEE, makeRow({ id, created: FIXED_NOW,
    data: { user: { id: user.user_id }, active: id !== 'a', operator_wide: false,
      home: { id: id === 'b' && !allFalse ? 'site' : 'elsewhere' }, locations: [] } })]);
  await store.commit(makeBatch(await store.readRevision(), { writes: rows.map(([model, row]) => ({ kind: 'insert', model, row })) }));
  const plan = def.descriptor.result!.disclosure!;
  const profileBound = { plan, artifactModels: new Map(slice.models!.map(model => [asModel(model.name), model])),
    canonicalModels: loaded.models, ...(loaded.valueSchema === undefined ? {} : { valueSchema: loaded.valueSchema }) };
  const profile = bindScenarioQueryAny(profileBound, metadata);
  return { store, memberships, caller, authority, access, scanned, table, policy, readPolicies, profile, profileBound, def,
    registry: loaded.registry, app: APP, source: 'component', clock: { nowMs: () => FIXED_NOW },
    identity: makeIdentity({ team, userId: user.user_id, membership: caller }), envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence)),
    activate: (call: AdmittedCall, predicate: ScenarioReceiptAnyPredicate) => { assert.equal(pending, null); pending = { call, predicate }; },
    deactivate: () => { pending = null; }, captures: () => captures, person: user.user_id };
}
type World = Awaited<ReturnType<typeof world>>;
function execution(w: World, mode: Mode = 'normal', after?: () => Promise<void> | void) {
  let receipt: Receipt | undefined, activeCall: AdmittedCall | undefined, late: ScenarioReceiptAnyPredicate | undefined;
  const visited: string[] = [];
  const request = { ...w, observeCommittedReceipt: (value: Receipt) => { receipt = value; }, execute: async (call: AdmittedCall) => {
    activeCall = call;
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds: { maxRows: 10, maxWork: 1000 } });
    const predicate: ScenarioReceiptAnyPredicate = ({ slot, record }) => {
      assert.deepEqual([...w.scanned].sort(), ['a', 'b', 'c']); visited.push(record.id);
      if (mode === 'failure') throw new StateError('rule_failed', 'Exact predicate failure');
      const read = (field: string) => { const value = record.data[field];
        if (mode !== 'missing-marker') observeScenarioReceiptQueryDependency(call, w.store, { slot, dependencyId: `control-${field}` }); return value; };
      if (mode === 'wrong-first') read('active');
      return (read('user') as { id: string }).id === w.person && read('active') === true &&
        (read('operator_wide') === true || (read('home') as { id: string }).id === 'site' ||
          (read('locations') as { id: string }[]).some(location => location.id === 'site'));
    };
    late = predicate; w.activate(call, predicate); if (mode === 'closed') w.deactivate();
    const invokeAny = () => executeScenarioReceiptAny(mode === 'copied-call' ? { ...call } : call,
      mode === 'foreign-store' ? { ...w.store } : w.store, { queryId: mode === 'wrong-query' ? 'foreign-query' : QUERY,
        predicate: mode === 'wrong-pointer' ? candidate => predicate(candidate) : predicate });
    const allowed = await invokeAny();
    if (mode === 'repeat') { await assert.rejects(invokeAny()); throw new StateError('validation', 'Repeat refused'); }
    await after?.();
    await session.stage({ op: 'create', model: RESULT, id: asId('result'), data: { allowed } }, { cause: 'scenario' });
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
