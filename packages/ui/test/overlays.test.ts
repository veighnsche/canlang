import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  AppearanceSize,
  AppearanceTone,
  MessageValue,
  PresentationContext,
} from "../../contracts/src/presentation.js";
import { message } from "../src/messages.js";
import {
  alert,
  aura,
  chatBubble,
  drawer,
  dropdown,
  fab,
  hover3d,
  hoverGallery,
  indicator,
  mask,
  modal,
  swap,
  toast,
  tooltip,
} from "../src/overlays.js";
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
const ALL_TONES: ReadonlyArray<AppearanceTone> = [
  "neutral",
  "primary",
  "secondary",
  "accent",
  "info",
  "success",
  "warning",
  "error",
];
const ALERT_TONES: ReadonlyArray<AppearanceTone> = ["info", "success", "warning", "error"];
const ALL_SIZES: ReadonlyArray<AppearanceSize> = ["xs", "sm", "md", "lg", "xl"];

function withExtra<T extends object>(props: T, extra: Record<string, unknown>): T {
  return { ...props, ...extra };
}

describe("alert", () => {
  it("renders a value leaf with role=alert", async () => {
    const html = await alert({ context: makeContext(), value: "Saved" });
    assert.ok(html.startsWith(`<div class="alert" role="alert">`), html);
    assert.ok(html.includes("Saved"), html);
  });

  it("renders a readable-content suite", async () => {
    const html = await alert({ context: makeContext(), children: ["<p>One</p>", "<p>Two</p>"] });
    assert.ok(html.includes("<p>One</p><p>Two</p>"), html);
  });

  it("maps every admitted tone", async () => {
    for (const tone of ALERT_TONES) {
      const html = await alert({ context: makeContext(), value: "v", tone });
      assert.ok(html.includes(`alert-${tone}`), tone);
    }
  });

  it("combines tone, variant and orientation modifiers", async () => {
    const html = await alert({
      context: makeContext(),
      value: "v",
      tone: "error",
      variant: "outline",
      orientation: "vertical",
    });
    assert.ok(html.includes(`class="alert alert-error alert-outline alert-vertical"`), html);
  });

  it("treats solid as the bare base and rejects ghost and sizes", async () => {
    const solid = await alert({ context: makeContext(), value: "v", variant: "solid" });
    assert.ok(solid.startsWith(`<div class="alert" role="alert">`), solid);
    await assert.rejects(
      alert({ context: makeContext(), value: "v", variant: "ghost" }),
      /does not admit variant/,
    );
    await assert.rejects(
      alert(withExtra({ context: makeContext(), value: "v" }, { size: "lg" })),
      /does not admit size/,
    );
  });

  it("rejects tones outside info/success/warning/error", async () => {
    await assert.rejects(
      alert({ context: makeContext(), value: "v", tone: "primary" }),
      /does not admit tone/,
    );
  });

  it("escapes the value and formatted scalars", async () => {
    const html = await alert({ context: makeContext(), value: XSS });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
    const typed = await alert({
      context: makeContext(),
      value: { type: "int", value: 42 },
    });
    assert.ok(typed.includes("42"), typed);
  });

  it("pins a stable hx swap region when regionId is given", async () => {
    const html = await alert({ context: makeContext(), value: "v", regionId: "save-feedback" });
    assert.ok(html.includes(`class="alert can-region"`), html);
    assert.ok(html.includes(`id="save-feedback"`), html);
    assert.ok(html.includes(`data-region="save-feedback"`), html);
    assert.ok(html.includes(`hx-swap="outerMorph"`), html);
  });

  it("fails closed on bad payloads and region ids", async () => {
    await assert.rejects(alert({ context: makeContext() }), /needs a value or children/);
    await assert.rejects(
      alert({ context: makeContext(), value: "v", children: ["<p>x</p>"] }),
      /not both/,
    );
    await assert.rejects(alert({ context: makeContext(), value: "" }), /must not be empty/);
    await assert.rejects(alert({ context: makeContext(), children: [] }), /at least one child/);
    await assert.rejects(
      alert({ context: makeContext(), value: "v", regionId: "Bad Id!" }),
      /invalid region id/,
    );
  });
});

describe("toast", () => {
  it("renders a role=status container plus one alert message", async () => {
    const html = await toast({ context: makeContext(), message: "Saved" });
    assert.ok(html.startsWith(`<div class="toast" role="status">`), html);
    assert.ok(html.includes(`<div class="alert">`), html);
    assert.ok(html.includes("Saved"), html);
  });

  it("renders a message suite", async () => {
    const html = await toast({ context: makeContext(), children: ["<p>Hi</p>"] });
    assert.ok(html.includes(`<div class="alert"><p>Hi</p></div>`), html);
  });

  it("admits no appearance matrix", async () => {
    await assert.rejects(
      toast(withExtra({ context: makeContext(), message: "v" }, { tone: "info" })),
      /admits no appearance/,
    );
  });

  it("escapes the message", async () => {
    const html = await toast({ context: makeContext(), message: XSS });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
  });

  it("pins a stable hx swap region when regionId is given", async () => {
    const html = await toast({ context: makeContext(), message: "v", regionId: "notices" });
    assert.ok(html.includes(`class="toast can-region"`), html);
    assert.ok(html.includes(`id="notices" data-region="notices" hx-swap="outerMorph"`), html);
  });

  it("fails closed on bad payloads", async () => {
    await assert.rejects(toast({ context: makeContext() }), /needs a value or children/);
    await assert.rejects(
      toast({ context: makeContext(), message: "v", children: ["<p>x</p>"] }),
      /not both/,
    );
    await assert.rejects(toast({ context: makeContext(), message: "" }), /must not be empty/);
    await assert.rejects(toast({ context: makeContext(), children: [] }), /at least one child/);
  });
});

describe("tooltip", () => {
  it("renders caption, content and keyboard-reachable wrapper", async () => {
    const html = await tooltip({
      context: makeContext(),
      caption: "Review this submission",
      content: ["<button>Go</button>"],
    });
    assert.ok(html.includes(`class="tooltip"`), html);
    assert.ok(html.includes(`data-tip="Review this submission"`), html);
    assert.ok(html.includes(`tabindex="0"`), html);
    assert.ok(html.includes(`aria-label="Review this submission"`), html);
    assert.ok(html.includes("<button>Go</button>"), html);
  });

  it("maps admitted tones but not neutral", async () => {
    for (const tone of ALL_TONES) {
      if (tone === "neutral") {
        continue;
      }
      const html = await tooltip({ context: makeContext(), caption: "t", content: ["x"], tone });
      assert.ok(html.includes(`tooltip-${tone}`), tone);
    }
    await assert.rejects(
      tooltip({ context: makeContext(), caption: "t", content: ["x"], tone: "neutral" }),
      /does not admit tone/,
    );
  });

  it("resolves captions preferred-locale, app-default, then source", async () => {
    const caption = message("Review this submission", { nl: "Beoordeel deze inzending" });
    const preferred = await tooltip({
      context: makeContext({ preferredLocales: ["nl"] }),
      caption,
      content: ["x"],
    });
    assert.ok(preferred.includes("Beoordeel deze inzending"), preferred);
    const fallback = await tooltip({
      context: makeContext({ preferredLocales: ["fr"], appDefaultLocale: "nl" }),
      caption,
      content: ["x"],
    });
    assert.ok(fallback.includes("Beoordeel deze inzending"), fallback);
    const source = await tooltip({
      context: makeContext({ preferredLocales: ["fr"], appDefaultLocale: "fr" }),
      caption,
      content: ["x"],
    });
    assert.ok(source.includes("Review this submission"), source);
  });

  it("escapes the caption for the attribute sink", async () => {
    const html = await tooltip({ context: makeContext(), caption: XSS, content: ["x"] });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
  });

  it("fails closed on empty caption or content", async () => {
    await assert.rejects(
      tooltip({ context: makeContext(), caption: "", content: ["x"] }),
      /caption must not be empty/,
    );
    await assert.rejects(
      tooltip({ context: makeContext(), caption: "t", content: [] }),
      /at least one child/,
    );
  });
});

describe("indicator", () => {
  it("renders content with the marker item first", async () => {
    const html = await indicator({
      context: makeContext(),
      content: ["<button>Inbox</button>"],
      indicator: [`<span class="badge">3</span>`],
    });
    assert.ok(html.startsWith(`<span class="indicator">`), html);
    assert.ok(html.includes(`<span class="indicator-item"><span class="badge">3</span></span>`), html);
    assert.ok(
      html.indexOf("indicator-item") < html.indexOf("<button>Inbox</button>"),
      html,
    );
  });

  it("admits no appearance matrix", async () => {
    await assert.rejects(
      indicator(
        withExtra({ context: makeContext(), content: ["x"], indicator: ["y"] }, { tone: "info" }),
      ),
      /admits no appearance/,
    );
  });

  it("fails closed on empty slots", async () => {
    await assert.rejects(
      indicator({ context: makeContext(), content: [], indicator: ["y"] }),
      /at least one child/,
    );
    await assert.rejects(
      indicator({ context: makeContext(), content: ["x"], indicator: [] }),
      /at least one child/,
    );
  });
});

describe("chatBubble", () => {
  it("starts by default with content only", async () => {
    const html = await chatBubble({ context: makeContext(), content: ["<p>Hi</p>"] });
    assert.ok(html.startsWith(`<div class="chat chat-start">`), html);
    assert.ok(html.includes(`<div class="chat-bubble"><p>Hi</p></div>`), html);
    assert.ok(!html.includes("chat-image"), html);
  });

  it("renders end alignment with avatar, header and footer slots", async () => {
    const html = await chatBubble({
      context: makeContext(),
      side: "end",
      avatar: [`<div class="w-10 rounded-full"><img src="/a.png" alt="A"></div>`],
      header: ["Ada <time>12:01</time>"],
      content: ["<p>Hello</p>"],
      footer: ["Seen"],
    });
    assert.ok(html.startsWith(`<div class="chat chat-end">`), html);
    assert.ok(html.includes(`<div class="chat-image">`), html);
    assert.ok(html.includes(`<div class="chat-header">Ada <time>12:01</time></div>`), html);
    assert.ok(html.includes(`<div class="chat-footer">Seen</div>`), html);
  });

  it("maps every tone onto the bubble", async () => {
    for (const tone of ALL_TONES) {
      const html = await chatBubble({ context: makeContext(), content: ["x"], tone });
      assert.ok(html.includes(`chat-bubble-${tone}`), tone);
    }
  });

  it("rejects sizes and other unadmitted tokens", async () => {
    await assert.rejects(
      chatBubble(withExtra({ context: makeContext(), content: ["x"] }, { size: "lg" })),
      /does not admit size/,
    );
  });

  it("fails closed on bad side or empty content", async () => {
    await assert.rejects(
      chatBubble({ context: makeContext(), content: ["x"], side: "middle" as "start" }),
      /must be "start" or "end"/,
    );
    await assert.rejects(chatBubble({ context: makeContext(), content: [] }), /at least one child/);
  });
});

describe("dropdown", () => {
  it("renders trigger and content under the focus contract", async () => {
    const html = await dropdown({
      context: makeContext(),
      trigger: ["<span>Open</span>"],
      content: [`<ul class="menu"><li><a href="/a">A</a></li></ul>`],
    });
    assert.ok(html.startsWith(`<div class="dropdown">`), html);
    assert.ok(html.includes(`<div tabindex="0" role="button" aria-haspopup="true">`), html);
    assert.ok(
      html.includes(`class="dropdown-content bg-base-100 rounded-box w-64 p-2 shadow"`),
      html,
    );
  });

  it("keeps trigger and content keyboard-focusable in the DOM", async () => {
    const html = await dropdown({
      context: makeContext(),
      trigger: ["T"],
      content: ["C"],
    });
    const page = await loadHtml(html);
    try {
      const trigger = page.document.querySelector(".dropdown > [role=button]");
      const content = page.document.querySelector(".dropdown > .dropdown-content");
      assert.ok(trigger !== null && content !== null);
      assert.equal(trigger?.getAttribute("tabindex"), "0");
      assert.equal(content?.getAttribute("tabindex"), "0");
    } finally {
      await page.close();
    }
  });

  it("admits no appearance matrix", async () => {
    await assert.rejects(
      dropdown(withExtra({ context: makeContext(), trigger: ["t"], content: ["c"] }, { tone: "info" })),
      /admits no appearance/,
    );
  });

  it("fails closed on empty slots", async () => {
    await assert.rejects(
      dropdown({ context: makeContext(), trigger: [], content: ["c"] }),
      /at least one child/,
    );
    await assert.rejects(
      dropdown({ context: makeContext(), trigger: ["t"], content: [] }),
      /at least one child/,
    );
  });
});

describe("modal", () => {
  it("renders dialog, captioned box and action slot", async () => {
    const html = await modal({
      context: makeContext(),
      caption: "Score review",
      id: "review_details",
      content: ["<p>Body</p>"],
      actions: [`<button class="btn">Save</button>`],
    });
    assert.ok(html.includes(`<dialog class="modal" id="review_details"`), html);
    assert.ok(html.includes(`aria-labelledby="review_details-title"`), html);
    assert.ok(html.includes(`<div class="modal-box">`), html);
    assert.ok(html.includes(`<h3 id="review_details-title"`), html);
    assert.ok(html.includes(`<div class="modal-action">`), html);
    assert.ok(html.includes(`aria-label="Close"`), html);
  });

  it("generates an opener linking to the dialog id", async () => {
    const html = await modal({
      context: makeContext(),
      caption: "Score review",
      id: "review_details",
      content: ["<p>Body</p>"],
    });
    assert.ok(html.startsWith(`<a class="btn" href="#review_details">Score review</a>`), html);
  });

  it("renders a provided trigger and labels the dialog without an id", async () => {
    const html = await modal({
      context: makeContext(),
      caption: "Notice",
      trigger: [`<button class="btn">Show</button>`],
      content: ["<p>Body</p>"],
    });
    assert.ok(html.includes(`<button class="btn">Show</button>`), html);
    assert.ok(html.includes(`<dialog class="modal" aria-label="Notice">`), html);
  });

  it("localizes the close control", async () => {
    const html = await modal({
      context: makeContext({ preferredLocales: ["nl"] }),
      caption: "Melding",
      id: "melding",
      content: ["<p>Body</p>"],
    });
    assert.ok(html.includes(`aria-label="Sluiten"`), html);
  });

  it("escapes the caption in every sink", async () => {
    const html = await modal({
      context: makeContext(),
      caption: XSS,
      id: "xss_modal",
      content: ["<p>Body</p>"],
    });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
  });

  it("admits only the solid base", async () => {
    const solid = await modal({
      context: makeContext(),
      caption: "M",
      id: "m",
      content: ["x"],
      variant: "solid",
    });
    assert.ok(solid.includes(`<dialog class="modal"`), solid);
    await assert.rejects(
      modal(
        withExtra({ context: makeContext(), caption: "M", id: "m", content: ["x"] }, { tone: "info" }),
      ),
      /does not admit tone/,
    );
  });

  it("fails closed on missing activation, caption, content or id", async () => {
    await assert.rejects(
      modal({ context: makeContext(), caption: "M", content: ["x"] }),
      /trigger slot or an id/,
    );
    await assert.rejects(
      modal({ context: makeContext(), caption: "", id: "m", content: ["x"] }),
      /caption must not be empty/,
    );
    await assert.rejects(
      modal({ context: makeContext(), caption: "M", id: "m", content: [] }),
      /at least one child/,
    );
    await assert.rejects(
      modal({ context: makeContext(), caption: "M", id: "has space", content: ["x"] }),
      /must match/,
    );
    await assert.rejects(
      modal({ context: makeContext(), caption: "M", id: "9bad", content: ["x"] }),
      /must match/,
    );
  });
});

describe("drawer", () => {
  it("renders toggle, content area, side and overlay", async () => {
    const html = await drawer({
      context: makeContext(),
      caption: "Filters",
      id: "filters",
      content: [`<ul class="menu"><li>F</li></ul>`],
      actions: [`<button class="btn">Apply</button>`],
    });
    assert.ok(html.startsWith(`<div class="drawer">`), html);
    assert.ok(html.includes(`<input id="filters" type="checkbox" class="drawer-toggle">`), html);
    assert.ok(html.includes(`<div class="drawer-content">`), html);
    assert.ok(html.includes(`<div class="drawer-side">`), html);
    assert.ok(html.includes(`class="drawer-overlay" aria-label="Close"`), html);
    assert.ok(html.includes(`<aside`), html);
    assert.ok(html.includes(`<footer><button class="btn">Apply</button></footer>`), html);
  });

  it("generates a drawer-button opener and labels the panel", async () => {
    const html = await drawer({
      context: makeContext(),
      caption: "Filters",
      id: "filters",
      content: ["<p>Body</p>"],
    });
    assert.ok(html.includes(`<label for="filters" class="btn drawer-button">Filters</label>`), html);
    assert.ok(html.includes(`aria-labelledby="filters-title"`), html);
    assert.ok(html.includes(`<h2 id="filters-title"`), html);
  });

  it("associates toggle, opener and overlay in the DOM", async () => {
    const html = await drawer({
      context: makeContext(),
      caption: "F",
      id: "panel",
      content: ["<p>Body</p>"],
    });
    const page = await loadHtml(html);
    try {
      const toggle = page.document.querySelector("input.drawer-toggle");
      assert.ok(toggle !== null);
      assert.equal(toggle?.getAttribute("id"), "panel");
      assert.equal(toggle?.getAttribute("type"), "checkbox");
      const labels = page.document.querySelectorAll('label[for="panel"]');
      assert.equal(labels.length, 2);
    } finally {
      await page.close();
    }
  });

  it("renders a provided trigger instead of the opener", async () => {
    const html = await drawer({
      context: makeContext(),
      caption: "F",
      id: "panel",
      trigger: [`<button class="btn">Custom</button>`],
      content: ["<p>Body</p>"],
    });
    assert.ok(html.includes(`<button class="btn">Custom</button>`), html);
    assert.ok(!html.includes("drawer-button"), html);
  });

  it("escapes the caption in every sink", async () => {
    const html = await drawer({
      context: makeContext(),
      caption: XSS,
      id: "xss",
      content: ["<p>Body</p>"],
    });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
  });

  it("admits only the solid base", async () => {
    await assert.rejects(
      drawer(
        withExtra({ context: makeContext(), caption: "F", id: "p", content: ["x"] }, { tone: "info" }),
      ),
      /does not admit tone/,
    );
  });

  it("fails closed on missing or invalid id, caption and content", async () => {
    await assert.rejects(
      drawer({ context: makeContext(), caption: "F", id: "", content: ["x"] }),
      /must match/,
    );
    await assert.rejects(
      drawer({ context: makeContext(), caption: "F", id: "has space", content: ["x"] }),
      /must match/,
    );
    await assert.rejects(
      drawer({ context: makeContext(), caption: "", id: "p", content: ["x"] }),
      /caption must not be empty/,
    );
    await assert.rejects(
      drawer({ context: makeContext(), caption: "F", id: "p", content: [] }),
      /at least one child/,
    );
  });
});

describe("swap", () => {
  it("renders off/on slots under a toggling label", async () => {
    const html = await swap({ context: makeContext(), on: ["ON"], off: ["OFF"] });
    assert.ok(html.startsWith(`<label class="swap">`), html);
    assert.ok(html.includes(`<input type="checkbox">`), html);
    assert.ok(html.includes(`<div class="swap-on">ON</div>`), html);
    assert.ok(html.includes(`<div class="swap-off">OFF</div>`), html);
  });

  it("reflects explicit state and names the control", async () => {
    const html = await swap({
      context: makeContext(),
      on: ["ON"],
      off: ["OFF"],
      active: true,
      label: "Preview",
    });
    assert.ok(html.includes(`<input type="checkbox" checked aria-label="Preview">`), html);
  });

  it("escapes the label", async () => {
    const html = await swap({ context: makeContext(), on: ["a"], off: ["b"], label: XSS });
    assert.ok(!html.includes("<script>"), html);
  });

  it("admits no appearance matrix", async () => {
    await assert.rejects(
      swap(withExtra({ context: makeContext(), on: ["a"], off: ["b"] }, { tone: "info" })),
      /admits no appearance/,
    );
  });

  it("fails closed on empty slots", async () => {
    await assert.rejects(swap({ context: makeContext(), on: [], off: ["b"] }), /at least one child/);
    await assert.rejects(swap({ context: makeContext(), on: ["a"], off: [] }), /at least one child/);
  });
});

describe("fab", () => {
  it("renders main trigger plus action items in a named group", async () => {
    const html = await fab({
      context: makeContext(),
      main: ["+"],
      actions: [`<button class="btn">One</button>`, `<button class="btn">Two</button>`],
    });
    assert.ok(html.startsWith(`<div class="fab" role="group" aria-label="Quick actions">`), html);
    assert.ok(
      html.includes(`<div tabindex="0" role="button" aria-label="Quick actions">+</div>`),
      html,
    );
    assert.ok(html.includes(`<button class="btn">One</button><button class="btn">Two</button>`), html);
  });

  it("resolves a custom label and the localized default", async () => {
    const custom = await fab({
      context: makeContext(),
      label: "Create",
      main: ["+"],
      actions: [`<button class="btn">One</button>`],
    });
    assert.ok(custom.includes(`aria-label="Create"`), custom);
    const dutch = await fab({
      context: makeContext({ preferredLocales: ["nl"] }),
      main: ["+"],
      actions: [`<button class="btn">One</button>`],
    });
    assert.ok(dutch.includes(`aria-label="Snelle acties"`), dutch);
  });

  it("escapes the label", async () => {
    const html = await fab({
      context: makeContext(),
      label: XSS,
      main: ["+"],
      actions: [`<button class="btn">One</button>`],
    });
    assert.ok(!html.includes("<script>"), html);
  });

  it("admits no appearance matrix", async () => {
    await assert.rejects(
      fab(withExtra({ context: makeContext(), main: ["+"], actions: ["a"] }, { size: "lg" })),
      /admits no appearance/,
    );
  });

  it("fails closed on empty main or actions", async () => {
    await assert.rejects(
      fab({ context: makeContext(), main: [], actions: ["a"] }),
      /at least one child/,
    );
    await assert.rejects(
      fab({ context: makeContext(), main: ["+"], actions: [] }),
      /at least one child/,
    );
  });
});

describe("aura", () => {
  it("wraps content in the aura base", async () => {
    const html = await aura({ context: makeContext(), content: [`<button class="btn">Hi</button>`] });
    assert.ok(html.startsWith(`<div class="aura">`), html);
  });

  it("maps every admitted size", async () => {
    for (const size of ALL_SIZES) {
      const html = await aura({ context: makeContext(), content: ["x"], size });
      assert.ok(html.includes(`aura-${size}`), size);
    }
  });

  it("rejects tones: effect names are not tone tokens", async () => {
    await assert.rejects(
      aura(withExtra({ context: makeContext(), content: ["x"] }, { tone: "primary" })),
      /does not admit tone/,
    );
  });

  it("fails closed on empty content", async () => {
    await assert.rejects(aura({ context: makeContext(), content: [] }), /at least one child/);
  });
});

describe("mask", () => {
  it("wraps content in the bare mask", async () => {
    const html = await mask({ context: makeContext(), content: ["<img src=/a.png alt=A>"] });
    assert.ok(html.startsWith(`<div class="mask">`), html);
  });

  it("admits no appearance matrix: shapes are not tokens", async () => {
    await assert.rejects(
      mask(withExtra({ context: makeContext(), content: ["x"] }, { size: "lg" })),
      /admits no appearance/,
    );
  });

  it("fails closed on empty content", async () => {
    await assert.rejects(mask({ context: makeContext(), content: [] }), /at least one child/);
  });
});

describe("hover3d", () => {
  it("wraps noninteractive layers", async () => {
    const html = await hover3d({
      context: makeContext(),
      content: ["<img src=/a.png alt=A>", "<p>Back</p>"],
    });
    assert.ok(html.startsWith(`<div class="hover-3d">`), html);
  });

  it("rejects interactive descendants", async () => {
    for (const tag of ["button", "a href=/x", "input", "select", "textarea", "label", "details"]) {
      await assert.rejects(
        hover3d({ context: makeContext(), content: [`<${tag}>x</${tag.split(" ")[0]}>`] }),
        /forbids interactive descendants/,
        tag,
      );
    }
  });

  it("accepts escaped text that merely mentions tags", async () => {
    const html = await hover3d({
      context: makeContext(),
      content: ["&lt;button&gt; is escaped text"],
    });
    assert.ok(html.includes("&lt;button&gt;"), html);
  });

  it("admits no appearance matrix", async () => {
    await assert.rejects(
      hover3d(withExtra({ context: makeContext(), content: ["x"] }, { tone: "info" })),
      /admits no appearance/,
    );
  });
});

describe("hoverGallery", () => {
  const images = (count: number): ReadonlyArray<{ src: string; alt: MessageValue }> =>
    Array.from({ length: count }, (_, index) => ({
      src: `/img-${index}.png`,
      alt: `Image ${index}`,
    }));

  it("renders images with alt text in focusable items", async () => {
    const html = await hoverGallery({ context: makeContext(), images: images(3) });
    assert.ok(html.startsWith(`<ul class="hover-gallery">`), html);
    assert.ok(html.includes(`<li tabindex="0"><img src="/img-0.png" alt="Image 0"></li>`), html);
    assert.equal(html.split("<li").length - 1, 3);
  });

  it("accepts exactly the pinned 1..10 bounds", async () => {
    const one = await hoverGallery({ context: makeContext(), images: images(1) });
    assert.equal(one.split("<li").length - 1, 1);
    const ten = await hoverGallery({ context: makeContext(), images: images(10) });
    assert.equal(ten.split("<li").length - 1, 10);
    await assert.rejects(hoverGallery({ context: makeContext(), images: [] }), /1\.\.10 images/);
    await assert.rejects(
      hoverGallery({ context: makeContext(), images: images(11) }),
      /1\.\.10 images/,
    );
  });

  it("resolves localized alt text", async () => {
    const html = await hoverGallery({
      context: makeContext({ preferredLocales: ["nl"] }),
      images: [{ src: "/a.png", alt: message("Sunset", { nl: "Zonsondergang" }) }],
    });
    assert.ok(html.includes(`alt="Zonsondergang"`), html);
  });

  it("escapes alt text and rejects unsafe sources", async () => {
    const html = await hoverGallery({
      context: makeContext(),
      images: [{ src: "/a.png", alt: XSS }],
    });
    assert.ok(!html.includes("<script>"), html);
    await assert.rejects(
      hoverGallery({
        context: makeContext(),
        images: [{ src: "javascript:alert(1)", alt: "x" }],
      }),
      /safe non-empty URL/,
    );
    await assert.rejects(
      hoverGallery({ context: makeContext(), images: [{ src: "", alt: "x" }] }),
      /safe non-empty URL/,
    );
  });

  it("admits no appearance matrix", async () => {
    await assert.rejects(
      hoverGallery(withExtra({ context: makeContext(), images: images(1) }, { tone: "info" })),
      /admits no appearance/,
    );
  });
});
