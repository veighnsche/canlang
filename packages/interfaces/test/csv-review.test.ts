/**
 * FP.CSV owned pins: source-derived CSV intake SERVER review + per-row
 * commit at HTTP level (`http/csv.ts`). UI thirds (parse/preview/confirm)
 * are F's; this slice pins the server contract F's UI drives:
 *
 * - review is authorized and pure (no invocation): every submitted row
 *   is preserved with a verdict — valid, invalid (framing/binding
 *   failure, malformed shape), or duplicate of an earlier valid row;
 * - commit requires the review's consent; candidates changed since the
 *   review void the consent (`conflict`, renewed consent required);
 * - commit confirms under a frozen commit-time identity with T32
 *   authority liveness (revoked authority voids the whole commit
 *   before any invocation);
 * - outcomes are canonical and replay-safe (per-row `operation_id`
 *   replay keys carried to L3 verbatim) with partial failure (per-row
 *   committed/failed/skipped, always HTTP 200 for a well-formed
 *   commit).
 *
 * Grounding: `CSV_ISSUE` follows the t19a/t19b fixture vocabulary
 * verbatim (string/integer/boolean/enum columns bind from their CSV
 * text cells — integers/decimals/datetimes/enums/files already travel
 * as strings on the wire; booleans decode from `true`/`false` text,
 * the single CSV-owned coercion); the review derives through the real
 * checked derivation (`catalogFromArtifactOperations`) and the real
 * V02.3 runner (`runPreparedHttpPlan`) per row; commit dispatches
 * through the scripted invoker with a real identity fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveCsrfToken, revokeSessionByToken } from '@canlang/identity';
import { ARTIFACT_VERSION } from '@canlang/contracts';
import type { ArtifactOperation } from '@canlang/contracts';
import { catalogFromArtifactOperations } from '../src/http/operations.js';
import { mintOperationId } from '../src/http/context.js';
import { handleCsvRequest } from '../src/http/csv.js';
import type { CsvCommitOutcome, CsvConsent, CsvReview } from '../src/http/csv.js';
import { createTestDeps, testRequest } from '../src/testing.js';

/* Fixture op in the t19a/t19b vocabulary: CSV-expressible columns only. */
const CSV_ISSUE: ArtifactOperation = {
  "name": "Billing.Invoice.issue",
  "kind": "create",
  "description": "",
  "inputs": {"fields": [
    {"name": "customer", "field": {"kind": "string"}, "required": true},
    {"name": "memo", "field": {"kind": "string"}, "required": false},
    {"name": "urgent", "field": {"kind": "boolean"}, "required": false},
    {"name": "count", "field": {"kind": "integer"}, "required": false},
    {"name": "state", "field": {"kind": "enum", "values": ["draft", "sent"]}, "required": false},
  ]},
};

const SLICE = { artifact_version: ARTIFACT_VERSION, operations: [CSV_ISSUE] };
const OPERATION = 'Billing.Invoice.issue';

async function csvDeps(overrides: Parameters<typeof createTestDeps>[0] = {}) {
  const t = await createTestDeps(overrides);
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  return { ...t, deps: { ...t.deps, catalog: catalogFromArtifactOperations(SLICE) }, csrf };
}

function postCsv(path: string, cookie: string, csrf: string, body: unknown): Request {
  return testRequest(path, {
    method: 'POST',
    cookie,
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify(body),
  });
}

async function reviewOk(
  t: Awaited<ReturnType<typeof csvDeps>>,
  csv: string,
): Promise<CsvReview> {
  const res = await handleCsvRequest(t.deps, postCsv('/api/csv/review', t.identity.cookie, t.csrf, {
    operation: OPERATION,
    csv,
  }));
  assert.equal(res.status, 200);
  return (await res.json()) as CsvReview;
}

function commitRows(consent: CsvConsent, csv: string, indexes: number[]): {
  operation: string;
  consent: CsvConsent;
  csv: string;
  rows: Array<{ index: number; operation_id: string }>;
} {
  return {
    operation: OPERATION,
    consent,
    csv,
    rows: indexes.map((index) => ({ index, operation_id: mintOperationId() })),
  };
}

test('FP.CSV: review preserves invalid, duplicate, and malformed rows; pure (no invocation)', async () => {
  const t = await csvDeps();
  const csv = [
    'customer,memo,urgent,count,state',
    'c-1,first,true,3,draft',
    'c-2,bad-enum,false,1,shipped',
    'c-1,first,true,3,draft',
    'c-3,short-row',
    ',empty-customer,,0,draft',
    'c-4,bad-bool,yes,2,sent',
    'c-5,bad-count,false,bogus,draft',
    '',
  ].join('\n');
  const body = await reviewOk(t, csv);
  assert.equal(body.operation, OPERATION);
  assert.equal(body.rows.length, 7);
  assert.deepEqual(body.counts, { total: 7, valid: 1, invalid: 5, duplicate: 1 });
  assert.deepEqual(body.rows.map((row) => row.status), [
    'valid', 'invalid', 'duplicate', 'invalid', 'invalid', 'invalid', 'invalid',
  ]);
  /* Duplicate points at the first identical valid row. */
  assert.equal(body.rows[2]!.duplicate_of, 0);
  /* Invalid rows keep their verdicts: binding mismatch, malformed shape, missing required. */
  assert.match(body.rows[1]!.error!.message, /"state"/);
  assert.match(body.rows[3]!.error!.message, /fields; header has/);
  assert.match(body.rows[4]!.error!.message, /Missing required input 'customer'/);
  assert.match(body.rows[5]!.error!.message, /"urgent"/);
  assert.match(body.rows[6]!.error!.message, /"count"/);
  /* Canonical identity: deterministic review id + digest over valid candidates. */
  assert.match(body.review_id, /^rev-[0-9a-f]{16}$/);
  assert.equal(body.consent.review_id, body.review_id);
  assert.equal(body.consent.operation, OPERATION);
  assert.equal(body.consent.principal, t.identity.userId);
  assert.equal(body.consent.candidate_count, 1);
  const again = await reviewOk(t, csv);
  assert.equal(again.review_id, body.review_id);
  assert.equal(again.consent.candidates_digest, body.consent.candidates_digest);
  /* Pure: review never touches the invoker. */
  assert.equal(t.invoker.mutations.length, 0);
});

test('FP.CSV: review is authorized — anonymous and CSRF-less callers denied', async () => {
  const t = await csvDeps();
  const csv = 'customer\nc-1\n';
  const anon = await handleCsvRequest(
    t.deps,
    testRequest('/api/csv/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': t.csrf },
      body: JSON.stringify({ operation: OPERATION, csv }),
    }),
  );
  assert.equal(anon.status, 403);
  assert.match(((await anon.json()) as { message: string }).message, /Authentication required/);
  const noCsrf = await handleCsvRequest(
    t.deps,
    testRequest('/api/csv/review', {
      method: 'POST',
      cookie: t.identity.cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: OPERATION, csv }),
    }),
  );
  assert.equal(noCsrf.status, 403);
  assert.equal(t.invoker.mutations.length, 0);
});

test('FP.CSV: commit confirms valid rows under the frozen identity; skips invalid + duplicate', async () => {
  const t = await csvDeps({
    mutations: {
      [OPERATION]: (envelope) => ({ result: { status: 'committed', operation_id: envelope.operation_id } }),
    },
  });
  const csv = [
    'customer,count',
    'c-1,3',
    'c-bad,bogus',
    'c-1,3',
    '',
  ].join('\n');
  const review = await reviewOk(t, csv);
  const res = await handleCsvRequest(
    t.deps,
    postCsv('/api/csv/commit', t.identity.cookie, t.csrf, commitRows(review.consent, csv, [0, 1, 2])),
  );
  assert.equal(res.status, 200);
  const outcome = (await res.json()) as CsvCommitOutcome;
  assert.equal(outcome.review_id, review.review_id);
  assert.equal(outcome.rows.length, 3);
  assert.deepEqual(outcome.rows.map((row) => row.status), ['committed', 'invalid', 'duplicate']);
  assert.equal(outcome.rows[2]!.duplicate_of, 0);
  assert.match(outcome.rows[1]!.error!.message, /"count"/);
  /* Frozen identity: every invocation carries the commit-time identity. */
  assert.equal(t.invoker.mutations.length, 1);
  assert.equal(t.invoker.mutations[0]!.identity.actor?.user_id, t.identity.userId);
  assert.deepEqual(t.invoker.mutations[0]!.envelope.inputs, { customer: 'c-1', count: '3' });
  assert.equal(outcome.principal.user_id, t.identity.userId);
});

test('FP.CSV: changed candidates void the consent — renewed review required', async () => {
  const t = await csvDeps({
    mutations: {
      [OPERATION]: (envelope) => ({ result: { status: 'committed', operation_id: envelope.operation_id } }),
    },
  });
  const before = 'customer,count\nc-1,3\n';
  const after = 'customer,count\nc-1,4\n';
  const review = await reviewOk(t, before);
  const res = await handleCsvRequest(
    t.deps,
    postCsv('/api/csv/commit', t.identity.cookie, t.csrf, commitRows(review.consent, after, [0])),
  );
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { message: string }).message, /renewed consent/i);
  assert.equal(t.invoker.mutations.length, 0);
  /* A fresh review of the changed candidates mints a fresh consent that commits. */
  const fresh = await reviewOk(t, after);
  assert.notEqual(fresh.consent.candidates_digest, review.consent.candidates_digest);
  const retry = await handleCsvRequest(
    t.deps,
    postCsv('/api/csv/commit', t.identity.cookie, t.csrf, commitRows(fresh.consent, after, [0])),
  );
  assert.equal(retry.status, 200);
  assert.equal(((await retry.json()) as CsvCommitOutcome).rows[0]!.status, 'committed');
});

test('FP.CSV: consent binds the reviewing principal — another user cannot spend it', async () => {
  const t = await csvDeps({
    mutations: {
      [OPERATION]: (envelope) => ({ result: { status: 'committed', operation_id: envelope.operation_id } }),
    },
  });
  const csv = 'customer\nc-1\n';
  const review = await reviewOk(t, csv);
  const forged: CsvConsent = { ...review.consent, principal: 'user-someone-else' };
  const res = await handleCsvRequest(
    t.deps,
    postCsv('/api/csv/commit', t.identity.cookie, t.csrf, commitRows(forged, csv, [0])),
  );
  assert.equal(res.status, 403);
  assert.equal(t.invoker.mutations.length, 0);
});

test('FP.CSV: partial failure — per-row outcomes, invoker errors stay row-scoped', async () => {
  const t = await csvDeps({
    mutations: {
      [OPERATION]: (envelope) => {
        const customer = (envelope.inputs as Record<string, unknown>)['customer'];
        if (customer === 'c-boom') {
          return { error: { code: 'rule_failed', message: 'Downstream refused c-boom.', retryable: false } };
        }
        return { result: { status: 'committed', operation_id: envelope.operation_id } };
      },
    },
  });
  const csv = 'customer\nc-1\nc-boom\nc-3\n';
  const review = await reviewOk(t, csv);
  const res = await handleCsvRequest(
    t.deps,
    postCsv('/api/csv/commit', t.identity.cookie, t.csrf, commitRows(review.consent, csv, [0, 1, 2])),
  );
  assert.equal(res.status, 200);
  const outcome = (await res.json()) as CsvCommitOutcome;
  assert.deepEqual(outcome.rows.map((row) => row.status), ['committed', 'failed', 'committed']);
  assert.equal(outcome.rows[1]!.error!.code, 'rule_failed');
  assert.equal(t.invoker.mutations.length, 3);
});

test('FP.CSV: replay-safe — identical commit replays carry identical envelopes; batch ids unique', async () => {
  const t = await csvDeps({
    mutations: {
      [OPERATION]: (envelope) => ({ result: { status: 'committed', operation_id: envelope.operation_id } }),
    },
  });
  const csv = 'customer\nc-1\nc-2\n';
  const review = await reviewOk(t, csv);
  const firstId = mintOperationId();
  const secondId = mintOperationId();
  const body = {
    operation: OPERATION,
    consent: review.consent,
    csv,
    rows: [
      { index: 0, operation_id: firstId },
      { index: 1, operation_id: secondId },
    ],
  };
  const one = await handleCsvRequest(t.deps, postCsv('/api/csv/commit', t.identity.cookie, t.csrf, body));
  assert.equal(one.status, 200);
  const two = await handleCsvRequest(t.deps, postCsv('/api/csv/commit', t.identity.cookie, t.csrf, body));
  assert.equal(two.status, 200);
  assert.equal(t.invoker.mutations.length, 4);
  /* Same replay keys, same inputs, same order — L3 dedupes by operation_id. */
  assert.deepEqual(
    t.invoker.mutations.slice(2).map((call) => call.envelope),
    t.invoker.mutations.slice(0, 2).map((call) => call.envelope),
  );
  /* Duplicate replay keys within one batch reject before any invocation. */
  const before = t.invoker.mutations.length;
  const dup = await handleCsvRequest(
    t.deps,
    postCsv('/api/csv/commit', t.identity.cookie, t.csrf, {
      operation: OPERATION,
      consent: review.consent,
      csv,
      rows: [
        { index: 0, operation_id: firstId },
        { index: 1, operation_id: firstId },
      ],
    }),
  );
  assert.equal(dup.status, 400);
  assert.match(((await dup.json()) as { message: string }).message, /Duplicate operation_id/);
  assert.equal(t.invoker.mutations.length, before);
});

test('FP.CSV: revoked authority voids the commit before any invocation (T32)', async () => {
  const t = await csvDeps({
    mutations: {
      [OPERATION]: (envelope) => ({ result: { status: 'committed', operation_id: envelope.operation_id } }),
    },
  });
  const csv = 'customer\nc-1\n';
  const review = await reviewOk(t, csv);
  await revokeSessionByToken(t.deps.identity.store, { token: t.identity.sessionToken });
  const res = await handleCsvRequest(
    t.deps,
    postCsv('/api/csv/commit', t.identity.cookie, t.csrf, commitRows(review.consent, csv, [0])),
  );
  assert.equal(res.status, 403);
  assert.equal(t.invoker.mutations.length, 0);
});

test('FP.CSV: unknown operation, bad header, and unparseable CSV reject at the route', async () => {
  const t = await csvDeps();
  const unknownOp = await handleCsvRequest(
    t.deps,
    postCsv('/api/csv/review', t.identity.cookie, t.csrf, { operation: 'Nope.missing', csv: 'customer\nc-1\n' }),
  );
  assert.equal(unknownOp.status, 404);
  const dupHeader = await handleCsvRequest(
    t.deps,
    postCsv('/api/csv/review', t.identity.cookie, t.csrf, { operation: OPERATION, csv: 'customer,customer\nc-1,x\n' }),
  );
  assert.equal(dupHeader.status, 400);
  const unterminated = await handleCsvRequest(
    t.deps,
    postCsv('/api/csv/review', t.identity.cookie, t.csrf, { operation: OPERATION, csv: 'customer\n"c-1\n' }),
  );
  assert.equal(unterminated.status, 400);
  const wrongMethod = await handleCsvRequest(
    t.deps,
    testRequest('/api/csv/review', { method: 'GET', cookie: t.identity.cookie }),
  );
  assert.equal(wrongMethod.status, 404);
  assert.equal(t.invoker.mutations.length, 0);
});

test('FP.CSV: an invalid partial input cannot suppress a later valid candidate', async () => {
  const t = await csvDeps({
    mutations: {
      [OPERATION]: (envelope) => ({
        result: { status: 'committed', operation_id: envelope.operation_id },
      }),
    },
  });
  const csv='customer,urgent\nc-1,yes\nc-1,\nc-1,';
  const reviewed=await reviewOk(t,csv);
  assert.deepEqual(reviewed.rows.map(row=>row.status),['invalid','valid','duplicate']);
  assert.equal(reviewed.rows[2]?.duplicate_of,1);
  assert.equal(reviewed.consent.candidate_count,1);
  // Golden canonical candidate digest is independent of the review implementation.
  const {createHash}=await import('node:crypto');
  const expected=createHash('sha256').update('{"candidates":[{"customer":"c-1"}],"operation":"Billing.Invoice.issue"}').digest('hex');
  assert.equal(reviewed.consent.candidates_digest,expected);
  const response=await handleCsvRequest(t.deps,postCsv('/api/csv/commit',t.identity.cookie,t.csrf,commitRows(reviewed.consent,csv,[1,2])));
  assert.equal(response.status,200);
  const committed=await response.json() as CsvCommitOutcome;
  assert.deepEqual(committed.rows.map(row=>row.status),['committed','duplicate']);
  assert.equal(t.invoker.mutations.length,1);
  assert.deepEqual(t.invoker.mutations[0]?.envelope.inputs,{customer:'c-1'});
});
