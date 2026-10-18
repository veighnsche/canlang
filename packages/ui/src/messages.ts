/**
 * Message descriptors, locale resolution and ICU-profile formatting.
 *
 * Resolution: RFC 4647 lookup over viewer preferences, then app-default
 * lookup, then the source variant. Formatting implements the bounded DESIGN
 * §9.1 profile: named args, number/date/time, nested plural/selectordinal/
 * select with mandatory `other`. Plural/format rules always use the selected
 * variant's locale, including fallback.
 *
 * Exactness seam (lane 2 owns locale-neutral codecs): integers travel as
 * bigint or canonical decimal strings and are never lossy-converted; naive
 * `number` is accepted for ints only when it is a safe integer. Currency
 * scales and canonical type ids come from lane 2; the scales table is an
 * explicit parameter here, never an invented default.
 */

import {
  DEFAULT_THEME,
  PRESENTATION_CONTRACT_VERSION,
  type Bcp47Tag,
  type MessageDescriptor,
  type MessageFactory,
  type MessageParams,
  type MessageParamValue,
  type MessageValue,
  type MessageVariantMap,
  type ResolvedMessage,
  type ThemeTokens,
} from "@canlang/contracts";
import {
  encodeValue,
  isDateValue,
  isDatetime,
  isDecimal,
  messageUsages,
  parseMessageSyntax,
  parseTypeId,
  ValueError,
  type MessageNode,
  type MessageUsage,
  type MessageSyntaxDiagnostic,
  type ParsedMessage,
} from "@canlang/values";

export { DEFAULT_THEME, PRESENTATION_CONTRACT_VERSION };
export type { Bcp47Tag, MessageParams, ResolvedMessage, ThemeTokens };

/** Canonicalize a BCP 47 tag; throws RangeError when invalid. */
export function normalizeTag(tag: string): string {
  if (typeof tag !== "string") {
    throw new TypeError("locale tag must be a string");
  }
  const canonical = Intl.getCanonicalLocales(tag);
  const first = canonical[0];
  if (first === undefined) {
    throw new RangeError(`invalid locale tag: ${tag}`);
  }
  return first;
}

/**
 * Construct an immutable message descriptor. Variant keys must be canonical
 * BCP 47 tags without duplicates; `null` marks an absent translation. Validate
 * source/present-variant syntax and every declared usage without converting
 * operand values. With no params, binding waits until formatting.
 */
export const message: MessageFactory = (
  source: string,
  variants: MessageVariantMap = {},
  params?: MessageParams,
  sourceLocale?: string,
): MessageDescriptor => {
  if (typeof source !== "string") {
    throw new TypeError("message source must be a string");
  }
  if (variants === null || typeof variants !== "object" || Array.isArray(variants)) {
    throw new TypeError("message variants must be an object");
  }
  const owningLocale = sourceLocale === undefined ? undefined : normalizeTag(sourceLocale);
  const checked: MessageVariantMap = {};
  for (const key of Object.keys(variants)) {
    const canonical = normalizeTag(key);
    if (canonical === owningLocale) {
      throw new RangeError(`source locale duplicates message variant: ${canonical}`);
    }
    if (Object.hasOwn(checked, canonical)) {
      throw new RangeError(`duplicate canonical locale variant: ${canonical}`);
    }
    const value = variants[key];
    if (typeof value !== "string" && value !== null) {
      throw new TypeError(`variant ${canonical} must be a string or null`);
    }
    checked[canonical] = value;
  }
  const descriptor: MessageDescriptor = {
    source,
    variants: Object.freeze(checked),
    ...(owningLocale === undefined ? {} : { sourceLocale: owningLocale }),
  };
  let copied: MessageParams | undefined;
  if (params !== undefined) {
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      throw new TypeError("message params must be an object");
    }
    copied = {};
    for (const name of Object.keys(params)) {
      const param = params[name];
      if (param === null || typeof param !== "object" || Array.isArray(param)) {
        throw new TypeError(`message argument "${name}" must be {type, value}`);
      }
      Object.defineProperty(copied, name, {
        value: Object.freeze({ type: param.type, value: param.value }),
        enumerable: true,
      });
    }
  }
  const declared = copied;
  checkedPatterns(source, checked, declared === undefined ? undefined : (name) =>
    Object.hasOwn(declared, name) ? declarationKind(name, declared[name]!.type) : undefined);
  return Object.freeze(copied === undefined ? descriptor : { ...descriptor, params: Object.freeze(copied) });
};

/** Recognize an already resolved display value without resolving or parsing it. */
export function resolvedText(value: unknown): ResolvedMessage | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  if (!Object.hasOwn(value, "text") && !Object.hasOwn(value, "locale")) {
    return undefined;
  }
  const keys = Reflect.ownKeys(value);
  if (typeof value !== "object" || Array.isArray(value) || keys.length !== 2 ||
      !keys.includes("text") || !keys.includes("locale")) {
    throw new TypeError("resolved text must contain exactly text and locale");
  }
  const pair = value as { text: unknown; locale: unknown };
  const text = pair.text;
  const rawLocale = pair.locale;
  if (typeof text !== "string" || typeof rawLocale !== "string") {
    throw new TypeError("resolved text and locale must be strings");
  }
  const locale = normalizeTag(rawLocale);
  if (locale !== rawLocale) {
    throw new RangeError("resolved text locale must be canonical");
  }
  return Object.freeze({ text, locale });
}

function isAncestorOrEqual(available: string, request: string): boolean {
  return request === available || request.startsWith(`${available}-`);
}

/**
 * RFC 4647 lookup of one request tag against available variant tags.
 * Compatible variants are exact or prefix ancestors; equally matching
 * candidates prefer the exact tag, then a matching app-default tag, then
 * canonical-tag lexical order.
 */
function lookupOne(
  available: readonly string[],
  request: string,
  appDefault: string,
): string | null {
  const compatible = available.filter((tag) => isAncestorOrEqual(tag, request));
  if (compatible.length === 0) {
    return null;
  }
  compatible.sort((a, b) => {
    if (a === request && b !== request) return -1;
    if (b === request && a !== request) return 1;
    if (b.length !== a.length) return b.length - a.length;
    // Defensive: compatible tags are all prefixes of one request, so distinct
    // candidates always differ in length and the rule above decides. The
    // app-default/lexical tiebreaks below only document the DESIGN §9.1 order.
    if (a === appDefault && b !== appDefault) return -1;
    if (b === appDefault && a !== appDefault) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return compatible[0] as string;
}

export interface ResolveOptions {
  readonly preferredLocales: readonly string[];
  readonly appDefaultLocale: string;
  /** Authored source language of the owning asset; pinned "en" unless declared. */
  readonly sourceLocale?: string;
}

/** Resolve a message to text plus the selected variant locale. */
export function resolveMessage(
  descriptor: MessageDescriptor,
  options: ResolveOptions,
): ResolvedMessage {
  if (descriptor === null || typeof descriptor !== "object") {
    throw new TypeError("descriptor must be a message descriptor");
  }
  const appDefault = normalizeTag(options.appDefaultLocale);
  const carriedLocale = descriptor.sourceLocale === undefined
    ? undefined : normalizeTag(descriptor.sourceLocale);
  const explicitLocale = options.sourceLocale === undefined
    ? undefined : normalizeTag(options.sourceLocale);
  if (carriedLocale !== undefined && explicitLocale !== undefined && carriedLocale !== explicitLocale) {
    throw new RangeError("resolver source locale disagrees with message descriptor");
  }
  const sourceLocale = carriedLocale ?? explicitLocale ?? "en";
  const available = Object.keys(descriptor.variants).filter(
    (tag) => descriptor.variants[tag] !== null,
  );
  if (carriedLocale !== undefined) {
    if (Object.hasOwn(descriptor.variants, carriedLocale)) {
      throw new RangeError(`source locale duplicates message variant: ${carriedLocale}`);
    }
    available.push(carriedLocale);
  }
  const selected = (locale: string): ResolvedMessage => Object.freeze({
    text: locale === carriedLocale ? descriptor.source : descriptor.variants[locale] as string,
    locale,
  });
  for (const preferred of options.preferredLocales) {
    const request = normalizeTag(preferred);
    const match = lookupOne(available, request, appDefault);
    if (match !== null) {
      return selected(match);
    }
  }
  const fallback = lookupOne(available, appDefault, appDefault);
  if (fallback !== null) {
    return selected(fallback);
  }
  return Object.freeze({ text: descriptor.source, locale: sourceLocale });
}

// ---------------------------------------------------------------------------
// Scalar display values
// ---------------------------------------------------------------------------

export interface MoneyValue {
  readonly minor: bigint | string;
  readonly currency: string;
}

type IntOperand = { readonly kind: "int"; readonly value: bigint };
type DecimalOperand = { readonly kind: "decimal"; readonly text: string };
type ScalarOperand =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "bool"; readonly value: boolean }
  | IntOperand
  | DecimalOperand
  | { readonly kind: "money"; readonly minor: bigint; readonly currency: string }
  | { readonly kind: "date"; readonly iso: string }
  | { readonly kind: "datetime"; readonly iso: string }
  | { readonly kind: "enum"; readonly value: string };

const INT_RE = /^[+-]?\d+$/;
const DECIMAL_RE = /^[+-]?(?:\d+)(?:\.\d+)?$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const STRING_LIKE = new Set(["text", "email", "url", "timezone", "locale", "currency"]);

function fail(name: string, why: string): never {
  throw new TypeError(`message argument "${name}": ${why}`);
}

/** Canonical decimal key for exact numeric comparison (strips +0/-0 padding). */
function decimalKey(text: string): string {
  let rest = text;
  let negative = false;
  if (rest.startsWith("-")) {
    negative = true;
    rest = rest.slice(1);
  } else if (rest.startsWith("+")) {
    rest = rest.slice(1);
  }
  const dot = rest.indexOf(".");
  let intPart = dot === -1 ? rest : rest.slice(0, dot);
  let fracPart = dot === -1 ? "" : rest.slice(dot + 1);
  intPart = intPart.replace(/^0+(?=\d)/, "");
  fracPart = fracPart.replace(/0+$/, "");
  if (intPart === "" || /^[0]+$/.test(intPart)) intPart = "0";
  if (intPart === "0" && fracPart === "") negative = false;
  return `${negative ? "-" : ""}${intPart}${fracPart === "" ? "" : `.${fracPart}`}`;
}

function isValidDate(iso: string): boolean {
  const [y, m, d] = iso.split("-").map(Number);
  if ((y as number) < 1 || (y as number) > 9999 || (m as number) < 1 || (m as number) > 12 || (d as number) < 1 || (d as number) > 31) {
    return false;
  }
  // Date.UTC remaps years 0–99 to 1900–1999. Set the full year and
  // calendar fields together so low years retain their own leap rules.
  const dt = new Date(0);
  dt.setUTCFullYear(y as number, (m as number) - 1, d as number);
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === (m as number) - 1 && dt.getUTCDate() === d
  );
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d+))?$/;

function isValidInstant(iso: string): boolean {
  // Validate the calendar date and wall time explicitly: Date.parse rolls
  // over out-of-range fields (Feb 30 becomes Mar 2). Leap second :60 is
  // rejected: it is unrepresentable in JS Date and outside canonical instants.
  if (!isValidDate(iso.slice(0, 10))) {
    return false;
  }
  const time = iso.slice(11, -1);
  if (!TIME_RE.test(time)) {
    return false;
  }
  return Number.isFinite(Date.parse(iso));
}

/** Descriptor carriers also serve Values' existing inline-enum formatter. */
function declarationKind(name: string, type: string): ScalarOperand["kind"] {
  if (typeof type === "string" && type.startsWith("enum(")) {
    try {
      const declared = parseTypeId(type);
      if (declared.base.kind === "enum" && !declared.array && !declared.nullable) return "enum";
    } catch (error) {
      if (!(error instanceof ValueError)) throw error;
    }
    return fail(name, `unsupported message parameter type ${type}`);
  }
  return operandKind(name, type);
}

/** Preserve UI's existing value-admission mapping at the formatting sink. */
function operandKind(name: string, type: string): ScalarOperand["kind"] {
  if (STRING_LIKE.has(type)) return "string";
  switch (type) {
    case "bool": case "int": case "decimal": case "money": case "date": case "datetime":
      return type;
    default:
      if (isEnumTypeId(type)) return "enum";
      return fail(name, `unsupported message parameter type ${type}`);
  }
}

function toOperand(name: string, param: MessageParamValue): ScalarOperand {
  const { type, value } = param;
  switch (operandKind(name, type)) {
    case "string":
      if (typeof value !== "string") fail(name, `type ${type} needs a string value`);
      return { kind: "string", value: value as string };
    case "bool":
      if (typeof value !== "boolean") fail(name, "type bool needs a boolean value");
      return { kind: "bool", value: value as boolean };
    case "int": {
      if (typeof value === "bigint") return { kind: "int", value };
      if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) fail(name, "int number value must be a safe integer");
        return { kind: "int", value: BigInt(value) };
      }
      if (typeof value === "string" && INT_RE.test(value)) {
        return { kind: "int", value: BigInt(value) };
      }
      return fail(name, "type int needs a bigint, safe number or canonical int string");
    }
    case "decimal": {
      const operand = isDecimal(value) ? encodeValue(type, value) : value;
      if (typeof operand === "bigint") return { kind: "decimal", text: operand.toString(10) };
      if (typeof operand === "string" && DECIMAL_RE.test(operand)) {
        return { kind: "decimal", text: decimalKey(operand) };
      }
      // Plain numbers are rejected: binary floating point cannot carry exact decimals.
      return fail(name, "type decimal needs a bigint or canonical decimal string");
    }
    case "money": {
      if (value === null || typeof value !== "object") fail(name, "type money needs {minor,currency}");
      const money = value as Partial<MoneyValue>;
      let minor: bigint;
      if (typeof money.minor === "bigint") minor = money.minor;
      else if (typeof money.minor === "string" && INT_RE.test(money.minor)) minor = BigInt(money.minor);
      else fail(name, "money.minor must be a bigint or canonical int string");
      if (typeof money.currency !== "string" || !CURRENCY_RE.test(money.currency)) {
        fail(name, "money.currency must be a 3-letter ISO code");
      }
      return { kind: "money", minor: minor as bigint, currency: money.currency as string };
    }
    case "date": {
      const operand = isDateValue(value) ? encodeValue(type, value) : value;
      if (typeof operand !== "string" || !DATE_RE.test(operand) || !isValidDate(operand)) {
        fail(name, "type date needs a valid YYYY-MM-DD civil date");
      }
      return { kind: "date", iso: operand as string };
    }
    case "datetime": {
      // The public guard checks the native shape; the owning codec also
      // validates its supported range. Conversion stays at the display sink.
      const operand = isDatetime(value) ? encodeValue(type, value) : value;
      if (typeof operand !== "string" || !DATETIME_RE.test(operand) || !isValidInstant(operand)) {
        fail(name, "type datetime needs a canonical RFC3339 UTC instant");
      }
      return { kind: "datetime", iso: operand as string };
    }
    case "enum":
      // Qualified nominal enum identities (DESIGN §13, e.g.
      // "expense.Expense.status") arrive as dotted type ids. Non-string
      // values still fail closed below, so a mistyped record/array/object
      // can never be formatted as an enum case.
      if (typeof value !== "string") fail(name, `type ${type} needs a stable case name`);
      return { kind: "enum", value: value as string };
  }
}

// ---------------------------------------------------------------------------
// Shared syntax diagnostics; UI retains its ordinary Error boundary.
// ---------------------------------------------------------------------------

function patternError(pattern: string, offset: number, why: string): Error {
  return new Error(`message pattern error at offset ${offset}: ${why} in ${JSON.stringify(pattern)}`);
}

function syntaxError(pattern: string, diagnostic: MessageSyntaxDiagnostic): Error {
  const { kind, format, token } = diagnostic;
  const argumentStart = diagnostic.argumentStart ?? diagnostic.offset;
  let offset = diagnostic.offset;
  let why = diagnostic.message;
  switch (kind) {
    case "unmatched-close":
      why = "unmatched closing brace";
      break;
    case "unterminated-branch":
      why = "unterminated option, expected closing brace";
      break;
    case "expected-name":
      offset = argumentStart;
      why = "empty argument name";
      break;
    case "expected-comma":
      why = "expected comma or closing brace";
      break;
    case "expected-type":
    case "unsupported-type":
      if (pattern[diagnostic.offset] === "}") {
        offset = argumentStart;
        why = `format ${token ?? ""} needs a style or options`;
      } else if (pattern[diagnostic.offset] === ",") {
        offset = argumentStart;
        why = `unsupported format ${token ?? ""}`;
      } else {
        why = "expected comma or closing brace";
      }
      break;
    case "missing-branches":
      offset = argumentStart;
      why = `format ${format} needs a style or options`;
      break;
    case "expected-style":
    case "unsupported-style":
      offset = argumentStart;
      // Explicit empty styles are newly refused by the approved grammar.
      if (token !== undefined && token !== "") {
        why = pattern.slice(diagnostic.offset).trimStart().startsWith("}")
          ? `unsupported ${format} style ${token}`
          : `unexpected input in ${format} style`;
      } else if (!pattern.slice(diagnostic.offset).trimStart().startsWith("}")) {
        why = `unexpected input in ${format} style`;
      }
      break;
    case "expected-style-end":
      offset = argumentStart;
      why = `unexpected input in ${format} style`;
      break;
    case "unsupported-offset":
      why = "plural offsets are not supported";
      break;
    case "invalid-exact":
      why = "invalid exact numeric case";
      break;
    case "duplicate-selector":
      why = `duplicate option ${token}`;
      break;
    case "expected-selector":
      why = "empty option selector";
      break;
    case "expected-branch":
      why = `expected message for option ${token}`;
      break;
    case "expected-branch-end":
      why = "expected closing brace for option";
      break;
    case "missing-other":
      offset = argumentStart;
      why = `format ${format} requires an "other" option`;
      break;
    case "unterminated-options":
      offset = argumentStart;
      why = "unterminated option list";
      break;
  }
  return patternError(pattern, offset, why);
}

// ---------------------------------------------------------------------------
// Locale-aware exact number formatting
// ---------------------------------------------------------------------------

export interface LocaleSeparators {
  readonly group: string;
  readonly decimal: string;
}

export function localeSeparators(locale: string): LocaleSeparators {
  const parts = new Intl.NumberFormat(locale).formatToParts(1000.5);
  let group = ",";
  let decimal = ".";
  for (const part of parts) {
    if (part.type === "group") group = part.value;
    if (part.type === "decimal") decimal = part.value;
  }
  return { group, decimal };
}

export interface LocaleNumberSystem {
  readonly group: string;
  readonly decimal: string;
  /** Localized decimal digits 0-9 for the locale numbering system. */
  readonly digits: readonly string[];
  /** Rightmost group size; 0 disables grouping. */
  readonly primaryGroup: number;
  /** Repeating group size applied leftwards. */
  readonly secondaryGroup: number;
}

const numberSystemCache = new Map<string, LocaleNumberSystem>();

/**
 * Derive separators, digits and the grouping pattern from Intl probes, so
 * exact values keep locale grouping (hi-IN pairs) and numbering systems
 * (ar-EG digits) while digits themselves never pass through binary floats.
 */
export function localeNumberSystem(locale: string): LocaleNumberSystem {
  const cached = numberSystemCache.get(locale);
  if (cached !== undefined) {
    return cached;
  }
  const probe = new Intl.NumberFormat(locale);
  let group = ",";
  let decimal = ".";
  for (const part of probe.formatToParts(1000.5)) {
    if (part.type === "group") group = part.value;
    if (part.type === "decimal") decimal = part.value;
  }
  const ungrouped = new Intl.NumberFormat(locale, { useGrouping: false });
  const digits: string[] = [];
  for (let d = 0; d <= 9; d += 1) {
    digits.push(ungrouped.format(d));
  }
  let primaryGroup = 3;
  let secondaryGroup = 3;
  const runs: number[] = [];
  let current = 0;
  let seenGroup = false;
  for (const part of probe.formatToParts(123456789012345)) {
    if (part.type === "group") {
      seenGroup = true;
      runs.push(current);
      current = 0;
    } else if (part.type === "integer") {
      current += Array.from(part.value).length;
    }
  }
  runs.push(current);
  if (!seenGroup) {
    primaryGroup = 0;
  } else {
    const fromRight = runs.reverse();
    primaryGroup = fromRight[0] as number;
    secondaryGroup = (fromRight[1] as number | undefined) ?? primaryGroup;
    if (primaryGroup <= 0) primaryGroup = 3;
    if (secondaryGroup <= 0) secondaryGroup = primaryGroup;
  }
  const system: LocaleNumberSystem = { group, decimal, digits, primaryGroup, secondaryGroup };
  numberSystemCache.set(locale, system);
  return system;
}

function groupDigits(digits: string, system: LocaleNumberSystem): string {
  const primary = system.primaryGroup;
  if (primary <= 0 || digits.length <= primary) {
    return digits;
  }
  const step = system.secondaryGroup > 0 ? system.secondaryGroup : primary;
  const parts: string[] = [];
  let rest = digits;
  parts.unshift(rest.slice(-primary));
  rest = rest.slice(0, -primary);
  while (rest.length > step) {
    parts.unshift(rest.slice(-step));
    rest = rest.slice(0, -step);
  }
  if (rest !== "") {
    parts.unshift(rest);
  }
  return parts.join(system.group);
}

function localizeDigits(latin: string, system: LocaleNumberSystem): string {
  return latin.replace(/[0-9]/g, (d) => system.digits[Number(d)] as string);
}

export function formatIntExact(value: bigint, locale: string): string {
  const system = localeNumberSystem(locale);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString(10);
  // Pinned: ASCII hyphen-minus for negatives (ICU would use locale minus signs).
  return `${negative ? "-" : ""}${localizeDigits(groupDigits(digits, system), system)}`;
}

export function formatDecimalExact(text: string, locale: string): string {
  const system = localeNumberSystem(locale);
  const key = decimalKey(text);
  const negative = key.startsWith("-");
  const rest = negative ? key.slice(1) : key;
  const dot = rest.indexOf(".");
  const intPart = dot === -1 ? rest : rest.slice(0, dot);
  const fracPart = dot === -1 ? "" : rest.slice(dot + 1);
  const head = `${negative ? "-" : ""}${localizeDigits(groupDigits(intPart, system), system)}`;
  return fracPart === "" ? head : `${head}${system.decimal}${localizeDigits(fracPart, system)}`;
}

/**
 * CLDR category selection preserving 64-bit ints. Exact =N cases are matched
 * on canonical decimal strings before this runs. Safe-range values go to
 * Intl directly; larger integers map to a representative that preserves small
 * magnitudes exactly and modular behavior above 10^6 (all CLDR integer rules
 * test small magnitudes or moduli up to 10^6).
 */
export function selectPluralCategory(
  operand: IntOperand | DecimalOperand,
  locale: string,
  ordinal: boolean,
): string {
  const rules = new Intl.PluralRules(locale, ordinal ? { type: "ordinal" } : undefined);
  if (operand.kind === "int") {
    const abs = operand.value < 0n ? -operand.value : operand.value;
    if (abs <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return rules.select(Number(operand.value));
    }
    const mod = Number(abs % 1000000n);
    const sign = operand.value < 0n ? -1 : 1;
    return rules.select(sign * (1000000 + mod));
  }
  const digits = operand.text.replace(/[^0-9]/g, "");
  if (digits.length <= 15) {
    return rules.select(Number(operand.text));
  }
  throw new RangeError(
    "plural category selection for decimals beyond 15 significant digits needs lane 2 exact adapters",
  );
}

export interface MoneyFormatOptions {
  readonly minor: bigint;
  readonly currency: string;
  /** Minor-unit scale for the currency (lane 2 pinned table); never defaulted here. */
  readonly scale: number;
  readonly locale: string;
}

/** Exact currency formatting: locale pattern from Intl, digits kept exact. */
export function formatMoneyExact(options: MoneyFormatOptions): string {
  const { minor, currency, scale, locale } = options;
  if (!Number.isInteger(scale) || scale < 0 || scale > 9) {
    throw new RangeError(`invalid currency scale for ${currency}`);
  }
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const digits = abs.toString(10).padStart(scale + 1, "0");
  const intDigits = digits.slice(0, digits.length - scale);
  const fracDigits = scale === 0 ? "" : digits.slice(digits.length - scale);
  const system = localeNumberSystem(locale);
  const numeric = `${localizeDigits(groupDigits(intDigits, system), system)}${fracDigits === "" ? "" : `${system.decimal}${localizeDigits(fracDigits, system)}`}`;
  // Reuse the locale currency pattern by formatting a probe and swapping the
  // numeric run; Intl supplies symbol placement, spacing and sign handling.
  const probe = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  }).formatToParts(negative ? -1 : 1);
  return probe
    .map((part) => {
      switch (part.type) {
        case "integer":
        case "group":
        case "decimal":
        case "fraction":
          return part.type === "integer" ? numeric : "";
        default:
          return part.value;
      }
    })
    .join("");
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

export interface FormatOptions {
  readonly args?: MessageParams;
  /** Locale for inline patterns; descriptors resolve their own locale first. */
  readonly locale?: string;
  readonly preferredLocales?: readonly string[];
  readonly appDefaultLocale?: string;
  readonly sourceLocale?: string;
  /** Business/team timezone for datetimes; UTC without a team. */
  readonly timeZone?: string;
  /** Pinned minor-unit scales by currency (lane 2 table); required for money. */
  readonly currencyScales?: Record<string, number>;
}

interface FormatState {
  readonly operands: Map<string, ScalarOperand>;
  readonly locale: string;
  readonly timeZone: string;
  readonly scales: Record<string, number> | undefined;
  /** Nearest-enclosing plural operand stack for `#`. */
  readonly pluralStack: Array<IntOperand | DecimalOperand>;
  readonly pattern: string;
}

export function formatMessage(
  pattern: string | MessageDescriptor,
  options: FormatOptions = {},
): string {
  return formatMessageResult(pattern, options).text;
}

export function formatMessageResult(
  pattern: string | MessageDescriptor,
  options: FormatOptions = {},
): ResolvedMessage {
  let text: string;
  let locale: string;
  // Explicit args win; otherwise a descriptor supplies its own bound params.
  let args = options.args;
  if (typeof pattern === "string") {
    text = pattern;
    locale = normalizeTag(options.locale ?? options.appDefaultLocale ?? "en");
  } else {
    if (pattern === null || typeof pattern !== "object") {
      throw new TypeError("pattern must be a string or message descriptor");
    }
    const resolveOptions: ResolveOptions = {
      preferredLocales: options.preferredLocales ?? [],
      appDefaultLocale: options.appDefaultLocale ?? "en",
    };
    const resolved = resolveMessage(
      pattern,
      options.sourceLocale === undefined
        ? resolveOptions
        : { ...resolveOptions, sourceLocale: options.sourceLocale },
    );
    text = resolved.text;
    locale = resolved.locale;
    args ??= pattern.params;
  }
  const bound = args ?? {};
  const operands = new Map<string, ScalarOperand>();
  for (const name of Object.keys(bound)) {
    const param = bound[name] as MessageParamValue;
    if (param === null || typeof param !== "object") {
      throw new TypeError(`message argument "${name}" must be {type, value}`);
    }
    operands.set(name, toOperand(name, param));
  }
  const lookup: UsageLookup = (name) => operands.get(name)?.kind;
  const nodes = typeof pattern === "string"
    ? checkedPattern(text, lookup)
    : checkedPatterns(pattern.source, pattern.variants, lookup).get(text) ?? checkedPattern(text, lookup);
  const state: FormatState = {
    operands,
    locale,
    timeZone: options.timeZone ?? "UTC",
    scales: options.currencyScales,
    pluralStack: [],
    pattern: text,
  };
  return Object.freeze({ text: renderNodes(nodes, state), locale });
}

type UsageLookup = (name: string) => ScalarOperand["kind"] | undefined;

function undeclaredArgument(name: string, pattern: string): Error {
  return new Error(`message pattern error: undeclared argument "${name}" in ${JSON.stringify(pattern)}`);
}

function checkedPattern(pattern: string, lookup?: UsageLookup): ParsedMessage {
  if (typeof pattern !== "string") throw new TypeError("message pattern must be a string");
  const parsed = parseMessageSyntax(pattern);
  if (!parsed.ok) throw syntaxError(pattern, parsed.diagnostic);
  if (lookup !== undefined) {
    for (const { name, usage } of messageUsages(parsed.nodes)) {
      const kind = lookup(name);
      if (kind === undefined) throw undeclaredArgument(name, pattern);
      checkUsage(name, kind, usage);
    }
  }
  return parsed.nodes;
}

/** Source first, then present variants in declaration order; reuse selected AST. */
function checkedPatterns(source: string, variants: MessageVariantMap, lookup?: UsageLookup): Map<string, ParsedMessage> {
  const parsed = new Map<string, ParsedMessage>();
  parsed.set(source, checkedPattern(source, lookup));
  for (const key of Object.keys(variants)) {
    const pattern = variants[key]!;
    if (pattern !== null && !parsed.has(pattern)) parsed.set(pattern, checkedPattern(pattern, lookup));
  }
  return parsed;
}

/** Type-only checks use UI's established rendering error messages and order. */
function checkUsage(name: string, kind: ScalarOperand["kind"], usage: MessageUsage): void {
  let why: string | undefined;
  switch (usage) {
    case "any": break;
    case "number": case "integer":
      if (kind !== "int" && kind !== "decimal") why = "number needs int or decimal";
      else if (usage === "integer" && kind !== "int") why = "number,integer needs int";
      break;
    case "date": case "time":
      if (usage === "time" && kind === "date") why = "date-only values have no time";
      else if (kind !== "date" && kind !== "datetime") why = `${usage} needs date or datetime`;
      break;
    case "cardinal":
      if (kind !== "int" && kind !== "decimal") why = "plural needs int or decimal";
      break;
    case "ordinal":
      if (kind !== "int") why = "selectordinal needs int";
      break;
    case "select":
      if (kind !== "string" && kind !== "bool" && kind !== "enum") why = "select needs text, bool or enum";
      break;
  }
  if (why !== undefined) throw new Error(`message argument "${name}": ${why}`);
}

function operandOf(state: FormatState, name: string): ScalarOperand {
  const operand = state.operands.get(name);
  if (operand === undefined) {
    throw undeclaredArgument(name, state.pattern);
  }
  return operand;
}

function renderNodes(nodes: ParsedMessage, state: FormatState): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      out += node.value;
    } else if (node.kind === "pound") {
      out += renderPound(state);
    } else {
      out += renderArgument(node, state);
    }
  }
  return out;
}

/** Render `#` using the nearest enclosing plural number and UI exact formatting. */
function renderPound(state: FormatState): string {
  const current = state.pluralStack[state.pluralStack.length - 1];
  if (current === undefined) return "#";
  return current.kind === "int"
    ? formatIntExact(current.value, state.locale)
    : formatDecimalExact(current.text, state.locale);
}

function renderArgument(
  node: Exclude<MessageNode, { kind: "text" | "pound" }>,
  state: FormatState,
): string {
  const operand = operandOf(state, node.name);
  switch (node.kind) {
    case "arg":
      return renderPlain(operand, state);
    case "number": {
      if (operand.kind !== "int" && operand.kind !== "decimal") {
        throw new Error(`message argument "${node.name}": number needs int or decimal`);
      }
      if (node.integerOnly) {
        if (operand.kind !== "int") {
          throw new Error(`message argument "${node.name}": number,integer needs int`);
        }
        return formatIntExact(operand.value, state.locale);
      }
      return operand.kind === "int"
        ? formatIntExact(operand.value, state.locale)
        : formatDecimalExact(operand.text, state.locale);
    }
    case "date":
    case "time": {
      if (node.kind === "time" && operand.kind === "date") {
        throw new Error(`message argument "${node.name}": date-only values have no time`);
      }
      if (operand.kind !== "date" && operand.kind !== "datetime") {
        throw new Error(`message argument "${node.name}": ${node.kind} needs date or datetime`);
      }
      if (operand.kind === "date") {
        // Civil dates never shift: format at UTC regardless of viewer zone.
        return new Intl.DateTimeFormat(state.locale, {
          dateStyle: node.style,
          timeZone: "UTC",
        }).format(new Date(`${operand.iso}T00:00:00Z`));
      }
      if (node.kind === "date") {
        return new Intl.DateTimeFormat(state.locale, {
          dateStyle: node.style,
          timeZone: state.timeZone,
        }).format(new Date(operand.iso));
      }
      return new Intl.DateTimeFormat(state.locale, {
        timeStyle: node.style,
        timeZone: state.timeZone,
      }).format(new Date(operand.iso));
    }
    case "plural": {
      if (node.ordinal && operand.kind !== "int") {
        throw new Error(`message argument "${node.name}": selectordinal needs int`);
      }
      if (operand.kind !== "int" && operand.kind !== "decimal") {
        throw new Error(`message argument "${node.name}": plural needs int or decimal`);
      }
      const key =
        operand.kind === "int" ? decimalKey(operand.value.toString(10)) : decimalKey(operand.text);
      const exact = node.branches.find((branch) => branch.selector === `=${key}`);
      // Category selection remains lazy: an exact branch must not invoke Intl
      // or impose UI's category-selection numeric limits on an exact operand.
      const category = exact === undefined
        ? selectPluralCategory(operand, state.locale, node.ordinal) : undefined;
      const match = exact ??
        node.branches.find((branch) => branch.selector === category) ??
        node.branches.find((branch) => branch.selector === "other");
      state.pluralStack.push(operand);
      try {
        return renderNodes(match!.nodes, state);
      } finally {
        state.pluralStack.pop();
      }
    }
    case "select": {
      let key: string;
      if (operand.kind === "string" || operand.kind === "enum") key = operand.value;
      else if (operand.kind === "bool") key = operand.value ? "true" : "false";
      else throw new Error(`message argument "${node.name}": select needs text, bool or enum`);
      const match =
        node.branches.find((branch) => branch.selector === key) ??
        node.branches.find((branch) => branch.selector === "other");
      return renderNodes(match!.nodes, state);
    }
  }
}

function renderPlain(operand: ScalarOperand, state: FormatState): string {
  return renderPlainOperand(operand, state.locale, state.timeZone, state.scales);
}

function renderPlainOperand(
  operand: ScalarOperand,
  locale: string,
  timeZone: string,
  scales: Record<string, number> | undefined,
): string {
  switch (operand.kind) {
    case "string":
    case "enum":
      return operand.value;
    case "bool":
      return operand.value ? "true" : "false";
    case "int":
      return formatIntExact(operand.value, locale);
    case "decimal":
      return formatDecimalExact(operand.text, locale);
    case "money": {
      const scale = scales?.[operand.currency];
      if (scale === undefined) {
        throw new Error(
          `money formatting needs currencyScales[${operand.currency}] from the pinned lane 2 table`,
        );
      }
      return formatMoneyExact({ minor: operand.minor, currency: operand.currency, scale, locale });
    }
    case "date":
      return new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeZone: "UTC",
      }).format(new Date(`${operand.iso}T00:00:00Z`));
    case "datetime":
      return new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "medium",
        timeZone,
      }).format(new Date(operand.iso));
  }
}

// ---------------------------------------------------------------------------
// Caption and cell formatting for renderers
// ---------------------------------------------------------------------------

/** Canonical preferred locales, skipping invalid tags. */
export function canonicalPreferredTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    try {
      out.push(normalizeTag(tag));
    } catch {
      // Skip invalid viewer preferences; resolution falls through.
    }
  }
  return out;
}

/** App default locale, falling back to "en" when invalid (dispatcher bug). */
export function canonicalDefaultTag(tag: string): string {
  try {
    return normalizeTag(tag);
  } catch {
    return "en";
  }
}

/** True for enum type ids: "enum", prefixed, or qualified dotted identities. */
export function isEnumTypeId(type: string): boolean {
  return (
    type === "enum" || type.startsWith("enum.") || type.startsWith("enum:") || type.includes(".")
  );
}

export interface CaptionContext {
  readonly preferredLocales: readonly string[];
  readonly appDefaultLocale: string;
  readonly currencyScales?: Record<string, number>;
}

/**
 * Resolve a caption slot: plain strings stay verbatim (literal braces are
 * text, not patterns); descriptors render through the formatter with bound
 * params. Caption datetimes use UTC: team-timezone rendering awaits a
 * PresentationContext timezone field (L6 join).
 */
export function resolveCaption(value: MessageValue, context: CaptionContext): string {
  if (typeof value === "string") {
    return value;
  }
  return formatMessage(value, {
    preferredLocales: canonicalPreferredTags(context.preferredLocales),
    appDefaultLocale: canonicalDefaultTag(context.appDefaultLocale),
    timeZone: "UTC",
    ...(context.currencyScales === undefined ? {} : { currencyScales: context.currencyScales }),
  });
}

export interface ScalarFormatOptions {
  readonly locale: string;
  readonly timeZone?: string;
  readonly currencyScales?: Record<string, number>;
}

/** Format one typed scalar (table cells, metrics) outside message patterns. */
export function formatScalar(param: MessageParamValue, options: ScalarFormatOptions): string {
  if (param === null || typeof param !== "object") {
    throw new TypeError("scalar param must be {type, value}");
  }
  const operand = toOperand("value", param);
  return renderPlainOperand(
    operand,
    normalizeTag(options.locale),
    options.timeZone ?? "UTC",
    options.currencyScales,
  );
}
