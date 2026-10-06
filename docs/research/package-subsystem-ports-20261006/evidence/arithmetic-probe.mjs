import assert from "node:assert/strict";
import { addInt, subtractInt, multiplyInt, modInt, compareInt } from "../../../../packages/values/src/int.ts";
import { Decimal, addDecimal, multiplyDecimal, divideDecimal, compareDecimal } from "../../../../packages/values/src/decimal.ts";
import { sumInt, sumDecimal } from "../../../../packages/values/src/array.ts";

const H = 10n ** 1000n;
const C = 10n ** 38n - 1n;
const observations = [];
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name);
  observations.push({ name, actual });
}
const parts = value => ({ coef: value.coef, scale: value.scale });
check("addInt(H, -H)", addInt(H, -H), 0n);
check("subtractInt(H, H)", subtractInt(H, H), 0n);
check("multiplyInt(H, 0n)", multiplyInt(H, 0n), 0n);
check("modInt(H, 3n)", modInt(H, 3n), 1n);
check("compareInt(H, H + 1n)", compareInt(H, H + 1n), -1);
check("sumInt([H, 1n, -H])", sumInt([H, 1n, -H]), 1n);
check("addDecimal(H, -H)", parts(addDecimal(H, -H)), {coef: 0n, scale: 0});
check("multiplyDecimal(H, 0n)", parts(multiplyDecimal(H, 0n)), {coef: 0n, scale: 0});
check("divideDecimal(H, H)", parts(divideDecimal(H, H)), {coef: 1n, scale: 0});
check("divideDecimal(1n, H)", parts(divideDecimal(1n, H)), {coef: 0n, scale: 18});
check("compareDecimal(H, H + 1n)", compareDecimal(H, H + 1n), -1);
check("modInt(INT64_MIN, -1n)", modInt(-(2n ** 63n), -1n), 0n);
check("wide product with valid rounded result", parts(multiplyDecimal(new Decimal(10n ** 27n, 18), new Decimal(10n ** 27n, 18))), {coef: 10n ** 36n, scale: 18});
check("wide scaled division", parts(divideDecimal(new Decimal(C, 18), new Decimal(C, 18))), {coef: 1n, scale: 0});
check("mixed-scale cancellation retaining zero scale", parts(sumDecimal([new Decimal(C, 0), new Decimal(-C, 0), new Decimal(0n, 18)])), {coef: 0n, scale: 18});
const magnitudeBits = value => value.toString(2).length;
const bounds = {
  coefficient: magnitudeBits(C),
  alignedBinary: magnitudeBits(C * (10n ** 18n + 1n)),
  product: magnitudeBits(C * C),
  scaledDivision: magnitudeBits(C * 10n ** 36n),
  aggregateU64: magnitudeBits(C * 10n ** 18n * (2n ** 64n - 1n)),
};
assert.ok(bounds.coefficient <= 127);
assert.ok(Object.values(bounds).every(bits => bits <= 255));
console.log(JSON.stringify({
  status: "passed",
  runtime: "Bun importing current TypeScript source directly",
  observations,
  magnitudeBits: bounds,
  scope: "15 targeted existing-TS behavior observations plus mathematical width checks; no Rust/Wasm implementation or benchmark",
}, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
