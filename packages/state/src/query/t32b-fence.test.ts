/**
 * T32b query-engine fence tests (colocated): authorized reads join the
 * operation's owner checkpoint (enrolling membership + model reads),
 * conflict when the checkpoint already moved, and serve display-only
 * eventual reads through a marked wrapper that can never authorize.
 * Memory store + local membership double.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isEventualRead,
  openFenceScope,
  requireAuthorizingRead,
} from '../invocation/admission.js';
import { queryAggregate, queryEventualRecords, queryRecords } from './engine.js';
import { buildPolicyTable } from '../policy/grants.js';
import { createMemoryStorage } from '../storage/memory.js';
import {
  asId,
  asModel,
  asRevision,
  captureStateError,
  createMemoryIdentityStore,
  seedMember,
  seedRow,
  updateRow,
} from '../../test/invocation/fixtures.js';

const MODEL = asModel('Acme.Gadget');

async function setup() {
  const store = createMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const policy = buildPolicyTable([
    { model: MODEL, secretFields: [], grants: [{ by: 'members', fields: ['title'] }] },
  ]);
  await seedRow(store, MODEL, { id: 'rec-1', data: { title: 't' } });
  return { store, memberships, policy, alice };
}

describe('T32b fenced queries', () => {
  it('viewer query joins the checkpoint and enrolls membership + model reads', async () => {
    const { store, memberships, policy, alice } = await setup();
    const revision = await store.readRevision();
    const scope = openFenceScope(revision, alice.team.team_id);
    const result = await queryRecords({
      policy,
      model: MODEL,
      authority: 'viewer',
      context: { actorUserId: alice.user.user_id, teamId: alice.team.team_id },
      memberships,
      store,
      fence: scope,
    });
    assert.equal(result.revision, revision);
    assert.equal(result.records.length, 1);
    assert.deepEqual(scope.snapshot().dependencies, [
      { kind: 'query', model: MODEL, authority: 'viewer' },
      { kind: 'membership', teamId: alice.team.team_id, userId: alice.user.user_id },
    ]);
  });

  it('owner query enrolls the model read without a membership check', async () => {
    const { store, memberships, policy, alice } = await setup();
    const revision = await store.readRevision();
    const scope = openFenceScope(revision, alice.team.team_id);
    const result = await queryRecords({
      policy,
      model: MODEL,
      authority: 'owner',
      context: { actorUserId: null, teamId: alice.team.team_id },
      memberships,
      store,
      fence: scope,
    });
    assert.equal(result.rows.length, 1);
    assert.deepEqual(scope.snapshot().dependencies, [
      { kind: 'query', model: MODEL, authority: 'owner' },
    ]);
  });

  it('conflicts when the checkpoint moved before the read', async () => {
    const { store, memberships, policy, alice } = await setup();
    const scope = openFenceScope(await store.readRevision(), alice.team.team_id);
    const row = await store.load(MODEL, asId('rec-1'));
    assert.ok(row);
    await updateRow(store, MODEL, row);
    const error = await captureStateError(
      queryRecords({
        policy,
        model: MODEL,
        authority: 'viewer',
        context: { actorUserId: alice.user.user_id, teamId: alice.team.team_id },
        memberships,
        store,
        fence: scope,
      }),
    );
    assert.equal(error.code, 'conflict');
    assert.match(error.message, /moved before this read/);
    assert.deepEqual(scope.snapshot().dependencies, []);
  });

  it('fenced aggregates enroll like fenced record reads', async () => {
    const { store, memberships, policy, alice } = await setup();
    const revision = await store.readRevision();
    const scope = openFenceScope(revision, alice.team.team_id);
    const result = await queryAggregate({
      policy,
      model: MODEL,
      authority: 'viewer',
      context: { actorUserId: alice.user.user_id, teamId: alice.team.team_id },
      memberships,
      store,
      spec: { op: 'count' },
      fence: scope,
    });
    assert.deepEqual(result.result, { op: 'count', value: 1 });
    assert.ok(
      scope.snapshot().dependencies.some((dep) => dep.kind === 'query' && dep.model === MODEL),
    );
  });

  it('unfenced queries still report the fence revision (database-wide assertion covers them)', async () => {
    const { store, memberships, policy, alice } = await setup();
    const result = await queryRecords({
      policy,
      model: MODEL,
      authority: 'viewer',
      context: { actorUserId: alice.user.user_id, teamId: alice.team.team_id },
      memberships,
      store,
    });
    assert.equal(result.revision, await store.readRevision());
  });
});

describe('T32b display-only eventual reads', () => {
  it('serves the same authorized pipeline with no enrollment', async () => {
    const { store, memberships, policy, alice } = await setup();
    const result = await queryEventualRecords({
      policy,
      model: MODEL,
      authority: 'viewer',
      context: { actorUserId: alice.user.user_id, teamId: alice.team.team_id },
      memberships,
      store,
    });
    assert.equal(result.eventual, true);
    assert.equal(result.result.revision, await store.readRevision());
    assert.equal(result.result.records.length, 1);
    assert.deepEqual(result.result.records[0]?.data, { title: 't' });
    assert.equal(isEventualRead(result), true);
    assert.equal(isEventualRead(result.result), false);
  });

  it('eventual reads refuse fence enrollment (display-only, never authorizing)', async () => {
    const { store, memberships, policy, alice } = await setup();
    const scope = openFenceScope(asRevision(1), alice.team.team_id);
    const error = await captureStateError(
      queryEventualRecords({
        policy,
        model: MODEL,
        authority: 'viewer',
        context: { actorUserId: alice.user.user_id, teamId: alice.team.team_id },
        memberships,
        store,
        fence: scope,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /cannot enroll in a fence/);
  });

  it('the eventual wrapper can never feed authorization', async () => {
    const { store, memberships, policy, alice } = await setup();
    const eventual = await queryEventualRecords({
      policy,
      model: MODEL,
      authority: 'viewer',
      context: { actorUserId: alice.user.user_id, teamId: alice.team.team_id },
      memberships,
      store,
    });
    assert.throws(() => requireAuthorizingRead(eventual, 'test spend'), /eventual/);
  });
});
