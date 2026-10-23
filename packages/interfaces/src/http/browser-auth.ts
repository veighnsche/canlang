/** Browser presentation only; Identity handlers remain the authority for POSTs. */
import { CSRF_FIELD, TEAM_FIELD } from '@canlang/contracts';
import { deriveCsrfToken, IdentityError, resolveIdentity } from '@canlang/identity';
import { escapeAttr, escapeHtml, message, renderLogin } from '@canlang/ui';
import type { AuthHttpDeps } from '../ports.js';
import { resolveRequestIdentity } from './context.js';
import { buildPresentationContext } from './presentation.js';

/** Default, wildcard and JSON clients keep the established JSON contract. */
export function wantsBrowserAuth(request: Request): boolean {
  let html = 0, json = 0;
  for (const entry of (request.headers.get('accept') ?? '').split(',')) {
    const [type, ...params] = entry.trim().toLowerCase().split(';');
    const quality = params.find(part => part.trim().startsWith('q='));
    const q = quality === undefined ? 1 : Number(quality.trim().slice(2));
    if (!Number.isFinite(q) || q < 0 || q > 1) continue;
    if (type === 'text/html') html = Math.max(html, q);
    if (type === 'application/json') json = Math.max(json, q);
  }
  return html > 0 && html > json;
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', vary: 'Accept',
  } });
}

/** Only fixed dispatcher-owned same-app paths become redirects. Preserve cookies. */
export async function browserAuthResponse(request: Request, response: Response, target: '/' | '/auth/login' | '/auth/select-team', redirectSuccess = true): Promise<Response> {
  if (!wantsBrowserAuth(request) || (!redirectSuccess && response.status !== 429)) return response;
  if (response.status !== 200) {
    const headers = new Headers(response.headers);
    headers.set('content-type', 'text/html; charset=utf-8'); headers.set('cache-control', 'no-store'); headers.set('vary', 'Accept');
    return new Response('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign-in request failed</title><main><h1>Request failed</h1><p>The request could not be completed. Try again.</p><a href="/auth/login">Return to sign in</a></main></html>', { status: response.status, headers });
  }
  const headers = new Headers(response.headers);
  headers.delete('content-type'); headers.set('location', target); headers.set('cache-control', 'no-store'); headers.set('vary', 'Accept');
  return new Response(null, { status: 303, headers });
}

export async function renderBrowserLogin(deps: AuthHttpDeps, request: Request, token: string, failureStatus?: number): Promise<Response> {
  // Login is public recovery presentation: old credentials cannot prevent a fresh attempt.
  const identity = await resolveIdentity(deps.identity.store, {}, { clock: deps.clock });
  const context = buildPresentationContext({ request, pathname: '/auth/login', isPartial: false,
    appDefaultLocale: 'en', csrfToken: '', principal: identity,
    query: async () => { throw new Error('Auth screens do not query app records.'); } });
  return htmlResponse(await renderLogin({ context, action: '/auth/login', brand: message('Sign in'),
    idPrefix: 'auth-login', preSessionToken: token,
    ...(failureStatus === undefined ? {} : { error: message('Sign-in failed. Try again.') }) }), failureStatus ?? 200);
}

export async function renderBrowserTeams(deps: AuthHttpDeps, request: Request): Promise<Response> {
  const { identity, sessionToken } = await resolveRequestIdentity(deps.identity.store, request, { clock: deps.clock });
  if (sessionToken === null || identity.actor === null) {
    return new Response(null, { status: 303, headers: { location: '/auth/login', 'cache-control': 'no-store', vary: 'Accept' } });
  }
  const params = new URL(request.url).searchParams;
  const cursors = params.getAll('after');
  if (params.size !== cursors.length || cursors.length > 1 ||
      (cursors.length === 1 && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cursors[0] ?? ''))) {
    throw new IdentityError('validation', 'Invalid team cursor.');
  }
  const page = await deps.identity.store.listActiveUserTeamsPage(identity.actor.user_id, cursors[0] ?? null);
  const teams = page.slice(0, 100);
  const csrf = escapeAttr(await deriveCsrfToken(sessionToken));
  const csrfInput = `<input type="hidden" name="${CSRF_FIELD}" value="${csrf}">`;
  const picker = teams.length === 0 ? '<p>No active team memberships are available for this account.</p>' :
    `<form method="POST" action="/auth/select-team">${csrfInput}<label for="auth-team">Team</label><select id="auth-team" name="${TEAM_FIELD}" required>` +
    teams.map(team => `<option value="${escapeAttr(team.team_id)}">${escapeHtml(team.team_id)}</option>`).join('') +
    '</select><button type="submit">Select team</button></form>';
  const next = page.length > 100 ? `<a href="/auth/select-team?after=${encodeURIComponent(teams.at(-1)!.team_id)}">More teams</a>` : '';
  return htmlResponse('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Select team</title><link rel="stylesheet" href="/assets/browser/can-style.css"></head><body><main><h1>Select team</h1>' +
    picker + next + `<form method="POST" action="/auth/logout">${csrfInput}<button type="submit">Sign out</button></form></main></body></html>`);
}

/** No offer details are read on GET; addressed-email authority is checked on POST. */
export async function renderBrowserInvitation(deps: AuthHttpDeps, request: Request, invitationId: string): Promise<Response> {
  const { identity, sessionToken } = await resolveRequestIdentity(deps.identity.store, request, { clock: deps.clock });
  if (sessionToken === null || identity.actor === null) {
    return htmlResponse('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Accept invitation</title><main><h1>Accept invitation</h1><p>Sign in with the invited email address, then open your invitation link again.</p><a href="/auth/login">Sign in</a></main></html>');
  }
  const csrf = escapeAttr(await deriveCsrfToken(sessionToken));
  return htmlResponse('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Accept invitation</title><link rel="stylesheet" href="/assets/browser/can-style.css"></head><body><main><h1>Accept invitation</h1>' +
    `<p>Accept using ${escapeHtml(identity.actor.email)}.</p><form method="POST" action="/auth/invite"><input type="hidden" name="${CSRF_FIELD}" value="${csrf}"><label for="auth-invitation">Invitation</label><input id="auth-invitation" name="invitation_id" required value="${escapeAttr(invitationId)}"><button type="submit">Accept invitation</button></form></main></body></html>`);
}
