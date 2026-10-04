/**
 * Lane 02 type-id parsing: canonical `CanTypeId` strings to frozen ASTs.
 *
 * Normative: DESIGN.md L107-121 (value/type table), L139 (bounded suffix
 * grammar `A|B[]?`), L145-147 (action/delivery type shapes); GRAMMAR.md
 * L165-185 (`type`/`field_type` productions, union/call-form/suffix rules).
 *
 * Accepted grammar (strict canonical spellings; no whitespace anywhere):
 *   type-id = base ["[]"] ["?"]            // `?` after the base or `[]`
 *           | base "[]!"                   // `!` only after `[]`; field-only (GRAMMAR L183)
 *   base    = path {"|" path}              // unions of named paths
 *           | "enum" "(" NAME {"," NAME} [","] ")"
 *           | "action" "(" path {"," path} [","] ")"
 *           | "delivery" "(" path ")"
 *           | "invocation" "(" path {"," path} [","] ")"
 *           | "json"                        // bare only; no call form
 *   path    = NAME {"." NAME}              // NAME: letter/underscore + alphanumerics
 *
 * Classification: scalars (int/decimal/money/date/datetime/duration/text/
 * bool), validated string-likes (email/url/locale/timezone/currency),
 * user/member/file/secret refs, bare or call-form action/delivery/
 * invocation, bare json (opaque bounded JSON), inline enum(...), multi-arm
 * unions, and nominal paths (models, contracts, named enums, field-reuse
 * paths, message).
 *
 * Decisions recorded here (no normative text found):
 * - Bare `action`/`delivery`/`invocation` (no parens) are builtins with an
 *   unconstrained target/operation; bare `enum` is a nominal (an enum needs
 *   cases, while a model or named enum may be spelled `enum` — GRAMMAR L179
 *   does not ban these words as path components).
 * - Union arms must be named paths: builtin scalar, string-like and secret
 *   spellings are rejected as arms (GRAMMAR L179: primitive unions are not
 *   authorized). Bare user/member/file/action/delivery/invocation/message/
 *   json and any dotted path are accepted as arms; arm *resolution* is the
 *   checker's.
 * - Duplicate union arms are accepted (harmless); duplicate inline-enum
 *   cases and duplicate action/invocation targets are rejected
 *   (GRAMMAR L179: "Checking requires distinct values").
 * - Every failure throws ValueError `invalid-construction` and carries the
 *   0-based failure index; non-string input fails without an index.
 */

import { ValueError } from "./errors.js";

/** Scalar value-type names (DESIGN L107-121). */
export type ScalarName =
  | "int"
  | "decimal"
  | "money"
  | "date"
  | "datetime"
  | "duration"
  | "text"
  | "bool";

/** Validated string-like value-type names (DESIGN L109-112). */
export type StringLikeName = "email" | "url" | "locale" | "timezone" | "currency";

/**
 * The unsuffixed base of a type id. `action.targets === null` is bare
 * `action` (any canonical target); `delivery.operation === null` is bare
 * `delivery` (any bound operation); `invocation.targets === null` is bare
 * `invocation` (any canonical target). Union arms are bare path spellings.
 */
export type TypeBase =
  | { readonly kind: "scalar"; readonly name: ScalarName }
  | { readonly kind: "stringlike"; readonly name: StringLikeName }
  | { readonly kind: "user" }
  | { readonly kind: "member" }
  | { readonly kind: "file" }
  | { readonly kind: "secret" }
  | { readonly kind: "action"; readonly targets: readonly string[] | null }
  | { readonly kind: "delivery"; readonly operation: string | null }
  | { readonly kind: "invocation"; readonly targets: readonly string[] | null }
  | { readonly kind: "json" }
  | { readonly kind: "enum"; readonly cases: readonly string[] }
  | { readonly kind: "nominal"; readonly path: string }
  | { readonly kind: "union"; readonly arms: readonly string[] };

/**
 * Normalized type id: one base, at most one array suffix, at most one of
 * container nullability (`?`) or the field-only required-array creation
 * marker (`[]!`). Nullable elements and nested arrays are unrepresentable.
 */
export interface NormalizedType {
  readonly base: TypeBase;
  readonly array: boolean;
  readonly nullable: boolean;
  readonly requiredArray: boolean;
}

const SCALAR_NAMES: ReadonlySet<string> = new Set([
  "int",
  "decimal",
  "money",
  "date",
  "datetime",
  "duration",
  "text",
  "bool",
]);

const STRINGLIKE_NAMES: ReadonlySet<string> = new Set([
  "email",
  "url",
  "locale",
  "timezone",
  "currency",
]);

function isNameStart(ch: string | undefined): boolean {
  return ch !== undefined && (ch === "_" || (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z"));
}

function isNamePart(ch: string | undefined): boolean {
  return isNameStart(ch) || (ch !== undefined && ch >= "0" && ch <= "9");
}

function callFormOf(name: string): "enum" | "action" | "delivery" | "invocation" | null {
  if (name === "enum" || name === "action" || name === "delivery" || name === "invocation") return name;
  return null;
}

/** True for spellings that can never be union arms (GRAMMAR L179). */
function isPrimitiveArm(arm: string): boolean {
  return !arm.includes(".") && (SCALAR_NAMES.has(arm) || STRINGLIKE_NAMES.has(arm) || arm === "secret");
}

function classifyPath(path: string): TypeBase {
  if (!path.includes(".")) {
    if (SCALAR_NAMES.has(path)) return { kind: "scalar", name: path as ScalarName };
    if (STRINGLIKE_NAMES.has(path)) return { kind: "stringlike", name: path as StringLikeName };
    if (path === "user") return { kind: "user" };
    if (path === "member") return { kind: "member" };
    if (path === "file") return { kind: "file" };
    if (path === "secret") return { kind: "secret" };
    if (path === "action") return { kind: "action", targets: null };
    if (path === "delivery") return { kind: "delivery", operation: null };
    if (path === "invocation") return { kind: "invocation", targets: null };
    if (path === "json") return { kind: "json" };
  }
  return { kind: "nominal", path };
}

function freezeType(value: {
  readonly base: TypeBase;
  readonly array: boolean;
  readonly nullable: boolean;
  readonly requiredArray: boolean;
}): NormalizedType {
  return Object.freeze({
    base: Object.freeze(value.base),
    array: value.array,
    nullable: value.nullable,
    requiredArray: value.requiredArray,
  });
}

class TypeIdParser {
  private pos = 0;

  constructor(private readonly id: string) {}

  parse(): NormalizedType {
    const base = this.parseBase();
    const array = this.consumeArraySuffix();
    let nullable = false;
    let requiredArray = false;
    const mark = this.peek();
    if (mark === "?") {
      nullable = true;
      this.pos += 1;
      const after = this.peek();
      if (after === "?") {
        this.fail("redundant nullable suffix");
      }
      if (after === "[") {
        this.fail(
          array
            ? "repeated array suffix"
            : "nullable-element spelling `T?[]` is not supported; write `T[]?` for a nullable array",
        );
      }
      if (after === "!") {
        this.fail("`!` is only valid as `T[]!`; it cannot combine with `?`");
      }
    } else if (mark === "!") {
      if (!array) {
        this.fail("`!` is only valid as `T[]!` on a nonnullable array type");
      }
      requiredArray = true;
      this.pos += 1;
      const after = this.peek();
      if (after === "!") {
        this.fail("repeated `!` marker");
      }
      if (after === "?") {
        this.fail("`[]!` cannot combine with `?`");
      }
    }
    if (this.pos < this.id.length) {
      const ch = this.peek();
      if (ch === "(" || ch === ")") {
        this.fail("grouped types are not supported");
      }
      this.fail(`unexpected trailing ${JSON.stringify(this.id.slice(this.pos))}`);
    }
    return freezeType({ base, array, nullable, requiredArray });
  }

  private parseBase(): TypeBase {
    const ch = this.peek();
    if (ch === "(" || ch === ")") {
      this.fail("grouped types are not supported");
    }
    const start = this.pos;
    const name = this.readName("expected a type path");
    const call = callFormOf(name);
    if (call !== null && this.peek() === "(") {
      const base = this.parseCallForm(call);
      if (this.peek() === "|") {
        this.fail(`\`${call}(...)\` cannot be a union arm; union arms must be named paths`);
      }
      return base;
    }
    const arms: Array<{ readonly text: string; readonly start: number }> = [
      { text: this.readPathTail(name), start },
    ];
    while (this.peek() === "|") {
      this.pos += 1;
      const armStart = this.pos;
      const armName = this.readName("expected a type path after `|`");
      const armCall = callFormOf(armName);
      if (armCall !== null && this.peek() === "(") {
        this.fail(`\`${armCall}(...)\` cannot be a union arm; union arms must be named paths`, armStart);
      }
      arms.push({ text: this.readPathTail(armName), start: armStart });
    }
    if (arms.length === 1) {
      return classifyPath((arms[0] as { readonly text: string }).text);
    }
    for (const arm of arms) {
      if (isPrimitiveArm(arm.text)) {
        this.fail(`union arms must be named types; primitive \`${arm.text}\` is not a union arm`, arm.start);
      }
    }
    return { kind: "union", arms: Object.freeze(arms.map((arm) => arm.text)) };
  }

  private parseCallForm(form: "enum" | "action" | "delivery" | "invocation"): TypeBase {
    this.pos += 1;
    if (form === "enum") {
      const cases = this.parseNameList("enum case");
      this.expectClose(form);
      return { kind: "enum", cases: Object.freeze(cases) };
    }
    if (form === "action") {
      const targets = this.parsePathList("action target");
      this.expectClose(form);
      return { kind: "action", targets: Object.freeze(targets) };
    }
    if (form === "invocation") {
      const targets = this.parsePathList("invocation target");
      this.expectClose(form);
      return { kind: "invocation", targets: Object.freeze(targets) };
    }
    if (this.peek() === ")") {
      this.fail("delivery() takes exactly one bound operation (empty lists are invalid)");
    }
    const first = this.readName("delivery() takes exactly one bound operation");
    const operation = this.readPathTail(first);
    if (this.peek() === ",") {
      this.fail("delivery() takes exactly one bound operation");
    }
    this.expectClose(form);
    return { kind: "delivery", operation };
  }

  private parseNameList(what: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (;;) {
      if (this.peek() === ")") {
        if (out.length === 0) {
          this.fail(`expected ${what} (empty lists are invalid)`);
        }
        return out;
      }
      const name = this.readName(`expected ${what}`);
      if (seen.has(name)) {
        this.fail(`duplicate ${what} \`${name}\``, this.pos - name.length);
      }
      seen.add(name);
      out.push(name);
      if (this.peek() === ",") {
        this.pos += 1;
        continue;
      }
      return out;
    }
  }

  private parsePathList(what: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (;;) {
      if (this.peek() === ")") {
        if (out.length === 0) {
          this.fail(`expected ${what} (empty lists are invalid)`);
        }
        return out;
      }
      const start = this.pos;
      const first = this.readName(`expected ${what}`);
      const path = this.readPathTail(first);
      if (seen.has(path)) {
        this.fail(`duplicate ${what} \`${path}\``, start);
      }
      seen.add(path);
      out.push(path);
      if (this.peek() === ",") {
        this.pos += 1;
        continue;
      }
      return out;
    }
  }

  private expectClose(form: string): void {
    if (this.peek() !== ")") {
      this.fail(`expected ")" to close \`${form}(...)\``);
    }
    this.pos += 1;
  }

  private readPathTail(first: string): string {
    let path = first;
    while (this.peek() === ".") {
      this.pos += 1;
      path += `.${this.readName("expected a name after `.`")}`;
    }
    return path;
  }

  private readName(what: string): string {
    const start = this.pos;
    if (!isNameStart(this.peek())) {
      const ch = this.peek();
      if (ch === "(" || ch === ")") {
        this.fail("grouped types are not supported", start);
      }
      this.fail(what, start);
    }
    this.pos += 1;
    while (isNamePart(this.peek())) {
      this.pos += 1;
    }
    return this.id.slice(start, this.pos);
  }

  private consumeArraySuffix(): boolean {
    if (this.id[this.pos] === "[" && this.id[this.pos + 1] === "]") {
      this.pos += 2;
      if (this.id[this.pos] === "[" && this.id[this.pos + 1] === "]") {
        this.fail("repeated array suffix");
      }
      return true;
    }
    return false;
  }

  private peek(): string | undefined {
    return this.id[this.pos];
  }

  private fail(message: string, at?: number): never {
    const index = at ?? this.pos;
    throw new ValueError("invalid-construction", `invalid type id "${this.id}": ${message} at index ${index}`);
  }
}

/**
 * Parses a canonical type id to a frozen AST. Rejects grouped types,
 * repeated array suffixes, `T?[]` nullable-element spellings, redundant `?`,
 * `[]` on nullable/array spellings, and every `!` outside `T[]!`.
 */
export function parseTypeId(id: string): NormalizedType {
  if (typeof id !== "string") {
    throw new ValueError("invalid-construction", "type id must be a string");
  }
  if (id.length === 0) {
    throw new ValueError("invalid-construction", `invalid type id "": expected a type path at index 0`);
  }
  return new TypeIdParser(id).parse();
}

/** True exactly for strings that `parseTypeId` accepts. Never throws. */
export function isTypeId(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    parseTypeId(value);
    return true;
  } catch (err) {
    if (err instanceof ValueError) {
      return false;
    }
    throw err;
  }
}

function assertBase(base: unknown): asserts base is TypeBase {
  if (typeof base !== "object" || base === null) {
    throw new ValueError("invalid-construction", "printTypeBase needs a type base object");
  }
  const kind = (base as Record<string, unknown>)["kind"];
  switch (kind) {
    case "scalar":
    case "stringlike":
    case "user":
    case "member":
    case "file":
    case "secret":
    case "action":
    case "delivery":
    case "invocation":
    case "json":
    case "enum":
    case "nominal":
    case "union":
      return;
    default:
      throw new ValueError("invalid-construction", `printTypeBase: unknown base kind ${String(kind)}`);
  }
}

/** Canonical spelling of one unsuffixed base. */
export function printTypeBase(base: TypeBase): string {
  assertBase(base);
  switch (base.kind) {
    case "scalar":
    case "stringlike":
      return base.name;
    case "user":
    case "member":
    case "file":
    case "secret":
    case "json":
      return base.kind;
    case "action":
      return base.targets === null ? "action" : `action(${base.targets.join(",")})`;
    case "invocation":
      return base.targets === null ? "invocation" : `invocation(${base.targets.join(",")})`;
    case "delivery":
      return base.operation === null ? "delivery" : `delivery(${base.operation})`;
    case "enum":
      return `enum(${base.cases.join(",")})`;
    case "nominal":
      return base.path;
    case "union":
      return base.arms.join("|");
  }
}

/**
 * Canonical spelling of a normalized type. `printTypeId(parseTypeId(id))`
 * is the identity on canonical ids (a trailing comma inside `enum(...)` /
 * `action(...)` / `invocation(...)` is the only accepted non-canonical
 * spelling, dropped here).
 */
export function printTypeId(type: NormalizedType): string {
  if (typeof type !== "object" || type === null) {
    throw new ValueError("invalid-construction", "printTypeId needs a normalized type object");
  }
  assertBase(type.base);
  if (typeof type.array !== "boolean" || typeof type.nullable !== "boolean") {
    throw new ValueError("invalid-construction", "printTypeId needs boolean array/nullable flags");
  }
  if (typeof type.requiredArray !== "boolean") {
    throw new ValueError("invalid-construction", "printTypeId needs a boolean requiredArray flag");
  }
  if (type.requiredArray && (!type.array || type.nullable)) {
    throw new ValueError(
      "invalid-construction",
      "printTypeId: requiredArray needs array && !nullable (only `T[]!` is valid)",
    );
  }
  let out = printTypeBase(type.base);
  if (type.array) {
    out += "[]";
  }
  if (type.requiredArray) {
    out += "!";
  } else if (type.nullable) {
    out += "?";
  }
  return out;
}
