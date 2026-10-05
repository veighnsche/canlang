import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ValueError } from "../src/errors.js";
import { makeMessageDescriptor, type MessageParam } from "../src/icu.js";
import { makeDatetime } from "../src/kinds.js";
import {
  canonicalLocale,
  formatMessage,
  lookupChain,
  resolveVariant,
  type FormatMessageOptions,
} from "../src/locale.js";

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

function intParam(value: bigint): MessageParam {
  return { type: "int", value };
}

describe("canonicalLocale and lookupChain", () => {
  it("canonicalizes BCP 47 tags", () => {
    assert.equal(canonicalLocale("en-us"), "en-US");
    assert.equal(canonicalLocale("NL"), "nl");
    assert.equal(canonicalLocale("pt-br"), "pt-BR");
    assert.equal(canonicalLocale("zh-hant-hk"), "zh-Hant-HK");
  });

  it("rejects invalid tags", () => {
    for (const tag of ["", "!!!", "en-", "a-very-long-subtag-that-exceeds-eight"]) {
      assertValueError(() => canonicalLocale(tag), "invalid-construction");
    }
    assertValueError(() => canonicalLocale(1 as unknown as string), "invalid-construction");
  });

  it("builds RFC 4647 truncation chains", () => {
    assert.deepEqual([...lookupChain("zh-Hant-HK")], ["zh-Hant-HK", "zh-Hant", "zh"]);
    assert.deepEqual([...lookupChain("en")], ["en"]);
    assert.equal(Object.isFrozen(lookupChain("en-US")), true);
  });
});

describe("resolveVariant fallback chains", () => {
  it("prefers exact tags over truncation", () => {
    const descriptor = makeMessageDescriptor("Tasks", { en: "Tasks!", "en-US": "Tasks, y'all" });
    assert.deepEqual(resolveVariant(descriptor, "en-US", "en", "de"), {
      tag: "en-US",
      text: "Tasks, y'all",
    });
  });

  it("truncates the requested tag (RFC 4647 lookup)", () => {
    const descriptor = makeMessageDescriptor("Taken", { nl: "Taken!" });
    assert.deepEqual(resolveVariant(descriptor, "nl-BE", "en", "de"), { tag: "nl", text: "Taken!" });
  });

  it("takes the longest match on multi-level chains", () => {
    const descriptor = makeMessageDescriptor("x", { pt: "pt", "pt-BR": "pt-BR!" });
    assert.equal(resolveVariant(descriptor, "pt-BR", "en", "de").tag, "pt-BR");
    assert.equal(resolveVariant(descriptor, "pt-PT", "en", "de").tag, "pt");
  });

  it("falls back to app-default lookup after requested lookup", () => {
    const descriptor = makeMessageDescriptor("Add", { nl: "Toevoegen" });
    assert.deepEqual(resolveVariant(descriptor, "de", "nl", "en"), { tag: "nl", text: "Toevoegen" });
  });

  it("truncates the app-default tag too", () => {
    const descriptor = makeMessageDescriptor("x", { pt: "pt!" });
    assert.deepEqual(resolveVariant(descriptor, "de", "pt-PT", "en"), { tag: "pt", text: "pt!" });
  });

  it("exhausts requested lookup before app-default lookup", () => {
    const descriptor = makeMessageDescriptor("x", { fr: "via-request", de: "via-default" });
    assert.equal(resolveVariant(descriptor, "fr-CA", "de", "en").tag, "fr");
  });

  it("falls back to the source variant last", () => {
    const descriptor = makeMessageDescriptor("Source!", { nl: "Niet dit" });
    assert.deepEqual(resolveVariant(descriptor, "de", "fr", "en"), { tag: "en", text: "Source!" });
  });

  it("skips null variants", () => {
    const descriptor = makeMessageDescriptor("Source!", { de: null, nl: "Nederlands" });
    assert.deepEqual(resolveVariant(descriptor, "de", "nl", "en"), {
      tag: "nl",
      text: "Nederlands",
    });
    const absent = makeMessageDescriptor("Source!", { de: null });
    assert.deepEqual(resolveVariant(absent, "de", "fr", "en"), { tag: "en", text: "Source!" });
  });

  it("matches requested tags case-insensitively", () => {
    const descriptor = makeMessageDescriptor("x", { nl: "Nederlands" });
    assert.equal(resolveVariant(descriptor, "NL", "en", "de").tag, "nl");
  });

  it("prefix-matches longer variants (requested en resolves en-US-only)", () => {
    const descriptor = makeMessageDescriptor("Color", { "en-US": "Color!" });
    assert.deepEqual(resolveVariant(descriptor, "en", "fr", "de"), {
      tag: "en-US",
      text: "Color!",
    });
  });

  it("prefers the exact tag when en and en-US both match", () => {
    const descriptor = makeMessageDescriptor("Color", { en: "Colour", "en-US": "Color!" });
    assert.deepEqual(resolveVariant(descriptor, "en", "fr", "de"), { tag: "en", text: "Colour" });
  });

  it("prefers the app-default tag among prefix matches, then lexical order", () => {
    const descriptor = makeMessageDescriptor("x", { "en-GB": "gb", "en-US": "us" });
    assert.equal(resolveVariant(descriptor, "en", "en-US", "de").tag, "en-US");
    assert.equal(resolveVariant(descriptor, "en", "fr", "de").tag, "en-GB");
  });

  it("falls back from en-GB to an en variant", () => {
    const descriptor = makeMessageDescriptor("Colour", { en: "Colour!" });
    assert.deepEqual(resolveVariant(descriptor, "en-GB", "fr", "de"), {
      tag: "en",
      text: "Colour!",
    });
  });

  it("rejects eng-style prefix overreach at subtag boundaries", () => {
    // Literal "eng" canonicalizes to "en" per BCP 47, so "ena" — a well-formed
    // distinct tag sharing the "en" prefix — exercises the boundary instead.
    assert.equal(canonicalLocale("eng"), "en");
    const descriptor = makeMessageDescriptor("Source!", { ena: "Not English" });
    assert.deepEqual(resolveVariant(descriptor, "en", "fr", "de"), {
      tag: "de",
      text: "Source!",
    });
  });

  it("resolves a source-tagged variant as an ordinary variant", () => {
    const descriptor = makeMessageDescriptor("Tasks", { nl: "Taken" });
    assert.deepEqual(resolveVariant(descriptor, "nl", "en", "nl"), { tag: "nl", text: "Taken" });
    assert.deepEqual(resolveVariant(descriptor, "NL", "en", "NL"), { tag: "nl", text: "Taken" });
    assert.deepEqual(resolveVariant(descriptor, "de", "fr", "nl"), { tag: "nl", text: "Tasks" });
  });

  it("selects requested source wording over a translated app default", () => {
    const descriptor = makeMessageDescriptor("Shared source.", { nl: "Gedeelde tekst." });
    assert.deepEqual(resolveVariant(descriptor, "en", "nl", "en"), {
      tag: "en",
      text: "Shared source.",
    });
  });

  it("truncates a regional request onto the source tag", () => {
    const descriptor = makeMessageDescriptor("Shared source.", { nl: "Gedeelde tekst." });
    assert.deepEqual(resolveVariant(descriptor, "en-US", "nl", "en"), {
      tag: "en",
      text: "Shared source.",
    });
  });

  it("prefix-admits a regional source tag from a short request", () => {
    const descriptor = makeMessageDescriptor("Color!", { nl: "Kleur!" });
    assert.deepEqual(resolveVariant(descriptor, "en", "nl", "en-US"), {
      tag: "en-US",
      text: "Color!",
    });
  });

  it("matches source participation on canonical tag spellings", () => {
    const descriptor = makeMessageDescriptor("Shared source.", { nl: "Gedeelde tekst." });
    assert.deepEqual(resolveVariant(descriptor, "EN", "nl", "en"), {
      tag: "en",
      text: "Shared source.",
    });
    assert.deepEqual(resolveVariant(descriptor, "en", "nl", "EN"), {
      tag: "en",
      text: "Shared source.",
    });
    assert.deepEqual(resolveVariant(descriptor, "en-us", "nl", "EN-us"), {
      tag: "en-US",
      text: "Shared source.",
    });
  });

  it("keeps an explicit source-tagged variant ahead of the source wording", () => {
    const descriptor = makeMessageDescriptor("Tasks", { nl: "Taken", en: "Tasks!" });
    assert.deepEqual(resolveVariant(descriptor, "en", "nl", "en"), {
      tag: "en",
      text: "Tasks!",
    });
  });

  it("rejects duplicate canonical tags defensively", () => {
    const descriptor = makeMessageDescriptor("x", { nl: "a" });
    const tampered = { ...descriptor, variants: { nl: "a", NL: "b" } };
    assertValueError(() => resolveVariant(tampered, "nl", "en", "de"), "invalid-construction");
  });

  it("rejects invalid tags and descriptors", () => {
    const descriptor = makeMessageDescriptor("x", {});
    assertValueError(() => resolveVariant(descriptor, "!!!", "en", "en"), "invalid-construction");
    assertValueError(() => resolveVariant(descriptor, "en", "!!!", "en"), "invalid-construction");
    assertValueError(() => resolveVariant(descriptor, "en", "en", ""), "invalid-construction");
    assertValueError(
      () => resolveVariant(null as unknown as typeof descriptor, "en", "en", "en"),
      "invalid-construction",
    );
  });

  it("freezes resolved variants", () => {
    const descriptor = makeMessageDescriptor("x", {});
    assert.equal(Object.isFrozen(resolveVariant(descriptor, "de", "fr", "en")), true);
  });
});

describe("formatMessage renders under the selected locale", () => {
  const tasks = makeMessageDescriptor("{n, plural, one {# task} other {# tasks}}", {
    nl: "{n, plural, one {# taak} other {# taken}}",
    ru: "{n, plural, one {# задача} few {# задачи} many {# задач} other {# задачи}}",
  });

  function withCount(n: bigint) {
    return makeMessageDescriptor(tasks.source, { ...tasks.variants }, { n: intParam(n) });
  }

  it("renders the exact requested variant", () => {
    const out = formatMessage(withCount(1n), { locale: "nl", appDefault: "en" });
    assert.deepEqual(out, { text: "1 taak", locale: "nl" });
  });

  it("selects plural rules from the variant locale (Russian few)", () => {
    const out = formatMessage(withCount(2n), { locale: "ru", appDefault: "en" });
    assert.deepEqual(out, { text: "2 задачи", locale: "ru" });
    const many = formatMessage(withCount(5n), { locale: "ru", appDefault: "en" });
    assert.deepEqual(many, { text: "5 задач", locale: "ru" });
  });

  it("uses source-locale rules on source fallback (English other)", () => {
    const out = formatMessage(withCount(2n), { locale: "de", appDefault: "fr" });
    assert.deepEqual(out, { text: "2 tasks", locale: "en" });
  });

  it("uses variant-locale rules on app-default fallback", () => {
    const out = formatMessage(withCount(2n), { locale: "de", appDefault: "ru" });
    assert.deepEqual(out, { text: "2 задачи", locale: "ru" });
  });

  it("selects the app default for null locale (never the viewer)", () => {
    const out = formatMessage(withCount(3n), { locale: null, appDefault: "nl" });
    assert.deepEqual(out, { text: "3 taken", locale: "nl" });
  });

  it("requires an explicit locale key at this boundary", () => {
    assertValueError(
      () => formatMessage(withCount(1n), { appDefault: "en" } as unknown as FormatMessageOptions),
      "invalid-construction",
    );
    assertValueError(
      () =>
        formatMessage(
          withCount(1n),
          { locale: 1, appDefault: "en" } as unknown as FormatMessageOptions,
        ),
      "invalid-construction",
    );
  });

  it("defaults the source language to en", () => {
    const out = formatMessage(withCount(1n), { locale: "de", appDefault: "fr" });
    assert.equal(out.locale, "en");
  });

  it("honors an explicit source language", () => {
    const descriptor = makeMessageDescriptor("Bron", { nl: null });
    const out = formatMessage(descriptor, { locale: "de", appDefault: "fr", sourceLang: "nl-BE" });
    assert.deepEqual(out, { text: "Bron", locale: "nl-BE" });
  });

  it("rejects explicit null/non-string source languages", () => {
    const descriptor = makeMessageDescriptor("Hi", {});
    assertValueError(
      () =>
        formatMessage(descriptor, {
          locale: "en",
          appDefault: "en",
          sourceLang: null as unknown as string,
        }),
      "invalid-construction",
    );
    assertValueError(
      () =>
        formatMessage(descriptor, {
          locale: "en",
          appDefault: "en",
          sourceLang: 1 as unknown as string,
        }),
      "invalid-construction",
    );
  });

  it("renders static descriptors without params", () => {
    const descriptor = makeMessageDescriptor("No tasks yet.", { nl: "Nog geen taken." });
    assert.deepEqual(formatMessage(descriptor, { locale: "nl", appDefault: "en" }), {
      text: "Nog geen taken.",
      locale: "nl",
    });
  });

  it("fails undeclared variables at render", () => {
    const descriptor = makeMessageDescriptor("{n, plural, other {#}}", {});
    assertValueError(
      () => formatMessage(descriptor, { locale: "en", appDefault: "en" }),
      "invalid-construction",
    );
  });

  it("passes the business zone through to datetimes", () => {
    const descriptor = makeMessageDescriptor("{t,time,short}", {}, {
      t: { type: "datetime", value: makeDatetime(1767225600000n) },
    });
    const utc = formatMessage(descriptor, { locale: "en", appDefault: "en" });
    assert.match(utc.text, /12:00/);
    const eastern = formatMessage(descriptor, {
      locale: "en",
      appDefault: "en",
      timeZone: "America/New_York",
    });
    assert.match(eastern.text, /7:00/);
  });

  it("freezes formatted messages and rejects bad shapes", () => {
    const out = formatMessage(withCount(1n), { locale: "en", appDefault: "en" });
    assert.equal(Object.isFrozen(out), true);
    assertValueError(
      () => formatMessage(null as unknown as typeof tasks, { locale: "en", appDefault: "en" }),
      "invalid-construction",
    );
    assertValueError(
      () => formatMessage(withCount(1n), null as unknown as FormatMessageOptions),
      "invalid-construction",
    );
  });
});
