// Selected int/ASCII producer checks: genuine native decode/encode at the
// owning codec entry with exact ordered SchemaError projection, TS-side
// admission before tag/JSON allocation, and full-domain TS dispatch outside
// ASCII. The backend is installed per-test via hooks (never at definition
// time); a counting wrapper proves native entry where claimed.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SchemaError, ValueError } from "../src/errors.js";
import { decodeValue } from "../src/wire.js";
import {
  SELECTED_INT_TEXT_MAX_BYTES,
  decodeSelectedInt,
  encodeSelectedInt,
  selectSelectedIntBackend,
  type ExactBackend,
} from "../bindings/backend.js";
import { bootstrapWasm } from "../bindings/bootstrap.js";

const here = dirname(fileURLToPath(import.meta.url));
const wasmBytes = () =>
  new Uint8Array(
    readFileSync(join(here, "..", "bindings", "generated", "values_semantics_bg.wasm")),
  );

const RANGE = "int in [-9223372036854775808, 9223372036854775807]";
const CANON = "canonical int64 decimal string";

function violationOf(error: unknown) {
  assert.ok(error instanceof SchemaError);
  assert.equal(error.violations.length, 1);
  return error.violations[0]!;
}

/** Installs a call-counting native backend; returns its counter. */
function installCounting(inner: ExactBackend): () => number {
  let calls = 0;
  selectSelectedIntBackend({
    name: "wasm",
    call: (op: string, args: unknown[]) => {
      calls += 1;
      return inner.call(op, args);
    },
  });
  return () => calls;
}

describe("selected int entry without opt-in keeps the TS default", () => {
  beforeEach(() => selectSelectedIntBackend(null));
  afterEach(() => selectSelectedIntBackend(null));

  it("decodes/encodes through the full-domain route with no backend", () => {
    assert.equal(decodeSelectedInt("0042"), 42n);
    assert.equal(encodeSelectedInt(42n), "42");
    assert.throws(() => decodeSelectedInt("12a"), (e) => violationOf(e).code === "format");
  });
});

describe("selected int native producer at explicit opt-in", () => {
  const backend = bootstrapWasm(wasmBytes());
  let nativeCalls = () => 0;
  beforeEach(() => {
    nativeCalls = installCounting(backend);
  });
  afterEach(() => selectSelectedIntBackend(null));

  it("decodes extremes and normalizes leading zeros and -0 natively", () => {
    assert.equal(decodeSelectedInt("-9223372036854775808"), -(2n ** 63n));
    assert.equal(decodeSelectedInt("9223372036854775807"), 2n ** 63n - 1n);
    assert.equal(decodeSelectedInt("00042"), 42n);
    assert.equal(decodeSelectedInt("-0"), 0n);
    assert.equal(decodeSelectedInt("0009223372036854775807"), 2n ** 63n - 1n);
    assert.equal(encodeSelectedInt(42n), "42");
    assert.equal(encodeSelectedInt(0n), "0");
    assert.equal(encodeSelectedInt(-(2n ** 63n)), "-9223372036854775808");
    assert.ok(nativeCalls() >= 8, `native calls: ${nativeCalls()}`);
  });

  it("decodes max-bound leading zeros natively without bigint strain", () => {
    assert.equal(decodeSelectedInt("0".repeat(SELECTED_INT_TEXT_MAX_BYTES)), 0n);
    assert.equal(nativeCalls(), 1);
  });

  it("projects malformed text as ordered format violations natively", () => {
    for (const wire of ["", "12a", "+", "--1", " 1", "1 ", "\u0001"]) {
      assert.throws(() => decodeSelectedInt(wire), (e) => {
        const v = violationOf(e);
        assert.deepEqual(v, {
          path: [],
          code: "format",
          message: "int is malformed",
          expected: CANON,
          actual: JSON.stringify(wire),
        });
        return true;
      }, wire);
    }
    assert.ok(nativeCalls() >= 7, `native calls: ${nativeCalls()}`);
  });

  it("projects out-of-range digits as bound violations with truncated actual natively", () => {
    const big = `!${"9".repeat(100)}`;
    assert.throws(() => decodeSelectedInt("9223372036854775808"), (e) => {
      const v = violationOf(e);
      assert.deepEqual(v, {
        path: [],
        code: "bound",
        message: "int is out of range",
        expected: RANGE,
        actual: JSON.stringify("9223372036854775808"),
      });
      return true;
    });
    assert.throws(() => decodeSelectedInt(big), (e) => {
      const v = violationOf(e);
      assert.equal(v.code, "format");
      assert.equal(v.actual, `${JSON.stringify(big).slice(0, 64)}...`);
      return true;
    });
    assert.throws(() => decodeSelectedInt("-9223372036854775809"), (e) => violationOf(e).code === "bound");
    assert.ok(nativeCalls() >= 3, `native calls: ${nativeCalls()}`);
  });

  it("admits exactly the 1MiB bound and refuses above it before native entry", () => {
    const atBound = "9".repeat(SELECTED_INT_TEXT_MAX_BYTES);
    assert.throws(() => decodeSelectedInt(atBound), (e) => violationOf(e).code === "bound");
    const over = `9`.repeat(SELECTED_INT_TEXT_MAX_BYTES + 1);
    const before = nativeCalls();
    assert.throws(() => decodeSelectedInt(over), (e) => {
      const v = violationOf(e);
      assert.deepEqual([v.code, v.message, v.expected], ["bound", "int is out of range", RANGE]);
      // Bounded diagnostic equals the whole-string slice exactly, with
      // no whole oversized stringify on the implementation path.
      assert.equal(v.actual, `${JSON.stringify(over).slice(0, 64)}...`);
      return true;
    });
    assert.equal(nativeCalls(), before, "only the admitted call reaches native");
  });

  it("cuts the bounded diagnostic exactly at escape boundaries", () => {
    // 60 plain units then a 6-unit escape straddling unit 64: the cut
    // keeps a partial escape exactly like slice(0, 64).
    const wire = `${"A".repeat(60)}\u0001${"9".repeat(100)}`;
    const before = nativeCalls();
    assert.throws(() => decodeSelectedInt(wire), (e) => {
      const v = violationOf(e);
      assert.equal(v.code, "format");
      assert.equal(v.actual, `${JSON.stringify(wire).slice(0, 64)}...`);
      return true;
    });
    assert.equal(nativeCalls(), before + 1, "admitted text reaches native");
  });

  it("keeps non-ASCII wire on the full-domain TS route before native entry", () => {
    const breaking: ExactBackend = {
      name: "wasm",
      call: () => { throw new Error("native entered"); },
    };
    selectSelectedIntBackend(breaking);
    try {
      assert.throws(() => decodeSelectedInt("12é"), (e) => violationOf(e).code === "format");
      assert.throws(() => decodeSelectedInt("１２３"), (e) => violationOf(e).code === "format");
    } finally {
      selectSelectedIntBackend(null);
    }
  });

  it("refuses out-of-range bigint encode before tag/native work", () => {
    assert.throws(() => encodeSelectedInt(2n ** 63n), (e) => {
      assert.ok(e instanceof ValueError);
      assert.equal(e.code, "invalid-construction");
      assert.equal(e.message, "int out of 64-bit range: 9223372036854775808 at $");
      return true;
    });
    const huge = 10n ** 30n;
    const before = nativeCalls();
    assert.throws(() => encodeSelectedInt(huge), (e) => {
      assert.ok(e instanceof ValueError);
      assert.equal(e.message, "int out of 64-bit range: bigint exceeds 26 digits at $");
      return true;
    });
    assert.equal(nativeCalls(), before, "no native call for refused encode");
  });

  it("matches legacy TS errors field-for-field on shared cases", () => {
    for (const wire of ["12a", "9223372036854775808", ""]) {
      const legacy = (() => { try { decodeValue("int", wire); return null; } catch (e) { return violationOf(e); } })();
      const native = (() => { try { decodeSelectedInt(wire); return null; } catch (e) { return violationOf(e); } })();
      assert.deepEqual(native, legacy, wire);
    }
    assert.ok(nativeCalls() >= 3, `native calls: ${nativeCalls()}`);
  });

  it("propagates native transport faults without retry or fallback", () => {
    const huge = "9".repeat(7_000_000);
    const before = nativeCalls();
    assert.throws(() => backend.call("decode-value", ["int", huge]), (e) => {
      assert.ok(e instanceof ValueError);
      assert.match(e.message, /native transport fault/);
      return true;
    });
    assert.equal(nativeCalls(), before, "direct backend call bypasses the entry");
    assert.throws(() => encodeSelectedInt(42 as unknown as bigint), ValueError);
  });
});
