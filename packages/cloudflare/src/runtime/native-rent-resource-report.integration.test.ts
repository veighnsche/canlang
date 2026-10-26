/** The original resource report reads complete hidden owner evidence at one revision. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { assembleModules, importVerifiedAssemblyModule } from './modules.js';
import { invokeReadCanonical } from './invoke.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const source = join(root, 'packages/cloudflare/test/fixtures/rent-resource-report-owner-probe.can');
const compiler = join(root, 'compiler/target/debug/can');
const catalog = join(root, 'packages/cloudflare/dist/native-catalog.json');
const from = '2099-01-02T09:00:00.000Z', middle = '2099-01-02T09:30:00.000Z';
const until = '2099-01-02T10:00:00.000Z';
const now = Date.parse('2099-01-02T09:45:00.000Z');
const nowIso = new Date(now).toISOString();
const weekday = String(new Date(from).getUTCDay() || 7);
const model = (name: string) => asModel(name);

it('reports exact current hidden resource and calendar evidence by owner authority',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-rent-resource-report-'));
    try {
      // Structured guards are independently emitted objects. Match their
      // checked meaning without granting an otherwise denied caller access.
      const guardSource = join(directory, 'read-guards.can');
      await writeFile(guardSource, `app ReadGuards
Given
 role reviewer
When
 scenario inspect() read=true -> bool by=(members and not owner) or reviewer
  do return true
Then
`);
      const guardOutput = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, guardSource],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const guardArtifact = JSON.parse(guardOutput.stdout) as CompileArtifact;
      const guardAssembly = async (name: string) => assembleModules({ artifact: guardArtifact, sourcePath: guardSource },
        { workDir: join(directory, name), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib') });
      const guardAsm = await guardAssembly('read-guards');
      const guardIdentities = createMemoryIdentityStore({ clock: createFrozenClock(now) });
      const guardTeam = await guardIdentities.createTeam({});
      for (const mode of ['member', 'owner', 'reviewer'] as const) {
        const user = await guardIdentities.createUser({ email: `${mode}@structured-read.test`,
          password_hash: 'unused', email_verified: true });
        await guardIdentities.createMembership({ team_id: guardTeam.team_id, user_id: user.user_id,
          is_owner: mode !== 'member', roles: mode === 'reviewer'
            ? [{ role: 'ReadGuards.reviewer', granted_at: nowIso, granted_by: user.user_id }] : [] });
        const token = `structured-read-${mode}`;
        await guardIdentities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
          last_team_id: guardTeam.team_id, expires_at: new Date(now + 3600000).toISOString() });
        const identity = await resolveIdentity(guardIdentities, { session_token: token }, { clock: createFrozenClock(now) });
        const read = (asm = guardAsm) => invokeReadCanonical({ asm, artifact: guardArtifact,
          operation: 'ReadGuards.inspect', inputs: {}, identity, store: createMemoryStorage(),
          memberships: guardIdentities, now: () => now });
        if (mode === 'owner') await assert.rejects(read(), (error: unknown) => (error as { code?: string })?.code === 'forbidden');
        else assert.equal((await read() as { result: boolean }).result, true, mode);
        if (mode === 'member') {
          for (const kind of ['different-role', 'getter', 'cycle', 'extra-term'] as const) {
            const selected = await guardAssembly(kind);
            const entry = guardArtifact.modules[0]!;
            const emitted = await importVerifiedAssemblyModule(selected, entry.path, guardArtifact) as {
              appDefinition: { operations: Record<string, { by: unknown }> };
            };
            const declaration = emitted.appDefinition.operations['ReadGuards.inspect']!;
            let getterCalls = 0;
            if (kind === 'different-role') declaration.by = { role: 'ReadGuards.other' };
            if (kind === 'getter') declaration.by = Object.defineProperty({}, 'or', {
              enumerable: true, get() { getterCalls++; return ['public']; } });
            if (kind === 'cycle') { const cycle: { not?: unknown } = {}; cycle.not = cycle; declaration.by = cycle; }
            if (kind === 'extra-term') declaration.by = { and: [declaration.by, 'public'] };
            await assert.rejects(read(selected), /checked by declaration\/policy disagreement|malformed.*policy|malformed.*by|unknown policy member/);
            assert.equal(getterCalls, 0, 'guard comparison cannot execute a getter');
          }
        }
      }
      const probe = await readFile(source, 'utf8');
      const rent = await readFile(join(root, 'draft/apps/CanRent/CanRent.can'), 'utf8');
      const locations = await readFile(join(root, 'draft/shared/Locations.can'), 'utf8');
      for (const line of rent.split('\n').slice(365, 386)) {
        assert.ok(probe.includes(line), `report retains original source: ${line.slice(0, 90)}`);
      }
      for (const name of ['next_boundary', 'saved_rows', 'saved_bookings', 'saved_venues',
        'saved_windows', 'saved_downtime', 'saved_service', 'saved_saleable']) {
        const line = rent.split('\n').find(line => line.startsWith(`  derive ${name}(`));
        assert.ok(line && probe.includes(line), `report retains original helper ${name}`);
      }
      const open = locations.split('\n').find(line => line.startsWith('  export derive policy_open('));
      assert.ok(open && probe.includes(open), 'report retains original opening helper');
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
      const modes = [
        'hidden-complete', 'ordered-hidden-policies', 'partial-baseline', 'wrong-role',
        'wrong-location', 'policy-changed-during-read', 'role-revoked-during-read',
      ] as const;
      for (const mode of modes) {
        const identities = createMemoryIdentityStore({ clock: createFrozenClock(now) });
        const team = await identities.createTeam({ timezone: 'UTC' });
        const actor = await identities.createUser({ email: `${mode}@rent-report.test`,
          password_hash: 'unused', email_verified: true });
        const member = await identities.createMembership({ team_id: team.team_id,
          user_id: actor.user_id, is_owner: false,
          roles: mode === 'wrong-role' ? [] : [{ role: 'rent_reservations.reservation_manager',
            granted_at: new Date(now).toISOString(), granted_by: actor.user_id }] });
        const token = `rent-report-${mode}-${randomBytes(8).toString('hex')}`;
        await identities.createSession({ user_id: actor.user_id, token_sha256: await sha256HexText(token),
          last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
        const identity = await resolveIdentity(identities, { session_token: token },
          { clock: createFrozenClock(now) });
        const backing = createMemoryStorage();
        const site = { ...makeRow({ id: asId('site'), data: { timezone: 'UTC', active: true } }), parent: null };
        const otherSite = { ...makeRow({ id: asId('other-site'), data: { timezone: 'UTC', active: true } }), parent: null };
        const resource = { ...makeRow({ id: asId('resource'), data: {
          location: { id: site.id }, timezone: 'UTC', active: true } }), parent: null };
        const otherResource = { ...makeRow({ id: asId('other-resource'), data: {
          location: { id: site.id }, timezone: 'UTC', active: true } }), parent: null };
        const worker = { ...makeRow({ id: asId('worker'), data: {
          user: { id: actor.user_id }, home: { id: mode === 'wrong-location' ? otherSite.id : site.id },
          locations: [], operator_wide: false, active: true, hidden: false } }), parent: null };
        const weekly = [{ weekday, opens: '09:00', closes: '10:00', close_after: '0', fold: 'earlier' }];
        const opening = { ...makeRow({ id: asId('opening-1'), data: {
          effective: '2099-01-01T00:00:00.000Z', sequence: '1', active: true,
          timezone: 'UTC', weekly, closed: [], dated: [], hidden: true } }),
          parent: { model: model('rent_catalog.Location'), id: site.id } };
        const policy = { ...makeRow({ id: asId('policy-1'), data: {
          effective: '2099-01-01T00:00:00.000Z', sequence: '1',
          baseline: mode !== 'partial-baseline',
          value: { active: true, capacity: '1', pooled: false, timezone: 'UTC' }, hidden: true } }),
          parent: { model: model('rent_reservations.Resource'), id: resource.id } };
        const window = { ...makeRow({ id: asId('window-1'), data: { sequence: '1', key: 'open',
          value: { from, until, closed: false }, hidden: true } }),
          parent: { model: model('rent_reservations.Resource'), id: resource.id } };
        const booking = { ...makeRow({ id: asId('booking-1'), data: { sequence: '1', key: 'booked',
          value: { from, until, intervals: [], quantity: '1', status: 'confirmed',
            checked_in: null, checked_out: null, arrival_buffer: '0', departure_buffer: '0' },
          hidden: true } }), parent: { model: model('rent_reservations.Resource'), id: resource.id } };
        const foreignPolicy = { ...makeRow({ id: asId('foreign-policy'), data: {
          effective: '2099-01-01T00:00:00.000Z', sequence: '99', baseline: true,
          value: { active: true, capacity: '99', pooled: true, timezone: 'UTC' }, hidden: true } }),
          parent: { model: model('rent_reservations.Resource'), id: otherResource.id } };
        const writes: Array<{ kind: 'insert'; model: ModelName; row: StoredRow }> = [
          { kind: 'insert', model: model('rent_catalog.Location'), row: site },
          { kind: 'insert', model: model('rent_catalog.Location'), row: otherSite },
          { kind: 'insert', model: model('employee.Employee'), row: worker },
          { kind: 'insert', model: model('rent_reservations.Resource'), row: resource },
          { kind: 'insert', model: model('rent_reservations.Resource'), row: otherResource },
          { kind: 'insert', model: model('rent_catalog.LocationPolicy'), row: opening },
          { kind: 'insert', model: model('rent_reservations.ResourcePolicy'), row: policy },
          { kind: 'insert', model: model('rent_reservations.WindowEvidence'), row: window },
          { kind: 'insert', model: model('rent_reservations.BookingEvidence'), row: booking },
          { kind: 'insert', model: model('rent_reservations.ResourcePolicy'), row: foreignPolicy },
        ];
        if (mode === 'ordered-hidden-policies') {
          writes.push({ kind: 'insert', model: model('rent_catalog.LocationPolicy'), row: {
            ...makeRow({ id: asId('opening-2'), data: { ...opening.data, effective: middle, sequence: '2' } }),
            parent: { model: model('rent_catalog.Location'), id: site.id } } });
          writes.push({ kind: 'insert', model: model('rent_reservations.ResourcePolicy'), row: {
            ...makeRow({ id: asId('policy-2'), data: { ...policy.data, effective: middle, sequence: '2',
              baseline: false, value: { active: true, capacity: '2', pooled: true, timezone: 'UTC' } } }),
            parent: { model: model('rent_reservations.Resource'), id: resource.id } } });
        }
        await backing.commit(makeBatch(await backing.readRevision(), { writes }));
        let injected = false;
        const store = { ...backing, query: async (spec: Parameters<typeof backing.query>[0]) => {
          const rows = await backing.query(spec);
          if (!injected && mode === 'policy-changed-during-read' &&
              spec.model === model('rent_reservations.ResourcePolicy')) {
            injected = true;
            const current = await backing.load(model('rent_reservations.ResourcePolicy'), policy.id);
            assert.ok(current);
            await backing.commit(makeBatch(await backing.readRevision(), { writes: [{
              kind: 'update', model: model('rent_reservations.ResourcePolicy'), id: policy.id,
              expectedVersion: current.version,
              row: { ...current, version: asVersion(current.version + 1), updated: now,
                data: { ...current.data, value: { active: true, capacity: '2', pooled: false, timezone: 'UTC' } } },
            }] }));
          }
          if (!injected && mode === 'role-revoked-during-read' &&
              spec.model === model('rent_reservations.WindowEvidence')) {
            injected = true;
            await identities.removeMembership(member.membership_id);
          }
          return rows;
        } };
        const call = (operation: string, inputs: Record<string, unknown> = {},
          selectedArtifact: CompileArtifact = artifact) => invokeReadCanonical({
          asm, artifact: selectedArtifact, operation, inputs, identity, store, memberships: identities, now: () => now,
        });
        if (mode === 'hidden-complete') {
          const visible = await call('rent_catalog.LocationPolicy.read') as { records: unknown[] };
          assert.equal(visible.records.length, 0, 'viewer cannot see the hidden opening policy');
        }
        const report = (selectedArtifact: CompileArtifact = artifact) => call('rent_reservations.resource_report', {
          resource: { id: resource.id, version: String(resource.version) }, from, until,
        }, selectedArtifact);
        if (mode === 'wrong-role' || mode === 'wrong-location' || mode.endsWith('-during-read')) {
          await assert.rejects(report(), (error: unknown) => {
            const code = (error as { code?: unknown })?.code;
            const sourceGuard = mode === 'wrong-location' && error instanceof Error &&
              error.message === 'forbidden';
            assert.ok(sourceGuard || code === 'forbidden' || code === 'rule_failed' || code === 'conflict',
              `${mode}: ${String(error)}`);
            return true;
          }, mode);
          if (mode.endsWith('-during-read')) assert.equal(injected, true, mode);
          continue;
        }
        const response = await report().catch((error: unknown) => {
          if (error instanceof Error) error.message = `${mode}: ${error.message}`;
          throw error;
        }) as { result: { checkpoint: { source: string; revision: string; generated: string;
          state: string; complete: boolean };
          rows: Array<{ source: string; location: string; metric: string; quantity: string;
            revision: string; unit: string; from: string; until: string; provisional: boolean }> } };
        const result = response.result;
        assert.equal(result.checkpoint.source, resource.id, mode);
        assert.equal(result.checkpoint.generated, nowIso, mode);
        assert.equal(result.checkpoint.revision,
          mode === 'ordered-hidden-policies'
            ? 'policy-1:1,policy-2:2:opening-1:1,opening-2:2:booking-1:1::window-1:1:'
            : 'policy-1:1:opening-1:1:booking-1:1::window-1:1:', mode);
        assert.equal(result.checkpoint.complete, mode !== 'partial-baseline', mode);
        assert.equal(result.checkpoint.state, mode === 'partial-baseline' ? 'partial' : 'fresh', mode);
        const measure = (metric: string) => result.rows.filter(row => row.metric === metric);
        // The authored service evidence also contributes `checked_out ?? now`.
        assert.equal(result.rows.length, mode === 'ordered-hidden-policies' ? 12 : 8, mode);
        assert.deepEqual(measure('booked_minutes').map(row => Number(row.quantity)),
          mode === 'ordered-hidden-policies' ? [30, 15, 15] : [45, 15], mode);
        assert.deepEqual(measure('saleable_minutes').map(row => Number(row.quantity)),
          mode === 'ordered-hidden-policies' ? [30, 30, 30] : [45, 15], mode);
        assert.deepEqual(measure('excluded_minutes').map(row => Number(row.quantity)),
          mode === 'ordered-hidden-policies' ? [0, 0, 0] : [0, 0], mode);
        assert.deepEqual(measure('occupied_minutes').map(row => Number(row.quantity)),
          mode === 'ordered-hidden-policies' ? [0, 0, 0] : [0, 0], mode);
        assert.ok(result.rows.every(row => row.provisional === false),
          `${mode}: authored default and occupied state are represented`);
        assert.deepEqual(measure('saleable_minutes').map(row => row.revision),
          mode === 'ordered-hidden-policies' ? ['1', '2', '2'] : ['1', '1'], mode);
        assert.deepEqual(measure('saleable_minutes').map(row => row.unit),
          mode === 'ordered-hidden-policies' ? ['room-minute', 'seat-minute', 'seat-minute'] :
            ['room-minute', 'room-minute'], mode);
        assert.deepEqual(measure('saleable_minutes').map(row => [row.from, row.until]),
          mode === 'ordered-hidden-policies' ? [[from, middle], [middle, nowIso], [nowIso, until]] :
            [[from, nowIso], [nowIso, until]], mode);
        assert.ok(result.rows.every(row => row.from >= from && row.until <= until), mode);
        assert.ok(result.rows.every(row => row.source === resource.id && row.location === site.id),
        `${mode}: report rows stay within the selected resource and location`);
        if (mode === 'hidden-complete') {
          const altered = structuredClone(artifact);
          const census = altered.operations?.find(operation =>
            operation.name === 'rent_reservations.resource_report')?.authorityQuerySites;
          const firstPolicy = census?.sites.find(site =>
            site.model === 'rent_reservations.ResourcePolicy' && site.firstSite !== null);
          assert.ok(firstPolicy, 'compiler sealed the original contained FIRST site');
          (firstPolicy as { model: string }).model = 'rent_reservations.WindowEvidence';
          await assert.rejects(report(altered), (error: unknown) => {
            assert.equal((error as { code?: unknown })?.code, 'validation');
            assert.match((error as Error).message, /artifact differs from assembled source/);
            return true;
          }, 'a changed artifact census cannot borrow the verified report module');
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
