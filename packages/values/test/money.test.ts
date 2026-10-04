import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CURRENCY_MINOR_UNITS } from "../src/currency-data.js";
import { Decimal, compareDecimal, decimalToString, parseDecimal } from "../src/decimal.js";
import { ValueError } from "../src/errors.js";
import { INT64_MAX, INT64_MIN } from "../src/int.js";
import { makeMoney } from "../src/kinds.js";
import {
  absMoney,
  addMoney,
  compareMoney,
  currencyScale,
  divideMoney,
  equalMoney,
  isKnownCurrency,
  money,
  moneyRatio,
  multiplyMoney,
  negateMoney,
  subtractMoney,
} from "../src/money.js";

const SEED = 20261006;
const CURRENCIES: ReadonlyArray<string> = Object.keys(CURRENCY_MINOR_UNITS).sort();

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

/** Independent half-even digit-string oracle (mirrors decimal.test.ts). */
function oracleRoundDigits(digits: string, drop: number): string {
  if (drop <= 0) return digits;
  const padded = digits.padStart(drop + 1, "0");
  const kept = padded.slice(0, padded.length - drop);
  const dropped = padded.slice(padded.length - drop);
  const half = "5" + "0".repeat(drop - 1);
  let up = false;
  if (dropped > half) {
    up = true;
  } else if (dropped === half) {
    up = Number(kept[kept.length - 1] as string) % 2 === 1;
  }
  if (!up) return kept;
  const arr = kept.split("");
  let i = arr.length - 1;
  while (i >= 0 && arr[i] === "9") {
    arr[i] = "0";
    i -= 1;
  }
  if (i < 0) {
    arr.unshift("1");
  } else {
    arr[i] = String(Number(arr[i]) + 1);
  }
  return arr.join("");
}

function randomDigits(rand: () => number, length: number): string {
  let out = String(1 + Math.floor(rand() * 9));
  for (let i = 1; i < length; i += 1) {
    out += String(Math.floor(rand() * 10));
  }
  return out;
}

function randomMinor(rand: () => number, maxDigits: number): bigint {
  const digits = 1 + Math.floor(rand() * maxDigits);
  const v = BigInt(randomDigits(rand, digits));
  return rand() < 0.5 ? -v : v;
}

function randomDecimal(rand: () => number, maxDigits: number, maxScale: number): Decimal {
  const coef = randomMinor(rand, maxDigits);
  return new Decimal(rand() < 0.1 ? 0n : coef, Math.floor(rand() * (maxScale + 1)));
}

function randomCurrency(rand: () => number, draws: { count: number }): string {
  draws.count += 1;
  const forced = ["JPY", "KWD", "CLF", "UYW", "USD", "EUR"];
  if (draws.count % 5 === 0) {
    return forced[draws.count % forced.length] as string;
  }
  return CURRENCIES[Math.floor(rand() * CURRENCIES.length) % CURRENCIES.length] as string;
}

describe("currency admission", () => {
  it("pins ISO 4217 minor-unit scales", () => {
    assert.equal(currencyScale("USD"), 2);
    assert.equal(currencyScale("EUR"), 2);
    assert.equal(currencyScale("JPY"), 0);
    assert.equal(currencyScale("KRW"), 0);
    assert.equal(currencyScale("KWD"), 3);
    assert.equal(currencyScale("BHD"), 3);
    assert.equal(currencyScale("JOD"), 3);
    assert.equal(currencyScale("CLF"), 4);
    assert.equal(currencyScale("UYW"), 4);
    assert.ok(isKnownCurrency("USD"));
    assert.ok(!isKnownCurrency("XXX"));
    assert.ok(!isKnownCurrency("usd"));
    assert.ok(!isKnownCurrency(5));
  });

  it("pins the full table: 165 members with 0/2/3/4-decimal counts", () => {
    assert.equal(CURRENCIES.length, 165);
    const counts = new Map<number, number>();
    for (const code of CURRENCIES) {
      const scale = CURRENCY_MINOR_UNITS[code] as number;
      counts.set(scale, (counts.get(scale) ?? 0) + 1);
    }
    assert.deepEqual([...counts.entries()].sort(), [
      [0, 17],
      [2, 139],
      [3, 7],
      [4, 2],
    ]);
  });

  it("rejects unknown currencies and non-strings", () => {
    for (const bad of ["XXX", "XAU", "XDR", "XTS", "USA", "usd", "EURO", "", "US D"]) {
      assertValueError(() => currencyScale(bad), "unknown-currency");
      assertValueError(() => money(1n, bad), "unknown-currency");
    }
    assertValueError(() => currencyScale(5 as unknown as string), "invalid-construction");
    assertValueError(() => money("25" as unknown as bigint, "EUR"), "invalid-construction");
  });
});

describe("money construction", () => {
  it("converts ints exactly to minor units", () => {
    assert.deepEqual(money(25n, "EUR"), { kind: "money", minor: 2500n, currency: "EUR" });
    assert.deepEqual(money(5n, "JPY"), { kind: "money", minor: 5n, currency: "JPY" });
    assert.deepEqual(money(-3n, "KWD"), { kind: "money", minor: -3000n, currency: "KWD" });
    assert.deepEqual(money(2n, "CLF"), { kind: "money", minor: 20000n, currency: "CLF" });
  });

  it("converts decimals without shortening exactly", () => {
    assert.deepEqual(money(parseDecimal("2.50"), "EUR"), { kind: "money", minor: 250n, currency: "EUR" });
    assert.deepEqual(money(parseDecimal("2.5"), "EUR"), { kind: "money", minor: 250n, currency: "EUR" });
    assert.deepEqual(money(parseDecimal("7"), "JPY"), { kind: "money", minor: 7n, currency: "JPY" });
  });

  it("rounds once half-even to the pinned scale", () => {
    const cases: ReadonlyArray<readonly [string, string, bigint]> = [
      ["0.005", "USD", 0n],
      ["0.015", "USD", 2n],
      ["0.025", "USD", 2n],
      ["0.035", "USD", 4n],
      ["2.675", "USD", 268n],
      ["-0.015", "USD", -2n],
      ["-0.025", "USD", -2n],
      ["0.5", "JPY", 0n],
      ["1.5", "JPY", 2n],
      ["2.5", "JPY", 2n],
      ["0.0005", "KWD", 0n],
      ["0.0015", "KWD", 2n],
      ["0.0025", "KWD", 2n],
      ["0.00005", "CLF", 0n],
      ["0.00015", "CLF", 2n],
      ["0.00025", "CLF", 2n],
    ];
    for (const [text, currency, minor] of cases) {
      assert.deepEqual(money(parseDecimal(text), currency), { kind: "money", minor, currency });
    }
  });

  it("checks minor:int at the boundary", () => {
    assert.deepEqual(money(INT64_MAX, "JPY"), { kind: "money", minor: INT64_MAX, currency: "JPY" });
    assert.deepEqual(money(INT64_MIN, "JPY"), { kind: "money", minor: INT64_MIN, currency: "JPY" });
    assertValueError(() => money(INT64_MAX, "USD"), "overflow");
    assertValueError(() => money(2n ** 62n, "USD"), "overflow");
    assertValueError(() => money(INT64_MIN, "USD"), "overflow");
  });
});

describe("money add/subtract", () => {
  it("adds and subtracts same-currency amounts", () => {
    assert.deepEqual(addMoney(makeMoney(100n, "USD"), makeMoney(250n, "USD")), {
      kind: "money",
      minor: 350n,
      currency: "USD",
    });
    assert.deepEqual(subtractMoney(makeMoney(100n, "USD"), makeMoney(250n, "USD")), {
      kind: "money",
      minor: -150n,
      currency: "USD",
    });
  });

  it("rejects mixed currencies and mistyped inputs", () => {
    assertValueError(() => addMoney(makeMoney(1n, "USD"), makeMoney(1n, "EUR")), "currency-mismatch");
    assertValueError(() => subtractMoney(makeMoney(1n, "USD"), makeMoney(1n, "JPY")), "currency-mismatch");
    assertValueError(() => addMoney(1n as unknown as never, makeMoney(1n, "USD")), "invalid-construction");
  });

  it("checks minor:int overflow", () => {
    assertValueError(() => addMoney(makeMoney(INT64_MAX, "USD"), makeMoney(1n, "USD")), "overflow");
    assertValueError(() => subtractMoney(makeMoney(INT64_MIN, "USD"), makeMoney(1n, "USD")), "overflow");
  });
});

describe("money multiply/divide", () => {
  it("scales by int factors exactly", () => {
    const dollar = money(1n, "USD");
    assert.deepEqual(multiplyMoney(dollar, 2n), { kind: "money", minor: 200n, currency: "USD" });
    assert.deepEqual(multiplyMoney(dollar, 0n), { kind: "money", minor: 0n, currency: "USD" });
    assert.deepEqual(multiplyMoney(dollar, -1n), { kind: "money", minor: -100n, currency: "USD" });
    assert.deepEqual(multiplyMoney(dollar, 1n), dollar);
    assertValueError(() => multiplyMoney(makeMoney(INT64_MAX, "USD"), 2n), "overflow");
  });

  it("scales by decimal factors rounding once half-even", () => {
    const cases: ReadonlyArray<readonly [bigint, string, bigint]> = [
      [100n, "0.5", 50n],
      [1n, "0.5", 0n],
      [3n, "0.5", 2n],
      [5n, "0.5", 2n],
      [3n, "1.5", 4n],
      [5n, "1.5", 8n],
      [100n, "-0.5", -50n],
    ];
    for (const [minor, factor, expected] of cases) {
      assert.deepEqual(multiplyMoney(makeMoney(minor, "USD"), parseDecimal(factor)), {
        kind: "money",
        minor: expected,
        currency: "USD",
      });
    }
    assertValueError(() => multiplyMoney(makeMoney(1n, "USD"), "2" as unknown as Decimal), "invalid-construction");
  });

  it("divides by int/decimal rounding once half-even", () => {
    const cases: ReadonlyArray<readonly [bigint, Decimal | bigint, bigint]> = [
      [1n, 2n, 0n],
      [3n, 2n, 2n],
      [5n, 2n, 2n],
      [7n, 2n, 4n],
      [1n, 3n, 0n],
      [5n, 3n, 2n],
      [100n, 4n, 25n],
      [5n, -2n, -2n],
      [100n, parseDecimal("0.5"), 200n],
      [100n, parseDecimal("3"), 33n],
      [1n, parseDecimal("0.5"), 2n],
    ];
    for (const [minor, divisor, expected] of cases) {
      assert.deepEqual(divideMoney(makeMoney(minor, "USD"), divisor), {
        kind: "money",
        minor: expected,
        currency: "USD",
      });
    }
  });

  it("fails on zero divisors and mistyped inputs", () => {
    assertValueError(() => divideMoney(makeMoney(1n, "USD"), 0n), "division-by-zero");
    assertValueError(() => divideMoney(makeMoney(1n, "USD"), parseDecimal("0.00")), "division-by-zero");
    assertValueError(() => divideMoney(makeMoney(1n, "USD"), "2" as unknown as Decimal), "invalid-construction");
    assertValueError(() => divideMoney(1n as unknown as never, 2n), "invalid-construction");
  });
});

describe("money ratio/compare/equality", () => {
  it("takes same-currency ratios as decimals", () => {
    assert.equal(decimalToString(moneyRatio(makeMoney(100n, "USD"), makeMoney(300n, "USD"))), "0.333333333333333333");
    assert.deepEqual(moneyRatio(makeMoney(200n, "EUR"), makeMoney(100n, "EUR")), new Decimal(2n, 0));
    assert.deepEqual(moneyRatio(makeMoney(0n, "USD"), makeMoney(5n, "USD")), new Decimal(0n, 0));
    assertValueError(() => moneyRatio(makeMoney(1n, "USD"), makeMoney(1n, "EUR")), "currency-mismatch");
    assertValueError(() => moneyRatio(makeMoney(1n, "USD"), makeMoney(0n, "USD")), "division-by-zero");
  });

  it("orders same-currency amounts and fails across currencies", () => {
    assert.equal(compareMoney(makeMoney(100n, "USD"), makeMoney(200n, "USD")), -1);
    assert.equal(compareMoney(makeMoney(200n, "USD"), makeMoney(200n, "USD")), 0);
    assert.equal(compareMoney(makeMoney(300n, "USD"), makeMoney(200n, "USD")), 1);
    assertValueError(() => compareMoney(makeMoney(1n, "USD"), makeMoney(1n, "EUR")), "currency-mismatch");
  });

  it("decides equality across currencies as unequal, never an error", () => {
    assert.ok(equalMoney(makeMoney(100n, "USD"), makeMoney(100n, "USD")));
    assert.ok(!equalMoney(makeMoney(100n, "USD"), makeMoney(200n, "USD")));
    assert.ok(!equalMoney(makeMoney(100n, "USD"), makeMoney(100n, "EUR")));
    assertValueError(() => equalMoney(1n as unknown as never, makeMoney(1n, "USD")), "invalid-construction");
  });
});

describe("money negate/abs/outputs", () => {
  it("negates and takes abs with int64 checks", () => {
    assert.deepEqual(negateMoney(money(1n, "USD")), { kind: "money", minor: -100n, currency: "USD" });
    assert.deepEqual(absMoney(money(-1n, "USD")), { kind: "money", minor: 100n, currency: "USD" });
    assertValueError(() => negateMoney(makeMoney(INT64_MIN, "USD")), "overflow");
    assertValueError(() => absMoney(makeMoney(INT64_MIN, "USD")), "overflow");
  });

  it("freezes every value output", () => {
    assert.ok(Object.isFrozen(money(1n, "USD")));
    assert.ok(Object.isFrozen(addMoney(makeMoney(1n, "USD"), makeMoney(2n, "USD"))));
    assert.ok(Object.isFrozen(multiplyMoney(makeMoney(2n, "USD"), 3n)));
    assert.ok(Object.isFrozen(moneyRatio(makeMoney(2n, "USD"), makeMoney(4n, "USD"))));
  });
});

describe("seeded money properties", () => {
  it("adds then subtracts back exactly", () => {
    const rand = mulberry32(SEED);
    const draws = { count: 0 };
    for (let i = 0; i < 200; i += 1) {
      const currency = randomCurrency(rand, draws);
      const a = makeMoney(randomMinor(rand, 12), currency);
      const b = makeMoney(randomMinor(rand, 12), currency);
      assert.deepEqual(subtractMoney(addMoney(a, b), b), a);
      assert.deepEqual(addMoney(a, b), addMoney(b, a));
    }
  });

  it("multiplies then divides by nonzero ints exactly", () => {
    const rand = mulberry32(SEED + 1);
    const draws = { count: 0 };
    for (let i = 0; i < 200; i += 1) {
      const currency = randomCurrency(rand, draws);
      const m = makeMoney(randomMinor(rand, 9), currency);
      let k = randomMinor(rand, 6);
      if (k === 0n) k = 7n;
      assert.deepEqual(divideMoney(multiplyMoney(m, k), k), m);
    }
  });

  it("constructs from decimals per the exact/oracle rule", () => {
    const rand = mulberry32(SEED + 2);
    const draws = { count: 0 };
    for (let i = 0; i < 250; i += 1) {
      const currency = randomCurrency(rand, draws);
      const scale = CURRENCY_MINOR_UNITS[currency] as number;
      const d = randomDecimal(rand, 12, 10);
      const got = money(d, currency);
      let expected: bigint;
      if (d.scale <= scale) {
        expected = d.coef * 10n ** BigInt(scale - d.scale);
      } else {
        const negative = d.coef < 0n;
        const kept = oracleRoundDigits((negative ? -d.coef : d.coef).toString(), d.scale - scale);
        expected = BigInt((negative ? "-" : "") + kept);
      }
      assert.equal(got.minor, expected);
      assert.equal(got.currency, currency);
    }
  });

  it("scales by decimals per the oracle and divides to nearest with even ties", () => {
    const rand = mulberry32(SEED + 3);
    const draws = { count: 0 };
    for (let i = 0; i < 200; i += 1) {
      const currency = randomCurrency(rand, draws);
      const m = makeMoney(randomMinor(rand, 9), currency);
      const f = randomDecimal(rand, 8, 4);
      const exact = m.minor * f.coef;
      const negative = exact < 0n;
      const kept = oracleRoundDigits((negative ? -exact : exact).toString(), f.scale);
      assert.deepEqual(multiplyMoney(m, f), {
        kind: "money",
        minor: BigInt((negative ? "-" : "") + kept),
        currency,
      });
      if (f.coef === 0n) {
        assertValueError(() => divideMoney(m, f), "division-by-zero");
        continue;
      }
      const num = m.minor * 10n ** BigInt(f.scale);
      const den = f.coef;
      const q = divideMoney(m, f);
      const diff = num - q.minor * den;
      const absDiff = diff < 0n ? -diff : diff;
      const absDen = den < 0n ? -den : den;
      const twice = absDiff * 2n;
      assert.ok(twice <= absDen, "money division must round to nearest");
      if (twice === absDen) {
        assert.equal(q.minor % 2n, 0n, "money division ties break to even");
      }
    }
  });

  it("ratios to one, compares by minor order, and separates currencies", () => {
    const rand = mulberry32(SEED + 4);
    const draws = { count: 0 };
    for (let i = 0; i < 150; i += 1) {
      const currency = randomCurrency(rand, draws);
      const a = makeMoney(randomMinor(rand, 12), currency);
      const b = makeMoney(randomMinor(rand, 12), currency);
      if (a.minor !== 0n) {
        assert.equal(compareDecimal(moneyRatio(a, a), new Decimal(1n, 0)), 0);
      }
      const expected = a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0;
      assert.equal(compareMoney(a, b), expected);
      assert.equal(equalMoney(a, b), a.minor === b.minor);
      let other = randomCurrency(rand, draws);
      if (other === currency) {
        other = currency === "USD" ? "EUR" : "USD";
      }
      const c = makeMoney(a.minor, other);
      assert.equal(equalMoney(a, c), false);
      assertValueError(() => compareMoney(a, c), "currency-mismatch");
    }
  });
});
