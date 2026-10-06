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
import { COLLECTION_MAX_LIMIT } from '../../contracts/src/wire.js';
import type { ListQueryResult } from '../../contracts/src/presentation.js';
import { ARTIFACT_VERSION } from '../../contracts/src/artifact.js';
import type { ArtifactOperation } from '../../contracts/src/artifact.js';
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
  assert.equal(second.as_of, first.as_of);
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
