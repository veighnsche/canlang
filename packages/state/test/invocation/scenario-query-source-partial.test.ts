/** Defining source-aware owner query control; handbound source, no native/app claim. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, ClosedInputs, ModelName, Receipt, StoredRow } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { buildModelTableFromCanonical } from '../../src/mutation/models.js';
import { buildPolicyTable } from '../../src/policy/grants.js';
import type { ViewerSourceReadPolicy } from '../../src/query/source-policy.js';
import { invoke } from '../../src/invocation/invoke.js';
import type { AdmittedCall } from '../../src/invocation/admission.js';
import { loadArtifactDescriptors, isGeneratedOperationDef, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { beginScenarioReceiptMutation, bindScenarioReceiptCallProducer, invokeScenarioReceiptCall,
  bindScenarioReceiptQueryProducer, executeScenarioReceiptQuery,
  observeScenarioReceiptQueryDependency, bindScenarioReceiptQueryResult, selectScenarioReceiptReturn,
  readScenarioReceiptAssociation, projectScenarioReceipt } from '../../src/invocation/scenario-receipt.js';
import { asId, asModel, FIXED_NOW, makeBatch, makeEnvelope, makeIdentity, makeRow, uuidv7 } from './fixtures.js';

test('source-aware unscoped child contract query retains false control-only rows and masks revoked selected data without replay', async () => {
  const ANCESTOR = asModel('PartialQuery.Workspace'), PARENT = asModel('PartialQuery.Branch'), TURN = asModel('PartialQuery.Turn');
  const ROOT = 'PartialQuery.review', CHILD = 'PartialQuery.facts', TEAM = 'partial-query-team', APP = 'partial-query-app';
  const source = { path: 'partial-query.can', sha256: 'e'.repeat(64), module: 'partial-query.mjs' };
  const slice: ArtifactDescriptorSlice = {
    artifact_version: 1, sources: [{ path: source.path, sha256: source.sha256 }],
    modules: [{ path: source.module, js: 'export const identity="PartialQuery.review";', map: {
      version: 3, file: source.module, sources: [source.path], sourcesContent: [null], names: [], mappings: '',
    } }],
    callables: [ROOT, CHILD].map(id => ({ id, kind: 'operation', module: source.module, export: 'identity', member: [id.split('.').at(-1)!] })),
    valueTypes: { contracts: [{ name: 'PartialFact', fields: [
      { name: 'turn', type: TURN as CanTypeId }, { name: 'version', type: 'int' as CanTypeId },
      { name: 'held', type: 'text' as CanTypeId },
    ] }] },
    models: [
      { name: ANCESTOR, deleteMode: 'remove', fields: [{ name: 'title', field: { kind: 'string' }, required: true, serverOnly: false }] },
      { name: PARENT, parent: ANCESTOR, deleteMode: 'remove', fields: [{ name: 'title', field: { kind: 'string' }, required: true, serverOnly: false }] },
      { name: TURN, parent: PARENT, deleteMode: 'remove', fields: ['account', 'held'].map(name => ({
        name, field: { kind: 'string' }, required: true, serverOnly: false,
      })) },
    ],
    operations: [
      { name: ROOT, kind: 'scenario', description: '', inputs: { fields: [] }, result: { type: 'text' as CanTypeId,
        disclosure: { version: 1, source, returns: [{ id: 'root-return', source, dependencies: [], influences: [] }] } } },
      { name: CHILD, kind: 'read', description: '', inputs: { fields: [] }, result: { type: 'PartialFact[]' as CanTypeId,
        disclosure: { version: 1, source, queries: [{ id: 'turns', source, model: TURN,
          order: [{ field: 'id', direction: 'asc' }], limit: null, archived: 'exclude', dependencies: [
            { id: 'account-control', source, role: 'control', field: 'account', type: 'text' as CanTypeId },
            { id: 'held-data', source, role: 'data', field: 'held', type: 'text' as CanTypeId },
          ] }], returns: [{ id: 'facts-return', source, dependencies: [],
          influences: (['query-existence', 'query-cardinality', 'query-membership', 'query-order'] as const)
            .map(kind => ({ id: kind, kind, queryId: 'turns' })),
          projection: { kind: 'query-contract-array', queryId: 'turns', source, fields: [
            { name: 'turn', kind: 'reference' }, { name: 'version', kind: 'version' }, { name: 'held', kind: 'field', field: 'held' },
          ] },
        }] } } },
    ],
  };
  const loaded = loadArtifactDescriptors(slice, { by: 'members' });
  const root = loaded.registry.get(ROOT), child = loaded.registry.get(CHILD);
  assert.ok(root && isGeneratedOperationDef(root)); assert.ok(child && isGeneratedOperationDef(child));
  assert.equal(child.descriptor.result?.disclosure?.queries?.[0]?.parent, undefined);
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, containment: loaded.containment });
  const store = createMemoryStorage(), memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const caller = await memberships.createMembership({ team_id: TEAM, user_id: 'caller', is_owner: false, roles: [] });
  await memberships.createMembership({ team_id: TEAM, user_id: 'source-reader', is_owner: false, roles: [] });
  const insert = async (model: ModelName, row: StoredRow) => {
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model, row }] }));
  };
  await insert(ANCESTOR, makeRow({ id: 'workspace', data: { title: 'Workspace' } }));
  for (const id of ['branch-a', 'branch-b']) await insert(PARENT, { ...makeRow({ id, data: { title: id } }),
    parent: { model: ANCESTOR, id: asId('workspace') } });
  await insert(TURN, { ...makeRow({ id: 'turn-a', data: { account: 'caller', held: '7' } }), parent: { model: PARENT, id: asId('branch-a') } });
  await insert(TURN, { ...makeRow({ id: 'turn-b', data: { account: 'other', held: '100' } }), parent: { model: PARENT, id: asId('branch-b') } });
  // Static grants intentionally omit the queried model; source policies own its authority.
  const policy = buildPolicyTable([ANCESTOR, PARENT].map(model => ({ model, secretFields: [], grants: [{ by: 'members', fields: ['title'] }] })), loaded.models);
  assert.equal(policy.has(TURN), false);
  let heldVisible = true, executions = 0, predicates = 0;
  const readPolicies = new Map<ModelName, ViewerSourceReadPolicy>();
  for (const model of [ANCESTOR, PARENT]) readPolicies.set(model, {
    ...(model === PARENT ? { parent: ANCESTOR } : {}), fields: ['title'], secretFields: [],
    grants: [{ fields: ['id', 'title'], read: async ({ context }) => context.membership?.status === 'active' &&
      (await context.memberships.findMembership(TEAM, 'source-reader'))?.status === 'active' }],
  });
  readPolicies.set(TURN, { parent: PARENT, fields: ['account', 'held'], secretFields: [], grants: [
    { fields: ['id', 'account'], read: async ({ context }) => context.membership?.status === 'active' &&
      (await context.memberships.findMembership(TEAM, 'source-reader'))?.status === 'active' },
    { fields: ['held'], read: async ({ row }) => heldVisible && row.id === 'turn-a' },
  ] });
  bindScenarioReceiptQueryProducer(child, { source, app: APP, policy, readPolicies });
  const expected = [{ turn: { id: 'turn-a', version: '1' }, version: '1', held: '7' }];
  bindScenarioReceiptCallProducer(root, { source, app: APP, registry: loaded.registry,
    sites: [{ id: 'facts-site', source, kind: 'operation', targets: [{ operation: CHILD, interface: child.descriptor }], resultType: 'PartialFact[]' as CanTypeId }],
    prepare: (_def, inputs) => inputs as ClosedInputs, execute: async frame => {
      executions++;
      const query = await executeScenarioReceiptQuery(frame.call, store, { queryId: 'turns', predicate: ({ slot, record }) => {
        predicates++; const account = record.data.account;
        observeScenarioReceiptQueryDependency(frame.call, store, { slot, dependencyId: 'account-control' });
        return account === 'caller';
      } });
      assert.deepEqual(query.rows.map(entry => entry.record.id), ['turn-a']);
      const wire = query.rows.map(({ record }) => ({ turn: { id: record.id, version: String(record.version) },
        version: String(record.version), held: record.data.held }));
      bindScenarioReceiptQueryResult(frame.call, store, { query: query.query, returnId: 'facts-return', wire, rows: query.rows.map(entry => entry.slot) });
      selectScenarioReceiptReturn(frame.call, store, 'facts-return'); return wire;
    },
  });
  let receipt: Receipt | undefined;
  const request = { store, memberships, policy, readPolicies, registry: loaded.registry, app: APP, source: 'component',
    clock: { nowMs: () => FIXED_NOW }, identity: makeIdentity({ membership: caller }),
    envelope: makeEnvelope(ROOT, uuidv7(FIXED_NOW, 98_001), {}), observeCommittedReceipt: (value: Receipt) => { receipt = value; },
    execute: async (call: AdmittedCall) => {
      const session = await beginScenarioReceiptMutation(call, store, { table, bounds: { maxRows: 10, maxWork: 1000 } });
      const wire = await invokeScenarioReceiptCall(call, store, { site: 'facts-site', target: CHILD, inputs: {} });
      assert.deepEqual(wire, expected); selectScenarioReceiptReturn(call, store, 'root-return');
      const facts = wire as typeof expected;
      return { ...await session.finalize(), result: facts.map(fact => fact.held).join(','), outbox: [] };
    },
  };
  const result = await invoke(request); assert.equal(result.status, 'committed'); assert.equal(result.result, '7'); assert.ok(receipt);
  const savedCall = readScenarioReceiptAssociation(receipt)!.calls![0]!, saved = savedCall.scenario!.queries![0]!;
  assert.deepEqual(savedCall.result, expected); assert.equal(saved.parent, undefined);
  assert.deepEqual(saved.candidates.map(candidate => candidate.row.id), ['turn-a', 'turn-b']);
  assert.deepEqual(saved.selectedIndices.map(index => saved.candidates[index]!.row.id), ['turn-a']);
  const selected = saved.candidates[0]!, rejected = saved.candidates[1]!;
  assert.ok(selected.dependencies.includes('held-data'));
  assert.equal(rejected.matched, false); assert.equal(Object.hasOwn(rejected.record.data, 'held'), false);
  assert.deepEqual(rejected.dependencies, ['account-control']);
  assert.equal((await projectScenarioReceipt({ ...request, receipt })).result, '7');
  heldVisible = false;
  assert.deepEqual(await projectScenarioReceipt({ ...request, receipt }), { result: null, records: [] });
  assert.equal((await invoke(request)).status, 'replayed'); assert.equal(executions, 1); assert.equal(predicates, 2);
  assert.deepEqual(readScenarioReceiptAssociation(receipt)!.calls![0]!.result, expected);
});
