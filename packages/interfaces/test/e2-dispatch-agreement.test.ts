/**
 * E2a dispatch-agreement tests (F-independent slice): rich denials and
 * rich drafts agree with the dispatcher on the full/partial request
 * path — bound-checker (E1) denials re-render with per-field errors
 * and preserved drafts, rich update/conflict paths re-render with the
 * record and changes, projected rich submits dispatch really, and
 * CSRF/session still gate before dispatch. No parallel validation:
 * every denial below is the dispatcher's own error re-rendered.
 *
 * Grounding (no invented operations or types):
 * - `LEDGER_CREATE`/`LEDGER_UPDATE` are the t19b fixtures verbatim
 *   (real `can 0.1.0` emission over the Ledger sources).
 * - `GADGET_CREATE` is the t19a fixture verbatim (Shop emission).
 * File values reach re-render as opaque-id drafts in S7 file slots
 * (F1 join: the file widget renders a picker + hidden slot + attached
 * line; file bytes never ride the op POST — the S7 intent flow carries
 * them and the projection submits the finalized id verbatim).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveCsrfToken } from '@canlang/identity';
import type { IdentityStore } from '@canlang/identity';
import { ARTIFACT_VERSION } from '@canlang/contracts';
import type { ArtifactOperation } from '@canlang/contracts';
import type {
  ClosedInputs,
  MutationEnvelope,
  ResolvedIdentity,
} from '@canlang/contracts';
import type { MutationOutcome } from '../src/ports.js';
import { buildBusinessError } from '../src/errors/envelope.js';
import {
  catalogFromArtifactOperations,
  deriveOperationInputs,
  handleOperationRequest,
} from '../src/http/operations.js';
import { mintOperationId, resolveRequestIdentity } from '../src/http/context.js';
import { buildPresentationContext } from '../src/http/presentation.js';
import {
  bindingFromDerived,
  clearFormBindings,
  registerFormBinding,
  renderFormError,
} from '../src/http/formErrors.js';
import { createTestDeps, testRequest } from '../src/testing.js';
import { generatedFields, projectGeneratedInputs } from '@canlang/ui';

/* Verbatim t19b emission: Ledger.Gadget.create. */
const LEDGER_CREATE: ArtifactOperation = {
  "name": "Ledger.Gadget.create",
  "kind": "create",
  "description": "",
  "inputs": {"fields": [
    {"name": "title", "field": {"kind": "string"}, "required": true},
    {"name": "stock", "field": {"kind": "integer"}, "required": false, "default": {"kind": "literal", "value": "0"}},
    {"name": "price", "field": {"kind": "decimal"}, "required": true},
    {"name": "fee", "field": {"kind": "money"}, "required": false},
    {"name": "whole", "field": {"kind": "decimal"}, "required": false, "default": {"kind": "literal", "value": "2"}},
    {"name": "delta", "field": {"kind": "integer"}, "required": false},
    {"name": "doc", "field": {"kind": "file"}, "required": true},
  ]},
};

/* Verbatim t19b emission: Ledger.Gadget.update (partial, default-less). */
const LEDGER_UPDATE: ArtifactOperation = {
  "name": "Ledger.Gadget.update",
  "kind": "update",
  "description": "",
  "inputs": {"fields": [
    {"name": "record", "field": {"kind": "ref", "model": "Ledger.Gadget", "requireVersion": true}, "required": true},
    {"name": "title", "field": {"kind": "string"}, "required": false},
    {"name": "stock", "field": {"kind": "integer"}, "required": false},
    {"name": "price", "field": {"kind": "decimal"}, "required": false},
    {"name": "fee", "field": {"kind": "money"}, "required": false},
    {"name": "whole", "field": {"kind": "decimal"}, "required": false},
    {"name": "delta", "field": {"kind": "integer"}, "required": false},
    {"name": "doc", "field": {"kind": "file"}, "required": false},
  ]},
};

/* Verbatim t19a emission: Shop.Gadget.create. */
const GADGET_CREATE: ArtifactOperation = {
  "name": "Shop.Gadget.create",
  "kind": "create",
  "description": "",
  "inputs": {"fields": [
    {"name": "title", "field": {"kind": "string"}, "required": true},
    {"name": "stock", "field": {"kind": "integer"}, "required": false, "default": {"kind": "literal", "value": "0"}},
    {"name": "price", "field": {"kind": "decimal"}, "required": true},
    {"name": "state", "field": {"kind": "enum", "values": ["draft", "submitted"]}, "required": false, "default": {"kind": "literal", "value": "draft"}},
    {"name": "owner", "field": {"kind": "ref", "model": "Shop.Gadget", "requireVersion": true}, "required": false, "nullable": true},
    {"name": "tags", "field": {"kind": "string"}, "required": false, "array": {"required": false}},
    {"name": "ids", "field": {"kind": "string"}, "required": true, "array": {"required": true}},
    {"name": "code", "field": {"kind": "string"}, "required": true},
  ]},
};

const E2_OPS: readonly ArtifactOperation[] = [LEDGER_CREATE, LEDGER_UPDATE, GADGET_CREATE];
const E2_SLICE = { artifact_version: ARTIFACT_VERSION, operations: E2_OPS };

/** One rich row: the observable state submits change (values verbatim). */
interface RichRow {
  readonly id: string;
  version: string;
  fields: ClosedInputs;
}

/**
 * Stateful rich-store invoker: real insert/update/version-fencing
 * semantics over the ledger + shop ops. Unknown ids are `not_found`,
 * stale versions are `conflict` with a wire-correct pointer; everything
 * else stores the envelope inputs verbatim.
 */
function createRichStore(): {
  readonly rows: Map<string, RichRow>;
  readonly handlers: Record<string, (envelope: MutationEnvelope, identity: ResolvedIdentity) => MutationOutcome>;
} {
  const rows = new Map<string, RichRow>();
  let seq = 0;
  const update = (envelope: MutationEnvelope): MutationOutcome => {
    const record = envelope.inputs['record'] as { id?: unknown; version?: unknown } | undefined;
    const row = typeof record?.id === 'string' ? rows.get(record.id) : undefined;
    if (row === undefined) {
      return { error: buildBusinessError('not_found', 'Unknown gadget.') };
    }
    if (record?.version !== row.version) {
      const message = 'Stale version.';
      return {
        error: buildBusinessError('conflict', message, {
          fields: [{ path: '/record/version', code: 'stale', message }],
        }),
      };
    }
    const { record: _dropped, ...changes } = envelope.inputs;
    void _dropped;
    row.fields = { ...row.fields, ...changes };
    row.version = String(Number(row.version) + 1);
    return {
      result: { status: 'committed', operation_id: envelope.operation_id, result: { id: row.id, version: row.version } },
    };
  };
  return {
    rows,
    handlers: {
      'Ledger.Gadget.create': (envelope) => {
        seq += 1;
        const id = `g${seq}`;
        rows.set(id, { id, version: '1', fields: { ...envelope.inputs } });
        return {
          result: { status: 'committed', operation_id: envelope.operation_id, result: { id, version: '1' } },
        };
      },
      'Ledger.Gadget.update': update,
      'Shop.Gadget.create': (envelope) => {
        seq += 1;
        const id = `s${seq}`;
        rows.set(id, { id, version: '1', fields: { ...envelope.inputs } });
        return {
          result: { status: 'committed', operation_id: envelope.operation_id, result: { id, version: '1' } },
        };
      },
    },
  };
}

function opRequest(opts: {
  cookie?: string;
  csrf?: string;
  acceptHtml?: boolean;
  htmx?: boolean;
  body: string;
}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.csrf !== undefined) headers['x-csrf-token'] = opts.csrf;
  if (opts.acceptHtml === true) headers['accept'] = 'text/html';
  if (opts.htmx === true) headers['HX-Request'] = 'true';
  return testRequest('/api/operations/x', {
    method: 'POST',
    headers,
    ...(opts.cookie === undefined ? {} : { cookie: opts.cookie }),
    body: opts.body,
  });
}

/** Resolve the fixture identity for one cookie-carrying request, for real. */
async function testPrincipal(store: IdentityStore, cookie: string): Promise<ResolvedIdentity> {
  const { identity } = await resolveRequestIdentity(store, testRequest('/x', { cookie }));
  return identity;
}

async function dispatchSetup() {
  const store = createRichStore();
  const t = await createTestDeps({ mutations: store.handlers });
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const catalog = catalogFromArtifactOperations(E2_SLICE);
  return { store, t, deps: { ...t.deps, catalog }, csrf };
}

function registerGenerated(
  op: ArtifactOperation,
  mode: 'create' | 'update',
  idPrefix: string,
  dropFields: readonly string[] = [],
): void {
  const derived = deriveOperationInputs(op);
  registerFormBinding(
    bindingFromDerived({
      derived,
      mode,
      action: `/api/operations/${op.name}`,
      fields: generatedFields(derived, mode).filter((field) => !dropFields.includes(field.path)),
      submit: 'Save',
      idPrefix,
      timeZone: 'UTC',
    }),
  );
}

test('E2a bound denial re-renders the full page with per-field errors and drafts', async () => {
  clearFormBindings();
  const { store, t, deps, csrf } = await dispatchSetup();
  registerGenerated(GADGET_CREATE, 'create', 'e2a-create');
  // The dispatcher's own bound-checker denial (no parallel engine).
  const res = await handleOperationRequest(
    deps,
    opRequest({
      cookie: t.identity.cookie,
      csrf,
      acceptHtml: true,
      body: JSON.stringify({
        operation_id: mintOperationId(),
        inputs: { title: 'wrench-draft', price: '1.50', ids: ['a'], code: 'c', state: 'DRAFT' },
      }),
    }),
    'Shop.Gadget.create',
  );
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  // Quotes arrive HTML-escaped: presence plus safe escaping in one check.
  assert.ok(html.includes('&quot;draft&quot;, &quot;submitted&quot;'), 'checker message explains');
  assert.ok(html.includes('value="wrench-draft"'), 'valid draft redisplays');
  assert.ok(html.includes('e2a-create-state-error'), 'per-field outlet anchors');
  assert.ok(!html.includes('    at '), 'no stack frames leak');
  assert.equal(t.invoker.mutations.length, 0, 'denied submit never invoked');
  assert.equal(store.rows.size, 0, 'denied submit changed no state');
});

test('E2a bound denial re-renders the HX fragment in the stable swap target', async () => {
  clearFormBindings();
  const { t, deps, csrf } = await dispatchSetup();
  registerGenerated(GADGET_CREATE, 'create', 'e2a-create');
  const res = await handleOperationRequest(
    deps,
    opRequest({
      cookie: t.identity.cookie,
      csrf,
      htmx: true,
      body: JSON.stringify({
        operation_id: mintOperationId(),
        inputs: { title: 'w', price: '1.50', ids: ['a'], code: 'c', stock: 5 },
      }),
    }),
    'Shop.Gadget.create',
  );
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.ok(html.startsWith('<div id="e2a-create-form">'));
  assert.ok(!html.includes('<!DOCTYPE html>'), 'fragment has no document shell');
  assert.ok(html.includes('canonical digit strings'), 'checker message explains');
  assert.ok(html.includes('e2a-create-stock-error'), 'per-field outlet anchors');
  assert.equal(t.invoker.mutations.length, 0);
});

test('E2a rich drafts render; ill-typed drafts degrade per-field', async () => {
  const { t } = await dispatchSetup();
  const derived = deriveOperationInputs(LEDGER_CREATE);
  const binding = bindingFromDerived({
    derived,
    mode: 'create',
    action: '/api/operations/Ledger.Gadget.create',
    // Full generated fields, file slot included (F1 join): every field
    // below is ui's real generated widget for rich kinds.
    fields: generatedFields(derived, 'create'),
    submit: 'Save',
    idPrefix: 'e2a-rich',
    timeZone: 'UTC',
  });
  const context = buildPresentationContext({
    request: testRequest('/x', { headers: { 'accept-language': 'en' } }),
    pathname: '/x',
    isPartial: true,
    appDefaultLocale: 'en',
    csrfToken: 'csrf-1',
    principal: await testPrincipal(t.identity.store, t.identity.cookie),
    query: async () => ({ rows: [], columns: [] }),
  });
  const render = (draftInputs: ClosedInputs) =>
    renderFormError({
      error: buildBusinessError('validation', 'Check the highlighted fields.', {
        fields: [{ path: '/price', code: 'binding_mismatch', message: 'Check the highlighted fields.' }],
      }),
      draftInputs,
      operationId: 'op-rich',
      binding,
      context,
      fragment: true,
    });
  // Well-formed rich drafts render with the banner; nothing throws. The
  // money object draft flattens to its minor units plus the `__currency`
  // companion (R5) and both redisplay; the render still explains.
  const ok = await render({
    title: 'w',
    stock: '3',
    price: '1.50',
    fee: { minor: '100', currency: 'EUR' },
    whole: '2',
    delta: '-3',
  });
  assert.equal(ok.status, 400);
  assert.ok(ok.html.includes('Check the highlighted fields.'));
  assert.ok(ok.html.includes('inputs[price]'), 'rich field present');
  assert.ok(ok.html.includes('value="100"'), 'money minor redisplays');
  assert.ok(ok.html.includes('value="EUR"'), 'money currency redisplays');
  assert.ok(!ok.html.includes('    at '), 'no stack frames leak');
  // Ill-typed rich drafts degrade per-field; the render still explains.
  const degraded = await render({ title: 'w', price: 1.5, fee: 'nope', stock: 5 });
  assert.equal(degraded.status, 400);
  assert.ok(degraded.html.includes('Check the highlighted fields.'));
  assert.ok(!degraded.html.includes('    at '), 'no stack frames leak');
});

test('E2a file-field forms re-render with S7 file slots (F1 join)', async () => {
  // F1 delivered the file widget: the direct render carries the opaque
  // file-id draft into the slot's attached line — no render throw.
  const { t, deps, csrf } = await dispatchSetup();
  const derived = deriveOperationInputs(LEDGER_CREATE);
  const full = bindingFromDerived({
    derived,
    mode: 'create',
    action: '/api/operations/Ledger.Gadget.create',
    fields: generatedFields(derived, 'create'),
    submit: 'Save',
    idPrefix: 'e2a-file',
    timeZone: 'UTC',
  });
  const context = buildPresentationContext({
    request: testRequest('/x', { headers: { 'accept-language': 'en' } }),
    pathname: '/x',
    isPartial: true,
    appDefaultLocale: 'en',
    csrfToken: 'csrf-1',
    principal: await testPrincipal(t.identity.store, t.identity.cookie),
    query: async () => ({ rows: [], columns: [] }),
  });
  const rendered = await renderFormError({
    error: buildBusinessError('validation', 'Missing required input.'),
    draftInputs: { title: 'w', doc: 'file-1' },
    operationId: 'op-file',
    binding: full,
    context,
    fragment: true,
  });
  assert.equal(rendered.status, 400);
  assert.ok(rendered.html.includes('data-can-file="doc"'), 'picker slot renders');
  assert.ok(rendered.html.includes('Attached file'), 'attached line renders');
  assert.ok(rendered.html.includes('file-1'), 'file-id draft redisplays');
  // …and dispatch re-renders the missing-doc denial as HTML: never bare
  // JSON, never a 500.
  clearFormBindings();
  registerGenerated(LEDGER_CREATE, 'create', 'e2a-file');
  const res = await handleOperationRequest(
    deps,
    opRequest({
      cookie: t.identity.cookie,
      csrf,
      htmx: true,
      body: JSON.stringify({
        operation_id: mintOperationId(),
        inputs: { title: 'w', price: '1.50' },
      }),
    }),
    'Ledger.Gadget.create',
  );
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.ok(html.startsWith('<div id="e2a-file-form">'));
  assert.ok(html.includes('data-can-file="doc"'), 'empty slot re-renders');
  assert.ok(html.includes('doc'), 'denial names the missing input');
  assert.ok(!html.includes('    at '), 'no stack frames leak');
  assert.equal(t.invoker.mutations.length, 0);
});

test('E2a update error path: stale rich submit re-renders 409 with record and changes', async () => {
  clearFormBindings();
  const { store, t, deps, csrf } = await dispatchSetup();
  // Full generated fields, file slot included (F1 join): E's update path
  // renders with ui's real widgets throughout.
  registerGenerated(LEDGER_UPDATE, 'update', 'e2a-update');
  store.rows.set('g1', { id: 'g1', version: '1', fields: { title: 'seeded' } });
  const res = await handleOperationRequest(
    deps,
    opRequest({
      cookie: t.identity.cookie,
      csrf,
      htmx: true,
      body: JSON.stringify({
        operation_id: mintOperationId(),
        inputs: { record: { id: 'g1', version: '0' }, title: 'new', price: '9.99', stock: '4' },
      }),
    }),
    'Ledger.Gadget.update',
  );
  assert.equal(res.status, 409);
  const html = await res.text();
  assert.ok(html.startsWith('<div id="e2a-update-form">'));
  assert.ok(html.includes('Stale version.'));
  assert.ok(html.includes('name="inputs[record][id]" value="g1"'));
  assert.ok(html.includes('name="inputs[record][version]" value="0"'));
  assert.ok(html.includes('value="new"'), 'title draft redisplays');
  assert.ok(html.includes('9.99'), 'decimal draft redisplays');
  assert.equal(t.invoker.mutations.length, 1, 'conflict came from the invoker');
  assert.equal(store.rows.get('g1')?.version, '1', 'stale submit changed no state');
});

test('E2a round trip: projected rich submit dispatches really and stores verbatim', async () => {
  const { store, t, deps, csrf } = await dispatchSetup();
  const inputs = projectGeneratedInputs(deriveOperationInputs(GADGET_CREATE), 'create', {
    'inputs[title]': 'w',
    'inputs[price]': '1.50',
    'inputs[stock]': '3',
    'inputs[state]': 'submitted',
    'inputs[tags]': '["a","b"]',
    'inputs[ids]': '["a"]',
    'inputs[code]': 'c',
  });
  const res = await handleOperationRequest(
    deps,
    opRequest({
      cookie: t.identity.cookie,
      csrf,
      body: JSON.stringify({ operation_id: mintOperationId(), inputs }),
    }),
    'Shop.Gadget.create',
  );
  assert.equal(res.status, 200);
  assert.deepEqual(store.rows.get('s1')?.fields, {
    title: 'w',
    price: '1.50',
    stock: '3',
    state: 'submitted',
    tags: ['a', 'b'],
    ids: ['a'],
    code: 'c',
  });
});

test('E2a CSRF and session gate the derived path before dispatch', async () => {
  const { t, deps } = await dispatchSetup();
  const inputs = { title: 'w', price: '1.50', ids: ['a'], code: 'c' };
  const noCsrf = await handleOperationRequest(
    deps,
    opRequest({
      cookie: t.identity.cookie,
      body: JSON.stringify({ operation_id: mintOperationId(), inputs }),
    }),
    'Shop.Gadget.create',
  );
  assert.equal(noCsrf.status, 403);
  const noCsrfBody = (await noCsrf.json()) as { code: string; message: string };
  assert.equal(noCsrfBody.code, 'forbidden');
  assert.equal(noCsrfBody.message, 'Invalid or missing CSRF token.');
  const noSession = await handleOperationRequest(
    deps,
    opRequest({ body: JSON.stringify({ operation_id: mintOperationId(), inputs }) }),
    'Shop.Gadget.create',
  );
  assert.equal(noSession.status, 403);
  const noSessionBody = (await noSession.json()) as { code: string; message: string };
  assert.equal(noSessionBody.code, 'forbidden');
  assert.equal(noSessionBody.message, 'Authentication required.');
  assert.equal(t.invoker.mutations.length, 0, 'gated submits never invoked');
});

test('E2a JSON stays the default for bound denials with a binding registered', async () => {
  clearFormBindings();
  const { t, deps, csrf } = await dispatchSetup();
  registerGenerated(GADGET_CREATE, 'create', 'e2a-create');
  const res = await handleOperationRequest(
    deps,
    opRequest({
      cookie: t.identity.cookie,
      csrf,
      body: JSON.stringify({
        operation_id: mintOperationId(),
        inputs: { title: 'w', price: '1.50', ids: ['a'], code: 'c', state: 'DRAFT' },
      }),
    }),
    'Shop.Gadget.create',
  );
  assert.equal(res.status, 400);
  assert.ok((res.headers.get('content-type') ?? '').includes('application/json'));
  const body = (await res.json()) as {
    code: string;
    message: string;
    fields?: ReadonlyArray<{ path: string; code: string }>;
    retryable: boolean;
  };
  assert.equal(body.code, 'validation');
  assert.ok(body.message.includes('"draft", "submitted"'));
  assert.equal(body.fields?.[0]?.code, 'binding_mismatch');
  assert.equal(body.fields?.[0]?.path, '/state');
  assert.equal(body.retryable, false);
  assert.equal(t.invoker.mutations.length, 0);
});
