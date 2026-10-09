import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_VERSION,
  type ArtifactModule,
  type CompileArtifact,
  type SourceMap,
} from "@canlang/contracts";
import { assembleModules, importVerifiedAssemblyModule } from "../src/runtime/modules.js";
import { importVerifiedAssemblyModule as importPortableAssemblyModule } from "../src/runtime/assembly-verification.js";

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

    expect(dirname(assembled.dir)).toBe(realpathSync(workDir));
    expect(assembled.dir).toMatch(/assembly-[a-f0-9]{64}$/);
    expect(Object.keys(assembled.moduleUrls).sort()).toEqual(["lib/helper.js", "main.js"]);
    expect(assembled.entryUrl).toBe(assembled.moduleUrls["main.js"]);

    const writtenEntry = readFileSync(join(assembled.dir, "main.js"), "utf8");
    expect(writtenEntry).toContain(`from "${stdlibUrl}"`);
    expect(writtenEntry).toContain(`from "${pathToFileURL(uiEntry).href}"`);
    expect(writtenEntry).toContain(`from "./lib/helper.js"`);
    expect(writtenEntry).not.toContain("@canlang/stdlib");
    expect(writtenEntry).not.toContain("@canlang/ui");
    expect(readFileSync(join(assembled.dir, "lib", "helper.js"), "utf8")).toContain(`from "${stdlibUrl}"`);

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
    const written = readFileSync(join(assembled.dir, "main.js"), "utf8");
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

  it("imports only the owned assembly and unchanged URL map", async () => {
    const { stdlibUrl, uiUrl } = stubProducers();
    const asm = await assembleModules({ artifact: artifact([module("main.js", "export const value=7;")]), sourcePath: "owned" },
      { stdlibUrl, uiUrl, workDir: mkdtempSync(join(tmpdir(), "b1-owned-")) });
    await expect(importVerifiedAssemblyModule(asm, "main.js")).resolves.toMatchObject({ value: 7 });
    await expect(importPortableAssemblyModule(asm, "main.js")).resolves.toMatchObject({ value: 7 });
    await expect(importPortableAssemblyModule({ dir: asm.dir, entryUrl: asm.entryUrl,
      moduleUrls: { ...asm.moduleUrls } }, "main.js")).rejects.toThrow(/not assembler-owned/);
    await expect(importVerifiedAssemblyModule({ ...asm }, "main.js")).rejects.toThrow(/not assembler-owned/);
    await expect(importVerifiedAssemblyModule(asm, "other.js")).rejects.toThrow(/unknown artifact module/);
    const urls = asm.moduleUrls;
    asm.moduleUrls = { ...urls };
    await expect(importVerifiedAssemblyModule(asm, "main.js")).rejects.toThrow(/identity or URL map changed/);
    asm.moduleUrls = urls;
    urls["main.js"] += "?caller-version";
    await expect(importVerifiedAssemblyModule(asm, "main.js")).rejects.toThrow(/module URL changed/);
  });

  it("matches the full owning artifact and refuses metadata or module mutation", async () => {
    const { stdlibUrl, uiUrl } = stubProducers();
    const input = artifact([module("main.js", "export const value=7;")]);
    const asm = await assembleModules({ artifact: input, sourcePath: "artifact" },
      { stdlibUrl, uiUrl, workDir: mkdtempSync(join(tmpdir(), "b1-artifact-")) });
    const same = JSON.parse(JSON.stringify(input)) as CompileArtifact;
    await expect(importVerifiedAssemblyModule(asm, "main.js", same)).resolves.toMatchObject({ value: 7 });
    same.modules[0]!.js = "export const value=8;";
    await expect(importVerifiedAssemblyModule(asm, "main.js", same)).rejects.toThrow(/artifact differs/);
    input.tool_version = "changed";
    await expect(importVerifiedAssemblyModule(asm, "main.js", input)).rejects.toThrow(/artifact differs/);
    input.tool_version = "0.1.0";
    input.modules[0]!.js = "export const value=9;";
    await expect(importVerifiedAssemblyModule(asm, "main.js", input)).rejects.toThrow(/artifact differs/);
  });

  it("rechecks the supplied artifact after initialization changes its metadata", async () => {
    const { stdlibUrl, uiUrl } = stubProducers();
    const key = "__canVerifiedAssemblyArtifact";
    const input = artifact([module("main.js", `globalThis[${JSON.stringify(key)}].tool_version="changed"; export const value=7;`)]);
    const asm = await assembleModules({ artifact: input, sourcePath: "metadata" },
      { stdlibUrl, uiUrl, workDir: mkdtempSync(join(tmpdir(), "b1-after-artifact-")) });
    Reflect.set(globalThis, key, input);
    try { await expect(importVerifiedAssemblyModule(asm, "main.js", input)).rejects.toThrow(/artifact differs/); }
    finally { Reflect.deleteProperty(globalThis, key); }
    expect(input.tool_version).toBe("changed");
  });

  it("refuses altered sibling bytes and file or directory symlinks", async () => {
    const { stdlibUrl, uiUrl } = stubProducers();
    const asm = await assembleModules({ artifact: artifact([
      module("main.js", 'export { value } from "./lib/helper.js";'), module("lib/helper.js", "export const value=7;"),
    ]), sourcePath: "closure" }, { stdlibUrl, uiUrl, workDir: mkdtempSync(join(tmpdir(), "b1-closure-")) });
    const helper = fileURLToPath(asm.moduleUrls["lib/helper.js"]!);
    const original = readFileSync(helper);
    writeFileSync(helper, "export const value=8;");
    await expect(importVerifiedAssemblyModule(asm, "main.js")).rejects.toThrow(/module bytes changed/);
    writeFileSync(helper, original);
    const outside = join(mkdtempSync(join(tmpdir(), "b1-outside-")), "helper.js");
    writeFileSync(outside, original, { mode: 0o600 });
    unlinkSync(helper); symlinkSync(outside, helper);
    await expect(importVerifiedAssemblyModule(asm, "main.js")).rejects.toThrow(/private regular owned path/);
    unlinkSync(helper); writeFileSync(helper, original, { mode: 0o600 });
    const moved = join(asm.dir, "moved-lib");
    renameSync(join(asm.dir, "lib"), moved); symlinkSync(moved, join(asm.dir, "lib"));
    await expect(importVerifiedAssemblyModule(asm, "main.js")).rejects.toThrow(/private regular owned path/);
  });

  it.each(["", 'throw new Error("initialization failed");'])("checks staged bytes again after module initialization %s", async (ending) => {
    const { stdlibUrl, uiUrl } = stubProducers();
    writeFileSync(fileURLToPath(stdlibUrl), [
      'import { appendFileSync } from "node:fs";',
      'import { fileURLToPath } from "node:url";',
      'export const change = url => appendFileSync(fileURLToPath(url), "\\n// changed during initialization");',
    ].join("\n"));
    const asm = await assembleModules({ artifact: artifact([module("main.js",
      `import { change } from "@canlang/stdlib"; change(import.meta.url); ${ending} export const value=7;`)]), sourcePath: "changed" },
      { stdlibUrl, uiUrl, workDir: mkdtempSync(join(tmpdir(), "b1-after-import-")) });
    await expect(importVerifiedAssemblyModule(asm, "main.js")).rejects.toThrow(/module bytes changed/);
  });

  it("reuses only exact staged bytes and never writes through an existing symlink", async () => {
    const { stdlibUrl, uiUrl } = stubProducers();
    const opts = { stdlibUrl, uiUrl, workDir: mkdtempSync(join(tmpdir(), "b1-no-overwrite-")) };
    const input = { artifact: artifact([module("main.js", 'export { value } from "./lib/helper.js";'),
      module("lib/helper.js", "export const value=7;")]), sourcePath: "reuse" };
    const asm = await assembleModules(input, opts);
    const helper = fileURLToPath(asm.moduleUrls["lib/helper.js"]!);
    const outside = join(mkdtempSync(join(tmpdir(), "b1-protected-")), "outside.js");
    writeFileSync(outside, "untouched", { mode: 0o600 });
    unlinkSync(helper); symlinkSync(outside, helper);
    await expect(assembleModules(input, opts)).rejects.toThrow(/private regular owned path/);
    expect(readFileSync(outside, "utf8")).toBe("untouched");
    unlinkSync(helper); writeFileSync(helper, "altered", { mode: 0o600 });
    await expect(assembleModules(input, opts)).rejects.toThrow(/existing staged file bytes changed/);
    expect(readFileSync(helper, "utf8")).toBe("altered");
    const parent = join(asm.dir, "lib");
    const moved = join(asm.dir, "moved-lib");
    renameSync(parent, moved); symlinkSync(moved, parent);
    await expect(assembleModules(input, opts)).rejects.toThrow(/private regular owned path/);
    expect(readFileSync(join(moved, "helper.js"), "utf8")).toBe("altered");
  });

  it("qualifies staged map bytes and separates different source-map provenance", async () => {
    const { stdlibUrl, uiUrl } = stubProducers();
    const opts = { stdlibUrl, uiUrl, workDir: mkdtempSync(join(tmpdir(), "b1-map-version-")) };
    const input = (source: string) => {
      const mod = module("main.js", "export const value=7;");
      mod.map = { ...mod.map, sources: [source], sourcesContent: [source] };
      return { artifact: artifact([mod]), sourcePath: source };
    };
    const first = await assembleModules(input("first.can"), opts);
    const second = await assembleModules(input("second.can"), opts);
    expect(second.entryUrl).not.toBe(first.entryUrl);
    const map = fileURLToPath(second.mapUrls!["main.js"]!);
    writeFileSync(map, "{}");
    await expect(importVerifiedAssemblyModule(second, "main.js")).rejects.toThrow(/module bytes changed/);
    await expect(assembleModules(input("second.can"), opts)).rejects.toThrow(/existing staged file bytes changed/);
  });

  it("versions the whole closure for ordinary and verified imports when workDir is reused", async () => {
    const { stdlibUrl, uiUrl } = stubProducers();
    const opts = { stdlibUrl, uiUrl, workDir: mkdtempSync(join(tmpdir(), "b1-version-")) };
    const input = (value: number) => ({ artifact: artifact([
      module("main.js", 'import { value } from "./helper.js"; export const read=()=>value;'),
      module("helper.js", `export const value=${value};`),
    ]), sourcePath: "versioned" });
    const first = await assembleModules(input(1), opts);
    const oldEntry = await import(first.entryUrl) as { read(): number };
    expect(oldEntry.read()).toBe(1);
    const second = await assembleModules(input(2), opts);
    expect(second.entryUrl).not.toBe(first.entryUrl);
    expect((await import(second.entryUrl) as { read(): number }).read()).toBe(2);
    expect((await importVerifiedAssemblyModule(second, "main.js") as { read(): number }).read()).toBe(2);
    expect((await importVerifiedAssemblyModule(first, "main.js") as { read(): number }).read()).toBe(1);
    const repeated = await assembleModules(input(2), opts);
    expect(repeated.entryUrl).toBe(second.entryUrl);
    expect(await importVerifiedAssemblyModule(repeated, "main.js")).toBe(await import(second.entryUrl));
  });

});
