/**
 * FP.CSV-DISPATCH route pins: the accepted `http/csv.js` slice mounted at
 * `/api/csv/*` through the real top-level `createHttpHandler` with the real
 * `handleCsvRequest` injected via `HttpSubHandlers.csv`.
 *
 * No CSV semantics are reimplemented here — every behavior delegates to
 * E's accepted handler (pinned in `csv-review.test.ts`); this suite pins
 * the DISPATCH join: the route reaches the real handler, auth/consent/
 * authority denials hold at the route, commits dispatch through the same
 * canonical invoker join (observed via the invoker's own call log, never
 * wrapper counters), replays stay replay-safe, unknown/unmounted routes
 * answer `not_found`, and the pre-existing routes are unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSessionCookie,
  deriveCsrfToken,
  loginWithPassword,
  registerWithEmail,
  removeMember,
  selectTeam,
  verifyEmail,
} from '@canlang/identity';
import { ARTIFACT_VERSION } from '../../contracts/src/artifact.js';
import type { ArtifactOperation } from '../../contracts/src/artifact.js';
import { catalogFromArtifactOperations, handleOperationRequest } from '../src/http/operations.js';
import { handleAuthRequest } from '../src/http/auth.js';
import { mintOperationId } from '../src/http/context.js';
import { handleCsvRequest } from '../src/http/csv.js';
import type { CsvCommitOutcome, CsvConsent, CsvReview } from '../src/http/csv.js';
import { createHttpHandler } from '../src/http/routes.js';
import type { HttpSubHandlers } from '../src/http/routes.js';
import { createTestDeps, testRequest } from '../src/testing.js';

/* Fixture op in the t19a/t19b vocabulary (mirrors csv-review.test.ts). */
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

async function csvRouteDeps(overrides: Parameters<typeof createTestDeps>[0] = {}) {
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
  return { ...t, deps, csrf, http: createHttpHandler(deps, sub) };
}

function postJson(path: string, cookie: string | undefined, csrf: string | undefined, body: unknown): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (csrf !== undefined) headers['x-csrf-token'] = csrf;
  return testRequest(path, {
    method: 'POST',
    headers,
    ...(cookie === undefined ? {} : { cookie }),
    body: JSON.stringify(body),
  });
}

async function reviewOk(
  t: Awaited<ReturnType<typeof csvRouteDeps>>,
  csv: string,
): Promise<CsvReview> {
  const res = await t.http(postJson('/api/csv/review', t.identity.cookie, t.csrf, {
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

test('FP.CSV-DISPATCH: review reaches the real handler via the route; pure, no mutation', async () => {
  const t = await csvRouteDeps();
  const csv = [
    'customer,memo,urgent,count,state',
    'c-1,first,true,3,draft',
    'c-2,bad-enum,false,1,shipped',
    'c-1,first,true,3,draft',
    '',
  ].join('\n');
  const body = await reviewOk(t, csv);
  assert.equal(body.operation, OPERATION);
  assert.deepEqual(body.counts, { total: 3, valid: 1, invalid: 1, duplicate: 1 });
  assert.deepEqual(body.rows.map((row) => row.status), ['valid', 'invalid', 'duplicate']);
  assert.equal(body.rows[2]!.duplicate_of, 0);
  assert.match(body.rows[1]!.error!.message, /"state"/);
  assert.equal(t.invoker.mutations.length, 0);
  assert.equal(t.invoker.reads.length, 0);
});

test('FP.CSV-DISPATCH: missing session, missing CSRF, and wrong method deny at the route', async () => {
  const t = await csvRouteDeps();
  const csv = 'customer\nc-1\n';
  const anon = await t.http(
    testRequest('/api/csv/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': t.csrf },
      body: JSON.stringify({ operation: OPERATION, csv }),
    }),
  );
  assert.equal(anon.status, 403);
  assert.match(((await anon.json()) as { message: string }).message, /Authentication required/);
  const noCsrf = await t.http(
    testRequest('/api/csv/review', {
      method: 'POST',
      cookie: t.identity.cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: OPERATION, csv }),
    }),
  );
  assert.equal(noCsrf.status, 403);
  const wrongMethod = await t.http(
    testRequest('/api/csv/review', { method: 'GET', cookie: t.identity.cookie }),
  );
  assert.equal(wrongMethod.status, 404);
  assert.equal(((await wrongMethod.json()) as { code: string }).code, 'not_found');
  const wrongCommitMethod = await t.http(
    testRequest('/api/csv/commit', { method: 'GET', cookie: t.identity.cookie }),
  );
  assert.equal(wrongCommitMethod.status, 404);
  assert.equal(t.invoker.mutations.length, 0);
});

test('FP.CSV-DISPATCH: commit confirms via the same canonical invoker; invalid + duplicate preserved', async () => {
  const t = await csvRouteDeps({
    mutations: {
      [OPERATION]: (envelope) => ({ result: { status: 'committed', operation_id: envelope.operation_id } }),
    },
  });
  const csv = ['customer,count', 'c-1,3', 'c-bad,bogus', 'c-1,3', ''].join('\n');
  const review = await reviewOk(t, csv);
  const res = await t.http(
    postJson('/api/csv/commit', t.identity.cookie, t.csrf, commitRows(review.consent, csv, [0, 1, 2])),
  );
  assert.equal(res.status, 200);
  const outcome = (await res.json()) as CsvCommitOutcome;
  assert.equal(outcome.review_id, review.review_id);
  assert.deepEqual(outcome.rows.map((row) => row.status), ['committed', 'invalid', 'duplicate']);
  assert.equal(outcome.rows[2]!.duplicate_of, 0);
  assert.match(outcome.rows[1]!.error!.message, /"count"/);
  /* Canonical join control: exactly one invocation, canonical envelope + frozen identity. */
  assert.equal(t.invoker.mutations.length, 1);
  const call = t.invoker.mutations[0]!;
  assert.equal(call.envelope.operation, OPERATION);
  assert.deepEqual(call.envelope.inputs, { customer: 'c-1', count: '3' });
  assert.equal(call.identity.actor?.user_id, t.identity.userId);
  assert.equal(outcome.principal.user_id, t.identity.userId);
  assert.equal(outcome.rows[0]!.operation_id, call.envelope.operation_id);
});

test('FP.CSV-DISPATCH: changed candidates refuse with conflict; renewed consent commits', async () => {
  const t = await csvRouteDeps({
    mutations: {
      [OPERATION]: (envelope) => ({ result: { status: 'committed', operation_id: envelope.operation_id } }),
    },
  });
  const before = 'customer,count\nc-1,3\n';
  const after = 'customer,count\nc-1,4\n';
  const review = await reviewOk(t, before);
  const res = await t.http(
    postJson('/api/csv/commit', t.identity.cookie, t.csrf, commitRows(review.consent, after, [0])),
  );
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { message: string }).message, /renewed consent/i);
  assert.equal(t.invoker.mutations.length, 0);
  const fresh = await reviewOk(t, after);
  assert.notEqual(fresh.consent.candidates_digest, review.consent.candidates_digest);
  const retry = await t.http(
    postJson('/api/csv/commit', t.identity.cookie, t.csrf, commitRows(fresh.consent, after, [0])),
  );
  assert.equal(retry.status, 200);
  assert.equal(((await retry.json()) as CsvCommitOutcome).rows[0]!.status, 'committed');
  assert.equal(t.invoker.mutations.length, 1);
});

test('FP.CSV-DISPATCH: consent binds the reviewing principal at the route', async () => {
  const t = await csvRouteDeps({
    mutations: {
      [OPERATION]: (envelope) => ({ result: { status: 'committed', operation_id: envelope.operation_id } }),
    },
  });
  const csv = 'customer\nc-1\n';
  const review = await reviewOk(t, csv);
  const forged: CsvConsent = { ...review.consent, principal: 'user-someone-else' };
  const res = await t.http(
    postJson('/api/csv/commit', t.identity.cookie, t.csrf, commitRows(forged, csv, [0])),
  );
  assert.equal(res.status, 403);
  assert.match(((await res.json()) as { message: string }).message, /different principal/);
  assert.equal(t.invoker.mutations.length, 0);
});

test('FP.CSV-DISPATCH: membership removed mid-flight voids the commit before any invocation', async () => {
  const t = await csvRouteDeps({
    mutations: {
      [OPERATION]: (envelope) => ({ result: { status: 'committed', operation_id: envelope.operation_id } }),
    },
  });
  /* Second member bob on the same team with his own team-scoped session. */
  const store = t.identity.store;
  const email = 'bob@test.example';
  await registerWithEmail(store, t.identity.mail, { email, password: 's3cure-password' }, { verifyBaseUrl: 'https://test.invalid/verify' });
  const messages = t.identity.mail.messages;
  const token = (messages[messages.length - 1]?.body_text.match(/[?&]token=([A-Za-z0-9_-]+)/) ?? [])[1] ?? '';
  const { user_id: bobId } = await verifyEmail(store, { token });
  await store.createMembership({ team_id: t.identity.teamId, user_id: bobId, is_owner: false, roles: [] });
  const { token: bobSession } = await loginWithPassword(store, { email, password: 's3cure-password' });
  await selectTeam(store, { session_token: bobSession, team_id: t.identity.teamId });
  const bobCookie = buildSessionCookie(bobSession, { maxAgeSeconds: 3600, secure: false });
  const bobCsrf = await deriveCsrfToken(bobSession);
  const csv = 'customer\nc-1\n';
  const reviewRes = await t.http(postJson('/api/csv/review', bobCookie, bobCsrf, { operation: OPERATION, csv }));
  assert.equal(reviewRes.status, 200);
  const review = (await reviewRes.json()) as CsvReview;
  /* Owner removes bob between review and commit. */
  await removeMember(store, { team_id: t.identity.teamId, member_user_id: bobId }, { removed_by: t.identity.userId });
  const res = await t.http(postJson('/api/csv/commit', bobCookie, bobCsrf, commitRows(review.consent, csv, [0])));
  assert.equal(res.status, 403);
  assert.match(((await res.json()) as { message: string }).message, /Authority revoked/);
  assert.equal(t.invoker.mutations.length, 0);
});

test('FP.CSV-DISPATCH: repeat commits replay-safe; duplicate batch ids reject before invocation', async () => {
  const t = await csvRouteDeps({
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
  const one = await t.http(postJson('/api/csv/commit', t.identity.cookie, t.csrf, body));
  assert.equal(one.status, 200);
  const two = await t.http(postJson('/api/csv/commit', t.identity.cookie, t.csrf, body));
  assert.equal(two.status, 200);
  assert.equal(t.invoker.mutations.length, 4);
  assert.deepEqual(
    t.invoker.mutations.slice(2).map((call) => call.envelope),
    t.invoker.mutations.slice(0, 2).map((call) => call.envelope),
  );
  const before = t.invoker.mutations.length;
  const dup = await t.http(
    postJson('/api/csv/commit', t.identity.cookie, t.csrf, {
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

test('FP.CSV-DISPATCH: unknown CSV subpaths are not_found; unmounted CSV stays not_found', async () => {
  const t = await csvRouteDeps();
  const nope = await t.http(
    postJson('/api/csv/nope', t.identity.cookie, t.csrf, { operation: OPERATION, csv: 'customer\nc-1\n' }),
  );
  assert.equal(nope.status, 404);
  assert.equal(((await nope.json()) as { code: string }).code, 'not_found');
  /* Assemblies without the delivery join: prefix present, handler absent. */
  const unmounted = createHttpHandler(t.deps, {
    operations: (req, op) => handleOperationRequest(t.deps, req, op),
    auth: (req) => handleAuthRequest(t.deps, req),
    uploads: () => Promise.resolve(new Response('unused', { status: 500 })),
    ingress: () => Promise.resolve(new Response('unused', { status: 500 })),
    oauth: () => Promise.resolve(new Response('unused', { status: 500 })),
  });
  const cold = await unmounted(postJson('/api/csv/review', t.identity.cookie, t.csrf, { operation: OPERATION, csv: 'customer\nc-1\n' }));
  assert.equal(cold.status, 404);
  assert.equal(((await cold.json()) as { code: string }).code, 'not_found');
  assert.equal(t.invoker.mutations.length, 0);
});

test('FP.CSV-DISPATCH: pre-existing routes unchanged — operations dispatch, auth serves, 404s stay 404', async () => {
  const t = await csvRouteDeps({
    mutations: {
      [OPERATION]: (envelope) => ({
        result: { status: 'committed', operation_id: envelope.operation_id, echoed: envelope.inputs },
      }),
    },
  });
  const operation_id = mintOperationId();
  const op = await t.http(
    postJson(`/api/operations/${OPERATION}`, t.identity.cookie, t.csrf, {
      operation_id,
      inputs: { customer: 'c-9' },
    }),
  );
  assert.equal(op.status, 200);
  assert.equal(t.invoker.mutations.length, 1);
  assert.deepEqual(t.invoker.mutations[0]!.envelope, {
    operation: OPERATION,
    operation_id,
    inputs: { customer: 'c-9' },
  });
  const login = await t.http(testRequest('/auth/login', { method: 'GET' }));
  assert.equal(login.status, 200);
  const emptyOp = await t.http(postJson('/api/operations/', t.identity.cookie, t.csrf, {}));
  assert.equal(emptyOp.status, 404);
  assert.equal(t.invoker.mutations.length, 1);
});
