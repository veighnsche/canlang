import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatMessage,
  message,
  normalizeTag,
  resolveMessage,
} from "../src/messages.js";
import { TEAMTASKS_MESSAGES } from "./fixtures/descriptors.js";

describe("normalizeTag", () => {
  it("canonicalizes tags", () => {
    assert.equal(normalizeTag("nl"), "nl");
    assert.equal(normalizeTag("pt-br"), "pt-BR");
    assert.equal(normalizeTag("EN-us"), "en-US");
  });

  it("rejects invalid tags", () => {
    assert.throws(() => normalizeTag("not a tag!!"), RangeError);
    assert.throws(() => normalizeTag("en_US"), RangeError);
  });
});

describe("message factory", () => {
  it("builds descriptors with variants", () => {
    const descriptor = message("Add", { nl: "Toevoegen" });
    assert.equal(descriptor.source, "Add");
    assert.deepEqual(descriptor.variants, { nl: "Toevoegen" });
  });

  it("rejects duplicate canonical tags and bad values", () => {
    assert.throws(() => message("x", { nl: "a", NL: "b" } as Record<string, string>), RangeError);
    assert.throws(() => message("x", { nl: 42 } as unknown as Record<string, string>), TypeError);
    assert.throws(() => message(42 as unknown as string), TypeError);
  });

  it("accepts explicit null for absent translations", () => {
    const descriptor = message("x", { nl: null });
    assert.equal(descriptor.variants["nl"], null);
  });
});

describe("resolveMessage", () => {
  const descriptor = message("Tasks", { nl: "Taken", de: "Aufgaben", "pt-BR": "Tarefas" });

  it("applies RFC 4647 lookup over preferences", () => {
    assert.deepEqual(
      resolveMessage(descriptor, { preferredLocales: ["nl"], appDefaultLocale: "en" }),
      { text: "Taken", locale: "nl" },
    );
    // Prefix fallback: pt-PT has no variant, pt-BR is not an ancestor; falls through.
    assert.deepEqual(
      resolveMessage(descriptor, { preferredLocales: ["pt-PT"], appDefaultLocale: "en" }),
      { text: "Tasks", locale: "en" },
    );
    // Ancestor fallback: pt-BR-variant strips to the pt-BR variant.
    assert.deepEqual(
      resolveMessage(descriptor, { preferredLocales: ["pt-BR-variant"], appDefaultLocale: "en" }),
      { text: "Tarefas", locale: "pt-BR" },
    );
  });

  it("prefers longer compatible matches and falls back to app default", () => {
    const nested = message("s", { pt: "PT", "pt-BR": "PT-BR" });
    assert.deepEqual(
      resolveMessage(nested, { preferredLocales: ["pt-BR"], appDefaultLocale: "en" }),
      { text: "PT-BR", locale: "pt-BR" },
    );
    assert.deepEqual(
      resolveMessage(descriptor, { preferredLocales: ["fr"], appDefaultLocale: "de" }),
      { text: "Aufgaben", locale: "de" },
    );
  });

  it("skips null variants and ends at the source locale", () => {
    const sparse = message("src", { nl: null });
    assert.deepEqual(
      resolveMessage(sparse, { preferredLocales: ["nl"], appDefaultLocale: "fr" }),
      { text: "src", locale: "en" },
    );
    assert.deepEqual(
      resolveMessage(sparse, {
        preferredLocales: ["nl"],
        appDefaultLocale: "fr",
        sourceLocale: "de",
      }),
      { text: "src", locale: "de" },
    );
  });
});

describe("formatMessage plurals", () => {
  it("formats the TeamTasks task count in en and nl", () => {
    for (const [n, en, nl] of [[0n, "0 tasks", "0 taken"], [1n, "1 task", "1 taak"], [2n, "2 tasks", "2 taken"]] as const) {
      const descriptor = TEAMTASKS_MESSAGES.taskCount(n);
      assert.equal(
        formatMessage(descriptor, { preferredLocales: ["en"], appDefaultLocale: "en" }),
        en,
      );
      assert.equal(
        formatMessage(descriptor, { preferredLocales: ["nl"], appDefaultLocale: "en" }),
        nl,
      );
    }
  });

  it("matches exact numeric cases before CLDR categories", () => {
    const pattern = "{n, plural, =0 {none} =1 {one} other {# items}}";
    assert.equal(
      formatMessage(pattern, { locale: "en", args: { n: { type: "int", value: 0 } } }),
      "none",
    );
    assert.equal(
      formatMessage(pattern, { locale: "en", args: { n: { type: "decimal", value: "1.0" } } }),
      "one",
    );
    assert.equal(
      formatMessage(pattern, { locale: "en", args: { n: { type: "int", value: 2n } } }),
      "2 items",
    );
  });

  it("keeps 64-bit ints exact, including French 0/1 and large magnitudes", () => {
    const pattern = "{n, plural, one {# item} other {# items}}";
    const big = 1000001n;
    assert.equal(
      formatMessage(pattern, { locale: "fr", args: { n: { type: "int", value: big } } }),
      "1\u202F000\u202F001 items",
    );
    assert.equal(
      formatMessage(pattern, { locale: "fr", args: { n: { type: "int", value: 1n } } }),
      "1 item",
    );
    const huge = 9223372036854775807n;
    const rendered = formatMessage(pattern, {
      locale: "en",
      args: { n: { type: "int", value: huge } },
    });
    assert.ok(rendered.startsWith("9,223,372,036,854,775,807"));
  });

  it("formats Arabic categories via Intl rules", () => {
    const pattern = "{n, plural, zero {zero} one {one} two {two} few {few} many {many} other {other}}";
    assert.equal(
      formatMessage(pattern, { locale: "ar", args: { n: { type: "int", value: 2 } } }),
      "two",
    );
    assert.equal(
      formatMessage(pattern, { locale: "ar", args: { n: { type: "int", value: 11 } } }),
      "many",
    );
  });

  it("rejects offsets, duplicate branches and missing other", () => {
    assert.throws(() => formatMessage("{n, plural, offset:1 other {x}}", { locale: "en", args: { n: { type: "int", value: 1 } } }));
    assert.throws(() => formatMessage("{n, plural, one {a} one {b} other {c}}", { locale: "en", args: { n: { type: "int", value: 1 } } }));
    assert.throws(() => formatMessage("{n, plural, one {a}}", { locale: "en", args: { n: { type: "int", value: 1 } } }));
  });
});

describe("formatMessage select/number/date/money", () => {
  it("selects text/bool/enum cases with other fallback", () => {
    const pattern = "{done, select, true {Done} false {Open} other {?}}";
    assert.equal(
      formatMessage(pattern, { locale: "en", args: { done: { type: "bool", value: true } } }),
      "Done",
    );
    assert.equal(
      formatMessage(pattern, { locale: "nl", args: { done: { type: "bool", value: false } } }),
      "Open",
    );
    const status = "{s, select, submitted {Submitted} approved {Approved} other {Other}}";
    assert.equal(
      formatMessage(status, { locale: "en", args: { s: { type: "enum.Expense.status", value: "approved" } } }),
      "Approved",
    );
  });

  it("formats numbers with locale grouping and integer style", () => {
    assert.equal(
      formatMessage("{n,number}", { locale: "en", args: { n: { type: "int", value: 1234567 } } }),
      "1,234,567",
    );
    assert.equal(
      formatMessage("{n,number}", { locale: "nl", args: { n: { type: "decimal", value: "1234.5" } } }),
      "1.234,5",
    );
    assert.equal(
      formatMessage("{n,number,integer}", { locale: "en", args: { n: { type: "decimal", value: "2.5" } } }),
      "2",
    );
  });

  it("formats dates without day shifts and datetimes in the team zone", () => {
    const date = formatMessage("{d,date}", {
      locale: "en",
      args: { d: { type: "date", value: "2026-10-04" } },
    });
    assert.ok(date.includes("2026"));
    const time = formatMessage("{t,time,short}", {
      locale: "en",
      timeZone: "Europe/Amsterdam",
      args: { t: { type: "datetime", value: "2026-10-04T12:00:00Z" } },
    });
    // 12:00 UTC is 14:00 in Amsterdam (CEST).
    assert.ok(time.includes("2:00"), time);
    assert.throws(() =>
      formatMessage("{d,time}", { locale: "en", args: { d: { type: "date", value: "2026-10-04" } } }),
    );
  });

  it("formats money exactly with explicit scales and fails closed without them", () => {
    const args = { m: { type: "money", value: { minor: 2500n, currency: "EUR" } } };
    assert.equal(
      formatMessage("{m}", { locale: "en", args, currencyScales: { EUR: 2 } }),
      "€25.00",
    );
    assert.throws(() => formatMessage("{m}", { locale: "en", args }));
  });

  it("rejects lossy and mistyped arguments", () => {
    assert.throws(() =>
      formatMessage("{n}", { locale: "en", args: { n: { type: "decimal", value: 1.1 } } }),
    );
    assert.throws(() =>
      formatMessage("{n,number}", { locale: "en", args: { n: { type: "text", value: "x" } } }),
    );
    assert.throws(() => formatMessage("{missing}", { locale: "en", args: {} }));
    assert.throws(() =>
      formatMessage("{d}", { locale: "en", args: { d: { type: "date", value: "2026-02-30" } } }),
    );
  });

  it("handles quoting and nested selects", () => {
    assert.equal(formatMessage("it''s {x}", { locale: "en", args: { x: { type: "text", value: "ok" } } }), "it's ok");
    const nested = "{a, select, x {{b, select, y {xy} other {x?}}} other {other}}";
    assert.equal(
      formatMessage(nested, {
        locale: "en",
        args: { a: { type: "text", value: "x" }, b: { type: "text", value: "y" } },
      }),
      "xy",
    );
  });
});
