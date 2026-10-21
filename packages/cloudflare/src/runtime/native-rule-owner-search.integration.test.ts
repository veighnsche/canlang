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
import { asId, asModel, asVersion, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';
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
async function member(mode: string, roles: readonly string[] = []) {
  const now = Date.now(), identities = createMemoryIdentityStore({ clock: createFrozenClock(now) });
  const team = await identities.createTeam({ timezone: 'UTC' });
  const user = await identities.createUser({ email: `${mode}@owner-search.test`, password_hash: 'unused', email_verified: true });
  await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false,
    roles: roles.map(role => ({ role, granted_at: new Date(now).toISOString(), granted_by: user.user_id })) });
  const token = `owner-search-${mode}-${randomBytes(8).toString('hex')}`;
  await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
    last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
  return { now, identities, user, identity: await resolveIdentity(identities, { session_token: token },
    { clock: createFrozenClock(now) }) };
}

it('refuses a helper-contained child scan through an unproved copy', () => {
  const result = spawnSync(compiler, ['compile', '--format=json', '--native-scenario-receipts',
    '--catalog', catalog, fixture('rule-owner-helper-child-copy-unproved.can')],
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

it('refuses a selected first row reused by a later effect without value proof', () => {
  const result = spawnSync(compiler, ['compile', '--format=json', '--native-scenario-receipts',
    '--catalog', catalog, fixture('rule-owner-first-target-suffix-unproved.can')],
  { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 10);
  const report = JSON.parse(result.stdout) as { diagnostics: { code: string; message: string }[] };
  assert.ok(report.diagnostics.some(diagnostic => diagnostic.code === 'E6008' &&
    diagnostic.message.includes('selected first row has an unproved decision, write target or value sink')));
});

it('refuses an order-only first target without an admitted parent domain', () => {
  const result = spawnSync(compiler, ['compile', '--format=json', '--native-scenario-receipts',
    '--catalog', catalog, fixture('rule-owner-first-target-order-only-unscoped.can')],
  { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 10);
  const report = JSON.parse(result.stdout) as { diagnostics: { code: string; message: string }[] };
  assert.ok(report.diagnostics.some(diagnostic => diagnostic.code === 'E6008' &&
    diagnostic.message.includes('selected first row has an unproved decision, write target or value sink')));
});

it('refuses an any guard over a different parent from the selected first target', () => {
  const result = spawnSync(compiler, ['compile', '--format=json', '--native-scenario-receipts',
    '--catalog', catalog, fixture('rule-owner-any-first-target-other-parent.can')],
  { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 10);
  const report = JSON.parse(result.stdout) as { diagnostics: { code: string; message: string }[] };
  assert.ok(report.diagnostics.some(diagnostic => diagnostic.code === 'E6008' &&
    diagnostic.message.includes('selected first row has an unproved decision, write target or value sink')));
});

it('refuses an all-helper owner query through an unproved parent copy', () => {
  const result = spawnSync(compiler, ['compile', '--format=json', '--native-scenario-receipts',
    '--catalog', catalog, fixture('rule-owner-all-helper-any-first-copied-parent.can')],
  { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 10);
  const report = JSON.parse(result.stdout) as { diagnostics: { code: string; message: string }[] };
  assert.ok(report.diagnostics.some(diagnostic => diagnostic.code === 'E6008' &&
    diagnostic.message.includes('owner-domain correspondence')));
});

it('refuses an emitted parent reference through an unproved copy', () => {
  const result = spawnSync(compiler, ['compile', '--format=json', '--native-scenario-receipts',
    '--catalog', catalog, fixture('rule-owner-all-helper-any-first-copied-emit.can')],
  { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 10);
  const report = JSON.parse(result.stdout) as { diagnostics: { code: string; message: string }[] };
  assert.ok(report.diagnostics.some(diagnostic => diagnostic.code === 'E6008' &&
    diagnostic.message.includes('original native query correspondence')));
});

it('runs source Require helpers and direct child scans over hidden owner rows',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-owner-require-'));
    try {
      for (const source of ['rule-owner-require.can', 'rule-owner-no-membership.can',
        'rule-owner-unreadable-anchor.can', 'rule-owner-direct-child.can',
        'rule-owner-helper-child.can', 'rule-owner-helper-child-no-membership.can']) {
        const { artifact, asm } = await installed(source, directory);
        for (const mode of ['none', 'visible-block', 'hidden-block']) {
          const { now, identities, identity } = await member(`${source}-${mode}`);
          const store = createMemoryStorage();
          const anchor = { ...makeRow({ id: asId('anchor-1'), data: { label: 'Probe anchor' } }), parent: null };
          const writes: Array<{ kind: 'insert'; model: ModelName; row: StoredRow }> =
            [{ kind: 'insert', model: model('AuthorityProbe', 'Anchor'), row: anchor }];
          if (mode !== 'none') {
            const contained = source === 'rule-owner-direct-child.can'
              || source.startsWith('rule-owner-helper-child');
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

it('passes an original required Model field to a leading helper owner search',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-owner-leading-helper-field-'));
    try {
      const { artifact, asm } = await installed('rule-owner-leading-helper-field.can', directory);
      for (const mode of ['none', 'visible-active', 'hidden-active', 'hidden-inactive', 'hidden-other']) {
        const { now, identities, identity, user } = await member(`leading-helper-${mode}`);
        const store = createMemoryStorage();
        const location = { ...makeRow({ id: asId('location-1'), data: { label: 'Home' } }), parent: null };
        const other = { ...makeRow({ id: asId('location-2'), data: { label: 'Elsewhere' } }), parent: null };
        const ticket = { ...makeRow({ id: asId('ticket-1'),
          data: { location: { id: location.id }, done: false } }), parent: null };
        const writes: Array<{ kind: 'insert'; model: ModelName; row: StoredRow }> = [
          { kind: 'insert', model: model('LeadingHelperFieldProbe', 'Location'), row: location },
          { kind: 'insert', model: model('LeadingHelperFieldProbe', 'Location'), row: other },
          { kind: 'insert', model: model('LeadingHelperFieldProbe', 'Ticket'), row: ticket },
        ];
        if (mode !== 'none') writes.push({ kind: 'insert', model: model('LeadingHelperFieldProbe', 'Employee'),
          row: { ...makeRow({ id: asId('worker-1'), data: { user: { id: user.user_id },
            home: { id: mode === 'hidden-other' ? other.id : location.id }, locations: [],
            operator_wide: false, active: mode !== 'hidden-inactive', hidden: mode.startsWith('hidden-') } }),
            parent: null } });
        await store.commit(makeBatch(await store.readRevision(), { writes }));
        const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
        if (mode === 'visible-active') {
          const unsupportedFile = await invoker.invokeMutation({ operation: 'LeadingHelperFieldProbe.handoff',
            operation_id: operationId(now), inputs: { ticket: { id: ticket.id,
              version: String(ticket.version) }, photo: { id: 'unproven-photo' } } }, identity);
          assert.ok('error' in unsupportedFile, JSON.stringify(unsupportedFile));
          assert.equal(unsupportedFile.error.code, 'validation');
          assert.equal((await store.load(model('LeadingHelperFieldProbe', 'Ticket'), ticket.id))?.data.done, false);
        }
        const outcome = await invoker.invokeMutation({ operation: 'LeadingHelperFieldProbe.handoff',
          operation_id: operationId(now), inputs: { ticket: { id: ticket.id,
            version: String(ticket.version) } } }, identity);
        const commits = mode === 'visible-active' || mode === 'hidden-active';
        assert.equal('result' in outcome ? outcome.result.status : outcome.error.code,
          commits ? 'committed' : 'rule_failed', `${mode}: ${JSON.stringify(outcome)}`);
        assert.equal((await store.load(model('LeadingHelperFieldProbe', 'Ticket'), ticket.id))?.data.done,
          commits, mode);
        assert.equal((await store.query({ model: model('LeadingHelperFieldProbe', 'Handoff'), authority: 'owner' })).length,
          commits ? 1 : 0, mode);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('fences a hidden helper owner row through a nullable-File child handoff',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-owner-helper-cross-handoff-'));
    try {
      const { artifact, asm } = await installed('rule-owner-leading-helper-cross-handoff.can', directory);
      for (const mode of ['none', 'visible-active', 'hidden-active', 'hidden-inactive', 'hidden-other']) {
        const { now, identities, identity, user } = await member(`helper-cross-${mode}`);
        const store = createMemoryStorage();
        const location = { ...makeRow({ id: asId('location-1'), data: { label: 'Home' } }), parent: null };
        const other = { ...makeRow({ id: asId('location-2'), data: { label: 'Elsewhere' } }), parent: null };
        const asset = { ...makeRow({ id: asId('asset-1'), data: { location: { id: location.id }, active: true } }), parent: null };
        const ticket = { ...makeRow({ id: asId('ticket-1'),
          data: { location: { id: location.id }, subject: 'Router offline', repair: null } }), parent: null };
        const writes: Array<{ kind: 'insert'; model: ModelName; row: StoredRow }> = [
          { kind: 'insert', model: model('LeadingHelperCrossHandoff', 'Location'), row: location },
          { kind: 'insert', model: model('LeadingHelperCrossHandoff', 'Location'), row: other },
          { kind: 'insert', model: model('LeadingHelperCrossHandoff', 'Asset'), row: asset },
          { kind: 'insert', model: model('LeadingHelperCrossHandoff', 'Ticket'), row: ticket },
        ];
        if (mode !== 'none') writes.push({ kind: 'insert', model: model('LeadingHelperCrossHandoff', 'Employee'),
          row: { ...makeRow({ id: asId('employee-1'), data: { user: { id: user.user_id },
            home: { id: mode === 'hidden-other' ? other.id : location.id },
            active: mode !== 'hidden-inactive', hidden: mode.startsWith('hidden-') } }), parent: null } });
        await store.commit(makeBatch(await store.readRevision(), { writes }));
        const noFileAccess = async (): Promise<never> => { throw new Error('Null photo attempted File access.'); };
        const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now,
          files: { validate: noFileAccess, retain: noFileAccess, observe: noFileAccess, revalidate: noFileAccess } });
        const visible = await invoker.invokeRead({ operation: 'LeadingHelperCrossHandoff.Employee.read', inputs: {} }, identity);
        assert.ok('result' in visible, JSON.stringify(visible));
        assert.equal((visible.result as { records: unknown[] }).records.length,
          mode === 'visible-active' ? 1 : 0, mode);
        const outcome = await invoker.invokeMutation({ operation: 'LeadingHelperCrossHandoff.handoff',
          operation_id: operationId(now), inputs: {
            ticket: { id: ticket.id, version: String(ticket.version) },
            asset: { id: asset.id, version: String(asset.version) },
          } }, identity);
        const commits = mode === 'visible-active' || mode === 'hidden-active';
        assert.equal('result' in outcome ? outcome.result.status : outcome.error.code,
          commits ? 'committed' : 'rule_failed', `${mode}: ${JSON.stringify(outcome)}`);
        const repairs = await store.query({ model: model('LeadingHelperCrossHandoff', 'Repair'), authority: 'owner' });
        assert.equal(repairs.length, commits ? 1 : 0, mode);
        if (commits) {
          assert.equal(repairs[0]!.parent?.id, asset.id);
          assert.equal(((await store.load(model('LeadingHelperCrossHandoff', 'Ticket'), ticket.id))?.data.repair as { id: string }).id,
            repairs[0]!.id);
        } else assert.equal((await store.load(model('LeadingHelperCrossHandoff', 'Ticket'), ticket.id))?.data.repair, null);
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

it('pairs a leading owner any guard with a checked first update target',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-owner-any-first-target-'));
    try {
      const { artifact, asm } = await installed('rule-owner-any-first-target.can', directory);
      for (const mode of ['none', 'visible-inactive', 'visible-active', 'hidden-inactive',
        'hidden-active', 'hidden-active-and-visible-inactive']) {
        const { now, identities, identity, user } = await member(`any-first-target-${mode}`);
        const store = createMemoryStorage();
        const parent = { ...makeRow({ id: asId('parent-1'), data: { v: '1' } }), parent: null };
        const invitation = { ...makeRow({ id: asId('invitation-1'), data: { role: 'administrator', done: false } }),
          parent: { model: model('AnyFirstTargetProbe', 'P'), id: parent.id } };
        const child = (id: string, active: boolean, hidden: boolean) => ({ ...makeRow({ id: asId(id),
          data: { account: { id: user.user_id }, role: 'administrator', active, hidden } }),
          parent: { model: model('AnyFirstTargetProbe', 'P'), id: parent.id } });
        const writes: Array<{ kind: 'insert'; model: ModelName; row: StoredRow }> = [
          { kind: 'insert', model: model('AnyFirstTargetProbe', 'P'), row: parent },
          { kind: 'insert', model: model('AnyFirstTargetProbe', 'I'), row: invitation },
        ];
        if (mode.startsWith('visible-')) writes.push({ kind: 'insert',
          model: model('AnyFirstTargetProbe', 'C'),
          row: child('visible-1', mode === 'visible-active', false) });
        if (mode.startsWith('hidden-')) writes.push({ kind: 'insert',
          model: model('AnyFirstTargetProbe', 'C'), row: child('hidden-0', mode !== 'hidden-inactive', true) });
        if (mode === 'hidden-active-and-visible-inactive') writes.push({ kind: 'insert',
          model: model('AnyFirstTargetProbe', 'C'), row: child('visible-1', false, false) });
        await store.commit(makeBatch(await store.readRevision(), { writes }));
        const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
        const visible = await invoker.invokeRead({ operation: 'AnyFirstTargetProbe.C.read', inputs: {} }, identity);
        assert.ok('result' in visible);
        assert.equal((visible.result as { records: unknown[] }).records.length,
          mode.startsWith('visible-') || mode === 'hidden-active-and-visible-inactive' ? 1 : 0);
        const outcome = await invoker.invokeMutation({ operation: 'AnyFirstTargetProbe.accept',
          operation_id: operationId(now), inputs: { invitation: { id: invitation.id,
            version: String(invitation.version) } } }, identity);
        const commits = mode === 'none' || mode === 'visible-inactive' || mode === 'hidden-inactive';
        assert.equal('result' in outcome ? outcome.result.status : outcome.error.code,
          commits ? 'committed' : 'rule_failed', `${mode}: ${JSON.stringify(outcome)}`);
        assert.equal((await store.load(model('AnyFirstTargetProbe', 'I'), invitation.id))?.data.done, commits);
        const children = await store.query({ model: model('AnyFirstTargetProbe', 'C'), authority: 'owner' });
        assert.equal(children.length, mode === 'none' ? 1 : mode === 'hidden-active-and-visible-inactive' ? 2 : 1, mode);
        if (commits) assert.equal(children[0]?.data.active, true, mode);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('selects a hidden row once for a checked null-branch update target',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-owner-first-target-'));
    try {
      for (const source of ['rule-owner-first-target.can', 'rule-owner-first-target-no-read.can',
        'rule-owner-first-target-suffix.can', 'rule-owner-first-target-order-only.can']) {
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
          if (source !== 'rule-owner-first-target-no-read.can') {
            const visible = await invoker.invokeRead({ operation: 'FirstTargetProbe.Child.read', inputs: {} }, identity);
            assert.ok('result' in visible);
            assert.equal((visible.result as { records: unknown[] }).records.length,
              mode === 'visible' || mode === 'hidden-and-visible' ? 1 : 0);
          }
          const outcome = await invoker.invokeMutation({ operation: 'FirstTargetProbe.ensure',
            operation_id: operationId(now), inputs: { parent: { id: parent.id, version: String(parent.version) },
              role: 'keeper' } }, identity);
          assert.equal('result' in outcome ? outcome.result.status : outcome.error.code, 'committed',
            `${source}: ${mode} ${'error' in outcome ? JSON.stringify(outcome.error) : ''}`);
          assert.equal((await store.load(model('FirstTargetProbe', 'Parent'), parent.id))?.data.label,
            source === 'rule-owner-first-target-suffix.can' || source === 'rule-owner-first-target-order-only.can'
              ? 'done' : 'Parent');
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

it('observes every original location in an all-helper guard before an owner any/first decision',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-owner-all-helper-'));
    try {
      for (const binding of ['plain', 'unrelated-mail'] as const) {
        const { artifact, asm } = await installed(binding === 'plain'
          ? 'rule-owner-all-helper-any-first.can' : 'rule-owner-all-helper-any-first-bound.can', directory);
        const app = binding === 'plain' ? 'AllHelperAnyFirstProbe' : 'bound_customer';
        for (const mode of binding === 'plain'
          ? ['hidden-admin', 'missing-location', 'hidden-other-parent-admin',
            'hidden-active-booker', 'hidden-inactive-booker'] : ['hidden-admin']) {
          const { now, identities, identity, user } = await member(`all-helper-${mode}`);
          const store = createMemoryStorage();
          const first = { ...makeRow({ id: asId('location-1'), data: { name: 'First' } }), parent: null };
          const second = { ...makeRow({ id: asId('location-2'), data: { name: 'Second' } }), parent: null };
          const locations = [{ id: first.id }, { id: second.id }];
          const parent = { ...makeRow({ id: asId('parent-1'), data: { v: '1', locations } }), parent: null };
          const other = { ...makeRow({ id: asId('parent-2'), data: { v: '2', locations } }), parent: null };
          const invitation = { ...makeRow({ id: asId('invitation-1'), data: {
            role: 'booker', invited_by: { id: user.user_id }, locations, done: false } }),
            parent: { model: model(app, 'P'), id: parent.id } };
          const child = (id: string, role: string, active: boolean, allowed: typeof locations,
            owner = parent) => ({
            ...makeRow({ id: asId(id), data: { account: { id: user.user_id }, role,
              locations: allowed, active, hidden: true } }),
            parent: { model: model(app, 'P'), id: owner.id },
          });
          const writes: Array<{ kind: 'insert'; model: ModelName; row: StoredRow }> = [
            { kind: 'insert', model: model(app, 'Location'), row: first },
            { kind: 'insert', model: model(app, 'Location'), row: second },
            { kind: 'insert', model: model(app, 'P'), row: parent },
            { kind: 'insert', model: model(app, 'I'), row: invitation },
            { kind: 'insert', model: model(app, 'C'), row: child('admin-1', 'administrator', true,
              mode === 'missing-location' ? locations.slice(0, 1) : locations,
              mode === 'hidden-other-parent-admin' ? other : parent) },
          ];
          if (mode === 'hidden-other-parent-admin') writes.splice(2, 0,
            { kind: 'insert', model: model(app, 'P'), row: other });
          if (mode.endsWith('booker')) writes.push({ kind: 'insert', model: model(app, 'C'),
            row: child('booker-1', 'booker', mode === 'hidden-active-booker',
              mode === 'hidden-inactive-booker' ? [] : locations) });
          await store.commit(makeBatch(await store.readRevision(), { writes }));
          const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
          const visible = await invoker.invokeRead({ operation: `${app}.C.read`, inputs: {} }, identity);
          assert.ok('result' in visible, JSON.stringify(visible));
          assert.equal((visible.result as { records: unknown[] }).records.length, 0, mode);
          const outcome = await invoker.invokeMutation({ operation: `${app}.accept`,
            operation_id: operationId(now), inputs: { invitation: { id: invitation.id,
              version: String(invitation.version) } } }, identity);
          const commits = mode === 'hidden-admin' || mode === 'hidden-inactive-booker';
          assert.equal('result' in outcome ? outcome.result.status : outcome.error.code,
            commits ? 'committed' : 'rule_failed', `${mode}: ${JSON.stringify(outcome)}`);
          assert.equal((await store.load(model(app, 'I'), invitation.id))?.data.done, commits, mode);
          const roles = await store.query({ model: model(app, 'C'), authority: 'owner' });
          const bookers = roles.filter(role => role.data.role === 'booker');
          assert.equal(bookers.length, mode.endsWith('booker') ? 1 : commits ? 1 : 0, mode);
          if (commits) {
            assert.equal(bookers[0]?.data.active, true, mode);
            assert.deepEqual(bookers[0]?.data.locations, locations, mode);
            if (mode === 'hidden-inactive-booker') assert.equal(bookers[0]?.id, 'booker-1', mode);
          }
          const occurrences = await store.query({ model: asModel('work.occurrence'), authority: 'owner' });
          assert.equal(occurrences.length, commits ? 1 : 0, mode);
          if (commits) {
            const result = occurrences[0]?.data.result as Record<string, unknown>;
            assert.equal(result.kind, 'declared-event-source', mode);
            assert.equal(result.event, `${app}.AccessChanged`, mode);
            assert.deepEqual(result.payload, { customer: { id: parent.id },
              account: { id: user.user_id }, revision: String(invitation.version + 1) }, mode);
          }
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('retries every hidden all-helper observation when its owner row changes before commit',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-owner-all-helper-race-'));
    try {
      const { artifact, asm } = await installed('rule-owner-all-helper-any-first.can', directory);
      const app = 'AllHelperAnyFirstProbe';
      const { now, identities, identity, user } = await member('all-helper-race');
      const backing = createMemoryStorage();
      const first = { ...makeRow({ id: asId('location-1'), data: { name: 'First' } }), parent: null };
      const second = { ...makeRow({ id: asId('location-2'), data: { name: 'Second' } }), parent: null };
      const locations = [{ id: first.id }, { id: second.id }];
      const parent = { ...makeRow({ id: asId('parent-1'), data: { v: '1', locations } }), parent: null };
      const invitation = { ...makeRow({ id: asId('invitation-1'), data: {
        role: 'booker', invited_by: { id: user.user_id }, locations, done: false } }),
        parent: { model: model(app, 'P'), id: parent.id } };
      const admin = { ...makeRow({ id: asId('admin-1'), data: {
        account: { id: user.user_id }, role: 'administrator', locations, active: true, hidden: true } }),
        parent: { model: model(app, 'P'), id: parent.id } };
      await backing.commit(makeBatch(await backing.readRevision(), { writes: [
        { kind: 'insert', model: model(app, 'Location'), row: first },
        { kind: 'insert', model: model(app, 'Location'), row: second },
        { kind: 'insert', model: model(app, 'P'), row: parent },
        { kind: 'insert', model: model(app, 'I'), row: invitation },
        { kind: 'insert', model: model(app, 'C'), row: admin },
      ] }));
      let injected = false;
      const store = { ...backing, commit: async (batch: Parameters<typeof backing.commit>[0]) => {
        if (!injected) {
          injected = true;
          const current = await backing.load(model(app, 'C'), admin.id);
          assert.ok(current);
          await backing.commit(makeBatch(await backing.readRevision(), { writes: [{
            kind: 'update', model: model(app, 'C'), id: current.id,
            expectedVersion: current.version,
            row: { ...current, version: asVersion(current.version + 1),
              data: { ...current.data, locations: locations.slice(0, 1) } },
          }] }));
        }
        return backing.commit(batch);
      } };
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const outcome = await invoker.invokeMutation({ operation: `${app}.accept`,
        operation_id: operationId(now), inputs: { invitation: { id: invitation.id,
          version: String(invitation.version) } } }, identity);
      assert.equal(injected, true);
      assert.equal('result' in outcome ? outcome.result.status : outcome.error.code, 'rule_failed',
        JSON.stringify(outcome));
      assert.equal((await backing.load(model(app, 'I'), invitation.id))?.data.done, false);
      const roles = await backing.query({ model: model(app, 'C'), authority: 'owner' });
      assert.equal(roles.filter(role => role.data.role === 'booker').length, 0);
      assert.deepEqual(roles.find(role => role.id === admin.id)?.data.locations, locations.slice(0, 1));
      assert.equal((await backing.query({ model: asModel('work.occurrence'), authority: 'owner' })).length, 0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('removes a seat only through its current company role or staffed term location',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-member-remove-owner-'));
    try {
      const { artifact, asm } = await installed('member-remove-owner-probe.can', directory);
      for (const mode of ['hidden-admin', 'revoked-admin', 'other-customer-admin',
        'manager-hidden-worker', 'manager-other-location', 'manager-inactive-worker',
        'admin-revoked-at-commit', 'manager-term-location-changed-at-commit'] as const) {
        const manager = mode.startsWith('manager-');
        const { now, identities, identity, user } = await member(`member-remove-${mode}`,
          manager ? ['member_terms.member_manager'] : []);
        const backing = createMemoryStorage();
        const location = { ...makeRow({ id: asId('location-1'), data: { name: 'First' } }), parent: null };
        const elsewhere = { ...makeRow({ id: asId('location-2'), data: { name: 'Elsewhere' } }), parent: null };
        const customer = { ...makeRow({ id: asId('customer-1'), data: { name: 'Current company' } }), parent: null };
        const other = { ...makeRow({ id: asId('customer-2'), data: { name: 'Other company' } }), parent: null };
        const membership = { ...makeRow({ id: asId('membership-1'), data: { access_revision: '7' } }),
          parent: { model: asModel('customer.Customer'), id: customer.id } };
        const term = { ...makeRow({ id: asId('term-1'), data: { locations: [{ id: location.id }] } }),
          parent: { model: asModel('member_terms.Membership'), id: membership.id } };
        const seat = { ...makeRow({ id: asId('seat-1'), data: { active: true, removed_reason: null } }),
          parent: { model: asModel('member_terms.Term'), id: term.id } };
        const grant = { ...makeRow({ id: asId('grant-1'), data: { account: { id: user.user_id },
          role: manager ? 'booker' : 'administrator', locations: [],
          active: mode !== 'revoked-admin', hidden: true } }),
          parent: { model: asModel('customer.Customer'),
            id: mode === 'other-customer-admin' ? other.id : customer.id } };
        const worker = { ...makeRow({ id: asId('worker-1'), data: { user: { id: user.user_id },
          home: { id: mode === 'manager-other-location' ? elsewhere.id : location.id },
          locations: [], operator_wide: false, active: mode !== 'manager-inactive-worker', hidden: true } }),
          parent: null };
        const writes: Array<{ kind: 'insert'; model: ModelName; row: StoredRow }> = [
          { kind: 'insert', model: asModel('rent_catalog.Location'), row: location },
          { kind: 'insert', model: asModel('rent_catalog.Location'), row: elsewhere },
          { kind: 'insert', model: asModel('customer.Customer'), row: customer },
          { kind: 'insert', model: asModel('customer.Customer'), row: other },
          { kind: 'insert', model: asModel('member_terms.Membership'), row: membership },
          { kind: 'insert', model: asModel('member_terms.Term'), row: term },
          { kind: 'insert', model: asModel('member_terms.Seat'), row: seat },
        ];
        writes.push({ kind: 'insert', model: asModel('employee.Employee'), row: worker });
        writes.push({ kind: 'insert', model: asModel('customer.CompanyRole'), row: grant });
        await backing.commit(makeBatch(await backing.readRevision(), { writes }));
        let injected = false;
        const store = mode === 'admin-revoked-at-commit' ||
          mode === 'manager-term-location-changed-at-commit'
          ? { ...backing, commit: async (batch: Parameters<typeof backing.commit>[0]) => {
            if (!injected) {
              injected = true;
              const changeTerm = mode === 'manager-term-location-changed-at-commit';
              const changedModel = asModel(changeTerm ? 'member_terms.Term' : 'customer.CompanyRole');
              const current = await backing.load(changedModel, changeTerm ? term.id : grant.id);
              assert.ok(current);
              await backing.commit(makeBatch(await backing.readRevision(), { writes: [{
                kind: 'update', model: changedModel, id: current.id,
                expectedVersion: current.version,
                row: { ...current, version: asVersion(current.version + 1), updated: now,
                  data: { ...current.data, ...(changeTerm
                    ? { locations: [{ id: elsewhere.id }] }
                    : { active: false }) } },
              }] }));
            }
            return backing.commit(batch);
          } }
          : backing;
        const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
        {
          const visible = await invoker.invokeRead({ operation: 'customer.CompanyRole.read', inputs: {} }, identity);
          assert.ok('result' in visible, JSON.stringify(visible));
          assert.equal((visible.result as { records: unknown[] }).records.length, 0, mode);
        }
        {
          const visible = await invoker.invokeRead({ operation: 'employee.Employee.read', inputs: {} }, identity);
          assert.ok('result' in visible, JSON.stringify(visible));
          assert.equal((visible.result as { records: unknown[] }).records.length, 0, mode);
        }
        const outcome = await invoker.invokeMutation({ operation: 'member_terms.remove',
          operation_id: operationId(now), inputs: { seat: { id: seat.id, version: String(seat.version) },
            reason: 'No longer assigned' } }, identity);
        const commits = mode === 'hidden-admin' || mode === 'manager-hidden-worker';
        assert.equal('result' in outcome ? outcome.result.status : outcome.error.code,
          commits ? 'committed' : 'rule_failed', `${mode}: ${JSON.stringify(outcome)}`);
        assert.equal((await backing.load(asModel('member_terms.Seat'), seat.id))?.data.active,
          !commits, mode);
        assert.equal((await backing.load(asModel('member_terms.Seat'), seat.id))?.data.removed_reason,
          commits ? 'No longer assigned' : null, mode);
        const events = await backing.query({ model: asModel('work.occurrence'), authority: 'owner' });
        assert.equal(events.length, commits ? 1 : 0, mode);
        if (commits) {
          const result = events[0]?.data.result as Record<string, unknown>;
          assert.equal(result.kind, 'declared-event-source', mode);
          assert.equal(result.event, 'member_terms.AccessChanged', mode);
          assert.deepEqual(result.payload, { membership: { id: membership.id }, revision: '8' }, mode);
        }
        if (mode === 'admin-revoked-at-commit' ||
            mode === 'manager-term-location-changed-at-commit') assert.equal(injected, true);
        if (mode === 'admin-revoked-at-commit') assert.equal(
          (await backing.load(asModel('customer.CompanyRole'), grant.id))?.data.active, false);
        if (mode === 'manager-term-location-changed-at-commit') assert.deepEqual(
          (await backing.load(asModel('member_terms.Term'), term.id))?.data.locations,
          [{ id: elsewhere.id }]);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('assigns a paid seat through current hidden customer and capacity facts',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-member-assign-owner-'));
    try {
      const { artifact, asm } = await installed('member-assign-owner-probe.can', directory);
      for (const mode of ['create-hidden', 'reactivate-hidden', 'existing-active-target',
        'capacity-hidden', 'wrong-account', 'wrong-customer', 'wrong-customer-contact',
        'wrong-customer-role', 'wrong-location', 'revoked-admin', 'unpaid', 'expired',
        'membership-revoked', 'admin-revoked-at-commit', 'contact-revoked-at-commit',
        'location-grant-revoked-at-commit', 'capacity-filled-at-commit'] as const) {
        const { now, identities, identity, user: actor } = await member(`member-assign-${mode}`);
        const target = await identities.createUser({ email: `target-${mode}@owner-search.test`,
          password_hash: 'unused', email_verified: true });
        const otherAccount = await identities.createUser({ email: `other-${mode}@owner-search.test`,
          password_hash: 'unused', email_verified: true });
        const backing = createMemoryStorage();
        const location = { ...makeRow({ id: asId('location-1'), data: { name: 'First' } }), parent: null };
        const elsewhere = { ...makeRow({ id: asId('location-2'), data: { name: 'Elsewhere' } }), parent: null };
        const customer = { ...makeRow({ id: asId('customer-1'), data: {
          name: 'Current company', kind: 'company', active: true } }), parent: null };
        const foreign = { ...makeRow({ id: asId('customer-2'), data: {
          name: 'Other company', kind: 'company', active: true } }), parent: null };
        const membership = { ...makeRow({ id: asId('membership-1'), data: {
          revoked: mode === 'membership-revoked', access_revision: '7' } }),
          parent: { model: asModel('customer.Customer'), id: customer.id } };
        const term = { ...makeRow({ id: asId('term-1'), data: {
          paid: mode !== 'unpaid', until: new Date(now + (mode === 'expired' ? -1000 : 86400000)).toISOString(),
          locations: [{ id: location.id }], seats: mode === 'capacity-hidden' ||
            mode === 'capacity-filled-at-commit' ? '1' : '2' } }),
          parent: { model: asModel('member_terms.Membership'), id: membership.id } };
        const grant = { ...makeRow({ id: asId('grant-admin'), data: {
          account: { id: actor.user_id }, role: 'administrator',
          locations: [{ id: mode === 'wrong-location' ? elsewhere.id : location.id }],
          active: mode !== 'revoked-admin', hidden: true } }),
          parent: { model: asModel('customer.Customer'), id: customer.id } };
        const contactParent = mode === 'wrong-customer' || mode === 'wrong-customer-contact'
          ? foreign : customer;
        const bookerParent = mode === 'wrong-customer' || mode === 'wrong-customer-role'
          ? foreign : customer;
        const contact = { ...makeRow({ id: asId('contact-target'), data: {
          account: { id: mode === 'wrong-account' ? otherAccount.user_id : target.user_id },
          verified: true, hidden: true } }),
          parent: { model: asModel('customer.Customer'), id: contactParent.id } };
        const booker = { ...makeRow({ id: asId('grant-booker'), data: {
          account: { id: target.user_id }, role: 'booker', locations: [], active: true,
          hidden: true } }),
          parent: { model: asModel('customer.Customer'), id: bookerParent.id } };
        const oldSeat = { ...makeRow({ id: asId('seat-existing'), data: {
          account: { id: mode === 'reactivate-hidden' || mode === 'existing-active-target'
            ? target.user_id : otherAccount.user_id },
          active: mode !== 'reactivate-hidden',
          removed_reason: mode === 'reactivate-hidden' ? 'Previously removed' : null,
          hidden: true } }),
          parent: { model: asModel('member_terms.Term'), id: term.id } };
        const writes: Array<{ kind: 'insert'; model: ModelName; row: StoredRow }> = [
          { kind: 'insert', model: asModel('rent_catalog.Location'), row: location },
          { kind: 'insert', model: asModel('rent_catalog.Location'), row: elsewhere },
          { kind: 'insert', model: asModel('customer.Customer'), row: customer },
          { kind: 'insert', model: asModel('customer.Customer'), row: foreign },
          { kind: 'insert', model: asModel('member_terms.Membership'), row: membership },
          { kind: 'insert', model: asModel('member_terms.Term'), row: term },
          { kind: 'insert', model: asModel('customer.CompanyRole'), row: grant },
          { kind: 'insert', model: asModel('customer.CompanyRole'), row: booker },
          { kind: 'insert', model: asModel('customer.Contact'), row: contact },
        ];
        if (mode === 'reactivate-hidden' || mode === 'existing-active-target' ||
            mode === 'capacity-hidden') writes.push({
          kind: 'insert', model: asModel('member_terms.Seat'), row: oldSeat });
        await backing.commit(makeBatch(await backing.readRevision(), { writes }));
        let injected = false;
        const race = mode.endsWith('-at-commit');
        const store = race ? { ...backing, commit: async (batch: Parameters<typeof backing.commit>[0]) => {
          if (!injected) {
            injected = true;
            if (mode === 'capacity-filled-at-commit') {
              await backing.commit(makeBatch(await backing.readRevision(), { writes: [{
                kind: 'insert', model: asModel('member_terms.Seat'), row: oldSeat,
              }] }));
            } else {
              const changeContact = mode === 'contact-revoked-at-commit';
              const changedModel = asModel(changeContact ? 'customer.Contact' : 'customer.CompanyRole');
              const current = await backing.load(changedModel, changeContact ? contact.id : grant.id);
              assert.ok(current);
              await backing.commit(makeBatch(await backing.readRevision(), { writes: [{
                kind: 'update', model: changedModel, id: current.id,
                expectedVersion: current.version,
                row: { ...current, version: asVersion(current.version + 1), updated: now,
                  data: { ...current.data, ...(changeContact ? { verified: false }
                    : mode === 'location-grant-revoked-at-commit' ? { locations: [] }
                    : { active: false }) } },
              }] }));
            }
          }
          return backing.commit(batch);
        } } : backing;
        const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
        for (const operation of ['customer.Contact.read', 'customer.CompanyRole.read'] as const) {
          const visible = await invoker.invokeRead({ operation, inputs: {} }, identity);
          assert.ok('result' in visible, `${mode}: ${JSON.stringify(visible)}`);
          assert.equal((visible.result as { records: unknown[] }).records.length, 0, mode);
        }
        if (mode === 'reactivate-hidden' || mode === 'existing-active-target' ||
            mode === 'capacity-hidden') {
          const visible = await invoker.invokeRead({ operation: 'member_terms.Seat.read', inputs: {} }, identity);
          assert.ok('result' in visible, `${mode}: ${JSON.stringify(visible)}`);
          assert.equal((visible.result as { records: unknown[] }).records.length, 0, mode);
        }
        const outcome = await invoker.invokeMutation({ operation: 'member_terms.assign',
          operation_id: operationId(now), inputs: { term: { id: term.id, version: String(term.version) },
            account: { id: target.user_id } } }, identity);
        const commits = mode === 'create-hidden' || mode === 'reactivate-hidden';
        assert.equal('result' in outcome ? outcome.result.status : outcome.error.code,
          commits ? 'committed' : 'rule_failed', `${mode}: ${JSON.stringify(outcome)}`);
        const seats = await backing.query({ model: asModel('member_terms.Seat'), authority: 'owner' });
        assert.equal(seats.length, mode === 'reactivate-hidden' || mode === 'existing-active-target' ||
          mode === 'capacity-hidden' || mode === 'capacity-filled-at-commit' ? 1 : commits ? 1 : 0, mode);
        const targetSeats = seats.filter(seat => (seat.data.account as { id: string }).id === target.user_id);
        assert.equal(targetSeats.length, commits || mode === 'existing-active-target' ? 1 : 0, mode);
        if (commits) {
          assert.equal(targetSeats[0]?.data.active, true, mode);
          assert.equal(targetSeats[0]?.data.removed_reason, null, mode);
          if (mode === 'reactivate-hidden') assert.equal(targetSeats[0]?.id, oldSeat.id);
          else assert.notEqual(targetSeats[0]?.id, oldSeat.id);
        }
        if (mode === 'existing-active-target') {
          assert.equal(targetSeats[0]?.id, oldSeat.id);
          assert.equal(targetSeats[0]?.version, oldSeat.version);
          assert.equal(targetSeats[0]?.data.active, true);
        }
        const events = await backing.query({ model: asModel('work.occurrence'), authority: 'owner' });
        assert.equal(events.length, commits ? 1 : 0, mode);
        if (commits) {
          const result = events[0]?.data.result as Record<string, unknown>;
          assert.equal(result.kind, 'declared-event-source', mode);
          assert.equal(result.event, 'member_terms.AccessChanged', mode);
          assert.deepEqual(result.payload, { membership: { id: membership.id }, revision: '8' }, mode);
        }
        if (race) assert.equal(injected, true, mode);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
