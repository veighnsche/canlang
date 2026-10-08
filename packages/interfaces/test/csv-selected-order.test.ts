import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveCsrfToken } from '@canlang/identity';
import { ARTIFACT_VERSION } from '@canlang/contracts';
import { catalogFromArtifactOperations } from '../src/http/operations.js';
import { mintOperationId } from '../src/http/context.js';
import { handleCsvRequest } from '../src/http/csv.js';
import type { CsvCommitOutcome, CsvReview } from '../src/http/csv.js';
import { createHttpHandler } from '../src/http/routes.js';
import { createTestDeps, testRequest } from '../src/testing.js';

const operation = 'Billing.Invoice.issue';
const slice = {
  artifact_version: ARTIFACT_VERSION,
  operations: [{
    name: operation, kind: 'create' as const, description: '',
    inputs: { fields: [
      { name: 'customer', field: { kind: 'string' as const }, required: true },
      { name: 'count', field: { kind: 'integer' as const }, required: false },
    ] },
  }],
};

async function fixture(overrides: Parameters<typeof createTestDeps>[0] = {}) {
  const t = await createTestDeps(overrides);
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const deps = { ...t.deps, catalog: catalogFromArtifactOperations(slice) };
  const unused = async () => new Response('unexpected route', { status: 500 });
  const http = createHttpHandler(deps, {
    operations: unused, auth: unused, uploads: unused, ingress: unused, oauth: unused,
    csv: (request) => handleCsvRequest(deps, request),
  });
  const post = (path: string, body: unknown) => http(testRequest(path, {
    method: 'POST', cookie: t.identity.cookie,
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify(body),
  }));
  const review = async (csv: string) => {
    const response = await post('/api/csv/review', { operation, csv });
    assert.equal(response.status, 200);
    return await response.json() as CsvReview;
  };
  return { ...t, post, review };
}

function body(review: CsvReview, csv: string, indexes: number[]) {
  return { operation, csv, consent: review.consent, rows: indexes.map((index) => ({ index, operation_id: mintOperationId() })) };
}

test('mounted reversed selection invokes and awaits in original source row order', async () => {
  const effects: string[] = [];
  const t = await fixture({ mutations: { [operation]: async (envelope) => {
    const customer = String(envelope.inputs['customer']);
    effects.push(`start:${customer}`);
    await Promise.resolve();
    effects.push(`end:${customer}`);
    return { result: { status: 'committed', operation_id: envelope.operation_id } };
  } } });
  const csv = 'customer\nfirst\nsecond\nthird\n';
  const request = body(await t.review(csv), csv, [2, 0, 1]);
  const before = structuredClone(request.rows);
  const response = await t.post('/api/csv/commit', request);
  assert.equal(response.status, 200);
  assert.deepEqual(effects, ['start:first', 'end:first', 'start:second', 'end:second', 'start:third', 'end:third']);
  assert.deepEqual(t.invoker.mutations.map((call) => call.envelope.inputs['customer']), ['first', 'second', 'third']);
  assert.deepEqual(request.rows, before);
  const result = await response.json() as CsvCommitOutcome;
  assert.deepEqual(result.rows.map((row) => row.index), [0, 1, 2]);
  for (const row of result.rows) assert.equal(row.operation_id, request.rows.find((selected) => selected.index === row.index)?.operation_id);
});

test('reversed selected invalid/duplicate/bad-id/partial rows preserve statuses with no extra effects', async () => {
  const effects: string[] = [];
  const t = await fixture({ mutations: { [operation]: (envelope) => {
    const customer = String(envelope.inputs['customer']);
    effects.push(customer);
    return customer === 'reject'
      ? { error: { code: 'rule_failed', message: 'row refused', retryable: false } }
      : { result: { status: 'committed', operation_id: envelope.operation_id } };
  } } });
  const csv = 'customer,count\nfirst,1\ninvalid,bogus\nfirst,1\nreject,2\nunselected,4\nbad-id,5\nlast,6\n';
  const review = await t.review(csv);
  const request = body(review, csv, [6, 5, 3, 2, 1, 0]);
  request.rows.find((row) => row.index === 5)!.operation_id = 'bad-key';
  const response = await t.post('/api/csv/commit', request);
  assert.equal(response.status, 200);
  assert.deepEqual(effects, ['first', 'reject', 'last']);
  const result = await response.json() as CsvCommitOutcome;
  assert.deepEqual(result.rows.map((row) => [row.index, row.status]), [[0, 'committed'], [1, 'invalid'], [2, 'duplicate'], [3, 'failed'], [5, 'failed'], [6, 'committed']]);
  assert.deepEqual(result.rows[1]?.error, review.rows[1]?.error);
  assert.equal(result.rows[2]?.duplicate_of, 0);
  assert.equal(result.rows[3]?.error?.message, 'row refused');
  assert.equal(t.invoker.mutations.length, 3);
});

test('unknown invoker outcomes remain row failures in source invocation order', async () => {
  const t = await fixture();
  const csv = 'customer\nfirst\nsecond\n';
  const response = await t.post('/api/csv/commit', body(await t.review(csv), csv, [1, 0]));
  assert.equal(response.status, 200);
  assert.deepEqual(t.invoker.mutations.map((call) => call.envelope.inputs['customer']), ['first', 'second']);
  const result = await response.json() as CsvCommitOutcome;
  assert.deepEqual(result.rows.map((row) => [row.status, row.error?.code]), [['failed', 'not_found'], ['failed', 'not_found']]);
});

test('a thrown source-first callback stops demand for later selected rows', async () => {
  const effects: string[] = [];
  const t = await fixture({ mutations: { [operation]: (envelope) => {
    const customer = String(envelope.inputs['customer']);
    effects.push(customer);
    if (customer === 'first') throw new Error('callback sentinel');
    return { result: { status: 'committed', operation_id: envelope.operation_id } };
  } } });
  const csv = 'customer\nfirst\nsecond\nthird\n';
  const response = await t.post('/api/csv/commit', body(await t.review(csv), csv, [2, 1, 0]));
  assert.equal(response.status, 422);
  assert.deepEqual(effects, ['first']);
  assert.equal(t.invoker.mutations.length, 1);
});

test('duplicate selections/replay keys and unknown row indexes refuse before effects', async () => {
  const t = await fixture();
  const csv = 'customer\nfirst\nsecond\n';
  const review = await t.review(csv);
  for (const [indexes, duplicateId, message] of [
    [[1, 1], false, 'Duplicate row index 1 in commit batch.'],
    [[1, 0], true, 'Duplicate operation_id in commit batch.'],
    [[9, 8], false, 'Unknown row index 9.'],
  ] as const) {
    const request = body(review, csv, [...indexes]);
    if (duplicateId) request.rows[1]!.operation_id = request.rows[0]!.operation_id;
    const response = await t.post('/api/csv/commit', request);
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { message: string }).message, message);
    assert.equal(t.invoker.mutations.length, 0);
  }
});

test('header errors retain first refusal without invocation', async () => {
  const t = await fixture();
  const csv = 'customer\nfirst\n';
  const review = await t.review(csv);
  for (const [invalid, message] of [
    ['customer,customer\na,b\n', 'CSV header repeats column "customer".'],
    [',customer\na,b\n', 'CSV header has an empty column name.'],
    ['customer,customer,\na,b,c\n', 'CSV header has an empty column name.'],
    ['unknown,customer,customer\na,b,c\n', 'CSV header repeats column "customer".'],
  ]) {
    const response = await t.post('/api/csv/commit', body(review, invalid!, [0]));
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { message: string }).message, message);
    assert.equal(t.invoker.mutations.length, 0);
  }
});
