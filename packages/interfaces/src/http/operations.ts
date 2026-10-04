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
import type { BusinessError, ClosedInputs, MutationEnvelope } from '@canlang/contracts';
import { IdentityError } from '@canlang/identity';
import type { HttpDeps } from '../ports.js';
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
import { parseFormBody, parseJsonBody } from './limits.js';

/**
 * Operation-name shape: 2-3 dot-separated segments (e.g. `shop.Order.create`,
 * `shop.checkout`, `system.team.invite`). Anything else is `not_found` — the
 * name never reaches the catalog, so malformed names cannot probe it.
 */
export const OPERATION_NAME_PATTERN =
  /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*){1,2}$/;

const JSON_CONTENT_TYPE = 'application/json';
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

function deny(deps: HttpDeps, error: BusinessError, operation: string): Response {
  logBusinessError(deps.logger, error, { route: 'operation', operation });
  const { status, body } = toHttpResponse(error);
  return jsonErrorResponse(body, status);
}

/**
 * Coerce a flat form map into an envelope body: JSON-parse each value,
 * falling back to the raw string when parsing fails (see module doc).
 */
function coerceFormBody(form: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(form)) {
    try {
      out[key] = JSON.parse(value) as unknown;
    } catch {
      out[key] = value;
    }
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
 */
export async function handleOperationRequest(
  deps: HttpDeps,
  request: Request,
  operation: string,
): Promise<Response> {
  if (request.method !== 'POST') {
    return deny(deps, buildBusinessError('not_found', 'Unknown operation.'), operation);
  }
  if (!OPERATION_NAME_PATTERN.test(operation)) {
    return deny(deps, buildBusinessError('not_found', 'Unknown operation.'), operation);
  }
  try {
    const { identity, sessionToken } = await resolveRequestIdentity(
      deps.identity.store,
      request,
      { clock: deps.clock },
    );
    if (sessionToken === null) {
      return deny(deps, buildBusinessError('forbidden', 'Authentication required.'), operation);
    }

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
    const operationId = record['operation_id'];
    const rawInputs = record['inputs'];
    if (typeof operationId !== 'string') {
      return deny(deps, buildBusinessError('validation', 'Missing operation_id.'), operation);
    }
    if (typeof rawInputs !== 'object' || rawInputs === null || Array.isArray(rawInputs)) {
      return deny(deps, buildBusinessError('validation', 'Invalid inputs.'), operation);
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
      return deny(deps, idError, operation);
    }
    const shape = deps.catalog.shapeFor(operation);
    if (shape === null) {
      return deny(deps, buildBusinessError('not_found', 'Unknown operation.'), operation);
    }
    const { [CSRF_FIELD]: _csrf, ...businessInputs } = inputs;
    void _csrf;
    const closedError = checkClosedInputs(businessInputs, shape);
    if (closedError !== null) {
      return deny(deps, closedError, operation);
    }

    const envelope: MutationEnvelope = { operation, operation_id: operationId, inputs: businessInputs };
    const outcome = await deps.invoker.invokeMutation(envelope, identity);
    if ('error' in outcome) {
      return deny(deps, outcome.error, operation);
    }
    return new Response(JSON.stringify(outcome.result), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  } catch (err) {
    if (err instanceof IdentityError) {
      return deny(deps, caughtToBusinessError(err), operation);
    }
    const incidentId = logInternalError(deps.logger, err, { route: 'operation', operation });
    void incidentId;
    const error = fromUnknown(err);
    const { status, body } = toHttpResponse(error);
    return jsonErrorResponse(body, status);
  }
}
