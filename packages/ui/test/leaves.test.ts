import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  AppearanceOrientation,
  AppearanceSize,
  AppearanceTone,
  AppearanceVariant,
  PresentationContext,
  TextValue,
} from "@canlang/contracts";
import { message } from "../src/messages.js";
import {
  badge,
  countdown,
  divider,
  kbd,
  link,
  mockupBrowser,
  mockupCode,
  mockupPhone,
  mockupWindow,
  status,
} from "../src/leaves.js";
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
const ALL_SIZES: ReadonlyArray<AppearanceSize> = ["xs", "sm", "md", "lg", "xl"];

function withExtra<T extends object>(props: T, extra: Record<string, unknown>): T {
  return { ...props, ...extra };
}

describe("badge", () => {
  it("renders the base class with a readable value", async () => {
    const html = await badge({ context: makeContext(), value: "Open" });
    assert.ok(html.startsWith(`<span class="badge">`), html);
    assert.ok(html.includes("Open"), html);
    assert.ok(!html.includes("aria-label"), html);
  });

  it("maps every admitted tone", async () => {
    for (const tone of ALL_TONES) {
      const html = await badge({ context: makeContext(), value: "v", tone });
      assert.ok(html.includes(`badge-${tone}`), tone);
    }
  });

  it("maps every admitted size", async () => {
    for (const size of ALL_SIZES) {
      const html = await badge({ context: makeContext(), value: "v", size });
      assert.ok(html.includes(`badge-${size}`), size);
    }
  });

  it("maps outline/soft/ghost and treats solid as the bare base", async () => {
    for (const variant of ["outline", "soft", "ghost"] as const) {
      const html = await badge({ context: makeContext(), value: "v", variant });
      assert.ok(html.includes(`badge-${variant}`), variant);
    }
    const solid = await badge({ context: makeContext(), value: "v", variant: "solid" });
    assert.ok(solid.startsWith(`<span class="badge">`), solid);
  });

  it("combines tone, size and variant modifiers", async () => {
    const html = await badge({
      context: makeContext(),
      value: "v",
      tone: "error",
      size: "lg",
      variant: "outline",
    });
    assert.ok(html.includes(`class="badge badge-error badge-lg badge-outline"`), html);
  });

  it("throws on unadmitted appearance tokens", async () => {
    await assert.rejects(
      badge({
        context: makeContext(),
        value: "v",
        tone: "blurple" as unknown as AppearanceTone,
      }),
      /does not admit tone/,
    );
    await assert.rejects(
      badge(withExtra({ context: makeContext(), value: "v" }, { orientation: "vertical" })),
      /does not admit orientation/,
    );
  });

  it("prefixes the accessible name with the caption", async () => {
    const html = await badge({ context: makeContext(), value: "Open", caption: "State" });
    assert.ok(html.includes(`aria-label="State: Open"`), html);
    assert.ok(html.includes("Open"), html);
  });

  it("resolves descriptor captions and values", async () => {
    const ctx = makeContext({ preferredLocales: ["nl"] });
    const html = await badge({
      context: ctx,
      value: message("Open", { nl: "Openstaand" }),
      caption: message("State", { nl: "Status" }),
    });
    assert.ok(html.includes(`aria-label="Status: Openstaand"`), html);
    assert.ok(html.includes("Openstaand"), html);
  });

  it("renders bigint, enum and typed-scalar values exactly", async () => {
    const big = await badge({ context: makeContext(), value: 12345678901234567890n });
    assert.ok(!big.includes("[object"), big);
    assert.equal(big.replace(/[^0-9]/g, ""), "12345678901234567890");
    const en = await badge({
      context: makeContext(),
      value: { type: "enum", value: "OPEN" },
    });
    assert.ok(en.includes("OPEN"), en);
    const dec = await badge({
      context: makeContext(),
      value: { type: "decimal", value: "19.99" },
    });
    assert.ok(dec.includes("19.99"), dec);
  });

  it("renders nullish values as empty", async () => {
    for (const value of [null, undefined] as const) {
      const html = await badge({ context: makeContext(), value: value as unknown as TextValue });
      assert.ok(html.startsWith(`<span class="badge">`), html);
    }
  });

  it("escapes hostile values and captions", async () => {
    const html = await badge({ context: makeContext(), value: XSS, caption: XSS });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(!html.includes("<img"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
    assert.ok(html.includes("&quot;") || html.includes("&#39;") || html.includes("&lt;"), html);
  });

  it("exposes the value as DOM text", async () => {
    const html = await badge({ context: makeContext(), value: "Open", tone: "success" });
    const page = await loadHtml(html);
    try {
      const el = page.document.querySelector("span.badge");
      assert.ok(el, "badge element present");
      assert.ok(el.textContent?.includes("Open"), el.textContent ?? "");
      assert.ok(el.classList.contains("badge-success"));
    } finally {
      await page.close();
    }
  });
});

describe("status", () => {
  it("renders a dot with a screen-reader text alternative", async () => {
    const html = await status({ context: makeContext(), value: "Online" });
    assert.ok(html.startsWith(`<span class="status" aria-label="Online">`), html);
    assert.ok(html.includes(`<span class="sr-only">`), html);
    assert.ok(html.includes("Online"), html);
  });

  it("renders nullish values as an empty unnamed state", async () => {
    for (const value of [null, undefined] as const) {
      const html = await status({ context: makeContext(), value });
      assert.ok(html.includes(`aria-label=""`), html);
      assert.ok(!html.includes("null"), html);
      assert.ok(!html.includes("undefined"), html);
    }
  });

  it("maps every admitted tone and size", async () => {
    for (const tone of ALL_TONES) {
      const html = await status({ context: makeContext(), value: "v", tone });
      assert.ok(html.includes(`status-${tone}`), tone);
    }
    for (const size of ALL_SIZES) {
      const html = await status({ context: makeContext(), value: "v", size });
      assert.ok(html.includes(`status-${size}`), size);
    }
  });

  it("throws on unadmitted appearance tokens", async () => {
    await assert.rejects(
      status(withExtra({ context: makeContext(), value: "v" }, { variant: "ghost" })),
      /does not admit variant/,
    );
    await assert.rejects(
      status({
        context: makeContext(),
        value: "v",
        size: "xxl" as unknown as AppearanceSize,
      }),
      /does not admit size/,
    );
  });

  it("uses the caption as the accessible name when present", async () => {
    const html = await status({ context: makeContext(), value: "Online", caption: "Presence" });
    assert.ok(html.includes(`aria-label="Presence"`), html);
    assert.ok(html.includes("Online"), html);
  });

  it("resolves descriptor values and escapes hostile input", async () => {
    const ctx = makeContext({ preferredLocales: ["nl"] });
    const html = await status({
      context: ctx,
      value: message("Online", { nl: "Beschikbaar" }),
      caption: XSS,
    });
    assert.ok(html.includes("Beschikbaar"), html);
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
  });

  it("exposes dot and text alternative in the DOM", async () => {
    const html = await status({ context: makeContext(), value: "Online", tone: "success" });
    const page = await loadHtml(html);
    try {
      const el = page.document.querySelector("span.status");
      assert.ok(el, "status element present");
      assert.equal(el.getAttribute("aria-label"), "Online");
      const sr = el.querySelector("span.sr-only");
      assert.ok(sr, "sr-only alternative present");
      assert.ok(sr.textContent?.includes("Online"), sr.textContent ?? "");
    } finally {
      await page.close();
    }
  });
});

describe("kbd", () => {
  it("renders one kbd element per key joined with +", async () => {
    const html = await kbd({ context: makeContext(), keys: ["Ctrl", "K"] });
    assert.equal(
      html,
      `<kbd class="kbd">Ctrl</kbd>+<kbd class="kbd">K</kbd>`,
    );
  });

  it("maps every admitted size", async () => {
    for (const size of ALL_SIZES) {
      const html = await kbd({ context: makeContext(), keys: ["A"], size });
      assert.ok(html.includes(`class="kbd kbd-${size}"`), size);
    }
  });

  it("throws on unadmitted appearance tokens", async () => {
    await assert.rejects(
      kbd(withExtra({ context: makeContext(), keys: ["A"] }, { tone: "primary" })),
      /does not admit tone/,
    );
  });

  it("throws on an empty key list", async () => {
    await assert.rejects(kbd({ context: makeContext(), keys: [] }), /at least one key/);
  });

  it("escapes hostile keys", async () => {
    const html = await kbd({ context: makeContext(), keys: [XSS, "<Enter>"] });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(!html.includes("<Enter>"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
    assert.ok(html.includes("&lt;Enter&gt;"), html);
  });

  it("exposes each key as a DOM element", async () => {
    const html = await kbd({ context: makeContext(), keys: ["Ctrl", "Shift", "P"] });
    const page = await loadHtml(html);
    try {
      const keys = page.document.querySelectorAll("kbd.kbd");
      assert.equal(keys.length, 3);
      const first = keys.item(0);
      const last = keys.item(2);
      assert.ok(first && last, "first and last keys present");
      assert.equal(first.textContent, "Ctrl");
      assert.equal(last.textContent, "P");
    } finally {
      await page.close();
    }
  });
});

describe("mockupCode", () => {
  it("renders one prefixed pre per line inside .mockup-code", async () => {
    const html = await mockupCode({ context: makeContext(), code: "npm i\nnpm run build" });
    assert.ok(html.startsWith(`<div class="mockup-code">`), html);
    assert.equal(html.match(/<pre data-prefix="\$">/g)?.length, 2);
    assert.ok(html.includes("<code>npm i</code>"), html);
    assert.ok(html.includes("<code>npm run build</code>"), html);
  });

  it("splits CRLF and keeps empty lines as empty pres", async () => {
    const html = await mockupCode({ context: makeContext(), code: "a\r\n\r\nb" });
    assert.equal(html.match(/<pre data-prefix="\$">/g)?.length, 3);
    assert.ok(html.includes("<pre data-prefix=\"$\"><code></code></pre>"), html);
  });

  it("never interprets content", async () => {
    const html = await mockupCode({ context: makeContext(), code: `${XSS}\n<pre>fake</pre>` });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(!html.includes("<pre>fake</pre>"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
  });

  it("rejects non-string code and any appearance key", async () => {
    await assert.rejects(
      mockupCode({ context: makeContext(), code: 42 as unknown as string }),
      /must be a string/,
    );
    await assert.rejects(
      mockupCode(withExtra({ context: makeContext(), code: "x" }, { tone: "primary" })),
      /admits no appearance/,
    );
  });

  it("exposes code lines in the DOM", async () => {
    const html = await mockupCode({ context: makeContext(), code: "one\ntwo" });
    const page = await loadHtml(html);
    try {
      const pres = page.document.querySelectorAll("div.mockup-code > pre[data-prefix='$']");
      assert.equal(pres.length, 2);
      const second = pres.item(1);
      assert.ok(second, "second pre present");
      assert.equal(second.textContent, "two");
    } finally {
      await page.close();
    }
  });
});

describe("countdown", () => {
  it("renders the integer part via the --value property", async () => {
    const html = await countdown({ context: makeContext(), value: 59 });
    assert.equal(html, `<span class="countdown"><span style="--value:59"></span></span>`);
    const floored = await countdown({ context: makeContext(), value: 59.9 });
    assert.ok(floored.includes(`--value:59`), floored);
  });

  it("renders zero and large values", async () => {
    assert.ok((await countdown({ context: makeContext(), value: 0 })).includes("--value:0"));
    assert.ok(
      (await countdown({ context: makeContext(), value: 86400 })).includes("--value:86400"),
    );
  });

  it("rejects NaN, Infinity and negative values", async () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, -0.5]) {
      await assert.rejects(
        countdown({ context: makeContext(), value }),
        /finite number >= 0/,
        String(value),
      );
    }
  });

  it("rejects non-number values", async () => {
    for (const value of ["5", null, undefined, {}, true] as const) {
      await assert.rejects(
        countdown({ context: makeContext(), value: value as never }),
        /finite number >= 0/,
        String(value),
      );
    }
  });

  it("rejects appearance keys and uses caption as the accessible name", async () => {
    await assert.rejects(
      countdown(withExtra({ context: makeContext(), value: 5 }, { tone: "primary" })),
      /does not admit tone/,
    );
    const html = await countdown({ context: makeContext(), value: 5, caption: "Launch in" });
    assert.ok(html.includes(`aria-label="Launch in"`), html);
    const hostile = await countdown({ context: makeContext(), value: 5, caption: XSS });
    assert.ok(!hostile.includes("<script>"), hostile);
  });

  it("exposes the countdown in the DOM without timers", async () => {
    const html = await countdown({ context: makeContext(), value: 7 });
    const page = await loadHtml(html);
    try {
      const el = page.document.querySelector("span.countdown > span");
      assert.ok(el, "countdown value element present");
      assert.equal(el.getAttribute("style"), "--value:7");
    } finally {
      await page.close();
    }
  });
});

describe("divider", () => {
  it("renders an empty divider by default", async () => {
    const html = await divider({ context: makeContext() });
    assert.equal(html, `<div class="divider"></div>`);
  });

  it("renders an escaped caption", async () => {
    const html = await divider({ context: makeContext(), caption: "OR" });
    assert.equal(html, `<div class="divider">OR</div>`);
    const hostile = await divider({ context: makeContext(), caption: XSS });
    assert.ok(!hostile.includes("<script>"), hostile);
    assert.ok(hostile.includes("&lt;script&gt;"), hostile);
  });

  it("resolves descriptor captions", async () => {
    const ctx = makeContext({ preferredLocales: ["nl"] });
    const html = await divider({
      context: ctx,
      caption: message("or", { nl: "of" }),
    });
    assert.ok(html.includes(">of</div>"), html);
  });

  it("maps every admitted tone and both orientations", async () => {
    for (const tone of ALL_TONES) {
      const html = await divider({ context: makeContext(), tone });
      assert.ok(html.includes(`divider-${tone}`), tone);
    }
    for (const orientation of ["horizontal", "vertical"] as const) {
      const html = await divider({ context: makeContext(), orientation });
      assert.ok(html.includes(`divider-${orientation}`), orientation);
    }
  });

  it("throws on unadmitted appearance tokens", async () => {
    await assert.rejects(
      divider(withExtra({ context: makeContext() }, { size: "xs" })),
      /does not admit size/,
    );
    await assert.rejects(
      divider({
        context: makeContext(),
        orientation: "diagonal" as unknown as AppearanceOrientation,
      }),
      /does not admit orientation/,
    );
  });

  it("exposes the divider in the DOM", async () => {
    const html = await divider({ context: makeContext(), caption: "OR", tone: "primary" });
    const page = await loadHtml(html);
    try {
      const el = page.document.querySelector("div.divider");
      assert.ok(el, "divider element present");
      assert.equal(el.textContent, "OR");
      assert.ok(el.classList.contains("divider-primary"));
    } finally {
      await page.close();
    }
  });
});

describe("link", () => {
  it("renders caption text with a safe href", async () => {
    const html = await link({ context: makeContext(), target: "/docs/guide", caption: "Guide" });
    assert.equal(html, `<a class="link" href="/docs/guide">Guide</a>`);
  });

  it("falls back to target text when no caption is given", async () => {
    const html = await link({ context: makeContext(), target: "https://example.com/x" });
    assert.equal(html, `<a class="link" href="https://example.com/x">https://example.com/x</a>`);
  });

  it("maps every admitted tone", async () => {
    for (const tone of ALL_TONES) {
      const html = await link({ context: makeContext(), target: "/x", tone });
      assert.ok(html.includes(`link-${tone}`), tone);
    }
  });

  it("throws on unadmitted appearance tokens", async () => {
    await assert.rejects(
      link({
        context: makeContext(),
        target: "/x",
        tone: "blurple" as unknown as AppearanceTone,
      }),
      /does not admit tone/,
    );
    await assert.rejects(
      link(
        withExtra({ context: makeContext(), target: "/x" }, { variant: "ghost" as AppearanceVariant }),
      ),
      /does not admit variant/,
    );
  });

  it("falls back to # for hostile targets", async () => {
    for (const target of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "  javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "",
    ]) {
      const html = await link({ context: makeContext(), target, caption: "Click" });
      assert.ok(html.includes(`href="#"`), `${JSON.stringify(target)} -> ${html}`);
      assert.ok(!html.includes("javascript:"), html);
    }
  });

  it("keeps safe absolute, relative and fragment targets", async () => {
    for (const target of ["/docs/a", "#section", "https://example.com", "mailto:a@example.com"]) {
      const html = await link({ context: makeContext(), target, caption: "Go" });
      assert.ok(html.includes(`href="${target}"`), target);
    }
  });

  it("escapes hostile captions and target text", async () => {
    const html = await link({ context: makeContext(), target: "/x", caption: XSS });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
    const bare = await link({ context: makeContext(), target: `/x?q=${XSS}` });
    assert.ok(!bare.includes("<script>"), bare);
  });

  it("exposes href and text in the DOM", async () => {
    const html = await link({
      context: makeContext(),
      target: "/docs/guide",
      caption: "Guide",
      tone: "primary",
    });
    const page = await loadHtml(html);
    try {
      const el = page.document.querySelector("a.link");
      assert.ok(el, "link element present");
      assert.equal(el.getAttribute("href"), "/docs/guide");
      assert.equal(el.textContent, "Guide");
      assert.ok(el.classList.contains("link-primary"));
    } finally {
      await page.close();
    }
  });
});

describe("mockupBrowser", () => {
  it("renders toolbar, URL bar text and trusted children", async () => {
    const html = await mockupBrowser({
      context: makeContext(),
      url: "https://example.com/app",
      children: ["<p>Page body</p>"],
    });
    assert.ok(html.includes(`<div class="mockup-browser">`), html);
    assert.ok(html.includes(`<div class="mockup-browser-toolbar">`), html);
    assert.ok(html.includes(`<div class="input">https://example.com/app</div>`), html);
    assert.ok(html.includes("<p>Page body</p>"), html);
    assert.ok(!html.includes("<a "), html);
  });

  it("renders an empty URL bar when no url is given", async () => {
    const html = await mockupBrowser({ context: makeContext(), children: ["<p>B</p>"] });
    assert.ok(html.includes(`<div class="input"></div>`), html);
  });

  it("fails closed on empty suites and appearance extras", async () => {
    await assert.rejects(mockupBrowser({ context: makeContext(), children: [] }), /nonempty content suite/);
    await assert.rejects(
      mockupBrowser(withExtra({ context: makeContext(), children: ["A"] }, { size: "lg" })),
      /admits no appearance/,
    );
    await assert.rejects(
      mockupBrowser({ context: makeContext(), children: ["A"], caption: "" }),
      /caption must not be empty/,
    );
  });

  it("resolves url and caption in locale order", async () => {
    const en = await mockupBrowser({
      context: makeContext(),
      url: message("https://example.com", { nl: "https://voorbeeld.nl" }),
      caption: message("Preview", { nl: "Voorbeeld" }),
      children: ["A"],
    });
    assert.ok(en.includes("https://example.com"), en);
    assert.ok(en.includes('aria-label="Preview"'), en);
    const nl = await mockupBrowser({
      context: makeContext({ preferredLocales: ["nl"] }),
      url: message("https://example.com", { nl: "https://voorbeeld.nl" }),
      caption: message("Preview", { nl: "Voorbeeld" }),
      children: ["A"],
    });
    assert.ok(nl.includes("https://voorbeeld.nl"), nl);
    assert.ok(nl.includes('aria-label="Voorbeeld"'), nl);
  });

  it("escapes hostile url text", async () => {
    const html = await mockupBrowser({ context: makeContext(), url: XSS, children: ["A"] });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
  });

  it("exposes browser chrome in the DOM", async () => {
    const html = await mockupBrowser({
      context: makeContext(),
      url: "https://example.com",
      caption: "Preview",
      children: ["<p>Body</p>"],
    });
    const page = await loadHtml(html);
    try {
      const el = page.document.querySelector(".mockup-browser");
      assert.ok(el, "browser wrapper present");
      assert.equal(el.getAttribute("aria-label"), "Preview");
      assert.equal(el.querySelector(".mockup-browser-toolbar .input")?.textContent, "https://example.com");
      assert.equal(el.querySelector("p")?.textContent, "Body");
    } finally {
      await page.close();
    }
  });
});

describe("mockupPhone", () => {
  it("renders camera notch, display slot and trusted children", async () => {
    const html = await mockupPhone({ context: makeContext(), children: ["<p>App</p>"] });
    assert.ok(html.includes(`<div class="mockup-phone">`), html);
    assert.ok(html.includes(`<div class="mockup-phone-camera"></div>`), html);
    assert.ok(html.includes(`<div class="mockup-phone-display"><p>App</p></div>`), html);
  });

  it("fails closed on empty suites and appearance extras", async () => {
    await assert.rejects(mockupPhone({ context: makeContext(), children: [] }), /nonempty content suite/);
    await assert.rejects(
      mockupPhone(withExtra({ context: makeContext(), children: ["A"] }, { tone: "primary" })),
      /admits no appearance/,
    );
  });

  it("resolves captions in locale order and escapes hostile text", async () => {
    const nl = await mockupPhone({
      context: makeContext({ preferredLocales: ["nl"] }),
      caption: message("Preview", { nl: "Voorbeeld" }),
      children: ["A"],
    });
    assert.ok(nl.includes('aria-label="Voorbeeld"'), nl);
    const html = await mockupPhone({ context: makeContext(), caption: XSS, children: ["A"] });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
  });

  it("exposes phone chrome in the DOM", async () => {
    const html = await mockupPhone({
      context: makeContext(),
      caption: "Preview",
      children: ["<p>App</p>"],
    });
    const page = await loadHtml(html);
    try {
      const el = page.document.querySelector(".mockup-phone");
      assert.ok(el, "phone wrapper present");
      assert.equal(el.getAttribute("aria-label"), "Preview");
      assert.ok(el.querySelector(".mockup-phone-camera"), "camera present");
      assert.equal(el.querySelector(".mockup-phone-display p")?.textContent, "App");
    } finally {
      await page.close();
    }
  });
});

describe("mockupWindow", () => {
  it("renders window chrome around trusted children", async () => {
    const html = await mockupWindow({ context: makeContext(), children: ["<p>Doc</p>"] });
    assert.ok(html.includes(`<div class="mockup-window">`), html);
    assert.ok(html.includes("<p>Doc</p>"), html);
  });

  it("fails closed on empty suites and appearance extras", async () => {
    await assert.rejects(mockupWindow({ context: makeContext(), children: [] }), /nonempty content suite/);
    await assert.rejects(
      mockupWindow(withExtra({ context: makeContext(), children: ["A"] }, { variant: "ghost" })),
      /admits no appearance/,
    );
  });

  it("resolves captions in locale order and escapes hostile text", async () => {
    const nl = await mockupWindow({
      context: makeContext({ preferredLocales: ["nl"] }),
      caption: message("Preview", { nl: "Voorbeeld" }),
      children: ["A"],
    });
    assert.ok(nl.includes('aria-label="Voorbeeld"'), nl);
    const html = await mockupWindow({ context: makeContext(), caption: XSS, children: ["A"] });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
  });

  it("exposes window chrome in the DOM", async () => {
    const html = await mockupWindow({
      context: makeContext(),
      caption: "Preview",
      children: ["<p>Doc</p>"],
    });
    const page = await loadHtml(html);
    try {
      const el = page.document.querySelector(".mockup-window");
      assert.ok(el, "window wrapper present");
      assert.equal(el.getAttribute("aria-label"), "Preview");
      assert.equal(el.querySelector("p")?.textContent, "Doc");
    } finally {
      await page.close();
    }
  });
});
