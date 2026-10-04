/**
 * S7 OAuth HTTP dispatch: metadata, dynamic registration, two-step
 * authorize (consent descriptor + CSRF-guarded issuance), and the token
 * endpoint. Lane 06 is its own authorization server: public clients, PKCE
 * S256 only, access-token = McpGrant Bearer, no refresh in v1.
 *
 * Two-step authorize rationale: consent issuance on a bare GET with an
 * ambient session cookie would be CSRF-issuable — a forged GET carrying
 * the attacker's PKCE challenge redirects a code (for a registered,
 * possibly loopback, redirect URI) that the attacker can exchange with
 * their own verifier. So GET only READS a consent descriptor (no code is
 * minted, CSRF-safe) for the future L5 consent screen, and issuance
 * happens on POST with the session-bound CSRF token (header or `_csrf`
 * field, same rule as every other mutating route). Standard MCP clients
 * drive a browser to GET and POST the consent form; the 302 carries the
 * code+state to the verified redirect URI.
 *
 * Error shapes: registration and authorize failures are plain safe
 * envelopes (400s; the caller is a browser/developer). The token endpoint
 * answers RFC 6749 shapes (`{error, error_description}`) because OAuth
 * clients parse those — descriptions stay generic/safe. Unknown paths and
 * wrong methods answer `not_found`, never a 405 oracle.
 *
 * Redirect matching is exact string equality against a registered URI —
 * no normalization, so trailing slashes, case, and query all matter.
 * Logging: denials are logged; successes are not (token volume), except
 * registration, which logs at info with the public client_id only.
 */
import { CSRF_FIELD } from '@canlang/contracts';
import type { BusinessError } from '@canlang/contracts';
import {
  IdentityError,
  MCP_GRANT_TTL_MS,
  OAUTH_MAX_STATE_LENGTH,
  exchangeCode,
  issueAuthCode,
  registerClient,
  validateAuthorizationRequest,
} from '@canlang/identity';
import type { OAuthDeps } from '../ports.js';
import { buildBusinessError, fromUnknown, toHttpResponse } from '../errors/envelope.js';
import { logBusinessError, logInternalError } from '../errors/logging.js';
import {
  CSRF_HEADER,
  assertPostCsrf,
  caughtToBusinessError,
  clientKey,
  jsonErrorResponse,
  resolveRequestIdentity,
} from '../http/context.js';
import {
  RATE_LIMIT_AUTH,
  RATE_LIMIT_WINDOW_MS,
  parseFormBody,
  parseJsonBody,
} from '../http/limits.js';
import {
  AUTHORIZATION_SERVER_PATH,
  AUTHORIZE_PATH,
  PROTECTED_RESOURCE_PATH,
  REGISTER_PATH,
  TOKEN_PATH,
  authorizationServerMetadata,
  protectedResourceMetadata,
  requestOrigin,
} from './metadata.js';

function requestPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return 'unknown';
  }
}

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function deny(
  deps: OAuthDeps,
  error: BusinessError,
  route: string,
  retryAfterMs?: number,
): Response {
  logBusinessError(deps.logger, error, { route });
  const { status, body } = toHttpResponse(error);
  return jsonErrorResponse(
    body,
    status,
    retryAfterMs === undefined
      ? undefined
      : { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
  );
}

/**
 * 401 with the `forbidden` code: MCP-server-style credential status (the
 * contract table would say 403, but a missing/invalid credential is 401
 * here, mirroring the S5/S6 credential paths).
 */
function unauthorized(deps: OAuthDeps, message: string, route: string): Response {
  const error = buildBusinessError('forbidden', message);
  logBusinessError(deps.logger, error, { route });
  return jsonErrorResponse(error, 401);
}

/** RFC 6749 token-endpoint error shape (OAuth clients parse this, not the safe envelope). */
function rfcError(
  deps: OAuthDeps,
  route: string,
  error: string,
  error_description: string,
  status: number,
  retryAfterMs?: number,
): Response {
  logBusinessError(deps.logger, buildBusinessError('validation', error_description), {
    route,
    oauth_error: error,
  });
  return new Response(JSON.stringify({ error, error_description }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(retryAfterMs === undefined
        ? {}
        : { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) }),
    },
  });
}

/** Fixed-window throttle mirroring the S4 auth policy (10/min per client key). */
async function checkOAuthRateLimit(
  deps: OAuthDeps,
  route: string,
  request: Request,
): Promise<{ retryAfterMs: number } | null> {
  const decision = await deps.limiter.check(
    `${route}:${clientKey(request)}`,
    RATE_LIMIT_AUTH,
    RATE_LIMIT_WINDOW_MS,
  );
  return decision.allowed ? null : { retryAfterMs: decision.retryAfterMs };
}

/** Registration and authorize-POST bodies are JSON only (form encoding is a token-endpoint matter). */
async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const mediaType =
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mediaType !== 'application/json') {
    throw new IdentityError('validation', 'Expected a JSON body.');
  }
  const body = await parseJsonBody(request);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new IdentityError('validation', 'Invalid request body.');
  }
  return body as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new IdentityError('validation', `Missing required field '${name}'.`, name);
  }
  return value;
}

/** `state` is opaque passthrough, echoed verbatim into the 302 — bounded only. */
function checkedState(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > OAUTH_MAX_STATE_LENGTH) {
    throw new IdentityError('validation', `state must be a string of at most ${OAUTH_MAX_STATE_LENGTH} characters.`);
  }
  return value;
}

async function handleRegister(deps: OAuthDeps, request: Request): Promise<Response> {
  const limited = await checkOAuthRateLimit(deps, REGISTER_PATH, request);
  if (limited !== null) {
    return deny(
      deps,
      buildBusinessError('limit', undefined, { retryable: true }),
      REGISTER_PATH,
      limited.retryAfterMs,
    );
  }
  const body = await readJsonObject(request);
  // Shape-check here so the typed call below holds; value validation
  // (URI gates, name bounds) stays single-sourced in registerClient.
  if (!Array.isArray(body['redirect_uris'])) {
    throw new IdentityError('validation', `Missing required field 'redirect_uris'.`, 'redirect_uris');
  }
  const rawName = body['client_name'];
  if (rawName !== undefined && typeof rawName !== 'string') {
    throw new IdentityError('validation', `Field 'client_name' must be a string.`, 'client_name');
  }
  const client = await registerClient(
    deps.identity.store,
    {
      redirect_uris: body['redirect_uris'] as string[],
      ...(rawName === undefined ? {} : { client_name: rawName as string }),
    },
    { clock: deps.identity.clock },
  );
  // The one logged OAuth success: client_id is a public identifier.
  deps.logger.log('info', 'oauth client registered', {
    route: REGISTER_PATH,
    client_id: client.client_id,
  });
  return jsonOk(
    {
      client_id: client.client_id,
      redirect_uris: [...client.redirect_uris],
      client_name: client.client_name,
      token_endpoint_auth_method: 'none',
    },
    201,
  );
}

interface AuthorizeContext {
  readonly user_id: string;
  readonly team_id: string | null;
  readonly sessionToken: string;
}

/**
 * Session + team gate shared by both authorize steps. Missing or invalid
 * credentials answer 401 (never a silent public downgrade); an unknown
 * explicit team answers 400 (a caller problem, not a missing route); a
 * resolved team without an active membership answers 400 — consent cannot
 * bind a team the caller is not in. Teamless consent (app-only context)
 * proceeds with a null team.
 */
async function authorizeContext(
  deps: OAuthDeps,
  request: Request,
  team: string | undefined,
): Promise<AuthorizeContext | Response> {
  let resolved;
  try {
    resolved = await resolveRequestIdentity(deps.identity.store, request, {
      clock: deps.clock,
      ...(team === undefined ? {} : { teamId: team }),
    });
  } catch (err) {
    if (err instanceof IdentityError && err.code === 'forbidden') {
      return unauthorized(deps, err.message, AUTHORIZE_PATH);
    }
    if (err instanceof IdentityError && err.code === 'not_found') {
      throw new IdentityError('validation', 'Unknown team.');
    }
    throw err;
  }
  if (resolved.sessionToken === null || resolved.identity.actor === null) {
    // The browser login page is L5's; this endpoint only demands the cookie.
    return unauthorized(deps, 'Login required.', AUTHORIZE_PATH);
  }
  if (resolved.identity.team !== null && resolved.identity.membership === null) {
    throw new IdentityError('validation', 'No active membership in this team.');
  }
  return {
    user_id: resolved.identity.actor.user_id,
    team_id: resolved.identity.team?.team_id ?? null,
    sessionToken: resolved.sessionToken,
  };
}

async function handleAuthorizeGet(deps: OAuthDeps, request: Request, url: URL): Promise<Response> {
  const params = url.searchParams;
  const teamParam = params.get('team');
  const team = teamParam === null || teamParam === '' ? undefined : teamParam;
  const context = await authorizeContext(deps, request, team);
  if (context instanceof Response) return context;
  // Unverified client/redirect/challenge failures answer 400 PLAIN — never
  // a redirect to an unverified redirect_uri.
  if (params.get('code_challenge_method') !== 'S256') {
    throw new IdentityError('validation', 'code_challenge_method must be S256.');
  }
  const client_id = params.get('client_id') ?? '';
  const redirect_uri = params.get('redirect_uri') ?? '';
  const code_challenge = params.get('code_challenge') ?? '';
  if (client_id === '') throw new IdentityError('validation', `Missing required field 'client_id'.`, 'client_id');
  if (redirect_uri === '') {
    throw new IdentityError('validation', `Missing required field 'redirect_uri'.`, 'redirect_uri');
  }
  if (code_challenge === '') {
    throw new IdentityError('validation', `Missing required field 'code_challenge'.`, 'code_challenge');
  }
  checkedState(params.get('state'));
  const client = await validateAuthorizationRequest(deps.identity.store, {
    client_id,
    redirect_uri,
    code_challenge,
  });
  // Interim descriptor (no code issued — a CSRF-safe read); L5 renders the
  // consent screen and POSTs back here. Mirrors the S4 auth descriptors.
  return jsonOk({
    client_id: client.client_id,
    client_name: client.client_name,
    redirect_uri,
    team_id: context.team_id,
    postTo: AUTHORIZE_PATH,
    csrfField: CSRF_FIELD,
  });
}

async function handleAuthorizePost(deps: OAuthDeps, request: Request): Promise<Response> {
  const body = await readJsonObject(request);
  const teamValue = body['team'];
  if (teamValue !== undefined && typeof teamValue !== 'string') {
    throw new IdentityError('validation', `Field 'team' must be a string.`, 'team');
  }
  const team = typeof teamValue === 'string' && teamValue.length > 0 ? teamValue : undefined;
  const context = await authorizeContext(deps, request, team);
  if (context instanceof Response) return context;
  await assertPostCsrf({
    sessionToken: context.sessionToken,
    headerValue: request.headers.get(CSRF_HEADER),
    fieldValue: body[CSRF_FIELD],
  });
  if (body['code_challenge_method'] !== 'S256') {
    throw new IdentityError('validation', 'code_challenge_method must be S256.');
  }
  const client_id = requiredString(body, 'client_id');
  const redirect_uri = requiredString(body, 'redirect_uri');
  const code_challenge = requiredString(body, 'code_challenge');
  const state = checkedState(body['state']);
  const { code } = await issueAuthCode(
    deps.identity.store,
    {
      user_id: context.user_id,
      team_id: context.team_id,
      client_id,
      redirect_uri,
      code_challenge,
    },
    { clock: deps.identity.clock },
  );
  // redirect_uri exactly matched a registered absolute URI, so this parse
  // cannot throw; query-bearing URIs keep their params (append, not set).
  const target = new URL(redirect_uri);
  target.searchParams.append('code', code);
  if (state !== undefined) target.searchParams.append('state', state);
  return Response.redirect(target.toString(), 302);
}

/** Token params arrive as RFC 6749 form or (accepted) JSON; values are strings only. */
async function readTokenParams(request: Request): Promise<Record<string, string>> {
  const mediaType =
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mediaType === 'application/x-www-form-urlencoded') {
    return parseFormBody(request);
  }
  if (mediaType === 'application/json') {
    const body = await parseJsonBody(request);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new IdentityError('validation', 'Invalid request body.');
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  }
  if (mediaType === '') return {};
  throw new IdentityError('validation', 'Use form or JSON encoding.');
}

async function handleToken(deps: OAuthDeps, request: Request): Promise<Response> {
  const limited = await checkOAuthRateLimit(deps, TOKEN_PATH, request);
  if (limited !== null) {
    return rfcError(
      deps,
      TOKEN_PATH,
      'temporarily_unavailable',
      'Rate limit exceeded.',
      429,
      limited.retryAfterMs,
    );
  }
  let params: Record<string, string>;
  try {
    params = await readTokenParams(request);
  } catch {
    return rfcError(deps, TOKEN_PATH, 'invalid_request', 'Use form or JSON encoding.', 400);
  }
  if (params['grant_type'] === undefined) {
    return rfcError(deps, TOKEN_PATH, 'invalid_request', 'Missing grant_type.', 400);
  }
  if (params['grant_type'] !== 'authorization_code') {
    return rfcError(deps, TOKEN_PATH, 'unsupported_grant_type', 'Only authorization_code is supported.', 400);
  }
  // Missing fields collapse into invalid_grant with the rest: which field
  // missed is not an oracle, and every exchange failure shares one text.
  try {
    const { token } = await exchangeCode(
      deps.identity.store,
      {
        code: params['code'] ?? '',
        client_id: params['client_id'] ?? '',
        redirect_uri: params['redirect_uri'] ?? '',
        code_verifier: params['code_verifier'] ?? '',
      },
      { clock: deps.identity.clock },
    );
    return jsonOk({
      access_token: token,
      token_type: 'Bearer',
      expires_in: Math.floor(MCP_GRANT_TTL_MS / 1000),
    });
  } catch (err) {
    if (err instanceof IdentityError && err.code === 'validation') {
      return rfcError(deps, TOKEN_PATH, 'invalid_grant', 'Invalid or expired code.', 400);
    }
    throw err;
  }
}

function handleMetadata(deps: OAuthDeps, request: Request, pathname: string): Response {
  const origin = requestOrigin(request.url);
  if (origin === null) {
    return deny(deps, buildBusinessError('not_found', 'Not found.'), pathname);
  }
  return jsonOk(
    pathname === PROTECTED_RESOURCE_PATH
      ? protectedResourceMetadata(origin)
      : authorizationServerMetadata(origin),
  );
}

/**
 * Dispatch one OAuth request: well-known metadata (GET only), registration
 * (POST JSON), two-step authorize (GET descriptor / POST issuance+302),
 * and the token endpoint (POST form-or-JSON). Anything unmapped is
 * `not_found`.
 */
export async function handleOAuthRequest(deps: OAuthDeps, request: Request): Promise<Response> {
  const pathname = requestPath(request.url);
  const method = request.method.toUpperCase();
  try {
    if (
      method === 'GET' &&
      (pathname === PROTECTED_RESOURCE_PATH || pathname === AUTHORIZATION_SERVER_PATH)
    ) {
      return handleMetadata(deps, request, pathname);
    }
    if (method === 'POST' && pathname === REGISTER_PATH) {
      return await handleRegister(deps, request);
    }
    if (pathname === AUTHORIZE_PATH) {
      if (method === 'GET') return await handleAuthorizeGet(deps, request, new URL(request.url));
      if (method === 'POST') return await handleAuthorizePost(deps, request);
      return deny(deps, buildBusinessError('not_found', 'Not found.'), pathname);
    }
    if (method === 'POST' && pathname === TOKEN_PATH) {
      return await handleToken(deps, request);
    }
    return deny(deps, buildBusinessError('not_found', 'Not found.'), pathname);
  } catch (err) {
    if (err instanceof IdentityError) {
      return deny(deps, caughtToBusinessError(err), pathname);
    }
    const incidentId = logInternalError(deps.logger, err, { route: pathname });
    void incidentId;
    const error = fromUnknown(err);
    const { status, body } = toHttpResponse(error);
    return jsonErrorResponse(body, status);
  }
}
