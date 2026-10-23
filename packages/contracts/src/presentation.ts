/**
 * Presentation boundary contract (lane 05 owned).
 *
 * Canonical component props, page descriptors, admitted bindings, operation/reference
 * bindings and safe message values shared by compiler emission (lane 1) and route
 * dispatch (lane 6). This file is types and wire shapes only: no execution engine,
 * no second CRUD/policy engine, no browser business-state store.
 * Protected POST targets below are rooted local paths with one leading slash.
 * Absolute/network URLs, backslashes, whitespace, controls and fragments refuse;
 * ordinary navigation links retain their separate URL policy.
 *
 * Member TS imports this module directly (workspace-wide pattern); the L7
 * contracts index re-exports it for external consumers. No duplicate
 * definitions: this file is the single source of truth for the shapes below.
 */

import type {
  BusinessError,
  DerivedOperationInputs,
  FieldError,
  MutationRef,
  SealedActionHandle,
} from "./wire.js";
import type { DeliveryStatus } from "./services.js";
import type { HistoryEntry, Revision } from "./state.js";
import type { DatetimeValue, FileValue, UserRef } from "./values.js";
import type { GenerationCallbackDiagnosticResult, GenerationCallbackFailure, ReceiptProperty } from "./work.js";

/** Reused producer types, re-exported so lane-05 members import one contract file. */
export type { BusinessError, FieldError, MutationRef, SealedActionHandle } from "./wire.js";
export type { DeliveryStatus } from "./services.js";
export type { HistoryEntry } from "./state.js";

export const PRESENTATION_CONTRACT_VERSION = "canlang.presentation/0.15.0";

/**
 * Name of the hidden CSRF field in every canonical POST form. Rendered by
 * lane 05, read by the lane 6 dispatcher (ack requested); never a business
 * input and never logged.
 */
export const CSRF_FIELD = "_csrf";
/** Opaque, host-verified source form binding; never canonical business input. */
export const SOURCE_FORM_BINDING_FIELD = "form_binding";

/** Source-occurrence query state only; never mutation inputs or authority. */
export const COLLECTION_FILTER_PREFIX = "can-filter:";
export function collectionFilterName(occurrence: string, field: string): string {
  return `${COLLECTION_FILTER_PREFIX}${encodeURIComponent(occurrence)}:${encodeURIComponent(field)}`;
}

/** Opaque continuation transport for one source occurrence; never authority. */
export function collectionCursorName(occurrence: string): string {
  return `can-cursor:${encodeURIComponent(occurrence)}`;
}

/**
 * Name of the pre-session token field in the login form. Rendered by lane
 * 05 from the `GET /auth/login` descriptor value, read by the lane 6
 * dispatcher before credentials are checked; never a business input and
 * never logged. Single-use: every credential-checked login POST consumes
 * the token, so a failed attempt refetches the descriptor.
 */
export const PRESESSION_FIELD = "_presession";

/**
 * Name of the team-select field in the account switcher form. Rendered by
 * lane 05, read by the lane 6 dispatcher at ShellRoutes.switchTeam (ack
 * requested); carries an opaque team id, never a grant.
 */
export const TEAM_FIELD = "team";

/** BCP 47 language tag in canonical form (see `normalizeTag` in @canlang/ui). */
export type Bcp47Tag = string;

/**
 * Localized variants keyed by canonical tag. `null` marks an absent translation,
 * which is distinct from an empty translation and is skipped during lookup.
 */
export type MessageVariantMap = Record<string, string | null>;

/**
 * One bound message parameter: `type` is the canonical resolved type id
 * (scalar `int`, qualified enum identities like `expense.Expense.status`, ...);
 * ids arrive unwrapped because message params are nonnullable scalar display
 * values (string-like, bool/enum, int/decimal, money, date/datetime).
 */
export interface MessageParamValue {
  readonly type: string;
  readonly value: unknown;
}

export type MessageParams = Record<string, MessageParamValue>;

/**
 * Immutable message descriptor: canonical source text plus explicit variants.
 * Single-use text and shared `message` declarations lower to this shape.
 * Descriptors are not stored fields, client-supplied keys, callbacks or tools.
 */
export interface MessageDescriptor {
  /** Checked owning source locale; omitted legacy descriptors retain explicit resolver options. */
  readonly sourceLocale?: string;
  readonly source: string;
  readonly variants: MessageVariantMap;
  readonly params?: MessageParams;
}

/** Factory implemented by @canlang/ui and called by generated code. */
export type MessageFactory = (
  source: string,
  variants?: MessageVariantMap,
  params?: MessageParams,
  sourceLocale?: string,
) => MessageDescriptor;

/** Any caption slot: literal source text or a full descriptor. */
export type MessageValue = string | MessageDescriptor;

/** Final display text and its effective locale. Never parse or resolve this text as a message pattern. */
export interface ResolvedMessage {
  readonly text: string;
  readonly locale: string;
}

export type ThemeMode = "system" | "light" | "dark";
export type ThemeAccent = "blue" | "green" | "purple";
export type ThemeDensity = "comfortable" | "compact";

/**
 * Finite theme tokens. The renderer maps these to shared daisyUI theme
 * variables and layout spacing; apps supply no stylesheets or classes.
 */
export interface ThemeTokens {
  readonly mode: ThemeMode;
  readonly accent: ThemeAccent;
  readonly density: ThemeDensity;
}

export const DEFAULT_THEME: ThemeTokens = {
  mode: "system",
  accent: "blue",
  density: "comfortable",
} as const;

/**
 * Server-private bindings produced by page admission and consumed by the
 * renderer at the same read checkpoint. Never serialized into navigation.
 */
export interface AdmittedBindings {
  readonly [key: string]: unknown;
}

/**
 * Compiler-derived shared admission callable. Checks inferred context and
 * page-level guards; returns the bindings the renderer needs (empty when no
 * data/record bindings were needed). A false presentation guard raises the
 * ordinary safe page denial; dependency failures remain failures, never
 * true/false permission. The first parameter is the canonical invocation
 * context (lane 3/6 owned, opaque here); route bindings carry typed record
 * ids or token/scalar route values.
 */
export type AdmitFn = (
  context: unknown,
  routeBindings?: Record<string, unknown>,
) => Promise<AdmittedBindings>;

/** One rendered child: HTML string, possibly async (authorized reads). */
export type PageChild = string | Promise<string>;

/**
 * Page body children: an array, or a thunk returning (a promise of) an array.
 * The canonical emitted form is the array; the thunk is accepted for
 * compatibility with existing draft targets.
 */
export type PageChildren =
  | readonly PageChild[]
  | (() => readonly PageChild[] | Promise<readonly PageChild[]>);

/** Native source facts shared by page admission, discovery, and rendering. */
export interface PageSourceContext {
  /** Native Datetime from the trusted identity admission instant, shared by guards and rendering. */
  readonly now: DatetimeValue;
  readonly actor: UserRef | null;
  readonly actorFacts: { readonly email: string; readonly email_verified: boolean } | null;
  readonly team: { readonly id: string; readonly timezone: string } | null;
  readonly memberships: readonly string[];
  /** Dispatcher-loaded saved values, scoped to this resolved actor and team. */
  readonly preferences?: Readonly<Record<string, Readonly<Record<string, string | null>>>>;
  /** Version of each saved value (`0` means no saved row yet). */
  readonly preferenceVersions?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly canonical: {
    readonly builtinRoles: readonly string[];
    /** Native records from this request's authorized viewer scope, shared by
     * matched dynamic admission and rendering without granting page authority. */
    readonly readRecords?: PageRecordsReader;
    readonly observeDelivery?: PageDeliveryObserver;
    readonly observeGenerationCallbackDiagnostics?: PageGenerationCallbackDiagnosticsObserver;
  };
}

/**
 * Typed opaque identity for user/member/model reference filter controls
 * (DESIGN 977: `eq` using typed opaque identity and authorized lookup).
 * Never an enum spelling: no case inventory applies, and unknown or
 * inaccessible references simply match nothing (DESIGN 1027).
 */
export interface ReferenceFilterIdentity {
  readonly id: string;
}

/**
 * Initial collection filter selections (DESIGN 975: each value must match its
 * control type). Enum case spellings, bool toggles, reference identities, or
 * null for no initial restriction. Explicit request selection or clear wins.
 */
export type CollectionFilterDefault = string | boolean | bigint | ReferenceFilterIdentity | null;

/** Dispatcher-owned presentation view; raw principal stays opaque to UI. */
export interface PresentationContext extends Partial<PageSourceContext> {
  /**
   * Trusted host configuration: HTTP(S) origin plus the app mount prefix.
   * Never inferred from request, polling or authentication URLs. Absent
   * configuration leaves app_url unavailable; constructing a link grants no access.
   */
  readonly deploymentBase?: string;
  /** Exact-operation form preparation supplied by the request dispatcher. */
  readonly prepareForm?: OperationFormPreparer;
  /** Current request selection over checked owning enum/bool/reference declarations; no query authority. */
  readonly prepareCollectionFilters?: (
    occurrence: string,
    fields: readonly ColumnMeta[],
    defaults?: Readonly<Record<string, CollectionFilterDefault>>,
  ) => readonly FilterCondition[];
  /** Viewer locale preference: saved preference, then language priority list. */
  readonly preferredLocales: readonly string[];
  /** Owning app default locale (pinned "en" unless the app declares otherwise). */
  readonly appDefaultLocale: string;
  readonly theme: ThemeTokens;
  /** Current normalized path, for navigation highlight. */
  readonly path: string;
  /** Admitted declared static ancestry and current page, supplied only by the dispatcher. */
  readonly breadcrumbs?: Pick<BreadcrumbsProps, "label" | "ancestry">;
  /** Dispatcher-owned page/principal/team comparison token; grants are never encoded. */
  readonly pollContext?: string;
  /** Current same-app pathname plus query, preserving team selection and filters. */
  readonly pollUrl?: string;
  /** Validated request-local collection search text; source fields stay compiler-owned. */
  readonly searchQuery?: string;
  /** URL occurrence → row-id locators; select only from the current authorized collection result. */
  readonly collectionSelections?: ReadonlyMap<string, string>;
  /** True for HTMX partial requests; false for full page GET. */
  readonly isPartial: boolean;
  /** Lane 6 issued CSRF token covering canonical POSTs from this page. */
  readonly csrfToken: string;
  /** Canonical principal; opaque to presentation, never inspected here. */
  readonly principal: unknown;
  /**
   * Canonical invocation context for authorized in-render reads; opaque to
   * presentation, passed only to `query`. Supplied by the dispatcher.
   */
  readonly invocation: unknown;
  /**
   * Authorized row-query runner bound by the dispatcher to canonical
   * records(). The sole path by which UI factories obtain rows; UI never
   * queries around it and never re-implements policy.
   */
  readonly query: RowQueryRunner;
  /** Current-authorized history reader supplied only by the admitted page scope. */
  readonly readHistory?: PageHistoryReader;
  /** Original File occurrence to current authorized link; a File ID alone grants nothing. */
  readonly presentFile?: PageFilePresenter;
  /** Current admitted row/checked File field to protected image destinations. */
  readonly resolveFileImage?: PageFileImageResolver;
  /**
   * Pinned minor-unit currency scales (lane 2 table) for money display;
   * absent scales fail money rendering loudly rather than guessing.
   */
  readonly currencyScales?: Record<string, number>;
}

/**
 * Sole generated page descriptor, in source order in appDefinition.pages.
 * Caption slots are static message values (context-free constants); `order`
 * is an exact bigint when explicitly authored and serializes as a decimal
 * string across JSON; `group`/`nav` retain actual exceptions only; dynamic
 * routes are intrinsically excluded from discovery. The owning package label
 * stays in package metadata, never copied per page.
 */
export interface PageDescriptor {
  /** Compiler-owned style hooks for the canonical page main and its interior. */
  readonly style?: { readonly unitId: string; readonly useId: string };
  /** Optional authorized page reread cadence in integer milliseconds (1s–1h). */
  readonly poll?: bigint;
  /** Checked canonical scenario repeated only after its explicit form succeeds. */
  readonly refresh?: string;
  /** Canonical declaring package. */
  readonly owner: string;
  /** Normalized route pattern, e.g. "/expenses/review" or "/invoices/{Invoice.id}". */
  readonly path: string;
  readonly title: MessageValue;
  readonly description?: MessageValue;
  readonly order?: bigint;
  readonly group?: MessageValue;
  readonly nav?: "none";
  /** Source-owned filter selectors (enum cases, bool spellings, free text, or civil dates) that this page can save for its current actor/team. */
  readonly preferenceFields?: readonly {
    readonly name: string;
    /** Case spellings for enum/bool leaves; empty for reference/text/date leaves, which carry no inventory. */
    readonly options: readonly string[];
    /** Source field and enum-case captions, resolved in the viewer locale. */
    readonly caption?: MessageValue;
    readonly optionLabels?: Readonly<Record<string, MessageValue>>;
    /** Only the original nullable initial default; saved enum values stay cases, saved text stays a bounded string, saved dates stay civil dates. */
    readonly nullable?: true;
    readonly defaultValue: string | null;
    /**
     * Reference preference leaf behind a filter default (DESIGN 977):
     * no case options, no literal default; the saved identity stays
     * opaque and validates as an opaque string. Reference, text and
     * date leaves carry no save control: only enum/bool selections
     * save through the preference form.
     */
    readonly reference?: true;
    /**
     * Civil-date preference leaf behind a filter default (C3, DESIGN
     * 1015-1025): no case options; the default and saved values are
     * civil `YYYY-MM-DD` strings validated as real dates downstream.
     * Only the compiler emits this shape.
     */
    readonly date?: true;
    /** Exact scalar wire type for saved equality-filter values; no enum/save control. */
    readonly scalarType?: 'int' | 'datetime' | 'currency';
    /** Only an authored inline editor enables scalar saves and nullable clearing. */
    readonly editable?: 'bool' | 'text' | 'int';
  }[];
  readonly admit: AdmitFn;
  readonly render: RenderFn;
  /** Direct authored page children for hosts that compose heading groups.
   * The dispatcher chooses this instead of render, preserving one evaluation. */
  readonly renderParts?: (context: PresentationContext, bindings: AdmittedBindings) => Promise<readonly string[]>;
}

/**
 * Generated page render function. Called by the dispatcher only after `admit`
 * succeeds, with the same admitted bindings at a valid checkpoint. Evaluates
 * remaining page data lazily; never re-implements the page guard, title or
 * placement. Returns full-document HTML for GET, fragment HTML for partials.
 */
export type RenderFn = (
  context: PresentationContext,
  bindings: AdmittedBindings,
) => Promise<string>;

/** Canonical operation identity, e.g. "TeamTasks.Todo.create" or "reporting.summarize". */
export type OperationRef = string;

/**
 * Typed record identity for bound arguments and version checks.
 * Both fields are opaque; versions use canonical decimal strings on the wire.
 */
export interface RecordIdentity {
  readonly id: string;
  readonly version: string;
}

/**
 * Bound operation arguments supplied by generated forms/actions. Values must
 * be exact wire-compatible scalars, record identities, or opaque file/action
 * handles; protected record bindings stay hidden/read-only.
 */
export type BoundArguments = Record<string, unknown>;

/**
 * Admission outcome per discovery candidate, mapped by the lane 6 dispatcher
 * from admit(): denied yields no link, unavailable yields a generic
 * incomplete-navigation state without destination disclosure.
 */
export type AdmissionOutcome = "admitted" | "denied" | "unavailable";

export interface NavigationEntry {
  readonly owner: string;
  readonly path: string;
  readonly title: MessageValue;
  /** Carried for future surfaces; S2 nav renders titles only. */
  readonly description?: MessageValue;
  readonly active: boolean;
}

export interface NavigationGroup {
  readonly owner: string;
  readonly caption: MessageValue;
  readonly entries: readonly NavigationEntry[];
}

export interface NavigationResult {
  readonly groups: readonly NavigationGroup[];
  /** True when any candidate was unavailable: show the generic incomplete state. */
  readonly incomplete: boolean;
}

/** Owner labels from package metadata, keyed by canonical owner. */
export type OwnerLabels = ReadonlyMap<string, MessageValue>;

export interface ShellRoutes {
  /** Lane 6 canonical endpoints; lane 05 never invents URLs. */
  readonly signIn: string;
  readonly signOut: string;
  readonly switchTeam: string;
}

export interface TeamOption {
  readonly id: string;
  /** L6-supplied safe display text; escaped on render. */
  readonly label: string;
}

export interface AccountMenuData {
  readonly authenticated: boolean;
  /** L6-supplied safe user label (opaque identity, escaped on render). */
  readonly userLabel?: string;
  readonly teams: readonly TeamOption[];
  readonly currentTeamId?: string;
}

export interface SettingsSection {
  readonly id: string;
  readonly caption: MessageValue;
  readonly active: boolean;
}

export interface SettingsFrameData {
  readonly sections: readonly SettingsSection[];
  /** Pre-rendered active panel HTML (settings.ts in S6); absent renders frame only. */
  readonly panelHtml?: string;
}

export interface ShellData {
  readonly navigation: NavigationResult;
  /** App wordmark/logo fallback caption. */
  readonly brand: MessageValue;
  readonly routes: ShellRoutes;
  readonly account: AccountMenuData;
  readonly settings: SettingsFrameData;
  /**
   * Highlight override for contextual details (parent destination stays lit).
   * Consumed by buildNavigation via BuildNavigationOptions; renderPage ignores it.
   */
  readonly highlightPath?: string;
}

/**
 * renderPage, implemented by @canlang/ui and called by generated page render
 * functions. Full pages require `shell` (the dispatcher supplies discovery
 * results); partials ignore it. Never dispatches routes or invokes admit.
 */
export type RenderPageFn = (
  context: PresentationContext,
  descriptor: PageDescriptor,
  children: PageChildren,
  shell?: ShellData,
) => Promise<string>;

/**
 * Canonical login screen props. The form POSTs to the lane-6 signIn route
 * with CSRF; lane 05 renders only and never implements an account flow.
 * `next` is a same-app relative path preserved across sign-in; anything
 * else fails closed to the app root.
 */
export interface LoginProps {
  readonly context: PresentationContext;
  /** Dispatcher-supplied signIn POST target; lane 05 never invents URLs. */
  readonly action: string;
  readonly brand: MessageValue;
  /** Safe L6-supplied failure text; absent renders no error. */
  readonly error?: MessageValue;
  readonly next?: string;
  /** Caller-unique prefix for input ids (deterministic for tests). */
  readonly idPrefix: string;
  /**
   * Single-use pre-session token from the login descriptor; rendered as a
   * hidden `_presession` field. Absent renders no field (static previews).
   */
  readonly preSessionToken?: string;
}

/**
 * One projected row for list/table rendering. Fields hold the authorized
 * projection only: forbidden fields never reach props, so they can never
 * enter HTML. The label rule reads supplied fields alone.
 */
export interface RowView {
  readonly id: string;
  /** Archive metadata from the authorized query owner. */
  readonly archivedAt?: number | null;
  readonly version?: string;
  readonly fields: Record<string, unknown>;
}

/** Column metadata supplied by the query runner from loaded appDefinition. */
export interface ColumnMeta {
  readonly field: string;
  readonly label: MessageValue;
  /** Canonical type id (lane 2 CanTypeId vocabulary). */
  readonly type: string;
  /** Bool/enum case captions keyed by stable value ("true"/case name). */
  readonly valueLabels?: Record<string, MessageValue>;
  /**
   * Sealed derived-bool expansion id (compiler-emitted, only on
   * `derived-bool` columns). Presentation and UI verify this exact
   * value before translating to a stored backing-field predicate.
   */
  readonly expansion?: string;
  /** Owning derive declaration source marker for the sealed expansion. */
  readonly source?: unknown;
}

/** Checked source column identity/type, never a field grant or rendering metadata. */
export type ColumnDeclaration = Pick<ColumnMeta, 'field' | 'type'>;

/**
 * Row-query arguments. Predicates are opaque generated code passed through
 * to the runner; UI never inspects them. Order/filter/search extend this
 * shape additively in the collections-controls slice.
 */
export interface ListQueryArgs {
  readonly archived?: 'exclude' | 'include';
  readonly parent?: { readonly id: string };
  readonly where?: unknown;
  /** Source-checked signed selectors; the authorized query owner applies ordering. */
  readonly order?: readonly string[];
  /** Source-checked searchable fields plus the accepted request query. */
  readonly search?: { readonly fields: readonly string[]; readonly query: string };
  /** Ask the authorized query owner for the matched total before pagination. */
  readonly includeCount?: true;
  /** Explicit finite page profile; omission retains ordinary read overflow refusal. */
  readonly page?: true;
  /** Stable collection identity for cursor binding; required by the page profile. */
  readonly occurrence?: string;
  /**
   * Requested page size, 1..100. UI rejects anything outside; the runner
   * defaults to 25 rows when absent and rejects overflow by design.
   */
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListQueryResult {
  readonly rows: readonly RowView[];
  readonly nextCursor?: string;
  /** Rendering metadata for fields actually present in authorized projected rows. */
  readonly columns: readonly ColumnMeta[];
  /**
   * Checked nonsecret/servable declarations supplied only for zero-row results.
   * List/table/board may validate authored names/group types, then render only their
   * empty state. Never authorizes a header, field value, enum group or export;
   * nonempty results must ignore it. Absence retains legacy validation behavior.
   */
  readonly emptyDeclarations?: readonly ColumnDeclaration[];
  /** Authorized where+search total before limit/cursor, when requested. */
  readonly totalCount?: number;
}

/**
 * Authorized row query: invocation is the opaque canonical context, model
 * the qualified model name. Enforces viewer grants, collection bounds
 * (default 25 rows, max 100, overflow rejected) and projection before
 * returning; UI renders exactly what it receives.
 */
export type RowQueryRunner = (
  invocation: unknown,
  model: string,
  args: ListQueryArgs,
) => Promise<ListQueryResult>;

/**
 * Authored source-expression selectors. Opaque predicates/parent/order stay
 * intact for the canonical owner to serve or explicitly refuse. `owner`
 * authority is retained for refusal; a page reader can grant only viewer access.
 */
export interface PageRecordsQuery {
  readonly parent?: unknown;
  readonly where?: unknown;
  readonly order?: unknown;
  readonly limit?: number;
  readonly archived?: 'exclude' | 'include';
  readonly authority?: 'owner' | 'viewer';
}

/**
 * Native source-expression records, bound to the admitted viewer and checked
 * source/physical owner by the scope producer. Only projected readable fields
 * may appear. This is not a paginated RowView query: no collection defaults,
 * cursors or implicit truncation apply. Unsupported selectors refuse instead
 * of being dropped. The same scope owns current authority/revision checks.
 */
export type PageRecordsReader = (
  model: string,
  query: PageRecordsQuery,
) => Promise<ReadonlyArray<Record<string, unknown>>>;

/** Readonly selected delivery observation; the implementing owner enforces current grants. */
export type PageDeliveryObserver = (
  locator: { readonly record: unknown; readonly field: string },
  selected: readonly ReceiptProperty[],
) => Promise<Readonly<Partial<Record<ReceiptProperty, unknown>>> | null>;

/** Native page result: the owning adapter converts the safe Work timestamp to Can int. */
export type PageGenerationCallbackDiagnosticResult =
  | (Omit<Extract<GenerationCallbackDiagnosticResult, { readonly outcome: "complete" }>, "failures"> & {
    readonly failures: readonly (Omit<GenerationCallbackFailure, "recordedAtMs"> & { readonly recordedAtMs: bigint })[];
  })
  | Extract<GenerationCallbackDiagnosticResult, { readonly outcome: "unsupported" }>;

/** Whole selected historical diagnostic observation; the owner enforces current grants. */
export type PageGenerationCallbackDiagnosticsObserver = (
  locator: { readonly record: unknown; readonly field: string },
) => Promise<PageGenerationCallbackDiagnosticResult | null>;

/** The owning reader rechecks this original projected row at the page checkpoint. */
export type PageHistoryReader = (
  locator: { readonly model: string; readonly record: RowView },
) => Promise<{
  readonly revision: Revision;
  readonly entries: readonly Omit<HistoryEntry, "auditProjection">[];
}>;

/** One request's authorized readers; this scope itself grants no authority. */
export interface PageReadScope {
  readonly query: RowQueryRunner;
  /** Host-only terminal cleanup, awaited once after the original request's
   * full/partial rendering or failure. Uses this scope as receiver; it is
   * never installed in renderer/source context. Close private File bindings
   * here so results completing after scope end cannot produce links. */
  readonly close?: () => void | Promise<void>;
  /**
   * Host-only association hook, called once before rendering with the exact
   * identity/limit-bound query installed by Interfaces and this scope as receiver.
   * May retain private ownership; returns no replacement reader or authority.
   */
  readonly onQueryBound?: (query: RowQueryRunner) => void | Promise<void>;
  readonly readRecords?: PageRecordsReader;
  readonly readHistory?: PageHistoryReader;
  readonly presentFile?: PageFilePresenter;
  readonly resolveFileImage?: PageFileImageResolver;
  readonly observeDelivery?: PageDeliveryObserver;
  readonly observeGenerationCallbackDiagnostics?: PageGenerationCallbackDiagnosticsObserver;
}

/**
 * One `text` value. Raw strings are verbatim text; raw numbers must be safe
 * integers (non-integers throw: decimals need {type,value}); bigint/bool are
 * exact; native user references display their stable ID and native datetimes
 * use the existing typed scalar formatter; descriptors render with bound params;
 * {type,value} pairs carry numerics/temporals with explicit types; null and
 * undefined render as empty.
 */
export type TextValue =
  | string
  | number
  | bigint
  | boolean
  | UserRef
  | DatetimeValue
  | MessageDescriptor
  | ResolvedMessage
  | MessageParamValue
  | null
  | undefined;

export interface CardProps {
  readonly context: PresentationContext;
  readonly title?: MessageValue;
  readonly layout?: "stack" | "columns";
  readonly children: PageChildren;
}

export interface TitleProps {
  readonly context: PresentationContext;
  readonly text: MessageValue;
  readonly level?: 1 | 2 | 3;
}

export interface TextProps {
  readonly context: PresentationContext;
  /** File arrays retain their original ordered occurrences, including duplicates. */
  readonly values: readonly (TextValue | FileValue | readonly FileValue[])[];
}

export interface ContentProps {
  readonly context: PresentationContext;
  readonly value: string | MessageDescriptor;
}

export interface SharedStateProps {
  readonly context: PresentationContext;
  /**
   * Rendered state. "no-match" is filtered-empty with a clear-filters
   * affordance; validation, conflict and pending outcomes arrive with forms.
   */
  readonly kind: "loading" | "empty" | "no-match" | "error";
  readonly message: MessageValue;
  readonly detail?: MessageValue;
}

export interface ListProps {
  readonly archived?: 'exclude' | 'include';
  readonly context: PresentationContext;
  readonly model: string;
  /** Ordered rendering selection from authorized column metadata and projected fields. */
  readonly columns?: readonly string[];
  readonly parent?: { readonly id: string };
  readonly where?: unknown;
  /** Checked owning enum/bool/reference filter declarations, not granted row metadata. */
  readonly filter?: readonly ColumnMeta[];
  /** Initial selections only; explicit request selection or clear wins. */
  readonly defaults?: Readonly<Record<string, CollectionFilterDefault>>;
  readonly order?: readonly string[];
  readonly search?: readonly string[];
  /** One source-owned list summary, outside renderRow. */
  readonly count?: { readonly label: MessageValue };
  readonly limit?: number;
  readonly cursor?: string;
  /** Explicit finite page read, independent of presentation layout. */
  readonly page?: true;
  readonly display?: "split";
  /** Stable source collection occurrence; required when display is split. */
  readonly occurrence?: string;
  /** Omission uses the standard shared collection empty message. */
  readonly empty?: MessageValue;
  readonly renderRow: (row: RowView, view: PresentationContext) => PageChildren | Promise<PageChildren>;
  /** Search/filter/order/pagination/export toolbar; absent renders rows only. */
  readonly controls?: CollectionControls;
}

/**
 * Image collection over the same authorized query and original row scopes as
 * list. The checked image selector names one readable owning File field.
 * The admitted scope supplies protected PNG/JPEG URLs; URL possession conveys
 * no authority and every preview/original open performs a fresh current check.
 */
export interface GalleryProps extends Omit<ListProps, "columns" | "display" | "renderRow"> {
  readonly image: string;
  /** Stable checked source occurrence for this collection's preview dialog. */
  readonly occurrence: string;
  readonly filter?: readonly ColumnMeta[];
  readonly defaults?: Readonly<Record<string, CollectionFilterDefault>>;
  readonly renderRow?: ListProps["renderRow"];
}

export interface TableProps {
  readonly archived?: 'exclude' | 'include';
  readonly context: PresentationContext;
  readonly model: string;
  readonly parent?: { readonly id: string };
  readonly where?: unknown;
  readonly search?: readonly string[];
  /** Checked owning enum/bool/reference filter declarations, not granted row metadata. */
  readonly filter?: readonly ColumnMeta[];
  /** Initial selections only; explicit request selection or clear wins. */
  readonly defaults?: Readonly<Record<string, CollectionFilterDefault>>;
  readonly order?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
  /** Explicit finite page read, independent of presentation layout. */
  readonly page?: true;
  readonly display?: "split";
  /** Stable source collection occurrence; required when display is split. */
  readonly occurrence?: string;
  readonly columns: readonly string[];
  /** Omission uses the standard shared collection empty message. */
  readonly empty?: MessageValue;
  /** Split detail body receives only the freshly queried authorized row and current view. */
  readonly renderRow?: (row: RowView, view: PresentationContext) => PageChildren | Promise<PageChildren>;
  /** Search/filter/order/pagination/export toolbar; absent renders rows only. */
  readonly controls?: CollectionControls;
}

/**
 * One component catalog entry, mirroring the L1/L2 catalog envelope shape
 * for presentation capabilities (unification with the shared envelope is a
 * later L1/L7 join; L1 acknowledgment pending).
 */
/**
 * Binding profile of a catalog word, per docs/design/UI-COMPONENTS.md grammar
 * profiles. "shell" marks non-word infrastructure (renderPage, discovery)
 * that lane 1 ignores for word checking.
 */
export type ComponentProfile =
  | "leaf"
  | "group"
  | "slotted-group"
  | "collection"
  | "field-control"
  | "bound-control"
  | "shared-control"
  | "shell";

/** Header-expression payload a catalog word accepts. */
export type ComponentHeaderExpr =
  | "none"
  | "value"
  | "text"
  | "numeric"
  | "bool"
  | "image"
  | "query"
  | "sequence"
  | "selector"
  | "binding";

/** One named slot in a slotted-group schema. */
export interface ComponentSlotDef {
  readonly name: string;
  readonly required: boolean;
  /** True only where the catalog explicitly permits repetition. */
  readonly repeatable: boolean;
}

/** Finite semantic appearance tokens (docs/design/UI-COMPONENTS.md). */
export type AppearanceTone = "neutral" | "primary" | "secondary" | "accent" | "info" | "success" | "warning" | "error";
export type AppearanceSize = "xs" | "sm" | "md" | "lg" | "xl";
export type AppearanceVariant = "solid" | "outline" | "soft" | "ghost";
export type AppearanceOrientation = "horizontal" | "vertical";

/**
 * Per-component admitted appearance subset. Every admitted token must map to
 * a class present in the pinned daisyUI CSS (substantiated by test, never
 * guessed); absent dimensions admit nothing. `caption` admits `caption=expr`.
 */
export interface ComponentAppearance {
  readonly tone?: ReadonlyArray<AppearanceTone>;
  readonly size?: ReadonlyArray<AppearanceSize>;
  readonly variant?: ReadonlyArray<AppearanceVariant>;
  readonly orientation?: ReadonlyArray<AppearanceOrientation>;
  readonly caption?: boolean;
}

export interface ComponentCatalogEntry {
  /** Can word, e.g. "card", "table", "chat_bubble". */
  readonly id: string;
  /** JS factory name as exported from @canlang/ui. */
  readonly js: string;
  readonly owner: "lane-05";
  readonly kind: "component";
  /** Props shape as stated in this contract. */
  readonly signature: string;
  readonly availability: "planned" | "implemented";
  readonly profile: ComponentProfile;
  readonly header: ComponentHeaderExpr;
  /**
   * Closed structural/binding attribute names admitted by this word
   * (pages=, id=, max=, target=, action=/submit=/target=/opens=, caption=,
   * fallback=, start=/end=, display=, columns=, ...). Appearance tokens
   * arrive in C2b; arbitrary option bags are never admitted.
   */
  readonly attributes?: ReadonlyArray<string>;
  /**
   * Named-slot schema for slotted groups; absent means no slots. Regular
   * suites and slot suites never mix (direct slot children require a schema).
   */
  readonly slots?: ReadonlyArray<ComponentSlotDef>;
  /**
   * Alternate accepted profiles for words the design gives two shapes
   * (hero/footer compact grouping vs slots, navbar bare leaf vs slots).
   * Primary profile stays in `profile`; alternates never add slots.
   */
  readonly alternates?: ReadonlyArray<ComponentProfile>;
  /** Admitted appearance subset; absent admits nothing. */
  readonly appearance?: ComponentAppearance;
  readonly notes?: string;
}

export interface ComponentCatalog {
  readonly catalog_version: string;
  readonly language_version: string | null;
  readonly entries: ReadonlyArray<ComponentCatalogEntry>;
}

/**
 * One form field. `path` is the top-level input key (validated identifier);
 * the form mode roots it under `inputs` (create/scenario) or
 * `inputs[changes]` (update). `value` carries the draft (or current) value;
 * generated code merges drafts over current values before rendering.
 */
export interface FormFieldDef {
  readonly path: string;
  readonly label: MessageValue;
  /** Canonical type id (lane 2 CanTypeId vocabulary). */
  readonly type: string;
  readonly required: boolean;
  readonly multiline?: boolean;
  readonly readonly?: boolean;
  readonly value?: unknown;
  /** Caller-supplied opaque options for enum/reference selects. */
  readonly options?: ReadonlyArray<FormFieldOption>;
  /** Inclusive numeric bounds from the source schema (range/slider display). */
  readonly min?: number;
  readonly max?: number;
  /**
   * Explicit control selection (C4): which factory renders this field.
   * Absent selects the default factory from `type` (established S4 rules).
   * Unsuitable selections throw; duplicate paths across fields throw.
   */
  readonly control?: FieldControlKind;
  /** Explicit label caption override (the `label path [caption]` spelling). */
  readonly labelCaption?: MessageValue;
}

/** Explicit selectable widget for a writable field (C4). */
export type FieldControlKind =
  | "input"
  | "textarea"
  | "checkbox"
  | "toggle"
  | "radio"
  | "select"
  | "range"
  | "rating"
  | "file_input"
  | "otp"
  | "filter"
  | "calendar";

/** Shared inputs for every field-control factory (C4). */
export interface FieldControlProps {
  readonly context: PresentationContext;
  readonly field: FormFieldDef;
  /** Caller-unique id prefix; shared with the owning form for id stability. */
  readonly idPrefix: string;
  readonly mode: FormMode;
  /** All outcome errors; the factory filters to its field, like renderField. */
  readonly errors?: ReadonlyArray<FieldError>;
  /** IANA zone for temporal display; defaults to UTC when absent. */
  readonly timeZone?: string;
  /** The owning prepared form places this label/validator separately. */
  readonly authoredLabel?: boolean;
  readonly authoredValidator?: boolean;
}

/** `label path [caption]`: this field's label element only (moves, never duplicates). */
export interface LabelProps {
  readonly context: PresentationContext;
  readonly field: FormFieldDef;
  readonly idPrefix: string;
  readonly caption?: MessageValue;
}

/** `validator path`: this field's error outlet only (moves, never duplicates). */
export interface ValidatorProps {
  readonly context: PresentationContext;
  readonly field: FormFieldDef;
  readonly idPrefix: string;
  readonly mode: FormMode;
  readonly errors?: ReadonlyArray<FieldError>;
}

/** Appearance-bearing control props (each mirrors its admitted catalog matrix). */
export interface InputProps extends FieldControlProps {
  readonly tone?: AppearanceTone;
  readonly size?: AppearanceSize;
  readonly variant?: AppearanceVariant;
}
export interface TextareaProps extends FieldControlProps {
  readonly tone?: AppearanceTone;
  readonly size?: AppearanceSize;
  readonly variant?: AppearanceVariant;
}
export interface CheckboxProps extends FieldControlProps {
  readonly tone?: AppearanceTone;
  readonly size?: AppearanceSize;
}
export interface ToggleProps extends FieldControlProps {
  readonly tone?: AppearanceTone;
  readonly size?: AppearanceSize;
}
export interface RadioProps extends FieldControlProps {
  readonly tone?: AppearanceTone;
  readonly size?: AppearanceSize;
}
export interface SelectProps extends FieldControlProps {
  readonly tone?: AppearanceTone;
  readonly size?: AppearanceSize;
  readonly variant?: AppearanceVariant;
}
export interface RangeProps extends FieldControlProps {
  readonly tone?: AppearanceTone;
  readonly size?: AppearanceSize;
  readonly orientation?: AppearanceOrientation;
}
export interface RatingProps extends FieldControlProps {
  readonly size?: AppearanceSize;
}
export interface FileInputProps extends FieldControlProps {
  readonly tone?: AppearanceTone;
  readonly size?: AppearanceSize;
  readonly variant?: AppearanceVariant;
}
export interface OtpProps extends FieldControlProps {
  readonly tone?: AppearanceTone;
  readonly size?: AppearanceSize;
}

/**
 * `filter` field-owner production: finite-choice input with Filter
 * presentation. The saved-preference production below uses its owning binding.
 */
export interface FilterFieldProps extends FieldControlProps {}

/** One owned-preference option doubling as a filter value. */
export interface FilterPreferenceOption {
  readonly value: string;
  readonly label: MessageValue;
}

/**
 * Owned saved-preference binding: the standalone page-body filter doubles
 * as its selector. Radios carry the preference field name and POST
 * name=<value> plus CSRF and the compare-and-set version to the caller
 * path — the same save shape the bound tabset selector uses.
 */
export interface FilterPreferenceBinding {
  /** Preference field name carried by the radios. */
  readonly name: string;
  readonly options: readonly FilterPreferenceOption[];
  /**
   * Saved selection. Decoded bool reads arrive as real booleans while
   * option values stay the canonical "true"/"false" spellings; the
   * control compares strictly so an explicit false stays selected.
   * POST/store remain the existing string-valued contract.
   */
  readonly current?: string | boolean | bigint | null;
  /** Checked inline preference control; omission retains finite-choice radios. */
  readonly editor?: 'bool' | 'text' | 'int';
  readonly nullable?: boolean;
  /** Saved snapshot version; sent with the save for compare-and-set. */
  readonly version?: string;
  /** Caller-owned persistence path; the form POSTs name=<value> + CSRF. */
  readonly postTo: string;
}

/**
 * Standalone saved-preference filter: Filter presentation over the owned
 * preference binding above, rendered in authored page-body position. The
 * sibling collection keeps its own occurrence controls and serving.
 */
export interface FilterPreferenceProps {
  readonly context: PresentationContext;
  readonly binding: FilterPreferenceBinding;
  readonly caption?: MessageValue;
}

/**
 * `filter` factory props: either the field-owner production or the
 * standalone saved-preference binding, never both.
 */
export type FilterProps = FilterFieldProps | FilterPreferenceProps;

/**
 * `calendar` agenda production: date-grouped authorized collection query
 * with an optional authored row body. Field production reuses control props.
 */
export interface CalendarAgendaProps {
  readonly context: PresentationContext;
  readonly model: string;
  /** Enclosing row scope for a contained agenda; the query owner binds its id. */
  readonly parent?: { readonly id: string };
  readonly startField: string;
  readonly endField: string;
  /** Owned row fields rendered beside each endpoint line; validated against authorized metadata. */
  readonly columns?: readonly string[];
  readonly where?: unknown;
  /** Checked owning enum/bool/reference filter declarations, not granted row metadata. */
  readonly filter?: readonly ColumnMeta[];
  /** Initial selections only; explicit request selection or clear wins. */
  readonly defaults?: Readonly<Record<string, CollectionFilterDefault>>;
  readonly order?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
  /** Existing finite page read; the query owner binds its cursor to occurrence. */
  readonly page?: true;
  readonly occurrence?: string;
  readonly empty?: MessageValue;
  /** IANA zone for day grouping/display; defaults to UTC when absent. */
  readonly timeZone?: string;
  /** Receives only the current authorized row and the dispatcher-owned view. */
  readonly renderRow?: (row: RowView, view: PresentationContext) => PageChildren | Promise<PageChildren>;
}
export interface CalendarFieldProps extends FieldControlProps {}
export type CalendarProps =
  | (CalendarAgendaProps & { readonly kind: "agenda" })
  | (CalendarFieldProps & { readonly kind: "field" });

export interface FormFieldOption {
  /** Opaque value (enum case name or reference); never a grant. */
  readonly value: string;
  readonly label: MessageValue;
}

export type FormMode = "create" | "update" | "scenario";

export interface DeliveryReceiptView {
  readonly id: string;
  readonly status: DeliveryStatus;
}

/**
 * Mutation outcome for form re-render. Pending/conflict/failed/unknown come
 * from the invocation result; drafts stay in field values and are never
 * overwritten by current values.
 */
export type FormOutcome =
  | { readonly status: "pending"; readonly deliveries: ReadonlyArray<DeliveryReceiptView> }
  | {
      readonly status: "conflict";
      /** Current authorized values keyed by field path. */
      readonly current: Record<string, unknown>;
      readonly message: MessageValue;
    }
  | { readonly status: "failed"; readonly error: BusinessError }
  | { readonly status: "unknown"; readonly operationId: string; readonly message: MessageValue };

export interface FormProps {
  readonly context: PresentationContext;
  /** Dispatcher-supplied POST target; lane 05 never invents URLs. */
  readonly action: string;
  readonly operation: string;
  /** Fresh idempotency key rendered per form (replay-safe resubmits). */
  readonly operationId: string;
  readonly mode: FormMode;
  /** Checked operation inputs consumed by the existing browser submit projection. */
  readonly derived?: DerivedOperationInputs;
  /** Server-sealed fixed arguments and editable fields for this occurrence. */
  readonly sourceBinding?: string;
  /** Stable occurrence comparison only; never authorization or a proof. */
  readonly sourceBindingIdentity?: string;
  /** Same logical binding across version refreshes; draft comparison only. */
  readonly sourceBindingDraftIdentity?: string;
  /** Bound record for updates (hidden id/version); required in update mode. */
  readonly record?: MutationRef;
  /** Resolved rendering timezone (team adapter or explicit UTC fallback). */
  readonly timeZone: string;
  readonly fields: ReadonlyArray<FormFieldDef>;
  /** Existing authored placements; other prepared fields render afterward. */
  readonly authoredFields?: readonly string[];
  /** Separate fragment placements; corresponding default fragments move here. */
  readonly authoredLabels?: readonly string[];
  readonly authoredValidators?: readonly string[];
  /** Authored body; fields describe its rendered controls for error matching. */
  readonly children?: PageChildren;
  /** Omitted keeps the low-level inline contract; source forms select explicitly. */
  readonly display?: "inline" | "drawer" | "menu";
  /** Field errors keyed by JSON Pointer into inputs (wire FieldError). */
  readonly errors?: ReadonlyArray<FieldError>;
  readonly outcome?: FormOutcome;
  readonly submit: MessageValue;
  /** Explicit source action caption for its visible canonical opener. */
  readonly controlLabel?: MessageValue;
  /** Compiler checked explicit submit control already rendered in this form. */
  readonly authoredSubmit?: boolean;
  readonly cancelHref?: string;
  /** Caller-unique prefix for input ids (deterministic for swaps/tests). */
  readonly idPrefix: string;
}

/** Checked source form props, evaluated once before its child controls. */
export interface OperationFormRequest {
  readonly operation: string;
  /** Stable source presentation occurrence; comparison identity only, never submission authority. */
  readonly occurrence?: string;
  readonly fields?: readonly string[];
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly submit?: MessageValue;
  readonly controlLabel?: MessageValue;
  readonly authoredSubmit?: boolean;
  /** Captions generated from owning source declarations, not a second schema. */
  readonly labels?: Record<string, MessageValue>;
  readonly display?: "inline" | "drawer" | "menu";
  /** Actual authored writable controls; absent selects the automatic body. */
  readonly authoredFields?: readonly string[];
  /** Checked standalone fragment placements, independent of writable controls. */
  readonly authoredLabels?: readonly string[];
  readonly authoredValidators?: readonly string[];
}

export type PreparedOperationForm =
  | {
      readonly status: "ready";
      readonly props: FormProps;
      /** Exact original operation schema for the existing submit projection. */
      readonly derived: DerivedOperationInputs;
      /** Resolves only against this form's selected checked fields. */
      readonly field: (path: string) => FieldControlProps;
    }
  | {
      readonly status: "unavailable";
      readonly message: MessageValue;
    };

export type OperationFormPreparer = (request: OperationFormRequest) => PreparedOperationForm | Promise<PreparedOperationForm>;

export interface EditProps extends Omit<FormProps, "mode" | "record"> {
  readonly record: MutationRef;
}

export interface DeleteProps {
  readonly controlLabel?: MessageValue;
  /** Compact opener with the canonical confirmation form in a native dialog. */
  readonly display?: "inline" | "menu";
  readonly context: PresentationContext;
  readonly action: string;
  readonly operation: string;
  readonly operationId: string;
  readonly record: MutationRef;
  readonly mode: "archive" | "remove";
  readonly itemLabel: MessageValue;
  readonly confirm: MessageValue;
  readonly cancelHref?: string;
  readonly idPrefix: string;
  /** IANA zone for datetime display; always declared on the wire (UTC default). */
  readonly timeZone?: string;
}

/** Checked metadata opts into the existing browser submitter; omission retains native POST. */
export interface ActionProps extends Pick<FormProps,
  "derived" | "sourceBinding" | "sourceBindingIdentity" | "sourceBindingDraftIdentity"> {
  readonly display?: "inline" | "drawer" | "menu";
  readonly context: PresentationContext;
  readonly action: string;
  readonly operation: string;
  readonly operationId: string;
  readonly label: MessageValue;
  /** Bound record for record actions (hidden id/version). */
  readonly record?: MutationRef;
  /** Legacy native POST only; prepared browser actions refuse MCP-only sealed handles. */
  readonly actionHandle?: SealedActionHandle;
  /** Pre-bound non-record scalar inputs (hidden fields). */
  readonly inputs?: Record<string, string | number | bigint | boolean>;
  /** Ordinary inputs render a mini form; absent renders a single button. */
  readonly fields?: ReadonlyArray<FormFieldDef>;
  readonly timeZone?: string;
  readonly errors?: ReadonlyArray<FieldError>;
  readonly confirm?: MessageValue;
  readonly variant?: "primary" | "danger" | "ghost";
  readonly idPrefix: string;
}

export interface ActionsProps {
  readonly context: PresentationContext;
  readonly actions: ReadonlyArray<Omit<ActionProps, "context">>;
}

// ---------------------------------------------------------------------------
// S5: collection controls (DESIGN §9 query-state toolbar)
// ---------------------------------------------------------------------------

/** Closed generated filter-operator matrix; unknown operators fail closed. */
export type FilterOperator =
  | "eq"
  | "ne"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "between"
  | "is_null"
  | "not_null";

/** One active typed filter condition; `between` uses value+upper, null modes none. */
export interface FilterCondition {
  readonly field: string;
  readonly op: FilterOperator;
  readonly value?: unknown;
  readonly upper?: unknown;
  /**
   * Sealed derived-bool marker (presentation-built only, after exact
   * inventory/marker validation). The query adapter maps exactly
   * this marker to the guarded State expansion; the marker is never
   * request-supplied and any mismatch refuses.
   */
  readonly derivedBool?: { readonly expansion: 'unassigned' | 'overdue' };
}

/** Literal search over declared readable fields (accepted state, not a predicate). */
export interface CollectionSearch {
  readonly query: string;
}

/** One concrete order selector; preference-dispatch resolves server-side. */
export interface OrderSelector {
  readonly field: string;
  readonly direction: "asc" | "desc";
}

/** Opaque query-bound cursor pagination state. */
export interface CollectionPagination {
  readonly nextCursor?: string;
  readonly prevCursor?: string;
}

/**
 * Accepted collection control state rendered as toolbar + pagination chrome.
 * All request targets are dispatcher-supplied; lane 05 serializes only the
 * closed accepted shapes above into query strings, never client predicates.
 */
export interface CollectionControls {
  readonly context: PresentationContext;
  /** Stable automatic-region id wrapping rows + toolbar (opaque, validated shape). */
  readonly regionId: string;
  /** Dispatcher-supplied GET target for control/pagination requests. */
  readonly baseHref: string;
  readonly search?: CollectionSearch;
  readonly filters?: ReadonlyArray<FilterCondition>;
  readonly order?: ReadonlyArray<OrderSelector>;
  readonly pagination?: CollectionPagination;
  /** Dispatcher-supplied shared export/print targets; absent omits the control. */
  readonly exportHref?: string;
  readonly printHref?: string;
  /** Region aria-label; defaults to the collection model name. */
  readonly label?: MessageValue;
}

// ---------------------------------------------------------------------------
// S5: HTMX fragments, swap config, poll/refresh (DESIGN §9)
// ---------------------------------------------------------------------------

/**
 * Lane-05 swap vocabulary mapped to HTMX 4 strategies. "morph" is the
 * default (outerMorph on regions); "replace" is explicit-reset only;
 * "append"/"prepend" serve infinite-scroll/load-more; "none" skips the swap.
 */
export type SwapStrategy = "morph" | "replace" | "append" | "prepend" | "none";

/** Per-status swap override emitted as `hx-status:` attributes. */
export interface StatusSwap {
  /** Status selector: exact code ("422") or class wildcard ("5xx"). */
  readonly status: string;
  readonly target: string;
  readonly swap: SwapStrategy;
  readonly select?: string;
}

/**
 * Declarative HTMX request description rendered as hx-* attributes.
 * URLs always come from the dispatcher; lane 05 never invents routes.
 */
export interface HtmxRequest {
  readonly method: "get" | "post";
  readonly href: string;
  readonly target: string;
  readonly swap?: SwapStrategy;
  readonly trigger?: string;
  readonly indicator?: string;
  /**
   * Extra values to submit, emitted as hx-include. Required for GET controls
   * (search/order): GET never carries element values without it.
   */
  readonly include?: string;
  readonly statusSwaps?: ReadonlyArray<StatusSwap>;
  readonly pushUrl?: boolean;
}

/** Automatic read-region wrapper: stable id + morph default + stale marking slot. */
export interface FragmentRegionProps {
  readonly context: PresentationContext;
  readonly regionId: string;
  readonly content: PageChildren;
  readonly label: MessageValue;
}

/**
 * Poll declaration: authorized GET reread of one region at a fixed cadence.
 * Interval is seconds, 1..3600 per DESIGN poll bounds; omission means no poll.
 */
export interface PollProps {
  readonly context: PresentationContext;
  readonly regionId: string;
  readonly href: string;
  readonly intervalSeconds: number;
}

/** Failed/stale read marker left on a region after correctable reread failure. */
export interface StaleMarkerProps {
  readonly context: PresentationContext;
  readonly regionId: string;
  readonly message: MessageValue;
}

// ---------------------------------------------------------------------------
// C3: readable leaves (appearance props mirror the admitted catalog matrix;
// dimensions the matrix omits have no prop and no accepted attribute)
// ---------------------------------------------------------------------------

/** `badge` readable typed value with its owning caption. */
export interface BadgeProps {
  readonly context: PresentationContext;
  readonly value: TextValue;
  readonly caption?: MessageValue;
  readonly tone?: AppearanceTone;
  readonly size?: AppearanceSize;
  readonly variant?: AppearanceVariant;
}

/** `status` explicit readable state; the value is its text alternative. */
export interface StatusProps {
  readonly context: PresentationContext;
  readonly value: TextValue;
  readonly caption?: MessageValue;
  readonly tone?: AppearanceTone;
  readonly size?: AppearanceSize;
}

/** `kbd` shortcut notation; registers no keyboard handler. */
export interface KbdProps {
  readonly context: PresentationContext;
  readonly keys: ReadonlyArray<string>;
  readonly size?: AppearanceSize;
}

/** `mockup_code` escaped text; never executed. */
export interface MockupCodeProps {
  readonly context: PresentationContext;
  readonly code: string;
}

/** `countdown` bounded view-only numeric/duration display; schedules nothing. */
export interface CountdownProps {
  readonly context: PresentationContext;
  readonly value: number;
  readonly caption?: MessageValue;
}

/** `divider` separation with an optional authored caption. */
export interface DividerProps {
  readonly context: PresentationContext;
  readonly caption?: MessageValue;
  readonly tone?: AppearanceTone;
  readonly orientation?: AppearanceOrientation;
}

/** `link` checked destination or authorized file URL. */
export interface LinkProps {
  readonly context: PresentationContext;
  readonly target: string | FileValue | null;
  readonly caption?: MessageValue;
  readonly tone?: AppearanceTone;
  /**
   * Static destination kind: true when the checked target is a nullable
   * URL. An absent URL then renders the shared unavailable label, while a
   * null/withheld File keeps its existing File caption default. Present
   * destinations ignore this marker.
   */
  readonly absentUrl?: boolean;
}

/**
 * `avatar` authorized image or explicit safe fallback. `image` null/absent
 * renders `fallback` (explicit safe text such as initials) or the shared
 * unavailable-image placeholder; never an inferred user directory.
 */
export interface AvatarProps {
  readonly context: PresentationContext;
  readonly image?: string | null;
  readonly caption?: MessageValue;
  readonly fallback?: MessageValue;
}

/**
 * `progress`/`radial_progress` readable numerics with a finite positive max.
 * Out-of-range/NaN values render explicit invalid presentation, never a
 * clamped bar; compatible units are checked by the caller (L1).
 */
export interface ProgressProps {
  readonly context: PresentationContext;
  readonly value: number;
  readonly max: number;
  readonly caption?: MessageValue;
  readonly tone?: AppearanceTone;
}

export interface RadialProgressProps {
  readonly context: PresentationContext;
  readonly value: number;
  readonly max: number;
  readonly caption?: MessageValue;
}

/**
 * `text_rotate` authored readable sequence (1..6 items per pinned upstream
 * limits). Sequence/query operands evaluate to admitted items in the
 * dispatcher; the factory takes resolved items only.
 */
export interface TextRotateProps {
  readonly context: PresentationContext;
  readonly items: ReadonlyArray<MessageValue>;
}

// ---------------------------------------------------------------------------
// C5 container groups (groups.ts): accordion, collapse, fieldset, join, stack,
// hero, footer, stat, steps, timeline, carousel, diff.
// ---------------------------------------------------------------------------

/** One `accordion` disclosure item: required caption, content suite, single-open flag. */
export interface AccordionItem {
  readonly caption: MessageValue;
  readonly children: PageChildren;
  readonly open?: boolean;
}

/**
 * `accordion` single-open disclosure group (pinned upstream radio-input pattern).
 * The optional caption names the radio group for assistive technology
 * (role=group/aria-label); authors should supply it.
 */
export interface AccordionProps {
  readonly context: PresentationContext;
  readonly items: ReadonlyArray<AccordionItem>;
  readonly caption?: MessageValue;
  readonly id?: string;
}

/** `collapse` native details/summary disclosure with a required caption. */
export interface CollapseProps {
  readonly context: PresentationContext;
  readonly caption: MessageValue;
  readonly children: PageChildren;
  readonly open?: boolean;
  readonly id?: string;
}

/** Original source `details display=drawer`, after current record admission.
 * The callback retains enclosing row/parent aliases and runs only for this
 * activated occurrence/record. Selection itself grants no read authority. */
export interface DetailsDrawerProps {
  readonly context: PresentationContext;
  readonly caption: MessageValue;
  readonly occurrence: string;
  readonly record: RowView;
  readonly renderBody: (record: RowView, context: PresentationContext) => PageChildren | Promise<PageChildren>;
  /** `open=` is admitted only by Collapse details. */
  readonly open?: never;
}

/** `fieldset` native group for existing form fields; legend only when captioned. */
export interface FieldsetProps {
  readonly context: PresentationContext;
  readonly caption?: MessageValue;
  readonly children: PageChildren;
  readonly id?: string;
}

/** `join` visual grouping of existing controls (container only; children own join-item). */
export interface JoinProps {
  readonly context: PresentationContext;
  readonly children: PageChildren;
  readonly orientation?: AppearanceOrientation;
  readonly id?: string;
}

/** `stack` visual stacking of scoped content. */
export interface StackProps {
  readonly context: PresentationContext;
  readonly children: PageChildren;
  readonly id?: string;
}

/** Closed start/content/end slot schema shared by `hero` and `footer`. */
export interface HeroSlots {
  readonly content: PageChild;
  readonly start?: PageChild;
  readonly end?: PageChild;
}

/**
 * `hero` prominent group: either children or slots, never both and never neither.
 * The caption renders as the page h1; pages should carry a single hero.
 */
export interface HeroProps {
  readonly context: PresentationContext;
  readonly caption?: MessageValue;
  readonly children?: PageChildren;
  readonly slots?: HeroSlots;
  readonly id?: string;
}

/** Closed start/content/end slot schema for `footer`. */
export interface FooterSlots {
  readonly content: PageChild;
  readonly start?: PageChild;
  readonly end?: PageChild;
}

/** `footer` page footer group: either children or slots, never both and never neither. */
export interface FooterProps {
  readonly context: PresentationContext;
  readonly caption?: MessageValue;
  readonly children?: PageChildren;
  readonly slots?: FooterSlots;
  readonly orientation?: AppearanceOrientation;
  readonly id?: string;
}

/** `stat` typed metric: required value plus optional title/description/icon slots. */
export interface StatProps {
  readonly context: PresentationContext;
  readonly value: TextValue;
  readonly title?: MessageValue;
  readonly description?: MessageValue;
  readonly icon?: PageChild;
  readonly orientation?: AppearanceOrientation;
  readonly id?: string;
}

/** One `steps` stage: label plus item-only tone and optional marker. */
export interface StepItem {
  readonly label: TextValue;
  readonly tone?: AppearanceTone;
  readonly marker?: string;
}

/** `steps` ordered process stages as a semantic list. */
export interface StepsProps {
  readonly context: PresentationContext;
  readonly items: ReadonlyArray<StepItem>;
  readonly orientation?: AppearanceOrientation;
  readonly id?: string;
}

/** One `timeline` entry: at least a start or an end, optional middle. */
export interface TimelineItem {
  readonly start?: PageChild;
  readonly middle?: PageChild;
  readonly end?: PageChild;
}

/**
 * `timeline` ordered entries as a semantic list.
 *
 * Two modes share one renderer. Explicit mode passes `items` (one authored
 * `slot item` suite per entry). Collection mode passes `model` with
 * `renderRow` (one `slot item` template rendered once per admitted query
 * row, per docs/design/UI-COMPONENTS.md): the factory queries authorized rows
 * through the dispatcher, maps each row body to an entry, and renders the
 * shared items path. `items` and `model` must not be combined.
 */
export interface TimelineProps {
  readonly context: PresentationContext;
  readonly items?: ReadonlyArray<TimelineItem>;
  readonly model?: string;
  readonly parent?: { readonly id: string };
  readonly where?: unknown;
  readonly order?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
  /** Explicit finite page read, independent of presentation layout. */
  readonly page?: true;
  /** Stable source collection occurrence; required for page cursor binding. */
  readonly occurrence?: string;
  /** Omission uses the standard shared collection empty message. */
  readonly empty?: MessageValue;
  /** Receives only the current authorized row and the dispatcher-owned view. */
  readonly renderRow?: (row: RowView, view: PresentationContext) => PageChildren | Promise<PageChildren>;
  readonly orientation?: AppearanceOrientation;
  readonly id?: string;
}

/** `carousel` ordered readable content with explicit item slots. */
export interface CarouselProps {
  readonly context: PresentationContext;
  readonly items: ReadonlyArray<PageChild>;
  readonly orientation?: AppearanceOrientation;
  readonly id?: string;
}

/** `diff` two-slot before/after presentation (no automatic business comparison). */
export interface DiffProps {
  readonly context: PresentationContext;
  readonly before: PageChild;
  readonly after: PageChild;
  readonly id?: string;
}

// ---------------------------------------------------------------------------
// C5 floating/feedback/effect overlays (overlays.ts): alert, toast, tooltip,
// indicator, chat_bubble, dropdown, modal, drawer, swap, fab, aura, mask,
// hover_3d, hover_gallery.
// ---------------------------------------------------------------------------

/** `alert` readable notice or operation feedback: value leaf or content suite. */
export interface AlertProps {
  readonly context: PresentationContext;
  readonly value?: TextValue;
  readonly children?: PageChildren;
  readonly tone?: AppearanceTone;
  readonly variant?: AppearanceVariant;
  readonly orientation?: AppearanceOrientation;
  readonly regionId?: string;
}

/** `toast` notice placement: container plus one message leaf or suite. */
export interface ToastProps {
  readonly context: PresentationContext;
  readonly message?: TextValue;
  readonly children?: PageChildren;
  readonly regionId?: string;
}

/** `tooltip` annotation: required caption plus the annotated content. */
export interface TooltipProps {
  readonly context: PresentationContext;
  readonly caption: MessageValue;
  readonly content: PageChildren;
  readonly tone?: AppearanceTone;
}

/** `indicator` explicit content plus indicator slots. */
export interface IndicatorProps {
  readonly context: PresentationContext;
  readonly content: PageChildren;
  readonly indicator: PageChildren;
}

/** `chat_bubble` message with start/end alignment and optional slots. */
export interface ChatBubbleProps {
  readonly context: PresentationContext;
  readonly side?: "start" | "end";
  readonly content: PageChildren;
  readonly avatar?: PageChildren;
  readonly header?: PageChildren;
  readonly footer?: PageChildren;
  readonly tone?: AppearanceTone;
}

/** Visible controls placed by an explicit page/card/row/panel/form owner. */
export interface PrimaryActionsProps {
  readonly context: PresentationContext;
  readonly children: PageChildren;
}

/** Compact controls placed in one explicit owner's shared overflow region. */
export interface ActionMenuProps {
  readonly context: PresentationContext;
  readonly id: string;
  readonly children: PageChildren;
}

/** `dropdown` explicit trigger and content slots with focus behavior. */
export interface DropdownProps {
  readonly context: PresentationContext;
  readonly trigger: PageChildren;
  readonly content: PageChildren;
}

/** `modal` activated dialog: required caption/content, optional id/slots. */
export interface ModalProps {
  /** Compiler-derived checked external opener; suppresses only the default trigger. */
  readonly externalTrigger?: boolean;
  readonly context: PresentationContext;
  readonly caption: MessageValue;
  readonly id?: string;
  readonly content: PageChildren;
  /** Custom opener; must be an `a[href="#id"]` link — a bare button is inert without JS. */
  readonly trigger?: PageChildren;
  /** Semantic action owner: primary footer controls and secondary heading overflow. */
  readonly actions?: PageChildren;
  readonly variant?: AppearanceVariant;
}

/** `drawer` activated side panel: required caption, id and content. */
export interface DrawerProps {
  /** Compiler-derived checked external opener; suppresses only the default trigger. */
  readonly externalTrigger?: boolean;
  readonly context: PresentationContext;
  readonly caption: MessageValue;
  readonly id: string;
  readonly content: PageChildren;
  /** Custom opener; must be a `label[for="id"]` — a bare button cannot toggle without JS. */
  readonly trigger?: PageChildren;
  /** Semantic action owner: primary footer controls and secondary heading overflow. */
  readonly actions?: PageChildren;
  readonly variant?: AppearanceVariant;
}

/** `swap` two presentation slots selected by explicit or transient state. */
export interface SwapProps {
  readonly context: PresentationContext;
  readonly on: PageChildren;
  readonly off: PageChildren;
  readonly active?: boolean;
  readonly label?: MessageValue;
}

/** `fab` main trigger plus a nonempty suite of canonical action controls. */
export interface FabProps {
  readonly context: PresentationContext;
  readonly label?: MessageValue;
  readonly main: PageChildren;
  readonly actions: PageChildren;
}

/** `aura` decoration around existing content. */
export interface AuraProps {
  readonly context: PresentationContext;
  readonly content: PageChildren;
  readonly size?: AppearanceSize;
}

/** `mask` visual shape around existing content. */
export interface MaskProps {
  readonly context: PresentationContext;
  readonly content: PageChildren;
}

/** `hover_3d` decorative wrapper; interactive descendants are invalid. */
export interface Hover3dProps {
  readonly context: PresentationContext;
  readonly content: PageChildren;
}

/** One `hover_gallery` image: safe source plus its accessible alternative. */
export interface HoverGalleryImage {
  readonly src: string;
  readonly alt: MessageValue;
}

/** `hover_gallery` 1..10 authorized images with keyboard/touch access. */
export interface HoverGalleryProps {
  readonly context: PresentationContext;
  readonly images: ReadonlyArray<HoverGalleryImage>;
}

// ---------------------------------------------------------------------------
// C6 navigation + shared state (navigation.ts): breadcrumbs, button, menu,
// navbar, dock, megamenu, pagination, theme_controller.
// ---------------------------------------------------------------------------

/**
 * `breadcrumbs` derived-ancestry trail. `ancestry` is the explicit
 * declared-route ancestry from the dispatcher, root first; the last entry is
 * the current page. `label` names the nav for assistive tech.
 */
export interface BreadcrumbsProps {
  readonly context: PresentationContext;
  readonly label: MessageValue;
  readonly ancestry: readonly NavigationEntry[];
}

/**
 * Canonical-operation binding for `button`: posts to the existing owning
 * endpoint with the same hidden-field contract as the forms action factory
 * (operation, operation_id, CSRF, inputs). `inputs` are pre-bound scalar
 * arguments; record/handle bindings stay with that factory.
 */
export interface ButtonActionBinding {
  readonly postTo: string;
  readonly operation: string;
  readonly operationId: string;
  readonly label: MessageValue;
  readonly inputs?: Record<string, string | number | bigint | boolean>;
}

/**
 * `button` canonical bound control. Exactly one of `action`, `submit`,
 * `target` or `opens` must be present. `submit` renders the submit control
 * alone inside an owning form; `target` needs a safe URL or an original
 * source-bound File. A sole configured null File target, or a File withheld by
 * the presenter, renders a disabled control without a destination. `opens` names a
 * declared local panel id wired through the :target pattern.
 */
export interface ButtonProps {
  readonly context: PresentationContext;
  /** Presentation override; otherwise derived from the binding. */
  readonly caption?: MessageValue;
  readonly action?: ButtonActionBinding;
  readonly submit?: true;
  readonly target?: string | FileValue | null;
  readonly opens?: string;
  readonly tone?: AppearanceTone;
  readonly size?: AppearanceSize;
  readonly variant?: AppearanceVariant;
}

/**
 * `menu` semantic nav list. `entries` are declared destinations or canonical
 * action controls from the authorized descriptors; `label` names the nav.
 * No `variant` prop: only solid is admitted upstream (a no-op base), so
 * callers cannot name a failing variant (the divider precedent).
 */
export interface MenuProps {
  readonly context: PresentationContext;
  readonly label: MessageValue;
  readonly entries: readonly NavigationEntry[];
  readonly size?: AppearanceSize;
  readonly orientation?: AppearanceOrientation;
}

/**
 * `navbar` shared navigation presentation. `entries` render as the center
 * nav list; `start`/`end` are optional trusted slots (brand, tools).
 * No `variant` prop: only solid is admitted upstream (a no-op base).
 */
export interface NavbarProps {
  readonly context: PresentationContext;
  readonly label: MessageValue;
  readonly entries: readonly NavigationEntry[];
  readonly start?: PageChildren;
  readonly end?: PageChildren;
}

/**
 * `dock` bottom-bar presentation of canonical authorized destinations.
 * No `variant` prop: only solid is admitted upstream (a no-op base).
 */
export interface DockProps {
  readonly context: PresentationContext;
  readonly label: MessageValue;
  readonly entries: readonly NavigationEntry[];
  readonly size?: AppearanceSize;
}

/**
 * `megamenu` authorized page-descriptor groups; each group becomes one native
 * popover panel. `idPrefix` namespaces the popover ids; callers rendering
 * two megamenus on one page must pass distinct prefixes. No `variant` prop:
 * only solid is admitted upstream (a no-op base).
 */
export interface MegamenuProps {
  readonly context: PresentationContext;
  readonly label: MessageValue;
  readonly groups: readonly NavigationGroup[];
  readonly idPrefix?: string;
  readonly size?: AppearanceSize;
  readonly orientation?: AppearanceOrientation;
}

/**
 * `pagination` collection page-window navigation. `page`/`pages` come from
 * the enclosing collection's admitted cursor state; `hrefForPage` builds
 * each destination (the caller preserves filter/order state). `window` caps
 * the numbered buttons (default 7, minimum 5).
 */
export interface PaginationProps {
  readonly context: PresentationContext;
  readonly label: MessageValue;
  readonly page: number;
  readonly pages: number;
  readonly hrefForPage: (page: number) => string;
  readonly window?: number;
  readonly prevLabel?: MessageValue;
  readonly nextLabel?: MessageValue;
}

/** One finite theme choice: a pinned data-theme value plus its label. */
export interface ThemeOption {
  readonly value: string;
  readonly label: MessageValue;
}

/**
 * `themeController` no-JS theme-choice form over the shared Appearance path.
 * `themes` lists the finite choices (every value must be pinned); `current`
 * marks the active choice. Posts `theme=<value>` plus CSRF to `postTo`;
 * radios preview live via the theme-controller hook, reset cancels.
 */
export interface ThemeControllerProps {
  readonly context: PresentationContext;
  readonly label: MessageValue;
  readonly postTo: string;
  readonly themes: readonly ThemeOption[];
  readonly current?: string;
}

// ---------------------------------------------------------------------------
// C7 collections + files + review (collections.ts, controls.ts, review.ts):
// board, csv-import, file, review.
// ---------------------------------------------------------------------------

/**
 * `board` enum-grouped card columns over an authorized query. `by` names the
 * enum field whose case names partition rows; group order follows the
 * column's valueLabels declaration order when present, else first-seen row
 * order. No appearance props: the word admits no matrix (runtime extras
 * throw), so callers cannot name a failing token.
 */
export interface BoardProps {
  readonly context: PresentationContext;
  readonly model: string;
  /** Enum field whose case names partition rows into groups. */
  readonly by: string;
  readonly columns: readonly string[];
  readonly parent?: { readonly id: string };
  readonly where?: unknown;
  /** Checked owning enum/bool/reference filter declarations, not granted row metadata. */
  readonly filter?: readonly ColumnMeta[];
  /** Initial selections only; explicit request selection or clear wins. */
  readonly defaults?: Readonly<Record<string, CollectionFilterDefault>>;
  readonly limit?: number;
  readonly cursor?: string;
  /** Explicit finite page read, independent of enum-grouped layout. */
  readonly page?: true;
  /** Stable source collection occurrence; required when filter controls or pagination apply. */
  readonly occurrence?: string;
  readonly empty: MessageValue;
  /** Card detail body receives only the freshly queried authorized row and current view. */
  readonly renderRow?: (row: RowView, view: PresentationContext) => PageChildren | Promise<PageChildren>;
  readonly controls?: CollectionControls;
}

/** Parsed CSV preview: header captions plus armored string cells. */
export interface CsvImportReview {
  readonly columns: readonly MessageValue[];
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}

/**
 * `csvImport` caller-targeted upload panel with optional review. `postTo`
 * is the caller-supplied upload path, never invented. No appearance props:
 * the word admits no matrix (runtime extras throw).
 */
export interface CsvImportProps {
  readonly context: PresentationContext;
  /** Upload target path supplied by the caller; never invented here. */
  readonly postTo: string;
  readonly label: MessageValue;
  readonly review?: CsvImportReview;
}

/**
 * One authorized finalized file/media link. `href` is a dispatcher-supplied
 * authorized URL (same trust as LinkProps.target); hostile or empty values
 * fall back to "#" via safeHref, never render raw. `status` is the declared
 * DeliveryStatus where the source shape carries one.
 */
export interface FileLinkView {
  readonly href: string;
  readonly name?: string;
  readonly caption?: MessageValue;
  readonly status?: DeliveryStatus;
}

/**
 * Trusted admitted scope binds the original File object to its actual current
 * row, checked field and attachment. Null withholds the occurrence; missing
 * configuration is unavailable. Returned URLs must recheck current Identity,
 * row/field/File authority on every open and never grant access by possession.
 * Renderer props, copied IDs and request metadata cannot establish that binding.
 */
export type PageFilePresenter = (file: FileValue) => Promise<FileLinkView | null>;

/** Protected exact-original PNG/JPEG preview and attachment download URLs. */
export interface PageFileImageView {
  readonly previewUrl: string;
  readonly originalUrl: string;
}

/**
 * Trusted current page scope resolves only an original authorized query row
 * and its checked single File field. Null withholds an unavailable occurrence.
 * The host rechecks current Identity, row/field/attachment, source, physical
 * lifetime, digest and actual PNG/JPEG policy on every media GET. No copied row,
 * source extra, ID, MIME hint or URL can establish that association. Scope close
 * terminates its private bindings and pending results.
 */
export type PageFileImageResolver = (input: {
  readonly model: string;
  readonly record: RowView;
  readonly field: string;
}) => Promise<PageFileImageView | null>;

/** `file` display props: field wiring plus the authorized file links. */
export interface FileProps extends FieldControlProps {
  readonly files: ReadonlyArray<FileLinkView>;
}

/**
 * Declared policy content for one review. Every slot is an already-resolved
 * display value from the caller (text/decision/rationale/actor/time); null
 * and undefined both mean absent and render the unavailable presentation.
 */
export interface ReviewPolicyView {
  readonly text?: MessageValue | null;
  readonly decision?: MessageValue | null;
  readonly rationale?: MessageValue | null;
  readonly actor?: MessageValue | null;
  readonly time?: MessageValue | null;
}

/**
 * `review` leaf props: required policy content plus an optional caption.
 * A present-but-empty caption throws rather than emitting an empty name.
 */
export interface ReviewProps {
  readonly context: PresentationContext;
  readonly policy: ReviewPolicyView;
  readonly caption?: MessageValue;
}

// ---------------------------------------------------------------------------
// C8 settings + panels (panels.ts, settings.ts, leaves.ts): tabs, history,
// copy, settings, mockup_browser, mockup_phone, mockup_window.
// ---------------------------------------------------------------------------

/** One tab: a stable value, its caption and its trusted panel children. */
export interface TabItem {
  readonly value: string;
  readonly caption: MessageValue;
  readonly children: PageChildren;
  readonly open?: boolean;
}

/** One owned-enum-preference option doubling as a tab value. */
export interface TabsOption {
  readonly value: string;
  readonly label: MessageValue;
}

/** Owned-enum-preference binding: the tabset doubles as its selector. */
export interface TabsBinding {
  /** Preference field name carried by the radios. */
  readonly name: string;
  readonly options: readonly TabsOption[];
  readonly current?: string;
  /** Saved snapshot version; sent with a bound save for compare-and-set. */
  readonly version?: string;
  /** Caller-owned persistence path; the form POSTs name=<value> + CSRF. */
  readonly postTo: string;
}

/**
 * `tabs` radio-driven tabset. Transient selection by default; a binding
 * names the radios after the owned preference and wraps them in a form
 * POSTing to the caller path. Either a nonempty tab-child suite or a
 * selector binding is required. No `variant` prop: only solid is admitted
 * upstream (a no-op base); sizes land on the container only. Panel/tab
 * element ids namespace under `id` when given, else under the radio group
 * name: pages rendering more than one tabset — or more than one set bound
 * to one preference — must pass distinct ids (the megamenu rule).
 */
export interface TabsProps {
  readonly context: PresentationContext;
  readonly items?: readonly TabItem[];
  readonly binding?: TabsBinding;
  readonly caption?: MessageValue;
  readonly id?: string;
  readonly size?: AppearanceSize;
}

/**
 * `history` authorized audit trail. Source rows use the current page reader
 * inside an initially closed Collapse; explicit entries retain their API.
 */
export type HistoryProps = {
  readonly context: PresentationContext;
  readonly caption?: MessageValue;
  readonly id?: string;
} & ({
  readonly entries: ReadonlyArray<HistoryEntry>;
  readonly model?: never;
  readonly record?: never;
} | {
  readonly model: string;
  readonly record: RowView;
  readonly entries?: never;
});

/**
 * `copy` selectable value display: a readonly input holding the value plus
 * its label. There is deliberately no copy button: clipboard write needs
 * JS, and a button that cannot act would be dishonest.
 */
export interface CopyProps {
  readonly context: PresentationContext;
  readonly value: string;
  /** Omission labels the value with itself; explicit empty labels throw. */
  readonly label?: MessageValue;
  readonly id?: string;
}

/** Base (shared appearance) panel controls over one caller POST target. */
export interface SettingsBaseControls {
  readonly caption: MessageValue;
  /** Caller-owned persistence path for theme + density. */
  readonly postTo: string;
  readonly themeLabel: MessageValue;
  readonly themes: readonly ThemeOption[];
  readonly currentTheme?: string;
  readonly densityLabel?: MessageValue;
  readonly currentDensity?: ThemeDensity;
}

/** One caller-declared preference section with its self-only POST paths. */
export interface PreferenceSection {
  /** Matches the SettingsSection id listed by the S2 frame. */
  readonly id: string;
  readonly caption: MessageValue;
  /** Caller-owned save path; controls POST here with CSRF + version. */
  readonly saveTo: string;
  readonly resetTo?: string;
  readonly version?: string;
  readonly controls?: PageChildren;
}

/**
 * `settings` active-section panel for the S2 frame (its panelHtml). The
 * base id (default "base") selects the shared theme/density panel; any
 * other id must match a caller-declared preference section.
 */
export interface SettingsPanelProps {
  readonly context: PresentationContext;
  /** Active section id as listed by the S2 frame. */
  readonly sectionId: string;
  /** Section id that selects the base panel (default "base"). */
  readonly baseId?: string;
  readonly base?: SettingsBaseControls;
  readonly preferences?: readonly PreferenceSection[];
}

/** `mockup_browser` presentation wrapper with a URL bar text prop. */
export interface MockupBrowserProps {
  readonly context: PresentationContext;
  readonly children: PageChildren;
  readonly url?: MessageValue;
  readonly caption?: MessageValue;
}

/** `mockup_phone` presentation wrapper; no device behavior. */
export interface MockupPhoneProps {
  readonly context: PresentationContext;
  readonly children: PageChildren;
  readonly caption?: MessageValue;
}

/** `mockup_window` presentation wrapper; no window behavior. */
export interface MockupWindowProps {
  readonly context: PresentationContext;
  readonly children: PageChildren;
  readonly caption?: MessageValue;
}

// ---------------------------------------------------------------------------
// T20a: generated operation forms over T19a derived inputs (L5/L6 pilot).
// Part of PRESENTATION_CONTRACT_VERSION canlang.presentation/0.15.0
// (additive, following the T19a additive precedent — no bump).
//
// Presentation rule (pinned here, implemented in @canlang/ui forms.ts and
// consumed by the @canlang/interfaces error re-render): a generated form
// renders exactly one field per derived input, in emission order, with the
// widget selected by GENERATED_FORM_TYPE_FOR_KIND below. The writable
// allowlist is exactly the derived input names — the form never adds a
// business member the derivation did not admit. `literal` defaults prefill
// verbatim as display values; `parent` defaults prefill nothing (omission
// defers to the engine, per the T19a wire rule); the interface never
// invents fill values. Submission carries exactly the caller-supplied
// values through the real operation dispatcher, and denials re-render
// through the same fields with safe messages only.
// ---------------------------------------------------------------------------

/**
 * T20a pinned widget selection: every committed T19a pilot input kind maps
 * to exactly one canonical form field type. `ref` renders as a text id
 * entry (the update `record` binds as hidden id/version instead — see
 * GeneratedFormProps — and versioned non-record refs pair with a
 * GENERATED_REF_VERSION_SUFFIX companion); `file` maps to the file type
 * whose render fails closed with the established S7 upload-intents error
 * (no pilot operation carries a file input); `enum` renders a select whose
 * options are the derived values verbatim. `user` renders an opaque ID;
 * submission uses its existing canonical `{id}` wire value. The table is
 * deliberately NOT keyed by the live DerivedInputKind union: richer kinds
 * are T19b/T20b scope, and the factory fails closed on any kind missing
 * here — never a guessed widget.
 */
export const GENERATED_FORM_TYPE_FOR_KIND = {
  ref: "text",
  user: "text",
  string: "text",
  integer: "int",
  decimal: "decimal",
  money: "money",
  datetime: "datetime",
  boolean: "bool",
  file: "file",
  enum: "enum",
};

/**
 * T20a ref-version companion convention: a versioned non-record ref input
 * named `owner` pairs with a text field pathed `owner__version` carrying
 * the expected version. The submission projection composes the pair into
 * the `{id, version}` envelope member; the companion name never enters the
 * envelope itself, so the closed-inputs check never sees it.
 */
export const GENERATED_REF_VERSION_SUFFIX = "__version";

/**
 * T20b companion suffixes (pinned for the E2b/F1 join; UI-local
 * GENERATED_REF_VERSION_SUFFIX precedent above). Each companion is a
 * client-flat-map member that the submission projection consumes and
 * never forwards to the envelope: `__null` marks explicit-null intent
 * on nullable inputs only (ignored on non-nullable — tamper-proof);
 * `__currency` carries the verbatim caller-supplied money currency next
 * to `amount` (minor); `__fold` disambiguates ambiguous wall times
 * ('earlier'/'later'). Companion names never enter the closed-inputs
 * envelope themselves.
 */
export const GENERATED_NULL_SUFFIX = "__null";
export const GENERATED_CURRENCY_SUFFIX = "__currency";
export const GENERATED_FOLD_SUFFIX = "__fold";

/**
 * T20b delivery-input presentation rule: a `delivery` derived input
 * renders as an informational receipt-binding notice in emission order
 * (capability.operation vN + result nominal + verbatim leaf table) —
 * never as a submittable field. The submission projection emits no
 * member for it, even if tampered client state carries one, per the
 * T19b wire rule (wire.ts: `delivery` entries are declared bindings,
 * not submittable members; a submitted `delivery` member fails
 * `validation` like an unknown member). Display-only, no envelope
 * member, no projection output.
 *
 * The rule is documentary: no runtime member is exported because a
 * delivery input produces no field, no companion, and no envelope
 * member. Delivery stays absent from GENERATED_FORM_TYPE_FOR_KIND by
 * design (the factory fails closed on it, like any unlisted kind).
 */

/** Caller overrides for generated fields; everything defaults verbatim. */
export interface GeneratedFormOverrides {
  /**
   * Label per field path (companions included). Absent labels default to
   * the field path verbatim — never prettified, never invented wording.
   */
  readonly labels?: Record<string, MessageValue>;
  /**
   * Prefill value per field path, overriding `literal` defaults. Keys must
   * match a generated field path exactly, else the factory throws naming
   * the key — a typo'd prefill is never silently dropped.
   */
  readonly values?: Record<string, unknown>;
}

/**
 * T20a generated operation form: the ui factory input. `mode` must agree
 * with `derived.kind` exactly (create/update/scenario); `read`/`delete`
 * derivations have no generated form and the factory throws naming the
 * operation — reads are not forms and deletes render the delete card.
 * Update mode binds `record` as hidden id/version and excludes the
 * `record` input from the visible fields; every other derived input
 * renders one field in emission order.
 */
export interface GeneratedFormProps {
  readonly context: PresentationContext;
  /** Dispatcher-supplied POST target; lane 05 never invents URLs. */
  readonly action: string;
  /** Checked T19a derivation this form is generated from. */
  readonly derived: DerivedOperationInputs;
  readonly mode: FormMode;
  /** Fresh idempotency key rendered per form (replay-safe resubmits). */
  readonly operationId: string;
  /** Bound record for updates (hidden id/version); required in update mode. */
  readonly record?: MutationRef;
  /** Resolved rendering timezone (team adapter or explicit UTC fallback). */
  readonly timeZone: string;
  /** Field errors keyed by JSON Pointer into inputs (wire FieldError). */
  readonly errors?: ReadonlyArray<FieldError>;
  readonly outcome?: FormOutcome;
  readonly submit: MessageValue;
  readonly cancelHref?: string;
  /** Caller-unique prefix for input ids (deterministic for swaps/tests). */
  readonly idPrefix: string;
  readonly labels?: Record<string, MessageValue>;
  readonly values?: Record<string, unknown>;
}

/**
 * BGI-09 row-bound generated views and BGI-10 scoped style hooks.
 *
 * A prompted `view Name(row:Model) $"..."` renders through its saved
 * `render({row, bindings, ui})`: the host evaluates the `show` row argument
 * once, pre-renders every declared canonical control through the existing
 * factories (refused fields never reach the bindings), and the renderer
 * only arranges those bindings. Optional saved `mount(root, presentation)`
 * browser code enhances the instance root and returns cleanup that the
 * browser join runs when the instance is replaced. No props, slots,
 * nested show or exports: the view name, one row, and declared controls
 * are the whole contract.
 */
export const GENERATED_VIEW_CONTRACT_VERSION = "canlang.presentation.generated-view/1";

/** Scope contract version shared with the compiler CSS scoper. */
export const STYLE_SCOPE_CONTRACT_VERSION = "canlang.css-scope/1";

/**
 * Ownership marker; the value is the owning style unit. A nested child
 * root carries its own unit here plus the parent unit in
 * STYLE_HOST_ATTR, so parent rules place the host but cannot match its
 * interior. Values are compiler-written; authored selectors must never
 * mention them.
 */
export const STYLE_OWNERSHIP_ATTR = "data-can-style";
/** Per-use root hook; the value is `<unit>:<use>`. */
export const STYLE_ROOT_ATTR = "data-can-style-root";
/** Child-host hook; the value is the parent style unit. */
export const STYLE_HOST_ATTR = "data-can-style-host";
/** Generated-view instance root; the value is the instance id. */
export const GENERATED_VIEW_ATTR = "data-can-view";

/** Rendered hook attributes for one named-style use root. */
export function styleUseAttributes(unitId: string, useId: string): string {
  return `${STYLE_OWNERSHIP_ATTR}="${unitId}" ${STYLE_ROOT_ATTR}="${unitId}:${useId}"`;
}

/** Rendered hook attributes for a nested child root (child unit + parent hook). */
export function styleHostAttributes(childUnit: string, parentUnit: string): string {
  return `${STYLE_OWNERSHIP_ATTR}="${childUnit}" ${STYLE_HOST_ATTR}="${parentUnit}"`;
}

/** One checked control binding a prompted view declares. */
export interface GeneratedViewControl {
  /** `edit` | `delete` | `form` | `action` | `actions`. */
  readonly kind: string;
  /** Operation for `form`/`action`/`actions` (`Todo.create`). */
  readonly operation?: string;
  /** Declared fields for `edit`/`form`; admission filters refusals. */
  readonly fields?: ReadonlyArray<string>;
}

/** Checked contract for one prompted row-bound view definition. */
export interface GeneratedViewDescriptor {
  readonly version: typeof GENERATED_VIEW_CONTRACT_VERSION;
  readonly view: string;
  readonly rowModel: string;
  readonly controls: ReadonlyArray<GeneratedViewControl>;
  /** Style unit id styling the renderer root, when declared. */
  readonly rootStyle?: string;
  /** Owning renderer unit when its saved implementation supplies CSS. */
  readonly rendererStyle?: string;
}

/** Pre-rendered canonical control HTML the renderer arranges. */
export interface GeneratedViewBinding {
  /** Stable binding name (`edit`, `delete`, `form`, `action`). */
  readonly name: string;
  readonly html: string;
}

/**
 * Presentation helpers the saved renderer may call. The renderer arranges
 * admitted data and pre-rendered bindings; it cannot reach stores,
 * dispatch, or raw principal state through this surface.
 */
export interface GeneratedViewUi {
  readonly escapeHtml: (value: string) => string;
  readonly escapeAttr: (value: string) => string;
}

/** Saved `render({row, bindings, ui})` input. `row` is already evaluated. */
export interface GeneratedViewRenderInput {
  readonly row: RowView;
  readonly bindings: Record<string, string>;
  readonly ui: GeneratedViewUi;
}

/** Saved renderer entry: arrange bindings into instance HTML. */
export type GeneratedViewRender = (
  input: GeneratedViewRenderInput,
) => string | Promise<string>;

/** Presentation facts handed to a saved browser `mount`. */
export interface GeneratedViewPresentation {
  readonly view: string;
  readonly useId: string;
  readonly row: RowView;
}

/**
 * Saved browser enhancement entry. `root` is the live instance element
 * (narrowed by the browser join); the return value is instance cleanup the
 * join runs when the instance is replaced. Name the export `mount`;
 * absence of the export means no browser enhancement.
 */
export type GeneratedViewMount = (
  root: unknown,
  presentation: GeneratedViewPresentation,
) => (() => void) | void;

/** UI factory input for one row-bound instance. */
export interface GeneratedViewInstanceProps {
  readonly context: PresentationContext;
  readonly descriptor: GeneratedViewDescriptor;
  /** Separate `can-view-m..-f..-s..` identity per `show` use. */
  readonly useId: string;
  /** Row value, evaluated exactly once by the caller. */
  readonly row: RowView;
  /** Pre-rendered canonical controls; refused fields are already absent. */
  readonly bindings: ReadonlyArray<GeneratedViewBinding>;
  /** Saved renderer; called exactly once per instance. */
  readonly render: GeneratedViewRender;
}

/**
 * Admit one rendered instance root: the factory asserts the descriptor
 * version, the use id shape, and that binding names are unique, so a
 * misbuilt caller fails before the saved renderer runs.
 */
export function assertGeneratedViewInstanceProps(props: GeneratedViewInstanceProps): void {
  if (props.descriptor.version !== GENERATED_VIEW_CONTRACT_VERSION) {
    throw new Error(
      `generated view ${JSON.stringify(props.descriptor.view)}: unsupported contract ${JSON.stringify(props.descriptor.version)}`,
    );
  }
  if (!/^can-view-m\d+-f\d+-s\d+(?:-o[0-9a-f]+)?$/.test(props.useId)) {
    throw new Error(`generated view ${JSON.stringify(props.descriptor.view)}: invalid use id ${JSON.stringify(props.useId)}`);
  }
  for (const style of [props.descriptor.rootStyle, props.descriptor.rendererStyle]) {
    if (style !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(style)) {
      throw new Error(`generated view ${JSON.stringify(props.descriptor.view)}: invalid style identity`);
    }
  }
  const seen = new Set<string>();
  for (const binding of props.bindings) {
    if (seen.has(binding.name)) {
      throw new Error(
        `generated view ${JSON.stringify(props.descriptor.view)}: duplicate binding ${JSON.stringify(binding.name)}`,
      );
    }
    seen.add(binding.name);
  }
}

/**
 * Admit a saved view-module `render` export. Anything but a function
 * refuses: a missing export is a missing implementation, never an empty
 * render.
 */
export function assertGeneratedViewRender(view: string, render: unknown): asserts render is GeneratedViewRender {
  if (typeof render !== "function") {
    throw new Error(`generated view ${JSON.stringify(view)}: saved module exports no render({row, bindings, ui})`);
  }
}
