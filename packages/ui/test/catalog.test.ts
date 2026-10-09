import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as ui from "../src/index.js";
import { LANE05_CATALOG_VERSION, UI_CATALOG } from "../src/catalog.js";
import type {
  ComponentHeaderExpr,
  ComponentProfile,
} from "@canlang/contracts";

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
      breadcrumbs: 1,
      button: 1,
      dock: 1,
      megamenu: 1,
      menu: 1,
      navbar: 1,
      pagination: 1,
      themeController: 1,
      board: 1,
      csvImport: 1,
      csvReviewForm: 1,
      csvPreviewSection: 1,
      csvConfirmSection: 1,
      fileControl: 1,
      review: 1,
      tabs: 1,
      history: 1,
      copy: 1,
      renderSettingsPanel: 1,
      mockupBrowser: 1,
      mockupPhone: 1,
      mockupWindow: 1,
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

  it("covers all 68 approved Can words plus 23 infrastructure entries", () => {
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
      "csv-review-form", "csv-preview", "csv-confirm",
    ];
    assert.equal(wordIds.length, 68);
    assert.equal(infraIds.length, 23);
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
    assert.equal(infraCount, 23);
    assert.equal(UI_CATALOG.entries.length, 91);
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

  it("reverse-audits every public export: cataloged-implemented or explicitly allowlisted", () => {
    // Non-component runtime exports, each named with its reason. Helpers are
    // not selectable Can words so they never enter the catalog; the catalog
    // itself and the contract constants are metadata, not components. No
    // blanket skips: every name below must exist on the index (stale entries
    // fail), and no name may shadow a cataloged factory.
    const allowlist: Record<string, string> = {
      // escape.ts: sink-specific escaping and URL guards (S1).
      csvFormulaProtect: "csv cell guard, not a component",
      escapeAttr: "attribute escaper, not a component",
      escapeHtml: "html escaper, not a component",
      isSafeUrl: "url predicate, not a component",
      isolate: "bidi isolation helper, not a component",
      safeHref: "url fallback helper, not a component",
      // messages.ts: locale resolution and ICU-profile formatting (S1).
      canonicalDefaultTag: "locale helper, not a component",
      canonicalPreferredTags: "locale helper, not a component",
      formatDecimalExact: "scalar formatter, not a component",
      formatIntExact: "scalar formatter, not a component",
      formatMessage: "icu formatter, not a component",
      formatMoneyExact: "scalar formatter, not a component",
      formatScalar: "scalar formatter, not a component",
      isEnumTypeId: "type-id predicate, not a component",
      localeNumberSystem: "locale helper, not a component",
      localeSeparators: "locale helper, not a component",
      message: "descriptor factory, not a component",
      normalizeTag: "bcp47 helper, not a component",
      resolveCaption: "caption resolver, not a component",
      resolveMessage: "variant resolver, not a component",
      selectPluralCategory: "plural helper, not a component",
      // navigation.ts: discovery candidate filter (S2; buildNavigation is cataloged).
      selectDiscoveryCandidates: "discovery filter, not a component",
      // shell.ts: locale/document helpers and the canonical login surface.
      pageDirection: "writing-direction helper, not a component",
      pageLocale: "locale helper, not a component",
      renderLogin: "canonical login surface, not a selectable word",
      policyPage: "policy-page renderer, not a selectable word",
      // components.ts: internal text/heading fragments (card/title/text/content/state are cataloged).
      renderTextValue: "text-value fragment, not a component",
      rowHeading: "row-heading fragment, not a component",
      // collections.ts: control primitives (list/table/board/csv-import/export/print are cataloged).
      collectionPagination: "pagination control renderer, not a word",
      collectionShareControls: "share control renderer, not a word",
      collectionToolbar: "toolbar renderer, not a word",
      controlHref: "control-url builder, not a component",
      // htmx.ts: fragment/interaction primitives (S5), none a Can word.
      assertRegionId: "region-id guard, not a component",
      fragmentRegion: "read-region wrapper, not a word",
      hxAttrs: "hx-attribute builder, not a component",
      pollTrigger: "poll declaration, not a word",
      refreshTrigger: "refresh cadence helper, not a component",
      staleMarker: "stale marker, not a word",
      validationStatusSwaps: "status-swap table, not a component",
      // appearance.ts: admitted-token class resolver (C2b).
      appearanceClasses: "appearance resolver, not a component",
      // forms.ts: field-identity and pointer helpers (form/edit/delete/action/actions are cataloged).
      assertFieldPath: "field-path guard, not a component",
      fieldErrorOutletId: "outlet-id helper, not a component",
      fieldInputId: "input-id helper, not a component",
      fieldInputName: "input-name helper, not a component",
      formatDatetimeLocal: "datetime renderer, not a component",
      pointerToFieldName: "json-pointer helper, not a component",
      // forms.ts: generated-operation surface (T20a factories, T20b exports; not selectable words).
      formFragmentWrap: "fragment-wrap helper, not a component",
      generatedDraftValues: "draft-flattening helper, not a component",
      generatedFields: "derived-input field mapper, not a component",
      generatedForm: "generated operation form, not a selectable word",
      projectGeneratedInputs: "submission-projection helper, not a component",
      // client.ts: submit client for generated forms (T20b), not selectable words.
      applyDocumentRerender: "denial-document swap helper, not a component",
      applyFormRerender: "denial-fragment swap helper, not a component",
      collectFormValues: "flat-map collector, not a component",
      GeneratedSubmitError: "typed submit failure, not a component",
      submitGeneratedForm: "envelope submitter, not a component",
      // csv/parse.ts: text parsing and error guards (FP.CSV); csvReviewForm is cataloged.
      CSV_CSRF_HEADER: "csrf header-name constant, not a component",
      CSV_UI_MAX_ROWS: "row-cap constant, not a component",
      checkCsvHeader: "CSV writable-header admission helper, not a component",
      digestBusinessError: "error digest helper, not a component",
      mapCsvCells: "CSV declared-input cell mapper, not a component",
      parseCsvText: "text parser, not a component",
      // csv/preview.ts: review payload parsers/submitter (FP.CSV); csvPreviewSection is cataloged.
      parseReviewPayload: "form-data parser, not a component",
      submitCsvReview: "envelope submitter, not a component",
      // csv/confirm.ts: commit payload parsers/submitter (FP.CSV); csvConfirmSection is cataloged.
      collectCommitSelections: "checkbox collector, not a component",
      mintOperationId: "idempotency-key minter, not a component",
      parseCommitPayload: "form-data parser, not a component",
      submitCsvCommit: "envelope submitter, not a component",
      // catalog.ts: the shared producer itself.
      LANE05_CATALOG_VERSION: "catalog version constant, not a component",
      UI_CATALOG: "the catalog, not a component",
      // contracts re-exports: wire constants, not components.
      CSRF_FIELD: "csrf field-name constant, not a component",
      DEFAULT_THEME: "theme constant, not a component",
      PRESENTATION_CONTRACT_VERSION: "contract version constant, not a component",
      TEAM_FIELD: "team field-name constant, not a component",
    };
    const implemented = new Set(
      UI_CATALOG.entries
        .filter((entry) => entry.availability === "implemented")
        .map((entry) => entry.js),
    );
    for (const name of Object.keys(allowlist)) {
      assert.ok(
        !implemented.has(name),
        `allowlist entry ${name} shadows a cataloged factory`,
      );
    }
    const exported = Object.keys(ui);
    assert.ok(exported.length > 0, "index must export a public surface");
    for (const name of exported) {
      if (implemented.has(name)) {
        continue;
      }
      assert.ok(
        Object.hasOwn(allowlist, name),
        `public export ${name} is neither cataloged-implemented nor allowlisted: ${allowlist[name] ?? "missing"}`,
      );
    }
    for (const name of Object.keys(allowlist)) {
      assert.ok(
        Object.hasOwn(ui, name),
        `allowlist entry ${name} is stale: the index no longer exports it`,
      );
    }
  });

  it("pins zero planned entries: all 91 are honestly implemented", () => {
    const planned = UI_CATALOG.entries.filter(
      (entry) => entry.availability !== "implemented",
    );
    assert.equal(
      planned.length,
      0,
      `planned entries remain: ${planned.map((entry) => `${entry.id}->${entry.js}`).join(", ")}`,
    );
    assert.equal(UI_CATALOG.entries.length, 91);
  });
});
