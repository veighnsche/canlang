import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
// Compiled tests run from dist/test; sources sit beside dist.
const packageRoot = join(here, "..", "..");
const srcDir = join(packageRoot, "src");
const themesCss = readFileSync(join(packageRoot, "themes.css"), "utf8");
// Resolve through node_modules instead of assuming a hoisted root layout
// (bun nests workspace deps under packages/ui/node_modules).
const pkgRequire = createRequire(import.meta.url);
const daisyRoot = dirname(pkgRequire.resolve("daisyui/package.json"));
const daisyCss = readFileSync(join(daisyRoot, "daisyui.css"), "utf8");
const sourceCss = readFileSync(join(srcDir, "browser", "style.css"), "utf8");

const THEME_NAMES = [
  "can-light-blue",
  "can-light-green",
  "can-light-purple",
  "can-dark-blue",
  "can-dark-green",
  "can-dark-purple",
  "can-system-blue",
  "can-system-green",
  "can-system-purple",
];

/** Structural `can-*` markup hooks owned by this package (reviewed). */
const CAN_HOOKS = new Set([
  "can-page-heading",
  "can-card-heading",
  "can-card-footer",
  "can-row-actions",
  "can-row-content",
  "can-panel-heading",
  "can-heading-actions",
  "can-primary-actions",
  "can-action-menu",
  "can-action-menu-trigger",
  "can-action-menu-popover",
  "can-page-heading-row",
  "can-menu-dialog",
  "can-action-entry",
  "can-form",
  "can-search",
  "can-preference-tabs",
  "can-account",
  "can-account-toggle",
  "can-account-avatar",
  "can-account-label",
  "can-account-icon",
  "can-sidebar",
  "can-drawer-panel",
  "can-brand",
  "can-delivery",
  "can-gallery-grid",
  "can-more",
  "can-region",
  "can-settings-panel",
  "can-settings-sidebar",
]);

function extractClassTokens(): Set<string> {
  const tokens = new Set<string>();
  for (const file of [...readdirSync(srcDir), "internal/menu-dialog.ts"]) {
    if (!file.endsWith(".ts")) {
      continue;
    }
    const source = readFileSync(join(srcDir, file), "utf8");
    for (const match of source.matchAll(/class="([^"]*)"/g)) {
      const group = match[1] as string;
      for (const token of group.split(/\s+/)) {
        // Dynamic interpolations resolve at runtime; their value maps are
        // covered below (TITLE_CLASSES) or contract-pinned (density-*).
        if (token !== "" && !token.includes("$")) {
          tokens.add(token);
        }
      }
    }
    // Class-list constants consumed through interpolation.
    for (const match of source.matchAll(/TITLE_CLASSES\s*=\s*\{([^}]*)\}/g)) {
      const body = match[1] as string;
      for (const literal of body.matchAll(/"([^"]*)"/g)) {
        const group = literal[1] as string;
        for (const token of group.split(/\s+/)) {
          if (token !== "") {
            tokens.add(token);
          }
        }
      }
    }
  }
  return tokens;
}

describe("themes.css", () => {
  it("defines all nine pinned data themes with system overrides", () => {
    for (const name of THEME_NAMES) {
      assert.ok(
        themesCss.includes(`[data-theme="${name}"]`),
        `themes.css lacks ${name}`,
      );
    }
    for (const accent of ["blue", "green", "purple"]) {
      assert.ok(
        themesCss.includes("@media (prefers-color-scheme: dark)") &&
          themesCss.includes(`[data-theme="can-system-${accent}"]`),
        `system theme can-system-${accent} lacks a dark override`,
      );
    }
    assert.ok(themesCss.includes(".density-compact .card-body"));
  });

  it("uses only variable names from the installed daisyUI themes", () => {
    const allowed = new Set<string>();
    for (const base of ["light", "dark"]) {
      const css = readFileSync(join(daisyRoot, "theme", `${base}.css`), "utf8");
      for (const match of css.matchAll(/--[a-z][a-z0-9-]*/g)) {
        allowed.add(match[0]);
      }
    }
    const stripped = themesCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const used = new Set<string>();
    for (const match of stripped.matchAll(/--[a-z][a-z0-9-]*/g)) {
      used.add(match[0]);
    }
    assert.ok(used.size > 0);
    for (const name of used) {
      assert.ok(allowed.has(name), `themes.css uses unknown variable ${name}`);
    }
  });

  it("defines the complete variable set in every theme block", () => {
    const expected = new Set<string>();
    const stock = readFileSync(join(daisyRoot, "theme", "light.css"), "utf8");
    for (const match of stock.matchAll(/--[a-z][a-z0-9-]*/g)) {
      expected.add(match[0]);
    }
    for (const name of THEME_NAMES) {
      const open = themesCss.indexOf(`[data-theme="${name}"]`);
      assert.ok(open !== -1, `themes.css lacks ${name}`);
      const close = themesCss.indexOf("}", open);
      const block = themesCss.slice(open, close);
      for (const variable of expected) {
        assert.ok(
          block.includes(variable),
          `theme ${name} drops ${variable}`,
        );
      }
    }
  });

  it("covers every stock light/dark difference in the system overrides", () => {
    const varsOf = (base: string): Map<string, string> => {
      const css = readFileSync(join(daisyRoot, "theme", `${base}.css`), "utf8");
      const map = new Map<string, string>();
      for (const match of css.matchAll(/(--[a-z][a-z0-9-]*)\s*:\s*([^;]*);/g)) {
        map.set(match[1] as string, (match[2] as string).trim());
      }
      return map;
    };
    const light = varsOf("light");
    const dark = varsOf("dark");
    const differing: string[] = [];
    for (const [name, value] of light) {
      if (dark.get(name) !== value) {
        differing.push(name);
      }
    }
    assert.ok(differing.length > 0);
    for (const accent of ["blue", "green", "purple"]) {
      const marker = `[data-theme="can-system-${accent}"]`;
      // The dark override is the second block with this selector (in @media).
      const first = themesCss.indexOf(marker);
      const second = themesCss.indexOf(marker, first + marker.length);
      assert.ok(second !== -1, `system theme ${accent} lacks a dark override block`);
      const close = themesCss.indexOf("}", second);
      const block = themesCss.slice(second, close);
      for (const name of differing) {
        assert.ok(block.includes(name), `system ${accent} override drops ${name}`);
      }
    }
  });


});

describe("class audit", () => {
  it("stacks complete sibling card/view owners instead of Daisy's shared grid row", () => {
    const listCss = readFileSync(join(daisyRoot, "components", "list.css"), "utf8");
    assert.ok(listCss.includes('.list .list-row>*{grid-row-start:1}'));
    assert.match(sourceCss, /\.list \.list-row:has\(> \.card, > \[data-can-view\]\)\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/);
  });

  it("supplies CSS for emitted classes including their responsive prefixes", () => {
    const unknown: string[] = [];
    for (const token of extractClassTokens()) {
      if (token.startsWith("can-")) {
        if (!CAN_HOOKS.has(token)) {
          unknown.push(token);
        }
      }
      const selector = "." + token.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
      const found = [daisyCss, themesCss, sourceCss].some(css => css.includes(selector));
      if (!found) {
        unknown.push(token);
      }
    }
    assert.deepEqual(unknown, []);
  });
});
