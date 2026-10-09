/**
 * T20a presentation-slice tests: pilot-scope real generated form dispatch.
 *
 * Grounding (no invented operations): the `*_OP` fixtures are the verbatim
 * T19a pilot emission — the six Shop ops plus the three Store ops pinned in
 * packages/interfaces/test/t19a-derivation.test.ts — and every dispatch
 * below runs through the REAL `handleOperationRequest` dispatcher with the
 * REAL T19a `catalogFromArtifactOperations` catalog. Forms render from the
 * REAL `deriveOperationInputs` derivation via the ui generated factories;
 * submits project through the REAL `projectGeneratedInputs` projection.
 * The only test seam is the L3 invoker: a stateful in-memory pilot store
 * with real create/update/version semantics (not canned responses), so
 * every submit observably changes state or denies with real rule meaning.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveCsrfToken, sha256HexText } from '@canlang/identity';
import type { IdentityStore } from '@canlang/identity';
import { ARTIFACT_VERSION } from '@canlang/contracts';
import type { ArtifactOperation } from '@canlang/contracts';
import type {
  ClosedInputs,
  ListQueryResult,
  MutationEnvelope,
  MutationResult,
  ResolvedIdentity,
  RowQueryRunner,
} from '@canlang/contracts';
import { DEFAULT_THEME } from '@canlang/contracts';
import type { MutationOutcome } from '../src/ports.js';
import { buildBusinessError } from '../src/errors/envelope.js';
import { UUID_V7_PATTERN, extractUuidV7Ms, validateOperationId } from '../src/envelope/validate.js';
import { deriveOperationInputs, catalogFromArtifactOperations } from '../src/http/operations.js';
import { handleOperationRequest } from '../src/http/operations.js';
import { createSourceFormBindings } from '../src/http/form-binding.js';
import { csrfTokenForSession, mintOperationId, resolveRequestIdentity } from '../src/http/context.js';
import { buildPresentationContext } from '../src/http/presentation.js';
import {
  applyDrafts,
  bindingFromDerived,
  clearFormBindings,
  formBindingFor,
  registerFormBinding,
  renderFormError,
  safeFormError,
} from '../src/http/formErrors.js';
import { createTestDeps, testRequest } from '../src/testing.js';
import {
  formFragmentWrap,
  generatedFields,
  generatedForm,
  form,
  projectGeneratedInputs,
} from '@canlang/ui';

/* Verbatim emission: Shop.review (scenario). */
const REVIEW_OP: ArtifactOperation = {
  "name": "Shop.review",
  "kind": "scenario",
  "description": "",
  "inputs": {"fields": [
    {"name": "notes", "field": {"kind": "string"}, "required": false, "array": {"required": false}},
    {"name": "limit", "field": {"kind": "integer"}, "required": false, "default": {"kind": "literal", "value": "10"}},
    {"name": "nick", "field": {"kind": "string"}, "required": false, "nullable": true},
  ]},
};

/* Verbatim emission: Shop.Gadget.create. */
const GADGET_CREATE_OP: ArtifactOperation = {
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

/* Verbatim emission: Shop.Gadget.update (partial, default-less). */
const GADGET_UPDATE_OP: ArtifactOperation = {
  "name": "Shop.Gadget.update",
  "kind": "update",
  "description": "",
  "inputs": {"fields": [
    {"name": "record", "field": {"kind": "ref", "model": "Shop.Gadget", "requireVersion": true}, "required": true},
    {"name": "title", "field": {"kind": "string"}, "required": false},
    {"name": "stock", "field": {"kind": "integer"}, "required": false},
    {"name": "price", "field": {"kind": "decimal"}, "required": false},
    {"name": "state", "field": {"kind": "enum", "values": ["draft", "submitted"]}, "required": false},
    {"name": "owner", "field": {"kind": "ref", "model": "Shop.Gadget", "requireVersion": true}, "required": false, "nullable": true},
    {"name": "tags", "field": {"kind": "string"}, "required": false, "array": {"required": false}},
    {"name": "ids", "field": {"kind": "string"}, "required": false, "array": {"required": true}},
    {"name": "code", "field": {"kind": "string"}, "required": false},
  ]},
};

/* Verbatim emission: Shop.Member.create (parent default + linkage). */
const MEMBER_CREATE_OP: ArtifactOperation = {
  "name": "Shop.Member.create",
  "kind": "create",
  "description": "",
  "inputs": {"fields": [
    {"name": "name", "field": {"kind": "string"}, "required": true},
    {"name": "buddy", "field": {"kind": "string"}, "required": false, "default": {"kind": "parent", "path": "owner"}},
    {"name": "parent", "field": {"kind": "ref", "model": "Shop.Team", "requireVersion": false}, "required": true},
  ]},
};

/* Verbatim emission: Shop.Member.update. */
const MEMBER_UPDATE_OP: ArtifactOperation = {
  "name": "Shop.Member.update",
  "kind": "update",
  "description": "",
  "inputs": {"fields": [
    {"name": "record", "field": {"kind": "ref", "model": "Shop.Member", "requireVersion": true}, "required": true},
    {"name": "name", "field": {"kind": "string"}, "required": false},
    {"name": "buddy", "field": {"kind": "string"}, "required": false},
  ]},
};

/* Verbatim emission: Shop.Gadget.read (empty inputs). */
const GADGET_READ_OP: ArtifactOperation = {
  "name": "Shop.Gadget.read",
  "kind": "read",
  "description": "",
  "inputs": {"fields": []},
};

/* Verbatim emission: committed compiled-shop.can fixture ops. */
const STORE_CREATE_OP: ArtifactOperation = {
  "name": "Store.Gadget.create",
  "kind": "create",
  "description": "",
  "inputs": {"fields": [
    {"name": "title", "field": {"kind": "string"}, "required": true},
  ]},
};
const STORE_UPDATE_OP: ArtifactOperation = {
  "name": "Store.Gadget.update",
  "kind": "update",
  "description": "",
  "inputs": {"fields": [
    {"name": "record", "field": {"kind": "ref", "model": "Store.Gadget", "requireVersion": true}, "required": true},
    {"name": "title", "field": {"kind": "string"}, "required": false},
  ]},
};
const STORE_READ_OP: ArtifactOperation = {
  "name": "Store.Gadget.read",
  "kind": "read",
  "description": "",
  "inputs": {"fields": []},
};

const PILOT_OPS: readonly ArtifactOperation[] = [
  REVIEW_OP,
  GADGET_CREATE_OP,
  GADGET_UPDATE_OP,
  MEMBER_CREATE_OP,
  MEMBER_UPDATE_OP,
  GADGET_READ_OP,
  STORE_CREATE_OP,
  STORE_UPDATE_OP,
  STORE_READ_OP,
];

/** One pilot row: the observable state submits change. */
interface PilotRow {
  readonly id: string;
  version: string;
  title: string;
}

/**
 * Stateful pilot-store invoker over `Store.Gadget.*` (+ a recording
 * `Shop.review` scenario): real insert/update/version-fencing semantics
 * with real rule meaning — blank titles are `validation`, the reserved
 * title is `rule_failed`, unknown ids are `not_found`, stale versions
 * are `conflict`. Field-error paths are wire-correct JSON Pointers into
 * the submitted (flat) inputs.
 */
function createPilotStore(): {
  readonly rows: Map<string, PilotRow>;
  readonly reviews: ClosedInputs[];
  readonly handlers: Record<string, (envelope: MutationEnvelope, identity: ResolvedIdentity) => MutationOutcome>;
} {
  const rows = new Map<string, PilotRow>();
  const reviews: ClosedInputs[] = [];
  let seq = 0;
  const committed = (operation_id: string, result: unknown): MutationOutcome => ({
    result: { status: 'committed', operation_id, result } satisfies MutationResult,
  });
  const titleError = (title: unknown): MutationOutcome | null => {
    if (typeof title !== 'string' || title === '') {
      const message = 'Title must not be blank.';
      return {
        error: buildBusinessError('validation', message, {
          fields: [{ path: '/title', code: 'blank', message }],
        }),
      };
    }
    if (title === 'banned') {
      return { error: buildBusinessError('rule_failed', 'That title is reserved.') };
    }
    return null;
  };
  return {
    rows,
    reviews,
    handlers: {
      'Store.Gadget.create': (envelope) => {
        const failed = titleError(envelope.inputs['title']);
        if (failed !== null) return failed;
        seq += 1;
        const id = `g${seq}`;
        rows.set(id, { id, version: '1', title: envelope.inputs['title'] as string });
        return committed(envelope.operation_id, { id, version: '1' });
      },
      'Store.Gadget.update': (envelope) => {
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
        if (Object.prototype.hasOwnProperty.call(envelope.inputs, 'title')) {
          const failed = titleError(envelope.inputs['title']);
          if (failed !== null) return failed;
          row.title = envelope.inputs['title'] as string;
        }
        row.version = String(Number(row.version) + 1);
        return committed(envelope.operation_id, { id: row.id, version: row.version });
      },
      'Shop.review': (envelope) => {
        reviews.push(envelope.inputs);
        return committed(envelope.operation_id, { ok: true });
      },
    },
  };
}

/** Row-query runner bound to one pilot store (the page-render `query`). */
function pilotQueryRunner(store: { readonly rows: Map<string, PilotRow> }): RowQueryRunner {
  return async (_invocation: unknown, model: string, _args): Promise<ListQueryResult> => {
    if (model !== 'Store.Gadget') throw buildBusinessError('not_found', 'Unknown model.');
    return {
      rows: [...store.rows.values()].map((row) => ({ id: row.id, version: row.version, fields: { title: row.title } })),
      columns: [{ field: 'title', label: 'Title', type: 'text' }],
    };
  };
}

function opRequest(opts: {
  cookie?: string;
  csrf?: string;
  contentType?: string;
  acceptHtml?: boolean;
  htmx?: boolean;
  body: string;
}): Request {
  const headers: Record<string, string> = { 'content-type': opts.contentType ?? 'application/json' };
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

/** Parse one hidden input value out of rendered form HTML. */
function hiddenValue(html: string, name: string): string | null {
  const match = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
  return match?.[1] ?? null;
}

/** Resolve the fixture identity for one cookie-carrying request, for real. */
async function testPrincipal(store: IdentityStore, cookie: string): Promise<ResolvedIdentity> {
  const { identity } = await resolveRequestIdentity(store, testRequest('/x', { cookie }));
  return identity;
}

test('generated ui fields map the REAL derivation for every formable pilot op', () => {
  assert.deepEqual(
    generatedFields(deriveOperationInputs(REVIEW_OP), 'scenario').map((f) => f.path),
    ['notes', 'limit', 'nick', 'nick__null'],
  );
  assert.deepEqual(
    generatedFields(deriveOperationInputs(GADGET_CREATE_OP), 'create').map((f) => f.path),
    ['title', 'stock', 'price', 'state', 'owner', 'owner__version', 'owner__null', 'tags', 'ids', 'code'],
  );
  assert.deepEqual(
    generatedFields(deriveOperationInputs(GADGET_UPDATE_OP), 'update').map((f) => f.path),
    ['title', 'stock', 'price', 'state', 'owner', 'owner__version', 'owner__null', 'tags', 'ids', 'code'],
  );
  assert.deepEqual(
    generatedFields(deriveOperationInputs(MEMBER_CREATE_OP), 'create').map((f) => f.path),
    ['name', 'buddy', 'parent'],
  );
  assert.deepEqual(
    generatedFields(deriveOperationInputs(MEMBER_UPDATE_OP), 'update').map((f) => f.path),
    ['name', 'buddy'],
  );
  assert.deepEqual(
    generatedFields(deriveOperationInputs(STORE_CREATE_OP), 'create').map((f) => f.path),
    ['title'],
  );
  assert.deepEqual(
    generatedFields(deriveOperationInputs(STORE_UPDATE_OP), 'update').map((f) => f.path),
    ['title'],
  );
  // The catalog serves the same derivation the forms generate from.
  const catalog = catalogFromArtifactOperations({ artifact_version: ARTIFACT_VERSION, operations: PILOT_OPS });
  for (const op of PILOT_OPS) {
    assert.deepEqual(catalog.derivedFor(op.name), deriveOperationInputs(op), op.name);
  }
});

test('source form preparation scopes typed controls and refuses unavailable bindings', async () => {
  const catalog = catalogFromArtifactOperations({ artifact_version: ARTIFACT_VERSION, operations: PILOT_OPS });
  const { deps, identity } = await createTestDeps();
  const { identity: principal } = await resolveRequestIdentity(deps.identity.store, testRequest('/forms', { cookie: identity.cookie }), { clock: deps.clock, teamId: identity.teamId });
  const csrfToken = await deriveCsrfToken(identity.sessionToken);
  const makeContext = () => buildPresentationContext({
    request: testRequest('/forms', { cookie: identity.cookie }), pathname: '/forms', isPartial: false,
    appDefaultLocale: 'en', csrfToken, principal,
    query: async () => ({ rows: [], columns: [] }), catalog, clock: deps.clock,
  });
  const context = makeContext();
  const prepare = context.prepareForm!;
  const first = await prepare({ operation: STORE_CREATE_OP.name, fields: ['title'], authoredFields: ['title'], labels: { title: 'Gadget title' }, submit: 'Publish', display: 'inline' });
  assert.equal(first.status, 'ready');
  if (first.status !== 'ready') throw new Error('expected the admitted unbound form');
  assert.deepEqual(first.derived, deriveOperationInputs(STORE_CREATE_OP));
  assert.equal(first.props.derived, first.derived);
  assert.equal(first.field('title').field.type, 'text');
  assert.equal(first.field('title').field.label, 'Gadget title');
  assert.equal(first.field('title').context.principal, principal);
  assert.equal(first.props.action, '/api/operations/Store.Gadget.create');
  assert.equal(first.props.timeZone, principal.team!.timezone);
  assert.equal(first.props.submit, 'Publish');
  assert.equal(first.props.display, 'inline');
  assert.equal(validateOperationId(first.props.operationId, deps.clock), null);
  const second = await prepare({ operation: STORE_CREATE_OP.name });
  assert.equal(second.status, 'ready');
  if (second.status !== 'ready') throw new Error('expected automatic form');
  assert.notEqual(second.props.idPrefix, first.props.idPrefix);
  assert.notEqual(second.props.operationId, first.props.operationId);
  assert.equal(second.props.display, 'drawer');
  assert.equal(first.props.idPrefix, 'operation-form-1');
  assert.equal(second.props.idPrefix, 'operation-form-2');
  const source = { operation: STORE_CREATE_OP.name, occurrence: 'page:/forms/view:1/row:é😀' };
  const stable = await prepare(source);
  const reordered = makeContext();
  await reordered.prepareForm!({ operation: STORE_CREATE_OP.name });
  const repeated = await reordered.prepareForm!(source);
  const sibling = await prepare({ ...source, occurrence: 'page:/forms/view:2/row:é😀' });
  assert.equal(stable.status, 'ready'); assert.equal(repeated.status, 'ready'); assert.equal(sibling.status, 'ready');
  if (stable.status !== 'ready' || repeated.status !== 'ready' || sibling.status !== 'ready') throw new Error('expected stable source forms');
  assert.equal(stable.props.idPrefix, repeated.props.idPrefix, 'source occurrence survives fresh request-local preparation');
  assert.match(stable.props.idPrefix, /^operation-form-source-[a-f0-9]+$/);
  assert.notEqual(stable.props.idPrefix, sibling.props.idPrefix);
  assert.equal(stable.field('title').idPrefix, stable.props.idPrefix);
  assert.notEqual(stable.props.operationId, repeated.props.operationId);
  for (const occurrence of ['', undefined, null, 1, '\uD800', '\uDC00']) {
    assert.throws(() => prepare({ ...source, occurrence } as Parameters<typeof prepare>[0]), TypeError);
  }
  assert.throws(() => first.field('other'), /outside/);
  assert.throws(() => prepare({ operation: STORE_CREATE_OP.name, fields: ['title', 'title'] }), /unique/);
  assert.throws(() => prepare({ operation: STORE_CREATE_OP.name, authoredFields: ['title', 'title'] }), /unique/);
  for (const request of [
    { operation: STORE_CREATE_OP.name, arguments: { title: 'protected' } },
    { operation: STORE_UPDATE_OP.name },
    { operation: STORE_CREATE_OP.name, authoredFields: [] },
    { operation: STORE_CREATE_OP.name, fields: [] },
    { operation: GADGET_CREATE_OP.name, authoredFields: ['title', 'stock', 'price', 'state', 'owner', 'tags', 'ids', 'code'] },
    { operation: 'Missing.create' },
  ]) assert.equal((await prepare(request)).status, 'unavailable');
});

test('protected source update submits only editable values and restores its exact record through HTTP', async () => {
  const calls: MutationEnvelope[] = [];
  const { deps, identity } = await createTestDeps({ mutations: {
    [STORE_UPDATE_OP.name]: envelope => {
      calls.push(envelope);
      return { result: { status: 'committed', operation_id: envelope.operation_id, result: null } };
    },
  } });
  const catalog = catalogFromArtifactOperations({ artifact_version: ARTIFACT_VERSION, operations: PILOT_OPS });
  const formBindings = await createSourceFormBindings(new Uint8Array(32).fill(93), 'source-update-revision');
  const session = await deps.identity.store.findSessionByTokenHash(await sha256HexText(identity.sessionToken));
  assert.ok(session);
  await deps.identity.store.setSessionTeam(session.session_id, identity.teamId);
  const csrf = await deriveCsrfToken(identity.sessionToken);
  const { identity: principal } = await resolveRequestIdentity(deps.identity.store,
    testRequest('/forms', { cookie: identity.cookie }), { clock: deps.clock, teamId: identity.teamId });
  const context = buildPresentationContext({ request: testRequest('/forms', { cookie: identity.cookie }),
    pathname: '/forms', isPartial: false, appDefaultLocale: 'en', csrfToken: csrf, principal,
    query: async () => ({ rows: [], columns: [] }), catalog, clock: deps.clock,
    formBindings, appId: deps.app.appId, sessionToken: identity.sessionToken,
  });
  const sourceRequest = { operation: STORE_UPDATE_OP.name, fields: ['title'], occurrence: 'page:/forms/form:1/row:g1',
    arguments: { record: { id: 'g1', version: 7n, title: 'Original', privateField: 'Never serialized' } } };
  const prepared = await context.prepareForm!(sourceRequest);
  assert.equal(prepared.status, 'ready');
  if (prepared.status !== 'ready') throw new Error('expected protected update');
  const repeated = await context.prepareForm!(sourceRequest);
  const sibling = await context.prepareForm!({ ...sourceRequest, occurrence: 'page:/forms/form:2/row:g1' });
  assert.equal(repeated.status, 'ready'); assert.equal(sibling.status, 'ready');
  if (repeated.status !== 'ready' || sibling.status !== 'ready') throw new Error('expected protected occurrences');
  assert.equal(repeated.props.idPrefix, prepared.props.idPrefix);
  assert.equal(repeated.props.sourceBindingIdentity, prepared.props.sourceBindingIdentity);
  assert.equal(repeated.props.sourceBindingDraftIdentity, prepared.props.sourceBindingDraftIdentity);
  assert.notEqual(repeated.props.sourceBinding, prepared.props.sourceBinding, 'each preparation still seals its fresh operation nonce');
  assert.notEqual(sibling.props.idPrefix, prepared.props.idPrefix);
  assert.notEqual(sibling.props.sourceBindingIdentity, prepared.props.sourceBindingIdentity);
  assert.notEqual(sibling.props.sourceBindingDraftIdentity, prepared.props.sourceBindingDraftIdentity);
  assert.equal(prepared.field('title').field.value, 'Original');
  assert.throws(() => prepared.field('record'), /outside/);
  const html = await form(prepared.props);
  assert.ok(html.includes('name="form_binding"'));
  assert.ok(!html.includes('inputs[record]'));
  assert.ok(!html.includes('Never serialized'));
  const inputs = projectGeneratedInputs(prepared.derived, 'update', { 'inputs[changes][title]': 'Edited' }, ['title']);
  assert.deepEqual(inputs, { title: 'Edited' });
  const protectedDeps = { ...deps, catalog, formBindings };
  const submit = (body: Record<string, unknown>, csrfValue = csrf) => handleOperationRequest(protectedDeps,
    testRequest('/forms', { method: 'POST', cookie: identity.cookie,
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfValue }, body: JSON.stringify(body) }), STORE_UPDATE_OP.name);
  const envelope = { operation: STORE_UPDATE_OP.name, operation_id: prepared.props.operationId,
    form_binding: prepared.props.sourceBinding, inputs };
  for (const invalid of [
    { ...envelope, form_binding: `${prepared.props.sourceBinding}x` },
    { ...envelope, operation_id: mintOperationId(deps.clock.nowMs()) },
    { ...envelope, inputs: { ...inputs, record: { id: 'other', version: '7' } } },
    { ...envelope, inputs: { ...inputs, unknown: 'extra' } },
  ]) assert.equal((await submit(invalid)).status, 403);
  assert.equal((await submit(envelope, 'bad-csrf')).status, 403);
  assert.equal(calls.length, 0, 'protection/CSRF refusal precedes canonical invocation');
  assert.equal((await submit(envelope)).status, 200);
  assert.equal(Object.getPrototypeOf(calls[0]!.inputs), null);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0]!.inputs)), { title: 'Edited', record: { id: 'g1', version: '7' } });
  assert.equal((await submit(envelope)).status, 200);
  assert.deepEqual(calls[1]!.inputs, calls[0]!.inputs, 'retry retains exact canonical inputs');
  const native = new URLSearchParams([...html.matchAll(/<input\b[^>]*name="([^"]*)"[^>]*value="([^"]*)"[^>]*>/g)]
    .map(match => [match[1]!, match[2]!]));
  native.set('inputs[changes][title]', 'Native edit');
  const nativeSubmit = (fields: URLSearchParams) => handleOperationRequest(protectedDeps,
    testRequest('/forms', { method: 'POST', cookie: identity.cookie,
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: fields.toString() }), STORE_UPDATE_OP.name);
  assert.equal((await nativeSubmit(native)).status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[2]!.inputs)), { title: 'Native edit', record: { id: 'g1', version: '7' } });
  const override = new URLSearchParams(native); override.set('inputs[record][id]', 'other');
  assert.equal((await nativeSubmit(override)).status, 403);
  assert.equal(calls.length, 3, 'native source bindings retain protected-ref refusal');
});

test('bindingFromDerived pins the operation and checks mode agreement', () => {
  clearFormBindings();
  const derived = deriveOperationInputs(STORE_CREATE_OP);
  const binding = bindingFromDerived({
    derived,
    mode: 'create',
    action: '/api/operations/Store.Gadget.create',
    fields: generatedFields(derived, 'create'),
    submit: 'Create',
    idPrefix: 't20a-create',
    timeZone: 'UTC',
  });
  assert.equal(binding.operation, 'Store.Gadget.create');
  assert.equal(binding.mode, 'create');
  assert.deepEqual(binding.fields.map((f) => f.path), ['title']);
  registerFormBinding(binding);
  assert.equal(formBindingFor('Store.Gadget.create'), binding);
  assert.equal(formBindingFor('Store.nope'), undefined);
  clearFormBindings();
  assert.equal(formBindingFor('Store.Gadget.create'), undefined);

  assert.throws(
    () => bindingFromDerived({
      derived, mode: 'update', action: '/x', fields: [], submit: 'x', idPrefix: 'x', timeZone: 'UTC',
    }),
    /does not agree/,
  );
  assert.throws(
    () => bindingFromDerived({
      derived: deriveOperationInputs(STORE_READ_OP), mode: 'create', action: '/x', fields: [], submit: 'x', idPrefix: 'x', timeZone: 'UTC',
    }),
    /read\/delete derivations have no generated form/,
  );
});

test('safeFormError keeps safe envelopes and fails closed on garbage', () => {
  const valid = buildBusinessError('validation', 'Bad title.', {
    operation_id: 'op-1',
    fields: [{ path: '/title', code: 'blank', message: 'Bad title.' }],
    retryable: false,
  });
  assert.deepEqual(safeFormError(valid), valid);

  // Unknown codes fail closed to the generic rule_failed envelope.
  const unknownCode = { code: 'exploded', message: 'boom\n    at evil (x.js:1:1)' } as unknown as Parameters<typeof safeFormError>[0];
  const closed = safeFormError(unknownCode);
  assert.equal(closed.code, 'rule_failed');
  assert.ok(!closed.message.includes('evil'));
  assert.equal(closed.fields, undefined);
  assert.equal(closed.retryable, false);

  // Non-string messages become the generic safe text for the code.
  const badMessage = { code: 'conflict', message: { leak: 'secret' } } as unknown as Parameters<typeof safeFormError>[0];
  const conflicted = safeFormError(badMessage);
  assert.equal(conflicted.code, 'conflict');
  assert.ok(!conflicted.message.includes('secret'));

  // Malformed field entries drop; well-shaped entries keep strings only.
  const badFields = {
    code: 'validation',
    message: 'Bad.',
    fields: [
      { path: '/title', code: 'blank', message: 'Bad.', extra: 'dropped' },
      { path: '/x', code: 7, message: 'nope' },
      'junk',
      null,
    ],
  } as unknown as Parameters<typeof safeFormError>[0];
  assert.deepEqual(safeFormError(badFields).fields, [
    { path: '/title', code: 'blank', message: 'Bad.' },
  ]);
  const nonArray = { code: 'validation', message: 'Bad.', fields: 'junk' } as unknown as Parameters<typeof safeFormError>[0];
  assert.equal(safeFormError(nonArray).fields, undefined);

  // Well-typed members pass through; mistyped ones normalize.
  const passthrough = safeFormError(buildBusinessError('busy', 'Wait.', { operation_id: 'op-9' }));
  assert.equal(passthrough.operation_id, 'op-9');
  assert.equal(passthrough.retryable, true);
  const mistyped = { code: 'busy', message: 'Wait.', operation_id: 7, retryable: 'yes' } as unknown as Parameters<typeof safeFormError>[0];
  const normalized = safeFormError(mistyped);
  assert.equal(normalized.operation_id, undefined);
  assert.equal(normalized.retryable, true);
});

test('validation re-renders per-field errors with drafts through the generated binding', async () => {
  clearFormBindings();
  const t = await createTestDeps({});
  const derived = deriveOperationInputs(STORE_CREATE_OP);
  const binding = bindingFromDerived({
    derived,
    mode: 'create',
    action: '/api/operations/Store.Gadget.create',
    fields: generatedFields(derived, 'create'),
    submit: 'Create',
    idPrefix: 't20a-create',
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
    error: buildBusinessError('validation', "Missing required input 'title'.", {
      fields: [{ path: '/title', code: 'required', message: "Missing required input 'title'." }],
    }),
    draftInputs: { title: 'wre' },
    operationId: 'op-draft',
    binding,
    context,
    fragment: true,
  });
  assert.equal(rendered.status, 400);
  assert.ok(rendered.html.startsWith('<div id="t20a-create-form">'));
  // The ui fragment helper pins the identical swap-target shape, so the
  // initial partial and the error re-render morph one stable node.
  assert.equal(formFragmentWrap('t20a-create', 'INNER'), '<div id="t20a-create-form">INNER</div>');
  assert.ok(rendered.html.includes('value="wre"'), 'draft redisplays');
  assert.ok(rendered.html.includes('Missing required input'), 'banner explains');
  assert.ok(rendered.html.includes('t20a-create-title-error'), 'per-field outlet anchors');
});

test('conflict re-renders the update form with the banner and the submitted record', async () => {
  const t = await createTestDeps({});
  const derived = deriveOperationInputs(STORE_UPDATE_OP);
  const binding = bindingFromDerived({
    derived,
    mode: 'update',
    action: '/api/operations/Store.Gadget.update',
    fields: generatedFields(derived, 'update'),
    submit: 'Save',
    idPrefix: 't20a-update',
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
    error: buildBusinessError('conflict', 'Stale version.', {
      fields: [{ path: '/record/version', code: 'stale', message: 'Stale version.' }],
    }),
    draftInputs: { record: { id: 'g1', version: '1' }, title: 'new title' },
    operationId: 'op-stale',
    binding,
    context,
    fragment: true,
  });
  assert.equal(rendered.status, 409);
  // The record pointer matches no visible field, so the banner carries
  // it — nothing is dropped.
  assert.ok(rendered.html.includes('Stale version.'));
  assert.ok(rendered.html.includes('name="inputs[record][id]" value="g1"'));
  assert.ok(rendered.html.includes('name="inputs[record][version]" value="1"'));
  assert.ok(rendered.html.includes('value="new title"'), 'title draft redisplays');
});

test('business denials re-render full-page with safe messages only', async () => {
  const t = await createTestDeps({});
  const derived = deriveOperationInputs(STORE_CREATE_OP);
  const binding = bindingFromDerived({
    derived,
    mode: 'create',
    action: '/api/operations/Store.Gadget.create',
    fields: generatedFields(derived, 'create'),
    submit: 'Create',
    idPrefix: 't20a-create',
    timeZone: 'UTC',
  });
  const context = buildPresentationContext({
    request: testRequest('/x'),
    pathname: '/x',
    isPartial: false,
    appDefaultLocale: 'en',
    csrfToken: 'csrf-1',
    principal: await testPrincipal(t.identity.store, t.identity.cookie),
    query: async () => ({ rows: [], columns: [] }),
  });
  const rendered = await renderFormError({
    error: buildBusinessError('rule_failed', 'That title is reserved.'),
    draftInputs: { title: 'banned' },
    operationId: 'op-denied',
    binding,
    context,
    fragment: false,
  });
  assert.equal(rendered.status, 422);
  assert.ok(rendered.html.startsWith('<!DOCTYPE html>'));
  assert.ok(rendered.html.includes('<title>That title is reserved.</title>'));
  assert.ok(rendered.html.includes('value="banned"'));
  assert.ok(!rendered.html.includes('    at '), 'no stack frames leak into markup');

  // Garbage denials render the generic envelope with a defined status.
  const garbage = await renderFormError({
    error: { code: 'exploded', message: { leak: 'x' } } as unknown as Parameters<typeof renderFormError>[0]['error'],
    draftInputs: {},
    operationId: '',
    binding,
    context,
    fragment: true,
  });
  assert.equal(typeof garbage.status, 'number');
  assert.equal(garbage.status, 422);
  assert.ok(!garbage.html.includes('exploded'));
  assert.ok(!garbage.html.includes('leak'));
});

test('ref-object drafts carry onto generated companions in the re-render', async () => {
  const t = await createTestDeps({});
  // Object-valued drafts (a composed `{id, version}` ref) flatten onto
  // the generated id + `__version` companions (R5: generatedDraftValues),
  // so the ref draft redisplays while the inline error still explains.
  const fields = generatedFields(deriveOperationInputs(GADGET_UPDATE_OP), 'update');
  const applied = applyDrafts(fields, 'update', { record: { id: 'g1', version: '3' }, changes: { title: 't' } });
  assert.equal(applied.find((f) => f.path === 'title')?.value, 't');
  const binding = bindingFromDerived({
    derived: deriveOperationInputs(GADGET_UPDATE_OP),
    mode: 'update',
    action: '/api/operations/Shop.Gadget.update',
    fields,
    submit: 'Save',
    idPrefix: 't20a-gadget',
    timeZone: 'UTC',
  });
  const context = buildPresentationContext({
    request: testRequest('/x'),
    pathname: '/x',
    isPartial: true,
    appDefaultLocale: 'en',
    csrfToken: 'csrf-1',
    principal: await testPrincipal(t.identity.store, t.identity.cookie),
    query: async () => ({ rows: [], columns: [] }),
  });
  const rendered = await renderFormError({
    error: buildBusinessError('validation', 'Bad owner.', {
      fields: [{ path: '/owner', code: 'unknown', message: 'Bad owner.' }],
    }),
    draftInputs: { record: { id: 'g1', version: '3' }, owner: { id: 'o9', version: '2' } },
    operationId: 'op-ref',
    binding,
    context,
    fragment: true,
  });
  assert.equal(rendered.status, 400);
  assert.ok(rendered.html.includes('Bad owner.'));
  assert.ok(rendered.html.includes('value="o9"'), 'ref id draft redisplays');
  assert.ok(rendered.html.includes('value="2"'), 'ref version draft redisplays');
});

test('csrfTokenForSession covers pages and mintOperationId mints canonical ids', async () => {
  const t = await createTestDeps({});
  assert.equal(await csrfTokenForSession(null), '');
  const token = await csrfTokenForSession(t.identity.sessionToken);
  assert.equal(token, await deriveCsrfToken(t.identity.sessionToken));
  assert.ok(token.length > 0);

  const first = mintOperationId();
  const second = mintOperationId();
  assert.notEqual(first, second);
  assert.ok(UUID_V7_PATTERN.test(first), first);
  assert.equal(validateOperationId(first), null);
  assert.equal(validateOperationId('not-an-id')?.code, 'validation');
  const atMs = Date.now() - 1000;
  const minted = mintOperationId(atMs);
  assert.equal(extractUuidV7Ms(minted), atMs);
  const seen = new Set<string>();
  for (let i = 0; i < 100; i += 1) seen.add(mintOperationId());
  assert.equal(seen.size, 100);
});

test('round trip: generated create form dispatches really and changes state', async () => {
  clearFormBindings();
  const store = createPilotStore();
  const t = await createTestDeps({ mutations: store.handlers });
  const catalog = catalogFromArtifactOperations({ artifact_version: ARTIFACT_VERSION, operations: PILOT_OPS });
  const deps = { ...t.deps, catalog };
  const derived = deriveOperationInputs(STORE_CREATE_OP);
  registerFormBinding(bindingFromDerived({
    derived,
    mode: 'create',
    action: '/api/operations/Store.Gadget.create',
    fields: generatedFields(derived, 'create'),
    submit: 'Create',
    idPrefix: 't20a-create',
    timeZone: 'UTC',
  }));

  // Page GET: resolve identity, cover CSRF, build context, render.
  const getRequest = testRequest('/gadgets/new', {
    cookie: t.identity.cookie,
    headers: { 'accept-language': 'nl, en;q=0.9' },
  });
  const { identity, sessionToken } = await resolveRequestIdentity(t.identity.store, getRequest);
  assert.ok(sessionToken !== null);
  const csrfToken = await csrfTokenForSession(sessionToken);
  const context = buildPresentationContext({
    request: getRequest,
    pathname: '/gadgets/new',
    isPartial: false,
    appDefaultLocale: deps.app.appDefaultLocale,
    csrfToken,
    principal: identity,
    query: pilotQueryRunner(store),
  });
  assert.deepEqual(context.preferredLocales, ['nl', 'en']);
  assert.equal(context.theme, DEFAULT_THEME);
  const operationId = mintOperationId();
  const html = await generatedForm({
    context,
    action: '/api/operations/Store.Gadget.create',
    derived,
    mode: 'create',
    operationId,
    timeZone: 'UTC',
    submit: 'Create',
    idPrefix: 't20a-create',
  });

  // The rendered form carries real dispatch material.
  assert.equal(hiddenValue(html, 'operation'), 'Store.Gadget.create');
  assert.equal(hiddenValue(html, 'operation_id'), operationId);
  assert.equal(hiddenValue(html, '_csrf'), csrfToken);
  assert.equal(hiddenValue(html, 'timezone'), 'UTC');
  assert.ok(html.includes('name="inputs[title]"'));

  // Submit the projected envelope as JSON through the real dispatcher.
  const inputs = projectGeneratedInputs(derived, 'create', {
    operation: 'Store.Gadget.create',
    operation_id: operationId,
    _csrf: csrfToken,
    timezone: 'UTC',
    'inputs[title]': 'wrench',
  });
  assert.deepEqual(inputs, { title: 'wrench' });
  const res = await handleOperationRequest(
    deps,
    opRequest({ cookie: t.identity.cookie, csrf: csrfToken, body: JSON.stringify({ operation_id: operationId, inputs }) }),
    'Store.Gadget.create',
  );
  assert.equal(res.status, 200);
  const payload = (await res.json()) as { status: string; operation_id: string; result: { id: string; version: string } };
  assert.equal(payload.status, 'committed');
  assert.equal(payload.operation_id, operationId);
  const row = store.rows.get(payload.result.id);
  assert.ok(row !== undefined, 'state changed: the row exists');
  assert.equal(row.title, 'wrench');
  assert.equal(row.version, '1');
  const call = t.invoker.mutations.at(-1);
  assert.ok(call !== undefined);
  assert.equal(call.identity.actor?.user_id, t.identity.userId);
  assert.equal(call.identity.binding.kind, 'session');

  // The same projection submits form-encoded (`inputs` as JSON text).
  const operationId2 = mintOperationId();
  const formBody = new URLSearchParams({
    operation_id: operationId2,
    inputs: JSON.stringify({ title: 'hammer' }),
    _csrf: csrfToken,
  });
  const formRes = await handleOperationRequest(
    deps,
    opRequest({ cookie: t.identity.cookie, contentType: 'application/x-www-form-urlencoded', body: formBody.toString() }),
    'Store.Gadget.create',
  );
  assert.equal(formRes.status, 200);
  assert.equal(store.rows.size, 2);
});

test('round trip: generated update form versions really; stale submits re-render', async () => {
  clearFormBindings();
  const store = createPilotStore();
  const t = await createTestDeps({ mutations: store.handlers });
  const catalog = catalogFromArtifactOperations({ artifact_version: ARTIFACT_VERSION, operations: PILOT_OPS });
  const deps = { ...t.deps, catalog };
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const derived = deriveOperationInputs(STORE_UPDATE_OP);
  registerFormBinding(bindingFromDerived({
    derived,
    mode: 'update',
    action: '/api/operations/Store.Gadget.update',
    fields: generatedFields(derived, 'update'),
    submit: 'Save',
    idPrefix: 't20a-update',
    timeZone: 'UTC',
  }));

  // Seed one row through the real dispatcher.
  const seedRes = await handleOperationRequest(
    deps,
    opRequest({ cookie: t.identity.cookie, csrf, body: JSON.stringify({ operation_id: mintOperationId(), inputs: { title: 'v1' } }) }),
    'Store.Gadget.create',
  );
  assert.equal(seedRes.status, 200);
  const seed = (await seedRes.json()) as { result: { id: string; version: string } };
  assert.equal(store.rows.get(seed.result.id)?.version, '1');

  // Fresh update renders the bound record and commits a new version.
  const context = buildPresentationContext({
    request: testRequest('/gadgets/g1/edit', { cookie: t.identity.cookie }),
    pathname: '/gadgets/g1/edit',
    isPartial: true,
    appDefaultLocale: 'en',
    csrfToken: csrf,
    principal: await testPrincipal(t.identity.store, t.identity.cookie),
    query: pilotQueryRunner(store),
  });
  const editHtml = await generatedForm({
    context,
    action: '/api/operations/Store.Gadget.update',
    derived,
    mode: 'update',
    operationId: mintOperationId(),
    record: { id: seed.result.id, version: '1' },
    timeZone: 'UTC',
    submit: 'Save',
    idPrefix: 't20a-update',
  });
  assert.ok(editHtml.includes(`value="${seed.result.id}"`));
  const okInputs = projectGeneratedInputs(derived, 'update', {
    'inputs[record][id]': seed.result.id,
    'inputs[record][version]': '1',
    'inputs[changes][title]': 'v2',
  });
  assert.deepEqual(okInputs, { record: { id: seed.result.id, version: '1' }, title: 'v2' });
  const okRes = await handleOperationRequest(
    deps,
    opRequest({ cookie: t.identity.cookie, csrf, body: JSON.stringify({ operation_id: mintOperationId(), inputs: okInputs }) }),
    'Store.Gadget.update',
  );
  assert.equal(okRes.status, 200);
  assert.equal(store.rows.get(seed.result.id)?.title, 'v2');
  assert.equal(store.rows.get(seed.result.id)?.version, '2');

  // A stale submit re-renders the form as an HTML fragment (HTMX path).
  const staleInputs = { record: { id: seed.result.id, version: '1' }, title: 'stale-write' };
  const staleRes = await handleOperationRequest(
    deps,
    opRequest({
      cookie: t.identity.cookie,
      csrf,
      htmx: true,
      body: JSON.stringify({ operation_id: mintOperationId(), inputs: staleInputs }),
    }),
    'Store.Gadget.update',
  );
  assert.equal(staleRes.status, 409);
  assert.ok((staleRes.headers.get('content-type') ?? '').includes('text/html'));
  const staleHtml = await staleRes.text();
  assert.ok(staleHtml.includes('<div id="t20a-update-form">'));
  assert.ok(staleHtml.includes('Stale version.'));
  assert.ok(staleHtml.includes('value="stale-write"'), 'draft preserved');
  assert.ok(staleHtml.includes('name="inputs[record][version]" value="1"'), 'submitted record preserved');
  assert.equal(store.rows.get(seed.result.id)?.title, 'v2', 'stale write changed nothing');

  // Without HTML headers the same denial stays bare JSON.
  const jsonRes = await handleOperationRequest(
    deps,
    opRequest({ cookie: t.identity.cookie, csrf, body: JSON.stringify({ operation_id: mintOperationId(), inputs: staleInputs }) }),
    'Store.Gadget.update',
  );
  assert.equal(jsonRes.status, 409);
  assert.equal((await jsonRes.json() as { code: string }).code, 'conflict');
});

test('CSRF and session are enforced before any generated submit dispatches', async () => {
  clearFormBindings();
  const store = createPilotStore();
  const t = await createTestDeps({ mutations: store.handlers });
  const catalog = catalogFromArtifactOperations({ artifact_version: ARTIFACT_VERSION, operations: PILOT_OPS });
  const deps = { ...t.deps, catalog };
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const body = JSON.stringify({ operation_id: mintOperationId(), inputs: { title: 'x' } });

  // Missing CSRF.
  const noCsrf = await handleOperationRequest(
    deps,
    opRequest({ cookie: t.identity.cookie, body }),
    'Store.Gadget.create',
  );
  assert.equal(noCsrf.status, 403);
  // Tampered CSRF.
  const badCsrf = await handleOperationRequest(
    deps,
    opRequest({ cookie: t.identity.cookie, csrf: `${csrf}x`, body }),
    'Store.Gadget.create',
  );
  assert.equal(badCsrf.status, 403);
  // Anonymous POST: no session, no dispatch.
  const anon = await handleOperationRequest(deps, opRequest({ csrf, body }), 'Store.Gadget.create');
  assert.equal(anon.status, 403);
  assert.equal((await anon.json() as { message: string }).message, 'Authentication required.');
  assert.equal(t.invoker.mutations.length, 0, 'no denied submit invoked');
  assert.equal(store.rows.size, 0, 'no denied submit changed state');
});

test('framing and business denials re-render with safe messages via dispatch', async () => {
  clearFormBindings();
  const store = createPilotStore();
  const t = await createTestDeps({ mutations: store.handlers });
  const catalog = catalogFromArtifactOperations({ artifact_version: ARTIFACT_VERSION, operations: PILOT_OPS });
  const deps = { ...t.deps, catalog };
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const derived = deriveOperationInputs(STORE_CREATE_OP);
  registerFormBinding(bindingFromDerived({
    derived,
    mode: 'create',
    action: '/api/operations/Store.Gadget.create',
    fields: generatedFields(derived, 'create'),
    submit: 'Create',
    idPrefix: 't20a-create',
    timeZone: 'UTC',
  }));

  // Missing required input: 400 fragment with the per-field error.
  const missing = await handleOperationRequest(
    deps,
    opRequest({
      cookie: t.identity.cookie,
      csrf,
      acceptHtml: true,
      body: JSON.stringify({ operation_id: mintOperationId(), inputs: {} }),
    }),
    'Store.Gadget.create',
  );
  assert.equal(missing.status, 400);
  const missingHtml = await missing.text();
  // Accept:text/html without HX-Request re-renders the full minimal doc.
  assert.ok(missingHtml.startsWith('<!DOCTYPE html>'));
  assert.ok(missingHtml.includes("Missing required input &#39;title&#39;."), 'safe message renders escaped');
  assert.ok(missingHtml.includes('t20a-create-title-error'));

  // Unknown member: 400 fragment naming the smuggled input.
  const smuggled = await handleOperationRequest(
    deps,
    opRequest({
      cookie: t.identity.cookie,
      csrf,
      htmx: true,
      body: JSON.stringify({ operation_id: mintOperationId(), inputs: { title: 'x', by: 'mallory' } }),
    }),
    'Store.Gadget.create',
  );
  assert.equal(smuggled.status, 400);
  assert.ok((await smuggled.text()).includes('Unknown input'));

  // Business rule: 422 fragment with exactly the authored message.
  const denied = await handleOperationRequest(
    deps,
    opRequest({
      cookie: t.identity.cookie,
      csrf,
      htmx: true,
      body: JSON.stringify({ operation_id: mintOperationId(), inputs: { title: 'banned' } }),
    }),
    'Store.Gadget.create',
  );
  assert.equal(denied.status, 422);
  const deniedHtml = await denied.text();
  assert.ok(deniedHtml.includes('That title is reserved.'));
  assert.ok(deniedHtml.includes('value="banned"'), 'draft preserved');
  assert.ok(!deniedHtml.includes('    at '), 'no stack frames leak');
  assert.equal(t.invoker.mutations.length, 1, 'only the business submit invoked');
  assert.equal(store.rows.size, 0, 'no denied submit changed state');
});

test('native bracket fields project through the owning catalog and refuse extras', async () => {
  const store = createPilotStore();
  const t = await createTestDeps({ mutations: store.handlers });
  const catalog = catalogFromArtifactOperations({ artifact_version: ARTIFACT_VERSION, operations: PILOT_OPS });
  const deps = { ...t.deps, catalog };
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const soup = new URLSearchParams({
    operation_id: mintOperationId(),
    'inputs[title]': 'wrench',
    _csrf: csrf,
  });
  const res = await handleOperationRequest(
    deps,
    opRequest({ cookie: t.identity.cookie, contentType: 'application/x-www-form-urlencoded', body: soup.toString() }),
    'Store.Gadget.create',
  );
  assert.equal(res.status, 200);
  assert.deepEqual(t.invoker.mutations[0]!.envelope.inputs, { title: 'wrench' });
  soup.set('inputs[undeclared]', 'extra');
  const refused = await handleOperationRequest(deps,
    opRequest({ cookie: t.identity.cookie, contentType: 'application/x-www-form-urlencoded', body: soup.toString() }),
    'Store.Gadget.create');
  assert.equal(refused.status, 400);
  assert.equal(t.invoker.mutations.length, 1);
});

test('scenario submits dispatch with projected arrays and defaults omitted', async () => {
  clearFormBindings();
  const store = createPilotStore();
  const t = await createTestDeps({ mutations: store.handlers });
  const catalog = catalogFromArtifactOperations({ artifact_version: ARTIFACT_VERSION, operations: PILOT_OPS });
  const deps = { ...t.deps, catalog };
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const derived = deriveOperationInputs(REVIEW_OP);
  const inputs = projectGeneratedInputs(derived, 'scenario', {
    'inputs[notes]': '["a","b"]',
    'inputs[limit]': '',
    'inputs[nick]': 'Al',
  });
  assert.deepEqual(inputs, { notes: ['a', 'b'], nick: 'Al' });
  const res = await handleOperationRequest(
    deps,
    opRequest({ cookie: t.identity.cookie, csrf, body: JSON.stringify({ operation_id: mintOperationId(), inputs }) }),
    'Shop.review',
  );
  assert.equal(res.status, 200);
  assert.equal(store.reviews.length, 1);
  assert.deepEqual(store.reviews[0], { notes: ['a', 'b'], nick: 'Al' });
});

test('page context carries identity, query, and metadata through the pilot', async () => {
  const store = createPilotStore();
  store.rows.set('g1', { id: 'g1', version: '1', title: 'seeded' });
  const t = await createTestDeps({ mutations: store.handlers });
  const getRequest = testRequest('/gadgets', { cookie: t.identity.cookie });
  const { identity } = await resolveRequestIdentity(t.identity.store, getRequest);
  const context = buildPresentationContext({
    request: getRequest,
    pathname: '/gadgets',
    isPartial: false,
    appDefaultLocale: 'en',
    csrfToken: await csrfTokenForSession(t.identity.sessionToken),
    principal: identity,
    query: pilotQueryRunner(store),
  });
  // Identity carries by reference; the query runner reads live state.
  assert.equal(context.principal, identity);
  assert.equal(context.invocation, identity);
  const listed = await context.query(context.invocation, 'Store.Gadget', { limit: 10 });
  assert.deepEqual(listed.rows, [{ id: 'g1', version: '1', fields: { title: 'seeded' } }]);
  assert.equal(context.path, '/gadgets');
  assert.equal(context.isPartial, false);
  assert.equal(context.appDefaultLocale, 'en');
});
