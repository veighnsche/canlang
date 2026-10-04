import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  AppearanceSize,
  HistoryEntry,
  PresentationContext,
} from "../../contracts/src/presentation.js";
import { message } from "../src/messages.js";
import { copy, history, tabs } from "../src/panels.js";
import { loadHtml } from "./harness.js";

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
const ALL_SIZES: ReadonlyArray<AppearanceSize> = ["xs", "sm", "md", "lg", "xl"];

function withExtra<T extends object>(props: T, extra: Record<string, unknown>): T {
  return { ...props, ...extra };
}

function makeEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    model: "expense.Expense" as HistoryEntry["model"],
    recordId: "rec-1" as HistoryEntry["recordId"],
    version: 2 as HistoryEntry["version"],
    operation: "expense.update" as HistoryEntry["operation"],
    operationId: "op-9" as HistoryEntry["operationId"],
    actor: "alice",
    at: Date.UTC(2026, 9, 1, 12, 0, 0),
    change: "update",
    before: { status: "draft" },
    after: { status: "filed" },
    ...overrides,
  };
}

describe("tabs", () => {
  it("renders radio-driven panels with tablist semantics", async () => {
    const html = await tabs({
      context: makeContext(),
      caption: "Views",
      items: [
        { value: "a", caption: "First", children: ["<p>Alpha</p>"] },
        { value: "b", caption: "Second", children: ["<p>Beta</p>"] },
      ],
    });
    assert.ok(html.includes(`<div class="tabs" role="tablist" aria-label="Views">`), html);
    assert.ok(html.includes(`type="radio" class="tab" role="tab"`), html);
    assert.ok(html.includes(`aria-label="First"`), html);
    assert.ok(html.includes(`<div class="tab-content" role="tabpanel"`), html);
    assert.ok(html.includes("<p>Alpha</p>"), html);
    assert.ok(html.includes("<p>Beta</p>"), html);
    // First tab selected by default.
    assert.equal((html.match(/ checked/g) ?? []).length, 1);
    assert.ok(html.includes('aria-selected="true" aria-controls="tabs-panel-0" checked'), html);
  });

  it("honours an explicit open item", async () => {
    const html = await tabs({
      context: makeContext(),
      items: [
        { value: "a", caption: "First", children: ["A"] },
        { value: "b", caption: "Second", children: ["B"], open: true },
      ],
    });
    assert.ok(html.includes('value="b" aria-label="Second" aria-selected="true"'), html);
    assert.ok(html.includes('value="a" aria-label="First" aria-selected="false"'), html);
  });

  it("maps every admitted size onto the container only", async () => {
    for (const size of ALL_SIZES) {
      const html = await tabs({
        context: makeContext(),
        size,
        items: [{ value: "a", caption: "A", children: ["A"] }],
      });
      assert.ok(html.includes(`<div class="tabs tabs-${size}"`), `${size}: ${html}`);
      assert.ok(!html.includes(`tab-${size}`), `${size}: ${html}`);
    }
  });

  it("treats solid as the bare base and rejects unadmitted tokens", async () => {
    const html = await tabs(
      withExtra(
        { context: makeContext(), items: [{ value: "a", caption: "A", children: ["A"] }] },
        { variant: "solid" },
      ),
    );
    assert.ok(html.includes(`<div class="tabs"`), html);
    await assert.rejects(
      tabs(
        withExtra(
          { context: makeContext(), items: [{ value: "a", caption: "A", children: ["A"] }] },
          { tone: "primary" },
        ),
      ),
      /does not admit tone/,
    );
    await assert.rejects(
      tabs(
        withExtra(
          { context: makeContext(), items: [{ value: "a", caption: "A", children: ["A"] }] },
          { orientation: "vertical" },
        ),
      ),
      /does not admit orientation/,
    );
    await assert.rejects(
      tabs(
        withExtra(
          { context: makeContext(), items: [{ value: "a", caption: "A", children: ["A"] }] },
          { size: "huge" },
        ),
      ),
      /does not admit size/,
    );
  });

  it("binds selection to an owned enum preference posting to the caller path", async () => {
    const html = await tabs({
      context: makeContext(),
      caption: "Views",
      binding: {
        name: "view",
        options: [
          { value: "a", label: "First" },
          { value: "b", label: "Second" },
        ],
        current: "b",
        postTo: "/prefs/view",
      },
      items: [
        { value: "a", caption: "First", children: ["A"] },
        { value: "b", caption: "Second", children: ["B"] },
      ],
    });
    assert.ok(html.includes(`<form action="/prefs/view" method="post">`), html);
    assert.ok(html.includes(`name="view" value="a"`), html);
    assert.ok(html.includes(`name="view" value="b"`), html);
    assert.ok(html.includes('value="b" aria-label="Second" aria-selected="true"'), html);
    assert.ok(html.includes(`name="_csrf" value="csrf-123"`), html);
    assert.ok(html.includes(`<button type="submit" class="btn btn-primary">Save</button>`), html);
  });

  it("renders a selector-only bound tabset without panels", async () => {
    const html = await tabs({
      context: makeContext(),
      caption: "Views",
      binding: {
        name: "view",
        options: [{ value: "a", label: "First" }],
        postTo: "/prefs/view",
      },
    });
    assert.ok(html.includes(`<form action="/prefs/view" method="post">`), html);
    assert.ok(html.includes("<fieldset>"), html);
    assert.ok(!html.includes("tab-content"), html);
  });

  it("prefers an explicit open item over the bound current value", async () => {
    const html = await tabs({
      context: makeContext(),
      binding: {
        name: "view",
        options: [
          { value: "a", label: "First" },
          { value: "b", label: "Second" },
        ],
        current: "b",
        postTo: "/prefs/view",
      },
      items: [
        { value: "a", caption: "First", children: ["A"], open: true },
        { value: "b", caption: "Second", children: ["B"] },
      ],
    });
    assert.ok(html.includes('value="a" aria-label="First" aria-selected="true"'), html);
    assert.ok(html.includes('value="b" aria-label="Second" aria-selected="false"'), html);
  });

  it("rejects duplicate binding options", async () => {
    await assert.rejects(
      tabs({
        context: makeContext(),
        binding: {
          name: "view",
          options: [
            { value: "a", label: "First" },
            { value: "a", label: "Again" },
          ],
          postTo: "/prefs/view",
        },
        items: [{ value: "a", caption: "First", children: ["A"] }],
      }),
      /duplicate option/,
    );
  });

  it("keeps two tabsets disjoint under distinct ids", async () => {
    const first = await tabs({
      context: makeContext(),
      id: "nav",
      items: [{ value: "a", caption: "A", children: ["A"] }],
    });
    const second = await tabs({
      context: makeContext(),
      id: "prefs",
      items: [{ value: "a", caption: "A", children: ["A"] }],
    });
    assert.ok(first.includes('id="nav-tab-0"'), first);
    assert.ok(first.includes('aria-controls="nav-panel-0"'), first);
    assert.ok(!first.includes("prefs-"), first);
    assert.ok(second.includes('id="prefs-tab-0"'), second);
    assert.ok(!second.includes("nav-"), second);
  });

  it("namespaces same-preference bound sets under distinct ids", async () => {
    const binding = {
      name: "view",
      options: [{ value: "a", label: "First" }],
      postTo: "/prefs/view",
    };
    const first = await tabs({
      context: makeContext(),
      id: "left",
      binding,
      items: [{ value: "a", caption: "First", children: ["A"] }],
    });
    const second = await tabs({
      context: makeContext(),
      id: "right",
      binding,
      items: [{ value: "a", caption: "First", children: ["A"] }],
    });
    assert.ok(first.includes('name="view"'), first);
    assert.ok(first.includes('id="left-panel-0"'), first);
    assert.ok(!first.includes("right-"), first);
    assert.ok(second.includes('id="right-panel-0"'), second);
    assert.ok(!second.includes("left-"), second);
  });

  it("fails closed on missing suites, mismatches and bad bindings", async () => {
    await assert.rejects(tabs({ context: makeContext() }), /suite or a selector binding/);
    await assert.rejects(tabs({ context: makeContext(), items: [] }), /suite or a selector binding/);
    await assert.rejects(
      tabs({
        context: makeContext(),
        binding: { name: "v", options: [], postTo: "/p" },
        items: [{ value: "a", caption: "A", children: ["A"] }],
      }),
      /nonempty options/,
    );
    await assert.rejects(
      tabs({
        context: makeContext(),
        binding: { name: "v", options: [{ value: "a", label: "A" }], current: "zzz", postTo: "/p" },
        items: [{ value: "a", caption: "A", children: ["A"] }],
      }),
      /not a listed option/,
    );
    await assert.rejects(
      tabs({
        context: makeContext(),
        binding: { name: "v", options: [{ value: "a", label: "A" }], postTo: "/p" },
        items: [{ value: "zzz", caption: "Z", children: ["Z"] }],
      }),
      /not a listed option/,
    );
    await assert.rejects(
      tabs({
        context: makeContext(),
        binding: {
          name: "v",
          options: [
            { value: "a", label: "A" },
            { value: "b", label: "B" },
          ],
          postTo: "/p",
        },
        items: [{ value: "a", caption: "A", children: ["A"] }],
      }),
      /has no tab panel/,
    );
    await assert.rejects(
      tabs({
        context: makeContext(),
        binding: { name: "", options: [{ value: "a", label: "A" }], postTo: "/p" },
      }),
      /non-empty binding name/,
    );
    await assert.rejects(
      tabs({
        context: makeContext(),
        binding: { name: "v", options: [{ value: "a", label: "A" }], postTo: "  " },
      }),
      /non-empty binding postTo/,
    );
    await assert.rejects(
      tabs({
        context: makeContext(),
        items: [
          { value: "a", caption: "A", children: ["A"], open: true },
          { value: "b", caption: "B", children: ["B"], open: true },
        ],
      }),
      /at most one open/,
    );
    await assert.rejects(
      tabs({
        context: makeContext(),
        items: [{ value: "a", caption: "A", children: [] }],
      }),
      /nonempty content suite/,
    );
    await assert.rejects(
      tabs({
        context: makeContext(),
        caption: "",
        items: [{ value: "a", caption: "A", children: ["A"] }],
      }),
      /caption must not be empty/,
    );
  });

  it("resolves captions in locale order", async () => {
    const caption = message("Views", { nl: "Weergaven" });
    const en = await tabs({
      context: makeContext(),
      caption,
      items: [{ value: "a", caption: message("First", { nl: "Eerste" }), children: ["A"] }],
    });
    assert.ok(en.includes('aria-label="Views"'), en);
    assert.ok(en.includes('aria-label="First"'), en);
    const nl = await tabs({
      context: makeContext({ preferredLocales: ["nl"] }),
      caption,
      items: [{ value: "a", caption: message("First", { nl: "Eerste" }), children: ["A"] }],
    });
    assert.ok(nl.includes('aria-label="Weergaven"'), nl);
    assert.ok(nl.includes('aria-label="Eerste"'), nl);
  });

  it("escapes hostile captions and values", async () => {
    const html = await tabs({
      context: makeContext(),
      caption: XSS,
      items: [{ value: `a"b`, caption: XSS, children: ["A"] }],
    });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
    assert.ok(html.includes('value="a&quot;b"'), html);
  });

  it("exposes tablist semantics in the DOM", async () => {
    const html = await tabs({
      context: makeContext(),
      caption: "Views",
      id: "views",
      binding: {
        name: "view",
        options: [
          { value: "a", label: "First" },
          { value: "b", label: "Second" },
        ],
        postTo: "/prefs/view",
      },
      items: [
        { value: "a", caption: "First", children: ["<p>Alpha</p>"] },
        { value: "b", caption: "Second", children: ["<p>Beta</p>"] },
      ],
    });
    const page = await loadHtml(html);
    try {
      const form = page.document.querySelector("form");
      assert.ok(form, "bound form present");
      assert.equal(form.getAttribute("action"), "/prefs/view");
      const list = page.document.querySelector('[role="tablist"]');
      assert.ok(list, "tablist present");
      assert.equal(list.getAttribute("aria-label"), "Views");
      const tabNodes = page.document.querySelectorAll('[role="tab"]');
      assert.equal(tabNodes.length, 2);
      const selected = page.document.querySelector('[role="tab"][aria-selected="true"]');
      assert.ok(selected, "one tab selected");
      const panelId = selected.getAttribute("aria-controls");
      assert.ok(panelId, "selected tab controls a panel");
      const panel = page.document.getElementById(panelId);
      assert.ok(panel, "controlled panel present");
      assert.equal(panel.getAttribute("role"), "tabpanel");
    } finally {
      await page.close();
    }
  });
});

describe("history", () => {
  it("renders entries as collapse groups with meta and before/after scalars", async () => {
    const html = await history({ context: makeContext(), entries: [makeEntry()] });
    assert.ok(html.startsWith("<ul>"), html);
    assert.ok(html.includes("<li>"), html);
    assert.ok(html.includes("collapse"), html);
    assert.ok(html.includes("expense.update"), html);
    assert.ok(html.includes("alice"), html);
    assert.ok(html.includes("2026-10-01T12:00:00.000Z"), html);
    assert.ok(html.includes("<time"), html);
    assert.ok(html.includes(">update</dd>"), html);
    assert.ok(html.includes(">Before</h3>"), html);
    assert.ok(html.includes(">After</h3>"), html);
    assert.ok(html.includes(">draft</dd>"), html);
    assert.ok(html.includes(">filed</dd>"), html);
  });

  it("omits null before/after sections and formats int/bool scalars", async () => {
    const html = await history({
      context: makeContext(),
      entries: [
        makeEntry({ change: "create", before: null, after: { seats: 4, active: true } }),
      ],
    });
    assert.ok(!html.includes(">Before</h3>"), html);
    assert.ok(html.includes(">After</h3>"), html);
    assert.ok(html.includes(">4</dd>"), html);
    assert.ok(html.includes(">true</dd>"), html);
  });

  it("fails closed on empty suites and non-scalar values", async () => {
    await assert.rejects(history({ context: makeContext(), entries: [] }), /nonempty entries/);
    await assert.rejects(
      history({
        context: makeContext(),
        entries: [makeEntry({ after: { nested: { deep: true } } })],
      }),
      /not a scalar/,
    );
    await assert.rejects(
      history({
        context: makeContext(),
        entries: [makeEntry({ after: { list: [1, 2] } })],
      }),
      /not a scalar/,
    );
    await assert.rejects(
      history({ context: makeContext(), entries: [makeEntry({ at: Number.NaN })] }),
      /not a valid timestamp/,
    );
    await assert.rejects(
      history(
        withExtra({ context: makeContext(), entries: [makeEntry()] }, { tone: "primary" }),
      ),
      /admits no appearance/,
    );
  });

  it("resolves structural captions in locale order", async () => {
    const nl = await history({
      context: makeContext({ preferredLocales: ["nl"] }),
      entries: [makeEntry()],
    });
    assert.ok(nl.includes(">Bewerking</dt>"), nl);
    assert.ok(nl.includes(">Voor</h3>"), nl);
    assert.ok(nl.includes(">Na</h3>"), nl);
  });

  it("escapes hostile actors, operations and field values", async () => {
    const html = await history({
      context: makeContext(),
      entries: [
        makeEntry({
          operation: XSS as HistoryEntry["operation"],
          actor: XSS,
          after: { "<b>k</b>": XSS },
        }),
      ],
    });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
    assert.ok(html.includes("&lt;b&gt;k&lt;/b&gt;"), html);
  });

  it("exposes list structure in the DOM", async () => {
    const html = await history({
      context: makeContext(),
      caption: "Audit",
      entries: [makeEntry(), makeEntry({ recordId: "rec-2" as HistoryEntry["recordId"], actor: "bob" })],
    });
    const page = await loadHtml(html);
    try {
      const list = page.document.querySelector("ul");
      assert.ok(list, "list present");
      assert.equal(list.getAttribute("aria-label"), "Audit");
      assert.equal(list.querySelectorAll(":scope > li").length, 2);
      assert.ok(list.querySelector("details.collapse"), "collapse group present");
      assert.ok(list.querySelector("summary.collapse-title"), "collapse title present");
    } finally {
      await page.close();
    }
  });
});

describe("copy", () => {
  it("renders a readonly selectable input with its label", async () => {
    const html = await copy({ context: makeContext(), value: "TOKEN-1", label: "API token" });
    assert.ok(html.includes("<label>API token"), html);
    assert.ok(html.includes(`<input type="text" class="input" readonly value="TOKEN-1">`), html);
    assert.ok(!html.includes("<button"), html);
    assert.ok(!html.includes("clipboard"), html.toLowerCase());
  });

  it("associates label and input by id when given", async () => {
    const html = await copy({
      context: makeContext(),
      value: "v",
      label: "Key",
      id: "api-key",
    });
    assert.ok(html.includes(`<label for="api-key">Key</label>`), html);
    assert.ok(html.includes(`id="api-key" readonly`), html);
  });

  it("fails closed on missing labels and non-string values", async () => {
    await assert.rejects(copy({ context: makeContext(), value: "v", label: "" }), /must not be empty/);
    await assert.rejects(
      copy({ context: makeContext(), value: 42 as unknown as string, label: "K" }),
      /must be a string/,
    );
    await assert.rejects(
      copy(withExtra({ context: makeContext(), value: "v", label: "K" }, { size: "lg" })),
      /admits no appearance/,
    );
  });

  it("resolves labels in locale order and escapes hostile text", async () => {
    const nl = await copy({
      context: makeContext({ preferredLocales: ["nl"] }),
      value: "v",
      label: message("API token", { nl: "API-sleutel" }),
    });
    assert.ok(nl.includes("API-sleutel"), nl);
    const html = await copy({ context: makeContext(), value: XSS, label: XSS });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
    assert.ok(!html.includes("<img"), html);
  });

  it("exposes a focusable readonly input in the DOM", async () => {
    const html = await copy({ context: makeContext(), value: "TOKEN-1", label: "API token" });
    const page = await loadHtml(html);
    try {
      const input = page.document.querySelector("input.input") as unknown as {
        readOnly: boolean;
        disabled: boolean;
        value: string;
        focus: () => void;
      } | null;
      assert.ok(input, "input present");
      assert.equal(input.readOnly, true);
      assert.equal(input.disabled, false);
      assert.equal(input.value, "TOKEN-1");
      input.focus();
      assert.equal(page.document.activeElement, input as never);
      assert.equal(page.document.querySelector("label")?.textContent, "API token");
    } finally {
      await page.close();
    }
  });
});
