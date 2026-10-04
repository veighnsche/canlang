import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ValueError } from "../src/errors.js";
import {
  isTypeId,
  parseTypeId,
  printTypeBase,
  printTypeId,
  type NormalizedType,
} from "../src/types.js";

function assertInvalidTypeId(id: unknown, snippet: string): void {
  try {
    parseTypeId(id as string);
  } catch (err) {
    assert.ok(err instanceof ValueError, `expected ValueError for ${String(id)}, got ${String(err)}`);
    assert.equal(err.code, "invalid-construction");
    assert.ok(
      err.message.includes(snippet),
      `expected ${JSON.stringify(err.message)} to include ${JSON.stringify(snippet)}`,
    );
    if (typeof id === "string") {
      assert.match(err.message, /at index \d+/, "expected position info");
    }
    return;
  }
  assert.fail(`expected ValueError for ${String(id)}, but nothing was thrown`);
}

interface AstExpect {
  readonly kind: string;
  readonly detail: string;
  readonly array: boolean;
  readonly nullable: boolean;
  readonly requiredArray: boolean;
}

function summarize(ast: NormalizedType): AstExpect {
  const base = ast.base;
  let kind = "";
  let detail = "";
  switch (base.kind) {
    case "scalar":
    case "stringlike":
      kind = base.kind;
      detail = base.name;
      break;
    case "user":
    case "member":
    case "file":
    case "secret":
      kind = base.kind;
      detail = base.kind;
      break;
    case "action":
      kind = "action";
      detail = base.targets === null ? "*" : base.targets.join(",");
      break;
    case "invocation":
      kind = "invocation";
      detail = base.targets === null ? "*" : base.targets.join(",");
      break;
    case "json":
      kind = "json";
      detail = "json";
      break;
    case "delivery":
      kind = "delivery";
      detail = base.operation ?? "*";
      break;
    case "enum":
      kind = "enum";
      detail = base.cases.join(",");
      break;
    case "nominal":
      kind = "nominal";
      detail = base.path;
      break;
    case "union":
      kind = "union";
      detail = base.arms.join("|");
      break;
  }
  return { kind, detail, array: ast.array, nullable: ast.nullable, requiredArray: ast.requiredArray };
}

// [id, kind, detail, array, nullable, requiredArray]
const ACCEPT: ReadonlyArray<readonly [string, string, string, boolean, boolean, boolean]> = [
  ["int", "scalar", "int", false, false, false],
  ["decimal", "scalar", "decimal", false, false, false],
  ["money", "scalar", "money", false, false, false],
  ["date", "scalar", "date", false, false, false],
  ["datetime", "scalar", "datetime", false, false, false],
  ["duration", "scalar", "duration", false, false, false],
  ["text", "scalar", "text", false, false, false],
  ["bool", "scalar", "bool", false, false, false],
  ["email", "stringlike", "email", false, false, false],
  ["url", "stringlike", "url", false, false, false],
  ["locale", "stringlike", "locale", false, false, false],
  ["timezone", "stringlike", "timezone", false, false, false],
  ["currency", "stringlike", "currency", false, false, false],
  ["user", "user", "user", false, false, false],
  ["member", "member", "member", false, false, false],
  ["file", "file", "file", false, false, false],
  ["secret", "secret", "secret", false, false, false],
  ["action", "action", "*", false, false, false],
  ["delivery", "delivery", "*", false, false, false],
  ["invocation", "invocation", "*", false, false, false],
  ["json", "json", "json", false, false, false],
  ["message", "nominal", "message", false, false, false],
  ["enum", "nominal", "enum", false, false, false],
  ["Todo", "nominal", "Todo", false, false, false],
  ["pkg.Todo", "nominal", "pkg.Todo", false, false, false],
  ["Todo.title", "nominal", "Todo.title", false, false, false],
  ["a.b.c", "nominal", "a.b.c", false, false, false],
  ["_x", "nominal", "_x", false, false, false],
  ["action.log", "nominal", "action.log", false, false, false],
  ["A|B", "union", "A|B", false, false, false],
  ["A|B|C", "union", "A|B|C", false, false, false],
  ["pkg.A|B", "union", "pkg.A|B", false, false, false],
  ["user|Todo", "union", "user|Todo", false, false, false],
  ["member|file", "union", "member|file", false, false, false],
  ["action|Todo", "union", "action|Todo", false, false, false],
  ["delivery|Todo", "union", "delivery|Todo", false, false, false],
  ["invocation|Todo", "union", "invocation|Todo", false, false, false],
  ["json|Todo", "union", "json|Todo", false, false, false],
  ["message|json", "union", "message|json", false, false, false],
  ["Todo.title|Status", "union", "Todo.title|Status", false, false, false],
  ["int?", "scalar", "int", false, true, false],
  ["text[]", "scalar", "text", true, false, false],
  ["text[]?", "scalar", "text", true, true, false],
  ["text[]!", "scalar", "text", true, false, true],
  ["A|B?", "union", "A|B", false, true, false],
  ["A|B[]", "union", "A|B", true, false, false],
  ["A|B[]?", "union", "A|B", true, true, false],
  ["A|B[]!", "union", "A|B", true, false, true],
  ["Todo[]!", "nominal", "Todo", true, false, true],
  ["user[]?", "user", "user", true, true, false],
  ["enum(a)", "enum", "a", false, false, false],
  ["enum(a,b)", "enum", "a,b", false, false, false],
  ["enum(a,b,c)", "enum", "a,b,c", false, false, false],
  ["action(Op)", "action", "Op", false, false, false],
  ["action(A,B)", "action", "A,B", false, false, false],
  ["action(pkg.Op,Other)", "action", "pkg.Op,Other", false, false, false],
  ["invocation(Op)", "invocation", "Op", false, false, false],
  ["invocation(A,B)", "invocation", "A,B", false, false, false],
  ["invocation(pkg.Op,Other)", "invocation", "pkg.Op,Other", false, false, false],
  ["delivery(Op)", "delivery", "Op", false, false, false],
  ["delivery(pkg.Op)", "delivery", "pkg.Op", false, false, false],
  ["enum(a,b)?", "enum", "a,b", false, true, false],
  ["enum(a,b)[]", "enum", "a,b", true, false, false],
  ["enum(a,b)[]?", "enum", "a,b", true, true, false],
  ["enum(a,b)[]!", "enum", "a,b", true, false, true],
  ["action(A)?", "action", "A", false, true, false],
  ["action(A,B)[]", "action", "A,B", true, false, false],
  ["invocation(A)?", "invocation", "A", false, true, false],
  ["invocation(A,B)[]", "invocation", "A,B", true, false, false],
  ["invocation(A,B)[]?", "invocation", "A,B", true, true, false],
  ["json?", "json", "json", false, true, false],
  ["json[]", "json", "json", true, false, false],
  ["json[]?", "json", "json", true, true, false],
  ["delivery(Op)?", "delivery", "Op", false, true, false],
  ["delivery(Op)[]!", "delivery", "Op", true, false, true],
];

// [id, expected message snippet]
const REJECT: ReadonlyArray<readonly [string, string]> = [
  ["", "expected a type path"],
  ["text!", "`!` is only valid as `T[]!`"],
  ["Todo.X!", "`!` is only valid as `T[]!`"],
  ["text?!", "cannot combine with `?`"],
  ["text[]?!", "cannot combine with `?`"],
  ["text[]!!", "repeated `!` marker"],
  ["text!!", "`!` is only valid as `T[]!`"],
  ["!", "expected a type path"],
  ["int??", "redundant nullable suffix"],
  ["int[]??", "redundant nullable suffix"],
  ["A|B??", "redundant nullable suffix"],
  ["int?[]", "nullable-element spelling `T?[]`"],
  ["A|B?[]", "nullable-element spelling `T?[]`"],
  ["int[][]", "repeated array suffix"],
  ["int[]?[]", "repeated array suffix"],
  ["(A|B)", "grouped types are not supported"],
  ["(A)", "grouped types are not supported"],
  ["A|(B)", "grouped types are not supported"],
  ["int(A)", "grouped types are not supported"],
  ["int|text", "primitive `int` is not a union arm"],
  ["int|Todo", "primitive `int` is not a union arm"],
  ["A|bool", "primitive `bool` is not a union arm"],
  ["email|url", "primitive `email` is not a union arm"],
  ["secret|A", "primitive `secret` is not a union arm"],
  ["A|secret", "primitive `secret` is not a union arm"],
  ["A|enum(a)", "`enum(...)` cannot be a union arm"],
  ["enum(a)|B", "`enum(...)` cannot be a union arm"],
  ["A|action(Op)", "`action(...)` cannot be a union arm"],
  ["action(A)|B", "`action(...)` cannot be a union arm"],
  ["A|delivery(Op)", "`delivery(...)` cannot be a union arm"],
  ["A|invocation(Op)", "`invocation(...)` cannot be a union arm"],
  ["invocation(A)|B", "`invocation(...)` cannot be a union arm"],
  ["A|", "expected a type path after `|`"],
  ["|A", "expected a type path"],
  ["A||B", "expected a type path after `|`"],
  ["|", "expected a type path"],
  ["enum()", "expected enum case"],
  ["enum(a,a)", "duplicate enum case `a`"],
  ["enum(A.B)", 'expected ")" to close `enum(...)`'],
  ["enum(a b)", 'expected ")" to close `enum(...)`'],
  ["action()", "expected action target"],
  ["action(A,A)", "duplicate action target `A`"],
  ["invocation()", "expected invocation target"],
  ["invocation(A,A)", "duplicate invocation target `A`"],
  ["json(a)", "grouped types are not supported"],
  ["delivery()", "delivery() takes exactly one bound operation"],
  ["delivery(A,B)", "delivery() takes exactly one bound operation"],
  ["delivery(A,)", "delivery() takes exactly one bound operation"],
  ["enum(a", 'expected ")" to close `enum(...)`'],
  ["action(A", 'expected ")" to close `action(...)`'],
  ["invocation(A", 'expected ")" to close `invocation(...)`'],
  ["delivery(", "delivery() takes exactly one bound operation"],
  ["Todo.", "expected a name after `.`"],
  [".Todo", "expected a type path"],
  ["Todo..X", "expected a name after `.`"],
  ["9lives", "expected a type path"],
  ["int ", "unexpected trailing"],
  [" int", "expected a type path"],
  ["A |B", "unexpected trailing"],
  ["A| B", "expected a type path after `|`"],
  ["enum(a, b)", "expected enum case"],
  ["action( A)", "expected action target"],
  ["invocation( A)", "expected invocation target"],
  ["int[", "unexpected trailing"],
  ["int]", "unexpected trailing"],
  ["A|B[]x", "unexpected trailing"],
];

describe("types accept matrix", () => {
  for (const [id, kind, detail, array, nullable, requiredArray] of ACCEPT) {
    it(`accepts ${id}`, () => {
      const ast = parseTypeId(id);
      assert.deepEqual(summarize(ast), { kind, detail, array, nullable, requiredArray });
      assert.equal(printTypeId(ast), id);
      assert.ok(isTypeId(id));
    });
  }

  it("accepts a trailing comma inside enum()/action()/invocation() but prints without it", () => {
    assert.equal(printTypeId(parseTypeId("enum(a,b,)")), "enum(a,b)");
    assert.equal(printTypeId(parseTypeId("action(A,)")), "action(A)");
    assert.equal(printTypeId(parseTypeId("invocation(A,)")), "invocation(A)");
    assert.equal(printTypeId(parseTypeId("invocation(A,B,)")), "invocation(A,B)");
  });

  it("freezes ASTs and their lists", () => {
    const ast = parseTypeId("A|B[]?");
    assert.ok(Object.isFrozen(ast));
    assert.ok(Object.isFrozen(ast.base));
    if (ast.base.kind === "union") {
      assert.ok(Object.isFrozen(ast.base.arms));
    } else {
      assert.fail("expected a union base");
    }
    const cases = parseTypeId("enum(a,b)");
    if (cases.base.kind === "enum") {
      assert.ok(Object.isFrozen(cases.base.cases));
    } else {
      assert.fail("expected an enum base");
    }
    const targets = parseTypeId("action(A,B)");
    if (targets.base.kind === "action" && targets.base.targets !== null) {
      assert.ok(Object.isFrozen(targets.base.targets));
    } else {
      assert.fail("expected action targets");
    }
    const invocation = parseTypeId("invocation(A,B)");
    if (invocation.base.kind === "invocation" && invocation.base.targets !== null) {
      assert.ok(Object.isFrozen(invocation.base.targets));
    } else {
      assert.fail("expected invocation targets");
    }
  });
});

describe("types reject matrix", () => {
  for (const [id, snippet] of REJECT) {
    it(`rejects ${JSON.stringify(id)}`, () => {
      assertInvalidTypeId(id, snippet);
      assert.equal(isTypeId(id), false);
    });
  }

  it("rejects non-string inputs without position info", () => {
    for (const bad of [123, null, undefined, {}, [], 5n, true]) {
      assertInvalidTypeId(bad, "type id must be a string");
      assert.equal(isTypeId(bad), false);
    }
  });
});

describe("type printing helpers", () => {
  it("prints every base kind", () => {
    assert.equal(printTypeBase(parseTypeId("int").base), "int");
    assert.equal(printTypeBase(parseTypeId("locale").base), "locale");
    assert.equal(printTypeBase(parseTypeId("user").base), "user");
    assert.equal(printTypeBase(parseTypeId("action").base), "action");
    assert.equal(printTypeBase(parseTypeId("action(A,B)").base), "action(A,B)");
    assert.equal(printTypeBase(parseTypeId("invocation").base), "invocation");
    assert.equal(printTypeBase(parseTypeId("invocation(A,B)").base), "invocation(A,B)");
    assert.equal(printTypeBase(parseTypeId("json").base), "json");
    assert.equal(printTypeBase(parseTypeId("delivery").base), "delivery");
    assert.equal(printTypeBase(parseTypeId("delivery(Op)").base), "delivery(Op)");
    assert.equal(printTypeBase(parseTypeId("enum(a,b)").base), "enum(a,b)");
    assert.equal(printTypeBase(parseTypeId("pkg.Todo").base), "pkg.Todo");
    assert.equal(printTypeBase(parseTypeId("A|B").base), "A|B");
  });

  it("rejects invalid requiredArray flag combos", () => {
    const base = parseTypeId("int").base;
    assert.throws(
      () => printTypeId({ base, array: false, nullable: false, requiredArray: true }),
      ValueError,
    );
    assert.throws(
      () => printTypeId({ base, array: true, nullable: true, requiredArray: true }),
      ValueError,
    );
  });

  it("round-trips every valid flag combo including T[]!", () => {
    const base = parseTypeId("int").base;
    const combos: ReadonlyArray<readonly [boolean, boolean, boolean, string]> = [
      [false, false, false, "int"],
      [false, true, false, "int?"],
      [true, false, false, "int[]"],
      [true, true, false, "int[]?"],
      [true, false, true, "int[]!"],
    ];
    for (const [array, nullable, requiredArray, id] of combos) {
      assert.equal(printTypeId({ base, array, nullable, requiredArray }), id);
      assert.deepEqual(parseTypeId(id), { base, array, nullable, requiredArray });
    }
  });

  it("rejects malformed printer inputs", () => {
    for (const bad of [null, undefined, 5, "int", {}, { base: null }, { base: { kind: "nope" } }]) {
      assert.throws(() => printTypeId(bad as unknown as NormalizedType), ValueError);
    }
    assert.throws(() => printTypeBase(null as never), ValueError);
    assert.throws(() => printTypeBase({ kind: "nope" } as never), ValueError);
    assert.throws(
      () => printTypeId({ base: parseTypeId("int").base, array: "x", nullable: false, requiredArray: false } as never),
      ValueError,
    );
  });
});
