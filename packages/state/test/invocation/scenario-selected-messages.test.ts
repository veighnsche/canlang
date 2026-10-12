/** Genuine State selected-message receiver controls; handbound source, no native/app claim. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, FinalizedFileObservation, FinalizedFileReceiver, ModelName, Receipt, RetainedFinalizedFile, StoredRow } from '@canlang/contracts';
import { createMemoryIdentityStore, createFrozenClock } from '@canlang/identity/testing';
import { finalizeProviderOutput, observeFinalizedFile } from '@canlang/files/finalize';
import { DEFAULT_FILE_POLICY, blobKeyForFile, revalidateRetainedFinalizedFile } from '@canlang/files';
import { TestOnlyCounterFileIds, TestOnlyCounterIntentIds, TestOnlyManualClock,
  TestOnlyMemoryBlobStore, TestOnlyMemoryFinalizedStore, TestOnlyMemoryIntentStore } from '@canlang/files/ports';
import { StateError } from '../../src/errors.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { loadArtifactDescriptors, isGeneratedOperationDef, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { invoke, invokeRetainedReceiptOnly } from '../../src/invocation/invoke.js';
import type { AdmittedCall } from '../../src/invocation/admission.js';
import { buildModelTableFromCanonical } from '../../src/mutation/models.js';
import { buildPolicyTable } from '../../src/policy/grants.js';
import type { ViewerSourceReadPolicy } from '../../src/query/source-policy.js';
import { beginScenarioReceiptMutation, bindScenarioReceiptQueryProducer, bindScenarioReceiptReferenceProducer,
  bindScenarioReceiptFileProducer, executeScenarioReceiptQuery, observeScenarioReceiptQueryDependency,
  bindScenarioReceiptQuerySelection, bindScenarioReceiptQueryCount, selectScenarioReceiptQueryFirstRow,
  bindScenarioReceiptModelResult, selectScenarioReceiptReturn,
  readScenarioReceiptAssociation, projectScenarioReceipt } from '../../src/invocation/scenario-receipt.js';
import { asId, asModel, FIXED_NOW, makeBatch, makeEnvelope, makeIdentity,
  seedRow, makeRow, updateRow, uuidv7 } from './fixtures.js';

const CONVERSATION = asModel('SelectedMessages.Conversation'), BRANCH = asModel('SelectedMessages.Branch');
const TURN = asModel('SelectedMessages.Turn'), RUN = asModel('SelectedMessages.Run');
const OP = 'SelectedMessages.collect', APP = 'selected-message-receiver', TYPE = 'std.TextMessage[]' as CanTypeId;
const ROLE = 'std.TextMessage.role' as CanTypeId;
const source = { path: 'selected-messages.can', sha256: 'b'.repeat(64), module: 'selected-messages.mjs' };
const retention = { unattachedHorizonMs: 60_000, retentionMs: 120_000 };
let sequence = 104_000;
const refuses = (error: unknown) => error instanceof StateError;
const mapping = [{ name: 'role', field: 'role', type: ROLE }, { name: 'content', field: 'content', type: 'text' as CanTypeId },
  { name: 'attachments', field: 'attachments', type: 'file[]' as CanTypeId }];

async function world(options: { domain?: 'empty' | 'false'; twice?: boolean; noFiles?: boolean; stopAfterFirstAttempt?: boolean } = {}) {
  const ids = options.twice ? ['messages', 'messages-again'] : ['messages'];
  const suffix = (id: string) => id === 'messages' ? '' : '-again';
  const slice: ArtifactDescriptorSlice = { artifact_version: 1, sources: [{ path: source.path, sha256: source.sha256 }],
    modules: [{ path: source.module, js: 'export const identity="SelectedMessages.collect";', map: {
      version: 3, file: source.module, sources: [source.path], sourcesContent: [null], names: [], mappings: '',
    } }], callables: [{ id: OP, kind: 'operation', module: source.module, export: 'identity', member: ['collect'] }],
    valueTypes: { contracts: [{ name: 'std.TextMessage', fields: [
      { name: 'role', type: ROLE }, { name: 'content', type: 'text' as CanTypeId, max: 100 },
      { name: 'attachments', type: 'file[]' as CanTypeId, max: 8 },
    ] }], enums: [{ name: ROLE, cases: ['system', 'user', 'assistant'] }] }, models: [
      { name: CONVERSATION, deleteMode: 'archive', fields: [{ name: 'title', field: { kind: 'string' }, required: true, serverOnly: false }] },
      { name: BRANCH, parent: CONVERSATION, deleteMode: 'archive', fields: [{ name: 'title', field: { kind: 'string' }, required: true, serverOnly: false }] },
      { name: TURN, parent: BRANCH, deleteMode: 'archive', fields: [
        { name: 'role', field: { kind: 'enum', values: ['system', 'user', 'assistant'] }, valueType: ROLE, required: true, serverOnly: false },
        { name: 'content', field: { kind: 'string' }, valueType: 'text' as CanTypeId, max: 100, required: true, serverOnly: false },
        { name: 'attachments', field: { kind: 'file' }, valueType: 'file[]' as CanTypeId, array: { required: false }, max: 8, required: false, serverOnly: false },
        { name: 'position', field: { kind: 'integer' }, valueType: 'int' as CanTypeId, required: true, serverOnly: false },
      ] },
      { name: RUN, parent: BRANCH, deleteMode: 'archive', fields: [{ name: 'count', field: { kind: 'integer' }, valueType: 'int' as CanTypeId, required: true, serverOnly: false }] },
    ], operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [
      { name: 'branch', field: { kind: 'ref', model: BRANCH, requireVersion: true }, required: true },
    ] }, result: { type: RUN as CanTypeId, disclosure: { version: 1, source,
      queries: ids.map(id => ({ id, source, model: TURN, parent: { source, model: BRANCH,
        origin: { kind: 'admitted-reference' as const, parameter: 'branch' } }, order: [{ field: 'position', direction: 'asc' as const }],
        limit: null, archived: 'exclude' as const, dependencies: [
          { id: `position-control${suffix(id)}`, source, role: 'control' as const, field: 'position', type: 'int' as CanTypeId },
          ...mapping.map(item => ({ id: `data-${item.name}${suffix(id)}`, source, role: 'data' as const, field: item.field, type: item.type })),
        ] })), returns: [{ id: 'created-run', source,
        influences: ids.flatMap(queryId => (['query-existence', 'query-cardinality', 'query-membership', 'query-order'] as const)
          .map(kind => ({ id: `${queryId}-${kind}`, kind, queryId }))),
        dependencies: ids.flatMap(queryId => mapping.map(item => ({ id: `q-${item.name}${suffix(queryId)}`, queryId,
          source, role: 'data' as const, model: TURN, field: item.field, type: item.type }))),
      }],
    } } }] };
  const loaded = loadArtifactDescriptors(slice, { by: 'members' });
  const def = loaded.registry.get(OP); assert.ok(def && isGeneratedOperationDef(def));
  const store = createMemoryStorage(), memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const team = await memberships.createTeam({ timezone: 'UTC' });
  const caller = await memberships.createUser({ email: 'selected-caller@example.test', password_hash: 'unused', email_verified: true });
  const subject = await memberships.createUser({ email: 'selected-subject@example.test', password_hash: 'unused', email_verified: true });
  const member = { team, user: caller, membership: await memberships.createMembership({ team_id: team.team_id,
    user_id: caller.user_id, is_owner: false, roles: [] }) };
  const related = { team, user: subject, membership: await memberships.createMembership({ team_id: team.team_id,
    user_id: subject.user_id, is_owner: false, roles: [] }) };
  const identity = makeIdentity({ membership: member.membership });
  const receiver: FinalizedFileReceiver = { app: APP, team: member.team.team_id, owner: member.team.team_id, principal: member.user.user_id };
  const clock = new TestOnlyManualClock(FIXED_NOW), blobs = new TestOnlyMemoryBlobStore(), files = new TestOnlyMemoryFinalizedStore(), intents = new TestOnlyMemoryIntentStore();
  const upload = { clock, blobs, intents, intentIds: new TestOnlyCounterIntentIds(), policy: DEFAULT_FILE_POLICY,
    intentTtlMs: 60_000, urlBase: 'https://selected-messages.invalid' };
  const finalize = { clock, blobs, intents, files, fileIds: new TestOnlyCounterFileIds() };
  let delivery = 0;
  const finish = (receiving = receiver) => {
    const result = finalizeProviderOutput(upload, finalize, { receiver: receiving,
      binding: { adapter: 'selected-test', deliveryId: `delivery-${++delivery}`, resultPath: 'attachment' }, operation: 'SelectedMessages.receive',
      field: '/attachment', args: {}, name: 'selected.txt', claimedType: 'text/plain', bytes: new TextEncoder().encode(`bytes-${delivery}`) });
    assert.equal(result.status, 'finalized'); if (result.status !== 'finalized') throw new Error('File finalization failed'); return result.file.id;
  };
  const refs = [finish(), finish()] as const;
  const observe = (id: string, receiving = receiver) => { const value = observeFinalizedFile(finalize, id, receiving,
    { policy: DEFAULT_FILE_POLICY, retention }); assert.ok(value); return value; };
  const access = { data: true, ancestor: true }, policy = buildPolicyTable([], loaded.models);
  const readPolicies = new Map<ModelName, ViewerSourceReadPolicy>([
    [CONVERSATION, { fields: ['title'], secretFields: [], grants: [{ fields: ['title'], read: async () => access.ancestor }] }],
    [BRANCH, { parent: CONVERSATION, fields: ['title'], secretFields: [], grants: [{ fields: ['title'], read: async ({ context }) => access.ancestor &&
      (!options.stopAfterFirstAttempt || (await context.memberships.findMembership(member.team.team_id, related.user.user_id))?.status === 'active') }] }],
    [TURN, { parent: BRANCH, fields: ['role', 'content', 'attachments', 'position'], secretFields: [], grants: [
      { fields: ['id', 'position'], read: async ({ context }) => context.membership?.status === 'active' },
      { fields: ['role', 'content', 'attachments'], read: async ({ context, row }) => access.data && row.id !== 'false' &&
        (await context.memberships.findMembership(member.team.team_id, related.user.user_id))?.status === 'active' },
    ] }],
    [RUN, { parent: BRANCH, fields: ['count'], secretFields: [], grants: [{ fields: ['count'], read: async ({ context }) => context.membership?.status === 'active' }] }],
  ]);
  const revalidate = (retained: RetainedFinalizedFile, receiving: FinalizedFileReceiver) =>
    revalidateRetainedFinalizedFile(finalize, retained, receiving, { policy: DEFAULT_FILE_POLICY, retention });
  if (!options.noFiles) bindScenarioReceiptFileProducer(def, { source, app: APP, revalidate });
  bindScenarioReceiptReferenceProducer(def, { source, app: APP, policy, readPolicies });
  bindScenarioReceiptQueryProducer(def, { source, app: APP, policy, readPolicies,
    selections: ids.map(queryId => ({ queryId, type: TYPE,
      fields: mapping.map(item => ({ name: item.name, dependencyId: `q-${item.name}${suffix(queryId)}` })) })),
  });
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, containment: loaded.containment,
    nullableFields: loaded.nullableFields, ...(loaded.valueSchema === undefined ? {} : { valueSchema: loaded.valueSchema }) });
  const conversation = await seedRow(store, CONVERSATION, { id: 'conversation', data: { title: 'Conversation' } });
  const branch: StoredRow = { ...makeRow({ id: 'branch', data: { title: 'Branch' } }), parent: { model: CONVERSATION, id: conversation.id } };
  const other: StoredRow = { ...makeRow({ id: 'other-branch', data: { title: 'Other' } }), parent: branch.parent ?? null };
  await store.commit(makeBatch(await store.readRevision(), { writes: [branch, other].map(row => ({ kind: 'insert' as const, model: BRANCH, row })) }));
  const turns: StoredRow[] = [];
  for (const [id, position, role, content, attachments, parent] of [
    ['second', '2', 'assistant', 'Second', [{ id: refs[1] }], branch],
    ['first', '1', 'user', 'First', [{ id: refs[1] }, { id: refs[0] }, { id: refs[1] }], branch],
    ['false', '3', 'user', 'Hidden false data', [], branch],
    ['excluded', '0', 'system', 'Other branch', [], other],
  ] as const) {
    const row: StoredRow = { ...makeRow({ id, data: { position, role, content, attachments } }), parent: { model: BRANCH,
      id: options.domain === 'empty' ? other.id : parent.id } };
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: TURN, row }] })); turns.push(row);
  }
  const expected = options.domain === 'empty' || options.domain === 'false' ? [] : [
    { role: 'user', content: 'First', attachments: [{ id: refs[1] }, { id: refs[0] }, { id: refs[1] }] },
    { role: 'assistant', content: 'Second', attachments: [{ id: refs[1] }] },
  ];
  let receipt: Receipt | undefined, executions = 0, predicates = 0;
  const request = { store, memberships, identity, registry: loaded.registry, policy, readPolicies, app: APP, source: 'component',
    clock: { nowMs: () => FIXED_NOW }, envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence), { branch: { id: branch.id, version: '1' } }),
    observeCommittedReceipt: (value: Receipt) => { receipt = value; } };
  type Mode = 'copied-query' | 'copied-slot' | 'order' | 'wire' | 'missing-files' | 'extra-files' | 'copied-files' | 'foreign-files' | 'false-slot' | 'stale-stage' | 'wrong-query'
    | 'role-set' | 'first-bypass' | 'count-bypass' | 'rows-accessor' | 'wrong-call-caught' | 'wrong-store-caught';
  let accessors = 0, bindingActive = false, selectionExposures = 0, firstBindingError: unknown;
  const run = (mode?: Mode, afterSelection?: () => Promise<void> | void) => invoke({ ...request, execute: async (call: AdmittedCall) => {
    executions++;
    if (options.stopAfterFirstAttempt && executions > 1) throw new StateError('rule_failed', 'Test stops after first selected-message attempt');
    const session = await beginScenarioReceiptMutation(call, store, { table, bounds: { maxRows: 20, maxWork: 4000 } });
    const selections: Array<readonly unknown[]> = [], handles: Array<Awaited<ReturnType<typeof executeScenarioReceiptQuery>>> = [];
    const falseSlots: object[] = [];
    for (const queryId of ids) {
      const query = await executeScenarioReceiptQuery(call, store, { queryId, predicate: ({ slot, record }) => {
        predicates++; const position = record.data.position;
        observeScenarioReceiptQueryDependency(call, store, { slot, dependencyId: `position-control${suffix(queryId)}` });
        if (record.id === 'false') falseSlots.push(slot);
        return options.domain !== 'false' && BigInt(String(position)) < 3n;
      } }); handles.push(query);
    }
    let count = 0;
    for (const [index, query] of handles.entries()) {
      const wire = query.rows.map(({ record }) => ({ role: record.data.role, content: record.data.content, attachments: record.data.attachments }));
      const facts: Array<{ slot: Readonly<object>; files: FinalizedFileObservation[] }> = query.rows.map(({ record, slot }) => ({
        slot, files: [...new Set((record.data.attachments as Array<{ id: string }>).map(file => file.id))].map(id => observe(id)),
      }));
      if (mode === 'copied-slot') facts[0]!.slot = { ...facts[0]!.slot };
      if (mode === 'order') { wire.reverse(); facts.reverse(); }
      if (mode === 'wire') wire[0]!.content = 'Invented';
      if (mode === 'role-set') wire[0]!.role = 'tool';
      if (mode === 'missing-files') facts[0]!.files = [];
      if (mode === 'extra-files') facts[0]!.files.push(observe(finish()));
      if (mode === 'copied-files') facts[0]!.files[0] = structuredClone(facts[0]!.files[0]!);
      if (mode === 'foreign-files') { const foreignReceiver = { ...receiver, principal: 'foreign' }; facts[0]!.files[0] = observe(finish(foreignReceiver), foreignReceiver); }
      if (mode === 'false-slot') facts[0]!.slot = falseSlots[0]!;
      if (mode === 'stale-stage') await session.stage({ op: 'update', model: BRANCH, id: branch.id, data: { title: 'Later stage' } }, { cause: 'scenario' });
      if (mode === 'first-bypass') await selectScenarioReceiptQueryFirstRow(call, store, { query: query.query });
      if (mode === 'count-bypass') await bindScenarioReceiptQueryCount(call, store, { query: query.query });
      if (mode === 'rows-accessor') {
        const original = facts[0]!;
        Object.defineProperty(facts, '0', { enumerable: true, get() { accessors++; return original; } });
      }
      if (mode === 'wrong-call-caught' || mode === 'wrong-store-caught') {
        await assert.rejects(bindScenarioReceiptQuerySelection(mode === 'wrong-call-caught' ? { ...call } : call,
          mode === 'wrong-store-caught' ? { ...store } : store, { query: query.query, wire, rows: facts }), refuses);
        await assert.rejects(session.finalize(), refuses);
        throw new StateError('validation', 'Caught wrong call/store selection poisoned its authentic owner');
      }
      let selected: readonly unknown[];
      bindingActive = true;
      try {
        selected = await bindScenarioReceiptQuerySelection(call, store, { query: mode === 'copied-query' ? { ...query.query }
          : mode === 'wrong-query' ? handles[(index + 1) % handles.length]!.query : query.query, wire, rows: facts });
        selectionExposures++;
      } catch (error) { firstBindingError ??= error; throw error; }
      finally { bindingActive = false; }
      assert.deepEqual(selected, expected); assert.ok(Object.isFrozen(selected));
      if (selected.length) assert.ok(Object.isFrozen(selected[0]));
      selections.push(selected); count += selected.length;
    }
    if (selections.length > 1) assert.notEqual(selections[0], selections[1], 'distinct occurrences must not memoize');
    await session.stage({ op: 'create', model: RUN, id: asId('created-run'), parent: { model: BRANCH, id: branch.id }, data: { count: String(count) } }, { cause: 'scenario' });
    await afterSelection?.();
    const row = await session.read(RUN, asId('created-run')); assert.ok(row);
    const result = await bindScenarioReceiptModelResult(call, store, { returnId: 'created-run', row });
    selectScenarioReceiptReturn(call, store, 'created-run'); return { ...await session.finalize(), result, outbox: [] };
  } });
  return { ...request, slice, run, expected, refs, turns, branch, access, blobs, related, member,
    receipt: () => { assert.ok(receipt); return receipt; }, executions: () => executions, predicates: () => predicates,
    accessors: () => accessors, bindingActive: () => bindingActive, selectionExposures: () => selectionExposures,
    firstBindingError: () => firstBindingError };
}

test('selected messages preserve full true/false/empty source domains, position order and ordinary DATA/file snapshots', async () => {
  for (const domain of [undefined, 'empty', 'false'] as const) {
    const w = await world(domain === undefined ? {} : { domain }); assert.equal((await w.run()).status, 'committed');
    const association = readScenarioReceiptAssociation(w.receipt())!;
    const query = association.queries![0]!;
    assert.deepEqual(query.candidates.map(candidate => candidate.row.id).sort(), domain === 'empty' ? [] : ['false', 'first', 'second']);
    assert.deepEqual(query.selectedIndices.map(index => query.candidates[index]!.row.id), domain === undefined ? ['first', 'second'] : []);
    assert.equal(association.observations.length, domain === undefined ? 6 : 0);
    if (domain === undefined) {
      assert.deepEqual(association.observations.filter(observation => observation.dependencyId === 'q-attachments').map(observation => observation.files!.map(file => file.ref)),
        [[w.refs[1], w.refs[0]], [w.refs[1]]]);
      const rejected = query.candidates.find(candidate => candidate.row.id === 'false')!;
      assert.deepEqual(rejected.dependencies, ['position-control']); assert.equal(Object.hasOwn(rejected.record.data, 'content'), false);
      for (const candidate of query.candidates.filter(candidate => candidate.matched)) for (const id of ['q-role', 'q-content', 'q-attachments']) assert.ok(candidate.dependencies.includes(id));
    }
    const row = await w.store.load(RUN, asId('created-run')); assert.ok(row); assert.equal(row.data.count, String(w.expected.length));
    assert.equal((await w.store.historyFor(RUN, row.id)).length, 1);
  }
});

test('distinct selected-message occurrences retain separate snapshots and immutable arrays', async () => {
  const w = await world({ twice: true }); assert.equal((await w.run()).status, 'committed');
  const association = readScenarioReceiptAssociation(w.receipt())!;
  assert.equal(association.queries!.length, 2); assert.equal(association.observations.length, 12); assert.equal(w.predicates(), 6);
  assert.equal((await w.store.load(RUN, asId('created-run')))!.data.count, '4');
});

test('selected empty File-bearing query requires a genuine Files producer', async () => {
  const w = await world({ domain: 'empty', noFiles: true }); await assert.rejects(w.run(), refuses);
  assert.equal(await w.store.load(RUN, asId('created-run')), null);
});

test('selection refuses copied/foreign query and slots, wrong order/wire/facts, false slots and stale owner stages', async () => {
  for (const mode of ['copied-query', 'copied-slot', 'order', 'wire', 'missing-files', 'extra-files', 'copied-files', 'foreign-files', 'false-slot', 'stale-stage', 'wrong-query'] as const) {
    const w = await world({ twice: mode === 'wrong-query' }); await assert.rejects(w.run(mode), refuses);
    assert.equal(await w.store.load(RUN, asId('created-run')), null); assert.deepEqual(await w.store.historyFor(RUN, asId('created-run')), []);
    assert.deepEqual(await w.store.load(BRANCH, w.branch.id), w.branch);
  }
});

test('late current source/ancestor/related Identity/physical loss rolls back selected message effects', async () => {
  for (const mode of ['source', 'ancestor', 'identity', 'bytes'] as const) {
    const w = await world(); await assert.rejects(w.run(undefined, async () => {
      if (mode === 'source') w.access.data = false;
      if (mode === 'ancestor') w.access.ancestor = false;
      if (mode === 'identity') await w.memberships.removeMembership(w.related.membership.membership_id);
      if (mode === 'bytes') w.blobs.remove(blobKeyForFile(w.refs[0]));
    }), refuses);
    assert.equal(await w.store.load(RUN, asId('created-run')), null); assert.deepEqual(await w.store.historyFor(RUN, asId('created-run')), []);
    assert.deepEqual(await w.store.outboxPending(), []);
  }
});

test('saved selected message authority/current lifetime/Files loss masks original result without query or body replay', async () => {
  for (const mode of ['source', 'ancestor', 'identity', 'bytes', 'lifetime'] as const) {
    const w = await world(); assert.equal((await w.run()).status, 'committed');
    if (mode === 'source') w.access.data = false;
    if (mode === 'ancestor') w.access.ancestor = false;
    if (mode === 'identity') await w.memberships.removeMembership(w.related.membership.membership_id);
    if (mode === 'bytes') w.blobs.remove(blobKeyForFile(w.refs[0]));
    if (mode === 'lifetime') { const row = await w.store.load(TURN, asId('first')); assert.ok(row); await updateRow(w.store, TURN, row, { created: row.created + 1 }); }
    const before = { revision: await w.store.readRevision(), history: await w.store.historyFor(RUN, asId('created-run')) };
    assert.deepEqual(await projectScenarioReceipt({ ...w, receipt: w.receipt() }), { result: null, records: [] });
    assert.deepEqual({ revision: await w.store.readRevision(), history: await w.store.historyFor(RUN, asId('created-run')) }, before);
    assert.equal(w.executions(), 1); assert.equal(w.predicates(), 3);
  }
});

test('later valid message data preserves original selected snapshots and effect-free replay', async () => {
  const w = await world(); assert.equal((await w.run()).status, 'committed'); const receipt = w.receipt();
  const first = await w.store.load(TURN, asId('first')); assert.ok(first);
  await updateRow(w.store, TURN, first, { data: { ...first.data, content: 'Later', attachments: [] } });
  const saved = readScenarioReceiptAssociation(receipt)!.observations.find(observation => observation.dependencyId === 'q-content' && observation.row.id === first.id)!;
  assert.equal(saved.row.data.content, 'First');
  const projected = await projectScenarioReceipt({ ...w, receipt }); assert.deepEqual(projected.result, { id: 'created-run' });
  const before = { revision: await w.store.readRevision(), row: await w.store.load(RUN, asId('created-run')), history: await w.store.historyFor(RUN, asId('created-run')) };
  assert.equal((await invokeRetainedReceiptOnly({ ...w, execute: async () => { throw new Error('Replay body ran'); } })).status, 'replayed');
  assert.deepEqual({ revision: await w.store.readRevision(), row: await w.store.load(RUN, asId('created-run')), history: await w.store.historyFor(RUN, asId('created-run')) }, before);
  assert.equal(w.executions(), 1); assert.equal(w.predicates(), 3);
});

test('late unrelated business refusal leaves selected snapshots, new Run and history uncommitted', async () => {
  const w = await world(); await assert.rejects(w.run(undefined, () => { throw new StateError('rule_failed', 'Original late requirement failed'); }), refuses);
  assert.equal(await w.store.load(RUN, asId('created-run')), null); assert.deepEqual(await w.store.historyFor(RUN, asId('created-run')), []);
  for (const row of w.turns) assert.deepEqual(await w.store.load(TURN, row.id), row);
});

test('genuine saved selected named roles remain original strings under the owning enum declaration', async () => {
  const w = await world(); assert.equal((await w.run()).status, 'committed');
  const receipt = w.receipt(), association = readScenarioReceiptAssociation(receipt)!;
  assert.deepEqual(association.observations.filter(observation => observation.dependencyId === 'q-role').map(observation => observation.row.data.role), ['user', 'assistant']);
  const before = await w.store.readRevision();
  assert.deepEqual((await projectScenarioReceipt({ ...w, receipt })).result, { id: 'created-run' });
  assert.equal(await w.store.readRevision(), before); assert.equal(w.predicates(), 3); assert.equal(w.executions(), 1);
});

test('saved selected role strings cannot become model/contract authority or omit their complete DATA association', async () => {
  for (const mode of ['model', 'contract', 'missing-data', 'out-of-set'] as const) {
    const w = await world(); assert.equal((await w.run()).status, 'committed');
    const receipt = w.receipt(); assert.ok(receipt.outcome.status === 'committed');
    const association = readScenarioReceiptAssociation(receipt)!;
    const type = mode === 'model' ? BRANCH as CanTypeId : 'std.TextMessage' as CanTypeId;
    const altered = mode === 'out-of-set' ? { ...association,
      observations: association.observations.map(observation => ({ ...observation,
        row: { ...observation.row, data: { ...observation.row.data, role: 'tool' } } })),
      queries: association.queries!.map(query => ({ ...query, candidates: query.candidates.map(candidate => ({ ...candidate,
        row: { ...candidate.row, data: { ...candidate.row.data, role: 'tool' } },
        record: { ...candidate.record, data: { ...candidate.record.data, role: 'tool' } },
      })) })),
    } : mode === 'missing-data' ? { ...association,
      observations: association.observations.filter(observation => observation.dependencyId !== 'q-role'),
      queries: association.queries!.map(query => ({ ...query, candidates: query.candidates.map(candidate => ({ ...candidate,
        dependencies: candidate.dependencies.filter(id => id !== 'data-role' && id !== 'q-role'),
      })) })),
    } : { ...association, plan: { ...association.plan,
      queries: association.plan.queries!.map(query => ({ ...query, dependencies: query.dependencies.map(dependency =>
        dependency.field === 'role' ? { ...dependency, type } : dependency) })),
      returns: association.plan.returns.map(returned => ({ ...returned, dependencies: returned.dependencies.map(dependency =>
        dependency.field === 'role' ? { ...dependency, type } : dependency) })),
    } };
    const changed: Receipt = { ...receipt, outcome: { ...receipt.outcome, scenario: altered } };
    // Incoming transport corruption is a negative input, never an authority issuer.
    assert.throws(() => readScenarioReceiptAssociation(changed), refuses);
    await assert.rejects(projectScenarioReceipt({ ...w, receipt: changed }), refuses);
    assert.equal(w.executions(), 1); assert.equal(w.predicates(), 3);
  }
});

test('selected owning enum validation and first/count recipe bypasses refuse before any commit', async () => {
  for (const mode of ['role-set', 'first-bypass', 'count-bypass'] as const) {
    const w = await world(); await assert.rejects(w.run(mode), refuses);
    assert.equal(await w.store.load(RUN, asId('created-run')), null);
    assert.deepEqual(await w.store.historyFor(RUN, asId('created-run')), []);
  }
  const w = await world(), finalSlice = structuredClone(w.slice);
  finalSlice.valueTypes = { ...finalSlice.valueTypes!, contracts: [...finalSlice.valueTypes!.contracts,
    { name: 'FinalSelectedFact', fields: [{ name: 'turn', type: TURN }, { name: 'version', type: 'int' as CanTypeId },
      { name: 'attachments', type: 'file[]' as CanTypeId }] }] };
  const original = finalSlice.operations![0]!.result!;
  finalSlice.operations![0]!.result = { type: 'FinalSelectedFact[]' as CanTypeId, disclosure: {
    ...original.disclosure!, returns: original.disclosure!.returns.map(returned => ({ ...returned,
      projection: { kind: 'query-contract-array' as const, queryId: 'messages', source, fields: [
        { name: 'turn', kind: 'reference' as const }, { name: 'version', kind: 'version' as const },
        { name: 'attachments', kind: 'field' as const, field: 'attachments' },
      ] },
    })),
  } };
  assert.throws(() => loadArtifactDescriptors(finalSlice, { by: 'members' }), /protected query File DATA requires its owning intermediate/);
});

test('dense selected rows reject accessors without evaluation and caught wrong call/store poisons its authentic owner', async () => {
  for (const mode of ['rows-accessor', 'wrong-call-caught', 'wrong-store-caught'] as const) {
    const w = await world(); await assert.rejects(w.run(mode), refuses); assert.equal(w.accessors(), 0);
    assert.equal(await w.store.load(RUN, asId('created-run')), null);
    assert.deepEqual(await w.store.historyFor(RUN, asId('created-run')), []);
  }
});

test('selected empty array never escapes State movement during the final genuine SDK snapshot await', { timeout: 10_000 }, async () => {
  const w = await world({ domain: 'empty', stopAfterFirstAttempt: true });
  const sdkSnapshot = w.memberships.findMembershipsSnapshot!.bind(w.memberships);
  let snapshots = 0, held!: () => void, release!: () => void;
  const snapshotHeld = new Promise<void>(resolve => { held = resolve; });
  const snapshotRelease = new Promise<void>(resolve => { release = resolve; });
  w.memberships.findMembershipsSnapshot = async (team, users) => {
    const actual = await sdkSnapshot(team, users);
    if (w.bindingActive()) {
      snapshots++;
      if (snapshots === 2) { held(); await snapshotRelease; }
    }
    return actual;
  };
  const pending = w.run();
  // Attach the rejection observer before releasing the held authority read.
  const rejected = pending.then(result => assert.fail(`Unexpected ${result.status}: executions=${w.executions()}, exposures=${w.selectionExposures()}, error=${String(w.firstBindingError())}`),
    error => assert.ok(error instanceof StateError && error.code === 'rule_failed' && error.message === 'Test stops after first selected-message attempt'));
  try {
    await snapshotHeld;
    assert.equal(snapshots, 2); assert.equal(w.bindingActive(), true); assert.equal(w.selectionExposures(), 0);
    const unrelated = await w.store.load(TURN, asId('excluded')); assert.ok(unrelated);
    assert.notEqual(unrelated.parent?.id, w.branch.id);
    const revision = await w.store.readRevision();
    await updateRow(w.store, TURN, unrelated, { data: { ...unrelated.data, content: 'Unrelated State movement' } });
    assert.ok(await w.store.readRevision() > revision);
    release(); await rejected;
    assert.equal(w.selectionExposures(), 0, 'the protected array must not return before outer commit refusal');
    const firstError = w.firstBindingError(); assert.ok(firstError instanceof StateError);
    assert.equal(firstError.code, 'conflict');
    assert.equal(firstError.message, 'Selected message final authority moved beyond its checkpoint.');
    assert.equal(snapshots, 2);
    assert.equal(await w.store.load(RUN, asId('created-run')), null);
    assert.deepEqual(await w.store.historyFor(RUN, asId('created-run')), []);
    assert.deepEqual(await w.store.outboxPending(), []);
  } finally { release(); }
});
