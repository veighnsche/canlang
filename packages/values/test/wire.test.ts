import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CanValue, Violation } from "../../contracts/src/values.js";
import { Decimal } from "../src/decimal.js";
import { SchemaError, ValueError } from "../src/errors.js";
import { INT64_MAX, INT64_MIN } from "../src/int.js";
import {
  makeActionRef,
  makeDate,
  makeDatetime,
  makeDeliveryRef,
  makeFileValue,
  makeMemberRef,
  makeMoney,
  makeRecordRef,
  makeUnionValue,
  makeUserRef,
} from "../src/kinds.js";
import { decodeValue, encodeValue } from "../src/wire.js";

function assertValueError(fn: () => unknown, code = "invalid-construction"): ValueError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ValueError, `expected ValueError, got ${String(err)}`);
    assert.equal(err.code, code);
    return err;
  }
  assert.fail("expected ValueError, but nothing was thrown");
}

function assertSchemaError(fn: () => unknown): Violation[] {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof SchemaError, `expected SchemaError, got ${String(err)}`);
    assert.ok(!("code" in (err as object)), "SchemaError must not carry a business `code` field");
    assert.equal(err.name, "SchemaError");
    assert.equal(err.kind, "schema");
    assert.ok(Object.isFrozen(err.violations), "violations are frozen");
    for (const violation of err.violations) {
      assert.ok(Object.isFrozen(violation.path), "violation paths are frozen");
      assert.equal(typeof violation.code, "string");
      assert.equal(typeof violation.message, "string");
    }
    return [...err.violations];
  }
  assert.fail("expected SchemaError, but nothing was thrown");
}

function codesOf(violations: ReadonlyArray<Violation>): string[] {
  return violations.map((v) => `${JSON.stringify([...v.path])}:${JSON.stringify(v.code)}`);
}

describe("wire int", () => {
  it("round-trips canonical strings including >2^53", () => {
    const big = 9007199254740993n;
    assert.equal(decodeValue("int", "9007199254740993"), big);
    assert.equal(encodeValue("int", big), "9007199254740993");
    assert.equal(decodeValue("int", "0"), 0n);
    assert.equal(encodeValue("int", 0n), "0");
    assert.equal(decodeValue("int", "-42"), -42n);
    assert.equal(encodeValue("int", INT64_MAX), "9223372036854775807");
    assert.equal(encodeValue("int", INT64_MIN), "-9223372036854775808");
    assert.equal(decodeValue("int", "9223372036854775807"), INT64_MAX);
    assert.equal(decodeValue("int", "-9223372036854775808"), INT64_MIN);
  });

  it("normalizes leading zeros and negative zero on decode", () => {
    assert.equal(decodeValue("int", "007"), 7n);
    assert.equal(decodeValue("int", "-0"), 0n);
    assert.equal(encodeValue("int", decodeValue("int", "007") as bigint), "7");
  });

  it("rejects malformed wire with precise codes", () => {
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("int", 5))), ['[]:"type"']);
    for (const bad of ["5.0", "", "+5", " 5", "5 ", "0x5", "5n", "-", "1,000"]) {
      assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("int", bad))), ['[]:"format"'], bad);
    }
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("int", "9223372036854775808"))), ['[]:"bound"']);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("int", "-9223372036854775809"))), ['[]:"bound"']);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("int", null))), ['[]:"type"']);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("int", [1]))), ['[]:"type"']);
    const violations = assertSchemaError(() => decodeValue("int", "nope"));
    assert.equal(violations[0]?.expected, "canonical int64 decimal string");
  });

  it("rejects encode mismatches as caller errors", () => {
    assertValueError(() => encodeValue("int", "5" as unknown as CanValue));
    assertValueError(() => encodeValue("int", 2n ** 63n));
    assertValueError(() => encodeValue("int", null));
    assertValueError(() => encodeValue("nope(", 1n));
    assertValueError(() => decodeValue("nope(", "1"));
  });
});

describe("wire decimal", () => {
  it("decodes authored scale and encodes R2a normalized text", () => {
    const decoded = decodeValue("decimal", "1.50");
    assert.ok(decoded instanceof Decimal);
    assert.equal(decoded.coef, 150n);
    assert.equal(decoded.scale, 2);
    assert.equal(encodeValue("decimal", decoded), "1.5");
    assert.equal(encodeValue("decimal", decodeValue("decimal", "0.00") as Decimal), "0");
    assert.equal(encodeValue("decimal", decodeValue("decimal", "-0.00") as Decimal), "0");
    assert.equal(encodeValue("decimal", decodeValue("decimal", "123") as Decimal), "123");
    assert.equal(encodeValue("decimal", decodeValue("decimal", "-2.500") as Decimal), "-2.5");
    // Value-equal across scales: re-encoding after a round-trip is stable.
    const once = encodeValue("decimal", decodeValue("decimal", "1.50") as Decimal);
    assert.equal(encodeValue("decimal", decodeValue("decimal", once) as Decimal), once);
  });

  it("accepts the 38-digit bound and rejects beyond it", () => {
    assert.equal(encodeValue("decimal", decodeValue("decimal", "9".repeat(38)) as Decimal), "9".repeat(38));
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("decimal", "9".repeat(39)))), ['[]:"bound"']);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("decimal", `1.${"0".repeat(19)}1`))), ['[]:"bound"']);
  });

  it("rejects malformed decimal wire", () => {
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("decimal", 1.5))), ['[]:"type"']);
    for (const bad of ["1e3", "abc", "", "--1", "1.2.3", " 1.5"]) {
      assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("decimal", bad))), ['[]:"format"'], bad);
    }
    assertValueError(() => encodeValue("decimal", 5n));
  });
});

describe("wire money", () => {
  it("round-trips minor units plus currency", () => {
    const wire = { minor: "100", currency: "USD" };
    const decoded = decodeValue("money", wire);
    assert.deepEqual(decoded, makeMoney(100n, "USD"));
    assert.deepEqual(encodeValue("money", decoded), wire);
    const big = decodeValue("money", { minor: "9007199254740993", currency: "EUR" });
    assert.deepEqual(encodeValue("money", big), { minor: "9007199254740993", currency: "EUR" });
  });

  it("rejects malformed money wire with precise paths", () => {
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("money", {}))), [
      '["minor"]:"required"',
      '["currency"]:"required"',
    ]);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("money", { minor: "1" }))), [
      '["currency"]:"required"',
    ]);
    assert.deepEqual(
      codesOf(assertSchemaError(() => decodeValue("money", { minor: "1", currency: "USD", extra: 1 }))),
      ['["extra"]:"unknown-field"'],
    );
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("money", { minor: 5, currency: "USD" }))), [
      '["minor"]:"type"',
    ]);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("money", { minor: "1.5", currency: "USD" }))), [
      '["minor"]:"format"',
    ]);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("money", { minor: "1", currency: "XXX" }))), [
      '["currency"]:"format"',
    ]);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("money", { minor: "1", currency: "usd" }))), [
      '["currency"]:"format"',
    ]);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("money", { minor: "1", currency: 5 }))), [
      '["currency"]:"type"',
    ]);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("money", "USD"))), ['[]:"type"']);
  });

  it("rejects encode mismatches and unknown currencies", () => {
    assertValueError(() => encodeValue("money", makeMoney(100n, "XXX")));
    assertValueError(() => encodeValue("money", 5n));
    assertValueError(() => encodeValue("money", null));
  });
});

describe("wire duration", () => {
  it("round-trips integer milliseconds and rejects non-integers", () => {
    assert.equal(decodeValue("duration", "1500"), 1500n);
    assert.equal(decodeValue("duration", "-5"), -5n);
    assert.equal(encodeValue("duration", 1500n), "1500");
    for (const bad of ["1.5", "1500.0", "1s", "abc", ""]) {
      assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("duration", bad))), ['[]:"format"'], bad);
    }
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("duration", 5))), ['[]:"type"']);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("duration", "9223372036854775808"))), ['[]:"bound"']);
    assertValueError(() => encodeValue("duration", "5" as unknown as CanValue));
  });
});

describe("wire date", () => {
  it("round-trips civil dates", () => {
    assert.deepEqual(decodeValue("date", "2026-10-04"), makeDate(2026, 10, 4));
    assert.equal(encodeValue("date", makeDate(2024, 2, 29)), "2024-02-29");
    assert.equal(encodeValue("date", makeDate(1, 1, 1)), "0001-01-01");
    assert.equal(encodeValue("date", decodeValue("date", "9999-12-31") as CanValue), "9999-12-31");
  });

  it("rejects malformed dates", () => {
    for (const bad of ["2023-02-29", "2026-13-01", "2026-10-4", "2026-1-01", "0000-01-01", "2026-10-04T00:00:00Z", ""]) {
      assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("date", bad))), ['[]:"format"'], bad);
    }
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("date", 20261004))), ['[]:"type"']);
    assertValueError(() => encodeValue("date", "2026-10-04" as unknown as CanValue));
  });
});

describe("wire datetime", () => {
  it("round-trips the pinned UTC millis form", () => {
    for (const pinned of [
      "2026-10-04T12:34:56.789Z",
      "1970-01-01T00:00:00.000Z",
      "1960-06-15T08:30:00.250Z",
      "0001-01-01T00:00:00.000Z",
      "9999-12-31T23:59:59.999Z",
    ]) {
      assert.equal(encodeValue("datetime", decodeValue("datetime", pinned)), pinned, pinned);
    }
    assert.deepEqual(decodeValue("datetime", "1970-01-01T00:00:00.000Z"), makeDatetime(0n));
  });

  it("accepts exactly the pinned form", () => {
    for (const bad of [
      "2026-10-04T12:00:00Z",
      "2026-10-04T12:00:00.789+02:00",
      "2026-10-04T12:00:00.789z",
      "2026-10-04t12:00:00.789Z",
      "2026-10-04T12:00:00.7890Z",
      "2026-10-04T12:00:00.78Z",
      "2026-10-04 12:00:00.789Z",
      "2023-02-29T00:00:00.000Z",
      "0000-01-01T00:00:00.000Z",
      "2026-10-04T24:00:00.000Z",
      "2026-10-04T12:00:60.000Z",
      "",
    ]) {
      assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("datetime", bad))), ['[]:"format"'], bad);
    }
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("datetime", 0))), ['[]:"type"']);
    assertValueError(() => encodeValue("datetime", makeDatetime(253402300800000n)));
  });
});

describe("wire text and bool", () => {
  it("passes scalars through and enforces their JSON types", () => {
    assert.equal(decodeValue("text", "hello"), "hello");
    assert.equal(decodeValue("text", ""), "");
    assert.equal(encodeValue("text", "hello"), "hello");
    assert.equal(decodeValue("bool", true), true);
    assert.equal(encodeValue("bool", false), false);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("text", 5))), ['[]:"type"']);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("bool", "true"))), ['[]:"type"']);
    assertValueError(() => encodeValue("text", 5 as unknown as CanValue));
    assertValueError(() => encodeValue("bool", 1 as unknown as CanValue));
  });

  it("handles nullability", () => {
    assert.equal(decodeValue("text?", null), null);
    assert.equal(encodeValue("text?", null), null);
    assert.equal(decodeValue("text?", "x"), "x");
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("text", null))), ['[]:"type"']);
    assertValueError(() => encodeValue("text", null));
  });
});

describe("wire validated string-likes", () => {
  it("accepts email/url as plain strings with no invented format", () => {
    // Recorded decision: email/url carry no format grammar at this layer.
    for (const text of ["", "not-an-email", "notaurl", "a@b", "http://x", "x".repeat(500)]) {
      assert.equal(decodeValue("email", text), text, text);
      assert.equal(decodeValue("url", text), text, text);
      assert.equal(encodeValue("email", text), text, text);
      assert.equal(encodeValue("url", text), text, text);
    }
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("email", 5))), ['[]:"type"']);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("url", null))), ['[]:"type"']);
  });

  it("validates and canonicalizes locales", () => {
    assert.equal(decodeValue("locale", "en-US"), "en-US");
    assert.equal(decodeValue("locale", "en-us"), "en-US");
    assert.equal(encodeValue("locale", "en-us"), "en-US");
    assert.equal(encodeValue("locale", "nl"), "nl");
    for (const bad of ["en_us", "", "e", "en-", "x-!"]) {
      assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("locale", bad))), ['[]:"format"'], bad);
    }
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("locale", 5))), ['[]:"type"']);
    assertValueError(() => encodeValue("locale", "en_us"));
  });

  it("validates timezones by pinned-zone membership", () => {
    for (const zone of ["UTC", "America/New_York", "Europe/Paris", "Pacific/Auckland"]) {
      assert.equal(decodeValue("timezone", zone), zone, zone);
      assert.equal(encodeValue("timezone", zone), zone, zone);
    }
    for (const bad of ["Mars/Olympus", "", "Not/AZone", "UTC+2"]) {
      assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("timezone", bad))), ['[]:"format"'], bad);
    }
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("timezone", 5))), ['[]:"type"']);
    assertValueError(() => encodeValue("timezone", "Mars/Olympus"));
  });

  it("validates currencies by pinned ISO table membership", () => {
    assert.equal(decodeValue("currency", "USD"), "USD");
    assert.equal(encodeValue("currency", "EUR"), "EUR");
    for (const bad of ["XXX", "usd", "", "US", "USDD", "123"]) {
      assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("currency", bad))), ['[]:"format"'], bad);
    }
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("currency", 5))), ['[]:"type"']);
    assertValueError(() => encodeValue("currency", "XXX"));
  });
});

describe("wire user, member and file", () => {
  it("round-trips user refs", () => {
    assert.deepEqual(decodeValue("user", { id: "u1" }), makeUserRef("u1"));
    assert.deepEqual(encodeValue("user", makeUserRef("u1")), { id: "u1" });
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("user", {}))), ['["id"]:"required"']);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("user", { id: "" }))), ['["id"]:"format"']);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("user", { id: 5 }))), ['["id"]:"type"']);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("user", { id: "u", v: "1" }))), [
      '["v"]:"unknown-field"',
    ]);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("user", "u1"))), ['[]:"type"']);
    assertValueError(() => encodeValue("user", makeFileValue("f") as unknown as CanValue));
  });

  it("round-trips member refs losslessly", () => {
    const wire = { id: "m1", user: { id: "u1" }, team: "t1" };
    const decoded = decodeValue("member", wire);
    assert.deepEqual(decoded, makeMemberRef("m1", makeUserRef("u1"), "t1"));
    assert.deepEqual(encodeValue("member", decoded), wire);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("member", { id: "m", user: {}, team: "t" }))), [
      '["user","id"]:"required"',
    ]);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("member", { id: "m", user: { id: "" }, team: "t" }))), [
      '["user","id"]:"format"',
    ]);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("member", { id: "m", user: { id: "u" } }))), [
      '["team"]:"required"',
    ]);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("member", { id: "m", user: { id: "u" }, team: "" }))), [
      '["team"]:"format"',
    ]);
    assert.deepEqual(
      codesOf(assertSchemaError(() => decodeValue("member", { id: "m", user: { id: "u", x: 1 }, team: "t" }))),
      ['["user","x"]:"unknown-field"'],
    );
    assertValueError(() => encodeValue("member", makeUserRef("u") as unknown as CanValue));
  });

  it("round-trips file values", () => {
    assert.deepEqual(decodeValue("file", { id: "f1" }), makeFileValue("f1"));
    assert.deepEqual(encodeValue("file", makeFileValue("f1")), { id: "f1" });
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("file", { id: "" }))), ['["id"]:"format"']);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("file", {}))), ['["id"]:"required"']);
  });
});

describe("wire secret", () => {
  it("refuses every encode and every decode", () => {
    assertValueError(() => encodeValue("secret", { kind: "secret" } as unknown as CanValue));
    for (const wire of ["x", {}, [], 5, true]) {
      const violations = assertSchemaError(() => decodeValue("secret", wire));
      assert.equal(violations[0]?.code, "type");
      assert.equal(violations[0]?.expected, "no wire form (secrets are never serialized)");
    }
    // Null hits the non-nullability check first; still a type violation.
    const nullViolations = assertSchemaError(() => decodeValue("secret", null));
    assert.equal(nullViolations[0]?.code, "type");
    assert.equal(decodeValue("secret?", null), null);
    assertSchemaError(() => decodeValue("secret?", "x"));
  });
});

describe("wire delivery", () => {
  it("round-trips bare and pinned deliveries", () => {
    const wire = { id: "d1", operation: "send" };
    assert.deepEqual(decodeValue("delivery", wire), makeDeliveryRef("d1", "send"));
    assert.deepEqual(encodeValue("delivery", makeDeliveryRef("d1", "send")), wire);
    assert.deepEqual(decodeValue("delivery(send)", wire), makeDeliveryRef("d1", "send"));
    assert.deepEqual(encodeValue("delivery(send)", makeDeliveryRef("d1", "send")), wire);
  });

  it("rejects malformed and misbound deliveries", () => {
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("delivery", { id: "d" }))), [
      '["operation"]:"required"',
    ]);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("delivery", { id: "", operation: "s" }))), [
      '["id"]:"format"',
    ]);
    assert.deepEqual(
      codesOf(assertSchemaError(() => decodeValue("delivery(send)", { id: "d", operation: "other" }))),
      ['["operation"]:"format"'],
    );
    assert.deepEqual(
      codesOf(assertSchemaError(() => decodeValue("delivery", { id: "d", operation: "s", x: 1 }))),
      ['["x"]:"unknown-field"'],
    );
    assertValueError(() => encodeValue("delivery(send)", makeDeliveryRef("d", "other") as unknown as CanValue));
  });
});

describe("wire action", () => {
  const wire = { target: "inspect", bindings: { inspection: { id: "r1", version: "3" } } };

  it("round-trips references with versioned bindings", () => {
    const decoded = decodeValue("action", wire);
    assert.deepEqual(decoded, makeActionRef("inspect", { inspection: makeRecordRef("inspection", "r1", 3n) }));
    assert.deepEqual(encodeValue("action", decoded), wire);
    assert.deepEqual(decodeValue("action(inspect,close)", wire), decoded);
    assert.deepEqual(encodeValue("action(inspect)", decoded), wire);
    // The binding model is the binding name: the pinned wire has no model
    // slot, and the parameter->model mapping is registry knowledge.
    const ref = (decoded as unknown as { bindings: { inspection: { model: string } } }).bindings.inspection;
    assert.equal(ref.model, "inspection");
    const empty = decodeValue("action", { target: "ping", bindings: {} });
    assert.deepEqual(encodeValue("action", empty), { target: "ping", bindings: {} });
  });

  it("requires a version on every binding", () => {
    assert.deepEqual(
      codesOf(assertSchemaError(() => decodeValue("action", { target: "t", bindings: { p: { id: "r" } } }))),
      ['["bindings","p","version"]:"required"'],
    );
    assert.deepEqual(
      codesOf(assertSchemaError(() => decodeValue("action", { target: "t", bindings: { p: { id: "r", version: "x" } } }))),
      ['["bindings","p","version"]:"format"'],
    );
    assert.deepEqual(
      codesOf(assertSchemaError(() => decodeValue("action", { target: "t", bindings: { p: { version: "1" } } }))),
      ['["bindings","p","id"]:"required"'],
    );
    assert.deepEqual(
      codesOf(assertSchemaError(() => decodeValue("action", { target: "t", bindings: { p: { id: "r", version: "1", z: 0 } } }))),
      ['["bindings","p","z"]:"unknown-field"'],
    );
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("action", { target: "t", bindings: [] }))), [
      '["bindings"]:"type"',
    ]);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("action(inspect)", { target: "other", bindings: {} }))), [
      '["target"]:"format"',
    ]);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("action", { target: "t" }))), [
      '["bindings"]:"required"',
    ]);
  });

  it("rejects encode mismatches and versionless bindings", () => {
    assertValueError(() => encodeValue("action", makeActionRef("t", { p: makeRecordRef("M", "r") })));
    assertValueError(() => encodeValue("action(inspect)", makeActionRef("other", {})));
    assertValueError(() => encodeValue("action", makeUserRef("u")));
  });

  it("rejects __proto__ binding names but keeps other dunder names", () => {
    const bad = JSON.parse('{"target":"t","bindings":{"__proto__":{"id":"r","version":"1"}}}');
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("action", bad))), [
      '["bindings","__proto__"]:"unknown-field"',
    ]);
    const ok = decodeValue("action", { target: "t", bindings: { constructor: { id: "r", version: "1" } } });
    assert.deepEqual(ok, makeActionRef("t", { constructor: makeRecordRef("constructor", "r", 1n) }));
  });

  it("rejects __proto__ bindings on encode but keeps other dunder names", () => {
    const bindings = JSON.parse('{"__proto__":{"kind":"ref","model":"M","id":"r"}}') as Record<string, unknown>;
    (bindings["__proto__"] as { version: unknown }).version = 1n;
    const err = assertValueError(() =>
      encodeValue("action", { kind: "action", target: "t", bindings } as never),
    );
    assert.match(err.message, /action binding name "__proto__" is reserved/);
    assert.deepEqual(
      encodeValue("action", makeActionRef("t", { constructor: makeRecordRef("M", "r", 1n) })),
      { target: "t", bindings: { constructor: { id: "r", version: "1" } } },
    );
  });
});

describe("wire inline enum", () => {
  it("passes declared cases and rejects the rest", () => {
    assert.equal(decodeValue("enum(open,closed)", "open"), "open");
    assert.equal(encodeValue("enum(open,closed)", "closed"), "closed");
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("enum(open,closed)", "done"))), ['[]:"format"']);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("enum(open,closed)", 5))), ['[]:"type"']);
    assert.equal(decodeValue("enum(a)?", null), null);
    assertValueError(() => encodeValue("enum(open,closed)", "done"));
  });
});

describe("wire nominal model refs", () => {
  it("accepts read and mutation shapes and preserves versions", () => {
    assert.deepEqual(decodeValue("Todo", { id: "t1" }), makeRecordRef("Todo", "t1"));
    assert.deepEqual(decodeValue("Todo", { id: "t1", version: "4" }), makeRecordRef("Todo", "t1", 4n));
    assert.deepEqual(encodeValue("Todo", makeRecordRef("Todo", "t1")), { id: "t1" });
    assert.deepEqual(encodeValue("Todo", makeRecordRef("Todo", "t1", 4n)), { id: "t1", version: "4" });
    assert.deepEqual(decodeValue("pkg.Todo", { id: "t", version: "007" }), makeRecordRef("pkg.Todo", "t", 7n));
    const big = decodeValue("Todo", { id: "t", version: "9007199254740993" });
    assert.deepEqual(encodeValue("Todo", big), { id: "t", version: "9007199254740993" });
  });

  it("rejects malformed refs", () => {
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("Todo", { id: "" }))), ['["id"]:"format"']);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("Todo", { id: 5 }))), ['["id"]:"type"']);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("Todo", { id: "t", version: "x" }))), [
      '["version"]:"format"',
    ]);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("Todo", { id: "t", version: 5 }))), [
      '["version"]:"type"',
    ]);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("Todo", { id: "t", x: 1 }))), [
      '["x"]:"unknown-field"',
    ]);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("Todo", true))), ['[]:"type"']);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("Todo", [{ id: "t" }]))), ['[]:"type"']);
    assertValueError(() => encodeValue("Todo", makeRecordRef("Other", "t")));
    assertValueError(() => encodeValue("Todo", 5n));
  });

  it("passes strings through on the named-enum path (membership needs schema)", () => {
    assert.equal(decodeValue("Status", "open"), "open");
    assert.equal(encodeValue("Status", "open"), "open");
  });
});

describe("wire nominal contract dynamics", () => {
  it("round-trips JSON-native structures", () => {
    const wire = { street: "Main", prior: ["x", "y"], meta: { k: "v", n: null }, nothing: null };
    const decoded = decodeValue("Address", wire);
    assert.deepEqual(decoded, wire);
    assert.deepEqual(encodeValue("Address", decoded), wire);
  });

  it("encodes exact scalars by runtime kind", () => {
    const value = {
      count: 5n,
      price: new Decimal(150n, 2),
      amount: makeMoney(100n, "USD"),
      day: makeDate(2026, 10, 4),
      owner: makeRecordRef("Todo", "t", 2n),
      tags: ["a"],
    };
    assert.deepEqual(encodeValue("Address", value), {
      count: "5",
      price: "1.5",
      amount: { minor: "100", currency: "USD" },
      day: "2026-10-04",
      owner: { id: "t", version: "2" },
      tags: ["a"],
    });
  });

  it("rejects numbers and reroutes id-carrying objects to ref decoding", () => {
    // Numbers never appear on the wire; exact-scalar contract leaves need
    // schema.validateValue with field types.
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("Address", { count: 5 }))), ['["count"]:"type"']);
    // A nominal object carrying `id` is ref-shaped: schema validation must
    // resolve contracts that declare their own id field.
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("Address", { id: "x", city: "Y" }))), [
      '["city"]:"unknown-field"',
    ]);
    assertValueError(() => encodeValue("Address", { kind: "money", minor: "x", currency: "USD" } as never));
    assertValueError(() => encodeValue("Address", { s: { kind: "secret" } } as never));
  });

  it("rejects __proto__ keys at any depth but keeps other dunder names", () => {
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("Address", JSON.parse('{"__proto__":"x"}')))), [
      '["__proto__"]:"unknown-field"',
    ]);
    assert.deepEqual(
      codesOf(assertSchemaError(() => decodeValue("Address", JSON.parse('{"a":{"__proto__":"x"}}')))),
      ['["a","__proto__"]:"unknown-field"'],
    );
    assert.deepEqual(decodeValue("Address", { constructor: "x" }), { constructor: "x" });
  });

  it("rejects __proto__ keys on encode at any depth but keeps other dunder names", () => {
    const top = assertValueError(() => encodeValue("Address", JSON.parse('{"__proto__":"x"}')));
    assert.match(top.message, /contract field name "__proto__" is reserved/);
    const nested = assertValueError(() => encodeValue("Address", JSON.parse('{"a":{"__proto__":"x"}}')));
    assert.match(nested.message, /contract field name "__proto__" is reserved/);
    assert.deepEqual(encodeValue("Address", { constructor: "x" }), { constructor: "x" });
  });

  it("treats undefined object values as absent but rejects undefined array elements", () => {
    assert.deepEqual(decodeValue("Address", { a: undefined, b: "x" }), { b: "x" });
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("Address", { a: [undefined] }))), [
      '["a",0]:"type"',
    ]);
  });

  it("rejects message descriptors (no wire form) and still rejects secrets", () => {
    const err = assertValueError(() => encodeValue("Address", { kind: "message" } as never));
    assert.match(err.message, /message descriptors have no wire form/);
    assertValueError(() => encodeValue("Address", { wrap: { kind: "message", text: "hi" } } as never));
    assertValueError(() => encodeValue("Address", { kind: "secret" } as never));
  });
});

describe("wire unions", () => {
  it("round-trips discriminated values per arm", () => {
    const wire = { type: "Todo", value: { id: "t", version: "2" } };
    const decoded = decodeValue("Todo|Note", wire);
    assert.deepEqual(decoded, makeUnionValue("Todo", makeRecordRef("Todo", "t", 2n)));
    assert.deepEqual(encodeValue("Todo|Note", decoded), wire);
    const userArm = { type: "user", value: { id: "u" } };
    assert.deepEqual(decodeValue("user|Todo", userArm), makeUnionValue("user", makeUserRef("u")));
    assert.deepEqual(encodeValue("user|Todo", makeUnionValue("user", makeUserRef("u"))), userArm);
  });

  it("rejects malformed unions with nested paths", () => {
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("Todo|Note", { type: "Other", value: {} }))), [
      '["type"]:"type"',
    ]);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("Todo|Note", { type: "Todo" }))), [
      '["value"]:"required"',
    ]);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("Todo|Note", { type: "Todo", value: {}, x: 1 }))), [
      '["x"]:"unknown-field"',
    ]);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("Todo|Note", { type: "Todo", value: { id: "" } }))), [
      '["value","id"]:"format"',
    ]);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("Todo|Note", []))), ['[]:"type"']);
    assertValueError(() => encodeValue("Todo|Note", makeUnionValue("Other", makeUserRef("u"))));
    assertValueError(() => encodeValue("Todo|Note", makeUserRef("u")));
  });
});

describe("wire arrays", () => {
  it("round-trips homogeneous arrays with indexed violations", () => {
    assert.deepEqual(decodeValue("int[]", ["1", "2"]), [1n, 2n]);
    assert.deepEqual(decodeValue("int[]", []), []);
    assert.deepEqual(encodeValue("int[]", [1n, 2n]), ["1", "2"]);
    assert.deepEqual(decodeValue("int[]!", ["1"]), [1n]);
    assert.deepEqual(encodeValue("int[]!", [1n]), ["1"]);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("int[]", ["1", "x", "y"]))), [
      '[1]:"format"',
      '[2]:"format"',
    ]);
  });

  it("rejects non-arrays and nullable elements", () => {
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("int[]", "1"))), ['[]:"type"']);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("int[]", ["1", null]))), ['[1]:"type"']);
    assert.deepEqual(codesOf(assertSchemaError(() => decodeValue("int[]", null))), ['[]:"type"']);
    assert.deepEqual(decodeValue("int[]?", null), null);
    assertValueError(() => encodeValue("int[]", 5n));
  });
});

describe("wire output shape", () => {
  it("freezes decoded values and encoded wire", () => {
    const decoded = decodeValue("Todo[]", [{ id: "t" }]);
    assert.ok(Object.isFrozen(decoded));
    assert.ok(Object.isFrozen((decoded as unknown[])[0]));
    const encoded = encodeValue("Todo[]", [makeRecordRef("Todo", "t")]);
    assert.ok(Object.isFrozen(encoded));
    assert.ok(Object.isFrozen((encoded as unknown[])[0]));
    const contract = decodeValue("Address", { tags: ["a"] });
    assert.ok(Object.isFrozen(contract));
    const dynamic = encodeValue("Address", { tags: ["a"] });
    assert.ok(Object.isFrozen(dynamic));
  });

  it("accumulates several violations in one SchemaError", () => {
    const violations = assertSchemaError(() => decodeValue("money", { minor: "x", currency: "XXX" }));
    assert.equal(violations.length, 2);
    assert.deepEqual(codesOf(violations), ['["minor"]:"format"', '["currency"]:"format"']);
    for (const violation of violations) {
      assert.ok(violation.expected !== undefined && violation.expected.length > 0);
      assert.ok(violation.actual !== undefined);
    }
  });
});
