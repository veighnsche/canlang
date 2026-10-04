import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isActionRef,
  isDateValue,
  isDatetime,
  isDeliveryRef,
  isFileValue,
  isInvocationRef,
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
  makeInvocation,
  makeMemberRef,
  makeMoney,
  makeRecordRef,
  makeUnionValue,
  makeUserRef,
} from "../src/kinds.js";
import { ValueError } from "../src/errors.js";
import { DATETIME_MAX_MS, DATETIME_MIN_MS } from "../src/temporal.js";

function assertCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ValueError, `expected ValueError, got ${String(err)}`);
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected ValueError(${code}), but nothing was thrown`);
}

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
      assertCode(() => makeMoney(1n, bad), "invalid-construction");
      assert.ok(!isMoney({ kind: "money", minor: 1n, currency: bad }));
    }
    assert.ok(!isMoney({ kind: "money" }));
    assert.ok(!isMoney(null));
  });

  it("validates pinned-ISO-table membership like the money() builtin", () => {
    // Shape-valid but excluded/unknown: XXX is an ISO code with N.A. minor
    // units (see currency-data.js), ZZZ/AAA are not codes at all.
    for (const unknown of ["XXX", "ZZZ", "AAA"]) {
      assertCode(() => makeMoney(1n, unknown), "unknown-currency");
    }
    // The shape guard stays shape-only; membership is the maker's check.
    assert.ok(isMoney({ kind: "money", minor: 1n, currency: "ZZZ" }));
    assert.deepEqual(makeMoney(1n, "USD"), { kind: "money", minor: 1n, currency: "USD" });
    assert.deepEqual(makeMoney(1n, "JPY"), { kind: "money", minor: 1n, currency: "JPY" });
  });
});

describe("date tags", () => {
  it("accepts valid civil dates including leap days", () => {
    assert.deepEqual(makeDate(2024, 2, 29), { kind: "date", year: 2024, month: 2, day: 29 });
    assert.equal(makeDate(1, 1, 1).year, 1);
    assert.equal(makeDate(9999, 12, 31).day, 31);
    assert.ok(isDateValue(makeDate(2026, 10, 4)));
  });

  it("applies century leap rules", () => {
    assert.deepEqual(makeDate(2000, 2, 29), { kind: "date", year: 2000, month: 2, day: 29 });
    assert.throws(() => makeDate(1900, 2, 29), ValueError);
    assert.ok(isDateValue(makeDate(2000, 2, 29)));
    assert.ok(!isDateValue({ kind: "date", year: 1900, month: 2, day: 29 }));
  });

  it("rejects invalid civil dates in makers and guards", () => {
    const invalid: ReadonlyArray<readonly [number, number, number]> = [
      [2023, 2, 29], [2026, 13, 1], [2026, 0, 1], [2026, 4, 31], [0, 1, 1], [10000, 1, 1], [2026, 1, 0],
    ];
    for (const [y, m, d] of invalid) {
      assert.throws(() => makeDate(y, m, d), ValueError);
      assert.ok(!isDateValue({ kind: "date", year: y, month: m, day: d }));
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

  it("range-checks to 0001-9999 like the datetime() builtin", () => {
    assert.deepEqual(makeDatetime(DATETIME_MIN_MS), { kind: "datetime", ms: DATETIME_MIN_MS });
    assert.deepEqual(makeDatetime(DATETIME_MAX_MS), { kind: "datetime", ms: DATETIME_MAX_MS });
    assertCode(() => makeDatetime(DATETIME_MIN_MS - 1n), "out-of-range");
    assertCode(() => makeDatetime(DATETIME_MAX_MS + 1n), "out-of-range");
    // The instant guard stays tag-only; range is the maker's check.
    assert.ok(isDatetime({ kind: "datetime", ms: DATETIME_MAX_MS + 1n }));
  });
});

describe("invocation tags", () => {
  it("packages decoded args frozen with versions preserved", () => {
    const value = makeInvocation("todo.Task.update", {
      record: makeRecordRef("Todo", "t1"),
      count: 3n,
      title: "hi",
      flag: true,
      when: null,
    });
    assert.equal(value.kind, "invocation");
    assert.equal(value.target, "todo.Task.update");
    assert.deepEqual(value.args["record"], { kind: "ref", model: "Todo", id: "t1" });
    assert.equal(value.args["count"], 3n);
    assert.ok(Object.isFrozen(value));
    assert.ok(Object.isFrozen(value.args));
    assert.ok(isInvocationRef(value));
    assert.ok(!isInvocationRef({ kind: "invocation", target: "", args: {} }));
    assert.ok(!isInvocationRef({ kind: "invocation", target: "t" }));
    assert.ok(!isInvocationRef(null));
  });

  it("rejects empty targets, non-record args and __proto__ names", () => {
    assertCode(() => makeInvocation("", {}), "invalid-construction");
    assertCode(() => makeInvocation(5 as unknown as string, {}), "invalid-construction");
    assertCode(() => makeInvocation("t", null as unknown as Record<string, never>), "invalid-construction");
    assertCode(() => makeInvocation("t", [] as unknown as Record<string, never>), "invalid-construction");
    assertCode(
      () => makeInvocation("t", { n: 5 } as unknown as Record<string, never>),
      "invalid-construction",
    );
    const args = JSON.parse('{"__proto__":{"kind":"ref","model":"M","id":"r"}}') as Record<string, unknown>;
    try {
      makeInvocation("t", args as never);
    } catch (err) {
      assert.ok(err instanceof ValueError);
      assert.equal(err.code, "invalid-construction");
      assert.match(err.message, /invocation argument name "__proto__" is reserved/);
      const dunder = makeInvocation("t", { constructor: makeRecordRef("M", "r", 1n) });
      assert.ok(Object.hasOwn(dunder.args, "constructor"));
      return;
    }
    assert.fail("expected __proto__ rejection, but nothing was thrown");
  });
});

describe("identity and reference tags", () => {
  it("builds user/member/record refs with identity checks", () => {
    const user = makeUserRef("u1");
    assert.ok(isUserRef(user));
    assert.ok(!isUserRef({ kind: "user", id: "" }));
    const member = makeMemberRef("m1", user, "t1");
    assert.ok(isMemberRef(member));
    assert.ok(Object.isFrozen(member.user));
    assert.ok(!isMemberRef({ kind: "member", id: "m1" }));
    assert.ok(!isMemberRef({ kind: "member", id: "", user, team: "t1" }));
    const ref = makeRecordRef("tasks.Todo", "r1", 3n);
    assert.ok(isRecordRef(ref));
    assert.ok(isRecordRef(makeRecordRef("tasks.Todo", "r1")));
    assert.ok(!isRecordRef({ kind: "ref", model: "", id: "r1" }));
    assert.throws(() => makeUserRef(""), ValueError);
    assert.throws(() => makeMemberRef("", user, "t1"), ValueError);
    assert.throws(() => makeMemberRef("m1", { kind: "user" } as unknown as never, "t1"), ValueError);
    assert.throws(() => makeRecordRef("", "r1"), ValueError);
    assert.throws(() => makeRecordRef("m", "r1", 3 as unknown as bigint), ValueError);
  });

  it("builds file/delivery/action/union values without granting authority", () => {
    assert.ok(isFileValue(makeFileValue("f1")));
    assert.ok(!isFileValue({ kind: "file", id: "" }));
    assert.throws(() => makeFileValue(""), ValueError);
    assert.ok(isDeliveryRef(makeDeliveryRef("d1", "ops.Notify.send")));
    assert.ok(!isDeliveryRef({ kind: "delivery", id: "d1", operation: "" }));
    assert.throws(() => makeDeliveryRef("d1", ""), ValueError);
    const action = makeActionRef("tasks.Todo.complete", { todo: makeRecordRef("tasks.Todo", "r1", 1n) });
    assert.ok(isActionRef(action));
    assert.ok(Object.isFrozen(action.bindings));
    assert.ok(Object.isFrozen(action.bindings["todo"]));
    assert.throws(() => makeActionRef("", {}), ValueError);
    assert.throws(
      () => makeActionRef("t", { x: { kind: "file", id: "f1" } as unknown as never }),
      ValueError,
    );
    const protoBindings = JSON.parse('{"__proto__":{"kind":"ref","model":"M","id":"r"}}') as Record<
      string,
      { version?: unknown }
    >;
    (protoBindings["__proto__"] as { version: unknown }).version = 1n;
    assert.throws(
      () => makeActionRef("t", protoBindings as never),
      (err: unknown): boolean => {
        assert.ok(err instanceof ValueError);
        assert.equal(err.code, "invalid-construction");
        assert.match(err.message, /action binding name "__proto__" is reserved/);
        return true;
      },
    );
    const dunder = makeActionRef("t", { constructor: makeRecordRef("M", "r", 1n) });
    assert.ok(Object.hasOwn(dunder.bindings, "constructor"));
    const union = makeUnionValue("Text", "hi");
    assert.deepEqual(union, { kind: "union", type: "Text", value: "hi" });
    assert.ok(isUnionValue(union));
    assert.ok(Object.isFrozen(makeUnionValue("C", { a: 1n }).value));
    assert.ok(!isUnionValue({ type: "Text", value: "hi" }));
    assert.throws(() => makeUnionValue("", "hi"), ValueError);
  });
});
