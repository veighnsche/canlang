/** Canonical State/host bridge component controls. Handbuilt owning
 * source/plan/handler metadata; no Compiler lowering, native or D1 acceptance.
 * Requires the released State 7132 markers in source-current public outputs.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import type { CanTypeId, CommitBatch, ScenarioResultDisclosurePlan, StoragePort, StoredRow } from '@canlang/contracts';
import { StateError } from '@canlang/state/errors';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice } from '@canlang/state/invocation/registry';
import { invoke, type ExecutionEffects } from '@canlang/state/invocation/invoke';
import { readScenarioReceiptAssociation } from '@canlang/state/invocation';
import { FIXED_NOW, asModel, createMemoryIdentityStore, makeIdentity, makeEnvelope,
  seedMember, seedRow, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { createContext, type HandlerContext } from './context.js';
import { bindNativeRecord } from './native-records.js';
import { openScenarioReceiptFrame } from './scenario-receipt-frame.js';
import { observeScenarioReceiptDependency, selectScenarioReceiptReturn } from './stdlib.js';

const MODEL = asModel('Bridge.Record'), OP = 'Bridge.saved', APP = 'bridge-component';
const source = 'package Bridge\nmodel Record do\n  visible: text\nend\n';
const origin = { path: 'bridge-component.can', sha256: createHash('sha256').update(source).digest('hex'), module: 'bridge-component.mjs' };
const plan: ScenarioResultDisclosurePlan = { version: 1, source: origin, returns: [{
  id: 'selected', source: origin, influences: [], dependencies: [{
    id: 'visible', source: origin, role: 'data', model: MODEL, field: 'visible', type: 'text' as CanTypeId,
  }],
}, { id: 'literal', source: origin, influences: [], dependencies: [] }] };
const artifact: ArtifactDescriptorSlice = {
  artifact_version: 1, sources: [{ path: origin.path, sha256: origin.sha256 }],
  modules: [{ path: origin.module, js: 'export const identity="Bridge.saved";',
    map: { version: 3, file: origin.module, sources: [origin.path], sourcesContent: [source], names: [], mappings: '' } }],
  callables: [{ id: OP, kind: 'operation', module: origin.module, export: 'identity', member: ['saved'] }],
  models: [{ name: MODEL, deleteMode: 'archive', fields: [{ name: 'visible', field: { kind: 'string' }, required: true, serverOnly: false }] }],
  operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [{
    name: 'record', field: { kind: 'ref', model: MODEL, requireVersion: true }, required: true,
  }] }, result: { type: 'text' as CanTypeId, disclosure: plan } }],
};
const validation = (error: unknown) => error instanceof StateError && error.code === 'validation';
const forbidden = (error: unknown) => error instanceof StateError && error.code === 'forbidden';
const effects = (result: unknown): ExecutionEffects => ({ result, writes: [], history: [], outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [], resolvedDefaults: {} });
let sequence = 0;
async function world() {
  const backing = createMemoryStorage(), memberships = createMemoryIdentityStore();
  const batches: CommitBatch[] = [];
  const store: StoragePort = { ...backing, commit: async batch => { batches.push(batch); return backing.commit(batch); } };
  const member = await seedMember(memberships, { isOwner: false });
  const identity = makeIdentity({ userId: member.user.user_id, team: member.team, membership: member.membership });
  const loaded = loadArtifactDescriptors(artifact, { by: 'members' });
  const seeded = await seedRow(backing, MODEL, { data: { visible: 'exact selected field' } });
  const row = await backing.load(MODEL, seeded.id);
  assert.ok(row);
  return { store, batches, memberships, identity, row, registry: loaded.registry, app: APP,
    envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence), { record: { id: row.id, version: String(row.version) } }),
    source: 'test', clock: { nowMs: () => FIXED_NOW } };
}

function context(w: Awaited<ReturnType<typeof world>>, qualified: Parameters<typeof createContext>[0]['qualified']) {
  return createContext({ caller: { userId: w.identity.actor!.user_id, roles: [] }, store: w.store,
    ...(qualified === undefined ? {} : { qualified }) });
}
function native(row: StoredRow) {
  const view = Object.freeze({}); bindNativeRecord(view, MODEL, row.id, row.version); return view;
}
function rejectedFence(w: Awaited<ReturnType<typeof world>>, revision: number, first: unknown) {
  assert.equal(w.batches.length, 1);
  const batch = w.batches[0]!;
  assert.equal(batch.expectedRevision, revision);
  assert.deepEqual(batch.writes, []); assert.deepEqual(batch.history, []);
  assert.deepEqual(batch.outbox, []); assert.deepEqual(batch.schedules, []);
  assert.deepEqual(batch.uniqueClaims, []); assert.deepEqual(batch.uniqueReleases, []);
  assert.ok(first instanceof StateError);
  assert.deepEqual(batch.receipt?.outcome, { status: 'rejected', code: first.code, message: first.message });
  assert.equal(Object.hasOwn(batch.receipt!.outcome, 'scenario'), false);
}

it('captures once without reading c.store or native getters again; unrelated contexts do not poison it', async () => {
  const w = await world();
  let escaped: HandlerContext | undefined, escapedRow: object | undefined;
  let nativeReads = 0, unrelatedGetterReads = 0, contextStoreReads = 0;
  const failures: unknown[] = [];
  let receipt: Parameters<NonNullable<Parameters<typeof invoke>[0]['observeCommittedReceipt']>>[0] | undefined;
  await invoke({ ...w, observeCommittedReceipt: value => { receipt = value; }, execute: async call => {
    const c = context(w, call.context);
    const frame = openScenarioReceiptFrame(c, call, w.store, error => { failures.push(error); });
    try {
      assert.throws(() => openScenarioReceiptFrame({ ...c }, { ...call }, w.store, () => {}), forbidden);
      assert.throws(() => openScenarioReceiptFrame({ ...c }, call, { ...w.store }, () => {}), forbidden);
      assert.throws(() => openScenarioReceiptFrame({ ...c }, call, w.store, () => {}), validation);
      const wire = call.recordRefs[0]!.row, view = {};
      Object.defineProperty(view, 'visible', { enumerable: true, get: () => { nativeReads += 1; return wire.data['visible']; } });
      Object.defineProperty(view, 'unused', { enumerable: true, get: () => { unrelatedGetterReads += 1; throw new Error('unselected getter'); } });
      bindNativeRecord(view, MODEL, wire.id, wire.version); Object.freeze(view);
      frame.bind(view, MODEL, () => wire);
      // Missing/copied contexts cannot identify or poison this active frame.
      const foreign = context(w, undefined);
      await assert.rejects(observeScenarioReceiptDependency(foreign, MODEL, view, 'visible', 'visible'), validation);
      await assert.rejects(observeScenarioReceiptDependency({ ...c }, MODEL, view, 'visible', 'visible'), validation);
      Object.defineProperty(c, 'store', { get: () => { contextStoreReads += 1; throw new Error('public store read'); } });
      const selected = (view as { visible: string }).visible;
      await observeScenarioReceiptDependency(c, MODEL, view, 'visible', 'visible');
      selectScenarioReceiptReturn(c, 'selected'); frame.assertCompleted();
      escaped = c; escapedRow = view;
      return effects(selected);
    } finally { frame.close(); }
  } });
  assert.ok(receipt); assert.equal(receipt.outcome.status, 'committed');
  assert.equal(readScenarioReceiptAssociation(receipt)!.observations[0]!.row.data['visible'], 'exact selected field');
  assert.equal(nativeReads, 1); assert.equal(unrelatedGetterReads, 0); assert.equal(contextStoreReads, 0);
  assert.deepEqual(failures, []);
  assert.ok(escaped); assert.ok(escapedRow);
  await assert.rejects(observeScenarioReceiptDependency(escaped, MODEL, escapedRow, 'visible', 'visible'), validation);
  assert.throws(() => selectScenarioReceiptReturn(escaped!, 'literal'), validation);
});

async function foreignView(): Promise<object> {
  const w = await world(); let view: object | undefined;
  await invoke({ ...w, execute: async call => {
    const c = context(w, call.context), frame = openScenarioReceiptFrame(c, call, w.store, () => {});
    try {
      const row = call.recordRefs[0]!.row; view = native(row); frame.bind(view, MODEL, () => row);
      selectScenarioReceiptReturn(c, 'literal'); frame.assertCompleted(); return effects('literal');
    } finally { frame.close(); }
  } });
  assert.ok(view); return view;
}

it('caught errors in a known frame remain terminal through actual completion and a fenced rejection', async () => {
  const foreign = await foreignView();
  for (const mode of ['copied-row', 'identity-only', 'foreign-row', 'wrong-model', 'substituted-id',
    'wire-accessor', 'invalid-dependency', 'invalid-return', 'storage-failure'] as const) {
    const w = await world(), baseline = await w.store.readRevision();
    const failures: unknown[] = []; let first: unknown; let wireGetterReads = 0, fault = false;
    const loadFailure = new Error('selected store load failed');
    const store: StoragePort = mode === 'storage-failure' ? { ...w.store, load: async (model, id) => {
      if (fault) throw loadFailure; return w.store.load(model, id);
    } } : w.store;
    await assert.rejects(invoke({ ...w, store, execute: async call => {
      const c = context({ ...w, store }, call.context);
      const frame = openScenarioReceiptFrame(c, call, store, error => { failures.push(error); });
      try {
        const row = call.recordRefs[0]!.row, view = native(row);
        frame.bind(view, MODEL, () => row);
        let observed: object = view;
        if (mode === 'copied-row') observed = Object.create(Object.getPrototypeOf(view), Object.getOwnPropertyDescriptors(view));
        if (mode === 'identity-only') observed = native(row);
        if (mode === 'foreign-row') observed = foreign;
        if (mode === 'substituted-id') {
          observed = native(row); frame.bind(observed, MODEL, () => ({ ...row, id: 'substituted' as typeof row.id }));
        }
        if (mode === 'wire-accessor') {
          observed = native(row); const data = {};
          Object.defineProperty(data, 'visible', { enumerable: true, get: () => { wireGetterReads += 1; return row.data['visible']; } });
          frame.bind(observed, MODEL, () => ({ ...row, data }));
        }
        try {
          fault = mode === 'storage-failure';
          if (mode === 'invalid-return') selectScenarioReceiptReturn(c, 'unknown');
          else await observeScenarioReceiptDependency(c, mode === 'wrong-model' ? 'Foreign.Record' : MODEL,
            observed, 'visible', mode === 'invalid-dependency' ? 'unknown' : 'visible');
        } catch (error) { first = error; }
        assert.ok(first, mode); assert.equal(wireGetterReads, 0);
        if (mode === 'storage-failure') assert.equal(first, loadFailure);
        else assert.ok(validation(first), mode);
        // Catching the bad marker cannot recover through good markers or an
        // empty dependency return. Completion rethrows the original object.
        await assert.rejects(observeScenarioReceiptDependency(c, MODEL, view, 'visible', 'visible'), error => error === first);
        assert.throws(() => selectScenarioReceiptReturn(c, 'literal'), error => error === first);
        assert.deepEqual(failures, [first]);
        frame.assertCompleted();
        return { ...effects('must not commit'), writes: [{ kind: 'update', model: MODEL, id: row.id,
          expectedVersion: row.version, row: { ...row, version: (row.version + 1) as typeof row.version, data: { visible: 'must not commit' } } }] };
      } finally { frame.close(); }
    } }), error => error === first);
    fault = false;
    assert.deepEqual(await store.load(MODEL, w.row.id), w.row, mode);
    if (mode === 'storage-failure') {
      assert.deepEqual(w.batches, []); assert.equal(await store.readRevision(), baseline);
    } else rejectedFence(w, baseline, first);
  }
});

it('owns detached pending failures and refuses overlapping markers or selection before completion', async () => {
  for (const mode of ['second-marker', 'selection'] as const) {
    const w = await world(), baseline = await w.store.readRevision();
    let block = false, release!: () => void, first: unknown, observationLoads = 0;
    const waiting = new Promise<void>(resolve => { release = resolve; }), failures: unknown[] = [];
    const store: StoragePort = { ...w.store, load: async (model, id) => {
      if (block) { observationLoads += 1; await waiting; }
      return w.store.load(model, id);
    } };
    await assert.rejects(invoke({ ...w, store, execute: async call => {
      const c = context({ ...w, store }, call.context), frame = openScenarioReceiptFrame(c, call, store, error => { failures.push(error); });
      try {
        const row = call.recordRefs[0]!.row, view = native(row); frame.bind(view, MODEL, () => row);
        block = true;
        // Deliberately detached: the test runner would report an unhandled
        // rejection if the framework did not own its rejection observer.
        void observeScenarioReceiptDependency(c, MODEL, view, 'visible', 'visible');
        try {
          if (mode === 'second-marker') await observeScenarioReceiptDependency(c, MODEL, view, 'visible', 'visible');
          else selectScenarioReceiptReturn(c, 'literal');
        } catch (error) { first = error; }
        assert.ok(validation(first), mode);
        assert.equal(observationLoads, 1, 'overlap never starts a second raw State observation');
        assert.throws(() => frame.assertCompleted(), error => error === first);
        release(); await new Promise<void>(resolve => { setImmediate(resolve); });
        assert.throws(() => selectScenarioReceiptReturn(c, 'literal'), error => error === first);
        assert.deepEqual(failures, [first]);
        frame.assertCompleted(); return effects('must not commit');
      } finally { release(); frame.close(); }
    } }), error => error === first);
    block = false;
    assert.deepEqual(await store.load(MODEL, w.row.id), w.row);
    rejectedFence(w, baseline, first);
  }
});
