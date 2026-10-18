/** Public CSV API across real Chromium FormData/native fetch
 * and the existing mounted native D1 consumer. Installed public helpers execute
 * in Node's default loader; Chromium owns DOM selection, FormData and HTTP.
 * This does not qualify an automatic CSV button binder, emitted .can CSV host,
 * current CLI emission, browser distribution, or maximum resource/memory scope.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { test } from 'vitest';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, ModelName, MutationResult, OperationId, OperationName,
  PresentationContext, StoragePort } from '@canlang/contracts';
import type { HttpDeps } from '@canlang/interfaces';
import type { SubmitFetch, SubmitCsvCommitInput } from '@canlang/ui';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const require = createRequire(import.meta.url);
const nodeImport = compileFunction('return import(url)', ['url'], {
  importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
});
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const producer = (name: string) => pathToFileURL(require.resolve(name)).href;
const APP = 'TypedOperationForms', OPERATION = `${APP}.Entry.create`, MODEL = `${APP}.Entry` as ModelName;
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function snapshot(db: D1Database) {
  // Only D1's unreadable private metadata is excluded. Identity, State,
  // application resources and SQLite's sequence are all retained.
  const names = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name")
    .all<{ name: string }>();
  assert.equal(names.success, true);
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  for (const { name } of names.results) {
    const rows = await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true);
    tables[name] = rows.results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return tables;
}

test('public CSV APIs carry Chromium selections and review proof through localhost Identity and canonical D1',
  { timeout: 120000 }, async () => {
  const { assembleModules } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
  const { buildInvoker } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
  const { loadInstalledChromium, prepareLocalPreviewCapture } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
  const { captureSingleFileSource, captureIsCurrent } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
  const { createD1Storage, ensureSchema } = await nodeImport(producer('@canlang/state/storage/d1')) as typeof import('@canlang/state/storage/d1');
  const { hashInputs } = await nodeImport(producer('@canlang/state/invocation/replay')) as typeof import('@canlang/state/invocation/replay');
  const { createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText, deriveCsrfToken } =
    await nodeImport(producer('@canlang/identity')) as typeof import('@canlang/identity');
  const { createHttpHandler, handleCsvRequest, catalogFromArtifactOperations, createSourceFormBindings } =
    await nodeImport(producer('@canlang/interfaces')) as typeof import('@canlang/interfaces');
  const { csvPreviewSection, collectCommitSelections, parseReviewPayload, submitCsvReview, submitCsvCommit } =
    await nodeImport(producer('@canlang/ui')) as typeof import('@canlang/ui');
  const sourcePath = join(root, 'packages/cloudflare/test/fixtures/typed-operation-forms.can');
  const artifactPath = join(root, 'packages/cloudflare/test/fixtures/typed-operation-forms.json');
  const sourceBytes = await readFile(sourcePath), artifactBytes = await readFile(artifactPath);
  const artifact = JSON.parse(artifactBytes.toString('utf8')) as CompileArtifact;
  assert.deepEqual(artifact.sources, [{ path: 'packages/cloudflare/test/fixtures/typed-operation-forms.can',
    sha256: createHash('sha256').update(sourceBytes).digest('hex') }]);
  assert.ok(artifact.modules.some(module => module.map?.sourcesContent?.includes(sourceBytes.toString('utf8'))));
  // Pin existing installed producers and owning source through disposal; this
  // prebuilt-artifact consumer does not invoke or qualify current CLI emission.
  const capture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: root, appPath: sourcePath,
    compilerPath: join(root, 'compiler/target/debug/can'), catalogPath: join(root, 'packages/values/dist/catalog.json'),
    helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md') }));
  assert.equal(capture.sourceSha256, artifact.sources[0]!.sha256); assert.equal(await captureIsCurrent(capture), true);
  const chromium = await loadInstalledChromium(root); assert.ok(chromium, 'installed owning Chromium is required');
  const availability = await chromium.producer.chromiumAvailability(); assert.ok(availability.available);
  const directory = await mkdtemp(join(tmpdir(), 'can-native-csv-browser-'));
  let miniflare: Miniflare | undefined, server: Server | undefined;
  let lease: Awaited<ReturnType<typeof chromium.producer.acquireChromium>> | undefined;
  let context: ReturnType<NonNullable<typeof lease>['browser']['contexts']>[number] | undefined;
  const failures: unknown[] = [], browserErrors: string[] = [];
  try {
    miniflare = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
      script: 'export default {fetch(){return new Response("ok")}}', d1Databases: { DB: 'native-csv-browser' },
      d1Persist: join(directory, 'd1') });
    const db = await miniflare.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(db); await ensureIdentitySchema(db);
    const state = createD1Storage(db);
    let now = Date.now(); const clock = { nowMs: () => now };
    const identities = createD1IdentityStore(db, { clock });
    const user = await identities.createUser({ email: 'native-csv-browser@example.test', password_hash: 'unused', email_verified: true });
    const team = await identities.createTeam({ timezone: 'UTC' });
    const membership = await identities.createMembership({ user_id: user.user_id, team_id: team.team_id, is_owner: true, roles: [] });
    const replacementOwner = await identities.createUser({ email: 'replacement-owner@native-csv-browser.example.test',
      password_hash: 'unused', email_verified: true });
    await identities.createMembership({ user_id: replacementOwner.user_id, team_id: team.team_id,
      is_owner: true, roles: [] });
    const token = randomBytes(32).toString('hex');
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      expires_at: new Date(now + 3600000).toISOString(), last_team_id: team.team_id });
    const csrf = await deriveCsrfToken(token);
    const identity = await resolveIdentity(identities, { session_token: token }, { clock });
    const sourceRevision = JSON.stringify({ artifact_version: artifact.artifact_version,
      language_version: artifact.language_version, sources: artifact.sources.map(({ path, sha256 }) => ({ path, sha256 }))
        .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0) });
    const formBindings = await createSourceFormBindings(randomBytes(32), sourceRevision);
    const asm = await assembleModules({ artifact, sourcePath: artifactPath }, { workDir: join(directory, 'modules'),
      stdlibUrl: producer('@canlang/cloudflare/runtime/stdlib'), uiUrl: producer('@canlang/ui') });
    let commits = 0, invocations = 0;
    let afterInvocation: ((outcome: Awaited<ReturnType<HttpDeps['invoker']['invokeMutation']>>) => Promise<void>) | undefined;
    const store: StoragePort = { ...state, async commit(batch) { commits++; return state.commit(batch); } };
    const canonical = buildInvoker(artifact, asm, store, { memberships: identities, source: 'http', now: clock.nowMs });
    const invoker: HttpDeps['invoker'] = { ...canonical, async invokeMutation(envelope, principal) {
      invocations++; const outcome = await canonical.invokeMutation(envelope, principal);
      await afterInvocation?.(outcome); return outcome;
    } };
    const unavailable = (): never => { throw new Error('Capability is outside this existing mounted CSV profile'); };
    const deps: HttpDeps = { app: { appId: APP, brand: APP, appDefaultLocale: 'en', ownerLabels: new Map() },
      pages: { descriptors: () => [] }, invoker, catalog: catalogFromArtifactOperations(artifact), clock, formBindings,
      logger: { log: () => {} }, limiter: { check: async () => unavailable() },
      identity: { store: identities, clock, mail: { sendMail: async () => unavailable() },
        verifyBaseUrl: '', recoveryBaseUrl: '', inviteBaseUrl: '', sessionMaxAgeSeconds: 3600 }, secureCookies: false,
      uploads: { files: { usesFiles: () => false }, kernel: { maxBytes: unavailable, createIntent: async () => unavailable(),
        append: async () => unavailable(), complete: async () => unavailable(), finalize: async () => unavailable() } },
      ingress: { bindings: { bindingFor: () => null }, verifier: { verify: async () => null },
        sink: { accept: async () => ({ accepted: false }) } } };
    const unused = async () => new Response('Not mounted', { status: 404 });
    const http = createHttpHandler(deps, { csv: request => handleCsvRequest(deps, request),
      operations: unused, auth: unused, uploads: unused, ingress: unused, oauth: unused });
    let origin = '', previewHtml = '<!doctype html><html><body></body></html>';
    const received: Array<{ path: string; headers: Headers; body: string }> = [];
    server = createServer((request, response) => {
      void (async () => {
        if (request.method === 'GET' && request.url === '/') {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(previewHtml); return;
        }
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
          else if (value !== undefined) headers.set(name, value);
        }
        const body = Buffer.concat(chunks).toString('utf8');
        const path = request.url ?? '/'; received.push({ path, headers, body });
        const reply = await http(new Request(new URL(path, origin), { method: request.method ?? 'GET', headers,
          ...(['GET', 'HEAD'].includes(request.method ?? 'GET') ? {} : { body }) }));
        response.writeHead(reply.status, Object.fromEntries(reply.headers)); response.end(Buffer.from(await reply.arrayBuffer()));
      })().catch(error => { failures.push(error); response.writeHead(500); response.end('native CSV host failure'); });
    });
    await new Promise<void>((done, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', done); });
    const address = server.address(); assert.ok(address !== null && typeof address !== 'string');
    origin = `http://127.0.0.1:${address.port}`;
    lease = await chromium.producer.acquireChromium({ signal: new AbortController().signal });
    assert.deepEqual(lease.identity, availability.identity);
    context = await lease.browser.newContext(); context.setDefaultTimeout(10000); context.setDefaultNavigationTimeout(10000);
    await context.addCookies([{ name: 'can_session', value: token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage(); page.on('pageerror', error => browserErrors.push(error.message));
    assert.equal((await page.goto(origin, { waitUntil: 'networkidle' }))!.status(), 200);
    // This test adapter exercises the exported host APIs. It supplies no DOM
    // submit controller: Node invokes the owning helper, whose fetch port crosses
    // into Chromium's genuine same-origin native fetch, cookie and Origin stack.
    const fetchImpl: SubmitFetch = async (url, init) => {
      assert.equal(typeof init.body, 'string');
      const reply = await page.evaluate(async ({ url, method, headers, body }) => {
        const response = await globalThis.fetch(url, { method, headers, body, credentials: 'same-origin', cache: 'no-store' });
        return { status: response.status, headers: Array.from(response.headers.entries()), text: await response.text() };
      }, { url, method: init.method, headers: init.headers, body: init.body as string });
      return { status: reply.status, headers: new Headers(reply.headers), text: async () => reply.text };
    };
    const presentation: PresentationContext = { preferredLocales: [], appDefaultLocale: 'en',
      theme: { mode: 'system', accent: 'blue', density: 'comfortable' }, path: '/', isPartial: false,
      csrfToken: csrf, principal: identity, invocation: identity,
      query: async () => { throw new Error('CSV preview does not query rows'); } };
    const review = async (csv: string) => {
      const before = await snapshot(db), entered = invocations, priorCommits = commits;
      const result = await submitCsvReview({ fetchImpl, action: '/api/csv/review', csrf, operation: OPERATION, csv });
      assert.ok(result.ok); assert.deepEqual(await snapshot(db), before); assert.equal(invocations, entered); assert.equal(commits, priorCommits);
      previewHtml = '<!doctype html><html><body>' + await csvPreviewSection({ context: presentation, review: result.review,
        csvText: csv, commitPath: '/api/csv/commit', regionId: 'csv-preview' }) + '</body></html>';
      assert.equal((await page.goto(origin, { waitUntil: 'networkidle' }))!.status(), 200);
      return result.review;
    };
    const collect = async (): Promise<SubmitCsvCommitInput> => {
      const flat = await page.locator('form[data-csv-commit-form]').evaluate(form => {
        const values: Record<string, string> = {};
        const NativeFormData = globalThis.FormData as unknown as new (form: unknown) => { entries(): IterableIterator<[string, unknown]> };
        for (const [name, value] of new NativeFormData(form).entries()) {
          if (typeof value !== 'string') throw new Error('CSV successful controls must be strings'); values[name] = value;
        }
        return values;
      });
      const selected = collectCommitSelections(flat); assert.ok(selected.ok);
      return { fetchImpl, action: '/api/csv/commit', csrf: flat['_csrf']!, operation: flat['operation']!, csv: flat['csv']!,
        consent: { review_id: flat['consent.review_id']!, review_token: flat['consent.review_token']!,
          operation: flat['consent.operation']!, principal: flat['consent.principal']!,
          candidates_digest: flat['consent.candidates_digest']!, candidate_count: Number(flat['consent.candidate_count']) },
        selections: selected.selections };
    };
    const receipt = (id: string) => state.readReceipt({ app: APP, owner: team.team_id, principal: user.user_id,
      operation: OPERATION as OperationName, operationId: id as OperationId });
    const assertCreate = (before: Awaited<ReturnType<typeof snapshot>>, after: Awaited<ReturnType<typeof snapshot>>) => {
      for (const name of ['records', 'receipts', 'history', 'fence_log']) assert.equal(after[name]!.length, before[name]!.length + 1);
      for (const name of Object.keys(before)) if (!['records', 'receipts', 'history', 'fence', 'fence_log', 'sqlite_sequence'].includes(name))
        assert.deepEqual(after[name], before[name], `canonical CSV preserves unrelated ${name}`);
    };
    const csv = 'label,count\nSelected,7\nExcluded,8\nInvalid,nope\nSelected,7';
    const reviewed = await review(csv);
    assert.deepEqual(reviewed.counts, { total: 4, valid: 2, invalid: 1, duplicate: 1 });
    assert.equal(await page.locator('input[type="checkbox"]').count(), 2);
    assert.equal(await page.locator('#csv-row-2 input[type="checkbox"]').count(), 0);
    assert.equal(await page.locator('#csv-row-3 input[type="checkbox"]').count(), 0);
    assert.match((await page.locator('#csv-row-2').textContent())!, /Invalid/);
    assert.match((await page.locator('#csv-row-3').textContent())!, /Duplicate/);
    await page.locator('input[name="rows[1].selected"]').uncheck();
    const original = await collect(); assert.deepEqual(original.selections.map(row => row.index), [0]);
    assert.equal(original.csv, csv); assert.equal(original.csrf, csrf); assert.equal(original.operation, OPERATION);
    assert.equal(original.consent.review_token, reviewed.consent.review_token);
    // Tamper the real rendered hidden control, then consume native FormData.
    const beforeTamper = await snapshot(db), beforeInvocations = invocations;
    await page.locator('input[name="consent.review_token"]').evaluate(input => (input as unknown as { value: string }).value = 'invalid-proof');
    const tampered = await submitCsvCommit(await collect()); assert.equal(tampered.ok, false);
    if (!tampered.ok) assert.equal(tampered.error.code, 'conflict');
    assert.deepEqual(await snapshot(db), beforeTamper); assert.equal(invocations, beforeInvocations); assert.equal(commits, 0);
    await page.locator('input[name="consent.review_token"]').evaluate((input, proof) => (input as unknown as { value: string }).value = proof, original.consent.review_token);
    const request = await collect(), beforeCreate = await snapshot(db), revision = await state.readRevision();
    const committed = await submitCsvCommit(request); assert.ok(committed.ok);
    assert.deepEqual(committed.outcome.rows.map(row => [row.index, row.status]), [[0, 'committed']]);
    const rows = await state.query({ model: MODEL, authority: 'owner' }); assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.data, { label: 'Selected', count: '7', owner: { id: user.user_id } });
    const savedReceipt = await receipt(request.selections[0]!.operation_id); assert.ok(savedReceipt);
    assert.equal(savedReceipt.inputHash, await hashInputs({ label: 'Selected', count: '7' }));
    assert.equal(savedReceipt.committedRevision, revision + 1); assert.equal(savedReceipt.outcome.status, 'committed');
    assert.equal((await state.historyFor(MODEL, rows[0]!.id)).length, 1); assert.equal(commits, 1);
    const saved = await snapshot(db); assertCreate(beforeCreate, saved);
    assert.equal(await state.readRevision(), revision + 1);
    assert.deepEqual(saved.fence, [{ id: 1, revision: revision + 1 }]);
    assert.deepEqual(saved.sqlite_sequence, [{ name: 'history', seq: 1 }]);
    const replay = await submitCsvCommit(await collect()); assert.ok(replay.ok);
    assert.equal((replay.outcome.rows[0]!.result as MutationResult).status, 'replayed');
    assert.deepEqual(await snapshot(db), saved); assert.deepEqual(await receipt(request.selections[0]!.operation_id), savedReceipt);

    // An original two-row browser selection survives a real partial revocation.
    // After current authority is restored, renewed genuine proof completes only
    // the uncommitted row while the original first row/nonce replays.
    const batchCsv = 'label,count\nPrefix,2\nSuffix,3';
    await review(batchCsv); const batchRequest = await collect();
    const beforeBatch = await snapshot(db), batchCommits = commits, batchInvocations = invocations;
    let removed: Awaited<ReturnType<typeof snapshot>> | undefined;
    afterInvocation = async outcome => { afterInvocation = undefined; assert.ok(!('error' in outcome));
      assert.equal(outcome.result.status, 'committed'); await identities.removeMembership(membership.membership_id); removed = await snapshot(db); };
    const partial = await submitCsvCommit(batchRequest); assert.ok(partial.ok);
    assert.deepEqual(partial.outcome.rows.map(row => [row.index, row.status]), [[0, 'committed'], [1, 'failed']]);
    assert.equal(partial.outcome.rows[1]!.error?.code, 'forbidden');
    assert.equal(invocations, batchInvocations + 1); assert.equal(commits, batchCommits + 1);
    assert.ok(removed); assert.deepEqual(await snapshot(db), removed);
    assert.equal(await receipt(batchRequest.selections[1]!.operation_id), null);
    const prefixReceipt = await receipt(batchRequest.selections[0]!.operation_id); assert.ok(prefixReceipt);
    assert.equal(prefixReceipt.committedRevision, revision + 2);
    assert.equal(await state.readRevision(), revision + 2);
    assert.deepEqual(removed.fence, [{ id: 1, revision: revision + 2 }]);
    for (const name of ['records', 'receipts', 'history', 'fence_log']) assert.equal(removed[name]!.length, beforeBatch[name]!.length + 1);
    for (const name of Object.keys(beforeBatch)) if (!['records', 'receipts', 'history', 'fence', 'fence_log', 'sqlite_sequence', 'identity_memberships'].includes(name))
      assert.deepEqual(removed[name], beforeBatch[name]);
    const beforeDenied = await snapshot(db), deniedInvocations = invocations;
    const denied = await submitCsvCommit(await collect()); assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, 'forbidden');
    assert.equal(invocations, deniedInvocations); assert.deepEqual(await snapshot(db), beforeDenied);
    await identities.reactivateMembership(membership.membership_id, { is_owner: true, roles: [] });
    now += 15 * 60_000;
    const beforeExpiry = await snapshot(db), expiryInvocations = invocations;
    const expired = await submitCsvCommit(await collect()); assert.equal(expired.ok, false);
    if (!expired.ok) assert.equal(expired.error.code, 'conflict');
    assert.equal(invocations, expiryInvocations); assert.deepEqual(await snapshot(db), beforeExpiry);
    const renewed = await review(batchCsv);
    for (const row of batchRequest.selections) await page.locator(`input[name="rows[${row.index}].operation_id"]`)
      .evaluate((input, operationId) => (input as unknown as { value: string }).value = operationId, row.operation_id);
    const renewedRequest = await collect(); assert.equal(renewedRequest.consent.review_token, renewed.consent.review_token);
    assert.deepEqual(renewedRequest.selections, batchRequest.selections);
    const beforeCompletion = await snapshot(db), completed = await submitCsvCommit(renewedRequest); assert.ok(completed.ok);
    assert.equal((completed.outcome.rows[0]!.result as MutationResult).status, 'replayed');
    assert.equal((completed.outcome.rows[1]!.result as MutationResult).status, 'committed');
    assert.equal(commits, batchCommits + 2); assertCreate(beforeCompletion, await snapshot(db));
    assert.equal(await state.readRevision(), revision + 3);
    const suffixReceipt = await receipt(batchRequest.selections[1]!.operation_id); assert.ok(suffixReceipt);
    assert.equal(suffixReceipt.committedRevision, revision + 3);
    assert.equal(suffixReceipt.inputHash, await hashInputs({ label: 'Suffix', count: '3' }));
    assert.deepEqual(await receipt(batchRequest.selections[0]!.operation_id), prefixReceipt);
    const allRows = await state.query({ model: MODEL, authority: 'owner' });
    assert.deepEqual(allRows.map(row => row.data.label).sort(), ['Prefix', 'Selected', 'Suffix']);
    for (const row of allRows) assert.equal((await state.historyFor(MODEL, row.id)).length, 1);
    const complete = await snapshot(db), repeated = await submitCsvCommit(await collect()); assert.ok(repeated.ok);
    assert.ok(repeated.outcome.rows.every(row => (row.result as MutationResult).status === 'replayed'));
    assert.deepEqual(await snapshot(db), complete); assert.equal(commits, batchCommits + 2);

    // Carry the same source-owned maximum profile across Chromium's real
    // cookie/Origin/CSRF fetch, then render its genuine 1000-row preview.
    const maximumLabels = Array.from({ length: 1000 }, (_, index) => `${'x'.repeat(1020)}-${index}`);
    const maximumCsv = ['label,count', ...maximumLabels.map((label, index) => `${label},${index}`)].join('\n');
    const maximum = { operation: OPERATION, csv: maximumCsv, metadata: { nested: { padding: '' } } };
    const padding = 'p'.repeat(1_048_576 - Buffer.byteLength(JSON.stringify(maximum)));
    const exactBody = JSON.stringify({ ...maximum, metadata: { nested: { padding } } });
    assert.equal(Buffer.byteLength(exactBody), 1_048_576);
    const maximumBefore = await snapshot(db), maximumInvocations = invocations, maximumCommits = commits;
    const browserReview = async (body: string) => page.evaluate(async ({ body, csrf }) => {
      const reply = await fetch('/api/csv/review', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body });
      return { status: reply.status, payload: await reply.json() };
    }, { body, csrf });
    const admitted = await browserReview(exactBody); assert.equal(admitted.status, 200);
    const maximumReview = parseReviewPayload(admitted.payload);
    assert.deepEqual(maximumReview.counts, { total: 1000, valid: 1000, invalid: 0, duplicate: 0 });
    assert.deepEqual(maximumReview.rows[999]!.inputs, { label: maximumLabels[999], count: '999' });
    for (const body of [
      exactBody + ' ',
      JSON.stringify({ operation: OPERATION, csv: `label,count\nPRIVATE_RESOURCE_MARKER${','.repeat(2000)}` }),
      JSON.stringify({ operation: OPERATION, csv: maximumCsv, extra: { nested: { fourth: {} } } }),
    ]) {
      const refused = await browserReview(body); assert.equal(refused.status, 429);
      assert.equal(object(refused.payload).code, 'limit');
      assert.equal(JSON.stringify(refused.payload).includes('PRIVATE_RESOURCE_MARKER'), false);
    }
    assert.deepEqual(await snapshot(db), maximumBefore, 'maximum browser review and refusals cannot mutate D1');
    assert.equal(invocations, maximumInvocations); assert.equal(commits, maximumCommits);
    previewHtml = '<!doctype html><html><body>' + await csvPreviewSection({ context: presentation,
      review: maximumReview, csvText: maximumCsv, commitPath: '/api/csv/commit', regionId: 'csv-maximum-preview' }) + '</body></html>';
    assert.equal((await page.goto(origin, { waitUntil: 'networkidle' }))!.status(), 200);
    assert.equal(await page.locator('form[data-csv-commit-form] input[type="checkbox"]').count(), 1000);
    await page.locator('form[data-csv-commit-form]').evaluate(form => {
      for (const input of form.querySelectorAll('input[type="checkbox"]')) {
        const checkbox = input as unknown as { checked: boolean; name: string };
        checkbox.checked = checkbox.name === 'rows[999].selected';
      }
    });
    const maximumRequest = await collect();
    assert.deepEqual(maximumRequest.selections.map(row => row.index), [999]);
    const maximumRevision = await state.readRevision();
    const maximumCommitted = await submitCsvCommit(maximumRequest); assert.ok(maximumCommitted.ok);
    assert.deepEqual(maximumCommitted.outcome.rows.map(row => [row.index, row.status]), [[999, 'committed']]);
    assertCreate(maximumBefore, await snapshot(db));
    assert.equal(invocations, maximumInvocations + 1); assert.equal(commits, maximumCommits + 1);
    const maximumRows = (await state.query({ model: MODEL, authority: 'owner' }))
      .filter(row => row.data.label === maximumLabels[999]);
    assert.equal(maximumRows.length, 1);
    assert.deepEqual(maximumRows[0]!.data, { label: maximumLabels[999], count: '999', owner: { id: user.user_id } });
    assert.equal((await state.historyFor(MODEL, maximumRows[0]!.id)).length, 1);
    const maximumReceipt = await receipt(maximumRequest.selections[0]!.operation_id); assert.ok(maximumReceipt);
    assert.equal(maximumReceipt.inputHash, await hashInputs({ label: maximumLabels[999], count: '999' }));
    assert.equal(maximumReceipt.committedRevision, maximumRevision + 1);
    assert.equal(maximumReceipt.outcome.status, 'committed');
    assert.equal(await state.readRevision(), maximumRevision + 1);
    for (const entry of received.filter(entry => entry.path.startsWith('/api/csv/'))) {
      assert.equal(entry.headers.get('origin'), origin); assert.equal(entry.headers.get('x-csrf-token'), csrf);
      assert.equal(entry.headers.get('cookie'), `can_session=${token}`);
      assert.match(entry.headers.get('content-type')!, /application\/json/);
      if (entry.path === '/api/csv/commit') assert.equal(typeof object(object(JSON.parse(entry.body)).consent).review_token, 'string');
    }
    assert.ok(received.some(entry => entry.path === '/api/csv/review'));
    assert.ok(received.some(entry => entry.path === '/api/csv/commit'));
    assert.deepEqual(failures, []); assert.deepEqual(browserErrors, []);
    assert.deepEqual(await readFile(sourcePath), sourceBytes); assert.deepEqual(await readFile(artifactPath), artifactBytes);
    assert.equal(await captureIsCurrent(capture), true);
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
    assert.equal(server?.listening ?? false, false);
    assert.deepEqual(await readFile(sourcePath), sourceBytes); assert.deepEqual(await readFile(artifactPath), artifactBytes);
    assert.equal(await captureIsCurrent(capture), true);
  }
});
