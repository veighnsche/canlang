import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SchemaError } from "@canlang/values";
import type {
  FormFieldDef,
  PresentationContext,
} from "@canlang/contracts";
import type { DerivedOperationInputs } from "@canlang/contracts";
import {
  GENERATED_DATETIME_FOLD_SUFFIX,
  GENERATED_MONEY_CURRENCY_SUFFIX,
  GENERATED_NULL_SUFFIX,
  form,
  generatedDraftValues,
  generatedFields,
  generatedForm,
  projectGeneratedInputs,
  wallToInstant,
} from "../src/forms.js";

// T20b generated-depth tests: delivery/file/datetime/null/money presentation
// over the committed T19b derivation.
//
// Grounding (no invented operations): RETRY/LEDGER_* mirror
// deriveOperationInputs() over the T19b verbatim emission pinned in
// packages/interfaces/test/t19b-depth.test.ts (names, kinds, required
// sets, bindings, and the file-claim boundary). WHEN_* are mapping-rule
// probes for kinds no T19b op carries (datetime, nullable); they prove
// mapping rules, not operations.

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

/* Mirrored derivation: Receipts.retry (scenario) — the T19b delivery depth op. */
const RETRY: DerivedOperationInputs = {
  operation: "Receipts.retry",
  kind: "scenario",
  artifactVersion: 1,
  inputs: [
    { name: "note", kind: "string", required: true },
    {
      name: "attempt",
      kind: "delivery",
      required: false,
      nullable: true,
      delivery: {
        capability: "std.EmailV1",
        operation: "send",
        version: 1,
        result: { name: "EmailAccepted", leaves: [{ name: "reference", type: "text" }] },
        recipe: "delivery:std.EmailV1.send",
      },
    },
  ],
};

/* Mirrored derivation: Ledger.Entry.create — money + file depth. */
const LEDGER_CREATE: DerivedOperationInputs = {
  operation: "Ledger.Entry.create",
  kind: "create",
  artifactVersion: 1,
  inputs: [
    { name: "title", kind: "string", required: true },
    { name: "stock", kind: "integer", required: false },
    { name: "price", kind: "decimal", required: false },
    { name: "fee", kind: "money", required: false },
    {
      name: "doc",
      kind: "file",
      required: true,
      file: { valueShape: "opaque-file-id", format: "can-file" },
    },
  ],
};

/* Mirrored derivation: Ledger.Entry.update — optional money + file depth. */
const LEDGER_UPDATE: DerivedOperationInputs = {
  operation: "Ledger.Entry.update",
  kind: "update",
  artifactVersion: 1,
  inputs: [
    { name: "record", kind: "ref", required: true, model: "Ledger.Entry", versioned: true },
    { name: "fee", kind: "money", required: false },
    {
      name: "doc",
      kind: "file",
      required: false,
      file: { valueShape: "opaque-file-id", format: "can-file" },
    },
  ],
};

/* Mapping-rule probes: datetime + nullable kinds no T19b op carries. */
const WHEN_CREATE: DerivedOperationInputs = {
  operation: "Ledger.Event.create",
  kind: "create",
  artifactVersion: 1,
  inputs: [
    { name: "title", kind: "string", required: true },
    { name: "when", kind: "datetime", required: false },
    { name: "nick", kind: "string", required: false, nullable: true },
    { name: "flag", kind: "boolean", required: false, nullable: true },
  ],
};

const WHEN_UPDATE: DerivedOperationInputs = {
  operation: "Ledger.Event.update",
  kind: "update",
  artifactVersion: 1,
  inputs: [
    { name: "record", kind: "ref", required: true, model: "Ledger.Event", versioned: true },
    { name: "when", kind: "datetime", required: false },
    { name: "nick", kind: "string", required: false, nullable: true },
  ],
};

/* Money literal default: the {minor, currency} wire literal splits across companions. */
const FEE_DEFAULT: DerivedOperationInputs = {
  operation: "Ledger.Entry.create",
  kind: "create",
  artifactVersion: 1,
  inputs: [
    {
      name: "fee",
      kind: "money",
      required: false,
      default: { kind: "literal", value: { minor: "150", currency: "EUR" } },
    },
  ],
};

function fieldByPath(fields: readonly FormFieldDef[], path: string): FormFieldDef {
  const found = fields.find((field) => field.path === path);
  assert.ok(found !== undefined, `generated field ${path}`);
  return found;
}

describe("T20b generated depth fields", () => {
  it("renders delivery inputs as notice fields with no companions", () => {
    const fields = generatedFields(RETRY, "scenario");
    assert.deepEqual(
      fields.map((field) => field.path),
      ["note", "attempt"],
    );
    const notice = fieldByPath(fields, "attempt");
    assert.equal(notice.type, "delivery");
    assert.equal(notice.required, false);
    // The binding travels as the field value; nullable delivery still
    // gains no null companion (nothing is submittable, not even null).
    assert.deepEqual(notice.value, {
      capability: "std.EmailV1",
      operation: "send",
      version: 1,
      result: { name: "EmailAccepted", leaves: [{ name: "reference", type: "text" }] },
      recipe: "delivery:std.EmailV1.send",
    });
  });

  it("pairs money with a currency companion and splits literal prefills", () => {
    const fields = generatedFields(LEDGER_CREATE, "create");
    assert.deepEqual(
      fields.map((field) => field.path),
      ["title", "stock", "price", "fee", "fee__currency", "doc"],
    );
    const minor = fieldByPath(fields, "fee");
    assert.equal(minor.type, "money");
    const currency = fieldByPath(fields, "fee__currency");
    assert.equal(currency.type, "text");
    assert.equal(currency.required, false);
    const prefilled = generatedFields(FEE_DEFAULT, "create");
    assert.equal(fieldByPath(prefilled, "fee").value, "150");
    assert.equal(fieldByPath(prefilled, "fee__currency").value, "EUR");
  });

  it("pairs datetime with a choice-free fold select", () => {
    const fields = generatedFields(WHEN_CREATE, "create");
    assert.deepEqual(
      fields.map((field) => field.path),
      ["title", "when", "when__fold", "nick", "nick__null", "flag", "flag__null"],
    );
    const fold = fieldByPath(fields, "when__fold");
    assert.equal(fold.type, "enum");
    assert.equal(fold.required, false);
    assert.deepEqual(fold.options, [
      { value: "", label: "—" },
      { value: "earlier", label: "earlier" },
      { value: "later", label: "later" },
    ]);
    assert.equal(GENERATED_DATETIME_FOLD_SUFFIX, "__fold");
    assert.equal(GENERATED_MONEY_CURRENCY_SUFFIX, "__currency");
    assert.equal(GENERATED_NULL_SUFFIX, "__null");
  });

  it("pairs nullable inputs with a null checkbox, delivery excluded", () => {
    const fields = generatedFields(WHEN_CREATE, "create");
    const checkbox = fieldByPath(fields, "nick__null");
    assert.equal(checkbox.type, "bool");
    assert.equal(checkbox.required, false);
    assert.equal(fieldByPath(fields, "flag__null").type, "bool");
    // Non-nullable inputs gain nothing; delivery gains nothing either.
    assert.ok(!fields.some((field) => field.path === "title__null"));
    assert.ok(!fields.some((field) => field.path === "when__null"));
    const retry = generatedFields(RETRY, "scenario");
    assert.ok(!retry.some((field) => field.path === "attempt__null"));
  });

  it("rejects malformed depth derivations precisely", () => {
    const noBinding = {
      ...RETRY,
      inputs: [{ name: "attempt", kind: "delivery", required: false }],
    } as unknown as DerivedOperationInputs;
    assert.throws(
      () => generatedFields(noBinding, "scenario"),
      /delivery input "attempt" needs its engine-resolved delivery binding/,
    );
    const badLeaves = {
      ...RETRY,
      inputs: [
        {
          name: "attempt",
          kind: "delivery",
          required: false,
          delivery: {
            capability: "std.EmailV1",
            operation: "send",
            version: 1,
            result: { name: "EmailAccepted", leaves: [{ name: "reference" }] },
            recipe: "delivery:std.EmailV1.send",
          },
        },
      ],
    } as unknown as DerivedOperationInputs;
    assert.throws(() => generatedFields(badLeaves, "scenario"), /leaves shaped \{name, type\}/);
    // A prefill for a companion that does not exist is never dropped.
    assert.throws(
      () => generatedFields(RETRY, "scenario", { values: { attempt__null: true } }),
      /unknown prefill path "attempt__null"/,
    );
  });

  it("applies label and value overrides to depth companions", () => {
    const fields = generatedFields(WHEN_CREATE, "create", {
      labels: { when__fold: "Earlier or later", nick__null: "Clear nickname" },
      values: { when__fold: "earlier", nick__null: true },
    });
    assert.equal(fieldByPath(fields, "when__fold").label, "Earlier or later");
    assert.equal(fieldByPath(fields, "when__fold").value, "earlier");
    assert.equal(fieldByPath(fields, "nick__null").label, "Clear nickname");
    assert.equal(fieldByPath(fields, "nick__null").value, true);
  });
});

describe("T20b depth rendering", () => {
  it("renders the delivery notice with no named inputs", async () => {
    const html = await generatedForm({
      context: makeContext(),
      action: "/api/operations/Receipts.retry",
      derived: RETRY,
      mode: "scenario",
      operationId: "op-retry",
      timeZone: "UTC",
      submit: "Retry",
      idPrefix: "retry",
    });
    assert.ok(html.includes('<section class="can-delivery" data-delivery="attempt"'));
    assert.ok(html.includes("<code>std.EmailV1.send</code>"));
    assert.ok(html.includes("<span>v1</span>"));
    assert.ok(html.includes("EmailAccepted"));
    assert.ok(html.includes("<td>reference</td>"));
    assert.ok(html.includes("<code>text</code>"));
    // The notice carries no submittable member: no inputs[attempt] name anywhere.
    assert.ok(!html.includes("inputs[attempt"));
    assert.ok(html.includes('name="inputs[note]"'));
  });

  it("keeps the delivery notice on error re-renders", async () => {
    const html = await generatedForm({
      context: makeContext(),
      action: "/api/operations/Receipts.retry",
      derived: RETRY,
      mode: "scenario",
      operationId: "op-retry-2",
      timeZone: "UTC",
      errors: [{ path: "/note", code: "validation", message: "Note is required." }],
      outcome: {
        status: "failed",
        error: { code: "validation", message: "Note is required." },
      },
      submit: "Retry",
      idPrefix: "retry",
    });
    assert.ok(html.includes('data-delivery="attempt"'));
    assert.ok(html.includes("Note is required."));
  });

  it("fails closed on a tampered delivery value with the field convention", async () => {
    await assert.rejects(
      generatedForm({
        context: makeContext(),
        action: "/api/operations/Receipts.retry",
        derived: RETRY,
        mode: "scenario",
        operationId: "op-retry-3",
        timeZone: "UTC",
        submit: "Retry",
        idPrefix: "retry",
        values: { attempt: "tampered" },
      }),
      /field "attempt": delivery notice needs its engine-resolved binding value/,
    );
  });

  it("renders the file slot as an unnamed picker plus its hidden id", async () => {
    const html = await generatedForm({
      context: makeContext(),
      action: "/api/operations/Ledger.Entry.create",
      derived: LEDGER_CREATE,
      mode: "create",
      operationId: "op-ledger",
      timeZone: "UTC",
      submit: "Create",
      idPrefix: "ledger",
    });
    assert.ok(html.includes('<input type="file" data-can-file="doc"'));
    assert.ok(html.includes('name="inputs[doc]" value=""'));
    // The picker tag itself carries no name: raw picker text can never submit.
    const picker = /<input type="file"[^>]*>/.exec(html)?.[0] ?? "";
    assert.ok(!picker.includes("name="), `picker tag: ${picker}`);
  });

  it("re-renders an attached file id as its line plus hidden", async () => {
    const html = await generatedForm({
      context: makeContext(),
      action: "/api/operations/Ledger.Entry.update",
      derived: LEDGER_UPDATE,
      mode: "update",
      operationId: "op-ledger-2",
      record: { id: "e1", version: "4" },
      timeZone: "UTC",
      submit: "Save",
      idPrefix: "ledger",
      values: { doc: "file-opaque-9" },
    });
    assert.ok(html.includes("Attached file"));
    assert.ok(html.includes("<code>file-opaque-9</code>"));
    assert.ok(html.includes('name="inputs[changes][doc]" value="file-opaque-9"'));
  });

  it("rejects malformed file drafts with canonical violations and field context", async () => {
    await assert.rejects(
      form({
        context: makeContext(),
        action: "/submit",
        operation: "Ledger.Entry.create",
        operationId: "op-1",
        mode: "create",
        timeZone: "UTC",
        fields: [{ path: "doc", label: "doc", type: "file", required: true, value: 5 }],
        submit: "Save",
        idPrefix: "f1",
      }),
      (error: unknown) => {
        assert.ok(error instanceof SchemaError);
        assert.equal(error.kind, "schema");
        assert.equal(error.message, 'field "doc": schema validation failed with 1 violation(s)');
        assert.deepEqual(error.violations, [{
          path: [], code: "type", message: "file has the wrong wire type", expected: "{id}", actual: "number 5",
        }]);
        const cause = error.cause;
        assert.ok(cause instanceof SchemaError);
        assert.equal(cause.kind, "schema");
        assert.equal(cause.message, "schema validation failed with 1 violation(s)");
        assert.deepEqual(error.violations, cause.violations);
        assert.equal(error.violations[0], cause.violations[0]);
        assert.deepEqual(Object.getOwnPropertyDescriptor(error, "cause"), {
          value: cause, writable: true, enumerable: false, configurable: true,
        });
        return true;
      },
    );
  });
});

describe("T20b wall-to-instant resolution", () => {
  it("resolves unambiguous walls to millis-pinned instants", () => {
    assert.equal(wallToInstant("2026-01-15T10:30", "UTC", undefined), "2026-01-15T10:30:00.000Z");
    assert.equal(
      wallToInstant("2026-01-15T10:30", "America/New_York", undefined),
      "2026-01-15T15:30:00.000Z",
    );
    // Non-hour offsets resolve exactly (Kathmandu +5:45).
    assert.equal(
      wallToInstant("2026-01-15T10:30", "Asia/Kathmandu", undefined),
      "2026-01-15T04:45:00.000Z",
    );
    // Unambiguous values ignore the fold entirely.
    assert.equal(
      wallToInstant("2026-01-15T10:30", "America/New_York", "later"),
      "2026-01-15T15:30:00.000Z",
    );
  });

  it("fails closed on spring-forward gaps", () => {
    // 2026-03-08 02:30 never exists in America/New_York.
    assert.throws(
      () => wallToInstant("2026-03-08T02:30", "America/New_York", undefined),
      /nonexistent local time "2026-03-08T02:30" in "America\/New_York"/,
    );
    assert.throws(
      () => wallToInstant("2026-03-08T02:30", "America/New_York", "earlier"),
      /nonexistent local time/,
    );
  });

  it("requires an explicit fold on fall-back overlaps", () => {
    // 2026-11-01 01:30 occurs twice in America/New_York (EDT then EST).
    assert.throws(
      () => wallToInstant("2026-11-01T01:30", "America/New_York", undefined),
      /ambiguous local time "2026-11-01T01:30" in "America\/New_York": choose "earlier" or "later"/,
    );
    assert.throws(
      () => wallToInstant("2026-11-01T01:30", "America/New_York", ""),
      /choose "earlier" or "later"/,
    );
    assert.equal(
      wallToInstant("2026-11-01T01:30", "America/New_York", "earlier"),
      "2026-11-01T05:30:00.000Z",
    );
    assert.equal(
      wallToInstant("2026-11-01T01:30", "America/New_York", "later"),
      "2026-11-01T06:30:00.000Z",
    );
  });

  it("rejects malformed walls, zones, and folds precisely", () => {
    assert.throws(() => wallToInstant("2026-01-15 10:30", "UTC", undefined), /invalid wall datetime/);
    assert.throws(
      () => wallToInstant("2026-01-15T10:30:00", "UTC", undefined),
      /expected "YYYY-MM-DDTHH:mm"/,
    );
    assert.throws(() => wallToInstant("2026-02-30T10:30", "UTC", undefined), /no such civil date/);
    assert.throws(() => wallToInstant("2026-01-15T25:30", "UTC", undefined), /no such civil date/);
    assert.throws(() => wallToInstant("2026-01-15T10:30", "", undefined), /invalid time zone/);
    assert.throws(
      () => wallToInstant("2026-01-15T10:30", "Mars/Olympus", undefined),
      /invalid time zone "Mars\/Olympus"/,
    );
    assert.throws(
      () => wallToInstant("2026-01-15T10:30", "UTC", "sometimes"),
      /invalid fold "sometimes"/,
    );
  });
});

describe("T20b depth projection", () => {
  it("preserves declared prototype-named inputs as own envelope data", () => {
    const derived: DerivedOperationInputs = {
      operation: "Shop.Entry.submit", kind: "scenario", artifactVersion: 1,
      inputs: [
        { name: "__proto__", kind: "boolean", required: true },
        { name: "constructor", kind: "ref", model: "Shop.Entry", versioned: true, required: true },
      ],
    };
    const projected = projectGeneratedInputs(derived, "scenario", {
      "inputs[__proto__]": "true", "inputs[constructor]": "entry-1",
      "inputs[constructor__version]": "9007199254740993",
    }, ["__proto__", "constructor"]);
    assert.equal(Object.getPrototypeOf(projected), Object.prototype);
    assert.deepEqual(Object.keys(projected), ["__proto__", "constructor"]);
    assert.deepEqual(Object.getOwnPropertyDescriptor(projected, "__proto__"), {
      value: true, enumerable: true, writable: true, configurable: true,
    });
    assert.deepEqual(Object.getOwnPropertyDescriptor(projected, "constructor"), {
      value: { id: "entry-1", version: "9007199254740993" },
      enumerable: true, writable: true, configurable: true,
    });
    const envelope = JSON.parse(JSON.stringify({ operation: derived.operation, inputs: projected }));
    assert.equal(Object.hasOwn(envelope.inputs, "__proto__"), true);
    assert.equal(envelope.inputs["__proto__"], true);
    assert.deepEqual(envelope.inputs.constructor, { id: "entry-1", version: "9007199254740993" });
    assert.equal(Object.getPrototypeOf(envelope.inputs), Object.prototype);
    const cases: Array<{ input: DerivedOperationInputs["inputs"][number]; form: Record<string, string>; expected: unknown }> = [
      { input: { name: "__proto__", kind: "ref", model: "Shop.Entry", versioned: true, required: true },
        form: { "inputs[__proto__]": "entry-2", "inputs[__proto____version]": "7" }, expected: { id: "entry-2", version: "7" } },
      { input: { name: "__proto__", kind: "string", required: true },
        form: { "inputs[__proto__]": "text" }, expected: "text" },
      { input: { name: "__proto__", kind: "boolean", required: false, nullable: true },
        form: { "inputs[__proto____null]": "true" }, expected: null },
      { input: { name: "__proto__", kind: "string", required: true, array: { required: true } },
        form: { "inputs[__proto__]": '["first","second"]' }, expected: ["first", "second"] },
    ];
    for (const { input, form: submitted, expected } of cases) {
      const result = projectGeneratedInputs({ ...derived, inputs: [input] }, "scenario", submitted, ["__proto__"]);
      assert.equal(Object.getPrototypeOf(result), Object.prototype);
      assert.equal(Object.hasOwn(result, "__proto__"), true);
      assert.deepEqual(result["__proto__"], expected);
      assert.deepEqual(Object.keys(result), ["__proto__"]);
    }
  });

  it("never emits delivery members, even under tampering", () => {
    assert.deepEqual(
      projectGeneratedInputs(RETRY, "scenario", {
        "inputs[note]": "again",
        "inputs[attempt]": "tampered-receipt",
        "inputs[attempt__null]": "true",
      }),
      { note: "again" },
    );
  });

  it("composes money to exact-keys {minor, currency}", () => {
    assert.deepEqual(
      projectGeneratedInputs(LEDGER_CREATE, "create", {
        "inputs[title]": "t",
        "inputs[fee]": "150",
        "inputs[fee__currency]": "EUR",
      }),
      { title: "t", fee: { minor: "150", currency: "EUR" } },
    );
    // Absent minors and currencies omit together for the engine to judge.
    assert.deepEqual(projectGeneratedInputs(LEDGER_CREATE, "create", { "inputs[title]": "t" }), {
      title: "t",
    });
    // A half-cleared pair travels as-is; the bound checker judges it.
    assert.deepEqual(
      projectGeneratedInputs(LEDGER_CREATE, "create", {
        "inputs[title]": "t",
        "inputs[fee]": "150",
      }),
      { title: "t", fee: { minor: "150", currency: "" } },
    );
    // A tampered currency on a non-money input never enters the envelope.
    assert.deepEqual(
      projectGeneratedInputs(LEDGER_CREATE, "create", {
        "inputs[title]": "t",
        "inputs[title__currency]": "EUR",
      }),
      { title: "t" },
    );
  });

  it("resolves datetimes through the form zone with fold rules", () => {
    assert.deepEqual(
      projectGeneratedInputs(WHEN_CREATE, "create", {
        timezone: "America/New_York",
        "inputs[title]": "t",
        "inputs[when]": "2026-01-15T10:30",
      }),
      { title: "t", when: "2026-01-15T15:30:00.000Z", flag: false },
    );
    assert.deepEqual(
      projectGeneratedInputs(WHEN_CREATE, "create", {
        timezone: "America/New_York",
        "inputs[title]": "t",
        "inputs[when]": "2026-11-01T01:30",
        "inputs[when__fold]": "later",
      }),
      { title: "t", when: "2026-11-01T06:30:00.000Z", flag: false },
    );
    assert.throws(
      () =>
        projectGeneratedInputs(WHEN_CREATE, "create", {
          timezone: "America/New_York",
          "inputs[when]": "2026-11-01T01:30",
        }),
      /datetime input "when": ambiguous local time/,
    );
    assert.throws(
      () =>
        projectGeneratedInputs(WHEN_CREATE, "create", {
          timezone: "America/New_York",
          "inputs[when]": "2026-03-08T02:30",
        }),
      /datetime input "when": nonexistent local time/,
    );
    // Absent datetimes omit; cleared datetimes travel for the engine to judge.
    // (Absent bools always emit unchecked-false per the committed rule.)
    assert.deepEqual(
      projectGeneratedInputs(WHEN_CREATE, "create", { timezone: "UTC", "inputs[title]": "t" }),
      { title: "t", flag: false },
    );
    assert.deepEqual(
      projectGeneratedInputs(WHEN_CREATE, "create", {
        timezone: "UTC",
        "inputs[title]": "t",
        "inputs[when]": "",
      }),
      { title: "t", when: "", flag: false },
    );
    // A valued datetime without a zone fails loudly instead of guessing UTC.
    assert.throws(
      () => projectGeneratedInputs(WHEN_CREATE, "create", { "inputs[when]": "2026-01-15T10:30" }),
      /datetime input "when" needs the form timezone/,
    );
    // Update mode roots the wall and fold under changes.
    assert.deepEqual(
      projectGeneratedInputs(WHEN_UPDATE, "update", {
        timezone: "UTC",
        "inputs[record][id]": "e1",
        "inputs[record][version]": "4",
        "inputs[changes][when]": "2026-01-15T10:30",
      }),
      { record: { id: "e1", version: "4" }, when: "2026-01-15T10:30:00.000Z" },
    );
  });

  it("projects explicit nulls on nullable inputs only", () => {
    assert.deepEqual(
      projectGeneratedInputs(WHEN_CREATE, "create", {
        "inputs[title]": "t",
        "inputs[nick]": "ignored-value",
        "inputs[nick__null]": "true",
      }),
      { title: "t", nick: null, flag: false },
    );
    // The mark on a non-nullable input is ignored, never a null member.
    assert.deepEqual(
      projectGeneratedInputs(WHEN_CREATE, "create", {
        "inputs[title]": "t",
        "inputs[title__null]": "true",
      }),
      { title: "t", flag: false },
    );
    // Null wins over the value widget for every nullable kind.
    assert.deepEqual(
      projectGeneratedInputs(WHEN_CREATE, "create", {
        "inputs[flag]": "true",
        "inputs[flag__null]": "true",
      }),
      { flag: null },
    );
    assert.deepEqual(
      projectGeneratedInputs(LEDGER_CREATE, "create", {
        "inputs[title]": "t",
        "inputs[fee]": "150",
        "inputs[fee__currency]": "EUR",
      }),
      { title: "t", fee: { minor: "150", currency: "EUR" } },
    );
    // Unchecked null companions change nothing.
    assert.deepEqual(
      projectGeneratedInputs(WHEN_CREATE, "create", {
        "inputs[title]": "t",
        "inputs[nick]": "x",
        "inputs[nick__null]": "false",
      }),
      { title: "t", nick: "x", flag: false },
    );
  });

  it("projects canonical file wire ids and omits absent slots", () => {
    assert.deepEqual(
      projectGeneratedInputs(LEDGER_CREATE, "create", {
        "inputs[title]": "t",
        "inputs[doc]": "file-opaque-1",
      }),
      { title: "t", doc: { id: "file-opaque-1" } },
    );
    assert.deepEqual(projectGeneratedInputs(LEDGER_UPDATE, "update", {}), {});
    // A cleared required slot travels for the bound checker to judge.
    assert.deepEqual(
      projectGeneratedInputs(LEDGER_CREATE, "create", { "inputs[title]": "t", "inputs[doc]": "" }),
      { title: "t", doc: { id: "" } },
    );
  });
});

describe("T20b draft flattening", () => {
  it("carries refs as id plus version companion", () => {
    const derived: DerivedOperationInputs = {
      operation: "Shop.Gadget.create",
      kind: "create",
      artifactVersion: 1,
      inputs: [
        { name: "owner", kind: "ref", required: false, model: "Shop.Team", versioned: true },
        { name: "parent", kind: "ref", required: true, model: "Shop.Team", versioned: false },
      ],
    };
    assert.deepEqual(
      generatedDraftValues(derived, "create", {
        owner: { id: "o9", version: "2" },
        parent: { id: "t1" },
      }),
      { owner: "o9", owner__version: "2", parent: "t1" },
    );
    // Malformed ref members omit rather than guess.
    assert.deepEqual(generatedDraftValues(derived, "create", { owner: "o9" }), {});
    assert.deepEqual(
      generatedDraftValues(derived, "create", { owner: { id: "o9", version: 2 } }),
      { owner: "o9" },
    );
  });

  it("carries money as minor plus currency companion", () => {
    assert.deepEqual(
      generatedDraftValues(LEDGER_CREATE, "create", {
        title: "t",
        fee: { minor: "150", currency: "EUR" },
      }),
      { title: "t", fee: "150", fee__currency: "EUR" },
    );
    assert.deepEqual(
      generatedDraftValues(LEDGER_CREATE, "create", { fee: { minor: "150" } }),
      { fee: "150" },
    );
    assert.deepEqual(generatedDraftValues(LEDGER_CREATE, "create", { fee: "150" }), {});
  });

  it("re-encodes arrays and marks explicit nulls", () => {
    const derived: DerivedOperationInputs = {
      operation: "Shop.review",
      kind: "scenario",
      artifactVersion: 1,
      inputs: [
        { name: "notes", kind: "string", required: false, array: { required: false } },
        { name: "nick", kind: "string", required: false, nullable: true },
        { name: "title", kind: "string", required: true },
      ],
    };
    assert.deepEqual(
      generatedDraftValues(derived, "scenario", { notes: ["a", "b"], nick: null }),
      { notes: '["a","b"]', nick__null: true },
    );
    // Null on a non-nullable member flattens to nothing (the error explains).
    assert.deepEqual(generatedDraftValues(derived, "scenario", { title: null }), {});
    // Non-array members on array inputs pass through for resilient dropping.
    assert.deepEqual(generatedDraftValues(derived, "scenario", { notes: "nope" }), {
      notes: "nope",
    });
  });

  it("reads updates from changes and ignores record, delivery, and unknowns", () => {
    assert.deepEqual(
      generatedDraftValues(WHEN_UPDATE, "update", {
        record: { id: "e1", version: "4" },
        changes: { when: "2026-01-15T10:30:00.000Z", nick: null },
        unknown: 1,
      }),
      { when: "2026-01-15T10:30:00.000Z", nick__null: true },
    );
    assert.deepEqual(
      generatedDraftValues(RETRY, "scenario", {
        note: "again",
        attempt: { id: "d-1" },
      }),
      { note: "again" },
    );
    assert.throws(
      () => generatedDraftValues(RETRY, "create", { note: "x" }),
      /does not agree/,
    );
  });
});

describe("T20b conflict table", () => {
  it("formats rich current values and never overwrites drafts", async () => {
    const html = await generatedForm({
      context: makeContext({ currencyScales: { EUR: 2 } }),
      action: "/api/operations/Ledger.Entry.update",
      derived: LEDGER_UPDATE,
      mode: "update",
      operationId: "op-conflict",
      record: { id: "e1", version: "4" },
      timeZone: "UTC",
      submit: "Save",
      idPrefix: "ledger",
      values: { fee: "200", fee__currency: "EUR" },
      outcome: {
        status: "conflict",
        current: {
          fee: { minor: "150", currency: "EUR" },
          doc: "file-opaque-9",
        },
        message: "Someone else saved this entry.",
      },
    });
    // Drafts stay in the inputs; currents render in the table.
    assert.ok(html.includes('name="inputs[changes][fee]"'));
    assert.ok(html.includes('value="200"'));
    assert.ok(html.includes("Someone else saved this entry."));
    assert.ok(html.includes("file-opaque-9"));
    assert.ok(html.includes("€1.50") || html.includes("1.50"));
  });

  it("renders ref currents as identity plus version", async () => {
    const html = await form({
      context: makeContext(),
      action: "/submit",
      operation: "Shop.Gadget.update",
      operationId: "op-1",
      mode: "update",
      record: { id: "g1", version: "3" },
      timeZone: "UTC",
      fields: [{ path: "owner", label: "owner", type: "text", required: false }],
      outcome: {
        status: "conflict",
        current: { owner: { id: "o9", version: "2" } },
        message: "Stale owner.",
      },
      submit: "Save",
      idPrefix: "f1",
    });
    assert.ok(html.includes("o9 (v2)"));
  });

  it("falls back to raw text for money without scales", async () => {
    const html = await form({
      context: makeContext(),
      action: "/submit",
      operation: "Ledger.Entry.update",
      operationId: "op-1",
      mode: "update",
      record: { id: "e1", version: "4" },
      timeZone: "UTC",
      fields: [{ path: "fee", label: "fee", type: "money", required: false }],
      outcome: {
        status: "conflict",
        current: { fee: { minor: "150", currency: "EUR" } },
        message: "Stale fee.",
      },
      submit: "Save",
      idPrefix: "f1",
    });
    // No currency scales in context: the raw wire value shows, escaped.
    assert.ok(html.includes("{&quot;minor&quot;:&quot;150&quot;"));
  });
});
