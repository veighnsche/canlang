/** The original movement refund selects owner evidence before one Billing refund and Credit create. */
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
import { asId, asModel, asVersion, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work/kernel/file-reference-inventory';
import { buildInvoker } from '../worker/assembly.js';
import { installNativeFileInventory } from './file-inventory.js';
import { assembleModules } from './modules.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const source = join(root, 'packages/cloudflare/test/fixtures/rent-refund-movement-credit-owner-probe.can');
const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
const model = (name: string) => asModel(name);
const amount = (minor: string) => ({ minor, currency: 'EUR' });
const now = Date.parse('2099-01-01T12:00:00.000Z');

function operationId(): string {
  const time = now.toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-8${random.slice(4, 7)}-${random.slice(7, 19)}`;
}

it('refuses altered refund selection, balance, SEND and Credit source', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-rent-refund-mutants-'));
  try {
    const original = await readFile(source, 'utf8');
    const variants = [
      ['adjustment-query', 'row.source==charge_source and row.state==paid',
        'row.source==charge_source and row.state==pending'],
      ['credit-census', 'credit.state!=failed select credit.amount',
        'credit.state==failed select credit.amount'],
      ['refund-request', 'send Billing.refund {source=charge_source,amount,reason}',
        'send Billing.refund {source=charge_source,amount,reason="Changed"}'],
      ['baseline', 'baseline=credit_baseline(charge_source,refunded)',
        'baseline=refunded'],
      ['global-baseline', 'credit.charge_source==charge_source and credit.state!=failed',
        'credit.charge_source==charge_source and credit.state==failed'],
    ] as const;
    for (const [name, before, after] of variants) {
      assert.ok(original.includes(before), name);
      const changed = original.replace(before, after);
      const path = join(directory, `${name}.can`);
      await writeFile(path, changed);
      const result = spawnSync(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, path],
        { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      assert.equal(result.status, 10, `${name}: ${result.stderr || result.stdout}`);
      const report = JSON.parse(result.stdout) as { diagnostics: { code: string; message: string;
        primary: { file: number; start: number; end: number } }[] };
      const first = changed.indexOf('first(booking.Adjustment');
      const owner = changed.indexOf('scenario refund_movement_credit') + 'scenario '.length;
      assert.ok(report.diagnostics.some(diagnostic => diagnostic.code === 'E6008' &&
        diagnostic.primary.file === 0 &&
        (diagnostic.primary.start === first || diagnostic.primary.start === owner)),
      `${name}: exact original refund owner must lose its receipt`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('refunds movement credit from complete current booking or adjustment evidence',
  { timeout: 180000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-rent-refund-'));
    try {
      const probe = await readFile(source, 'utf8');
      const original = await readFile(join(root, 'draft/apps/CanRent/CanRent.can'), 'utf8');
      const start = original.indexOf('  scenario refund_movement_credit(');
      const end = original.indexOf('  scenario movement_credit_result ', start);
      assert.ok(start >= 0 && end > start);
      assert.ok(probe.includes(original.slice(start, end).trimEnd()),
        'the original two-branch refund body is retained');
      const baseline = original.split('\n').find(line => line.includes('derive credit_baseline('));
      assert.ok(baseline && probe.includes(baseline.trim()), 'original global baseline derive is retained');
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
        uiUrl: import.meta.resolve('@canlang/ui') });

      for (const mode of [
        'booking-source', 'adjustment-hidden', 'failed-credit-ignored',
        'movement-exhausted', 'booking-insufficient', 'adjustment-insufficient',
        'missing-adjustment', 'wrong-worker', 'inactive-worker', 'not-billing',
        'credit-at-commit', 'adjustment-at-commit',
      ] as const) {
        const identities = createMemoryIdentityStore({ clock: createFrozenClock(now) });
        const team = await identities.createTeam({ timezone: 'UTC' });
        const actor = await identities.createUser({ email: `actor-${mode}@rent-refund.test`,
          password_hash: 'unused', email_verified: true });
        await identities.createMembership({ team_id: team.team_id, user_id: actor.user_id,
          is_owner: false, roles: mode === 'not-billing' ? [] : [{
            role: 'rent_reservations.billing', granted_at: new Date(now).toISOString(),
            granted_by: actor.user_id,
          }] });
        const token = `rent-refund-${mode}-${randomBytes(8).toString('hex')}`;
        await identities.createSession({ user_id: actor.user_id,
          token_sha256: await sha256HexText(token), last_team_id: team.team_id,
          expires_at: new Date(now + 3600000).toISOString() });
        const identity = await resolveIdentity(identities, { session_token: token },
          { clock: createFrozenClock(now) });
        const scope = { app: 'CanRent', owner: team.team_id, ownerPackage: 'rent_reservations' };
        const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app,
          stateStoreId: 'rent-refund-state', fileStoreId: 'rent-refund-files',
          receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
        const { store, probe: storageProbe } = createTestMemoryStorage(authority,
          [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({ artifact, asm, store, authority, scope,
          now: () => now, verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });

        const location = { ...makeRow({ id: asId('site'), data: { active: true } }), parent: null };
        const otherLocation = { ...makeRow({ id: asId('other-site'), data: { active: true } }), parent: null };
        const resource = { ...makeRow({ id: asId('resource'), data: {
          location: { id: location.id } } }), parent: null };
        const booking = { ...makeRow({ id: asId('booking'), data: {
          source: 'booking-charge', collected: amount(mode === 'booking-insufficient' ? '2500' : '10000'),
          refunded: amount('2000') } }), parent: { model: model('rent_reservations.Resource'), id: resource.id } };
        const movement = { ...makeRow({ id: asId('movement'), data: {
          state: 'adopted', credit_due: amount('5000') } }),
          parent: { model: model('rent_reservations.Booking'), id: booking.id } };
        const foreignBooking = { ...makeRow({ id: asId('foreign-booking'), data: {
          source: 'foreign-charge', collected: amount('10000'), refunded: amount('0') } }),
          parent: { model: model('rent_reservations.Resource'), id: resource.id } };
        const foreignMovement = { ...makeRow({ id: asId('foreign-movement'), data: {
          state: 'adopted', credit_due: amount('5000') } }),
          parent: { model: model('rent_reservations.Booking'), id: foreignBooking.id } };
        const adjustment = { ...makeRow({ id: asId('adjustment'), data: {
          source: 'adjustment-charge', state: 'paid', collected: amount(mode === 'adjustment-insufficient' ? '1200' : '8000'),
          refunded: amount('1000'), hidden: true } }),
          parent: { model: model('rent_reservations.Booking'), id: booking.id } };
        const employee = { ...makeRow({ id: asId('employee'), data: {
          user: { id: actor.user_id }, home: { id: mode === 'wrong-worker' ? otherLocation.id : location.id },
          locations: [], operator_wide: false, active: mode !== 'inactive-worker', hidden: true } }), parent: null };
        const sameBooking = mode !== 'adjustment-hidden' && mode !== 'adjustment-insufficient' &&
          mode !== 'missing-adjustment' && mode !== 'adjustment-at-commit';
        const chargeSource = sameBooking ? 'booking-charge' : 'adjustment-charge';
        const existingCredit = { ...makeRow({ id: asId('existing-credit'), data: {
          charge_source: chargeSource, amount: amount('4500'), baseline: amount('0'),
          delivery: 'prior-credit', state: mode === 'failed-credit-ignored' ? 'failed' : 'pending',
          reason: 'Prior credit', hidden: true } }),
          parent: { model: model('rent_reservations.Movement'), id: movement.id } };
        const foreignCredit = { ...makeRow({ id: asId('foreign-credit'), data: {
          charge_source: chargeSource, amount: amount('500'),
          baseline: amount(sameBooking ? '2500' : '1200'), delivery: 'foreign-credit',
          state: 'paid', reason: 'Other movement credit', hidden: true } }),
          parent: { model: model('rent_reservations.Movement'), id: foreignMovement.id } };
        const writes: Array<{ kind: 'insert'; model: ModelName; row: StoredRow }> = [
          { kind: 'insert', model: model('rent_catalog.Location'), row: location },
          { kind: 'insert', model: model('rent_catalog.Location'), row: otherLocation },
          { kind: 'insert', model: model('rent_reservations.Resource'), row: resource },
          { kind: 'insert', model: model('rent_reservations.Booking'), row: booking },
          { kind: 'insert', model: model('rent_reservations.Movement'), row: movement },
          { kind: 'insert', model: model('rent_reservations.Booking'), row: foreignBooking },
          { kind: 'insert', model: model('rent_reservations.Movement'), row: foreignMovement },
          { kind: 'insert', model: model('employee.Employee'), row: employee },
          { kind: 'insert', model: model('rent_reservations.MovementCredit'), row: foreignCredit },
        ];
        if (mode === 'movement-exhausted' || mode === 'failed-credit-ignored') writes.push({
          kind: 'insert', model: model('rent_reservations.MovementCredit'), row: existingCredit });
        if (mode !== 'missing-adjustment') writes.push({
          kind: 'insert', model: model('rent_reservations.Adjustment'), row: adjustment });
        await store.commit(makeBatch(await store.readRevision(), { writes }));

        let injected = false;
        if (mode === 'credit-at-commit' || mode === 'adjustment-at-commit') {
          const commit = store.commit.bind(store);
          Object.defineProperty(store, 'commit', { value: async (batch: Parameters<typeof store.commit>[0]) => {
            if (!injected && batch.outbox.length > 0) {
              injected = true;
              if (mode === 'credit-at-commit') {
                await commit(makeBatch(await store.readRevision(), { writes: [{
                  kind: 'insert', model: model('rent_reservations.MovementCredit'),
                  row: { ...existingCredit, id: asId('race-credit') },
                }] }));
              } else {
                const current = await store.load(model('rent_reservations.Adjustment'), adjustment.id);
                assert.ok(current);
                await commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update',
                  model: model('rent_reservations.Adjustment'), id: current.id,
                  expectedVersion: current.version,
                  row: { ...current, version: asVersion(current.version + 1), updated: now,
                    data: { ...current.data, state: 'pending' } },
                }] }));
              }
            }
            return commit(batch);
          } });
        }
        const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
        const id = operationId();
        const outcome = await invoker.invokeMutation({ operation: 'rent_reservations.refund_movement_credit',
          operation_id: id, inputs: { movement: { id: movement.id, version: String(movement.version) },
            charge_source: chargeSource, amount: amount('1000'), reason: 'Customer refund' } }, identity);
        const success = ['booking-source', 'adjustment-hidden', 'failed-credit-ignored'].includes(mode);
        const code = 'result' in outcome ? outcome.result.status : outcome.error.code;
        if (success) assert.equal(code, 'committed', `${mode}: ${JSON.stringify(outcome)}`);
        else assert.ok(['forbidden', 'rule_failed', 'conflict'].includes(code),
          `${mode}: ${JSON.stringify(outcome)}`);
        const credits = await store.query({ model: model('rent_reservations.MovementCredit'),
          parent: { model: model('rent_reservations.Movement'), id: movement.id }, authority: 'owner' });
        const created = credits.filter(row => row.data['delivery'] !== 'prior-credit');
        assert.equal(created.length, success ? 1 : 0, `${mode}: exact one own Credit`);
        const intents = storageProbe.outboxAll();
        assert.equal(intents.length, success ? 1 : 0, `${mode}: exact one refund intent`);
        if (success) {
          const intent = intents[0]!;
          assert.equal(intent.operation, 'rent_reservations.refund_movement_credit');
          assert.equal(intent.operationId, id);
          assert.equal(intent.target, 'invoice.BillingV1.refund');
          assert.equal(intent.arguments['binding'], 'rent_reservations.Billing');
          assert.deepEqual(intent.arguments['arguments'], {
            source: chargeSource, amount: amount('1000'), reason: 'Customer refund',
          });
          assert.deepEqual(created[0]?.data, {
            charge_source: chargeSource, amount: amount('1000'),
            baseline: amount(mode === 'adjustment-hidden' ? '1700' :
              mode === 'failed-credit-ignored' ? '3000' : '3000'),
            delivery: intent.intentId, state: 'pending', reason: 'Customer refund', hidden: false,
          });
        }
        if (mode.endsWith('-at-commit')) assert.equal(injected, true, `${mode}: race hook reached`);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
