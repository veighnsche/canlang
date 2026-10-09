/** Actual local workerd D1 check for the bounded joined team discovery path. */
import { Miniflare } from 'miniflare';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1IdentityStore, ensureIdentitySchema, sha256HexText } from '@canlang/identity';
import type { IdentityD1Database } from '@canlang/identity';
import { handleAuthRequest } from '@canlang/interfaces';
import { createTestDeps, testRequest } from '@canlang/interfaces/testing';

test('real D1 discovery pages 205 active memberships with constant query budget', async () => {
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: '2026-07-15', d1Databases: ['DB'] });
  try {
    const db: IdentityD1Database = await mf.getD1Database('DB');
    await ensureIdentitySchema(db);
    const queries: string[] = [];
    const observed: IdentityD1Database = {
      prepare(sql) { queries.push(sql); return db.prepare(sql); },
      exec(sql) { return db.exec(sql); },
    };
    const store = createD1IdentityStore(observed);
    const user = await store.createUser({ email: 'pages@test.example', password_hash: 'unused', email_verified: true });
    const expected: Array<{ team_id: string; timezone: string }> = [];
    for (let index = 0; index < 205; index += 1) {
      const team = await store.createTeam({ timezone: index % 2 === 0 ? 'UTC' : 'Europe/Brussels' });
      await store.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
      expected.push({ team_id: team.team_id, timezone: team.timezone });
    }
    const removedTeam = await store.createTeam({});
    const removed = await store.createMembership({ team_id: removedTeam.team_id, user_id: user.user_id, is_owner: false, roles: [] });
    await store.removeMembership(removed.membership_id);
    const danglingTeam = await store.createTeam({});
    await store.createMembership({ team_id: danglingTeam.team_id, user_id: user.user_id, is_owner: false, roles: [] });
    await db.prepare('DELETE FROM identity_teams WHERE team_id = ?').bind(danglingTeam.team_id).run();
    const foreign = await store.createUser({ email: 'foreign@test.example', password_hash: 'unused', email_verified: true });
    const foreignTeam = await store.createTeam({});
    await store.createMembership({ team_id: foreignTeam.team_id, user_id: foreign.user_id, is_owner: false, roles: [] });
    const token = 'a'.repeat(43);
    const session = await store.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      expires_at: new Date(Date.now() + 3600000).toISOString(), last_team_id: expected[0]!.team_id });
    const t = await createTestDeps();
    const deps = { ...t.deps, identity: { ...t.deps.identity, store } };
    let after: string | null = null;
    const seen: Array<{ team_id: string; timezone: string }> = [];
    const pageSizes: number[] = [];
    do {
      queries.length = 0;
      const response = await handleAuthRequest(deps, testRequest(after === null ? '/auth/teams' : `/auth/teams?after=${after}`,
        { method: 'GET', cookie: `can_session=${token}` }));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json() as { teams: Array<{ team_id: string; timezone: string }>; truncated: boolean; next_after: string | null };
      // Actual prepared queries executed against workerd D1: session, user,
      // selected team, membership, and the single bounded team join.
      assert.equal(queries.length, 5, `unexpected D1 query budget: ${queries.join('; ')}`);
      assert.equal(queries.filter(sql => sql.includes('INNER JOIN identity_teams')).length, 1);
      assert.ok(body.teams.length > 0 && body.teams.length <= 100);
      assert.equal(body.truncated, body.next_after !== null);
      if (body.truncated) assert.equal(body.next_after, body.teams.at(-1)!.team_id);
      seen.push(...body.teams);
      pageSizes.push(body.teams.length);
      after = body.next_after;
    } while (after !== null);
    assert.deepEqual(pageSizes, [100, 100, 5]);
    assert.deepEqual(seen, expected.sort((a, b) => a.team_id < b.team_id ? -1 : a.team_id > b.team_id ? 1 : 0));
    assert.equal(new Set(seen.map(team => team.team_id)).size, 205);
    await store.revokeSession(session.session_id);
    const revoked = await handleAuthRequest(deps, testRequest('/auth/teams', { cookie: `can_session=${token}` }));
    assert.equal(revoked.status, 403);
  } finally { await mf.dispose(); }
});
