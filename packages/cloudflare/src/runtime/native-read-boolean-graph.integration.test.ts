/** Exact original CanMember role/work and CanShift coverage bodies, including
 * installed policy-control recursion and viewer reference/query permissions. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type { StoredRow } from '@canlang/contracts';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { buildPageSourceContext } from '@canlang/interfaces';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { asModel, asId, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';
import { assembleModules, importVerifiedAssemblyModule } from './modules.js';
import { bindPageReadBooleanContextCanonical, createPageReadScopeCanonical } from './invoke.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const fixture = join(root, 'packages/cloudflare/test/fixtures/native-read-boolean-graph.can');
const app = 'NativeBooleanGraph';
const model = (name: string) => asModel(`${app}.${name}`);
const object = (value: unknown): Record<string, any> => {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, any>;
};

it('runs original membership role/work and coverage query/reference closures under one current source observation', { timeout: 120000 }, async () => {
  const original = await readFile(fixture, 'utf8');
  for (const [path, names] of [['draft/shared/Employees.can', ['staff', 'can_work']],
    ['draft/apps/CanCustomer/CanCustomer.can', ['has_role']],
    ['draft/apps/CanShift/CanShift.can', ['eligible', 'coverage_met']]] as const) {
    const source = await readFile(join(root, path), 'utf8');
    for (const name of names) {
      const declaration = source.split('\n').find(line => line.includes(`derive ${name}(`))!.trim().replace('export derive ', 'derive ');
      assert.ok(original.includes(declaration), `${name} retains its exact original source body`);
    }
  }
  const compiler = join(root, 'compiler/target/debug/can');
  const catalog = join(root, 'packages/cloudflare/dist/native-catalog.json');
  const pins = [fixture, compiler, catalog];
  const hashes = () => Promise.all(pins.map(async path => createHash('sha256').update(await readFile(path)).digest('hex')));
  const before = await hashes();
  const dir = await mkdtemp(join(tmpdir(), 'can-native-boolean-graph-'));
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
    const registry = object(namespace.canApp()), met = object(registry.derives)[`${app}.Coverage.met`];
    const page = (object(namespace.appDefinition).pages as Record<string, any>[]).find(page => page.path === '/companies/{Customer.id}/membership-access');
    assert.ok(page); assert.equal(typeof met, 'function');

    for (const mode of ['admin-lazy', 'manager', 'subject-removed', 'revoke-subject', 'revoke-caller'] as const) {
      const now = Date.now(), clock = createFrozenClock(now), identities = createMemoryIdentityStore({ clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      const caller = await identities.createUser({ email: 'caller@boolean-graph.test', password_hash: 'unused', email_verified: true });
      const subject = await identities.createUser({ email: 'subject@boolean-graph.test', password_hash: 'unused', email_verified: true });
      const callerMembership = await identities.createMembership({ team_id: team.team_id, user_id: caller.user_id, is_owner: false,
        roles: ['scheduler', 'member_manager'].map(role => ({ role: `${app}.${role}`, granted_at: new Date(now).toISOString(), granted_by: caller.user_id })) });
      const subjectMembership = await identities.createMembership({ team_id: team.team_id, user_id: subject.user_id, is_owner: false, roles: [] });
      const token = `boolean-graph-${mode}`;
      await identities.createSession({ user_id: caller.user_id, token_sha256: await sha256HexText(token),
        last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
      const identity = await resolveIdentity(identities, { session_token: token }, { clock });
      const backing = createMemoryStorage();
      const from = '2026-10-15T09:00:00.000Z', until = '2026-10-15T11:00:00.000Z';
      const rows: [string, StoredRow][] = [];
      const add = (name: string, id: string, data: StoredRow['data'], parent?: { model: string; id: string }) => {
        const row = { ...makeRow({ id: asId(id), data }), parent: parent === undefined ? null : { model: model(parent.model), id: asId(parent.id) } };
        rows.push([name, row]); return row;
      };
      add('Location', 'site', { active: true });
      add('Customer', 'company', { locations: [{ id: 'site' }] });
      if (mode === 'admin-lazy') add('CompanyRole', 'admin', { account: { id: caller.user_id }, role: 'administrator', active: true }, { model: 'Customer', id: 'company' });
      add('Employee', 'caller-worker', { user: { id: caller.user_id }, active: true, operator_wide: false, home: { id: 'site' }, locations: [], role: 'host', skills: ['host'], private_notes: 'CALLER PRIVATE' });
      add('Employee', 'subject-worker', { user: { id: subject.user_id }, active: true, operator_wide: false, home: { id: 'site' }, locations: [], role: 'host', skills: ['host'], private_notes: 'SUBJECT PRIVATE' });
      add('Roster', 'roster', { label: 'Current roster' });
      add('Availability', 'available', { employee: { id: 'subject-worker' }, available: true, from, until }, { model: 'Roster', id: 'roster' });
      add('Commitment', 'commitment', { employee: { id: 'subject-worker' }, location: { id: 'site' }, active: true,
        kind: 'duty', skill: 'host', from, until, before: '0', after: '0', conflict: false }, { model: 'Roster', id: 'roster' });
      add('Duty', 'duty', { role: 'host', published: true }, { model: 'Commitment', id: 'commitment' });
      const coverage = add('Coverage', 'coverage', { location: { id: 'site' }, role: 'host', from, until, minimum: '1' }, { model: 'Roster', id: 'roster' });
      await backing.commit(makeBatch(await backing.readRevision(), { writes: rows.map(([name, row]) => ({ kind: 'insert', model: model(name), row })) }));
      if (mode === 'subject-removed') await identities.removeMembership(subjectMembership.membership_id);
      let employeeQueries = 0, armed = false, revoked = false;
      const store = { ...backing, query: async (spec: Parameters<typeof backing.query>[0]) => {
        if (spec.model === model('Employee')) employeeQueries++;
        return backing.query(spec);
      } };
      const memberships = { ...identities, findMembership: async (...args: Parameters<typeof identities.findMembership>) => {
        const result = await identities.findMembership(...args);
        if (armed && args[1] === subject.user_id && mode.startsWith('revoke-') && !revoked) {
          revoked = true;
          await identities.removeMembership(mode === 'revoke-subject' ? subjectMembership.membership_id : callerMembership.membership_id);
        }
        return result;
      } };
      let scope: ReturnType<typeof createPageReadScopeCanonical>;
      const source = buildPageSourceContext(identity, (model, query) => scope.readRecords!(model, query));
      const opts = { asm, artifact, identity, store, memberships, pageSource: source, now: () => now };
      scope = createPageReadScopeCanonical(opts);
      bindPageReadBooleanContextCanonical(source, async () => opts);
      try {
        await page.admit(source, { 'Customer.id': 'company' });
        if (mode === 'admin-lazy') assert.equal(employeeQueries, 0, 'administrator branch skips all work queries');
        else assert.ok(employeeQueries > 0, 'manager branch uses actual employee work query');
        const employees = await scope.readRecords!(`${app}.Employee`, {});
        assert.equal(employees.length, 2, 'staff policy decides its own Employee query without policy recursion');
        for (const employee of employees) assert.equal(Object.keys(employee).includes('private_notes'), false, 'data projections omit private fields');
        const records = await scope.readRecords!(`${app}.Coverage`, { where: { op: 'eq', field: 'id', value: coverage.id } });
        assert.equal(records.length, 1); armed = true;
        const evaluate = () => met({ canonical: { readRecords: scope.readRecords } }, records[0]);
        if (mode.startsWith('revoke-')) { await assert.rejects(evaluate()); assert.equal(revoked, true); }
        else assert.equal(await evaluate(), mode !== 'subject-removed');
        for (const employee of employees) assert.throws(() => employee.private_notes,
          (error: any) => error.code === 'forbidden', 'native field access retains original field grants');
      } finally { await scope.close?.(); }
      for (const [name, row] of rows) { assert.deepEqual(await backing.load(model(name), row.id), row); assert.deepEqual(await backing.historyFor(model(name), row.id), []); }
    }
    assert.deepEqual(await hashes(), before, 'original source and compiler inputs remain frozen');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
