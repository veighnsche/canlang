import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CSRF_FIELD } from "../../contracts/src/presentation.js";
import type {
  ActionProps,
  DeleteProps,
  EditProps,
  FormFieldDef,
  FormProps,
  PresentationContext,
} from "../../contracts/src/presentation.js";
import type { FieldError, SealedActionHandle } from "../../contracts/src/wire.js";
import { message } from "../src/messages.js";
import {
  action,
  actions,
  deleteRecord,
  edit,
  form,
  formatDatetimeLocal,
  pointerToFieldName,
} from "../src/forms.js";

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

function makeFormProps(overrides: Partial<FormProps> = {}): FormProps {
  return {
    context: makeContext(),
    action: "/submit",
    operation: "TeamTasks.Todo.create",
    operationId: "op-1",
    mode: "create",
    timeZone: "UTC",
    fields: [],
    submit: "Save",
    idPrefix: "f1",
    ...overrides,
  };
}

function makeEditProps(overrides: Partial<EditProps> = {}): EditProps {
  return {
    context: makeContext(),
    action: "/edit",
    operation: "TeamTasks.Todo.update",
    operationId: "op-edit-1",
    record: { id: "r1", version: "3" },
    timeZone: "UTC",
    fields: [],
    submit: "Save",
    idPrefix: "e1",
    ...overrides,
  };
}

function makeDeleteProps(overrides: Partial<DeleteProps> = {}): DeleteProps {
  return {
    context: makeContext(),
    action: "/delete",
    operation: "TeamTasks.Todo.delete",
    operationId: "op-del-1",
    record: { id: "r1", version: "3" },
    mode: "remove",
    itemLabel: "Buy milk",
    confirm: "This cannot be undone.",
    idPrefix: "d1",
    ...overrides,
  };
}

function makeActionProps(overrides: Partial<ActionProps> = {}): ActionProps {
  return {
    context: makeContext(),
    action: "/act",
    operation: "TeamTasks.Todo.complete",
    operationId: "op-act-1",
    label: "Complete",
    idPrefix: "a1",
    ...overrides,
  };
}

function field(path: string, overrides: Partial<FormFieldDef> = {}): FormFieldDef {
  return { path, label: `Label ${path}`, type: "text", required: false, ...overrides };
}

function fieldError(path: string, messageText = "is invalid", code = "type"): FieldError {
  return { path, code, message: messageText };
}

function actionItem(overrides: Partial<ActionProps> = {}): Omit<ActionProps, "context"> {
  const { context: _ignored, ...item } = makeActionProps(overrides);
  void _ignored;
  return item;
}

/** Every id/for/aria-describedby value must carry the caller prefix. */
function assertIdsPrefixed(html: string, prefix: string): void {
  const values: string[] = [];
  for (const match of html.matchAll(/\s(?:id|for|aria-describedby)="([^"]*)"/g)) {
    values.push(match[1] as string);
  }
  assert.ok(values.length > 0, "expected at least one id/for/describedby");
  for (const value of values) {
    assert.ok(value.startsWith(`${prefix}-`), `unprefixed reference: ${value}`);
  }
}

function idRefCount(html: string): number {
  let count = 0;
  for (const _match of html.matchAll(/\s(?:id|for|aria-describedby)="[^"]*"/g)) {
    count += 1;
  }
  return count;
}

describe("pointerToFieldName", () => {
  it("maps single and nested pointers to bracket names", () => {
    assert.equal(pointerToFieldName("/title"), "inputs[title]");
    assert.equal(pointerToFieldName("/changes/title"), "inputs[changes][title]");
    assert.equal(pointerToFieldName("/a/b/c"), "inputs[a][b][c]");
  });

  it("unescapes ~0 and ~1 per RFC 6901", () => {
    assert.equal(pointerToFieldName("/a~1b"), "inputs[a/b]");
    assert.equal(pointerToFieldName("/a~0b"), "inputs[a~b]");
    assert.equal(pointerToFieldName("/~01"), "inputs[~1]");
    assert.equal(pointerToFieldName("/~10"), "inputs[/0]");
  });

  it("rejects pointers without a leading slash", () => {
    assert.throws(() => pointerToFieldName(""), /malformed JSON pointer/);
    assert.throws(() => pointerToFieldName("changes/title"), /must start with "\/"/);
  });

  it("rejects empty segments and bad escapes", () => {
    assert.throws(() => pointerToFieldName("/a//b"), /empty segment/);
    assert.throws(() => pointerToFieldName("/"), /empty segment/);
    assert.throws(() => pointerToFieldName("/a~2b"), /bad escape/);
    assert.throws(() => pointerToFieldName("/a~"), /bad escape/);
  });

  it("rejects non-string input", () => {
    assert.throws(() => pointerToFieldName(42 as unknown as string), TypeError);
  });
});

describe("formatDatetimeLocal", () => {
  it("renders UTC instants verbatim to the minute", () => {
    assert.equal(formatDatetimeLocal("2024-01-15T12:34:56Z", "UTC"), "2024-01-15T12:34");
    assert.equal(formatDatetimeLocal("2024-01-15T12:34:56.789Z", "UTC"), "2024-01-15T12:34");
  });

  it("converts to Europe/Amsterdam wall time in winter (+1)", () => {
    assert.equal(
      formatDatetimeLocal("2024-01-15T12:00:00Z", "Europe/Amsterdam"),
      "2024-01-15T13:00",
    );
  });

  it("converts to Europe/Amsterdam wall time on a DST date (+2)", () => {
    assert.equal(
      formatDatetimeLocal("2024-07-15T12:00:00Z", "Europe/Amsterdam"),
      "2024-07-15T14:00",
    );
  });

  it("rolls the calendar day across midnight offsets", () => {
    assert.equal(
      formatDatetimeLocal("2024-01-15T23:30:00Z", "Europe/Amsterdam"),
      "2024-01-16T00:30",
    );
  });

  it("rejects rolled-over dates, bad times and non-canonical shapes", () => {
    assert.throws(() => formatDatetimeLocal("2024-02-30T12:00:00Z", "UTC"), TypeError);
    assert.throws(() => formatDatetimeLocal("2024-01-15T25:00:00Z", "UTC"), TypeError);
    assert.throws(() => formatDatetimeLocal("2024-01-15T12:00:60Z", "UTC"), TypeError);
    assert.throws(() => formatDatetimeLocal("15/01/2024", "UTC"), TypeError);
    assert.throws(() => formatDatetimeLocal("2024-01-15T12:00:00", "UTC"), TypeError);
  });

  it("lets an invalid time zone throw the Intl RangeError", () => {
    assert.throws(() => formatDatetimeLocal("2024-01-15T12:00:00Z", "Mars/Olympus"), RangeError);
  });
});

describe("form hidden fields and roots", () => {
  it("renders operation, operation_id, csrf and timezone hiddens", async () => {
    const html = await form(makeFormProps());
    assert.ok(html.includes('<form action="/submit" method="post">'));
    assert.ok(html.includes('<input type="hidden" name="operation" value="TeamTasks.Todo.create">'));
    assert.ok(html.includes('<input type="hidden" name="operation_id" value="op-1">'));
    assert.ok(html.includes(`<input type="hidden" name="${CSRF_FIELD}" value="csrf-123">`));
    assert.ok(html.includes('<input type="hidden" name="timezone" value="UTC">'));
    assert.ok(!html.includes("inputs[record]"));
  });

  it("renders record identity hiddens when a record is bound", async () => {
    const html = await form(makeFormProps({ record: { id: "r1", version: "42" } }));
    assert.ok(html.includes('<input type="hidden" name="inputs[record][id]" value="r1">'));
    assert.ok(html.includes('<input type="hidden" name="inputs[record][version]" value="42">'));
  });

  it("roots create and scenario fields under inputs, update under inputs[changes]", async () => {
    const create = await form(makeFormProps({ fields: [field("title")] }));
    assert.ok(create.includes('name="inputs[title]"'));
    const scenario = await form(makeFormProps({ mode: "scenario", fields: [field("title")] }));
    assert.ok(scenario.includes('name="inputs[title]"'));
    const update = await form(
      makeFormProps({ mode: "update", record: { id: "r1", version: "3" }, fields: [field("title")] }),
    );
    assert.ok(update.includes('name="inputs[changes][title]"'));
    assert.ok(!update.includes('name="inputs[title]"'));
  });

  it("throws when update mode has no bound record", async () => {
    await assert.rejects(form(makeFormProps({ mode: "update" })), /update mode requires a bound record/);
  });

  it("renders the primary submit button and an optional ghost cancel link", async () => {
    const plain = await form(makeFormProps());
    assert.ok(plain.includes('<button type="submit" class="btn btn-primary">Save</button>'));
    assert.ok(!plain.includes("btn-ghost"));
    const withCancel = await form(makeFormProps({ cancelHref: "/back" }));
    assert.ok(withCancel.includes('<a class="btn btn-ghost" href="/back">Cancel</a>'));
  });

  it("resolves the submit label and cancel copy per locale", async () => {
    const html = await form(
      makeFormProps({
        context: makeContext({ preferredLocales: ["nl"] }),
        submit: message("Save", { nl: "Opslaan" }),
        cancelHref: "/back",
      }),
    );
    assert.ok(html.includes(">Opslaan</button>"));
    assert.ok(html.includes(">Annuleren</a>"));
  });

  it("labels each fieldset with a prefixed for/id pair", async () => {
    const html = await form(makeFormProps({ fields: [field("title")] }));
    assert.ok(html.includes("<fieldset>"));
    assert.ok(html.includes('<label for="f1-title"'));
    assert.ok(html.includes('id="f1-title"'));
    assertIdsPrefixed(html, "f1");
  });
});

describe("form field widgets", () => {
  it("renders text, email and url inputs with escaped values", async () => {
    const html = await form(
      makeFormProps({
        fields: [
          field("a", { type: "text", value: `x"y<z` }),
          field("b", { type: "email", value: "a@b.c" }),
          field("c", { type: "url", value: "https://example.com" }),
        ],
      }),
    );
    assert.ok(html.includes('type="text" name="inputs[a]"'));
    assert.ok(html.includes('value="x&quot;y&lt;z"'));
    assert.ok(html.includes('type="email" name="inputs[b]"'));
    assert.ok(html.includes('type="url" name="inputs[c]"'));
  });

  it("renders timezone, locale and currency as text inputs", async () => {
    const html = await form(
      makeFormProps({
        fields: [
          field("tz", { type: "timezone", value: "Europe/Amsterdam" }),
          field("loc", { type: "locale", value: "nl-NL" }),
          field("cur", { type: "currency", value: "EUR" }),
        ],
      }),
    );
    for (const name of ["inputs[tz]", "inputs[loc]", "inputs[cur]"]) {
      assert.ok(html.includes(`type="text" name="${name}"`));
    }
  });

  it("renders multiline fields as textareas with escaped content", async () => {
    const html = await form(
      makeFormProps({ fields: [field("body", { multiline: true, value: "a</textarea><b>" })] }),
    );
    assert.ok(html.includes('<textarea name="inputs[body]" id="f1-body"'));
    assert.ok(html.includes("a&lt;/textarea&gt;&lt;b&gt;</textarea>"));
  });

  it("rejects non-string values for text-like fields", async () => {
    await assert.rejects(
      form(makeFormProps({ fields: [field("a", { value: 42 })] })),
      /type text needs a string value/,
    );
  });

  it("renders ints exactly from bigint, safe numbers and decimal strings", async () => {
    const html = await form(
      makeFormProps({
        fields: [
          field("big", { type: "int", value: 9007199254740993n }),
          field("small", { type: "int", value: 42 }),
          field("padded", { type: "int", value: "+007" }),
        ],
      }),
    );
    assert.ok(html.includes('inputmode="decimal" name="inputs[big]"'));
    assert.ok(html.includes('name="inputs[big]" id="f1-big" value="9007199254740993"'));
    assert.ok(html.includes('name="inputs[small]" id="f1-small" value="42"'));
    assert.ok(html.includes('name="inputs[padded]" id="f1-padded" value="+007"'));
  });

  it("rejects lossy int values", async () => {
    for (const value of [1.5, 9007199254740993, "12.5", "abc", true]) {
      await assert.rejects(
        form(makeFormProps({ fields: [field("n", { type: "int", value })] })),
        /type int needs/,
        `value ${String(value)} should throw`,
      );
    }
  });

  it("renders decimal and money strings verbatim without reformatting", async () => {
    const html = await form(
      makeFormProps({
        fields: [
          field("d", { type: "decimal", value: "12.50" }),
          field("m", { type: "money", value: "1234" }),
          field("big", { type: "decimal", value: 5n }),
        ],
      }),
    );
    assert.ok(html.includes('name="inputs[d]" id="f1-d" value="12.50"'));
    assert.ok(html.includes('name="inputs[m]" id="f1-m" value="1234"'));
    assert.ok(html.includes('name="inputs[big]" id="f1-big" value="5"'));
  });

  it("rejects binary floats for decimals and non-minor money", async () => {
    await assert.rejects(
      form(makeFormProps({ fields: [field("d", { type: "decimal", value: 1.5 })] })),
      /type decimal needs/,
    );
    await assert.rejects(
      form(makeFormProps({ fields: [field("m", { type: "money", value: "12.50" })] })),
      /type money needs/,
    );
  });

  it("renders bools as toggles checked by value", async () => {
    const html = await form(
      makeFormProps({
        fields: [
          field("on", { type: "bool", value: true }),
          field("off", { type: "bool", value: false }),
        ],
      }),
    );
    assert.ok(html.includes('type="checkbox" name="inputs[on]" id="f1-on" value="true" checked'));
    assert.ok(html.includes('class="toggle"'));
    assert.ok(!html.includes('name="inputs[off]" id="f1-off" value="true" checked'));
    await assert.rejects(
      form(makeFormProps({ fields: [field("b", { type: "bool", value: "yes" })] })),
      /type bool needs a boolean value/,
    );
  });

  it("renders enums as selects with the current value selected", async () => {
    const html = await form(
      makeFormProps({
        fields: [
          field("status", {
            type: "enum",
            value: "b",
            options: [
              { value: "a", label: "A" },
              { value: "b", label: message("Bee", { nl: "Bij" }) },
            ],
          }),
        ],
      }),
    );
    assert.ok(html.includes('<select name="inputs[status]" id="f1-status"'));
    assert.ok(html.includes('<option value="a">A</option>'));
    assert.ok(html.includes('<option value="b" selected>Bee</option>'));
  });

  it("selects nothing when an enum has no value", async () => {
    const html = await form(
      makeFormProps({
        fields: [
          field("status", { type: "enum", options: [{ value: "a", label: "A" }] }),
        ],
      }),
    );
    assert.ok(!html.includes("selected"));
  });

  it("requires schema-supplied options for enum selects", async () => {
    await assert.rejects(
      form(makeFormProps({ fields: [field("status", { type: "enum" })] })),
      /schema-supplied options/,
    );
    await assert.rejects(
      form(
        makeFormProps({ fields: [field("status", { type: "expense.Expense.status", value: "x" })] }),
      ),
      /schema-supplied options/,
    );
  });

  it("renders qualified 3-segment enum identities as selects", async () => {
    const html = await form(
      makeFormProps({
        fields: [
          field("status", {
            type: "expense.Expense.status",
            value: "paid",
            options: [{ value: "paid", label: "Paid" }],
          }),
        ],
      }),
    );
    assert.ok(html.includes("<select"));
    assert.ok(html.includes('<option value="paid" selected>Paid</option>'));
  });

  it("renders 2-segment model references as selects via the S5 picker error", async () => {
    const html = await form(
      makeFormProps({
        fields: [
          field("todo", {
            type: "TeamTasks.Todo",
            value: "t1",
            options: [{ value: "t1", label: "First" }],
          }),
        ],
      }),
    );
    assert.ok(html.includes("<select"));
    await assert.rejects(
      form(makeFormProps({ fields: [field("todo", { type: "TeamTasks.Todo" })] })),
      /S5 search picker/,
    );
  });

  it("renders dates and validates the civil calendar", async () => {
    const html = await form(
      makeFormProps({ fields: [field("day", { type: "date", value: "2024-02-29" })] }),
    );
    assert.ok(html.includes('type="date" name="inputs[day]"'));
    assert.ok(html.includes('value="2024-02-29"'));
    await assert.rejects(
      form(makeFormProps({ fields: [field("day", { type: "date", value: "2024-02-30" })] })),
      /needs a valid YYYY-MM-DD civil date/,
    );
    await assert.rejects(
      form(makeFormProps({ fields: [field("day", { type: "date", value: "30-01-2024" })] })),
      /needs a valid YYYY-MM-DD civil date/,
    );
  });

  it("renders datetimes in the form time zone with a zone label", async () => {
    const html = await form(
      makeFormProps({
        timeZone: "Europe/Amsterdam",
        fields: [field("when", { type: "datetime", value: "2024-07-15T12:00:00Z" })],
      }),
    );
    assert.ok(html.includes('type="datetime-local" name="inputs[when]"'));
    assert.ok(html.includes('value="2024-07-15T14:00"'));
    assert.ok(html.includes("<span>Europe/Amsterdam</span>"));
    await assert.rejects(
      form(makeFormProps({ fields: [field("when", { type: "datetime", value: "2024-13-01T00:00:00Z" })] })),
      /field "when"/,
    );
  });

  it("throws naming S7 upload intents for file types", async () => {
    await assert.rejects(
      form(makeFormProps({ fields: [field("avatar", { type: "file" })] })),
      /S7 upload intents/,
    );
    await assert.rejects(
      form(makeFormProps({ fields: [field("clip", { type: "file.video" })] })),
      /S7 upload intents/,
    );
  });

  it("throws a precise error for unknown types", async () => {
    await assert.rejects(
      form(makeFormProps({ fields: [field("weird", { type: "bogus" })] })),
      /field "weird": unsupported type "bogus"/,
    );
  });

  it("rejects field paths outside the identifier shape", async () => {
    for (const path of ["0bad", "has-dash", "has space", ""]) {
      await assert.rejects(
        form(makeFormProps({ fields: [field(path)] })),
        /invalid field path/,
        `path ${JSON.stringify(path)} should throw`,
      );
    }
  });
});

describe("required and readonly fields", () => {
  it("marks required fields with aria-required and a visual star", async () => {
    const html = await form(
      makeFormProps({
        fields: [field("req", { required: true }), field("opt")],
      }),
    );
    assert.ok(html.includes('name="inputs[req]" id="f1-req" value="" class="input" aria-required="true"'));
    assert.ok(html.includes('Label req <span aria-hidden="true">*</span>'));
    assert.ok(!html.includes('name="inputs[opt]" id="f1-opt" value="" class="input" aria-required'));
    assert.ok(!html.includes("Label opt <span"));
  });

  it("disables readonly inputs and duplicates the value in a hidden field", async () => {
    const html = await form(
      makeFormProps({ fields: [field("title", { readonly: true, value: "draft" })] }),
    );
    assert.ok(html.includes(" disabled>") || html.includes(" disabled "));
    assert.ok(html.includes('<input type="hidden" name="inputs[title]" value="draft">'));
  });

  it("carries readonly toggle state as true/false hiddens", async () => {
    const html = await form(
      makeFormProps({
        fields: [
          field("on", { type: "bool", readonly: true, value: true }),
          field("off", { type: "bool", readonly: true, value: false }),
        ],
      }),
    );
    assert.ok(html.includes('<input type="hidden" name="inputs[on]" value="true">'));
    assert.ok(html.includes('<input type="hidden" name="inputs[off]" value="false">'));
  });

  it("disables readonly selects and duplicates the selection", async () => {
    const html = await form(
      makeFormProps({
        fields: [
          field("status", {
            type: "enum",
            readonly: true,
            value: "b",
            options: [{ value: "b", label: "B" }],
          }),
        ],
      }),
    );
    assert.ok(html.includes("<select"));
    assert.ok(html.includes(" disabled>") || html.includes(" disabled "));
    assert.ok(html.includes('<input type="hidden" name="inputs[status]" value="b">'));
  });
});

describe("form error mapping", () => {
  it("wires matched errors under the input with aria attributes", async () => {
    const html = await form(
      makeFormProps({
        fields: [field("title")],
        errors: [fieldError("/title", "Title is required", "required")],
      }),
    );
    assert.ok(html.includes("Title is required"));
    assert.ok(html.includes('aria-invalid="true" aria-describedby="f1-title-error"'));
    assert.ok(html.includes('<div id="f1-title-error">'));
    assert.ok(!html.includes('role="alert"'));
    assertIdsPrefixed(html, "f1");
  });

  it("lists every error on a field with several failures", async () => {
    const html = await form(
      makeFormProps({
        fields: [field("title")],
        errors: [fieldError("/title", "First problem"), fieldError("/title", "Second problem")],
      }),
    );
    assert.ok(html.includes("First problem"));
    assert.ok(html.includes("Second problem"));
  });

  it("routes unmatched errors to a top alert instead of dropping them", async () => {
    const html = await form(
      makeFormProps({
        fields: [field("title")],
        errors: [fieldError("/nope", "Unknown input rejected", "unknown-field")],
      }),
    );
    assert.ok(html.includes('role="alert"'));
    assert.ok(html.includes("There were problems with your submission."));
    assert.ok(html.includes("Unknown input rejected (unknown-field)"));
    assert.ok(!html.includes("aria-invalid"));
  });

  it("matches update errors under /changes and treats /title as unmatched", async () => {
    const matched = await form(
      makeFormProps({
        mode: "update",
        record: { id: "r1", version: "3" },
        fields: [field("title")],
        errors: [fieldError("/changes/title", "bad change")],
      }),
    );
    assert.ok(matched.includes("bad change"));
    assert.ok(matched.includes('aria-describedby="f1-title-error"'));
    const unmatched = await form(
      makeFormProps({
        mode: "update",
        record: { id: "r1", version: "3" },
        fields: [field("title")],
        errors: [fieldError("/title", "wrong root")],
      }),
    );
    assert.ok(unmatched.includes('role="alert"'));
    assert.ok(unmatched.includes("wrong root"));
    assert.ok(!unmatched.includes("aria-invalid"));
  });

  it("unescapes pointers before matching so odd paths surface unmatched", async () => {
    const html = await form(
      makeFormProps({
        fields: [field("title")],
        errors: [fieldError("/we~1ird", "Odd path rejected")],
      }),
    );
    assert.ok(html.includes('role="alert"'));
    assert.ok(html.includes("Odd path rejected"));
  });

  it("routes separator-adversarial paths to the escaped summary, never to fields", async () => {
    const html = await form(
      makeFormProps({
        fields: [field("title")],
        errors: [
          fieldError("/TITLE", "case-shifted"),
          fieldError("/\u200btitle", "zero-width lead"),
          fieldError("/title\"", "quoted"),
          fieldError("/changes/title/..", "traversal"),
        ],
      }),
    );
    assert.ok(html.includes('role="alert"'));
    for (const message of ["case-shifted", "zero-width lead", "quoted", "traversal"]) {
      assert.ok(html.includes(message));
    }
    assert.ok(!html.includes("aria-invalid"));
    assert.ok(!html.includes('id="f1-title-error"'));
  });
});

describe("form outcomes", () => {
  it("renders pending deliveries with status badges", async () => {
    const html = await form(
      makeFormProps({
        fields: [field("title")],
        outcome: {
          status: "pending",
          deliveries: [
            { id: "d-pending", status: "pending" },
            { id: "d-ok", status: "succeeded" },
            { id: "d-bad", status: "failed" },
            { id: "d-unknown", status: "unknown" },
            { id: "d-skip", status: "skipped" },
          ],
        },
      }),
    );
    assert.ok(html.includes('role="status"'));
    assert.ok(html.includes("Deliveries are still pending."));
    assert.ok(html.includes("d-pending"));
    assert.ok(html.includes('<span class="badge badge-warning">Pending</span>'));
    assert.ok(html.includes('<span class="badge badge-success">Succeeded</span>'));
    assert.ok(html.includes('<span class="badge badge-error">Failed</span>'));
    assert.ok(html.includes('<span class="badge badge-ghost">Unknown</span>'));
    assert.ok(html.includes('<span class="badge badge-ghost">Skipped</span>'));
  });

  it("localizes pending badges to Dutch", async () => {
    const html = await form(
      makeFormProps({
        context: makeContext({ preferredLocales: ["nl"] }),
        outcome: {
          status: "pending",
          deliveries: [
            { id: "d1", status: "succeeded" },
            { id: "d2", status: "pending" },
          ],
        },
      }),
    );
    assert.ok(html.includes("Leveringen zijn nog in behandeling."));
    assert.ok(html.includes(">Geslaagd</span>"));
    assert.ok(html.includes(">In behandeling</span>"));
  });

  it("renders conflict currents in a table while drafts stay in the inputs", async () => {
    const html = await form(
      makeFormProps({
        fields: [field("title", { type: "text", value: "Draft!" }), field("n", { type: "int" })],
        outcome: {
          status: "conflict",
          current: { title: "Current", n: 7n, mystery: "<raw>" },
          message: "Someone else saved first.",
        },
      }),
    );
    assert.ok(html.includes('role="alert"'));
    assert.ok(html.includes("Someone else saved first."));
    assert.ok(html.includes("<th scope=\"col\">Field</th>"));
    assert.ok(html.includes("Label title"));
    assert.ok(html.includes("<td>Current</td>"));
    assert.ok(html.includes("<td>7</td>"));
    assert.ok(html.includes("mystery"));
    assert.ok(html.includes("&lt;raw&gt;"));
    assert.ok(html.includes('name="inputs[title]" id="f1-title" value="Draft!"'));
  });

  it("falls back to raw escaped text for unformattable conflict values", async () => {
    const html = await form(
      makeFormProps({
        fields: [field("price", { type: "money" })],
        outcome: {
          status: "conflict",
          current: { price: { minor: "1234", currency: "USD" } },
          message: "Stale write.",
        },
      }),
    );
    assert.ok(html.includes("&quot;minor&quot;"));
    assert.ok(html.includes("1234"));
  });

  it("renders failed outcomes with message, code and a retry hint when retryable", async () => {
    const retryable = await form(
      makeFormProps({
        outcome: { status: "failed", error: { code: "busy", message: "Upstream busy.", retryable: true } },
      }),
    );
    assert.ok(retryable.includes('role="alert"'));
    assert.ok(retryable.includes("Upstream busy."));
    assert.ok(retryable.includes("<code>busy</code>"));
    assert.ok(retryable.includes("You can retry."));
    const fatal = await form(
      makeFormProps({
        outcome: { status: "failed", error: { code: "rule_failed", message: "Denied by policy." } },
      }),
    );
    assert.ok(fatal.includes("Denied by policy."));
    assert.ok(!fatal.includes("You can retry."));
  });

  it("localizes the retry hint to Dutch", async () => {
    const html = await form(
      makeFormProps({
        context: makeContext({ preferredLocales: ["nl"] }),
        outcome: { status: "failed", error: { code: "busy", message: "Druk.", retryable: true } },
      }),
    );
    assert.ok(html.includes("U kunt het opnieuw proberen."));
  });

  it("renders unknown outcomes with a monospace operation id", async () => {
    const html = await form(
      makeFormProps({
        outcome: { status: "unknown", operationId: "op-xyz", message: "Check later." },
      }),
    );
    assert.ok(html.includes('role="alert"'));
    assert.ok(html.includes("The outcome is unknown."));
    assert.ok(html.includes("<code>op-xyz</code>"));
    assert.ok(html.includes("Check later."));
  });
});

describe("edit", () => {
  it("renders an update form with changes roots and record hiddens", async () => {
    const html = await edit(makeEditProps({ fields: [field("title")] }));
    assert.ok(html.includes('name="inputs[changes][title]"'));
    assert.ok(html.includes('<input type="hidden" name="inputs[record][id]" value="r1">'));
    assert.ok(html.includes('<input type="hidden" name="inputs[record][version]" value="3">'));
    assertIdsPrefixed(html, "e1");
  });
});

describe("deleteRecord", () => {
  it("renders a remove confirmation with an error-toned submit", async () => {
    const html = await deleteRecord(makeDeleteProps());
    assert.ok(html.includes('<section class="card bg-base-100 shadow">'));
    assert.ok(html.includes('<h2 class="card-title">Buy milk</h2>'));
    assert.ok(html.includes("<p>This cannot be undone.</p>"));
    assert.ok(html.includes('<form action="/delete" method="post">'));
    assert.ok(html.includes('<input type="hidden" name="operation" value="TeamTasks.Todo.delete">'));
    assert.ok(html.includes('<input type="hidden" name="operation_id" value="op-del-1">'));
    assert.ok(html.includes(`name="${CSRF_FIELD}" value="csrf-123"`));
    assert.ok(html.includes('<input type="hidden" name="timezone" value="UTC">'));
    assert.ok(html.includes('<input type="hidden" name="inputs[record][id]" value="r1">'));
    assert.ok(html.includes('<input type="hidden" name="inputs[mode]" value="remove">'));
    assert.ok(html.includes('<button type="submit" class="btn btn-error">Delete</button>'));
    assert.ok(!html.includes("btn-ghost"));
    assert.equal(idRefCount(html), 0);
  });

  it("renders an archive confirmation with a warning-toned submit", async () => {
    const html = await deleteRecord(makeDeleteProps({ mode: "archive" }));
    assert.ok(html.includes('<input type="hidden" name="inputs[mode]" value="archive">'));
    assert.ok(html.includes('<button type="submit" class="btn btn-warning">Archive</button>'));
  });

  it("adds a ghost cancel link when cancelHref is present", async () => {
    const html = await deleteRecord(makeDeleteProps({ cancelHref: "/todos" }));
    assert.ok(html.includes('<a class="btn btn-ghost" href="/todos">Cancel</a>'));
  });

  it("localizes delete chrome to Dutch", async () => {
    const html = await deleteRecord(
      makeDeleteProps({ context: makeContext({ preferredLocales: ["nl"] }), cancelHref: "/todos" }),
    );
    assert.ok(html.includes(">Verwijderen</button>"));
    assert.ok(html.includes(">Annuleren</a>"));
  });
});

describe("action", () => {
  const handle: SealedActionHandle = {
    kind: "action_handle",
    handle: "h1",
    target: "TeamTasks.run",
    revision: "r1",
  };

  it("renders a single-button form with hidden bindings and scalars", async () => {
    const html = await action(
      makeActionProps({
        record: { id: "r9", version: "11" },
        actionHandle: handle,
        inputs: { note: "hi", count: 3, big: 9007199254740993n, flag: true },
      }),
    );
    assert.ok(html.includes('<form action="/act" method="post">'));
    assert.ok(html.includes('<input type="hidden" name="operation" value="TeamTasks.Todo.complete">'));
    assert.ok(html.includes(`name="${CSRF_FIELD}" value="csrf-123"`));
    assert.ok(html.includes('<input type="hidden" name="timezone" value="UTC">'));
    assert.ok(html.includes('<input type="hidden" name="inputs[record][id]" value="r9">'));
    assert.ok(html.includes('name="action_handle"'));
    assert.ok(html.includes("&quot;kind&quot;:&quot;action_handle&quot;"));
    assert.ok(html.includes('<input type="hidden" name="inputs[note]" value="hi">'));
    assert.ok(html.includes('<input type="hidden" name="inputs[count]" value="3">'));
    assert.ok(html.includes('<input type="hidden" name="inputs[big]" value="9007199254740993">'));
    assert.ok(html.includes('<input type="hidden" name="inputs[flag]" value="true">'));
    assert.ok(html.includes('<button type="submit" class="btn btn-primary">Complete</button>'));
    assert.ok(!html.includes("<fieldset>"));
  });

  it("maps variants to button tones with primary as default", async () => {
    const primary = await action(makeActionProps());
    assert.ok(primary.includes('class="btn btn-primary"'));
    const danger = await action(makeActionProps({ variant: "danger" }));
    assert.ok(danger.includes('class="btn btn-error"'));
    const ghost = await action(makeActionProps({ variant: "ghost" }));
    assert.ok(ghost.includes('class="btn btn-ghost"'));
  });

  it("renders a scenario mini-form when fields are present", async () => {
    const html = await action(
      makeActionProps({
        timeZone: "Europe/Amsterdam",
        record: { id: "r9", version: "11" },
        fields: [field("reason"), field("when", { type: "datetime", value: "2024-07-15T12:00:00Z" })],
        errors: [fieldError("/reason", "Required"), fieldError("/nope", "Stray")],
      }),
    );
    assert.ok(html.includes('<input type="hidden" name="timezone" value="Europe/Amsterdam">'));
    assert.ok(html.includes('name="inputs[reason]"'));
    assert.ok(html.includes('value="2024-07-15T14:00"'));
    assert.ok(html.includes('aria-describedby="a1-reason-error"'));
    assert.ok(html.includes('role="alert"'));
    assert.ok(html.includes("Stray"));
    assertIdsPrefixed(html, "a1");
  });

  it("surfaces errors on button-only forms in the top alert", async () => {
    const html = await action(
      makeActionProps({ errors: [fieldError("/note", "Note rejected")] }),
    );
    assert.ok(html.includes('role="alert"'));
    assert.ok(html.includes("Note rejected"));
  });

  it("renders confirm copy as an explainer paragraph above submit", async () => {
    const html = await action(makeActionProps({ confirm: "This starts the job." }));
    assert.ok(html.includes("<p>This starts the job.</p>"));
    assert.ok(html.indexOf("This starts the job.") < html.indexOf('type="submit"'));
  });

  it("rejects non-scalar bindings with precise errors", async () => {
    const objectInputs = { o: { a: 1 } } as unknown as Record<string, string | number | bigint | boolean>;
    await assert.rejects(action(makeActionProps({ inputs: objectInputs })), /action input "o"/);
    const nullInputs = { n: null } as unknown as Record<string, string | number | bigint | boolean>;
    await assert.rejects(action(makeActionProps({ inputs: nullInputs })), /action input "n"/);
    await assert.rejects(
      action(makeActionProps({ inputs: { n: Number.NaN } })),
      /number value must be finite/,
    );
  });

  it("rejects scalar keys outside the identifier shape", async () => {
    await assert.rejects(
      action(makeActionProps({ inputs: { "a-b": "x" } })),
      /invalid field path/,
    );
  });

  it("rejects non-serializable action handles", async () => {
    const bad = (() => {}) as unknown as SealedActionHandle;
    await assert.rejects(
      action(makeActionProps({ actionHandle: bad })),
      /action_handle must be JSON-serializable/,
    );
  });
});

describe("actions", () => {
  it("renders each action as its own form in a flex gap-2 group", async () => {
    const html = await actions({
      context: makeContext(),
      actions: [
        actionItem({ label: "One", idPrefix: "g1" }),
        actionItem({ label: "Two", idPrefix: "g2", variant: "danger" }),
      ],
    });
    assert.ok(html.includes('<div class="flex gap-2">'));
    assert.equal(html.split("<form").length - 1, 2);
    assert.ok(html.includes(">One</button>"));
    assert.ok(html.includes(">Two</button>"));
    assert.ok(html.includes('class="btn btn-error">Two</button>'));
  });

  it("shares the page context across grouped actions", async () => {
    const html = await actions({
      context: makeContext({ csrfToken: "shared-csrf" }),
      actions: [
        actionItem({ idPrefix: "g1" }),
        actionItem({ idPrefix: "g2" }),
      ],
    });
    assert.equal(html.split('value="shared-csrf"').length - 1, 2);
  });
});

describe("forms escaping and prefixes", () => {
  it("escapes labels, values, options and errors", async () => {
    const html = await form(
      makeFormProps({
        fields: [
          field("title", {
            label: "<script>alert(1)</script>",
            value: `x" onfocus="alert(1)`,
          }),
          field("status", {
            type: "enum",
            value: `b"bad`,
            options: [{ value: `b"bad`, label: "<img src=x>" }],
          }),
        ],
        errors: [fieldError("/title", "<img src=x onerror=alert(1)>"), fieldError("/nope", "<b>unmatched</b>")],
      }),
    );
    assert.ok(!html.includes("<script>"));
    assert.ok(!html.includes('onfocus="alert(1)"'));
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(html.includes('value="x&quot; onfocus=&quot;alert(1)"'));
    assert.ok(html.includes('<option value="b&quot;bad" selected>&lt;img src=x&gt;</option>'));
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
    assert.ok(html.includes("&lt;b&gt;unmatched&lt;/b&gt;"));
  });

  it("falls back to # for unsafe action and cancel urls", async () => {
    const html = await form(
      makeFormProps({ action: "javascript:alert(1)", cancelHref: "JaVaScRiPt:alert(1)" }),
    );
    assert.ok(html.includes('<form action="#" method="post">'));
    assert.ok(html.includes('href="#"'));
    assert.ok(!html.includes("javascript:"));
    assert.ok(!html.includes("JaVaScRiPt:"));
  });

  it("neutralizes unsafe action urls on edit, delete and action too", async () => {
    const edited = await edit(makeEditProps({ action: "javascript:alert(2)" }));
    const deleted = await deleteRecord(makeDeleteProps({ action: "JaVaScRiPt:alert(3)" }));
    const acted = await action(makeActionProps({ action: "vbscript:msgbox(4)" }));
    for (const html of [edited, deleted, acted]) {
      assert.ok(html.includes('<form action="#" method="post">'));
      assert.ok(!html.includes("javascript:"));
      assert.ok(!html.includes("JaVaScRiPt:"));
      assert.ok(!html.includes("vbscript:"));
    }
  });

  it("survives malformed error pointers by listing them unmatched", async () => {
    const html = await form(
      makeFormProps({
        fields: [field("title")],
        errors: [
          fieldError("no-leading-slash", "bad shape"),
          fieldError("/title//x", "empty segment"),
          fieldError("/title", "real one"),
        ],
      }),
    );
    assert.ok(html.includes('role="alert"'));
    assert.ok(html.includes("bad shape"));
    assert.ok(html.includes("empty segment"));
    assert.ok(html.includes('aria-describedby="f1-title-error"'));
    assert.ok(html.includes("real one"));
  });

  it("escapes hostile id prefixes in every id, for and describedby", async () => {
    const html = await form(
      makeFormProps({
        idPrefix: `p"><svg`,
        fields: [field("title")],
        errors: [fieldError("/title", "bad")],
      }),
    );
    assert.ok(!html.includes('"><svg'));
    assert.ok(html.includes('for="p&quot;&gt;&lt;svg-title"'));
    assert.ok(html.includes('id="p&quot;&gt;&lt;svg-title"'));
    assert.ok(html.includes('aria-describedby="p&quot;&gt;&lt;svg-title-error"'));
  });

  it("escapes operation ids in hiddens and the unknown banner", async () => {
    const html = await form(
      makeFormProps({
        operationId: `"><script>alert(1)</script>`,
        outcome: {
          status: "unknown",
          operationId: `"><script>alert(1)</script>`,
          message: "Check.",
        },
      }),
    );
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"'));
    assert.ok(html.includes("<code>&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</code>"));
  });

  it("applies a custom id prefix to every generated reference", async () => {
    const html = await form(
      makeFormProps({
        idPrefix: "xyz9",
        fields: [field("title", { required: true })],
        errors: [fieldError("/title", "bad")],
      }),
    );
    assertIdsPrefixed(html, "xyz9");
  });
});
