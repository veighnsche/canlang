/**
 * FP.EXPORT-DISPATCH route pins: the accepted `http/export.js` +
 * `http/print.js` slices mounted at `/api/exports` and `/print/*`
 * through the real top-level `createHttpHandler` with the real
 * handlers injected via `HttpSubHandlers.exports` / `.print`.
 *
 * No export/print semantics are reimplemented here — every behavior
 * delegates to E's accepted handlers (pinned in
 * `export-print.test.ts`); this suite pins the DISPATCH join: the
 * routes reach the real handlers, auth/authority denials hold at the
 * route, reads dispatch through the same canonical invoker join
 * (observed via the invoker's own call log, never wrapper counters),
 * truncation/expiry/replay behave at the route, unknown/unmounted
 * routes answer `not_found`, and the pre-existing routes are
 * unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveCsrfToken, revokeSessionByToken } from '@canlang/identity';
import { COLLECTION_MAX_LIMIT } from '@canlang/contracts';
import type { ListQueryResult } from '@canlang/contracts';
import { ARTIFACT_VERSION } from '@canlang/contracts';
import type { ArtifactOperation } from '@canlang/contracts';
import { catalogFromArtifactOperations, handleOperationRequest } from '../src/http/operations.js';
import { handleAuthRequest } from '../src/http/auth.js';
import { handleCsvRequest } from '../src/http/csv.js';
import { mintOperationId } from '../src/http/context.js';
import { handleExportRequest } from '../src/http/export.js';
import type { ExportOutcome } from '../src/http/export.js';
import { handlePrintRequest } from '../src/http/print.js';
import type { PrintViewRegistry } from '../src/http/print.js';
import { createHttpHandler } from '../src/http/routes.js';
import type { HttpSubHandlers } from '../src/http/routes.js';
import { createTestDeps, testRequest } from '../src/testing.js';
import { createMemoryExportDownloadStore } from '../src/testing.js';
import { canonicalJson } from '../src/http/canonical-json.js';
import { createHash } from 'node:crypto';

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

/* Fixture mutation op (t19a/t19b vocabulary) for the unchanged-routes check. */
const CSV_ISSUE: ArtifactOperation = {
  "name": "Billing.Invoice.issue",
  "kind": "create",
  "description": "",
  "inputs": {"fields": [
    {"name": "customer", "field": {"kind": "string"}, "required": true},
  ]},
};

async function exportRouteDeps(overrides: Parameters<typeof createTestDeps>[0] = {}) {
  const t = await createTestDeps(overrides);
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const deps = t.deps;
  const sub: HttpSubHandlers = {
    operations: (req, op) => handleOperationRequest(deps, req, op),
    auth: (req) => handleAuthRequest(deps, req),
    uploads: () => Promise.resolve(new Response('unused', { status: 500 })),
    ingress: () => Promise.resolve(new Response('unused', { status: 500 })),
    oauth: () => Promise.resolve(new Response('unused', { status: 500 })),
    exports: (req) => handleExportRequest(deps, req),
    print: (req) => handlePrintRequest(deps, VIEWS, req),
  };
  return { ...t, deps, csrf, http: createHttpHandler(deps, sub) };
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
  t: Awaited<ReturnType<typeof exportRouteDeps>>,
  body: unknown,
): Promise<ExportOutcome> {
  const res = await t.http(postExport(t.identity.cookie, t.csrf, body));
  assert.equal(res.status, 200);
  return (await res.json()) as ExportOutcome;
}

test('FP.EXPORT-DISPATCH: export reaches the real handler via the route with declared semantics', async () => {
  const t = await exportRouteDeps({ reads: { [OPERATION]: () => ({ result: TWO_ROWS }) } });
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
  assert.equal(body.csv, 'id,version,customer,total\ninv-1,3,c-1,100\ninv-2,,c-2,250\n');
  /* Canonical join control: one read, live identity, default page inputs. */
  assert.equal(t.invoker.reads.length, 1);
  assert.equal(t.invoker.reads[0]!.identity.actor?.user_id, t.identity.userId);
  assert.deepEqual(t.invoker.reads[0]!.envelope, {
    operation: OPERATION,
    inputs: { limit: COLLECTION_MAX_LIMIT },
  });
});

test('FP.EXPORT-DISPATCH: anonymous, CSRF-less, revoked, and wrong-method callers denied at the route', async () => {
  const t = await exportRouteDeps({ reads: { [OPERATION]: () => ({ result: TWO_ROWS }) } });
  const anon = await t.http(
    testRequest('/api/exports', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': t.csrf },
      body: JSON.stringify({ operation: OPERATION }),
    }),
  );
  assert.equal(anon.status, 403);
  const noCsrf = await t.http(
    testRequest('/api/exports', {
      method: 'POST',
      cookie: t.identity.cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: OPERATION }),
    }),
  );
  assert.equal(noCsrf.status, 403);
  const wrongMethod = await t.http(
    testRequest('/api/exports', { method: 'GET', cookie: t.identity.cookie }),
  );
  assert.equal(wrongMethod.status, 404);
  assert.equal(((await wrongMethod.json()) as { code: string }).code, 'not_found');
  await revokeSessionByToken(t.deps.identity.store, { token: t.identity.sessionToken });
  const revoked = await t.http(postExport(t.identity.cookie, t.csrf, { operation: OPERATION }));
  assert.equal(revoked.status, 403);
  assert.equal(t.invoker.reads.length, 0);
});

test('FP.EXPORT-DISPATCH: truncation declares cursor + descriptor with guarded expiry at the route', async () => {
  const t = await exportRouteDeps({
    reads: { [OPERATION]: () => ({ result: listResult(TWO_ROWS.rows, 'cur-9') }) },
  });
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
  const expiresMs = Date.parse(descriptor.expires_at);
  assert.ok(expiresMs - before >= 14 * 60 * 1000 && expiresMs - before <= 16 * 60 * 1000);
});

test('FP.EXPORT-DISPATCH: repeats replay-safe with deterministic descriptors; limits bound rows', async () => {
  const t = await exportRouteDeps({ reads: { [OPERATION]: () => ({ result: TWO_ROWS }) } });
  const first = await exportOk(t, { operation: OPERATION });
  const second = await exportOk(t, { operation: OPERATION });
  assert.equal(second.csv, first.csv);
  /* Currency is wall-clock: consecutive runs may straddle a millisecond
   * (main flake ...50.503Z vs ...50.502Z), so proximity — not identity. */
  assert.ok(Math.abs(Date.parse(second.as_of) - Date.parse(first.as_of)) < 60_000);
  assert.equal(t.invoker.reads.length, 2);
  assert.deepEqual(t.invoker.reads[1]!.envelope, t.invoker.reads[0]!.envelope);
  const capped = await exportOk(t, { operation: OPERATION, limit: 1 });
  assert.equal(capped.row_count, 1);
  assert.equal(capped.truncated, true);
  assert.deepEqual(t.invoker.reads.at(-1)!.envelope.inputs, { limit: 1 });
});

test('FP.EXPORT-DISPATCH: declared print view renders via the route; unknown/anon/wrong-method denied', async () => {
  const t = await exportRouteDeps({ reads: { [OPERATION]: () => ({ result: TWO_ROWS }) } });
  const res = await t.http(testRequest('/print/invoice-register', { method: 'GET', cookie: t.identity.cookie }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  assert.match(html, /<title>Invoice register<\/title>/);
  assert.match(html, /<th>Customer<\/th>.*<th>Total<\/th>/s);
  assert.match(html, /<td>c-1<\/td>/);
  assert.match(html, /as of .*Z/);
  assert.match(html, /2 rows/);
  assert.equal(t.invoker.reads.length, 1);
  const missing = await t.http(testRequest('/print/nope', { method: 'GET', cookie: t.identity.cookie }));
  assert.equal(missing.status, 404);
  const anon = await t.http(testRequest('/print/invoice-register', { method: 'GET' }));
  assert.equal(anon.status, 403);
  const post = await t.http(
    testRequest('/print/invoice-register', { method: 'POST', cookie: t.identity.cookie }),
  );
  assert.equal(post.status, 404);
});

test('FP.EXPORT-DISPATCH: unknown export/print subpaths are not_found; unmounted stays not_found', async () => {
  const t = await exportRouteDeps({ reads: { [OPERATION]: () => ({ result: TWO_ROWS }) } });
  const guessed = await t.http(
    testRequest('/api/exports/download/exp-0123456789abcdef', { method: 'GET', cookie: t.identity.cookie }),
  );
  assert.equal(guessed.status, 404);
  assert.equal(((await guessed.json()) as { code: string }).code, 'not_found');
  const emptyPrint = await t.http(testRequest('/print/', { method: 'GET', cookie: t.identity.cookie }));
  assert.equal(emptyPrint.status, 404);
  /* Assemblies without the delivery join: prefixes present, handlers absent. */
  const unmounted = createHttpHandler(t.deps, {
    operations: (req, op) => handleOperationRequest(t.deps, req, op),
    auth: (req) => handleAuthRequest(t.deps, req),
    uploads: () => Promise.resolve(new Response('unused', { status: 500 })),
    ingress: () => Promise.resolve(new Response('unused', { status: 500 })),
    oauth: () => Promise.resolve(new Response('unused', { status: 500 })),
  });
  const coldExport = await unmounted(postExport(t.identity.cookie, t.csrf, { operation: OPERATION }));
  assert.equal(coldExport.status, 404);
  const coldPrint = await unmounted(
    testRequest('/print/invoice-register', { method: 'GET', cookie: t.identity.cookie }),
  );
  assert.equal(coldPrint.status, 404);
  assert.equal(t.invoker.reads.length, 0);
});

test('FP.EXPORT-DISPATCH: pre-existing routes unchanged — operations, csv, auth serve; 404s stay 404', async () => {
  const t = await createTestDeps({
    mutations: {
      ['Billing.Invoice.issue']: (envelope) => ({
        result: { status: 'committed', operation_id: envelope.operation_id },
      }),
    },
  });
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const deps = {
    ...t.deps,
    catalog: catalogFromArtifactOperations({ artifact_version: ARTIFACT_VERSION, operations: [CSV_ISSUE] }),
  };
  const http = createHttpHandler(deps, {
    operations: (req, op) => handleOperationRequest(deps, req, op),
    auth: (req) => handleAuthRequest(deps, req),
    uploads: () => Promise.resolve(new Response('unused', { status: 500 })),
    ingress: () => Promise.resolve(new Response('unused', { status: 500 })),
    oauth: () => Promise.resolve(new Response('unused', { status: 500 })),
    csv: (req) => handleCsvRequest(deps, req),
    exports: (req) => handleExportRequest(deps, req),
    print: (req) => handlePrintRequest(deps, VIEWS, req),
  });
  const operation_id = mintOperationId();
  const op = await http(
    testRequest('/api/operations/Billing.Invoice.issue', {
      method: 'POST',
      cookie: t.identity.cookie,
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ operation_id, inputs: { customer: 'c-9' } }),
    }),
  );
  assert.equal(op.status, 200);
  assert.equal(t.invoker.mutations.length, 1);
  assert.deepEqual(t.invoker.mutations[0]!.envelope, {
    operation: 'Billing.Invoice.issue',
    operation_id,
    inputs: { customer: 'c-9' },
  });
  const review = await http(
    testRequest('/api/csv/review', {
      method: 'POST',
      cookie: t.identity.cookie,
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ operation: 'Billing.Invoice.issue', csv: 'customer\nc-1\n' }),
    }),
  );
  assert.equal(review.status, 200);
  assert.equal(((await review.json()) as { counts: { valid: number } }).counts.valid, 1);
  const login = await http(testRequest('/auth/login', { method: 'GET' }));
  assert.equal(login.status, 200);
  const emptyOp = await http(
    testRequest('/api/operations/', {
      method: 'POST',
      cookie: t.identity.cookie,
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: '{}',
    }),
  );
  assert.equal(emptyOp.status, 404);
  assert.equal(t.invoker.mutations.length, 1);
});

/* DEL-B02 durable large-output backend: same dispatch join plus an injected store. */

async function exportDownloadDeps(overrides: Parameters<typeof createTestDeps>[0] = {}) {
  const t = await exportRouteDeps(overrides);
  const store = createMemoryExportDownloadStore();
  const deps = { ...t.deps, exportDownloads: store };
  const sub: HttpSubHandlers = {
    operations: (req, op) => handleOperationRequest(deps, req, op),
    auth: (req) => handleAuthRequest(deps, req),
    uploads: () => Promise.resolve(new Response('unused', { status: 500 })),
    ingress: () => Promise.resolve(new Response('unused', { status: 500 })),
    oauth: () => Promise.resolve(new Response('unused', { status: 500 })),
    exports: (req) => handleExportRequest(deps, req),
    print: (req) => handlePrintRequest(deps, VIEWS, req),
  };
  return { ...t, deps, store, http: createHttpHandler(deps, sub) };
}

function getDownload(t: { http: (req: Request) => Promise<Response>; identity: { cookie: string } }, path: string) {
  return t.http(testRequest(path, { method: 'GET', cookie: t.identity.cookie }));
}

const PAGE_ROWS = [
  { id: 'e-1', version: '1', fields: { customer: 'a', total: '10' } },
  { id: 'e-2', fields: { customer: 'b', total: '20' } },
];

function pagedReads(pages: ListQueryResult['rows'][]) {
  return {
    [OPERATION]: (envelope: { inputs: { cursor?: string } }) => {
      const index = envelope.inputs.cursor === undefined ? 0 : Number(envelope.inputs.cursor);
      const rows = pages[index] ?? [];
      const next = index + 1;
      return { result: listResult(rows, next < pages.length ? String(next) : undefined) };
    },
  };
}

test('DEL-B02: truncated export registers; status pending then ready; download serves the full output', async () => {
  const t = await exportDownloadDeps({ reads: pagedReads([[PAGE_ROWS[0]!], [PAGE_ROWS[1]!]]) });
  const outcome = await exportOk(t, { operation: OPERATION, limit: 1 });
  assert.equal(outcome.truncated, true);
  const descriptor = outcome.descriptor!;
  const statusBefore = await getDownload(t, `/api/exports/status/${descriptor.handle}`);
  assert.equal(statusBefore.status, 200);
  const pending = (await statusBefore.json()) as Record<string, unknown>;
  assert.equal(pending['status'], 'pending');
  assert.equal(pending['handle'], descriptor.handle);
  assert.equal(pending['expires_at'], descriptor.expires_at);
  assert.ok(!('row_count' in pending));
  const download = await getDownload(t, `/api/exports/download/${descriptor.handle}`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type') ?? '', /text\/csv/);
  assert.equal(await download.text(), 'id,version,customer,total\ne-1,1,a,10\ne-2,,b,20\n');
  const statusAfter = await getDownload(t, `/api/exports/status/${descriptor.handle}`);
  const ready = (await statusAfter.json()) as Record<string, unknown>;
  assert.equal(ready['status'], 'ready');
  assert.equal(ready['row_count'], 2);
  const again = await getDownload(t, `/api/exports/download/${descriptor.handle}`);
  assert.equal(await again.text(), 'id,version,customer,total\ne-1,1,a,10\ne-2,,b,20\n');
});

test('DEL-B02: replay converges on the same handle, expiry and completed body', async () => {
  const t = await exportDownloadDeps({ reads: pagedReads([[PAGE_ROWS[0]!], [PAGE_ROWS[1]!]]) });
  const first = await exportOk(t, { operation: OPERATION, limit: 1 });
  const download = await getDownload(t, `/api/exports/download/${first.descriptor!.handle}`);
  assert.equal(download.status, 200);
  const second = await exportOk(t, { operation: OPERATION, limit: 1 });
  assert.equal(second.descriptor!.handle, first.descriptor!.handle);
  assert.equal(second.descriptor!.expires_at, first.descriptor!.expires_at);
  const again = await getDownload(t, `/api/exports/download/${first.descriptor!.handle}`);
  assert.equal(again.status, 200);
  assert.equal(await again.text(), await download.clone().text());
});

test('DEL-B02: unknown handles and missing store answer not_found', async () => {
  const t = await exportDownloadDeps({ reads: { [OPERATION]: () => ({ result: TWO_ROWS }) } });
  const guessed = await getDownload(t, '/api/exports/download/exp-0123456789abcdef');
  assert.equal(guessed.status, 404);
  assert.equal(((await guessed.json()) as { code: string }).code, 'not_found');
  const status = await getDownload(t, '/api/exports/status/exp-0123456789abcdef');
  assert.equal(status.status, 404);
  const malformed = await getDownload(t, '/api/exports/download/not-a-handle!');
  assert.equal(malformed.status, 404);
  const plain = await exportRouteDeps({ reads: { [OPERATION]: () => ({ result: TWO_ROWS }) } });
  const outcome = await exportOk(plain, { operation: OPERATION });
  assert.equal(outcome.truncated, false);
});

test('DEL-B02: storeless truncated export emits an unregistered descriptor', async () => {
  const t = await exportRouteDeps({ reads: pagedReads([[PAGE_ROWS[0]!], [PAGE_ROWS[1]!]]) });
  const outcome = await exportOk(t, { operation: OPERATION, limit: 1 });
  assert.equal(outcome.truncated, true);
  const descriptor = outcome.descriptor!;
  assert.equal((await getDownload(t, `/api/exports/status/${descriptor.handle}`)).status, 404);
  assert.equal((await getDownload(t, `/api/exports/download/${descriptor.handle}`)).status, 404);
});

test('DEL-B02: expired records answer not_found on status and download', async () => {
  const t = await exportDownloadDeps({ reads: pagedReads([[PAGE_ROWS[0]!], [PAGE_ROWS[1]!]]) });
  const outcome = await exportOk(t, { operation: OPERATION, limit: 1 });
  const handle = outcome.descriptor!.handle;
  const stored = (await t.store.read(handle))!;
  await t.store.save({ ...stored, expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await getDownload(t, `/api/exports/status/${handle}`)).status, 404);
  assert.equal((await getDownload(t, `/api/exports/download/${handle}`)).status, 404);
});

test('DEL-B02: foreign principal and revoked records answer forbidden', async () => {
  const t = await exportDownloadDeps({ reads: pagedReads([[PAGE_ROWS[0]!], [PAGE_ROWS[1]!]]) });
  const outcome = await exportOk(t, { operation: OPERATION, limit: 1 });
  const handle = outcome.descriptor!.handle;
  const stored = (await t.store.read(handle))!;
  await t.store.save({ ...stored, principal: 'mallory' });
  const foreign = await getDownload(t, `/api/exports/download/${handle}`);
  assert.equal(foreign.status, 403);
  await t.store.save(stored);
  assert.equal(await t.store.revoke(handle), true);
  const status = await getDownload(t, `/api/exports/status/${handle}`);
  assert.equal(status.status, 403);
  const download = await getDownload(t, `/api/exports/download/${handle}`);
  assert.equal(download.status, 403);
  assert.equal(await t.store.revoke('exp-0123456789abcdef'), false);
});

test('DEL-B02: tainted bodies refuse validation without serving bytes', async () => {
  const t = await exportDownloadDeps({ reads: pagedReads([[PAGE_ROWS[0]!], [PAGE_ROWS[1]!]]) });
  const outcome = await exportOk(t, { operation: OPERATION, limit: 1 });
  const handle = outcome.descriptor!.handle;
  assert.equal((await getDownload(t, `/api/exports/download/${handle}`)).status, 200);
  const stored = (await t.store.read(handle))!;
  await t.store.save({ ...stored, csv: `${stored.csv}tampered,row\n` });
  const download = await getDownload(t, `/api/exports/download/${handle}`);
  assert.equal(download.status, 400);
  assert.equal(((await download.json()) as { code: string }).code, 'validation');
});

test('DEL-B02: missing bodies and store read failures answer generic internal without bytes', async () => {
  const t = await exportDownloadDeps({ reads: pagedReads([[PAGE_ROWS[0]!], [PAGE_ROWS[1]!]]) });
  const outcome = await exportOk(t, { operation: OPERATION, limit: 1 });
  const handle = outcome.descriptor!.handle;
  const stored = (await t.store.read(handle))!;
  const { digest: _stale, ...rest } = stored;
  const crafted = { ...rest, status: 'ready' as const };
  const digest = createHash('sha256').update(canonicalJson(crafted), 'utf8').digest('hex');
  await t.store.save({ ...crafted, digest });
  const missing = await getDownload(t, `/api/exports/download/${handle}`);
  assert.equal(missing.status, 422);
  assert.equal(((await missing.json()) as { code: string }).code, 'rule_failed');
  const failing = {
    read: async (_handle: string): Promise<never> => { throw new Error('boom'); },
    save: async (): Promise<void> => {},
    revoke: async (): Promise<boolean> => false,
  };
  const brokenDeps = { ...t.deps, exportDownloads: failing };
  const brokenHttp = createHttpHandler(brokenDeps, {
    operations: (req, op) => handleOperationRequest(brokenDeps, req, op),
    auth: (req) => handleAuthRequest(brokenDeps, req),
    uploads: () => Promise.resolve(new Response('unused', { status: 500 })),
    ingress: () => Promise.resolve(new Response('unused', { status: 500 })),
    oauth: () => Promise.resolve(new Response('unused', { status: 500 })),
    exports: (req) => handleExportRequest(brokenDeps, req),
    print: (req) => handlePrintRequest(brokenDeps, VIEWS, req),
  });
  const failed = await brokenHttp(testRequest(`/api/exports/status/${handle}`, { method: 'GET', cookie: t.identity.cookie }));
  assert.equal(failed.status, 422);
  assert.equal(((await failed.json()) as { code: string }).code, 'rule_failed');
});

test('DEL-B02: download serves current rows, not the export-time snapshot', async () => {
  let current = [PAGE_ROWS[0]!, PAGE_ROWS[1]!];
  const t = await exportDownloadDeps({ reads: { [OPERATION]: () => ({ result: listResult([...current]) }) } });
  const outcome = await exportOk(t, { operation: OPERATION, limit: 1 });
  assert.equal(outcome.truncated, true);
  current = [{ id: 'e-3', fields: { customer: 'c', total: '30' } }];
  const download = await getDownload(t, `/api/exports/download/${outcome.descriptor!.handle}`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'id,version,customer,total\ne-3,,c,30\n');
});

test('DEL-B02: secret values in later pages refuse the download closed', async () => {
  const secretPage = [{ id: 'e-9', fields: { customer: { kind: 'secret' }, total: '1' } }];
  const t = await exportDownloadDeps({ reads: pagedReads([[PAGE_ROWS[0]!], secretPage]) });
  const outcome = await exportOk(t, { operation: OPERATION, limit: 1 });
  assert.equal(outcome.truncated, true);
  const download = await getDownload(t, `/api/exports/download/${outcome.descriptor!.handle}`);
  assert.equal(download.status, 400);
  assert.equal(((await download.json()) as { code: string }).code, 'validation');
});
