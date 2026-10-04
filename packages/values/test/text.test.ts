import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Decimal } from "../src/decimal.js";
import { ValueError } from "../src/errors.js";
import { makeDate, makeDatetime, makeMoney } from "../src/kinds.js";
import {
  compareScalar,
  contains,
  formatPlain,
  join,
  lower,
  scalarChars,
  scalarLength,
  starts_with,
  trim,
  upper,
} from "../src/text.js";

function assertValueError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ValueError, `expected ValueError, got ${String(err)}`);
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected ValueError(${code}), but nothing was thrown`);
}

describe("lower/upper use full default Unicode case conversion", () => {
  it("lowercases ASCII", () => {
    assert.equal(lower("Hello WORLD"), "hello world");
  });

  it("lowercases U+0130 to i + combining dot (full default mapping)", () => {
    assert.equal(lower("İ"), "i̇");
    assert.equal(scalarLength(lower("İ")), 2n);
  });

  it("lowercases without locale tailoring (I -> i, not dotless ı)", () => {
    assert.equal(lower("I"), "i");
  });

  it("uppercases ASCII", () => {
    assert.equal(upper("Hello world"), "HELLO WORLD");
  });

  it("uppercases ß to SS (full default mapping)", () => {
    assert.equal(upper("straße"), "STRASSE");
  });

  it("keeps İ under upper", () => {
    assert.equal(upper("İ"), "İ");
  });

  it("rejects non-text input", () => {
    assertValueError(() => lower(1 as unknown as string), "invalid-construction");
    assertValueError(() => upper(null as unknown as string), "invalid-construction");
  });
});

describe("trim removes pinned White_Space at both ends", () => {
  it("trims ASCII whitespace", () => {
    assert.equal(trim("  \t\nhello \r\n "), "hello");
  });

  it("trims U+00A0 no-break space", () => {
    assert.equal(trim("\u00A0hello\u00A0"), "hello");
  });

  it("trims EM SPACE and vertical tab / form feed", () => {
    assert.equal(trim("\u2003\u000B\u000Chi\u000B\u000C\u2003"), "hi");
  });

  it("trims NEL U+0085", () => {
    assert.equal(trim("\u0085hi\u0085"), "hi");
  });

  it("trims thin and hair spaces", () => {
    assert.equal(trim("\u2009\u200Ahi\u200A\u2009"), "hi");
  });

  it("preserves interior whitespace", () => {
    assert.equal(trim("  a  b  "), "a  b");
  });

  it("preserves zero-width space (not White_Space)", () => {
    assert.equal(trim("\u200Bhi\u200B"), "\u200Bhi\u200B");
  });

  it("trims an all-whitespace value to empty", () => {
    assert.equal(trim("   "), "");
  });
});

describe("contains/starts_with are exact case-sensitive scalar matches", () => {
  it("contains finds exact substrings", () => {
    assert.equal(contains("hello world", "o w"), true);
    assert.equal(contains("hello", "z"), false);
  });

  it("contains is case-sensitive", () => {
    assert.equal(contains("Hello", "hello"), false);
  });

  it("contains matches astral needles", () => {
    assert.equal(contains("a𝄞b", "𝄞"), true);
  });

  it("contains accepts an empty needle", () => {
    assert.equal(contains("abc", ""), true);
  });

  it("starts_with matches exact prefixes", () => {
    assert.equal(starts_with("hello", "hell"), true);
    assert.equal(starts_with("hello", "ello"), false);
  });

  it("starts_with is case-sensitive", () => {
    assert.equal(starts_with("Hello", "hello"), false);
  });

  it("starts_with matches astral prefixes", () => {
    assert.equal(starts_with("𝄞abc", "𝄞"), true);
  });

  it("starts_with accepts an empty prefix", () => {
    assert.equal(starts_with("abc", ""), true);
  });

  it("rejects non-text input", () => {
    assertValueError(() => contains("a", 1 as unknown as string), "invalid-construction");
    assertValueError(() => starts_with(null as unknown as string, "a"), "invalid-construction");
  });
});

describe("join follows domain order", () => {
  it("joins in order with the separator", () => {
    assert.equal(join(["b", "a", "b"], ", "), "b, a, b");
  });

  it("yields empty text on an empty domain", () => {
    assert.equal(join([], ", "), "");
  });

  it("joins a single value without separator", () => {
    assert.equal(join(["solo"], ", "), "solo");
  });

  it("rejects non-text elements", () => {
    assertValueError(() => join(["a", 1] as unknown as string[], ","), "invalid-construction");
  });
});

describe("scalar counting uses code points", () => {
  it("counts ASCII by scalar", () => {
    assert.equal(scalarLength("hello"), 5n);
  });

  it("counts astral characters as 1", () => {
    assert.equal(scalarLength("𝄞"), 1n);
    assert.equal(scalarLength("😀"), 1n);
    assert.equal(scalarLength("a𝄞b"), 3n);
  });

  it("counts combining sequences per scalar", () => {
    assert.equal(scalarLength("é"), 1n);
    assert.equal(scalarLength("é"), 2n);
  });

  it("counts empty text as 0", () => {
    assert.equal(scalarLength(""), 0n);
  });

  it("counts lone surrogates as 1 each", () => {
    const lead = String.fromCharCode(0xd800);
    const trail = String.fromCharCode(0xdc00);
    assert.equal(scalarLength(lead), 1n);
    assert.equal(scalarLength(trail), 1n);
    assert.equal(scalarLength(`a${lead}b`), 3n);
    assert.deepEqual([...scalarChars(`a${lead}b`)], ["a", lead, "b"]);
  });

  it("splits scalars astral-aware and frozen", () => {
    const chars = scalarChars("a𝄞b");
    assert.deepEqual([...chars], ["a", "𝄞", "b"]);
    assert.equal(Object.isFrozen(chars), true);
  });
});

describe("no implicit normalization", () => {
  it("precomposed é differs from e + combining acute", () => {
    assert.notEqual("é", "é");
    assert.equal(contains("é", "é"), false);
    assert.equal(contains("é", "é"), false);
    assert.equal(scalarLength("é"), 1n);
    assert.equal(scalarLength("é"), 2n);
  });
});

describe("compareScalar orders by Unicode scalar", () => {
  it("orders ASCII", () => {
    assert.equal(compareScalar("a", "b"), -1);
    assert.equal(compareScalar("b", "a"), 1);
    assert.equal(compareScalar("a", "a"), 0);
  });

  it("orders shorter prefixes first", () => {
    assert.equal(compareScalar("abc", "abcd"), -1);
    assert.equal(compareScalar("abcd", "abc"), 1);
  });

  it("orders astral planes above the BMP", () => {
    assert.equal(compareScalar("z", "𝄞"), -1);
    assert.equal(compareScalar("𝄞", "z"), 1);
  });

  it("is case-sensitive code-point order (Z < a)", () => {
    assert.equal(compareScalar("Z", "a"), -1);
  });

  it("orders lone surrogates by scalar value (total order)", () => {
    const lead = String.fromCharCode(0xd800);
    const trail = String.fromCharCode(0xdc00);
    assert.equal(compareScalar(lead, lead), 0);
    assert.equal(compareScalar(lead, trail), -1);
    assert.equal(compareScalar(trail, lead), 1);
    assert.equal(compareScalar(lead, "a"), 1);
    assert.equal(compareScalar("a", trail), -1);
    assert.equal(compareScalar(trail, String.fromCodePoint(0x10000)), -1);
  });
});

describe("formatPlain renders named Display placeholders", () => {
  it("substitutes named keys", () => {
    assert.equal(formatPlain("Hello, {name}!", { name: "Ada" }), "Hello, Ada!");
  });

  it("renders doubled braces literally", () => {
    assert.equal(formatPlain("{{x}} {v} {{", { v: "1" }), "{x} 1 {");
    assert.equal(formatPlain("}}", {}), "}");
  });

  it("renders bool/int/date Display values", () => {
    assert.equal(
      formatPlain("{t} {f} {n} {d}", {
        t: true,
        f: false,
        n: -42n,
        d: makeDate(2026, 10, 4),
      }),
      "true false -42 2026-10-04",
    );
  });

  it("zero-pads dates", () => {
    assert.equal(formatPlain("{d}", { d: makeDate(42, 1, 5) }), "0042-01-05");
  });

  it("renders bigints in base 10 beyond 2^53", () => {
    assert.equal(formatPlain("{n}", { n: 9223372036854775807n }), "9223372036854775807");
  });

  it("passes enum spellings and validated-likes through as text", () => {
    assert.equal(formatPlain("{status}", { status: "draft" }), "draft");
  });

  it("allows extra object fields", () => {
    assert.equal(formatPlain("{a}", { a: "x", unused: 1 }), "x");
  });

  it("fails on missing placeholders", () => {
    assertValueError(() => formatPlain("Hello, {name}!", {}), "invalid-construction");
  });

  it("fails on malformed placeholders", () => {
    for (const template of ["{", "}", "{key", "x}", "{}", "{ }", "{a b}", "{a-b}", "{0}", "{a{}}"]) {
      assertValueError(() => formatPlain(template, { a: "x", key: "x" }), "invalid-construction");
    }
  });

  it("rejects decimal/money/datetime args (outside plain Display)", () => {
    assertValueError(
      () => formatPlain("{v}", { v: new Decimal(25n, 1) }),
      "invalid-construction",
    );
    assertValueError(
      () => formatPlain("{v}", { v: makeMoney(100n, "USD") }),
      "invalid-construction",
    );
    assertValueError(
      () => formatPlain("{v}", { v: makeDatetime(0n) }),
      "invalid-construction",
    );
  });

  it("rejects non-Display primitives and shapes", () => {
    for (const value of [1.5, 0, null, undefined, {}, [], makeDatetime(0n)]) {
      assertValueError(() => formatPlain("{v}", { v: value }), "invalid-construction");
    }
  });

  it("rejects non-object values and non-text templates", () => {
    assertValueError(() => formatPlain("{a}", null as unknown as Record<string, unknown>), "invalid-construction");
    assertValueError(() => formatPlain(1 as unknown as string, {}), "invalid-construction");
  });
});
