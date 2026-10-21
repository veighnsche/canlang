/** The original collection source owns one current balance, payment attempt, and settlement. */
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { StorageConstraintError } from '@canlang/state/storage/port';
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
const source = join(root, 'packages/cloudflare/test/fixtures/invoice-collect-owner-probe.can');
const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
const model = (name: string) => asModel(name);
const money = (minor: string) => ({ minor, currency: 'EUR' });
const now = Date.parse('2099-01-01T12:00:00.000Z');

function operationId(): string {
  const time = now.toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-8${random.slice(4, 7)}-${random.slice(7, 19)}`;
}

it('refuses altered collection authority, financial queries, guarded SEND, and settlement',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-invoice-collect-mutants-'));
    try {
      const original = await readFile(source, 'utf8');
      const variants = [
        ['authority', 'has_role(actor,invoice.parent,billing) or owns(actor,invoice.parent)',
          'owns(actor,invoice.parent)'],
        ['pending-attempt', 'attempt.kind==collection and (attempt.status in [pending,unknown] or (attempt.status==failed and attempt.failure==permanent))',
          'attempt.kind==collection and (attempt.status==pending or (attempt.status==failed and attempt.failure==permanent))'],
        ['received', 'attempt.kind==collection and attempt.status==succeeded select attempt.amount',
          'attempt.kind==refund and attempt.status==succeeded select attempt.amount'],
        ['balance', 'row.total-row.credits-row.received', 'row.total-row.received'],
        ['create', 'reference=operation.id,amount=invoice.balance,kind=collection',
          'reference=operation.id,amount=invoice.total,kind=collection'],
        ['send-guard', 'when=invoice.state==issued and invoice.balance==attempt.amount and not attempt.disabled',
          'when=invoice.state==issued and invoice.balance==attempt.amount'],
        ['send-request', 'customer=invoice.parent.id,amount=attempt.amount,reference=attempt.reference,consent=null',
          'customer=invoice.parent.id,amount=invoice.total,reference=attempt.reference,consent=null'],
        ['settlement', 'collection_pending=any(invoice.Attempt as attempt,attempt.kind==collection',
          'collection_pending=any(invoice.Attempt as attempt,attempt.kind==refund'],
      ] as const;
      for (const [name, before, after] of variants) {
        assert.equal(original.split(before).length, 2, `${name}: unique original source`);
        const path = join(directory, `${name}.can`);
        await writeFile(path, original.replace(before, after));
        const result = spawnSync(compiler,
          ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, path],
          { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
        assert.equal(result.status, 10, `${name}: ${result.stderr || result.stdout}`);
        const report = JSON.parse(result.stdout) as { diagnostics: { code: string }[] };
        assert.ok(report.diagnostics.some(diagnostic => diagnostic.code === 'E6008'),
          `${name}: changed original owner must lose native receipt`);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('collects the current invoice balance from owner-complete evidence and emits settlement',
  { timeout: 180000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-invoice-collect-'));
    try {
      const probe = await readFile(source, 'utf8');
      const original = await readFile(join(root, 'draft/apps/CanInvoice/CanInvoice.can'), 'utf8');
      const start = original.indexOf('  scenario collect(');
      const end = original.indexOf('   examples seed=', start);
      assert.ok(start >= 0 && end > start);
      assert.ok(probe.includes(original.slice(start, end).trimEnd()), 'original collect handler is retained');
      for (const prefix of ['derive settlement(', 'derive Invoice.credits:',
        'derive Invoice.received:', 'derive Invoice.refunded:', 'derive Invoice.balance:']) {
        const line = original.split('\n').find(value => value.includes(prefix));
        assert.ok(line && probe.includes(line.trim().split(' label=')[0]!),
          `${prefix} expression is retained`);
      }
      for (const [file, prefix] of [
        ['draft/apps/CanCustomer/CanCustomer.can', 'export derive has_role('],
        ['draft/apps/CanCustomer/CanCustomer.can', 'export derive owns('],
        ['draft/shared/Employees.can', 'export derive can_work('],
      ] as const) {
        const text = await readFile(join(root, file), 'utf8');
        const line = text.split('\n').find(value => value.includes(prefix));
        assert.ok(line && probe.includes(line.trim()), `${prefix} is retained`);
      }
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
        uiUrl: import.meta.resolve('@canlang/ui') });

      for (const mode of [
        'billing-hidden', 'individual-owner', 'finance-worker', 'partial-ledger', 'transient-failed',
        'pending-hidden', 'unknown-hidden', 'permanent-failed', 'zero-balance', 'void-invoice',
        'no-authority', 'wrong-worker', 'inactive-worker',
        'pending-at-commit', 'balance-at-commit', 'billing-revoked-at-commit',
      ] as const) {
        const identities = createMemoryIdentityStore({ clock: createFrozenClock(now) });
        const team = await identities.createTeam({ timezone: 'UTC' });
        const actor = await identities.createUser({ email: `actor-${mode}@invoice-collect.test`,
          password_hash: 'unused', email_verified: true });
        const finance = mode === 'finance-worker' || mode === 'wrong-worker' ||
          mode === 'inactive-worker';
        await identities.createMembership({ team_id: team.team_id, user_id: actor.user_id,
          is_owner: false, roles: finance ? [{ role: 'invoice.finance',
            granted_at: new Date(now).toISOString(), granted_by: actor.user_id }] : [] });
        const token = `invoice-collect-${mode}-${randomBytes(8).toString('hex')}`;
        await identities.createSession({ user_id: actor.user_id,
          token_sha256: await sha256HexText(token), last_team_id: team.team_id,
          expires_at: new Date(now + 3600000).toISOString() });
        const identity = await resolveIdentity(identities, { session_token: token },
          { clock: createFrozenClock(now) });
        const scope = { app: 'CanInvoice', owner: team.team_id, ownerPackage: 'invoice' };
        const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app,
          stateStoreId: 'invoice-collect-state', fileStoreId: 'invoice-collect-files',
          receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
        const { store, probe: storageProbe } = createTestMemoryStorage(authority,
          [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({ artifact, asm, store, authority, scope,
          now: () => now, verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
        const location = { ...makeRow({ id: asId('site'), data: { active: true } }), parent: null };
        const otherLocation = { ...makeRow({ id: asId('other-site'), data: { active: true } }), parent: null };
        const customer = { ...makeRow({ id: asId('customer'), data: {
          kind: mode === 'individual-owner' ? 'individual' : 'company', hidden: false } }), parent: null };
        const invoice = { ...makeRow({ id: asId('invoice'), data: {
          location: { id: location.id }, source: 'invoice-source', currency: 'EUR',
          state: mode === 'void-invoice' ? 'void' : 'issued', total: money('10000'),
          next_collection: new Date(now + 86400000).toISOString(), ledger_revision: '7', hidden: false } }),
          parent: { model: model('customer.Customer'), id: customer.id } };
        const billing = { ...makeRow({ id: asId('billing-role'), data: {
          account: { id: actor.user_id }, role: 'billing', active: true, hidden: true } }),
          parent: { model: model('customer.Customer'), id: customer.id } };
        const contact = { ...makeRow({ id: asId('contact'), data: {
          account: { id: actor.user_id }, verified: true, hidden: true } }),
          parent: { model: model('customer.Customer'), id: customer.id } };
        const employee = { ...makeRow({ id: asId('employee'), data: {
          user: { id: actor.user_id },
          home: { id: mode === 'wrong-worker' ? otherLocation.id : location.id },
          locations: [], operator_wide: false, active: mode !== 'inactive-worker', hidden: true } }),
          parent: null };
        const priorStatus = mode === 'pending-hidden' || mode === 'pending-at-commit' ? 'pending' :
          mode === 'unknown-hidden' ? 'unknown' :
          mode === 'permanent-failed' || mode === 'transient-failed' ? 'failed' : 'succeeded';
        const prior = { ...makeRow({ id: asId('prior-attempt'), data: {
          reference: 'prior-attempt', amount: money(mode === 'partial-ledger' ? '3000' : '1000'),
          kind: 'collection', status: priorStatus,
          failure: mode === 'permanent-failed' ? 'permanent' :
            mode === 'transient-failed' ? 'transient' : null,
          disabled: false, delivery: 'prior-delivery', hidden: true } }),
          parent: { model: model('invoice.Invoice'), id: invoice.id } };
        const credit = { ...makeRow({ id: asId('credit'), data: {
          amount: money(mode === 'zero-balance' ? '10000' : '2000'), hidden: true } }),
          parent: { model: model('invoice.Invoice'), id: invoice.id } };
        const payment = { ...makeRow({ id: asId('external-payment'), data: {
          amount: money('1000'), hidden: true } }),
          parent: { model: model('invoice.Invoice'), id: invoice.id } };
        const writes: Array<{ kind: 'insert'; model: ModelName; row: StoredRow }> = [
          { kind: 'insert', model: model('rent_catalog.Location'), row: location },
          { kind: 'insert', model: model('rent_catalog.Location'), row: otherLocation },
          { kind: 'insert', model: model('customer.Customer'), row: customer },
          { kind: 'insert', model: model('invoice.Invoice'), row: invoice },
        ];
        if (!finance && mode !== 'individual-owner' && mode !== 'no-authority') writes.push({
          kind: 'insert', model: model('customer.CompanyRole'), row: billing });
        if (mode === 'individual-owner') writes.push({
          kind: 'insert', model: model('customer.Contact'), row: contact });
        if (finance) writes.push({ kind: 'insert', model: model('employee.Employee'), row: employee });
        if (['pending-hidden', 'unknown-hidden', 'permanent-failed', 'transient-failed',
          'partial-ledger'].includes(mode)) writes.push({
          kind: 'insert', model: model('invoice.Attempt'), row: prior });
        if (mode === 'zero-balance' || mode === 'partial-ledger') writes.push({
          kind: 'insert', model: model('invoice.Credit'), row: credit });
        if (mode === 'partial-ledger') writes.push({
          kind: 'insert', model: model('invoice.ExternalPayment'), row: payment });
        await store.commit(makeBatch(await store.readRevision(), { writes }));
        let injected = false;
        if (mode.endsWith('-at-commit')) {
          const commit = store.commit.bind(store);
          Object.defineProperty(store, 'commit', { value: async (batch: Parameters<typeof store.commit>[0]) => {
            if (!injected && batch.outbox.length > 0) {
              injected = true;
              if (mode === 'billing-revoked-at-commit') {
                const current = await store.load(model('customer.CompanyRole'), billing.id);
                assert.ok(current);
                await commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update',
                  model: model('customer.CompanyRole'), id: current.id, expectedVersion: current.version,
                  row: { ...current, version: asVersion(current.version + 1), updated: now,
                    data: { ...current.data, active: false } },
                }] }));
              } else await commit(makeBatch(await store.readRevision(), { writes: [{
                kind: 'insert', model: mode === 'balance-at-commit' ? model('invoice.Credit') :
                  model('invoice.Attempt'), row: mode === 'balance-at-commit'
                  ? { ...credit, id: asId('race-credit'), data: { amount: money('10000'), hidden: true } }
                  : { ...prior, id: asId('race-attempt'), data: { ...prior.data,
                    reference: 'race-attempt', status: 'pending' } },
              }] }));
            }
            return commit(batch);
          } });
        }
        const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
        const id = operationId();
        const outcome = await invoker.invokeMutation({ operation: 'invoice.collect',
          operation_id: id, inputs: { invoice: { id: invoice.id, version: String(invoice.version) } } },
        identity);
        const success = ['billing-hidden', 'individual-owner', 'finance-worker',
          'partial-ledger', 'transient-failed'].includes(mode);
        const code = 'result' in outcome ? outcome.result.status : outcome.error.code;
        if (success) assert.equal(code, 'committed', `${mode}: ${JSON.stringify(outcome)}`);
        else assert.ok(['forbidden', 'rule_failed', 'conflict'].includes(code),
          `${mode}: ${JSON.stringify(outcome)}`);
        const current = await store.load(model('invoice.Invoice'), invoice.id); assert.ok(current);
        assert.equal(current.data['ledger_revision'], success ? '8' : '7', mode);
        assert.equal(current.data['next_collection'], success ? null : invoice.data.next_collection, mode);
        const attempts = await store.query({ model: model('invoice.Attempt'),
          parent: { model: model('invoice.Invoice'), id: invoice.id }, authority: 'owner' });
        const created = attempts.filter(row => row.data['reference'] === id);
        assert.equal(created.length, success ? 1 : 0, `${mode}: one original Attempt`);
        const intents = storageProbe.outboxAll();
        assert.equal(intents.length, success ? 1 : 0, `${mode}: one Payments.collect intent`);
        const events = await store.query({ model: model('work.occurrence'), authority: 'owner' });
        assert.equal(events.length, success ? 1 : 0, `${mode}: one settlement event`);
        if (success) {
          const requested = mode === 'partial-ledger' ? money('4000') : money('10000');
          const intent = intents[0]!;
          assert.equal(intent.target, 'std.PaymentsV1.collect', mode);
          assert.equal(intent.operation, 'invoice.collect', mode);
          assert.equal(intent.operationId, id, mode);
          assert.equal(intent.arguments['binding'], 'invoice.Payments', mode);
          assert.deepEqual(intent.arguments['arguments'], {
            customer: customer.id, amount: requested, reference: id, consent: null,
          }, mode);
          assert.equal(created[0]?.data['reference'], id, mode);
          assert.deepEqual(created[0]?.data['amount'], requested, mode);
          assert.equal(created[0]?.data['kind'], 'collection', mode);
          assert.equal(created[0]?.data['status'], 'pending', mode);
          assert.equal(created[0]?.data['delivery'], intent.intentId, mode);
          const result = events[0]!.data['result'] as Record<string, unknown>;
          assert.equal(result['kind'], 'declared-event-source', mode);
          assert.equal(result['event'], 'invoice.InvoiceSettlement', mode);
          const payload = result['payload'] as { value: Record<string, unknown> };
          assert.equal(payload.value['source'], 'invoice-source', mode);
          assert.equal(payload.value['invoice'], invoice.id, mode);
          assert.equal(payload.value['revision'], '8', mode);
          assert.deepEqual(payload.value['amount'], money('10000'), mode);
          assert.deepEqual(payload.value['collected'], mode === 'partial-ledger' ? money('4000') : money('0'), mode);
          assert.deepEqual(payload.value['refunded'], money('0'), mode);
          assert.equal(payload.value['collection_pending'], true, mode);
          assert.equal(payload.value['refund_pending'], false, mode);
          assert.equal(payload.value['state'], 'issued', mode);
          assert.ok(Object.hasOwn(events[0]!.data, 'filePayloadOrigin'),
            `${mode}: declared settlement retains its opaque File origin`);
          if (mode === 'billing-hidden') {
            const { filePayloadOrigin: _origin, ...withoutOrigin } = events[0]!.data;
            const currentOccurrence = events[0]!;
            const revision = await store.readRevision();
            await assert.rejects(() => store.commit(makeBatch(revision, {
              writes: [{ kind: 'update', model: model('work.occurrence'),
                id: currentOccurrence.id, expectedVersion: currentOccurrence.version,
                row: { ...currentOccurrence, version: asVersion(currentOccurrence.version + 1),
                  updated: now, data: withoutOrigin } }],
            })), error => error instanceof StorageConstraintError && error.kind === 'reference',
            'settlement cannot lose its original opaque File header');
          }
          if (['billing-hidden', 'individual-owner', 'finance-worker', 'partial-ledger'].includes(mode)) {
            const frozen = structuredClone(intent.arguments);
            if (mode === 'individual-owner') {
              await store.commit(makeBatch(await store.readRevision(), { writes: [{
                kind: 'insert', model: model('invoice.Credit'), row: {
                  ...makeRow({ id: asId('dispatch-credit'), data: { amount: money('10000'), hidden: true } }),
                  parent: { model: model('invoice.Invoice'), id: invoice.id },
                },
              }] }));
            } else if (mode === 'finance-worker' || mode === 'partial-ledger') {
              const currentAttempt = await store.load(model('invoice.Attempt'), created[0]!.id);
              assert.ok(currentAttempt);
              await store.commit(makeBatch(await store.readRevision(), { writes: [{
                kind: 'update', model: model('invoice.Attempt'), id: currentAttempt.id,
                expectedVersion: currentAttempt.version,
                row: { ...currentAttempt, version: asVersion(currentAttempt.version + 1),
                  updated: now, data: { ...currentAttempt.data,
                    ...(mode === 'finance-worker' ? { disabled: true } : { amount: money('1000') }) } },
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
            let providerCalls = 0;
            const dispatch = await driveDispatchIntentWithPreclaim({
              store: joined, intent, actor: 'dispatch:invoice.collect',
              operation: 'test.invoice.collect.dispatch', nowMs: () => now + 1000,
              nextClaimId: () => `claim-${mode}`, maxClaimAgeMs: 60000,
              claimOperationId: uuidv7(now + 1000, 1), recordOperationId: uuidv7(now + 1000, 2),
              evaluateGuard: () => { throw new Error('native collect guard was bypassed'); },
              readStateSnapshot: () => null,
              callProvider: async () => { providerCalls++; return { kind: 'delivered', result: null }; },
              classifyFailure, fence: fenceFor(intent),
            }, (guard, allocator) => {
              const guarded = createWorkDispatchClaimCommand((candidateId, target) =>
                candidateId === intent.intentId && target === intent.target, guard, allocator);
              return producers.createSystemRegistry(commands.map(command =>
                command.name === claim.name ? guarded : command));
            });
            const expected = mode === 'billing-hidden' ? 'recorded' : 'not-claimed';
            assert.equal(dispatch.status, expected, `${mode}: ${JSON.stringify(dispatch)}`);
            if (dispatch.status === 'not-claimed') assert.equal(dispatch.reason, 'guard-false', mode);
            assert.equal(providerCalls, mode === 'billing-hidden' ? 1 : 0, `${mode}: provider calls`);
            assert.deepEqual((await store.outboxGet(intent.intentId))?.intent.arguments, frozen,
              `${mode}: queued Payments.collect arguments remain frozen`);
            assert.equal(storageProbe.outboxAll().length, 1, `${mode}: no duplicate collection`);
          }
        }
        if (mode.endsWith('-at-commit')) assert.equal(injected, true, `${mode}: race hook reached`);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
