/** A declared read scenario selects only rows admitted by the current viewer policy. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { promisify } from 'node:util';
import type { CompileArtifact } from '@canlang/contracts';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { asId, asModel, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';
import { assembleModules } from './modules.js';
import { invokeReadCanonical } from './invoke.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const source = join(root, 'packages/cloudflare/test/fixtures/native-viewer-first.can');
const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');

it('keeps hidden first rows out of a viewer read and rechecks membership', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-viewer-first-'));
  try {
    const { stdout } = await promisify(execFile)(compiler,
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
      stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
    const now = Date.now(), clock = createFrozenClock(now), identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({ timezone: 'UTC' });
    const user = await identities.createUser({ email: 'viewer-first@example.test', password_hash: 'unused', email_verified: true });
    const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id,
      is_owner: false, roles: [] });
    const token = `viewer-first-${randomBytes(8).toString('hex')}`;
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
    const identity = await resolveIdentity(identities, { session_token: token }, { clock });
    const store = createMemoryStorage();
    const read = () => invokeReadCanonical({ asm, artifact, operation: 'NativeViewerFirst.preview',
      inputs: {}, identity, store, memberships: identities, now: () => now });

    assert.equal((await read() as { result: unknown }).result, null);
    await store.commit(makeBatch(await store.readRevision(), { writes: [
      { kind: 'insert', model: asModel('NativeViewerFirst.Item'),
        row: { ...makeRow({ id: asId('a-hidden'), data: { label: 'Secret', hidden: true } }), parent: null } },
      { kind: 'insert', model: asModel('NativeViewerFirst.Item'),
        row: { ...makeRow({ id: asId('a-ignored'), data: { label: 'Ignored', hidden: false } }), parent: null } },
      { kind: 'insert', model: asModel('NativeViewerFirst.Item'),
        row: { ...makeRow({ id: asId('b-visible'), data: { label: 'Visible', hidden: false } }), parent: null } },
    ] }));
    assert.equal((await read() as { result: unknown }).result, 'Visible');
    await identities.removeMembership(membership.membership_id);
    await assert.rejects(read());
  } finally { await rm(directory, { recursive: true, force: true }); }
});
