/**
 * FP.CSV-JOIN: E server + C dispatcher + F UI wire agreement through the
 * REAL `createHttpHandler` + real `handleCsvRequest` + the real F UI
 * submitters, observed at the canonical `createTestDeps` invoker.
 *
 * No seam mocks: `submitCsvReview`/`submitCsvCommit` run with a `fetchImpl`
 * that builds a real `Request` (session cookie attached) and awaits the
 * real route `Response`. Commit selections come from the real
 * `csvPreviewSection` markup via the real `collectCommitSelections` —
 * the UI-minted `operation_id` replay keys are the exact keys the
 * canonical invoker receives.
 *
 * Fixture op mirrors `csv-route.test.ts` (t19a/t19b vocabulary); this
 * suite pins the UI WIRE, not dispatch (C) or handler semantics (E).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveCsrfToken } from '@canlang/identity';
import {
  collectCommitSelections,
  csvPreviewSection,
  mintOperationId,
  submitCsvCommit,
  submitCsvReview,
} from '@canlang/ui';
import type {
  CsvReviewModel,
  PresentationContext,
  SubmitFetch,
  SubmitFetchInit,
} from '@canlang/ui';
import { ARTIFACT_VERSION } from '../../contracts/src/artifact.js';
import type { ArtifactOperation } from '../../contracts/src/artifact.js';
import { catalogFromArtifactOperations, handleOperationRequest } from '../src/http/operations.js';
import { handleAuthRequest } from '../src/http/auth.js';
import { handleCsvRequest } from '../src/http/csv.js';
import { createHttpHandler } from '../src/http/routes.js';
import type { HttpSubHandlers } from '../src/http/routes.js';
import { createTestDeps } from '../src/testing.js';

const CSV_ISSUE: ArtifactOperation = {
  "name": "Billing.Invoice.issue",
  "kind": "create",
  "description": "",
  "inputs": {"fields": [
    {"name": "customer", "field": {"kind": "string"}, "required": true},
    {"name": "count", "field": {"kind": "integer"}, "required": false},
  ]},
};

const SLICE = { artifact_version: ARTIFACT_VERSION, operations: [CSV_ISSUE] };
const OPERATION = 'Billing.Invoice.issue';

async function joinDeps(overrides: Parameters<typeof createTestDeps>[0] = {}) {
  const t = await createTestDeps(overrides);
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const deps = { ...t.deps, catalog: catalogFromArtifactOperations(SLICE) };
  const sub: HttpSubHandlers = {
    operations: (req, op) => handleOperationRequest(deps, req, op),
    auth: (req) => handleAuthRequest(deps, req),
    uploads: () => Promise.resolve(new Response('unused', { status: 500 })),
    ingress: () => Promise.resolve(new Response('unused', { status: 500 })),
    oauth: () => Promise.resolve(new Response('unused', { status: 500 })),
    csv: (req) => handleCsvRequest(deps, req),
  };
  const http = createHttpHandler(deps, sub);
  /* The wire: real UI fetch seam -> real Request -> real route. */
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

function contextWith(csrf: string): PresentationContext {
  return {
    preferredLocales: [],
    appDefaultLocale: 'en',
    theme: { mode: 'system', accent: 'blue', density: 'comfortable' },
    path: '/',
    isPartial: false,
    csrfToken: csrf,
    principal: null,
    invocation: { request: 'req-join' },
    query: async () => ({ rows: [], columns: [] }),
  };
}

/* Flat form map exactly as a browser would post the preview checkboxes. */
function flatFromPreview(markup: string): Record<string, string> {
  const flat: Record<string, string> = {};
  const input = /<input\b[^>]*>/g;
  let tag: RegExpExecArray | null;
  while ((tag = input.exec(markup)) !== null) {
    const name = /name="([^"]+)"/.exec(tag[0])?.[1];
    const value = /value="([^"]*)"/.exec(tag[0])?.[1];
    if (name === undefined || value === undefined) continue;
    if (!name.startsWith('rows[')) continue;
    if (/type="checkbox"/.test(tag[0]) && !/\bchecked\b/.test(tag[0])) continue;
    flat[name] = value;
  }
  return flat;
}

test('FP.CSV-JOIN: UI review submit reaches the real handler; model mirrors server JSON', async () => {
  const t = await joinDeps();
  const csv = ['customer,count', 'c-1,3', 'c-bad,bogus', 'c-1,3', ''].join('\n');
  const result = await submitCsvReview({
    fetchImpl: t.wire(t.identity.cookie),
    action: '/api/csv/review',
    csrf: t.csrf,
    operation: OPERATION,
    csv,
  });
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  const review: CsvReviewModel = result.review;
  assert.equal(review.operation, OPERATION);
  assert.deepEqual(review.counts, { total: 3, valid: 1, invalid: 1, duplicate: 1 });
  assert.deepEqual(review.rows.map((row) => row.status), ['valid', 'invalid', 'duplicate']);
  assert.equal(review.rows[2]!.duplicate_of, 0);
  assert.match(review.rows[1]!.error!.message, /"count"/);
  /* Consent round-trips every server field the commit replays. */
  assert.equal(review.consent.operation, OPERATION);
  assert.equal(review.consent.review_id, review.review_id);
  assert.ok(review.consent.principal.length > 0);
  assert.ok(review.consent.candidates_digest.length > 0);
  assert.equal(review.consent.candidate_count, 1);
  /* Review stays pure at the real invoker. */
  assert.equal(t.invoker.mutations.length, 0);
  assert.equal(t.invoker.reads.length, 0);
});

test('FP.CSV-JOIN: preview markup -> selections -> commit; invoker gets UI-minted keys', async () => {
  const t = await joinDeps({
    mutations: {
      [OPERATION]: (envelope) => ({ result: { status: 'committed', operation_id: envelope.operation_id } }),
    },
  });
  const csv = ['customer,count', 'c-1,3', 'c-bad,bogus', 'c-1,3', ''].join('\n');
  const reviewed = await submitCsvReview({
    fetchImpl: t.wire(t.identity.cookie),
    action: '/api/csv/review',
    csrf: t.csrf,
    operation: OPERATION,
    csv,
  });
  assert.equal(reviewed.ok, true);
  assert.ok(reviewed.ok);
  /* Real preview render; selections collected from its real markup. */
  const markup = await csvPreviewSection({
    context: contextWith(t.csrf),
    review: reviewed.review,
    commitPath: '/api/csv/commit',
    csvText: csv,
    regionId: 'csv-preview-join',
  });
  assert.match(markup, /rows\[0\]\.selected/);
  const collected = collectCommitSelections(flatFromPreview(markup));
  assert.equal(collected.ok, true);
  assert.ok(collected.ok);
  assert.deepEqual(collected.selections.map((row) => row.index), [0]);
  const committed = await submitCsvCommit({
    fetchImpl: t.wire(t.identity.cookie),
    action: '/api/csv/commit',
    csrf: t.csrf,
    operation: OPERATION,
    csv,
    consent: reviewed.review.consent,
    selections: collected.selections,
  });
  assert.equal(committed.ok, true);
  assert.ok(committed.ok);
  assert.equal(committed.outcome.review_id, reviewed.review.review_id);
  assert.deepEqual(committed.outcome.rows.map((row) => row.status), ['committed']);
  /* Canonical join control: one invocation, UI-minted replay key, frozen identity. */
  assert.equal(t.invoker.mutations.length, 1);
  const call = t.invoker.mutations[0]!;
  assert.equal(call.envelope.operation, OPERATION);
  assert.deepEqual(call.envelope.inputs, { customer: 'c-1', count: '3' });
  assert.equal(call.envelope.operation_id, collected.selections[0]!.operation_id);
  assert.equal(committed.outcome.rows[0]!.operation_id, collected.selections[0]!.operation_id);
  assert.equal(call.identity.actor?.user_id, t.identity.userId);
  assert.equal(committed.outcome.principal.user_id, t.identity.userId);
});

test('FP.CSV-JOIN: changed candidates digest to UI conflict; renewed consent commits via UI', async () => {
  const t = await joinDeps({
    mutations: {
      [OPERATION]: (envelope) => ({ result: { status: 'committed', operation_id: envelope.operation_id } }),
    },
  });
  const before = 'customer,count\nc-1,3\n';
  const after = 'customer,count\nc-1,4\n';
  const reviewed = await submitCsvReview({
    fetchImpl: t.wire(t.identity.cookie),
    action: '/api/csv/review',
    csrf: t.csrf,
    operation: OPERATION,
    csv: before,
  });
  assert.ok(reviewed.ok);
  const stale = await submitCsvCommit({
    fetchImpl: t.wire(t.identity.cookie),
    action: '/api/csv/commit',
    csrf: t.csrf,
    operation: OPERATION,
    csv: after,
    consent: reviewed.review.consent,
    selections: [{ index: 0, operation_id: mintOperationId() }],
  });
  assert.equal(stale.ok, false);
  assert.ok(!stale.ok);
  assert.equal(stale.error.code, 'conflict');
  assert.match(stale.error.message, /renewed consent/i);
  assert.equal(t.invoker.mutations.length, 0);
  /* Renewed review through the same UI wire commits cleanly. */
  const fresh = await submitCsvReview({
    fetchImpl: t.wire(t.identity.cookie),
    action: '/api/csv/review',
    csrf: t.csrf,
    operation: OPERATION,
    csv: after,
  });
  assert.ok(fresh.ok);
  assert.notEqual(fresh.review.consent.candidates_digest, reviewed.review.consent.candidates_digest);
  const markup = await csvPreviewSection({
    context: contextWith(t.csrf),
    review: fresh.review,
    commitPath: '/api/csv/commit',
    csvText: after,
    regionId: 'csv-preview-renew',
  });
  const collected = collectCommitSelections(flatFromPreview(markup));
  assert.ok(collected.ok);
  const retry = await submitCsvCommit({
    fetchImpl: t.wire(t.identity.cookie),
    action: '/api/csv/commit',
    csrf: t.csrf,
    operation: OPERATION,
    csv: after,
    consent: fresh.review.consent,
    selections: collected.selections,
  });
  assert.equal(retry.ok, true);
  assert.ok(retry.ok);
  assert.deepEqual(retry.outcome.rows.map((row) => row.status), ['committed']);
  assert.equal(t.invoker.mutations.length, 1);
});

test('FP.CSV-JOIN: anonymous UI submit digests the server forbidden denial', async () => {
  const t = await joinDeps();
  const denied = await submitCsvReview({
    fetchImpl: t.wire(''),
    action: '/api/csv/review',
    csrf: t.csrf,
    operation: OPERATION,
    csv: 'customer\nc-1\n',
  });
  assert.equal(denied.ok, false);
  assert.ok(!denied.ok);
  assert.equal(denied.error.code, 'forbidden');
  assert.match(denied.error.message, /Authentication required/);
  assert.equal(t.invoker.mutations.length, 0);
});
