import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  PresentationContext,
  SettingsBaseControls,
} from "../../contracts/src/presentation.js";
import { message } from "../src/messages.js";
import { renderSettingsPanel } from "../src/settings.js";
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

function withExtra<T extends object>(props: T, extra: Record<string, unknown>): T {
  return { ...props, ...extra };
}

function makeBase(overrides: Partial<SettingsBaseControls> = {}): SettingsBaseControls {
  return {
    caption: "Appearance",
    postTo: "/settings/appearance",
    themeLabel: "Theme",
    themes: [
      { value: "can-light-blue", label: "Light blue" },
      { value: "can-dark-blue", label: "Dark blue" },
    ],
    currentTheme: "can-dark-blue",
    densityLabel: "Density",
    currentDensity: "compact",
    ...overrides,
  };
}

describe("renderSettingsPanel", () => {
  it("renders the base panel via themeController plus density controls", async () => {
    const html = await renderSettingsPanel({
      context: makeContext(),
      sectionId: "base",
      base: makeBase(),
    });
    assert.ok(html.includes("<section><h3>Appearance</h3>"), html);
    // Theme control reuses the shared Appearance path with caller postTo.
    assert.ok(html.includes(`action="/settings/appearance"`), html);
    assert.ok(html.includes("theme-controller"), html);
    assert.ok(html.includes('value="can-dark-blue" checked'), html);
    assert.ok(html.includes("Light blue"), html);
    // Finite density pair over the contract union, same caller path.
    assert.ok(html.includes('name="density" value="comfortable"'), html);
    assert.ok(html.includes('name="density" value="compact" checked'), html);
    assert.ok(html.includes(">Density</legend>"), html);
    assert.ok(html.includes(`name="_csrf" value="csrf-123"`), html);
  });

  it("leaves density unchecked when the current value is unknown", async () => {
    const html = await renderSettingsPanel({
      context: makeContext(),
      sectionId: "base",
      base: withExtra(makeBase(), { currentDensity: undefined }),
    });
    assert.ok(html.includes('name="density" value="comfortable"'), html);
    assert.ok(!html.includes('name="density" value="comfortable" checked'), html);
    assert.ok(!html.includes('name="density" value="compact" checked'), html);
  });

  it("renders a preference panel through its self-only save/reset/version path", async () => {
    const html = await renderSettingsPanel({
      context: makeContext(),
      sectionId: "notifications",
      preferences: [
        {
          id: "notifications",
          caption: "Notifications",
          saveTo: "/prefs/notifications/save",
          resetTo: "/prefs/notifications/reset",
          version: "7",
          controls: [`<label>Level<input name="level" value="all"></label>`],
        },
      ],
    });
    assert.ok(html.includes("<section><h3>Notifications</h3>"), html);
    assert.ok(html.includes(`action="/prefs/notifications/save"`), html);
    assert.ok(html.includes(`action="/prefs/notifications/reset"`), html);
    assert.ok(html.includes(`name="version" value="7"`), html);
    assert.ok(html.includes("Version: 7"), html);
    assert.ok(html.includes(`name="level"`), html);
    assert.ok(html.includes(`type="submit" class="btn btn-primary">Save</button>`), html);
    assert.ok(html.includes(`type="submit" class="btn btn-ghost">Reset</button>`), html);
  });

  it("renders omitted controls completely instead of failing", async () => {
    const html = await renderSettingsPanel({
      context: makeContext(),
      sectionId: "notifications",
      preferences: [
        { id: "notifications", caption: "Notifications", saveTo: "/prefs/notifications/save" },
      ],
    });
    assert.ok(html.includes("<section><h3>Notifications</h3>"), html);
    assert.ok(html.includes(`action="/prefs/notifications/save"`), html);
    assert.ok(!html.includes("reset"), html);
    assert.ok(!html.includes("Version:"), html);
  });

  it("honours a custom base id", async () => {
    const html = await renderSettingsPanel({
      context: makeContext(),
      sectionId: "appearance",
      baseId: "appearance",
      base: makeBase(),
    });
    assert.ok(html.includes("<h3>Appearance</h3>"), html);
  });

  it("rejects missing POST targets and unknown sections", async () => {
    await assert.rejects(
      renderSettingsPanel({ context: makeContext(), sectionId: "base", base: makeBase({ postTo: "  " }) }),
      /non-empty postTo/,
    );
    await assert.rejects(
      renderSettingsPanel({
        context: makeContext(),
        sectionId: "n",
        preferences: [{ id: "n", caption: "N", saveTo: "" }],
      }),
      /non-empty saveTo/,
    );
    await assert.rejects(
      renderSettingsPanel({
        context: makeContext(),
        sectionId: "n",
        preferences: [{ id: "n", caption: "N", saveTo: "/s", resetTo: "" }],
      }),
      /non-empty resetTo/,
    );
    await assert.rejects(
      renderSettingsPanel({ context: makeContext(), sectionId: "nope", preferences: [] }),
      /unknown section "nope"/,
    );
    await assert.rejects(
      renderSettingsPanel({ context: makeContext(), sectionId: "base" }),
      /needs base controls/,
    );
    await assert.rejects(
      renderSettingsPanel({ context: makeContext(), sectionId: "", base: makeBase() }),
      /non-empty sectionId/,
    );
  });

  it("rejects empty captions, bad density and empty provided suites", async () => {
    await assert.rejects(
      renderSettingsPanel({ context: makeContext(), sectionId: "base", base: makeBase({ caption: "" }) }),
      /base caption must not be empty/,
    );
    await assert.rejects(
      renderSettingsPanel({
        context: makeContext(),
        sectionId: "base",
        base: makeBase({ currentDensity: "airy" as never }),
      }),
      /unknown density/,
    );
    await assert.rejects(
      renderSettingsPanel({
        context: makeContext(),
        sectionId: "n",
        preferences: [{ id: "n", caption: "", saveTo: "/s" }],
      }),
      /caption must not be empty/,
    );
    await assert.rejects(
      renderSettingsPanel({
        context: makeContext(),
        sectionId: "n",
        preferences: [{ id: "n", caption: "N", saveTo: "/s", controls: [] }],
      }),
      /nonempty controls suite/,
    );
    await assert.rejects(
      renderSettingsPanel(
        withExtra({ context: makeContext(), sectionId: "base", base: makeBase() }, { size: "lg" }),
      ),
      /admits no appearance/,
    );
  });

  it("propagates themeController validation instead of guessing", async () => {
    await assert.rejects(
      renderSettingsPanel({
        context: makeContext(),
        sectionId: "base",
        base: makeBase({ themes: [] }),
      }),
      /nonempty themes suite/,
    );
    await assert.rejects(
      renderSettingsPanel({
        context: makeContext(),
        sectionId: "base",
        base: makeBase({ currentTheme: "neon" }),
      }),
      /not a listed theme/,
    );
  });

  it("resolves captions in locale order", async () => {
    const html = await renderSettingsPanel({
      context: makeContext({ preferredLocales: ["nl"] }),
      sectionId: "n",
      preferences: [
        {
          id: "n",
          caption: message("Notifications", { nl: "Meldingen" }),
          saveTo: "/s",
          resetTo: "/r",
          version: "7",
        },
      ],
    });
    assert.ok(html.includes("<h3>Meldingen</h3>"), html);
    assert.ok(html.includes(">Opslaan</button>"), html);
    assert.ok(html.includes(">Opnieuw instellen</button>"), html);
    assert.ok(html.includes("Versie: 7"), html);
  });

  it("escapes hostile captions, versions and targets", async () => {
    const html = await renderSettingsPanel({
      context: makeContext(),
      sectionId: "n",
      preferences: [{ id: "n", caption: XSS, saveTo: "/s", version: XSS }],
    });
    assert.ok(!html.includes("<script>"), html);
    assert.ok(html.includes("&lt;script&gt;"), html);
    const hostile = await renderSettingsPanel({
      context: makeContext(),
      sectionId: "n",
      preferences: [{ id: "n", caption: "N", saveTo: "javascript:alert(1)" }],
    });
    assert.ok(hostile.includes(`action="#"`), hostile);
    assert.ok(!hostile.includes("javascript:"), hostile);
  });

  it("exposes panel forms in the DOM", async () => {
    const html = await renderSettingsPanel({
      context: makeContext(),
      sectionId: "n",
      preferences: [
        {
          id: "n",
          caption: "Notifications",
          saveTo: "/prefs/n/save",
          resetTo: "/prefs/n/reset",
          version: "7",
          controls: [`<input name="level" value="all">`],
        },
      ],
    });
    const page = await loadHtml(html);
    try {
      const forms = page.document.querySelectorAll("section > form");
      assert.equal(forms.length, 2);
      const saveForm = forms[0];
      const resetForm = forms[1];
      assert.ok(saveForm, "save form present");
      assert.ok(resetForm, "reset form present");
      assert.equal(saveForm.getAttribute("action"), "/prefs/n/save");
      assert.equal(resetForm.getAttribute("action"), "/prefs/n/reset");
      const version = saveForm.querySelector('input[name="version"]');
      assert.ok(version, "version hidden field present");
      assert.equal(version.getAttribute("value"), "7");
      const control = saveForm.querySelector('input[name="level"]');
      assert.ok(control, "controls render inside the save form");
      assert.equal(page.document.querySelector("section > h3")?.textContent, "Notifications");
    } finally {
      await page.close();
    }
  });

  it("exposes the base panel density choice in the DOM", async () => {
    const html = await renderSettingsPanel({
      context: makeContext(),
      sectionId: "base",
      base: makeBase(),
    });
    const page = await loadHtml(html);
    try {
      const checked = page.document.querySelector('input[name="density"]:checked') as unknown as {
        value: string;
      } | null;
      assert.ok(checked, "a density is checked");
      assert.equal(checked.value, "compact");
      const theme = page.document.querySelector('input[name="theme"]:checked') as unknown as {
        value: string;
      } | null;
      assert.ok(theme, "a theme is checked");
      assert.equal(theme.value, "can-dark-blue");
    } finally {
      await page.close();
    }
  });
});
