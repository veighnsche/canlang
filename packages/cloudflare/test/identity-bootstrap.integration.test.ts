/** Real D1 owner claim: account/team/membership publish atomically. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare } from 'miniflare';
import { it } from 'vitest';
import { bootstrapD1Owner, addD1TeamMember } from '../../identity/src/storage/bootstrap.js';
import { ensureIdentitySchema, type IdentityD1Database, type IdentityD1BoundStatement } from '../../identity/src/storage/d1.js';

import { createD1IdentityStore, createOpaqueToken, deriveCsrfToken, hashPassword, inviteMember, inviteMemberWithReceipt, acceptInvitation, setMemberRole } from '@canlang/identity';
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


it('serializes durable role deltas and preserves exact original receipts across lost acknowledgement and D1 reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-team-role-receipts-'));
  let runtime = new Miniflare(options(directory));
  try {
    let db = await runtime.getD1Database('IDENTITY');
    const owner = await bootstrapD1Owner(db, credentials);
    const member = await addD1TeamMember(db, { teamId: owner.teamId, email: 'role-member@example.invalid', password: 'Synthetic role password' });
    const clock = { nowMs: () => Date.parse('2026-10-24T00:00:00.000Z') };
    let store = createD1IdentityStore(db, { clock });
    const command = (role: string, operationId: string = randomUUID()) => ({ namespace: 'role-app', operationId,
      team_id: owner.teamId, member_user_id: member.userId, granted_by: owner.userId, role });
    const run = (input: ReturnType<typeof command>) => store.changeMemberRoleWithReceipt!(input);
    const current = () => store.findMembership(owner.teamId, member.userId);
    const names = async () => (await current())!.roles.map(grant => grant.role).sort();
    const [alpha, beta] = await Promise.all([run(command('Workspace.alpha')), run(command('Workspace.beta'))]);
    assert.deepEqual(await names(), ['Workspace.alpha', 'Workspace.beta'], 'concurrent grants preserve both deltas');
    assert.equal(alpha.membership.membership_id, beta.membership.membership_id);
    assert.equal(alpha.namespace, 'role-app'); assert.match(alpha.requestDigest, /^[a-f0-9]{64}$/);
    const originalBeta = (await current())!.roles.find(grant => grant.role === 'Workspace.beta');
    const repeatBeta = command('Workspace.beta');
    await run(repeatBeta);
    assert.deepEqual((await current())!.roles.find(grant => grant.role === 'Workspace.beta'), originalBeta,
      'idempotent grants retain the original attribution');
    const originalAlpha = { ...command('Workspace.alpha'), operationId: alpha.operationId };
    await Promise.all([run(command('-Workspace.alpha')), run(command('Workspace.gamma'))]);
    assert.deepEqual(await names(), ['Workspace.beta', 'Workspace.gamma']);
    assert.deepEqual(await run(originalAlpha), alpha, 'exact replay returns original technical outcome');
    assert.deepEqual(await store.readMemberRoleMutationReceipt!(originalAlpha), alpha);
    const unseen = command('Workspace.unseen');
    const receiptCount = (await db.prepare('SELECT * FROM identity_team_mutations').all()).results.length;
    assert.equal(await store.readMemberRoleMutationReceipt!(unseen), null);
    assert.equal((await db.prepare('SELECT * FROM identity_team_mutations').all()).results.length, receiptCount, 'receipt-only lookup never executes an unseen operation');
    assert.deepEqual(await names(), ['Workspace.beta', 'Workspace.gamma'], 'replay never reapplies a role');
    for (const changed of [{ role: '-Workspace.alpha' }, { member_user_id: owner.userId }, { granted_by: member.userId }, { team_id: 'other-team' }]) {
      await assert.rejects(run({ ...originalAlpha, ...changed }), error => error instanceof Error && 'code' in error && error.code === 'conflict');
    }
    const lostInput = command('Workspace.delta');
    const lostStore = createD1IdentityStore({ prepare: sql => db.prepare(sql), exec: sql => db.exec(sql),
      batch: async statements => { await db.batch(statements as Parameters<typeof db.batch>[0]); throw new Error('injected lost role acknowledgement'); } }, { clock });
    await lostStore.changeMemberRoleWithReceipt!(lostInput).catch(error => assert.match(String(error), /lost role acknowledgement/));
    assert.deepEqual(await names(), ['Workspace.beta', 'Workspace.delta', 'Workspace.gamma']);
    const recovered = await run(lostInput);
    await run(command('-Workspace.delta'));
    assert.deepEqual(await run(lostInput), recovered);
    assert.deepEqual(await names(), ['Workspace.beta', 'Workspace.gamma']);
    const historical = await setMemberRole(store,
      { team_id: owner.teamId, member_user_id: member.userId, role: 'Workspace.alpha' },
      { granted_by: owner.userId, occurrence: { namespace: originalAlpha.namespace, operationId: originalAlpha.operationId } });
    assert.deepEqual(historical, alpha.membership);
    await runtime.dispose(); runtime = new Miniflare(options(directory));
    db = await runtime.getD1Database('IDENTITY'); store = createD1IdentityStore(db, { clock });
    assert.deepEqual(await run(lostInput), recovered, 'original outcome survives physical D1 reopen');
    assert.deepEqual(await names(), ['Workspace.beta', 'Workspace.gamma']);
    const retainedMember = (await current())!;
    await store.removeMembership(retainedMember.membership_id);
    await store.reactivateMembership(retainedMember.membership_id, { is_owner: false, roles: retainedMember.roles });
    assert.deepEqual(await run(originalAlpha), alpha, 're-admission never turns an old occurrence into a new grant');
    assert.equal((await current())!.created_at, retainedMember.created_at);
    assert.deepEqual(await names(), ['Workspace.beta', 'Workspace.gamma']);
    const before = await current();
    const revokedOwner = (await store.findMembership(owner.teamId, owner.userId))!;
    // A second owner keeps the real last-owner guard intact while revoking the original actor.
    await store.setMembershipOwner(before!.membership_id, true);
    await store.removeMembership(revokedOwner.membership_id);
    assert.deepEqual(await run(originalAlpha), alpha, 'stored technical outcome grants no new authority');
    await assert.rejects(run(command('Workspace.unadmitted')), error => error instanceof Error && 'code' in error && error.code === 'forbidden');
    assert.deepEqual(await names(), ['Workspace.beta', 'Workspace.gamma']);
    await store.removeMembership(before!.membership_id).catch(error => assert.match(String(error), /at least one owner/));
    assert.equal((await current())!.status, 'active', 'last active owner remains protected');
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it('rolls back durable role claims with their writes and serializes competing owner demotions on real D1', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-team-role-atomic-'));
  const runtime = new Miniflare(options(directory));
  try {
    const db = await runtime.getD1Database('IDENTITY');
    const owner = await bootstrapD1Owner(db, credentials);
    const member = await addD1TeamMember(db, { teamId: owner.teamId, email: 'role-target@example.invalid', password: 'Synthetic target password' });
    const store = createD1IdentityStore(db);
    const input = { namespace: 'atomic-role-app', operationId: randomUUID(), team_id: owner.teamId,
      member_user_id: member.userId, granted_by: owner.userId, role: 'Workspace.reviewer' };
    const original = await store.findMembership(owner.teamId, member.userId);
    const interrupted = createD1IdentityStore({ prepare: sql => db.prepare(sql), exec: sql => db.exec(sql),
      batch: statements => db.batch([...(statements.slice(0, 2) as Parameters<typeof db.batch>[0]), db.prepare('INSERT INTO missing_role_table VALUES (1)')]) });
    await assert.rejects(interrupted.changeMemberRoleWithReceipt!(input));
    assert.deepEqual(await store.findMembership(owner.teamId, member.userId), original);
    assert.equal((await db.prepare('SELECT * FROM identity_team_mutations').all()).results.length, 0, 'failed transaction leaves no receipt claim');
    const committed = await store.changeMemberRoleWithReceipt!(input);
    assert.deepEqual(committed.membership.roles.map(grant => grant.role), ['Workspace.reviewer']);
    for (const candidate of [
      { ...input, operationId: randomUUID(), granted_by: member.userId },
      { ...input, operationId: randomUUID(), member_user_id: 'missing-member' },
      { ...input, operationId: randomUUID(), role: 'unqualified' },
    ]) await assert.rejects(store.changeMemberRoleWithReceipt!(candidate));
    let getterReads = 0;
    const accessor = { ...input, operationId: randomUUID() };
    Object.defineProperty(accessor, 'role', { enumerable: true, get() { getterReads++; return 'Workspace.reviewer'; } });
    await assert.rejects(store.changeMemberRoleWithReceipt!(accessor));
    assert.equal(getterReads, 0, 'command capture does not evaluate accessors');
    assert.equal((await db.prepare('SELECT * FROM identity_team_mutations').all()).results.length, 1, 'denials publish no successful receipts');
    await store.changeMemberRoleWithReceipt!({ ...input, operationId: randomUUID(), role: 'owner' });
    const demotions = await Promise.allSettled([
      store.changeMemberRoleWithReceipt!({ ...input, operationId: randomUUID(), member_user_id: owner.userId, granted_by: owner.userId, role: '-owner' }),
      store.changeMemberRoleWithReceipt!({ ...input, operationId: randomUUID(), granted_by: member.userId, role: '-owner' }),
    ]);
    assert.equal(demotions.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(demotions.filter(result => result.status === 'rejected').length, 1);
    assert.equal((await store.listActiveOwners(owner.teamId)).length, 1, 'competing self-demotions preserve one owner');
    const readonly = createD1IdentityStore({ prepare: sql => db.prepare(sql), exec: sql => db.exec(sql) });
    assert.equal(readonly.changeMemberRoleWithReceipt, undefined, 'nontransactional stores cannot expose this command');
    assert.deepEqual(await readonly.readMemberRoleMutationReceipt!(input), committed);
    assert.equal(await readonly.readMemberRoleMutationReceipt!({ ...input, operationId: randomUUID() }), null);
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);


/** A real local HTTP receiver; acknowledgement proves only this mail boundary. */
async function invitationMailReceiver() {
  const received: Array<{ to: string; subject: string; body_text: string }> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
    request.on('end', () => { received.push(JSON.parse(body)); response.writeHead(204); response.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address !== null && typeof address !== 'string');
  return { received,
    mail: { async sendMail(to: string, subject: string, body_text: string) {
      const response = await fetch(`http://127.0.0.1:${address.port}/mail`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to, subject, body_text }) });
      assert.equal(response.status, 204); await response.arrayBuffer();
    } },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())); },
  };
}

it('publishes one original invitation and mail intent, recovers lost publication acknowledgement and never retargets after D1 reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-invitation-receipts-'));
  const receiver = await invitationMailReceiver();
  let runtime = new Miniflare(options(directory));
  try {
    let db = await runtime.getD1Database('IDENTITY');
    const owner = await bootstrapD1Owner(db, credentials);
    const clock = { nowMs: () => Date.parse('2026-10-24T02:00:00.000Z') };
    let store = createD1IdentityStore(db, { clock });
    const input = { namespace: 'invitation-app', operationId: randomUUID(), team_id: owner.teamId,
      email: '  Invited@Example.invalid  ', role: 'Workspace.reviewer', invited_by: owner.userId };
    const config = { inviteBaseUrl: 'https://original.example/auth/invite' };
    const interrupted = createD1IdentityStore({ prepare: sql => db.prepare(sql), exec: sql => db.exec(sql),
      batch: statements => db.batch([...(statements.slice(0, 2) as Parameters<typeof db.batch>[0]), db.prepare('INSERT INTO missing_invitation_table VALUES (1)')]) }, { clock });
    await assert.rejects(interrupted.createInvitationWithReceipt!(input, config));
    for (const table of ['identity_invitations', 'identity_team_mutations', 'identity_invitation_mail']) {
      assert.equal((await db.prepare(`SELECT * FROM ${table}`).all()).results.length, 0, 'publication rolls back all three records');
    }
    const lost = createD1IdentityStore({ prepare: sql => db.prepare(sql), exec: sql => db.exec(sql),
      batch: async statements => { await db.batch(statements as Parameters<typeof db.batch>[0]); throw new Error('lost invitation publication acknowledgement'); } }, { clock });
    await assert.rejects(lost.createInvitationWithReceipt!(input, config), /lost invitation publication acknowledgement/);
    const original = await store.readInvitationMutationReceipt!(input); assert.ok(original);
    assert.equal(original.invitation.email, 'invited@example.invalid');
    assert.deepEqual(original.invitation.grants_roles, ['Workspace.reviewer']);
    assert.equal(original.invitation.grants_owner, false);
    assert.equal(await store.readInvitationMailState!(input), 'pending');
    assert.deepEqual(await store.createInvitationWithReceipt!(input, { inviteBaseUrl: 'invalid-new-configuration' }), original,
      'saved original publication does not reconstruct new configuration');
    const mutable = { ...input };
    const changesDuringPublication = { ...store, async createInvitationWithReceipt(
      raw: Parameters<NonNullable<typeof store.createInvitationWithReceipt>>[0], creationConfig: { inviteBaseUrl: string },
    ) {
      const receipt = await store.createInvitationWithReceipt!(raw, creationConfig);
      mutable.email = 'retargeted@example.invalid'; mutable.role = 'owner'; mutable.operationId = randomUUID();
      return receipt;
    } };
    const [a, b] = await Promise.all([
      inviteMemberWithReceipt(changesDuringPublication, receiver.mail, mutable, { inviteBaseUrl: 'https://replacement.example' }),
      inviteMemberWithReceipt(store, receiver.mail, { ...input, email: 'invited@example.invalid' }, config),
    ]);
    assert.equal(a.invitation_id, original.invitation.invitation_id); assert.equal(b.invitation_id, a.invitation_id);
    assert.ok(['acknowledged', 'unknown'].includes(a.mail)); assert.ok(['acknowledged', 'unknown'].includes(b.mail));
    assert.equal(receiver.received.length, 1, 'concurrent retries expose only one local send attempt');
    const message = receiver.received[0]!;
    assert.equal(message.to, 'invited@example.invalid');
    assert.ok(message.body_text.includes(`https://original.example/auth/invite?invitation_id=${a.invitation_id}`));
    assert.ok(!message.body_text.includes('replacement.example'));
    assert.ok(message.body_text.includes(original.invitation.expires_at), 'mail states the captured expiry');
    assert.equal(await store.readInvitationMailState!(input), 'acknowledged');
    for (const altered of [{ role: 'owner' }, { email: 'other@example.invalid' }, { invited_by: 'other-owner' }, { team_id: 'other-team' }]) {
      await assert.rejects(store.createInvitationWithReceipt!({ ...input, ...altered }, config),
        error => error instanceof Error && 'code' in error && error.code === 'conflict');
    }
    assert.equal(await store.readInvitationMutationReceipt!({ ...input, operationId: randomUUID() }), null);
    assert.equal((await db.prepare('SELECT * FROM identity_invitations').all()).results.length, 1);
    await runtime.dispose(); runtime = new Miniflare(options(directory));
    db = await runtime.getD1Database('IDENTITY'); store = createD1IdentityStore(db, { clock });
    assert.deepEqual(await store.readInvitationMutationReceipt!(input), original);
    assert.deepEqual(await inviteMemberWithReceipt(store, receiver.mail, input, config), { invitation_id: a.invitation_id, mail: 'acknowledged' });
    assert.equal(receiver.received.length, 1);
    const readonly = createD1IdentityStore({ prepare: sql => db.prepare(sql), exec: sql => db.exec(sql) }, { clock });
    assert.equal(readonly.createInvitationWithReceipt, undefined); assert.equal(readonly.claimInvitationMail, undefined);
    assert.deepEqual(await readonly.readInvitationMutationReceipt!(input), original);
    assert.equal(await readonly.readInvitationMailState!(input), 'acknowledged');
  } finally { await runtime.dispose(); await receiver.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it('preserves unknown mail attempts across faults and rechecks live invitation authority before an unclaimed send', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-invitation-mail-recovery-'));
  const receiver = await invitationMailReceiver();
  let runtime = new Miniflare(options(directory));
  try {
    let db = await runtime.getD1Database('IDENTITY');
    const owner = await bootstrapD1Owner(db, credentials);
    let at = Date.parse('2026-10-24T02:00:00.000Z'); const clock = { nowMs: () => at };
    let store = createD1IdentityStore(db, { clock });
    const config = { inviteBaseUrl: 'https://mail.example' };
    const command = (email: string) => ({ namespace: 'mail-app', operationId: randomUUID(), team_id: owner.teamId,
      email, role: 'Workspace.reviewer', invited_by: owner.userId });
    const lostClaimInput = command('lost-claim@example.invalid');
    await store.createInvitationWithReceipt!(lostClaimInput, config);
    const lost = createD1IdentityStore({ prepare: sql => db.prepare(sql), exec: sql => db.exec(sql),
      batch: async statements => { await db.batch(statements as Parameters<typeof db.batch>[0]); throw new Error('lost mail acknowledgement'); } }, { clock });
    const lostClaim = await inviteMemberWithReceipt(lost, receiver.mail, lostClaimInput, config);
    assert.equal(lostClaim.mail, 'unknown'); assert.equal(receiver.received.length, 0);
    assert.equal((await inviteMemberWithReceipt(store, receiver.mail, lostClaimInput, config)).mail, 'unknown');
    assert.equal(receiver.received.length, 0, 'lost claim cannot be assumed unsent');
    const acceptedInput = command('accepted-unknown@example.invalid');
    const ambiguousMail = { async sendMail(to: string, subject: string, body: string) {
      await receiver.mail.sendMail(to, subject, body); throw new Error('lost receiver response');
    } };
    const ambiguous = await inviteMemberWithReceipt(store, ambiguousMail, acceptedInput, config);
    assert.equal(ambiguous.mail, 'unknown'); assert.equal(receiver.received.length, 1);
    assert.equal((await inviteMemberWithReceipt(store, receiver.mail, acceptedInput, config)).mail, 'unknown');
    assert.equal(receiver.received.length, 1, 'provider-side receipt plus lost acknowledgement never triggers a duplicate');
    const ackInput = command('lost-local-ack@example.invalid');
    await store.createInvitationWithReceipt!(ackInput, config);
    const lostAck = { ...store, acknowledgeInvitationMail: lost.acknowledgeInvitationMail!.bind(lost) };
    assert.equal((await inviteMemberWithReceipt(lostAck, receiver.mail, ackInput, config)).mail, 'acknowledged');
    assert.equal(receiver.received.length, 2, 'lost local ack is observed from durable state');
    const pendingInput = command('pending-owner@example.invalid');
    await store.createInvitationWithReceipt!(pendingInput, config);
    const second = await addD1TeamMember(db, { teamId: owner.teamId, email: 'second-owner@example.invalid', password: 'Synthetic second password' });
    await store.setMembershipOwner((await store.findMembership(owner.teamId, second.userId))!.membership_id, true);
    await assert.rejects(store.createInvitationWithReceipt!(command('second-owner@example.invalid'), config),
      'an active addressed membership cannot receive a new grant offer');
    const principal = (await store.findMembership(owner.teamId, owner.userId))!;
    await store.removeMembership(principal.membership_id);
    assert.deepEqual(await store.claimInvitationMail!(pendingInput), { state: 'pending' });
    assert.equal(receiver.received.length, 2);
    await assert.rejects(store.createInvitationWithReceipt!(command('denied-owner@example.invalid'), config));
    await store.reactivateMembership(principal.membership_id, { is_owner: true, roles: [] });
    const claimed = await store.claimInvitationMail!(pendingInput); assert.ok(claimed.attempt);
    await assert.rejects(store.acknowledgeInvitationMail!(pendingInput, 'wrong-attempt'));
    const original = await store.readInvitationMutationReceipt!(pendingInput); assert.ok(original);
    await store.revokeInvitation(original.invitation.invitation_id);
    assert.equal(await store.acknowledgeInvitationMail!(pendingInput, claimed.attempt.token), 'acknowledged',
      'late acknowledgement concerns only the old attempt, never restores the revoked offer');
    const revokedInput = command('revoked-pending@example.invalid');
    const revoked = await store.createInvitationWithReceipt!(revokedInput, config);
    await store.revokeInvitation(revoked.invitation.invitation_id);
    assert.deepEqual(await store.claimInvitationMail!(revokedInput), { state: 'cancelled' });
    const expiresInput = command('expires-pending@example.invalid');
    const expires = await store.createInvitationWithReceipt!(expiresInput, config);
    at = Date.parse(expires.invitation.expires_at);
    assert.deepEqual(await store.claimInvitationMail!(expiresInput), { state: 'cancelled' });
    assert.equal((await inviteMemberWithReceipt(store, receiver.mail, acceptedInput, config)).mail, 'unknown', 'expiry never cancels an unknown effect');
    assert.equal(receiver.received.length, 2);
    at -= 1000;
    const addressed = command('addressed@example.invalid');
    const offer = await store.createInvitationWithReceipt!(addressed, config);
    const invited = await store.createUser({ email: addressed.email, password_hash: 'unused', email_verified: true });
    await acceptInvitation(store, { invitation_id: offer.invitation.invitation_id, user_id: invited.user_id }, { clock });
    assert.equal((await inviteMemberWithReceipt(store, receiver.mail, addressed, config)).mail, 'cancelled');
    assert.deepEqual(await store.readInvitationMutationReceipt!(addressed), offer, 'acceptance never rewrites the original receipt');
    assert.equal(receiver.received.length, 2);
    await runtime.dispose(); runtime = new Miniflare(options(directory));
    db = await runtime.getD1Database('IDENTITY'); store = createD1IdentityStore(db, { clock });
    assert.equal(await store.readInvitationMailState!(acceptedInput), 'unknown');
    assert.equal((await store.claimInvitationMail!(acceptedInput)).attempt, undefined);
    assert.equal(receiver.received.length, 2);
  } finally { await runtime.dispose(); await receiver.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
