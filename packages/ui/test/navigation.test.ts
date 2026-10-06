import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  AdmissionOutcome,
  AppearanceTone,
  MessageValue,
  NavigationEntry,
  NavigationGroup,
  PageDescriptor,
  PresentationContext,
} from "@canlang/contracts";
import {
  breadcrumbs,
  buildNavigation,
  button,
  dock,
  megamenu,
  menu,
  navbar,
  pagination,
  selectDiscoveryCandidates,
  themeController,
} from "../src/navigation.js";
import { message } from "../src/messages.js";
import { loadHtml } from "./harness.js";
import {
  DUPLICATE_PAGES,
  DYNAMIC_INVOICE_PAGE,
  EXPENSE_FULL_PAGES,
  HIDDEN_ADMIN_PAGE,
  SYNTHETIC_PAGES,
  TEAMTASKS_FULL_PAGES,
} from "./fixtures/descriptors.js";

function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  assert.ok(value !== undefined, `expected item at index ${index}`);
  return value;
}

function byPath(pages: readonly PageDescriptor[], path: string): PageDescriptor {
  const found = pages.find((page) => page.path === path);
  assert.ok(found !== undefined, `expected fixture with path ${path}`);
  return found;
}

function outcomesFor(
  descriptors: readonly PageDescriptor[],
  outcome: AdmissionOutcome = "admitted",
): Map<PageDescriptor, AdmissionOutcome> {
  return new Map(descriptors.map((descriptor) => [descriptor, outcome]));
}

function stubPage(
  owner: string,
  path: string,
  title: string,
  extra: Partial<PageDescriptor> = {},
): PageDescriptor {
  return {
    owner,
    path,
    title: message(title),
    admit: async () => ({}),
    render: async () => "",
    ...extra,
  };
}

function entryPaths(pages: readonly PageDescriptor[]): string[] {
  return pages.map((page) => page.path);
}

describe("selectDiscoveryCandidates", () => {
  it("excludes dynamic routes and nav=none pages, keeping declaration order", () => {
    const declared = [
      DYNAMIC_INVOICE_PAGE,
      ...TEAMTASKS_FULL_PAGES,
      HIDDEN_ADMIN_PAGE,
      ...EXPENSE_FULL_PAGES,
    ];
    const candidates = selectDiscoveryCandidates(declared);
    assert.deepEqual(entryPaths(candidates), ["/", "/notes", "/reports", "/expenses/review"]);
  });

  it("dedups (owner, path) pairs keeping the first occurrence", () => {
    const first = at(DUPLICATE_PAGES, 0);
    const candidates = selectDiscoveryCandidates(DUPLICATE_PAGES);
    assert.equal(candidates.length, 1);
    assert.strictEqual(at(candidates, 0), first);
  });
});

describe("buildNavigation", () => {
  it("denied pages yield no link and leave navigation complete", () => {
    const candidates = selectDiscoveryCandidates(TEAMTASKS_FULL_PAGES);
    const outcomes = outcomesFor(candidates);
    outcomes.set(byPath(candidates, "/notes"), "denied");
    const result = buildNavigation(candidates, outcomes, {
      ownerLabels: new Map<string, MessageValue>(),
      currentPath: "/",
    });
    assert.equal(result.incomplete, false);
    assert.equal(result.groups.length, 1);
    assert.deepEqual(
      at(result.groups, 0)?.entries.map((entry) => entry.path),
      ["/"],
    );
  });

  it("unavailable pages yield no link and mark navigation incomplete", () => {
    const candidates = selectDiscoveryCandidates(TEAMTASKS_FULL_PAGES);
    const outcomes = outcomesFor(candidates);
    outcomes.set(byPath(candidates, "/notes"), "unavailable");
    const result = buildNavigation(candidates, outcomes, {
      ownerLabels: new Map<string, MessageValue>(),
      currentPath: "/",
    });
    assert.equal(result.incomplete, true);
    assert.equal(result.groups.length, 1);
    assert.deepEqual(
      at(result.groups, 0)?.entries.map((entry) => entry.path),
      ["/"],
    );
  });

  it("throws when a candidate has no outcome", () => {
    const candidates = selectDiscoveryCandidates(TEAMTASKS_FULL_PAGES);
    assert.throws(
      () =>
        buildNavigation(candidates, new Map(), {
          ownerLabels: new Map<string, MessageValue>(),
          currentPath: "/",
        }),
      /missing admission outcome/,
    );
  });

  it("sorts by order ascending with default zero, BigInt compare, ties by input index", () => {
    const candidates = [
      byPath(SYNTHETIC_PAGES, "/a-big"),
      byPath(SYNTHETIC_PAGES, "/a-tie-first"),
      byPath(SYNTHETIC_PAGES, "/a-tie-second"),
      byPath(SYNTHETIC_PAGES, "/a-default-order"),
      byPath(SYNTHETIC_PAGES, "/a-negative"),
    ];
    const result = buildNavigation(candidates, outcomesFor(candidates), {
      ownerLabels: new Map<string, MessageValue>([["alpha", "Alpha"]]),
      currentPath: "/",
    });
    assert.equal(result.groups.length, 1);
    assert.deepEqual(
      at(result.groups, 0)?.entries.map((entry) => entry.path),
      ["/a-negative", "/a-default-order", "/a-tie-first", "/a-tie-second", "/a-big"],
    );
  });

  it("clusters explicit string groups and uses the group value as caption", () => {
    const candidates = [
      byPath(SYNTHETIC_PAGES, "/a-shared-one"),
      byPath(SYNTHETIC_PAGES, "/a-shared-two"),
    ];
    const result = buildNavigation(candidates, outcomesFor(candidates), {
      ownerLabels: new Map<string, MessageValue>(),
      currentPath: "/",
    });
    assert.equal(result.groups.length, 1);
    const group = at(result.groups, 0);
    assert.equal(group.caption, "Shared");
    assert.deepEqual(
      group.entries.map((entry) => entry.path),
      ["/a-shared-one", "/a-shared-two"],
    );
  });

  it("clusters descriptor groups by source across variant differences", () => {
    const candidates = [
      byPath(SYNTHETIC_PAGES, "/a-team-one"),
      byPath(SYNTHETIC_PAGES, "/a-team-two"),
    ];
    const result = buildNavigation(candidates, outcomesFor(candidates), {
      ownerLabels: new Map<string, MessageValue>(),
      currentPath: "/",
    });
    assert.equal(result.groups.length, 1);
    const group = at(result.groups, 0);
    assert.deepEqual(group.caption, message("Team", { nl: "Team" }));
    assert.deepEqual(
      group.entries.map((entry) => entry.path),
      ["/a-team-one", "/a-team-two"],
    );
  });

  it("falls back to the owner label for default-group captions", () => {
    const label = message("Beta app", { nl: "Beta-app" });
    const candidates = [byPath(SYNTHETIC_PAGES, "/b-default")];
    const result = buildNavigation(candidates, outcomesFor(candidates), {
      ownerLabels: new Map<string, MessageValue>([["beta", label]]),
      currentPath: "/",
    });
    assert.equal(result.groups.length, 1);
    assert.deepEqual(at(result.groups, 0)?.caption, label);
  });

  it("falls back to the first-declared eligible title when no label exists", () => {
    // First-declared default page is denied, so the fallback must move to
    // the next eligible admitted default-group entry — never the denied one.
    const candidates = [
      byPath(SYNTHETIC_PAGES, "/b-negative"),
      byPath(SYNTHETIC_PAGES, "/b-default"),
    ];
    const outcomes = outcomesFor(candidates);
    outcomes.set(at(candidates, 0), "denied");
    const result = buildNavigation(candidates, outcomes, {
      ownerLabels: new Map<string, MessageValue>(),
      currentPath: "/",
    });
    assert.equal(result.groups.length, 1);
    const group = at(result.groups, 0);
    assert.deepEqual(group.caption, message("B default"));
    assert.deepEqual(
      group.entries.map((entry) => entry.path),
      ["/b-default"],
    );
  });

  it("omits groups left empty by denial or unavailability", () => {
    const candidates = [
      byPath(SYNTHETIC_PAGES, "/a-negative"),
      byPath(SYNTHETIC_PAGES, "/b-default"),
    ];
    const denied = outcomesFor(candidates);
    denied.set(at(candidates, 1), "denied");
    const deniedResult = buildNavigation(candidates, denied, {
      ownerLabels: new Map<string, MessageValue>(),
      currentPath: "/",
    });
    assert.equal(deniedResult.incomplete, false);
    assert.deepEqual(
      deniedResult.groups.map((group) => group.owner),
      ["alpha"],
    );

    const unavailable = outcomesFor(candidates);
    unavailable.set(at(candidates, 0), "unavailable");
    unavailable.set(at(candidates, 1), "unavailable");
    const unavailableResult = buildNavigation(candidates, unavailable, {
      ownerLabels: new Map<string, MessageValue>(),
      currentPath: "/",
    });
    assert.equal(unavailableResult.incomplete, true);
    assert.equal(unavailableResult.groups.length, 0);
  });

  it("keeps same-caption groups from different owners separate", () => {
    const candidates = [
      byPath(SYNTHETIC_PAGES, "/a-shared-one"),
      byPath(SYNTHETIC_PAGES, "/a-shared-two"),
      byPath(SYNTHETIC_PAGES, "/b-shared"),
    ];
    const result = buildNavigation(candidates, outcomesFor(candidates), {
      ownerLabels: new Map<string, MessageValue>(),
      currentPath: "/",
    });
    assert.equal(result.groups.length, 2);
    const alpha = at(result.groups, 0);
    const beta = at(result.groups, 1);
    assert.equal(alpha.owner, "alpha");
    assert.equal(alpha.caption, "Shared");
    assert.deepEqual(
      alpha.entries.map((entry) => entry.path),
      ["/a-shared-one", "/a-shared-two"],
    );
    assert.equal(beta.owner, "beta");
    assert.equal(beta.caption, "Shared");
    assert.deepEqual(
      beta.entries.map((entry) => entry.path),
      ["/b-shared"],
    );
  });

  it("orders groups by first entry sorted position", () => {
    const candidates = selectDiscoveryCandidates(SYNTHETIC_PAGES);
    const result = buildNavigation(candidates, outcomesFor(candidates), {
      ownerLabels: new Map<string, MessageValue>(),
      currentPath: "/",
    });
    assert.deepEqual(
      result.groups.map((group) => group.owner),
      ["beta", "alpha", "alpha", "beta", "alpha"],
    );
    assert.deepEqual(
      result.groups.map((group) => group.caption),
      [
        message("B negative"),
        message("A tie first"),
        "Shared",
        "Shared",
        message("Team", { nl: "Team" }),
      ],
    );
    assert.deepEqual(
      result.groups.map((group) => group.entries.map((entry) => entry.path)),
      [
        ["/b-negative", "/b-default"],
        ["/a-negative", "/a-default-order", "/a-tie-first", "/a-tie-second", "/a-big"],
        ["/a-shared-one", "/a-shared-two"],
        ["/b-shared"],
        ["/a-team-one", "/a-team-two"],
      ],
    );
  });

  it("marks the current path active and honors highlightPath overrides", () => {
    const candidates = selectDiscoveryCandidates([
      ...TEAMTASKS_FULL_PAGES,
      ...EXPENSE_FULL_PAGES,
    ]);
    const flags = (highlightPath?: string): Array<[string, boolean]> =>
      buildNavigation(candidates, outcomesFor(candidates), {
        ownerLabels: new Map<string, MessageValue>(),
        currentPath: "/reports",
        ...(highlightPath === undefined ? {} : { highlightPath }),
      })
        .groups.flatMap((group) => group.entries)
        .map((entry) => [entry.path, entry.active]);

    assert.deepEqual(flags(), [
      ["/", false],
      ["/notes", false],
      ["/reports", true],
      ["/expenses/review", false],
    ]);
    assert.deepEqual(flags("/"), [
      ["/", true],
      ["/notes", false],
      ["/reports", false],
      ["/expenses/review", false],
    ]);
  });

  it("keeps same-path pages from different owners (dedup negative)", () => {
    const pages = [stubPage("alpha", "/shared", "Alpha"), stubPage("beta", "/shared", "Beta")];
    const candidates = selectDiscoveryCandidates(pages);
    assert.equal(candidates.length, 2);
    const result = buildNavigation(candidates, outcomesFor(candidates), {
      ownerLabels: new Map<string, MessageValue>(),
      currentPath: "/shared",
    });
    assert.equal(result.groups.length, 2);
    assert.deepEqual(
      result.groups.flatMap((group) => group.entries.map((entry) => entry.active)),
      [true, true],
    );
  });

  it("falls back past an unavailable first-declared page for the group title", () => {
    const first = stubPage("alpha", "/one", "One");
    const second = stubPage("alpha", "/two", "Two");
    const candidates = selectDiscoveryCandidates([first, second]);
    const outcomes = outcomesFor(candidates);
    outcomes.set(first, "unavailable");
    const result = buildNavigation(candidates, outcomes, {
      ownerLabels: new Map<string, MessageValue>(),
      currentPath: "/two",
    });
    assert.equal(result.incomplete, true);
    assert.equal(result.groups.length, 1);
    assert.deepEqual(at(result.groups, 0)?.caption, message("Two"));
    assert.deepEqual(
      at(result.groups, 0)?.entries.map((entry) => entry.path),
      ["/two"],
    );
  });

  it("marks nothing active when highlightPath matches no admitted page", () => {
    const candidates = selectDiscoveryCandidates(TEAMTASKS_FULL_PAGES);
    const result = buildNavigation(candidates, outcomesFor(candidates), {
      ownerLabels: new Map<string, MessageValue>(),
      currentPath: "/",
      highlightPath: "/invoices/123",
    });
    assert.deepEqual(
      result.groups.flatMap((group) => group.entries.map((entry) => entry.active)),
      [false, false],
    );
  });
});

// ---------------------------------------------------------------------------
// C6 navigation factories
// ---------------------------------------------------------------------------

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

function navEntry(
  path: string,
  title: MessageValue,
  active = false,
  owner = "alpha",
): NavigationEntry {
  return { owner, path, title, active };
}

function navGroup(caption: MessageValue, entries: readonly NavigationEntry[]): NavigationGroup {
  return { owner: "alpha", caption, entries };
}

function withExtra<T extends object>(props: T, extra: Record<string, unknown>): T {
  return { ...props, ...extra };
}

const XSS = `<script>alert(1)</script><img src=x onerror=alert(2)>`;

/** Visible page numbers in pagination order. */
function pageNumbers(html: string): string[] {
  return [...html.matchAll(/>(\d+)</g)].map((match) => match[1] as string);
}

function ellipsisCount(html: string): number {
  return html.split("…").length - 1;
}

describe("breadcrumbs", () => {
  const ancestry = [
    navEntry("/", "Home"),
    navEntry("/reports", message("Reports", { nl: "Rapporten" })),
    navEntry("/reports/7", "Quarterly"),
  ];

  it("renders ancestors as links and the current page as aria-current text", async () => {
    const html = await breadcrumbs({ context: makeContext(), label: "Trail", ancestry });
    const page = await loadHtml(html);
    try {
      const nav = page.document.querySelector("nav");
      assert.equal(nav?.getAttribute("aria-label"), "Trail");
      assert.ok(html.includes(`<div class="breadcrumbs"><ul>`), html);
      assert.ok(html.includes(`<li><a href="/">Home</a></li>`), html);
      assert.ok(
        html.includes(`<li><span aria-current="page">Quarterly</span></li>`),
        html,
      );
      assert.ok(!html.includes(`href="/reports/7"`), html);
    } finally {
      await page.close();
    }
  });

  it("resolves descriptor titles through the viewer locale", async () => {
    const html = await breadcrumbs({
      context: makeContext({ preferredLocales: ["nl"] }),
      label: "Trail",
      ancestry,
    });
    assert.ok(html.includes("Rapporten"), html);
    assert.ok(!html.includes(">Reports<"), html);
  });

  it("escapes titles, labels and hostile paths", async () => {
    const html = await breadcrumbs({
      context: makeContext(),
      label: XSS,
      ancestry: [navEntry(`javascript:alert(1)`, XSS), navEntry("/here", XSS)],
    });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
    assert.ok(html.includes(`href="#"`), html);
    assert.ok(!html.includes("javascript:"), html);
  });

  it("throws on an empty ancestry instead of inventing a trail", async () => {
    await assert.rejects(
      breadcrumbs({ context: makeContext(), label: "Trail", ancestry: [] }),
      /nonempty ancestry/,
    );
  });

  it("rejects every appearance token (base class only upstream)", async () => {
    const props = { context: makeContext(), label: "Trail", ancestry };
    await assert.rejects(
      breadcrumbs(withExtra(props, { size: "lg" })),
      /does not admit size|admits no appearance/,
    );
    await assert.rejects(
      breadcrumbs(withExtra(props, { tone: "primary" })),
      /admits no appearance/,
    );
  });
});

describe("button", () => {
  const actionBinding = {
    postTo: "/ops/approve",
    operation: "approve",
    operationId: "op-1",
    label: "Approve",
  };

  it("renders an action binding as a POST form with the operation hiddens", async () => {
    const html = await button({ context: makeContext(), action: actionBinding });
    assert.ok(html.includes(`<form action="/ops/approve" method="post">`), html);
    assert.ok(html.includes(`name="operation" value="approve"`), html);
    assert.ok(html.includes(`name="operation_id" value="op-1"`), html);
    assert.ok(html.includes(`name="_csrf" value="csrf-123"`), html);
    assert.ok(html.includes(`<button type="submit" class="btn">Approve</button>`), html);
  });

  it("prefers an explicit caption over the action label", async () => {
    const html = await button({
      context: makeContext(),
      caption: "Go",
      action: actionBinding,
    });
    assert.ok(html.includes(">Go</button>"), html);
    assert.ok(!html.includes("Approve"), html);
  });

  it("renders submit as a lone submit control with the owning form's caption", async () => {
    const html = await button({ context: makeContext(), caption: "Save", submit: true });
    assert.equal(html, `<button type="submit" class="btn">Save</button>`);
  });

  it("renders target as a styled link defaulting its text to the URL", async () => {
    const html = await button({ context: makeContext(), target: "/reviews" });
    assert.equal(html, `<a class="btn" href="/reviews">/reviews</a>`);
    const captioned = await button({
      context: makeContext(),
      caption: "Reviews",
      target: "/reviews",
    });
    assert.ok(captioned.includes(">Reviews</a>"), captioned);
  });

  it("renders opens as a :target opener for the declared panel id", async () => {
    const html = await button({
      context: makeContext(),
      caption: "Score",
      opens: "review_details",
    });
    assert.equal(html, `<a class="btn" href="#review_details">Score</a>`);
  });

  it("rejects zero bindings and two-or-more bindings", async () => {
    await assert.rejects(button({ context: makeContext() }), /exactly one/);
    await assert.rejects(
      button({ context: makeContext(), caption: "x", submit: true, target: "/x" }),
      /exactly one/,
    );
    await assert.rejects(
      button({ context: makeContext(), action: actionBinding, opens: "panel" }),
      /exactly one/,
    );
  });

  it("rejects submit values other than true", async () => {
    await assert.rejects(
      button(
        withExtra({ context: makeContext(), caption: "x" }, { submit: false }),
      ),
      /submit must be true/,
    );
  });

  it("requires a caption where the binding cannot derive one", async () => {
    await assert.rejects(button({ context: makeContext(), submit: true }), /needs a caption/);
    await assert.rejects(
      button({ context: makeContext(), opens: "panel" }),
      /needs the panel caption/,
    );
  });

  it("rejects bad activation ids, empty targets and empty action fields", async () => {
    await assert.rejects(
      button({ context: makeContext(), caption: "x", opens: "9lives" }),
      /must match/,
    );
    await assert.rejects(
      button({ context: makeContext(), caption: "x", opens: "has space" }),
      /must match/,
    );
    await assert.rejects(button({ context: makeContext(), target: "  " }), /non-empty target/);
    await assert.rejects(
      button({
        context: makeContext(),
        action: { ...actionBinding, operation: "" },
      }),
      /non-empty action operation/,
    );
  });

  it("serializes bound scalar arguments like the canonical action factory", async () => {
    const html = await button({
      context: makeContext(),
      action: { ...actionBinding, inputs: { qty: 2, rush: true, note: "x", big: 10n } },
    });
    assert.ok(html.includes(`name="inputs[qty]" value="2"`), html);
    assert.ok(html.includes(`name="inputs[rush]" value="true"`), html);
    assert.ok(html.includes(`name="inputs[note]" value="x"`), html);
    assert.ok(html.includes(`name="inputs[big]" value="10"`), html);
    await assert.rejects(
      button({
        context: makeContext(),
        action: { ...actionBinding, inputs: { "has space": 1 } },
      }),
      /field path|inputs\[/,
    );
    await assert.rejects(
      button({
        context: makeContext(),
        action: { ...actionBinding, inputs: { qty: Number.NaN } },
      }),
      /finite/,
    );
  });

  it("treats null bindings as absent and never routes into them", async () => {
    await assert.rejects(
      button(withExtra({ context: makeContext(), caption: "x" }, { opens: null })),
      /exactly one/,
    );
    const html = await button(
      withExtra({ context: makeContext(), target: "/reviews" }, { opens: null }),
    );
    assert.ok(html.includes(`<a class="btn" href="/reviews">`), html);
    const targetWins = await button(
      withExtra({ context: makeContext(), target: "/x" }, { submit: null }),
    );
    assert.ok(targetWins.includes(`<a class="btn" href="/x">`), targetWins);
    const submitWins = await button(
      withExtra({ context: makeContext(), caption: "Save", submit: true }, { target: null }),
    );
    assert.ok(submitWins.includes(`<button type="submit"`), submitWins);
    await assert.rejects(
      button(withExtra({ context: makeContext() }, { submit: null, target: null })),
      /exactly one/,
    );
  });

  it("escapes captions and falls back hostile targets to #", async () => {
    const html = await button({ context: makeContext(), target: `javascript:alert(1)` });
    assert.ok(html.includes(`href="#"`), html);
    assert.ok(!html.includes(`href="javascript:`), html);
    // The link precedent: fallback keeps the escaped raw target as text.
    assert.ok(html.includes(`>javascript:alert(1)</a>`), html);
    const xss = await button({ context: makeContext(), caption: XSS, submit: true });
    assert.ok(!xss.includes("<script>"), xss);
    assert.ok(xss.includes("&lt;script&gt;"), xss);
  });

  it("maps the admitted tone/size/variant scale", async () => {
    const html = await button({
      context: makeContext(),
      caption: "x",
      submit: true,
      tone: "primary",
      size: "lg",
      variant: "outline",
    });
    assert.ok(html.includes(`class="btn btn-primary btn-lg btn-outline"`), html);
    const solid = await button({ context: makeContext(), caption: "x", submit: true });
    assert.ok(solid.includes(`class="btn"`), solid);
  });

  it("rejects unadmitted appearance tokens", async () => {
    const props = { context: makeContext(), caption: "x", submit: true as const };
    await assert.rejects(
      button(withExtra(props, { orientation: "horizontal" })),
      /does not admit orientation/,
    );
    await assert.rejects(
      button({ ...props, tone: "blurple" as unknown as AppearanceTone }),
      /does not admit tone/,
    );
  });
});

describe("menu", () => {
  const entries = [
    navEntry("/", "Home"),
    navEntry("/notes", message("Notes", { nl: "Notities" }), true),
  ];

  it("renders a nav list with the active entry marked", async () => {
    const html = await menu({ context: makeContext(), label: "Pages", entries });
    const page = await loadHtml(html);
    try {
      const nav = page.document.querySelector("nav");
      assert.equal(nav?.getAttribute("aria-label"), "Pages");
      assert.equal(page.document.querySelectorAll("nav ul li").length, 2);
      assert.ok(html.includes(`<ul class="menu">`), html);
      assert.ok(
        html.includes(`<a href="/notes" class="menu-active" aria-current="page">Notes</a>`),
        html,
      );
    } finally {
      await page.close();
    }
  });

  it("resolves entry titles through the viewer locale", async () => {
    const html = await menu({
      context: makeContext({ preferredLocales: ["nl"] }),
      label: "Pages",
      entries,
    });
    assert.ok(html.includes("Notities"), html);
  });

  it("escapes titles, labels and hostile paths", async () => {
    const html = await menu({
      context: makeContext(),
      label: XSS,
      entries: [navEntry(`java\tscript:alert(1)`, XSS)],
    });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes(`href="#"`), html);
  });

  it("throws on empty entries", async () => {
    await assert.rejects(menu({ context: makeContext(), label: "Pages", entries: [] }), /nonempty/);
  });

  it("maps the admitted size/orientation scale", async () => {
    const html = await menu({
      context: makeContext(),
      label: "Pages",
      entries,
      size: "sm",
      orientation: "horizontal",
    });
    assert.ok(html.includes(`class="menu menu-sm menu-horizontal"`), html);
    const vertical = await menu({
      context: makeContext(),
      label: "Pages",
      entries,
      orientation: "vertical",
    });
    assert.ok(vertical.includes(`menu-vertical`), vertical);
  });

  it("rejects unadmitted appearance tokens", async () => {
    const props = { context: makeContext(), label: "Pages", entries };
    await assert.rejects(
      menu(withExtra(props, { tone: "primary" })),
      /does not admit tone/,
    );
    await assert.rejects(
      menu(withExtra(props, { variant: "ghost" })),
      /does not admit variant/,
    );
  });
});

describe("navbar", () => {
  const entries = [navEntry("/", "Home"), navEntry("/notes", "Notes", true)];

  it("renders start/center/end regions with a horizontal center menu", async () => {
    const html = await navbar({
      context: makeContext(),
      label: "Top",
      entries,
      start: [`<span>Brand</span>`],
      end: [`<span>Tools</span>`],
    });
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelector("nav")?.getAttribute("aria-label"), "Top");
      assert.ok(html.includes(`<div class="navbar">`), html);
      assert.ok(html.includes(`<div class="navbar-start"><span>Brand</span></div>`), html);
      assert.ok(html.includes(`<ul class="menu menu-horizontal">`), html);
      assert.ok(html.includes(`<div class="navbar-end"><span>Tools</span></div>`), html);
      assert.ok(html.includes(`aria-current="page"`), html);
    } finally {
      await page.close();
    }
  });

  it("omits slot regions when no slot children are given", async () => {
    const html = await navbar({ context: makeContext(), label: "Top", entries });
    assert.ok(!html.includes("navbar-start"), html);
    assert.ok(!html.includes("navbar-end"), html);
    assert.ok(html.includes("navbar-center"), html);
  });

  it("awaits thunk children and resolves titles by locale", async () => {
    const html = await navbar({
      context: makeContext({ preferredLocales: ["nl"] }),
      label: "Top",
      entries: [navEntry("/notes", message("Notes", { nl: "Notities" }))],
      start: async () => [`<b>B</b>`],
    });
    assert.ok(html.includes("<b>B</b>"), html);
    assert.ok(html.includes("Notities"), html);
  });

  it("escapes titles and labels", async () => {
    const html = await navbar({
      context: makeContext(),
      label: XSS,
      entries: [navEntry("/x", XSS)],
    });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
  });

  it("throws on empty entries and on provided-but-empty slots", async () => {
    await assert.rejects(
      navbar({ context: makeContext(), label: "Top", entries: [] }),
      /nonempty entries/,
    );
    await assert.rejects(
      navbar({ context: makeContext(), label: "Top", entries, start: [] }),
      /start slot needs a nonempty suite/,
    );
  });

  it("accepts only the solid variant and rejects other tokens", async () => {
    const bare = await navbar(
      withExtra({ context: makeContext(), label: "Top", entries }, { variant: "solid" }),
    );
    assert.ok(bare.includes(`<div class="navbar">`), bare);
    const props = { context: makeContext(), label: "Top", entries };
    await assert.rejects(
      navbar(withExtra(props, { variant: "outline" })),
      /does not admit variant/,
    );
    await assert.rejects(navbar(withExtra(props, { size: "lg" })), /does not admit size/);
  });
});

describe("dock", () => {
  const entries = [navEntry("/", "Home"), navEntry("/notes", "Notes", true)];

  it("renders labeled destinations with the active item marked", async () => {
    const html = await dock({ context: makeContext(), label: "Quick", entries });
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelector("nav")?.getAttribute("aria-label"), "Quick");
      assert.ok(html.includes(`<div class="dock">`), html);
      assert.ok(html.includes(`<span class="dock-label">Home</span>`), html);
      assert.ok(
        html.includes(`<a href="/notes" class="dock-active" aria-current="page">`),
        html,
      );
    } finally {
      await page.close();
    }
  });

  it("resolves titles through the viewer locale", async () => {
    const html = await dock({
      context: makeContext({ preferredLocales: ["nl"] }),
      label: "Quick",
      entries: [navEntry("/notes", message("Notes", { nl: "Notities" }))],
    });
    assert.ok(html.includes("Notities"), html);
  });

  it("escapes titles and hostile paths", async () => {
    const html = await dock({
      context: makeContext(),
      label: "Quick",
      entries: [navEntry(`javascript:alert(1)`, XSS)],
    });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes(`href="#"`), html);
  });

  it("throws on empty entries", async () => {
    await assert.rejects(dock({ context: makeContext(), label: "Quick", entries: [] }), /nonempty/);
  });

  it("maps admitted sizes and rejects other tokens", async () => {
    const html = await dock({ context: makeContext(), label: "Quick", entries, size: "xs" });
    assert.ok(html.includes(`class="dock dock-xs"`), html);
    const props = { context: makeContext(), label: "Quick", entries };
    await assert.rejects(
      dock(withExtra(props, { tone: "primary" })),
      /does not admit tone/,
    );
    await assert.rejects(
      dock(withExtra(props, { orientation: "vertical" })),
      /does not admit orientation/,
    );
  });
});

describe("megamenu", () => {
  const groups = [
    navGroup(message("Team", { nl: "Team-nl" }), [navEntry("/", "Home")]),
    navGroup("Reports", [navEntry("/notes", "Notes", true)]),
  ];

  it("renders one popover panel per group with an active indicator", async () => {
    const html = await megamenu({ context: makeContext(), label: "Sections", groups });
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelector("nav")?.getAttribute("aria-label"), "Sections");
      assert.ok(html.includes(`<div class="megamenu">`), html);
      assert.ok(html.includes(`<button type="button" popovertarget="megamenu-0">Team</button>`), html);
      assert.ok(
        html.includes(`<div popover id="megamenu-1"><ul class="menu" aria-label="Reports">`),
        html,
      );
      // Trigger immediately followed by its popover sibling (upstream order).
      assert.ok(
        html.includes(`>Reports</button><div popover id="megamenu-1">`),
        html,
      );
      assert.ok(html.includes(`<div class="megamenu-active" aria-hidden="true"></div>`), html);
      assert.ok(html.includes(`aria-current="page"`), html);
    } finally {
      await page.close();
    }
  });

  it("namespaces popover ids under an explicit prefix", async () => {
    const html = await megamenu({
      context: makeContext(),
      label: "Sections",
      groups,
      idPrefix: "siteNav",
    });
    assert.ok(html.includes(`popovertarget="siteNav-0"`), html);
    assert.ok(html.includes(`id="siteNav-1"`), html);
  });

  it("keeps two megamenus disjoint under distinct prefixes", async () => {
    const first = await megamenu({
      context: makeContext(),
      label: "A",
      groups,
      idPrefix: "navA",
    });
    const second = await megamenu({
      context: makeContext(),
      label: "B",
      groups,
      idPrefix: "navB",
    });
    assert.ok(first.includes(`id="navA-0"`), first);
    assert.ok(!first.includes("navB-"), first);
    assert.ok(second.includes(`id="navB-0"`), second);
    assert.ok(!second.includes("navA-"), second);
  });

  it("resolves group captions and entry titles by locale", async () => {
    const html = await megamenu({
      context: makeContext({ preferredLocales: ["nl"] }),
      label: "Sections",
      groups,
    });
    assert.ok(html.includes("Team-nl"), html);
  });

  it("escapes captions, titles and hostile paths", async () => {
    const html = await megamenu({
      context: makeContext(),
      label: XSS,
      groups: [navGroup(XSS, [navEntry(`javascript:alert(1)`, XSS)])],
    });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes(`href="#"`), html);
  });

  it("throws on empty groups, empty group entries and bad prefixes", async () => {
    await assert.rejects(
      megamenu({ context: makeContext(), label: "S", groups: [] }),
      /nonempty groups/,
    );
    await assert.rejects(
      megamenu({ context: makeContext(), label: "S", groups: [navGroup("G", [])] }),
      /nonempty entries/,
    );
    await assert.rejects(
      megamenu({ context: makeContext(), label: "S", groups, idPrefix: "9bad" }),
      /must match/,
    );
    await assert.rejects(
      megamenu(
        withExtra({ context: makeContext(), label: "S", groups }, { idPrefix: 5 }),
      ),
      /must match/,
    );
  });

  it("throws past the 10-group upstream anchor bound", async () => {
    const many = Array.from({ length: 11 }, (_, index) =>
      navGroup(`G${String(index)}`, [navEntry(`/${String(index)}`, "x")]),
    );
    await assert.rejects(
      megamenu({ context: makeContext(), label: "S", groups: many }),
      /at most 10/,
    );
    const ten = many.slice(0, 10);
    const html = await megamenu({ context: makeContext(), label: "S", groups: ten });
    assert.ok(html.includes(`popovertarget="megamenu-9"`), html);
  });

  it("maps admitted sizes and vertical orientation", async () => {
    const html = await megamenu({
      context: makeContext(),
      label: "S",
      groups,
      size: "lg",
      orientation: "vertical",
    });
    assert.ok(html.includes(`class="megamenu megamenu-lg megamenu-vertical"`), html);
  });

  it("rejects horizontal orientation and other unadmitted tokens", async () => {
    const props = { context: makeContext(), label: "S", groups };
    await assert.rejects(
      megamenu(withExtra(props, { orientation: "horizontal" })),
      /does not admit orientation/,
    );
    await assert.rejects(
      megamenu(withExtra(props, { tone: "primary" })),
      /does not admit tone/,
    );
  });
});

describe("pagination", () => {
  const hrefForPage = (page: number): string => `/items?page=${String(page)}`;

  it("renders prev/numbers/next with the current page marked", async () => {
    const html = await pagination({
      context: makeContext(),
      label: "Pages",
      page: 3,
      pages: 5,
      hrefForPage,
    });
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelector("nav")?.getAttribute("aria-label"), "Pages");
      assert.ok(html.includes(`<div class="join">`), html);
      assert.deepEqual(pageNumbers(html), ["1", "2", "3", "4", "5"]);
      assert.equal(ellipsisCount(html), 0);
      assert.ok(
        html.includes(`<a href="/items?page=3" class="join-item btn btn-active" aria-current="page">3</a>`),
        html,
      );
      assert.ok(html.includes(`<a href="/items?page=2" class="join-item btn">Previous</a>`), html);
      assert.ok(html.includes(`<a href="/items?page=4" class="join-item btn">Next</a>`), html);
    } finally {
      await page.close();
    }
  });

  it("disables prev on the first page and next on the last page", async () => {
    const first = await pagination({
      context: makeContext(),
      label: "Pages",
      page: 1,
      pages: 3,
      hrefForPage,
    });
    assert.ok(
      first.includes(`<button type="button" class="join-item btn btn-disabled" disabled aria-disabled="true">Previous</button>`),
      first,
    );
    const last = await pagination({
      context: makeContext(),
      label: "Pages",
      page: 3,
      pages: 3,
      hrefForPage,
    });
    assert.ok(
      last.includes(`<button type="button" class="join-item btn btn-disabled" disabled aria-disabled="true">Next</button>`),
      last,
    );
  });

  it("collapses a long tail into an ellipsis while pinning first and last", async () => {
    const html = await pagination({
      context: makeContext(),
      label: "Pages",
      page: 1,
      pages: 20,
      hrefForPage,
    });
    assert.deepEqual(pageNumbers(html), ["1", "2", "3", "4", "5", "6", "20"]);
    assert.equal(ellipsisCount(html), 1);
  });

  it("collapses a long head into an ellipsis on the last page", async () => {
    const html = await pagination({
      context: makeContext(),
      label: "Pages",
      page: 20,
      pages: 20,
      hrefForPage,
    });
    assert.deepEqual(pageNumbers(html), ["1", "15", "16", "17", "18", "19", "20"]);
    assert.equal(ellipsisCount(html), 1);
  });

  it("centers the window with two ellipses mid-range", async () => {
    const html = await pagination({
      context: makeContext(),
      label: "Pages",
      page: 10,
      pages: 20,
      hrefForPage,
    });
    assert.deepEqual(pageNumbers(html), ["1", "8", "9", "10", "11", "12", "20"]);
    assert.equal(ellipsisCount(html), 2);
  });

  it("honors a custom window width", async () => {
    const html = await pagination({
      context: makeContext(),
      label: "Pages",
      page: 10,
      pages: 20,
      hrefForPage,
      window: 5,
    });
    assert.deepEqual(pageNumbers(html), ["1", "9", "10", "11", "20"]);
    assert.equal(ellipsisCount(html), 2);
  });

  it("pins first/last with a single gap at one past the window", async () => {
    const html = await pagination({
      context: makeContext(),
      label: "Pages",
      page: 4,
      pages: 8,
      hrefForPage,
    });
    assert.deepEqual(pageNumbers(html), ["1", "2", "3", "4", "5", "6", "8"]);
    assert.equal(ellipsisCount(html), 1);
    assert.equal(new Set(pageNumbers(html)).size, pageNumbers(html).length);
  });

  it("uses caller hrefs verbatim and escapes them for the attribute sink", async () => {
    const html = await pagination({
      context: makeContext(),
      label: "Pages",
      page: 2,
      pages: 3,
      hrefForPage: (page) => `/items?page=${String(page)}&q=a"b`,
    });
    assert.ok(html.includes(`href="/items?page=1&amp;q=a&quot;b"`), html);
    const hostile = await pagination({
      context: makeContext(),
      label: "Pages",
      page: 2,
      pages: 3,
      hrefForPage: () => `javascript:alert(1)`,
    });
    assert.ok(!hostile.includes("javascript:"), hostile);
    assert.ok(hostile.includes(`href="#"`), hostile);
  });

  it("prefers explicit prev/next labels and resolves defaults by locale", async () => {
    const html = await pagination({
      context: makeContext(),
      label: "Pages",
      page: 2,
      pages: 3,
      hrefForPage,
      prevLabel: "Back",
      nextLabel: XSS,
    });
    assert.ok(html.includes(">Back</a>"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
    const nl = await pagination({
      context: makeContext({ preferredLocales: ["nl"] }),
      label: "Pages",
      page: 2,
      pages: 3,
      hrefForPage,
    });
    assert.ok(nl.includes(">Vorige</a>"), nl);
    assert.ok(nl.includes(">Volgende</a>"), nl);
  });

  it("fails closed on out-of-range pages, bad counts and small windows", async () => {
    const base = { context: makeContext(), label: "Pages", hrefForPage };
    await assert.rejects(pagination({ ...base, page: 0, pages: 5 }), /1 <= page/);
    await assert.rejects(pagination({ ...base, page: 6, pages: 5 }), /1 <= page/);
    await assert.rejects(pagination({ ...base, page: 1, pages: 0 }), /pages >= 1/);
    await assert.rejects(pagination({ ...base, page: 1.5, pages: 5 }), /1 <= page/);
    await assert.rejects(
      pagination({ ...base, page: 5, pages: 20, window: 4 }),
      /window >= 5/,
    );
    await assert.rejects(
      pagination({ ...base, page: 1, pages: 1, hrefForPage: "x" as unknown as (page: number) => string }),
      /must be a function/,
    );
    await assert.rejects(
      pagination({
        ...base,
        page: 1,
        pages: 1,
        hrefForPage: (() => 7) as unknown as (page: number) => string,
      }),
      /must return a string/,
    );
  });

  it("rejects every appearance token (join+button carry no matrix)", async () => {
    const props = { context: makeContext(), label: "Pages", page: 1, pages: 2, hrefForPage };
    await assert.rejects(pagination(withExtra(props, { size: "lg" })), /admits no appearance/);
  });
});

describe("themeController", () => {
  const themes = [
    { value: "can-light-blue", label: "Light blue" },
    { value: "can-dark-blue", label: message("Dark blue", { nl: "Donkerblauw" }) },
  ];

  it("posts the theme choice with the CSRF field to the caller path", async () => {
    const html = await themeController({
      context: makeContext(),
      label: "Appearance",
      postTo: "/settings/theme",
      themes,
      current: "can-dark-blue",
    });
    const page = await loadHtml(html);
    try {
      const form = page.document.querySelector("form");
      assert.equal(form?.getAttribute("action"), "/settings/theme");
      assert.equal(form?.getAttribute("method"), "post");
      assert.equal(
        page.document.querySelector(`input[name="_csrf"]`)?.getAttribute("value"),
        "csrf-123",
      );
      assert.equal(page.document.querySelector("fieldset legend")?.textContent, "Appearance");
      const radios = [...page.document.querySelectorAll(`input[name="theme"]`)];
      assert.equal(radios.length, 2);
      assert.equal(radios[0]?.getAttribute("value"), "can-light-blue");
      assert.equal(radios[1]?.getAttribute("value"), "can-dark-blue");
      assert.ok(html.includes(`value="can-dark-blue" checked`), html);
      assert.ok(!html.includes(`value="can-light-blue" checked`), html);
      assert.ok(html.includes(`<button type="submit" class="btn btn-primary">Save</button>`), html);
    } finally {
      await page.close();
    }
  });

  it("resolves option labels through the viewer locale", async () => {
    const html = await themeController({
      context: makeContext({ preferredLocales: ["nl"] }),
      label: "Appearance",
      postTo: "/settings/theme",
      themes,
    });
    assert.ok(html.includes("Donkerblauw"), html);
    assert.ok(html.includes(">Opslaan</button>"), html);
  });

  it("escapes labels and hostile post paths", async () => {
    const html = await themeController({
      context: makeContext(),
      label: XSS,
      postTo: `javascript:alert(1)`,
      themes: [{ value: "can-light-blue", label: XSS }],
    });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes(`action="#"`), html);
    assert.ok(!html.includes("javascript:"), html);
  });

  it("throws on unknown, duplicate or unlisted-current themes", async () => {
    const base = { context: makeContext(), label: "Appearance", postTo: "/settings/theme" };
    await assert.rejects(
      themeController({
        ...base,
        themes: [{ value: "can-light-pink", label: "Pink" }],
      }),
      /unknown theme/,
    );
    await assert.rejects(
      themeController({
        ...base,
        themes: [
          { value: "can-light-blue", label: "A" },
          { value: "can-light-blue", label: "B" },
        ],
      }),
      /duplicate theme/,
    );
    await assert.rejects(
      themeController({ ...base, themes, current: "can-dark-green" }),
      /not a listed theme/,
    );
    await assert.rejects(themeController({ ...base, themes: [] }), /nonempty themes/);
    await assert.rejects(
      themeController({ ...base, themes, postTo: "  " }),
      /non-empty postTo/,
    );
  });

  it("rejects every appearance token (no component CSS)", async () => {
    const props = {
      context: makeContext(),
      label: "Appearance",
      postTo: "/settings/theme",
      themes,
    };
    await assert.rejects(
      themeController(withExtra(props, { tone: "primary" })),
      /admits no appearance/,
    );
  });

  it("carries the preview hook on radios and a cancel reset control", async () => {
    const html = await themeController({
      context: makeContext(),
      label: "Appearance",
      postTo: "/settings/theme",
      themes,
    });
    assert.ok(html.includes(`class="radio theme-controller"`), html);
    assert.ok(html.includes(`<button type="reset" class="btn btn-ghost">Cancel</button>`), html);
    const dutch = await themeController({
      context: makeContext({ preferredLocales: ["nl"] }),
      label: "Weergave",
      postTo: "/settings/theme",
      themes,
    });
    assert.ok(dutch.includes(">Annuleren</button>"), dutch);
  });
});

describe("navigation label guards", () => {
  const entries = [navEntry("/", "Home")];
  const groups = [navGroup("Team", entries)];
  const hrefForPage = (page: number): string => `/items?page=${String(page)}`;
  const themes = [{ value: "can-light-blue", label: "Light blue" }];

  it("rejects empty labels instead of emitting empty accessible names", async () => {
    const context = makeContext();
    await assert.rejects(
      breadcrumbs({ context, label: "", ancestry: entries }),
      /label must not be empty/,
    );
    await assert.rejects(menu({ context, label: "", entries }), /label must not be empty/);
    await assert.rejects(navbar({ context, label: "", entries }), /label must not be empty/);
    await assert.rejects(dock({ context, label: "", entries }), /label must not be empty/);
    await assert.rejects(
      megamenu({ context, label: "", groups }),
      /label must not be empty/,
    );
    await assert.rejects(
      pagination({ context, label: "", page: 1, pages: 1, hrefForPage }),
      /label must not be empty/,
    );
    await assert.rejects(
      themeController({ context, label: "", postTo: "/theme", themes }),
      /label must not be empty/,
    );
  });

  it("rejects megamenu groups with empty captions", async () => {
    await assert.rejects(
      megamenu({
        context: makeContext(),
        label: "Sections",
        groups: [navGroup("", [navEntry("/", "Home")])],
      }),
      /group caption must not be empty/,
    );
  });
});
