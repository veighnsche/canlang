import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { UI_CATALOG } from "../src/catalog.js";
import { appearanceClasses } from "../src/appearance.js";

const here = dirname(fileURLToPath(import.meta.url));
// Compiled tests run from dist/test; sources sit beside dist.
const packageRoot = join(here, "..", "..");
// Resolve through node_modules instead of assuming a hoisted root layout
// (bun nests workspace deps under packages/ui/node_modules).
const pkgRequire = createRequire(import.meta.url);
const daisyRoot = dirname(pkgRequire.resolve("daisyui/package.json"));

const DAISY_PIN = "5.7.47";

/**
 * Word → upstream CSS evidence mapping. `css` names the pinned per-component
 * file(s) relative to the daisyUI root; `base` is the word's base class
 * (null when upstream ships no base class for the word). Per-dimension bases
 * default to `base`; the overrides record where upstream hangs a dimension
 * on a different class (tones on the chat-bubble and step families, sizes on the tabs
 * container, orientation on the stats container). `omit` documents why a
 * word admits no appearance at all; absent appearance admits nothing.
 *
 * Admission rules (fail closed):
 * - tone=X needs .<toneBase>-<x>; neutral is admitted only when
 *   .<toneBase>-neutral exists upstream, never by analogy.
 * - size=X needs .<sizeBase>-<x>.
 * - solid needs the base class itself; outline/soft/ghost need
 *   .<base>-outline/-soft/-ghost. solid rides only on words that admit
 *   something else: it never solely justifies an appearance block, so
 *   base-class-only words without a design caption stay omitted.
 * - orientation needs .<orientBase>-horizontal/-vertical; each direction is
 *   admitted only with its own class (range/megamenu are vertical-only).
 * - caption admits caption=expr per the design profile table, not per CSS.
 */
interface WordMapping {
  readonly css: ReadonlyArray<string>;
  readonly base: string | null;
  readonly toneBase?: string;
  readonly sizeBase?: string;
  readonly orientBase?: string;
  readonly omit?: string;
}

const MAPPING: Record<string, WordMapping> = {
  accordion: { css: [], base: null, omit: "no upstream component CSS in 5.7.47; accordion is built from collapse" },
  alert: { css: ["components/alert.css"], base: "alert" },
  aura: { css: ["components/aura.css"], base: "aura" },
  avatar: { css: ["components/avatar.css"], base: "avatar" },
  badge: { css: ["components/badge.css"], base: "badge" },
  breadcrumbs: { css: ["components/breadcrumbs.css"], base: "breadcrumbs", omit: "base class only upstream; design admits no caption" },
  button: { css: ["components/button.css"], base: "btn" },
  calendar: { css: ["components/calendar.css"], base: null, omit: "adapter-only CSS (cally/pika/rdp/vc); no .calendar base" },
  card: { css: ["components/card.css"], base: "card" },
  carousel: { css: ["components/carousel.css"], base: "carousel" },
  chat_bubble: { css: ["components/chat.css"], base: "chat", toneBase: "chat-bubble" },
  checkbox: { css: ["components/checkbox.css"], base: "checkbox" },
  collapse: { css: ["components/collapse.css"], base: "collapse" },
  countdown: { css: ["components/countdown.css"], base: "countdown" },
  diff: { css: ["components/diff.css"], base: "diff", omit: "no tone/size/variant/orientation scale; design admits no caption" },
  divider: { css: ["components/divider.css"], base: "divider" },
  dock: { css: ["components/dock.css"], base: "dock" },
  drawer: { css: ["components/drawer.css"], base: "drawer" },
  dropdown: { css: ["components/dropdown.css"], base: "dropdown", omit: "placement classes only; no admittable dimension" },
  fab: { css: ["components/fab.css"], base: "fab", omit: "no tone/size/variant/orientation scale" },
  fieldset: { css: ["components/fieldset.css"], base: "fieldset" },
  file_input: { css: ["components/fileinput.css"], base: "file-input" },
  filter: { css: ["components/filter.css"], base: "filter", omit: "no tone/size/variant scale" },
  footer: { css: ["components/footer.css"], base: "footer" },
  hero: { css: ["components/hero.css"], base: "hero" },
  hover_3d: { css: ["components/hover3d.css"], base: "hover-3d", omit: "decorative wrapper; no admittable dimension" },
  hover_gallery: { css: ["components/hovergallery.css"], base: "hover-gallery", omit: "no admittable dimension" },
  indicator: { css: ["components/indicator.css"], base: "indicator", omit: "placement classes only; no admittable dimension" },
  input: { css: ["components/input.css"], base: "input" },
  join: { css: ["utilities/join.css"], base: "join" },
  kbd: { css: ["components/kbd.css"], base: "kbd" },
  label: { css: ["components/label.css"], base: "label" },
  link: { css: ["components/link.css"], base: "link" },
  list: { css: ["components/list.css"], base: "list", omit: "no modifier scale upstream" },
  loading: { css: ["components/loading.css"], base: "loading" },
  mask: { css: ["components/mask.css"], base: "mask", omit: "upstream shapes (mask-circle, ...) are not tone/size tokens" },
  megamenu: { css: ["components/megamenu.css"], base: "megamenu" },
  menu: { css: ["components/menu.css"], base: "menu" },
  mockup_browser: { css: ["components/mockup.css"], base: "mockup-browser", omit: "presentation wrapper; no modifiers" },
  mockup_code: { css: ["components/mockup.css"], base: "mockup-code", omit: "escaped-text leaf; no modifiers" },
  mockup_phone: { css: ["components/mockup.css"], base: "mockup-phone", omit: "presentation wrapper; no modifiers" },
  mockup_window: { css: ["components/mockup.css"], base: "mockup-window", omit: "presentation wrapper; no modifiers" },
  modal: { css: ["components/modal.css"], base: "modal" },
  navbar: { css: ["components/navbar.css"], base: "navbar" },
  otp: { css: ["components/otp.css"], base: "otp" },
  pagination: { css: [], base: null, omit: "no upstream component CSS in 5.7.47; built from join+button" },
  progress: { css: ["components/progress.css"], base: "progress" },
  radial_progress: { css: ["components/radialprogress.css"], base: "radial-progress" },
  radio: { css: ["components/radio.css"], base: "radio" },
  range: { css: ["components/range.css"], base: "range" },
  rating: { css: ["components/rating.css"], base: "rating" },
  select: { css: ["components/select.css"], base: "select" },
  skeleton: { css: ["components/skeleton.css"], base: "skeleton", omit: "base class only upstream (unlike loading, no size scale)" },
  stack: { css: ["components/stack.css"], base: "stack", omit: "placement classes only; no admittable dimension" },
  stat: { css: ["components/stat.css"], base: "stats" },
  status: { css: ["components/status.css"], base: "status" },
  steps: { css: ["components/steps.css"], base: "steps", toneBase: "step" },
  swap: { css: ["components/swap.css"], base: "swap", omit: "no tone/size/variant/orientation scale" },
  tabs: { css: ["components/tab.css"], base: "tabs" },
  table: { css: ["components/table.css"], base: "table" },
  text_rotate: { css: ["components/textrotate.css"], base: "text-rotate", omit: "base class only upstream" },
  textarea: { css: ["components/textarea.css"], base: "textarea" },
  theme_controller: { css: [], base: null, omit: "behavior hook only (input.theme-controller); no component CSS" },
  timeline: { css: ["components/timeline.css"], base: "timeline" },
  toast: { css: ["components/toast.css"], base: "toast", omit: "placement classes only; no admittable dimension" },
  toggle: { css: ["components/toggle.css"], base: "toggle" },
  tooltip: { css: ["components/tooltip.css"], base: "tooltip" },
  validator: { css: ["components/validator.css"], base: "validator", omit: "outlet marker only; no admittable dimension" },
};

const WORD_IDS = Object.keys(MAPPING);

const INFRA_IDS = [
  "page-shell", "navigation", "title", "text", "content", "state", "form",
  "edit", "delete", "action", "actions", "settings", "export", "print",
  "history", "copy", "board", "review", "csv-import", "file",
];

/** caption=expr per the design profile table (optional/required caption rows). */
const CAPTION_WORDS = [
  "avatar", "badge", "button", "card", "collapse", "countdown", "divider",
  "dock", "drawer", "fieldset", "footer", "hero", "label", "link",
  "megamenu", "menu", "modal", "navbar", "progress", "radial_progress",
  "status", "tooltip",
];

function classPresent(css: string, cls: string): boolean {
  return new RegExp(`\\.${cls}(?![a-zA-Z0-9_-])`).test(css);
}

function cssFor(mapping: WordMapping): string {
  return mapping.css
    .map((file) => readFileSync(join(daisyRoot, file), "utf8"))
    .join("\n");
}

describe("appearance pin", () => {
  it("pins daisyUI 5.7.47 exactly", () => {
    const manifest = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as { devDependencies: Record<string, string> };
    const pinned = manifest.devDependencies["daisyui"];
    assert.equal(pinned, DAISY_PIN);
    const installed = JSON.parse(
      readFileSync(join(daisyRoot, "package.json"), "utf8"),
    ) as { version: string };
    assert.equal(installed.version, DAISY_PIN);
  });
});

describe("appearance mapping", () => {
  it("covers all 68 words and no infrastructure", () => {
    assert.equal(WORD_IDS.length, 68);
    assert.equal(new Set(WORD_IDS).size, 68);
    const catalogIds = new Set(UI_CATALOG.entries.map((entry) => entry.id));
    for (const id of WORD_IDS) {
      assert.ok(catalogIds.has(id), `mapping covers unknown id ${id}`);
    }
    for (const id of INFRA_IDS) {
      assert.ok(!(id in MAPPING), `mapping covers infrastructure ${id}`);
    }
  });

  it("names only CSS files that exist upstream", () => {
    for (const [id, mapping] of Object.entries(MAPPING)) {
      for (const file of mapping.css) {
        assert.ok(
          readFileSync(join(daisyRoot, file), "utf8").length > 0,
          `${id} names missing CSS ${file}`,
        );
      }
    }
  });
});

describe("appearance substantiation", () => {
  it("grounds every admitted token in the pinned component CSS", () => {
    const byId = new Map(UI_CATALOG.entries.map((entry) => [entry.id, entry]));
    let substantiated = 0;
    for (const [id, mapping] of Object.entries(MAPPING)) {
      const entry = byId.get(id);
      assert.ok(entry !== undefined, `catalog is missing word ${id}`);
      const appearance = entry.appearance;
      if (appearance === undefined) {
        continue;
      }
      assert.ok(mapping.base !== null, `${id} admits appearance without a base class`);
      assert.ok(mapping.css.length > 0, `${id} admits appearance without CSS evidence`);
      const css = cssFor(mapping);
      const base = mapping.base as string;
      const toneBase = mapping.toneBase ?? base;
      const sizeBase = mapping.sizeBase ?? base;
      const orientBase = mapping.orientBase ?? base;
      for (const tone of appearance.tone ?? []) {
        assert.ok(
          classPresent(css, `${toneBase}-${tone}`),
          `${id} admits tone=${tone} without .${toneBase}-${tone} upstream`,
        );
        substantiated += 1;
      }
      for (const size of appearance.size ?? []) {
        assert.ok(
          classPresent(css, `${sizeBase}-${size}`),
          `${id} admits size=${size} without .${sizeBase}-${size} upstream`,
        );
        substantiated += 1;
      }
      for (const variant of appearance.variant ?? []) {
        const cls = variant === "solid" ? base : `${base}-${variant}`;
        assert.ok(
          classPresent(css, cls),
          `${id} admits variant=${variant} without .${cls} upstream`,
        );
        substantiated += 1;
      }
      for (const orientation of appearance.orientation ?? []) {
        assert.ok(
          classPresent(css, `${orientBase}-${orientation}`),
          `${id} admits orientation=${orientation} without .${orientBase}-${orientation} upstream`,
        );
        substantiated += 1;
      }
    }
    assert.ok(substantiated > 0, "no appearance tokens substantiated");
  });

  it("never justifies an appearance block by solid alone", () => {
    for (const entry of UI_CATALOG.entries) {
      const appearance = entry.appearance;
      if (appearance === undefined) {
        continue;
      }
      const variants = appearance.variant ?? [];
      const solidOnly =
        variants.length === 1 &&
        variants[0] === "solid" &&
        (appearance.tone ?? []).length === 0 &&
        (appearance.size ?? []).length === 0 &&
        (appearance.orientation ?? []).length === 0 &&
        appearance.caption !== true;
      assert.ok(!solidOnly, `${entry.id} admits appearance for solid alone`);
    }
  });

  it("admits caption exactly on the design-table caption words", () => {
    const captioned = UI_CATALOG.entries
      .filter((entry) => entry.appearance?.caption === true)
      .map((entry) => entry.id)
      .sort();
    assert.deepEqual(captioned, [...CAPTION_WORDS].sort());
  });

  it("admits nothing on infrastructure entries", () => {
    const byId = new Map(UI_CATALOG.entries.map((entry) => [entry.id, entry]));
    assert.equal(INFRA_IDS.length, 20);
    for (const id of INFRA_IDS) {
      const entry = byId.get(id);
      assert.ok(entry !== undefined, `catalog is missing infrastructure ${id}`);
      assert.equal(entry.appearance, undefined, `${id} admits appearance`);
      assert.equal(entry.alternates, undefined, `${id} admits alternates`);
    }
  });

  it("admits nothing on words whose upstream CSS carries no admittable token", () => {
    const byId = new Map(UI_CATALOG.entries.map((entry) => [entry.id, entry]));
    const omitted = Object.entries(MAPPING).filter(([, mapping]) => mapping.omit !== undefined);
    assert.equal(omitted.length, 24);
    for (const [id, mapping] of omitted) {
      assert.ok((mapping.omit as string).length > 0, `${id} omits appearance without a reason`);
      assert.equal(byId.get(id)?.appearance, undefined, `${id} admits appearance despite: ${mapping.omit}`);
    }
    const present = UI_CATALOG.entries.filter((entry) => entry.appearance !== undefined);
    assert.equal(present.length, 44);
  });

  it("keeps the surprising upstream gaps closed", () => {
    const byId = new Map(UI_CATALOG.entries.map((entry) => [entry.id, entry]));
    // tooltip ships every tone except neutral, and no size scale.
    assert.deepEqual(byId.get("tooltip")?.appearance?.tone, [
      "primary", "secondary", "accent", "info", "success", "warning", "error",
    ]);
    assert.equal(byId.get("tooltip")?.appearance?.size, undefined);
    // alert ships only feedback tones and no sizes.
    assert.deepEqual(byId.get("alert")?.appearance?.tone, ["info", "success", "warning", "error"]);
    assert.equal(byId.get("alert")?.appearance?.size, undefined);
    // radial_progress is a bare base class; progress beside it has full tones.
    assert.equal(byId.get("radial_progress")?.appearance?.tone, undefined);
    assert.equal(byId.get("radial_progress")?.appearance?.size, undefined);
    assert.equal(byId.get("progress")?.appearance?.tone?.length, 8);
    // ghost exists only on the text-entry family (file_input/input/select/textarea).
    for (const id of ["file_input", "input", "select", "textarea"]) {
      assert.deepEqual(byId.get(id)?.appearance?.variant, ["solid", "ghost"]);
    }
    // range and megamenu ship only the vertical direction.
    assert.deepEqual(byId.get("range")?.appearance?.orientation, ["vertical"]);
    assert.deepEqual(byId.get("megamenu")?.appearance?.orientation, ["vertical"]);
  });

  it("admits alternates only on hero, footer and navbar", () => {
    const byId = new Map(UI_CATALOG.entries.map((entry) => [entry.id, entry]));
    assert.deepEqual(byId.get("hero")?.alternates, ["group"]);
    assert.deepEqual(byId.get("footer")?.alternates, ["group"]);
    assert.deepEqual(byId.get("navbar")?.alternates, ["leaf"]);
    for (const entry of UI_CATALOG.entries) {
      if (entry.id === "hero" || entry.id === "footer" || entry.id === "navbar") {
        continue;
      }
      assert.equal(entry.alternates, undefined, `${entry.id} admits alternates`);
    }
  });
});

describe("appearanceClasses", () => {
  it("maps admitted tokens to base modifiers and emits nothing for solid", () => {
    assert.equal(
      appearanceClasses("badge", "badge", { tone: "primary", size: "lg", variant: "outline" }),
      "badge-primary badge-lg badge-outline",
    );
    assert.equal(appearanceClasses("badge", "badge", { variant: "solid" }), "");
    assert.equal(appearanceClasses("badge", "badge", {}), "");
  });

  it("maps orientation to directional classes", () => {
    assert.equal(
      appearanceClasses("divider", "divider", { orientation: "vertical" }),
      "divider-vertical",
    );
  });

  it("throws on unadmitted tokens, unknown words and matrix-less words", () => {
    assert.throws(
      () => appearanceClasses("badge", "badge", { tone: "primary", size: "lg", orientation: "vertical" }),
      /does not admit orientation/,
    );
    assert.throws(() => appearanceClasses("nope", "nope", {}), /unknown catalog word/);
    assert.throws(
      () => appearanceClasses("skeleton", "skeleton", { size: "lg" }),
      /admits no appearance/,
    );
    assert.equal(appearanceClasses("skeleton", "skeleton", {}), "");
  });
});
