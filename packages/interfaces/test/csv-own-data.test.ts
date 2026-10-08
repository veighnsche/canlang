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
import { checkCsvHeader, mapCsvCells, parseCsvText as advisoryParse } from '@canlang/ui';

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

test('mounted scalar CSV keeps raw consent/calls while decoded duplicates and advisory agree', async () => {
  const owner = catalogFromArtifactOperations({ artifact_version: ARTIFACT_VERSION, operations: [{
    name: operation, kind: 'create', description: '', inputs: { fields: [
      { name: 'label', field: { kind: 'string' }, required: true },
      { name: 'nullable', field: { kind: 'string' }, required: false, nullable: true },
      { name: 'integer', field: { kind: 'integer' }, required: true },
      { name: 'duration', field: { kind: 'duration' }, required: false },
      { name: 'decimal', field: { kind: 'decimal' }, required: false },
      { name: 'flag', field: { kind: 'boolean' }, required: false },
      { name: '__proto__', field: { kind: 'string' }, required: false },
      { name: 'optional', field: { kind: 'string' }, required: false, default: { kind: 'literal', value: 'default' } },
      { name: 'unmapped', field: { kind: 'string' }, required: false, default: { kind: 'literal', value: 'default' } },
      { name: 'label.part', field: { kind: 'string' }, required: false },
    ] } }] });
  const t = await createTestDeps({ mutations: { [operation]: (envelope) => ({
    result: { status: 'committed', operation_id: envelope.operation_id },
  }) } });
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const deps = { ...t.deps, catalog: owner };
  const unexpected = async () => new Response('unexpected', { status: 500 });
  const handler = createHttpHandler(deps, { csv: (request) => handleCsvRequest(deps, request),
    operations: unexpected, auth: unexpected, uploads: unexpected, ingress: unexpected, oauth: unexpected });
  const post = (path: string, body: unknown) => handler(testRequest(path, { method: 'POST', cookie: t.identity.cookie,
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) }));
  const csv = [
    'label,nullable,integer,duration,decimal,flag,__proto__,optional',
    ',,-0,000,1.00,true,own,',
    ',,00,0,1.00,true,own,',
    ',,0,0,1.0,true,own,',
    ',,9007199254740992,0,1.00,true,large,',
    ',,9007199254740993,0,1.00,true,large,',
    ',,9223372036854775808,0,1.00,true,large,',
    ',,,0,1.00,yes,own,',
  ].join('\n');
  const response = await post('/api/csv/review', { operation, csv });
  assert.equal(response.status, 200);
  const reviewed = await response.json() as CsvReview;
  assert.deepEqual(reviewed.rows.map((row) => row.status), ['valid', 'duplicate', 'valid', 'valid', 'valid', 'invalid', 'invalid']);
  assert.equal(reviewed.rows[1]?.duplicate_of, 0);
  assert.deepEqual(reviewed.rows[0]?.inputs, JSON.parse('{"label":"","nullable":null,"integer":"-0","duration":"000","decimal":"1.00","flag":true,"__proto__":"own"}'));
  assert.match(reviewed.rows[6]?.error?.message ?? '', /boolean columns take true\/false/);
  const parsed = advisoryParse(csv);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('unexpected parse failure');
  const derived = owner.derivedFor(operation)!;
  assert.equal(checkCsvHeader(parsed.header, derived, owner.shapeFor(operation)!.allowed), null);
  parsed.rows.forEach((row, index) => assert.deepEqual(mapCsvCells(parsed.header, row.cells, derived).inputs, reviewed.rows[index]?.inputs));
  for (const header of ['unknown', 'operation_id', 'label,label.part', 'label,label', ',label']) {
    assert.notEqual(checkCsvHeader(header.split(','), derived, owner.shapeFor(operation)!.allowed), null);
    const refused = await post('/api/csv/review', { operation, csv: `${header}\n` });
    assert.equal(refused.status, 400, header);
  }
  // A change to the first emitted candidate must renew consent even when its duplicate group is unchanged.
  const changed = await post('/api/csv/commit', { operation, csv: csv.replace(',,-0,', ',,0,'), consent: reviewed.consent,
    rows: [{ index: 0, operation_id: mintOperationId() }] });
  assert.equal(changed.status, 409);
  assert.equal(t.invoker.mutations.length, 0);
  const committed = await post('/api/csv/commit', { operation, csv, consent: reviewed.consent,
    rows: [4, 3, 2, 1, 0].map((index) => ({ index, operation_id: mintOperationId() })) });
  assert.equal(committed.status, 200);
  assert.deepEqual((await committed.json() as CsvCommitOutcome).rows.map((row) => row.status), ['committed', 'duplicate', 'committed', 'committed', 'committed']);
  assert.deepEqual(t.invoker.mutations.map((call) => call.envelope.inputs), [0, 2, 3, 4].map((index) => reviewed.rows[index]!.inputs));
  ownData(t.invoker.mutations[0]!.envelope.inputs, '__proto__', 'own');
});
