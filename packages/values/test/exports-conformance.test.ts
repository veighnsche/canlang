import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { CATALOG } from "../src/catalog.js";
import * as index from "../src/index.js";

/**
 * Export conformance for the builtin catalog.
 *
 * (a) The emitted dist/catalog.json (test-only fixture consumption of `bun
 * run catalog` output) parses and deep-equals the imported authored CATALOG.
 * (b) Every implemented entry's js name is a function export of the barrel.
 *
 * Planned/external entries are never required here.
 */
describe("exports conformance", () => {
  it("emitted catalog.json deep-equals the authored CATALOG", (t) => {
    const emission = new URL("../catalog.json", import.meta.url);
    if (!existsSync(emission)) {
      t.skip("dist/catalog.json absent; run `bun run catalog` to exercise the emission fixture");
      return;
    }
    const parsed: unknown = JSON.parse(readFileSync(emission, "utf8"));
    assert.deepEqual(parsed, CATALOG);
  });

  it("every implemented entry resolves to a function export of the barrel", () => {
    const surface = index as unknown as Record<string, unknown>;
    const implemented = CATALOG.entries.filter((entry) => entry.availability === "implemented");
    assert.ok(implemented.length > 0);
    for (const entry of implemented) {
      assert.equal(typeof surface[entry.js], "function", entry.js);
    }
  });

  it("leaves planned and external entries out of the requirement", () => {
    const skipped = CATALOG.entries.filter((entry) => entry.availability !== "implemented");
    assert.ok(skipped.length > 0);
    const ids = skipped.map((entry) => entry.id);
    assert.ok(ids.includes("active_member"));
    assert.ok(ids.includes("random_secret"));
    for (const entry of skipped) {
      assert.equal(entry.availability, "external", entry.id);
    }
  });
});
