/** Original invoice issue owns its line total, number uniqueness, defaults, settlement, and notices. */
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
const source = join(root, 'packages/cloudflare/test/fixtures/invoice-issue-owner-probe.can');
const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
const model = (name: string) => asModel(name);
const money = (minor: string) => ({ minor, currency: 'EUR' });
const now = Date.parse('2099-01-01T12:00:00.000Z');
const deploymentBase = 'https://workspace.example.test';

function operationId(): string {
  const time = now.toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-8${random.slice(4, 7)}-${random.slice(7, 19)}`;
}

it('rejects changed issue authority, line pricing, number check, defaults, settlement, Mail, and schedule',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-invoice-issue-mutants-'));
    try {
      const original = await readFile(source, 'utf8');
      const variants = [
        ['worker', 'can_work(actor,invoice.location) and invoice.state==draft',
          'invoice.state==draft'],
        ['lines', 'count(invoice.Line)>0', 'count(invoice.Line)>=0'],
        ['number-unique', 'other.number==number', 'other.number!=number'],
        ['defaults', 'defaults.retry_window>0m', 'defaults.retry_window>=0m'],
        ['total', 'line.price*line.quantity+line.tax-line.discount',
          'line.price*line.quantity+line.tax+line.discount'],
        ['set', 'ledger_revision=invoice.ledger_revision+1',
          'ledger_revision=invoice.ledger_revision+2'],
        ['settlement', 'collection_pending=any(invoice.Attempt as attempt,attempt.kind==collection',
          'collection_pending=any(invoice.Attempt as attempt,attempt.kind==refund'],
        ['mail', 'to=invoice.recipient_email', 'to="other@example.test"'],
        ['mail-guard', 'when=invoice.state==issued as notice',
          'when=invoice.state==draft as notice'],
        ['schedule', 'add_days(invoice.due,1)', 'add_days(invoice.due,2)'],
      ] as const;
      for (const [name, before, after] of variants) {
        assert.equal(original.split(before).length, 2, `${name}: unique source segment`);
        const path = join(directory, `${name}.can`);
        await writeFile(path, original.replace(before, after));
        const result = spawnSync(compiler,
          ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, path],
          { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
        assert.equal(result.status, 10, `${name}: ${result.stderr || result.stdout}`);
        const report = JSON.parse(result.stdout) as { diagnostics: { code: string }[] };
        assert.deepEqual(report.diagnostics.map(diagnostic => diagnostic.code), ['E6008', 'E6008'],
          `${name}: both original issue receipt sites must lose proof`);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('issues only from complete current owner evidence and commits its original four effects',
  { timeout: 240000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-invoice-issue-'));
    try {
      const probe = await readFile(source, 'utf8');
      const original = await readFile(join(root, 'draft/apps/CanInvoice/CanInvoice.can'), 'utf8');
      const start = original.indexOf('  scenario issue(invoice:Invoice,');
      const end = original.indexOf('  # Render the issued invoice', start);
      assert.ok(start >= 0 && end > start);
      assert.ok(probe.includes(original.slice(start, end).trimEnd()), 'original issue handler is retained');
      for (const name of ['settlement(invoice:', 'Invoice.credits:', 'Invoice.received:',
        'Invoice.refunded:']) {
        const declaration = original.split('\n').find(line => line.includes(`derive ${name}`));
        assert.ok(declaration && probe.includes(declaration.trim().split(' label=')[0]!), name);
      }
      const workers = await readFile(join(root, 'draft/shared/Employees.can'), 'utf8');
      const canWork = workers.split('\n').find(line => line.includes('export derive can_work('));
      assert.ok(canWork && probe.includes(canWork.trim()), 'original can_work helper is retained');
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const singleArtifact = JSON.parse(stdout) as CompileArtifact;
      const singleAsm = await assembleModules({ artifact: singleArtifact, sourcePath: source }, { workDir: directory,
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
        uiUrl: import.meta.resolve('@canlang/ui') });
      const employeeStart = probe.indexOf('package employee\n');
      const customerStart = probe.indexOf('package customer\n', employeeStart);
      assert.ok(employeeStart > 0 && customerStart > employeeStart);
      const splitMain = join(directory, 'issue-main.can');
      const splitEmployee = join(directory, 'issue-employee.can');
      await writeFile(splitMain, probe.slice(0, employeeStart) + probe.slice(customerStart));
      await writeFile(splitEmployee, probe.slice(employeeStart, customerStart));
      const splitOutput = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog,
          splitMain, splitEmployee],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const splitArtifact = JSON.parse(splitOutput.stdout) as CompileArtifact;
      assert.equal(splitArtifact.sources.length, 2, 'helper and issue have distinct source files');
      const splitAsm = await assembleModules({ artifact: splitArtifact, sourcePath: splitMain },
        { workDir: directory,
          stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
          uiUrl: import.meta.resolve('@canlang/ui') });

      for (const mode of [
        'hidden-ledger', 'two-lines', 'pending-ledger', 'split-helper',
        'no-finance', 'wrong-worker', 'inactive-worker',
        'no-lines', 'duplicate-number', 'blank-number', 'issued-invoice',
        'missing-defaults', 'zero-delay', 'stale-input',
        'line-at-commit', 'defaults-at-commit', 'number-at-commit', 'worker-at-commit',
      ] as const) {
        const artifact = mode === 'split-helper' ? splitArtifact : singleArtifact;
        const asm = mode === 'split-helper' ? splitAsm : singleAsm;
        const identities = createMemoryIdentityStore({ clock: createFrozenClock(now) });
        const team = await identities.createTeam({ timezone: 'UTC' });
        const actor = await identities.createUser({ email: `actor-${mode}@invoice-issue.test`,
          password_hash: 'unused', email_verified: true });
        await identities.createMembership({ team_id: team.team_id, user_id: actor.user_id,
          is_owner: false, roles: mode === 'no-finance' ? [] : [{ role: 'invoice.finance',
            granted_at: new Date(now).toISOString(), granted_by: actor.user_id }] });
        const token = `invoice-issue-${mode}-${randomBytes(8).toString('hex')}`;
        await identities.createSession({ user_id: actor.user_id,
          token_sha256: await sha256HexText(token), last_team_id: team.team_id,
          expires_at: new Date(now + 3600000).toISOString() });
        const identity = await resolveIdentity(identities, { session_token: token },
          { clock: createFrozenClock(now) });
        const scope = { app: 'CanInvoice', owner: team.team_id, ownerPackage: 'invoice' };
        const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app,
          stateStoreId: 'invoice-issue-state', fileStoreId: 'invoice-issue-files',
          receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
        const { store, probe: storageProbe } = createTestMemoryStorage(authority,
          [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({ artifact, asm, store, authority, scope,
          now: () => now, verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
        const location = { ...makeRow({ id: asId('site'), data: {
          active: true, timezone: 'UTC' } }), parent: null };
        const otherLocation = { ...makeRow({ id: asId('other-site'), data: {
          active: true, timezone: 'UTC' } }), parent: null };
        const customer = { ...makeRow({ id: asId('customer'), data: {
          kind: 'company', hidden: false } }), parent: null };
        const invoice = { ...makeRow({ id: asId('invoice'), data: {
          location: { id: location.id }, source: 'invoice-source', currency: 'EUR',
          state: mode === 'issued-invoice' ? 'issued' : 'draft', total: money('0'),
          ledger_revision: '7', recipient_email: 'customer@example.test',
          description: 'Desk rental', due: '2099-01-10', number: null, issued_at: null,
          attempt_limit: '3', retry_delay: '172800000', retry_until: null, hidden: false } }),
          parent: { model: model('customer.Customer'), id: customer.id } };
        const line = { ...makeRow({ id: asId('line'), data: {
          price: money('5000'), quantity: '2', tax: money('1000'), discount: money('500'),
          hidden: true } }), parent: { model: model('invoice.Invoice'), id: invoice.id } };
        const secondLine = { ...makeRow({ id: asId('second-line'), data: {
          price: money('2000'), quantity: '1', tax: money('0'), discount: money('0'),
          hidden: true } }), parent: { model: model('invoice.Invoice'), id: invoice.id } };
        const defaults = { ...makeRow({ id: asId('defaults'), data: {
          issuer: 'Canlang', attempt_limit: '4',
          retry_delay: mode === 'zero-delay' ? '0' : '86400000',
          retry_window: '1209600000', hidden: true } }), parent: null };
        const employee = { ...makeRow({ id: asId('employee'), data: {
          user: { id: actor.user_id },
          home: { id: mode === 'wrong-worker' ? otherLocation.id : location.id },
          locations: [], operator_wide: false, active: mode !== 'inactive-worker',
          hidden: true } }), parent: null };
        const duplicate = { ...makeRow({ id: asId('duplicate'), data: {
          ...invoice.data, source: 'other-source', number: '2026-100', hidden: true } }),
          parent: { model: model('customer.Customer'), id: customer.id } };
        const prior = { ...makeRow({ id: asId('prior-attempt'), data: {
          reference: 'prior', amount: money('1500'), kind: 'collection',
          status: mode === 'pending-ledger' ? 'pending' : 'succeeded',
          failure: null, disabled: false, delivery: null, hidden: true } }),
          parent: { model: model('invoice.Invoice'), id: invoice.id } };
        const pendingRefund = { ...makeRow({ id: asId('pending-refund'), data: {
          reference: 'pending-refund', amount: money('300'), kind: 'refund', status: 'unknown',
          failure: null, disabled: false, delivery: null, hidden: true } }),
          parent: { model: model('invoice.Invoice'), id: invoice.id } };
        const payment = { ...makeRow({ id: asId('payment'), data: {
          amount: money('250'), hidden: true } }),
          parent: { model: model('invoice.Invoice'), id: invoice.id } };
        const refund = { ...makeRow({ id: asId('refund'), data: {
          amount: money('100'), hidden: true } }),
          parent: { model: model('invoice.Invoice'), id: invoice.id } };
        const credit = { ...makeRow({ id: asId('credit'), data: {
          amount: money('500'), hidden: true } }),
          parent: { model: model('invoice.Invoice'), id: invoice.id } };
        const writes: Array<{ kind: 'insert'; model: ModelName; row: StoredRow }> = [
          { kind: 'insert', model: model('rent_catalog.Location'), row: location },
          { kind: 'insert', model: model('rent_catalog.Location'), row: otherLocation },
          { kind: 'insert', model: model('customer.Customer'), row: customer },
          { kind: 'insert', model: model('invoice.Invoice'), row: invoice },
          { kind: 'insert', model: model('employee.Employee'), row: employee },
          { kind: 'insert', model: model('invoice.Credit'), row: credit },
          { kind: 'insert', model: model('invoice.Attempt'), row: prior },
          { kind: 'insert', model: model('invoice.ExternalPayment'), row: payment },
          { kind: 'insert', model: model('invoice.ExternalRefund'), row: refund },
        ];
        if (mode !== 'no-lines') writes.push({ kind: 'insert', model: model('invoice.Line'), row: line });
        if (mode === 'two-lines') writes.push({ kind: 'insert', model: model('invoice.Line'), row: secondLine });
        if (mode === 'pending-ledger') writes.push({ kind: 'insert', model: model('invoice.Attempt'), row: pendingRefund });
        if (mode !== 'missing-defaults') writes.push({ kind: 'insert', model: model('invoice.Defaults'), row: defaults });
        if (mode === 'duplicate-number') writes.push({ kind: 'insert', model: model('invoice.Invoice'), row: duplicate });
        await store.commit(makeBatch(await store.readRevision(), { writes }));
        let injected = false;
        if (mode.endsWith('-at-commit')) {
          const commit = store.commit.bind(store);
          Object.defineProperty(store, 'commit', { value: async (batch: Parameters<typeof store.commit>[0]) => {
            if (!injected && batch.outbox.length > 0) {
              injected = true;
              if (mode === 'line-at-commit' || mode === 'number-at-commit') {
                await commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert',
                  model: mode === 'line-at-commit' ? model('invoice.Line') : model('invoice.Invoice'),
                  row: mode === 'line-at-commit' ? secondLine : duplicate }] }));
              } else {
                const name = mode === 'defaults-at-commit' ? 'invoice.Defaults' : 'employee.Employee';
                const current = await store.load(model(name),
                  mode === 'defaults-at-commit' ? defaults.id : employee.id);
                assert.ok(current);
                await commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update',
                  model: model(name), id: current.id, expectedVersion: current.version,
                  row: { ...current, version: asVersion(current.version + 1), updated: now,
                    data: { ...current.data, ...(mode === 'defaults-at-commit'
                      ? { retry_window: '0' } : { active: false }) } } }] }));
              }
            }
            return commit(batch);
          } });
        }
        const invoker = buildInvoker(artifact, asm, store,
          { memberships: identities, now: () => now, deploymentBase });
        const id = operationId();
        const outcome = await invoker.invokeMutation({ operation: 'invoice.issue', operation_id: id,
          inputs: { invoice: { id: invoice.id,
            version: String(invoice.version + (mode === 'stale-input' ? 1 : 0)) },
            number: mode === 'blank-number' ? ' ' : '2026-100' } }, identity);
        const success = mode === 'hidden-ledger' || mode === 'two-lines' ||
          mode === 'pending-ledger' || mode === 'split-helper' || mode === 'line-at-commit';
        const issuedTotal = money(mode === 'two-lines' || mode === 'line-at-commit' ? '12500' : '10500');
        const code = 'result' in outcome ? outcome.result.status : outcome.error.code;
        if (success) assert.equal(code, 'committed', `${mode}: ${JSON.stringify(outcome)}`);
        else assert.ok((mode === 'blank-number' ? ['validation'] :
          ['forbidden', 'rule_failed', 'conflict']).includes(code),
          `${mode}: ${JSON.stringify(outcome)}`);
        const current = await store.load(model('invoice.Invoice'), invoice.id); assert.ok(current);
        assert.equal(current.data['state'], success ? 'issued' : invoice.data.state, mode);
        assert.equal(current.data['ledger_revision'], success ? '8' : '7', mode);
        assert.deepEqual(current.data['total'], success ? issuedTotal : money('0'), mode);
        assert.equal(current.data['number'], success ? '2026-100' : null, mode);
        assert.equal(storageProbe.outboxAll().length, success ? 1 : 0, `${mode}: Mail intent count`);
        const events = await store.query({ model: model('work.occurrence'), authority: 'owner' });
        assert.equal(events.length, success ? 1 : 0, `${mode}: settlement occurrence count`);
        const schedules = await store.query({ model: model('work.schedule'), authority: 'owner' });
        assert.equal(schedules.length, success ? 1 : 0, `${mode}: Overdue schedule count`);
        if (success) {
          assert.equal(current.data['attempt_limit'], '4', mode);
          assert.equal(current.data['retry_delay'], '86400000', mode);
          assert.equal(current.data['retry_until'], new Date(now + 1209600000).toISOString(), mode);
          assert.equal(current.data['issued_at'], new Date(now).toISOString(), mode);
          const intent = storageProbe.outboxAll()[0]!;
          assert.equal(intent.target, 'std.EmailV1.send', mode);
          assert.equal(intent.operation, 'invoice.issue', mode);
          assert.equal(intent.operationId, id, mode);
          assert.equal(intent.arguments['binding'], 'invoice.Mail', mode);
          assert.deepEqual(intent.arguments['arguments'], {
            to: 'customer@example.test', subject: 'Invoice issued',
            body: `Desk rental ${deploymentBase}/finance/invoice/${invoice.id}`,
            attachments: [],
          }, mode);
          const result = events[0]!.data['result'] as Record<string, unknown>;
          assert.equal(result['kind'], 'declared-event-source', mode);
          assert.equal(result['event'], 'invoice.InvoiceSettlement', mode);
          const payload = result['payload'] as { value: Record<string, unknown> };
          assert.equal(payload.value['revision'], '8', mode);
          assert.deepEqual(payload.value['amount'], issuedTotal, mode);
          assert.deepEqual(payload.value['collected'], money(mode === 'pending-ledger' ? '250' : '1750'), mode);
          assert.deepEqual(payload.value['refunded'], money('100'), mode);
          assert.equal(payload.value['collection_pending'], mode === 'pending-ledger', mode);
          assert.equal(payload.value['refund_pending'], mode === 'pending-ledger', mode);
          assert.equal(payload.value['state'], 'issued', mode);
          assert.ok(Object.hasOwn(events[0]!.data, 'filePayloadOrigin'), `${mode}: genuine File event origin`);
          assert.equal(schedules[0]!.data['event'], 'invoice.Overdue', mode);
          assert.equal(schedules[0]!.data['key'], invoice.id, mode);
          assert.equal(schedules[0]!.data['at'], Date.parse('2099-01-11T00:00:00.000Z'), mode);
          assert.ok(Object.hasOwn(schedules[0]!.data, 'filePayloadOrigin'), `${mode}: genuine File schedule origin`);
          if (mode === 'two-lines' || mode === 'pending-ledger') {
            const before = await store.load(model('invoice.Invoice'), invoice.id);
            assert.ok(before);
            await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update',
              model: model('invoice.Invoice'), id: before.id, expectedVersion: before.version,
              row: { ...before, version: asVersion(before.version + 1), updated: now,
                data: { ...before.data, ...(mode === 'two-lines'
                  ? { state: 'void' } : { recipient_email: 'changed@example.test' }) } } }] }));
          }
          const frozen = structuredClone(intent.arguments);
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
            store: joined, intent, actor: 'dispatch:invoice.issue',
            operation: 'test.invoice.issue.dispatch', nowMs: () => now + 1000,
            nextClaimId: () => `claim-${mode}`, maxClaimAgeMs: 60000,
            claimOperationId: uuidv7(now + 1000, 1), recordOperationId: uuidv7(now + 1000, 2),
            evaluateGuard: () => { throw new Error('native issue Mail guard was bypassed'); },
            readStateSnapshot: () => null,
            callProvider: async () => { providerCalls++; return { kind: 'delivered', result: null }; },
            classifyFailure, fence: fenceFor(intent),
          }, (guard, allocator) => {
            const guarded = createWorkDispatchClaimCommand((candidateId, target) =>
              candidateId === intent.intentId && target === intent.target, guard, allocator);
            return producers.createSystemRegistry(commands.map(command =>
              command.name === claim.name ? guarded : command));
          });
          const shouldDeliver = mode === 'hidden-ledger' || mode === 'split-helper' ||
            mode === 'line-at-commit';
          assert.equal(dispatch.status, shouldDeliver ? 'recorded' : 'not-claimed',
            `${mode}: ${JSON.stringify(dispatch)}`);
          if (dispatch.status === 'not-claimed') assert.equal(dispatch.reason, 'guard-false', mode);
          assert.equal(providerCalls, shouldDeliver ? 1 : 0, `${mode}: provider calls`);
          assert.deepEqual((await store.outboxGet(intent.intentId))?.intent.arguments, frozen,
            `${mode}: immutable original Mail arguments`);
        }
        if (mode.endsWith('-at-commit')) assert.equal(injected, true, `${mode}: race hook reached`);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
