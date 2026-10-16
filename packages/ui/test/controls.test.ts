import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  ColumnMeta,
  FieldError,
  FormFieldDef,
  FormMode,
  PresentationContext,
  RowView,
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
  assert.ok(html.startsWith('<fieldset class="fieldset">'), "unit opens with fieldset");
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
    assert.ok(ok.includes(`class="input input-primary input-sm input-ghost w-full"`), "admitted modifiers");
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
    assert.ok(html.includes(`class="select select-primary select-sm w-full"`), "appearance modifiers");
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
    assert.ok(html.includes(`class="file-input w-full"`), "file-input base class");
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
  it("authored label and validator own one linked outlet while the widget keeps required and readonly behavior", async () => {
    const props = { context: makeContext(), field: field("title", { required: true, readonly: true, value: "kept" }),
      idPrefix: "placed", mode: "create" as const,
      errors: [fieldError("/title", "too short"), fieldError("/other", "unrelated")],
      authoredLabel: true, authoredValidator: true };
    const widget = await input(props);
    assert.ok(!widget.includes('<label'));
    assert.ok(!widget.includes('id="placed-title-error"'));
    assert.ok(widget.includes('aria-describedby="placed-title-error"'));
    assert.ok(widget.includes('aria-invalid="true"'));
    assert.ok(widget.includes('aria-required="true"'));
    assert.ok(widget.includes(' disabled'));
    assert.ok(widget.includes('type="hidden" name="inputs[title]" value="kept"'));
    const html = await label({ ...props, caption: "Authored title" }) + widget + await validator(props);
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelectorAll('label[for="placed-title"]').length, 1);
      assert.equal(page.document.querySelector('label')?.textContent, 'Authored title *');
      assert.equal(page.document.querySelectorAll('#placed-title').length, 1);
      assert.equal(page.document.querySelectorAll('#placed-title-error').length, 1);
      assert.equal(page.document.querySelector('#placed-title-error')?.textContent, 'too short');
      assert.ok(!html.includes('unrelated'));
    } finally { await page.close(); }
  });

  it("authored fragment suppression is independent and empty external validators stay stable", async () => {
    const props = { context: makeContext(), field: field("title"), idPrefix: "placed", mode: "create" as const,
      errors: [fieldError("/title", "invalid")] };
    const labelOnly = await input({ ...props, authoredLabel: true });
    assert.ok(!labelOnly.includes('<label'));
    assert.ok(labelOnly.includes('id="placed-title-error"'));
    const validatorOnly = await input({ ...props, authoredValidator: true });
    assert.ok(validatorOnly.includes('<label for="placed-title"'));
    assert.ok(!validatorOnly.includes('id="placed-title-error"'));
    assert.ok(validatorOnly.includes('aria-describedby="placed-title-error"'));
    assertUnitWiring(await input(props), 'placed', 'title', true);
    assertUnitWiring(await input({ ...props, authoredLabel: false, authoredValidator: false }), 'placed', 'title', true);
    const emptyProps = { ...props, errors: [], authoredLabel: true, authoredValidator: true };
    const emptyWidget = await input(emptyProps);
    assert.ok(!emptyWidget.includes('<label'));
    assert.ok(!emptyWidget.includes('placed-title-error'));
    assert.ok(!emptyWidget.includes('aria-invalid'));
    const empty = await label(emptyProps) + emptyWidget + await validator(emptyProps);
    assert.equal((empty.match(/id="placed-title-error"/g) ?? []).length, 1);
    assert.ok(empty.includes('<div id="placed-title-error"></div>'));
    assert.equal((empty.match(/<label for="placed-title"/g) ?? []).length, 1);
  });

  it("label renders only the label with caption precedence", async () => {
    const f = field("title", { label: "Base", labelCaption: "Override", required: true });
    const html = await label({ context: makeContext(), field: f, idPrefix: "u1" });
    assert.ok(html === `<label for="u1-title" class="label fieldset-label">Override <span aria-hidden="true">*</span></label>`, `exact label fragment, got ${html}`);
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

describe("calendar agenda authored enum filters", () => {
  it("composes data predicates and refuses unavailable or unprojected filters before query or row bodies", async () => {
    const filterFields: readonly ColumnMeta[] = [{ field: 'state', type: 'enum:Calendar.Appointment.state', label: 'State',
      valueLabels: { confirmed: 'Confirmed', cancelled: 'Cancelled' } }];
    const defaults = { state: 'confirmed' };
    const where = { op: 'eq', field: 'host', value: 'host-1' };
    let queries = 0;
    let bodies = 0;
    const context = makeContext({
      path: '/appointments',
      prepareCollectionFilters: (occurrence, fields, actualDefaults) => {
        assert.equal(occurrence, 'appointments-agenda');
        assert.equal(fields, filterFields); assert.equal(actualDefaults, defaults);
        return [{ field: 'state', op: 'eq', value: 'confirmed' }];
      },
      query: async (_invocation, model, args) => {
        queries++;
        assert.equal(model, 'Calendar.Appointment');
        assert.deepEqual(args.where, { op: 'and', args: [where,
          { op: 'eq', field: 'state', value: 'confirmed' }] });
        return { rows: [], columns: [] };
      },
    });
    const props = { kind: 'agenda' as const, context, model: 'Calendar.Appointment',
      startField: 'starts', endField: 'ends', empty: 'No appointments',
      occurrence: 'appointments-agenda', filter: filterFields, defaults, where,
      renderRow: async () => { bodies++; return ['authored body']; } };
    await calendar(props);
    assert.equal(queries, 1); assert.equal(bodies, 0);
    // E5 (CAN18-v1): a function source where conjoins with typed controls
    // instead of refusing; the composed `{op:and,[where,...filters]}`
    // reaches the query adapter intact.
    const sourceWhere = () => true;
    await calendar({ ...props, where: sourceWhere, context: { ...context, query: async (_invocation, model, args) => {
      queries++;
      assert.equal(model, 'Calendar.Appointment');
      assert.deepEqual(args.where, { op: 'and', args: [sourceWhere,
        { op: 'eq', field: 'state', value: 'confirmed' }] });
      return { rows: [], columns: [] };
    } } });
    assert.equal(queries, 2); assert.equal(bodies, 0);
    await assert.rejects(calendar({ kind: 'agenda', context, model: props.model,
      startField: props.startField, endField: props.endField, empty: props.empty, defaults }),
      /defaults require declared filter controls/);
    await assert.rejects(calendar({ ...props, context: makeContext({ query: context.query }) }),
      /source filter preparation is unavailable/);
    assert.equal(queries, 2); assert.equal(bodies, 0);

    const authorizedRow: RowView = { id: 'appointment-1', version: '2', fields: {
      starts: '2026-10-12T09:00:00Z', ends: '2026-10-12T09:30:00Z', state: 'confirmed',
    } };
    await assert.rejects(calendar({ ...props, context: { ...context, query: async () => {
      queries++; return { rows: [authorizedRow], columns: [] };
    } } }), /missing authorized filter field "state"/);
    const missingOwnState: RowView = { id: 'appointment-2', version: '3', fields: {
      starts: '2026-10-12T10:00:00Z', ends: '2026-10-12T10:30:00Z',
    } };
    await assert.rejects(calendar({ ...props, context: { ...context, query: async () => {
      queries++; return { rows: [authorizedRow, missingOwnState], columns: filterFields };
    } } }), /row "appointment-2" is missing projected filter field "state"/);
    assert.equal(queries, 4); assert.equal(bodies, 0);
  });
});

describe("calendar agenda bindings", () => {
  it("scopes a parent-bound agenda to the enclosing row and renders consumed columns beside each endpoint line", async () => {
    const columns = [
      { field: 'kind', type: 'enum:Roster.Commitment.kind', label: 'Kind', valueLabels: { duty: 'Duty', visit: 'Visit' } },
      { field: 'conflict', type: 'bool', label: 'Conflict', valueLabels: { true: 'Yes', false: 'No' } },
    ];
    const seen: unknown[] = [];
    let bodies = 0;
    const context = makeContext({
      query: async (_invocation, model, args) => {
        seen.push(args);
        assert.equal(model, 'Roster.Commitment');
        assert.deepEqual((args as { parent?: unknown }).parent, { id: 'roster-1' });
        return { rows: [
          { id: 'c1', fields: { from: '2026-10-12T09:00:00Z', until: '2026-10-12T17:00:00Z', kind: 'duty', conflict: false } },
        ], columns };
      },
    });
    const html = await calendar({ kind: 'agenda', context, model: 'Roster.Commitment',
      parent: { id: 'roster-1' }, startField: 'from', endField: 'until', columns: ['kind', 'conflict'],
      renderRow: async () => { bodies++; return ['body']; } });
    assert.equal(seen.length, 1);
    assert.ok(html.includes('<section><h2>'), 'endpoint day grouping renders');
    assert.ok(html.includes('<p><span>Kind</span>'), 'consumed kind column renders its label');
    assert.ok(html.includes('Duty'), 'consumed enum column renders its case');
    assert.ok(html.includes('body'), 'authored row body renders per endpoint row');
    assert.equal(bodies, 1);
  });

  it("serves parent-bound filter/defaults selections through the shared preparation path", async () => {
    const filterFields: readonly ColumnMeta[] = [{ field: 'location', type: 'ref:Roster.Site', label: 'Site', valueLabels: {} },
      { field: 'kind', type: 'enum:Roster.Commitment.kind', label: 'Kind', valueLabels: { duty: 'Duty', visit: 'Visit' } }];
    const columns = [...filterFields,
      { field: 'conflict', type: 'bool', label: 'Conflict', valueLabels: { true: 'Yes', false: 'No' } }];
    const seen: unknown[] = [];
    let bodies = 0;
    const context = makeContext({
      prepareCollectionFilters: (occurrence, fields, defaults) => {
        assert.equal(occurrence, 'roster-agenda');
        assert.equal(fields, filterFields);
        assert.deepEqual(defaults, { location: null });
        return [{ field: 'kind', op: 'eq', value: 'duty' }];
      },
      query: async (_invocation, model, args) => {
        seen.push(args);
        assert.equal(model, 'Roster.Commitment');
        assert.deepEqual((args as { parent?: unknown }).parent, { id: 'roster-1' });
        assert.deepEqual(args.where, { op: 'eq', field: 'kind', value: 'duty' });
        return { rows: [
          { id: 'c1', fields: { from: '2026-10-12T09:00:00.000Z', until: '2026-10-12T17:00:00.000Z', location: { id: 's1' }, kind: 'duty', conflict: false } },
        ], columns };
      },
    });
    const html = await calendar({ kind: 'agenda', context, model: 'Roster.Commitment',
      parent: { id: 'roster-1' }, startField: 'from', endField: 'until',
      occurrence: 'roster-agenda', filter: filterFields, defaults: { location: null },
      columns: ['kind', 'conflict'],
      renderRow: async () => { bodies++; return ['body']; } });
    assert.equal(seen.length, 1);
    assert.ok(html.includes('<section><h2>'), 'endpoint day grouping renders');
    assert.ok(html.includes('<p><span>Kind</span>'), 'consumed kind column renders its label');
    assert.equal(bodies, 1);
  });

  it("refuses unowned columns against authorized metadata before row bodies run", async () => {
    let bodies = 0;
    const context = makeContext({
      query: async () => ({ rows: [], columns: [], emptyDeclarations: [
        { field: 'kind', type: 'enum:Roster.Commitment.kind', label: 'Kind', valueLabels: { duty: 'Duty' } },
      ] }),
    });
    const props = { kind: 'agenda' as const, context, model: 'Roster.Commitment',
      startField: 'from', endField: 'until', empty: 'None',
      renderRow: async () => { bodies++; return ['body']; } };
    await assert.rejects(calendar({ ...props, columns: ['location'] }),
      /calendar agenda "Roster.Commitment": missing columns: location/);
    assert.equal(bodies, 0);
    const html = await calendar({ ...props, columns: ['kind'] });
    assert.ok(html.includes('None'), 'owned columns keep the empty state');
    assert.equal(bodies, 0);
  });
});

describe("calendar agenda", () => {
  it("localizes the default empty agenda without invoking authored row callbacks", async () => {
    for (const [preferredLocales, expected] of [[[], 'No records.'], [['nl'], 'Geen gegevens.']] as const) {
      let queries = 0, callbacks = 0;
      const context = makeContext({ preferredLocales, query: async (invocation, model, args) => {
        queries++;
        assert.equal(invocation, context.invocation);
        assert.equal(model, 'Calendar.Booking');
        assert.deepEqual(args, {});
        return { rows: [], columns: [] };
      } });
      const html = await calendar({ kind: 'agenda', context, model: 'Calendar.Booking',
        startField: 'starts', endField: 'ends', renderRow: () => { callbacks++; return []; } });
      assert.equal(html, `<p>${expected}</p>`);
      assert.equal(queries, 1);
      assert.equal(callbacks, 0);
    }
  });

  it("forwards authorized query options and awaits original row bodies sequentially before chronological zone grouping", async () => {
    const rows: RowView[] = [
      { id: 'later', version: '9', fields: { starts: '2026-01-02T05:30:00Z', ends: '<unsafe-end>' } },
      { id: 'earlier-a', version: '3', fields: { starts: '2026-01-01T00:30:00Z', ends: '2026-01-01T01:30:00Z' } },
      { id: 'earlier-b', version: '5', fields: { starts: '2026-01-01T02:30:00Z', ends: '2026-01-01T03:30:00Z' } },
    ];
    const where = { op: 'eq', field: 'state', value: 'confirmed' };
    const order = ['starts', 'id'];
    const seen: unknown[][] = [];
    const calls: RowView[] = [];
    const events: string[] = [];
    const prepareForm: NonNullable<PresentationContext['prepareForm']> = async () => {
      throw new Error('this control does not issue protected forms');
    };
    const ctx = makeContext({ prepareForm, query: async (...args) => {
      seen.push(args); return { rows, columns: [] };
    } });
    const html = await calendar({ kind: 'agenda', context: ctx, model: 'Calendar.Booking',
      startField: 'starts', endField: 'ends', timeZone: 'America/New_York', empty: 'None',
      where, order, limit: 3, cursor: 'original-cursor', page: true, occurrence: 'page:/bookings/agenda',
      renderRow: async (current, view) => {
        assert.equal(view, ctx); assert.equal(view.prepareForm, prepareForm);
        assert.equal(current, rows[calls.length]);
        calls.push(current); events.push(`start:${current.id}`);
        await Promise.resolve(); events.push(`end:${current.id}`);
        return async () => { events.push(`body:${current.id}`); return [`<p>body-${current.id}-${current.version}</p>`]; };
      } });
    assert.deepEqual(seen, [[ctx.invocation, 'Calendar.Booking',
      { where, order, limit: 3, cursor: 'original-cursor', page: true, occurrence: 'page:/bookings/agenda' }]]);
    assert.equal((seen[0]![2] as { where: unknown }).where, where);
    assert.equal((seen[0]![2] as { order: unknown }).order, order);
    assert.deepEqual(calls, rows);
    assert.deepEqual(events.filter(event => !event.startsWith('body:')), [
      'start:later', 'end:later', 'start:earlier-a', 'end:earlier-a', 'start:earlier-b', 'end:earlier-b',
    ]);
    assert.equal(events.filter(event => event.startsWith('body:')).length, 3);
    const page = await loadHtml(html);
    try {
      const sections = [...page.document.querySelectorAll('section')];
      assert.equal(sections.length, 2);
      assert.ok(sections[0]!.querySelector('h2')!.textContent!.includes('2025'));
      assert.deepEqual([...sections[0]!.querySelectorAll('p')].map(body => body.textContent),
        ['body-earlier-a-3', 'body-earlier-b-5']);
      assert.deepEqual([...sections[1]!.querySelectorAll('p')].map(body => body.textContent), ['body-later-9']);
      for (const item of page.document.querySelectorAll('li')) {
        assert.equal(item.firstElementChild?.tagName.toLowerCase(), 'span');
        assert.equal(item.lastElementChild?.tagName.toLowerCase(), 'p');
      }
      assert.ok(sections[1]!.textContent!.includes('<unsafe-end>'));
      assert.equal(page.document.querySelector('unsafe-end'), null);
    } finally { await page.close(); }
  });

  it("rejects unknown or missing agenda start values and query failures before authored row callbacks", async () => {
    let calls = 0;
    const valid = { id: 'valid', version: '1', fields: { starts: '2026-01-01', ends: '2026-01-02' } };
    for (const [startField, fields, error] of [
      ['starts', {}, /missing projected field "starts"/],
      ['unknown', valid.fields, /missing projected field "unknown"/],
      ['starts', { starts: '2026-01-01' }, /missing projected field "ends"/],
      ['starts', { starts: 'not-a-date', ends: '2026-01-02' }, /start field.*needs a date or datetime/],
    ] as const) {
      const ctx = makeContext({ query: async () => ({ rows: [valid, { id: 'missing', version: '2', fields }], columns: [] }) });
      await assert.rejects(calendar({ kind: 'agenda', context: ctx, model: 'Calendar.Booking',
        startField, endField: 'ends', empty: 'None', renderRow: () => { calls++; return []; } }), error);
      assert.equal(calls, 0);
    }
    const denial = new Error('current query authority refused');
    const ctx = makeContext({ query: async () => { throw denial; } });
    await assert.rejects(calendar({ kind: 'agenda', context: ctx, model: 'Calendar.Booking',
      startField: 'starts', endField: 'ends', empty: 'None', renderRow: () => { calls++; return []; } }),
      error => error === denial);
    assert.equal(calls, 0);
  });

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
    assert.ok(html.startsWith('<fieldset class="fieldset">'), "fieldset group");
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
