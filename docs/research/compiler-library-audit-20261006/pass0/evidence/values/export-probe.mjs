import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as values from "@canlang/values";

const vectors = JSON.parse(readFileSync(new URL("../../witnesses/values.json", import.meta.url), "utf8"));
const entry = import.meta.resolve("@canlang/values");
const results = [];
for (const test of vectors.cases) {
  let observation;
  try {
    if (test.boundary === "ordinary url value" || test.boundary === "locale admission and wire canonicalization") {
      const decoded = values.decodeValue(test.input.type, test.input.value);
      const encoded = values.encodeValue(test.input.type, decoded);
      observation = { valid: true, decoded, encoded };
      if (test.input.type === "locale") observation.canonical = values.canonicalLocale(test.input.value);
    } else if (test.boundary === "app_url injected origin") {
      observation = { valid: true, value: values.app_url(test.input.path, test.input.origin) };
    } else {
      const descriptor = values.makeMessageDescriptor(test.input.source, test.input.variants);
      observation = { valid: true, variants: descriptor.variants };
    }
  } catch (error) {
    observation = { valid: false, name: error.name, kind: error.kind ?? null, code: error.code ?? null, message: error.message };
  }
  let matches = observation.valid === test.expected.valid;
  if (test.expected.retained !== undefined) matches &&= observation.decoded === test.expected.retained && observation.encoded === test.expected.retained;
  if (test.expected.canonical !== undefined) matches &&= observation.canonical === test.expected.canonical && observation.encoded === test.expected.canonical;
  if (test.expected.value !== undefined) matches &&= observation.value === test.expected.value;
  if (test.expected.error_code !== undefined) matches &&= observation.code === test.expected.error_code;
  results.push({ id: test.id, observation, matches_expected: matches, readiness: test.readiness });
}
const exact = JSON.parse(readFileSync(new URL("../../witnesses/serialization-maps.json", import.meta.url), "utf8")).cases.find(test => test.id === "exact_wire_values");
const wireResults = exact.input.values.map(({ type, value, expected }) => {
  const decoded = values.decodeValue(type, value);
  const encoded = values.encodeValue(type, decoded);
  let matches = JSON.stringify(encoded) === JSON.stringify(expected.encoded);
  if (expected.bigint_decimal !== undefined) matches &&= typeof decoded === "bigint" && decoded.toString() === expected.bigint_decimal;
  if (expected.decimal_coef !== undefined) matches &&= typeof decoded.coef === "bigint" && decoded.coef.toString() === expected.decimal_coef && decoded.scale === expected.decimal_scale;
  if (expected.money_minor !== undefined) matches &&= typeof decoded.minor === "bigint" && decoded.minor.toString() === expected.money_minor && decoded.currency === expected.currency;
  return { type, input: value, decoded, encoded, matches_expected: matches };
});
console.log(JSON.stringify({
  scope: "current workspace public values exports; no installed tarball or Rust candidate equivalence claim",
  node: process.version, icu: process.versions.icu, entry,
  entry_sha256: createHash("sha256").update(readFileSync(fileURLToPath(entry))).digest("hex"),
  results, wire_results: wireResults,
}, (_, value) => typeof value === "bigint" ? { bigint_decimal: value.toString() } : value, 2));
if (results.some(result => !result.matches_expected) || wireResults.some(result => !result.matches_expected)) process.exitCode = 1;
