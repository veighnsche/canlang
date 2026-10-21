/** A flow-narrowed nullable field stays tied to its declared SEND source row. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
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
import { asId, asModel, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work/kernel/file-reference-inventory';
import { buildInvoker } from '../worker/assembly.js';
import { installNativeFileInventory } from './file-inventory.js';
import { assembleModules } from './modules.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const source = join(root, 'packages/cloudflare/test/fixtures/native-send-nullable-narrowing.can');
const compiler = join(root, 'compiler/target/debug/can');
const catalog = join(root, 'packages/cloudflare/dist/native-catalog.json');

it('refuses an event-sourced guard without orphaning a separate valid SEND owner', () => {
  const mixed = join(root, 'packages/cloudflare/test/fixtures/native-send-partial-refusal.can');
  const result = spawnSync(compiler,
    ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, mixed],
    { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 10);
  const report = JSON.parse(result.stdout) as { complete: boolean; diagnostics: {
    code: string; message: string; primary: { start: number } }[] };
  assert.equal(report.complete, true);
  const refused = report.diagnostics.filter(diagnostic => diagnostic.code === 'E6008');
  assert.ok(refused.some(diagnostic => diagnostic.message.includes('send dispatch guard')));
  const invalidOwner = readFileSync(mixed, 'utf8').indexOf('scenario ping on=Ping');
  assert.ok(invalidOwner >= 0);
  assert.ok(refused.every(diagnostic => diagnostic.primary.start >= invalidOwner),
    `only the event owner may be refused: ${JSON.stringify(refused)}`);
});

function operationId(now: number): string {
  const time = now.toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-8${random.slice(4, 7)}-${random.slice(7, 19)}`;
}

it('commits a guarded SEND only for a present, current nullable recipient',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-nullable-send-'));
    try {
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
        uiUrl: import.meta.resolve('@canlang/ui') });
      const operation = artifact.operations?.find(item => item.name === 'NullableSendProbe.retry');
      assert.ok(operation?.result?.disclosure, 'the original nullable read has a native receipt');
      const declared = (artifact.modules[0]?.js ?? '').includes('sendWhen:');
      assert.equal(declared, true, 'the original guarded SEND has a sealed Rule');
      for (const { state, recipient, status, outbox } of [
        { state: 'cancelled', recipient: 'recipient@example.test', status: 'committed', outbox: 1 },
        { state: 'cancelled', recipient: null, status: 'rule_failed', outbox: 0 },
        { state: 'active', recipient: 'recipient@example.test', status: 'rule_failed', outbox: 0 },
      ]) {
        const now = Date.now(), clock = createFrozenClock(now), identities = createMemoryIdentityStore({ clock });
        const team = await identities.createTeam({ timezone: 'UTC' });
        const user = await identities.createUser({ email: 'owner@nullable-send.test', password_hash: 'unused', email_verified: true });
        await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: [] });
        const token = randomBytes(24).toString('hex');
        await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
          last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
        const identity = await resolveIdentity(identities, { session_token: token }, { clock });
        const authority: FileRetirementAuthority = { app: 'NullableSendProbe', stateOwner: 'NullableSendProbe',
          stateStoreId: 'nullable-send-state', fileStoreId: 'nullable-send-files',
          receiver: { app: 'NullableSendProbe', owner: team.team_id, team: team.team_id } };
        const { store, probe } = createTestMemoryStorage(authority,
          [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({ artifact, asm, store, authority,
          scope: { app: 'NullableSendProbe', owner: team.team_id, ownerPackage: 'NullableSendProbe' },
          now: () => now, verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
        const row = { ...makeRow({ id: asId('request-1'), data: { recipient, state, attempt: null } }), parent: null };
        await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert',
          model: asModel('NullableSendProbe.Request'), row }] }));
        const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
        const outcome = await invoker.invokeMutation({ operation: 'NullableSendProbe.retry', operation_id: operationId(now),
          inputs: { request: { id: row.id, version: String(row.version) } } }, identity);
        assert.equal('result' in outcome ? outcome.result.status : outcome.error.code, status,
          `${state}/${recipient}: ${JSON.stringify(outcome)}`);
        assert.equal(probe.outboxAll().length, outbox, `${state}/${recipient}: outbox`);
        const actual = await store.load(asModel('NullableSendProbe.Request'), row.id);
        assert.ok(actual);
        assert.equal(actual.data.recipient, recipient);
        assert.equal(actual.data.attempt === null, outbox === 0);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
