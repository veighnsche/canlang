import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64UrlToBytes, bytesToBase64Url } from '@canlang/identity';
import { sha256HexText } from '@canlang/identity';
import { createMemoryIdentityStore } from '@canlang/identity/testing';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { FIXED_NOW, asOperationId, makeIdentity, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import type { CompileArtifact } from '@canlang/contracts';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assembleModules } from './modules.js';
import { buildInvoker } from '../worker/assembly.js';
import { queryPageRowsCanonical } from './invoke.js';
import { createPageCursorCodec } from './page-cursor.js';

const hostKey = new Uint8Array(32).fill(77);
const binding = 'a'.repeat(64);
const now = 1_800_000_000_000;
const lifetime = 15 * 60 * 1_000;
const position = { revision: 7, after: 'visible-row-é😀' };

async function signed(text: string | Uint8Array): Promise<string> {
  const payload = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  const key = await globalThis.crypto.subtle.importKey('raw', hostKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await globalThis.crypto.subtle.sign('HMAC', key, payload.slice());
  return `${bytesToBase64Url(payload)}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

test('page cursor transports only a bound visible position and expires at its finite lease', async () => {
  const mutableKey = hostKey.slice();
  const encoder = await createPageCursorCodec(mutableKey);
  mutableKey.fill(78);
  const decoder = await createPageCursorCodec(bytesToBase64Url(hostKey));
  const token = await encoder.encode(binding, position, now);
  const expected = { status: 'valid', bindingDigest: binding, position };
  assert.deepEqual(await decoder.decode(token, now), expected);
  assert.deepEqual(await decoder.decode(token, now + lifetime - 1), expected);
  assert.deepEqual(await decoder.decode(token, now + lifetime), { status: 'stale' });
  assert.deepEqual(await decoder.decode(token, now - 1), { status: 'stale' });
  const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(token.split('.')[0]!)!));
  assert.deepEqual(payload, ['can-page-cursor', 1, binding, 7, position.after, now, now + lifetime]);
  const otherContext = await encoder.encode('b'.repeat(64), position, now);
  assert.notEqual(otherContext, token);
  assert.deepEqual(await decoder.decode(otherContext, now), { ...expected, bindingDigest: 'b'.repeat(64) });
  const otherHost = await createPageCursorCodec(new Uint8Array(32).fill(78));
  assert.deepEqual(await otherHost.decode(token, now), { status: 'invalid' });
});

test('page cursor rejects tampering, alias encodings and cross-domain canonical signed payloads', async () => {
  const codec = await createPageCursorCodec(hostKey);
  const token = await codec.encode(binding, position, now);
  const [payload, signature] = token.split('.') as [string, string];
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alias = signature.slice(0, -1) + alphabet[alphabet.indexOf(signature.at(-1)!) + 1];
  assert.deepEqual(base64UrlToBytes(alias), base64UrlToBytes(signature));
  assert.deepEqual(await codec.decode(`${payload}.${alias}`, now), { status: 'invalid' });
  assert.deepEqual(await codec.decode(`${payload}.${signature.slice(1)}`, now), { status: 'invalid' });
  assert.deepEqual(await codec.decode('not.a.valid.token', now), { status: 'invalid' });
  for (const tuple of [
    ['can-source-form-binding', 1, binding, 7, position.after, now, now + lifetime],
    ['can-page-cursor', 2, binding, 7, position.after, now, now + lifetime],
    ['can-page-cursor', 1, binding, 7, position.after, now, now + lifetime, 'extra'],
    ['can-page-cursor', 1, binding, -1, position.after, now, now + lifetime],
    ['can-page-cursor', 1, binding, 7, '', now, now + lifetime],
    ['can-page-cursor', 1, binding, 7, position.after, now, now + lifetime + 1],
    ['can-page-cursor', 1, binding, 7, position.after, null, now + lifetime],
  ]) assert.deepEqual(await codec.decode(await signed(JSON.stringify(tuple)), now), { status: 'invalid' });
  assert.deepEqual(await codec.decode(await signed(` ${JSON.stringify(['can-page-cursor', 1, binding, 7, position.after, now, now + lifetime])}`), now), { status: 'invalid' });
  assert.deepEqual(await codec.decode(await signed(new Uint8Array([0xc3, 0x28])), now), { status: 'invalid' });
});

test('page cursor requires canonical host keys, bounded tokens and checked scalar inputs', async () => {
  await assert.rejects(createPageCursorCodec(new Uint8Array(31)), TypeError);
  await assert.rejects(createPageCursorCodec('not-base64url!'), TypeError);
  const encoded = bytesToBase64Url(hostKey), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const keyAlias = encoded.slice(0, -1) + alphabet[alphabet.indexOf(encoded.at(-1)!) + 1];
  await assert.rejects(createPageCursorCodec(keyAlias), TypeError);
  const codec = await createPageCursorCodec(hostKey);
  assert.deepEqual(await codec.decode('x'.repeat(4_097), now), { status: 'invalid' });
  await assert.rejects(codec.encode(binding, { ...position, after: 'x'.repeat(4_096) }, now), TypeError);
  for (const bad of ['', 'a'.repeat(63), 'A'.repeat(64)]) await assert.rejects(codec.encode(bad, position, now), TypeError);
  for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(codec.encode(binding, { ...position, revision }, now), TypeError);
  }
  for (const clock of [-1, 1.5, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(codec.encode(binding, position, clock), TypeError);
    await assert.rejects(codec.decode('invalid', clock), TypeError);
  }
});

test('explicit hosted page reads bind current query, caller decisions and occurrence before final authority checks', async () => {
  const path = resolve('packages/cloudflare/test/fixtures/typed-authorized-reads.json');
  const artifact = JSON.parse(await readFile(path, 'utf8')) as CompileArtifact;
  const dir = await mkdtemp(join(tmpdir(), 'can-hosted-page-'));
  const app = 'TypedAuthorizedReads', model = `${app}.Entry`;
  const identities = createMemoryIdentityStore({ clock: { nowMs: () => FIXED_NOW } });
  const team = await identities.createTeam({ timezone: 'UTC' });
  const owner = await identities.createUser({ email: 'page-owner@example.test', email_verified: true, password_hash: 'unused' });
  const viewer = await identities.createUser({ email: 'page-viewer@example.test', email_verified: true, password_hash: 'unused' });
  const ownerMember = await identities.createMembership({ team_id: team.team_id, user_id: owner.user_id, is_owner: true, roles: [] });
  const viewerMember = await identities.createMembership({ team_id: team.team_id, user_id: viewer.user_id, is_owner: false,
    roles: [{ role: `${app}.auditor`, granted_at: new Date(FIXED_NOW).toISOString(), granted_by: owner.user_id }] });
  const identity = makeIdentity({ membership: viewerMember, team, email: viewer.email });
  try {
    const asm = await assembleModules({ artifact, sourcePath: path }, { workDir: join(dir, 'modules'),
      stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
    // This isolated memory store is the explicitly supplied test host binding; no deployed routing claim.
    const { store } = createTestMemoryStorage();
    const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => FIXED_NOW });
    for (let sequence = 1; sequence <= 3; sequence++) {
      const outcome = await invoker.invokeMutation({ operation: `${model}.create`, inputs: { count: String(sequence) },
        operation_id: asOperationId(uuidv7(FIXED_NOW, sequence)) }, makeIdentity({ membership: ownerMember, team, email: owner.email }));
      assert.ok('result' in outcome); assert.equal(outcome.result.status, 'committed');
    }
    const cursors = await createPageCursorCodec(hostKey);
    const binding = { scope: { app, owner: team.team_id, ownerPackage: app },
      sourceIdentity: await sha256HexText(JSON.stringify(artifact.sources.map(source => [source.path, source.sha256]))), cursors };
    const opts = { artifact, asm, store, identity, memberships: identities, model, now: () => FIXED_NOW, pageReads: binding };
    const args = { page: true as const, occurrence: 'hosted-collection-one', limit: 1 };
    const first = await queryPageRowsCanonical({ ...opts, args });
    assert.equal(first.rows.length, 1); assert.ok(first.nextCursor);
    assert.deepEqual(Object.keys(first.rows[0]!.fields), ['count']);
    const second = await queryPageRowsCanonical({ ...opts, args: { ...args, cursor: first.nextCursor } });
    assert.equal(second.rows.length, 1); assert.ok(second.nextCursor);
    assert.notEqual(second.rows[0]!.id, first.rows[0]!.id);
    const third = await queryPageRowsCanonical({ ...opts, args: { ...args, cursor: second.nextCursor } });
    assert.equal(third.rows.length, 1); assert.equal(third.nextCursor, undefined);
    assert.equal(new Set([...first.rows, ...second.rows, ...third.rows].map(row => row.id)).size, 3);
    const refuses = (code: string) => (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === code;
    await assert.rejects(queryPageRowsCanonical({ ...opts, args: { occurrence: args.occurrence, limit: 1 } }), refuses('validation'));
    const { pageReads: _binding, ...unboundOpts } = opts;
    void _binding;
    await assert.rejects(queryPageRowsCanonical({ ...unboundOpts, args }), refuses('validation'));
    await assert.rejects(queryPageRowsCanonical({ ...opts, args: { cursor: first.nextCursor } }), refuses('validation'));
    await assert.rejects(queryPageRowsCanonical({ ...opts, args: { ...args, occurrence: 'hosted-collection-two', cursor: first.nextCursor } }), refuses('conflict'));
    await assert.rejects(queryPageRowsCanonical({ ...opts, args: { ...args, limit: 2, cursor: first.nextCursor } }), refuses('conflict'));
    const noKey = { scope: binding.scope, sourceIdentity: binding.sourceIdentity };
    await assert.rejects(queryPageRowsCanonical({ ...opts, pageReads: noKey, args }), refuses('validation'));
    assert.equal((await queryPageRowsCanonical({ ...opts, pageReads: noKey, args: { ...args, limit: 3 } })).rows.length, 3);
    const revision = await store.readRevision();
    await identities.setMembershipOwner(viewerMember.membership_id, true);
    await assert.rejects(queryPageRowsCanonical({ ...opts, args: { ...args, cursor: first.nextCursor } }), refuses('conflict'));
    assert.equal(await store.readRevision(), revision, 'changed relevant read grants restart even at the same State revision');
    await identities.setMembershipOwner(viewerMember.membership_id, false);
    const revoking = { ...binding, cursors: { ...cursors, async encode(...input: Parameters<typeof cursors.encode>) {
      const token = await cursors.encode(...input);
      await identities.setMembershipRoles(viewerMember.membership_id, []);
      return token;
    } } };
    await assert.rejects(queryPageRowsCanonical({ ...opts, pageReads: revoking, args }), refuses('forbidden'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
