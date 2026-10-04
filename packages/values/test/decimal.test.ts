import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Decimal,
  absDecimal,
  addDecimal,
  compareDecimal,
  decimalToString,
  divideDecimal,
  divideDurationMs,
  equalDecimal,
  isDecimal,
  multiplyDecimal,
  negateDecimal,
  parseDecimal,
  round,
  subtractDecimal,
} from "../src/decimal.js";
import { ValueError } from "../src/errors.js";
import { INT64_MAX, INT64_MIN } from "../src/int.js";
import { makeMoney } from "../src/kinds.js";

const SEED = 20261005;
const NINES_38 = "99999999999999999999999999999999999999";

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

/**
 * Independent half-even oracle over digit strings (no shared code with the
 * implementation): round integer `digits` (no sign) dropping `drop` low
 * digits. Returns the kept digit string.
 */
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

function oracleDigitsLength(digits: string): number {
  const stripped = digits.replace(/^0+/, "");
  return stripped === "" ? 1 : stripped.length;
}

function randomDigits(rand: () => number, length: number): string {
  let out = String(1 + Math.floor(rand() * 9));
  for (let i = 1; i < length; i += 1) {
    out += String(Math.floor(rand() * 10));
  }
  return out;
}

/** Random decimal with coef up to maxDigits digits and scale up to maxScale. */
function randomDecimal(rand: () => number, maxDigits: number, maxScale: number, allowZero: boolean): Decimal {
  const digits = 1 + Math.floor(rand() * maxDigits);
  let coef = BigInt(randomDigits(rand, digits));
  if (rand() < 0.5) coef = -coef;
  if (allowZero && rand() < 0.1) coef = 0n;
  const scale = Math.floor(rand() * (maxScale + 1));
  return new Decimal(coef, scale);
}

describe("decimal construction", () => {
  it("builds frozen values and guards shapes", () => {
    const d = new Decimal(250n, 2);
    assert.deepEqual(d, new Decimal(250n, 2));
    assert.ok(Object.isFrozen(d));
    assert.ok(isDecimal(d));
    assert.ok(isDecimal({ kind: "decimal", coef: 1n, scale: 0 }));
    assert.ok(!isDecimal({ kind: "decimal", coef: 1n, scale: 19 }));
    assert.ok(!isDecimal({ kind: "decimal", coef: 1, scale: 0 }));
    assert.ok(!isDecimal({ kind: "decimal", coef: 10n ** 38n, scale: 0 }));
    assert.ok(!isDecimal(null));
  });

  it("rejects malformed construction", () => {
    assertValueError(() => new Decimal(5 as unknown as bigint, 0), "invalid-construction");
    assertValueError(() => new Decimal(5n, 1.5), "invalid-construction");
    assertValueError(() => new Decimal(5n, -1), "out-of-range");
    assertValueError(() => new Decimal(5n, 19), "out-of-range");
    assertValueError(() => new Decimal(BigInt(NINES_38 + "9"), 0), "out-of-range");
  });
});

describe("decimal parsing", () => {
  it("parses exact strings with retained scale", () => {
    assert.deepEqual(parseDecimal("0"), new Decimal(0n, 0));
    assert.deepEqual(parseDecimal("-0"), new Decimal(0n, 0));
    assert.deepEqual(parseDecimal("2"), new Decimal(2n, 0));
    assert.deepEqual(parseDecimal("-2.5"), new Decimal(-25n, 1));
    assert.deepEqual(parseDecimal("1.00"), new Decimal(100n, 2));
    assert.deepEqual(parseDecimal("0.005"), new Decimal(5n, 3));
    assert.deepEqual(parseDecimal("007"), new Decimal(7n, 0));
    assert.deepEqual(parseDecimal(NINES_38), new Decimal(BigInt(NINES_38), 0));
  });

  it("rejects malformed text", () => {
    for (const bad of ["", "-", ".", ".5", "5.", "1e3", "+1", " 1", "1 ", "1,000", "0x1", "NaN", "--1", "1..2"]) {
      assertValueError(() => parseDecimal(bad), "invalid-construction");
    }
    assertValueError(() => parseDecimal(5 as unknown as string), "invalid-construction");
  });

  it("rejects bound-breaching inputs instead of rounding them", () => {
    assertValueError(() => parseDecimal("1.0000000000000000001"), "out-of-range");
    assertValueError(() => parseDecimal(`${NINES_38}9`), "out-of-range");
    assertValueError(() => parseDecimal(`0.${"0".repeat(18)}1`), "out-of-range");
  });
});

describe("canonical decimal strings", () => {
  it("normalizes per R2a", () => {
    const cases: ReadonlyArray<readonly [bigint, number, string]> = [
      [0n, 0, "0"],
      [0n, 5, "0"],
      [200n, 2, "2"],
      [250n, 2, "2.5"],
      [-250n, 2, "-2.5"],
      [5n, 3, "0.005"],
      [-5n, 3, "-0.005"],
      [100n, 0, "100"],
      [10n, 1, "1"],
      [101n, 2, "1.01"],
      [10000000000000000009n, 18, "10.000000000000000009"],
    ];
    for (const [coef, scale, expected] of cases) {
      assert.equal(decimalToString(new Decimal(coef, scale)), expected);
    }
  });

  it("stays exact beyond 2^53", () => {
    assert.equal(decimalToString(parseDecimal("9007199254740993")), "9007199254740993");
    assert.equal(decimalToString(parseDecimal("-9007199254740993.25")), "-9007199254740993.25");
  });

  it("rejects non-decimals", () => {
    assertValueError(() => decimalToString("2.5" as unknown as Decimal), "invalid-construction");
  });
});

describe("decimal add/subtract vectors", () => {
  it("computes exact sums, retaining produced scale", () => {
    assert.deepEqual(addDecimal(parseDecimal("0.1"), parseDecimal("0.2")), new Decimal(3n, 1));
    assert.deepEqual(addDecimal(parseDecimal("1.0"), parseDecimal("2.00")), new Decimal(300n, 2));
    assert.deepEqual(addDecimal(1n, parseDecimal("0.5")), new Decimal(15n, 1));
    assert.deepEqual(addDecimal(-2n, 5n), new Decimal(3n, 0));
    assert.deepEqual(subtractDecimal(parseDecimal("1.0"), parseDecimal("0.9")), new Decimal(1n, 1));
    assert.deepEqual(subtractDecimal(parseDecimal("0.3"), parseDecimal("0.1")), new Decimal(2n, 1));
    assert.deepEqual(subtractDecimal(parseDecimal("2.00"), 2n), new Decimal(0n, 2));
  });

  it("overflows past 38 significant digits", () => {
    assertValueError(() => addDecimal(parseDecimal(NINES_38), 1n), "overflow");
    assertValueError(() => addDecimal(parseDecimal(NINES_38), parseDecimal("0.1")), "overflow");
    assertValueError(() => subtractDecimal(parseDecimal(`-${NINES_38}`), 1n), "overflow");
    assert.deepEqual(addDecimal(parseDecimal(NINES_38), 0n), new Decimal(BigInt(NINES_38), 0));
  });
});

describe("decimal multiply vectors", () => {
  it("keeps exact products at summed scale", () => {
    assert.deepEqual(multiplyDecimal(parseDecimal("0.1"), parseDecimal("0.2")), new Decimal(2n, 2));
    assert.deepEqual(multiplyDecimal(parseDecimal("1.5"), parseDecimal("1.5")), new Decimal(225n, 2));
    assert.deepEqual(multiplyDecimal(3n, parseDecimal("0.1")), new Decimal(3n, 1));
    assert.deepEqual(multiplyDecimal(parseDecimal("0.05"), parseDecimal("0.05")), new Decimal(25n, 4));
  });

  it("rounds half-even to 18 places past scale 36", () => {
    const a = parseDecimal("9.999999999999999999");
    const b = parseDecimal("1.000000000000000001");
    assert.deepEqual(multiplyDecimal(a, b), new Decimal(10000000000000000009n, 18));
    assert.deepEqual(multiplyDecimal(negateDecimal(a), b), new Decimal(-10000000000000000009n, 18));
  });

  it("overflows past 38 significant digits", () => {
    assertValueError(() => multiplyDecimal(parseDecimal(NINES_38), 10n), "overflow");
    assertValueError(
      () => multiplyDecimal(parseDecimal("100000000000000000000"), parseDecimal("100000000000000000000")),
      "overflow",
    );
  });
});

describe("decimal division vectors", () => {
  it("retains exact terminating results at minimal scale", () => {
    assert.deepEqual(divideDecimal(1n, 2n), new Decimal(5n, 1));
    assert.deepEqual(divideDecimal(10n, 4n), new Decimal(25n, 1));
    assert.deepEqual(divideDecimal(1n, 8n), new Decimal(125n, 3));
    assert.deepEqual(divideDecimal(7n, 2n), new Decimal(35n, 1));
    assert.deepEqual(divideDecimal(-7n, 2n), new Decimal(-35n, 1));
    assert.deepEqual(divideDecimal(7n, -2n), new Decimal(-35n, 1));
    assert.deepEqual(divideDecimal(-7n, -2n), new Decimal(35n, 1));
    assert.deepEqual(divideDecimal(0n, 5n), new Decimal(0n, 0));
    assert.deepEqual(divideDecimal(1n, 2000n), new Decimal(5n, 4));
    assert.deepEqual(divideDecimal(parseDecimal("25"), parseDecimal("100")), new Decimal(25n, 2));
  });

  it("rounds repeating results half-even to 18 places", () => {
    assert.equal(decimalToString(divideDecimal(1n, 3n)), "0.333333333333333333");
    assert.equal(decimalToString(divideDecimal(2n, 3n)), "0.666666666666666667");
    assert.equal(decimalToString(divideDecimal(10n, 3n)), "3.333333333333333333");
    assert.equal(decimalToString(divideDecimal(1n, 6n)), "0.166666666666666667");
    assert.equal(decimalToString(divideDecimal(5n, 6n)), "0.833333333333333333");
    assert.equal(decimalToString(divideDecimal(1n, 7n)), "0.142857142857142857");
    assert.equal(decimalToString(divideDecimal(100n, 7n)), "14.285714285714285714");
  });

  it("breaks exact ties to even", () => {
    const quintillion = 10n ** 19n;
    assert.deepEqual(divideDecimal(5n, quintillion), new Decimal(0n, 18));
    assert.deepEqual(divideDecimal(15n, quintillion), new Decimal(2n, 18));
    assert.deepEqual(divideDecimal(25n, quintillion), new Decimal(2n, 18));
    assert.deepEqual(divideDecimal(-15n, quintillion), new Decimal(-2n, 18));
  });

  it("fails on zero divisors", () => {
    assertValueError(() => divideDecimal(1n, 0n), "division-by-zero");
    assertValueError(() => divideDecimal(0n, 0n), "division-by-zero");
    assertValueError(() => divideDecimal(parseDecimal("1"), parseDecimal("0.00")), "division-by-zero");
  });

  it("overflows past 38 significant digits", () => {
    assertValueError(() => divideDecimal(parseDecimal(NINES_38), parseDecimal("0.1")), "overflow");
    assert.deepEqual(divideDecimal(parseDecimal(NINES_38), 1n), new Decimal(BigInt(NINES_38), 0));
  });

  it("divides money/money ratios with decimal rounding", () => {
    assert.equal(decimalToString(divideDecimal(makeMoney(100n, "USD"), makeMoney(300n, "USD"))), "0.333333333333333333");
    assert.deepEqual(divideDecimal(makeMoney(200n, "EUR"), makeMoney(100n, "EUR")), new Decimal(2n, 0));
    assertValueError(() => divideDecimal(makeMoney(1n, "USD"), makeMoney(1n, "EUR")), "currency-mismatch");
    assertValueError(() => divideDecimal(makeMoney(1n, "USD"), 2n), "invalid-construction");
    assertValueError(() => divideDecimal(1n, makeMoney(1n, "USD")), "invalid-construction");
    assertValueError(() => divideDecimal({ kind: "money" } as unknown as Decimal, 1n), "invalid-construction");
    assertValueError(() => divideDecimal(makeMoney(1n, "USD"), makeMoney(0n, "USD")), "division-by-zero");
  });

  it("divides duration milliseconds to decimals", () => {
    assert.deepEqual(divideDurationMs(7n, 2n), new Decimal(35n, 1));
    assert.deepEqual(divideDurationMs(-7n, 2n), new Decimal(-35n, 1));
    assert.deepEqual(divideDurationMs(2n ** 60n, 7n), divideDecimal(2n ** 60n, 7n));
    assertValueError(() => divideDurationMs(2n ** 100n, 3n), "overflow");
    assertValueError(() => divideDecimal(2n ** 100n, 3n), "overflow");
    assertValueError(() => divideDurationMs(1n, 0n), "division-by-zero");
    assertValueError(() => divideDurationMs(1 as unknown as bigint, 2n), "invalid-construction");
  });

  it("int64-narrows both duration inputs at entry", () => {
    // Out-of-range inputs throw on either side, even when the ratio itself
    // would fit in 38 digits (3/2^100 rounds to 0 at scale 18).
    assertValueError(() => divideDurationMs(2n ** 100n, 3n), "overflow");
    assertValueError(() => divideDurationMs(3n, 2n ** 100n), "overflow");
    assertValueError(() => divideDurationMs(-(2n ** 100n), 3n), "overflow");
    assertValueError(() => divideDurationMs(3n, -(2n ** 100n)), "overflow");
    // int64 extremes still divide exactly.
    assert.deepEqual(divideDurationMs(INT64_MAX, INT64_MAX), new Decimal(1n, 0));
    assert.deepEqual(divideDurationMs(INT64_MIN, 2n), new Decimal(-(2n ** 62n), 0));
  });
});

describe("round vectors", () => {
  it("rounds half-even (banker)", () => {
    const cases: ReadonlyArray<readonly [string, number, bigint, number]> = [
      ["2.5", 0, 2n, 0],
      ["3.5", 0, 4n, 0],
      ["-2.5", 0, -2n, 0],
      ["-3.5", 0, -4n, 0],
      ["0.5", 0, 0n, 0],
      ["1.5", 0, 2n, 0],
      ["0.15", 1, 2n, 1],
      ["0.25", 1, 2n, 1],
      ["0.35", 1, 4n, 1],
      ["2.675", 2, 268n, 2],
      ["2.665", 2, 266n, 2],
      ["-2.675", 2, -268n, 2],
      ["2.5", 1, 25n, 1],
      ["2.5", 5, 250000n, 5],
    ];
    for (const [text, scale, coef, outScale] of cases) {
      assert.deepEqual(round(parseDecimal(text), scale), new Decimal(coef, outScale));
    }
    assert.deepEqual(round(5n, 2), new Decimal(500n, 2));
    assert.deepEqual(round(-5n, 0), new Decimal(-5n, 0));
  });

  it("fails outside scale 0..18", () => {
    assertValueError(() => round(parseDecimal("1.5"), -1), "out-of-range");
    assertValueError(() => round(parseDecimal("1.5"), 19), "out-of-range");
    assertValueError(() => round(parseDecimal("1.5"), 1.5), "invalid-construction");
    assertValueError(() => round(parseDecimal(NINES_38), 18), "overflow");
  });
});

describe("decimal compare/negate/abs", () => {
  it("compares by value across scales and int mixes", () => {
    assert.ok(equalDecimal(parseDecimal("1.0"), parseDecimal("1.00")));
    assert.equal(compareDecimal(parseDecimal("1.5"), parseDecimal("1.51")), -1);
    assert.equal(compareDecimal(1n, parseDecimal("0.9")), 1);
    assert.equal(compareDecimal(2n, parseDecimal("2.00")), 0);
    assert.equal(compareDecimal(parseDecimal("-0.1"), -1n), 1);
  });

  it("negates and takes abs exactly, preserving scale", () => {
    assert.deepEqual(negateDecimal(parseDecimal("2.50")), new Decimal(-250n, 2));
    assert.deepEqual(negateDecimal(parseDecimal("-2.50")), new Decimal(250n, 2));
    assert.deepEqual(absDecimal(parseDecimal("-2.50")), new Decimal(250n, 2));
    assert.deepEqual(absDecimal(parseDecimal("2.50")), new Decimal(250n, 2));
    assert.ok(Object.isFrozen(absDecimal(parseDecimal("-1"))));
  });

  it("rejects mistyped operands without Number routing", () => {
    assertValueError(() => addDecimal("1" as unknown as Decimal, 2n), "invalid-construction");
    assertValueError(() => divideDecimal(1 as unknown as Decimal, 2 as unknown as Decimal), "invalid-construction");
    assertValueError(() => negateDecimal(5n as unknown as Decimal), "invalid-construction");
    assertValueError(() => round("2.5" as unknown as Decimal, 0), "invalid-construction");
  });
});

describe("seeded decimal properties", () => {
  it("round agrees with the digit-string oracle", () => {
    const rand = mulberry32(SEED);
    for (let i = 0; i < 300; i += 1) {
      const d = randomDecimal(rand, 38, 18, true);
      const target = Math.floor(rand() * 19);
      if (target >= d.scale) {
        const growth = target - d.scale;
        const digits = d.coef === 0n ? 1 : d.coef.toString().replace("-", "").length + growth;
        if (digits > 38) {
          assertValueError(() => round(d, target), "overflow");
        } else {
          assert.deepEqual(round(d, target), new Decimal(d.coef * 10n ** BigInt(growth), target));
        }
        continue;
      }
      const negative = d.coef < 0n;
      const kept = oracleRoundDigits((negative ? -d.coef : d.coef).toString(), d.scale - target);
      const expected = BigInt((negative ? "-" : "") + kept);
      assert.deepEqual(round(d, target), new Decimal(expected, target));
    }
  });

  it("multiply agrees with the exact product plus digit-string oracle", () => {
    const rand = mulberry32(SEED + 1);
    for (let i = 0; i < 200; i += 1) {
      const a = randomDecimal(rand, 20, 18, true);
      const b = randomDecimal(rand, 20, 18, true);
      const exact = a.coef * b.coef;
      const exactScale = a.scale + b.scale;
      if (exactScale <= 18) {
        if (oracleDigitsLength(exact.toString().replace("-", "")) > 38) {
          assertValueError(() => multiplyDecimal(a, b), "overflow");
        } else {
          assert.deepEqual(multiplyDecimal(a, b), new Decimal(exact, exactScale));
        }
        continue;
      }
      const negative = exact < 0n;
      const kept = oracleRoundDigits((negative ? -exact : exact).toString(), exactScale - 18);
      if (oracleDigitsLength(kept) > 38) {
        assertValueError(() => multiplyDecimal(a, b), "overflow");
      } else {
        assert.deepEqual(multiplyDecimal(a, b), new Decimal(BigInt((negative ? "-" : "") + kept), 18));
      }
    }
  });

  it("division returns the nearest value with even ties and minimal exact scale", () => {
    const rand = mulberry32(SEED + 2);
    for (let i = 0; i < 300; i += 1) {
      const a = randomDecimal(rand, 8, 4, true);
      const b = randomDecimal(rand, 6, 2, false);
      if (b.coef === 0n) continue;
      const num = a.coef * 10n ** BigInt(b.scale);
      const den = b.coef * 10n ** BigInt(a.scale);
      const q = divideDecimal(a, b);
      const scaled = num * 10n ** BigInt(q.scale) - q.coef * den;
      const diff = scaled < 0n ? -scaled : scaled;
      const absDen = den < 0n ? -den : den;
      const twice = diff * 2n;
      assert.ok(twice <= absDen, `not nearest: ${decimalToString(a)}/${decimalToString(b)}`);
      if (twice === absDen) {
        assert.equal(q.coef % 2n, 0n, "tie must break to even");
      }
      if (diff === 0n) {
        if (q.scale > 0) {
          const coarser = num * 10n ** BigInt(q.scale - 1);
          assert.notEqual(coarser % den, 0n, "exact result must keep minimal scale");
        }
      } else {
        assert.equal(q.scale, 18);
      }
      const exactSign = (num < 0n) !== (den < 0n) ? -1 : num === 0n ? 0 : 1;
      const expectedSign = q.coef === 0n ? 0 : exactSign;
      assert.equal(compareDecimal(q, 0n), expectedSign);
    }
  });

  it("stringifies and reparses to the same value and stable text", () => {
    const rand = mulberry32(SEED + 3);
    for (let i = 0; i < 300; i += 1) {
      const d = randomDecimal(rand, 38, 18, true);
      const text = decimalToString(d);
      assert.match(text, /^-?\d+(\.\d+)?$/);
      const back = parseDecimal(text);
      assert.equal(compareDecimal(back, d), 0);
      assert.equal(decimalToString(back), text);
    }
  });

  it("obeys exact algebra: commutativity, cancellation, involution", () => {
    const rand = mulberry32(SEED + 4);
    for (let i = 0; i < 200; i += 1) {
      const a = randomDecimal(rand, 18, 6, true);
      const b = randomDecimal(rand, 18, 6, true);
      assert.deepEqual(addDecimal(a, b), addDecimal(b, a));
      assert.deepEqual(multiplyDecimal(a, b), multiplyDecimal(b, a));
      assert.equal(compareDecimal(subtractDecimal(addDecimal(a, b), b), a), 0);
      assert.deepEqual(negateDecimal(negateDecimal(a)), a);
      assert.deepEqual(addDecimal(a, 0n), a);
      assert.deepEqual(multiplyDecimal(a, 1n), a);
    }
  });

  it("recovers factors through exact division", () => {
    const rand = mulberry32(SEED + 5);
    for (let i = 0; i < 200; i += 1) {
      const a = randomDecimal(rand, 10, 4, true);
      const b = randomDecimal(rand, 6, 2, false);
      if (b.coef === 0n) continue;
      const product = multiplyDecimal(a, b);
      const back = divideDecimal(product, b);
      assert.equal(compareDecimal(back, a), 0);
      assert.equal(decimalToString(back), decimalToString(a));
    }
  });
});
