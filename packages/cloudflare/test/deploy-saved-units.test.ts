import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SourceMap } from "@canlang/contracts";
import { encode } from "@jridgewell/sourcemap-codec";
import {
  assertLinksResolve,
  assertSavedUnitSeparation,
  packSavedUnitModules,
  savedUnitStagedPath,
} from "../src/deploy/bundle.js";
import { assertSavedUnitImports, rewriteModuleImports, type ImportTransformMap } from "../src/deploy/module-imports.js";
import { parseOwnerManifest, viewSavedUnitMap, type CanOwnerLink } from "../src/deploy/module-maps.js";
import { gatherSavedUnitAssets } from "../src/deploy/package-assets.js";
import { lookup } from "../src/runtime/sourcemap.js";

const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "can-deploy-saved-units-"));
  directories.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function sha256(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

const KEYWORD_JS = "export function canonicalKey(value) { return value; }\n";
const VIEW_JS = "export function render({row, bindings, ui}) { return null; }\nexport function mount(root, presentation) { return () => {}; }\n";
const OWNER: CanOwnerLink = {
  unitId: "u3",
  kind: "keyword",
  canPath: "app.can",
  canRevision: "r".repeat(64),
  start: 10,
  end: 20,
};

describe("saved-unit closure packing", () => {
  it("stages keywords at server.js and views at view.js", () => {
    expect(savedUnitStagedPath("u3", "keyword")).toBe("can.generated/u3/server.js");
    expect(savedUnitStagedPath("u5", "view")).toBe("can.generated/u5/view.js");
    const staged = packSavedUnitModules([
      { unitId: "u5", kind: "view", js: VIEW_JS, sha256: sha256(VIEW_JS) },
      { unitId: "u3", kind: "keyword", js: KEYWORD_JS, sha256: sha256(KEYWORD_JS) },
    ]);
    // Deterministic sorted keys regardless of input order.
    expect(Object.keys(staged)).toEqual(["can.generated/u3/server.js", "can.generated/u5/view.js"]);
    expect(staged["can.generated/u3/server.js"]).toBe(KEYWORD_JS);
    expect(staged["can.generated/u5/view.js"]).toBe(VIEW_JS);
    expect(packSavedUnitModules([
      { unitId: "u3", kind: "keyword", js: KEYWORD_JS, sha256: sha256(KEYWORD_JS) },
    ])).toEqual(packSavedUnitModules([
      { unitId: "u3", kind: "keyword", js: KEYWORD_JS, sha256: sha256(KEYWORD_JS) },
    ]));
  });

  it("refuses mismatched, empty, duplicate, and non-packable units", () => {
    expect(() => packSavedUnitModules([
      { unitId: "u3", kind: "keyword", js: KEYWORD_JS, sha256: "0".repeat(64) },
    ])).toThrowError(/fingerprint mismatch/);
    expect(() => packSavedUnitModules([
      { unitId: "u3", kind: "keyword", js: "", sha256: sha256("") },
    ])).toThrowError(/empty implementation bytes/);
    expect(() => packSavedUnitModules([
      { unitId: "u3", kind: "keyword", js: KEYWORD_JS, sha256: sha256(KEYWORD_JS) },
      { unitId: "u3", kind: "keyword", js: KEYWORD_JS, sha256: sha256(KEYWORD_JS) },
    ])).toThrowError(/duplicate path/);
    expect(() => packSavedUnitModules([
      { unitId: "u3", kind: "style" as "keyword", js: KEYWORD_JS, sha256: sha256(KEYWORD_JS) },
    ])).toThrowError(/non-packable kind/);
    for (const unitId of ["", ".", "..", "u/1", "u\\1", "u 1", "u\t1"]) {
      expect(() => packSavedUnitModules([
        { unitId, kind: "keyword", js: KEYWORD_JS, sha256: sha256(KEYWORD_JS) },
      ])).toThrowError(/must not be empty, name a path, or contain whitespace/);
    }
    expect(() => packSavedUnitModules([
      { unitId: "u3", kind: "keyword", js: KEYWORD_JS, sha256: "xyz" },
    ])).toThrowError(/malformed SHA-256/);
  });

  it("packed closures link-resolve within the bundle", () => {
    const staged = packSavedUnitModules([
      { unitId: "u3", kind: "keyword", js: "import { help } from \"./helper.js\";\nexport function canonicalKey(v) { return help(v); }\n", sha256: sha256("import { help } from \"./helper.js\";\nexport function canonicalKey(v) { return help(v); }\n") },
    ]);
    const modules: Record<string, string> = {
      ...staged,
      "can.generated/u3/helper.js": "export function help(v) { return v; }\n",
    };
    expect(() => assertLinksResolve(modules)).not.toThrow();
    expect(() => assertLinksResolve(staged)).toThrowError(/no such staged module/);
  });
});

describe("saved-unit import separation", () => {
  it("admits unit-local relative imports and import.meta", () => {
    expect(() => assertSavedUnitImports(
      "import { help } from \"./helper.js\";\nimport \"../shared.js\";\nexport function canonicalKey(v) { return import.meta.url && help(v); }\n",
      "can.generated/u3/server.js",
    )).not.toThrow();
    expect(() => assertSavedUnitImports("export function canonicalKey(v) { return v; }\n", "can.generated/u3/server.js")).not.toThrow();
    // Explicitly admitted producers pass; nothing else is admitted by appearing.
    expect(() => assertSavedUnitImports(
      "import { x } from \"@canlang/admitted\";\nexport function canonicalKey(v) { return x(v); }\n",
      "can.generated/u3/server.js",
      { allowedProducers: ["@canlang/admitted"] },
    )).not.toThrow();
  });

  it("refuses privileged, bare, file, phase, and nonliteral edges", () => {
    for (const [js, needle] of [
      ["import fs from \"fs\";\nexport function f() {}\n", "never enter worker/browser bundles"],
      ["import { x } from \"node:fs\";\nexport function f() {}\n", "\"node:fs\""],
      ["import \"node:process\";\nexport function f() {}\n", "\"node:process\""],
      ["import { x } from \"fs/promises\";\nexport function f() {}\n", "\"fs/promises\""],
      ["import x from \"left-pad\";\nexport function f() {}\n", "only unit-local relative imports"],
      ["import \"file:///etc/passwd\";\nexport function f() {}\n", "\"file:///etc/passwd\""],
      ["export function f(name) { return import(name); }\n", "nonliteral dynamic import"],
    ] as const) {
      expect(() => assertSavedUnitImports(js, "can.generated/u3/server.js"), js).toThrowError(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("separates only generated modules and no-ops without them", () => {
    expect(() => assertSavedUnitSeparation({ "worker/main.js": "import x from \"node:fs\";\n" })).not.toThrow();
    expect(() => assertSavedUnitSeparation({})).not.toThrow();
    expect(() => assertSavedUnitSeparation({
      "can.generated/u3/server.js": "import fs from \"fs\";\nexport function f() {}\n",
    })).toThrowError(/never enter worker\/browser bundles/);
  });
});

describe("saved-unit maps with owner links", () => {
  const TWO_LINE_JS = "export function canonicalKey(value) {\n  return value;\n}\n";
  // Identity map over three saved lines: maps locate actual saved JS.
  const identity: SourceMap = {
    version: 3,
    file: "can.generated/u3/server.js",
    sources: ["can.generated/u3/server.js"],
    sourcesContent: [TWO_LINE_JS],
    names: [],
    mappings: encode([[[0, 0, 0, 0]], [[0, 0, 1, 0]], [[0, 0, 2, 0]]]),
  };

  it("pairs composed maps with the Can owner link", () => {
    // Unedited: the identity map locates actual saved lines, and the
    // owner link rides alongside as data passthrough, never map input.
    const unchanged = viewSavedUnitMap(identity, [], TWO_LINE_JS, OWNER);
    expect(unchanged.owner).toEqual(OWNER);
    expect(unchanged.view.status).toBe("unchanged");
    expect(lookup(unchanged.view.map!, 1, 0)).toEqual({ source: "can.generated/u3/server.js", line: 1, column: 1 });
    expect(lookup(unchanged.view.map!, 2, 0)).toEqual({ source: "can.generated/u3/server.js", line: 2, column: 1 });
    // One import-rewrite stage: composition reuses composeModuleMap
    // unchanged, still locating saved lines through the edit.
    const js = "import x from './something.js'; throw Error('boom');";
    const rewritten = rewriteModuleImports(js, "can.generated/u3/server.js", () => "./other.js");
    expect(rewritten.changed).toBe(true);
    const stages: ImportTransformMap[] = [rewritten.map!];
    const paired = viewSavedUnitMap(identity, stages, js, OWNER);
    expect(paired.owner).toEqual(OWNER);
    expect(paired.view.status).toBe("composed");
    expect(paired.view.map!.sources).toEqual(["can.generated/u3/server.js"]);
    expect(lookup(paired.view.map!, 1, 0)).toEqual({ source: "can.generated/u3/server.js", line: 1, column: 1 });
  });

  it("parses strict owner manifests and refuses drift", () => {
    const manifest = JSON.stringify([{
      path: "can.generated/u3/server.js",
      sha256: sha256(KEYWORD_JS),
      owner: OWNER,
    }]);
    expect(parseOwnerManifest(manifest)).toEqual([{
      path: "can.generated/u3/server.js",
      sha256: sha256(KEYWORD_JS),
      owner: OWNER,
    }]);
    expect(parseOwnerManifest("[]")).toEqual([]);
    expect(() => parseOwnerManifest("{oops")).toThrowError(/invalid JSON/);
    expect(() => parseOwnerManifest("{}")).toThrowError(/expected a JSON array/);
    expect(() => parseOwnerManifest(JSON.stringify([{ path: "x", sha256: "zz", owner: OWNER }]))).toThrowError(/sha256/);
    expect(() => parseOwnerManifest(JSON.stringify([{
      path: "can.generated/u3/server.js", sha256: sha256(KEYWORD_JS), owner: OWNER, extra: 1,
    }]))).toThrowError(/unknown field/);
    expect(() => parseOwnerManifest(JSON.stringify([{
      path: "can.generated/u3/server.js", sha256: sha256(KEYWORD_JS), owner: { ...OWNER, start: -1 },
    }]))).toThrowError(/non-negative safe integer/);
  });
});

describe("saved-unit assets", () => {
  it("gathers exactly the manifest set with typed resources", () => {
    const dir = tempDirectory();
    const unitDir = join(dir, "u3");
    mkdirSync(join(unitDir, "assets"), { recursive: true });
    const helper = "export function help(v) { return v; }\n";
    const css = ".tile { color: red; }\n";
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    writeFileSync(join(unitDir, "helper.js"), helper);
    writeFileSync(join(unitDir, "tile.css"), css);
    writeFileSync(join(unitDir, "assets", "bg.png"), png);
    const gathered = gatherSavedUnitAssets(unitDir, {
      "tile.css": sha256(css),
      "helper.js": sha256(helper),
      "assets/bg.png": sha256(png),
    });
    // Sorted deterministic keys.
    expect(Object.keys(gathered.modules)).toEqual(["helper.js"]);
    expect(Object.keys(gathered.resources)).toEqual(["assets/bg.png", "tile.css"]);
    expect(gathered.modules["helper.js"]).toBe(helper);
    expect(gathered.resources["tile.css"]!.contentType).toBe("text/css");
    expect(gathered.resources["assets/bg.png"]!.contentType).toBe("image/png");
    expect(Buffer.from(gathered.resources["assets/bg.png"]!.bytes)).toEqual(Buffer.from(png));
    expect(gatherSavedUnitAssets(unitDir, {})).toEqual({ modules: {}, resources: {} });
  });

  it("refuses escapes, mismatches, reserved names, and unknown extensions", () => {
    const dir = tempDirectory();
    const unitDir = join(dir, "u3");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, "helper.js"), "export const x = 1;\n");
    writeFileSync(join(dir, "outside.txt"), "outside");
    symlinkSync(join(dir, "outside.txt"), join(unitDir, "escape.js"));
    expect(() => gatherSavedUnitAssets(unitDir, { "../outside.txt": "0".repeat(64) })).toThrowError(/traversal-free/);
    expect(() => gatherSavedUnitAssets(unitDir, { "escape.js": sha256("outside") })).toThrowError(/escapes producer directory|cannot read/);
    expect(() => gatherSavedUnitAssets(unitDir, { "helper.js": "0".repeat(64) })).toThrowError(/fingerprint mismatch/);
    expect(() => gatherSavedUnitAssets(unitDir, { "helper.js": "xyz" })).toThrowError(/malformed SHA-256/);
    expect(() => gatherSavedUnitAssets(unitDir, { "implementation.js": "0".repeat(64) })).toThrowError(/reserved primary/);
    writeFileSync(join(unitDir, "data.xyz"), "data");
    expect(() => gatherSavedUnitAssets(unitDir, { "data.xyz": sha256("data") })).toThrowError(/unadmitted extension/);
    writeFileSync(join(unitDir, "bad.js"), new Uint8Array([0xff, 0xfe, 0xfd]));
    expect(() => gatherSavedUnitAssets(unitDir, { "bad.js": sha256(new Uint8Array([0xff, 0xfe, 0xfd])) })).toThrowError(/not valid UTF-8/);
    expect(() => gatherSavedUnitAssets(join(dir, "missing"), {})).toThrowError(/cannot read unit directory/);
  });
});

// The workerd/browser actual-target gate stays explicitly open: this
// suite qualifies packing, separation, maps, and assets here;
// execution on workerd/browser hardware is a held external gate,
// reported rather than claimed.
