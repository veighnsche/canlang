import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PresentationContext } from "@canlang/contracts";
import { message } from "../src/messages.js";
import { avatar, progress, radialProgress, textRotate } from "../src/media.js";
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
const HOSTILE_CAPTION = `"><img src=x onerror=alert(1)>`;

describe("avatar", () => {
  it("renders an img for a safe image with caption alt", async () => {
    const html = await avatar({
      context: makeContext(),
      image: "https://example.com/a.png",
      caption: "Ada",
    });
    const page = await loadHtml(html);
    try {
      const img = page.document.querySelector(".avatar img");
      assert.ok(img !== null, "expected .avatar img");
      assert.equal(img.getAttribute("src"), "https://example.com/a.png");
      assert.equal(img.getAttribute("alt"), "Ada");
      assert.equal(page.document.querySelector(".avatar-placeholder"), null);
    } finally {
      await page.close();
    }
  });

  it("falls back to fallback text alt when caption is absent", async () => {
    const html = await avatar({
      context: makeContext(),
      image: "/photos/a.png",
      fallback: "AL",
    });
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelector("img")?.getAttribute("alt"), "AL");
    } finally {
      await page.close();
    }
  });

  it("uses the shared unavailable label when caption and fallback are absent", async () => {
    const html = await avatar({ context: makeContext(), image: "/photos/a.png" });
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelector("img")?.getAttribute("alt"), "Image unavailable");
    } finally {
      await page.close();
    }
  });

  it("localizes the shared unavailable label to nl", async () => {
    const html = await avatar({
      context: makeContext({ preferredLocales: ["nl"] }),
      image: "/photos/a.png",
    });
    const page = await loadHtml(html);
    try {
      assert.equal(
        page.document.querySelector("img")?.getAttribute("alt"),
        "Afbeelding niet beschikbaar",
      );
    } finally {
      await page.close();
    }
  });

  it("prefers caption over fallback for the accessible name", async () => {
    const html = await avatar({
      context: makeContext(),
      image: "/photos/a.png",
      caption: "Cap",
      fallback: "Fb",
    });
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelector("img")?.getAttribute("alt"), "Cap");
    } finally {
      await page.close();
    }
  });

  it("renders the placeholder with fallback text for a null image", async () => {
    const html = await avatar({ context: makeContext(), image: null, fallback: "AL" });
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelector("img"), null);
      const holder = page.document.querySelector(".avatar.avatar-placeholder");
      assert.ok(holder !== null, "expected .avatar.avatar-placeholder");
      assert.equal(holder.querySelector("span")?.textContent, "AL");
    } finally {
      await page.close();
    }
  });

  it("renders the shared ? glyph when image and fallback are absent", async () => {
    const html = await avatar({ context: makeContext() });
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelector("img"), null);
      assert.equal(
        page.document.querySelector(".avatar-placeholder span")?.textContent,
        "?",
      );
    } finally {
      await page.close();
    }
  });

  it("labels the placeholder with caption, fallback or the shared label", async () => {
    const captioned = await avatar({ context: makeContext(), caption: "Ada" });
    const fallback = await avatar({ context: makeContext(), fallback: "AL" });
    const bare = await avatar({ context: makeContext() });
    for (const [html, expected] of [
      [captioned, "Ada"],
      [fallback, "AL"],
      [bare, "Image unavailable"],
    ] as const) {
      const page = await loadHtml(html);
      try {
        assert.equal(
          page.document.querySelector(".avatar-placeholder")?.getAttribute("aria-label"),
          expected,
        );
      } finally {
        await page.close();
      }
    }
  });

  it("renders the placeholder for empty and hostile image URLs", async () => {
    for (const image of ["", "javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<p>x</p>"]) {
      const html = await avatar({ context: makeContext(), image, fallback: "AL" });
      const page = await loadHtml(html);
      try {
        assert.equal(page.document.querySelector("img"), null, `image ${image} must not render img`);
        assert.ok(page.document.querySelector(".avatar-placeholder") !== null);
      } finally {
        await page.close();
      }
    }
  });

  it("escapes hostile caption and fallback as text", async () => {
    const html = await avatar({ context: makeContext(), image: null, fallback: XSS });
    assert.ok(!html.includes("<script>"), "fallback must be escaped");
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelector(".avatar-placeholder span")?.textContent, XSS);
      assert.equal(page.document.querySelector("script"), null);
    } finally {
      await page.close();
    }
    const imgHtml = await avatar({
      context: makeContext(),
      image: "/a.png",
      caption: HOSTILE_CAPTION,
    });
    assert.ok(!imgHtml.includes('<img src=x onerror=alert(1)>'), "caption must be escaped");
  });

  it("resolves descriptor captions through the formatter", async () => {
    const html = await avatar({
      context: makeContext({ preferredLocales: ["nl"] }),
      image: "/a.png",
      caption: message("Hello", { nl: "Hallo" }),
    });
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelector("img")?.getAttribute("alt"), "Hallo");
    } finally {
      await page.close();
    }
  });
});

describe("progress", () => {
  it("renders a bar with exact value/max and percent fallback text", async () => {
    const html = await progress({ context: makeContext(), value: 30, max: 100 });
    const page = await loadHtml(html);
    try {
      const bar = page.document.querySelector("progress.progress");
      assert.ok(bar !== null, "expected progress.progress");
      assert.equal(bar.getAttribute("value"), "30");
      assert.equal(bar.getAttribute("max"), "100");
      assert.equal(bar.textContent, "30%");
    } finally {
      await page.close();
    }
  });

  it("applies admitted tones and rejects unadmitted ones", async () => {
    const html = await progress({
      context: makeContext(),
      value: 1,
      max: 2,
      tone: "primary",
    });
    assert.ok(html.includes('class="progress progress-primary"'));
    await assert.rejects(
      progress({
        context: makeContext(),
        value: 1,
        max: 2,
        tone: "ghost" as never,
      }),
    );
  });

  it("renders explicit invalid presentation for out-of-range and NaN values", async () => {
    for (const value of [Number.NaN, -1, 101]) {
      const html = await progress({ context: makeContext(), value, max: 100 });
      const page = await loadHtml(html);
      try {
        assert.equal(page.document.querySelector("progress"), null, `value ${value}: no bar`);
        const alert = page.document.querySelector('p[role="alert"].alert.alert-error');
        assert.ok(alert !== null, `value ${value}: expected role=alert error`);
        assert.equal(alert.textContent, "Invalid progress value");
      } finally {
        await page.close();
      }
    }
  });

  it("uses the caption in invalid presentation and localizes the default", async () => {
    const custom = await progress({ context: makeContext(), value: -1, max: 100, caption: "Bad" });
    assert.ok(custom.includes(">Bad</p>"));
    const dutch = await progress({
      context: makeContext({ preferredLocales: ["nl"] }),
      value: -1,
      max: 100,
    });
    assert.ok(dutch.includes("Ongeldige voortgangswaarde"));
  });

  it("throws RangeError for invalid max", async () => {
    for (const max of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        progress({ context: makeContext(), value: 1, max }),
        RangeError,
        `max ${max} must throw`,
      );
    }
  });

  it("throws when both max and value are invalid (max wins)", async () => {
    await assert.rejects(
      progress({ context: makeContext(), value: Number.NaN, max: 0 }),
      RangeError,
    );
    await assert.rejects(
      radialProgress({ context: makeContext(), value: -5, max: Number.NaN }),
      RangeError,
    );
  });

  it("rejects undeclared runtime appearance extras instead of dropping them", async () => {
    await assert.rejects(
      avatar({ context: makeContext(), tone: "x" } as never),
      /does not admit|admits no appearance/,
    );
    await assert.rejects(
      progress({ context: makeContext(), value: 1, max: 2, size: "xs" } as never),
      /does not admit/,
    );
    await assert.rejects(
      radialProgress({ context: makeContext(), value: 1, max: 2, tone: "primary" } as never),
      /does not admit/,
    );
    await assert.rejects(
      textRotate({ context: makeContext(), items: ["a"], size: "lg" } as never),
      /admits no appearance/,
    );
  });

  it("keeps value/max unrounded in exact decimal text", async () => {
    const html = await progress({ context: makeContext(), value: 0.1, max: 0.3 });
    assert.ok(html.includes('value="0.1"'));
    assert.ok(html.includes('max="0.3"'));
  });

  it("escapes a hostile caption in invalid presentation", async () => {
    const html = await progress({ context: makeContext(), value: -5, max: 10, caption: XSS });
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelector("script"), null);
      assert.equal(
        page.document.querySelector('[role="alert"]')?.textContent,
        XSS,
      );
    } finally {
      await page.close();
    }
  });
});

describe("radialProgress", () => {
  it("renders percent, aria and pinned size", async () => {
    const html = await radialProgress({ context: makeContext(), value: 50, max: 100 });
    const page = await loadHtml(html);
    try {
      const dial = page.document.querySelector(".radial-progress");
      assert.ok(dial !== null, "expected .radial-progress");
      assert.equal(dial.getAttribute("role"), "progressbar");
      assert.equal(dial.getAttribute("aria-valuenow"), "50");
      assert.equal(dial.getAttribute("aria-valuemin"), "0");
      assert.equal(dial.getAttribute("aria-valuemax"), "100");
      assert.equal(dial.getAttribute("aria-label"), "Progress");
      assert.ok((dial.getAttribute("style") ?? "").includes("--value:50"));
      assert.ok((dial.getAttribute("style") ?? "").includes("--size:3rem"));
      assert.equal(dial.textContent, "50%");
    } finally {
      await page.close();
    }
  });

  it("uses the caption as aria-label", async () => {
    const html = await radialProgress({
      context: makeContext(),
      value: 1,
      max: 4,
      caption: "Upload",
    });
    const page = await loadHtml(html);
    try {
      assert.equal(
        page.document.querySelector(".radial-progress")?.getAttribute("aria-label"),
        "Upload",
      );
    } finally {
      await page.close();
    }
  });

  it("mirrors the progress invalid matrix: alert for bad values, throw for bad max", async () => {
    for (const value of [Number.NaN, -1, 11]) {
      const html = await radialProgress({ context: makeContext(), value, max: 10 });
      const page = await loadHtml(html);
      try {
        assert.equal(page.document.querySelector(".radial-progress"), null);
        assert.ok(page.document.querySelector('p[role="alert"].alert.alert-error') !== null);
      } finally {
        await page.close();
      }
    }
    for (const max of [0, Number.NaN, -2]) {
      await assert.rejects(radialProgress({ context: makeContext(), value: 1, max }), RangeError);
    }
  });

  it("escapes a hostile caption in the aria-label", async () => {
    const html = await radialProgress({
      context: makeContext(),
      value: 1,
      max: 2,
      caption: HOSTILE_CAPTION,
    });
    assert.ok(!html.includes(HOSTILE_CAPTION), "caption must be escaped");
    const page = await loadHtml(html);
    try {
      assert.equal(
        page.document.querySelector(".radial-progress")?.getAttribute("aria-label"),
        HOSTILE_CAPTION,
      );
    } finally {
      await page.close();
    }
  });
});

describe("textRotate", () => {
  it("renders one and six items inside the upstream wrapper", async () => {
    for (const count of [1, 6]) {
      const items = Array.from({ length: count }, (_, i) => `item-${i}`);
      const html = await textRotate({ context: makeContext(), items });
      const page = await loadHtml(html);
      try {
        const outer = page.document.querySelector("span.text-rotate");
        assert.ok(outer !== null, "expected span.text-rotate");
        const rendered = outer.querySelectorAll(":scope > span > span");
        assert.equal(rendered.length, count);
        assert.deepEqual(
          Array.from(rendered).map((el) => el.textContent),
          items,
        );
      } finally {
        await page.close();
      }
    }
  });

  it("throws RangeError for 0 and 7 items", async () => {
    await assert.rejects(textRotate({ context: makeContext(), items: [] }), RangeError);
    await assert.rejects(
      textRotate({ context: makeContext(), items: ["a", "b", "c", "d", "e", "f", "g"] }),
      RangeError,
    );
  });

  it("resolves descriptor items and escapes hostile text", async () => {
    const html = await textRotate({
      context: makeContext({ preferredLocales: ["nl"] }),
      items: [message("Hello", { nl: "Hallo" }), XSS],
    });
    const page = await loadHtml(html);
    try {
      const rendered = page.document.querySelectorAll(":scope span.text-rotate > span > span");
      assert.equal(rendered.length, 2);
      assert.equal(rendered[0]?.textContent, "Hallo");
      assert.equal(rendered[1]?.textContent, XSS);
      assert.equal(page.document.querySelector("script"), null);
    } finally {
      await page.close();
    }
  });
});
