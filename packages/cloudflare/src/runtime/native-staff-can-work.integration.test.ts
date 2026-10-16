/** Original compiled staff/can_work read permissions over actual State/Identity reads. */
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
const employeesFixture = join(root, 'packages/cloudflare/test/fixtures/staff-can-work-employee.can');
const shopFixture = join(root, 'packages/cloudflare/test/fixtures/staff-can-work-shop.can');
const employeeModel = asModel('employee.Employee');
const entryModel = asModel('shop.Entry');
const object = (value: unknown): Record<string, any> => {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, any>;
};

it('enforces original staff/can_work grants, denial, revocation and location branches after current read authority', { timeout: 180000 }, async () => {
  const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
  const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
  const pins = [employeesFixture, shopFixture, compiler, catalog];
  const hashes = () => Promise.all(pins.map(async path => createHash('sha256').update(await readFile(path)).digest('hex')));
  const before = await hashes();
  const dir = await mkdtemp(join(tmpdir(), 'can-native-staff-'));
  try {
    const { stdout } = await promisify(execFile)(compiler,
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, employeesFixture, shopFixture],
      { cwd: root, timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as import('@canlang/contracts').CompileArtifact;
    assert.ok(artifact.sources.some(source => resolve(source.path) === employeesFixture && source.sha256 === before[0]));
    assert.ok(artifact.sources.some(source => resolve(source.path) === shopFixture && source.sha256 === before[1]));
    const asm = await assembleModules({ artifact, sourcePath: shopFixture }, { workDir: dir,
      stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
    const entry = Object.entries(asm.moduleUrls).find(([, url]) => url === asm.entryUrl)?.[0]; assert.ok(entry);
    const namespace = object(await importVerifiedAssemblyModule(asm, entry, artifact));
    const definition = object(namespace.appDefinition);
    const pages = definition.pages as Record<string, any>[];
    const access = pages.find(page => page.path === '/entries/{Entry.id}/access'); assert.ok(access);
    const hidden = pages.find(page => page.path === '/entries/{Entry.id}/hidden'); assert.ok(hidden);

    for (const mode of ['grant-member', 'deny-stranger', 'revoke-subject', 'branch-home', 'branch-operator', 'branch-locations', 'branch-hidden'] as const) {
      // Derives that call active_member run only inside framework-opened
      // membership frames, so every mode drives through record reads and
      // page admits over real State/Identity; no derive is invoked directly.
      const now = Date.now(), clock = createFrozenClock(now), identities = createMemoryIdentityStore({ clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      const alice = await identities.createUser({ email: 'alice@staff-work.test', password_hash: 'unused', email_verified: true });
      const bob = await identities.createUser({ email: 'bob@staff-work.test', password_hash: 'unused', email_verified: true });
      const carol = await identities.createUser({ email: 'carol@staff-work.test', password_hash: 'unused', email_verified: true });
      const mallory = await identities.createUser({ email: 'mallory@staff-work.test', password_hash: 'unused', email_verified: true });
      const aliceMembership = await identities.createMembership({ team_id: team.team_id, user_id: alice.user_id, is_owner: false, roles: [] });
      await identities.createMembership({ team_id: team.team_id, user_id: bob.user_id, is_owner: false, roles: [] });
      await identities.createMembership({ team_id: team.team_id, user_id: carol.user_id, is_owner: false, roles: [] });
      await identities.createMembership({ team_id: team.team_id, user_id: mallory.user_id, is_owner: false, roles: [] });
      const sessionFor = async (userId: string) => {
        const token = `staff-work-${mode}-${userId}`;
        await identities.createSession({ user_id: userId, token_sha256: await sha256HexText(token),
          last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
        return resolveIdentity(identities, { session_token: token }, { clock });
      };
      const store = createMemoryStorage();
      const siteA = 'site-a', siteB = 'site-b';
      const employee = (id: string, userId: string, data: Record<string, any>) => ({ ...makeRow({ id: asId(id), data: { user: { id: userId }, ...data } }), parent: null });
      const writes = [
        { kind: 'insert', model: employeeModel, row: employee('alice', alice.user_id, {
          name: 'Alice', home: { id: siteA }, locations: [], operator_wide: false, active: true, role: 'caregiver' }) },
        { kind: 'insert', model: employeeModel, row: employee('bob', bob.user_id, {
          name: 'Bob', home: { id: siteA }, locations: [], operator_wide: true, active: true, role: 'operator' }) },
        { kind: 'insert', model: employeeModel, row: employee('carol', carol.user_id, {
          name: 'Carol', home: { id: siteA }, locations: [{ id: siteB }], operator_wide: false, active: true, role: 'operator' }) },
        { kind: 'insert', model: entryModel, row: { ...makeRow({ id: asId('e1'), data: {
          owner: { id: alice.user_id }, site: { id: siteA }, hidden: false } }), parent: null } },
        { kind: 'insert', model: entryModel, row: { ...makeRow({ id: asId('e2'), data: {
          owner: { id: alice.user_id }, site: { id: siteB }, hidden: true } }), parent: null } },
      ] as const;
      await store.commit(makeBatch(await store.readRevision(), { writes: [...writes] }));
      const memberships = identities;
      const readAs = async (userId: string) => {
        const identity = await sessionFor(userId);
        const holder: { scope?: any } = {};
        const source = buildPageSourceContext(identity, (async (...args: any[]) => holder.scope!.readRecords!(...args)) as any);
        const opts = { asm, artifact, store, identity, memberships, pageSource: source, now: () => now };
        bindPageReadBooleanContextCanonical(source, async () => opts);
        const scope = createPageReadScopeCanonical(opts);
        holder.scope = scope;
        return { source, scope };
      };
      const entryWhere = (id: string) => ({ where: { op: 'eq', field: 'id', value: id } }) as const;
      if (mode === 'grant-member') {
        const { scope } = await readAs(alice.user_id);
        try {
          assert.equal((await scope.readRecords!('shop.Entry', entryWhere('e1'))).length, 1, 'active staff reads');
        } finally { await scope.close?.(); }
      } else if (mode === 'deny-stranger') {
        const { scope } = await readAs(mallory.user_id);
        try {
          assert.deepEqual(await scope.readRecords!('shop.Entry', entryWhere('e1')), [], 'member without a row reads nothing');
        } finally { await scope.close?.(); }
      } else if (mode === 'revoke-subject') {
        const first = await readAs(alice.user_id);
        try {
          assert.equal((await first.scope.readRecords!('shop.Entry', entryWhere('e1'))).length, 1, 'granted before revocation');
        } finally { await first.scope.close?.(); }
        await identities.removeMembership(aliceMembership.membership_id);
        const second = await readAs(alice.user_id);
        try {
          assert.deepEqual(await second.scope.readRecords!('shop.Entry', entryWhere('e1')), [], 'revoked membership reads nothing: authority is current, not cached');
        } finally { await second.scope.close?.(); }
      } else if (mode === 'branch-home') {
        const { source, scope } = await readAs(alice.user_id);
        try {
          await access.admit(source, { 'Entry.id': 'e1' });
          await assert.rejects(access.admit(source, { 'Entry.id': 'e2' }), 'non-home place denies');
        } finally { await scope.close?.(); }
      } else if (mode === 'branch-operator') {
        const { source, scope } = await readAs(bob.user_id);
        try {
          await access.admit(source, { 'Entry.id': 'e2' });
        } finally { await scope.close?.(); }
      } else if (mode === 'branch-locations') {
        const { source, scope } = await readAs(carol.user_id);
        try {
          await access.admit(source, { 'Entry.id': 'e2' });
        } finally { await scope.close?.(); }
      } else {
        const first = await readAs(alice.user_id);
        try {
          await assert.rejects(hidden.admit(first.source, { 'Entry.id': 'e1' }), 'visible entry denies hidden access');
        } finally { await first.scope.close?.(); }
        const second = await readAs(bob.user_id);
        try {
          await hidden.admit(second.source, { 'Entry.id': 'e2' });
        } finally { await second.scope.close?.(); }
      }
      assert.deepEqual(await store.historyFor(employeeModel, asId('alice')), []);
    }
    assert.deepEqual(await hashes(), before, 'original source and compiler inputs remain frozen');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
