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
 * Form transport convention (lane-06 authored): form values are strings, so
 * each value is JSON-parsed with fallback to the raw string — scalars travel
 * raw (`operation_id=<uuid>`), structured members travel as JSON text
 * (`inputs={"qty":2}`). The `_csrf` field is transport-level: it is consumed
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
  ClosedInputs,
  DerivedOperationInputs,
  DerivedWritableInput,
  MutationEnvelope,
  ResolvedIdentity,
} from '@canlang/contracts';
import { IdentityError, assertCredentialLive, deriveCsrfToken, sha256HexText } from '@canlang/identity';
import { SOURCE_FORM_BINDING_FIELD } from '@canlang/contracts';
export { createSourceFormBindings } from './form-binding.js';
import type { HttpDeps, OperationInputShape, SchemaCatalog } from '../ports.js';
import { checkArtifactOperation, checkArtifactOperations, checkBoundArguments, isDeliveryField } from '../mcp/schemas.js';
import type {
  ArtifactOperationSlice,
  CheckedArtifactDeliveryField,
  CheckedArtifactInput,
  CheckedArtifactOperation,
} from '../mcp/schemas.js';
import { buildBusinessError, fromUnknown, toHttpResponse } from '../errors/envelope.js';
import { logBusinessError, logInternalError } from '../errors/logging.js';
import { checkClosedInputs, validateOperationId } from '../envelope/validate.js';
import {
  CSRF_FIELD,
  CSRF_HEADER,
  assertPostCsrf,
  caughtToBusinessError,
  jsonErrorResponse,
  resolveRequestIdentity,
} from './context.js';
import { formBindingFor, renderFormError, wantsHtmlRerender } from './formErrors.js';
import { isPartialRequest } from './fragments.js';
import { parseFormBody, parseJsonBody } from './limits.js';
import { buildPresentationContext } from './presentation.js';
import { handleInputChoiceRequest } from './input-choices.js';

/**
 * Operation-name shape: 2-3 dot-separated segments (e.g. `shop.Order.create`,
 * `shop.checkout`, `system.team.invite`). Anything else is `not_found` — the
 * name never reaches the catalog, so malformed names cannot probe it.
 */
export const OPERATION_NAME_PATTERN =
  /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*){1,2}$/;

const JSON_CONTENT_TYPE = 'application/json';
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';
/** Installed consumer version for the checked route and generated control contract. */
export const INPUT_CHOICES_VERSION = 1;

function deny(deps: HttpDeps, error: BusinessError, operation: string): Response {
  logBusinessError(deps.logger, error, { route: 'operation', operation });
  const { status, body } = toHttpResponse(error);
  return jsonErrorResponse(body, status);
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
): Promise<Response> {
  const binding = seen === null || authed === null || !wantsHtmlRerender(request)
    ? undefined
    : formBindingFor(operation);
  if (binding === undefined || seen === null || authed === null) {
    return deny(deps, error, operation);
  }
  logBusinessError(deps.logger, error, { route: 'operation', operation });
  try {
    const fragment = isPartialRequest(request);
    const context = buildPresentationContext({
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
      binding,
      context,
      fragment,
    });
    return new Response(rendered.html, {
      status: rendered.status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        vary: 'Accept, HX-Request',
      },
    });
  } catch (err) {
    logInternalError(deps.logger, err, { route: 'operation-form', operation });
    const { status, body } = toHttpResponse(error);
    return jsonErrorResponse(body, status);
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

    const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    let body: unknown;
    if (mediaType === JSON_CONTENT_TYPE) {
      body = await parseJsonBody(request);
    } else if (mediaType === FORM_CONTENT_TYPE) {
      body = coerceFormBody(await parseFormBody(request));
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
    // Capture redisplay state best-effort: later denials re-render the form
    // when the request asks for HTML; `_csrf` is transport, never a draft.
    const seenId = record['operation_id'];
    const seenInputs = record['inputs'];
    const seenObj: ClosedInputs =
      typeof seenInputs === 'object' && seenInputs !== null && !Array.isArray(seenInputs)
        ? (seenInputs as ClosedInputs)
        : {};
    const { [CSRF_FIELD]: _seenCsrf, ...seenRest } = seenObj;
    void _seenCsrf;
    seen = {
      operationId: typeof seenId === 'string' ? seenId : '',
      inputs: seenRest,
    };
    const operationId = record['operation_id'];
    const rawInputs = record['inputs'];
    if (typeof operationId !== 'string') {
      return denyOrRerender(deps, request, operation, buildBusinessError('validation', 'Missing operation_id.'), seen, authed);
    }
    if (typeof rawInputs !== 'object' || rawInputs === null || Array.isArray(rawInputs)) {
      return denyOrRerender(deps, request, operation, buildBusinessError('validation', 'Invalid inputs.'), seen, authed);
    }
    const inputs = rawInputs as ClosedInputs;

    const csrfInInputs = inputs[CSRF_FIELD];
    await assertPostCsrf({
      sessionToken,
      headerValue: request.headers.get(CSRF_HEADER),
      fieldValue: typeof csrfInInputs === 'string' ? csrfInInputs : record[CSRF_FIELD],
    });

    const idError = validateOperationId(operationId, deps.clock);
    if (idError !== null) {
      return denyOrRerender(deps, request, operation, idError, seen, authed);
    }
    const shape = deps.catalog.shapeFor(operation);
    if (shape === null) {
      return denyOrRerender(deps, request, operation, buildBusinessError('not_found', 'Unknown operation.'), seen, authed);
    }
    const { [CSRF_FIELD]: _csrf, ...submittedInputs } = inputs;
    void _csrf;
    const derived = deps.catalog.derivedFor?.(operation) ?? null;
    let businessInputs = submittedInputs;
    if (Object.hasOwn(record, SOURCE_FORM_BINDING_FIELD)) {
      const token = record[SOURCE_FORM_BINDING_FIELD];
      const restored = typeof token !== 'string' || derived === null || deps.formBindings === undefined ? null :
        await deps.formBindings.restore({ appId: deps.app.appId, sessionToken, identity, derived,
          operationId, nowMs: deps.clock.nowMs() }, token, submittedInputs);
      if (restored === null) {
        return denyOrRerender(deps, request, operation,
          buildBusinessError('forbidden', 'This form binding is no longer available. Reload the page.'), seen, authed);
      }
      businessInputs = restored;
    }
    const closedError = checkClosedInputs(businessInputs, shape);
    if (closedError !== null) {
      return denyOrRerender(deps, request, operation, closedError, seen, authed);
    }
    // E1 bound-input wiring: framing first, then each present value binds
    // to its derived declaration (delivery binds to nothing — submitted
    // receipts fail here when framing admits them). Catalogs without the
    // derived channel keep framing-only behavior.
    if (derived !== null) {
      const boundError = checkBoundArguments(derived, businessInputs);
      if (boundError !== null) {
        return denyOrRerender(deps, request, operation, boundError, seen, authed);
      }
    }

    /* B4 commit-time credential liveness: the session is re-read from
     * CURRENT store facts just before the commit — a revocation (or
     * expiry) landing between admission and commit voids the in-flight
     * operation. IdentityError falls into the shared catch below and
     * denies with the admission-identical message (no oracle). */
    await assertCredentialLive(deps.identity.store, {
      kind: 'session',
      tokenHash: await sha256HexText(sessionToken),
      now: new Date(deps.clock.nowMs()).toISOString(),
    });
    const envelope: MutationEnvelope = { operation, operation_id: operationId, inputs: businessInputs };
    const outcome = await deps.invoker.invokeMutation(envelope, identity);
    if ('error' in outcome) {
      return denyOrRerender(deps, request, operation, outcome.error, seen, authed);
    }
    return new Response(JSON.stringify(outcome.result), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
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
    ...(field.default === undefined ? {} : { default: field.default }),
    delivery: field.delivery,
    ...(field.description === undefined ? {} : { description: field.description }),
  };
}

/** Project one checked input to its wire documented-optionality shape. */
function toDerivedInput(field: CheckedArtifactInput): DerivedWritableInput {
  if (isDeliveryField(field)) return toDerivedDeliveryInput(field);
  const common = {
    name: field.name,
    ...(field.choices === undefined ? {} : { choices: field.choices }),
    required: field.required,
    ...(field.nullable === undefined ? {} : { nullable: field.nullable }),
    ...(field.array === undefined ? {} : { array: field.array }),
    ...(field.default === undefined ? {} : { default: field.default }),
    ...(field.description === undefined ? {} : { description: field.description }),
  };
  const tag = field.field;
  switch (tag.kind) {
    case 'ref':
      return { ...common, kind: 'ref', model: tag.model, versioned: tag.requireVersion };
    case 'enum':
      return { ...common, kind: 'enum', enumValues: [...tag.values] };
    case 'string':
      return { ...common, kind: 'string' };
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
export function catalogFromArtifactOperations(slice: ArtifactOperationSlice): DerivedInputCatalog {
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
  return {
    shapeFor: (operation: string): OperationInputShape | null => shapes.get(operation) ?? null,
    derivedFor: (operation: string): DerivedOperationInputs | null => derived.get(operation) ?? null,
  };
}
