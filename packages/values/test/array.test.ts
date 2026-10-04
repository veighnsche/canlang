import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  all,
  any,
  at,
  concat,
  count,
  first,
  flatten,
  group,
  max,
  min,
  sumDecimal,
  sumDuration,
  sumInt,
  sumMoney,
} from "../src/array.js";
import { Decimal, compareDecimal } from "../src/decimal.js";
import { ValueError } from "../src/errors.js";
import { INT64_MAX } from "../src/int.js";
import {
  makeDate,
  makeDatetime,
  makeMemberRef,
  makeMoney,
  makeRecordRef,
  makeUserRef,
} from "../src/kinds.js";

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

describe("concat (DESIGN L201)", () => {
  it("concatenates in order without mutating its inputs", () => {
    const left = [1n, 2n];
    const right = [3n];
    const out = concat(left, right);
    assert.deepEqual(out, [1n, 2n, 3n]);
    assert.ok(Object.isFrozen(out));
    assert.deepEqual(left, [1n, 2n]);
    assert.deepEqual(right, [3n]);
  });

  it("handles empty forms", () => {
    assert.deepEqual(concat([], []), []);
    assert.deepEqual(concat([1n], []), [1n]);
    assert.deepEqual(concat([], [1n]), [1n]);
  });

  it("rejects non-array inputs", () => {
    assertValueError(() => concat(1n as unknown as ReadonlyArray<bigint>, []), "invalid-construction");
    assertValueError(() => concat([], null as unknown as ReadonlyArray<bigint>), "invalid-construction");
  });
});

describe("flatten (DESIGN L217)", () => {
  it("expands one layer preserving order and duplicates", () => {
    const out = flatten([[1n, 2n], [3n]]);
    assert.deepEqual(out, [1n, 2n, 3n]);
    assert.deepEqual(flatten([[1n, 1n], [1n]]), [1n, 1n, 1n]);
    assert.ok(Object.isFrozen(out));
  });

  it("maps empty inputs to empty output", () => {
    assert.deepEqual(flatten([]), []);
    assert.deepEqual(flatten([[]]), []);
    assert.deepEqual(flatten([[], [1n], []]), [1n]);
  });

  it("expands exactly one layer and rejects non-array elements", () => {
    assert.deepEqual(flatten([[[1n]]]), [[1n]]);
    assertValueError(() => flatten([1n] as unknown as ReadonlyArray<ReadonlyArray<bigint>>), "invalid-construction");
    assertValueError(
      () => flatten([[1n], 2n] as unknown as ReadonlyArray<ReadonlyArray<bigint>>),
      "invalid-construction",
    );
    assertValueError(() => flatten(1n as unknown as ReadonlyArray<ReadonlyArray<bigint>>), "invalid-construction");
  });
});

describe("at (DESIGN L263)", () => {
  it("indexes zero-based", () => {
    assert.equal(at(["a", "b"], 0n), "a");
    assert.equal(at(["a", "b"], 1n), "b");
  });

  it("returns null for negative, out-of-range, huge, and empty indices", () => {
    assert.equal(at(["a", "b"], -1n), null);
    assert.equal(at(["a", "b"], 2n), null);
    assert.equal(at(["a", "b"], 100n), null);
    assert.equal(at(["a", "b"], 2n ** 100n), null);
    assert.equal(at([], 0n), null);
  });

  it("requires a bigint index and an array", () => {
    assertValueError(() => at([1n], 0 as unknown as bigint), "invalid-construction");
    assertValueError(() => at([1n], "0" as unknown as bigint), "invalid-construction");
    assertValueError(() => at(null as unknown as ReadonlyArray<bigint>, 0n), "invalid-construction");
  });
});

describe("count", () => {
  it("returns the length as a bigint int", () => {
    assert.equal(count([]), 0n);
    assert.equal(count(["x", "y", "z"]), 3n);
    assert.equal(typeof count([1n]), "bigint");
  });

  it("rejects non-array domains", () => {
    assertValueError(() => count(null as unknown as ReadonlyArray<bigint>), "invalid-construction");
  });
});

describe("sums (DESIGN L261 empty forms)", () => {
  it("sums ints with a typed zero and int64 checks", () => {
    assert.equal(sumInt([]), 0n);
    assert.equal(sumInt([1n, 2n, 3n]), 6n);
    assert.equal(sumInt([-5n, 5n]), 0n);
    assertValueError(() => sumInt([INT64_MAX, 1n]), "overflow");
    assertValueError(() => sumInt(["1"] as unknown as ReadonlyArray<bigint>), "invalid-construction");
  });

  it("sums decimals with a decimal zero and strict decimal elements", () => {
    assert.deepEqual(sumDecimal([]), new Decimal(0n, 0));
    const total = sumDecimal([new Decimal(10n, 1), new Decimal(200n, 2)]);
    assert.equal(compareDecimal(total, new Decimal(3n, 0)), 0);
    assertValueError(() => sumDecimal([1n] as unknown as ReadonlyArray<Decimal>), "invalid-construction");
  });

  it("sums durations with a zero and int64 checks", () => {
    assert.equal(sumDuration([]), 0n);
    assert.equal(sumDuration([1n, 2n]), 3n);
    assertValueError(() => sumDuration([INT64_MAX, 1n]), "overflow");
    assertValueError(() => sumDuration([1] as unknown as ReadonlyArray<bigint>), "invalid-construction");
  });

  it("sums money against an explicit currency, empty included", () => {
    assert.deepEqual(sumMoney([], "EUR"), { kind: "money", minor: 0n, currency: "EUR" });
    assert.deepEqual(sumMoney([makeMoney(100n, "EUR"), makeMoney(250n, "EUR")], "EUR"), {
      kind: "money",
      minor: 350n,
      currency: "EUR",
    });
    assertValueError(
      () => sumMoney([makeMoney(100n, "EUR"), makeMoney(100n, "USD")], "EUR"),
      "currency-mismatch",
    );
    assertValueError(() => sumMoney([1n] as never, "EUR"), "invalid-construction");
    assertValueError(() => sumMoney([], "ZZZ"), "unknown-currency");
    assertValueError(() => sumMoney([], "XXX"), "unknown-currency");
    assertValueError(() => sumMoney([], 5 as unknown as string), "invalid-construction");
  });

  it("sums money by first-currency validation without a currency, nonempty only", () => {
    assert.deepEqual(sumMoney([makeMoney(100n, "JPY")]), { kind: "money", minor: 100n, currency: "JPY" });
    assert.deepEqual(
      sumMoney([makeMoney(100n, "EUR"), makeMoney(50n, "EUR")]),
      makeMoney(150n, "EUR"),
    );
    assertValueError(() => sumMoney([]), "invalid-construction");
    assertValueError(
      () => sumMoney([makeMoney(100n, "EUR"), makeMoney(100n, "USD")]),
      "currency-mismatch",
    );
    assertValueError(() => sumMoney([1n] as never), "invalid-construction");
  });

  it("validates the inferred currency against the currency table (DESIGN L213)", () => {
    assertValueError(() => sumMoney([makeMoney(100n, "XXX")]), "unknown-currency");
    assertValueError(
      () => sumMoney([makeMoney(100n, "XXX"), makeMoney(100n, "EUR")]),
      "unknown-currency",
    );
    assertValueError(
      () => sumMoney([makeMoney(100n, "EUR"), makeMoney(100n, "XXX")]),
      "currency-mismatch",
    );
  });

  it("checks int/duration totals once, not per addition (DESIGN L213)", () => {
    assert.equal(sumInt([INT64_MAX, 1n, -INT64_MAX]), 1n);
    assert.equal(sumDuration([INT64_MAX, 1n, -INT64_MAX]), 1n);
    assertValueError(() => sumInt([INT64_MAX, INT64_MAX]), "overflow");
    assertValueError(() => sumDuration([INT64_MAX, INT64_MAX]), "overflow");
  });

  it("sums decimals exactly at max input scale with one 38-digit check", () => {
    assert.deepEqual(sumDecimal([new Decimal(1n, 1), new Decimal(2n, 1)]), new Decimal(3n, 1));
    assert.deepEqual(
      sumDecimal([new Decimal(1n, 1), new Decimal(25n, 2)]),
      new Decimal(35n, 2),
    );
    // Intermediate totals may exceed 38 digits while the total fits.
    const big = 10n ** 38n - 1n;
    assert.deepEqual(
      sumDecimal([new Decimal(big, 0), new Decimal(big, 0), new Decimal(-big, 0)]),
      new Decimal(big, 0),
    );
    assertValueError(
      () => sumDecimal([new Decimal(big, 0), new Decimal(big, 0)]),
      "overflow",
    );
  });
});

describe("min/max (DESIGN L261, L209 ordering)", () => {
  it("yield null over empty domains", () => {
    assert.equal(min([]), null);
    assert.equal(max([]), null);
  });

  it("selects int extremes", () => {
    assert.equal(min([3n, 1n, 2n]), 1n);
    assert.equal(max([3n, 1n, 2n]), 3n);
    assert.equal(min([-2n, -5n]), -5n);
    assert.equal(max([7n]), 7n);
  });

  it("orders text by Unicode scalar order, not UTF-16 units", () => {
    assert.equal(min(["b", "a"]), "a");
    assert.equal(max(["b", "a"]), "b");
    assert.equal(min(["ab", "a"]), "a");
    // U+E000 (BMP) sorts before U+10000 (astral) in scalar order; UTF-16
    // code-unit comparison would order them the other way (lead surrogate
    // D800 < E000), so this vector pins scalar order.
    const bmp = String.fromCodePoint(0xe000);
    const astral = String.fromCodePoint(0x10000);
    assert.ok(bmp < astral === false, "sanity: UTF-16 unit order differs here");
    assert.equal(min([bmp, astral]), bmp);
    assert.equal(max([bmp, astral]), astral);
    assert.equal(min(["b", astral, "a"]), "a");
  });

  it("compares decimals by value across scales", () => {
    assert.deepEqual(min([new Decimal(150n, 2), new Decimal(10n, 1)]), new Decimal(10n, 1));
    assert.deepEqual(max([new Decimal(150n, 2), new Decimal(10n, 1)]), new Decimal(150n, 2));
  });

  it("compares money with same-currency checks", () => {
    assert.deepEqual(min([makeMoney(200n, "EUR"), makeMoney(100n, "EUR")]), makeMoney(100n, "EUR"));
    assert.deepEqual(max([makeMoney(200n, "EUR"), makeMoney(100n, "EUR")]), makeMoney(200n, "EUR"));
    assertValueError(() => min([makeMoney(100n, "EUR"), makeMoney(100n, "USD")]), "currency-mismatch");
    assertValueError(() => max([makeMoney(100n, "EUR"), makeMoney(100n, "USD")]), "currency-mismatch");
    assertValueError(() => min([makeMoney(100n, "EUR"), 1n] as never), "invalid-construction");
  });

  it("compares dates and datetimes", () => {
    assert.deepEqual(min([makeDate(2024, 3, 1), makeDate(2024, 1, 1)]), makeDate(2024, 1, 1));
    assert.deepEqual(max([makeDate(2024, 3, 1), makeDate(2024, 1, 1)]), makeDate(2024, 3, 1));
    assert.deepEqual(min([makeDatetime(9n), makeDatetime(3n)]), makeDatetime(3n));
    assert.deepEqual(max([makeDatetime(9n), makeDatetime(3n)]), makeDatetime(9n));
  });

  it("compares durations as integer milliseconds", () => {
    assert.equal(min([3n, 1n]), 1n);
    assert.equal(max([3n, 1n]), 3n);
  });

  it("rejects mixed and unordered domains", () => {
    assertValueError(() => min([1n, "a"] as never), "invalid-construction");
    assertValueError(() => max([1n, new Decimal(10n, 1)] as never), "invalid-construction");
    assertValueError(() => min([new Decimal(10n, 1), 1n] as never), "invalid-construction");
    assertValueError(() => min([true, false]), "invalid-construction");
    assertValueError(() => min([null] as never), "invalid-construction");
    assertValueError(() => max([1n, null] as never), "invalid-construction");
    assertValueError(() => min(makeDate(2024, 1, 1) as never), "invalid-construction");
  });
});

describe("any/all (DESIGN L176)", () => {
  it("resolve empty domains to false/true", () => {
    assert.equal(any([], () => true), false);
    assert.equal(all([], () => false), true);
  });

  it("tests existentially with short-circuiting", () => {
    assert.equal(any([1n, 2n, 3n], (x) => x === 2n), true);
    assert.equal(any([1n, 2n, 3n], (x) => x === 9n), false);
    let calls = 0;
    assert.equal(
      any([1n, 2n, 3n], (x) => {
        calls += 1;
        return x === 1n;
      }),
      true,
    );
    assert.equal(calls, 1);
  });

  it("tests universally with short-circuiting", () => {
    assert.equal(all([2n, 4n], (x) => x % 2n === 0n), true);
    assert.equal(all([2n, 3n], (x) => x % 2n === 0n), false);
    let calls = 0;
    assert.equal(
      all([1n, 2n], (x) => {
        calls += 1;
        return x === 2n;
      }),
      false,
    );
    assert.equal(calls, 1);
  });

  it("requires function predicates returning booleans over arrays", () => {
    const notFn = null as unknown as (item: bigint) => boolean;
    const badReturn = (() => 1) as unknown as (item: bigint) => boolean;
    assertValueError(() => any([1n], notFn), "invalid-construction");
    assertValueError(() => all([1n], notFn), "invalid-construction");
    assertValueError(() => any([1n], badReturn), "invalid-construction");
    assertValueError(() => all([1n], badReturn), "invalid-construction");
    assertValueError(() => any(1n as unknown as ReadonlyArray<bigint>, () => true), "invalid-construction");
    assertValueError(() => all(1n as unknown as ReadonlyArray<bigint>, () => true), "invalid-construction");
  });
});

describe("first (DESIGN L176)", () => {
  it("returns the head element or null", () => {
    assert.equal(first([10n, 20n]), 10n);
    assert.equal(first([]), null);
    assertValueError(() => first(null as unknown as ReadonlyArray<bigint>), "invalid-construction");
  });
});

describe("group (DESIGN L263)", () => {
  it("groups by typed key in first-encounter order", () => {
    assert.deepEqual(group([1n, 2n, 1n], (x) => x), [
      { key: 1n, items: [1n, 1n] },
      { key: 2n, items: [2n] },
    ]);
    assert.deepEqual(group([2n, 1n, 2n], (x) => x).map((g) => g.key), [2n, 1n]);
  });

  it("preserves item encounter order inside groups", () => {
    const out = group([3n, 1n, 3n, 2n, 1n], (x) => x % 2n);
    assert.deepEqual(out, [
      { key: 1n, items: [3n, 1n, 3n, 1n] },
      { key: 0n, items: [2n] },
    ]);
  });

  it("emits exactly {key,items} objects, all frozen", () => {
    const out = group([1n, 2n], (x) => x);
    assert.deepEqual(
      out.map((g) => Object.keys(g)),
      [["key", "items"], ["key", "items"]],
    );
    assert.ok(Object.isFrozen(out));
    for (const g of out) {
      assert.ok(Object.isFrozen(g));
      assert.ok(Object.isFrozen(g.items));
    }
  });

  it("collects null keys into exactly one group", () => {
    const out = group([1n, null, 2n, null], (x) => x);
    assert.deepEqual(out, [
      { key: 1n, items: [1n] },
      { key: null, items: [null, null] },
      { key: 2n, items: [2n] },
    ]);
  });

  it("groups decimal keys by value across scales", () => {
    const out = group([new Decimal(10n, 1), new Decimal(100n, 2), new Decimal(15n, 1)], (x) => x);
    assert.equal(out.length, 2);
    assert.equal(compareDecimal(out[0]?.key as Decimal, new Decimal(1n, 0)), 0);
    assert.equal(out[0]?.items.length, 2);
    assert.equal(compareDecimal(out[1]?.key as Decimal, new Decimal(15n, 1)), 0);
  });

  it("groups money keys by full money equality without erroring", () => {
    const out = group(
      [makeMoney(100n, "EUR"), makeMoney(100n, "USD"), makeMoney(100n, "EUR")],
      (x) => x,
    );
    assert.deepEqual(out, [
      { key: makeMoney(100n, "EUR"), items: [makeMoney(100n, "EUR"), makeMoney(100n, "EUR")] },
      { key: makeMoney(100n, "USD"), items: [makeMoney(100n, "USD")] },
    ]);
    // Same currency but different amounts are unequal keys, not one group.
    assert.equal(group([makeMoney(100n, "EUR"), makeMoney(200n, "EUR")], (x) => x).length, 2);
  });

  it("groups ref keys by identity across versions", () => {
    const out = group(
      [makeRecordRef("M", "1", 1n), makeRecordRef("M", "2"), makeRecordRef("M", "1", 2n)],
      (x) => x,
    );
    assert.equal(out.length, 2);
    assert.deepEqual(out[0]?.items, [makeRecordRef("M", "1", 1n), makeRecordRef("M", "1", 2n)]);
    assert.deepEqual(out[0]?.key, makeRecordRef("M", "1", 1n));
  });

  it("groups user keys by id", () => {
    const out = group([makeUserRef("u1"), makeUserRef("u2"), makeUserRef("u1")], (x) => x);
    assert.deepEqual(out.map((g) => g.items.length), [2, 1]);
    assert.deepEqual(group([makeMemberRef("m1", makeUserRef("u1"), "t1")], (x) => x)[0]?.key, {
      kind: "member",
      id: "m1",
      user: { kind: "user", id: "u1" },
      team: "t1",
    });
  });

  it("handles empty domains and rejects bad key functions and mixed keys", () => {
    assert.deepEqual(group<bigint, bigint>([], (x) => x), []);
    assertValueError(
      () => group([1n], null as unknown as (item: bigint) => bigint),
      "invalid-construction",
    );
    assertValueError(
      () => group([1n, -1n], (x: bigint) => (x > 0n ? "pos" : 0n)),
      "invalid-construction",
    );
    assertValueError(
      () => group(1n as unknown as ReadonlyArray<bigint>, (x: bigint) => x),
      "invalid-construction",
    );
  });
});
