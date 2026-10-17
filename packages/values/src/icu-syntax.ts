/** Shared bounded message grammar. Rendering, binding and public errors stay with callers. */

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

/** Stable syntax facts for caller-owned errors; offsets count UTF16 code units. */
export type MessageSyntaxKind =
  | "unmatched-close" | "unterminated-branch" | "unterminated-quote"
  | "rich-tag" | "nesting" | "expected-name" | "expected-type"
  | "unsupported-type" | "expected-comma" | "missing-branches"
  | "expected-style" | "unsupported-style" | "expected-style-end"
  | "expected-selector" | "unsupported-offset" | "unknown-category"
  | "invalid-exact" | "duplicate-selector" | "expected-branch"
  | "expected-branch-end" | "missing-other" | "exact-in-select"
  | "expected-complex-end" | "unterminated-options";

export interface MessageSyntaxDiagnostic {
  readonly kind: MessageSyntaxKind;
  readonly message: string;
  readonly offset: number;
  readonly argumentStart?: number;
  readonly format?: string;
  readonly token?: string;
}

export type MessageSyntaxResult =
  | { readonly ok: true; readonly nodes: ParsedMessage }
  | { readonly ok: false; readonly diagnostic: MessageSyntaxDiagnostic };

class SyntaxFailure extends Error {
  constructor(readonly diagnostic: MessageSyntaxDiagnostic) {
    super(diagnostic.message);
  }
}

const SIMPLE_TYPES: ReadonlySet<string> = new Set(["number", "date", "time"]);
const COMPLEX_TYPES: ReadonlySet<string> = new Set(["plural", "selectordinal", "select"]);
const PLURAL_CATEGORIES: ReadonlySet<string> = new Set(["zero", "one", "two", "few", "many", "other"]);
const DATE_TIME_STYLES: ReadonlySet<string> = new Set(["short", "medium", "long", "full"]);
const RICH_TAG_PATTERN = /^<\/?[A-Za-z][A-Za-z0-9_.:-]*(\s+[^<>]*)?\/?>/;
const ARG_NAME_PATTERN = /^[A-Za-z0-9_]+/;
const KEYWORD_PATTERN = /^[A-Za-z]+/;
const SELECTOR_WORD_PATTERN = /^[A-Za-z0-9_-]+/;
const EXACT_DIGITS_PATTERN = /^\d+(\.\d+)?/;
const TOKEN_PATTERN = /^[^\s{},]*/;

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
  private readonly arguments: Array<{ start: number; format?: string }> = [];

  constructor(private readonly pattern: string) {}

  parseTop(): ParsedMessage {
    const nodes = this.parseNodes(false, false);
    this.skipWhiteSpace();
    if (this.pos < this.pattern.length) {
      this.fail("unmatched-close", "unmatched closing brace");
    }
    return Object.freeze(nodes.map(freezeNode));
  }

  private peek(): string | undefined {
    return this.pattern[this.pos];
  }

  private fail(kind: MessageSyntaxKind, message: string, offset = this.pos, token?: string): never {
    const argument = this.arguments.at(-1);
    throw new SyntaxFailure({
      kind, message, offset,
      ...(argument === undefined ? {} : { argumentStart: argument.start }),
      ...(argument?.format === undefined ? {} : { format: argument.format }),
      ...(token === undefined ? {} : { token }),
    });
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
        if (!nested) this.fail("unmatched-close", "unmatched closing brace");
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
          this.fail("rich-tag", "rich-text tags are outside the bounded profile");
        }
        text += "<";
        this.pos += 1;
        continue;
      }
      text += ch;
      this.pos += 1;
    }
    if (nested) this.fail("unterminated-branch", "unterminated branch message");
    flush();
    return nodes;
  }

  /** ICU apostrophe quoting: `''` is a literal apostrophe; `'{', `'}`, `'#'` quote. */
  private parseApostrophe(): string {
    this.pos += 1;
    const quotedStart = this.pos;
    const next = this.pattern[this.pos];
    if (next === "'") {
      this.pos += 1;
      return "'";
    }
    if (next === "{" || next === "}" || next === "#") {
      let out = "";
      for (;;) {
        if (this.pos >= this.pattern.length) this.fail("unterminated-quote", "unterminated quoted literal", quotedStart);
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
    this.arguments.push({ start: this.pos });
    this.depth += 1;
    if (this.depth > ICU_MAX_NESTING_DEPTH) {
      this.fail("nesting", `nesting exceeds the maximum depth of ${ICU_MAX_NESTING_DEPTH}`);
    }
    try {
      return this.parseArgumentInner(inPlural);
    } finally {
      this.depth -= 1;
      this.arguments.pop();
    }
  }

  private parseArgumentInner(inPlural: boolean): MessageNode {
    this.pos += 1;
    this.skipWhiteSpace();
    const name = this.matchPattern(ARG_NAME_PATTERN);
    if (name === null) this.fail("expected-name", "expected an argument name after '{'");
    this.skipWhiteSpace();
    if (this.peek() === "}") {
      this.pos += 1;
      return { kind: "arg", name };
    }
    this.expectComma();
    this.skipWhiteSpace();
    const formatStart = this.pos;
    const keyword = this.matchPattern(KEYWORD_PATTERN);
    if (keyword === null) this.failFormat("expected-type", `expected an argument type after '${name},'`, formatStart);
    const argument = this.arguments.at(-1);
    if (argument !== undefined) argument.format = keyword;
    this.skipWhiteSpace();
    if (!SIMPLE_TYPES.has(keyword) && !COMPLEX_TYPES.has(keyword)) {
      this.failFormat("unsupported-type", `unsupported argument type '${keyword}': choice and custom formatters are rejected`, formatStart);
    }
    if ((TOKEN_PATTERN.exec(this.pattern.slice(formatStart))?.[0].length ?? 0) > keyword.length) {
      // The grammar still refuses at the original delimiter checkpoint;
      // expose the whole invalid token for caller-owned diagnostic locations.
      this.failFormat("unsupported-type", "expected ',' in argument", formatStart);
    }
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
    this.fail("missing-branches", `'${keyword}' requires branches with a mandatory 'other'`);
  }

  private parseNumberStyle(name: string): MessageNode {
    const style = this.matchPattern(KEYWORD_PATTERN);
    if (style === null) this.failStyle("expected-style", "expected a number style after 'number,'");
    if (style !== "integer") {
      this.failStyle("unsupported-style", `unsupported number style '${style}': skeletons and custom styles are rejected`, style);
    }
    if ((TOKEN_PATTERN.exec(this.pattern.slice(this.pos))?.[0].length ?? 0) > 0) {
      this.failStyle("unsupported-style", "expected '}' after number style", style);
    }
    this.skipWhiteSpace();
    this.expectChar("}", "expected '}' after number style", "expected-style-end");
    this.pos += 1;
    return { kind: "number", name, integerOnly: true };
  }

  private parseDateTimeStyle(keyword: "date" | "time", name: string): MessageNode {
    const style = this.matchPattern(KEYWORD_PATTERN);
    if (style === null) this.failStyle("expected-style", `expected a ${keyword} style after '${keyword},'`);
    if (!DATE_TIME_STYLES.has(style)) {
      this.failStyle("unsupported-style", `unsupported ${keyword} style '${style}': expected short/medium/long/full`, style);
    }
    if ((TOKEN_PATTERN.exec(this.pattern.slice(this.pos))?.[0].length ?? 0) > 0) {
      this.failStyle("unsupported-style", `expected '}' after ${keyword} style`, style);
    }
    this.skipWhiteSpace();
    this.expectChar("}", `expected '}' after ${keyword} style`, "expected-style-end");
    this.pos += 1;
    const resolved = style as IcuDateTimeStyle;
    return keyword === "date"
      ? { kind: "date", name, style: resolved }
      : { kind: "time", name, style: resolved };
  }

  private parseComplex(keyword: string, name: string, inPlural: boolean): MessageNode {
    if (keyword === "select") {
      const branches = this.parseSelectBranches(inPlural);
      this.expectChar("}", "expected '}' after select branches", "expected-complex-end");
      this.pos += 1;
      return { kind: "select", name, branches };
    }
    const branches = this.parsePluralBranches();
    this.expectChar("}", "expected '}' after plural branches", "expected-complex-end");
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
      const selectorStart = this.pos;
      let invalidExactStart: number | undefined;
      if (this.peek() === "=") {
        this.pos += 1;
        const exactStart = this.pos;
        const digits = this.matchPattern(EXACT_DIGITS_PATTERN);
        if (digits === null) this.fail("invalid-exact", "expected digits after '=' in an exact plural selector", exactStart);
        exact = Object.freeze(normalizeExact(digits));
        selector = `=${exactText(exact)}`;
        // Keep Values' existing failure text while locating a bare decimal
        // point at the exact literal start for the UI diagnostic adapter.
        if (this.peek() === "." && !digits.includes(".")) invalidExactStart = exactStart;
      } else {
        const word = this.matchPattern(KEYWORD_PATTERN);
        if (word === null) this.fail(this.pos === this.pattern.length ? "unterminated-options" : "expected-selector", "expected a plural branch selector");
        if (word === "offset") this.fail("unsupported-offset", "plural offsets are outside the bounded profile", selectorStart);
        if (!PLURAL_CATEGORIES.has(word)) this.fail("unknown-category", `unknown plural selector '${word}'`, selectorStart, word);
        selector = word;
      }
      if (seen.has(selector)) this.fail(invalidExactStart === undefined ? "duplicate-selector" : "invalid-exact", `duplicate plural branch '${selector}'`, invalidExactStart ?? this.pos, selector);
      seen.add(selector);
      this.skipWhiteSpace();
      if (this.peek() !== "{") this.fail(invalidExactStart === undefined ? "expected-branch" : "invalid-exact", `expected '{' after plural selector '${selector}'`, invalidExactStart ?? this.pos, selector);
      this.pos += 1;
      const nodes = this.parseNodes(true, true);
      this.expectChar("}", `expected '}' after plural branch '${selector}'`, "expected-branch-end", selector);
      this.pos += 1;
      branches.push({ selector, exact, nodes });
    }
    if (!seen.has("other")) this.fail("missing-other", "plural requires a mandatory 'other' branch");
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
      if (this.peek() === "=") this.fail("exact-in-select", "exact selectors are only valid in plural");
      const selector = this.matchPattern(SELECTOR_WORD_PATTERN);
      if (selector === null) this.fail(this.pos === this.pattern.length ? "unterminated-options" : "expected-selector", "expected a select branch selector");
      if (seen.has(selector)) this.fail("duplicate-selector", `duplicate select branch '${selector}'`, this.pos, selector);
      seen.add(selector);
      this.skipWhiteSpace();
      this.expectChar("{", `expected '{' after select selector '${selector}'`, "expected-branch", selector);
      this.pos += 1;
      const nodes = this.parseNodes(true, inPlural);
      this.expectChar("}", `expected '}' after select branch '${selector}'`, "expected-branch-end", selector);
      this.pos += 1;
      branches.push({ selector, exact: null, nodes });
    }
    if (!seen.has("other")) this.fail("missing-other", "select requires a mandatory 'other' branch");
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
    if (this.peek() !== ",") this.fail("expected-comma", "expected ',' in argument");
    this.pos += 1;
  }

  private expectChar(ch: string, message: string, kind: MessageSyntaxKind, token?: string): void {
    if (this.peek() !== ch) this.fail(kind, message, this.pos, token);
  }

  private failStyle(kind: MessageSyntaxKind, message: string, prefix = ""): never {
    const tail = TOKEN_PATTERN.exec(this.pattern.slice(this.pos))?.[0] ?? "";
    this.fail(kind, message, this.pos + tail.length, prefix + tail);
  }

  private failFormat(kind: MessageSyntaxKind, message: string, start: number): never {
    const token = TOKEN_PATTERN.exec(this.pattern.slice(start))?.[0] ?? "";
    let end = start + token.length;
    while (end < this.pattern.length && /\s/.test(this.pattern[end] as string)) end += 1;
    this.fail(kind, message, end, token);
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

/** Parse once; callers project the syntax diagnostic into their existing error API. */
export function parseMessageSyntax(pattern: string): MessageSyntaxResult {
  try {
    return { ok: true, nodes: new IcuParser(pattern).parseTop() };
  } catch (error) {
    if (error instanceof SyntaxFailure) return { ok: false, diagnostic: error.diagnostic };
    throw error;
  }
}
