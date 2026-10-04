import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Decimal } from "../src/decimal.js";
import { ValueError } from "../src/errors.js";
import { makeMessageDescriptor } from "../src/icu.js";
import { INT64_MAX, INT64_MIN, absInt } from "../src/int.js";
import { makeDate, makeMoney, makeRecordRef, makeUserRef } from "../src/kinds.js";
import type { FormatMessageOptions } from "../src/locale.js";
import { absDuration } from "../src/temporal.js";
import { abs, action, app_url, choose, format, invocation, sum } from "../src/stdlib-pure.js";

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

const ORIGIN = "https://app.example.com/tenant";

describe("sum dispatcher", () => {
  it("routes int elements to sumInt, empty to zero", () => {
    assert.equal(sum([1n, 2n, 3n], "int"), 6n);
    assert.equal(sum([], "int"), 0n);
  });

  it("routes decimal elements to sumDecimal, empty to decimal zero", () => {
    const total = sum([new Decimal(10n, 1), new Decimal(25n, 2)], "decimal");
    assert.equal(total.coef, 125n);
    assert.equal(total.scale, 2);
    assert.ok(Object.isFrozen(total));
    const empty = sum([], "decimal");
    assert.equal(empty.coef, 0n);
    assert.equal(empty.scale, 0);
  });

  it("routes duration elements to sumDuration, empty to zero", () => {
    assert.equal(sum([1000n, -250n], "duration"), 750n);
    assert.equal(sum([], "duration"), 0n);
  });

  it("routes money with explicit currency and validates every amount", () => {
    const total = sum([makeMoney(100n, "USD"), makeMoney(25n, "USD")], "money", "USD");
    assert.equal(total.minor, 125n);
    assert.equal(total.currency, "USD");
    const zero = sum([], "money", "EUR");
    assert.equal(zero.minor, 0n);
    assert.equal(zero.currency, "EUR");
  });

  it("infers money currency from a nonempty domain", () => {
    const total = sum([makeMoney(100n, "JPY"), makeMoney(25n, "JPY")], "money");
    assert.equal(total.minor, 125n);
    assert.equal(total.currency, "JPY");
  });

  it("rejects element/kind mismatches as invalid-construction", () => {
    assertValueError(() => sum([new Decimal(1n, 0)], "int"), "invalid-construction");
    assertValueError(() => sum([makeMoney(1n, "USD")], "int"), "invalid-construction");
    assertValueError(() => sum(["1"] as unknown as ReadonlyArray<bigint>, "int"), "invalid-construction");
    assertValueError(() => sum([1n], "decimal"), "invalid-construction");
    assertValueError(() => sum([makeMoney(1n, "USD")], "decimal"), "invalid-construction");
    assertValueError(() => sum([new Decimal(1n, 0)], "duration"), "invalid-construction");
    assertValueError(() => sum([1n], "money"), "invalid-construction");
    assertValueError(() => sum([new Decimal(1n, 0)], "money"), "invalid-construction");
  });

  it("rejects bad tags, non-array domains and misplaced currency", () => {
    assertValueError(() => sum([1n], "float"), "invalid-construction");
    assertValueError(() => sum([1n], ""), "invalid-construction");
    assertValueError(
      () => sum("nope" as unknown as ReadonlyArray<bigint>, "int"),
      "invalid-construction",
    );
    assertValueError(() => sum([1n], "int", "USD"), "invalid-construction");
    assertValueError(() => sum([new Decimal(1n, 0)], "decimal", "USD"), "invalid-construction");
    assertValueError(() => sum([1n], "duration", "USD"), "invalid-construction");
  });

  it("keeps sumMoney currency and overflow rules", () => {
    assertValueError(
      () => sum([makeMoney(1n, "USD"), makeMoney(1n, "EUR")], "money"),
      "currency-mismatch",
    );
    assertValueError(
      () => sum([makeMoney(1n, "USD")], "money", "EUR"),
      "currency-mismatch",
    );
    assertValueError(() => sum([], "money"), "invalid-construction");
    assertValueError(() => sum([makeMoney(1n, "USD")], "money", "ZZZ"), "unknown-currency");
    // Direct literals: the maker itself rejects ZZZ, so only hand-built
    // values reach sumMoney's membership check.
    const zzz1 = { kind: "money" as const, minor: 1n, currency: "ZZZ" };
    const zzz2 = { kind: "money" as const, minor: 2n, currency: "ZZZ" };
    assertValueError(() => sum([zzz1, zzz2], "money"), "unknown-currency");
    assertValueError(() => sum([INT64_MAX, 1n], "int"), "overflow");
  });
});

describe("abs dispatcher", () => {
  it("routes bigints through absInt", () => {
    assert.equal(abs(5n), 5n);
    assert.equal(abs(-5n), 5n);
    assert.equal(abs(0n), 0n);
    assertValueError(() => abs(INT64_MIN), "overflow");
  });

  it("routes decimals through absDecimal with scale preserved", () => {
    const negated = abs(new Decimal(-125n, 2));
    assert.ok(typeof negated !== "bigint" && negated.kind === "decimal");
    if (typeof negated !== "bigint" && negated.kind === "decimal") {
      assert.equal(negated.coef, 125n);
      assert.equal(negated.scale, 2);
    }
    const zero = abs(new Decimal(0n, 5));
    assert.ok(typeof zero !== "bigint" && zero.kind === "decimal");
  });

  it("routes money through absMoney with currency kept", () => {
    const result = abs(makeMoney(-90n, "USD"));
    assert.ok(typeof result !== "bigint" && result.kind === "money");
    if (typeof result !== "bigint" && result.kind === "money") {
      assert.equal(result.minor, 90n);
      assert.equal(result.currency, "USD");
    }
    assertValueError(() => abs(makeMoney(INT64_MIN, "USD")), "overflow");
  });

  it("rejects every other runtime kind as invalid-construction", () => {
    for (const bad of ["5", 5, true, null, undefined, [], {}, makeDate(2026, 1, 1)]) {
      assertValueError(() => abs(bad as unknown as bigint), "invalid-construction");
    }
    assertValueError(() => abs(makeUserRef("u1") as unknown as bigint), "invalid-construction");
  });

  it("treats absDuration as behaviorally identical to absInt", () => {
    const samples: ReadonlyArray<bigint> = [INT64_MIN + 1n, -7n, -1n, 0n, 1n, 7n, INT64_MAX];
    for (const value of samples) {
      assert.equal(absDuration(value), absInt(value));
    }
    assertValueError(() => absDuration(INT64_MIN), "overflow");
    assertValueError(() => absInt(INT64_MIN), "overflow");
  });
});

describe("app_url", () => {
  it("joins app-relative paths under a bare origin", () => {
    assert.equal(app_url("/dashboard", "https://app.example.com"), "https://app.example.com/dashboard");
    assert.equal(app_url("/", "https://app.example.com/"), "https://app.example.com/");
    assert.equal(app_url("/a/b", "http://app.example.com"), "http://app.example.com/a/b");
    assert.equal(app_url("/x", "http://localhost:3000/app"), "http://localhost:3000/app/x");
  });

  it("joins under a mount prefix with canonical origin handling", () => {
    assert.equal(app_url("/reports/7", ORIGIN), "https://app.example.com/tenant/reports/7");
    assert.equal(app_url("/a", "https://app.example.com/tenant/"), "https://app.example.com/tenant/a");
    assert.equal(app_url("/", ORIGIN), "https://app.example.com/tenant/");
    assert.equal(
      app_url("/x", "https://APP.EXAMPLE.COM/t"),
      "https://app.example.com/t/x",
    );
    assert.equal(
      app_url("/x", "https://app.example.com:443/t"),
      "https://app.example.com/t/x",
    );
  });

  it("passes query/fragment suffixes and encoded content through", () => {
    assert.equal(
      app_url("/search?q=can+lang&n=2", "https://app.example.com"),
      "https://app.example.com/search?q=can+lang&n=2",
    );
    assert.equal(
      app_url("/docs#section-2", "https://app.example.com"),
      "https://app.example.com/docs#section-2",
    );
    assert.equal(
      app_url("/files/my%20file", "https://app.example.com"),
      "https://app.example.com/files/my%20file",
    );
    assert.equal(
      app_url("/a?x=%3F%23", "https://app.example.com"),
      "https://app.example.com/a?x=%3F%23",
    );
    assert.equal(
      app_url("/invite?email=a@b.com", "https://app.example.com"),
      "https://app.example.com/invite?email=a@b.com",
    );
    assert.equal(
      app_url("/caf\u00e9", "https://app.example.com"),
      "https://app.example.com/caf%C3%A9",
    );
  });

  it("accepts dot-free lookalikes without over-rejecting", () => {
    assert.equal(app_url("/a/...", ORIGIN), "https://app.example.com/tenant/a/...");
    assert.equal(app_url("/a/b.", ORIGIN), "https://app.example.com/tenant/a/b.");
    assert.equal(app_url("/a//b", ORIGIN), "https://app.example.com/tenant/a//b");
  });

  it("rejects non-app-relative paths", () => {
    for (const bad of ["", "dashboard", "a/b", "//evil.com/x", "https://evil.com/x", "ftp://h/x"]) {
      assertValueError(() => app_url(bad, ORIGIN), "invalid-construction");
    }
    assertValueError(() => app_url(5 as unknown as string, ORIGIN), "invalid-construction");
  });

  it("rejects backslashes anywhere in the path argument", () => {
    for (const bad of ["/\\evil.com", "/a\\b", "\\", "/a?q=a\\b", "/a#x\\y"]) {
      assertValueError(() => app_url(bad, ORIGIN), "invalid-construction");
    }
  });

  it("rejects malformed percent-encoding in path, query and fragment", () => {
    for (const bad of ["/a%", "/a%2", "/a%zz", "/a%2G", "/a%%", "/a?x=%zz", "/a#frag%2", "/%"]) {
      assertValueError(() => app_url(bad, ORIGIN), "invalid-construction");
    }
  });

  it("rejects raw and decoded dot segments (prefix escape attempts)", () => {
    for (const bad of [
      "/../x", "/./x", "/a/../x", "/a/./b", "/a/..", "/..", "/.",
      "/tenant/../evil",
      "/%2e%2e/x", "/%2E%2E/x", "/%2e/x", "/a/%2E/b", "/a/%2e%2e",
      "/.%2e/x", "/%2e./x", "/a/%2E",
    ]) {
      assertValueError(() => app_url(bad, ORIGIN), "invalid-construction");
    }
  });

  it("accepts @ inside path segments (stays path data, never authority)", () => {
    assert.equal(app_url("/users/@me", ORIGIN), "https://app.example.com/tenant/users/@me");
    assert.equal(app_url("/files/a@2x.png", ORIGIN), "https://app.example.com/tenant/files/a@2x.png");
    assert.equal(app_url("/a%40b", ORIGIN), "https://app.example.com/tenant/a%40b");
    assert.equal(app_url("/%40evil/x", ORIGIN), "https://app.example.com/tenant/%40evil/x");
  });

  it("rejects decoded separators while @-carrying origins stay rejected", () => {
    for (const bad of ["/%2F/x", "/a%2fb", "/%5c/x", "/a%5Cb", "/a%2F..%2Fb"]) {
      assertValueError(() => app_url(bad, ORIGIN), "invalid-construction");
    }
    // The real userinfo smuggling vector is the origin, not path segments.
    assertValueError(() => app_url("/users/@me", "https://user@app.example.com"), "invalid-construction");
    assertValueError(() => app_url("/users/@me", "https://user:pass@app.example.com/"), "invalid-construction");
  });

  it("rejects raw and decoded whitespace and controls", () => {
    for (const bad of ["/a b", "/a\tb", "/a?x=a b", "/a#x y", "/%00/x", "/a%1F", "/%7F"]) {
      assertValueError(() => app_url(bad, ORIGIN), "invalid-construction");
    }
  });

  it("rejects untrusted origins", () => {
    for (const badOrigin of [
      "https://user@app.example.com",
      "https://user:pass@app.example.com/",
      "ftp://app.example.com/x",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "//app.example.com/x",
      "/tenant",
      "",
      "not a url",
      "app.example.com/tenant",
      "https://app.example.com/tenant?x=1",
      "https://app.example.com/tenant#h",
    ]) {
      assertValueError(() => app_url("/x", badOrigin), "invalid-construction");
    }
    assertValueError(() => app_url("/x", 5 as unknown as string), "invalid-construction");
  });
});

describe("action packaging", () => {
  it("packages validated targets and versioned bindings frozen", () => {
    const ref = action("billing.inspect", {
      inspection: makeRecordRef("Inspection", "i1", 3n),
      account: makeRecordRef("Account", "a9", 0n),
    });
    assert.equal(ref.kind, "action");
    assert.equal(ref.target, "billing.inspect");
    assert.deepEqual(ref.bindings["inspection"], { kind: "ref", model: "Inspection", id: "i1", version: 3n });
    assert.ok(Object.isFrozen(ref));
    assert.ok(Object.isFrozen(ref.bindings));
  });

  it("accepts an empty closed binding record", () => {
    const ref = action("billing.ping", {});
    assert.deepEqual(ref.bindings, {});
    assert.ok(Object.isFrozen(ref));
  });

  it("rejects __proto__ binding names but keeps constructor", () => {
    // JSON.parse builds a true own __proto__ key (an object literal would
    // hit the prototype setter instead); the version is then made valid so
    // only the reserved name can fail.
    const bindings = JSON.parse('{"__proto__":{"kind":"ref","model":"M","id":"r"}}') as Record<
      string,
      { readonly version?: unknown }
    >;
    (bindings["__proto__"] as { version: unknown }).version = 1n;
    let produced: unknown = null;
    try {
      produced = action("billing.inspect", bindings as never);
    } catch (err) {
      assert.ok(err instanceof ValueError, `expected ValueError, got ${String(err)}`);
      assert.equal(err.code, "invalid-construction");
      assert.match(err.message, /action binding name "__proto__" is reserved/);
    }
    assert.equal(produced, null);
    const ref = action("billing.inspect", { constructor: makeRecordRef("M", "r", 1n) });
    assert.ok(Object.hasOwn(ref.bindings, "constructor"));
    assert.deepEqual(ref.bindings["constructor"], { kind: "ref", model: "M", id: "r", version: 1n });
  });

  it("rejects bindings without an expected version", () => {
    assertValueError(
      () => action("billing.inspect", { inspection: makeRecordRef("Inspection", "i1") }),
      "invalid-construction",
    );
    const textVersion = { kind: "ref", model: "M", id: "i", version: "3" };
    assertValueError(
      () => action("billing.inspect", { m: textVersion as unknown as never }),
      "invalid-construction",
    );
  });

  it("rejects non-record bindings and malformed envelopes", () => {
    assertValueError(
      () => action("billing.inspect", { x: "nope" as unknown as never }),
      "invalid-construction",
    );
    assertValueError(
      () => action("billing.inspect", { x: makeUserRef("u1") as unknown as never }),
      "invalid-construction",
    );
    assertValueError(() => action("", { m: makeRecordRef("M", "i", 1n) }), "invalid-construction");
    assertValueError(
      () => action(5 as unknown as string, { m: makeRecordRef("M", "i", 1n) }),
      "invalid-construction",
    );
    assertValueError(
      () => action("billing.inspect", null as unknown as Record<string, never>),
      "invalid-construction",
    );
    assertValueError(
      () => action("billing.inspect", [] as unknown as Record<string, never>),
      "invalid-construction",
    );
  });
});

describe("choose", () => {
  it("selects strictly, returning inputs as-is", () => {
    assert.equal(choose(true, 1n, 2n), 1n);
    assert.equal(choose(false, 1n, 2n), 2n);
    assert.equal(choose(true, "y", "n"), "y");
    assert.equal(choose(false, "y", "n"), "n");
    assert.equal(choose(true, null, 1n), null);
    const yes = Object.freeze({ v: 1n });
    const no = Object.freeze({ v: 2n });
    assert.equal(choose<unknown>(true, yes, no), yes);
    assert.equal(choose<unknown>(false, yes, no), no);
    const money = makeMoney(100n, "USD");
    assert.equal(choose(true, money, makeMoney(1n, "USD")), money);
  });

  it("requires a boolean condition", () => {
    for (const bad of ["true", 1, 0, null, undefined, {}, [], 1n]) {
      assertValueError(() => choose(bad as unknown as boolean, 1n, 2n), "invalid-construction");
    }
  });
});

describe("invocation packaging", () => {
  it("packages validated targets and decoded args frozen", () => {
    const ref = invocation("todo.Task.update", {
      record: makeRecordRef("Todo", "t1", 3n),
      count: 5n,
      title: "hi",
    });
    assert.equal(ref.kind, "invocation");
    assert.equal(ref.target, "todo.Task.update");
    assert.deepEqual(ref.args["record"], { kind: "ref", model: "Todo", id: "t1", version: 3n });
    assert.equal(ref.args["count"], 5n);
    assert.ok(Object.isFrozen(ref));
    assert.ok(Object.isFrozen(ref.args));
  });

  it("preserves versionless refs instead of requiring versions", () => {
    // Unlike action bindings, args can carry read refs needing only IDs.
    const ref = invocation("todo.Task.read", { record: makeRecordRef("Todo", "t1") });
    assert.deepEqual(ref.args["record"], { kind: "ref", model: "Todo", id: "t1" });
    const empty = invocation("todo.ping", {});
    assert.deepEqual(empty.args, {});
    assert.ok(Object.isFrozen(empty));
  });

  it("rejects __proto__ argument names but keeps constructor", () => {
    const args = JSON.parse('{"__proto__":{"kind":"ref","model":"M","id":"r"}}') as Record<
      string,
      { readonly version?: unknown }
    >;
    (args["__proto__"] as { version: unknown }).version = 1n;
    let produced: unknown = null;
    try {
      produced = invocation("todo.Task.update", args as never);
    } catch (err) {
      assert.ok(err instanceof ValueError, `expected ValueError, got ${String(err)}`);
      assert.equal(err.code, "invalid-construction");
      assert.match(err.message, /invocation argument name "__proto__" is reserved/);
    }
    assert.equal(produced, null);
    const ref = invocation("todo.Task.update", { constructor: makeRecordRef("M", "r", 1n) });
    assert.ok(Object.hasOwn(ref.args, "constructor"));
  });

  it("rejects bad targets, non-record args and non-values", () => {
    assertValueError(() => invocation("", {}), "invalid-construction");
    assertValueError(() => invocation(5 as unknown as string, {}), "invalid-construction");
    assertValueError(() => invocation("t", null as unknown as Record<string, never>), "invalid-construction");
    assertValueError(() => invocation("t", [] as unknown as Record<string, never>), "invalid-construction");
    assertValueError(
      () => invocation("t", { x: undefined as unknown as never }),
      "invalid-construction",
    );
    assertValueError(
      () => invocation("t", { x: (() => 1) as unknown as never }),
      "invalid-construction",
    );
  });
});

describe("format dispatcher", () => {
  it("routes text templates to formatPlain", () => {
    assert.equal(format("Hello {name}!", { name: "Ada" }), "Hello Ada!");
    assert.equal(format("{n} tasks {{literal}}", { n: 3n }), "3 tasks {literal}");
    assert.equal(format("{flag}", { flag: false }), "false");
  });

  it("keeps the plain Display exclusion: decimal values are rejected", () => {
    assertValueError(
      () => format("{amount}", { amount: new Decimal(125n, 2) }),
      "invalid-construction",
    );
    assertValueError(
      () => format("{amount}", { amount: makeMoney(125n, "USD") }),
      "invalid-construction",
    );
  });

  it("routes message descriptors to formatMessage with selected-locale behavior", () => {
    const descriptor = makeMessageDescriptor(
      "Hello {name}!",
      { en: "Hello {name}!", fr: "Bonjour {name}!" },
      { name: { type: "text", value: "Ada" } },
    );
    const selected = format(descriptor, { locale: "fr", appDefault: "en" });
    assert.equal(selected.text, "Bonjour Ada!");
    assert.equal(selected.locale, "fr");
    const fallback = format(descriptor, { locale: "fr-CA", appDefault: "en" });
    assert.equal(fallback.text, "Bonjour Ada!");
    assert.equal(fallback.locale, "fr");
    const appDefault = format(descriptor, { locale: null, appDefault: "fr" });
    assert.equal(appDefault.text, "Bonjour Ada!");
    assert.equal(appDefault.locale, "fr");
  });

  it("rejects a first argument that is neither text nor a descriptor", () => {
    const values = {};
    for (const bad of [42, 5n, true, null, undefined, [], values, { kind: "message" }]) {
      assertValueError(
        () => format(bad as unknown as string, values),
        "invalid-construction",
      );
    }
  });

  it("rejects a second argument of the wrong shape for the detected overload", () => {
    for (const bad of ["nope", 42, null, undefined, []]) {
      assertValueError(
        () => format("Hello {name}!", bad as unknown as Readonly<Record<string, unknown>>),
        "invalid-construction",
      );
    }
    const descriptor = makeMessageDescriptor("Hello!", { en: "Hello!" });
    assertValueError(
      () => format(descriptor, { appDefault: "en" } as unknown as FormatMessageOptions),
      "invalid-construction",
    );
    assertValueError(
      () => format(descriptor, "fr" as unknown as FormatMessageOptions),
      "invalid-construction",
    );
  });
});
