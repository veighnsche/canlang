/** Finite actual query-candidate parent navigation controls using a genuine owner
 * session. Native ask75/source correspondence remains separately owned. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, ClosedInputs, CommitBatch, ModelName, Receipt, StoredRow } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { StateError } from '@canlang/state/errors';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { buildModelTableFromCanonical } from '@canlang/state/mutation/models';
import { buildPolicyTable } from '@canlang/state/policy/grants';
import type { ViewerSourceReadPolicy } from '@canlang/state/query';
import { invoke } from '@canlang/state/invocation/invoke';
import type { AdmittedCall } from '@canlang/state/invocation';
import { loadArtifactDescriptors, isGeneratedOperationDef, type ArtifactDescriptorSlice } from '@canlang/state/invocation/registry';
import { beginScenarioReceiptMutation, bindScenarioReceiptCallProducer, invokeScenarioReceiptCall,
  bindScenarioReceiptQueryProducer, bindScenarioReceiptReferenceProducer, bindScenarioReceiptModelResult,
  selectScenarioReceiptReturn, readScenarioReceiptAssociation } from '@canlang/state/invocation';
import { createContext, type HandlerContext } from './context.js';
import { bindNativeRecord } from './native-records.js';
import { makeRecordRef } from '@canlang/values';
import { openScenarioReceiptFrame, type ScenarioReceiptFrame, executeScenarioReceiptQuery as nativeQuery,
  observeScenarioReceiptQueryDependency as queryObserve, readScenarioReceiptQueryParent,
  observeScenarioReceiptDependency as nativeObserve, countQuery } from './scenario-receipt-frame.js';
import { asId, asModel, FIXED_NOW, makeBatch, makeEnvelope, makeIdentity, makeRow, uuidv7 } from '@canlang/state/testing/invocation/fixtures';

const CONVERSATION = asModel('QueryParentNavigation.Conversation');
const PARENT = asModel('QueryParentNavigation.Branch');
const TURN = asModel('QueryParentNavigation.Run'), RUN = asModel('QueryParentNavigation.Reservation');
const ROOT = 'QueryParentNavigation.start', CHILD = 'QueryParentNavigation.reserve', APP = 'query-parent-navigation-components', TEAM = 'query-parent-navigation-team';
const CREATED = asId('created-run'), cause = { cause: 'scenario' } as const, bounds = { maxRows: 10, maxWork: 1000 };
const source = { path: 'query-parent-navigation.can', sha256: 'd'.repeat(64), module: 'query-parent-navigation.mjs' };
let sequence = 98_000;
function artifact(): ArtifactDescriptorSlice {
  return { artifact_version: 1, sources: [{ path: source.path, sha256: source.sha256 }],
    modules: [{ path: source.module, js: 'export const identity="QueryParentNavigation.start";', map: {
      version: 3, file: source.module, sources: [source.path], sourcesContent: [null], names: [], mappings: '',
    } }], callables: [ROOT, CHILD].map(id => ({ id, kind: 'operation' as const, module: source.module,
      export: 'identity', member: [id.split('.').at(-1)!] })),
    models: [{ name: CONVERSATION, deleteMode: 'remove', fields: [{ name: 'title', field: { kind: 'string' }, required: true, serverOnly: false }] }, { name: PARENT, parent: CONVERSATION, deleteMode: 'remove', fields: [{ name: 'title', field: { kind: 'string' }, required: true, serverOnly: false }] }, { name: TURN, parent: PARENT, deleteMode: 'remove', fields: [
      ...['account', 'held'].map(name => ({
        name, field: { kind: 'string' as const }, required: true, serverOnly: false,
      })), { name: 'position', field: { kind: 'integer' as const }, required: false, serverOnly: false },
    ] }, { name: RUN, deleteMode: 'remove', fields: [
      ...['account', 'title'].map(name => ({ name, field: { kind: 'string' as const }, required: true, serverOnly: false })),
    ] }],
    operations: [ROOT, CHILD].map(name => ({ name, kind: 'scenario' as const, description: '', inputs: { fields: [] },
      result: { type: RUN as CanTypeId, disclosure: { version: 1 as const, source,
        ...(name === CHILD ? { queries: [{ id: 'turns', source, model: TURN,
          order: [{ field: 'id', direction: 'asc' as const }], limit: null, archived: 'exclude' as const,
          dependencies: [{ id: 'parent-control', source, role: 'control' as const, field: 'parent', type: PARENT as CanTypeId }, { id: 'account-control', source, role: 'control' as const, field: 'account', type: 'text' as CanTypeId },
          ],
        }] } : {}),
        returns: [{ id: name === ROOT ? 'root-return' : 'child-return', source,
          dependencies: name === CHILD ? [{ id: 'branch-parent', source, role: 'control' as const, model: PARENT, field: 'parent', type: CONVERSATION as CanTypeId }] : [],
          influences: name === CHILD ? (['query-existence', 'query-cardinality', 'query-membership', 'query-order'] as const)
            .map(kind => ({ id: kind, kind, queryId: 'turns' })) : [],
        }],
      } } })),
  };
}
async function world(configure?: (slice: ArtifactDescriptorSlice) => void) {
  const slice = artifact(); configure?.(slice);
  const memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const caller = await memberships.createMembership({ team_id: TEAM, user_id: 'caller', is_owner: false, roles: [] });
  const reader = await memberships.createMembership({ team_id: TEAM, user_id: 'turn-reader', is_owner: false, roles: [] });
  const parentReader = await memberships.createMembership({ team_id: TEAM, user_id: 'parent-reader', is_owner: false, roles: [] });
  const physical = createMemoryStorage(), batches: CommitBatch[] = [];
  const store = { ...physical, commit: async (batch: CommitBatch) => {
    batches.push(batch); return physical.commit(batch);
  } }, loaded = loadArtifactDescriptors(
    slice, { by: 'members' });
  const root = loaded.registry.get(ROOT), child = loaded.registry.get(CHILD);
  assert.ok(root && isGeneratedOperationDef(root)); assert.ok(child && isGeneratedOperationDef(child));
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, serverInits: loaded.serverInits,
    nullableFields: loaded.nullableFields, containment: loaded.containment });
  const rows: StoredRow[] = [];
  for (const id of ['conversation-a', 'conversation-b']) {
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: CONVERSATION,
      row: makeRow({ id, data: { title: id } }) }] }));
  }
  for (const id of ['branch-a', 'branch-b', 'branch-c']) {
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: PARENT,
      row: { ...makeRow({ id, data: { title: id } }), parent: { model: CONVERSATION,
        id: asId(id === 'branch-c' ? 'conversation-b' : 'conversation-a') } } }] }));
  }
  for (const [id, account, branch] of [
    ['turn-a', 'caller', 'branch-a'], ['turn-b', 'caller', 'branch-b'],
    ['turn-c', 'caller', 'branch-c'], ['turn-d', 'other', 'branch-a'],
  ] as const) {
    const row: StoredRow = { ...makeRow({ id, data: { account, held: '7' } }), parent: { model: PARENT, id: asId(branch) } };
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: TURN, row }] }));
    const stored = await store.load(TURN, row.id); assert.ok(stored); rows.push(stored);
  }
  const access = { turn: true, run: true, parent: true, conversation: true };
  const policy = buildPolicyTable([
    { model: CONVERSATION, secretFields: [], grants: [{ by: 'members', fields: ['title'] }] },
    { model: PARENT, secretFields: [], grants: [{ by: 'members', fields: ['title'] }] },
    { model: TURN, secretFields: [], grants: [{ by: 'members', fields: ['account', 'held', 'position'] }] },
    { model: RUN, secretFields: [], grants: [{ by: 'members', fields: ['account', 'title'] }] },
  ], loaded.models);
  const readPolicies = new Map<ModelName, ViewerSourceReadPolicy>();
  for (const [model, fields] of [[TURN, ['account', 'held', 'position']], [RUN, ['account', 'title']], [PARENT, ['title']], [CONVERSATION, ['title']]] as const) {
    readPolicies.set(model, { ...(model === TURN ? { parent: PARENT } : model === PARENT ? { parent: CONVERSATION } : {}), fields: [...fields],
      secretFields: [], grants: [{ fields: ['id', ...fields], read: async ({ context }) =>
      (model === TURN ? access.turn : model === PARENT ? access.parent : model === CONVERSATION ? access.conversation : access.run) &&
      (await context.memberships.findMembership(TEAM, model === TURN ? 'turn-reader' : model === PARENT || model === CONVERSATION ? 'parent-reader' : 'caller'))?.status === 'active' &&
      context.membership?.status === 'active',
    }] });
  }
  for (const def of [root, child]) bindScenarioReceiptReferenceProducer(def, { source, app: APP, policy, readPolicies });
  bindScenarioReceiptQueryProducer(child, { source, app: APP, policy });
  return { store, batches, memberships, caller, reader, parentReader, root, child, table, policy, access, readPolicies, rows,
 registry: loaded.registry, app: APP, source: 'component', clock: { nowMs: () => FIXED_NOW },
    activeRootCall: undefined as AdmittedCall | undefined, identity: makeIdentity({ membership: caller }), envelope: makeEnvelope(ROOT, uuidv7(FIXED_NOW, ++sequence), {}) };
}

type Mode = 'normal' | 'copy' | 'foreign-view' | 'wrong-context' | 'missing-marker' | 'wrong-dependency' |
  'missing-binder' | 'copied-observation' | 'missing-observation' | 'prior-candidate' | 'closed' | 'pending' | 'refused' | 'fake-row';
const refuses = (error: unknown) => error instanceof StateError;
function bindNativeChild(w: Awaited<ReturnType<typeof world>>, mode: Mode) {
  const issued: StoredRow[] = [], failures: unknown[] = [];
  let context: HandlerContext | undefined, candidate: unknown;
  bindScenarioReceiptCallProducer(w.root, { source, app: APP, registry: w.registry,
    sites: [{ id: 'reserve-site', source, kind: 'operation', targets: [{ operation: CHILD, interface: w.child.descriptor }],
      resultType: RUN as CanTypeId }], prepare: (_def, inputs) => inputs as ClosedInputs,
    execute: async owner => {
      const c = createContext({ caller: { userId: 'caller', roles: [] }, store: w.store, qualified: owner.call.context });
      context = c;
      let frame!: ScenarioReceiptFrame;
      const views = new Map<string, { readonly view: Record<string, unknown>; current: StoredRow }>();
      const mutableRecord = async (model: string, row: StoredRow, privateMode?: 'query-parent') => {
        assert.equal(privateMode, 'query-parent');
        issued.push(row);
        if (mode === 'closed') frame.close();
        if (mode === 'pending') await readScenarioReceiptQueryParent(c, candidate, 'branch-parent');
        let existing = views.get(row.id);
        const view: Record<string, unknown> = {};
        existing = { view, current: mode === 'fake-row' ? { ...row } : row }; views.set(row.id, existing);
        Object.defineProperty(view, 'parent', { get: () => {
          const parent = existing!.current.parent!; return makeRecordRef(parent.model, parent.id);
        } });
        bindNativeRecord(view, model, row.id, row.version); Object.freeze(view);
        frame.bind(view, model, () => existing!.current); return view;
      };
      frame = openScenarioReceiptFrame(c, owner.call, w.store, error => failures.push(error), undefined, {
        record: (model, record, read, current) => {
          const view: Record<string, unknown> = {};
          Object.defineProperty(view, 'account', { get: () => { read('account'); return current().data.account; } });
          Object.defineProperty(view, 'parent', { get: () => { read('parent');
            const parent = current().parent!; return makeRecordRef(parent.model, parent.id);
          } });
          bindNativeRecord(view, model, record.id, record.version); return Object.freeze(view);
        }, encode: value => value, ...(mode === 'missing-binder' ? {} : { mutableRecord }),
      });
      let previous: unknown;
      try {
        const rows = await nativeQuery(c, 'turns', async run => {
          candidate = run;
          if (mode === 'wrong-context') await assert.rejects(readScenarioReceiptQueryParent({ ...c }, run, 'branch-parent'), refuses);
          const account = run.account; queryObserve(c, TURN, run, 'account', 'account-control');
          const parent = run.parent;
          if (mode !== 'missing-marker') queryObserve(c, TURN, run, 'parent', 'parent-control');
          if (mode === 'refused') w.access.parent = false;
          const supplied = mode === 'copy' ? { ...run } : mode === 'foreign-view' ? makeRecordRef(TURN, String(run.id))
            : mode === 'prior-candidate' && previous !== undefined ? previous : run;
          const branch = await readScenarioReceiptQueryParent(c, supplied, mode === 'wrong-dependency' ? 'account-control' : 'branch-parent');
          assert.ok(parent); assert.equal(branch.parent === null, false);
          const ancestor = branch.parent;
          if (mode !== 'missing-observation') await nativeObserve(c, PARENT,
            mode === 'copied-observation' ? { ...branch } : branch, 'parent', 'branch-parent');
          previous = run;
          return account === 'caller' && (ancestor as { id: string }).id === 'conversation-a';
        });
        const count = await countQuery(c, rows); assert.equal(count, 2n);
        frame.assertCompleted();
        await owner.session.stage({ op: 'create', model: RUN, id: CREATED, data: { account: 'caller', title: String(count) } }, cause);
        const row = await owner.session.read(RUN, CREATED); assert.ok(row);
        const wire = await bindScenarioReceiptModelResult(owner.call, w.store, { returnId: 'child-return', row });
        selectScenarioReceiptReturn(owner.call, w.store, 'child-return'); return wire;
      } finally { frame.close(); }
    } });
  return { issued, failures, get context() { return context; }, get candidate() { return candidate; } };
}
async function nativeInput(w: Awaited<ReturnType<typeof world>>, observed?: (receipt: Receipt) => void) {
  return { ...w, ...(observed === undefined ? {} : { observeCommittedReceipt: observed }), execute: async (call: AdmittedCall) => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await invokeScenarioReceiptCall(call, w.store, { site: 'reserve-site', target: CHILD, inputs: {} });
    const row = await session.read(RUN, CREATED); assert.ok(row);
    const wire = await bindScenarioReceiptModelResult(call, w.store, { returnId: 'root-return', row });
    selectScenarioReceiptReturn(call, w.store, 'root-return'); return { ...await session.finalize(), result: wire, outbox: [] };
  } };
}
test('native candidate parent facade retains per-candidate owning observations and original count', async () => {
  for (const mode of ['normal', 'wrong-context'] as const) {
    const w = await world(), native = bindNativeChild(w, mode); let receipt: Receipt | undefined;
    const request = await nativeInput(w, value => { receipt = value; });
    assert.equal((await invoke(request)).status, 'committed'); assert.ok(receipt);
    assert.equal(native.issued.length, 4); assert.notEqual(native.issued[0], native.issued[3], 'shared Branch still has separate State row issuance');
    const saved = readScenarioReceiptAssociation(receipt)!.calls![0]!.scenario!;
    assert.deepEqual(saved.queries![0]!.selectedIndices, [0, 1]);
    assert.equal(saved.observations.filter(item => item.dependencyId === 'branch-parent').length, 4);
    assert.deepEqual(native.failures, []);
    assert.equal((await invoke(request)).status, 'replayed'); assert.equal(native.issued.length, 4);
    await assert.rejects(readScenarioReceiptQueryParent(native.context!, native.candidate, 'branch-parent'), refuses);
  }
});
test('native parent facade rejects substituted carriers, incomplete markers, authority loss and crossed await lifetimes', async () => {
  for (const mode of ['copy', 'foreign-view', 'missing-marker', 'wrong-dependency', 'missing-binder',
    'copied-observation', 'missing-observation', 'prior-candidate', 'closed', 'pending', 'refused', 'fake-row'] as const) {
    const w = await world(); bindNativeChild(w, mode); const revision = await w.store.readRevision();
    const before = w.batches.length, request = await nativeInput(w);
    await assert.rejects(invoke(request), refuses);
    assert.equal(await w.store.load(RUN, CREATED), null, mode);
    assert.equal(w.batches.length, before + 1, mode);
    const rejected = w.batches.at(-1)!;
    assert.equal(rejected.expectedRevision, revision, mode);
    assert.deepEqual(rejected.writes, [], mode); assert.deepEqual(rejected.history, [], mode);
    assert.deepEqual(rejected.outbox, [], mode); assert.deepEqual(rejected.schedules, [], mode);
    assert.deepEqual(rejected.uniqueClaims, [], mode); assert.deepEqual(rejected.uniqueReleases, [], mode);
    assert.equal(rejected.receipt?.outcome.status, 'rejected', mode);
    assert.equal(Object.hasOwn(rejected.receipt!.outcome, 'scenario'), false, mode);
    assert.equal(await w.store.readRevision(), revision + 1, mode);
    await assert.rejects(invoke(request), refuses);
    assert.equal(w.batches.length, before + 1, `${mode} refusal replay adds no commit`);
    assert.equal(await w.store.load(RUN, CREATED), null, mode);
  }
});


// These linked supplied-parent checks require reviewed Contracts queryId and
// corrected State capture/save validation. They do not qualify native lowering.
type SuppliedMode = 'normal' | 'both-linked' | 'skipped' | 'copy' | 'current' | 'unassociated' | 'wrong-query' |
  'pending' | 'detached' | 'closed' | 'refused' | 'foreign-context' | 'post-query';
async function suppliedWorld(mode: SuppliedMode) {
  return world(slice => {
    const child = slice.operations!.find(operation => operation.name === CHILD)!;
    child.inputs.fields.push({ name: 'branch', field: { kind: 'ref', model: PARENT, requireVersion: true }, required: true });
    const disclosure = child.result!.disclosure!, returned = disclosure.returns[0]!;
    const other = { ...structuredClone(disclosure.queries![0]!), id: 'other-turns',
      dependencies: disclosure.queries![0]!.dependencies.map(entry => ({ ...entry, id: `${entry.id}-other` })),
    };
    child.result = { ...child.result!, disclosure: { ...disclosure,
      queries: mode === 'wrong-query' ? [...disclosure.queries!, other] : disclosure.queries!,
      returns: [{ ...returned,
        dependencies: [...returned.dependencies.map(dependency => mode === 'both-linked' ? { ...dependency, queryId: 'turns' } : dependency), { id: 'supplied-branch-parent', source, role: 'control', model: PARENT,
          field: 'parent', type: CONVERSATION as CanTypeId,
          ...(mode === 'unassociated' ? {} : { queryId: mode === 'wrong-query' ? 'other-turns' : 'turns' }),
        }],
        influences: mode !== 'wrong-query' ? returned.influences : [...returned.influences,
          ...(['query-existence', 'query-cardinality', 'query-membership', 'query-order'] as const)
            .map(kind => ({ id: `other-${kind}`, kind, queryId: 'other-turns' })),
        ],
      }],
    } };
  });
}
function bindSuppliedChild(w: Awaited<ReturnType<typeof world>>, mode: SuppliedMode) {
  let executions = 0, observations = 0;
  bindScenarioReceiptCallProducer(w.root, { source, app: APP, registry: w.registry,
    sites: [{ id: 'reserve-site', source, kind: 'operation', targets: [{ operation: CHILD, interface: w.child.descriptor }],
      resultType: RUN as CanTypeId }], prepare: (_def, inputs) => inputs as ClosedInputs,
    execute: async owner => {
      executions++;
      const c = createContext({ caller: { userId: 'caller', roles: [] }, store: w.store, qualified: owner.call.context });
      let frame!: ScenarioReceiptFrame;
      const admitted = owner.call.recordRefs.find(reference => reference.model === PARENT)!;
      assert.ok(admitted);
      const current = mode === 'current' ? await owner.session.read(PARENT, admitted.row.id) : admitted.row;
      assert.ok(current);
      if (mode === 'current') assert.notEqual(current, admitted.row);
      const supplied: Record<string, unknown> = {};
      Object.defineProperty(supplied, 'parent', { enumerable: true, get: () => {
        const parent = current.parent!; return makeRecordRef(parent.model, parent.id);
      } });
      bindNativeRecord(supplied, PARENT, current.id, current.version); Object.freeze(supplied);
      frame = openScenarioReceiptFrame(c, owner.call, w.store, () => {}, undefined, {
        record: (model, record, read, projected) => {
          const view: Record<string, unknown> = {};
          Object.defineProperty(view, 'account', { get: () => { read('account'); return projected().data.account; } });
          Object.defineProperty(view, 'parent', { get: () => { read('parent');
            const parent = projected().parent!; return makeRecordRef(parent.model, parent.id);
          } });
          bindNativeRecord(view, model, record.id, record.version); return Object.freeze(view);
        }, encode: value => value,
        mutableRecord: (model, row, privateMode) => {
          assert.equal(privateMode, 'query-parent');
          const view: Record<string, unknown> = { parent: makeRecordRef(row.parent!.model, row.parent!.id) };
          bindNativeRecord(view, model, row.id, row.version); Object.freeze(view);
          frame.bind(view, model, () => row); return view;
        },
      }, async (_input, healthy) => {
        healthy();
        if (_input.dependencyId === 'supplied-branch-parent') {
          observations++;
          if (mode === 'pending') await nativeObserve(c, PARENT, supplied, 'parent', 'supplied-branch-parent');
          if (mode === 'detached') await new Promise<void>(resolve => setImmediate(resolve));
          if (mode === 'closed') frame.close();
        }
        healthy(); return undefined;
      });
      frame.bind(supplied, PARENT, () => current);
      try {
        const rows = await nativeQuery(c, 'turns', async run => {
          const account = run.account; queryObserve(c, TURN, run, 'account', 'account-control');
          void run.parent; queryObserve(c, TURN, run, 'parent', 'parent-control');
          const branch = await readScenarioReceiptQueryParent(c, run, 'branch-parent');
          const ancestor = branch.parent;
          await nativeObserve(c, PARENT, branch, 'parent', 'branch-parent');
          // Both original parent occurrences stay here, after the candidate
          // marker, rather than becoming query scope or a hoisted root read.
          const suppliedAncestor = mode === 'skipped' ? undefined : supplied.parent;
          if (mode === 'refused') w.access.parent = false;
          if (mode === 'foreign-context') await assert.rejects(nativeObserve({ ...c }, PARENT, supplied,
            'parent', 'supplied-branch-parent'), refuses);
          if (mode !== 'skipped') {
            const observed = nativeObserve(c, PARENT, mode === 'copy' ? { ...supplied } : supplied,
              'parent', 'supplied-branch-parent');
            if (mode !== 'detached') await observed;
          }
          return mode !== 'skipped' && account === 'caller' && (ancestor as { id: string }).id === (suppliedAncestor as { id: string }).id;
        });
        if (mode === 'post-query') await nativeObserve(c, PARENT, supplied, 'parent', 'supplied-branch-parent');
        const count = await countQuery(c, rows); assert.equal(count, mode === 'skipped' ? 0n : 2n); frame.assertCompleted();
        await owner.session.stage({ op: 'create', model: RUN, id: CREATED, data: { account: 'caller', title: String(count) } }, cause);
        const row = await owner.session.read(RUN, CREATED); assert.ok(row);
        const wire = await bindScenarioReceiptModelResult(owner.call, w.store, { returnId: 'child-return', row });
        selectScenarioReceiptReturn(owner.call, w.store, 'child-return'); return wire;
      } finally { frame.close(); }
    } });
  return { get executions() { return executions; }, get observations() { return observations; } };
}
async function suppliedInput(w: Awaited<ReturnType<typeof world>>, observed?: (receipt: Receipt) => void) {
  const row = await w.store.load(PARENT, asId('branch-a')); assert.ok(row);
  const request = await nativeInput(w, observed);
  return { ...request, execute: async (call: AdmittedCall) => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await invokeScenarioReceiptCall(call, w.store, { site: 'reserve-site', target: CHILD,
      inputs: { branch: { id: row.id, version: String(row.version) } } });
    const created = await session.read(RUN, CREATED); assert.ok(created);
    const wire = await bindScenarioReceiptModelResult(call, w.store, { returnId: 'root-return', row: created });
    selectScenarioReceiptReturn(call, w.store, 'root-return'); return { ...await session.finalize(), result: wire, outbox: [] };
  } };
}
test('query-linked supplied admitted parent remains distinct and awaited at each original candidate', async () => {
  for (const mode of ['normal', 'both-linked', 'foreign-context', 'skipped'] as const) {
    const w = await suppliedWorld(mode), child = bindSuppliedChild(w, mode); let receipt: Receipt | undefined;
    const request = await suppliedInput(w, value => { receipt = value; });
    assert.equal((await invoke(request)).status, 'committed'); assert.ok(receipt);
    const saved = readScenarioReceiptAssociation(receipt)!.calls![0]!.scenario!;
    assert.equal(saved.observations.filter(item => item.dependencyId === 'branch-parent').length, 4);
    assert.equal(saved.observations.filter(item => item.dependencyId === 'supplied-branch-parent').length, mode === 'skipped' ? 0 : 4);
    assert.deepEqual(saved.queries![0]!.selectedIndices, mode === 'skipped' ? [] : [0, 1]); assert.equal(child.observations, mode === 'skipped' ? 0 : 4);
    if (mode === 'both-linked') assert.ok(saved.queries![0]!.candidates.every(candidate =>
      candidate.dependencies.includes('branch-parent') && candidate.dependencies.includes('supplied-branch-parent')));
    assert.equal((await invoke(request)).status, 'replayed'); assert.equal(child.executions, 1);
  }
});
test('supplied query parent refuses unassociated, substituted, unrelated, current-row and crossed-await observations', async () => {
  for (const mode of ['copy', 'current', 'unassociated', 'wrong-query', 'pending', 'detached', 'closed', 'refused', 'post-query'] as const) {
    const w = await suppliedWorld(mode); bindSuppliedChild(w, mode); const revision = await w.store.readRevision();
    const before = w.batches.length, request = await suppliedInput(w);
    await assert.rejects(invoke(request), refuses);
    assert.equal(await w.store.load(RUN, CREATED), null, mode);
    assert.equal(w.batches.length, before + 1, mode);
    const rejected = w.batches.at(-1)!;
    assert.equal(rejected.expectedRevision, revision, mode);
    assert.deepEqual(rejected.writes, [], mode); assert.deepEqual(rejected.history, [], mode);
    assert.deepEqual(rejected.outbox, [], mode); assert.deepEqual(rejected.schedules, [], mode);
    assert.deepEqual(rejected.uniqueClaims, [], mode); assert.deepEqual(rejected.uniqueReleases, [], mode);
    assert.equal(rejected.receipt?.outcome.status, 'rejected', mode);
    assert.equal(Object.hasOwn(rejected.receipt!.outcome, 'scenario'), false, mode);
    assert.equal(await w.store.readRevision(), revision + 1, mode);
    await assert.rejects(invoke(request), refuses);
    assert.equal(w.batches.length, before + 1, `${mode} refusal replay adds no commit`);
    assert.equal(await w.store.load(RUN, CREATED), null, mode);
  }
});
