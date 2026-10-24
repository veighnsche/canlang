/** Current PromptLab source/saved closure -> native receipts -> canonical memory owner.
 * This is app permission/rollback/replay acceptance, not browser or activation coverage.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import type { CommitBatch, ModelName, MutationResult, OperationId, ProjectedRecord, RecordId, ResolvedIdentity, RowView, StoragePort } from '@canlang/contracts';
import { buildSessionCookie, resolveIdentity, setMemberRole, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { distribution } from '@canlang/values/distribution';
import { compileCapturedSingleFile } from './native-dev.test-support.js';
import { prepareLocalPreviewCapture } from './native-dev.test-support.js';
import { resolvePreviewRoles } from './native-preview.test-support.js';
import { captureIsCurrent, captureSingleFileSource } from './native-dev.test-support.js';
import { assembleWorker, buildInvoker } from '../worker/assembly.js';
import { catalogFromArtifactOperations, createSourceFormBindings, handleOperationRequest } from '@canlang/interfaces/http/operations';
import { handlePageRequest } from '@canlang/interfaces';
import type { HttpDeps, PageHttpDeps } from '@canlang/interfaces';
import { formatScalar, submitGeneratedForm } from '@canlang/ui';
import { createPageCursorCodec } from './page-cursor.js';
import { createPageReadScopeCanonical } from './invoke.js';
import { wrapNativeUiQueryFactory } from './native-ui-query.js';
import { assembleModules, importVerifiedAssemblyModule } from './modules.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const require = createRequire(join(root, 'package.json'));
const sourcePath = join(root, 'draft/apps/CanPromptLab/CanPromptLab.can');
const model = (name: string) => `prompt_lab.${name}` as ModelName;

function operationId(now: number): OperationId {
  const time = now.toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-8${random.slice(4, 7)}-${random.slice(7, 19)}` as OperationId;
}

test('actual PromptLab enforces member note boundaries, rolls back computed keys and replays native receipts', { timeout: 120_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'can-promptlab-native-'));
  try {
    const capture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: root,
      appPath: sourcePath, compilerPath: process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can'),
      catalogPath: fileURLToPath(distribution.catalog), helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md') }));
    const compiled = await compileCapturedSingleFile(capture);
    assert.equal(compiled.kind, 'artifact', JSON.stringify(compiled.kind === 'diagnostics' ? compiled.envelope.diagnostics : compiled.kind));
    if (compiled.kind !== 'artifact') throw new Error('Current PromptLab source/saved closure did not compile');
    const artifact = compiled.artifact;
    assert.equal(artifact.givenContracts?.keywords.length, 2, 'consume both actual canonical_identity applications');
    assert.equal(artifact.modelPolicies?.length, 2, 'consume the actual Entry/Tag archive invariants');
    const asm = await assembleModules({ artifact, sourcePath }, { workDir: join(scratch, 'assembly'),
      stdlibUrl: pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href });
    const appModule = artifact.modules.find(module => module.js.includes('export const appDefinition='));
    assert.ok(appModule, 'owning compiled app definition');
    const loaded = await importVerifiedAssemblyModule(asm, appModule.path, artifact) as { appDefinition: unknown };
    const roles = (await resolvePreviewRoles({ Ava: ['curator'] }, loaded.appDefinition)).Ava;
    assert.equal(roles?.length, 1, 'only the source-declared curator assignment');

    const now = Date.now(), clock = createFrozenClock(now), identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({});
    const account = async (name: string, owner = false) => {
      const user = await identities.createUser({ email: `${name}@promptlab-native.test`, password_hash: 'unused', email_verified: true });
      await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: owner, roles: [] });
      const token = randomBytes(32).toString('hex');
      await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        expires_at: new Date(now + 3_600_000).toISOString(), last_team_id: team.team_id });
      return { user, token, identity: await resolveIdentity(identities, { session_token: token }, { clock }) };
    };
    const owner = await account('owner', true), curator = await account('curator'), member = await account('member');
    await setMemberRole(identities, { team_id: team.team_id, member_user_id: curator.user.user_id, role: roles![0]! },
      { granted_by: owner.user.user_id, clock });
    const { store: backing, probe } = createTestMemoryStorage();
    const batches: CommitBatch[] = [];
    const store: StoragePort = { ...backing, commit: async batch => {
      batches.push(batch);
      return backing.commit(batch);
    } };
    const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
    const invoke = (operation: string, inputs: Record<string, unknown>, identity: ResolvedIdentity = curator.identity,
      id = operationId(now)) => invoker.invokeMutation({ operation: `prompt_lab.${operation}`, operation_id: id, inputs }, identity);
    const committed = async (operation: string, inputs: Record<string, unknown>, identity = curator.identity,
      id = operationId(now)): Promise<MutationResult> => {
      const outcome = await invoke(operation, inputs, identity, id);
      assert.ok('result' in outcome, JSON.stringify(outcome));
      assert.equal(outcome.result.status, 'committed');
      return outcome.result;
    };
    const create = async (name: string, inputs: Record<string, unknown>, identity = curator.identity): Promise<RecordId> => {
      const id = operationId(now);
      await committed(`${name}.create`, inputs, identity, id);
      const recordId = id as unknown as RecordId;
      assert.ok(await store.load(model(name), recordId));
      return recordId;
    };
    const ref = async (name: string, id: RecordId) => {
      const row = await store.load(model(name), id);
      assert.ok(row);
      return { id, version: String(row.version) };
    };
    const snapshot = async () => {
      const models = await Promise.all(['Catalog', 'Entry', 'Tag', 'Note'].map(async name => {
        const rows = await store.query({ model: model(name), authority: 'owner', archived: 'include', order: [{ field: 'id', direction: 'asc' }] });
        return { name, rows, history: rows.map(row => probe.historyFor(model(name), row.id)) };
      }));
      const keys = new Map(batches.flatMap(batch => [...batch.uniqueClaims, ...batch.uniqueReleases])
        .map(key => [JSON.stringify([key.model, key.keyName, key.keyValue]), key]));
      const claims = await Promise.all([...keys.values()].map(async key => ({ model: key.model, keyName: key.keyName,
        keyValue: key.keyValue, owner: await store.uniqueOwner!(key.model, key.keyName, key.keyValue) })));
      return { models, claims, outbox: probe.outboxAll() };
    };
    const refused = async (operation: string, inputs: Record<string, unknown>, code: 'forbidden' | 'rule_failed',
      identity = member.identity) => {
      const before = await snapshot(), batchIndex = batches.length, id = operationId(now);
      const outcome = await invoke(operation, inputs, identity, id);
      assert.ok('error' in outcome, JSON.stringify(outcome));
      assert.equal(outcome.error.code, code);
      assert.equal(outcome.receipt, code === 'rule_failed' ? 'rejected' : undefined);
      if (code === 'rule_failed') {
        const replay = await invoke(operation, inputs, identity, id);
        assert.ok('error' in replay, JSON.stringify(replay));
        assert.equal(replay.error.code, code);
        assert.equal(replay.receipt, 'rejected', 'exact rejected replay is observed by State');
        const changed = await invoke(operation, { ...inputs, unexpected: true }, identity, id);
        assert.ok('error' in changed, JSON.stringify(changed));
        assert.equal(changed.receipt, undefined, 'altered envelope never inherits rejected observation');
      }
      assert.deepEqual(await snapshot(), before, 'refusal preserves domain rows, history, computed claims and effects');
      for (const batch of batches.slice(batchIndex)) {
        for (const field of ['writes', 'history', 'uniqueClaims', 'uniqueReleases', 'outbox', 'schedules'] as const)
          assert.deepEqual(batch[field], [], `rejection may retain its receipt, but stages no ${field}`);
      }
      for (const name of ['Catalog', 'Entry', 'Tag', 'Note'])
        assert.deepEqual(probe.historyFor(model(name), id as unknown as RecordId), []);
    };

    const catalog = await create('Catalog', { name: 'Native acceptance' });
    const entryInputs = { parent: await ref('Catalog', catalog), code: 'Ａlice', title: 'Original entry',
      barcode: '4006381333931', summary: 'Keep stored spelling' };
    const entry = await create('Entry', entryInputs);
    const tag = await create('Tag', { name: 'Reference', description: 'Keep tag' });
    const foreignNote = await create('Note', { parent: await ref('Entry', entry), body: 'Curator note' });
    const ownNote = await create('Note', { parent: await ref('Entry', entry), body: 'Member note' }, member.identity);
    assert.deepEqual((await store.load(model('Note'), ownNote))?.data.author, { id: member.user.user_id });
    // Positive member update before the negative controls rules out a blanket denial.
    await committed('Note.update', { record: await ref('Note', ownNote), body: 'Member revision' }, member.identity);
    await refused('Catalog.create', { name: 'Unauthorized' }, 'forbidden');
    await refused('Entry.create', { ...entryInputs, code: 'Unauthorized' }, 'forbidden');
    await refused('Entry.update', { record: await ref('Entry', entry), code: 'Unauthorized' }, 'forbidden');
    await refused('Entry.delete', { record: await ref('Entry', entry) }, 'forbidden');
    await refused('Tag.create', { name: 'Unauthorized', description: 'Unauthorized' }, 'forbidden');
    await refused('Tag.update', { record: await ref('Tag', tag), name: 'Unauthorized' }, 'forbidden');
    await refused('Tag.delete', { record: await ref('Tag', tag) }, 'forbidden');
    await refused('Note.update', { record: await ref('Note', foreignNote), body: 'Foreign edit' }, 'rule_failed');
    await refused('Note.delete', { record: await ref('Note', foreignNote) }, 'rule_failed');

    await refused('change_code_if', { entry: await ref('Entry', entry), code: 'Carol', accept: false }, 'rule_failed', curator.identity);
    assert.equal((await store.load(model('Entry'), entry))?.data.code, 'Ａlice');
    // A collision on the old canonical spelling and reuse of the rejected new
    // spelling prove both sides of the rollback through actual owner operations.
    const addInputs = { catalog: await ref('Catalog', catalog), code: 'Alice', title: 'Collision',
      barcode: '9780306406157', summary: 'Original key is reserved' };
    const conflict = await invoke('add_entry', addInputs);
    assert.ok('error' in conflict, JSON.stringify(conflict));
    assert.equal(conflict.error.code, 'conflict');
    const replayId = operationId(now), carolInputs = { ...addInputs, code: 'Carol', title: 'Reusable rejected code' };
    const first = await committed('add_entry', carolInputs, curator.identity, replayId);
    const beforeReplay = await snapshot(), beforeRevision = await store.readRevision(), beforeBatches = batches.length;
    const replay = await invoke('add_entry', carolInputs, curator.identity, replayId);
    assert.ok('result' in replay, JSON.stringify(replay));
    assert.equal(replay.result.status, 'replayed');
    assert.equal(replay.result.operation_id, first.operation_id);
    assert.deepEqual(replay.result.result, first.result, 'replay retains the actual source-returned Entry reference');
    assert.deepEqual(replay.result.records, first.records);
    assert.deepEqual(await snapshot(), beforeReplay, 'replay duplicates no row, history, claim or outbox effect');
    assert.equal(await store.readRevision(), beforeRevision);
    assert.equal(batches.length, beforeBatches, 'replay performs no second commit');
    assert.equal((await store.query({ model: model('Entry'), authority: 'owner' })).filter(row => row.data.code === 'Carol').length, 1);

    const evidence = (result: MutationResult, id: RecordId, archived: boolean) => {
      assert.equal(result.records?.length, 1, 'authorized changed record is disclosed');
      const row = result.records![0] as ProjectedRecord;
      assert.equal(row.id, id);
      assert.equal(row.data.archived, archived);
      assert.deepEqual(row.data.archived_by, archived ? { id: curator.user.user_id } : null);
      assert.equal(row.data.archive_recorded_at, archived ? new Date(now).toISOString() : null);
      assert.equal(row.updatedBy, curator.user.user_id);
      assert.equal(row.updated, now);
    };
    const archiveId = operationId(now), archiveInput = { entry: await ref('Entry', entry) };
    const archivedReceipt = await committed('archive_entry', archiveInput, curator.identity, archiveId);
    evidence(archivedReceipt, entry, true);
    evidence(await committed('restore_entry', { entry: await ref('Entry', entry) }), entry, false);
    const archiveReplay = await invoke('archive_entry', archiveInput, curator.identity, archiveId);
    assert.ok('result' in archiveReplay, JSON.stringify(archiveReplay));
    assert.equal(archiveReplay.result.status, 'replayed');
    assert.deepEqual(archiveReplay.result.records, archivedReceipt.records, 'replay retains original changed snapshot');
    assert.equal((await store.load(model('Entry'), entry))?.data.archived, false, 'replay does not rearchive current row');
    await committed('archive_entry', { entry: await ref('Entry', entry) });
    evidence(await committed('archive_tag', { tag: await ref('Tag', tag) }), tag, true);
    evidence(await committed('restore_tag', { tag: await ref('Tag', tag) }), tag, false);
    await refused('Note.create', { parent: await ref('Entry', entry), body: 'Archived new note' }, 'rule_failed');
    await refused('Note.update', { record: await ref('Note', ownNote), body: 'Archived edit' }, 'rule_failed');
    await refused('Note.delete', { record: await ref('Note', ownNote) }, 'rule_failed');
    // Real server-rendered forms and authenticated HTTP retain the rejected
    // attempt and issue a separate, equally protected identity for correction.
    const catalogOperations = catalogFromArtifactOperations(artifact);
    const derivedInputs = Object.fromEntries(artifact.operations!.map(operation => {
      const derived = catalogOperations.derivedFor(operation.name);
      assert.ok(derived);
      return [operation.name, derived];
    }));
    const worker = await assembleWorker(artifact, asm, {
      store, identityStore: identities, now: () => now,
      pageReads: { scope: { app: 'CanPromptLab', ownerPackage: 'CanPromptLab', owner: team.team_id },
        sourceIdentity: JSON.stringify(artifact.sources), cursors: await createPageCursorCodec(new Uint8Array(32).fill(72)) },
      http: { derivedInputs,
        formBindings: await createSourceFormBindings(new Uint8Array(32).fill(37), JSON.stringify(artifact.sources)),
        createOperationHandler: deps => (request, operation) => handleOperationRequest(deps as unknown as HttpDeps, request, operation),
        createPageHandler: deps => request => handlePageRequest(deps as unknown as PageHttpDeps, request) },
    }, { active: true });
    const cookie = buildSessionCookie(curator.token, { maxAgeSeconds: 3600 }).split(';')[0]!;
    const decode = (value: string) => value.replaceAll('&quot;', '"').replaceAll('&#39;', "'")
      .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
    const attributes = (tag: string): Record<string, string> => Object.fromEntries(
      [...tag.matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)')/g)].map(match => [match[1]!, decode(match[2] ?? match[3]!)]));
    const formsIn = (html: string) => [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map(match => {
      const flat: Record<string, string> = {};
      for (const input of match[2]!.matchAll(/<input\b[^>]*>/g)) {
        const attrs = attributes(input[0]);
        if (attrs.name !== undefined) flat[attrs.name] = attrs.value ?? '';
      }
      for (const textarea of match[2]!.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
        const attrs = attributes(textarea[1]!);
        if (attrs.name !== undefined) flat[attrs.name] = decode(textarea[2]!);
      }
      return { attrs: attributes(match[1]!), flat };
    });
    const pageForms = async (route: string, token: string) => {
      const callerCookie = buildSessionCookie(token, { maxAgeSeconds: 3600 }).split(';')[0]!;
      const response = await worker.fetch(new Request(`http://localhost${route}`, { headers: { cookie: callerCookie } }));
      assert.equal(response.status, 200, 'actual current authenticated page remains readable');
      return formsIn(await response.text());
    };
    const operationsIn = (forms: ReturnType<typeof formsIn>) => new Set(forms.map(form => form.flat.operation));
    const curatorControls = ['Catalog.create', 'Catalog.update', 'Entry.create', 'Entry.update', 'Entry.delete',
      'archive_entry', 'restore_entry'];
    const beforePresentation = await snapshot(), beforePresentationRevision = await store.readRevision();
    const curatorForms = operationsIn(await pageForms('/catalogs', curator.token));
    for (const operation of curatorControls) assert.ok(curatorForms.has(`prompt_lab.${operation}`), operation);
    assert.ok(operationsIn(await pageForms('/tags', curator.token)).has('prompt_lab.Tag.create'));
    const memberForms = operationsIn(await pageForms('/catalogs', member.token));
    for (const operation of curatorControls) assert.ok(!memberForms.has(`prompt_lab.${operation}`), operation);
    assert.ok(memberForms.has('prompt_lab.Note.create'), 'member retains the canonical own-note intake');
    assert.ok(memberForms.has('prompt_lab.Note.update'), 'member retains canonical note editing; existing owner tests enforce its row guard');
    const memberTags = operationsIn(await pageForms('/tags', member.token));
    for (const operation of ['Tag.create', 'Tag.update', 'Tag.delete', 'archive_tag', 'restore_tag']) {
      assert.ok(!memberTags.has(`prompt_lab.${operation}`), operation);
    }
    // The same valid browser session observes a real role removal on its next
    // page request. Neither a cached role snapshot nor the shell caption admits it.
    await setMemberRole(identities, { team_id: team.team_id, member_user_id: curator.user.user_id, role: `-${roles![0]!}` },
      { granted_by: owner.user.user_id, clock });
    const revokedForms = operationsIn(await pageForms('/catalogs', curator.token));
    for (const operation of curatorControls) assert.ok(!revokedForms.has(`prompt_lab.${operation}`), operation);
    assert.ok(revokedForms.has('prompt_lab.Note.create'), 'role removal preserves ordinary membership');
    assert.deepEqual(await snapshot(), beforePresentation, 'page admission and role changes preserve business rows/history/claims/effects');
    assert.equal(await store.readRevision(), beforePresentationRevision);
    await setMemberRole(identities, { team_id: team.team_id, member_user_id: curator.user.user_id, role: roles![0]! },
      { granted_by: owner.user.user_id, clock });
    assert.ok(operationsIn(await pageForms('/catalogs', curator.token)).has('prompt_lab.Catalog.create'),
      'the same browser session sees its restored native role');
    for (const [page, name, values, invalid, corrected, protectedParent] of [
      ['/tags', 'Tag', { name: 'é'.repeat(65), description: 'HTTP correction' }, 'name', 'é'.repeat(64), false],
      ['/catalogs', 'Entry', { code: 'HTTP-entry', title: 'HTTP correction', barcode: '4006381333932', summary: 'Protected parent', rank: '0' },
        'barcode', '4006381333931', true],
    ] as const) {
      const response = await worker.fetch(new Request(`http://localhost${page}`, { headers: { cookie } }));
      assert.equal(response.status, 200);
      const html = await response.text();
      const forms = formsIn(html);
      const form = forms.find(value => value.flat.operation === `prompt_lab.${name}.create`);
      assert.ok(form, `actual ${name}.create form`);
      const metadata = JSON.parse(form.attrs['data-can-generated-form']!) as Pick<Parameters<typeof submitGeneratedForm>[0],
        'derived' | 'mode' | 'renderedInputs'>;
      const original = { ...form.flat };
      for (const [field, value] of Object.entries(values)) original[`inputs[${field}]`] = value;
      const oldId = original.operation_id!;
      assert.equal(typeof original.form_binding === 'string', protectedParent);
      const submit = async (flat: Record<string, string>) => {
        let status = 0;
        const result = await submitGeneratedForm({ ...metadata, flat, action: form.attrs.action!, fragment: false, denialFormat: 'json',
          fetchImpl: async (url, init) => {
            const actual = await worker.fetch(new Request(new URL(url, 'http://localhost'), {
              ...init, headers: { ...init.headers, cookie } }));
            status = actual.status;
            return actual;
          } });
        return { result, status };
      };
      const beforeRows = await store.query({ model: model(name), authority: 'owner', archived: 'include' });
      const first = await submit(original);
      assert.equal(first.status, 400);
      assert.equal(first.result.kind, 'denied');
      if (first.result.kind !== 'denied') throw new Error('Expected correctable validation');
      assert.equal(first.result.error.code, 'validation');
      assert.equal(first.result.error.operation_id, oldId);
      const retry = first.result.retry;
      assert.ok(retry, 'durable rejection offers a new server-issued attempt');
      assert.notEqual(retry.operation_id, oldId);
      assert.equal(typeof retry.form_binding === 'string', protectedParent);
      const afterRejected = await store.readRevision();
      const replay = await submit(original);
      assert.equal(replay.result.kind, 'denied');
      if (replay.result.kind !== 'denied') throw new Error('Expected original rejected replay');
      assert.equal(replay.result.error.code, 'validation');
      assert.equal(replay.result.error.message, first.result.error.message);
      assert.equal(await store.readRevision(), afterRejected, 'exact rejected replay writes nothing');
      const changed = { ...original, [`inputs[${invalid}]`]: corrected };
      const alteredOld = await submit(changed);
      assert.equal(alteredOld.status, 409);
      assert.equal(alteredOld.result.kind, 'denied');
      if (alteredOld.result.kind !== 'denied') throw new Error('Expected old identity conflict');
      assert.equal(alteredOld.result.error.code, 'conflict');
      assert.equal(alteredOld.result.retry, undefined);
      const correctedFlat = { ...changed, operation_id: retry.operation_id,
        ...(retry.form_binding === undefined ? {} : { form_binding: retry.form_binding }) };
      if (protectedParent) {
        const wrongProof = await submit({ ...correctedFlat, form_binding: original.form_binding! });
        assert.equal(wrongProof.result.kind, 'denied', 'old proof cannot authorize the fresh identity');
        assert.ok(wrongProof.status >= 400);
        assert.equal(await store.readRevision(), afterRejected);
      }
      const accepted = await submit(correctedFlat);
      assert.equal(accepted.status, 200);
      assert.equal(accepted.result.kind, 'committed');
      if (accepted.result.kind !== 'committed') throw new Error('Expected corrected create');
      assert.equal(accepted.result.result.status, 'committed');
      const created = await store.load(model(name), retry.operation_id as unknown as RecordId);
      assert.ok(created);
      if (protectedParent) assert.deepEqual(created.parent, { model: model('Catalog'), id: catalog });
      const afterCreated = await store.readRevision(), history = probe.historyFor(model(name), created.id);
      const finalReplay = await submit(correctedFlat);
      assert.equal(finalReplay.result.kind, 'committed');
      if (finalReplay.result.kind !== 'committed') throw new Error('Expected corrected replay');
      assert.equal(finalReplay.result.result.status, 'replayed');
      assert.equal(await store.readRevision(), afterCreated);
      assert.deepEqual(probe.historyFor(model(name), created.id), history);
      assert.equal((await store.query({ model: model(name), authority: 'owner', archived: 'include' })).length, beforeRows.length + 1);
    }
    const archivedPage = await worker.fetch(new Request('http://localhost/catalogs/archived', { headers: { cookie } }));
    assert.equal(archivedPage.status, 200, 'actual archived EntryTile renders contributed native user/datetime evidence');
    const archivedHtml = await archivedPage.text(), archivedEntry = await store.load(model('Entry'), entry);
    assert.ok(archivedEntry);
    assert.deepEqual(archivedEntry.data.archived_by, { id: curator.user.user_id });
    assert.equal(typeof archivedEntry.data.archive_recorded_at, 'string');
    assert.ok(archivedHtml.includes(curator.user.user_id), 'native UserRef renders its stable identity');
    assert.ok(archivedHtml.includes(formatScalar({ type: 'datetime', value: archivedEntry.data.archive_recorded_at },
      { locale: 'en', timeZone: 'UTC' })), 'native datetime uses canonical UI formatting rather than raw stored ISO text');
    const liveEntry = (await store.query({ model: model('Entry'), authority: 'owner' })).find(row => row.data.code === 'Carol');
    assert.ok(liveEntry);
    assert.equal(liveEntry.data.archived_by, null);
    assert.equal(liveEntry.data.archive_recorded_at, null);
    const sourceScope = createPageReadScopeCanonical({ artifact, asm, store, identity: curator.identity,
      memberships: identities, now: () => now });
    try {
      const projected = await sourceScope.query(null, model('Entry'), { limit: 25 });
      const original = projected.rows.find(row => row.id === entry);
      assert.ok(original);
      const wireSnapshot = JSON.stringify(original);
      const invokeRow = wrapNativeUiQueryFactory(async (props: {
        context: { query: typeof sourceScope.query }; row: RowView;
        renderRow: (row: RowView, context: unknown, source: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
      }) => props.renderRow(props.row, {}, {}));
      const props = { context: { query: sourceScope.query }, row: original,
        renderRow: (wire: RowView, _context: unknown, source: Readonly<Record<string, unknown>>) => {
          assert.strictEqual(wire, original);
          assert.equal(JSON.stringify(wire), wireSnapshot, 'original row remains exact wire presentation');
          return source;
        } };
      const native = await invokeRow(props);
      assert.equal(native.id, entry);
      assert.equal(typeof native.version, 'bigint');
      assert.equal(typeof native.rank, 'bigint');
      assert.deepEqual(native.archived_by, { kind: 'user', id: curator.user.user_id });
      assert.deepEqual(native.archive_recorded_at, { kind: 'datetime', ms: BigInt(now) });
      assert.equal(native.archived_at, null, 'authored archive evidence does not archive the engine record');
      assert.deepEqual(Object.keys(native).sort(), [...Object.keys(original.fields), 'id', 'version', 'archived_at'].sort());
      await assert.rejects(invokeRow({ ...props, row: { ...original, fields: { ...original.fields } } }),
        /original final page query row/);
      original.fields.archived_by = { id: member.user.user_id };
      assert.deepEqual(native.archived_by, { kind: 'user', id: curator.user.user_id },
        'native data retains the admitted projection despite later wire-object mutation');
      await sourceScope.close?.();
      assert.throws(() => native.archived_by, /Page read scope is closed/);
      await assert.rejects(invokeRow(props), /Page read scope is closed/);
    } finally { await sourceScope.close?.(); }
    assert.equal(await captureIsCurrent(capture), true, 'source, saved implementations and native producer closure remain current');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('compiled duration forms preserve exact milliseconds through public HTTP, defaults and updates', { timeout: 120_000 }, async () => {
  const { deriveCsrfToken } = await import('@canlang/identity');
  const { writeFile } = await import('node:fs/promises');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const scratch = await mkdtemp(join(tmpdir(), 'can-duration-forms-'));
  try {
    const sourcePath = join(scratch, 'DurationForms.can');
    await writeFile(sourcePath, `app DurationForms
Given
 Entry {label:text,wait:duration,optional:duration?}
 policy Entry read=members
When
 crud Entry by=owner fields=label,wait,optional
Then
 page / title="Explicit duration inputs"
  require members
  form Entry.create display=inline fields=label,wait,optional
   input label
   input wait
   input optional
 page /automatic title="Generated duration inputs"
  require members
  form Entry.create display=inline fields=label,wait,optional
 page /edit title="Update duration inputs"
  require members
  list Entry
   form Entry.update arguments={record=row} display=inline fields=label,wait,optional
    input label
    input wait
    input optional
`);
    const { stdout } = await promisify(execFile)(process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can'),
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog',
        process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json'), sourcePath],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as import('@canlang/contracts').CompileArtifact;
    assert.equal(artifact.pages.length, 3);
    const asm = await assembleModules({ artifact, sourcePath }, { workDir: join(scratch, 'assembly'),
      stdlibUrl: pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href, uiUrl: import.meta.resolve('@canlang/ui') });
    const now = Date.now(), clock = createFrozenClock(now), identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({});
    const account = async (label: string, owner: boolean) => {
      const user = await identities.createUser({ email: `${label}@duration.test`, password_hash: 'unused', email_verified: true });
      await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: owner, roles: [] });
      const token = randomBytes(32).toString('hex');
      await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        expires_at: new Date(now + 3600000).toISOString(), last_team_id: team.team_id });
      return buildSessionCookie(token, { maxAgeSeconds: 3600 }).split(';')[0]!;
    };
    const ownerCookie = await account('owner', true), memberCookie = await account('member', false);
    const { store } = createTestMemoryStorage();
    const catalogOperations = catalogFromArtifactOperations(artifact);
    const derivedInputs = Object.fromEntries(artifact.operations!.map(operation => {
      const derived = catalogOperations.derivedFor(operation.name); assert.ok(derived); return [operation.name, derived];
    }));
    const worker = await assembleWorker(artifact, asm, { store, identityStore: identities, now: () => now,
      pageReads: { scope: { app: 'DurationForms', ownerPackage: 'DurationForms', owner: team.team_id },
        sourceIdentity: JSON.stringify(artifact.sources), cursors: await createPageCursorCodec(new Uint8Array(32).fill(73)) },
      http: { derivedInputs, formBindings: await createSourceFormBindings(new Uint8Array(32).fill(38), JSON.stringify(artifact.sources)),
        createOperationHandler: deps => (request, operation) => handleOperationRequest(deps as unknown as HttpDeps, request, operation),
        createPageHandler: deps => request => handlePageRequest(deps as unknown as PageHttpDeps, request) },
    }, { active: true });
    const decode = (value: string) => value.replaceAll('&quot;', '"').replaceAll('&#39;', "'")
      .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
    const attrs = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)')/g)]
      .map(match => [match[1]!, decode(match[2] ?? match[3]!)]));
    const formAt = async (path: string) => {
      const response = await worker.fetch(new Request(`http://localhost${path}`, { headers: { cookie: ownerCookie } }));
      assert.equal(response.status, 200);
      const html = await response.text(), match = /<form\b([^>]*)>([\s\S]*?)<\/form>/.exec(html); assert.ok(match);
      const fields = [...match[2]!.matchAll(/<input\b[^>]*>/g)].map(item => attrs(item[0]));
      const flat: Record<string, string> = {};
      // Browser FormData omits unchecked null checkboxes, preserving optional omission.
      for (const field of fields) if (field.name && field.type !== 'checkbox') flat[field.name] = field.value ?? '';
      for (const name of ['wait', 'optional']) {
        const input = fields.find(field => field.name === `inputs[${path === '/edit' ? 'changes][' : ''}${name}]`);
        assert.ok(input, `${path}: duration ${name} input rendered`);
        assert.equal(input.type, 'text'); assert.equal(input.inputmode, 'numeric');
        assert.ok(input['aria-describedby']?.split(' ').includes(`${input.id}-unit`));
      }
      assert.match(match[2]!, /\bms\b/, 'duration widget exposes its millisecond unit');
      return { attrs: attrs(match[1]!), flat };
    };
    const submit = async (form: Awaited<ReturnType<typeof formAt>>, values: Record<string, string>, cookie = ownerCookie) => {
      const metadata = JSON.parse(form.attrs['data-can-generated-form']!) as Pick<Parameters<typeof submitGeneratedForm>[0], 'derived' | 'mode' | 'renderedInputs'>;
      return submitGeneratedForm({ ...metadata, flat: { ...form.flat, ...values }, action: form.attrs.action!, fragment: false, denialFormat: 'json',
        fetchImpl: (url, init) => worker.fetch(new Request(new URL(url, 'http://localhost'), { ...init, headers: { ...init.headers, cookie } })) });
    };
    const rows = () => store.query({ model: 'DurationForms.Entry' as ModelName, authority: 'owner' });
    for (const [path, label, wait, optional] of [
      ['/', 'exact-large', '9007199254740993', '-123'], ['/automatic', 'negative', '-9007199254740993', ''],
    ]) {
      const form = await formAt(path!);
      const result = await submit(form, { 'inputs[label]': label!, 'inputs[wait]': wait!, 'inputs[optional]': optional! });
      assert.equal(result.kind, 'committed', JSON.stringify(result));
      const saved = (await rows()).find(row => row.data.label === label); assert.ok(saved);
      assert.equal(saved.data.wait, wait); assert.equal(saved.data.optional ?? null, optional || null);
      const revision = await store.readRevision();
      const replay = await submit(form, { 'inputs[label]': label!, 'inputs[wait]': wait!, 'inputs[optional]': optional! });
      assert.ok(replay.kind === 'committed' && replay.result.status === 'replayed', JSON.stringify(replay));
      assert.equal(await store.readRevision(), revision);
    }
    for (const invalid of ['', '1h', '1.5', '9223372036854775808', '-9223372036854775809']) {
      const before = await rows(), form = await formAt('/');
      const result = await submit(form, { 'inputs[label]': 'invalid', 'inputs[wait]': invalid, 'inputs[optional]': '' });
      assert.equal(result.kind, 'denied', `${invalid}: ${JSON.stringify(result)}`);
      assert.deepEqual(await rows(), before, `${invalid}: no persisted mutation`);
    }
    const edit = await formAt('/edit');
    const originalLabel = edit.flat['inputs[changes][label]']; assert.ok(originalLabel);
    assert.equal(edit.flat['inputs[changes][wait]'], (await rows()).find(row => row.data.label === originalLabel)!.data.wait);
    const updated = await submit(edit, { 'inputs[changes][wait]': '-5000', 'inputs[changes][optional__null]': 'true' });
    assert.equal(updated.kind, 'committed', JSON.stringify(updated));
    const saved = (await rows()).find(row => row.data.label === originalLabel); assert.ok(saved);
    assert.equal(saved.data.wait, '-5000'); assert.equal(saved.data.optional, null);
    const beforeDenied = await rows(), deniedForm = await formAt('/');
    const denied = await submit(deniedForm, { 'inputs[label]': 'denied', 'inputs[wait]': '1000', 'inputs[optional]': '',
      _csrf: await deriveCsrfToken(decodeURIComponent(memberCookie.slice(memberCookie.indexOf('=') + 1))) }, memberCookie);
    assert.equal(denied.kind, 'denied', JSON.stringify(denied));
    assert.deepEqual(await rows(), beforeDenied, 'authenticated nonowner cannot submit the duration mutation');
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
