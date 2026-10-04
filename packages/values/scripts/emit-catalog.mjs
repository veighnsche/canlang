#!/usr/bin/env node
// Emits the versioned lane-02 catalog JSON from the single authored definition
// (src/catalog.ts), validates its shape, and asserts export conformance:
// every implemented entry resolves to a function export of the built dist
// index. Run after `bun run build`.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG } from "../dist/values/src/catalog.js";

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, "..", "dist", "catalog.json");

function fail(message) {
  console.error(`catalog emit failed: ${message}`);
  process.exit(1);
}

if (typeof CATALOG.catalog_version !== "string" || CATALOG.catalog_version.length === 0) {
  fail("catalog_version must be a non-empty string");
}
if (!Array.isArray(CATALOG.entries) || CATALOG.entries.length === 0) {
  fail("entries must be a non-empty array");
}
if (!Array.isArray(CATALOG.features) || CATALOG.features.length === 0) {
  fail("features must be a non-empty array");
}
const seen = new Set();
for (const entry of CATALOG.entries) {
  for (const field of ["id", "js", "owner", "kind", "signature", "effects", "availability"]) {
    if (typeof entry[field] !== "string" || entry[field].length === 0) {
      fail(`entry ${JSON.stringify(entry.id)} has invalid ${field}`);
    }
  }
  if (entry.kind !== "builtin" && entry.kind !== "helper") fail(`bad kind ${entry.kind}`);
  if (!["pure", "server-default-only", "state-read"].includes(entry.effects)) {
    fail(`bad effects ${entry.effects}`);
  }
  if (!["planned", "implemented", "external"].includes(entry.availability)) {
    fail(`bad availability ${entry.availability}`);
  }
  const key = `${entry.kind}:${entry.id}`;
  if (seen.has(key)) fail(`duplicate entry ${key}`);
  seen.add(key);
}

// Export conformance (PR5): every implemented entry must resolve to a
// function export of the built dist index. Planned/external entries are
// never required.
const runtime = await import("../dist/values/src/index.js");
for (const entry of CATALOG.entries) {
  if (entry.availability !== "implemented") continue;
  if (typeof runtime[entry.js] !== "function") {
    fail(`implemented entry ${entry.kind}:${entry.id} (js ${entry.js}) is not a function export`);
  }
}

writeFileSync(outPath, `${JSON.stringify(CATALOG, null, 2)}\n`);
console.log(
  `catalog ${CATALOG.catalog_version}: ${CATALOG.entries.length} entries, ${CATALOG.features.length} features -> dist/catalog.json`,
);
