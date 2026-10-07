import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARTIFACT_VERSION } from '@canlang/contracts';
import { deriveCsrfToken } from '@canlang/identity';
import { catalogFromArtifactOperations } from '../src/http/operations.js';
import { handleCsvRequest, reviewCsvCandidates } from '../src/http/csv.js';
import type { CsvCommitOutcome, CsvReview } from '../src/http/csv.js';
import { mintOperationId } from '../src/http/context.js';
import { createHttpHandler } from '../src/http/routes.js';
import { createTestDeps, testRequest } from '../src/testing.js';

const operation = 'Data.Row.put';
function catalog(names: string[], kind: 'string' | 'boolean' = 'string') {
  return catalogFromArtifactOperations({ artifact_version: ARTIFACT_VERSION, operations: [{
    name: operation, kind: 'create', description: '',
    inputs: { fields: names.map((name) => ({ name, field: { kind }, required: false })) },
  }] });
}
async function review(names: string[], cells: string[][], kind: 'string' | 'boolean' = 'string') {
  const owner = catalog(names, kind);
  return reviewCsvCandidates({ operation, shape: owner.shapeFor(operation)!, derived: owner.derivedFor(operation)!,
    principal: 'viewer', header: names, rows: cells.map((row) => ({ cells: row, malformed: false })) });
}
function ownData(inputs: unknown, key: string, value: unknown) {
  assert.equal(Object.getPrototypeOf(inputs), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(inputs, key), { value, enumerable: true, writable: true, configurable: true });
}

test('declared __proto__ cells preserve candidate identity and ordinary own data', async () => {
  const result = await review(['__proto__'], [['first'], ['second'], ['first']]);
  assert.deepEqual(result.rows.map((row) => row.status), ['valid', 'valid', 'duplicate']);
  assert.equal(result.rows[2]?.duplicate_of, 0);
  ownData(result.rows[0]?.inputs, '__proto__', 'first');
  ownData(result.rows[1]?.inputs, '__proto__', 'second');
  assert.equal(JSON.stringify(result.rows[0]?.inputs), '{"__proto__":"first"}');
  const changed = await review(['__proto__'], [['different'], ['second'], ['different']]);
  assert.notEqual(result.consent.candidates_digest, changed.consent.candidates_digest);
  assert.deepEqual(result.counts, { total: 3, valid: 2, invalid: 0, duplicate: 1 });
});

test('prototype-like names remain ordinary declared data; empty cells remain absent', async () => {
  const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];
  const result = await review(names, [['one', 'two', 'three', 'four', 'five'], ['', '', '', '', '']]);
  assert.deepEqual(result.rows.map((row) => row.status), ['valid', 'valid']);
  names.forEach((name, index) => ownData(result.rows[0]?.inputs, name, ['one', 'two', 'three', 'four', 'five'][index]));
  assert.deepEqual(Object.keys(result.rows[1]!.inputs), []);
  assert.equal(Object.hasOwn(result.rows[1]!.inputs, '__proto__'), false);
});

test('boolean __proto__ retains false/true data and first binding error', async () => {
  const result = await review(['__proto__'], [['true'], ['false'], ['yes'], ['']], 'boolean');
  assert.deepEqual(result.rows.map((row) => row.status), ['valid', 'valid', 'invalid', 'valid']);
  ownData(result.rows[0]?.inputs, '__proto__', true);
  ownData(result.rows[1]?.inputs, '__proto__', false);
  assert.equal(result.rows[2]?.error?.message, 'Invalid value for input "__proto__": boolean columns take true/false text (got "yes").');
  assert.equal(Object.hasOwn(result.rows[2]!.inputs, '__proto__'), false);
  assert.equal(Object.hasOwn(result.rows[3]!.inputs, '__proto__'), false);
});

async function mounted() {
  const t = await createTestDeps({ mutations: { [operation]: (envelope) => {
    ownData(envelope.inputs, '__proto__', envelope.inputs['__proto__']);
    return { result: { status: 'committed', operation_id: envelope.operation_id } };
  } } });
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const deps = { ...t.deps, catalog: catalog(['__proto__']) };
  const unexpected = async () => new Response('unexpected route', { status: 500 });
  const handler = createHttpHandler(deps, { csv: (request) => handleCsvRequest(deps, request),
    operations: unexpected, auth: unexpected, uploads: unexpected, ingress: unexpected, oauth: unexpected });
  const post = (route: string, body: unknown) => handler(testRequest(route, { method: 'POST', cookie: t.identity.cookie,
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) }));
  return { ...t, post };
}

test('mounted commit receives distinct own inputs and source-ordered operation IDs', async () => {
  const t = await mounted();
  const csv = '__proto__\nfirst\nsecond\n';
  const response = await t.post('/api/csv/review', { operation, csv });
  assert.equal(response.status, 200);
  const result = await response.json() as CsvReview;
  assert.deepEqual(result.rows.map((row) => row.status), ['valid', 'valid']);
  const rows = [1, 0].map((index) => ({ index, operation_id: mintOperationId() }));
  const commit = await t.post('/api/csv/commit', { operation, csv, consent: result.consent, rows });
  assert.equal(commit.status, 200);
  assert.deepEqual(t.invoker.mutations.map((call) => [call.envelope.inputs['__proto__'], call.envelope.operation_id]),
    [['first', rows[1]!.operation_id], ['second', rows[0]!.operation_id]]);
  assert.deepEqual((await commit.json() as CsvCommitOutcome).rows.map((row) => row.status), ['committed', 'committed']);
});

test('mounted changed __proto__ candidate voids consent before any invocation', async () => {
  const t = await mounted();
  const response = await t.post('/api/csv/review', { operation, csv: '__proto__\nfirst\n' });
  assert.equal(response.status, 200);
  const result = await response.json() as CsvReview;
  const changed = await t.post('/api/csv/commit', { operation, csv: '__proto__\nchanged\n', consent: result.consent,
    rows: [{ index: 0, operation_id: mintOperationId() }] });
  assert.equal(changed.status, 409);
  assert.equal((await changed.json() as { message: string }).message, 'Candidates changed since review; renewed consent required.');
  assert.equal(t.invoker.mutations.length, 0);
});
