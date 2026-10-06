import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CanValue, SecretValue } from "@canlang/contracts/values";
import { Decimal } from "../src/decimal.js";
import { equalValue, same } from "../src/equality.js";
import { ValueError } from "../src/errors.js";
import {
  makeActionRef,
  makeDate,
  makeDatetime,
  makeDeliveryRef,
  makeFileValue,
  makeInvocation,
  makeMemberRef,
  makeMoney,
  makeRecordRef,
  makeUnionValue,
  makeUserRef,
} from "../src/kinds.js";

function assertValueError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ValueError, `expected ValueError, got ${String(err)}`);
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected ValueError(${code}), but nothing was thrown`);
}

describe("equalValue null rules (DESIGN L159)", () => {
  it("null equals null under nullable, array, and plain type ids", () => {
    assert.equal(equalValue("int?", null, null), true);
    assert.equal(equalValue("text?[]", null, null), true);
    assert.equal(equalValue("int", null, null), true);
  });

  it("null vs value is false, never an error", () => {
    assert.equal(equalValue("int?", null, 1n), false);
    assert.equal(equalValue("int?", 1n, null), false);
    assert.equal(equalValue("int[]", null, []), false);
    assert.equal(equalValue("int", null, 1n), false);
  });
});

describe("equalValue scalars", () => {
  it("compares bigints by ===", () => {
    assert.equal(equalValue("int", 1n, 1n), true);
    assert.equal(equalValue("int", 1n, 2n), false);
    assert.equal(equalValue("duration", 5n, 5n), true);
  });

  it("compares strings by ===", () => {
    assert.equal(equalValue("text", "a", "a"), true);
    assert.equal(equalValue("text", "a", "A"), false);
    assert.equal(equalValue("text", "", ""), true);
  });

  it("compares booleans by ===", () => {
    assert.equal(equalValue("bool", true, true), true);
    assert.equal(equalValue("bool", true, false), false);
  });

  it("compares decimals by value across scales (R3)", () => {
    assert.equal(equalValue("decimal", new Decimal(10n, 1), new Decimal(100n, 2)), true);
    assert.equal(equalValue("decimal", new Decimal(15n, 1), new Decimal(150n, 2)), true);
    assert.equal(equalValue("decimal", new Decimal(0n, 0), new Decimal(0n, 5)), true);
    assert.equal(equalValue("decimal", new Decimal(10n, 1), new Decimal(15n, 1)), false);
  });

  it("promotes int/decimal mixes exactly (DESIGN L209)", () => {
    assert.equal(equalValue("decimal", 1n, new Decimal(100n, 2)), true);
    assert.equal(equalValue("decimal", new Decimal(100n, 2), 1n), true);
    assert.equal(equalValue("decimal", 2n, new Decimal(100n, 2)), false);
  });

  it("rejects mismatched scalar kinds", () => {
    assertValueError(() => equalValue("int", 1n, "1"), "invalid-construction");
    assertValueError(() => equalValue("text", "a", true), "invalid-construction");
    assertValueError(() => equalValue("bool", true, 1n), "invalid-construction");
    assertValueError(() => equalValue("decimal", new Decimal(10n, 1), "1.0"), "invalid-construction");
  });
});

describe("equalValue money/date/datetime", () => {
  it("decides money equality across currencies (R2c)", () => {
    assert.equal(equalValue("money", makeMoney(100n, "EUR"), makeMoney(100n, "EUR")), true);
    assert.equal(equalValue("money", makeMoney(100n, "EUR"), makeMoney(200n, "EUR")), false);
    assert.equal(equalValue("money", makeMoney(100n, "EUR"), makeMoney(100n, "USD")), false);
  });

  it("rejects money vs non-money", () => {
    assertValueError(() => equalValue("money", makeMoney(100n, "EUR"), 100n), "invalid-construction");
    assertValueError(
      () => equalValue("money", makeMoney(100n, "EUR"), new Decimal(100n, 0)),
      "invalid-construction",
    );
  });

  it("compares dates by civil value", () => {
    assert.equal(equalValue("date", makeDate(2024, 2, 29), makeDate(2024, 2, 29)), true);
    assert.equal(equalValue("date", makeDate(2024, 2, 29), makeDate(2024, 2, 28)), false);
    assertValueError(() => equalValue("date", makeDate(2024, 1, 1), makeDatetime(0n)), "invalid-construction");
    assertValueError(() => equalValue("date", makeDate(2024, 1, 1), "2024-01-01"), "invalid-construction");
  });

  it("compares datetimes by instant", () => {
    assert.equal(equalValue("datetime", makeDatetime(1000n), makeDatetime(1000n)), true);
    assert.equal(equalValue("datetime", makeDatetime(1000n), makeDatetime(1001n)), false);
    assertValueError(() => equalValue("datetime", makeDatetime(0n), 0n), "invalid-construction");
  });
});

describe("equalValue arrays", () => {
  it("compares ordered elementwise with duplicates significant", () => {
    assert.equal(equalValue("int[]", [1n, 2n], [1n, 2n]), true);
    assert.equal(equalValue("int[]", [1n, 2n], [2n, 1n]), false);
    assert.equal(equalValue("int[]", [1n, 2n], [1n]), false);
    assert.equal(equalValue("int[]", [1n, 1n], [1n, 1n]), true);
    assert.equal(equalValue("int[]", [1n, 1n], [1n]), false);
    assert.equal(equalValue("int[]", [], []), true);
  });

  it("recurses into nested arrays", () => {
    assert.equal(
      equalValue("int[][]", [[1n], [2n, 3n]], [[1n], [2n, 3n]]),
      true,
    );
    assert.equal(
      equalValue("int[][]", [[1n], [2n, 3n]], [[1n], [3n, 2n]]),
      false,
    );
  });

  it("handles nullable elements under a nullable-element id", () => {
    assert.equal(equalValue("int?[]", [1n, null], [1n, null]), true);
    assert.equal(equalValue("int?[]", [1n, null], [1n, 2n]), false);
  });

  it("rejects non-array values under an array id", () => {
    assertValueError(() => equalValue("int[]", 1n, [1n]), "invalid-construction");
    assertValueError(() => equalValue("int[]", [1n], 1n), "invalid-construction");
    assert.equal(equalValue("int[]", [1n], null), false);
  });

  it("compares arrays structurally when the id carries no suffix", () => {
    assert.equal(equalValue("int", [1n], [1n]), true);
    assert.equal(equalValue("int", [1n], [2n]), false);
    assertValueError(() => equalValue("int", [1n], 1n), "invalid-construction");
  });
});

describe("equalValue contracts", () => {
  it("compares fieldwise with key sets significant", () => {
    assert.equal(equalValue("c", { a: 1n, b: "x" }, { a: 1n, b: "x" }), true);
    assert.equal(equalValue("c", { a: 1n }, { a: 2n }), false);
    assert.equal(equalValue("c", { a: 1n }, {}), false);
    assert.equal(equalValue("c", { a: 1n }, { a: 1n, b: 2n }), false);
  });

  it("treats field order as irrelevant", () => {
    assert.equal(equalValue("c", { a: 1n, b: 2n }, { b: 2n, a: 1n }), true);
  });

  it("treats missing-vs-undefined as unequal, present-undefined as malformed", () => {
    const withUndefined = { a: undefined as unknown as CanValue };
    assert.equal(equalValue("c", { a: 1n }, {}), false);
    assert.equal(equalValue("c", withUndefined, {}), false);
    assertValueError(() => equalValue("c", withUndefined, withUndefined), "invalid-construction");
  });

  it("recurses into nested contracts and arrays", () => {
    assert.equal(equalValue("c", { pts: [{ x: 1n }] }, { pts: [{ x: 1n }] }), true);
    assert.equal(equalValue("c", { pts: [{ x: 1n }] }, { pts: [{ x: 2n }] }), false);
  });

  it("rejects contract vs non-contract", () => {
    assertValueError(() => equalValue("c", { a: 1n }, 1n), "invalid-construction");
    assertValueError(() => equalValue("c", { a: 1n }, [1n]), "invalid-construction");
  });
});

describe("equalValue unions", () => {
  it("compares by branch plus value", () => {
    assert.equal(equalValue("u", makeUnionValue("A", 1n), makeUnionValue("A", 1n)), true);
    assert.equal(equalValue("u", makeUnionValue("A", 1n), makeUnionValue("B", 1n)), false);
    assert.equal(equalValue("u", makeUnionValue("A", 1n), makeUnionValue("A", 2n)), false);
    assert.equal(
      equalValue("u", makeUnionValue("A", [1n]), makeUnionValue("A", [1n])),
      true,
    );
  });

  it("rejects union vs non-union", () => {
    assertValueError(() => equalValue("u", makeUnionValue("A", 1n), 1n), "invalid-construction");
  });
});

describe("equalValue refs, files, actions, secrets", () => {
  it("compares record refs by model+id, ignoring versions", () => {
    assert.equal(
      equalValue("r", makeRecordRef("M", "1", 1n), makeRecordRef("M", "1", 2n)),
      true,
    );
    assert.equal(
      equalValue("r", makeRecordRef("M", "1"), makeRecordRef("M", "1", 7n)),
      true,
    );
    assert.equal(equalValue("r", makeRecordRef("M", "1"), makeRecordRef("M", "2")), false);
    assert.equal(equalValue("r", makeRecordRef("M", "1"), makeRecordRef("N", "1")), false);
  });

  it("compares user/member refs by id; mismatched ref kinds are false", () => {
    assert.equal(equalValue("u", makeUserRef("u1"), makeUserRef("u1")), true);
    assert.equal(equalValue("u", makeUserRef("u1"), makeUserRef("u2")), false);
    assert.equal(
      equalValue(
        "m",
        makeMemberRef("m1", makeUserRef("u1"), "t1"),
        makeMemberRef("m1", makeUserRef("u9"), "t9"),
      ),
      true,
    );
    assert.equal(
      equalValue("x", makeUserRef("u1"), makeMemberRef("u1", makeUserRef("u1"), "t1")),
      false,
    );
  });

  it("compares files by id and deliveries by id", () => {
    assert.equal(equalValue("f", makeFileValue("f1"), makeFileValue("f1")), true);
    assert.equal(equalValue("f", makeFileValue("f1"), makeFileValue("f2")), false);
    assert.equal(
      equalValue("d", makeDeliveryRef("d1", "pkg.A"), makeDeliveryRef("d1", "pkg.B")),
      true,
    );
    assert.equal(
      equalValue("d", makeDeliveryRef("d1", "pkg.A"), makeDeliveryRef("d2", "pkg.A")),
      false,
    );
  });

  it("compares actions by target plus bindings identity", () => {
    const left = makeActionRef("pkg.Op", { rec: makeRecordRef("M", "1", 1n) });
    const sameBindingsOtherVersion = makeActionRef("pkg.Op", { rec: makeRecordRef("M", "1", 2n) });
    assert.equal(equalValue("a", left, sameBindingsOtherVersion), true);
    assert.equal(
      equalValue("a", left, makeActionRef("pkg.Other", { rec: makeRecordRef("M", "1", 1n) })),
      false,
    );
    assert.equal(
      equalValue("a", left, makeActionRef("pkg.Op", { rec: makeRecordRef("M", "2", 1n) })),
      false,
    );
    assert.equal(equalValue("a", left, makeActionRef("pkg.Op", {})), false);
  });

  it("compares invocations by target plus structural args, versions ignored", () => {
    const left = makeInvocation("pkg.Op", { rec: makeRecordRef("M", "1", 1n), n: 5n, s: "x" });
    const otherVersion = makeInvocation("pkg.Op", { rec: makeRecordRef("M", "1", 2n), n: 5n, s: "x" });
    assert.equal(equalValue("invocation", left, otherVersion), true);
    assert.equal(
      equalValue("invocation", left, makeInvocation("pkg.Other", { rec: makeRecordRef("M", "1", 1n), n: 5n, s: "x" })),
      false,
    );
    assert.equal(
      equalValue("invocation", left, makeInvocation("pkg.Op", { rec: makeRecordRef("M", "1", 1n), n: 6n, s: "x" })),
      false,
    );
    assert.equal(
      equalValue("invocation", left, makeInvocation("pkg.Op", { rec: makeRecordRef("M", "1", 1n), n: 5n })),
      false,
    );
    assert.equal(
      equalValue("invocation", left, makeInvocation("pkg.Op", { rec: makeRecordRef("M", "1", 1n), n: 5n, s: "x", z: 1n })),
      false,
    );
    // Arg order is irrelevant; nested nulls compare by value.
    const reordered = makeInvocation("pkg.Op", { s: "x", n: 5n, rec: makeRecordRef("M", "1", 9n) });
    assert.equal(equalValue("invocation", left, reordered), true);
    assert.equal(
      equalValue("invocation", makeInvocation("t", { v: null }), makeInvocation("t", { v: null })),
      true,
    );
    assert.equal(
      equalValue("invocation", makeInvocation("t", { v: null }), makeInvocation("t", { v: 1n })),
      false,
    );
  });

  it("never equates secrets except by identical reference", () => {
    const s1 = { kind: "secret" } as SecretValue;
    const s2 = { kind: "secret" } as SecretValue;
    assert.equal(equalValue("secret", s1, s1), true);
    assert.equal(equalValue("secret", s1, s2), false);
    assertValueError(() => equalValue("secret", s1, 1n), "invalid-construction");
  });

  it("rejects ref vs non-ref", () => {
    assertValueError(() => equalValue("r", makeUserRef("u1"), 1n), "invalid-construction");
    assertValueError(
      () => equalValue("r", makeRecordRef("M", "1"), { model: "M", id: "1" }),
      "invalid-construction",
    );
  });
});

describe("equalValue malformed inputs", () => {
  it("rejects known-tag carriers that fail their shape guard", () => {
    assertValueError(
      () => equalValue("money", { kind: "money", minor: 5n }, makeMoney(5n, "EUR")),
      "invalid-construction",
    );
    assertValueError(
      () =>
        equalValue("money", { kind: "money", minor: 5n }, { kind: "money", minor: 5n }),
      "invalid-construction",
    );
    assertValueError(
      () => equalValue("decimal", { kind: "decimal", coef: 1n, scale: 99 }, new Decimal(1n, 0)),
      "invalid-construction",
    );
    assertValueError(
      () =>
        equalValue(
          "invocation",
          { kind: "invocation", target: "", args: {} },
          makeInvocation("t", {}),
        ),
      "invalid-construction",
    );
  });

  it("compares unknown-kind objects as plain contracts", () => {
    assert.equal(equalValue("c", { kind: "banana", x: 1n }, { kind: "banana", x: 1n }), true);
    assert.equal(equalValue("c", { kind: "banana", x: 1n }, { kind: "banana", x: 2n }), false);
  });

  it("validates the type id and allows empty-id runtime dispatch", () => {
    assertValueError(() => equalValue(5 as unknown as string, 1n, 1n), "invalid-construction");
    assert.equal(equalValue("", 1n, 1n), true);
    assert.equal(equalValue("", 1n, 2n), false);
    assert.equal(equalValue("", null, null), true);
  });

  it("rejects values outside the Can domain", () => {
    assertValueError(() => equalValue("int", 1 as unknown as CanValue, 1n), "invalid-construction");
    assertValueError(
      () => equalValue("int", undefined as unknown as CanValue, 1n),
      "invalid-construction",
    );
  });
});

describe("same (reference identity)", () => {
  it("identifies users by id", () => {
    assert.equal(same(makeUserRef("u1"), makeUserRef("u1")), true);
    assert.equal(same(makeUserRef("u1"), makeUserRef("u2")), false);
  });

  it("identifies members by id only", () => {
    assert.equal(
      same(makeMemberRef("m1", makeUserRef("u1"), "t1"), makeMemberRef("m1", makeUserRef("u9"), "t9")),
      true,
    );
    assert.equal(
      same(makeMemberRef("m1", makeUserRef("u1"), "t1"), makeMemberRef("m2", makeUserRef("u1"), "t1")),
      false,
    );
  });

  it("identifies records by model+id, ignoring versions", () => {
    assert.equal(same(makeRecordRef("M", "1", 1n), makeRecordRef("M", "1", 2n)), true);
    assert.equal(same(makeRecordRef("M", "1"), makeRecordRef("M", "1", 9n)), true);
    assert.equal(same(makeRecordRef("M", "1"), makeRecordRef("M", "2")), false);
    assert.equal(same(makeRecordRef("M", "1"), makeRecordRef("N", "1")), false);
  });

  it("identifies files and deliveries by id", () => {
    assert.equal(same(makeFileValue("f1"), makeFileValue("f1")), true);
    assert.equal(same(makeFileValue("f1"), makeFileValue("f2")), false);
    assert.equal(same(makeDeliveryRef("d1", "pkg.A"), makeDeliveryRef("d1", "pkg.B")), true);
    assert.equal(same(makeDeliveryRef("d1", "pkg.A"), makeDeliveryRef("d2", "pkg.A")), false);
  });

  it("identifies actions by target plus bindings identity", () => {
    assert.equal(
      same(
        makeActionRef("pkg.Op", { rec: makeRecordRef("M", "1", 1n) }),
        makeActionRef("pkg.Op", { rec: makeRecordRef("M", "1", 2n) }),
      ),
      true,
    );
    assert.equal(
      same(
        makeActionRef("pkg.Op", { rec: makeRecordRef("M", "1") }),
        makeActionRef("pkg.Other", { rec: makeRecordRef("M", "1") }),
      ),
      false,
    );
    assert.equal(
      same(
        makeActionRef("pkg.Op", { rec: makeRecordRef("M", "1") }),
        makeActionRef("pkg.Op", { rec: makeRecordRef("M", "2") }),
      ),
      false,
    );
  });

  it("identifies invocations by target plus structural args", () => {
    assert.equal(
      same(
        makeInvocation("pkg.Op", { rec: makeRecordRef("M", "1", 1n), n: 2n }),
        makeInvocation("pkg.Op", { rec: makeRecordRef("M", "1", 2n), n: 2n }),
      ),
      true,
    );
    assert.equal(
      same(makeInvocation("pkg.Op", { n: 1n }), makeInvocation("pkg.Other", { n: 1n })),
      false,
    );
    assert.equal(
      same(makeInvocation("pkg.Op", { n: 1n }), makeInvocation("pkg.Op", { n: 2n })),
      false,
    );
    assert.equal(same(makeInvocation("pkg.Op", { n: 1n }), makeInvocation("pkg.Op", {})), false);
  });

  it("returns false for mismatched ref kinds", () => {
    assert.equal(same(makeUserRef("u1"), makeMemberRef("u1", makeUserRef("u1"), "t1")), false);
    assert.equal(same(makeUserRef("u1"), makeRecordRef("M", "u1")), false);
    assert.equal(same(makeFileValue("f1"), makeDeliveryRef("f1", "pkg.Op")), false);
    assert.equal(same(makeRecordRef("M", "1"), makeActionRef("pkg.Op", {})), false);
    assert.equal(same(makeInvocation("t", {}), makeActionRef("t", {})), false);
    assert.equal(same(makeUserRef("u1"), makeInvocation("t", {})), false);
  });

  it("rejects non-refs", () => {
    const user = makeUserRef("u1");
    const nonRefs: ReadonlyArray<CanValue> = [
      1n,
      "u1",
      true,
      null,
      makeMoney(100n, "EUR"),
      makeDate(2024, 1, 1),
      { a: 1n },
      [makeUserRef("u1")],
      new Decimal(1n, 0),
      { kind: "secret" } as SecretValue,
    ];
    for (const value of nonRefs) {
      assertValueError(() => same(value, user), "invalid-construction");
      assertValueError(() => same(user, value), "invalid-construction");
    }
  });
});
