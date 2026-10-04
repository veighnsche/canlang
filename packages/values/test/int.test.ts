import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ValueError } from "../src/errors.js";
import {
  INT64_MAX,
  INT64_MIN,
  absInt,
  addInt,
  compareInt,
  int64,
  modInt,
  multiplyInt,
  negateInt,
  subtractInt,
} from "../src/int.js";

const SEED = 20261004;

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

function inInt64(v: bigint): boolean {
  return v >= INT64_MIN && v <= INT64_MAX;
}

/** Uniform random int64 from a seeded stream, edges injected every 16th draw. */
function randomInt64(rand: () => number, draws: { count: number }): bigint {
  draws.count += 1;
  const edges: ReadonlyArray<bigint> = [INT64_MIN, INT64_MIN + 1n, -1n, 0n, 1n, INT64_MAX - 1n, INT64_MAX];
  if (draws.count % 16 === 0) {
    return edges[Math.floor(rand() * edges.length) % edges.length] as bigint;
  }
  const hi = BigInt(Math.floor(rand() * 4294967296));
  const lo = BigInt(Math.floor(rand() * 4294967296));
  const unsigned = hi * 4294967296n + lo;
  return unsigned >= 2n ** 63n ? unsigned - 2n ** 64n : unsigned;
}

describe("int64 narrowing", () => {
  it("accepts the bound values and zero", () => {
    assert.equal(int64(INT64_MIN), INT64_MIN);
    assert.equal(int64(INT64_MAX), INT64_MAX);
    assert.equal(int64(0n), 0n);
  });

  it("rejects out-of-range bigints with overflow", () => {
    assertValueError(() => int64(INT64_MIN - 1n), "overflow");
    assertValueError(() => int64(INT64_MAX + 1n), "overflow");
    assertValueError(() => int64(2n ** 100n), "overflow");
  });

  it("rejects non-bigint inputs without Number routing", () => {
    assertValueError(() => int64(5 as unknown as bigint), "invalid-construction");
    assertValueError(() => int64("5" as unknown as bigint), "invalid-construction");
    assertValueError(() => addInt(1 as unknown as bigint, 2n), "invalid-construction");
  });

  it("stays exact beyond 2^53", () => {
    const big = 2n ** 53n + 1n;
    assert.equal(addInt(big, 1n), 2n ** 53n + 2n);
    assert.equal(String(big), "9007199254740993");
  });
});

describe("checked int arithmetic vectors", () => {
  it("adds at the bounds", () => {
    assert.equal(addInt(INT64_MAX, 0n), INT64_MAX);
    assert.equal(addInt(INT64_MAX, -1n), INT64_MAX - 1n);
    assertValueError(() => addInt(INT64_MAX, 1n), "overflow");
    assertValueError(() => addInt(INT64_MIN, -1n), "overflow");
    assertValueError(() => addInt(INT64_MAX, INT64_MAX), "overflow");
    assertValueError(() => addInt(INT64_MIN, INT64_MIN), "overflow");
  });

  it("subtracts at the bounds", () => {
    assert.equal(subtractInt(INT64_MIN, 0n), INT64_MIN);
    assertValueError(() => subtractInt(INT64_MIN, 1n), "overflow");
    assertValueError(() => subtractInt(INT64_MAX, -1n), "overflow");
    assertValueError(() => subtractInt(INT64_MIN, INT64_MAX), "overflow");
  });

  it("multiplies at the bounds", () => {
    assert.equal(multiplyInt(INT64_MAX, 1n), INT64_MAX);
    assert.equal(multiplyInt(0n, INT64_MIN), 0n);
    assertValueError(() => multiplyInt(INT64_MAX, 2n), "overflow");
    assertValueError(() => multiplyInt(INT64_MIN, 2n), "overflow");
    assertValueError(() => multiplyInt(INT64_MIN, -1n), "overflow");
    assertValueError(() => multiplyInt(2n ** 32n, 2n ** 32n), "overflow");
  });

  it("takes remainders with the dividend sign and fails on zero", () => {
    assert.equal(modInt(7n, 3n), 1n);
    assert.equal(modInt(-7n, 3n), -1n);
    assert.equal(modInt(7n, -3n), 1n);
    assert.equal(modInt(-7n, -3n), -1n);
    assert.equal(modInt(INT64_MIN, -1n), 0n);
    assertValueError(() => modInt(7n, 0n), "division-by-zero");
    assertValueError(() => modInt(0n, 0n), "division-by-zero");
  });

  it("negates with signed-minimum overflow", () => {
    assert.equal(negateInt(0n), 0n);
    assert.equal(negateInt(5n), -5n);
    assert.equal(negateInt(INT64_MAX), -INT64_MAX);
    assertValueError(() => negateInt(INT64_MIN), "overflow");
  });

  it("abs shares negation overflow boundaries", () => {
    assert.equal(absInt(0n), 0n);
    assert.equal(absInt(-5n), 5n);
    assert.equal(absInt(INT64_MAX), INT64_MAX);
    assertValueError(() => absInt(INT64_MIN), "overflow");
  });

  it("compares with -1/0/1, exact past int64", () => {
    assert.equal(compareInt(-3n, 2n), -1);
    assert.equal(compareInt(2n, 2n), 0);
    assert.equal(compareInt(3n, 2n), 1);
    assert.equal(compareInt(2n ** 100n, 2n ** 100n + 1n), -1);
    assertValueError(() => compareInt(1 as unknown as bigint, 2n), "invalid-construction");
  });
});

describe("seeded int properties", () => {
  it("add/sub/mul agree with the exact BigInt oracle plus range check", () => {
    const rand = mulberry32(SEED);
    const draws = { count: 0 };
    for (let i = 0; i < 300; i += 1) {
      const a = randomInt64(rand, draws);
      const b = randomInt64(rand, draws);
      const cases: ReadonlyArray<readonly [bigint, () => bigint]> = [
        [a + b, () => addInt(a, b)],
        [a - b, () => subtractInt(a, b)],
        [a * b, () => multiplyInt(a, b)],
      ];
      for (const [exact, run] of cases) {
        if (inInt64(exact)) {
          assert.equal(run(), exact);
        } else {
          assertValueError(run, "overflow");
        }
      }
    }
  });

  it("mod satisfies the truncated-division identity", () => {
    const rand = mulberry32(SEED + 1);
    const draws = { count: 0 };
    for (let i = 0; i < 300; i += 1) {
      const a = randomInt64(rand, draws);
      let b = randomInt64(rand, draws);
      if (i % 5 === 0) b = 0n;
      if (b === 0n) {
        assertValueError(() => modInt(a, b), "division-by-zero");
        continue;
      }
      const r = modInt(a, b);
      const q = a / b;
      assert.equal(a, q * b + r);
      const absR = r < 0n ? -r : r;
      const absB = b < 0n ? -b : b;
      assert.ok(absR < absB);
      if (r !== 0n) {
        assert.equal(r < 0n, a < 0n);
      }
    }
  });

  it("negate is an involution and compare is a trichotomy", () => {
    const rand = mulberry32(SEED + 2);
    const draws = { count: 0 };
    for (let i = 0; i < 300; i += 1) {
      const a = randomInt64(rand, draws);
      const b = randomInt64(rand, draws);
      if (a !== INT64_MIN) {
        assert.equal(negateInt(negateInt(a)), a);
      }
      const ab = compareInt(a, b);
      const ba = compareInt(b, a);
      assert.equal(ab, a < b ? -1 : a > b ? 1 : 0);
      assert.equal(ab + ba, 0);
      assert.ok(absInt(a === INT64_MIN ? 0n : a) >= 0n);
    }
  });
});
