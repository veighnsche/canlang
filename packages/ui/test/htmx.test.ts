import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  HtmxRequest,
  PresentationContext,
  StatusSwap,
  SwapStrategy,
} from "../../contracts/src/presentation.js";
import {
  fragmentRegion,
  hxAttrs,
  pollTrigger,
  refreshTrigger,
  staleMarker,
  validationStatusSwaps,
} from "../src/htmx.js";
import { message } from "../src/messages.js";
import type { KeyboardEvent as HappyKeyboardEvent } from "happy-dom";
import { loadHtml, pressKey } from "./harness.js";

function makeContext(
  overrides: Partial<PresentationContext> = {},
): PresentationContext {
  return {
    preferredLocales: [],
    appDefaultLocale: "en",
    theme: { mode: "system", accent: "blue", density: "comfortable" },
    path: "/",
    isPartial: true,
    csrfToken: "csrf-123",
    principal: null,
    invocation: null,
    query: async () => ({ rows: [], columns: [] }),
    ...overrides,
  };
}

describe("hxAttrs", () => {
  it("emits hx-get with escaped href and target", () => {
    const out = hxAttrs({ method: "get", href: "/expenses?page=2", target: "#rows" });
    assert.equal(out, 'hx-get="/expenses?page=2" hx-target="#rows"');
  });

  it("emits hx-post for post requests", () => {
    const out = hxAttrs({ method: "post", href: "/expenses", target: "#form" });
    assert.ok(out.startsWith('hx-post="/expenses"'));
    assert.ok(out.includes('hx-target="#form"'));
  });

  it("maps all five swap strategies", () => {
    const cases: Array<[SwapStrategy, string]> = [
      ["morph", "outerMorph"],
      ["replace", "outerHTML"],
      ["append", "beforeend"],
      ["prepend", "afterbegin"],
      ["none", "none"],
    ];
    for (const [swap, expected] of cases) {
      const out = hxAttrs({ method: "get", href: "/x", target: "#a", swap });
      assert.ok(
        out.includes(`hx-swap="${expected}"`),
        `${swap} should map to ${expected}: ${out}`,
      );
    }
  });

  it("omits hx-swap when no swap is given (region carries the default)", () => {
    const out = hxAttrs({ method: "get", href: "/x", target: "#a" });
    assert.ok(!out.includes("hx-swap"));
  });

  it("emits hx-include for GET controls and validates the selector", () => {
    const out = hxAttrs({ method: "get", href: "/x", target: "#a", include: "this" });
    assert.ok(out.includes('hx-include="this"'));
    assert.throws(() => hxAttrs({ method: "get", href: "/x", target: "#a", include: "" }), /include/);
    assert.throws(
      () => hxAttrs({ method: "get", href: "/x", target: "#a", include: "div > p" }),
      /include/,
    );
  });

  it("emits trigger and indicator when given", () => {
    const out = hxAttrs({
      method: "get",
      href: "/x",
      target: "#a",
      trigger: "click",
      indicator: "#spinner",
    });
    assert.ok(out.includes('hx-trigger="click"'));
    assert.ok(out.includes('hx-indicator="#spinner"'));
  });

  it("serializes statusSwaps with target, swap and optional select", () => {
    const req: HtmxRequest = {
      method: "post",
      href: "/x",
      target: "#form",
      statusSwaps: [
        { status: "422", target: "#form", swap: "morph" },
        { status: "5xx", target: "#form", swap: "none", select: "#banner" },
      ],
    };
    const out = hxAttrs(req);
    assert.ok(out.includes('hx-status:422="target:#form swap:outerMorph"'), out);
    assert.ok(
      out.includes('hx-status:5xx="target:#form swap:none select:#banner"'),
      out,
    );
  });

  it("emits hx-push-url only when pushUrl is true", () => {
    const on = hxAttrs({ method: "get", href: "/x", target: "#a", pushUrl: true });
    assert.ok(on.includes('hx-push-url="true"'), on);
    const off = hxAttrs({ method: "get", href: "/x", target: "#a", pushUrl: false });
    assert.ok(!off.includes("hx-push-url"), off);
    const absent = hxAttrs({ method: "get", href: "/x", target: "#a" });
    assert.ok(!absent.includes("hx-push-url"), absent);
  });

  it("accepts extended hx target selectors", () => {
    for (const target of ["this", "closest div", "find .row", "next tr", "previous tr"]) {
      const out = hxAttrs({ method: "get", href: "/x", target });
      assert.ok(out.includes(`hx-target="${target}"`), out);
    }
  });

  it("throws on bad targets", () => {
    for (const target of ["", "#", "div", ".row", "closest", "parent div", "#a b"]) {
      if (target === "#a b") {
        // "#" selectors pass validation (a descendant selector is legal CSS);
        // hostile payloads inside are neutralized by escaping instead.
        const out = hxAttrs({ method: "get", href: "/x", target });
        assert.ok(out.includes("hx-target="), out);
        continue;
      }
      assert.throws(
        () => hxAttrs({ method: "get", href: "/x", target }),
        /target|selector/,
        `target ${JSON.stringify(target)} should throw`,
      );
    }
  });

  it("throws on bad status selectors", () => {
    const bad = ["", "42", "2000", "200 OK", "6xx", "0xx", "*", "4XX", "4x"];
    for (const status of bad) {
      assert.throws(
        () =>
          hxAttrs({
            method: "post",
            href: "/x",
            target: "#form",
            statusSwaps: [{ status, target: "#form", swap: "morph" }],
          }),
        /status/,
        `status ${JSON.stringify(status)} should throw`,
      );
    }
  });

  it("accepts exact and wildcard status selectors", () => {
    const swaps: StatusSwap[] = [
      { status: "400", target: "#f", swap: "morph" },
      { status: "1xx", target: "#f", swap: "none" },
      { status: "5xx", target: "#f", swap: "none" },
    ];
    const out = hxAttrs({ method: "get", href: "/x", target: "#a", statusSwaps: swaps });
    assert.ok(out.includes("hx-status:400="), out);
    assert.ok(out.includes("hx-status:1xx="), out);
    assert.ok(out.includes("hx-status:5xx="), out);
  });

  it("neutralizes hostile attribute content by escaping", () => {
    const out = hxAttrs({
      method: "get",
      href: "/x",
      target: "#a",
      trigger: `click" hx-get="/evil`,
    });
    assert.ok(!out.includes('hx-get="/evil'), out);
    assert.ok(out.includes("hx-trigger="), out);
  });

  it("falls back to # for unsafe hrefs", () => {
    const out = hxAttrs({ method: "get", href: "javascript:alert(1)", target: "#a" });
    assert.ok(out.includes('hx-get="#"'), out);
  });
});

describe("fragmentRegion", () => {
  it("renders id, data-region, class, label and morph default", async () => {
    const html = await fragmentRegion({
      context: makeContext(),
      regionId: "expense-rows",
      content: ["<p>hi</p>"],
      label: "Expenses",
    });
    assert.ok(html.includes('id="expense-rows"'), html);
    assert.ok(html.includes('data-region="expense-rows"'), html);
    assert.ok(html.includes('class="can-region"'), html);
    assert.ok(html.includes('aria-label="Expenses"'), html);
    assert.ok(html.includes('hx-swap="outerMorph"'), html);
    assert.ok(html.includes("<p>hi</p>"), html);
    assert.ok(html.startsWith("<section"), html);
    assert.ok(html.endsWith("</section>"), html);
  });

  it("emits no inherited hx-* attributes", async () => {
    const html = await fragmentRegion({
      context: makeContext(),
      regionId: "rows",
      content: [],
      label: "Rows",
    });
    assert.ok(!html.includes("hx-get"), html);
    assert.ok(!html.includes("hx-post"), html);
    assert.ok(!html.includes("hx-target"), html);
    assert.ok(!html.includes("hx-trigger"), html);
  });

  it("escapes a hostile label", async () => {
    const html = await fragmentRegion({
      context: makeContext(),
      regionId: "rows",
      content: [],
      label: `"><script>alert(1)</script>`,
    });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes("&quot;&gt;&lt;script&gt;"), html);
  });

  it("resolves descriptor labels through locale resolution", async () => {
    const html = await fragmentRegion({
      context: makeContext({ preferredLocales: ["nl"] }),
      regionId: "rows",
      content: [],
      label: message("Rows", { nl: "Rijen" }),
    });
    assert.ok(html.includes('aria-label="Rijen"'), html);
  });

  it("awaits array, thunk and promise children", async () => {
    const thunk = await fragmentRegion({
      context: makeContext(),
      regionId: "rows",
      content: () => ["<i>a</i>", Promise.resolve("<i>b</i>")],
      label: "Rows",
    });
    assert.ok(thunk.includes("<i>a</i><i>b</i>"), thunk);
    const asyncThunk = await fragmentRegion({
      context: makeContext(),
      regionId: "rows",
      content: async () => [Promise.resolve("<i>c</i>")],
      label: "Rows",
    });
    assert.ok(asyncThunk.includes("<i>c</i>"), asyncThunk);
  });

  it("throws on bad region ids", async () => {
    for (const regionId of ["", "Rows", "has space", "a_b", "-lead", "trail-", "a--b", `"><script>`, "../x", "#rows"]) {
      await assert.rejects(
        fragmentRegion({ context: makeContext(), regionId, content: [], label: "x" }),
        /region id/,
        `regionId ${JSON.stringify(regionId)} should throw`,
      );
    }
  });
});

describe("pollTrigger", () => {
  it("renders the hidden reread trigger with morph swap and sync", async () => {
    const html = await pollTrigger({
      context: makeContext(),
      regionId: "expense-rows",
      href: "/expenses/rows",
      intervalSeconds: 30,
    });
    assert.ok(html.includes("hidden"), html);
    assert.ok(html.includes('aria-hidden="true"'), html);
    assert.ok(html.includes('hx-get="/expenses/rows"'), html);
    assert.ok(html.includes('hx-target="#expense-rows"'), html);
    assert.ok(html.includes('hx-trigger="every 30s"'), html);
    assert.ok(html.includes('hx-swap="outerMorph"'), html);
    assert.ok(html.includes('hx-sync="this:abort"'), html);
    assert.ok(html.endsWith("</div>"), html);
  });

  it("rejects out-of-bounds and non-integer intervals", async () => {
    for (const intervalSeconds of [0, -1, 3601, 1.5, Number.NaN]) {
      await assert.rejects(
        pollTrigger({ context: makeContext(), regionId: "rows", href: "/x", intervalSeconds }),
        /intervalSeconds|integer|bounds/,
        `interval ${intervalSeconds} should throw`,
      );
    }
  });

  it("accepts the interval bounds 1 and 3600", async () => {
    const lo = await pollTrigger({ context: makeContext(), regionId: "rows", href: "/x", intervalSeconds: 1 });
    assert.ok(lo.includes('hx-trigger="every 1s"'), lo);
    const hi = await pollTrigger({ context: makeContext(), regionId: "rows", href: "/x", intervalSeconds: 3600 });
    assert.ok(hi.includes('hx-trigger="every 3600s"'), hi);
  });

  it("validates region id and neutralizes unsafe href", async () => {
    await assert.rejects(
      pollTrigger({ context: makeContext(), regionId: "Bad Id", href: "/x", intervalSeconds: 5 }),
      /region id/,
    );
    const html = await pollTrigger({
      context: makeContext(),
      regionId: "rows",
      href: "javascript:alert(1)",
      intervalSeconds: 5,
    });
    assert.ok(html.includes('hx-get="#"'), html);
  });
});

describe("staleMarker", () => {
  it("renders an alert badge bound to the region", async () => {
    const html = await staleMarker({
      context: makeContext(),
      regionId: "expense-rows",
      message: "Data may be stale.",
    });
    assert.ok(html.includes('role="alert"'), html);
    assert.ok(html.includes('class="badge badge-warning"'), html);
    assert.ok(html.includes('data-stale-region="expense-rows"'), html);
    assert.ok(html.includes("Data may be stale."), html);
  });

  it("escapes the message and resolves descriptors", async () => {
    const hostile = await staleMarker({
      context: makeContext(),
      regionId: "rows",
      message: `<img src=x onerror=alert(1)>`,
    });
    assert.ok(!hostile.includes("<img"), hostile);
    assert.ok(hostile.includes("&lt;img"), hostile);
    const localized = await staleMarker({
      context: makeContext({ preferredLocales: ["nl"] }),
      regionId: "rows",
      message: message("Stale", { nl: "Verouderd" }),
    });
    assert.ok(localized.includes("Verouderd"), localized);
  });

  it("throws on bad region ids", async () => {
    await assert.rejects(
      staleMarker({ context: makeContext(), regionId: "Bad!", message: "x" }),
      /region id/,
    );
  });
});

describe("validationStatusSwaps", () => {
  it("returns the canonical form-region table", () => {
    const swaps = validationStatusSwaps("#expense-form");
    assert.deepEqual(swaps, [
      { status: "400", target: "#expense-form", swap: "morph" },
      { status: "422", target: "#expense-form", swap: "morph" },
      { status: "409", target: "#expense-form", swap: "morph" },
      { status: "5xx", target: "#expense-form", swap: "none" },
      { status: "429", target: "#expense-form", swap: "none" },
    ]);
  });

  it("morphs correctable outcomes and preserves input on 5xx/429", () => {
    const swaps = validationStatusSwaps("#f");
    const byStatus = new Map(swaps.map((entry) => [entry.status, entry.swap]));
    assert.equal(byStatus.get("400"), "morph");
    assert.equal(byStatus.get("422"), "morph");
    assert.equal(byStatus.get("409"), "morph");
    assert.equal(byStatus.get("5xx"), "none");
    assert.equal(byStatus.get("429"), "none");
  });

  it("has no entry for 403/404: those are full navigations, not swaps", () => {
    const swaps = validationStatusSwaps("#f");
    const statuses = swaps.map((entry) => entry.status);
    assert.ok(!statuses.includes("403"), `unexpected 403 entry: ${JSON.stringify(swaps)}`);
    assert.ok(!statuses.includes("404"), `unexpected 404 entry: ${JSON.stringify(swaps)}`);
    assert.ok(!statuses.includes("4xx"), `wildcard must not smuggle 403/404: ${JSON.stringify(swaps)}`);
  });

  it("wires into hxAttrs status serialization", () => {
    const out = hxAttrs({
      method: "post",
      href: "/expenses",
      target: "#expense-form",
      swap: "morph",
      statusSwaps: validationStatusSwaps("#expense-form"),
    });
    assert.ok(out.includes('hx-status:400="target:#expense-form swap:outerMorph"'), out);
    assert.ok(out.includes('hx-status:5xx="target:#expense-form swap:none"'), out);
  });

  it("throws on a bad form region target", () => {
    assert.throws(() => validationStatusSwaps(""), /target|selector/);
    assert.throws(() => validationStatusSwaps("div"), /target|selector/);
  });
});

describe("refreshTrigger", () => {
  it("returns the every-Ns trigger string", () => {
    assert.equal(refreshTrigger(60), "every 60s");
    assert.equal(refreshTrigger(1), "every 1s");
    assert.equal(refreshTrigger(3600), "every 3600s");
  });

  it("validates bounds", () => {
    assert.throws(() => refreshTrigger(0), /bounds/);
    assert.throws(() => refreshTrigger(3601), /bounds/);
    assert.throws(() => refreshTrigger(2.5), /integer/);
  });
});

describe("htmx DOM behavior", () => {
  it("region wrapper parses with a stable id", async () => {
    const html = await fragmentRegion({
      context: makeContext(),
      regionId: "expense-rows",
      content: [`<button type="button" id="row-1">Row</button>`],
      label: "Expenses",
    });
    const page = await loadHtml(html);
    try {
      const region = page.document.querySelector("section#expense-rows");
      assert.ok(region !== null, "region section must parse with its id");
      assert.equal(region?.getAttribute("data-region"), "expense-rows");
      assert.equal(region?.getAttribute("hx-swap"), "outerMorph");
    } finally {
      await page.close();
    }
  });

  it("regions scope swaps: touching one region leaves focus in another", async () => {
    // Library-owned claim: stable region ids scope swaps to one subtree.
    // Focus retention across a real morph is htmx runtime behavior, verified
    // at the L7 browser join; here the harness stands in for the swap.
    const form = await fragmentRegion({
      context: makeContext(),
      regionId: "expense-form",
      content: [`<input id="title" name="inputs[title]" value="">`],
      label: "Form",
    });
    const rows = await fragmentRegion({
      context: makeContext(),
      regionId: "expense-rows",
      content: [`<p>row one</p>`],
      label: "Rows",
    });
    const page = await loadHtml(`${form}${rows}`);
    try {
      // No DOM lib in this tsconfig (harness.ts carries the happy-dom types):
      // use structural types, never DOM global names.
      const input = page.document.querySelector("#title") as unknown as {
        focus(): void;
      } | null;
      assert.ok(input !== null, "form control must exist");
      input.focus();
      const activeId = (page.document.activeElement as { id: string } | null)?.id;
      assert.equal(activeId, "title");
      // Simulate a morph of the UNRELATED region: only its subtree is touched.
      const rowsRegion = page.document.querySelector("#expense-rows");
      assert.ok(rowsRegion !== null);
      rowsRegion.innerHTML = "<p>row one (reread)</p>";
      const stillActive = (page.document.activeElement as { id: string } | null)?.id;
      assert.equal(stillActive, "title");
    } finally {
      await page.close();
    }
  });

  it("stale marker is discoverable by data-stale-region", async () => {
    const region = await fragmentRegion({
      context: makeContext(),
      regionId: "expense-rows",
      content: ["<p>rows</p>"],
      label: "Rows",
    });
    const marker = await staleMarker({
      context: makeContext(),
      regionId: "expense-rows",
      message: "Reread failed; showing last known rows.",
    });
    const page = await loadHtml(`${region}${marker}`);
    try {
      const found = page.document.querySelector('[data-stale-region="expense-rows"]');
      assert.ok(found !== null, "stale marker must be discoverable by region");
      assert.equal(found?.getAttribute("role"), "alert");
    } finally {
      await page.close();
    }
  });

  it("controls inside a loaded region receive keyboard events", async () => {
    const html = await fragmentRegion({
      context: makeContext(),
      regionId: "expense-rows",
      content: [`<button type="button" id="more">More</button>`],
      label: "Rows",
    });
    const page = await loadHtml(html);
    try {
      const button = page.document.querySelector("#more");
      assert.ok(button !== null);
      let seen: string | null = null;
      button.addEventListener("keydown", (event) => {
        seen = (event as HappyKeyboardEvent).key;
      });
      pressKey(button, "Enter");
      assert.equal(seen, "Enter");
    } finally {
      await page.close();
    }
  });
});

describe("htmx XSS neutralization", () => {
  it("neutralizes javascript: hrefs in requests and polls", async () => {
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "  javascript:alert(1)  ",
      "data:text/html,<script>alert(1)</script>",
    ]) {
      const out = hxAttrs({ method: "get", href, target: "#a" });
      assert.ok(!out.toLowerCase().includes("javascript:"), out);
      assert.ok(!out.includes("<script>"), out);
      const poll = await pollTrigger({
        context: makeContext(),
        regionId: "rows",
        href,
        intervalSeconds: 5,
      });
      assert.ok(poll.includes('hx-get="#"'), poll);
    }
  });

  it("neutralizes hostile trigger and indicator content", () => {
    const out = hxAttrs({
      method: "get",
      href: "/x",
      target: "#a",
      trigger: `every 1s" onmouseover="alert(1)`,
      indicator: `"><script>alert(1)</script>`,
    });
    assert.ok(!out.includes("<script>"), out);
    assert.ok(!out.includes('onmouseover="alert(1)'), out);
    assert.ok(out.includes("&quot;"), out);
  });

  it("rejects hostile region id attempts everywhere", async () => {
    const attempts = [
      `"><img src=x onerror=alert(1)>`,
      "a/b",
      "a.b",
      "UPPER",
      "a__b",
      "..",
    ];
    for (const regionId of attempts) {
      await assert.rejects(
        fragmentRegion({ context: makeContext(), regionId, content: [], label: "x" }),
        /region id/,
        `fragmentRegion should reject ${JSON.stringify(regionId)}`,
      );
      await assert.rejects(
        pollTrigger({ context: makeContext(), regionId, href: "/x", intervalSeconds: 5 }),
        /region id/,
        `pollTrigger should reject ${JSON.stringify(regionId)}`,
      );
      await assert.rejects(
        staleMarker({ context: makeContext(), regionId, message: "x" }),
        /region id/,
        `staleMarker should reject ${JSON.stringify(regionId)}`,
      );
    }
  });
});
