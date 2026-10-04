import type {
  DatetimeValue,
  DateValue,
  MoneyValue,
} from "../../contracts/src/values.js";
import { isDecimal, type Decimal } from "./decimal.js";
import { ValueError } from "./errors.js";
import { int64 } from "./int.js";
import { isDatetime, isDateValue, isMoney } from "./kinds.js";
import { currencyScale } from "./money.js";
import { DATETIME_MAX_MS, DATETIME_MIN_MS } from "./temporal.js";

/**
 * Bounded ICU MessageFormat profile (DESIGN L856-858): named `{name}`;
 * `{n,number}`/`{n,number,integer}`; `{d,date}`/`{d,time}` with short/medium/
 * long/full (default medium); nested plural/selectordinal/select with
 * mandatory `other`. Rejected as syntax errors: plural offsets, choice,
 * skeleton/custom styles, rich tags, custom functions, duplicate branches,
 * undeclared variables and incompatible argument/selector types. Argument
 * nesting deeper than 32 levels fails as a syntax error rather than
 * overflowing the call stack.
 *
 * Exactness: ints/decimals are never routed through Number for digit
 * rendering; exact `=N` plural cases compare by exact decimal value.
 * Digits render Latin with locale separators/minus/grouping (exactness-first, Rust-reproducible).
 *
 * Plural/selectordinal category selection routes through Intl.PluralRules,
 * which takes a Number operand (exact CLDR operands are infeasible through
 * that API), so selection fails closed as out-of-range instead of guessing
 * (DESIGN L893 anti-lossy rule). Ints are int64-narrowed at binding and
 * select exactly within the safe range; safe-range-exceeding ints and
 * decimals whose text does not round-trip Number exactly fail closed.
 */

// ---------------------------------------------------------------------------
// Parameters and descriptors
// ---------------------------------------------------------------------------

/** Scalar display types a message parameter may carry (DESIGN L819). */
export type MessageParamType =
  | "text"
  | "bool"
  | "enum"
  | "int"
  | "decimal"
  | "money"
  | "date"
  | "datetime";

const PARAM_TYPES: ReadonlySet<string> = new Set([
  "text",
  "bool",
  "enum",
  "int",
  "decimal",
  "money",
  "date",
  "datetime",
]);

export interface MessageParam {
  readonly type: MessageParamType;
  readonly value: string | boolean | bigint | Decimal | MoneyValue | DateValue | DatetimeValue;
}

/**
 * Immutable message descriptor: authored source plus explicit per-locale
 * variants (`null` = absent translation, distinct from empty text) and the
 * explicitly bound typed parameters shared by one signature across variants.
 */
export interface MessageDescriptor {
  readonly kind: "message";
  readonly source: string;
  readonly variants: Readonly<Record<string, string | null>>;
  readonly params?: Readonly<Record<string, MessageParam>>;
}

function canonicalTag(tag: unknown, what: string): string {
  if (typeof tag !== "string" || tag.length === 0) {
    throw new ValueError("invalid-construction", `${what} must be a non-empty BCP 47 tag`);
  }
  try {
    const canonical = Intl.getCanonicalLocales(tag);
    const first = canonical[0];
    if (first === undefined) {
      throw new ValueError("invalid-construction", `${what} is not a valid BCP 47 tag: ${tag}`);
    }
    return first;
  } catch (err) {
    if (err instanceof ValueError) throw err;
    throw new ValueError("invalid-construction", `${what} is not a valid BCP 47 tag: ${tag}`);
  }
}

function isParamShape(value: unknown): value is MessageParam {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record["type"] !== "string" || !PARAM_TYPES.has(record["type"])) return false;
  return "value" in record;
}

export function isMessageDescriptor(value: unknown): value is MessageDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record["kind"] !== "message") return false;
  if (typeof record["source"] !== "string") return false;
  const variants = record["variants"];
  if (typeof variants !== "object" || variants === null || Array.isArray(variants)) return false;
  for (const [key, entry] of Object.entries(variants)) {
    if (typeof key !== "string" || key.length === 0) return false;
    if (typeof entry !== "string" && entry !== null) return false;
  }
  const params = record["params"];
  if (params !== undefined) {
    if (typeof params !== "object" || params === null || Array.isArray(params)) return false;
    for (const entry of Object.values(params)) {
      if (!isParamShape(entry)) return false;
    }
  }
  return true;
}

function requireParam(name: string, param: unknown): MessageParam {
  if (!isParamShape(param)) {
    throw new ValueError("invalid-construction", `message param ${name} must be {type, value}`);
  }
  return param;
}

/**
 * Checked descriptor constructor. Canonicalizes variant tags (duplicates
 * after canonicalization fail), structurally validates the source and every
 * present variant pattern, and — when params are supplied — validates each
 * param shape and binds every placeholder across every variant.
 */
export function makeMessageDescriptor(
  source: string,
  variants: Readonly<Record<string, string | null>>,
  params?: Readonly<Record<string, MessageParam>>,
): MessageDescriptor {
  if (typeof source !== "string") {
    throw new ValueError("invalid-construction", "message source must be text");
  }
  if (typeof variants !== "object" || variants === null || Array.isArray(variants)) {
    throw new ValueError("invalid-construction", "message variants must be an object");
  }
  const canonical: Record<string, string | null> = {};
  for (const [tag, text] of Object.entries(variants)) {
    if (typeof text !== "string" && text !== null) {
      throw new ValueError("invalid-construction", `message variant ${tag} must be text or null`);
    }
    const key = canonicalTag(tag, "message variant tag");
    if (Object.hasOwn(canonical, key)) {
      throw new ValueError("invalid-construction", `duplicate canonical message variant tag: ${key}`);
    }
    canonical[key] = text;
  }
  let frozenParams: Record<string, MessageParam> | undefined;
  let declared: Record<string, MessageParamType> | undefined;
  if (params !== undefined) {
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      throw new ValueError("invalid-construction", "message params must be an object");
    }
    frozenParams = {};
    declared = {};
    for (const [name, param] of Object.entries(params)) {
      // `__proto__` would silently set the prototype instead of an own key
      // on the accumulators below; reject it like wire.ts decodeAction so
      // the param is never lost. Other dunder names are safe own keys.
      if (name === "__proto__") {
        throw new ValueError("invalid-construction", 'message param name "__proto__" is reserved');
      }
      const checked = requireParam(name, param);
      checkParamValue(name, checked);
      frozenParams[name] = Object.freeze({ type: checked.type, value: freezeParamValue(checked.value) });
      declared[name] = checked.type;
    }
  }
  validateMessagePattern(source, declared);
  for (const text of Object.values(canonical)) {
    if (text !== null) validateMessagePattern(text, declared);
  }
  const descriptor: MessageDescriptor =
    frozenParams === undefined
      ? { kind: "message", source, variants: Object.freeze({ ...canonical }) }
      : {
          kind: "message",
          source,
          variants: Object.freeze({ ...canonical }),
          params: Object.freeze({ ...frozenParams }),
        };
  return Object.freeze(descriptor);
}

function freezeParamValue(
  value: string | boolean | bigint | Decimal | MoneyValue | DateValue | DatetimeValue,
): string | boolean | bigint | Decimal | MoneyValue | DateValue | DatetimeValue {
  if (typeof value !== "object" || value === null) return value;
  // Maker-built values (Decimal, money/date/datetime) arrive frozen and keep
  // their identity/prototype; only ad-hoc shapes are copied before freezing.
  if (Object.isFrozen(value)) return value;
  return Object.freeze({ ...value });
}

// ---------------------------------------------------------------------------
// AST and parser
// ---------------------------------------------------------------------------

export type IcuDateTimeStyle = "short" | "medium" | "long" | "full";

/** Exact `=N` plural selector as an exact (coef, scale) decimal value. */
export interface IcuExactSelector {
  readonly coef: bigint;
  readonly scale: number;
}

export interface IcuBranch {
  readonly selector: string;
  readonly exact: IcuExactSelector | null;
  readonly nodes: ReadonlyArray<MessageNode>;
}

export type MessageNode =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "pound" }
  | { readonly kind: "arg"; readonly name: string }
  | { readonly kind: "number"; readonly name: string; readonly integerOnly: boolean }
  | { readonly kind: "date"; readonly name: string; readonly style: IcuDateTimeStyle }
  | { readonly kind: "time"; readonly name: string; readonly style: IcuDateTimeStyle }
  | {
      readonly kind: "plural";
      readonly name: string;
      readonly ordinal: boolean;
      readonly branches: ReadonlyArray<IcuBranch>;
    }
  | { readonly kind: "select"; readonly name: string; readonly branches: ReadonlyArray<IcuBranch> };

export type ParsedMessage = ReadonlyArray<MessageNode>;

const SIMPLE_TYPES: ReadonlySet<string> = new Set(["number", "date", "time"]);
const COMPLEX_TYPES: ReadonlySet<string> = new Set(["plural", "selectordinal", "select"]);
const PLURAL_CATEGORIES: ReadonlySet<string> = new Set(["zero", "one", "two", "few", "many", "other"]);
const DATE_TIME_STYLES: ReadonlySet<string> = new Set(["short", "medium", "long", "full"]);
const RICH_TAG_PATTERN = /^<\/?[A-Za-z][A-Za-z0-9_.:-]*(\s+[^<>]*)?\/?>/;
const ARG_NAME_PATTERN = /^[A-Za-z0-9_]+/;
const KEYWORD_PATTERN = /^[A-Za-z]+/;
const SELECTOR_WORD_PATTERN = /^[A-Za-z0-9_-]+/;
const EXACT_DIGITS_PATTERN = /^\d+(\.\d+)?/;

function failPattern(message: string): never {
  throw new ValueError("invalid-construction", `invalid message pattern: ${message}`);
}

/** Maximum nested-argument depth: pathological patterns fail instead of overflowing the call stack. */
const ICU_MAX_NESTING_DEPTH = 32;

function freezeNode(node: MessageNode): MessageNode {
  if (node.kind === "plural" || node.kind === "select") {
    const branches = node.branches.map((branch) =>
      Object.freeze({ ...branch, nodes: Object.freeze([...branch.nodes]) }),
    );
    return Object.freeze({ ...node, branches: Object.freeze(branches) });
  }
  return Object.freeze({ ...node });
}

class IcuParser {
  private pos = 0;
  private depth = 0;

  constructor(private readonly pattern: string) {}

  parseTop(): ParsedMessage {
    const nodes = this.parseNodes(false, false);
    this.skipWhiteSpace();
    if (this.pos < this.pattern.length) {
      failPattern("unmatched closing brace");
    }
    return Object.freeze(nodes.map(freezeNode));
  }

  private peek(): string | undefined {
    return this.pattern[this.pos];
  }

  private skipWhiteSpace(): void {
    while (this.pos < this.pattern.length && /\s/.test(this.pattern[this.pos] as string)) {
      this.pos += 1;
    }
  }

  private parseNodes(nested: boolean, inPlural: boolean): MessageNode[] {
    const nodes: MessageNode[] = [];
    let text = "";
    const flush = (): void => {
      if (text.length > 0) {
        nodes.push({ kind: "text", value: text });
        text = "";
      }
    };
    while (this.pos < this.pattern.length) {
      const ch = this.pattern[this.pos] as string;
      if (ch === "{") {
        flush();
        nodes.push(this.parseArgument(inPlural));
        continue;
      }
      if (ch === "}") {
        if (!nested) failPattern("unmatched closing brace");
        flush();
        return nodes;
      }
      if (ch === "#") {
        flush();
        this.pos += 1;
        nodes.push(inPlural ? { kind: "pound" } : { kind: "text", value: "#" });
        continue;
      }
      if (ch === "'") {
        text += this.parseApostrophe();
        continue;
      }
      if (ch === "<") {
        if (RICH_TAG_PATTERN.test(this.pattern.slice(this.pos))) {
          failPattern("rich-text tags are outside the bounded profile");
        }
        text += "<";
        this.pos += 1;
        continue;
      }
      text += ch;
      this.pos += 1;
    }
    if (nested) failPattern("unterminated branch message");
    flush();
    return nodes;
  }

  /** ICU apostrophe quoting: `''` is a literal apostrophe; `'{', `'}`, `'#'` quote. */
  private parseApostrophe(): string {
    this.pos += 1;
    const next = this.pattern[this.pos];
    if (next === "'") {
      this.pos += 1;
      return "'";
    }
    if (next === "{" || next === "}" || next === "#") {
      let out = "";
      for (;;) {
        if (this.pos >= this.pattern.length) failPattern("unterminated quoted literal");
        const ch = this.pattern[this.pos] as string;
        if (ch === "'") {
          if (this.pattern[this.pos + 1] === "'") {
            out += "'";
            this.pos += 2;
            continue;
          }
          this.pos += 1;
          return out;
        }
        out += ch;
        this.pos += 1;
      }
    }
    return "'";
  }

  private parseArgument(inPlural: boolean): MessageNode {
    this.depth += 1;
    if (this.depth > ICU_MAX_NESTING_DEPTH) {
      failPattern(`nesting exceeds the maximum depth of ${ICU_MAX_NESTING_DEPTH}`);
    }
    try {
      return this.parseArgumentInner(inPlural);
    } finally {
      this.depth -= 1;
    }
  }

  private parseArgumentInner(inPlural: boolean): MessageNode {
    this.pos += 1;
    this.skipWhiteSpace();
    const name = this.matchPattern(ARG_NAME_PATTERN);
    if (name === null) failPattern("expected an argument name after '{'");
    this.skipWhiteSpace();
    if (this.peek() === "}") {
      this.pos += 1;
      return { kind: "arg", name };
    }
    this.expectComma();
    this.skipWhiteSpace();
    const keyword = this.matchPattern(KEYWORD_PATTERN);
    if (keyword === null) failPattern(`expected an argument type after '${name},'`);
    if (!SIMPLE_TYPES.has(keyword) && !COMPLEX_TYPES.has(keyword)) {
      failPattern(`unsupported argument type '${keyword}': choice and custom formatters are rejected`);
    }
    this.skipWhiteSpace();
    if (this.peek() === "}") {
      this.pos += 1;
      return this.defaultTypedNode(keyword, name);
    }
    this.expectComma();
    this.skipWhiteSpace();
    if (keyword === "number") return this.parseNumberStyle(name);
    if (keyword === "date" || keyword === "time") return this.parseDateTimeStyle(keyword, name);
    return this.parseComplex(keyword, name, inPlural);
  }

  private defaultTypedNode(keyword: string, name: string): MessageNode {
    if (keyword === "number") return { kind: "number", name, integerOnly: false };
    if (keyword === "date") return { kind: "date", name, style: "medium" };
    if (keyword === "time") return { kind: "time", name, style: "medium" };
    failPattern(`'${keyword}' requires branches with a mandatory 'other'`);
  }

  private parseNumberStyle(name: string): MessageNode {
    const style = this.matchPattern(KEYWORD_PATTERN);
    if (style === null) failPattern("expected a number style after 'number,'");
    if (style !== "integer") {
      failPattern(`unsupported number style '${style}': skeletons and custom styles are rejected`);
    }
    this.skipWhiteSpace();
    this.expectChar("}", "expected '}' after number style");
    this.pos += 1;
    return { kind: "number", name, integerOnly: true };
  }

  private parseDateTimeStyle(keyword: "date" | "time", name: string): MessageNode {
    const style = this.matchPattern(KEYWORD_PATTERN);
    if (style === null) failPattern(`expected a ${keyword} style after '${keyword},'`);
    if (!DATE_TIME_STYLES.has(style)) {
      failPattern(`unsupported ${keyword} style '${style}': expected short/medium/long/full`);
    }
    this.skipWhiteSpace();
    this.expectChar("}", `expected '}' after ${keyword} style`);
    this.pos += 1;
    const resolved = style as IcuDateTimeStyle;
    return keyword === "date"
      ? { kind: "date", name, style: resolved }
      : { kind: "time", name, style: resolved };
  }

  private parseComplex(keyword: string, name: string, inPlural: boolean): MessageNode {
    if (keyword === "select") {
      const branches = this.parseSelectBranches(inPlural);
      this.expectChar("}", "expected '}' after select branches");
      this.pos += 1;
      return { kind: "select", name, branches };
    }
    const branches = this.parsePluralBranches();
    this.expectChar("}", "expected '}' after plural branches");
    this.pos += 1;
    return { kind: "plural", name, ordinal: keyword === "selectordinal", branches };
  }

  private parsePluralBranches(): IcuBranch[] {
    const branches: IcuBranch[] = [];
    const seen = new Set<string>();
    for (;;) {
      this.skipWhiteSpace();
      if (this.peek() === "}") {
        break;
      }
      let selector: string;
      let exact: IcuExactSelector | null = null;
      if (this.peek() === "=") {
        this.pos += 1;
        const digits = this.matchPattern(EXACT_DIGITS_PATTERN);
        if (digits === null) failPattern("expected digits after '=' in an exact plural selector");
        exact = Object.freeze(normalizeExact(digits));
        selector = `=${exactText(exact)}`;
      } else {
        const word = this.matchPattern(KEYWORD_PATTERN);
        if (word === null) failPattern("expected a plural branch selector");
        if (word === "offset") failPattern("plural offsets are outside the bounded profile");
        if (!PLURAL_CATEGORIES.has(word)) failPattern(`unknown plural selector '${word}'`);
        selector = word;
      }
      if (seen.has(selector)) failPattern(`duplicate plural branch '${selector}'`);
      seen.add(selector);
      this.skipWhiteSpace();
      this.expectChar("{", `expected '{' after plural selector '${selector}'`);
      this.pos += 1;
      const nodes = this.parseNodes(true, true);
      this.expectChar("}", `expected '}' after plural branch '${selector}'`);
      this.pos += 1;
      branches.push({ selector, exact, nodes });
    }
    if (!seen.has("other")) failPattern("plural requires a mandatory 'other' branch");
    return branches;
  }

  private parseSelectBranches(inPlural: boolean): IcuBranch[] {
    const branches: IcuBranch[] = [];
    const seen = new Set<string>();
    for (;;) {
      this.skipWhiteSpace();
      if (this.peek() === "}") {
        break;
      }
      if (this.peek() === "=") failPattern("exact selectors are only valid in plural");
      const selector = this.matchPattern(SELECTOR_WORD_PATTERN);
      if (selector === null) failPattern("expected a select branch selector");
      if (seen.has(selector)) failPattern(`duplicate select branch '${selector}'`);
      seen.add(selector);
      this.skipWhiteSpace();
      this.expectChar("{", `expected '{' after select selector '${selector}'`);
      this.pos += 1;
      const nodes = this.parseNodes(true, inPlural);
      this.expectChar("}", `expected '}' after select branch '${selector}'`);
      this.pos += 1;
      branches.push({ selector, exact: null, nodes });
    }
    if (!seen.has("other")) failPattern("select requires a mandatory 'other' branch");
    return branches;
  }

  private matchPattern(pattern: RegExp): string | null {
    const match = pattern.exec(this.pattern.slice(this.pos));
    if (match === null) return null;
    const text = match[0] as string;
    this.pos += text.length;
    return text;
  }

  private expectComma(): void {
    if (this.peek() !== ",") failPattern("expected ',' in argument");
    this.pos += 1;
  }

  private expectChar(ch: string, message: string): void {
    if (this.peek() !== ch) failPattern(message);
  }
}

function normalizeExact(digits: string): { coef: bigint; scale: number } {
  const dot = digits.indexOf(".");
  const intPart = (dot < 0 ? digits : digits.slice(0, dot)).replace(/^0+(?=\d)/, "");
  const fracRaw = dot < 0 ? "" : digits.slice(dot + 1);
  const frac = fracRaw.replace(/0+$/, "");
  const intDigits = intPart.length === 0 ? "0" : intPart;
  return { coef: BigInt(intDigits + frac), scale: frac.length };
}

function exactText(exact: IcuExactSelector): string {
  const digits = exact.coef.toString(10);
  if (exact.scale === 0) return digits;
  const padded = digits.padStart(exact.scale + 1, "0");
  return `${padded.slice(0, padded.length - exact.scale)}.${padded.slice(padded.length - exact.scale)}`;
}

/** Parses a bounded-profile ICU pattern into a frozen AST. Syntax errors fail. */
export function parseMessageFormat(pattern: string): ParsedMessage {
  if (typeof pattern !== "string") {
    throw new ValueError("invalid-construction", "message pattern must be text");
  }
  return new IcuParser(pattern).parseTop();
}

// ---------------------------------------------------------------------------
// Usage validation
// ---------------------------------------------------------------------------

type IcuUsage =
  | "any"
  | "number"
  | "integer"
  | "date"
  | "time"
  | "cardinal"
  | "ordinal"
  | "select";

interface IcuUsageSite {
  readonly name: string;
  readonly usage: IcuUsage;
}

function collectUsages(nodes: ReadonlyArray<MessageNode>, out: IcuUsageSite[]): void {
  for (const node of nodes) {
    if (node.kind === "arg") out.push({ name: node.name, usage: "any" });
    else if (node.kind === "number") out.push({ name: node.name, usage: node.integerOnly ? "integer" : "number" });
    else if (node.kind === "date") out.push({ name: node.name, usage: "date" });
    else if (node.kind === "time") out.push({ name: node.name, usage: "time" });
    else if (node.kind === "plural") {
      out.push({ name: node.name, usage: node.ordinal ? "ordinal" : "cardinal" });
      for (const branch of node.branches) collectUsages(branch.nodes, out);
    } else if (node.kind === "select") {
      out.push({ name: node.name, usage: "select" });
      for (const branch of node.branches) collectUsages(branch.nodes, out);
    }
  }
}

function usageLabel(usage: IcuUsage): string {
  if (usage === "cardinal") return "plural";
  if (usage === "ordinal") return "selectordinal";
  if (usage === "integer") return "number,integer";
  return usage;
}

function checkUsageCompatible(name: string, type: MessageParamType, usage: IcuUsage): void {
  const ok =
    usage === "any" ||
    ((usage === "number" || usage === "cardinal") && (type === "int" || type === "decimal")) ||
    ((usage === "integer" || usage === "ordinal") && type === "int") ||
    (usage === "date" && (type === "date" || type === "datetime")) ||
    (usage === "time" && type === "datetime") ||
    (usage === "select" && (type === "text" || type === "bool" || type === "enum"));
  if (!ok) {
    throw new ValueError(
      "invalid-construction",
      `message param ${name} has type ${type}, incompatible with ${usageLabel(usage)}`,
    );
  }
}

function checkUsagesBound(
  ast: ParsedMessage,
  lookup: (name: string) => MessageParamType | undefined,
): void {
  const sites: IcuUsageSite[] = [];
  collectUsages(ast, sites);
  for (const site of sites) {
    const type = lookup(site.name);
    if (type === undefined) {
      throw new ValueError(
        "invalid-construction",
        `message pattern uses undeclared variable {${site.name}}`,
      );
    }
    checkUsageCompatible(site.name, type, site.usage);
  }
}

/**
 * Validates a pattern: structural profile conformance always; when `declared`
 * is supplied, every placeholder must bind to a declared type-compatible
 * variable. Locale branches may use different arguments while sharing one
 * signature, so callers validate each variant against the same signature.
 */
export function validateMessagePattern(
  pattern: string,
  declared?: Readonly<Record<string, MessageParamType>>,
): void {
  const ast = parseMessageFormat(pattern);
  if (declared !== undefined) {
    checkUsagesBound(ast, (name) => declared[name]);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export interface RenderMessageOptions {
  /** Business/team zone for datetimes; UTC without a team (DESIGN L858). */
  readonly timeZone?: string;
}

type ResolvedNumber = { readonly coef: bigint; readonly scale: number };

interface ResolvedParam {
  readonly type: MessageParamType;
  readonly text: string | null;
  readonly bool: boolean | null;
  readonly number: ResolvedNumber | null;
  readonly money: MoneyValue | null;
  readonly date: DateValue | null;
  readonly datetime: DatetimeValue | null;
}

function checkParamValue(name: string, param: MessageParam): void {
  resolveParamValue(name, param);
}

function resolveParamValue(name: string, param: MessageParam): ResolvedParam {
  const empty: ResolvedParam = {
    type: param.type,
    text: null,
    bool: null,
    number: null,
    money: null,
    date: null,
    datetime: null,
  };
  const value: unknown = param.value;
  switch (param.type) {
    case "text":
    case "enum": {
      if (typeof value !== "string") {
        throw new ValueError("invalid-construction", `message param ${name} must be text`);
      }
      return { ...empty, text: value };
    }
    case "bool": {
      if (typeof value !== "boolean") {
        throw new ValueError("invalid-construction", `message param ${name} must be a bool`);
      }
      return { ...empty, bool: value };
    }
    case "int": {
      if (typeof value !== "bigint") {
        throw new ValueError("invalid-construction", `message param ${name} must be an int`);
      }
      return { ...empty, number: { coef: int64(value), scale: 0 } };
    }
    case "decimal": {
      if (!isDecimal(value)) {
        throw new ValueError("invalid-construction", `message param ${name} must be a decimal`);
      }
      return { ...empty, number: { coef: value.coef, scale: value.scale } };
    }
    case "money": {
      if (!isMoney(value)) {
        throw new ValueError("invalid-construction", `message param ${name} must be money`);
      }
      currencyScale(value.currency);
      return { ...empty, money: value };
    }
    case "date": {
      if (!isDateValue(value)) {
        throw new ValueError("invalid-construction", `message param ${name} must be a date`);
      }
      return { ...empty, date: value };
    }
    case "datetime": {
      if (!isDatetime(value)) {
        throw new ValueError("invalid-construction", `message param ${name} must be a datetime`);
      }
      if (value.ms < DATETIME_MIN_MS || value.ms > DATETIME_MAX_MS) {
        throw new ValueError("out-of-range", `message param ${name} datetime is outside years 0001-9999`);
      }
      return { ...empty, datetime: value };
    }
  }
}

interface RenderContext {
  readonly locale: string;
  readonly timeZone: string;
  readonly args: ReadonlyMap<string, ResolvedParam>;
  readonly symbols: NumberSymbols;
}

function requireArgs(args: Readonly<Record<string, MessageParam>>): asserts args is Readonly<
  Record<string, MessageParam>
> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new ValueError("invalid-construction", "message args must be an object");
  }
}

function resolveLocale(locale: string): string {
  if (typeof locale !== "string" || locale.length === 0) {
    throw new ValueError("invalid-construction", "message locale must be a non-empty tag");
  }
  try {
    void new Intl.PluralRules(locale);
    return locale;
  } catch {
    throw new ValueError("invalid-construction", `message locale is not usable: ${locale}`);
  }
}

function resolveTimeZone(locale: string, timeZone: string | undefined): string {
  const zone = timeZone ?? "UTC";
  if (typeof zone !== "string" || zone.length === 0) {
    throw new ValueError("invalid-construction", "message timeZone must be a non-empty zone");
  }
  try {
    void new Intl.DateTimeFormat(locale, { timeZone: zone });
    return zone;
  } catch {
    throw new ValueError("invalid-construction", `message timeZone is not usable: ${zone}`);
  }
}

/**
 * Renders one pattern with explicitly bound args under the SELECTED variant
 * locale: plural/format rules always use this locale, including on fallback.
 */
export function renderMessage(
  pattern: string,
  args: Readonly<Record<string, MessageParam>>,
  locale: string,
  options?: RenderMessageOptions,
): string {
  const ast = parseMessageFormat(pattern);
  requireArgs(args);
  const resolvedLocale = resolveLocale(locale);
  const timeZone = resolveTimeZone(resolvedLocale, options?.timeZone);
  const sites: IcuUsageSite[] = [];
  collectUsages(ast, sites);
  const resolved = new Map<string, ResolvedParam>();
  for (const site of sites) {
    if (resolved.has(site.name)) continue;
    if (!Object.hasOwn(args, site.name)) {
      throw new ValueError(
        "invalid-construction",
        `message pattern uses undeclared variable {${site.name}}`,
      );
    }
    const param = requireParam(site.name, args[site.name]);
    const value = resolveParamValue(site.name, param);
    checkUsageCompatible(site.name, value.type, site.usage);
    resolved.set(site.name, value);
  }
  for (const site of sites) {
    const value = resolved.get(site.name) as ResolvedParam;
    checkUsageCompatible(site.name, value.type, site.usage);
  }
  const ctx: RenderContext = {
    locale: resolvedLocale,
    timeZone,
    args: resolved,
    symbols: numberSymbols(resolvedLocale),
  };
  return renderNodes(ast, ctx, null);
}

function renderNodes(
  nodes: ReadonlyArray<MessageNode>,
  ctx: RenderContext,
  pound: ResolvedNumber | null,
): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out += node.value;
        break;
      case "pound":
        if (pound === null) {
          out += "#";
        } else {
          out += formatNumberValue(pound, ctx.symbols, false);
        }
        break;
      case "arg":
        out += renderPlainParam(node.name, ctx);
        break;
      case "number": {
        const param = ctx.args.get(node.name) as ResolvedParam;
        out += formatNumberValue(param.number as ResolvedNumber, ctx.symbols, node.integerOnly);
        break;
      }
      case "date":
        out += renderDateParam(node.name, node.style, ctx);
        break;
      case "time":
        out += renderTimeParam(node.name, node.style, ctx);
        break;
      case "plural": {
        const param = ctx.args.get(node.name) as ResolvedParam;
        const value = param.number as ResolvedNumber;
        const branch = selectPluralBranch(ctx.locale, node.ordinal, value, node.branches);
        out += renderNodes(branch.nodes, ctx, value);
        break;
      }
      case "select": {
        const branch = selectSelectBranch(node.name, ctx, node.branches);
        out += renderNodes(branch.nodes, ctx, pound);
        break;
      }
    }
  }
  return out;
}

function renderPlainParam(name: string, ctx: RenderContext): string {
  const param = ctx.args.get(name) as ResolvedParam;
  if (param.text !== null) return param.text;
  if (param.bool !== null) return param.bool ? "true" : "false";
  if (param.number !== null) return plainNumberText(param.number);
  if (param.money !== null) return renderMoneyText(param.money);
  if (param.date !== null) return dateText(param.date);
  const instant = param.datetime as DatetimeValue;
  return new Intl.DateTimeFormat(ctx.locale, {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: ctx.timeZone,
  }).format(new Date(Number(instant.ms)));
}

/** Plain `{name}` numbers render exact digits without grouping: like `{n,number}`, every stored scale digit is preserved. */
function plainNumberText(value: ResolvedNumber): string {
  if (value.scale === 0) return value.coef.toString(10);
  const neg = value.coef < 0n;
  const digits = (neg ? -value.coef : value.coef).toString(10).padStart(value.scale + 1, "0");
  const intPart = digits.slice(0, digits.length - value.scale).replace(/^0+(?=\d)/, "");
  const fracPart = digits.slice(digits.length - value.scale);
  const intDigits = intPart.length === 0 ? "0" : intPart;
  return neg ? `-${intDigits}.${fracPart}` : `${intDigits}.${fracPart}`;
}

function renderMoneyText(money: MoneyValue): string {
  const scale = currencyScale(money.currency);
  const neg = money.minor < 0n;
  const digits = (neg ? -money.minor : money.minor).toString(10);
  let amount: string;
  if (scale === 0) {
    amount = digits;
  } else {
    const padded = digits.padStart(scale + 1, "0");
    amount = `${padded.slice(0, padded.length - scale)}.${padded.slice(padded.length - scale)}`;
  }
  return `${neg ? "-" : ""}${amount} ${money.currency}`;
}

function dateText(date: DateValue): string {
  const year = String(date.year).padStart(4, "0");
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateValueToUtcMs(date: DateValue): number {
  const instant = new Date(0);
  instant.setUTCFullYear(date.year, date.month - 1, date.day);
  instant.setUTCHours(0, 0, 0, 0);
  return instant.getTime();
}

function renderDateParam(name: string, style: IcuDateTimeStyle, ctx: RenderContext): string {
  const param = ctx.args.get(name) as ResolvedParam;
  if (param.date !== null) {
    return new Intl.DateTimeFormat(ctx.locale, { dateStyle: style, timeZone: "UTC" }).format(
      dateValueToUtcMs(param.date),
    );
  }
  const instant = param.datetime as DatetimeValue;
  return new Intl.DateTimeFormat(ctx.locale, { dateStyle: style, timeZone: ctx.timeZone }).format(
    new Date(Number(instant.ms)),
  );
}

function renderTimeParam(name: string, style: IcuDateTimeStyle, ctx: RenderContext): string {
  const param = ctx.args.get(name) as ResolvedParam;
  const instant = param.datetime as DatetimeValue;
  return new Intl.DateTimeFormat(ctx.locale, { timeStyle: style, timeZone: ctx.timeZone }).format(
    new Date(Number(instant.ms)),
  );
}

function numbersEqual(a: ResolvedNumber, b: IcuExactSelector): boolean {
  const scaleDiff = a.scale - b.scale;
  if (scaleDiff === 0) return a.coef === b.coef;
  if (scaleDiff > 0) return a.coef === b.coef * 10n ** BigInt(scaleDiff);
  return a.coef * 10n ** BigInt(-scaleDiff) === b.coef;
}

function selectPluralBranch(
  locale: string,
  ordinal: boolean,
  value: ResolvedNumber,
  branches: ReadonlyArray<IcuBranch>,
): IcuBranch {
  for (const branch of branches) {
    if (branch.exact !== null && numbersEqual(value, branch.exact)) return branch;
  }
  const category = pluralCategory(locale, ordinal, value);
  for (const branch of branches) {
    if (branch.selector === category) return branch;
  }
  return branches.find((branch) => branch.selector === "other") as IcuBranch;
}

const MAX_SAFE_BIGINT: bigint = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT: bigint = BigInt(Number.MIN_SAFE_INTEGER);

function pluralOperand(value: ResolvedNumber): number {
  if (value.scale === 0) {
    if (value.coef > MAX_SAFE_BIGINT || value.coef < MIN_SAFE_BIGINT) {
      throw new ValueError(
        "out-of-range",
        "plural selection needs a safe-range int; this magnitude cannot select exactly",
      );
    }
    return Number(value.coef);
  }
  const neg = value.coef < 0n;
  const digits = (neg ? -value.coef : value.coef).toString(10).padStart(value.scale + 1, "0");
  const intDigits = digits.slice(0, digits.length - value.scale).replace(/^0+(?=\d)/, "");
  const fracDigits = digits.slice(digits.length - value.scale).replace(/0+$/, "");
  const intPart = intDigits.length === 0 ? "0" : intDigits;
  if (fracDigits.length === 0) {
    const integral = BigInt(intPart);
    if (integral > MAX_SAFE_BIGINT) {
      throw new ValueError(
        "out-of-range",
        "plural selection needs a safe-range int; this magnitude cannot select exactly",
      );
    }
    return neg ? -Number(integral) : Number(integral);
  }
  const text = `${neg ? "-" : ""}${intPart}.${fracDigits}`;
  const integral = BigInt(intPart);
  if (integral > MAX_SAFE_BIGINT) {
    throw new ValueError(
      "out-of-range",
      "plural selection needs a safe-range operand; this magnitude cannot select exactly",
    );
  }
  const candidate = Number(text);
  if (!Number.isFinite(candidate) || String(candidate) !== text) {
    throw new ValueError(
      "out-of-range",
      "plural selection cannot represent this decimal exactly; refusing to guess a category",
    );
  }
  return candidate;
}

function pluralCategory(locale: string, ordinal: boolean, value: ResolvedNumber): string {
  const rules = ordinal
    ? new Intl.PluralRules(locale, { type: "ordinal" })
    : new Intl.PluralRules(locale);
  return rules.select(pluralOperand(value));
}

function selectSelectBranch(
  name: string,
  ctx: RenderContext,
  branches: ReadonlyArray<IcuBranch>,
): IcuBranch {
  const param = ctx.args.get(name) as ResolvedParam;
  const key = param.text !== null ? param.text : ((param.bool as boolean) ? "true" : "false");
  for (const branch of branches) {
    if (branch.selector === key) return branch;
  }
  return branches.find((branch) => branch.selector === "other") as IcuBranch;
}

// ---------------------------------------------------------------------------
// Exact locale-aware number rendering (never Number-routed)
// ---------------------------------------------------------------------------

interface NumberSymbols {
  readonly group: string | null;
  readonly decimal: string;
  readonly minus: string;
  readonly firstGroup: number;
  readonly restGroup: number;
}

function numberSymbols(locale: string): NumberSymbols {
  const format = new Intl.NumberFormat(locale);
  let decimal = ".";
  for (const part of format.formatToParts(1.1)) {
    if (part.type === "decimal") decimal = part.value;
  }
  let minus = "-";
  for (const part of format.formatToParts(-1)) {
    if (part.type === "minusSign") minus = part.value;
  }
  const probe = format.formatToParts(123456789012345);
  let group: string | null = null;
  const runLengths: number[] = [];
  let run = 0;
  for (const part of probe) {
    if (part.type === "integer") {
      run += part.value.length;
    } else if (part.type === "group") {
      group = part.value;
      runLengths.push(run);
      run = 0;
    }
  }
  runLengths.push(run);
  if (group === null || runLengths.length < 2) {
    return { group: null, decimal, minus, firstGroup: 0, restGroup: 0 };
  }
  const fromRight = runLengths.reverse();
  const first = fromRight[0] as number;
  const rest = fromRight.length > 2 ? (fromRight[1] as number) : first;
  return { group, decimal, minus, firstGroup: first, restGroup: rest };
}

function groupIntegerDigits(digits: string, symbols: NumberSymbols): string {
  const separator = symbols.group;
  if (separator === null || digits.length <= symbols.firstGroup) return digits;
  let out = digits.slice(digits.length - symbols.firstGroup);
  let rest = digits.slice(0, digits.length - symbols.firstGroup);
  const step = symbols.restGroup > 0 ? symbols.restGroup : symbols.firstGroup;
  while (rest.length > 0) {
    if (rest.length <= step) {
      out = `${rest}${separator}${out}`;
      break;
    }
    out = `${rest.slice(rest.length - step)}${separator}${out}`;
    rest = rest.slice(0, rest.length - step);
  }
  return out;
}

function roundHalfEvenToInt(coef: bigint, scale: number): bigint {
  if (scale === 0) return coef;
  const divisor = 10n ** BigInt(scale);
  const neg = coef < 0n;
  const abs = neg ? -coef : coef;
  let quotient = abs / divisor;
  const remainder = abs % divisor;
  const doubled = remainder * 2n;
  if (doubled > divisor || (doubled === divisor && quotient % 2n !== 0n)) {
    quotient += 1n;
  }
  return neg ? -quotient : quotient;
}

/**
 * Locale number rendering (`{n,number}`, `integer` style, `#`): grouping and
 * decimal separators come from Intl parts; every digit is assembled from the
 * exact bigint/decimal value. `integer` style requires int (DESIGN L893);
 * the half-even rounding below is a defensive no-op for scale-0 values.
 */
function formatNumberValue(value: ResolvedNumber, symbols: NumberSymbols, integerOnly: boolean): string {
  if (integerOnly) {
    const rounded = roundHalfEvenToInt(value.coef, value.scale);
    const neg = rounded < 0n;
    const grouped = groupIntegerDigits((neg ? -rounded : rounded).toString(10), symbols);
    return neg ? `${symbols.minus}${grouped}` : grouped;
  }
  const neg = value.coef < 0n;
  const digits = (neg ? -value.coef : value.coef).toString(10).padStart(value.scale + 1, "0");
  const intDigits = digits.slice(0, digits.length - value.scale).replace(/^0+(?=\d)/, "");
  const intPart = intDigits.length === 0 ? "0" : intDigits;
  const grouped = groupIntegerDigits(intPart, symbols);
  const fracPart = value.scale === 0 ? "" : digits.slice(digits.length - value.scale);
  const text = fracPart.length === 0 ? grouped : `${grouped}${symbols.decimal}${fracPart}`;
  return neg ? `${symbols.minus}${text}` : text;
}

