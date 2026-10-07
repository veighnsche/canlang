import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deriveCsrfToken } from '@canlang/identity';
import { parseFormBody, parseCollectionQuery } from '../src/http/limits.js';
import { handleOperationRequest } from '../src/http/operations.js';
import { createHttpHandler } from '../src/http/routes.js';
import { createTestDeps, testRequest } from '../src/testing.js';

const keys = ['__proto__', 'constructor', 'toString', 'ordinary'];
const inputs = Object.fromEntries(keys.map((key) => [key, key]));

test('form helper retains own data keys, ordinary prototype, and last duplicate', async () => {
  const params = new URLSearchParams(Object.entries(inputs));
  params.append('__proto__', 'last');
  const parsed = await parseFormBody(new Request('https://x.invalid', { method: 'POST', body: params }));
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  for (const key of keys) {
    assert.equal(Object.hasOwn(parsed, key), true);
    assert.equal(parsed[key], key === '__proto__' ? 'last' : key);
  }
});

test('query helper retains own filter data keys without claiming mounted query effects', () => {
  const url = new URL('https://x.invalid');
  for (const key of keys) url.searchParams.append(`filter[${key}]`, key);
  url.searchParams.append('filter[__proto__]', 'last');
  url.searchParams.append('filter[]', 'ignored');
  const outcome = parseCollectionQuery(url);
  assert.ok('request' in outcome);
  assert.deepEqual(outcome.request.filters, { ...inputs, ['__proto__']: 'last' });
  assert.equal(Object.getPrototypeOf(outcome.request.filters), Object.prototype);
  assert.ok('error' in parseCollectionQuery(new URL('https://x.invalid/?limit=bad')));
});

test('mounted operation preserves declared keys in JSON/form and top-level prototype data', async () => {
  let calls = 0;
  const op = 'acme.keys';
  const t = await createTestDeps({ shapes: { [op]: { allowed: keys, required: keys } }, mutations: {
    [op]: (envelope) => {
      calls++;
      assert.deepEqual(envelope.inputs, inputs);
      assert.equal(Object.getPrototypeOf(envelope.inputs), Object.prototype);
      for (const key of keys) assert.equal(Object.hasOwn(envelope.inputs, key), true);
      return { result: { status: 'committed', operation_id: envelope.operation_id, result: {} } };
    },
  } });
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const fallback = async () => new Response(null, { status: 404 });
  const mounted = createHttpHandler(t.deps, {
    operations: (req, name) => handleOperationRequest(t.deps, req, name),
    auth: fallback, uploads: fallback, ingress: fallback, oauth: fallback,
  });
  async function submit(form: boolean, value: Record<string, unknown>, extra: Record<string, unknown> = {}, authed = true) {
    // UUIDv7 timestamp framing, with independently randomized suffix.
    const hex = Date.now().toString(16).padStart(12, '0');
    const uuid = randomUUID();
    const operation_id = `${hex.slice(0, 8)}-${hex.slice(8)}-7${uuid.slice(15)}`;
    const body = { operation_id, inputs: value, ...extra };
    return mounted(testRequest(`/api/operations/${op}`, {
      method: 'POST', ...(authed ? { cookie: t.identity.cookie } : {}),
      headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'x-csrf-token': csrf },
      body: form ? new URLSearchParams(Object.entries(body).map(([key, val]) => [key, JSON.stringify(val)])).toString() : JSON.stringify(body),
    }));
  }
  for (const form of [false, true]) {
    assert.equal((await submit(form, inputs, { ['__proto__']: { operation: 'wrong.route', action_handle: 'extra' } })).status, 200);
    const unknown = await submit(form, { ...inputs, unknown: 1 });
    assert.equal(unknown.status, 400);
    assert.match(JSON.stringify(await unknown.json()), /Unknown input 'unknown'/);
    assert.equal((await submit(form, {}, {}, false)).status, 403);
    assert.equal((await submit(form, inputs, { action_handle: 'explicit' })).status, 400);
  }
  assert.equal(calls, 2);
  assert.equal(Object.hasOwn(Object.prototype, 'operation'), false);
});
