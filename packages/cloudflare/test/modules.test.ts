import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_VERSION,
  type ArtifactModule,
  type CompileArtifact,
  type SourceMap,
} from "@canlang/contracts";
import { assembleModules } from "../src/runtime/modules.js";

const EMPTY_MAP: SourceMap = {
  version: 3,
  file: "",
  sources: [],
  sourcesContent: [],
  names: [],
  mappings: "",
};

function module(path: string, js: string): ArtifactModule {
  return { path, js, map: { ...EMPTY_MAP, file: path } };
}

function artifact(modules: ArtifactModule[]): CompileArtifact {
  return {
    artifact_version: ARTIFACT_VERSION,
    language_version: "1.0.0",
    tool_version: "0.1.0",
    sources: [],
    modules,
    callables: [],
    pages: [],
    requires: [],
    tests: [],
  };
}

/** Stub producer dists: `<root>/ui/dist/ui/src/index.js` + a stdlib module. */
function stubProducers(): { distRoot: string; stdlibUrl: string; uiEntry: string; uiUrl: string } {
  const distRoot = mkdtempSync(join(tmpdir(), "b1-dist-"));
  const uiEntry = join(distRoot, "ui", "dist", "ui", "src", "index.js");
  mkdirSync(join(distRoot, "ui", "dist", "ui", "src"), { recursive: true });
  writeFileSync(uiEntry, `export const uiMarker = "ui-stub";\n`);
  const stdlibPath = join(distRoot, "stdlib.mjs");
  writeFileSync(stdlibPath, `export const stdlibMarker = "stdlib-stub";\n`);
  return { distRoot, stdlibUrl: pathToFileURL(stdlibPath).href, uiEntry, uiUrl: pathToFileURL(uiEntry).href };
}

const ENTRY_JS = `import { stdlibMarker } from "@canlang/stdlib";
import { uiMarker } from "@canlang/ui";
import { helper } from "./lib/helper.js";
export const main = [stdlibMarker, uiMarker, helper].join("+");
`;

const HELPER_JS = `import { stdlibMarker } from "@canlang/stdlib";
export const helper = "helper:" + stdlibMarker;
`;

describe("assembleModules", () => {
  it("writes modules, rewrites producer imports, entry imports cleanly", async () => {
    const { distRoot, stdlibUrl, uiEntry, uiUrl } = stubProducers();
    const workDir = mkdtempSync(join(tmpdir(), "b1-work-"));
    const loaded = { artifact: artifact([module("main.js", ENTRY_JS), module("lib/helper.js", HELPER_JS)]), sourcePath: "/tmp/fixture.artifact.json" };

    const assembled = await assembleModules(loaded, { distRoot, uiUrl, workDir, stdlibUrl });

    expect(assembled.dir).toBe(workDir);
    expect(Object.keys(assembled.moduleUrls).sort()).toEqual(["lib/helper.js", "main.js"]);
    expect(assembled.entryUrl).toBe(assembled.moduleUrls["main.js"]);

    const writtenEntry = readFileSync(join(workDir, "main.js"), "utf8");
    expect(writtenEntry).toContain(`from "${stdlibUrl}"`);
    expect(writtenEntry).toContain(`from "${pathToFileURL(uiEntry).href}"`);
    expect(writtenEntry).toContain(`from "./lib/helper.js"`);
    expect(writtenEntry).not.toContain("@canlang/stdlib");
    expect(writtenEntry).not.toContain("@canlang/ui");
    expect(readFileSync(join(workDir, "lib", "helper.js"), "utf8")).toContain(`from "${stdlibUrl}"`);

    const entry = (await import(assembled.entryUrl)) as { main: string };
    expect(entry.main).toBe("stdlib-stub+ui-stub+helper:stdlib-stub");
  });

  it("fails loud naming the missing UI dist and build command", async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "b1-empty-dist-"));
    const workDir = mkdtempSync(join(tmpdir(), "b1-work-"));
    const loaded = { artifact: artifact([module("main.js", `export const x = 1;\n`)]), sourcePath: "s" };

    await expect(
      assembleModules(loaded, { uiUrl: pathToFileURL(join(emptyRoot, "missing.js")).href, workDir, stdlibUrl: "file:///stub.mjs" }),
    ).rejects.toThrow(/@canlang\/ui dist entry missing at .*bun run --filter @canlang\/ui build/);
  });

  it("throws naming module and specifier for non-producer bare imports", async () => {
    const { distRoot, stdlibUrl, uiUrl } = stubProducers();
    const workDir = mkdtempSync(join(tmpdir(), "b1-work-"));
    const bad = module("main.js", `import { x } from "left-pad";\nexport const y = x;\n`);
    const loaded = { artifact: artifact([bad]), sourcePath: "s" };

    await expect(assembleModules(loaded, { distRoot, uiUrl, workDir, stdlibUrl })).rejects.toThrow(
      /"main\.js".*"left-pad"/,
    );
  });

  it("throws for relative imports resolving to no artifact module", async () => {
    const { distRoot, stdlibUrl, uiUrl } = stubProducers();
    const workDir = mkdtempSync(join(tmpdir(), "b1-work-"));
    const bad = module("main.js", `import { x } from "./missing.js";\nexport const y = x;\n`);
    const loaded = { artifact: artifact([bad]), sourcePath: "s" };

    await expect(assembleModules(loaded, { distRoot, uiUrl, workDir, stdlibUrl })).rejects.toThrow(
      /"main\.js".*"\.\/missing\.js"/,
    );
  });
  it("uses literal import records and preserves prose, attributes and dynamic options", async () => {
    const { stdlibUrl, uiUrl } = stubProducers();
    const workDir = mkdtempSync(join(tmpdir(), "b1-literals-"));
    const js = [
      'const prose = "from \\\"unresolved-prose\\\"";',
      '// import "unresolved-comment";',
      'const matcher = /import("unresolved-regex")/;',
      'import { stdlibMarker } from "@canlang/stdlib" with { type: "javascript" };',
      'export const load = () => import(/* keep */ `@canlang/ui`, { with: { type: "javascript" } });',
      '',
    ].join("\n");
    const assembled = await assembleModules({ artifact: artifact([module("main.js", js)]), sourcePath: "literal.artifact.json" }, { uiUrl, workDir, stdlibUrl });
    const written = readFileSync(join(workDir, "main.js"), "utf8");
    expect(written).toContain('const prose = "from \\\"unresolved-prose\\\"";');
    expect(written).toContain('// import "unresolved-comment";');
    expect(written).toContain('/import("unresolved-regex")/');
    expect(written).toContain(`from "${stdlibUrl}" with { type: "javascript" }`);
    expect(written).toContain(`import(/* keep */ \`${uiUrl}\`, { with: { type: "javascript" } })`);
    expect(assembled.sourceMaps?.["main.js"]).toBeDefined();
  });

  it.each([
    ['import(which);', /nonliteral dynamic import/],
    ['import source x from "./x.js";', /unsupported import kind/],
    ['import("./missing.js");', /no such artifact module/],
  ])("refuses unsupported or dangling imports before writing", async (js, error) => {
    const { stdlibUrl, uiUrl } = stubProducers();
    const workDir = join(mkdtempSync(join(tmpdir(), "b1-invalid-")), "unwritten");
    await expect(assembleModules({ artifact: artifact([module("main.js", js as string)]), sourcePath: "invalid.artifact.json" }, { uiUrl, workDir, stdlibUrl })).rejects.toThrow(error as RegExp);
  });

});
