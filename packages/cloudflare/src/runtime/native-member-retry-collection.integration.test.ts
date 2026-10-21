/** The published CanMember retry source keeps one charge bound to its current term. */
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
const source = join(root, 'packages/cloudflare/test/fixtures/member-retry-collection-owner-probe.can');
const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
const model = (name: string) => asModel(name);
const now = Date.parse('2099-01-01T12:00:00.000Z');
const money = { minor: '2500', currency: 'EUR' };

function operationId(): string {
  const time = now.toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-8${random.slice(4, 7)}-${random.slice(7, 19)}`;
}

it('retries the exact term invoice for its manager, account owner, or billing grant, with current evidence only',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-member-retry-'));
    try {
      const probe = await readFile(source, 'utf8');
      const original = await readFile(join(root, 'draft/apps/CanMember/CanMember.can'), 'utf8');
      const start = original.indexOf('  scenario retry_collection(');
      const end = original.indexOf('  scenario settlement ', start);
      assert.ok(start >= 0 && end > start);
      for (const line of original.slice(start, end).trimEnd().split('\n')) {
        assert.ok(probe.includes(line), `retry_collection retains original source: ${line.slice(0, 90)}`);
      }
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
      const modes = [
        'account-owner', 'billing-grant', 'manager-hidden-employee', 'unknown-state',
        'automatic-current', 'replay', 'no-role', 'inactive-billing-grant',
        'manager-wrong-location', 'manager-inactive', 'confirmed-state',
        'cancelled-term', 'expired-term', 'empty-locations', 'stale-term',
        'term-confirmed-at-commit', 'membership-revoked-at-commit',
        'billing-grant-revoked-at-commit', 'employee-moved-at-commit',
      ] as const;
      for (const mode of modes) {
        const identities = createMemoryIdentityStore({ clock: createFrozenClock(now) });
        const team = await identities.createTeam({ timezone: 'UTC' });
        const account = await identities.createUser({ email: `account-${mode}@member-retry.test`,
          password_hash: 'unused', email_verified: true });
        const actor = await identities.createUser({ email: `actor-${mode}@member-retry.test`,
          password_hash: 'unused', email_verified: true });
        const manager = ['manager-hidden-employee', 'manager-wrong-location', 'manager-inactive',
          'employee-moved-at-commit'].includes(mode);
        await identities.createMembership({ team_id: team.team_id, user_id: account.user_id,
          is_owner: false, roles: [] });
        await identities.createMembership({ team_id: team.team_id, user_id: actor.user_id,
          is_owner: false, roles: manager ? [{ role: 'member_terms.member_manager',
            granted_at: new Date(now).toISOString(), granted_by: account.user_id }] : [] });
        const token = `member-retry-${mode}-${randomBytes(8).toString('hex')}`;
        await identities.createSession({ user_id: actor.user_id,
          token_sha256: await sha256HexText(token), last_team_id: team.team_id,
          expires_at: new Date(now + 3600000).toISOString() });
        const identity = await resolveIdentity(identities, { session_token: token },
          { clock: createFrozenClock(now) });
        const authority: FileRetirementAuthority = { app: 'CanMember', stateOwner: 'CanMember',
          stateStoreId: 'member-retry-state', fileStoreId: 'member-retry-files',
          receiver: { app: 'CanMember', owner: team.team_id, team: team.team_id } };
        const { store: backing, probe: storageProbe } = createTestMemoryStorage(authority,
          [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({ artifact, asm, store: backing, authority,
          scope: { app: 'CanMember', owner: team.team_id, ownerPackage: 'member_terms' },
          now: () => now, verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
        const site = { ...makeRow({ id: asId('site'), data: { active: true } }), parent: null };
        const otherSite = { ...makeRow({ id: asId('other-site'), data: { active: true } }), parent: null };
        const customer = { ...makeRow({ id: asId('customer'), data: { kind: 'company', active: true } }), parent: null };
        const membership = { ...makeRow({ id: asId('membership'), data: {
          account: { id: mode === 'account-owner' || mode === 'unknown-state' ||
            mode === 'automatic-current' || mode === 'replay' || mode === 'confirmed-state' ||
            mode === 'cancelled-term' || mode === 'expired-term' || mode === 'empty-locations' ||
            mode === 'stale-term' || mode === 'term-confirmed-at-commit' ||
            mode === 'membership-revoked-at-commit' ? actor.user_id : account.user_id },
          revoked: false, recurrence: true, consent: 'consent-v1',
          cancellation_at: null, timezone: 'UTC' } }),
          parent: { model: model('customer.Customer'), id: customer.id } };
        const term = { ...makeRow({ id: asId('term'), data: {
          source: 'membership:customer:cycle-1', from: '2098-12-01T10:00:00.000Z',
          until: mode === 'expired-term' ? '2098-12-31T00:00:00.000Z' : '2099-02-01T00:00:00.000Z',
          price: money, locations: mode === 'empty-locations' ? [] : [{ id: site.id }],
          collection: mode === 'confirmed-state' ? 'confirmed' : mode === 'unknown-state' ? 'unknown' : 'failed',
          charge_delivery: 'prior-charge-delivery',
          cancellation: mode === 'cancelled-term' ? 'pending' : 'none',
          title: 'Membership January', automatic: mode === 'automatic-current', consent: 'consent-v1' } }),
          parent: { model: model('member_terms.Membership'), id: membership.id } };
        const role = { ...makeRow({ id: asId('billing-role'), data: {
          account: { id: actor.user_id }, role: 'billing',
          active: mode !== 'inactive-billing-grant', hidden: true } }),
          parent: { model: model('customer.Customer'), id: customer.id } };
        const employee = { ...makeRow({ id: asId('employee'), data: {
          user: { id: actor.user_id },
          home: { id: mode === 'manager-wrong-location' ? otherSite.id : site.id },
          locations: [], operator_wide: false, active: mode !== 'manager-inactive', hidden: true } }),
          parent: null };
        const writes: Array<{ kind: 'insert'; model: ModelName; row: StoredRow }> = [
          { kind: 'insert', model: model('rent_catalog.Location'), row: site },
          { kind: 'insert', model: model('rent_catalog.Location'), row: otherSite },
          { kind: 'insert', model: model('customer.Customer'), row: customer },
          { kind: 'insert', model: model('member_terms.Membership'), row: membership },
          { kind: 'insert', model: model('member_terms.Term'), row: term },
        ];
        if (manager) writes.push({ kind: 'insert', model: model('employee.Employee'), row: employee });
        if (mode === 'billing-grant' || mode === 'inactive-billing-grant' ||
            mode === 'billing-grant-revoked-at-commit') writes.push({ kind: 'insert',
          model: model('customer.CompanyRole'), row: role });
        await backing.commit(makeBatch(await backing.readRevision(), { writes }));
        let injected = false;
        const originalCommit = backing.commit.bind(backing);
        Object.defineProperty(backing, 'commit', { value:
          async (batch: Parameters<typeof backing.commit>[0]) => {
            if (mode.endsWith('-at-commit') && !injected) {
              injected = true;
              const changes: Record<string, [ModelName, string, Record<string, unknown>]> = {
                'term-confirmed-at-commit': [model('member_terms.Term'), term.id, { collection: 'confirmed' }],
                'membership-revoked-at-commit': [model('member_terms.Membership'), membership.id, { revoked: true }],
                'billing-grant-revoked-at-commit': [model('customer.CompanyRole'), role.id, { active: false }],
                'employee-moved-at-commit': [model('employee.Employee'), employee.id, { home: { id: otherSite.id } }],
              };
              const [name, rowId, data] = changes[mode]!;
              const current = await backing.load(name, asId(rowId)); assert.ok(current);
              await originalCommit(makeBatch(await backing.readRevision(), { writes: [{
                kind: 'update', model: name, id: current.id, expectedVersion: current.version,
                row: { ...current, version: asVersion(current.version + 1), updated: now,
                  data: { ...current.data, ...data } },
              }] }));
            }
            return originalCommit(batch);
          } });
        const invoker = buildInvoker(artifact, asm, backing, { memberships: identities, now: () => now });
        const id = operationId();
        const request = { operation: 'member_terms.retry_collection', operation_id: id,
          inputs: { term: { id: term.id, version: String(mode === 'stale-term'
            ? term.version + 1 : term.version) } } };
        const outcome = await invoker.invokeMutation(request, identity)
          .catch((error: unknown) => { throw new Error(`${mode}: ${error instanceof Error
            ? error.message : String(error)}`, { cause: error }); });
        const success = ['account-owner', 'billing-grant', 'manager-hidden-employee',
          'unknown-state', 'automatic-current', 'replay',
          'membership-revoked-at-commit'].includes(mode);
        const queued = success && mode !== 'membership-revoked-at-commit';
        const code = 'result' in outcome ? outcome.result.status : outcome.error.code;
        if (success) assert.equal(code, 'committed', `${mode}: ${JSON.stringify(outcome)}`);
        else assert.ok(['forbidden', 'rule_failed', 'conflict'].includes(code),
          `${mode}: ${JSON.stringify(outcome)}`);
        const actual = await backing.load(model('member_terms.Term'), term.id); assert.ok(actual);
        assert.equal(actual.data.collection, success ? 'pending' :
          mode === 'term-confirmed-at-commit' || mode === 'confirmed-state' ? 'confirmed' :
            mode === 'unknown-state' ? 'unknown' : 'failed', mode);
        assert.equal(storageProbe.outboxAll().length, queued ? 1 : 0, `${mode}: charge outbox`);
        if (queued) {
          const intent = storageProbe.outboxAll()[0]!;
          assert.equal(intent.operation, 'member_terms.retry_collection', mode);
          assert.equal(intent.operationId, id, mode);
          assert.equal(actual.data.charge_delivery, intent.intentId, mode);
          assert.match(intent.target, /invoice\.BillingV1\.charge/, mode);
          const value = (intent.arguments['arguments'] as Record<string, unknown>)['value'] as Record<string, unknown>;
          assert.equal(value['source'], term.data.source, mode);
          assert.equal(value['customer'], customer.id, mode);
          assert.equal(value['location'], site.id, mode);
          assert.equal(value['description'], term.data.title, mode);
          assert.deepEqual(value['amount'], money, mode);
          assert.equal(value['due'], '2098-12-01', mode);
          assert.equal(value['issuer'], null, mode);
          assert.equal(value['terms'], null, mode);
          assert.equal(value['consent'], term.data.consent, mode);
          const [line] = value['items'] as Array<Record<string, unknown>>;
          assert.equal(line?.['title'], term.data.title, mode);
          assert.equal(String(line?.['quantity']), '1', mode);
          assert.deepEqual(line?.['price'], money, mode);
          assert.deepEqual(line?.['tax'], { minor: '0', currency: 'EUR' }, mode);
          assert.deepEqual(line?.['discount'], { minor: '0', currency: 'EUR' }, mode);
          assert.equal(line?.['unit'], 'term', mode);
          assert.equal(line?.['from'], term.data.from, mode);
          assert.equal(line?.['until'], term.data.until, mode);
          assert.equal(line?.['location'], site.id, mode);
          assert.equal(line?.['reference'], term.data.source, mode);
          if (mode === 'replay') {
            const replay = await invoker.invokeMutation(request, identity);
            assert.ok('result' in replay, JSON.stringify(replay));
            assert.equal(replay.result.status, 'replayed');
            assert.equal(storageProbe.outboxAll().length, 1, 'replay adds no duplicate charge');
            const duplicate = await invoker.invokeMutation({ ...request,
              operation_id: operationId(),
              inputs: { term: { id: term.id, version: String(actual.version) } } }, identity);
            assert.equal('result' in duplicate ? duplicate.result.status : duplicate.error.code,
              'rule_failed', `new operation cannot retry a pending charge: ${JSON.stringify(duplicate)}`);
            assert.equal(storageProbe.outboxAll().length, 1, 'new operation adds no duplicate charge');
          }
        } else if (mode === 'membership-revoked-at-commit') {
          assert.match(String(actual.data.charge_delivery), /^skp_/,
            `${mode}: skipped delivery is recorded`);
        } else {
          assert.equal(actual.data.charge_delivery, 'prior-charge-delivery', mode);
        }
        if (mode.endsWith('-at-commit')) assert.equal(injected, true, `${mode}: race hook reached`);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('calls Billing.charge only while the original term and membership still permit collection',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-member-retry-dispatch-'));
    try {
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
      for (const mode of ['current', 'term-cancelled', 'membership-revoked',
        'recurrence-disabled', 'consent-changed', 'cancellation-effective'] as const) {
        const identities = createMemoryIdentityStore({ clock: createFrozenClock(now) });
        const team = await identities.createTeam({ timezone: 'UTC' });
        const actor = await identities.createUser({ email: `owner-${mode}@member-dispatch.test`,
          password_hash: 'unused', email_verified: true });
        await identities.createMembership({ team_id: team.team_id, user_id: actor.user_id,
          is_owner: false, roles: [] });
        const token = `member-dispatch-${mode}-${randomBytes(8).toString('hex')}`;
        await identities.createSession({ user_id: actor.user_id,
          token_sha256: await sha256HexText(token), last_team_id: team.team_id,
          expires_at: new Date(now + 3600000).toISOString() });
        const identity = await resolveIdentity(identities, { session_token: token },
          { clock: createFrozenClock(now) });
        const scope = { app: 'CanMember', owner: team.team_id, ownerPackage: 'member_terms' };
        const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app,
          stateStoreId: 'member-dispatch-state', fileStoreId: 'member-dispatch-files',
          receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
        const { store, probe } = createTestMemoryStorage(authority,
          [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({ artifact, asm, store, authority, scope,
          now: () => now, verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
        const site = { ...makeRow({ id: asId('site'), data: { active: true } }), parent: null };
        const customer = { ...makeRow({ id: asId('customer'), data: { kind: 'company', active: true } }), parent: null };
        const membership = { ...makeRow({ id: asId('membership'), data: {
          account: { id: actor.user_id }, revoked: false, recurrence: true,
          consent: 'consent-v1', cancellation_at: null, timezone: 'UTC' } }),
          parent: { model: model('customer.Customer'), id: customer.id } };
        const term = { ...makeRow({ id: asId('term'), data: {
          source: 'membership:customer:cycle-1', from: '2098-12-01T10:00:00.000Z',
          until: '2099-02-01T00:00:00.000Z', price: money, locations: [{ id: site.id }],
          collection: 'unknown', charge_delivery: 'prior-charge-delivery',
          cancellation: 'none', title: 'Membership January', automatic: true,
          consent: 'consent-v1' } }),
          parent: { model: model('member_terms.Membership'), id: membership.id } };
        await store.commit(makeBatch(await store.readRevision(), { writes: [
          { kind: 'insert', model: model('rent_catalog.Location'), row: site },
          { kind: 'insert', model: model('customer.Customer'), row: customer },
          { kind: 'insert', model: model('member_terms.Membership'), row: membership },
          { kind: 'insert', model: model('member_terms.Term'), row: term },
        ] }));
        const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
        const id = operationId();
        const admitted = await invoker.invokeMutation({ operation: 'member_terms.retry_collection',
          operation_id: id, inputs: { term: { id: term.id, version: String(term.version) } } }, identity);
        assert.equal('result' in admitted ? admitted.result.status : admitted.error.code,
          'committed', `${mode}: ${JSON.stringify(admitted)}`);
        const intent = probe.outboxAll()[0];
        assert.ok(intent, `${mode}: original charge intent`);
        assert.equal(probe.outboxAll().length, 1, `${mode}: one charge`);
        const frozen = structuredClone(intent.arguments);
        if (mode !== 'current') {
          const targetModel = mode === 'term-cancelled' ? model('member_terms.Term') : model('member_terms.Membership');
          const targetId = mode === 'term-cancelled' ? term.id : membership.id;
          const current = await store.load(targetModel, targetId); assert.ok(current);
          const change: Record<string, unknown> = {
            'term-cancelled': { cancellation: 'pending' },
            'membership-revoked': { revoked: true },
            'recurrence-disabled': { recurrence: false },
            'consent-changed': { consent: 'consent-v2' },
            'cancellation-effective': { cancellation_at: '2098-11-01T00:00:00.000Z' },
          }[mode] as Record<string, unknown>;
          await store.commit(makeBatch(await store.readRevision(), { writes: [{
            kind: 'update', model: targetModel, id: current.id,
            expectedVersion: current.version,
            row: { ...current, version: asVersion(current.version + 1), updated: now,
              data: { ...current.data, ...change } },
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
          store: joined, intent, actor: 'dispatch:member_terms.retry_collection',
          operation: 'test.member.retry.dispatch', nowMs: () => now + 1000,
          nextClaimId: () => `claim-${mode}`, maxClaimAgeMs: 60000,
          claimOperationId: uuidv7(now + 1000, 1),
          recordOperationId: uuidv7(now + 1000, 2),
          evaluateGuard: () => { throw new Error('native guard was bypassed'); },
          readStateSnapshot: () => null,
          callProvider: async () => { providerCalls++; return { kind: 'delivered',
            result: { source: term.data.source } }; },
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
        assert.deepEqual(retained?.intent.arguments, frozen, `${mode}: immutable charge payload`);
        assert.equal(probe.outboxAll().length, 1, `${mode}: no duplicate charge`);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
