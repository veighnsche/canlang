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
import { decodeValue, makeUserRef } from '@canlang/values';
import { createOperationFormPreparer } from './forms.js';
import { buildBusinessError } from '../errors/envelope.js';
import { systemInterfacesClock } from '../ports.js';
import type { InterfacesClock, SchemaCatalog, SourceFormBindings } from '../ports.js';
import type {
  PageSourceContext,
  PageDeliveryObserver,
  PageGenerationCallbackDiagnosticsObserver,
  PageRecordsReader,
  PageHistoryReader,
  PageFilePresenter,
  PageFileImageResolver,
  PresentationContext,
  ResolvedIdentity,
  RowQueryRunner,
  RowView,
  FilterCondition,
  DatetimeValue,
} from '@canlang/contracts';

/** Bounds locator extraction only; the complete page query stays in polling state. */
const COLLECTION_SELECTION_QUERY_MAX_CHARS = 8_192;

/** Rendering without an owning native viewer reader must refuse explicitly. */
const unavailablePageRecords: PageRecordsReader = async () => {
  throw buildBusinessError('validation', 'Authorized page source reads are not configured.');
};

/**
 * Request selectors choose only admitted values from the owning readable
 * inventory: enum case names, strict booleans for `bool` toggle columns,
 * bounded free text for `text` columns (C2 text-equality rule, DESIGN 975
 * scalar + operator table: ordinary string equality, never a spelling
 * inventory), or typed opaque identities for `user`/`member`/`ref:`
 * reference columns
 * (DESIGN 977: reference equality is not an enum spelling, so no case
 * inventory applies; unknown or inaccessible references simply match nothing,
 * DESIGN 1027). Conditions carry typed predicate values (booleans stay
 * booleans; text stays strings; reference identities stay `{id}` objects; the spellings
 * `"true"`/`"false"` only travel in column metadata and request text, never
 * as truthy filter values). Defaults initialize only declared controls
 * (DESIGN 975); explicit request selection or clear wins per control.
 */
function collectionFilterPreparer(params: URLSearchParams): NonNullable<PresentationContext['prepareCollectionFilters']> {
  const selectors = [...params];
  return (occurrence, fields, defaults) => {
    function refuse(): never { throw buildBusinessError('validation', 'Invalid collection filters.'); }
    const own = (value: object, key: string): unknown => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      return property !== undefined && property.enumerable && 'value' in property ? property.value : refuse();
    };
    // Opaque reference text from request/defaults: a non-empty string
    // without control characters, bounded like search input. Well-formed
    // but unknown ids match nothing downstream; malformed input refuses.
    const opaqueId = (value: unknown): string => {
      if (typeof value !== 'string' || value === '' || value.length > 200 ||
          /[\u0000-\u001f\u007f]/.test(value)) refuse();
      return value as string;
    };
    const referenceIdentity = (value: unknown): { readonly id: string } => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) refuse();
      const property = Object.getOwnPropertyDescriptor(value, 'id');
      if (property === undefined || !property.enumerable || !('value' in property)) refuse();
      return Object.freeze({ id: opaqueId(property.value) });
    };
    // C2 text-equality free text from request/defaults (DESIGN 975
    // scalar + operator table): a bounded non-empty string without
    // control characters, like search input. Well-formed values compare
    // by the ordinary string equality downstream, never a spelling
    // inventory; malformed input refuses. Empty means no restriction
    // (DESIGN 1023) and is mapped to null by the callers, never passed
    // here.
    const filterText = (value: unknown): string => {
      if (typeof value !== 'string' || value === '' || value.length > 200 ||
          /[\u0000-\u001f\u007f]/.test(value)) refuse();
      return value as string;
    };
    if (typeof occurrence !== 'string' || occurrence.length === 0) refuse();
    let prefix: string;
    try { prefix = `${COLLECTION_FILTER_PREFIX}${encodeURIComponent(occurrence)}:`; } catch { return refuse(); }
    const inventories = new Map<string, { readonly kind: 'enum' | 'bool' | 'ref' | 'text'; readonly cases: Set<string> }>();
    for (const column of fields) {
      if (typeof column !== 'object' || column === null) refuse();
      const field = own(column, 'field'), type = own(column, 'type'), labels = own(column, 'valueLabels');
      if (typeof field !== 'string' || field.trim().length === 0 || inventories.has(field) ||
          typeof labels !== 'object' || labels === null || Array.isArray(labels)) refuse();
      const cases = Object.keys(labels);
      if (type === 'bool') {
        if (cases.length !== 2 || !cases.includes('true') || !cases.includes('false')) refuse();
        try { collectionFilterName(occurrence, field); } catch { return refuse(); }
        inventories.set(field, { kind: 'bool', cases: new Set(cases) });
        continue;
      }
      if (type === 'user' || type === 'member' || (typeof type === 'string' && type.startsWith('ref:'))) {
        // Reference controls carry no spellings: the descriptor must not
        // smuggle an enum inventory alongside the opaque identity.
        if (cases.length !== 0) refuse();
        try { collectionFilterName(occurrence, field); } catch { return refuse(); }
        inventories.set(field, { kind: 'ref', cases: new Set() });
        continue;
      }
      // C2 text-equality rule (DESIGN 975 scalar): a `text` control
      // carries no spellings, exactly like a reference: the descriptor
      // must not smuggle an option inventory alongside the free text.
      if (type === 'text') {
        if (cases.length !== 0) refuse();
        try { collectionFilterName(occurrence, field); } catch { return refuse(); }
        inventories.set(field, { kind: 'text', cases: new Set() });
        continue;
      }
      if (typeof type !== 'string' || !type.startsWith('enum:') || type.slice(5).trim().length === 0 ||
          cases.length === 0 || cases.some(value => value.length === 0)) refuse();
      try { collectionFilterName(occurrence, field); } catch { return refuse(); }
      inventories.set(field, { kind: 'enum', cases: new Set(cases) });
    }
    const selected = new Map<string, string | boolean | { readonly id: string } | null>();
    if (defaults !== undefined) {
      if (typeof defaults !== 'object' || defaults === null || Array.isArray(defaults)) refuse();
      for (const field of Object.keys(defaults)) {
        const entry = inventories.get(field);
        if (entry === undefined) refuse();
        const value = own(defaults, field);
        if (entry.kind === 'bool') {
          if (value !== null && typeof value !== 'boolean') refuse();
        } else if (entry.kind === 'ref') {
          if (value !== null) {
            // Saved reference identities arrive either decoded (`{id}`)
            // or as the checked saved string the page preference capture
            // owns; both normalize to the opaque identity.
            selected.set(field, typeof value === 'string'
              ? Object.freeze({ id: opaqueId(value) })
              : referenceIdentity(value));
            continue;
          }
        } else if (entry.kind === 'text') {
          // C2 text-equality rule (DESIGN 975 scalar + 1023): a text
          // default is a bounded string or null; empty means no
          // restriction, exactly like a cleared request value.
          if (value !== null && typeof value !== 'string') refuse();
          selected.set(field, value === null || value === '' ? null : filterText(value));
          continue;
        } else if (value !== null && (typeof value !== 'string' || !entry.cases.has(value))) refuse();
        selected.set(field, value as string | boolean | null);
      }
    }
    const seen = new Set<string>();
    for (const [key, value] of selectors) {
      if (key.startsWith('filter[') || key.startsWith('f[')) refuse();
      if (!key.startsWith(prefix)) continue;
      let field: string;
      try { field = decodeURIComponent(key.slice(prefix.length)); } catch { return refuse(); }
      const entry = inventories.get(field);
      if (entry === undefined || collectionFilterName(occurrence, field) !== key || seen.has(field)) refuse();
      if (entry.kind === 'bool') {
        if (value !== '' && value !== 'true' && value !== 'false') refuse();
        seen.add(field);
        selected.set(field, value === '' ? null : value === 'true');
        continue;
      }
      if (entry.kind === 'ref') {
        seen.add(field);
        selected.set(field, value === '' ? null : Object.freeze({ id: opaqueId(value) }));
        continue;
      }
      // C2 text-equality rule: request text validates like defaults
      // (bounded, no control characters); empty clears the control
      // (DESIGN 1023). The emitted condition stays the existing
      // `eq` shape below.
      if (entry.kind === 'text') {
        seen.add(field);
        selected.set(field, value === '' ? null : filterText(value));
        continue;
      }
      if (value !== '' && !entry.cases.has(value)) refuse();
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
  /** Actual declared/admitted trail; source extras cannot supply it. */
  readonly breadcrumbs?: PresentationContext['breadcrumbs'];
  readonly catalog?: SchemaCatalog;
  readonly clock?: InterfacesClock;
  readonly formBindings?: SourceFormBindings;
  readonly appId?: string;
  readonly sessionToken?: string | null;
  /** Row-query runner bound before the call. */
  readonly query: RowQueryRunner;
  /** Native source-expression reader from the same admitted request scope. */
  readonly readRecords?: PageRecordsReader;
  readonly readHistory?: PageHistoryReader;
  readonly presentFile?: PageFilePresenter;
  readonly resolveFileImage?: PageFileImageResolver;
  readonly observeDelivery?: PageDeliveryObserver;
  readonly observeGenerationCallbackDiagnostics?: PageGenerationCallbackDiagnosticsObserver;
}

/** Project verified identity facts into the generated page callable contract. */
export function buildPageSourceContext(identity: ResolvedIdentity, readRecords?: PageRecordsReader): PageSourceContext {
  const { actor, team, membership } = identity;
  const active = actor !== null && team !== null && membership !== null
    && membership.status === 'active' && membership.user_id === actor.user_id
    && membership.team_id === team.team_id;
  const builtinRoles = ['public', ...(actor === null ? [] : ['authenticated']),
    ...(active ? ['members', ...(membership.is_owner ? ['owner'] : [])] : [])];
  return Object.freeze({
    now: decodeValue('datetime', identity.admitted_at) as DatetimeValue,
    actor: actor === null ? null : makeUserRef(actor.user_id),
    actorFacts: actor === null ? null : Object.freeze({ email: actor.email, email_verified: actor.email_verified }),
    team: team === null ? null : Object.freeze({ id: team.team_id, timezone: team.timezone }),
    memberships: Object.freeze(active ? membership.roles.map(grant => grant.role) : []),
    canonical: Object.freeze({ builtinRoles: Object.freeze(builtinRoles), ...(readRecords === undefined ? {} : { readRecords }) }),
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
  // Source extras cannot override host configuration, native readers or the
  // trusted identity admission instant shared with page guards and discovery.
  const { deploymentBase: _sourceDeploymentBase, readHistory: _sourceReadHistory,
    breadcrumbs: _sourceBreadcrumbs, presentFile: _sourcePresentFile, resolveFileImage: _sourceResolveFileImage, close: _sourceClose, resolveCaller: _sourceResolveCaller, now: _sourceNow, ...source } =
    (input.source ?? buildPageSourceContext(input.principal)) as PageSourceContext &
      Pick<PresentationContext, 'deploymentBase' | 'readHistory' | 'breadcrumbs' | 'presentFile' | 'resolveFileImage'> & { readonly close?: unknown; readonly resolveCaller?: unknown };
  const { observeGenerationCallbackDiagnostics: _sourceCallbackDiagnostics, ...canonical } = source.canonical;
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
    now: decodeValue('datetime', input.principal.admitted_at) as DatetimeValue,
    canonical: Object.freeze({
      ...canonical,
      readRecords: input.readRecords ?? unavailablePageRecords,
      ...(input.observeDelivery === undefined ? {} : { observeDelivery: input.observeDelivery }),
      ...(input.observeGenerationCallbackDiagnostics === undefined ? {} : {
        observeGenerationCallbackDiagnostics: input.observeGenerationCallbackDiagnostics,
      }),
    }),
    ...(input.deploymentBase === undefined ? {} : { deploymentBase: input.deploymentBase }),
    preferredLocales: parseAcceptLanguage(input.request.headers.get('accept-language')),
    appDefaultLocale: input.appDefaultLocale,
    theme: DEFAULT_THEME,
    path: input.pathname,
    ...(input.breadcrumbs === undefined ? {} : { breadcrumbs: input.breadcrumbs }),
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
    ...(input.readHistory === undefined ? {} : { readHistory: input.readHistory }),
    ...(input.presentFile === undefined ? {} : { presentFile: input.presentFile }),
    ...(input.resolveFileImage === undefined ? {} : { resolveFileImage: input.resolveFileImage }),
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

/**
 * BGI-09 row-bound renderer input: project one loaded row to the fields
 * the view admits, freezing the projection the saved renderer arranges.
 * Refused fields are absent (not nulled): the renderer cannot
 * distinguish them from fields the model never had. Unknown admitted
 * names throw naming the view, so a misbuilt caller fails before the
 * renderer runs.
 */
export function projectViewRow(
  view: string,
  row: RowView,
  admittedFields: ReadonlyArray<string>,
): RowView {
  const fields: Record<string, unknown> = {};
  for (const field of admittedFields) {
    if (!Object.hasOwn(row.fields, field)) {
      throw buildBusinessError('validation', `Generated view ${JSON.stringify(view)} admits unknown row field ${JSON.stringify(field)}.`);
    }
    fields[field] = row.fields[field];
  }
  return Object.freeze({
    id: row.id,
    ...(row.version === undefined ? {} : { version: row.version }),
    fields: Object.freeze(fields),
  });
}
