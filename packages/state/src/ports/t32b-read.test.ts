/**
 * T32b bound read-port fence tests (colocated): the port threads the
 * operation's enrollment scope through to the engine, serves display-only
 * eventual reads through the marked wrapper, and accepts no fence on the
 * eventual path. Memory store + local membership double.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openFenceScope, requireAuthorizingRead } from '../invocation/admission.js';
import { createReadPort } from './read.js';
import { buildPolicyTable } from '../policy/grants.js';
import { createMemoryStorage } from '../storage/memory.js';
import {
  asModel,
  captureStateError,
  createMemoryIdentityStore,
  seedMember,
  seedRow,
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
  const port = createReadPort({ policy, store, memberships });
  return { store, memberships, policy, alice, port };
}

describe('T32b bound read port fence', () => {
  it('threads the enrollment scope through fenced reads', async () => {
    const { store, alice, port } = await setup();
    const scope = openFenceScope(await store.readRevision(), alice.team.team_id);
    const out = await port.queryRecords({
      authority: 'viewer',
      model: MODEL,
      context: { actorUserId: alice.user.user_id, teamId: alice.team.team_id },
      fence: scope,
    });
    assert.equal(out.records.length, 1);
    assert.deepEqual(scope.snapshot().dependencies, [
      { kind: 'query', model: MODEL, authority: 'viewer' },
      { kind: 'membership', teamId: alice.team.team_id, userId: alice.user.user_id },
    ]);
  });

  it('serves eventual reads marked, unenrolled, and unusable for authorization', async () => {
    const { alice, port } = await setup();
    const out = await port.queryEventualRecords({
      authority: 'viewer',
      model: MODEL,
      context: { actorUserId: alice.user.user_id, teamId: alice.team.team_id },
    });
    assert.equal(out.eventual, true);
    assert.ok('records' in out.result, 'viewer eventual serves records');
    assert.equal(out.result.records.length, 1);
    assert.throws(() => requireAuthorizingRead(out, 'test spend'), /eventual/);
  });

  it('refuses a fence on the eventual path', async () => {
    const { store, alice, port } = await setup();
    const scope = openFenceScope(await store.readRevision(), alice.team.team_id);
    const error = await captureStateError(
      port.queryEventualRecords({
        authority: 'viewer',
        model: MODEL,
        context: { actorUserId: alice.user.user_id, teamId: alice.team.team_id },
        fence: scope,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /cannot enroll in a fence/);
  });
});
