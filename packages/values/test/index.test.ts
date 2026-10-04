import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  all,
  any,
  at,
  canonicalLocale,
  compareScalar,
  concat,
  contains,
  count,
  equalValue,
  first,
  flatten,
  formatMessage,
  formatPlain,
  group,
  join,
  lower,
  makeMessageDescriptor,
  max,
  min,
  parseMessageFormat,
  renderMessage,
  resolveVariant,
  scalarChars,
  scalarLength,
  same,
  starts_with,
  sumDecimal,
  sumDuration,
  sumInt,
  sumMoney,
  trim,
  upper,
  validateMessagePattern,
} from "../src/index.js";

/**
 * The barrel uses `export *`, which silently drops conflicting names. Static
 * imports fail at load when a name is missing, so referencing every PR4
 * headline export here pins the assembled surface.
 */
describe("values barrel", () => {
  it("re-exports the PR4 text/array/equality surface", () => {
    const functions: ReadonlyArray<unknown> = [
      all, any, at, canonicalLocale, compareScalar, concat, contains, count,
      equalValue, first, flatten, formatMessage, formatPlain, group, join,
      lower, makeMessageDescriptor, max, min, parseMessageFormat, renderMessage,
      resolveVariant, scalarChars, scalarLength, same, starts_with, sumDecimal,
      sumDuration, sumInt, sumMoney, trim, upper, validateMessagePattern,
    ];
    for (const fn of functions) {
      assert.equal(typeof fn, "function");
    }
  });
});
