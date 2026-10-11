/** Saved generated CRUD source-policy refusal/race controls; no native app claim. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelName, Receipt, StoredRow } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { StateError } from '../../src/errors.js';
import { FenceConflictError } from '../../src/storage/port.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { invoke, projectGeneratedCrudReceipt } from '../../src/invocation/invoke.js';
import { generatedCrudExecute } from '../../src/mutation/crud.js';
import { buildModelTableFromCanonical } from '../../src/mutation/models.js';
import { buildPolicyTable } from '../../src/policy/grants.js';
import { projectCurrentRecordForViewerSourcePolicies, type ViewerGenerationCallbackSourceReadPolicy,
  type ViewerSourceReadPolicy } from '../../src/query/source-policy.js';
import { asId, asModel, FIXED_NOW, makeEnvelope, makeIdentity, seedRow, updateRow, uuidv7 } from './fixtures.js';

const MODEL = asModel('CrudSourceRace.Budget'), PARENT = asModel('CrudSourceRace.Workspace');
const APP = 'crud-source-race', TEAM = 'crud-source-race-team';
let sequence = 102_000;
type Read = ViewerGenerationCallbackSourceReadPolicy['grants'][number]['read'];

async function world() {
  const slice: ArtifactDescriptorSlice = { artifact_version: 1, models: [
    { name: PARENT, deleteMode: 'archive', fields: [{ name: 'title', field: { kind: 'string' }, required: true, serverOnly: false }] },
    { name: MODEL, parent: PARENT, deleteMode: 'archive', fields: [
      { name: 'account', field: { kind: 'user' }, required: true, serverOnly: false },
      { name: 'title', field: { kind: 'string' }, required: true, serverOnly: false },
      { name: 'secret', field: { kind: 'secret' }, required: false, serverOnly: true,
        default: { kind: 'server', init: 'random_secret' } },
    ] },
  ], operations: [{ name: `${MODEL}.create`, kind: 'create', description: '', inputs: { fields: [
    { name: 'parent', field: { kind: 'ref', model: PARENT, requireVersion: true }, required: true },
    { name: 'account', field: { kind: 'user' }, required: true },
    { name: 'title', field: { kind: 'string' }, required: true },
  ] } }] };
  const loaded = loadArtifactDescriptors(slice, { by: 'members' });
  const store = createMemoryStorage(), identityClock = createFrozenClock(FIXED_NOW);
  const memberships = createMemoryIdentityStore({ clock: identityClock });
  const caller = await memberships.createMembership({ team_id: TEAM, user_id: 'caller', is_owner: false, roles: [] });
  const related = await memberships.createMembership({ team_id: TEAM, user_id: 'related', is_owner: false, roles: [] });
  const workspace = await seedRow(store, PARENT, { id: 'workspace', data: { title: 'Workspace' } });
  await seedRow(store, PARENT, { id: 'other-workspace', data: { title: 'Other' } });
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, containment: loaded.containment,
    serverInits: loaded.serverInits, nullableFields: loaded.nullableFields });
  const policy = buildPolicyTable([{ model: PARENT, secretFields: [], grants: [{ by: 'members', fields: ['title'] }] }], loaded.models);
  let receipt: Receipt | undefined;
  const common = { store, memberships, registry: loaded.registry, policy, app: APP, identity: makeIdentity({ membership: caller }) };
  const result = await invoke({ ...common, source: 'component', clock: { nowMs: () => FIXED_NOW },
    envelope: makeEnvelope(`${MODEL}.create`, uuidv7(FIXED_NOW, ++sequence), {
      parent: { id: workspace.id, version: String(workspace.version) }, account: { id: caller.user_id }, title: 'Saved',
    }), execute: generatedCrudExecute({ table, store,
      secretFields: new Map([...loaded.secretFields].map(([model, fields]) => [model, [...fields]])) }),
    observeCommittedReceipt: value => { receipt = value; },
  });
  assert.equal(result.status, 'committed'); assert.ok(receipt);
  assert.ok(receipt.outcome.status === 'committed');
  const saved = receipt.outcome.result as StoredRow; assert.ok(saved.id); assert.ok(saved.data.secret);
  assert.deepEqual(saved.data.account, { id: caller.user_id });
  const parentRead: ViewerGenerationCallbackSourceReadPolicy = { fields: ['title'], secretFields: [], grants: [
    { fields: ['id', 'title'], read: async ({ context }) => context.membership?.status === 'active' },
  ] };
  const current: ViewerGenerationCallbackSourceReadPolicy = { parent: PARENT, fields: ['account', 'title', 'secret'], secretFields: ['secret'], grants: [
    { fields: ['id', 'account', 'title'], read: async ({ context, row }) => context.membership?.status === 'active' &&
      row.data.account !== null && typeof row.data.account === 'object' &&
      (row.data.account as { id?: unknown }).id === context.actorUserId },
  ] };
  const sourceReadPolicies = new Map<ModelName, ViewerSourceReadPolicy>([[MODEL, current], [PARENT, parentRead]]);
  return { ...common, receipt, saved, caller, related, workspace, current, parentRead, sourceReadPolicies, identityClock };
}
type World = Awaited<ReturnType<typeof world>>;
function replaceRead(w: World, read: Read, fields = ['id', 'account', 'title']) {
  w.sourceReadPolicies.set(MODEL, { ...w.current, grants: [{ fields, read }] });
}
async function withheld(operation: () => ReturnType<typeof projectGeneratedCrudReceipt>) {
  try { assert.deepEqual(await operation(), { result: null, records: [] }); }
  catch (error) {
    if (error instanceof StateError || error instanceof FenceConflictError) return;
    throw error;
  }
}

test('source CRUD projection refuses State and full related Identity races after genuine borrowed parent navigation', async () => {
  for (const mode of ['state', 'caller-revoked', 'related-revoked', 'related-restored', 'related-role'] as const) {
    const w = await world(); let changed = false, navigation = 0;
    replaceRead(w, async observation => {
      assert.ok(observation.row.parent);
      const parent = await projectCurrentRecordForViewerSourcePolicies({ model: PARENT, id: observation.row.parent.id,
        store: w.store, policy: w.policy, readPolicies: w.sourceReadPolicies, observation,
        context: { actorUserId: observation.context.actorUserId, teamId: observation.context.teamId },
        memberships: observation.context.memberships,
        ...(observation.fence === undefined ? {} : { fence: observation.fence }),
      });
      navigation++; assert.ok(parent.record); assert.equal(parent.record.data.title, 'Workspace');
      assert.equal(parent.revision, observation.revision);
      const related = await observation.context.memberships.findMembership(TEAM, w.related.user_id);
      if (!changed) assert.equal(related?.status, 'active');
      if (!changed) {
        changed = true;
        if (mode === 'state') {
          const row = await w.store.load(MODEL, w.saved.id); assert.ok(row);
          await updateRow(w.store, MODEL, row, { data: { ...row.data, title: 'Changed during read' } });
        } else if (mode === 'caller-revoked') await w.memberships.removeMembership(w.caller.membership_id);
        else if (mode === 'related-role') await w.memberships.setMembershipRoles(w.related.membership_id, [{
          role: 'CrudSourceRace.reader', granted_at: new Date(FIXED_NOW).toISOString(), granted_by: w.caller.user_id,
        }]);
        else {
          await w.memberships.removeMembership(w.related.membership_id);
          if (mode === 'related-restored') {
            w.identityClock.advance(1);
            await w.memberships.reactivateMembership(w.related.membership_id, {
              is_owner: w.related.is_owner, roles: w.related.roles,
            });
          }
        }
      }
      return true;
    });
    await withheld(() => projectGeneratedCrudReceipt(w));
    assert.equal(changed, true); assert.ok(navigation >= 1);
  }
});

test('source CRUD projection withholds current lifetime, containment and archive mismatches', async () => {
  for (const mode of ['created', 'createdBy', 'parent', 'archive'] as const) {
    const w = await world(), current = await w.store.load(MODEL, w.saved.id); assert.ok(current);
    await updateRow(w.store, MODEL, current, mode === 'created' ? { created: current.created + 1 }
      : mode === 'createdBy' ? { createdBy: 'other-generation' }
      : mode === 'parent' ? { parent: { model: PARENT, id: asId('other-workspace') } } : { archivedAt: FIXED_NOW });
    await withheld(() => projectGeneratedCrudReceipt(w));
  }
});

test('source CRUD projection freezes map and grant field selectors before awaited callbacks can widen them', async () => {
  const w = await world(), fields = ['id', 'account']; let callbacks = 0;
  const policy: ViewerGenerationCallbackSourceReadPolicy = { ...w.current, grants: [{ fields, read: async () => {
    callbacks++; await Promise.resolve(); fields.push('title', 'secret');
    w.sourceReadPolicies.set(MODEL, { ...w.current, secretFields: [], grants: [{ fields: ['id', 'account', 'title', 'secret'], read: async () => true }] });
    return true;
  } }] };
  w.sourceReadPolicies.set(MODEL, policy);
  const before = { revision: await w.store.readRevision(), row: await w.store.load(MODEL, w.saved.id),
    history: await w.store.historyFor(MODEL, w.saved.id) };
  const projected = await projectGeneratedCrudReceipt(w);
  assert.equal(projected.records.length, 1); assert.ok(callbacks > 0);
  assert.deepEqual(projected.records[0]!.data, { account: { id: w.caller.user_id } });
  assert.deepEqual({ revision: await w.store.readRevision(), row: await w.store.load(MODEL, w.saved.id),
    history: await w.store.historyFor(MODEL, w.saved.id) }, before);
});

test('source CRUD projection refuses missing ancestors, cyclic source policies and invalid field closure', async () => {
  for (const mode of ['missing', 'cycle', 'field'] as const) {
    const w = await world();
    if (mode === 'missing') w.sourceReadPolicies.delete(PARENT);
    else if (mode === 'cycle') w.sourceReadPolicies.set(PARENT, { ...w.parentRead, parent: MODEL });
    else w.sourceReadPolicies.set(MODEL, { ...w.current, grants: [{ fields: ['undeclared'], read: async () => true }] });
    await withheld(() => projectGeneratedCrudReceipt(w));
  }
});
