/**
 * C9 join/audit/discovery evidence: route-level journeys over real lane-05
 * code paths (renderPage/login, discovery, forms, collections, htmx,
 * messages, catalog). No mocks of library code: only the hand-emitted
 * fixtures from ./fixtures/descriptors.ts plus test-local AdmitFn/RenderFn
 * doubles and outcome shapes. The fixtures are test-only stand-ins until L1
 * emits real descriptors; nothing here claims they are compiler output.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  AdmissionOutcome,
  AdmitFn,
  FormOutcome,
  MessageValue,
  NavigationResult,
  PageDescriptor,
  PresentationContext,
  RenderFn,
  RowQueryRunner,
  ShellData,
} from "../../contracts/src/presentation.js";
import * as ui from "../src/index.js";
import { UI_CATALOG } from "../src/catalog.js";
import { table } from "../src/collections.js";
import { action, form } from "../src/forms.js";
import { fragmentRegion, hxAttrs, validationStatusSwaps } from "../src/htmx.js";
import { message, resolveCaption } from "../src/messages.js";
import { buildNavigation, selectDiscoveryCandidates } from "../src/navigation.js";
import { renderLogin, renderPage } from "../src/shell.js";
import { loadHtml } from "./harness.js";
import {
  EXPENSE_PAGES,
  TEAMTASKS_PAGES,
  type StaticPageMeta,
} from "./fixtures/descriptors.js";

type Principal = "anonymous" | "member" | "lead";

function byPath(pages: readonly StaticPageMeta[], path: string): StaticPageMeta {
  const found = pages.find((page) => page.path === path);
  assert.ok(found !== undefined, `expected fixture with path ${path}`);
  return found;
}

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

function makeShell(navigation: NavigationResult, overrides: Partial<ShellData> = {}): ShellData {
  return {
    navigation,
    brand: message("CanApp", { nl: "KanApp" }),
    routes: { signIn: "/sign-in", signOut: "/sign-out", switchTeam: "/team" },
    account: {
      authenticated: true,
      userLabel: "Ada",
      teams: [{ id: "t1", label: "Red" }],
      currentTeamId: "t1",
    },
    settings: {
      sections: [{ id: "profile", caption: message("Profile", { nl: "Profiel" }), active: true }],
    },
    ...overrides,
  };
}

/**
 * Generated-guard shape: the admitted principals pass with (empty) bindings;
 * anyone else raises the ordinary safe page denial, which the dispatcher
 * maps to "denied". The denial text must never leak the page's content.
 */
function guard(allowed: readonly Principal[], page: string): AdmitFn {
  return async (context: unknown) => {
    if (typeof context !== "string" || !allowed.includes(context as Principal)) {
      throw new Error(`page denied: ${page} is not admitted for this principal`);
    }
    return {};
  };
}

const FORBIDDEN_FIELD = "salaryBand";
const FORBIDDEN_VALUE = "band-9-secret";

/**
 * Raw store rows carry a forbidden field; the authorized runner projects it
 * out before UI ever sees it (the runner's documented duty). UI renders only
 * the projection, so the forbidden field can never enter HTML.
 */
function projectingRunner(): RowQueryRunner {
  const raw = [{ id: "t1", title: "Buy milk", [FORBIDDEN_FIELD]: FORBIDDEN_VALUE }];
  return async () => ({
    rows: raw.map((row) => ({ id: row.id, fields: { title: row.title } })),
    columns: [{ field: "title", label: message("Title", { nl: "Titel" }), type: "text" }],
  });
}

interface AppJourney {
  readonly name: string;
  readonly pages: readonly StaticPageMeta[];
  readonly openPath: string;
  readonly restrictedPath: string;
  readonly titles: Record<string, { en: string; nl: string }>;
}

const APPS: readonly AppJourney[] = [
  {
    name: "TeamTasks",
    pages: TEAMTASKS_PAGES,
    openPath: "/",
    restrictedPath: "/notes",
    titles: {
      "/": { en: "Team tasks", nl: "Teamtaken" },
      "/notes": { en: "Team notes", nl: "Teamnotities" },
    },
  },
  {
    name: "ExpenseFlow",
    pages: EXPENSE_PAGES,
    openPath: "/reports",
    restrictedPath: "/expenses/review",
    titles: {
      "/reports": { en: "Expense summary", nl: "Onkostenoverzicht" },
      "/expenses/review": { en: "Expense review", nl: "Onkostenbeoordeling" },
    },
  },
];

/** Route descriptors with real admit/render fns over the fixture metas. */
function routeDescriptors(
  app: AppJourney,
  rendered: Map<string, boolean>,
): { open: PageDescriptor; restricted: PageDescriptor } {
  const openMeta = byPath(app.pages, app.openPath);
  const restrictedMeta = byPath(app.pages, app.restrictedPath);
  const openRender: RenderFn = async (context) => {
    rendered.set(app.openPath, true);
    return table({
      context,
      model: `${app.name}.Item`,
      columns: ["title"],
      empty: message("Nothing here yet.", { nl: "Nog niets hier." }),
    });
  };
  const restrictedRender: RenderFn = async (context) => {
    rendered.set(app.restrictedPath, true);
    return form({
      context,
      action: app.restrictedPath,
      operation: `${app.name}.Item.create`,
      operationId: "op-journey-1",
      mode: "create",
      timeZone: "UTC",
      fields: [{ path: "title", label: message("Title", { nl: "Titel" }), type: "text", required: true }],
      submit: message("Save", { nl: "Opslaan" }),
      idPrefix: "journey",
    });
  };
  return {
    open: { ...openMeta, admit: guard(["member", "lead"], app.openPath), render: openRender },
    restricted: {
      ...restrictedMeta,
      admit: guard(["lead"], app.restrictedPath),
      render: restrictedRender,
    },
  };
}

function ownerLabels(): ReadonlyMap<string, MessageValue> {
  return new Map([
    ["TeamTasks", message("Work", { nl: "Werk" })],
    ["TeamNotes", message("Notes", { nl: "Notities" })],
    ["reporting", message("Reporting", { nl: "Rapportage" })],
    ["expense", message("Expenses", { nl: "Onkosten" })],
  ]);
}

function titleFor(app: AppJourney, path: string, locale: "en" | "nl"): string {
  const titles = app.titles[path];
  assert.ok(titles !== undefined, `expected titles for ${path}`);
  return titles[locale];
}

/** Dispatcher stand-in: admit each candidate, map throws to "denied". */
async function admitAll(
  candidates: readonly PageDescriptor[],
  principal: Principal,
): Promise<Map<PageDescriptor, AdmissionOutcome>> {
  const outcomes = new Map<PageDescriptor, AdmissionOutcome>();
  for (const candidate of candidates) {
    try {
      await candidate.admit(principal);
      outcomes.set(candidate, "admitted");
    } catch {
      outcomes.set(candidate, "denied");
    }
  }
  return outcomes;
}

describe("authority journeys", () => {
  for (const app of APPS) {
    it(`${app.name}: denied principals get login, admitted principals get the full page (en + nl)`, async () => {
      for (const locale of ["en", "nl"] as const) {
        const preferredLocales = locale === "nl" ? ["nl"] : [];
        const rendered = new Map<string, boolean>();
        const { open, restricted } = routeDescriptors(app, rendered);
        const candidates = selectDiscoveryCandidates([open, restricted]);
        assert.deepStrictEqual(
          candidates.map((page) => page.path),
          [app.openPath, app.restrictedPath],
        );

        // Fully denied principal: empty nav, route renders never invoked,
        // canonical login surface still renders without page leakage.
        const deniedOutcomes = await admitAll(candidates, "anonymous");
        const deniedNav = buildNavigation(candidates, deniedOutcomes, {
          ownerLabels: ownerLabels(),
          currentPath: app.openPath,
        });
        assert.equal(deniedNav.groups.length, 0);
        assert.equal(rendered.size, 0, "denied routes must never render");
        const login = await renderLogin({
          context: makeContext({ preferredLocales }),
          action: "/sign-in",
          brand: message("CanApp", { nl: "KanApp" }),
          next: app.openPath,
          idPrefix: "can-login",
        });
        const signIn = locale === "nl" ? "Aanmelden" : "Sign in";
        assert.ok(login.includes(signIn), "login surface renders");
        assert.ok(login.includes('name="username"'), "login username renders");
        for (const path of [app.openPath, app.restrictedPath]) {
          const title = titleFor(app, path, locale);
          if (path !== "/") {
            assert.ok(!login.includes(`href="${path}"`), `${path} leaks into login`);
          }
          assert.ok(!login.includes(title), `${title} leaks into login`);
        }
        assert.ok(!login.includes(FORBIDDEN_FIELD));
        assert.ok(!login.includes(FORBIDDEN_VALUE));

        // Partially denied principal: nav excludes the restricted page only.
        const memberOutcomes = await admitAll(candidates, "member");
        const memberNav = buildNavigation(candidates, memberOutcomes, {
          ownerLabels: ownerLabels(),
          currentPath: app.openPath,
        });
        const memberPaths = memberNav.groups.flatMap((group) =>
          group.entries.map((entry) => entry.path),
        );
        assert.deepStrictEqual(memberPaths, [app.openPath]);

        // Admitted principal: full render with the same descriptors.
        const admittedOutcomes = await admitAll(candidates, "lead");
        const admittedNav = buildNavigation(candidates, admittedOutcomes, {
          ownerLabels: ownerLabels(),
          currentPath: app.openPath,
        });
        const context = makeContext({
          preferredLocales,
          path: app.openPath,
          query: projectingRunner(),
        });
        const bindings = await open.admit("lead");
        const html = await renderPage(
          context,
          open,
          [await open.render(context, bindings)],
          makeShell(admittedNav),
        );
        const openTitle = titleFor(app, app.openPath, locale);
        const restrictedTitle = titleFor(app, app.restrictedPath, locale);
        assert.ok(html.includes(openTitle), `admitted page renders ${openTitle}`);
        assert.ok(html.includes("Buy milk"), "authorized projection renders");
        assert.ok(!html.includes(FORBIDDEN_FIELD), "forbidden field absent");
        assert.ok(!html.includes(FORBIDDEN_VALUE), "forbidden value absent");
        assert.ok(html.includes(`href="${app.restrictedPath}"`), "admitted nav links both pages");
        assert.ok(html.includes("Ada"), "account surface renders");
        assert.ok(html.includes("/sign-out"), "sign-out surface renders");

        // Same descriptors, member principal: restricted page excluded from HTML.
        const memberContext = makeContext({
          preferredLocales,
          path: app.openPath,
          query: projectingRunner(),
        });
        const memberBindings = await open.admit("member");
        const memberHtml = await renderPage(
          memberContext,
          open,
          [await open.render(memberContext, memberBindings)],
          makeShell(memberNav),
        );
        assert.ok(!memberHtml.includes(`href="${app.restrictedPath}`));
        assert.ok(!memberHtml.includes(restrictedTitle));
      }
    });
  }
});

describe("locale fallback journeys", () => {
  it("falls back per the declared contract with resolved strings, never raw ICU", async () => {
    const title = (n: bigint): MessageValue =>
      message(
        "{n, plural, one {# task} other {# tasks}}",
        { nl: "{n, plural, one {# taak} other {# taken}}" },
        { n: { type: "int", value: n } },
      );
    const meta = byPath(TEAMTASKS_PAGES, "/");
    const descriptor: PageDescriptor = {
      ...meta,
      title: title(3n),
      admit: guard(["member", "lead"], "/"),
      render: async () => "<p>body</p>",
    };
    const cases: ReadonlyArray<{
      name: string;
      preferredLocales: readonly string[];
      appDefaultLocale: string;
      lang: string;
      expected: string;
    }> = [
      {
        // xx/fr are structurally valid but unsupported: the lang attribute
        // follows the first valid tag while strings fall back to en.
        name: "invalid tags skipped, valid-but-unsupported sets lang, strings fall back to en",
        preferredLocales: ["not a tag!!", "xx", "fr"],
        appDefaultLocale: "en",
        lang: "xx",
        expected: "3 tasks",
      },
      {
        name: "unsupported preferred keeps its lang tag, strings fall back to the nl app default",
        preferredLocales: ["xx"],
        appDefaultLocale: "nl",
        lang: "xx",
        expected: "3 taken",
      },
      {
        name: "invalid preferred plus invalid default falls back to en",
        preferredLocales: ["not a tag!!"],
        appDefaultLocale: "also not a tag!!",
        lang: "en",
        expected: "3 tasks",
      },
    ];
    for (const fallback of cases) {
      const candidates = selectDiscoveryCandidates([descriptor]);
      const nav = buildNavigation(
        candidates,
        new Map([[descriptor, "admitted" as AdmissionOutcome]]),
        { ownerLabels: ownerLabels(), currentPath: "/" },
      );
      const html = await renderPage(
        makeContext({
          preferredLocales: fallback.preferredLocales,
          appDefaultLocale: fallback.appDefaultLocale,
        }),
        descriptor,
        ["<p>body</p>"],
        makeShell(nav),
      );
      assert.ok(html.includes(`lang="${fallback.lang}"`), `${fallback.name}: lang`);
      assert.ok(html.includes(fallback.expected), `${fallback.name}: resolved string`);
      assert.ok(!html.includes("{n, plural"), `${fallback.name}: no raw ICU`);
      // resolveCaption agrees with the page render (same contract, direct call).
      assert.equal(
        resolveCaption(title(1n), {
          preferredLocales: fallback.preferredLocales,
          appDefaultLocale: fallback.appDefaultLocale,
        }),
        fallback.expected === "3 taken" ? "1 taak" : "1 task",
      );
    }
  });
});

describe("interaction journeys", () => {
  function journeyForm(outcomeErrors?: Parameters<typeof form>[0]["errors"]) {
    return form({
      context: makeContext(),
      action: "/todos",
      operation: "TeamTasks.Todo.create",
      operationId: "op-journey-form",
      mode: "create",
      timeZone: "UTC",
      fields: [
        {
          path: "title",
          label: "Title",
          type: "text",
          required: true,
          value: "typed so far",
        },
      ],
      ...(outcomeErrors === undefined ? {} : { errors: outcomeErrors }),
      submit: "Save",
      idPrefix: "j1",
    });
  }

  it("5xx/429 none-swaps leave unsaved input and focus untouched", async () => {
    const swaps = validationStatusSwaps("#task-form");
    for (const status of ["5xx", "429"]) {
      const entry = swaps.find((swap) => swap.status === status);
      assert.ok(entry !== undefined, `${status} has a documented swap entry`);
      assert.equal(entry.swap, "none", `${status} must never wipe user input`);
      assert.equal(entry.target, "#task-form");
    }
    // The request markup carries the none-swaps, so a 5xx/429 response swaps
    // nothing; the dispatcher surfaces those as banners/toasts instead.
    const attrs = hxAttrs({
      method: "post",
      href: "/todos",
      target: "#task-form",
      statusSwaps: swaps,
    });
    assert.ok(attrs.includes('hx-status:5xx="target:#task-form swap:none"'), attrs);
    assert.ok(attrs.includes('hx-status:429="target:#task-form swap:none"'), attrs);

    const region = await fragmentRegion({
      context: makeContext(),
      regionId: "task-form",
      content: [await journeyForm()],
      label: "Task form",
    });
    const page = await loadHtml(region);
    try {
      const input = page.document.querySelector("#j1-title") as unknown as {
        value: string;
        focus(): void;
      } | null;
      assert.ok(input !== null, "form control must exist");
      input.value = "unsaved draft";
      input.focus();
      // A "none" swap applies no markup: assert the survived state directly.
      assert.equal(input.value, "unsaved draft");
      const activeId = (page.document.activeElement as { id: string } | null)?.id;
      assert.equal(activeId, "j1-title");
    } finally {
      await page.close();
    }
  });

  it("400 morph swaps update the error outlet while value and focus survive", async () => {
    const swaps = validationStatusSwaps("#task-form");
    const badRequest = swaps.find((swap) => swap.status === "400");
    assert.ok(badRequest !== undefined, "400 has a documented swap entry");
    assert.equal(badRequest.swap, "morph");

    const first = await journeyForm([
      { path: "/title", code: "required", message: "Title is required." },
    ]);
    const region = await fragmentRegion({
      context: makeContext(),
      regionId: "task-form",
      content: [first],
      label: "Task form",
    });
    const page = await loadHtml(region);
    try {
      const input = page.document.querySelector("#j1-title") as unknown as {
        value: string;
        focus(): void;
        getAttribute(name: string): string | null;
      } | null;
      assert.ok(input !== null);
      input.value = "typed so far plus more";
      input.focus();

      // Server re-render from the same draft with a new validation message.
      // Morph semantics (htmx runtime, verified at the L7 browser join): only
      // the changed outlet subtree is touched, so the harness stands in for
      // the swap by copying just the outlet content into the live document.
      const second = await journeyForm([
        { path: "/title", code: "too_short", message: "Title needs 3+ characters." },
      ]);
      const scratch = await loadHtml(second);
      try {
        const fresh = scratch.document.querySelector("#j1-title-error");
        assert.ok(fresh !== null, "re-render carries the outlet");
        const live = page.document.querySelector("#j1-title-error");
        assert.ok(live !== null, "live outlet is the stable swap target");
        live.innerHTML = fresh.innerHTML;
      } finally {
        await scratch.close();
      }

      const after = page.document.querySelector("#j1-title") as unknown as {
        value: string;
        getAttribute(name: string): string | null;
      } | null;
      assert.ok(after !== null);
      assert.strictEqual(after, input, "input node untouched by the outlet swap");
      assert.equal(after.value, "typed so far plus more", "unsaved value survives");
      const activeId = (page.document.activeElement as { id: string } | null)?.id;
      assert.equal(activeId, "j1-title", "focus survives the outlet swap");
      const outletId = after.getAttribute("aria-describedby");
      assert.equal(outletId, "j1-title-error");
      const outlet = page.document.querySelector(`#${outletId ?? ""}`);
      assert.ok((outlet?.textContent ?? "").includes("Title needs 3+ characters."));
    } finally {
      await page.close();
    }
  });

  it("login username takes focus and error outlets link to their fields", async () => {
    const login = await renderLogin({
      context: makeContext(),
      action: "/sign-in",
      brand: "CanApp",
      idPrefix: "can-login",
    });
    const loginPage = await loadHtml(login);
    try {
      const username = loginPage.document.querySelector(
        "input#can-login-username",
      ) as unknown as { focus(): void } | null;
      assert.ok(username !== null);
      username.focus();
      const activeId = (loginPage.document.activeElement as { id: string } | null)?.id;
      assert.equal(activeId, "can-login-username");
      const label = loginPage.document.querySelector("label[for='can-login-username']");
      assert.ok(label !== null, "username label links to the input");
    } finally {
      await loginPage.close();
    }

    const meta = byPath(TEAMTASKS_PAGES, "/");
    const descriptor: PageDescriptor = {
      ...meta,
      admit: guard(["member", "lead"], "/"),
      render: async () => "",
    };
    const candidates = selectDiscoveryCandidates([descriptor]);
    const nav = buildNavigation(
      candidates,
      new Map([[descriptor, "admitted" as AdmissionOutcome]]),
      { ownerLabels: ownerLabels(), currentPath: "/" },
    );
    const body = await form({
      context: makeContext(),
      action: "/todos",
      operation: "TeamTasks.Todo.create",
      operationId: "op-journey-link",
      mode: "create",
      timeZone: "UTC",
      fields: [{ path: "title", label: "Title", type: "text", required: true }],
      errors: [{ path: "/title", code: "required", message: "Title is required." }],
      submit: "Save",
      idPrefix: "link",
    });
    const html = await renderPage(makeContext(), descriptor, [body], makeShell(nav));
    const route = await loadHtml(html);
    try {
      const input = route.document.querySelector("#link-title");
      assert.ok(input !== null);
      const describedBy = input?.getAttribute("aria-describedby");
      assert.equal(describedBy, "link-title-error");
      const outlet = route.document.querySelector(`#${describedBy ?? ""}`);
      assert.ok(outlet !== null, "outlet resolves from aria-describedby");
      assert.ok((outlet?.textContent ?? "").includes("Title is required."));
      assert.equal(input?.getAttribute("aria-invalid"), "true");
      const label = route.document.querySelector("label[for='link-title']");
      assert.ok(label !== null, "field label links to the input");
    } finally {
      await route.close();
    }
  });
});

describe("error journeys", () => {
  async function renderRoute(body: string): Promise<string> {
    const meta = byPath(TEAMTASKS_PAGES, "/");
    const descriptor: PageDescriptor = {
      ...meta,
      admit: guard(["member", "lead"], "/"),
      render: async () => body,
    };
    const candidates = selectDiscoveryCandidates([descriptor]);
    const nav = buildNavigation(
      candidates,
      new Map([[descriptor, "admitted" as AdmissionOutcome]]),
      { ownerLabels: ownerLabels(), currentPath: "/" },
    );
    return renderPage(makeContext(), descriptor, [body], makeShell(nav));
  }

  it("failed form outcomes render banners with matched and unmatched errors", async () => {
    const outcome: FormOutcome = {
      status: "failed",
      error: {
        code: "rule_failed",
        message: "A task with this title already exists.",
      },
    };
    const body = await form({
      context: makeContext(),
      action: "/todos",
      operation: "TeamTasks.Todo.create",
      operationId: "op-journey-fail",
      mode: "create",
      timeZone: "UTC",
      fields: [{ path: "title", label: "Title", type: "text", required: true, value: "Buy milk" }],
      errors: [
        { path: "/title", code: "rule_failed", message: "Title is taken." },
        { path: "/stale", code: "type", message: "Stale draft marker." },
      ],
      outcome,
      submit: "Save",
      idPrefix: "fail",
    });
    const html = await renderRoute(body);
    assert.ok(html.includes('role="alert"'), "outcome banner renders");
    assert.ok(html.includes("A task with this title already exists."), "error message kept");
    assert.ok(html.includes("<code>rule_failed</code>"), "error code kept");
    assert.ok(html.includes("Title is taken."), "matched field error kept");
    assert.ok(html.includes("Stale draft marker."), "unmatched error kept, not dropped");
    assert.ok(html.includes('value="Buy milk"'), "draft survives the failure render");
  });

  it("conflict outcomes render current values without dropping field errors", async () => {
    const outcome: FormOutcome = {
      status: "conflict",
      current: { title: "Current title from Ada" },
      message: message("Someone else changed this task.", {
        nl: "Iemand anders heeft deze taak gewijzigd.",
      }),
    };
    const body = await form({
      context: makeContext(),
      action: "/todos",
      operation: "TeamTasks.Todo.update",
      operationId: "op-journey-conflict",
      mode: "update",
      record: { id: "t1", version: "3" },
      timeZone: "UTC",
      fields: [
        { path: "title", label: "Title", type: "text", required: true, value: "My draft title" },
      ],
      errors: [{ path: "/changes/title", code: "conflict", message: "Title changed underneath you." }],
      outcome,
      submit: "Save",
      idPrefix: "conf",
    });
    const html = await renderRoute(body);
    assert.ok(html.includes("Someone else changed this task."), "conflict lead kept");
    assert.ok(html.includes("Current title from Ada"), "current value kept");
    assert.ok(html.includes("Title changed underneath you."), "field error kept");
    assert.ok(html.includes('value="My draft title"'), "draft kept alongside current");
  });

  it("action field errors render on the route with the button intact", async () => {
    const body = await action({
      context: makeContext(),
      action: "/todos/complete",
      operation: "TeamTasks.Todo.complete",
      operationId: "op-journey-action",
      label: "Complete",
      fields: [{ path: "note", label: "Note", type: "text", required: false }],
      errors: [{ path: "/note", code: "too_long", message: "Note is too long." }],
      idPrefix: "act",
    });
    const html = await renderRoute(body);
    assert.ok(html.includes("Note is too long."), "action field error kept");
    assert.ok(html.includes(">Complete</button>"), "action button intact");
    assert.ok(html.includes('id="act-note-error"'), "action outlet id stable");
  });
});

describe("discovery journeys", () => {
  it("enumerates and filters the full 88-entry surface programmatically", () => {
    const entries = UI_CATALOG.entries;
    assert.equal(entries.length, 88);

    const byKind = entries.filter((entry) => entry.kind === "component");
    assert.equal(byKind.length, 88, "kind filter keeps the whole surface");
    const byOwner = entries.filter((entry) => entry.owner === "lane-05");
    assert.equal(byOwner.length, 88, "owner filter keeps the whole surface");

    const profiles = new Set(entries.map((entry) => entry.profile));
    assert.deepStrictEqual(
      [...profiles].sort(),
      [
        "bound-control",
        "collection",
        "field-control",
        "group",
        "leaf",
        "shared-control",
        "shell",
        "slotted-group",
      ],
      "every profile is queryable",
    );
    let partitioned = 0;
    for (const profile of profiles) {
      const slice = entries.filter((entry) => entry.profile === profile);
      assert.ok(slice.length > 0, `${profile} has entries`);
      partitioned += slice.length;
    }
    assert.equal(partitioned, 88, "profile partitions cover the surface");

    const fields = entries.filter((entry) => entry.profile === "field-control");
    assert.ok(
      fields.every((entry) => entry.header === "selector"),
      "field-control filter returns selector-headed words only",
    );
    for (const entry of entries) {
      assert.ok(entry.id.length > 0, "id readable");
      assert.ok(entry.js.length > 0, "js readable");
      assert.ok(entry.signature.length > 0, "signature readable");
    }
  });

  it("resolves every implemented factory to a callable and reads appearance/slot metadata", () => {
    const record = ui as unknown as Record<string, unknown>;
    const implemented = UI_CATALOG.entries.filter(
      (entry) => entry.availability === "implemented",
    );
    assert.equal(implemented.length, 88, "the whole surface resolves, none planned");
    for (const entry of implemented) {
      const target = record[entry.js];
      assert.equal(typeof target, "function", `${entry.js} resolves to a callable export`);
    }

    const byId = new Map(UI_CATALOG.entries.map((entry) => [entry.id, entry]));
    const badge = byId.get("badge");
    assert.ok(badge?.appearance?.tone?.includes("error"), "badge tone metadata readable");
    assert.ok(badge?.appearance?.size?.includes("xl"), "badge size metadata readable");
    const button = byId.get("button");
    assert.equal(button?.profile, "bound-control");
    assert.ok(button?.appearance?.variant?.includes("ghost"), "button variant metadata readable");
    const modal = byId.get("modal");
    assert.deepStrictEqual(
      modal?.slots?.map((slot) => slot.name),
      ["content", "trigger", "actions"],
      "modal slot schema readable",
    );
    assert.equal(modal?.slots?.find((slot) => slot.name === "content")?.required, true);
    assert.equal(modal?.slots?.find((slot) => slot.name === "trigger")?.required, false);
    const carousel = byId.get("carousel");
    assert.deepStrictEqual(
      carousel?.slots?.map((slot) => slot.name),
      ["item"],
      "collection item-slot schema readable",
    );
    assert.equal(carousel?.slots?.find((slot) => slot.name === "item")?.repeatable, true);
  });
});
