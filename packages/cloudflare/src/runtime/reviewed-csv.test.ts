import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, MutationResult, PresentationContext, StoragePort } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { asModel, asOperation, asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { buildSessionCookie, createD1IdentityStore, deriveCsrfToken, ensureIdentitySchema, resolveIdentity, sha256HexText } from '@canlang/identity';
import { createHttpHandler, handleAuthRequest, handleCsvRequest, handleOperationRequest, catalogFromArtifactOperations } from '@canlang/interfaces';
import type { HttpDeps } from '@canlang/interfaces';
import { collectCommitSelections, csvConfirmSection, csvPreviewSection, submitCsvCommit, submitCsvReview } from '@canlang/ui';
import type { CsvReviewModel, SubmitFetch } from '@canlang/ui';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker } from '@canlang/cloudflare/worker/assembly';

const APP = 'TypedOperationForms';
const OPERATION = `${APP}.Entry.create`;
const MODEL = asModel(`${APP}.Entry`);

test('reviewed CSV commits authored rows through native D1 admission, replay and live authority', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'can-reviewed-csv-'));
  const worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: { DB: 'reviewed-csv' }, d1Persist: join(dir, 'd1') });
  const { Window } = createRequire(import.meta.resolve('@canlang/ui'))('happy-dom') as
    typeof import('../../../ui/node_modules/happy-dom/lib/index.js');
  const window = new Window({ url: 'https://csv.example.test/' });
  let clockOffset = 0;
  const clock = { nowMs: () => Date.now() + clockOffset };
  const trace: string[] = [];
  try {
    const db = await worker.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(db); await ensureIdentitySchema(db);
    const state = createD1Storage(db);
    const identities = createD1IdentityStore(db, { clock });
    const team = await identities.createTeam({ timezone: 'UTC' });
    const user = await identities.createUser({ email: 'csv-owner@example.test', password_hash: 'unused', email_verified: true });
    const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: [] });
    const token = 'native-reviewed-csv-session';
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      last_team_id: team.team_id, expires_at: new Date(clock.nowMs() + 7 * 24 * 3600_000).toISOString() });
    const cookie = buildSessionCookie(token, { maxAgeSeconds: 3600 }).split(';')[0]!;
    const csrf = await deriveCsrfToken(token);
    const identity = await resolveIdentity(identities, { session_token: token }, { clock });
    const path = resolve('packages/cloudflare/test/fixtures/typed-operation-forms.json');
    const artifact = JSON.parse(await readFile(path, 'utf8')) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: path }, {
      workDir: join(dir, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui') });
    let revokeAfterCommit = false;
    const store: StoragePort = { ...state,
      async readReceipt(receipt) { trace.push(`receipt:${receipt.operationId}`); return state.readReceipt(receipt); },
      async load(model, id) { trace.push(`load:${model}:${id}`); return state.load(model, id); },
      async commit(batch) {
      trace.push('commit');
      const result = await state.commit(batch);
      if (revokeAfterCommit && batch.writes.some(write => write.model === MODEL)) {
        revokeAfterCommit = false;
        await identities.removeMembership(membership.membership_id);
      }
      return result;
    } };
    const invoker = buildInvoker(artifact, asm, store, { memberships: identities, source: 'http', now: clock.nowMs });
    // This route composition mounts only the existing CSV and canonical operation
    // endpoints. No page, upload or provider port participates in this profile.
    const unavailable = (): never => { throw new Error('Capability is not installed in the reviewed CSV host'); };
    const sourceCatalog = catalogFromArtifactOperations(artifact);
    const catalog: HttpDeps['catalog'] = {
      shapeFor(operation) { trace.push(`shape:${operation}`); return sourceCatalog.shapeFor(operation); },
      derivedFor(operation) { trace.push(`derived:${operation}`); return sourceCatalog.derivedFor!(operation); },
    };
    const deps: HttpDeps = { app: { appId: APP, brand: APP, appDefaultLocale: 'en', ownerLabels: new Map() },
      pages: { descriptors: () => [] },
      invoker, catalog, clock, logger: { log: () => {} },
      limiter: { check: async () => unavailable() },
      identity: { store: identities, clock, mail: { sendMail: async () => unavailable() },
        verifyBaseUrl: '', recoveryBaseUrl: '', inviteBaseUrl: '', sessionMaxAgeSeconds: 3600 },
      secureCookies: false,
      uploads: { files: { usesFiles: () => false }, kernel: {
        maxBytes: unavailable, createIntent: async () => unavailable(), append: async () => unavailable(),
        complete: async () => unavailable(), finalize: async () => unavailable(),
      } },
      ingress: { bindings: { bindingFor: () => null }, verifier: { verify: async () => null },
        sink: { accept: async () => ({ accepted: false }) } },
    };
    const unmounted = async () => new Response('Not mounted', { status: 404 });
    const http = createHttpHandler(deps, { csv: request => handleCsvRequest(deps, request),
      operations: (request, operation) => handleOperationRequest(deps, request, operation),
      auth: request => handleAuthRequest(deps, request), uploads: unmounted, ingress: unmounted, oauth: unmounted });
    const wire: SubmitFetch = async (url, init) => {
      trace.push(`request:${url}`);
      const response = await http(new Request(new URL(url, 'https://csv.example.test'), {
        method: init.method, headers: { ...init.headers, cookie }, body: init.body as string }));
      return { status: response.status, headers: response.headers, text: () => response.text() };
    };
    const context: PresentationContext = { preferredLocales: [], appDefaultLocale: 'en',
      theme: { mode: 'system', accent: 'blue', density: 'comfortable' }, path: '/', isPartial: false,
      csrfToken: csrf, principal: identity, invocation: identity,
      query: async () => { throw new Error('CSV presentation does not query rows'); } };
    const review = async (csv: string) => {
      const result = await submitCsvReview({ fetchImpl: wire, action: '/api/csv/review', csrf, operation: OPERATION, csv });
      assert.ok(result.ok, JSON.stringify(result)); return result.review;
    };
    const selections = async (csv: string, reviewed: CsvReviewModel, excluded?: number) => {
      window.document.body.innerHTML = await csvPreviewSection({ context, review: reviewed,
        commitPath: '/api/csv/commit', csvText: csv, regionId: 'csv-preview' });
      const form = window.document.querySelector('form')!;
      if (excluded !== undefined) {
        const checkbox = form.querySelector(`input[name="rows[${excluded}].selected"]`) as
          import('../../../ui/node_modules/happy-dom/lib/index.js').HTMLInputElement;
        checkbox.checked = false;
      }
      const flat: Record<string, string> = {};
      for (const [name, value] of new window.FormData(form).entries()) {
        assert.equal(typeof value, 'string'); flat[name] = value as string;
      }
      const collected = collectCommitSelections(flat);
      assert.ok(collected.ok, JSON.stringify(collected)); return collected.selections;
    };
    const csv = 'label,count\nFirst,\nBad,not-int\nFirst,\nExcluded,2\nSecond,3\n';
    const revision = await state.readRevision();
    const reviewed = await review(csv);
    assert.deepEqual(reviewed.counts, { total: 5, valid: 3, invalid: 1, duplicate: 1 });
    assert.deepEqual(reviewed.rows.map(row => row.status), ['valid', 'invalid', 'duplicate', 'valid', 'valid']);
    assert.equal(reviewed.rows[2]!.duplicate_of, 0);
    assert.equal(await state.readRevision(), revision);
    assert.deepEqual(await state.query({ model: MODEL, authority: 'owner' }), []);
    const selected = await selections(csv, reviewed, 3);
    assert.deepEqual(selected.map(row => row.index), [0, 4]);
    assert.match(window.document.body.textContent, /Bad/);
    assert.match(window.document.body.textContent, /Excluded/);
    const request = { fetchImpl: wire, action: '/api/csv/commit', csrf, operation: OPERATION,
      csv, consent: reviewed.consent, selections: [...selected].reverse() };
    const changed = await submitCsvCommit({ ...request, csv: csv.replace('Second,3', 'Second,4') });
    assert.equal(changed.ok, false); if (!changed.ok) assert.equal(changed.error.code, 'conflict');
    assert.equal(await state.readRevision(), revision);
    const committed = await submitCsvCommit(request);
    assert.ok(committed.ok, JSON.stringify(committed));
    assert.deepEqual(committed.outcome.rows.map(row => [row.index, row.status]), [[0, 'committed'], [4, 'committed']]);
    const rows = await state.query({ model: MODEL, authority: 'owner' });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => [row.data['label'], row.data['count']]).sort(), [['First', '1'], ['Second', '3']]);
    assert.ok(rows.every(row => JSON.stringify(row.data['owner']) === JSON.stringify({ id: user.user_id })));
    const receipts = await Promise.all(selected.map(row => state.readReceipt({ app: APP, owner: team.team_id,
      principal: user.user_id, operation: asOperation(OPERATION), operationId: asOperationId(row.operation_id) })));
    assert.ok(receipts.every(receipt => receipt?.outcome.status === 'committed'));
    assert.equal(receipts[0]!.resolvedDefaults['count'], '1');
    const histories = await Promise.all(rows.map(row => state.historyFor(MODEL, row.id)));
    assert.ok(histories.every(history => history.length === 1));
    const committedRevision = await state.readRevision();
    const replay = await submitCsvCommit(request);
    assert.ok(replay.ok, JSON.stringify(replay));
    assert.deepEqual(replay.outcome.rows.map(row => [row.index, row.operation_id, row.status]),
      committed.outcome.rows.map(row => [row.index, row.operation_id, row.status]));
    for (const [index, row] of replay.outcome.rows.entries()) {
      const original = committed.outcome.rows[index]!.result as MutationResult;
      const repeated = row.result as MutationResult;
      assert.equal(original.status, 'committed');
      assert.equal(repeated.status, 'replayed');
      assert.equal(repeated.operation_id, original.operation_id);
      assert.deepEqual(repeated.result, original.result);
    }
    assert.equal(await state.readRevision(), committedRevision);
    assert.deepEqual(await state.query({ model: MODEL, authority: 'owner' }), rows);
    assert.deepEqual(await Promise.all(rows.map(row => state.historyFor(MODEL, row.id))), histories);
    assert.deepEqual(await Promise.all(selected.map(row => state.readReceipt({ app: APP, owner: team.team_id,
      principal: user.user_id, operation: asOperation(OPERATION), operationId: asOperationId(row.operation_id) }))), receipts);
    window.document.body.innerHTML = await csvConfirmSection({ context, outcome: committed.outcome, regionId: 'csv-confirm' });
    assert.match(window.document.body.textContent, /Committed/);
    assert.match(window.document.body.textContent, new RegExp(user.user_id));

    const lostCsv = 'label,count\nLost response,7\n';
    const lostReview = await review(lostCsv);
    const lostSelections = await selections(lostCsv, lostReview);
    const lostRequest = { ...request, csv: lostCsv, consent: lostReview.consent, selections: lostSelections };
    const lostWire: SubmitFetch = async (url, init) => {
      const response = await wire(url, init);
      assert.equal(response.status, 200);
      await response.text();
      throw new Error('Native transport disconnected after the committed HTTP response');
    };
    const unknown = await submitCsvCommit({ ...lostRequest, fetchImpl: lostWire });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.error.code, 'transport');
    const lostRows = await state.query({ model: MODEL, authority: 'owner' });
    assert.equal(lostRows.length, rows.length + 1);
    const lostRow = lostRows.find(row => row.data['label'] === 'Lost response');
    assert.ok(lostRow);
    const lostReceiptIdentity = { app: APP, owner: team.team_id, principal: user.user_id,
      operation: asOperation(OPERATION), operationId: asOperationId(lostSelections[0]!.operation_id) };
    const lostReceipt = await state.readReceipt(lostReceiptIdentity);
    assert.ok(lostReceipt);
    assert.equal(lostReceipt.outcome.status, 'committed');
    assert.ok(lostReceipt.outcome.status === 'committed');
    const lostHistory = await state.historyFor(MODEL, lostRow.id);
    assert.equal(lostHistory.length, 1);
    const lostRevision = await state.readRevision();
    // The caller explicitly retries the same selected row; the UI helper does
    // not translate an unknown transport outcome into a server verdict or retry.
    const recovered = await submitCsvCommit(lostRequest);
    assert.ok(recovered.ok, JSON.stringify(recovered));
    assert.deepEqual(recovered.outcome.rows.map(row => [row.index, row.operation_id, row.status]),
      [[0, lostSelections[0]!.operation_id, 'committed']]);
    const recoveredResult = recovered.outcome.rows[0]!.result as MutationResult;
    assert.equal(recoveredResult.status, 'replayed');
    assert.equal(recoveredResult.operation_id, lostSelections[0]!.operation_id);
    assert.equal(recoveredResult.result, null);
    assert.deepEqual(recoveredResult.records, [lostReceipt.outcome.result]);
    assert.equal(await state.readRevision(), lostRevision);
    assert.deepEqual(await state.query({ model: MODEL, authority: 'owner' }), lostRows);
    assert.deepEqual(await state.historyFor(MODEL, lostRow.id), lostHistory);
    assert.deepEqual(await state.readReceipt(lostReceiptIdentity), lostReceipt);

    // A genuine source-declared model separates mutation membership from
    // disclosure authority. Replay must project saved bytes with live grants.
    const privateModel = asModel(`${APP}.PrivateEntry`);
    const privateOperation = `${APP}.PrivateEntry.create`;
    await identities.setMembershipRoles(membership.membership_id, [{ role: `${APP}.auditor`,
      granted_at: new Date(clock.nowMs()).toISOString(), granted_by: user.user_id }]);
    const privateCsv = 'label,count\nProtected saved,5\n';
    const privateReview = await submitCsvReview({ fetchImpl: wire, action: '/api/csv/review', csrf,
      operation: privateOperation, csv: privateCsv });
    assert.ok(privateReview.ok, JSON.stringify(privateReview));
    const privateSelections = await selections(privateCsv, privateReview.review);
    const privateId = privateSelections[0]!.operation_id;
    const privateInputs = { label: 'Protected saved', count: '5' };
    const privateRequest = async (operation: string, operationId: string, inputs: Record<string, unknown>) => {
      trace.push(`request:/api/operations/${operation}`);
      return http(new Request(`https://csv.example.test/api/operations/${operation}`, {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ operation_id: operationId, inputs }) }));
    };
    const privateHttp = async (operation: string, operationId: string, inputs: Record<string, unknown>) => {
      const response = await privateRequest(operation, operationId, inputs);
      assert.equal(response.status, 200, await response.clone().text());
      return await response.json() as MutationResult;
    };
    trace.length = 0;
    const privateCreated = await privateHttp(privateOperation, privateId, privateInputs);
    assert.deepEqual(trace.filter(entry => entry.startsWith('shape:') || entry.startsWith('derived:')),
      [`shape:${privateOperation}`, `derived:${privateOperation}`]);
    assert.equal(privateCreated.status, 'committed');
    assert.equal(privateCreated.result, null);
    assert.deepEqual((privateCreated.records![0] as { data: unknown }).data, privateInputs);
    await privateHttp(`${APP}.PrivateEntry.update`, uuidv7(clock.nowMs(), 99), {
      record: { id: privateId, version: '1' }, label: 'Current changed', count: '9' });
    const privateReplay = await privateHttp(privateOperation, privateId, privateInputs);
    assert.equal(privateReplay.status, 'replayed');
    assert.deepEqual(privateReplay.records, privateCreated.records);
    const privateReceiptIdentity = { app: APP, owner: team.team_id, principal: user.user_id,
      operation: asOperation(privateOperation), operationId: asOperationId(privateId) };
    const privateReceipt = await state.readReceipt(privateReceiptIdentity);
    const privateRows = await state.query({ model: privateModel, authority: 'owner' });
    assert.equal(privateRows.length, 1);
    const privateHistory = await state.historyFor(privateModel, privateRows[0]!.id);
    const privateRevision = await state.readRevision();
    // The original committed identity is now outside transport age bounds,
    // while its credential and stored receipt remain live. Only canonical
    // State may decide retained replay versus unseen-age refusal.
    clockOffset = 25 * 3600_000;
    const privateCommit = { ...request, operation: privateOperation, csv: privateCsv,
      consent: privateReview.review.consent, selections: privateSelections };
    const assertReplayTrace = () => {
      assert.ok(trace.some(entry => entry.startsWith('request:')), JSON.stringify(trace));
      assert.ok(trace.includes(`receipt:${privateId}`), JSON.stringify(trace));
      assert.ok(trace.some(entry => entry.startsWith(`load:${privateModel}:`)), JSON.stringify(trace));
      assert.equal(trace.includes('commit'), false, JSON.stringify(trace));
    };
    trace.length = 0;
    const agedHttp = await privateHttp(privateOperation, privateId, privateInputs);
    assert.equal(agedHttp.status, 'replayed');
    assert.deepEqual(agedHttp.records, privateCreated.records);
    assertReplayTrace();
    assert.deepEqual(trace.filter(entry => entry.startsWith('shape:') || entry.startsWith('derived:')),
      [`derived:${privateOperation}`, `shape:${privateOperation}`]);
    trace.length = 0;
    const agedCsv = await submitCsvCommit(privateCommit);
    assert.ok(agedCsv.ok, JSON.stringify(agedCsv));
    const agedCsvResult = agedCsv.outcome.rows[0]!.result as MutationResult;
    assert.equal(agedCsvResult.status, 'replayed');
    assert.deepEqual(agedCsvResult.records, privateCreated.records);
    assertReplayTrace();
    trace.length = 0;
    const conflicting = await privateRequest(privateOperation, privateId, { ...privateInputs, count: '6' });
    assert.equal(conflicting.status, 409, await conflicting.clone().text());
    assert.equal((await conflicting.json() as { code: string }).code, 'conflict');
    assert.ok(trace.includes(`receipt:${privateId}`));
    assert.equal(trace.includes('commit'), false);
    const changedCsv = privateCsv.replace(',5', ',6');
    const changedReview = await submitCsvReview({ fetchImpl: wire, action: '/api/csv/review', csrf,
      operation: privateOperation, csv: changedCsv });
    assert.ok(changedReview.ok, JSON.stringify(changedReview));
    trace.length = 0;
    const conflictingCsv = await submitCsvCommit({ ...privateCommit, csv: changedCsv,
      consent: changedReview.review.consent });
    assert.ok(conflictingCsv.ok, JSON.stringify(conflictingCsv));
    assert.equal(conflictingCsv.outcome.rows[0]!.error?.code, 'conflict');
    assert.ok(trace.includes(`receipt:${privateId}`));
    assert.equal(trace.includes('commit'), false);
    for (const [label, id] of [
      ['expired', uuidv7(clock.nowMs() - 26 * 3600_000, 110)],
      ['future', uuidv7(clock.nowMs() + 10 * 60_000, 111)],
      ['malformed', privateId.toUpperCase()],
    ] as const) {
      trace.length = 0;
      const refused = await privateRequest(privateOperation, id, privateInputs);
      assert.equal(refused.status, 400, `${label}: ${await refused.clone().text()}`);
      assert.equal((await refused.json() as { code: string }).code, 'validation');
      assert.equal(trace.includes(`receipt:${id}`), label !== 'malformed', JSON.stringify(trace));
      assert.equal(trace.includes('commit'), false);
      trace.length = 0;
      const refusedCsv = await submitCsvCommit({ ...privateCommit, selections: [{ index: 0, operation_id: id }] });
      assert.ok(refusedCsv.ok, JSON.stringify(refusedCsv));
      assert.equal(refusedCsv.outcome.rows[0]!.status, 'failed');
      assert.equal(refusedCsv.outcome.rows[0]!.error?.code, 'validation');
      assert.equal(trace.includes(`receipt:${id}`), label !== 'malformed', JSON.stringify(trace));
      assert.equal(trace.includes('commit'), false);
    }
    // A pre-provenance generated CRUD receipt cannot authorize raw content.
    assert.ok(privateReceipt !== null && privateReceipt.outcome.status === 'committed');
    const legacyOutcome = { ...privateReceipt.outcome } as Record<string, unknown>;
    delete legacyOutcome['generatedCrud'];
    const replaceSavedOutcome = (outcome: unknown) => db.prepare(
      'UPDATE receipts SET outcome = ? WHERE app = ? AND owner = ? AND principal = ? AND operation = ? AND operation_id = ?',
    ).bind(JSON.stringify(outcome), APP, team.team_id, user.user_id, privateOperation, privateId).run();
    await replaceSavedOutcome(legacyOutcome);
    trace.length = 0;
    const legacy = await privateRequest(privateOperation, privateId, privateInputs);
    assert.equal(legacy.status, 400);
    const legacyBody = await legacy.text();
    assert.equal((JSON.parse(legacyBody) as { code: string }).code, 'validation');
    assert.equal(legacyBody.includes('Protected saved'), false);
    assert.ok(trace.includes(`receipt:${privateId}`));
    assert.equal(trace.includes('commit'), false);
    trace.length = 0;
    const legacyCsv = await submitCsvCommit(privateCommit);
    assert.ok(legacyCsv.ok, JSON.stringify(legacyCsv));
    assert.equal(legacyCsv.outcome.rows[0]!.error?.code, 'validation');
    assert.equal(JSON.stringify(legacyCsv).includes('Protected saved'), false);
    assert.ok(trace.includes(`receipt:${privateId}`));
    assert.equal(trace.includes('commit'), false);
    await replaceSavedOutcome(privateReceipt.outcome);
    await identities.setMembershipRoles(membership.membership_id, []);
    assert.equal((await identities.findMembership(team.team_id, user.user_id))?.status, 'active');
    trace.length = 0;
    const withheldHttp = await privateHttp(privateOperation, privateId, privateInputs);
    assert.equal(withheldHttp.status, 'replayed');
    assert.equal(withheldHttp.result, null);
    assert.deepEqual(withheldHttp.records, []);
    assertReplayTrace();
    trace.length = 0;
    const withheldCsv = await submitCsvCommit({ ...request, operation: privateOperation, csv: privateCsv,
      consent: privateReview.review.consent, selections: privateSelections });
    assert.ok(withheldCsv.ok, JSON.stringify(withheldCsv));
    const withheld = withheldCsv.outcome.rows[0]!.result as MutationResult;
    assert.equal(withheld.status, 'replayed');
    assert.equal(withheld.result, null);
    assert.deepEqual(withheld.records, []);
    assertReplayTrace();
    assert.equal(JSON.stringify(withheldHttp).includes('Protected saved'), false);
    assert.equal(JSON.stringify(withheldCsv).includes('Protected saved'), false);
    assert.equal(await state.readRevision(), privateRevision);
    assert.deepEqual(await state.query({ model: privateModel, authority: 'owner' }), privateRows);
    assert.deepEqual(await state.historyFor(privateModel, privateRows[0]!.id), privateHistory);
    assert.deepEqual(await state.readReceipt(privateReceiptIdentity), privateReceipt);

    clockOffset = 0;
    const partialCsv = 'label,count\nBefore revocation,5\nAfter revocation,6\n';
    const partialReview = await review(partialCsv);
    const partialSelections = await selections(partialCsv, partialReview);
    revokeAfterCommit = true;
    const partial = await submitCsvCommit({ ...request, csv: partialCsv, consent: partialReview.consent,
      selections: [...partialSelections].reverse() });
    assert.ok(partial.ok, JSON.stringify(partial));
    assert.deepEqual(partial.outcome.rows.map(row => [row.index, row.status]), [[0, 'committed'], [1, 'failed']]);
    assert.equal(partial.outcome.rows[1]!.error?.code, 'forbidden');
    const afterPartial = await state.query({ model: MODEL, authority: 'owner' });
    assert.equal(afterPartial.length, lostRows.length + 1);
    const beforeRevocation = afterPartial.find(row => row.data['label'] === 'Before revocation');
    assert.ok(beforeRevocation);
    assert.equal((await state.historyFor(MODEL, beforeRevocation.id)).length, 1);
    assert.equal((await state.readReceipt({ app: APP, owner: team.team_id, principal: user.user_id,
      operation: asOperation(OPERATION), operationId: asOperationId(partialSelections[0]!.operation_id) }))?.outcome.status, 'committed');
    assert.equal(afterPartial.some(row => row.data['label'] === 'After revocation'), false);
    window.document.body.innerHTML = await csvConfirmSection({ context, outcome: partial.outcome, regionId: 'csv-partial' });
    assert.match(window.document.body.textContent, /Failed/);
    const afterRevision = await state.readRevision();
    clockOffset = 25 * 3600_000;
    trace.length = 0;
    const revokedHttp = await privateHttp(privateOperation, privateId, privateInputs);
    // The established CRUD disclosure contract withholds data while keeping
    // the retained mutation outcome; membership removal does not rewrite it.
    assert.equal(revokedHttp.status, 'replayed');
    assert.equal(revokedHttp.result, null);
    assert.deepEqual(revokedHttp.records, []);
    assert.equal(JSON.stringify(revokedHttp).includes('Protected saved'), false);
    assert.ok(trace.includes(`receipt:${privateId}`));
    assert.equal(trace.includes('commit'), false);
    trace.length = 0;
    const revoked = await submitCsvCommit({ ...request, csv: partialCsv, consent: partialReview.consent, selections: partialSelections });
    assert.equal(revoked.ok, false); if (!revoked.ok) assert.equal(revoked.error.code, 'forbidden');
    assert.equal(JSON.stringify(revoked).includes('Protected saved'), false);
    assert.equal(trace.includes('commit'), false);
    assert.equal(await state.readRevision(), afterRevision);
    assert.deepEqual(await state.query({ model: MODEL, authority: 'owner' }), afterPartial);
  } finally {
    await window.happyDOM.cancelAsync(); await worker.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
