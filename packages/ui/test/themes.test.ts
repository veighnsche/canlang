import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Compiled tests run from dist/ui/test; sources sit beside dist.
const packageRoot = join(here, "..", "..", "..");
const srcDir = join(packageRoot, "src");
const themesCss = readFileSync(join(packageRoot, "themes.css"), "utf8");
const daisyRoot = join(packageRoot, "..", "..", "node_modules", "daisyui");
const daisyCss = readFileSync(join(daisyRoot, "daisyui.css"), "utf8");

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
  "can-account",
  "can-brand",
  "can-more",
  "can-settings-panel",
  "can-settings-sidebar",
]);

/**
 * Tailwind utility tokens used in src markup, reviewed by hand. Anything used
 * in src that is neither can-* structural, nor in daisyUI's CSS, nor listed
 * here fails the audit (likely a typo or an unreviewed dependency).
 */
const TAILWIND_UTILS = new Set([
  "absolute",
  "flex",
  "flex-1",
  "flex-col",
  "font-bold",
  "gap-4",
  "grid",
  "grid-cols-2",
  "h-4",
  "hidden",
  "min-h-full",
  "overflow-y-auto",
  "p-2",
  "p-4",
  "px-4",
  "py-3",
  "right-2",
  "shadow",
  "sr-only",
  "text-2xl",
  "text-3xl",
  "text-lg",
  "text-xl",
  "top-2",
  "w-64",
  "w-80",
  "w-full",
]);

function extractClassTokens(): Set<string> {
  const tokens = new Set<string>();
  for (const file of readdirSync(srcDir)) {
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

  it("pins the audited daisyUI version", () => {
    const manifest = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as { devDependencies: Record<string, string> };
    const pinned = manifest.devDependencies["daisyui"];
    assert.ok(pinned !== undefined && !pinned.startsWith("^") && !pinned.startsWith("~"));
    const installed = JSON.parse(
      readFileSync(join(daisyRoot, "package.json"), "utf8"),
    ) as { version: string };
    assert.equal(installed.version, pinned);
  });
});

describe("class audit", () => {
  it("resolves every markup class to daisyUI, tailwind-utils or can-* hooks", () => {
    const unknown: string[] = [];
    for (const token of extractClassTokens()) {
      if (token.startsWith("can-")) {
        if (!CAN_HOOKS.has(token)) {
          unknown.push(token);
        }
        continue;
      }
      const base = token.includes(":") ? (token.split(":").pop() as string) : token;
      const escaped = base.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
      const found = new RegExp(`\\.${escaped}(?![a-zA-Z0-9_-])`).test(daisyCss);
      if (!found && !TAILWIND_UTILS.has(base)) {
        unknown.push(token);
      }
    }
    assert.deepEqual(unknown, []);
  });
});
