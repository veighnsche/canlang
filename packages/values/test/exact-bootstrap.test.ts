// A07.2 host bootstrap checks: import-without-bootstrap TS use, sync
// calls, double init, missing/corrupt/ABI-mismatched assets, carrier
// provenance and no semantic-error retry. Isolate-restart coverage
// needs a real workerd host and rides with the workerd smoke proof.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Decimal } from "../src/decimal.js";
import { ValueError } from "../src/errors.js";
import { makeDate, makeMoney } from "../src/kinds.js";
import { tsBackend, wasmBackend } from "../bindings/backend.js";
import { BootstrapError, bootstrapWasm } from "../bindings/bootstrap.js";

const here = dirname(fileURLToPath(import.meta.url));
// Compiled hosts read the staged, digest-checked binding beside dist/test/.
const wasmBytes = () =>
  new Uint8Array(
    readFileSync(join(here, "..", "bindings", "generated", "values_semantics_bg.wasm")),
  );

describe("ts backend without bootstrap", () => {
  it("answers smoke ops synchronously with no glue built", () => {
    const ts = tsBackend();
    assert.equal(ts.name, "ts");
    assert.equal(ts.call("add-int", [1n, 2n]), 3n);
    assert.equal(ts.call("negate-int", [5n]), -5n);
    const sum = ts.call("add-decimal", [new Decimal(15n, 1), 2n]);
    assert.ok(sum instanceof Decimal);
    assert.equal((sum as Decimal).coef, 35n);
    assert.equal((sum as Decimal).scale, 1);
    assert.equal(ts.call("date-to-epoch-days", [makeDate(2024, 2, 29)]), 19782);
    const money = ts.call("add-money", [makeMoney(100n, "USD"), makeMoney(25n, "USD")]);
    assert.deepEqual(money, { kind: "money", minor: 125n, currency: "USD" });
  });

  it("reports unknown smoke ops and Can failures as ValueError", () => {
    const ts = tsBackend();
    assert.throws(() => ts.call("nope", []), ValueError);
    assert.throws(() => ts.call("add-int", [1n]), ValueError);
  });

  it("retains decimal scale -0 on the ts path (carrier pin control)", () => {
    const ts = tsBackend();
    const out = ts.call("negate-decimal", [new Decimal(1n, -0)]);
    assert.ok(out instanceof Decimal);
    assert.ok(Object.is((out as Decimal).scale, -0));
    assert.equal((out as Decimal).coef, -1n);
    assert.ok(Object.isFrozen(out));
  });
});

describe("wasm bootstrap", () => {
  // Glue init is process-one-shot per module instance: once any
  // bootstrap succeeds, later initSync calls reuse it. The corrupt test
  // must therefore precede every successful bootstrap in this file.
  it("rejects missing bytes without touching the glue", () => {
    assert.throws(() => bootstrapWasm(new Uint8Array(0)), (err: unknown) => {
      assert.ok(err instanceof BootstrapError);
      assert.equal(err.code, "missing-bytes");
      return true;
    });
  });

  it("reports corrupt bytes as init-failed, never a half backend", () => {
    assert.throws(() => bootstrapWasm(new Uint8Array([0, 1, 2, 3])), (err: unknown) => {
      assert.ok(err instanceof BootstrapError);
      assert.equal(err.code, "init-failed");
      return true;
    });
  });

  it("instantiates local bytes and answers smoke ops", () => {
    const wasm = bootstrapWasm(wasmBytes());
    assert.equal(wasm.name, "wasm");
    assert.equal(wasm.call("add-int", [1n, 2n]), 3n);
    assert.equal(wasm.call("negate-int", [5n]), -5n);
    assert.equal(wasm.call("date-to-epoch-days", [makeDate(2024, 2, 29)]), 19782);
  });

  it("reconstructs carriers with public provenance", () => {
    const wasm = bootstrapWasm(wasmBytes());
    const sum = wasm.call("add-decimal", [new Decimal(15n, 1), 2n]);
    assert.ok(sum instanceof Decimal);
    assert.equal((sum as Decimal).coef, 35n);
    assert.equal((sum as Decimal).scale, 1);
    assert.ok(Object.isFrozen(sum));
    const money = wasm.call("add-money", [makeMoney(100n, "USD"), makeMoney(25n, "USD")]);
    assert.deepEqual(money, { kind: "money", minor: 125n, currency: "USD" });
  });

  it("supports repeated bootstrap with working backends", () => {
    // Both backends share the one-shot underlying instance; each
    // answers calls independently.
    const first = bootstrapWasm(wasmBytes());
    const second = bootstrapWasm(wasmBytes());
    assert.equal(first.call("add-int", [2n, 3n]), 5n);
    assert.equal(second.call("add-int", [3n, 4n]), 7n);
  });

  it("fails ABI-mismatched glue at construction", () => {
    assert.throws(
      () => wasmBackend({ abi_version: () => 999, exact_call: () => "{}" }),
      (err: unknown) => {
        assert.ok(err instanceof ValueError);
        assert.equal(err.code, "invalid-construction");
        return true;
      },
    );
  });

  it("surfaces Can failures once with no retry", () => {
    let calls = 0;
    const counting = wasmBackend({
      abi_version: () => 1,
      exact_call: () => {
        calls += 1;
        return JSON.stringify({ ok: false, code: "overflow", message: "int64 overflow" });
      },
    });
    assert.throws(() => counting.call("add-int", [1n, 2n]), (err: unknown) => {
      assert.ok(err instanceof ValueError);
      assert.equal(err.code, "overflow");
      return true;
    });
    assert.equal(calls, 1);
  });

  it("refuses decimal scale -0 on the wasm path (carrier pin negative)", () => {
    const wasm = bootstrapWasm(wasmBytes());
    assert.throws(
      () => wasm.call("negate-decimal", [new Decimal(1n, -0)]),
      (err: unknown) => {
        assert.ok(err instanceof ValueError);
        assert.equal(err.code, "invalid-construction");
        assert.match(err.message, /outside the wasm profile/);
        return true;
      },
    );
  });

  it("propagates real native failures with original code and message", () => {
    const wasm = bootstrapWasm(wasmBytes());
    assert.throws(
      () => wasm.call("add-int", [9223372036854775807n, 1n]),
      (err: unknown) => {
        assert.ok(err instanceof ValueError);
        assert.equal(err.code, "overflow");
        return true;
      },
    );
  });
});
