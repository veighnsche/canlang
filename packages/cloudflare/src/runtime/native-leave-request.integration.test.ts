/** The original leave request groups current calendar days into atomic yearly portions. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { promisify } from 'node:util';
import type { CompileArtifact, ModelName, StoredRow } from '@canlang/contracts';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { asId, asModel, asVersion, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';
import { buildInvoker } from '../worker/assembly.js';
import { assembleModules } from './modules.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const source = join(root, 'packages/cloudflare/test/fixtures/leave-request-owner-probe.can');
const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
const model = (name: string) => asModel(name);
const now = Date.parse('2099-01-01T12:00:00.000Z');
const from = '2099-12-30', until = '2100-01-02';
const dayDates = ['2099-12-30', '2099-12-31', '2100-01-01', '2100-01-02'] as const;
const longDates = Array.from({ length: 201 }, (_, index) =>
  new Date(Date.UTC(2100, 0, 2 + index)).toISOString().slice(0, 10));
const longUntil = longDates[longDates.length - 1]!;
function operationId(): string {
  const time = now.toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-8${random.slice(4, 7)}-${random.slice(7, 19)}`;
}

it('creates one original leave request and its current yearly portions, or no effects on refusal',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-leave-request-'));
    try {
      const probe = await readFile(source, 'utf8');
      const original = await readFile(join(root, 'draft/apps/CanLeave/CanLeave.can'), 'utf8');
      const start = original.indexOf('  scenario request(');
      const end = original.indexOf('   examples seed=', start);
      assert.ok(start >= 0 && end > start);
      for (const line of original.slice(start, end).trimEnd().split('\n')) {
        assert.ok(probe.includes(line), `request retains original source: ${line.slice(0, 90)}`);
      }
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
      const modes = [
        'cross-year', 'sick-uncharged', 'long-range-201', 'category-domain-overflow',
        'missing-day', 'missing-allowance',
        'reviewer-role-missing', 'reviewer-wrong-location', 'reviewer-inactive',
        'wrong-calendar-owner', 'overlapping-request',
        'category-changed-at-commit', 'day-changed-at-commit',
        'allowance-changed-at-commit', 'calendar-changed-at-commit',
        'reviewer-revoked-during-employee-query',
      ] as const;
      for (const mode of modes) {
        const identities = createMemoryIdentityStore({ clock: createFrozenClock(now) });
        const team = await identities.createTeam({ timezone: 'UTC' });
        const actor = await identities.createUser({ email: `${mode}@leave-request.test`,
          password_hash: 'unused', email_verified: true });
        const reviewer = await identities.createUser({ email: `reviewer-${mode}@leave-request.test`,
          password_hash: 'unused', email_verified: true });
        await identities.createMembership({ team_id: team.team_id, user_id: actor.user_id,
          is_owner: false, roles: [] });
        const reviewerMembership = await identities.createMembership({ team_id: team.team_id,
          user_id: reviewer.user_id, is_owner: false,
          roles: mode === 'reviewer-role-missing' ? [] : [{ role: 'leave.leave_reviewer',
            granted_at: new Date(now).toISOString(), granted_by: actor.user_id }] });
        const token = `leave-request-${mode}-${randomBytes(8).toString('hex')}`;
        await identities.createSession({ user_id: actor.user_id, token_sha256: await sha256HexText(token),
          last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
        const identity = await resolveIdentity(identities, { session_token: token },
          { clock: createFrozenClock(now) });
        const backing = createMemoryStorage();
        const site = { ...makeRow({ id: asId('site'), data: { name: 'Main', address: '1 Example Road',
          timezone: 'UTC', currency: 'EUR', hours: '09:00–18:00', arrival: 'Reception', active: true } }), parent: null };
        const otherSite = { ...makeRow({ id: asId('other-site'), data: { ...site.data, name: 'Elsewhere' } }), parent: null };
        const employeeData = (userId: string, homeId: string) => ({ user: { id: userId },
          name: 'Worker', home: { id: homeId }, locations: [], operator_wide: false,
          active: true, start: '2090-01-01', end: null, manager: null,
          role: 'worker', skills: [], private_notes: 'private', document: null });
        const owner = { ...makeRow({ id: asId('owner-employee'), data: employeeData(actor.user_id, site.id) }), parent: null };
        const reviewerWorker = { ...makeRow({ id: asId('reviewer-employee'), data: {
          ...employeeData(reviewer.user_id, mode === 'reviewer-wrong-location' ? otherSite.id : site.id),
          active: mode !== 'reviewer-inactive' } }), parent: null };
        const calendar = { ...makeRow({ id: asId('calendar'), data: {
          name: 'Working days', timezone: 'UTC', revision: '1' } }),
          parent: { model: model('employee.Employee'),
            id: mode === 'wrong-calendar-owner' ? reviewerWorker.id : owner.id } };
        const vacation = { ...makeRow({ id: asId('vacation'), data: {
          name: 'vacation', allowance_bucket: 'vacation' } }),
          parent: { model: model('leave.Calendar'), id: calendar.id } };
        const sick = { ...makeRow({ id: asId('sick'), data: {
          name: 'sick', allowance_bucket: null } }),
          parent: { model: model('leave.Calendar'), id: calendar.id } };
        const long = mode === 'long-range-201';
        const days = (long ? longDates : dayDates).map((date, index) => ({ ...makeRow({ id: asId(`day-${index}`), data: {
          date, working: date !== '2100-01-01' } }),
          parent: { model: model('leave.Calendar'), id: calendar.id } }));
        const allowance99 = { ...makeRow({ id: asId('allowance-2099'), data: {
          year: '2099', bucket: 'vacation', days: '20' } }),
          parent: { model: model('employee.Employee'), id: owner.id } };
        const allowance00 = { ...makeRow({ id: asId('allowance-2100'), data: {
          year: '2100', bucket: 'vacation', days: '20' } }),
          parent: { model: model('employee.Employee'), id: owner.id } };
        const prior = { ...makeRow({ id: asId('prior-request'), data: {
          location: { id: site.id }, from: '2099-12-31', until: '2100-01-01',
          bucket: 'vacation', reason: 'Existing leave', reviewer: { id: reviewer.user_id },
          timezone: 'UTC', allowance_bucket: 'vacation', calendar_version: '1',
          schedule_revision: '1', state: 'pending', release_state: 'none', sync: 'none',
          reserve_delivery: null, release_delivery: null, decision: null, schedule_source: null } }),
          parent: { model: model('leave.Calendar'), id: calendar.id } };
        const writes: Array<{ kind: 'insert'; model: ModelName; row: StoredRow }> = [
          { kind: 'insert', model: model('rent_catalog.Location'), row: site },
          { kind: 'insert', model: model('rent_catalog.Location'), row: otherSite },
          { kind: 'insert', model: model('employee.Employee'), row: owner },
          { kind: 'insert', model: model('employee.Employee'), row: reviewerWorker },
          { kind: 'insert', model: model('leave.Calendar'), row: calendar },
          { kind: 'insert', model: model('leave.Category'), row: vacation },
          { kind: 'insert', model: model('leave.Category'), row: sick },
        ];
        if (mode === 'category-domain-overflow') {
          for (let index = 0; index < 3999; index++) writes.push({ kind: 'insert',
            model: model('leave.Category'), row: { ...makeRow({ id: asId(`noise-category-${index}`),
              data: { name: `noise-${index}`, allowance_bucket: null } }),
              parent: { model: model('leave.Calendar'), id: calendar.id } } });
        }
        for (const day of days) if (!(mode === 'missing-day' && day.data.date === '2100-01-01')) {
          writes.push({ kind: 'insert', model: model('leave.Day'), row: day });
        }
        if (mode !== 'sick-uncharged') {
          writes.push({ kind: 'insert', model: model('leave.Allowance'), row: allowance99 });
          if (mode !== 'missing-allowance') writes.push({ kind: 'insert',
            model: model('leave.Allowance'), row: allowance00 });
        }
        if (mode === 'overlapping-request') writes.push({ kind: 'insert',
          model: model('leave.Request'), row: prior });
        await backing.commit(makeBatch(await backing.readRevision(), { writes }));
        let injected = false;
        const store = { ...backing,
          query: async (spec: Parameters<typeof backing.query>[0]) => {
            const records = await backing.query(spec);
            if (mode === 'reviewer-revoked-during-employee-query' && !injected &&
                spec.model === model('employee.Employee')) {
              injected = true;
              await identities.removeMembership(reviewerMembership.membership_id);
            }
            return records;
          },
          commit: async (batch: Parameters<typeof backing.commit>[0]) => {
            const changes = {
              'category-changed-at-commit': [model('leave.Category'), vacation.id, { name: 'other' }],
              'day-changed-at-commit': [model('leave.Day'), days[1]!.id, { date: '2099-12-29' }],
              'allowance-changed-at-commit': [model('leave.Allowance'), allowance00.id, { bucket: 'other' }],
              'calendar-changed-at-commit': [model('leave.Calendar'), calendar.id, { revision: '2' }],
            } as Record<string, [ModelName, string, Record<string, unknown>]>;
            const change = changes[mode];
            if (change !== undefined && !injected) {
              injected = true;
              const [name, id, data] = change;
              const current = await backing.load(name, asId(id)); assert.ok(current);
              await backing.commit(makeBatch(await backing.readRevision(), { writes: [{
                kind: 'update', model: name, id: current.id, expectedVersion: current.version,
                row: { ...current, version: asVersion(current.version + 1), updated: now,
                  data: { ...current.data, ...data } },
              }] }));
            }
            return backing.commit(batch);
          } };
        const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
        const uncharged = mode === 'sick-uncharged';
        const outcome = await invoker.invokeMutation({ operation: 'leave.request', operation_id: operationId(),
          inputs: { calendar: { id: calendar.id, version: String(calendar.version) },
            from: uncharged || long ? '2100-01-02' : from, until: long ? longUntil : until,
            bucket: uncharged ? 'sick' : 'vacation', reason: uncharged ? 'Unwell' : 'Year-end leave',
            reviewer: { id: reviewer.user_id } } }, identity).catch((error: unknown) => {
          throw new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        });
        const success = mode === 'cross-year' || uncharged || long;
        const code = 'result' in outcome ? outcome.result.status : outcome.error.code;
        if (success) assert.equal(code, 'committed', `${mode}: ${JSON.stringify(outcome)}`);
        else if (mode === 'category-domain-overflow') {
          assert.equal(code, 'validation', `${mode}: ${JSON.stringify(outcome)}`);
          assert.match('error' in outcome ? outcome.error.message : '', /complete domain bound/);
        }
        else assert.ok(['forbidden', 'rule_failed', 'conflict'].includes(code),
          `${mode}: ${JSON.stringify(outcome)}`);
        const requests = await backing.query({ model: model('leave.Request'), authority: 'owner' });
        const portions = await backing.query({ model: model('leave.Portion'), authority: 'owner' });
        assert.equal(requests.length, success ? 1 : mode === 'overlapping-request' ? 1 : 0, mode);
        assert.equal(portions.length, success ? uncharged || long ? 1 : 2 : 0, mode);
        if (success) {
          const request = requests[0]!;
          assert.equal(request.parent?.model, model('leave.Calendar'), mode);
          assert.equal(request.parent?.id, calendar.id, mode);
          assert.deepEqual(request.data.location, { id: site.id }, mode);
          assert.equal(request.data.from, uncharged || long ? '2100-01-02' : from, mode);
          assert.equal(request.data.until, long ? longUntil : until, mode);
          assert.equal(request.data.bucket, uncharged ? 'sick' : 'vacation', mode);
          assert.equal(request.data.reason, uncharged ? 'Unwell' : 'Year-end leave', mode);
          assert.deepEqual(request.data.reviewer, { id: reviewer.user_id }, mode);
          assert.equal(request.data.timezone, 'UTC', mode);
          assert.equal(request.data.allowance_bucket, uncharged ? null : 'vacation', mode);
          assert.equal(request.data.calendar_version, '1', mode);
          assert.equal(request.data.state, 'pending', mode);
          assert.equal(request.data.schedule_revision, '1', mode);
          assert.equal(request.data.sync, 'none', mode);
          assert.equal(request.data.release_state, 'none', mode);
          assert.ok(portions.every(portion => portion.parent?.model === model('leave.Request') &&
            portion.parent.id === request.id), mode);
          const ordered = [...portions].sort((left, right) => String(left.data.dates).localeCompare(String(right.data.dates)));
          assert.deepEqual(ordered.map(portion => portion.data.days), uncharged ? ['1'] : long ? ['201'] : ['2', '1'], mode);
          if (long) assert.deepEqual([...(ordered[0]!.data.dates as string[])].sort(), longDates, mode);
          else assert.deepEqual(ordered.map(portion => portion.data.dates), uncharged
            ? [['2100-01-02']] : [['2099-12-30', '2099-12-31'], ['2100-01-02']], mode);
          assert.deepEqual(ordered.map(portion => portion.data.allowance), uncharged ? [null]
            : long ? [{ id: allowance00.id }] : [{ id: allowance99.id }, { id: allowance00.id }], mode);
        }
        if (mode.endsWith('-at-commit') || mode === 'reviewer-revoked-during-employee-query') {
          assert.equal(injected, true, `${mode}: race hook reached`);
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
