/**
 * D1-backed IdentityStore (MCP deploy packet P-C): full `IdentityStore`
 * conformance over REAL SQL semantics (node:sqlite, same dialect family
 * as D1), plus the production grant/session read paths through the REAL
 * `issueMcpGrant` + `resolveIdentity` constructors.
 *
 * Failing-first: written before `src/storage/d1.ts` existed. The
 * workerd-D1 proof (miniflare) lives in the cloudflare suite
 * (`test/mcpd-env-assembly.test.ts`), which drives this same store
 * through a real D1 binding; this file proves the store's SQL against a
 * real relational engine with zero new dependencies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeMember } from '../src/teams/membership.js';
import { setMemberRole } from '../src/teams/roles.js';
import { recoverAccount } from '../src/accounts/recovery.js';
import { IdentityError } from '../src/ports.js';
import type { IdentityStore } from '../src/ports.js';
import { createFrozenClock } from '../src/testing.js';
import { resolveIdentity } from '../src/authentication/context.js';
import { issueMcpGrant } from '../src/authentication/grants.js';
import { consumePreSessionToken, mintPreSessionToken, PRESESSION_TTL_MS } from '../src/sessions/presession.js';
import { sha256HexText } from '../src/sessions/tokens.js';
import {
  createD1IdentityStore,
  ensureIdentitySchema,
  type IdentityD1Database,
} from '../src/storage/d1.js';

const NOW = Date.parse('2026-10-04T15:00:00.000Z');

test('D1 snapshot is one complete bound SELECT, detached from later equal-clock mutations', async () => {
  const { db, d1, store } = await setup();
  const { user, team, membership } = await setupUserTeam(store);
  const subject = await store.createMembership({ team_id: team.team_id, user_id: 'subject', is_owner: false,
    roles: [{ role: 'Tasks.review', granted_at: new Date(NOW).toISOString(), granted_by: user.user_id }] });
  await store.removeMembership(subject.membership_id);
  const otherTeam = await store.createTeam({});
  await store.createMembership({ team_id: otherTeam.team_id, user_id: 'absent', is_owner: true, roles: [] });
  const statements: { sql: string; values: unknown[] }[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const observing: IdentityD1Database = {
    exec: sql => d1.exec(sql),
    prepare(sql) { return { bind(...values) {
      statements.push({ sql, values });
      const bound = d1.prepare(sql).bind(...values);
      return { ...bound, async all<T>() {
        const observed = await bound.all<T>();
        await gate;
        return observed;
      } };
    } }; },
  };
  const snapshotStore = createD1IdentityStore(observing);
  const users = ['subject', 'absent', user.user_id, user.user_id];
  const pending = snapshotStore.findMembershipsSnapshot(team.team_id, users);
  users[0] = 'absent';
  await store.reactivateMembership(subject.membership_id, { is_owner: true, roles: [] });
  await store.removeMembership(membership.membership_id);
  release();
  const snapshot = await pending;
  assert.equal(statements.length, 1);
  assert.match(statements[0]!.sql, /^WITH wanted.*SELECT .*LEFT JOIN identity_memberships/);
  assert.deepEqual(statements[0]!.values, ['subject', 'absent', user.user_id, user.user_id, team.team_id]);
  assert.equal(snapshot.team_id, team.team_id);
  assert.deepEqual(snapshot.entries.map(e => e.user_id), ['subject', 'absent', user.user_id, user.user_id]);
  assert.equal(snapshot.entries[0]!.membership!.status, 'removed');
  assert.equal(snapshot.entries[0]!.membership!.is_owner, false);
  assert.equal(snapshot.entries[0]!.membership!.roles[0]!.role, 'Tasks.review');
  assert.equal(snapshot.entries[1]!.membership, null);
  assert.equal(snapshot.entries[2]!.membership!.status, 'active');
  assert.equal(snapshot.entries[2]!.membership!.is_owner, true);
  assert.deepEqual(snapshot.entries[2], snapshot.entries[3]);
  assert(Object.isFrozen(snapshot.entries[0]!.membership!.roles[0]));
  assert(Object.isFrozen(snapshot.entries) && Object.isFrozen(snapshot.entries[2]!.membership));
  assert.equal(snapshot.entries[2]!.membership!.updated_at, (await store.findMembershipById(membership.membership_id))!.updated_at);
  db.close();
});

test('D1 snapshot admits the maximum in one query and refuses malformed requests before I/O', async () => {
  const { db, d1 } = await setup();
  const binds: unknown[][] = [];
  const store = createD1IdentityStore({ exec: sql => d1.exec(sql), prepare(sql) {
    return { bind(...values) { binds.push(values); return d1.prepare(sql).bind(...values); } };
  } });
  let calls = 0;
  const accessor = ['caller'];
  Object.defineProperty(accessor, '0', { get() { calls++; return 'caller'; } });
  for (const users of [[], new Array<string>(1), accessor, [''], Array<string>(100).fill('caller')]) {
    await assert.rejects(store.findMembershipsSnapshot('team', users));
  }
  await assert.rejects(store.findMembershipsSnapshot('', ['caller']));
  assert.equal(calls, 0);
  assert.equal(binds.length, 0);
  const users = Array<string>(99).fill('missing');
  users[98] = "quoted' OR 1=1 --";
  const snapshot = await store.findMembershipsSnapshot('team', users);
  assert.equal(binds.length, 1);
  assert.equal(binds[0]!.length, 100);
  assert.equal(snapshot.entries.length, 99);
  assert(snapshot.entries.every(e => e.membership === null));
  assert.equal(snapshot.entries[98]!.user_id, users[98]);
  db.close();
});

test('D1 snapshot refuses incomplete, skewed and corrupt facts instead of narrowing authority', async () => {
  const { db, d1, store } = await setup();
  const { user, team } = await setupUserTeam(store);
  const corruptions: ((rows: Record<string, unknown>[]) => void)[] = [
    rows => { rows.pop(); },
    rows => { rows.push(rows[0]!); },
    rows => { rows.reverse(); },
    rows => { rows[0]!['ordinal'] = 1; },
    rows => { rows[0]!['requested_user_id'] = 'other'; },
    rows => { rows[0]!['team_id'] = 'other'; },
    rows => { rows[0]!['user_id'] = 'other'; },
    rows => { rows[0]!['is_owner'] = 2; },
    rows => { rows[0]!['status'] = 'unknown'; },
    rows => { rows[0]!['roles'] = '{}'; },
    rows => { rows[0]!['roles'] = '[{"role":"Tasks.review"}]'; },
    rows => { rows[1]!['status'] = 'active'; },
  ];
  for (const corrupt of corruptions) {
    const changed = createD1IdentityStore({ exec: sql => d1.exec(sql), prepare(sql) {
      return { bind(...values) {
        const bound = d1.prepare(sql).bind(...values);
        return { ...bound, async all<T>() {
          const result = await bound.all<Record<string, unknown>>();
          const rows = result.results.map(r => ({ ...r }));
          corrupt(rows);
          return { results: rows as T[] };
        } };
      } };
    } });
    await assert.rejects(changed.findMembershipsSnapshot(team.team_id, [user.user_id, 'missing']));
  }
  db.close();
});

/** Adapt node:sqlite to the store's minimal D1 surface (no new deps). */
function wrapSqlite(db: DatabaseSync): IdentityD1Database {
  const executions = new WeakMap<object, () => unknown>();
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          // The store binds string | number | null only; anything else is a
          // store bug the engine must reject, never silently coerce.
          const args = values.map((value) => {
            if (
              typeof value !== 'string' &&
              typeof value !== 'number' &&
              value !== null
            ) {
              throw new Error(`d1-test: unbindable value ${typeof value}`);
            }
            return value;
          });
          const stmt = db.prepare(sql);
          const bound = {
            async first<T>(): Promise<T | null> {
              const row = stmt.get(...args) as T | undefined;
              return row ?? null;
            },
            async all<T>(): Promise<{ results: T[] }> {
              return { results: stmt.all(...args) as T[] };
            },
            async run(): Promise<unknown> {
              return { meta: { changes: Number(stmt.run(...args).changes) } };
            },
          };
          executions.set(bound, () => ({ meta: { changes: Number(stmt.run(...args).changes) } }));
          return bound;
        },
      };
    },
    async exec(sql: string): Promise<unknown> {
      db.exec(sql);
      return undefined;
    },
    async batch(statements) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(statement => {
          const execute = executions.get(statement);
          assert.ok(execute, 'batch accepts only this real SQL adapter statements');
          return execute();
        });
        db.exec('COMMIT');
        return results;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}

async function setup() {
  const db = new DatabaseSync(':memory:');
  const d1 = wrapSqlite(db);
  await ensureIdentitySchema(d1);
  const clock = createFrozenClock(NOW);
  const store: IdentityStore = createD1IdentityStore(d1, { clock });
  return { db, d1, clock, store };
}

async function setupUserTeam(
  store: IdentityStore,
  opts: { email?: string; owner?: boolean } = {},
) {
  const user = await store.createUser({
    email: opts.email ?? 'd1@test.example',
    password_hash: 'test-hash-opaque',
    email_verified: true,
  });
  const team = await store.createTeam({});
  const membership = await store.createMembership({
    team_id: team.team_id,
    user_id: user.user_id,
    is_owner: opts.owner ?? true,
    roles: [],
  });
  return { user, team, membership };
}

test('ensureIdentitySchema is idempotent and creates every table', async () => {
  const { d1 } = await setup();
  await ensureIdentitySchema(d1);
  await ensureIdentitySchema(d1);
  const tables = await d1
    .prepare(
      "SELECT name AS name FROM sqlite_master WHERE type = 'table' AND name LIKE 'identity\\_%' ESCAPE '\\'",
    )
    .bind()
    .all<{ name: string }>();
  const names = tables.results.map((row) => row.name).sort();
  assert.deepEqual(names, [
    'identity_auth_codes',
    'identity_email_tokens',
    'identity_invitations',
    'identity_mcp_grants',
    'identity_member_removals',
    'identity_memberships',
    'identity_oauth_clients',
    'identity_presession_tokens',
    'identity_sessions',
    'identity_teams',
    'identity_users',
  ]);
});

test('users: create, case-insensitive lookup, password + verified updates', async () => {
  const { store } = await setup();
  const created = await store.createUser({
    email: 'Ada@Test.example',
    password_hash: 'hash-1',
    email_verified: false,
  });
  assert.equal(typeof created.user_id, 'string');
  assert.ok(created.user_id.length > 0);
  assert.equal(created.email, 'Ada@Test.example');

  const byEmail = await store.findUserByEmail('ada@test.example');
  assert.ok(byEmail !== null);
  assert.equal(byEmail.user_id, created.user_id);
  const byId = await store.findUserById(created.user_id);
  assert.ok(byId !== null);
  assert.equal(byId.email, 'Ada@Test.example');
  assert.equal(await store.findUserByEmail('nobody@test.example'), null);
  assert.equal(await store.findUserById('missing-user'), null);

  await store.setUserPassword(created.user_id, 'hash-2');
  assert.equal((await store.findUserById(created.user_id))?.password_hash, 'hash-2');
  await store.setUserEmailVerified(created.user_id, true);
  assert.equal((await store.findUserById(created.user_id))?.email_verified, true);

  // Missing rows are no-ops, never throws.
  await store.setUserPassword('missing-user', 'hash-3');
  await store.setUserEmailVerified('missing-user', true);
});

test('users: duplicate email fails loud (no silent second row)', async () => {
  const { store } = await setup();
  await store.createUser({
    email: 'dup@test.example',
    password_hash: 'hash-1',
    email_verified: false,
  });
  await assert.rejects(
    () =>
      store.createUser({
        email: 'DUP@test.example',
        password_hash: 'hash-2',
        email_verified: false,
      }),
    /UNIQUE|unique|duplicate/i,
  );
});

test('teams and memberships: full lifecycle', async () => {
  const { store } = await setup();
  const { user, team, membership } = await setupUserTeam(store);
  assert.equal((await store.findTeamById(team.team_id))?.team_id, team.team_id);
  assert.equal(await store.findTeamById('missing-team'), null);
  await store.setTeamTimezone(team.team_id, 'America/Chicago');
  assert.equal((await store.findTeamById(team.team_id))?.timezone, 'America/Chicago');

  assert.equal(
    (await store.findMembership(team.team_id, user.user_id))?.membership_id,
    membership.membership_id,
  );
  assert.equal(
    (await store.findMembershipById(membership.membership_id))?.status,
    'active',
  );
  assert.equal(await store.findMembership(team.team_id, 'missing-user'), null);

  const other = await store.createUser({
    email: 'other@test.example',
    password_hash: 'hash',
    email_verified: true,
  });
  await store.createMembership({
    team_id: team.team_id,
    user_id: other.user_id,
    is_owner: false,
    roles: [],
  });
  assert.equal((await store.listUserMemberships(other.user_id)).length, 1);
  assert.equal((await store.listActiveOwners(team.team_id)).length, 1);

  // Exactly one row per (team, user): concurrent re-admissions collide.
  await assert.rejects(
    () =>
      store.createMembership({
        team_id: team.team_id,
        user_id: user.user_id,
        is_owner: false,
        roles: [],
      }),
    /UNIQUE|unique|duplicate/i,
  );

  const otherMembership = await store.findMembership(team.team_id, other.user_id);
  assert.ok(otherMembership !== null);
  await store.setMembershipRoles(otherMembership.membership_id, [
    { role: 'TeamTasks.reviewer', granted_at: '2026-10-04T15:00:00.000Z', granted_by: user.user_id },
  ]);
  assert.deepEqual((await store.findMembershipById(otherMembership.membership_id))?.roles, [
    { role: 'TeamTasks.reviewer', granted_at: '2026-10-04T15:00:00.000Z', granted_by: user.user_id },
  ]);
  await store.setMembershipOwner(otherMembership.membership_id, true);
  assert.equal((await store.findMembershipById(otherMembership.membership_id))?.is_owner, true);

  await store.removeMembership(otherMembership.membership_id);
  assert.equal((await store.findMembershipById(otherMembership.membership_id))?.status, 'removed');
  // listUserMemberships keeps history (any status); owners list drops removed.
  assert.equal((await store.listUserMemberships(other.user_id)).length, 1);
  assert.equal((await store.listActiveOwners(team.team_id)).length, 1);

  await store.reactivateMembership(otherMembership.membership_id, {
    is_owner: false,
    roles: [],
  });
  const reactivated = await store.findMembershipById(otherMembership.membership_id);
  assert.equal(reactivated?.status, 'active');
  assert.equal(reactivated?.is_owner, false);
});

test('ordinary D1 owner demotion and removal serialize two admitted contenders, including a mixed race', async (t) => {
  for (const actions of [['demote', 'demote'], ['remove', 'remove'], ['demote', 'remove']] as const) {
    await t.test(actions.join('/'), async () => {
      const directory = mkdtempSync(join(tmpdir(), 'identity-owner-race-'));
      const path = join(directory, 'identity.sqlite');
      const first = new DatabaseSync(path), second = new DatabaseSync(path);
      try {
        const clock = createFrozenClock(NOW), d1 = wrapSqlite(first);
        await ensureIdentitySchema(d1);
        const store = createD1IdentityStore(d1, { clock });
        const { user: a, team, membership: aMember } = await setupUserTeam(store);
        const b = await store.createUser({ email: 'second-owner@example.test', password_hash: 'opaque', email_verified: true });
        const bMember = await store.createMembership({ team_id: team.team_id, user_id: b.user_id, is_owner: true, roles: [] });
        const members = [aMember, bMember], users = [a, b];
        const grants = [], invitations = [];
        for (const user of users) {
          grants.push(await store.createMcpGrant({ user_id: user.user_id, team_id: team.team_id, client_id: 'owner-race',
            token_sha256: user.user_id, expires_at: new Date(NOW + 100_000).toISOString() }));
          invitations.push(await store.createInvitation({ team_id: team.team_id, email: user.email,
            grants_owner: false, grants_roles: [], invited_by: a.user_id, expires_at: new Date(NOW + 100_000).toISOString() }));
        }
        let admitted = 0, release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const stores = [store, createD1IdentityStore(wrapSqlite(second), { clock })];
        for (const contender of stores) {
          const list = contender.listActiveOwners;
          contender.listActiveOwners = async id => {
            const owners = await list.call(contender, id);
            assert.equal(owners.length, 2, 'both public prechecks observe the original two owners');
            if (++admitted === 2) release();
            await gate;
            return owners;
          };
        }
        const results = await Promise.allSettled(actions.map((action, index) => action === 'demote'
          ? setMemberRole(stores[index]!, { team_id: team.team_id, member_user_id: users[index]!.user_id, role: '-owner' },
            { granted_by: users[index]!.user_id, clock })
          : removeMember(stores[index]!, { team_id: team.team_id, member_user_id: users[index]!.user_id },
            { removed_by: users[index]!.user_id })));
        assert.equal(admitted, 2);
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
        const loser = results.findIndex(result => result.status === 'rejected');
        const rejected = results[loser]!;
        assert.equal(rejected.status, 'rejected');
        if (rejected.status === 'rejected') {
          assert.ok(rejected.reason instanceof IdentityError);
          assert.equal(rejected.reason.code, 'forbidden');
          assert.equal(rejected.reason.message, 'A team must keep at least one owner.');
        }
        const owners = await createD1IdentityStore(d1, { clock }).listActiveOwners(team.team_id);
        assert.equal(owners.length, 1);
        assert.equal(owners[0]!.membership_id, members[loser]!.membership_id);
        assert.deepEqual(await store.findMembershipById(members[loser]!.membership_id), members[loser]);
        for (let index = 0; index < users.length; index++) {
          const changed = index !== loser && actions[index] === 'remove';
          assert.equal((await store.findMcpGrantByTokenHash(users[index]!.user_id))!.revoked_at,
            changed ? new Date(NOW).toISOString() : null);
          assert.equal((await store.findInvitationById(invitations[index]!.invitation_id))!.revoked_at,
            changed ? new Date(NOW).toISOString() : null);
        }
      } finally { second.close(); first.close(); rmSync(directory, { recursive: true, force: true }); }
    });
  }
});

test('D1 owner guard preserves promotions, nonowners, inactive owners and missing raw rows', async () => {
  const { db, store } = await setup();
  try {
    const { user, team, membership } = await setupUserTeam(store);
    const member = await store.createMembership({ team_id: team.team_id, user_id: 'ordinary-member', is_owner: false, roles: [] });
    await store.setMembershipOwner('missing-member', true);
    await store.setMembershipOwner('missing-member', false);
    await store.removeMembership('missing-member');
    await store.setMembershipOwner(member.membership_id, false);
    await store.removeMembership(member.membership_id);
    await store.setMembershipOwner(member.membership_id, true);
    await store.setMembershipOwner(member.membership_id, false);
    await store.removeMembership(member.membership_id);
    for (const mutate of [() => store.setMembershipOwner(membership.membership_id, false),
      () => store.removeMembership(membership.membership_id)]) {
      await assert.rejects(mutate, (error: unknown) => error instanceof IdentityError &&
        error.code === 'forbidden' && error.message === 'A team must keep at least one owner.');
      assert.deepEqual(await store.findMembership(team.team_id, user.user_id), membership);
    }
    await store.reactivateMembership(member.membership_id, { is_owner: false, roles: [] });
    await store.setMembershipOwner(member.membership_id, true);
    assert.equal((await store.listActiveOwners(team.team_id)).length, 2);
    await store.setMembershipOwner(membership.membership_id, false);
    await store.removeMembership(membership.membership_id);
    assert.equal((await store.listActiveOwners(team.team_id)).length, 1);
  } finally { db.close(); }
});

test('ordinary D1 removal refuses unavailable mutation acknowledgement before cascades', async () => {
  for (const answer of [undefined, { meta: {} }, { meta: { changes: '1' } }, { meta: { changes: 2 } }]) {
    const { db, d1, store, clock } = await setup();
    try {
      const { user: owner, team } = await setupUserTeam(store);
      const user = await store.createUser({ email: 'ack-member@example.test', password_hash: 'opaque', email_verified: true });
      await store.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
      const grant = await store.createMcpGrant({ user_id: user.user_id, team_id: team.team_id, client_id: 'ack',
        token_sha256: 'ack-grant', expires_at: new Date(NOW + 100_000).toISOString() });
      const invitation = await store.createInvitation({ team_id: team.team_id, email: user.email,
        grants_owner: false, grants_roles: [], invited_by: owner.user_id, expires_at: new Date(NOW + 100_000).toISOString() });
      const uncertain = createD1IdentityStore({ exec: sql => d1.exec(sql), prepare(sql) { return { bind(...values) {
        const bound = d1.prepare(sql).bind(...values);
        return { ...bound, async run() {
          const result = await bound.run();
          return sql.startsWith('UPDATE identity_memberships SET status') ? answer : result;
        } };
      } }; } }, { clock });
      await assert.rejects(removeMember(uncertain, { team_id: team.team_id, member_user_id: user.user_id },
        { removed_by: owner.user_id }), /membership mutation needs definitive meta.changes of 0 or 1/);
      assert.equal((await store.findMembership(team.team_id, user.user_id))!.status, 'removed',
        'unavailable acknowledgement does not undo a physically committed single update');
      assert.equal((await store.findMcpGrantByTokenHash(grant.token_sha256))!.revoked_at, null);
      assert.equal((await store.findInvitationById(invitation.invitation_id))!.revoked_at, null);
    } finally { db.close(); }
  }
});

test('invitations: create, accept, revoke, pending-addressed revocation', async () => {
  const { store } = await setup();
  const { user, team } = await setupUserTeam(store);
  const first = await store.createInvitation({
    team_id: team.team_id,
    email: 'guest@test.example',
    grants_owner: false,
    grants_roles: ['TeamTasks.reviewer'],
    invited_by: user.user_id,
    expires_at: '2026-11-04T15:00:00.000Z',
  });
  const row = await store.findInvitationById(first.invitation_id);
  assert.ok(row !== null);
  assert.equal(row.email, 'guest@test.example');
  assert.deepEqual([...row.grants_roles], ['TeamTasks.reviewer']);
  assert.equal(row.accepted_at, null);
  assert.equal(await store.findInvitationById('missing-invitation'), null);

  await store.acceptInvitation(first.invitation_id);
  assert.ok((await store.findInvitationById(first.invitation_id))?.accepted_at !== null);

  const second = await store.createInvitation({
    team_id: team.team_id,
    email: 'GUEST@test.example',
    grants_owner: false,
    grants_roles: [],
    invited_by: user.user_id,
    expires_at: '2026-11-04T15:00:00.000Z',
  });
  // Accepted invitations are not pending: only the second revokes.
  await store.revokePendingTeamInvitationsForEmail(team.team_id, 'guest@test.example');
  assert.equal(
    (await store.findInvitationById(first.invitation_id))?.revoked_at,
    null,
  );
  assert.ok((await store.findInvitationById(second.invitation_id))?.revoked_at !== null);

  await store.revokeInvitation(first.invitation_id);
  assert.ok((await store.findInvitationById(first.invitation_id))?.revoked_at !== null);
});

test('sessions: create, lookup, team switch, revocation', async () => {
  const { store } = await setup();
  const { user, team } = await setupUserTeam(store);
  const session = await store.createSession({
    user_id: user.user_id,
    token_sha256: 'session-hash-1',
    expires_at: '2026-11-04T15:00:00.000Z',
    last_team_id: team.team_id,
  });
  assert.equal((await store.findSessionByTokenHash('session-hash-1'))?.session_id, session.session_id);
  assert.equal(session.last_team_id, team.team_id);
  assert.equal(await store.findSessionByTokenHash('missing-hash'), null);

  await store.setSessionTeam(session.session_id, null);
  assert.equal((await store.findSessionByTokenHash('session-hash-1'))?.last_team_id, null);

  const other = await store.createSession({
    user_id: user.user_id,
    token_sha256: 'session-hash-2',
    expires_at: '2026-11-04T15:00:00.000Z',
    last_team_id: null,
  });
  await store.revokeSession(session.session_id);
  assert.ok((await store.findSessionByTokenHash('session-hash-1'))?.revoked_at !== null);
  assert.equal((await store.findSessionByTokenHash('session-hash-2'))?.revoked_at, null);
  await store.revokeUserSessions(user.user_id);
  assert.ok((await store.findSessionByTokenHash('session-hash-2'))?.revoked_at !== null);
  // Revoking twice keeps the first revoked_at (memory parity).
  const firstRevoked = (await store.findSessionByTokenHash('session-hash-1'))?.revoked_at;
  await store.revokeSession(session.session_id);
  assert.equal((await store.findSessionByTokenHash('session-hash-1'))?.revoked_at, firstRevoked);
  assert.ok(other.session_id.length > 0);
});

test('pre-session tokens: create, lookup by hash, hard delete', async () => {
  const { store } = await setup();
  const { token_id } = await store.createPreSessionToken({
    token_sha256: 'presession-hash-1',
    expires_at: '2026-10-04T15:10:00.000Z',
  });
  assert.equal((await store.findPreSessionTokenByHash('presession-hash-1'))?.token_id, token_id);
  assert.equal(await store.findPreSessionTokenByHash('missing-hash'), null);
  await store.deletePreSessionToken(token_id);
  assert.equal(await store.findPreSessionTokenByHash('presession-hash-1'), null);
  // Deleting twice is a no-op, never an error.
  await store.deletePreSessionToken(token_id);
});

test('pre-session atomic consume: two D1 handles yield one winner and expiry is consumed', async () => {
  const { db, d1, clock, store } = await setup();
  try {
    const other = createD1IdentityStore(d1, { clock });
    const { token } = await mintPreSessionToken(store, { clock });
    const results = await Promise.all([
      consumePreSessionToken(store, token, { clock }), consumePreSessionToken(other, token, { clock }),
    ]);
    assert.deepEqual(results.sort(), [false, true]);
    assert.equal(await consumePreSessionToken(other, token, { clock }), false);
    assert.equal(await store.findPreSessionTokenByHash(await sha256HexText(token)), null);
    const expired = await mintPreSessionToken(store, { clock });
    clock.advance(PRESESSION_TTL_MS);
    assert.equal(await consumePreSessionToken(other, expired.token, { clock }), false);
    assert.equal(await store.findPreSessionTokenByHash(await sha256HexText(expired.token)), null);
    assert.equal(await consumePreSessionToken(store, expired.token, { clock }), false);
    const live = await mintPreSessionToken(store, { clock });
    clock.advance(PRESESSION_TTL_MS - 1);
    assert.equal(await consumePreSessionToken(other, live.token, { clock }), true);
  } finally { db.close(); }
});

test('email tokens: create, lookup, idempotent consume, purpose-scoped revocation', async () => {
  const { store } = await setup();
  const { user } = await setupUserTeam(store);
  const { token_id } = await store.createEmailToken({
    user_id: user.user_id,
    purpose: 'verify_email',
    token_sha256: 'email-hash-1',
    expires_at: '2026-10-05T15:00:00.000Z',
  });
  assert.equal((await store.findEmailTokenByHash('email-hash-1'))?.token_id, token_id);
  assert.equal(await store.findEmailTokenByHash('missing-hash'), null);

  await store.consumeEmailToken(token_id);
  const consumed = (await store.findEmailTokenByHash('email-hash-1'))?.consumed_at;
  assert.ok(consumed !== null);
  await store.consumeEmailToken(token_id);
  assert.equal((await store.findEmailTokenByHash('email-hash-1'))?.consumed_at, consumed);

  const recovery = await store.createEmailToken({
    user_id: user.user_id,
    purpose: 'recover_account',
    token_sha256: 'email-hash-2',
    expires_at: '2026-10-05T15:00:00.000Z',
  });
  await store.revokeUserEmailTokens(user.user_id, 'recover_account');
  assert.ok(
    (await store.findEmailTokenByHash('email-hash-2'))?.consumed_at !== null,
  );
  assert.ok(recovery.token_id.length > 0);
});

test('mcp grants: create, lookup, revoke, user/team revocation', async () => {
  const { store } = await setup();
  const { user, team } = await setupUserTeam(store);
  const grant = await store.createMcpGrant({
    user_id: user.user_id,
    team_id: team.team_id,
    client_id: 'test-client',
    token_sha256: 'grant-hash-1',
    expires_at: '2026-11-04T15:00:00.000Z',
  });
  assert.equal(grant.client_id, 'test-client');
  assert.equal(grant.revoked_at, null);
  assert.equal((await store.findMcpGrantByTokenHash('grant-hash-1'))?.grant_id, grant.grant_id);
  assert.equal(await store.findMcpGrantByTokenHash('missing-hash'), null);

  await store.revokeMcpGrant(grant.grant_id);
  const revoked = (await store.findMcpGrantByTokenHash('grant-hash-1'))?.revoked_at;
  assert.ok(revoked !== null);
  await store.revokeMcpGrant(grant.grant_id);
  assert.equal((await store.findMcpGrantByTokenHash('grant-hash-1'))?.revoked_at, revoked);

  const team2 = await store.createTeam({});
  const grant2 = await store.createMcpGrant({
    user_id: user.user_id,
    team_id: team2.team_id,
    client_id: 'test-client',
    token_sha256: 'grant-hash-2',
    expires_at: '2026-11-04T15:00:00.000Z',
  });
  await store.revokeUserTeamMcpGrants(user.user_id, team.team_id);
  assert.equal((await store.findMcpGrantByTokenHash('grant-hash-2'))?.revoked_at, null);
  await store.revokeUserMcpGrants(user.user_id);
  assert.ok((await store.findMcpGrantByTokenHash('grant-hash-2'))?.revoked_at !== null);
  assert.ok(grant2.grant_id.length > 0);
});

test('oauth clients and auth codes: register, lookup, idempotent consume', async () => {
  const { store } = await setup();
  const { user, team } = await setupUserTeam(store);
  const client = await store.createOAuthClient({
    client_name: 'test-mcp-host',
    redirect_uris: ['https://host.invalid/callback'],
  });
  assert.ok(client.client_id.startsWith('client_'));
  const found = await store.findOAuthClient(client.client_id);
  assert.ok(found !== null);
  assert.deepEqual([...found.redirect_uris], ['https://host.invalid/callback']);
  assert.equal(await store.findOAuthClient('client_missing'), null);

  const code = await store.createAuthCode({
    client_id: client.client_id,
    user_id: user.user_id,
    team_id: team.team_id,
    redirect_uri: 'https://host.invalid/callback',
    code_challenge: 'challenge-opaque',
    code_sha256: 'code-hash-1',
    expires_at: '2026-10-04T15:10:00.000Z',
  });
  assert.equal((await store.findAuthCodeByHash('code-hash-1'))?.code_challenge, code.code_challenge);
  assert.equal(await store.findAuthCodeByHash('missing-hash'), null);
  assert.equal(await store.consumeAuthCode('code-hash-1'), 'consumed');
  const consumed = (await store.findAuthCodeByHash('code-hash-1'))?.consumed_at;
  assert.ok(consumed !== null);
  assert.equal(await store.consumeAuthCode('code-hash-1'), 'unavailable');
  assert.equal(await store.consumeAuthCode('missing-hash'), 'unavailable');
  assert.equal((await store.findAuthCodeByHash('code-hash-1'))?.consumed_at, consumed);
});

test('grant round-trip: real issue + mcp-grant resolve, revoke and expiry deny', async () => {
  const { store, clock } = await setup();
  const { user, team, membership } = await setupUserTeam(store);
  const issued = await issueMcpGrant(
    store,
    { user_id: user.user_id, team_id: team.team_id, client_id: 'prod-client' },
    { clock },
  );
  assert.ok(issued.token.length > 0);

  const resolved = await resolveIdentity(store, { mcp_grant_token: issued.token }, { clock });
  assert.equal(resolved.actor?.user_id, user.user_id);
  assert.equal(resolved.team?.team_id, team.team_id);
  assert.equal(resolved.membership?.membership_id, membership.membership_id);
  assert.equal(resolved.binding.kind, 'mcp_grant');

  // Unknown token: collapsed credential failure (never a distinct oracle).
  await assert.rejects(
    resolveIdentity(store, { mcp_grant_token: 'bogus-not-a-grant' }, { clock }),
    (err: unknown) => err instanceof IdentityError && err.code === 'forbidden',
  );

  await store.revokeMcpGrant(issued.grant.grant_id);
  await assert.rejects(
    resolveIdentity(store, { mcp_grant_token: issued.token }, { clock }),
    (err: unknown) => err instanceof IdentityError && err.code === 'forbidden',
  );

  const fresh = await issueMcpGrant(
    store,
    { user_id: user.user_id, team_id: team.team_id, client_id: 'prod-client' },
    { clock, ttlMs: 1000 },
  );
  clock.advance(2000);
  await assert.rejects(
    resolveIdentity(store, { mcp_grant_token: fresh.token }, { clock }),
    (err: unknown) => err instanceof IdentityError && err.code === 'forbidden',
  );

  // Removed membership ends grant admission immediately (collapsed, not an oracle).
  clock.advance(-2000);
  const replacement = await store.createUser({ email: 'replacement-owner@example.test', password_hash: 'opaque', email_verified: true });
  await store.createMembership({ team_id: team.team_id, user_id: replacement.user_id, is_owner: true, roles: [] });
  const member = await issueMcpGrant(
    store,
    { user_id: user.user_id, team_id: team.team_id, client_id: 'prod-client' },
    { clock },
  );
  await store.removeMembership(membership.membership_id);
  await assert.rejects(
    resolveIdentity(store, { mcp_grant_token: member.token }, { clock }),
    (err: unknown) => err instanceof IdentityError && err.code === 'forbidden',
  );
});

test('session round-trip: the grant route resolves cookie sessions from D1', async () => {
  const { store, clock } = await setup();
  const { user, team } = await setupUserTeam(store);
  const session = await store.createSession({
    user_id: user.user_id,
    token_sha256: 'route-session-hash',
    expires_at: '2026-11-04T15:00:00.000Z',
    last_team_id: team.team_id,
  });
  // resolveIdentity hashes the presented token; store the hash of the token
  // the route will present by round-tripping through the real hasher.
  const { sha256HexText } = await import('../src/sessions/tokens.js');
  const presented = 'route-session-token-opaque';
  await store.revokeSession(session.session_id);
  const live = await store.createSession({
    user_id: user.user_id,
    token_sha256: await sha256HexText(presented),
    expires_at: '2026-11-04T15:00:00.000Z',
    last_team_id: team.team_id,
  });
  const resolved = await resolveIdentity(store, { session_token: presented }, { clock });
  assert.equal(resolved.binding.kind, 'session');
  if (resolved.binding.kind === 'session') {
    assert.equal(resolved.binding.session_id, live.session_id);
  }
  assert.equal(resolved.actor?.user_id, user.user_id);
  assert.equal(resolved.team?.team_id, team.team_id);
  assert.equal(resolved.membership?.status, 'active');
});

test('D1 consumption accepts only definitive own numeric meta.changes 0 or 1', async () => {
  const profiles: unknown[] = [undefined, null, {}, { changes: 1 }, { meta: {} },
    { meta: { changes: '1' } }, { meta: { changes: true } }, { meta: { changes: 2 } },
    { meta: { changes: -1 } }, { meta: { changes: NaN } }, { meta: { changes: Infinity } },
    { meta: [] }, { meta: Object.create({ changes: 1 }) }, Object.create({ meta: { changes: 1 } })];
  for (const profile of [...profiles, { meta: { changes: 0 } }, { meta: { changes: 1 } }]) {
    let updates = 0;
    const database: IdentityD1Database = {
      prepare(sql) {
        assert.equal(sql, 'UPDATE identity_auth_codes SET consumed_at = ? WHERE code_sha256 = ? AND consumed_at IS NULL');
        return { bind(...args) {
          assert.deepEqual(args, [new Date(NOW).toISOString(), 'code-hash']);
          return { async first<T>() { throw new Error('no reread'); }, async all<T>() { throw new Error('no reread'); },
            async run() { updates++; return profile; } };
        } };
      },
      async exec() { throw new Error('no schema mutation'); },
    };
    const store = createD1IdentityStore(database, { clock: createFrozenClock(NOW) });
    if (profiles.includes(profile)) {
      await assert.rejects(() => store.consumeAuthCode('code-hash'), /definitive meta.changes of 0 or 1/);
    } else {
      assert.equal(await store.consumeAuthCode('code-hash'), (profile as { meta: { changes: number } }).meta.changes === 1 ? 'consumed' : 'unavailable');
    }
    assert.equal(updates, 1);
  }
});

test('atomic removal occurrence survives lost acknowledgement and reopen without revoking re-admitted resources', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'identity-removal-'));
  const path = join(directory, 'identity.sqlite');
  let db = new DatabaseSync(path);
  try {
    const d1 = wrapSqlite(db), clock = createFrozenClock(NOW);
    await ensureIdentitySchema(d1);
    const store = createD1IdentityStore(d1, { clock });
    const { user: owner, team } = await setupUserTeam(store);
    const subject = await store.createUser({ email: 'subject@example.test', password_hash: 'opaque', email_verified: true });
    const member = await store.createMembership({ team_id: team.team_id, user_id: subject.user_id, is_owner: false, roles: [] });
    const resources = async (hash: string) => ({
      grant: await store.createMcpGrant({ user_id: subject.user_id, team_id: team.team_id, client_id: 'client', token_sha256: hash, expires_at: new Date(NOW + 100_000).toISOString() }),
      invitation: await store.createInvitation({ team_id: team.team_id, email: subject.email, grants_owner: false, grants_roles: [], invited_by: owner.user_id, expires_at: new Date(NOW + 100_000).toISOString() }),
    });
    const old = await resources('old-grant');
    const input = { team_id: team.team_id, member_user_id: subject.user_id, removed_by: owner.user_id, namespace: 'app:Office', operationId: 'remove-1' };
    const acknowledgement = new Error('lost durable acknowledgement');
    const lost = createD1IdentityStore({ prepare: sql => d1.prepare(sql), exec: sql => d1.exec(sql),
      async batch(statements) { await d1.batch!(statements); throw acknowledgement; } }, { clock });
    await assert.rejects(lost.removeMemberWithOccurrence!(input), error => error === acknowledgement);
    assert.equal((await store.findMembershipById(member.membership_id))!.status, 'removed');
    assert.ok((await store.findMcpGrantByTokenHash('old-grant'))!.revoked_at);
    assert.ok((await store.findInvitationById(old.invitation.invitation_id))!.revoked_at);
    const original = await store.removeMemberWithOccurrence!(input);
    assert.deepEqual(original.membershipRemoval, { team_id: team.team_id, membership_id: member.membership_id, user: { kind: 'user', id: subject.user_id } });
    assert.deepEqual(original.removedBy, { kind: 'user', id: owner.user_id });
    assert.equal(original.deliveryId, null); assert.equal(original.operationKind, 'teams.member_removed');
    assert.equal(original.occurredAt, new Date(NOW).toISOString());
    for (const value of [original, original.membershipRemoval, original.membershipRemoval.user, original.removedBy]) assert.equal(Object.isFrozen(value), true);
    await store.reactivateMembership(member.membership_id, { is_owner: false, roles: [] });
    const fresh = await resources('new-grant');
    db.close(); db = new DatabaseSync(path);
    const reopenedD1 = wrapSqlite(db), reopened = createD1IdentityStore(reopenedD1, { clock: createFrozenClock(NOW + 10_000) });
    assert.deepEqual(await reopened.removeMemberWithOccurrence!(input), original);
    assert.equal((await reopened.findMembershipById(member.membership_id))!.status, 'active');
    assert.equal((await reopened.findMcpGrantByTokenHash('new-grant'))!.revoked_at, null);
    assert.equal((await reopened.findInvitationById(fresh.invitation.invitation_id))!.revoked_at, null);
    for (const changed of [{ ...input, member_user_id: owner.user_id }, { ...input, removed_by: subject.user_id }, { ...input, team_id: 'foreign-team' }]) {
      await assert.rejects(reopened.removeMemberWithOccurrence!(changed), (error: unknown) => error instanceof IdentityError && error.code === 'conflict');
    }
    assert.equal((await reopened.findMembershipById(member.membership_id))!.status, 'active');
    const next = await reopened.removeMemberWithOccurrence!({ ...input, operationId: 'remove-2' });
    assert.notEqual(next.producerEventId, original.producerEventId);
    assert.equal((await reopened.findMcpGrantByTokenHash('new-grant'))!.revoked_at, next.occurredAt);
    assert.equal((await reopened.findInvitationById(fresh.invitation.invitation_id))!.revoked_at, next.occurredAt);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('atomic removal occurrence real SQL batches roll back and serialize same-key and last-owner winners', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'identity-removal-race-'));
  const path = join(directory, 'identity.sqlite');
  const first = new DatabaseSync(path), second = new DatabaseSync(path);
  try {
    const d1 = wrapSqlite(first), otherD1 = wrapSqlite(second), clock = createFrozenClock(NOW);
    await ensureIdentitySchema(d1);
    const store = createD1IdentityStore(d1, { clock }), other = createD1IdentityStore(otherD1, { clock });
    const { user: owner, team } = await setupUserTeam(store);
    const subject = await store.createUser({ email: 'race@example.test', password_hash: 'opaque', email_verified: true });
    const membership = await store.createMembership({ team_id: team.team_id, user_id: subject.user_id, is_owner: true, roles: [] });
    await store.createMcpGrant({ user_id: subject.user_id, team_id: team.team_id, client_id: 'client', token_sha256: 'race-grant', expires_at: new Date(NOW + 100_000).toISOString() });
    const input = { team_id: team.team_id, member_user_id: subject.user_id, removed_by: owner.user_id, namespace: 'app:Office', operationId: 'race' };
    const snapshot = () => ['identity_member_removals', 'identity_memberships', 'identity_mcp_grants', 'identity_invitations'].map(table => first.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
    const before = snapshot();
    first.exec("CREATE TRIGGER removal_fail BEFORE UPDATE ON identity_mcp_grants BEGIN SELECT RAISE(ABORT, 'cascade failed'); END");
    await assert.rejects(store.removeMemberWithOccurrence!(input), /cascade failed/);
    assert.deepEqual(snapshot(), before, 'event insert and membership update roll back with the failing cascade');
    first.exec('DROP TRIGGER removal_fail');
    const [a, b] = await Promise.all([store.removeMemberWithOccurrence!(input), other.removeMemberWithOccurrence!(input)]);
    assert.deepEqual(a, b); assert.equal(first.prepare('SELECT COUNT(*) AS n FROM identity_member_removals').get()!['n'], 1);
    await store.reactivateMembership(membership.membership_id, { is_owner: true, roles: [] });
    const results = await Promise.allSettled([
      store.removeMemberWithOccurrence!({ ...input, operationId: 'owner-a' }),
      other.removeMemberWithOccurrence!({ ...input, member_user_id: owner.user_id, removed_by: subject.user_id, operationId: 'owner-b' }),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await store.listActiveOwners(team.team_id)).length, 1);
    const after = snapshot();
    const unsupported = createD1IdentityStore({ prepare: sql => d1.prepare(sql), exec: sql => d1.exec(sql) }, { clock });
    await assert.rejects(removeMember(unsupported, { team_id: team.team_id, member_user_id: subject.user_id },
      { removed_by: owner.user_id, occurrence: { namespace: 'app:Office', operationId: 'unsupported' } }),
      /Atomic membership removal occurrences are not configured/);
    assert.deepEqual(snapshot(), after);
    await assert.rejects(store.removeMemberWithOccurrence!({ ...input, namespace: '' }), (error: unknown) => error instanceof IdentityError && error.code === 'validation');
    assert.deepEqual(snapshot(), after);
  } finally { second.close(); first.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('delayed losing removal batch preserves re-admitted resources and retained replay conveys no new owner authority', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'identity-removal-delayed-'));
  const path = join(directory, 'identity.sqlite');
  const first = new DatabaseSync(path), second = new DatabaseSync(path);
  try {
    const d1 = wrapSqlite(first), loserD1 = wrapSqlite(second), clock = createFrozenClock(NOW);
    await ensureIdentitySchema(d1);
    const store = createD1IdentityStore(d1, { clock });
    const { user: owner, team, membership: ownerMembership } = await setupUserTeam(store);
    const subject = await store.createUser({ email: 'delayed@example.test', password_hash: 'opaque', email_verified: true });
    const member = await store.createMembership({ team_id: team.team_id, user_id: subject.user_id, is_owner: false, roles: [] });
    const input = { team_id: team.team_id, member_user_id: subject.user_id, removed_by: owner.user_id,
      namespace: 'app:Office', operationId: 'delayed-loser' };
    let entered!: () => void, release!: () => void;
    const batchEntered = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const loser = createD1IdentityStore({ prepare: sql => loserD1.prepare(sql), exec: sql => loserD1.exec(sql),
      async batch(statements) { entered(); await gate; return loserD1.batch!(statements); } }, { clock });
    const pending = loser.removeMemberWithOccurrence!(input);
    await batchEntered; // Its absent-prior lookup and statements are already captured.
    let original: Awaited<ReturnType<NonNullable<IdentityStore['removeMemberWithOccurrence']>>> | undefined;
    try {
      original = await store.removeMemberWithOccurrence!(input);
      await store.reactivateMembership(member.membership_id, { is_owner: false, roles: [] });
      await store.createMcpGrant({ user_id: subject.user_id, team_id: team.team_id, client_id: 'client', token_sha256: 'delayed-fresh-grant', expires_at: new Date(NOW + 100_000).toISOString() });
      await store.createInvitation({ team_id: team.team_id, email: subject.email, grants_owner: false, grants_roles: [], invited_by: owner.user_id, expires_at: new Date(NOW + 100_000).toISOString() });
    } finally { release(); }
    assert.ok(original);
    const snapshot = () => ['identity_member_removals', 'identity_memberships', 'identity_mcp_grants', 'identity_invitations']
      .map(table => first.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
    const beforeLoser = snapshot();
    assert.deepEqual(await pending, original);
    assert.deepEqual(snapshot(), beforeLoser, 'the losing attempt token cannot repeat any cascade on fresh resources');
    assert.equal((await store.findMembershipById(member.membership_id))!.status, 'active');
    assert.equal((await store.findMcpGrantByTokenHash('delayed-fresh-grant'))!.revoked_at, null);
    // Technical receipt replay survives loss of the original remover's authority.
    await store.setMembershipOwner(member.membership_id, true);
    await store.removeMembership(ownerMembership.membership_id);
    const withoutAuthority = snapshot();
    assert.deepEqual(await store.removeMemberWithOccurrence!(input), original);
    assert.deepEqual(snapshot(), withoutAuthority);
    await assert.rejects(store.removeMemberWithOccurrence!({ ...input, operationId: 'new-after-remover-removal' }),
      (error: unknown) => error instanceof IdentityError && error.code === 'forbidden');
    assert.deepEqual(snapshot(), withoutAuthority, 'a saved outcome cannot authorize a fresh event or removal');
  } finally { second.close(); first.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('cold removal occurrence lookup reopens original SQL facts without command authority or new effects', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'identity-removal-read-'));
  const path = join(directory, 'identity.sqlite');
  let db = new DatabaseSync(path);
  try {
    const d1 = wrapSqlite(db);
    await ensureIdentitySchema(d1);
    const store = createD1IdentityStore(d1, { clock: createFrozenClock(NOW) });
    const { user: owner, team, membership: ownerMembership } = await setupUserTeam(store);
    const subject = await store.createUser({ email: 'cold-subject@example.test', password_hash: 'opaque', email_verified: true });
    const member = await store.createMembership({ team_id: team.team_id, user_id: subject.user_id, is_owner: false, roles: [] });
    const input = { team_id: team.team_id, member_user_id: subject.user_id, removed_by: owner.user_id,
      namespace: 'app:Office', operationId: 'cold-original' };
    const original = await store.removeMemberWithOccurrence!(input);
    await store.reactivateMembership(member.membership_id, { is_owner: false, roles: [] });
    const grant = await store.createMcpGrant({ user_id: subject.user_id, team_id: team.team_id,
      client_id: 'client', token_sha256: 'cold-fresh-grant', expires_at: new Date(NOW + 100_000).toISOString() });
    const invitation = await store.createInvitation({ team_id: team.team_id, email: subject.email,
      grants_owner: false, grants_roles: [], invited_by: owner.user_id, expires_at: new Date(NOW + 100_000).toISOString() });
    await store.setMembershipOwner(member.membership_id, true);
    await store.removeMembership(ownerMembership.membership_id);
    db.close(); db = new DatabaseSync(path);
    const reopened = wrapSqlite(db);
    const selects: string[] = [];
    let writes = 0, clocks = 0, randoms = 0;
    const readonlyDb: IdentityD1Database = {
      prepare(sql) {
        selects.push(sql); assert.match(sql, /^SELECT\b/);
        assert.match(sql, /FROM identity_member_removals WHERE namespace = \? AND operation_id = \?$/);
        return { bind(...values) {
          const bound = reopened.prepare(sql).bind(...values);
          return { first: <T>() => bound.first<T>(), all: <T>() => bound.all<T>(),
            async run() { writes++; throw new Error('read-only lookup attempted a write'); } };
        } };
      },
      async exec() { writes++; throw new Error('read-only lookup attempted exec'); },
      // Deliberately no batch: lookup cannot acquire the command implementation.
    };
    const reader = createD1IdentityStore(readonlyDb, {
      clock: { nowMs() { clocks++; throw new Error('lookup read current time'); } },
      random: { randomUUID() { randoms++; throw new Error('lookup minted an ID'); },
        randomBytes() { randoms++; throw new Error('lookup requested random bytes'); } },
    });
    assert.equal(reader.removeMemberWithOccurrence, undefined);
    assert.equal(typeof reader.readMemberRemovalOccurrence, 'function');
    const snapshot = () => ['identity_member_removals', 'identity_memberships', 'identity_mcp_grants', 'identity_invitations']
      .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
    const before = snapshot();
    const retained = await reader.readMemberRemovalOccurrence!(input);
    assert.deepEqual(retained, original);
    assert.notEqual(retained, original);
    assert.ok(retained);
    for (const fact of [retained, retained.membershipRemoval, retained.membershipRemoval.user, retained.removedBy]) {
      assert.equal(Object.isFrozen(fact), true);
    }
    for (const changed of [{ ...input, namespace: 'app:Elsewhere' }, { ...input, operationId: 'absent' }]) {
      assert.equal(await reader.readMemberRemovalOccurrence!(changed), null);
    }
    for (const changed of [{ ...input, member_user_id: owner.user_id }, { ...input, removed_by: subject.user_id },
      { ...input, team_id: 'foreign-team' }]) {
      await assert.rejects(reader.readMemberRemovalOccurrence!(changed),
        (error: unknown) => error instanceof IdentityError && error.code === 'conflict');
    }
    assert.deepEqual(snapshot(), before);
    assert.equal(selects.length, 6);
    db.prepare('UPDATE identity_member_removals SET occurred_at = ? WHERE namespace = ? AND operation_id = ?')
      .run('corrupt-time', input.namespace, input.operationId);
    const corrupted = snapshot();
    await assert.rejects(reader.readMemberRemovalOccurrence!(input), /Invalid stored membership removal occurrence/);
    assert.deepEqual(snapshot(), corrupted);
    db.prepare('DELETE FROM identity_member_removals WHERE namespace = ? AND operation_id = ?')
      .run(input.namespace, input.operationId);
    const absent = snapshot();
    assert.equal(await reader.readMemberRemovalOccurrence!(input), null);
    assert.deepEqual(snapshot(), absent, 'missing journal must not remove the readmitted member or recreate the event');
    assert.equal(db.prepare('SELECT status FROM identity_memberships WHERE membership_id = ?').get(member.membership_id)!['status'], 'active');
    assert.equal(db.prepare('SELECT revoked_at FROM identity_mcp_grants WHERE grant_id = ?').get(grant.grant_id)!['revoked_at'], null);
    assert.equal(db.prepare('SELECT revoked_at FROM identity_invitations WHERE invitation_id = ?').get(invitation.invitation_id)!['revoked_at'], null);
    assert.equal(selects.length, 8); assert.equal(writes, 0); assert.equal(clocks, 0); assert.equal(randoms, 0);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('cold removal lookup rejects malformed own-data arguments before SQL or accessor evaluation', async () => {
  const { db, d1 } = await setup();
  let queries = 0, getters = 0;
  try {
    const reader = createD1IdentityStore({
      prepare(sql) { queries++; return d1.prepare(sql); },
      async exec() { throw new Error('lookup cannot execute SQL mutation'); },
    });
    const input = { team_id: 'team', member_user_id: 'subject', removed_by: 'owner', namespace: 'app:Office', operationId: 'absent' };
    const accessors = (Object.keys(input) as Array<keyof typeof input>).map(name => {
      const accessor = { ...input };
      Object.defineProperty(accessor, name, { enumerable: true, get() { getters++; return input[name]; } });
      return accessor;
    });
    const inherited = Object.assign(Object.create({ namespace: input.namespace }), input);
    const hidden = { ...input };
    Object.defineProperty(hidden, 'operationId', { enumerable: false, value: 'absent' });
    for (const malformed of [null, {}, { ...input, namespace: '' }, { ...input, operationId: 1 },
      { ...input, extra: true }, { ...input, [Symbol('extra')]: true }, ...accessors, inherited, hidden]) {
      await assert.rejects(reader.readMemberRemovalOccurrence!(malformed as unknown as typeof input),
        (error: unknown) => error instanceof IdentityError && error.code === 'validation');
    }
    assert.equal(queries, 0); assert.equal(getters, 0);
  } finally { db.close(); }
});

function recoveryFacts(db: DatabaseSync): Record<string, unknown>[][] {
  return ['identity_users', 'identity_sessions', 'identity_mcp_grants', 'identity_email_tokens']
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all() as Record<string, unknown>[]);
}

async function setupRecoveryFacts(store: IdentityStore, credentials = true) {
  const user = await store.createUser({ email: 'recover@example.test', password_hash: 'original-hash', email_verified: true });
  const unrelated = await store.createUser({ email: 'unrelated@example.test', password_hash: 'unrelated-hash', email_verified: false });
  const expires_at = new Date(NOW + 60_000).toISOString();
  const raw = 'real-sql-recovery-proof', token_sha256 = await sha256HexText(raw);
  const proof = await store.createEmailToken({ user_id: user.user_id, purpose: 'recover_account', token_sha256, expires_at });
  const sibling = await store.createEmailToken({ user_id: user.user_id, purpose: 'recover_account', token_sha256: 'sibling-recovery', expires_at });
  const verification = await store.createEmailToken({ user_id: user.user_id, purpose: 'verify_email', token_sha256: 'target-verification', expires_at });
  await store.createEmailToken({ user_id: unrelated.user_id, purpose: 'recover_account', token_sha256: 'unrelated-recovery', expires_at });
  await store.createEmailToken({ user_id: unrelated.user_id, purpose: 'verify_email', token_sha256: 'unrelated-verification', expires_at });
  for (const subject of credentials ? [user, unrelated] : [unrelated]) {
    await store.createSession({ user_id: subject.user_id, token_sha256: `session:${subject.user_id}`, expires_at, last_team_id: null });
    await store.createMcpGrant({ user_id: subject.user_id, team_id: null, client_id: 'client', token_sha256: `grant:${subject.user_id}`, expires_at });
  }
  const input = { token_id: proof.token_id, user_id: user.user_id, password_hash: 'winner-hash' };
  return { user, unrelated, raw, token_sha256, proof, sibling, verification, expires_at, input };
}

test('atomic recovery real SQL rolls back every mutation phase with all account facts preserved', async (t) => {
  for (const phase of ['password', 'sessions', 'grants', 'other recovery tokens', 'exact recovery proof']) {
    await t.test(phase, async () => {
      const { db, store } = await setup();
      try {
        const { proof, input } = await setupRecoveryFacts(store);
        const target = phase === 'password' ? 'identity_users' : phase === 'sessions' ? 'identity_sessions'
          : phase === 'grants' ? 'identity_mcp_grants' : 'identity_email_tokens';
        const condition = phase === 'other recovery tokens' ? `WHEN OLD.token_id <> '${proof.token_id}'`
          : phase === 'exact recovery proof' ? `WHEN OLD.token_id = '${proof.token_id}'` : '';
        db.exec(`CREATE TRIGGER recovery_fault BEFORE UPDATE ON ${target} ${condition}
          BEGIN SELECT RAISE(ABORT, 'recovery phase fault'); END`);
        const before = recoveryFacts(db);
        await assert.rejects(store.recoverAccountWithToken!(input), /recovery phase fault/);
        assert.deepEqual(recoveryFacts(db), before, `${phase} failure must roll back password, credentials and every email proof`);
      } finally { db.close(); }
    });
  }
});

test('atomic recovery reopens its password and revocations while preserving verification and unrelated accounts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'identity-recovery-reopen-'));
  const path = join(directory, 'identity.sqlite');
  let db = new DatabaseSync(path);
  try {
    const d1 = wrapSqlite(db), clock = createFrozenClock(NOW);
    await ensureIdentitySchema(d1);
    const store = createD1IdentityStore(d1, { clock });
    const { user, input } = await setupRecoveryFacts(store);
    const before = recoveryFacts(db), at = new Date(NOW).toISOString();
    assert.deepEqual(await store.recoverAccountWithToken!(input), { user_id: user.user_id });
    db.close(); db = new DatabaseSync(path);
    const reopened = createD1IdentityStore(wrapSqlite(db), { clock });
    const expected = before.map((rows, table) => rows.map(row => {
      if (row['user_id'] !== user.user_id) return row;
      if (table === 0) return Object.assign(Object.create(null), row, { password_hash: input.password_hash, updated_at: at });
      if (table === 1 || table === 2) return Object.assign(Object.create(null), row, { revoked_at: at });
      return row['purpose'] === 'recover_account' ? Object.assign(Object.create(null), row, { consumed_at: at }) : row;
    }));
    assert.deepEqual(recoveryFacts(db), expected, 'the reopened file retains the complete transaction and leaves all other facts identical');
    assert.equal(await reopened.recoverAccountWithToken!({ ...input, password_hash: 'retry-hash' }), null);
    assert.deepEqual(recoveryFacts(db), expected);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('atomic recovery on two real SQL connections has one same-clock winner and a delayed loser preserves fresh credentials', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'identity-recovery-race-'));
  const path = join(directory, 'identity.sqlite');
  const first = new DatabaseSync(path), second = new DatabaseSync(path);
  let release!: () => void;
  try {
    const d1 = wrapSqlite(first), otherD1 = wrapSqlite(second), clock = createFrozenClock(NOW);
    await ensureIdentitySchema(d1);
    const store = createD1IdentityStore(d1, { clock });
    const { user, input, expires_at } = await setupRecoveryFacts(store);
    let entered!: () => void;
    const batchEntered = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const loser = createD1IdentityStore({ prepare: sql => otherD1.prepare(sql), exec: sql => otherD1.exec(sql),
      async batch(statements) { entered(); await gate; return otherD1.batch!(statements); } }, { clock });
    const pending = loser.recoverAccountWithToken!({ ...input, password_hash: 'loser-hash' });
    await batchEntered; // Both commands capture eligibility at the same clock.
    assert.deepEqual(await store.recoverAccountWithToken!(input), { user_id: user.user_id });
    await store.createSession({ user_id: user.user_id, token_sha256: 'postwinner-session', expires_at, last_team_id: null });
    await store.createMcpGrant({ user_id: user.user_id, team_id: null, client_id: 'client', token_sha256: 'postwinner-grant', expires_at });
    await store.createEmailToken({ user_id: user.user_id, purpose: 'recover_account', token_sha256: 'postwinner-proof', expires_at });
    const beforeLoser = recoveryFacts(first);
    release();
    assert.equal(await pending, null);
    assert.deepEqual(recoveryFacts(first), beforeLoser);
    assert.equal((await store.findUserById(user.user_id))!.password_hash, 'winner-hash');
    assert.equal((await store.findSessionByTokenHash('postwinner-session'))!.revoked_at, null);
    assert.equal((await store.findMcpGrantByTokenHash('postwinner-grant'))!.revoked_at, null);
    assert.equal((await store.findEmailTokenByHash('postwinner-proof'))!.consumed_at, null);
    assert.equal(clock.nowMs(), NOW);
  } finally { release?.(); second.close(); first.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('atomic recovery rejects invalid real SQL proofs and missing batch without changing any facts', async (t) => {
  for (const invalid of ['wrong purpose', 'expired', 'wrong user', 'orphan proof', 'spent proof']) {
    await t.test(invalid, async () => {
      const { db, store } = await setup();
      try {
        const { user, unrelated, proof, verification, input } = await setupRecoveryFacts(store);
        let attempt = input;
        if (invalid === 'wrong purpose') attempt = { ...input, token_id: verification.token_id };
        if (invalid === 'expired') db.prepare('UPDATE identity_email_tokens SET expires_at = ? WHERE token_id = ?')
          .run(new Date(NOW).toISOString(), proof.token_id);
        if (invalid === 'wrong user') attempt = { ...input, user_id: unrelated.user_id };
        if (invalid === 'orphan proof') db.prepare('DELETE FROM identity_users WHERE user_id = ?').run(user.user_id);
        if (invalid === 'spent proof') await store.consumeEmailToken(proof.token_id);
        const before = recoveryFacts(db);
        assert.equal(await store.recoverAccountWithToken!(attempt), null);
        assert.deepEqual(recoveryFacts(db), before);
      } finally { db.close(); }
    });
  }
  await t.test('missing batch', async () => {
    const { db, d1, clock, store } = await setup();
    try {
      const { raw } = await setupRecoveryFacts(store);
      const unsupported = createD1IdentityStore({ prepare: sql => d1.prepare(sql), exec: sql => d1.exec(sql) }, { clock });
      assert.equal(unsupported.recoverAccountWithToken, undefined);
      const before = recoveryFacts(db);
      await assert.rejects(recoverAccount(unsupported, { token: raw, new_password: 'unsupported-password-1' }, { clock }),
        /Atomic account recovery is unavailable/);
      assert.deepEqual(recoveryFacts(db), before);
    } finally { db.close(); }
  });
});

test('atomic recovery treats lost or malformed committed acknowledgements as uncertain and a spent retry cannot mutate', async (t) => {
  const faults = ['lost response', 'missing metadata', 'non-numeric changes', 'invalid winner count', 'missing batch results'];
  for (const fault of faults) {
    await t.test(fault, async () => {
      const { db, d1, clock, store } = await setup();
      try {
        const { user, input, expires_at } = await setupRecoveryFacts(store);
        const uncertain = createD1IdentityStore({ prepare: sql => d1.prepare(sql), exec: sql => d1.exec(sql),
          async batch(statements) {
            const committed = await d1.batch!(statements);
            assert.ok(Array.isArray(committed));
            if (fault === 'lost response') throw new Error('lost committed recovery response');
            if (fault === 'missing batch results') return [];
            return [fault === 'missing metadata' ? {} : { meta: { changes: fault === 'non-numeric changes' ? '1' : 2 } },
              ...committed.slice(1)];
          } }, { clock });
        await assert.rejects(uncertain.recoverAccountWithToken!(input),
          fault === 'lost response' ? /lost committed recovery response/ : /recovery acknowledgement is unavailable/);
        assert.equal((await store.findUserById(user.user_id))!.password_hash, 'winner-hash');
        assert.equal((await store.findEmailTokenByHash(await sha256HexText('real-sql-recovery-proof')))!.consumed_at,
          new Date(NOW).toISOString());
        await store.createSession({ user_id: user.user_id, token_sha256: 'ack-fresh-session', expires_at, last_team_id: null });
        await store.createMcpGrant({ user_id: user.user_id, team_id: null, client_id: 'client', token_sha256: 'ack-fresh-grant', expires_at });
        await store.createEmailToken({ user_id: user.user_id, purpose: 'recover_account', token_sha256: 'ack-fresh-proof', expires_at });
        const beforeRetry = recoveryFacts(db);
        assert.equal(await store.recoverAccountWithToken!({ ...input, password_hash: 'retry-hash' }), null);
        assert.deepEqual(recoveryFacts(db), beforeRetry);
      } finally { db.close(); }
    });
  }
});

test('atomic recovery winner depends on password admission even with zero session and grant revocations', async () => {
  const { db, store } = await setup();
  try {
    const { user, input } = await setupRecoveryFacts(store, false);
    const before = recoveryFacts(db);
    assert.equal(before[1]!.filter(row => row['user_id'] === user.user_id).length, 0);
    assert.equal(before[2]!.filter(row => row['user_id'] === user.user_id).length, 0);
    assert.deepEqual(await store.recoverAccountWithToken!(input), { user_id: user.user_id });
    assert.equal((await store.findUserById(user.user_id))!.password_hash, 'winner-hash');
    assert.deepEqual(recoveryFacts(db)[1], before[1]);
    assert.deepEqual(recoveryFacts(db)[2], before[2]);
    assert.equal((await store.findEmailTokenByHash('sibling-recovery'))!.consumed_at, new Date(NOW).toISOString());
  } finally { db.close(); }
});
