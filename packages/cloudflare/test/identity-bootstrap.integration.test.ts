/** Real D1 owner claim: account/team/membership publish atomically. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { it } from 'vitest';
import { bootstrapD1Owner, addD1TeamMember } from '../../identity/src/storage/bootstrap.js';
import { ensureIdentitySchema, type IdentityD1Database, type IdentityD1BoundStatement } from '../../identity/src/storage/d1.js';

import { createD1IdentityStore, createOpaqueToken, deriveCsrfToken, hashPassword, inviteMember } from '@canlang/identity';
import { handleAuthRequest, type AuthHttpDeps } from '@canlang/interfaces';

const credentials = { email: 'owner@example.invalid', password: 'Synthetic bootstrap password', timezone: 'Europe/Amsterdam' };
const options = (directory: string) => ({ modules: true, script: 'export default {fetch(){return new Response("bootstrap test")}}',
  d1Databases: { IDENTITY: 'bootstrap-proof' }, d1Persist: directory });
async function snapshot(db: IdentityD1Database) {
  const result: Record<string, unknown> = {};
  for (const table of ['identity_bootstrap_claim', 'identity_users', 'identity_teams', 'identity_memberships']) {
    result[table] = (await db.prepare(`SELECT * FROM ${table}`).bind().all()).results;
  }
  return result;
}

it('recovers an actual committed batch after lost acknowledgement and retained-storage reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-owner-bootstrap-'));
  let runtime = new Miniflare(options(directory));
  try {
    const db = await runtime.getD1Database('IDENTITY');
    const lost: IdentityD1Database = {
      prepare: sql => db.prepare(sql), exec: sql => db.exec(sql),
      batch: async statements => { await db.batch(statements as Parameters<typeof db.batch>[0]); throw new Error('injected lost acknowledgement'); },
    };
    const first = await bootstrapD1Owner(lost, credentials);
    const before = await snapshot(db);
    assert.equal((before.identity_users as unknown[]).length, 1);
    assert.equal((before.identity_teams as unknown[]).length, 1);
    assert.equal((before.identity_memberships as unknown[]).length, 1);
    const owner = (before.identity_users as Array<Record<string, unknown>>)[0]!;
    assert.equal(owner.email_verified, 1); assert.notEqual(owner.password_hash, credentials.password);
    await runtime.dispose(); runtime = new Miniflare(options(directory));
    const reopened = await runtime.getD1Database('IDENTITY');
    assert.deepEqual(await bootstrapD1Owner(reopened, credentials), first);
    await assert.rejects(bootstrapD1Owner(reopened, { ...credentials, password: 'Different synthetic password' }), /different credentials/);
    await assert.rejects(bootstrapD1Owner(reopened, { ...credentials, email: 'other@example.invalid' }), /different credentials/);
    await assert.rejects(bootstrapD1Owner(reopened, { ...credentials, timezone: 'UTC' }), /different credentials/);
    assert.deepEqual(await snapshot(reopened), before);
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it('rolls back a batch failure and refuses populated unclaimed identity data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-owner-rollback-'));
  const runtime = new Miniflare(options(directory));
  try {
    const db = await runtime.getD1Database('IDENTITY');
    const interrupted: IdentityD1Database = {
      prepare: sql => db.prepare(sql), exec: sql => db.exec(sql),
      batch: async (statements: IdentityD1BoundStatement[]) => db.batch([
        ...(statements.slice(0, 3) as Parameters<typeof db.batch>[0]),
        db.prepare('INSERT INTO missing_bootstrap_table VALUES (1)'),
      ]),
    };
    await assert.rejects(bootstrapD1Owner(interrupted, credentials), /transaction did not complete/);
    for (const rows of Object.values(await snapshot(db))) assert.deepEqual(rows, []);
    await db.prepare('INSERT INTO identity_oauth_clients VALUES (?, ?, ?, ?)')
      .bind('unclaimed-client', 'Existing client', '[]', '2026-10-14T00:00:00.000Z').run();
    await assert.rejects(bootstrapD1Owner(db, credentials), /populated/);
    for (const rows of Object.values(await snapshot(db))) assert.deepEqual(rows, []);
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it('serializes competing genuine D1 claims and refuses a nontransactional port before schema writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-owner-race-'));
  const runtime = new Miniflare(options(directory));
  try {
    const db = await runtime.getD1Database('IDENTITY');
    await ensureIdentitySchema(db);
    const competing = await Promise.allSettled([
      bootstrapD1Owner(db, credentials),
      bootstrapD1Owner(db, { ...credentials, email: 'competing@example.invalid' }),
    ]);
    assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(competing.filter(result => result.status === 'rejected').length, 1);
    for (const rows of Object.values(await snapshot(db))) assert.equal((rows as unknown[]).length, 1);
    let schemaCalls = 0;
    await assert.rejects(bootstrapD1Owner({ prepare: sql => db.prepare(sql), exec: async () => { schemaCalls++; } }, credentials), /transactional D1/);
    assert.equal(schemaCalls, 0);
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it('adds a member atomically without resetting accounts or elevating membership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-member-admin-'));
  const runtime = new Miniflare(options(directory));
  try {
    const db = await runtime.getD1Database('IDENTITY');
    const owner = await bootstrapD1Owner(db, credentials);
    const input = { teamId: owner.teamId, email: 'member@example.invalid', password: 'Synthetic member password' };
    const lost: IdentityD1Database = { prepare: sql => db.prepare(sql), exec: sql => db.exec(sql),
      batch: async statements => { await db.batch(statements as Parameters<typeof db.batch>[0]); throw new Error('injected lost acknowledgement'); } };
    const member = await addD1TeamMember(lost, input);
    const before = await snapshot(db);
    assert.equal((before.identity_users as unknown[]).length, 2);
    const saved = (before.identity_memberships as Array<Record<string, unknown>>).find(row => row.user_id === member.userId)!;
    assert.equal(saved.is_owner, 0); assert.equal(saved.roles, '[]'); assert.equal(saved.status, 'active');
    assert.deepEqual(await addD1TeamMember(db, input), member);
    await assert.rejects(addD1TeamMember(db, { ...input, password: 'Different synthetic password' }), /different credentials/);
    await assert.rejects(addD1TeamMember(db, { ...input, teamId: 'missing-team' }), /claimed team/);
    assert.deepEqual(await snapshot(db), before);
    const interrupted: IdentityD1Database = { prepare: sql => db.prepare(sql), exec: sql => db.exec(sql),
      batch: statements => db.batch([...(statements.slice(0, 1) as Parameters<typeof db.batch>[0]), db.prepare('INSERT INTO missing_member_table VALUES (1)')]) };
    await assert.rejects(addD1TeamMember(interrupted, { ...input, email: 'rollback@example.invalid' }), /transaction did not complete/);
    assert.deepEqual(await snapshot(db), before);
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);


it('accepts only an addressed verified invitation through browser CSRF and retains its exact ceiling on real D1 reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-invitation-http-'));
  let runtime = new Miniflare(options(directory));
  try {
    let db = await runtime.getD1Database('IDENTITY');
    const owner = await bootstrapD1Owner(db, credentials);
    const clock = { nowMs: () => Date.now() };
    let store = createD1IdentityStore(db, { clock });
    const messages: string[] = [];
    const mail = { sendMail: async (_to: string, _subject: string, body: string) => { messages.push(body); } };
    const deps = (): AuthHttpDeps => ({ identity: { store, mail, clock,
      verifyBaseUrl: 'https://app.example/auth/verify', recoveryBaseUrl: 'https://app.example/auth/recover',
      inviteBaseUrl: 'https://app.example', sessionMaxAgeSeconds: 3600 },
      clock, secureCookies: false, authOrigin: 'https://app.example',
      logger: { log() {} }, limiter: { check: async () => { throw new Error('Invitation acceptance does not use public authentication throttles.'); } } });
    const session = async (userId: string) => {
      const { token, token_sha256 } = await createOpaqueToken();
      await store.createSession({ user_id: userId, token_sha256,
        expires_at: new Date(clock.nowMs() + 3600_000).toISOString(), last_team_id: null });
      return { cookie: `can_session=${encodeURIComponent(token)}`, csrf: await deriveCsrfToken(token) };
    };
    const passwordHash = await hashPassword('Synthetic invitation password');
    const invited = await store.createUser({ email: 'invited@example.invalid', password_hash: passwordHash, email_verified: true });
    const recipient = await session(invited.user_id), wrongActor = await session(owner.userId);
    const offer = await inviteMember(store, mail,
      { team_id: owner.teamId, email: invited.email, role: 'Selected.reviewer' },
      { invited_by: owner.userId, inviteBaseUrl: 'https://app.example', clock });
    assert.ok(messages.at(-1)?.includes(`/auth/invite?invitation_id=${offer.invitation_id}`));
    const request = (actor: typeof recipient, body: Record<string, unknown>, csrf = actor.csrf, html = false) =>
      new Request('https://app.example/auth/invite', { method: 'POST', headers: {
        origin: 'https://app.example', cookie: actor.cookie,
        ...(html ? { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' }
          : { 'content-type': 'application/json' }), 'x-csrf-token': csrf },
        body: html ? new URLSearchParams(Object.entries(body).map(([key, value]): [string, string] => [key, String(value)])).toString() : JSON.stringify(body) });
    const body = { invitation_id: offer.invitation_id };
    const readOffer = async () => await store.findInvitationById(offer.invitation_id);
    const original = await readOffer();
    const descriptor = await handleAuthRequest(deps(), new Request(`https://app.example/auth/invite?invitation_id=${offer.invitation_id}`, {
      headers: { cookie: recipient.cookie, accept: 'text/html' } }));
    assert.equal(descriptor.status, 200);
    assert.equal(descriptor.headers.get('cache-control'), 'no-store');
    const html = await descriptor.text();
    assert.ok(html.includes('action="/auth/invite"') && html.includes(offer.invitation_id) && html.includes(recipient.csrf));
    assert.deepEqual(await readOffer(), original, 'GET never accepts or alters the invitation');
    assert.equal((await handleAuthRequest(deps(), request(recipient, body, 'wrong-csrf'))).status, 403);
    assert.equal((await handleAuthRequest(deps(), request(wrongActor, body))).status, 403);
    assert.ok((await handleAuthRequest(deps(), request(recipient, { ...body, user_id: owner.userId }))).status >= 400);
    await store.setUserEmailVerified(invited.user_id, false);
    assert.equal((await handleAuthRequest(deps(), request(recipient, body))).status, 403);
    await store.setUserEmailVerified(invited.user_id, true);
    const expired = await inviteMember(store, mail, { team_id: owner.teamId, email: invited.email, role: 'owner' },
      { invited_by: owner.userId, inviteBaseUrl: 'https://app.example', clock, inviteExpiresMs: -1 });
    const revoked = await inviteMember(store, mail, { team_id: owner.teamId, email: invited.email, role: 'owner' },
      { invited_by: owner.userId, inviteBaseUrl: 'https://app.example/auth/invite', clock });
    assert.ok(messages.at(-1)?.includes(`https://app.example/auth/invite?invitation_id=${revoked.invitation_id}\n`));
    assert.ok(!messages.at(-1)?.includes('/auth/invite/auth/invite'));
    await store.revokeInvitation(revoked.invitation_id);
    for (const denied of [expired, revoked]) {
      assert.ok((await handleAuthRequest(deps(), request(recipient, { invitation_id: denied.invitation_id }))).status >= 400);
      assert.equal((await store.findInvitationById(denied.invitation_id))?.accepted_at, null);
    }
    assert.equal(await store.findMembership(owner.teamId, invited.user_id), null);
    assert.deepEqual(await readOffer(), original, 'all refused submissions leave the valid offer untouched');
    const attempts = await Promise.all([
      handleAuthRequest(deps(), request(recipient, body, recipient.csrf, true)),
      handleAuthRequest(deps(), request(recipient, body)),
    ]);
    assert.equal(attempts.filter(response => response.status === 200 || response.status === 303).length, 1);
    assert.equal(attempts.filter(response => response.status >= 400).length, 1);
    const browserWinner = attempts.find(response => response.status === 303);
    if (browserWinner !== undefined) assert.equal(browserWinner.headers.get('location'), '/auth/select-team');
    const accepted = await store.findMembership(owner.teamId, invited.user_id);
    assert.ok(accepted !== null && accepted.status === 'active' && !accepted.is_owner);
    assert.deepEqual(accepted.roles.map(grant => grant.role), ['Selected.reviewer']);
    const acceptedOffer = await readOffer();
    assert.ok(acceptedOffer !== null && acceptedOffer.accepted_at !== null);
    await runtime.dispose(); runtime = new Miniflare(options(directory));
    db = await runtime.getD1Database('IDENTITY'); store = createD1IdentityStore(db, { clock });
    assert.deepEqual(await store.findMembership(owner.teamId, invited.user_id), accepted);
    assert.deepEqual(await readOffer(), acceptedOffer);
    assert.ok((await handleAuthRequest(deps(), request(recipient, body))).status >= 400, 'consumed offer refuses after reopen');
    assert.deepEqual(await store.findMembership(owner.teamId, invited.user_id), accepted);
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
