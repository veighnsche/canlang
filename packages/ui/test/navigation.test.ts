import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  AdmissionOutcome,
  MessageValue,
  PageDescriptor,
} from "../../contracts/src/presentation.js";
import { buildNavigation, selectDiscoveryCandidates } from "../src/navigation.js";
import { message } from "../src/messages.js";
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
