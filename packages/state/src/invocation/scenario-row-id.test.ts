/** Defining State components with hand-built frozen descriptors and real Memory/Identity.
 * This qualifies receipt row metadata only, not Compiler/native ImageRequest execution. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, ClosedInputs, ModelName, Receipt, StoredRow } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { StateError } from '../errors.js';
import { createMemoryStorage } from '../storage/memory.js';
import { buildModelTable } from '../mutation/models.js';
import { buildPolicyTable } from '../policy/grants.js';
import type { ViewerSourceReadPolicy } from '../query/source-policy.js';
import type { AdmittedCall } from './admission.js';
import { invoke, invokeRetainedReceiptOnly, type ExecutionEffects } from './invoke.js';
import { loadArtifactDescriptors, isGeneratedOperationDef, type ArtifactDescriptorSlice } from './registry.js';
import { beginScenarioReceiptMutation, bindScenarioReceiptReferenceProducer, observeScenarioReceiptRowId,
  observeScenarioReceiptDependency, selectScenarioReceiptReturn, projectScenarioReceipt, readScenarioReceiptAssociation,
  bindScenarioReceiptCallProducer, invokeScenarioReceiptCall } from './scenario-receipt.js';
import { field, modelDef } from '../../test/mutation/fixtures.js';
import { asId, asModel, asVersion, FIXED_NOW, makeBatch, makeEnvelope, makeIdentity, makeRow, uuidv7 } from '../../test/invocation/fixtures.js';

const MODEL = asModel('RowId.Job'), PARENT = asModel('RowId.Other');
const ROOT = 'RowId.start', CHILD = 'RowId.child', APP = 'row-id-components', TEAM = 'row-id-team';
const CREATED = asId('new-job'), EXISTING = asId('existing-job'), PARENT_ID = asId('parent');
const cause = { cause: 'scenario' } as const, bounds = { maxRows: 8, maxWork: 1000 };
const source = { path: 'row-id.can', sha256: 'a'.repeat(64), module: 'row-id.mjs' };
const childSource = { path: 'row-id-child.can', sha256: 'b'.repeat(64), module: 'row-id-child.mjs' };
const refuses = (error: unknown) => error instanceof StateError;
let sequence = 98_000;
function artifact(contained = false, archive = false): ArtifactDescriptorSlice {
  return { artifact_version: 1, sources: [source, childSource].map(({ path, sha256 }) => ({ path, sha256 })),
    modules: [source, childSource].map(origin => ({ path: origin.module, js: 'export const identity="RowId";', map: {
      version: 3, file: origin.module, sources: [origin.path], sourcesContent: [null], names: [], mappings: '',
    } })), callables: [ROOT, CHILD].map((id, i) => ({ id, kind: 'operation' as const,
      module: i ? childSource.module : source.module, export: 'identity', member: [id.split('.').at(-1)!] })),
    models: [MODEL, PARENT].map(name => ({ name, deleteMode: archive && name === MODEL ? 'archive' as const : 'remove' as const,
      ...(contained && name === MODEL ? { parent: PARENT } : {}), fields: [
        { name: 'title', field: { kind: 'string' as const }, required: true, serverOnly: false },
        { name: 'author', field: { kind: 'string' as const }, required: true, serverOnly: false },
      ] })), operations: [ROOT, CHILD].map((name, i) => { const origin = i ? childSource : source; return {
        name, kind: 'scenario' as const, description: '', inputs: { fields: [
          { name: 'job', field: { kind: 'ref' as const, model: MODEL, requireVersion: true }, required: true },
        ] }, result: { type: 'text' as CanTypeId, disclosure: { version: 1 as const, source: origin, returns: [
          { id: 'return', source: origin, influences: [], dependencies: [
            { id: 'job-id', source: origin, role: 'data' as const, model: MODEL, field: 'id', type: 'text' as CanTypeId },
          ] },
        ] } },
      }; }),
  };
}
async function world(options: { contained?: boolean; archive?: boolean; fields?: string[]; bind?: boolean; slice?: ArtifactDescriptorSlice } = {}) {
  const memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const caller = await memberships.createMembership({ team_id: TEAM, user_id: 'caller', is_owner: false, roles: [] });
  const author = await memberships.createMembership({ team_id: TEAM, user_id: 'author', is_owner: false, roles: [] });
  const parentAuthor = await memberships.createMembership({ team_id: TEAM, user_id: 'parent-author', is_owner: false, roles: [] });
  const store = createMemoryStorage(), contained = options.contained ?? false;
  const loaded = loadArtifactDescriptors(options.slice ?? artifact(contained, options.archive), { by: 'members' });
  const root = loaded.registry.get(ROOT), child = loaded.registry.get(CHILD);
  assert.ok(root && isGeneratedOperationDef(root)); assert.ok(child && isGeneratedOperationDef(child));
  const table = buildModelTable([MODEL, PARENT].map(name => ({ ...modelDef(name, { deleteMode: options.archive && name === MODEL ? 'archive' : 'remove', fields: {
    title: field({ required: true }), author: field({ required: true }),
  } }), ...(contained && name === MODEL ? { containment: { parent: PARENT } } : {}) })));
  const parent = makeRow({ id: PARENT_ID, data: { title: 'Parent', author: 'parent-author' } });
  const old = { ...makeRow({ id: EXISTING, version: 4, data: { title: 'Old', author: 'author' } }),
    parent: contained ? { model: PARENT, id: PARENT_ID } : null };
  await store.commit(makeBatch(await store.readRevision(), { writes: [
    { kind: 'insert', model: PARENT, row: parent }, { kind: 'insert', model: MODEL, row: old },
  ] }));
  const access = { row: true, parent: true, child: true };
  const hooks: { read?: () => Promise<void> } = {};
  const policy = buildPolicyTable([MODEL, PARENT].map(model => ({ model, secretFields: [],
    grants: [{ by: 'members' as const, fields: ['id', 'title', 'author'] }] })));
  function sourcePolicies(child = false) {
    return new Map<ModelName, ViewerSourceReadPolicy>([MODEL, PARENT].map(model => [model, {
      ...(contained && model === MODEL ? { parent: PARENT } : {}), fields: ['title', 'author'], secretFields: [],
      grants: [{ fields: options.fields ?? ['id', 'title'], read: async ({ context, row }) => {
        const subject = await context.memberships.findMembership(TEAM, row.data.author as string);
        await hooks.read?.();
        return (model === MODEL ? access.row && (!child || access.child) : access.parent) &&
          subject?.status === 'active' && context.membership?.status === 'active';
      } }],
    } ]));
  }
  const readPolicies = sourcePolicies(), childReadPolicies = sourcePolicies(true);
  if (options.bind !== false) {
    bindScenarioReceiptReferenceProducer(root, { source, app: APP, policy, readPolicies });
    bindScenarioReceiptReferenceProducer(child, { source: childSource, app: APP, policy, readPolicies: childReadPolicies });
  }
  return { store, memberships, caller, author, parentAuthor, root, child, table, policy, readPolicies, childReadPolicies,
    contained, old, parent, access, hooks, registry: loaded.registry, app: APP, source: 'component',
    clock: { nowMs: () => FIXED_NOW }, identity: makeIdentity({ membership: caller }),
    envelope: makeEnvelope(ROOT, uuidv7(FIXED_NOW, ++sequence), { job: { id: EXISTING, version: '4' } }) };
}
type World = Awaited<ReturnType<typeof world>>;
type Session = Awaited<ReturnType<typeof beginScenarioReceiptMutation>>;
const empty = (): ExecutionEffects => ({ result: null, writes: [], history: [], outbox: [], schedules: [],
  uniqueClaims: [], uniqueReleases: [], resolvedDefaults: {} });
async function finish(call: AdmittedCall, w: World, session: Session | undefined, result: string) {
  selectScenarioReceiptReturn(call, w.store, 'return');
  return { ...(session ? await session.finalize() : empty()), result, outbox: [] };
}
async function created(session: Session, w: World) {
  await session.stage({ op: 'create', model: MODEL, id: CREATED, data: { title: 'Created', author: 'author' },
    ...(w.contained ? { parent: { model: PARENT, id: PARENT_ID } } : {}) }, cause);
  const row = await session.read(MODEL, CREATED); assert.ok(row); return row;
}
async function unchanged(w: World) {
  assert.equal(await w.store.load(MODEL, CREATED), null);
  assert.deepEqual(await w.store.load(MODEL, EXISTING), w.old);
  assert.deepEqual(await w.store.historyFor(MODEL, CREATED), []);
  assert.deepEqual(await w.store.outboxPending(), []);
}
async function physicalUpdate(w: World, model: ModelName, id: StoredRow['id'], changes: Partial<StoredRow>) {
  const row = await w.store.load(model, id); assert.ok(row);
  await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'update', model, id,
    expectedVersion: row.version, row: { ...row, ...changes, version: asVersion(row.version + 1) } }] }));
}
async function save(w: World, admitted = false, noOwner = false) {
  let receipt: Receipt | undefined, captured: AdmittedCall | undefined, executions = 0;
  const input = { ...w, observeCommittedReceipt: (value: Receipt) => { receipt = value; }, execute: async (call: AdmittedCall) => {
    executions++; captured = call;
    const session = noOwner ? undefined : await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    const row = session && !admitted ? await created(session, w) : undefined;
    if (session && admitted) await session.stage({ op: 'update', model: MODEL, id: EXISTING, data: { title: 'Before capture' } }, cause);
    const id = await observeScenarioReceiptRowId(call, w.store, row
      ? { dependencyId: 'job-id', model: MODEL, row }
      : { dependencyId: 'job-id', model: MODEL, reference: call.recordRefs[0]! });
    assert.equal(id, admitted || noOwner ? EXISTING : CREATED);
    if (session) await session.stage({ op: 'update', model: MODEL, id: asId(id), data: { title: 'After capture' } }, cause);
    return finish(call, w, session, id);
  } };
  assert.equal((await invoke(input)).status, 'committed'); assert.ok(receipt); assert.ok(captured);
  return { receipt, call: captured, input, executions: () => executions };
}

test('current created/existing row envelope IDs capture once, survive later data updates and retain exact admitted originals', async () => {
  for (const fields of [['id'], ['title']]) {
    const w = await world({ fields }); const saved = await save(w);
    const association = readScenarioReceiptAssociation(saved.receipt); assert.ok(association);
    assert.equal(association.observations.length, 1);
    assert.equal(association.observations[0]!.row.id, CREATED);
    assert.equal(Object.hasOwn(association.observations[0]!.row.data, 'id'), false);
    assert.deepEqual((await projectScenarioReceipt({ ...w, receipt: saved.receipt })).result, CREATED);
    assert.equal((await invoke(saved.input)).status, 'replayed'); assert.equal(saved.executions(), 1);
  }
  for (const noOwner of [false, true]) {
    const w = await world(); const saved = await save(w, true, noOwner);
    const association = readScenarioReceiptAssociation(saved.receipt); assert.ok(association);
    assert.equal(association.observations[0]!.row.version, 4);
    assert.deepEqual(association.observations[0]!.row.data, w.old.data);
    assert.equal((await projectScenarioReceipt({ ...w, receipt: saved.receipt })).result, EXISTING);
  }
  const w = await world();
  await invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    const row = await session.read(MODEL, EXISTING); assert.ok(row);
    await observeScenarioReceiptDependency(call, w.store, { dependencyId: 'job-id', model: MODEL, row, field: 'id' });
    await session.stage({ op: 'update', model: MODEL, id: EXISTING, data: { title: 'Current existing' } }, cause);
    return finish(call, w, session, row.id);
  } });
});

test('copied, raw, stale, foreign and mismatched row/reference carriers poison even caught capture failures', async () => {
  for (const mode of ['copy-row', 'raw', 'stale', 'foreign', 'call', 'store', 'model', 'dependency', 'copy-reference', 'foreign-reference', 'admitted-row'] as const) {
    const w = await world();
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      let row = await created(session, w);
      if (mode === 'stale') await session.stage({ op: 'update', model: MODEL, id: CREATED, data: { title: 'Stale' } }, cause);
      if (mode === 'foreign') { const other = await session.read(PARENT, PARENT_ID); assert.ok(other); row = other; }
      const rowInput = { dependencyId: mode === 'dependency' ? 'unknown' : 'job-id', model: mode === 'model' ? PARENT : MODEL,
        row: mode === 'copy-row' ? structuredClone(row) : mode === 'raw' ? { id: row.id } as StoredRow
          : mode === 'admitted-row' ? call.recordRefs[0]!.row : row };
      const input = mode === 'copy-reference' || mode === 'foreign-reference'
        ? { dependencyId: 'job-id', model: MODEL, reference: mode === 'copy-reference' ? { ...call.recordRefs[0]! }
          : { ...call.recordRefs[0]!, model: PARENT, row: w.parent } } : rowInput;
      await assert.rejects(observeScenarioReceiptRowId(mode === 'call' ? { ...call } : call,
        mode === 'store' ? { ...w.store } : w.store, input), refuses, mode);
      await assert.rejects(session.finalize(), refuses, mode); return empty();
    } }), refuses, mode);
    await unchanged(w);
  }
});

test('source row and complete ancestry grants are required initially, including tracked subject membership', async () => {
  for (const mode of ['row', 'ancestor', 'subject', 'missing-producer', 'wrong-app'] as const) {
    const w = await world({ contained: true, bind: mode !== 'missing-producer' });
    if (mode === 'row') w.access.row = false;
    if (mode === 'ancestor') w.access.parent = false;
    if (mode === 'subject') await w.memberships.removeMembership(w.author.membership_id);
    await assert.rejects(invoke({ ...w, app: mode === 'wrong-app' ? 'foreign-app' : APP, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      const row = await created(session, w);
      await assert.rejects(observeScenarioReceiptRowId(call, w.store, { dependencyId: 'job-id', model: MODEL, row }), refuses);
      await assert.rejects(session.finalize(), refuses); return empty();
    } }), refuses, mode); await unchanged(w);
  }
});

test('row metadata admits only id:text and the defining installed producer source', async () => {
  for (const mode of ['version', 'created', 'parent', 'wrong-type'] as const) {
    const slice = artifact(), dep = slice.operations![0]!.result!.disclosure!.returns[0]!.dependencies[0]!;
    if (mode === 'wrong-type') Object.assign(dep, { type: 'int' });
    else Object.assign(dep, { field: mode });
    assert.throws(() => loadArtifactDescriptors(slice, { by: 'members' }), mode);
  }
  const foreignSource = artifact();
  Object.assign(foreignSource.operations![0]!.result!.disclosure!.returns[0]!.dependencies[0]!, { source: childSource });
  const foreign = await world({ slice: foreignSource });
  await assert.rejects(invoke({ ...foreign, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, foreign.store, { table: foreign.table, bounds });
    const row = await created(session, foreign);
    await observeScenarioReceiptRowId(call, foreign.store, { dependencyId: 'job-id', model: MODEL, row });
    return finish(call, foreign, session, row.id);
  } }), refuses); await unchanged(foreign);
  const w = await world({ bind: false });
  assert.throws(() => bindScenarioReceiptReferenceProducer(w.root,
    { source: childSource, app: APP, policy: w.policy, readPolicies: w.readPolicies }), refuses);
});

test('double, late and concurrent exact-site captures refuse; complete awaited authority precedes return', async () => {
  for (const mode of ['double', 'late', 'concurrent', 'await-revoke', 'await-stage', 'await-fence', 'await-identity'] as const) {
    const w = await world(); let awaitedDriftAttempted = false;
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      const row = await created(session, w), input = { dependencyId: 'job-id', model: MODEL, row };
      if (mode === 'double' || mode === 'late') await observeScenarioReceiptRowId(call, w.store, input);
      if (mode === 'late') selectScenarioReceiptReturn(call, w.store, 'return');
      if (mode === 'concurrent') {
        let enter!: () => void, release!: () => void;
        const entered = new Promise<void>(resolve => { enter = resolve; });
        const blocked = new Promise<void>(resolve => { release = resolve; });
        w.hooks.read = async () => { enter(); await blocked; };
        const first = observeScenarioReceiptRowId(call, w.store, input); await entered;
        await assert.rejects(observeScenarioReceiptRowId(call, w.store, input), refuses);
        release(); await assert.rejects(first, refuses);
      } else {
        if (mode.startsWith('await-')) w.hooks.read = async () => {
          awaitedDriftAttempted = true;
          delete w.hooks.read;
          if (mode === 'await-revoke') w.access.row = false;
          if (mode === 'await-stage') await session.stage({ op: 'update', model: MODEL, id: CREATED, data: { title: 'Racing' } }, cause);
          if (mode === 'await-fence') await w.store.commit(makeBatch(await w.store.readRevision()));
          if (mode === 'await-identity') await w.memberships.setMembershipRoles(w.author.membership_id,
            [{ role: 'RowId.extra', granted_at: w.author.updated_at, granted_by: w.caller.user_id }]);
        };
        await assert.rejects(observeScenarioReceiptRowId(call, w.store, input), refuses, mode);
      }
      await assert.rejects(session.finalize(), refuses); return empty();
    } }), refuses, mode); await unchanged(w);
    if (mode.startsWith('await-')) assert.equal(awaitedDriftAttempted, true, mode);
  }
});

test('final removal, archive, replacement, parent, grant and full Identity drift roll back owner writes', async () => {
  for (const mode of ['remove', 'archive', 'recreate', 'parent', 'grant', 'ancestor', 'subject', 'full-identity', 'post-finalize'] as const) {
    const w = await world({ contained: true, archive: mode === 'archive' });
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      const row = await created(session, w);
      const id = await observeScenarioReceiptRowId(call, w.store, { dependencyId: 'job-id', model: MODEL, row });
      if (mode === 'remove' || mode === 'recreate') {
        await session.stage({ op: 'remove', model: MODEL, id: CREATED }, cause);
        if (mode === 'recreate') await created(session, w);
      }
      if (mode === 'archive') await session.stage({ op: 'remove', model: MODEL, id: CREATED }, cause);
      if (mode === 'parent') await session.stage({ op: 'remove', model: PARENT, id: PARENT_ID }, cause);
      if (mode === 'grant') w.access.row = false;
      if (mode === 'ancestor') w.access.parent = false;
      if (mode === 'subject') await w.memberships.removeMembership(w.author.membership_id);
      if (mode === 'full-identity') await w.memberships.setMembershipRoles(w.author.membership_id,
        [{ role: 'RowId.extra', granted_at: w.author.updated_at, granted_by: w.caller.user_id }]);
      const output = await finish(call, w, session, id);
      if (mode === 'post-finalize') await w.memberships.setMembershipRoles(w.author.membership_id,
        [{ role: 'RowId.extra', granted_at: w.author.updated_at, granted_by: w.caller.user_id }]);
      return output;
    } }), refuses, mode); await unchanged(w);
  }
});

test('retained JSON row IDs recover without execution and mask result/changes after current source, ancestor, Identity or lifetime loss', async () => {
  for (const mode of ['grant', 'ancestor', 'subject', 'caller', 'archive', 'remove', 'recreate', 'parent'] as const) {
    const w = await world({ contained: true }); const saved = await save(w);
    const receipt = JSON.parse(JSON.stringify(saved.receipt)) as Receipt;
    assert.equal((await projectScenarioReceipt({ ...w, receipt })).result, CREATED);
    let executions = 0;
    assert.equal((await invokeRetainedReceiptOnly({ ...w, clock: { nowMs: () => FIXED_NOW + 16 * 60_000 },
      execute: async () => { executions++; throw new Error('retained recovery must not execute'); } })).status, 'replayed');
    assert.equal(executions, 0); assert.equal(saved.executions(), 1);
    if (mode === 'grant') w.access.row = false;
    if (mode === 'ancestor') w.access.parent = false;
    if (mode === 'subject') await w.memberships.removeMembership(w.author.membership_id);
    if (mode === 'caller') await w.memberships.removeMembership(w.caller.membership_id);
    if (mode === 'archive') await physicalUpdate(w, MODEL, CREATED, { archivedAt: FIXED_NOW + 1 });
    if (mode === 'parent') await physicalUpdate(w, MODEL, CREATED, { parent: { model: PARENT, id: asId('foreign-parent') } });
    if (mode === 'remove' || mode === 'recreate') {
      const current = await w.store.load(MODEL, CREATED); assert.ok(current);
      await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'remove', model: MODEL,
        id: CREATED, expectedVersion: current.version }] }));
      if (mode === 'recreate') await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'insert', model: MODEL,
        row: { ...makeRow({ id: CREATED, created: FIXED_NOW + 1, createdBy: 'replacement',
          data: { title: 'Replacement', author: 'author' } }), parent: { model: PARENT, id: PARENT_ID } } }] }));
    }
    const revision = await w.store.readRevision();
    assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] }, mode);
    assert.equal(await w.store.readRevision(), revision); assert.equal(saved.executions(), 1);
  }
});

test('nested child captures use their own installed source and retained recovery never executes the child', async () => {
  const w = await world(); let executions = 0, receipt: Receipt | undefined;
  bindScenarioReceiptCallProducer(w.root, { source, app: APP, registry: w.registry,
    sites: [{ id: 'child-site', source, kind: 'operation', targets: [{ operation: CHILD, interface: w.child.descriptor }], resultType: 'text' }],
    prepare: (_def, inputs) => inputs as ClosedInputs, execute: async frame => {
      executions++; const row = await frame.session.read(MODEL, EXISTING); assert.ok(row);
      const id = await observeScenarioReceiptRowId(frame.call, w.store, { dependencyId: 'job-id', model: MODEL, row });
      selectScenarioReceiptReturn(frame.call, w.store, 'return'); return id;
    } });
  const input = { ...w, observeCommittedReceipt: (value: Receipt) => { receipt = value; }, execute: async (call: AdmittedCall) => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    const id = await invokeScenarioReceiptCall(call, w.store, { site: 'child-site', target: CHILD,
      inputs: { job: { id: EXISTING, version: '4' } } });
    const row = await session.read(MODEL, EXISTING); assert.ok(row);
    await observeScenarioReceiptRowId(call, w.store, { dependencyId: 'job-id', model: MODEL, row });
    await session.stage({ op: 'update', model: MODEL, id: EXISTING, data: { title: 'Nested' } }, cause);
    return finish(call, w, session, id as string);
  } };
  assert.equal((await invoke(input)).status, 'committed'); assert.ok(receipt); assert.equal(executions, 1);
  const json = JSON.parse(JSON.stringify(receipt)) as Receipt;
  assert.equal((await projectScenarioReceipt({ ...w, receipt: json })).result, EXISTING);
  assert.equal((await invoke(input)).status, 'replayed'); assert.equal(executions, 1);
  w.access.child = false;
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt: json }), { result: null, records: [] });
  assert.equal(executions, 1);
});

test('admitted-reference roots without owners require final authority and refuse raw row substitutes', async () => {
  for (const mode of ['grant', 'ancestor', 'subject', 'identity', 'raw', 'copy-reference', 'double'] as const) {
    const w = await world({ contained: true });
    await assert.rejects(invoke({ ...w, execute: async call => {
      if (mode === 'raw') await assert.rejects(observeScenarioReceiptRowId(call, w.store,
        { dependencyId: 'job-id', model: MODEL, row: w.old }), refuses);
      else if (mode === 'copy-reference') await assert.rejects(observeScenarioReceiptRowId(call, w.store,
        { dependencyId: 'job-id', model: MODEL, reference: { ...call.recordRefs[0]! } }), refuses);
      else {
        const capture = () => observeScenarioReceiptRowId(call, w.store,
          { dependencyId: 'job-id', model: MODEL, reference: call.recordRefs[0]! });
        assert.equal(await capture(), EXISTING);
        if (mode === 'double') await assert.rejects(capture(), refuses);
        if (mode === 'grant') w.access.row = false;
        if (mode === 'ancestor') w.access.parent = false;
        if (mode === 'subject') await w.memberships.removeMembership(w.author.membership_id);
        if (mode === 'identity') await w.memberships.setMembershipRoles(w.author.membership_id,
          [{ role: 'RowId.extra', granted_at: w.author.updated_at, granted_by: w.caller.user_id }]);
      }
      return finish(call, w, undefined, EXISTING);
    } }), refuses, mode); await unchanged(w);
  }
});

test('row ID capture rechecks full Identity after the common physical load tail before returning the ID', async () => {
  const w = await world(); let armed = false, tailReached = false, returned = false;
  const load = w.store.load;
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    const row = await created(session, w);
    w.hooks.read = async () => {
      delete w.hooks.read; armed = true;
      w.store.load = async (model, id) => {
        const current = await load(model, id);
        if (model === MODEL && id === CREATED && !tailReached) {
          tailReached = true; w.store.load = load;
          await w.memberships.removeMembership(w.author.membership_id);
        }
        return current;
      };
    };
    await assert.rejects(observeScenarioReceiptRowId(call, w.store,
      { dependencyId: 'job-id', model: MODEL, row }).then(id => { returned = true; return id; }), refuses);
    await assert.rejects(session.finalize(), refuses); return empty();
  } }), refuses);
  w.store.load = load;
  assert.equal(armed, true); assert.equal(tailReached, true); assert.equal(returned, false);
  await unchanged(w);
});

test('ownerless admitted row IDs validate actual returned removal, subject update and ancestor effects before commit', async () => {
  for (const mode of ['remove', 'author', 'ancestor'] as const) {
    const w = await world({ contained: true }); let captured = false;
    const removed = await w.memberships.createMembership({ team_id: TEAM, user_id: 'removed-author', is_owner: false, roles: [] });
    await w.memberships.removeMembership(removed.membership_id);
    await assert.rejects(invoke({ ...w, execute: async call => {
      const reference = call.recordRefs[0]!;
      const id = await observeScenarioReceiptRowId(call, w.store,
        { dependencyId: 'job-id', model: MODEL, reference });
      assert.equal(id, EXISTING); captured = true;
      const output = await finish(call, w, undefined, id);
      if (mode === 'author') return { ...output, writes: [{ kind: 'update' as const, model: MODEL, id: EXISTING,
        expectedVersion: reference.row.version, row: { ...reference.row, version: asVersion(reference.row.version + 1),
          data: { ...reference.row.data, author: removed.user_id } } }] };
      const model = mode === 'ancestor' ? PARENT : MODEL, target = mode === 'ancestor' ? PARENT_ID : EXISTING;
      const current = await w.store.load(model, target); assert.ok(current);
      return { ...output, writes: [{ kind: 'remove' as const, model, id: target, expectedVersion: current.version }] };
    } }), refuses, mode);
    assert.equal(captured, true, mode); await unchanged(w);
    assert.deepEqual(await w.store.load(PARENT, PARENT_ID), { ...w.parent, parent: null });
  }
});
