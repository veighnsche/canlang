import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  MessageValue,
  PresentationContext,
  RowView,
} from "../../contracts/src/presentation.js";
import { message } from "../src/messages.js";
import {
  card,
  content,
  renderState,
  renderTextValue,
  rowHeading,
  text,
  title,
} from "../src/components.js";

function makeContext(overrides: Partial<PresentationContext> = {}): PresentationContext {
  return {
    preferredLocales: [],
    appDefaultLocale: "en",
    theme: { mode: "system", accent: "blue", density: "comfortable" },
    path: "/",
    isPartial: false,
    csrfToken: "csrf-123",
    principal: null,
    invocation: null,
    query: async () => ({ rows: [], columns: [] }),
    ...overrides,
  };
}

const XSS = `<script>alert(1)</script><img src=x onerror=alert(2)>`;

describe("card", () => {
  it("renders a daisyUI card with a literal title", async () => {
    const html = await card({ context: makeContext(), title: "Tasks", children: ["<p>one</p>"] });
    assert.match(html, /<section class="card bg-base-100 shadow">/);
    assert.match(html, /<div class="card-body">/);
    assert.match(html, /<h2 class="card-title">Tasks<\/h2>/);
    assert.ok(html.includes("<p>one</p>"));
  });

  it("resolves descriptor titles against viewer locale", async () => {
    const ctx = makeContext({ preferredLocales: ["nl"] });
    const html = await card({
      context: ctx,
      title: message("Tasks", { nl: "Taken" }),
      children: [],
    });
    assert.ok(html.includes(">Taken</h2>"));
  });

  it("escapes titles", async () => {
    const html = await card({ context: makeContext(), title: XSS, children: [] });
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&lt;script&gt;"));
  });

  it("awaits promise children and joins arrays", async () => {
    const html = await card({
      context: makeContext(),
      title: "t",
      children: ["<p>a</p>", Promise.resolve("<p>b</p>")],
    });
    assert.ok(html.includes("<p>a</p><p>b</p>"));
  });

  it("accepts a sync thunk and an async thunk", async () => {
    const sync = await card({ context: makeContext(), title: "t", children: () => ["<p>s</p>"] });
    assert.ok(sync.includes("<p>s</p>"));
    const asyncKids = await card({
      context: makeContext(),
      title: "t",
      children: async () => ["<p>a</p>", Promise.resolve("<p>b</p>")],
    });
    assert.ok(asyncKids.includes("<p>a</p><p>b</p>"));
  });

  it('wraps children in a grid for layout "columns" only', async () => {
    const columns = await card({
      context: makeContext(),
      title: "t",
      layout: "columns",
      children: ["<p>a</p>"],
    });
    assert.ok(columns.includes('<div class="grid gap-4 sm:grid-cols-2"><p>a</p></div>'));
    const stack = await card({
      context: makeContext(),
      title: "t",
      layout: "stack",
      children: ["<p>a</p>"],
    });
    assert.ok(!stack.includes("grid"));
    assert.ok(stack.includes("</h2><p>a</p>"));
    const absent = await card({ context: makeContext(), title: "t", children: ["<p>a</p>"] });
    assert.ok(!absent.includes("grid"));
  });
});

describe("title", () => {
  it("renders h1/h2/h3 with size classes", async () => {
    assert.match(
      await title({ context: makeContext(), text: "A", level: 1 }),
      /<h1 class="text-3xl font-bold">A<\/h1>/,
    );
    assert.match(
      await title({ context: makeContext(), text: "B", level: 2 }),
      /<h2 class="text-2xl font-bold">B<\/h2>/,
    );
    assert.match(
      await title({ context: makeContext(), text: "C", level: 3 }),
      /<h3 class="text-xl font-bold">C<\/h3>/,
    );
  });

  it("defaults to h2 and resolves descriptors", async () => {
    const html = await title({
      context: makeContext({ preferredLocales: ["nl"] }),
      text: message("Hello", { nl: "Hallo" }),
    });
    assert.match(html, /<h2 class="text-2xl font-bold">Hallo<\/h2>/);
  });

  it("escapes text and rejects invalid levels", async () => {
    const html = await title({ context: makeContext(), text: XSS });
    assert.ok(!html.includes("<img"));
    assert.ok(html.includes("&lt;img"));
    await assert.rejects(
      title({ context: makeContext(), text: "x", level: 4 as unknown as 1 }),
      RangeError,
    );
  });
});

describe("renderTextValue", () => {
  const ctx = makeContext();

  it("renders strings verbatim, escaped and isolated", () => {
    const out = renderTextValue("a&b", ctx);
    assert.equal(out, "⁨a&amp;b⁩");
  });

  it("renders booleans as true/false", () => {
    assert.equal(renderTextValue(true, ctx), "⁨true⁩");
    assert.equal(renderTextValue(false, ctx), "⁨false⁩");
  });

  it("renders bigint and safe-int numbers exactly with page locale", () => {
    assert.equal(renderTextValue(1234567n, ctx), "⁨1,234,567⁩");
    assert.equal(renderTextValue(42, ctx), "⁨42⁩");
    const de = makeContext({ preferredLocales: ["de"] });
    assert.equal(renderTextValue(1234567n, de), "⁨1.234.567⁩");
  });

  it("throws a TypeError naming {type, value} for non-integer numbers", () => {
    assert.throws(() => renderTextValue(1.5, ctx), /{type, value}/);
    assert.throws(() => renderTextValue(Number.NaN, ctx), TypeError);
    assert.throws(() => renderTextValue(1e21, ctx), TypeError);
  });

  it("renders descriptors with bound params", () => {
    const out = renderTextValue(
      message("{n, plural, one {# thing} other {# things}}", {}, {
        n: { type: "int", value: 2 },
      }),
      ctx,
    );
    assert.equal(out, "⁨2 things⁩");
  });

  it("renders typed scalar pairs with UTC and currency scales", () => {
    assert.equal(renderTextValue({ type: "decimal", value: "1234.50" }, ctx), "⁨1,234.5⁩");
    const money = makeContext({ currencyScales: { USD: 2 } });
    assert.equal(
      renderTextValue({ type: "money", value: { minor: 1234n, currency: "USD" } }, money),
      "⁨$12.34⁩",
    );
    assert.equal(
      renderTextValue({ type: "date", value: "2026-01-02" }, ctx),
      `⁨${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date("2026-01-02T00:00:00Z"))}⁩`,
    );
  });

  it("escapes scalar string values and returns empty for null/undefined", () => {
    const out = renderTextValue({ type: "text", value: XSS }, ctx);
    assert.ok(!out.includes("<script>"));
    assert.ok(out.includes("&lt;script&gt;"));
    assert.equal(renderTextValue(null, ctx), "");
    assert.equal(renderTextValue(undefined, ctx), "");
  });

  it("falls back to the app default when preferences are invalid", () => {
    const bad = makeContext({ preferredLocales: ["!!"], appDefaultLocale: "en" });
    assert.equal(renderTextValue(1234567n, bad), "⁨1,234,567⁩");
  });
});

describe("text", () => {
  it("space-joins every TextValue kind in one paragraph", async () => {
    const html = await text({
      context: makeContext(),
      values: [
        "hi",
        7,
        8n,
        true,
        message("Yo", {}),
        { type: "decimal", value: "1.5" },
        null,
        undefined,
      ],
    });
    assert.ok(html.startsWith("<p>"));
    assert.ok(html.endsWith("</p>"));
    for (const part of ["⁨hi⁩", "⁨7⁩", "⁨8⁩", "⁨true⁩", "⁨Yo⁩", "⁨1.5⁩"]) {
      assert.ok(html.includes(part), `missing ${part}`);
    }
  });

  it("propagates value errors and escapes content", async () => {
    await assert.rejects(text({ context: makeContext(), values: [1.5] }), TypeError);
    const html = await text({ context: makeContext(), values: [XSS] });
    assert.ok(!html.includes("<script>"));
  });
});

describe("content", () => {
  const ctx = makeContext();

  it("splits blank lines into paragraphs and single newlines into <br>", async () => {
    assert.equal(await content({ context: ctx, value: "Hello" }), "<p>Hello</p>");
    assert.equal(await content({ context: ctx, value: "a\nb" }), "<p>a<br>b</p>");
    assert.equal(await content({ context: ctx, value: "a\n\nb" }), "<p>a</p><p>b</p>");
    assert.equal(await content({ context: ctx, value: "a\r\n\r\nb" }), "<p>a</p><p>b</p>");
    assert.equal(
      await content({ context: ctx, value: "a\nline2\n\nb\nline2" }),
      "<p>a<br>line2</p><p>b<br>line2</p>",
    );
  });

  it("never emits raw HTML", async () => {
    const html = await content({ context: ctx, value: `<b>x</b>\n\n${XSS}` });
    assert.ok(!html.includes("<b>"));
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;"));
  });

  it("resolves descriptor values before splitting", async () => {
    const es = makeContext({ preferredLocales: ["es"] });
    const html = await content({
      context: es,
      value: message("one\n\ntwo", { es: "uno\n\ndos" }),
    });
    assert.equal(html, "<p>uno</p><p>dos</p>");
  });
});

describe("renderState", () => {
  const ctx = makeContext();

  it("loading renders a status region with spinner, skeleton and message", async () => {
    const html = await renderState({
      context: makeContext({ preferredLocales: ["nl"] }),
      kind: "loading",
      message: message("Loading…", { nl: "Laden…" }),
    });
    assert.ok(html.includes('role="status"'));
    assert.ok(html.includes("loading"));
    assert.ok(html.includes("skeleton"));
    assert.ok(html.includes("Laden…"));
  });

  it("empty renders a semantic text block", async () => {
    assert.equal(
      await renderState({ context: ctx, kind: "empty", message: "Nothing here" }),
      "<p>Nothing here</p>",
    );
  });

  it("error renders an alert with optional detail", async () => {
    const withDetail = await renderState({
      context: ctx,
      kind: "error",
      message: "Failed",
      detail: "Try again",
    });
    assert.ok(withDetail.includes("alert-error"));
    assert.ok(withDetail.includes("<p>Failed</p><p>Try again</p>"));
    const without = await renderState({ context: ctx, kind: "error", message: "Failed" });
    assert.equal(without, '<div class="alert alert-error" role="alert"><p>Failed</p></div>');
  });

  it("escapes state messages and details", async () => {
    for (const kind of ["loading", "empty", "error"] as const) {
      const html = await renderState({ context: ctx, kind, message: XSS, detail: XSS });
      assert.ok(!html.includes("<script>"), kind);
    }
  });
});

describe("rowHeading", () => {
  const ctx = makeContext();
  const caption: MessageValue = "Task";

  function row(fields: Record<string, unknown>, id = "r1"): RowView {
    return { id, fields };
  }

  it("prefers title, then name, then the model-caption fallback", () => {
    assert.equal(rowHeading(row({ title: "T", name: "N" }), caption, ctx), "T");
    assert.equal(rowHeading(row({ name: "N" }), caption, ctx), "N");
    assert.equal(rowHeading(row({}), caption, ctx), "Task r1");
  });

  it("skips whitespace-only and non-string fields", () => {
    assert.equal(rowHeading(row({ title: "   ", name: "N" }), caption, ctx), "N");
    assert.equal(rowHeading(row({ title: "  ", name: "\t" }), caption, ctx), "Task r1");
    assert.equal(rowHeading(row({ title: 42, name: "N" }), caption, ctx), "N");
  });

  it("resolves descriptor captions in the fallback and escapes output", () => {
    const es = makeContext({ preferredLocales: ["es"] });
    assert.equal(
      rowHeading(row({}), message("Task", { es: "Tarea" }), es),
      "Tarea r1",
    );
    const evil = rowHeading(row({ title: XSS }), caption, ctx);
    assert.ok(!evil.includes("<img"));
    assert.ok(evil.includes("&lt;img"));
    const evilId = rowHeading(row({}, "<b>id</b>"), caption, ctx);
    assert.ok(evilId.includes("&lt;b&gt;id&lt;/b&gt;"));
  });
});

describe("xss sweep", () => {
  it("no sink emits raw markup from one shared vector set", async () => {
    const ctx = makeContext();
    const vectors = [XSS, `"'><svg onload=alert(1)>`, "a&amp;b"];
    for (const vector of vectors) {
      const outputs = [
        await card({ context: ctx, title: vector, children: [] }),
        await title({ context: ctx, text: vector }),
        await text({ context: ctx, values: [vector] }),
        await content({ context: ctx, value: vector }),
        await renderState({ context: ctx, kind: "error", message: vector, detail: vector }),
        rowHeading({ id: "r", fields: { title: vector } }, vector, ctx),
        renderTextValue(vector, ctx),
      ];
      for (const out of outputs) {
        assert.ok(!out.includes("<script>"), vector);
        assert.ok(!out.includes("<svg"), vector);
        assert.ok(!out.includes("<img"), vector);
      }
    }
  });
});
