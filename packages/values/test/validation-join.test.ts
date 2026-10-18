// Deferred-leaf join checks: the resolve loop drives genuine owned
// execution (real wasm binding, real exact decodes) from first gap
// to a settled outcome. Requires rebuilt glue (build-semantics.mjs)
// exposing validation_call with the resolved-leaf admission.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initSync } from "../bindings/generated/values_semantics.js";
import {
  executeOwnedRequest,
  frameToJsonValue,
  loadOwnerPlan,
  resolveDeferredValidation,
  validationBackend,
  type OwnedExecution,
  type ValidationBackend,
  type ValidationGlue,
} from "../bindings/validation.js";
import {
  ownedFrameAt,
  ownedFrameFor,
  ownedJsonValue,
  parseOwnedJsonBody,
  textUnits,
  type OwnedFrame,
} from "../bindings/owned-input.js";
import { structural_abi_version, validation_call } from "../bindings/generated/values_semantics.js";
import { decodeValue } from "../src/wire.js";
import { SchemaError } from "../src/errors.js";
import { decimalToString } from "../src/decimal.js";

const here = dirname(fileURLToPath(import.meta.url));
const wasmBytes = () =>
  new Uint8Array(
    readFileSync(join(here, "..", "bindings", "generated", "values_semantics_bg.wasm")),
  );

function backend(): ValidationBackend {
  initSync({ module: wasmBytes() });
  const glue: ValidationGlue = { structural_abi_version, validation_call };
  return validationBackend(glue);
}

const budgets = { nodes: 1000, depth: 50, text: 1000, entries: 100 };
const provenance = { factory: "normalizeSchema", owner_rev: "artifact-1" };

function exactField(name: string, scalar: string, required: boolean): Record<string, unknown> {
  return {
    name,
    type_id: scalar,
    base: { t: "scalar", name: scalar },
    required,
  };
}

function invoiceSchema(): Record<string, unknown> {
  return {
    t: "normalized",
    contracts: [
      {
        name: "Invoice",
        fields: [
          exactField("amount", "money", true),
          exactField("qty", "int", true),
          exactField("rate", "decimal", true),
          exactField("day", "date", true),
          {
            name: "note",
            type_id: "text",
            base: { t: "scalar", name: "text" },
            required: true,
            length_max: 5,
          },
        ],
      },
    ],
    enums: [],
    operations: [],
  };
}

function loadInvoice(via: ValidationBackend): { owner: number; id: string } {
  return loadOwnerPlan(via, {
    abi: "v1",
    profile: "values",
    planProfile: "values/v1",
    backend: "native",
    owner_rev: "artifact-1",
    bound: 8,
    schema: invoiceSchema(),
    provenance,
  });
}

async function tokenFor(body: string) {
  const bytes = new TextEncoder().encode(body);
  return parseOwnedJsonBody(
    new Request("http://owned.test/input", { method: "POST", body }),
    async () => bytes,
  );
}

function executionFor(
  owner: number,
  plan: string,
  frame: unknown,
  target: OwnedExecution["target"],
): OwnedExecution {
  return { owner, plan, frame, budgets, profile: "values/v1", target };
}

function segPathToStrings(path: ReadonlyArray<{ k: readonly number[] } | { i: number }>): Array<string | number> {
  return path.map((seg) => ("i" in seg ? seg.i : String.fromCharCode(...seg.k)));
}

describe("deferred-leaf join through the resolve loop", () => {
  it("validates money+int+decimal+date end to end through genuine decodes", async () => {
    const via = backend();
    const loaded = loadInvoice(via);
    const body =
      '{"amount":{"minor":"100","currency":"USD"},"qty":"5","rate":"1.50","day":"2024-02-29","note":"ok"}';
    const token = await tokenFor(body);
    const outcome = resolveDeferredValidation(
      via,
      executionFor(
        loaded.owner,
        loaded.id,
        ownedFrameFor(token),
        { kind: "contract", name: "Invoice", mode: "create" },
      ),
      ownedJsonValue(token),
    );
    assert.equal(outcome.outcome, "valid");
    assert.equal((outcome as { value: unknown }).value !== undefined, true);
    const value = (outcome as { value: { t: string; entries: Array<[number[], unknown]> } }).value;
    assert.equal(value.t, "entries");
    const fields = Object.fromEntries(
      value.entries.map(([key, node]) => [String.fromCharCode(...key), node as { t: string; kind?: string; value?: unknown }]),
    );
    // Canonical frames ride opaquely: "1.50" decodes and stores as "1.5".
    assert.deepEqual(fields["qty"], {
      t: "exact",
      kind: "int",
      value: { t: "text", units: textUnits("5") },
    });
    assert.deepEqual(fields["rate"], {
      t: "exact",
      kind: "decimal",
      value: { t: "text", units: textUnits("1.5") },
    });
    // Materialization decodes canonical frames through the genuine codec.
    const materialized = frameToJsonValue(value) as Record<string, unknown>;
    assert.equal(materialized["qty"], 5n);
    assert.equal(decimalToString(materialized["rate"] as Parameters<typeof decimalToString>[0]), "1.5");
    const amount = materialized["amount"] as { minor: unknown; currency: unknown };
    assert.equal(String(amount.minor), "100");
    assert.equal(amount.currency, "USD");
    assert.deepEqual(materialized["day"], { kind: "date", year: 2024, month: 2, day: 29 });
    assert.equal(materialized["note"], "ok");
  });

  it("accumulates ordered violations across replayed and native leaves", async () => {
    const via = backend();
    const loaded = loadInvoice(via);
    const body =
      '{"amount":{"minor":"xx","currency":"USD"},"qty":"zz","rate":"1.5","day":"2024-02-29","note":"waytoolong"}';
    const token = await tokenFor(body);
    const outcome = resolveDeferredValidation(
      via,
      executionFor(
        loaded.owner,
        loaded.id,
        ownedFrameFor(token),
        { kind: "contract", name: "Invoice", mode: "create" },
      ),
      ownedJsonValue(token),
    );
    assert.equal(outcome.outcome, "invalid");
    const violations = (outcome as unknown as {
      violations: ReadonlyArray<{ path: unknown; code: string; message: string }>;
    }).violations;
    assert.equal(violations.length, 3);
    // Field order: replayed money (with the codec-relative minor step),
    // replayed int, then the native text bound.
    assert.deepEqual(segPathToStrings(
      violations[0]!.path as ReadonlyArray<{ k: readonly number[] } | { i: number }>,
    ), ["amount", "minor"]);
    assert.deepEqual(segPathToStrings(
      violations[1]!.path as ReadonlyArray<{ k: readonly number[] } | { i: number }>,
    ), ["qty"]);
    assert.deepEqual(segPathToStrings(
      violations[2]!.path as ReadonlyArray<{ k: readonly number[] } | { i: number }>,
    ), ["note"]);
    assert.equal(violations[2]!.code, "bound");
    // Genuine codec messages survive the replay verbatim.
    let genuineMessage = "";
    try {
      decodeValue("money", { minor: "xx", currency: "USD" });
    } catch (error) {
      assert.ok(error instanceof SchemaError);
      genuineMessage = (error as SchemaError).violations[0]!.message;
    }
    assert.notEqual(genuineMessage, "");
    assert.equal(violations[0]!.message, genuineMessage);
  });

  it("validates a mutation operation target with datetime and duration leaves", async () => {
    const via = backend();
    const loaded = loadOwnerPlan(via, {
      abi: "v1",
      profile: "values",
      planProfile: "values/v1",
      backend: "native",
      owner_rev: "artifact-1",
      bound: 8,
      schema: {
        t: "normalized",
        contracts: [],
        enums: [],
        operations: [
          {
            name: "Shop.Refund",
            mutation: true,
            inputs: [
              exactField("amount", "money", true),
              exactField("when", "datetime", true),
              exactField("ttl", "duration", false),
            ],
          },
        ],
      },
      provenance,
    });
    const body =
      '{"amount":{"minor":"25","currency":"EUR"},"when":"2024-02-29T00:00:00.000Z","ttl":"86400000","operation_id":"op-1"}';
    const token = await tokenFor(body);
    const outcome = resolveDeferredValidation(
      via,
      executionFor(
        loaded.owner,
        loaded.id,
        ownedFrameFor(token),
        { kind: "operation", name: "Shop.Refund" },
      ),
      ownedJsonValue(token),
    );
    assert.equal(outcome.outcome, "valid");
    const materialized = frameToJsonValue(
      (outcome as { value: unknown }).value,
    ) as Record<string, unknown>;
    const amount = materialized["amount"] as { minor: unknown; currency: unknown };
    assert.equal(String(amount.minor), "25");
    assert.equal(amount.currency, "EUR");
    assert.equal(materialized["operation_id"], "op-1");
  });

  it("passes wire-codec deferrals through honestly unresolved", async () => {
    const via = backend();
    const loaded = loadOwnerPlan(via, {
      abi: "v1",
      profile: "values",
      planProfile: "values/v1",
      backend: "native",
      owner_rev: "artifact-1",
      bound: 8,
      schema: {
        t: "normalized",
        contracts: [
          {
            name: "Team",
            fields: [{ name: "owner", type_id: "user", base: { t: "user" }, required: true }],
          },
        ],
        enums: [],
        operations: [],
      },
      provenance,
    });
    const token = await tokenFor('{"owner":"u1"}');
    const outcome = resolveDeferredValidation(
      via,
      executionFor(
        loaded.owner,
        loaded.id,
        ownedFrameFor(token),
        { kind: "contract", name: "Team", mode: "create" },
      ),
      ownedJsonValue(token),
    );
    assert.equal(outcome.outcome, "deferred");
    assert.equal((outcome as { reason: string }).reason, "wire-codec");
    assert.equal((outcome as { leaf?: string }).leaf, undefined);
  });

  it("fails closed when the gap never shrinks", async () => {
    let calls = 0;
    const stuck: ValidationBackend = {
      call(op: string) {
        calls += 1;
        if (op === "request.begin") return { request: 7 };
        if (op === "request.dispose") return null;
        assert.equal(op, "values.execute");
        return {
          outcome: "deferred",
          reason: "exact-codec",
          detail: "target reaches a leaf owned by exact-codec at contracts.Invoice.fields.qty",
          leaf: "int",
          path: [{ k: textUnits("qty") }],
        };
      },
    };
    // Absent input appends a marker, but the stub keeps returning the
    // same gap: the progress guard must throw instead of looping.
    assert.throws(
      () =>
        resolveDeferredValidation(
          stuck,
          {
            owner: 1,
            plan: "plan:v1:values:native:artifact-1:g0:0",
            frame: { t: "entries", entries: [] },
            budgets,
            profile: "values/v1",
            target: { kind: "contract", name: "Invoice", mode: "create" },
          },
          {},
          { maxRounds: 8 },
        ),
      /did not shrink/,
    );
    assert.equal(calls, 4);
  });

  it("fails closed when bounded iterations run out", () => {
    const slow: ValidationBackend = {
      call(op: string) {
        if (op === "request.begin") return { request: 7 };
        if (op === "request.dispose") return null;
        assert.equal(op, "values.execute");
        return { outcome: "valid", value: null };
      },
    };
    // maxRounds 0 still permits the first execute; a deferral on that
    // round attempts resolution past the bound.
    const deferring: ValidationBackend = {
      call(op: string, args: Record<string, unknown>) {
        if (op === "request.begin") return { request: 7 };
        if (op === "request.dispose") return null;
        assert.equal(op, "values.execute");
        const resolved = args["resolved"];
        if (Array.isArray(resolved) && resolved.length > 0) return { outcome: "valid", value: null };
        return {
          outcome: "deferred",
          reason: "exact-codec",
          detail: "x",
          leaf: "int",
          path: [{ k: textUnits("qty") }],
        };
      },
    };
    assert.equal(
      resolveDeferredValidation(
        slow,
        {
          owner: 1,
          plan: "p",
          frame: { t: "null" },
          budgets,
          profile: "values/v1",
          target: { kind: "contract", name: "Invoice", mode: "create" },
        },
        {},
      ).outcome,
      "valid",
    );
    assert.throws(
      () =>
        resolveDeferredValidation(
          deferring,
          {
            owner: 1,
            plan: "p",
            frame: { t: "null" },
            budgets,
            profile: "values/v1",
            target: { kind: "contract", name: "Invoice", mode: "create" },
          },
          {},
          { maxRounds: 0 },
        ),
      /bounded iterations/,
    );
  });
});

describe("owned frame derivation and conversion", () => {
  it("derives subframes from genuine tokens and refuses absent paths", async () => {
    const token = await tokenFor('{"inputs":{"amount":"5"},"operation":"Shop.Refund"}');
    const frame = ownedFrameAt(token, ["inputs"]) as {
      t: string;
      entries: Array<[number[], OwnedFrame]>;
    };
    assert.equal(frame.t, "entries");
    assert.deepEqual(
      frame.entries.map(([key]) => String.fromCharCode(...key)),
      ["amount"],
    );
    assert.throws(
      () => ownedFrameAt(token, ["missing"]),
      (error: unknown) => (error as Error).message === "Owned frame path is absent.",
    );
    assert.throws(
      () => ownedFrameAt(token, ["inputs", "amount", "deep"]),
      (error: unknown) => (error as Error).message === "Owned frame path is absent.",
    );
  });

  it("converts frames back to JSON values without host stack overflow", async () => {
    assert.equal(frameToJsonValue({ t: "null" }), null);
    assert.equal(frameToJsonValue({ t: "bool", v: true }), true);
    assert.equal(frameToJsonValue({ t: "f64", bits: "8000000000000000" }), -0);
    assert.ok(Object.is(frameToJsonValue({ t: "f64", bits: "8000000000000000" }), -0));
    assert.equal(frameToJsonValue({ t: "text", units: [55296] }), "\ud800");
    assert.deepEqual(frameToJsonValue({
      t: "entries",
      entries: [
        [textUnits("b"), { t: "f64", bits: "3ff0000000000000" }],
        [textUnits("a"), { t: "text", units: textUnits("x") }],
      ],
    }), { b: 1, a: "x" });
    // Parser-accepted depth converts on the heap, never the host stack.
    const deep = `[`.repeat(12000) + `0` + `]`.repeat(12000);
    const token = await tokenFor(deep);
    const frame = ownedFrameFor(token);
    let value: unknown = frameToJsonValue(frame);
    for (let index = 0; index < 12000; index++) value = (value as unknown[])[0];
    assert.equal(value, 0);
  });

  it("materializes exact nodes through the genuine codec", () => {
    const materialized = frameToJsonValue({
      t: "entries",
      entries: [
        [textUnits("qty"), { t: "exact", kind: "int", value: { t: "text", units: textUnits("42") } }],
      ],
    }) as Record<string, unknown>;
    assert.equal(materialized["qty"], 42n);
    // executeOwnedRequest threads resolved entries into the envelope.
    let seen: unknown;
    const spy: ValidationBackend = {
      call(op: string, args: Record<string, unknown>) {
        assert.equal(op, "values.execute");
        seen = (args as { resolved?: unknown }).resolved;
        return { outcome: "valid", value: null };
      },
    };
    const outcome = executeOwnedRequest(spy, 1, "values/v1", {
      kind: "contract",
      name: "Invoice",
      mode: "create",
    }, [{ path: [{ k: textUnits("qty") }], frame: { t: "text", units: textUnits("42") } }]);
    assert.equal(outcome.outcome, "valid");
    assert.deepEqual(seen, [{ path: [{ k: textUnits("qty") }], frame: { t: "text", units: textUnits("42") } }]);
  });
});
