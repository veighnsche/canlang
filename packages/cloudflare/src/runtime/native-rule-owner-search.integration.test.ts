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
import type { CompileArtifact, FileRetirementAuthority, ModelName, StoredRow } from '@canlang/contracts';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { createMemoryStorage, createTestMemoryStorage } from '@canlang/state/storage/memory';
import { asId, asModel, asVersion, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';
import { buildInvoker } from '../worker/assembly.js';
import { assembleModules } from './modules.js';

import { invokeRetainedHandlerOccurrenceCanonical } from './invoke.js';
import { STATE_FILE_REFERENCE_PRODUCER } from '@canlang/state/storage';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work/kernel/file-reference-inventory';
import { installNativeFileInventory } from './file-inventory.js';

import { createCanonicalFileBinding } from './bound-files.js';
import { createFileJourneyKernel, type FileJourneyBindings } from '@canlang/interfaces/uploads/kernel';
import { createUploadIntent, appendUploadContentAtOffset, completeUploadContent, sha256Hex, DEFAULT_FILE_POLICY } from '@canlang/files/upload';
import { authorizeAttach, finalizeUpload, observeFinalizedFile, readCurrentFinalizedBytes,
  readCurrentFinalizedSnapshot, readFinalizedBytes, readFinalizedFile, recordAttachment,
  revalidateRetainedFinalizedFile } from '@canlang/files/finalize';
import { TestOnlyManualClock, TestOnlyCounterIntentIds, TestOnlyCounterFileIds,
  TestOnlyMemoryIntentStore, TestOnlyMemoryBlobStore, TestOnlyMemoryFinalizedStore } from '@canlang/files/ports';

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

it('executes original booking and rescheduling with private constructor inputs and real provider intents',
  {timeout:240000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-book-body-'));
    try {
      const source=join(root,'compiler/tests/fixtures/book-original-source.can');
      const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
      const artifact=JSON.parse(stdout) as CompileArtifact;
      const asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
      for(const mode of ['book','book-room','book-custom-id','book-host-at-commit','book-link-at-commit','book-identity-read','book-unverified','book-wrong-actor','book-inactive-calendar','host-inactive','wrong-contact','blocked','reschedule','reschedule-room','missing-first','pending-attempt','first-read-race','unverified','wrong-actor','contact-at-commit','identity-query-race']){
        const {now,identities,identity,user:actor,membership}=await member('book-body-'+mode);
        const {store,probe}=createTestMemoryStorage();
        const movement=mode.startsWith('reschedule')||['missing-first','pending-attempt','first-read-race','unverified','wrong-actor','contact-at-commit','identity-query-race'].includes(mode),room=mode.endsWith('-room');
        const row=(model:string,id:string,data:Record<string,unknown>,parent:{model:ModelName;id:ReturnType<typeof asId>}|null=null)=>({kind:'insert' as const,model:asModel(model),row:{...makeRow({id:asId(id),data}),parent}});
        const calendar={model:asModel('appointments.Calendar'),id:asId('calendar')},type={model:asModel('appointments.Type'),id:asId('type')},visit={model:asModel('appointments.Appointment'),id:asId('visit')};
        await store.commit(makeBatch(await store.readRevision(),{writes:[
          row('rent_catalog.Location','site',{active:true,timezone:'UTC'}),
          row('rent_catalog.WeeklyHours','site-hours',{weekday:'4',opens:'09:00',closes:'18:00',close_after:'0',fold:'earlier'},{model:asModel('rent_catalog.Location'),id:asId('site')}),
          row('employee.Employee','host',{user:{id:actor.user_id},active:mode!=='host-inactive',operator_wide:false,home:{id:'site'},locations:[]}),
          row('employee.Employee','other-host',{user:{id:actor.user_id},active:true,operator_wide:false,home:{id:'site'},locations:[]}),
          row('customer.Customer','customer',{active:true,locations:[{id:'site'}],name:'Customer'}),
          row('customer.Customer','other-customer',{active:true,locations:[{id:'site'}],name:'Other'}),
          row('customer.Contact','contact',{account:{id:mode.endsWith('wrong-actor')?'other-user':actor.user_id},verified:!mode.endsWith('unverified'),email:'customer@example.test',name:'Contact'},{model:asModel('customer.Customer'),id:asId(mode==='wrong-contact'?'other-customer':'customer')}),
          row('appointments.Calendar','calendar',{location:{id:'site'},host:{id:'host'},timezone:'UTC',duration:'1800000',hours:'9-18',instructions:'Reception',cutoff:'3600000',active:mode!=='book-inactive-calendar'}),
          row('appointments.Type','type',{name:'Tour',duration:'1800000',room:room?'room-1':null},calendar),
          row('appointments.WeeklyHours','hours',{weekday:'4',opens:'09:00',closes:'18:00',fold:'earlier'},calendar),
          row('appointments.Window','window',{from:'2099-01-01T09:00:00.000Z',until:'2099-01-01T18:00:00.000Z',available:mode!=='blocked'},calendar),
          ...(movement?[row('appointments.Appointment','visit',{customer:{id:'customer'},contact:{id:'contact'},from:'2099-01-01T09:00:00.000Z',until:'2099-01-01T09:30:00.000Z',duration:'1800000',source:'original',active_source:'original',host:{id:actor.user_id},reservation_account:{id:actor.user_id},room_snapshot:room?'room-1':null,state:'confirmed',host_ok:true,room_ok:true,host_delivery:'original-host',room_delivery:null,reason:null,reason_code:null},type),
            ...(mode==='missing-first'?[]:[row('appointments.Attempt','previous',{source:'original',kind:'initial',from:'2099-01-01T09:00:00.000Z',until:'2099-01-01T09:30:00.000Z',previous_source:null,previous_host_revision:'1',previous_room_revision:'1',requested_by:{id:actor.user_id},state:'active',host_ok:true,room_ok:true,host_unknown:false,room_unknown:false,host_revision:'3',room_revision:'5',host_delivery:'original-host',room_delivery:null,room_confirmation:null,host_release:null,room_release:null,host_released:false,room_released:true},visit)]),
            ...(mode==='pending-attempt'?[row('appointments.Attempt','pending',{state:'pending'},visit)]:[])]:[])
        ]}));
        let raced=false,employeeReads=0;
        const load=store.load.bind(store);
        store.load=async(model,id)=>{
          const row=await load(model,id);
          if(model==='employee.Employee'){
            employeeReads++;
            if(mode==='book-identity-read'&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}
          }
          return row;
        };
        if(mode==='book-host-at-commit'||mode==='book-link-at-commit'){
          const commit=store.commit.bind(store);
          store.commit=async batch=>{
            if(batch.writes.some(write=>write.kind==='insert'&&write.model==='appointments.Appointment')){
              raced=true;
              const model=asModel(mode==='book-host-at-commit'?'employee.Employee':'appointments.Calendar');
              const current=await load(model,asId(mode==='book-host-at-commit'?'host':'calendar'));assert.ok(current);
              const data=mode==='book-host-at-commit'?{...current.data,user:{id:current.data['user']&&JSON.stringify(current.data['user']).includes(actor.user_id)?'other-user':actor.user_id}}
                :{...current.data,host:{id:JSON.stringify(current.data['host']).includes('other-host')?'host':'other-host'}};
              await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model,id:current.id,expectedVersion:current.version,row:{...current,version:asVersion(current.version+1),data}}]}));
            }
            return commit(batch);
          };
        }
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
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now,
          ...(mode==='book-custom-id'?{allocateRecordId:(model:string,index:number)=>`custom:${model}:${index}`}:{})});
        const operation=movement?'appointments.reschedule':'appointments.book',operation_id=operationId(now);
        const inputs=movement?{visit:{id:'visit',version:'1'},from:'2099-01-01T10:00:00.000Z'}:{type:{id:'type',version:'1'},customer:{id:'customer',version:'1'},contact:{id:'contact',version:'1'},from:'2099-01-01T09:00:00.000Z'};
        const result=await invoker.invokeMutation({operation,operation_id,inputs},identity);
        const success=['book','book-room','book-custom-id','reschedule','reschedule-room'].includes(mode);
        assert.equal('result' in result,success,mode+': '+JSON.stringify(result));
        if(['first-read-race','contact-at-commit','identity-query-race','book-host-at-commit','book-link-at-commit','book-identity-read'].includes(mode))assert.equal(raced,true,mode+': the original authority or selected row changed');
        if(mode==='book-inactive-calendar')assert.equal(employeeReads,0,'false first operand avoids private host ancestry');
        const visits=await store.query({model:asModel('appointments.Appointment'),authority:'owner'});
        assert.equal(visits.filter(row=>row.data['source']===operation_id).length,!movement&&success?1:0,mode+': appointment remains atomic');
        if(mode==='book-custom-id')assert.equal(visits[0]?.id,'custom:appointments.Appointment:0');
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
            assert.deepEqual(roomArgs['value'],{source:operation_id,revision:'1',resource:'room-1',customer:'customer',account:{id:actor.user_id},from:movement?'2099-01-01T10:00:00.000Z':'2099-01-01T09:00:00.000Z',until:movement?'2099-01-01T10:30:00.000Z':'2099-01-01T09:30:00.000Z',quantity:'1',price:null,terms:null});
            if(movement){assert.equal(roomArgs['previous_source'],'original');assert.equal(roomArgs['previous_revision'],'5');}}
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

it('decides the original Purchase request against complete nested Money owner domains',
  {timeout:180000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-purchase-decision-'));
    try {
      const source=join(root,'compiler/tests/fixtures/purchase-decision-source-require.can');
      const authored=await readFile(join(root,'draft/apps/CanPurchase/CanPurchase.can'),'utf8');
      const start=authored.indexOf('  scenario decide('),end=authored.indexOf('   examples ',start);
      const text=await readFile(source,'utf8');
      assert.ok(text.includes(authored.slice(start,end)),'the whole original decision body is retained');
      for(const line of authored.split('\n').filter(line=>line.startsWith('  derive Budget.')||line.startsWith('  derive Request.authorized'))) {
        assert.ok(text.includes(line),'original aggregate helper is retained');
      }
      const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],
        {cwd:root,timeout:60000,maxBuffer:32*1024*1024});
      const artifact=JSON.parse(stdout) as CompileArtifact;
      const asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,
        stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
      for(const mode of ['allowed','rejected','too-much','hidden-increase','null-actual','foreign-budget','worker-inactive','worker-at-commit','domain-race'] as const) {
        const {now,identities,identity}=await member(`purchase-${mode}`,['purchase.approver']);
        const store=createMemoryStorage();
        const actor=identity.actor!.user_id;
        const other=await identities.createUser({email:`other-${mode}@purchase.test`,password_hash:'unused',email_verified:true});
        const location={...makeRow({id:asId('location'),data:{name:'Office'}}),parent:null};
        const budget={...makeRow({id:asId('budget'),data:{name:'hidden',total:{minor:'10000',currency:'EUR'},active:mode!=='rejected'}}),parent:null};
        const request={...makeRow({id:asId('request'),data:{reviewer:{id:actor},requester:{id:other.user_id},location:{id:location.id},
          amount:{minor:mode==='too-much'?'7000':'6000',currency:'EUR'},state:'submitted',decision:null,actual:null,hidden:false}}),
          parent:{model:model('purchase','Budget'),id:budget.id}};
        const approved={...request,id:asId('approved'),data:{...request.data,amount:{minor:'2000',currency:'EUR'},state:'approved',hidden:true}};
        const closed={...request,id:asId('closed'),data:{...request.data,amount:{minor:'1000',currency:'EUR'},state:'closed',
          actual:mode==='null-actual'?null:{minor:'1000',currency:'EUR'},hidden:true}};
        const employee={...makeRow({id:asId('worker'),data:{user:{id:actor},home:{id:location.id},active:mode!=='worker-inactive',hidden:true}}),parent:null};
        const writes:Array<{kind:'insert';model:ModelName;row:StoredRow}>=[
          {kind:'insert',model:model('purchase','Location'),row:location},
          {kind:'insert',model:model('purchase','Employee'),row:employee},
          {kind:'insert',model:model('purchase','Budget'),row:budget},
          {kind:'insert',model:model('purchase','Request'),row:request},
          {kind:'insert',model:model('purchase','Request'),row:approved},
          {kind:'insert',model:model('purchase','Request'),row:closed},
          {kind:'insert',model:model('purchase','Adjustment'),row:{...makeRow({id:asId('adjustment'),data:{amount:{minor:'500',currency:'EUR'},hidden:true}}),parent:{model:model('purchase','Budget'),id:budget.id}}},
        ];
        if(mode==='hidden-increase')writes.push({kind:'insert',model:model('purchase','Increase'),row:{...makeRow({id:asId('increase'),data:{amount:{minor:'1000',currency:'EUR'},hidden:true}}),parent:{model:model('purchase','Request'),id:approved.id}}});
        if(mode==='foreign-budget')writes.push(
          {kind:'insert',model:model('purchase','Budget'),row:{...budget,id:asId('foreign-budget')}},
          {kind:'insert',model:model('purchase','Request'),row:{...approved,id:asId('foreign-request'),data:{...approved.data,amount:{minor:'999999',currency:'EUR'}},parent:{model:model('purchase','Budget'),id:asId('foreign-budget')}}});
        await store.commit(makeBatch(await store.readRevision(),{writes}));
        let raced=false;
        if(mode==='domain-race'||mode==='worker-at-commit') {
          const commit=store.commit.bind(store);
          store.commit=async batch=>{
            if(!raced && batch.writes.some(write=>write.model===model('purchase','Request'))) {
              raced=true;
              if(mode==='worker-at-commit')await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:model('purchase','Employee'),
                id:employee.id,expectedVersion:employee.version,row:{...employee,version:asVersion(employee.version+1),data:{...employee.data,active:false}}}]}));
              else await commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:model('purchase','Adjustment'),
                row:{...makeRow({id:asId('race-adjustment'),data:{amount:{minor:'1000',currency:'EUR'},hidden:true}}),parent:{model:model('purchase','Budget'),id:budget.id}}}]}));
            }
            return commit(batch);
          };
        }
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const outcome=await invoker.invokeMutation({operation:'purchase.decide',operation_id:operationId(now),inputs:{
          request:{id:request.id,version:String(request.version)},approve:mode!=='rejected',reason:'Reviewed budget'}},identity);
        const success=['allowed','rejected','null-actual','foreign-budget'].includes(mode);
        assert.equal('result' in outcome && outcome.result.status==='committed',success,`${mode}: ${JSON.stringify(outcome)}`);
        assert.equal((await store.load(model('purchase','Request'),request.id))!.data.state,
          success?mode==='rejected'?'rejected':'approved':'submitted',`${mode}: atomic source decision`);
        if(mode==='domain-race'||mode==='worker-at-commit')assert.ok(raced,'actual final commit observed the current complete owner domain and eligibility');
      }
    } finally {await rm(directory,{recursive:true,force:true});}
  });

it('finalizes source-only declared EMIT with genuine references and ordinary replay privacy',
  {timeout:180000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-source-only-emit-'));
    try{
      const {artifact,asm}=await installed('native-source-require-emit.can',directory);
      for(const name of ['notify','abort'])assert.equal(artifact.operations?.find(op=>op.name===`SourceGuardEmit.${name}`)?.result?.disclosure,undefined);
      const original=await readFile(fixture('native-source-require-emit.can'),'utf8');
      const refused=fixture('.native-source-require-emit-refusal.can');
      try{
        for(const changed of [original.replaceAll('emit Checked {root,message}','emit Checked {root,message=root.secret}'),
          original.replaceAll('emit Checked {root,message}','let alias=root\n   emit Checked {root=alias,message}')]){
          await writeFile(refused,changed);
          const report=spawnSync(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,refused],{cwd:root,encoding:'utf8'});
          assert.equal(report.status,10,report.stdout+report.stderr);
          assert.ok((JSON.parse(report.stdout) as {diagnostics:{code:string}[]}).diagnostics.some(item=>item.code==='E6008'));
        }
      }finally{await rm(refused,{force:true});}
      for(const mode of ['allowed','full','inactive','other-parent','invariant-after-emit','identity-during-source-stage','root-at-commit','tampered-source','missing-inventory']){
        const {now,identities,identity,membership}=await member(`source-emit-${mode}`);
        const scope={app:'SourceGuardEmit',owner:membership.team_id,ownerPackage:'SourceGuardEmit'};
        const authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'source-emit-state',fileStoreId:'source-emit-files',
          receiver:{app:scope.app,owner:scope.owner,team:scope.owner}};
        const {store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
        if(mode!=='missing-inventory')await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,
          verifyOwner:async()=>{assert.ok(await identities.findTeamById(scope.owner));}});
        const rootModel=model('SourceGuardEmit','Root');
        const rootRow={...makeRow({id:asId('root-1'),data:{capacity:mode==='full'?'1':'2',checked:false,seen:false,secret:'Hidden field'}}),parent:null};
        await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:rootModel,row:rootRow},
          {kind:'insert',model:rootModel,row:{...rootRow,id:asId('root-2')}},
          {kind:'insert',model:model('SourceGuardEmit','Child'),row:{...makeRow({id:asId('child-1'),data:{active:mode!=='inactive'}}),
            parent:{model:rootModel,id:asId(mode==='other-parent'?'root-2':'root-1')}}}]}));
        let raced=false;
        if(mode==='identity-during-source-stage'){
          const inventory=store.readFileReferenceInventory.bind(store);
          store.readFileReferenceInventory=async owner=>{
            if(!raced){raced=true;await identities.removeMembership(membership.membership_id);}
            return inventory(owner);
          };
        }
        if(mode==='root-at-commit'){
          const commit=store.commit.bind(store);
          store.commit=async batch=>{
            if(!raced&&batch.writes.some(write=>write.model==='work.occurrence')){
              raced=true;
              await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:rootModel,id:rootRow.id,
                expectedVersion:asVersion(rootRow.version),row:{...rootRow,version:asVersion(rootRow.version+1),archivedAt:now}}]}));
            }
            return commit(batch);
          };
        }
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const request={operation:mode==='invariant-after-emit'?'SourceGuardEmit.abort':'SourceGuardEmit.notify',operation_id:operationId(now),
          inputs:{root:{id:rootRow.id,version:String(rootRow.version)},message:'Original event'}};
        const outcome=await invoker.invokeMutation(request,identity);
        const allowed=mode==='allowed'||mode==='tampered-source';
        assert.equal('result'in outcome&&outcome.result.status==='committed',allowed,`${mode}: ${JSON.stringify(outcome)}`);
        if(mode==='identity-during-source-stage')assert.equal('error'in outcome&&outcome.error.code,'forbidden');
        if(mode==='root-at-commit')assert.equal('error'in outcome&&outcome.error.code,'conflict');
        const sources=await store.query({model:asModel('work.occurrence'),authority:'owner'});
        assert.equal(sources.length,allowed?1:0,mode);
        const actual=await store.load(rootModel,rootRow.id);assert.ok(actual);assert.equal(actual.data.checked,allowed,mode);assert.equal(actual.data.seen,false);
        if(mode==='identity-during-source-stage'||mode==='root-at-commit')assert.equal(raced,true,mode);
        if(!allowed)continue;
        const source=sources[0]!,result=source.data['result'] as {context:{kind:string;operation:string};payload:unknown};
        assert.equal(result.context.kind,'user');assert.equal(result.context.operation,request.operation);
        assert.deepEqual(result.payload,{root:{id:rootRow.id,version:String(actual.version)},message:'Original event'});
        const saved=await store.readReceipt({app:'SourceGuardEmit',owner:membership.team_id,principal:membership.user_id,
          operation:request.operation,operationId:request.operation_id} as Parameters<typeof store.readReceipt>[0]);assert.ok(saved);
        assert.ok(saved.outcome.status==='committed');assert.equal(saved.outcome.scenario,undefined);
        const visible=await invoker.invokeRead({operation:'SourceGuardEmit.Root.read',inputs:{}},identity);
        assert.ok('error'in visible||((visible.result as {records:unknown[]}).records.length===0));
        const replay=await invoker.invokeMutation(request,identity);
        assert.ok('error'in replay&&replay.error.code==='validation',JSON.stringify(replay));
        assert.deepEqual(await store.query({model:asModel('work.occurrence'),authority:'owner'}),sources);
        const deliver=()=>invokeRetainedHandlerOccurrenceCanonical({asm,artifact,app:'SourceGuardEmit',store,identities,now:()=>now+1,
          selector:{scope:{app:'SourceGuardEmit',owner:membership.team_id,ownerPackage:'SourceGuardEmit'},event:'SourceGuardEmit.Checked',
            sourceOccurrence:source.id,handler:'SourceGuardEmit.observe'}});
        if(mode==='tampered-source'){
          await assert.rejects(async()=>store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:asModel('work.occurrence'),id:source.id,
            expectedVersion:source.version,row:{...source,version:asVersion(source.version+1),data:{...source.data,result:{...result,payload:{root:{id:'root-2',version:'1'},message:'Original event'}}}}}]})));
          assert.deepEqual(await store.load(asModel('work.occurrence'),source.id),source,'owning opaque resolver rejects substituted event references');
          assert.equal((await store.load(rootModel,rootRow.id))?.data.seen,false);
        }
        assert.equal((await deliver() as {status:string}).status,'completed');
        assert.equal((await deliver() as {status:string}).status,'replayed');
        assert.equal((await store.load(rootModel,rootRow.id))?.data.seen,true);
        assert.deepEqual(await store.readReceipt(saved.identity),saved,'consumer never rewrites the ordinary source receipt');
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });

it('intakes the original Purchase File against an exact hidden unique-key owner census',
  {timeout:180000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-purchase-intake-'));
    try {
      const source=join(root,'compiler/tests/fixtures/purchase-intake-source-require.can');
      const authored=await readFile(join(root,'draft/apps/CanPurchase/CanPurchase.can'),'utf8');
      const start=authored.indexOf('  scenario intake_invoice('),end=authored.indexOf('   examples ',start);
      assert.ok((await readFile(source,'utf8')).includes(authored.slice(start,end)),'the original complete File intake body is retained');
      const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],
        {cwd:root,timeout:60000,maxBuffer:32*1024*1024});
      const artifact=JSON.parse(stdout) as CompileArtifact;
      const asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,
        stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
      for(const mode of ['allowed','duplicate-other-parent','concurrent-duplicate','inactive-worker','draft-request','foreign-file','forged-file','revoked-buyer'] as const) {
        const {now,identities,identity,team,user,membership}=await member(`intake-${mode}`,['purchase.buyer']);
        const scope={app:'PurchaseDecision',owner:team.team_id,ownerPackage:'purchase'};
        const authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'purchase-state',fileStoreId:'purchase-files',
          receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
        const {store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,
          verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
        const row=(id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({...makeRow({id:asId(id),data}),parent});
        const location=row('location',{name:'Office'}),budget=row('budget',{name:'Main',total:{minor:'10000',currency:'EUR'},active:true});
        const request=row('request',{reviewer:{id:user.user_id},requester:{id:user.user_id},location:{id:location.id},amount:{minor:'100',currency:'EUR'},
          state:mode==='draft-request'?'draft':'approved',decision:null,actual:null,hidden:false},{model:model('purchase','Budget'),id:budget.id});
        const order=row('order',{location:{id:location.id}},{model:model('purchase','Request'),id:request.id});
        const otherRequest={...request,id:asId('other-request')};
        const other=row('other-order',{location:{id:location.id}},{model:model('purchase','Request'),id:otherRequest.id});
        await store.commit(makeBatch(await store.readRevision(),{writes:[
          {kind:'insert',model:model('purchase','Location'),row:location},{kind:'insert',model:model('purchase','Budget'),row:budget},
          {kind:'insert',model:model('purchase','Request'),row:request},{kind:'insert',model:model('purchase','Order'),row:order},
          {kind:'insert',model:model('purchase','Order'),row:other},{kind:'insert',model:model('purchase','Request'),row:otherRequest},
          {kind:'insert',model:model('purchase','Employee'),row:row('worker',{user:{id:user.user_id},home:{id:location.id},active:mode!=='inactive-worker',hidden:true})},
        ]}));
        const clock=new TestOnlyManualClock(now),blobs=new TestOnlyMemoryBlobStore(),files=new TestOnlyMemoryFinalizedStore(),intents=new TestOnlyMemoryIntentStore();
        const physical={clock,blobs,files,upload:{clock,intents,blobs,policy:DEFAULT_FILE_POLICY,intentIds:new TestOnlyCounterIntentIds(),intentTtlMs:3600000,urlBase:'https://purchase.test'},
          finalize:{clock,intents,blobs,files,fileIds:new TestOnlyCounterFileIds()}};
        const retention={unattachedHorizonMs:3600000,retentionMs:86400000},observation={policy:physical.upload.policy,retention};
        const kernel=createFileJourneyKernel({maxBytes:physical.upload.policy.maxBytes,
          createIntent:input=>createUploadIntent(physical.upload,input),append:(id,caller,bytes,offset)=>appendUploadContentAtOffset(physical.upload,id,caller,bytes,offset),
          complete:(id,caller)=>completeUploadContent(physical.upload,id,caller),finalize:input=>finalizeUpload(physical.finalize,input),
          authorizeAttach:(ref,caller)=>authorizeAttach(physical.finalize,ref,caller),readProvenance:(ref,caller)=>readFinalizedFile(physical.finalize,ref,caller),
          recordAttachment:(ref,record,caller)=>recordAttachment(physical.finalize,ref,record,caller),readBytes:(ref,caller)=>readFinalizedBytes(physical.finalize,ref,caller),
          readCurrentBytes:(ref,caller,policy)=>readCurrentFinalizedBytes(physical.finalize,ref,caller,{...observation,retention:policy}),
          readCurrentSnapshot:(ref,caller,policy)=>readCurrentFinalizedSnapshot(physical.finalize,ref,caller,{...observation,retention:policy}),
          observeFile:(ref,caller,policy)=>observeFinalizedFile(physical.finalize,ref,caller,{...observation,retention:policy}),
          revalidateFile:(saved,caller,policy)=>revalidateRetainedFinalizedFile(physical.finalize,saved,caller,{...observation,retention:policy}),
        } satisfies FileJourneyBindings);
        const upload=(name:string,foreign=false)=>{
          const receiver={app:scope.app,owner:team.team_id,team:team.team_id,principal:foreign?'foreign-principal':user.user_id};
          const bytes=new TextEncoder().encode('Original invoice document');
          const created=createUploadIntent(physical.upload,{receiver,binding:{adapter:'deployment.web',deliveryId:name,resultPath:'document'},
            request:{upload_id:name,operation:'purchase.intake_invoice',field:'/document',arguments:{},name:'invoice.txt',type:'text/plain',size:String(bytes.length)}});
          assert.equal(created.status,'granted');assert.ok(created.status==='granted');
          assert.equal(appendUploadContentAtOffset(physical.upload,created.intentId,receiver,bytes,0).status,'appended');
          assert.equal(completeUploadContent(physical.upload,created.intentId,receiver).status,'completed');
          const finalized=finalizeUpload(physical.finalize,{intentId:created.intentId,retryId:name,bytesDigest:sha256Hex(bytes),caller:receiver});
          assert.equal(finalized.status,'finalized');assert.ok(finalized.status==='finalized');return {id:finalized.result.file};
        };
        const document=mode==='forged-file'?{id:'unissued-file'}:upload('tested',mode==='foreign-file');
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now,files:createCanonicalFileBinding(kernel,retention)});
        const invoke=(target:typeof order,file:{id:string})=>invoker.invokeMutation({operation:'purchase.intake_invoice',operation_id:operationId(now),
          inputs:{order:{id:target.id,version:String(target.version)},document:file,source:'  invoice-42  '}},identity);
        let raced=false;
        if(mode==='duplicate-other-parent') {
          const seeded=await invoke(other,upload('existing'));assert.ok('result' in seeded&&seeded.result.status==='committed',JSON.stringify(seeded));
          await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:model('purchase','Request'),id:otherRequest.id,expectedVersion:otherRequest.version,
            row:{...otherRequest,version:asVersion(otherRequest.version+1),data:{...otherRequest.data,state:'draft'}}}]}));
          const visible=await invoker.invokeRead({operation:'purchase.InvoiceDocument.read',inputs:{}},identity);
          assert.ok('result' in visible&&((visible.result as {records:unknown[]}).records.length===0),'ordinary row reads remain hidden');
        }
        if(mode==='concurrent-duplicate') {
          const competing=upload('competing'),commit=store.commit.bind(store);
          store.commit=async batch=>{
            if(!raced&&batch.writes.some(write=>write.model===model('purchase','InvoiceDocument'))) {
              raced=true;const result=await invoke(other,competing);assert.ok('result' in result&&result.result.status==='committed',JSON.stringify(result));
            }
            return commit(batch);
          };
        }
        if(mode==='revoked-buyer')await identities.setMembershipRoles(membership.membership_id,[]);
        const outcome=await invoke(order,document),success=mode==='allowed';
        assert.equal('result' in outcome&&outcome.result.status==='committed',success,`${mode}: ${JSON.stringify(outcome)}`);
        const records=await store.query({model:model('purchase','InvoiceDocument'),authority:'owner'});
        assert.equal(records.length,success||mode==='duplicate-other-parent'||mode==='concurrent-duplicate'?1:0,mode);
        if(success){assert.equal(records[0]!.parent?.id,order.id);assert.equal(records[0]!.data.source,'invoice-42');assert.deepEqual(records[0]!.data.document,document);}
        if(mode==='concurrent-duplicate')assert.ok(raced,'the real competing CREATE invalidated the original complete owner census');
        if(mode!=='forged-file')assert.equal(files.get(document.id)?.state,success?'attached':'finalized',`${mode}: refusal never attaches File or partially creates a row`);
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });
