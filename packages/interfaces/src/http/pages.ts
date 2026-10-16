/**
 * S4 page dispatch: route matching, admission, discovery, and rendering.
 *
 * GET/HEAD render pages; a source-declared enum preference selector also
 * admits a CSRF-checked POST to its own page path. Flow: strip a non-root trailing
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
  PAGE_MAX_RESPONSE_BYTES,
} from '@canlang/contracts';
import type {
  AccountMenuData,
  AdmittedBindings,
  AdmissionOutcome,
  ListQueryArgs,
  NavigationResult,
  NavigationEntry,
  PageDescriptor,
  PageSourceContext,
  PageReadScope,
  PageRecordsReader,
  PresentationContext,
  ResolvedIdentity,
  RowQueryRunner,
  ShellData,
  TeamOption,
} from '@canlang/contracts';
import { deriveCsrfToken, parseSessionCookie, IdentityError } from '@canlang/identity';
import { buildNavigation, renderEnumPreferenceSettings, renderPage, selectDiscoveryCandidates } from '@canlang/ui';
import type { PageHttpDeps, PagePreferenceKey } from '../ports.js';
import {
  assertPostCsrf,
  caughtToBusinessError,
  isBusinessThrow,
  jsonErrorResponse,
  resolveRequestIdentity,
} from './context.js';
import { buildBusinessError, fromUnknown, httpStatusFor } from '../errors/envelope.js';
import { logInternalError } from '../errors/logging.js';
import { wantsBrowserAuth } from './browser-auth.js';
import { isPartialRequest } from './fragments.js';
import { readCappedBody } from './limits.js';
import { buildPageSourceContext, buildPresentationContext } from './presentation.js';
import { SIGN_IN_PATH, SIGN_OUT_PATH, SWITCH_TEAM_PATH } from './routes.js';

/** Authored unknown/method response: `not_found`, mirroring routes.ts. */
function notFoundResponse(): Response {
  const error = buildBusinessError('not_found', 'Not found.');
  return jsonErrorResponse(error, httpStatusFor(error.code));
}

/** Generic internal response after journaling the redacted detail. */
function internalResponse(deps: PageHttpDeps, err: unknown, path: string): Response {
  logInternalError(deps.logger, err, { path });
  const error = fromUnknown(err);
  return jsonErrorResponse(error, httpStatusFor(error.code));
}

/** Render-path throw mapping: business denials keep meaning, else internal. */
function renderThrowResponse(deps: PageHttpDeps, err: unknown, path: string): Response {
  if (isBusinessThrow(err)) {
    const error = caughtToBusinessError(err);
    return jsonErrorResponse(error, httpStatusFor(error.code));
  }
  return internalResponse(deps, err, path);
}

/** Keep the resolved request identity authoritative over renderer-supplied values. */
function bindRowQueryRunner(deps: PageHttpDeps, identity: ResolvedIdentity, query = deps.query, receiver: unknown = deps): RowQueryRunner {
  return async (_invocation: unknown, model: string, args: ListQueryArgs) => {
    const limit = args.limit ?? COLLECTION_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > COLLECTION_MAX_LIMIT) {
      throw buildBusinessError('validation', 'Invalid collection limit.');
    }
    if (query === undefined) {
      throw buildBusinessError('validation', 'Authorized page queries are not configured.');
    }
    return query.call(receiver, identity, model, { ...args, limit });
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
export function matchDescriptor(
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

function checkedPreferenceFields(descriptor: PageDescriptor): NonNullable<PageDescriptor['preferenceFields']> {
  const fields = descriptor.preferenceFields ?? [];
  const names = new Set<string>();
  for (const field of fields) {
    // Reference preference leaves carry no case options and no literal
    // default (DESIGN 977: reference equality is not an enum spelling);
    // the saved identity validates as an opaque string at read time.
    if (field.reference === true) {
      if (typeof field.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/u.test(field.name) ||
          names.has(field.name) || !Array.isArray(field.options) || field.options.length !== 0 ||
          field.defaultValue !== null || field.nullable !== true) {
        throw new Error('Invalid source preference descriptor.');
      }
      names.add(field.name);
      continue;
    }
    if (field.reference !== undefined || typeof field.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/u.test(field.name) ||
        names.has(field.name) || !Array.isArray(field.options) || field.options.length === 0 ||
        field.options.some(value => typeof value !== 'string' || value === '') ||
        new Set(field.options).size !== field.options.length ||
        (field.defaultValue === null
          ? field.nullable !== true
          : !field.options.includes(field.defaultValue))) {
      throw new Error('Invalid source preference descriptor.');
    }
    names.add(field.name);
  }
  return fields;
}

function checkedPreferenceVersion(value: string): boolean {
  return /^(0|[1-9][0-9]*)$/u.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
}

/** Saved preference values are loaded only for this resolved active actor/team. */
async function preferenceSource(
  deps: PageHttpDeps, identity: ResolvedIdentity, descriptor: PageDescriptor, readRecords?: PageRecordsReader,
): Promise<PageSourceContext> {
  const source = buildPageSourceContext(identity, readRecords);
  const fields = checkedPreferenceFields(descriptor);
  if (fields.length === 0) {
    await deps.bindSourceReadContext?.(identity, source);
    return source;
  }
  if (identity.actor === null || identity.team === null || identity.membership === null ||
      identity.membership.status !== 'active' ||
      identity.membership.user_id !== identity.actor.user_id ||
      identity.membership.team_id !== identity.team.team_id) {
    throw buildBusinessError('forbidden', 'An active team membership is required.');
  }
  if (deps.preferences === undefined) throw new Error('Page preference persistence is not configured.');
  const values: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
  const versions: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const field of fields) {
    const key: PagePreferenceKey = {
      appId: deps.app.appId, actorUserId: identity.actor.user_id,
      teamId: identity.team.team_id, owner: descriptor.owner, field: field.name,
    };
    const saved = await deps.preferences.read(key);
    // Reference identities validate as opaque strings (bounded like
    // search input), never against a case inventory: unknown references
    // simply match nothing downstream (DESIGN 1027).
    const savedOk = saved === null || !checkedPreferenceVersion(saved.version) || saved.version === '0'
      ? saved === null
      : field.reference === true
        ? typeof saved.value === 'string' && saved.value !== '' && saved.value.length <= 200 &&
          !/[\u0000-\u001f\u007f]/.test(saved.value)
        : field.options.includes(saved.value);
    if (!savedOk) {
      throw new Error('Invalid saved page preference.');
    }
    values[field.name] = saved?.value ?? field.defaultValue;
    versions[field.name] = saved?.version ?? '0';
  }
  const result = Object.freeze({
    ...source,
    preferences: Object.freeze({ [descriptor.owner]: Object.freeze(values) }),
    preferenceVersions: Object.freeze({ [descriptor.owner]: Object.freeze(versions) }),
  });
  await deps.bindSourceReadContext?.(identity, result);
  return result;
}

/** Bound tabs save through their actual page route and return to that view. */
export async function handlePagePreferencePost(deps: PageHttpDeps, request: Request): Promise<Response> {
  if (request.method.toUpperCase() !== 'POST') return notFoundResponse();
  const url = new URL(request.url);
  const match = matchDescriptor(deps.pages.descriptors(), url.pathname);
  if (match === null) return notFoundResponse();
  const fields = checkedPreferenceFields(match.descriptor);
  if (fields.length === 0) return notFoundResponse();
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/x-www-form-urlencoded') {
    throw buildBusinessError('validation', 'Invalid preference form.');
  }
  const body = new URLSearchParams(new TextDecoder().decode(await readCappedBody(request, 4096)));
  const names = [...body.keys()];
  const selected = fields.filter(field => body.has(field.name));
  if (selected.length !== 1 || names.length !== 3 || new Set(names).size !== 3 ||
      !body.has('_csrf') || !body.has('_version') ||
      names.some(name => name !== '_csrf' && name !== '_version' && name !== selected[0]?.name)) {
    throw buildBusinessError('validation', 'Invalid preference form.');
  }
  const field = selected[0]!;
  const value = body.get(field.name)!;
  const expectedVersion = body.get('_version')!;
  if (!field.options.includes(value) || !checkedPreferenceVersion(expectedVersion)) {
    throw buildBusinessError('validation', 'Invalid preference selection.');
  }
  const teamId = url.searchParams.get('team');
  const resolved = await resolveRequestIdentity(deps.identity.store, request, {
    clock: deps.clock, ...(teamId === null ? {} : { teamId }),
  });
  const { identity, sessionToken } = resolved;
  if (sessionToken === null) throw buildBusinessError('forbidden', 'Authentication required.');
  await assertPostCsrf({
    sessionToken, headerValue: request.headers.get('x-csrf-token'), fieldValue: body.get('_csrf'),
  });
  const source = await preferenceSource(deps, identity, match.descriptor);
  await match.descriptor.admit(source, match.routeBindings);
  const currentVersion = source.preferenceVersions?.[match.descriptor.owner]?.[field.name];
  if (currentVersion !== expectedVersion) throw buildBusinessError('conflict', 'Preference changed; reload the page.');
  const key: PagePreferenceKey = {
    appId: deps.app.appId, actorUserId: identity.actor!.user_id, teamId: identity.team!.team_id,
    owner: match.descriptor.owner, field: field.name,
  };
  if (!await deps.preferences!.save({ ...key, value, expectedVersion })) {
    throw buildBusinessError('conflict', 'Preference changed; reload the page.');
  }
  return new Response(null, { status: 303, headers: { location: `${url.pathname}${url.search}` } });
}

/** Switcher options: active memberships with a live team, id-prefix labels. */
async function teamOptions(deps: PageHttpDeps, identity: ResolvedIdentity): Promise<TeamOption[]> {
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
 * verified source context and `{}` bindings (dynamic patterns never reach discovery).
 * Business denials hide the link; unexpected throws mark the navigation
 * incomplete after an incident-logged journal entry.
 */
async function admitDiscovery(
  deps: PageHttpDeps,
  candidates: readonly PageDescriptor[],
  source: PageSourceContext,
): Promise<ReadonlyMap<PageDescriptor, AdmissionOutcome>> {
  const outcomes = new Map<PageDescriptor, AdmissionOutcome>();
  for (const candidate of candidates) {
    try {
      await candidate.admit(source, {});
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

/** Only real static route ancestors are implicit destinations; no segment route is invented. */
function declaredAncestors(descriptors: readonly PageDescriptor[], candidates: readonly PageDescriptor[],
  current: PageDescriptor): PageDescriptor[] {
  return candidates.filter(candidate => candidate.path !== current.path &&
    (candidate.path === '/' || current.path.startsWith(candidate.path + '/')) &&
    matchDescriptor(descriptors, candidate.path)?.descriptor === candidate)
    .sort((a, b) => a.path.length - b.path.length);
}

function pageBreadcrumbs(current: PageDescriptor, pathname: string, ancestors: readonly PageDescriptor[],
  outcomes: ReadonlyMap<PageDescriptor, AdmissionOutcome>): NonNullable<PresentationContext['breadcrumbs']> {
  const ancestry: NavigationEntry[] = [];
  for (const ancestor of ancestors) {
    const outcome = outcomes.get(ancestor);
    if (outcome === undefined) throw new Error('Missing breadcrumb admission outcome.');
    if (outcome === 'admitted') ancestry.push(Object.freeze({
      owner: ancestor.owner, path: ancestor.path, title: ancestor.title, active: false,
    }));
  }
  ancestry.push(Object.freeze({ owner: current.owner, path: pathname, title: current.title, active: true }));
  return Object.freeze({ label: 'Breadcrumbs', ancestry: Object.freeze(ancestry) });
}

/**
 * Cap the rendered bytes: past PAGE_MAX_RESPONSE_BYTES the generator is
 * faulty (internal), else 200 HTML — HEAD with the same headers and an
 * empty body.
 */
function cappedHtmlResponse(
  deps: PageHttpDeps,
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
async function handlePageRequestCore(deps: PageHttpDeps, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const identityStore = deps.identity.store, identityClock = deps.clock;
  const capturedCookie = request.headers.get('cookie');
  const credentialRequest = new Request(url.href, {
    headers: capturedCookie === null ? {} : { cookie: capturedCookie },
  });
  const selectedTeam = parseSessionCookie(capturedCookie ?? undefined) === null ? null : url.searchParams.get('team');
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return notFoundResponse();
  const searchValues = url.searchParams.getAll('q');
  if (searchValues.length > 1 || searchValues.some(value => value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value))) {
    const error = buildBusinessError('validation', 'Invalid collection search.');
    return jsonErrorResponse(error, httpStatusFor(error.code));
  }
  const searchQuery = searchValues[0] ?? '';
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
    const teamParam = selectedTeam;
    const resolved = await resolveRequestIdentity(
      identityStore,
      credentialRequest,
      {
        clock: identityClock,
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

  let source: PageSourceContext;
  let sourceReady = false;
  let scope: PageReadScope | undefined;
  let closeScope: (() => void | Promise<void>) | undefined;
  let scopeActive = true;
  const requireActiveScope = (): void => {
    if (!scopeActive || request.signal.aborted) throw new IdentityError('forbidden', 'Page read scope is closed.');
  };
  const resolveCaller = async (): Promise<ResolvedIdentity> => {
    requireActiveScope();
    const resolved = await resolveRequestIdentity(identityStore, credentialRequest, {
      clock: identityClock, ...(selectedTeam === null ? {} : { teamId: selectedTeam }),
    });
    requireActiveScope();
    return resolved.identity;
  };
  let query!: RowQueryRunner;
  let opening: Promise<void> | undefined;
  const openScope = (): Promise<void> => opening ??= Promise.resolve().then(async () => {
    requireActiveScope();
    scope = await deps.createReadScope?.(identity, source, resolveCaller);
    closeScope = scope?.close?.bind(scope);
    requireActiveScope();
    const scopedQuery = scope?.query;
    query = bindRowQueryRunner(deps, identity, scopedQuery, scopedQuery === undefined ? deps : scope);
    await scope?.onQueryBound?.(query);
    requireActiveScope();
  });
  const admissionRead: PageRecordsReader = async (model, selected) => {
    requireActiveScope();
    if (!sourceReady) throw buildBusinessError('validation', 'Page source admission is not active.');
    await openScope();
    requireActiveScope();
    if (scope?.readRecords === undefined) throw buildBusinessError('validation', 'Authorized page source reads are not configured.');
    // This reader owns model, source and current field authority. A page guard
    // has not admitted the request and cannot grant any of those permissions.
    const rows = await scope.readRecords.call(scope, model, selected);
    requireActiveScope();
    return rows;
  };
  try {
    try {
      source = await preferenceSource(deps, identity, match.descriptor,
        Object.keys(match.routeBindings).length === 0 ? undefined : admissionRead);
      sourceReady = true;
    } catch (err) {
      return renderThrowResponse(deps, err, pathname);
    }
    let bindings: AdmittedBindings;
    try {
      bindings = await match.descriptor.admit(source, match.routeBindings);
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
    try {
      await openScope();
    } catch (err) {
      return renderThrowResponse(deps, err, pathname);
    }
    const candidates = selectDiscoveryCandidates(descriptors);
    const ancestors = declaredAncestors(descriptors, candidates, match.descriptor);
    const outcomes = await admitDiscovery(deps, partial ? ancestors : candidates, source);
    let breadcrumbs: ReturnType<typeof pageBreadcrumbs>;
    try {
      breadcrumbs = pageBreadcrumbs(match.descriptor, pathname, ancestors, outcomes);
    } catch (err) {
      return internalResponse(deps, err, pathname);
    }
    if (partial) {
      const context = buildPresentationContext({
        ...(deps.deploymentBase === undefined ? {} : { deploymentBase: deps.deploymentBase }),
        request,
        pathname,
        searchQuery,
        isPartial: true,
        appDefaultLocale: deps.app.appDefaultLocale,
        csrfToken,
        principal: identity,
        source,
        breadcrumbs,
        query,
        ...(scope?.readRecords === undefined ? {} : { readRecords: scope.readRecords }),
        ...(scope?.readHistory === undefined ? {} : { readHistory: scope.readHistory }),
        ...(scope?.presentFile === undefined ? {} : { presentFile: scope.presentFile.bind(scope) }),
        ...(scope?.resolveFileImage === undefined ? {} : { resolveFileImage: scope.resolveFileImage.bind(scope) }),
        ...(scope?.observeDelivery === undefined ? {} : { observeDelivery: scope.observeDelivery }),
        ...(scope?.observeGenerationCallbackDiagnostics === undefined ? {} : {
          observeGenerationCallbackDiagnostics: scope.observeGenerationCallbackDiagnostics,
        }),
        ...(deps.catalog === undefined ? {} : { catalog: deps.catalog }),
        ...(deps.formBindings === undefined ? {} : { formBindings: deps.formBindings }),
        appId: deps.app.appId, sessionToken,
        clock: deps.clock,
      });
      let children: readonly string[];
      try {
        children = match.descriptor.renderParts === undefined
          ? [await match.descriptor.render(context, bindings)]
          : await match.descriptor.renderParts(context, bindings);
      } catch (err) {
        return renderThrowResponse(deps, err, pathname);
      }
      let html: string;
      try {
        html = await renderPage(context, match.descriptor, children);
      } catch (err) {
        return internalResponse(deps, err, pathname);
      }
      return cappedHtmlResponse(deps, html, { method, path: pathname });
    }

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
    const context = buildPresentationContext({
      ...(deps.deploymentBase === undefined ? {} : { deploymentBase: deps.deploymentBase }),
      request,
      pathname,
      searchQuery,
      isPartial: false,
      appDefaultLocale: deps.app.appDefaultLocale,
      csrfToken,
      principal: identity,
      source,
      breadcrumbs,
      query,
      ...(scope?.readRecords === undefined ? {} : { readRecords: scope.readRecords }),
      ...(scope?.readHistory === undefined ? {} : { readHistory: scope.readHistory }),
      ...(scope?.presentFile === undefined ? {} : { presentFile: scope.presentFile.bind(scope) }),
      ...(scope?.resolveFileImage === undefined ? {} : { resolveFileImage: scope.resolveFileImage.bind(scope) }),
      ...(scope?.observeDelivery === undefined ? {} : { observeDelivery: scope.observeDelivery }),
      ...(scope?.observeGenerationCallbackDiagnostics === undefined ? {} : {
        observeGenerationCallbackDiagnostics: scope.observeGenerationCallbackDiagnostics,
      }),
      ...(deps.catalog === undefined ? {} : { catalog: deps.catalog }),
      ...(deps.formBindings === undefined ? {} : { formBindings: deps.formBindings }),
      appId: deps.app.appId, sessionToken,
      clock: deps.clock,
    });
    let children: readonly string[];
    try {
      children = match.descriptor.renderParts === undefined
          ? [await match.descriptor.render(context, bindings)]
          : await match.descriptor.renderParts(context, bindings);
    } catch (err) {
      return renderThrowResponse(deps, err, pathname);
    }
    let html: string;
    try {
      html = await renderPage(context, match.descriptor, children, {
        ...shell, settings: renderEnumPreferenceSettings({
          context, owner: match.descriptor.owner,
          caption: deps.app.ownerLabels.get(match.descriptor.owner) ?? match.descriptor.owner,
          fields: checkedPreferenceFields(match.descriptor),
          postTo: context.pollUrl ?? context.path,
        }),
      });
    } catch (err) {
      return internalResponse(deps, err, pathname);
    }
    return cappedHtmlResponse(deps, html, { method, path: pathname });
  } finally {
    scopeActive = false;
    try { await closeScope?.(); }
    catch (err) { return internalResponse(deps, err, pathname); }
  }
}


/** Browser recovery runs only after the owning page refusal and read-scope cleanup. */
export async function handlePageRequest(deps: PageHttpDeps, request: Request): Promise<Response> {
  const response = await handlePageRequestCore(deps, request);
  if (request.method.toUpperCase() !== 'GET' || response.status !== 403 ||
      isPartialRequest(request) || !wantsBrowserAuth(request)) return response;
  let target: string | undefined;
  try {
    const { identity } = await resolveRequestIdentity(deps.identity.store, request, { clock: deps.clock });
    if (identity.actor === null) target = SIGN_IN_PATH;
    else if (identity.team === null) target = SWITCH_TEAM_PATH;
  } catch (err) {
    // Only rejected credentials are recoverable; store failures preserve the safe refusal.
    if (err instanceof IdentityError && err.code === 'forbidden') target = SIGN_IN_PATH;
  }
  return target === undefined ? response : new Response(null, { status: 303, headers: {
    location: target, 'cache-control': 'no-store', vary: 'Accept',
  } });
}
