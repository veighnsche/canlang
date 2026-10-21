/** The original leave decision reserves allowance and absence together. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { promisify } from 'node:util';
import type { CompileArtifact, FileRetirementAuthority, ModelName, StoredRow } from '@canlang/contracts';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { STATE_FILE_REFERENCE_PRODUCER } from '@canlang/state/storage';
import { asId, asModel, asVersion, makeBatch, makeRow, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work/kernel/file-reference-inventory';
import { WORK_DISPATCH_STAGE_COMMANDS, WORK_SYSTEM_COMMANDS,
  createWorkDispatchClaimCommand } from '@canlang/work/kernel/commands';
import { classifyFailure } from '@canlang/work/receipt';
import { assembleDispatchCommands, buildInvoker } from '../worker/assembly.js';
import { installNativeFileInventory } from './file-inventory.js';
import { bindNativeEmailDispatchGuards, createWorkerDispatchJoinPort,
  driveDispatchIntentWithPreclaim, loadDispatchSystemProducers,
  withDispatchJoinPort } from './invoke.js';
import { assembleModules } from './modules.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const source = join(root, 'packages/cloudflare/test/fixtures/leave-decide-owner-probe.can');
const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
const model = (name: string) => asModel(name);
const now = Date.parse('2099-01-01T12:00:00.000Z');

function operationId(): string {
  const time = now.toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-8${random.slice(4, 7)}-${random.slice(7, 19)}`;
}

it('applies the original leave decision and reserves absence only after a current authorized approval',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-leave-decide-'));
    try {
      const probe = await readFile(source, 'utf8');
      const original = await readFile(join(root, 'draft/apps/CanLeave/CanLeave.can'), 'utf8');
      const start = original.indexOf('  scenario decide(');
      const end = original.indexOf('   examples seed=', start);
      assert.ok(start >= 0 && end > start);
      for (const line of original.slice(start, end).trimEnd().split('\n')) {
        assert.ok(probe.includes(line), `decide retains original source: ${line.slice(0, 90)}`);
      }
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
      const modes = [
        'approve', 'reject', 'uncharged-approve', 'insufficient-allowance',
        'shared-allowance-overdraw', 'reviewer-role-missing', 'wrong-reviewer',
        'reviewer-inactive', 'reviewer-wrong-location', 'self-review', 'stale-version',
        'request-withdrawn-at-commit', 'allowance-reduced-at-commit',
        'portion-increased-at-commit', 'approved-portion-inserted-at-commit',
      ] as const;
      for (const mode of modes) {
        const identities = createMemoryIdentityStore({ clock: createFrozenClock(now) });
        const team = await identities.createTeam({ timezone: 'UTC' });
        const owner = await identities.createUser({ email: `owner-${mode}@leave-decide.test`,
          password_hash: 'unused', email_verified: true });
        const reviewer = await identities.createUser({ email: `reviewer-${mode}@leave-decide.test`,
          password_hash: 'unused', email_verified: true });
        await identities.createMembership({ team_id: team.team_id, user_id: owner.user_id,
          is_owner: false, roles: [] });
        await identities.createMembership({ team_id: team.team_id, user_id: reviewer.user_id,
          is_owner: false, roles: mode === 'reviewer-role-missing' ? [] : [{
            role: 'leave.leave_reviewer', granted_at: new Date(now).toISOString(),
            granted_by: owner.user_id }] });
        const token = `leave-decide-${mode}-${randomBytes(8).toString('hex')}`;
        await identities.createSession({ user_id: reviewer.user_id,
          token_sha256: await sha256HexText(token), last_team_id: team.team_id,
          expires_at: new Date(now + 3600000).toISOString() });
        const identity = await resolveIdentity(identities, { session_token: token },
          { clock: createFrozenClock(now) });
        const authority: FileRetirementAuthority = { app: 'CanLeave', stateOwner: 'CanLeave',
          stateStoreId: 'leave-decide-state', fileStoreId: 'leave-decide-files',
          receiver: { app: 'CanLeave', owner: team.team_id, team: team.team_id } };
        const { store: backing, probe: storageProbe } = createTestMemoryStorage(authority,
          [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({ artifact, asm, store: backing, authority,
          scope: { app: 'CanLeave', owner: team.team_id, ownerPackage: 'leave' },
          now: () => now, verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
        const site = { ...makeRow({ id: asId('site'), data: { name: 'Main', address: '1 Example Road',
          timezone: 'UTC', currency: 'EUR', hours: '09:00–18:00', arrival: 'Reception', active: true } }), parent: null };
        const otherSite = { ...makeRow({ id: asId('other-site'), data: { ...site.data, name: 'Elsewhere' } }), parent: null };
        const employeeData = (userId: string, homeId: string) => ({ user: { id: userId },
          name: 'Worker', home: { id: homeId }, locations: [], operator_wide: false,
          active: true, start: '2090-01-01', end: null, manager: null,
          role: 'worker', skills: [], private_notes: 'private', document: null });
        const ownerWorker = { ...makeRow({ id: asId('owner-employee'),
          data: employeeData(owner.user_id, site.id) }), parent: null };
        const reviewerWorker = { ...makeRow({ id: asId('reviewer-employee'), data: {
          ...employeeData(reviewer.user_id,
            mode === 'reviewer-wrong-location' ? otherSite.id : site.id),
          active: mode !== 'reviewer-inactive' } }), parent: null };
        const calendar = { ...makeRow({ id: asId('calendar'), data: {
          name: 'Working days', timezone: 'UTC', revision: '1' } }),
          parent: { model: model('employee.Employee'),
            id: mode === 'self-review' ? reviewerWorker.id : ownerWorker.id } };
        const allowance = { ...makeRow({ id: asId('allowance'), data: {
          year: '2099', bucket: 'vacation',
          days: mode === 'insufficient-allowance' ? '1' : '3' } }),
          parent: { model: model('employee.Employee'), id: ownerWorker.id } };
        const request = { ...makeRow({ id: asId('request'), data: {
          location: { id: site.id }, from: '2099-12-30', until: '2099-12-31',
          bucket: 'vacation', reason: 'Year-end leave',
          reviewer: { id: mode === 'wrong-reviewer' ? owner.user_id : reviewer.user_id },
          timezone: 'UTC', allowance_bucket: 'vacation', calendar_version: '1',
          schedule_revision: '1', state: 'pending', release_state: 'none', sync: 'none',
          reserve_delivery: null, release_delivery: null, decision: null, schedule_source: null } }),
          parent: { model: model('leave.Calendar'), id: calendar.id } };
        const portionData = (days: string, useAllowance = true) => ({
          allowance: useAllowance ? { id: allowance.id } : null, days,
          dates: ['2099-12-30', '2099-12-31'] });
        const portion = { ...makeRow({ id: asId('portion'), data: portionData('2',
          mode !== 'uncharged-approve') }),
          parent: { model: model('leave.Request'), id: request.id } };
        const secondPortion = { ...makeRow({ id: asId('second-portion'), data: portionData('2') }),
          parent: { model: model('leave.Request'), id: request.id } };
        const priorRequest = { ...makeRow({ id: asId('prior-request'), data: {
          ...request.data, from: '2099-12-20', until: '2099-12-21', state: 'approved',
          schedule_source: 'prior', reserve_delivery: 'prior-delivery', sync: 'pending' } }),
          parent: { model: model('leave.Calendar'), id: calendar.id } };
        const priorPortion = { ...makeRow({ id: asId('prior-portion'), data: {
          allowance: { id: allowance.id }, days: '2', dates: ['2099-12-20', '2099-12-21'] } }),
          parent: { model: model('leave.Request'), id: priorRequest.id } };
        const writes: Array<{ kind: 'insert'; model: ModelName; row: StoredRow }> = [
          { kind: 'insert', model: model('rent_catalog.Location'), row: site },
          { kind: 'insert', model: model('rent_catalog.Location'), row: otherSite },
          { kind: 'insert', model: model('employee.Employee'), row: ownerWorker },
          { kind: 'insert', model: model('employee.Employee'), row: reviewerWorker },
          { kind: 'insert', model: model('leave.Calendar'), row: calendar },
          { kind: 'insert', model: model('leave.Allowance'), row: allowance },
          { kind: 'insert', model: model('leave.Request'), row: request },
          { kind: 'insert', model: model('leave.Portion'), row: portion },
        ];
        if (mode === 'shared-allowance-overdraw') writes.push({ kind: 'insert',
          model: model('leave.Portion'), row: secondPortion });
        if (mode === 'approved-portion-inserted-at-commit') writes.push({ kind: 'insert',
          model: model('leave.Request'), row: priorRequest });
        await backing.commit(makeBatch(await backing.readRevision(), { writes }));
        let injected = false;
        const originalCommit = backing.commit.bind(backing);
        Object.defineProperty(backing, 'commit', { value:
          async (batch: Parameters<typeof backing.commit>[0]) => {
            if (mode.endsWith('-at-commit') && !injected) {
              injected = true;
              if (mode === 'approved-portion-inserted-at-commit') {
                await originalCommit(makeBatch(await backing.readRevision(), { writes: [{
                  kind: 'insert', model: model('leave.Portion'), row: priorPortion }] }));
              } else {
                const changes: Record<string, [ModelName, string, Record<string, unknown>]> = {
                  'request-withdrawn-at-commit': [model('leave.Request'), request.id, { state: 'withdrawn' }],
                  'allowance-reduced-at-commit': [model('leave.Allowance'), allowance.id, { days: '1' }],
                  'portion-increased-at-commit': [model('leave.Portion'), portion.id, { days: '4' }],
                };
                const [name, id, data] = changes[mode]!;
                const current = await backing.load(name, asId(id)); assert.ok(current);
                await originalCommit(makeBatch(await backing.readRevision(), { writes: [{
                  kind: 'update', model: name, id: current.id, expectedVersion: current.version,
                  row: { ...current, version: asVersion(current.version + 1), updated: now,
                    data: { ...current.data, ...data } },
                }] }));
              }
            }
            return originalCommit(batch);
          } });
        const invoker = buildInvoker(artifact, asm, backing, { memberships: identities, now: () => now });
        const id = operationId();
        const approve = mode !== 'reject';
        const outcome = await invoker.invokeMutation({ operation: 'leave.decide', operation_id: id,
          inputs: { request: { id: request.id, version: String(mode === 'stale-version'
            ? request.version + 1 : request.version) }, approve, reason: 'Reviewed policy' } }, identity)
          .catch((error: unknown) => { throw new Error(`${mode}: ${error instanceof Error
            ? error.message : String(error)}`, { cause: error }); });
        const success = mode === 'approve' || mode === 'reject' || mode === 'uncharged-approve';
        const code = 'result' in outcome ? outcome.result.status : outcome.error.code;
        if (success) assert.equal(code, 'committed', `${mode}: ${JSON.stringify(outcome)}`);
        else assert.ok(['forbidden', 'rule_failed', 'conflict', 'validation'].includes(code),
          `${mode}: ${JSON.stringify(outcome)}`);
        const actual = await backing.load(model('leave.Request'), request.id);
        assert.ok(actual);
        assert.equal(actual.data.state, success ? approve ? 'approved' : 'rejected'
          : mode === 'request-withdrawn-at-commit' ? 'withdrawn' : 'pending', mode);
        assert.equal(actual.data.decision, success ? 'Reviewed policy' : null, mode);
        assert.equal(actual.data.schedule_source, success && approve ? id : null, mode);
        assert.equal(actual.data.sync, success && approve ? 'pending' : 'none', mode);
        assert.equal(actual.data.reserve_delivery === null, !(success && approve), mode);
        assert.equal(storageProbe.outboxAll().length, success && approve ? 1 : 0,
          `${mode}: outbox`);
        if (success && approve) {
          const intent = storageProbe.outboxAll()[0]!;
          assert.equal(intent.operation, 'leave.decide', mode);
          assert.equal(intent.operationId, id, mode);
          assert.equal(actual.data.reserve_delivery, intent.intentId, mode);
          assert.match(intent.target, /shift\.ScheduleV1\.reserve|StaffSchedule\.reserve/, mode);
          const argumentsValue = intent.arguments['arguments'] as Record<string, unknown>;
          const value = argumentsValue['value'] as Record<string, unknown>;
          assert.ok(value, `${mode}: reserve payload`);
          assert.equal(value['source'], id, mode);
          assert.deepEqual(value['employee'], { id: owner.user_id }, mode);
          assert.equal(value['location'], site.id, mode);
          assert.equal(value['from'], '2099-12-30T00:00:00.000Z', mode);
          assert.equal(value['until'], '2100-01-01T00:00:00.000Z', mode);
          assert.equal(value['skill'], 'absence', mode);
          assert.equal(value['kind'], 'absence', mode);
          assert.equal(String(value['revision']), '1', mode);
        }
        if (mode.endsWith('-at-commit')) assert.equal(injected, true, `${mode}: race hook reached`);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('claims the original reserve only while the approved Request remains current',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-leave-reserve-dispatch-'));
    try {
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
      for (const mode of ['current', 'withdrawn'] as const) {
        const identities = createMemoryIdentityStore({ clock: createFrozenClock(now) });
        const team = await identities.createTeam({ timezone: 'UTC' });
        const owner = await identities.createUser({ email: `owner-${mode}@leave-dispatch.test`,
          password_hash: 'unused', email_verified: true });
        const reviewer = await identities.createUser({ email: `reviewer-${mode}@leave-dispatch.test`,
          password_hash: 'unused', email_verified: true });
        await identities.createMembership({ team_id: team.team_id, user_id: owner.user_id,
          is_owner: false, roles: [] });
        await identities.createMembership({ team_id: team.team_id, user_id: reviewer.user_id,
          is_owner: false, roles: [{ role: 'leave.leave_reviewer',
            granted_at: new Date(now).toISOString(), granted_by: owner.user_id }] });
        const token = `leave-dispatch-${mode}-${randomBytes(8).toString('hex')}`;
        await identities.createSession({ user_id: reviewer.user_id,
          token_sha256: await sha256HexText(token), last_team_id: team.team_id,
          expires_at: new Date(now + 3600000).toISOString() });
        const identity = await resolveIdentity(identities, { session_token: token },
          { clock: createFrozenClock(now) });
        const scope = { app: 'CanLeave', owner: team.team_id, ownerPackage: 'leave' };
        const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app,
          stateStoreId: 'leave-dispatch-state', fileStoreId: 'leave-dispatch-files',
          receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
        const { store, probe } = createTestMemoryStorage(authority,
          [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({ artifact, asm, store, authority, scope,
          now: () => now, verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
        const site = { ...makeRow({ id: asId('site'), data: { name: 'Main', address: '1 Example Road',
          timezone: 'UTC', currency: 'EUR', hours: '09:00–18:00', arrival: 'Reception', active: true } }), parent: null };
        const employeeData = (userId: string) => ({ user: { id: userId }, name: 'Worker',
          home: { id: site.id }, locations: [], operator_wide: false, active: true,
          start: '2090-01-01', end: null, manager: null, role: 'worker', skills: [],
          private_notes: 'private', document: null });
        const ownerWorker = { ...makeRow({ id: asId('owner-employee'),
          data: employeeData(owner.user_id) }), parent: null };
        const reviewerWorker = { ...makeRow({ id: asId('reviewer-employee'),
          data: employeeData(reviewer.user_id) }), parent: null };
        const calendar = { ...makeRow({ id: asId('calendar'), data: {
          name: 'Working days', timezone: 'UTC', revision: '1' } }),
          parent: { model: model('employee.Employee'), id: ownerWorker.id } };
        const allowance = { ...makeRow({ id: asId('allowance'), data: {
          year: '2099', bucket: 'vacation', days: '3' } }),
          parent: { model: model('employee.Employee'), id: ownerWorker.id } };
        const request = { ...makeRow({ id: asId('request'), data: {
          location: { id: site.id }, from: '2099-12-30', until: '2099-12-31',
          bucket: 'vacation', reason: 'Year-end leave', reviewer: { id: reviewer.user_id },
          timezone: 'UTC', allowance_bucket: 'vacation', calendar_version: '1',
          schedule_revision: '1', state: 'pending', release_state: 'none', sync: 'none',
          reserve_delivery: null, release_delivery: null, decision: null, schedule_source: null } }),
          parent: { model: model('leave.Calendar'), id: calendar.id } };
        const portion = { ...makeRow({ id: asId('portion'), data: {
          allowance: { id: allowance.id }, days: '2', dates: ['2099-12-30', '2099-12-31'] } }),
          parent: { model: model('leave.Request'), id: request.id } };
        await store.commit(makeBatch(await store.readRevision(), { writes: [
          { kind: 'insert', model: model('rent_catalog.Location'), row: site },
          { kind: 'insert', model: model('employee.Employee'), row: ownerWorker },
          { kind: 'insert', model: model('employee.Employee'), row: reviewerWorker },
          { kind: 'insert', model: model('leave.Calendar'), row: calendar },
          { kind: 'insert', model: model('leave.Allowance'), row: allowance },
          { kind: 'insert', model: model('leave.Request'), row: request },
          { kind: 'insert', model: model('leave.Portion'), row: portion },
        ] }));
        const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
        const id = operationId();
        const admitted = await invoker.invokeMutation({ operation: 'leave.decide', operation_id: id,
          inputs: { request: { id: request.id, version: String(request.version) },
            approve: true, reason: 'Reviewed policy' } }, identity);
        assert.equal('result' in admitted ? admitted.result.status : admitted.error.code,
          'committed', `${mode}: ${JSON.stringify(admitted)}`);
        const intent = probe.outboxAll()[0];
        assert.ok(intent, `${mode}: reserve intent`);
        assert.equal(probe.outboxAll().length, 1, `${mode}: one reserve`);
        const frozen = structuredClone(intent.arguments);
        if (mode === 'withdrawn') {
          const current = await store.load(model('leave.Request'), request.id);
          assert.ok(current);
          await store.commit(makeBatch(await store.readRevision(), { writes: [{
            kind: 'update', model: model('leave.Request'), id: current.id,
            expectedVersion: current.version,
            row: { ...current, version: asVersion(current.version + 1), updated: now,
              data: { ...current.data, state: 'withdrawn' } },
          }] }));
        }
        const fenceFor = await bindNativeEmailDispatchGuards({ asm, artifact, store, identities,
          scope, revalidateAuthority: async () => true });
        const producers = await loadDispatchSystemProducers();
        const claim = createWorkDispatchClaimCommand((candidateId, target) =>
          candidateId === intent.intentId && target === intent.target);
        const commands = assembleDispatchCommands({ l3Commands: producers.l3Commands,
          workCommands: WORK_SYSTEM_COMMANDS.map(command => command.name === claim.name ? claim : command),
          stageCommands: WORK_DISPATCH_STAGE_COMMANDS });
        const joined = withDispatchJoinPort(store, await createWorkerDispatchJoinPort(store));
        const fence = fenceFor(intent);
        let providerCalls = 0;
        const result = await driveDispatchIntentWithPreclaim({
          store: joined, intent, actor: 'dispatch:leave.decide', operation: 'test.leave.reserve.dispatch',
          nowMs: () => now + 1000, nextClaimId: () => `claim-${mode}`,
          maxClaimAgeMs: 60000, claimOperationId: uuidv7(now + 1000, 1),
          recordOperationId: uuidv7(now + 1000, 2),
          evaluateGuard: () => { throw new Error('native guard was bypassed'); },
          readStateSnapshot: () => null,
          callProvider: async () => { providerCalls++; return { kind: 'delivered', result: { source: id } }; },
          classifyFailure, fence,
        }, (guard, allocator) => {
          const guarded = createWorkDispatchClaimCommand((candidateId, target) =>
            candidateId === intent.intentId && target === intent.target, guard, allocator);
          return producers.createSystemRegistry(commands.map(command =>
            command.name === claim.name ? guarded : command));
        });
        assert.equal(result.status, mode === 'current' ? 'recorded' : 'not-claimed',
          `${mode}: ${JSON.stringify(result)}`);
        if (result.status === 'not-claimed') assert.equal(result.reason, 'guard-false', mode);
        assert.equal(providerCalls, mode === 'current' ? 1 : 0, `${mode}: provider calls`);
        const retained = await store.outboxGet(intent.intentId);
        assert.deepEqual(retained?.intent.arguments, frozen, `${mode}: frozen source payload`);
        assert.equal(probe.outboxAll().length, 1, `${mode}: no duplicate reserve`);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
