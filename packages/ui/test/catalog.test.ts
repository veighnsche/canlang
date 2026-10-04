import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as ui from "../src/index.js";
import { LANE05_CATALOG_VERSION, UI_CATALOG } from "../src/catalog.js";
import type {
  ComponentHeaderExpr,
  ComponentProfile,
} from "../../contracts/src/presentation.js";

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
      avatar: 1,
      badge: 1,
      countdown: 1,
      divider: 1,
      kbd: 1,
      link: 1,
      mockupCode: 1,
      progress: 1,
      radialProgress: 1,
      status: 1,
      textRotate: 1,
      calendar: 1,
      checkbox: 1,
      fileInput: 1,
      filter: 1,
      input: 1,
      label: 1,
      otp: 1,
      radio: 1,
      range: 1,
      rating: 1,
      select: 1,
      textarea: 1,
      toggle: 1,
      validator: 1,
      accordion: 1,
      collapse: 1,
      fieldset: 1,
      join: 1,
      stack: 1,
      hero: 1,
      footer: 1,
      stat: 1,
      steps: 1,
      timeline: 1,
      carousel: 1,
      diff: 1,
      alert: 1,
      toast: 1,
      tooltip: 1,
      indicator: 1,
      chatBubble: 1,
      dropdown: 1,
      modal: 1,
      drawer: 1,
      swap: 1,
      fab: 1,
      aura: 1,
      mask: 1,
      hover3d: 1,
      hoverGallery: 1,
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

  it("covers all 68 approved Can words plus 20 infrastructure entries", () => {
    const wordIds = [
      "accordion", "alert", "aura", "avatar", "badge", "breadcrumbs", "button",
      "calendar", "card", "carousel", "chat_bubble", "checkbox", "collapse",
      "countdown", "diff", "divider", "dock", "drawer", "dropdown", "fab",
      "fieldset", "file_input", "filter", "footer", "hero", "hover_3d",
      "hover_gallery", "indicator", "input", "join", "kbd", "label", "link",
      "list", "loading", "mask", "megamenu", "menu", "mockup_browser",
      "mockup_code", "mockup_phone", "mockup_window", "modal", "navbar",
      "otp", "pagination", "progress", "radial_progress", "radio", "range",
      "rating", "select", "skeleton", "stack", "stat", "status", "steps",
      "swap", "tabs", "table", "text_rotate", "textarea", "theme_controller",
      "timeline", "toast", "toggle", "tooltip", "validator",
    ];
    const infraIds = [
      "page-shell", "navigation", "title", "text", "content", "state", "form",
      "edit", "delete", "action", "actions", "settings", "export", "print",
      "history", "copy", "board", "review", "csv-import", "file",
    ];
    assert.equal(wordIds.length, 68);
    assert.equal(infraIds.length, 20);
    const words = new Set(wordIds);
    const infra = new Set(infraIds);
    const seen = new Set<string>();
    let wordCount = 0;
    let infraCount = 0;
    for (const entry of UI_CATALOG.entries) {
      seen.add(entry.id);
      if (words.has(entry.id)) {
        wordCount += 1;
      } else if (infra.has(entry.id)) {
        infraCount += 1;
      } else {
        assert.fail(`catalog entry ${entry.id} is neither an approved word nor known infrastructure`);
      }
    }
    assert.equal(wordCount, 68);
    assert.equal(infraCount, 20);
    assert.equal(UI_CATALOG.entries.length, 88);
    for (const id of [...wordIds, ...infraIds]) {
      assert.ok(seen.has(id), `catalog is missing entry ${id}`);
    }
  });

  it("uses only the closed profile and header unions", () => {
    // Typed against the contract unions: a misspelled value fails typecheck,
    // and the runtime membership check below fails on contract drift.
    const profiles: ReadonlyArray<ComponentProfile> = [
      "leaf", "group", "slotted-group", "collection", "field-control",
      "bound-control", "shared-control", "shell",
    ];
    const headers: ReadonlyArray<ComponentHeaderExpr> = [
      "none", "value", "text", "numeric", "bool", "image", "query",
      "sequence", "selector", "binding",
    ];
    for (const entry of UI_CATALOG.entries) {
      assert.ok(
        (profiles as ReadonlyArray<string>).includes(entry.profile),
        `${entry.id} has unknown profile ${entry.profile}`,
      );
      assert.ok(
        (headers as ReadonlyArray<string>).includes(entry.header),
        `${entry.id} has unknown header ${entry.header}`,
      );
    }
  });

  it("carries slot schemas exactly on slotted groups and item collections", () => {
    // The design assigns named-slot schemas to slotted groups AND to the five
    // repeated-item collection renderers (carousel, hover_gallery, steps,
    // timeline, text_rotate), so slots-bearing implies slotted-group or
    // collection — never leaf/group/field-control/bound-control/shared/shell.
    for (const entry of UI_CATALOG.entries) {
      const slots = entry.slots;
      if (entry.profile === "slotted-group") {
        assert.ok(slots !== undefined, `${entry.id} is slotted-group but has no slots`);
        assert.ok(slots.length > 0, `${entry.id} is slotted-group but has empty slots`);
        const names = slots.map((slot) => slot.name);
        assert.equal(
          new Set(names).size,
          names.length,
          `${entry.id} has duplicate slot names`,
        );
      } else if (entry.profile === "collection") {
        if (slots !== undefined) {
          assert.deepStrictEqual(
            slots.map((slot) => slot.name),
            ["item"],
            `${entry.id} is a collection with a non-item slot schema`,
          );
        }
      } else {
        assert.equal(
          slots,
          undefined,
          `${entry.id} bears slots but is profile ${entry.profile}`,
        );
      }
    }
  });

  it("pins the audited slot schemas against the design table", () => {
    const expected: Record<
      string,
      ReadonlyArray<{ name: string; required: boolean; repeatable: boolean }>
    > = {
      dropdown: [
        { name: "trigger", required: true, repeatable: false },
        { name: "content", required: true, repeatable: false },
      ],
      modal: [
        { name: "content", required: true, repeatable: false },
        { name: "trigger", required: false, repeatable: false },
        { name: "actions", required: false, repeatable: false },
      ],
      drawer: [
        { name: "content", required: true, repeatable: false },
        { name: "trigger", required: false, repeatable: false },
        { name: "actions", required: false, repeatable: false },
      ],
      diff: [
        { name: "before", required: true, repeatable: false },
        { name: "after", required: true, repeatable: false },
      ],
      swap: [
        { name: "off", required: true, repeatable: false },
        { name: "on", required: true, repeatable: false },
      ],
      indicator: [
        { name: "content", required: true, repeatable: false },
        { name: "indicator", required: true, repeatable: false },
      ],
      chat_bubble: [
        { name: "content", required: true, repeatable: false },
        { name: "avatar", required: false, repeatable: false },
        { name: "header", required: false, repeatable: false },
        { name: "footer", required: false, repeatable: false },
      ],
      stat: [
        { name: "value", required: true, repeatable: false },
        { name: "title", required: false, repeatable: false },
        { name: "description", required: false, repeatable: false },
        { name: "icon", required: false, repeatable: false },
      ],
      carousel: [{ name: "item", required: true, repeatable: true }],
      steps: [{ name: "item", required: true, repeatable: true }],
      timeline: [{ name: "item", required: true, repeatable: true }],
    };
    const byId = new Map(UI_CATALOG.entries.map((entry) => [entry.id, entry]));
    for (const [id, slots] of Object.entries(expected)) {
      const entry = byId.get(id);
      assert.ok(entry !== undefined, `catalog is missing ${id}`);
      assert.deepStrictEqual(
        (entry.slots ?? []).map((slot) => ({
          name: slot.name,
          required: slot.required,
          repeatable: slot.repeatable,
        })),
        [...slots],
        `${id} slot schema drifted`,
      );
    }
  });

  it("maps reserved words to safe factory names", () => {
    const reserved = new Set(["delete", "export", "new", "class", "function"]);
    for (const entry of UI_CATALOG.entries) {
      assert.ok(
        !reserved.has(entry.js),
        `${entry.id} uses reserved factory name ${entry.js}`,
      );
    }
    const byId = new Map(UI_CATALOG.entries.map((entry) => [entry.id, entry]));
    assert.equal(byId.get("delete")?.js, "deleteRecord");
    assert.equal(byId.get("export")?.js, "collectionExportLink");
  });

  it("round-trips through JSON for L1 consumers", () => {
    const json = JSON.stringify(UI_CATALOG);
    assert.deepStrictEqual(JSON.parse(json), UI_CATALOG);
  });

  it("serves the loading/skeleton spellings through renderState", () => {
    const byId = new Map(UI_CATALOG.entries.map((entry) => [entry.id, entry]));
    assert.equal(byId.get("loading")?.js, "renderState");
    assert.equal(byId.get("loading")?.availability, "implemented");
    assert.equal(byId.get("skeleton")?.js, "renderState");
    assert.equal(byId.get("skeleton")?.availability, "implemented");
  });
});
