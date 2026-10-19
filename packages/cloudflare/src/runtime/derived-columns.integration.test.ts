/** Page-scope list queries serve evaluated derived bool columns on their rows. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { buildPageSourceContext } from '@canlang/interfaces';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { asModel, asId, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';
import { assembleModules } from './modules.js';
import { bindPageReadBooleanContextCanonical, createPageReadScopeCanonical } from './invoke.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const fixture = join(root, 'packages/cloudflare/test/fixtures/native-read-boolean.can');
const itemModel = asModel('NativeBoolean.Item');

it('page list queries carry evaluated derived bool columns', { timeout: 120000 }, async () => {
  const compiler = join(root, 'compiler/target/debug/can');
  const catalog = join(root, 'packages/cloudflare/dist/native-catalog.json');
  const dir = await mkdtemp(join(tmpdir(), 'can-derived-columns-'));
  try {
    const { stdout } = await promisify(execFile)(compiler,
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, fixture],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as import('@canlang/contracts').CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: fixture }, { workDir: dir,
      stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
    const now = Date.now(), clock = createFrozenClock(now), identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({ timezone: 'UTC' });
    const caller = await identities.createUser({ email: 'caller@derived-columns.test', password_hash: 'unused', email_verified: true });
    const subject = await identities.createUser({ email: 'subject@derived-columns.test', password_hash: 'unused', email_verified: true });
    await identities.createMembership({ team_id: team.team_id, user_id: caller.user_id, is_owner: false, roles: [] });
    await identities.createMembership({ team_id: team.team_id, user_id: subject.user_id, is_owner: false, roles: [] });
    const token = 'derived-columns';
    await identities.createSession({ user_id: caller.user_id, token_sha256: await sha256HexText(token),
      last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
    const identity = await resolveIdentity(identities, { session_token: token }, { clock });
    const store = createMemoryStorage();
    const row = { ...makeRow({ id: asId('item'), data: { author: { id: subject.user_id }, enabled: true, hidden: true } }), parent: null };
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: itemModel, row }] }));
    const source = buildPageSourceContext(identity), opts = { asm, artifact, store, identity,
      memberships: identities, pageSource: source, now: () => now };
    bindPageReadBooleanContextCanonical(source, async () => opts);
    const scope = createPageReadScopeCanonical(opts);
    try {
      const listed = await scope.query!(null, 'NativeBoolean.Item', {});
      assert.equal(listed.rows.length, 1);
      const meta = listed.columns.find(column => column.field === 'met');
      assert.ok(meta !== undefined && meta.type === 'bool', 'derived met column is served');
      assert.equal(listed.rows[0]!.fields['met'], true);
    } finally { await scope.close?.(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
