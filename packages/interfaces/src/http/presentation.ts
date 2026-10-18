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
 * `currencyScales` comes from the pinned Values currency table so original
 * Money columns use canonical minor units without request-provided scales.
 */
import { DEFAULT_THEME, COLLECTION_FILTER_PREFIX, collectionFilterName } from '@canlang/contracts';
import { CURRENCY_MINOR_UNITS, decodeValue, encodeValue, makeUserRef } from '@canlang/values';
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
  ColumnMeta,
  CollectionFilterDefault,
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
 * inventory), civil `YYYY-MM-DD` dates for `date` columns (C3
 * civil-date equality rule, DESIGN 1015-1025 operator table: exact
 * typed equality over civil dates, never shifted instants), or typed
 * opaque identities for `user`/`member`/`ref:` reference columns
 * (DESIGN 977: reference equality is not an enum spelling, so no case
 * inventory applies; unknown or inaccessible references simply match nothing,
 * DESIGN 1027). Conditions carry typed predicate values (booleans stay
 * booleans; text and civil dates stay strings; reference identities stay `{id}` objects; the spellings
 * `"true"`/`"false"` only travel in column metadata and request text, never
 * as truthy filter values). Defaults initialize only declared controls
 * (DESIGN 975); explicit request selection or clear wins per control.
 */
function refuseCollectionFilters(): never {
  throw buildBusinessError('validation', 'Invalid collection filters.');
}

function ownFilterProperty(value: object, key: string): unknown {
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property !== undefined && property.enumerable && 'value' in property ? property.value : refuseCollectionFilters();
}

// Opaque reference text from request/defaults: a non-empty string
// without control characters, bounded like search input. Well-formed
// but unknown ids match nothing downstream; malformed input refuses.
function opaqueFilterId(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(value)) refuseCollectionFilters();
  return value as string;
}

function filterReferenceIdentity(value: unknown): { readonly id: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) refuseCollectionFilters();
  const property = Object.getOwnPropertyDescriptor(value, 'id');
  if (property === undefined || !property.enumerable || !('value' in property)) refuseCollectionFilters();
  return Object.freeze({ id: opaqueFilterId(property.value) });
}

// C2 text-equality free text from request/defaults (DESIGN 975
// scalar + operator table): a bounded non-empty string without
// control characters, like search input. Well-formed values compare
// by the ordinary string equality downstream, never a spelling
// inventory; malformed input refuses. Empty means no restriction
// (DESIGN 1023) and is mapped to null by the callers, never passed
// here.
function filterTextValue(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(value)) refuseCollectionFilters();
  return value as string;
}

// C3 civil-date equality from request/defaults (DESIGN 1015-1025
// operator table): a real civil `YYYY-MM-DD` date in years
// 0001-9999, validated through the canonical date wire (leap days
// and month lengths enforced, never a shifted instant). The wire
// string itself flows downstream, where the state string equality
// evaluates it. Malformed input refuses; empty means no restriction
// (DESIGN 1023) and is mapped to null by the callers, never passed
// here.
function filterDateValue(value: unknown): string {
  if (typeof value === 'string') {
    if (value === '') refuseCollectionFilters();
    try {
      decodeValue('date', value);
    } catch {
      refuseCollectionFilters();
    }
    return value;
  }
  // Compiled `date("...")` literal defaults arrive as canonical
  // DateValue objects (the `date()` helper returns decoded values,
  // not wire strings); normalize them to the wire string the state
  // string equality evaluates. Anything else refuses.
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    try {
      const wire = encodeValue('date', value as never);
      if (typeof wire !== 'string') refuseCollectionFilters();
      return wire as string;
    } catch {
      refuseCollectionFilters();
    }
  }
  return refuseCollectionFilters();
}

function filterScalarWire(type: 'int' | 'datetime' | 'currency', value: unknown): string {
  try {
    // Request/saved strings use canonical codecs. Compiled int defaults
    // are bigint values and follow the same exact wire representation.
    const decoded = typeof value === 'string' ? decodeValue(type, value) : value;
    const wire = encodeValue(type, decoded as never);
    if (typeof wire !== 'string') return refuseCollectionFilters();
    return wire;
  } catch { return refuseCollectionFilters(); }
}

type FilterInventoryKind = 'enum' | 'bool' | 'ref' | 'text' | 'date' | 'int' | 'datetime' | 'currency';

interface FilterInventory {
  readonly kind: FilterInventoryKind;
  readonly cases: Set<string>;
}

type FilterSelection = string | boolean | { readonly id: string } | null;

function admitFilterInventory(
  inventories: Map<string, FilterInventory>,
  occurrence: string,
  field: string,
  kind: FilterInventoryKind,
  names: readonly string[],
): void {
  try { collectionFilterName(occurrence, field); } catch { return refuseCollectionFilters(); }
  inventories.set(field, { kind, cases: new Set(names) });
}

function admitEmptyFilterInventory(
  inventories: Map<string, FilterInventory>,
  occurrence: string,
  field: string,
  cases: string[],
  kind: 'ref' | 'text' | 'date' | 'int' | 'datetime' | 'currency',
): void {
  if (cases.length !== 0) refuseCollectionFilters();
  admitFilterInventory(inventories, occurrence, field, kind, []);
}

function setFilterInventory(
  inventories: Map<string, FilterInventory>,
  occurrence: string,
  field: string,
  type: unknown,
  cases: string[],
): void {
  if (type === 'bool') {
    if (cases.length !== 2 || !cases.includes('true') || !cases.includes('false')) refuseCollectionFilters();
    admitFilterInventory(inventories, occurrence, field, 'bool', cases);
    return;
  }
  // Reference controls carry no spellings: the descriptor must not
  // smuggle an enum inventory alongside the opaque identity.
  if (type === 'user' || type === 'member' || (typeof type === 'string' && type.startsWith('ref:'))) {
    admitEmptyFilterInventory(inventories, occurrence, field, cases, 'ref');
    return;
  }
  // C2 text-equality rule (DESIGN 975 scalar): a `text` control
  // carries no spellings, exactly like a reference: the descriptor
  // must not smuggle an option inventory alongside the free text.
  if (type === 'text') {
    admitEmptyFilterInventory(inventories, occurrence, field, cases, 'text');
    return;
  }
  // C3 civil-date equality rule (DESIGN 1015-1025 operator table):
  // a `date` control carries no spellings, exactly like text/a
  // reference: the descriptor must not smuggle an option inventory
  // alongside the civil date.
  if (type === 'date') {
    admitEmptyFilterInventory(inventories, occurrence, field, cases, 'date');
    return;
  }
  if (type === 'int' || type === 'datetime' || type === 'currency') {
    admitEmptyFilterInventory(inventories, occurrence, field, cases, type);
    return;
  }
  if (typeof type !== 'string' || !type.startsWith('enum:') || type.slice(5).trim().length === 0 ||
      cases.length === 0 || cases.some(value => value.length === 0)) refuseCollectionFilters();
  admitFilterInventory(inventories, occurrence, field, 'enum', cases);
}

function buildFilterInventories(
  occurrence: string,
  fields: readonly ColumnMeta[],
): Map<string, FilterInventory> {
  const inventories = new Map<string, FilterInventory>();
  for (const column of fields) {
    if (typeof column !== 'object' || column === null) refuseCollectionFilters();
    const field = ownFilterProperty(column, 'field'), type = ownFilterProperty(column, 'type'),
      labels = ownFilterProperty(column, 'valueLabels');
    if (typeof field !== 'string' || field.trim().length === 0 || inventories.has(field) ||
        typeof labels !== 'object' || labels === null || Array.isArray(labels)) refuseCollectionFilters();
    setFilterInventory(inventories, occurrence, field, type, Object.keys(labels));
  }
  return inventories;
}

function setRefFilterDefault(
  field: string,
  value: CollectionFilterDefault,
  selected: Map<string, FilterSelection>,
): void {
  // Saved reference identities arrive either decoded (`{id}`)
  // or as the checked saved string the page preference capture
  // owns; both normalize to the opaque identity.
  selected.set(field, typeof value === 'string'
    ? Object.freeze({ id: opaqueFilterId(value) })
    : filterReferenceIdentity(value));
}

function setTextFilterDefault(
  field: string,
  value: CollectionFilterDefault,
  selected: Map<string, FilterSelection>,
): void {
  // C2 text-equality rule (DESIGN 975 scalar + 1023): a text
  // default is a bounded string or null; empty means no
  // restriction, exactly like a cleared request value.
  selected.set(field, value === null || value === '' ? null : filterTextValue(value));
}

function setDateFilterDefault(
  field: string,
  value: CollectionFilterDefault,
  selected: Map<string, FilterSelection>,
): void {
  // C3 civil-date equality rule (DESIGN 1015-1025 + 1023): a
  // date default is a civil date or null; empty means no
  // restriction, exactly like a cleared request value.
  // Compiled `date("...")` literal defaults arrive as canonical
  // DateValue objects, not wire strings; filterDateValue normalizes
  // both spellings and refuses anything else.
  selected.set(field, value === null || value === '' ? null : filterDateValue(value));
}

function setFilterDefault(
  entry: FilterInventory,
  field: string,
  value: CollectionFilterDefault,
  selected: Map<string, FilterSelection>,
): void {
  if (entry.kind === 'bool') {
    if (value !== null && typeof value !== 'boolean') refuseCollectionFilters();
  } else if (entry.kind === 'ref') {
    if (value !== null) {
      setRefFilterDefault(field, value, selected);
      return;
    }
  } else if (entry.kind === 'text') {
    if (value !== null && typeof value !== 'string') refuseCollectionFilters();
    setTextFilterDefault(field, value, selected);
    return;
  } else if (entry.kind === 'date') {
    if (value !== null && typeof value !== 'string' &&
        (typeof value !== 'object' || value === null || Array.isArray(value))) refuseCollectionFilters();
    setDateFilterDefault(field, value, selected);
    return;
  } else if (value !== null) {
    setScalarOrEnumFilterDefault(entry, field, value, selected);
    return;
  }
  selected.set(field, value as string | boolean | null);
}

function setScalarOrEnumFilterDefault(
  entry: FilterInventory,
  field: string,
  value: CollectionFilterDefault,
  selected: Map<string, FilterSelection>,
): void {
  if (entry.kind === 'int' || entry.kind === 'datetime' || entry.kind === 'currency') {
    selected.set(field, value === null || value === '' ? null : filterScalarWire(entry.kind, value));
    return;
  }
  if (value !== null && (typeof value !== 'string' || !entry.cases.has(value))) refuseCollectionFilters();
  selected.set(field, value as string | boolean | null);
}

function applyFilterDefaults(
  defaults: Readonly<Record<string, CollectionFilterDefault>>,
  inventories: Map<string, FilterInventory>,
  selected: Map<string, FilterSelection>,
): void {
  if (typeof defaults !== 'object' || defaults === null || Array.isArray(defaults)) refuseCollectionFilters();
  for (const field of Object.keys(defaults)) {
    const entry = inventories.get(field);
    if (entry === undefined) refuseCollectionFilters();
    setFilterDefault(entry, field, ownFilterProperty(defaults, field) as CollectionFilterDefault, selected);
  }
}

function setFilterSelection(
  entry: FilterInventory,
  field: string,
  value: string,
  seen: Set<string>,
  selected: Map<string, FilterSelection>,
): void {
  if (entry.kind === 'bool') {
    if (value !== '' && value !== 'true' && value !== 'false') refuseCollectionFilters();
    seen.add(field);
    selected.set(field, value === '' ? null : value === 'true');
    return;
  }
  if (entry.kind === 'ref') {
    seen.add(field);
    selected.set(field, value === '' ? null : Object.freeze({ id: opaqueFilterId(value) }));
    return;
  }
  // C2 text-equality rule: request text validates like defaults
  // (bounded, no control characters); empty clears the control
  // (DESIGN 1023). The emitted condition stays the existing
  // `eq` shape below.
  if (entry.kind === 'text') {
    seen.add(field);
    selected.set(field, value === '' ? null : filterTextValue(value));
    return;
  }
  // C3 civil-date equality rule: request dates validate like
  // defaults (real civil dates); empty clears the control
  // (DESIGN 1023). The emitted condition stays the existing
  // `eq` shape below.
  if (entry.kind === 'date') {
    seen.add(field);
    selected.set(field, value === '' ? null : filterDateValue(value));
    return;
  }
  if (entry.kind === 'int' || entry.kind === 'datetime' || entry.kind === 'currency') {
    seen.add(field);
    selected.set(field, value === '' ? null : filterScalarWire(entry.kind, value));
    return;
  }
  if (value !== '' && !entry.cases.has(value)) refuseCollectionFilters();
  seen.add(field);
  selected.set(field, value === '' ? null : value);
}

function applyFilterSelectors(
  selectors: ReadonlyArray<readonly [string, string]>,
  prefix: string,
  occurrence: string,
  inventories: Map<string, FilterInventory>,
  selected: Map<string, FilterSelection>,
): void {
  const seen = new Set<string>();
  for (const [key, value] of selectors) {
    if (key.startsWith('filter[') || key.startsWith('f[')) refuseCollectionFilters();
    if (!key.startsWith(prefix)) continue;
    let field: string;
    try { field = decodeURIComponent(key.slice(prefix.length)); } catch { return refuseCollectionFilters(); }
    const entry = inventories.get(field);
    if (entry === undefined || collectionFilterName(occurrence, field) !== key || seen.has(field)) refuseCollectionFilters();
    setFilterSelection(entry, field, value, seen, selected);
  }
}

function collectionFilterPreparer(params: URLSearchParams): NonNullable<PresentationContext['prepareCollectionFilters']> {
  const selectors = [...params];
  return (occurrence, fields, defaults) => {
    if (typeof occurrence !== 'string' || occurrence.length === 0) refuseCollectionFilters();
    let prefix: string;
    try { prefix = `${COLLECTION_FILTER_PREFIX}${encodeURIComponent(occurrence)}:`; } catch { return refuseCollectionFilters(); }
    const inventories = buildFilterInventories(occurrence, fields);
    const selected = new Map<string, FilterSelection>();
    if (defaults !== undefined) {
      applyFilterDefaults(defaults, inventories, selected);
    }
    applyFilterSelectors(selectors, prefix, occurrence, inventories, selected);
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
function collectRowSelections(url: URL): Map<string, string> {
  const collectionSelections = new Map<string, string>();
  if (url.search.length > COLLECTION_SELECTION_QUERY_MAX_CHARS + 1) return collectionSelections;
  for (const [key, value] of url.searchParams) {
    if (!key.startsWith('can-row:')) continue;
    const occurrence = key.slice('can-row:'.length);
    if (occurrence === '' || value === '' || collectionSelections.has(occurrence)) {
      collectionSelections.clear();
      break;
    }
    collectionSelections.set(occurrence, value);
  }
  return collectionSelections;
}

function attachOperationForm(
  context: PresentationContext,
  input: BuildPresentationContextInput,
): PresentationContext {
  if (input.catalog === undefined) return context;
  return {
    ...context,
    prepareForm: createOperationFormPreparer(context, input.catalog, input.clock ?? systemInterfacesClock,
      input.formBindings === undefined || input.appId === undefined || input.sessionToken == null ? undefined : {
        service: input.formBindings, appId: input.appId, sessionToken: input.sessionToken, identity: input.principal,
      }),
  };
}

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
  const collectionSelections = collectRowSelections(url);
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
    currencyScales: CURRENCY_MINOR_UNITS,
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
  return attachOperationForm(context, input);
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
