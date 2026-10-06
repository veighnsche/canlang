import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  ArtifactCallable,
  ArtifactModule,
  CompileArtifact,
  SourceMap,
  StoragePort,
} from "@canlang/contracts";
import { createContext, type HandlerContext } from "../src/runtime/context.js";
import { findAssembledFrame, findRemappedFrame, invokeCallable } from "../src/runtime/invoke.js";
import { assembleModules } from "../src/runtime/modules.js";
import { decodeMappings, lookup } from "../src/runtime/sourcemap.js";
import { startLocalDev } from "../src/dev/local-run.js";

// B3 I2: a NON-EMPTY real map (never EMPTY_MAP). Three generated lines map
// to plain.can lines 1..3 at column 1: "AAAA" (origin), then two "AACA"
// (source line +1 each) — the same bytes the Rust encoder emits for the
// plain-snippet fixture in compiler/tests/codegen.rs.
const REAL_MAP: SourceMap = {
  version: 3,
  file: "main.js",
  sources: ["plain.can"],
  sourcesContent: ["app Plain\nnote Note\nrule allow\n"],
  names: [],
  mappings: "AAAA;AACA;AACA",
};

// The `throw` sits on generated line 3; the appended sourceMappingURL
// comment lands after it, so assembly never shifts the throw line.
const THROWING_JS = [
  "export function canApp(){ return { boom }; }",
  "function boom(ctx) {",
  '  throw new Error("kaboom");',
  "}",
  "",
].join("\n");

function testCtx(): HandlerContext {
  return createContext({
    caller: { userId: "u-test", roles: [] },
    store: {} as unknown as StoragePort,
  });
}

function stubProducers(): { distRoot: string; stdlibUrl: string; uiUrl: string } {
  const distRoot = mkdtempSync(join(tmpdir(), "b3-dist-"));
  const uiEntry = join(distRoot, "ui", "dist", "ui", "src", "index.js");
  mkdirSync(join(distRoot, "ui", "dist", "ui", "src"), { recursive: true });
  writeFileSync(uiEntry, `export const uiMarker = "ui-stub";\n`);
  const stdlibPath = join(distRoot, "stdlib.mjs");
  writeFileSync(stdlibPath, `export const stdlibMarker = "stdlib-stub";\n`);
  return { distRoot, uiUrl: pathToFileURL(uiEntry).href, stdlibUrl: pathToFileURL(stdlibPath).href };
}

function artifactWith(module: ArtifactModule): CompileArtifact {
  const callable: ArtifactCallable = {
    id: "plain.Plain.boom",
    kind: "operation",
    module: module.path,
    export: "boom",
    member: ["boom"],
  };
  return {
    artifact_version: 1,
    language_version: "1.0.0",
    tool_version: "0.1.0",
    sources: [{ path: "plain.can", sha256: "0".repeat(64) }],
    modules: [module],
    callables: [callable],
    pages: [],
    requires: [],
    tests: [],
  };
}

describe("sourcemap decode + lookup (B3 I2)", () => {
  it("decodes the real map into per-line segments", () => {
    const lines = decodeMappings(REAL_MAP.mappings);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual([{ genCol: 0, src: 0, srcLine: 0, srcCol: 0 }]);
    expect(lines[1]).toEqual([{ genCol: 0, src: 0, srcLine: 1, srcCol: 0 }]);
    expect(lines[2]).toEqual([{ genCol: 0, src: 0, srcLine: 2, srcCol: 0 }]);
  });

  it("decodes an empty mappings string to no lines", () => {
    expect(decodeMappings("")).toEqual([]);
  });

  it("fails loud on malformed mappings", () => {
    expect(() => decodeMappings("!")).toThrow(/sourcemap/i);
    expect(() => decodeMappings(";;;,,,")).toThrow(/sourcemap/i);
  });

  it("looks up a generated position to 1-based .can source + line + column", () => {
    expect(lookup(REAL_MAP, 3, 9)).toEqual({ source: "plain.can", line: 3, column: 1 });
    expect(lookup(REAL_MAP, 1, 0)).toEqual({ source: "plain.can", line: 1, column: 1 });
  });

  it("picks the greatest segment at or before the generated column", () => {
    // Two segments on one line: col 0 -> src line 1, col 10 -> src line 2.
    // "AAAA" then ",UACA": gen +10 (U), src +0, line +1 (C), col +0.
    const map: SourceMap = { ...REAL_MAP, mappings: "AAAA,UACA" };
    expect(lookup(map, 1, 0)).toEqual({ source: "plain.can", line: 1, column: 1 });
    expect(lookup(map, 1, 9)).toEqual({ source: "plain.can", line: 1, column: 1 });
    expect(lookup(map, 1, 10)).toEqual({ source: "plain.can", line: 2, column: 1 });
  });

  it("returns null for unknown frames (out of range, empty line, bad index)", () => {
    expect(lookup(REAL_MAP, 99, 0)).toBeNull();
    expect(lookup(REAL_MAP, 0, 0)).toBeNull();
    expect(lookup({ ...REAL_MAP, mappings: "" }, 1, 0)).toBeNull();
    expect(lookup({ ...REAL_MAP, mappings: ";" }, 1, 0)).toBeNull();
    // 1-field (unmapped) segments carry no source.
    expect(lookup({ ...REAL_MAP, mappings: "A" }, 1, 0)).toBeNull();
  });

  it("fails loud when lookup meets a malformed map", () => {
    expect(() => lookup({ ...REAL_MAP, mappings: "!" }, 1, 0)).toThrow(/sourcemap/i);
  });
});

describe("sourcemap runtime round-trip (B3 I2)", () => {
  it("a throwing handler yields mapped == the .can file + line", async () => {
    const { distRoot, stdlibUrl, uiUrl } = stubProducers();
    const workDir = mkdtempSync(join(tmpdir(), "b3-work-"));
    const artifact = artifactWith({ path: "main.js", js: THROWING_JS, map: REAL_MAP });

    const assembled = await assembleModules(
      { artifact, sourcePath: "/tmp/b3-fixture.artifact.json" },
      { distRoot, uiUrl, workDir, stdlibUrl },
    );

    // assembleModules stages the map next to the module with a working
    // sourceMappingURL, so plain Node can resolve staged frames too.
    const stagedMap = JSON.parse(readFileSync(join(workDir, "main.js.map"), "utf8")) as SourceMap;
    expect(stagedMap.mappings).toBe(REAL_MAP.mappings);
    expect(stagedMap.sources).toEqual(["plain.can"]);
    const stagedJs = readFileSync(join(workDir, "main.js"), "utf8");
    expect(stagedJs).toContain("//# sourceMappingURL=main.js.map");
    expect(assembled.mapUrls?.["main.js"]).toBe(pathToFileURL(join(workDir, "main.js.map")).href);

    const result = await invokeCallable(assembled, artifact, "plain.Plain.boom", testCtx());
    expect(result.ok).toBe(false);
    expect(result.error).toBe("kaboom");
    expect(result.mapped).toEqual({ source: "plain.can", line: 3, column: 1 });
  });

  it("unknown frames stay message-only: original error preserved, no mapped", async () => {
    const { distRoot, stdlibUrl, uiUrl } = stubProducers();
    const workDir = mkdtempSync(join(tmpdir(), "b3-work-"));
    const emptyMap: SourceMap = { ...REAL_MAP, sources: [], sourcesContent: [], mappings: "" };
    const artifact = artifactWith({ path: "main.js", js: THROWING_JS, map: emptyMap });
    const assembled = await assembleModules(
      { artifact, sourcePath: "/tmp/b3-fixture.artifact.json" },
      { distRoot, uiUrl, workDir, stdlibUrl },
    );

    const result = await invokeCallable(assembled, artifact, "plain.Plain.boom", testCtx());
    expect(result.ok).toBe(false);
    expect(result.error).toBe("kaboom");
    expect(result.mapped).toBeUndefined();
  });

  it("malformed maps never break invoke: message-only, unmapped position intact", async () => {
    const { distRoot, stdlibUrl, uiUrl } = stubProducers();
    const workDir = mkdtempSync(join(tmpdir(), "b3-work-"));
    const badMap: SourceMap = { ...REAL_MAP, mappings: "!" };
    const artifact = artifactWith({ path: "main.js", js: THROWING_JS, map: badMap });
    const assembled = await assembleModules(
      { artifact, sourcePath: "/tmp/b3-fixture.artifact.json" },
      { distRoot, uiUrl, workDir, stdlibUrl },
    );

    const result = await invokeCallable(assembled, artifact, "plain.Plain.boom", testCtx());
    expect(result.ok).toBe(false);
    expect(result.error).toBe("kaboom");
    expect(result.mapped).toBeUndefined();
    // The failure is loud at the decode layer, not swallowed as a guess.
    expect(() => decodeMappings(badMap.mappings)).toThrow(/sourcemap/i);
  });

  it("findAssembledFrame preserves the unmapped generated position", () => {
    const mainUrl = "file:///tmp/b3-work/main.js";
    const stack = [
      "Error: kaboom",
      `    at boom (${mainUrl}:3:9)`,
      "    at node:internal/async:1:1",
      `    at async other (${mainUrl}:1:1)`,
    ].join("\n");
    // Topmost assembled frame wins; non-module frames are skipped.
    expect(findAssembledFrame(stack, { "main.js": mainUrl })).toEqual({
      module: "main.js",
      line: 3,
      column: 9,
    });
    expect(findAssembledFrame("Error: x\n    at f (node:internal/y:1:1)", { "main.js": mainUrl })).toBeNull();
    expect(findAssembledFrame("not a stack", { "main.js": mainUrl })).toBeNull();
    // Realpath divergence (macOS /tmp vs /private/tmp) still resolves.
    expect(
      findAssembledFrame(`Error: x\n    at boom (file:///private/tmp/w/main.js:3:9)`, {
        "main.js": "file:///tmp/w/main.js",
      }),
    ).toEqual({ module: "main.js", line: 3, column: 9 });
    // Decoded file paths match too (runtimes printing paths, not URLs).
    expect(
      findAssembledFrame(`Error: x\n    at boom (/tmp/w/main.js:3:9)`, {
        "main.js": "file:///tmp/w/main.js",
      }),
    ).toEqual({ module: "main.js", line: 3, column: 9 });
  });

  it("findRemappedFrame reads runtime-remapped .can positions directly", () => {
    // Node with source-map support rewrites the frame file to the map's
    // `sources` entry; the 1-based line/column are already the answer.
    const stack = [
      "Error: kaboom",
      "    at Object.boom (/private/tmp/b3-work/plain.can:3:1)",
      "    at node:internal/async:1:1",
    ].join("\n");
    expect(findRemappedFrame(stack, ["plain.can"])).toEqual({
      source: "plain.can",
      line: 3,
      column: 1,
    });
    expect(findRemappedFrame(stack, ["other.can"])).toBeNull();
    expect(findRemappedFrame(stack, [])).toBeNull();
  });

  it("invoke maps through its own lookup when the runtime cannot remap", async () => {
    const { distRoot, stdlibUrl, uiUrl } = stubProducers();
    const workDir = mkdtempSync(join(tmpdir(), "b3-work-"));
    const artifact = artifactWith({ path: "main.js", js: THROWING_JS, map: REAL_MAP });
    const assembled = await assembleModules(
      { artifact, sourcePath: "/tmp/b3-fixture.artifact.json" },
      { distRoot, uiUrl, workDir, stdlibUrl },
    );
    // Deleting the staged map (and its comment, so no loader hunts for
    // it) disables runtime remapping: the stack keeps generated positions
    // and invoke's own lookup must resolve them.
    rmSync(join(workDir, "main.js.map"));
    const stagedPath = join(workDir, "main.js");
    writeFileSync(
      stagedPath,
      readFileSync(stagedPath, "utf8").replace(/\/\/# sourceMappingURL=.*\n?/, ""),
    );

    const result = await invokeCallable(assembled, artifact, "plain.Plain.boom", testCtx());
    expect(result.ok).toBe(false);
    expect(result.error).toBe("kaboom");
    expect(result.mapped).toEqual({ source: "plain.can", line: 3, column: 1 });
  });

  it("local dev passes source maps through as inline comments", async () => {
    const dev = await startLocalDev({
      workerName: "sourcemap-passthrough",
      compatibilityDate: "2026-07-15",
      mainModule: "worker.mjs",
      modules: {
        "worker.mjs": `export default { async fetch() { return Response.json({ ok: true }); } }`,
      },
      sourceMaps: { "worker.mjs": REAL_MAP },
    });
    try {
      const response = await dev.dispatch("/");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      await dev.dispose();
    }
  }, 120000);
});
