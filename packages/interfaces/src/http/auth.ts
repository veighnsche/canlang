/**
 * Auth endpoints over the real @canlang/identity stack (S4).
 *
 * Explicit HTML clients receive login/team-selection screens and native POST
 * redirects. Default and JSON clients retain descriptors and JSON outcomes.
 * Login GET mints one throttled browser-bound pre-session token; team
 * discovery and team-picker GETs are side-effect-free and bounded.
 * Registration, verification and recovery retain their JSON contracts.
 *
 * Method/path matrix: only the documented method+subpath pairs dispatch;
 * every other combination (unknown `/auth/*` subpath, wrong method) is
 * `not_found` JSON, so the matrix reveals nothing about which half missed.
 *
 * CSRF: the session-authed POSTs (logout, select-team, select-team/clear)
 * require the session-bound token via the `x-csrf-token` header or the
 * `_csrf` field. Login has no session yet, so it carries a single-use
 * anonymous browser-bound pre-session token instead: `GET /auth/login` mints it into
 * the descriptor (`preSessionToken`) and host-only cookie, the POST
 * must present that same cookie and `_presession`, and every credential-checked login POST consumes it — a
 * failed attempt refetches the descriptor (429s and malformed bodies
 * return before the consume). Register/recover/verify stay tokenless and
 * rate-limited: those routes plant no session, so there is nothing for a
 * login-CSRF forgery to fixate (stricter mail policy for recovery).
 *
 * Registration conflict passes through as `conflict` (409): registration
 * MUST tell the caller the address is taken, else legitimate users cannot
 * proceed — unlike sign-in and recovery, which stay oracle-free.
 */
import { browserAuthResponse, renderBrowserInvitation, renderBrowserLogin, renderBrowserTeams, wantsBrowserAuth } from './browser-auth.js';
import { CSRF_FIELD, PRESESSION_FIELD, TEAM_FIELD } from '@canlang/contracts';
import type { BusinessError } from '@canlang/contracts';
import {
  IdentityError,
  acceptInvitation,
  deriveCsrfToken,
  buildPreSessionCookie,
  buildPreSessionClearCookie,
  parsePreSessionCookie,
  buildSessionClearCookie,
  buildSessionCookie,
  clearTeamSelection,
  consumePreSessionToken,
  loginWithPassword,
  mintPreSessionToken,
  recoverAccount,
  registerWithEmail,
  requestRecovery,
  revokeSessionByToken,
  selectTeam,
  verifyEmail,
} from '@canlang/identity';
import type { AuthHttpDeps } from '../ports.js';
import { buildBusinessError, fromUnknown, toHttpResponse } from '../errors/envelope.js';
import { logBusinessError, logInternalError } from '../errors/logging.js';
import {
  CSRF_HEADER,
  assertPostCsrf,
  assertTrustedAuthOrigin,
  caughtToBusinessError,
  jsonErrorResponse,
  resolveRequestIdentity,
} from './context.js';
import {
  checkAuthRateLimit,
  parseFormBody,
  parseJsonBody,
  retryAfterMsOf,
} from './limits.js';

/** One descriptor field: name, coarse input type, required flag. */
export interface AuthFormField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
}

/** JSON GET descriptor for one auth form. */
export interface AuthFormDescriptor {
  readonly form: string;
  readonly fields: readonly AuthFormField[];
  readonly postTo: string;
  readonly csrfField: string;
  /**
   * Single-use login token, present on the login descriptor only. The form
   * posts it back as `_presession`; every credential-checked login POST
   * consumes it.
   */
  readonly preSessionToken?: string;
}

/**
 * Throttle label for descriptor mints. Distinct from `/auth/login` so page
 * loads don't eat the login-attempt budget (and vice versa); the limiter
 * keys on `${route}:${clientKey}`.
 */
const LOGIN_DESCRIPTOR_THROTTLE = '/auth/login/descriptor';
const MAX_LISTED_TEAMS = 100;
const TEAM_CURSOR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function descriptor(form: string, fields: readonly AuthFormField[], postTo: string): AuthFormDescriptor {
  return { form, fields, postTo, csrfField: CSRF_FIELD };
}

function mailUnavailable(): Response {
  return jsonErrorResponse(buildBusinessError('busy', 'Authentication mail is unavailable.', { retryable: true }), 503);
}

function jsonOk(body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function deny(deps: AuthHttpDeps, error: BusinessError, route: string): Response {
  logBusinessError(deps.logger, error, { route });
  const { status, body } = toHttpResponse(error);
  const retryAfterMs = retryAfterMsOf(error);
  return jsonErrorResponse(
    body,
    status,
    { 'cache-control': 'no-store',
      ...(retryAfterMs === null ? {} : { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) }) },
  );
}

/**
 * Read an auth POST body: JSON objects, or flat form maps (scalar auth fields
 * need no JSON coercion). No content-type means no body (`{}`, for
 * header-CSRF posts like logout). Anything else is `validation`.
 */
async function readAuthBody(request: Request): Promise<Record<string, unknown>> {
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (mediaType === '') return {};
  if (mediaType === 'application/json') {
    const body = await parseJsonBody(request);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new IdentityError('validation', 'Invalid request body.');
    }
    return body as Record<string, unknown>;
  }
  if (mediaType === 'application/x-www-form-urlencoded') {
    return await parseFormBody(request);
  }
  throw new IdentityError('validation', 'Unsupported content type.');
}

/** Required non-empty string member; failure names the field. */
function requiredString(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new IdentityError('validation', `Missing required field '${name}'.`, name);
  }
  return value;
}

async function withRateLimit(
  deps: AuthHttpDeps,
  route: string,
  request: Request,
): Promise<Response | null> {
  const limited = await checkAuthRateLimit(deps, route, request);
  return limited === null ? null : deny(deps, limited, route);
}

async function handleRegister(deps: AuthHttpDeps, request: Request): Promise<Response> {
  if (deps.identity.mail === undefined) return mailUnavailable();
  const limited = await withRateLimit(deps, '/auth/register', request);
  if (limited !== null) return limited;
  const body = await readAuthBody(request);
  await registerWithEmail(
    deps.identity.store,
    deps.identity.mail,
    { email: requiredString(body, 'email'), password: requiredString(body, 'password') },
    { clock: deps.identity.clock, verifyBaseUrl: deps.identity.verifyBaseUrl },
  );
  return jsonOk({ ok: true });
}

async function handleVerifyPost(deps: AuthHttpDeps, request: Request): Promise<Response> {
  const limited = await withRateLimit(deps, '/auth/verify', request);
  if (limited !== null) return limited;
  const body = await readAuthBody(request);
  await verifyEmail(
    deps.identity.store,
    { token: requiredString(body, 'token') },
    { clock: deps.identity.clock },
  );
  return jsonOk({ ok: true });
}

async function handleLoginDescriptor(deps: AuthHttpDeps, request: Request, failureStatus?: number): Promise<Response> {
  const limited = await withRateLimit(deps, LOGIN_DESCRIPTOR_THROTTLE, request);
  if (limited !== null) return limited;
  const { token } = await mintPreSessionToken(deps.identity.store, { clock: deps.identity.clock });
  if (wantsBrowserAuth(request)) {
    const response = await renderBrowserLogin(deps, request, token, failureStatus);
    response.headers.set('set-cookie', buildPreSessionCookie(token, { secure: deps.secureCookies }));
    return response;
  }
  return jsonOk({ ...LOGIN_DESCRIPTOR(), preSessionToken: token }, { 'cache-control': 'no-store',
    'set-cookie': buildPreSessionCookie(token, { secure: deps.secureCookies }) });
}

async function handleLogin(deps: AuthHttpDeps, request: Request): Promise<Response> {
  const limited = await withRateLimit(deps, '/auth/login', request);
  if (limited !== null) return limited;
  const body = await readAuthBody(request);
  const presented = body[PRESESSION_FIELD];
  const browserToken = parsePreSessionCookie(request.headers.get('cookie') ?? undefined);
  if (browserToken === null || typeof presented !== 'string' || browserToken !== presented) {
    throw new IdentityError('forbidden', 'Invalid or expired login token.');
  }
  const consumed = await consumePreSessionToken(deps.identity.store, presented, { clock: deps.identity.clock });
  let response: Response;
  try {
    if (!consumed) throw new IdentityError('forbidden', 'Invalid or expired login token.');
    const { token } = await loginWithPassword(
      deps.identity.store,
      { email: requiredString(body, 'email'), password: requiredString(body, 'password') },
      { clock: deps.identity.clock },
    );
    response = jsonOk({ ok: true }, {
      'set-cookie': buildSessionCookie(token, {
        maxAgeSeconds: deps.identity.sessionMaxAgeSeconds, secure: deps.secureCookies,
      }),
    });
  } catch (err) {
    response = authFailureResponse(deps, err, '/auth/login');
  }
  // Separate Set-Cookie fields preserve the new session and clear the consumed
  // anonymous binding, including failed credential attempts.
  response.headers.append('set-cookie', buildPreSessionClearCookie({ secure: deps.secureCookies }));
  return response;
}

async function handleLogout(deps: AuthHttpDeps, request: Request): Promise<Response> {
  // Fully idempotent: unknown, revoked, or expired sessions clear the jar
  // and answer ok — double-logout and stale tabs never 403.
  let sessionToken: string | null;
  try {
    sessionToken = (
      await resolveRequestIdentity(deps.identity.store, request, { clock: deps.clock })
    ).sessionToken;
  } catch {
    return jsonOk({ ok: true }, { 'set-cookie': buildSessionClearCookie({ secure: deps.secureCookies }) });
  }
  if (sessionToken === null) {
    return jsonOk({ ok: true }, { 'set-cookie': buildSessionClearCookie({ secure: deps.secureCookies }) });
  }
  const body = await readAuthBody(request);
  await assertPostCsrf({
    sessionToken,
    headerValue: request.headers.get(CSRF_HEADER),
    fieldValue: body[CSRF_FIELD],
  });
  await revokeSessionByToken(deps.identity.store, { token: sessionToken });
  return jsonOk({ ok: true }, { 'set-cookie': buildSessionClearCookie({ secure: deps.secureCookies }) });
}

async function handleRecoverPost(deps: AuthHttpDeps, request: Request): Promise<Response> {
  if (deps.identity.mail === undefined) return mailUnavailable();
  const limited = await withRateLimit(deps, '/auth/recover', request);
  if (limited !== null) return limited;
  const body = await readAuthBody(request);
  await requestRecovery(
    deps.identity.store,
    deps.identity.mail,
    { email: requiredString(body, 'email') },
    { clock: deps.identity.clock, recoveryBaseUrl: deps.identity.recoveryBaseUrl },
  );
  return jsonOk({ ok: true });
}

async function handleRecoverConfirm(deps: AuthHttpDeps, request: Request): Promise<Response> {
  const limited = await withRateLimit(deps, '/auth/recover/confirm', request);
  if (limited !== null) return limited;
  const body = await readAuthBody(request);
  await recoverAccount(
    deps.identity.store,
    { token: requiredString(body, 'token'), new_password: requiredString(body, 'new_password') },
    { clock: deps.identity.clock },
  );
  return jsonOk({ ok: true });
}

/** Invitation IDs name addressed offers; only the current verified user may accept. */
async function handleInvitation(deps: AuthHttpDeps, request: Request): Promise<Response> {
  const { identity, sessionToken } = await resolveRequestIdentity(deps.identity.store, request, { clock: deps.clock });
  if (sessionToken === null || identity.actor === null) {
    throw new IdentityError('forbidden', 'Authentication required.');
  }
  const body = await readAuthBody(request);
  if (Object.keys(body).some(name => name !== 'invitation_id' && name !== CSRF_FIELD)) {
    throw new IdentityError('validation', 'Invalid invitation fields.');
  }
  await assertPostCsrf({ sessionToken, headerValue: request.headers.get(CSRF_HEADER), fieldValue: body[CSRF_FIELD] });
  const membership = await acceptInvitation(deps.identity.store,
    { invitation_id: requiredString(body, 'invitation_id'), user_id: identity.actor.user_id },
    { clock: deps.identity.clock });
  return jsonOk({ ok: true, team_id: membership.team_id }, { 'cache-control': 'no-store' });
}

async function handleInvitationDescriptor(deps: AuthHttpDeps, request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const ids = params.getAll('invitation_id');
  if (params.size !== ids.length || ids.length > 1 || ids.some(id => !TEAM_CURSOR.test(id))) {
    throw new IdentityError('validation', 'Invalid invitation.');
  }
  if (wantsBrowserAuth(request)) return await renderBrowserInvitation(deps, request, ids[0] ?? '');
  const { identity, sessionToken } = await resolveRequestIdentity(deps.identity.store, request, { clock: deps.clock });
  if (sessionToken === null || identity.actor === null) throw new IdentityError('forbidden', 'Authentication required.');
  return jsonOk({ ...descriptor('invite', [{ name: 'invitation_id', type: 'text', required: true }], '/auth/invite'),
    inputs: { invitation_id: ids[0] ?? '' }, csrfToken: await deriveCsrfToken(sessionToken) }, { 'cache-control': 'no-store' });
}

async function handleSelectTeam(deps: AuthHttpDeps, request: Request): Promise<Response> {
  const { sessionToken } = await resolveRequestIdentity(deps.identity.store, request, {
    clock: deps.clock,
  });
  if (sessionToken === null) {
    throw new IdentityError('forbidden', 'Authentication required.');
  }
  const body = await readAuthBody(request);
  await assertPostCsrf({
    sessionToken,
    headerValue: request.headers.get(CSRF_HEADER),
    fieldValue: body[CSRF_FIELD],
  });
  const { team_id } = await selectTeam(
    deps.identity.store,
    { session_token: sessionToken, team_id: requiredString(body, TEAM_FIELD) },
    { clock: deps.identity.clock },
  );
  return jsonOk({ ok: true, team_id });
}

/** Discover only the current session actor's active, live team memberships. */
async function handleTeams(deps: AuthHttpDeps, request: Request): Promise<Response> {
  const { identity, sessionToken } = await resolveRequestIdentity(deps.identity.store, request, { clock: deps.clock });
  if (sessionToken === null || identity.actor === null) {
    throw new IdentityError('forbidden', 'Authentication required.');
  }
  const params = new URL(request.url).searchParams;
  const cursors = params.getAll('after');
  if (params.size !== cursors.length || cursors.length > 1 ||
      (cursors.length === 1 && !TEAM_CURSOR.test(cursors[0] ?? ''))) {
    throw new IdentityError('validation', 'Invalid team cursor.');
  }
  const after = cursors[0] ?? null;
  const page = await deps.identity.store.listActiveUserTeamsPage(identity.actor.user_id, after);
  const teams = page.slice(0, MAX_LISTED_TEAMS);
  const truncated = page.length > MAX_LISTED_TEAMS;
  return jsonOk({ teams, truncated, next_after: truncated ? teams.at(-1)!.team_id : null }, { 'cache-control': 'no-store' });
}

async function handleSelectTeamClear(deps: AuthHttpDeps, request: Request): Promise<Response> {
  const { sessionToken } = await resolveRequestIdentity(deps.identity.store, request, {
    clock: deps.clock,
  });
  if (sessionToken === null) {
    throw new IdentityError('forbidden', 'Authentication required.');
  }
  const body = await readAuthBody(request);
  await assertPostCsrf({
    sessionToken,
    headerValue: request.headers.get(CSRF_HEADER),
    fieldValue: body[CSRF_FIELD],
  });
  await clearTeamSelection(deps.identity.store, { session_token: sessionToken }, { clock: deps.identity.clock });
  return jsonOk({ ok: true });
}

const LOGIN_DESCRIPTOR = (): AuthFormDescriptor =>
  descriptor(
    'login',
    [
      { name: 'email', type: 'email', required: true },
      { name: 'password', type: 'password', required: true },
    ],
    '/auth/login',
  );

const REGISTER_DESCRIPTOR = (): AuthFormDescriptor =>
  descriptor(
    'register',
    [
      { name: 'email', type: 'email', required: true },
      { name: 'password', type: 'password', required: true },
    ],
    '/auth/register',
  );

const VERIFY_DESCRIPTOR = (): AuthFormDescriptor =>
  descriptor('verify', [{ name: 'token', type: 'text', required: true }], '/auth/verify');

const RECOVER_DESCRIPTOR = (): AuthFormDescriptor =>
  descriptor('recover', [{ name: 'email', type: 'email', required: true }], '/auth/recover');

const SELECT_TEAM_DESCRIPTOR = (): AuthFormDescriptor =>
  descriptor('select-team', [{ name: TEAM_FIELD, type: 'text', required: true }], '/auth/select-team');

function authFailureResponse(deps: AuthHttpDeps, err: unknown, pathname: string): Response {
  if (err instanceof IdentityError) return deny(deps, caughtToBusinessError(err), pathname);
  logInternalError(deps.logger, err, { route: pathname });
  const { status, body } = toHttpResponse(fromUnknown(err));
  return jsonErrorResponse(body, status, { 'cache-control': 'no-store' });
}

/**
 * Dispatch one `/auth/*` request. Form GETs return interim descriptors;
 * team discovery returns active memberships. The login GET mints a throttled
 * pre-session token; the other GETs are side-effect-free. POSTs run the
 * identity flows above. Anything unmapped is `not_found` JSON.
 */
async function dispatchAuthGet(deps: AuthHttpDeps, request: Request, pathname: string, method: string): Promise<Response | null> {
  if (method === 'GET' && pathname === '/auth/login') {
    return browserAuthResponse(request, await handleLoginDescriptor(deps, request), '/auth/login', false);
  }
  if (method === 'GET' && pathname === '/auth/register') return jsonOk(REGISTER_DESCRIPTOR());
  // Side-effect-free: the token query only pre-selects the form; the POST consumes it.
  if (method === 'GET' && pathname === '/auth/verify') return jsonOk(VERIFY_DESCRIPTOR());
  if (method === 'GET' && pathname === '/auth/recover') return jsonOk(RECOVER_DESCRIPTOR());
  if (method === 'GET' && pathname === '/auth/select-team') {
    return wantsBrowserAuth(request) ? await renderBrowserTeams(deps, request) : jsonOk(SELECT_TEAM_DESCRIPTOR());
  }
  if (method === 'GET' && pathname === '/auth/invite') return await handleInvitationDescriptor(deps, request);
  if (method === 'GET' && pathname === '/auth/teams') return await handleTeams(deps, request);
  return null;
}

async function dispatchAuthPost(deps: AuthHttpDeps, request: Request, pathname: string, method: string): Promise<Response | null> {
  if (method === 'POST' && pathname === '/auth/invite') {
    return browserAuthResponse(request, await handleInvitation(deps, request), '/auth/select-team');
  }
  if (method === 'POST' && pathname === '/auth/register') return await handleRegister(deps, request);
  if (method === 'POST' && pathname === '/auth/verify') return await handleVerifyPost(deps, request);
  if (method === 'POST' && pathname === '/auth/login') {
    const response = await handleLogin(deps, request);
    if (wantsBrowserAuth(request) && response.status !== 200 && response.status !== 429) {
      return browserAuthResponse(request, await handleLoginDescriptor(deps, request, response.status), '/auth/login', false);
    }
    return browserAuthResponse(request, response, '/auth/select-team');
  }
  if (method === 'POST' && pathname === '/auth/logout') {
    return browserAuthResponse(request, await handleLogout(deps, request), '/auth/login');
  }
  if (method === 'POST' && pathname === '/auth/recover') return await handleRecoverPost(deps, request);
  if (method === 'POST' && pathname === '/auth/recover/confirm') {
    return await handleRecoverConfirm(deps, request);
  }
  if (method === 'POST' && pathname === '/auth/select-team') {
    return browserAuthResponse(request, await handleSelectTeam(deps, request), '/');
  }
  if (method === 'POST' && pathname === '/auth/select-team/clear') {
    return await handleSelectTeamClear(deps, request);
  }
  return null;
}

export async function handleAuthRequest(deps: AuthHttpDeps, request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const method = request.method;
  try {
    if ((method === 'GET' && pathname === '/auth/login') || (method === 'POST' &&
        ['/auth/login', '/auth/logout', '/auth/select-team', '/auth/select-team/clear', '/auth/invite'].includes(pathname))) {
      assertTrustedAuthOrigin(request, deps.authOrigin);
    }
    const getResponse = await dispatchAuthGet(deps, request, pathname, method);
    if (getResponse !== null) return getResponse;
    const postResponse = await dispatchAuthPost(deps, request, pathname, method);
    if (postResponse !== null) return postResponse;
    return deny(deps, buildBusinessError('not_found', 'Unknown auth route.'), pathname);
  } catch (err) {
    const response = authFailureResponse(deps, err, pathname);
    return ['/auth/login', '/auth/select-team', '/auth/logout', '/auth/invite'].includes(pathname)
      ? browserAuthResponse(request, response, '/auth/login') : response;
  }
}
