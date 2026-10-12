import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { ARTIFACT_VERSION } from '@canlang/contracts';
import { deriveCsrfToken } from '@canlang/identity';
import { catalogFromArtifactOperations, createSourceValidationCatalog, handleOperationRequest } from '../src/http/operations.js';
import { createTestDeps, testRequest } from '../src/testing.js';

const OP = 'Serving.run';
const slice = { artifact_version: ARTIFACT_VERSION, operations: [{ name: OP, kind: 'scenario', description: '',
  inputs: { fields: [{ name: 'qty', field: { kind: 'integer' }, required: true }] } }] };
function id(): string {
  const time = Date.now().toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-8${random.slice(4, 7)}-${random.slice(7, 19)}`;
}

test('HTTP source lifetime refuses a mutation queued after final asynchronous verification', async () => {
  let current = true, checks = 0, invocations = 0;
  const t = await createTestDeps({ mutations: { [OP]: envelope => {
    invocations++; return { result: { status: 'committed', operation_id: envelope.operation_id, result: null } };
  } } });
  // Controlled timing oracle only. The owning CF test separately supplies
  // the genuine verified assembly/source; this proves the caller boundary.
  const catalog = createSourceValidationCatalog(catalogFromArtifactOperations(slice), async () => ({
    ownerRevision: 'controlled-await-order', descriptor: { operations: { [OP]: { inputs: { qty: { type: 'int' } }, mutation: true } } },
    assertCurrent: async () => {
      assert.ok(current);
      if (++checks === 3) queueMicrotask(() => { current = false; });
    },
    assertStable: () => { if (!current) throw new Error('source changed after async verification'); },
  }));
  const response = await handleOperationRequest({ ...t.deps, catalog }, testRequest('/api/operations/Serving.run', {
    method: 'POST', cookie: t.identity.cookie,
    headers: { 'content-type': 'application/json', 'x-csrf-token': await deriveCsrfToken(t.identity.sessionToken) },
    body: JSON.stringify({ operation_id: id(), inputs: { qty: '1' } }),
  }), OP);
  assert.notEqual(response.status, 200); assert.equal(checks, 3); assert.equal(invocations, 0);
});

test('copied/frozen source catalog cannot silently serve as a legacy catalog; closed originals cannot re-enter', async () => {
  let invocations = 0;
  const t = await createTestDeps({ mutations: { [OP]: envelope => {
    invocations++; return { result: { status: 'committed', operation_id: envelope.operation_id, result: null } };
  } } });
  const catalog = createSourceValidationCatalog(catalogFromArtifactOperations(slice), async () => ({
    ownerRevision: 'controlled-lifetime', descriptor: { operations: { [OP]: { inputs: { qty: { type: 'int' } }, mutation: true } } },
    assertCurrent: async () => {}, assertStable: () => {},
  }));
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const request = () => testRequest('/api/operations/Serving.run', { method: 'POST', cookie: t.identity.cookie,
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ operation_id: id(), inputs: { qty: '1' } }) });
  const copied = await handleOperationRequest({ ...t.deps, catalog: Object.freeze({ ...catalog }) }, request(), OP);
  assert.notEqual(copied.status, 200); assert.equal(invocations, 0);
  assert.equal((await handleOperationRequest({ ...t.deps, catalog }, request(), OP)).status, 200);
  assert.equal(invocations, 1);
  assert.notEqual((await handleOperationRequest({ ...t.deps, catalog }, request(), OP)).status, 200);
  assert.equal(invocations, 1);
});
