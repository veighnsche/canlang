/** Canonical State/host bridge component controls. Handbuilt owning
 * source/plan/handler metadata; no Compiler lowering, native or D1 acceptance.
 * Requires the released State root/child markers in source-current public outputs.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { it } from 'node:test';
import type { CanTypeId, ClosedInputs, CommitBatch, Receipt, ScenarioResultDisclosurePlan, StoragePort, StoredRow } from '@canlang/contracts';
import { StateError } from '@canlang/state/errors';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { isGeneratedOperationDef, loadArtifactDescriptors, type ArtifactDescriptorSlice } from '@canlang/state/invocation/registry';
import { invoke, type ExecutionEffects } from '@canlang/state/invocation/invoke';
import { beginScenarioReceiptMutation, bindScenarioReceiptCallProducer,
  invokeScenarioReceiptCall as invokeStateCall, bindScenarioReceiptQueryProducer, bindScenarioReceiptReferenceProducer,
  readScenarioReceiptAssociation, type ScenarioReceiptAnyPredicate } from '@canlang/state/invocation';
import { buildModelTable } from '@canlang/state/mutation';
import { buildPolicyTable } from '@canlang/state/policy/grants';
import type { ViewerSourceReadPolicy } from '@canlang/state/query';
import { first as pureFirst, count as pureValuesCount } from '@canlang/values';
import { field, modelDef } from '@canlang/state/testing/mutation/fixtures';
import { FIXED_NOW, asId, asModel, createMemoryIdentityStore, makeIdentity, makeEnvelope, makeBatch,
  seedMember, seedRow, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { createContext, type HandlerContext } from './context.js';
import { bindNativeRecord, nativeRecordReference } from './native-records.js';
import { invokeScenarioReceiptCall, openScenarioReceiptFrame, firstQuery, countQuery, bindScenarioReceiptModelResult,
  executeScenarioReceiptQuery as executeNativeQuery, executeScenarioReceiptAny as executeNativeAny, observeScenarioReceiptQueryDependency as observeNativeQueryDependency } from './scenario-receipt-frame.js';
import type { ScenarioReceiptFrame } from './scenario-receipt-frame.js';
import { observeScenarioReceiptDependency, observeScenarioReceiptIntrinsic, selectScenarioReceiptReturn, count as pureCount, int64 } from './stdlib.js';

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
async function world(configure?: (slice: ArtifactDescriptorSlice) => void) {
  const backing = createMemoryStorage(), memberships = createMemoryIdentityStore();
  const batches: CommitBatch[] = [];
  const store: StoragePort = { ...backing, commit: async batch => { batches.push(batch); return backing.commit(batch); } };
  const member = await seedMember(memberships, { isOwner: false });
  const identity = makeIdentity({ userId: member.user.user_id, team: member.team, membership: member.membership });
  const slice = structuredClone(artifact); configure?.(slice);
  const loaded = loadArtifactDescriptors(slice, { by: 'members' });
  const seeded = await seedRow(backing, MODEL, { data: { visible: 'exact selected field' } });
  const row = await backing.load(MODEL, seeded.id);
  assert.ok(row);
  return { store, batches, memberships, identity, row, registry: loaded.registry, app: APP,
    envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence), { record: { id: row.id, version: String(row.version) },
      ...(configure === undefined ? {} : { prompt: 'original prompt' }) }),
    source: 'test', clock: { nowMs: () => FIXED_NOW } };
}

function intrinsicFixture(slice: ArtifactDescriptorSlice): void {
  const operation = slice.operations![0]!;
  operation.inputs.fields.push({ name: 'prompt', field: { kind: 'string' }, valueType: 'text' as CanTypeId, required: true });
  operation.result = { ...operation.result!, disclosure: { ...plan, returns: [{
    ...plan.returns[0]!, intrinsics: [
      { id: 'operation-id', source: origin, role: 'data', kind: 'operation-id', type: 'text' as CanTypeId },
      { id: 'original-version', source: origin, role: 'data', kind: 'admitted-reference-version',
        parameter: 'record', model: MODEL, type: 'int' as CanTypeId },
      { id: 'prompt-input', source: origin, role: 'data', kind: 'admitted-input', parameter: 'prompt', type: 'text' as CanTypeId },
    ],
  }, plan.returns[1]!] } };
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

it('prepares the exact current protected reference while State suspends its genuine parent; copied and closed references roll back', async () => {
  const CHILD = 'Bridge.preparedChild';
  const foreign = await foreignView();
  for (const mode of ['positive', 'copied', 'closed', 'foreign', 'wrong-model'] as const) {
    const w = await world(slice => {
      intrinsicFixture(slice);
      slice.operations!.push({ ...structuredClone(slice.operations![0]!), name: CHILD });
      slice.callables!.push({ ...structuredClone(slice.callables![0]!), id: CHILD, member: ['preparedChild'] });
    });
    const parent = w.registry.get(OP), child = w.registry.get(CHILD);
    assert.ok(parent && isGeneratedOperationDef(parent)); assert.ok(child && isGeneratedOperationDef(child));
    const table = buildModelTable([modelDef(MODEL, { fields: { visible: field({ required: true }) } })]);
    const privateParents = new WeakMap<Parameters<typeof beginScenarioReceiptMutation>[0], ScenarioReceiptFrame>();
    const baseline = await w.store.readRevision(), failures: unknown[] = [];
    let first: unknown, receipt: Receipt | undefined, childExecutions = 0, rootExecutions = 0, preparations = 0;
    bindScenarioReceiptCallProducer(parent, { source: origin, app: APP, registry: w.registry,
      sites: [{ id: 'prepared-site', source: origin, kind: 'operation',
        targets: [{ operation: CHILD, interface: child.descriptor }], resultType: child.descriptor.result!.type }],
      prepare: (def, inputs, actualParent) => {
        preparations++; assert.equal(actualParent.def, parent); assert.equal(def, child);
        const frame = privateParents.get(actualParent); assert.ok(frame, 'only the exact private parent pointer selects preparation authority');
        assert.equal(privateParents.get({ ...actualParent }), undefined);
        if (mode === 'closed') frame.close();
        const reference = frame.prepareReference(inputs['record'], mode === 'wrong-model' ? 'Foreign.Record' : MODEL);
        assert.deepEqual(reference, { id: w.row.id, version: String(w.row.version + 1) });
        assert.ok(Object.isFrozen(reference));
        return { record: reference, prompt: inputs['prompt'] } as ClosedInputs;
      },
      execute: async issued => {
        childExecutions++;
        const original = issued.call.recordRefs[0]!;
        assert.equal(original.row.version, w.row.version + 1, 'child admission must use the current staged version');
        assert.equal(original.row.data['visible'], 'parent intermediate');
        const c = context(w, issued.call.context), frame = openScenarioReceiptFrame(c, issued.call, w.store, error => failures.push(error));
        let current = original.row;
        const view = native(current); frame.bind(view, MODEL, () => current); frame.bindAdmittedReference(view, original);
        try {
          await issued.session.stage({ op: 'update', model: MODEL, id: current.id, data: { visible: 'child final' } }, { cause: 'scenario' });
          const staged = await issued.session.read(MODEL, current.id); assert.ok(staged); current = staged;
          await observeScenarioReceiptDependency(c, MODEL, view, 'visible', 'visible');
          await observeScenarioReceiptIntrinsic(c, 'operation-id', 'operation-id', issued.call.context.operationId);
          await observeScenarioReceiptIntrinsic(c, 'original-version', 'admitted-reference-version', BigInt(original.row.version), view);
          await observeScenarioReceiptIntrinsic(c, 'prompt-input', 'admitted-input', issued.call.inputs['prompt']);
          selectScenarioReceiptReturn(c, 'selected'); frame.assertCompleted();
          return current.data['visible'];
        } finally { frame.close(); }
      },
    });
    const execute: Parameters<typeof invoke>[0]['execute'] = async call => {
      rootExecutions++;
      const session = await beginScenarioReceiptMutation(call, w.store, { table, bounds: { maxRows: 10, maxWork: 1000 } });
      const original = call.recordRefs[0]!, c = context(w, call.context);
      const frame = openScenarioReceiptFrame(c, call, w.store, error => failures.push(error),
        (site, target, inputs) => invokeStateCall(call, w.store, { site, target, inputs }));
      privateParents.set(call, frame);
      let current = original.row;
      const view = Object.freeze({ version: BigInt(original.row.version) });
      bindNativeRecord(view, MODEL, original.row.id, original.row.version);
      frame.bind(view, MODEL, () => current); frame.bindAdmittedReference(view, original);
      try {
        await session.stage({ op: 'update', model: MODEL, id: current.id, data: { visible: 'parent intermediate' } }, { cause: 'scenario' });
        const staged = await session.read(MODEL, current.id); assert.ok(staged); current = staged;
        assert.equal(current.version, w.row.version + 1); assert.equal(view.version, BigInt(w.row.version));
        const operand = mode === 'copied' ? { ...view } : mode === 'foreign' ? foreign : view;
        let result: unknown;
        try { result = await invokeScenarioReceiptCall(c, 'prepared-site', CHILD, { record: operand, prompt: call.inputs['prompt'] }); }
        catch (error) { first = error; }
        if (mode !== 'positive') {
          assert.ok(validation(first));
          assert.throws(() => frame.prepareReference(view, MODEL), error => error === first);
          assert.throws(() => frame.assertCompleted(), error => error === first);
          assert.deepEqual(failures, [first]);
          frame.assertCompleted(); return effects('must not commit');
        }
        assert.equal(result, 'child final');
        const final = await session.read(MODEL, current.id); assert.ok(final); current = final;
        assert.equal(call.recordRefs[0]!.row.version, w.row.version, 'root admitted reference stays original');
        assert.equal(view.version, BigInt(w.row.version), 'public native version stays original');
        await observeScenarioReceiptDependency(c, MODEL, view, 'visible', 'visible');
        await observeScenarioReceiptIntrinsic(c, 'operation-id', 'operation-id', call.context.operationId);
        await observeScenarioReceiptIntrinsic(c, 'original-version', 'admitted-reference-version', view.version, view);
        await observeScenarioReceiptIntrinsic(c, 'prompt-input', 'admitted-input', call.inputs['prompt']);
        selectScenarioReceiptReturn(c, 'selected'); frame.assertCompleted();
        const finalized = await session.finalize(); return { ...finalized, result, outbox: finalized.outbox ?? [] };
      } finally { frame.close(); privateParents.delete(call); }
    };
    const input = { ...w, execute, observeCommittedReceipt: (value: Receipt) => { receipt = value; } };
    if (mode === 'positive') {
      assert.equal((await invoke(input)).status, 'committed'); assert.ok(receipt);
      assert.equal(w.batches.length, 1); assert.equal(w.batches[0]!.writes.length, 1); assert.equal(w.batches[0]!.history.length, 2);
      const historyBase = { model: MODEL, recordId: w.row.id, version: w.row.version + 1,
        operationId: w.envelope.operation_id, actor: w.identity.actor!.user_id, at: FIXED_NOW, change: 'update',
        // The checked fixture inventory declares only public `visible`; both
        // writes retain the original row lifetime rather than the staged version.
        auditProjection: { created: w.row.created, createdBy: w.row.createdBy, secretFields: [] } };
      assert.deepEqual(w.batches[0]!.history, [
        { ...historyBase, operation: OP, before: w.row.data, after: { visible: 'parent intermediate' } },
        { ...historyBase, operation: CHILD, before: { visible: 'parent intermediate' }, after: { visible: 'child final' } },
      ], 'parent/child authored order and operation attribution share one root invocation and reserved version');
      assert.deepEqual(w.batches[0]!.outbox, []); assert.deepEqual(w.batches[0]!.schedules, []);
      const association = readScenarioReceiptAssociation(receipt)!;
      assert.equal(association.intrinsics!.find(value => value.dependencyId === 'original-version')!.wire, String(w.row.version));
      assert.equal(association.calls!.length, 1);
      assert.equal(association.calls![0]!.references[0]!.row.version, w.row.version + 1);
      assert.equal(association.calls![0]!.scenario!.intrinsics!.find(value => value.dependencyId === 'original-version')!.wire, String(w.row.version + 1));
      const stored = await w.store.load(MODEL, w.row.id); assert.ok(stored);
      assert.equal(stored.version, w.row.version + 1); assert.equal(stored.data['visible'], 'child final');
      const revision = await w.store.readRevision();
      assert.equal((await invoke(input)).status, 'replayed'); assert.equal(await w.store.readRevision(), revision);
      assert.deepEqual(await w.store.load(MODEL, w.row.id), stored);
      assert.equal(w.batches.length, 1); assert.equal(rootExecutions, 1); assert.equal(childExecutions, 1); assert.equal(preparations, 1);
    } else {
      await assert.rejects(invoke(input), error => error === first);
      assert.deepEqual(await w.store.load(MODEL, w.row.id), w.row); rejectedFence(w, baseline, first);
      assert.equal(childExecutions, 0); assert.equal(preparations, 1);
    }
  }
});

async function foreignView(): Promise<object> {
  const w = await world(); let view: object | undefined;
  await invoke({ ...w, execute: async call => {
    const c = context(w, call.context), frame = openScenarioReceiptFrame(c, call, w.store, () => {});
    try {
      const row = call.recordRefs[0]!.row; view = native(row); frame.bind(view, MODEL, () => row); frame.bindAdmittedReference(view, call.recordRefs[0]!);
      selectScenarioReceiptReturn(c, 'literal'); frame.assertCompleted(); return effects('literal');
    } finally { frame.close(); }
  } });
  assert.ok(view); return view;
}

it('caught errors in a known frame remain terminal through actual completion and a fenced rejection', async () => {
  const foreign = await foreignView();
  for (const mode of ['copied-row', 'identity-only', 'foreign-row', 'wrong-model', 'substituted-id',
    'wire-accessor', 'invalid-dependency', 'invalid-return', 'storage-failure',
    'intrinsic-wrong-operation', 'intrinsic-copied-version', 'intrinsic-foreign-version',
    'intrinsic-unbound-version', 'intrinsic-wrong-version', 'intrinsic-wrong-input'] as const) {
    const intrinsic = mode.startsWith('intrinsic-');
    const w = await world(intrinsic ? intrinsicFixture : undefined), baseline = await w.store.readRevision();
    const failures: unknown[] = []; let first: unknown; let wireGetterReads = 0, fault = false;
    const loadFailure = new Error('selected store load failed');
    const store: StoragePort = mode === 'storage-failure' ? { ...w.store, load: async (model, id) => {
      if (fault) throw loadFailure; return w.store.load(model, id);
    } } : w.store;
    await assert.rejects(invoke({ ...w, store, execute: async call => {
      const c = context({ ...w, store }, call.context);
      const frame = openScenarioReceiptFrame(c, call, store, error => { failures.push(error); });
      try {
        const row = call.recordRefs[0]!.row, view = {};
        Object.defineProperty(view, 'version', { get: () => { wireGetterReads += 1; throw new Error('metadata getter reread'); } });
        bindNativeRecord(view, MODEL, row.id, row.version); Object.freeze(view);
        frame.bind(view, MODEL, () => row);
        if (intrinsic && mode !== 'intrinsic-unbound-version') frame.bindAdmittedReference(view, call.recordRefs[0]!);
        let observed: object = view;
        if (mode === 'copied-row') observed = Object.create(Object.getPrototypeOf(view), Object.getOwnPropertyDescriptors(view));
        if (mode === 'identity-only') observed = native(row);
        if (mode === 'foreign-row' || mode === 'intrinsic-foreign-version') observed = foreign;
        if (mode === 'intrinsic-copied-version') observed = Object.create(Object.getPrototypeOf(view), Object.getOwnPropertyDescriptors(view));
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
          if (mode === 'intrinsic-wrong-operation') await observeScenarioReceiptIntrinsic(c, 'operation-id', 'operation-id', 'wrong operation');
          else if (mode === 'intrinsic-wrong-input') await observeScenarioReceiptIntrinsic(c, 'prompt-input', 'admitted-input', 'changed prompt');
          else if (intrinsic) await observeScenarioReceiptIntrinsic(c, 'original-version', 'admitted-reference-version',
            BigInt(row.version) + (mode === 'intrinsic-wrong-version' ? 1n : 0n), observed);
          else if (mode === 'invalid-return') selectScenarioReceiptReturn(c, 'unknown');
          else await observeScenarioReceiptDependency(c, mode === 'wrong-model' ? 'Foreign.Record' : MODEL,
            observed, 'visible', mode === 'invalid-dependency' ? 'unknown' : 'visible');
        } catch (error) { first = error; }
        assert.ok(first, mode); assert.equal(wireGetterReads, 0);
        if (mode === 'storage-failure') assert.equal(first, loadFailure);
        else assert.ok(validation(first), mode);
        // Catching the bad marker cannot recover through good markers or an
        // empty dependency return. Completion rethrows the original object.
        await assert.rejects(observeScenarioReceiptDependency(c, MODEL, view, 'visible', 'visible'), error => error === first);
        if (intrinsic) await assert.rejects(observeScenarioReceiptIntrinsic(c, 'operation-id', 'operation-id', call.context.operationId), error => error === first);
        assert.throws(() => selectScenarioReceiptReturn(c, 'literal'), error => error === first);
        assert.throws(() => frame.assertCompleted(), error => error === first);
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
  for (const mode of ['second-marker', 'selection', 'intrinsic-close'] as const) {
    const w = await world(mode === 'intrinsic-close' ? intrinsicFixture : undefined), baseline = await w.store.readRevision();
    let block = false, release!: () => void, first: unknown, observationLoads = 0;
    const waiting = new Promise<void>(resolve => { release = resolve; }), failures: unknown[] = [];
    const store: StoragePort = { ...w.store, load: async (model, id) => {
      if (block) { observationLoads += 1; await waiting; }
      return w.store.load(model, id);
    } };
    await assert.rejects(invoke({ ...w, store, execute: async call => {
      const c = context({ ...w, store }, call.context), frame = openScenarioReceiptFrame(c, call, store, error => { failures.push(error); });
      try {
        const row = call.recordRefs[0]!.row, view = native(row); frame.bind(view, MODEL, () => row); frame.bindAdmittedReference(view, call.recordRefs[0]!);
        block = true;
        // Deliberately detached: the test runner would report an unhandled
        // rejection if the framework did not own its rejection observer.
        const pending = mode === 'intrinsic-close'
          ? observeScenarioReceiptIntrinsic(c, 'original-version', 'admitted-reference-version', BigInt(row.version), view)
          : observeScenarioReceiptDependency(c, MODEL, view, 'visible', 'visible');
        if (mode === 'intrinsic-close') {
          assert.equal(observationLoads, 1, 'original-reference intrinsic awaits the actual backing load');
          frame.close(); release();
          try { await pending; } catch (error) { first = error; }
        }
        try {
          if (mode === 'intrinsic-close') {
            await assert.rejects(observeScenarioReceiptIntrinsic(c, 'operation-id', 'operation-id', call.context.operationId), error => error === first);
          } else if (mode === 'second-marker') await observeScenarioReceiptDependency(c, MODEL, view, 'visible', 'visible');
          else selectScenarioReceiptReturn(c, 'literal');
        } catch (error) { first = error; }
        assert.ok(validation(first), mode);
        assert.equal(observationLoads, 1, 'overlap never starts a second raw State observation');
        assert.throws(() => frame.assertCompleted(), error => error === first);
        release(); await new Promise<void>(resolve => { setImmediate(resolve); });
        if (mode === 'intrinsic-close') await assert.rejects(observeScenarioReceiptIntrinsic(c, 'operation-id', 'operation-id', call.context.operationId), error => error === first);
        assert.throws(() => selectScenarioReceiptReturn(c, 'literal'), error => error === first);
        assert.throws(() => frame.assertCompleted(), error => error === first);
        assert.deepEqual(failures, [first]);
        frame.assertCompleted(); return effects('must not commit');
      } finally { release(); frame.close(); }
    } }), error => error === first);
    block = false;
    assert.deepEqual(await store.load(MODEL, w.row.id), w.row);
    rejectedFence(w, baseline, first);
  }
});

it('keeps a receiving dependency capture inside its original pending frame lifetime', async () => {
  for (const closed of [false, true]) {
    const w = await world(), baseline = await w.store.readRevision();
    let release!: () => void, entered!: () => void, first: unknown;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const failures: unknown[] = [];
    let loads = 0, captureLoads = 0, captures = 0;
    const store: StoragePort = { ...w.store, load: async (model, id) => {
      loads++; return w.store.load(model, id);
    } };
    const attempt = invoke({ ...w, store, execute: async call => {
      const c = context({ ...w, store }, call.context);
      const row = call.recordRefs[0]!.row, view = native(row);
      const frame = openScenarioReceiptFrame(c, call, store, error => { failures.push(error); },
        undefined, undefined, async (input, healthy) => {
          captures++;
          assert.equal(input.dependencyId, 'visible'); assert.equal(input.model, MODEL);
          assert.equal(input.field, 'visible'); assert.deepEqual(input.row, row);
          healthy(); captureLoads = loads; entered(); await waiting; healthy();
          return undefined;
        });
      try {
        frame.bind(view, MODEL, () => row);
        const pending = observeScenarioReceiptDependency(c, MODEL, view, 'visible', 'visible');
        await started;
        if (closed) frame.close();
        release();
        try { await pending; } catch (error) { first = error; }
        if (closed) {
          assert.ok(validation(first)); assert.equal(loads, captureLoads, 'closed capture never reaches State observation');
          assert.deepEqual(failures, [first]);
          assert.throws(() => frame.assertCompleted(), error => error === first);
        }
        selectScenarioReceiptReturn(c, 'selected'); frame.assertCompleted();
        return effects(row.data['visible']);
      } finally { release(); frame.close(); }
    } });
    if (closed) {
      await assert.rejects(attempt, error => error === first);
      rejectedFence(w, baseline, first);
    } else await attempt;
    assert.equal(captures, 1);
    assert.deepEqual(await w.store.load(MODEL, w.row.id), w.row);
  }
});

it('joins a genuine State child frame and original slots; caught call failures roll back the enclosing stage', async () => {
  const CHILD = 'Bridge.child';
  for (const mode of ['positive', 'missing-callback', 'closed', 'overlap', 'state-rejection'] as const) {
    const w = await world(slice => {
      intrinsicFixture(slice);
      slice.operations!.push({ ...structuredClone(slice.operations![0]!), name: CHILD });
      slice.callables!.push({ ...structuredClone(slice.callables![0]!), id: CHILD, member: ['child'] });
    });
    const parent = w.registry.get(OP), child = w.registry.get(CHILD);
    assert.ok(parent && isGeneratedOperationDef(parent)); assert.ok(child && isGeneratedOperationDef(child));
    const table = buildModelTable([modelDef(MODEL, { fields: { visible: field({ required: true }) } })]);
    const baseline = await w.store.readRevision(), failures: unknown[] = [];
    let first: unknown, childExecutions = 0, rootExecutions = 0, publicStoreReads = 0;
    let escapedChild: HandlerContext | undefined, receipt: Receipt | undefined;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    bindScenarioReceiptCallProducer(parent, { source: origin, app: APP, registry: w.registry,
      sites: [{ id: 'child-site', source: origin, kind: 'operation',
        targets: [{ operation: CHILD, interface: child.descriptor }], resultType: child.descriptor.result!.type }],
      prepare: (_def, inputs) => inputs as ClosedInputs,
      execute: async issued => {
        childExecutions++;
        const c = context(w, issued.call.context);
        const frame = openScenarioReceiptFrame(c, issued.call, w.store, error => { failures.push(error); });
        try {
          const original = issued.call.recordRefs[0]!;
          let current = original.row;
          const view = native(original.row);
          frame.bind(view, MODEL, () => current); frame.bindAdmittedReference(view, original);
          await issued.session.stage({ op: 'update', model: MODEL, id: original.row.id,
            data: { visible: 'actual child stage' } }, { cause: 'scenario' });
          const row = await issued.session.read(MODEL, original.row.id); assert.ok(row); current = row;
          if (mode === 'overlap') await waiting;
          await observeScenarioReceiptDependency(c, MODEL, view, 'visible', 'visible');
          await observeScenarioReceiptIntrinsic(c, 'operation-id', 'operation-id', issued.call.context.operationId);
          await observeScenarioReceiptIntrinsic(c, 'original-version', 'admitted-reference-version', BigInt(original.row.version), view);
          await observeScenarioReceiptIntrinsic(c, 'prompt-input', 'admitted-input', issued.call.inputs['prompt']);
          selectScenarioReceiptReturn(c, 'selected'); frame.assertCompleted(); escapedChild = c;
          return current.data['visible'];
        } finally { frame.close(); }
      },
    });
    const execute: Parameters<typeof invoke>[0]['execute'] = async call => {
      rootExecutions++;
      const session = await beginScenarioReceiptMutation(call, w.store, { table, bounds: { maxRows: 10, maxWork: 1000 } });
      const c = context(w, call.context);
      const frame = openScenarioReceiptFrame(c, call, w.store, error => { failures.push(error); },
        mode === 'missing-callback' ? undefined : (site, target, inputs) => invokeStateCall(call, w.store, { site, target, inputs }));
      const copied = { ...c };
      Object.defineProperty(c, 'store', { get: () => { publicStoreReads++; throw new Error('call facade read public storage'); } });
      try {
        await assert.rejects(invokeScenarioReceiptCall(copied, 'child-site', CHILD, call.inputs), validation);
        assert.deepEqual(failures, [], 'a foreign context cannot poison the actual root');
        if (mode === 'closed') frame.close();
        const pending = invokeScenarioReceiptCall(c, mode === 'state-rejection' ? 'unknown-site' : 'child-site', CHILD, call.inputs);
        if (mode === 'overlap') {
          // Do not detach without an owner: the facade observes rejection,
          // and this test releases and awaits the original child as well.
          try { await invokeScenarioReceiptCall(c, 'child-site', CHILD, call.inputs); } catch (error) { first = error; }
          assert.ok(validation(first)); release();
        }
        let result: unknown;
        try { result = await pending; } catch (error) { first ??= error; assert.equal(error, first); }
        if (mode === 'positive') {
          assert.equal(result, 'actual child stage');
          selectScenarioReceiptReturn(c, 'literal'); frame.assertCompleted();
          const finalized = await session.finalize();
          return { ...finalized, result, outbox: finalized.outbox ?? [] };
        }
        assert.ok(validation(first), mode);
        await assert.rejects(invokeScenarioReceiptCall(c, 'child-site', CHILD, call.inputs), error => error === first);
        assert.throws(() => selectScenarioReceiptReturn(c, 'literal'), error => error === first);
        assert.throws(() => frame.assertCompleted(), error => error === first);
        assert.deepEqual(failures, [first]);
        frame.assertCompleted(); return effects('must not commit');
      } finally { release(); frame.close(); }
    };
    const input = { ...w, execute, observeCommittedReceipt: (value: Receipt) => { receipt = value; } };
    if (mode === 'positive') {
      const result = await invoke(input); assert.equal(result.status, 'committed'); assert.ok(receipt);
      assert.equal(w.batches.length, 1); assert.equal(w.batches[0]!.writes.length, 1); assert.equal(w.batches[0]!.history.length, 1);
      assert.deepEqual(w.batches[0]!.outbox, []); assert.deepEqual(w.batches[0]!.schedules, []);
      const association = readScenarioReceiptAssociation(receipt)!;
      assert.equal(association.calls!.length, 1);
      const captured = association.calls![0]!;
      assert.equal(captured.target, CHILD); assert.equal(captured.result, 'actual child stage');
      assert.equal(captured.references[0]!.row.version, w.row.version);
      assert.equal(captured.scenario!.observations[0]!.row.version, w.row.version + 1);
      assert.equal(captured.scenario!.observations[0]!.row.data['visible'], 'actual child stage');
      assert.equal(captured.scenario!.intrinsics!.find(value => value.dependencyId === 'original-version')!.wire, String(w.row.version));
      const stored = await w.store.load(MODEL, w.row.id); assert.ok(stored);
      assert.equal(stored.data['visible'], 'actual child stage');
      assert.equal((await invoke(input)).status, 'replayed'); assert.deepEqual(await w.store.load(MODEL, w.row.id), stored);
      assert.equal(w.batches.length, 1); assert.equal(rootExecutions, 1); assert.equal(childExecutions, 1);
      assert.ok(escapedChild);
      await assert.rejects(invokeScenarioReceiptCall(escapedChild, 'child-site', CHILD, {}), validation);
    } else {
      await assert.rejects(invoke(input), error => error === first);
      assert.deepEqual(await w.store.load(MODEL, w.row.id), w.row); rejectedFence(w, baseline, first);
      assert.equal(childExecutions, mode === 'overlap' ? 1 : 0);
    }
    assert.equal(publicStoreReads, 0);
  }
});

/** Consumer-only first(Query) controls. The owning fixture metadata is handbuilt
 * like the other bridge controls; candidates/handles/rows come from actual State.
 * No Compiler/native acceptance is asserted here. */
async function firstQueryWorld(domain: 'matched' | 'empty' | 'false' = 'matched', consumer: 'first' | 'count' = 'first') {
  const w = await world(slice => {
    intrinsicFixture(slice);
    slice.operations![0]!.inputs.fields.shift(); // Remove the fixture's record parameter before loading; keep its declared prompt.
    slice.operations![0]!.result = { type: MODEL as CanTypeId, disclosure: {
      version: 1, source: origin, queries: [{ id: 'first-record', source: origin, model: MODEL,
        order: [{ field: 'id', direction: 'asc' }], limit: null, archived: 'exclude',
        dependencies: [{ id: 'visible-control', source: origin, role: 'control', field: 'visible', type: 'text' as CanTypeId }],
      }], returns: [{ id: 'first-result', source: origin,
        dependencies: domain === 'matched' && consumer === 'first' ? [plan.returns[0]!.dependencies[0]!] : [],
        influences: (['query-existence', 'query-cardinality', 'query-membership', 'query-order'] as const)
          .map(kind => ({ id: kind, kind, queryId: 'first-record' })),
      }],
    } };
  });
  // The admitted original seed is a genuine false candidate. Empty means an
  // actual empty live query domain; the removed seed is fixture setup only.
  if (domain === 'empty') await w.store.commit(makeBatch(await w.store.readRevision(), {
    writes: [{ kind: 'remove', model: MODEL, id: w.row.id, expectedVersion: w.row.version }],
  }));
  const seededRows = domain === 'empty' ? [] : [
    await seedRow(w.store, MODEL, { id: 'first-z', data: { visible: domain === 'false' ? 'excluded z' : 'matched z' } }),
    await seedRow(w.store, MODEL, { id: 'first-a', data: { visible: domain === 'false' ? 'excluded a' : 'matched a' } }),
  ];
  const selectedRows = await Promise.all(seededRows.map(async row => {
    const stored = await w.store.load(MODEL, row.id); assert.ok(stored); return stored;
  }));
  const def = w.registry.get(OP); assert.ok(def && isGeneratedOperationDef(def));
  const policy = buildPolicyTable([{ model: MODEL, secretFields: [], grants: [{ by: 'members', fields: ['visible'] }] }]);
  const readPolicies = new Map<import('@canlang/contracts').ModelName, ViewerSourceReadPolicy>([[MODEL, {
    fields: ['visible'], secretFields: [], grants: [{ fields: ['id', 'visible'],
      read: async ({ context }) => context.membership?.status === 'active' }],
  }]]);
  bindScenarioReceiptReferenceProducer(def, { source: origin, app: APP, policy, readPolicies });
  bindScenarioReceiptQueryProducer(def, { source: origin, app: APP, policy });
  const table = buildModelTable([modelDef(MODEL, { fields: { visible: field({ required: true }) } })]);
  // Keep setup outside the observed invocation fence, as world() already does.
  w.batches.length = 0;
  // Query has no admitted model parameter; an empty domain must not require one.
  const envelope = makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence), { prompt: 'original prompt' });
  return { ...w, table, selectedRows, envelope };
}

function queryCandidate(model: string, row: import('@canlang/contracts').ProjectedRecord,
  read: (field: string) => void, current: () => import('@canlang/contracts').ProjectedRecord) {
  const view: Record<string, unknown> = Object.create(null);
  for (const field of Object.keys(row.data)) Object.defineProperty(view, field, {
    enumerable: true, get: () => { read(field); return current().data[field]; },
  });
  bindNativeRecord(view, model, row.id, row.version); return Object.freeze(view);
}

it('firstQuery binds the actual sorted State owner row or genuine null and preserves receipt replay', async () => {
  assert.equal(pureFirst([]), null);
  const literal = { literal: true }; assert.equal(pureFirst([literal]), literal);
  assert.equal(pureFirst([literal]) instanceof Promise, false);
  for (const domain of ['matched', 'empty', 'false'] as const) {
    const w = await firstQueryWorld(domain), failures: unknown[] = [], issued: StoredRow[] = [];
    let receipt: Receipt | undefined, escaped: HandlerContext | undefined, originalArray: unknown;
    let predicates = 0, executions = 0;
    const input: Parameters<typeof invoke>[0] = { ...w, observeCommittedReceipt: value => { receipt = value; }, execute: async call => {
      executions++;
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds: { maxRows: 10, maxWork: 1000 } });
      const c = context(w, call.context);
      let frame!: ScenarioReceiptFrame;
      const bind = (row: StoredRow) => {
        const view = Object.freeze({ visible: row.data['visible'] });
        bindNativeRecord(view, MODEL, row.id, row.version); frame.bind(view, MODEL, () => row); return view;
      };
      frame = openScenarioReceiptFrame(c, call, w.store, error => failures.push(error), undefined, {
        record: queryCandidate, encode: value => value,
        mutableRecord: (model, row) => { assert.equal(model, MODEL); issued.push(row); return bind(row); },
      });
      try {
        const rows = await executeNativeQuery(c, 'first-record', row => {
          predicates++; const visible = row['visible'];
          observeNativeQueryDependency(c, MODEL, row, 'visible', 'visible-control');
          return typeof visible === 'string' && visible.startsWith('matched');
        });
        originalArray = rows; escaped = c;
        await assert.rejects(firstQuery({ ...c }, rows), validation);
        assert.deepEqual(failures, [], 'foreign context does not poison this source');
        const selected = await firstQuery(c, rows);
        if (domain === 'matched') {
          assert.ok(selected); assert.equal(selected['visible'], 'matched a');
          assert.equal(issued.length, 1); assert.equal(issued[0]!.id, 'first-a');
          await observeScenarioReceiptDependency(c, MODEL, selected, 'visible', 'visible');
          await session.stage({ op: 'update', model: MODEL, id: issued[0]!.id, data: { visible: 'changed first' } }, { cause: 'scenario' });
        } else { assert.equal(selected, null); assert.deepEqual(issued, []); }
        await session.stage({ op: 'create', model: MODEL, id: asId('first-created'), data: {
          visible: domain === 'matched' ? 'matched a' : 'genuine absence',
        } }, { cause: 'scenario' });
        const created = await session.read(MODEL, asId('first-created')); assert.ok(created);
        const result = await bindScenarioReceiptModelResult(c, 'first-result', bind(created));
        selectScenarioReceiptReturn(c, 'first-result'); frame.assertCompleted();
        return { ...await session.finalize(), result, outbox: [] };
      } finally { frame.close(); }
    } };
    assert.equal((await invoke(input)).status, 'committed'); assert.ok(receipt);
    const saved = readScenarioReceiptAssociation(receipt)!.queries![0]!;
    assert.equal(saved.candidates.length, domain === 'empty' ? 0 : 3);
    assert.deepEqual(saved.selectedIndices.map(index => saved.candidates[index]!.row.id), domain === 'matched' ? ['first-a', 'first-z'] : []);
    if (domain === 'matched') {
      assert.equal((await w.store.load(MODEL, asId('first-a')))!.data['visible'], 'changed first');
      assert.equal((await w.store.load(MODEL, asId('first-z')))!.data['visible'], 'matched z');
    }
    const revision = await w.store.readRevision();
    assert.equal((await invoke(input)).status, 'replayed'); assert.equal(executions, 1);
    assert.equal(predicates, domain === 'empty' ? 0 : 3); assert.equal(await w.store.readRevision(), revision);
    assert.equal(w.batches.length, 1); assert.deepEqual(failures, []);
    assert.ok(escaped); await assert.rejects(firstQuery(escaped, originalArray), validation);
  }
});

it('firstQuery refuses copied, repeated, stale and pending/closed consumer lifetimes without escaping an owner row', async () => {
  for (const mode of ['copy', 'once', 'stale', 'close', 'overlap', 'binder-close'] as const) {
    const w = await firstQueryWorld(), baseline = await w.store.readRevision(), failures: unknown[] = [];
    let first: unknown, bindings = 0, release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds: { maxRows: 10, maxWork: 1000 } });
      const c = context(w, call.context); let frame!: ScenarioReceiptFrame;
      frame = openScenarioReceiptFrame(c, call, w.store, error => failures.push(error), undefined, {
        record: queryCandidate, encode: value => value,
        mutableRecord: async (model, row) => {
          assert.equal(model, MODEL); assert.equal(row.id, 'first-a'); bindings++;
          if (mode === 'overlap' || mode === 'binder-close') { entered(); await waiting; }
          const view = native(row); frame.bind(view, MODEL, () => row); return view;
        },
      });
      try {
        const rows = await executeNativeQuery(c, 'first-record', row => {
          const visible = row['visible']; observeNativeQueryDependency(c, MODEL, row, 'visible', 'visible-control');
          return typeof visible === 'string' && visible.startsWith('matched');
        });
        if (mode === 'stale') await session.stage({ op: 'update', model: MODEL, id: asId('first-z'), data: { visible: 'next stage' } }, { cause: 'scenario' });
        if (mode === 'close') frame.close();
        const pending = firstQuery(c, mode === 'copy' ? [...rows] : rows);
        if (mode === 'overlap' || mode === 'binder-close') {
          await Promise.race([started, pending.then(() => assert.fail('Expected pending mutable owner binding.'))]);
          if (mode === 'binder-close') frame.close();
          else try { await firstQuery(c, rows); } catch (error) { first = error; }
          release();
        }
        try { await pending; if (mode === 'once') await firstQuery(c, rows); }
        catch (error) { first ??= error; assert.equal(error, first); }
        assert.ok(validation(first), mode);
        assert.throws(() => frame.assertCompleted(), error => error === first);
        assert.deepEqual(failures, [first]);
        frame.assertCompleted(); return effects('must not commit');
      } finally { release(); frame.close(); }
    } }), error => error === first);
    assert.equal(bindings, ['once', 'overlap', 'binder-close'].includes(mode) ? 1 : 0, mode);
    rejectedFence(w, baseline, first);
    for (const row of w.selectedRows) assert.deepEqual(await w.store.load(MODEL, row.id), row);
    assert.equal(await w.store.load(MODEL, asId('first-created')), null);
  }
});

/** Actual State count consumer bridge only; generated count/containment source
 * and arithmetic lowering remain a separate Compiler/native prerequisite. */
it('countQuery consumes actual matched cardinality as Can bigint and preserves created result/census on replay', async () => {
  assert.equal(pureValuesCount([]), 0n); assert.equal(pureCount([]), 0n);
  assert.equal(pureValuesCount([1n, 2n]), 2n); assert.equal(pureCount([1n, 2n]), 2n);
  assert.equal(typeof pureCount([1n, 2n]), 'bigint', 'generic count is synchronous');
  for (const domain of ['matched', 'empty', 'false'] as const) {
    const w = await firstQueryWorld(domain, 'count'), failures: unknown[] = [];
    let receipt: Receipt | undefined, executions = 0, predicates = 0;
    let escaped: HandlerContext | undefined, originalArray: unknown;
    const expected = domain === 'matched' ? 2n : 0n;
    const input: Parameters<typeof invoke>[0] = { ...w, observeCommittedReceipt: value => { receipt = value; }, execute: async call => {
      executions++;
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds: { maxRows: 10, maxWork: 1000 } });
      const c = context(w, call.context), frame = openScenarioReceiptFrame(c, call, w.store, error => failures.push(error), undefined, {
        record: queryCandidate, encode: value => value,
        // A count-only consumer deliberately has no mutable first-row binder.
      });
      try {
        const rows = await executeNativeQuery(c, 'first-record', row => {
          predicates++; const visible = row['visible'];
          observeNativeQueryDependency(c, MODEL, row, 'visible', 'visible-control');
          return typeof visible === 'string' && visible.startsWith('matched');
        });
        await assert.rejects(countQuery({ ...c }, rows), validation);
        assert.deepEqual(failures, [], 'foreign context cannot poison the original count');
        originalArray = rows; escaped = c;
        const count = await countQuery(c, rows);
        assert.equal(count, expected); assert.equal(typeof count, 'bigint');
        const next = int64(count + 1n); assert.equal(next, expected + 1n);
        await session.stage({ op: 'create', model: MODEL, id: asId('count-created'),
          data: { visible: next.toString() } }, { cause: 'scenario' });
        const created = await session.read(MODEL, asId('count-created')); assert.ok(created);
        const view = native(created); frame.bind(view, MODEL, () => created);
        const result = await bindScenarioReceiptModelResult(c, 'first-result', view);
        selectScenarioReceiptReturn(c, 'first-result'); frame.assertCompleted();
        return { ...await session.finalize(), result, outbox: [] };
      } finally { frame.close(); }
    } };
    assert.equal((await invoke(input)).status, 'committed'); assert.ok(receipt);
    const saved = readScenarioReceiptAssociation(receipt)!.queries![0]!;
    assert.equal(saved.candidates.length, domain === 'empty' ? 0 : 3);
    assert.deepEqual(saved.selectedIndices.map(index => saved.candidates[index]!.row.id),
      domain === 'matched' ? ['first-a', 'first-z'] : []);
    assert.ok(saved.candidates.every(candidate => candidate.dependencies.includes('visible-control')));
    assert.equal(saved.candidates.find(candidate => candidate.row.id === w.row.id)?.matched,
      domain === 'empty' ? undefined : false);
    const created = await w.store.load(MODEL, asId('count-created')); assert.ok(created);
    assert.equal(created.data['visible'], (expected + 1n).toString());
    for (const row of w.selectedRows) assert.deepEqual(await w.store.load(MODEL, row.id), row);
    assert.deepEqual(await w.store.outboxPending(), []);
    assert.equal(w.batches.length, 1); assert.equal(w.batches[0]!.writes.length, 1);
    const revision = await w.store.readRevision(), retained = structuredClone(receipt);
    assert.equal((await invoke(input)).status, 'replayed'); assert.equal(executions, 1);
    assert.equal(predicates, domain === 'empty' ? 0 : 3); assert.equal(await w.store.readRevision(), revision);
    assert.deepEqual(await w.store.load(MODEL, asId('count-created')), created);
    assert.deepEqual(receipt, retained); assert.equal(w.batches.length, 1); assert.deepEqual(failures, []);
    assert.ok(escaped); await assert.rejects(countQuery(escaped, originalArray), validation);
  }
});

it('countQuery refuses copied arrays, repeat/mutual first selection, stale stage and closed or overlapping frame', async () => {
  for (const mode of ['copy', 'once', 'count-first', 'first-count', 'stale', 'close', 'overlap'] as const) {
    const w = await firstQueryWorld('matched', 'count'), baseline = await w.store.readRevision(), failures: unknown[] = [];
    let first: unknown, bindings = 0;
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds: { maxRows: 10, maxWork: 1000 } });
      const c = context(w, call.context); let frame!: ScenarioReceiptFrame;
      frame = openScenarioReceiptFrame(c, call, w.store, error => failures.push(error), undefined, {
        record: queryCandidate, encode: value => value,
        ...(mode !== 'first-count' ? {} : { mutableRecord: (model: string, row: StoredRow) => {
          assert.equal(model, MODEL); assert.equal(row.id, 'first-a'); bindings++;
          const view = native(row); frame.bind(view, MODEL, () => row); return view;
        } }),
      });
      try {
        const rows = await executeNativeQuery(c, 'first-record', row => {
          const visible = row['visible']; observeNativeQueryDependency(c, MODEL, row, 'visible', 'visible-control');
          return typeof visible === 'string' && visible.startsWith('matched');
        });
        if (mode === 'stale') await session.stage({ op: 'update', model: MODEL, id: asId('first-z'),
          data: { visible: 'next stage' } }, { cause: 'scenario' });
        if (mode === 'close') frame.close();
        if (mode === 'first-count') assert.ok(await firstQuery(c, rows));
        const pending = countQuery(c, mode === 'copy' ? [...rows] : rows);
        if (mode === 'overlap') {
          try { await countQuery(c, rows); } catch (error) { first = error; }
        }
        try {
          const count = await pending;
          assert.equal(count, 2n);
          if (mode === 'once') await countQuery(c, rows);
          if (mode === 'count-first') await firstQuery(c, rows);
        } catch (error) { first ??= error; assert.equal(error, first); }
        assert.ok(validation(first), mode);
        assert.throws(() => frame.assertCompleted(), error => error === first);
        assert.deepEqual(failures, [first]);
        frame.assertCompleted(); return effects('must not commit');
      } finally { frame.close(); }
    } }), error => error === first);
    assert.equal(bindings, mode === 'first-count' ? 1 : 0, 'count cannot mint a mutable first-row view');
    rejectedFence(w, baseline, first);
    for (const row of w.selectedRows) assert.deepEqual(await w.store.load(MODEL, row.id), row);
    assert.deepEqual(await w.store.historyFor(MODEL, w.selectedRows[0]!.id), []);
    assert.deepEqual(await w.store.outboxPending(), []);
    assert.equal(await w.store.load(MODEL, asId('count-created')), null);
  }
});


/** Hand-built trusted verifier exercises the native-frame/State handoff only;
 * Compiler source-factory authentication remains a separate integration gate. */
it('predicate ANY hands its exact authenticated native closure through State once and preserves lazy viewer reads', async () => {
  for (const mode of ['positive', 'withheld', 'revoked', 'wrapped', 'forged', 'verifier-throw', 'wrong-query', 'repeat-capture', 'closed-capture'] as const) {
    const w = await world(slice => {
      intrinsicFixture(slice); slice.operations![0]!.inputs.fields.shift();
      slice.models![0]!.fields.push({ name: 'approved', field: { kind: 'boolean' }, valueType: 'bool' as CanTypeId,
        required: true, serverOnly: false });
      slice.operations![0]!.result = { type: MODEL as CanTypeId, disclosure: { version: 1, source: origin,
        queries: [{ id: 'predicate-any', source: origin, model: MODEL, order: [], limit: null, archived: 'exclude',
          dependencies: [{ id: 'approved-control', source: origin, role: 'control', field: 'approved', type: 'bool' as CanTypeId }] }],
        returns: [{ id: 'any-result', source: origin, dependencies: [],
          influences: (['query-existence', 'query-cardinality', 'query-membership', 'query-order'] as const)
            .map(kind => ({ id: kind, kind, queryId: 'predicate-any' })) }],
      } };
    });
    await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [
      { kind: 'remove', model: MODEL, id: w.row.id, expectedVersion: w.row.version },
    ] }));
    for (const id of ['a', 'b', 'c']) await seedRow(w.store, MODEL, { id, created: FIXED_NOW,
      data: { visible: id, approved: id === 'b' } });
    const def = w.registry.get(OP); assert.ok(def && isGeneratedOperationDef(def));
    const access = { fields: mode !== 'withheld' }, visited: string[] = [], failures: unknown[] = [];
    const policy = buildPolicyTable([], []);
    const readPolicies = new Map<import('@canlang/contracts').ModelName, ViewerSourceReadPolicy>([[MODEL, {
      fields: ['visible', 'approved'], secretFields: [], grants: [
        { fields: ['id'], read: async ({ context }) => context.membership?.status === 'active' },
        { fields: ['approved'], read: async ({ context, row }) => access.fields && row.id !== 'c' && context.membership?.status === 'active' },
      ],
    }]]);
    const table = buildModelTable([modelDef(MODEL, { fields: { visible: field({ required: true }), approved: field({ required: true }) } })]);
    let active: { readonly call: Parameters<typeof beginScenarioReceiptMutation>[0]; readonly frame: ScenarioReceiptFrame } | undefined;
    let captures = 0, authentications = 0, sourceCalls = 0, receipt: Receipt | undefined;
    let escaped: ScenarioReceiptFrame | undefined, escapedContext: HandlerContext | undefined;
    let original: ((row: Readonly<Record<string, unknown>>) => boolean) | undefined, captured: ScenarioReceiptAnyPredicate | undefined;
    const authoredFailure = new StateError('rule_failed', 'Exact source verifier failure');
    bindScenarioReceiptReferenceProducer(def, { source: origin, app: APP, policy, readPolicies });
    bindScenarioReceiptQueryProducer(def, { source: origin, app: APP, policy, readPolicies,
      any: [{ kind: 'predicate', queryId: 'predicate-any', dependencyIds: ['approved-control'] }],
      captureAnyPredicate: (call, queryId) => {
        assert.ok(active && active.call === call); captures++;
        if (mode === 'closed-capture') active.frame.close();
        const callback = active.frame.captureAnyPredicate(mode === 'wrong-query' ? 'foreign-query' : queryId);
        captured = callback;
        if (mode === 'repeat-capture') active.frame.captureAnyPredicate(queryId);
        return callback;
      },
    });
    w.batches.length = 0;
    const baseline = await w.store.readRevision();
    const request: Parameters<typeof invoke>[0] = { ...w,
      envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence), { prompt: 'original prompt' }),
      observeCommittedReceipt: value => { receipt = value; }, execute: async call => {
        const session = await beginScenarioReceiptMutation(call, w.store, { table, bounds: { maxRows: 10, maxWork: 1000 } });
        const c = context(w, call.context);
        const frame = openScenarioReceiptFrame(c, call, w.store, error => failures.push(error), undefined, {
          record: queryCandidate, encode: value => value,
          authenticateAnyPredicate: (queryId, predicate) => {
            authentications++; assert.equal(queryId, 'predicate-any');
            if (mode === 'verifier-throw') throw authoredFailure;
            return predicate === original;
          },
        });
        active = { call, frame }; escaped = frame; escapedContext = c;
        original = row => {
          sourceCalls++; const ref = nativeRecordReference(row); assert.ok(ref); visited.push(ref.id);
          const approved = row['approved'];
          observeNativeQueryDependency(c, MODEL, row, 'approved', 'approved-control'); return approved === true;
        };
        try {
          const submitted = mode === 'wrapped' ? (row: Readonly<Record<string, unknown>>) => original!(row)
            : mode === 'forged' ? () => false : original;
          const allowed = await executeNativeAny(c, 'predicate-any', submitted);
          assert.equal(allowed, true); assert.notEqual(captured, original, 'State receives the private native candidate adapter');
          if (mode === 'revoked') access.fields = false;
          await session.stage({ op: 'create', model: MODEL, id: asId('any-created'),
            data: { visible: 'allowed', approved: allowed } }, { cause: 'scenario' });
          const row = await session.read(MODEL, asId('any-created')); assert.ok(row);
          const view = native(row); frame.bind(view, MODEL, () => row);
          const result = await bindScenarioReceiptModelResult(c, 'any-result', view);
          selectScenarioReceiptReturn(c, 'any-result'); frame.assertCompleted();
          return { ...await session.finalize(), result, outbox: [] };
        } finally { frame.close(); active = undefined; }
      },
    };
    if (mode === 'positive') {
      assert.equal((await invoke(request)).status, 'committed'); assert.ok(receipt);
      const saved = readScenarioReceiptAssociation(receipt)!.queries![0]!;
      assert.deepEqual(visited, ['a', 'b']); assert.equal(captures, 1); assert.equal(authentications, 1); assert.equal(sourceCalls, 2);
      assert.deepEqual(saved.selectedIndices, [1]); assert.deepEqual(saved.candidates.map(row => row.dependencies),
        [['approved-control'], ['approved-control'], []]);
      assert.deepEqual(failures, []); assert.equal(w.batches.length, 1); assert.equal(w.batches[0]!.writes.length, 1);
      assert.ok(escaped && escapedContext && original);
      assert.throws(() => escaped!.captureAnyPredicate('predicate-any'), validation);
      await assert.rejects(executeNativeAny(escapedContext, 'predicate-any', original), validation);
    } else {
      let first: unknown;
      await assert.rejects(invoke(request), error => { first = error;
        return mode === 'verifier-throw' ? error === authoredFailure : mode === 'withheld' || mode === 'revoked' ? forbidden(error) : validation(error);
      });
      assert.equal(await w.store.load(MODEL, asId('any-created')), null);
      if (mode === 'revoked') {
        // Returned query guards revalidate at Invoke's commit fence, after
        // executor finalization: authority loss records no receipt or effects.
        assert.equal(w.batches.length, 0); assert.equal(receipt, undefined);
        assert.equal(await w.store.readRevision(), baseline);
      } else rejectedFence(w, baseline, first);
      assert.equal(authentications, 1);
      if (!['withheld', 'revoked'].includes(mode)) assert.equal(sourceCalls, 0, 'untrusted or invalid captures never enter source predicate');
    }
  }
});
