/**
 * @canlang/ui public surface for generated code.
 *
 * Generated app JS calls these canonical factories with props/children; the
 * library owns markup/classes and behavior. S1 ships escaping and messages;
 * shell, components, forms, collections, htmx, settings and review land in
 * later slices on this same surface.
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
// Temporary B0 wiring: re-exported contract types until lane 7 assembles
// @canlang/contracts; see README.
export type {
  AdmittedBindings,
  AdmitFn,
  BoundArguments,
  Bcp47Tag as ContractBcp47Tag,
  MessageDescriptor,
  MessageFactory,
  MessageParamValue,
  MessageValue,
  MessageVariantMap,
  OperationRef,
  PageChild,
  PageChildren,
  PageDescriptor,
  PresentationContext,
  RecordIdentity,
  RenderFn,
  ThemeAccent,
  ThemeDensity,
  ThemeMode,
  ThemeTokens as ContractThemeTokens,
} from "../../contracts/src/presentation.js";
export {
  DEFAULT_THEME,
  PRESENTATION_CONTRACT_VERSION,
} from "../../contracts/src/presentation.js";
