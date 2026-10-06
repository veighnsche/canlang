#!/usr/bin/env node
/**
 * FP.BROWSER browser-asset build: installs the real CSS/client path.
 *
 * Reads (pinned, verified): daisyUI `daisyui.css`, `ui/themes.css`,
 * `ui/src/browser/style.css`, and the tsc-compiled browser client
 * (`dist/src/browser/*.js`). Writes `dist/browser/`:
 *
 * - `bootstrap.js`, `polling.js` — installed client modules, copied
 *   verbatim; the page loads `bootstrap.js` as a module.
 * - `can-style.css` — assembled stylesheet: daisyUI + themes +
 *   browser source layer, in that order (source layer wins ties).
 * - `manifest.json` — installed files with sha256, pinned daisyUI +
 *   catalog versions, and the binder ids this client registers.
 *
 * Build joins (fail closed):
 *
 * - daisyUI version MUST equal the pinned version (bump
 *   deliberately, never blindly — see themes.css header).
 * - Installed client modules MUST NOT import outside the browser
 *   directory: every `from` specifier must be a `./` sibling that
 *   resolves inside `dist/browser/`. A new runtime import beyond
 *   the browser dir fails the build — bundle it or keep the client
 *   import-free (type-only imports are erased by tsc and never
 *   appear here).
 * - The catalog join is informational: the manifest records the
 *   catalog version bound against plus the registered binder ids
 *   scanned from browser sources. Full 68-word binder coverage
 *   completes with the planned forms/drawers/navigation/settings
 *   slices; this slice seeds poll-region/guarded-form/once-action.
 *
 * URL contract: file NAMES are pinned here; E's `assets.ts` owns
 * serving (routes, caching, hashing). Run after `tsc -p` (the
 * package `build` script chains it); expects `dist/` fresh.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const distUi = join(packageRoot, "dist", "src");
const distBrowserSrc = join(distUi, "browser");
const outDir = join(packageRoot, "dist", "browser");

/** Pinned daisyUI version (mirrors package.json devDependency + themes.css). */
const PINNED_DAISYUI_VERSION = "5.7.47";

/** Client modules this slice installs (verbatim copy, relative imports intact). */
const INSTALLED_CLIENT_MODULES = ["bootstrap.js", "polling.js"];

function fail(message) {
  console.error(`build-browser: ${message}`);
  process.exit(1);
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// 1. Pinned daisyUI (resolve through node_modules, never a hoisted guess).
const pkgRequire = createRequire(join(packageRoot, "package.json"));
let daisyRoot;
try {
  daisyRoot = dirname(pkgRequire.resolve("daisyui/package.json"));
} catch {
  fail("cannot resolve daisyui/package.json — install devDependencies first");
}
const daisyPkg = JSON.parse(readFileSync(join(daisyRoot, "package.json"), "utf8"));
if (daisyPkg.version !== PINNED_DAISYUI_VERSION) {
  fail(`daisyUI version is ${daisyPkg.version}, pinned is ${PINNED_DAISYUI_VERSION} — bump deliberately`);
}
const daisyCssPath = join(daisyRoot, "daisyui.css");
if (!existsSync(daisyCssPath)) {
  fail(`daisyUI has no daisyui.css at ${daisyCssPath}`);
}

// 2. Compiled client inputs exist (run tsc first).
for (const module of INSTALLED_CLIENT_MODULES) {
  if (!existsSync(join(distBrowserSrc, module))) {
    fail(`missing compiled ${module} — run tsc -p tsconfig.json first`);
  }
}

// 3. Client import closure: no runtime import may escape the browser dir.
const INSTALLED = new Set(INSTALLED_CLIENT_MODULES);
for (const module of INSTALLED_CLIENT_MODULES) {
  const source = readFileSync(join(distBrowserSrc, module), "utf8");
  for (const match of source.matchAll(/from\s*["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (!specifier.startsWith("./")) {
      fail(`${module} imports ${JSON.stringify(specifier)} — client modules must be browser-local`);
    }
    const target = specifier.slice(2);
    if (target.includes("/") || !INSTALLED.has(target)) {
      fail(`${module} imports ${JSON.stringify(specifier)} — not an installed browser sibling`);
    }
  }
  for (const match of source.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    fail(`${module} uses dynamic import(${JSON.stringify(match[1])}) — static siblings only`);
  }
}

// 4. Catalog version bound against (informational join).
const catalogJs = join(distUi, "catalog.js");
if (!existsSync(catalogJs)) {
  fail("missing compiled catalog.js — run tsc -p tsconfig.json first");
}
const catalogSource = readFileSync(catalogJs, "utf8");
const catalogVersion = catalogSource.match(/LANE05_CATALOG_VERSION\s*=\s*"([^"]+)"/)?.[1];
if (catalogVersion === undefined) {
  fail("cannot read LANE05_CATALOG_VERSION from compiled catalog.js");
}

// 5. Binder ids registered by browser sources (informational join).
const boundIds = [];
for (const file of readdirSync(join(packageRoot, "src", "browser"))) {
  if (!file.endsWith(".ts")) {
    continue;
  }
  const source = readFileSync(join(packageRoot, "src", "browser", file), "utf8");
  for (const match of source.matchAll(/registerBinder\(\s*"([^"]+)"/g)) {
    if (!boundIds.includes(match[1])) {
      boundIds.push(match[1]);
    }
  }
}

// 6. Assemble + install.
mkdirSync(outDir, { recursive: true });
const daisyCss = readFileSync(daisyCssPath, "utf8");
const themesCss = readFileSync(join(packageRoot, "themes.css"), "utf8");
const sourceCss = readFileSync(join(packageRoot, "src", "browser", "style.css"), "utf8");
const styleCss =
  `/* Installed CanLang browser stylesheet (FP.BROWSER).\n` +
  ` * Assembled by ui/scripts/build-browser.mjs: daisyUI ${PINNED_DAISYUI_VERSION} + themes.css + src/browser/style.css.\n` +
  ` * Catalog bound against: ${catalogVersion}. Do not edit — edit the sources.\n` +
  ` */\n${daisyCss}\n${themesCss}\n${sourceCss}`;
writeFileSync(join(outDir, "can-style.css"), styleCss);

const files = {};
for (const module of INSTALLED_CLIENT_MODULES) {
  const bytes = readFileSync(join(distBrowserSrc, module));
  writeFileSync(join(outDir, module), bytes);
  files[module] = { sha256: sha256Hex(bytes), bytes: bytes.length };
}
const styleBytes = readFileSync(join(outDir, "can-style.css"));
files["can-style.css"] = { sha256: sha256Hex(styleBytes), bytes: styleBytes.length };

writeFileSync(
  join(outDir, "manifest.json"),
  JSON.stringify(
    {
      generator: "ui/scripts/build-browser.mjs (FP.BROWSER-UI)",
      daisyui: PINNED_DAISYUI_VERSION,
      catalog: catalogVersion,
      binderIds: boundIds.sort(),
      files,
    },
    null,
    2,
  ) + "\n",
);

console.log(
  `build-browser: installed ${Object.keys(files).join(", ")} + manifest.json ` +
    `(daisyui ${PINNED_DAISYUI_VERSION}, catalog ${catalogVersion}, binders ${boundIds.sort().join(",")})`,
);
