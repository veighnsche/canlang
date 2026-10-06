// V03.5 coordinated binding checks: the SAME structural calls run
// through the actual wasm binding (initSync over local bytes, no
// mocked loader) and prove bits/UTF-16/keys preservation plus
// version/length/fixed-width gates before coercion. Requires rebuilt
// glue (build-semantics.mjs) exposing validation_call.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initSync } from "../bindings/generated/values_semantics.js";
import {
  StructuralError,
  validationBackend,
  type ValidationBackend,
  type ValidationGlue,
} from "../bindings/validation.js";
import { structural_abi_version, validation_call } from "../bindings/generated/values_semantics.js";

const here = dirname(fileURLToPath(import.meta.url));
// Compiled hosts read the staged, digest-checked binding beside dist/test/.
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

function schema(): Record<string, unknown> {
  return {
    t: "normalized",
    contracts: [
      {
        name: "User",
        fields: [
          { name: "id", type_id: "int", base: { t: "scalar", name: "int" }, required: true },
        ],
      },
    ],
    enums: [],
    operations: [],
  };
}

const provenance = { factory: "normalizeSchema", owner_rev: "artifact-1" };

function owner(via: ValidationBackend): number {
  const out = via.call("owner.create", {
    abi: "v1",
    profile: "values",
    backend: "native",
    owner_rev: "artifact-1",
    bound: 8,
  }) as { owner: number };
  return out.owner;
}

describe("structural scaffold binding", () => {
  it("constructs only against ABI 1", () => {
    const good = backend();
    assert.equal(typeof good.call, "function");
    assert.throws(
      () => validationBackend({ structural_abi_version: () => 999, validation_call: () => "{}" }),
      (err: unknown) => {
        assert.ok(err instanceof StructuralError);
        assert.equal(err.code, "version/unsupported");
        return true;
      },
    );
  });

  it("preserves bits, units and keys through the real binding", () => {
    const via = backend();
    const negZero = via.call("input.digest", {
      frame: { t: "f64", bits: "8000000000000000" },
      budgets,
    }) as { root: { bits: string } };
    assert.equal(negZero.root.bits, "8000000000000000");
    const lone = via.call("input.digest", {
      frame: { t: "text", units: [55296] },
      budgets,
    }) as { root: { units: number[] } };
    assert.deepEqual(lone.root.units, [55296]);
    const dupes = via.call("input.digest", {
      frame: {
        t: "entries",
        entries: [
          [[98], { t: "f64", bits: "3ff0000000000000" }],
          [[97], { t: "bool", v: true }],
          [[98], { t: "null" }],
        ],
      },
      budgets,
    }) as { root: { keys: number[][] } };
    assert.deepEqual(dupes.root.keys, [[98], [97], [98]]);
  });

  it("rejects malformed versions, ops and args at the transport stage", () => {
    initSync({ module: wasmBytes() });
    const raw = (body: string): Record<string, unknown> =>
      JSON.parse(validation_call(body)) as Record<string, unknown>;
    assert.equal(raw('{"op":"input.digest","args":{}}')["code"], "version/malformed");
    assert.equal(raw('{"v":9,"op":"input.digest","args":{}}')["code"], "version/unsupported");
    assert.equal(
      raw('{"v":1,"op":"nope","args":{}}')["code"],
      "op/unknown",
    );
    assert.equal(raw("not json")["code"], "args/malformed");
  });

  it("rejects fixed-width overflow before coercion", () => {
    const via = backend();
    for (const frame of [
      { t: "text", units: [65536] },
      { t: "f64", bits: "00000000000000000" },
    ]) {
      assert.throws(() => via.call("input.digest", { frame, budgets }), (err: unknown) => {
        assert.ok(err instanceof StructuralError);
        assert.equal(err.stage, "transport");
        assert.equal(err.code, "fixed-width/overflow");
        return true;
      });
    }
    assert.throws(
      () =>
        via.call("input.digest", {
          frame: { t: "bool", v: true },
          budgets: { nodes: 4294967296, depth: 1, text: 1, entries: 1 },
        }),
      (err: unknown) => {
        assert.ok(err instanceof StructuralError);
        assert.equal(err.code, "fixed-width/overflow");
        return true;
      },
    );
  });

  it("checks lengths before any node is usable", () => {
    const via = backend();
    assert.throws(
      () =>
        via.call("input.digest", {
          frame: { t: "array", items: [{ t: "bool", v: true }] },
          budgets: { nodes: 1, depth: 50, text: 1000, entries: 100 },
        }),
      (err: unknown) => {
        assert.ok(err instanceof StructuralError);
        assert.equal(err.stage, "transport");
        assert.equal(err.code, "length/oversized");
        assert.equal(err.check, "nodes");
        return true;
      },
    );
  });

  it("keeps owner handles server-side across calls", () => {
    const via = backend();
    const handle = owner(via);
    assert.equal(typeof handle, "number");
    assert.throws(
      () => via.call("plan.register", { owner: 999999, profile: "v", schema: schema() }),
      (err: unknown) => {
        assert.ok(err instanceof StructuralError);
        assert.equal(err.stage, "plan");
        assert.equal(err.code, "foreign-owner");
        return true;
      },
    );
  });

  it("registers and reads plans through the envelope", () => {
    const via = backend();
    const handle = owner(via);
    const registered = via.call("plan.register", {
      owner: handle,
      profile: "values/v1",
      schema: schema(),
      provenance,
    }) as { id: string };
    assert.match(registered.id, /^plan:v1:values:native:artifact-1:g0:\d+$/);
    const summary = via.call("plan.get", { owner: handle, id: registered.id }) as {
      contracts: string[];
      generation: number;
    };
    assert.deepEqual(summary.contracts, ["User"]);
    assert.equal(summary.generation, 0);
    const retired = via.call("owner.retire", { owner: handle }) as { generation: number };
    assert.equal(retired.generation, 1);
    assert.throws(() => via.call("plan.get", { owner: handle, id: registered.id }), (err: unknown) => {
      assert.ok(err instanceof StructuralError);
      assert.equal(err.code, "inactive-generation");
      return true;
    });
  });

  it("surfaces plan gates at the plan stage", () => {
    const via = backend();
    const handle = owner(via);
    assert.throws(
      () =>
        via.call("plan.register", {
          owner: handle,
          profile: "v",
          schema: { t: "legacy", text: "s" },
          provenance,
        }),
      (err: unknown) => {
        assert.ok(err instanceof StructuralError);
        assert.equal(err.stage, "plan");
        assert.equal(err.code, "legacy-wrapper");
        return true;
      },
    );
    assert.throws(
      () => via.call("plan.register", { owner: handle, profile: "v", schema: schema() }),
      (err: unknown) => {
        assert.ok(err instanceof StructuralError);
        assert.equal(err.code, "missing-provenance");
        return true;
      },
    );
  });
});
