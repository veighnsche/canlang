/**
 * Canonical `PresentationContext` construction for page rendering (F2).
 *
 * Both page-dispatch paths (partial + full) build through
 * {@link buildPresentationContext}; no inline literals elsewhere. Field
 * sources: locales from the request `Accept-Language` header (up to 10
 * tags, `;` params stripped, empties dropped), the app default locale
 * and CSRF token from the dispatcher (the token is derived before the
 * call and stays `''` when anonymous, failing POSTs closed), the
 * resolved identity as both `principal` and `invocation` (opaque
 * pass-through), and the dispatcher-bound row-query runner. `theme`
 * stays `DEFAULT_THEME` until a preference store exists, and
 * `currencyScales` stays absent until the lane-2 table is importable —
 * money rendering fails loudly without it rather than guessing.
 */
import { DEFAULT_THEME, COLLECTION_FILTER_PREFIX, collectionFilterName } from '@canlang/contracts';
import { makeUserRef } from '@canlang/values';
import { createOperationFormPreparer } from './forms.js';
import { buildBusinessError } from '../errors/envelope.js';
import { systemInterfacesClock } from '../ports.js';
import type { InterfacesClock, SchemaCatalog, SourceFormBindings } from '../ports.js';
import type {
  PageSourceContext,
  PageDeliveryObserver,
  PageRecordsReader,
  PresentationContext,
  ResolvedIdentity,
  RowQueryRunner,
  FilterCondition,
} from '@canlang/contracts';

/** Bounds locator extraction only; the complete page query stays in polling state. */
const COLLECTION_SELECTION_QUERY_MAX_CHARS = 8_192;

/** Rendering without an owning native viewer reader must refuse explicitly. */
const unavailablePageRecords: PageRecordsReader = async () => {
  throw buildBusinessError('validation', 'Authorized page source reads are not configured.');
};

/** Request selectors choose only cases from the owning readable enum inventory. */
function collectionFilterPreparer(params: URLSearchParams): NonNullable<PresentationContext['prepareCollectionFilters']> {
  const selectors = [...params];
  return (occurrence, fields, defaults) => {
    function refuse(): never { throw buildBusinessError('validation', 'Invalid collection filters.'); }
    const own = (value: object, key: string): unknown => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      return property !== undefined && property.enumerable && 'value' in property ? property.value : refuse();
    };
    if (typeof occurrence !== 'string' || occurrence.length === 0) refuse();
    let prefix: string;
    try { prefix = `${COLLECTION_FILTER_PREFIX}${encodeURIComponent(occurrence)}:`; } catch { return refuse(); }
    const inventories = new Map<string, Set<string>>();
    for (const column of fields) {
      if (typeof column !== 'object' || column === null) refuse();
      const field = own(column, 'field'), type = own(column, 'type'), labels = own(column, 'valueLabels');
      if (typeof field !== 'string' || field.trim().length === 0 || inventories.has(field) ||
          typeof type !== 'string' || !type.startsWith('enum:') || type.slice(5).trim().length === 0 ||
          typeof labels !== 'object' || labels === null || Array.isArray(labels)) refuse();
      try { collectionFilterName(occurrence, field); } catch { return refuse(); }
      const cases = Object.keys(labels);
      if (cases.length === 0 || cases.some(value => value.length === 0)) refuse();
      inventories.set(field, new Set(cases));
    }
    const selected = new Map<string, string | null>();
    if (defaults !== undefined) {
      if (typeof defaults !== 'object' || defaults === null || Array.isArray(defaults)) refuse();
      for (const field of Object.keys(defaults)) {
        const value = own(defaults, field);
        if (!inventories.has(field) || (value !== null && (typeof value !== 'string' || !inventories.get(field)!.has(value)))) refuse();
        selected.set(field, value as string | null);
      }
    }
    const seen = new Set<string>();
    for (const [key, value] of selectors) {
      if (key.startsWith('filter[') || key.startsWith('f[')) refuse();
      if (!key.startsWith(prefix)) continue;
      let field: string;
      try { field = decodeURIComponent(key.slice(prefix.length)); } catch { return refuse(); }
      if (!inventories.has(field) || collectionFilterName(occurrence, field) !== key || seen.has(field) ||
          (value !== '' && !inventories.get(field)!.has(value))) refuse();
      seen.add(field);
      selected.set(field, value === '' ? null : value);
    }
    const conditions: FilterCondition[] = [];
    for (const field of inventories.keys()) {
      const value = selected.get(field);
      if (value !== undefined && value !== null) conditions.push(Object.freeze({ field, op: 'eq', value }));
    }
    return Object.freeze(conditions);
  };
}

/** Inputs to {@link buildPresentationContext}, all dispatcher-supplied. */
export interface BuildPresentationContextInput {
  /** Explicit trusted host origin plus mount prefix; never request-derived. */
  readonly deploymentBase?: string;
  /** Request carrying the `Accept-Language` header. */
  readonly request: Request;
  /** Already-normalized pathname. */
  readonly pathname: string;
  /** Already validated request-local collection search text. */
  readonly searchQuery?: string;
  /** From `isPartialRequest` (HTMX header). */
  readonly isPartial: boolean;
  /** Owning app default locale ("en" unless declared). */
  readonly appDefaultLocale: string;
  /** Derived before the call; `''` when anonymous. */
  readonly csrfToken: string;
  /** Resolved identity; also passed through as `invocation`. */
  readonly principal: ResolvedIdentity;
  /** Source facts shared with admission and discovery for this request. */
  readonly source?: PageSourceContext;
  readonly catalog?: SchemaCatalog;
  readonly clock?: InterfacesClock;
  readonly formBindings?: SourceFormBindings;
  readonly appId?: string;
  readonly sessionToken?: string | null;
  /** Row-query runner bound before the call. */
  readonly query: RowQueryRunner;
  /** Native source-expression reader from the same admitted request scope. */
  readonly readRecords?: PageRecordsReader;
  readonly observeDelivery?: PageDeliveryObserver;
}

/** Project verified identity facts into the generated page callable contract. */
export function buildPageSourceContext(identity: ResolvedIdentity): PageSourceContext {
  const { actor, team, membership } = identity;
  const active = actor !== null && team !== null && membership !== null
    && membership.status === 'active' && membership.user_id === actor.user_id
    && membership.team_id === team.team_id;
  const builtinRoles = ['public', ...(actor === null ? [] : ['authenticated']),
    ...(active ? ['members', ...(membership.is_owner ? ['owner'] : [])] : [])];
  return Object.freeze({
    actor: actor === null ? null : makeUserRef(actor.user_id),
    actorFacts: actor === null ? null : Object.freeze({ email: actor.email, email_verified: actor.email_verified }),
    team: team === null ? null : Object.freeze({ id: team.team_id, timezone: team.timezone }),
    memberships: Object.freeze(active ? membership.roles.map(grant => grant.role) : []),
    canonical: Object.freeze({ builtinRoles: Object.freeze(builtinRoles) }),
  });
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

/**
 * Build the presentation context for one page render. Pure: every
 * authority-bearing input (identity, CSRF token, query runner) arrives
 * already resolved; this function only shapes them for the renderer.
 */
export function buildPresentationContext(
  input: BuildPresentationContextInput,
): PresentationContext {
  // Source/identity facts cannot supply host configuration, including when the
  // source object carries extra fields from another context.
  const { deploymentBase: _sourceDeploymentBase, ...source } =
    (input.source ?? buildPageSourceContext(input.principal)) as PageSourceContext &
      Pick<PresentationContext, 'deploymentBase'>;
  const url = new URL(input.request.url);
  const collectionSelections = new Map<string, string>();
  if (url.search.length <= COLLECTION_SELECTION_QUERY_MAX_CHARS + 1) {
    for (const [key, value] of url.searchParams) {
      if (!key.startsWith('can-row:')) continue;
      const occurrence = key.slice('can-row:'.length);
      if (occurrence === '' || value === '' || collectionSelections.has(occurrence)) {
        collectionSelections.clear();
        break;
      }
      collectionSelections.set(occurrence, value);
    }
  }
  const context: PresentationContext = {
    ...source,
    canonical: Object.freeze({
      ...source.canonical,
      readRecords: input.readRecords ?? unavailablePageRecords,
      ...(input.observeDelivery === undefined ? {} : { observeDelivery: input.observeDelivery }),
    }),
    ...(input.deploymentBase === undefined ? {} : { deploymentBase: input.deploymentBase }),
    preferredLocales: parseAcceptLanguage(input.request.headers.get('accept-language')),
    appDefaultLocale: input.appDefaultLocale,
    theme: DEFAULT_THEME,
    path: input.pathname,
    pollUrl: input.pathname + url.search,
    ...(input.searchQuery === undefined ? {} : { searchQuery: input.searchQuery }),
    collectionSelections,
    isPartial: input.isPartial,
    csrfToken: input.csrfToken,
    // A comparison key for the active browser view, never an authority grant.
    // Only already-client-visible session protection and this caller's own
    // selected identity participate; no email, grants or private records.
    pollContext: JSON.stringify([url.origin, input.pathname + url.search,
      input.csrfToken, input.principal.actor?.user_id ?? null,
      input.principal.team?.team_id ?? null]),
    principal: input.principal,
    invocation: input.principal,
    query: input.query,
    prepareCollectionFilters: collectionFilterPreparer(url.searchParams),
  };
  return input.catalog === undefined ? context : {
    ...context,
    prepareForm: createOperationFormPreparer(context, input.catalog, input.clock ?? systemInterfacesClock,
      input.formBindings === undefined || input.appId === undefined || input.sessionToken == null ? undefined : {
        service: input.formBindings, appId: input.appId, sessionToken: input.sessionToken, identity: input.principal,
      }),
  };
}
