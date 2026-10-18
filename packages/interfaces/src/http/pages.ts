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
import { decodeValue } from '@canlang/values';
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
import type { BuildPresentationContextInput } from './presentation.js';
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

type PagePreferenceField = NonNullable<PageDescriptor['preferenceFields']>[number];

/** Only source-authored scalar editors add writes to the existing save route. */
function editablePreferenceMatches(field: PagePreferenceField): boolean {
  if (field.editable === undefined) return true;
  if (field.reference !== undefined || field.date !== undefined || (field.nullable !== undefined && field.nullable !== true)) return false;
  if (field.editable === 'int') return field.scalarType === 'int';
  if (field.editable === 'bool') return field.scalarType === undefined &&
    field.options.join(',') === 'true,false';
  return field.editable === 'text' && field.scalarType === undefined && field.reference === undefined &&
    field.date === undefined && field.options.length === 0;
}

function clearedPreference(field: PagePreferenceField, value: string): boolean {
  return field.editable !== undefined && field.nullable === true && value === '';
}

function acceptedPreferenceValue(field: PagePreferenceField, value: string): boolean {
  if (typeof value !== 'string') return false;
  if (clearedPreference(field, value)) return true;
  if (field.editable === 'int') return isScalarFilterValue('int', value);
  if (field.editable === 'text') return value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);
  return field.options.includes(value);
}

/** Saved filter defaults remain readable without granting an editor POST. */
function readablePreferenceValue(field: PagePreferenceField, value: string): boolean {
  if (field.editable !== undefined) return acceptedPreferenceValue(field, value);
  if (field.scalarType !== undefined) return isScalarFilterValue(field.scalarType, value);
  if (field.date === true) return isCivilDate(value);
  if (field.options.length > 0) return field.options.includes(value);
  return typeof value === 'string' && value.length <= 200 &&
    !/[\u0000-\u001f\u007f]/u.test(value) && (field.reference !== true || value !== '');
}

function checkPreferenceFieldShape(field: PagePreferenceField, names: Set<string>): void {
  if (!editablePreferenceMatches(field) || typeof field.name !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_]*$/u.test(field.name) || names.has(field.name) || !Array.isArray(field.options)) {
    throw new Error('Invalid source preference descriptor.');
  }
  names.add(field.name);
}

function checkScalarPreferenceField(field: PagePreferenceField): void {
  // Reference preference leaves carry no case options and no literal
  // default (DESIGN 977: reference equality is not an enum spelling);
  // the saved identity validates as an opaque string at read time.
  const scalarType = field.scalarType;
  if (scalarType === undefined || !['int', 'datetime', 'currency'].includes(scalarType) || field.reference !== undefined || field.date !== undefined ||
      !Array.isArray(field.options) || field.options.length !== 0 || (field.defaultValue === null
        ? field.nullable !== true : !isScalarFilterValue(scalarType, field.defaultValue))) {
    throw new Error('Invalid source preference descriptor.');
  }
}

function checkReferencePreferenceField(field: PagePreferenceField): void {
  if (!Array.isArray(field.options) || field.options.length !== 0 ||
      field.defaultValue !== null || field.nullable !== true || field.date !== undefined) {
    throw new Error('Invalid source preference descriptor.');
  }
}

function checkDatePreferenceField(field: PagePreferenceField): void {
  // C3 civil-date preference leaf (DESIGN 1015-1025 operator table):
  // a plain-date control carries no case options and no save
  // control; the default is a civil date or null (empty means no
  // restriction, DESIGN 1023) and the saved value validates as a
  // civil date, never against an inventory. Only the compiler emits
  // this shape (`date:true` with empty options); enum/bool leaves
  // always carry their spellings below. The POST save path keeps
  // refusing date leaves with validation: no save control admits
  // them.
  if (!Array.isArray(field.options) || field.options.length !== 0 ||
      (field.defaultValue === null
        ? field.nullable !== true
        : !isCivilDate(field.defaultValue))) {
    throw new Error('Invalid source preference descriptor.');
  }
}

function checkTextPreferenceField(field: PagePreferenceField): void {
  // C2 text-equality preference leaf (DESIGN 975 scalar): a plain-text
  // control carries no case options and no save control; the default
  // is a bounded string or null (empty means no restriction, DESIGN
  // 1023) and the saved value validates as a bounded string, never
  // against an inventory. Only the compiler emits this shape (empty
  // options with no reference/date flag); enum/bool leaves always carry
  // their spellings below. The POST save path keeps refusing text
  // leaves with validation: no save control admits them.
  if (field.date !== undefined ||
      (field.defaultValue === null
        ? field.nullable !== true
        : typeof field.defaultValue !== 'string' || field.defaultValue.length > 200 ||
          /[\u0000-\u001f\u007f]/.test(field.defaultValue))) {
    throw new Error('Invalid source preference descriptor.');
  }
}

function checkEnumPreferenceField(field: PagePreferenceField): void {
  if (field.reference !== undefined || field.date !== undefined || !Array.isArray(field.options) || field.options.length === 0 ||
      field.options.some(value => typeof value !== 'string' || value === '') ||
      new Set(field.options).size !== field.options.length ||
      (field.defaultValue === null
        ? field.nullable !== true
        : !field.options.includes(field.defaultValue))) {
    throw new Error('Invalid source preference descriptor.');
  }
}

function checkedPreferenceFields(descriptor: PageDescriptor): NonNullable<PageDescriptor['preferenceFields']> {
  const fields = descriptor.preferenceFields ?? [];
  const names = new Set<string>();
  for (const field of fields) {
    checkPreferenceFieldShape(field, names);
    if (field.scalarType !== undefined) {
      checkScalarPreferenceField(field);
      continue;
    }
    if (field.reference === true) {
      checkReferencePreferenceField(field);
      continue;
    }
    if (field.date === true) {
      checkDatePreferenceField(field);
      continue;
    }
    if (Array.isArray(field.options) && field.options.length === 0) {
      checkTextPreferenceField(field);
      continue;
    }
    checkEnumPreferenceField(field);
  }
  return fields;
}

/**
 * C3 civil-date check (DESIGN 1015-1025): a real civil `YYYY-MM-DD`
 * date in years 0001-9999 through the canonical date wire (leap days
 * and month lengths enforced, never a shifted instant).
 */
function isCivilDate(value: string): boolean {
  try {
    decodeValue('date', value);
    return true;
  } catch {
    return false;
  }
}

function isScalarFilterValue(type: 'int' | 'datetime' | 'currency', value: string): boolean {
  try { decodeValue(type, value); return true; } catch { return false; }
}

function checkedPreferenceVersion(value: string): boolean {
  return /^(0|[1-9][0-9]*)$/u.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER);
}

/** Saved preference values are loaded only for this resolved active actor/team. */
function checkPreferenceMembership(identity: ResolvedIdentity): void {
  if (identity.actor === null || identity.team === null || identity.membership === null ||
      identity.membership.status !== 'active' ||
      identity.membership.user_id !== identity.actor.user_id ||
      identity.membership.team_id !== identity.team.team_id) {
    throw buildBusinessError('forbidden', 'An active team membership is required.');
  }
}

async function loadPreferenceField(
  deps: PageHttpDeps,
  identity: ResolvedIdentity,
  owner: string,
  field: PagePreferenceField,
  values: Record<string, string | null>,
  versions: Record<string, string>,
): Promise<void> {
  const key: PagePreferenceKey = {
    appId: deps.app.appId, actorUserId: identity.actor!.user_id,
    teamId: identity.team!.team_id, owner, field: field.name,
  };
  const saved = await deps.preferences!.read(key);
  // Reference identities validate as opaque strings (bounded like
  // search input), never against a case inventory: unknown references
  // simply match nothing downstream (DESIGN 1027). Text values
  // validate the same way (C2 text-equality rule, DESIGN 975 scalar):
  // a bounded string with no inventory to violate, so an unknown
  // saved string narrows to no rows downstream instead of failing
  // materialization; empty stays no restriction (DESIGN 1023). Date
  // values validate as civil dates (C3, DESIGN 1015-1025): a saved
  // non-date is a materialization failure, never a silent empty.
  const savedOk = saved === null || (checkedPreferenceVersion(saved.version) && saved.version !== '0' &&
    readablePreferenceValue(field, saved.value));
  if (!savedOk) {
    throw new Error('Invalid saved page preference.');
  }
  values[field.name] = saved !== null && clearedPreference(field, saved.value) ? null : saved?.value ?? field.defaultValue;
  versions[field.name] = saved?.version ?? '0';
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
  checkPreferenceMembership(identity);
  if (deps.preferences === undefined) throw new Error('Page preference persistence is not configured.');
  const values: Record<string, string | null> = Object.create(null) as Record<string, string | null>;
  const versions: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const field of fields) {
    await loadPreferenceField(deps, identity, descriptor.owner, field, values, versions);
  }
  const result = Object.freeze({
    ...source,
    preferences: Object.freeze({ [descriptor.owner]: Object.freeze(values) }),
    preferenceVersions: Object.freeze({ [descriptor.owner]: Object.freeze(versions) }),
  });
  await deps.bindSourceReadContext?.(identity, result);
  return result;
}

function parsePreferencePost(
  body: URLSearchParams,
  fields: NonNullable<PageDescriptor['preferenceFields']>,
): { field: PagePreferenceField; value: string; expectedVersion: string } {
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
  if (!acceptedPreferenceValue(field, value) || !checkedPreferenceVersion(expectedVersion)) {
    throw buildBusinessError('validation', 'Invalid preference selection.');
  }
  return { field, value, expectedVersion };
}

async function resolvePreferenceIdentity(
  deps: PageHttpDeps,
  request: Request,
  teamId: string | null,
  body: URLSearchParams,
): Promise<{ identity: ResolvedIdentity; sessionToken: string }> {
  const resolved = await resolveRequestIdentity(deps.identity.store, request, {
    clock: deps.clock, ...(teamId === null ? {} : { teamId }),
  });
  const { identity, sessionToken } = resolved;
  if (sessionToken === null) throw buildBusinessError('forbidden', 'Authentication required.');
  await assertPostCsrf({
    sessionToken, headerValue: request.headers.get('x-csrf-token'), fieldValue: body.get('_csrf'),
  });
  return { identity, sessionToken };
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
  const { field, value, expectedVersion } = parsePreferencePost(body, fields);
  const { identity } = await resolvePreferenceIdentity(deps, request, url.searchParams.get('team'), body);
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

function checkPageQuery(url: URL): Response | null {
  const searchValues = url.searchParams.getAll('q');
  if (searchValues.length > 1 || searchValues.some(value => value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value))) {
    const error = buildBusinessError('validation', 'Invalid collection search.');
    return jsonErrorResponse(error, httpStatusFor(error.code));
  }
  return null;
}

function stripPageSlash(url: URL, pathname: string): Response | null {
  if (pathname.length > 1 && pathname.endsWith('/')) {
    const stripped = pathname.replace(/\/+$/, '');
    const target = `${stripped.length === 0 ? '/' : stripped}${url.search}`;
    return new Response(null, { status: 308, headers: { location: target } });
  }
  return null;
}

async function resolvePageIdentity(
  deps: PageHttpDeps,
  pathname: string,
  credentialRequest: Request,
  selectedTeam: string | null,
): Promise<{ identity: ResolvedIdentity; sessionToken: string | null } | Response> {
  try {
    // ?team= is honored only with a session cookie: anonymous callers must
    // not probe team existence via 404-vs-render, and public record routes
    // resolve their team from the record (L3), never from the query.
    const resolved = await resolveRequestIdentity(
      deps.identity.store,
      credentialRequest,
      {
        clock: deps.clock,
        ...(selectedTeam === null ? {} : { teamId: selectedTeam }),
      },
    );
    return { identity: resolved.identity, sessionToken: resolved.sessionToken };
  } catch (err) {
    const error = caughtToBusinessError(err);
    if (!isBusinessThrow(err)) logInternalError(deps.logger, err, { path: pathname });
    return jsonErrorResponse(error, httpStatusFor(error.code));
  }
}

async function readPageBindings(
  deps: PageHttpDeps,
  match: RouteMatch,
  source: PageSourceContext,
  pathname: string,
): Promise<AdmittedBindings | Response> {
  try {
    return await match.descriptor.admit(source, match.routeBindings);
  } catch (err) {
    const error = caughtToBusinessError(err);
    if (!isBusinessThrow(err)) logInternalError(deps.logger, err, { path: pathname });
    return jsonErrorResponse(error, httpStatusFor(error.code));
  }
}

async function derivePageCsrf(
  deps: PageHttpDeps,
  sessionToken: string | null,
  pathname: string,
): Promise<string | Response> {
  try {
    return sessionToken === null ? '' : await deriveCsrfToken(sessionToken);
  } catch (err) {
    return internalResponse(deps, err, pathname);
  }
}

async function renderPageChildren(
  deps: PageHttpDeps,
  match: RouteMatch,
  context: PresentationContext,
  bindings: AdmittedBindings,
  pathname: string,
): Promise<readonly string[] | Response> {
  try {
    return match.descriptor.renderParts === undefined
      ? [await match.descriptor.render(context, bindings)]
      : await match.descriptor.renderParts(context, bindings);
  } catch (err) {
    return renderThrowResponse(deps, err, pathname);
  }
}

interface PageRenderEnv {
  readonly deps: PageHttpDeps;
  readonly request: Request;
  readonly match: RouteMatch;
  readonly identity: ResolvedIdentity;
  readonly sessionToken: string | null;
  readonly source: PageSourceContext;
  readonly bindings: AdmittedBindings;
  readonly csrfToken: string;
  readonly query: RowQueryRunner;
  readonly scope: PageReadScope | undefined;
  readonly candidates: readonly PageDescriptor[];
  readonly ancestors: readonly PageDescriptor[];
  readonly outcomes: ReadonlyMap<PageDescriptor, AdmissionOutcome>;
  readonly breadcrumbs: NonNullable<PresentationContext['breadcrumbs']>;
  readonly searchQuery: string;
  readonly pathname: string;
  readonly method: string;
}

function pageContextOptions(env: PageRenderEnv, isPartial: boolean): BuildPresentationContextInput {
  const { deps, request, csrfToken, identity, source, breadcrumbs, query, scope } = env;
  return {
    ...(deps.deploymentBase === undefined ? {} : { deploymentBase: deps.deploymentBase }),
    request,
    pathname: env.pathname,
    searchQuery: env.searchQuery,
    isPartial,
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
    appId: deps.app.appId, sessionToken: env.sessionToken,
    clock: deps.clock,
  };
}

async function finishPageRender(
  deps: PageHttpDeps,
  context: PresentationContext,
  descriptor: PageDescriptor,
  children: readonly string[],
  method: string,
  pathname: string,
  shell: ShellData | undefined,
): Promise<Response> {
  let html: string;
  try {
    html = await renderPage(context, descriptor, children, shell);
  } catch (err) {
    return internalResponse(deps, err, pathname);
  }
  return cappedHtmlResponse(deps, html, { method, path: pathname });
}

async function renderPartialPage(env: PageRenderEnv): Promise<Response> {
  const context = buildPresentationContext(pageContextOptions(env, true));
  const children = await renderPageChildren(env.deps, env.match, context, env.bindings, env.pathname);
  if (children instanceof Response) return children;
  return finishPageRender(env.deps, context, env.match.descriptor, children, env.method, env.pathname, undefined);
}

async function renderFullPage(env: PageRenderEnv): Promise<Response> {
  const { deps, match, pathname } = env;
  let navigation: NavigationResult;
  try {
    navigation = buildNavigation(env.candidates, env.outcomes, {
      currentPath: pathname,
      ownerLabels: deps.app.ownerLabels,
    });
  } catch (err) {
    return internalResponse(deps, err, pathname);
  }
  let teams: TeamOption[];
  try {
    teams = await teamOptions(deps, env.identity);
  } catch (err) {
    return internalResponse(deps, err, pathname);
  }
  const account: AccountMenuData = {
    authenticated: env.identity.actor !== null,
    ...(env.identity.actor !== null ? { userLabel: env.identity.actor.email } : {}),
    teams,
    ...(env.identity.team !== null ? { currentTeamId: env.identity.team.team_id } : {}),
  };
  const shell: ShellData = {
    navigation,
    brand: deps.app.brand,
    routes: { signIn: SIGN_IN_PATH, signOut: SIGN_OUT_PATH, switchTeam: SWITCH_TEAM_PATH },
    account,
    settings: { sections: [] },
  };
  const context = buildPresentationContext(pageContextOptions(env, false));
  const children = await renderPageChildren(deps, match, context, env.bindings, pathname);
  if (children instanceof Response) return children;
  return finishPageRender(deps, context, match.descriptor, children, env.method, pathname, {
    ...shell, settings: renderEnumPreferenceSettings({
      context, owner: match.descriptor.owner,
      caption: deps.app.ownerLabels.get(match.descriptor.owner) ?? match.descriptor.owner,
      fields: checkedPreferenceFields(match.descriptor),
      postTo: context.pollUrl ?? context.path,
    }),
  });
}

function readPageHead(request: Request): {
  url: URL; credentialRequest: Request; selectedTeam: string | null; method: string;
} | Response {
  const url = new URL(request.url);
  const capturedCookie = request.headers.get('cookie');
  const credentialRequest = new Request(url.href, {
    headers: capturedCookie === null ? {} : { cookie: capturedCookie },
  });
  const selectedTeam = parseSessionCookie(capturedCookie ?? undefined) === null ? null : url.searchParams.get('team');
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return notFoundResponse();
  return { url, credentialRequest, selectedTeam, method };
}

/**
 * Render one page request. GET/HEAD only; see the module doc for the
 * full dispatch/admission/discovery/render flow and error mapping.
 */
async function handlePageRequestCore(deps: PageHttpDeps, request: Request): Promise<Response> {
  const identityStore = deps.identity.store, identityClock = deps.clock;
  const head = readPageHead(request);
  if (head instanceof Response) return head;
  const { url, credentialRequest, selectedTeam, method } = head;
  const searched = checkPageQuery(url);
  if (searched !== null) return searched;
  const searchQuery = url.searchParams.getAll('q')[0] ?? '';
  const pathname = url.pathname;
  const redirected = stripPageSlash(url, pathname);
  if (redirected !== null) return redirected;

  const descriptors = deps.pages.descriptors();
  const match = matchDescriptor(descriptors, pathname);
  if (match === null) return notFoundResponse();

  const identified = await resolvePageIdentity(deps, pathname, credentialRequest, selectedTeam);
  if (identified instanceof Response) return identified;
  const { identity, sessionToken } = identified;

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
    const admitted = await readPageBindings(deps, match, source, pathname);
    if (admitted instanceof Response) return admitted;

    const derived = await derivePageCsrf(deps, sessionToken, pathname);
    if (derived instanceof Response) return derived;
    const csrfToken = derived;

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
    const env: PageRenderEnv = {
      deps, request, match, identity, sessionToken, source, bindings: admitted, csrfToken,
      query, scope, candidates, ancestors, outcomes, breadcrumbs, searchQuery, pathname, method,
    };
    return partial ? await renderPartialPage(env) : await renderFullPage(env);
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
