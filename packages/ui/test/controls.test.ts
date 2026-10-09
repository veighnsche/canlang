import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  FieldError,
  FormFieldDef,
  FormMode,
  PresentationContext,
} from "@canlang/contracts";
import { loadHtml } from "./harness.js";
import { message } from "../src/messages.js";
import { NATIVE_BOOLEAN_PRESENCE_PREFIX } from "../src/forms.js";
import {
  calendar,
  checkbox,
  fileControl,
  fileInput,
  filter,
  input,
  label,
  otp,
  radio,
  range,
  rating,
  select,
  textarea,
  toggle,
  validator,
} from "../src/controls.js";

function makeContext(overrides: Partial<PresentationContext> = {}): PresentationContext {
  return {
    preferredLocales: [],
    appDefaultLocale: "en",
    theme: { mode: "system", accent: "blue", density: "comfortable" },
    path: "/",
    isPartial: false,
    csrfToken: "csrf-123",
    principal: null,
    invocation: null,
    query: async () => ({ rows: [], columns: [] }),
    ...overrides,
  };
}

function field(path: string, overrides: Partial<FormFieldDef> = {}): FormFieldDef {
  return { path, label: `Label ${path}`, type: "text", required: false, ...overrides };
}

function fieldError(path: string, messageText = "is invalid", code = "type"): FieldError {
  return { path, code, message: messageText };
}

/** Unit ids: label for=, widget id=, outlet id=/describedby must agree. */
function assertUnitWiring(html: string, idPrefix: string, path: string, outlet: boolean): void {
  const id = `${idPrefix}-${path}`;
  assert.ok(html.startsWith("<fieldset>"), "unit opens with fieldset");
  assert.ok(html.includes(`<label for="${id}"`), "label targets the widget id");
  assert.ok(html.includes(`id="${id}"`), "widget carries the input id");
  if (outlet) {
    assert.ok(html.includes(`id="${id}-error"`), "error outlet rendered");
    assert.ok(html.includes(`aria-describedby="${id}-error"`), "widget describes the outlet");
    assert.ok(html.includes(`aria-invalid="true"`), "widget marked invalid");
  } else {
    assert.ok(!html.includes(`${id}-error`), "no outlet without errors");
  }
}

describe("input", () => {
  it("renders a complete text unit with wired ids", async () => {
    const html = await input({
      context: makeContext(),
      field: field("title", { value: "hello", required: true }),
      idPrefix: "u1",
      mode: "create",
    });
    assertUnitWiring(html, "u1", "title", false);
    assert.ok(html.includes(`name="inputs[title]"`), "create-mode name");
    assert.ok(html.includes(`value="hello"`), "draft value verbatim");
    assert.ok(html.includes(`aria-required="true"`), "required marked");
    assert.ok(html.includes(`<span aria-hidden="true">*</span>`), "required star");
  });

  it("roots update names under inputs[changes]", async () => {
    const html = await input({
      context: makeContext(),
      field: field("title", { value: "x" }),
      idPrefix: "u1",
      mode: "update",
    });
    assert.ok(html.includes(`name="inputs[changes][title]"`), "update-mode name");
  });

  it("shows only its own errors and wires describedby", async () => {
    const html = await input({
      context: makeContext(),
      field: field("title", { value: "x" }),
      idPrefix: "u1",
      mode: "create",
      errors: [
        fieldError("/title", "too short"),
        fieldError("/other", "unrelated"),
        fieldError("bogus", "malformed pointer"),
      ],
    });
    assertUnitWiring(html, "u1", "title", true);
    assert.ok(html.includes("too short"), "own error shown");
    assert.ok(!html.includes("unrelated"), "other field error filtered out");
    assert.ok(!html.includes("malformed pointer"), "malformed pointer ignored");
  });

  it("maps email/url/numeric/date/datetime types like forms.ts", async () => {
    const ctx = makeContext();
    const email = await input({ context: ctx, field: field("e", { type: "email", value: "a@b.c" }), idPrefix: "f", mode: "create" });
    assert.ok(email.includes(`type="email"`), "email input type");
    const num = await input({ context: ctx, field: field("n", { type: "int", value: 42n }), idPrefix: "f", mode: "create" });
    assert.ok(num.includes(`inputmode="decimal"`), "numeric inputmode");
    assert.ok(num.includes(`value="42"`), "bigint draft verbatim");
    const date = await input({ context: ctx, field: field("d", { type: "date", value: "2026-03-04" }), idPrefix: "f", mode: "create" });
    assert.ok(date.includes(`type="date"`), "date input type");
    const dt = await input({ context: ctx, field: field("t", { type: "datetime", value: "2026-01-01T00:30:00Z" }), idPrefix: "f", mode: "create" });
    assert.ok(dt.includes(`type="datetime-local"`), "datetime-local input type");
    assert.ok(dt.includes(`value="2026-01-01T00:30"`), "UTC wall time by default");
    assert.ok(dt.includes(`<span>UTC</span>`), "UTC zone marker");
    const zoned = await input({ context: ctx, field: field("t", { type: "datetime", value: "2026-01-01T00:30:00Z" }), idPrefix: "f", mode: "create", timeZone: "America/New_York" });
    assert.ok(zoned.includes(`value="2025-12-31T19:30"`), "zoned wall time");
    assert.ok(zoned.includes(`<span>America/New_York</span>`), "zone marker");
  });

  it("throws naming the field for unsuitable types", async () => {
    await assert.rejects(
      input({ context: makeContext(), field: field("flag", { type: "bool", value: true }), idPrefix: "f", mode: "create" }),
      /field "flag"/,
    );
  });

  it("renders readonly as disabled plus a hidden duplicate", async () => {
    const html = await input({
      context: makeContext(),
      field: field("title", { value: "kept", readonly: true }),
      idPrefix: "u1",
      mode: "create",
    });
    assert.ok(html.includes(" disabled"), "widget disabled");
    assert.ok(
      html.includes(`<input type="hidden" name="inputs[title]" value="kept">`),
      "hidden duplicate carries the submit value",
    );
  });

  it("admits tone/size/ghost and rejects orientation", async () => {
    const ok = await input({
      context: makeContext(),
      field: field("title"),
      idPrefix: "f",
      mode: "create",
      tone: "primary",
      size: "sm",
      variant: "ghost",
    });
    assert.ok(ok.includes(`class="input input-primary input-sm input-ghost"`), "admitted modifiers");
    await assert.rejects(
      input({ context: makeContext(), field: field("title"), idPrefix: "f", mode: "create", orientation: "vertical" } as unknown as Parameters<typeof input>[0]),
      /orientation/,
    );
  });
});

describe("textarea", () => {
  it("renders a multiline unit and rejects non-text types", async () => {
    const html = await textarea({
      context: makeContext(),
      field: field("bio", { value: "line1\nline2" }),
      idPrefix: "u1",
      mode: "create",
    });
    assertUnitWiring(html, "u1", "bio", false);
    assert.ok(html.includes("<textarea"), "textarea widget");
    assert.ok(html.includes("line1\nline2"), "draft verbatim");
    await assert.rejects(
      textarea({ context: makeContext(), field: field("n", { type: "int", value: 1 }), idPrefix: "f", mode: "create" }),
      /field "n"/,
    );
  });
});

describe("checkbox and toggle", () => {
  it("checkbox reflects the bool draft and rejects text", async () => {
    const on = await checkbox({
      context: makeContext(),
      field: field("flag", { type: "bool", value: true }),
      idPrefix: "u1",
      mode: "create",
    });
    assertUnitWiring(on, "u1", "flag", false);
    assert.ok(on.includes(`class="checkbox"`), "checkbox base class");
    assert.ok(on.includes(" checked"), "checked when true");
    const off = await checkbox({
      context: makeContext(),
      field: field("flag", { type: "bool" }),
      idPrefix: "u1",
      mode: "create",
    });
    assert.ok(!off.includes(" checked"), "unchecked when absent");
    assert.ok(off.includes(`name="${NATIVE_BOOLEAN_PRESENCE_PREFIX}inputs[flag]" value="true"`));
    assert.equal((off.match(/name="inputs\[flag\]"/g) ?? []).length, 1);
    const editableToggle = await toggle({ context: makeContext(), field: field('flag', { type: 'bool', value: false }), idPrefix: 'u1', mode: 'update' });
    assert.ok(editableToggle.includes(`name="${NATIVE_BOOLEAN_PRESENCE_PREFIX}inputs[changes][flag]" value="true"`));
    await assert.rejects(
      checkbox({ context: makeContext(), field: field("t", { value: "x" }), idPrefix: "f", mode: "create" }),
      /field "t"/,
    );
  });

  it("toggle uses the toggle class with the same value semantics", async () => {
    const html = await toggle({
      context: makeContext(),
      field: field("flag", { type: "bool", value: true, readonly: true }),
      idPrefix: "u1",
      mode: "update",
    });
    assert.ok(html.includes(`class="toggle"`), "toggle base class");
    assert.ok(html.includes(" checked"), "checked when true");
    assert.ok(html.includes(" disabled"), "readonly disabled");
    assert.ok(!html.includes(NATIVE_BOOLEAN_PRESENCE_PREFIX));
    assert.ok(
      html.includes(`<input type="hidden" name="inputs[changes][flag]" value="true">`),
      "hidden duplicate carries bool submit value",
    );
    await assert.rejects(
      toggle({ context: makeContext(), field: field("t", { value: "x" }), idPrefix: "f", mode: "create" }),
      /field "t"/,
    );
  });
});

describe("radio and select", () => {
  const options = [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Beta <b>" },
  ];

  it("radio renders a labelled group with the checked option", async () => {
    const html = await radio({
      context: makeContext(),
      field: field("pick", { type: "enum", value: "b", options }),
      idPrefix: "u1",
      mode: "create",
    });
    assertUnitWiring(html, "u1", "pick", false);
    assert.ok(html.includes(`role="radiogroup"`), "radiogroup wrapper");
    assert.ok(html.includes(`value="b" checked`), "current option checked");
    assert.ok(html.includes("Beta &lt;b&gt;"), "option caption escaped");
    assert.ok(!html.includes(`value="a" checked`), "other option unchecked");
  });

  it("radio rejects a field without options", async () => {
    await assert.rejects(
      radio({ context: makeContext(), field: field("pick", { type: "enum" }), idPrefix: "f", mode: "create" }),
      /field "pick"/,
    );
    await assert.rejects(
      radio({ context: makeContext(), field: field("pick", { type: "enum", options: [] }), idPrefix: "f", mode: "create" }),
      /field "pick"/,
    );
  });

  it("select renders options with the selected current value", async () => {
    const html = await select({
      context: makeContext(),
      field: field("pick", { type: "enum", value: "a", options }),
      idPrefix: "u1",
      mode: "create",
      tone: "primary",
      size: "sm",
    });
    assertUnitWiring(html, "u1", "pick", false);
    assert.ok(html.includes(`<select`), "select widget");
    assert.ok(html.includes(`class="select select-primary select-sm"`), "appearance modifiers");
    assert.ok(html.includes(`value="a" selected`), "current option selected");
    await assert.rejects(
      select({ context: makeContext(), field: field("pick", { type: "enum" }), idPrefix: "f", mode: "create" }),
      /field "pick"/,
    );
  });
});

describe("range and rating", () => {
  it("range renders a numeric slider and rejects text", async () => {
    const html = await range({
      context: makeContext(),
      field: field("level", { type: "int", value: 7 }),
      idPrefix: "u1",
      mode: "create",
    });
    assertUnitWiring(html, "u1", "level", false);
    assert.ok(html.includes(`type="range"`), "range widget");
    assert.ok(html.includes(`value="7"`), "numeric draft verbatim");
    await assert.rejects(
      range({ context: makeContext(), field: field("t", { value: "x" }), idPrefix: "f", mode: "create" }),
      /field "t"/,
    );
  });

  it("range emits schema bounds and preserves out-of-bounds drafts losslessly", async () => {
    const bounded = await range({
      context: makeContext(),
      field: { ...field("level", { type: "int", value: 7 }), min: 1, max: 10 },
      idPrefix: "u1",
      mode: "create",
    });
    assert.ok(bounded.includes(`min="1" max="10"`), "bounds emitted");
    assert.ok(!bounded.includes("disabled"), "in-bounds slider writable");
    const outside = await range({
      context: makeContext(),
      field: { ...field("level", { type: "int", value: 5000 }), min: 1, max: 10 },
      idPrefix: "u1",
      mode: "create",
    });
    assert.ok(outside.includes("disabled"), "out-of-bounds slider disabled");
    assert.ok(outside.includes(`role="alert"`), "invalid note");
    assert.ok(
      outside.includes(`<input type="hidden" name="inputs[level]" value="5000">`),
      "raw draft preserved",
    );
    await assert.rejects(
      range({
        context: makeContext(),
        field: { ...field("level", { type: "int", value: 7 }), min: 10, max: 1 },
        idPrefix: "f",
        mode: "create",
      }),
      /min <= max/,
    );
    await assert.rejects(
      range({
        context: makeContext(),
        field: { ...field("level", { type: "int", value: 7 }), min: 1 },
        idPrefix: "f",
        mode: "create",
      }),
      /min <= max/,
    );
  });

  it("rating renders five stars with the matching one checked", async () => {
    const html = await rating({
      context: makeContext(),
      field: field("score", { type: "int", value: 3 }),
      idPrefix: "u1",
      mode: "create",
      size: "lg",
    });
    assertUnitWiring(html, "u1", "score", false);
    assert.ok(html.includes(`class="rating rating-lg"`), "rating container with size");
    assert.equal((html.match(/mask mask-star/g) ?? []).length, 5, "five stars");
    assert.ok(html.includes(`value="3" aria-label="3 stars" class="mask mask-star" checked`), "third star checked");
    const blank = await rating({
      context: makeContext(),
      field: field("score", { type: "int" }),
      idPrefix: "u1",
      mode: "create",
    });
    assert.ok(!blank.includes("checked"), "no star checked without a draft");
    await assert.rejects(
      rating({ context: makeContext(), field: field("score", { type: "int", value: 3 }), idPrefix: "f", mode: "create", tone: "primary" } as unknown as Parameters<typeof rating>[0]),
      /tone/,
      "rating admits no tone",
    );
    await assert.rejects(
      rating({ context: makeContext(), field: field("t", { value: "x" }), idPrefix: "f", mode: "create" }),
      /field "t"/,
    );
  });

  it("rating matches stars string-exactly, never via float rounding", async () => {
    const near = await rating({
      context: makeContext(),
      field: field("score", { type: "decimal", value: "3.0000000000000004" }),
      idPrefix: "u1",
      mode: "create",
    });
    assert.ok(!near.includes("checked"), "near-integer decimal checks nothing");
    const huge = await rating({
      context: makeContext(),
      field: field("score", { type: "int", value: "9007199254740993" }),
      idPrefix: "u1",
      mode: "create",
    });
    assert.ok(!huge.includes("checked"), "huge int checks nothing");
    const padded = await rating({
      context: makeContext(),
      field: field("score", { type: "int", value: "03" }),
      idPrefix: "u1",
      mode: "create",
    });
    assert.ok(padded.includes(`value="3" aria-label="3 stars" class="mask mask-star" checked`), "padded int matches");
  });
});

describe("fileInput and otp", () => {
  it("fileInput renders a file widget and rejects non-file types", async () => {
    const html = await fileInput({
      context: makeContext(),
      field: field("doc", { type: "file" }),
      idPrefix: "u1",
      mode: "create",
    });
    assertUnitWiring(html, "u1", "doc", false);
    assert.ok(html.includes(`type="file"`), "file widget");
    assert.ok(html.includes(`class="file-input"`), "file-input base class");
    await assert.rejects(
      fileInput({ context: makeContext(), field: field("t", { value: "x" }), idPrefix: "f", mode: "create" }),
      /field "t"/,
    );
  });

  it("otp preserves leading zeros and rejects numeric types", async () => {
    const html = await otp({
      context: makeContext(),
      field: field("code", { value: "007" }),
      idPrefix: "u1",
      mode: "create",
    });
    assertUnitWiring(html, "u1", "code", false);
    assert.ok(html.includes(`class="otp"`), "otp container");
    assert.ok(html.includes(`inputmode="numeric"`), "numeric inputmode");
    assert.ok(html.includes(`value="007"`), "leading zeros preserved verbatim");
    assert.equal((html.match(/<span><\/span>/g) ?? []).length, 3, "one segment per draft char");
    await assert.rejects(
      otp({ context: makeContext(), field: field("n", { type: "int", value: 7 }), idPrefix: "f", mode: "create" }),
      /field "n"/,
    );
  });
});

describe("label and validator fragments", () => {
  it("label renders only the label with caption precedence", async () => {
    const f = field("title", { label: "Base", labelCaption: "Override", required: true });
    const html = await label({ context: makeContext(), field: f, idPrefix: "u1" });
    assert.ok(html === `<label for="u1-title" class="label">Override <span aria-hidden="true">*</span></label>`, `exact label fragment, got ${html}`);
    assert.ok(!html.includes("<input"), "no widget");
    const explicit = await label({ context: makeContext(), field: f, idPrefix: "u1", caption: "Explicit" });
    assert.ok(explicit.includes(">Explicit <span"), "explicit caption wins");
    const unit = await input({ context: makeContext(), field: f, idPrefix: "u1", mode: "create" });
    assert.ok(unit.includes(html.slice(0, `<label for="u1-title"`.length)), "for= matches the sibling unit");
  });

  it("validator renders only the outlet, empty when no errors", async () => {
    const f = field("title", { value: "x" });
    const empty = await validator({ context: makeContext(), field: f, idPrefix: "u1", mode: "create" });
    assert.equal(empty, `<div id="u1-title-error"></div>`, "stable empty swap target");
    const filled = await validator({
      context: makeContext(),
      field: f,
      idPrefix: "u1",
      mode: "create",
      errors: [fieldError("/title", "too short"), fieldError("/other", "unrelated")],
    });
    assert.ok(filled.includes(`<div id="u1-title-error">`), "outlet id matches the unit");
    assert.ok(filled.includes(`<p class="text-error">too short</p>`), "own error shown");
    assert.ok(!filled.includes("unrelated"), "other errors filtered");
    assert.ok(!filled.includes("<label"), "no label");
    assert.ok(!filled.includes("<input"), "no widget");
  });
});

describe("filter", () => {
  const options = [
    { value: "s", label: "Svelte" },
    { value: "v", label: "Vue" },
  ];

  it("renders radio buttons in a filter container without form reset", async () => {
    const html = await filter({
      context: makeContext(),
      field: field("fw", { type: "enum", value: "v", options }),
      idPrefix: "u1",
      mode: "create",
    });
    assertUnitWiring(html, "u1", "fw", false);
    assert.ok(html.includes(`<div class="filter">`), "filter container");
    assert.ok(html.includes(`<input class="btn" type="radio"`), "radio styled as button");
    assert.ok(html.includes(`aria-label="Vue"`), "option caption as aria-label");
    assert.ok(html.includes(`value="v" aria-label="Vue" checked`), "current option checked");
    assert.ok(!html.includes(`type="reset"`), "no form-wide reset (would discard drafts)");
  });

  it("rejects a field without options", async () => {
    await assert.rejects(
      filter({ context: makeContext(), field: field("fw", { type: "enum" }), idPrefix: "f", mode: "create" }),
      /field "fw"/,
    );
  });
});

describe("calendar field", () => {
  it("renders date and UTC datetime units and rejects text", async () => {
    const ctx = makeContext();
    const date = await calendar({
      kind: "field",
      context: ctx,
      field: field("due", { type: "date", value: "2026-05-06" }),
      idPrefix: "u1",
      mode: "create",
    });
    assertUnitWiring(date, "u1", "due", false);
    assert.ok(date.includes(`type="date"`), "date widget");
    const dt = await calendar({
      kind: "field",
      context: ctx,
      field: field("at", { type: "datetime", value: "2026-01-01T00:30:00Z" }),
      idPrefix: "u1",
      mode: "create",
    });
    assert.ok(dt.includes(`value="2026-01-01T00:30"`), "UTC wall time (no zone on props)");
    assert.ok(dt.includes(`<span>UTC</span>`), "UTC zone marker");
    await assert.rejects(
      calendar({ kind: "field", context: ctx, field: field("t", { value: "x" }), idPrefix: "f", mode: "create" }),
      /field "t"/,
    );
  });
});

describe("calendar agenda", () => {
  it("groups rows by start day with item rows and no mutation affordances", async () => {
    const ctx = makeContext({
      query: async () => ({
        rows: [
          { id: "r2", fields: { starts: "2026-02-02", ends: "2026-02-03" } },
          { id: "r1", fields: { starts: "2026-02-01", ends: "2026-02-01" } },
          { id: "r3", fields: { starts: "2026-02-01", ends: "2026-02-02" } },
        ],
        columns: [],
      }),
    });
    const html = await calendar({
      kind: "agenda",
      context: ctx,
      model: "TeamTasks.Todo",
      startField: "starts",
      endField: "ends",
      empty: "Nothing scheduled",
    });
    assert.equal((html.match(/<section>/g) ?? []).length, 2, "two day groups");
    assert.ok(html.includes("<h2>"), "day headings");
    assert.ok(html.includes("<span>r1</span>"), "row id rendered");
    assert.ok(!html.includes("<input"), "no inputs");
    assert.ok(!html.includes("<form"), "no forms");
    assert.ok(!html.includes("<button"), "no buttons");
    const firstDay = html.indexOf("<section>");
    const secondDay = html.indexOf("<section>", firstDay + 1);
    assert.ok(firstDay >= 0 && secondDay > firstDay, "days in ascending order");
    const firstSection = html.slice(firstDay, secondDay);
    assert.ok(firstSection.includes("r1") && firstSection.includes("r3"), "same-day rows grouped");
  });

  it("groups datetime starts by UTC day by default", async () => {
    const ctx = makeContext({
      query: async () => ({
        rows: [{ id: "r1", fields: { starts: "2026-01-01T00:30:00Z", ends: "2026-01-01T01:30:00Z" } }],
        columns: [],
      }),
    });
    const html = await calendar({
      kind: "agenda",
      context: ctx,
      model: "TeamTasks.Todo",
      startField: "starts",
      endField: "ends",
      empty: "Nothing scheduled",
    });
    assert.equal((html.match(/<section>/g) ?? []).length, 1, "single UTC day group");
    assert.ok(html.includes("2026"), "day heading carries the UTC year");
  });

  it("names the field and zone when datetime formatting fails", async () => {
    await assert.rejects(
      input({
        context: makeContext(),
        field: field("t", { type: "datetime", value: "2026-01-01T00:30:00Z" }),
        idPrefix: "f",
        mode: "create",
        timeZone: "Mars/Olympus",
      }),
      /field "t".*Mars\/Olympus/,
    );
  });

  it("groups datetime starts by the zoned day when timeZone is set", async () => {
    const ctx = makeContext({
      query: async () => ({
        rows: [{ id: "r1", fields: { starts: "2026-01-01T00:30:00Z", ends: "2026-01-01T01:30:00Z" } }],
        columns: [],
      }),
    });
    const html = await calendar({
      kind: "agenda",
      context: ctx,
      model: "TeamTasks.Todo",
      startField: "starts",
      endField: "ends",
      empty: "Nothing scheduled",
      timeZone: "America/New_York",
    });
    assert.equal((html.match(/<section>/g) ?? []).length, 1, "single zoned day group");
    assert.ok(html.includes("2025"), "2026-01-01T00:30Z is 2025-12-31 in New York");
  });

  it("renders the empty message and validates the limit", async () => {
    const html = await calendar({
      kind: "agenda",
      context: makeContext(),
      model: "TeamTasks.Todo",
      startField: "starts",
      endField: "ends",
      empty: "Nothing scheduled",
    });
    assert.equal(html, "<p>Nothing scheduled</p>", "empty-state message");
    await assert.rejects(
      calendar({
        kind: "agenda",
        context: makeContext(),
        model: "TeamTasks.Todo",
        startField: "starts",
        endField: "ends",
        empty: "Nothing scheduled",
        limit: 101,
      }),
      /limit/,
    );
  });

  it("escapes hostile row content", async () => {
    const ctx = makeContext({
      query: async () => ({
        rows: [{ id: `r"><img src=x>`, fields: { starts: "2026-02-01", ends: `e"><script>` } }],
        columns: [],
      }),
    });
    const html = await calendar({
      kind: "agenda",
      context: ctx,
      model: "TeamTasks.Todo",
      startField: "starts",
      endField: "ends",
      empty: "Nothing scheduled",
    });
    assert.ok(!html.includes("<img"), "row id escaped");
    assert.ok(!html.includes("<script>"), "end text escaped");
  });
});

describe("escaping and hostile paths", () => {
  it("escapes hostile labels, values, options and captions", async () => {
    const html = await input({
      context: makeContext(),
      field: field("title", {
        label: `L"><script>alert(1)</script>`,
        value: `v"><img src=x onerror=alert(1)>`,
      }),
      idPrefix: `p"><b>`,
      mode: "create",
    });
    assert.ok(!html.includes("<script>"), "label escaped");
    assert.ok(!html.includes("<img"), "value escaped");
    assert.ok(!html.includes(`p"><b>`), "id prefix escaped");
    const opted = await select({
      context: makeContext(),
      field: field("pick", {
        type: "enum",
        value: `a" onfocus=alert(1)`,
        options: [{ value: `a" onfocus=alert(1)`, label: `O<script>` }],
      }),
      idPrefix: "u1",
      mode: "create",
      errors: [fieldError("/pick", `E<img src=x>`)],
    });
    assert.ok(!opted.includes("<script>"), "option caption escaped");
    assert.ok(!opted.includes("<img"), "error text escaped");
    assert.ok(opted.includes(`value="a&quot; onfocus=alert(1)"`), "option value escaped");
    assert.ok(!opted.includes(`value="a"`), "no attribute break-out");
  });

  it("rejects hostile field paths via assertFieldPath", async () => {
    const modes: FormMode[] = ["create", "update"];
    for (const mode of modes) {
      await assert.rejects(
        input({ context: makeContext(), field: field(`x][${mode}`, { value: "v" }), idPrefix: "f", mode }),
        /invalid field path/,
      );
    }
    await assert.rejects(
      label({ context: makeContext(), field: field("../evil"), idPrefix: "f" }),
      /invalid field path/,
    );
    await assert.rejects(
      validator({ context: makeContext(), field: field("a/b"), idPrefix: "f", mode: "create" }),
      /invalid field path/,
    );
    await assert.rejects(
      calendar({
        kind: "agenda",
        context: makeContext(),
        model: "M",
        startField: "a-b",
        endField: "ends",
        empty: "none",
      }),
      /invalid field path/,
    );
  });
});

describe("DOM interaction", () => {
  it("focuses a unit input in a live document", async () => {
    const html = await input({
      context: makeContext(),
      field: field("title", { value: "hello" }),
      idPrefix: "u1",
      mode: "create",
    });
    const page = await loadHtml(html);
    try {
      const el = page.document.querySelector("input");
      assert.ok(el, "input present");
      (el as unknown as { focus(): void }).focus();
      assert.equal(page.document.activeElement, el, "input receives focus");
      const lab = page.document.querySelector("label");
      assert.equal(lab?.getAttribute("for"), "u1-title", "label for= wired");
    } finally {
      await page.close();
    }
  });
});

describe("fileControl", () => {
  it("renders a fieldset with legend, named links and announced status", async () => {
    const html = await fileControl({
      context: makeContext(),
      field: field("doc", { type: "file" }),
      idPrefix: "u1",
      mode: "create",
      files: [
        { href: "https://files.example/r1", name: "report.pdf", status: "succeeded" },
        { href: "/files/r2", name: "photo.png" },
      ],
    });
    assert.ok(html.startsWith("<fieldset>"), "fieldset group");
    assert.ok(
      html.includes(`<legend class="fieldset-legend">Label doc</legend>`),
      "field label as legend",
    );
    assert.ok(html.includes(`<a class="link" href="https://files.example/r1">report.pdf</a>`), "named link");
    assert.ok(html.includes(`<a class="link" href="/files/r2">photo.png</a>`), "relative link");
    assert.ok(html.includes(`<span role="status">succeeded</span>`), "status announced");
    assert.ok(!html.includes(`<input type="file"`), "no upload widget");
    assert.ok(!html.includes("<form"), "no form or endpoint");
  });

  it("prefers caption over name over href and labelCaption over label", async () => {
    const html = await fileControl({
      context: makeContext(),
      field: field("doc", { type: "file", label: "Base", labelCaption: "Override" }),
      idPrefix: "u1",
      mode: "create",
      files: [
        { href: "https://files.example/a", name: "a.pdf", caption: "Explicit" },
        { href: "https://files.example/b", name: "b.pdf" },
        { href: "https://files.example/c" },
      ],
    });
    assert.ok(html.includes(">Override</legend>"), "labelCaption wins");
    assert.ok(!html.includes(">Base</legend>"), "base label replaced");
    assert.ok(html.includes(">Explicit</a>"), "link caption wins");
    assert.ok(html.includes(">b.pdf</a>"), "name next");
    assert.ok(html.includes(">https://files.example/c</a>"), "href last");
  });

  it("resolves captions through the viewer locale", async () => {
    const props = {
      field: field("doc", { type: "file" }),
      idPrefix: "u1",
      mode: "create" as const,
      files: [{ href: "/f", caption: message("Download", { nl: "Downloaden" }) }],
    };
    const en = await fileControl({ ...props, context: makeContext() });
    assert.ok(en.includes(">Download</a>"), "source text by default");
    const nl = await fileControl({ ...props, context: makeContext({ preferredLocales: ["nl"] }) });
    assert.ok(nl.includes(">Downloaden</a>"), "nl variant resolved");
    const emptyNl = await fileControl({
      context: makeContext({ preferredLocales: ["nl"] }),
      field: field("doc", { type: "file" }),
      idPrefix: "u1",
      mode: "create",
      files: [],
    });
    assert.ok(emptyNl.includes("Bestand niet beschikbaar"), "nl unavailable presentation");
  });

  it("fails hostile and missing URLs closed to the fallback href", async () => {
    const html = await fileControl({
      context: makeContext(),
      field: field("doc", { type: "file" }),
      idPrefix: "u1",
      mode: "create",
      files: [
        { href: "javascript:alert(1)", name: "evil" },
        { href: "  JaVaScRiPt:alert(1)", name: "smuggled" },
        { href: "", name: "empty" },
      ],
    });
    assert.equal((html.match(/href="#"/g) ?? []).length, 3, "all three fall back");
    assert.ok(!html.includes("javascript:"), "no hostile scheme in markup");
    assert.ok(!html.includes("JaVaScRiPt"), "no smuggled scheme in markup");
    assert.ok(html.includes(">evil</a>"), "link stays named");
  });

  it("escapes every text sink", async () => {
    const html = await fileControl({
      context: makeContext(),
      field: field("doc", { type: "file", label: `L"><script>alert(1)</script>` }),
      idPrefix: "u1",
      mode: "create",
      files: [
        {
          href: `https://files.example/x" onmouseover="alert(1)`,
          name: `n<img src=x>`,
          caption: `C<script>alert(1)</script>`,
          status: "pending",
        },
      ],
      errors: [fieldError("/doc", `E<img src=x>`)],
    });
    assert.ok(!html.includes("<script>"), "label/caption escaped");
    assert.ok(!html.includes("<img"), "name/error escaped");
    assert.ok(!html.includes(`onmouseover="alert(1)"`), "no attribute break-out");
    assert.ok(html.includes(`E&lt;img src=x&gt;`), "own error shown");
    assert.ok(html.includes(`id="u1-doc-error"`), "error outlet id");
  });

  it("renders explicit unavailable presentation for an empty list", async () => {
    const html = await fileControl({
      context: makeContext(),
      field: field("doc", { type: "file" }),
      idPrefix: "u1",
      mode: "create",
      files: [],
    });
    assert.ok(html.includes("File unavailable"), "unavailable text");
    assert.ok(!html.includes("<a "), "no link without files");
  });

  it("shows only its own errors", async () => {
    const html = await fileControl({
      context: makeContext(),
      field: field("doc", { type: "file" }),
      idPrefix: "u1",
      mode: "create",
      files: [{ href: "/f", name: "f" }],
      errors: [fieldError("/doc", "too big"), fieldError("/other", "unrelated")],
    });
    assert.ok(html.includes("too big"), "own error shown");
    assert.ok(!html.includes("unrelated"), "other field error filtered out");
  });

  it("rejects every appearance token under the file catalog id", async () => {
    const base = {
      context: makeContext(),
      field: field("doc", { type: "file" }),
      idPrefix: "f",
      mode: "create" as const,
      files: [{ href: "/f" }],
    };
    for (const extra of [
      { tone: "primary" },
      { size: "sm" },
      { variant: "ghost" },
      { orientation: "vertical" },
    ]) {
      await assert.rejects(
        fileControl({ ...base, ...extra } as unknown as Parameters<typeof fileControl>[0]),
        /appearance|tone|size|variant|orientation/,
      );
    }
  });

  it("throws invalid input naming the field", async () => {
    const ctx = makeContext();
    await assert.rejects(
      fileControl({
        context: ctx,
        field: field("t", { value: "x" }),
        idPrefix: "f",
        mode: "create",
        files: [{ href: "/f" }],
      }),
      /field "t"/,
      "non-file type",
    );
    await assert.rejects(
      fileControl({
        context: ctx,
        field: field("doc", { type: "file" }),
        idPrefix: "f",
        mode: "create",
        files: "nope" as unknown as [],
      }),
      /field "doc"/,
      "non-array files",
    );
    await assert.rejects(
      fileControl({
        context: ctx,
        field: field("doc", { type: "file" }),
        idPrefix: "f",
        mode: "create",
        files: [null as unknown as { href: string }],
      }),
      /field "doc"/,
      "non-object entry",
    );
    await assert.rejects(
      fileControl({
        context: ctx,
        field: field("doc", { type: "file" }),
        idPrefix: "f",
        mode: "create",
        files: [{ href: 42 as unknown as string }],
      }),
      /field "doc"/,
      "non-string href",
    );
    await assert.rejects(
      fileControl({
        context: ctx,
        field: field("doc", { type: "file" }),
        idPrefix: "f",
        mode: "create",
        files: [{ href: "/f", caption: 42 as unknown as string }],
      }),
      /field "doc": file caption must be a message value/,
      "non-message caption",
    );
    await assert.rejects(
      fileControl({
        context: ctx,
        field: field("doc", { type: "file" }),
        idPrefix: "f",
        mode: "create",
        files: [{ href: "/f", status: "<script>" as unknown as "pending" }],
      }),
      /field "doc"/,
      "undeclared status",
    );
    await assert.rejects(
      fileControl({
        context: ctx,
        field: field("../evil", { type: "file" }),
        idPrefix: "f",
        mode: "create",
        files: [{ href: "/f" }],
      }),
      /invalid field path/,
      "hostile field path",
    );
  });
});
