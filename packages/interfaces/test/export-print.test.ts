/**
 * FP.EXPORT owned pins: the HTTP contract for authorized bounded CSV
 * export (`http/export.ts`) + declared authorized Print views
 * (`http/print.ts`).
 *
 * Export (`POST /api/exports`): one bounded `<model>.list` read under
 * current grants (fresh identity + T32 liveness per request) projected
 * to CSV — `id` always first (fail closed without row ids), `version`
 * second (empty when the row carries none), then the declared/selected
 * columns; file values export as opaque ids (possession grants
 * nothing), secret values fail the whole export closed, and
 * formula-leading cells (`= + - @` after leading whitespace) are
 * neutralized with a `'` prefix. The outcome declares completeness
 * (`complete`, `row_count`, `truncated`, `next_cursor`), currency
 * (`as_of`), and — when truncated — a download descriptor (opaque
 * deterministic handle, guarded expiry, D-owned URLs) for the large-
 * output lifecycle whose durable backend is D-domain follow-up.
 *
 * Print (`GET /print/<view>`): the same authorized read rendered as an
 * HTML table over a DECLARED view (name/title/operation/columns from
 * the injected registry — never caller-selected fields), with escaped
 * cells, as-of currency, and an explicit truncation note.
 *
 * Grounding: reads ride the real `invokeRead` `<model>.list` shape
 * (`pages.ts` runner convention) with `ListQueryResult` rows/columns;
 * bounds reuse the DESIGN pins (`COLLECTION_MAX_LIMIT` default page,
 * `PAGE_MAX_RECORDS` export ceiling); errors use the canonical
 * envelope/status projection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveCsrfToken, revokeSessionByToken } from '@canlang/identity';
import { COLLECTION_MAX_LIMIT, PAGE_MAX_RECORDS } from '@canlang/contracts';
import type { ListQueryResult } from '@canlang/contracts';
import { handleExportRequest } from '../src/http/export.js';
import type { ExportOutcome } from '../src/http/export.js';
import { handlePrintRequest } from '../src/http/print.js';
import type { PrintViewRegistry } from '../src/http/print.js';
import { createTestDeps, testRequest } from '../src/testing.js';

const OPERATION = 'Billing.Invoice.list';

const COLUMNS = [
  { field: 'customer', label: 'Customer', type: 'text' },
  { field: 'total', label: 'Total', type: 'money' },
];

function listResult(rows: ListQueryResult['rows'], nextCursor?: string): ListQueryResult {
  return { rows, columns: COLUMNS, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

const TWO_ROWS = listResult([
  { id: 'inv-1', version: '3', fields: { customer: 'c-1', total: '100' } },
  { id: 'inv-2', fields: { customer: 'c-2', total: '250' } },
]);

async function exportDeps(reads: NonNullable<Parameters<typeof createTestDeps>[0]>['reads']) {
  const t = await createTestDeps({ ...(reads === undefined ? {} : { reads }) });
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  return { ...t, csrf };
}

function postExport(cookie: string, csrf: string, body: unknown): Request {
  return testRequest('/api/exports', {
    method: 'POST',
    cookie,
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify(body),
  });
}

async function exportOk(
  t: Awaited<ReturnType<typeof exportDeps>>,
  body: unknown,
): Promise<ExportOutcome> {
  const res = await handleExportRequest(t.deps, postExport(t.identity.cookie, t.csrf, body));
  assert.equal(res.status, 200);
  return (await res.json()) as ExportOutcome;
}

const VIEWS: PrintViewRegistry = {
  views: () => [
    {
      name: 'invoice-register',
      title: 'Invoice register',
      operation: OPERATION,
      columns: [
        { field: 'customer', label: 'Customer' },
        { field: 'total', label: 'Total' },
      ],
    },
  ],
};

test('FP.EXPORT: inline export projects id/version/columns with completeness + currency', async () => {
  const t = await exportDeps({ [OPERATION]: () => ({ result: TWO_ROWS }) });
  const body = await exportOk(t, { operation: OPERATION });
  assert.equal(body.operation, OPERATION);
  assert.equal(body.complete, true);
  assert.equal(body.truncated, false);
  assert.equal(body.row_count, 2);
  assert.ok(typeof body.as_of === 'string' && body.as_of.endsWith('Z'));
  assert.deepEqual(body.columns, [
    { field: 'id', label: 'ID' },
    { field: 'version', label: 'Version' },
    { field: 'customer', label: 'Customer' },
    { field: 'total', label: 'Total' },
  ]);
  assert.equal(
    body.csv,
    'id,version,customer,total\ninv-1,3,c-1,100\ninv-2,,c-2,250\n',
  );
  assert.ok(!('descriptor' in body) || body.descriptor === undefined);
  assert.ok(!('next_cursor' in body) || body.next_cursor === undefined);
  /* Current grants: the read carries the live identity, default page 100. */
  assert.equal(t.invoker.reads.length, 1);
  assert.equal(t.invoker.reads[0]!.identity.actor?.user_id, t.identity.userId);
  assert.deepEqual(t.invoker.reads[0]!.envelope, {
    operation: OPERATION,
    inputs: { limit: COLLECTION_MAX_LIMIT },
  });
});

test('FP.EXPORT: column subset honored; unknown column rejects; limit bounds enforced', async () => {
  const t = await exportDeps({ [OPERATION]: () => ({ result: TWO_ROWS }) });
  const subset = await exportOk(t, { operation: OPERATION, columns: ['total'] });
  assert.equal(subset.csv, 'id,version,total\ninv-1,3,100\ninv-2,,250\n');
  const unknown = await handleExportRequest(
    t.deps,
    postExport(t.identity.cookie, t.csrf, { operation: OPERATION, columns: ['zzz'] }),
  );
  assert.equal(unknown.status, 400);
  assert.match(((await unknown.json()) as { message: string }).message, /Unknown export column/);
  for (const limit of [0, PAGE_MAX_RECORDS + 1, 'many']) {
    const res = await handleExportRequest(
      t.deps,
      postExport(t.identity.cookie, t.csrf, { operation: OPERATION, limit }),
    );
    assert.equal(res.status, 400);
  }
  const capped = await exportOk(t, { operation: OPERATION, limit: 1 });
  assert.deepEqual(t.invoker.reads.at(-1)!.envelope.inputs, { limit: 1 });
  /* The layer enforces the requested bound even when the read over-delivers. */
  assert.equal(capped.row_count, 1);
  assert.equal(capped.truncated, true);
});

test('FP.EXPORT: empty declaration evidence grants no export or print columns', async () => {
  const result: ListQueryResult = { rows: [], columns: [], emptyDeclarations: [
    { field: 'customer', type: 'text' }, { field: 'total', type: 'money' },
  ] };
  const t = await exportDeps({ [OPERATION]: () => ({ result }) });
  const requested = await handleExportRequest(t.deps,
    postExport(t.identity.cookie, t.csrf, { operation: OPERATION, columns: ['customer'] }));
  assert.equal(requested.status, 400);
  const refusal = await requested.json() as { code: string; message: string };
  assert.equal(refusal.code, 'validation');
  assert.match(refusal.message, /Unknown export column/);

  const body = await exportOk(t, { operation: OPERATION });
  assert.equal(body.row_count, 0);
  assert.equal(body.csv, 'id,version\n');
  assert.deepEqual(body.columns, [{ field: 'id', label: 'ID' }, { field: 'version', label: 'Version' }]);
  assert.doesNotMatch(JSON.stringify(body), /customer|total|emptyDeclarations/);

  const print = await handlePrintRequest(t.deps, VIEWS,
    testRequest('/print/invoice-register', { method: 'GET', cookie: t.identity.cookie }));
  assert.equal(print.status, 400);
  const printRefusal = await print.json() as { code: string; message: string };
  assert.equal(printRefusal.code, 'validation');
  assert.match(printRefusal.message, /Unknown print column/);
  assert.equal(t.invoker.reads.length, 3);
  assert.ok(t.invoker.reads.every(read => read.identity.actor?.user_id === t.identity.userId));
});

test('FP.EXPORT: truncated reads stay complete=false with cursor + download descriptor', async () => {
  const t = await exportDeps({ [OPERATION]: () => ({ result: listResult(TWO_ROWS.rows, 'cur-9') }) });
  const before = Date.now();
  const body = await exportOk(t, { operation: OPERATION });
  assert.equal(body.complete, false);
  assert.equal(body.truncated, true);
  assert.equal(body.next_cursor, 'cur-9');
  assert.equal(body.row_count, 2);
  const descriptor = body.descriptor!;
  assert.match(descriptor.handle, /^exp-[0-9a-f]{16}$/);
  assert.equal(descriptor.status, 'pending');
  assert.equal(descriptor.truncated, true);
  assert.equal(descriptor.row_estimate, null);
  assert.ok(descriptor.download_url.endsWith(`/api/exports/download/${descriptor.handle}`));
  assert.ok(descriptor.status_url.endsWith(`/api/exports/status/${descriptor.handle}`));
  /* Guarded expiry: ~15 minutes, never open-ended. */
  const expiresMs = Date.parse(descriptor.expires_at);
  assert.ok(expiresMs - before >= 14 * 60 * 1000 && expiresMs - before <= 16 * 60 * 1000);
  /* Deterministic handle: the same request replays the same descriptor. */
  const again = await exportOk(t, { operation: OPERATION });
  assert.equal(again.descriptor!.handle, descriptor.handle);
});

test('FP.EXPORT: formula-leading cells neutralized; quoting + file ids explicit', async () => {
  const t = await exportDeps({
    [OPERATION]: () => ({
      result: listResult([
        { id: 'inv-1', version: '1', fields: { customer: '=1+1', total: '@x' } },
        { id: 'inv-2', version: '1', fields: { customer: '  +7', total: '-2' } },
        { id: 'inv-3', version: '1', fields: { customer: 'Oaks, "Fine"', total: { kind: 'file', id: 'file-9' } } },
      ]),
    }),
  });
  const body = await exportOk(t, { operation: OPERATION });
  assert.equal(
    body.csv,
    'id,version,customer,total\n' +
      "inv-1,1,'=1+1,'@x\n" +
      "inv-2,1,'  +7,'-2\n" +
      'inv-3,1,"Oaks, ""Fine""",file-9\n',
  );
});

test('FP.EXPORT: secrets fail the export closed; rows without ids fail closed', async () => {
  const secret = await exportDeps({
    [OPERATION]: () => ({
      result: listResult([{ id: 'inv-1', version: '1', fields: { customer: { kind: 'secret' }, total: '1' } }]),
    }),
  });
  const secretRes = await handleExportRequest(
    secret.deps,
    postExport(secret.identity.cookie, secret.csrf, { operation: OPERATION }),
  );
  assert.equal(secretRes.status, 400);
  assert.match(((await secretRes.json()) as { message: string }).message, /secret/i);
  const noid = await exportDeps({
    [OPERATION]: () => ({
      result: listResult([{ id: '', version: '1', fields: { customer: 'c', total: '1' } }]),
    }),
  });
  const noidRes = await handleExportRequest(
    noid.deps,
    postExport(noid.identity.cookie, noid.csrf, { operation: OPERATION }),
  );
  assert.equal(noidRes.status, 400);
  assert.match(((await noidRes.json()) as { message: string }).message, /row ids/);
});

test('FP.EXPORT: anonymous, CSRF-less, and revoked callers denied before any read', async () => {
  const t = await exportDeps({ [OPERATION]: () => ({ result: TWO_ROWS }) });
  const anon = await handleExportRequest(
    t.deps,
    testRequest('/api/exports', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': t.csrf },
      body: JSON.stringify({ operation: OPERATION }),
    }),
  );
  assert.equal(anon.status, 403);
  const noCsrf = await handleExportRequest(
    t.deps,
    testRequest('/api/exports', {
      method: 'POST',
      cookie: t.identity.cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: OPERATION }),
    }),
  );
  assert.equal(noCsrf.status, 403);
  await revokeSessionByToken(t.deps.identity.store, { token: t.identity.sessionToken });
  const revoked = await handleExportRequest(
    t.deps,
    postExport(t.identity.cookie, t.csrf, { operation: OPERATION }),
  );
  assert.equal(revoked.status, 403);
  assert.equal(t.invoker.reads.length, 0);
});

test('FP.EXPORT: non-list operations reject; malformed read results stay internal', async () => {
  const t = await exportDeps({ [OPERATION]: () => ({ result: TWO_ROWS }) });
  for (const operation of ['Billing.Invoice.create', 'nope', 'Billing.Invoice.list.extra']) {
    const res = await handleExportRequest(
      t.deps,
      postExport(t.identity.cookie, t.csrf, { operation }),
    );
    assert.equal(res.status, 400);
  }
  assert.equal(t.invoker.reads.length, 0);
  const broken = await exportDeps({ [OPERATION]: () => ({ result: { rows: [{ id: 'x' }] } }) });
  const res = await handleExportRequest(
    broken.deps,
    postExport(broken.identity.cookie, broken.csrf, { operation: OPERATION }),
  );
  assert.equal(res.status, 422);
  const body = (await res.json()) as { code: string; message: string };
  assert.equal(body.code, 'rule_failed');
  assert.ok(!body.message.includes('malformed'));
});

test('FP.EXPORT print: declared view renders escaped authorized HTML with currency + completeness', async () => {
  const t = await exportDeps({ [OPERATION]: () => ({ result: TWO_ROWS }) });
  const res = await handlePrintRequest(
    t.deps,
    VIEWS,
    testRequest('/print/invoice-register', { method: 'GET', cookie: t.identity.cookie }),
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  assert.match(html, /<title>Invoice register<\/title>/);
  assert.match(html, /<th>Customer<\/th>.*<th>Total<\/th>/s);
  assert.match(html, /<td>c-1<\/td>/);
  assert.match(html, /as of .*Z/);
  assert.match(html, /2 rows/);
  assert.equal(t.invoker.reads.length, 1);
  /* Cells escape; truncation notes explicitly. */
  const xss = await exportDeps({
    [OPERATION]: () => ({
      result: listResult(
        [{ id: 'inv-1', version: '1', fields: { customer: '<script>alert(1)</script>', total: '1' } }],
        'cur-1',
      ),
    }),
  });
  const xssRes = await handlePrintRequest(
    xss.deps,
    VIEWS,
    testRequest('/print/invoice-register', { method: 'GET', cookie: xss.identity.cookie }),
  );
  const xssHtml = await xssRes.text();
  assert.ok(!xssHtml.includes('<script>'));
  assert.match(xssHtml, /&lt;script&gt;/);
  assert.match(xssHtml, /truncated|more rows/i);
});

test('FP.EXPORT print: unknown views 404; undeclared columns fail closed; anonymous denied', async () => {
  const t = await exportDeps({ [OPERATION]: () => ({ result: TWO_ROWS }) });
  const missing = await handlePrintRequest(
    t.deps,
    VIEWS,
    testRequest('/print/nope', { method: 'GET', cookie: t.identity.cookie }),
  );
  assert.equal(missing.status, 404);
  const badView: PrintViewRegistry = {
    views: () => [{ name: 'bad', title: 'Bad', operation: OPERATION, columns: [{ field: 'zzz', label: 'Zzz' }] }],
  };
  const bad = await handlePrintRequest(
    t.deps,
    badView,
    testRequest('/print/bad', { method: 'GET', cookie: t.identity.cookie }),
  );
  assert.equal(bad.status, 400);
  const anon = await handlePrintRequest(
    t.deps,
    VIEWS,
    testRequest('/print/invoice-register', { method: 'GET' }),
  );
  assert.equal(anon.status, 403);
  const post = await handlePrintRequest(
    t.deps,
    VIEWS,
    testRequest('/print/invoice-register', { method: 'POST', cookie: t.identity.cookie }),
  );
  assert.equal(post.status, 404);
});
