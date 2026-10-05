/**
 * T32b commit-time authority liveness (L6): the live membership row wins
 * unconditionally over checkpoint snapshots and caller claims, and a
 * revocation landing between checkpoint and commit voids the in-flight
 * commit (L291 NARROWER reading). Memory identity store.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Membership } from '@canlang/contracts';
import { IdentityError } from '../ports.js';
import { createFrozenClock, createMemoryIdentityStore } from '../testing.js';
import { assertAuthorityLive, authorityWasRevoked, isAuthorityLive } from './revocation.js';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const NOW_ISO = '2026-10-05T12:00:00.000Z';

async function seedActive() {
  const clock = createFrozenClock(NOW);
  const store = createMemoryIdentityStore({ clock });
  const user = await store.createUser({
    email: 't32b@example.test',
    password_hash: 'not-a-real-hash',
    email_verified: true,
  });
  const team = await store.createTeam({ timezone: 'UTC' });
  const membership = await store.createMembership({
    team_id: team.team_id,
    user_id: user.user_id,
    is_owner: false,
    roles: [{ role: 'members', granted_at: NOW_ISO, granted_by: user.user_id }],
  });
  return { clock, store, user, team, membership };
}

function snapshotOf(membership: Membership): Membership {
  return { ...membership, roles: [...membership.roles] };
}

describe('T32b authority liveness', () => {
  it('passes for a live active membership and returns the live row', async () => {
    const { store, user, team, membership } = await seedActive();
    const live = await assertAuthorityLive(store, { teamId: team.team_id, userId: user.user_id });
    assert.equal(live.membership_id, membership.membership_id);
    assert.equal(live.status, 'active');
    assert.equal(isAuthorityLive(live), true);
    assert.equal(authorityWasRevoked(snapshotOf(membership), live), false);
  });

  it('voids the commit when removal lands after the checkpoint (narrower L291)', async () => {
    const { store, user, team, membership } = await seedActive();
    const checkpoint = snapshotOf(membership);
    assert.equal(authorityWasRevoked(checkpoint, checkpoint), false);
    // Revocation lands between checkpoint and commit.
    await store.removeMembership(membership.membership_id);
    const live = await store.findMembership(team.team_id, user.user_id);
    assert.ok(live, 'removed rows stay readable');
    assert.equal(live.status, 'removed');
    assert.equal(isAuthorityLive(live), false);
    assert.equal(authorityWasRevoked(checkpoint, live), true);
    const error = await assertAuthorityLive(store, {
      teamId: team.team_id,
      userId: user.user_id,
    }).then(
      () => null,
      (failure: unknown) => failure,
    );
    assert.ok(error instanceof IdentityError, `want IdentityError, got ${String(error)}`);
    assert.equal(error.code, 'forbidden');
    assert.match(error.message, /revoked/);
  });

  it('fails closed for a membership that never existed', async () => {
    const { store, team } = await seedActive();
    assert.equal(isAuthorityLive(null), false);
    assert.equal(authorityWasRevoked(null, null), true);
    const error = await assertAuthorityLive(store, {
      teamId: team.team_id,
      userId: 'user-nobody',
    }).then(
      () => null,
      (failure: unknown) => failure,
    );
    assert.ok(error instanceof IdentityError);
    assert.equal(error.code, 'forbidden');
  });

  it('the live row wins unconditionally over the checkpoint snapshot', async () => {
    const { store, user, team, membership } = await seedActive();
    const checkpoint = snapshotOf(membership);
    // Revoked mid-flight: an ACTIVE checkpoint snapshot never saves it.
    await store.removeMembership(membership.membership_id);
    const removed = await store.findMembership(team.team_id, user.user_id);
    assert.equal(authorityWasRevoked(checkpoint, removed), true);
    // And a live active row clears even a removed checkpoint snapshot
    // (re-granted mid-flight): snapshots are never trusted either way.
    assert.equal(
      authorityWasRevoked(removed, { ...checkpoint, status: 'active' }),
      false,
    );
  });
});
