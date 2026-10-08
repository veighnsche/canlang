import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatMessage,
  formatScalar,
  isEnumTypeId,
  message,
  normalizeTag,
  resolveCaption,
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
      formatMessage(status, { locale: "en", args: { s: { type: "expense.Expense.status", value: "approved" } } }),
      "Approved",
    );
  });

  it("accepts canonical qualified enum identities and rejects mistyped values", () => {
    const pattern = "{s, select, submitted {S} other {O}}";
    for (const type of ["enum", "enum.Expense.status", "enum:Expense.status", "expense.Expense.status"]) {
      assert.equal(
        formatMessage(pattern, { locale: "en", args: { s: { type, value: "submitted" } } }),
        "S",
      );
    }
    // A record-typed value can never be formatted as an enum case.
    assert.throws(() =>
      formatMessage(pattern, { locale: "en", args: { s: { type: "expense.Expense.status", value: { id: "1" } } } }),
    );
    assert.throws(() =>
      formatMessage(pattern, { locale: "en", args: { s: { type: "text?", value: "x" } } }),
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

  it("rejects rolled-over datetimes and out-of-range times", () => {
    for (const bad of ["2026-02-30T00:00:00Z", "2026-10-04T25:00:00Z", "2026-10-04T12:60:00Z", "2026-10-04T12:00:60Z"]) {
      assert.throws(() =>
        formatMessage("{t}", { locale: "en", args: { t: { type: "datetime", value: bad } } }),
      );
    }
    assert.equal(
      formatMessage("{t,date,short}", {
        locale: "en",
        timeZone: "UTC",
        args: { t: { type: "datetime", value: "2026-02-28T23:00:00Z" } },
      }),
      "2/28/26",
    );
  });

  it("preserves full civil years for date and datetime operands", () => {
    for (const [day, expected] of [
      ["0001-01-01", "Jan 1, 1"],
      ["0099-01-01", "Jan 1, 99"],
      ["0100-01-01", "Jan 1, 100"],
      ["2001-01-01", "Jan 1, 2001"],
      ["0004-02-29", "Feb 29, 4"],
      ["2000-02-29", "Feb 29, 2000"],
      ["9999-12-31", "Dec 31, 9999"],
    ]) {
      for (const type of ["date", "datetime"]) {
        const value = type === "date" ? day : `${day}T00:00:00.000Z`;
        assert.equal(formatMessage("{x,date}", {
          locale: "en", timeZone: "UTC", args: { x: { type, value } },
        }), expected);
      }
    }
  });

  it("rejects zero years and calendar rollover at the existing operand boundary", () => {
    for (const day of [
      "0000-01-01", "0099-02-29", "1900-02-29", "0004-02-30",
      "2000-02-30", "2024-04-31", "2024-00-01", "2024-13-01",
      "2024-01-00", "2024-01-32", "10000-01-01", "001-01-01",
    ]) {
      for (const type of ["date", "datetime"]) {
        const value = type === "date" ? day : `${day}T00:00:00.000Z`;
        assert.throws(() => formatMessage("{x,date}", {
          locale: "en", timeZone: "UTC", args: { x: { type, value } },
        }), { name: "TypeError", message: type === "date"
          ? 'message argument "x": type date needs a valid YYYY-MM-DD civil date'
          : 'message argument "x": type datetime needs a canonical RFC3339 UTC instant' });
      }
    }
  });

  it("keeps quoted '#' literal inside plurals", () => {
    assert.equal(
      formatMessage("{n, plural, other {'#'}}", { locale: "en", args: { n: { type: "int", value: 5 } } }),
      "#",
    );
    assert.equal(
      formatMessage("{n, plural, other {# of '#'}}", { locale: "en", args: { n: { type: "int", value: 5 } } }),
      "5 of #",
    );
  });

  it("uses locale grouping and digits for exact values", () => {
    // Safe-range values must match platform ICU exactly (oracle); big-value
    // exactness is covered separately and never passes through floats.
    for (const locale of ["en", "nl", "fr", "hi-IN", "ar-EG", "de-CH"]) {
      for (const value of [0, 7, 1000, 1234567, 123456789012345]) {
        assert.equal(
          formatMessage("{n,number}", { locale, args: { n: { type: "int", value } } }),
          new Intl.NumberFormat(locale).format(value),
          `${locale} ${value}`,
        );
      }
    }
    // Beyond safe range the digits stay exact (spot-check Latin rendering).
    assert.equal(
      formatMessage("{n,number}", { locale: "en", args: { n: { type: "int", value: "123456789012345678901234567890" } } }),
      "123,456,789,012,345,678,901,234,567,890",
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

describe("renderer helpers", () => {
  it("resolveCaption keeps strings verbatim and formats descriptors with scales", () => {
    assert.equal(
      resolveCaption("Use {x} daily", { preferredLocales: ["en"], appDefaultLocale: "en" }),
      "Use {x} daily",
    );
    const money = message("Total: {m}", {}, { m: { type: "money", value: { minor: 2500n, currency: "EUR" } } });
    assert.equal(
      resolveCaption(money, {
        preferredLocales: ["en"],
        appDefaultLocale: "en",
        currencyScales: { EUR: 2 },
      }),
      "Total: €25.00",
    );
    assert.throws(() =>
      resolveCaption(money, { preferredLocales: ["en"], appDefaultLocale: "en" }),
    );
  });

  it("formatScalar renders typed scalars with locale and scales", () => {
    assert.equal(formatScalar({ type: "int", value: 1234567 }, { locale: "en" }), "1,234,567");
    assert.equal(
      formatScalar({ type: "money", value: { minor: 99n, currency: "USD" } }, { locale: "en", currencyScales: { USD: 2 } }),
      "$0.99",
    );
    assert.throws(() => formatScalar({ type: "money", value: { minor: 1n, currency: "USD" } }, { locale: "en" }));
    assert.throws(() => formatScalar({ type: "decimal", value: 1.1 }, { locale: "en" }));
  });

  it("isEnumTypeId accepts enum spellings and rejects scalars", () => {
    for (const type of ["enum", "enum.Expense.state", "enum:Expense.state", "expense.Expense.status"]) {
      assert.equal(isEnumTypeId(type), true, type);
    }
    for (const type of ["text", "int", "bool", "money", "date"]) {
      assert.equal(isEnumTypeId(type), false, type);
    }
  });
});
