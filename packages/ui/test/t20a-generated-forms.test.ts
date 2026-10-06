import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CSRF_FIELD,
  GENERATED_FORM_TYPE_FOR_KIND,
  GENERATED_REF_VERSION_SUFFIX,
} from "../../contracts/src/presentation.js";
import type {
  FormFieldDef,
  MessageValue,
  NavigationResult,
  PageDescriptor,
  PresentationContext,
  ShellData,
} from "../../contracts/src/presentation.js";
import type { DerivedOperationInputs } from "../../contracts/src/wire.js";
import { UI_CATALOG } from "../src/catalog.js";
import {
  formFragmentWrap,
  generatedFields,
  generatedForm,
  projectGeneratedInputs,
} from "../src/forms.js";
import { message } from "../src/messages.js";
import { renderPage } from "../src/shell.js";
import { renderSettingsPanel } from "../src/settings.js";

// T20a generated-form tests: the ui slice of the pilot presentation join.
//
// Grounding (no invented operations): the fixtures below mirror
// deriveOperationInputs() over the T19a verbatim emission — the six
// Shop ops plus the three Store ops pinned in
// packages/interfaces/test/t19a-derivation.test.ts (names, kinds,
// required sets, versioned flags, nullable/array markers, and verbatim
// literal/parent defaults). The interfaces T20a suite re-proves every
// mapping here over the REAL derivation; these fixtures exist only
// because the ui package cannot import the interfaces derivation.

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

function makeDescriptor(title: MessageValue = "Gadgets"): PageDescriptor {
  return {
    owner: "Shop",
    path: "/gadgets",
    title,
    admit: async () => ({}),
    render: async () => "",
  };
}

function makeNavigation(overrides: Partial<NavigationResult> = {}): NavigationResult {
  return {
    groups: [
      {
        owner: "Shop",
        caption: message("Shop", { nl: "Winkel" }),
        entries: [
          { owner: "Shop", path: "/gadgets", title: message("Gadgets", { nl: "Gadgets" }), active: true },
        ],
      },
    ],
    incomplete: false,
    ...overrides,
  };
}

function makeShell(overrides: Partial<ShellData> = {}): ShellData {
  return {
    navigation: makeNavigation(),
    brand: message("Shop", { nl: "Winkel" }),
    routes: { signIn: "/sign-in", signOut: "/sign-out", switchTeam: "/team" },
    account: {
      authenticated: true,
      userLabel: "Ada",
      teams: [{ id: "t1", label: "Red" }],
      currentTeamId: "t1",
    },
    settings: {
      sections: [{ id: "base", caption: message("Settings", { nl: "Instellingen" }), active: true }],
    },
    ...overrides,
  };
}

/* Mirrored derivation: Shop.review (scenario). */
const REVIEW: DerivedOperationInputs = {
  operation: "Shop.review",
  kind: "scenario",
  artifactVersion: 1,
  inputs: [
    { name: "notes", kind: "string", required: false, array: { required: false } },
    {
      name: "limit",
      kind: "integer",
      required: false,
      default: { kind: "literal", value: "10" },
    },
    { name: "nick", kind: "string", required: false, nullable: true },
  ],
};

/* Mirrored derivation: Shop.Gadget.create. */
const GADGET_CREATE: DerivedOperationInputs = {
  operation: "Shop.Gadget.create",
  kind: "create",
  artifactVersion: 1,
  inputs: [
    { name: "title", kind: "string", required: true },
    {
      name: "stock",
      kind: "integer",
      required: false,
      default: { kind: "literal", value: "0" },
    },
    { name: "price", kind: "decimal", required: true },
    {
      name: "state",
      kind: "enum",
      required: false,
      default: { kind: "literal", value: "draft" },
      enumValues: ["draft", "submitted"],
    },
    {
      name: "owner",
      kind: "ref",
      required: false,
      nullable: true,
      model: "Shop.Gadget",
      versioned: true,
    },
    { name: "tags", kind: "string", required: false, array: { required: false } },
    { name: "ids", kind: "string", required: true, array: { required: true } },
    { name: "code", kind: "string", required: true },
  ],
};

/* Mirrored derivation: Shop.Gadget.update (partial, default-less). */
const GADGET_UPDATE: DerivedOperationInputs = {
  operation: "Shop.Gadget.update",
  kind: "update",
  artifactVersion: 1,
  inputs: [
    { name: "record", kind: "ref", required: true, model: "Shop.Gadget", versioned: true },
    { name: "title", kind: "string", required: false },
    { name: "stock", kind: "integer", required: false },
    { name: "price", kind: "decimal", required: false },
    { name: "state", kind: "enum", required: false, enumValues: ["draft", "submitted"] },
    {
      name: "owner",
      kind: "ref",
      required: false,
      nullable: true,
      model: "Shop.Gadget",
      versioned: true,
    },
    { name: "tags", kind: "string", required: false, array: { required: false } },
    { name: "ids", kind: "string", required: false, array: { required: true } },
    { name: "code", kind: "string", required: false },
  ],
};

/* Mirrored derivation: Shop.Member.create (parent default + linkage). */
const MEMBER_CREATE: DerivedOperationInputs = {
  operation: "Shop.Member.create",
  kind: "create",
  artifactVersion: 1,
  inputs: [
    { name: "name", kind: "string", required: true },
    {
      name: "buddy",
      kind: "string",
      required: false,
      default: { kind: "parent", path: "owner" },
    },
    { name: "parent", kind: "ref", required: true, model: "Shop.Team", versioned: false },
  ],
};

/* Mirrored derivation: Shop.Member.update. */
const MEMBER_UPDATE: DerivedOperationInputs = {
  operation: "Shop.Member.update",
  kind: "update",
  artifactVersion: 1,
  inputs: [
    { name: "record", kind: "ref", required: true, model: "Shop.Member", versioned: true },
    { name: "name", kind: "string", required: false },
    { name: "buddy", kind: "string", required: false },
  ],
};

/* Mirrored derivation: Shop.Gadget.read (empty inputs; reads are not forms). */
const GADGET_READ: DerivedOperationInputs = {
  operation: "Shop.Gadget.read",
  kind: "read",
  artifactVersion: 1,
  inputs: [],
};

/* Mirrored derivation: Store.Gadget.create. */
const STORE_CREATE: DerivedOperationInputs = {
  operation: "Store.Gadget.create",
  kind: "create",
  artifactVersion: 1,
  inputs: [{ name: "title", kind: "string", required: true }],
};

/* Mirrored derivation: Store.Gadget.update. */
const STORE_UPDATE: DerivedOperationInputs = {
  operation: "Store.Gadget.update",
  kind: "update",
  artifactVersion: 1,
  inputs: [
    { name: "record", kind: "ref", required: true, model: "Store.Gadget", versioned: true },
    { name: "title", kind: "string", required: false },
  ],
};

/* Mirrored derivation: Store.Gadget.read (empty inputs; reads are not forms). */
const STORE_READ: DerivedOperationInputs = {
  operation: "Store.Gadget.read",
  kind: "read",
  artifactVersion: 1,
  inputs: [],
};

function fieldByPath(fields: readonly FormFieldDef[], path: string): FormFieldDef {
  const found = fields.find((field) => field.path === path);
  assert.ok(found !== undefined, `generated field ${path}`);
  return found;
}

describe("generated fields", () => {
  it("renders one field per derived input in emission order", () => {
    // T20b SUPERSEDE: nullable inputs gain their explicit-null companion
    // (the old pins below contradict the specified T20b rule, so they are
    // re-pinned here; see t20b-generated-depth.test.ts for the rule).
    assert.deepEqual(
      generatedFields(REVIEW, "scenario").map((field) => field.path),
      ["notes", "limit", "nick", "nick__null"],
    );
    assert.deepEqual(
      generatedFields(GADGET_CREATE, "create").map((field) => field.path),
      ["title", "stock", "price", "state", "owner", "owner__version", "owner__null", "tags", "ids", "code"],
    );
    // The update `record` binds as hidden id/version instead of a field.
    assert.deepEqual(
      generatedFields(GADGET_UPDATE, "update").map((field) => field.path),
      ["title", "stock", "price", "state", "owner", "owner__version", "owner__null", "tags", "ids", "code"],
    );
    assert.deepEqual(
      generatedFields(MEMBER_CREATE, "create").map((field) => field.path),
      ["name", "buddy", "parent"],
    );
    assert.deepEqual(
      generatedFields(MEMBER_UPDATE, "update").map((field) => field.path),
      ["name", "buddy"],
    );
    assert.deepEqual(
      generatedFields(STORE_CREATE, "create").map((field) => field.path),
      ["title"],
    );
    assert.deepEqual(
      generatedFields(STORE_UPDATE, "update").map((field) => field.path),
      ["title"],
    );
  });

  it("selects widgets from the pinned kind table", () => {
    const fields = generatedFields(GADGET_CREATE, "create");
    assert.equal(fieldByPath(fields, "title").type, "text");
    assert.equal(fieldByPath(fields, "stock").type, "int");
    assert.equal(fieldByPath(fields, "price").type, "decimal");
    assert.equal(fieldByPath(fields, "state").type, "enum");
    assert.equal(fieldByPath(fields, "owner").type, "text");
    assert.equal(fieldByPath(fields, "owner__version").type, "text");
    assert.equal(fieldByPath(fields, "tags").type, "text");
    assert.equal(fieldByPath(fields, "title").required, true);
    assert.equal(fieldByPath(fields, "stock").required, false);
    assert.equal(fieldByPath(fields, "ids").required, true);
    // The companion inherits the ref's requiredness (aria-level only).
    assert.equal(fieldByPath(fields, "owner__version").required, false);
    // Enum options pin the derived values verbatim (label === value).
    assert.deepEqual(fieldByPath(fields, "state").options, [
      { value: "draft", label: "draft" },
      { value: "submitted", label: "submitted" },
    ]);
    // Labels default to the field path verbatim.
    assert.equal(fieldByPath(fields, "title").label, "title");
    assert.equal(fieldByPath(fields, "owner__version").label, "owner__version");
  });

  it("prefills literal defaults verbatim and defers parent defaults", () => {
    const create = generatedFields(GADGET_CREATE, "create");
    assert.equal(fieldByPath(create, "stock").value, "0");
    assert.equal(fieldByPath(create, "state").value, "draft");
    const review = generatedFields(REVIEW, "scenario");
    assert.equal(fieldByPath(review, "limit").value, "10");
    // No default, no prefill — and `parent` defaults prefill nothing:
    // omission defers to the engine.
    assert.ok(!("value" in fieldByPath(create, "title")));
    assert.ok(!("value" in fieldByPath(review, "nick")));
    const member = generatedFields(MEMBER_CREATE, "create");
    assert.ok(!("value" in fieldByPath(member, "buddy")));
  });

  it("marks the required version companion on a tampered required versioned ref", () => {
    // Verbatim-plus-tamper probe (T19a withExtraInput precedent): no pilot
    // op carries a required versioned non-record ref, so the flip proves
    // the companion-required rule, not an operation.
    const flipped: DerivedOperationInputs = {
      ...MEMBER_CREATE,
      inputs: MEMBER_CREATE.inputs.map((input) =>
        input.name === "parent" ? { ...input, versioned: true } : input,
      ),
    };
    const fields = generatedFields(flipped, "create");
    assert.deepEqual(
      fields.map((field) => field.path),
      ["name", "buddy", "parent", "parent__version"],
    );
    assert.equal(fieldByPath(fields, "parent__version").required, true);
  });

  it("rejects reads, mode mismatches, and malformed derivations", () => {
    // Reads are not forms: no mode agrees with a read derivation.
    for (const mode of ["create", "update", "scenario"] as const) {
      assert.throws(
        () => generatedFields(GADGET_READ, mode),
        /read\/delete derivations have no generated form/,
      );
      assert.throws(
        () => generatedFields(STORE_READ, mode),
        /read\/delete derivations have no generated form/,
      );
    }
    assert.throws(() => generatedFields(GADGET_CREATE, "update"), /does not agree/);
    assert.throws(() => generatedFields(REVIEW, "create"), /does not agree/);
    // Unknown kinds fail closed (JS-callable surface; TS closes the union).
    const unknownKind = {
      ...STORE_CREATE,
      inputs: [{ name: "title", kind: "nope", required: true }],
    } as unknown as DerivedOperationInputs;
    assert.throws(() => generatedFields(unknownKind, "create"), /unknown input kind/);
    const refNoFlag = {
      ...MEMBER_CREATE,
      inputs: [{ name: "parent", kind: "ref", required: true, model: "Shop.Team" }],
    } as unknown as DerivedOperationInputs;
    assert.throws(() => generatedFields(refNoFlag, "create"), /boolean versioned flag/);
    const enumNoValues = {
      ...STORE_CREATE,
      inputs: [{ name: "state", kind: "enum", required: false }],
    } as unknown as DerivedOperationInputs;
    assert.throws(() => generatedFields(enumNoValues, "create"), /needs enumValues/);
    // A typo'd prefill is never silently dropped.
    assert.throws(
      () => generatedFields(STORE_CREATE, "create", { values: { tital: "x" } }),
      /unknown prefill path "tital"/,
    );
  });

  it("applies label and value overrides, companions included", () => {
    const fields = generatedFields(GADGET_CREATE, "create", {
      labels: { stock: message("Stock", { nl: "Voorraad" }), owner__version: "Owner version" },
      values: { stock: "5", owner__version: "7" },
    });
    assert.deepEqual(fieldByPath(fields, "stock").label, message("Stock", { nl: "Voorraad" }));
    assert.equal(fieldByPath(fields, "stock").value, "5");
    assert.equal(fieldByPath(fields, "owner__version").label, "Owner version");
    assert.equal(fieldByPath(fields, "owner__version").value, "7");
    // Untouched fields keep their verbatim defaults.
    assert.equal(fieldByPath(fields, "title").label, "title");
  });

  it("prefills money object literals with their minor units", () => {
    // Mapping-rule probe (no pilot input is money): the `{minor,
    // currency}` wire literal prefills the minor-only widget value.
    const withMoney: DerivedOperationInputs = {
      ...STORE_CREATE,
      inputs: [
        ...STORE_CREATE.inputs,
        {
          name: "total",
          kind: "money",
          required: false,
          default: { kind: "literal", value: { minor: "150", currency: "EUR" } },
        },
      ],
    };
    const fields = generatedFields(withMoney, "create");
    assert.equal(fieldByPath(fields, "total").type, "money");
    assert.equal(fieldByPath(fields, "total").value, "150");
  });
});

describe("generated form rendering", () => {
  it("renders a create form with dispatch hiddens", async () => {
    const html = await generatedForm({
      context: makeContext(),
      action: "/api/operations/Store.Gadget.create",
      derived: STORE_CREATE,
      mode: "create",
      operationId: "op-1",
      timeZone: "UTC",
      submit: "Create",
      idPrefix: "store-create",
    });
    assert.ok(html.includes('<form action="/api/operations/Store.Gadget.create" method="post">'));
    assert.ok(html.includes('name="operation" value="Store.Gadget.create"'));
    assert.ok(html.includes('name="operation_id" value="op-1"'));
    assert.ok(html.includes(`name="${CSRF_FIELD}" value="csrf-123"`));
    assert.ok(html.includes('name="timezone" value="UTC"'));
    assert.ok(html.includes('name="inputs[title]"'));
    assert.ok(html.includes(">Create</button>"));
  });

  it("renders an update form with the bound record and changes root", async () => {
    const html = await generatedForm({
      context: makeContext(),
      action: "/api/operations/Store.Gadget.update",
      derived: STORE_UPDATE,
      mode: "update",
      operationId: "op-2",
      record: { id: "g1", version: "3" },
      timeZone: "UTC",
      submit: "Save",
      idPrefix: "store-update",
    });
    assert.ok(html.includes('name="inputs[record][id]" value="g1"'));
    assert.ok(html.includes('name="inputs[record][version]" value="3"'));
    assert.ok(html.includes('name="inputs[changes][title]"'));
    await assert.rejects(
      generatedForm({
        context: makeContext(),
        action: "/x",
        derived: STORE_UPDATE,
        mode: "update",
        operationId: "op-3",
        timeZone: "UTC",
        submit: "Save",
        idPrefix: "store-update",
      }),
      /update mode requires a bound record/,
    );
  });

  it("renders scenario fields with verbatim literal prefills", async () => {
    const html = await generatedForm({
      context: makeContext(),
      action: "/api/operations/Shop.review",
      derived: REVIEW,
      mode: "scenario",
      operationId: "op-4",
      timeZone: "UTC",
      submit: "Review",
      idPrefix: "review",
    });
    assert.ok(html.includes('name="inputs[notes]"'));
    assert.ok(html.includes('name="inputs[limit]"'));
    assert.ok(html.includes('value="10"'));
    assert.ok(html.includes('name="inputs[nick]"'));
  });
});

describe("submission projection", () => {
  it("projects scalars verbatim and ignores transport extras", () => {
    assert.deepEqual(
      projectGeneratedInputs(STORE_CREATE, "create", {
        operation: "Store.Gadget.create",
        operation_id: "op-1",
        [CSRF_FIELD]: "csrf-123",
        timezone: "UTC",
        "inputs[title]": "wrench",
        bogus: "never-enters",
        "inputs[bogus]": "never-enters",
      }),
      { title: "wrench" },
    );
    assert.deepEqual(
      projectGeneratedInputs(REVIEW, "scenario", {
        "inputs[notes]": '["a","b"]',
        "inputs[limit]": "10",
        "inputs[nick]": "x",
      }),
      { notes: ["a", "b"], limit: "10", nick: "x" },
    );
  });

  it("omits absent and empty optional members; required absence omits for dispatch", () => {
    // Empty/absent optionals omit so omission defers to the engine.
    assert.deepEqual(
      projectGeneratedInputs(REVIEW, "scenario", { "inputs[notes]": "", "inputs[limit]": "10" }),
      { limit: "10" },
    );
    // Required-but-absent also omits: presence is the dispatcher's
    // judgment (closed-inputs `required` validation), not the client's.
    assert.deepEqual(projectGeneratedInputs(STORE_CREATE, "create", {}), {});
    // Required-but-cleared travels verbatim for the engine to judge.
    assert.deepEqual(
      projectGeneratedInputs(STORE_CREATE, "create", { "inputs[title]": "" }),
      { title: "" },
    );
  });

  it("composes refs and the bound record; optional empty refs omit", () => {
    assert.deepEqual(
      projectGeneratedInputs(MEMBER_CREATE, "create", {
        "inputs[name]": "Ada",
        "inputs[parent]": "t1",
      }),
      { name: "Ada", parent: { id: "t1" } },
    );
    assert.deepEqual(
      projectGeneratedInputs(GADGET_UPDATE, "update", {
        "inputs[record][id]": "g1",
        "inputs[record][version]": "3",
        "inputs[changes][owner]": "o9",
        "inputs[changes][owner__version]": "2",
      }),
      { record: { id: "g1", version: "3" }, owner: { id: "o9", version: "2" } },
    );
    // Optional owner left empty omits the whole member (id and version).
    assert.deepEqual(
      projectGeneratedInputs(GADGET_UPDATE, "update", {
        "inputs[record][id]": "g1",
        "inputs[record][version]": "3",
        "inputs[changes][owner]": "",
      }),
      { record: { id: "g1", version: "3" } },
    );
    // A partial record travels as-is; the engine judges the shape.
    assert.deepEqual(
      projectGeneratedInputs(STORE_UPDATE, "update", { "inputs[record][id]": "g1" }),
      { record: { id: "g1" } },
    );
  });

  it("coerces bools and fails closed on malformed values", () => {
    // Mapping-rule probe (no pilot input is bool): absent reads
    // unchecked-false, present coerces, anything else throws.
    const withFlag: DerivedOperationInputs = {
      ...STORE_CREATE,
      inputs: [...STORE_CREATE.inputs, { name: "flag", kind: "boolean", required: false }],
    };
    assert.deepEqual(
      projectGeneratedInputs(withFlag, "create", { "inputs[title]": "t" }),
      { title: "t", flag: false },
    );
    assert.deepEqual(
      projectGeneratedInputs(withFlag, "create", { "inputs[title]": "t", "inputs[flag]": "true" }),
      { title: "t", flag: true },
    );
    assert.throws(
      () => projectGeneratedInputs(withFlag, "create", { "inputs[flag]": "yes" }),
      /bool input "flag" needs "true" or "false"/,
    );
    // Malformed arrays never enter the envelope.
    assert.throws(
      () => projectGeneratedInputs(REVIEW, "scenario", { "inputs[notes]": "nope" }),
      /array input "notes" needs JSON-array text/,
    );
    assert.throws(
      () => projectGeneratedInputs(REVIEW, "scenario", { "inputs[notes]": '"x"' }),
      /array input "notes" needs JSON-array text/,
    );
    assert.throws(
      () => projectGeneratedInputs(GADGET_CREATE, "create", { "inputs[ids]": "" }),
      /array input "ids" needs JSON-array text/,
    );
    assert.throws(
      () => projectGeneratedInputs(STORE_CREATE, "update", { "inputs[title]": "t" }),
      /does not agree/,
    );
  });

  it("resolves datetime values and carries file ids (T20b supersede)", () => {
    // T20b SUPERSEDE: the T20a placeholder throws are replaced by the
    // specified projection — wall-to-instant in the form zone, opaque
    // file ids verbatim — while absent optionals still omit.
    const withWhen: DerivedOperationInputs = {
      ...STORE_CREATE,
      inputs: [...STORE_CREATE.inputs, { name: "when", kind: "datetime", required: false }],
    };
    assert.deepEqual(projectGeneratedInputs(withWhen, "create", { "inputs[title]": "t" }), {
      title: "t",
    });
    assert.deepEqual(
      projectGeneratedInputs(withWhen, "create", {
        timezone: "UTC",
        "inputs[title]": "t",
        "inputs[when]": "2026-01-01T10:00",
      }),
      { title: "t", when: "2026-01-01T10:00:00.000Z" },
    );
    const withFile: DerivedOperationInputs = {
      ...STORE_CREATE,
      inputs: [...STORE_CREATE.inputs, { name: "scan", kind: "file", required: false }],
    };
    assert.deepEqual(projectGeneratedInputs(withFile, "create", { "inputs[title]": "t" }), {
      title: "t",
    });
    assert.deepEqual(
      projectGeneratedInputs(withFile, "create", {
        "inputs[title]": "t",
        "inputs[scan]": "file-opaque-1",
      }),
      { title: "t", scan: "file-opaque-1" },
    );
  });
});

describe("fragment wrap", () => {
  it("wraps the form in the stable swap target", () => {
    assert.equal(
      formFragmentWrap("store-create", "<form></form>"),
      '<div id="store-create-form"><form></form></div>',
    );
    assert.equal(GENERATED_REF_VERSION_SUFFIX, "__version");
    assert.deepEqual(Object.keys(GENERATED_FORM_TYPE_FOR_KIND).sort(), [
      "boolean",
      "datetime",
      "decimal",
      "enum",
      "file",
      "integer",
      "money",
      "ref",
      "string",
    ]);
  });
});

describe("pilot shell, settings, and appearance integration", () => {
  async function pilotPage(
    context: PresentationContext,
    shell: ShellData,
  ): Promise<string> {
    const formHtml = await generatedForm({
      context,
      action: "/api/operations/Store.Gadget.create",
      derived: STORE_CREATE,
      mode: "create",
      operationId: "op-page",
      timeZone: "UTC",
      submit: "Create",
      idPrefix: "store-create",
    });
    const panelHtml = await renderSettingsPanel({
      context,
      sectionId: "base",
      base: {
        caption: message("Appearance", { nl: "Vormgeving" }),
        postTo: "/settings/base",
        themeLabel: message("Theme", { nl: "Thema" }),
        themes: [
          { value: "can-system-blue", label: message("System blue", { nl: "Systeem blauw" }) },
          { value: "can-dark-green", label: message("Dark green", { nl: "Donkergroen" }) },
        ],
        currentTheme: "can-system-blue",
        densityLabel: message("Density", { nl: "Dichtheid" }),
        currentDensity: context.theme.density,
      },
    });
    return renderPage(
      context,
      makeDescriptor(),
      [formHtml],
      { ...shell, settings: { ...shell.settings, panelHtml } },
    );
  }

  it("renders the pilot form full-page inside the shell with the settings panel", async () => {
    const html = await pilotPage(makeContext(), makeShell());
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.ok(html.includes('<main id="can-main">'));
    assert.ok(html.includes('name="operation" value="Store.Gadget.create"'));
    assert.ok(html.includes('name="inputs[title]"'));
    // Shell chrome stays intact around the pilot form.
    assert.ok(html.includes("can-brand"));
    assert.ok(html.includes('id="can-settings"'));
    assert.ok(html.includes('action="/settings/base"'));
    assert.ok(html.includes('name="density" value="compact"'));
  });

  it("carries theme and density into the pilot page; partials render main only", async () => {
    const context = makeContext({
      theme: { mode: "dark", accent: "green", density: "compact" },
    });
    const full = await pilotPage(context, makeShell());
    assert.ok(full.includes('data-theme="can-dark-green"'));
    assert.ok(full.includes('class="density-compact"'));
    const partialContext = makeContext({ isPartial: true });
    const partialForm = await generatedForm({
      context: partialContext,
      action: "/api/operations/Store.Gadget.create",
      derived: STORE_CREATE,
      mode: "create",
      operationId: "op-partial",
      timeZone: "UTC",
      submit: "Create",
      idPrefix: "store-create",
    });
    const partial = await renderPage(
      partialContext,
      makeDescriptor(),
      [formFragmentWrap("store-create", partialForm)],
    );
    assert.equal(partial, `<main id="can-main">${formFragmentWrap("store-create", partialForm)}</main>`);
    assert.ok(partial.includes('<div id="store-create-form">'));
    assert.ok(partial.includes('name="inputs[title]"'));
  });

  it("preserves the delivered catalog words the pilot flows reuse", () => {
    for (const id of ["page-shell", "form", "edit", "action", "actions", "settings"]) {
      const entry = UI_CATALOG.entries.find((candidate) => candidate.id === id);
      assert.ok(entry !== undefined, `catalog word ${id}`);
      assert.equal(entry.availability, "implemented");
    }
  });
});
