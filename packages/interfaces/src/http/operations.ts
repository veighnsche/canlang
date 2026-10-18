/**
 * HTTP dispatch for canonical mutation operations (S4).
 *
 * URL naming: the operation NAME comes from the route
 * (`/api/operations/<name>`, routed by `http/routes.ts`); the body carries
 * `operation_id` + `inputs`.
 * When the body also carries `operation` it MUST equal the route name —
 * mismatch is `validation`, so a misrouted envelope can never invoke a
 * different operation than the URL names.
 *
 * Authentication rule (lane-06 authored): EVERY operation POST requires a
 * session, including `by=public` operations. An unauthenticated POST has no
 * CSRF protection, so anonymous mutations are never accepted over HTTP —
 * public callers read through page GETs, and MCP tool calls authenticate via
 * grants instead. Public (no-cookie) POSTs are rejected `forbidden`
 * 'Authentication required.'.
 *
 * Form transport: legacy structured members travel as JSON text
 * (`inputs={"qty":2}`). Native bracket controls are projected using the
 * owning operation declarations, preserving exact ref and scalar strings;
 * duplicate, mixed or undeclared controls refuse before invocation.
 * The `_csrf` field is transport-level: it is consumed
 * for the CSRF check and stripped before the closed-inputs check and
 * invocation, never a business input. The field is read from `inputs` first
 * (the canonical location, e.g. JSON bodies) with fallback to the top-level
 * body (the natural location for a flat HTML form's hidden field); both must
 * still verify against the session token.
 */
import { ARTIFACT_VERSION } from '@canlang/contracts';
import type {
  ArtifactOperation,
  BusinessError,
  FormRetry,
  ClosedInputs,
  DerivedOperationInputs,
  DerivedWritableInput,
  MutationEnvelope,
  ResolvedIdentity,
} from '@canlang/contracts';
import { IdentityError, assertCredentialLive, deriveCsrfToken, sha256HexText } from '@canlang/identity';
import { SOURCE_FORM_BINDING_FIELD } from '@canlang/contracts';
import { NATIVE_BOOLEAN_PRESENCE_PREFIX, projectGeneratedInputs } from '@canlang/ui';
export { createSourceFormBindings } from './form-binding.js';
import type { HttpDeps, OperationInputShape, SchemaCatalog } from '../ports.js';
import { checkArtifactOperation, checkArtifactOperations, checkBoundArguments, isDeliveryField } from '../mcp/schemas.js';
import type {
  ArtifactOperationSlice,
  CheckedArtifactDeliveryField,
  CheckedArtifactField,
  CheckedArtifactInput,
  CheckedArtifactOperation,
} from '../mcp/schemas.js';
import { buildBusinessError, fromUnknown, toHttpResponse } from '../errors/envelope.js';
import { logBusinessError, logInternalError } from '../errors/logging.js';
import { isBusinessErrorCode } from '../errors/safe.js';
import { checkClosedInputs, validateOperationId, validateOperationIdShape } from '../envelope/validate.js';
import {
  CSRF_FIELD,
  CSRF_HEADER,
  assertPostCsrf,
  caughtToBusinessError,
  jsonErrorResponse,
  mintOperationId,
  resolveRequestIdentity,
} from './context.js';
import { formBindingFor, renderFormError, wantsHtmlRerender } from './formErrors.js';
import { isPartialRequest } from './fragments.js';
import { FORM_BODY_MAX_BYTES, JSON_BODY_MAX_BYTES, readCappedBody } from './limits.js';
import { OwnedInputError, type OwnedJsonToken, ownedOperationFrame, parseOwnedJsonBody, readOwnedJson } from '@canlang/values/bindings/owned-input';
import { resolveDeferredValidation } from '@canlang/values/bindings/validation';
import { assertSourceValidationCurrent, assertSourceValidationStable, closeSourceValidationCatalog, runSourceHttpPlan } from './prepared-validation.js';
export { createSourceValidationCatalog, wrapCatalogWithOwnedValidation } from './prepared-validation.js';
/** Same installed/bundled owner codec used by the verified source adapter. */
export { encodeServingLiteral } from '@canlang/values/bindings/serving-validation';
import { buildPresentationContext } from './presentation.js';
import { handleInputChoiceRequest } from './input-choices.js';

/**
 * Operation-name shape: 2-3 source identifier segments (e.g. `shop.Order.create`,
 * `shop.release_skipped`, `system.team.invite`). Preserve the compiler's
 * underscore vocabulary in every segment. Anything else is `not_found` — the
 * name never reaches the catalog, so malformed names cannot probe it.
 */
export const OPERATION_NAME_PATTERN =
  /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){1,2}$/;

const JSON_CONTENT_TYPE = 'application/json';
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
/** Installed consumer version for the checked route and generated control contract. */
export const INPUT_CHOICES_VERSION = 1;
/** HTML refusal metadata: JSON {version:1, code:BusinessErrorCode, retryable:boolean}.
 * Contains no message, draft, field detail, operation identity or private value.
 */
export const FORM_REFUSAL_HEADER = 'can-form-refusal';

function denialResponse(error: BusinessError, status: number, retry?: FormRetry): Response {
  if (retry === undefined) return jsonErrorResponse(error, status);
  return new Response(JSON.stringify({ error, retry }), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function deny(deps: HttpDeps, error: BusinessError, operation: string, retry?: FormRetry): Response {
  logBusinessError(deps.logger, error, { route: 'operation', operation });
  const { status, body } = toHttpResponse(error);
  return denialResponse(body, status, retry);
}

/** Best-effort redisplay state captured once the body parses to a record. */
interface SeenDrafts {
  readonly inputs: ClosedInputs;
  readonly operationId: string;
}

/**
 * B3-I5 content negotiation: deny with a re-rendered form when the request
 * asks for HTML (explicit `text/html` Accept or `HX-Request`) and a form
 * binding is registered for the operation; bare JSON otherwise. The JSON
 * path is byte-identical to the pre-negotiation behavior. A failing
 * re-render journals an incident and falls back to JSON, never a 500.
 */
async function denyOrRerender(
  deps: HttpDeps,
  request: Request,
  operation: string,
  error: BusinessError,
  seen: SeenDrafts | null,
  authed: { identity: ResolvedIdentity; sessionToken: string } | null,
  retry?: FormRetry,
): Promise<Response> {
  const binding = seen === null || authed === null || !wantsHtmlRerender(request)
    ? undefined
    : formBindingFor(operation);
  if (binding === undefined || seen === null || authed === null) {
    return deny(deps, error, operation, retry);
  }
  logBusinessError(deps.logger, error, { route: 'operation', operation });
  try {
    const fragment = isPartialRequest(request);
    const context = buildPresentationContext({
      ...(deps.deploymentBase === undefined ? {} : { deploymentBase: deps.deploymentBase }),
      request,
      pathname: new URL(request.url).pathname,
      isPartial: fragment,
      appDefaultLocale: deps.app.appDefaultLocale,
      csrfToken: await deriveCsrfToken(authed.sessionToken),
      principal: authed.identity,
      query: () => Promise.reject(buildBusinessError('not_found', 'Row queries are unavailable during error re-render.')),
    });
    const rendered = await renderFormError({
      error,
      draftInputs: seen.inputs,
      operationId: seen.operationId,
      ...(retry === undefined ? {} : { retry }),
      binding,
      context,
      fragment,
    });
    return new Response(rendered.html, {
      status: rendered.status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        vary: 'Accept, HX-Request',
        [FORM_REFUSAL_HEADER]: JSON.stringify({ version: 1,
          code: isBusinessErrorCode(error.code) ? error.code : 'rule_failed',
          retryable: error.retryable === true }),
      },
    });
  } catch (err) {
    logInternalError(deps.logger, err, { route: 'operation-form', operation });
    const { status, body } = toHttpResponse(error);
    return denialResponse(body, status, retry);
  }
}

/**
 * Coerce a flat form map into an envelope body: JSON-parse each value,
 * falling back to the raw string when parsing fails (see module doc).
 */
function coerceFormBody(form: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(form)) {
    let coerced: unknown;
    try {
      coerced = JSON.parse(value) as unknown;
    } catch {
      coerced = value;
    }
    Object.defineProperty(out, key, { value: coerced, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** Operation forms cannot silently overwrite a protected or editable control. */
async function readOperationForm(request: Request): Promise<Record<string, string>> {
  const params = new URLSearchParams(new TextDecoder().decode(await readCappedBody(request, FORM_BODY_MAX_BYTES)));
  const form = Object.create(null) as Record<string, string>;
  for (const [name, value] of params) {
    if (Object.hasOwn(form, name)) throw new IdentityError('validation', 'Duplicate form field.');
    form[name] = value;
  }
  return form;
}

/** One naming inventory serves strict admission and best-effort declared drafts. */
function nativeFormControls(derived: DerivedOperationInputs) {
  const controls = new Map<string, string>();
  const presence = new Map<string, string | null>();
  const root = (name: string) => derived.kind === 'update' ? `inputs[changes][${name}]` : `inputs[${name}]`;
  for (const input of derived.inputs) {
    if (input.kind === 'delivery') continue;
    if ((derived.kind === 'update' || derived.kind === 'delete') && input.name === 'record' && input.kind === 'ref') {
      controls.set('inputs[record][id]', input.name);
      if (input.versioned === true) controls.set('inputs[record][version]', input.name);
      continue;
    }
    controls.set(root(input.name), input.name);
    if (input.nullable === true) {
      controls.set(root(`${input.name}__null`), input.name);
      presence.set(NATIVE_BOOLEAN_PRESENCE_PREFIX + root(`${input.name}__null`), null);
    }
    if (input.kind === 'boolean') presence.set(NATIVE_BOOLEAN_PRESENCE_PREFIX + root(input.name), input.name);
    if (input.array !== undefined) continue;
    if (input.kind === 'ref' && input.versioned === true) controls.set(root(`${input.name}__version`), input.name);
    if (input.kind === 'money') controls.set(root(`${input.name}__currency`), input.name);
    if (input.kind === 'datetime') controls.set(root(`${input.name}__fold`), input.name);
  }
  return { controls, presence };
}

/** Preserve independently valid drafts; a bad sibling never becomes mutation input. */
function nativeFormDrafts(derived: DerivedOperationInputs | null, form: Record<string, string>): ClosedInputs {
  const drafts = Object.create(null) as ClosedInputs;
  if (derived === null || !['create', 'update', 'scenario'].includes(derived.kind)) return drafts;
  const { controls, presence } = nativeFormControls(derived);
  const submitted = new Set<string>();
  for (const name of Object.keys(form)) {
    const owner = controls.get(name) ?? (form[name] === 'true' ? presence.get(name) : undefined);
    if (owner != null) submitted.add(owner);
  }
  for (const input of derived.inputs) {
    if (!submitted.has(input.name)) continue;
    const one = { ...derived, inputs: [input] };
    try {
      const projected = projectGeneratedInputs(one, derived.kind as 'create' | 'update' | 'scenario', form, [input.name]);
      if (checkBoundArguments(one, projected) !== null) continue;
      for (const [name, value] of Object.entries(projected)) {
        Object.defineProperty(drafts, name, { value, enumerable: true, writable: true, configurable: true });
      }
    } catch { /* Unprojectable fields retain the existing per-field omission. */ }
  }
  return drafts;
}

/** Validate native control names before the UI-owned typed projection ignores extras. */
function projectNativeForm(derived: DerivedOperationInputs | null, form: Record<string, string>): ClosedInputs {
  if (derived === null || !['create', 'update', 'delete', 'scenario'].includes(derived.kind)) {
    throw new IdentityError('validation', 'Native forms require a declared mutation operation.');
  }
  const { controls, presence } = nativeFormControls(derived);
  const transport = new Set(['operation', 'operation_id', CSRF_FIELD, SOURCE_FORM_BINDING_FIELD, 'timezone']);
  const rendered = new Set<string>();
  for (const name of Object.keys(form)) {
    const boolean = presence.get(name);
    if (boolean !== undefined) {
      if (form[name] !== 'true') throw new IdentityError('validation', 'Invalid boolean presence marker.');
      if (boolean !== null) rendered.add(boolean);
      continue;
    }
    const owner = controls.get(name);
    if (owner !== undefined) rendered.add(owner);
    else if (!transport.has(name)) throw new IdentityError('validation', 'Unknown native form field.');
  }
  if (derived.kind === 'delete') {
    return Object.hasOwn(form, 'inputs[record][id]') || Object.hasOwn(form, 'inputs[record][version]')
      ? { record: {
        ...(Object.hasOwn(form, 'inputs[record][id]') ? { id: form['inputs[record][id]'] } : {}),
        ...(Object.hasOwn(form, 'inputs[record][version]') ? { version: form['inputs[record][version]'] } : {}),
      } } : {};
  }
  try { return projectGeneratedInputs(derived, derived.kind as 'create' | 'update' | 'scenario', form, [...rendered]); }
  catch { throw new IdentityError('validation', 'Invalid native form inputs.'); }
}

/**
 * Renders one native violation path as a JSON Pointer into the
 * submitted inputs (lossy display only, mirroring host formatting).
 */
function ownedPathToPointer(path: ReadonlyArray<{ k: readonly number[] } | { i: number }>): string {
  let out = '';
  for (const seg of path) {
    out += 'i' in seg ? `/${seg.i}` : `/${String.fromCharCode(...seg.k)}`;
  }
  return out === '' ? '/' : out;
}

/**
 * Runs the owned values/v1 gate for one JSON operation call: the
 * catalog's owned execution (when present) validates the submitted
 * inputs through genuine native execution with the deferred-leaf
 * join, decoding through the installed exact-codec capability.
 * Returns a validation denial for invalid and limit outcomes, or
 * null to continue the legacy flow on valid outcomes. TS-only
 * selections never enter the gate; an unresolvable deferral under a
 * native selection is installation/execution skew and fails loudly,
 * never silent legacy.
 */
function runOwnedHttpValidation(
  deps: HttpDeps,
  operation: string,
  token: OwnedJsonToken,
): BusinessError | null {
  const handle = deps.catalog.ownedValidationFor?.(operation) ?? null;
  if (handle === null || handle.selection.kind !== 'native') return null;
  // Framing already established the envelope shape (record body with
  // an inputs object); anything else here is unreachable skew, so a
  // refusal surfaces loudly instead of silently skipping the gate.
  // The native call sees the protected original-stage projection:
  // `_csrf` is transport (consumed by the check, stripped before the
  // closed-inputs check), so it is projected out of the frame and the
  // resolve-loop input alike — still derived from this same token's
  // raw source, never reparsed or forged.
  const call = ownedOperationFrame(token, { exclude: [CSRF_FIELD] });
  const outcome = resolveDeferredValidation(
    handle.backend,
    {
      owner: handle.owner,
      plan: handle.plan,
      frame: call.frame,
      budgets: handle.budgets,
      profile: 'values/v1',
      target: { kind: 'operation', name: operation },
    },
    call.input,
    { exact: handle.exact },
  );
  if (outcome.outcome === 'invalid') {
    const fields = outcome.violations.map((violation) => ({
      path: ownedPathToPointer(violation.path),
      code: violation.code,
      message: violation.message,
    }));
    return buildBusinessError('validation', outcome.violations[0]?.message ?? 'Invalid inputs.', {
      fields,
    });
  }
  if (outcome.outcome === 'limit') {
    return buildBusinessError(
      'validation',
      `Owned validation refused: ${outcome.code} (${outcome.check}).`,
    );
  }
  if (outcome.outcome === 'deferred') {
    throw new Error(
      `Owned validation left an unresolvable ${outcome.reason} deferral under a native selection.`,
    );
  }
  return null;
}

/**
 * Dispatch one `POST /api/operations/<operation>` request through framing
 * checks to the L3 canonical invocation. Non-POST methods and malformed
 * names are `not_found`; every other denial carries its canonical status.
 * Leniency (documented): extra top-level envelope members beyond
 * operation/operation_id/inputs are ignored — only `inputs` is
 * closed-checked, since the URL (not the body) selects the operation.
 * Carve-out (E2b): a top-level `action_handle` rejects loudly instead —
 * sealed-handle submission is MCP-only, so it must never silently
 * dispatch as an ordinary envelope.
 */
async function readOperationBody(request: Request, operation: string, deps: HttpDeps): Promise<{
  record: Record<string, unknown>; nativeForm: Record<string, string> | null; ownedToken: OwnedJsonToken | null;
} | Response> {
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  let body: unknown;
  let nativeForm: Record<string, string> | null = null;
  let ownedToken: OwnedJsonToken | null = null;
  if (mediaType === JSON_CONTENT_TYPE) {
    try {
      ownedToken = await parseOwnedJsonBody(request, readCappedBody, JSON_BODY_MAX_BYTES);
      body = readOwnedJson(ownedToken).value;
    } catch (error) {
      if (error instanceof OwnedInputError && error.code === 'validation') {
        throw new IdentityError('validation', error.message);
      }
      throw error;
    }
  } else if (mediaType === FORM_CONTENT_TYPE) {
    const form = await readOperationForm(request);
    if (Object.hasOwn(form, 'inputs')) {
      if (Object.keys(form).some(name => name.startsWith('inputs[') || name.startsWith(NATIVE_BOOLEAN_PRESENCE_PREFIX))) {
        throw new IdentityError('validation', 'Mixed form input encodings.');
      }
      body = coerceFormBody(form);
    } else {
      nativeForm = form;
      body = { ...coerceFormBody(form), inputs: {} };
    }
  } else {
    return deny(deps, buildBusinessError('validation', 'Unsupported content type.'), operation);
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return deny(deps, buildBusinessError('validation', 'Invalid request body.'), operation);
  }
  const record = body as Record<string, unknown>;
  if ('operation' in record && record['operation'] !== operation) {
    return deny(deps, buildBusinessError('validation', 'Body operation does not match the route.'), operation);
  }
  // E2b handle-mode boundary: sealed-handle submission is MCP-only, so a
  // top-level `action_handle` (the MCP sibling spelling) rejects loudly
  // instead of falling into the documented extra-member leniency — a
  // misrouted handle call must never silently dispatch as ordinary.
  if ('action_handle' in record) {
    const message =
      "Unknown top-level member 'action_handle': sealed-handle submission is MCP-only " +
      '(tools/call); HTTP operation POSTs carry ordinary inputs.';
    return deny(
      deps,
      buildBusinessError('validation', message, {
        fields: [{ path: '/action_handle', code: 'unknown', message }],
      }),
      operation,
    );
  }
  return { record, nativeForm, ownedToken };
}

function resolveOperationDerived(
  deps: HttpDeps,
  operation: string,
  aged: DerivedOperationInputs | null | undefined,
): DerivedOperationInputs | null {
  return aged === undefined ? deps.catalog.derivedFor?.(operation) ?? null : aged;
}

async function checkOperationAge(
  deps: HttpDeps,
  request: Request,
  operation: string,
  operationId: string,
  record: Record<string, unknown>,
  seen: SeenDrafts | null,
  authed: { identity: ResolvedIdentity; sessionToken: string } | null,
): Promise<{
  derived: DerivedOperationInputs | null | undefined; retainedScenario: boolean; idError: BusinessError | null;
} | Response> {
  const idError = validateOperationId(operationId, deps.clock);
  let derived: DerivedOperationInputs | null | undefined;
  let retainedScenario = false;
  if (idError !== null) {
    // Checked scenarios use the dedicated current-authority saved-outcome
    // join for expired identities only; fresh and future routing stay intact.
    // Preserve ordinary fresh and malformed-ID demand order; consult the
    // catalog here only when the original age gate would refuse.
    if (validateOperationIdShape(operationId) === null) {
      derived = deps.catalog.derivedFor?.(operation) ?? null;
    }
    retainedScenario = derived?.kind === 'scenario' && idError.message === 'Expired operation_id.' &&
      typeof deps.invoker.invokeRetainedMutation === 'function' &&
      (!Object.hasOwn(record, SOURCE_FORM_BINDING_FIELD) || typeof deps.formBindings?.restoreRetained === 'function');
    if (!retainedScenario && derived?.kind !== 'create' && derived?.kind !== 'update' && derived?.kind !== 'delete') {
      return denyOrRerender(deps, request, operation, idError, seen, authed);
    }
  }
  return { derived, retainedScenario, idError };
}

async function restoreNativeDrafts(
  deps: HttpDeps,
  request: Request,
  record: Record<string, unknown>,
  nativeForm: Record<string, string>,
  derived: DerivedOperationInputs | null,
  operation: string,
  operationId: string,
  sessionToken: string,
  identity: ResolvedIdentity,
): Promise<ClosedInputs> {
  let drafts = nativeFormDrafts(derived, nativeForm);
  if (Object.hasOwn(record, SOURCE_FORM_BINDING_FIELD) && wantsHtmlRerender(request) && formBindingFor(operation) !== undefined) {
    const token = record[SOURCE_FORM_BINDING_FIELD];
    const restoredDrafts = typeof token !== 'string' || derived === null || deps.formBindings === undefined ? null :
      await deps.formBindings.restore({ appId: deps.app.appId, sessionToken, identity, derived,
        operationId, nowMs: deps.clock.nowMs() }, token, drafts);
    // Signed bound refs may restore the update shell for redisplay only.
    // An unavailable proof never turns submitted refs into protected ones.
    drafts = restoredDrafts ?? Object.fromEntries(Object.entries(drafts).filter(([name]) =>
      derived?.inputs.find(input => input.name === name)?.kind !== 'ref'));
  }
  return drafts;
}

function captureSeenDrafts(record: Record<string, unknown>): SeenDrafts {
  const seenId = record['operation_id'];
  const seenInputs = record['inputs'];
  const seenObj: ClosedInputs =
    typeof seenInputs === 'object' && seenInputs !== null && !Array.isArray(seenInputs)
      ? (seenInputs as ClosedInputs)
      : {};
  const { [CSRF_FIELD]: _seenCsrf, ...seenRest } = seenObj;
  void _seenCsrf;
  return {
    operationId: typeof seenId === 'string' ? seenId : '',
    inputs: seenRest,
  };
}

async function assertOperationCsrf(
  request: Request,
  record: Record<string, unknown>,
  inputs: ClosedInputs,
  sessionToken: string,
): Promise<void> {
  const csrfInInputs = inputs[CSRF_FIELD];
  await assertPostCsrf({
    sessionToken,
    headerValue: request.headers.get(CSRF_HEADER),
    fieldValue: typeof csrfInInputs === 'string' ? csrfInInputs : record[CSRF_FIELD],
  });
}

async function checkOperationEnvelope(
  deps: HttpDeps,
  request: Request,
  record: Record<string, unknown>,
  operation: string,
  seen: SeenDrafts | null,
  authed: { identity: ResolvedIdentity; sessionToken: string } | null,
): Promise<{ operationId: string; inputs: ClosedInputs } | Response> {
  const operationId = record['operation_id'];
  const rawInputs = record['inputs'];
  if (typeof operationId !== 'string') {
    return denyOrRerender(deps, request, operation, buildBusinessError('validation', 'Missing operation_id.'), seen, authed);
  }
  if (typeof rawInputs !== 'object' || rawInputs === null || Array.isArray(rawInputs)) {
    return denyOrRerender(deps, request, operation, buildBusinessError('validation', 'Invalid inputs.'), seen, authed);
  }
  return { operationId, inputs: rawInputs as ClosedInputs };
}

async function checkClosedOperationInputs(
  deps: HttpDeps,
  request: Request,
  operation: string,
  businessInputs: ClosedInputs,
  shape: OperationInputShape,
  prepared: Awaited<ReturnType<typeof runSourceHttpPlan>>,
  derived: DerivedOperationInputs | null,
  seen: SeenDrafts | null,
  authed: { identity: ResolvedIdentity; sessionToken: string } | null,
): Promise<null | Response> {
  const closedError = prepared === undefined ? checkClosedInputs(businessInputs, shape) : prepared.ok ? null : prepared.error;
  if (closedError !== null) {
    return denyOrRerender(deps, request, operation, closedError, seen, authed);
  }
  if (derived !== null && prepared === undefined) {
    const boundError = checkBoundArguments(derived, businessInputs);
    if (boundError !== null) {
      return denyOrRerender(deps, request, operation, boundError, seen, authed);
    }
  }
  return null;
}

async function restoreOperationBindings(
  deps: HttpDeps,
  request: Request,
  record: Record<string, unknown>,
  nativeForm: Record<string, string> | null,
  derived: DerivedOperationInputs | null,
  operation: string,
  operationId: string,
  sessionToken: string,
  identity: ResolvedIdentity,
  submittedInputs: ClosedInputs,
  seenHolder: { current: SeenDrafts | null },
): Promise<{
  businessInputs: ClosedInputs; retainedBinding: boolean; seen: SeenDrafts | null;
} | Response> {
  if (nativeForm !== null) {
    seenHolder.current = { operationId, inputs: await restoreNativeDrafts(deps, request, record, nativeForm,
      derived, operation, operationId, sessionToken, identity) };
  }
  let retainedBinding = false;
  let businessInputs = nativeForm === null ? submittedInputs : projectNativeForm(derived, nativeForm);
  if (nativeForm !== null) seenHolder.current = { operationId, inputs: businessInputs };
  if (Object.hasOwn(record, SOURCE_FORM_BINDING_FIELD)) {
    const token = record[SOURCE_FORM_BINDING_FIELD];
    let restored = typeof token !== 'string' || derived === null || deps.formBindings === undefined ? null :
      await deps.formBindings.restore({ appId: deps.app.appId, sessionToken, identity, derived,
        operationId, nowMs: deps.clock.nowMs() }, token, businessInputs);
    if (restored === null && typeof token === 'string' && derived !== null &&
        ['create', 'update', 'delete', 'scenario'].includes(derived.kind) &&
        typeof deps.formBindings?.restoreRetained === 'function' && typeof deps.invoker.invokeRetainedMutation === 'function') {
      restored = await deps.formBindings.restoreRetained({ appId: deps.app.appId, sessionToken, identity, derived,
        operationId, nowMs: deps.clock.nowMs() }, token, businessInputs);
      retainedBinding = restored !== null;
    }
    if (restored === null) {
      return denyOrRerender(deps, request, operation,
        buildBusinessError('forbidden', 'This form binding is no longer available. Reload the page.'), seenHolder.current, { identity, sessionToken });
    }
    businessInputs = restored;
    seenHolder.current = { operationId, inputs: businessInputs };
  }
  return { businessInputs, retainedBinding, seen: seenHolder.current };
}

async function mintOperationRetry(
  deps: HttpDeps,
  record: Record<string, unknown>,
  operation: string,
  operationId: string,
  derived: DerivedOperationInputs,
  sessionToken: string,
  identity: ResolvedIdentity,
): Promise<FormRetry | undefined> {
  const nextId = mintOperationId(deps.clock.nowMs());
  if (Object.hasOwn(record, SOURCE_FORM_BINDING_FIELD)) {
    const token = record[SOURCE_FORM_BINDING_FIELD];
    const renewed = typeof token !== 'string' || typeof deps.formBindings?.renew !== 'function' ? null :
      await deps.formBindings.renew({ appId: deps.app.appId, sessionToken, identity, derived,
        operationId, nowMs: deps.clock.nowMs() }, token, nextId);
    if (typeof renewed === 'string' && renewed.length > 0) return { operation_id: nextId, form_binding: renewed };
    return undefined;
  }
  return { operation_id: nextId };
}

async function settleOperationOutcome(
  deps: HttpDeps,
  request: Request,
  operation: string,
  operationId: string,
  businessInputs: ClosedInputs,
  identity: ResolvedIdentity,
  sessionToken: string,
  seen: SeenDrafts | null,
  authed: { identity: ResolvedIdentity; sessionToken: string } | null,
  retainedBinding: boolean,
  retainedScenario: boolean,
  idError: BusinessError | null,
  derived: DerivedOperationInputs | null,
  record: Record<string, unknown>,
): Promise<Response> {
  /* B4 pre-invoker admission: re-read CURRENT session facts after the
   * capped body and checked arguments. Revocation or expiry before this
   * read refuses entry with the admission-identical message. Work already
   * admitted to the invoker has no retroactive cancellation guarantee. */
  await assertCredentialLive(deps.identity.store, {
    kind: 'session',
    tokenHash: await sha256HexText(sessionToken),
    now: new Date(deps.clock.nowMs()).toISOString(),
  });
  await assertSourceValidationCurrent(deps.catalog, operation);
  const envelope: MutationEnvelope = { operation, operation_id: operationId, inputs: businessInputs };
  assertSourceValidationStable(deps.catalog, operation);
  const outcome = retainedBinding || retainedScenario
    ? await deps.invoker.invokeRetainedMutation!(envelope, identity)
    : await deps.invoker.invokeMutation(envelope, identity);
  if (!('error' in outcome)) {
    return new Response(JSON.stringify(outcome.result), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  // Only the trusted invoker's exact durable rejection can start a new
  // attempt. Unknown outcomes keep their original identity for replay.
  const error = outcome.receipt === 'rejected' ? { ...outcome.error, operation_id: operationId } : outcome.error;
  let retry: FormRetry | undefined;
  if (outcome.receipt === 'rejected' && !retainedBinding && !retainedScenario && idError === null &&
      derived !== null && ['create', 'update', 'scenario'].includes(derived.kind)) {
    try {
      await assertSourceValidationCurrent(deps.catalog, operation);
      retry = await mintOperationRetry(deps, record, operation, operationId, derived, sessionToken, identity);
      assertSourceValidationStable(deps.catalog, operation);
    } catch {
      // Renewal is optional recovery, never a replacement denial.
      retry = undefined;
    }
  }
  return denyOrRerender(deps, request, operation, error, seen, authed, retry);
}

export async function handleOperationRequest(
  deps: HttpDeps,
  request: Request,
  operation: string,
): Promise<Response> {
  const choiceRoute = /^(.+)\/choices\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(operation);
  if (choiceRoute !== null) {
    return handleInputChoiceRequest(deps, request, choiceRoute[1]!, choiceRoute[2]!);
  }
  if (request.method !== 'POST') {
    return deny(deps, buildBusinessError('not_found', 'Unknown operation.'), operation);
  }
  if (!OPERATION_NAME_PATTERN.test(operation)) {
    return deny(deps, buildBusinessError('not_found', 'Unknown operation.'), operation);
  }
  let authed: { identity: ResolvedIdentity; sessionToken: string } | null = null;
  let seen: SeenDrafts | null = null;
  try {
    const { identity, sessionToken } = await resolveRequestIdentity(
      deps.identity.store,
      request,
      { clock: deps.clock },
    );
    if (sessionToken === null) {
      return deny(deps, buildBusinessError('forbidden', 'Authentication required.'), operation);
    }
    authed = { identity, sessionToken };

    const parsedBody = await readOperationBody(request, operation, deps);
    if (parsedBody instanceof Response) return parsedBody;
    const { record, nativeForm, ownedToken } = parsedBody;
    // Capture redisplay state best-effort: later denials re-render the form
    // when the request asks for HTML; `_csrf` is transport, never a draft.
    seen = captureSeenDrafts(record);
    const envelope = await checkOperationEnvelope(deps, request, record, operation, seen, authed);
    if (envelope instanceof Response) return envelope;
    const { operationId, inputs } = envelope;

    await assertOperationCsrf(request, record, inputs, sessionToken);

    const aged = await checkOperationAge(deps, request, operation, operationId, record, seen, authed);
    if (aged instanceof Response) return aged;
    const { retainedScenario, idError } = aged;
    const shape = deps.catalog.shapeFor(operation);
    if (shape === null) {
      return denyOrRerender(deps, request, operation, buildBusinessError('not_found', 'Unknown operation.'), seen, authed);
    }
    // Owned values/v1 gate (JSON only): when the catalog carries an
    // installed owned execution for this operation, genuine native
    // validation with the deferred-leaf join judges the submitted
    // inputs FIRST — before the legacy TS validators below. Invalid
    // denies here; valid and honestly unresolved (deferred) outcomes
    // continue on the legacy flow with its value identity unchanged.
    // All host shells above (auth, framing, CSRF, operation identity,
    // known operation) keep their precedence. Forms and SDK-shaped
    // bodies carry no token and keep their original handling.
    if (ownedToken !== null) {
      const ownedError = runOwnedHttpValidation(deps, operation, ownedToken);
      if (ownedError !== null) {
        return denyOrRerender(deps, request, operation, ownedError, seen, authed);
      }
    }
    const { [CSRF_FIELD]: _csrf, ...submittedInputs } = inputs;
    void _csrf;
    const derived = resolveOperationDerived(deps, operation, aged.derived);
    // The inline original assigned drafts to the shared `seen` binding before
    // native projection; a throwing projection still re-rendered those drafts.
    // The holder carries that partial state back when the helper throws.
    const seenHolder = { current: seen };
    let restored: Awaited<ReturnType<typeof restoreOperationBindings>> | Response;
    try {
      restored = await restoreOperationBindings(deps, request, record, nativeForm, derived,
        operation, operationId, sessionToken, identity, submittedInputs, seenHolder);
    } catch (err) {
      seen = seenHolder.current;
      throw err;
    }
    if (restored instanceof Response) return restored;
    seen = restored.seen;
    const { businessInputs, retainedBinding } = restored;
    const prepared = await runSourceHttpPlan(deps.catalog, operation, businessInputs);
    // E1 bound-input wiring: framing first, then each present value binds
    // to its derived declaration (delivery binds to nothing — submitted
    // receipts fail here when framing admits them). Catalogs without the
    // derived channel keep framing-only behavior.
    const admission = await checkClosedOperationInputs(deps, request, operation, businessInputs,
      shape, prepared, derived, seen, authed);
    if (admission instanceof Response) return admission;
    return await settleOperationOutcome(deps, request, operation, operationId, businessInputs,
      identity, sessionToken, seen, authed, retainedBinding, retainedScenario, idError, derived, record);
  } catch (err) {
    if (err instanceof IdentityError) {
      return denyOrRerender(deps, request, operation, caughtToBusinessError(err), seen, authed);
    }
    const incidentId = logInternalError(deps.logger, err, { route: 'operation', operation });
    void incidentId;
    const error = fromUnknown(err);
    // An unexpected failure behind an HTML POST still re-renders (generic
    // banner); without HTML headers this stays the JSON envelope below.
    if (seen !== null && authed !== null && wantsHtmlRerender(request) && formBindingFor(operation) !== undefined) {
      return denyOrRerender(deps, request, operation, error, seen, authed);
    }
    const { status, body } = toHttpResponse(error);
    return jsonErrorResponse(body, status);
  } finally {
    closeSourceValidationCatalog(deps.catalog);
  }
}

/* ------------------------------------------------------------------ */
/* T19a checked derivation: artifact operations -> HTTP input shapes.  */
/* Every builder checks through the shared `mcp/schemas.ts` rule, so  */
/* the HTTP catalog derives the same writable allowlist the MCP       */
/* registry/tools derive from the same checked operation. T19b adds   */
/* the delivery/file depth: receipt bindings project to the            */
/* documented `derivedFor` channel (engine-resolved, excluded from     */
/* dispatch shapes) and file inputs carry their provenance boundary.   */
/* ------------------------------------------------------------------ */

/**
 * A version-fenced derived catalog: the dispatch `shapeFor` view plus
 * the `derivedFor` documented-optionality view (defaults pinned
 * verbatim, versioned flags, array markers) for parity checks and the
 * T20 form join. Bound to a single artifact slice — a new artifact
 * requires a fresh derivation; stale shapes never serve new traffic.
 */
export interface DerivedInputCatalog extends SchemaCatalog {
  derivedFor(operation: string): DerivedOperationInputs | null;
}

/** Project one checked receipt binding to its wire documented shape. */
function toDerivedDeliveryInput(field: CheckedArtifactDeliveryField): DerivedWritableInput {
  return {
    name: field.name,
    kind: 'delivery',
    required: field.required,
    ...(field.nullable === undefined ? {} : { nullable: field.nullable }),
    ...(field.array === undefined ? {} : { array: field.array }),
    ...(field.min === undefined ? {} : { min: field.min }),
    ...(field.max === undefined ? {} : { max: field.max }),
    ...(field.default === undefined ? {} : { default: field.default }),
    delivery: field.delivery,
    ...(field.description === undefined ? {} : { description: field.description }),
  };
}

function commonDerivedInput(field: CheckedArtifactField): {
  name: string; required: boolean;
} {
  return {
    name: field.name,
    ...(field.choices === undefined ? {} : { choices: field.choices }),
    required: field.required,
    ...(field.nullable === undefined ? {} : { nullable: field.nullable }),
    ...(field.array === undefined ? {} : { array: field.array }),
    ...(field.min === undefined ? {} : { min: field.min }),
    ...(field.max === undefined ? {} : { max: field.max }),
    ...(field.default === undefined ? {} : { default: field.default }),
    ...(field.description === undefined ? {} : { description: field.description }),
  };
}

function derivedKindInput(
  tag: CheckedArtifactField['field'],
  field: CheckedArtifactField,
  common: ReturnType<typeof commonDerivedInput>,
): DerivedWritableInput {
  switch (tag.kind) {
    case 'nominal':
      return { ...common, kind: 'nominal', valueTypes: tag.valueTypes,
        valueType: field.valueType ?? `${tag.name}${field.array === undefined ? '' : field.array.required ? '[]!' : '[]'}${field.nullable ? '?' : ''}` };
    case 'ref':
      return { ...common, kind: 'ref', model: tag.model, versioned: tag.requireVersion };
    case 'enum':
      return { ...common, kind: 'enum', enumValues: [...tag.values] };
    case 'string':
      return { ...common, kind: 'string',
        ...(field.valueType === undefined ? {} : { valueType: field.valueType }) };
    case 'integer':
      return { ...common, kind: 'integer' };
    case 'decimal':
      return { ...common, kind: 'decimal' };
    case 'money':
      return { ...common, kind: 'money' };
    case 'datetime':
      return { ...common, kind: 'datetime' };
    case 'duration':
      return { ...common, kind: 'duration' };
    case 'user':
      return { ...common, kind: 'user' };
    case 'boolean':
      return { ...common, kind: 'boolean' };
    case 'file':
      return {
        ...common,
        kind: 'file',
        file: { valueShape: 'opaque-file-id', format: 'can-file' },
      };
  }
}

/** Project one checked input to its wire documented-optionality shape. */
function toDerivedInput(field: CheckedArtifactInput): DerivedWritableInput {
  if (isDeliveryField(field)) return toDerivedDeliveryInput(field);
  return derivedKindInput(field.field, field, commonDerivedInput(field));
}

/** Project one checked operation to its wire derived-inputs shape. */
function checkedToDerivedInputs(checked: CheckedArtifactOperation): DerivedOperationInputs {
  return {
    operation: checked.name,
    kind: checked.kind,
    artifactVersion: ARTIFACT_VERSION,
    inputs: Object.freeze(checked.fields.map(toDerivedInput)),
  };
}

/**
 * Derive the documented writable inputs for one artifact operation:
 * allowlist, required sets, versioned flags, and verbatim
 * `literal`/`parent` defaults. Server-owned inputs, unknown kinds, and
 * malformed members reject via `IncompatibleDescriptorError`. T19b
 * depth rides along: receipt bindings (engine-resolved), exact
 * numeric defaults, and file provenance claims.
 */
export function deriveOperationInputs(op: ArtifactOperation): DerivedOperationInputs {
  return checkedToDerivedInputs(checkArtifactOperation(op));
}

/**
 * Derive the dispatch input shape for one artifact operation: the
 * closed `allowed` allowlist (emission order; array inputs are single
 * named members) and its `required` subset. Same rule as
 * `deriveOperationInputs`, framing projection — engine-resolved
 * receipt bindings excluded (never submitted).
 */
export function deriveOperationShape(op: ArtifactOperation): OperationInputShape {
  const checked = checkArtifactOperation(op);
  const allowed: string[] = [];
  const required: string[] = [];
  for (const named of checked.fields) {
    if (isDeliveryField(named)) continue;
    allowed.push(named.name);
    if (named.required) required.push(named.name);
  }
  return { allowed: Object.freeze(allowed), required: Object.freeze(required) };
}

/**
 * Build the HTTP input catalog for one version-fenced artifact slice:
 * `shapeFor` serves dispatch framing (unknown operations read null —
 * the existing `not_found` path), `derivedFor` serves the documented
 * optionality. Any unknown kind, server-owned input, duplicate, or
 * version mismatch rejects the whole slice — nothing derives partially.
 */
export function catalogFromArtifactOperations(
  slice: ArtifactOperationSlice,
  options?: { readonly owned?: ReadonlyMap<string, import('../envelope/owned-selection.js').InstalledOwnedOperation> },
): DerivedInputCatalog {
  const shapes = new Map<string, OperationInputShape>();
  const derived = new Map<string, DerivedOperationInputs>();
  for (const checked of checkArtifactOperations(slice)) {
    const allowed: string[] = [];
    const required: string[] = [];
    for (const named of checked.fields) {
      if (isDeliveryField(named)) continue;
      allowed.push(named.name);
      if (named.required) required.push(named.name);
    }
    shapes.set(
      checked.name,
      { allowed: Object.freeze(allowed), required: Object.freeze(required) },
    );
    derived.set(checked.name, checkedToDerivedInputs(checked));
  }
  // Explicit owned installation: native-selected operations serve
  // their handle; every other operation serves null and validates
  // exactly as before. No coverage is (re-)decided here.
  const owned = options?.owned;
  return {
    shapeFor: (operation: string): OperationInputShape | null => shapes.get(operation) ?? null,
    derivedFor: (operation: string): DerivedOperationInputs | null => derived.get(operation) ?? null,
    ...(owned === undefined
      ? {}
      : { ownedValidationFor: (operation: string) => owned.get(operation)?.handle ?? null }),
  };
}

/**
 * BGI-09 view-control admission: narrow one operation's derived inputs to
 * the fields a prompted view declares for its control. Declared names the
 * operation does not admit are refused (reported, absent from the
 * admitted derivation): the renderer arranges only admitted bindings,
 * and the existing closed-inputs dispatch refuses any submitted refused
 * member. Emission order is preserved.
 */
export function admitGeneratedViewControls(
  derived: DerivedOperationInputs,
  declaredFields: ReadonlyArray<string>,
): { admitted: DerivedOperationInputs; refused: ReadonlyArray<string> } {
  const available = new Map(derived.inputs.map((input) => [input.name, input]));
  const admittedInputs: DerivedWritableInput[] = [];
  const refused: string[] = [];
  for (const field of declaredFields) {
    const input = available.get(field);
    if (input === undefined) {
      refused.push(field);
    } else {
      admittedInputs.push(input);
    }
  }
  return {
    admitted: {
      operation: derived.operation,
      kind: derived.kind,
      artifactVersion: derived.artifactVersion,
      inputs: Object.freeze(admittedInputs),
    },
    refused: Object.freeze(refused),
  };
}
