/**
 * S4 page dispatch: route matching, admission, discovery, and rendering.
 *
 * GET/HEAD only; any other method answers `not_found` (authored mapping
 * for 405/unknown, mirroring routes.ts). Flow: strip a non-root trailing
 * slash with a 308 (query preserved), match the descriptor (exact path,
 * else `{Token}` segments with the FULL token as the binding key),
 * resolve the caller (a present-but-bad credential is `forbidden`, never
 * a silent public downgrade), admit the page, then render. Full pages
 * run discovery admission per candidate (`admitted` links, `denied`
 * hides, `unavailable` marks the navigation incomplete) inside the
 * dispatcher-supplied shell; partials (`HX-Request`) render the fragment
 * without a shell. Rendered bytes past PAGE_MAX_RESPONSE_BYTES are an
 * internal generator failure. Every unexpected throw is journaled under
 * an incident id and answers the generic envelope; denial throws keep
 * their safe code and message.
 */
import {
  COLLECTION_DEFAULT_LIMIT,
  COLLECTION_MAX_LIMIT,
  DEFAULT_THEME,
  PAGE_MAX_RESPONSE_BYTES,
} from '@canlang/contracts';
import type {
  AccountMenuData,
  AdmittedBindings,
  AdmissionOutcome,
  ListQueryArgs,
  ListQueryResult,
  NavigationResult,
  PageDescriptor,
  PresentationContext,
  ResolvedIdentity,
  RowQueryRunner,
  ShellData,
  TeamOption,
} from '@canlang/contracts';
import { deriveCsrfToken, parseSessionCookie } from '@canlang/identity';
import { buildNavigation, renderPage, selectDiscoveryCandidates } from '@canlang/ui';
import type { HttpDeps } from '../ports.js';
import {
  caughtToBusinessError,
  isBusinessThrow,
  jsonErrorResponse,
  resolveRequestIdentity,
} from './context.js';
import { buildBusinessError, fromUnknown, httpStatusFor } from '../errors/envelope.js';
import { logInternalError } from '../errors/logging.js';
import { isPartialRequest } from './fragments.js';
import { SIGN_IN_PATH, SIGN_OUT_PATH, SWITCH_TEAM_PATH } from './routes.js';

/** Authored unknown/method response: `not_found`, mirroring routes.ts. */
function notFoundResponse(): Response {
  const error = buildBusinessError('not_found', 'Not found.');
  return jsonErrorResponse(error, httpStatusFor(error.code));
}

/** Generic internal response after journaling the redacted detail. */
function internalResponse(deps: HttpDeps, err: unknown, path: string): Response {
  logInternalError(deps.logger, err, { path });
  const error = fromUnknown(err);
  return jsonErrorResponse(error, httpStatusFor(error.code));
}

/** Render-path throw mapping: business denials keep meaning, else internal. */
function renderThrowResponse(deps: HttpDeps, err: unknown, path: string): Response {
  if (isBusinessThrow(err)) {
    const error = caughtToBusinessError(err);
    return jsonErrorResponse(error, httpStatusFor(error.code));
  }
  return internalResponse(deps, err, path);
}

/**
 * Bind the row-query runner to canonical reads. `invocation` carries the
 * resolved identity (opaque to presentation); the runner maps
 * (model, args) to the `<model>.list` read operation per the DESIGN
 * section-10 tool-name convention, enforces collection bounds, and throws
 * business denials (mapped by the render path) instead of hiding them.
 * The args→inputs mapping (where→filters passthrough) is lane-06 authored,
 * pending L3 acknowledgment.
 */
function bindRowQueryRunner(deps: HttpDeps, identity: ResolvedIdentity): RowQueryRunner {
  return async (_invocation: unknown, model: string, args: ListQueryArgs): Promise<ListQueryResult> => {
    const limit = args.limit ?? COLLECTION_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > COLLECTION_MAX_LIMIT) {
      throw buildBusinessError('validation', 'Invalid collection limit.');
    }
    const outcome = await deps.invoker.invokeRead(
      {
        operation: `${model}.list`,
        inputs: {
          ...(args.parent === undefined ? {} : { parent: args.parent }),
          ...(args.where === undefined ? {} : { filters: args.where }),
          limit,
          ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
        },
      },
      identity,
    );
    if ('error' in outcome) throw outcome.error;
    const result = outcome.result as Partial<ListQueryResult> | null | undefined;
    if (
      typeof result !== 'object' ||
      result === null ||
      !Array.isArray(result.rows) ||
      !Array.isArray(result.columns) ||
      (result.nextCursor !== undefined && typeof result.nextCursor !== 'string')
    ) {
      throw new Error(`read ${model}.list returned a malformed collection result.`);
    }
    return { rows: result.rows, columns: result.columns, ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }) };
  };
}

interface RouteMatch {
  readonly descriptor: PageDescriptor;
  readonly routeBindings: Record<string, unknown>;
}

/**
 * Match one `{Token}` pattern against a pathname. Segments must align 1:1;
 * a `{...}` pattern segment captures any non-empty segment with the FULL
 * token text (e.g. `Invoice.id`) as the key and the decoded segment as the
 * value (lane-06 authored, pending L1 ack). Returns null on any mismatch
 * or undecodable segment.
 */
function matchPattern(pattern: string, pathname: string): Record<string, unknown> | null {
  if (!pattern.includes('{')) return null;
  const patternSegments = pattern.split('/');
  const pathSegments = pathname.split('/');
  if (patternSegments.length !== pathSegments.length) return null;
  const bindings: Record<string, unknown> = {};
  for (let i = 0; i < patternSegments.length; i++) {
    const expected = patternSegments[i];
    const actual = pathSegments[i];
    if (expected === undefined || actual === undefined) return null;
    if (expected.startsWith('{') && expected.endsWith('}') && expected.length > 2) {
      if (actual.length === 0) return null;
      try {
        bindings[expected.slice(1, -1)] = decodeURIComponent(actual);
      } catch {
        return null;
      }
    } else if (expected !== actual) {
      return null;
    }
  }
  return bindings;
}

/** Exact path first, then `{Token}` patterns, both in registry order. */
function matchDescriptor(
  descriptors: readonly PageDescriptor[],
  pathname: string,
): RouteMatch | null {
  for (const descriptor of descriptors) {
    if (descriptor.path === pathname) return { descriptor, routeBindings: {} };
  }
  for (const descriptor of descriptors) {
    const routeBindings = matchPattern(descriptor.path, pathname);
    if (routeBindings !== null) return { descriptor, routeBindings };
  }
  return null;
}

/**
 * Parse Accept-Language: split on ',', take up to 10 tags, strip `;`
 * params, drop empties. Invalid tags pass through here; the renderer
 * skips them during locale resolution.
 */
function parseAcceptLanguage(header: string | null): readonly string[] {
  if (header === null) return [];
  return header
    .split(',', 10)
    .map((part) => {
      const semi = part.indexOf(';');
      return (semi === -1 ? part : part.slice(0, semi)).trim();
    })
    .filter((tag) => tag.length > 0);
}

/** Switcher options: active memberships with a live team, id-prefix labels. */
async function teamOptions(deps: HttpDeps, identity: ResolvedIdentity): Promise<TeamOption[]> {
  if (identity.actor === null) return [];
  const memberships = await deps.identity.store.listUserMemberships(identity.actor.user_id);
  const options: TeamOption[] = [];
  for (const membership of memberships) {
    if (membership.status !== 'active') continue;
    const team = await deps.identity.store.findTeamById(membership.team_id);
    if (team === null) continue;
    options.push({ id: team.team_id, label: team.team_id.slice(0, 8) });
  }
  return options;
}

/**
 * Render one discovery admission outcome per candidate with the SAME
 * identity and `{}` bindings (dynamic patterns never reach discovery).
 * Business denials hide the link; unexpected throws mark the navigation
 * incomplete after an incident-logged journal entry.
 */
async function admitDiscovery(
  deps: HttpDeps,
  candidates: readonly PageDescriptor[],
  identity: ResolvedIdentity,
): Promise<ReadonlyMap<PageDescriptor, AdmissionOutcome>> {
  const outcomes = new Map<PageDescriptor, AdmissionOutcome>();
  for (const candidate of candidates) {
    try {
      await candidate.admit(identity, {});
      outcomes.set(candidate, 'admitted');
    } catch (err) {
      if (isBusinessThrow(err)) {
        outcomes.set(candidate, 'denied');
      } else {
        logInternalError(deps.logger, err, { path: candidate.path });
        outcomes.set(candidate, 'unavailable');
      }
    }
  }
  return outcomes;
}

/**
 * Cap the rendered bytes: past PAGE_MAX_RESPONSE_BYTES the generator is
 * faulty (internal), else 200 HTML — HEAD with the same headers and an
 * empty body.
 */
function cappedHtmlResponse(
  deps: HttpDeps,
  html: string,
  opts: { method: string; path: string },
): Response {
  const bytes = new TextEncoder().encode(html).length;
  if (bytes > PAGE_MAX_RESPONSE_BYTES) {
    logInternalError(deps.logger, new Error('page render exceeded PAGE_MAX_RESPONSE_BYTES'), {
      path: opts.path,
      bytes,
    });
    const error = fromUnknown(undefined);
    return jsonErrorResponse(error, httpStatusFor(error.code));
  }
  return new Response(opts.method === 'HEAD' ? null : html, {
    status: 200,
    headers: { 'content-type': 'text/html;charset=utf-8' },
  });
}

/**
 * Render one page request. GET/HEAD only; see the module doc for the
 * full dispatch/admission/discovery/render flow and error mapping.
 */
export async function handlePageRequest(deps: HttpDeps, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return notFoundResponse();
  const pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith('/')) {
    const stripped = pathname.replace(/\/+$/, '');
    const target = `${stripped.length === 0 ? '/' : stripped}${url.search}`;
    return new Response(null, { status: 308, headers: { location: target } });
  }

  const descriptors = deps.pages.descriptors();
  const match = matchDescriptor(descriptors, pathname);
  if (match === null) return notFoundResponse();

  let identity: ResolvedIdentity;
  let sessionToken: string | null;
  try {
    // ?team= is honored only with a session cookie: anonymous callers must
    // not probe team existence via 404-vs-render, and public record routes
    // resolve their team from the record (L3), never from the query.
    const hasSessionCookie =
      parseSessionCookie(request.headers.get('cookie') ?? undefined) !== null;
    const teamParam = hasSessionCookie ? url.searchParams.get('team') : null;
    const resolved = await resolveRequestIdentity(
      deps.identity.store,
      request,
      {
        clock: deps.clock,
        ...(teamParam === null ? {} : { teamId: teamParam }),
      },
    );
    identity = resolved.identity;
    sessionToken = resolved.sessionToken;
  } catch (err) {
    const error = caughtToBusinessError(err);
    if (!isBusinessThrow(err)) logInternalError(deps.logger, err, { path: pathname });
    return jsonErrorResponse(error, httpStatusFor(error.code));
  }

  let bindings: AdmittedBindings;
  try {
    bindings = await match.descriptor.admit(identity, match.routeBindings);
  } catch (err) {
    const error = caughtToBusinessError(err);
    if (!isBusinessThrow(err)) logInternalError(deps.logger, err, { path: pathname });
    return jsonErrorResponse(error, httpStatusFor(error.code));
  }

  let csrfToken: string;
  try {
    csrfToken = sessionToken === null ? '' : await deriveCsrfToken(sessionToken);
  } catch (err) {
    return internalResponse(deps, err, pathname);
  }

  const partial = isPartialRequest(request);
  const query = bindRowQueryRunner(deps, identity);
  if (partial) {
    const context: PresentationContext = {
      preferredLocales: parseAcceptLanguage(request.headers.get('accept-language')),
      appDefaultLocale: deps.app.appDefaultLocale,
      theme: DEFAULT_THEME,
      path: pathname,
      isPartial: true,
      csrfToken,
      principal: identity,
      invocation: identity,
      query,
    };
    let children: string;
    try {
      children = await match.descriptor.render(context, bindings);
    } catch (err) {
      return renderThrowResponse(deps, err, pathname);
    }
    let html: string;
    try {
      html = await renderPage(context, match.descriptor, [children]);
    } catch (err) {
      return internalResponse(deps, err, pathname);
    }
    return cappedHtmlResponse(deps, html, { method, path: pathname });
  }

  const candidates = selectDiscoveryCandidates(descriptors);
  const outcomes = await admitDiscovery(deps, candidates, identity);
  let navigation: NavigationResult;
  try {
    navigation = buildNavigation(candidates, outcomes, {
      currentPath: pathname,
      ownerLabels: deps.app.ownerLabels,
    });
  } catch (err) {
    return internalResponse(deps, err, pathname);
  }

  let teams: TeamOption[];
  try {
    teams = await teamOptions(deps, identity);
  } catch (err) {
    return internalResponse(deps, err, pathname);
  }
  const account: AccountMenuData = {
    authenticated: identity.actor !== null,
    ...(identity.actor !== null ? { userLabel: identity.actor.email } : {}),
    teams,
    ...(identity.team !== null ? { currentTeamId: identity.team.team_id } : {}),
  };
  const shell: ShellData = {
    navigation,
    brand: deps.app.brand,
    routes: { signIn: SIGN_IN_PATH, signOut: SIGN_OUT_PATH, switchTeam: SWITCH_TEAM_PATH },
    account,
    settings: { sections: [] },
  };
  const context: PresentationContext = {
    preferredLocales: parseAcceptLanguage(request.headers.get('accept-language')),
    appDefaultLocale: deps.app.appDefaultLocale,
    theme: DEFAULT_THEME,
    path: pathname,
    isPartial: false,
    csrfToken,
    principal: identity,
    invocation: identity,
    query,
  };
  let children: string;
  try {
    children = await match.descriptor.render(context, bindings);
  } catch (err) {
    return renderThrowResponse(deps, err, pathname);
  }
  let html: string;
  try {
    html = await renderPage(context, match.descriptor, [children], shell);
  } catch (err) {
    return internalResponse(deps, err, pathname);
  }
  return cappedHtmlResponse(deps, html, { method, path: pathname });
}
