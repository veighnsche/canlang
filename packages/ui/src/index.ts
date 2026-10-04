/**
 * @canlang/ui public surface for generated code.
 *
 * Generated app JS calls these canonical factories with props/children; the
 * library owns markup/classes and behavior. S1 ships escaping and messages;
 * S2 adds navigation discovery and the page shell; components, forms,
 * collections, htmx, settings and review land in later slices on this surface.
 */

export {
  csvFormulaProtect,
  escapeAttr,
  escapeHtml,
  isSafeUrl,
  isolate,
  safeHref,
} from "./escape.js";
export {
  formatDecimalExact,
  formatIntExact,
  formatMessage,
  formatMoneyExact,
  localeNumberSystem,
  localeSeparators,
  message,
  normalizeTag,
  resolveMessage,
  selectPluralCategory,
} from "./messages.js";
export type {
  Bcp47Tag,
  LocaleNumberSystem,
  MessageParams,
  ResolvedMessage,
  ThemeTokens,
} from "./messages.js";
export {
  buildNavigation,
  selectDiscoveryCandidates,
} from "./navigation.js";
export type { BuildNavigationOptions } from "./navigation.js";
export {
  pageDirection,
  pageLocale,
  renderPage,
} from "./shell.js";
// Temporary B0 wiring: re-exported contract types until lane 7 assembles
// @canlang/contracts; see README.
export type {
  AccountMenuData,
  AdmittedBindings,
  AdmitFn,
  AdmissionOutcome,
  BoundArguments,
  Bcp47Tag as ContractBcp47Tag,
  MessageDescriptor,
  MessageFactory,
  MessageParamValue,
  MessageValue,
  MessageVariantMap,
  NavigationEntry,
  NavigationGroup,
  NavigationResult,
  OperationRef,
  OwnerLabels,
  PageChild,
  PageChildren,
  PageDescriptor,
  PresentationContext,
  RecordIdentity,
  RenderFn,
  RenderPageFn,
  SettingsFrameData,
  SettingsSection,
  ShellData,
  ShellRoutes,
  TeamOption,
  ThemeAccent,
  ThemeDensity,
  ThemeMode,
  ThemeTokens as ContractThemeTokens,
} from "../../contracts/src/presentation.js";
export {
  CSRF_FIELD,
  DEFAULT_THEME,
  PRESENTATION_CONTRACT_VERSION,
  TEAM_FIELD,
} from "../../contracts/src/presentation.js";
