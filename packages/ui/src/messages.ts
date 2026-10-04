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
  type MessageVariantMap,
  type ResolvedMessage,
  type ThemeTokens,
} from "../../contracts/src/presentation.js";

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
 * BCP 47 tags without duplicates; `null` marks an absent translation.
 */
export const message: MessageFactory = (
  source: string,
  variants: MessageVariantMap = {},
  params?: MessageParams,
): MessageDescriptor => {
  if (typeof source !== "string") {
    throw new TypeError("message source must be a string");
  }
  if (variants === null || typeof variants !== "object" || Array.isArray(variants)) {
    throw new TypeError("message variants must be an object");
  }
  const checked: MessageVariantMap = {};
  for (const key of Object.keys(variants)) {
    const canonical = normalizeTag(key);
    if (Object.hasOwn(checked, canonical)) {
      throw new RangeError(`duplicate canonical locale variant: ${canonical}`);
    }
    const value = variants[key];
    if (typeof value !== "string" && value !== null) {
      throw new TypeError(`variant ${canonical} must be a string or null`);
    }
    checked[canonical] = value;
  }
  const descriptor: MessageDescriptor = { source, variants: checked };
  if (params !== undefined) {
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      throw new TypeError("message params must be an object");
    }
    return { ...descriptor, params: { ...params } };
  }
  return descriptor;
};

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
  const sourceLocale = normalizeTag(options.sourceLocale ?? "en");
  const available = Object.keys(descriptor.variants).filter(
    (tag) => descriptor.variants[tag] !== null,
  );
  for (const preferred of options.preferredLocales) {
    const request = normalizeTag(preferred);
    const match = lookupOne(available, request, appDefault);
    if (match !== null) {
      return { text: descriptor.variants[match] as string, locale: match };
    }
  }
  const fallback = lookupOne(available, appDefault, appDefault);
  if (fallback !== null) {
    return { text: descriptor.variants[fallback] as string, locale: fallback };
  }
  return { text: descriptor.source, locale: sourceLocale };
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
  if ((m as number) < 1 || (m as number) > 12 || (d as number) < 1 || (d as number) > 31) {
    return false;
  }
  const dt = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === (m as number) - 1 && dt.getUTCDate() === d
  );
}

function isValidInstant(iso: string): boolean {
  const ms = Date.parse(iso);
  return Number.isFinite(ms);
}

function toOperand(name: string, param: MessageParamValue): ScalarOperand {
  const { type, value } = param;
  if (STRING_LIKE.has(type)) {
    if (typeof value !== "string") fail(name, `type ${type} needs a string value`);
    return { kind: "string", value: value as string };
  }
  switch (type) {
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
      if (typeof value === "bigint") return { kind: "decimal", text: value.toString(10) };
      if (typeof value === "string" && DECIMAL_RE.test(value)) {
        return { kind: "decimal", text: decimalKey(value) };
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
    case "date":
      if (typeof value !== "string" || !DATE_RE.test(value) || !isValidDate(value)) {
        fail(name, "type date needs a valid YYYY-MM-DD civil date");
      }
      return { kind: "date", iso: value as string };
    case "datetime":
      if (typeof value !== "string" || !DATETIME_RE.test(value) || !isValidInstant(value)) {
        fail(name, "type datetime needs a canonical RFC3339 UTC instant");
      }
      return { kind: "datetime", iso: value as string };
    default:
      if (type === "enum" || type.startsWith("enum.") || type.startsWith("enum:")) {
        if (typeof value !== "string") fail(name, `type ${type} needs a stable case name`);
        return { kind: "enum", value: value as string };
      }
      return fail(name, `unsupported message parameter type ${type}`);
  }
}

// ---------------------------------------------------------------------------
// ICU-profile parser (bounded subset; offsets/choice/skeletons rejected)
// ---------------------------------------------------------------------------

type PatternNode =
  | { readonly kind: "text"; readonly value: string }
  | {
      readonly kind: "arg";
      readonly name: string;
      readonly format: "plain" | "number" | "date" | "time" | "plural" | "selectordinal" | "select";
      readonly style?: string;
      readonly options?: ReadonlyArray<{ readonly key: string; readonly nodes: PatternNode[] }>;
    };

function patternError(pattern: string, offset: number, why: string): Error {
  return new Error(`message pattern error at offset ${offset}: ${why} in ${JSON.stringify(pattern)}`);
}

class PatternParser {
  private pos = 0;
  constructor(private readonly pattern: string) {}

  parseTop(): PatternNode[] {
    const nodes = this.parseMessage(false);
    if (this.pos !== this.pattern.length) {
      throw patternError(this.pattern, this.pos, "unexpected trailing input");
    }
    return nodes;
  }

  private parseMessage(nested: boolean): PatternNode[] {
    const nodes: PatternNode[] = [];
    let text = "";
    const flush = () => {
      if (text !== "") {
        nodes.push({ kind: "text", value: text });
        text = "";
      }
    };
    while (this.pos < this.pattern.length) {
      const ch = this.pattern[this.pos] as string;
      if (ch === "'") {
        const next = this.pattern[this.pos + 1];
        if (next === "'") {
          text += "'";
          this.pos += 2;
        } else if (next === "{" || next === "}" || next === "#" || next === "|") {
          // Quoted literal: consume up to the closing apostrophe.
          this.pos += 1;
          const end = this.pattern.indexOf("'", this.pos);
          if (end === -1) {
            throw patternError(this.pattern, this.pos, "unterminated quoted literal");
          }
          text += this.pattern.slice(this.pos, end);
          this.pos = end + 1;
        } else {
          // Lone apostrophe before ordinary text stays literal (ICU lenient mode).
          text += "'";
          this.pos += 1;
        }
      } else if (ch === "{") {
        flush();
        nodes.push(this.parseArgument());
      } else if (ch === "}") {
        if (!nested) {
          throw patternError(this.pattern, this.pos, "unmatched closing brace");
        }
        flush();
        return nodes;
      } else {
        text += ch;
        this.pos += 1;
      }
    }
    if (nested) {
      throw patternError(this.pattern, this.pos, "unterminated option, expected closing brace");
    }
    flush();
    return nodes;
  }

  private parseArgument(): PatternNode {
    const start = this.pos;
    this.pos += 1; // consume {
    this.skipSpaces();
    const name = this.parseName();
    if (name === "") {
      throw patternError(this.pattern, start, "empty argument name");
    }
    this.skipSpaces();
    if (this.pattern[this.pos] === "}") {
      this.pos += 1;
      return { kind: "arg", name, format: "plain" };
    }
    if (this.pattern[this.pos] !== ",") {
      throw patternError(this.pattern, this.pos, "expected comma or closing brace");
    }
    this.pos += 1;
    this.skipSpaces();
    const format = this.parseName();
    this.skipSpaces();
    if (this.pattern[this.pos] === "}") {
      this.pos += 1;
      if (format === "number" || format === "date" || format === "time") {
        return { kind: "arg", name, format, style: "" };
      }
      throw patternError(this.pattern, start, `format ${format} needs a style or options`);
    }
    if (this.pattern[this.pos] !== ",") {
      throw patternError(this.pattern, this.pos, "expected comma or closing brace");
    }
    this.pos += 1;
    this.skipSpaces();
    if (format === "number" || format === "date" || format === "time") {
      const style = this.parseName();
      this.skipSpaces();
      if (this.pattern[this.pos] !== "}") {
        throw patternError(this.pattern, start, `unexpected input in ${format} style`);
      }
      this.pos += 1;
      if (format === "number" && style !== "" && style !== "integer") {
        throw patternError(this.pattern, start, `unsupported number style ${style}`);
      }
      if (
        (format === "date" || format === "time") &&
        style !== "" &&
        style !== "short" &&
        style !== "medium" &&
        style !== "long" &&
        style !== "full"
      ) {
        throw patternError(this.pattern, start, `unsupported ${format} style ${style}`);
      }
      return { kind: "arg", name, format, style };
    }
    if (format === "plural" || format === "selectordinal" || format === "select") {
      if (this.pattern.startsWith("offset:", this.pos)) {
        throw patternError(this.pattern, this.pos, "plural offsets are not supported");
      }
      const options: Array<{ key: string; nodes: PatternNode[] }> = [];
      const seen = new Set<string>();
      for (;;) {
        this.skipSpaces();
        if (this.pos >= this.pattern.length) {
          throw patternError(this.pattern, start, "unterminated option list");
        }
        if (this.pattern[this.pos] === "}") {
          this.pos += 1;
          break;
        }
        let key: string;
        if (
          (format === "plural" || format === "selectordinal") &&
          this.pattern[this.pos] === "="
        ) {
          this.pos += 1;
          const raw = this.parseExactNumber();
          key = `=${decimalKey(raw)}`;
        } else {
          key = this.parseName();
        }
        if (key === "") {
          throw patternError(this.pattern, this.pos, "empty option selector");
        }
        if (seen.has(key)) {
          throw patternError(this.pattern, this.pos, `duplicate option ${key}`);
        }
        seen.add(key);
        this.skipSpaces();
        if (this.pattern[this.pos] !== "{") {
          throw patternError(this.pattern, this.pos, `expected message for option ${key}`);
        }
        this.pos += 1;
        const nodes = this.parseMessage(true);
        if (this.pattern[this.pos] !== "}") {
          throw patternError(this.pattern, this.pos, "expected closing brace for option");
        }
        this.pos += 1;
        options.push({ key, nodes });
      }
      if (!seen.has("other")) {
        throw patternError(this.pattern, start, `format ${format} requires an "other" option`);
      }
      return { kind: "arg", name, format, options };
    }
    throw patternError(this.pattern, start, `unsupported format ${format}`);
  }

  private skipSpaces(): void {
    while (this.pos < this.pattern.length && this.pattern[this.pos] === " ") {
      this.pos += 1;
    }
  }

  private parseName(): string {
    const start = this.pos;
    while (this.pos < this.pattern.length) {
      const ch = this.pattern[this.pos] as string;
      if (ch === " " || ch === "," || ch === "{" || ch === "}") break;
      this.pos += 1;
    }
    return this.pattern.slice(start, this.pos);
  }

  private parseExactNumber(): string {
    const start = this.pos;
    if (this.pattern[this.pos] === "-" || this.pattern[this.pos] === "+") {
      this.pos += 1;
    }
    let digits = false;
    while (this.pos < this.pattern.length && /[0-9]/.test(this.pattern[this.pos] as string)) {
      digits = true;
      this.pos += 1;
    }
    if (this.pattern[this.pos] === ".") {
      this.pos += 1;
      while (this.pos < this.pattern.length && /[0-9]/.test(this.pattern[this.pos] as string)) {
        digits = true;
        this.pos += 1;
      }
    }
    const raw = this.pattern.slice(start, this.pos);
    if (!digits || !DECIMAL_RE.test(raw)) {
      throw patternError(this.pattern, start, "invalid exact numeric case");
    }
    return raw;
  }
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

function groupIntDigits(digits: string, sep: string): string {
  if (digits.length <= 3) return digits;
  const out: string[] = [];
  let count = 0;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    out.push(digits[i] as string);
    count += 1;
    if (count === 3 && i !== 0) {
      out.push(sep);
      count = 0;
    }
  }
  return out.reverse().join("");
}

export function formatIntExact(value: bigint, locale: string): string {
  const { group } = localeSeparators(locale);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString(10);
  return `${negative ? "-" : ""}${groupIntDigits(digits, group)}`;
}

export function formatDecimalExact(text: string, locale: string): string {
  const { group, decimal } = localeSeparators(locale);
  const key = decimalKey(text);
  const negative = key.startsWith("-");
  const rest = negative ? key.slice(1) : key;
  const dot = rest.indexOf(".");
  const intPart = dot === -1 ? rest : rest.slice(0, dot);
  const fracPart = dot === -1 ? "" : rest.slice(dot + 1);
  const head = `${negative ? "-" : ""}${groupIntDigits(intPart, group)}`;
  return fracPart === "" ? head : `${head}${decimal}${fracPart}`;
}

/** Round a canonical decimal to an integer (half-even, ICU integer style). */
function roundDecimalToInt(text: string): bigint {
  const key = decimalKey(text);
  const negative = key.startsWith("-");
  const rest = negative ? key.slice(1) : key;
  const dot = rest.indexOf(".");
  if (dot === -1) {
    const value = BigInt(rest);
    return negative ? -value : value;
  }
  const intPart = BigInt(rest.slice(0, dot));
  const frac = rest.slice(dot + 1);
  const first = frac.slice(0, 1);
  const remainder = frac.slice(1);
  let roundUp = false;
  if ((first as string) > "5") roundUp = true;
  else if ((first as string) < "5") roundUp = false;
  else if (/[1-9]/.test(remainder)) roundUp = true;
  else roundUp = intPart % 2n !== 0n;
  const rounded = roundUp ? intPart + 1n : intPart;
  return negative ? -rounded : rounded;
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
  const { group, decimal } = localeSeparators(locale);
  const numeric = `${groupIntDigits(intDigits, group)}${fracDigits === "" ? "" : `${decimal}${fracDigits}`}`;
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
  const nodes = new PatternParser(text).parseTop();
  const state: FormatState = {
    operands,
    locale,
    timeZone: options.timeZone ?? "UTC",
    scales: options.currencyScales,
    pluralStack: [],
    pattern: text,
  };
  return renderNodes(nodes, state);
}

function operandOf(state: FormatState, name: string, offset: string): ScalarOperand {
  const operand = state.operands.get(name);
  if (operand === undefined) {
    throw new Error(
      `message pattern error ${offset}: undeclared argument "${name}" in ${JSON.stringify(state.pattern)}`,
    );
  }
  return operand;
}

function renderNodes(nodes: readonly PatternNode[], state: FormatState): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      out += renderText(node.value, state);
    } else {
      out += renderArgument(node, state);
    }
  }
  return out;
}

/** Render literal text, expanding `#` to the nearest enclosing plural number. */
function renderText(value: string, state: FormatState): string {
  if (!value.includes("#")) return value;
  const current = state.pluralStack[state.pluralStack.length - 1];
  if (current === undefined) return value;
  const formatted =
    current.kind === "int"
      ? formatIntExact(current.value, state.locale)
      : formatDecimalExact(current.text, state.locale);
  return value.replace(/#/g, formatted);
}

function renderArgument(node: Extract<PatternNode, { kind: "arg" }>, state: FormatState): string {
  const operand = operandOf(state, node.name, `for argument "${node.name}"`);
  switch (node.format) {
    case "plain":
      return renderPlain(operand, state);
    case "number": {
      if (operand.kind !== "int" && operand.kind !== "decimal") {
        throw new Error(`message argument "${node.name}": number needs int or decimal`);
      }
      if (node.style === "integer") {
        const rounded =
          operand.kind === "int" ? operand.value : roundDecimalToInt(operand.text);
        return formatIntExact(rounded, state.locale);
      }
      return operand.kind === "int"
        ? formatIntExact(operand.value, state.locale)
        : formatDecimalExact(operand.text, state.locale);
    }
    case "date":
    case "time": {
      if (node.format === "time" && operand.kind === "date") {
        throw new Error(`message argument "${node.name}": date-only values have no time`);
      }
      if (operand.kind !== "date" && operand.kind !== "datetime") {
        throw new Error(`message argument "${node.name}": ${node.format} needs date or datetime`);
      }
      const style = (node.style === "" || node.style === undefined ? "medium" : node.style) as
        | "short"
        | "medium"
        | "long"
        | "full";
      if (operand.kind === "date") {
        // Civil dates never shift: format at UTC regardless of viewer zone.
        return new Intl.DateTimeFormat(state.locale, {
          dateStyle: style,
          timeZone: "UTC",
        }).format(new Date(`${operand.iso}T00:00:00Z`));
      }
      if (node.format === "date") {
        return new Intl.DateTimeFormat(state.locale, {
          dateStyle: style,
          timeZone: state.timeZone,
        }).format(new Date(operand.iso));
      }
      return new Intl.DateTimeFormat(state.locale, {
        timeStyle: style,
        timeZone: state.timeZone,
      }).format(new Date(operand.iso));
    }
    case "plural":
    case "selectordinal": {
      if (operand.kind !== "int" && operand.kind !== "decimal") {
        throw new Error(`message argument "${node.name}": plural needs int or decimal`);
      }
      const options = node.options as NonNullable<typeof node.options>;
      const key =
        operand.kind === "int" ? decimalKey(operand.value.toString(10)) : decimalKey(operand.text);
      const exact = options.find((option) => option.key === `=${key}`);
      if (exact !== undefined) {
        state.pluralStack.push(operand);
        try {
          return renderNodes(exact.nodes, state);
        } finally {
          state.pluralStack.pop();
        }
      }
      const category = selectPluralCategory(operand, state.locale, node.format === "selectordinal");
      const match =
        options.find((option) => option.key === category) ??
        (options.find((option) => option.key === "other") as { nodes: PatternNode[] });
      state.pluralStack.push(operand);
      try {
        return renderNodes(match.nodes, state);
      } finally {
        state.pluralStack.pop();
      }
    }
    case "select": {
      let key: string;
      if (operand.kind === "string" || operand.kind === "enum") key = operand.value;
      else if (operand.kind === "bool") key = operand.value ? "true" : "false";
      else throw new Error(`message argument "${node.name}": select needs text, bool or enum`);
      const options = node.options as NonNullable<typeof node.options>;
      const match =
        options.find((option) => option.key === key) ??
        (options.find((option) => option.key === "other") as { nodes: PatternNode[] });
      return renderNodes(match.nodes, state);
    }
  }
}

function renderPlain(operand: ScalarOperand, state: FormatState): string {
  switch (operand.kind) {
    case "string":
    case "enum":
      return operand.value;
    case "bool":
      return operand.value ? "true" : "false";
    case "int":
      return formatIntExact(operand.value, state.locale);
    case "decimal":
      return formatDecimalExact(operand.text, state.locale);
    case "money": {
      const scale = state.scales?.[operand.currency];
      if (scale === undefined) {
        throw new Error(
          `money formatting needs currencyScales[${operand.currency}] from the pinned lane 2 table`,
        );
      }
      return formatMoneyExact({ minor: operand.minor, currency: operand.currency, scale, locale: state.locale });
    }
    case "date":
      return new Intl.DateTimeFormat(state.locale, {
        dateStyle: "medium",
        timeZone: "UTC",
      }).format(new Date(`${operand.iso}T00:00:00Z`));
    case "datetime":
      return new Intl.DateTimeFormat(state.locale, {
        dateStyle: "medium",
        timeStyle: "medium",
        timeZone: state.timeZone,
      }).format(new Date(operand.iso));
  }
}
