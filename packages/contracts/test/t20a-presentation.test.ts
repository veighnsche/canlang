import { describe, expect, it } from "vitest";
import {
  GENERATED_FORM_TYPE_FOR_KIND,
  GENERATED_REF_VERSION_SUFFIX,
  PRESENTATION_CONTRACT_VERSION,
  type GeneratedFormProps,
  type MessageValue,
  type PresentationContext,
} from "../src/presentation.js";
import type { DerivedOperationInputs } from "../src/wire.js";

// T20a generated-form contract pins. The factories live in @canlang/ui
// (forms.ts) and the re-render join in @canlang/interfaces
// (http/formErrors.ts); this file pins the presentation rule they must
// satisfy: the closed pilot widget table, the ref-version companion
// convention, and the generated-form props shape.

function makeContext(): PresentationContext {
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
  };
}

const STORE_CREATE: DerivedOperationInputs = {
  operation: "Store.Gadget.create",
  kind: "create",
  artifactVersion: 1,
  inputs: [{ name: "title", kind: "string", required: true }],
};

describe("T20a contract version stays pinned (additive slice)", () => {
  it("presentation version is unchanged", () => {
    expect(PRESENTATION_CONTRACT_VERSION).toBe("canlang.presentation/0.15.0");
  });
});

describe("T20a pinned widget selection", () => {
  it("covers the supported generated input kinds", () => {
    expect(Object.keys(GENERATED_FORM_TYPE_FOR_KIND).sort()).toEqual([
      "boolean",
      "datetime",
      "decimal",
      "enum",
      "file",
      "integer",
      "money",
      "ref",
      "string",
      "user",
    ]);
  });

  it("maps each kind to its canonical field type", () => {
    expect(GENERATED_FORM_TYPE_FOR_KIND).toEqual({
      ref: "text",
      user: "text",
      string: "text",
      integer: "int",
      decimal: "decimal",
      money: "money",
      datetime: "datetime",
      boolean: "bool",
      file: "file",
      enum: "enum",
    });
  });

  it("pins the ref-version companion suffix", () => {
    expect(GENERATED_REF_VERSION_SUFFIX).toBe("__version");
  });
});

describe("T20a generated-form props", () => {
  it("carries the derivation, mode, dispatch metadata, and overrides", () => {
    const submit: MessageValue = "Create";
    const props: GeneratedFormProps = {
      context: makeContext(),
      action: "/api/operations/Store.Gadget.create",
      derived: STORE_CREATE,
      mode: "create",
      operationId: "op-1",
      timeZone: "UTC",
      submit,
      idPrefix: "store-create",
      labels: { title: "Title" },
      values: { title: "wrench" },
    };
    expect(props.derived.operation).toBe("Store.Gadget.create");
    expect(props.mode).toBe("create");
    expect(props.operationId).toBe("op-1");
    expect(props.timeZone).toBe("UTC");
    expect(props.labels).toEqual({ title: "Title" });
    expect(props.values).toEqual({ title: "wrench" });
    expect(props.record).toBeUndefined();
  });
});
