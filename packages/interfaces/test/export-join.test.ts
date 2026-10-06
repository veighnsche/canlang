/**
 * FP.EXPORT-JOIN: E server + C dispatcher + browser-consumer wire agreement.
 *
 * The real browser consumers (`ui/src/browser/export.js` + `print.js`,
 * reached by relative deep import — they are not index-exported) drive
 * the real top-level `createHttpHandler` with the real accepted
 * `handleExportRequest`/`handlePrintRequest` injected via
 * `HttpSubHandlers.exports`/`.print`, over a fetch seam that builds a
 * real `Request` per call. Reads dispatch through the same canonical
 * invoker join (observed via the invoker's own call log, never wrapper
 * counters).
 *
 * No seam mocks: no export/print semantics are reimplemented here —
 * every behavior delegates to E's accepted handlers (pinned in
 * `export-print.test.ts` + `browser-export.test.ts`) and C's accepted
 * dispatch (pinned in `export-route.test.ts`); this suite pins the
 * JOIN: the browser request bytes reach the real handlers through the
 * real route, completion derives from the real outcome, inline bytes
 * flow byte-exact to the host sink, truncated exports pend with the
 * D-owned links and no polling, print views fetch live HTML, and
 * denials hold end to end with zero reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveCsrfToken, revokeSessionByToken } from '@canlang/identity';
import { COLLECTION_MAX_LIMIT } from '@canlang/contracts';
import type { ListQueryResult } from '@canlang/contracts';
import type { SubmitFetch, SubmitFetchInit } from '@canlang/ui';
import { handleOperationRequest } from '../src/http/operations.js';
import { handleAuthRequest } from '../src/http/auth.js';
import { handleCsvRequest } from '../src/http/csv.js';
import { handleExportRequest } from '../src/http/export.js';
import { handlePrintRequest } from '../src/http/print.js';
import type { PrintViewRegistry } from '../src/http/print.js';
import { createHttpHandler } from '../src/http/routes.js';
import type { HttpSubHandlers } from '../src/http/routes.js';
import { createTestDeps, testRequest } from '../src/testing.js';
import {
  deriveExportStatus,
  downloadInlineCsv,
  renderExportPanel,
  submitExportRequest,
} from '@canlang/ui/browser/export';
import type { DownloadSink } from '@canlang/ui/browser/export';
import { fetchPrintView, renderPrintFrame, renderPrintLink } from '@canlang/ui/browser/print';

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

async function exportJoinDeps(overrides: Parameters<typeof createTestDeps>[0] = {}) {
  const t = await createTestDeps(overrides);
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const deps = t.deps;
  const sub: HttpSubHandlers = {
    operations: (req, op) => handleOperationRequest(deps, req, op),
    auth: (req) => handleAuthRequest(deps, req),
    uploads: () => Promise.resolve(new Response('unused', { status: 500 })),
    ingress: () => Promise.resolve(new Response('unused', { status: 500 })),
    oauth: () => Promise.resolve(new Response('unused', { status: 500 })),
    csv: (req) => handleCsvRequest(deps, req),
    exports: (req) => handleExportRequest(deps, req),
    print: (req) => handlePrintRequest(deps, VIEWS, req),
  };
  const http = createHttpHandler(deps, sub);
  /* The wire: real browser-consumer fetch seam -> real Request -> real route. */
  const wire = (cookie: string): SubmitFetch => {
    return async (url: string, init: SubmitFetchInit) => {
      const res = await http(
        new Request(`https://join.invalid${url}`, {
          method: init.method,
          headers: { ...init.headers, cookie },
          body: init.body as string,
        }),
      );
      return { status: res.status, headers: res.headers, text: () => res.text() };
    };
  };
  return { ...t, deps, csrf, http, wire };
}

function captureSink(): DownloadSink & { saves: Array<{ filename: string; text: string; mime: string }> } {
  const saves: Array<{ filename: string; text: string; mime: string }> = [];
  return {
    saves,
    save(filename: string, text: string, mime: string): void {
      saves.push({ filename, text, mime });
    },
  };
}

test('FP.EXPORT-JOIN: browser export reaches the real handler via the route; inline CSV byte-exact to the host sink', async () => {
  const t = await exportJoinDeps({ reads: { [OPERATION]: () => ({ result: TWO_ROWS }) } });
  let fetches = 0;
  const inner = t.wire(t.identity.cookie);
  const fetchImpl: SubmitFetch = async (url, init) => {
    fetches += 1;
    return inner(url, init);
  };
  const result = await submitExportRequest({
    fetchImpl,
    action: '/api/exports',
    csrf: t.csrf,
    operation: OPERATION,
  });
  assert.equal(result.ok, true);
  assert.equal(fetches, 1);
  const outcome = result.ok ? result.outcome : null;
  assert.ok(outcome !== null);
  assert.equal(outcome.operation, OPERATION);
  assert.equal(outcome.complete, true);
  assert.equal(outcome.truncated, false);
  assert.equal(outcome.row_count, 2);
  assert.ok(outcome.as_of.endsWith('Z'));
  assert.deepEqual(outcome.columns, [
    { field: 'id', label: 'ID' },
    { field: 'version', label: 'Version' },
    { field: 'customer', label: 'Customer' },
    { field: 'total', label: 'Total' },
  ]);
  assert.equal(outcome.csv, 'id,version,customer,total\ninv-1,3,c-1,100\ninv-2,,c-2,250\n');
  assert.equal(deriveExportStatus(outcome, Date.now()), 'inline-complete');
  const sink = captureSink();
  const filename = downloadInlineCsv(sink, outcome, Date.now());
  assert.match(filename, /^Billing\.Invoice\.list-\d{8}\.csv$/);
  assert.equal(sink.saves.length, 1);
  assert.equal(sink.saves[0]!.filename, filename);
  assert.equal(sink.saves[0]!.text, outcome.csv);
  assert.equal(sink.saves[0]!.mime, 'text/csv;charset=utf-8');
  const panel = renderExportPanel({
    regionId: 'export-join',
    action: '/api/exports',
    csrf: t.csrf,
    operations: [OPERATION],
    status: { kind: 'inline-complete', outcome },
  });
  assert.match(panel, /Download CSV/);
  assert.ok(panel.includes(`data-export-download="${filename}"`));
  /* Canonical join control: one read, live identity, default page inputs. */
  assert.equal(t.invoker.reads.length, 1);
  assert.equal(t.invoker.reads[0]!.identity.actor?.user_id, t.identity.userId);
  assert.deepEqual(t.invoker.reads[0]!.envelope, {
    operation: OPERATION,
    inputs: { limit: COLLECTION_MAX_LIMIT },
  });
});

test('FP.EXPORT-JOIN: truncated export pends with descriptor links and no polling; inline download refuses', async () => {
  const t = await exportJoinDeps({
    reads: { [OPERATION]: () => ({ result: listResult(TWO_ROWS.rows, 'cur-9') }) },
  });
  let fetches = 0;
  const inner = t.wire(t.identity.cookie);
  const fetchImpl: SubmitFetch = async (url, init) => {
    fetches += 1;
    return inner(url, init);
  };
  const result = await submitExportRequest({
    fetchImpl,
    action: '/api/exports',
    csrf: t.csrf,
    operation: OPERATION,
  });
  assert.equal(result.ok, true);
  assert.equal(fetches, 1);
  const outcome = result.ok ? result.outcome : null;
  assert.ok(outcome !== null);
  assert.equal(outcome.complete, false);
  assert.equal(outcome.truncated, true);
  assert.equal(outcome.next_cursor, 'cur-9');
  const descriptor = outcome.descriptor;
  assert.ok(descriptor !== undefined);
  assert.match(descriptor.handle, /^exp-[0-9a-f]{16}$/);
  assert.equal(descriptor.status, 'pending');
  assert.equal(deriveExportStatus(outcome, Date.now()), 'truncated-pending');
  /* Descriptor-only never downloads: false completion is refused. */
  assert.throws(() => downloadInlineCsv(captureSink(), outcome, Date.now()));
  const panel = renderExportPanel({
    regionId: 'export-join',
    action: '/api/exports',
    csrf: t.csrf,
    operations: [OPERATION],
    status: { kind: 'truncated-pending', outcome },
  });
  assert.match(panel, /does not poll for completion/);
  assert.ok(panel.includes(descriptor.download_url));
  assert.ok(panel.includes(descriptor.status_url));
  /* Exactly one fetch: status/download URLs never touched (D follow-up). */
  assert.equal(fetches, 1);
  assert.equal(t.invoker.reads.length, 1);
});

test('FP.EXPORT-JOIN: declared print view fetches live HTML via the route; link/frame render safe navigation', async () => {
  const t = await exportJoinDeps({ reads: { [OPERATION]: () => ({ result: TWO_ROWS }) } });
  const fetched = await fetchPrintView({
    fetchImpl: t.wire(t.identity.cookie),
    printBase: '/print',
    view: 'invoice-register',
  });
  assert.equal(fetched.ok, true);
  assert.equal(fetched.ok && fetched.view, 'invoice-register');
  const html = fetched.ok ? fetched.html : '';
  assert.match(html, /<title>Invoice register<\/title>/);
  assert.match(html, /<th>Customer<\/th>.*<th>Total<\/th>/s);
  assert.match(html, /<td>c-1<\/td>/);
  assert.match(html, /as of .*Z/);
  assert.match(html, /2 rows/);
  assert.equal(t.invoker.reads.length, 1);
  const link = renderPrintLink({ printBase: '/print', view: 'invoice-register' });
  assert.match(link, /href="\/print\/invoice-register"/);
  assert.match(link, /target="_blank" rel="noopener"/);
  const frame = renderPrintFrame({ regionId: 'print-join', printBase: '/print', view: 'invoice-register' });
  assert.match(frame, /<iframe src="\/print\/invoice-register" sandbox=""/);
  /* Server HTML is navigated to, never inlined into the host page. */
  assert.ok(!frame.includes('<td>'));
  /* Unknown declared-shape view digests the route denial. */
  const missing = await fetchPrintView({
    fetchImpl: t.wire(t.identity.cookie),
    printBase: '/print',
    view: 'no-such-view',
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.ok ? '' : missing.error.code, 'not_found');
  /* Undeclared-shape names fail closed client-side (host-fatal, no fetch). */
  await assert.rejects(
    fetchPrintView({ fetchImpl: t.wire(t.identity.cookie), printBase: '/print', view: 'BAD VIEW' }),
  );
});

test('FP.EXPORT-JOIN: revoked session denies export + print at the route with zero reads', async () => {
  const t = await exportJoinDeps({ reads: { [OPERATION]: () => ({ result: TWO_ROWS }) } });
  await revokeSessionByToken(t.deps.identity.store, { token: t.identity.sessionToken });
  const exported = await submitExportRequest({
    fetchImpl: t.wire(t.identity.cookie),
    action: '/api/exports',
    csrf: t.csrf,
    operation: OPERATION,
  });
  assert.equal(exported.ok, false);
  assert.equal(exported.ok ? '' : exported.error.code, 'forbidden');
  const printed = await fetchPrintView({
    fetchImpl: t.wire(t.identity.cookie),
    printBase: '/print',
    view: 'invoice-register',
  });
  assert.equal(printed.ok, false);
  assert.equal(printed.ok ? '' : printed.error.code, 'forbidden');
  /* Handler-level control: CSRF-less export denied before any read. */
  const noCsrf = await t.http(
    testRequest('/api/exports', {
      method: 'POST',
      cookie: t.identity.cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: OPERATION }),
    }),
  );
  assert.equal(noCsrf.status, 403);
  assert.equal(t.invoker.reads.length, 0);
});
