/** An overdue Mail is decided from the current private Invoice and its complete balance ledger. */
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { promisify } from 'node:util';
import type { CompileArtifact, FileRetirementAuthority } from '@canlang/contracts';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { STATE_FILE_REFERENCE_PRODUCER } from '@canlang/state/storage';
import { asId, asModel, asVersion, makeBatch, makeRow, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work/kernel/file-reference-inventory';
import { WORK_DISPATCH_STAGE_COMMANDS, WORK_SYSTEM_COMMANDS,
  createWorkDispatchClaimCommand } from '@canlang/work/kernel/commands';
import { classifyFailure } from '@canlang/work/receipt';
import { workSchedulePutCommand } from '@canlang/work/kernel/schedule-staging';
import { assembleDispatchCommands, buildInvoker } from '../worker/assembly.js';
import { installNativeFileInventory } from './file-inventory.js';
import { bindNativeEmailDispatchGuards, createWorkerDispatchJoinPort,
  driveDispatchIntentWithPreclaim, invokeDueScheduleCanonical,
  loadCanonicalDescriptors, loadDispatchSystemProducers, withDispatchJoinPort } from './invoke.js';
import { assembleModules } from './modules.js';
import { loadOpaqueFileStaging } from './opaque-file-staging.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const source = join(root, 'packages/cloudflare/test/fixtures/invoice-overdue-owner-probe.can');
const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
const model = (name: string) => asModel(name);
const amount = (minor: string) => ({ minor, currency: 'EUR' });
const now = Date.parse('2099-01-01T12:00:00.000Z');
const deploymentBase = 'https://workspace.example.test';

it('refuses mutations to the original overdue guard, Mail request, and balance derivation',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-invoice-overdue-mutants-'));
    try {
      const original = await readFile(source, 'utf8');
      const variants = [
        ['require', 'event.invoice.state==issued and event.invoice.balance.minor>0',
          'event.invoice.state==draft and event.invoice.balance.minor>0'],
        ['recipient', 'to=event.invoice.recipient_email', 'to="different@example.test"'],
        ['subject', '"Invoice overdue"@{nl="Factuur achterstallig"}',
          '"Different reminder"@{nl="Factuur achterstallig"}'],
        ['body', 'description=event.invoice.description', 'description="Changed"'],
        ['guard', 'when=event.invoice.state==issued and event.invoice.balance.minor>0',
          'when=event.invoice.state==issued and event.invoice.balance.minor>=0'],
        ['credits', 'sum(row.Credit as credit select credit.amount,row.currency)',
          'money(0,row.currency)'],
        ['attempts', 'attempt.kind==collection and attempt.status==succeeded',
          'attempt.kind==refund and attempt.status==succeeded'],
        ['payments', 'sum(row.ExternalPayment as payment select payment.amount,row.currency)',
          'money(0,row.currency)'],
      ] as const;
      for (const [name, before, after] of variants) {
        assert.ok(original.includes(before), name);
        const changed = original.replace(before, after);
        assert.notEqual(changed, original, name);
        const path = join(directory, `${name}.can`);
        await writeFile(path, changed);
        const result = spawnSync(compiler,
          ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, path],
          { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
        assert.equal(result.status, 10, `${name}: ${result.stderr || result.stdout}`);
        const report = JSON.parse(result.stdout) as { sources: { sha256: string }[];
          diagnostics: { code: string; message: string;
            primary: { file: number; start: number; end: number } }[] };
        assert.equal(report.sources[0]?.sha256,
          createHash('sha256').update(changed).digest('hex'), name);
        const ownerName = changed.indexOf('scenario overdue') + 'scenario '.length;
        const guard = changed.indexOf('when=event.invoice.') + 'when='.length;
        const guardEnd = changed.indexOf(' as notice', guard);
        assert.ok(ownerName >= 'scenario '.length && guard >= 'when='.length && guardEnd > guard);
        assert.ok(report.diagnostics.some(diagnostic => diagnostic.code === 'E6008' &&
          diagnostic.primary.file === 0 &&
          (diagnostic.primary.start === ownerName && diagnostic.primary.end === ownerName + 'overdue'.length ||
            diagnostic.primary.start === guard && diagnostic.primary.end === guardEnd)),
        `${name}: original overdue owner or SEND guard must lose its proof`);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('sends overdue Mail only for a current positive owner balance from genuine Work',
  { timeout: 180000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-invoice-overdue-'));
    try {
      const probe = await readFile(source, 'utf8');
      const original = await readFile(join(root, 'draft/apps/CanInvoice/CanInvoice.can'), 'utf8');
      const start = original.indexOf('  scenario overdue on=Overdue');
      const end = original.indexOf('   examples seed=', start);
      assert.ok(start >= 0 && end > start);
      assert.ok(probe.includes(original.slice(start, end).trimEnd()), 'original overdue handler is retained');
      for (const name of ['credits', 'received', 'balance']) {
        const declaration = original.split('\n').find(line => line.startsWith(`  derive Invoice.${name}:`));
        assert.ok(declaration);
        assert.ok(probe.includes(declaration.split(' label=')[0]!),
          `original ${name} balance dependency is retained`);
      }
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
        uiUrl: import.meta.resolve('@canlang/ui') });
      assert.ok((artifact.modules[0]?.js ?? '').includes('sendWhen:'), 'original balance Rule is emitted');

      for (const mode of [
        'current-hidden', 'revision-is-not-in-authored-guard', 'initial-credit',
        'initial-succeeded-attempt', 'initial-external-payment', 'failed-attempt',
        'credit-after-schedule', 'attempt-after-schedule', 'payment-after-schedule',
        'recipient-after-schedule', 'void-after-schedule', 'missing-work-due',
        'credit-at-commit',
      ] as const) {
        const clock = createFrozenClock(now);
        const identities = createMemoryIdentityStore({ clock });
        const team = await identities.createTeam({ timezone: 'UTC' });
        const viewer = await identities.createUser({ email: `viewer-${mode}@overdue.test`,
          password_hash: 'unused', email_verified: true });
        await identities.createMembership({ team_id: team.team_id, user_id: viewer.user_id,
          is_owner: false, roles: [] });
        const token = `invoice-overdue-${mode}`;
        await identities.createSession({ user_id: viewer.user_id,
          token_sha256: await sha256HexText(token), last_team_id: team.team_id,
          expires_at: new Date(now + 3600000).toISOString() });
        const viewerIdentity = await resolveIdentity(identities, { session_token: token }, { clock });
        const scope = { app: 'CanInvoice', owner: team.team_id, ownerPackage: 'invoice' };
        const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app,
          stateStoreId: 'invoice-overdue-state', fileStoreId: 'invoice-overdue-files',
          receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
        const { store, probe: storageProbe } = createTestMemoryStorage(authority,
          [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({ artifact, asm, store, authority, scope,
          now: () => now, verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
        const customerId = asId('customer-1'), invoiceId = asId('invoice-1');
        const seed = [
          { kind: 'insert' as const, model: model('customer.Customer'), row: {
            ...makeRow({ id: customerId, data: { name: 'Customer' } }), parent: null } },
          { kind: 'insert' as const, model: model('invoice.Invoice'), row: {
            ...makeRow({ id: invoiceId, data: { recipient_email: 'customer@example.test',
              description: 'Desk rental', currency: 'EUR', state: 'issued', total: amount('10000'),
              hidden: true } }), parent: { model: model('customer.Customer'), id: customerId } } },
        ];
        await store.commit(makeBatch(await store.readRevision(), { writes: seed }));
        const addChild = async (kind: 'Credit' | 'Attempt' | 'ExternalPayment', id: string,
          data: Record<string, unknown>) => store.commit(makeBatch(await store.readRevision(), { writes: [{
            kind: 'insert', model: model(`invoice.${kind}`), row: {
              ...makeRow({ id: asId(id), data }),
              parent: { model: model('invoice.Invoice'), id: invoiceId },
            },
          }] }));
        const credit = () => addChild('Credit', 'credit-1', { amount: amount('10000') });
        const attempt = (status: 'succeeded' | 'failed') => addChild('Attempt', 'attempt-1', {
          kind: 'collection', status, amount: amount('10000'),
        });
        const payment = () => addChild('ExternalPayment', 'payment-1', { amount: amount('10000') });
        if (mode === 'initial-credit') await credit();
        if (mode === 'initial-succeeded-attempt') await attempt('succeeded');
        if (mode === 'initial-external-payment') await payment();
        if (mode === 'failed-attempt') await attempt('failed');
        if (mode === 'current-hidden') {
          const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
          const visible = await invoker.invokeRead({ operation: 'invoice.Invoice.read', inputs: {} }, viewerIdentity);
          assert.ok('result' in visible, JSON.stringify(visible));
          assert.equal((visible.result as { records: unknown[] }).records.length, 0,
            'private due can decide a row the viewer cannot read');
        }
        const due = { key: invoiceId, scope, occurrenceId: 'overdue-1',
          event: 'invoice.Overdue', at: now - 1 };
        const payload = { invoice: { id: invoiceId, version: '1' },
          revision: mode === 'revision-is-not-in-authored-guard' ? '2' : '1' };
        const stageContext = { actor: `schedule:${due.event}`, now, operation: 'invoice.overdue',
          load: (name: Parameters<typeof store.load>[0], id: Parameters<typeof store.load>[1]) => store.load(name, id),
          query: (spec: Parameters<typeof store.query>[0]) => store.query(spec) };
        if (mode !== 'missing-work-due') {
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
            model: model('work.schedule'), row: row.row, field: 'payload', scope,
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
          if (mode === 'current-hidden') {
            const forged = await invokeDueScheduleCanonical({ asm, artifact, app: scope.app,
              handler: 'invoice.overdue', due: { ...due, occurrenceId: 'not-the-issued-head' },
              store, identities, now: () => now, deploymentBase });
            assert.equal(forged.status, 'refused', 'unissued occurrence has no owner authority');
            assert.equal(storageProbe.outboxAll().length, 0);
          }
        }
        if (mode === 'credit-after-schedule') await credit();
        if (mode === 'attempt-after-schedule') await attempt('succeeded');
        if (mode === 'payment-after-schedule') await payment();
        if (mode === 'recipient-after-schedule' || mode === 'void-after-schedule') {
          const row = await store.load(model('invoice.Invoice'), invoiceId); assert.ok(row);
          await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update',
            model: model('invoice.Invoice'), id: row.id, expectedVersion: row.version,
            row: { ...row, version: asVersion(row.version + 1), updated: now,
              data: { ...row.data, ...(mode === 'recipient-after-schedule'
                ? { recipient_email: 'new@example.test' } : { state: 'void' }) } },
          }] }));
        }
        let injected = false;
        if (mode === 'credit-at-commit') {
          const commit = store.commit.bind(store);
          store.commit = async batch => {
            if (!injected && batch.outbox.length > 0) {
              injected = true;
              await commit(makeBatch(await store.readRevision(), { writes: [{
                kind: 'insert', model: model('invoice.Credit'), row: {
                  ...makeRow({ id: asId('race-credit'), data: { amount: amount('10000') } }),
                  parent: { model: model('invoice.Invoice'), id: invoiceId },
                },
              }] }));
            }
            return commit(batch);
          };
        }
        const result = await invokeDueScheduleCanonical({ asm, artifact, app: scope.app,
          handler: 'invoice.overdue', due, store, identities, now: () => now, deploymentBase });
        const intents = storageProbe.outboxAll();
        if (mode === 'credit-at-commit') {
          assert.equal(injected, true, 'credit race runs at the Mail commit');
          assert.equal(intents.length, 0, 'stale positive balance cannot queue Mail');
          continue;
        }
        const expected = [
          'current-hidden', 'revision-is-not-in-authored-guard', 'failed-attempt',
          'recipient-after-schedule',
        ].includes(mode) ? 1 : 0;
        assert.equal(intents.length, expected, `${mode}: ${JSON.stringify(result)}`);
        assert.equal(result.status, mode === 'missing-work-due' ? 'refused'
          : expected ? 'completed' : 'failed', `${mode}: due status`);
        if (expected) {
          const request = intents[0]?.arguments['arguments'] as Record<string, unknown>;
          assert.equal(request['to'], mode === 'recipient-after-schedule'
            ? 'new@example.test' : 'customer@example.test', mode);
          assert.equal(request['subject'], 'Invoice overdue', mode);
          assert.equal(request['body'],
            `Desk rental ${deploymentBase}/finance/invoice/${invoiceId}`, mode);
          if (mode === 'current-hidden') {
            await payment();
            const fenceFor = await bindNativeEmailDispatchGuards({ asm, artifact, store,
              identities, scope, revalidateAuthority: async () => true });
            const producers = await loadDispatchSystemProducers();
            const intent = intents[0]!;
            const claim = createWorkDispatchClaimCommand((candidateId, target) =>
              candidateId === intent.intentId && target === intent.target);
            const commands = assembleDispatchCommands({ l3Commands: producers.l3Commands,
              workCommands: WORK_SYSTEM_COMMANDS.map(command => command.name === claim.name ? claim : command),
              stageCommands: WORK_DISPATCH_STAGE_COMMANDS });
            const joined = withDispatchJoinPort(store, await createWorkerDispatchJoinPort(store));
            let providerCalls = 0;
            const frozen = structuredClone(intent.arguments);
            const dispatch = await driveDispatchIntentWithPreclaim({
              store: joined, intent, actor: 'dispatch:invoice.overdue',
              operation: 'test.invoice.overdue.dispatch', nowMs: () => now + 1000,
              nextClaimId: () => 'claim-overdue', maxClaimAgeMs: 60000,
              claimOperationId: uuidv7(now + 1000, 1), recordOperationId: uuidv7(now + 1000, 2),
              evaluateGuard: () => { throw new Error('native guard was bypassed'); },
              readStateSnapshot: () => null,
              callProvider: async () => { providerCalls++; return { kind: 'delivered', result: null }; },
              classifyFailure, fence: fenceFor(intent),
            }, (guard, allocator) => {
              const guarded = createWorkDispatchClaimCommand((candidateId, target) =>
                candidateId === intent.intentId && target === intent.target, guard, allocator);
              return producers.createSystemRegistry(commands.map(command =>
                command.name === claim.name ? guarded : command));
            });
            assert.equal(dispatch.status, 'recorded', JSON.stringify(dispatch));
            assert.equal(providerCalls, 1,
              'a later payment cannot rewrite the original source-stage true verdict');
            assert.deepEqual((await store.outboxGet(intent.intentId))?.intent.arguments, frozen,
              'queued Mail arguments stay frozen after payment');
          }
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
