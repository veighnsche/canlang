/** Compiled mutation decisions observe bounded owner rows without widening reads. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { promisify } from 'node:util';
import type { CompileArtifact, ModelName, StoredRow } from '@canlang/contracts';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { createMemoryStorage, createTestMemoryStorage } from '@canlang/state/storage/memory';
import { asId, asModel, asVersion, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';
import { buildInvoker } from '../worker/assembly.js';
import { assembleModules } from './modules.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const fixture = (name: string) => join(root, 'packages/cloudflare/test/fixtures', name);
const compiler = process.env['CAN_COMPILER_BIN'] ?? join(root, 'compiler/target/debug/can');
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
    stdlibUrl: new URL('./stdlib.js',import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
  return { artifact, asm };
}
async function member(mode: string, roles: readonly string[] = [], emailVerified = true) {
  const now = Date.now(), identities = createMemoryIdentityStore({ clock: createFrozenClock(now) });
  const team = await identities.createTeam({ timezone: 'UTC' });
  const user = await identities.createUser({ email: `${mode}@owner-search.test`, password_hash: 'unused', email_verified: emailVerified });
  const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false,
    roles: roles.map(role => ({ role, granted_at: new Date(now).toISOString(), granted_by: user.user_id })) });
  const token = `owner-search-${mode}-${randomBytes(8).toString('hex')}`;
  await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
    last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
  return { now, identities, team, user, membership, identity: await resolveIdentity(identities, { session_token: token },
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

it('requests the original member term once from current hidden renewal, capture and authority rows',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-member-term-owner-'));
    try {
      const { artifact, asm } = await installed('member-term-owner-probe.can', directory);
      const modes = [
        'create-no-capture', 'create-explicit-null', 'replay-hidden', 'replay-mismatch',
        'cycle-zero', 'boundary-expired', 'plan-inactive', 'membership-revoked',
        'capture-advocate-hidden', 'capture-partner', 'capture-stale',
        'capture-wrong-customer', 'capture-wrong-account', 'capture-superseded-hidden',
        'capture-tied-hidden', 'capture-unverified-actor',
        'capture-program-inactive', 'capture-product-ineligible',
        'manager-hidden-worker', 'manager-inactive-worker', 'billing-hidden-role',
        'plan-locations-changed-at-commit', 'capture-window-changed-at-commit',
        'program-revoked-at-commit', 'partner-revoked-at-commit',
        'membership-revoked-at-commit', 'billing-role-revoked-at-commit',
        'manager-worker-revoked-at-commit', 'identity-revoked-during-schedule',
        'plan-inactive-at-commit',
      ] as const;
      for (const mode of modes) {
        const manager = mode.startsWith('manager-');
        const billing = mode.startsWith('billing-');
        const partner = mode === 'capture-partner' || mode === 'partner-revoked-at-commit';
        const withCapture = mode.startsWith('capture-') || mode === 'plan-locations-changed-at-commit'
          || mode === 'program-revoked-at-commit' || mode === 'partner-revoked-at-commit';
        const { now, identities, team, identity, user: actor, membership: authMembership } = await member(`member-term-${mode}`,
          manager ? ['member_terms.member_manager'] : [], mode !== 'capture-unverified-actor');
        const otherUser = await identities.createUser({ email: `other-${mode}@owner-search.test`,
          password_hash: 'unused', email_verified: true });
        const backing = createMemoryStorage();
        const site = { ...makeRow({ id: asId('site-1'), data: { active: true } }), parent: null };
        const otherSite = { ...makeRow({ id: asId('site-2'), data: { active: true } }), parent: null };
        const customer = { ...makeRow({ id: asId('customer-1'), data: {
          kind: 'company', locations: [{ id: site.id }], active: true } }), parent: null };
        const otherCustomer = { ...makeRow({ id: asId('customer-2'), data: {
          kind: 'company', locations: [{ id: otherSite.id }], active: true } }), parent: null };
        const plan = { ...makeRow({ id: asId('plan-1'), data: {
          active: mode !== 'plan-inactive', locations: [{ id: site.id }] } }), parent: null };
        const membership = { ...makeRow({ id: asId('membership-1'), data: {
          account: { id: manager || billing ? otherUser.user_id : actor.user_id },
          plan: { id: plan.id }, revoked: mode === 'membership-revoked',
          anchor: mode === 'boundary-expired' ? '2020-01-01' : '2090-01-01', months: '1',
          timezone: 'UTC', consent: 'consent-1' } }),
          parent: { model: asModel('customer.Customer'), id: customer.id } };
        const role = { ...makeRow({ id: asId('billing-role'), data: {
          account: { id: actor.user_id }, role: 'billing', active: true,
          locations: [{ id: site.id }], hidden: true } }),
          parent: { model: asModel('customer.Customer'), id: customer.id } };
        const employee = { ...makeRow({ id: asId('worker-1'), data: {
          user: { id: actor.user_id }, home: { id: site.id }, locations: [],
          operator_wide: false, active: mode !== 'manager-inactive-worker', hidden: true } }),
          parent: null };
        const program = { ...makeRow({ id: asId('program-1'), data: {
          active: mode !== 'capture-program-inactive', locations: [{ id: site.id }],
          products: [mode === 'capture-product-ineligible' ? 'office' : 'membership'] } }),
          parent: null };
        const advocate = { ...makeRow({ id: asId('advocate-1'), data: {
          account: { id: otherUser.user_id } } }),
          parent: { model: asModel('refer.Program'), id: program.id } };
        const partnerRow = { ...makeRow({ id: asId('partner-1'), data: {
          active: true, account: { id: otherUser.user_id },
          locations: [{ id: site.id }], products: ['membership'] } }), parent: null };
        const captured = new Date(now - (mode === 'capture-stale' ? 31 : 1) * 86400000).toISOString();
        const capture = { ...makeRow({ id: asId('capture-1'), data: {
          advocate: partner ? null : { id: advocate.id },
          partner: partner ? { id: partnerRow.id } : null,
          account: { id: mode === 'capture-wrong-account' ? otherUser.user_id : actor.user_id },
          captured, window: '2592000000', hidden: mode === 'capture-advocate-hidden' } }),
          parent: { model: asModel('customer.Customer'),
            id: mode === 'capture-wrong-customer' ? otherCustomer.id : customer.id } };
        const newerCapture = { ...makeRow({ id: asId('capture-2'), data: {
          advocate: { id: advocate.id }, partner: null, account: { id: actor.user_id },
          captured: mode === 'capture-tied-hidden' ? captured : new Date(now).toISOString(),
          window: '2592000000', hidden: true } }),
          parent: { model: asModel('customer.Customer'), id: customer.id } };
        const previous = { ...makeRow({ id: asId('renewal-1'), data: {
          capture: mode === 'replay-mismatch' ? { id: capture.id } : null,
          cycle: '1', requester: { id: actor.user_id }, consent: 'consent-1', hidden: true } }),
          parent: { model: asModel('member_terms.Membership'), id: membership.id } };
        const writes: Array<{ kind: 'insert'; model: ModelName; row: StoredRow }> = [
          { kind: 'insert', model: asModel('rent_catalog.Location'), row: site },
          { kind: 'insert', model: asModel('rent_catalog.Location'), row: otherSite },
          { kind: 'insert', model: asModel('customer.Customer'), row: customer },
          { kind: 'insert', model: asModel('customer.Customer'), row: otherCustomer },
          { kind: 'insert', model: asModel('member_plans.Plan'), row: plan },
          { kind: 'insert', model: asModel('member_terms.Membership'), row: membership },
          { kind: 'insert', model: asModel('refer.Program'), row: program },
          { kind: 'insert', model: asModel('refer.Advocate'), row: advocate },
          { kind: 'insert', model: asModel('affiliate.Partner'), row: partnerRow },
        ];
        if (billing) writes.push({ kind: 'insert', model: asModel('customer.CompanyRole'), row: role });
        if (manager) writes.push({ kind: 'insert', model: asModel('employee.Employee'), row: employee });
        if (withCapture || mode === 'replay-mismatch') writes.push({
          kind: 'insert', model: asModel('sales_attribution.Capture'), row: capture });
        if (mode === 'capture-superseded-hidden' || mode === 'capture-tied-hidden') writes.push({
          kind: 'insert', model: asModel('sales_attribution.Capture'), row: newerCapture });
        if (mode.startsWith('replay-')) writes.push({
          kind: 'insert', model: asModel('member_terms.Renewal'), row: previous });
        await backing.commit(makeBatch(await backing.readRevision(), { writes }));
        const race = mode.endsWith('-at-commit') || mode === 'identity-revoked-during-schedule';
        let injected = false;
        const committed: Array<Parameters<typeof backing.commit>[0]> = [];
        const store = { ...backing,
          query: async (spec: Parameters<typeof backing.query>[0]) => {
            if (mode === 'identity-revoked-during-schedule' && spec.model === asModel('work.schedule') && !injected) {
              injected = true;
              await identities.removeMembership(authMembership.membership_id);
            }
            return backing.query(spec);
          },
          commit: async (batch: Parameters<typeof backing.commit>[0]) => {
            if (race && mode !== 'identity-revoked-during-schedule' && !injected) {
              injected = true;
              const target = mode === 'plan-locations-changed-at-commit' ? ['member_plans.Plan', plan.id, { locations: [{ id: otherSite.id }] }]
                : mode === 'plan-inactive-at-commit' ? ['member_plans.Plan', plan.id, { active: false }]
                : mode === 'capture-window-changed-at-commit' ? ['sales_attribution.Capture', capture.id, { window: '0' }]
                : mode === 'program-revoked-at-commit' ? ['refer.Program', program.id, { active: false }]
                : mode === 'partner-revoked-at-commit' ? ['affiliate.Partner', partnerRow.id, { active: false }]
                : mode === 'membership-revoked-at-commit' ? ['member_terms.Membership', membership.id, { revoked: true }]
                : mode === 'billing-role-revoked-at-commit' ? ['customer.CompanyRole', role.id, { active: false }]
                : ['employee.Employee', employee.id, { active: false }];
              const [name, id, change] = target as [string, string, Record<string, unknown>];
              const current = await backing.load(asModel(name), asId(id)); assert.ok(current);
              await backing.commit(makeBatch(await backing.readRevision(), { writes: [{
                kind: 'update', model: asModel(name), id: current.id, expectedVersion: current.version,
                row: { ...current, version: asVersion(current.version + 1), updated: now,
                  data: { ...current.data, ...change } },
              }] }));
            }
            const result = await backing.commit(batch);
            committed.push(batch);
            return result;
          } };
        const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
        if (mode.startsWith('replay-')) {
          const visible = await invoker.invokeRead({ operation: 'member_terms.Renewal.read', inputs: {} }, identity);
          assert.ok('result' in visible, `${mode}: ${JSON.stringify(visible)}`);
          assert.equal((visible.result as { records: unknown[] }).records.length, 0, mode);
        }
        if (mode === 'capture-advocate-hidden') {
          const visible = await invoker.invokeRead({ operation: 'sales_attribution.Capture.read', inputs: {} }, identity);
          assert.ok('result' in visible, `${mode}: ${JSON.stringify(visible)}`);
          assert.equal((visible.result as { records: unknown[] }).records.length, 0, mode);
        }
        if (manager) {
          const visible = await invoker.invokeRead({ operation: 'employee.Employee.read', inputs: {} }, identity);
          assert.ok('result' in visible, `${mode}: ${JSON.stringify(visible)}`);
          assert.equal((visible.result as { records: unknown[] }).records.length, 0, mode);
        }
        if (billing) {
          const visible = await invoker.invokeRead({ operation: 'customer.CompanyRole.read', inputs: {} }, identity);
          assert.ok('result' in visible, `${mode}: ${JSON.stringify(visible)}`);
          assert.equal((visible.result as { records: unknown[] }).records.length, 0, mode);
        }
        const outcome = await invoker.invokeMutation({ operation: 'member_terms.term',
          operation_id: operationId(now), inputs: {
            membership: { id: membership.id, version: String(membership.version) },
            cycle: mode === 'cycle-zero' ? '0' : '1',
            ...(withCapture ? { capture: { id: capture.id, version: String(capture.version) } }
              : mode === 'create-explicit-null' ? { capture: null } : {}),
          } }, identity).catch((error: unknown) => {
            throw new Error(`${mode}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          });
        const created = ['create-no-capture', 'create-explicit-null', 'capture-advocate-hidden',
          'capture-partner', 'capture-tied-hidden',
          'manager-hidden-worker', 'billing-hidden-role'].includes(mode);
        const replay = mode === 'replay-hidden';
        assert.equal('result' in outcome ? outcome.result.status : outcome.error.code,
          created || replay ? 'committed' : mode === 'identity-revoked-during-schedule' ? 'forbidden'
            : mode === 'capture-window-changed-at-commit' || mode === 'membership-revoked-at-commit'
              ? 'conflict' : 'rule_failed',
          `${mode}: ${JSON.stringify(outcome)}`);
        const renewals = await backing.query({ model: asModel('member_terms.Renewal'), authority: 'owner' });
        assert.equal(renewals.length, mode.startsWith('replay-') || created ? 1 : 0, mode);
        if (created) {
          assert.equal(renewals[0]?.data.cycle, '1', mode);
          assert.deepEqual(renewals[0]?.data.capture, withCapture ? { id: capture.id } : null, mode);
          assert.deepEqual(renewals[0]?.data.requester, { id: actor.user_id }, mode);
          assert.equal(renewals[0]?.data.consent, 'consent-1', mode);
        }
        if (replay) assert.equal(renewals[0]?.version, previous.version, mode);
        const schedules = committed.flatMap(batch => batch.schedules ?? []);
        assert.equal(schedules.length, created ? 1 : 0, `${mode}: schedule count`);
        const lineage = await backing.query({ model: asModel('work.schedule'), authority: 'owner' });
        assert.equal(lineage.length, created ? 1 : 0, `${mode}: schedule lineage count`);
        if (created) {
          const schedule = schedules[0]; assert.ok(schedule && schedule.op === 'replace');
          const scopedKey = ['CanMember', 'member_terms', team.team_id, renewals[0]!.id]
            .map(encodeURIComponent).join('/');
          assert.equal(schedule.key, scopedKey, mode);
          assert.equal(schedule.at, now, `${mode}: authored at=now`);
          assert.equal(schedule.event, 'member_terms.RenewalDue', mode);
          assert.deepEqual(schedule.payload, { renewal: { id: renewals[0]?.id, version: '1' } }, mode);
          assert.deepEqual(await backing.scheduleGet(scopedKey), {
            key: schedule.key, at: schedule.at, event: schedule.event, payload: schedule.payload }, mode);
          assert.equal(lineage[0]?.data.key, renewals[0]?.id, `${mode}: bare lineage key`);
          assert.equal(lineage[0]?.data.scopeApp, 'CanMember', mode);
          assert.equal(lineage[0]?.data.scopeOwnerPackage, 'member_terms', mode);
          assert.equal(lineage[0]?.data.scopeOwner, team.team_id, mode);
          assert.equal(lineage[0]?.data.state, 'pending', mode);
          assert.deepEqual(lineage[0]?.data.payload, schedule.payload, mode);
        }
        if (race) assert.equal(injected, true, mode);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('refuses changed term replay, capture selection, and scheduled-event source bodies',
  { timeout: 120000 }, async () => {
    const original = await readFile(fixture('member-term-owner-probe.can'), 'utf8');
    const source = await readFile(join(root, 'draft/apps/CanMember/CanMember.can'), 'utf8');
    const refer = await readFile(join(root, 'draft/apps/CanRefer/CanRefer.can'), 'utf8');
    for (const line of source.split('\n').slice(230, 245)) {
      if (line.includes('scenario term(') || line.trim().startsWith('require ') ||
          line.trim().startsWith('let ') || line.trim().startsWith('if ') ||
          line.trim().startsWith('create Renewal ') || line.trim().startsWith('schedule ')) {
        assert.ok(original.includes(line), `term retains the original source line: ${line}`);
      }
    }
    const helper = refer.split('\n').find(line => line.includes('export derive latest_capture('));
    assert.ok(helper && original.includes(helper));
    const changes = [
      ['cycle-guard', 'require cycle>0 and not membership.revoked',
        'require cycle>=0 and not membership.revoked'],
      ['capture-helper', 'capture.captured+capture.window>=now',
        'capture.captured+capture.window>now'],
      ['replay-key', 'request.cycle==cycle', 'request.cycle!=cycle'],
      ['replay-capture', 'previous.capture==capture', 'previous.capture!=capture'],
      ['latest-capture', 'capture==latest_capture(', 'capture!=latest_capture('],
      ['scheduled-time', 'schedule renewal.id at=now event=RenewalDue {renewal}',
        'schedule renewal.id at=now+1d event=RenewalDue {renewal}'],
    ] as const;
    const directory = await mkdtemp(join(tmpdir(), 'can-member-term-mutants-'));
    try {
      for (const [name, before, after] of changes) {
        assert.equal(original.split(before).length, 2, `${name}: unique original source`);
        const path = join(directory, `${name}.can`);
        await writeFile(path, original.replace(before, after));
        const result = spawnSync(compiler, ['compile', '--format=json', '--native-scenario-receipts',
          '--catalog', catalog, path], { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 10, `${name}: ${result.stdout} ${result.stderr}`);
        const report = JSON.parse(result.stdout) as { diagnostics: { code: string; message: string }[] };
        assert.ok(report.diagnostics.some(diagnostic => diagnostic.code === 'E6008'),
          `${name}: changed source must retain a native refusal`);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('evaluates original booking availability over civil dates and both owning calendars',
  { timeout: 180000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-book-availability-'));
    try {
      const source = join(root, 'compiler/tests/fixtures/book-available-source.can');
      const { stdout } = await promisify(execFile)(compiler,
        ['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],
        {cwd:root,timeout:60000,maxBuffer:32*1024*1024});
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({artifact,sourcePath:source},{workDir:directory,
        stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
      for (const mode of ['open','inactive','holiday','dated-closed','dated-open','calendar-closed','blocked','other-location','holiday-at-commit']) {
        const {now,identities,identity}=await member(`booking-${mode}`),store=createMemoryStorage();
        const row=(id:string,data:Record<string,unknown>,parent:string|null=null)=>
          ({...makeRow({id:asId(id),data}),parent:parent===null?null:{model:asModel(parent.startsWith('location-')?'rent_catalog.Location':'appointments.Calendar'),id:asId(parent)}});
        const writes:Array<{kind:'insert';model:ModelName;row:StoredRow}>=[
          {kind:'insert',model:asModel('rent_catalog.Location'),row:row('location-1',{active:mode!=='inactive',timezone:'UTC'})},
          {kind:'insert',model:asModel('rent_catalog.Location'),row:row('location-2',{active:true,timezone:'UTC'})},
          {kind:'insert',model:asModel('appointments.Calendar'),row:row('calendar-1',{location:{id:'location-1'},active:true,timezone:'UTC'})},
          {kind:'insert',model:asModel('rent_catalog.WeeklyHours'),row:row('location-hours',{weekday:'4',opens:'09:00',closes:'18:00',close_after:'0',fold:'earlier'},mode==='other-location'?'location-2':'location-1')},
          {kind:'insert',model:asModel('appointments.WeeklyHours'),row:row('calendar-hours',{weekday:'4',opens:'09:00',closes:'18:00',fold:'earlier'},'calendar-1')},
          {kind:'insert',model:asModel('appointments.Window'),row:row('available-window',{from:'2099-01-01T09:00:00.000Z',until:'2099-01-01T18:00:00.000Z',available:true},'calendar-1')},
        ];
        const holiday={kind:'insert' as const,model:asModel('rent_catalog.ClosedDate'),row:row('holiday',{day:'2099-01-01',reason:'Closed'},'location-1')};
        if(mode==='holiday')writes.push(holiday);
        if(mode==='dated-closed'||mode==='dated-open')writes.push({kind:'insert',model:asModel('rent_catalog.DateHours'),row:row('dated-hours',{day:'2099-01-01',opens:'09:00',closes:'18:00',close_after:'0',closed:mode==='dated-closed',fold:'earlier'},'location-1')});
        if(mode==='calendar-closed')writes.push({kind:'insert',model:asModel('appointments.ClosedDay'),row:row('calendar-closure',{day:'2099-01-01',reason:'Closed'},'calendar-1')});
        if(mode==='blocked')writes.push({kind:'insert',model:asModel('appointments.Window'),row:row('blocked-window',{from:'2099-01-01T09:15:00.000Z',until:'2099-01-01T09:45:00.000Z',available:false},'calendar-1')});
        await store.commit(makeBatch(await store.readRevision(),{writes}));
        let inserted=false;
        if(mode==='holiday-at-commit'){
          const commit=store.commit.bind(store);
          store.commit=async batch=>{
            if(!inserted){inserted=true;await commit(makeBatch(await store.readRevision(),{writes:[holiday]}));}
            return commit(batch);
          };
        }
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const outcome=await invoker.invokeMutation({operation:'appointments.check',operation_id:operationId(now),inputs:{
          calendar:{id:'calendar-1',version:'1'},from:'2099-01-01T09:00:00.000Z',until:'2099-01-01T09:30:00.000Z'}},identity);
        const success=mode==='open'||mode==='dated-open';
        assert.equal('result' in outcome?outcome.result.status:outcome.error.code,success?'committed':'rule_failed',`${mode}: ${JSON.stringify(outcome)}`);
        if(mode==='holiday-at-commit')assert.equal(inserted,true);
        assert.equal((await store.load(asModel('appointments.Calendar'),asId('calendar-1')))?.version,1);
      }
    } finally {await rm(directory,{recursive:true,force:true});}
  });


it('runs source-only guard frames without inventing result disclosure',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-source-only-frame-'));
    try {
      const source = join(root, 'compiler/tests/fixtures/native-require-missing-owner-frame.can');
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      assert.equal(artifact.operations?.find(operation => operation.name === 'GuardOwnerFrame.run')?.result?.disclosure, undefined);
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
        stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
      for (const mode of ['allowed', 'full', 'inactive', 'other-parent', 'capacity-at-commit', 'membership-during-query']) {
        const { now, identities, identity, membership } = await member(`source-only-${mode}`);
        const store = createMemoryStorage(), rootModel = model('GuardOwnerFrame', 'Root');
        const rootRow = { ...makeRow({ id: asId('root-1'), data: { capacity: mode === 'full' ? '1' : '2', checked: false } }), parent: null };
        const writes: Array<{ kind: 'insert'; model: ModelName; row: StoredRow }> = [
          { kind: 'insert', model: rootModel, row: rootRow },
          { kind: 'insert', model: rootModel, row: { ...rootRow, id: asId('root-2') } },
          { kind: 'insert', model: model('GuardOwnerFrame', 'Child'), row: {
            ...makeRow({ id: asId('child-1'), data: { active: mode !== 'inactive' } }),
            parent: { model: rootModel, id: asId(mode === 'other-parent' ? 'root-2' : 'root-1') },
          } },
        ];
        await store.commit(makeBatch(await store.readRevision(), { writes }));
        let changed = false;
        if (mode === 'membership-during-query') {
          const query = store.query.bind(store);
          store.query = async spec => {
            if (!changed && spec.model === model('GuardOwnerFrame', 'Child')) {
              changed = true;
              await identities.removeMembership(membership.membership_id);
            }
            return query(spec);
          };
        }
        if (mode === 'capacity-at-commit') {
          const commit = store.commit.bind(store);
          store.commit = async batch => {
            if (!changed) {
              changed = true;
              if (mode === 'capacity-at-commit') await commit(makeBatch(await store.readRevision(), { writes: [
                { kind: 'update', model: rootModel, id: rootRow.id, expectedVersion: asVersion(rootRow.version),
                  row: { ...rootRow, version: asVersion(rootRow.version + 1), data: { ...rootRow.data, capacity: '0' } } },
              ] }));
            }
            return commit(batch);
          };
        }
        const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
        const request = { operation: 'GuardOwnerFrame.run', operation_id: operationId(now),
          inputs: { root: { id: rootRow.id, version: String(rootRow.version) } } };
        const outcome = await invoker.invokeMutation(request, identity);
        assert.equal('result' in outcome ? outcome.result.status : outcome.error.code,
          mode === 'allowed' ? 'committed' : mode === 'capacity-at-commit' ? 'conflict' : mode === 'membership-during-query' ? 'forbidden' : 'rule_failed',
          `${mode}: ${JSON.stringify(outcome)}`);
        assert.equal((await store.load(rootModel, rootRow.id))?.data.checked, mode === 'allowed');
        if (mode === 'allowed') {
          assert.equal('result' in outcome && outcome.result.result, new Date(now + 86400000).toISOString().slice(0, 10));
          const replay = await invoker.invokeMutation(request, identity);
          // Guard execution supplies no saved DATA authority. The ordinary
          // replay path must keep refusing a value without its association.
          assert.equal('error' in replay && replay.error.code, 'validation', JSON.stringify(replay));
          assert.match('error' in replay ? replay.error.message : '', /no supported execution association/);
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });


it('stages source-only unguarded SEND through the actual State Work owner without saved DATA authority',
  {timeout:180000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-source-only-send-'));
    try{
      const {artifact,asm}=await installed('native-source-require-send.can',directory);
      const original=await readFile(fixture('native-source-require-send.can'),'utf8');
      const declined=fixture('.native-source-require-send-refusal.can');
      try{
        for(const [name,text] of [
          ['stored field',original.replace('let subject="Checked request"','let subject=root.secret')],
          ['direct stored field',original.replace('send Mail.send {to,subject,','send Mail.send {to,subject=root.secret,')],
          ['guarded SEND',original.replace('body="Original source action"} as delivery','body="Original source action"} when=root.checked as delivery')],
          ['unproved CALL',original.replace('let subject="Checked request"','call abort {root,to} as prior\n   let subject="Checked request"')],
        ] as const){
          await writeFile(declined,text);
          const rejected=spawnSync(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,declined],{cwd:root,encoding:'utf8'});
          assert.equal(rejected.status,10,`${name}: ${rejected.stdout}`);
          const report=JSON.parse(rejected.stdout) as {diagnostics:{code:string;message:string}[]};
          assert.ok(report.diagnostics.some(item=>item.code==='E6008'),`${name}: source-only work must not lend DATA/guard/CALL authority`);
        }
      }finally{await rm(declined,{force:true});}
      for(const name of ['SourceGuardSend.notify','SourceGuardSend.abort']){
        assert.equal(artifact.operations?.find(operation=>operation.name===name)?.result?.disclosure,undefined);
      }
      for(const mode of ['allowed','full','inactive','other-parent','invariant-after-send','membership-during-send','invalid-email'] as const){
        const {now,identities,identity,membership}=await member(`source-send-${mode}`);
        const store=createMemoryStorage(),rootModel=model('SourceGuardSend','Root');
        const rootRow={...makeRow({id:asId('root-1'),data:{capacity:mode==='full'?'1':'2',checked:false,last:null,secret:'Hidden source field'}}),parent:null};
        await store.commit(makeBatch(await store.readRevision(),{writes:[
          {kind:'insert',model:rootModel,row:rootRow},
          {kind:'insert',model:rootModel,row:{...rootRow,id:asId('root-2')}},
          {kind:'insert',model:model('SourceGuardSend','Child'),row:{...makeRow({id:asId('child-1'),data:{active:mode!=='inactive'}}),
            parent:{model:rootModel,id:asId(mode==='other-parent'?'root-2':'root-1')}}},
        ]}));
        let revoked=false;
        if(mode==='membership-during-send'){
          const load=store.load.bind(store);
          store.load=async(model,id)=>{
            if(!revoked&&model==='work.dispatch'){revoked=true;await identities.removeMembership(membership.membership_id);}
            return load(model,id);
          };
        }
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const request={operation:mode==='invariant-after-send'?'SourceGuardSend.abort':'SourceGuardSend.notify',operation_id:operationId(now),
          inputs:{root:{id:rootRow.id,version:String(rootRow.version)},to:mode==='invalid-email'?'invalid':'recipient@example.test'}};
        const result=await invoker.invokeMutation(request,identity);
        const allowed=mode==='allowed';
        assert.equal('result' in result&&result.result.status==='committed',allowed,`${mode}: ${JSON.stringify(result)}`);
        if(mode==='membership-during-send')assert.equal(revoked,true);
        const actual=await store.load(rootModel,rootRow.id);assert.ok(actual);
        assert.equal(actual.data.checked,allowed,mode);assert.equal(actual.data.capacity,rootRow.data.capacity,mode);
        const dispatch=await store.query({model:asModel('work.dispatch'),authority:'owner'}),pending=await store.outboxPending();
        assert.equal(dispatch.length,allowed?1:0,mode);assert.equal(pending.length,allowed?1:0,mode);
        if(allowed){
          assert.equal(typeof actual.data.last,'string');assert.equal(actual.data.last,dispatch[0]!.id);
          assert.equal(pending[0]!.target,'std.EmailV1.send');
          assert.deepEqual(pending[0]!.arguments,{binding:'SourceGuardSend.Mail',from:'deployment.mail',
            arguments:{to:'recipient@example.test',subject:'Checked request',body:'Original source action',attachments:[]}});
          assert.equal('result' in result&&result.result.result,new Date(now).toISOString().slice(0,10));
          const visible=await invoker.invokeRead({operation:'SourceGuardSend.Root.read',inputs:{}},identity);
          assert.ok('error' in visible||((visible.result as {records:unknown[]}).records.length===0),'source guard/SEND creates no row DATA grant');
          const saved=await store.readReceipt({app:'SourceGuardSend',owner:membership.team_id,principal:membership.user_id,
            operation:request.operation,operationId:request.operation_id} as Parameters<typeof store.readReceipt>[0]);assert.ok(saved);
          assert.equal(saved.outcome.status,'committed');assert.equal('scenario' in saved.outcome,false);
          const replay=await invoker.invokeMutation(request,identity);
          assert.ok('error' in replay&&replay.error.code==='validation',JSON.stringify(replay));
          assert.match('error' in replay?replay.error.message:'',/no supported execution association/);
          assert.deepEqual(await store.outboxPending(),pending,'ordinary replay never sends again or changes the original Work request');
          assert.deepEqual(await store.query({model:asModel('work.dispatch'),authority:'owner'}),dispatch);
          assert.deepEqual(await store.readReceipt(saved.identity),saved);
        }else{
          assert.equal(actual.data.last,null);assert.equal(actual.version,rootRow.version,'refusal rolls back preceding SET and staged SEND together');
        }
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });

it('executes original rescheduling with real provider intents and unchanged original slots',
  {timeout:180000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-book-body-'));
    try {
      const source=join(root,'compiler/tests/fixtures/book-original-source.can');
      const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
      const artifact=JSON.parse(stdout) as CompileArtifact;
      const asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
      for(const mode of ['reschedule','reschedule-room','missing-first','pending-attempt','first-read-race','unverified','wrong-actor','contact-at-commit','identity-query-race']){
        const {now,identities,identity,user:actor,membership}=await member('book-body-'+mode);
        const {store,probe}=createTestMemoryStorage();
        const movement=mode.startsWith('reschedule')||['missing-first','pending-attempt','first-read-race','unverified','wrong-actor','contact-at-commit','identity-query-race'].includes(mode),room=mode.endsWith('-room');
        const row=(model:string,id:string,data:Record<string,unknown>,parent:{model:ModelName;id:ReturnType<typeof asId>}|null=null)=>({kind:'insert' as const,model:asModel(model),row:{...makeRow({id:asId(id),data}),parent}});
        const calendar={model:asModel('appointments.Calendar'),id:asId('calendar')},type={model:asModel('appointments.Type'),id:asId('type')},visit={model:asModel('appointments.Appointment'),id:asId('visit')};
        await store.commit(makeBatch(await store.readRevision(),{writes:[
          row('rent_catalog.Location','site',{active:true,timezone:'UTC'}),
          row('rent_catalog.WeeklyHours','site-hours',{weekday:'4',opens:'09:00',closes:'18:00',close_after:'0',fold:'earlier'},{model:asModel('rent_catalog.Location'),id:asId('site')}),
          row('employee.Employee','host',{user:{id:actor.user_id},active:mode!=='host-inactive',operator_wide:false,home:{id:'site'},locations:[]}),
          row('customer.Customer','customer',{active:true,locations:[{id:'site'}],name:'Customer'}),
          row('customer.Customer','other-customer',{active:true,locations:[{id:'site'}],name:'Other'}),
          row('customer.Contact','contact',{account:{id:mode==='wrong-actor'?'other-user':actor.user_id},verified:mode!=='unverified',email:'customer@example.test',name:'Contact'},{model:asModel('customer.Customer'),id:asId(mode==='wrong-contact'?'other-customer':'customer')}),
          row('appointments.Calendar','calendar',{location:{id:'site'},host:{id:'host'},timezone:'UTC',duration:'1800000',hours:'9-18',instructions:'Reception',cutoff:'3600000',active:true}),
          row('appointments.Type','type',{name:'Tour',duration:'1800000',room:room?'room-1':null},calendar),
          row('appointments.WeeklyHours','hours',{weekday:'4',opens:'09:00',closes:'18:00',fold:'earlier'},calendar),
          row('appointments.Window','window',{from:'2099-01-01T09:00:00.000Z',until:'2099-01-01T18:00:00.000Z',available:mode!=='blocked'},calendar),
          ...(movement?[row('appointments.Appointment','visit',{customer:{id:'customer'},contact:{id:'contact'},from:'2099-01-01T09:00:00.000Z',until:'2099-01-01T09:30:00.000Z',duration:'1800000',source:'original',active_source:'original',host:{id:actor.user_id},reservation_account:{id:actor.user_id},room_snapshot:room?'room-1':null,state:'confirmed',host_ok:true,room_ok:true,host_delivery:'original-host',room_delivery:null,reason:null,reason_code:null},type),
            ...(mode==='missing-first'?[]:[row('appointments.Attempt','previous',{source:'original',kind:'initial',from:'2099-01-01T09:00:00.000Z',until:'2099-01-01T09:30:00.000Z',previous_source:null,previous_host_revision:'1',previous_room_revision:'1',requested_by:{id:actor.user_id},state:'active',host_ok:true,room_ok:true,host_unknown:false,room_unknown:false,host_revision:'3',room_revision:'5',host_delivery:'original-host',room_delivery:null,room_confirmation:null,host_release:null,room_release:null,host_released:false,room_released:true},visit)]),
            ...(mode==='pending-attempt'?[row('appointments.Attempt','pending',{state:'pending'},visit)]:[])]:[])
        ]}));
        let raced=false;
        if(mode==='identity-query-race'){
          const query=store.query.bind(store);
          store.query=async spec=>{const rows=await query(spec);if(spec.model==='appointments.Attempt'&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}return rows;};
        }
        if(mode==='contact-at-commit'){
          const commit=store.commit.bind(store);
          store.commit=async batch=>{if(batch.writes.some(write=>write.kind==='insert'&&write.model==='appointments.Attempt')){raced=true;const contact=await store.load(asModel('customer.Contact'),asId('contact'));assert.ok(contact);await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:asModel('customer.Contact'),id:contact.id,expectedVersion:contact.version,row:{...contact,version:asVersion(contact.version+1),data:{...contact.data,verified:false}}}]}));}return commit(batch);};
        }
        if(mode==='first-read-race'){
          const commit=store.commit.bind(store);
          store.commit=async batch=>{if(batch.writes.some(write=>write.kind==='insert'&&write.model==='appointments.Attempt')){raced=true;const previous=await store.load(asModel('appointments.Attempt'),asId('previous'));assert.ok(previous);await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:asModel('appointments.Attempt'),id:previous.id,expectedVersion:previous.version,row:{...previous,version:asVersion(previous.version+1),data:{...previous.data,host_revision:(BigInt(String(previous.data['host_revision']))+1n).toString()}}}]}));}return commit(batch);};
        }
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const operation=movement?'appointments.reschedule':'appointments.book',operation_id=operationId(now);
        const inputs=movement?{visit:{id:'visit',version:'1'},from:'2099-01-01T10:00:00.000Z'}:{type:{id:'type',version:'1'},customer:{id:'customer',version:'1'},contact:{id:'contact',version:'1'},from:'2099-01-01T09:00:00.000Z'};
        const result=await invoker.invokeMutation({operation,operation_id,inputs},identity);
        const success=['book','book-room','reschedule','reschedule-room'].includes(mode);
        assert.equal('result' in result,success,mode+': '+JSON.stringify(result));
        if(['first-read-race','contact-at-commit','identity-query-race'].includes(mode))assert.equal(raced,true,mode+': the original authority or selected row changed');
        const attempts=await store.query({model:asModel('appointments.Attempt'),authority:'owner'});
        const created=attempts.filter(row=>row.data['source']===operation_id);assert.equal(created.length,success?1:0,mode+': attempts remain atomic');
        assert.equal(probe.outboxAll().length,success?(room?2:1):0,mode+': genuine intents remain atomic');
        if(success){
          const attempt=created[0];assert.ok(attempt);assert.equal(attempt.data['kind'],movement?'movement':'initial');
          const host=probe.outboxAll().find(intent=>intent.target==='shift.ScheduleV1.'+(movement?'stage':'reserve'));assert.ok(host);
          const args=host.arguments['arguments'] as Record<string,unknown>;
          assert.deepEqual(args['value'],{source:operation_id,employee:{id:actor.user_id},location:'site',from:movement?'2099-01-01T10:00:00.000Z':'2099-01-01T09:00:00.000Z',until:movement?'2099-01-01T10:30:00.000Z':'2099-01-01T09:30:00.000Z',before:'0',after:'0',skill:'host',kind:'appointment',revision:'1'});
          assert.equal(attempt.data['host_delivery'],host.intentId);
          if(movement){assert.equal(args['previous_source'],'original');assert.equal(args['previous_revision'],'3');assert.equal(attempt.data['previous_room_revision'],'5');}
          if(room){const roomIntent=probe.outboxAll().find(intent=>intent.target==='rent_reservations.RoomsV1.'+(movement?'stage':'hold'));assert.ok(roomIntent);assert.equal(attempt.data['room_delivery'],roomIntent.intentId);
            const roomArgs=roomIntent.arguments['arguments'] as Record<string,unknown>;
            assert.deepEqual(roomArgs['value'],{source:operation_id,revision:'1',resource:'room-1',customer:'customer',account:{id:actor.user_id},from:'2099-01-01T10:00:00.000Z',until:'2099-01-01T10:30:00.000Z',quantity:'1',price:null,terms:null});
            assert.equal(roomArgs['previous_source'],'original');assert.equal(roomArgs['previous_revision'],'5');}
          else assert.equal(attempt.data['room_ok'],true);
          const replay=await invoker.invokeMutation({operation,operation_id,inputs},identity);assert.ok('result' in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');assert.equal(probe.outboxAll().length,room?2:1);
        }
        if(movement){const original=await store.load(asModel('appointments.Appointment'),asId('visit'));assert.ok(original);assert.equal(original.version,1);assert.equal(original.data['from'],'2099-01-01T09:00:00.000Z');assert.equal(original.data['state'],'confirmed');assert.equal(original.data['active_source'],'original');}
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });

it('retains exact nullable enum membership through real owner execution and final guards',
  {timeout:120000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-nullable-enum-membership-'));
    try{
      const {artifact,asm}=await installed('native-nullable-enum-membership.can',directory);
      assert.notEqual(artifact.operations?.find(operation=>operation.name==='EnumProbe.act')?.result?.disclosure,undefined);
      // A computed nullable field is still a stored read, rather than a
      // closed enum literal. It cannot inherit the new literal-array proof.
      const computed=fixture('.native-nullable-enum-computed.can');
      try{
        await writeFile(computed,(await readFile(fixture('native-nullable-enum-membership.can'),'utf8'))
          .replace('[failed,unknown]','[root.state]'));
        const result=spawnSync(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,computed],{cwd:root,encoding:'utf8'});
        assert.equal(result.status,0,result.stdout+result.stderr);
        assert.equal((JSON.parse(result.stdout) as CompileArtifact).operations?.find(operation=>operation.name==='EnumProbe.act')?.result?.disclosure,undefined);
      }finally{await rm(computed,{force:true});}
      for(const mode of ['failed','unknown','ready','null','changed-at-commit']){
        const {now,identities,identity}=await member(`nullable-enum-${mode}`);
        const store=createMemoryStorage(),rootModel=model('EnumProbe','Root');
        const row={...makeRow({id:asId('root-1'),data:{state:mode==='null'?null:mode==='changed-at-commit'?'failed':mode,checked:false}}),parent:null};
        await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:rootModel,row}]}));
        if(mode==='changed-at-commit'){
          const commit=store.commit.bind(store);let changed=false;
          store.commit=async batch=>{
            if(!changed){changed=true;await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:rootModel,
              id:row.id,expectedVersion:asVersion(row.version),row:{...row,version:asVersion(row.version+1),data:{...row.data,state:'ready'}}}]}));}
            return commit(batch);
          };
        }
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const outcome=await invoker.invokeMutation({operation:'EnumProbe.act',operation_id:operationId(now),
          inputs:{root:{id:row.id,version:String(row.version)}}},identity);
        const allowed=mode==='failed'||mode==='unknown';
        assert.equal('result'in outcome?outcome.result.status:outcome.error.code,
          allowed?'committed':mode==='changed-at-commit'?'conflict':'rule_failed',`${mode}: ${JSON.stringify(outcome)}`);
        assert.equal((await store.load(rootModel,row.id))?.data.checked,allowed,mode);
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });
it('authorizes a stored timezone through the original parent path and rechecks saved disclosure',
  {timeout:120000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-parent-timezone-'));
    try{
      const {artifact,asm}=await installed('native-parent-timezone.can',directory);
      const plan=artifact.operations?.find(operation=>operation.name==='ParentTimezone.day')?.result?.disclosure;
      assert.ok(plan,'the date must retain its actual parent DATA dependencies');
      assert.ok(plan.returns.some(returned=>returned.dependencies.some(dependency=>dependency.field==='timezone'&&dependency.type==='timezone')));
      for(const mode of ['utc','new-york','hidden','changed-at-commit','hidden-at-commit']){
        const {now,identities,identity}=await member(`parent-zone-${mode}`);
        const store=createMemoryStorage(),resourceModel=model('ParentTimezone','Resource'),bookingModel=model('ParentTimezone','Booking');
        const zone=mode==='new-york'?'America/New_York':'UTC';
        const resource={...makeRow({id:asId('resource'),data:{timezone:zone,visible:mode!=='hidden'}}),parent:null};
        const booking={...makeRow({id:asId('booking'),data:{active:true,checked:false}}),parent:{model:resourceModel,id:resource.id}};
        await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:resourceModel,row:resource},{kind:'insert',model:bookingModel,row:booking}]}));
        const updateResource=async(data:Record<string,unknown>)=>{
          const current=await store.load(resourceModel,resource.id);assert.ok(current);
          await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:resourceModel,id:current.id,
            expectedVersion:asVersion(current.version),row:{...current,version:asVersion(current.version+1),data:{...current.data,...data}}}]}));
        };
        if(mode.endsWith('at-commit')){
          const commit=store.commit.bind(store);let injecting=false;
          store.commit=async batch=>{
            if(!injecting){
              injecting=true;
              try{await updateResource(mode==='hidden-at-commit'?{visible:false}:{timezone:'Pacific/Kiritimati'});}
              finally{injecting=false;}
            }
            return commit(batch);
          };
        }
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const request={operation:'ParentTimezone.day',operation_id:operationId(now),inputs:{booking:{id:booking.id,version:String(booking.version)}}};
        const outcome=await invoker.invokeMutation(request,identity),allowed=mode==='utc'||mode==='new-york';
        assert.equal('result'in outcome,allowed,`${mode}: ${JSON.stringify(outcome)}`);
        assert.equal((await store.load(bookingModel,booking.id))?.data.checked,allowed,'denied or stale parent reads roll back the preceding SET');
        if(allowed){
          assert.ok('result'in outcome);
          const expected=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));
          assert.equal(outcome.result.result,expected);
          const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay,JSON.stringify(replay));
          assert.equal(replay.result.status,'replayed');assert.equal(replay.result.result,expected);
          await updateResource({visible:false});
          const hidden=await invoker.invokeMutation(request,identity);
          assert.ok('error'in hidden || hidden.result.result===null,'saved date cannot disclose a now-hidden parent timezone');
        }
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });
