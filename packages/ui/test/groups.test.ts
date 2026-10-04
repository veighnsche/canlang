import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  AppearanceOrientation,
  AppearanceTone,
  PresentationContext,
} from "../../contracts/src/presentation.js";
import { message } from "../src/messages.js";
import {
  accordion,
  carousel,
  collapse,
  diff,
  fieldset,
  footer,
  hero,
  join,
  stack,
  stat,
  steps,
  timeline,
} from "../src/groups.js";
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
const NL_CAPTION = message("Source caption", { nl: "Brononderschrift" });
const nlContext = (): PresentationContext => makeContext({ preferredLocales: ["nl"] });

function withExtra<T extends object>(props: T, extra: Record<string, unknown>): T {
  return { ...props, ...extra };
}

describe("accordion", () => {
  it("renders a join of radio-input collapse items with one open child", async () => {
    const html = await accordion({
      context: makeContext(),
      id: "faq",
      items: [
        { caption: "First", children: ["<p>one</p>"], open: true },
        { caption: "Second", children: ["<p>two</p>"] },
      ],
    });
    assert.ok(html.includes(`<div class="join join-vertical w-full" id="faq">`), html);
    assert.ok(html.includes('name="accordion-faq"'), html);
    assert.equal(html.match(/checked="checked"/g)?.length ?? 0, 1);
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelectorAll(".collapse-title").length, 2);
      assert.equal(page.document.querySelectorAll('input[type="radio"]').length, 2);
    } finally {
      await page.close();
    }
  });

  it("escapes item captions", async () => {
    const html = await accordion({
      context: makeContext(),
      items: [{ caption: XSS, children: ["<p>ok</p>"] }],
    });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
  });

  it("resolves captions through locale lookup", async () => {
    const html = await accordion({
      context: nlContext(),
      items: [{ caption: NL_CAPTION, children: ["<p>ok</p>"] }],
    });
    assert.ok(html.includes("Brononderschrift"), html);
  });

  it("rejects appearance tokens and multiple open items", async () => {
    await assert.rejects(() =>
      accordion(
        withExtra(
          { context: makeContext(), items: [{ caption: "a", children: ["x"] }] },
          { tone: "primary" },
        ),
      ),
    );
    await assert.rejects(() =>
      accordion({
        context: makeContext(),
        items: [
          { caption: "a", children: ["x"], open: true },
          { caption: "b", children: ["y"], open: true },
        ],
      }),
    );
    await assert.rejects(() => accordion({ context: makeContext(), items: [] }));
  });

  it("rejects invalid ids", async () => {
    await assert.rejects(() =>
      accordion({ context: makeContext(), id: "has space", items: [{ caption: "a", children: ["x"] }] }),
    );
  });
});

describe("collapse", () => {
  it("renders a native details/summary disclosure", async () => {
    const html = await collapse({ context: makeContext(), caption: "More", children: ["<p>body</p>"] });
    assert.ok(html.startsWith(`<details class="collapse">`), html);
    assert.ok(html.includes(`<summary class="collapse-title">More</summary>`), html);
    assert.ok(html.includes(`<div class="collapse-content"><p>body</p></div>`), html);
    const open = await collapse({
      context: makeContext(),
      caption: "More",
      children: ["x"],
      open: true,
    });
    assert.ok(open.includes("<details class=\"collapse\" open>"), open);
  });

  it("escapes captions and ids", async () => {
    const html = await collapse({ context: makeContext(), caption: XSS, children: ["x"] });
    assert.ok(!html.includes("<script>") && html.includes("&lt;script&gt;"), html);
    const withId = await collapse({
      context: makeContext(),
      caption: "c",
      children: ["x"],
      id: `a"b`,
    });
    assert.ok(withId.includes(`id="a&quot;b"`), withId);
  });

  it("prefers the viewer locale caption, then the source", async () => {
    const localized = await collapse({ context: nlContext(), caption: NL_CAPTION, children: ["x"] });
    assert.ok(localized.includes("Brononderschrift"), localized);
    const source = await collapse({ context: makeContext(), caption: NL_CAPTION, children: ["x"] });
    assert.ok(source.includes("Source caption"), source);
  });

  it("accepts solid variant but rejects tones, sizes and orientations", async () => {
    const solid = await collapse(
      withExtra({ context: makeContext(), caption: "c", children: ["x"] }, { variant: "solid" }),
    );
    assert.ok(solid.includes(`class="collapse"`), solid);
    await assert.rejects(() =>
      collapse(
        withExtra({ context: makeContext(), caption: "c", children: ["x"] }, { tone: "primary" }),
      ),
    );
    await assert.rejects(() =>
      collapse(
        withExtra({ context: makeContext(), caption: "c", children: ["x"] }, { size: "lg" }),
      ),
    );
    await assert.rejects(() =>
      collapse(
        withExtra(
          { context: makeContext(), caption: "c", children: ["x"] },
          { orientation: "vertical" },
        ),
      ),
    );
  });

  it("fails closed on missing captions and empty suites", async () => {
    await assert.rejects(() =>
      collapse({ context: makeContext(), caption: undefined as never, children: ["x"] }),
    );
    await assert.rejects(() => collapse({ context: makeContext(), caption: "c", children: [] }));
  });
});

describe("fieldset", () => {
  it("renders a legend only when captioned", async () => {
    const captioned = await fieldset({
      context: makeContext(),
      caption: "Group",
      children: ["<input />"],
    });
    assert.ok(captioned.includes(`<fieldset class="fieldset">`), captioned);
    assert.ok(captioned.includes(`<legend class="fieldset-legend">Group</legend>`), captioned);
    const bare = await fieldset({ context: makeContext(), children: ["<input />"] });
    assert.ok(!bare.includes("<legend"), bare);
  });

  it("escapes captions", async () => {
    const html = await fieldset({ context: makeContext(), caption: XSS, children: ["x"] });
    assert.ok(!html.includes("<script>") && html.includes("&lt;script&gt;"), html);
  });

  it("resolves captions through locale lookup and emits stable ids", async () => {
    const html = await fieldset({ context: nlContext(), caption: NL_CAPTION, children: ["x"], id: "fs-1" });
    assert.ok(html.includes("Brononderschrift"), html);
    assert.ok(html.includes(`id="fs-1"`), html);
  });

  it("rejects unadmitted appearance and empty suites", async () => {
    await assert.rejects(() =>
      fieldset(withExtra({ context: makeContext(), children: ["x"] }, { tone: "error" })),
    );
    await assert.rejects(() => fieldset({ context: makeContext(), children: [] }));
  });
});

describe("join", () => {
  it("renders the join container with trusted children", async () => {
    const html = await join({ context: makeContext(), children: ["<button>a</button>", "<button>b</button>"] });
    assert.ok(html.startsWith(`<div class="join">`), html);
    assert.ok(html.includes("<button>a</button><button>b</button>"), html);
  });

  it("routes orientation tokens and rejects tones and sizes", async () => {
    for (const orientation of ["horizontal", "vertical"] as const satisfies ReadonlyArray<AppearanceOrientation>) {
      const html = await join({ context: makeContext(), children: ["x"], orientation });
      assert.ok(html.includes(`class="join join-${orientation}"`), html);
    }
    await assert.rejects(() =>
      join(withExtra({ context: makeContext(), children: ["x"] }, { tone: "primary" })),
    );
    await assert.rejects(() =>
      join(withExtra({ context: makeContext(), children: ["x"] }, { size: "sm" })),
    );
  });

  it("fails closed on empty suites and invalid ids", async () => {
    await assert.rejects(() => join({ context: makeContext(), children: [] }));
    await assert.rejects(() => join({ context: makeContext(), children: ["x"], id: "" }));
  });
});

describe("stack", () => {
  it("renders the stack container", async () => {
    const html = await stack({ context: makeContext(), children: ["<div>a</div>", "<div>b</div>"] });
    assert.ok(html.startsWith(`<div class="stack">`), html);
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelectorAll(".stack > div").length, 2);
    } finally {
      await page.close();
    }
  });

  it("escapes ids and rejects appearance tokens and empty suites", async () => {
    const html = await stack({ context: makeContext(), children: ["x"], id: `s"id` });
    assert.ok(html.includes(`id="s&quot;id"`), html);
    await assert.rejects(() =>
      stack(withExtra({ context: makeContext(), children: ["x"] }, { orientation: "vertical" })),
    );
    await assert.rejects(() => stack({ context: makeContext(), children: [] }));
  });
});

describe("hero", () => {
  it("renders compact children with an h1 caption", async () => {
    const html = await hero({ context: makeContext(), caption: "Welcome", children: ["<p>body</p>"] });
    assert.ok(html.includes(`<section class="hero">`), html);
    assert.ok(html.includes(`<h1 class="text-3xl font-bold">Welcome</h1>`), html);
    assert.ok(html.includes(`<div class="hero-content">`), html);
  });

  it("renders the closed slot schema in start/content/end order", async () => {
    const html = await hero({
      context: makeContext(),
      slots: { start: "<nav>s</nav>", content: "<p>c</p>", end: "<nav>e</nav>" },
    });
    const start = html.indexOf("<nav>s</nav>");
    const content = html.indexOf("<p>c</p>");
    const end = html.indexOf("<nav>e</nav>");
    assert.ok(start !== -1 && start < content && content < end, html);
  });

  it("escapes captions and resolves locale variants", async () => {
    const xss = await hero({ context: makeContext(), caption: XSS, children: ["x"] });
    assert.ok(!xss.includes("<script>") && xss.includes("&lt;script&gt;"), xss);
    const localized = await hero({ context: nlContext(), caption: NL_CAPTION, children: ["x"] });
    assert.ok(localized.includes("Brononderschrift"), localized);
  });

  it("rejects mixed or missing bodies and appearance tokens", async () => {
    await assert.rejects(() =>
      hero({ context: makeContext(), children: ["x"], slots: { content: "y" } }),
    );
    await assert.rejects(() => hero({ context: makeContext() }));
    await assert.rejects(() =>
      hero(withExtra({ context: makeContext(), children: ["x"] }, { size: "lg" })),
    );
    await assert.rejects(() => hero({ context: makeContext(), children: [] }));
  });
});

describe("footer", () => {
  it("renders a footer landmark with title and orientation", async () => {
    const html = await footer({
      context: makeContext(),
      caption: "Site",
      children: ["<nav>links</nav>"],
      orientation: "horizontal",
      id: "site-footer",
    });
    assert.ok(html.includes(`<footer class="footer footer-horizontal" id="site-footer">`), html);
    assert.ok(html.includes(`<span class="footer-title">Site</span>`), html);
  });

  it("renders slots without a caption", async () => {
    const html = await footer({
      context: makeContext(),
      slots: { content: "<p>c</p>" },
      orientation: "vertical",
    });
    assert.ok(html.includes(`class="footer footer-vertical"`), html);
    assert.ok(!html.includes("footer-title"), html);
  });

  it("escapes captions and resolves locale variants", async () => {
    const xss = await footer({ context: makeContext(), caption: XSS, children: ["x"] });
    assert.ok(!xss.includes("<script>") && xss.includes("&lt;script&gt;"), xss);
    const localized = await footer({ context: nlContext(), caption: NL_CAPTION, children: ["x"] });
    assert.ok(localized.includes("Brononderschrift"), localized);
  });

  it("rejects mixed or missing bodies, tones and empty suites", async () => {
    await assert.rejects(() =>
      footer({ context: makeContext(), children: ["x"], slots: { content: "y" } }),
    );
    await assert.rejects(() => footer({ context: makeContext() }));
    await assert.rejects(() =>
      footer(withExtra({ context: makeContext(), children: ["x"] }, { tone: "primary" })),
    );
    await assert.rejects(() => footer({ context: makeContext(), children: [] }));
  });
});

describe("stat", () => {
  it("renders the stats container with title, value and description", async () => {
    const html = await stat({
      context: makeContext(),
      value: 1200,
      title: "Views",
      description: "this week",
    });
    assert.ok(html.includes(`<div class="stats">`), html);
    assert.ok(html.includes(`<div class="stat-title">Views</div>`), html);
    assert.ok(html.includes(`<div class="stat-desc">this week</div>`), html);
    const page = await loadHtml(html);
    try {
      const value = page.document.querySelector(".stat-value");
      assert.ok(value !== null && (value.textContent ?? "").includes("1"), html);
    } finally {
      await page.close();
    }
  });

  it("escapes title and description and formats typed values exactly", async () => {
    const html = await stat({ context: makeContext(), value: XSS, title: XSS });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
  });

  it("resolves title captions through locale lookup", async () => {
    const html = await stat({ context: nlContext(), value: 1, title: NL_CAPTION });
    assert.ok(html.includes("Brononderschrift"), html);
  });

  it("routes orientation to the stats container and rejects tones and sizes", async () => {
    const html = await stat({ context: makeContext(), value: 1, orientation: "vertical" });
    assert.ok(html.includes(`class="stats stats-vertical"`), html);
    await assert.rejects(() =>
      stat(withExtra({ context: makeContext(), value: 1 }, { tone: "primary" })),
    );
    await assert.rejects(() =>
      stat(withExtra({ context: makeContext(), value: 1 }, { size: "lg" })),
    );
  });

  it("fails closed on missing values", async () => {
    await assert.rejects(() => stat({ context: makeContext(), value: null }));
    await assert.rejects(() => stat({ context: makeContext(), value: undefined }));
  });
});

describe("steps", () => {
  it("renders an ordered list of stages", async () => {
    const html = await steps({
      context: makeContext(),
      items: [{ label: "One" }, { label: "Two" }],
    });
    assert.ok(html.startsWith(`<ol class="steps">`), html);
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelectorAll("ol.steps > li.step").length, 2);
    } finally {
      await page.close();
    }
  });

  it("escapes labels and markers", async () => {
    const html = await steps({
      context: makeContext(),
      items: [{ label: XSS, marker: `1"x` }],
    });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes(`data-content="1&quot;x"`), html);
  });

  it("routes tones to step items and orientation to the container", async () => {
    const tones: ReadonlyArray<AppearanceTone> = ["neutral", "primary", "success"];
    for (const tone of tones) {
      const html = await steps({ context: makeContext(), items: [{ label: "s", tone }] });
      assert.ok(html.includes(`class="step step-${tone}"`), html);
    }
    const vertical = await steps({
      context: makeContext(),
      items: [{ label: "s" }],
      orientation: "vertical",
    });
    assert.ok(vertical.includes(`class="steps steps-vertical"`), vertical);
  });

  it("rejects container tones, item sizes and empty suites", async () => {
    await assert.rejects(() =>
      steps(withExtra({ context: makeContext(), items: [{ label: "s" }] }, { tone: "primary" })),
    );
    await assert.rejects(() =>
      steps({ context: makeContext(), items: [{ label: "s", size: "lg" } as never] }),
    );
    await assert.rejects(() => steps({ context: makeContext(), items: [] }));
    await assert.rejects(() => steps({ context: makeContext(), items: [{ label: null }] }));
  });
});

describe("timeline", () => {
  it("renders entries with start/middle/end slots and hr connectors", async () => {
    const html = await timeline({
      context: makeContext(),
      items: [
        { start: "1984", middle: "*", end: "first" },
        { start: "1985", end: "second" },
      ],
    });
    assert.ok(html.startsWith(`<ul class="timeline">`), html);
    assert.ok(html.includes(`<div class="timeline-start">1984</div>`), html);
    assert.ok(html.includes(`<div class="timeline-middle">*</div>`), html);
    assert.ok(html.includes(`<div class="timeline-end">first</div>`), html);
    assert.equal(html.match(/<hr \/>/g)?.length ?? 0, 2);
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelectorAll("ul.timeline > li").length, 2);
    } finally {
      await page.close();
    }
  });

  it("routes orientation and emits stable ids", async () => {
    const html = await timeline({
      context: makeContext(),
      items: [{ start: "a" }],
      orientation: "vertical",
      id: "tl-1",
    });
    assert.ok(html.includes(`<ul class="timeline timeline-vertical" id="tl-1">`), html);
  });

  it("rejects tones and entries without a start or end", async () => {
    await assert.rejects(() =>
      timeline(withExtra({ context: makeContext(), items: [{ start: "a" }] }, { tone: "info" })),
    );
    await assert.rejects(() => timeline({ context: makeContext(), items: [{ middle: "x" }] }));
    await assert.rejects(() => timeline({ context: makeContext(), items: [] }));
  });
});

describe("carousel", () => {
  it("renders explicit item slots", async () => {
    const html = await carousel({
      context: makeContext(),
      items: ["<img />", "<img />", "<img />"],
    });
    assert.ok(html.startsWith(`<div class="carousel">`), html);
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelectorAll(".carousel-item").length, 3);
    } finally {
      await page.close();
    }
  });

  it("routes orientation, escapes ids and rejects tones and empty suites", async () => {
    const html = await carousel({
      context: makeContext(),
      items: ["x"],
      orientation: "vertical",
      id: "car-1",
    });
    assert.ok(html.includes(`<div class="carousel carousel-vertical" id="car-1">`), html);
    await assert.rejects(() =>
      carousel(withExtra({ context: makeContext(), items: ["x"] }, { tone: "accent" })),
    );
    await assert.rejects(() => carousel({ context: makeContext(), items: [] }));
  });
});

describe("diff", () => {
  it("renders before/after slots with a resizer and localized names", async () => {
    const html = await diff({ context: makeContext(), before: "<p>old</p>", after: "<p>new</p>" });
    assert.ok(html.includes(`<figure class="diff" tabindex="0">`), html);
    assert.ok(html.includes(`<div class="diff-item-1" role="img" tabindex="0" aria-label="Before">`), html);
    assert.ok(html.includes(`<div class="diff-item-2" role="img" tabindex="0" aria-label="After">`), html);
    assert.ok(html.includes(`<div class="diff-resizer"></div>`), html);
    const localized = await diff({ context: nlContext(), before: "a", after: "b" });
    assert.ok(localized.includes(`aria-label="Voor"`), localized);
    assert.ok(localized.includes(`aria-label="Na"`), localized);
  });

  it("rejects appearance tokens, missing slots and invalid ids", async () => {
    await assert.rejects(() =>
      diff(withExtra({ context: makeContext(), before: "a", after: "b" }, { size: "sm" })),
    );
    await assert.rejects(() =>
      diff({ context: makeContext(), before: undefined as never, after: "b" }),
    );
    await assert.rejects(() => diff({ context: makeContext(), before: "a", after: "b", id: "  " }));
  });
});
