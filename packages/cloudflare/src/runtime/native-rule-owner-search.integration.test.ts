import { workSchedulePutCommand, workScheduleCancelCommand } from '@canlang/work/kernel/schedule-staging';
/** Compiled mutation decisions observe bounded owner rows without widening reads. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { promisify } from 'node:util';
import type { CompileArtifact, FileRetirementAuthority, ModelName, StoredRow, Receipt, ScenarioReceiptAssociation, ArtifactOperationInput } from '@canlang/contracts';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { createMemoryStorage, createTestMemoryStorage } from '@canlang/state/storage/memory';
import { asId, asModel, asVersion, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';
import { hashInputs } from '@canlang/state/invocation/replay';
import { buildInvoker } from '../worker/assembly.js';
import { assembleModules } from './modules.js';

import { invokeDueScheduleCanonical, invokeRetainedHandlerOccurrenceCanonical, loadCanonicalDescriptors } from './invoke.js';
import { STATE_FILE_REFERENCE_PRODUCER } from '@canlang/state/storage';
import { checkScenarioReceiptMembershipSites } from '@canlang/state/invocation';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work/kernel/file-reference-inventory';
import { installNativeFileInventory } from './file-inventory.js';
import { loadOpaqueFileStaging } from './opaque-file-staging.js';

import { createCanonicalFileBinding } from './bound-files.js';
import { createFileJourneyKernel, type FileJourneyBindings } from '@canlang/interfaces/uploads/kernel';
import { createUploadIntent, appendUploadContentAtOffset, completeUploadContent, sha256Hex, DEFAULT_FILE_POLICY } from '@canlang/files/upload';
import { authorizeAttach, blobKeyForFile, finalizeUpload, observeFinalizedFile, readCurrentFinalizedBytes,
  readCurrentFinalizedSnapshot, readFinalizedBytes, readFinalizedFile, recordAttachment,
  revalidateRetainedFinalizedFile } from '@canlang/files/finalize';
import { TestOnlyManualClock, TestOnlyCounterIntentIds, TestOnlyCounterFileIds,
  TestOnlyMemoryIntentStore, TestOnlyMemoryBlobStore, TestOnlyMemoryFinalizedStore } from '@canlang/files/ports';

/** Check the exact sealed return profile, including independently gated DATA sites. */
function assertSourceOnlyReceipt(artifact: CompileArtifact, operation: string, type = 'date',
  dependencies: ReadonlyArray<ReadonlyArray<readonly [string, string, 'data' | 'control', string]>> = [[]]): void {
  const descriptor = artifact.operations?.find(item => item.name === operation);
  assert.equal(descriptor?.result?.type, type);
  const plan = descriptor?.result?.disclosure; assert.ok(plan, operation);
  assert.deepEqual(Object.keys(plan).sort(), ['returns', 'source', 'version']);
  assert.equal(plan.version, 1);
  const callable = artifact.callables.find(item => item.id === operation); assert.ok(callable);
  assert.equal(plan.source.module, callable.module);
  assert.ok(artifact.sources.some(source => source.path === plan.source.path && source.sha256 === plan.source.sha256));
  assert.equal(plan.returns.length, dependencies.length);
  for (const [index, returned] of plan.returns.entries()) {
    assert.deepEqual(Object.keys(returned).sort(), ['dependencies', 'id', 'influences', ...(returned.intrinsics === undefined ? [] : ['intrinsics']), 'source']);
    for (const site of returned.intrinsics ?? []) {
      assert.match(site.id, /^[a-f0-9]{64}$/); assert.deepEqual(site.source, plan.source);
      assert.ok(site.role === 'data' || site.role === 'control');
      if (site.kind === 'operation-id') assert.equal(site.type, 'text');
      else if(site.kind==='created-model-version'){assert.equal(site.type,'int');assert.match(site.created.id,/^[a-f0-9]{64}$/);assert.ok(site.created.stage>=0);}
      else {
        const input: ArtifactOperationInput | undefined = descriptor!.inputs.fields.find(declaredInput => declaredInput.name === site.parameter); assert.ok(input);
        if (site.kind === 'admitted-reference-version') { assert.equal(input.field.kind, 'ref'); assert.equal(site.model, input.field.kind === 'ref' ? input.field.model : undefined); assert.equal(site.type, 'int'); }
        else assert.equal(site.kind, 'admitted-input');
      }
    }
    assert.match(returned.id, /^[a-f0-9]{64}$/);
    assert.deepEqual(returned.source, plan.source);
    assert.deepEqual(returned.influences, []);
    assert.deepEqual(returned.dependencies.map(site => [site.model, site.field, site.role, site.type]), dependencies[index]);
    for (const site of returned.dependencies) {
      assert.deepEqual(Object.keys(site).sort(), ['field', 'id', 'model', 'role', 'source', 'type']);
      assert.match(site.id, /^[a-f0-9]{64}$/);
      assert.deepEqual(site.source, plan.source);
    }
  }
}

function assertSavedSourceReceipt(artifact: CompileArtifact, saved: Receipt): void {
  assert.equal(saved.outcome.status, 'committed');
  assert.ok(saved.outcome.status === 'committed' && saved.outcome.scenario);
  const association: ScenarioReceiptAssociation = saved.outcome.scenario;
  const declared = artifact.operations?.find(operation => operation.name === saved.identity.operation)?.result;
  assert.ok(declared?.disclosure);
  assert.equal(association.kind, 'scenario-result/v1');
  assert.equal(association.resultType, declared.type);
  assert.deepEqual(association.plan, declared.disclosure);
  assert.ok(declared.disclosure.returns.some(returned => returned.id === association.returnId));
}
type MutationOutcome = Awaited<ReturnType<ReturnType<typeof buildInvoker>['invokeMutation']>>;
function assertDateReplay(outcome: MutationOutcome, expected: string, fields: readonly string[] = []): void {
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.status, 'replayed'); assert.equal(outcome.result.result, expected);
  if (fields.length === 0) assert.deepEqual(outcome.result.records, []);
  else {
    assert.ok((outcome.result.records?.length ?? 0)>0);
    for (const record of outcome.result.records ?? []) {
    assert.ok(record !== null && typeof record === 'object' && 'data' in record);
    assert.ok(record.data !== null && typeof record.data === 'object' && !Array.isArray(record.data));
    assert.deepEqual(Object.keys(record.data).sort(),[...fields].sort());
    }
  }
  assert.ok(!JSON.stringify(outcome).includes('Hidden source'));
}

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
async function member(mode: string, roles: readonly string[] = [], emailVerified = true, at = Date.now()) {
  const now = at, identities = createMemoryIdentityStore({ clock: createFrozenClock(now) });
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


it('runs source-only guard frames with sealed zero-DATA result receipts',
  { timeout: 120000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-source-only-frame-'));
    try {
      const source = join(directory,'phase-prefix.can');
      const original=await readFile(join(root,'compiler/tests/fixtures/native-require-missing-owner-frame.can'),'utf8');
      await writeFile(source,original.replace('Given\n','Given\n contract Selected {active:bool}\n StagedSettlement in Root {amount:money,visible:bool=true}\n StagedAllocation in StagedSettlement {amount:money}\n StagedCredit in Root {amount:money,total:money}\n policy StagedCredit read=members\n policy StagedSettlement read=members where=row.visible\n policy StagedAllocation read=members\n').replace('Child in Root {active:bool=true}','Child in Root {active:bool=true,marked:bool=false}').replace('Then\n',' scenario staged(root:Root) by=members\n  do\n   let probe_values=Child as child select child.active\n   let original=root.capacity\n   require count(probe_values)>0\n   set root {checked=true,capacity=root.capacity+1}\n   for child in root.Child limit=10\n    set child {marked=true}\n   require root.checked and root.capacity>original and allowed(root)\n   if root.checked and allowed(root)\n    set root {capacity=root.capacity+1}\n scenario query_value(root:Root) by=members\n  require root.capacity>0\n  do\n   let values=root.Child as child select Selected {active=child.active}\n   require count(values)>0 and all(values as selected,selected.active)\n   let first_value=at(values,0)\n   require first_value!=null\n   set root {checked=true}\n scenario loop_values(root:Root,amount:money) by=members\n  require root.capacity>0 and amount.minor>0\n  do\n   create StagedSettlement {parent=root,amount,visible=true} as settlement\n   for credit in root.StagedCredit limit=10\n    set credit {total=amount}\n    let running=sum(root.StagedCredit as entry select entry.total,amount.currency)\n    set credit {total=running}\n scenario staged_values(root:Root,other:Root,amount:money) by=members\n  require root.capacity>0 and amount.minor>0\n  do\n   create StagedSettlement {parent=root,amount,visible=true} as settlement\n   let staged_total=sum(root.StagedSettlement as entry select entry.amount,amount.currency)\n   let no_allocations=sum(settlement.StagedAllocation as entry select entry.amount,amount.currency)\n   require staged_total==amount and no_allocations==money(0,amount.currency)\n scenario created(root:Root) by=members\n  do\n   create Child {parent=root,active=true,marked=false} as child\n   require root.capacity>0 and allowed(root)\n   for item in root.Child limit=10\n    set item {marked=true}\nThen\n'));
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      assertSourceOnlyReceipt(artifact, 'GuardOwnerFrame.run');
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
        stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
      const deniedSource=join(directory,'withheld-capture.can');
      await writeFile(deniedSource,(await readFile(source,'utf8')).replace('policy Root read=members','policy Root read=members fields=checked'));
      const deniedCompile=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,deniedSource],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
      const deniedArtifact=JSON.parse(deniedCompile.stdout)as CompileArtifact;
      const deniedAsm=await assembleModules({artifact:deniedArtifact,sourcePath:deniedSource},{workDir:join(directory,'withheld'),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
      const queryVariants=new Map<string,{artifact:CompileArtifact;asm:typeof asm}>();
      for(const [mode,policy] of [['stage-hidden-query','policy Child read=members where=row.marked'],['stage-withheld-query','policy Child read=members fields=marked']] as const){
        const variant=join(directory,mode+'.can');await writeFile(variant,(await readFile(source,'utf8')).replace('policy Child read=members',policy));
        const result=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,variant],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
        const artifact=JSON.parse(result.stdout)as CompileArtifact;
        const assembly=await assembleModules({artifact,sourcePath:variant},{workDir:join(directory,mode),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
        queryVariants.set(mode,{artifact,asm:assembly});
      }
      {
        const callable=artifact.callables.find(callable=>callable.id==='GuardOwnerFrame.loop_values');assert.ok(callable);
        const module=await import(asm.moduleUrls[callable.module]!);
        const values=module.canScenarioQueryValueSources()as Record<string,Parameters<typeof state.bindScenarioSourceQueryValueProducer>[1]['sites']>;
        const running=values[callable.id]?.find(site=>site.binding==='running');assert.ok(running?.loop,'actual compiled LET uses the independently bound active-item Values producer');
        assert.equal(running.stage,1);assert.equal(running.loop.before,1);assert.deepEqual(running.loop.fields,[['total'],['total']]);
        const loops=module.canScenarioBodyLoopSources()as Record<string,Parameters<typeof state.bindScenarioSourceLoopProducer>[1]>;
        assert.equal(loops[callable.id]?.loops[0]?.id,running.loop.id,'Values phase uses the genuine original selected-item source');
        const unqualified=join(directory,'loop-model-result.can');
        const modelSource=(await readFile(source,'utf8')).replace('scenario loop_values(root:Root,amount:money) by=members','scenario loop_values(root:Root,amount:money) by=members -> StagedSettlement').replace('    set credit {total=running}\n scenario staged_values','    set credit {total=running}\n   return settlement\n scenario staged_values');
        await writeFile(unqualified,modelSource);
        let diagnostics:readonly {readonly code:string}[]=[];
        try{const result=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,unqualified],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});diagnostics=(JSON.parse(result.stdout)as {diagnostics:readonly {code:string}[]}).diagnostics;}catch(error){diagnostics=(JSON.parse((error as {stdout:string}).stdout)as {diagnostics:readonly {code:string}[]}).diagnostics;}
        assert.ok(diagnostics.some(diagnostic=>diagnostic.code==='E6008'),'source-only active phase grants no complete native Model result association');
      }
      const loopVariants=new Map<string,{artifact:CompileArtifact;asm:typeof asm}>();
      {
        const path=join(directory,'loop-withheld.can');await writeFile(path,(await readFile(source,'utf8')).replace('policy StagedCredit read=members','policy StagedCredit read=members fields=amount'));
        const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,path],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
        const checked=JSON.parse(stdout)as CompileArtifact;
        loopVariants.set('withheld',{artifact:checked,asm:await assembleModules({artifact:checked,sourcePath:path},{workDir:join(directory,'loop-withheld'),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')})});
      }
      for(const mode of ['wrong-item-prefix','wrong-item-fields']){
        const forged=JSON.parse(JSON.stringify(artifact))as CompileArtifact;let changed=0;
        const alter=(value:unknown):void=>{
          if(typeof value!=='object'||value===null)return;
          const object=value as Record<string,unknown>;
          if(object.owner==='GuardOwnerFrame.loop_values'&&object.binding==='running'&&typeof object.loop==='object'&&object.loop!==null){
            const loop=object.loop as {before:number;fields:string[][]};
            if(mode==='wrong-item-prefix')loop.before=0;else loop.fields[0]=['amount'];changed++;
          }
          for(const child of Object.values(object))alter(child);
        };
        for(const module of forged.modules)module.js=module.js.replace(/"(?:[^"\\]|\\.)*"/g,literal=>{
          try{const text=JSON.parse(literal);if(typeof text!=='string')return literal;const value=JSON.parse(text),before=changed;alter(value);return before===changed?literal:JSON.stringify(JSON.stringify(value));}catch{return literal;}
        });
        assert.ok(changed>0,mode+': alters actual source-issued item prefix metadata');
        loopVariants.set(mode,{artifact:forged,asm:await assembleModules({artifact:forged,sourcePath:source},{workDir:join(directory,mode),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')})});
      }
      for(const mode of ['allowed','withheld','identity-during-query','wrong-item-prefix','wrong-item-fields']){
        const {now,identities,identity,membership}=await member('active-loop-values-'+mode),store=createMemoryStorage();
        const rootModel=model('GuardOwnerFrame','Root'),creditModel=model('GuardOwnerFrame','StagedCredit');
        const parent={...makeRow({id:asId('root'),data:{capacity:'2',checked:false}}),parent:null};
        const credits=['credit-a','credit-b'].map(id=>({...makeRow({id:asId(id),data:{amount:{minor:'7',currency:'EUR'},total:{minor:'0',currency:'EUR'}}}),parent:{model:rootModel,id:parent.id}}));
        await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:rootModel,row:parent},...credits.map(row=>({kind:'insert' as const,model:creditModel,row}))]}));
        const query=store.query.bind(store);let reads=0,raced=false;
        store.query=async spec=>{if(spec.model===creditModel&&++reads===2&&mode==='identity-during-query'){raced=true;await identities.removeMembership(membership.membership_id);}return query(spec);};
        const variant=loopVariants.get(mode),invoke=buildInvoker(variant?.artifact??artifact,variant?.asm??asm,store,{memberships:identities,now:()=>now});
        const request={operation:'GuardOwnerFrame.loop_values',operation_id:operationId(now),inputs:{root:{id:'root',version:'1'},amount:{minor:'7',currency:'EUR'}}};
        const result=await invoke.invokeMutation(request,identity);
        assert.equal('result'in result,mode==='allowed',mode+': '+JSON.stringify(result));
        if(mode==='identity-during-query'){assert.equal(raced,true);assert.ok('error'in result);assert.equal(result.error.code,'forbidden');}
        if(mode==='wrong-item-prefix'||mode==='wrong-item-fields'){assert.ok('error'in result);assert.equal(result.error.code,'validation');assert.match(result.error.message,/actual item mutation|original selected-item write/);}
        const actual=await query({model:creditModel,authority:'owner',order:[{field:'id',direction:'asc'}]});
        if(mode==='allowed'){
          assert.deepEqual(actual.map(row=>row.data.total),[{minor:'7',currency:'EUR'},{minor:'14',currency:'EUR'}],'each original LET sees prior completed item writes and its own current SET');
          const replay=await invoke.invokeMutation(request,identity);assert.ok('result'in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');assert.deepEqual(await query({model:creditModel,authority:'owner',order:[{field:'id',direction:'asc'}]}),actual);
        }else assert.deepEqual(actual,credits,'failed item phase or current DATA/Identity denial rolls back all earlier item writes');
        assert.equal((await store.query({model:model('GuardOwnerFrame','StagedSettlement'),authority:'owner'})).length,mode==='allowed'?1:0);assert.deepEqual(await store.outboxPending(),[]);
      }
      const stagedVariants=new Map<string,{artifact:CompileArtifact;asm:typeof asm}>();
      for(const [mode,policy] of [['withheld','policy StagedSettlement read=members fields=visible where=row.visible'],['hidden','policy StagedSettlement read=members where=not row.visible']] as const){
        const path=join(directory,`staged-${mode}.can`);await writeFile(path,(await readFile(source,'utf8')).replace('policy StagedSettlement read=members where=row.visible',policy));
        const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,path],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
        const checked=JSON.parse(stdout)as CompileArtifact;
        stagedVariants.set(mode,{artifact:checked,asm:await assembleModules({artifact:checked,sourcePath:path},{workDir:join(directory,`staged-${mode}`),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')})});
      }
      for(const mode of ['wrong-created-parent','stale-phase','missing-prefix','unissued-callback']){
        const forged=JSON.parse(JSON.stringify(artifact))as CompileArtifact;let changed=0;
        const alter=(value:unknown):void=>{
          if(value===null||typeof value!=='object')return;
          const object=value as Record<string,unknown>;
          if(object.owner==='GuardOwnerFrame.staged_values'&&object.binding==='staged_total'&&Array.isArray(object.mutationPrefix)){
            if(mode==='stale-phase'){object.stage=2;changed++;}
            if(mode==='missing-prefix'){delete object.mutationPrefix;changed++;}
          }
          const parent=object.parent as {created?:{parentParameter:string}}|undefined;
          if(mode==='wrong-created-parent'&&parent?.created!==undefined){parent.created.parentParameter='other';changed++;}
          for(const child of Object.values(object))alter(child);
        };
        for(const module of forged.modules){
          if(mode==='unissued-callback'){
            const before='function $can$query$value$issue(source,context,body,captures){';
            if(module.js.includes(before)){module.js=module.js.replace(before,before+'if(JSON.parse(source).owner===\"GuardOwnerFrame.staged_values\")return async()=>body();');changed++;}
          }else module.js=module.js.replace(/"(?:[^"\\]|\\.)*"/g,literal=>{
            try{const text=JSON.parse(literal);if(typeof text!=='string')return literal;const value=JSON.parse(text),before=changed;alter(value);return before===changed?literal:JSON.stringify(JSON.stringify(value));}catch{return literal;}
          });
        }
        assert.ok(changed>0,mode+': mutates actual staged source metadata or callback');
        stagedVariants.set(mode,{artifact:forged,asm:await assembleModules({artifact:forged,sourcePath:source},{workDir:join(directory,`staged-${mode}`),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')})});
      }
      for(const mode of ['allowed','withheld','hidden','identity-during-query','domain-at-commit','wrong-created-parent','stale-phase','missing-prefix','unissued-callback']){
        const {now,identities,identity,membership}=await member(`staged-values-${mode}`),store=createMemoryStorage();
        const rootModel=model('GuardOwnerFrame','Root'),settlementModel=model('GuardOwnerFrame','StagedSettlement');
        const parent={...makeRow({id:asId('root'),data:{capacity:'2',checked:false}}),parent:null};
        await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:rootModel,row:parent},{kind:'insert',model:rootModel,row:{...parent,id:asId('other')}}]}));
        const commit=store.commit.bind(store),query=store.query.bind(store);let raced=false;
        store.query=async spec=>{
          if(mode==='identity-during-query'&&!raced&&spec.model===settlementModel){raced=true;await identities.removeMembership(membership.membership_id);}
          return query(spec);
        };
        store.commit=async batch=>{
          if(!raced&&mode.endsWith('-at-commit')&&batch.writes.some(write=>write.kind==='insert'&&write.model===settlementModel)){
            raced=true;
            await commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:settlementModel,row:{...makeRow({id:asId('concurrent'),data:{amount:{minor:'1',currency:'EUR'},visible:true}}),parent:{model:rootModel,id:parent.id}}}]}));
          }
          return commit(batch);
        };
        const selected=stagedVariants.get(mode);
        const request={operation:'GuardOwnerFrame.staged_values',operation_id:operationId(now),inputs:{root:{id:'root',version:'1'},other:{id:'other',version:'1'},amount:{minor:'7',currency:'EUR'}}};
        let result:MutationOutcome|undefined,rejected:unknown;
        try{result=await buildInvoker(selected?.artifact??artifact,selected?.asm??asm,store,{memberships:identities,now:()=>now}).invokeMutation(request,identity);}catch(error){rejected=error;}
        if(['wrong-created-parent','stale-phase','missing-prefix','unissued-callback'].includes(mode)){
          if(rejected!==undefined)assert.match(String(rejected),/original|phase|created|parent|shape|invocation/i,mode);
          else{assert.ok(result!==undefined&&'error'in result,mode);assert.equal(result.error.code,mode==='unissued-callback'?'rule_failed':'validation',mode+': '+JSON.stringify(result));if(mode==='unissued-callback')assert.match(result.error.message,/plain owning metadata/);}
        }else{assert.equal(rejected,undefined,String(rejected));assert.ok(result!==undefined);if(mode==='identity-during-query'||mode.endsWith('-at-commit'))assert.equal(raced,true,mode+': actual race hook reached');assert.equal('result'in result,mode==='allowed',`${mode}: ${JSON.stringify(result)}`);}
        const actual=await store.query({model:settlementModel,authority:'owner'});
        assert.equal(actual.length,mode==='allowed'||mode==='domain-at-commit'?1:0,mode+': staged query denial rolls back its original CREATE');
        if(mode==='allowed'){
          assert.deepEqual(actual[0]!.data,{amount:{minor:'7',currency:'EUR'},visible:true});
          assert.deepEqual(actual[0]!.parent,{model:rootModel,id:parent.id});
          const replay=await buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now}).invokeMutation(request,identity);assert.ok('result'in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');
          assert.ok(result!==undefined&&'result'in result);assert.deepEqual(replay.result.result,result.result.result);
          assert.deepEqual(await store.query({model:settlementModel,authority:'owner'}),actual);
        }else if(mode==='domain-at-commit')assert.equal(actual[0]!.id,'concurrent','only the independent physical race remains');
        assert.deepEqual(await store.load(rootModel,parent.id),parent);assert.deepEqual(await store.outboxPending(),[]);
        assert.deepEqual(await store.query({model:model('GuardOwnerFrame','StagedAllocation'),authority:'owner'}),[]);
      }
      for (const mode of ['allowed', 'full', 'inactive', 'other-parent', 'capacity-at-commit', 'membership-during-query','stage-allowed','stage-capacity-at-commit','stage-membership-during-query','stage-withheld-capture','stage-hidden-query','stage-withheld-query']) {
        const { now, identities, identity, membership } = await member(`source-only-${mode}`);
        const store = createMemoryStorage(), rootModel = model('GuardOwnerFrame', 'Root');
        const rootRow = { ...makeRow({ id: asId('root-1'), data: { capacity: mode === 'full' ? '1' : '2', checked: false } }), parent: null };
        const writes: Array<{ kind: 'insert'; model: ModelName; row: StoredRow }> = [
          { kind: 'insert', model: rootModel, row: rootRow },
          { kind: 'insert', model: rootModel, row: { ...rootRow, id: asId('root-2') } },
          { kind: 'insert', model: model('GuardOwnerFrame', 'Child'), row: {
            ...makeRow({ id: asId('child-1'), data: { active: mode !== 'inactive',marked:false } }),
            parent: { model: rootModel, id: asId(mode === 'other-parent' ? 'root-2' : 'root-1') },
          } },
        ];
        await store.commit(makeBatch(await store.readRevision(), { writes }));
        let changed = false;
        if (mode.endsWith('membership-during-query')) {
          const query = store.query.bind(store);
          store.query = async spec => {
            if (!changed && spec.model === model('GuardOwnerFrame', 'Child')) {
              changed = true;
              await identities.removeMembership(membership.membership_id);
            }
            return query(spec);
          };
        }
        if (mode.endsWith('capacity-at-commit')) {
          const commit = store.commit.bind(store);
          store.commit = async batch => {
            if (!changed) {
              changed = true;
              if (mode.endsWith('capacity-at-commit')) await commit(makeBatch(await store.readRevision(), { writes: [
                { kind: 'update', model: rootModel, id: rootRow.id, expectedVersion: asVersion(rootRow.version),
                  row: { ...rootRow, version: asVersion(rootRow.version + 1), data: { ...rootRow.data, capacity: '0' } } },
              ] }));
            }
            return commit(batch);
          };
        }
        const selected=queryVariants.get(mode)??(mode==='stage-withheld-capture'?{artifact:deniedArtifact,asm:deniedAsm}:{artifact,asm});
        const invoker = buildInvoker(selected.artifact,selected.asm, store, { memberships: identities, now: () => now });
        const request = { operation:mode.startsWith('stage-')?'GuardOwnerFrame.staged':'GuardOwnerFrame.run', operation_id: operationId(now),
          inputs: { root: { id: rootRow.id, version: String(rootRow.version) } } };
        const outcome = await invoker.invokeMutation(request, identity);
        assert.equal('result' in outcome ? outcome.result.status : outcome.error.code,
          mode.endsWith('allowed') ? 'committed' : mode.endsWith('capacity-at-commit') ? 'conflict' : mode.endsWith('membership-during-query')||mode==='stage-withheld-capture'||mode==='stage-withheld-query' ? 'forbidden' : 'rule_failed',
          `${mode}: ${JSON.stringify(outcome)}`);
        assert.equal((await store.load(rootModel, rootRow.id))?.data.checked, mode.endsWith('allowed'));
        if(mode==='stage-allowed')assert.equal((await store.load(rootModel,rootRow.id))?.data.capacity,'4','phase IF reads the actual post-SET checked value');
        if(mode.startsWith('stage-')&&mode!=='stage-allowed')assert.equal((await store.load(rootModel,rootRow.id))?.data.checked,false,'phase/race refusal rolls back the preceding genuine SET');
        if (mode.endsWith('allowed')) {
          assert.equal('result' in outcome && outcome.result.result, mode==='stage-allowed'?null:new Date(now + 86400000).toISOString().slice(0, 10));
          const replay = await invoker.invokeMutation(request, identity);
          if(mode==='stage-allowed'){assert.ok('result'in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');assert.equal(replay.result.result,null);assert.deepEqual(replay.result.records,[]);}
          else assertDateReplay(replay, new Date(now + 86400000).toISOString().slice(0, 10), ['capacity', 'checked']);
          const rows = await store.query({model: rootModel, authority: 'owner'});
          await identities.removeMembership(membership.membership_id);
          const denied = await invoker.invokeMutation(request, identity);
          assert.ok('result' in denied, JSON.stringify(denied)); assert.equal(denied.result.status,'replayed'); assert.equal(denied.result.result,null); assert.deepEqual(denied.result.records,[]);
          assert.deepEqual(await store.query({model: rootModel, authority: 'owner'}), rows);

        }
      }
      // The same owner-prefix capability authenticates an original CREATE;
      // a schema-valid default cannot conceal a different authored field set.
      const state=await import('@canlang/state/invocation');
      for(const mode of ['valid','wrong-fields','wrong-parent','extra-write']){
        const {now,identities,identity}=await member('created-phase-'+mode),store=createMemoryStorage();
        const loaded=await loadCanonicalDescriptors(asm,artifact,store),target=model('GuardOwnerFrame','Root'),child=model('GuardOwnerFrame','Child');
        const sourceRow={...makeRow({id:asId('root'),data:{capacity:'2',checked:false}}),parent:null};
        await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:target,row:sourceRow}]}));
        const def=loaded.registry.get('GuardOwnerFrame.created')as Parameters<typeof state.bindScenarioSourceRequirePhases>[0];
        const sites=loaded.requireSources.get(def.name)!,site=sites.find(site=>site.decision==='require'&&site.mutationPrefix!==undefined)!;
        assert.ok(site);assert.equal(site.mutationPrefix?.length,1);assert.equal(site.mutationPrefix?.[0]?.kind,'create');
        const callable=artifact.callables.find(callable=>callable.id===def.name)!;
        state.bindScenarioSourceRequirePhases(def,{source:{...site.source,module:callable.module},owner:def.name,phases:[{node:site.node,statement:site.statement,prefix:site.mutationPrefix!}]});
        let proven=false;
        await assert.rejects(()=>state.invoke({registry:loaded.registry as Parameters<typeof state.invoke>[0]['registry'],
          envelope:{operation:def.name,operation_id:operationId(now),inputs:{root:{id:'root',version:'1'}}},identity,app:'GuardOwnerFrame',source:'integration',store,memberships:identities,clock:{nowMs:()=>now},execute:async call=>{
            const session=await state.beginScenarioReceiptMutation(call,store,{table:loaded.table as Parameters<typeof state.beginScenarioReceiptMutation>[2]['table'],bounds:state.readScenarioReceiptOwnerBounds(call,store)});
            await session.stage({op:'create',model:child,id:asId('created-child'),data:mode==='wrong-fields'?{active:true}:{active:true,marked:false},parent:{model:target,id:mode==='wrong-parent'?asId('foreign-root'):sourceRow.id}},{cause:'scenario'});
            if(mode==='extra-write')await session.stage({op:'update',model:target,id:sourceRow.id,data:{checked:true}},{cause:'scenario'});
            const phase=await state.openScenarioSourceRequirePhase(call,store,site.node);
            await state.consumeScenarioSourceRequirePhase(call,store,site.node,phase);proven=true;throw new Error('created phase proof complete; abort probe');
          }}),mode==='valid'?/created phase proof complete/:mode==='wrong-fields'?/complete original CREATE prefix/:mode==='wrong-parent'?/exact actual CREATE stage and admitted parent/:/omitted or reordered an actual owner mutation/);
        assert.equal(proven,mode==='valid');assert.deepEqual(await store.query({model:child,authority:'owner'}),[],'CREATE phase probing publishes no insert');assert.deepEqual(await store.load(target,sourceRow.id),sourceRow);assert.deepEqual(await store.outboxPending(),[]);
      }
      // Native query cardinality is owned by its completed State execution;
      // copying or exchanging the original return-case metadata cannot supply it.
      for(const mode of ['swapped-query-cases','missing-query-completion','forged-pure-value']){
        const {now,identities,identity}=await member(mode),store=createMemoryStorage();
        const loaded=await loadCanonicalDescriptors(asm,artifact,store),target=model('GuardOwnerFrame','Root');
        const sourceRow={...makeRow({id:asId('root'),data:{capacity:'2',checked:false}}),parent:null};
        await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:target,row:sourceRow}]}));
        const def=loaded.registry.get('GuardOwnerFrame.query_value')as Parameters<typeof state.bindScenarioSourceQueryValueProducer>[0];
        const callable=artifact.callables.find(callable=>callable.id===def.name)!;
        const module=await import(asm.moduleUrls[callable.module]!);
        const sites=(module.canScenarioQueryValueSources()as Record<string,Parameters<typeof state.bindScenarioSourceQueryValueProducer>[1]['sites']>)[def.name]!;
        const site=sites.find(site=>site.receiptQueryId!==undefined)!;
        assert.ok(site?.receiptCases);assert.ok(site.receiptCases.empty.length>0);assert.ok(site.receiptCases.nonempty.length>0);
        assert.deepEqual(sites.find(site=>site.binding==='first_value')?.captures?.map(capture=>capture.binding),['values'],'pure native LET keeps its actual prior canonical Values capture');
        state.bindScenarioSourceQueryValueProducer(def,{source:def.descriptor.result!.disclosure!.source,owner:def.name,sites,original:module.canScenarioQueryValueSource});
        let ran=false,entered=false;
        await assert.rejects(()=>state.invoke({registry:loaded.registry as Parameters<typeof state.invoke>[0]['registry'],
          envelope:{operation:def.name,operation_id:operationId(now),inputs:{root:{id:'root',version:'1'}}},identity,app:'GuardOwnerFrame',source:'integration',store,memberships:identities,clock:{nowMs:()=>now},execute:async call=>{
            entered=true;await state.beginScenarioReceiptMutation(call,store,{table:loaded.table as Parameters<typeof state.beginScenarioReceiptMutation>[2]['table'],bounds:state.readScenarioReceiptOwnerBounds(call,store)});
            if(mode==='missing-query-completion')state.selectScenarioReceiptReturn(call,store,site.receiptCases!.empty[0]!);
            else await state.executeScenarioSourceQueryValue(call,store,{source:mode==='forged-pure-value'?sites.find(site=>site.binding==='first_value')!:{...site,receiptCases:{empty:site.receiptCases!.nonempty,nonempty:site.receiptCases!.empty}},body:async()=>{ran=true;return [];},context:{}});
            throw new Error('forged query case unexpectedly accepted');
          }}),mode==='missing-query-completion'?/Return omitted its original completed Values query case/:mode==='forged-pure-value'?/closed own data shape required/:/changed their original declaration/);
        assert.equal(entered,true);assert.equal(ran,false);assert.deepEqual(await store.load(target,sourceRow.id),sourceRow);assert.deepEqual(await store.outboxPending(),[]);
      }
      // Exercise the actual admitted State owner API independently of the
      // generated IF adapter. A probe always aborts before business commit.
      for(const mode of ['valid','forged','stale','wrong-prefix','mutable-write','loop-wrong-fields','loop-extra-when','loop-out-of-order','missing-scalar-capture','forged-query-value','wrong-source','reused','revision-race']){
        const {now,identities,identity}=await member('phase-proof-'+mode),store=createMemoryStorage();
        const loaded=await loadCanonicalDescriptors(asm,artifact,store),target=model('GuardOwnerFrame','Root');
        const sourceRow={...makeRow({id:asId('root'),data:{capacity:'2',checked:false}}),parent:null};
        const childModel=model('GuardOwnerFrame','Child'),childRow={...makeRow({id:asId('child'),data:{active:true,marked:false}}),parent:{model:target,id:sourceRow.id}};
        await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:target,row:sourceRow},{kind:'insert',model:childModel,row:childRow},...(['valid','loop-out-of-order'].includes(mode)?[{kind:'insert' as const,model:childModel,row:{...childRow,id:asId('second-child')}}]:[])]}));
        const site=loaded.requireSources.get('GuardOwnerFrame.staged')?.find(site=>site.decision==='if'&&site.mutationPrefix!==undefined);
        assert.ok(site,'fresh compiler/loader independently bind the actual staged IF prefix');
        assert.equal(site.mutationPrefix?.length,2);assert.deepEqual(site.mutationPrefix?.[0],{kind:'set',parameter:'root',model:target,parents:[],fields:['capacity','checked']});
        const loopStep=site.mutationPrefix?.[1];assert.ok(loopStep?.kind==='loop');assert.deepEqual(loopStep.fields,[['marked']]);
        const def=loaded.registry.get('GuardOwnerFrame.staged') as Parameters<typeof state.bindScenarioSourceRequirePhases>[0];
        const callable=artifact.callables.find(callable=>callable.id===def.name);assert.ok(callable);
        const module=await import(asm.moduleUrls[callable.module]!);
        const loopPlan=(module.canScenarioBodyLoopSources() as Record<string,Parameters<typeof state.bindScenarioSourceLoopProducer>[1]>)[def.name]!;
        assert.equal(loopPlan.loops.length,1);assert.equal(loopPlan.loops[0]!.id,loopStep.id);state.bindScenarioSourceLoopProducer(def,loopPlan);
        const queryValues=(module.canScenarioQueryValueSources() as Record<string,Parameters<typeof state.bindScenarioSourceQueryValueProducer>[1]['sites']>)[def.name]!;
        assert.ok(queryValues.some(site=>site.binding==='probe_values'),'fresh module binds original plain Values LET');
        state.bindScenarioSourceQueryValueProducer(def,{source:{...site.source,module:callable.module},owner:def.name,sites:queryValues,original:module.canScenarioQueryValueSource});
        state.bindScenarioSourceRequirePhases(def,{source:def.descriptor.result?.disclosure?.source??{...site.source,module:callable.module},owner:def.name,phases:loaded.requireSources.get(def.name)!.filter(site=>site.mutationPrefix!==undefined).map(site=>({node:site.node,statement:site.statement,prefix:site.mutationPrefix!}))});

        let entered=false,proven=false,phaseRaced=false;
        await assert.rejects(()=>state.invoke({registry:loaded.registry as Parameters<typeof state.invoke>[0]['registry'],
          envelope:{operation:'GuardOwnerFrame.staged',operation_id:operationId(now),inputs:{root:{id:'root',version:'1'}}},
          identity,app:'GuardOwnerFrame',source:'integration',store,memberships:identities,clock:{nowMs:()=>now},execute:async call=>{
            entered=true;
            const session=await state.beginScenarioReceiptMutation(call,store,{table:loaded.table as Parameters<typeof state.beginScenarioReceiptMutation>[2]['table'],bounds:state.readScenarioReceiptOwnerBounds(call,store)});
            if(mode==='forged-query-value'){
              let ran=false;
              try{await state.executeScenarioSourceQueryValue(call,store,{source:queryValues.find(site=>site.binding==='probe_values')!,body:async()=>{ran=true;return [];},context:{}});}
              finally{assert.equal(ran,false,'unissued callback never executes or records Values');}
            }
            const patch:Record<string,unknown>=['wrong-prefix','mutable-write'].includes(mode)?{capacity:'3'}:{capacity:'3',checked:true};
            const staging=session.stage({op:'update',model:target,id:sourceRow.id,data:patch},{cause:'scenario'});
            if(mode==='mutable-write')patch['checked']=true;await staging;
            const selected=await state.executeScenarioSourceLoop(call,store,{id:loopStep.id,predicate:null});assert.equal(selected.length,['valid','loop-out-of-order'].includes(mode)?2:1);
            const ordered=mode==='loop-out-of-order'?[...selected].reverse():selected;
            for(const row of ordered)await state.executeScenarioSourceLoopItem(call,store,{id:loopStep.id,row,execute:()=>session.stage({op:'update',model:childModel,id:row.id,data:mode==='loop-wrong-fields'?{active:false}:{marked:true},...(mode==='loop-extra-when'?{when:{op:'eq' as const,field:'marked',value:true}}:{})},{cause:'scenario'})});
            if(mode==='missing-scalar-capture'){
              const require=loaded.requireSources.get(def.name)!.find(site=>site.decision==='require'&&site.mutationPrefix!==undefined)!;
              assert.deepEqual(require.captures?.map(capture=>[capture.binding,capture.typeId]),[['original','int']]);
              const phase=await state.openScenarioSourceRequirePhase(call,store,require.node);
              await state.executeScenarioReceiptRequire(call,store,{original:require,checked:require,parameter:'root',phase,captures:{original:2n},
                capture:()=>{throw new Error('unrecorded lexical input must never reach the predicate');}});
            }
            if(mode==='forged')await state.consumeScenarioSourceRequirePhase(call,store,site.node,{kind:'source-require-phase'});
            const token=await state.openScenarioSourceRequirePhase(call,store,mode==='wrong-source'?{start:site.node.start+1,end:site.node.end}:site.node);
            if(mode==='stale')await session.stage({op:'update',model:target,id:sourceRow.id,data:{checked:false}},{cause:'scenario'});
            if(mode==='revision-race')await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:target,id:sourceRow.id,expectedVersion:sourceRow.version,row:{...sourceRow,version:asVersion(sourceRow.version+1),data:{...sourceRow.data,capacity:'9'}}}]}));
            try { await state.consumeScenarioSourceRequirePhase(call,store,site.node,token); }
            catch(error){if(mode==='revision-race'){assert.equal((error as {code:string}).code,'conflict');assert.match((error as Error).message,/revision changed/);phaseRaced=true;}throw error;}
            if(mode==='reused')await state.consumeScenarioSourceRequirePhase(call,store,site.node,token);
            proven=true;throw new Error('phase proof complete; abort probe before business commit');
          }}),mode==='valid'?/phase proof complete/:['wrong-prefix','mutable-write'].includes(mode)?/complete original SET prefix/:['loop-wrong-fields','loop-extra-when'].includes(mode)?/loop stamp differs/:mode==='loop-out-of-order'?/original selected order/:mode==='missing-scalar-capture'?/genuine original scalar read/:mode==='forged-query-value'?/closed own data shape required/:mode==='wrong-source'?/quiescent original owner/:mode==='revision-race'?(error:unknown)=>{assert.equal((error as {code:string}).code,'conflict');assert.match((error as Error).message,/Stale record version/);return true;}: /forged, stale, foreign or already consumed/);
        assert.equal(entered,true);assert.equal(proven,mode==='valid');assert.equal(phaseRaced,mode==='revision-race','actual phase rejects the changed revision before canonical retry admission');
        assert.equal((await store.load(target,sourceRow.id))?.data.checked,false,'proof probing publishes no staged SET');
        assert.equal((await store.load(target,sourceRow.id))?.data.capacity,mode==='revision-race'?'9':'2');
        assert.deepEqual(await store.load(childModel,childRow.id),childRow,'phase proof publishes no selected item mutation');
        if(['valid','loop-out-of-order'].includes(mode))assert.deepEqual(await store.load(childModel,asId('second-child')),{...childRow,id:asId('second-child')},'ordered and refused selection both roll back every original item');
        assert.deepEqual(await store.outboxPending(),[]);
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
        assertSourceOnlyReceipt(artifact,name);
      }
      const variants = new Map<string, {artifact: CompileArtifact; asm: typeof asm}>();
      for (const [mode, text] of [
        ['unbound-stored-alias', original.replace('let subject="Checked request"', 'let copied=root\n   let subject=copied.secret')],
        ['guarded-send', original.replace('body="Original source action"} as delivery', 'body="Original source action"} when=to=="recipient@example.test" as delivery')],
        ['guarded-send-false', original.replace('body="Original source action"} as delivery', 'body="Original source action"} when=to=="other@example.test" as delivery')],
      ] as const) {
        const source = join(directory, `${mode}.can`); await writeFile(source,text);
        const compiled = spawnSync(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,encoding:'utf8'});
        assert.equal(compiled.status,0,`${mode}: ${compiled.stdout} ${compiled.stderr}`);
        const artifact = JSON.parse(compiled.stdout) as CompileArtifact;
        assertSourceOnlyReceipt(artifact,'SourceGuardSend.notify','date',mode==='unbound-stored-alias' ? [[['SourceGuardSend.Root','secret','data','text']]] : [[]]);
        const asm = await assembleModules({artifact,sourcePath:source},{workDir:join(directory,mode),
          stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
        variants.set(mode,{artifact,asm});
      }
      for(const mode of ['allowed','guarded-send','guarded-send-false','unbound-stored-alias','full','inactive','other-parent','invariant-after-send','membership-during-send','invalid-email'] as const){
        const {now,identities,identity,membership}=await member(`source-send-${mode}`);
        const selected=variants.get(mode)??{artifact,asm};
        const scope={app:'SourceGuardSend',owner:membership.team_id,ownerPackage:'SourceGuardSend'};
        const authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'source-send-state',fileStoreId:'source-send-files',receiver:{app:scope.app,owner:scope.owner,team:scope.owner}};
        const {store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({...selected,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(scope.owner));}});
        const rootModel=model('SourceGuardSend','Root');
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
        const invoker=buildInvoker(selected.artifact,selected.asm,store,{memberships:identities,now:()=>now});
        const request={operation:mode==='invariant-after-send'?'SourceGuardSend.abort':'SourceGuardSend.notify',operation_id:operationId(now),
          inputs:{root:{id:rootRow.id,version:String(rootRow.version)},to:mode==='invalid-email'?'invalid':'recipient@example.test'}};
        const result=await invoker.invokeMutation(request,identity);
        if(mode==='guarded-send-false'){
          assert.ok('result'in result&&result.result.status==='committed',JSON.stringify(result));
          const current=await store.load(rootModel,rootRow.id);assert.ok(current);assert.equal(current.data.checked,true);assert.equal(typeof current.data.last,'string');assert.match(String(current.data.last),/^skp_[a-f0-9]{64}$/);
          assert.deepEqual(await store.query({model:asModel('work.dispatch'),authority:'owner'}),[]);
          assert.deepEqual(await store.outboxPending(),[]);
          assertDateReplay(await invoker.invokeMutation(request,identity),new Date(now).toISOString().slice(0,10));
          assert.deepEqual(await store.load(rootModel,rootRow.id),current);
          continue;
        }
        const allowed=mode==='allowed'||mode==='guarded-send';
        assert.equal('result' in result&&result.result.status==='committed',allowed,`${mode}: ${JSON.stringify(result)}`);
        if(mode==='membership-during-send')assert.equal(revoked,true);
        if(mode==='unbound-stored-alias')assert.ok(!JSON.stringify(result).includes('Hidden source field'));
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
          assert.equal(saved.outcome.status,'committed');assertSavedSourceReceipt(selected.artifact,saved);
          const replay=await invoker.invokeMutation(request,identity);
          assertDateReplay(replay,new Date(now).toISOString().slice(0,10));
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
      const membershipSource=join(directory,'reference-membership.can');
      await writeFile(membershipSource,`app ReferenceMembership
Given
 Location {active:bool=true}
 Resource {location:Location,active:bool=true}
 Customer {locations:Location[],visible:bool=true}
 policy Location read=members where=row.active
 policy Resource read=members fields=active
 policy Customer read=members where=row.visible
When
 scenario check(resource:Resource,customer:Customer) by=members
  require resource.location in customer.locations
  do set resource {active=false}
Then
`);
      const compiled=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,membershipSource],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
      const membershipArtifact=JSON.parse(compiled.stdout) as CompileArtifact;
      const membershipAsm=await assembleModules({artifact:membershipArtifact,sourcePath:membershipSource},{workDir:join(directory,'references'),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
      for(const mode of ['allowed','different','empty','private-source','revision-race','identity-race']){
        const {now,identities,identity,membership}=await member('reference-array-'+mode);
        const store=createMemoryStorage(),resource=model('ReferenceMembership','Resource'),customer=model('ReferenceMembership','Customer'),location=model('ReferenceMembership','Location');
        const site='location-private',resourceRow={...makeRow({id:asId('resource'),data:{location:{id:site},active:true}}),parent:null};
        const customerRow={...makeRow({id:asId('customer'),data:{locations:mode==='empty'?[]:[{id:mode==='different'?'different-location':site}],visible:mode!=='private-source'}}),parent:null};
        await store.commit(makeBatch(await store.readRevision(),{writes:[
          {kind:'insert',model:location,row:{...makeRow({id:asId(site),data:{active:mode!=='private-source'}}),parent:null}},
          {kind:'insert',model:resource,row:resourceRow},{kind:'insert',model:customer,row:customerRow}
        ]}));
        let raced=false;
        if(mode==='revision-race'){
          const commit=store.commit.bind(store);store.commit=async batch=>{
            if(!raced){raced=true;await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:customer,id:customerRow.id,expectedVersion:asVersion(customerRow.version),row:{...customerRow,version:asVersion(customerRow.version+1),data:{...customerRow.data,locations:[]}}}]}));}
            return commit(batch);
          };
        }
        if(mode==='identity-race'){
          const load=store.load.bind(store);store.load=async(name,id)=>{const row=await load(name,id);if(name===customer&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}return row;};
        }
        const request={operation:'ReferenceMembership.check',operation_id:operationId(now),inputs:{resource:{id:resourceRow.id,version:'1'},customer:{id:customerRow.id,version:'1'}}};
        const invoker=buildInvoker(membershipArtifact,membershipAsm,store,{memberships:identities,now:()=>now}),outcome=await invoker.invokeMutation(request,identity);
        const allowed=mode==='allowed'||mode==='private-source';
        assert.equal('result'in outcome?outcome.result.status:outcome.error.code,allowed?'committed':mode==='revision-race'?'conflict':'rule_failed',mode+': '+JSON.stringify(outcome));
        if(mode==='identity-race'){assert.ok('error'in outcome);assert.equal(outcome.error.message,'forbidden');}
        assert.equal((await store.load(resource,resourceRow.id))!.data.active,!allowed,mode);
        assert.deepEqual(await store.outboxPending(),[]);
        assert.ok(!JSON.stringify(outcome).includes(site),'the guard must not release its reference operands');
        if(mode.endsWith('race'))assert.equal(raced,true,mode);
        if(allowed){const replay=await invoker.invokeMutation(request,identity);assert.equal('result'in replay?replay.result.status:replay.error.code,'replayed');assert.equal((await store.load(resource,resourceRow.id))!.data.active,false);}
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });
it('authorizes a stored timezone through original parent and required reference paths and rechecks saved disclosure',
  {timeout:120000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-parent-timezone-'));
    try{
      for(const fixtureName of ['native-parent-timezone.can','native-reference-timezone.can']){
      const {artifact,asm}=await installed(fixtureName,directory);
      const plan=artifact.operations?.find(operation=>operation.name==='ParentTimezone.day')?.result?.disclosure;
      assert.ok(plan,'the date must retain its actual parent DATA dependencies');
      assert.ok(plan.returns.some(returned=>returned.dependencies.some(dependency=>dependency.field==='timezone'&&dependency.type==='timezone')));
      for(const operation of fixtureName==='native-reference-timezone.can'?['day','snapshot']:['day']){
      const snapshot=operation==='snapshot';
      if(snapshot){
        const captured=artifact.operations?.find(item=>item.name==='ParentTimezone.snapshot')?.result?.disclosure;
        assert.ok(captured?.returns.some(returned=>returned.dependencies.some(read=>read.field==='location')
          &&returned.dependencies.some(read=>read.field==='timezone')),'captured getter and original receiver leaf both retain their DATA obligations');
      }
      for(const mode of ['utc','new-york','hidden','changed-at-commit','hidden-at-commit',...(fixtureName==='native-reference-timezone.can'?['root-hidden']:[])]){
        const {now,identities,identity}=await member(`${fixtureName}-${operation}-${mode}`,[],true,Date.parse('2099-01-01T11:30:00.000Z'));
        const store=createMemoryStorage(),resourceModel=model('ParentTimezone','Resource'),bookingModel=model('ParentTimezone','Booking');
        const zone=mode==='new-york'?'America/New_York':'UTC';
        const resource={...makeRow({id:asId('resource'),data:{timezone:zone,visible:mode!=='hidden'}}),parent:null};
        const booking={...makeRow({id:asId('booking'),data:{active:true,checked:false,...(fixtureName==='native-reference-timezone.can'?{location:{id:resource.id},visible:mode!=='root-hidden'}:{})}}),parent:{model:resourceModel,id:resource.id}};
        const other={...resource,id:asId('replacement'),data:{timezone:'Pacific/Kiritimati',visible:true}};
        await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:resourceModel,row:resource},
          {kind:'insert',model:resourceModel,row:other},{kind:'insert',model:bookingModel,row:booking}]}));
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
        const request={operation:`ParentTimezone.${operation}`,operation_id:operationId(now),inputs:{booking:{id:booking.id,version:String(booking.version)},
          ...(snapshot?{other:{id:other.id,version:String(other.version)}}:{})}};
        const outcome=await invoker.invokeMutation(request,identity),allowed=mode==='utc'||mode==='new-york';
        assert.equal('result'in outcome,allowed,`${mode}: ${JSON.stringify(outcome)}`);
        assert.equal((await store.load(bookingModel,booking.id))?.data.checked,allowed,'denied or stale parent reads roll back the preceding SET');
        if(snapshot)assert.deepEqual((await store.load(bookingModel,booking.id))?.data.location,{id:allowed?other.id:resource.id},
          'the captured reference survives a successful reassignment, while denied source/leaf grants roll it back');
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
      }
      }
      const {artifact:aliasArtifact,asm:aliasAsm}=await installed('native-reference-timezone.can',join(directory,'mixed-roles'));
      for(const mode of ['different','same','old-user-hidden','new-user-hidden','old-row-hidden','source-hidden','late-refusal','identity-race']){
        const {now,identities,identity,user,membership}=await member('captured-recipient-'+mode);
        const originalUser=await identities.createUser({email:'original-'+mode+'@captured.test',password_hash:'unused',email_verified:true});
        const {store}=createTestMemoryStorage(),personModel=model('ParentTimezone','Person'),unitModel=model('ParentTimezone','Unit'),assignmentModel=model('ParentTimezone','Assignment');
        const row=(modelName:ReturnType<typeof asModel>,id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({kind:'insert' as const,model:modelName,row:{...makeRow({id:asId(id),data}),parent}});
        await store.commit(makeBatch(await store.readRevision(),{writes:[
          row(personModel,'original',{user:{id:originalUser.user_id},visible:mode!=='old-row-hidden',user_visible:mode!=='old-user-hidden'}),
          row(personModel,'replacement',{user:{id:user.user_id},visible:true,user_visible:mode!=='new-user-hidden'}),
          row(unitModel,'unit',{person:{id:'original'}}),
          row(assignmentModel,'assignment',{visible:mode!=='source-hidden'},{model:unitModel,id:asId('unit')})
        ]}));
        let raced=false;const load=store.load.bind(store);
        store.load=async(modelName,id)=>{const saved=await load(modelName,id);if(mode==='identity-race'&&modelName===personModel&&id==='original'&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}return saved;};
        const request={operation:'ParentTimezone.reassign',operation_id:operationId(now),inputs:{assignment:{id:'assignment',version:'1'},replacement:{id:mode==='same'?'original':'replacement',version:'1'},abort:mode==='late-refusal'}};
        const invoker=buildInvoker(aliasArtifact,aliasAsm,store,{memberships:identities,now:()=>now});
        const outcome=await invoker.invokeMutation(request,identity),allowed=mode==='different'||mode==='same';
        assert.equal('result'in outcome,allowed,mode+': '+JSON.stringify(outcome));
        assert.deepEqual((await store.load(unitModel,asId('unit')))!.data['person'],{id:allowed&&mode!=='same'?'replacement':'original'},mode+': denied recipient DATA rolls back reassignment');
        const events=await store.query({model:asModel('work.occurrence'),authority:'owner'});
        assert.equal(events.length,allowed?(mode==='same'?1:2):0,mode+': emitted notices remain atomic');
        if(mode==='identity-race')assert.equal(raced,true);
        if(allowed){
          const recipients=events.map(event=>(event.data['result'] as {payload:{recipient:{id:string}}}).payload.recipient.id).sort();
          assert.deepEqual(recipients,(mode==='same'?[originalUser.user_id]:[originalUser.user_id,user.user_id]).sort(),'the original target is retained after the source field changes');
          const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');
          assert.deepEqual(await store.query({model:asModel('work.occurrence'),authority:'owner'}),events);
          if(mode==='different')for(const mutation of ['model','field','role','id']){
            const changed=JSON.parse(JSON.stringify(aliasArtifact)) as CompileArtifact;
            const disclosure=changed.operations!.find(operation=>operation.name==='ParentTimezone.reassign')!.result!.disclosure!;
            const source=disclosure.returns.flatMap(returned=>returned.dependencies).find(dependency=>dependency.field==='person'&&dependency.role==='data')! as unknown as Record<string,unknown>;
            source[mutation]=mutation==='model'?'ParentTimezone.Person':mutation==='field'?'user':mutation==='role'?'control':'0'.repeat(64);
            let refused=false;
            try{const forged=buildInvoker(changed,aliasAsm,store,{memberships:identities,now:()=>now});const result=await forged.invokeMutation({...request,operation_id:operationId(now)},identity);refused='error'in result;}
            catch{refused=true;}
            assert.equal(refused,true,mutation+': source/field/role/node substitution cannot reuse the observed view');
            assert.deepEqual(await store.query({model:asModel('work.occurrence'),authority:'owner'}),events);
          }
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
      for(const name of ['notify','abort'])assertSourceOnlyReceipt(artifact,`SourceGuardEmit.${name}`);
      const original=await readFile(fixture('native-source-require-emit.can'),'utf8');
      const refused=fixture('.native-source-require-emit-refusal.can');
      try{
        for(const changed of [original.replaceAll('emit Checked {root,message}','emit Checked {root,message=format("{amount}",{amount=root.remaining})}'),
          original.replaceAll('emit Checked {root,message}','let alias=root\n   emit Checked {root=alias,message}')]){
          await writeFile(refused,changed);
          const report=spawnSync(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,refused],{cwd:root,encoding:'utf8'});
          assert.equal(report.status,10,report.stdout+report.stderr);
          assert.ok((JSON.parse(report.stdout) as {diagnostics:{code:string}[]}).diagnostics.some(item=>item.code==='E6008'));
        }
      }finally{await rm(refused,{force:true});}
      for(const mode of ['allowed','full','inactive','other-parent','invariant-after-emit','identity-during-event-stage','root-at-commit','tampered-source','missing-inventory']){
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
        if(mode==='identity-during-event-stage'){
          const load=store.load.bind(store);
          store.load=async(model,id)=>{
            if(!raced&&model==='work.occurrence'){raced=true;await identities.removeMembership(membership.membership_id);}
            return load(model,id);
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
        const allowed=mode==='allowed'||mode==='tampered-source'||mode==='missing-inventory';
        assert.equal('result'in outcome&&outcome.result.status==='committed',allowed,`${mode}: ${JSON.stringify(outcome)}`);
        if(mode==='identity-during-event-stage')assert.equal('error'in outcome&&outcome.error.code,'forbidden');
        if(mode==='root-at-commit')assert.equal('error'in outcome&&outcome.error.code,'conflict');
        const sources=await store.query({model:asModel('work.occurrence'),authority:'owner'});
        assert.equal(sources.length,allowed?1:0,mode);
        const actual=await store.load(rootModel,rootRow.id);assert.ok(actual);assert.equal(actual.data.checked,allowed,mode);assert.equal(actual.data.seen,false);
        if(mode==='identity-during-event-stage'||mode==='root-at-commit')assert.equal(raced,true,mode);
        if(!allowed)continue;
        const source=sources[0]!,result=source.data['result'] as {context:{kind:string;operation:string};payload:unknown};
        assert.equal(result.context.kind,'user');assert.equal(result.context.operation,request.operation);
        assert.deepEqual(result.payload,{root:{id:rootRow.id,version:String(actual.version)},message:'Original event'});
        const saved=await store.readReceipt({app:'SourceGuardEmit',owner:membership.team_id,principal:membership.user_id,
          operation:request.operation,operationId:request.operation_id} as Parameters<typeof store.readReceipt>[0]);assert.ok(saved);
        assert.ok(saved.outcome.status==='committed');assertSavedSourceReceipt(artifact,saved);
        const visible=await invoker.invokeRead({operation:'SourceGuardEmit.Root.read',inputs:{}},identity);
        assert.ok('error'in visible||((visible.result as {records:unknown[]}).records.length===0));
        const replay=await invoker.invokeMutation(request,identity);
        assertDateReplay(replay,new Date(now+86400000).toISOString().slice(0,10));
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
        if(mode==='missing-inventory'){
          await assert.rejects(deliver,/Declared event differs from its original owner, payload or complete routes/);
          assert.equal((await store.load(rootModel,rootRow.id))?.data.seen,false);
          assert.deepEqual(await store.readReceipt(saved.identity),saved);
          continue;
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

it('executes original cancellation and candidate cleanup over exact admitted sibling domains',
  {timeout:180000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-book-cancel-'));
    try{
      const source=join(root,'compiler/tests/fixtures/book-original-source.can');
      const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
      const artifact=JSON.parse(stdout) as CompileArtifact;
      const asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
      for(const mode of ['cancel','discard','retry','empty','wrong-actor','unverified','stale-input','domain-race','contact-race','identity-race']){
        const {now,identities,identity,user:actor,membership}=await member('book-cancel-'+mode);
        const {store,probe}=createTestMemoryStorage();
        const row=(model:string,id:string,data:Record<string,unknown>,parent:{model:ModelName;id:ReturnType<typeof asId>}|null=null)=>({kind:'insert' as const,model:asModel(model),row:{...makeRow({id:asId(id),data}),parent}});
        const calendar={model:asModel('appointments.Calendar'),id:asId('calendar')},type={model:asModel('appointments.Type'),id:asId('type')},visit={model:asModel('appointments.Appointment'),id:asId('visit')};
        const slot={customer:{id:'customer'},contact:{id:'contact'},from:'2099-01-01T09:00:00.000Z',until:'2099-01-01T09:30:00.000Z',duration:'1800000',source:'original',active_source:'original',host:{id:actor.user_id},reservation_account:{id:actor.user_id},room_snapshot:'room-1',state:'confirmed',host_ok:true,room_ok:true,host_delivery:'original-host',room_delivery:'original-room',reason:null,reason_code:null};
        const attempt=(id:string,state:string,kind='movement',parent=visit)=>row('appointments.Attempt',id,{source:id,kind,from:slot.from,until:slot.until,previous_source:'original',previous_host_revision:'1',previous_room_revision:'1',requested_by:{id:actor.user_id},state,host_ok:true,room_ok:true,host_unknown:false,room_unknown:false,host_revision:'3',room_revision:'5',host_delivery:'original-host',room_delivery:'original-room',room_confirmation:null,host_release:'host-release',room_release:'room-release',host_released:id==='retired',room_released:false},parent);
        await store.commit(makeBatch(await store.readRevision(),{writes:[
          row('rent_catalog.Location','site',{active:true,timezone:'UTC'}),
          row('employee.Employee','host',{user:{id:actor.user_id},active:true,operator_wide:false,home:{id:'site'},locations:[]}),
          row('customer.Customer','customer',{active:true,locations:[{id:'site'}],name:'Customer'}),
          row('customer.Contact','contact',{account:{id:mode==='wrong-actor'?'other-user':actor.user_id},verified:mode!=='unverified',email:'customer@example.test',name:'Contact'},{model:asModel('customer.Customer'),id:asId('customer')}),
          row('appointments.Calendar','calendar',{location:{id:'site'},host:{id:'host'},timezone:'UTC',duration:'1800000',hours:'9-18',instructions:'Reception',cutoff:'3600000',active:true}),
          row('appointments.Type','type',{name:'Tour',duration:'1800000',room:'room-1'},calendar),
          row('appointments.Appointment','visit',slot,type),row('appointments.Appointment','other',{...slot,source:'other',active_source:'other'},type),
          ...(mode==='empty'?[]:[attempt('active','active','initial'),attempt('candidate','pending'),attempt('pending-initial','pending','initial'),attempt('failed','failed'),attempt('retired','retired')]),
          attempt('foreign','pending','movement',{model:asModel('appointments.Appointment'),id:asId('other')})
        ]}));
        let raced=false;
        if(mode==='identity-race'){
          const query=store.query.bind(store);
          store.query=async spec=>{const rows=await query(spec);if(spec.model==='appointments.Attempt'&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}return rows;};
        }
        if(mode==='domain-race'||mode==='contact-race'){
          const commit=store.commit.bind(store);
          store.commit=async batch=>{
            if(batch.writes.some(write=>write.model==='appointments.Attempt')){
              raced=true;
              if(mode==='domain-race'){
                const id='late-'+String(await store.readRevision());
                await commit(makeBatch(await store.readRevision(),{writes:[attempt(id,'pending')]}));
              }else{
                const current=await store.load(asModel('customer.Contact'),asId('contact'));assert.ok(current);
                await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:asModel('customer.Contact'),id:current.id,expectedVersion:current.version,row:{...current,version:asVersion(current.version+1),data:{...current.data,verified:false}}}]}));
              }
            }
            return commit(batch);
          };
        }
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const operation=mode==='retry'?'appointments.retry_cleanup':mode==='cancel'?'appointments.cancel':'appointments.discard_reschedule';
        const operation_id=operationId(now),reference={id:'visit',version:mode==='stale-input'?'0':'1'};
        const inputs=mode==='cancel'?{appointment:reference,reason:'Changed plans'}:mode==='retry'?{appointment:reference}:{visit:reference};
        const result=await invoker.invokeMutation({operation,operation_id,inputs},identity);
        const success=['cancel','discard','retry','empty'].includes(mode);
        assert.equal('result' in result,success,mode+': '+JSON.stringify(result));
        if(['domain-race','contact-race','identity-race'].includes(mode))assert.equal(raced,true,mode);
        const current=await store.load(asModel('appointments.Appointment'),asId('visit'));assert.ok(current);
        assert.equal(current.data['state'],mode==='cancel'?'cancelled':'confirmed');
        assert.equal(current.data['from'],slot.from);assert.equal(current.data['active_source'],'original');
        assert.equal(current.version,mode==='cancel'?2:1);
        const siblings=await store.query({model:asModel('appointments.Attempt'),authority:'owner'});
        const byId=new Map(siblings.map(row=>[row.id,row]));
        assert.equal(byId.get(asId('foreign'))?.data['state'],'pending');
        if(mode!=='empty'){
          assert.equal(byId.get(asId('active'))?.data['state'],mode==='cancel'?'cancelled':'active');
          assert.equal(byId.get(asId('candidate'))?.data['state'],success&&mode!=='retry'?'cancelled':'pending');
          assert.equal(byId.get(asId('pending-initial'))?.data['state'],mode==='cancel'?'cancelled':'pending');
          assert.equal(byId.get(asId('failed'))?.data['state'],'failed');
          assert.equal(byId.get(asId('retired'))?.data['state'],'retired');
          if(mode==='retry'){
            assert.equal(byId.get(asId('failed'))?.data['host_release'],null);
            assert.equal(byId.get(asId('failed'))?.data['room_release'],null);
            assert.equal(byId.get(asId('retired'))?.data['host_release'],'host-release');
            assert.equal(byId.get(asId('retired'))?.data['room_release'],null);
            assert.equal(byId.get(asId('candidate'))?.data['host_release'],'host-release');
          }
        }
        assert.equal(probe.outboxAll().length,0);
        if(success){const replay=await invoker.invokeMutation({operation,operation_id,inputs},identity);assert.ok('result' in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');}
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });
it('executes qualified enum literals without reading their namespace as stored data',
  {timeout:120000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-qualified-case-'));
    try{
      const {artifact,asm}=await installed('native-qualified-enum-case.can',directory);
      assert.ok(artifact.operations?.find(operation=>operation.name==='QualifiedCase.act')?.result?.disclosure);
      for(const mode of ['allowed','no-child','inactive','other-parent','changed-at-commit']){
        const {now,identities,identity,membership}=await member(`qualified-case-${mode}`);
        const store=createMemoryStorage(),rootModel=model('QualifiedCase','Root');
        const row={...makeRow({id:asId('root'),data:{state:'ready',checked:false}}),parent:null};
        await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:rootModel,row},
          {kind:'insert',model:rootModel,row:{...row,id:asId('other')}},
          ...(mode==='no-child'?[]:[{kind:'insert' as const,model:model('QualifiedCase','Child'),row:{
            ...makeRow({id:asId('child'),data:{active:mode!=='inactive'}}),parent:{model:rootModel,id:asId(mode==='other-parent'?'other':'root')}}}])]}));
        if(mode==='changed-at-commit'){
          const commit=store.commit.bind(store);let changed=false;
          store.commit=async batch=>{
            if(!changed){changed=true;await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:rootModel,
              id:row.id,expectedVersion:asVersion(row.version),row:{...row,version:asVersion(row.version+1),data:{...row.data,state:'no_show'}}}]}));}
            return commit(batch);
          };
        }
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const request={operation:'QualifiedCase.act',operation_id:operationId(now),inputs:{root:{id:row.id,version:String(row.version)}}};
        const outcome=await invoker.invokeMutation(request,identity),allowed=mode==='allowed';
        assert.equal('result'in outcome?outcome.result.status:outcome.error.code,
          allowed?'committed':mode==='changed-at-commit'?'conflict':'rule_failed',`${mode}: ${JSON.stringify(outcome)}`);
        assert.equal((await store.load(rootModel,row.id))?.data.checked,allowed);
        if(allowed){
          assert.ok('result'in outcome);assert.equal(outcome.result.result,true);
          assert.equal((await store.load(rootModel,row.id))?.data.state,'no_show');
          const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay);assert.equal(replay.result.result,true);
          await identities.removeMembership(membership.membership_id);
          const denied=await invoker.invokeMutation(request,identity);assert.ok('error'in denied||denied.result.result===null);
        }
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });

it('authorizes original SEND scalar DATA with independent current field projections and final guards',
  {timeout:180000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-source-send-data-'));
    try{
      const {artifact,asm}=await installed('native-source-send-data.can',directory);
      for(const name of ['notify','lose_grant','change_reference','secret']) {
        const fields = [['SourceSendData.Root','source','data','text'],['SourceSendData.Root','reason','data','text?'],['SourceSendData.Root','reason','control','text?']] as const;
        assertSourceOnlyReceipt(artifact,`SourceSendData.${name}`,'date',name==='secret' ? [[['SourceSendData.Root','secret','data','text']]] : [fields,fields]);
      }
      const original=await readFile(fixture('native-source-send-data.can'),'utf8'),refused=fixture('.native-source-send-data-refusal.can');
      try{
        // Required reference identities now have their own checked DATA path.
        // A checked lexical row copy retains the same independently checked field authority.
        await writeFile(refused,original.replace('subject=root.source','subject=root.location.id'));
        const identityPath=spawnSync(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,refused],{cwd:root,encoding:'utf8'});
        assert.equal(identityPath.status,0,identityPath.stdout+identityPath.stderr);
        for(const text of [original.replace('send Mail.send {to,subject=root.source','let loan=root\n   send Mail.send {to,subject=loan.source')]){
          await writeFile(refused,text);
          const result=spawnSync(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,refused],{cwd:root,encoding:'utf8'});
          assert.equal(result.status,0,result.stdout+result.stderr);
          const fields = [['SourceSendData.Root','source','data','text'],['SourceSendData.Root','reason','data','text?'],['SourceSendData.Root','reason','control','text?']] as const;
          assertSourceOnlyReceipt(JSON.parse(result.stdout) as CompileArtifact,'SourceSendData.notify','date',[fields,fields]);
        }
      }finally{await rm(refused,{force:true});}

      for(const mode of ['allowed','nonnull','hidden-row','field-withheld','grant-loss','reference-change','identity-during-send','source-at-commit']){
        const {now,identities,identity,membership}=await member(`source-data-${mode}`);
        const scope={app:'SourceSendData',owner:membership.team_id,ownerPackage:'SourceSendData'};
        const authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'source-data-state',fileStoreId:'source-data-files',receiver:{app:scope.app,owner:scope.owner,team:scope.owner}};
        const {store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(scope.owner));}});
        const rootModel=model('SourceSendData','Root'),locationModel=model('SourceSendData','Location');
        const location={...makeRow({id:asId('location'),data:{enabled:true,visible:true}}),parent:null};
        const other={...location,id:asId('other'),data:{enabled:false}};
        const row={...makeRow({id:asId('root'),data:{location:{id:location.id},capacity:'2',checked:false,last:null,
          source:'Readable source',reason:mode==='nonnull'?'Stored reason':null,secret:'Hidden source',visible:mode!=='hidden-row'}}),parent:null};
        await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:locationModel,row:location},
          {kind:'insert',model:locationModel,row:other},{kind:'insert',model:rootModel,row},
          {kind:'insert',model:model('SourceSendData','Child'),row:{...makeRow({id:asId('child'),data:{active:true}}),parent:{model:rootModel,id:row.id}}}]}));
        let raced=false;
        if(mode==='identity-during-send'){
          const load=store.load.bind(store);store.load=async(model,id)=>{
            if(!raced&&model==='work.dispatch'){raced=true;await identities.removeMembership(membership.membership_id);}
            return load(model,id);
          };
        }
        if(mode==='source-at-commit'){
          const commit=store.commit.bind(store);store.commit=async batch=>{
            if(!raced&&batch.writes.some(write=>write.model==='work.dispatch')){
              raced=true;await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:rootModel,id:row.id,
                expectedVersion:asVersion(row.version),row:{...row,version:asVersion(row.version+1),data:{...row.data,source:'Changed original source'}}}]}));
            }
            return commit(batch);
          };
        }
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const operation=`SourceSendData.${mode==='grant-loss'?'lose_grant':mode==='reference-change'?'change_reference':mode==='field-withheld'?'secret':'notify'}`;
        const request={operation,operation_id:operationId(now),inputs:{root:{id:row.id,version:String(row.version)},to:'recipient@example.test',
          ...(mode==='field-withheld'?{}:{reason:'Fallback reason'}),...(mode==='reference-change'?{other:{id:other.id,version:String(other.version)}}:{})}};
        const outcome=await invoker.invokeMutation(request,identity);
        const allowed=mode==='allowed'||mode==='nonnull';
        assert.equal('result'in outcome?outcome.result.status:outcome.error.code,
          allowed?'committed':mode==='source-at-commit'?'conflict':'forbidden',`${mode}: ${JSON.stringify(outcome)}`);
        const actual=await store.load(rootModel,row.id);assert.ok(actual);
        assert.equal(actual.data.checked,allowed,mode);assert.equal(actual.data.visible,row.data.visible,mode);
        assert.deepEqual(actual.data.location,row.data.location,mode);
        const pending=await store.outboxPending(),dispatch=await store.query({model:asModel('work.dispatch'),authority:'owner'});
        assert.equal(pending.length,allowed?1:0,mode);assert.equal(dispatch.length,allowed?1:0,mode);
        if(mode==='identity-during-send'||mode==='source-at-commit')assert.equal(raced,true,mode);
        if(!allowed){assert.equal(actual.data.last,null);continue;}
        assert.equal(actual.data.last,pending[0]!.intentId);
        assert.deepEqual(pending[0]!.arguments,{binding:'SourceSendData.Mail',from:'deployment.mail',
          arguments:{to:'recipient@example.test',subject:'Readable source',body:mode==='nonnull'?'Stored reason':'Fallback reason',attachments:[]}});
        const read=await invoker.invokeRead({operation:'SourceSendData.Root.read',inputs:{}},identity);
        assert.ok('result'in read,JSON.stringify(read));
        assert.ok(!JSON.stringify(read).includes('Hidden source'),'SEND authorization does not expose ungranted row fields');
        const saved=await store.readReceipt({app:'SourceSendData',owner:membership.team_id,principal:membership.user_id,
          operation,operationId:request.operation_id} as Parameters<typeof store.readReceipt>[0]);assert.ok(saved);assert.ok(saved.outcome.status==='committed');
        assertSavedSourceReceipt(artifact,saved);
        const replay=await invoker.invokeMutation(request,identity);
        assertDateReplay(replay,new Date(now+86400000).toISOString().slice(0,10));
        assert.deepEqual(await store.outboxPending(),pending);assert.deepEqual(await store.readReceipt(saved.identity),saved);
      }
      for(const mode of ['allowed','hidden-source','hidden-target','identity-race','source-race']){
        const {now,identities,identity,membership}=await member(`loop-reference-${mode}`);
        const scope={app:'SourceSendData',owner:membership.team_id,ownerPackage:'SourceSendData'};
        const authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'loop-reference-state',fileStoreId:'loop-reference-files',receiver:{app:scope.app,owner:scope.owner,team:scope.owner}};
        const {store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(scope.owner));}});
        const rootModel=model('SourceSendData','Root'),locationModel=model('SourceSendData','Location'),childModel=model('SourceSendData','Child');
        const location={...makeRow({id:asId('location'),data:{enabled:true,visible:mode!=='hidden-target'}}),parent:null};
        const row={...makeRow({id:asId('root'),data:{location:{id:location.id},capacity:'2',checked:false,last:null,source:'Original source',reason:null,secret:'Secret',visible:mode!=='hidden-source'}}),parent:null};
        const children=['first','second'].map(id=>({...makeRow({id:asId(id),data:{active:true}}),parent:{model:rootModel,id:row.id}}));
        await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:locationModel,row:location},{kind:'insert',model:rootModel,row},...children.map(row=>({kind:'insert' as const,model:childModel,row}))]}));
        let raced=false;
        if(mode==='identity-race'){
          const load=store.load.bind(store);store.load=async(model,id)=>{
            if(!raced&&model==='work.dispatch'){raced=true;await identities.removeMembership(membership.membership_id);}
            return load(model,id);
          };
        }
        if(mode==='source-race'){
          const commit=store.commit.bind(store);store.commit=async batch=>{
            if(!raced&&batch.writes.some(write=>write.model==='work.dispatch')){
              raced=true;await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:rootModel,id:row.id,expectedVersion:asVersion(row.version),row:{...row,version:asVersion(row.version+1),data:{...row.data,source:'Changed source'}}}]}));
            }
            return commit(batch);
          };
        }
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const request={operation:'SourceSendData.notify_children',operation_id:operationId(now),inputs:{root:{id:row.id,version:String(row.version)},to:'recipient@example.test'}};
        const outcome=await invoker.invokeMutation(request,identity),allowed=mode==='allowed';
        assert.equal('result'in outcome?outcome.result.status:outcome.error.code,allowed?'committed':mode==='hidden-source'?'rule_failed':mode==='source-race'?'conflict':'forbidden',`${mode}: ${JSON.stringify(outcome)}`);
        const pending=await store.outboxPending();assert.equal(pending.length,allowed?2:0,mode);
        for(const child of children)assert.equal((await store.load(childModel,child.id))!.data.active,!allowed,mode);
        if(mode==='identity-race'||mode==='source-race')assert.equal(raced,true,mode);
        if(allowed){
          for(const intent of pending)assert.deepEqual(intent.arguments,{binding:'SourceSendData.Mail',from:'deployment.mail',arguments:{to:'recipient@example.test',subject:location.id,body:'Original source',attachments:[]}});
          const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay,JSON.stringify(replay));
          assert.deepEqual(await store.outboxPending(),pending);
        }
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });

it('runs original appointment ready and cleanup from genuine retained progress Work',
  {timeout:180000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-book-progress-'));
    try{
      const source=join(root,'compiler/tests/fixtures/book-original-source.can');
      const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
      const artifact=JSON.parse(stdout) as CompileArtifact;
      const asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
      for(const mode of ['initial','movement','waiting','current-row','newer','cancelled','host-released','already-releasing','all-released','missing-room','ref-substitution','stale-source','body-race']){
        const {now,identities,identity,user:actor,membership}=await member('book-progress-'+mode);
        const scope={app:'BookOriginalProbe',owner:membership.team_id,ownerPackage:'appointments'};
        const authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'book-progress-state',fileStoreId:'book-progress-files',receiver:{app:scope.app,owner:scope.owner,team:scope.owner}};
        const {store,probe}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(scope.owner));}});
        const row=(model:string,id:string,data:Record<string,unknown>,parent:{model:ModelName;id:ReturnType<typeof asId>}|null=null)=>({kind:'insert' as const,model:asModel(model),row:{...makeRow({id:asId(id),data}),parent}});
        const calendar={model:asModel('appointments.Calendar'),id:asId('calendar')},type={model:asModel('appointments.Type'),id:asId('type')},visit={model:asModel('appointments.Appointment'),id:asId('visit')};
        const candidate={source:'candidate',kind:mode==='initial'?'initial':'movement',from:'2099-01-01T10:00:00.000Z',until:'2099-01-01T10:30:00.000Z',previous_source:mode==='initial'?null:'original',previous_host_revision:'3',previous_room_revision:'5',requested_by:{id:actor.user_id},state:['cancelled','host-released','already-releasing','all-released','missing-room'].includes(mode)?'cancelled':'pending',host_ok:mode!=='waiting',room_ok:true,host_unknown:false,room_unknown:false,host_revision:'1',room_revision:'1',host_delivery:'candidate-host',room_delivery:'candidate-room',room_confirmation:null,host_release:mode==='already-releasing'?'held-host-release':null,room_release:mode==='already-releasing'?'held-room-release':null,host_released:['host-released','all-released'].includes(mode),room_released:mode==='all-released'};
        await store.commit(makeBatch(await store.readRevision(),{writes:[
          row('rent_catalog.Location','site',{active:true,timezone:'UTC'}),
          row('employee.Employee','host',{user:{id:actor.user_id},active:true,operator_wide:false,home:{id:'site'},locations:[]}),
          row('customer.Customer','customer',{active:true,locations:[{id:'site'}],name:'Customer'}),
          row('customer.Contact','contact',{account:{id:actor.user_id},verified:true,email:'customer@example.test',name:'Contact'},{model:asModel('customer.Customer'),id:asId('customer')}),
          row('appointments.Calendar','calendar',{location:{id:'site'},host:{id:'host'},timezone:'UTC',duration:'1800000',hours:'9-18',instructions:'Reception',cutoff:'3600000',active:true}),
          row('appointments.Type','type',{name:'Tour',duration:'1800000',room:'room-1'},calendar),
          row('appointments.Appointment','visit',{customer:{id:'customer'},contact:{id:'contact'},from:'2099-01-01T09:00:00.000Z',until:'2099-01-01T09:30:00.000Z',duration:'1800000',source:'original',active_source:mode==='newer'?'newer':'original',host:{id:actor.user_id},reservation_account:{id:actor.user_id},room_snapshot:mode==='missing-room'?null:'room-1',state:mode==='initial'?'pending':'confirmed',host_ok:true,room_ok:true,host_delivery:'original-host',room_delivery:'original-room',reason:null,reason_code:null},type),
          row('appointments.Attempt','candidate',candidate,visit),
          row('appointments.Attempt','previous',{...candidate,source:'original',kind:'initial',state:'active',host_revision:'3',room_revision:'5'},visit)
        ]}));
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const request={operation:'appointments.recover_attempt',operation_id:operationId(now),inputs:{attempt:{id:'candidate',version:'1'}}};
        const emitted=await invoker.invokeMutation(request,identity);assert.ok('result'in emitted,mode+': '+JSON.stringify(emitted));
        const sources=await store.query({model:asModel('work.occurrence'),authority:'owner'});
        const progress=sources.find(row=>(row.data['result'] as {event?:string}|undefined)?.event==='appointments.AttemptProgress');assert.ok(progress);
        const deliver=(handler:string)=>invokeRetainedHandlerOccurrenceCanonical({asm,artifact,app:scope.app,store,identities,now:()=>now+1,
          selector:{scope,event:'appointments.AttemptProgress',sourceOccurrence:progress.id,handler:'appointments.'+handler}});
        if(mode==='current-row'){
          const current=await store.load(asModel('appointments.Attempt'),asId('candidate'));assert.ok(current);
          await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:asModel('appointments.Attempt'),id:current.id,expectedVersion:current.version,row:{...current,version:asVersion(current.version+1),data:{...current.data,host_ok:false}}}]}));
        }
        if(mode==='ref-substitution'){
          const result=progress.data['result'] as Record<string,unknown>;
          await assert.rejects(async()=>store.commit(makeBatch(await store.readRevision(),{writes:[{
            kind:'update',model:asModel('work.occurrence'),id:progress.id,expectedVersion:progress.version,
            row:{...progress,version:asVersion(progress.version+1),data:{...progress.data,
              result:{...result,payload:{attempt:{id:'previous',version:'1'}}}}}
          }]})));
          assert.deepEqual(await store.load(asModel('work.occurrence'),progress.id),progress,'opaque Work source forbids another admitted Model identity');
        }
        if(mode==='waiting'){
          const load=store.load.bind(store);
          store.load=async(model,id)=>{assert.notEqual(model,asModel('customer.Contact'),'false prefix avoids Contact ancestry');return load(model,id);};
        }
        let raced=false;
        if(mode==='stale-source'||mode==='body-race'){
          const commit=store.commit.bind(store);
          store.commit=async batch=>{
            if(batch.writes.some(write=>write.model==='appointments.Appointment')){
              raced=true;
              const model=asModel(mode==='stale-source'?'work.occurrence':'appointments.Calendar');
              const current=await store.load(model,mode==='stale-source'?progress.id:asId('calendar'));assert.ok(current);
              await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model,id:current.id,expectedVersion:current.version,row:{...current,version:asVersion(current.version+1),data:mode==='body-race'?{...current.data,instructions:'Changed '+current.version}:current.data}}]}));
            }
            return commit(batch);
          };
        }
        const ready=await deliver('ready').catch(error=>({status:'rejected',error}));
        if(mode==='stale-source'||mode==='body-race'){
          assert.equal(raced,true,mode);assert.notEqual((ready as {status:string}).status,'completed',mode);
          assert.equal((await store.load(asModel('appointments.Appointment'),asId('visit')))?.version,1);
          assert.equal((await store.load(asModel('appointments.Attempt'),asId('candidate')))?.data['state'],'pending');
          assert.equal((await store.query({model:asModel('appointments.Notice'),authority:'owner'})).length,0);
          assert.equal(probe.outboxAll().length,0);continue;
        }
        assert.equal((ready as {status:string}).status,'completed',mode+': '+JSON.stringify(ready));
        assert.equal((await deliver('ready') as {status:string}).status,'replayed');
        const cleanup=await deliver('cleanup').catch(error=>({status:'rejected',error}));
        if(mode==='missing-room'){
          assert.notEqual((cleanup as {status:string}).status,'completed');
          assert.equal((await store.load(asModel('appointments.Attempt'),asId('candidate')))?.data['host_release'],null);
          assert.equal(probe.outboxAll().length,0,'later authored Room Require rolls back the preceding host release');continue;
        }
        assert.equal((cleanup as {status:string}).status,'completed',mode+': '+JSON.stringify(cleanup));
        assert.equal((await deliver('cleanup') as {status:string}).status,'replayed');
        const accepted=['initial','movement','ref-substitution'].includes(mode);
        const current=await store.load(asModel('appointments.Appointment'),asId('visit'));assert.ok(current);
        assert.equal(current.data['from'],accepted?candidate.from:'2099-01-01T09:00:00.000Z',mode);
        const currentAttempt=await store.load(asModel('appointments.Attempt'),asId('candidate'));assert.ok(currentAttempt);
        assert.equal(currentAttempt.data['state'],accepted?'active':['waiting','current-row'].includes(mode)?'pending':mode==='all-released'?'released':'cancelled',mode);
        const previous=await store.load(asModel('appointments.Attempt'),asId('previous'));assert.ok(previous);
        assert.equal(previous.data['state'],mode==='movement'||mode==='ref-substitution'?'retired':'active');
        const notices=await store.query({model:asModel('appointments.Notice'),authority:'owner'});assert.equal(notices.length,accepted?1:0);
        const intents=probe.outboxAll();assert.equal(intents.length,accepted?1:['waiting','current-row','already-releasing','all-released'].includes(mode)?0:mode==='host-released'?1:2,mode);
        if(accepted){assert.equal(notices[0]?.data['source'],'candidate');assert.equal(notices[0]?.data['kind'],'confirmation');assert.equal((notices[0]?.data['delivery'] as {id?:string})?.id,intents[0]?.intentId,'Notice retains the genuine staged Mail delivery');
          assert.equal((intents[0]?.arguments['arguments'] as Record<string,unknown>)['to'],'customer@example.test');
          assert.equal((intents[0]?.arguments['arguments'] as Record<string,unknown>)['body'],'Reception');
          const schedules=await store.query({model:asModel('work.schedule'),authority:'owner'});assert.equal(schedules.length,1);
          assert.equal((schedules[0]?.data['payload'] as {revision?:string})?.revision,String(current.version));
        }else if(intents.length!==0){
          const host=intents.find(intent=>intent.target==='shift.ScheduleV1.release');
          const room=intents.find(intent=>intent.target==='rent_reservations.RoomsV1.release');assert.ok(room);
          assert.deepEqual(room.arguments['arguments'],{source:'candidate',resource:'room-1',reason:'Appointment resource cleanup'});
          if(mode==='host-released')assert.equal(host,undefined);else{assert.ok(host);assert.deepEqual(host.arguments['arguments'],{source:'candidate',revision:'1'});}
        }
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });

it('constructs declared nested Contract SEND arguments through real Values and Work staging',
  {timeout:180000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-declared-contract-send-'));
    try {
      const source=join(root,'compiler/tests/fixtures/declared-contract-send.can');
      const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],
        {cwd:root,timeout:60000,maxBuffer:32*1024*1024});
      const artifact=JSON.parse(stdout) as CompileArtifact;
      const asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,
        stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
      const descriptor=artifact.operations?.find(operation=>operation.name==='worker.notify');assert.ok(descriptor);
      assertSourceOnlyReceipt(artifact,descriptor.name);
      for(const mode of ['allowed','allowed-stored','forbidden-stored','false-guard','invalid-title','membership-during-send'] as const) {
        const {now,identities,identity,membership}=await member(`contract-${mode}`);
        const store=createMemoryStorage(),rootModel=model('worker','Root');
        const owner={...makeRow({id:asId('root'),data:{checked:false,last:null,public:'Readable title',secret:'Hidden stored DATA'}}),parent:null};
        await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:rootModel,row:owner},
          {kind:'insert',model:model('worker','Child'),row:{...makeRow({id:asId('child'),data:{active:mode!=='false-guard'}}),parent:{model:rootModel,id:owner.id}}}]}));
        let revoked=false;
        if(mode==='membership-during-send') {
          const load=store.load.bind(store);
          store.load=async (model,id)=>{
            if(!revoked&&model==='work.dispatch'){
              revoked=true;await identities.removeMembership(membership.membership_id);
            }
            return load(model,id);
          };
        }
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const request={operation:mode==='allowed-stored'?'worker.stored':mode==='forbidden-stored'?'worker.forbidden':'worker.notify',operation_id:operationId(now),inputs:{root:{id:owner.id,version:String(owner.version)},
          ...(mode.endsWith('-stored')?{}:{title:mode==='invalid-title'?'no':'Original title'})}};
        const result=await invoker.invokeMutation(request,identity),success=mode==='allowed'||mode==='allowed-stored';
        assert.equal('result' in result&&result.result.status==='committed',success,`${mode}: ${JSON.stringify(result)}`);
        const row=await store.load(rootModel,owner.id);assert.ok(row);assert.equal(row.data.checked,success,mode);
        const pending=await store.outboxPending();assert.equal(pending.length,success?1:0,mode);
        if(success){
          assert.deepEqual(pending[0]!.arguments,{binding:'worker.Port',from:'deployment.port',arguments:{packet:{
            detail:{title:mode==='allowed-stored'?'Readable title':'Original title',enabled:true,note:'Original',tags:['authored'],mode:'normal'},
            details:[{title:'Second',enabled:true,note:'Original',tags:['authored'],mode:'normal'}],sequence:'7'}}});
          const receipts=await store.query({model:asModel('work.dispatch'),authority:'owner'});assert.equal(receipts.length,1);
          assert.equal(row.data.last,receipts[0]!.id);
          const replay=await invoker.invokeMutation(request,identity);assertDateReplay(replay,new Date(now+86400000).toISOString().slice(0,10),['public']);
          assert.deepEqual(await store.outboxPending(),pending,'no second SEND from replay');
        } else assert.equal(row.data.last,null);
        if(mode==='membership-during-send')assert.ok(revoked,'actual SEND Identity fence reached');
      }
    } finally {await rm(directory,{recursive:true,force:true});}
  });

it('formats original scalar DATA with saved result privacy and commit fences',
  {timeout:120000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-literal-format-'));
    try{
      const {artifact,asm}=await installed('native-literal-format.can',directory);
      for(const mode of ['allowed','no-child','changed-at-commit']){
        const {now,identities,identity,membership}=await member(`literal-format-${mode}`);
        const store=createMemoryStorage(),rootModel=model('LiteralFormat','Root');
        const row={...makeRow({id:asId('root'),data:{code:'Original',checked:false}}),parent:null};
        await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:rootModel,row},
          ...(mode==='no-child'?[]:[{kind:'insert' as const,model:model('LiteralFormat','Child'),row:{
            ...makeRow({id:asId('child'),data:{active:true}}),parent:{model:rootModel,id:row.id}}}])]}));
        if(mode==='changed-at-commit'){
          const commit=store.commit.bind(store);let changed=false;
          store.commit=async batch=>{
            if(!changed){changed=true;await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:rootModel,
              id:row.id,expectedVersion:row.version,row:{...row,version:asVersion(row.version+1),data:{...row.data,code:'Changed'}}}]}));}
            return commit(batch);
          };
        }
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const request={operation:'LiteralFormat.render',operation_id:operationId(now),inputs:{root:{id:row.id,version:String(row.version)}}};
        const outcome=await invoker.invokeMutation(request,identity),allowed=mode==='allowed';
        assert.equal('result'in outcome?outcome.result.status:outcome.error.code,
          allowed?'committed':mode==='changed-at-commit'?'conflict':'rule_failed',`${mode}: ${JSON.stringify(outcome)}`);
        assert.equal((await store.load(rootModel,row.id))?.data.checked,allowed);
        if(allowed){
          assert.ok('result'in outcome);assert.equal(outcome.result.result,'Original:occupancy');
          const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay);assert.equal(replay.result.result,'Original:occupancy');
          await identities.removeMembership(membership.membership_id);
          const denied=await invoker.invokeMutation(request,identity);assert.ok('error'in denied||denied.result.result===null);
        }
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });

it('keeps cancellation result DATA private and cancels only the admitted root through void Work',
  {timeout:180000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-source-only-cancel-'));
    try{
      const {artifact,asm}=await installed('native-source-require-cancel.can',directory);
      for(const name of ['notify','abort'])assertSourceOnlyReceipt(artifact,`SourceGuardCancel.${name}`,'date',[[['SourceGuardCancel.Root','id','data','text']]]);
      const original=await readFile(fixture('native-source-require-cancel.can'),'utf8'),refused=fixture('.native-source-cancel-refusal.can');
      // The original date result retains its complete DATA receipt. The
      // separate void variant isolates Work identity authority from readable
      // Root DATA while keeping every original guard and cancellation intact.
      const voidSource=join(directory,'void-cancel.can');
      await writeFile(voidSource,original.replaceAll(' -> date','').replaceAll('   return add_days(local_date(now,"UTC"),1)\n',''));
      const voidReport=spawnSync(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,voidSource],{cwd:root,encoding:'utf8'});
      assert.equal(voidReport.status,0,voidReport.stdout+voidReport.stderr);
      const voidArtifact=JSON.parse(voidReport.stdout) as CompileArtifact;
      for(const name of ['notify','abort'])assert.equal(voidArtifact.operations?.find(operation=>operation.name===`SourceGuardCancel.${name}`)?.result?.disclosure,undefined);
      const voidAsm=await assembleModules({artifact:voidArtifact,sourcePath:voidSource},{workDir:join(directory,'void'),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
      try{
        for(const text of [original.replaceAll('cancel root.id','cancel "arbitrary"'),
          original.replaceAll('cancel root.id','let key=root.id\n   cancel key')]){
          await writeFile(refused,text);const result=spawnSync(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,refused],{cwd:root,encoding:'utf8'});
          assert.equal(result.status,0,result.stdout+result.stderr);
          const artifact=JSON.parse(result.stdout) as CompileArtifact;
          assert.equal(artifact.operations?.find(operation=>operation.name==='SourceGuardCancel.notify')?.result?.type,'date');
        }
      }finally{await rm(refused,{force:true});}
      for(const mode of ['allowed','twins','nonexistent','other-root','full','inactive','late-invariant','identity-during-cancel','schedule-at-commit','owner-date']){
        const cohort=await member(`source-cancel-${mode}`),{now,identities}=cohort;
        let {identity,membership}=cohort;
        if(mode==='owner-date'){
          const owner=await identities.createUser({email:'source-cancel-owner@owner-search.test',password_hash:'unused',email_verified:true});
          membership=await identities.createMembership({team_id:cohort.team.team_id,user_id:owner.user_id,is_owner:true,roles:[]});
          const token='source-cancel-owner-'+randomBytes(8).toString('hex');
          await identities.createSession({user_id:owner.user_id,token_sha256:await sha256HexText(token),last_team_id:cohort.team.team_id,expires_at:new Date(now+3600000).toISOString()});
          identity=await resolveIdentity(identities,{session_token:token},{clock:createFrozenClock(now)});
        }
        const store=createMemoryStorage(),rootModel=model('SourceGuardCancel','Root');
        const rootRow={...makeRow({id:asId('root-1'),data:{capacity:mode==='full'?'1':'2',checked:false}}),parent:null};
        const root2={...rootRow,id:asId('root-2'),data:{capacity:'2',checked:false}};
        await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:rootModel,row:rootRow},{kind:'insert',model:rootModel,row:root2},
          ...[rootRow,root2].map((root,index)=>({kind:'insert' as const,model:model('SourceGuardCancel','Child'),row:{...makeRow({id:asId(`child-${index}`),
            data:{active:mode!=='inactive'}}),parent:{model:rootModel,id:root.id}}}))]}));
        const scope={app:'SourceGuardCancel',owner:membership.team_id,ownerPackage:'SourceGuardCancel'},foreign={...scope,owner:'foreign-owner'};
        const stageContext={actor:'cancel-fixture',now,operation:'SourceGuardCancel.seed',load:store.load.bind(store),query:store.query.bind(store)};
        const put=async(current:typeof scope,id:string)=>workSchedulePutCommand.stage({key:rootRow.id,scope:current,at:now+10000,
          event:'SourceGuardCancel.Due',payload:{message:'Original schedule'},occurrenceId:id},stageContext);
        const stages=[await put(foreign,'foreign-source'),...(mode==='nonexistent'?[]:[await put(scope,'original-source')]),
          ...(mode==='twins'?[await put(scope,'twin-source')]:[])];
        await store.commit(makeBatch(await store.readRevision(),{writes:stages.flatMap(stage=>stage.writes??[]),schedules:stages.flatMap(stage=>stage.schedules??[])}));
        const scheduleKey=(current:typeof scope,key:string)=>[current.app,current.ownerPackage,current.owner,key].map(encodeURIComponent).join('/');
        const foreignRows=await store.query({model:asModel('work.schedule'),authority:'owner'});
        const foreignRow=foreignRows.find(row=>row.data['scopeOwner']===foreign.owner);assert.ok(foreignRow);
        const foreignSlot=await store.scheduleGet(scheduleKey(foreign,rootRow.id));assert.ok(foreignSlot);
        if(mode==='allowed'){
          const history=await store.historyFor(rootModel,rootRow.id),slot=await store.scheduleGet(scheduleKey(scope,rootRow.id));
          const dateInvoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
          const denied=await dateInvoker.invokeMutation({operation:'SourceGuardCancel.notify',operation_id:operationId(now),inputs:{root:{id:rootRow.id,version:String(rootRow.version)}}},identity);
          assert.ok('error'in denied,JSON.stringify(denied));assert.equal(denied.error.code,'forbidden');
          assert.match(denied.error.message,/row id source authority/);
          assert.deepEqual(await store.load(rootModel,rootRow.id),rootRow);
          assert.deepEqual(await store.historyFor(rootModel,rootRow.id),history);
          assert.deepEqual(await store.query({model:asModel('work.schedule'),authority:'owner'}),foreignRows);
          assert.deepEqual(await store.scheduleGet(scheduleKey(scope,rootRow.id)),slot);
          assert.deepEqual(await store.outboxPending(),[]);
        }
        let raced=false;
        if(mode==='identity-during-cancel'){
          const query=store.query.bind(store);store.query=async spec=>{
            if(!raced&&spec.model==='work.schedule'){raced=true;await identities.removeMembership(membership.membership_id);}
            return query(spec);
          };
        }
        if(mode==='schedule-at-commit'){
          const commit=store.commit.bind(store);store.commit=async batch=>{
            if(batch.writes.some(write=>write.model===rootModel&&write.kind==='update')){
              raced=true;const cancelled=await workScheduleCancelCommand.stage({key:rootRow.id,scope},{...stageContext,actor:'external-cancel',operation:'external-cancel'});
              await commit(makeBatch(await store.readRevision(),{writes:cancelled.writes??[],schedules:cancelled.schedules??[]}));
            }
            return commit(batch);
          };
        }
        const selected=mode==='other-root'?root2:rootRow,operation=mode==='late-invariant'?'SourceGuardCancel.abort':'SourceGuardCancel.notify';
        const request={operation,operation_id:operationId(now),inputs:{root:{id:selected.id,version:String(selected.version)}}};
        const invoker=buildInvoker(mode==='owner-date'?artifact:voidArtifact,mode==='owner-date'?asm:voidAsm,store,{memberships:identities,now:()=>now});
        const outcome=await invoker.invokeMutation(request,identity),allowed=['allowed','twins','nonexistent','other-root','owner-date'].includes(mode);
        assert.equal('result'in outcome&&outcome.result.status==='committed',allowed,`${mode}: ${JSON.stringify(outcome)}`);
        if(mode==='identity-during-cancel')assert.equal('error'in outcome&&outcome.error.code,'forbidden');
        if(mode==='schedule-at-commit')assert.equal('error'in outcome&&outcome.error.code,'busy');
        const current=await store.load(rootModel,selected.id);assert.ok(current);assert.equal(current.data.checked,allowed,mode);
        assert.equal(current.data.capacity,selected.data.capacity,mode);
        assert.deepEqual(await store.load(asModel('work.schedule'),foreignRow.id),foreignRow,'same key in another owner scope is untouched');
        assert.deepEqual(await store.scheduleGet(scheduleKey(foreign,rootRow.id)),foreignSlot);
        const own=(await store.query({model:asModel('work.schedule'),authority:'owner'})).filter(row=>row.data['scopeOwner']===scope.owner);
        assert.equal(own.length,mode==='nonexistent'?0:mode==='twins'?2:1,mode);
        const cancelled=mode==='allowed'||mode==='twins'||mode==='schedule-at-commit'||mode==='owner-date';
        assert.ok(own.every(row=>row.data['state']===(cancelled?'cancelled':'pending')),mode);
        assert.equal(await store.scheduleGet(scheduleKey(scope,rootRow.id))===null,mode==='nonexistent'||cancelled,mode);
        if(mode==='schedule-at-commit')assert.ok(own.every(row=>row.updatedBy==='external-cancel'));
        if(mode==='identity-during-cancel'||mode==='schedule-at-commit')assert.equal(raced,true,mode);
        assert.deepEqual(await store.outboxPending(),[]);
        if(!allowed)continue;
        const visible=await invoker.invokeRead({operation:'SourceGuardCancel.Root.read',inputs:{}},identity);
        if(mode==='owner-date')assert.ok('result'in visible&&((visible.result as {records:unknown[]}).records.length===2));
        else assert.ok('error'in visible||((visible.result as {records:unknown[]}).records.length===0));
        const saved=await store.readReceipt({app:scope.app,owner:scope.owner,principal:membership.user_id,operation,
          operationId:request.operation_id} as Parameters<typeof store.readReceipt>[0]);assert.ok(saved);assert.ok(saved.outcome.status==='committed');
        if(mode==='owner-date')assertSavedSourceReceipt(artifact,saved);else assert.equal(saved.outcome.scenario,undefined);
        const before=await store.query({model:asModel('work.schedule'),authority:'owner'});
        const replay=await invoker.invokeMutation(request,identity);
        if(mode==='owner-date')assertDateReplay(replay,new Date(now+86400000).toISOString().slice(0,10),['capacity','checked']);
        else assert.deepEqual(replay,{result:{status:'replayed',operation_id:request.operation_id,result:null,records:[]}});
        assert.deepEqual(await store.query({model:asModel('work.schedule'),authority:'owner'}),before);assert.deepEqual(await store.readReceipt(saved.identity),saved);
      }
      for(const mode of ['allowed','inactive','late-refusal','identity-race','schedule-race']){
        const {now,identities,identity,membership}=await member(`loop-work-${mode}`);
        const store=createMemoryStorage(),rootModel=model('SourceGuardCancel','Root'),childModel=model('SourceGuardCancel','Child');
        const parent={...makeRow({id:asId('root'),data:{capacity:'3',checked:false}}),parent:null},other={...parent,id:asId('other-root')};
        const children=['first','second','inactive','other-child'].map(id=>({...makeRow({id:asId(id),data:{active:mode!=='inactive'&&id!=='inactive'}}),parent:{model:rootModel,id:id==='other-child'?other.id:parent.id}}));
        await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:rootModel,row:parent},{kind:'insert',model:rootModel,row:other},...children.map(row=>({kind:'insert' as const,model:childModel,row}))]}));
        const scope={app:'SourceGuardCancel',owner:membership.team_id,ownerPackage:'SourceGuardCancel'},foreign={...scope,owner:'foreign-owner'};
        const stageContext={actor:'loop-work-fixture',now,operation:'SourceGuardCancel.seed',load:store.load.bind(store),query:store.query.bind(store)};
        const stages=[];
        for(const current of [scope,foreign])for(const child of children)stages.push(await workSchedulePutCommand.stage({key:child.id,scope:current,at:now+10000,event:'SourceGuardCancel.Due',payload:{message:'Original child schedule'},occurrenceId:`${current.owner}-${child.id}`},stageContext));
        await store.commit(makeBatch(await store.readRevision(),{writes:stages.flatMap(stage=>stage.writes??[]),schedules:stages.flatMap(stage=>stage.schedules??[])}));
        const scheduleKey=(current:typeof scope,id:string)=>[current.app,current.ownerPackage,current.owner,id].map(encodeURIComponent).join('/');
        const foreignSlots=await Promise.all(children.map(child=>store.scheduleGet(scheduleKey(foreign,child.id))));
        let raced=false;const attempts:number[]=[];
        if(mode==='identity-race'){
          const query=store.query.bind(store);store.query=async spec=>{if(!raced&&spec.model==='work.schedule'){raced=true;await identities.removeMembership(membership.membership_id);}return query(spec);};
        }
        if(mode==='schedule-race'){
          const commit=store.commit.bind(store);store.commit=async batch=>{
            if(batch.writes.some(write=>write.model===childModel&&write.kind==='update'))attempts.push(batch.expectedRevision);
            if(!raced&&batch.writes.some(write=>write.model===childModel&&write.kind==='update')){
              raced=true;const stage=await workScheduleCancelCommand.stage({key:children[0]!.id,scope},{...stageContext,actor:'external-cancel',operation:'external-cancel'});
              await commit(makeBatch(await store.readRevision(),{writes:stage.writes??[],schedules:stage.schedules??[]}));
            }
            return commit(batch);
          };
        }
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const request={operation:'SourceGuardCancel.cancel_children',operation_id:operationId(now),inputs:{root:{id:parent.id,version:String(parent.version)},fail:mode==='late-refusal'}};
        const outcome=await invoker.invokeMutation(request,identity),allowed=mode==='allowed'||mode==='schedule-race';
        assert.equal('result'in outcome?outcome.result.status:outcome.error.code,allowed?'committed':mode==='inactive'||mode==='late-refusal'?'rule_failed':'forbidden',`${mode}: ${JSON.stringify(outcome)}`);
        for(const [index,child]of children.entries()){
          const selected=index<2;
          const actual=await store.load(childModel,child.id);assert.ok(actual);
          assert.equal(actual.data.active,allowed&&selected?false:child.data.active,`${mode}: child writes rollback atomically`);
          assert.equal(actual.version,child.version+(allowed&&selected?1:0),`${mode}: each selected child commits at most once`);
          const slot=await store.scheduleGet(scheduleKey(scope,child.id));
          assert.equal(slot===null,allowed&&selected||mode==='schedule-race'&&index===0,`${mode}: only selected original child Work keys change`);
          assert.deepEqual(await store.scheduleGet(scheduleKey(foreign,child.id)),foreignSlots[index],`${mode}: foreign Work scope remains intact`);
        }
        assert.deepEqual(await store.outboxPending(),[]);
        if(mode==='identity-race'||mode==='schedule-race')assert.equal(raced,true,mode);
        if(mode==='schedule-race'){
          assert.equal(attempts.length,2,'stale Work attempt is retried from a new source revision');assert.equal(attempts[1],attempts[0]!+1);
          const external=await store.load(asModel('work.schedule'),asId(`${scope.owner}-${children[0]!.id}`));assert.ok(external);
          assert.equal(external.version,2);assert.equal(external.updatedBy,'external-cancel','fresh retry preserves the concurrent Work cancellation');
        }
        if(allowed){
          const before=await store.query({model:asModel('work.schedule'),authority:'owner'}),replay=await invoker.invokeMutation(request,identity);
          assert.ok('result'in replay,JSON.stringify(replay));assert.equal(replay.result.result,null);
          assert.deepEqual(await store.query({model:asModel('work.schedule'),authority:'owner'}),before,'replay stages no additional Work');
        }
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });

it('passes an original required parent to a helper while retaining both DATA grants',
  {timeout:120000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-parent-helper-'));
    try{
      const {artifact,asm}=await installed('native-parent-helper.can',directory);
      assert.ok(artifact.operations?.find(operation=>operation.name==='ParentHelper.act')?.result?.disclosure);
      for(const mode of ['allowed','hidden','inactive','changed-at-commit','hidden-at-commit']){
        const {now,identities,identity}=await member(`parent-helper-${mode}`);
        const store=createMemoryStorage(),parentModel=model('ParentHelper','Parent'),childModel=model('ParentHelper','Child');
        const parent={...makeRow({id:asId('parent'),data:{label:'Original parent',visible:mode!=='hidden'}}),parent:null};
        const child={...makeRow({id:asId('child'),data:{active:mode!=='inactive',checked:false}}),parent:{model:parentModel,id:parent.id}};
        await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:parentModel,row:parent},{kind:'insert',model:childModel,row:child}]}));
        const updateParent=async(data:Record<string,unknown>)=>{
          const current=await store.load(parentModel,parent.id);assert.ok(current);
          await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:parentModel,id:current.id,
            expectedVersion:current.version,row:{...current,version:asVersion(current.version+1),data:{...current.data,...data}}}]}));
        };
        if(mode.endsWith('at-commit')){
          const commit=store.commit.bind(store);let injecting=false;
          store.commit=async batch=>{
            if(!injecting){injecting=true;try{await updateParent(mode==='hidden-at-commit'?{visible:false}:{label:'Changed parent'});}finally{injecting=false;}}
            return commit(batch);
          };
        }
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const request={operation:'ParentHelper.act',operation_id:operationId(now),inputs:{child:{id:child.id,version:String(child.version)}}};
        const outcome=await invoker.invokeMutation(request,identity),allowed=mode==='allowed';
        assert.equal('result'in outcome,allowed,`${mode}: ${JSON.stringify(outcome)}`);
        assert.equal((await store.load(childModel,child.id))?.data.checked,allowed,'failed helper DATA or stale parent rolls back the preceding SET');
        if(allowed){
          assert.ok('result'in outcome);assert.equal(outcome.result.result,'Original parent');
          const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay);assert.equal(replay.result.result,'Original parent');
          await updateParent({visible:false});const hidden=await invoker.invokeMutation(request,identity);
          assert.ok('error'in hidden||hidden.result.result===null,'replay cannot disclose the now-hidden parent');
        }
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });

it('schedules original admitted roots through genuine Work sources and ordinary replay privacy',
  {timeout:180000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-source-only-schedule-'));
    try{
      const {artifact,asm}=await installed('native-source-require-schedule.can',directory);
      for(const name of ['notify','abort'])assertSourceOnlyReceipt(artifact,`SourceGuardSchedule.${name}`);
      const original=await readFile(fixture('native-source-require-schedule.can'),'utf8');
      const refused=join(directory,'literal-key.can');
      await writeFile(refused,original.replaceAll('schedule root.id at=now','schedule "arbitrary" at=now'));
      const report=spawnSync(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,refused],{cwd:root,encoding:'utf8'});
      assert.equal(report.status,10,report.stdout+report.stderr);
      assert.ok((JSON.parse(report.stdout) as {diagnostics:{code:string}[]}).diagnostics.some(item=>item.code==='E3001'));
      const hiddenPath=join(directory,'hidden-data.can');
      await writeFile(hiddenPath,original.replaceAll('event=Checked {root,message}','event=Checked {root,message=root.secret}'));
      const compiled=spawnSync(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,hiddenPath],{cwd:root,encoding:'utf8'});
      assert.equal(compiled.status,0,compiled.stdout+compiled.stderr);
      const hiddenArtifact=JSON.parse(compiled.stdout) as CompileArtifact;
      const hiddenAsm=await assembleModules({artifact:hiddenArtifact,sourcePath:hiddenPath},{workDir:join(directory,'hidden'),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
      for(const mode of ['allowed','hidden-data','replacement','full','inactive','other-parent','invariant-after-schedule','identity-during-source-stage','root-at-commit','missing-inventory']){
        const {now,identities,identity,membership}=await member(`source-schedule-${mode}`);
        const scope={app:'SourceGuardSchedule',owner:membership.team_id,ownerPackage:'SourceGuardSchedule'};
        const authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'source-schedule-state',fileStoreId:'source-schedule-files',
          receiver:{app:scope.app,owner:scope.owner,team:scope.owner}};
        const {store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
        if(mode!=='missing-inventory')await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,
          verifyOwner:async()=>{assert.ok(await identities.findTeamById(scope.owner));}});
        const rootModel=model('SourceGuardSchedule','Root');
        const rootRow={...makeRow({id:asId('root-1'),data:{capacity:mode==='full'?'1':'2',checked:false,seen:false,secret:'Hidden field'}}),parent:null};
        await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:rootModel,row:rootRow},
          {kind:'insert',model:rootModel,row:{...rootRow,id:asId('root-2')}},
          {kind:'insert',model:model('SourceGuardSchedule','Child'),row:{...makeRow({id:asId('child-1'),data:{active:mode!=='inactive'}}),
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
            if(!raced&&batch.writes.some(write=>write.model==='work.schedule')){
              raced=true;
              await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:rootModel,id:rootRow.id,
                expectedVersion:asVersion(rootRow.version),row:{...rootRow,version:asVersion(rootRow.version+1),archivedAt:now}}]}));
            }
            return commit(batch);
          };
        }
        const invoker=buildInvoker(mode==='hidden-data'?hiddenArtifact:artifact,mode==='hidden-data'?hiddenAsm:asm,store,{memberships:identities,now:()=>now});
        const request={operation:mode==='invariant-after-schedule'?'SourceGuardSchedule.abort':'SourceGuardSchedule.notify',operation_id:operationId(now),
          inputs:{root:{id:rootRow.id,version:String(rootRow.version)},message:'Original event'}};
        const outcome=await invoker.invokeMutation(request,identity);
        const allowed=mode==='allowed'||mode==='replacement';
        assert.equal('result'in outcome&&outcome.result.status==='committed',allowed,`${mode}: ${JSON.stringify(outcome)}`);
        if(mode==='identity-during-source-stage')assert.equal('error'in outcome&&outcome.error.code,'validation');
        if(mode==='root-at-commit')assert.equal('error'in outcome&&outcome.error.code,'conflict');
        const sources=await store.query({model:asModel('work.schedule'),authority:'owner'});
        assert.equal(sources.length,allowed?1:0,mode);
        const actual=await store.load(rootModel,rootRow.id);assert.ok(actual);assert.equal(actual.data.checked,allowed,mode);assert.equal(actual.data.seen,false);
        if(mode==='identity-during-source-stage'||mode==='root-at-commit')assert.equal(raced,true,mode);
        if(!allowed)continue;
        let source=sources[0]!;
        assert.deepEqual(source.data['payload'],{root:{id:rootRow.id,version:String(actual.version)},message:'Original event'});
        assert.equal(source.data['state'],'pending');assert.equal(source.data['key'],rootRow.id);
        assert.equal(source.data['scopeOwner'],scope.owner);assert.equal(source.data['scopeOwnerPackage'],scope.ownerPackage);
        const key=[scope.app,scope.ownerPackage,scope.owner,rootRow.id].map(encodeURIComponent).join('/');
        assert.ok(await store.scheduleGet(key));
        const saved=await store.readReceipt({app:'SourceGuardSchedule',owner:membership.team_id,principal:membership.user_id,
          operation:request.operation,operationId:request.operation_id} as Parameters<typeof store.readReceipt>[0]);assert.ok(saved);
        assertSavedSourceReceipt(artifact,saved);
        const visible=await invoker.invokeRead({operation:'SourceGuardSchedule.Root.read',inputs:{}},identity);
        assert.ok('error'in visible||((visible.result as {records:unknown[]}).records.length===0));
        const replay=await invoker.invokeMutation(request,identity);
        assert.ok('result'in outcome);assert.equal(typeof outcome.result.result,'string');
        assertDateReplay(replay,outcome.result.result as string);
        assert.deepEqual(await store.query({model:asModel('work.schedule'),authority:'owner'}),sources);
        if(mode==='replacement'){
          const again=await invoker.invokeMutation({...request,operation_id:operationId(now),inputs:{root:{id:rootRow.id,version:String(actual.version)},message:'Replacement event'}},identity);
          assert.ok('result'in again&&again.result.status==='committed',JSON.stringify(again));
          const replaced=await store.load(asModel('work.schedule'),source.id);assert.ok(replaced);assert.equal(replaced.data['state'],'superseded');
          const all=await store.query({model:asModel('work.schedule'),authority:'owner'});assert.equal(all.length,2);
          const next=all.find(row=>row.id!==source.id);assert.ok(next);assert.equal(next.data['replaces'],source.id);
          assert.equal(next.data['state'],'pending');assert.deepEqual(next.data['payload'],{root:{id:rootRow.id,version:String(actual.version+1)},message:'Replacement event'});
          source=next;
        }
        const deliver=()=>invokeDueScheduleCanonical({asm,artifact,app:scope.app,store,identities,now:()=>now,
          handler:'SourceGuardSchedule.observe',due:{key:rootRow.id,scope,at:now,event:'SourceGuardSchedule.Checked',occurrenceId:source.id}});
        assert.equal((await deliver() as {status:string}).status,'completed');
        assert.equal((await deliver() as {status:string}).status,'replayed');
        assert.equal((await store.load(rootModel,rootRow.id))?.data.seen,true);
        assert.deepEqual(await store.readReceipt(saved.identity),saved,'consumer never rewrites the ordinary source receipt');
      }
      const full=artifact.operations?.find(operation=>operation.name==='SourceGuardSchedule.notify_content')?.result?.disclosure;
      assert.ok(full,'genuine native content DATA receipt required');
      assert.ok(full.returns.some(returned=>returned.dependencies.some(read=>read.model==='SourceGuardSchedule.Content'&&read.field==='message'&&read.role==='data')));
      assert.ok(full.returns.every(returned=>returned.dependencies.every(read=>read.model!=='SourceGuardSchedule.Root'||read.field!=='id'||read.role!=='data')),'Work key must not mint root DATA');
      for(const mode of ['native-allowed','native-hidden-content','native-identity-race','native-root-race']){
        const {now,identities,identity,membership}=await member(mode);
        const scope={app:'SourceGuardSchedule',owner:membership.team_id,ownerPackage:'SourceGuardSchedule'};
        const authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'native-work-key',fileStoreId:'native-work-key-files',receiver:{app:scope.app,owner:scope.owner,team:scope.owner}};
        const {store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(scope.owner));}});
        const rootModel=model('SourceGuardSchedule','Root'),rootRow=makeRow({id:asId('root'),data:{capacity:'2',checked:false,seen:false,secret:'Hidden field'}});
        await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:rootModel,row:rootRow},
          {kind:'insert',model:model('SourceGuardSchedule','Content'),row:makeRow({id:asId('content'),data:{message:'Original content',visible:mode!=='native-hidden-content'}})},
          {kind:'insert',model:model('SourceGuardSchedule','Child'),row:{...makeRow({id:asId('child'),data:{active:true}}),parent:{model:rootModel,id:rootRow.id}}}]}));
        let raced=false;const inventory=store.readFileReferenceInventory.bind(store),commit=store.commit.bind(store);
        store.readFileReferenceInventory=async owner=>{if(mode==='native-identity-race'&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}return inventory(owner);};
        store.commit=async batch=>{if(mode==='native-root-race'&&!raced&&batch.writes.some(write=>write.model==='work.schedule')){
          raced=true;await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:rootModel,id:rootRow.id,expectedVersion:rootRow.version,row:{...rootRow,version:asVersion(rootRow.version+1),archivedAt:now}}]}));
        }return commit(batch);};
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const request={operation:'SourceGuardSchedule.notify_content',operation_id:operationId(now),inputs:{root:{id:'root',version:'1'},content:{id:'content',version:'1'}}};
        const result=await invoker.invokeMutation(request,identity),allowed=mode==='native-allowed';
        assert.equal('result'in result,allowed,mode+': '+JSON.stringify(result));
        if(mode.endsWith('-race'))assert.equal(raced,true,mode);
        const sources=await store.query({model:asModel('work.schedule'),authority:'owner'});
        assert.equal(sources.length,allowed?1:0,mode);assert.equal((await store.load(rootModel,rootRow.id))?.data.checked,allowed,mode);
        if(allowed){assert.equal(sources[0]!.data.key,'root');assert.deepEqual(sources[0]!.data.payload,{root:{id:'root',version:'2'},message:'Original content'});
          const visible=await invoker.invokeRead({operation:'SourceGuardSchedule.Root.read',inputs:{}},identity);
          assert.ok('error'in visible||((visible.result as {records:unknown[]}).records.length===0),'native Work authority grants no root read');
        }
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });

it('projects the original Invoice document child arrays through ordinary field DATA grants',
  {timeout:180000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-invoice-document-projection-'));
    try{
      const source=join(root,'compiler/tests/fixtures/invoice-document-source-projection.can');
      const original=await readFile(join(root,'draft/apps/CanInvoice/CanInvoice.can'),'utf8'),text=await readFile(source,'utf8');
      const start=original.indexOf('  scenario document('),end=original.indexOf('   examples ',start);
      assert.ok(text.includes(original.slice(start,end)),'complete original document owner is retained');
      assert.ok(text.includes(original.split('\n').find(line=>line.startsWith('  derive issued_snapshot('))!),'complete original snapshot helper is retained');
      const receiptStart=original.indexOf('  scenario generate_receipt('),receiptEnd=original.indexOf('   examples ',receiptStart);
      assert.ok(text.includes(original.slice(receiptStart,receiptEnd)),'complete original receipt owner is retained');
      for(const name of ['refund_payment','record_refund','record_payment']){
        const start=original.indexOf(`  scenario ${name}(`),end=original.indexOf('   do',start);
        for(const guard of original.slice(start,end).split('\n').filter(line=>line.startsWith('   require '))){
          if(name==='record_refund'&&guard.includes('not any(ExternalRefund'))continue;
          assert.ok(text.includes(guard),'exact original correlated refund guard is retained');
        }
      }
      const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],
        {cwd:root,timeout:60000,maxBuffer:32*1024*1024});
      const artifact=JSON.parse(stdout) as CompileArtifact,asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,
        stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
      for(const mode of ['allowed','hidden-row','other-parent','withheld-field','worker-inactive','role-during-send','child-at-commit','grant-at-commit','parent-at-commit','overflow','receipt-allowed','receipt-unsettled','receipt-pending','receipt-pending-at-commit','refund-allowed','refund-over','external-refund-allowed','external-refund-over','refund-at-commit','payment-allowed','payment-duplicate','payment-foreign-duplicate','payment-at-commit','credit-positive','credit-false','credit-hidden','credit-at-commit','credit-role-loss'] as const){
        if(process.env['CAN_INVOICE_DOCUMENT_CASE']&&!process.env['CAN_INVOICE_DOCUMENT_CASE'].split(',').includes(mode))continue;
        const creditReview=mode.startsWith('credit-');
        const paymentAllowance=mode.startsWith('payment-');
        const allowance=paymentAllowance||mode.startsWith('refund-')||mode.startsWith('external-refund-');
        const {now,identities,identity,team,user}=await member(`invoice-document-${mode}`,['invoice.finance']);
        const scope={app:'CanInvoice',owner:team.team_id,ownerPackage:'invoice'};
        const authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'document-state',fileStoreId:'document-files',
          receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
        const {store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
        const row=(id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({...makeRow({id:asId(id),data}),parent});
        const location=row('location',{active:true}),customer=row('customer',{kind:'company',hidden:false});
        const invoice=row('invoice',{location:{id:location.id},source:'original-invoice',ledger_revision:'0',currency:'EUR',state:'issued',total:{minor:paymentAllowance?'1100':allowance?'100':mode==='receipt-allowed'||mode.startsWith('receipt-pending')?'900':'2000',currency:'EUR'},
          issuer:'Original issuer',recipient:'Original recipient',address:'1 Road',tax_reference:null,terms:'Net 14',due:'2026-12-01',number:'INV-1',issued_at:new Date(now).toISOString(),hidden:false,needs_review:false},
          {model:model('customer','Customer'),id:customer.id});
        const child={model:model('invoice','Invoice'),id:invoice.id};
        const first=row('line-a',{description:'First',position:'10',quantity:'2',unit:'seat',service_from:null,service_until:null,service_location:null,service_reference:null,
          price:{minor:'1000',currency:'EUR'},tax:{minor:'100',currency:'EUR'},discount:{minor:'100',currency:'EUR'},tax_readable:mode!=='withheld-field',hidden:mode==='hidden-row'},child);
        const second=row('line-b',{...first.data,description:'Second',position:'2',hidden:false},child);
        await store.commit(makeBatch(await store.readRevision(),{writes:[
          {kind:'insert',model:model('rent_catalog','Location'),row:location},{kind:'insert',model:model('customer','Customer'),row:customer},
          {kind:'insert',model:model('employee','Employee'),row:row('worker',{user:{id:user.user_id},home:{id:location.id},locations:[],operator_wide:false,active:mode!=='worker-inactive',hidden:true})},
          {kind:'insert',model:model('invoice','Invoice'),row:invoice},{kind:'insert',model:model('invoice','Line'),row:first},{kind:'insert',model:model('invoice','Line'),row:second},
          {kind:'insert',model:model('invoice','Credit'),row:row('credit',{amount:{minor:'100',currency:'EUR'},reason:'Original credit',hidden:mode==='credit-hidden'},child)},
          {kind:'insert',model:model('invoice','Attempt'),row:row('attempt',{reference:'payment-1',amount:{minor:'500',currency:'EUR'},kind:'collection',status:mode==='receipt-pending'?'pending':'succeeded',received:new Date(now).toISOString(),hidden:false},child)},
          {kind:'insert',model:model('invoice','ExternalPayment'),row:row('external',{reference:'bank-1',evidence:'Original bank proof',amount:{minor:'400',currency:'EUR'},received:new Date(now).toISOString(),hidden:mode==='payment-duplicate'},child)},
          {kind:'insert',model:model('invoice','ExternalRefund'),row:row('refund',{payment:{id:asId('external')},reference:'refund-1',amount:{minor:mode==='external-refund-over'?'390':'100',currency:'EUR'},received:new Date(now).toISOString(),hidden:false},child)},
        ]}));
        if(mode==='payment-foreign-duplicate'||mode==='payment-at-commit')await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:model('invoice','Invoice'),row:{...invoice,id:asId('foreign-invoice'),data:{...invoice.data,source:'foreign-invoice'}}},...(mode==='payment-foreign-duplicate'?[{kind:'insert' as const,model:model('invoice','ExternalPayment'),row:row('foreign-payment',{reference:'new-payment',evidence:'Hidden bank proof',amount:{minor:'100',currency:'EUR'},received:new Date(now).toISOString(),hidden:true},{model:model('invoice','Invoice'),id:asId('foreign-invoice')})}]:[])]}));
        if(mode.startsWith('refund-'))await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:model('invoice','Attempt'),row:row('prior-refund',{reference:'prior-refund',amount:{minor:mode==='refund-over'?'499':'20',currency:'EUR'},kind:'refund',payment:'payment-1',status:'succeeded',received:new Date(now).toISOString(),hidden:true},child)}]}));
        if(mode==='other-parent')await store.commit(makeBatch(await store.readRevision(),{writes:[
          {kind:'insert',model:model('invoice','Invoice'),row:{...invoice,id:asId('foreign-invoice')}},
          {kind:'insert',model:model('invoice','Line'),row:{...first,id:asId('foreign-line'),data:{...first.data,description:'Foreign secret'},parent:{model:model('invoice','Invoice'),id:asId('foreign-invoice')}}},
        ]}));
        if(mode==='overflow')await store.commit(makeBatch(await store.readRevision(),{writes:Array.from({length:199},(_,index)=>({kind:'insert' as const,
          model:model('invoice','Line'),row:{...first,id:asId(`overflow-${String(index).padStart(3,'0')}`)}}))}));
        let raced=false;
        if(mode==='role-during-send'){
          const load=store.load.bind(store);store.load=async(model,id)=>{
            if(!raced&&model==='work.dispatch'){raced=true;const membership=await identities.findMembership(team.team_id,user.user_id);assert.ok(membership);await identities.setMembershipRoles(membership.membership_id,[]);}
            return load(model,id);
          };
        }
        if(mode==='child-at-commit'||mode==='grant-at-commit'||mode==='parent-at-commit'||mode==='receipt-pending-at-commit'||mode==='refund-at-commit'||mode==='payment-at-commit'){
          const commit=store.commit.bind(store);store.commit=async batch=>{
            if(!raced&&batch.writes.some(write=>write.model==='work.dispatch'||(mode==='refund-at-commit'||mode==='payment-at-commit')&&write.model===model('invoice','Invoice'))){
              raced=true;
              if(mode==='payment-at-commit')await commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:model('invoice','ExternalPayment'),row:row('payment-race',{reference:'new-payment',evidence:'Concurrent bank proof',amount:{minor:'100',currency:'EUR'},received:new Date(now).toISOString(),hidden:true},{model:model('invoice','Invoice'),id:asId('foreign-invoice')})}]}));
              else if(mode==='refund-at-commit')await commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:model('invoice','Attempt'),row:row('refund-race',{reference:'refund-race',amount:{minor:'431',currency:'EUR'},kind:'refund',payment:'payment-1',status:'succeeded',received:new Date(now).toISOString(),hidden:true},child)}]}));
              else if(mode==='receipt-pending-at-commit')await commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:model('invoice','Attempt'),row:row('pending-race',{reference:'pending-race',amount:{minor:'1',currency:'EUR'},kind:'collection',status:'pending',received:null,hidden:true},child)}]}));
              else if(mode==='parent-at-commit')await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:model('invoice','Invoice'),id:invoice.id,
                expectedVersion:invoice.version,row:{...invoice,version:asVersion(invoice.version+1),data:{...invoice.data,hidden:true}}}]}));
              else await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:model('invoice','Line'),id:first.id,expectedVersion:first.version,
                row:{...first,version:asVersion(first.version+1),data:{...first.data,...(mode==='grant-at-commit'?{tax_readable:false}:{description:'Concurrent source'})}}}]}));
            }
            return commit(batch);
          };
        }
        if(mode==='credit-role-loss'){
          const query=store.query.bind(store);store.query=async request=>{
            if(!raced&&request.model===model('invoice','Credit')){
              raced=true;const current=await identities.findMembership(team.team_id,user.user_id);assert.ok(current);await identities.setMembershipRoles(current.membership_id,[]);
            }
            return query(request);
          };
        }
        if(mode==='credit-at-commit'){
          const commit=store.commit.bind(store);store.commit=async batch=>{
            if(!raced&&batch.writes.some(write=>write.model===model('invoice','Credit'))){
              raced=true;
              await commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:model('invoice','ExternalRefund'),row:row('credit-race',{payment:{id:asId('external')},reference:'credit-race',amount:{minor:'1000',currency:'EUR'},received:new Date(now).toISOString(),hidden:true},child)}]}));
            }
            return commit(batch);
          };
        }
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const request={operation:creditReview?'invoice.credit_review':paymentAllowance?'invoice.record_payment_allowance':mode.startsWith('refund-')?'invoice.refund_allowance':mode.startsWith('external-refund-')?'invoice.external_refund_allowance':mode.startsWith('receipt-')?'invoice.generate_receipt':'invoice.document',operation_id:operationId(now),inputs:{invoice:{id:invoice.id,version:String(invoice.version)},...(creditReview?{amount:{minor:mode==='credit-false'?'1100':'1200',currency:'EUR'},reason:'Reviewed credit'}:paymentAllowance?{amount:{minor:'100',currency:'EUR'},reference:mode==='payment-duplicate'?'bank-1':'new-payment',received:new Date(now).toISOString(),evidence:'Bank proof'}:allowance?{payment:{id:asId(mode.startsWith('refund-')?'attempt':'external'),version:'1'},amount:{minor:'50',currency:'EUR'},reason:'Approved allowance',...(mode.startsWith('external-refund-')?{reference:'new-refund',received:new Date(now).toISOString(),evidence:'Bank proof'}:{})}:{})}};
        const result=await invoker.invokeMutation(request,identity),success=['allowed','hidden-row','other-parent','child-at-commit','receipt-allowed','refund-allowed','external-refund-allowed','payment-allowed','credit-positive','credit-false','credit-hidden','credit-at-commit'].includes(mode);
        assert.equal('result'in result&&result.result.status==='committed',success,`${mode}: ${JSON.stringify(result)}`);
        const pending=await store.outboxPending();assert.equal(pending.length,success&&!allowance&&!creditReview?1:0,mode);
        assert.equal((await store.query({model:model('invoice','DocumentRequest'),authority:'owner'})).length,success&&!allowance&&!creditReview?1:0,mode);
        if(['child-at-commit','grant-at-commit','parent-at-commit','role-during-send','receipt-pending-at-commit','refund-at-commit','payment-at-commit'].includes(mode))assert.ok(raced,'actual final race reached');
        if(creditReview){
          const current=await store.load(model('invoice','Invoice'),invoice.id);assert.ok(current);
          assert.equal(current.data.needs_review,success&&mode!=='credit-false'&&mode!=='credit-at-commit',mode);
          assert.equal(current.data.ledger_revision,success?'1':'0',mode);
          assert.equal((await store.query({model:model('invoice','Credit'),authority:'owner'})).length,success?2:1,mode);
          if(mode==='credit-at-commit'||mode==='credit-role-loss')assert.ok(raced,'actual staged-decision fence reached');
          if(success){const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay&&replay.result.status==='replayed');assert.equal(replay.result.result,null);}
          continue;
        }
        if(paymentAllowance){
          assert.equal((await store.query({model:model('invoice','ExternalPayment'),authority:'owner'})).length,success||mode==='payment-at-commit'||mode==='payment-foreign-duplicate'?2:1,mode);
          assert.equal((await store.load(model('invoice','Invoice'),invoice.id))!.data.ledger_revision,success?'1':'0',mode);
          continue;
        }
        if(allowance){
          assert.equal((await store.load(model('invoice','Invoice'),invoice.id))!.data.terms,success?'Approved allowance':'Net 14',mode);
          if(success){const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay&&replay.result.status==='replayed');assert.equal(replay.result.result,null);}
          continue;
        }
        if(!success)continue;
        const snapshot=(pending[0]!.arguments as {arguments:{snapshot:{lines:{title:string}[];credits:{reason:string}[];payments:{reference:string}[]}}}).arguments.snapshot;
        assert.deepEqual(snapshot.lines.map(line=>line.title),mode==='hidden-row'?['Second']:mode==='child-at-commit'?['Second','Concurrent source']:['Second','First']);
        assert.deepEqual(snapshot.credits.map(credit=>credit.reason),['Original credit']);
        assert.deepEqual(snapshot.payments.map(payment=>payment.reference),['payment-1','bank-1','refund-1']);
        const replay=await invoker.invokeMutation(request,identity);
        assert.ok('result'in replay&&replay.result.status==='replayed',JSON.stringify(replay));
        assert.equal(replay.result.result,null,'void replay returns only its technical receipt');
        assert.deepEqual(await store.outboxPending(),pending,'replay does not reevaluate or resend the private snapshot');
        assert.equal((await store.query({model:model('invoice','DocumentRequest'),authority:'owner'})).length,1);
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });

it('consumes original post-SET parent COUNT in an atomic ResourcePolicy CREATE', {timeout:240000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'can-constructor-count-'));
  try{
    const originalSource=join(root,'compiler/tests/fixtures/rent-restore-count-source.can');
    for(const manyGuards of [false,true]){
    const source=manyGuards?join(directory,'many-guards.can'):originalSource;
    const original=await readFile(originalSource,'utf8');
    if(manyGuards)await writeFile(source,original.replace('require can_work(actor,downtime.parent.location) and downtime.active',
      `require ${Array(4).fill('can_work(actor,downtime.parent.location)').join(' and ')} and downtime.active`));
    const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
    const artifact=JSON.parse(stdout) as CompileArtifact;
    const asm=await assembleModules({artifact,sourcePath:source},{workDir:join(directory,manyGuards?'many':'single'),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
    for(const mode of ['empty','siblings','other-parent','stale','inactive','policy-denied','insert-race','update-race','identity-race','grant-race']){
      const {now,identities,identity,user:actor,membership}=await member('constructor-count-'+mode,['rent_reservations.reservation_manager']);
      const {store}=createTestMemoryStorage();
      const resource={model:asModel('rent_reservations.Resource'),id:asId('resource')};
      const row=(model:string,id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({kind:'insert' as const,model:asModel(model),row:{...makeRow({id:asId(id),data}),parent}});
      const value={active:true,capacity:'7',pooled:false,timezone:'UTC'};
      const policy=(id:string,sequence:string,parent=resource)=>row('rent_reservations.ResourcePolicy',id,{effective:new Date(now).toISOString(),sequence,baseline:false,value},parent);
      await store.commit(makeBatch(await store.readRevision(),{writes:[
        row('rent_catalog.Location','site',{active:true}),
        row('employee.Employee','operator',{user:{id:actor.user_id},active:mode!=='policy-denied',operator_wide:false,home:{id:'site'},locations:[]}),
        row('rent_reservations.Resource','resource',{location:{id:'site'},...value}),
        row('rent_reservations.Resource','other-resource',{location:{id:'site'},...value}),
        row('rent_reservations.Downtime','downtime',{source:'original',from:new Date(now-1000).toISOString(),until:null,reason:'maintenance',active:mode!=='inactive',verified_by:null,verification:null},resource),
        ...(mode==='empty'?[]:[policy('one','1'),policy('two','2')]),
        policy('foreign','1',{model:resource.model,id:asId('other-resource')})
      ]}));
      const query=store.query.bind(store),load=store.load.bind(store),commit=store.commit.bind(store);let raced=false,raceNumber=0;
      store.query=async spec=>{
        const rows=await query(spec);
        if(spec.model==='rent_reservations.ResourcePolicy'&&mode==='identity-race'&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}
        return rows;
      };
      store.commit=async batch=>{
        if(['insert-race','update-race','grant-race'].includes(mode)&&batch.writes.some(write=>write.kind==='insert'&&write.model==='rent_reservations.ResourcePolicy')){
          raced=true;raceNumber++;
          if(mode==='insert-race')await commit(makeBatch(await store.readRevision(),{writes:[policy('inserted:'+raceNumber,String(8+raceNumber))]}));
          else{
            const model=asModel(mode==='grant-race'?'employee.Employee':'rent_reservations.ResourcePolicy');
            const current=await load(model,asId(mode==='grant-race'?'operator':'one'));assert.ok(current);
            await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model,id:current.id,expectedVersion:current.version,row:{...current,version:asVersion(current.version+1),data:{...current.data,...(mode==='grant-race'?{active:false}:{baseline:current.data['baseline']!==true})}}}]}));
          }
        }
        return commit(batch);
      };
      const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
      const operation_id=operationId(now),request={operation:'rent_reservations.restore',operation_id,inputs:{downtime:{id:'downtime',version:mode==='stale'?'2':'1'},evidence:'Checked'}};
      const result=await invoker.invokeMutation(request,identity);
      const success=['empty','siblings','other-parent'].includes(mode);
      assert.equal('result'in result,success,`${manyGuards?'many':'single'} ${mode}: `+JSON.stringify(result));
      if(mode.endsWith('-race'))assert.equal(raced,true,mode);
      const downtime=await load(asModel('rent_reservations.Downtime'),asId('downtime'));assert.ok(downtime);
      const policies=(await query({model:asModel('rent_reservations.ResourcePolicy'),authority:'owner'})).filter(row=>row.parent?.id==='resource');
      const created=policies.filter(row=>!['one','two'].includes(row.id)&&!row.id.startsWith('inserted:'));
      assert.equal(created.length,success?1:0,mode+': no partial snapshot');
      assert.equal(downtime.version,success?asVersion(2):asVersion(1),mode+': preceding SET is atomic');
      if(success){
        assert.equal(created[0]!.data['sequence'],mode==='empty'?'1':'3');
        assert.deepEqual(created[0]!.data['value'],value);
        assert.equal(downtime.data['active'],false);
        const receipt=await store.readReceipt({app:'ConstructorCount',owner:membership.team_id,principal:membership.user_id,operation:request.operation,operationId:operation_id} as Parameters<typeof store.readReceipt>[0]);
        const before=await query({model:asModel('rent_reservations.ResourcePolicy'),authority:'owner'});
        const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay,mode+': '+JSON.stringify(replay));
        assert.deepEqual(await query({model:asModel('rent_reservations.ResourcePolicy'),authority:'owner'}),before);
        assert.equal((await load(asModel('rent_reservations.Downtime'),asId('downtime')))!.version,asVersion(2));
        assert.ok(receipt);
      }
    }
    for(const hidden of [false,true]){
      const {now,identities,identity}=await member('count-visibility-'+hidden);
      const {store}=createTestMemoryStorage(),parent={model:asModel('count_visibility.Root'),id:asId('root')};
      await store.commit(makeBatch(await store.readRevision(),{writes:[
        {kind:'insert',model:parent.model,row:makeRow({id:parent.id,data:{label:'root'}})},
        {kind:'insert',model:asModel('count_visibility.Snapshot'),row:{...makeRow({id:asId('existing'),data:{sequence:'1',hidden}}),parent}}
      ]}));
      const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
      const result=await invoker.invokeMutation({operation:'count_visibility.snapshot',operation_id:operationId(now),inputs:{root:{id:'root',version:'1'}}},identity);
      assert.equal('result'in result,!hidden,'hidden sibling cannot become an undercount: '+JSON.stringify(result));
      const rows=await store.query({model:asModel('count_visibility.Snapshot'),authority:'owner'});
      assert.equal(rows.length,hidden?1:2);
      if(!hidden){
        assert.equal(rows.find(row=>row.id!=='existing')!.data['sequence'],'2');
        const second=await invoker.invokeMutation({operation:'count_visibility.snapshot_after_writes',operation_id:operationId(now),inputs:{root:{id:'root',version:'1'}}},identity);
        assert.ok('result'in second,JSON.stringify(second));
        const after=await store.query({model:asModel('count_visibility.Snapshot'),authority:'owner'});
        assert.equal(after.length,3);assert.ok(after.some(row=>row.data['sequence']==='3'));
        assert.equal((await store.query({model:asModel('count_visibility.Revision'),authority:'owner'})).length,1);
        assert.equal((await store.load(parent.model,parent.id))!.data['label'],'revised');
      }
    }
    }
  }finally{await rm(directory,{recursive:true,force:true});}
});

it('keeps an original created-row parent as a staged identity across COUNT and Contract construction', {timeout:240000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'can-created-parent-'));
  try{
    const source=join(root,'compiler/tests/fixtures/rent-restore-count-source.can');
    const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
    const artifact=JSON.parse(stdout) as CompileArtifact;
    const asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
    for(const mode of ['empty','siblings','custom-id','stale','invalid-interval','hidden-parent','identity-race','field-race','domain-race']){
      const {now,identities,identity,user:actor,membership}=await member('created-parent-'+mode,['rent_reservations.reservation_manager']);
      const {store}=createTestMemoryStorage(),parent={model:asModel('rent_reservations.Resource'),id:asId('resource')};
      const value={active:true,capacity:'7',pooled:false,timezone:'UTC'};
      const row=(model:string,id:string,data:Record<string,unknown>,owner:StoredRow['parent']=null)=>({kind:'insert' as const,model:asModel(model),row:{...makeRow({id:asId(id),data}),parent:owner}});
      const policy=(id:string,sequence:string)=>row('rent_reservations.ResourcePolicy',id,{effective:new Date(now).toISOString(),sequence,baseline:false,value},parent);
      await store.commit(makeBatch(await store.readRevision(),{writes:[
        row('rent_catalog.Location','site',{active:true}),
        row('employee.Employee','operator',{user:{id:actor.user_id},active:mode!=='hidden-parent',operator_wide:false,home:{id:'site'},locations:[]}),
        row('rent_reservations.Resource','resource',{location:{id:'site'},...value}),
        ...(mode==='empty'?[]:[policy('existing','1')])
      ]}));
      const query=store.query.bind(store),commit=store.commit.bind(store),load=store.load.bind(store);let raced=false,races=0;
      store.query=async spec=>{const rows=await query(spec);if(spec.model==='rent_reservations.ResourcePolicy'&&mode==='identity-race'&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}return rows;};
      store.commit=async batch=>{
        if(['field-race','domain-race'].includes(mode)&&batch.writes.some(write=>write.kind==='insert'&&write.model==='rent_reservations.Downtime')){
          raced=true;races++;
          if(mode==='domain-race')await commit(makeBatch(await store.readRevision(),{writes:[policy('raced:'+races,String(races+3))]}));
          else{const resource=await load(parent.model,parent.id);assert.ok(resource);await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:parent.model,id:parent.id,expectedVersion:resource.version,row:{...resource,version:asVersion(resource.version+1),data:{...resource.data,capacity:String(7+races)}}}]}));}
        }
        return commit(batch);
      };
      const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now,...(mode==='custom-id'?{allocateRecordId:(model:string,index:number)=>`custom:${model}:${index}`}:{})});
      const request={operation:'rent_reservations.block',operation_id:operationId(now),inputs:{resource:{id:'resource',version:mode==='stale'?'2':'1'},from:new Date(now).toISOString(),until:mode==='invalid-interval'?new Date(now-1).toISOString():null,reason:'Repair'}};
      const result=await invoker.invokeMutation(request,identity),success=['empty','siblings','custom-id'].includes(mode);
      assert.equal('result'in result,success,mode+': '+JSON.stringify(result));
      if(mode.endsWith('-race'))assert.equal(raced,true,mode);
      const downtimes=await query({model:asModel('rent_reservations.Downtime'),authority:'owner'});
      const policies=await query({model:asModel('rent_reservations.ResourcePolicy'),authority:'owner'});
      const created=policies.filter(row=>row.id!=='existing'&&!row.id.startsWith('raced:'));
      assert.equal(downtimes.length,success?1:0,mode+': source create rolls back atomically');assert.equal(created.length,success?1:0,mode+': snapshot rolls back atomically');
      if(success){
        assert.deepEqual(downtimes[0]!.parent,parent);assert.deepEqual(created[0]!.parent,parent);
        assert.equal(created[0]!.data['sequence'],mode==='empty'?'1':'2');assert.deepEqual(created[0]!.data['value'],value);
        if(mode==='custom-id')assert.ok(downtimes[0]!.id.startsWith('custom:'));
        const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay,JSON.stringify(replay));
        assert.deepEqual(await query({model:asModel('rent_reservations.Downtime'),authority:'owner'}),downtimes);
        assert.deepEqual(await query({model:asModel('rent_reservations.ResourcePolicy'),authority:'owner'}),policies);
      }
    }
    for(const allowed of [true,false]){
      const {now,identities,identity}=await member('created-parent-policy-'+allowed);
      const {store}=createTestMemoryStorage(),parent={model:asModel('count_visibility.Root'),id:asId('root')};
      await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:parent.model,row:makeRow({id:parent.id,data:{label:'Original'}})}]}));
      const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
      const result=await invoker.invokeMutation({operation:'count_visibility.created_parent',operation_id:operationId(now),inputs:{root:{id:'root',version:'1'},allowed}},identity);
      assert.equal('result'in result,allowed,'a created child needs its genuine parent read policy: '+JSON.stringify(result));
      assert.equal((await store.query({model:asModel('count_visibility.Child'),authority:'owner'})).length,allowed?1:0);
      assert.equal((await store.query({model:asModel('count_visibility.Snapshot'),authority:'owner'})).length,allowed?1:0);
      const plain=await invoker.invokeMutation({operation:'count_visibility.plain_parent',operation_id:operationId(now),inputs:{root:{id:'root',version:'1'},allowed}},identity);
      assert.equal('result'in plain,allowed,'ordinary created-parent DATA keeps the same policy without a COUNT profile: '+JSON.stringify(plain));
      const audits=await store.query({model:asModel('count_visibility.Audit'),authority:'owner'});
      assert.equal(audits.length,allowed?1:0);
      if(allowed){assert.deepEqual(audits[0]!.parent,parent);assert.equal(audits[0]!.data['label'],'Original');}

    }
    const captureSource=join(directory,'Capture.can');
    await writeFile(captureSource,String.raw`app ReferenceCapture
Given
 Customer {active:bool=true}
 Program {active:bool=true,window:duration,visible:bool=true}
 Advocate in Program {account:user,code:text}
 Partner {active:bool=true,account:user,window:duration,visible:bool=true}
 Capture in Customer {advocate:Advocate?,partner:Partner?,code:text,program:text,window:duration,source:text}
 policy Customer read=members
 policy Program read=members where=row.visible
 policy Advocate read=members
 policy Partner read=members where=row.visible
 policy Capture read=members
When
 scenario capture(customer:Customer,advocate:Advocate?,partner:Partner?) -> Capture by=members
  require customer.active
  require (advocate!=null and partner==null) or (advocate==null and partner!=null)
  do
   if advocate!=null
    require advocate.parent.active and advocate.account!=actor
    create Capture {parent=customer,advocate,code=advocate.code,program=format("program:{id}",{id=advocate.parent.id}),window=advocate.parent.window,source=operation.id} as captured
    return captured
   require partner!=null
   require partner.active and partner.account!=actor
   create Capture {parent=customer,partner,code=partner.id,program=format("partner:{id}",{id=partner.id}),window=partner.window,source=operation.id} as captured
   return captured
Then
`);
    const captureCompiled=spawnSync(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,captureSource],{cwd:root,encoding:'utf8'});
    assert.equal(captureCompiled.status,0,captureCompiled.stdout+captureCompiled.stderr);
    const captureArtifact=JSON.parse(captureCompiled.stdout) as CompileArtifact;
    const captureAsm=await assembleModules({artifact:captureArtifact,sourcePath:captureSource},{workDir:join(directory,'capture'),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
    for(const mode of ['advocate','partner','both','neither','hidden-program','hidden-partner','grant-race']){
      const {now,identities,identity,membership}=await member('capture-branch-'+mode);
      const foreign=await identities.createUser({email:'foreign-'+mode+'@capture.test',password_hash:'unused',email_verified:true});
      const {store}=createTestMemoryStorage();
      const row=(name:string,id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({kind:'insert' as const,model:asModel('ReferenceCapture.'+name),row:{...makeRow({id:asId(id),data}),parent}});
      await store.commit(makeBatch(await store.readRevision(),{writes:[
        row('Customer','customer',{active:true}),
        row('Program','program',{active:true,window:'86400000',visible:mode!=='hidden-program'}),
        row('Advocate','advocate',{account:{id:foreign.user_id},code:'ACODE'},{model:asModel('ReferenceCapture.Program'),id:asId('program')}),
        row('Partner','partner',{active:true,account:{id:foreign.user_id},window:'172800000',visible:mode!=='hidden-partner'})
      ]}));
      let raced=false;const load=store.load.bind(store);
      store.load=async(model,id)=>{const saved=await load(model,id);if(mode==='grant-race'&&model==='ReferenceCapture.Program'&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}return saved;};
      const invoker=buildInvoker(captureArtifact,captureAsm,store,{memberships:identities,now:()=>now});
      const advocate=!['partner','neither','hidden-partner'].includes(mode),partner=['partner','both','hidden-partner'].includes(mode);
      const request={operation:'ReferenceCapture.capture',operation_id:operationId(now),inputs:{customer:{id:'customer',version:'1'},advocate:advocate?{id:'advocate',version:'1'}:null,partner:partner?{id:'partner',version:'1'}:null}};
      const outcome=await invoker.invokeMutation(request,identity),allowed=['advocate','partner'].includes(mode);
      const captures=await store.query({model:asModel('ReferenceCapture.Capture'),authority:'owner'});
      assert.equal('result'in outcome,allowed,mode+': '+JSON.stringify(outcome));assert.equal(captures.length,allowed?1:0,mode);
      if(mode==='grant-race')assert.equal(raced,true);
      if(allowed){
        assert.ok('result'in outcome);assert.deepEqual(outcome.result.result,{id:captures[0]!.id});
        assert.deepEqual(captures[0]!.parent,{model:asModel('ReferenceCapture.Customer'),id:asId('customer')});
        assert.equal(captures[0]!.data['code'],advocate?'ACODE':'partner');
        assert.equal(captures[0]!.data['program'],advocate?'program:program':'partner:partner');
        const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');
        assert.deepEqual(await store.query({model:asModel('ReferenceCapture.Capture'),authority:'owner'}),captures);
      }
    }
    const auxiliarySource=join(directory,'Auxiliary.can');
    await writeFile(auxiliarySource,String.raw`app CreatedAuxiliary
Given
 Root {active:bool=true,visible:bool=true}
 Primary in Root {value:int=0}
 Policy in Root {sequence:int}
 Evidence in Root {key:text}
 policy Root read=members where=row.visible
 policy Primary read=members
 policy Policy read=members
 policy Evidence read=members
When
 scenario make(root:Root,apply:bool,allowed:bool) -> Primary by=members
  require root.active
  do
   create Primary {parent=root,value=1} as primary
   create Policy {parent=primary.parent,sequence=1} as snapshot
   create Evidence {parent=primary.parent,key=primary.id} as evidence
   if apply
    set primary {value=2}
   require allowed
   return primary
Then
`);
    const auxiliaryCompiled=spawnSync(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,auxiliarySource],{cwd:root,encoding:'utf8'});
    assert.equal(auxiliaryCompiled.status,0,auxiliaryCompiled.stdout+auxiliaryCompiled.stderr);
    const auxiliaryArtifact=JSON.parse(auxiliaryCompiled.stdout) as CompileArtifact;
    const auxiliaryAsm=await assembleModules({artifact:auxiliaryArtifact,sourcePath:auxiliarySource},{workDir:join(directory,'auxiliary'),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
    for(const mode of ['plain','updated','late-refusal','hidden-root']){
      const {now,identities,identity}=await member('created-auxiliary-'+mode);
      const {store}=createTestMemoryStorage(),parent={model:asModel('CreatedAuxiliary.Root'),id:asId('root')};
      await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:parent.model,row:makeRow({id:parent.id,data:{active:true,visible:mode!=='hidden-root'}})}]}));
      const invoker=buildInvoker(auxiliaryArtifact,auxiliaryAsm,store,{memberships:identities,now:()=>now});
      const request={operation:'CreatedAuxiliary.make',operation_id:operationId(now),inputs:{root:{id:'root',version:'1'},apply:mode!=='plain',allowed:mode!=='late-refusal'}};
      const outcome=await invoker.invokeMutation(request,identity),allowed=['plain','updated'].includes(mode);
      assert.equal('result'in outcome,allowed,mode+': '+JSON.stringify(outcome));
      for(const name of ['Primary','Policy','Evidence']){
        const rows=await store.query({model:asModel('CreatedAuxiliary.'+name),authority:'owner'});
        assert.equal(rows.length,allowed?1:0,mode+': '+name+' remains atomic');
        if(allowed){
          assert.deepEqual(rows[0]!.parent,parent);
          if(name==='Primary'){assert.equal(rows[0]!.data['value'],mode==='updated'?'2':'1');assert.ok('result'in outcome);assert.deepEqual(outcome.result.result,{id:rows[0]!.id});}
        }
      }
      if(allowed){const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');assert.equal((await store.query({model:asModel('CreatedAuxiliary.Primary'),authority:'owner'})).length,1);}
    }
  }finally{await rm(directory,{recursive:true,force:true});}
});

it('authorizes original EMIT Contract DATA through its separate declared Work lifecycle',
  {timeout:180000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-source-emit-data-'));
    try{
      const {artifact,asm}=await installed('native-source-emit-data.can',directory);
      for(const name of ['notify','lose_grant','change_reference','secret','mixed','abort'])assert.equal(artifact.operations?.find(op=>op.name===`SourceEmitData.${name}`)?.result?.disclosure,undefined);
      for(const name of ['input','direct'])assertSourceOnlyReceipt(artifact,`SourceEmitData.${name}`,'date',[[['SourceEmitData.Root','source','data','text']]]);
      const original=await readFile(fixture('native-source-emit-data.can'),'utf8'),refused=fixture('.native-source-emit-data-refused.can');
      try{
        for(const changed of [original.replaceAll('emit Checked {value=snapshot(root,reason)}','let alias=root\n   emit Checked {value=snapshot(alias,reason)}'),
          original.replace('scenario notify(root:Root,reason:text) by=members','scenario notify(root:Root,reason:text) -> date by=members')
            .replace(' scenario lose_grant(', '   return add_days(local_date(now,"UTC"),1)\n scenario lose_grant(')]){
          await writeFile(refused,changed);const report=spawnSync(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,refused],{cwd:root,encoding:'utf8'});
          assert.equal(report.status,10,report.stdout+report.stderr);
          assert.ok((JSON.parse(report.stdout) as {diagnostics:{code:string}[]}).diagnostics.some(item=>item.code==='E6008'));
        }
      }finally{await rm(refused,{force:true});}
      const identityPath=join(directory,'identity-path.can');
      await writeFile(identityPath,original.replaceAll('title=root.source','title=root.location.id'));
      const identityReport=spawnSync(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,identityPath],{cwd:root,encoding:'utf8'});
      assert.equal(identityReport.status,0,identityReport.stdout+identityReport.stderr);
      const identityArtifact=JSON.parse(identityReport.stdout) as CompileArtifact;
      const identityAsm=await assembleModules({artifact:identityArtifact,sourcePath:identityPath},{workDir:join(directory,'identity'),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
      for(const mode of ['allowed','identity-path','input','direct','mixed','reference-at-commit','nonnull','late-invariant','hidden-row','field-withheld','grant-loss','reference-change','identity-during-source','source-at-commit']){
        const {now,identities,identity,membership}=await member(`source-data-${mode}`);
        const scope={app:'SourceEmitData',owner:membership.team_id,ownerPackage:'SourceEmitData'};
        const authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'source-emit-data-state',fileStoreId:'source-emit-data-files',receiver:{app:scope.app,owner:scope.owner,team:scope.owner}};
        const {store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
        const selected=mode==='identity-path'?{artifact:identityArtifact,asm:identityAsm}:{artifact,asm};
        await installNativeFileInventory({...selected,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(scope.owner));}});
        const rootModel=model('SourceEmitData','Root'),locationModel=model('SourceEmitData','Location');
        const location={...makeRow({id:asId('location'),data:{enabled:true}}),parent:null};
        const other={...location,id:asId('other'),data:{enabled:false}};
        const hidden={...makeRow({id:asId('hidden-reference'),data:{label:'No readable fields'}}),parent:null};
        const row={...makeRow({id:asId('root'),data:{location:{id:location.id},capacity:'2',checked:false,last:null,
          source:'Readable source',reason:mode==='nonnull'?'Stored reason':null,secret:'Hidden source',visible:mode!=='hidden-row'}}),parent:null};
        await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:locationModel,row:location},
          {kind:'insert',model:locationModel,row:other},{kind:'insert',model:model('SourceEmitData','Hidden'),row:hidden},{kind:'insert',model:rootModel,row},
          {kind:'insert',model:model('SourceEmitData','Child'),row:{...makeRow({id:asId('child'),data:{active:true}}),parent:{model:rootModel,id:row.id}}}]}));
        let raced=false;
        if(mode==='identity-during-source'){
          const load=store.load.bind(store);store.load=async(model,id)=>{
            if(!raced&&model==='work.occurrence'){raced=true;await identities.removeMembership(membership.membership_id);}
            return load(model,id);
          };
        }
        if(mode==='source-at-commit'){
          const commit=store.commit.bind(store);store.commit=async batch=>{
            if(!raced&&batch.writes.some(write=>write.model==='work.occurrence')){
              raced=true;await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:rootModel,id:row.id,
                expectedVersion:asVersion(row.version),row:{...row,version:asVersion(row.version+1),data:{...row.data,source:'Changed original source'}}}]}));
            }
            return commit(batch);
          };
        }
        if(mode==='reference-at-commit'){
          const commit=store.commit.bind(store);store.commit=async batch=>{
            if(!raced&&batch.writes.some(write=>write.model==='work.occurrence')){
              raced=true;await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:model('SourceEmitData','Hidden'),id:hidden.id,expectedVersion:hidden.version,row:{...hidden,version:asVersion(hidden.version+1),archivedAt:now}}]}));
            }return commit(batch);
          };
        }
        const invoker=buildInvoker(selected.artifact,selected.asm,store,{memberships:identities,now:()=>now});
        const operation=`SourceEmitData.${mode==='grant-loss'?'lose_grant':mode==='reference-change'?'change_reference':mode==='field-withheld'?'secret':mode==='late-invariant'?'abort':mode==='input'?'input':mode==='direct'?'direct':mode==='mixed'||mode==='reference-at-commit'?'mixed':'notify'}`;
        const request={operation,operation_id:operationId(now),inputs:{root:{id:row.id,version:String(row.version)},
          ...(mode==='field-withheld'||mode==='direct'||mode==='input'?{}:{reason:'Fallback reason'}),...(mode==='input'?{value:{title:'Supplied title',reason:'Supplied reason'}}:{}),...(mode==='mixed'||mode==='reference-at-commit'?{other:{id:hidden.id,version:String(hidden.version)}}:{}),...(mode==='reference-change'?{other:{id:other.id,version:String(other.version)}}:{})}};
        const outcome=await invoker.invokeMutation(request,identity);
        const allowed=mode==='allowed'||mode==='nonnull'||mode==='direct'||mode==='mixed'||mode==='input';
        assert.equal('result'in outcome?outcome.result.status:outcome.error.code,
          allowed?'committed':mode==='source-at-commit'||mode==='reference-at-commit'?'conflict':mode==='late-invariant'?'rule_failed':'forbidden',`${mode}: ${JSON.stringify(outcome)}`);
        const actual=await store.load(rootModel,row.id);assert.ok(actual);
        if(mode==='identity-path'){assert.ok('error'in outcome);assert.match(outcome.error.message,/Original model query source fields are unavailable/);assert.equal(actual.version,row.version,'unreadable identity path rolls back preceding SET');}
        assert.equal(actual.data.checked,allowed,mode);assert.equal(actual.data.visible,row.data.visible,mode);
        assert.deepEqual(actual.data.location,row.data.location,mode);
        const pending=await store.outboxPending(),sources=await store.query({model:asModel('work.occurrence'),authority:'owner'});
        assert.equal(pending.length,0,mode);assert.equal(sources.length,allowed?1:0,mode);
        if(mode==='identity-during-source'||mode==='source-at-commit'||mode==='reference-at-commit')assert.equal(raced,true,mode);
        assert.equal(actual.data.last,null);if(!allowed)continue;
        const result=sources[0]!.data['result'] as {payload:unknown;context:{kind:string;operation:string}};
        assert.deepEqual(result.payload,mode==='input'?{text:'Readable source',value:{title:'Supplied title',reason:'Supplied reason'}}:mode==='direct'?{message:'Readable source'}:mode==='mixed'?{root:{id:row.id,version:String(actual.version)},other:{id:hidden.id,version:String(hidden.version)},value:{title:'Readable source',reason:'Fallback reason'}}:{value:{title:'Readable source',reason:mode==='nonnull'?'Stored reason':'Fallback reason'}});
        assert.equal(result.context.kind,'user');assert.equal(result.context.operation,request.operation);
        const read=await invoker.invokeRead({operation:'SourceEmitData.Root.read',inputs:{}},identity);
        assert.ok('result'in read,JSON.stringify(read));
        assert.ok(!JSON.stringify(read).includes('Hidden source'),'EMIT authorization does not expose ungranted row fields');
        if(mode==='mixed'){const hiddenRead=await invoker.invokeRead({operation:'SourceEmitData.Hidden.read',inputs:{}},identity);assert.ok('result'in hiddenRead&&((hiddenRead.result as {records:unknown[]}).records.length===0),'retaining an admitted reference grants no model read');}
        const saved=await store.readReceipt({app:'SourceEmitData',owner:membership.team_id,principal:membership.user_id,
          operation,operationId:request.operation_id} as Parameters<typeof store.readReceipt>[0]);assert.ok(saved);assert.ok(saved.outcome.status==='committed');
        const replay=await invoker.invokeMutation(request,identity);
        if(mode==='input'||mode==='direct'){assertSavedSourceReceipt(artifact,saved);assertDateReplay(replay,new Date(now+86400000).toISOString().slice(0,10));}
        else{assert.equal(saved.outcome.scenario,undefined);assert.deepEqual(replay,{result:{status:'replayed',operation_id:request.operation_id,result:null,records:[]}});}
        assert.deepEqual(await store.query({model:asModel('work.occurrence'),authority:'owner'}),sources);assert.deepEqual(await store.readReceipt(saved.identity),saved);
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });

it('copies the original booking report Contract array through whole-field DATA authority', {timeout:240000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-booking-report-'));
 try{
  const source=join(root,'compiler/tests/fixtures/rent-booking-report-source.can');
  const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const artifact=JSON.parse(stdout) as CompileArtifact;
  assert.ok(artifact.operations?.find(operation=>operation.name==='rent_reservations.depart')?.result?.disclosure,'real owning mutation receipt required');
  const asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  for(const mode of ['ordered','empty','hidden-field','invalid-leaf','extra-leaf','field-race','identity-race','stale']){
   const {now,identities,identity,membership}=await member('booking-report-'+mode,['rent_reservations.manager']);
   const {store}=createTestMemoryStorage(),model=asModel('rent_reservations.Booking');
   const intervals=mode==='empty'?[]:[{from:'2099-01-01T12:00:00.000Z',until:'2099-01-01T13:00:00.000Z'},
     {from:'2099-01-01T09:00:00.000Z',until:mode==='invalid-leaf'?'invalid':'2099-01-01T10:00:00.000Z',...(mode==='extra-leaf'?{authority:'forged'}:{})}];
   await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model,row:makeRow({id:asId('booking'),data:{from:'2099-01-01T09:00:00.000Z',until:'2099-01-01T13:00:00.000Z',intervals,quantity:'1',status:'occupied',checked_in:null,checked_out:null,arrival_buffer:'0',departure_buffer:'0',visible:mode!=='hidden-field'}})}]}));
   const load=store.load.bind(store),commit=store.commit.bind(store);let raced=false;
   store.load=async(model,id)=>{const row=await load(model,id);if(model==='rent_reservations.BookingEvidence'&&mode==='identity-race'&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}return row;};
   store.commit=async batch=>{if(mode==='field-race'&&batch.writes.some(write=>write.kind==='insert'&&write.model==='rent_reservations.BookingEvidence')){
     raced=true;const current=await load(model,asId('booking'));assert.ok(current);
     await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model,id:current.id,expectedVersion:current.version,row:{...current,version:asVersion(current.version+1),data:{...current.data,intervals:[...(current.data['intervals'] as unknown[])].reverse()}}}]}));
    }return commit(batch);};
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
   const request={operation:'rent_reservations.depart',operation_id:operationId(now),inputs:{booking:{id:'booking',version:mode==='stale'?'2':'1'}}};
   const result=await invoker.invokeMutation(request,identity),success=['ordered','empty'].includes(mode);
   assert.equal('result'in result,success,mode+': '+JSON.stringify(result));
   if(mode.endsWith('-race'))assert.equal(raced,true,mode);
   const evidence=await store.query({model:asModel('rent_reservations.BookingEvidence'),authority:'owner'});
   const booking=await load(model,asId('booking'));assert.ok(booking);
   assert.equal(evidence.length,success?1:0,mode+': CREATE and preceding SET remain atomic');
   assert.equal(booking.data['status'],success?'completed':'occupied');
   assert.equal(booking.data['checked_out'],success?new Date(now).toISOString():null);
   if(success){
    const report=evidence[0]!.data['value'] as Record<string,unknown>;
    assert.deepEqual(report['intervals'],intervals,'whole ordered canonical array preserved');assert.equal(report['status'],'completed');assert.equal(report['checked_out'],new Date(now).toISOString());
    const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay,JSON.stringify(replay));
    assert.deepEqual(await store.query({model:asModel('rent_reservations.BookingEvidence'),authority:'owner'}),evidence);
   }
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('observes original helper reference identities through their genuine owning field', {timeout:240000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-helper-reference-identity-'));
 try{
  const source=join(root,'compiler/tests/fixtures/helper-reference-identity.can');
  const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const artifact=JSON.parse(stdout) as CompileArtifact;
  assert.ok(artifact.operations?.find(operation=>operation.name==='worker.prepare')?.result?.disclosure);
  const asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  for(const mode of ['allowed','denied-field','hidden-target','reference-race','identity-race','stale']){
   const {now,identities,identity,membership}=await member('helper-reference-'+mode);
   const {store}=createTestMemoryStorage(),model=asModel('worker.Booking');
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    {kind:'insert',model:asModel('api.Customer'),row:makeRow({id:asId('customer'),data:{active:mode!=='hidden-target'}})},
    {kind:'insert',model:asModel('api.Customer'),row:makeRow({id:asId('other'),data:{active:true}})},
    {kind:'insert',model,row:makeRow({id:asId('booking'),data:{customer:{id:'customer'},visible:true,permitted:mode!=='denied-field',last:null,checked:false}})}]}));
   const load=store.load.bind(store),commit=store.commit.bind(store);let raced=false;
   store.load=async(model,id)=>{const row=await load(model,id);if(model==='worker.Evidence'&&mode==='identity-race'&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}return row;};
   store.commit=async batch=>{if(mode==='reference-race'&&batch.writes.some(write=>write.kind==='insert'&&write.model==='worker.Evidence')){
    raced=true;const row=await load(model,asId('booking'));assert.ok(row);
    await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model,id:row.id,expectedVersion:row.version,row:{...row,version:asVersion(row.version+1),data:{...row.data,customer:{id:'other'}}}}]}));
   }return commit(batch);};
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
   const request={operation:'worker.prepare',operation_id:operationId(now),inputs:{booking:{id:'booking',version:mode==='stale'?'2':'1'}}};
   const result=await invoker.invokeMutation(request,identity),success=['allowed','hidden-target'].includes(mode);
   assert.equal('result'in result,success,mode+': '+JSON.stringify(result));
   if(mode.endsWith('-race'))assert.equal(raced,true,mode);
   const evidence=await store.query({model:asModel('worker.Evidence'),authority:'owner'});
   assert.equal(evidence.length,success?1:0,mode);assert.equal((await load(model,asId('booking')))?.data['checked'],success,mode);
   const pending=await store.outboxPending();assert.equal(pending.length,success?1:0,mode+': SEND remains atomic with SET and CREATE');
   if(success){assert.deepEqual(pending[0]!.arguments,{binding:'worker.Membership',from:'deployment.membership',arguments:{value:{customer:'customer'}}});
    assert.deepEqual(evidence[0]!.data['value'],{customer:'customer'});
    assert.ok('result'in await invoker.invokeMutation(request,identity));assert.deepEqual(await store.query({model:asModel('worker.Evidence'),authority:'owner'}),evidence);assert.deepEqual(await store.outboxPending(),pending);}
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('observes original helper parent getters at their authored identity reads', {timeout:240000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-helper-parent-identity-'));
 try{
  const source=join(root,'compiler/tests/fixtures/helper-parent-reference-identity.can');
  const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const artifact=JSON.parse(stdout) as CompileArtifact;
  assert.ok(artifact.operations?.find(operation=>operation.name==='worker.prepare')?.result?.disclosure);
  const asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  for(const mode of ['allowed','denied-field','parent-metadata','denied-location','hidden-target','parent-race','reference-race','identity-race','stale','guard-false']){
   const {now,identities,identity,membership}=await member('helper-parent-'+mode);
   const {store}=createTestMemoryStorage(),model=asModel('worker.Booking');
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    {kind:'insert',model:asModel('api.Customer'),row:makeRow({id:asId('customer'),data:{active:mode!=='hidden-target'}})},
    {kind:'insert',model:asModel('api.Customer'),row:makeRow({id:asId('other'),data:{active:true}})},
    {kind:'insert',model:asModel('api.Location'),row:makeRow({id:asId('location'),data:{active:true}})},
    {kind:'insert',model:asModel('api.Location'),row:makeRow({id:asId('elsewhere'),data:{active:true}})},
    {kind:'insert',model:asModel('worker.Resource'),row:makeRow({id:asId('resource'),data:{location:{id:'location'},permitted:!['denied-location','guard-false'].includes(mode)}})},
    {kind:'insert',model:asModel('worker.Resource'),row:makeRow({id:asId('other-resource'),data:{location:{id:'location'},permitted:true}})},
    {kind:'insert',model,row:{...makeRow({id:asId('booking'),data:{customer:{id:'customer'},visible:mode!=='guard-false',permitted:mode!=='denied-field',parent_visible:mode!=='parent-metadata',last:null,checked:false}}),parent:{model:asModel('worker.Resource'),id:asId('resource')}}}]}));
   const load=store.load.bind(store),commit=store.commit.bind(store);let raced=false;
   store.load=async(model,id)=>{const row=await load(model,id);if(model==='worker.Evidence'&&mode==='identity-race'&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}return row;};
   store.commit=async batch=>{if(['reference-race','parent-race'].includes(mode)&&batch.writes.some(write=>write.kind==='insert'&&write.model==='worker.Evidence')){
    raced=true;const changedModel=mode==='parent-race'?model:asModel('worker.Resource');
    const row=await load(changedModel,asId(mode==='parent-race'?'booking':'resource'));assert.ok(row);
    await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:changedModel,id:row.id,expectedVersion:row.version,row:{...row,version:asVersion(row.version+1),
     ...(mode==='parent-race'?{parent:{model:asModel('worker.Resource'),id:asId('other-resource')}}:{data:{...row.data,location:{id:'elsewhere'}}})}}]}));
   }return commit(batch);};
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
   const request={operation:'worker.prepare',operation_id:operationId(now),inputs:{booking:{id:'booking',version:mode==='stale'?'2':'1'}}};
   const result=await invoker.invokeMutation(request,identity),success=['allowed','hidden-target','parent-metadata'].includes(mode);
   assert.equal('result'in result,success,mode+': '+JSON.stringify(result));
   if(mode.endsWith('-race'))assert.equal(raced,true,mode);
   const evidence=await store.query({model:asModel('worker.Evidence'),authority:'owner'});
   assert.equal(evidence.length,success?1:0,mode);assert.equal((await load(model,asId('booking')))?.data['checked'],success,mode);
   const pending=await store.outboxPending();assert.equal(pending.length,success?1:0,mode+': SEND remains atomic with SET and CREATE');
   if(success){assert.deepEqual(pending[0]!.arguments,{binding:'worker.Membership',from:'deployment.membership',arguments:{value:{customer:'customer',location:'location'}}});
    assert.deepEqual(evidence[0]!.data['value'],{customer:'customer',location:'location'});
    assert.ok('result'in await invoker.invokeMutation(request,identity));assert.deepEqual(await store.query({model:asModel('worker.Evidence'),authority:'owner'}),evidence);assert.deepEqual(await store.outboxPending(),pending);}
  }
  const createdSource=join(root,'compiler/tests/fixtures/helper-created-parent-reference.can');
  const createdOutput=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,createdSource],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const createdArtifact=JSON.parse(createdOutput.stdout) as CompileArtifact;
  assert.ok(createdArtifact.operations?.find(operation=>operation.name==='reservations.move')?.result?.disclosure,'actual native Movement receipt required');
  const createdAsm=await assembleModules({artifact:createdArtifact,sourcePath:createdSource},{workDir:join(directory,'created'),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  const arrayText=(await readFile(createdSource,'utf8'))
   .replace('  export contract Entitlement {source:text,customer:text,location:text,quantity:int}','  export contract Interval {from:datetime,until:datetime}\n  export contract Entitlement {source:text,customer:text,location:text,quantity:int,intervals:Interval[]!}')
   .replace(' use api {Entitlement,',' use api {Interval,Entitlement,')
   .replace('Movement in Booking {source:text,last:text?}','Movement in Booking {source:text,last:text?,intervals:Interval[]!}')
   .replace('quantity=movement.parent.quantity}','quantity=movement.parent.quantity,intervals=movement.intervals}')
   .replace('   do\n    create Movement','   do\n    let previous=first(booking.Movement as row order=row.id)\n    require previous==null\n    create Movement')
   .replace('create Movement {parent=booking,source=operation.id}','create Movement {parent=booking,source=operation.id,intervals=[Interval {from=datetime("2099-01-01T09:00:00Z"),until=datetime("2099-01-01T10:00:00Z")}]}');
  const arrayVariants=new Map<string,{artifact:CompileArtifact;asm:typeof createdAsm}>();
  for(const [name,text]of [['array',arrayText],['withheld-array',arrayText.replace('policy Movement read=members','policy Movement read=members fields=source,last,parent')]]){
   const source=join(directory,name+'.can');await writeFile(source,text!);
   const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
   const artifact=JSON.parse(stdout)as CompileArtifact;
   const plan=artifact.operations?.find(operation=>operation.name==='reservations.move')?.result?.disclosure;
   assert.ok(plan?.returns.some(returned=>returned.dependencies.some(dependency=>dependency.model==='reservations.Movement'&&dependency.field==='intervals'&&dependency.type==='api.Interval[]!')),'whole required Contract array retains its exact native DATA field dependency');
   arrayVariants.set(name!,{artifact,asm:await assembleModules({artifact,sourcePath:source},{workDir:join(directory,name!+'-modules'),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')})});
  }
  for(const mode of ['allowed','hidden-booking','hidden-resource','hidden-customer','hidden-location','identity-race','reference-race','stale','required-array','withheld-array','array-identity-race','array-reference-race','array-existing']){
   const {now,identities,identity,membership}=await member('created-helper-'+mode);
   const {store}=createTestMemoryStorage();
   const row=(model:string,id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({kind:'insert' as const,model:asModel(model),row:{...makeRow({id:asId(id),data}),parent}});
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    row('reservations.Customer','customer',{visible:mode!=='hidden-customer'}),
    row('reservations.Customer','other',{visible:true}),
    row('reservations.Location','location',{visible:mode!=='hidden-location'}),
    row('reservations.Resource','resource',{location:{id:'location'},visible:mode!=='hidden-resource'}),
    row('reservations.Booking','booking',{customer:{id:'customer'},quantity:'3',visible:mode!=='hidden-booking'},{model:asModel('reservations.Resource'),id:asId('resource')})
   ]}));
   const previous=mode==='array-existing'?row('reservations.Movement','previous',{source:'previous-operation',last:null,intervals:[{from:'2099-01-01T09:00:00.000Z',until:'2099-01-01T10:00:00.000Z'}]},{model:asModel('reservations.Booking'),id:asId('booking')}):undefined;
   if(previous!==undefined)await store.commit(makeBatch(await store.readRevision(),{writes:[previous]}));
   const load=store.load.bind(store),commit=store.commit.bind(store);let raced=false;
   store.load=async(model,id)=>{const value=await load(model,id);if(model==='reservations.Movement'&&(mode==='identity-race'||mode==='array-identity-race')&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}return value;};
   store.commit=async batch=>{if((mode==='reference-race'||mode==='array-reference-race')&&batch.writes.some(write=>write.kind==='insert'&&write.model==='reservations.Movement')){
    raced=true;const model=asModel('reservations.Booking'),row=await load(model,asId('booking'));assert.ok(row);
    await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model,id:row.id,expectedVersion:row.version,row:{...row,version:asVersion(row.version+1),data:{...row.data,customer:{id:'other'}}}}]}));
   }return commit(batch);};
   const selected=arrayVariants.get(mode==='withheld-array'?'withheld-array':'array');
   const arrayMode=mode==='required-array'||mode==='withheld-array'||mode.startsWith('array-');
   const invoker=buildInvoker(arrayMode?selected!.artifact:createdArtifact,arrayMode?selected!.asm:createdAsm,store,{memberships:identities,now:()=>now});
   const request={operation:'reservations.move',operation_id:operationId(now),inputs:{booking:{id:'booking',version:mode==='stale'?'2':'1'}}};
   const result=await invoker.invokeMutation(request,identity),success=['allowed','hidden-customer','hidden-location','required-array'].includes(mode);
   assert.equal('result'in result,success,mode+': '+JSON.stringify(result));
   if(mode.endsWith('-race'))assert.equal(raced,true,mode);
   const movement=await store.query({model:asModel('reservations.Movement'),authority:'owner'}),pending=await store.outboxPending();
   assert.equal(movement.length,success||previous!==undefined?1:0,mode+': actual CREATE rollback');assert.equal(pending.length,success?1:0,mode+': actual SEND rollback');
   if(previous!==undefined){assert.ok('error'in result);assert.equal(result.error.code,'rule_failed');assert.deepEqual(movement,[previous.row],'original nonempty FIRST refuses before publishing another Movement');}
   const evidence=await store.query({model:asModel('reservations.Evidence'),authority:'owner'});assert.equal(evidence.length,success?1:0,mode+': evidence rollback');
   if(success){assert.deepEqual(pending[0]!.arguments,{binding:'reservations.Membership',from:'deployment.membership',arguments:{value:{source:request.operation_id,customer:'customer',location:'location',quantity:'3',...(arrayMode?{intervals:[{from:'2099-01-01T09:00:00.000Z',until:'2099-01-01T10:00:00.000Z'}]}:{})}}});
    assert.deepEqual(movement[0]!.parent,{model:'reservations.Booking',id:'booking'});
    if(arrayMode){assert.deepEqual(movement[0]!.data.intervals,[{from:'2099-01-01T09:00:00.000Z',until:'2099-01-01T10:00:00.000Z'}]);assert.deepEqual((evidence[0]!.data.value as {intervals:unknown}).intervals,movement[0]!.data.intervals);}
    const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay,JSON.stringify(replay));
    assert.deepEqual(await store.query({model:asModel('reservations.Movement'),authority:'owner'}),movement);assert.deepEqual(await store.outboxPending(),pending);}
  }
  const controlSource=join(root,'compiler/tests/fixtures/helper-created-parent-control.can');
  const controlText=await readFile(controlSource,'utf8');
  const controlVariants=new Map<string,CompileArtifact>();
  for(const [name,text]of [['full',controlText],['withheld',controlText.replace('policy Booking read=members where=row.visible','policy Booking read=members where=row.visible fields=customer,quantity,visible,parent,override')],['withheld-override',controlText.replace('policy Booking read=members where=row.visible','policy Booking read=members where=row.visible fields=customer,quantity,visible,parent,unit')]]){
   const source=join(directory,'helper-control-'+name+'.can');await writeFile(source,text!);
   const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
   const artifact=JSON.parse(stdout)as CompileArtifact;
   const plan=artifact.operations?.find(operation=>operation.name==='reservations.move')?.result?.disclosure;
   assert.ok(plan,'the conditional scalar helper must publish its actual complete receipt');
   for(const field of ['unit','override'])assert.ok(plan.returns.some(returned=>{
    const data=returned.dependencies.find(read=>read.model==='reservations.Booking'&&read.field===field&&read.role==='data');
    const control=returned.dependencies.find(read=>read.model==='reservations.Booking'&&read.field===field&&read.role==='control');
    return data!==undefined&&control!==undefined&&data.id!==control.id;
   }),'DATA and CONTROL retain independent original identities');
   controlVariants.set(name!,artifact);
  }
  // The deployed compiler module owns its receipt plan. Callers supply only
  // closed business inputs; a claimed plan or role cannot replace that owner.
  for(const mode of ['hour','day','withheld','identity-race','field-race','caller-plan','wrong-source','override-present','override-null-withheld','override-present-withheld','override-race']){
   const {now,identities,identity,membership}=await member('helper-control-'+mode),{store}=createTestMemoryStorage();
   const bookingModel=asModel('reservations.Booking'),movementModel=asModel('reservations.Movement'),evidenceModel=asModel('reservations.Evidence');
   const insert=(model:string,id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({kind:'insert' as const,model:asModel(model),row:{...makeRow({id:asId(id),data}),parent}});
   const unit=mode==='day'?'day':'hour',override=mode==='override-present'||mode==='override-present-withheld'||mode==='override-race'?'5':null;
   const booking=insert('reservations.Booking','booking',{customer:{id:'customer'},quantity:'3',visible:true,unit,override},{model:asModel('reservations.Resource'),id:asId('resource')});
   await store.commit(makeBatch(await store.readRevision(),{writes:[insert('reservations.Customer','customer',{visible:true}),insert('reservations.Location','location',{visible:true}),insert('reservations.Resource','resource',{visible:true,location:{id:'location'}}),booking]}));
   const history=await store.historyFor(bookingModel,booking.row.id),load=store.load.bind(store),commit=store.commit.bind(store);let raced=false;
   store.load=async(model,id)=>{const row=await load(model,id);if(mode==='identity-race'&&model===movementModel&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}return row;};
   store.commit=async batch=>{if((mode==='field-race'||mode==='override-race')&&!raced&&batch.writes.some(write=>write.kind==='insert'&&write.model===movementModel)){
    raced=true;const row=await load(bookingModel,booking.row.id);assert.ok(row);
    await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:bookingModel,id:row.id,expectedVersion:row.version,row:{...row,version:asVersion(row.version+1),data:{...row.data,...(mode==='override-race'?{override:'6'}:{unit:'day'})}}}]}));
   }return commit(batch);};
   const original=controlVariants.get(mode==='override-null-withheld'||mode==='override-present-withheld'?'withheld-override':mode==='withheld'||mode==='caller-plan'?'withheld':'full')!;
   const artifact=JSON.parse(JSON.stringify(original))as CompileArtifact;
   if(mode==='wrong-source'){
    const raw=JSON.parse(JSON.stringify(artifact.operations?.find(operation=>operation.name==='reservations.move')?.result?.disclosure));let changed=0;
    for(const returned of raw.returns)for(const read of returned.dependencies){if(read.model==='reservations.Booking'&&read.field==='unit'&&read.role==='control'){
     read.source.sha256='0'.repeat(64);changed++;
    }}
    assert.ok(changed>0);
    const before=JSON.stringify(original.operations!.find(operation=>operation.name==='reservations.move')!.result!.disclosure);let replaced=0;
    for(const module of artifact.modules){if(module.js.includes(before)){Object.assign(module,{js:module.js.replace(before,JSON.stringify(raw))});replaced++;}}
    assert.equal(replaced,1,'forgery must replace the actual executing module declaration as well as its artifact claim');
    Object.assign(artifact.operations!.find(operation=>operation.name==='reservations.move')!.result!,{disclosure:raw});
   }
   let failure:unknown,invoker:ReturnType<typeof buildInvoker>|undefined,outcome:Awaited<ReturnType<ReturnType<typeof buildInvoker>['invokeMutation']>>|undefined;
   const request={operation:'reservations.move',operation_id:operationId(now),inputs:{booking:{id:'booking',version:'1'}}};
   if(mode==='caller-plan')Object.assign(request.inputs,{receipt_plan:{role:'control',disclosure:original.operations!.find(operation=>operation.name==='reservations.move')!.result!.disclosure}});
   try{const source=artifact.sources.find(source=>source.path.endsWith('.can'))!.path;
    const asm=await assembleModules({artifact,sourcePath:source},{workDir:join(directory,'helper-control-'+mode),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
    invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});outcome=await invoker.invokeMutation(request,identity);
   }catch(error){failure=error;}
   const allowed=mode==='hour'||mode==='day'||mode==='override-present';
   if(mode==='wrong-source'){assert.ok(failure!==undefined||outcome!==undefined&&'error'in outcome,mode+': forged consumer must refuse');
    assert.match(String(failure instanceof Error?failure.message:outcome!==undefined&&'error'in outcome?outcome.error.message:failure),/source|receipt|dependency|control|DATA|field|grant|authority|read/i);
   }else{if(failure!==undefined)throw failure;assert.ok(outcome);assert.equal('result'in outcome,allowed,mode+': '+JSON.stringify(outcome));if(!allowed&&'error'in outcome){if(mode==='caller-plan'){assert.equal(outcome.error.code,'validation');assert.match(outcome.error.message,/receipt_plan|unknown|unexpected|undeclared|input/i);}else assert.ok(['forbidden','conflict','invalid_input'].includes(outcome.error.code),JSON.stringify(outcome));}}
   if(mode.endsWith('-race'))assert.equal(raced,true,mode);
   const movements=await store.query({model:movementModel,authority:'owner'}),evidence=await store.query({model:evidenceModel,authority:'owner'}),pending=await store.outboxPending();
   assert.equal(movements.length,allowed?1:0,mode);assert.equal(evidence.length,allowed?1:0,mode);assert.equal(pending.length,allowed?1:0,mode+': no partial SEND');
   if(allowed){assert.equal((pending[0]!.arguments as {arguments:{value:{unit:string}}}).arguments.value.unit,unit);assert.equal((evidence[0]!.data.value as {unit:string}).unit,unit);
    assert.equal((pending[0]!.arguments as {arguments:{value:{quantity:string}}}).arguments.value.quantity,override??'3');assert.equal((evidence[0]!.data.value as {quantity:string}).quantity,override??'3');
    const replay=await invoker!.invokeMutation(request,identity);assert.ok('result'in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');
    assert.deepEqual(await store.query({model:movementModel,authority:'owner'}),movements);assert.deepEqual(await store.outboxPending(),pending);
   }
   if(mode!=='field-race'&&mode!=='override-race'){assert.deepEqual(await load(bookingModel,booking.row.id),booking.row);assert.deepEqual(await store.historyFor(bookingModel,booking.row.id),history);}
   else if(mode==='field-race')assert.equal((await load(bookingModel,booking.row.id))?.data.unit,'day','external change survives the refused stale attempt');
   else assert.equal((await load(bookingModel,booking.row.id))?.data.override,'6','external nullable-field change survives the refused stale attempt');
  }
  const optionalSource=join(root,'compiler/tests/fixtures/nullable-capture-projection.can');
  const optionalOutput=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,optionalSource],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const optionalArtifact=JSON.parse(optionalOutput.stdout) as CompileArtifact;
  const optionalPlan=optionalArtifact.operations?.find(operation=>operation.name==='NullableCapture.copy')?.result?.disclosure;
  assert.ok(optionalPlan);assert.equal(optionalPlan.returns.length,2);
  const optionalAsm=await assembleModules({artifact:optionalArtifact,sourcePath:optionalSource},{workDir:join(directory,'optional'),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  for(const mode of ['omitted','null','present','withheld-field','stale','foreign-id','identity-race','field-race']){
   const {now,identities,identity,membership}=await member('optional-capture-'+mode);
   const {store}=createTestMemoryStorage(),captureModel=asModel('NullableCapture.Capture'),bookingModel=asModel('NullableCapture.Booking');
   const captured={code:'Original code',program:'Original program',captured:new Date(now).toISOString(),window:'86400000',visible:mode!=='withheld-field'};
   await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:captureModel,row:makeRow({id:asId('capture'),data:captured})}]}));
   const load=store.load.bind(store),commit=store.commit.bind(store);let reads=0,raced=false;
   store.load=async(model,id)=>{if(model===captureModel)reads++;const row=await load(model,id);
    if(mode==='identity-race'&&model===bookingModel&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}return row;};
   store.commit=async batch=>{if(mode==='field-race'&&batch.writes.some(write=>write.kind==='insert'&&write.model===bookingModel)){
    raced=true;const row=await load(captureModel,asId('capture'));assert.ok(row);
    await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:captureModel,id:row.id,expectedVersion:row.version,row:{...row,version:asVersion(row.version+1),data:{...row.data,program:'Changed program'}}}]}));
   }return commit(batch);};
   const inputs=mode==='omitted'?{}:{capture:mode==='null'?null:{id:mode==='foreign-id'?'foreign':'capture',version:mode==='stale'?'2':'1'}};
   const request={operation:'NullableCapture.copy',operation_id:operationId(now),inputs};
   const invoker=buildInvoker(optionalArtifact,optionalAsm,store,{memberships:identities,now:()=>now});
   const result=await invoker.invokeMutation(request,identity),allowed=['omitted','null','present'].includes(mode);
   assert.equal('result'in result,allowed,mode+': '+JSON.stringify(result));
   if(mode.endsWith('-race'))assert.equal(raced,true,mode);
   const bookings=await store.query({model:bookingModel,authority:'owner'});assert.equal(bookings.length,allowed?1:0,mode+': atomic constructor');
   if(mode==='omitted'||mode==='null')assert.equal(reads,0,'absent input never loads a Capture row');
   if(allowed){assert.deepEqual(bookings[0]!.data,mode==='present'?{attribution:captured.code,exclusive_program:captured.program,attributed_at:captured.captured,attribution_window:captured.window}:{attribution:null,exclusive_program:null,attributed_at:null,attribution_window:null});
    const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');
    assert.deepEqual(await store.query({model:bookingModel,authority:'owner'}),bookings);
   }
  }
  const guardSource=join(directory,'lazy-scalar-precondition.can');
  const scalarGuard=Array.from({length:12},()=>'(guard.code=="skip" or guard.program=="Original program")').join(' and ');
  await writeFile(guardSource,(await readFile(optionalSource,'utf8'))
   .replace('copy(capture:Capture?)','copy(guard:Capture,capture:Capture?)')
   .replace('  do\n',`  require ${scalarGuard}\n  do\n`));
  const guardOutput=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,guardSource],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const guardArtifact=JSON.parse(guardOutput.stdout) as CompileArtifact;
  assert.equal(guardArtifact.operations?.find(operation=>operation.name==='NullableCapture.copy')?.result?.disclosure?.returns.length,2);
  const guardAsm=await assembleModules({artifact:guardArtifact,sourcePath:guardSource},{workDir:join(directory,'lazy-guard'),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  // Private Require control keeps its existing owner authority. The same
  // observer never lends that authority to constructor DATA (withheld-data).
  for(const mode of ['allowed','lazy-skipped','false','private-control','withheld-data','identity-race','guard-race']){
   const {now,identities,identity,membership}=await member('lazy-scalar-guard-'+mode);
   const {store}=createTestMemoryStorage(),captureModel=asModel('NullableCapture.Capture'),bookingModel=asModel('NullableCapture.Booking');
   const lazy=mode==='lazy-skipped'||mode==='withheld-data';
   const captured={code:'Original code',program:'Original program',captured:new Date(now).toISOString(),window:'86400000',visible:mode!=='withheld-data'};
   const guarded={...captured,code:lazy?'skip':'Original code',program:mode==='false'?'blocked':'Original program',visible:!lazy&&mode!=='private-control'};
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    {kind:'insert',model:captureModel,row:makeRow({id:asId('guard'),data:guarded})},
    {kind:'insert',model:captureModel,row:makeRow({id:asId('capture'),data:captured})}]}));
   const load=store.load.bind(store),commit=store.commit.bind(store);let raced=false;
   store.load=async(model,id)=>{const row=await load(model,id);
    if(mode==='identity-race'&&model===bookingModel&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}return row;};
   store.commit=async batch=>{if(mode==='guard-race'&&!raced&&batch.writes.some(write=>write.kind==='insert'&&write.model===bookingModel)){
    raced=true;const row=await load(captureModel,asId('guard'));assert.ok(row);
    await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:captureModel,id:row.id,expectedVersion:row.version,row:{...row,version:asVersion(row.version+1),data:{...row.data,program:'blocked'}}}]}));
   }return commit(batch);};
   const request={operation:'NullableCapture.copy',operation_id:operationId(now),inputs:{guard:{id:'guard',version:'1'},capture:{id:'capture',version:'1'}}};
   const invoker=buildInvoker(guardArtifact,guardAsm,store,{memberships:identities,now:()=>now});
   const result=await invoker.invokeMutation(request,identity),allowed=mode==='allowed'||mode==='lazy-skipped'||mode==='private-control';
   assert.equal('result'in result,allowed,mode+': '+JSON.stringify(result));
   if(mode.endsWith('-race'))assert.equal(raced,true,mode);
   const bookings=await store.query({model:bookingModel,authority:'owner'});assert.equal(bookings.length,allowed?1:0,mode+': atomic scalar-guard constructor');
   if(allowed){assert.deepEqual(bookings[0]!.data,{attribution:captured.code,exclusive_program:captured.program,attributed_at:captured.captured,attribution_window:captured.window});
    const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');
    assert.deepEqual(await store.query({model:bookingModel,authority:'owner'}),bookings);
   }
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('executes the original contained Invoice cancellation loop through authentic Work deliveries',
  {timeout:240000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-invoice-cancel-loop-'));
    try{
      const {artifact,asm}=await installed('invoice-credit-loop-source.can',directory);
      const original=await readFile(join(root,'draft/apps/CanInvoice/CanInvoice.can'),'utf8');
      const text=await readFile(fixture('invoice-credit-loop-source.can'),'utf8');
      const credit=original.slice(original.indexOf('  scenario credit('));
      const begin=credit.indexOf('    for attempt in invoice.Attempt');
      assert.ok(text.includes(credit.slice(begin,credit.indexOf('\n    if ',begin))),'the exact original per-child SET, SEND and typed CREATE are retained');
      for(const mode of ['allowed','empty','hidden','withheld-reference','inactive','stale','overflow','maximum','physical-cap','role-during-send','insert-at-commit','full-credit-positive','full-credit-false']){
        if(process.env['CAN_INVOICE_LOOP_CASE']&&process.env['CAN_INVOICE_LOOP_CASE']!==mode)continue;
        if(process.env['CAN_INVOICE_LOOP_SKIP_MAXIMUM']==='1'&&mode==='maximum')continue;
        const {now,identities,identity,team,user}=await member(`invoice-loop-${mode}`,['invoice.finance']);
        const scope={app:'CanInvoice',owner:team.team_id,ownerPackage:'invoice'};
        const authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'loop-state',fileStoreId:'loop-files',
          receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
        const {store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
        const row=(id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({...makeRow({id:asId(id),data}),parent});
        const location=row('location',{active:true}),customer=row('customer',{kind:'company',hidden:false});
        const invoice=row('invoice',{location:{id:location.id},source:'original-invoice',currency:'EUR',state:'issued',total:{minor:'1000',currency:'EUR'},next_collection:null,ledger_revision:'0',first_paid_at:null,hidden:false,needs_review:false},{model:model('customer','Customer'),id:customer.id});
        const child={model:model('invoice','Invoice'),id:invoice.id};
        const attempt=(id:string,status='pending',kind='collection',parent=child)=>row(id,{reference:id,amount:{minor:'100',currency:'EUR'},kind,status,failure:null,disabled:false,delivery:null,checkout:'https://checkout.test/'+id,outcome_at:null,received:null,reference_readable:mode!=='withheld-reference',hidden:mode==='hidden'},parent);
        const count=mode==='empty'?0:mode==='maximum'?100:mode==='overflow'?101:2;
        await store.commit(makeBatch(await store.readRevision(),{writes:[
          {kind:'insert',model:model('rent_catalog','Location'),row:location},{kind:'insert',model:model('customer','Customer'),row:customer},
          {kind:'insert',model:model('employee','Employee'),row:row('worker',{user:{id:user.user_id},home:{id:location.id},locations:[],operator_wide:false,active:mode!=='inactive',hidden:true})},
          {kind:'insert',model:model('invoice','Invoice'),row:invoice},{kind:'insert',model:model('invoice','Invoice'),row:{...invoice,id:asId('foreign')}},
          ...Array.from({length:count},(_,index)=>({kind:'insert' as const,model:model('invoice','Attempt'),row:attempt(`attempt-${String(index).padStart(3,'0')}`,index===1?'unknown':'pending')})),
          ...Array.from({length:mode==='physical-cap'?199:1},(_,index)=>({kind:'insert' as const,model:model('invoice','Attempt'),row:attempt(`succeeded-${index}`,'succeeded')})),
          {kind:'insert',model:model('invoice','Attempt'),row:attempt('refund','pending','refund')},
          {kind:'insert',model:model('invoice','Attempt'),row:attempt('foreign-attempt','pending','collection',{model:child.model,id:asId('foreign')})}
        ]}));
        let raced=false;
        if(mode==='role-during-send'){
          const load=store.load.bind(store);store.load=async(model,id)=>{if(!raced&&model==='work.dispatch'){raced=true;const membership=await identities.findMembership(team.team_id,user.user_id);assert.ok(membership);await identities.setMembershipRoles(membership.membership_id,[]);}return load(model,id);};
        }
        if(mode==='insert-at-commit'){
          const commit=store.commit.bind(store);store.commit=async batch=>{if(!raced&&batch.writes.some(write=>write.model==='work.dispatch')){raced=true;await commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:model('invoice','Attempt'),row:attempt('late-attempt')}]}));}return commit(batch);};
        }
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const request={operation:mode.startsWith('full-credit')?'invoice.credit':'invoice.cancel_pending',operation_id:operationId(now),inputs:{invoice:{id:invoice.id,version:mode==='stale'?'0':String(invoice.version)},...(mode.startsWith('full-credit')?{amount:{minor:mode==='full-credit-positive'?'950':'100',currency:'EUR'},reason:'Reviewed original credit'}:{})}};
        const outcome=await invoker.invokeMutation(request,identity),success=['allowed','empty','maximum','insert-at-commit','full-credit-positive','full-credit-false'].includes(mode);
        assert.equal('result'in outcome&&outcome.result.status==='committed',success,`${mode}: ${JSON.stringify(outcome)}`);
        const pending=await store.outboxPending(),requests=await store.query({model:model('invoice','PaymentRequest'),authority:'owner'});
        const expected=success?count+(mode==='insert-at-commit'?1:0):0;
        assert.equal(pending.length,expected,mode);assert.equal(requests.length,expected,mode);
        for(const current of await store.query({model:model('invoice','Attempt'),authority:'owner'})){
          const selected=current.id.startsWith('attempt-')||current.id==='late-attempt';
          assert.equal(current.data.disabled,success&&selected,`${mode}: ${current.id}`);
          if(success&&selected)assert.equal(current.data.checkout,null);
        }
        for(const retained of requests){
          assert.equal(retained.data.kind,'cancel');const delivery=retained.data.cancellation as {id:string};assert.ok(delivery);
          const intent=pending.find(intent=>intent.intentId===delivery.id);assert.ok(intent,'typed cancellation belongs to this actual retained SEND');
          assert.equal(intent.target,'std.PaymentsV1.cancel');assert.equal((intent.arguments as {arguments:{reference:string}}).arguments.reference,retained.parent?.id);
          const receipt=await store.load(asModel('work.receipt'),asId(delivery.id));assert.ok(receipt,'owning typed delivery retains the real pending receipt');assert.equal(receipt.data.status,'pending');assert.equal(receipt.data.result,null);
        }
        if(mode.startsWith('full-credit')){
          const current=await store.load(model('invoice','Invoice'),invoice.id);assert.ok(current);
          assert.equal(current.data.ledger_revision,'1');assert.equal(current.data.needs_review,mode==='full-credit-positive');
          const credits=await store.query({model:model('invoice','Credit'),authority:'owner'});assert.equal(credits.length,1);
          assert.equal((credits[0]!.data.amount as {minor:string}).minor,mode==='full-credit-positive'?'950':'100');
          const events=await store.query({model:asModel('work.occurrence'),authority:'owner'});assert.equal(events.length,1);
          const emitted=(events[0]!.data.result as {payload:{value:{revision:string;collected:{minor:string};collection_pending:boolean}}}).payload;
          assert.equal(emitted.value.revision,'1');assert.equal(emitted.value.collected.minor,'100');assert.equal(emitted.value.collection_pending,true);
        }
        if(mode==='role-during-send'||mode==='insert-at-commit')assert.equal(raced,true);
        if(success){const replay=await invoker.invokeMutation(request,identity);if('error'in replay)assert.equal(replay.error.code,'validation',JSON.stringify(replay));else{assert.equal(replay.result.status,'replayed');assert.equal(replay.result.result,null);}assert.deepEqual(await store.outboxPending(),pending);assert.deepEqual(await store.query({model:model('invoice','PaymentRequest'),authority:'owner'}),requests);}
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });

it('emits the original Invoice settlement with independently granted derived Money DATA',
  {timeout:180000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-invoice-settlement-data-'));
    try{
      const source=join(root,'compiler/tests/fixtures/invoice-document-source-projection.can');
      const original=await readFile(join(root,'draft/apps/CanInvoice/CanInvoice.can'),'utf8'),text=await readFile(source,'utf8');
      const start=original.indexOf('  scenario record_payment('),end=original.indexOf('   examples ',start);
      assert.ok(text.includes(original.slice(start,end)),'full original financial owner remains authored');
      assert.ok(text.includes(original.split('\n').find(line=>line.startsWith('  derive settlement('))!),'full original settlement helper remains authored');
      const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],
        {cwd:root,timeout:60000,maxBuffer:32*1024*1024});
      const artifact=JSON.parse(stdout) as CompileArtifact,asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,
        stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
      assert.equal(artifact.operations?.find(operation=>operation.name==='invoice.record_payment')?.result?.disclosure,undefined);
      for(const mode of ['allowed','other-parent','hidden-child','withheld-child-field','withheld-derived-field','hidden-invoice','grant-loss','late-invariant','identity-during-source','child-at-commit','derived-grant-at-commit'] as const){
        const {now,identities,identity,team,user}=await member(`invoice-settlement-${mode}`,['invoice.finance']);
        const scope={app:'CanInvoice',owner:team.team_id,ownerPackage:'invoice'};
        const authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'settlement-state',fileStoreId:'settlement-files',receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
        const {store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
        const row=(id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({...makeRow({id:asId(id),data}),parent});
        const location=row('location',{active:true}),customer=row('customer',{kind:'company',hidden:false});
        const invoice=row('invoice',{location:{id:location.id},source:'original-invoice',ledger_revision:'0',currency:'EUR',state:'issued',total:{minor:'1100',currency:'EUR'},
          issuer:'Original issuer',recipient:'Original recipient',address:'1 Road',tax_reference:null,terms:mode==='withheld-derived-field'?'Withhold aggregates':'Net 14',due:'2026-12-01',number:'INV-1',issued_at:new Date(now).toISOString(),hidden:mode==='hidden-invoice'},
          {model:model('customer','Customer'),id:customer.id});
        const child={model:model('invoice','Invoice'),id:invoice.id};
        const attempt=row('attempt',{reference:mode==='withheld-child-field'?'withheld':'payment-1',amount:{minor:'500',currency:'EUR'},kind:'collection',status:'succeeded',received:new Date(now).toISOString(),hidden:mode==='hidden-child'},child);
        await store.commit(makeBatch(await store.readRevision(),{writes:[
          {kind:'insert',model:model('rent_catalog','Location'),row:location},{kind:'insert',model:model('customer','Customer'),row:customer},
          {kind:'insert',model:model('employee','Employee'),row:row('worker',{user:{id:user.user_id},home:{id:location.id},locations:[],operator_wide:false,active:true,hidden:true})},
          {kind:'insert',model:model('invoice','Invoice'),row:invoice},{kind:'insert',model:model('invoice','Attempt'),row:attempt},
          {kind:'insert',model:model('invoice','ExternalPayment'),row:row('external',{reference:'bank-1',evidence:'Original bank proof',amount:{minor:'400',currency:'EUR'},received:new Date(now).toISOString(),hidden:false},child)},
          {kind:'insert',model:model('invoice','ExternalRefund'),row:row('refund',{payment:{id:asId('external')},reference:'refund-1',amount:{minor:'100',currency:'EUR'},received:new Date(now).toISOString(),hidden:false},child)},
        ]}));
        if(mode==='other-parent')await store.commit(makeBatch(await store.readRevision(),{writes:[
          {kind:'insert',model:model('invoice','Invoice'),row:{...invoice,id:asId('other-invoice')}},
          {kind:'insert',model:model('invoice','Attempt'),row:{...attempt,id:asId('other-attempt'),data:{...attempt.data,reference:'foreign-hidden',amount:{minor:'99999',currency:'EUR'},hidden:true},parent:{model:model('invoice','Invoice'),id:asId('other-invoice')}}},
        ]}));
        let raced=false;
        if(mode==='identity-during-source'){
          const load=store.load.bind(store);store.load=async(model,id)=>{
            if(!raced&&model==='work.occurrence'){raced=true;const membership=await identities.findMembership(team.team_id,user.user_id);assert.ok(membership);await identities.setMembershipRoles(membership.membership_id,[]);}
            return load(model,id);
          };
        }
        if(mode==='child-at-commit'||mode==='derived-grant-at-commit'){
          const commit=store.commit.bind(store);store.commit=async batch=>{
            if(!raced&&batch.writes.some(write=>write.model==='work.occurrence')){
              raced=true;
              if(mode==='derived-grant-at-commit')await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:model('invoice','Invoice'),id:invoice.id,expectedVersion:invoice.version,
                row:{...invoice,version:asVersion(invoice.version+1),data:{...invoice.data,terms:'Withhold aggregates'}}}]}));
              else await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:model('invoice','Attempt'),id:attempt.id,expectedVersion:attempt.version,
                row:{...attempt,version:asVersion(attempt.version+1),data:{...attempt.data,amount:{minor:'600',currency:'EUR'}}}}]}));
            }return commit(batch);
          };
        }
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const request={operation:mode==='grant-loss'?'invoice.payment_lose_grant':mode==='late-invariant'?'invoice.payment_abort':'invoice.record_payment',operation_id:operationId(now),inputs:{invoice:{id:invoice.id,version:String(invoice.version)},amount:{minor:'200',currency:'EUR'},reference:'new-bank-payment',received:new Date(now).toISOString(),evidence:'Bank statement'}};
        const outcome=await invoker.invokeMutation(request,identity);
        const allowed=mode==='allowed'||mode==='other-parent';
        assert.equal('result'in outcome&&outcome.result.status==='committed',allowed,`${mode}: ${JSON.stringify(outcome)}`);
        const actual=await store.load(model('invoice','Invoice'),invoice.id);assert.ok(actual);assert.equal(actual.data.ledger_revision,allowed?'1':'0',mode);
        const sources=await store.query({model:asModel('work.occurrence'),authority:'owner'});assert.equal(sources.length,allowed?1:0,mode);
        assert.equal((await store.query({model:model('invoice','ExternalPayment'),authority:'owner'})).length,allowed?2:1,mode);
        if(mode==='identity-during-source'||mode==='child-at-commit'||mode==='derived-grant-at-commit')assert.equal(raced,true,mode);
        if(!allowed){assert.ok('error'in outcome,`${mode}: ${JSON.stringify(outcome)}`);assert.equal(outcome.error.code,mode==='late-invariant'?'rule_failed':mode==='child-at-commit'?'rule_failed':mode==='derived-grant-at-commit'?'conflict':mode==='hidden-invoice'?'not_found':'forbidden',mode);continue;}
        const result=sources[0]!.data.result as {payload:unknown;context:{kind:string;operation:string}};
        assert.deepEqual(result.payload,{value:{source:'original-invoice',invoice:invoice.id,revision:'1',amount:{minor:'1100',currency:'EUR'},collected:{minor:'1100',currency:'EUR'},refunded:{minor:'100',currency:'EUR'},collection_pending:false,refund_pending:false,state:'issued',recorded_at:new Date(now).toISOString()}});
        assert.equal(result.context.kind,'user');assert.equal(result.context.operation,request.operation);
        assert.equal((await store.outboxPending()).length,0);
        const saved=await store.readReceipt({app:scope.app,owner:scope.owner,principal:user.user_id,operation:request.operation,operationId:request.operation_id} as Parameters<typeof store.readReceipt>[0]);assert.ok(saved);assert.ok(saved.outcome.status==='committed');assert.equal(saved.outcome.scenario,undefined);
        const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay&&replay.result.status==='replayed',JSON.stringify(replay));assert.deepEqual(replay.result.records,[]);assert.equal(replay.result.result,null);
        assert.deepEqual(await store.query({model:asModel('work.occurrence'),authority:'owner'}),sources);assert.deepEqual(await store.readReceipt(saved.identity),saved);
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });

it('authorizes native scalar DATA before void CREATE and SEND and at final commit', {timeout:240000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-native-data-egress-'));
 try{
  const source=join(root,'compiler/tests/fixtures/native-data-egress-source.can');
  const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const artifact=JSON.parse(stdout) as CompileArtifact;
  for(const name of ['worker.act','worker.capture'])assert.ok(artifact.operations?.find(operation=>operation.name===name)?.result?.disclosure,'actual native mutation receipt required');
  const asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  for(const mode of ['allowed','allowed-capture','denied-money','denied-text','denied-enum','false-prefix','money-value-race','money-grant-race','enum-grant-race','identity-race']){
   const {now,identities,identity,membership}=await member('native-data-egress-'+mode);
   const {store}=createTestMemoryStorage(),model=asModel('worker.Root'),amount={minor:'2400',currency:'EUR'};
   await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model,row:makeRow({id:asId('root'),data:{amount,reference:'original-reference',state:'held',visible:mode!=='false-prefix',
    amount_visible:!['denied-money','false-prefix'].includes(mode),reference_visible:!['denied-text','false-prefix'].includes(mode),state_visible:!['denied-enum','false-prefix'].includes(mode),checked:false,last:null}})}]}));
   const load=store.load.bind(store),commit=store.commit.bind(store);let raced=false;
   store.load=async(model,id)=>{const row=await load(model,id);if(model==='work.dispatch'&&mode==='identity-race'&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}return row;};
   store.commit=async batch=>{if(['money-value-race','money-grant-race','enum-grant-race'].includes(mode)&&batch.writes.some(write=>write.kind==='insert'&&write.model==='worker.Evidence')){
    raced=true;const row=await load(model,asId('root'));assert.ok(row);
    const data=mode==='money-value-race'?{amount:{minor:'9999',currency:'EUR'}}:mode==='money-grant-race'?{amount_visible:false}:{state_visible:false};
    await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model,id:row.id,expectedVersion:row.version,row:{...row,version:asVersion(row.version+1),data:{...row.data,...data}}}]}));
   }return commit(batch);};
   const capture=mode==='allowed-capture'||mode.endsWith('-race');
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
   const request={operation:capture?'worker.capture':'worker.act',operation_id:operationId(now),inputs:{root:{id:'root',version:'1'}}};
   const result=await invoker.invokeMutation(request,identity),success=mode.startsWith('allowed');
   assert.equal('result'in result,success,mode+': '+JSON.stringify(result));if(mode.endsWith('-race'))assert.equal(raced,true,mode);
   const evidence=await store.query({model:asModel('worker.Evidence'),authority:'owner'}),pending=await store.outboxPending();
   assert.equal(evidence.length,success?1:0,mode+': denied DATA must roll back the actual CREATE');
   assert.equal(pending.length,success?1:0,mode+': denied DATA must roll back the actual SEND');
   const current=await load(model,asId('root'));assert.ok(current);assert.equal(current.data['checked'],success&&!capture,mode);
   if(success){const expected={amount,reference:'original-reference',state:'held'};
    assert.deepEqual(evidence[0]!.data['value'],expected);assert.deepEqual(pending[0]!.arguments,{binding:'worker.Port',from:'deployment.port',arguments:{value:expected}});
    assert.ok('result'in await invoker.invokeMutation(request,identity));assert.deepEqual(await store.query({model:asModel('worker.Evidence'),authority:'owner'}),evidence);assert.deepEqual(await store.outboxPending(),pending);
   }else assert.equal(current.data['last'],null,mode);
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('projects original created refund scalar fields independently from admitted payment DATA',
  {timeout:240000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-invoice-cancel-loop-'));
    try{
      const {artifact,asm}=await installed('invoice-created-send-source.can',directory);
      assert.equal(artifact.operations?.find(operation=>operation.name==='invoice.refund_source')?.result?.disclosure,undefined,'this exercises the original source-only DATA lifecycle');
      const original=await readFile(join(root,'draft/apps/CanInvoice/CanInvoice.can'),'utf8');
      const text=await readFile(fixture('invoice-created-send-source.can'),'utf8');
      const refund=original.slice(original.indexOf('  scenario refund_payment('));
      const begin=refund.indexOf('    create Attempt'),end=refund.indexOf('    set invoice',begin);
      assert.ok(text.includes(refund.slice(begin,end)),'the exact original CREATE, refund SEND and delivery write are retained');
      for(const mode of ['allowed','withheld-payment','withheld-created','inactive','stale','role-during-send','payment-at-commit']){
        if(process.env['CAN_CREATED_SEND_CASE']&&process.env['CAN_CREATED_SEND_CASE']!==mode)continue;
        const {now,identities,identity,team,user}=await member(`invoice-loop-${mode}`,['invoice.finance']);
        const scope={app:'CanInvoice',owner:team.team_id,ownerPackage:'invoice'};
        const authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'loop-state',fileStoreId:'loop-files',
          receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
        const {store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
        const row=(id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({...makeRow({id:asId(id),data}),parent});
        const location=row('location',{active:true}),customer=row('customer',{kind:'company',hidden:false});
        const invoice=row('invoice',{location:{id:location.id},source:'original-invoice',currency:'EUR',state:'issued',total:{minor:'50',currency:'EUR'},next_collection:null,ledger_revision:'0',first_paid_at:null,hidden:false},{model:model('customer','Customer'),id:customer.id});
        const child={model:model('invoice','Invoice'),id:invoice.id};
        const attempt=(id:string,status='pending',kind='collection',parent=child)=>row(id,{reference:id,amount:{minor:'100',currency:'EUR'},kind,status,failure:null,disabled:false,delivery:null,checkout:'https://checkout.test/'+id,outcome_at:null,received:null,reference_readable:mode!=='withheld-payment',hidden:mode==='hidden'},parent);
        const payment=attempt('payment','succeeded');
        await store.commit(makeBatch(await store.readRevision(),{writes:[
          {kind:'insert',model:model('rent_catalog','Location'),row:location},{kind:'insert',model:model('customer','Customer'),row:customer},
          {kind:'insert',model:model('employee','Employee'),row:row('worker',{user:{id:user.user_id},home:{id:location.id},locations:[],operator_wide:false,active:mode!=='inactive',hidden:true})},
          {kind:'insert',model:model('invoice','Invoice'),row:invoice},{kind:'insert',model:model('invoice','Attempt'),row:payment}
        ]}));
        let raced=false;
        if(mode==='role-during-send'){
          const load=store.load.bind(store);store.load=async(model,id)=>{if(!raced&&model==='work.dispatch'){raced=true;const membership=await identities.findMembership(team.team_id,user.user_id);assert.ok(membership);await identities.setMembershipRoles(membership.membership_id,[]);}return load(model,id);};
        }
        if(mode==='payment-at-commit'){
          const commit=store.commit.bind(store);store.commit=async batch=>{if(!raced&&batch.writes.some(write=>write.model==='work.dispatch')){raced=true;await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:model('invoice','Attempt'),id:payment.id,expectedVersion:payment.version,row:{...payment,version:asVersion(payment.version+1),data:{...payment.data,reference:'concurrent-payment'}}}]}));}return commit(batch);};
        }
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
        const request={operation:mode==='withheld-created'?'invoice.refund_unreadable':'invoice.refund_source',operation_id:operationId(now),inputs:{invoice:{id:invoice.id,version:mode==='stale'?'0':String(invoice.version)},payment:{id:payment.id,version:String(payment.version)},amount:{minor:'50',currency:'EUR'},reason:'Approved refund'}};
        const outcome=await invoker.invokeMutation(request,identity),success=mode==='allowed';
        assert.equal('result'in outcome&&outcome.result.status==='committed',success,`${mode}: ${JSON.stringify(outcome)}`);
        const pending=await store.outboxPending(),attempts=await store.query({model:model('invoice','Attempt'),authority:'owner'});
        assert.equal(pending.length,success?1:0,mode);assert.equal(attempts.length,success?2:1,mode);
        if(mode==='role-during-send'||mode==='payment-at-commit')assert.equal(raced,true);
        if(success){
          const created=attempts.find(row=>row.id!==payment.id);assert.ok(created);assert.equal(created.data.kind,'refund');
          assert.equal(created.data.reference,request.operation_id);assert.equal(created.data.delivery,pending[0]!.intentId);
          assert.equal(pending[0]!.target,'std.PaymentsV1.refund');
          assert.deepEqual((pending[0]!.arguments as {arguments:unknown}).arguments,{payment:'payment',amount:{minor:'50',currency:'EUR'},reference:request.operation_id});
          const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay&&replay.result.status==='replayed',JSON.stringify(replay));assert.equal(replay.result.result,null);
          assert.deepEqual(await store.outboxPending(),pending);assert.deepEqual(await store.query({model:model('invoice','Attempt'),authority:'owner'}),attempts);
        }
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });


it('evaluates the original Entitlement enum FIRST through immutable Values and field authority', {timeout:240000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-entitlement-values-first-'));
 try{
  const source=join(root,'compiler/tests/fixtures/helper-entitlement-original.can');
  const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const artifact=JSON.parse(stdout) as CompileArtifact;
  const plan=artifact.operations?.find(operation=>operation.name==='rent_reservations.prepare')?.result?.disclosure;
  assert.ok(plan);assert.equal(plan.queries?.length??0,0,'literal enum FIRST grants no Model query authority');
  const asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  for(const mode of ['hour','day','preferred-rate','unused-rate-denied','needed-rate-denied','denied-unit','empty-intervals','unit-race','identity-race']){
   const {now,identities,identity,membership,user}=await member('entitlement-values-'+mode);
   const {store}=createTestMemoryStorage(),model=asModel('rent_reservations.Booking');
   const intervals=mode==='empty-intervals'?[]:[{from:'2099-01-01T09:00:00.000Z',until:'2099-01-01T10:00:00.000Z'}];
   const preferred=['preferred-rate','unused-rate-denied'].includes(mode),rate={minor:'2400',currency:'EUR'},benefitRate={minor:'1200',currency:'EUR'};
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    {kind:'insert',model:asModel('customer.Customer'),row:makeRow({id:asId('customer'),data:{active:true}})},
    {kind:'insert',model:asModel('rent_catalog.Location'),row:makeRow({id:asId('location'),data:{active:true}})},
    {kind:'insert',model:asModel('rent_reservations.Resource'),row:makeRow({id:asId('resource'),data:{location:{id:'location'},price_unit:'hour'}})},
    {kind:'insert',model,row:{...makeRow({id:asId('booking'),data:{source:'original-booking',customer:{id:'customer'},account:{id:user.user_id},
     benefit_intervals:intervals,quantity:'2',benefit_unit:mode==='day'?'day':'hour',benefit_duration:'3600000',benefit_rate:preferred?benefitRate:null,
     rate,checked:false,permitted:mode!=='denied-unit',rate_visible:!['unused-rate-denied','needed-rate-denied'].includes(mode)}}),
     parent:{model:asModel('rent_reservations.Resource'),id:asId('resource')}}}]}));
   const load=store.load.bind(store),commit=store.commit.bind(store);let raced=false;
   store.load=async(model,id)=>{const row=await load(model,id);if(model==='rent_reservations.Evidence'&&mode==='identity-race'&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}return row;};
   store.commit=async batch=>{if(mode==='unit-race'&&batch.writes.some(write=>write.kind==='insert'&&write.model==='rent_reservations.Evidence')){
    raced=true;const row=await load(model,asId('booking'));assert.ok(row);
    await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model,id:row.id,expectedVersion:row.version,row:{...row,version:asVersion(row.version+1),data:{...row.data,benefit_unit:'day'}}}]}));
   }return commit(batch);};
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
   const request={operation:'rent_reservations.prepare',operation_id:operationId(now),inputs:{booking:{id:'booking',version:'1'}}};
   const result=await invoker.invokeMutation(request,identity),success=['hour','day','preferred-rate','unused-rate-denied','empty-intervals'].includes(mode);
   assert.equal('result'in result,success,mode+': '+JSON.stringify(result));if(mode.endsWith('-race'))assert.equal(raced,true,mode);
   const evidence=await store.query({model:asModel('rent_reservations.Evidence'),authority:'owner'});
   assert.equal(evidence.length,success?1:0,mode);assert.equal((await load(model,asId('booking')))?.data['checked'],success,mode);
   if(success){assert.deepEqual(evidence[0]!.data['value'],{source:'original-booking',customer:'customer',account:{id:user.user_id},location:'location',product:'workspace',
    intervals,quantity:'2',unit:mode==='day'?'day':'hour',duration:'3600000',rate:preferred?benefitRate:rate,previous_source:null,restore_consumed:false});
    assert.ok('result'in await invoker.invokeMutation(request,identity));assert.deepEqual(await store.query({model:asModel('rent_reservations.Evidence'),authority:'owner'}),evidence);}
   assert.equal((await store.query({model:asModel('member_terms.Benefit'),authority:'owner'})).length,0,'enum namespace never becomes a Model query');
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('stages the complete original Affiliate settlement from its immediate scalar LET and created schedule root',
  {timeout:180000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),'can-affiliate-created-schedule-'));
    try{
      const source=join(root,'compiler/tests/fixtures/affiliate-created-schedule.can');
      const original=await readFile(join(root,'draft/apps/CanAffiliate/CanAffiliate.can'),'utf8'),text=await readFile(source,'utf8');
      const start=original.indexOf('  scenario settle('),end=original.indexOf('   examples ',start);
      assert.ok(text.includes(original.slice(start,end)),'full original guard, LET, SEND, CREATE and SCHEDULE remain authored');
      assert.ok(text.includes(original.split('\n').find(line=>line.startsWith('  derive available('))!),'full original financial control helper remains authored');
      const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],
        {cwd:root,timeout:60000,maxBuffer:32*1024*1024});
      const artifact=JSON.parse(stdout) as CompileArtifact,asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,
        stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
      assertSourceOnlyReceipt(artifact,'affiliate.settle','void',[[['affiliate.Partner','provider_account','data','text?'],['affiliate.Settlement','id','data','text']]]);
      for(const mode of ['allowed','snapshot','withheld','false-prefix','grant-loss','identity-during-schedule','partner-at-commit'] as const){
        const {now,identities,identity,team,user}=await member(`affiliate-created-${mode}`,['affiliate.finance']);
        const scope={app:'CanAffiliate',owner:team.team_id,ownerPackage:'affiliate'};
        const authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'affiliate-state',fileStoreId:'affiliate-files',receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
        const {store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
        const row=(id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({...makeRow({id:asId(id),data}),parent});
        const location=row('location',{active:true}),partner=row('partner',{locations:[{id:location.id}],active:mode!=='false-prefix',onboarded:true,provider_state:'ready',provider_account:'acct-original',readable:true,account_readable:!['withheld','false-prefix'].includes(mode)});
        await store.commit(makeBatch(await store.readRevision(),{writes:[
          {kind:'insert',model:model('rent_catalog','Location'),row:location},{kind:'insert',model:model('affiliate','Partner'),row:partner},
          {kind:'insert',model:model('employee','Employee'),row:row('worker',{user:{id:user.user_id},home:{id:location.id},locations:[],operator_wide:false,active:true,hidden:true})},
          {kind:'insert',model:model('affiliate','Sale'),row:row('sale',{commission:{minor:'100',currency:'EUR'}},{model:model('affiliate','Partner'),id:partner.id})},
        ]}));
        const load=store.load.bind(store),commit=store.commit.bind(store);let raced=false,workReads=0;
        store.load=async(model,id)=>{if(model==='work.dispatch')workReads++;if(model==='work.schedule'&&mode==='identity-during-schedule'&&!raced){raced=true;const membership=await identities.findMembership(team.team_id,user.user_id);assert.ok(membership);await identities.setMembershipRoles(membership.membership_id,[]);}return load(model,id);};
        store.commit=async batch=>{if(mode==='partner-at-commit'&&!raced&&batch.writes.some(write=>write.model==='work.schedule')){raced=true;await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:model('affiliate','Partner'),id:partner.id,expectedVersion:partner.version,row:{...partner,version:asVersion(partner.version+1),data:{...partner.data,account_readable:false}}}]}));}return commit(batch);};
        const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now,allocateRecordId:()=> 'settlement-created'});
        const request={operation:mode==='snapshot'?'affiliate.settle_snapshot':mode==='grant-loss'?'affiliate.settle_lose_grant':'affiliate.settle',operation_id:operationId(now),inputs:{partner:{id:partner.id,version:String(partner.version)},amount:{minor:'100',currency:'EUR'}}};
        const outcome=await invoker.invokeMutation(request,identity),success=mode==='allowed'||mode==='snapshot';
        assert.equal('result'in outcome&&outcome.result.status==='committed',success,`${mode}: ${JSON.stringify(outcome)}`);
        if(mode==='identity-during-schedule'||mode==='partner-at-commit')assert.equal(raced,true,mode);
        if(!success){assert.equal((await store.query({model:model('affiliate','Settlement'),authority:'owner'})).length,0,mode);assert.equal((await store.query({model:asModel('work.schedule'),authority:'owner'})).length,0,mode);assert.equal((await store.outboxPending()).length,0,mode);if(mode==='withheld'||mode==='false-prefix')assert.equal(workReads,0,'early DATA denial/false guard must precede Work SEND');continue;}
        assert.equal((await load(model('affiliate','Partner'),partner.id))?.data.provider_account,mode==='snapshot'?'acct-replaced':'acct-original',mode);
        const settlements=await store.query({model:model('affiliate','Settlement'),authority:'owner'});assert.equal(settlements.length,1);
        const settlement=settlements[0]!;assert.equal(settlement.id,'settlement-created');assert.equal(settlement.data.account,'acct-original');assert.equal(settlement.data.source,request.operation_id);
        const pending=await store.outboxPending();assert.equal(pending.length,1);
        assert.deepEqual(pending[0]!.arguments,{binding:'affiliate.Commissions',from:'deployment.commissions',arguments:{source:request.operation_id,account:'acct-original',amount:{minor:'100',currency:'EUR'}}});
        const schedules=await store.query({model:asModel('work.schedule'),authority:'owner'});assert.equal(schedules.length,1);
        const scheduled=schedules[0]!;assert.equal(scheduled.data.key,'commission-settlement-created');assert.equal(scheduled.data.state,'pending');
        assert.equal(scheduled.data.scopeOwner,scope.owner);assert.equal(scheduled.data.scopeOwnerPackage,'affiliate');
        assert.deepEqual(scheduled.data.payload,{settlement:{id:settlement.id,version:String(settlement.version)}});
        const slot=await store.scheduleGet([scope.app,scope.ownerPackage,scope.owner,'commission-settlement-created'].map(encodeURIComponent).join('/'));assert.ok(slot);assert.equal(slot.at,now+300000);
        const saved=await store.readReceipt({app:scope.app,owner:scope.owner,principal:user.user_id,operation:request.operation,operationId:request.operation_id} as Parameters<typeof store.readReceipt>[0]);assert.ok(saved);assert.ok(saved.outcome.status==='committed');assertSavedSourceReceipt(artifact,saved);
        const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay&&replay.result.status==='replayed',JSON.stringify(replay));assert.deepEqual(replay.result.records,[{...settlement,data:{source:settlement.data.source,account:settlement.data.account,amount:settlement.data.amount,allocation:settlement.data.allocation,bank:settlement.data.bank,reconcile_delivery:settlement.data.reconcile_delivery,seen:settlement.data.seen}}]);assert.equal(replay.result.result,null);
        assert.deepEqual(await store.outboxPending(),pending);assert.deepEqual(await store.query({model:asModel('work.schedule'),authority:'owner'}),schedules);
        const deliver=()=>invokeDueScheduleCanonical({asm,artifact,app:scope.app,store,identities,now:()=>now+300000,
          handler:'affiliate.observe',due:{key:'commission-settlement-created',scope,at:now+300000,event:'affiliate.SettlementCheck',occurrenceId:scheduled.id}});
        assert.equal((await deliver() as {status:string}).status,'completed');assert.equal((await deliver() as {status:string}).status,'replayed');
        assert.equal((await store.load(model('affiliate','Settlement'),settlement.id))?.data.seen,true);assert.deepEqual(await store.readReceipt(saved.identity),saved);
      }
    }finally{await rm(directory,{recursive:true,force:true});}
  });

it('retains original admitted booking identity through the complete no-show evidence transaction', {timeout:180000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-rent-emission-'));
 try{
  const source=join(root,'compiler/tests/fixtures/rent-original-emission.can');
  const original=await readFile(join(root,'draft/apps/CanRent/CanRent.can'),'utf8'),text=await readFile(source,'utf8');
  const start=original.indexOf('  export scenario no_show('),end=original.indexOf('  # Keep overtime',start);assert.ok(text.includes(original.slice(start,end)));
  const{stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const artifact=JSON.parse(stdout)as CompileArtifact,asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  for(const mode of ['allowed','stale','inactive','identity-at-source','parent-at-commit','withheld-data','grant-at-commit','depart','depart-nonexistent','depart-denied','depart-grant-at-commit']){
   if(process.env['CAN_RENT_EMISSION_CASE']&&!mode.startsWith(process.env['CAN_RENT_EMISSION_CASE']))continue;
   const departing=mode.startsWith('depart');
   const{now,identities,identity,user,team,membership}=await member('rent-emission-'+mode,['rent_reservations.reception','rent_reservations.reservation_manager']);
   const scope={app:'ConstructorCount',owner:team.team_id,ownerPackage:'rent_reservations'},authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'rent-state',fileStoreId:'rent-files',receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
   const{store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
   await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
   const resource={model:asModel('rent_reservations.Resource'),id:asId('resource')},row=(model:string,id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({kind:'insert'as const,model:asModel(model),row:{...makeRow({id:asId(id),data}),parent}});
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    row('rent_catalog.Location','site',{active:true}),row('employee.Employee','worker',{user:{id:user.user_id},active:mode!=='inactive',operator_wide:false,home:{id:'site'},locations:[]}),
    row('rent_reservations.Resource','resource',{location:{id:'site'},active:true,capacity:'7',pooled:false,timezone:'UTC',readable:mode!=='withheld-data'}),
    row('rent_reservations.Booking','booking',{from:new Date(now-7200000).toISOString(),until:new Date(now-3600000).toISOString(),intervals:[],quantity:'1',status:departing?'occupied':'confirmed',checked_in:departing?new Date(now-5400000).toISOString():null,checked_out:null,arrival_buffer:'0',departure_buffer:'0',source:'original',reserved_until:new Date(now-3600000).toISOString(),overdue:false,cancellation_reason:null},resource)
   ]}));
   const scheduleKey=(owner:string)=>[scope.app,scope.ownerPackage,owner,'original:occupancy'].map(encodeURIComponent).join('/');
   if(departing&&mode!=='depart-nonexistent'){
    const seeder=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
    const seeded=await seeder.invokeMutation({operation:'rent_reservations.seed_occupancy',operation_id:operationId(now),inputs:{booking:{id:'booking',version:'1'}}},identity);
    assert.ok('result'in seeded&&seeded.result.status==='committed','the original opaque Schedule must have a genuine source-bound Work header: '+JSON.stringify(seeded));
   }
   if(mode==='depart-denied'){const current=await store.load(resource.model,resource.id);assert.ok(current);await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:resource.model,id:current.id,expectedVersion:current.version,row:{...current,version:asVersion(current.version+1),data:{...current.data,readable:false}}}]}));}
   const originalSchedules=departing?await store.query({model:asModel('work.schedule'),authority:'owner'}):[];
   const load=store.load.bind(store),commit=store.commit.bind(store);let raced=false;
   store.load=async(model,id)=>{if(mode==='identity-at-source'&&model==='work.occurrence'&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}return load(model,id);};
   store.commit=async batch=>{if(['parent-at-commit','grant-at-commit','depart-grant-at-commit'].includes(mode)&&!raced&&batch.writes.some(write=>write.model==='work.occurrence')){raced=true;const current=await load(resource.model,resource.id);assert.ok(current);await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:resource.model,id:current.id,expectedVersion:current.version,row:{...current,version:asVersion(current.version+1),data:{...current.data,...(mode==='parent-at-commit'?{capacity:'8'}:{readable:false})}}}]}));}return commit(batch);};
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now}),request={operation:departing?'rent_reservations.depart':'rent_reservations.no_show',operation_id:operationId(now),inputs:{booking:{id:'booking',version:mode==='stale'?'0':'1'},...(departing?{}:{reason:'Missed arrival'})}};
   const outcome=await invoker.invokeMutation(request,identity),success=mode==='allowed'||mode==='parent-at-commit'||mode==='depart'||mode==='depart-nonexistent';assert.equal('result'in outcome&&outcome.result.status==='committed',success,mode+': '+JSON.stringify(outcome));
   const policies=await store.query({model:asModel('rent_reservations.ResourcePolicy'),authority:'owner'}),evidence=await store.query({model:asModel('rent_reservations.BookingEvidence'),authority:'owner'}),events=await store.query({model:asModel('work.occurrence'),authority:'owner'});
   for(const rows of [policies,evidence,events])assert.equal(rows.length,success?1:0,mode);assert.equal((await load(asModel('rent_reservations.Booking'),asId('booking')))?.data.status,success?(departing?'completed':'no_show'):(departing?'occupied':'confirmed'),mode);
   if(mode==='identity-at-source'||mode==='parent-at-commit'||mode==='grant-at-commit'||mode==='depart-grant-at-commit')assert.equal(raced,true,mode);
   if(departing){const ownSlot=await store.scheduleGet(scheduleKey(scope.owner));if(success)assert.equal(ownSlot,null,'authored CANCEL removes only its own active key');
    if(!success)assert.deepEqual(await store.query({model:asModel('work.schedule'),authority:'owner'}),originalSchedules,'rejected evidence rolls back cancellation');
   }
   if(success){assert.equal((policies[0]!.data.value as {capacity:string}).capacity,mode==='parent-at-commit'?'8':'7','commit retry must rebuild original Resource DATA, never retain stale capacity');assert.equal(evidence[0]!.data.key,'booking');assert.equal(evidence[0]!.data.sequence,'1');assert.equal((evidence[0]!.data.value as {status:string}).status,departing?'completed':'no_show');
    const result=events[0]!.data.result as {payload:unknown};assert.deepEqual(result.payload,{booking:{id:'booking',version:'2'},revision:'2'});
    const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay&&replay.result.status==='replayed');assert.deepEqual(await store.query({model:asModel('work.occurrence'),authority:'owner'}),events);
   }
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('sends the complete original Quote derived Contract with stored intervals and contained lines', {timeout:180000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-quote-derived-contract-'));
 try{
  const source=join(root,'compiler/tests/fixtures/propose-document-derived-contract.can'),original=await readFile(join(root,'draft/apps/CanPropose/CanPropose.can'),'utf8'),text=await readFile(source,'utf8');
  const start=original.indexOf('  export scenario document('),end=original.indexOf('   examples ',start);
  assert.ok(text.includes(original.slice(start,end)),'complete original guard, SEND and SET');
  for(const prefix of ['  derive Revision.snapshot:','  export contract QuoteDocument ','  export contract QuoteLine ','  export contract QuoteInterval '])assert.ok(text.includes(original.split('\n').find(line=>line.startsWith(prefix))!),'exact original '+prefix);
  const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const artifact=JSON.parse(stdout) as CompileArtifact,asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  for(const mode of ['allowed','hidden-child','foreign-child','denied-root','denied-snapshot','denied-intervals','denied-tax','false-prefix','child-race','child-grant-race','child-insert-race','interval-race','grant-race','identity-race']){
   const {now,identities,identity,team,user,membership}=await member('quote-derived-'+mode,['propose.salesperson']);
   const scope={app:'CanPropose',owner:team.team_id,ownerPackage:'propose'},authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'quote-state',fileStoreId:'quote-files',receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
   const {store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
   await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
   const row=(id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({...makeRow({id:asId(id),data}),parent});
   const intervals=[{from:'2099-01-01T09:00:00.000Z',until:'2099-01-01T10:00:00.000Z'}],money={minor:'1000',currency:'EUR'},zero={minor:'0',currency:'EUR'};
   const revision=row('revision',{number:'1',issuer_snapshot:'Frozen issuer',title_snapshot:'Frozen title',location_snapshot:'Frozen location',customer_snapshot:'Frozen customer',resource:null,quantity:'2',seats:'4',recipient_email:user.email,from:intervals[0]!.from,until:intervals[0]!.until,intervals,terms:'Original terms',refund_before:intervals[0]!.from,expires:'2099-01-01T08:00:00.000Z',total:money,state:mode==='false-prefix'?'withdrawn':'sent',document:null,document_state:'none',root_visible:mode!=='denied-root',snapshot_visible:mode!=='denied-snapshot',intervals_visible:mode!=='denied-intervals'},{model:model('propose','Proposal'),id:asId('proposal')});
   const child={model:model('propose','Revision'),id:revision.id},item=row('item-a',{title:'Original line',quantity:'2',unit:'hour',price:money,tax:zero,discount:zero,hidden:mode==='hidden-child',tax_visible:mode!=='denied-tax'},child);
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    {kind:'insert',model:model('customer','Customer'),row:row('customer',{active:true})},
    {kind:'insert',model:model('rent_catalog','Location'),row:row('location',{active:true})},
    {kind:'insert',model:model('employee','Employee'),row:row('worker',{user:{id:user.user_id},home:{id:'location'},locations:[],operator_wide:false,active:true,hidden:true})},
    {kind:'insert',model:model('propose','Proposal'),row:row('proposal',{location:{id:'location'}},{model:model('customer','Customer'),id:asId('customer')})},
    {kind:'insert',model:model('propose','Revision'),row:revision},{kind:'insert',model:model('propose','Item'),row:item},
    ...(mode==='foreign-child'?[{kind:'insert' as const,model:model('propose','Revision'),row:{...revision,id:asId('foreign')}},{kind:'insert' as const,model:model('propose','Item'),row:{...item,id:asId('foreign-item'),data:{...item.data,title:'Foreign secret'},parent:{model:model('propose','Revision'),id:asId('foreign')}}}]:[])]}));
   const load=store.load.bind(store),commit=store.commit.bind(store);let raced=false;
   store.load=async(name,id)=>{if(!raced&&mode==='identity-race'&&name==='work.dispatch'){raced=true;await identities.removeMembership(membership.membership_id);}return load(name,id);};
   store.commit=async batch=>{if(!raced&&mode.endsWith('-race')&&mode!=='identity-race'&&batch.writes.some(write=>write.model==='work.dispatch')){
    raced=true;const isChild=mode.startsWith('child-'),name=isChild?model('propose','Item'):model('propose','Revision'),old=await load(name,isChild?item.id:revision.id);assert.ok(old);
    if(mode==='child-insert-race')await commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:name,row:{...old,id:asId('item-b'),data:{...old.data,title:'New line'}}}]}));
    else await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:name,id:old.id,expectedVersion:old.version,row:{...old,version:asVersion(old.version+1),data:{...old.data,...(isChild?mode==='child-grant-race'?{tax_visible:false}:{title:'Concurrent line'}:mode==='interval-race'?{intervals:[]}:{snapshot_visible:false})}}}]}));
   }return commit(batch);};
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now}),request={operation:'propose.document',operation_id:operationId(now),inputs:{revision:{id:'revision',version:'1'}}};
   const result=await invoker.invokeMutation(request,identity),success=['allowed','hidden-child','foreign-child','child-race','child-insert-race'].includes(mode);
   assert.equal('result'in result,success,mode+': '+JSON.stringify(result));if(mode.endsWith('-race'))assert.ok(raced,mode);
   const pending=await store.outboxPending();assert.equal(pending.length,success?1:0,mode);assert.equal((await load(model('propose','Revision'),revision.id))?.data['document_state'],success?'pending':'none',mode);
   if(success){const snapshot=(pending[0]!.arguments as {arguments:{snapshot:unknown}}).arguments.snapshot;
    const receipt=await load(asModel('work.receipt'),pending[0]!.intentId as ReturnType<typeof asId>),origin=receipt?.data['filePayloadOrigin'] as {origin?:{kind:string;declaration?:{canonical?:{capability:string;operation:string}}}}|undefined;
    assert.equal(origin?.origin?.kind,'delivery-result','pending receipt retains its genuine File result origin');
    assert.equal(origin?.origin?.declaration?.canonical?.capability,'propose.DocumentsV1');
    assert.equal(origin?.origin?.declaration?.canonical?.operation,'quote');
    assert.deepEqual(snapshot,{issuer:'Frozen issuer',customer:'Frozen customer',resource:null,quantity:'2',attendees:'4',recipient:user.email,title:'Frozen title',location:'Frozen location',from:intervals[0]!.from,until:intervals[0]!.until,intervals,terms:'Original terms',refund_before:intervals[0]!.from,expires:'2099-01-01T08:00:00.000Z',lines:mode==='hidden-child'?[]:[{title:mode==='child-race'?'Concurrent line':'Original line',quantity:'2',unit:'hour',price:money,tax:zero,discount:zero},...(mode==='child-insert-race'?[{title:'New line',quantity:'2',unit:'hour',price:money,tax:zero,discount:zero}]:[])],total:money});
    assert.ok('result'in await invoker.invokeMutation(request,identity));assert.deepEqual(await store.outboxPending(),pending,'replay retains frozen original snapshot');}
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('executes the original refund review with counted evidence and conditional declared release atomically', {timeout:180000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-rent-refund-evidence-'));
 try{
  const source=join(root,'compiler/tests/fixtures/rent-refund-evidence.can'),original=await readFile(join(root,'draft/apps/CanRent/CanRent.can'),'utf8'),text=await readFile(source,'utf8');
  const start=original.indexOf('  scenario refund_review('),end=original.indexOf('  # Mark a capacity conflict',start);assert.ok(text.includes(original.slice(start,end)));
  const{stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const artifact=JSON.parse(stdout)as CompileArtifact,asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  for(const mode of ['allowed','release','no-restore','fallback-total','withheld-data','role-during-send','source-at-commit']){
   const{now,identities,identity,user,team,membership}=await member('rent-refund-'+mode,['rent_reservations.billing','rent_reservations.reservation_manager']);
   const scope={app:'ConstructorCount',owner:team.team_id,ownerPackage:'rent_reservations'},authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'rent-state',fileStoreId:'rent-files',receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
   const{store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
   await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
   const resource={model:asModel('rent_reservations.Resource'),id:asId('resource')},row=(model:string,id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({kind:'insert'as const,model:asModel(model),row:{...makeRow({id:asId(id),data}),parent}});
   const release=mode==='release'||mode==='no-restore',amount={minor:mode==='fallback-total'?'300':'200',currency:'EUR'};
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    row('rent_catalog.Location','site',{active:true}),row('employee.Employee','worker',{user:{id:user.user_id},active:true,operator_wide:false,home:{id:'site'},locations:[]}),row('customer.Customer','customer',{name:'Test customer'}),
    row('rent_reservations.Resource','resource',{location:{id:'site'},active:true,capacity:'7',pooled:false,timezone:'UTC',readable:mode!=='withheld-data'}),
    row('rent_reservations.Booking','booking',{from:new Date(now-7200000).toISOString(),until:new Date(now-3600000).toISOString(),intervals:[],quantity:'1',status:'review',checked_in:null,checked_out:null,arrival_buffer:'0',departure_buffer:'0',source:'original',reserved_until:new Date(now-3600000).toISOString(),overdue:false,cancellation_reason:null,customer:{id:'customer'},payment:'paid',refund_before:new Date(now+(mode==='no-restore'?-1000:1000)).toISOString(),refund_delivery:null,allowance:release?'reserved':'not_required',release_delivery:null,allowance_source:'original-allowance',monetary_due:mode==='fallback-total'?null:{minor:'200',currency:'EUR'},total:{minor:'300',currency:'EUR'},refund_state:'pending',refund_requested:null},resource)
   ]}));
   const load=store.load.bind(store),commit=store.commit.bind(store);let raced=false;
   store.load=async(model,id)=>{if(mode==='role-during-send'&&model==='work.dispatch'&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}return load(model,id);};
   store.commit=async batch=>{if(mode==='source-at-commit'&&!raced&&batch.writes.some(write=>write.model==='work.dispatch')){raced=true;const current=await load(asModel('rent_reservations.Booking'),asId('booking'));assert.ok(current);await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:asModel('rent_reservations.Booking'),id:current.id,expectedVersion:current.version,row:{...current,version:asVersion(current.version+1),data:{...current.data,source:'changed-original'}}}]}));}return commit(batch);};
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now}),request={operation:'rent_reservations.refund_review',operation_id:operationId(now),inputs:{booking:{id:'booking',version:'1'},reason:'Approved exception'}};
   const outcome=await invoker.invokeMutation(request,identity),success=!['withheld-data','role-during-send','source-at-commit'].includes(mode);assert.equal('result'in outcome&&outcome.result.status==='committed',success,mode+': '+JSON.stringify(outcome));
   const policies=await store.query({model:asModel('rent_reservations.ResourcePolicy'),authority:'owner'}),evidence=await store.query({model:asModel('rent_reservations.BookingEvidence'),authority:'owner'}),events=await store.query({model:asModel('work.occurrence'),authority:'owner'}),pending=await store.outboxPending();
   for(const rows of[policies,evidence,events])assert.equal(rows.length,success?1:0,mode);assert.equal(pending.length,success?(release?2:1):0,mode);
   const booking=await load(asModel('rent_reservations.Booking'),asId('booking'));assert.ok(booking);assert.equal(booking.data.status,success?'cancelled':'review',mode);
   if(mode==='role-during-send'||mode==='source-at-commit')assert.equal(raced,true,mode);
   if(success){assert.deepEqual(booking.data.refund_requested,amount);const refund=pending.find(item=>item.target==='invoice.BillingV1.refund');assert.ok(refund);assert.equal(booking.data.refund_delivery,refund.intentId);
    assert.deepEqual(refund.arguments,{binding:'rent_reservations.Billing',from:'deployment.billing',arguments:{source:'original',amount,reason:'Approved exception'}});
    if(release){const released=pending.find(item=>item.target==='member_terms.MembershipV1.release');assert.ok(released);assert.equal(booking.data.release_delivery,released.intentId);assert.deepEqual(released.arguments,{binding:'rent_reservations.Membership',from:'deployment.membership',arguments:{source:'original-allowance',customer:'customer',restore_consumed:mode!=='no-restore'}});}
    const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay&&replay.result.status==='replayed');assert.deepEqual(await store.outboxPending(),pending);assert.deepEqual(await store.query({model:asModel('work.occurrence'),authority:'owner'}),events);
    if(mode==='allowed'){
     const write=(resourceId:string,sequence:string,key:string)=>invoker.invokeMutation({operation:'rent_reservations.write_evidence',operation_id:operationId(now),inputs:{resource:{id:resourceId,version:'1'},sequence,key}},identity);
     const before=await store.query({model:asModel('rent_reservations.BookingEvidence'),authority:'owner'});
     const duplicate=await write('resource','1','booking');assert.ok('error'in duplicate,'same parent + ordered int/text tuple must reject');assert.deepEqual(await store.query({model:asModel('rent_reservations.BookingEvidence'),authority:'owner'}),before);
     const different=await write('resource','1','booking,"second"');assert.ok('result'in different&&different.result.status==='committed',JSON.stringify(different));
     const noPolicy=await write('resource','99','unmatched-policy');assert.ok('error'in noPolicy,'original relation invariant must reject even a unique tuple');
     const rows=await store.query({model:asModel('rent_reservations.BookingEvidence'),authority:'owner'}),second=rows.find(row=>row.data.key==='booking,"second"');assert.ok(second);
     const locked=await invoker.invokeMutation({operation:'rent_reservations.alter_evidence',operation_id:operationId(now),inputs:{evidence:{id:second.id,version:String(second.version)},key:'different'}},identity);assert.ok('error'in locked,'original evidence key lock remains enforced');assert.deepEqual(await store.query({model:asModel('rent_reservations.BookingEvidence'),authority:'owner'}),rows);
     await store.commit(makeBatch(await store.readRevision(),{writes:[row('rent_reservations.Resource','other-resource',{location:{id:'site'},active:true,capacity:'7',pooled:false,timezone:'UTC',readable:true}),row('rent_reservations.ResourcePolicy','other-policy',{effective:new Date(now).toISOString(),sequence:'1',baseline:false,value:{active:true,capacity:'7',pooled:false,timezone:'UTC'}},{model:resource.model,id:asId('other-resource')})]}));
     const other=await write('other-resource','1','booking');assert.ok('result'in other&&other.result.status==='committed','identical tuple under another actual parent must remain independent: '+JSON.stringify(other));
     const malformed=await write('resource','01','malformed-int');assert.ok('error'in malformed,'owning integer codec rejects noncanonical tuple wire');
     for(const fieldName of ['sequence','key']){
      const altered=structuredClone(artifact),field=altered.models?.find(model=>model.name==='rent_reservations.BookingEvidence')?.fields.find(field=>field.name===fieldName);assert.ok(field);(field as {nullable:boolean}).nullable=true;
      await assert.rejects(installNativeFileInventory({artifact:altered,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{}}),/artifact differs from assembled source/,'mutable nullable schema cannot borrow the original required tuple producer');
     }
    }
   }
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('executes the original Rent block contained sibling constructors with their complete native prefix', {timeout:600000},async({signal})=>{
 const directory=await mkdtemp(join(tmpdir(),'can-rent-block-loop-'));
 const databases:Miniflare[]=[];
 let disposal:Promise<void>|undefined;
 const dispose=()=>disposal??=Promise.all(databases.map(database=>database.dispose())).then(()=>{});
 signal.addEventListener('abort',()=>{void dispose().catch(()=>{});},{once:true});
 try{
  const source=join(root,'compiler/tests/fixtures/rent-block-loop-source.can');
  const authored=await readFile(join(root,'draft/apps/CanRent/CanRent.can'),'utf8'),fixtureSource=await readFile(source,'utf8');
  const start=authored.indexOf('    create Downtime {parent=resource,source=operation.id,from,until,reason} as downtime');
  const end=authored.indexOf(' as conflict',start)+' as conflict'.length;
  assert.ok(start>=0&&fixtureSource.includes(authored.slice(start,end)),'preserves the entire original block body');
  const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const originalArtifact=JSON.parse(stdout) as CompileArtifact;
  const artifact=originalArtifact;
  const asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  const conditionalSource=join(directory,'conditional.can');
  await writeFile(conditionalSource,fixtureSource.replace(
   '     create Conflict {parent=resource,booking,reason} as conflict',
   '     if booking.status==confirmed\n      create Conflict {parent=resource,booking,reason} as conflict'));
  const conditionalCompile=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,conditionalSource],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const conditionalArtifact=JSON.parse(conditionalCompile.stdout) as CompileArtifact;
  const conditionalAsm=await assembleModules({artifact:conditionalArtifact,sourcePath:conditionalSource},{workDir:join(directory,'conditional'),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  const modes=(process.env['CAN_RENT_BLOCK_CASE']??'base,empty,null-until,large,inactive,hidden,stale,identity-race,role-race,insert-race,overflow,physical-cap,d1-conditional-sparse,d1-conditional-false,d1-conditional-budget,d1-conditional-role-race').split(',');
  for(const mode of modes){
   signal.throwIfAborted();
   const conditional=mode.startsWith('d1-conditional-');
   const artifact=conditional?conditionalArtifact:originalArtifact,modules=conditional?conditionalAsm:asm;
   const {now,identities,identity,user:actor,membership}=await member('rent-block-'+mode,['rent_reservations.reservation_manager']);
   let database:D1Database|undefined;
   if(conditional){
    const worker=new Miniflare({compatibilityDate:'2026-07-15',modules:true,script:'export default { fetch() { return new Response("ok"); } }',d1Databases:{DB:'rent-block-'+mode},d1Persist:join(directory,mode)});
    databases.push(worker);database=await worker.getD1Database('DB') as unknown as D1Database;await ensureSchema(database);
   }
   const store=database===undefined?createTestMemoryStorage().store:createD1Storage(database),parent={model:asModel('rent_reservations.Resource'),id:asId('resource')};
   const date=(offset:number)=>new Date(now+offset).toISOString();
   const insert=(model:string,id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({kind:'insert' as const,model:asModel(model),row:{...makeRow({id:asId(id),data}),parent}});
   const booking=(id:string,status='confirmed',owner=parent,extra:Record<string,unknown>={})=>insert('rent_reservations.Booking',id,{hidden:mode==='hidden',status,expires:date(10000),checked_in:null,checked_out:null,departure_buffer:'0',reserved_from:date(-1000),reserved_until:date(10000),...extra},owner);
   const count=mode==='large'?1000:mode==='overflow'?1001:mode==='physical-cap'?2200:mode==='d1-conditional-budget'?201:mode==='d1-conditional-sparse'?1:mode==='empty'?0:2;
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    insert('rent_catalog.Location','site',{active:true}),
    insert('employee.Employee','operator',{user:{id:actor.user_id},active:mode!=='inactive',operator_wide:false,home:{id:'site'},locations:[]}),
    insert('rent_reservations.Resource','resource',{location:{id:'site'},active:true,capacity:'7',pooled:false,timezone:'UTC'}),
    insert('rent_reservations.Resource','other',{location:{id:'site'},active:true,capacity:'7',pooled:false,timezone:'UTC'}),
    ...Array.from({length:count},(_,i)=>booking('booking-'+String(i).padStart(4,'0'),mode==='physical-cap'?'completed':['d1-conditional-false','d1-conditional-budget'].includes(mode)?'occupied':'confirmed')),
    booking('foreign','confirmed',{model:parent.model,id:asId('other')}),
    booking('completed','completed'),booking('expired','held',parent,{expires:date(-1000)}),booking('outside','occupied',parent,{reserved_from:date(10000),reserved_until:date(20000)})
   ]}));
   const query=store.query.bind(store),commit=store.commit.bind(store);let raced=false;
   store.query=async spec=>{signal.throwIfAborted();const rows=await query(spec);if(['identity-race','role-race','d1-conditional-role-race'].includes(mode)&&!raced&&spec.model==='rent_reservations.Booking'){raced=true;if(mode==='role-race'||mode==='d1-conditional-role-race')await identities.setMembershipRoles(membership.membership_id,[]);else await identities.removeMembership(membership.membership_id);}return rows;};
   store.commit=async batch=>{signal.throwIfAborted();if(mode==='insert-race'&&!raced&&batch.writes.some(write=>write.model==='rent_reservations.Conflict')){raced=true;await commit(makeBatch(await store.readRevision(),{writes:[booking('raced')]}));}return commit(batch);};
   const invoker=buildInvoker(artifact,modules,store,{memberships:identities,now:()=>now});
   const request={operation:'rent_reservations.block',operation_id:operationId(now),inputs:{resource:{id:'resource',version:mode==='stale'?'2':'1'},from:date(0),until:mode==='null-until'?null:date(5000),reason:'maintenance'}};
   const snapshot=async()=>{
    assert.ok(database);const tables=await database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{name:string}>();assert.equal(tables.success,true);
    const rows:Record<string,Record<string,unknown>[]>={};for(const {name} of tables.results){const selected:{success:boolean;results:Record<string,unknown>[]} =await database.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all<Record<string,unknown>>();assert.equal(selected.success,true);rows[name]=selected.results.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));}return rows;
   };
   const before=database===undefined?undefined:await snapshot();
   const result=await invoker.invokeMutation(request,identity),success=['base','empty','null-until','large','insert-race','hidden','d1-conditional-sparse','d1-conditional-false'].includes(mode);
   assert.equal('result'in result,success,mode+': '+JSON.stringify(result));
   if(mode==='d1-conditional-budget'){
    assert.ok('error'in result);assert.equal(result.error.code,'validation');
    assert.match(result.error.message,/source control needs its actual quiescent owner stage/);
   }
   for(const name of ['Downtime','ResourcePolicy','DowntimeEvidence'])assert.equal((await query({model:asModel('rent_reservations.'+name),authority:'owner'})).length,success?1:0,mode+': atomic '+name);
   const conflicts=await query({model:asModel('rent_reservations.Conflict'),authority:'owner'});
   assert.equal(conflicts.length,success?(mode==='d1-conditional-false'?0:count+(['insert-race','null-until'].includes(mode)?1:0)):0,mode+': exact selected census');
   if(database!==undefined&&!success){
    assert.ok(before);assert.ok('error'in result);
    const after=await snapshot();
    if(mode==='d1-conditional-role-race'){
     assert.equal(result.error.code,'forbidden');assert.equal(raced,true);
     assert.deepEqual(after,before,'revoked admission publishes no business effects, receipt, history or fence');
     assert.equal(after['receipts']!.some(row=>row['operation_id']===request.operation_id),false,'revoked admission has no saved rejection');
     const denied=await invoker.invokeMutation(request,identity);assert.ok('error'in denied);assert.equal(denied.error.code,'forbidden');
     assert.deepEqual(await snapshot(),before,'retry of unseen revoked admission remains effect-free');
    }else{
    const revision=Number(before['fence']![0]!['revision'])+1;
    assert.deepEqual(Object.keys(after),Object.keys(before));
    for(const table of Object.keys(before))if(!['receipts','fence','fence_log'].includes(table))assert.deepEqual(after[table],before[table],mode+': business, history, sequences and side effects roll back '+table);
    assert.deepEqual(after['fence'],before['fence']!.map(row=>({...row,revision})));
    assert.equal(after['fence_log']!.length,before['fence_log']!.length+1);
    assert.deepEqual(after['fence_log']!.filter(row=>row['revision']!==revision),before['fence_log']);
    assert.deepEqual(after['fence_log']!.find(row=>row['revision']===revision),{revision,operation:request.operation,at:now});
    assert.equal(after['receipts']!.length,before['receipts']!.length+1);
    assert.deepEqual(after['receipts']!.filter(row=>row['operation_id']!==request.operation_id),before['receipts']);
    assert.deepEqual(after['receipts']!.find(row=>row['operation_id']===request.operation_id),{
     app:'ConstructorCount',owner:identity.team!.team_id,principal:actor.user_id,operation:request.operation,
     operation_id:request.operation_id,input_hash:await hashInputs(request.inputs),
     outcome:JSON.stringify({status:'rejected',code:result.error.code,message:result.error.message}),
     committed_revision:revision,created_at:now,resolved_defaults:'{}'});
    const replay=await invoker.invokeMutation(request,identity);assert.deepEqual(replay,result,mode+': canonical rejected replay');
    assert.deepEqual(await snapshot(),after,mode+': replay adds no receipt or fence');
    if(mode==='d1-conditional-budget'){
     await identities.setMembershipRoles(membership.membership_id,[]);
     const revoked=await invoker.invokeMutation(request,identity);assert.deepEqual(revoked,result,'ordinary rejected replay preserves its original deterministic rejection after role loss');
     assert.deepEqual(await snapshot(),after,'rejected replay changes no audit history');
     const unseen=await invoker.invokeMutation({...request,operation_id:operationId(now)},identity);assert.ok('error'in unseen);assert.equal(unseen.error.code,'forbidden','a fresh operation still requires current owner authority');
     assert.deepEqual(await snapshot(),after,'denied fresh admission changes no audit history');
    }
    }
   }
   if(success){
    if(mode==='hidden'){assert.ok('result'in result);assert.ok(!JSON.stringify(result.result.records??[]).includes('"booking":'),'CONTROL selection does not expose unreadable selected references');}
    assert.ok(conflicts.every(row=>row.parent?.id==='resource'&&row.data['reason']==='maintenance'&&row.data['downtime']===null));
    const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay&&replay.result.status==='replayed',mode+': '+JSON.stringify(replay));
    assert.deepEqual(await query({model:asModel('rent_reservations.Conflict'),authority:'owner'}),conflicts);
   }
   if(mode.endsWith('-race'))assert.equal(raced,true,mode);
  }
 }finally{await dispose();await rm(directory,{recursive:true,force:true});}
});

it('emits the original Shift request with its genuine created Swap and parent DATA', {timeout:180000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-shift-created-emit-'));
 try{
  const source=join(root,'compiler/tests/fixtures/shift-request-original.can'),original=await readFile(join(root,'draft/apps/CanShift/CanShift.can'),'utf8'),text=await readFile(source,'utf8');
  const start=original.indexOf('  scenario request_swap('),end=original.indexOf('  # Accept',start);assert.ok(text.includes(original.slice(start,end)),'complete unchanged original request_swap');
  const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const artifact=JSON.parse(stdout) as CompileArtifact;assert.equal(artifact.operations?.find(operation=>operation.name==='shift.request_swap')?.result?.disclosure,undefined,'genuine source-only frame');
  const asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  const deniedSource=join(directory,'denied-original.can');
  await writeFile(deniedSource,text.replaceAll('fields=parent,employee,location','fields=parent,location').replace('    emit DutyNotice {duty,recipient=substitute.user,revision=duty.parent.revision,kind=swap_request,swap}\n',''));
  const deniedCompile=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,deniedSource],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const deniedArtifact=JSON.parse(deniedCompile.stdout)as CompileArtifact,deniedAsm=await assembleModules({artifact:deniedArtifact,sourcePath:deniedSource},{workDir:join(directory,'denied-original'),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  const originalArtifact=artifact,originalAsm=asm;
  for(const mode of ['allowed','denied-original-reference','member-only','denied-user','denied-parent-field','false-prefix','inactive-substitute','stale','parent-race','parent-grant-race','user-grant-race','identity-race']){
   const artifact=mode==='denied-original-reference'?deniedArtifact:originalArtifact,asm=mode==='denied-original-reference'?deniedAsm:originalAsm;
   const {now,identities,identity,team,user,membership}=await member('shift-created-'+mode,mode==='member-only'?[]:['shift.scheduler']);
   const substitute=await identities.createUser({email:'substitute-'+mode+'@shift.test',password_hash:'unused',email_verified:true});
   await identities.createMembership({team_id:team.team_id,user_id:substitute.user_id,is_owner:false,roles:[]});
   const scope={app:'CanShift',owner:team.team_id,ownerPackage:'shift'},authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'shift-state',fileStoreId:'shift-files',receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
   const {store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
   await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
   const row=(id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({...makeRow({id:asId(id),data}),parent});
   const employee={home:{id:'location'},locations:[],operator_wide:false,active:true,skills:['reception'],role:'Reception',visible:true,user_visible:true};
   const commitment=row('commitment',{employee:{id:'employee'},location:{id:'location'},from:'2099-01-01T09:00:00.000Z',until:'2099-01-01T17:00:00.000Z',before:'0',after:'0',skill:'reception',kind:'duty',source:'original-duty',previous:null,revision:'7',active:true,conflict:false,revision_visible:mode!=='denied-parent-field'},{model:model('shift','Roster'),id:asId('roster')});
   const duty=row('duty',{role:'Reception',published:mode!=='false-prefix',published_revision:'7',published_by:{id:user.user_id},override_reason:null},{model:model('shift','Commitment'),id:commitment.id});
   const substituteRow=row('substitute',{...employee,user:{id:substitute.user_id},active:mode!=='inactive-substitute',user_visible:mode!=='denied-user'});
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    {kind:'insert',model:model('rent_catalog','Location'),row:row('location',{active:true})},
    {kind:'insert',model:model('employee','Employee'),row:row('employee',{...employee,user:{id:user.user_id}})},
    {kind:'insert',model:model('employee','Employee'),row:substituteRow},
    {kind:'insert',model:model('shift','Roster'),row:row('roster',{name:'Original roster'})},
    {kind:'insert',model:model('shift','Commitment'),row:commitment},{kind:'insert',model:model('shift','Duty'),row:duty}]}));
   const load=store.load.bind(store),commit=store.commit.bind(store);let raced=false;
   store.load=async(name,id)=>{if(!raced&&mode==='identity-race'&&name==='work.occurrence'){raced=true;await identities.removeMembership(membership.membership_id);}return load(name,id);};
   store.commit=async batch=>{if(!raced&&['parent-race','parent-grant-race','user-grant-race'].includes(mode)&&batch.writes.some(write=>write.model==='work.occurrence')){
    raced=true;const parent=mode.startsWith('parent-'),name=parent?model('shift','Commitment'):model('employee','Employee'),old=await load(name,parent?commitment.id:substituteRow.id);assert.ok(old);
    await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:name,id:old.id,expectedVersion:old.version,row:{...old,version:asVersion(old.version+1),data:{...old.data,...(parent?mode==='parent-grant-race'?{revision_visible:false}:{revision:'8'}:{user_visible:false})}}}]}));
   }return commit(batch);};
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now}),request={operation:'shift.request_swap',operation_id:operationId(now),inputs:{duty:{id:'duty',version:mode==='stale'?'2':'1'},substitute:{id:'substitute',version:'1'}}};
   const result=await invoker.invokeMutation(request,identity),success=['allowed','parent-race'].includes(mode);assert.equal('result'in result,success,mode+': '+JSON.stringify(result));
   if(mode==='member-only'&&'error'in result)assert.equal(result.error.code,'forbidden','the constructor DATA loan refuses the private Roster ancestor before later EMIT');
   if(mode.endsWith('-race'))assert.ok(raced,mode);
   const swaps=await store.query({model:model('shift','Swap'),authority:'owner'}),events=await store.query({model:asModel('work.occurrence'),authority:'owner'});assert.equal(swaps.length,success?1:0,mode);assert.equal(events.length,success?1:0,mode);
   if(success){assert.deepEqual(swaps[0]!.parent,{model:model('shift','Duty'),id:duty.id});assert.deepEqual(swaps[0]!.data,{substitute:{id:'substitute'},original:{id:'employee'},revision:mode==='parent-race'?'2':'1',state:'open'});
    assert.deepEqual((events[0]!.data['result'] as {payload:unknown}).payload,{duty:{id:'duty',version:'1'},recipient:{id:substitute.user_id},revision:mode==='parent-race'?'8':'7',kind:'swap_request',swap:{id:swaps[0]!.id,version:'1'}});
    assert.ok(Object.hasOwn(events[0]!.data,'filePayloadOrigin'),'genuine declared Work source origin');
    const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay||replay.error.code==='validation',JSON.stringify(replay));assert.deepEqual(await store.query({model:model('shift','Swap'),authority:'owner'}),swaps);assert.deepEqual(await store.query({model:asModel('work.occurrence'),authority:'owner'}),events);
   }
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('uses the original Shift nested nullable FIRST guards before actual assignment', {timeout:360000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-shift-helper-first-'));
 try{
  const source=join(root,'compiler/tests/fixtures/shift-assign-original.can'),original=await readFile(join(root,'draft/apps/CanShift/CanShift.can'),'utf8'),text=await readFile(source,'utf8');
  const start=original.indexOf('  scenario assign('),end=original.indexOf('   examples',start);assert.ok(text.includes(original.slice(start,end)));
  for(const name of ['fits','previous_work','next_work','travel_entered'])assert.ok(text.includes(original.split('\n').find(line=>line.startsWith('  derive '+name+'('))!));
  const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const artifact=JSON.parse(stdout) as CompileArtifact,asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  for(const mode of ['empty','previous-same','previous-away','previous-buffer','nearest-same','nearest-away','next-away','absence','false-prefix','domain-race','identity-race']){
   const {now,identities,identity,team,user,membership}=await member('shift-first-'+mode,['shift.scheduler']);
   const store=createMemoryStorage(),day='2099-01-01T',at=(time:string)=>day+time+':00.000Z',roster={model:model('shift','Roster'),id:asId('roster')};
   const row=(id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({...makeRow({id:asId(id),data}),parent});
   const prior=(id:string,from:string,until:string,location='location',kind='duty')=>row(id,{employee:{id:'employee'},location:{id:location},from:at(from),until:at(until),before:'0',after:'0',skill:'reception',kind,source:id,previous:null,revision:'1',active:true,revision_visible:true,conflict:false},roster);
   const existing:StoredRow[]=[];
   if(mode.startsWith('previous-'))existing.push(prior('prior','14:00','16:00',mode==='previous-same'?'location':'away'));
   if(mode.startsWith('nearest-'))existing.push(prior('far','09:00','12:00',mode==='nearest-same'?'away':'location'),prior('near','14:00','16:00',mode==='nearest-same'?'location':'away'));
   if(mode==='next-away')existing.push(prior('next-far','21:00','22:00'),prior('next-near','19:00','20:00','away'));
   if(mode==='absence')existing.push(prior('absence','14:00','16:00','away','absence'));
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    {kind:'insert',model:model('rent_catalog','Location'),row:row('location',{active:mode!=='false-prefix'})},{kind:'insert',model:model('rent_catalog','Location'),row:row('away',{active:true})},
    {kind:'insert',model:model('employee','Employee'),row:row('employee',{user:{id:user.user_id},home:{id:'location'},locations:[{id:'away'}],operator_wide:false,active:true,skills:['reception'],role:'Reception',visible:true,user_visible:true})},
    {kind:'insert',model:model('shift','Roster'),row:row('roster',{name:'Original roster'})},
    {kind:'insert',model:model('shift','Availability'),row:row('availability',{employee:{id:'employee'},from:at('08:00'),until:at('23:00'),available:true},roster)},
    ...existing.map(row=>({kind:'insert' as const,model:model('shift','Commitment'),row}))]}));
   const commit=store.commit.bind(store),query=store.query.bind(store);let raced=false,scans=0;
   store.query=async input=>{if(input.model===model('shift','Commitment')){scans++;if(mode==='identity-race'&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}}return query(input);};
   store.commit=async batch=>{if(mode==='domain-race'&&!raced&&batch.writes.some(write=>write.model===model('shift','Duty'))){raced=true;await commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:model('shift','Commitment'),row:prior('raced','14:00','16:00','away')}]}));}return commit(batch);};
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now}),request={operation:'shift.assign',operation_id:operationId(now),inputs:{roster:{id:'roster',version:'1'},employee:{id:'employee',version:'1'},location:{id:'location',version:'1'},from:at('17:30'),until:at('18:00'),role:'Reception',skill:'reception',before:mode==='previous-buffer'?'1800000':'0',after:'0'}};
   const result=await invoker.invokeMutation(request,identity),success=['empty','previous-same','previous-buffer','nearest-same','absence'].includes(mode);assert.equal('result'in result,success,mode+': '+JSON.stringify(result));
   if(mode==='false-prefix')assert.equal(scans,0,'false original prefix does not enter helper domains');
   if(mode.endsWith('-race'))assert.ok(raced,mode);
   const duties=await query({model:model('shift','Duty'),authority:'owner'}),commitments=await query({model:model('shift','Commitment'),authority:'owner'});assert.equal(duties.length,success?1:0,mode);assert.equal(commitments.length,existing.length+(success?1:0)+(mode==='domain-race'?1:0),mode);
   if(success){const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay||replay.error.code==='validation',JSON.stringify(replay));assert.deepEqual(await query({model:model('shift','Duty'),authority:'owner'}),duties);assert.deepEqual(await query({model:model('shift','Commitment'),authority:'owner'}),commitments);}
  }
  // The original private cohort uses the same FIRST helpers under its
  // genuine retained child admission, rather than a public mutation entry.
  const reviewStart=original.indexOf('  scenario review_swap '),reviewEnd=original.indexOf('  scenario duty_notice ',reviewStart);
  assert.ok(text.includes(original.slice(reviewStart,reviewEnd)));
  const {createD1OwnerRouter}=await import('@canlang/state/storage/owner-router');
  const {createTeamOwnerStorageBoundary}=await import('../worker/assembly.js');
  const {createBoundCohortTick}=await import('./cohort-tick.js');
  const modes=['empty','previous-away','nearest-same','false-prefix','domain-race','inactive-substitute','membership-grant-race','membership-revoke-race','changed-source'];
  const runtime=new Miniflare({modules:true,compatibilityDate:'2026-07-15',script:'export default {fetch(){return new Response("Shift review")}}',
   d1Databases:Object.fromEntries(modes.map((_,index)=>['MODE'+index,'shift-review-'+index]))});
  try{for(const [index,mode]of modes.entries()){
   const {now,identities,identity,team,user}=await member('shift-review-'+mode,['shift.scheduler']);
   const substitute=await identities.createUser({email:'review-substitute-'+mode+'@shift.test',password_hash:'unused',email_verified:true});
   const substituteMembership=await identities.createMembership({team_id:team.team_id,user_id:substitute.user_id,is_owner:false,roles:[]});
   if(mode==='inactive-substitute'||mode==='membership-grant-race')await identities.removeMembership(substituteMembership.membership_id);
   const scope={app:'CanShift',owner:team.team_id,ownerPackage:'shift'},authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'review-state-'+index,fileStoreId:'review-files-'+index,receiver:{app:scope.app,owner:scope.owner,team:scope.owner}};
   const db=await runtime.getD1Database('MODE'+index)as unknown as D1Database;
   const router=createD1OwnerRouter({resolveBinding:selected=>selected.app===scope.app&&selected.owner===scope.owner?{app:scope.app,owner:scope.owner,db,initializeFresh:true as const,fileRetirementAuthority:authority,fileReferenceProducers:[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]}:null});
   const ownerStorage=await createTeamOwnerStorageBoundary({artifact,asm,app:scope.app,identities,router});
   const {store}=await ownerStorage.forTrustedScope(scope,now);
   await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(scope.owner));}});
   const roster={model:model('shift','Roster'),id:asId('roster')},at=(time:string)=>'2099-01-01T'+time+':00.000Z';
   const row=(id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({...makeRow({id:asId(id),data}),parent});
   const employee={home:{id:'location'},locations:[{id:'away'}],operator_wide:false,active:true,skills:['reception'],role:'Reception',visible:true,user_visible:true};
   const commitment=(id:string,employeeId:string,from:string,until:string,location='location')=>row(id,{employee:{id:employeeId},location:{id:location},from:at(from),until:at(until),before:'0',after:'0',skill:'reception',kind:'duty',source:id,previous:null,revision:'1',active:true,conflict:false,revision_visible:true},roster);
   const assigned=commitment('assigned','employee','17:30','18:00'),duty=row('duty',{role:'Reception',published:true,published_revision:'1',published_by:null,override_reason:null},{model:model('shift','Commitment'),id:assigned.id});
   const swap=row('swap',{original:{id:'employee'},substitute:{id:'substitute'},revision:'1',state:mode==='false-prefix'?'accepted':'open'},{model:model('shift','Duty'),id:duty.id});
   const previous:StoredRow[]=mode==='previous-away'||mode==='domain-race'?[commitment('prior','substitute','14:00','16:00','away')]:mode==='nearest-same'?[commitment('far','substitute','09:00','12:00','away'),commitment('near','substitute','14:00','16:00')]:[];
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    {kind:'insert',model:model('rent_catalog','Location'),row:row('location',{active:true})},{kind:'insert',model:model('rent_catalog','Location'),row:row('away',{active:true})},
    {kind:'insert',model:model('employee','Employee'),row:row('employee',{...employee,user:{id:user.user_id}})},{kind:'insert',model:model('employee','Employee'),row:row('substitute',{...employee,user:{id:substitute.user_id}})},
    {kind:'insert',model:model('shift','Roster'),row:row('roster',{name:'Review roster'})},
    ...['employee','substitute'].map(employeeId=>({kind:'insert'as const,model:model('shift','Availability'),row:row('hours-'+employeeId,{employee:{id:employeeId},from:at('08:00'),until:at('23:00'),available:true},roster)})),
    {kind:'insert',model:model('shift','Commitment'),row:assigned},{kind:'insert',model:model('shift','Duty'),row:duty},{kind:'insert',model:model('shift','Swap'),row:swap},
    ...previous.map(row=>({kind:'insert'as const,model:model('shift','Commitment'),row}))]}));
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
   const direct=await invoker.invokeMutation({operation:'shift.review_swap',operation_id:operationId(now),inputs:{}},identity);assert.ok('error'in direct,'private cohort has no public mutation entry');
   assert.deepEqual(await store.load(model('shift','Swap'),swap.id),swap);
   const queued=await invoker.invokeMutation({operation:'shift.queue_review',operation_id:operationId(now),inputs:{}},identity);assert.ok('result'in queued,JSON.stringify(queued));
   const sources=await store.query({model:asModel('work.occurrence'),authority:'owner'});assert.equal(sources.length,1);assert.equal((sources[0]!.data.result as {event:string}).event,'shift.EligibilityReview');
   const physicalCommit=store.commit.bind(store);let raced=false;
   const findMembership=identities.findMembership.bind(identities);
   identities.findMembership=async(teamId,userId)=>{const fact=await findMembership(teamId,userId);if(['membership-grant-race','membership-revoke-race'].includes(mode)&&!raced&&userId===substitute.user_id){raced=true;if(mode==='membership-grant-race')await identities.reactivateMembership(substituteMembership.membership_id,{is_owner:false,roles:[]});else await identities.removeMembership(substituteMembership.membership_id);}return fact;};
   store.commit=async batch=>{
    if(mode==='domain-race'&&!raced&&batch.writes.some(write=>write.model==='shift.Swap')){raced=true;await physicalCommit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:model('shift','Commitment'),row:commitment('raced','substitute','16:00','17:00')}]}));}
    return physicalCommit(batch);
   };
   if(mode==='changed-source'){
    const sourceRow=sources[0]!,revision=await store.readRevision(),history=await store.historyFor(model('shift','Swap'),swap.id),outbox=await store.outboxPending();
    await assert.rejects(physicalCommit(makeBatch(revision,{writes:[{kind:'update',model:asModel('work.occurrence'),id:sourceRow.id,expectedVersion:sourceRow.version,row:{...sourceRow,version:asVersion(sourceRow.version+1),data:{...sourceRow.data,result:{...(sourceRow.data.result as object),event:'shift.Other'}}}}]})),{kind:'reference',message:/actual owning synchronous opaque resolver refused/});
    assert.equal(await store.readRevision(),revision,'forged retained event cannot enter its owning opaque source census');
    assert.deepEqual(await store.load(asModel('work.occurrence'),sourceRow.id),sourceRow);assert.deepEqual(await store.load(model('shift','Swap'),swap.id),swap);
    assert.deepEqual(await store.historyFor(model('shift','Swap'),swap.id),history);assert.deepEqual(await store.outboxPending(),outbox);
   }
   const tick=await createBoundCohortTick({artifact,asm,identities,ownerStorage,scope,now:()=>now});
   let failure:unknown;for(let turn=0;turn<3;turn++){try{await tick.tick();const children=await store.query({model:asModel('work.fanout_child'),authority:'owner'});if(children.length>0&&children.every(row=>['completed','failed','skipped'].includes(String(row.data.state))))break;}catch(error){failure=error;break;}}
   if(failure!==undefined)throw failure;
   const children=await store.query({model:asModel('work.fanout_child'),authority:'owner'});
   assert.ok(children.length>0,mode+': genuine retained cohort child required');
   assert.ok(children.every(row=>row.data.state===(mode==='membership-revoke-race'?'failed':'completed')),mode+': '+JSON.stringify(children.map(row=>row.data)));
   if(mode==='membership-revoke-race')assert.ok(children.every(row=>row.data.causeReason==='inaccessible-record'),'revoked positive membership cannot acknowledge a no-effect child');
   if(mode==='membership-grant-race')assert.ok(children.every(row=>row.data.attempts===1),'a changed negative CONTROL fact recomputes and completes without permanently refusing its child');
   const current=await store.load(model('shift','Swap'),swap.id);assert.ok(current);assert.equal(current.data.state,['previous-away','inactive-substitute'].includes(mode)?'obsolete':swap.data.state,mode);
   if(['previous-away','inactive-substitute'].includes(mode)){assert.equal(current.version,2,mode);assert.deepEqual(current.data,{...swap.data,state:'obsolete'});}else assert.deepEqual(current,swap,mode+': no stale or compensating Swap write may commit');
   if(mode==='domain-race'||mode.startsWith('membership-'))assert.equal(raced,true,'the genuine private child reaches its current domain/Identity fence');
   const history=await store.historyFor(model('shift','Swap'),swap.id),outbox=await store.outboxPending();await tick.tick();
   assert.deepEqual(await store.load(model('shift','Swap'),swap.id),current,'terminal cohort replay performs no new business writes');
   assert.deepEqual(await store.historyFor(model('shift','Swap'),swap.id),history);assert.deepEqual(await store.outboxPending(),outbox);
  }}finally{await runtime.dispose();}
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('clears the original optional Event candidate before scheduling both cancellation workflows atomically', {timeout:180000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-event-null-reference-'));
 try{
  const source=join(root,'compiler/tests/fixtures/event-cancel-original-source.can'),original=await readFile(join(root,'draft/apps/CanEvent/CanEvent.can'),'utf8'),text=await readFile(source,'utf8');
  const start=original.indexOf('  scenario cancel_event('),end=original.indexOf('   examples seed=[test_worker,free_ticket] event=workshop reason="Event cancelled"',start);assert.ok(text.includes(original.slice(start,end)));
  const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const artifact=JSON.parse(stdout)as CompileArtifact,asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  for(const mode of ['allowed','already-cancelled','denied-revision','identity-race','root-race','stale','missing-inventory']){
   const {now,identities,identity,team,user,membership}=await member('event-null-'+mode,['events.organizer']);
   const scope={app:'EventCancel',owner:team.team_id,ownerPackage:'events'},authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'event-state',fileStoreId:'event-files',receiver:{app:scope.app,owner:scope.owner,team:scope.owner}};
   const {store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
   if(mode!=='missing-inventory')await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(scope.owner));}});
   const eventModel=asModel('events.Event'),eventId=asId('event');
   const row=(model:string,id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({kind:'insert'as const,model:asModel(model),row:{...makeRow({id:asId(id),data}),parent}});
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    row('rent_catalog.Location','site',{name:'Site',currency:'EUR'}),row('employee.Employee','worker',{user:{id:user.user_id},active:true,operator_wide:false,home:{id:'site'},locations:[]}),
    row('events.Program','program',{name:'Program'}),row('events.Event','event',{location:{id:'site'},revision:'1',cancelled:mode==='already-cancelled',cancellation_reason:null,pending_change:{id:'candidate'},revision_readable:mode!=='denied-revision'},{model:asModel('events.Program'),id:asId('program')}),
    row('events.Change','candidate',{state:'holding'},{model:eventModel,id:eventId})
   ]}));
   const load=store.load.bind(store),commit=store.commit.bind(store);let raced=false;
   store.load=async(model,id)=>{if(mode==='identity-race'&&!raced&&model==='work.schedule'){raced=true;await identities.removeMembership(membership.membership_id);}return load(model,id);};
   store.commit=async batch=>{if(mode==='root-race'&&!raced&&batch.writes.some(write=>write.model==='work.schedule')){raced=true;const current=await load(eventModel,eventId);assert.ok(current);await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:eventModel,id:eventId,expectedVersion:current.version,row:{...current,version:asVersion(current.version+1),archivedAt:now}}]}));}return commit(batch);};
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now}),request={operation:'events.cancel_event',operation_id:operationId(now),inputs:{event:{id:'event',version:mode==='stale'?'2':'1'},reason:'Event cancelled'}};
   const outcome=await invoker.invokeMutation(request,identity),success=mode==='allowed'||mode==='missing-inventory';assert.equal('result'in outcome&&outcome.result.status==='committed',success,mode+': '+JSON.stringify(outcome));
   const saved=await load(eventModel,eventId),schedules=await store.query({model:asModel('work.schedule'),authority:'owner'});assert.ok(saved);assert.equal(schedules.length,success?2:0,mode);
   assert.equal(saved.data.pending_change===null,success,mode);assert.equal(saved.data.revision,success?'2':'1',mode);assert.equal(saved.data.cancelled,success||mode==='already-cancelled',mode);
   if(mode.endsWith('-race'))assert.equal(raced,true,mode);
   if(success){for(const schedule of schedules){const payload=schedule.data.payload as {event:unknown;revision:unknown;reason:unknown};assert.deepEqual(payload.event,{id:'event',version:String(saved.version)});assert.equal(payload.revision,'2');assert.equal(payload.reason,'Event cancelled');}
    assert.deepEqual(new Set(schedules.map(schedule=>schedule.data.key)),new Set(['event:venues','event:attendees']));
    const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay&&replay.result.status==='replayed');assert.deepEqual(await store.query({model:asModel('work.schedule'),authority:'owner'}),schedules);
   }
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('sends original Propose offers through independently authorized parent identities', {timeout:180000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-propose-parent-id-'));
 try{
  const source=join(root,'compiler/tests/fixtures/propose-handoff-original.can'),original=await readFile(join(root,'draft/apps/CanPropose/CanPropose.can'),'utf8'),text=await readFile(source,'utf8');
  for(const head of ['  scenario hold_inventory(','  export scenario request_booking(']){const start=original.indexOf(head),end=original.indexOf('   examples',start);assert.ok(text.includes(original.slice(start,end)));}
  const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const artifact=JSON.parse(stdout) as CompileArtifact,asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  for(const operation of ['hold_inventory','request_booking'])for(const mode of ['allowed','denied-customer','denied-location','denied-ref','false-prefix','link-race','grant-race','identity-race']){
   const {now,identities,identity,team,user,membership}=await member('propose-parent-'+operation+'-'+mode,['propose.salesperson']);
   const scope={app:'CanPropose',owner:team.team_id,ownerPackage:'propose'},authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'parent-state',fileStoreId:'parent-files',receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
   const {store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
   const row=(id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({...makeRow({id:asId(id),data}),parent}),money={minor:'1000',currency:'EUR'},zero={minor:'0',currency:'EUR'},intervals=[{from:'2099-01-01T09:00:00.000Z',until:'2099-01-01T10:00:00.000Z'}];
   const proposal=row('proposal',{location:{id:'location'},recipient:{id:'contact'},issuer:'Issuer',title:'Offer',currency:'EUR',valid_days:'14',current:'1',link_visible:mode!=='denied-ref'},{model:model('customer','Customer'),id:asId('customer')});
   const revision=row('revision',{product:null,attribution:null,exclusive_program:null,attributed_at:null,attribution_window:null,number:'1',issuer_snapshot:'Issuer',title_snapshot:'Offer',location_snapshot:'Frozen location',customer_snapshot:'Frozen customer',alternative_to:null,recipient_email:user.email,account:{id:user.user_id},expires:'2099-01-01T08:00:00.000Z',terms:'Terms',refund_before:intervals[0]!.from,resource:'office',from:intervals[0]!.from,until:intervals[0]!.until,intervals,seats:'4',quantity:'2',held_until:null,total:money,state:mode==='false-prefix'?'withdrawn':operation==='hold_inventory'?'sent':'accepted',decided_by:{id:user.user_id},decided_at:'2026-01-01T08:00:00.000Z',handoff:'none',delivery:null,booking:null,invoice:null,hold_state:'none',booking_version:'0',hold_version:'0',hold_delivery:null,hold_release:null,notice:null,document_state:'none',document:null,pdf:null},{model:model('propose','Proposal'),id:proposal.id});
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    {kind:'insert',model:model('rent_catalog','Location'),row:row('location',{active:true,visible:mode!=='denied-location'})},
    {kind:'insert',model:model('rent_catalog','Location'),row:row('replacement',{active:true,visible:true})},
    {kind:'insert',model:model('employee','Employee'),row:row('employee',{user:{id:user.user_id},home:{id:'location'},locations:[{id:'replacement'}],operator_wide:false,active:true,hidden:false})},
    {kind:'insert',model:model('customer','Customer'),row:row('customer',{active:true,visible:mode!=='denied-customer'})},
    {kind:'insert',model:model('customer','Contact'),row:row('contact',{account:{id:user.user_id}},{model:model('customer','Customer'),id:asId('customer')})},
    {kind:'insert',model:model('propose','Proposal'),row:proposal},{kind:'insert',model:model('propose','Revision'),row:revision},
    {kind:'insert',model:model('propose','Item'),row:row('item',{title:'Line',quantity:'2',unit:'hour',price:money,tax:zero,discount:zero,hidden:false,tax_visible:true},{model:model('propose','Revision'),id:revision.id})}]}));
   const load=store.load.bind(store),commit=store.commit.bind(store);let raced=false;
   store.load=async(name,id)=>{if(!raced&&mode==='identity-race'&&name==='work.dispatch'){raced=true;await identities.removeMembership(membership.membership_id);}return load(name,id);};
   store.commit=async batch=>{if(!raced&&['link-race','grant-race'].includes(mode)&&batch.writes.some(write=>write.model==='work.dispatch')){raced=true;const name=mode==='link-race'?model('propose','Proposal'):model('rent_catalog','Location'),old=await load(name,mode==='link-race'?proposal.id:asId('location'));assert.ok(old);await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:name,id:old.id,expectedVersion:old.version,row:{...old,version:asVersion(old.version+1),data:{...old.data,...(mode==='link-race'?{location:{id:'replacement'}}:{visible:false})}}}]}));}return commit(batch);};
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now}),request={operation:'propose.'+operation,operation_id:operationId(now),inputs:{revision:{id:'revision',version:'1'},...(operation==='hold_inventory'?{until:'2098-12-31T00:00:00.000Z'}:{})}};
   const result=await invoker.invokeMutation(request,identity),success=['allowed','link-race'].includes(mode);assert.equal('result'in result,success,operation+'/'+mode+': '+JSON.stringify(result));if(mode.endsWith('-race'))assert.ok(raced,mode);
   const pending=await store.outboxPending(),current=await load(model('propose','Revision'),revision.id);assert.equal(pending.length,success?1:0,mode);assert.ok(current);
   if(success){const args=(pending[0]!.arguments as {arguments:{value:Record<string,unknown>}}).arguments.value;assert.equal(args.customer,'customer');assert.equal(args.location,mode==='link-race'?'replacement':'location');assert.equal(args.source,'revision');assert.equal((args.snapshot as {lines:unknown[]}).lines.length,1);assert.equal(current.data[operation==='hold_inventory'?'hold_state':'handoff'],'pending');assert.ok('result'in await invoker.invokeMutation(request,identity));assert.deepEqual(await store.outboxPending(),pending);}
   else assert.deepEqual(current,revision,mode+': no partial SEND or revision SET');
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('emits both original membership recheck events with required identities in optional slots', {timeout:180000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-member-recheck-'));
 try{
  const source=join(root,'compiler/tests/fixtures/member-recheck-original-source.can'),original=await readFile(join(root,'draft/apps/CanMember/CanMember.can'),'utf8'),text=await readFile(source,'utf8');
  const start=original.indexOf('  export scenario recheck_access('),end=original.indexOf('   examples',start);assert.ok(text.includes(original.slice(start,end)));
  const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const artifact=JSON.parse(stdout)as CompileArtifact,asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  for(const mode of ['manager','administrator','unauthorized','inactive','stale','identity-race','source-race']){
   const admin=mode==='administrator'||mode==='source-race',roles=admin||mode==='unauthorized'?[]:['member_terms.member_manager'];
   const {now,identities,identity,user,membership}=await member('member-recheck-'+mode,roles),{store}=createTestMemoryStorage();
   const customerModel=asModel('customer.Customer'),customerId=asId('customer');
   const row=(model:string,id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({kind:'insert'as const,model:asModel(model),row:{...makeRow({id:asId(id),data}),parent}});
   await store.commit(makeBatch(await store.readRevision(),{writes:[row('rent_catalog.Location','site',{name:'Site',currency:'EUR'}),row('employee.Employee','worker',{user:{id:user.user_id},active:mode!=='inactive',operator_wide:false,home:{id:'site'},locations:[]}),row('customer.Customer','customer',{active:true,locations:[{id:'site'}]}),...(admin?[row('customer.CompanyRole','administrator',{account:{id:user.user_id},active:true,role:'administrator',locations:[{id:'site'}]},{model:customerModel,id:customerId})]:[])]}));
   const query=store.query.bind(store),load=store.load.bind(store),commit=store.commit.bind(store);let raced=false;
   store.query=async spec=>{const rows=await query(spec);if(mode==='identity-race'&&!raced&&spec.model==='customer.CompanyRole'){raced=true;await identities.removeMembership(membership.membership_id);}return rows;};
   store.commit=async batch=>{if(mode==='source-race'&&!raced&&batch.writes.some(write=>write.model==='work.occurrence')){raced=true;const current=await load(customerModel,customerId);assert.ok(current);await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:customerModel,id:customerId,expectedVersion:current.version,row:{...current,version:asVersion(current.version+1),data:{...current.data,locations:[]}}}]}));}return commit(batch);};
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now}),request={operation:'member_terms.recheck_access',operation_id:operationId(now),inputs:{customer:{id:'customer',version:mode==='stale'?'2':'1'},location:{id:'site',version:'1'}}};
   const outcome=await invoker.invokeMutation(request,identity),success=mode==='manager'||mode==='administrator';assert.equal('result'in outcome&&outcome.result.status==='committed',success,mode+': '+JSON.stringify(outcome));
   const events=await query({model:asModel('work.occurrence'),authority:'owner'});assert.equal(events.length,success?2:0,mode);if(mode.endsWith('-race'))assert.equal(raced,true,mode);
   if(success){for(const event of events){const result=event.data.result as {event:string;payload:Record<string,unknown>};assert.ok(['member_terms.CompanyAccessStep','member_terms.WatchAccessStep'].includes(result.event));const payload=result.payload;assert.deepEqual(payload.customer,{id:'customer',version:'1'});assert.deepEqual(payload.location,{id:'site',version:'1'});assert.equal(payload.after,null);}
    const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay&&replay.result.status==='replayed');assert.deepEqual(await query({model:asModel('work.occurrence'),authority:'owner'}),events);
   }
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('runs original Event nullable resource release paths at their actual source stages', {timeout:180000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-event-resource-id-'));
 try{
  const source=join(root,'compiler/tests/fixtures/event-release-original-source.can'),original=await readFile(join(root,'draft/apps/CanEvent/CanEvent.can'),'utf8'),text=await readFile(source,'utf8');
  for(const [head,tail]of [['  scenario abandon(','   examples'],['  scenario retry_release(','  # Correlate']]){const start=original.indexOf(head!),end=original.indexOf(tail!,start);assert.ok(text.includes(original.slice(start,end)));}
  const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const artifact=JSON.parse(stdout) as CompileArtifact,asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  for(const operation of ['abandon','retry_release'])for(const mode of ['allowed','null','null-denied','denied-ref','denied-target','false-prefix','stale','ref-race','grant-race','identity-race']){
   const {now,identities,identity,team,user,membership}=await member('event-resource-'+operation+'-'+mode,['events.organizer']);
   const scope={app:'CanEvent',owner:team.team_id,ownerPackage:'events'},authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'release-state',fileStoreId:'release-files',receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
   const {store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
   const row=(id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({...makeRow({id:asId(id),data}),parent}),nullResource=mode.startsWith('null');
   const event=row('event',{location:{id:'location'},timezone:'UTC',from:'2099-01-01T09:00:00.000Z',until:'2099-01-01T10:00:00.000Z',capacity:'10',price:{minor:'1000',currency:'EUR'},sales_until:'2099-01-01T08:00:00.000Z',venue:null,pending_change:mode==='false-prefix'?null:{id:'change'},revision:'1',cancelled:false},{model:model('events','Program'),id:asId('program')});
   const change=row('change',{source:'original-held-source',base_revision:'1',location:{id:'location'},timezone:'UTC',from:'2099-01-01T09:00:00.000Z',until:'2099-01-01T10:00:00.000Z',capacity:'10',sales_until:'2099-01-01T08:00:00.000Z',reason:'Original proposal',author:{id:user.user_id},resource:nullResource?null:{id:'resource'},customer:null,account:{id:user.user_id},previous:null,state:operation==='abandon'?'holding':mode==='false-prefix'?'released':'releasing',venue_state:'pending',venue_revision:'0',hold_delivery:null,hold_status:null,release_reason:operation==='retry_release'?'Frozen release':null,release_delivery:null,release_status:operation==='retry_release'?'failed':null,resource_visible:!['denied-ref','null-denied'].includes(mode)},{model:model('events','Event'),id:event.id});
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    {kind:'insert',model:model('rent_catalog','Location'),row:row('location',{name:'Site',currency:'EUR'})},
    {kind:'insert',model:model('employee','Employee'),row:row('employee',{user:{id:user.user_id},active:true,operator_wide:false,home:{id:'location'},locations:[]})},
    {kind:'insert',model:model('rent_reservations','Resource'),row:row('resource',{active:true,location:{id:'location'},party_limit:'20',visible:mode!=='denied-target'})},
    {kind:'insert',model:model('rent_reservations','Resource'),row:row('replacement',{active:true,location:{id:'location'},party_limit:'20',visible:true})},
    {kind:'insert',model:model('events','Program'),row:row('program',{name:'Original program'})},
    {kind:'insert',model:model('events','Event'),row:event},{kind:'insert',model:model('events','Change'),row:change}]}));
   const load=store.load.bind(store),commit=store.commit.bind(store);let raced=false;
   store.load=async(name,id)=>{if(!raced&&mode==='identity-race'&&name==='work.dispatch'){raced=true;await identities.removeMembership(membership.membership_id);}return load(name,id);};
   store.commit=async batch=>{if(!raced&&['ref-race','grant-race'].includes(mode)&&batch.writes.some(write=>write.model==='work.dispatch')){raced=true;const name=mode==='ref-race'?model('events','Change'):model('rent_reservations','Resource'),old=await load(name,mode==='ref-race'?change.id:asId('resource'));assert.ok(old);await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:name,id:old.id,expectedVersion:old.version,row:{...old,version:asVersion(old.version+1),data:{...old.data,...(mode==='ref-race'?{resource:{id:'replacement'}}:{visible:false})}}}]}));}return commit(batch);};
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now}),request={operation:'events.'+operation,operation_id:operationId(now),inputs:{change:{id:'change',version:mode==='stale'?'2':'1'},...(operation==='abandon'?{reason:'Keep original'}:{})}};
   const result=await invoker.invokeMutation(request,identity),success=mode==='allowed'||operation==='abandon'&&nullResource;assert.equal('result'in result,success,operation+'/'+mode+': '+JSON.stringify(result));if(mode.endsWith('-race'))assert.ok(raced,mode);
   const pending=await store.outboxPending(),current=await load(model('events','Change'),change.id),parent=await load(model('events','Event'),event.id);assert.equal(pending.length,success&&!nullResource?1:0,mode);assert.ok(current);assert.ok(parent);
   if(success){assert.equal(current.data.state,nullResource?'released':'releasing');assert.deepEqual(parent.data.pending_change,operation==='abandon'?null:{id:'change'});if(!nullResource){assert.deepEqual((pending[0]!.arguments as {arguments:unknown}).arguments,{source:'original-held-source',resource:'resource',reason:operation==='abandon'?'Keep original':'Frozen release'});assert.equal(current.data.release_status,'pending');}assert.ok('result'in await invoker.invokeMutation(request,identity));assert.deepEqual(await store.outboxPending(),pending);}
   else{assert.deepEqual(parent,event,mode+': parent SET rolls back');if(mode==='ref-race'){assert.equal(current.data.state,change.data.state);assert.deepEqual(current.data.resource,{id:'replacement'});}else assert.deepEqual(current,change,mode+': no partial Change SET');}
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('executes only the original prepare branch with its own reached COUNT and helper DATA', {timeout:240000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-prepare-branch-count-'));
 try{
  const source=join(root,'compiler/tests/fixtures/rent-prepare-branch-count.can'),original=await readFile(join(root,'draft/apps/CanRent/CanRent.can'),'utf8'),text=await readFile(source,'utf8');
  const start=original.indexOf('  export scenario prepare('),end=original.indexOf('\n  # Admit a fulfilled',start);
  assert.ok(text.includes(original.slice(start,end).trimEnd()),'complete original prepare body remains authored');
  for(const helper of ['benefit_request','charge_request','resource_evidence','report_booking'])assert.ok(text.includes(original.split('\n').find(line=>line.startsWith('  derive '+helper+'('))!),'original '+helper+' remains authored');
  const{stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const artifact=JSON.parse(stdout)as CompileArtifact,asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  for(const mode of ['billing','membership','pending','inactive-data-denied','billing-data-denied','identity-race','location-race','count-insert-race']){
   const{now,identities,identity,user,team,membership}=await member('rent-prepare-'+mode,['rent_reservations.reception','rent_reservations.billing','rent_reservations.reservation_manager']);
   const scope={app:'ConstructorCount',owner:team.team_id,ownerPackage:'rent_reservations'},authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'rent-state',fileStoreId:'rent-files',receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
   const{store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
   await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
   const resource={model:asModel('rent_reservations.Resource'),id:asId('resource')},row=(model:string,id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({kind:'insert'as const,model:asModel(model),row:{...makeRow({id:asId(id),data}),parent}});
   const money={minor:'300',currency:'EUR'},zero={minor:'0',currency:'EUR'},from=new Date(now+3600000).toISOString(),until=new Date(now+7200000).toISOString(),value={active:true,capacity:'7',pooled:false,timezone:'UTC'};
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    row('rent_catalog.Location','site',{active:true,name:'Original location',name_visible:!mode.endsWith('data-denied')}),
    row('employee.Employee','worker',{user:{id:user.user_id},active:true,operator_wide:false,home:{id:'site'},locations:[]}),row('customer.Customer','customer',{active:true}),
    row('rent_reservations.Resource','resource',{location:{id:'site'},...value,readable:true,name:'Original resource',price_unit:'hour'}),
    row('rent_reservations.ResourcePolicy','existing',{effective:new Date(now).toISOString(),sequence:'1',baseline:false,value},resource),
    row('rent_reservations.Booking','booking',{from,until,intervals:[{from,until}],quantity:'1',status:'held',checked_in:null,checked_out:null,arrival_buffer:'0',departure_buffer:'0',source:'original',reserved_until:until,overdue:false,cancellation_reason:null,customer:{id:'customer'},account:{id:user.user_id},benefit_intervals:[{from,until}],benefit_unit:'hour',benefit_duration:'3600000',benefit_rate:null,rate:money,billing_delivery:null,allowance_delivery:null,allowance:mode==='pending'?'pending':'not_required',payment:'pending',total:money,subtotal:money,discount:zero,tax:zero,monetary_due:zero,expires:new Date(now+60000).toISOString(),terms:'Original terms'},resource)
   ]}));
   const load=store.load.bind(store),commit=store.commit.bind(store);let raced=false;
   store.load=async(model,id)=>{if(mode==='identity-race'&&model==='work.dispatch'&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}return load(model,id);};
   store.commit=async batch=>{if(!raced&&['location-race','count-insert-race'].includes(mode)&&batch.writes.some(write=>write.kind==='insert'&&write.model==='rent_reservations.BookingEvidence')){
    raced=true;if(mode==='location-race'){const old=await load(asModel('rent_catalog.Location'),asId('site'));assert.ok(old);await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:asModel('rent_catalog.Location'),id:old.id,expectedVersion:old.version,row:{...old,version:asVersion(old.version+1),data:{...old.data,name_visible:false}}}]}));}
    else await commit(makeBatch(await store.readRevision(),{writes:[row('rent_reservations.ResourcePolicy','concurrent',{effective:new Date(now).toISOString(),sequence:'2',baseline:false,value},resource)]}));
   }return commit(batch);};
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now}),request={operation:'rent_reservations.prepare',operation_id:operationId(now),inputs:{booking:{id:'booking',version:'1'},use_allowance:['membership','inactive-data-denied'].includes(mode)}};
   const result=await invoker.invokeMutation(request,identity),success=!['billing-data-denied','identity-race','location-race'].includes(mode);assert.equal('result'in result&&result.result.status==='committed',success,mode+': '+JSON.stringify(result));
   if(mode.endsWith('-race'))assert.ok(raced,mode);
   const policies=await store.query({model:asModel('rent_reservations.ResourcePolicy'),authority:'owner'}),evidence=await store.query({model:asModel('rent_reservations.BookingEvidence'),authority:'owner'}),pending=await store.outboxPending(),booking=await load(asModel('rent_reservations.Booking'),asId('booking'));assert.ok(booking);
   assert.equal(evidence.length,success?1:0,mode);assert.equal(policies.length,success?(mode==='count-insert-race'?3:2):1,mode);assert.equal(pending.length,success?1:0,mode);assert.equal(booking.data.status,success?'pending':'held',mode);
   if(success){const allowance=['membership','pending','inactive-data-denied'].includes(mode);assert.equal(pending[0]!.target,allowance?'member_terms.MembershipV1.reserve':'invoice.BillingV1.charge',mode);assert.equal(booking.data[allowance?'allowance_delivery':'billing_delivery'],pending[0]!.intentId);assert.equal(evidence[0]!.data.sequence,mode==='count-insert-race'?'3':'2');assert.equal(evidence[0]!.data.key,'booking');assert.equal((evidence[0]!.data.value as{status:string}).status,'pending');
    const payload=(pending[0]!.arguments as{arguments:{value:Record<string,unknown>}}).arguments.value;assert.equal(payload.source,'original');assert.equal(payload.location,'site');if(!allowance)assert.equal((payload.items as{location:string}[])[0]!.location,'Original location');
    const saved=await store.readReceipt({app:scope.app,owner:scope.owner,principal:user.user_id,operation:request.operation,operationId:request.operation_id}as Parameters<typeof store.readReceipt>[0]);assert.ok(saved);assert.ok(saved.outcome.status==='committed');
    const association=saved.outcome.scenario;assert.ok(association);assert.equal(association.queries?.length,1,'inactive branch COUNT must not be executed or saved');
    const reached=association.plan.returns.find(returned=>returned.id===association.returnId);assert.ok(reached);assert.equal(reached.influences.length,4);assert.ok(reached.influences.every(influence=>influence.queryId===association.queries![0]!.queryId));
    const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay&&replay.result.status==='replayed',mode);assert.deepEqual(await store.outboxPending(),pending);assert.deepEqual(await store.query({model:asModel('rent_reservations.BookingEvidence'),authority:'owner'}),evidence);
   }
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('recovers the original Shift commitment through its exact descendant Swap loop', {timeout:240000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-shift-recover-'));
 try{
  const source=join(root,'compiler/tests/fixtures/shift-recover-original.can'),authored=await readFile(join(root,'draft/apps/CanShift/CanShift.can'),'utf8'),text=await readFile(source,'utf8');
  const start=authored.indexOf('  scenario recover_commitment('),end=authored.indexOf('   examples',start);assert.ok(text.includes(authored.slice(start,end)));
  const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const artifact=JSON.parse(stdout)as CompileArtifact,asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  for(const mode of (process.env['CAN_SHIFT_RECOVER_CASE']??'valid,invalid-skill,swap-revision,empty,stale,role-race,insert-race,overflow,physical-cap,withheld-revision').split(',')){
   const{now,identities,identity,team,user,membership}=await member('shift-recover-'+mode,['shift.scheduler']);
   const staff=await identities.createUser({email:'original-'+mode+'@shift.test',password_hash:'unused',email_verified:true}),sub=await identities.createUser({email:'sub-'+mode+'@shift.test',password_hash:'unused',email_verified:true});
   for(const person of [staff,sub])await identities.createMembership({team_id:team.team_id,user_id:person.user_id,is_owner:false,roles:[]});
   const scope={app:'CanShift',owner:team.team_id,ownerPackage:'shift'},authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'shift-state',fileStoreId:'shift-files',receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
   const{store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
   await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
   const at=(time:string)=>'2099-01-01T'+time+':00.000Z',roster={model:model('shift','Roster'),id:asId('roster')},commitment={model:model('shift','Commitment'),id:asId('commitment')},duty={model:model('shift','Duty'),id:asId('duty')};
   const insert=(name:string,id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({kind:'insert'as const,model:asModel(name),row:{...makeRow({id:asId(id),data}),parent}});
   const booking=(id:string)=>insert('shift.Commitment',id,{employee:{id:'original'},location:{id:'location'},from:at('17:30'),until:at('18:00'),before:'0',after:'0',skill:'reception',kind:'duty',source:id,previous:null,revision:'1',active:true,revision_visible:mode!=='withheld-revision',conflict:false},roster);
   const swap=(id:string,owner=duty,state='open')=>insert('shift.Swap',id,{original:{id:'original'},substitute:{id:'substitute'},revision:['swap-revision','insert-race'].includes(mode)?'2':'1',state},owner);
   const count=mode==='empty'?0:mode==='overflow'?101:mode==='physical-cap'?400:2;
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    insert('rent_catalog.Location','location',{active:true}),insert('shift.Roster','roster',{name:'Original roster'}),
    ...[ ['operator',user],['original',staff],['substitute',sub] ].map(([id,person])=>insert('employee.Employee',id as string,{user:{id:(person as typeof user).user_id},home:{id:'location'},locations:[],operator_wide:false,active:true,skills:['invalid-skill','withheld-revision'].includes(mode)&&id==='original'?[]:['reception'],role:'Reception',visible:true,user_visible:true})),
    insert('shift.Availability','original-hours',{employee:{id:'original'},from:at('08:00'),until:at('23:00'),available:true},roster),
    insert('shift.Availability','sub-hours',{employee:{id:'substitute'},from:at('08:00'),until:at('23:00'),available:true},roster),
    booking('commitment'),booking('foreign'),insert('shift.Duty','duty',{role:'Reception',published:false,published_revision:'0',published_by:null,override_reason:null},commitment),
    insert('shift.Duty','foreign-duty',{role:'Reception',published:false,published_revision:'0',published_by:null,override_reason:null},{model:commitment.model,id:asId('foreign')}),
    ...Array.from({length:count},(_,index)=>swap('swap-'+String(index).padStart(3,'0'),duty,mode==='physical-cap'?'accepted':'open')),
    swap('foreign-swap',{model:duty.model,id:asId('foreign-duty')})
   ]}));
   const query=store.query.bind(store),commit=store.commit.bind(store);let raced=false;
   store.query=async input=>{const rows=await query(input);if(mode==='role-race'&&!raced&&input.model===model('shift','Swap')){raced=true;await identities.setMembershipRoles(membership.membership_id,[]);}return rows;};
   store.commit=async batch=>{if(mode==='insert-race'&&!raced&&batch.writes.some(write=>write.model===model('shift','Swap'))){raced=true;await commit(makeBatch(await store.readRevision(),{writes:[swap('raced')]}));}return commit(batch);};
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now}),request={operation:'shift.recover_commitment',operation_id:operationId(now),inputs:{commitment:{id:'commitment',version:mode==='stale'?'2':'1'}}};
   const result=await invoker.invokeMutation(request,identity);const success=!['stale','role-race','overflow','physical-cap','withheld-revision'].includes(mode);
   assert.equal('result'in result,success,mode+': '+JSON.stringify(result));
   const swaps=await query({model:model('shift','Swap'),authority:'owner'});assert.equal(swaps.find(row=>row.id==='foreign-swap')!.data.state,'open');
   assert.equal((await store.load(commitment.model,commitment.id))!.data.conflict,success&&mode==='invalid-skill');
   for(const row of swaps.filter(row=>row.parent?.id==='duty'))assert.equal(row.data.state,success&&['invalid-skill','swap-revision','insert-race'].includes(mode)?'obsolete':mode==='physical-cap'?'accepted':'open',mode);
   if(success){const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay&&replay.result.status==='replayed',mode+': '+JSON.stringify(replay));assert.deepEqual(await query({model:model('shift','Swap'),authority:'owner'}),swaps);}
   if(mode.endsWith('-race'))assert.equal(raced,true,mode);
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('records the complete original CRM win from one genuine nullable booking or term input', {timeout:240000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-crm-win-nullable-'));
 try{
  const source=join(root,'compiler/tests/fixtures/crm-win-nullable-source.can'),original=await readFile(join(root,'draft/apps/CanCRM/CanCRM.can'),'utf8'),text=await readFile(source,'utf8');
  const start=original.indexOf('  scenario win('),end=original.indexOf('   examples ',start);assert.ok(text.includes(original.slice(start,end)),'the full original XOR, source evidence, duplicate veto and both effect tails remain authored');
  const{stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const artifact=JSON.parse(stdout)as CompileArtifact,asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  for(const mode of ['booking','term','omitted-term','omitted-booking','both-null','both-omitted','both-present','foreign-model','no-version','stale-version','unpaid','hidden-booking','hidden-duplicate','duplicate-race','identity-race','source-race']){
   const{now,identities,identity,user,team,membership}=await member('crm-win-'+mode,['crm.salesperson']);
   const scope={app:'CanCRM',owner:team.team_id,ownerPackage:'crm'},authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'crm-state',fileStoreId:'crm-files',receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
   const{store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
   await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
   const row=(model:string,id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({kind:'insert'as const,model:asModel(model),row:{...makeRow({id:asId(id),data}),parent}});
   const deal={customer:{id:'customer'},contact:{id:'contact'},title:'Original deal',location:{id:'site'},owner:{id:user.user_id},value:{minor:'300',currency:'EUR'},stage:'proposal',seats:'1',desired_start:null,duration:null,workspace:null,source:null,next_action:new Date(now+60000).toISOString(),notes:null,lost_reason:null,outcome_reference:null};
   const prior={deal:{id:'foreign-deal'},booking:{id:'booking'},term:null,recorded_by:{id:user.user_id},recorded_at:new Date(now).toISOString()};
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    row('rent_catalog.Location','site',{active:true,currency:'EUR'}),row('rent_catalog.Location','other-site',{active:true,currency:'EUR'}),row('customer.Customer','customer',{active:true}),row('customer.Contact','contact',{name:'Contact'},{model:asModel('customer.Customer'),id:asId('customer')}),
    row('employee.Employee','worker',{user:{id:user.user_id},active:true,operator_wide:false,home:{id:'site'},locations:[]}),
    row('rent_reservations.Resource','resource',{location:{id:'site'}}),row('rent_reservations.Booking','booking',{customer:{id:'customer'},status:'confirmed',readable:mode!=='hidden-booking'},{model:asModel('rent_reservations.Resource'),id:asId('resource')}),
    row('member_terms.Membership','membership',{active:true},{model:asModel('customer.Customer'),id:asId('customer')}),row('member_terms.Term','term',{locations:[{id:'site'}],paid:mode!=='unpaid',readable:true},{model:asModel('member_terms.Membership'),id:asId('membership')}),
    row('crm.Deal','deal',deal),row('crm.Deal','foreign-deal',{...deal,location:{id:'other-site'}}),...(mode==='hidden-duplicate'?[row('crm.Sale','prior',prior)]:[])
   ]}));
   const load=store.load.bind(store),commit=store.commit.bind(store),query=store.query.bind(store);let raced=false;
   store.query=async spec=>{const rows=await query(spec);if(mode==='identity-race'&&spec.model==='crm.Sale'&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}return rows;};
   store.commit=async batch=>{if(!raced&&['duplicate-race','source-race'].includes(mode)&&batch.writes.some(write=>write.kind==='insert'&&write.model==='crm.Sale')){raced=true;if(mode==='duplicate-race')await commit(makeBatch(await store.readRevision(),{writes:[row('crm.Sale','concurrent',prior)]}));else{const old=await load(asModel('rent_reservations.Booking'),asId('booking'));assert.ok(old);await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:asModel('rent_reservations.Booking'),id:old.id,expectedVersion:old.version,row:{...old,version:asVersion(old.version+1),data:{...old.data,status:'pending'}}}]}));}}return commit(batch);};
   const termBranch=['term','omitted-booking','unpaid'].includes(mode),inputs:Record<string,unknown>={deal:{id:'deal',version:'1'},booking:termBranch?null:{id:'booking',version:mode==='stale-version'?'2':'1'},term:termBranch?{id:'term',version:'1'}:null};
   if(mode==='omitted-booking')delete inputs.booking;if(mode==='omitted-term')delete inputs.term;if(mode==='both-null')inputs.booking=null;if(mode==='both-omitted'){delete inputs.booking;delete inputs.term;}if(mode==='foreign-model')inputs.booking={id:'term',version:'1'};if(mode==='both-present')inputs.term={id:'term',version:'1'};if(mode==='no-version')inputs.booking={id:'booking'};
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now}),request={operation:'crm.win',operation_id:operationId(now),inputs};
   const result=await invoker.invokeMutation(request,identity),success=['booking','term','omitted-term','omitted-booking'].includes(mode);assert.equal('result'in result&&result.result.status==='committed',success,mode+': '+JSON.stringify(result));if(mode.endsWith('-race'))assert.ok(raced,mode);
   const sales=await query({model:asModel('crm.Sale'),authority:'owner'}),activities=await query({model:asModel('crm.Activity'),authority:'owner'}),updated=await load(asModel('crm.Deal'),asId('deal'));assert.ok(updated);assert.equal(updated.data.stage,success?'won':'proposal',mode);assert.equal(activities.length,success?1:0,mode);assert.equal(sales.length,success?1:['hidden-duplicate','duplicate-race'].includes(mode)?1:0,mode);
   if(success){assert.deepEqual(sales[0]!.data.deal,{id:'deal'});assert.deepEqual(sales[0]!.data[termBranch?'term':'booking'],{id:termBranch?'term':'booking'});assert.equal(sales[0]!.data[termBranch?'booking':'term'],null);assert.equal(activities[0]!.data.kind,'sale');assert.equal(activities[0]!.data.body,termBranch?'term':'booking');assert.equal(updated.data.outcome_reference,termBranch?'term':'booking');assert.equal(updated.data.next_action,null);assert.deepEqual(activities[0]!.data.author,{id:user.user_id});assert.deepEqual(sales[0]!.data.recorded_by,{id:user.user_id});
    const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay&&replay.result.status==='replayed',mode);assert.deepEqual(await query({model:asModel('crm.Sale'),authority:'owner'}),sales);assert.deepEqual(await query({model:asModel('crm.Activity'),authority:'owner'}),activities);
    if(mode==='booking'){
     const claim=(booking:unknown,term:unknown)=>invoker.invokeMutation({operation:'crm.claim_sale',operation_id:operationId(now),inputs:{deal:{id:'deal',version:'2'},booking,term}},identity);
     const duplicate=await claim({id:'booking',version:'1'},null);assert.ok('error'in duplicate,'owning unique constraint refuses without a duplicate source guard');assert.deepEqual(await query({model:asModel('crm.Sale'),authority:'owner'}),sales);
     const independent=await claim(null,{id:'term',version:'1'});assert.ok('result'in independent&&independent.result.status==='committed',JSON.stringify(independent));
     const after=await query({model:asModel('crm.Sale'),authority:'owner'});assert.equal(after.length,2,'distinct nonnull keys can coexist with repeated null slots');
     const second=await claim(null,{id:'term',version:'1'});assert.ok('error'in second,'the Term key also retains uniqueness');assert.deepEqual(await query({model:asModel('crm.Sale'),authority:'owner'}),after);
    }

   }
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('emits the complete original Shift decline with native parent identity and granted path scalars', {timeout:180000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-shift-decline-path-'));
 try{
  const source=join(root,'compiler/tests/fixtures/shift-decline-original.can'),original=await readFile(join(root,'draft/apps/CanShift/CanShift.can'),'utf8'),text=await readFile(source,'utf8');
  const start=original.indexOf('  scenario decline('),end=original.indexOf('   examples',start);assert.ok(text.includes(original.slice(start,end)));
  const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const artifact=JSON.parse(stdout) as CompileArtifact,asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  for(const mode of ['allowed','member-only','denied-ref','denied-user','denied-revision','denied-duty','false-prefix','stale','ref-race','revision-race','grant-race','identity-race']){
   const {now,identities,identity,team,user,membership}=await member('shift-decline-'+mode,mode==='member-only'?[]:['shift.scheduler']);
   const recipient=await identities.createUser({email:'original-'+mode+'@shift.test',password_hash:'unused',email_verified:true});
   const scope={app:'CanShift',owner:team.team_id,ownerPackage:'shift'},authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'decline-state',fileStoreId:'decline-files',receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
   const {store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
   const row=(id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({...makeRow({id:asId(id),data}),parent}),employee={home:{id:'location'},locations:[],operator_wide:false,active:true,skills:['reception'],role:'Reception',visible:true,user_visible:true};
   const commitment=row('commitment',{employee:{id:'original'},location:{id:'location'},from:'2099-01-01T09:00:00.000Z',until:'2099-01-01T17:00:00.000Z',before:'0',after:'0',skill:'reception',kind:'duty',source:'original-duty',previous:null,revision:'7',active:true,conflict:false,revision_visible:mode!=='denied-revision'},{model:model('shift','Roster'),id:asId('roster')});
   const duty=row('duty',{role:'Reception',published:true,target_visible:mode!=='denied-duty',published_revision:'7',published_by:{id:user.user_id},override_reason:null},{model:model('shift','Commitment'),id:commitment.id});
   const swap=row('swap',{substitute:{id:'substitute'},original:{id:'original'},revision:'1',state:mode==='false-prefix'?'accepted':'open',original_visible:mode!=='denied-ref'},{model:model('shift','Duty'),id:duty.id});
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    {kind:'insert',model:model('rent_catalog','Location'),row:row('location',{active:true})},
    {kind:'insert',model:model('employee','Employee'),row:row('original',{...employee,user:{id:recipient.user_id},user_visible:mode!=='denied-user'})},
    {kind:'insert',model:model('employee','Employee'),row:row('substitute',{...employee,user:{id:user.user_id}})},
    {kind:'insert',model:model('shift','Roster'),row:row('roster',{name:'Original roster'})},
    {kind:'insert',model:model('shift','Commitment'),row:commitment},{kind:'insert',model:model('shift','Duty'),row:duty},{kind:'insert',model:model('shift','Swap'),row:swap}]}));
   const load=store.load.bind(store),commit=store.commit.bind(store);let raced=false;
   store.load=async(name,id)=>{if(!raced&&mode==='identity-race'&&name==='work.occurrence'){raced=true;await identities.removeMembership(membership.membership_id);}return load(name,id);};
   store.commit=async batch=>{if(!raced&&['ref-race','revision-race','grant-race'].includes(mode)&&batch.writes.some(write=>write.model==='work.occurrence')){
    raced=true;const name=mode==='ref-race'?model('shift','Swap'):mode==='revision-race'?model('shift','Commitment'):model('employee','Employee'),old=await load(name,mode==='ref-race'?swap.id:mode==='revision-race'?commitment.id:asId('original'));assert.ok(old);
    await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:name,id:old.id,expectedVersion:old.version,row:{...old,version:asVersion(old.version+1),data:{...old.data,...(mode==='ref-race'?{original:{id:'substitute'}}:mode==='revision-race'?{revision:'8'}:{user_visible:false})}}}]}));
   }return commit(batch);};
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now}),request={operation:'shift.decline',operation_id:operationId(now),inputs:{swap:{id:'swap',version:mode==='stale'?'2':'1'}}};
   const result=await invoker.invokeMutation(request,identity),success=['allowed','revision-race'].includes(mode);assert.equal('result'in result,success,mode+': '+JSON.stringify(result));if(mode.endsWith('-race'))assert.ok(raced,mode);
   const events=await store.query({model:asModel('work.occurrence'),authority:'owner'}),current=await load(model('shift','Swap'),swap.id);assert.equal(events.length,success?1:0,mode);assert.ok(current);
   if(success){assert.equal(current.data.state,'rejected');assert.deepEqual((events[0]!.data.result as {payload:unknown}).payload,{duty:{id:'duty'},recipient:{id:recipient.user_id},revision:mode==='revision-race'?'8':'7',kind:'swap_rejected',swap:{id:'swap',version:'2'}});const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay||replay.error.code==='validation');assert.deepEqual(await store.query({model:asModel('work.occurrence'),authority:'owner'}),events);}
   else if(mode==='ref-race'){assert.equal(current.data.state,swap.data.state);assert.deepEqual(current.data.original,{id:'substitute'});}else assert.deepEqual(current,swap,mode+': original SET rolls back');
   assert.deepEqual(await load(model('shift','Duty'),duty.id),duty,'decline leaves duty unchanged');
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('cancels the complete original Shift duty with its bounded swaps and optional notice', {timeout:180000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-shift-cancel-'));
 try{
  const source=join(root,'compiler/tests/fixtures/shift-cancel-original.can'),original=await readFile(join(root,'draft/apps/CanShift/CanShift.can'),'utf8'),text=await readFile(source,'utf8');
  const start=original.indexOf('  scenario cancel('),end=original.indexOf('  # Resolve',start);assert.ok(text.includes(original.slice(start,end)));
  const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const artifact=JSON.parse(stdout) as CompileArtifact,asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  for(const mode of ['allowed','unpublished','unpublished-denied-user','denied-user','denied-revision','hidden-swap','dependent','limit','stale','insert-race','grant-race','identity-race']){
   const {now,identities,identity,team,user,membership}=await member('shift-cancel-'+mode,['shift.scheduler']);
   const recipient=await identities.createUser({email:'cancel-original-'+mode+'@shift.test',password_hash:'unused',email_verified:true});
   const scope={app:'CanShift',owner:team.team_id,ownerPackage:'shift'},authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'cancel-state',fileStoreId:'cancel-files',receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
   const {store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
   const row=(id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({...makeRow({id:asId(id),data}),parent}),employee={home:{id:'location'},locations:[],operator_wide:false,active:true,skills:['reception'],role:'Reception',visible:true,user_visible:true};
   const commitment=row('commitment',{employee:{id:'original'},location:{id:'location'},from:'2099-01-01T09:00:00.000Z',until:'2099-01-01T17:00:00.000Z',before:'0',after:'0',skill:'reception',kind:'duty',source:'original-duty',previous:null,revision:'7',active:true,conflict:false,revision_visible:mode!=='denied-revision'},{model:model('shift','Roster'),id:asId('roster')});
   const duty=row('duty',{role:'Reception',published:!mode.startsWith('unpublished'),published_revision:'7',published_by:{id:user.user_id},override_reason:null},{model:model('shift','Commitment'),id:commitment.id});
   const swap=(id:string,state='open',parent=duty.id)=>row(id,{substitute:{id:'actor'},original:{id:'original'},revision:'1',state,hidden:mode==='hidden-swap'},{model:model('shift','Duty'),id:parent});
   const swaps=Array.from({length:mode==='limit'?101:2},(_,index)=>swap('swap-'+index));
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    {kind:'insert',model:model('rent_catalog','Location'),row:row('location',{active:true})},
    {kind:'insert',model:model('employee','Employee'),row:row('original',{...employee,user:{id:recipient.user_id},user_visible:!['denied-user','unpublished-denied-user'].includes(mode)})},
    {kind:'insert',model:model('employee','Employee'),row:row('actor',{...employee,user:{id:user.user_id}})},
    {kind:'insert',model:model('shift','Roster'),row:row('roster',{name:'Original roster'})},
    {kind:'insert',model:model('shift','Commitment'),row:commitment},{kind:'insert',model:model('shift','Duty'),row:duty},
    {kind:'insert',model:model('shift','Commitment'),row:{...commitment,id:asId('other-commitment'),data:{...commitment.data,source:'other'}}},{kind:'insert',model:model('shift','Duty'),row:{...duty,id:asId('other-duty'),parent:{model:model('shift','Commitment'),id:asId('other-commitment')}}},
    ...[...swaps,swap('accepted','accepted'),swap('foreign','open',asId('other-duty'))].map(row=>({kind:'insert' as const,model:model('shift','Swap'),row})),
    ...(mode==='dependent'?[{kind:'insert' as const,model:model('shift','Commitment'),row:{...commitment,id:asId('dependent'),data:{...commitment.data,kind:'visit',source:'dependent'}}}]:[])]}));
   const load=store.load.bind(store),commit=store.commit.bind(store);let raced=false;
   store.load=async(name,id)=>{if(!raced&&mode==='identity-race'&&name==='work.occurrence'){raced=true;await identities.removeMembership(membership.membership_id);}return load(name,id);};
   store.commit=async batch=>{if(!raced&&['insert-race','grant-race'].includes(mode)&&batch.writes.some(write=>write.model==='work.occurrence')){raced=true;if(mode==='insert-race')await commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:model('shift','Swap'),row:swap('inserted')}]}));else{const old=await load(model('employee','Employee'),asId('original'));assert.ok(old);await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:model('employee','Employee'),id:old.id,expectedVersion:old.version,row:{...old,version:asVersion(old.version+1),data:{...old.data,user_visible:false}}}]}));}}return commit(batch);};
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now}),request={operation:'shift.cancel',operation_id:operationId(now),inputs:{duty:{id:'duty',version:mode==='stale'?'2':'1'},reason:'Original release reason'}};
   const result=await invoker.invokeMutation(request,identity),success=['allowed','unpublished','unpublished-denied-user','hidden-swap','insert-race'].includes(mode);assert.equal('result'in result,success,mode+': '+JSON.stringify(result));if(mode.endsWith('-race'))assert.ok(raced,mode);
   const events=await store.query({model:asModel('work.occurrence'),authority:'owner'}),current=await load(model('shift','Commitment'),commitment.id);assert.equal(events.length,success&&!mode.startsWith('unpublished')?1:0,mode);assert.ok(current);
   if(success){assert.equal(current.data.active,false);assert.equal(current.data.revision,'8');for(const candidate of [...swaps,...(mode==='insert-race'?[swap('inserted')]:[])])assert.equal((await load(model('shift','Swap'),candidate.id))?.data.state,'obsolete',mode);if(events.length)assert.deepEqual((events[0]!.data.result as {payload:unknown}).payload,{duty:{id:'duty',version:'1'},recipient:{id:recipient.user_id},revision:'8',kind:'cancelled',swap:null});const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay||replay.error.code==='validation');assert.deepEqual(await store.query({model:asModel('work.occurrence'),authority:'owner'}),events);}
   else{assert.deepEqual(current,commitment,mode+': parent SET rolls back');for(const candidate of swaps)assert.deepEqual(await load(model('shift','Swap'),candidate.id),candidate,mode+': all sibling SETs roll back');}
   assert.equal((await load(model('shift','Swap'),asId('accepted')))?.data.state,'accepted');assert.equal((await load(model('shift','Swap'),asId('foreign')))?.data.state,'open');assert.deepEqual(await load(model('shift','Duty'),duty.id),duty,'cancel does not rewrite Duty');
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});


it('accepts the complete original Shift swap through staged ancestor writes and its sibling loop', {timeout:240000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-shift-accept-'));
 try{
  const source=join(root,'compiler/tests/fixtures/shift-accept-original.can'),original=await readFile(join(root,'draft/apps/CanShift/CanShift.can'),'utf8'),text=await readFile(source,'utf8');
  const start=original.indexOf('  scenario accept('),end=original.indexOf('   examples',start);assert.ok(text.includes(original.slice(start,end)));
  const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const artifact=JSON.parse(stdout) as CompileArtifact,asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  for(const mode of (process.env['CAN_SHIFT_ACCEPT_CASE']??'allowed,member-only,dependent,unpublished,stale,denied-user,denied-revision,member-grant-after-set,denied-substitute,limit,parent-race,grant-race,identity-race,insert-race').split(',')){
   const {now,identities,identity,team,user,membership}=await member('shift-accept-'+mode,mode==='member-only'?[]:['shift.scheduler']);
   const recipient=await identities.createUser({email:'accept-original-'+mode+'@shift.test',password_hash:'unused',email_verified:true});
   const scope={app:'CanShift',owner:team.team_id,ownerPackage:'shift'},authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'accept-state',fileStoreId:'accept-files',receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
   const {store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
   const row=(id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({...makeRow({id:asId(id),data}),parent}),employee={home:{id:'location'},locations:[],operator_wide:false,active:true,skills:['reception'],role:'Reception',visible:true,user_visible:true};
   const commitment=row('commitment',{employee:{id:'original'},location:{id:'location'},from:'2099-01-01T09:00:00.000Z',until:'2099-01-01T17:00:00.000Z',before:'0',after:'0',skill:'reception',kind:'duty',source:'original-duty',previous:null,revision:'7',active:true,conflict:true,revision_visible:mode!=='denied-revision'},{model:model('shift','Roster'),id:asId('roster')});
   const duty=row('duty',{visible:mode!=='member-grant-after-set',role:'Reception',published:mode!=='unpublished',published_revision:'7',published_by:{id:user.user_id},override_reason:null},{model:model('shift','Commitment'),id:commitment.id});
   const swap=(id:string,state='open',parent=duty.id)=>row(id,{substitute:{id:'actor'},original:{id:'original'},revision:'1',state},{model:model('shift','Duty'),id:parent});
   const proposed=swap('proposed'),swaps=Array.from({length:mode==='limit'?101:2},(_,index)=>swap('swap-'+index));
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    {kind:'insert',model:model('rent_catalog','Location'),row:row('location',{active:true})},
    {kind:'insert',model:model('employee','Employee'),row:row('original',{...employee,user:{id:recipient.user_id},user_visible:mode!=='denied-user'})},
    {kind:'insert',model:model('employee','Employee'),row:row('actor',{...employee,visible:mode!=='denied-substitute',user:{id:user.user_id}})},
    {kind:'insert',model:model('shift','Roster'),row:row('roster',{name:'Original roster'})},
    {kind:'insert',model:model('shift','Availability'),row:row('available',{employee:{id:'actor'},available:true,from:'2099-01-01T00:00:00.000Z',until:'2099-01-02T00:00:00.000Z'},commitment.parent)},
    {kind:'insert',model:model('shift','Commitment'),row:commitment},{kind:'insert',model:model('shift','Duty'),row:duty},
    {kind:'insert',model:model('shift','Commitment'),row:{...commitment,id:asId('other-commitment'),data:{...commitment.data,source:'other',active:false}}},{kind:'insert',model:model('shift','Duty'),row:{...duty,id:asId('other-duty'),parent:{model:model('shift','Commitment'),id:asId('other-commitment')}}},
    ...[proposed,...swaps,swap('accepted','accepted'),swap('foreign','open',asId('other-duty'))].map(row=>({kind:'insert' as const,model:model('shift','Swap'),row})),
    ...(mode==='dependent'?[{kind:'insert' as const,model:model('shift','Commitment'),row:{...commitment,id:asId('dependent'),data:{...commitment.data,kind:'visit',source:'dependent'}}}]:[])]}));
   const load=store.load.bind(store),commit=store.commit.bind(store);let raced=false;
   store.load=async(name,id)=>{if(!raced&&mode==='identity-race'&&name==='work.occurrence'){raced=true;await identities.removeMembership(membership.membership_id);}return load(name,id);};
   store.commit=async batch=>{if(!raced&&['parent-race','grant-race','insert-race'].includes(mode)&&batch.writes.some(write=>write.model==='work.occurrence')){raced=true;
    if(mode==='insert-race')await commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:model('shift','Swap'),row:swap('inserted')}]}));
    else{const name=mode==='parent-race'?model('shift','Swap'):model('employee','Employee'),old=await load(name,mode==='parent-race'?proposed.id:asId('original'));assert.ok(old);await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:name,id:old.id,expectedVersion:old.version,row:{...old,version:asVersion(old.version+1),...(mode==='parent-race'?{parent:{model:model('shift','Duty'),id:asId('other-duty')}}:{data:{...old.data,user_visible:false}})}}]}));}
   }return commit(batch);};
   const unchangedSource = async () => ({
    domains: await Promise.all([...new Set([...(artifact.models??[]).map(model=>model.name),
     'work.occurrence','work.schedule','work.dispatch','work.receipt','work.receipt_association'])].map(async name=>{
      const rows=await store.query({model:asModel(name),authority:'owner',archived:'include'});
      return {name,rows,history:await Promise.all(rows.map(row=>store.historyFor(asModel(name),row.id)))};
    })), outbox:await store.outboxPending(),
   });
   const hiddenAncestorBaseline=mode==='member-grant-after-set'?await unchangedSource():undefined;
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now}),request={operation:'shift.accept',operation_id:operationId(now),inputs:{swap:{id:'proposed',version:mode==='stale'?'2':'1'}}};
   const result=await invoker.invokeMutation(request,identity),success=['allowed','insert-race'].includes(mode);assert.equal('result'in result,success,mode+': '+JSON.stringify(result));if(mode.endsWith('-race'))assert.ok(raced,mode);
   if(mode==='member-grant-after-set'){
    assert.ok('error'in result);assert.equal(result.error.code,'forbidden');
    assert.equal(result.error.message,'Original model query source fields are unavailable.');
    assert.deepEqual(await unchangedSource(),hiddenAncestorBaseline,
     'stage-zero Swap.parent DATA cannot use a Duty grant that would become true only after a later SET');
   }
   const events=await store.query({model:asModel('work.occurrence'),authority:'owner'}),current=await load(model('shift','Commitment'),commitment.id),currentDuty=await load(model('shift','Duty'),duty.id),currentSwap=await load(model('shift','Swap'),proposed.id);assert.equal(events.length,success?2:0,mode);assert.ok(current);assert.ok(currentDuty);assert.ok(currentSwap);
   if(success){assert.deepEqual(current.data.employee,{id:'actor'});assert.equal(current.data.revision,'8');assert.equal(current.data.conflict,false);assert.equal(currentSwap.data.state,'accepted');assert.equal(currentDuty.data.published_revision,'8');for(const candidate of [...swaps,...(mode==='insert-race'?[swap('inserted')]:[])])assert.equal((await load(model('shift','Swap'),candidate.id))?.data.state,'obsolete',mode);
    assert.deepEqual(events.map(event=>(event.data.result as {payload:{recipient:{id:string};revision:string;kind:string}}).payload.recipient.id).sort(),[recipient.user_id,user.user_id].sort());assert.ok(events.every(event=>(event.data.result as{payload:{revision:string;kind:string}}).payload.revision==='8'&&(event.data.result as{payload:{kind:string}}).payload.kind==='swap_accepted'));
    const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay||replay.error.code==='validation');assert.deepEqual(await store.query({model:asModel('work.occurrence'),authority:'owner'}),events);
   }else{assert.deepEqual(current,commitment,mode+': original parent SET rolls back');assert.deepEqual(currentDuty,duty,mode+': Duty SET rolls back');assert.equal(currentSwap.data.state,'open');for(const candidate of swaps)assert.deepEqual(await load(model('shift','Swap'),candidate.id),candidate,mode+': siblings roll back');}
   assert.equal((await load(model('shift','Swap'),asId('accepted')))?.data.state,'accepted');assert.equal((await load(model('shift','Swap'),asId('foreign')))?.data.state,'open');
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});


it('submits the complete original Expense with a live independent reviewer role and receipt match', {timeout:240000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-expense-submit-'));
 try{
  const source=join(root,'compiler/tests/fixtures/expense-submit-original.can'),original=await readFile(join(root,'draft/apps/CanExpense/CanExpense.can'),'utf8'),text=await readFile(source,'utf8');
  const start=original.indexOf('  scenario submit('),end=original.indexOf('   examples',start);assert.ok(text.includes(original.slice(start,end)));
  for(const declaration of original.split('\n').filter(line=>line.startsWith('  invariant Expense:')||line.startsWith('  lock Expense ')||line.startsWith('  invariant ReceiptExtract:')||line.startsWith('  lock ReceiptExtract ')))assert.ok(text.includes(declaration));
  const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source,join(root,'draft/shared/Employees.can'),join(root,'draft/shared/Locations.can')],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const artifact=JSON.parse(stdout) as CompileArtifact,asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  for(const mode of ['allowed','not-reviewer','inactive-reviewer','no-extract','wrong-amount','stale','role-race','identity-race','extract-race']){
   const {now,identities,team,user,membership,identity}=await member('expense-submit-'+mode);
   const reviewer=await identities.createUser({email:mode+'@expense-review.test',password_hash:'unused',email_verified:true});
   const reviewerMembership=await identities.createMembership({team_id:team.team_id,user_id:reviewer.user_id,is_owner:false,roles:mode==='not-reviewer'?[]:[{role:'expense.reviewer',granted_at:new Date(now).toISOString(),granted_by:user.user_id}]});
   const scope={app:'CanExpense',owner:team.team_id,ownerPackage:'expense'},authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'expense-state',fileStoreId:'expense-files',receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
   const {store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
   const clock=new TestOnlyManualClock(now),blobs=new TestOnlyMemoryBlobStore(),files=new TestOnlyMemoryFinalizedStore(),intents=new TestOnlyMemoryIntentStore();
   const physical={clock,blobs,files,upload:{clock,intents,blobs,policy:DEFAULT_FILE_POLICY,intentIds:new TestOnlyCounterIntentIds(),intentTtlMs:3600000,urlBase:'https://expense.test'},finalize:{clock,intents,blobs,files,fileIds:new TestOnlyCounterFileIds()}};
   const retention={unattachedHorizonMs:3600000,retentionMs:86400000},observation={policy:physical.upload.policy,retention};
   const kernel=createFileJourneyKernel({maxBytes:physical.upload.policy.maxBytes,createIntent:input=>createUploadIntent(physical.upload,input),append:(id,caller,bytes,offset)=>appendUploadContentAtOffset(physical.upload,id,caller,bytes,offset),complete:(id,caller)=>completeUploadContent(physical.upload,id,caller),finalize:input=>finalizeUpload(physical.finalize,input),authorizeAttach:(ref,caller)=>authorizeAttach(physical.finalize,ref,caller),readProvenance:(ref,caller)=>readFinalizedFile(physical.finalize,ref,caller),recordAttachment:(ref,record,caller)=>recordAttachment(physical.finalize,ref,record,caller),readBytes:(ref,caller)=>readFinalizedBytes(physical.finalize,ref,caller),readCurrentBytes:(ref,caller,policy)=>readCurrentFinalizedBytes(physical.finalize,ref,caller,{...observation,retention:policy}),readCurrentSnapshot:(ref,caller,policy)=>readCurrentFinalizedSnapshot(physical.finalize,ref,caller,{...observation,retention:policy}),observeFile:(ref,caller,policy)=>observeFinalizedFile(physical.finalize,ref,caller,{...observation,retention:policy}),revalidateFile:(saved,caller,policy)=>revalidateRetainedFinalizedFile(physical.finalize,saved,caller,{...observation,retention:policy})} satisfies FileJourneyBindings);
   const receiver={app:scope.app,owner:team.team_id,team:team.team_id,principal:user.user_id},bytes=new TextEncoder().encode('Exact original receipt');
   const intent=createUploadIntent(physical.upload,{receiver,binding:{adapter:'deployment.web',deliveryId:'receipt',resultPath:'receipt'},request:{upload_id:'receipt',operation:'expense.submit',field:'/receipt',arguments:{},name:'receipt.txt',type:'text/plain',size:String(bytes.length)}});assert.ok(intent.status==='granted');
   assert.equal(appendUploadContentAtOffset(physical.upload,intent.intentId,receiver,bytes,0).status,'appended');assert.equal(completeUploadContent(physical.upload,intent.intentId,receiver).status,'completed');
   const finalized=finalizeUpload(physical.finalize,{intentId:intent.intentId,retryId:'receipt',bytesDigest:sha256Hex(bytes),caller:receiver});assert.ok(finalized.status==='finalized');
   const row=(id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({...makeRow({id:asId(id),data}),parent}),amount={minor:'2500',currency:'EUR'},employee={home:{id:'site'},locations:[{id:'site'}],active:true,operator_wide:false,start:'2026-01-01',end:null,role:'Operator',skills:[],name:null,manager:null,private_notes:null,document:null};
   const expense=row('expense',{location:{id:'site'},corrects:null,authorization:null,purpose:'Travel',category:'Travel',amount,business_date:'2026-10-01',receipt:{id:finalized.result.file},reviewer:{id:reviewer.user_id},status:'draft',submission:'0',withdrawal:null,decision:null,decided_by:null,decided_at:null},{model:asModel('employee.Employee'),id:asId('claimant')});
   const extract=row('extract',{source:'original-receipt',amount:mode==='wrong-amount'?{minor:'1000',currency:'EUR'}:amount,spent_on:'2026-10-01',merchant:'Station kiosk'},{model:asModel('expense.Expense'),id:expense.id});
   await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:asModel('rent_catalog.Location'),row:row('site',{name:'Office',address:'Example',timezone:'UTC',currency:'EUR',hours:'09:00-18:00',arrival:'Reception',active:true})},{kind:'insert',model:asModel('employee.Employee'),row:row('claimant',{...employee,user:{id:user.user_id}})},{kind:'insert',model:asModel('employee.Employee'),row:row('reviewer',{...employee,user:{id:reviewer.user_id},active:mode!=='inactive-reviewer'})},{kind:'insert',model:asModel('expense.Expense'),row:expense},...(mode==='no-extract'?[]:[{kind:'insert' as const,model:asModel('expense.ReceiptExtract'),row:extract}])]}));
   const commit=store.commit.bind(store),load=store.load.bind(store),query=store.query.bind(store);let raced=false;
   // The original role check precedes ReceiptExtract observation. Revoke
   // inside that tracked query so current/final Identity fences can reject it.
   store.query=async input=>{const rows=await query(input);if(!raced&&['role-race','identity-race'].includes(mode)&&input.model==='expense.ReceiptExtract'){raced=true;if(mode==='role-race')await identities.setMembershipRoles(reviewerMembership.membership_id,[]);else await identities.removeMembership(membership.membership_id);}return rows;};
   store.commit=async batch=>{if(!raced&&mode==='extract-race'&&batch.writes.some(write=>write.model==='expense.Expense')){raced=true;await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:asModel('expense.ReceiptExtract'),id:extract.id,expectedVersion:extract.version,row:{...extract,version:asVersion(extract.version+1),data:{...extract.data,amount:{minor:'5000',currency:'EUR'}}}}]}));}return commit(batch);};
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now,files:createCanonicalFileBinding(kernel,retention)}),request={operation:'expense.submit',operation_id:operationId(now),inputs:{expense:{id:'expense',version:mode==='stale'?'2':'1'}}};
   const result=await invoker.invokeMutation(request,identity);assert.equal('result'in result,mode==='allowed',mode+': '+JSON.stringify(result));if(mode.endsWith('-race'))assert.ok(raced,mode);
   const current=await load(asModel('expense.Expense'),expense.id);assert.ok(current);
   if(mode==='allowed'){assert.equal(current.data.status,'submitted');assert.equal(current.data.submission,'1');const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay||replay.error.code==='validation');assert.deepEqual(await load(asModel('expense.Expense'),expense.id),current);}
   else assert.deepEqual(current,expense,mode+': failed guard or lost authority rolls back the whole update');
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('terminates the original agreement with coherent subject roles and its exact Work cancellation', {timeout:180000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-contract-role-guard-'));
 try{
  const source=join(root,'compiler/tests/fixtures/contract-terminate-forwarded-reference.can'),text=await readFile(source,'utf8'),original=await readFile(join(root,'draft/apps/CanContract/CanContract.can'),'utf8');
  const start=original.indexOf('  scenario terminate('),end=original.indexOf('  # Complete an obligation',start);assert.ok(text.includes(original.slice(start,end)));
  const{stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const artifact=JSON.parse(stdout)as CompileArtifact,asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  for(const mode of(process.env['CAN_CONTRACT_TERMINATE_CASE']??'valid,unexecuted,terminated,employee-inactive,wrong-role,stale,role-race,parent-race').split(',')){
   const{now,identities,identity,user:actor,membership}=await member('contract-terminate-'+mode,mode==='wrong-role'?['agreements.finance']:['agreements.legal']);
   const store=createMemoryStorage(),agreement={model:asModel('agreements.Agreement'),id:asId('agreement')},termModel=asModel('agreements.Term');
   const insert=(model:string,id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({kind:'insert'as const,model:asModel(model),row:{...makeRow({id:asId(id),data}),parent}});
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    insert('rent_catalog.Location','location',{active:true}),insert('rent_catalog.Location','away',{active:true}),
    insert('employee.Employee','operator',{user:{id:actor.user_id},active:mode!=='employee-inactive',operator_wide:false,home:{id:'location'},locations:[]}),
    insert('agreements.Agreement','agreement',{location:{id:'location'},active:true,category:'landlord'}),insert('agreements.Agreement','foreign',{location:{id:'away'},active:true,category:'landlord'}),
    insert('agreements.Term','term',{executed:mode!=='unexecuted',terminated:mode==='terminated',reason:null},agreement)
   ]}));
   const scope={app:'ContractForwarding',owner:membership.team_id,ownerPackage:'agreements'},foreign={...scope,owner:'foreign-owner'},stage={actor:'original-scheduler',now,operation:'agreements.seed',load:store.load.bind(store),query:store.query.bind(store)};
   const stages=await Promise.all([scope,foreign].map((scope,index)=>workSchedulePutCommand.stage({key:'term',scope,at:now+10000,event:'agreements.Due',payload:{term:{id:'term'}},occurrenceId:'original-'+index},stage)));
   await store.commit(makeBatch(await store.readRevision(),{writes:stages.flatMap(stage=>stage.writes??[]),schedules:stages.flatMap(stage=>stage.schedules??[])}));
   const query=store.query.bind(store),commit=store.commit.bind(store);let raced=false;
   store.query=async input=>{const rows=await query(input);if(mode==='role-race'&&!raced&&input.model===asModel('employee.Employee')){raced=true;await identities.setMembershipRoles(membership.membership_id,[]);}return rows;};
   store.commit=async batch=>{if(mode==='parent-race'&&!raced&&batch.writes.some(write=>write.model===termModel)){raced=true;const term=(await store.load(termModel,asId('term')))!;await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:termModel,id:term.id,expectedVersion:term.version,row:{...term,parent:{model:agreement.model,id:asId('foreign')},version:asVersion(term.version+1)}}]}));}return commit(batch);};
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now}),request={operation:'agreements.terminate',operation_id:operationId(now),inputs:{term:{id:'term',version:mode==='stale'?'2':'1'},reason:'Original termination'}};
   const result=await invoker.invokeMutation(request,identity),success=mode==='valid';assert.equal('result'in result,success,mode+': '+JSON.stringify(result));
   const term=(await store.load(termModel,asId('term')))!;assert.equal(term.data.terminated,success||mode==='terminated',mode);assert.equal(term.data.reason,success?'Original termination':null,mode);
   const schedules=await query({model:asModel('work.schedule'),authority:'owner'});assert.equal(schedules.length,2);assert.equal(schedules.find(row=>row.data.scopeOwner===scope.owner)!.data.state,success?'cancelled':'pending',mode);assert.equal(schedules.find(row=>row.data.scopeOwner===foreign.owner)!.data.state,'pending');
   if(success){const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay&&replay.result.status==='replayed',JSON.stringify(replay));assert.deepEqual(await query({model:asModel('work.schedule'),authority:'owner'}),schedules);await identities.setMembershipRoles(membership.membership_id,[]);const revokedReplay=await invoker.invokeMutation(request,identity);assert.ok('result'in revokedReplay&&revokedReplay.result.status==='replayed');assert.deepEqual(revokedReplay.result.result,null);assert.deepEqual(revokedReplay.result.records,[]);assert.deepEqual(await query({model:asModel('work.schedule'),authority:'owner'}),schedules);const denied=await invoker.invokeMutation({...request,operation_id:operationId(now+1)},identity);assert.ok('error'in denied&&denied.error.code==='forbidden',JSON.stringify(denied));}
   if(mode.endsWith('-race'))assert.ok(raced,mode);
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('executes the complete original Invoice void with its unique fence, Work cancellation and settlement', {timeout:900000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-invoice-void-source-')),sourceDirectory=await mkdtemp(join(root,'packages/cloudflare/test/fixtures/.invoice-void-data-'));
 try{
  const{artifact,asm}=await installed('invoice-void-source.can',directory),original=await readFile(join(root,'draft/apps/CanInvoice/CanInvoice.can'),'utf8'),text=await readFile(fixture('invoice-void-source.can'),'utf8');
  const start=original.indexOf('  scenario void_invoice('),end=original.indexOf('   examples ',start);assert.ok(text.includes(original.slice(start,end)),'complete original unique IF, bounded cancellation loop, settlement and both CANCEL expressions remain authored');
  for(const mode of (process.env['CAN_INVOICE_VOID_CASE']??'empty,pending,constructor-data-denied,maximum,overflow,existing-fence,duplicate-race,identity-race,source-race,aggregate-race,withheld-reference').split(',')){
   let activeArtifact=artifact,activeAsm=asm;
   if(mode==='constructor-data-denied'){
    // Remove the later EMIT so only the original constructor's own DATA
    // observation can reject this read; a Bool guard cannot lend that grant.
    const source=join(sourceDirectory,'constructor-data.can');
    await writeFile(source,text.replace('policy Invoice read=members and not row.hidden','policy Invoice read=members where=not row.hidden fields=location,currency,state,total,next_collection,ledger_revision,first_paid_at,hidden,needs_review,credits,received,refunded,balance,refund_due').replace('    emit InvoiceSettlement {value=settlement(invoice)}\n',''));
    const{stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});activeArtifact=JSON.parse(stdout)as CompileArtifact;
    activeAsm=await assembleModules({artifact:activeArtifact,sourcePath:source},{workDir:join(directory,'constructor-data'),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
   }
   const{now,identities,identity,user,team,membership}=await member('invoice-void-'+mode,['invoice.finance']);
   const scope={app:'CanInvoice',owner:team.team_id,ownerPackage:'invoice'},authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'void-state',fileStoreId:'void-files',receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
   const{store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
   await installNativeFileInventory({artifact:activeArtifact,asm:activeAsm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
   const row=(model:string,id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({kind:'insert'as const,model:asModel(model),row:{...makeRow({id:asId(id),data}),parent}}),parent={model:asModel('invoice.Invoice'),id:asId('invoice')};
   const zero={minor:'0',currency:'EUR'},amount={minor:'100',currency:'EUR'},count=['pending','aggregate-race','withheld-reference'].includes(mode)?2:mode==='maximum'?100:mode==='overflow'?101:0;
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    row('rent_catalog.Location','location',{active:true}),row('customer.Customer','customer',{kind:'company',hidden:false}),row('employee.Employee','worker',{user:{id:user.user_id},home:{id:'location'},locations:[],operator_wide:false,active:true,hidden:true}),
    row('invoice.Invoice','invoice',{location:{id:'location'},source:'original-invoice',currency:'EUR',state:'issued',total:amount,next_collection:new Date(now+3600000).toISOString(),ledger_revision:'0',first_paid_at:null,hidden:false,needs_review:false},{model:asModel('customer.Customer'),id:asId('customer')}),
    ...Array.from({length:count},(_,index)=>row('invoice.Attempt','attempt-'+index,{reference:'attempt-'+index,amount,kind:'collection',status:index===0?'pending':'unknown',failure:null,disabled:false,delivery:null,checkout:'https://checkout.test/'+index,outcome_at:null,received:null,reference_readable:mode!=='withheld-reference',hidden:false},parent)),
    ...(mode==='existing-fence'?[row('invoice.BillingCancellation','prior',{source:'original-invoice',reason:'Original cancellation'})]:[])
   ]}));
   const invoker=buildInvoker(activeArtifact,activeAsm,store,{memberships:identities,now:()=>now});
   const armed=await invoker.invokeMutation({operation:'invoice.arm_void',operation_id:operationId(now),inputs:{invoice:{id:'invoice',version:'1'}}},identity);assert.ok('result'in armed&&armed.result.status==='committed',JSON.stringify(armed));
   const before=await store.query({model:asModel('work.schedule'),authority:'owner'});assert.equal(before.length,2);
   const commit=store.commit.bind(store),query=store.query.bind(store),load=store.load.bind(store);let raced=false;
   store.query=async spec=>{const rows=await query(spec);if(mode==='identity-race'&&spec.model==='invoice.BillingCancellation'&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}return rows;};
   store.commit=async batch=>{if(!raced&&['duplicate-race','source-race','aggregate-race'].includes(mode)&&batch.writes.some(write=>write.kind==='insert'&&write.model==='invoice.BillingCancellation')){raced=true;if(mode==='duplicate-race')await commit(makeBatch(await store.readRevision(),{writes:[row('invoice.BillingCancellation','concurrent',{source:'original-invoice',reason:'Concurrent original cancellation'})]}));else{const changedModel=asModel(mode==='aggregate-race'?'invoice.Attempt':'invoice.Invoice'),old=await load(changedModel,asId(mode==='aggregate-race'?'attempt-0':'invoice'));assert.ok(old);await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:changedModel,id:old.id,expectedVersion:old.version,row:{...old,version:asVersion(old.version+1),data:{...old.data,...(mode==='aggregate-race'?{hidden:true}:{state:'draft'})}}}]}));}}return commit(batch);};
   const request={operation:'invoice.void_invoice',operation_id:operationId(now),inputs:{invoice:{id:'invoice',version:'1'},reason:'Reviewed cancellation'}},outcome=await invoker.invokeMutation(request,identity),success=!['constructor-data-denied','overflow','identity-race','source-race','aggregate-race','withheld-reference'].includes(mode);assert.equal('result'in outcome&&outcome.result.status==='committed',success,mode+': '+JSON.stringify(outcome));
   if(mode.endsWith('-race'))assert.ok(raced,mode);
   if(!success){assert.equal((await query({model:asModel('invoice.PaymentRequest'),authority:'owner'})).length,0);assert.equal((await query({model:asModel('invoice.BillingCancellation'),authority:'owner'})).length,0);assert.equal((await store.outboxPending()).length,0);assert.equal((await query({model:asModel('work.occurrence'),authority:'owner'})).length,0);assert.deepEqual(await query({model:asModel('work.schedule'),authority:'owner'}),before);const unchanged=await load(asModel('invoice.Invoice'),asId('invoice'));assert.ok(unchanged);assert.equal(unchanged.data.state,mode==='source-race'?'draft':'issued');assert.equal(unchanged.data.ledger_revision,'0');continue;}

   const invoice=await store.load(asModel('invoice.Invoice'),asId('invoice'));assert.ok(invoice);assert.equal(invoice.data.state,count?'void_pending':'void');assert.equal(invoice.data.next_collection,null);assert.equal(invoice.data.ledger_revision,'1');
   const fences=await store.query({model:asModel('invoice.BillingCancellation'),authority:'owner'});assert.equal(fences.length,1);assert.equal(fences[0]!.data.source,'original-invoice');assert.equal(fences[0]!.data.reason,mode==='existing-fence'?'Original cancellation':mode==='duplicate-race'?'Concurrent original cancellation':'Reviewed cancellation');
   const pending=await store.outboxPending(),requests=await store.query({model:asModel('invoice.PaymentRequest'),authority:'owner'});assert.equal(pending.length,count);assert.equal(requests.length,count);
   for(const request of requests){const id=(request.data.cancellation as{id:string}).id;assert.ok(pending.some(intent=>intent.intentId===id&&intent.target==='std.PaymentsV1.cancel'));assert.equal(request.data.kind,'cancel');assert.equal(request.data.reconciliation,null);}
   const events=(await store.query({model:asModel('work.occurrence'),authority:'owner'}));assert.equal(events.length,1);assert.deepEqual((events[0]!.data.result as{payload:unknown}).payload,{value:{source:'original-invoice',invoice:'invoice',revision:'1',amount,collected:zero,refunded:zero,collection_pending:count>0,refund_pending:false,state:count?'void_pending':'void',recorded_at:new Date(now).toISOString()}});
   for(const key of ['invoice','invoice:collection'])assert.equal(await store.scheduleGet([scope.app,scope.ownerPackage,scope.owner,key].map(encodeURIComponent).join('/')),null,'both authored keys cancel their genuine original Work schedules');
   const schedules=await store.query({model:asModel('work.schedule'),authority:'owner'});assert.ok(schedules.every(row=>row.data.state==='cancelled'));
   if(mode==='pending'){
    for(const operation of ['invalid_kind','invalid_review']){const invalid=await invoker.invokeMutation({operation:'invoice.'+operation,operation_id:operationId(now),inputs:{attempt:{id:'attempt-0',version:'2'}}},identity);assert.ok('error'in invalid,operation+': '+JSON.stringify(invalid));assert.equal(invalid.error.code,'rule_failed',operation);assert.deepEqual(await store.outboxPending(),pending);assert.deepEqual(await query({model:asModel('invoice.PaymentRequest'),authority:'owner'}),requests);}
    const locked=await invoker.invokeMutation({operation:'invoice.alter_request',operation_id:operationId(now),inputs:{request:{id:requests[0]!.id,version:String(requests[0]!.version)}}},identity);assert.ok('error'in locked,JSON.stringify(locked));assert.equal(locked.error.code,'rule_failed');assert.match(locked.error.message,/Locked fields/);assert.deepEqual(await query({model:asModel('invoice.PaymentRequest'),authority:'owner'}),requests);
   }
   const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay&&replay.result.status==='replayed',JSON.stringify(replay));assert.deepEqual(replay.result.records,[]);assert.equal(replay.result.result,null);assert.deepEqual(await store.query({model:asModel('work.schedule'),authority:'owner'}),schedules);assert.deepEqual(await store.outboxPending(),pending);
  }
 }finally{await rm(directory,{recursive:true,force:true});await rm(sourceDirectory,{recursive:true,force:true});}
});


it('adjusts the original Stock ledger with a complete contained integer sum', {timeout:180000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-stock-adjust-'));
 try{
  const source=join(root,'compiler/tests/fixtures/stock-adjust-original.can'),original=await readFile(join(root,'draft/apps/CanStock/CanStock.can'),'utf8'),text=await readFile(source,'utf8');
  const start=original.indexOf('  scenario adjust('),end=original.indexOf('   examples',start);assert.ok(text.includes(original.slice(start,end)));
  for(const prefix of ['  derive available(','  invariant Movement:','  lock Movement fields='])for(const line of original.split('\n').filter(line=>line.startsWith(prefix)))assert.ok(text.includes(line),line);
  const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
  const artifact=JSON.parse(stdout)as CompileArtifact,asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  for(const mode of (process.env['CAN_STOCK_ADJUST_CASE']??'consume,empty,insufficient,hidden-negative,hidden-positive,other-location,overflow,inactive,empty-reason,stale,insert-race,update-race,identity-race,location-race').split(',')){
   const{now,identities,identity,team,user,membership}=await member('stock-adjust-'+mode,['stock.stock_staff']);
   const scope={app:'CanStock',owner:team.team_id,ownerPackage:'stock'},authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'stock-state',fileStoreId:'stock-files',receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
   const{store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
   const row=(id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({...makeRow({id:asId(id),data}),parent}),parent={model:model('stock','Item'),id:asId('item')};
   const item=row('item',{sku:'coffee',name:'Coffee',unit:'box',reorder:'0',active:mode!=='inactive'}),movement=(id:string,quantity:string,location='location',visible=true)=>row(id,{visible,location:{id:location},quantity,reason:'Initial count',source:id,transfer:null,reversal:null,order:null,actor:null,revision:null,unit:null},parent);
   const overflow=['overflow','inactive','empty-reason'].includes(mode),ledger=mode==='empty'?[]:[movement('opening',overflow?'9223372036854775807':mode==='hidden-negative'?'6':mode==='hidden-positive'?'1':'3'),...(overflow?[movement('overflow','1')]:[]),...(mode==='hidden-negative'?[movement('hidden','-4','location',false)]:mode==='hidden-positive'?[movement('hidden','3','location',false)]:[])];
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    {kind:'insert',model:model('rent_catalog','Location'),row:row('location',{name:'Original location',active:true})},{kind:'insert',model:model('rent_catalog','Location'),row:row('elsewhere',{name:'Other location',active:true})},
    {kind:'insert',model:model('employee','Employee'),row:row('worker',{user:{id:user.user_id},home:{id:'location'},locations:[],operator_wide:false,active:true,skills:[],role:'Stock',visible:true,user_visible:true})},
    {kind:'insert',model:model('stock','Item'),row:item},{kind:'insert',model:model('stock','Item'),row:{...item,id:asId('other-item'),data:{...item.data,sku:'other'}}},
    ...[...ledger,movement('foreign-location','100','elsewhere'),{...movement('foreign-item','100'),parent:{model:model('stock','Item'),id:asId('other-item')}}].map(row=>({kind:'insert'as const,model:model('stock','Movement'),row}))]}));
   const load=store.load.bind(store),query=store.query.bind(store),commit=store.commit.bind(store);let raced=false;
   store.query=async request=>{const rows=await query(request);if(!raced&&['identity-race','location-race'].includes(mode)&&request.model===model('stock','Movement')){raced=true;if(mode==='identity-race')await identities.removeMembership(membership.membership_id);else{const old=await load(model('employee','Employee'),asId('worker'));assert.ok(old);await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:model('employee','Employee'),id:old.id,expectedVersion:old.version,row:{...old,version:asVersion(old.version+1),data:{...old.data,active:false}}}]}));}}return rows;};
   store.commit=async batch=>{if(!raced&&['insert-race','update-race'].includes(mode)&&batch.writes.some(write=>write.model===model('stock','Movement')&&write.kind==='insert')){raced=true;if(mode==='insert-race')await commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:model('stock','Movement'),row:movement('concurrent','-2')}]}));else{const old=await load(model('stock','Movement'),asId('opening'));assert.ok(old);await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:model('stock','Movement'),id:old.id,expectedVersion:old.version,row:{...old,version:asVersion(old.version+1),data:{...old.data,quantity:'1'}}}]}));}}return commit(batch);};
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now}),request={operation:'stock.adjust',operation_id:operationId(now),inputs:{item:{id:'item',version:mode==='stale'?'2':'1'},location:{id:'location',version:'1'},quantity:mode==='empty'?'2':mode==='insufficient'||mode==='other-location'?'-4':'-3',reason:mode==='empty-reason'?'  ':'Consumption'}};
   const result=await invoker.invokeMutation(request,identity),success=['consume','empty','hidden-positive'].includes(mode);assert.equal('result'in result,success,mode+': '+JSON.stringify(result));if(mode.endsWith('-race'))assert.ok(raced,mode);
   const all=await query({model:model('stock','Movement'),authority:'owner'}),created=all.filter(row=>row.data.source===request.operation_id);assert.equal(created.length,success?1:0,mode);assert.deepEqual(await load(model('stock','Item'),item.id),item,mode+': ledger never rewrites its Item');
   if(success){assert.equal(created[0]!.parent?.id,item.id);assert.equal(created[0]!.data.quantity,request.inputs.quantity);assert.deepEqual(created[0]!.data.location,{id:'location'});assert.deepEqual(created[0]!.data.actor,{id:user.user_id});const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay&&replay.result.status==='replayed',mode+': '+JSON.stringify(replay));assert.deepEqual(await query({model:model('stock','Movement'),authority:'owner'}),all);}
   assert.equal((await load(model('stock','Movement'),asId('foreign-location')))?.data.quantity,'100');assert.equal((await load(model('stock','Movement'),asId('foreign-item')))?.data.quantity,'100');assert.equal((await store.outboxPending()).length,0);
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('refreshes the complete original Affiliate settlement through its parent location array', {timeout:240000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-affiliate-refresh-'));
 try{
  const source=join(root,'compiler/tests/fixtures/affiliate-refresh-original.can'),original=await readFile(join(root,'draft/apps/CanAffiliate/CanAffiliate.can'),'utf8'),text=await readFile(source,'utf8');
  const start=original.indexOf('  scenario refresh_settlement('),end=original.indexOf('  scenario reconcile ',start);assert.ok(text.includes(original.slice(start,end)));
  for(const declaration of ['  invariant Partner: row.window>0m and count(row.locations)>0 and count(row.products)>0 and trim(row.agreement)!=""','  lock Settlement fields=source,account,amount,delivery'])assert.ok(text.includes(declaration));
  const{stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});const artifact=JSON.parse(stdout)as CompileArtifact,asm=await assembleModules({artifact,sourcePath:source},{workDir:directory,stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
  for(const mode of (process.env['CAN_AFFILIATE_REFRESH_CASE']??'own,finance,own-unused-archived-location,unverified,foreign,uncovered,archived,archived-parent,stale,identity-race,locations-race,parent-race').split(',')){
   const finance=['finance','uncovered','archived','archived-parent','identity-race','locations-race','parent-race'].includes(mode),{now,identities,team,user,identity,membership}=await member('affiliate-refresh-'+mode,finance?['affiliate.finance']:[],mode!=='unverified');
   const other=await identities.createUser({email:mode+'@other-affiliate.test',password_hash:'unused',email_verified:true});
   const scope={app:'CanAffiliate',owner:team.team_id,ownerPackage:'affiliate'},authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'affiliate-state',fileStoreId:'affiliate-files',receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
   const{store}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
   const row=(model:string,id:string,data:Record<string,unknown>,parent:StoredRow['parent']=null)=>({kind:'insert'as const,model:asModel(model),row:{...makeRow({id:asId(id),data}),parent}});
   const partner={window:'2592000000',name:'Original partner',account:{id:finance||mode==='foreign'?other.user_id:user.user_id},email:'partner@test.example',locations:[{id:mode==='uncovered'?'other':'location'}],products:['office'],rate:'0.1',agreement:'Original agreement',milestone:'completed',provider_account:'connected',onboarded:true,active:true};
   const settlement={last:null,account:'connected',result_revision:'0',reconcile_delivery:null,review:false,source:'original-frozen-source',amount:{minor:'100',currency:'EUR'},allocation:'pending',bank:'not_started',transfer:null,payout:null,delivery:'original-settle-delivery'};
   await store.commit(makeBatch(await store.readRevision(),{writes:[row('rent_catalog.Location','location',{active:true}),row('rent_catalog.Location','other',{active:true}),row('employee.Employee','worker',{user:{id:user.user_id},home:{id:'location'},locations:[],operator_wide:false,active:true,hidden:true}),row('affiliate.Partner','partner',partner),row('affiliate.Partner','foreign',{...partner,account:{id:other.user_id},locations:[{id:'other'}]}),row('affiliate.Settlement','settlement',settlement,{model:asModel('affiliate.Partner'),id:asId('partner')})]}));
   const query=store.query.bind(store),commit=store.commit.bind(store),load=store.load.bind(store);let raced=false,employeeQueries=0;
   if(['archived','archived-parent','own-unused-archived-location'].includes(mode)){const target=asModel(mode==='archived-parent'?'affiliate.Partner':'rent_catalog.Location'),current=await load(target,asId(mode==='archived-parent'?'partner':'location'));assert.ok(current);await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:target,id:current.id,expectedVersion:current.version,row:{...current,version:asVersion(current.version+1),archivedAt:now}}]}));}
   store.query=async spec=>{const rows=await query(spec);if(spec.model==='employee.Employee'){employeeQueries++;if(mode==='identity-race'&&!raced){raced=true;await identities.removeMembership(membership.membership_id);}}return rows;};
   store.commit=async batch=>{if(!raced&&['locations-race','parent-race'].includes(mode)&&batch.writes.some(write=>write.model==='affiliate.Settlement')){raced=true;const name=asModel(mode==='locations-race'?'affiliate.Partner':'affiliate.Settlement'),current=await load(name,asId(mode==='locations-race'?'partner':'settlement'));assert.ok(current);await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:name,id:current.id,expectedVersion:current.version,row:{...current,version:asVersion(current.version+1),...(mode==='locations-race'?{data:{...current.data,locations:[{id:'other'}]}}:{parent:{model:asModel('affiliate.Partner'),id:asId('foreign')}})}}]}));}return commit(batch);};
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now}),request={operation:'affiliate.refresh_settlement',operation_id:operationId(now),inputs:{settlement:{id:'settlement',version:mode==='stale'?'2':'1'}}},result=await invoker.invokeMutation(request,identity),success=['own','finance','own-unused-archived-location','archived'].includes(mode);assert.equal('result'in result,success,mode+': '+JSON.stringify(result));
   const updated=await load(asModel('affiliate.Settlement'),asId('settlement')),pending=await store.outboxPending();assert.ok(updated);assert.equal(pending.length,success?1:0,mode);assert.equal(updated.data.source,settlement.source);assert.equal(updated.data.delivery,settlement.delivery);assert.equal(updated.data.account,settlement.account);assert.deepEqual(updated.data.amount,settlement.amount);
   if(mode.endsWith('-race'))assert.ok(raced,mode);if(mode==='own-unused-archived-location')assert.equal(employeeQueries,0,'own verified branch never evaluates the finance location ALL');
   if(success){assert.equal(pending[0]!.target,'affiliate.CommissionV1.reconcile');assert.deepEqual((pending[0]!.arguments as{arguments:unknown}).arguments,{source:settlement.source});assert.equal(updated.data.reconcile_delivery,pending[0]!.intentId);const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay,JSON.stringify(replay));assert.deepEqual(await store.outboxPending(),pending);}
   else{assert.equal(updated.data.reconcile_delivery,null);assert.equal(updated.data.result_revision,'0');}
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('derives owner bounds from genuine State plans and rejects forged allowances', {timeout:120000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'can-owner-budget-'));
 try{
  const state=await import('@canlang/state/invocation');
  for(const profile of ['ordinary','protected']as const){
   const source=profile==='ordinary'?join(root,'compiler/tests/fixtures/native-require-missing-owner-frame.can'):fixture('invoice-collect-owner-probe.can');
   const{stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],{cwd:root,timeout:60000,maxBuffer:32*1024*1024});
   const artifact=JSON.parse(stdout)as CompileArtifact,asm=await assembleModules({artifact,sourcePath:source},{workDir:join(directory,profile),stdlibUrl:new URL('./stdlib.js',import.meta.url).href,uiUrl:import.meta.resolve('@canlang/ui')});
   const ordinary=profile==='ordinary',expected={maxRows:ordinary?200:4001,maxWork:ordinary?10000:200000};
   const variants=ordinary?[{maxRows:100,maxWork:30000},{maxRows:201,maxWork:10000},{maxRows:200,maxWork:10000,maxSourceNodes:200000,maxSourceRows:1}]:[expected,{maxRows:200,maxWork:200000},{maxRows:4001,maxWork:10000},{...expected,maxSourceNodes:200000,maxSourceRows:1}];
   for(const[variant,bounds]of variants.entries()){
    const{now,identities,identity}=await member(`owner-budget-${profile}-${variant}`,ordinary?[]:['invoice.finance']),store=createMemoryStorage(),loaded=await loadCanonicalDescriptors(asm,artifact,store);
    const operation=ordinary?'GuardOwnerFrame.run':'invoice.collect',target=asModel(ordinary?'GuardOwnerFrame.Root':'invoice.Invoice');
    await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:target,row:makeRow({id:asId('root'),data:ordinary?{capacity:'2',checked:false}:{location:{id:'location'},source:'original-source',currency:'EUR',state:'issued',total:{minor:'100',currency:'EUR'},next_collection:null,ledger_revision:'0',first_paid_at:null,hidden:false}})}]}));
    const before=await store.readRevision();let entered=false,accepted=false;
    await assert.rejects(()=>state.invoke({registry:loaded.registry as Parameters<typeof state.invoke>[0]['registry'],envelope:{operation,operation_id:operationId(now),inputs:{[ordinary?'root':'invoice']:{id:'root',version:'1'}}},identity,app:ordinary?'GuardOwnerFrame':'CanInvoice',source:'integration',store,memberships:identities,clock:{nowMs:()=>now},execute:async call=>{
      entered=true;assert.deepEqual(state.readScenarioReceiptOwnerBounds(call,store),expected);
      await state.beginScenarioReceiptMutation(call,store,{table:loaded.table as Parameters<typeof state.beginScenarioReceiptMutation>[2]['table'],bounds});
      accepted=true;throw new Error('budget session accepted; stop before business execution');
    }}),variant===0?/budget session accepted/:/owner row bound exceeds its exact saved disclosure budget/);
    assert.ok(entered);assert.equal(accepted,variant===0);assert.equal((await store.load(target,asId('root')))?.version,1);assert.equal((await store.outboxPending()).length,0);
    if(variant===0)assert.equal(await store.readRevision(),before,'accepted budget probe intentionally commits no effects');
   }
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

it('preserves unread File-array defaults through the checked owner workflow',
  { timeout: 180000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-owner-file-array-'));
    try {
      // Generic carrier qualification of the existing complete helper workflow;
      // this does not stand in for CanDesk's full original declaration closure.
      const original = await readFile(fixture('rule-owner-leading-helper-field.can'), 'utf8');
      const source = join(directory, 'LeadingHelperFieldProbe.can');
      // Scalar reuse must retain every Contract provider and its narrowed bounds.
      const adapted = original.replace('Given', 'use std {EmailV1 as Mail} from=deployment.mail\nGiven\n contract DeliveryInput {external_id:text min=1 max=1000}\n contract NoteInput {external_id:DeliveryInput.external_id min=2 max=100}')
        .replace('Handoff {ticket:Ticket}', 'Handoff {ticket:Ticket,photo:file[] max=1,external_id:NoteInput.external_id max=80}')
        .replace('policy Handoff read=members', 'policy Handoff read=members fields=ticket,external_id\n policy Handoff read=members where=actor.email_verified fields=photo')
        .replace('photo:file?=null', 'external_id:text,photo:Handoff.photo=[]')
        .replace('create Handoff {ticket}', 'create Handoff {ticket,photo,external_id}')
        .replace('   return handoff', '   send Mail.send {to=actor.email,subject="Handoff",body="Ready",attachments=handoff.photo} as delivery\n   return handoff');
      const scenario = adapted.slice(adapted.indexOf(' scenario handoff('), adapted.indexOf('Then')).trimEnd();
      const direct = scenario.replace('scenario handoff(', 'scenario handoff_direct(').replace('photo:Handoff.photo=[]', 'photo:file[]=[]');
      const text = adapted.replace('Then', `${direct}\nThen`);
      assert.ok(text.includes('require can_work(actor,ticket.location)'));
      for (const [name, rejectedSource] of [
        ['copied-created-array', text.replaceAll('   send Mail.send', '   let copied=handoff.photo\n   send Mail.send').replaceAll('attachments=handoff.photo', 'attachments=copied')],
        ['parameter-array', text.replace('Ticket {location:Location,done:bool=false}', 'Ticket {location:Location,done:bool=false,photo:file[] max=1}').replaceAll('attachments=handoff.photo', 'attachments=ticket.photo')],
        ['weaker-inherited-bound', text.replace('external_id:NoteInput.external_id max=80', 'external_id:NoteInput.external_id max=101')],
        ['require', text.replace('require can_work(actor,ticket.location)',
          'require can_work(actor,ticket.location) and count(photo)>0')],
        ['helper', text.replace('When', ' derive photo_present(value:file[]):bool = count(value)>0\nWhen')
          .replace('require can_work(actor,ticket.location)', 'require can_work(actor,ticket.location) and photo_present(photo)')],
        ['if', text.replace('  do\n   create Handoff', '  do\n   if count(photo)>0\n    require true\n   create Handoff')],
      ] as const) {
        const declined = join(directory, `file-array-read-${name}.can`);
        await writeFile(declined, rejectedSource);
        const rejected = spawnSync(compiler,
          ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, declined],
          { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
        assert.equal(rejected.error, undefined, `${name}: compiler must complete its real refusal`);
        assert.notEqual(rejected.status, 0, `${name}: checked source and inherited constraints must retain their refusal`);
        const report = JSON.parse(rejected.stdout) as { diagnostics?: { code: string }[]; artifact?: unknown; modules?: unknown };
        assert.ok(report.diagnostics?.some(item => item.code === 'E6008'), `${name}: ${rejected.stdout}`);
        assert.equal(report.artifact, undefined);
        assert.equal(report.modules, undefined, `${name}: refusal must not publish a native artifact`);
      }
      await writeFile(source, text);
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      for (const name of ['handoff', 'handoff_direct']) assert.ok(artifact.operations?.find(operation =>
        operation.name === `LeadingHelperFieldProbe.${name}`)?.result?.disclosure, `${name} stays native`);
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
        stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
      for (const mode of ['default', 'empty', 'nonempty', 'direct-nonempty', 'oversize', 'foreign-file', 'unissued-file',
        'missing-producer', 'not-array', 'short-id', 'long-id', 'file-field-denied', 'file-during-send', 'inactive-helper', 'helper-at-commit'] as const) {
        const { now, identities, identity, user, team } = await member(`file-array-${mode}`, [], mode !== 'file-field-denied');
        const app = 'LeadingHelperFieldProbe';
        const scope = { app, owner: team.team_id, ownerPackage: app };
        const authority: FileRetirementAuthority = { app, stateOwner: app, stateStoreId: 'array-state', fileStoreId: 'array-files',
          receiver: { app, owner: team.team_id, team: team.team_id } };
        const { store } = createTestMemoryStorage(authority, [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({ artifact, asm, store, authority, scope, now: () => now,
          verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
        const row = (id: string, data: Record<string, unknown>) => ({ ...makeRow({ id: asId(id), data }), parent: null });
        const ticket = row('ticket', { location: { id: 'location' }, done: false });
        const employee = row('worker', { user: { id: user.user_id }, home: { id: 'location' }, locations: [], operator_wide: false, active: mode !== 'inactive-helper', hidden: true });
        await store.commit(makeBatch(await store.readRevision(), { writes: [
          { kind: 'insert', model: model(app, 'Location'), row: row('location', { label: 'Home' }) },
          { kind: 'insert', model: model(app, 'Employee'), row: employee },
          { kind: 'insert', model: model(app, 'Ticket'), row: ticket },
        ] }));
        const clock = new TestOnlyManualClock(now), blobs = new TestOnlyMemoryBlobStore();
        const files = new TestOnlyMemoryFinalizedStore(), intents = new TestOnlyMemoryIntentStore();
        const physical = { clock, blobs, files,
          upload: { clock, intents, blobs, policy: DEFAULT_FILE_POLICY, intentIds: new TestOnlyCounterIntentIds(),
            intentTtlMs: 3600000, urlBase: 'https://file-array.test' },
          finalize: { clock, intents, blobs, files, fileIds: new TestOnlyCounterFileIds() } };
        const retention = { unattachedHorizonMs: 3600000, retentionMs: 86400000 };
        const observation = { policy: physical.upload.policy, retention };
        const kernel = createFileJourneyKernel({ maxBytes: physical.upload.policy.maxBytes,
          createIntent: input => createUploadIntent(physical.upload, input),
          append: (id, caller, bytes, offset) => appendUploadContentAtOffset(physical.upload, id, caller, bytes, offset),
          complete: (id, caller) => completeUploadContent(physical.upload, id, caller),
          finalize: input => finalizeUpload(physical.finalize, input),
          authorizeAttach: (ref, caller) => authorizeAttach(physical.finalize, ref, caller),
          readProvenance: (ref, caller) => readFinalizedFile(physical.finalize, ref, caller),
          recordAttachment: (ref, record, caller) => recordAttachment(physical.finalize, ref, record, caller),
          readBytes: (ref, caller) => readFinalizedBytes(physical.finalize, ref, caller),
          readCurrentBytes: (ref, caller, policy) => readCurrentFinalizedBytes(physical.finalize, ref, caller, { ...observation, retention: policy }),
          readCurrentSnapshot: (ref, caller, policy) => readCurrentFinalizedSnapshot(physical.finalize, ref, caller, { ...observation, retention: policy }),
          observeFile: (ref, caller, policy) => observeFinalizedFile(physical.finalize, ref, caller, { ...observation, retention: policy }),
          revalidateFile: (saved, caller, policy) => revalidateRetainedFinalizedFile(physical.finalize, saved, caller, { ...observation, retention: policy }),
        } satisfies FileJourneyBindings);
        const receiver = { app, owner: team.team_id, team: team.team_id, principal: mode === 'foreign-file' ? 'foreign-principal' : user.user_id };
        const bytes = new TextEncoder().encode('Private attachment content must not enter a guard result');
        const created = createUploadIntent(physical.upload, { receiver,
          binding: { adapter: 'deployment.web', deliveryId: 'attachment', resultPath: 'photo' },
          request: { upload_id: 'attachment', operation: `${app}.handoff`, field: '/photo/0', arguments: {},
            name: 'note.txt', type: 'text/plain', size: String(bytes.length) } });
        assert.ok(created.status === 'granted');
        assert.equal(appendUploadContentAtOffset(physical.upload, created.intentId, receiver, bytes, 0).status, 'appended');
        assert.equal(completeUploadContent(physical.upload, created.intentId, receiver).status, 'completed');
        const finalized = finalizeUpload(physical.finalize, { intentId: created.intentId, retryId: 'attachment', bytesDigest: sha256Hex(bytes), caller: receiver });
        assert.ok(finalized.status === 'finalized');
        let raced = false;
        const commit = store.commit.bind(store);
        store.commit = async batch => {
          if (mode === 'helper-at-commit' && !raced && batch.writes.some(write => write.model === `${app}.Handoff`)) {
            raced = true;
            await commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update', model: model(app, 'Employee'),
              id: employee.id, expectedVersion: employee.version,
              row: { ...employee, version: asVersion(employee.version + 1), data: { ...employee.data, active: false } } }] }));
          }
          return commit(batch);
        };
        const load = store.load.bind(store);
        store.load = async (model, id) => {
          if (mode === 'file-during-send' && !raced && model === 'work.dispatch') {
            raced = true;
            assert.ok(blobs.read(blobKeyForFile(finalized.result.file)));
            blobs.remove(blobKeyForFile(finalized.result.file));
          }
          return load(model, id);
        };
        const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now,
          ...(mode === 'missing-producer' ? {} : { files: createCanonicalFileBinding(kernel, retention) }) });
        const photo = mode === 'unissued-file' ? [{ id: 'unissued' }] : mode === 'not-array' ? { id: finalized.result.file } :
          mode === 'empty' ? [] : mode === 'oversize' ? [{ id: finalized.result.file }, { id: finalized.result.file }] : [{ id: finalized.result.file }];
        const request = { operation: `${app}.${mode === 'direct-nonempty' ? 'handoff_direct' : 'handoff'}`, operation_id: operationId(now),
          inputs: { ticket: { id: 'ticket', version: '1' },
            external_id: mode === 'short-id' ? 'x' : mode === 'long-id' ? 'x'.repeat(81) : 'note-identity',
            ...(mode === 'default' ? {} : { photo }) } };
        const result = await invoker.invokeMutation(request, identity);
        const success = ['default', 'empty', 'nonempty', 'direct-nonempty'].includes(mode);
        assert.equal('result' in result, success, `${mode}: ${JSON.stringify(result)}`);
        assert.equal(JSON.stringify(result).includes(new TextDecoder().decode(bytes)), false);
        const repairs = await store.query({ model: model(app, 'Handoff'), authority: 'owner' });
        assert.equal(repairs.length, success ? 1 : 0, mode);
        const current = await store.load(model(app, 'Ticket'), ticket.id); assert.ok(current);
        const pending = await store.outboxPending();
        assert.equal(pending.length, success ? 1 : 0, `${mode}: SEND is atomic with its owning CREATE/SET`);
        if (success) {
          assert.deepEqual(repairs[0]!.data.photo, mode.endsWith('nonempty') ? [{ id: finalized.result.file }] : []);
          assert.equal(repairs[0]!.data.external_id, 'note-identity');
          assert.equal(pending[0]!.target, 'std.EmailV1.send');
          assert.deepEqual(pending[0]!.arguments, { binding: `${app}.Mail`, from: 'deployment.mail', arguments: {
            to: user.email, subject: 'Handoff', body: 'Ready', attachments: repairs[0]!.data.photo } });
          assert.equal(current.data.done, true);
          assert.deepEqual(repairs[0]!.data.ticket, { id: ticket.id });
          const revision = await store.readRevision();
          const replay = await invoker.invokeMutation(request, identity);
          assert.ok('result' in replay && replay.result.status === 'replayed', `${mode}: ${JSON.stringify(replay)}`);
          assert.equal(await store.readRevision(), revision);
          assert.deepEqual(await store.outboxPending(), pending, `${mode}: replay cannot duplicate SEND`);
          assert.deepEqual(await store.query({ model: model(app, 'Handoff'), authority: 'owner' }), repairs);
        } else {
          assert.deepEqual(current, ticket, `${mode}: no partial parent mutation`);
          assert.ok('error' in result);
          if (mode === 'file-field-denied') assert.equal(result.error.code, 'forbidden');
          if (mode === 'file-during-send') assert.equal(result.error.code, 'validation', JSON.stringify(result));
          if (mode === 'inactive-helper' || mode === 'helper-at-commit') assert.equal(result.error.code, 'rule_failed');
          if (mode === 'oversize' || mode === 'not-array' || mode === 'short-id' || mode === 'long-id') assert.equal(result.error.code, 'validation');
        }
        assert.equal(raced, mode === 'helper-at-commit' || mode === 'file-during-send');
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('reports exhausted decision inventories at their source site while preserving admitted observers',
  { timeout: 180000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-decision-inventory-'));
    try {
      const original = await readFile(join(root, 'compiler/tests/fixtures/helper-reference-identity.can'), 'utf8');
      const nested = original.replace('derive allowed(booking:Booking):bool=booking.visible',
        'derive allow_customer(customer:Customer):bool=customer.active\n  derive allowed(booking:Booking):bool=allow_customer(booking.customer)');
      const queried = nested.replace('export Customer {active:bool=true}',
        'export Customer {active:bool=true}\n  export Seat in Customer {active:bool=true}')
        .replace('policy Customer read=', 'policy Seat read=members\n  policy Customer read=')
        .replace('derive allow_customer(customer:Customer):bool=customer.active',
          'derive allow_customer(customer:Customer):bool=customer.active and any(customer.Seat as seat,seat.active)');
      const balanced = (terms: readonly string[]): string => {
        if (terms.length === 1) return terms[0]!;
        const half = Math.floor(terms.length / 2);
        return `(${balanced(terms.slice(0, half))} and ${balanced(terms.slice(half))})`;
      };
      const source = join(directory, 'Helper.can');
      // Distinct authored call sites retain the 200-site bound, even when
      // shared helper bodies are represented once in the source inventory.
      const overflow = queried.replace('require allowed(booking)', `require ${balanced([
        'allowed(booking)', ...Array<string>(201).fill('trim("yes")=="yes"'),
      ])}`);
      await writeFile(source, overflow);
      const refused = spawnSync(compiler, ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, encoding: 'utf8', timeout: 60000 });
      assert.equal(refused.error, undefined);
      assert.equal(refused.status, 10);
      const report = JSON.parse(refused.stdout) as { diagnostics: { code: string; message: string;
        related: { start?: number; end?: number; message: string }[] }[]; artifact?: unknown; modules?: unknown };
      const failure = report.diagnostics.find(item => item.code === 'E6008' &&
        item.message.includes('scenario decision inventory exceeds 200 selected calls'));
      assert.ok(failure, refused.stdout);
      const condition = failure.related.find(item => item.message.includes('200 selected calls'));
      assert.ok(condition?.start !== undefined && condition.end !== undefined);
      assert.equal(Buffer.from(overflow).subarray(condition.start, condition.end).toString().trim(),
        overflow.split('   require ')[1]!.split('\n')[0]);
      assert.equal(report.artifact, undefined); assert.equal(report.modules, undefined);

      const earlierResult = overflow.slice(0, overflow.indexOf('   do\n')) + '   do return attachment\n Then\n';
      await writeFile(source, earlierResult.replace('scenario prepare(booking:Booking)',
        'scenario prepare(booking:Booking,attachment:file) -> file'));
      const earlier = spawnSync(compiler, ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, encoding: 'utf8', timeout: 60000 });
      assert.equal(earlier.status, 10);
      assert.ok(earlier.stdout.includes('unsupported result shape'), earlier.stdout);
      assert.equal(earlier.stdout.includes('scenario decision inventory exceeds'), false,
        'an unrelated earlier result refusal keeps its diagnostic precedence');

      // Exhaustion is diagnostic detail on an already-declined closure. A
      // larger ordinary expression that already emits remains supported.
      const membershipNested = nested
        .replace('derive allow_customer(customer:Customer):bool=customer.active',
          'derive allow_customer(customer:Customer,person:user):bool=customer.active and active_member(person,team)')
        .replace('derive allowed(booking:Booking):bool=allow_customer(booking.customer)',
          'derive allowed(booking:Booking,person:user):bool=allow_customer(booking.customer,person)');
      await writeFile(source, membershipNested.replace('require allowed(booking)',
        `require ${balanced(Array<string>(101).fill('allowed(booking,actor)'))}`));
      const ordinary = spawnSync(compiler, ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, encoding: 'utf8', timeout: 60000 });
      assert.equal(ordinary.status, 0, ordinary.stdout + ordinary.stderr);

      const ordinaryArtifact = JSON.parse(ordinary.stdout) as CompileArtifact;
      const compactAsm = await assembleModules({ artifact: ordinaryArtifact, sourcePath: source }, { workDir: join(directory, 'compact'),
        stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
      // The shared helper retains every ordered expansion and original call
      // index. Compact metadata shares only immutable definition data.
      const plans: unknown[] = [];
      for (const url of Object.values(compactAsm.moduleUrls)) {
        const emitted = await import(url) as { canMembershipSources?: () => Record<string, unknown> };
        if (emitted.canMembershipSources) plans.push(...Object.values(emitted.canMembershipSources()));
      }
      const compact = plans.find(value => typeof value === 'object' && value !== null &&
        (value as { version?: number }).version === 2) as {
          version: number; definitions: { chain: unknown[]; target: { kind: string }; slots: unknown[] }[];
          frames: [number, number | null][]; sites: { calls: [number, number | null][] }[];
        } | undefined;
      assert.ok(compact, 'repeated source helpers use the lossless compact transport');
      const expanded = checkScenarioReceiptMembershipSites(compact);
      assert.ok(expanded.reduce((sum, site) => sum + site.calls.length, 0) > 200);
      assert.equal(checkScenarioReceiptMembershipSites(expanded), expanded, 'only immutable validated plans reuse validation');
      assert.deepEqual(checkScenarioReceiptMembershipSites(expanded.filter(() => true)), expanded);
      assert.throws(() => checkScenarioReceiptMembershipSites([expanded[0], expanded[0]]), /Membership recipe:/);
      assert.ok(Object.isFrozen(expanded) && Object.isFrozen(expanded[0]!.calls));
      for (const corrupt of [
        (plan: typeof compact) => { plan!.sites[0]!.calls[0]![0] = plan!.definitions.length; },
        (plan: typeof compact) => { plan!.frames[0]![1] = 0; },
        (plan: typeof compact) => { plan!.definitions[0]!.slots = [999]; },
        (plan: typeof compact) => { plan!.definitions.push(...Array(201).fill(plan!.definitions[0]!)); },
      ]) {
        const forged = JSON.parse(JSON.stringify(compact)) as typeof compact;
        corrupt(forged);
        assert.throws(() => checkScenarioReceiptMembershipSites(forged), /Membership recipe:/);
      }
      // Exercise the nested query observer through real State admission,
      // query execution, revision fencing and receipt replay.
      const small = queried.slice(0, queried.indexOf('   do\n')) + '   do set booking {checked=true}\n Then\n';
      await writeFile(source, small);
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
        stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
      for (const mode of ['allowed', 'hidden-source', 'nonmember', 'inactive-target', 'missing-seat', 'seat-at-commit'] as const) {
        const { now, identities, identity, membership } = await member(`inventory-${mode}`);
        const { store } = createTestMemoryStorage();
        const bookingModel = asModel('worker.Booking'), seatModel = asModel('api.Seat');
        const booking = makeRow({ id: asId('booking'), data: { customer: { id: 'customer' }, visible: true,
          permitted: mode !== 'hidden-source', last: null, checked: false } });
        const seat = { ...makeRow({ id: asId('seat'), data: { active: true } }), parent: { model: asModel('api.Customer'), id: asId('customer') } };
        await store.commit(makeBatch(await store.readRevision(), { writes: [
          { kind: 'insert', model: asModel('api.Customer'), row: makeRow({ id: asId('customer'), data: { active: mode !== 'inactive-target' } }) },
          { kind: 'insert', model: bookingModel, row: booking },
          ...(mode === 'missing-seat' ? [] : [{ kind: 'insert' as const, model: seatModel, row: seat }]),
        ] }));
        const commit = store.commit.bind(store); let raced = false;
        store.commit = async batch => {
          if (mode === 'seat-at-commit' && !raced && batch.writes.some(write => write.model === bookingModel)) {
            raced = true;
            await commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update', model: seatModel,
              id: seat.id, expectedVersion: seat.version, row: { ...seat, version: asVersion(seat.version + 1), data: { active: false } } }] }));
          }
          return commit(batch);
        };
        if (mode === 'nonmember') await identities.removeMembership(membership.membership_id);
        const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
        const request = { operation: 'worker.prepare', operation_id: operationId(now), inputs: { booking: { id: booking.id, version: '1' } } };
        const result = await invoker.invokeMutation(request, identity);
        const success = mode === 'allowed' || mode === 'hidden-source';
        assert.equal('result' in result, success, `${mode}: ${JSON.stringify(result)}`);
        const current = await store.load(bookingModel, booking.id); assert.ok(current);
        assert.equal(current.data.checked, success);
        assert.equal((await store.outboxPending()).length, 0);
        assert.equal(raced, mode === 'seat-at-commit');
        if (success) {
          assert.ok('result' in result); assert.deepEqual(result.result.records, []);
          const revision = await store.readRevision();
          const replay = await invoker.invokeMutation(request, identity);
          assert.ok('result' in replay && replay.result.status === 'replayed', JSON.stringify(replay));
          assert.equal(await store.readRevision(), revision);
          assert.deepEqual(await store.load(bookingModel, booking.id), current);
        }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

it('retains the nullable stored DATA read after an original null guard', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-null-guard-copy-'));
  try {
    const original = await readFile(fixture('rule-owner-leading-helper-field.can'), 'utf8');
    const text = original.replace('Ticket {location:Location,done:bool=false}',
      'Ticket {location:Location,done:bool=false,order:text?,order_visible:bool=true}')
      .replace('Handoff {ticket:Ticket}', 'Handoff {ticket:Ticket,order:text?}')
      .replace('policy Ticket read=members',
        'policy Ticket read=members fields=location,done,order_visible\n policy Ticket read=members where=row.order_visible fields=order')
      .replace('require can_work(actor,ticket.location)', 'require can_work(actor,ticket.location) and ticket.order==null')
      .replace('create Handoff {ticket}', 'create Handoff {ticket,order=ticket.order}');
    const source = join(directory, 'NullGuardCopy.can'); await writeFile(source, text);
    const { stdout } = await promisify(execFile)(compiler,
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    const disclosure = artifact.operations?.find(operation => operation.name === 'LeadingHelperFieldProbe.handoff')?.result?.disclosure;
    assert.ok(disclosure, 'the complete checked owner retains its native receipt');
    assert.ok(disclosure.returns.some(returned => returned.dependencies.some(dependency =>
      dependency.model === 'LeadingHelperFieldProbe.Ticket' && dependency.field === 'order' && dependency.type === 'text?' && dependency.role === 'data')),
    'known-null use still requires the original declared nullable DATA field');
    const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
      stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
    for (const mode of ['allowed', 'nonnull', 'withheld-field', 'grant-at-commit', 'value-at-commit', 'inactive-helper', 'nonmember', 'stale'] as const) {
      const { now, identities, identity, membership, user } = await member(`null-copy-${mode}`);
      const { store } = createTestMemoryStorage(); const app = 'LeadingHelperFieldProbe';
      const ticketModel = model(app, 'Ticket'), handoffModel = model(app, 'Handoff');
      const row = (id: string, data: Record<string, unknown>) => ({ ...makeRow({ id: asId(id), data }), parent: null });
      const ticket = row('ticket', { location: { id: 'location' }, done: false,
        order: mode === 'nonnull' ? 'purchase-order' : null, order_visible: mode !== 'withheld-field' });
      await store.commit(makeBatch(await store.readRevision(), { writes: [
        { kind: 'insert', model: model(app, 'Location'), row: row('location', { label: 'Home' }) },
        { kind: 'insert', model: model(app, 'Employee'), row: row('worker', { user: { id: user.user_id }, home: { id: 'location' },
          locations: [], operator_wide: false, active: mode !== 'inactive-helper', hidden: true }) },
        { kind: 'insert', model: ticketModel, row: ticket },
      ] }));
      const commit = store.commit.bind(store); let raced = false;
      store.commit = async batch => {
        if ((mode === 'grant-at-commit' || mode === 'value-at-commit') && !raced && batch.writes.some(write => write.model === handoffModel)) {
          raced = true;
          await commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update', model: ticketModel,
            id: ticket.id, expectedVersion: ticket.version, row: { ...ticket, version: asVersion(ticket.version + 1),
              data: { ...ticket.data, ...(mode === 'grant-at-commit' ? { order_visible: false } : { order: 'competing-order' }) } } }] }));
        }
        return commit(batch);
      };
      if (mode === 'nonmember') await identities.removeMembership(membership.membership_id);
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const request = { operation: `${app}.handoff`, operation_id: operationId(now),
        inputs: { ticket: { id: ticket.id, version: mode === 'stale' ? '2' : '1' } } };
      const result = await invoker.invokeMutation(request, identity), success = mode === 'allowed';
      assert.equal('result' in result, success, `${mode}: ${JSON.stringify(result)}`);
      const copies = await store.query({ model: handoffModel, authority: 'owner' });
      assert.equal(copies.length, success ? 1 : 0, mode);
      const current = await store.load(ticketModel, ticket.id); assert.ok(current);
      assert.equal(current.data.done, success, `${mode}: failed DATA cannot leave the parent SET`);
      assert.equal(current.data.order, mode === 'value-at-commit' ? 'competing-order' : ticket.data.order);
      assert.equal(raced, mode === 'grant-at-commit' || mode === 'value-at-commit');
      assert.equal((await store.outboxPending()).length, 0);
      if (success) {
        assert.equal(copies[0]!.data.order, null);
        const revision = await store.readRevision();
        const replay = await invoker.invokeMutation(request, identity);
        assert.ok('result' in replay && replay.result.status === 'replayed', JSON.stringify(replay));
        assert.equal(await store.readRevision(), revision);
        assert.deepEqual(await store.query({ model: handoffModel, authority: 'owner' }), copies);
      } else {
        assert.ok('error' in result);
        if (mode === 'withheld-field') assert.equal(result.error.code, 'forbidden');
        if (mode === 'nonnull' || mode === 'inactive-helper') assert.equal(result.error.code, 'rule_failed');
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});


it('compiles original Stock and executes its reversal guard with checked actor shorthand', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-stock-reverse-original-'));
  try {
    const source = join(root, 'draft/apps/CanStock/CanStock.can');
    const { stdout } = await promisify(execFile)(compiler,
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source,
        join(root, 'draft/shared/Employees.can'), join(root, 'draft/shared/Locations.can')],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const originalArtifact = JSON.parse(stdout) as CompileArtifact;
    assert.ok(originalArtifact.operations?.find(operation => operation.name === 'stock.reverse')?.result?.disclosure);
    // Full original assembly is independently blocked by Threshold.location's
    // unique-field association. Qualify the exact reversal guard/body on the
    // existing selected Stock ledger recipient without claiming full installation.
    const original = await readFile(source, 'utf8');
    const start = original.indexOf('  scenario reverse(');
    const end = original.indexOf('  # Persist authenticated', start);
    assert.ok(start >= 0 && end > start);
    const selected = await readFile(join(root, 'compiler/tests/fixtures/stock-adjust-original.can'), 'utf8');
    const tail = selected.lastIndexOf(' Then'); assert.ok(tail > 0);
    const runtimeSource = join(directory, 'StockReverse.can');
    await writeFile(runtimeSource, selected.slice(0, tail) + original.slice(start, end) + selected.slice(tail));
    const compiled = await promisify(execFile)(compiler,
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, runtimeSource],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(compiled.stdout) as CompileArtifact;
    assert.ok(artifact.operations?.find(operation => operation.name === 'stock.reverse')?.result?.disclosure);
    const asm = await assembleModules({ artifact, sourcePath: runtimeSource }, { workDir: directory,
      stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
    for (const mode of ['allowed', 'ordered', 'inactive', 'wrong-location', 'no-role', 'nonmember', 'stale', 'empty-reason', 'commit-race'] as const) {
      const { now, identities, identity, team, user, membership } = await member(`stock-reverse-${mode}`,
        mode === 'no-role' ? [] : ['stock.stock_staff']);
      const scope = { app: 'CanStock', owner: team.team_id, ownerPackage: 'stock' };
      const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app,
        stateStoreId: 'stock-state', fileStoreId: 'stock-files',
        receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
      const { store } = createTestMemoryStorage(authority, [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
      await installNativeFileInventory({ artifact, asm, store, authority, scope, now: () => now,
        verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
      const row = (id: string, data: Record<string, unknown>, parent: StoredRow['parent'] = null) =>
        ({ ...makeRow({ id: asId(id), data }), parent });
      const movementModel = model('stock', 'Movement');
      const movement = row('opening', { visible: true, location: { id: 'location' }, quantity: '3', reason: 'Initial count',
        source: 'opening', transfer: null, reversal: null, order: mode === 'ordered' ? 'purchase-order' : null,
        actor: null, revision: null, unit: null }, { model: model('stock', 'Item'), id: asId('item') });
      await store.commit(makeBatch(await store.readRevision(), { writes: [
        { kind: 'insert', model: model('rent_catalog', 'Location'), row: row('location', {
          name: 'Original location', active: true }) },
        { kind: 'insert', model: model('employee', 'Employee'), row: row('worker', {
          user: { id: user.user_id }, home: { id: mode === 'wrong-location' ? 'other' : 'location' },
          locations: [], operator_wide: false, active: mode !== 'inactive',
          role: 'Stock', skills: [], visible: true, user_visible: true }) },
        { kind: 'insert', model: model('stock', 'Item'), row: row('item', {
          sku: 'coffee', name: 'Coffee', unit: 'box', reorder: '0', active: true }) },
        { kind: 'insert', model: movementModel, row: movement },
      ] }));
      const commit = store.commit.bind(store); let raced = false;
      store.commit = async batch => {
        if (mode === 'commit-race' && !raced && batch.writes.some(write => write.model === movementModel && write.kind === 'insert')) {
          raced = true;
          await commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: movementModel,
            row: { ...movement, id: asId('competing-reversal'), data: { ...movement.data,
              quantity: '-3', source: 'competing-reversal', reversal: { id: movement.id }, actor: { id: user.user_id } } } }] }));
        }
        return commit(batch);
      };
      if (mode === 'nonmember') await identities.removeMembership(membership.membership_id);
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const request = { operation: 'stock.reverse', operation_id: operationId(now), inputs: {
        movement: { id: movement.id, version: mode === 'stale' ? '2' : '1' }, reason: mode === 'empty-reason' ? ' ' : 'Reverse count' } };
      const outcome = await invoker.invokeMutation(request, identity), success = mode === 'allowed';
      assert.equal('result' in outcome, success, `${mode}: ${JSON.stringify(outcome)}`);
      const movements = await store.query({ model: movementModel, authority: 'owner' });
      const created = movements.filter(value => value.data.source === request.operation_id);
      assert.equal(created.length, success ? 1 : 0, mode);
      assert.equal(raced, mode === 'commit-race');
      assert.equal((await store.outboxPending()).length, 0);
      if (success) {
        assert.deepEqual(created[0]!.data.actor, { id: user.user_id });
        assert.equal(created[0]!.data.quantity, '-3');
        assert.equal(created[0]!.data.order, null);
        assert.deepEqual(created[0]!.data.reversal, { id: movement.id });
        assert.deepEqual(created[0]!.parent, movement.parent);
        const revision = await store.readRevision();
        const replay = await invoker.invokeMutation(request, identity);
        assert.ok('result' in replay && replay.result.status === 'replayed', JSON.stringify(replay));
        assert.equal(await store.readRevision(), revision);
        assert.deepEqual(await store.query({ model: movementModel, authority: 'owner' }), movements);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});


it('retains calendar DATA and Values failures through native receipt execution', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-calendar-receipt-'));
  try {
    const original = await readFile(fixture('rule-owner-leading-helper-field.can'), 'utf8');
    const text = original.replace('Ticket {location:Location,done:bool=false}',
      'Ticket {location:Location,done:bool=false,anchor:date,months:int,zone:timezone,wall:text,calendar_visible:bool=true}')
      .replace('Handoff {ticket:Ticket}', 'Handoff {ticket:Ticket,due:datetime,shifted:date,day:int,overlap:bool,local:date}')
      .replace('policy Ticket read=members',
        'policy Ticket read=members fields=location,done,calendar_visible\n policy Ticket read=members where=row.calendar_visible fields=anchor,months,zone,wall')
      .replace('photo:file?=null', 'fold:enum(earlier,later)')
      .replace('require can_work(actor,ticket.location)', 'require not ticket.done')
      .replace('create Handoff {ticket}',
        'create Handoff {ticket,due=local_instant(zone=ticket.zone,time=ticket.wall,date=add_months(ticket.anchor,ticket.months),fold=fold),shifted=add_days(ticket.anchor,1),day=weekday(ticket.anchor),overlap=overlaps(ticket.anchor,add_days(ticket.anchor,2),ticket.anchor,add_days(ticket.anchor,1)),local=local_date(zone=ticket.zone,value=now)}');
    const source = join(directory, 'CalendarReceipt.can'); await writeFile(source, text);
    const { stdout } = await promisify(execFile)(compiler,
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    const disclosure = artifact.operations?.find(operation => operation.name === 'LeadingHelperFieldProbe.handoff')?.result?.disclosure;
    assert.ok(disclosure, 'calendar values retain the complete owner receipt');
    for (const field of ['anchor', 'months', 'zone', 'wall']) assert.ok(disclosure.returns.some(returned =>
      returned.dependencies.some(dependency => dependency.model === 'LeadingHelperFieldProbe.Ticket' &&
        dependency.field === field && dependency.role === 'data')), field);
    const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
      stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
    for (const mode of ['month-end', 'fold-earlier', 'fold-later', 'gap', 'withheld', 'done', 'nonmember', 'commit-race'] as const) {
      const { now, identities, identity, membership, user } = await member(`calendar-receipt-${mode}`);
      const { store } = createTestMemoryStorage(); const app = 'LeadingHelperFieldProbe';
      const ticketModel = model(app, 'Ticket'), handoffModel = model(app, 'Handoff');
      const row = (id: string, data: Record<string, unknown>) => ({ ...makeRow({ id: asId(id), data }), parent: null });
      const anchor = mode.startsWith('fold-') ? '2026-09-25' : mode === 'gap' ? '2026-01-29' : '2026-01-31';
      const ticket = row('ticket', { location: { id: 'location' }, done: mode === 'done',
        anchor, months: mode === 'gap' ? '2' : '1', zone: mode.startsWith('fold-') || mode === 'gap' ? 'Europe/Amsterdam' : 'UTC',
        wall: mode.startsWith('fold-') || mode === 'gap' ? '02:30' : '12:00', calendar_visible: mode !== 'withheld' });
      await store.commit(makeBatch(await store.readRevision(), { writes: [
        { kind: 'insert', model: model(app, 'Location'), row: row('location', { label: 'Home' }) },
        { kind: 'insert', model: model(app, 'Employee'), row: row('worker', { user: { id: user.user_id }, home: { id: 'location' },
          locations: [], operator_wide: false, active: true, hidden: true }) },
        { kind: 'insert', model: ticketModel, row: ticket },
      ] }));
      const commit = store.commit.bind(store); let raced = false;
      store.commit = async batch => {
        if (mode === 'commit-race' && !raced && batch.writes.some(write => write.model === handoffModel)) {
          raced = true;
          await commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update', model: ticketModel,
            id: ticket.id, expectedVersion: ticket.version, row: { ...ticket, version: asVersion(ticket.version + 1),
              data: { ...ticket.data, calendar_visible: false } } }] }));
        }
        return commit(batch);
      };
      if (mode === 'nonmember') await identities.removeMembership(membership.membership_id);
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const request = { operation: `${app}.handoff`, operation_id: operationId(now), inputs: {
        ticket: { id: ticket.id, version: '1' }, fold: mode === 'fold-later' ? 'later' : 'earlier' } };
      const result = await invoker.invokeMutation(request, identity);
      if (mode === 'gap') {
        assert.ok('error' in result);
        assert.equal(result.error.code, 'rule_failed');
        assert.match(result.error.message, /DST gap/);
      }
      const success = ['month-end', 'fold-earlier', 'fold-later'].includes(mode);
      assert.equal('result' in result, success, `${mode}: ${JSON.stringify(result)}`);
      const copies = await store.query({ model: handoffModel, authority: 'owner' });
      assert.equal(copies.length, success ? 1 : 0, mode);
      assert.equal((await store.load(ticketModel, ticket.id))?.data.done, success || mode === 'done');
      assert.equal(raced, mode === 'commit-race');
      assert.equal((await store.outboxPending()).length, 0);
      if (success) {
        assert.equal(copies[0]!.data.due, mode === 'month-end' ? '2026-02-28T12:00:00.000Z' :
          mode === 'fold-earlier' ? '2026-10-25T00:30:00.000Z' : '2026-10-25T01:30:00.000Z');
        assert.equal(copies[0]!.data.shifted, mode === 'month-end' ? '2026-02-01' : '2026-09-26');
        assert.equal(copies[0]!.data.day, mode === 'month-end' ? '6' : '5');
        assert.equal(copies[0]!.data.overlap, true);
        if (mode === 'month-end') assert.equal(copies[0]!.data.local, new Date(now).toISOString().slice(0, 10));
        const revision = await store.readRevision();
        const replay = await invoker.invokeMutation(request, identity);
        assert.ok('result' in replay && replay.result.status === 'replayed', JSON.stringify(replay));
        assert.equal(await store.readRevision(), revision);
        assert.deepEqual(await store.query({ model: handoffModel, authority: 'owner' }), copies);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});


it('captures computed scalar DATA at its original LET checkpoint', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-computed-let-data-'));
  try {
    const scenario = (name: string, prefix: boolean, lazy = false) => `
  scenario ${name}(root:Root,months:int=1) by=members
   require allowed(root)
   do
${prefix ? '    set root {anchor=date("2026-01-31")}\n' : ''}${lazy ? '    let unused=root.visible or root.label==""\n' : ''}    let due=local_instant(add_months(root.anchor,months),"02:30",root.location.zone,fold=earlier)
    set root {anchor=date("2026-02-01"),done=true}
    create Evidence {due} as evidence
    for child in root.Child as item limit=2
     set child {done=true}
    emit Captured {label=${lazy ? '"Original label"' : 'root.label'}}
    send Port.submit {value=due,label=${lazy ? '"Original label"' : 'root.label'}} as delivery
`;
    const text = `app ComputedData uses=[worker]
package api
 Given
  export capability PortV1 version=1
   submit(value:datetime,label:text) -> text
 When
 Then
package worker
 use api {PortV1 as Port} from=deployment.port
 Given
  Location {zone:timezone,visible:bool=true}
  Root {anchor:date,location:Location,visible:bool=true,calendar_visible:bool=true,label:text,label_visible:bool=true,done:bool=false}
  Employee {user:user,home:Location,active:bool=true}
  Evidence {due:datetime}
  event Captured {label:text}
  Child in Root {done:bool=false}
  policy Child read=members
  policy Root read=members fields=visible
  policy Root read=members and row.calendar_visible fields=anchor,location
  policy Root read=members and row.label_visible fields=label
  policy Location read=members and row.visible
  policy Evidence read=members
  derive allowed(root:Root):bool=root.visible and any(Employee as e,e.user==actor and e.active and e.home==root.location)
 When
${scenario('capture', false)}${scenario('prefix', true)}${scenario('lazy', false, true)} Then
`;
    const source = join(directory, 'ComputedData.can'); await writeFile(source, text);
    const { stdout } = await promisify(execFile)(compiler,
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    assert.ok(artifact.modules.some(module => module.js.includes('canScenarioLetDataSources')),
      'execute the new source-bound computation, rather than an ordinary result receipt');
    for (const issuer of ['canScenarioSendDataSource', 'canScenarioEmitDataSource']) assert.ok(artifact.modules.some(module => module.js.includes(issuer)), issuer);
    const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
      stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
    for (const mode of ['allowed', 'prefix', 'lazy', 'overflow-order', 'withheld', 'label-withheld', 'path-withheld', 'false-prefix', 'inactive', 'nonmember', 'grant-race', 'identity-race', 'gap'] as const) {
      const { now, identities, identity, membership, user, team } = await member(`computed-let-${mode}`);
      const scope = { app: 'ComputedData', owner: team.team_id, ownerPackage: 'worker' };
      const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app, stateStoreId: 'computed-data-state', fileStoreId: 'computed-data-files', receiver: { app: scope.app, owner: scope.owner, team: scope.owner } };
      const { store } = createTestMemoryStorage(authority, [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
      await installNativeFileInventory({ artifact, asm, store, authority, scope, now: () => now, verifyOwner: async () => { assert.ok(await identities.findTeamById(scope.owner)); } });
      const rootModel = model('worker', 'Root'), evidenceModel = model('worker', 'Evidence');
      const row = (id: string, data: Record<string, unknown>) => ({ ...makeRow({ id: asId(id), data }), parent: null });
      const original = row('root', { anchor: mode === 'prefix' ? '2025-12-31' : mode === 'gap' ? '2026-01-29' : mode === 'overflow-order' ? '9999-12-31' : '2026-01-31',
        location: { id: 'location' }, visible: mode !== 'false-prefix', calendar_visible: !['withheld', 'false-prefix'].includes(mode), label: 'Original label', label_visible: !['label-withheld', 'lazy'].includes(mode), done: false });
      // January 29 plus two months reaches Amsterdam's missing March 29 02:30.
      await store.commit(makeBatch(await store.readRevision(), { writes: [
        { kind: 'insert', model: model('worker', 'Location'), row: row('location', { zone: mode === 'gap' ? 'Europe/Amsterdam' : 'UTC', visible: !['path-withheld', 'overflow-order'].includes(mode) }) },
        { kind: 'insert', model: rootModel, row: original },
        ...['child-1', 'child-2'].map(id => ({ kind: 'insert' as const, model: model('worker', 'Child'),
          row: { ...row(id, { done: false }), parent: { model: rootModel, id: original.id } } })),
        { kind: 'insert', model: model('worker', 'Employee'), row: row('worker', { user: { id: user.user_id }, home: { id: 'location' }, active: mode !== 'inactive' }) },
      ] }));
      const commit = store.commit.bind(store); let raced = false;
      store.commit = async batch => {
        if (mode === 'grant-race' && !raced && batch.writes.some(write => write.model === evidenceModel)) {
          raced = true;
          await commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update', model: rootModel,
            id: original.id, expectedVersion: original.version, row: { ...original, version: asVersion(original.version + 1), data: { ...original.data, calendar_visible: false } } }] }));
        }
        return commit(batch);
      };
      const load = store.load.bind(store);
      store.load = async (model, id) => {
        const value = await load(model, id);
        if (mode === 'identity-race' && !raced && model === 'work.dispatch') { raced = true; await identities.removeMembership(membership.membership_id); }
        return value;
      };
      if (mode === 'nonmember') await identities.removeMembership(membership.membership_id);
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const request = { operation: mode === 'prefix' ? 'worker.prefix' : mode === 'lazy' ? 'worker.lazy' : 'worker.capture', operation_id: operationId(now), inputs: { root: { id: original.id, version: '1' }, months: mode === 'gap' ? '2' : '1' } };
      const outcome = await invoker.invokeMutation(request, identity), success = mode === 'allowed' || mode === 'prefix' || mode === 'lazy';
      assert.equal('result' in outcome, success, `${mode}: ${JSON.stringify(outcome)}`);
      if (mode === 'overflow-order') { assert.ok('error' in outcome); assert.equal(outcome.error.code, 'rule_failed'); assert.match(outcome.error.message, /add_months result outside/); }
      if (mode === 'gap') { assert.ok('error' in outcome); assert.equal(outcome.error.code, 'rule_failed'); assert.match(outcome.error.message, /DST gap/); }
      const evidence = await store.query({ model: evidenceModel, authority: 'owner' }), pending = await store.outboxPending();
      assert.equal(evidence.length, success ? 1 : 0, mode); assert.equal(pending.length, success ? 1 : 0, mode);
      const sources = await store.query({ model: asModel('work.occurrence'), authority: 'owner' });
      assert.equal(sources.length, success ? 1 : 0, mode);
      assert.equal((await store.load(rootModel, original.id))?.data.done, success);
      for (const child of await store.query({ model: model('worker', 'Child'), authority: 'owner' })) assert.equal(child.data.done, success);
      assert.equal(raced, mode === 'grant-race' || mode === 'identity-race');
      if (success) {
        const due = '2026-02-28T02:30:00.000Z';
        assert.equal(evidence[0]!.data.due, due);
        assert.deepEqual((sources[0]!.data.result as {payload:unknown}).payload, { label: 'Original label' });
        assert.deepEqual(pending[0]!.arguments, { binding: 'worker.Port', from: 'deployment.port', arguments: { value: due, label: 'Original label' } });
        assert.equal((await store.load(rootModel, original.id))?.data.anchor, '2026-02-01');
        const revision = await store.readRevision();
        const replay = await invoker.invokeMutation(request, identity);
        assert.ok('result' in replay && replay.result.status === 'replayed', JSON.stringify(replay));
        assert.equal(await store.readRevision(), revision); assert.deepEqual(await store.outboxPending(), pending);
        assert.deepEqual(await store.query({ model: asModel('work.occurrence'), authority: 'owner' }), sources);
      } else if (mode === 'false-prefix' || mode === 'inactive') {
        assert.ok('error' in outcome); assert.equal(outcome.error.code, 'rule_failed');
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('executes original Success review and reassign item Work with exact revisions and atomic replay', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-success-item-work-'));
  try {
    const [base, original] = await Promise.all([readFile(fixture('success-renewal-owner-probe.can'), 'utf8'),
      readFile(join(root, 'draft/apps/CanSuccess/CanSuccess.can'), 'utf8')]);
    const lines = original.split('\n');
    const operation = (name: string) => {
      const start = lines.findIndex(line => line.startsWith(`  scenario ${name}(`)); assert.ok(start >= 0);
      let end = start + 1;
      while (end < lines.length && (!lines[end]!.trim() || /^ {3}/.test(lines[end]!)) && !lines[end]!.startsWith('   examples')) end++;
      return lines.slice(start, end).join('\n');
    };
    const source = base
      .replace('  role account_manager', '  message label_account_manager = "Account manager"@{nl="Klantbeheerder"}\n  role account_manager')
      .replace('renewal:date?, active:', 'renewal:date?, reviewed_at:datetime?, reviewed_by:user?, active:')
      .replace('email:email,done:bool=false}', 'email:email,done:bool=false,completed_by:user?,completed_at:datetime?}')
      .replace('  policy Account read=members', '  policy Account read=account_manager and can_work(actor,row.location)\n  policy FollowUp read=account_manager and can_work(actor,row.parent.location)\n  lock FollowUp fields=title,due,assignee,email,done,completed_by,completed_at when=row.done');
    const end = source.lastIndexOf('\n Then'); assert.ok(end > 0);
    const path = join(directory, 'Success.can');
    await writeFile(path, source.slice(0, end) + '\n' + operation('reassign') + '\n' + operation('review') + source.slice(end));
    const { stdout } = await promisify(execFile)(compiler, ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, path],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: path }, { workDir: join(directory, 'modules'),
      stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
    for (const mode of ['review', 'reassign', 'review-inactive', 'reassign-role-missing', 'reassign-commit-failure']) {
      const reassign = mode.startsWith('reassign'), name = reassign ? 'reassign' : 'review';
      const { now, identities, team, user: actor, identity } = await member(`success-item-${mode}`, ['success.account_manager']);
      const manager = await identities.createUser({ email: `manager-${mode}@success.test`, password_hash: 'unused', email_verified: true });
      await identities.createMembership({ team_id: team.team_id, user_id: manager.user_id, is_owner: false,
        roles: mode === 'reassign-role-missing' ? [] : [{ role: 'success.account_manager', granted_at: new Date(now).toISOString(), granted_by: actor.user_id }] });
      const scope = { app: 'SuccessProbe', owner: team.team_id, ownerPackage: 'success' };
      const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app,
        stateStoreId: `success-${mode}`, fileStoreId: `success-${mode}-files`, receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
      const { store, probe } = createTestMemoryStorage(authority, [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
      await installNativeFileInventory({ artifact, asm, store, authority, scope, now: () => now,
        verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
      const row = (id: string, data: Record<string, unknown>, parent: StoredRow['parent'] = null): StoredRow => ({
        ...makeRow({ id: asId(id), data }), parent });
      const customer = row('customer', { name: 'Customer' });
      const site = row('site', { name: 'Site', timezone: 'UTC' });
      const account = row('account', { location: { id: site.id }, manager: { id: actor.user_id }, email: actor.email,
        renewal: new Date(now + 2 * 86400000).toISOString().slice(0, 10), reviewed_at: null, reviewed_by: null, active: mode !== 'review-inactive' },
        { model: asModel('customer.Customer'), id: customer.id });
      const foreign = row('foreign', { ...account.data }, account.parent);
      const child = (id: string, due: number, done = false, parent = account) => row(id, { title: id, due: new Date(due).toISOString(),
        assignee: { id: actor.user_id }, email: actor.email, done, completed_by: null, completed_at: null },
        { model: asModel('success.Account'), id: parent.id });
      const future = child('future', now + 86400000), past = child('past', now - 1000), done = child('done', now + 86400000, true),
        other = child('other', now + 86400000, false, foreign);
      await store.commit(makeBatch(await store.readRevision(), { writes: [
        { kind: 'insert', model: asModel('customer.Customer'), row: customer },
        { kind: 'insert', model: asModel('rent_catalog.Location'), row: site },
        ...[actor, manager].map((user, index) => ({ kind: 'insert' as const, model: asModel('employee.Employee'),
          row: row(`employee-${index}`, { user: { id: user.user_id }, home: { id: site.id }, locations: [], operator_wide: false, active: true }) })),
        ...[account, foreign].map(row => ({ kind: 'insert' as const, model: asModel('success.Account'), row })),
        ...[future, past, done, other].map(row => ({ kind: 'insert' as const, model: asModel('success.FollowUp'), row })),
      ] }));
      const scoped = (id: string) => [scope.app, scope.ownerPackage, scope.owner, id].map(encodeURIComponent).join('/');
      const loaded = await loadCanonicalDescriptors(asm, artifact); assert.ok(loaded.valueTypes);
      const opaque = await loadOpaqueFileStaging({ store, inventoryOwner: scope.ownerPackage, artifact,
        canonicalModels: loaded.models, valueTypes: loaded.valueTypes, operations: new Map(), scope,
        verify: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
      assert.ok(opaque);
      const stageContext = { actor: actor.user_id, now, operation: `success.${name}`,
        load: (model: Parameters<typeof store.load>[0], id: Parameters<typeof store.load>[1]) => store.load(model, id),
        query: (query: Parameters<typeof store.query>[0]) => store.query(query) };
      for (const target of [account, future, past, done, other]) {
        const isAccount = target === account;
        const request = { key: target.id, scope, occurrenceId: `old-${target.id}`, at: now + 300000,
          event: isAccount ? 'success.RenewalDue' : 'success.FollowUpDue', payload: isAccount
            ? { account: { id: target.id, version: '1' }, revision: '1' }
            : { followup: { id: target.id, version: '1' }, revision: '1', account_revision: '1' } };
        const pending = await workSchedulePutCommand.stage(request, stageContext);
        const row = pending.writes?.find(write => write.kind === 'insert' && write.model === 'work.schedule' && write.row.id === request.occurrenceId);
        assert.ok(row && row.kind === 'insert');
        const declaration = opaque.event(request.event);
        const filePayloadOrigin = await opaque.prepare({ expectedRevision: await store.readRevision(), model: asModel('work.schedule'),
          row: row.row, field: 'payload', scope, origin: { kind: 'event-input', occurrenceId: request.occurrenceId,
            sourceOccurrence: request.occurrenceId, declaration,
            lineage: { kind: 'schedule', key: request.key, replaces: row.row.data.replaces as null }, target: { kind: 'schedule' } },
          projection: { kind: 'inputs', path: [], declarationId: declaration.inputsDeclarationId }, value: request.payload, identity });
        const staged = await workSchedulePutCommand.stage({ ...request, filePayloadOrigin }, stageContext);
        await store.commit(makeBatch(await store.readRevision(), { writes: staged.writes ?? [], schedules: staged.schedules ?? [] }));
      }
      const snapshot = async () => ({ records: await Promise.all(['success.Account', 'success.FollowUp', 'work.schedule', 'work.supersession'].map(model =>
        store.query({ model: asModel(model), authority: 'owner', order: [{ field: 'id', direction: 'asc' }] }))),
        schedules: [account, future, past, done, other].map(row => probe.scheduleGet(scoped(row.id))), outbox: probe.outboxAll() });
      const before = await snapshot();
      const commit = store.commit.bind(store); let injected = false;
      if (mode === 'reassign-commit-failure') store.commit = async batch => {
        if (!injected && batch.writes.some(write => write.kind === 'update' && write.model === 'success.FollowUp' && write.id === future.id)) {
          assert.ok(batch.writes.some(write => write.kind === 'insert' && write.model === 'work.schedule' &&
            write.row.data.key === future.id && write.row.data.event === 'success.FollowUpDue'),
          'the final batch contains the actual selected item replacement schedule');
          if (batch.schedules.length !== 0) {
            assert.ok(batch.schedules.some(schedule => schedule.op === 'replace' && schedule.key === scoped(future.id)),
              'the batch replaces the future selected item schedule');
            assert.ok(batch.schedules.some(schedule => schedule.op === 'cancel' && schedule.key === scoped(past.id)),
              'the batch cancels the past selected item schedule');
          }
          // Refuse the genuine fully staged transaction before publication.
          // This qualifies final-commit failure, rather than a Work-stage fault.
          injected = true;
          throw new Error('injected final Success item Work commit failure');
        }
        return commit(batch);
      };
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const envelope = { operation: `success.${name}`, operation_id: operationId(now), inputs: {
        account: { id: account.id, version: '1' }, ...(reassign ? { manager: { id: manager.user_id }, email: manager.email } : {}) } };
      const outcome = await invoker.invokeMutation(envelope, identity);
      store.commit = commit;
      if (mode !== 'review' && mode !== 'reassign') {
        assert.ok('error' in outcome, `${mode}: ${JSON.stringify(outcome)}`);
        if (mode === 'reassign-commit-failure') assert.equal(injected, true, 'failure reaches the actual fully staged final transaction');
        assert.deepEqual(await snapshot(), before, `${mode}: no staged field, cancellation or schedule survives refusal`);
        continue;
      }
      assert.ok('result' in outcome, `${mode}: ${JSON.stringify(outcome)}`); assert.equal(outcome.result.status, 'committed');
      const updated = await store.load(asModel('success.Account'), account.id); assert.ok(updated); assert.equal(updated.version, 2);
      if (reassign) { assert.deepEqual(updated.data.manager, { id: manager.user_id }); assert.equal(updated.data.email, manager.email); }
      else { assert.equal(updated.data.reviewed_at, new Date(now).toISOString()); assert.deepEqual(updated.data.reviewed_by, { id: actor.user_id }); }
      for (const source of [future, past]) {
        const current = await store.load(asModel('success.FollowUp'), source.id); assert.ok(current);
        assert.equal(current.version, reassign ? 2 : 1);
        assert.deepEqual(current.data.assignee, { id: reassign ? manager.user_id : actor.user_id });
      }
      assert.deepEqual(await store.load(asModel('success.FollowUp'), done.id), done);
      assert.deepEqual(await store.load(asModel('success.FollowUp'), other.id), other);
      assert.equal(probe.scheduleGet(scoped(past.id)), null, 'past selected item is cancelled without replacement');
      assert.deepEqual(probe.scheduleGet(scoped(done.id)), before.schedules[3]);
      assert.deepEqual(probe.scheduleGet(scoped(other.id)), before.schedules[4]);
      const scheduled = probe.scheduleGet(scoped(future.id)); assert.ok(scheduled);
      assert.equal(scheduled.at, now + 86400000);
      assert.deepEqual(scheduled.payload, { followup: { id: future.id, version: reassign ? '2' : '1' },
        revision: reassign ? '2' : '1', account_revision: '2' });
      const renewal = probe.scheduleGet(scoped(account.id)); assert.ok(renewal);
      assert.equal(renewal.at, Date.parse(String(account.data.renewal) + 'T00:00:00.000Z'));
      assert.deepEqual(renewal.payload, { account: { id: account.id, version: '2' }, revision: '2' });
      const after = await snapshot();
      const replay = await invoker.invokeMutation(envelope, identity);
      assert.ok('result' in replay, JSON.stringify(replay)); assert.equal(replay.result.status, 'replayed');
      assert.deepEqual(await snapshot(), after, 'saved replay changes neither fields nor Work lineage');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

/** Selected original bodies: no application guard or policy is rewritten. */
async function globalAnyFixture(kind: 'Customer' | 'Expense', directory: string) {
  const original = await readFile(join(root, `draft/apps/Can${kind}/Can${kind}.can`), 'utf8');
  const one = (prefix: string) => { const values = original.split('\n').filter(line => line.startsWith('  ' + prefix));
    assert.equal(values.length, 1, prefix); return values[0]!; };
  const operation = (name: string) => { const start = original.indexOf(`  ${kind === 'Customer' ? 'export ' : ''}scenario ${name}(`);
    assert.ok(start >= 0); return original.slice(start, original.indexOf('   examples', start)).trimEnd(); };
  let text: string;
  if (kind === 'Customer') text = ['app CanCustomer uses=[customer]', 'package customer', ' use rent_catalog {Location}',
    ' use employee {can_work}', ' Given', one('role customer_manager '), one('message label_Alias_to_customer ='),
    '  export Customer {name:text,kind:enum(individual,company),locations:Location[],active:bool=true}', one('export Alias {'),
    one('derive customer_staff('), one('policy Customer read=customer_manager'), one('policy Alias read='), one('invariant Alias:'), one('lock Alias '),
    ' When', operation('alias'), ' Then', ''].join('\n');
  else { const base = await readFile(join(root, 'compiler/tests/fixtures/expense-submit-original.can'), 'utf8');
    text = base.slice(0, base.indexOf('\n When')) + '\n' + [one('Reimbursement in '), one('policy Reimbursement read='),
      one('lock Reimbursement '), ' When', operation('correct'), operation('reimburse'), ' Then', ''].join('\n'); }
  const source = join(directory, `${kind}.can`); await writeFile(source, text);
  const { stdout } = await promisify(execFile)(compiler, ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog,
    source, join(root, 'draft/shared/Employees.can'), join(root, 'draft/shared/Locations.can')],
    { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
  const artifact = JSON.parse(stdout) as CompileArtifact;
  const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: join(directory, 'modules'),
    stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
  return { artifact, asm };
}
const globalAnyRow = (id: string, data: Record<string, unknown>, parent: StoredRow['parent'] = null): StoredRow => ({ ...makeRow({ id: asId(id), data }), parent });
const globalAnyEmployee = (user: string, home = 'site') => ({ user: { id: user }, home: { id: home }, locations: [],
  active: true, operator_wide: false, start: '2026-01-01', end: null, role: 'Operator', skills: [], name: null, manager: null, private_notes: null, document: null });
const globalAnySite = (id: string) => globalAnyRow(id, { name: id, address: 'Example', timezone: 'UTC', currency: 'EUR', hours: 'Open', arrival: 'Door', active: true });

it('qualifies the original customer Alias global ANY against hidden rows and commit contention', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-alias-global-any-'));
  try {
    const { artifact, asm } = await globalAnyFixture('Customer', directory);
    for (const mode of ['allowed', 'unrelated', 'hidden-alias', 'stale', 'nonmember', 'missing-role', 'foreign-location', 'competing-insert']) {
      const { now, identities, team, user, membership, identity } = await member(`alias-any-${mode}`, mode === 'missing-role' ? [] : ['customer.customer_manager']);
      const store = createMemoryStorage();
      const source = globalAnyRow('source', { name: 'Source', kind: 'company', locations: [{ id: 'site' }], active: true });
      const target = globalAnyRow('target', { ...source.data, name: 'Target', locations: [{ id: mode === 'foreign-location' ? 'other' : 'site' }] });
      const hidden = globalAnyRow('hidden', { ...source.data, locations: [{ id: 'other' }] });
      const unrelated = globalAnyRow('unrelated', { ...source.data });
      const alias = globalAnyRow('existing', { from_customer: { id: mode === 'unrelated' ? unrelated.id : source.id },
        to_customer: { id: hidden.id }, reason: 'PRIVATE-ALIAS-REASON', approved_by: { id: user.user_id } });
      await store.commit(makeBatch(await store.readRevision(), { writes: [
        ...['site', 'other'].map(id => ({ kind: 'insert' as const, model: asModel('rent_catalog.Location'), row: globalAnySite(id) })),
        { kind: 'insert', model: asModel('employee.Employee'), row: globalAnyRow('worker', globalAnyEmployee(user.user_id)) },
        ...[source, target, hidden, unrelated].map(row => ({ kind: 'insert' as const, model: asModel('customer.Customer'), row })),
        ...(['hidden-alias', 'unrelated'].includes(mode) ? [{ kind: 'insert' as const, model: asModel('customer.Alias'), row: alias }] : []),
      ] }));
      if (mode === 'nonmember') await identities.removeMembership(membership.membership_id);
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      if (mode === 'hidden-alias') { const read = await invoker.invokeRead({ operation: 'customer.Alias.read', inputs: {} }, identity);
        assert.ok('result' in read, mode + ': ' + JSON.stringify(read)); assert.equal((read.result as { records: unknown[] }).records.length, 0); }
      const commit = store.commit.bind(store); let injected = false;
      if (mode === 'competing-insert') store.commit = async batch => {
        if (!injected && batch.writes.some(write => write.model === 'customer.Alias')) { injected = true;
          await commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: asModel('customer.Alias'), row: alias }] })); }
        return commit(batch);
      };
      const request = { operation: 'customer.alias', operation_id: operationId(now), inputs: {
        source: { id: source.id, version: mode === 'stale' ? '2' : '1' }, target: { id: target.id, version: '1' }, reason: 'Reviewed alias' } };
      const outcome = await invoker.invokeMutation(request, identity);
      assert.equal(JSON.stringify(outcome).includes('PRIVATE-ALIAS-REASON'), false);
      const rows = await store.query({ model: asModel('customer.Alias'), authority: 'owner' });
      if (mode === 'allowed' || mode === 'unrelated') {
        assert.ok('result' in outcome, mode + ': ' + JSON.stringify(outcome)); assert.equal(outcome.result.status, 'committed');
        const created = rows.find(row => row.id !== alias.id)!; assert.ok(created);
        assert.deepEqual(created.data, { from_customer: { id: source.id }, to_customer: { id: target.id }, reason: 'Reviewed alias', approved_by: { id: user.user_id } });
        const before = structuredClone(rows);
        const replay = await invoker.invokeMutation(request, identity); assert.ok('result' in replay); assert.equal(replay.result.status, 'replayed');
        assert.deepEqual(await store.query({ model: asModel('customer.Alias'), authority: 'owner' }), before);
      } else { assert.ok('error' in outcome, mode + ': ' + JSON.stringify(outcome));
        assert.equal(rows.length, ['hidden-alias', 'competing-insert'].includes(mode) ? 1 : 0, mode);
        if (mode === 'competing-insert') { assert.equal(injected, true); assert.equal(rows[0]!.id, alias.id); } }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('qualifies original Expense correction and reimbursement global ANY with finalized receipt preservation', { timeout: 240000 }, async () => {
 const directory=await mkdtemp(join(tmpdir(),'can-expense-global-any-'));
 try{
  const {artifact,asm}=await globalAnyFixture('Expense',directory);
  for(const mode of ['correct-allowed','correct-existing','correct-competing','reimburse-allowed','reimburse-hidden-reference','reimburse-unrelated','reimburse-missing-role']){
   const correct=mode.startsWith('correct'),name=correct?'correct':'reimburse';
   const {now,identities,team,user,identity}=await member('expense-any-'+mode,mode==='reimburse-missing-role'?[]:['expense.finance']);
   const otherUser=await identities.createUser({email:'other-'+mode+'@expense.test',password_hash:'unused',email_verified:true});
   await identities.createMembership({team_id:team.team_id,user_id:otherUser.user_id,is_owner:false,roles:[]});
   const scope={app:'CanExpense',owner:team.team_id,ownerPackage:'expense'},authority:FileRetirementAuthority={app:scope.app,stateOwner:scope.app,stateStoreId:'expense-any-state',fileStoreId:'expense-any-files',receiver:{app:scope.app,owner:team.team_id,team:team.team_id}};
   const {store,probe}=createTestMemoryStorage(authority,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
   await installNativeFileInventory({artifact,asm,store,authority,scope,now:()=>now,verifyOwner:async()=>{assert.ok(await identities.findTeamById(team.team_id));}});
   const clock=new TestOnlyManualClock(now),blobs=new TestOnlyMemoryBlobStore(),files=new TestOnlyMemoryFinalizedStore(),intents=new TestOnlyMemoryIntentStore();
   const physical={clock,blobs,files,upload:{clock,intents,blobs,policy:DEFAULT_FILE_POLICY,intentIds:new TestOnlyCounterIntentIds(),intentTtlMs:3600000,urlBase:'https://expense.test'},finalize:{clock,intents,blobs,files,fileIds:new TestOnlyCounterFileIds()}};
   const retention={unattachedHorizonMs:3600000,retentionMs:86400000},observation={policy:physical.upload.policy,retention};
   const kernel=createFileJourneyKernel({maxBytes:physical.upload.policy.maxBytes,createIntent:input=>createUploadIntent(physical.upload,input),append:(id,caller,bytes,offset)=>appendUploadContentAtOffset(physical.upload,id,caller,bytes,offset),complete:(id,caller)=>completeUploadContent(physical.upload,id,caller),finalize:input=>finalizeUpload(physical.finalize,input),authorizeAttach:(ref,caller)=>authorizeAttach(physical.finalize,ref,caller),readProvenance:(ref,caller)=>readFinalizedFile(physical.finalize,ref,caller),recordAttachment:(ref,record,caller)=>recordAttachment(physical.finalize,ref,record,caller),readBytes:(ref,caller)=>readFinalizedBytes(physical.finalize,ref,caller),readCurrentBytes:(ref,caller,policy)=>readCurrentFinalizedBytes(physical.finalize,ref,caller,{...observation,retention:policy}),readCurrentSnapshot:(ref,caller,policy)=>readCurrentFinalizedSnapshot(physical.finalize,ref,caller,{...observation,retention:policy}),observeFile:(ref,caller,policy)=>observeFinalizedFile(physical.finalize,ref,caller,{...observation,retention:policy}),revalidateFile:(saved,caller,policy)=>revalidateRetainedFinalizedFile(physical.finalize,saved,caller,{...observation,retention:policy})} satisfies FileJourneyBindings);
   const receiver={app:scope.app,owner:team.team_id,team:team.team_id,principal:user.user_id},bytes=new TextEncoder().encode('Exact original receipt');
   const intent=createUploadIntent(physical.upload,{receiver,binding:{adapter:'deployment.web',deliveryId:'receipt',resultPath:'receipt'},request:{upload_id:'receipt',operation:'expense.correct',field:'/receipt',arguments:{},name:'receipt.txt',type:'text/plain',size:String(bytes.length)}});assert.ok(intent.status==='granted');
   assert.equal(appendUploadContentAtOffset(physical.upload,intent.intentId,receiver,bytes,0).status,'appended');assert.equal(completeUploadContent(physical.upload,intent.intentId,receiver).status,'completed');
   const finalized=finalizeUpload(physical.finalize,{intentId:intent.intentId,retryId:'receipt',bytesDigest:sha256Hex(bytes),caller:receiver});assert.ok(finalized.status==='finalized');

   const amount={minor:'2500',currency:'EUR'},claimant=globalAnyRow('claimant',globalAnyEmployee(user.user_id)),otherEmployee=globalAnyRow('other-worker',globalAnyEmployee(otherUser.user_id,'other'));
   const expense=globalAnyRow('expense',{location:{id:'site'},corrects:null,authorization:'Approved travel',purpose:'Travel',category:'Travel',amount,business_date:'2026-10-01',receipt:{id:finalized.result.file},reviewer:{id:otherUser.user_id},status:correct?'rejected':'approved',submission:'1',withdrawal:null,decision:'Original decision',decided_by:{id:otherUser.user_id},decided_at:new Date(now-1000).toISOString()},{model:asModel('employee.Employee'),id:claimant.id});
   const foreign=globalAnyRow('foreign-expense',{...expense.data,location:{id:'other'},status:'approved'},{model:asModel('employee.Employee'),id:otherEmployee.id});
   const replacement=globalAnyRow('existing-correction',{...expense.data,corrects:{id:expense.id},status:'draft',decision:null,decided_by:null,decided_at:null},expense.parent);
   const payment=globalAnyRow('existing-payment',{amount,reference:mode==='reimburse-unrelated'?'other-reference':'bank-new',paid:'2026-10-01',reason:'PRIVATE-PAYMENT-EVIDENCE',recorded_by:{id:otherUser.user_id}},{model:asModel('expense.Expense'),id:foreign.id});
   await store.commit(makeBatch(await store.readRevision(),{writes:[
    ...['site','other'].map(id=>({kind:'insert' as const,model:asModel('rent_catalog.Location'),row:globalAnySite(id)})),
    ...[claimant,otherEmployee].map(row=>({kind:'insert' as const,model:asModel('employee.Employee'),row})),
    ...[expense,foreign,...(mode==='correct-existing'?[replacement]:[])].map(row=>({kind:'insert' as const,model:asModel('expense.Expense'),row})),
    ...(['reimburse-hidden-reference','reimburse-unrelated'].includes(mode)?[{kind:'insert' as const,model:asModel('expense.Reimbursement'),row:payment}]:[])
   ]}));
   const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now,files:createCanonicalFileBinding(kernel,retention)});
   if(mode==='reimburse-hidden-reference'){
    const read=await invoker.invokeRead({operation:'expense.Reimbursement.read',inputs:{}},identity);assert.ok('result'in read,mode+': '+JSON.stringify(read));assert.equal((read.result as {records:unknown[]}).records.length,0);
   }
   const snapshot=async()=>({expenses:await store.query({model:asModel('expense.Expense'),authority:'owner',order:[{field:'id',direction:'asc'}]}),payments:await store.query({model:asModel('expense.Reimbursement'),authority:'owner',order:[{field:'id',direction:'asc'}]}),outbox:probe.outboxAll()});
   const before=await snapshot(),commit=store.commit.bind(store);let injected=false;
   if(mode==='correct-competing')store.commit=async batch=>{
    if(!injected&&batch.writes.some(write=>write.kind==='insert'&&write.model==='expense.Expense')){injected=true;await commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:asModel('expense.Expense'),row:replacement}]}));}
    return commit(batch);
   };
   const request={operation:'expense.'+name,operation_id:operationId(now),inputs:{expense:{id:expense.id,version:'1'},...(correct?{}:{amount,reference:' bank-new ',paid:new Date(now).toISOString().slice(0,10),reason:'Statement evidence'})}};
   const result=await invoker.invokeMutation(request,identity),allowed=mode.endsWith('-allowed')||mode==='reimburse-unrelated';
   assert.equal('result'in result,allowed,mode+': '+JSON.stringify(result));assert.equal(JSON.stringify(result).includes('PRIVATE-PAYMENT-EVIDENCE'),false);
   if(allowed){
    assert.ok('result'in result);assert.equal(result.result.status,'committed');
    const after=await snapshot();
    if(correct){
     assert.deepEqual(await store.load(asModel('expense.Expense'),expense.id),expense,'correction never edits the original rejected claim');
     const created=after.expenses.find(row=>row.id!==expense.id&&row.id!==foreign.id)!;assert.ok(created);
     assert.deepEqual(created.data.receipt,expense.data.receipt);assert.deepEqual(created.data.corrects,{id:expense.id});assert.equal(created.data.status,'draft');assert.equal(created.data.submission,'1');assert.deepEqual(created.data.amount,amount);
     const retained=await readCurrentFinalizedBytes(physical.finalize,finalized.result.file,receiver,observation);assert.ok(retained,'actual finalized receipt remains accessible after clone');assert.deepEqual(retained,bytes);
    }else{
     assert.equal((await store.load(asModel('expense.Expense'),expense.id))?.data.status,'reimbursed');
     const created=after.payments.find(row=>row.id!==payment.id)!;assert.ok(created);assert.deepEqual(created.parent,{model:asModel('expense.Expense'),id:expense.id});assert.equal(created.data.reference,'bank-new');assert.deepEqual(created.data.recorded_by,{id:user.user_id});
    }
    const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');assert.deepEqual(await snapshot(),after);
   }else if(mode==='correct-competing'){
    assert.equal(injected,true);assert.deepEqual(await store.load(asModel('expense.Expense'),expense.id),expense);assert.equal((await snapshot()).expenses.length,before.expenses.length+1);assert.ok(await store.load(asModel('expense.Expense'),replacement.id));
   }else assert.deepEqual(await snapshot(),before,mode+': original guards reject without mutation');
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});


async function originalDeskFixtureSource(directory: string) {
  const original = await readFile(join(root, 'draft/apps/CanRent/CanRent.can'), 'utf8');
  const lines = original.split('\n');
  const one = (prefix: string) => { const matches = lines.filter(line => line.startsWith('  ' + prefix));
    assert.equal(matches.length, 1, prefix); return matches[0]!; };
  const start = original.indexOf('  export scenario assign_desk(');
  const end = original.indexOf('\n  ', original.indexOf('   do create Assignment ', start));
  assert.ok(start >= 0 && end > start);
  const text = ['app CanRent uses=[rent_reservations]', 'package customer', ' Given',
    '  export Customer {name:text}', ' When', ' Then', 'package rent_reservations',
    ' use rent_catalog {Location,catalog_owner}', ' use employee {can_work}', ' use customer {Customer}', ' Given',
    one('export role reservation_manager '), one('export role reception '), one('role billing '),
    one('message label_RoomRequest_terms ='), one('export Resource {'),
    one('contract BookingInterval {'),
    // Keep every field consumed by the original policies, busy helper and invariants.
    '  export Booking in Resource {customer:Customer,account:user,email:email,from:datetime,until:datetime,quantity:int=1 min=1,attendees:int=1 min=1,status:enum(held,pending,confirmed,occupied,completed,cancelled,expired,review,no_show)=held,payment:enum(unpaid,pending,unknown,paid,refunded,free,on_account)=unpaid,allowance:enum(not_required,pending,reserved,consumed,released,failed)=not_required,checked_in:datetime?,checked_out:datetime?,overdue:bool=false,source:text unique,expires:datetime,departure_buffer:duration=0m,reserved_from:datetime,reserved_until:datetime,total:money,subtotal:money,discount:money,tax:money,refund_amount:money,intervals:BookingInterval[]}',
    one('Desk in Resource {'), one('Assignment in Booking {'), one('derive busy('),
    ...lines.filter(line => line.startsWith('  policy Resource read=')),
    one('export derive can_read_booking_details('), ...lines.filter(line => line.startsWith('  policy Booking read=')),
    one('policy Desk read='), ...lines.filter(line => line.startsWith('  policy Assignment read=')),
    ...lines.filter(line => line.startsWith('  invariant Resource:')), one('invariant Booking:'), one('invariant Assignment:'),
    ' When', original.slice(start, end), ' Then', ''].join('\n');
  const source = join(directory, 'Rent.can'); await writeFile(source, text); return source;
}

it('qualifies original Rent desk assignment with private occupancy control and atomic admission', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-rent-desk-original-'));
  try {
    const source = await originalDeskFixtureSource(directory);
    const { stdout } = await promisify(execFile)(compiler, ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog,
      source, join(root, 'draft/shared/Employees.can'), join(root, 'draft/shared/Locations.can')],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: join(directory, 'modules'),
      stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
    for (const mode of ['allowed', 'adjacent', 'held-live', 'held-expired', 'occupied', 'checked-in', 'departure-buffer', 'buffer-ended',
      'quantity', 'quantity-spare', 'invalid-interval', 'stale', 'missing-role', 'foreign-location', 'inactive-worker', 'inactive-desk', 'wrong-resource', 'nonpooled', 'target-held',
      'employee-revoked', 'membership-revoked', 'competing-assignment']) {
      const { now, identities, team, user, membership, identity } = await member('rent-desk-' + mode, mode === 'missing-role' ? [] : ['rent_reservations.reception']);
      const guest = await identities.createUser({ email: 'guest-' + mode + '@desk.test', password_hash: 'unused', email_verified: true });
      const scope = { app: 'CanRent', owner: team.team_id, ownerPackage: 'rent_reservations' };
      const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app, stateStoreId: 'rent-desk-state', fileStoreId: 'rent-desk-files',
        receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
      const { store, probe } = createTestMemoryStorage(authority, [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
      await installNativeFileInventory({ artifact, asm, store, authority, scope, now: () => now,
        verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
      const instant = (offset: number) => new Date(now + offset).toISOString();
      const resourceData = { location: { id: mode === 'foreign-location' ? 'other' : 'site' }, name: 'Pool', pooled: mode !== 'nonpooled', capacity: mode === 'nonpooled' ? '1' : '4',
        party_limit: '4', kind: 'desk', hold_for: '900000', active: true, timezone: 'UTC', currency: 'EUR', tax_rate: '0', discount_rate: '0',
        cancellation_fee: null, hourly: { minor: '1000', currency: 'EUR' }, daily: null, price_unit: 'hour', increment: '3600000', minimum: '3600000', terms: 'Terms',
        refund_notice: '0', buffer_before: '0', buffer_after: '0', amenities: [], accessibility: 'Level' };
      const resource = globalAnyRow('pool', resourceData), otherResource = globalAnyRow('other-pool', { ...resourceData, name: 'Other pool' });
      const worker = globalAnyRow('worker', { ...globalAnyEmployee(user.user_id), active: mode !== 'inactive-worker' });
      const desk = globalAnyRow('desk', { name: 'Desk', active: mode !== 'inactive-desk' }, { model: asModel('rent_reservations.Resource'), id: mode === 'wrong-resource' ? otherResource.id : resource.id });
      const otherDesk = globalAnyRow('other-desk', { name: 'Other desk', active: true }, { model: asModel('rent_reservations.Resource'), id: resource.id });
      const money = { minor: '1000', currency: 'EUR' }, zero = { minor: '0', currency: 'EUR' };
      const bookingData = { customer: { id: 'customer' }, account: { id: guest.user_id }, email: guest.email, from: instant(-3600000), until: instant(7200000),
        quantity: mode === 'quantity-spare' ? '2' : '1', attendees: '1', status: 'confirmed', payment: 'paid', allowance: 'not_required', checked_in: null, checked_out: null, overdue: false,
        source: 'target', expires: instant(60000), departure_buffer: '60000', reserved_from: instant(-3600000), reserved_until: instant(7200000),
        total: money, subtotal: money, discount: zero, tax: zero, refund_amount: money, intervals: [] };
      const booking = globalAnyRow('booking', { ...bookingData, status: mode === 'target-held' ? 'held' : 'confirmed' }, { model: asModel('rent_reservations.Resource'), id: resource.id });
      const competitor = globalAnyRow('competitor', { ...bookingData, source: 'competitor', status: ['allowed', 'adjacent', 'competing-assignment'].includes(mode) ? 'confirmed' : mode === 'occupied' ? 'occupied' : ['held-live', 'held-expired'].includes(mode) ? 'held' : 'completed',
        expires: instant(mode === 'held-expired' ? 0 : 60000), checked_in: ['checked-in', 'departure-buffer', 'buffer-ended'].includes(mode) ? instant(-3600000) : null,
        checked_out: ['departure-buffer', 'buffer-ended'].includes(mode) ? instant(mode === 'buffer-ended' ? -60000 : -30000) : null }, booking.parent);
      const existing = globalAnyRow('existing', { desk: { id: ['quantity', 'quantity-spare', 'allowed'].includes(mode) ? otherDesk.id : desk.id },
        from: instant(mode === 'adjacent' ? -1800000 : 0), until: instant(mode === 'adjacent' ? 0 : 1800000) },
        { model: asModel('rent_reservations.Booking'), id: ['quantity', 'quantity-spare'].includes(mode) ? booking.id : competitor.id });
      const hasExisting = ['allowed', 'adjacent', 'held-live', 'held-expired', 'occupied', 'checked-in', 'departure-buffer', 'buffer-ended', 'quantity', 'quantity-spare'].includes(mode);
      await store.commit(makeBatch(await store.readRevision(), { writes: [
        ...['site', 'other'].map(id => ({ kind: 'insert' as const, model: asModel('rent_catalog.Location'), row: globalAnySite(id) })),
        { kind: 'insert', model: asModel('employee.Employee'), row: worker },
        ...[resource, otherResource].map(row => ({ kind: 'insert' as const, model: asModel('rent_reservations.Resource'), row })),
        { kind: 'insert', model: asModel('customer.Customer'), row: globalAnyRow('customer', { name: 'Customer' }) },
        ...[booking, competitor].map(row => ({ kind: 'insert' as const, model: asModel('rent_reservations.Booking'), row })),
        ...[desk, otherDesk].map(row => ({ kind: 'insert' as const, model: asModel('rent_reservations.Desk'), row })),
        ...(hasExisting ? [{ kind: 'insert' as const, model: asModel('rent_reservations.Assignment'), row: existing }] : []),
      ] }));
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      if (mode === 'held-live' || mode === 'departure-buffer') {
        const read = await invoker.invokeRead({ operation: 'rent_reservations.Booking.read', inputs: {} }, identity);
        assert.ok('result' in read, mode + ': ' + JSON.stringify(read));
        const records = (read.result as { records: { id: string; data: Record<string, unknown> }[] }).records;
        const visible = records.find(row => row.id === competitor.id); assert.ok(visible, 'reception sees the competing booking');
        assert.equal(Object.hasOwn(visible.data, 'expires'), false); assert.equal(Object.hasOwn(visible.data, 'departure_buffer'), false);
        const assignments = await invoker.invokeRead({ operation: 'rent_reservations.Assignment.read', inputs: {} }, identity);
        assert.ok('result' in assignments, JSON.stringify(assignments));
        assert.equal((assignments.result as { records: unknown[] }).records.length, 1, 'same-resource Assignment has its original reception read grant');
      }
      const commit = store.commit.bind(store), query = store.query.bind(store); let injected = false;
      // Identity revocation is observable before final admission, rather than promising
      // cross-store atomicity after State has admitted its physical commit.
      if (mode === 'membership-revoked') store.query = async request => {
        const rows = await query(request);
        if (!injected && request.model === 'rent_reservations.Assignment') {
          injected = true; await identities.removeMembership(membership.membership_id);
        }
        return rows;
      };
      if (['employee-revoked', 'competing-assignment'].includes(mode)) store.commit = async batch => {
        if (!injected && batch.writes.some(write => write.model === 'rent_reservations.Assignment')) {
          injected = true;
          if (mode === 'employee-revoked') await commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update', model: asModel('employee.Employee'), id: worker.id, expectedVersion: worker.version, row: { ...worker, version: asVersion(2), data: { ...worker.data, active: false } } }] }));
          else await commit(makeBatch(await store.readRevision(), { writes: [
            { kind: 'insert', model: asModel('rent_reservations.Assignment'), row: existing },
          ] }));
        }
        return commit(batch);
      };
      const request = { operation: 'rent_reservations.assign_desk', operation_id: operationId(now), inputs: {
        booking: { id: booking.id, version: mode === 'stale' ? '2' : '1' }, desk: { id: desk.id, version: '1' },
        from: instant(0), until: instant(mode === 'invalid-interval' ? 10800000 : 1800000) } };
      const outcome = await invoker.invokeMutation(request, identity); store.commit = commit; store.query = query;
      const allowed = ['allowed', 'adjacent', 'held-expired', 'buffer-ended', 'quantity-spare'].includes(mode);
      assert.equal('result' in outcome, allowed, mode + ': ' + JSON.stringify(outcome));
      const rows = await store.query({ model: asModel('rent_reservations.Assignment'), authority: 'owner', order: [{ field: 'id', direction: 'asc' }] });
      assert.deepEqual(await store.load(asModel('rent_reservations.Booking'), booking.id), booking, 'source creates Assignment without changing Booking');
      assert.deepEqual(await store.load(asModel('rent_reservations.Resource'), resource.id), resource);
      assert.deepEqual(probe.outboxAll(), [], 'original assignment body emits no Work or other outbox effects');
      assert.equal((await store.query({ model: asModel('work.schedule'), authority: 'owner' })).length, 0);
      if (allowed) {
        assert.ok('result' in outcome); assert.equal(outcome.result.status, 'committed');
        const created = rows.find(row => row.id !== existing.id); assert.ok(created);
        assert.deepEqual(created.parent, { model: asModel('rent_reservations.Booking'), id: booking.id });
        assert.deepEqual(created.data, { desk: { id: desk.id }, from: request.inputs.from, until: request.inputs.until });
        const replay = await invoker.invokeMutation(request, identity); assert.ok('result' in replay, JSON.stringify(replay)); assert.equal(replay.result.status, 'replayed');
        assert.deepEqual(await store.query({ model: asModel('rent_reservations.Assignment'), authority: 'owner', order: [{ field: 'id', direction: 'asc' }] }), rows);
      } else {
        if (['held-live', 'occupied', 'checked-in', 'departure-buffer', 'quantity', 'invalid-interval', 'foreign-location',
          'inactive-worker', 'inactive-desk', 'wrong-resource', 'nonpooled', 'target-held'].includes(mode)) {
          assert.ok('error' in outcome); assert.equal(outcome.error.code, 'rule_failed', mode + ': ' + JSON.stringify(outcome));
        }
        assert.equal(rows.length, hasExisting || mode === 'competing-assignment' ? 1 : 0, mode + ': no orphan Assignment');
        if (['employee-revoked', 'membership-revoked', 'competing-assignment'].includes(mode)) assert.equal(injected, true);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});


async function originalLegacyLinkSource(directory: string, operation: 'link_legacy' | 'retain_legacy' = 'link_legacy') {
  const original = await readFile(join(root, 'draft/apps/CanExpense/CanExpense.can'), 'utf8'), lines = original.split('\n');
  const one = (prefix: string) => { const matches = lines.filter(line => line.startsWith('  ' + prefix));
    assert.equal(matches.length, 1, prefix); return matches[0]!; };
  const start = original.indexOf('  scenario ' + operation + '('), end = original.indexOf('   examples', start);
  assert.ok(start >= 0 && end > start);
  const source = join(directory, 'Expense.can');
  await writeFile(source, ['app CanExpense uses=[expense]', 'package expense', ' use rent_catalog {Location}', ' use employee {Employee,can_work}',
    ' Given', one('role finance '), one('contract LegacyClaim {'), one('LegacyExpense {'), one('unique LegacyExpense '), one('lock LegacyExpense '),
    ...lines.filter(line => line.startsWith('  policy LegacyExpense read=')), one('invariant LegacyExpense:'),
    ' When', original.slice(start, end).trimEnd(), ' Then', ''].join('\n'));
  return source;
}

it('qualifies original historical Expense access with query-local archived employee control', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-expense-legacy-archived-'));
  try {
    const source = await originalLegacyLinkSource(directory);
    const { stdout } = await promisify(execFile)(compiler, ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog,
      source, join(root, 'draft/shared/Employees.can'), join(root, 'draft/shared/Locations.can')],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: join(directory, 'modules'),
      stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
    for (const mode of ['archived-home', 'archived-locations', 'inactive-archived', 'absent', 'foreign-location', 'null-revoke',
      'actor-only-archived', 'missing-role', 'stale', 'blank-reason', 'restore-race', 'archive-race', 'membership-revoked']) {
      const { now, identities, team, user, membership, identity } = await member('legacy-archived-' + mode, mode === 'missing-role' ? [] : ['expense.finance']);
      const claimant = await identities.createUser({ email: 'claimant-' + mode + '@legacy.test', password_hash: 'unused', email_verified: true });
      const scope = { app: 'CanExpense', owner: team.team_id, ownerPackage: 'expense' };
      const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app, stateStoreId: 'legacy-state', fileStoreId: 'legacy-files',
        receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
      const { store, probe } = createTestMemoryStorage(authority, [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
      await installNativeFileInventory({ artifact, asm, store, authority, scope, now: () => now,
        verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
   const clock=new TestOnlyManualClock(now),blobs=new TestOnlyMemoryBlobStore(),files=new TestOnlyMemoryFinalizedStore(),intents=new TestOnlyMemoryIntentStore();
   const physical={clock,blobs,files,upload:{clock,intents,blobs,policy:DEFAULT_FILE_POLICY,intentIds:new TestOnlyCounterIntentIds(),intentTtlMs:3600000,urlBase:'https://expense.test'},finalize:{clock,intents,blobs,files,fileIds:new TestOnlyCounterFileIds()}};
   const retention={unattachedHorizonMs:3600000,retentionMs:86400000},observation={policy:physical.upload.policy,retention};
   const kernel=createFileJourneyKernel({maxBytes:physical.upload.policy.maxBytes,createIntent:input=>createUploadIntent(physical.upload,input),append:(id,caller,bytes,offset)=>appendUploadContentAtOffset(physical.upload,id,caller,bytes,offset),complete:(id,caller)=>completeUploadContent(physical.upload,id,caller),finalize:input=>finalizeUpload(physical.finalize,input),authorizeAttach:(ref,caller)=>authorizeAttach(physical.finalize,ref,caller),readProvenance:(ref,caller)=>readFinalizedFile(physical.finalize,ref,caller),recordAttachment:(ref,record,caller)=>recordAttachment(physical.finalize,ref,record,caller),readBytes:(ref,caller)=>readFinalizedBytes(physical.finalize,ref,caller),readCurrentBytes:(ref,caller,policy)=>readCurrentFinalizedBytes(physical.finalize,ref,caller,{...observation,retention:policy}),readCurrentSnapshot:(ref,caller,policy)=>readCurrentFinalizedSnapshot(physical.finalize,ref,caller,{...observation,retention:policy}),observeFile:(ref,caller,policy)=>observeFinalizedFile(physical.finalize,ref,caller,{...observation,retention:policy}),revalidateFile:(saved,caller,policy)=>revalidateRetainedFinalizedFile(physical.finalize,saved,caller,{...observation,retention:policy})} satisfies FileJourneyBindings);
   const receiver={app:scope.app,owner:team.team_id,team:team.team_id,principal:user.user_id},bytes=new TextEncoder().encode('Original legacy source evidence');
   const intent=createUploadIntent(physical.upload,{receiver,binding:{adapter:'deployment.web',deliveryId:'receipt',resultPath:'receipt'},request:{upload_id:'receipt',operation:'expense.link_legacy',field:'/source_evidence',arguments:{},name:'receipt.txt',type:'text/plain',size:String(bytes.length)}});assert.ok(intent.status==='granted');
   assert.equal(appendUploadContentAtOffset(physical.upload,intent.intentId,receiver,bytes,0).status,'appended');assert.equal(completeUploadContent(physical.upload,intent.intentId,receiver).status,'completed');
   const finalized=finalizeUpload(physical.finalize,{intentId:intent.intentId,retryId:'receipt',bytesDigest:sha256Hex(bytes),caller:receiver});assert.ok(finalized.status==='finalized');
      const actorWorker = { ...globalAnyRow('actor-worker', globalAnyEmployee(user.user_id)), archivedAt: mode === 'actor-only-archived' ? now - 1000 : null };
      const oldWorker = { ...globalAnyRow('old-worker', { ...globalAnyEmployee(claimant.user_id, ['foreign-location', 'archived-locations'].includes(mode) ? 'other' : 'site'),
        active: mode !== 'inactive-archived', locations: mode === 'archived-locations' ? [{ id: 'site' }] : [] }), archivedAt: mode === 'archive-race' ? null : now - 1000 };
      const entry = globalAnyRow('legacy', { source: 'vendor-a', external_id: 'old-17', location: { id: 'site' },
        claim: { actor: 'Former employee 41', reviewer: 'Original reviewer', decision_time_original: '2021-05-12 09:00',
          decided_at: '2021-05-12T09:00:00.000Z', paid: '2021-05-20', status: 'Paid', purpose: 'Travel', amount: { minor: '2500', currency: 'EUR' },
          receipt: null, receipt_issue: 'Original receipt absent from the historical export' },
        source_evidence: { id: finalized.result.file }, attestation: 'Source transcribed without live approval',
        claimant: mode === 'null-revoke' ? { id: claimant.user_id } : null, access_reason: null,
        imported_by: { id: user.user_id }, imported_at: new Date(now - 10000).toISOString() });
      await store.commit(makeBatch(await store.readRevision(), { writes: [
        ...['site', 'other'].map(id => ({ kind: 'insert' as const, model: asModel('rent_catalog.Location'), row: globalAnySite(id) })),
        { kind: 'insert', model: asModel('employee.Employee'), row: actorWorker },
        ...(!['absent', 'null-revoke'].includes(mode) ? [{ kind: 'insert' as const, model: asModel('employee.Employee'), row: oldWorker }] : []),
        { kind: 'insert', model: asModel('expense.LegacyExpense'), row: entry },
      ] }));
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now, files: createCanonicalFileBinding(kernel, retention) });
      if (mode === 'archived-home') {
        const read = await invoker.invokeRead({ operation: 'employee.Employee.read', inputs: {} }, identity);
        assert.ok('result' in read, JSON.stringify(read));
        assert.deepEqual((read.result as { records: { id: string }[] }).records.map(row => row.id), [actorWorker.id],
          'archived claimant control does not widen ordinary Employee read');
      }
      const commit = store.commit.bind(store), query = store.query.bind(store); let injected = false;
      if (mode === 'membership-revoked') store.query = async request => {
        const rows = await query(request);
        if (!injected && request.model === 'employee.Employee') { injected = true; await identities.removeMembership(membership.membership_id); }
        return rows;
      };
      if (mode === 'restore-race' || mode === 'archive-race') store.commit = async batch => {
        if (!injected && batch.writes.some(write => write.model === 'expense.LegacyExpense')) {
          injected = true;
          await commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update', model: asModel('employee.Employee'),
            id: oldWorker.id, expectedVersion: oldWorker.version, row: { ...oldWorker, version: asVersion(oldWorker.version + 1),
              archivedAt: mode === 'restore-race' ? null : now, data: { ...oldWorker.data, home: { id: 'other' }, locations: [] } } }] }));
        }
        return commit(batch);
      };
      const request = { operation: 'expense.link_legacy', operation_id: operationId(now), inputs: {
        entry: { id: entry.id, version: mode === 'stale' ? '2' : '1' }, claimant: mode === 'null-revoke' ? null : { id: claimant.user_id },
        reason: mode === 'blank-reason' ? '   ' : ' Verified personnel key ' } };
      const outcome = await invoker.invokeMutation(request, identity); store.commit = commit; store.query = query;
      const allowed = ['archived-home', 'archived-locations', 'inactive-archived', 'null-revoke'].includes(mode);
      assert.equal('result' in outcome, allowed, mode + ': ' + JSON.stringify(outcome));
      const current = await store.load(asModel('expense.LegacyExpense'), entry.id); assert.ok(current);
      assert.deepEqual(probe.outboxAll(), [], 'access mapping never schedules or emits work');
      if (allowed) {
        assert.ok('result' in outcome); assert.equal(outcome.result.status, 'committed');
        assert.equal(current.version, entry.version + 1);
        assert.deepEqual(current.data, { ...entry.data, claimant: request.inputs.claimant, access_reason: 'Verified personnel key' });
        const retained = await readCurrentFinalizedBytes(physical.finalize, finalized.result.file, receiver, observation);
        assert.ok(retained, 'real original source evidence remains readable'); assert.deepEqual(retained, bytes);
        const replay = await invoker.invokeMutation(request, identity); assert.ok('result' in replay, mode + ': ' + JSON.stringify(replay));
        assert.equal(replay.result.status, 'replayed'); assert.deepEqual(await store.load(asModel('expense.LegacyExpense'), entry.id), current);
      } else {
        if (['absent', 'foreign-location', 'actor-only-archived', 'blank-reason'].includes(mode)) {
          assert.ok('error' in outcome); assert.equal(outcome.error.code, 'rule_failed', mode + ': ' + JSON.stringify(outcome));
        }
        assert.deepEqual(current, entry, mode + ': historical evidence and access mapping are unchanged on refusal');
        if (['restore-race', 'archive-race', 'membership-revoked'].includes(mode)) assert.equal(injected, true, mode);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});


async function originalInvoiceLegacySource(directory: string) {
  const original = await readFile(join(root, 'draft/apps/CanInvoice/CanInvoice.can'), 'utf8');
  const customer = await readFile(join(root, 'draft/apps/CanCustomer/CanCustomer.can'), 'utf8');
  const one = (text: string, prefix: string) => { const found = text.split('\n').filter(line => line.startsWith('  ' + prefix));
    assert.equal(found.length, 1, prefix); return found[0]!; };
  const start = original.indexOf('  scenario retain_legacy_booking('), end = original.indexOf('   examples', start);
  assert.ok(start >= 0 && end > start);
  const source = join(directory, 'Invoice.can');
  await writeFile(source, ['app CanInvoice uses=[invoice]', 'package invoice', ' use rent_catalog {Location}', ' use employee {can_work}',
    ' use customer {Customer,owns,has_role}', ' use rent_reservations {LegacyBooking}', ' Given', one(original, 'export role finance '),
    ...['number', 'issuer', 'recipient'].map(name => one(original, 'message label_InvoiceDocument_' + name + ' =')),
    ...['contract LegacyInvoiceFacts {', 'LegacyInvoice {', 'LegacyInvoiceBooking in ', 'unique LegacyInvoice fields=',
      'unique LegacyInvoiceBooking fields=', 'lock LegacyInvoice fields=', 'lock LegacyInvoiceBooking fields='].map(prefix => one(original, prefix)),
    ...original.split('\n').filter(line => line.startsWith('  policy LegacyInvoice read=') || line.startsWith('  policy LegacyInvoiceBooking read=')),
    one(original, 'invariant LegacyInvoice:'), ' When', original.slice(start, end).trimEnd(), ' Then',
    'package customer', ' use rent_catalog {Location}', ' Given', ...customer.split('\n').filter(line => line.startsWith('  message ')),
    ...['export Customer {', 'export Contact in ', 'export CompanyRole in ', 'export derive has_role(', 'export derive owns('].map(prefix => one(customer, prefix)),
    // Nullable unresolved reference only; this workflow never reads or creates a retained Booking.
    ' When', ' Then', 'package rent_reservations', ' Given', '  export LegacyBooking {source:text,external_id:text}', ' When', ' Then', ''].join('\n'));
  return source;
}

it('qualifies original invoice booking-link retention with archived child capacity and duplicate guards', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-invoice-legacy-archived-count-'));
  try {
    const source = await originalInvoiceLegacySource(directory);
    const { stdout } = await promisify(execFile)(compiler, ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog,
      source, join(root, 'draft/shared/Employees.can'), join(root, 'draft/shared/Locations.can')],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: join(directory, 'modules'),
      stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
    for (const mode of ['allowed', 'archived-capacity', 'archived-spare', 'null-count', 'scoped-parent', 'distinct-edge',
      'archived-duplicate', 'current-duplicate', 'zero-count', 'missing-role', 'foreign-location', 'actor-archived', 'stale',
      'blank-attestation', 'count-phantom', 'duplicate-phantom', 'membership-revoked']) {
      const { now, identities, team, user, membership, identity } = await member('invoice-legacy-' + mode, mode === 'missing-role' ? [] : ['invoice.finance']);
      const scope = { app: 'CanInvoice', owner: team.team_id, ownerPackage: 'invoice' };
      const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app, stateStoreId: 'legacy-invoice-state', fileStoreId: 'legacy-invoice-files',
        receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
      const { store, probe } = createTestMemoryStorage(authority, [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
      await installNativeFileInventory({ artifact, asm, store, authority, scope, now: () => now,
        verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
      const clock = new TestOnlyManualClock(now), blobs = new TestOnlyMemoryBlobStore(), files = new TestOnlyMemoryFinalizedStore(), intents = new TestOnlyMemoryIntentStore();
      const physical = { clock, blobs, files, upload: { clock, intents, blobs, policy: DEFAULT_FILE_POLICY, intentIds: new TestOnlyCounterIntentIds(), intentTtlMs: 3600000, urlBase: 'https://invoice.test' },
        finalize: { clock, intents, blobs, files, fileIds: new TestOnlyCounterFileIds() } };
      const retention = { unattachedHorizonMs: 3600000, retentionMs: 86400000 }, observation = { policy: physical.upload.policy, retention };
      const kernel = createFileJourneyKernel({ maxBytes: physical.upload.policy.maxBytes, createIntent: input => createUploadIntent(physical.upload, input),
        append: (id, caller, bytes, offset) => appendUploadContentAtOffset(physical.upload, id, caller, bytes, offset), complete: (id, caller) => completeUploadContent(physical.upload, id, caller),
        finalize: input => finalizeUpload(physical.finalize, input), authorizeAttach: (ref, caller) => authorizeAttach(physical.finalize, ref, caller),
        readProvenance: (ref, caller) => readFinalizedFile(physical.finalize, ref, caller), recordAttachment: (ref, record, caller) => recordAttachment(physical.finalize, ref, record, caller),
        readBytes: (ref, caller) => readFinalizedBytes(physical.finalize, ref, caller), readCurrentBytes: (ref, caller, policy) => readCurrentFinalizedBytes(physical.finalize, ref, caller, { ...observation, retention: policy }),
        readCurrentSnapshot: (ref, caller, policy) => readCurrentFinalizedSnapshot(physical.finalize, ref, caller, { ...observation, retention: policy }),
        observeFile: (ref, caller, policy) => observeFinalizedFile(physical.finalize, ref, caller, { ...observation, retention: policy }),
        revalidateFile: (saved, caller, policy) => revalidateRetainedFinalizedFile(physical.finalize, saved, caller, { ...observation, retention: policy }) } satisfies FileJourneyBindings);
      const receiver = { app: scope.app, owner: team.team_id, team: team.team_id, principal: user.user_id }, bytes = new TextEncoder().encode('Original invoice source export');
      const intent = createUploadIntent(physical.upload, { receiver, binding: { adapter: 'deployment.web', deliveryId: 'source', resultPath: 'source_evidence' },
        request: { upload_id: 'source', operation: 'invoice.retain_legacy_booking', field: '/source_evidence', arguments: {}, name: 'source.txt', type: 'text/plain', size: String(bytes.length) } });
      assert.ok(intent.status === 'granted'); assert.equal(appendUploadContentAtOffset(physical.upload, intent.intentId, receiver, bytes, 0).status, 'appended');
      assert.equal(completeUploadContent(physical.upload, intent.intentId, receiver).status, 'completed');
      const finalized = finalizeUpload(physical.finalize, { intentId: intent.intentId, retryId: 'source', bytesDigest: sha256Hex(bytes), caller: receiver }); assert.ok(finalized.status === 'finalized');
      const sourceEvidence = { id: finalized.result.file }, imported = new Date(now - 10000).toISOString();
      const worker = { ...globalAnyRow('worker', globalAnyEmployee(user.user_id, mode === 'foreign-location' ? 'other' : 'site')), archivedAt: mode === 'actor-archived' ? now - 1000 : null };
      const invoiceData = { source: 'vendor-w', external_id: 'I-8', location: { id: 'site' },
        facts: { customer_source: null, customer_external_id: null, number: '2021-8', issuer: 'Original operator', recipient: 'Original billed party', issued_original: '2021-05-12 09:00',
          issued_at: '2021-05-12T09:00:00.000Z', due_original: null, due: null, status: 'Issued', payment: 'Paid', amount: { minor: '1000', currency: 'EUR' },
          booking_count: ['null-count', 'archived-duplicate', 'current-duplicate', 'duplicate-phantom'].includes(mode) ? null : mode === 'zero-count' ? '0' : ['archived-spare', 'distinct-edge'].includes(mode) ? '2' : '1' },
        document: null, document_issue: 'Original invoice document not transferred', source_evidence: sourceEvidence, attestation: 'Source export verified', customer: null,
        mapping_reason: null, imported_by: { id: user.user_id }, imported_at: imported };
      const entry = globalAnyRow('invoice', invoiceData), other = globalAnyRow('other-invoice', { ...invoiceData, external_id: 'I-9' });
      const existing = { ...globalAnyRow('old-edge', { booking_source: 'vendor-w', booking_external_id: ['archived-duplicate', 'current-duplicate', 'scoped-parent', 'duplicate-phantom'].includes(mode) ? 'B-18' : 'B-17',
        source_evidence: sourceEvidence, attestation: 'Original edge retained', booking: null, mapping_reason: 'Booking source record not transferred', imported_by: { id: user.user_id }, imported_at: imported },
        { model: asModel('invoice.LegacyInvoice'), id: mode === 'scoped-parent' ? other.id : entry.id }),
        archivedAt: ['current-duplicate', 'distinct-edge'].includes(mode) ? null : now - 1000 };
      const hasExisting = ['archived-capacity', 'archived-spare', 'null-count', 'scoped-parent', 'distinct-edge', 'archived-duplicate', 'current-duplicate'].includes(mode);
      await store.commit(makeBatch(await store.readRevision(), { writes: [
        ...['site', 'other'].map(id => ({ kind: 'insert' as const, model: asModel('rent_catalog.Location'), row: globalAnySite(id) })),
        { kind: 'insert', model: asModel('employee.Employee'), row: worker },
        ...[entry, other].map(row => ({ kind: 'insert' as const, model: asModel('invoice.LegacyInvoice'), row })),
        ...(hasExisting ? [{ kind: 'insert' as const, model: asModel('invoice.LegacyInvoiceBooking'), row: existing }] : []),
      ] }));
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now, files: createCanonicalFileBinding(kernel, retention) });
      if (['archived-capacity', 'archived-duplicate'].includes(mode)) {
        const read = await invoker.invokeRead({ operation: 'invoice.LegacyInvoiceBooking.read', inputs: {} }, identity);
        assert.ok('result' in read, JSON.stringify(read)); assert.equal((read.result as { records: unknown[] }).records.length, 0,
          'ordinary child reads exclude archives even when source control includes them');
      }
      const commit = store.commit.bind(store), query = store.query.bind(store); let injected = false;
      if (mode === 'membership-revoked') store.query = async request => {
        const rows = await query(request);
        if (!injected && request.model === 'invoice.LegacyInvoiceBooking') { injected = true; await identities.removeMembership(membership.membership_id); }
        return rows;
      };
      if (mode === 'count-phantom' || mode === 'duplicate-phantom') store.commit = async batch => {
        if (!injected && batch.writes.some(write => write.model === 'invoice.LegacyInvoiceBooking')) {
          injected = true; await commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: asModel('invoice.LegacyInvoiceBooking'), row: existing }] }));
        }
        return commit(batch);
      };
      const request = { operation: 'invoice.retain_legacy_booking', operation_id: operationId(now), inputs: {
        entry: { id: entry.id, version: mode === 'stale' ? '2' : '1' }, booking_source: 'vendor-w', booking_external_id: 'B-18', source_evidence: sourceEvidence,
        attestation: mode === 'blank-attestation' ? '   ' : ' Actual edge from source export ', reason: ' Booking source record not yet transferred ' } };
      const outcome = await invoker.invokeMutation(request, identity); store.commit = commit; store.query = query;
      const allowed = ['allowed', 'archived-spare', 'null-count', 'scoped-parent', 'distinct-edge'].includes(mode);
      assert.equal('result' in outcome, allowed, mode + ': ' + JSON.stringify(outcome));
      const rows = await store.query({ model: asModel('invoice.LegacyInvoiceBooking'), authority: 'owner', archived: 'include', order: [{ field: 'id', direction: 'asc' }] });
      assert.deepEqual(await store.load(asModel('invoice.LegacyInvoice'), entry.id), entry, 'retention leaves original invoice facts unchanged');
      assert.deepEqual(await store.load(asModel('invoice.LegacyInvoice'), other.id), other);
      assert.deepEqual(probe.outboxAll(), [], 'original retention emits no Work or service effect');
      if (allowed) {
        assert.ok('result' in outcome); assert.equal(outcome.result.status, 'committed');
        const created = rows.find(row => row.id !== existing.id); assert.ok(created); assert.equal(rows.length, hasExisting ? 2 : 1);
        assert.deepEqual(created.parent, { model: asModel('invoice.LegacyInvoice'), id: entry.id });
        assert.deepEqual(created.data, { booking_source: 'vendor-w', booking_external_id: 'B-18', source_evidence: sourceEvidence,
          attestation: 'Actual edge from source export', booking: null, mapping_reason: 'Booking source record not yet transferred', imported_by: { id: user.user_id }, imported_at: new Date(now).toISOString() });
        const retained = await readCurrentFinalizedBytes(physical.finalize, finalized.result.file, receiver, observation); assert.ok(retained); assert.deepEqual(retained, bytes);
        const replay = await invoker.invokeMutation(request, identity); assert.ok('result' in replay, mode + ': ' + JSON.stringify(replay)); assert.equal(replay.result.status, 'replayed');
        assert.deepEqual(await store.query({ model: asModel('invoice.LegacyInvoiceBooking'), authority: 'owner', archived: 'include', order: [{ field: 'id', direction: 'asc' }] }), rows);
      } else {
        if (['archived-capacity', 'archived-duplicate', 'current-duplicate', 'zero-count', 'foreign-location', 'actor-archived', 'blank-attestation'].includes(mode)) {
          assert.ok('error' in outcome); assert.equal(outcome.error.code, 'rule_failed', mode + ': ' + JSON.stringify(outcome));
        }
        assert.equal(rows.length, hasExisting || ['count-phantom', 'duplicate-phantom'].includes(mode) ? 1 : 0, mode + ': no partial new booking link');
        if (['count-phantom', 'duplicate-phantom', 'membership-revoked'].includes(mode)) assert.equal(injected, true, mode);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});


it('qualifies original historical Expense retention with optional finalized receipt and atomic File effects', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-expense-retain-original-'));
  try {
    const source = await originalLegacyLinkSource(directory, 'retain_legacy');
    const original = await readFile(source, 'utf8');
    const firstGuard = 'require can_work(actor,location) and trim(source)!=""';
    assert.ok(original.includes(firstGuard));
    for (const [name, text] of [
      ['guard', original.replace(firstGuard, firstGuard + ' and claim.status!="Unread"')],
      ['helper', original.replace(' When', '  derive claim_present(value:LegacyClaim):bool = value.status!=null\n When')
        .replace(firstGuard, firstGuard + ' and claim_present(claim)')],
      ['if', original.replace('    create LegacyExpense', '    if claim.status!=null\n     require true\n    create LegacyExpense')],
    ] as const) {
      const declined = join(directory, 'read-claim-' + name + '.can');
      await writeFile(declined, text);
      const result = spawnSync(compiler, ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog,
        declined, join(root, 'draft/shared/Employees.can'), join(root, 'draft/shared/Locations.can')],
        { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      assert.equal(result.error, undefined, name);
      assert.notEqual(result.status, 0, name + ': a read Contract must not be omitted');
      const report = JSON.parse(result.stdout) as { diagnostics?: { code: string }[]; artifact?: unknown; modules?: unknown };
      assert.ok(report.diagnostics?.some(item => item.code === 'E6008'), result.stdout);
      assert.equal(report.artifact, undefined); assert.equal(report.modules, undefined);
    }
    const { stdout } = await promisify(execFile)(compiler, ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog,
      source, join(root, 'draft/shared/Employees.can'), join(root, 'draft/shared/Locations.can')],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: join(directory, 'modules'),
      stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
    for (const mode of ['receipt', 'receipt-absent', 'archived-duplicate', 'current-duplicate', 'missing-receipt-issue', 'receipt-and-issue',
      'blank-source', 'blank-attestation', 'invalid-money', 'foreign-receipt', 'missing-role', 'foreign-location', 'membership-revoked', 'duplicate-phantom', 'commit-failure']) {
      const { now, identities, team, user, membership, identity } = await member('expense-retain-' + mode, mode === 'missing-role' ? [] : ['expense.finance']);
      const foreign = await identities.createUser({ email: 'foreign-' + mode + '@retain.test', password_hash: 'unused', email_verified: true });
      const scope = { app: 'CanExpense', owner: team.team_id, ownerPackage: 'expense' };
      const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app, stateStoreId: 'expense-retain-state', fileStoreId: 'expense-retain-files',
        receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
      const { store, probe } = createTestMemoryStorage(authority, [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
      await installNativeFileInventory({ artifact, asm, store, authority, scope, now: () => now,
        verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
      const clock = new TestOnlyManualClock(now), blobs = new TestOnlyMemoryBlobStore(), files = new TestOnlyMemoryFinalizedStore(), intents = new TestOnlyMemoryIntentStore();
      const physical = { clock, blobs, files, upload: { clock, intents, blobs, policy: DEFAULT_FILE_POLICY, intentIds: new TestOnlyCounterIntentIds(), intentTtlMs: 3600000, urlBase: 'https://invoice.test' },
        finalize: { clock, intents, blobs, files, fileIds: new TestOnlyCounterFileIds() } };
      const retention = { unattachedHorizonMs: 3600000, retentionMs: 86400000 }, observation = { policy: physical.upload.policy, retention };
      const kernel = createFileJourneyKernel({ maxBytes: physical.upload.policy.maxBytes, createIntent: input => createUploadIntent(physical.upload, input),
        append: (id, caller, bytes, offset) => appendUploadContentAtOffset(physical.upload, id, caller, bytes, offset), complete: (id, caller) => completeUploadContent(physical.upload, id, caller),
        finalize: input => finalizeUpload(physical.finalize, input), authorizeAttach: (ref, caller) => authorizeAttach(physical.finalize, ref, caller),
        readProvenance: (ref, caller) => readFinalizedFile(physical.finalize, ref, caller), recordAttachment: (ref, record, caller) => recordAttachment(physical.finalize, ref, record, caller),
        readBytes: (ref, caller) => readFinalizedBytes(physical.finalize, ref, caller), readCurrentBytes: (ref, caller, policy) => readCurrentFinalizedBytes(physical.finalize, ref, caller, { ...observation, retention: policy }),
        readCurrentSnapshot: (ref, caller, policy) => readCurrentFinalizedSnapshot(physical.finalize, ref, caller, { ...observation, retention: policy }),
        observeFile: (ref, caller, policy) => observeFinalizedFile(physical.finalize, ref, caller, { ...observation, retention: policy }),
        revalidateFile: (saved, caller, policy) => revalidateRetainedFinalizedFile(physical.finalize, saved, caller, { ...observation, retention: policy }) } satisfies FileJourneyBindings);

      const receiver = { app: scope.app, owner: team.team_id, team: team.team_id, principal: user.user_id };
      const upload = (name: string, field: string, owner = receiver) => {
        const bytes = new TextEncoder().encode('Original ' + name + ' evidence');
        const intent = createUploadIntent(physical.upload, { receiver: owner, binding: { adapter: 'deployment.web', deliveryId: name, resultPath: field },
          request: { upload_id: name, operation: 'expense.retain_legacy', field, arguments: {}, name: name + '.txt', type: 'text/plain', size: String(bytes.length) } });
        assert.ok(intent.status === 'granted'); assert.equal(appendUploadContentAtOffset(physical.upload, intent.intentId, owner, bytes, 0).status, 'appended');
        assert.equal(completeUploadContent(physical.upload, intent.intentId, owner).status, 'completed');
        const result = finalizeUpload(physical.finalize, { intentId: intent.intentId, retryId: name, bytesDigest: sha256Hex(bytes), caller: owner }); assert.ok(result.status === 'finalized');
        return { ref: result.result.file, bytes };
      };
      const sourceFile = upload('source', '/source_evidence');
      const receiptFile = upload('receipt', '/claim/receipt', mode === 'foreign-receipt' ? { ...receiver, principal: foreign.user_id } : receiver);
      const nullReceipt = mode === 'receipt-absent' || mode === 'missing-receipt-issue';
      const claim = { actor: 'Former employee 41', reviewer: 'Reviewer 8', decision_time_original: '2021-05-12 09:00', decided_at: '2021-05-12T09:00:00.000Z', paid: '2021-05-20',
        status: 'Paid', purpose: 'Historical travel', amount: { minor: mode === 'invalid-money' ? 'invalid' : '2500', currency: 'EUR' },
        receipt: nullReceipt ? null : { id: receiptFile.ref }, receipt_issue: mode === 'receipt-absent' ? 'Original receipt absent from source export' : mode === 'receipt-and-issue' ? 'Conflicting receipt issue' : null };
      const existing = { ...globalAnyRow('historical', { source: 'vendor-a', external_id: 'old-18', location: { id: 'site' }, claim: { ...claim, amount: { minor: '2500', currency: 'EUR' } },
        source_evidence: { id: sourceFile.ref }, attestation: 'Previously retained original', claimant: null, access_reason: null,
        imported_by: { id: user.user_id }, imported_at: new Date(now - 10000).toISOString() }), archivedAt: mode === 'current-duplicate' ? null : now - 1000 };
      const seededDuplicate = mode === 'archived-duplicate' || mode === 'current-duplicate';
      await store.commit(makeBatch(await store.readRevision(), { writes: [
        ...['site', 'other'].map(id => ({ kind: 'insert' as const, model: asModel('rent_catalog.Location'), row: globalAnySite(id) })),
        { kind: 'insert', model: asModel('employee.Employee'), row: globalAnyRow('worker', globalAnyEmployee(user.user_id, mode === 'foreign-location' ? 'other' : 'site')) },
        ...(seededDuplicate ? [{ kind: 'insert' as const, model: asModel('expense.LegacyExpense'), row: existing }] : []),
      ] }));
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now, files: createCanonicalFileBinding(kernel, retention) });
      if (mode === 'archived-duplicate') {
        const read = await invoker.invokeRead({ operation: 'expense.LegacyExpense.read', inputs: {} }, identity); assert.ok('result' in read, JSON.stringify(read));
        assert.equal((read.result as { records: unknown[] }).records.length, 0, 'ordinary history read excludes the archived duplicate');
      }
      const beforeFiles = structuredClone(files.listAll()), commit = store.commit.bind(store), query = store.query.bind(store); let injected = false;
      if (mode === 'membership-revoked') store.query = async request => {
        const rows = await query(request);
        if (!injected && request.model === 'expense.LegacyExpense') { injected = true; await identities.removeMembership(membership.membership_id); }
        return rows;
      };
      if (mode === 'duplicate-phantom' || mode === 'commit-failure') store.commit = async batch => {
        if (!injected && batch.writes.some(write => write.kind === 'insert' && write.model === 'expense.LegacyExpense')) {
          injected = true;
          if (mode === 'commit-failure') throw new Error('Injected actual final transaction refusal.');
          await commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: asModel('expense.LegacyExpense'), row: existing }] }));
        }
        return commit(batch);
      };
      const request = { operation: 'expense.retain_legacy', operation_id: operationId(now), inputs: {
        source: mode === 'blank-source' ? '   ' : ' vendor-a ', external_id: 'old-18', location: { id: 'site', version: '1' }, claim,
        source_evidence: { id: sourceFile.ref }, attestation: mode === 'blank-attestation' ? '   ' : ' Transcribed from retained export ' } };
      const outcome = await invoker.invokeMutation(request, identity); store.commit = commit; store.query = query;
      const allowed = mode === 'receipt' || mode === 'receipt-absent';
      assert.equal('result' in outcome, allowed, mode + ': ' + JSON.stringify(outcome));
      const rows = await store.query({ model: asModel('expense.LegacyExpense'), authority: 'owner', archived: 'include', order: [{ field: 'id', direction: 'asc' }] });
      assert.deepEqual(probe.outboxAll(), [], 'historical retention never recreates approval, payment or Work');
      if (allowed) {
        assert.ok('result' in outcome); assert.equal(outcome.result.status, 'committed'); assert.equal(rows.length, 1); const created = rows[0]!;
        assert.deepEqual(created.data, { source: 'vendor-a', external_id: 'old-18', location: { id: 'site' }, claim, source_evidence: { id: sourceFile.ref },
          attestation: 'Transcribed from retained export', claimant: null, access_reason: null, imported_by: { id: user.user_id }, imported_at: new Date(now).toISOString() });
        for (const file of [sourceFile, ...(nullReceipt ? [] : [receiptFile])]) {
          const bytes = await readCurrentFinalizedBytes(physical.finalize, file.ref, receiver, observation); assert.ok(bytes); assert.deepEqual(bytes, file.bytes);
          assert.equal(files.get(file.ref)?.state, 'attached', 'successful original CREATE records the actual attachment');
        }
        if (nullReceipt) assert.equal(files.get(receiptFile.ref)?.state, 'finalized', 'unused optional receipt is not attached');
        const attachments = structuredClone(files.listAll());
        const replay = await invoker.invokeMutation(request, identity); assert.ok('result' in replay, JSON.stringify(replay)); assert.equal(replay.result.status, 'replayed');
        assert.deepEqual(await store.query({ model: asModel('expense.LegacyExpense'), authority: 'owner', archived: 'include', order: [{ field: 'id', direction: 'asc' }] }), rows);
        assert.deepEqual(files.listAll(), attachments, 'exact replay neither renews nor duplicates attachments');
      } else {
        assert.equal(rows.length, seededDuplicate || mode === 'duplicate-phantom' ? 1 : 0, mode + ': failed retention leaves no newly created historical claim');
        assert.deepEqual(files.listAll(), beforeFiles, mode + ': refusal records no physical attachment');
        if (['archived-duplicate', 'current-duplicate', 'blank-source', 'blank-attestation', 'foreign-location'].includes(mode)) {
          assert.ok('error' in outcome); assert.equal(outcome.error.code, 'rule_failed', mode + ': ' + JSON.stringify(outcome));
        }
        if (['membership-revoked', 'duplicate-phantom', 'commit-failure'].includes(mode)) assert.equal(injected, true, mode);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});


async function originalReportRefreshSource(directory: string) {
  const original = await readFile(join(root, 'draft/apps/CanReport/CanReport.can'), 'utf8');
  const givenEnd = original.indexOf('  fixture utilization='), start = original.indexOf('  scenario refresh('), end = original.indexOf('  scenario result ', start);
  assert.ok(givenEnd > 0 && start > givenEnd && end > start);
  const source = join(directory, 'Report.can');
  await writeFile(source, original.slice(0, givenEnd) + ' When\n' + original.slice(start, end).trimEnd() + '\n Then\n');
  return source;
}

it('qualifies original report refresh with ordered model-array SEND and atomic Run creation', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-report-refresh-original-'));
  try {
    const source = await originalReportRefreshSource(directory);
    const { stdout } = await promisify(execFile)(compiler, ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog,
      source, join(root, 'draft/shared/Employees.can'), join(root, 'draft/shared/Locations.can')],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: join(directory, 'modules'),
      stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
    for (const mode of ['ordered', 'finance', 'finance-only-denied', 'cash-denied', 'empty', 'reversed', 'disabled', 'foreign-location',
      'missing-role', 'stale-definition', 'stale-location', 'archived-location', 'employee-race', 'definition-race', 'location-race', 'membership-revoked', 'commit-failure']) {
      const roles = mode === 'missing-role' ? [] : ['report.manager', ...(mode === 'finance' ? ['report.finance'] : [])];
      const { now, identities, team, user, membership, identity } = await member('report-refresh-' + mode, roles);
      const scope = { app: 'CanReport', owner: team.team_id, ownerPackage: 'report' };
      const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app, stateStoreId: 'report-state', fileStoreId: 'report-files',
        receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
      const { store, probe } = createTestMemoryStorage(authority, [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
      await installNativeFileInventory({ artifact, asm, store, authority, scope, now: () => now,
        verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
      const definition = globalAnyRow('definition', { name: 'Utilization', metric: mode === 'finance' || mode === 'cash-denied' ? 'cash' : 'booked_minutes',
        unit: 'room-minute', finance_only: mode === 'finance' || mode === 'finance-only-denied', inclusion: 'Confirmed minutes / saleable minutes', display_timezone: 'UTC', enabled: mode !== 'disabled' });
      const worker = globalAnyRow('worker', { ...globalAnyEmployee(user.user_id), locations: mode === 'foreign-location' ? [] : [{ id: 'other' }] });
      const site = globalAnySite('site'), other = { ...globalAnySite('other'), archivedAt: mode === 'archived-location' ? now - 1000 : null };
      await store.commit(makeBatch(await store.readRevision(), { writes: [
        { kind: 'insert', model: asModel('report.Definition'), row: definition },
        { kind: 'insert', model: asModel('employee.Employee'), row: worker },
        ...[site, other].map(row => ({ kind: 'insert' as const, model: asModel('rent_catalog.Location'), row })),
      ] }));
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
      const commit = store.commit.bind(store), load = store.load.bind(store); let injected = false;
      if (mode === 'membership-revoked') store.load = async (modelName, id) => {
        const row = await load(modelName, id);
        if (!injected && modelName === 'work.dispatch') { injected = true; await identities.removeMembership(membership.membership_id); }
        return row;
      };
      if (['employee-race', 'definition-race', 'location-race', 'commit-failure'].includes(mode)) store.commit = async batch => {
        if (!injected && batch.writes.some(write => write.kind === 'insert' && write.model === 'report.Run')) {
          injected = true;
          assert.ok(batch.writes.some(write => write.model === 'work.dispatch'), 'actual SEND is staged in the same final transaction as Run');
          assert.equal(batch.outbox?.length, 1, 'actual configured report intent joins the Run transaction');
          if (mode === 'commit-failure') throw new Error('Injected report transaction refusal.');
          const row = mode === 'employee-race' ? worker : mode === 'definition-race' ? definition : other;
          const modelName = asModel(mode === 'employee-race' ? 'employee.Employee' : mode === 'definition-race' ? 'report.Definition' : 'rent_catalog.Location');
          await commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update', model: modelName, id: row.id, expectedVersion: row.version,
            row: { ...row, version: asVersion(row.version + 1), ...(mode === 'location-race' ? { archivedAt: now } : {}),
              data: mode === 'employee-race' ? { ...row.data, active: false } : mode === 'definition-race' ? { ...row.data, enabled: false } : row.data } }] }));
        }
        return commit(batch);
      };
      const ids = mode === 'empty' ? [] : ['other', 'site', 'other'];
      const from = new Date(now - 86400000).toISOString(), until = new Date(now).toISOString();
      const request = { operation: 'report.refresh', operation_id: operationId(now), inputs: {
        definition: { id: definition.id, version: mode === 'stale-definition' ? '2' : '1' },
        locations: ids.map(id => ({ id, version: mode === 'stale-location' && id === 'other' ? '2' : '1' })),
        from, until: mode === 'reversed' ? from : until, currency: mode === 'finance' ? 'EUR' : null } };
      const outcome = await invoker.invokeMutation(request, identity); store.commit = commit; store.load = load;
      const allowed = mode === 'ordered' || mode === 'finance';
      assert.equal('result' in outcome, allowed, mode + ': ' + JSON.stringify(outcome));
      const snapshot = async () => ({ runs: await store.query({ model: asModel('report.Run'), authority: 'owner' }),
        dispatches: await store.query({ model: asModel('work.dispatch'), authority: 'owner' }), outbox: probe.outboxAll() });
      const state = await snapshot();
      assert.equal(state.runs.length, allowed ? 1 : 0, mode); assert.equal(state.dispatches.length, allowed ? 1 : 0, mode); assert.equal(state.outbox.length, allowed ? 1 : 0, mode);
      if (allowed) {
        assert.ok('result' in outcome); assert.equal(outcome.result.status, 'committed');
        const run = state.runs[0]!, dispatch = state.dispatches[0]!, intent = state.outbox[0]!;
        assert.deepEqual(run.parent, { model: asModel('report.Definition'), id: definition.id });
        assert.deepEqual(run.data, { account: { id: user.user_id }, locations: ids.map(id => ({ id })), from, until, currency: request.inputs.currency,
          requested: new Date(now).toISOString(), delivery: dispatch.id, checkpoint: null, rows: [], state: 'unavailable', pending: true });
        assert.equal(intent.intentId, dispatch.id); assert.equal(intent.target, 'report.ReportsV1.reports');
        assert.deepEqual(intent.arguments, { binding: 'report.Reports', from: 'deployment.reports', arguments: { locations: ids, from, until } },
          'original model-array SELECT preserves ordered duplicate IDs in the actual SEND');
        const read = await invoker.invokeRead({ operation: 'report.Run.read', inputs: {} }, identity); assert.ok('result' in read, JSON.stringify(read));
        assert.equal((read.result as { records: unknown[] }).records.length, 1, 'original Run policy admits its current requesting manager');
        const replay = await invoker.invokeMutation(request, identity); assert.ok('result' in replay, JSON.stringify(replay)); assert.equal(replay.result.status, 'replayed');
        assert.deepEqual(await snapshot(), state, 'exact replay creates neither another Run nor another report intent');
      } else {
        if (['empty', 'reversed', 'disabled', 'foreign-location'].includes(mode)) {
          assert.ok('error' in outcome); assert.equal(outcome.error.code, 'rule_failed', mode + ': ' + JSON.stringify(outcome));
        }
        if (['employee-race', 'definition-race', 'location-race', 'membership-revoked', 'commit-failure'].includes(mode)) assert.equal(injected, true, mode);
      }
      if (mode !== 'definition-race') assert.deepEqual(await store.load(asModel('report.Definition'), definition.id), definition);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});


async function originalContractExecuteSource(directory: string) {
  const original = await readFile(join(root, 'draft/apps/CanContract/CanContract.can'), 'utf8');
  const customer = await readFile(join(root, 'draft/apps/CanCustomer/CanCustomer.can'), 'utf8');
  const supplier = await readFile(join(root, 'draft/shared/Suppliers.can'), 'utf8');
  const start = original.indexOf('  scenario execute('), end = original.indexOf('   examples', start), givenEnd = original.indexOf('  fixture signed_file=');
  assert.ok(givenEnd > 0 && start > givenEnd && end > start);
  const source = join(directory, 'Contract.can');
  await writeFile(source, original.slice(0, givenEnd) + original.split('\n').filter(line => line.startsWith('  message ')).join('\n') +
    '\n When\n' + original.slice(start, end).trimEnd() + '\n Then\n' +
    ['package customer', ' use rent_catalog {Location}', ' Given', ...customer.split('\n').filter(line =>
      line.startsWith('  export Customer {') || line.startsWith('  message label_Customer_kind_company =') || line.startsWith('  message label_Customer_locations =')),
    ' When', ' Then', ''].join('\n') + supplier.slice(0, supplier.indexOf('\n When')) + '\n When\n Then\n');
  return source;
}

it('executes the original agreement snapshot and calendar Work schedules with finalized signed evidence', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-contract-execute-original-'));
  try {
    const source = await originalContractExecuteSource(directory);
    const { stdout } = await promisify(execFile)(compiler, ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog,
      source, join(root, 'draft/shared/Employees.can'), join(root, 'draft/shared/Locations.can')],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: join(directory, 'modules'),
      stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
    for (const mode of ['future', 'notice-past', 'past', 'dst', 'calendar-gap', 'calendar-overflow', 'inactive-agreement', 'already-executed',
      'wrong-role', 'foreign-location', 'inactive-worker', 'owner-archived', 'stale', 'employee-race', 'parent-race', 'membership-revoked', 'commit-failure']) {
      const { now, identities, team, user, membership, identity } = await member('contract-execute-' + mode, mode === 'wrong-role' ? ['agreements.property_manager'] : ['agreements.legal']);
      const owner = await identities.createUser({ email: 'responsible-' + mode + '@contract.test', password_hash: 'unused', email_verified: true });
      const scope = { app: 'CanContract', owner: team.team_id, ownerPackage: 'agreements' };
      const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app, stateStoreId: 'contract-execute-state', fileStoreId: 'contract-execute-files',
        receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
      const { store, probe } = createTestMemoryStorage(authority, [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
      await installNativeFileInventory({ artifact, asm, store, authority, scope, now: () => now,
        verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
      const clock = new TestOnlyManualClock(now), blobs = new TestOnlyMemoryBlobStore(), files = new TestOnlyMemoryFinalizedStore(), intents = new TestOnlyMemoryIntentStore();
      const physical = { clock, blobs, files, upload: { clock, intents, blobs, policy: DEFAULT_FILE_POLICY, intentIds: new TestOnlyCounterIntentIds(), intentTtlMs: 3600000, urlBase: 'https://invoice.test' },
        finalize: { clock, intents, blobs, files, fileIds: new TestOnlyCounterFileIds() } };
      const retention = { unattachedHorizonMs: 3600000, retentionMs: 86400000 }, observation = { policy: physical.upload.policy, retention };
      const kernel = createFileJourneyKernel({ maxBytes: physical.upload.policy.maxBytes, createIntent: input => createUploadIntent(physical.upload, input),
        append: (id, caller, bytes, offset) => appendUploadContentAtOffset(physical.upload, id, caller, bytes, offset), complete: (id, caller) => completeUploadContent(physical.upload, id, caller),
        finalize: input => finalizeUpload(physical.finalize, input), authorizeAttach: (ref, caller) => authorizeAttach(physical.finalize, ref, caller),
        readProvenance: (ref, caller) => readFinalizedFile(physical.finalize, ref, caller), recordAttachment: (ref, record, caller) => recordAttachment(physical.finalize, ref, record, caller),
        readBytes: (ref, caller) => readFinalizedBytes(physical.finalize, ref, caller), readCurrentBytes: (ref, caller, policy) => readCurrentFinalizedBytes(physical.finalize, ref, caller, { ...observation, retention: policy }),
        readCurrentSnapshot: (ref, caller, policy) => readCurrentFinalizedSnapshot(physical.finalize, ref, caller, { ...observation, retention: policy }),
        observeFile: (ref, caller, policy) => observeFinalizedFile(physical.finalize, ref, caller, { ...observation, retention: policy }),
        revalidateFile: (saved, caller, policy) => revalidateRetainedFinalizedFile(physical.finalize, saved, caller, { ...observation, retention: policy }) } satisfies FileJourneyBindings);

      const receiver = { app: scope.app, owner: team.team_id, team: team.team_id, principal: user.user_id }, bytes = new TextEncoder().encode('Original signed agreement');
      const intent = createUploadIntent(physical.upload, { receiver, binding: { adapter: 'deployment.web', deliveryId: 'signed', resultPath: 'file' },
        request: { upload_id: 'signed', operation: 'agreements.execute', field: '/file', arguments: {}, name: 'signed.txt', type: 'text/plain', size: String(bytes.length) } });
      assert.ok(intent.status === 'granted'); assert.equal(appendUploadContentAtOffset(physical.upload, intent.intentId, receiver, bytes, 0).status, 'appended');
      assert.equal(completeUploadContent(physical.upload, intent.intentId, receiver).status, 'completed');
      const finalized = finalizeUpload(physical.finalize, { intentId: intent.intentId, retryId: 'signed', bytesDigest: sha256Hex(bytes), caller: receiver }); assert.ok(finalized.status === 'finalized');
      const timezone = mode === 'dst' ? 'Europe/Brussels' : mode === 'calendar-gap' ? 'Pacific/Apia' : 'UTC';
      const site = globalAnyRow('site', { ...globalAnySite('site').data, timezone, address: 'Original signed address' });
      const worker = globalAnyRow('worker', { ...globalAnyEmployee(user.user_id, mode === 'foreign-location' ? 'other' : 'site'), active: mode !== 'inactive-worker' });
      const responsible = { ...globalAnyRow('responsible', globalAnyEmployee(owner.user_id)), archivedAt: mode === 'owner-archived' ? now - 1000 : null };
      const agreement = globalAnyRow('agreement', { title: 'Workspace lease', category: 'landlord', location: { id: site.id }, customer: null, supplier: null,
        counterparty: 'Property owner', owner: { id: responsible.id }, email: owner.email, resource: null, active: mode !== 'inactive-agreement' });
      const today = new Date(now).toISOString().slice(0, 10);
      const until = mode === 'past' ? new Date(now - 2 * 86400000).toISOString().slice(0, 10) : mode === 'notice-past' ? new Date(now + 86400000).toISOString().slice(0, 10) :
        mode === 'dst' ? '2099-03-29' : mode === 'calendar-gap' ? '2011-12-29' : '2099-12-31';
      const oldSnapshot = { title: 'Prior executed title', counterparty: 'Prior party', owner: { id: owner.user_id }, location: site.id, address: 'Prior address' };
      const term = globalAnyRow('term', { snapshot: mode === 'already-executed' ? oldSnapshot : null, timezone: mode === 'already-executed' ? timezone : null,
        executed_by: mode === 'already-executed' ? { id: user.user_id } : null, executed_at: mode === 'already-executed' ? new Date(now - 10000).toISOString() : null,
        expired: false, notice_suppressed: false, file: { id: finalized.result.file }, from: mode === 'calendar-gap' ? '2011-01-01' : mode === 'past' ? '2020-01-01' : today,
        until, notice_days: mode === 'calendar-overflow' ? '9223372036854775807' : mode === 'dst' ? '1' : '30', pricing: 'EUR 1000 monthly', currency: 'EUR', previous: null,
        executed: mode === 'already-executed', terminated: false, reason: null }, { model: asModel('agreements.Agreement'), id: agreement.id });
      await store.commit(makeBatch(await store.readRevision(), { writes: [
        { kind: 'insert', model: asModel('rent_catalog.Location'), row: site }, { kind: 'insert', model: asModel('rent_catalog.Location'), row: globalAnySite('other') },
        ...[worker, responsible].map(row => ({ kind: 'insert' as const, model: asModel('employee.Employee'), row })),
        { kind: 'insert', model: asModel('agreements.Agreement'), row: agreement }, { kind: 'insert', model: asModel('agreements.Term'), row: term },
      ] }));
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now, files: createCanonicalFileBinding(kernel, retention) });
      const commit = store.commit.bind(store), query = store.query.bind(store); let injected = false;
      if (mode === 'membership-revoked') store.query = async request => {
        const rows = await query(request);
        if (!injected && request.model === 'employee.Employee') { injected = true; await identities.removeMembership(membership.membership_id); }
        return rows;
      };
      if (['employee-race', 'parent-race', 'commit-failure'].includes(mode)) store.commit = async batch => {
        if (!injected && batch.writes.some(write => write.model === 'agreements.Term')) {
          injected = true;
          if (mode === 'commit-failure') {
            assert.equal(batch.writes.filter(write => write.model === 'work.schedule').length, 2, 'fault follows both genuine staged calendar schedules');
            throw new Error('Injected original agreement execution commit failure.');
          }
          const row = mode === 'employee-race' ? worker : agreement;
          await commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update', model: asModel(mode === 'employee-race' ? 'employee.Employee' : 'agreements.Agreement'),
            id: row.id, expectedVersion: row.version, row: { ...row, version: asVersion(row.version + 1),
              data: mode === 'employee-race' ? { ...row.data, active: false } : { ...row.data, location: { id: 'other' } } } }] }));
        }
        return commit(batch);
      };
      const scoped = (key: string) => [scope.app, scope.ownerPackage, scope.owner, key].map(encodeURIComponent).join('/');
      const snapshot = async () => ({ term: await store.load(asModel('agreements.Term'), term.id),
        schedules: await store.query({ model: asModel('work.schedule'), authority: 'owner', order: [{ field: 'id', direction: 'asc' }] }),
        supersessions: await store.query({ model: asModel('work.supersession'), authority: 'owner' }), outbox: probe.outboxAll() });
      const before = await snapshot(), beforeFiles = structuredClone(files.listAll());
      const request = { operation: 'agreements.execute', operation_id: operationId(now), inputs: { term: { id: term.id, version: mode === 'stale' ? '2' : '1' } } };
      const outcome = await invoker.invokeMutation(request, identity); store.commit = commit; store.query = query;
      const allowed = ['future', 'notice-past', 'past', 'dst'].includes(mode);
      assert.equal('result' in outcome, allowed, mode + ': ' + JSON.stringify(outcome));
      if (mode === 'calendar-gap' || mode === 'calendar-overflow') {
        assert.ok('error' in outcome);
        assert.equal(outcome.error.code, 'rule_failed');
        assert.match(outcome.error.message, mode === 'calendar-gap' ? /DST gap/ : /add_days result outside 0001-9999/);
      }
      if (allowed) {
        assert.ok('result' in outcome); assert.equal(outcome.result.status, 'committed');
        const after = await snapshot(); assert.ok(after.term); assert.equal(after.term.version, term.version + 1);
        assert.deepEqual(after.term.data, { ...term.data, executed: true, timezone, executed_by: { id: user.user_id }, executed_at: new Date(now).toISOString(),
          expired: mode === 'past', snapshot: { title: agreement.data.title, counterparty: agreement.data.counterparty, owner: { id: owner.user_id }, location: site.id, address: site.data.address } });
        const expiry = probe.scheduleGet(scoped('term-expiry-' + term.id)), notice = probe.scheduleGet(scoped(term.id));
        if (mode === 'past') { assert.equal(expiry, null); assert.equal(notice, null); }
        else {
          assert.ok(expiry); assert.equal(expiry.event, 'agreements.Expire');
          const expectedExpiry = mode === 'dst' ? Date.parse('2099-03-29T22:00:00.000Z') : Date.parse(until + 'T00:00:00.000Z') + 86400000;
          assert.equal(expiry.at, expectedExpiry);
          assert.deepEqual(expiry.payload, { term: { id: term.id, version: '2' }, at: new Date(expectedExpiry).toISOString() });
          if (mode === 'notice-past') assert.equal(notice, null);
          else { assert.ok(notice); assert.equal(notice.event, 'agreements.Notice');
            assert.equal(notice.at, mode === 'dst' ? Date.parse('2099-03-27T23:00:00.000Z') : Date.parse(until + 'T00:00:00.000Z') - 30 * 86400000);
            assert.deepEqual(notice.payload, { term: { id: term.id, version: '2' }, revision: '2' });
            if (mode === 'dst') assert.equal(expiry.at - notice.at, 47 * 3600000, 'calendar midnight arithmetic crosses the actual DST boundary'); }
        }
        assert.equal(after.schedules.length, mode === 'past' ? 0 : mode === 'notice-past' ? 1 : 2);
        const retained = await readCurrentFinalizedBytes(physical.finalize, finalized.result.file, receiver, observation); assert.ok(retained); assert.deepEqual(retained, bytes);
        const attachments = structuredClone(files.listAll()), replay = await invoker.invokeMutation(request, identity);
        assert.ok('result' in replay, JSON.stringify(replay)); assert.equal(replay.result.status, 'replayed'); assert.deepEqual(await snapshot(), after); assert.deepEqual(files.listAll(), attachments);
      } else {
        assert.deepEqual(await snapshot(), before, mode + ': no partial execution, snapshot or calendar Work survives refusal');
        assert.deepEqual(files.listAll(), beforeFiles, mode + ': signed file lifecycle is unchanged');
        if (['employee-race', 'parent-race', 'membership-revoked', 'commit-failure'].includes(mode)) assert.equal(injected, true, mode);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});


async function originalDeskSource(directory: string, operation: 'open_request' | 'triage' = 'open_request') {
  const original = await readFile(join(root, 'draft/apps/CanDesk/CanDesk.can'), 'utf8');
  const customer = await readFile(join(root, 'draft/apps/CanCustomer/CanCustomer.can'), 'utf8');
  const invoice = await readFile(join(root, 'draft/apps/CanInvoice/CanInvoice.can'), 'utf8');
  const declaration = original.indexOf('scenario ' + operation + '(');
  const start = original.lastIndexOf('\n', declaration) + 1;
  const end = operation === 'triage' ? original.indexOf('  # Escalate', start) : original.indexOf('   examples', start);
  assert.ok(start > 0 && end > start);
  const text = ['app CanDesk uses=[desk]', 'package desk', ' use customer {Customer,owns,has_role}', ' use rent_catalog {Location' + (operation === 'triage' ? ',test_site' : '') + '}',
    ' use employee {can_work,staff' + (operation === 'triage' ? ',test_worker' : '') + '}', ' use rent_reservations {Booking}', ' use member_terms {Membership}', ' use invoice {Invoice}', ' use maintain {Repair}',
    ' use std {DeliveryResult}', ' use std {EmailV1 as Mail} from=deployment.mail', ' use desk {InboxV1 as Inbox} from=deployment.support_inbox',
    original.slice(original.indexOf(' Given\n'), original.indexOf('  fixture conversation=')),
    ...(operation === 'triage' ? original.split('\n').filter(line => ['conversation', 'document', 'received_message', 'unmatched'].some(name => line.startsWith('  fixture ' + name + '='))) : []),
    ...original.split('\n').filter(line => line.startsWith('  message ')), ' When', original.slice(start, end).trimEnd(), ' Then',
    'package customer', ' use rent_catalog {Location}', ' use employee {can_work}', ' use invoice {finance}', ' use std {EmailV1 as Mail} from=deployment.mail',
    customer.slice(customer.indexOf(' Given\n'), customer.indexOf('  export fixture test_directory_manager=')),
    ...customer.split('\n').filter(line => line.startsWith('  message ')), ' When', ' Then',
    // These nullable reference targets remain unpopulated in both selected intake workflows.
    'package invoice', ' Given', invoice.split('\n').find(line => line.startsWith('  export role finance '))!, '  export Invoice {source:text}', ' When', ' Then',
    ...[['rent_reservations', 'Booking'], ['member_terms', 'Membership'], ['maintain', 'Repair']].flatMap(([owner, name]) =>
      ['package ' + owner, ' Given', '  export ' + name + ' {source:text}', ' When', ' Then']), ''].join('\n');
  const source = join(directory, 'Desk.can'); await writeFile(source, text); return source;
}

it('opens the original customer support request with scoped membership and archived spam control', { timeout: 360000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-desk-open-original-'));
  try {
    const source = await originalDeskSource(directory);
    const { stdout } = await promisify(execFile)(compiler, ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog,
      source, join(root, 'draft/shared/Employees.can'), join(root, 'draft/shared/Locations.can')],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: join(directory, 'modules'),
      stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
    for (const mode of ['null-client', 'default-priority', 'low-priority', 'invalid-priority', 'oversize-subject', 'owned', 'administrator', 'booker', 'support', 'inactive-client', 'outside-client', 'nonowned', 'billing-only',
      'unverified', 'inactive-location', 'spam19', 'spam20', 'old-boundary', 'other-email', 'no-attachments', 'foreign-attachment', 'blank-body', 'stale-client',
      'client-race', 'grant-race', 'membership-revoked', 'spam-race', 'commit-failure']) {
      const { now, identities, team, user, membership, identity } = await member('desk-open-' + mode, mode === 'support' ? ['desk.support'] : [], mode !== 'unverified');
      const foreign = await identities.createUser({ email: 'other-' + mode + '@desk.test', password_hash: 'unused', email_verified: true });
      const scope = { app: 'CanDesk', owner: team.team_id, ownerPackage: 'desk' };
      const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app, stateStoreId: 'desk-open-state', fileStoreId: 'desk-open-files',
        receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
      const { store, probe } = createTestMemoryStorage(authority, [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
      await installNativeFileInventory({ artifact, asm, store, authority, scope, now: () => now,
        verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
      const clock = new TestOnlyManualClock(now), blobs = new TestOnlyMemoryBlobStore(), files = new TestOnlyMemoryFinalizedStore(), intents = new TestOnlyMemoryIntentStore();
      const physical = { clock, blobs, files, upload: { clock, intents, blobs, policy: DEFAULT_FILE_POLICY, intentIds: new TestOnlyCounterIntentIds(), intentTtlMs: 3600000, urlBase: 'https://invoice.test' },
        finalize: { clock, intents, blobs, files, fileIds: new TestOnlyCounterFileIds() } };
      const retention = { unattachedHorizonMs: 3600000, retentionMs: 86400000 }, observation = { policy: physical.upload.policy, retention };
      const kernel = createFileJourneyKernel({ maxBytes: physical.upload.policy.maxBytes, createIntent: input => createUploadIntent(physical.upload, input),
        append: (id, caller, bytes, offset) => appendUploadContentAtOffset(physical.upload, id, caller, bytes, offset), complete: (id, caller) => completeUploadContent(physical.upload, id, caller),
        finalize: input => finalizeUpload(physical.finalize, input), authorizeAttach: (ref, caller) => authorizeAttach(physical.finalize, ref, caller),
        readProvenance: (ref, caller) => readFinalizedFile(physical.finalize, ref, caller), recordAttachment: (ref, record, caller) => recordAttachment(physical.finalize, ref, record, caller),
        readBytes: (ref, caller) => readFinalizedBytes(physical.finalize, ref, caller), readCurrentBytes: (ref, caller, policy) => readCurrentFinalizedBytes(physical.finalize, ref, caller, { ...observation, retention: policy }),
        readCurrentSnapshot: (ref, caller, policy) => readCurrentFinalizedSnapshot(physical.finalize, ref, caller, { ...observation, retention: policy }),
        observeFile: (ref, caller, policy) => observeFinalizedFile(physical.finalize, ref, caller, { ...observation, retention: policy }),
        revalidateFile: (saved, caller, policy) => revalidateRetainedFinalizedFile(physical.finalize, saved, caller, { ...observation, retention: policy }) } satisfies FileJourneyBindings);

      const receiver = { app: scope.app, owner: team.team_id, team: team.team_id, principal: user.user_id };
      const fileOwner = mode === 'foreign-attachment' ? { ...receiver, principal: foreign.user_id } : receiver;
      const bytes = new TextEncoder().encode('Private connectivity attachment');
      const upload = createUploadIntent(physical.upload, { receiver: fileOwner, binding: { adapter: 'deployment.web', deliveryId: 'attachment', resultPath: 'attachments' },
        request: { upload_id: 'attachment', operation: 'desk.open_request', field: '/attachments/0', arguments: {}, name: 'connection.txt', type: 'text/plain', size: String(bytes.length) } });
      assert.ok(upload.status === 'granted'); assert.equal(appendUploadContentAtOffset(physical.upload, upload.intentId, fileOwner, bytes, 0).status, 'appended');
      assert.equal(completeUploadContent(physical.upload, upload.intentId, fileOwner).status, 'completed');
      const finalized = finalizeUpload(physical.finalize, { intentId: upload.intentId, retryId: 'attachment', bytesDigest: sha256Hex(bytes), caller: fileOwner }); assert.ok(finalized.status === 'finalized');
      const site = globalAnyRow('site', { ...globalAnySite('site').data, active: mode !== 'inactive-location' });
      const company = ['administrator', 'booker', 'billing-only', 'grant-race'].includes(mode);
      const client = globalAnyRow('client', { name: 'Customer', kind: company ? 'company' : 'individual', locations: [{ id: mode === 'outside-client' ? 'other' : site.id }], active: mode !== 'inactive-client' });
      const contact = globalAnyRow('contact', { name: 'Customer', email: user.email, account: { id: mode === 'nonowned' ? foreign.user_id : user.user_id }, verified: true, phone: null, external_id: null },
        { model: asModel('customer.Customer'), id: client.id });
      const grant = globalAnyRow('grant', { account: { id: user.user_id }, role: mode === 'billing-only' ? 'billing' : mode === 'administrator' ? 'administrator' : 'booker', locations: [], active: true }, contact.parent);
      const ticketData = { location: { id: site.id }, customer: null, subject: 'Earlier request', email: user.email, thread: 'prior', category: 'Connectivity', priority: 'normal',
        assignee: null, queue: 'Private old routing', state: 'open', due: null, escalation: null, escalated_by: null, escalated_at: null, booking: null, membership: null, invoice: null, repair: null };
      const priorCount = mode === 'spam19' || mode === 'spam-race' ? 19 : ['spam20', 'old-boundary', 'other-email'].includes(mode) ? 20 : 0;
      const prior = (id: string) => ({ ...globalAnyRow(id, { ...ticketData, thread: id, email: mode === 'other-email' ? foreign.email : user.email }),
        created: mode === 'old-boundary' ? now - 86400000 : now - 1000, updated: now - 1000, archivedAt: now - 500 });
      await store.commit(makeBatch(await store.readRevision(), { writes: [
        { kind: 'insert', model: asModel('rent_catalog.Location'), row: site }, { kind: 'insert', model: asModel('rent_catalog.Location'), row: globalAnySite('other') },
        { kind: 'insert', model: asModel('employee.Employee'), row: globalAnyRow('worker', globalAnyEmployee(user.user_id)) },
        { kind: 'insert', model: asModel('customer.Customer'), row: client },
        company ? { kind: 'insert', model: asModel('customer.CompanyRole'), row: grant } : { kind: 'insert', model: asModel('customer.Contact'), row: contact },
        ...Array.from({ length: priorCount }, (_, index) => ({ kind: 'insert' as const, model: asModel('desk.Ticket'), row: prior('prior-' + index) })),
      ] }));
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now, files: createCanonicalFileBinding(kernel, retention) });
      if (mode === 'spam20') {
        const read = await invoker.invokeRead({ operation: 'desk.Ticket.read', inputs: {} }, identity); assert.ok('result' in read, JSON.stringify(read));
        assert.equal((read.result as { records: unknown[] }).records.length, 0, 'all rate-limit history is archived and withheld by default reads');
      }
      const snapshot = async () => ({ tickets: await store.query({ model: asModel('desk.Ticket'), authority: 'owner', archived: 'include', order: [{ field: 'id', direction: 'asc' }] }),
        messages: await store.query({ model: asModel('desk.Message'), authority: 'owner' }), outbox: probe.outboxAll() });
      const before = await snapshot(), beforeFiles = structuredClone(files.listAll()), commit = store.commit.bind(store), query = store.query.bind(store); let injected = false;
      if (mode === 'membership-revoked') store.query = async request => {
        const rows = await query(request);
        if (!injected && request.model === 'desk.Ticket') { injected = true; await identities.removeMembership(membership.membership_id); }
        return rows;
      };
      if (['client-race', 'grant-race', 'spam-race', 'commit-failure'].includes(mode)) store.commit = async batch => {
        if (!injected && batch.writes.some(write => write.kind === 'insert' && write.model === 'desk.Ticket')) {
          injected = true;
          assert.ok(batch.writes.some(write => write.kind === 'insert' && write.model === 'desk.Message'), 'actual Message and Ticket share final admission');
          if (mode === 'commit-failure') throw new Error('Injected support request transaction refusal.');
          if (mode === 'spam-race') await commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: asModel('desk.Ticket'), row: prior('concurrent') }] }));
          else {
            const row = mode === 'client-race' ? client : grant;
            await commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update', model: asModel(mode === 'client-race' ? 'customer.Customer' : 'customer.CompanyRole'),
              id: row.id, expectedVersion: row.version, row: { ...row, version: asVersion(row.version + 1), data: mode === 'client-race' ? { ...row.data, locations: [{ id: 'other' }] } : { ...row.data, active: false } } }] }));
          }
        }
        return commit(batch);
      };
      const nullClient = ['null-client', 'default-priority', 'low-priority', 'invalid-priority', 'oversize-subject', 'support', 'spam19', 'spam20', 'old-boundary', 'other-email', 'no-attachments', 'foreign-attachment', 'blank-body', 'membership-revoked', 'spam-race', 'commit-failure', 'unverified', 'inactive-location'].includes(mode);
      const priority = mode === 'default-priority' ? 'normal' : mode === 'low-priority' ? 'low' : mode === 'invalid-priority' ? 'unsupported' : 'urgent';
      const request = { operation: 'desk.open_request', operation_id: operationId(now), inputs: {
        location: { id: site.id, version: '1' }, subject: mode === 'oversize-subject' ? 'x'.repeat(301) : ' Wi-Fi ', body: mode === 'blank-body' ? '   ' : ' Cannot connect ', category: ' Connectivity ', ...(mode === 'default-priority' ? {} : { priority }),
        attachments: mode === 'no-attachments' ? [] : [{ id: finalized.result.file }], client: nullClient ? null : { id: client.id, version: mode === 'stale-client' ? '2' : '1' } } };
      const outcome = await invoker.invokeMutation(request, identity); store.commit = commit; store.query = query;
      const allowed = ['null-client', 'default-priority', 'low-priority', 'owned', 'administrator', 'booker', 'support', 'spam19', 'old-boundary', 'other-email', 'no-attachments'].includes(mode);
      assert.equal('result' in outcome, allowed, mode + ': ' + JSON.stringify(outcome)); const after = await snapshot();
      assert.deepEqual(after.outbox, [], 'opening a request sends no mail or unrelated business action');
      if (allowed) {
        assert.ok('result' in outcome); assert.equal(outcome.result.status, 'committed');
        const created = after.tickets.find(row => row.data.thread === request.operation_id); assert.ok(created); assert.equal(after.tickets.length, priorCount + 1);
        assert.deepEqual(created.data, { ...ticketData, subject: 'Wi-Fi', customer: nullClient ? null : { id: client.id }, thread: request.operation_id,
          category: ' Connectivity ', priority, queue: 'Reception' });
        assert.equal(after.messages.length, 1); const message = after.messages[0]!;
        assert.deepEqual(message.parent, { model: asModel('desk.Ticket'), id: created.id });
        assert.deepEqual(message.data, { external_id: 'web-' + request.operation_id, kind: 'customer', body: ' Cannot connect ', sender: user.email,
          recipient: null, author: { id: user.user_id }, attachments: request.inputs.attachments, delivery: null, state: null });
        assert.deepEqual(outcome.result.result, { id: created.id }, 'original model result discloses the admitted Ticket identity');
        const read = await invoker.invokeRead({ operation: 'desk.Ticket.read', inputs: {} }, identity); assert.ok('result' in read, JSON.stringify(read));
        const visible = (read.result as { records: { id: string; data: Record<string, unknown> }[] }).records.find(row => row.id === created.id); assert.ok(visible);
        const disclosed = { subject: 'Wi-Fi', category: ' Connectivity ', priority, state: 'open', email: user.email };
        if (mode === 'support') assert.equal(visible.data.queue, 'Reception');
        else { assert.deepEqual(visible.data, disclosed); const changed = (outcome.result.records as { id: string; data: Record<string, unknown> }[]).find(row => row.id === created.id); assert.ok(changed); assert.deepEqual(changed.data, disclosed, 'returned changed records retain the original field-limited policy'); }
        if (mode !== 'no-attachments') { const retained = await readCurrentFinalizedBytes(physical.finalize, finalized.result.file, receiver, observation); assert.ok(retained); assert.deepEqual(retained, bytes); assert.equal(files.get(finalized.result.file)?.state, 'attached'); }
        else assert.equal(files.get(finalized.result.file)?.state, 'finalized', 'empty attachment input leaves the unused finalized File unattached');
        const attached = structuredClone(files.listAll()), replay = await invoker.invokeMutation(request, identity);
        assert.ok('result' in replay, JSON.stringify(replay)); assert.equal(replay.result.status, 'replayed'); assert.deepEqual(await snapshot(), after); assert.deepEqual(files.listAll(), attached);
      } else {
        if (mode === 'spam-race') { assert.equal(after.tickets.length, priorCount + 1); assert.ok(after.tickets.some(row => row.id === 'concurrent')); assert.deepEqual(after.messages, []); }
        else assert.deepEqual(after, before, mode + ': no partial Ticket/Message survives refusal');
        assert.deepEqual(files.listAll(), beforeFiles, mode + ': refusal attaches no File');
        if (mode === 'invalid-priority' || mode === 'oversize-subject') { assert.ok('error' in outcome); assert.equal(outcome.error.code, 'validation', JSON.stringify(outcome)); }
        if (['inactive-client', 'outside-client', 'billing-only', 'unverified', 'inactive-location', 'blank-body', 'spam20'].includes(mode)) {
          assert.ok('error' in outcome); assert.equal(outcome.error.code, 'rule_failed', mode + ': ' + JSON.stringify(outcome));
        }
        if (['client-race', 'grant-race', 'spam-race', 'membership-revoked', 'commit-failure'].includes(mode)) assert.equal(injected, true, mode);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});


it('triages the original unmatched mail atomically with its stored default and finalized attachments', { timeout: 240000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-desk-triage-original-'));
  try {
    const source = await originalDeskSource(directory, 'triage');
    const { stdout } = await promisify(execFile)(compiler, ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog,
      source, join(root, 'draft/shared/Employees.can'), join(root, 'draft/shared/Locations.can')],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: join(directory, 'modules'),
      stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
    for (const mode of ['default-subject', 'explicit-subject', 'empty-attachments', 'other-message', 'duplicate', 'archived-duplicate', 'resolved',
      'no-role', 'inactive-worker', 'outside-location', 'inactive-location', 'stale-input', 'blank-category', 'blank-queue', 'blank-default',
      'oversize-subject', 'missing-file-producer', 'file-race', 'membership-race', 'worker-race', 'incoming-race', 'duplicate-race', 'commit-failure']) {
      const { now, identities, team, user, membership, identity } = await member('desk-triage-' + mode, mode === 'no-role' ? [] : ['desk.support']);
      const scope = { app: 'CanDesk', owner: team.team_id, ownerPackage: 'desk' };
      const authority: FileRetirementAuthority = { app: scope.app, stateOwner: scope.app, stateStoreId: 'desk-triage-state', fileStoreId: 'desk-triage-files',
        receiver: { app: scope.app, owner: team.team_id, team: team.team_id } };
      const { store, probe } = createTestMemoryStorage(authority, [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
      await installNativeFileInventory({ artifact, asm, store, authority, scope, now: () => now,
        verifyOwner: async () => { assert.ok(await identities.findTeamById(team.team_id)); } });
      const clock = new TestOnlyManualClock(now), blobs = new TestOnlyMemoryBlobStore(), files = new TestOnlyMemoryFinalizedStore(), intents = new TestOnlyMemoryIntentStore();
      const physical = { clock, blobs, files, upload: { clock, intents, blobs, policy: DEFAULT_FILE_POLICY, intentIds: new TestOnlyCounterIntentIds(), intentTtlMs: 3600000, urlBase: 'https://invoice.test' },
        finalize: { clock, intents, blobs, files, fileIds: new TestOnlyCounterFileIds() } };
      const retention = { unattachedHorizonMs: 3600000, retentionMs: 86400000 }, observation = { policy: physical.upload.policy, retention };
      const kernel = createFileJourneyKernel({ maxBytes: physical.upload.policy.maxBytes, createIntent: input => createUploadIntent(physical.upload, input),
        append: (id, caller, bytes, offset) => appendUploadContentAtOffset(physical.upload, id, caller, bytes, offset), complete: (id, caller) => completeUploadContent(physical.upload, id, caller),
        finalize: input => finalizeUpload(physical.finalize, input), authorizeAttach: (ref, caller) => authorizeAttach(physical.finalize, ref, caller),
        readProvenance: (ref, caller) => readFinalizedFile(physical.finalize, ref, caller), recordAttachment: (ref, record, caller) => recordAttachment(physical.finalize, ref, record, caller),
        readBytes: (ref, caller) => readFinalizedBytes(physical.finalize, ref, caller), readCurrentBytes: (ref, caller, policy) => readCurrentFinalizedBytes(physical.finalize, ref, caller, { ...observation, retention: policy }),
        readCurrentSnapshot: (ref, caller, policy) => readCurrentFinalizedSnapshot(physical.finalize, ref, caller, { ...observation, retention: policy }),
        observeFile: (ref, caller, policy) => observeFinalizedFile(physical.finalize, ref, caller, { ...observation, retention: policy }),
        revalidateFile: (saved, caller, policy) => revalidateRetainedFinalizedFile(physical.finalize, saved, caller, { ...observation, retention: policy }) } satisfies FileJourneyBindings);
      const receiver = { app: scope.app, owner: team.team_id, team: team.team_id, principal: user.user_id };
      const bytes = new TextEncoder().encode('Original unmatched mail evidence');
      const upload = createUploadIntent(physical.upload, { receiver, binding: { adapter: 'deployment.support_inbox', deliveryId: 'incoming', resultPath: 'attachments' },
        request: { upload_id: 'incoming', operation: 'desk.triage', field: '/attachments/0', arguments: {}, name: 'incoming.txt', type: 'text/plain', size: String(bytes.length) } });
      assert.ok(upload.status === 'granted'); assert.equal(appendUploadContentAtOffset(physical.upload, upload.intentId, receiver, bytes, 0).status, 'appended');
      assert.equal(completeUploadContent(physical.upload, upload.intentId, receiver).status, 'completed');
      const finalized = finalizeUpload(physical.finalize, { intentId: upload.intentId, retryId: 'incoming', bytesDigest: sha256Hex(bytes), caller: receiver }); assert.ok(finalized.status === 'finalized');
      const attachments = mode === 'empty-attachments' ? [] : [{ id: finalized.result.file }];
      const site = globalAnyRow('site', { ...globalAnySite('site').data, active: mode !== 'inactive-location' });
      const worker = globalAnyRow('worker', { ...globalAnyEmployee(user.user_id), active: mode !== 'inactive-worker', home: { id: mode === 'outside-location' ? 'other' : site.id }, locations: [] });
      const oldTicket = globalAnyRow('older-ticket', { location: { id: 'other' }, customer: null, subject: 'Older request', email: 'other@desk.test', thread: 'older-thread',
        category: 'Other', priority: 'normal', assignee: null, queue: 'Other', state: 'open', due: null, escalation: null, escalated_by: null, escalated_at: null,
        booking: null, membership: null, invoice: null, repair: null });
      const priorMessage = (id: string, externalId = 'inbound-id') => globalAnyRow(id, { external_id: externalId, kind: 'customer', body: 'Existing message', sender: 'sender@desk.test',
        recipient: 'support@desk.test', author: null, attachments: [], delivery: null }, { model: asModel('desk.Ticket'), id: oldTicket.id });
      const incoming = globalAnyRow('incoming', { external_id: 'inbound-id', sender: 'sender@desk.test', recipient: 'support@desk.test',
        subject: ['explicit-subject', 'blank-default'].includes(mode) ? '' : ' Incoming Wi-Fi ', body: ' Original mail body ', thread: 'untrusted-thread', attachments,
        state: mode === 'resolved' ? 'resolved' : 'pending', ticket: mode === 'resolved' ? { id: oldTicket.id } : null,
        resolved_by: mode === 'resolved' ? { id: user.user_id } : null, resolved_at: mode === 'resolved' ? new Date(now).toISOString() : null, received: new Date(now).toISOString() });
      const duplicate = ['duplicate', 'archived-duplicate', 'other-message'].includes(mode)
        ? { ...priorMessage('prior-message', mode === 'other-message' ? 'other-external-id' : 'inbound-id'), archivedAt: mode === 'archived-duplicate' ? now - 1 : null } : undefined;
      await store.commit(makeBatch(await store.readRevision(), { writes: [
        { kind: 'insert', model: asModel('rent_catalog.Location'), row: site }, { kind: 'insert', model: asModel('rent_catalog.Location'), row: globalAnySite('other') },
        { kind: 'insert', model: asModel('employee.Employee'), row: worker }, { kind: 'insert', model: asModel('desk.Ticket'), row: oldTicket },
        { kind: 'insert', model: asModel('desk.Unmatched'), row: incoming }, ...(duplicate ? [{ kind: 'insert' as const, model: asModel('desk.Message'), row: duplicate }] : []),
      ] }));
      const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now, ...(mode === 'missing-file-producer' ? {} : { files: createCanonicalFileBinding(kernel, retention) }) });
      const snapshot = async () => ({ tickets: await store.query({ model: asModel('desk.Ticket'), authority: 'owner', archived: 'include', order: [{ field: 'id', direction: 'asc' }] }),
        messages: await store.query({ model: asModel('desk.Message'), authority: 'owner', archived: 'include', order: [{ field: 'id', direction: 'asc' }] }),
        incoming: await store.load(asModel('desk.Unmatched'), incoming.id), outbox: probe.outboxAll() });
      const before = await snapshot(), beforeFiles = structuredClone(files.listAll()), commit = store.commit.bind(store), query = store.query.bind(store); let injected = false;
      if (['membership-race', 'file-race'].includes(mode)) store.query = async request => {
        const rows = await query(request);
        if (!injected && request.model === 'desk.Message') { injected = true;
          if (mode === 'file-race') blobs.remove(blobKeyForFile(finalized.result.file));
          else await identities.removeMembership(membership.membership_id);
        }
        return rows;
      };
      if (['worker-race', 'incoming-race', 'duplicate-race', 'commit-failure'].includes(mode)) store.commit = async batch => {
        if (!injected && batch.writes.some(write => write.kind === 'insert' && write.model === 'desk.Ticket')) {
          injected = true; assert.ok(batch.writes.some(write => write.kind === 'insert' && write.model === 'desk.Message'));
          assert.ok(batch.writes.some(write => write.kind === 'update' && write.model === 'desk.Unmatched'), 'triage stages its original incoming audit in the same transaction');
          if (mode === 'commit-failure') throw new Error('Injected triage transaction refusal.');
          if (mode === 'duplicate-race') await commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: asModel('desk.Message'), row: { ...priorMessage('concurrent-message'), archivedAt: now - 1 } }] }));
          else {
            const row = mode === 'worker-race' ? worker : incoming;
            await commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'update', model: asModel(mode === 'worker-race' ? 'employee.Employee' : 'desk.Unmatched'),
              id: row.id, expectedVersion: row.version, row: { ...row, version: asVersion(row.version + 1), data: mode === 'worker-race' ? { ...row.data, active: false }
                : { ...row.data, state: 'resolved', ticket: { id: oldTicket.id }, resolved_by: { id: user.user_id }, resolved_at: new Date(now).toISOString() } } }] }));
          }
        }
        return commit(batch);
      };
      const subject = mode === 'explicit-subject' ? { subject: ' Replacement subject ' } : mode === 'oversize-subject' ? { subject: 'x'.repeat(301) } : {};
      const request = { operation: 'desk.triage', operation_id: operationId(now), inputs: { incoming: { id: incoming.id, version: mode === 'stale-input' ? '2' : '1' },
        location: { id: site.id, version: '1' }, category: mode === 'blank-category' ? ' ' : ' Connectivity ', queue: mode === 'blank-queue' ? ' ' : ' Reception ', ...subject } };
      const outcome = await invoker.invokeMutation(request, identity); store.commit = commit; store.query = query;
      // The original triage guard checks can_work; it does not require location.active.
      const allowed = ['default-subject', 'explicit-subject', 'empty-attachments', 'other-message', 'inactive-location'].includes(mode);
      assert.equal('result' in outcome, allowed, mode + ': ' + JSON.stringify(outcome)); const after = await snapshot();
      assert.deepEqual(after.outbox, [], 'triage sends no mail');
      if (allowed) {
        assert.ok('result' in outcome); assert.equal(outcome.result.status, 'committed');
        const ticket = after.tickets.find(row => row.data.thread === request.operation_id); assert.ok(ticket); assert.equal(after.tickets.length, 2);
        assert.deepEqual(ticket.data, { ...oldTicket.data, location: { id: site.id }, subject: mode === 'explicit-subject' ? 'Replacement subject' : 'Incoming Wi-Fi',
          email: incoming.data.sender, thread: request.operation_id, category: ' Connectivity ', queue: ' Reception ' });
        const message = after.messages.find(row => row.parent?.id === ticket.id); assert.ok(message); assert.equal(after.messages.length, (duplicate ? 1 : 0) + 1);
        assert.deepEqual(message.data, { external_id: incoming.data.external_id, kind: 'customer', body: incoming.data.body, sender: incoming.data.sender,
          recipient: incoming.data.recipient, author: null, attachments, delivery: null, state: null });
        assert.deepEqual(after.incoming?.data, { ...incoming.data, state: 'resolved', ticket: { id: ticket.id }, resolved_by: { id: user.user_id }, resolved_at: new Date(now).toISOString() });
        assert.deepEqual(outcome.result.result, { id: ticket.id }); assert.deepEqual(await store.load(asModel('desk.Ticket'), oldTicket.id), oldTicket);
        if (attachments.length) { assert.deepEqual(await readCurrentFinalizedBytes(physical.finalize, finalized.result.file, receiver, observation), bytes); assert.equal(files.get(finalized.result.file)?.state, 'attached'); }
        const attached = structuredClone(files.listAll()), replay = await invoker.invokeMutation(request, identity);
        assert.ok('result' in replay, JSON.stringify(replay)); assert.equal(replay.result.status, 'replayed'); assert.deepEqual(await snapshot(), after); assert.deepEqual(files.listAll(), attached);
      } else {
        assert.deepEqual(after.tickets, before.tickets, mode + ': no partial Ticket');
        if (mode === 'duplicate-race') { assert.equal(after.messages.length, 1); assert.equal(after.messages[0]!.id, 'concurrent-message'); }
        else assert.deepEqual(after.messages, before.messages, mode + ': no partial Message');
        if (mode === 'incoming-race') { assert.equal(after.incoming?.version, incoming.version + 1); assert.deepEqual(after.incoming?.data.ticket, { id: oldTicket.id }); }
        else assert.deepEqual(after.incoming, before.incoming, mode + ': no partial triage audit');
        assert.deepEqual(files.listAll(), beforeFiles, mode + ': refusal attaches no File');
        if (['duplicate', 'archived-duplicate', 'resolved', 'inactive-worker', 'outside-location', 'blank-category', 'blank-queue'].includes(mode)) {
          assert.ok('error' in outcome); assert.equal(outcome.error.code, 'rule_failed', mode + ': ' + JSON.stringify(outcome));
        }
        if (['blank-default', 'oversize-subject'].includes(mode)) { assert.ok('error' in outcome); assert.equal(outcome.error.code, 'validation', JSON.stringify(outcome)); }
        if (['file-race', 'membership-race', 'worker-race', 'incoming-race', 'duplicate-race', 'commit-failure'].includes(mode)) assert.equal(injected, true, mode);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
