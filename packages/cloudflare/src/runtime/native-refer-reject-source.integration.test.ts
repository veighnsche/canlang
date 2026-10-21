/** Rejecting one qualified referral reverses only its own credit and retains payment evidence. */
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
const source = join(root, 'packages/cloudflare/test/fixtures/refer-reject-source-owner-probe.can');
const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
const model = (name: string) => asModel(name);
const now = Date.parse('2099-01-01T12:00:00.000Z');
const reward = { minor: '10000', currency: 'EUR' };
const reversedReward = { minor: '-10000', currency: 'EUR' };

function operationId(): string {
  const time = now.toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-8${random.slice(4, 7)}-${random.slice(7, 19)}`;
}

it('rejects the original referral source once while preserving unrelated credits and settlements',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-refer-reject-'));
    try {
      const probe = await readFile(source, 'utf8');
      const original = await readFile(join(root, 'draft/apps/CanRefer/CanRefer.can'), 'utf8');
      const start = original.indexOf('  scenario reject_source(');
      const end = original.indexOf('   examples seed=', start);
      assert.ok(start >= 0 && end > start);
      for (const line of original.slice(start, end).trimEnd().split('\n')) {
        assert.ok(probe.includes(line), `reject_source retains original source: ${line.slice(0, 90)}`);
      }
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
      const modes = [
        'reverse-credit', 'no-credit', 'existing-reversal', 'other-source-credit',
        'foreign-advocate-credit', 'role-missing', 'wrong-location', 'inactive-worker',
        'empty-reason', 'stale-evidence', 'program-locations-changed-at-commit',
        'program-reward-currency-changed-at-commit', 'concurrent-reversal-at-commit',
      ] as const;
      for (const mode of modes) {
        const identities = createMemoryIdentityStore({ clock: createFrozenClock(now) });
        const team = await identities.createTeam({ timezone: 'UTC' });
        const manager = await identities.createUser({ email: `manager-${mode}@refer-reject.test`,
          password_hash: 'unused', email_verified: true });
        const advocateUser = await identities.createUser({ email: `advocate-${mode}@refer-reject.test`,
          password_hash: 'unused', email_verified: true });
        await identities.createMembership({ team_id: team.team_id, user_id: manager.user_id,
          is_owner: false, roles: mode === 'role-missing' ? [] : [{
            role: 'refer.program_manager', granted_at: new Date(now).toISOString(),
            granted_by: advocateUser.user_id }] });
        await identities.createMembership({ team_id: team.team_id, user_id: advocateUser.user_id,
          is_owner: false, roles: [] });
        const token = `refer-reject-${mode}-${randomBytes(8).toString('hex')}`;
        await identities.createSession({ user_id: manager.user_id,
          token_sha256: await sha256HexText(token), last_team_id: team.team_id,
          expires_at: new Date(now + 3600000).toISOString() });
        const identity = await resolveIdentity(identities, { session_token: token },
          { clock: createFrozenClock(now) });
        const backing = createMemoryStorage();
        const site = { ...makeRow({ id: asId('site'), data: { name: 'Main', address: '1 Example Road',
          timezone: 'UTC', currency: 'EUR', hours: '09:00–18:00', arrival: 'Reception', active: true } }), parent: null };
        const otherSite = { ...makeRow({ id: asId('other-site'), data: { ...site.data, name: 'Elsewhere' } }), parent: null };
        const managerWorker = { ...makeRow({ id: asId('manager-worker'), data: {
          user: { id: manager.user_id }, name: 'Manager',
          home: { id: mode === 'wrong-location' ? otherSite.id : site.id },
          locations: [], operator_wide: false, active: mode !== 'inactive-worker',
          start: '2090-01-01', end: null, manager: null, role: 'manager', skills: [],
          private_notes: 'private', document: null } }), parent: null };
        const program = { ...makeRow({ id: asId('program'), data: { name: 'Advocates',
          locations: [{ id: site.id }], products: ['meeting'], reward,
          destination: 'https://example.test/', window: '2592000000', active: true } }), parent: null };
        const advocate = { ...makeRow({ id: asId('advocate'), data: {
          account: { id: advocateUser.user_id }, email: 'advocate@example.test', code: 'share' } }),
          parent: { model: model('refer.Program'), id: program.id } };
        const foreignAdvocate = { ...makeRow({ id: asId('foreign-advocate'), data: {
          account: { id: manager.user_id }, email: 'foreign@example.test', code: 'elsewhere' } }),
          parent: { model: model('refer.Program'), id: program.id } };
        const evidence = { ...makeRow({ id: asId('evidence'), data: {
          advocate: { id: advocate.id }, source: 'sale', reversed: false, reason: null,
          value: { source: 'sale', revision: '1', customer: 'customer-1',
            account: { id: advocateUser.user_id }, location: site.id, product: 'meeting',
            amount: { minor: '100000', currency: 'EUR' },
            purchased_at: '2098-12-01T00:00:00.000Z', occurred: '2098-12-02T00:00:00.000Z',
            milestone: 'completed', attribution: 'share',
            exclusive_program: `refer.Program:${program.id}`,
            attributed_at: '2098-11-30T00:00:00.000Z', attribution_window: '2592000000',
            first_customer: true, history_known: true } } }), parent: null };
        const sourceCredit = { ...makeRow({ id: asId('credit'), data: {
          source: mode === 'other-source-credit' ? 'different-sale' : 'sale',
          customer: 'customer-1', amount: reward, reversal: null,
          qualification: 'Verified first paid customer' } }),
          parent: { model: model('refer.Advocate'), id: mode === 'foreign-advocate-credit'
            ? foreignAdvocate.id : advocate.id } };
        const existingReversal = { ...makeRow({ id: asId('existing-reversal'), data: {
          source: 'sale:reversal', customer: 'customer-1', amount: reversedReward,
          reversal: { id: sourceCredit.id }, qualification: 'Prior rejection' } }),
          parent: { model: model('refer.Advocate'), id: advocate.id } };
        const settlement = { ...makeRow({ id: asId('settlement'), data: {
          payment_source: 'operator-bank', source: 'settled', amount: reward,
          reference: 'external-1', paid: '2098-12-03', method: 'Bank transfer',
          evidence: 'Statement', author: { id: manager.user_id } } }),
          parent: { model: model('refer.Advocate'), id: advocate.id } };
        const writes: Array<{ kind: 'insert'; model: ModelName; row: StoredRow }> = [
          { kind: 'insert', model: model('rent_catalog.Location'), row: site },
          { kind: 'insert', model: model('rent_catalog.Location'), row: otherSite },
          { kind: 'insert', model: model('employee.Employee'), row: managerWorker },
          { kind: 'insert', model: model('refer.Program'), row: program },
          { kind: 'insert', model: model('refer.Advocate'), row: advocate },
          { kind: 'insert', model: model('refer.SourceEvidence'), row: evidence },
          { kind: 'insert', model: model('refer.Settlement'), row: settlement },
        ];
        if (mode === 'foreign-advocate-credit') writes.push({ kind: 'insert',
          model: model('refer.Advocate'), row: foreignAdvocate });
        if (mode !== 'no-credit') writes.push({ kind: 'insert', model: model('refer.Credit'), row: sourceCredit });
        if (mode === 'existing-reversal') writes.push({ kind: 'insert',
          model: model('refer.Credit'), row: existingReversal });
        await backing.commit(makeBatch(await backing.readRevision(), { writes }));
        let injected = false;
        const originalCommit = backing.commit.bind(backing);
        Object.defineProperty(backing, 'commit', { value:
          async (batch: Parameters<typeof backing.commit>[0]) => {
            if (mode.endsWith('-at-commit') && !injected) {
              injected = true;
              if (mode === 'concurrent-reversal-at-commit') {
                await originalCommit(makeBatch(await backing.readRevision(), { writes: [{
                  kind: 'insert', model: model('refer.Credit'), row: existingReversal }] }));
              } else {
                const current = await backing.load(model('refer.Program'), program.id); assert.ok(current);
                await originalCommit(makeBatch(await backing.readRevision(), { writes: [{
                  kind: 'update', model: model('refer.Program'), id: current.id,
                  expectedVersion: current.version,
                  row: { ...current, version: asVersion(current.version + 1), updated: now,
                    data: { ...current.data,
                      ...(mode === 'program-reward-currency-changed-at-commit'
                        ? { reward: { minor: '10000', currency: 'USD' } }
                        : { locations: [{ id: otherSite.id }] }) } },
                }] }));
              }
            }
            return originalCommit(batch);
          } });
        const invoker = buildInvoker(artifact, asm, backing, { memberships: identities, now: () => now });
        const reason = mode === 'empty-reason' ? '' : 'Duplicate attribution';
        const outcome = await invoker.invokeMutation({ operation: 'refer.reject_source', operation_id: operationId(),
          inputs: { evidence: { id: evidence.id, version: String(mode === 'stale-evidence'
            ? evidence.version + 1 : evidence.version) }, reason } }, identity)
          .catch((error: unknown) => { throw new Error(`${mode}: ${error instanceof Error
            ? error.message : String(error)}`, { cause: error }); });
        const success = ['reverse-credit', 'no-credit', 'existing-reversal', 'other-source-credit',
          'foreign-advocate-credit', 'concurrent-reversal-at-commit'].includes(mode);
        const code = 'result' in outcome ? outcome.result.status : outcome.error.code;
        if (success) assert.equal(code, 'committed', `${mode}: ${JSON.stringify(outcome)}`);
        else assert.ok(['forbidden', 'rule_failed', 'conflict'].includes(code),
          `${mode}: ${JSON.stringify(outcome)}`);
        const actual = await backing.load(model('refer.SourceEvidence'), evidence.id);
        assert.ok(actual);
        assert.equal(actual.data.reversed, success, mode);
        assert.equal(actual.data.reason, success ? reason : null, mode);
        const credits = await backing.query({ model: model('refer.Credit'), authority: 'owner' });
        const own = credits.filter(row => row.parent?.id === advocate.id);
        const reversals = own.filter(row => row.data.reversal !== null);
        const newReversal = mode === 'reverse-credit';
        assert.equal(reversals.length, newReversal || mode === 'existing-reversal' ||
          mode === 'concurrent-reversal-at-commit' ? 1 : 0, mode);
        if (newReversal) {
          const reversal = reversals[0]!;
          assert.equal(reversal.data.source, 'sale:reversal', mode);
          assert.equal(reversal.data.customer, sourceCredit.data.customer, mode);
          assert.deepEqual(reversal.data.amount, reversedReward, mode);
          assert.equal((reversal.data.amount as { currency: string }).currency,
            (program.data.reward as { currency: string }).currency, mode);
          assert.deepEqual(reversal.data.reversal, { id: sourceCredit.id }, mode);
          assert.equal(reversal.data.qualification, reason, mode);
        }
        if (mode !== 'no-credit') {
          const originalCredit = await backing.load(model('refer.Credit'), sourceCredit.id);
          assert.deepEqual(originalCredit?.data, sourceCredit.data, mode);
        }
        const settlements = await backing.query({ model: model('refer.Settlement'), authority: 'owner' });
        assert.deepEqual(settlements.map(row => row.data), [settlement.data], `${mode}: payment evidence`);
        assert.deepEqual(await backing.outboxPending(), [], `${mode}: no outbound effect`);
        if (mode.endsWith('-at-commit')) assert.equal(injected, true, `${mode}: race hook reached`);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
