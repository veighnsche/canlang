import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Decimal as OracleDecimal } from "decimal.js";
import {
  Decimal,
  absDecimal,
  addDecimal,
  divideDecimal,
  multiplyDecimal,
  negateDecimal,
  parseDecimal,
  round,
  subtractDecimal,
} from "../src/decimal.js";
import { ValueError } from "../src/errors.js";

/**
 * Independent decimal oracle: 200 seeded cases plus explicit edge vectors
 * cross-check our add/sub/mul/div/abs/round/negate (including int/decimal
 * mixes where our signatures accept them) against Decimal.js.
 *
 * Our pipeline, mirrored from src/decimal.ts: compute the mathematical
 * result, round half-even to at most 18 fractional places (add/sub are
 * always exact at the max input scale; mul rounds only when the summed
 * scale exceeds 18; div keeps terminating results at minimal scale and
 * rounds repeating ones half-even to 18), then check the 38-significant-
 * digit representation bound (breaches throw `overflow`).
 *
 * Oracle configuration: Decimal.clone({ precision: 38, rounding:
 * ROUND_HALF_EVEN }). Comparison is by numeric VALUE (Decimal.equals on
 * an exact re-parse of our coef/scale), never by scale.
 *
 * Principled differences (documented, not failures):
 * 1. Decimal.js rounds EVERY operation to 38 significant digits; our
 *    add/sub/mul compute exactly and CHECK 38 digits (overflow throws).
 *    Generated operands keep exact results within 38 digits so both sides
 *    are exact; explicit overflow vectors assert ours throws where the
 *    oracle silently rounds (still finite).
 * 2. Division shape: ours yields minimal-scale terminating or half-even-
 *    to-18 results; the oracle yields 38 significant digits. The oracle
 *    side is finished with toDecimalPlaces(18, HALF_EVEN) before compare.
 *    Double-rounding caveat: the oracle's 38-sig rounding followed by an
 *    18-place rounding could in theory differ from direct 18-place
 *    rounding of the true value. Operand bounds (quotients <= 1e18, so at
 *    least 19 true places survive at 38 significant digits) plus the fixed
 *    seed keep this check exact; any mismatch fails loudly.
 * 3. Division by zero: ours throws `division-by-zero`; the oracle yields
 *    Infinity (Can has no Infinity). Zero-divisor vectors assert ours
 *    throws and the oracle is non-finite.
 * 4. abs/negate take Decimal only in our signatures (no bigint overload),
 *    so mixes apply to add/sub/mul/div/round; abs/negate cases use
 *    Decimal operands.
 */

const DJ = OracleDecimal.clone({ precision: 38, rounding: OracleDecimal.ROUND_HALF_EVEN });

const SEED = 20261007;
const CASES = 200;

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

function digitRun(rand: () => number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    const digit = i === 0 && length > 1 ? 1 + Math.floor(rand() * 9) : Math.floor(rand() * 10);
    out += String(digit);
  }
  return out;
}

function intText(rand: () => number, maxDigits: number): string {
  const sign = rand() < 0.35 ? "-" : "";
  return sign + digitRun(rand, 1 + Math.floor(rand() * maxDigits));
}

function decText(rand: () => number, maxInt: number, maxFrac: number): string {
  const sign = rand() < 0.35 ? "-" : "";
  const frac = digitRun(rand, Math.floor(rand() * (maxFrac + 1)));
  const head = `${sign}${digitRun(rand, 1 + Math.floor(rand() * maxInt))}`;
  return frac === "" ? `${head}.0` : `${head}.${frac}`;
}

const EDGE_TEXTS: ReadonlyArray<string> = [
  "0", "1", "-1", "2", "-2", "0.5", "-0.5", "2.5", "-2.5", "3.5",
  "0.1", "-0.1", "0.01", "10", "100", "1000000", "0.000001",
  "999999.999999", "-999999.999999", "123456.789", "7", "8", "3",
];

function edgeText(rand: () => number): string {
  return EDGE_TEXTS[Math.floor(rand() * EDGE_TEXTS.length)] as string;
}

interface Operand {
  readonly text: string;
  readonly asInt: boolean;
}

function toOurs(op: Operand): Decimal | bigint {
  return op.asInt ? BigInt(op.text) : parseDecimal(op.text);
}

function toTheirs(op: Operand): InstanceType<typeof DJ> {
  return new DJ(op.text);
}

/** Exact plain decimal text of our (coef, scale): the value oracle input. */
function toPlain(value: Decimal): string {
  const negative = value.coef < 0n;
  const digits = (negative ? -value.coef : value.coef).toString();
  const padded = digits.length > value.scale ? digits : digits.padStart(value.scale + 1, "0");
  const intPart = value.scale === 0 ? padded : padded.slice(0, padded.length - value.scale);
  const fracPart = value.scale === 0 ? "" : padded.slice(padded.length - value.scale);
  return `${negative ? "-" : ""}${intPart}${fracPart === "" ? "" : `.${fracPart}`}`;
}

function assertSameValue(ours: Decimal, theirs: InstanceType<typeof DJ>, label: string): void {
  const finished = theirs.toDecimalPlaces(18, OracleDecimal.ROUND_HALF_EVEN);
  const oursAgain = new DJ(toPlain(ours));
  assert.ok(
    oursAgain.equals(finished),
    `${label}: ours ${toPlain(ours)} (scale ${ours.scale}) vs oracle ${finished.toString()}`,
  );
}

type Op = "add" | "sub" | "mul" | "div" | "abs" | "round" | "negate";
const OPS: ReadonlyArray<Op> = ["add", "sub", "mul", "div", "abs", "round", "negate"];

function mixedOperand(rand: () => number, draws: number, maxInt: number, maxFrac: number): Operand {
  if (draws % 8 === 0) {
    const text = edgeText(rand);
    return { text, asInt: !text.includes(".") && rand() < 0.5 };
  }
  if (rand() < 0.3) {
    return { text: intText(rand, maxInt), asInt: true };
  }
  return { text: decText(rand, maxInt, maxFrac), asInt: false };
}

describe("decimal oracle (Decimal.js, 38 digits, half-even)", () => {
  it("runs the oracle at 38-digit precision, half-even", () => {
    assert.equal(new DJ("0.5").toDecimalPlaces(0, OracleDecimal.ROUND_HALF_EVEN).toString(), "0");
    assert.equal(new DJ("1.5").toDecimalPlaces(0, OracleDecimal.ROUND_HALF_EVEN).toString(), "2");
    // 2/3 at 38 significant digits ends ...6667; re-rounding to 37 places
    // rounds that trailing 7 up. (At precision 20 the tail would be zeros.)
    const third = new DJ(2).div(3).toDecimalPlaces(37).toString();
    assert.equal(third, `0.${"6".repeat(36)}7`);
  });

  it("matches across 200 seeded mixed cases", () => {
    const rand = mulberry32(SEED);
    let draws = 0;
    for (let index = 0; index < CASES; index += 1) {
      const op = OPS[index % OPS.length] as Op;
      draws += 1;
      if (op === "abs" || op === "negate") {
        const operand: Operand =
          draws % 8 === 0
            ? { text: edgeText(rand), asInt: false }
            : { text: decText(rand, 12, 15), asInt: false };
        const input = parseDecimal(operand.text);
        const ours = op === "abs" ? absDecimal(input) : negateDecimal(input);
        const theirs = op === "abs" ? toTheirs(operand).abs() : toTheirs(operand).negated();
        assertSameValue(ours, theirs, `case ${index} ${op}(${operand.text})`);
        continue;
      }
      if (op === "round") {
        const operand = mixedOperand(rand, draws, 12, 15);
        const scale = Math.floor(rand() * 19);
        const ours = round(toOurs(operand), scale);
        const theirs = toTheirs(operand).toDecimalPlaces(scale, OracleDecimal.ROUND_HALF_EVEN);
        assertSameValue(ours, theirs, `case ${index} round(${operand.text},${scale})`);
        continue;
      }
      const bounds = op === "div" ? { maxInt: 12, maxFrac: 6 } : op === "mul" ? { maxInt: 6, maxFrac: 12 } : { maxInt: 12, maxFrac: 12 };
      const left = mixedOperand(rand, draws, bounds.maxInt, bounds.maxFrac);
      draws += 1;
      let right = mixedOperand(rand, draws, bounds.maxInt, bounds.maxFrac);
      if (op === "div" && new DJ(right.text).isZero()) {
        right = { text: "1", asInt: rand() < 0.5 };
      }
      const a = toOurs(left);
      const b = toOurs(right);
      const x = toTheirs(left);
      const y = toTheirs(right);
      const label = `case ${index} ${op}(${left.text},${right.text})`;
      if (op === "add") assertSameValue(addDecimal(a, b), x.plus(y), label);
      else if (op === "sub") assertSameValue(subtractDecimal(a, b), x.minus(y), label);
      else if (op === "mul") assertSameValue(multiplyDecimal(a, b), x.times(y), label);
      else assertSameValue(divideDecimal(a, b), x.div(y), label);
    }
  });

  it("agrees on terminating and repeating division", () => {
    assertSameValue(divideDecimal(1n, 8n), new DJ(1).div(8), "1/8");
    assertSameValue(divideDecimal(-1n, 8n), new DJ(-1).div(8), "-1/8");
    assertSameValue(divideDecimal(1n, 3n), new DJ(1).div(3), "1/3");
    assertSameValue(divideDecimal(22n, 7n), new DJ(22).div(7), "22/7");
    const eighth = divideDecimal(1n, 8n);
    assert.equal(eighth.coef, 125n);
    assert.equal(eighth.scale, 3);
    assert.equal(divideDecimal(1n, 3n).scale, 18);
  });

  it("agrees on half-even ties", () => {
    for (const [text, scale, coef] of [["2.5", 0, 2n], ["3.5", 0, 4n], ["-2.5", 0, -2n]] as const) {
      const ours = round(parseDecimal(text), scale);
      assert.equal(ours.coef, coef);
      assertSameValue(ours, new DJ(text).toDecimalPlaces(scale, OracleDecimal.ROUND_HALF_EVEN), `tie ${text}`);
    }
  });

  it("throws division-by-zero where the oracle goes infinite", () => {
    for (const zero of ["0", "0.0"]) {
      const divisor = parseDecimal(zero);
      assertValueError(() => divideDecimal(parseDecimal("1.5"), divisor), "division-by-zero");
      assert.ok(!new DJ("1.5").div(new DJ(zero)).isFinite());
    }
    assertValueError(() => divideDecimal(5n, 0n), "division-by-zero");
  });

  it("throws overflow where the oracle silently rounds", () => {
    const huge = parseDecimal("9".repeat(38));
    assertValueError(() => addDecimal(huge, 1n), "overflow");
    assert.ok(new DJ("9".repeat(38)).plus(1).isFinite());
    const wide = parseDecimal("9".repeat(20));
    assertValueError(() => multiplyDecimal(wide, wide), "overflow");
  });
});
