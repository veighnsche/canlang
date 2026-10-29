/** Scheduled renewal uses current Account rows before guarded delivery. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import type { CompileArtifact, FileRetirementAuthority } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { STATE_FILE_REFERENCE_PRODUCER } from '@canlang/state/storage';
import { asId, asModel, asVersion, makeBatch, makeRow, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work/kernel/file-reference-inventory';
import { WORK_DISPATCH_STAGE_COMMANDS, WORK_SYSTEM_COMMANDS,
  createWorkDispatchClaimCommand } from '@canlang/work/kernel/commands';
import { classifyFailure } from '@canlang/work/receipt';
import { workSchedulePutCommand } from '@canlang/work/kernel/schedule-staging';
import { buildInvoker } from '../worker/assembly.js';
import { createBoundMailDispatcher } from './bound-dispatch.js';
import { installNativeFileInventory } from './file-inventory.js';
import { bindNativeEmailDispatchGuards, invokeDueScheduleCanonical,
  loadCanonicalDescriptors } from './invoke.js';
import { assembleModules } from './modules.js';
import { loadOpaqueFileStaging } from './opaque-file-staging.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const source = join(root, 'packages/cloudflare/test/fixtures/success-renewal-owner-probe.can');
const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');

const WHEN = 'event.account.version==event.revision and event.account.active and account_manager(event.account.manager) and can_work(event.account.manager,event.account.location)';

it('refuses altered renewal guard conjuncts and retargeted helper calls', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(root, 'packages/cloudflare/test/fixtures/.renewal-refusal-'));
  try {
    const original = await readFile(source, 'utf8');
    assert.equal(original.split(WHEN).length - 1, 1, 'original WHEN occurs exactly once');
    const variants = [
      { name: 'dropped-conjunct',
        source: original.replace(WHEN,
          'event.account.version==event.revision and event.account.active and account_manager(event.account.manager)') },
      { name: 'reordered-conjuncts',
        source: original.replace(WHEN,
          'event.account.active and event.account.version==event.revision and account_manager(event.account.manager) and can_work(event.account.manager,event.account.location)') },
    ];
    for (const variant of variants) {
      assert.notEqual(variant.source, original, variant.name);
      const path = join(directory, `${variant.name}.can`);
      await writeFile(path, variant.source);
      const result = spawnSync(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, path],
        { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      assert.equal(result.status, 10, `${variant.name}: ${result.stderr || result.stdout}`);
      const report = JSON.parse(result.stdout) as { sources: { sha256: string }[];
        diagnostics: { code: string; message: string; primary: { file: number; start: number; end: number } }[] };
      const mutatedWhen = variant.source.match(/when=(.*?) as notice/)?.[1];
      assert.ok(mutatedWhen, `${variant.name}: mutated SEND guard is present`);
      const guardStart = variant.source.indexOf(`when=${mutatedWhen}`) + 'when='.length;
      assert.ok(report.diagnostics.some(({ code, primary }) =>
        code === 'E6008' && primary.file === 0 && primary.start === guardStart &&
        primary.end === guardStart + mutatedWhen.length),
      `${variant.name}: original SEND guard loses its exact source proof`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('delivers renewal only from the current Account row and skips stale or unauthorized rows', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-success-renewal-'));
  try {
    const { stdout } = await promisify(execFile)(compiler,
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
      stdlibUrl: new URL('./stdlib.js', import.meta.url).href,
      uiUrl: import.meta.resolve('@canlang/ui') });
    assert.ok((artifact.modules[0]?.js ?? '').includes('sendWhen:'),
      'the original guarded Mail SEND is emitted');

    for (const mode of ['current-eligible', 'stale-version-location-archived',
      'role-missing', 'account-deactivated', 'role-revoked-at-dispatch',
      'employee-deactivated-at-dispatch'] as const) {
      const now = Date.now(), clock = createFrozenClock(now);
      const identities = createMemoryIdentityStore({ clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      const manager = await identities.createUser({ email: `manager-${mode}@success.test`,
        password_hash: 'unused', email_verified: true });
      const outsider = await identities.createUser({ email: `outsider-${mode}@success.test`,
        password_hash: 'unused', email_verified: true });
      const membership = await identities.createMembership({ team_id: team.team_id,
        user_id: manager.user_id, is_owner: false,
        roles: mode === 'role-missing' ? [] : [{
          role: 'success.account_manager', granted_at: new Date(now).toISOString(),
          granted_by: manager.user_id }] });
      await identities.createMembership({ team_id: team.team_id, user_id: outsider.user_id,
        is_owner: false, roles: [] });
      const scope = { app: 'SuccessProbe', owner: team.team_id, ownerPackage: 'success' };
      const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app,
        stateStoreId: 'renewal-state', fileStoreId: 'renewal-files',
        receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
      const { store, probe } = createTestMemoryStorage(authority,
        [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
      await installNativeFileInventory({ artifact, asm, store, authority, scope,
        now: () => now, verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });

      const customerId = asId('customer-1'), locationId = asId('location-1');
      const employeeId = asId('employee-1'), accountId = asId('account-1');
      const yesterday = new Date(now - 86400000).toISOString().slice(0, 10);
      await store.commit(makeBatch(await store.readRevision(), { writes: [
        { kind: 'insert' as const, model: asModel('customer.Customer'),
          row: { ...makeRow({ id: customerId, data: { name: 'Customer' } }), parent: null } },
        { kind: 'insert' as const, model: asModel('rent_catalog.Location'),
          row: { ...makeRow({ id: locationId, data: { name: 'Main site', timezone: 'UTC' } }), parent: null } },
        { kind: 'insert' as const, model: asModel('employee.Employee'),
          row: { ...makeRow({ id: employeeId, data: { user: { id: manager.user_id },
            home: { id: locationId }, locations: [], operator_wide: false, active: true } }), parent: null } },
        { kind: 'insert' as const, model: asModel('success.Account'),
          row: { ...makeRow({ id: accountId, data: { location: { id: locationId },
            manager: { id: manager.user_id }, email: 'manager@example.test', renewal: yesterday,
            active: mode !== 'account-deactivated' } }),
            parent: { model: asModel('customer.Customer'), id: customerId } } },
      ] }));

      const due = { key: accountId, scope, occurrenceId: 'renewal-1',
        event: 'success.RenewalDue', at: now - 1 };
      const payload = { account: { id: accountId, version: '1' }, revision: '1' };
      const stageContext = { actor: `schedule:${due.event}`, now, operation: 'success.renewal_due',
        load: (model: Parameters<typeof store.load>[0], id: Parameters<typeof store.load>[1]) => store.load(model, id),
        query: (spec: Parameters<typeof store.query>[0]) => store.query(spec) };
      const loaded = await loadCanonicalDescriptors(asm, artifact);
      assert.ok(loaded.valueTypes);
      const opaque = await loadOpaqueFileStaging({ store, inventoryOwner: scope.ownerPackage,
        artifact, canonicalModels: loaded.models, valueTypes: loaded.valueTypes,
        operations: new Map(), scope, verify: async () => {} });
      assert.ok(opaque);
      const declaration = opaque.event(due.event);
      const identity = await resolveIdentity(identities, { team_id: team.team_id }, { clock });
      const first = await workSchedulePutCommand.stage({ ...due, payload }, stageContext);
      const row = first.writes?.find(write => write.kind === 'insert' &&
        write.model === 'work.schedule' && write.row.id === due.occurrenceId);
      assert.ok(row && row.kind === 'insert');
      const filePayloadOrigin = await opaque.prepare({ expectedRevision: await store.readRevision(),
        model: asModel('work.schedule'), row: row.row, field: 'payload', scope,
        origin: { kind: 'event-input', occurrenceId: due.occurrenceId,
          sourceOccurrence: due.occurrenceId, declaration,
          lineage: { kind: 'schedule', key: due.key, replaces: row.row.data['replaces'] as null },
          target: { kind: 'schedule' } },
        projection: { kind: 'inputs', path: [], declarationId: declaration.inputsDeclarationId },
        value: payload, identity });
      const scheduled = await workSchedulePutCommand.stage({ ...due, payload, filePayloadOrigin }, stageContext);
      await store.commit(makeBatch(await store.readRevision(), {
        writes: scheduled.writes ?? [], schedules: scheduled.schedules ?? [],
      }));

      const stageDenied = mode === 'role-missing' || mode === 'account-deactivated';
      const result = await invokeDueScheduleCanonical({ asm, artifact, app: scope.app,
        handler: 'success.renewal_due', due, store, identities, now: () => now });
      const expected = stageDenied ? 0 : 1;
      assert.equal(result.status, 'completed', `${mode}: ${JSON.stringify(result)}`);
      const intents = probe.outboxAll();
      assert.equal(intents.length, expected, `${mode}: Mail intents`);
      const notices = await store.query({ model: asModel('success.Notice'), authority: 'owner' });
      assert.equal(notices.length, expected, `${mode}: Notice writes`);
      if (stageDenied) continue;
      if (mode === 'stale-version-location-archived') {
        const account = await store.load(asModel('success.Account'), accountId);
        assert.ok(account);
        await store.commit(makeBatch(await store.readRevision(), { writes: [{
          kind: 'update', model: asModel('success.Account'), id: account.id,
          expectedVersion: account.version,
          row: { ...account, version: asVersion(account.version + 1), updated: now,
            data: { ...account.data } } }] }));
        const location = await store.load(asModel('rent_catalog.Location'), locationId);
        assert.ok(location);
        await store.commit(makeBatch(await store.readRevision(), { writes: [{
          kind: 'update', model: asModel('rent_catalog.Location'), id: location.id,
          expectedVersion: location.version,
          row: { ...location, archivedAt: now, updated: now } }] }));
      }
      if (mode === 'role-revoked-at-dispatch') {
        await identities.setMembershipRoles(membership.membership_id, []);
      }
      if (mode === 'employee-deactivated-at-dispatch') {
        const current = await store.load(asModel('employee.Employee'), employeeId);
        assert.ok(current);
        await store.commit(makeBatch(await store.readRevision(), { writes: [{
          kind: 'update', model: asModel('employee.Employee'), id: current.id,
          expectedVersion: current.version,
          row: { ...current, version: asVersion(current.version + 1), updated: now,
            data: { ...current.data, active: false } } }] }));
      }
      {
        const intent = intents[0]!;
        const request = intent.arguments['arguments'] as Record<string, unknown> | undefined;
        assert.equal(request?.['to'], 'manager@example.test');
        assert.equal(request?.['subject'], 'Account renewal due');
        assert.equal(request?.['body'],
          'Review the recorded renewal date; renewal remains a separate agreement action.');
        const fenceFor = await bindNativeEmailDispatchGuards({ asm, artifact, store,
          identities, scope, revalidateAuthority: async () => true });
        let providerCalls = 0;
        const adapter: Parameters<typeof createBoundMailDispatcher>[0]['adapter'] = {
          available: () => true, userRecipient: () => null,
          recipientActive: async () => true, resolveRecipient: async () => null,
          callProvider: async () => {
            providerCalls++;
            return { kind: 'delivered', result: null };
          },
          reconcile: async () => null,
        };
        const dispatcher = await createBoundMailDispatcher({ store, adapter,
          workCommands: WORK_SYSTEM_COMMANDS, stageCommands: WORK_DISPATCH_STAGE_COMMANDS,
          createClaimCommand: createWorkDispatchClaimCommand });
        const dispatched = await dispatcher.drive({ intentId: intent.intentId,
          actor: `dispatch:${due.event}`, operation: 'test.success.dispatch',
          nowMs: () => now + 1, nextClaimId: () => `claim-${mode}`,
          maxClaimAgeMs: 60000, claimOperationId: uuidv7(now + 1, 1),
          recordOperationId: uuidv7(now + 1, 2), classifyFailure,
          evaluateGuard: () => { throw new Error('native guard was bypassed'); },
          readStateSnapshot: () => null, fence: fenceFor(intent) });
        if (mode === 'current-eligible') {
          assert.equal(dispatched.status, 'claimed', `${mode}: ${JSON.stringify(dispatched)}`);
          assert.equal(providerCalls, 1, `${mode}: one provider call`);
        } else {
          assert.equal(dispatched.status, 'not-claimed', `${mode}: ${JSON.stringify(dispatched)}`);
          if (dispatched.status === 'not-claimed') assert.equal(dispatched.reason, 'guard-false', mode);
          assert.equal(providerCalls, 0, `${mode}: no stale provider call`);
        }
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
