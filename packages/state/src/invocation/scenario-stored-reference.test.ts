/** Defining State stored-reference controls for the original workbench shapes:
 * Step in Run, Run.location, Run.targets (1..10), and nullable Task.location.
 * Checked descriptors are hand-built and installed in one load. These tests
 * do not qualify Compiler emission, native execution, or the approval workflow.
 * References retain original facts; they confer no referenced-row authority. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, ClosedInputs, QueryPredicate, Receipt, StoragePort, StoredRow } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { StateError } from '../errors.js';
import { createMemoryStorage } from '../storage/memory.js';
import { buildModelTableFromCanonical } from '../mutation/models.js';
import { buildPolicyTable, type PolicyTable } from '../policy/grants.js';
import type { ByPredicate, MembershipReader } from '../policy/roles.js';
import { projectSavedRecordForViewer } from '../query/engine.js';
import { receiptIdentityFor, type AdmittedCall } from './admission.js';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice, type GeneratedOperationDef } from './registry.js';
import { invoke, invokeRetainedReceiptOnly, type ExecutionEffects } from './invoke.js';
import { beginScenarioReceiptMutation, bindScenarioReceiptReferenceProducer, observeScenarioReceiptDependency,
  bindScenarioReceiptCallProducer, invokeScenarioReceiptCall, selectScenarioReceiptReturn,
  readScenarioReceiptAssociation, projectScenarioReceipt } from './scenario-receipt.js';
import { FIXED_NOW, asId, asModel, asVersion, makeBatch, makeEnvelope, makeIdentity,
  seedRow, uuidv7 } from '../../test/invocation/fixtures.js';

const STEP = asModel('workbench.Step'), RUN = asModel('workbench.Run');
const TASK = asModel('todo.Task'), LOCATION = asModel('rent_catalog.Location');
const OP = 'workbench.countStoredTargets', APP = 'stored-reference-app';
const bounds = { maxWork: 1000, maxRows: 10 }, cause = { cause: 'scenario' } as const;
const stateError = (error: unknown) => error instanceof StateError;
let sequence = 80_000;
const origin = (digest = 'd'.repeat(64)) => ({ path: 'stored-reference.can', sha256: digest, module: 'stored-reference.mjs' });
const targets = () => [{ id: 'task-first', version: '7' }, { id: 'task-second' }, { id: 'task-first', version: '7' }];
function artifact(digest = 'd'.repeat(64)): ArtifactDescriptorSlice {
  const dependency = (id: string, model: typeof STEP, field: string, type: string) =>
    ({ id, source: origin(digest), role: 'data' as const, model, field, type: type as CanTypeId });
  return { artifact_version: 1, sources: [{ path: 'stored-reference.can', sha256: digest }],
    modules: [{ path: 'stored-reference.mjs', js: `export const identity="${OP}";`, map: {
      version: 3, file: 'stored-reference.mjs', sources: ['stored-reference.can'], sourcesContent: [null], names: [], mappings: '' } }],
    callables: [{ id: OP, kind: 'operation', module: 'stored-reference.mjs', export: 'identity', member: ['countStoredTargets'] }],
    models: [
      { name: STEP, parent: RUN, deleteMode: 'archive', fields: [
        { name: 'state', field: { kind: 'string' }, valueType: 'text' as CanTypeId, required: true, serverOnly: false },
      ] },
      { name: RUN, deleteMode: 'archive', fields: [
        { name: 'location', field: { kind: 'ref', model: LOCATION }, valueType: LOCATION as CanTypeId, required: true, serverOnly: false },
        { name: 'targets', field: { kind: 'ref', model: TASK }, valueType: `${TASK}[]!` as CanTypeId,
          array: { required: true }, min: 1, max: 10, required: true, serverOnly: false },
        { name: 'reviewer', field: { kind: 'user' }, valueType: 'user' as CanTypeId, required: true, serverOnly: false },
        { name: 'state', field: { kind: 'string' }, valueType: 'text' as CanTypeId, required: true, serverOnly: false },
      ] },
      { name: TASK, deleteMode: 'archive', fields: [
        { name: 'location', field: { kind: 'ref', model: LOCATION }, valueType: `${LOCATION}?` as CanTypeId,
          nullable: true, required: false, serverOnly: false },
        { name: 'title', field: { kind: 'string' }, valueType: 'text' as CanTypeId, required: true, serverOnly: false },
      ] },
      { name: LOCATION, deleteMode: 'archive', fields: [
        { name: 'name', field: { kind: 'string' }, valueType: 'text' as CanTypeId, required: true, serverOnly: false },
      ] },
    ],
    operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [
      { name: 'step', field: { kind: 'ref', model: STEP, requireVersion: true }, required: true },
    ] }, result: { type: 'int' as CanTypeId, disclosure: { version: 1, source: origin(digest), returns: [
      { id: 'target-count', source: origin(digest), influences: [], dependencies: [
        dependency('step-parent', STEP, 'parent', RUN),
        dependency('run-location', RUN, 'location', LOCATION),
        dependency('run-targets', RUN, 'targets', `${TASK}[]!`),
      ] },
      { id: 'nullable-location', source: origin(digest), influences: [], dependencies: [
        dependency('task-location', TASK, 'location', `${LOCATION}?`),
      ] },
    ] } } }],
  };
}
const empty = (): ExecutionEffects => ({ result: null, writes: [], history: [], outbox: [], schedules: [],
  uniqueClaims: [], uniqueReleases: [], resolvedDefaults: {} });
type PolicyOptions = { runFields?: string[]; runSecrets?: string[]; stepFields?: string[]; stepVisible?: boolean; by?: ByPredicate;
  when?: QueryPredicate; task?: boolean };
function policyFor(loaded: ReturnType<typeof loadArtifactDescriptors>, options: PolicyOptions = {}): PolicyTable {
  return buildPolicyTable([
    { model: STEP, secretFields: [], grants: options.stepVisible === false ? []
      : [{ by: 'members', fields: options.stepFields ?? ['state'] }] },
    { model: RUN, secretFields: options.runSecrets ?? [], grants: [{ by: options.by ?? {
      and: ['members', { roleSubject: { role: 'workbench.review', person: { model: RUN, field: 'reviewer' } } }],
    }, fields: options.runFields ?? ['location', 'targets', 'reviewer', 'state'],
      ...(options.when === undefined ? {} : { when: options.when }) }] },
    { model: TASK, secretFields: [], grants: options.task ? [{ by: 'members', fields: ['location', 'title'] }] : [] },
    { model: LOCATION, secretFields: [], grants: [] },
  ], loaded.models);
}
async function world(options: PolicyOptions = {}, edit?: (run: Record<string, unknown>, step: StoredRow) => void,
  slice = artifact(), bind = true) {
  const physical = createMemoryStorage(), memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const team = await memberships.createTeam({ timezone: 'UTC' });
  const caller = await memberships.createMembership({ team_id: team.team_id, user_id: 'reference-caller', is_owner: false, roles: [] });
  const subject = await memberships.createMembership({ team_id: team.team_id, user_id: 'reference-reviewer', is_owner: false,
    roles: [{ role: 'workbench.review', granted_at: caller.created_at, granted_by: caller.user_id }] });
  const identity = makeIdentity({ userId: caller.user_id, team, membership: caller });
  const loaded = loadArtifactDescriptors(slice, { by: 'members' });
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, serverInits: loaded.serverInits,
    nullableFields: loaded.nullableFields, containment: loaded.containment,
    ...(loaded.valueSchema === undefined ? {} : { valueSchema: loaded.valueSchema }) });
  const data: Record<string, unknown> = { location: { id: 'location-first', version: '2' }, targets: targets(),
    reviewer: { id: subject.user_id }, state: 'open' };
  const step: StoredRow = { id: asId('step-first'), version: asVersion(1), created: FIXED_NOW, updated: FIXED_NOW,
    createdBy: caller.user_id, updatedBy: caller.user_id, archivedAt: null,
    parent: { model: RUN, id: asId('run-first') }, data: { state: 'open' } };
  edit?.(data, step);
  const run = await seedRow(physical, RUN, { id: 'run-first', data, createdBy: caller.user_id, updatedBy: caller.user_id });
  await physical.commit(makeBatch(await physical.readRevision(), { writes: [{ kind: 'insert', model: STEP, row: step }] }));
  const task = await seedRow(physical, TASK, { id: 'task-first', version: 7, data: { location: null, title: 'Private task' } });
  const location = await seedRow(physical, LOCATION, { id: 'location-first', version: 2, data: { name: 'Private location' } });
  let referenceLoads = 0, locationLoads = 0, queries = 0, computations = 0;
  const store: StoragePort = { ...physical, query: async spec => { queries++; return physical.query(spec); },
    load: async (model, id) => {
      if (model === TASK || model === LOCATION) referenceLoads++;
      if (model === LOCATION) locationLoads++;
      return physical.load(model, id);
    } };
  const policy = policyFor(loaded, options), def = loaded.registry.get(OP) as GeneratedOperationDef;
  if (bind) bindScenarioReceiptReferenceProducer(def, { source: origin(), app: APP, policy });
  return { physical, store, memberships, team, caller, subject, identity, loaded, table, run, step, task, location,
    policy, def, registry: loaded.registry, app: APP, source: 'test', clock: { nowMs: () => FIXED_NOW },
    envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence), { step: { id: step.id, version: String(step.version) } }),
    count: (wire: unknown) => { computations++; return (wire as readonly unknown[]).length; },
    counts: () => computations, referenceLoads: () => referenceLoads, locationLoads: () => locationLoads, queries: () => queries };
}
type World = Awaited<ReturnType<typeof world>>;
async function domain(w: World) { return { run: await w.physical.load(RUN, w.run.id), step: await w.physical.load(STEP, w.step.id),
  history: await w.store.historyFor(RUN, w.run.id), task: await w.physical.load(TASK, w.task.id), outbox: await w.store.outboxPending() }; }
async function observe(call: AdmittedCall, w: World) {
  const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
  const step = await session.read(STEP, w.step.id); assert.ok(step);
  await observeScenarioReceiptDependency(call, w.store, { dependencyId: 'step-parent', model: STEP, row: step, field: 'parent' });
  assert.equal(step.parent!.model, RUN);
  const run = await session.read(RUN, step.parent!.id); assert.ok(run);
  await observeScenarioReceiptDependency(call, w.store, { dependencyId: 'run-location', model: RUN, row: run, field: 'location' });
  await observeScenarioReceiptDependency(call, w.store, { dependencyId: 'run-targets', model: RUN, row: run, field: 'targets' });
  return { session, run };
}
async function save(w: World) {
  let receipt: Receipt | undefined, admitted: AdmittedCall | undefined;
  const result = await invoke({ ...w, execute: async call => {
    admitted = call;
    const { session, run } = await observe(call, w);
    const count = w.count(run.data['targets']);
    await session.stage({ op: 'update', model: RUN, id: run.id, data: { state: 'counted' } }, cause);
    selectScenarioReceiptReturn(call, w.store, 'target-count');
    return { ...await session.finalize(), result: String(count), outbox: [] };
  }, observeCommittedReceipt: value => { receipt = value; } });
  assert.equal(result.status, 'committed'); assert.equal(result.result, '3'); assert.ok(receipt); assert.ok(admitted);
  return { receipt, admitted };
}
async function update(w: World, model: typeof RUN, id: StoredRow['id'], changes: Partial<StoredRow>) {
  const current = await w.physical.load(model, id); assert.ok(current);
  await w.physical.commit(makeBatch(await w.physical.readRevision(), { writes: [{ kind: 'update', model, id,
    expectedVersion: current.version, row: { ...current, version: asVersion(current.version + 1), ...changes } }] }));
}

test('stored references preserve implicit parent, ordered duplicate wires, original count and one owner update through retained recovery', async () => {
  // A real matching row-visibility grant carries existing parent metadata
  // even when no authored Step field is projected.
  const w = await world({ stepFields: [] }); const { receipt, admitted } = await save(w);
  const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
  assert.deepEqual(association.observations.map(entry => [entry.model, entry.dependencyId]),
    [[STEP, 'step-parent'], [RUN, 'run-location'], [RUN, 'run-targets']]);
  assert.deepEqual(association.observations[0]!.row.parent, w.step.parent);
  assert.deepEqual(association.observations[1]!.row.data['location'], w.run.data['location']);
  assert.deepEqual(association.observations[2]!.row.data['targets'], targets());
  assert.equal(association.observations[2]!.row.version, w.run.version);
  assert.deepEqual(association.changed.map(entry => entry.model), [RUN]);
  assert.equal(association.changed[0]!.row.version, w.run.version + 1);
  for (const field of ['location', 'targets']) {
    assert.equal(association.changed[0]!.fieldTypes[field], null);
    assert.ok(association.changed[0]!.withheldFields.includes(field));
  }
  assert.equal((await w.store.historyFor(RUN, w.run.id)).length, 1);
  assert.equal(w.counts(), 1); assert.equal(w.referenceLoads(), 0); assert.equal(w.queries(), 0);
  const persisted = await w.store.readReceipt(receiptIdentityFor(admitted.context)); assert.deepEqual(persisted, receipt);
  const saved = JSON.parse(JSON.stringify(persisted)) as Receipt;
  assert.deepEqual(readScenarioReceiptAssociation(saved), association);
  const projected = await projectScenarioReceipt({ ...w, receipt: saved });
  assert.equal(projected.result, '3'); assert.equal(projected.records.length, 1);
  assert.deepEqual(projected.records[0]!.data, { reviewer: { id: w.subject.user_id }, state: 'counted' });
  const current = await w.physical.load(RUN, w.run.id); assert.ok(current);
  await update(w, RUN, current.id, { data: { ...current.data,
    location: { id: 'different-unloaded-location' }, targets: [{ id: 'different-unloaded-task', version: '99' }] } });
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt: saved }), projected);
  const before = await domain(w), revision = await w.store.readRevision(); let executes = 0, commits = 0;
  const store: StoragePort = { ...w.store, commit: async batch => { commits++; return w.store.commit(batch); } };
  assert.equal((await invokeRetainedReceiptOnly({ ...w, store, clock: { nowMs: () => FIXED_NOW + 16 * 60_000 },
    execute: async () => { executes++; return empty(); } })).status, 'replayed');
  assert.equal(executes, 0); assert.equal(commits, 0); assert.equal(w.counts(), 1);
  assert.equal(w.referenceLoads(), 0); assert.equal(w.queries(), 0);
  assert.deepEqual(await domain(w), before); assert.equal(await w.store.readRevision(), revision);
  const context = { actorUserId: w.caller.user_id, teamId: w.team.team_id, membership: w.caller, memberships: w.memberships };
  for (const [model, row] of [[TASK, w.task], [LOCATION, w.location]] as const) {
    assert.equal(await projectSavedRecordForViewer({ policy: w.policy.get(model), context,
      current: row, saved: row, originalSecretFields: [] }), null);
  }
});

test('nullable stored Task.location admits canonical null and reference wires without loading the referenced location', async () => {
  for (const wire of [null, { id: 'location-first' }, { id: 'location-first', version: '2' }]) {
    const w = await world({ task: true });
    await update(w, TASK, w.task.id, { data: { ...w.task.data, location: wire } });
    let receipt: Receipt | undefined;
    const result = await invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      const row = await session.read(TASK, w.task.id); assert.ok(row);
      await observeScenarioReceiptDependency(call, w.store, { dependencyId: 'task-location', model: TASK, row, field: 'location' });
      const value = row.data['location'] === null ? '0' : '1';
      await session.stage({ op: 'update', model: TASK, id: row.id, data: { title: 'Observed optional location' } }, cause);
      selectScenarioReceiptReturn(call, w.store, 'nullable-location');
      return { ...await session.finalize(), result: value, outbox: [] };
    }, observeCommittedReceipt: value => { receipt = value; } });
    assert.equal(result.status, 'committed'); assert.equal(result.result, wire === null ? '0' : '1'); assert.ok(receipt);
    const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
    assert.deepEqual(association.observations[0]!.row.data['location'], wire);
    assert.ok(association.changed[0]!.withheldFields.includes('location'));
    assert.equal((await projectScenarioReceipt({ ...w, receipt })).result, wire === null ? '0' : '1');
    assert.equal(w.locationLoads(), 0); assert.equal(w.queries(), 0);
  }
});

test('a genuine nested child retains reference influence without root dependencies and recovers its original scalar under current source authority', async () => {
  const ROOT = 'workbench.reviewStoredTargets', slice = artifact();
  slice.callables!.push({ id: ROOT, kind: 'operation', module: 'stored-reference.mjs', export: 'identity', member: ['reviewStoredTargets'] });
  slice.operations!.push({ name: ROOT, kind: 'scenario', description: '', inputs: { fields: [] }, result: {
    type: 'int' as CanTypeId, disclosure: { version: 1, source: origin(), returns: [{
      id: 'review-count', source: origin(), influences: [], dependencies: [],
    }] },
  } });
  const w = await world({}, undefined, slice), root = w.registry.get(ROOT) as GeneratedOperationDef;
  assert.deepEqual(root.descriptor.result!.disclosure!.returns[0]!.dependencies, []);
  let childExecutions = 0, rootExecutions = 0, finalizations = 0, commits = 0;
  let parentCall: AdmittedCall | undefined, childCall: AdmittedCall | undefined, receipt: Receipt | undefined;
  const originalCommit = w.store.commit;
  w.store.commit = async batch => { commits++; return originalCommit(batch); };
  bindScenarioReceiptCallProducer(root, { source: origin(), app: APP, registry: w.registry,
    sites: [{ id: 'stored-child', source: origin(), kind: 'operation', resultType: 'int' as CanTypeId,
      targets: [{ operation: OP, interface: w.def.descriptor }] }],
    prepare: (_def, inputs, parent) => { assert.equal(parent, parentCall); return inputs as ClosedInputs; },
    execute: async frame => {
      childExecutions++; childCall = frame.call;
      assert.equal(frame.parent, parentCall); assert.notEqual(frame.call, parentCall);
      const step = await frame.session.read(STEP, w.step.id); assert.ok(step);
      await observeScenarioReceiptDependency(frame.call, w.store,
        { dependencyId: 'step-parent', model: STEP, row: step, field: 'parent' });
      const run = await frame.session.read(RUN, step.parent!.id); assert.ok(run);
      await observeScenarioReceiptDependency(frame.call, w.store,
        { dependencyId: 'run-location', model: RUN, row: run, field: 'location' });
      await observeScenarioReceiptDependency(frame.call, w.store,
        { dependencyId: 'run-targets', model: RUN, row: run, field: 'targets' });
      const count = w.count(run.data['targets']);
      selectScenarioReceiptReturn(frame.call, w.store, 'target-count');
      return String(count);
    },
  });
  const envelope = makeEnvelope(ROOT, uuidv7(FIXED_NOW, ++sequence), {});
  const result = await invoke({ ...w, envelope, execute: async call => {
    rootExecutions++; parentCall = call;
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    const count = await invokeScenarioReceiptCall(call, w.store, { site: 'stored-child', target: OP,
      inputs: { step: { id: w.step.id, version: String(w.step.version) } } });
    assert.equal(count, '3');
    await session.stage({ op: 'update', model: RUN, id: w.run.id, data: { state: 'nested-counted' } }, cause);
    selectScenarioReceiptReturn(call, w.store, 'review-count'); finalizations++;
    const output = await session.finalize();
    assert.equal(output.writes.length, 1); assert.equal(output.history.length, 1);
    return { ...output, result: count, outbox: [] };
  }, observeCommittedReceipt: value => { receipt = value; } });
  assert.equal(result.status, 'committed'); assert.equal(result.result, '3'); assert.ok(receipt); assert.ok(childCall);
  assert.equal(rootExecutions, 1); assert.equal(childExecutions, 1); assert.equal(finalizations, 1); assert.equal(commits, 1);
  const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
  assert.deepEqual(association.observations, []); assert.equal(association.calls!.length, 1);
  const child = association.calls![0]!;
  assert.equal(child.target, OP); assert.equal(child.result, '3'); assert.equal(child.scenario!.returnId, 'target-count');
  assert.deepEqual(child.scenario!.observations.map(entry => [entry.model, entry.dependencyId]),
    [[STEP, 'step-parent'], [RUN, 'run-location'], [RUN, 'run-targets']]);
  assert.deepEqual(child.scenario!.observations[2]!.row.data['targets'], targets());
  const saved = JSON.parse(JSON.stringify(receipt)) as Receipt;
  assert.deepEqual(readScenarioReceiptAssociation(saved), association);
  const projected = await projectScenarioReceipt({ ...w, receipt: saved });
  assert.equal(projected.result, '3'); assert.equal(projected.records.length, 1);
  assert.deepEqual(projected.records[0]!.data, { reviewer: { id: w.subject.user_id }, state: 'nested-counted' });
  const current = await w.physical.load(RUN, w.run.id); assert.ok(current);
  await update(w, RUN, current.id, { data: { ...current.data, location: { id: 'another-unloaded-location' },
    targets: [{ id: 'another-unloaded-task', version: '99' }] } });
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt: saved }), projected);
  const before = await domain(w), revision = await w.store.readRevision();
  assert.equal((await invokeRetainedReceiptOnly({ ...w, envelope, clock: { nowMs: () => FIXED_NOW + 16 * 60_000 },
    execute: async () => { rootExecutions++; return empty(); } })).status, 'replayed');
  assert.equal(rootExecutions, 1); assert.equal(childExecutions, 1); assert.equal(finalizations, 1); assert.equal(commits, 1);
  const partial = policyFor(w.loaded, { runFields: ['location.id', 'targets', 'reviewer', 'state'] });
  assert.deepEqual(await projectScenarioReceipt({ ...w, policy: partial, receipt: saved }), { result: null, records: [] });
  await w.memberships.removeMembership(w.subject.membership_id);
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt: saved }), { result: null, records: [] });
  const context = { actorUserId: w.caller.user_id, teamId: w.team.team_id, membership: w.caller, memberships: w.memberships };
  for (const [model, row] of [[TASK, w.task], [LOCATION, w.location]] as const) {
    assert.equal(await projectSavedRecordForViewer({ policy: w.policy.get(model), context,
      current: row, saved: row, originalSecretFields: [] }), null);
  }
  await assert.rejects(observeScenarioReceiptDependency(childCall, w.store,
    { dependencyId: 'run-targets', model: RUN, row: child.scenario!.observations[2]!.row, field: 'targets' }), stateError);
  assert.equal(w.counts(), 1); assert.equal(w.referenceLoads(), 0); assert.equal(w.queries(), 0);
  assert.deepEqual(await domain(w), before); assert.equal(await w.store.readRevision(), revision);
});

test('stored reference observation rejects incomplete, malformed, wrong-model and out-of-bound source wires before computation', async () => {
  for (const mode of ['missing', 'null', 'empty', 'over-bound', 'numeric-version', 'leading-version', 'overflow-version',
    'unknown', 'wrong-model', 'empty-id', 'array-null', 'parent-missing', 'parent-model', 'parent-version', 'authored-parent'] as const) {
    const w = await world({}, (run, step) => {
      if (mode === 'missing') delete run['location'];
      if (mode === 'null') run['location'] = null;
      if (mode === 'empty') run['targets'] = [];
      if (mode === 'over-bound') run['targets'] = Array.from({ length: 11 }, () => ({ id: 'task-first' }));
      if (mode === 'numeric-version') run['location'] = { id: 'location-first', version: 2 };
      if (mode === 'leading-version') run['location'] = { id: 'location-first', version: '02' };
      if (mode === 'overflow-version') run['location'] = { id: 'location-first', version: '9223372036854775808' };
      if (mode === 'unknown') run['location'] = { id: 'location-first', model: LOCATION };
      if (mode === 'wrong-model') run['targets'] = [{ id: 'task-first', model: LOCATION }];
      if (mode === 'empty-id') run['location'] = { id: '' };
      if (mode === 'array-null') run['targets'] = [{ id: 'task-first' }, null];
      if (mode === 'parent-missing' || mode === 'authored-parent') Reflect.deleteProperty(step, 'parent');
      if (mode === 'parent-model') Object.assign(step, { parent: { model: TASK, id: 'run-first' } });
      if (mode === 'parent-version') Object.assign(step, { parent: { model: RUN, id: 'run-first', version: '1' } });
      if (mode === 'authored-parent') (step.data as Record<string, unknown>)['parent'] = { model: RUN, id: 'run-first' };
    });
    const before = await domain(w);
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      const model = mode.startsWith('parent-') || mode === 'authored-parent' ? STEP : RUN;
      const row = await session.read(model, model === STEP ? w.step.id : w.run.id); assert.ok(row);
      const field = model === STEP ? 'parent' : ['empty', 'over-bound', 'wrong-model', 'array-null'].includes(mode) ? 'targets' : 'location';
      await assert.rejects(observeScenarioReceiptDependency(call, w.store, { dependencyId: model === STEP ? 'step-parent'
        : field === 'targets' ? 'run-targets' : 'run-location', model, row, field }), stateError);
      await assert.rejects(session.finalize(), stateError); return empty();
    } }), stateError);
    assert.equal(w.counts(), 0); assert.equal(w.referenceLoads(), 0); assert.deepEqual(await domain(w), before);
  }
});

test('reference capture requires exact active current-stage owner rows and poisons copied, stale, foreign and caught carriers', async () => {
  for (const mode of ['raw', 'copy', 'stale', 'call', 'store', 'caught', 'accessor', 'missing', 'after-finalize'] as const) {
    const w = await world(); const before = await domain(w); let getters = 0;
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      const row = await session.read(RUN, w.run.id); assert.ok(row);
      if (mode === 'missing') { selectScenarioReceiptReturn(call, w.store, 'target-count'); return empty(); }
      if (mode === 'stale') await session.stage({ op: 'update', model: RUN, id: row.id, data: { state: 'new stage' } }, cause);
      if (mode === 'after-finalize') await session.finalize();
      const candidate = mode === 'raw' ? w.run : ['copy', 'caught', 'accessor'].includes(mode) ? { ...row } : row;
      if (mode === 'accessor') Object.defineProperty(candidate, 'data', { enumerable: true,
        get: () => { getters++; return row.data; } });
      await assert.rejects(observeScenarioReceiptDependency(mode === 'call' ? { ...call } : call,
        mode === 'store' ? { ...w.store } : w.store, { dependencyId: 'run-targets', model: RUN, row: candidate, field: 'targets' }), stateError);
      if (mode === 'caught') await assert.rejects(observeScenarioReceiptDependency(call, w.store,
        { dependencyId: 'run-targets', model: RUN, row, field: 'targets' }), stateError);
      await assert.rejects(session.finalize(), stateError); return empty();
    } }), stateError);
    assert.equal(getters, 0); assert.equal(w.counts(), 0); assert.deepEqual(await domain(w), before);
  }
  const w = await world(); const { admitted } = await save(w);
  await assert.rejects(observeScenarioReceiptDependency(admitted, w.store,
    { dependencyId: 'run-targets', model: RUN, row: w.run, field: 'targets' }), stateError);
});

test('reference source permission is checked before promotion, including partial bare-id grants and hidden implicit-parent rows', async () => {
  for (const mode of ['partial', 'partial-id-only', 'hidden-run', 'hidden-step', 'secret', 'subject', 'app', 'unbound'] as const) {
    const options: PolicyOptions = mode === 'hidden-step' ? { stepVisible: false }
      : mode === 'hidden-run' ? { runFields: ['state', 'reviewer'] }
      : mode.startsWith('partial') ? { runFields: ['location.id', 'targets', 'state', 'reviewer'] }
      : mode === 'secret' ? { runFields: ['targets', 'state', 'reviewer'], runSecrets: ['location'] } : {};
    const w = await world(options, mode === 'partial-id-only' ? run => { run['location'] = { id: 'location-first' }; } : undefined,
      artifact(), mode !== 'unbound');
    if (mode === 'subject') await w.memberships.removeMembership(w.subject.membership_id);
    const before = await domain(w);
    await assert.rejects(invoke({ ...w, app: mode === 'app' ? 'another-app' : APP, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      const model = mode === 'hidden-step' ? STEP : RUN;
      const row = await session.read(model, model === STEP ? w.step.id : w.run.id); assert.ok(row);
      await assert.rejects(observeScenarioReceiptDependency(call, w.store, { dependencyId: model === STEP ? 'step-parent' : 'run-location',
        model, row, field: model === STEP ? 'parent' : 'location' }), stateError);
      await assert.rejects(session.finalize(), stateError); return empty();
    } }), stateError);
    assert.equal(w.counts(), 0); assert.equal(w.referenceLoads(), 0);
    assert.deepEqual(await domain(w), before);
  }
});

test('reference producer binds one checked source, app and actual policy before invocation and rejects getters without execution', async () => {
  for (const mode of ['raw', 'copy', 'source', 'app', 'policy', 'getter', 'type', 'duplicate'] as const) {
    const w = await world({}, undefined, artifact(), false); let getters = 0;
    const producer: Parameters<typeof bindScenarioReceiptReferenceProducer>[1] = { source: origin(), app: APP, policy: w.policy };
    if (mode === 'source') Object.assign(producer, { source: origin('f'.repeat(64)) });
    if (mode === 'app') Object.assign(producer, { app: '' });
    if (mode === 'policy') Object.assign(producer, { policy: {} });
    if (mode === 'type') Object.assign(producer, { policy: new Map([[RUN, { model: TASK, secretFields: [], grants: [] }]]) });
    if (mode === 'getter') Object.defineProperty(producer, 'policy', { enumerable: true, get: () => { getters++; return w.policy; } });
    if (mode === 'duplicate') bindScenarioReceiptReferenceProducer(w.def, producer);
    assert.throws(() => bindScenarioReceiptReferenceProducer(mode === 'raw' ? artifact().operations![0] as unknown as GeneratedOperationDef
      : mode === 'copy' ? { ...w.def } : w.def, producer), stateError);
    assert.equal(getters, 0);
  }
  const w = await world(); await save(w);
  assert.throws(() => bindScenarioReceiptReferenceProducer(w.def, { source: origin(), app: APP, policy: w.policy }), stateError);
  for (const mode of ['wrong-type', 'wrong-field', 'wrong-target', 'array-bound', 'parent-target', 'authored-parent'] as const) {
    const slice = artifact(), dependencies = slice.operations![0]!.result!.disclosure!.returns[0]!.dependencies;
    if (mode === 'wrong-type') Object.assign(dependencies[2]!, { type: `${TASK}[]` });
    if (mode === 'wrong-field') Object.assign(dependencies[1]!, { field: 'location.id' });
    if (mode === 'wrong-target') Object.assign(slice.models![1]!.fields[0]!, { field: { kind: 'ref', model: TASK } });
    if (mode === 'array-bound') Object.assign(slice.models![1]!.fields[1]!, { max: '10' });
    if (mode === 'parent-target') Object.assign(dependencies[0]!, { type: TASK });
    if (mode === 'authored-parent') slice.models![0]!.fields.push({ name: 'parent', field: { kind: 'ref', model: RUN },
      valueType: RUN as CanTypeId, required: true, serverOnly: false });
    assert.throws(() => loadArtifactDescriptors(slice, { by: 'members' }), mode);
  }
});

test('saved reference scalar requires current whole-field authority, canonical type, original lifetime and exact parent containment', async () => {
  for (const mode of ['partial', 'private', 'secret', 'subject', 'caller', 'subject-field', 'owner', 'archive', 'remove', 'recreate', 'missing', 'malformed',
    'wrong-model-wire', 'parent', 'parent-id', 'parent-archive', 'type', 'schema', 'source', 'secrecy'] as const) {
    const w = await world(); const { receipt } = await save(w);
    let policy = w.policy, registry = w.registry;
    if (mode === 'partial') policy = policyFor(w.loaded, { runFields: ['location.id', 'targets', 'reviewer', 'state'] });
    if (mode === 'private') policy = policyFor(w.loaded, { runFields: ['state'] });
    if (mode === 'secret') policy = policyFor(w.loaded, { runFields: ['targets', 'reviewer', 'state'], runSecrets: ['location'] });
    if (mode === 'subject') await w.memberships.removeMembership(w.subject.membership_id);
    if (mode === 'caller') await w.memberships.removeMembership(w.caller.membership_id);
    const current = await w.physical.load(RUN, w.run.id); assert.ok(current);
    if (mode === 'subject-field') await update(w, RUN, current.id, { data: { ...current.data, reviewer: { id: 'unprivileged-reviewer' } } });
    if (mode === 'owner') await update(w, RUN, current.id, { createdBy: 'another-owner' });
    if (mode === 'archive') await update(w, RUN, current.id, { archivedAt: FIXED_NOW + 1 });
    if (mode === 'remove' || mode === 'recreate') {
      await w.physical.commit(makeBatch(await w.physical.readRevision(), { writes: [{ kind: 'remove', model: RUN,
        id: current.id, expectedVersion: current.version }] }));
      if (mode === 'recreate') await seedRow(w.physical, RUN, { id: current.id, created: current.created + 1,
        version: current.version + 1, data: { ...current.data } });
    }
    if (['missing', 'malformed', 'wrong-model-wire'].includes(mode)) {
      const data = structuredClone(current.data) as Record<string, unknown>;
      if (mode === 'missing') delete data['location'];
      if (mode === 'malformed') data['targets'] = [];
      if (mode === 'wrong-model-wire') data['location'] = { id: 'location-first', model: TASK };
      await update(w, RUN, current.id, { data });
    }
    if (mode === 'parent') await update(w, STEP, w.step.id, { parent: { model: TASK, id: w.task.id } });
    if (mode === 'parent-id') await update(w, STEP, w.step.id, { parent: { model: RUN, id: asId('another-run') } });
    if (mode === 'parent-archive') await update(w, STEP, w.step.id, { archivedAt: FIXED_NOW + 1 });
    if (['type', 'schema', 'source', 'secrecy'].includes(mode)) {
      const slice = artifact(mode === 'source' ? 'f'.repeat(64) : undefined);
      if (mode === 'type') {
        Object.assign(slice.models![1]!.fields[0]!, { field: { kind: 'ref', model: TASK }, valueType: TASK });
        Object.assign(slice.operations![0]!.result!.disclosure!.returns[0]!.dependencies[1]!, { type: TASK });
      }
      if (mode === 'schema') Object.assign(slice.models![1]!.fields[1]!, { max: 2 });
      if (mode === 'secrecy') {
        Object.assign(slice.models![1]!.fields[0]!, { field: { kind: 'secret' }, serverOnly: true });
        Reflect.deleteProperty(slice.models![1]!.fields[0]!, 'valueType');
        Object.assign(slice.operations![0]!.result!.disclosure!.returns[0]!, { dependencies:
          slice.operations![0]!.result!.disclosure!.returns[0]!.dependencies.filter(dep => dep.id !== 'run-location') });
      }
      registry = loadArtifactDescriptors(slice, { by: 'members' }).registry;
    }
    const before = await domain(w), revision = await w.store.readRevision();
    assert.deepEqual(await projectScenarioReceipt({ ...w, policy, registry, receipt: JSON.parse(JSON.stringify(receipt)) as Receipt }),
      { result: null, records: [] }, mode);
    assert.equal(w.counts(), 1); assert.equal(w.referenceLoads(), 0); assert.equal(w.queries(), 0);
    assert.deepEqual(await domain(w), before); assert.equal(await w.store.readRevision(), revision);
  }
});

test('reference business fence rechecks observed full Identity facts and final source authority without callback recomputation', async () => {
  for (const mode of ['revoked', 'full-facts', 'subject-swap', 'final-private'] as const) {
    const w = await world(mode === 'final-private' ? { by: 'members',
      when: { op: 'eq', field: 'state', value: 'open' } } : {});
    const before = await domain(w); let executes = 0, committed = 0;
    const alternate = await w.memberships.createMembership({ team_id: w.team.team_id, user_id: 'another-reviewer',
      is_owner: false, roles: w.subject.roles });
    await assert.rejects(invoke({ ...w, execute: async call => {
      executes++;
      const { session, run } = await observe(call, w); const count = w.count(run.data['targets']);
      await session.stage({ op: 'update', model: RUN, id: run.id,
        data: { state: 'counted', ...(mode === 'subject-swap' ? { reviewer: { id: alternate.user_id } } : {}) } }, cause);
      selectScenarioReceiptReturn(call, w.store, 'target-count');
      const output = await session.finalize();
      if (mode === 'revoked') await w.memberships.removeMembership(w.subject.membership_id);
      if (mode === 'full-facts') await w.memberships.setMembershipRoles(w.subject.membership_id, [...w.subject.roles,
        { role: 'workbench.other', granted_at: w.subject.updated_at, granted_by: w.caller.user_id }]);
      return { ...output, result: String(count), outbox: [] };
    }, observeCommittedReceipt: () => { committed++; } }), stateError);
    assert.equal(executes, 1); assert.equal(w.counts(), 1); assert.equal(committed, 0);
    assert.equal(w.referenceLoads(), 0); assert.deepEqual(await domain(w), before);
  }
});

test('reference observation poisons concurrent source validation and refuses a moved admitted State revision', async () => {
  for (const mode of ['concurrent', 'revision'] as const) {
    const w = await world(); const before = await domain(w);
    let delay = false, enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const store: StoragePort = { ...w.store, load: async (model, id) => {
      if (delay && model === RUN) { delay = false; enter(); await blocked; }
      return w.store.load(model, id);
    } };
    await assert.rejects(invoke({ ...w, store, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, store, { table: w.table, bounds });
      const row = await session.read(RUN, w.run.id); assert.ok(row);
      if (mode === 'revision') await w.physical.commit(makeBatch(await w.physical.readRevision()));
      const input = { dependencyId: 'run-location', model: RUN, row, field: 'location' };
      if (mode === 'concurrent') {
        delay = true; const first = observeScenarioReceiptDependency(call, store, input);
        await entered;
        await assert.rejects(observeScenarioReceiptDependency(call, store, input), stateError);
        release(); await assert.rejects(first, stateError);
      } else await assert.rejects(observeScenarioReceiptDependency(call, store, input), stateError);
      await assert.rejects(session.finalize(), stateError); return empty();
    } }), stateError);
    assert.equal(w.counts(), 0); assert.equal(w.referenceLoads(), 0); assert.deepEqual(await domain(w), before);
  }
});

test('saved reference source projection withholds after final await revocation and coherent Identity metadata drift', async () => {
  for (const mode of ['final-await', 'snapshot-drift'] as const) {
    const w = await world(); const { receipt } = await save(w); let loads = 0, snapshots = 0;
    const store: StoragePort = { ...w.store, load: async (model, id) => {
      const row = await w.store.load(model, id);
      if (mode === 'final-await' && model === RUN && ++loads === 4) await w.memberships.removeMembership(w.subject.membership_id);
      return row;
    } };
    const memberships: MembershipReader = { findMembership: w.memberships.findMembership,
      findMembershipsSnapshot: async (team, users) => {
        snapshots++;
        const snapshot = await w.memberships.findMembershipsSnapshot(team, users);
        if (mode === 'snapshot-drift' && snapshots === 1) await w.memberships.setMembershipRoles(w.subject.membership_id,
          [...w.subject.roles, { role: 'workbench.other', granted_at: w.subject.updated_at, granted_by: w.caller.user_id }]);
        return snapshot;
      } };
    const before = await domain(w), revision = await w.store.readRevision();
    assert.deepEqual(await projectScenarioReceipt({ ...w, store, memberships, receipt }), { result: null, records: [] });
    if (mode === 'final-await') assert.ok(loads >= 4);
    else assert.ok(snapshots >= 2);
    assert.equal(w.counts(), 1); assert.equal(w.referenceLoads(), 0);
    assert.deepEqual(await domain(w), before); assert.equal(await w.store.readRevision(), revision);
  }
});
