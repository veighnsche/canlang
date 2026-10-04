import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isActionRef,
  isDateValue,
  isDatetime,
  isDeliveryRef,
  isFileValue,
  isMemberRef,
  isMoney,
  isRecordRef,
  isUnionValue,
  isUserRef,
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
import { ValueError } from "../src/errors.js";

describe("money tags", () => {
  it("constructs a frozen money value", () => {
    const value = makeMoney(2500n, "EUR");
    assert.deepEqual(value, { kind: "money", minor: 2500n, currency: "EUR" });
    assert.ok(Object.isFrozen(value));
    assert.ok(isMoney(value));
  });

  it("rejects non-bigint minor and misshapen currency", () => {
    assert.throws(() => makeMoney(25 as unknown as bigint, "EUR"), ValueError);
    for (const bad of ["eur", "EURO", "E1R", "", "EU"]) {
      assert.throws(() => makeMoney(1n, bad), ValueError);
    }
    assert.ok(!isMoney({ kind: "money" }));
    assert.ok(!isMoney(null));
  });
});

describe("date tags", () => {
  it("accepts valid civil dates including leap days", () => {
    assert.deepEqual(makeDate(2024, 2, 29), { kind: "date", year: 2024, month: 2, day: 29 });
    assert.equal(makeDate(1, 1, 1).year, 1);
    assert.equal(makeDate(9999, 12, 31).day, 31);
    assert.ok(isDateValue(makeDate(2026, 10, 4)));
  });

  it("rejects invalid civil dates", () => {
    const invalid: ReadonlyArray<readonly [number, number, number]> = [
      [2023, 2, 29], [2026, 13, 1], [2026, 0, 1], [2026, 4, 31], [0, 1, 1], [10000, 1, 1], [2026, 1, 0],
    ];
    for (const [y, m, d] of invalid) {
      assert.throws(() => makeDate(y, m, d), ValueError);
    }
    assert.throws(() => makeDate(2026.5, 1, 1), ValueError);
    assert.ok(!isDateValue({ kind: "date", year: 2026 }));
  });
});

describe("datetime tags", () => {
  it("constructs frozen UTC instants from bigint ms", () => {
    const value = makeDatetime(0n);
    assert.deepEqual(value, { kind: "datetime", ms: 0n });
    assert.ok(Object.isFrozen(value));
    assert.ok(isDatetime(value));
    assert.throws(() => makeDatetime(0 as unknown as bigint), ValueError);
  });
});

describe("identity and reference tags", () => {
  it("builds user/member/record refs with identity checks", () => {
    const user = makeUserRef("u1");
    assert.ok(isUserRef(user));
    const member = makeMemberRef("m1", user, "t1");
    assert.ok(isMemberRef(member));
    assert.ok(!isMemberRef({ kind: "member", id: "m1" }));
    const ref = makeRecordRef("tasks.Todo", "r1", 3n);
    assert.ok(isRecordRef(ref));
    assert.ok(isRecordRef(makeRecordRef("tasks.Todo", "r1")));
    assert.throws(() => makeUserRef(""), ValueError);
    assert.throws(() => makeMemberRef("", user, "t1"), ValueError);
    assert.throws(() => makeMemberRef("m1", { kind: "user" } as unknown as never, "t1"), ValueError);
    assert.throws(() => makeRecordRef("", "r1"), ValueError);
    assert.throws(() => makeRecordRef("m", "r1", 3 as unknown as bigint), ValueError);
  });

  it("builds file/delivery/action/union values without granting authority", () => {
    assert.ok(isFileValue(makeFileValue("f1")));
    assert.throws(() => makeFileValue(""), ValueError);
    assert.ok(isDeliveryRef(makeDeliveryRef("d1", "ops.Notify.send")));
    assert.throws(() => makeDeliveryRef("d1", ""), ValueError);
    const action = makeActionRef("tasks.Todo.complete", { todo: makeRecordRef("tasks.Todo", "r1", 1n) });
    assert.ok(isActionRef(action));
    assert.throws(() => makeActionRef("", {}), ValueError);
    assert.throws(
      () => makeActionRef("t", { x: { kind: "file", id: "f1" } as unknown as never }),
      ValueError,
    );
    assert.ok(isUnionValue(makeUnionValue("Text", "hi")));
    assert.throws(() => makeUnionValue("", "hi"), ValueError);
  });
});
