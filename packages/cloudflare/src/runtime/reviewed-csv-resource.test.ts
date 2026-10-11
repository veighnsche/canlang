/** Prebuilt genuine .can artifact -> generated invoker -> native D1 CSV consumer.
 * This finite durable profile does not claim current CLI emission or Chromium.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, MutationResult, PresentationContext, StoragePort } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { asModel, asOperation, asOperationId } from '@canlang/state/testing/invocation/fixtures';
import { buildSessionCookie, createD1IdentityStore, deriveCsrfToken, ensureIdentitySchema,
  resolveIdentity, sha256HexText } from '@canlang/identity';
import { createHttpHandler, handleCsvRequest, catalogFromArtifactOperations, createSourceFormBindings } from '@canlang/interfaces';
import type { HttpDeps } from '@canlang/interfaces';
import { collectCommitSelections, csvPreviewSection, parseReviewPayload, submitCsvCommit, mintOperationId } from '@canlang/ui';
import type { SubmitFetch } from '@canlang/ui';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker } from '@canlang/cloudflare/worker/assembly';

const APP = 'TypedOperationForms';
const OPERATION = `${APP}.Entry.create`;
const MODEL = asModel(`${APP}.Entry`);
const MAX_BODY_BYTES = 1024 * 1024;
const sourcePath = 'packages/cloudflare/test/fixtures/typed-operation-forms.can';
const artifactPath = 'packages/cloudflare/test/fixtures/typed-operation-forms.json';
type Tables = Record<string, Record<string, unknown>[]>;
async function snapshot(database: D1Database): Promise<Tables> {
  // D1 forbids reading its private metadata. Include all readable Identity,
  // State/application tables and SQLite's sequence; no domain whitelist.
  const tables = await database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name")
    .all<{ name: string }>();
  assert.equal(tables.success, true);
  const result: Tables = {};
  for (const { name } of tables.results) {
    const rows = await database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true);
    result[name] = rows.results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}

test('prebuilt generated CSV maximum review and resource refusals preserve durable effects and replay',
  { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'can-reviewed-csv-resource-'));
  const worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: { DB: 'reviewed-csv-resource' }, d1Persist: join(dir, 'd1') });
  const { Window } = createRequire(import.meta.resolve('@canlang/ui'))('happy-dom') as
    typeof import('../../../ui/node_modules/happy-dom/lib/index.js');
  const window = new Window({ url: 'https://csv.example.test/' });
  try {
    const originalSource = await readFile(resolve(sourcePath));
    const originalArtifact = await readFile(resolve(artifactPath));
    const artifact = JSON.parse(originalArtifact.toString('utf8')) as CompileArtifact;
    assert.deepEqual(artifact.sources, [{ path: sourcePath,
      sha256: createHash('sha256').update(originalSource).digest('hex') }]);
    assert.ok(artifact.modules.some(module => module.map?.sourcesContent?.includes(originalSource.toString('utf8'))),
      'prebuilt generated source map retains the complete owning source');
    const model = artifact.models?.find(model => model.name === MODEL); assert.ok(model);
    assert.equal(model.fields.find(field => field.name === 'owner')?.serverOnly, true);
    const catalog = catalogFromArtifactOperations(artifact);
    const shape = catalog.shapeFor(OPERATION); assert.ok(shape);
    const derived = catalog.derivedFor?.(OPERATION); assert.ok(derived);
    const writable = derived.inputs.filter(input => input.kind !== 'delivery' && shape.allowed.includes(input.name));
    assert.deepEqual(writable.map(input => input.name), ['label', 'count']);
    assert.equal((1000 + 1) * Math.max(1, new Set(writable.map(input => input.name)).size), 2002);

    const db = await worker.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(db); await ensureIdentitySchema(db);
    const state = createD1Storage(db);
    let now = Date.now();
    const clock = { nowMs: () => now };
    const bindingKey = randomBytes(32);
    const sourceRevision = JSON.stringify({ artifact_version: artifact.artifact_version,
      language_version: artifact.language_version, sources: artifact.sources.map(({ path, sha256 }) => ({ path, sha256 }))
        .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0) });
    let formBindings = await createSourceFormBindings(bindingKey, sourceRevision);
    const identities = createD1IdentityStore(db, { clock });
    const team = await identities.createTeam({ timezone: 'UTC' });
    const user = await identities.createUser({ email: 'csv-resource@example.test', password_hash: 'unused', email_verified: true });
    const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: [] });
    const token = 'native-reviewed-csv-resource-session';
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      last_team_id: team.team_id, expires_at: new Date(clock.nowMs() + 3600_000).toISOString() });
    const otherToken = 'native-reviewed-csv-resource-other-session';
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(otherToken),
      last_team_id: team.team_id, expires_at: new Date(clock.nowMs() + 3600_000).toISOString() });
    const cookie = buildSessionCookie(token, { maxAgeSeconds: 3600 }).split(';')[0]!;
    const csrf = await deriveCsrfToken(token);
    const identity = await resolveIdentity(identities, { session_token: token }, { clock });
    const asm = await assembleModules({ artifact, sourcePath: resolve(artifactPath) }, {
      workDir: join(dir, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui') });
    let commits = 0, invocations = 0;
    let afterInvocation: ((outcome: Awaited<ReturnType<HttpDeps['invoker']['invokeMutation']>>) => Promise<void>) | undefined;
    const store: StoragePort = { ...state, async commit(batch) { commits++; return state.commit(batch); } };
    const canonical = buildInvoker(artifact, asm, store, { memberships: identities, source: 'http', now: clock.nowMs });
    const invoker: HttpDeps['invoker'] = { ...canonical,
      async invokeMutation(envelope, context) { invocations++; const outcome = await canonical.invokeMutation(envelope, context);
        await afterInvocation?.(outcome); return outcome; } };
    const unavailable = (): never => { throw new Error('Capability is outside the reviewed durable CSV profile'); };
    const deps: HttpDeps = { app: { appId: APP, brand: APP, appDefaultLocale: 'en', ownerLabels: new Map() },
      pages: { descriptors: () => [] }, invoker, catalog, clock, get formBindings() { return formBindings; }, logger: { log: () => {} },
      limiter: { check: async () => unavailable() },
      identity: { store: identities, clock, mail: { sendMail: async () => unavailable() },
        verifyBaseUrl: '', recoveryBaseUrl: '', inviteBaseUrl: '', sessionMaxAgeSeconds: 3600 }, secureCookies: false,
      uploads: { files: { usesFiles: () => false }, kernel: { maxBytes: unavailable, createIntent: async () => unavailable(),
        append: async () => unavailable(), complete: async () => unavailable(), finalize: async () => unavailable() } },
      ingress: { bindings: { bindingFor: () => null }, verifier: { verify: async () => null },
        sink: { accept: async () => ({ accepted: false }) } } };
    const unused = async () => new Response('Not mounted', { status: 404 });
    const http = createHttpHandler(deps, { csv: request => handleCsvRequest(deps, request),
      operations: unused, auth: unused, uploads: unused, ingress: unused, oauth: unused });
    const post = (body: unknown, path = '/api/csv/review', csrfValue = csrf, sessionCookie = cookie) => http(new Request(`https://csv.example.test${path}`, {
      method: 'POST', headers: { cookie: sessionCookie, 'content-type': 'application/json', 'x-csrf-token': csrfValue },
      body: typeof body === 'string' ? body : JSON.stringify(body) }));
    const wire: SubmitFetch = async (url, init) => {
      assert.ok(typeof init.body === 'string');
      const transported = JSON.parse(init.body) as { consent: { review_token: string } };
      assert.equal(typeof transported.consent.review_token, 'string');
      const response = await post(init.body, url, init.headers['x-csrf-token']);
      return { status: response.status, headers: response.headers, text: () => response.text() };
    };

    // 1000 unique authored rows, 2002 cells, and an exact 1MiB raw request
    // with legal depth-three metadata. Large labels exercise byte and row work
    // together; padding only fills the remaining JSON transport budget.
    const labels = Array.from({ length: 1000 }, (_, index) => `${'x'.repeat(1020)}-${index}`);
    const csv = ['label,count', ...labels.map((label, index) => `${label},${index}`)].join('\n');
    const maximum = { operation: OPERATION, csv, metadata: { nested: { padding: '' } } };
    const padding = 'p'.repeat(MAX_BODY_BYTES - Buffer.byteLength(JSON.stringify(maximum)));
    const exactBody = JSON.stringify({ ...maximum, metadata: { nested: { padding } } });
    assert.equal(Buffer.byteLength(exactBody), MAX_BODY_BYTES);
    const before = await snapshot(db), revision = await state.readRevision();

    // Observe this Node consumer during maximum review. Sampled heap/RSS can
    // miss synchronous transients; OS maxRSS is a process-lifetime high-water
    // mark. Neither includes workerd's separate process, nor defines a quota.
    const initialMemory = process.memoryUsage(), initialMaxRssKiB = process.resourceUsage().maxRSS;
    let samples = 1, sampledPeakRss = initialMemory.rss, sampledPeakHeapUsed = initialMemory.heapUsed;
    const sample = () => { const usage = process.memoryUsage(); samples++;
      sampledPeakRss = Math.max(sampledPeakRss, usage.rss); sampledPeakHeapUsed = Math.max(sampledPeakHeapUsed, usage.heapUsed); };
    const observer = setInterval(sample, 2);
    let response: Response;
    let reviewed: ReturnType<typeof parseReviewPayload>;
    const started = performance.now();
    try { response = await post(exactBody); sample(); assert.equal(response.status, 200);
      reviewed = parseReviewPayload(await response.json()); sample(); }
    finally { clearInterval(observer); }
    t.diagnostic(JSON.stringify({ scope: 'Node maximum-review request and response JSON only; separate workerd excluded',
      rawBodyBytes: Buffer.byteLength(exactBody), csvBytes: Buffer.byteLength(csv), cells: 2002, dataRows: 1000,
      durationMs: performance.now() - started, samples, sampledPeakRssBytes: sampledPeakRss,
      sampledPeakHeapUsedBytes: sampledPeakHeapUsed, initialRssBytes: initialMemory.rss,
      initialHeapUsedBytes: initialMemory.heapUsed, initialProcessMaxRssKiB: initialMaxRssKiB,
      finalProcessMaxRssKiB: process.resourceUsage().maxRSS }));
    assert.deepEqual(reviewed.counts, { total: 1000, valid: 1000, invalid: 0, duplicate: 0 });
    assert.deepEqual(reviewed.rows[999]!.inputs, { label: labels[999], count: '999' });
    assert.deepEqual(await snapshot(db), before, 'maximum review changes no readable table');
    assert.equal(invocations, 0); assert.equal(commits, 0);

    const refused = async (body: unknown, code: string, status: number, path?: string, csrfValue?: string) => {
      const response = await post(body, path, csrfValue);
      assert.equal(response.status, status);
      const error = await response.json() as { code: string; message: string };
      assert.equal(error.code, code);
      assert.equal(error.message.includes('PRIVATE_RESOURCE_MARKER'), false);
      assert.deepEqual(await snapshot(db), before, 'resource refusal changes no readable table');
      assert.equal(invocations, 0); assert.equal(commits, 0);
      return error;
    };
    const excess = { operation: OPERATION, csv: `label,count\nPRIVATE_RESOURCE_MARKER${','.repeat(2000)}` };
    // Header2 + malformed row2001 = 2003 cells. Model width3 must not inflate
    // the source-owned width2 resource profile or allow this to materialize.
    await refused(excess, 'limit', 429);
    await refused({ ...excess, consent: reviewed.consent, rows: [] }, 'limit', 429, '/api/csv/commit');
    await refused(exactBody + ' ', 'limit', 429);
    await refused({ operation: OPERATION, csv, extra: { nested: { fourth: {} } } }, 'limit', 429);
    const malformed = await refused({ operation: OPERATION, csv: csv + '\nextra,1\n"unterminated' }, 'validation', 400);
    assert.equal(malformed.message, 'Unterminated quoted field in CSV text.');
    await refused(excess, 'forbidden', 403, '/api/csv/review', 'bad-csrf');

    // Genuine mounted review controls leave every Identity/application table unchanged.
    const smallCsv = 'label,count\nproof,1\nbad,nope\nproof,1';
    const smallBody = { operation: OPERATION, csv: smallCsv };
    const smallResponse = await post(smallBody); assert.equal(smallResponse.status, 200);
    const small = parseReviewPayload(await smallResponse.json());
    const proofRequest = { ...smallBody, consent: small.consent, rows: [{ index: 0,
      operation_id: '01900000-0000-7000-8000-000000000001' }] };
    const noEffect = async (body: unknown, status: number, code: string, sessionCookie = cookie, csrfValue = csrf) => {
      const snapshotBefore = await snapshot(db), priorInvocations = invocations, priorCommits = commits;
      const response = await post(body, '/api/csv/commit', csrfValue, sessionCookie);
      assert.equal(response.status, status); assert.equal((await response.json() as { code: string }).code, code);
      assert.deepEqual(await snapshot(db), snapshotBefore); assert.equal(invocations, priorInvocations);
      assert.equal(commits, priorCommits);
    };
    const { review_token: omittedProof, ...unsigned } = small.consent;
    await noEffect({ ...proofRequest, consent: unsigned }, 400, 'validation');
    await noEffect({ ...proofRequest, consent: { ...small.consent,
      review_token: omittedProof.slice(0, -1) + (omittedProof.endsWith('A') ? 'B' : 'A') } }, 409, 'conflict');
    const shiftedCsv = 'label,count\nproof,1\nproof,1\nbad,nope';
    const shiftedResponse = await post({ ...smallBody, csv: shiftedCsv }); assert.equal(shiftedResponse.status, 200);
    const shifted = parseReviewPayload(await shiftedResponse.json());
    assert.equal(shifted.consent.candidates_digest, small.consent.candidates_digest);
    await noEffect({ ...proofRequest, csv: shiftedCsv }, 409, 'conflict');
    await noEffect(proofRequest, 409, 'conflict', buildSessionCookie(otherToken, { maxAgeSeconds: 3600 }).split(';')[0]!,
      await deriveCsrfToken(otherToken));
    // Reconstruct the actual provider, rather than manufacturing claims or consent.
    formBindings = await createSourceFormBindings(bindingKey, sourceRevision);
    const reconstructedResponse = await post(smallBody); assert.equal(reconstructedResponse.status, 200);
    const reconstructed = parseReviewPayload(await reconstructedResponse.json());
    assert.deepEqual(reconstructed.consent, small.consent, 'same real key/revision reconstructs the same proof');
    formBindings = await createSourceFormBindings(bindingKey, sourceRevision + '-changed');
    await noEffect(proofRequest, 409, 'conflict');
    formBindings = await createSourceFormBindings(bindingKey, sourceRevision);
    now += 15 * 60_000;
    await noEffect(proofRequest, 409, 'conflict');
    // Maximum-profile proof also expires; renew through the real mounted review.
    const renewedMaximum = await post({ operation: OPERATION, csv }); assert.equal(renewedMaximum.status, 200);
    reviewed = parseReviewPayload(await renewedMaximum.json());

    const context: PresentationContext = { preferredLocales: [], appDefaultLocale: 'en',
      theme: { mode: 'system', accent: 'blue', density: 'comfortable' }, path: '/', isPartial: false,
      csrfToken: csrf, principal: identity, invocation: identity,
      query: async () => { throw new Error('CSV preview does not query rows'); } };
    window.document.body.innerHTML = await csvPreviewSection({ context, review: reviewed, csvText: csv,
      commitPath: '/api/csv/commit', regionId: 'csv-resource-preview' });
    const form = window.document.querySelector('form'); assert.ok(form);
    const checkboxes = form.querySelectorAll('input[type="checkbox"]');
    assert.equal(checkboxes.length, 1000);
    for (const checkbox of checkboxes) {
      const control = checkbox as import('../../../ui/node_modules/happy-dom/lib/index.js').HTMLInputElement;
      control.checked = control.name === 'rows[999].selected';
    }
    const flat: Record<string, string> = {};
    for (const [name, value] of new window.FormData(form).entries()) {
      assert.equal(typeof value, 'string'); flat[name] = value as string;
    }
    assert.equal(flat['consent.review_token'], reviewed.consent.review_token);
    const selected = collectCommitSelections(flat); assert.ok(selected.ok);
    assert.deepEqual(selected.selections.map(row => row.index), [999]);
    const request = { fetchImpl: wire, action: '/api/csv/commit', csrf, operation: OPERATION,
      csv: flat.csv!, consent: { review_id: flat['consent.review_id']!,
        review_token: flat['consent.review_token']!, operation: flat['consent.operation']!,
        principal: flat['consent.principal']!, candidates_digest: flat['consent.candidates_digest']!,
        candidate_count: Number(flat['consent.candidate_count']) }, selections: selected.selections };
    const committed = await submitCsvCommit(request); assert.ok(committed.ok);
    assert.deepEqual(committed.outcome.rows.map(row => [row.index, row.status]), [[999, 'committed']]);
    const rows = await state.query({ model: MODEL, authority: 'owner' });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.data, { label: labels[999], count: '999', owner: { id: user.user_id } });
    assert.equal(await state.readRevision(), revision + 1); assert.equal(commits, 1);
    const receiptIdentity = { app: APP, owner: team.team_id, principal: user.user_id,
      operation: asOperation(OPERATION), operationId: asOperationId(selected.selections[0]!.operation_id) };
    const receipt = await state.readReceipt(receiptIdentity); assert.equal(receipt?.outcome.status, 'committed');
    assert.equal((await state.historyFor(MODEL, rows[0]!.id)).length, 1);
    const saved = await snapshot(db);
    assert.deepEqual(Object.keys(saved), Object.keys(before));
    for (const table of Object.keys(before)) {
      if (!['records', 'receipts', 'history', 'fence', 'fence_log', 'sqlite_sequence'].includes(table)) {
        assert.deepEqual(saved[table], before[table], `selected authored create leaves ${table} unchanged`);
      }
    }
    for (const table of ['records', 'receipts', 'history', 'fence_log']) {
      assert.equal(saved[table]!.length, before[table]!.length + 1, `one selected row adds one ${table} entry`);
    }
    assert.deepEqual(saved['fence'], [{ id: 1, revision: revision + 1 }]);
    assert.deepEqual(saved['sqlite_sequence'], [{ name: 'history', seq: 1 }]);
    const replay = await submitCsvCommit(request); assert.ok(replay.ok);
    assert.equal((replay.outcome.rows[0]!.result as MutationResult).status, 'replayed');
    assert.deepEqual(await snapshot(db), saved, 'same UI selected row replays with no effects');
    assert.deepEqual(await state.readReceipt(receiptIdentity), receipt); assert.equal(commits, 1);
    const batchCsv = 'label,count\nprefix,2\nsuffix,3';
    const batchReviewResponse = await post({ operation: OPERATION, csv: batchCsv });
    assert.equal(batchReviewResponse.status, 200);
    const batchReview = parseReviewPayload(await batchReviewResponse.json());
    const batchIds = [mintOperationId(clock.nowMs), mintOperationId(clock.nowMs)];
    const batchRequest = { ...request, csv: batchCsv, consent: batchReview.consent,
      selections: batchIds.map((operation_id, index) => ({ index, operation_id })) };
    let removedSnapshot: Tables | undefined;
    const beforeBatch = await snapshot(db), beforeInvocations = invocations, beforeCommits = commits;
    afterInvocation = async outcome => { afterInvocation = undefined;
      assert.ok(!('error' in outcome), 'first real canonical row must succeed before revocation');
      assert.equal(outcome.result.status, 'committed');
      await identities.removeMembership(membership.membership_id); removedSnapshot = await snapshot(db); };
    const partial = await submitCsvCommit(batchRequest); assert.ok(partial.ok);
    assert.deepEqual(partial.outcome.rows.map(row => [row.index, row.status]), [[0, 'committed'], [1, 'failed']]);
    assert.equal(partial.outcome.rows[1]!.error?.code, 'forbidden');
    assert.equal(invocations, beforeInvocations + 1); assert.equal(commits, beforeCommits + 1);
    assert.ok(removedSnapshot); assert.deepEqual(await snapshot(db), removedSnapshot);
    for (const table of ['records', 'receipts', 'history', 'fence_log'])
      assert.equal(removedSnapshot[table]!.length, beforeBatch[table]!.length + 1);
    const prefixReceipt = await state.readReceipt({ ...receiptIdentity, operationId: asOperationId(batchIds[0]!) });
    assert.ok(prefixReceipt); assert.equal(await state.readRevision(), revision + 2);
    assert.deepEqual((await state.query({ model: MODEL, authority: 'owner' })).map(row => row.data.label).sort(),
      [labels[999]!, 'prefix'].sort());
    assert.equal(await state.readReceipt({ ...receiptIdentity, operationId: asOperationId(batchIds[1]!) }), null);
    for (const table of Object.keys(beforeBatch))
      if (!['records', 'receipts', 'history', 'fence', 'fence_log', 'sqlite_sequence', 'identity_memberships'].includes(table))
        assert.deepEqual(removedSnapshot[table], beforeBatch[table], `partial batch leaves ${table} unchanged`);
    await identities.reactivateMembership(membership.membership_id, { is_owner: true, roles: [] });
    const renewedBatchResponse = await post({ operation: OPERATION, csv: batchCsv });
    assert.equal(renewedBatchResponse.status, 200);
    const renewedBatch = parseReviewPayload(await renewedBatchResponse.json());
    const beforeRenewalCommit = await snapshot(db);
    const completed = await submitCsvCommit({ ...batchRequest, consent: renewedBatch.consent }); assert.ok(completed.ok);
    assert.equal((completed.outcome.rows[0]!.result as MutationResult).status, 'replayed');
    assert.equal((completed.outcome.rows[1]!.result as MutationResult).status, 'committed');
    assert.equal(commits, beforeCommits + 2); assert.equal(await state.readRevision(), revision + 3);
    assert.deepEqual(await state.readReceipt({ ...receiptIdentity, operationId: asOperationId(batchIds[0]!) }), prefixReceipt);
    const afterRenewalCommit = await snapshot(db);
    for (const table of ['records', 'receipts', 'history', 'fence_log'])
      assert.equal(afterRenewalCommit[table]!.length, beforeRenewalCommit[table]!.length + 1);
    for (const table of Object.keys(beforeRenewalCommit))
      if (!['records', 'receipts', 'history', 'fence', 'fence_log', 'sqlite_sequence'].includes(table))
        assert.deepEqual(afterRenewalCommit[table], beforeRenewalCommit[table]);
    await identities.removeMembership(membership.membership_id);

    const revoked = await snapshot(db), priorInvocations = invocations;
    const denial = await submitCsvCommit(request); assert.equal(denial.ok, false);
    if (!denial.ok) assert.equal(denial.error.code, 'forbidden');
    assert.equal(invocations, priorInvocations); assert.equal(commits, beforeCommits + 2);
    assert.deepEqual(await snapshot(db), revoked, 'current membership refusal leaves durable resources unchanged');
    assert.deepEqual(await readFile(resolve(sourcePath)), originalSource);
    assert.deepEqual(await readFile(resolve(artifactPath)), originalArtifact);
  } finally {
    await window.happyDOM.cancelAsync(); await worker.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
