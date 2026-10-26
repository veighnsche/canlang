/** The original collection source owns one current balance, payment attempt, and settlement. */
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
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
import { createSystemRegistry, systemCommandStageRevision } from '@canlang/state';
import { workSchedulePutCommand } from '@canlang/work/kernel/schedule-staging';
import { loadOpaqueFileStaging } from './opaque-file-staging.js';
import { readReceiptRow, readAssociationRow, withReceiptRowData, withAssociationRowData } from '@canlang/state/receipt/tables';
import { applyReceiptProgress, applyRetainedRelatedProgress } from '@canlang/work/observation/association';
import { assembleDispatchCommands, buildInvoker } from '../worker/assembly.js';
import { installNativeFileInventory } from './file-inventory.js';
import { bindNativeEmailDispatchGuards, createWorkerDispatchJoinPort,
  driveDispatchIntentWithPreclaim, loadDispatchSystemProducers,
  withDispatchJoinPort, driveDispatchIntent, invokeDueSourceRoutingCanonical, loadCanonicalDescriptors, createNativeStandardCompletionSourceCommand, createNativeStandardCompletionPendingReceiptCommand, invokeRetainedHandlerOccurrenceCanonical } from './invoke.js';
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
      for (const [name, text] of [
        ['ordinary-helper-write', original.replace('  scenario collect(',
          '  scenario ordinary(invoice:Invoice) by=finance\n   do create CommercialHistory {parent=invoice.parent,complete=false,first_invoice=first_paid_invoice(invoice.parent),evidence="Ordinary write"} as history\n  scenario collect(')],
        ['exported-helper', original.replace('  derive first_paid_invoice(', '  export derive first_paid_invoice(')],
        ['ordinary-transitive-helper', original.replace('  derive first_paid_invoice(',
          '  derive ordinary(customer:Customer):Invoice? = first_paid_invoice(customer)\n  derive first_paid_invoice(')],
      ]) {
        const path=join(directory, `${name}.can`); await writeFile(path,text!);
        const result=spawnSync(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,path],
          {cwd:root,encoding:'utf8',timeout:60000,maxBuffer:32*1024*1024});
        assert.equal(result.status,10,`${name}: ${result.stderr || result.stdout}`);
        assert.ok((JSON.parse(result.stdout) as {diagnostics:{code:string;message:string}[]}).diagnostics
          .some(d=>d.code==='E6008' && d.message.includes('first query')),name);
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
        stdlibUrl: new URL('./stdlib.js', import.meta.url).href,
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
          disabled: false, delivery: 'prior-delivery', received: new Date(now - 2000).toISOString(), hidden: true } }),
          parent: { model: model('invoice.Invoice'), id: invoice.id } };
        const credit = { ...makeRow({ id: asId('credit'), data: {
          amount: money(mode === 'zero-balance' ? '10000' : '2000'), hidden: true } }),
          parent: { model: model('invoice.Invoice'), id: invoice.id } };
        const payment = { ...makeRow({ id: asId('external-payment'), data: {
          amount: money('1000'), received: new Date(now - 1000).toISOString(), hidden: true } }),
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

it('executes the four authored Invoice terminals only from retained Work completion admission',
  { timeout: 900000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-invoice-terminals-'));
    try {
      const terminalSource = join(root, 'packages/cloudflare/test/fixtures/invoice-terminal-owner-probe.can');
      const probe = await readFile(terminalSource, 'utf8');
      const original = await readFile(join(root, 'draft/apps/CanInvoice/CanInvoice.can'), 'utf8');
      const start = original.indexOf('  scenario collected on=');
      const end = original.indexOf('   ## Correlated transport acceptance', start);
      assert.ok(start >= 0 && end > start && probe.includes(original.slice(start, end)),
        'all four actual authored terminal bodies are retained unchanged');
      const observeStart=original.indexOf('  scenario observe_commercial_payment on=');
      const observeEnd=original.indexOf('  scenario observe_commercial_sale on=',observeStart);
      assert.ok(probe.includes(original.slice(observeStart,observeEnd).trimEnd()),
        'the actual commercial payment observation write is retained');
      for(const prefix of ['  derive first_receipt(', '  derive first_paid_invoice(']) {
        const line=original.split('\n').find(value=>value.startsWith(prefix));
        assert.ok(line && probe.includes(line),`${prefix} is retained`);
      }
      const failedFramework=process.env['CAN_INVOICE_GUARDED_FAIL']==='1';
      const sourceCharge=process.env['CAN_INVOICE_SOURCE_CHARGE']==='1';
      const automaticCollection=process.env['CAN_INVOICE_AUTOMATIC_COLLECTION']==='1';
      const applyResult=sourceCharge || automaticCollection || process.env['CAN_INVOICE_APPLY_RESULT']==='1';
      const guardedRetained=failedFramework || applyResult || process.env['CAN_INVOICE_GUARDED_RETAINED']==='1';
      const compiledSource=guardedRetained?join(directory,'guarded-invoice.can'):terminalSource;
      if(guardedRetained) await writeFile(compiledSource,probe.replace(' use std {PaymentState}',
        ' use std {EmailV1 as Mail} from=deployment.mail\n use std {PaymentState}')
        .replace('  scenario collected on=Payments.collect.completed',
          '  scenario guarded_receipt on=ProviderReceipt\n   do\n    for observed in Attempt as candidate where candidate.reference==event.value.reference limit=1\n     send Mail.send {to="owner@example.test",subject="Source guard",body="Retained receipt"} when=observed.status==pending as delivery\n     set observed {outcome_at=now}\n     schedule event.value.reference at=now+5m event=ProviderReceipt {value=event.value}\n     cancel event.value.reference\n     schedule "guarded-followup" at=now+10m event=ProviderReceipt {value=event.value}\n  scenario collected on=Payments.collect.completed'));
      if(failedFramework) {
        const text=await readFile(compiledSource,'utf8');
        const marker='     schedule "guarded-followup" at=now+10m event=ProviderReceipt {value=event.value}';
        assert.ok(text.includes(marker));
        await writeFile(compiledSource,text.replace(marker,marker+'\n     require false'));
      }
      if(applyResult) {
        const start=original.indexOf('  scenario apply_result on=ProviderReceipt');
        const end=original.indexOf('   examples ',start);
        const actualBody=original.slice(start,end).trimEnd();
        const refundLine=original.split('\n').find(line=>line.startsWith('  derive Invoice.refund_due:'))!;
        let text=probe.replace(' use std {PaymentState}',
          ' use std {EmailV1 as Mail} from=deployment.mail\n use std {PaymentState}')
          .replace('  export Invoice in Customer {','  export Invoice in Customer {recipient_email:email,needs_review:bool=false,consent:text?,retry_delay:duration=2d,retry_until:datetime?,attempt_limit:int=3,')
          .replace('  Attempt in Invoice {','  Attempt in Invoice {mode:enum(interactive,automatic)=interactive,provider_revision:int=0,provider_reference:text?,')
          .replace('  event ProviderReceipt {value:PaymentState}',
            '  event ReconcileDue {attempt:Attempt}\n  event CollectionDue {invoice:Invoice}\n  event ProviderReceipt {value:PaymentState}')
          .replace('  derive Invoice.balance:money',refundLine+'\n  derive Invoice.balance:money')
          .replace('  scenario collected on=Payments.collect.completed',actualBody+'\n  scenario collected on=Payments.collect.completed');
        assert.ok(text.includes(actualBody),'complete original apply_result body is unchanged');
        if(automaticCollection) {
          const automaticStart=original.indexOf('  scenario automatic_collection on=CollectionDue');
          const automaticEnd=original.indexOf('   examples ',automaticStart);
          const automaticBody=original.slice(automaticStart,automaticEnd).trimEnd();
          text=text.replace('  event CollectionDue {invoice:Invoice}',
            '  BillingCancellation {source:text}\n  event CollectionDue {invoice:Invoice}')
            .replace('  scenario collected on=Payments.collect.completed',automaticBody+'\n  scenario collected on=Payments.collect.completed');
          assert.ok(text.includes(automaticBody),'complete original automatic_collection body is unchanged');
        }
        if(sourceCharge) {
          const start=original.indexOf('  scenario source_charge on=BillingRequests.charge');
          const end=original.indexOf('   examples ',start);
          const body=original.slice(start,end).trimEnd();
          text=text.replace('package customer\n Given','package customer\n use rent_catalog {Location}\n Given')
            .replace('export Location {active:bool=true}', 'export Location {active:bool=true,currency:currency,timezone:timezone}')
            .replace('export Customer {','export Customer {name:text,active:bool=true,locations:Location[],')
            .replace('export Contact in Customer {','export Contact in Customer {email:email,')
            .replace('  export CompanyRole in Customer {','  export BillingProfile in Customer {contact:Contact,address:text,tax_reference:text?}\n  export CompanyRole in Customer {')
            .replace('use customer {Customer,Contact,CompanyRole,has_role,owns}', 'use customer {Customer,Contact,CompanyRole,BillingProfile,has_role,owns}')
            .replace(' use std {PaymentState}', ' use invoice {BillingIngressV1 as BillingRequests} from=deployment.billing_ingress\n use std {PaymentState,OperationOutcome}')
            .replace('  export Invoice in Customer {','  export Invoice in Customer {issuer:text,recipient:text,address:text,tax_reference:text?,description:text,terms:text?,source_items:DocumentLine[]?,due:date,number:text?,issued_at:datetime?,')
            .replace('  event CollectionDue {invoice:Invoice}', '  BillingCancellation {source:text}\n  event CollectionDue {invoice:Invoice}')
            .replace('  role finance', `  message notice_invoice_issued = "Invoice issued"@{nl="Factuur uitgegeven"}
  Defaults {issuer:text,attempt_limit:int=3,retry_delay:duration=2d,retry_window:duration=14d}
  export contract DocumentLine {title:text,quantity:decimal,price:money,tax:money,discount:money,unit:text?,from:datetime?,until:datetime?,location:text?,reference:text?}
  export contract Charge {source:text,customer:text,location:text,description:text,amount:money,due:date,issuer:text?,terms:text?,items:DocumentLine[]?,consent:text?}
  export capability BillingIngressV1 version=1
   event charge {value:Charge}
  event ChargeOutcome {value:OperationOutcome}
  event Overdue {invoice:Invoice,revision:int}
  Line in Invoice {description:text,position:int=0,quantity:decimal=1,unit:text?,service_from:datetime?,service_until:datetime?,service_location:text?,service_reference:text?,price:money,tax:money,discount:money}
  role finance`)
            .replace('  scenario collected on=Payments.collect.completed',body+'\n  scenario collected on=Payments.collect.completed');
          assert.ok(text.includes(body),'complete original source_charge body is unchanged');
        }
        await writeFile(compiledSource,text);
      }
      const broadFields=Array.from({length:100},(_,index)=>`field${index}:text`).join(',');
      const broadHandlers=Array.from({length:70},(_,index)=>
        `  scenario broad_${index} on=Broad\n   do require event.field0!=""`).join('\n');
      const routingPackage=`
package routing
 Given
  event Seen {id:text,revision:int}
  event Broad {${broadFields}}
  Item_0 {visible:bool=true}
  policy Item_0 read=members
  Item_1 {visible:bool=true}
  policy Item_1 read=members
 When
  scenario changed_0 on=Item_0.updated
   do
    for changed in Item_0 archived=include as row where row.id==event.id limit=1
     emit Seen {id=changed.id,revision=event.version}
  scenario changed_0_second on=Item_0.updated
   do
    for changed in Item_0 archived=include as row where row.id==event.id limit=1
     emit Seen {id=changed.id,revision=event.version}
  scenario changed_1 on=Item_1.updated
   do
    for changed in Item_1 archived=include as row where row.id==event.id limit=1
     emit Seen {id=changed.id,revision=event.version}
${broadHandlers}
 Then
`;
      const terminalText=await readFile(compiledSource,'utf8');
      assert.ok(terminalText.includes('app CanInvoice uses=[invoice]'));
      const routingSource=join(directory,'large-routing-invoice.can');
      await writeFile(routingSource,terminalText.replace('app CanInvoice uses=[invoice]',
        'app CanInvoice uses=[invoice,routing]')+routingPackage);
      const { stdout:routingStdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, routingSource],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const routingArtifact = JSON.parse(routingStdout) as CompileArtifact;
      const routingAsm = await assembleModules({ artifact:routingArtifact, sourcePath:routingSource }, { workDir: directory,
        stdlibUrl: new URL('./stdlib.js', import.meta.url).href,
        uiUrl: import.meta.resolve('@canlang/ui') });
      const composed=await loadCanonicalDescriptors(routingAsm,routingArtifact);
      for(const index of [0,1]) {
        const event=`routing.Item_${index}.updated`;
        const handlers=index===0?['routing.changed_0','routing.changed_0_second']:['routing.changed_1'];
        const entry=composed.committedChanges.get(event);
        assert.ok(entry,event);
        assert.deepEqual(entry.descriptor.handlers,handlers);
        assert.deepEqual(entry.routes.map(route=>route.handler),handlers);
        for(const route of entry.routes) {
          assert.equal(route.invocation['name'],route.handler);
          assert.ok(route.definition!==null && typeof route.definition==='object');
          const operations=Object.getOwnPropertyDescriptor(route.definition,'operations')?.value as Record<string,{event:string;invocation?:unknown}>;
          for(let broad=0;broad<70;broad++) {
            assert.equal(operations[`routing.broad_${broad}`]?.event,'routing.Broad');
            assert.equal(Object.hasOwn(operations[`routing.broad_${broad}`]!,'invocation'),false,
              'unrelated headers remain complete without borrowing their invocation payload');
          }
          for(const sibling of entry.routes) {
            assert.deepEqual(operations[sibling.handler]?.invocation,sibling.invocation,
              'every source-group view retains every complete sibling invocation');
          }
          assert.equal(Object.hasOwn(operations[`routing.changed_${1-index}`]!,'invocation'),false,
            'independent committed source groups keep their own invocation payload');
        }
      }
      const completionHandlers=new Set<string>();
      for(const completion of composed.standardCompletions?.values() ?? []) for(const route of completion.routes) {
        completionHandlers.add(route.handler);
        assert.equal(route.invocation['name'],route.handler);
        assert.ok(route.definition!==null && typeof route.definition==='object');
        const operations=Object.getOwnPropertyDescriptor(route.definition,'operations')?.value as Record<string,{event:string;invocation?:unknown}>;
        assert.ok(operations[route.handler]?.invocation);
        for(let broad=0;broad<70;broad++) {
          assert.equal(operations[`routing.broad_${broad}`]?.event,'routing.Broad');
          assert.equal(Object.hasOwn(operations[`routing.broad_${broad}`]!,'invocation'),false);
        }
      }
      for(const handler of ['invoice.collected','invoice.refunded','invoice.checkout_cancelled','invoice.reconciled']) {
        assert.ok(completionHandlers.has(handler),handler);
      }
      const routingCallable=routingArtifact.callables.find(value=>value.id==='routing.changed_0');assert.ok(routingCallable);
      const originalModule=await import(routingAsm.moduleUrls[routingCallable.module]!);
      const originalOperations=originalModule.appDefinition.operations as Record<string,{event?:string;invocation?:unknown}>;
      const pending:unknown[]=Object.values(originalOperations).filter(value=>typeof value.event==='string').map(value=>value.invocation);
      let invocationNodes=0;
      while(pending.length) {
        const value=pending.pop();invocationNodes++;
        if(Array.isArray(value)) pending.push(...value);
        else if(value!==null && typeof value==='object') pending.push(...Object.values(value));
      }
      assert.ok(invocationNodes>20000,'real composed private invocation metadata exceeds the old aggregate snapshot bound');
      const originalCensus=routingArtifact.committedChanges!;
      for(const mutation of ['omitted','changed-handler','changed-invocation'] as const) {
        const altered=structuredClone(routingArtifact);
        if(mutation==='omitted') altered.committedChanges=altered.committedChanges!.filter(value=>value.source!=='routing.Item_0.updated');
        if(mutation==='changed-handler') altered.committedChanges!.find(value=>value.source==='routing.Item_0.updated')!.handlers=['routing.changed_1'];
        const before=`committedChanges:${JSON.stringify(originalCensus)}`;
        const after=`committedChanges:${JSON.stringify(altered.committedChanges)}`;
        let changed=0;
        for(const module of altered.modules) {
          if(mutation==='changed-invocation') {
            const original='invocation:{"name":"routing.changed_0"';
            if(module.js.includes(original)) {module.js=module.js.replaceAll(original,'invocation:{"name":"routing.changed_1"');changed++;}
          } else if(module.js.includes(before)) {module.js=module.js.replaceAll(before,after);changed++;}
        }
        assert.ok(changed>0,mutation);
        const rejected=await assembleModules({artifact:altered,sourcePath:routingSource},{workDir:join(directory,mutation),
          stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
        await assert.rejects(loadCanonicalDescriptors(rejected,altered),
          /omitted a matching handler|different private invocation|repeats or lacks|source handler/,mutation);
      }
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, compiledSource],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: compiledSource }, { workDir: directory,
        stdlibUrl: new URL('./stdlib.js', import.meta.url).href,
        uiUrl: import.meta.resolve('@canlang/ui') });
      const selectedCase=process.env['CAN_INVOICE_TERMINAL_CASE'];
      let executed=0;
      for (const [op, status, mismatch] of [
        ['collect', 'succeeded', null], ['refund', 'succeeded', null],
        ['cancel', 'succeeded', null], ['reconcile', 'succeeded', null],
        ['collect', 'failed', null], ['refund', 'failed', null],
        ['collect', 'skipped', null], ['refund', 'skipped', null],
        ['cancel', 'failed', null], ['reconcile', 'skipped', null],
        ['collect', 'succeeded', 'reference'], ['refund', 'succeeded', 'amount'],
        ['cancel', 'succeeded', 'reference'], ['reconcile', 'succeeded', 'amount'],
      ] as const) {
        const mode = `${op}-${status}-${mismatch ?? 'valid'}`;
        if(selectedCase!==undefined && selectedCase!==mode) continue;
        executed++;
        const realSkip = op === 'collect' && status === 'skipped';
        const commercial = op === 'collect' && status === 'failed';
        const identities = createMemoryIdentityStore({ clock: createFrozenClock(now) });
        const team = await identities.createTeam({ timezone: 'UTC' });
        const actor = await identities.createUser({ email: `${mode}@invoice-terminal.test`,
          password_hash: 'unused', email_verified: true });
        await identities.createMembership({ team_id: team.team_id, user_id: actor.user_id,
          is_owner: true, roles: [] });
        const token = `terminal-${mode}`;
        await identities.createSession({ user_id: actor.user_id, token_sha256: await sha256HexText(token),
          last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
        const identity = await resolveIdentity(identities, { session_token: token },
          { clock: createFrozenClock(now) });
        const scope = { app: 'CanInvoice', owner: team.team_id, ownerPackage: 'invoice' };
        const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app,
          stateStoreId: 'terminal-state', fileStoreId: 'terminal-files',
          receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
        const { store, probe: storageProbe } = createTestMemoryStorage(authority,
          [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({ artifact, asm, store, authority, scope,
          now: () => now, verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
        const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
        if(sourceCharge) {
          const location={...makeRow({id:asId('charge-location'),data:{active:true,currency:'EUR',timezone:'UTC'}}),parent:null};
          const customer={...makeRow({id:asId('charge-customer'),data:{name:'Customer',kind:'company',active:true,locations:[{id:location.id}],hidden:true}}),parent:null};
          const contact={...makeRow({id:asId('charge-contact'),data:{email:'charge@example.test',account:null,verified:false,hidden:true}}),parent:{model:model('customer.Customer'),id:customer.id}};
          const profile={...makeRow({id:asId('charge-profile'),data:{contact:{id:contact.id},address:'Billing address',tax_reference:null}}),parent:{model:model('customer.Customer'),id:customer.id}};
          const defaults={...makeRow({id:asId('charge-defaults'),data:{issuer:'Operator',attempt_limit:'3',retry_delay:'172800000',retry_window:'1209600000'}}),parent:null};
          await store.commit(makeBatch(await store.readRevision(),{writes:[
            {kind:'insert',model:model('rent_catalog.Location'),row:location},
            {kind:'insert',model:model('customer.Customer'),row:customer},
            {kind:'insert',model:model('customer.Contact'),row:contact},
            {kind:'insert',model:model('customer.BillingProfile'),row:profile},
            {kind:'insert',model:model('invoice.Defaults'),row:defaults}]}));
          const invalidChargeMode=process.env['CAN_INVOICE_SOURCE_CHARGE_INVALID'];
          const invalidCharge=invalidChargeMode!==undefined;
          const payload={value:{source:'charge-original',customer:customer.id,location:location.id,description:'Room',amount:money(invalidChargeMode==='1'?'-1500':'1500'),due:'2099-01-02',issuer:null,terms:null,items:invalidChargeMode==='items'?[]:null,consent:null}};
          const kickoff={occurrenceId:uuidv7(now,30),key:'charge-kickoff',event:'invoice.BillingIngressV1.charge',scope,at:now};
          const loaded=await loadCanonicalDescriptors(asm,artifact);
          assert.ok(loaded.valueTypes);
          const opaque=await loadOpaqueFileStaging({store,inventoryOwner:scope.ownerPackage,artifact,
            canonicalModels:loaded.models,valueTypes:loaded.valueTypes,operations:new Map(),scope,verify:async()=>{}});assert.ok(opaque);
          const declaration=opaque.event(kickoff.event);
          const scheduleIdentity=await resolveIdentity(identities,{team_id:team.team_id},{clock:createFrozenClock(now)});
          const stageContext={actor:'schedule:charge-fixture',now,operation:'invoice.source_charge',load:(name:ModelName,id:StoredRow['id'])=>store.load(name,id),query:(spec:Parameters<typeof store.query>[0])=>store.query(spec)};
          const initial=await workSchedulePutCommand.stage({...kickoff,payload},stageContext);
          const write=initial.writes?.find(write=>write.model==='work.schedule' && write.kind==='insert');assert.ok(write && write.kind==='insert');
          const filePayloadOrigin=await opaque.prepare({expectedRevision:await store.readRevision(),model:model('work.schedule'),row:write.row,field:'payload',scope,
            origin:{kind:'event-input',occurrenceId:kickoff.occurrenceId,sourceOccurrence:kickoff.occurrenceId,declaration,
              lineage:{kind:'schedule',key:kickoff.key,replaces:null},target:{kind:'schedule'}},
            projection:{kind:'inputs',path:[],declarationId:declaration.inputsDeclarationId},value:payload,identity:scheduleIdentity});
          const staged=await workSchedulePutCommand.stage({...kickoff,payload,filePayloadOrigin},stageContext);
          await store.commit(makeBatch(await store.readRevision(),{writes:staged.writes??[],schedules:staged.schedules??[]}));
          assert.equal((await invokeDueSourceRoutingCanonical({asm,artifact,app:scope.app,handler:'invoice.source_charge',due:kickoff,store,identities,now:()=>now})).status,'completed');
          const invoke=()=>invokeRetainedHandlerOccurrenceCanonical({asm,artifact,app:scope.app,selector:{scope,event:kickoff.event,sourceOccurrence:kickoff.occurrenceId,handler:'invoice.source_charge'},store,identities,deploymentBase:'https://billing.example.test',now:()=>now+1});
          assert.equal((await invoke() as {status:string}).status,invalidCharge?'failed':'completed');
          assert.equal((await store.query({model:model('invoice.Invoice'),authority:'owner'})).length,invalidCharge?0:1);
          assert.equal((await store.query({model:model('invoice.Line'),authority:'owner'})).length,invalidCharge?0:1);
          assert.equal(storageProbe.outboxAll().filter(intent=>intent.target==='std.EmailV1.send').length,invalidCharge?0:1);
          if(invalidCharge) {
            assert.equal((await store.query({model:model('work.schedule'),authority:'owner'})).length,1,'failed Require keeps only the original kickoff');
            const sources=await store.query({model:model('work.occurrence'),authority:'owner'});
            assert.equal(sources.some(row=>['invoice.InvoiceSettlement','invoice.ChargeOutcome'].includes(String((row.data['result'] as {event?:string}|null)?.event))),false,
              'failed Require cannot emit events from its partial Invoice overlay');
          }
          assert.equal((await invoke() as {status:string}).status,'replayed');
          if(!invalidCharge) {
            const mail=storageProbe.outboxAll().find(intent=>intent.operation==='invoice.source_charge');assert.ok(mail);
            const stale=process.env['CAN_INVOICE_SOURCE_CHARGE_DISPATCH']==='changed';
            if(stale) {
              const row=(await store.query({model:model('invoice.Invoice'),authority:'owner'}))[0]!;
              await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:model('invoice.Invoice'),id:row.id,
                expectedVersion:row.version,row:{...row,version:asVersion(row.version+1),data:{...row.data,state:'void'}}}]}));
            }
            const producers=await loadDispatchSystemProducers();
            const claim=createWorkDispatchClaimCommand((id,target)=>id===mail.intentId && target===mail.target);
            const commands=assembleDispatchCommands({l3Commands:producers.l3Commands,
              workCommands:WORK_SYSTEM_COMMANDS.map(command=>command.name===claim.name?claim:command),stageCommands:WORK_DISPATCH_STAGE_COMMANDS});
            const joined=withDispatchJoinPort(store,await createWorkerDispatchJoinPort(store));
            const fence=(await bindNativeEmailDispatchGuards({asm,artifact,store,identities,scope,revalidateAuthority:async()=>true}))(mail);
            let providerCalls=0;
            await driveDispatchIntentWithPreclaim({store:joined,intent:mail,actor:'dispatch:charge',operation:'test.charge.dispatch',nowMs:()=>now+2,
              nextClaimId:()=>`charge-${mode}`,maxClaimAgeMs:60000,claimOperationId:uuidv7(now+2,31),recordOperationId:uuidv7(now+2,32),
              evaluateGuard:()=>true,readStateSnapshot:()=>null,fence,callProvider:async()=>{providerCalls++;return {kind:'delivered' as const,result:null};},classifyFailure},
              (guard,allocator)=>{const nativeClaim=createWorkDispatchClaimCommand((id,target)=>id===mail.intentId && target===mail.target,guard,allocator);
                return producers.createSystemRegistry(commands.map(command=>command.name===claim.name?nativeClaim:command));});
            assert.equal(providerCalls,stale?0:1,'new Invoice current original WHEN owns source_charge Mail dispatch');
          }
          continue;
        }
        const customer = { ...makeRow({ id: asId('customer'), data: { kind: 'company', hidden: true } }), parent: null };
        const invoice = { ...makeRow({ id: asId('invoice'), data: { location: { id: 'location' },
          source: 'invoice-source', currency: 'EUR', state: realSkip || applyResult ? 'issued' : 'void_pending', total: money('1500'),
          ...(applyResult?{recipient_email:'owner@example.test',needs_review:false,consent:'verified',retry_delay:'172800000',
            retry_until:new Date(now+14*86400000).toISOString(),attempt_limit:'3'}:{}),
          next_collection: null, ledger_revision: '7', hidden: true } }),
          parent: { model: model('customer.Customer'), id: customer.id } };
        let attempt: StoredRow = { ...makeRow({ id: asId('attempt'), data: { reference: 'provider-reference',
          amount: money('1500'), kind: op === 'refund' ? 'refund' : 'collection', status: 'pending',
          failure: null, disabled: false, delivery: null, checkout: 'https://pay.test/',
          ...(applyResult?{mode:'automatic',provider_revision:'0',provider_reference:null}:{}),
          outcome_at: null, hidden: true } }), parent: { model: model('invoice.Invoice'), id: invoice.id } };
        const request = { ...makeRow({ id: asId('request'), data: { kind: op,
          cancellation: null, reconciliation: null } }),
          parent: { model: model('invoice.Attempt'), id: attempt.id } };
        await store.commit(makeBatch(await store.readRevision(), { writes: [
          { kind: 'insert', model: model('customer.Customer'), row: customer },
          { kind: 'insert', model: model('invoice.Invoice'), row: invoice },
          ...(!realSkip ? [{ kind: 'insert' as const, model: model('invoice.Attempt'), row: attempt }] : [{
            kind:'insert' as const,model:model('customer.CompanyRole'),row:{...makeRow({id:asId('billing'),
              data:{account:{id:actor.user_id},role:'billing',active:true,hidden:true}}),
              parent:{model:model('customer.Customer'),id:customer.id}} }]),
          ...(['cancel', 'reconcile'].includes(op) ? [{ kind: 'insert' as const,
            model: model('invoice.PaymentRequest'), row: request }] : []),
        ] }));
        if (commercial) {
          const paid=(id:string,owner:StoredRow,at:number):Array<{kind:'insert';model:ModelName;row:StoredRow}>=>[
            {kind:'insert',model:model('invoice.Invoice'),row:owner},
            {kind:'insert',model:model('invoice.ExternalPayment'),row:{...makeRow({id:asId(`${id}-payment`),
              data:{amount:money('1000'),received:new Date(at).toISOString(),hidden:true}}),
              parent:{model:model('invoice.Invoice'),id:owner.id}}}];
          const other={...customer,id:asId('other-customer')};
          const earlier=(id:string,parent=customer.id)=>({...invoice,id:asId(id),
            parent:{model:model('customer.Customer'),id:parent}});
          await store.commit(makeBatch(await store.readRevision(),{writes:[
            {kind:'insert',model:model('invoice.ExternalPayment'),row:{...makeRow({id:asId('observed-payment'),
              data:{amount:money('1000'),received:new Date(now-1000).toISOString(),hidden:true}}),
              parent:{model:model('invoice.Invoice'),id:invoice.id}}},
            ...paid('b-first',earlier('b-first'),now-3000),
            ...paid('a-first',earlier('a-first'),now-3000),
            {kind:'insert',model:model('customer.Customer'),row:other},
            ...paid('0-foreign',earlier('0-foreign',other.id),now-5000),
          ]}));
        }
        const sent = await invoker.invokeMutation({ operation: realSkip ? 'invoice.collect' : `invoice.request_${op}`,
          operation_id: operationId(), inputs: realSkip ? {invoice:{id:invoice.id,version:String(invoice.version)}} : { ...(['cancel', 'reconcile'].includes(op) ? { retained: { id: request.id, version: String(request.version) } } : {}),
            reference: 'provider-reference',
            ...(['collect', 'refund'].includes(op) ? { amount: money('1500') } : {}) } }, identity);
        assert.ok('result' in sent && sent.result.status === 'committed', `${mode}: ${JSON.stringify(sent)}`);
        const intent = storageProbe.outboxAll()[0]!;
        assert.ok(intent && intent.target === `std.PaymentsV1.${op}`, mode);
        if (realSkip) {
          const originals=await store.query({model:model('invoice.Attempt'),authority:'owner',
            parent:{model:model('invoice.Invoice'),id:invoice.id}});
          assert.equal(originals.length,1,`${mode}: original collect produced the Attempt`);
          attempt=originals[0]!;
          assert.equal(attempt.data['delivery'],intent.intentId);
          const currentInvoice=await store.load(model('invoice.Invoice'),invoice.id);assert.ok(currentInvoice);
          await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:model('invoice.Invoice'),
            id:currentInvoice.id,expectedVersion:currentInvoice.version,row:{...currentInvoice,
              version:asVersion(currentInvoice.version+1),data:{...currentInvoice.data,state:'void_pending'}}}]}));
        }
        const current = await store.load(model('invoice.Attempt'), attempt.id); assert.ok(current);
        await store.commit(makeBatch(await store.readRevision(), {writes:[{kind:'update',model:model('invoice.Attempt'),
          id:current.id,expectedVersion:current.version,row:{...current,version:asVersion(current.version+1),
            data:{...current.data,delivery:intent.intentId}}}]}));
        const producers = await loadDispatchSystemProducers();
        const claim = createWorkDispatchClaimCommand((id, target) => id === intent.intentId && target === intent.target);
        const commands = assembleDispatchCommands({ l3Commands: producers.l3Commands,
          workCommands: WORK_SYSTEM_COMMANDS.map(command => command.name === claim.name ? claim : command),
          stageCommands: WORK_DISPATCH_STAGE_COMMANDS });
        const joined = withDispatchJoinPort(store, await createWorkerDispatchJoinPort(store));
        let providerCalls=0;
        const dispatchInput = { store: joined, intent,
          actor: 'dispatch:invoice-terminal', operation: 'test.invoice-terminal.dispatch', nowMs: () => now + 1,
          nextClaimId: () => `claim-${mode}`, maxClaimAgeMs: 60000,
          claimOperationId: uuidv7(now + 1, 1), recordOperationId: uuidv7(now + 1, 2),
          evaluateGuard: () => true, readStateSnapshot: () => null,
          callProvider: async () => {providerCalls++;return { kind: 'delivered' as const, result: null };},classifyFailure,
        };
        const dispatched=realSkip ? await driveDispatchIntentWithPreclaim({...dispatchInput,
          fence:(await bindNativeEmailDispatchGuards({asm,artifact,store,identities,scope,
            revalidateAuthority:async()=>true}))(intent)},(guard,allocator)=>{
          const nativeClaim=createWorkDispatchClaimCommand((id,target)=>id===intent.intentId && target===intent.target,guard,allocator);
          return producers.createSystemRegistry(commands.map(command=>command.name===claim.name?nativeClaim:command));
        }) : await driveDispatchIntent({...dispatchInput,registry:producers.createSystemRegistry(commands)});
        assert.equal(dispatched.status,realSkip?'not-claimed':'recorded',`${mode}: ${JSON.stringify(dispatched)}`);
        assert.equal(providerCalls,realSkip?0:1,`${mode}: provider is excluded by current native guard`);
        if(realSkip){
          assert.equal((await store.outboxGet(intent.intentId))?.status,'dispatched',`${mode}: guard skip acknowledges original retained intent`);
          const dispatch=await store.load(model('work.dispatch'),asId(intent.intentId));assert.ok(dispatch);
          assert.equal(dispatch.data['guardVerdict'],false,`${mode}: original dispatch pins false`);
          assert.equal(dispatch.data['attempts'],0,`${mode}: skipped dispatch spends no provider attempt`);
        }
        const completionInput = { asm, artifact, scope, identities, store,
          bounds: { maxSources: 4, maxHandlers: 4, maxMembers: 10, chunkSize: 10 } };
        if (op === 'collect' || op === 'refund') {
          assert.equal(await store.load(model('work.receipt'),asId(intent.intentId)),null,
            `${mode}: authored text delivery has no synthetic typed association`);
          const pending = await createNativeStandardCompletionPendingReceiptCommand(completionInput);
          const pendingRegistry = createSystemRegistry([pending]);
          const initialize = (deliveryId = intent.intentId) => pendingRegistry.run(pending.name,{deliveryId},
            {actor:'dispatch:payments',now:now+2,operation:pending.name,operationId:operationId()},{store});
          await assert.rejects(()=>initialize('absent-delivery'),`${mode}: no fabricated delivery`);
          if (op === 'collect' && status === 'succeeded' && mismatch === null) {
            await assert.rejects(()=>pendingRegistry.run(pending.name,{deliveryId:intent.intentId,status:'succeeded',result:{}},
              {actor:'dispatch:payments',now:now+2,operation:pending.name,operationId:operationId()},{store}),
              `${mode}: initializer cannot accept result/progress authority`);
          }

          if (op === 'collect' && status === 'succeeded' && mismatch === null) {
            const dispatch = await store.load(model('work.dispatch'),asId(intent.intentId)); assert.ok(dispatch);
            for (const corruption of [{source:'std.PaymentsV1.refund'}, {operationId:operationId()}]) {
              const before = await store.load(model('work.dispatch'),dispatch.id); assert.ok(before);
              await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:model('work.dispatch'),
                id:before.id,expectedVersion:before.version,row:{...before,version:asVersion(before.version+1),
                  data:{...before.data,...corruption}}}]}));
              await assert.rejects(()=>initialize(),`${mode}: original dispatch source/operation is required`);
              const changed = await store.load(model('work.dispatch'),dispatch.id); assert.ok(changed);
              await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:model('work.dispatch'),
                id:changed.id,expectedVersion:changed.version,row:{...changed,version:asVersion(changed.version+1),data:dispatch.data}}]}));
            }
            // Even a wrapper around the same readers cannot replace the actual
            // physical store enrolled by the native host factory.
            await assert.rejects(()=>pendingRegistry.run(pending.name,{deliveryId:intent.intentId},
              {actor:'dispatch:payments',now:now+2,operation:pending.name,operationId:operationId()},
              {store:{...store}}),`${mode}: foreign system store`);
          }
          assert.equal(((await initialize()).result as {status:string}).status,'initialized',mode);
          assert.equal(((await initialize()).result as {status:string}).status,'replayed',mode);
          const pendingRow = await store.load(model('work.receipt'),asId(intent.intentId)); assert.ok(pendingRow);
          const header = readReceiptRow(pendingRow).filePayloadOrigin!;
          assert.equal(header.origin.kind,'retained-delivery-result');
          if (op === 'collect' && status === 'succeeded' && mismatch === null) {
            for (const mutate of [
              (copy: typeof header) => { if(copy.origin.kind==='retained-delivery-result') Object.assign(copy.origin.request,{binding:'invoice.Forged'}); },
              (copy: typeof header) => { if(copy.origin.kind==='retained-delivery-result') Object.assign(copy.origin.caller.callable,{id:'invoice.request_refund'}); },
              (copy: typeof header) => { if(copy.origin.kind==='retained-delivery-result') Object.assign(copy.origin,{resultDeclarationId:'invoice.Payments.refund.completed:provider-result'}); },
            ]) {
              const forged=structuredClone(header);mutate(forged);
              const forgedRevision=await store.readRevision();
              await assert.rejects(()=>store.commit(makeBatch(forgedRevision,{writes:[{kind:'update',
                model:model('work.receipt'),id:pendingRow.id,expectedVersion:pendingRow.version,
                row:{...pendingRow,version:asVersion(pendingRow.version+1),data:{...pendingRow.data,filePayloadOrigin:forged}}}]})),
                error=>error instanceof StorageConstraintError && error.kind==='reference',
                `${mode}: persisted caller/binding/result declaration cannot be substituted`);
            }
          }

        }
        const nominal = { reference: mismatch === 'reference' ? 'wrong-reference' : 'provider-reference',
          revision: '1', provider_reference: null, amount: money(mismatch === 'amount' ? '1400' : '1500'),
          status: applyResult?'failed':'succeeded', checkout_url: null, failure: applyResult?'transient':null };
        // Test provider progress uses the real owning reducer and State row writers.
        // The host has no installed Payments adapter; it grants no source authority.
        const progress = { name: 'test.payments.progress', stage: async (_: Readonly<Record<string, unknown>>,
          ctx: import('@canlang/state').SystemCommandContext) => {
          const row = await ctx.load(model('work.receipt'), asId(intent.intentId)); assert.ok(row, mode);
          const prior = readReceiptRow(row).receipt;
          const associations = await ctx.query({ model: model('work.receipt_association'),
            where: { op: 'eq', field: 'deliveryId', value: intent.intentId }, authority: 'owner' });
          const associationRow = associations[0];
          const revision = systemCommandStageRevision(ctx) + 1;
          const progress = { delivery_id: intent.intentId, relation: intent.target,
            source: intent.target, revision, status, result: status === 'succeeded' ? nominal : null,
            error: status === 'failed' ? { code: 'provider', message: 'Provider unavailable' } : null };
          const declaration = readReceiptRow(row).filePayloadOrigin!.origin;
          assert.ok(declaration.kind === 'retained-delivery-result' || declaration.kind === 'delivery-result');
          const context = { source:intent.target,declaredResult:declaration.declaration.canonical.result };
          const reduced = associationRow === undefined
            ? applyRetainedRelatedProgress(intent.target,prior,progress,context)
            : applyReceiptProgress(readAssociationRow(associationRow),prior,progress,context);
          assert.equal(associations.length, op === 'collect' || op === 'refund' ? 0 : 1,
            `${mode}: actual authored locator shape`);
          assert.ok(reduced.applied, `${mode}: ${JSON.stringify(reduced)}`);
          const meta = { nowMs: ctx.now, actor: ctx.actor };
          return { writes: [
            { kind: 'update' as const, model: model('work.receipt'), id: row.id, expectedVersion: row.version,
              row: withReceiptRowData(row, { ...reduced.receipt, contentRef: null, resultExpiresAtMs: null }, meta) },
            ...(associationRow === undefined ? [] : [{ kind: 'update' as const,
              model: model('work.receipt_association'), id: associationRow.id,
              expectedVersion: associationRow.version, row: withAssociationRowData(associationRow, {
                recordModel: associationRow.data['recordModel'] as string,
                recordId: readAssociationRow(associationRow).locator.recordId,
                field: readAssociationRow(associationRow).locator.field,
                deliveryId: intent.intentId, source: intent.target, revision }, meta) }]),
          ] };
        } };
        await createSystemRegistry([progress]).run(progress.name, {}, { actor: 'provider:payments',
          now: now + 2, operation: progress.name, operationId: uuidv7(now + 2, 3) }, { store });
        const completion = await createNativeStandardCompletionSourceCommand(completionInput);
        const registry = createSystemRegistry([completion]);
        const issue = () => registry.run(completion.name, { deliveryId: intent.intentId }, {
          actor: 'completion:payments', now: now + 3, operation: completion.name,
          operationId: operationId() }, { store });
        const admitted = await issue();
        const issued = admitted.result as { status: string; sourceOccurrence: string; event: string };
        assert.equal(issued.status, 'staged', mode);
        assert.equal(((await issue()).result as { status: string }).status, 'replayed', mode);
        const handler = ({ collect: 'collected', refund: 'refunded', cancel: 'checkout_cancelled',
          reconcile: 'reconciled' } as const)[op];
        const selector = { scope, event: issued.event, sourceOccurrence: issued.sourceOccurrence,
          handler: `invoice.${handler}` };
        const invoke = (current = selector) => invokeRetainedHandlerOccurrenceCanonical({ asm, artifact,
          app: scope.app, selector: current, store, identities, now: () => now + 4 });
        await assert.rejects(() => invoke({ ...selector, handler: `invoice.${handler === 'collected' ? 'refunded' : 'collected'}` }),
          `${mode}: cannot retarget original route`);
        const committed: Array<Parameters<typeof store.commit>[0]> = [];
        const originalCommit = store.commit.bind(store);
        Object.defineProperty(store,'commit',{value:async(batch:Parameters<typeof store.commit>[0])=>{
          const result=await originalCommit(batch);committed.push(batch);return result;
        }});
        const beforeTerminal=await store.load(model('invoice.Invoice'),invoice.id);assert.ok(beforeTerminal);
        const expectedLedger=String(BigInt(String(beforeTerminal.data['ledger_revision']))+1n);
        const handled = await invoke().catch(error => { throw new Error(`${mode}: ${error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error)}`,{cause:error}); }) as { status: string };
        assert.equal(handled.status, mismatch ? 'failed' : 'completed', `${mode}: ${JSON.stringify(handled)}`);
        assert.equal((await invoke() as { status: string }).status, 'replayed', `${mode}: idempotent handler`);
        const currentInvoice = await store.load(model('invoice.Invoice'), invoice.id); assert.ok(currentInvoice);
        const currentAttempt = await store.load(model('invoice.Attempt'), attempt.id); assert.ok(currentAttempt);
        const changed = (op === 'collect' && status !== 'succeeded') || (op === 'refund' && status === 'failed');
        assert.equal(currentInvoice.data['ledger_revision'], changed ? expectedLedger : String(beforeTerminal.data['ledger_revision']), mode);
        if (changed) {
          assert.equal(committed.filter(batch=>batch.writes.some(write=>write.model==='invoice.Invoice')).length,1,
            `${mode}: parent changes commit once`);
          const atomic=committed.find(batch=>batch.writes.some(write=>write.model==='invoice.Invoice'))!;
          for(const name of ['invoice.Invoice','invoice.Attempt','work.occurrence']) assert.ok(
            atomic.writes.some(write=>write.model===name),`${mode}: ${name} shares the final owner transaction`);
        }

        assert.equal(currentAttempt.data['status'], changed ? status === 'skipped' ? 'failed' : 'unknown' : 'pending', mode);
        if (changed) assert.equal(currentAttempt.data['outcome_at'], new Date(now + 4).toISOString(), mode);
        if (op === 'collect' && status === 'skipped') {
          assert.equal(currentInvoice.data['state'], 'void', mode);
          assert.equal(currentAttempt.data['disabled'], true, mode);
          assert.equal(currentAttempt.data['checkout'], null, mode);
          assert.equal(currentAttempt.data['failure'], 'cancelled', mode);
        }
        const events = await store.query({ model: model('work.occurrence'), authority: 'owner' });
        const receipts = events.filter(row => (row.data['result'] as { event?: string })?.event === 'invoice.ProviderReceipt');
        assert.equal(receipts.length, status === 'succeeded' && !mismatch ? 1 : 0, mode);
        if (receipts.length) assert.deepEqual((receipts[0]!.data['result'] as { payload: unknown }).payload,
          { value: nominal }, `${mode}: complete raw nominal result`);
        if(guardedRetained && op==='collect' && status==='succeeded' && mismatch===null) {
          assert.equal(receipts.length,1);
          const before=storageProbe.outboxAll().length;
          const invoke=()=>invokeRetainedHandlerOccurrenceCanonical({asm,artifact,app:scope.app,
            selector:{scope,event:'invoice.ProviderReceipt',sourceOccurrence:receipts[0]!.id,
              handler:applyResult?'invoice.apply_result':'invoice.guarded_receipt'},store,identities,
            deploymentBase:'https://billing.example.test',now:()=>now+5});
          for(const changed of [
            {scope,event:'invoice.ProviderReceipt',sourceOccurrence:'missing-source',handler:applyResult?'invoice.apply_result':'invoice.guarded_receipt'},
            {scope,event:'invoice.InvoiceSettlement',sourceOccurrence:receipts[0]!.id,handler:applyResult?'invoice.apply_result':'invoice.guarded_receipt'},
            {scope:{...scope,owner:'foreign-owner'},event:'invoice.ProviderReceipt',sourceOccurrence:receipts[0]!.id,handler:applyResult?'invoice.apply_result':'invoice.guarded_receipt'},
          ]) {
            const denied=await invokeRetainedHandlerOccurrenceCanonical({asm,artifact,app:scope.app,
              selector:changed,store,identities,deploymentBase:'https://billing.example.test',now:()=>now+5})
              .catch(()=>({status:'rejected'})) as {status:string};
            assert.ok(!['completed','replayed'].includes(denied.status),'foreign retained coordinates cannot execute');
            assert.equal(storageProbe.outboxAll().length,before,'foreign source/event/owner has no guarded effects');
          }
          const sourceRace=process.env['CAN_INVOICE_GUARDED_SOURCE']==='race';
          const sourceFalse=sourceRace || process.env['CAN_INVOICE_GUARDED_SOURCE']==='false';
          let raced=false;
          if(sourceRace) {
            assert.ok(applyResult);
            const commit=store.commit.bind(store);
            Object.defineProperty(store,'commit',{value:async(batch:Parameters<typeof store.commit>[0])=>{
              if(!raced && batch.outbox.some(intent=>intent.operation==='invoice.apply_result')) {
                raced=true;
                await commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:model('invoice.Credit'),
                  row:{...makeRow({id:asId('source-race-credit'),data:{amount:money('1500'),hidden:true}}),parent:{model:model('invoice.Invoice'),id:invoice.id}}}]}));
              }
              return commit(batch);
            }});
          }
          if(sourceFalse && !sourceRace) {
            assert.ok(applyResult);
            const row=await store.load(model('invoice.Invoice'),invoice.id);assert.ok(row);
            await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:model('invoice.Invoice'),id:row.id,
              expectedVersion:row.version,row:{...row,version:asVersion(row.version+1),data:{...row.data,state:'void'}}}]}));
          }
          assert.equal((await invoke() as {status:string}).status,failedFramework?'failed':'completed');
          if(sourceRace)assert.ok(raced,'original guard domain changed only at actual final commit');
          assert.equal(storageProbe.outboxAll().length,before+(sourceFalse || failedFramework?0:1),'original source guard stages Mail only when true');
          const scheduled=await store.query({model:model('work.schedule'),authority:'owner'});
          assert.equal(scheduled.filter(row=>row.data['key']===(applyResult?'invoice:collection':'guarded-followup') && row.data['state']==='pending').length,sourceFalse || failedFramework?0:1,
            'actual Schedule/Cancel/replace stages preserve one current head');
          assert.equal((await invoke() as {status:string}).status,'replayed');
          assert.equal(storageProbe.outboxAll().length,before+(sourceFalse || failedFramework?0:1),'replay cannot duplicate guarded SEND');
          if(failedFramework) {
            assert.equal((await store.load(model('invoice.Attempt'),attempt.id))!.data['outcome_at'],null,'late Require discards earlier SET');
            assert.equal(scheduled.length,0,'late Require discards genuine Schedule/Cancel stages');
          }
          if(sourceFalse || failedFramework)continue;
          const mail=storageProbe.outboxAll().find(candidate=>candidate.target==='std.EmailV1.send');assert.ok(mail);
          const staleRoot=process.env['CAN_INVOICE_GUARDED_DISPATCH']==='changed';
          if(staleRoot) {
            const row=await store.load(model('invoice.Attempt'),attempt.id);assert.ok(row);
            await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:model('invoice.Attempt'),
              id:row.id,expectedVersion:row.version,row:{...row,version:asVersion(row.version+1),
                data:{...row.data,status:applyResult?'succeeded':'failed',failure:applyResult?null:'transient'}}}]}));
          }
          const dispatchFences=await bindNativeEmailDispatchGuards({asm,artifact,store,identities,scope,
            revalidateAuthority:async()=>true});
          const fence=dispatchFences(mail);
          let mailCalls=0;
          const mailDispatched=await driveDispatchIntentWithPreclaim({store:joined,intent:mail,
            actor:'dispatch:retained-mail',operation:'test.retained-mail.dispatch',nowMs:()=>now+6,
            nextClaimId:()=>`mail-${mode}`,maxClaimAgeMs:60000,
            claimOperationId:uuidv7(now+6,20),recordOperationId:uuidv7(now+6,21),
            evaluateGuard:()=>true,readStateSnapshot:()=>null,fence,
            callProvider:async()=>{mailCalls++;return {kind:'delivered' as const,result:null};},classifyFailure},
            (guard,allocator)=>{
              const nativeClaim=createWorkDispatchClaimCommand((id,target)=>id===mail.intentId && target===mail.target,guard,allocator);
              return producers.createSystemRegistry(commands.map(command=>command.name===claim.name?nativeClaim:command));
            });
          assert.equal(mailCalls,staleRoot?0:1,'current original guard owns deferred provider dispatch');
          assert.ok(mailDispatched!==undefined);
          if(automaticCollection) {
            const schedule=scheduled.find(row=>row.data['key']==='invoice:collection' && row.data['state']==='pending');assert.ok(schedule);
            const due={occurrenceId:schedule.id,key:String(schedule.data['key']),at:Number(schedule.data['at']),event:'invoice.CollectionDue',scope};
            const dueNow=now+3*86400000;
            const source=await invokeDueSourceRoutingCanonical({asm,artifact,app:scope.app,
              handler:'invoice.automatic_collection',due,store,identities,now:()=>dueNow});
            assert.equal(source.status,'completed','actual retry schedule retains original ordinary source route');
            const automaticSelector={scope,event:due.event,sourceOccurrence:schedule.id,handler:'invoice.automatic_collection'};
            const automatic=()=>invokeRetainedHandlerOccurrenceCanonical({asm,artifact,app:scope.app,
              selector:automaticSelector,store,identities,now:()=>dueNow+1});
            assert.equal((await automatic() as {status:string}).status,'completed');
            const attempts=await store.query({model:model('invoice.Attempt'),authority:'owner'});
            assert.equal(attempts.length,2,'authored scheduled source creates exactly one retry Attempt');
            assert.equal(storageProbe.outboxAll().filter(intent=>intent.target==='std.PaymentsV1.collect').length,2,
              'authored retry SEND shares real owner transaction');
            assert.equal((await automatic() as {status:string}).status,'replayed');
            const retry=storageProbe.outboxAll().find(intent=>intent.target==='std.PaymentsV1.collect' && intent.operation==='invoice.automatic_collection');assert.ok(retry);
            const revoke=process.env['CAN_INVOICE_AUTOMATIC_DISPATCH']==='changed';
            if(revoke) {
              const row=await store.load(model('invoice.Invoice'),invoice.id);assert.ok(row);
              await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:model('invoice.Invoice'),
                id:row.id,expectedVersion:row.version,row:{...row,version:asVersion(row.version+1),data:{...row.data,consent:null}}}]}));
            }
            const retryFence=dispatchFences(retry);
            let retryCalls=0;
            await driveDispatchIntentWithPreclaim({store:joined,intent:retry,actor:'dispatch:retry',operation:'test.retry.dispatch',nowMs:()=>dueNow+2,
              nextClaimId:()=>`retry-${mode}`,maxClaimAgeMs:60000,claimOperationId:uuidv7(dueNow+2,22),recordOperationId:uuidv7(dueNow+2,23),
              evaluateGuard:()=>true,readStateSnapshot:()=>null,fence:retryFence,
              callProvider:async()=>{retryCalls++;return {kind:'delivered' as const,result:null};},classifyFailure},
              (guard,allocator)=>{
                const nativeClaim=createWorkDispatchClaimCommand((id,target)=>id===retry.intentId && target===retry.target,guard,allocator);
                return producers.createSystemRegistry(commands.map(command=>command.name===claim.name?nativeClaim:command));
              });
            assert.equal(retryCalls,revoke?0:1,'current consent/balance/original query guard fences retry provider dispatch');
          }

        }
        const settlements = events.filter(row => row.created===now+4 && (row.data['result'] as { event?: string })?.event === 'invoice.InvoiceSettlement');
        assert.equal(settlements.length, changed ? 1 : 0, mode);
        if (settlements.length) {
          const value = (settlements[0]!.data['result'] as { payload: { value: Record<string, unknown> } }).payload.value;
          assert.equal(value['revision'], expectedLedger, mode);
          assert.equal(value['collection_pending'], op === 'collect' && status !== 'skipped', mode);
          assert.equal(value['refund_pending'], op === 'refund', mode);
          assert.deepEqual(value['collected'], money(commercial ? '1000' : '0'), mode);
          assert.deepEqual(value['refunded'], money('0'), mode);
        }
        if (commercial) {
          const source=settlements[0]!;
          const invoke=()=>invokeRetainedHandlerOccurrenceCanonical({asm,artifact,app:scope.app,
            selector:{scope,event:'invoice.InvoiceSettlement',sourceOccurrence:source.id,
              handler:'invoice.observe_commercial_payment'},store,identities,now:()=>now+5});
          assert.equal((await invoke() as {status:string}).status,'completed');
          const histories=await store.query({model:model('invoice.CommercialHistory'),authority:'owner'});
          assert.equal(histories.length,1);
          assert.deepEqual(histories[0]!.data['first_invoice'],{id:'a-first'},'complete hidden domain and stable tie breaker');
          assert.equal(histories[0]!.parent?.id,customer.id,'foreign Customer ledger excluded');
          assert.equal((await store.load(model('invoice.Invoice'),invoice.id))!.data['first_paid_at'],
            new Date(now-1000).toISOString());
          assert.equal((await invoke() as {status:string}).status,'replayed');
        }
      }
      assert.ok(executed>0,`unknown terminal case: ${selectedCase}`);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('evaluates commercial history Require over complete ordered owner evidence and nullable admitted inputs',
  {timeout:900000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-invoice-commercial-require-'));
    const databases:Miniflare[]=[];
    try {
      const authored=await readFile(join(root,'draft/apps/CanInvoice/CanInvoice.can'),'utf8');
      const start=authored.indexOf('  scenario review_commercial_history(');
      const end=authored.indexOf('\n   examples ',start);
      const guards=authored.slice(start,end).replace('scenario review_commercial_history(','scenario verify(');
      let text=await readFile(source,'utf8');
      text=text.replace('package customer\n','package customer\n use rent_catalog {Location}\n')
        .replace('export Customer {kind:','export Customer {locations:Location[],kind:');
      const insertion=text.lastIndexOf(' Then\n');
      text=text.slice(0,insertion)+guards+'\n  scenario observe_sale on=SaleCheck\n   do let selected=event.sale\n'+text.slice(insertion);
      const path=join(directory,'commercial.can'); await writeFile(path,text);
      const {stdout}=await promisify(execFile)(compiler,
        ['compile','--format=json','--native-scenario-receipts','--catalog',catalog,path],
        {cwd:root,timeout:60000,maxBuffer:32*1024*1024});
      const artifact=JSON.parse(stdout) as CompileArtifact;
      assert.ok(!artifact.callables?.some(callable=>callable.id==='invoice.first_paid_invoice'),
        'ordinary helper entry is omitted rather than replaced by a throwing function');
      const asm=await assembleModules({artifact,sourcePath:path},{workDir:directory,
        stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
      for(const mode of ['complete','null-incomplete','complete-update','null-update','large-loop','loop-overflow','loop-race','wrong-first','foreign-parent','null-complete','timestamp-missing','worker-inactive','domain-race'] as const){
        if(process.env['CAN_INVOICE_HISTORY_CASE']!==undefined && process.env['CAN_INVOICE_HISTORY_CASE']!==mode)continue;
        const identities=createMemoryIdentityStore({clock:createFrozenClock(now)});
        const team=await identities.createTeam({timezone:'UTC'});
        const actor=await identities.createUser({email:`${mode}@commercial-require.test`,password_hash:'unused',email_verified:true});
        await identities.createMembership({team_id:team.team_id,user_id:actor.user_id,is_owner:false,
          roles:[{role:'invoice.finance',granted_at:new Date(now).toISOString(),granted_by:actor.user_id}]});
        const token=`commercial-${mode}`;
        await identities.createSession({user_id:actor.user_id,token_sha256:await sha256HexText(token),
          last_team_id:team.team_id,expires_at:new Date(now+3600000).toISOString()});
        const identity=await resolveIdentity(identities,{session_token:token},{clock:createFrozenClock(now)});
        const scope={app:'CanInvoice',owner:team.team_id,ownerPackage:'invoice'};
        const authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'commercial-state',
          fileStoreId:'commercial-files',receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
        const producers=[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER];
        let database:D1Database|undefined;
        if(process.env['CAN_INVOICE_HISTORY_STORAGE']==='d1'){
          const worker=new Miniflare({compatibilityDate:'2026-07-15',modules:true,
            script:'export default { fetch() { return new Response("ok"); } }',
            d1Databases:{DB:'invoice-history'},d1Persist:join(directory,`d1-${mode}`)});
          databases.push(worker);
          database=await worker.getD1Database('DB') as unknown as D1Database;
          await ensureSchema(database);
        }
        const store=database===undefined?createTestMemoryStorage(authority,producers).store:createD1Storage(database,authority,producers);
        await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,
          verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
        const location={...makeRow({id:asId('location'),data:{active:true}}),parent:null};
        const customer={...makeRow({id:asId('customer'),data:{kind:'company',locations:[{id:location.id}],hidden:false}}),parent:null};
        const invoice=(id:string)=>({...makeRow({id:asId(id),data:{location:{id:location.id},source:id,currency:'EUR',
          state:'issued',total:money('1000'),next_collection:null,ledger_revision:'1',first_paid_at:null,hidden:true}}),
          parent:{model:model('customer.Customer'),id:customer.id}});
        const first=invoice('a-first'), second=invoice('b-second');
        const foreign={...customer,id:asId('foreign-customer')};
        if(mode==='foreign-parent')second.parent={model:model('customer.Customer'),id:foreign.id};
        const payment=(id:string,owner:StoredRow)=>({...makeRow({id:asId(id),data:{amount:money('1000'),
          received:new Date(now-1000).toISOString(),hidden:true}}),parent:{model:model('invoice.Invoice'),id:owner.id}});
        const employee={...makeRow({id:asId('employee'),data:{user:{id:actor.user_id},home:{id:location.id},
          locations:[],operator_wide:false,active:mode!=='worker-inactive',hidden:true}}),parent:null};
        const update=mode==='complete-update'||mode==='null-update';
        const saleCount=mode==='large-loop'||mode==='loop-race'?201:mode==='loop-overflow'?501:0;
        const sales=Array.from({length:saleCount},(_,index)=>({...makeRow({id:asId(`sale-${String(index).padStart(4,'0')}`),data:{source:`commercial-sale-${index}`}}),
          parent:{model:model('customer.Customer'),id:customer.id}}));
        const history=(id:string)=>({...makeRow({id:asId(id),data:{complete:false,first_invoice:null,evidence:'Before',hidden:true}}),
          parent:{model:model('customer.Customer'),id:customer.id}});
        await store.commit(makeBatch(await store.readRevision(),{writes:[
          {kind:'insert',model:model('rent_catalog.Location'),row:location},
          {kind:'insert',model:model('customer.Customer'),row:customer},
          ...(mode==='foreign-parent'?[{kind:'insert' as const,model:model('customer.Customer'),row:foreign}]:[]),
          {kind:'insert',model:model('employee.Employee'),row:employee},
          ...sales.map(row=>({kind:'insert' as const,model:model('invoice.CommercialSale'),row})),
          ...(update?['a-history','b-history'].map(id=>({kind:'insert' as const,model:model('invoice.CommercialHistory'),row:history(id)})):[]),
          {kind:'insert',model:model('invoice.Invoice'),row:first},
          {kind:'insert',model:model('invoice.Invoice'),row:second},
          {kind:'insert',model:model('invoice.ExternalPayment'),row:payment('second-payment',second)},
          ...(mode==='timestamp-missing'?[{kind:'insert' as const,model:model('invoice.Attempt'),row:{...makeRow({id:asId('missing-time'),
            data:{reference:'missing',amount:money('1000'),kind:'collection',status:'succeeded',failure:null,disabled:false,
              delivery:null,received:null,hidden:true}}),parent:{model:model('invoice.Invoice'),id:first.id}}}]:[
            {kind:'insert' as const,model:model('invoice.ExternalPayment'),row:payment('first-payment',first)}]),
        ]}));
        if(mode==='large-loop'||mode==='complete'){
          const commit=store.commit.bind(store);
          let checkedBatch=false;
          Object.defineProperty(store,'commit',{value:async(batch:Parameters<typeof store.commit>[0])=>{
            if(!checkedBatch && batch.writes.some(write=>write.model==='invoice.CommercialHistory')){
              checkedBatch=true;
              const revision=await store.readRevision();
              const sparse=[...batch.writes]; delete sparse[0];
              await assert.rejects(()=>commit({...batch,writes:sparse}),/reference/);
              let getterRan=false;
              const accessor=[...batch.writes];
              Object.defineProperty(accessor,'0',{enumerable:true,get(){getterRan=true;throw new Error('untrusted accessor');}});
              await assert.rejects(()=>commit({...batch,writes:accessor}),/reference/);
              assert.equal(getterRan,false,'complete commit detaches descriptors before reading values');
              const hiddenIndex=new Proxy([...batch.writes],{ownKeys(target){
                return Reflect.ownKeys(target).map(key=>key==='0'?'ignored-index':key);
              }});
              await assert.rejects(()=>commit({...batch,writes:hiddenIndex}),/reference/);
              let lengthReads=0;
              const changingCensus=new Proxy([...batch.writes],{getOwnPropertyDescriptor(target,key){
                if(key==='length')lengthReads++;
                return Reflect.getOwnPropertyDescriptor(target,key);
              }});
              await assert.rejects(()=>commit({...batch,writes:changingCensus,receipt:undefined} as unknown as Parameters<typeof store.commit>[0]),/reference/);
              assert.equal(lengthReads,1,'complete outer collection descriptors are captured once');
              assert.equal(await store.readRevision(),revision,'malformed complete batches are atomic');
            }
            return commit(batch);
          }});
        }
        let raced=false;
        if(mode==='domain-race'||mode==='loop-race'){
          const commit=store.commit.bind(store);
          Object.defineProperty(store,'commit',{value:async(batch:Parameters<typeof store.commit>[0])=>{
            if(!raced && batch.writes.some(write=>write.model==='invoice.CommercialHistory')){
              raced=true;
              if(mode==='loop-race'){
                const concurrent={...sales[0]!,id:asId('concurrent-sale')};
                await commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:model('invoice.CommercialSale'),row:concurrent}]}));
                return commit(batch);
              }
              const concurrent=payment('concurrent-payment',second);
              await commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:model('invoice.ExternalPayment'),
                row:{...concurrent,data:{...concurrent.data,
                  received:new Date(now-5000).toISOString()}}}]}));
            }
            return commit(batch);
          }});
        }
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const selected=mode==='null-incomplete'||mode==='null-complete'||mode==='null-update'?null:mode==='wrong-first'||mode==='foreign-parent'?second:first;
        const result=await invoker.invokeMutation({operation:'invoice.verify',operation_id:operationId(),inputs:{
          customer:{id:customer.id,version:String(customer.version)},complete:mode!=='null-incomplete'&&mode!=='null-update',
          first_invoice:selected===null?null:{id:selected.id,version:String(selected.version)},evidence:'Reviewed ledger'}},identity);
        const successful=mode==='complete'||mode==='null-incomplete'||update||mode==='large-loop'||mode==='loop-race';
        assert.equal('result' in result && result.result.status==='committed',successful,`${mode}: ${JSON.stringify(result)}`);
        const histories=await store.query({model:model('invoice.CommercialHistory'),authority:'owner'});
        assert.equal(histories.length,update?2:successful?1:0,`${mode}: atomic original decision`);
        if(successful){
          const chosen=update?histories.find(row=>row.id===asId('a-history'))!:histories[0]!;
          assert.deepEqual(chosen.data['first_invoice'],selected===null?null:{id:selected.id});
          assert.equal(chosen.data['evidence'],'Reviewed ledger');
          if(update)assert.equal(histories.find(row=>row.id===asId('b-history'))!.data['evidence'],'Before','id-FIRST selects exactly its original earliest row');
        }
        const occurrences=await store.query({model:model('work.occurrence'),authority:'owner'});
        const saleSources=occurrences.filter(row=>(row.data['result'] as {event?:string}|undefined)?.event==='invoice.SaleCheck');
        const expectedSources=successful?saleCount+(mode==='loop-race'?1:0):0;
        assert.equal(saleSources.length,expectedSources,`${mode}: complete authored loop source inventory`);
        const handlers=await store.query({model:model('work.handler_occurrence'),authority:'owner'});
        assert.equal(handlers.filter(row=>row.data['handler']==='invoice.observe_sale').length,expectedSources,`${mode}: complete ordinary route inventory`);
        if(database!==undefined){
          const reopened=createD1Storage(database,authority,producers);
          assert.equal(await reopened.readRevision(),await store.readRevision(),'durable lifetime inventory reload retains the exact complete fence');
          assert.deepEqual(await reopened.query({model:model('work.occurrence'),authority:'owner'}),occurrences,
            'durable reload preserves every source and complete File lifetime inventory');
        }
        if(mode==='loop-race')assert.ok(raced,'native whole-domain selection revalidated before final commit');
        if(mode==='domain-race')assert.ok(raced,'final owner fence observed concurrent query-domain mutation');
      }
    }finally{await Promise.all(databases.map(database=>database.dispose()));await rm(directory,{recursive:true,force:true});}
  });
