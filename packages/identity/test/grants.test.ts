/**
 * MCP grant issuance: mint once, resolve via the verified constructor,
 * revoke like any other binding.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IdentityError } from '../src/ports.js';
import {
  createFrozenClock,
  createMemoryIdentityStore,
} from '../src/testing.js';
import { hashPassword } from '../src/accounts/passwords.js';
import { resolveIdentity } from '../src/authentication/context.js';
import { issueMcpGrant, MCP_GRANT_TTL_MS } from '../src/authentication/grants.js';
import { revokeMcpGrantByToken } from '../src/authentication/revocation.js';

const NOW = Date.parse('2026-10-04T15:00:00.000Z');

async function setup() {
  const clock = createFrozenClock(NOW);
  const store = createMemoryIdentityStore({ clock });
  const user = await store.createUser({
    email: 'mcp@test.example',
    password_hash: await hashPassword('s3cure-password'),
    email_verified: true,
  });
  const team = await store.createTeam({});
  await store.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: [] });
  return { clock, store, user, team };
}

test('issued grant resolves the same principal as a session', async () => {
  const { clock, store, user, team } = await setup();
  const { token, grant } = await issueMcpGrant(
    store,
    { user_id: user.user_id, team_id: team.team_id, client_id: 'test-client' },
    { clock },
  );
  assert.equal(grant.user_id, user.user_id);
  assert.equal(grant.team_id, team.team_id);
  assert.equal(grant.expires_at, new Date(NOW + MCP_GRANT_TTL_MS).toISOString());
  const identity = await resolveIdentity(store, { mcp_grant_token: token }, { clock });
  assert.equal(identity.actor?.user_id, user.user_id);
  assert.equal(identity.team?.team_id, team.team_id);
  assert.equal(identity.binding.kind, 'mcp_grant');
});

test('issued grant stops resolving after revocation', async () => {
  const { clock, store, user, team } = await setup();
  const { token } = await issueMcpGrant(
    store,
    { user_id: user.user_id, team_id: team.team_id, client_id: 'test-client' },
    { clock },
  );
  await revokeMcpGrantByToken(store, { token });
  await assert.rejects(
    () => resolveIdentity(store, { mcp_grant_token: token }, { clock }),
    (error: unknown) => error instanceof IdentityError && error.code === 'forbidden',
  );
});

test('empty client_id is rejected', async () => {
  const { clock, store, user, team } = await setup();
  await assert.rejects(
    () => issueMcpGrant(store, { user_id: user.user_id, team_id: team.team_id, client_id: '  ' }, { clock }),
    (error: unknown) => error instanceof IdentityError && error.code === 'validation',
  );
});
