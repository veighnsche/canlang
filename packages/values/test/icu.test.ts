import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Decimal } from "../src/decimal.js";
import { ValueError } from "../src/errors.js";
import {
  isMessageDescriptor,
  makeMessageDescriptor,
  parseMessageFormat,
  renderMessage,
  validateMessagePattern,
  type MessageParam,
  type MessageParamType,
} from "../src/icu.js";
import { makeDate, makeDatetime, makeMoney } from "../src/kinds.js";

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

function intParam(value: bigint): MessageParam {
  return { type: "int", value };
}

function textParam(value: string): MessageParam {
  return { type: "text", value };
}

describe("bounded profile accept matrix", () => {
  it("renders static text and empty patterns", () => {
    assert.equal(renderMessage("No tasks yet.", {}, "en"), "No tasks yet.");
    assert.equal(renderMessage("", {}, "en"), "");
  });

  it("renders named placeholders", () => {
    assert.equal(renderMessage("Hello, {name}!", { name: textParam("Ada") }, "en"), "Hello, Ada!");
  });

  it("renders {n,number} with locale grouping", () => {
    assert.equal(renderMessage("{n,number}", { n: intParam(1234567n) }, "en"), "1,234,567");
    assert.equal(renderMessage("{n,number}", { n: intParam(1234567n) }, "de"), "1.234.567");
  });

  it("renders {n,number,integer} with half-even rounding", () => {
    const args = { n: { type: "decimal", value: new Decimal(25n, 1) } as MessageParam };
    assert.equal(renderMessage("{n,number,integer}", args, "en"), "2");
    const up = { n: { type: "decimal", value: new Decimal(35n, 1) } as MessageParam };
    assert.equal(renderMessage("{n,number,integer}", up, "en"), "4");
    assert.equal(renderMessage("{n,number,integer}", { n: intParam(42n) }, "en"), "42");
  });

  it("renders {d,date} defaulting to medium style", () => {
    const args = { d: { type: "date", value: makeDate(2026, 10, 4) } as MessageParam };
    assert.equal(renderMessage("{d,date}", args, "en"), "Oct 4, 2026");
    assert.equal(renderMessage("{d,date,medium}", args, "en"), "Oct 4, 2026");
  });

  it("renders explicit date/time styles", () => {
    const args = { d: { type: "date", value: makeDate(2026, 10, 4) } as MessageParam };
    assert.equal(renderMessage("{d,date,short}", args, "en"), "10/4/26");
    assert.equal(renderMessage("{d,date,long}", args, "en"), "October 4, 2026");
    assert.equal(renderMessage("{d,date,full}", args, "en"), "Sunday, October 4, 2026");
    const atNoon = { t: { type: "datetime", value: makeDatetime(1762084800000n) } as MessageParam };
    assert.match(renderMessage("{t,time}", atNoon, "en"), /12:00:00/);
    assert.match(renderMessage("{t,time,short}", atNoon, "en"), /12:00/);
  });

  it("renders cardinal plurals with #", () => {
    const pattern = "{n, plural, one {# task} other {# tasks}}";
    assert.equal(renderMessage(pattern, { n: intParam(1n) }, "en"), "1 task");
    assert.equal(renderMessage(pattern, { n: intParam(5n) }, "en"), "5 tasks");
  });

  it("prefers exact numeric cases over CLDR categories", () => {
    const pattern = "{n, plural, =0 {none} one {# task} other {# tasks}}";
    assert.equal(renderMessage(pattern, { n: intParam(0n) }, "en"), "none");
    assert.equal(renderMessage(pattern, { n: intParam(1n) }, "en"), "1 task");
  });

  it("matches exact decimal cases by value", () => {
    const pattern = "{n, plural, =1.5 {one and a half} other {#}}";
    const args = { n: { type: "decimal", value: new Decimal(15n, 1) } as MessageParam };
    assert.equal(renderMessage(pattern, args, "en"), "one and a half");
  });

  it("renders selectordinal with int-only ordinals", () => {
    const pattern = "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}";
    assert.equal(renderMessage(pattern, { n: intParam(1n) }, "en"), "1st");
    assert.equal(renderMessage(pattern, { n: intParam(2n) }, "en"), "2nd");
    assert.equal(renderMessage(pattern, { n: intParam(3n) }, "en"), "3rd");
    assert.equal(renderMessage(pattern, { n: intParam(4n) }, "en"), "4th");
  });

  it("renders select over text/bool/enum", () => {
    const pattern = "{g, select, male {he} female {she} other {they}}";
    assert.equal(renderMessage(pattern, { g: textParam("female") }, "en"), "she");
    assert.equal(renderMessage(pattern, { g: textParam("x") }, "en"), "they");
    const flags = "{v, select, true {yes} false {no} other {?}}";
    assert.equal(renderMessage(flags, { v: { type: "bool", value: true } }, "en"), "yes");
    assert.equal(renderMessage(flags, { v: { type: "bool", value: false } }, "en"), "no");
    const status = "{s, select, draft {Draft} other {Other}}";
    assert.equal(renderMessage(status, { s: { type: "enum", value: "draft" } }, "en"), "Draft");
  });

  it("renders nested plural/select with nearest-plural #", () => {
    const pattern = "{g, select, male {{n, plural, one {he has # task} other {he has # tasks}}} other {they}}";
    const args = { g: textParam("male"), n: intParam(2n) };
    assert.equal(renderMessage(pattern, args, "en"), "he has 2 tasks");
    const nested = "{n, plural, other {{m, plural, other {# inner}}}}";
    assert.equal(renderMessage(nested, { n: intParam(5n), m: intParam(7n) }, "en"), "7 inner");
  });

  it("treats # outside plural as literal text", () => {
    assert.equal(renderMessage("Issue #42", {}, "en"), "Issue #42");
  });

  it("supports ICU apostrophe quoting", () => {
    assert.equal(renderMessage("it''s", {}, "en"), "it's");
    assert.equal(renderMessage("'{x}'", {}, "en"), "{x}");
    assert.equal(renderMessage("'{n,number}'", {}, "en"), "{n,number}");
    assert.equal(renderMessage("don't", {}, "en"), "don't");
    assert.equal(renderMessage("'#' {n,number}", { n: intParam(3n) }, "en"), "# 3");
  });

  it("allows extra unused params", () => {
    assert.equal(
      renderMessage("{a}", { a: textParam("x"), extra: intParam(1n) }, "en"),
      "x",
    );
  });

  it("validates patterns structurally without declared vars", () => {
    validateMessagePattern("{n, plural, one {#} other {#}}");
    assertValueError(() => validateMessagePattern("{n, plural, one {#}}"), "invalid-construction");
  });
});

describe("bounded profile reject matrix", () => {
  it("rejects plural offsets", () => {
    for (const pattern of [
      "{n, plural, offset:1 other {#}}",
      "{n, plural, offset : 1 other {#}}",
      "{n, selectordinal, offset:1 other {#}}",
    ]) {
      assertValueError(() => parseMessageFormat(pattern), "invalid-construction");
    }
  });

  it("rejects choice and custom functions", () => {
    for (const pattern of ["{n, choice, 0#none}", "{n, spellout}", "{n, number, spellout}"]) {
      assertValueError(() => parseMessageFormat(pattern), "invalid-construction");
    }
  });

  it("rejects skeletons and custom styles", () => {
    for (const pattern of [
      "{n,number,::currency/USD}",
      "{n,number,currency}",
      "{n,number,percent}",
      "{d,date,yyyy-MM-dd}",
      "{d,time,HH:mm}",
      "{d,date,medium,extra}",
    ]) {
      assertValueError(() => parseMessageFormat(pattern), "invalid-construction");
    }
  });

  it("rejects rich-text tags", () => {
    for (const pattern of ["Click <b>here</b>", "a<br/>b", "a <link>x</link>"]) {
      assertValueError(() => parseMessageFormat(pattern), "invalid-construction");
    }
  });

  it("keeps bare angle brackets literal", () => {
    assert.equal(renderMessage("a < b and c > d", {}, "en"), "a < b and c > d");
    assert.equal(renderMessage("1 <3", {}, "en"), "1 <3");
  });

  it("rejects duplicate branches", () => {
    for (const pattern of [
      "{n, plural, one {a} one {b} other {c}}",
      "{n, plural, =1 {a} =1.0 {b} other {c}}",
      "{n, plural, other {a} other {b}}",
      "{s, select, a {x} a {y} other {z}}",
    ]) {
      assertValueError(() => parseMessageFormat(pattern), "invalid-construction");
    }
  });

  it("rejects missing other branches", () => {
    for (const pattern of ["{n, plural, one {a}}", "{n, selectordinal, one {a}}", "{s, select, a {x}}"]) {
      assertValueError(() => parseMessageFormat(pattern), "invalid-construction");
    }
  });

  it("rejects unknown plural selectors and misplaced exact cases", () => {
    for (const pattern of [
      "{n, plural, foo {a} other {b}}",
      "{n, plural, One {a} other {b}}",
      "{s, select, =1 {a} other {b}}",
    ]) {
      assertValueError(() => parseMessageFormat(pattern), "invalid-construction");
    }
  });

  it("rejects malformed argument syntax", () => {
    for (const pattern of [
      "{",
      "}",
      "{}",
      "{,number}",
      "{n,}",
      "{n, plural}",
      "{n, select}",
      "{n,number",
      "{n, plural, one {#}",
      "'{n}",
    ]) {
      assertValueError(() => parseMessageFormat(pattern), "invalid-construction");
    }
  });

  it("rejects undeclared variables", () => {
    assertValueError(() => renderMessage("{x}", {}, "en"), "invalid-construction");
    assertValueError(
      () => renderMessage("{n, plural, other {{x}}}", { n: intParam(1n) }, "en"),
      "invalid-construction",
    );
    const declared: Record<string, MessageParamType> = { n: "int" };
    assertValueError(
      () => validateMessagePattern("{n, plural, other {{x}}}", declared),
      "invalid-construction",
    );
  });

  it("rejects incompatible argument/selector types", () => {
    const text = { v: textParam("x") };
    const boolean = { v: { type: "bool", value: true } as MessageParam };
    const int = { v: intParam(1n) };
    const decimal = { v: { type: "decimal", value: new Decimal(1n, 0) } as MessageParam };
    const date = { v: { type: "date", value: makeDate(2026, 1, 1) } as MessageParam };
    assertValueError(() => renderMessage("{v,number}", text, "en"), "invalid-construction");
    assertValueError(() => renderMessage("{v,number}", boolean, "en"), "invalid-construction");
    assertValueError(() => renderMessage("{v, plural, other {#}}", text, "en"), "invalid-construction");
    assertValueError(
      () => renderMessage("{v, selectordinal, other {#}}", decimal, "en"),
      "invalid-construction",
    );
    assertValueError(() => renderMessage("{v, select, other {x}}", int, "en"), "invalid-construction");
    assertValueError(
      () => renderMessage("{v, select, other {x}}", decimal, "en"),
      "invalid-construction",
    );
    assertValueError(() => renderMessage("{v,date}", text, "en"), "invalid-construction");
    assertValueError(() => renderMessage("{v,time}", date, "en"), "invalid-construction");
    assertValueError(() => renderMessage("{v,time}", text, "en"), "invalid-construction");
  });

  it("rejects one variable used with conflicting types", () => {
    const int = { v: intParam(1n) };
    assertValueError(() => renderMessage("{v,number} {v,date}", int, "en"), "invalid-construction");
    const declared: Record<string, MessageParamType> = { v: "int" };
    assertValueError(
      () => validateMessagePattern("{v,number} {v,date}", declared),
      "invalid-construction",
    );
  });

  it("renders depth-3 nesting", () => {
    const pattern =
      "{g, select, male {{n, plural, one {he has {m, select, other {# tasks}}} other {they}}} other {they}}";
    const args = { g: textParam("male"), n: intParam(1n), m: textParam("x") };
    assert.equal(renderMessage(pattern, args, "en"), "he has 1 tasks");
  });

  it("rejects nesting deeper than 32 levels", () => {
    const nest = (levels: number): string =>
      "{v, select, other {".repeat(levels) + "deep" + "}".repeat(levels * 2);
    assertValueError(() => parseMessageFormat(nest(33)), "invalid-construction");
    assertValueError(
      () => renderMessage(nest(33), { v: textParam("x") }, "en"),
      "invalid-construction",
    );
    assert.equal(parseMessageFormat(nest(32)).length, 1);
  });

  it("rejects malformed param shapes and values", () => {
    assertValueError(
      () => renderMessage("{v}", { v: { type: "nope", value: 1 } as unknown as MessageParam }, "en"),
      "invalid-construction",
    );
    assertValueError(
      () => renderMessage("{v}", { v: { type: "int", value: "1" } as unknown as MessageParam }, "en"),
      "invalid-construction",
    );
    assertValueError(() => renderMessage("{v}", null as unknown as Record<string, MessageParam>, "en"), "invalid-construction");
  });

  it("rejects unusable locales and zones", () => {
    assertValueError(() => renderMessage("x", {}, "!!!"), "invalid-construction");
    assertValueError(() => renderMessage("x", {}, ""), "invalid-construction");
    assertValueError(() => renderMessage("x", {}, "en", { timeZone: "Mars/Olympus" }), "invalid-construction");
  });
});

describe("exactness without Number routing", () => {
  it("matches int64-max exact cases exactly", () => {
    const pattern = "{n, plural, =9223372036854775807 {max} other {#}}";
    assert.equal(renderMessage(pattern, { n: intParam(9223372036854775807n) }, "en"), "max");
  });

  it("renders huge ints with exact grouped digits", () => {
    assert.equal(renderMessage("{n,number}", { n: intParam(9223372036854775807n) }, "en"), "9,223,372,036,854,775,807");
    assert.equal(renderMessage("{n,number}", { n: intParam(123456789012345678n) }, "de"), "123.456.789.012.345.678");
    assert.equal(
      renderMessage("{n, plural, other {#}}", { n: intParam(1234567n) }, "de"),
      "1.234.567",
    );
  });

  it("refuses to guess plural categories beyond the safe range", () => {
    assertValueError(
      () => renderMessage("{n, plural, other {#}}", { n: intParam(2n ** 60n) }, "en"),
      "out-of-range",
    );
  });

  it("renders decimals with exact digits and locale separators", () => {
    const tenth = { n: { type: "decimal", value: new Decimal(1n, 1) } as MessageParam };
    assert.equal(renderMessage("{n,number}", tenth, "en"), "0.1");
    const big = { n: { type: "decimal", value: new Decimal(123450n, 1) } as MessageParam };
    assert.equal(renderMessage("{n,number}", big, "de"), "12.345,0");
  });

  it("renders negative numbers with the locale minus sign", () => {
    assert.equal(renderMessage("{n,number}", { n: intParam(-1234567n) }, "en"), "-1,234,567");
    const neg = { n: { type: "decimal", value: new Decimal(-25n, 1) } as MessageParam };
    assert.equal(renderMessage("{n,number,integer}", neg, "en"), "-2");
  });

  it("applies Indic secondary grouping from Intl parts", () => {
    assert.equal(renderMessage("{n,number}", { n: intParam(12345678n) }, "en-IN"), "1,23,45,678");
  });

  it("selects decimal plurals by value with round-trip safety", () => {
    const half = { n: { type: "decimal", value: new Decimal(15n, 1) } as MessageParam };
    const pattern = "{n, plural, one {#} other {# others}}";
    assert.equal(renderMessage(pattern, half, "en"), "1.5 others");
  });

  it("treats trailing-zero decimals as their integer value (R2a-consistent)", () => {
    const two = { n: { type: "decimal", value: new Decimal(20n, 1) } as MessageParam };
    const pattern = "{n, plural, one {#} few {#} other {# others}}";
    // Selects ru "few" like integer 2, while # still shows the exact stored digits.
    assert.equal(renderMessage(pattern, two, "ru"), "2,0");
  });

  it("preserves exact scale digits in both plain {n} and {n,number}", () => {
    const two = { n: { type: "decimal", value: new Decimal(20n, 1) } as MessageParam };
    assert.equal(renderMessage("{n}", two, "en"), "2.0");
    assert.equal(renderMessage("{n,number}", two, "en"), "2.0");
  });
});

describe("typed display of money/date/datetime", () => {
  it("displays money with exact amount, currency and scale", () => {
    const usd = { m: { type: "money", value: makeMoney(1234n, "USD") } as MessageParam };
    assert.equal(renderMessage("{m}", usd, "en"), "12.34 USD");
    const jpy = { m: { type: "money", value: makeMoney(500n, "JPY") } as MessageParam };
    assert.equal(renderMessage("{m}", jpy, "en"), "500 JPY");
    const kwd = { m: { type: "money", value: makeMoney(1234n, "KWD") } as MessageParam };
    assert.equal(renderMessage("{m}", kwd, "en"), "1.234 KWD");
    const neg = { m: { type: "money", value: makeMoney(-50n, "USD") } as MessageParam };
    assert.equal(renderMessage("{m}", neg, "en"), "-0.50 USD");
  });

  it("rejects unknown-currency money", () => {
    const bad = { m: { type: "money", value: makeMoney(1n, "XXX") } as MessageParam };
    assertValueError(() => renderMessage("{m}", bad, "en"), "unknown-currency");
  });

  it("displays plain dates without day shifts", () => {
    const args = { d: { type: "date", value: makeDate(2026, 10, 4) } as MessageParam };
    assert.equal(renderMessage("{d}", args, "en"), "2026-10-04");
    assert.equal(renderMessage("{d}", args, "nl"), "2026-10-04");
  });

  it("displays datetimes in the selected zone (UTC default)", () => {
    const instant = makeDatetime(1767225600000n);
    const args = { t: { type: "datetime", value: instant } as MessageParam };
    assert.match(renderMessage("{t,time,short}", args, "en"), /12:00/);
    assert.match(
      renderMessage("{t,time,short}", args, "en", { timeZone: "America/New_York" }),
      /7:00/,
    );
  });

  it("rejects out-of-range datetimes and ints", () => {
    const far = { t: { type: "datetime", value: makeDatetime(253402300800000n) } as MessageParam };
    assertValueError(() => renderMessage("{t}", far, "en"), "out-of-range");
    assertValueError(
      () => renderMessage("{n,number}", { n: intParam(2n ** 63n) }, "en"),
      "overflow",
    );
  });
});

describe("message descriptors", () => {
  it("makes source-only descriptors", () => {
    const descriptor = makeMessageDescriptor("Add", {});
    assert.equal(descriptor.kind, "message");
    assert.deepEqual(descriptor.variants, {});
    assert.equal(descriptor.params, undefined);
  });

  it("canonicalizes variant tags and keeps nulls distinct", () => {
    const descriptor = makeMessageDescriptor("Add", { "PT-br": "Adicionar", nl: null });
    assert.deepEqual(descriptor.variants, { "pt-BR": "Adicionar", nl: null });
  });

  it("rejects duplicate canonical tags", () => {
    assertValueError(() => makeMessageDescriptor("Add", { nl: "x", NL: "y" }), "invalid-construction");
  });

  it("rejects invalid variant tags and shapes", () => {
    assertValueError(() => makeMessageDescriptor("Add", { "!!!": "x" }), "invalid-construction");
    assertValueError(() => makeMessageDescriptor("Add", { nl: 1 as unknown as string }), "invalid-construction");
    assertValueError(() => makeMessageDescriptor(1 as unknown as string, {}), "invalid-construction");
  });

  it("validates every variant pattern at construction", () => {
    assertValueError(
      () => makeMessageDescriptor("ok", { nl: "{n, plural, one {x}}" }),
      "invalid-construction",
    );
    assertValueError(() => makeMessageDescriptor("{n, choice, 0#x}", {}), "invalid-construction");
  });

  it("binds every variant against shared params", () => {
    const params = { n: intParam(2n) };
    const descriptor = makeMessageDescriptor("{n, plural, other {#}}", { nl: "{n, plural, other {#}}" }, params);
    assert.equal(Object.hasOwn(descriptor.params as Record<string, MessageParam>, "n"), true);
    assertValueError(
      () =>
        makeMessageDescriptor("{n, plural, other {#}}", { nl: "{m, plural, other {#}}" }, params),
      "invalid-construction",
    );
  });

  it("rejects malformed params at construction", () => {
    assertValueError(
      () => makeMessageDescriptor("{v}", {}, { v: { type: "int", value: "1" } as unknown as MessageParam }),
      "invalid-construction",
    );
    assertValueError(
      () => makeMessageDescriptor("{v}", {}, { v: { type: "zzz", value: 1 } as unknown as MessageParam }),
      "invalid-construction",
    );
  });

  it("guards descriptor shapes", () => {
    assert.equal(isMessageDescriptor(makeMessageDescriptor("a", {})), true);
    assert.equal(isMessageDescriptor({ kind: "message", source: "a", variants: {} }), true);
    assert.equal(isMessageDescriptor(null), false);
    assert.equal(isMessageDescriptor({ kind: "message", source: 1, variants: {} }), false);
    assert.equal(isMessageDescriptor({ kind: "message", source: "a", variants: [] }), false);
    assert.equal(isMessageDescriptor({ kind: "text", source: "a", variants: {} }), false);
    assert.equal(
      isMessageDescriptor({ kind: "message", source: "a", variants: {}, params: { v: { type: "zzz" } } }),
      false,
    );
  });

  it("preserves Decimal identity through the maker", () => {
    const decimal = new Decimal(15n, 1);
    const descriptor = makeMessageDescriptor("{n}", {}, { n: { type: "decimal", value: decimal } });
    const stored = (descriptor.params as Record<string, MessageParam>)["n"]?.value;
    assert.ok(stored instanceof Decimal);
    assert.equal(stored, decimal);
  });

  it("freezes descriptors deeply one level", () => {
    const descriptor = makeMessageDescriptor("{n}", {}, { n: intParam(1n) });
    assert.equal(Object.isFrozen(descriptor), true);
    assert.equal(Object.isFrozen(descriptor.variants), true);
    assert.equal(Object.isFrozen(descriptor.params as object), true);
  });

  it("freezes parsed ASTs", () => {
    const ast = parseMessageFormat("{n, plural, other {#}}");
    assert.equal(Object.isFrozen(ast), true);
  });
});
