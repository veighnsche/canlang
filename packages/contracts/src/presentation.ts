/**
 * Presentation boundary contract (lane 05 owned).
 *
 * Canonical component props, page descriptors, admitted bindings, operation/reference
 * bindings and safe message values shared by compiler emission (lane 1) and route
 * dispatch (lane 6). This file is types and wire shapes only: no execution engine,
 * no second CRUD/policy engine, no browser business-state store.
 *
 * B0 note: packages/contracts assembly (package.json, index.ts) is lane 7 owned and
 * does not exist yet. Until it lands, packages/ui imports this file via an explicit
 * relative path, marked temporary B0 wiring in the ui README. No duplicate
 * definitions: this file is the single source of truth for the shapes below.
 */

export const PRESENTATION_CONTRACT_VERSION = "canlang.presentation/0.1.0";

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
