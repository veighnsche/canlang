import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as ui from "../src/index.js";
import { LANE05_CATALOG_VERSION, UI_CATALOG } from "../src/catalog.js";

describe("component catalog", () => {
  it("has a versioned envelope with unique lane-05 component entries", () => {
    assert.equal(UI_CATALOG.catalog_version, LANE05_CATALOG_VERSION);
    assert.equal(UI_CATALOG.language_version, null);
    const ids = UI_CATALOG.entries.map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const entry of UI_CATALOG.entries) {
      assert.equal(entry.owner, "lane-05");
      assert.equal(entry.kind, "component");
      assert.ok(entry.js.length > 0);
      assert.ok(entry.signature.length > 0);
    }
  });

  it("matches implemented entries to real exports, with no phantoms", () => {
    const exported = new Set(Object.keys(ui));
    for (const entry of UI_CATALOG.entries) {
      if (entry.availability === "implemented") {
        assert.ok(
          exported.has(entry.js),
          `catalog claims implemented ${entry.js} but index does not export it`,
        );
      } else {
        assert.ok(
          !exported.has(entry.js),
          `catalog claims planned ${entry.js} but index already exports it`,
        );
      }
    }
  });
});
