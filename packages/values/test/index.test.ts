import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  abs,
  action,
  all,
  any,
  app_url,
  at,
  canonicalLocale,
  compareScalar,
  concat,
  contains,
  count,
  decodeValue,
  encodeValue,
  equalValue,
  first,
  flatten,
  format,
  formatMessage,
  formatPlain,
  group,
  join,
  lower,
  makeMessageDescriptor,
  max,
  min,
  normalizeSchema,
  parseMessageFormat,
  parseTypeId,
  renderMessage,
  resolveVariant,
  scalarChars,
  scalarLength,
  same,
  starts_with,
  sum,
  sumDecimal,
  sumDuration,
  sumInt,
  sumMoney,
  trim,
  upper,
  validateMessagePattern,
  validateOperationInput,
  validateValue,
} from "../src/index.js";

/**
 * The barrel uses `export *`, which silently drops conflicting names. Static
 * imports fail at load when a name is missing, so referencing every PR4
 * headline export here pins the assembled surface.
 */
describe("values barrel", () => {
  it("re-exports the PR4 text/array/equality surface", () => {
    const functions: ReadonlyArray<unknown> = [
      abs, action, all, any, app_url, at, canonicalLocale, compareScalar,
      concat, contains, count, decodeValue, encodeValue, equalValue, first,
      flatten, format, formatMessage, formatPlain, group, join, lower,
      makeMessageDescriptor, max, min, normalizeSchema, parseMessageFormat,
      parseTypeId, renderMessage, resolveVariant, scalarChars, scalarLength,
      same, starts_with, sum, sumDecimal, sumDuration, sumInt, sumMoney,
      trim, upper, validateMessagePattern, validateOperationInput, validateValue,
    ];
    for (const fn of functions) {
      assert.equal(typeof fn, "function");
    }
  });
});
