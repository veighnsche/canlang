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

  it("pins implemented factory arities against signature drift", () => {
    // Reviewed call shapes: renderPage(context, descriptor, children, shell?),
    // discovery (candidates, outcomes, options), factories (props). Optional
    // shell has no default, so renderPage.length counts it.
    const arities: Record<string, number> = {
      renderPage: 4,
      buildNavigation: 3,
      form: 1,
      edit: 1,
      deleteRecord: 1,
      action: 1,
      actions: 1,
      card: 1,
      title: 1,
      text: 1,
      content: 1,
      list: 1,
      table: 1,
      renderState: 1,
      collectionExportLink: 1,
      collectionPrintLink: 1,
    };
    const record = ui as unknown as Record<string, unknown>;
    for (const entry of UI_CATALOG.entries) {
      if (entry.availability !== "implemented") {
        continue;
      }
      const target = record[entry.js];
      assert.equal(typeof target, "function", `${entry.js} is not a function`);
      assert.equal(
        (target as (...args: never[]) => unknown).length,
        arities[entry.js],
        `${entry.js} arity drifted`,
      );
    }
  });
});
