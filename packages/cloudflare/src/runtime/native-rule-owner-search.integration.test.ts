/** Compiled mutation decisions observe bounded owner rows without widening reads. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { promisify } from 'node:util';
import type { CompileArtifact, ModelName, StoredRow } from '@canlang/contracts';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { asId, asModel, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';
import { buildInvoker } from '../worker/assembly.js';
import { assembleModules } from './modules.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const fixture = (name: string) => join(root, 'packages/cloudflare/test/fixtures', name);
const compiler = join(root, 'compiler/target/debug/can');
const catalog = join(root, 'packages/cloudflare/dist/native-catalog.json');
const model = (app: string, name: string) => asModel(`${app}.${name}`);
function operationId(now: number): string {
  const time = now.toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-8${random.slice(4, 7)}-${random.slice(7, 19)}`;
}
async function installed(name: string, directory: string) {
  const source = fixture(name);
  const { stdout } = await promisify(execFile)(compiler,
    ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
    { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
  const artifact = JSON.parse(stdout) as CompileArtifact;
  const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
    stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
  return { artifact, asm };
}
async function member(mode: string) {
  const now = Date.now(), identities = createMemoryIdentityStore({ clock: createFrozenClock(now) });
  const team = await identities.createTeam({ timezone: 'UTC' });
  const user = await identities.createUser({ email: `${mode}@owner-search.test`, password_hash: 'unused', email_verified: true });
  await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
  const token = `owner-search-${mode}-${randomBytes(8).toString('hex')}`;
  await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
    last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
  return { now, identities, user, identity: await resolveIdentity(identities, { session_token: token },
    { clock: createFrozenClock(now) }) };
}

it('refuses an unproved helper-contained child scan during compilation', () => {
  const result = spawnSync(compiler, ['compile', '--format=json', '--native-scenario-receipts',
    '--catalog', catalog, fixture('rule-owner-helper-child-unproved.can')],
  { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 10);
  const report = JSON.parse(result.stdout) as { diagnostics: { code: string; message: string }[] };
  assert.ok(report.diagnostics.some(diagnostic => diagnostic.code === 'E6008' &&
    diagnostic.message.includes('helper collection in Require lacks exact owner-domain correspondence')));
});

it('refuses a first-selected field copied into an update without a value proof', () => {
  const result = spawnSync(compiler, ['compile', '--format=json', '--native-scenario-receipts',
    '--catalog', catalog, fixture('rule-owner-first-copy-unproved.can')],
  { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 10);
  const report = JSON.parse(result.stdout) as { diagnostics: { code: string; message: string }[] };
  assert.ok(report.diagnostics.some(diagnostic => diagnostic.code === 'E6008' &&
    diagnostic.message.includes('selected first row has an unproved decision, write target or value sink')));
});

it('runs source Require helpers and direct child scans over hidden owner rows',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-owner-require-'));
    try {
      for (const source of ['rule-owner-require.can', 'rule-owner-no-membership.can',
        'rule-owner-unreadable-anchor.can', 'rule-owner-direct-child.can']) {
        const { artifact, asm } = await installed(source, directory);
        for (const mode of ['none', 'visible-block', 'hidden-block']) {
          const { now, identities, identity } = await member(`${source}-${mode}`);
          const store = createMemoryStorage();
          const anchor = { ...makeRow({ id: asId('anchor-1'), data: { label: 'Probe anchor' } }), parent: null };
          const writes: Array<{ kind: 'insert'; model: ModelName; row: StoredRow }> =
            [{ kind: 'insert', model: model('AuthorityProbe', 'Anchor'), row: anchor }];
          if (mode !== 'none') {
            const contained = source === 'rule-owner-direct-child.can';
            writes.push({ kind: 'insert', model: model('AuthorityProbe', 'Secret'),
              row: { ...makeRow({ id: asId('secret-1'), data: {
                ...(contained ? {} : { anchor: { id: anchor.id } }), blocked: true,
                hidden: mode === 'hidden-block' } }),
                parent: contained ? { model: model('AuthorityProbe', 'Anchor'), id: anchor.id } : null } });
          }
          await store.commit(makeBatch(await store.readRevision(), { writes }));
          const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
          const visible = await invoker.invokeRead({ operation: 'AuthorityProbe.Secret.read', inputs: {} }, identity);
          assert.ok('result' in visible);
          assert.equal((visible.result as { records: unknown[] }).records.length, mode === 'visible-block' ? 1 : 0);
          const outcome = await invoker.invokeMutation({ operation: 'AuthorityProbe.enter', operation_id: operationId(now),
            inputs: { anchor: { id: anchor.id, version: String(anchor.version) } } }, identity);
          assert.equal('result' in outcome ? outcome.result.status : outcome.error.code,
            mode === 'none' ? 'committed' : 'rule_failed', `${source}: ${mode}`);
          assert.equal((await store.load(model('AuthorityProbe', 'Anchor'), anchor.id))?.data.label,
            mode === 'none' ? 'entered' : 'Probe anchor');
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('uses owner rows for both checked any and decision-only first while ordinary reads remain filtered',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-owner-any-first-'));
    try {
      const { artifact, asm } = await installed('rule-owner-any-first.can', directory);
      for (const mode of ['visible-inactive', 'visible-active', 'hidden-active-and-visible-inactive',
        'hidden-inactive-only']) {
        const { now, identities, identity, user } = await member(mode);
        const store = createMemoryStorage();
        const p = { ...makeRow({ id: asId('p-1'), data: { v: '1', active: true } }), parent: null };
        const i = { ...makeRow({ id: asId('i-1'), data: { role: 'administrator' } }),
          parent: { model: model('AnyFirstProbe', 'P'), id: p.id } };
        const child = (id: string, active: boolean, hidden: boolean) => ({ ...makeRow({ id: asId(id),
          data: { account: { id: user.user_id }, role: 'administrator', active, hidden } }),
          parent: { model: model('AnyFirstProbe', 'P'), id: p.id } });
        const writes = [
          { kind: 'insert' as const, model: model('AnyFirstProbe', 'P'), row: p },
          { kind: 'insert' as const, model: model('AnyFirstProbe', 'I'), row: i },
        ];
        if (mode !== 'hidden-inactive-only') writes.push({ kind: 'insert', model: model('AnyFirstProbe', 'C'),
          row: child('c-visible', mode === 'visible-active', false) });
        if (mode.startsWith('hidden-')) writes.push({ kind: 'insert', model: model('AnyFirstProbe', 'C'),
          row: child('c-hidden', mode !== 'hidden-inactive-only', true) });
        await store.commit(makeBatch(await store.readRevision(), { writes }));
        const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
        const visible = await invoker.invokeRead({ operation: 'AnyFirstProbe.C.read', inputs: {} }, identity);
        assert.ok('result' in visible);
        assert.equal((visible.result as { records: unknown[] }).records.length,
          mode === 'hidden-inactive-only' ? 0 : 1);
        const outcome = await invoker.invokeMutation({ operation: 'AnyFirstProbe.accept', operation_id: operationId(now),
          inputs: { invitation: { id: i.id, version: String(i.version) } } }, identity);
        const commits = mode === 'visible-inactive' || mode === 'hidden-inactive-only';
        assert.equal('result' in outcome ? outcome.result.status : outcome.error.code,
          commits ? 'committed' : 'rule_failed', mode);
        assert.equal((await store.query({ model: model('AnyFirstProbe', 'D'), authority: 'owner' })).length,
          commits ? 1 : 0);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('selects a hidden row once for a checked null-branch update target',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-owner-first-target-'));
    try {
      for (const source of ['rule-owner-first-target.can', 'rule-owner-first-target-no-read.can']) {
        const { artifact, asm } = await installed(source, directory);
        for (const mode of ['none', 'visible', 'hidden', 'hidden-and-visible']) {
          const { now, identities, identity } = await member(`first-target-${mode}`);
          const store = createMemoryStorage();
          const parent = { ...makeRow({ id: asId('parent-1'), data: { label: 'Parent' } }), parent: null };
          const writes: Array<{ kind: 'insert'; model: ModelName; row: StoredRow }> =
            [{ kind: 'insert', model: model('FirstTargetProbe', 'Parent'), row: parent }];
          if (mode !== 'none') writes.push({ kind: 'insert', model: model('FirstTargetProbe', 'Child'),
            row: { ...makeRow({ id: asId('child-1'), data: { role: 'keeper', v: '0', hidden: mode === 'hidden' } }),
              parent: { model: model('FirstTargetProbe', 'Parent'), id: parent.id } } });
          if (mode === 'hidden-and-visible') writes.push({ kind: 'insert', model: model('FirstTargetProbe', 'Child'),
            row: { ...makeRow({ id: asId('child-0'), data: { role: 'keeper', v: '0', hidden: true } }),
              parent: { model: model('FirstTargetProbe', 'Parent'), id: parent.id } } });
          await store.commit(makeBatch(await store.readRevision(), { writes }));
          const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
          if (source === 'rule-owner-first-target.can') {
            const visible = await invoker.invokeRead({ operation: 'FirstTargetProbe.Child.read', inputs: {} }, identity);
            assert.ok('result' in visible);
            assert.equal((visible.result as { records: unknown[] }).records.length,
              mode === 'visible' || mode === 'hidden-and-visible' ? 1 : 0);
          }
          const outcome = await invoker.invokeMutation({ operation: 'FirstTargetProbe.ensure',
            operation_id: operationId(now), inputs: { parent: { id: parent.id, version: String(parent.version) },
              role: 'keeper' } }, identity);
          assert.equal('result' in outcome ? outcome.result.status : outcome.error.code, 'committed', mode);
          const children = await store.query({ model: model('FirstTargetProbe', 'Child'), authority: 'owner' });
          assert.equal(children.length, mode === 'hidden-and-visible' ? 2 : 1, `${source}: ${mode}`);
          if (mode === 'hidden-and-visible') {
            assert.equal(children.find(child => child.id === 'child-0')?.data.v, '2');
            assert.equal(children.find(child => child.id === 'child-1')?.data.v, '0');
          } else assert.equal(children[0]?.data.v, mode === 'none' ? '1' : '2', `${source}: ${mode}`);
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('retries a first-target decision after a hidden row arrives at commit',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-owner-first-race-'));
    try {
      const { artifact, asm } = await installed('rule-owner-first-target.can', directory);
      const { now, identities, identity } = await member('first-target-race');
      const backing = createMemoryStorage();
      const parent = { ...makeRow({ id: asId('parent-1'), data: { label: 'Parent' } }), parent: null };
      await backing.commit(makeBatch(await backing.readRevision(), { writes: [
        { kind: 'insert', model: model('FirstTargetProbe', 'Parent'), row: parent },
      ] }));
      let injected = false;
      const store = { ...backing, commit: async (batch: Parameters<typeof backing.commit>[0]) => {
        if (!injected) {
          injected = true;
          const row = { ...makeRow({ id: asId('child-race'), data: { role: 'keeper', v: '0', hidden: true } }),
            parent: { model: model('FirstTargetProbe', 'Parent'), id: parent.id } };
          await backing.commit(makeBatch(await backing.readRevision(), { writes: [
            { kind: 'insert', model: model('FirstTargetProbe', 'Child'), row },
          ] }));
        }
        return backing.commit(batch);
      } };
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const outcome = await invoker.invokeMutation({ operation: 'FirstTargetProbe.ensure',
        operation_id: operationId(now), inputs: { parent: { id: parent.id, version: String(parent.version) },
          role: 'keeper' } }, identity);
      assert.equal(injected, true);
      assert.equal('result' in outcome ? outcome.result.status : outcome.error.code, 'committed');
      const children = await backing.query({ model: model('FirstTargetProbe', 'Child'), authority: 'owner' });
      assert.equal(children.length, 1);
      assert.equal(children[0]?.id, 'child-race');
      assert.equal(children[0]?.data.v, '2');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
