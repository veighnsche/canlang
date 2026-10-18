import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MessageDescriptor, MessageParams } from "@canlang/contracts";
import { date, parseDecimal } from "@canlang/values";
import { formatMessage, message, resolveCaption } from "../src/messages.js";

const selected = { s: { type: "text", value: "yes" } };

function undeclared(name: string, pattern: string): string {
  return `message pattern error: undeclared argument "${name}" in ${JSON.stringify(pattern)}`;
}

describe("full message signature usage", () => {
  it("checks source and every present variant syntax even before binding", () => {
    const malformed = "🧭\n}";
    for (const construct of [
      () => message(malformed),
      () => message("ok", { nl: malformed }),
    ]) {
      assert.throws(construct, (error: unknown) => {
        assert.equal(Object.getPrototypeOf(error), Error.prototype);
        assert.equal((error as Error).message,
          `message pattern error at offset 3: unmatched closing brace in ${JSON.stringify(malformed)}`);
        return true;
      });
    }
    const unbound = message("{name}", { nl: "{count,number}", fr: null, de: "" });
    assert.equal(unbound.params, undefined);
    assert.equal(formatMessage(unbound, {
      preferredLocales: ["de"], args: {
        name: { type: "text", value: "Ada" }, count: { type: "int", value: 1n },
      },
    }), "");
  });

  it("rejects missing bindings in unused branches at construction and formatting", () => {
    const pattern = "{s,select,yes {ok} other {{missing}}}";
    assert.throws(() => message(pattern, {}, selected), { message: undeclared("missing", pattern) });
    const structural: MessageDescriptor = { source: pattern, variants: {}, params: selected };
    assert.throws(() => formatMessage(structural), { message: undeclared("missing", pattern) });
    assert.throws(() => formatMessage(pattern, { args: selected }), { message: undeclared("missing", pattern) });
  });

  it("validates every typed usage in unselected branches using UI error families", () => {
    const cases = [
      ["{x,number}", "text", "text", "number needs int or decimal"],
      ["{x,number,integer}", "decimal", "2.5", "number,integer needs int"],
      ["{x,date}", "int", 2n, "date needs date or datetime"],
      ["{x,time}", "date", "2024-01-01", "date-only values have no time"],
      ["{x,time}", "bool", true, "time needs date or datetime"],
      ["{x,plural,other {#}}", "text", "2", "plural needs int or decimal"],
      ["{x,selectordinal,other {#}}", "decimal", "2", "selectordinal needs int"],
      ["{x,select,other {ok}}", "int", 2n, "select needs text, bool or enum"],
    ] as const;
    for (const [usage, type, value, why] of cases) {
      const source = `{s,select,yes {ok} other {${usage}}}`;
      const params = { ...selected, x: { type, value } };
      const expected = { name: "Error", message: `message argument "x": ${why}` };
      assert.throws(() => message(source, {}, params), expected, usage);
      assert.throws(() => formatMessage({ source, variants: {}, params }), expected, usage);
    }
  });

  it("checks missing and invalid usage in unselected variants and the unselected source", () => {
    for (const invalid of ["{missing}", "{x,number}"]) {
      const params = { x: { type: "text", value: "x" } };
      const expected = invalid === "{missing}"
        ? undeclared("missing", invalid) : 'message argument "x": number needs int or decimal';
      for (const descriptor of [
        { source: "ok", variants: { nl: invalid }, params },
        { source: invalid, variants: { nl: "ok" }, params },
      ]) {
        assert.throws(() => message(descriptor.source, descriptor.variants, params), { message: expected });
        assert.throws(() => formatMessage(descriptor, { preferredLocales: ["nl"] }), { message: expected });
      }
    }
    const structural = { source: "ok", variants: { nl: "ok", de: "}" } };
    assert.throws(() => formatMessage(structural, { preferredLocales: ["nl"] }),
      { message: 'message pattern error at offset 0: unmatched closing brace in "}"' });
    assert.throws(() => formatMessage({ source: "}", variants: { nl: "ok" } }, { preferredLocales: ["nl"] }),
      { message: 'message pattern error at offset 0: unmatched closing brace in "}"' });
  });

  it("permits differing subsets of one shared signature, null and empty variants", () => {
    const params = {
      ...selected, name: { type: "text", value: "Ada" }, count: { type: "int", value: 2n },
    };
    const descriptor = message("{s,select,yes {{name}} other {{count,number}}}", {
      nl: "{count,number}", fr: null, de: "",
    }, params);
    assert.equal(formatMessage(descriptor), "Ada");
    assert.equal(formatMessage(descriptor, { preferredLocales: ["nl"] }), "2");
    assert.equal(formatMessage(descriptor, { preferredLocales: ["fr"] }), "Ada");
    assert.equal(formatMessage(descriptor, { preferredLocales: ["de"] }), "");
  });

  it("uses explicit args as the entire effective signature", () => {
    const descriptor = message("{name}", { nl: "{count,number}" }, {
      name: { type: "text", value: "bound" }, count: { type: "int", value: "bad" },
    });
    assert.equal(formatMessage(descriptor, { args: {
      name: { type: "text", value: "override" }, count: { type: "int", value: 3n },
    } }), "override");
    assert.throws(() => formatMessage(descriptor, { args: { name: { type: "text", value: "override" } } }),
      { message: undeclared("count", "{count,number}") });
  });

  it("checks declaration types without converting values at construction", () => {
    const descriptor = message("{x,number}", {}, {
      x: { type: "int", value: "bad" }, unused: { type: "future-type", value: null },
    });
    assert.equal(descriptor.params?.x?.value, "bad");
    assert.throws(() => formatMessage(descriptor), {
      name: "TypeError", message: 'message argument "x": type int needs a bigint, safe number or canonical int string',
    });
    const unused = message("ok", {}, { unused: { type: "future-type", value: null } });
    assert.throws(() => formatMessage(unused), {
      name: "TypeError", message: 'message argument "unused": unsupported message parameter type future-type',
    });
  });

  it("retains metadata and wrapper validation before syntax or usage at construction", () => {
    for (const source of ["}", "{missing}"]) {
      assert.throws(() => message(source, { nl: 42 } as unknown as Record<string, string>, {}),
        { name: "TypeError", message: "variant nl must be a string or null" });
      assert.throws(() => message(source, {}, { broken: null } as unknown as MessageParams),
        { name: "TypeError", message: 'message argument "broken" must be {type, value}' });
    }
  });

  it("retains locale resolution then eager supplied-value admission before pattern checks", () => {
    const params = { unused: { type: "int", value: 1.5 } };
    for (const source of ["}", "{missing}"]) {
      const descriptor = { source: "ok", variants: { nl: source }, params };
      assert.throws(() => formatMessage(descriptor), {
        name: "TypeError", message: 'message argument "unused": int number value must be a safe integer',
      });
      assert.throws(() => formatMessage(descriptor, { appDefaultLocale: "invalid_tag" }), RangeError);
    }
  });

  it("uses own bindings and preserves own __proto__ declarations", () => {
    const source = "{s,select,yes {ok} other {{x}}}";
    const inherited: MessageParams = Object.assign(Object.create({ x: { type: "text", value: "inherited" } }), selected);
    assert.throws(() => message(source, {}, inherited), { message: undeclared("x", source) });
    assert.throws(() => formatMessage({ source, variants: {}, params: inherited }), { message: undeclared("x", source) });
    const own: MessageParams = Object.create(null);
    Object.defineProperty(own, "__proto__", { enumerable: true, value: { type: "text", value: "special" } });
    const descriptor = message("{__proto__}", {}, own);
    assert.equal(Object.hasOwn(descriptor.params!, "__proto__"), true);
    assert.equal(formatMessage(descriptor), "special");
  });

  it("accepts qualified enums, string-like aliases and bool selectors in all variants", () => {
    for (const type of ["expense.Expense.status", "email", "url", "timezone", "locale", "currency", "bool"]) {
      const value = type === "bool" ? true : "yes";
      const descriptor = message("{x}", { nl: "{x,select,yes {yes} true {yes} other {other}}" }, { x: { type, value } });
      assert.equal(formatMessage(descriptor, { preferredLocales: ["nl"] }), "yes", type);
    }
  });

  it("keeps inline-enum descriptor carriers usable by their existing formatter owner", () => {
    const params = { mode: { type: "enum(pending,released)", value: "pending" } };
    const descriptor = message("{mode}", { nl: "{mode,select,pending {yes} other {no}}" }, params);
    assert.equal(descriptor.params?.mode?.type, params.mode.type);
    assert.throws(() => formatMessage(descriptor), {
      name: "TypeError", message: 'message argument "mode": unsupported message parameter type enum(pending,released)',
    });
    assert.throws(() => message("{mode,number}", {}, params), {
      name: "Error", message: 'message argument "mode": number needs int or decimal',
    });
    for (const type of ["enum(pending,released)[]", "enum(pending,released)?", "enum(pending,pending)"]) {
      assert.throws(() => message("{mode}", {}, { mode: { type, value: "pending" } }), TypeError);
    }
  });

  it("retains exact selected rendering without imposing rendering limits on unused branches", () => {
    const exact = "12345678901234567890.123456789012345678";
    const descriptor = message(`{n,plural,=${exact} {#} other {{m}}}`, {
      nl: "{d,date}",
    }, {
      n: { type: "decimal", value: parseDecimal(exact) },
      m: { type: "money", value: { minor: 100n, currency: "EUR" } },
      d: { type: "date", value: date("0001-01-01") },
    });
    assert.equal(formatMessage(descriptor), "12,345,678,901,234,567,890.123456789012345678");
    assert.equal(formatMessage(descriptor, { preferredLocales: ["nl"], timeZone: "America/Los_Angeles" }),
      new Intl.DateTimeFormat("nl", { dateStyle: "medium", timeZone: "UTC" }).format(new Date("0001-01-01T00:00:00Z")));
    assert.equal(resolveCaption("literal } {missing}", { preferredLocales: [], appDefaultLocale: "en" }), "literal } {missing}");
  });
});
