#!/usr/bin/env node
// Emits the versioned lane-02 catalog JSON from the single authored definition
// (src/catalog.ts) and validates its shape. Run after `npm run build`.
// Export-conformance against runtime implementations activates in PR5.
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

writeFileSync(outPath, `${JSON.stringify(CATALOG, null, 2)}\n`);
console.log(
  `catalog ${CATALOG.catalog_version}: ${CATALOG.entries.length} entries, ${CATALOG.features.length} features -> dist/catalog.json`,
);
