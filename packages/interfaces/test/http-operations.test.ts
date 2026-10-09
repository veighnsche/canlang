/**
 * S4 operation-dispatch tests: authed mutation framing, CSRF, identity,
 * envelope checks, form coercion, body caps, collection queries, and error
 * passthrough.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { IdentityError, deriveCsrfToken } from '@canlang/identity';
import { buildBusinessError } from '../src/errors/envelope.js';
import {
  clearFormBindings,
  registerFormBinding,
} from '../src/http/formErrors.js';
import { FORM_REFUSAL_HEADER, catalogFromArtifactOperations, handleOperationRequest } from '../src/http/operations.js';
import { ARTIFACT_VERSION } from '@canlang/contracts';
import {
  parseCollectionQuery,
  parseFormBody,
  parseJsonBody,
  readCappedBody,
} from '../src/http/limits.js';
import { createTestDeps, testRequest } from '../src/testing.js';

const OP = 'acme.order';
const SHAPES = { [OP]: { allowed: ['qty', 'label'], required: ['qty'] } };

/** Fresh canonical UUIDv7 operation_id with the time field at `atMs`. */
function freshOperationId(atMs: number = Date.now()): string {
  const timeHex = atMs.toString(16).padStart(12, '0');
  const rand = randomBytes(10).toString('hex');
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

async function setup() {
  const t = await createTestDeps({
    shapes: SHAPES,
    mutations: {
      [OP]: (envelope) => ({
        result: {
          status: 'committed',
          operation_id: envelope.operation_id,
          result: { echoed: envelope.inputs },
        },
      }),
    },
  });
  return { ...t, csrf: await deriveCsrfToken(t.identity.sessionToken) };
}

function opRequest(opts: {
  cookie?: string;
  csrf?: string;
  body: string;
  contentType?: string;
  accept?: string;
  hxRequest?: boolean;
}): Request {
  const headers: Record<string, string> = {};
  if (opts.contentType !== undefined) headers['content-type'] = opts.contentType;
  if (opts.csrf !== undefined) headers['x-csrf-token'] = opts.csrf;
  if (opts.accept !== undefined) headers['accept'] = opts.accept;
  if (opts.hxRequest === true) headers['hx-request'] = 'true';
  return testRequest('/operations/acme.order', {
    method: 'POST',
    headers,
    ...(opts.cookie === undefined ? {} : { cookie: opts.cookie }),
    body: opts.body,
  });
}

/** Register the B3-I5 re-render binding for OP; callers must clearFormBindings in finally. */
function bindOrderForm(): void {
  registerFormBinding({
    operation: OP,
    action: '/api/operations/acme.order',
    mode: 'create',
    fields: [
      { path: 'qty', label: 'Qty', type: 'int', required: true },
      { path: 'label', label: 'Label', type: 'text', required: false },
    ],
    submit: 'Save',
    idPrefix: 'order-form',
    timeZone: 'UTC',
  });
}

async function setupFailing(code: 'rule_failed' | 'busy' = 'rule_failed') {
  const t = await createTestDeps({
    shapes: SHAPES,
    mutations: {
      [OP]: () => ({
        error: buildBusinessError(code, 'Too many ordered.', {
          fields: [{ path: '/qty', code: 'rule_failed', message: 'Too many ordered.' }],
        }),
      }),
    },
  });
  return { ...t, csrf: await deriveCsrfToken(t.identity.sessionToken) };
}

function jsonOpBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ operation_id: freshOperationId(), inputs: { qty: 1 }, ...extra });
}

test('authed JSON mutation invokes with envelope + identity', async () => {
  const t = await setup();
  const operation_id = freshOperationId();
  const res = await handleOperationRequest(
    t.deps,
    opRequest({
      cookie: t.identity.cookie,
      csrf: t.csrf,
      contentType: 'application/json',
      body: JSON.stringify({ operation: OP, operation_id, inputs: { qty: 2, label: 'x' } }),
    }),
    OP,
  );
  assert.equal(res.status, 200);
  const payload = (await res.json()) as { status: string; operation_id: string };
  assert.equal(payload.status, 'committed');
  assert.equal(payload.operation_id, operation_id);
  assert.equal(t.invoker.mutations.length, 1);
  const call = t.invoker.mutations[0];
  assert.ok(call);
  assert.deepEqual(call.envelope, { operation: OP, operation_id, inputs: { qty: 2, label: 'x' } });
  assert.equal(call.identity.actor?.user_id, t.identity.userId);
});

test('missing or stale CSRF is forbidden and never invokes', async () => {
  const t = await setup();
  const body = jsonOpBody();
  const missing = await handleOperationRequest(
    t.deps,
    opRequest({ cookie: t.identity.cookie, contentType: 'application/json', body }),
    OP,
  );
  assert.equal(missing.status, 403);
  const stale = await handleOperationRequest(
    t.deps,
    opRequest({ cookie: t.identity.cookie, csrf: 'stale-token', contentType: 'application/json', body }),
    OP,
  );
  assert.equal(stale.status, 403);
  assert.equal((await stale.json() as { code: string }).code, 'forbidden');
  assert.equal(t.invoker.mutations.length, 0);
});

test('CSRF via inputs._csrf field succeeds and the field never reaches the invoker', async () => {
  const t = await setup();
  const res = await handleOperationRequest(
    t.deps,
    opRequest({
      cookie: t.identity.cookie,
      contentType: 'application/json',
      body: JSON.stringify({ operation_id: freshOperationId(), inputs: { qty: 1, _csrf: t.csrf } }),
    }),
    OP,
  );
  assert.equal(res.status, 200);
  const call = t.invoker.mutations[0];
  assert.ok(call);
  assert.deepEqual(call.envelope.inputs, { qty: 1 });
});

test('present-but-invalid session cookie is forbidden, never public', async () => {
  const t = await setup();
  const res = await handleOperationRequest(
    t.deps,
    opRequest({
      cookie: 'can_session=garbage',
      csrf: t.csrf,
      contentType: 'application/json',
      body: jsonOpBody(),
    }),
    OP,
  );
  assert.equal(res.status, 403);
  assert.equal(t.invoker.mutations.length, 0);
});

test('public POST without a session is rejected: anonymous mutations never accepted', async () => {
  const t = await setup();
  const res = await handleOperationRequest(
    t.deps,
    opRequest({ contentType: 'application/json', body: jsonOpBody() }),
    OP,
  );
  assert.equal(res.status, 403);
  const err = (await res.json()) as { code: string; message: string };
  assert.equal(err.code, 'forbidden');
  assert.equal(err.message, 'Authentication required.');
  assert.equal(t.invoker.mutations.length, 0);
});

test('malformed, expired, and future operation_ids are validation', async () => {
  const t = await setup();
  const ids = [
    'not-a-uuid',
    freshOperationId(Date.now() - 25 * 60 * 60 * 1000),
    freshOperationId(Date.now() + 10 * 60 * 1000),
    freshOperationId().toUpperCase(),
  ];
  for (const operation_id of ids) {
    const res = await handleOperationRequest(
      t.deps,
      opRequest({
        cookie: t.identity.cookie,
        csrf: t.csrf,
        contentType: 'application/json',
        body: JSON.stringify({ operation_id, inputs: { qty: 1 } }),
      }),
      OP,
    );
    assert.equal(res.status, 400, operation_id);
    assert.equal((await res.json() as { code: string }).code, 'validation');
  }
  assert.equal(t.invoker.mutations.length, 0);
});

test('unknown operation name shape and unknown catalog entry are not_found', async () => {
  const t = await setup();
  const body = jsonOpBody();
  const authed = { cookie: t.identity.cookie, csrf: t.csrf, contentType: 'application/json', body };
  for (const name of ['nope', 'a.b.c.d', 'acme.nope', '1acme.order']) {
    const res = await handleOperationRequest(t.deps, opRequest(authed), name);
    assert.equal(res.status, 404, name);
    assert.equal((await res.json() as { code: string }).code, 'not_found');
  }
  assert.equal(t.invoker.mutations.length, 0);
});

test('unknown input member and missing required input are validation', async () => {
  const t = await setup();
  for (const inputs of [{ qty: 1, bogus: 2 }, { label: 'no-qty' }]) {
    const res = await handleOperationRequest(
      t.deps,
      opRequest({
        cookie: t.identity.cookie,
        csrf: t.csrf,
        contentType: 'application/json',
        body: JSON.stringify({ operation_id: freshOperationId(), inputs }),
      }),
      OP,
    );
    assert.equal(res.status, 400, JSON.stringify(inputs));
    assert.equal((await res.json() as { code: string }).code, 'validation');
  }
  assert.equal(t.invoker.mutations.length, 0);
});

test('invoker business errors pass through with canonical status', async () => {
  const t = await createTestDeps({
    shapes: SHAPES,
    mutations: { [OP]: () => ({ error: buildBusinessError('conflict', 'Stale version.') }) },
  });
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const res = await handleOperationRequest(
    t.deps,
    opRequest({
      cookie: t.identity.cookie,
      csrf,
      contentType: 'application/json',
      body: jsonOpBody(),
    }),
    OP,
  );
  assert.equal(res.status, 409);
  const err = (await res.json()) as { code: string; message: string };
  assert.deepEqual(err, { code: 'conflict', message: 'Stale version.', retryable: false });
});

test('form-encoded body coerces JSON values and plain strings; _csrf field works', async () => {
  const t = await setup();
  const operation_id = freshOperationId();
  const form = new URLSearchParams({
    operation_id,
    inputs: JSON.stringify({ qty: 3, label: 'plain' }),
    _csrf: t.csrf,
  });
  const res = await handleOperationRequest(
    t.deps,
    opRequest({
      cookie: t.identity.cookie,
      contentType: 'application/x-www-form-urlencoded',
      body: form.toString(),
    }),
    OP,
  );
  assert.equal(res.status, 200);
  const call = t.invoker.mutations[0];
  assert.ok(call);
  // operation_id/_csrf traveled raw (not valid JSON); inputs traveled as JSON text.
  assert.deepEqual(call.envelope, {
    operation: OP,
    operation_id,
    inputs: { qty: 3, label: 'plain' },
  });
});

test('native delete controls retain exact ref strings and refuse ambiguous or undeclared inputs', async () => {
  const operation = 'Store.Entry.delete';
  const t = await createTestDeps({ mutations: { [operation]: envelope => ({ result: {
    status: 'committed', operation_id: envelope.operation_id, result: envelope.inputs,
  } }) } });
  const catalog = catalogFromArtifactOperations({ artifact_version: ARTIFACT_VERSION, operations: [{
    name: operation, kind: 'delete', description: '', inputs: { fields: [{ name: 'record',
      field: { kind: 'ref', model: 'Store.Entry', requireVersion: true }, required: true }] },
  }] });
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const params = new URLSearchParams({ operation, operation_id: freshOperationId(), _csrf: csrf,
    'inputs[record][id]': '123', 'inputs[record][version]': '9007199254740993' });
  const submit = (body: URLSearchParams) => handleOperationRequest({ ...t.deps, catalog }, opRequest({
    cookie: t.identity.cookie, contentType: 'application/x-www-form-urlencoded', body: body.toString(),
  }), operation);
  assert.equal((await submit(params)).status, 200);
  assert.deepEqual(t.invoker.mutations[0]?.envelope.inputs, { record: { id: '123', version: '9007199254740993' } });
  for (const [name, value] of [
    ['inputs[record][id]', 'other'], ['operation_id', freshOperationId()], ['_csrf', csrf],
    ['inputs', '{}'], ['inputs[mode]', 'archive'], ['mode', 'archive'], ['inputs[unknown]', 'x'],
    ['inputs[record][extra]', 'x'], ['inputs[record][version]', '07'],
  ]) {
    const invalid = new URLSearchParams(params); invalid.append(name!, value!);
    assert.equal((await submit(invalid)).status, 400, name!);
  }
  for (const missing of ['inputs[record][id]', 'inputs[record][version]']) {
    const invalid = new URLSearchParams(params); invalid.delete(missing);
    assert.equal((await submit(invalid)).status, 400, missing);
  }
  const badCsrf = new URLSearchParams(params); badCsrf.set('_csrf', 'bad');
  assert.equal((await submit(badCsrf)).status, 403);
  const badVersion = new URLSearchParams(params); badVersion.set('inputs[record][version]', 'not-int');
  assert.equal((await submit(badVersion)).status, 400);
  assert.equal(t.invoker.mutations.length, 1, 'all refusals precede canonical execution');
});

test('native create, update and scenario controls project by declarations before canonical validation', async () => {
  for (const kind of ['create', 'update', 'scenario'] as const) {
    const operation = kind === 'scenario' ? 'Store.submit' : `Store.Entry.${kind}`;
    const t = await createTestDeps({ mutations: { [operation]: envelope => ({ result: {
      status: 'committed', operation_id: envelope.operation_id, result: envelope.inputs,
    } }) } });
    const fields = [
      ...(kind === 'update' ? [{ name: 'record', field: { kind: 'ref' as const, model: 'Store.Entry', requireVersion: true }, required: true }] : []),
      { name: 'title', field: { kind: 'string' as const }, required: true },
      { name: 'quantity', field: { kind: 'integer' as const }, required: true },
      { name: 'enabled', field: { kind: 'boolean' as const }, required: true },
      { name: 'tags', field: { kind: 'string' as const }, required: true, array: { required: true } },
    ];
    const catalog = catalogFromArtifactOperations({ artifact_version: ARTIFACT_VERSION, operations: [{ name: operation, kind, description: '', inputs: { fields } }] });
    const root = (name: string) => kind === 'update' ? `inputs[changes][${name}]` : `inputs[${name}]`;
    const params = new URLSearchParams({ operation, operation_id: freshOperationId(), _csrf: await deriveCsrfToken(t.identity.sessionToken),
      [root('title')]: '123', [root('quantity')]: '9007199254740993', [root('enabled')]: 'false', [root('tags')]: '["one"]',
      ...(kind === 'update' ? { 'inputs[record][id]': 'true', 'inputs[record][version]': '7' } : {}),
    });
    const submit = (body: URLSearchParams) => handleOperationRequest({ ...t.deps, catalog }, opRequest({
      cookie: t.identity.cookie, contentType: 'application/x-www-form-urlencoded', body: body.toString(),
    }), operation);
    assert.equal((await submit(params)).status, 200, kind);
    assert.deepEqual(t.invoker.mutations[0]?.envelope.inputs, { title: '123', quantity: '9007199254740993', enabled: false, tags: ['one'],
      ...(kind === 'update' ? { record: { id: 'true', version: '7' } } : {}),
    });
    for (const [name, value] of [[root('tags'), '{}'], [root('quantity'), 'not-int'], [root('enabled'), 'maybe']]) {
      const invalid = new URLSearchParams(params); invalid.set(name!, value!);
      assert.equal((await submit(invalid)).status, 400, `${kind}:${name}`);
    }
    if (kind === 'update') {
      const wrongMode = new URLSearchParams(params); wrongMode.set('inputs[title]', 'wrong-root');
      assert.equal((await submit(wrongMode)).status, 400);
    }
    assert.equal(t.invoker.mutations.length, 1);
  }
});

test('oversize body is a 429 quota breach', async () => {
  const t = await setup();
  const res = await handleOperationRequest(
    t.deps,
    opRequest({
      cookie: t.identity.cookie,
      csrf: t.csrf,
      contentType: 'application/json',
      body: JSON.stringify({ operation_id: freshOperationId(), inputs: { qty: 1, blob: 'x'.repeat(1_100_000) } }),
    }),
    OP,
  );
  assert.equal(res.status, 429);
  assert.equal((await res.json() as { code: string }).code, 'limit');
  assert.equal(t.invoker.mutations.length, 0);
});

test('invalid JSON, wrong content-type, and body.operation mismatch are validation', async () => {
  const t = await setup();
  const auth = { cookie: t.identity.cookie, csrf: t.csrf };
  const badJson = await handleOperationRequest(
    t.deps,
    opRequest({ ...auth, contentType: 'application/json', body: '{oops' }),
    OP,
  );
  assert.equal(badJson.status, 400);
  const wrongType = await handleOperationRequest(
    t.deps,
    opRequest({ ...auth, contentType: 'text/plain', body: '{}' }),
    OP,
  );
  assert.equal(wrongType.status, 400);
  assert.equal((await wrongType.json() as { code: string }).code, 'validation');
  const mismatch = await handleOperationRequest(
    t.deps,
    opRequest({
      ...auth,
      contentType: 'application/json',
      body: JSON.stringify({ operation: 'acme.other', operation_id: freshOperationId(), inputs: { qty: 1 } }),
    }),
    OP,
  );
  assert.equal(mismatch.status, 400);
  assert.equal((await mismatch.json() as { code: string }).code, 'validation');
  assert.equal(t.invoker.mutations.length, 0);
});

test('GET on an operation route is not_found', async () => {
  const t = await setup();
  const res = await handleOperationRequest(
    t.deps,
    testRequest('/operations/acme.order', { method: 'GET', cookie: t.identity.cookie }),
    OP,
  );
  assert.equal(res.status, 404);
  assert.equal(t.invoker.mutations.length, 0);
});

test('parseCollectionQuery: defaults, clamp, cursor, order, filters, validation', () => {
  assert.deepEqual(parseCollectionQuery(new URL('https://x.invalid/')), {
    request: { limit: 25 },
  });
  assert.deepEqual(parseCollectionQuery(new URL('https://x.invalid/?limit=10')), {
    request: { limit: 10 },
  });
  assert.deepEqual(parseCollectionQuery(new URL('https://x.invalid/?limit=500')), {
    request: { limit: 100 },
  });
  const full = parseCollectionQuery(
    new URL('https://x.invalid/?cursor=abc&order=a,-b&filter%5Bstatus%5D=open&filter%5Bq%5D=x'),
  );
  assert.deepEqual(full, {
    request: { limit: 25, cursor: 'abc', order: ['a', '-b'], filters: { status: 'open', q: 'x' } },
  });
  for (const raw of ['abc', '-1', '1.5', '']) {
    const outcome = parseCollectionQuery(new URL(`https://x.invalid/?limit=${raw}`));
    assert.ok('error' in outcome, raw);
    assert.equal(outcome.error.code, 'validation');
  }
});

test('B3-I5: Accept text/html re-renders the failed POST as a full page with drafts', async () => {
  const t = await setupFailing();
  bindOrderForm();
  try {
    const operation_id = freshOperationId();
    const res = await handleOperationRequest(
      t.deps,
      opRequest({
        cookie: t.identity.cookie,
        csrf: t.csrf,
        contentType: 'application/json',
        accept: 'text/html,application/xhtml+xml',
        body: JSON.stringify({ operation_id, inputs: { qty: 9, label: 'keep me' } }),
      }),
      OP,
    );
    assert.equal(res.status, 422);
    assert.ok((res.headers.get('content-type') ?? '').startsWith('text/html'));
    assert.ok((res.headers.get('vary') ?? '').includes('Accept'));
    assert.deepEqual(JSON.parse(res.headers.get(FORM_REFUSAL_HEADER)!), {
      version: 1, code: 'rule_failed', retryable: false,
    });
    const html = await res.text();
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'full-page branch');
    assert.ok(html.includes('Too many ordered.'), 'inline field error');
    assert.ok(html.includes('aria-invalid="true"'), 'qty flagged invalid');
    assert.ok(html.includes('value="9"'), 'int draft preserved verbatim');
    assert.ok(html.includes('value="keep me"'), 'text draft preserved verbatim');
    assert.ok(html.includes(`value="${operation_id}"`), 'operation_id carried for retry');
  } finally {
    clearFormBindings();
  }
});

test('B3-I5: HX-Request re-renders a bare fragment without the document shell', async () => {
  const t = await setupFailing();
  bindOrderForm();
  try {
    const res = await handleOperationRequest(
      t.deps,
      opRequest({
        cookie: t.identity.cookie,
        csrf: t.csrf,
        contentType: 'application/json',
        accept: 'application/json',
        hxRequest: true,
        body: jsonOpBody(),
      }),
      OP,
    );
    assert.equal(res.status, 422);
    assert.ok((res.headers.get('content-type') ?? '').startsWith('text/html'));
    assert.deepEqual(JSON.parse(res.headers.get(FORM_REFUSAL_HEADER)!), {
      version: 1, code: 'rule_failed', retryable: false,
    });
    const html = await res.text();
    assert.ok(!html.includes('<html'), 'fragment branch: no document shell');
    assert.ok(html.includes('id="order-form-form"'), 'stable swap target');
    assert.ok(html.includes('Too many ordered.'), 'inline field error');
  } finally {
    clearFormBindings();
  }
});

test('HTML refusals expose only closed code and retryability, with no prose or draft data', async () => {
  const t = await setupFailing('busy');
  bindOrderForm();
  try {
    const res = await handleOperationRequest(t.deps, opRequest({
      cookie: t.identity.cookie, csrf: t.csrf, contentType: 'application/json', accept: 'text/html',
      body: jsonOpBody({ inputs: { qty: 9, label: 'private-draft-value' } }),
    }), OP);
    assert.equal(res.status, 503);
    const fact = res.headers.get(FORM_REFUSAL_HEADER)!;
    assert.deepEqual(JSON.parse(fact), { version: 1, code: 'busy', retryable: true });
    assert.ok(!fact.includes('private-draft-value'));
    assert.ok(!fact.includes('Too many ordered.'));
    assert.ok((await res.text()).includes('private-draft-value'), 'normal form redisplay is preserved');
  } finally {
    clearFormBindings();
  }
});

test('B3-I5: JSON stays the default without HTML headers, even with a binding', async () => {
  const t = await setupFailing();
  bindOrderForm();
  try {
    for (const accept of [undefined, 'application/json', '*/*']) {
      const res = await handleOperationRequest(
        t.deps,
        opRequest({
          cookie: t.identity.cookie,
          csrf: t.csrf,
          contentType: 'application/json',
          ...(accept === undefined ? {} : { accept }),
          body: jsonOpBody(),
        }),
        OP,
      );
      assert.equal(res.status, 422, `accept=${accept ?? '(absent)'}`);
      assert.ok((res.headers.get('content-type') ?? '').startsWith('application/json'));
      assert.equal(res.headers.get(FORM_REFUSAL_HEADER), null);
      assert.equal((await res.json() as { code: string }).code, 'rule_failed');
    }
  } finally {
    clearFormBindings();
  }
});

test('B3-I5: text/html without a registered binding stays bare JSON', async () => {
  const t = await setupFailing();
  clearFormBindings();
  const res = await handleOperationRequest(
    t.deps,
    opRequest({
      cookie: t.identity.cookie,
      csrf: t.csrf,
      contentType: 'application/json',
      accept: 'text/html',
      body: jsonOpBody(),
    }),
    OP,
  );
  assert.equal(res.status, 422);
  assert.ok((res.headers.get('content-type') ?? '').startsWith('application/json'));
});

test('B3-I5: ill-typed drafts degrade to empty inputs, never a 500', async () => {
  const t = await setupFailing();
  bindOrderForm();
  try {
    const res = await handleOperationRequest(
      t.deps,
      opRequest({
        cookie: t.identity.cookie,
        csrf: t.csrf,
        contentType: 'application/json',
        accept: 'text/html',
        body: JSON.stringify({ operation_id: freshOperationId(), inputs: { qty: 'not-a-number', label: 'ok' } }),
      }),
      OP,
    );
    assert.equal(res.status, 422);
    const html = await res.text();
    assert.ok(html.includes('Too many ordered.'), 'inline error survives the bad draft');
    assert.ok(!html.includes('not-a-number'), 'unrenderable draft dropped, not echoed');
    assert.ok(html.includes('value="ok"'), 'renderable draft preserved');
  } finally {
    clearFormBindings();
  }
});

test('B3-I5: framing failures re-render too when drafts exist', async () => {
  const t = await setup();
  bindOrderForm();
  try {
    const res = await handleOperationRequest(
      t.deps,
      opRequest({
        cookie: t.identity.cookie,
        csrf: t.csrf,
        contentType: 'application/json',
        accept: 'text/html',
        body: JSON.stringify({ operation_id: freshOperationId(), inputs: { label: 'no-qty' } }),
      }),
      OP,
    );
    assert.equal(res.status, 400);
    assert.ok((res.headers.get('content-type') ?? '').startsWith('text/html'));
    const html = await res.text();
    assert.ok(html.includes('Missing required input'), 'framing message in banner');
    assert.ok(html.includes('aria-invalid="true"'), 'missing field flagged inline');
    assert.ok(html.includes('value="no-qty"'), 'draft preserved');
  } finally {
    clearFormBindings();
  }
});

test('body readers enforce caps and shapes', async () => {
  const over = testRequest('/x', { method: 'POST', body: 'x'.repeat(100) });
  await assert.rejects(readCappedBody(over, 10), (e: unknown) => e instanceof IdentityError && e.code === 'limit');
  const badJson = testRequest('/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'nope',
  });
  await assert.rejects(parseJsonBody(badJson), (e: unknown) => e instanceof IdentityError && e.code === 'validation');
  const dupes = testRequest('/x', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'a=1&a=2',
  });
  assert.deepEqual(await parseFormBody(dupes), { a: '2' });
});
