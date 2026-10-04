import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CSRF_FIELD,
  TEAM_FIELD,
} from "../../contracts/src/presentation.js";
import type {
  AdmissionOutcome,
  MessageValue,
  NavigationResult,
  PageDescriptor,
  PresentationContext,
  ShellData,
} from "../../contracts/src/presentation.js";
import { message } from "../src/messages.js";
import { buildNavigation, selectDiscoveryCandidates } from "../src/navigation.js";
import { pageDirection, pageLocale, renderPage } from "../src/shell.js";
import { EXPENSE_FULL_PAGES, TEAMTASKS_FULL_PAGES } from "./fixtures/descriptors.js";

function makeContext(
  overrides: Partial<PresentationContext> = {},
): PresentationContext {
  return {
    preferredLocales: [],
    appDefaultLocale: "en",
    theme: { mode: "system", accent: "blue", density: "comfortable" },
    path: "/",
    isPartial: false,
    csrfToken: "csrf-123",
    principal: null,
    ...overrides,
  };
}

function makeDescriptor(title: MessageValue = "Team tasks"): PageDescriptor {
  return {
    owner: "TeamTasks",
    path: "/",
    title,
    admit: async () => ({}),
    render: async () => "",
  };
}

function makeNavigation(
  overrides: Partial<NavigationResult> = {},
): NavigationResult {
  return {
    groups: [
      {
        owner: "TeamTasks",
        caption: message("Work", { nl: "Werk" }),
        entries: [
          {
            owner: "TeamTasks",
            path: "/",
            title: message("Team tasks", { nl: "Teamtaken" }),
            active: true,
          },
          {
            owner: "TeamNotes",
            path: "/notes",
            title: message("Team notes", { nl: "Teamnotities" }),
            active: false,
          },
        ],
      },
    ],
    incomplete: false,
    ...overrides,
  };
}

function makeShell(overrides: Partial<ShellData> = {}): ShellData {
  return {
    navigation: makeNavigation(),
    brand: message("CanApp", { nl: "CanApp" }),
    routes: { signIn: "/sign-in", signOut: "/sign-out", switchTeam: "/team" },
    account: {
      authenticated: true,
      userLabel: "Ada",
      teams: [
        { id: "t1", label: "Red" },
        { id: "t2", label: "Blue" },
      ],
      currentTeamId: "t1",
    },
    settings: {
      sections: [
        { id: "profile", caption: message("Profile", { nl: "Profiel" }), active: true },
        { id: "theme", caption: message("Theme", { nl: "Thema" }), active: false },
      ],
      panelHtml: "<p>panel</p>",
    },
    ...overrides,
  };
}

describe("full-document structure", () => {
  it("emits doctype, lang, dir, title, theme and density", async () => {
    const html = await renderPage(
      makeContext({
        theme: { mode: "dark", accent: "purple", density: "compact" },
      }),
      makeDescriptor(),
      ["<p>hi</p>"],
      makeShell(),
    );
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<html lang="en" dir="ltr" data-theme="can-dark-purple">/);
    assert.match(html, /<meta charset="utf-8">/);
    assert.match(
      html,
      /<meta name="viewport" content="width=device-width, initial-scale=1">/,
    );
    assert.match(html, /<title>Team tasks — CanApp<\/title>/);
    assert.match(html, /<body class="density-compact">/);
    assert.match(html, /<main id="can-main"><p>hi<\/p><\/main>/);
    assert.ok(!html.includes("<script"));
  });

  it("omits the brand suffix when title equals brand", async () => {
    const html = await renderPage(
      makeContext(),
      makeDescriptor("CanApp"),
      [],
      makeShell(),
    );
    assert.match(html, /<title>CanApp<\/title>/);
  });

  it("resolves title and brand in the preferred locale", async () => {
    const html = await renderPage(
      makeContext({ preferredLocales: ["nl"] }),
      makeDescriptor(message("Team tasks", { nl: "Teamtaken" })),
      [],
      makeShell({ brand: message("CanApp", { nl: "KanApp" }) }),
    );
    assert.match(html, /<title>Teamtaken — KanApp<\/title>/);
    assert.match(html, /<html lang="nl"/);
  });
});

describe("drawer and navigation", () => {
  it("renders drawer chrome with menu button and overlay", async () => {
    const html = await renderPage(
      makeContext(),
      makeDescriptor(),
      [],
      makeShell(),
    );
    assert.match(html, /<div class="drawer lg:drawer-open">/);
    assert.match(
      html,
      /<input id="can-drawer" type="checkbox" class="drawer-toggle">/,
    );
    assert.match(
      html,
      /<label for="can-drawer" class="btn btn-square btn-ghost">/,
    );
    assert.match(html, /<span class="sr-only">Open menu<\/span>/);
    assert.match(html, /<svg aria-hidden="true"/);
    assert.match(
      html,
      /<label for="can-drawer" class="drawer-overlay" aria-label="Close menu"><\/label>/,
    );
    assert.match(
      html,
      /<aside class="w-80 min-h-full bg-base-200 flex flex-col">/,
    );
  });

  it("renders groups, menus and the active entry", async () => {
    const html = await renderPage(
      makeContext(),
      makeDescriptor(),
      [],
      makeShell(),
    );
    assert.match(
      html,
      /<nav class="flex-1 overflow-y-auto" hx-boost="true" hx-target="#can-main" hx-select="#can-main">/,
    );
    assert.match(html, /<div class="menu-title">Work<\/div>/);
    assert.match(
      html,
      /<li><a href="\/" class="active" aria-current="page">Team tasks<\/a><\/li>/,
    );
    assert.match(html, /<li><a href="\/notes">Team notes<\/a><\/li>/);
  });

  it("shows the generic incomplete status only when flagged", async () => {
    const incomplete = await renderPage(
      makeContext(),
      makeDescriptor(),
      [],
      makeShell({ navigation: makeNavigation({ incomplete: true }) }),
    );
    assert.match(
      incomplete,
      /<p role="status">Navigation is temporarily incomplete\.<\/p>/,
    );
    const complete = await renderPage(
      makeContext(),
      makeDescriptor(),
      [],
      makeShell(),
    );
    assert.ok(!complete.includes('role="status"'));
  });

  it("renders the brand caption", async () => {
    const html = await renderPage(
      makeContext(),
      makeDescriptor(),
      [],
      makeShell(),
    );
    assert.match(
      html,
      /<div class="can-brand px-4 py-3 text-lg font-bold">CanApp<\/div>/,
    );
  });

  it("localizes chrome wording in Dutch", async () => {
    const html = await renderPage(
      makeContext({ preferredLocales: ["nl"] }),
      makeDescriptor(),
      [],
      makeShell({ navigation: makeNavigation({ incomplete: true }) }),
    );
    assert.match(html, /<span class="sr-only">Menu openen<\/span>/);
    assert.match(html, /aria-label="Menu sluiten"/);
    assert.match(html, /De navigatie is tijdelijk onvolledig\./);
  });
});

describe("authenticated account menu", () => {
  it("renders the user label escaped in a dropup toggle", async () => {
    const html = await renderPage(
      makeContext(),
      makeDescriptor(),
      [],
      makeShell({
        account: {
          authenticated: true,
          userLabel: `<img src=x onerror=alert(1)>`,
          teams: [],
        },
      }),
    );
    assert.match(html, /dropdown dropdown-top/);
    assert.match(
      html,
      /<div tabindex="0" role="button" class="btn btn-block">&lt;img src=x onerror=alert\(1\)&gt;<\/div>/,
    );
  });

  it("falls back to the account caption without a user label", async () => {
    const html = await renderPage(
      makeContext({ preferredLocales: ["nl"] }),
      makeDescriptor(),
      [],
      makeShell({ account: { authenticated: true, teams: [] } }),
    );
    assert.match(
      html,
      /<div tabindex="0" role="button" class="btn btn-block">Account<\/div>/,
    );
  });

  it("marks the current team and posts form for others", async () => {
    const html = await renderPage(
      makeContext(),
      makeDescriptor(),
      [],
      makeShell(),
    );
    assert.match(html, /<li><span aria-current="true">Red<\/span><\/li>/);
    assert.match(
      html,
      new RegExp(
        `<li><form method="POST" action="/team">` +
          `<input type="hidden" name="${CSRF_FIELD}" value="csrf-123">` +
          `<input type="hidden" name="${TEAM_FIELD}" value="t2">` +
          `<button type="submit">Blue</button></form></li>`,
      ),
    );
  });

  it("renders the settings label and sign-out form", async () => {
    const html = await renderPage(
      makeContext(),
      makeDescriptor(),
      [],
      makeShell(),
    );
    assert.match(html, /<li><label for="can-settings">Settings<\/label><\/li>/);
    assert.match(
      html,
      new RegExp(
        `<li><form method="POST" action="/sign-out">` +
          `<input type="hidden" name="${CSRF_FIELD}" value="csrf-123">` +
          `<button type="submit">Sign out</button></form></li>`,
      ),
    );
  });
});

describe("anonymous account menu", () => {
  it("renders a sign-in button link", async () => {
    const html = await renderPage(
      makeContext(),
      makeDescriptor(),
      [],
      makeShell({ account: { authenticated: false, teams: [] } }),
    );
    assert.match(
      html,
      /<a class="btn btn-block" href="\/sign-in">Sign in<\/a>/,
    );
    assert.ok(!html.includes("dropdown-top"));
  });
});

describe("route escaping", () => {
  it("escapes route URLs for their attribute sink", async () => {
    const html = await renderPage(
      makeContext(),
      makeDescriptor(),
      [],
      makeShell({
        routes: {
          signIn: `/sign-in?next="/x"`,
          signOut: "/sign-out",
          switchTeam: "/team",
        },
        account: { authenticated: false, teams: [] },
      }),
    );
    assert.match(html, /href="\/sign-in\?next=&quot;\/x&quot;"/);
  });

  it("falls back unsafe route URLs", async () => {
    const html = await renderPage(
      makeContext(),
      makeDescriptor(),
      [],
      makeShell({
        routes: {
          signIn: "javascript:alert(1)",
          signOut: "/sign-out",
          switchTeam: "/team",
        },
        account: { authenticated: false, teams: [] },
      }),
    );
    assert.match(html, /<a class="btn btn-block" href="#">Sign in<\/a>/);
  });
});

describe("settings frame", () => {
  it("renders sections with the active mark and panel passthrough", async () => {
    const html = await renderPage(
      makeContext(),
      makeDescriptor(),
      [],
      makeShell(),
    );
    assert.match(
      html,
      /<input id="can-settings" type="checkbox" class="modal-toggle">/,
    );
    assert.match(
      html,
      /<div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="can-settings-title">/,
    );
    assert.match(html, /<h2 id="can-settings-title">Settings<\/h2>/);
    assert.match(
      html,
      /<label for="can-settings" class="btn btn-sm btn-circle absolute right-2 top-2" aria-label="Close">✕<\/label>/,
    );
    assert.match(
      html,
      /<li><button type="button" data-settings-section="profile" aria-current="true">Profile<\/button><\/li>/,
    );
    assert.match(
      html,
      /<li><button type="button" data-settings-section="theme">Theme<\/button><\/li>/,
    );
    assert.match(html, /<section class="can-settings-panel"><p>panel<\/p><\/section>/);
  });

  it("renders an empty panel when panelHtml is absent", async () => {
    const shell = makeShell();
    const html = await renderPage(makeContext(), makeDescriptor(), [], {
      ...shell,
      settings: { sections: shell.settings.sections },
    });
    assert.match(html, /<section class="can-settings-panel"><\/section>/);
  });
});

describe("partial mode", () => {
  it("returns only the main element and ignores shell", async () => {
    const html = await renderPage(
      makeContext({ isPartial: true }),
      makeDescriptor(),
      ["<p>a</p>", "<p>b</p>"],
      makeShell(),
    );
    assert.equal(html, "<main id=\"can-main\"><p>a</p><p>b</p></main>");
  });

  it("allows absent shell for partials", async () => {
    const html = await renderPage(
      makeContext({ isPartial: true }),
      makeDescriptor(),
      ["x"],
    );
    assert.equal(html, "<main id=\"can-main\">x</main>");
  });
});

describe("children", () => {
  it("throws when shell is absent on a full page", async () => {
    await assert.rejects(
      () => renderPage(makeContext(), makeDescriptor(), []),
      /requires shell data/,
    );
  });

  it("accepts array children including promises", async () => {
    const html = await renderPage(
      makeContext({ isPartial: true }),
      makeDescriptor(),
      ["a", Promise.resolve("b"), "c"],
    );
    assert.equal(html, "<main id=\"can-main\">abc</main>");
  });

  it("accepts thunk children, sync and async", async () => {
    const sync = await renderPage(
      makeContext({ isPartial: true }),
      makeDescriptor(),
      () => ["x", Promise.resolve("y")],
    );
    assert.equal(sync, "<main id=\"can-main\">xy</main>");
    const asyncThunk = await renderPage(
      makeContext({ isPartial: true }),
      makeDescriptor(),
      async () => ["p", "q"],
    );
    assert.equal(asyncThunk, "<main id=\"can-main\">pq</main>");
  });
});

describe("XSS vectors", () => {
  it("escapes titles, captions and labels", async () => {
    const evil = `"><script>alert(1)</script>`;
    const html = await renderPage(
      makeContext(),
      makeDescriptor(evil),
      [],
      makeShell({
        brand: evil,
        navigation: {
          groups: [
            {
              owner: "o",
              caption: evil,
              entries: [
                { owner: "o", path: "/x", title: evil, active: true },
              ],
            },
          ],
          incomplete: false,
        },
        account: {
          authenticated: true,
          userLabel: evil,
          teams: [{ id: `t" evil`, label: evil }],
          currentTeamId: "other",
        },
        settings: {
          sections: [{ id: `s"x`, caption: evil, active: true }],
          panelHtml: "<p>ok</p>",
        },
      }),
    );
    assert.ok(!html.includes("<script>alert(1)</script>"));
    assert.ok(!html.includes(`"><script>`));
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /value="t&quot; evil"/);
    assert.match(html, /data-settings-section="s&quot;x"/);
  });

  it("falls back javascript: entry paths", async () => {
    const html = await renderPage(
      makeContext(),
      makeDescriptor(),
      [],
      makeShell({
        navigation: {
          groups: [
            {
              owner: "o",
              caption: "G",
              entries: [
                {
                  owner: "o",
                  path: "javascript:alert(1)",
                  title: "Evil",
                  active: false,
                },
              ],
            },
          ],
          incomplete: false,
        },
      }),
    );
    assert.match(html, /<li><a href="#">Evil<\/a><\/li>/);
    assert.ok(!html.includes("javascript:"));
  });
});

describe("pageLocale and pageDirection", () => {
  it("prefers the first valid preferred locale", () => {
    assert.equal(pageLocale(makeContext({ preferredLocales: ["nl"] })), "nl");
    assert.equal(
      pageLocale(makeContext({ preferredLocales: ["PT-br"] })),
      "pt-BR",
    );
  });

  it("skips invalid preferred tags", () => {
    assert.equal(
      pageLocale(
        makeContext({ preferredLocales: ["not a tag!!", "nl"] }),
      ),
      "nl",
    );
  });

  it("falls back to the app default locale", () => {
    assert.equal(
      pageLocale(makeContext({ appDefaultLocale: "nl" })),
      "nl",
    );
    assert.equal(
      pageLocale(
        makeContext({ preferredLocales: ["not a tag!!"], appDefaultLocale: "nl" }),
      ),
      "nl",
    );
  });

  it("maps locales to writing direction", () => {
    assert.equal(pageDirection("en"), "ltr");
    assert.equal(pageDirection("ar"), "rtl");
    assert.equal(pageDirection("not a tag!!"), "ltr");
  });

  it("renders rtl documents for rtl locales", async () => {
    const html = await renderPage(
      makeContext({ preferredLocales: ["ar"] }),
      makeDescriptor(),
      [],
      makeShell(),
    );
    assert.match(html, /<html lang="ar" dir="rtl"/);
  });
});

describe("locale fallback", () => {
  it("renders full pages with an invalid app default (falls back to en)", async () => {
    const html = await renderPage(
      makeContext({ appDefaultLocale: "not a tag!!" }),
      makeDescriptor(),
      ["<p>hi</p>"],
      makeShell(),
    );
    assert.match(html, /<html lang="en" dir="ltr"/);
    assert.match(html, /<title>Team tasks — CanApp<\/title>/);
  });
});

describe("parameterized captions", () => {
  it("formats descriptor titles with bound params per locale", async () => {
    const title = message(
      "{n, plural, one {# task} other {# tasks}}",
      { nl: "{n, plural, one {# taak} other {# taken}}" },
      { n: { type: "int", value: 2n } },
    );
    const en = await renderPage(makeContext(), makeDescriptor(title), [], makeShell());
    assert.match(en, /<title>2 tasks — CanApp<\/title>/);
    const nl = await renderPage(
      makeContext({ preferredLocales: ["nl"] }),
      makeDescriptor(title),
      [],
      makeShell(),
    );
    assert.match(nl, /<title>2 taken — CanApp<\/title>/);
  });

  it("keeps plain-string braces verbatim", async () => {
    const html = await renderPage(makeContext(), makeDescriptor("Use {x} daily"), [], makeShell());
    assert.match(html, /<title>Use \{x\} daily — CanApp<\/title>/);
  });
});

describe("page description", () => {
  it("emits an escaped meta description when present, none when absent", async () => {
    const withDescription = { ...makeDescriptor(), description: message('Tasks & "notes"') };
    const html = await renderPage(makeContext(), withDescription, [], makeShell());
    assert.match(html, /<meta name="description" content="Tasks &amp; &quot;notes&quot;">/);
    const plain = await renderPage(makeContext(), makeDescriptor(), [], makeShell());
    assert.doesNotMatch(plain, /<meta name="description"/);
  });
});

describe("account edge cases", () => {
  it("renders all teams as forms when no current team is selected", async () => {
    const shell = makeShell();
    const account = shell.account;
    const html = await renderPage(makeContext(), makeDescriptor(), [], {
      ...shell,
      account: {
        authenticated: true,
        userLabel: "Ada",
        teams: account.teams,
      },
    });
    assert.doesNotMatch(html, /aria-current="true">Red/);
    assert.match(html, new RegExp(`name="${TEAM_FIELD}" value="t1"`));
    assert.match(html, new RegExp(`name="${TEAM_FIELD}" value="t2"`));
  });

  it("renders an empty settings section list", async () => {
    const shell = makeShell();
    const html = await renderPage(makeContext(), makeDescriptor(), [], {
      ...shell,
      settings: { sections: [] },
    });
    assert.match(html, /<section class="can-settings-sidebar"><ul class="menu"><\/ul><\/section>/);
  });
});

describe("navigation join", () => {
  it("renders discovered navigation end to end with highlight and incomplete state", async () => {
    const declared = [...TEAMTASKS_FULL_PAGES, ...EXPENSE_FULL_PAGES];
    const candidates = selectDiscoveryCandidates(declared);
    const outcomes = new Map<PageDescriptor, AdmissionOutcome>(
      candidates.map((candidate) => [candidate, "admitted"]),
    );
    const review = candidates.find((candidate) => candidate.path === "/expenses/review");
    assert.ok(review !== undefined);
    outcomes.set(review, "unavailable");
    const navigation = buildNavigation(candidates, outcomes, {
      ownerLabels: new Map(),
      currentPath: "/notes",
    });
    const shell = makeShell({ navigation });
    const notes = candidates.find((candidate) => candidate.path === "/notes");
    assert.ok(notes !== undefined);
    const html = await renderPage(makeContext({ path: "/notes" }), notes, ["<p>body</p>"], shell);
    assert.match(html, /<a href="\/notes" class="active" aria-current="page">/);
    assert.ok(!html.includes("/expenses/review"));
    assert.match(html, /<p role="status">Navigation is temporarily incomplete\.<\/p>/);
    assert.match(html, /<main id="can-main"><p>body<\/p><\/main>/);
  });
});
