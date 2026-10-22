/** Original compiled page/derived booleans over actual State/Identity reads. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { buildPageSourceContext } from '@canlang/interfaces';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { asModel, asId, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';
import { assembleModules, importVerifiedAssemblyModule } from './modules.js';
import { bindPageReadBooleanContextCanonical, createPageReadScopeCanonical } from './invoke.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const fixture = join(root, 'packages/cloudflare/test/fixtures/native-read-boolean.can');
const itemModel = asModel('NativeBoolean.Item');
const object = (value: unknown): Record<string, any> => {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, any>;
};

it('releases original page and false derived values after current read authority, preserving lazy protected access', { timeout: 120000 }, async () => {
  const compiler = join(root, 'compiler/target/debug/can');
  const catalog = join(root, 'packages/cloudflare/dist/native-catalog.json');
  const pins = [fixture, compiler, catalog];
  const hashes = () => Promise.all(pins.map(async path => createHash('sha256').update(await readFile(path)).digest('hex')));
  const before = await hashes();
  const dir = await mkdtemp(join(tmpdir(), 'can-native-boolean-'));
  try {
    const { stdout } = await promisify(execFile)(compiler,
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, fixture],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as import('@canlang/contracts').CompileArtifact;
    assert.ok(artifact.sources.some(source => resolve(source.path) === fixture && source.sha256 === before[0]));
    const asm = await assembleModules({ artifact, sourcePath: fixture }, { workDir: dir,
      stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
    const entry = Object.entries(asm.moduleUrls).find(([, url]) => url === asm.entryUrl)?.[0]; assert.ok(entry);
    const namespace = object(await importVerifiedAssemblyModule(asm, entry, artifact));
    const definition = object(namespace.appDefinition), registry = object(namespace.canApp());
    const met = object(registry.derives)['NativeBoolean.Item.met']; assert.equal(typeof met, 'function');
    const pages = definition.pages as Record<string, any>[];
    const access = pages.find(page => page.path === '/items/{Item.id}/access'); assert.ok(access);
    const hidden = pages.find(page => page.path === '/items/{Item.id}/hidden'); assert.ok(hidden);

    for (const mode of ['active', 'false-lazy', 'subject-removed', 'revoke-subject', 'revoke-caller', 'withheld'] as const) {
      const now = Date.now(), clock = createFrozenClock(now), identities = createMemoryIdentityStore({ clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      const caller = await identities.createUser({ email: 'caller@native-boolean.test', password_hash: 'unused', email_verified: true });
      const subject = await identities.createUser({ email: 'subject@native-boolean.test', password_hash: 'unused', email_verified: true });
      const callerMembership = await identities.createMembership({ team_id: team.team_id, user_id: caller.user_id, is_owner: false, roles: [] });
      const subjectMembership = await identities.createMembership({ team_id: team.team_id, user_id: subject.user_id, is_owner: false, roles: [] });
      const token = `native-boolean-${mode}`;
      await identities.createSession({ user_id: caller.user_id, token_sha256: await sha256HexText(token),
        last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
      const identity = await resolveIdentity(identities, { session_token: token }, { clock });
      const store = createMemoryStorage();
      const row = { ...makeRow({ id: asId('item'), data: { author: { id: subject.user_id }, enabled: mode !== 'false-lazy', hidden: true } }), parent: null };
      await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: itemModel, row }] }));
      if (mode === 'subject-removed') await identities.removeMembership(subjectMembership.membership_id);
      let subjectReads = 0, revoked = false, armed = false;
      const memberships = { ...identities, findMembership: async (teamId: Parameters<typeof identities.findMembership>[0], person: Parameters<typeof identities.findMembership>[1]) => {
        const result = await identities.findMembership(teamId, person);
        if (person === subject.user_id) {
          subjectReads++;
          if (armed && !revoked && mode.startsWith('revoke-')) {
            revoked = true;
            await identities.removeMembership(mode === 'revoke-subject' ? subjectMembership.membership_id : callerMembership.membership_id);
          }
        }
        return result;
      } };
      const source = buildPageSourceContext(identity), opts = { asm, artifact, store, identity, memberships,
        pageSource: source, now: () => now };
      bindPageReadBooleanContextCanonical(source, async () => opts);
      const scope = createPageReadScopeCanonical(opts);
      try {
        const records = await scope.readRecords!('NativeBoolean.Item', { where: { op: 'eq', field: 'id', value: row.id } });
        assert.equal(records.length, 1);
        const context = { canonical: { readRecords: scope.readRecords } };
        const before = subjectReads; armed = true;
        if (mode.startsWith('revoke-')) {
          await assert.rejects(met(context, records[0]));
          assert.equal(revoked, true);
        } else if (mode === 'withheld') {
          await assert.rejects(hidden.admit(source, { 'Item.id': row.id }), (error: any) => error.code === 'forbidden');
          assert.equal(subjectReads, before, 'denied field stops before membership');
        } else {
          const expected = mode === 'active';
          assert.equal(await met(context, records[0]), expected, 'false is a value and retains the granted row');
          if (mode === 'false-lazy') assert.equal(subjectReads, before, 'false left operand skips membership');
          if (mode === 'subject-removed') await assert.rejects(access.admit(source, { 'Item.id': row.id }));
          else await access.admit(source, { 'Item.id': row.id });
        }
        assert.deepEqual(await store.load(itemModel, row.id), row);
        assert.deepEqual(await store.historyFor(itemModel, row.id), []);
      } finally { await scope.close?.(); }
    }
    assert.deepEqual(await hashes(), before, 'original source and compiler inputs remain frozen');
  } finally { await rm(dir, { recursive: true, force: true }); }
});


it('executes compiled grouping keys and nested boolean callbacks in source order', { timeout: 120000 }, async () => {
  const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
  const sourcePath = join(root, 'compiler/tests/fixtures/callback-probe.can');
  const dir = await mkdtemp(join(tmpdir(), 'can-callback-values-'));
  try {
    const { stdout } = await promisify(execFile)(compiler,
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog',
        join(root, 'packages/cloudflare/dist/native-catalog.json'), sourcePath],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout);
    const asm = await assembleModules({ artifact, sourcePath }, { workDir: dir,
      stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
    const entry = artifact.modules[0].path;
    const namespace = object(await importVerifiedAssemblyModule(asm, entry, artifact));
    const functions = object(namespace.canApp());
    for (const name of ['callbacks.grouped', 'callbacks.plain']) {
      assert.equal(await functions[name]({}, [1n, 1n, 2n]), 2n, name);
      assert.equal(await functions[name]({}, []), 0n, name);
    }
    assert.equal(await functions['callbacks.nested']({}, [1n, 2n]), false);
    assert.equal(await functions['callbacks.nested']({}, [1n, 1n]), true);
    assert.equal(await functions['callbacks.nested']({}, []), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
