import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PresentationContext } from "@canlang/contracts";
import { message } from "../src/messages.js";
import { review } from "../src/review.js";

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

describe("review", () => {
  it("renders all five policy slots from props in source order", async () => {
    const html = await review({
      context: makeContext(),
      policy: {
        text: "Refunds within 30 days.",
        decision: "Approved",
        rationale: "Receipt verified.",
        actor: "Ada Lovelace",
        time: "2026-10-04",
      },
    });
    assert.ok(html.startsWith(`<section aria-label="Review">`), "labelled section");
    assert.ok(html.includes("<dl>"), "description list");
    const order = [
      html.indexOf("<dt>Policy</dt><dd>Refunds within 30 days.</dd>"),
      html.indexOf("<dt>Decision</dt><dd>Approved</dd>"),
      html.indexOf("<dt>Rationale</dt><dd>Receipt verified.</dd>"),
      html.indexOf("<dt>Actor</dt><dd>Ada Lovelace</dd>"),
      html.indexOf("<dt>Time</dt><dd>2026-10-04</dd>"),
    ];
    for (const [index, position] of order.entries()) {
      assert.ok(position !== -1, `slot ${String(index)} rendered verbatim`);
      if (index > 0) {
        assert.ok(position > (order[index - 1] as number), "source order kept");
      }
    }
    assert.ok(html.endsWith("</section>"), "section closed");
  });

  it("rejects an empty caption instead of emitting an empty name", async () => {
    await assert.rejects(
      review({ context: makeContext(), policy: { decision: "Approved" }, caption: "" }),
      /caption must not be empty/,
    );
  });

  it("renders explicit unavailable presentation for missing slots, never guesses", async () => {
    const html = await review({
      context: makeContext(),
      policy: { decision: "Approved", rationale: null },
    });
    assert.ok(html.includes("<dt>Decision</dt><dd>Approved</dd>"), "supplied slot verbatim");
    assert.equal((html.match(/<dd>Unavailable<\/dd>/g) ?? []).length, 4, "four absent slots");
    assert.ok(!html.includes("<dd></dd>"), "no silent empty slot");
  });

  it("throws when policy is absent", async () => {
    for (const policy of [undefined, null, 42, "text", []]) {
      await assert.rejects(
        review({ context: makeContext(), policy: policy as unknown as never }),
        /policy is absent/,
      );
    }
  });

  it("throws naming the slot for non-message slot values", async () => {
    await assert.rejects(
      review({ context: makeContext(), policy: { decision: 42 as unknown as string } }),
      /slot "decision"/,
    );
  });

  it("escapes every text sink", async () => {
    const html = await review({
      context: makeContext(),
      caption: `Cap"><script>alert(1)</script>`,
      policy: {
        text: `T<img src=x onerror=alert(1)>`,
        decision: `D<script>alert(1)</script>`,
        rationale: `R" onmouseover="alert(1)`,
        actor: `A<svg onload=alert(1)>`,
        time: `T<iframe src=javascript:alert(1)>`,
      },
    });
    for (const hostile of ["<script>", "<img", "<svg", "<iframe", `onmouseover="alert(1)"`]) {
      assert.ok(!html.includes(hostile), `no ${hostile} in markup`);
    }
    assert.ok(html.includes(`aria-label="Cap&quot;&gt;`), "caption escaped for the attribute");
  });

  it("prefers the explicit caption and resolves the viewer locale", async () => {
    const explicit = await review({
      context: makeContext(),
      caption: "Case 42",
      policy: { decision: "Approved" },
    });
    assert.ok(explicit.includes(`aria-label="Case 42"`), "explicit caption wins");
    const localized = await review({
      context: makeContext({ preferredLocales: ["nl"] }),
      caption: message("Case file", { nl: "Dossier" }),
      policy: { decision: message("Approved", { nl: "Goedgekeurd" }) },
    });
    assert.ok(localized.includes(`aria-label="Dossier"`), "nl caption resolved");
    assert.ok(localized.includes("<dd>Goedgekeurd</dd>"), "nl slot resolved");
    assert.ok(localized.includes("<dt>Beslissing</dt>"), "nl structural label resolved");
    assert.ok(localized.includes("<dd>Niet beschikbaar</dd>"), "nl unavailable resolved");
  });

  it("rejects every appearance token under the review catalog id", async () => {
    const base = { context: makeContext(), policy: { decision: "Approved" } };
    for (const extra of [
      { tone: "primary" },
      { size: "sm" },
      { variant: "ghost" },
      { orientation: "vertical" },
    ]) {
      await assert.rejects(
        review({ ...base, ...extra } as unknown as Parameters<typeof review>[0]),
        /appearance|tone|size|variant|orientation/,
      );
    }
  });
});
