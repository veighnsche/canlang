/** B01 public UI action API over unchanged compiled AppOwnedPreview CRUD.
 * This does not claim emitted .can action rendering. Cancellation controls are
 * reused from first-profile-browser/browser-lifecycle; this adds actual submits. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { test } from 'vitest';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { ModelName, OperationId, OperationName, RecordId } from '@canlang/contracts';
import type { PageHttpDeps } from '@canlang/interfaces';
import type { HttpDeps as AssemblyHttpDeps } from '@canlang/cloudflare/worker/assembly';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const require = createRequire(import.meta.url);
const nodeImport = compileFunction('return import(url)', ['url'], {
  importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
});
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const producer = (name: string) => pathToFileURL(require.resolve(name)).href;
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function snapshot(db: D1Database) {
  const names = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{ name: string }>();
  assert.equal(names.success, true);
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  for (const { name } of names.results) {
    const rows = await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true);
    tables[name] = rows.results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return tables;
}

test('public prepared action submits original native CRUD through Chromium, HTTP, Identity and D1',
  { timeout: 180000 }, async () => {
    // Private installed assembly/catalog capabilities must share their default loader.
    const { assembleModules } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
    const { assembleWorker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
    const { buildProductionDeps } = await nodeImport(installed('runtime/env-assembly.js')) as typeof import('../src/runtime/env-assembly.js');
    const { buildDerivedInputsModule } = await nodeImport(installed('deploy/bundle.js')) as typeof import('../src/deploy/bundle.js');
    const { gatherBrowserAssets } = await nodeImport(installed('deploy/package-assets.js')) as typeof import('../src/deploy/package-assets.js');
    const { prepareLocalPreviewCapture, loadInstalledChromium } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
    const { captureSingleFileSource, captureIsCurrent, verifyCompilerSources } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
    const { compileCapturedSingleFile } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
    const { localPreviewActivationVerdict } = await nodeImport(installed('runtime/native-preview.test-support.js')) as typeof import('../src/runtime/native-preview.test-support.js');
    const { handlePageRequest, handleOperationRequest, INPUT_CHOICES_VERSION, buildPresentationContext,
      createSourceFormBindings } = await nodeImport(producer('@canlang/interfaces')) as typeof import('@canlang/interfaces');
    const { createAssetTable, handleAssetsRequest } = await nodeImport(producer('@canlang/interfaces/http/assets')) as typeof import('@canlang/interfaces/http/assets');
    const { createD1IdentityStore, resolveIdentity, sha256HexText, deriveCsrfToken } = await nodeImport(producer('@canlang/identity')) as typeof import('@canlang/identity');
    const { hashInputs } = await nodeImport(producer('@canlang/state/invocation/replay')) as typeof import('@canlang/state/invocation/replay');
    const { action } = await nodeImport(producer('@canlang/ui')) as typeof import('@canlang/ui');
    const fixture = join(root, 'tests/integration/can-dev-server/AppOwnedPreview.can');
    const capture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: root, appPath: fixture,
      compilerPath: join(root, 'compiler/target/debug/can'), catalogPath: join(root, 'packages/values/dist/catalog.json'),
      helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md') }));
    const compiled = await compileCapturedSingleFile(capture); assert.equal(compiled.kind, 'artifact');
    if (compiled.kind !== 'artifact') throw new Error('unchanged AppOwnedPreview must compile');
    const artifact = compiled.artifact, originalArtifact = JSON.stringify(artifact);
    assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
    const app = 'AppOwnedPreview', model = `${app}.Setting` as ModelName;
    const create = `${model}.create`, update = `${model}.update`;
    assert.equal(artifact.models?.find(value => value.name === model)?.scope, 'app');
    for (const name of [create, update]) assert.ok(artifact.operations?.some(value => value.name === name));
    const chromium = await loadInstalledChromium(root); assert.ok(chromium, 'owning installed Chromium is required');
    const availability = await chromium.producer.chromiumAvailability(); assert.ok(availability.available);
    const directory = await mkdtemp(join(tmpdir(), 'can-native-plain-action-'));
    let miniflare: Miniflare | undefined, server: Server | undefined;
    let lease: Awaited<ReturnType<typeof chromium.producer.acquireChromium>> | undefined;
    let context: ReturnType<NonNullable<typeof lease>['browser']['contexts']>[number] | undefined;
    const failures: unknown[] = [], browserErrors: string[] = [], journal: string[] = [];
    try {
      const asm = await assembleModules({ artifact, sourcePath: fixture }, { workDir: join(directory, 'modules'),
        stdlibUrl: producer('@canlang/cloudflare/runtime/stdlib'), uiUrl: producer('@canlang/ui') });
      miniflare = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default {fetch(){return new Response("ok")}}', d1Databases: { DB: 'native-plain-action' },
        d1Persist: join(directory, 'd1') });
      const db = await miniflare.getD1Database('DB') as unknown as D1Database;
      const production = await buildProductionDeps({ DB: db });
      const identities = createD1IdentityStore(db);
      const user = await identities.createUser({ email: 'native-action@example.test', password_hash: 'unused', email_verified: true });
      const team = await identities.createTeam({ timezone: 'UTC' });
      await identities.createMembership({ user_id: user.user_id, team_id: team.team_id, is_owner: true, roles: [] });
      const token = randomBytes(32).toString('hex');
      const session = await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        expires_at: new Date(Date.now() + 3600000).toISOString(), last_team_id: team.team_id });
      const csrf = await deriveCsrfToken(token);
      const verdict = await localPreviewActivationVerdict(artifact, capture, db, 'native-plain-action');
      assert.equal(verdict.active, true, 'genuine installed native activation must pass');
      const derivedModule = object(await nodeImport(`data:text/javascript,${encodeURIComponent(buildDerivedInputsModule(artifact))}`));
      const derivedInputs = derivedModule.derivedInputs as NonNullable<Parameters<typeof assembleWorker>[2]['http']>['derivedInputs'];
      assert.ok(derivedInputs);
      // One real host service serves preparation AND the original public HTTP restore.
      const formBindings = await createSourceFormBindings(randomBytes(32), capture.sourceSha256);
      const resources = gatherBrowserAssets().resources;
      const assetTable = createAssetTable(Object.entries(resources).map(([key, value]) => ({ key,
        bytes: value.bytes, mime: value.contentType, cache: { maxAgeSeconds: 0, immutable: false } })));
      let pageDeps: PageHttpDeps | undefined, invocations = 0;
      const worker = await assembleWorker(artifact, asm, { ...production, identityStore: identities,
        http: { derivedInputs, formBindings,
          loadBrowserAssets: async () => ({ paths: Object.keys(resources).map(key => `/assets/${key}`),
            fetch: request => handleAssetsRequest(assetTable, request) }),
          createPageHandler: deps => {
            pageDeps = deps as unknown as PageHttpDeps;
            return request => handlePageRequest(pageDeps!, request);
          },
          createOperationHandler: Object.assign((deps: AssemblyHttpDeps) => {
            // Same genuine deps; Interfaces and CF publish structural join types.
            const original = deps as unknown as Parameters<typeof handleOperationRequest>[0];
            return (request: Request, operation: string) => handleOperationRequest({ ...original,
              logger: { log: (level, message, fields) => journal.push(JSON.stringify({ level, message, fields })) },
              invoker: { ...original.invoker, invokeMutation: async (envelope, identity) => {
                invocations++; return original.invoker.invokeMutation(envelope, identity);
              } } }, request, operation);
          }, { inputChoicesVersion: INPUT_CHOICES_VERSION }) } }, verdict);
      let origin = '';
      server = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const headers = new Headers();
          for (const [name, value] of Object.entries(request.headers)) {
            if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
            else if (value !== undefined) headers.set(name, value);
          }
          const reply = await worker.fetch(new Request(new URL(request.url ?? '/', origin), {
            method: request.method ?? 'GET', headers,
            ...(['GET', 'HEAD'].includes(request.method ?? 'GET') ? {} : { body: Buffer.concat(chunks) }) }));
          response.writeHead(reply.status, Object.fromEntries(reply.headers));
          response.end(Buffer.from(await reply.arrayBuffer()));
        })().catch(error => { failures.push(error); response.writeHead(500); response.end('native action host failure'); });
      });
      await new Promise<void>((done, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', done); });
      const address = server.address(); assert.ok(address !== null && typeof address !== 'string');
      origin = `http://127.0.0.1:${address.port}`;
      lease = await chromium.producer.acquireChromium({ signal: new AbortController().signal });
      assert.deepEqual(lease.identity, availability.identity);
      context = await lease.browser.newContext();
      context.setDefaultTimeout(10000); context.setDefaultNavigationTimeout(10000);
      await context.addCookies([{ name: 'can_session', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
      const page = await context.newPage(); page.on('pageerror', error => browserErrors.push(error.message));
      assert.equal((await page.goto(origin, { waitUntil: 'networkidle' }))!.status(), 200);
      assert.ok(pageDeps?.catalog && pageDeps.formBindings === formBindings);
      const beforePreparation = await snapshot(db);
      const prepare = async (operation: string, record?: Record<string, unknown>) => {
        const principal = await resolveIdentity(identities, { session_token: token });
        assert.equal(principal.actor?.user_id, user.user_id); assert.equal(principal.team?.team_id, team.team_id);
        assert.ok(pageDeps!.query);
        const presentation = buildPresentationContext({ request: new Request(origin, { headers: { cookie: `can_session=${token}` } }),
          pathname: '/', isPartial: false, appDefaultLocale: pageDeps!.app.appDefaultLocale, csrfToken: csrf, principal,
          catalog: pageDeps!.catalog!, clock: pageDeps!.clock, formBindings, appId: pageDeps!.app.appId,
          sessionToken: token, query: pageDeps!.query });
        const prepared = await presentation.prepareForm!({ operation, fields: ['name', 'enabled'], display: 'inline',
          ...(record === undefined ? {} : { arguments: { record: { id: record.id, version: String(record.version) } } }) });
        assert.equal(prepared.status, 'ready'); if (prepared.status !== 'ready') throw new Error('original CRUD must prepare');
        assert.deepEqual(prepared.derived, pageDeps!.catalog!.derivedFor!(operation));
        const html = await action({ ...prepared.props, label: prepared.props.submit,
          fields: prepared.props.fields.filter(field => field.path === 'name'), inputs: { enabled: record === undefined ? false : true } });
        return { prepared, html };
      };
      const mount = async (html: string) => {
        await page.locator('body').evaluate((body, markup) => {
          body.querySelectorAll('form[data-can-generated-form]').forEach((form: {remove(): void}) => form.remove());
          body.insertAdjacentHTML('beforeend', markup);
        }, html);
        const form = page.locator('form[data-can-generated-form]').last(); assert.equal(await form.count(), 1);
        return form;
      };
      const submit = async (html: string, name: string, mutate?: (form: ReturnType<typeof page.locator>) => Promise<void>) => {
        const form = await mount(html);
        await form.locator('input[type="text"]').fill(name); await mutate?.(form);
        const received = page.waitForResponse(reply => reply.request().method() === 'POST' && reply.url().includes('/api/operations/'), { timeout: 10000 });
        const [response] = await Promise.all([received, form.locator('button[type="submit"]').click()]);
        await page.waitForFunction(() => {
          const document = (globalThis as unknown as { document: { querySelector(s: string): { getAttribute(s: string): string | null } | null } }).document;
          const state = document.querySelector('form[data-can-generated-form]')?.getAttribute('data-can-submit-state');
          return state === 'committed' || state === 'denied' || state === 'error';
        });
        assert.equal(await form.locator('button[type="submit"]').isEnabled(), true);
        assert.equal(response.request().headers()['x-csrf-token'], await form.locator('input[name="_csrf"]').inputValue());
        assert.match(response.request().headers()['content-type']!, /application\/json/);
        return { response, form, body: object(await response.json()), raw: response.request().postData()! };
      };
      // Canonical admission scopes receipts to the actual caller team; the
      // app-scoped model declaration does not replace that receipt owner.
      const receipt = (operation: string, id: string) => production.store.readReceipt({ app, owner: team.team_id, principal: user.user_id,
        operation: operation as OperationName, operationId: id as OperationId });
      const assertCommit = (before: Awaited<ReturnType<typeof snapshot>>, after: Awaited<ReturnType<typeof snapshot>>) => {
        for (const name of ['receipts', 'history']) assert.equal(after[name]!.length, before[name]!.length + 1, name);
        for (const name of Object.keys(before)) if (!['records', 'receipts', 'history', 'fence', 'fence_log', 'sqlite_sequence'].includes(name))
          assert.deepEqual(after[name], before[name], `original CRUD preserves unrelated ${name}`);
      };
      const made = await prepare(create); assert.deepEqual(await snapshot(db), beforePreparation, 'preparation grants no mutation effect');
      const revision = await production.store.readRevision();
      const created = await submit(made.html, 'Actual action setting');
      assert.equal(created.response.status(), 200); assert.equal(created.body.status, 'committed');
      assert.deepEqual(object(JSON.parse(created.raw)).inputs, { name: 'Actual action setting', enabled: false });
      const rows = created.body.records; assert.ok(Array.isArray(rows)); assert.equal(rows.length, 1);
      const originalRecord = object(rows[0]); assert.deepEqual(originalRecord.data, { name: 'Actual action setting', enabled: false });
      assert.equal(await production.store.readRevision(), revision + 1);
      const createdReceipt = await receipt(create, made.prepared.props.operationId); assert.ok(createdReceipt);
      assert.equal(createdReceipt.identity.operation, create); assert.equal(createdReceipt.identity.operationId, made.prepared.props.operationId);
      assert.equal(createdReceipt.committedRevision, revision + 1); assert.deepEqual(createdReceipt.resolvedDefaults, {});
      assert.equal(createdReceipt.inputHash, await hashInputs({ name: 'Actual action setting', enabled: false }));
      assert.equal(createdReceipt.outcome.status, 'committed'); assert.equal(originalRecord.version, 1);
      if (createdReceipt.outcome.status !== 'committed') throw new Error('original create receipt must commit');
      assert.deepEqual(createdReceipt.outcome.recordVersions, [{ model, id: originalRecord.id, version: 1 }]);
      const recordId = originalRecord.id as RecordId;
      const history = await production.store.historyFor(model, recordId);
      assert.equal(history.length, 1); assert.equal(history[0]!.actor, user.user_id); assert.equal(history[0]!.change, 'create');
      const afterCreate = await snapshot(db); assertCommit(beforePreparation, afterCreate);
      assert.deepEqual((await production.store.load(model, recordId))!.data, originalRecord.data);
      const replay = await context.request.post(created.response.url(), { data: created.raw,
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf } });
      assert.equal(replay.status(), 200); const replayed = object(await replay.json());
      assert.equal(replayed.status, 'replayed'); assert.deepEqual(replayed.records, created.body.records);
      assert.deepEqual(await snapshot(db), afterCreate, 'exact original replay changes no resource');
      const stale = await prepare(update, originalRecord), edited = await prepare(update, originalRecord);
      assert.ok(edited.prepared.props.sourceBinding && edited.prepared.props.sourceBindingIdentity && edited.prepared.props.sourceBindingDraftIdentity);
      const editedForm = await mount(edited.html);
      const metadata = JSON.parse((await editedForm.getAttribute('data-can-generated-form'))!);
      assert.deepEqual(metadata.derived, edited.prepared.derived); assert.equal(metadata.mode, 'update');
      assert.equal(metadata.bindingIdentity, edited.prepared.props.sourceBindingIdentity);
      assert.equal(metadata.draftIdentity, edited.prepared.props.sourceBindingDraftIdentity);
      assert.equal(await editedForm.locator('input[name="inputs[record][id]"]').count(), 0);
      assert.equal(await editedForm.locator('input[name="inputs[changes][enabled]"]').inputValue(), 'true');
      const beforeUpdate = await snapshot(db), updateRevision = await production.store.readRevision();
      const updated = await submit(edited.html, 'Actual action updated');
      assert.equal(updated.response.status(), 200); assert.equal(updated.body.status, 'committed');
      const updatedWire = object(JSON.parse(updated.raw));
      assert.equal(updatedWire.form_binding, edited.prepared.props.sourceBinding);
      assert.deepEqual(updatedWire.inputs, { name: 'Actual action updated', enabled: true });
      const updatedRows = updated.body.records; assert.ok(Array.isArray(updatedRows)); assert.equal(updatedRows.length, 1); const currentRecord = object(updatedRows[0]);
      assert.deepEqual(currentRecord.data, { name: 'Actual action updated', enabled: true });
      assert.equal(currentRecord.id, originalRecord.id); assert.equal(BigInt(String(currentRecord.version)), BigInt(String(originalRecord.version)) + 1n);
      const updatedReceipt = await receipt(update, edited.prepared.props.operationId); assert.ok(updatedReceipt);
      assert.equal(updatedReceipt.identity.operation, update); assert.equal(updatedReceipt.identity.operationId, edited.prepared.props.operationId);
      assert.equal(updatedReceipt.committedRevision, updateRevision + 1); assert.deepEqual(updatedReceipt.resolvedDefaults, {});
      assert.equal(updatedReceipt.inputHash, await hashInputs({ record: { id: originalRecord.id, version: String(originalRecord.version) },
        name: 'Actual action updated', enabled: true }));
      assert.equal(updatedReceipt.outcome.status, 'committed'); assert.equal(currentRecord.version, 2);
      if (updatedReceipt.outcome.status !== 'committed') throw new Error('original update receipt must commit');
      assert.deepEqual(updatedReceipt.outcome.recordVersions, [{ model, id: originalRecord.id, version: 2 }]);
      assertCommit(beforeUpdate, await snapshot(db)); assert.equal(await production.store.readRevision(), updateRevision + 1);
      assert.deepEqual((await production.store.load(model, recordId))!.data, currentRecord.data);
      const beforeStale = await snapshot(db), beforeStaleRevision = await production.store.readRevision();
      const rejected = await submit(stale.html, 'Stale must not replace');
      assert.equal(rejected.response.status(), 409); assert.equal(rejected.body.code, 'conflict');
      assert.deepEqual(await snapshot(db), beforeStale, 'version conflict is original State admission refusal before an execution receipt');
      assert.equal(await production.store.readRevision(), beforeStaleRevision);
      assert.equal(await receipt(update, stale.prepared.props.operationId), null);
      const afterStale = await snapshot(db);
      const retryRejected = await context.request.post(rejected.response.url(), { data: rejected.raw,
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf } });
      assert.equal(retryRejected.status(), 409); assert.deepEqual(await snapshot(db), afterStale);
      // Distinct transport/association boundaries; accepted cancellation controls are not repeated.
      for (const cause of ['csrf', 'binding', 'record'] as const) {
        const candidate = await prepare(update, currentRecord), before = await snapshot(db), entered = invocations;
        const denied = await submit(candidate.html, `Denied ${cause}`, async form => {
          if (cause === 'csrf') await form.locator('input[name="_csrf"]').evaluate(input => input.setAttribute('value', 'wrong-csrf'));
          if (cause === 'binding') await form.locator('input[name="form_binding"]').evaluate(input => input.setAttribute('value', 'invalid-proof'));
          if (cause === 'record') await form.evaluate(element => element.insertAdjacentHTML('beforeend',
            '<input type="hidden" name="inputs[record][id]" value="foreign-record"><input type="hidden" name="inputs[record][version]" value="1">'));
        });
        if (cause === 'record') {
          const sent = object(JSON.parse(denied.raw));
          assert.deepEqual(object(sent.inputs).record, { id: 'foreign-record', version: '1' },
            'bound-record hiddens project before renderedInputs and reach original HTTP');
          assert.equal(sent.form_binding, candidate.prepared.props.sourceBinding);
        }
        assert.equal(denied.response.status(), 403); assert.equal(denied.body.code, 'forbidden');
        assert.equal(await denied.form.getAttribute('data-can-submit-state'), 'denied');
        assert.ok((await denied.form.locator('[data-can-form-feedback]').textContent())!.length > 0);
        assert.equal(await denied.form.locator('input[type="text"]').inputValue(), `Denied ${cause}`);
        assert.equal(invocations, entered); assert.deepEqual(await snapshot(db), before, `${cause} refuses before canonical effects`);
      }
      const dead = await prepare(update, currentRecord);
      await identities.revokeSession(session.session_id); const afterRevocation = await snapshot(db), entered = invocations;
      const expired = await submit(dead.html, 'Revoked must not replace');
      assert.equal(expired.response.status(), 403); assert.equal(expired.body.code, 'forbidden');
      assert.equal(invocations, entered); assert.deepEqual(await snapshot(db), afterRevocation, 'current credential refusal has no effect');
      const finalHistory = await production.store.historyFor(model, recordId);
      assert.deepEqual(finalHistory.map(entry => entry.change), ['create', 'update']);
      assert.deepEqual(finalHistory.map(({ model: writtenModel, recordId: id, version, operation, operationId, actor, change, before, after }) =>
        ({ model: writtenModel, recordId: id, version, operation, operationId, actor, change, before, after })), [
        { model, recordId, version: 1, operation: create, operationId: made.prepared.props.operationId, actor: user.user_id,
          change: 'create', before: null, after: originalRecord.data },
        { model, recordId, version: 2, operation: update, operationId: edited.prepared.props.operationId, actor: user.user_id,
          change: 'update', before: originalRecord.data, after: currentRecord.data },
      ]);
      const finalRow = await production.store.load(model, recordId); assert.ok(finalRow);
      assert.equal(finalRow.version, 2); assert.deepEqual(finalRow.data, { name: 'Actual action updated', enabled: true });
      assert.deepEqual(await receipt(create, made.prepared.props.operationId), createdReceipt);
      assert.deepEqual(await receipt(update, edited.prepared.props.operationId), updatedReceipt);
      assert.deepEqual(await production.store.outboxPending(), []);
      const finalResources = await snapshot(db);
      for (const name of ['outbox', 'schedules']) if (finalResources[name]) assert.equal(finalResources[name]!.length, 0);
      for (const secret of [token, csrf, edited.prepared.props.sourceBinding!]) assert.ok(journal.every(entry => !entry.includes(secret)));
      assert.deepEqual(failures, []); assert.deepEqual(browserErrors, []);
      assert.equal(JSON.stringify(artifact), originalArtifact); assert.equal(await captureIsCurrent(capture), true);
      let contextClosed = false; context.once('close', () => { contextClosed = true; });
      await context.close(); assert.equal(contextClosed, true); assert.equal(page.isClosed(), true);
      assert.equal(lease.browser.contexts().length, 0); await lease.close(); assert.equal(lease.browser.isConnected(), false);
    } finally {
      try { await context?.close(); } finally {
        try { await lease?.close(); } finally {
          try { if (server) { server.closeAllConnections(); if (server.listening) await new Promise<void>((done, reject) => server!.close(error => error ? reject(error) : done())); } }
          finally { try { await miniflare?.dispose(); } finally { await rm(directory, { recursive: true, force: true }); } }
        }
      }
      assert.equal(await captureIsCurrent(capture), true, 'actual native/browser closure stays current through cleanup');
    }
  });
