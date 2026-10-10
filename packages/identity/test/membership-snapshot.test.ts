import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_MEMBERSHIP_SNAPSHOT_USERS } from '@canlang/contracts';
import type { Membership } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '../src/testing.js';

const AT = '2026-10-04T15:00:00.000Z';

test('Memory snapshot preserves the same-team observation across later removal and role mutation', async () => {
  const store = createMemoryIdentityStore({ clock: createFrozenClock(Date.parse(AT)) });
  const roles = [{ role: 'Tasks.review', granted_at: AT, granted_by: 'caller' }];
  const caller = await store.createMembership({ team_id: 'team', user_id: 'caller', is_owner: true, roles });
  const subject = await store.createMembership({ team_id: 'team', user_id: 'subject', is_owner: false, roles: [] });
  await store.removeMembership(subject.membership_id);
  await store.createMembership({ team_id: 'other', user_id: 'absent', is_owner: true, roles: [] });
  const requested = ['subject', 'absent', 'caller', 'caller'];
  const pending = store.findMembershipsSnapshot('team', requested);
  requested[0] = 'caller';
  roles[0]!.role = 'Tasks.changed';
  await store.removeMembership(caller.membership_id);
  await store.reactivateMembership(subject.membership_id, { is_owner: true, roles: [] });
  const snapshot = await pending;
  assert.equal(snapshot.team_id, 'team');
  assert.deepEqual(snapshot.entries.map(e => e.user_id), ['subject', 'absent', 'caller', 'caller']);
  assert.equal(snapshot.entries[0]!.membership!.status, 'removed');
  assert.equal(snapshot.entries[0]!.membership!.is_owner, false);
  assert.equal(snapshot.entries[1]!.membership, null);
  assert.equal(snapshot.entries[2]!.membership!.status, 'active');
  assert.equal(snapshot.entries[2]!.membership!.is_owner, true);
  assert.deepEqual(snapshot.entries[2]!.membership!.roles, [
    { role: 'Tasks.review', granted_at: AT, granted_by: 'caller' },
  ]);
  assert.deepEqual(snapshot.entries[2], snapshot.entries[3]);
  assert(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.entries));
  const entry = snapshot.entries[2]!;
  assert(Object.isFrozen(entry) && Object.isFrozen(entry.membership));
  assert(Object.isFrozen(entry.membership!.roles) && Object.isFrozen(entry.membership!.roles[0]));
  assert.throws(() => { (entry.membership!.roles[0] as { role: string }).role = 'Tasks.forged'; }, TypeError);
  // No revision/timestamp token invented; the facts are an earlier point.
  assert.deepEqual(Object.keys(snapshot).sort(), ['entries', 'team_id']);
});

test('Memory bounds requests and refuses holes/accessors without running supplied code', async () => {
  const store = createMemoryIdentityStore();
  let calls = 0;
  const accessor = ['caller'];
  Object.defineProperty(accessor, '0', { get() { calls++; return 'caller'; } });
  for (const users of [[], new Array<string>(1), accessor, [''], Array<string>(100).fill('caller')]) {
    await assert.rejects(store.findMembershipsSnapshot('team', users));
  }
  await assert.rejects(store.findMembershipsSnapshot('', ['caller']));
  assert.equal(calls, 0);
  const full = await store.findMembershipsSnapshot('team', Array<string>(MAX_MEMBERSHIP_SNAPSHOT_USERS).fill('missing'));
  assert.equal(full.entries.length, 99);
  assert(full.entries.every(e => e.membership === null));
});

test('Memory refuses corrupt grants and duplicate membership facts without a partial snapshot', async () => {
  const store = createMemoryIdentityStore();
  let calls = 0;
  const role = { role: 'Tasks.review', granted_at: AT, granted_by: 'caller' };
  Object.defineProperty(role, 'role', { get() { calls++; return 'Tasks.review'; } });
  await store.createMembership({ team_id: 'team', user_id: 'caller', is_owner: false, roles: [role] });
  await assert.rejects(store.findMembershipsSnapshot('team', ['missing', 'caller']));
  assert.equal(calls, 0);
  const duplicate = createMemoryIdentityStore();
  const input = { team_id: 'team', user_id: 'caller', is_owner: false, roles: [] as Membership['roles'] };
  await duplicate.createMembership(input);
  await duplicate.createMembership(input);
  await assert.rejects(duplicate.findMembershipsSnapshot('team', ['caller']), /duplicate membership/);
  for (const key of ['team_id', 'user_id']) {
    const changed = createMemoryIdentityStore();
    const row = await changed.createMembership(input);
    Object.defineProperty(row, key, { get() { calls++; return key === 'team_id' ? 'team' : 'caller'; } });
    await assert.rejects(changed.findMembershipsSnapshot('team', ['caller']));
  }
  assert.equal(calls, 0);
});
