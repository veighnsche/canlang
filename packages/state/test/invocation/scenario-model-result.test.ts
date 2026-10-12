/** Installed literal State components only; no Can/Dev/native source acceptance. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, ClosedInputs, ModelName, Receipt } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { StateError } from '../../src/errors.js';
import { queryRecordsPage } from '../../src/query/engine.js';
import { openFenceScope } from '../../src/invocation/admission.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { buildModelTable } from '../../src/mutation/models.js';
import { buildPolicyTable } from '../../src/policy/grants.js';
import { projectCurrentRecordForViewerSourcePolicies, type ViewerSourceReadPolicy,
  type CurrentRecordSourcePolicyResult, type ViewerGenerationCallbackReadObservation } from '../../src/query/source-policy.js';
import { invoke, type ExecutionEffects } from '../../src/invocation/invoke.js';
import type { AdmittedCall } from '../../src/invocation/admission.js';
import { loadArtifactDescriptors, isGeneratedOperationDef, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { beginScenarioReceiptMutation, bindScenarioReceiptCallProducer, invokeScenarioReceiptCall,
  bindScenarioReceiptReferenceProducer, bindScenarioReceiptModelResult, selectScenarioReceiptReturn,
  projectScenarioReceipt } from '../../src/invocation/scenario-receipt.js';
import { field, modelDef } from '../mutation/fixtures.js';
import { asId, asModel, asRevision, asVersion, FIXED_NOW, makeBatch, makeEnvelope, makeIdentity, makeRow, uuidv7 } from './fixtures.js';

const MODEL = asModel('ModelResult.Run'), FOREIGN = asModel('ModelResult.Other');
const ROOT = 'ModelResult.start', CHILD = 'ModelResult.create', APP = 'model-result-components', TEAM = 'model-result-team';
const CREATED = asId('created-run'), cause = { cause: 'scenario' } as const, bounds = { maxRows: 8, maxWork: 1000 };
const PARENT_ID = asId('created-parent');
const source = { path: 'model-result.can', sha256: 'c'.repeat(64), module: 'model-result.mjs' };
let sequence = 93_000;
function artifact(type = MODEL as CanTypeId, contained = false, presence = false): ArtifactDescriptorSlice {
  return { artifact_version: 1, sources: [{ path: source.path, sha256: source.sha256 }],
    modules: [{ path: source.module, js: 'export const identity="ModelResult.start";', map: {
      version: 3, file: source.module, sources: [source.path], sourcesContent: [null], names: [], mappings: '',
    } }], callables: [ROOT, CHILD].map(id => ({ id, kind: 'operation' as const, module: source.module,
      export: 'identity', member: [id.split('.').at(-1)!] })),
    valueTypes: { contracts: [{ name: 'ModelResult.Lookalike', fields: [{ name: 'id', type: 'text' as CanTypeId }] }] },
    models: [MODEL, FOREIGN].map(name => ({ name, ...(contained && name === MODEL ? { parent: FOREIGN } : {}), deleteMode: 'remove' as const, fields: [
      { name: 'title', field: { kind: 'string' as const }, required: true, serverOnly: false },
      { name: 'author', field: { kind: 'string' as const }, required: true, serverOnly: false },
      ...(presence && name === FOREIGN ? [{ name: 'note', field: { kind: 'string' as const }, required: false, serverOnly: false }] : []),
    ] })), operations: [ROOT, CHILD].map(name => ({ name, kind: 'scenario' as const, description: '', inputs: { fields: [] },
      result: { type, disclosure: { version: 1 as const, source, returns: [{ id: name === ROOT ? 'root-return' : 'child-return',
        source, influences: [], dependencies: [] }] } } })),
  };
}
async function world(type = MODEL as CanTypeId, contained = false, presence = false) {
  const memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const caller = await memberships.createMembership({ team_id: TEAM, user_id: 'caller', is_owner: false, roles: [] });
  const author = await memberships.createMembership({ team_id: TEAM, user_id: 'author', is_owner: false, roles: [] });
  const parentOwner = await memberships.createMembership({ team_id: TEAM, user_id: 'parent-owner', is_owner: false, roles: [] });
  const store = createMemoryStorage(), loaded = loadArtifactDescriptors(artifact(type, contained, presence), { by: 'members' });
  const root = loaded.registry.get(ROOT), child = loaded.registry.get(CHILD);
  assert.ok(root && isGeneratedOperationDef(root)); assert.ok(child && isGeneratedOperationDef(child));
  const table = buildModelTable([MODEL, FOREIGN].map(name => ({ ...modelDef(name, { deleteMode: 'remove', fields: {
    title: field({ required: true }), author: field({ required: true }),
    ...(presence && name === FOREIGN ? { note: field() } : {}),
  } }), ...(contained && name === MODEL ? { containment: { parent: FOREIGN } } : {}) })));
  const seed = makeRow({ id: 'existing-run', data: { title: 'Existing', author: 'author' } });
  await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: MODEL, row: seed }] }));
  const old = await store.load(MODEL, seed.id); assert.ok(old);
  const access = { allowed: true, parentAllowed: true, navigations: 0 };
  const navigation: { inspect?: (result: Readonly<CurrentRecordSourcePolicyResult>,
    sourcePresence: Readonly<{ fields: readonly string[] }> | null,
    observation: Readonly<ViewerGenerationCallbackReadObservation>, allowed: readonly boolean[]) => Promise<void>;
    after?: (observation: Readonly<ViewerGenerationCallbackReadObservation>) => Promise<void>;
    advance?: () => Promise<void> } = {};
  const policy = buildPolicyTable([MODEL, FOREIGN].map(model => ({ model, secretFields: [],
    grants: [{ by: 'members' as const, fields: ['title', 'author'] }] })));
  const readPolicies = new Map<ModelName, ViewerSourceReadPolicy>();
  readPolicies.set(MODEL, { ...(contained ? { parent: FOREIGN } : {}), fields: ['title', 'author'], secretFields: [], grants: [{ fields: ['id', 'title'],
    read: async observation => {
      const { context, row } = observation;
      const fact = await context.memberships.findMembership(TEAM, row.data.author as string);
      let parentAllowed = true;
      if (contained) {
        assert.ok(row.parent);
        const parent = await projectCurrentRecordForViewerSourcePolicies({ model: FOREIGN, id: row.parent.id,
          readPolicies, policy, store, memberships: context.memberships, context, observation }, async (result, _allowed, sourcePresence) => {
            await navigation.inspect?.(result, sourcePresence, observation, _allowed); return result;
          });
        await navigation.after?.(observation);
        access.navigations++;
        parentAllowed = parent.record?.data.title === 'Parent';
      }
      return access.allowed && parentAllowed && fact?.status === 'active' && context.membership?.status === 'active';
    } }] });
  const parentFields = ['title', 'author', ...(presence ? ['note'] : [])];
  if (contained) readPolicies.set(FOREIGN, { fields: parentFields, secretFields: [], grants: [{ fields: ['id', ...parentFields],
    read: async ({ context, row }) => access.parentAllowed &&
      (await context.memberships.findMembership(TEAM, row.data.author as string))?.status === 'active',
  }] });
  for (const def of [root, child]) bindScenarioReceiptReferenceProducer(def, { source, app: APP, policy, readPolicies });
  return { store, memberships, caller, author, parentOwner, contained, root, child, table, policy, access, navigation, readPolicies, old,
    registry: loaded.registry, app: APP, source: 'component', clock: { nowMs: () => FIXED_NOW },
    identity: makeIdentity({ membership: caller }), envelope: makeEnvelope(ROOT, uuidv7(FIXED_NOW, ++sequence), {}) };
}
type World = Awaited<ReturnType<typeof world>>;
type Session = Awaited<ReturnType<typeof beginScenarioReceiptMutation>>;
function bindChild(w: World) {
  let executions = 0, closedCall: AdmittedCall | undefined;
  bindScenarioReceiptCallProducer(w.root, { source, app: APP, registry: w.registry,
    sites: [{ id: 'child-site', source, kind: 'operation', targets: [{ operation: CHILD, interface: w.child.descriptor }],
      resultType: w.child.descriptor.result!.type }], prepare: (_def, inputs) => inputs as ClosedInputs,
    execute: async frame => {
      executions++; closedCall = frame.call;
      if (w.contained) await frame.session.stage({ op: 'create', model: FOREIGN, id: PARENT_ID,
        data: { title: 'Parent', author: 'parent-owner' } }, cause);
      w.navigation.advance = async () => frame.session.stage({ op: 'update', model: FOREIGN, id: PARENT_ID,
        data: { title: 'Concurrent owner stage' } }, cause);
      await frame.session.stage({ op: 'create', model: MODEL, id: CREATED, data: { title: 'Child', author: 'author' },
        ...(w.contained ? { parent: { model: FOREIGN, id: PARENT_ID } } : {}) }, cause);
      if (w.contained) assert.equal(await w.store.load(FOREIGN, PARENT_ID), null);
      const row = await frame.session.read(MODEL, CREATED); assert.ok(row);
      const wire = await bindScenarioReceiptModelResult(frame.call, w.store, { returnId: 'child-return', row });
      assert.deepEqual(wire, { id: CREATED }); assert.ok(Object.isFrozen(wire));
      selectScenarioReceiptReturn(frame.call, w.store, 'child-return'); return wire;
    } });
  return { get executions() { return executions; }, get closedCall() { return closedCall; } };
}
async function child(call: AdmittedCall, w: World) {
  return invokeScenarioReceiptCall(call, w.store, { site: 'child-site', target: CHILD, inputs: {} });
}
async function finish(call: AdmittedCall, w: World, session: Session, wire: unknown): Promise<ExecutionEffects> {
  selectScenarioReceiptReturn(call, w.store, 'root-return');
  return { ...await session.finalize(), result: wire, outbox: [] };
}
const refuses = (error: unknown) => error instanceof StateError;
async function unchanged(w: World) {
  assert.equal(await w.store.load(MODEL, CREATED), null);
  assert.deepEqual(await w.store.load(MODEL, w.old.id), w.old);
  assert.deepEqual(await w.store.historyFor(MODEL, CREATED), []); assert.deepEqual(await w.store.outboxPending(), []);
}

test('child-created model result promotes through the current parent read, permits later data update and replays one commit', async () => {
  const w = await world(), producer = bindChild(w); let roots = 0, commits = 0, receipt: Receipt | undefined;
  const commit = w.store.commit; w.store.commit = async batch => { commits++; return commit(batch); };
  const input = { ...w, observeCommittedReceipt: (value: Receipt) => { receipt = value; }, execute: async (call: AdmittedCall) => {
    roots++; const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    assert.deepEqual(await child(call, w), { id: CREATED });
    const row = await session.read(MODEL, CREATED); assert.ok(row);
    const wire = await bindScenarioReceiptModelResult(call, w.store, { returnId: 'root-return', row });
    await session.stage({ op: 'update', model: MODEL, id: CREATED, data: { title: 'Parent' } }, cause);
    return finish(call, w, session, wire);
  } };
  const result = await invoke(input); assert.equal(result.status, 'committed'); assert.ok(receipt);
  assert.equal(roots, 1); assert.equal(producer.executions, 1); assert.equal(commits, 1);
  assert.deepEqual((await w.store.load(MODEL, CREATED))?.data, { title: 'Parent', author: 'author' });
  assert.ok(receipt.outcome.status === 'committed'); assert.deepEqual(receipt.outcome.result, { id: CREATED });
  const retained = structuredClone(receipt), row = await w.store.load(MODEL, CREATED);
  assert.equal((await invoke(input)).status, 'replayed'); assert.equal(roots, 1); assert.equal(producer.executions, 1); assert.equal(commits, 1);
  assert.deepEqual(receipt, retained); assert.deepEqual(await w.store.load(MODEL, CREATED), row);
  const projected = await projectScenarioReceipt({ ...w, receipt }); assert.deepEqual(projected.result, { id: CREATED });
  assert.equal(projected.records.length, 1);
  // Canonical member grants include author, but the actual source grant does
  // not. Saved disclosure must copy only the source-authorized fields.
  assert.deepEqual(projected.records[0]!.data, { title: 'Parent' });
  await assert.rejects(bindScenarioReceiptModelResult(producer.closedCall!, w.store,
    { returnId: 'child-return', row: row! }), refuses);
});

test('parent rejection after a successful model-result child rolls back the shared owner effects', async () => {
  const w = await world(), producer = bindChild(w);
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await child(call, w); const row = await session.read(MODEL, CREATED); assert.ok(row);
    await bindScenarioReceiptModelResult(call, w.store, { returnId: 'root-return', row });
    await session.stage({ op: 'update', model: MODEL, id: w.old.id, data: { title: 'Rejected' } }, cause);
    throw new StateError('rule_failed', 'Parent rejected after child return.');
  } }), refuses);
  assert.equal(producer.executions, 1); await unchanged(w);
});

test('caught copied, stale, foreign, existing and repeated model-result bindings poison the shared owner', async () => {
  for (const mode of ['copy-row', 'copy-call', 'stale', 'foreign', 'existing', 'repeat', 'wrong-return', 'selected-first'] as const) {
    const w = await world(); bindChild(w);
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      await child(call, w); let row = await session.read(MODEL, CREATED); assert.ok(row);
      if (mode === 'copy-row') row = structuredClone(row);
      if (mode === 'stale') await session.stage({ op: 'update', model: MODEL, id: CREATED, data: { title: 'Moved' } }, cause);
      if (mode === 'foreign') {
        await session.stage({ op: 'create', model: FOREIGN, id: asId('foreign'), data: { title: 'Other', author: 'author' } }, cause);
        row = await session.read(FOREIGN, asId('foreign')); assert.ok(row);
      }
      if (mode === 'existing') { row = await session.read(MODEL, w.old.id); assert.ok(row); }
      try {
        if (mode === 'repeat') await bindScenarioReceiptModelResult(call, w.store, { returnId: 'root-return', row });
        if (mode === 'selected-first') selectScenarioReceiptReturn(call, w.store, 'root-return');
        await bindScenarioReceiptModelResult(mode === 'copy-call' ? { ...call } : call, w.store,
          { returnId: mode === 'wrong-return' ? 'child-return' : 'root-return', row });
        assert.fail('invalid model-result binding succeeded');
      } catch (error) { assert.ok(refuses(error)); }
      return finish(call, w, session, { id: CREATED });
    } }), refuses);
    await unchanged(w);
  }
});

test('substituted result wire and removal/recreation after binding cannot commit a model identity', async () => {
  for (const mode of ['copy-wire', 'other-wire', 'remove', 'recreate'] as const) {
    const w = await world(); bindChild(w);
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      await child(call, w); const row = await session.read(MODEL, CREATED); assert.ok(row);
      const wire = await bindScenarioReceiptModelResult(call, w.store, { returnId: 'root-return', row });
      if (mode === 'remove' || mode === 'recreate') {
        await session.stage({ op: 'remove', model: MODEL, id: CREATED }, cause);
        if (mode === 'recreate') await session.stage({ op: 'create', model: MODEL, id: CREATED, data: { title: 'Recreated', author: 'author' } }, cause);
      }
      return finish(call, w, session, mode === 'copy-wire' ? structuredClone(wire) : mode === 'other-wire' ? { id: w.old.id } : wire);
    } }), refuses); await unchanged(w);
  }
});

test('caught current State checkpoint loss during model-result binding refuses all child and parent effects', async () => {
  const w = await world(), producer = bindChild(w);
  const concurrentIds: string[] = [];
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await child(call, w); const row = await session.read(MODEL, CREATED); assert.ok(row);
    const concurrent = makeRow({ id: `concurrent-other-${concurrentIds.length}`, data: { title: 'Concurrent', author: 'author' } });
    concurrentIds.push(concurrent.id);
    await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'insert', model: FOREIGN, row: concurrent }] }));
    await assert.rejects(bindScenarioReceiptModelResult(call, w.store, { returnId: 'root-return', row }), refuses);
    return finish(call, w, session, { id: CREATED });
  } }), error => error instanceof StateError && error.code === 'busy');
  assert.ok(concurrentIds.length > 1); assert.equal(producer.executions, concurrentIds.length); await unchanged(w);
  for (const id of concurrentIds) assert.deepEqual((await w.store.load(FOREIGN, asId(id)))?.data, { title: 'Concurrent', author: 'author' });
});

test('current source grant or tracked subject revocation after binding refuses the shared commit', async () => {
  for (const mode of ['grant', 'subject'] as const) {
    const w = await world(); bindChild(w);
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      await child(call, w); const row = await session.read(MODEL, CREATED); assert.ok(row);
      const wire = await bindScenarioReceiptModelResult(call, w.store, { returnId: 'root-return', row });
      if (mode === 'grant') w.access.allowed = false;
      else await w.memberships.removeMembership(w.author.membership_id);
      return finish(call, w, session, wire);
    } }), refuses);
    await unchanged(w);
  }
});

test('saved model-result identity and changed records mask together on current grant, subject or lifetime loss', async () => {
  for (const mode of ['grant', 'subject', 'removed', 'recreated'] as const) {
    const w = await world(), producer = bindChild(w); let receipt: Receipt | undefined;
    const input = { ...w, observeCommittedReceipt: (value: Receipt) => { receipt = value; }, execute: async (call: AdmittedCall) => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds }); await child(call, w);
      const row = await session.read(MODEL, CREATED); assert.ok(row);
      return finish(call, w, session, await bindScenarioReceiptModelResult(call, w.store, { returnId: 'root-return', row }));
    } };
    await invoke(input); assert.ok(receipt);
    assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: CREATED });
    if (mode === 'grant') w.access.allowed = false;
    if (mode === 'subject') await w.memberships.removeMembership(w.author.membership_id);
    if (mode === 'removed' || mode === 'recreated') {
      const row = await w.store.load(MODEL, CREATED); assert.ok(row);
      await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'remove', model: MODEL, id: CREATED, expectedVersion: row.version }] }));
      if (mode === 'recreated') await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'insert', model: MODEL,
        row: makeRow({ id: CREATED, created: FIXED_NOW + 1, createdBy: 'different-lifetime', data: { title: 'Recreated', author: 'author' } }) }] }));
    }
    assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] });
    const replay = await invoke(input); assert.equal(replay.status, 'replayed'); assert.equal(producer.executions, 1);
  }
});

test('created Run source navigation resolves its uncommitted parent in the shared closure and ancestor loss masks the saved result', async () => {
  for (const loss of ['grant', 'subject'] as const) {
    const w = await world(MODEL as CanTypeId, true), producer = bindChild(w); let receipt: Receipt | undefined;
    await invoke({ ...w, observeCommittedReceipt: value => { receipt = value; }, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      await child(call, w);
      assert.ok(w.access.navigations > 0);
      assert.equal(await w.store.load(FOREIGN, PARENT_ID), null);
      const row = await session.read(MODEL, CREATED); assert.ok(row);
      assert.deepEqual(row.parent, { model: FOREIGN, id: PARENT_ID });
      return finish(call, w, session, await bindScenarioReceiptModelResult(call, w.store, { returnId: 'root-return', row }));
    } });
    assert.ok(receipt); assert.equal(producer.executions, 1);
    assert.deepEqual((await w.store.load(FOREIGN, PARENT_ID))?.data, { title: 'Parent', author: 'parent-owner' });
    const visible = await projectScenarioReceipt({ ...w, receipt });
    assert.deepEqual(visible.result, { id: CREATED }); assert.equal(visible.records.length, 2);
    if (loss === 'grant') w.access.parentAllowed = false;
    else await w.memberships.removeMembership(w.parentOwner.membership_id);
    assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] });
  }
});

/** Saved-only navigation uses the same installed child and parent reads. The
 * nested child callback joins the page read without starting another page. */
function savedParentNavigation(w: World, mode: 'live' | 'invalid-parent' | 'fence' = 'live') {
  let entered = false, missing = 0, pages = 0;
  w.navigation.after = async observation => {
    if (entered) return;
    entered = true;
    try {
      const input = { model: MODEL, authority: 'viewer' as const, policy: w.policy, sourceReadPolicies: w.readPolicies,
        store: w.store, memberships: observation.context.memberships,
        context: observation.context,
        selection: { parent: { model: FOREIGN, id: mode === 'invalid-parent' ? asId('') : PARENT_ID } },
        ...(mode === 'fence' ? { fence: openFenceScope(asRevision(observation.revision - 1), TEAM) } : {}),
      };
      const page = await queryRecordsPage(input);
      assert.deepEqual(page.records.map(record => record.id), [CREATED]); pages++;
    } catch (error) {
      if (error instanceof StateError && error.code === 'not_found') {
        assert.equal(error.message, 'Parent record not found.'); missing++;
      }
      throw error;
    } finally { entered = false; }
  };
  return { get missing() { return missing; }, get pages() { return pages; } };
}
async function savedContainedWorld() {
  const w = await world(MODEL as CanTypeId, true), producer = bindChild(w);
  let roots = 0, commits = 0, receipt: Receipt | undefined;
  const commit = w.store.commit;
  w.store.commit = async batch => { commits++; return commit(batch); };
  const input = { ...w, observeCommittedReceipt: (value: Receipt) => { receipt = value; }, execute: async (call: AdmittedCall) => {
    roots++;
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await child(call, w);
    const row = await session.read(MODEL, CREATED); assert.ok(row);
    return finish(call, w, session, await bindScenarioReceiptModelResult(call, w.store, { returnId: 'root-return', row }));
  } };
  assert.equal((await invoke(input)).status, 'committed'); assert.ok(receipt);
  assert.equal(roots, 1); assert.equal(producer.executions, 1); assert.equal(commits, 1);
  assert.deepEqual((await w.store.load(MODEL, CREATED))?.parent, { model: FOREIGN, id: PARENT_ID });
  return { w, input, producer, receipt, counts: () => ({ roots, child: producer.executions, commits }) };
}
async function savedState(w: World, receipt: Receipt) {
  return { revision: await w.store.readRevision(), receipt: await w.store.readReceipt(receipt.identity),
    child: await w.store.load(MODEL, CREATED), parent: await w.store.load(FOREIGN, PARENT_ID),
    childHistory: await w.store.historyFor(MODEL, CREATED), parentHistory: await w.store.historyFor(FOREIGN, PARENT_ID),
    outbox: await w.store.outboxPending() };
}

test('saved authentic contained result replays live scoped parent queries and withholds archived or missing ancestors without writes', async () => {
  for (const mode of ['live', 'archived', 'missing'] as const) {
    const { w, input, receipt, counts } = await savedContainedWorld();
    const navigation = savedParentNavigation(w), retained = structuredClone(receipt);
    const visible = await projectScenarioReceipt({ ...w, receipt });
    assert.deepEqual(visible.result, { id: CREATED }); assert.equal(visible.records.length, 2);
    assert.ok(navigation.pages > 0);
    if (mode !== 'live') {
      const parent = await w.store.load(FOREIGN, PARENT_ID); assert.ok(parent);
      await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [mode === 'missing'
        ? { kind: 'remove', model: FOREIGN, id: PARENT_ID, expectedVersion: parent.version }
        : { kind: 'update', model: FOREIGN, id: PARENT_ID, expectedVersion: parent.version,
          row: { ...parent, version: asVersion(parent.version + 1), archivedAt: FIXED_NOW + 1 } }] }));
    }
    const before = await savedState(w, receipt), executions = counts();
    const projection = await projectScenarioReceipt({ ...w, receipt });
    if (mode === 'live') { assert.deepEqual(projection.result, { id: CREATED }); assert.equal(projection.records.length, 2); }
    else { assert.deepEqual(projection, { result: null, records: [] }); assert.ok(navigation.missing > 0); }
    const replay = await invoke(input); assert.equal(replay.status, 'replayed');
    assert.deepEqual(counts(), executions); assert.deepEqual(await savedState(w, receipt), before);
    assert.deepEqual(receipt, retained);
  }
});

test('saved source navigation preserves genuine parent validation, authentication and fence exceptions', async () => {
  for (const [mode, code] of [['invalid-parent', 'validation'], ['row-identity', 'validation'], ['authentication', 'forbidden'], ['fence', 'conflict']] as const) {
    const { w, input, receipt, counts } = await savedContainedWorld();
    if (mode === 'row-identity') {
      // A real stored row returned under the wrong requested identity is an
      // adapter-contract error, not loss of authority over an absent parent.
      const load = w.store.cohortLoad;
      w.store.cohortLoad = async request => request.model === FOREIGN && request.id === PARENT_ID
        ? w.old : load(request);
    } else if (mode !== 'authentication') savedParentNavigation(w, mode);
    const before = await savedState(w, receipt), executions = counts();
    // A different actual SDK member cannot read the caller's retained receipt.
    const identity = mode === 'authentication' ? makeIdentity({ membership: w.parentOwner }) : w.identity;
    await assert.rejects(projectScenarioReceipt({ ...w, receipt, identity }),
      error => error instanceof StateError && error.code === code, mode);
    assert.equal((await invoke(input)).status, 'replayed');
    assert.deepEqual(counts(), executions); assert.deepEqual(await savedState(w, receipt), before);
  }
});

test('nullable, array and nominal contract result lookalikes cannot acquire the singular newly-created model profile', async () => {
  for (const type of [`${MODEL}?`, `${MODEL}[]`, 'ModelResult.Lookalike'] as CanTypeId[]) {
    await assert.rejects(async () => {
      const w = await world(type); bindChild(w);
      await invoke({ ...w, execute: async call => {
        const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds }); await child(call, w);
        const row = await session.read(MODEL, CREATED); assert.ok(row);
        return finish(call, w, session, await bindScenarioReceiptModelResult(call, w.store, { returnId: 'root-return', row }));
      } });
    });
  }
});

test('borrowed source presence describes created and updated owner parent fields while committed parent is absent', async () => {
  const w = await world(MODEL as CanTypeId, true, true); bindChild(w);
  const seen: Array<{ fields: readonly string[]; note: unknown }> = [];
  let absent = 0;
  w.navigation.inspect = async (result, presence) => {
    assert.ok(result.record); assert.ok(presence);
    assert.deepEqual(Object.keys(presence), ['fields']);
    assert.ok(Object.isFrozen(presence)); assert.ok(Object.isFrozen(presence.fields));
    assert.throws(() => (presence.fields as string[]).push('forged'), TypeError);
    assert.deepEqual([...presence.fields].sort(), Object.keys(result.record.data).sort());
    assert.equal(Object.hasOwn(presence, 'data'), false);
    seen.push({ fields: [...presence.fields], note: result.record.data.note });
  };
  w.navigation.after = async observation => {
    await projectCurrentRecordForViewerSourcePolicies({ model: FOREIGN, id: asId('actually-absent'),
      readPolicies: w.readPolicies, policy: w.policy, store: w.store,
      context: observation.context, memberships: observation.context.memberships, observation }, (result, allowed, presence) => {
      assert.equal(result.record, null); assert.deepEqual(allowed, []); assert.equal(presence, null); absent++;
    });
  };
  await invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await child(call, w);
    assert.ok(seen.some(value => !value.fields.includes('note') && value.note === undefined));
    await session.stage({ op: 'update', model: FOREIGN, id: PARENT_ID, data: { note: 'Staged note' } }, cause);
    assert.equal(await w.store.load(FOREIGN, PARENT_ID), null);
    const row = await session.read(MODEL, CREATED); assert.ok(row);
    const wire = await bindScenarioReceiptModelResult(call, w.store, { returnId: 'root-return', row });
    assert.ok(seen.some(value => value.fields.includes('note') && value.note === 'Staged note'));
    return finish(call, w, session, wire);
  } });
  assert.ok(absent > 0); assert.equal((await w.store.load(FOREIGN, PARENT_ID))?.data.note, 'Staged note');
});

test('borrowed source presence withholds denied owner parent fields without treating that row as absent', async () => {
  const w = await world(MODEL as CanTypeId, true, true); bindChild(w); w.access.parentAllowed = false;
  let denials = 0;
  w.navigation.inspect = async (result, presence, _observation, allowed) => {
    assert.equal(result.record, null); assert.equal(presence, null); assert.deepEqual(allowed, [false]); denials++;
  };
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await child(call, w);
    const row = await session.read(MODEL, CREATED); assert.ok(row);
    return finish(call, w, session, await bindScenarioReceiptModelResult(call, w.store, { returnId: 'root-return', row }));
  } }), error => error instanceof StateError && error.code === 'forbidden');
  assert.ok(denials > 0); await unchanged(w);
  assert.equal(await w.store.load(FOREIGN, PARENT_ID), null);
});

test('borrowed owner parent presence refuses awaited authority loss, concurrent owner stage and closed observation navigation', async () => {
  for (const mode of ['authority', 'stage', 'closed'] as const) {
    const w = await world(MODEL as CanTypeId, true, true); bindChild(w);
    let entered = false, captured: Readonly<ViewerGenerationCallbackReadObservation> | undefined;
    w.navigation.inspect = async (_result, presence, observation) => {
      assert.ok(presence); captured ??= observation;
      if (entered) return; entered = true;
      if (mode === 'authority') await w.memberships.removeMembership(w.parentOwner.membership_id);
      if (mode === 'stage') { assert.ok(w.navigation.advance); await w.navigation.advance(); }
    };
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      await child(call, w);
      if (mode === 'closed') {
        assert.ok(captured);
        await assert.rejects(projectCurrentRecordForViewerSourcePolicies({ model: FOREIGN, id: PARENT_ID,
          readPolicies: w.readPolicies, policy: w.policy, store: w.store, context: captured.context,
          memberships: captured.context.memberships, observation: captured }), refuses);
        throw new StateError('forbidden', 'Closed child observation cannot authorize parent navigation.');
      }
      const row = await session.read(MODEL, CREATED); assert.ok(row);
      return finish(call, w, session, await bindScenarioReceiptModelResult(call, w.store, { returnId: 'root-return', row }));
    } }), refuses);
    assert.ok(entered); await unchanged(w); assert.equal(await w.store.load(FOREIGN, PARENT_ID), null);
  }
});
