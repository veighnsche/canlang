/**
 * Presentation boundary contract (lane 05 owned).
 *
 * Canonical component props, page descriptors, admitted bindings, operation/reference
 * bindings and safe message values shared by compiler emission (lane 1) and route
 * dispatch (lane 6). This file is types and wire shapes only: no execution engine,
 * no second CRUD/policy engine, no browser business-state store.
 *
 * Member TS imports this module directly (workspace-wide pattern); the L7
 * contracts index re-exports it for external consumers. No duplicate
 * definitions: this file is the single source of truth for the shapes below.
 */

import type {
  BusinessError,
  FieldError,
  MutationRef,
  SealedActionHandle,
} from "./wire.js";
import type { DeliveryStatus } from "./services.js";

/** Reused producer types, re-exported so lane-05 members import one contract file. */
export type { BusinessError, FieldError, MutationRef, SealedActionHandle } from "./wire.js";
export type { DeliveryStatus } from "./services.js";

export const PRESENTATION_CONTRACT_VERSION = "canlang.presentation/0.10.0";

/**
 * Name of the hidden CSRF field in every canonical POST form. Rendered by
 * lane 05, read by the lane 6 dispatcher (ack requested); never a business
 * input and never logged.
 */
export const CSRF_FIELD = "_csrf";

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
  readonly source: string;
  readonly variants: MessageVariantMap;
  readonly params?: MessageParams;
}

/** Factory implemented by @canlang/ui and called by generated code. */
export type MessageFactory = (
  source: string,
  variants?: MessageVariantMap,
  params?: MessageParams,
) => MessageDescriptor;

/** Any caption slot: literal source text or a full descriptor. */
export type MessageValue = string | MessageDescriptor;

/** Result of locale resolution: selected text plus the variant locale used. */
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

/**
 * Minimal presentation view of the request, derived by the lane 6 route
 * dispatcher from the authenticated context. Never constructed from user JSON.
 * Lane 05 never inspects `principal`; authority stays with canonical policies.
 */
export interface PresentationContext {
  /** Viewer locale preference: saved preference, then language priority list. */
  readonly preferredLocales: readonly string[];
  /** Owning app default locale (pinned "en" unless the app declares otherwise). */
  readonly appDefaultLocale: string;
  readonly theme: ThemeTokens;
  /** Current normalized path, for navigation highlight. */
  readonly path: string;
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
  /** Canonical declaring package. */
  readonly owner: string;
  /** Normalized route pattern, e.g. "/expenses/review" or "/invoices/{Invoice.id}". */
  readonly path: string;
  readonly title: MessageValue;
  readonly description?: MessageValue;
  readonly order?: bigint;
  readonly group?: MessageValue;
  readonly nav?: "none";
  readonly admit: AdmitFn;
  readonly render: RenderFn;
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
}

/**
 * One projected row for list/table rendering. Fields hold the authorized
 * projection only: forbidden fields never reach props, so they can never
 * enter HTML. The label rule reads supplied fields alone.
 */
export interface RowView {
  readonly id: string;
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
}

/**
 * Row-query arguments. Predicates are opaque generated code passed through
 * to the runner; UI never inspects them. Order/filter/search extend this
 * shape additively in the collections-controls slice.
 */
export interface ListQueryArgs {
  readonly parent?: { readonly id: string };
  readonly where?: unknown;
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
  readonly columns: readonly ColumnMeta[];
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
 * One `text` value. Raw strings are verbatim text; raw numbers must be safe
 * integers (non-integers throw: decimals need {type,value}); bigint/bool are
 * exact; descriptors render through the formatter with bound params;
 * {type,value} pairs carry numerics/temporals with explicit types; null and
 * undefined render as empty.
 */
export type TextValue =
  | string
  | number
  | bigint
  | boolean
  | MessageDescriptor
  | MessageParamValue
  | null
  | undefined;

export interface CardProps {
  readonly context: PresentationContext;
  readonly title: MessageValue;
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
  readonly values: readonly TextValue[];
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
  readonly context: PresentationContext;
  readonly model: string;
  readonly parent?: { readonly id: string };
  readonly where?: unknown;
  readonly limit?: number;
  readonly cursor?: string;
  readonly empty: MessageValue;
  readonly renderRow: (row: RowView, view: PresentationContext) => PageChildren;
  /** Search/filter/order/pagination/export toolbar; absent renders rows only. */
  readonly controls?: CollectionControls;
}

export interface TableProps {
  readonly context: PresentationContext;
  readonly model: string;
  readonly parent?: { readonly id: string };
  readonly where?: unknown;
  readonly limit?: number;
  readonly cursor?: string;
  readonly columns: readonly string[];
  readonly empty: MessageValue;
  /** Search/filter/order/pagination/export toolbar; absent renders rows only. */
  readonly controls?: CollectionControls;
}

/**
 * One component catalog entry, mirroring the L1/L2 catalog envelope shape
 * for presentation capabilities (unification with the shared envelope is a
 * later L1/L7 join; L1 acknowledgment pending).
 */
/**
 * Binding profile of a catalog word, per design/UI-COMPONENTS.md grammar
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

/** Finite semantic appearance tokens (design/UI-COMPONENTS.md). */
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
 * presentation. The view-preference production arrives with C8 preferences.
 */
export interface FilterProps extends FieldControlProps {}

/**
 * `calendar` agenda production: date-grouped read-only agenda over a query
 * in the team timezone. Field production reuses the control props.
 */
export interface CalendarAgendaProps {
  readonly context: PresentationContext;
  readonly model: string;
  readonly startField: string;
  readonly endField: string;
  readonly where?: unknown;
  readonly limit?: number;
  readonly cursor?: string;
  readonly empty: MessageValue;
  /** IANA zone for day grouping/display; defaults to UTC when absent. */
  readonly timeZone?: string;
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
  /** Bound record for updates (hidden id/version); required in update mode. */
  readonly record?: MutationRef;
  /** Resolved rendering timezone (team adapter or explicit UTC fallback). */
  readonly timeZone: string;
  readonly fields: ReadonlyArray<FormFieldDef>;
  /** Field errors keyed by JSON Pointer into inputs (wire FieldError). */
  readonly errors?: ReadonlyArray<FieldError>;
  readonly outcome?: FormOutcome;
  readonly submit: MessageValue;
  readonly cancelHref?: string;
  /** Caller-unique prefix for input ids (deterministic for swaps/tests). */
  readonly idPrefix: string;
}

export interface EditProps extends Omit<FormProps, "mode" | "record"> {
  readonly record: MutationRef;
}

export interface DeleteProps {
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

export interface ActionProps {
  readonly context: PresentationContext;
  readonly action: string;
  readonly operation: string;
  readonly operationId: string;
  readonly label: MessageValue;
  /** Bound record for record actions (hidden id/version). */
  readonly record?: MutationRef;
  /** Sealed handle for handle-mode actions (opaque hidden JSON). */
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
  readonly target: string;
  readonly caption?: MessageValue;
  readonly tone?: AppearanceTone;
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
