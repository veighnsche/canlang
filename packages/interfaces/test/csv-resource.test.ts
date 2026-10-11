/** DEL-C01/SR02 mounted intake limits; downstream invocation is scripted,
 * while catalog derivation, Identity admission and CSV handling are actual. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARTIFACT_VERSION } from '@canlang/contracts';
import type { ArtifactOperation } from '@canlang/contracts';
import { deriveCsrfToken } from '@canlang/identity';
import { parseCsvText as advisory } from '@canlang/ui';
import { CsvGrammarError, parseCsvGrammar } from '@canlang/ui/csv/grammar';
import { catalogFromArtifactOperations } from '../src/http/operations.js';
import { CsvParseError, CsvResourceLimitError, handleCsvRequest, parseCsvText } from '../src/http/csv.js';
import type { CsvReview } from '../src/http/csv.js';
import { JSON_BODY_MAX_BYTES } from '../src/http/limits.js';
import { mintOperationId } from '../src/http/context.js';
import { createHttpHandler } from '../src/http/routes.js';
import { createTestDeps, testRequest } from '../src/testing.js';

const OP: ArtifactOperation = { name: 'CsvResource.Item.create', kind: 'create', description: '',
  inputs: { fields: [{ name: 'title', field: { kind: 'string' }, required: true }] } };
async function mounted() {
  const t = await createTestDeps({ mutations: {
    [OP.name]: envelope => ({ result: { status: 'committed', operation_id: envelope.operation_id } }),
  } });
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const catalog = catalogFromArtifactOperations({ artifact_version: ARTIFACT_VERSION, operations: [OP] });
  const derivedFor = catalog.derivedFor;
  assert.ok(derivedFor);
  let catalogReads = 0;
  const deps = { ...t.deps, catalog: { ...catalog,
    get shapeFor() { catalogReads++; return catalog.shapeFor; },
    get derivedFor() { catalogReads++; return derivedFor; },
  } };
  const unused = async () => new Response('unused', { status: 500 });
  const http = createHttpHandler(deps, { operations: unused, auth: unused, uploads: unused,
    ingress: unused, oauth: unused, csv: request => handleCsvRequest(deps, request) });
  const post = (value: unknown, path = '/api/csv/review', csrfValue = csrf, cookie = t.identity.cookie) =>
    testRequest(path, { method: 'POST', cookie, headers: { 'content-type': 'application/json', 'x-csrf-token': csrfValue },
      body: typeof value === 'string' ? value : JSON.stringify(value) });
  return { ...t, csrf, http, post, catalogReads: () => catalogReads };
}
const limitError = (error: unknown) => error instanceof CsvResourceLimitError;
async function refusal(response: Response, status: number, code: string, privateText?: string) {
  assert.equal(response.status, status);
  const text = await response.text();
  assert.equal((JSON.parse(text) as { code: string }).code, code);
  if (privateText !== undefined) assert.equal(text.includes(privateText), false);
}

test('CSV authoritative optional resource profile counts header and malformed cells without changing advisory grammar', () => {
  const text = 'title\né';
  const expected = { header: ['title'], rows: [{ cells: ['é'], malformed: false }] };
  const bytes = new TextEncoder().encode(text).byteLength;
  assert.deepEqual(parseCsvText(text, { maxBytes: bytes, maxCells: 2 }), expected);
  assert.deepEqual(parseCsvGrammar(text, { maxBytes: bytes, maxCells: 2 }), expected);
  assert.deepEqual(advisory(text), { ok: true, ...expected });
  assert.deepEqual(advisory(text, { maxBytes: bytes, maxCells: 2 }), { ok: true, ...expected });
  assert.equal(advisory(text, { maxCells: 1 }).ok, false);
  assert.equal(advisory(text, { maxBytes: bytes - 1 }).ok, false);
  assert.throws(() => parseCsvText(text, { maxCells: 1 }), limitError);
  assert.throws(() => parseCsvText(text, { maxBytes: bytes - 1 }), limitError);
  assert.throws(() => parseCsvGrammar(text, { maxCells: 1 }), error => error instanceof CsvGrammarError && error.kind === 'limit');
  const malformed = 'a,b\nx,y,z';
  assert.equal(advisory(malformed).ok, true);
  assert.equal(parseCsvText(malformed, { maxCells: 5 }).rows[0]!.malformed, true);
  assert.throws(() => parseCsvText(malformed, { maxCells: 4 }), limitError);
  for (const invalid of ['a\n"unterminated', 'a\n\ud800']) {
    assert.throws(() => parseCsvText(invalid, { maxCells: 1 }), error => error instanceof CsvParseError);
  }
});

test('mounted one-input CSV admits exactly 1001 cells and refuses oversized headers without invocation or raw disclosure', async () => {
  const t = await mounted();
  const exact = ['title', ...Array.from({ length: 1000 }, (_, index) => `own-${index}`)].join('\n');
  const response = await t.http(t.post({ operation: OP.name, csv: exact }));
  assert.equal(response.status, 200);
  const review = await response.json() as CsvReview;
  assert.deepEqual(review.counts, { total: 1000, valid: 1000, invalid: 0, duplicate: 0 });
  assert.deepEqual(review.rows[999]!.inputs, { title: 'own-999' });
  const marker = 'PRIVATE_HEADER_CONTENT';
  const excessHeader = marker + ','.repeat(1001);
  await refusal(await t.http(t.post({ operation: OP.name, csv: excessHeader })), 429, 'limit', marker);
  // A malformed row still contributes every parsed cell to the resource total.
  const malformed = 'title\n' + marker + ','.repeat(1000);
  await refusal(await t.http(t.post({ operation: OP.name, csv: malformed })), 429, 'limit', marker);
  assert.equal(t.invoker.mutations.length, 0); assert.equal(t.invoker.reads.length, 0);
  assert.equal(JSON.stringify(t.logger.calls).includes(marker), false);
});

test('mounted CSV accepts depth-three review and commit metadata but refuses depth four before catalog lookup', async () => {
  const t = await mounted();
  const csv = 'title\noriginal';
  const reviewed = await t.http(t.post({ operation: OP.name, csv, metadata: { nested: { value: 'retained' } } }));
  assert.equal(reviewed.status, 200);
  const review = await reviewed.json() as CsvReview;
  assert.deepEqual(review.rows[0]!.inputs, { title: 'original' });
  const operationId = mintOperationId();
  const committed = await t.http(t.post({ operation: OP.name, csv, consent: review.consent,
    rows: [{ index: 0, operation_id: operationId }], metadata: { nested: { value: 'retained' } } }, '/api/csv/commit'));
  assert.equal(committed.status, 200);
  assert.equal(t.invoker.mutations.length, 1);
  assert.deepEqual(t.invoker.mutations[0]!.envelope, { operation: OP.name, operation_id: operationId, inputs: { title: 'original' } });
  const before = t.catalogReads();
  const deep = { operation: OP.name, csv: 'title\n"unterminated', extra: { nested: { fourth: {} } } };
  await refusal(await t.http(t.post(deep)), 429, 'limit');
  await refusal(await t.http(t.post({ ...deep, consent: review.consent, rows: [] }, '/api/csv/commit')), 429, 'limit');
  assert.equal(t.catalogReads(), before, 'depth refusal precedes even catalog method access');
  assert.equal(t.invoker.mutations.length, 1);
});

test('mounted CSV late syntax failure wins over row and cell resource excess', async () => {
  const t = await mounted();
  const csv = 'title\n' + Array.from({ length: 1001 }, () => 'own').join('\n') + '\n"unterminated';
  const response = await t.http(t.post({ operation: OP.name, csv }));
  assert.equal(response.status, 400);
  const error = await response.json() as { code: string; message: string };
  assert.equal(error.code, 'validation'); assert.equal(error.message, 'Unterminated quoted field in CSV text.');
  assert.equal(t.invoker.mutations.length, 0);
});

test('mounted CSV retains capped raw body and authentication then body then CSRF demand order', async () => {
  const t = await mounted();
  const csv = 'title\noriginal';
  const base = JSON.stringify({ operation: OP.name, csv, padding: '' });
  const padding = 'p'.repeat(JSON_BODY_MAX_BYTES - new TextEncoder().encode(base).byteLength);
  const exact = JSON.stringify({ operation: OP.name, csv, padding });
  assert.equal(new TextEncoder().encode(exact).byteLength, JSON_BODY_MAX_BYTES);
  assert.equal((await t.http(t.post(exact))).status, 200);
  const oversized = JSON.stringify({ operation: OP.name, csv, padding: padding + 'PRIVATE_EXCESS' });
  const before = t.catalogReads();
  await refusal(await t.http(t.post(oversized)), 429, 'limit', 'PRIVATE_EXCESS');
  await refusal(await t.http(t.post(oversized, '/api/csv/review', 'bad-csrf')), 429, 'limit', 'PRIVATE_EXCESS');
  const anonymous = t.post(oversized, '/api/csv/review', t.csrf, '');
  const originalBody = anonymous.body;
  let bodyReads = 0;
  Object.defineProperty(anonymous, 'body', { get() { bodyReads++; return originalBody; } });
  await refusal(await t.http(anonymous), 403, 'forbidden');
  assert.equal(bodyReads, 0);
  await refusal(await t.http(t.post({ operation: OP.name, csv: 'title' + ','.repeat(1001) },
    '/api/csv/review', 'bad-csrf')), 403, 'forbidden');
  assert.equal(t.catalogReads(), before);
  assert.equal(t.invoker.mutations.length, 0); assert.equal(t.invoker.reads.length, 0);
  assert.equal(JSON.stringify(t.logger.calls).includes('PRIVATE_EXCESS'), false);
});
