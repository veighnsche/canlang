import { describe, expect, it } from "vitest";
import { posix } from "node:path";
import { decode } from "@jridgewell/sourcemap-codec";
import corpus from "./fixtures/import-policy-contract.json" with { type: "json" };
import { rewriteModuleImports, scanModuleImports, validateArtifactModuleImports, type ImportErrorPrefix } from "../src/deploy/module-imports.js";

interface Control {
  id: string; module_key: string; js: string; policy: "artifact" | "trusted-producer";
  prefix?: ImportErrorPrefix; stdlib_url?: string; known_artifact_paths?: string[];
  modules?: { path: string; js: string }[];
  target: { error?: string; js?: string; record_count?: number; specifier?: string; content_span?: number[]; dynamic_status?: string };
}
const controls = corpus.controls as Control[];
const entries: Record<string, string> = {
  "@canlang/stdlib": "vendor/stdlib/index.js", "@canlang/ui": "vendor/ui/index.js",
  "@canlang/identity": "vendor/identity/index.js", "@canlang/values": "vendor/values/index.js",
  "@canlang/contracts": "vendor/contracts/index.js", "@canlang/contracts/values": "vendor/contracts/values.js",
  "@canlang/state/storage/d1": "vendor/state/storage/d1.js",
  "@canlang/state/receipt/join": "vendor/state/receipt/join.js", "@canlang/state/receipt": "vendor/state/receipt/index.js",
};
function mapped(control: Control, specifier: string): string {
  if (control.stdlib_url !== undefined && specifier === "@canlang/stdlib") return control.stdlib_url;
  let entry = entries[specifier];
  if (control.module_key.startsWith("vendor/values-bindings/") && specifier.startsWith("../src/")) entry = `vendor/values/${specifier.slice(7)}`;
  if (entry === undefined) return specifier;
  const relative = posix.relative(posix.dirname(control.module_key), entry);
  return relative.startsWith(".") ? relative : `./${relative}`;
}
function execute(control: Control) {
  const prefix = control.prefix ?? "deploy bundle";
  if (control.policy === "artifact") {
    const modules = control.id === "cross-module-order" ? control.modules! : [
      { path: control.module_key, js: control.js },
      ...(control.known_artifact_paths ?? []).filter((path) => path !== control.module_key).map((path) => ({ path, js: "" })),
    ];
    validateArtifactModuleImports(modules, prefix);
  }
  return rewriteModuleImports(control.js, control.module_key, (specifier) => mapped(control, specifier), { prefix, profile: control.policy });
}

describe("frozen decoded import policy (41 controls)", () => {
  for (const control of controls) it(control.id, () => {
    if (control.target.error !== undefined) {
      let caught: unknown;
      try { execute(control); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).name).toBe("Error");
      expect((caught as Error).message).toBe(control.target.error);
      expect(Object.hasOwn(caught as object, "code")).toBe(false);
      return;
    }
    const result = execute(control);
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.modulePath).toBe(control.module_key);
    expect(result.js).toBe(control.target.js);
    if (control.target.record_count !== undefined) expect(result.records).toHaveLength(control.target.record_count);
    if (control.target.specifier !== undefined) expect(result.records[0]!.specifier).toBe(control.target.specifier);
    if (control.target.content_span !== undefined) expect([result.records[0]!.content!.start, result.records[0]!.content!.end]).toEqual(control.target.content_span);
    if (control.target.dynamic_status !== undefined) expect(result.records.find((record) => record.dynamicStatus)?.dynamicStatus).toBe(control.target.dynamic_status);
    if (result.changed) {
      expect(result.map!.file).toBe("can:imports:edited");
      expect(result.map!.sources).toEqual(["can:imports:previous"]);
      expect(Object.hasOwn(result.map!, "sourcesContent")).toBe(false);
      expect(Object.hasOwn(result.map!, "rangeMappings")).toBe(false);
    } else {
      expect(Object.hasOwn(result, "map")).toBe(false);
      expect(result.edits).toEqual([]);
    }
  });
});

describe("ECMAScript Unicode whitespace repair", () => {
  for (const whitespace of corpus.unicode_whitespace_inventory) {
    it(`${whitespace.id} recognizes imports and preserves original spans/maps`, () => {
      const unit = whitespace.unit;
      const forms = [
        `${unit}import "bare";`, `import${unit}x from "bare";`,
        `import${unit}("bare");`, `import(${unit}"bare");`,
        `export${unit}{x} from "bare";`, `import/*gap*/${unit}"bare";`,
      ];
      for (const js of forms) {
        const records = scanModuleImports(js, "raw/./main.js");
        expect(records).toHaveLength(1);
        expect(records[0]!.specifier).toBe("bare");
        expect(records[0]!.rawSpecifier).toBe("bare");
        expect(records[0]!.content).toEqual({ start: js.indexOf("bare"), end: js.indexOf("bare") + 4 });
        expect(() => validateArtifactModuleImports([{ path: "raw/./main.js", js }]))
          .toThrow('deploy bundle: module "raw/./main.js" has unresolvable import "bare" (only @canlang/stdlib, @canlang/ui, and relative imports are supported)');
      }
      const js = `${unit}const marker="😀"; import "@canlang/stdlib"; throw new Error("boom");`;
      const result = rewriteModuleImports(js, "raw/./main.js", () => "./longer/vendor/index.js");
      expect(result.js).toBe(`${unit}const marker="😀"; import "./longer/vendor/index.js"; throw new Error("boom");`);
      expect(result.records[0]!.content!.start).toBe(js.indexOf("@canlang/stdlib"));
      const line = whitespace.kind === "LineTerminator" ? 1 : 0;
      const originalColumn = js.indexOf("throw") - (line === 1 ? 1 : 0);
      const editedColumn = result.js.indexOf("throw") - (line === 1 ? 1 : 0);
      expect(decode(result.map!.mappings)[line]!.find((segment) => segment[0] === editedColumn))
        .toEqual([editedColumn, 0, line, originalColumn]);
    });
  }
  for (const control of corpus.unicode_context_controls) it(control.id, () => {
    if (control.id === "unicode-parser-first") {
      expect(() => validateArtifactModuleImports([{ path: control.module_key, js: control.js }]))
        .toThrow('deploy bundle: module "raw/./main.js" has invalid import syntax at offset 32');
      return;
    }
    const records = scanModuleImports(control.js, control.module_key);
    expect(records.map((record) => record.specifier)).toEqual(control.expected_specifiers);
    expect(records.map((record) => record.group)).toEqual(control.expected_groups);
    if (control.id === "unicode-group-order") {
      expect(() => validateArtifactModuleImports([{ path: control.module_key, js: control.js }]))
        .toThrow('deploy bundle: module "raw/./main.js" has unresolvable import "from-bad" (only @canlang/stdlib, @canlang/ui, and relative imports are supported)');
      return;
    }
    validateArtifactModuleImports([
      { path: control.module_key, js: control.js },
      ...control.known_paths.map((path) => ({ path, js: "" })),
    ]);
    const noEdit = rewriteModuleImports(control.js, control.module_key, (specifier) => specifier);
    expect(noEdit.js).toBe(control.js);
    expect(noEdit.changed).toBe(false);
    expect(Object.hasOwn(noEdit, "map")).toBe(false);
    for (const record of records) expect(control.js.slice(record.content!.start, record.content!.end)).toBe(record.rawSpecifier);
  });
  for (const control of corpus.non_whitespace_controls) it(`${control.id} remains a distinct non-whitespace identity`, () => {
    const specifier = `./a${control.unit}b.js`;
    const js = `import(${JSON.stringify(specifier)});`;
    validateArtifactModuleImports([{ path: "main.js", js }, { path: `a${control.unit}b.js`, js: "" }]);
    expect(scanModuleImports(js, "main.js")[0]!.specifier).toBe(specifier);
    // These prefixed snippets are native-invalid, not a JS-validity claim.
    expect(scanModuleImports(`${control.unit}import "bare";`, "main.js")).toEqual([]);
  });
  for (const control of corpus.unicode_runtime_map_controls) it(`runtime line grid: ${control.id}`, () => {
    const result = rewriteModuleImports(control.js, "main.js", () => "./longer/vendor/index.js");
    const position = (js: string) => {
      const lines = js.slice(0, js.indexOf("throw")).split(/\r\n|[\r\n\u2028\u2029]/);
      return { line: lines.length - 1, column: lines[lines.length - 1]!.length };
    };
    const original = position(control.js), edited = position(result.js);
    expect(decode(result.map!.mappings)[edited.line]!.find((segment) => segment[0] === edited.column))
      .toEqual([edited.column, 0, original.line, original.column]);
    expect(result.js).toBe(control.js.replace("@canlang/stdlib", "./longer/vendor/index.js"));
    const noEdit = rewriteModuleImports(control.js, "main.js", (specifier) => specifier);
    expect(noEdit.js).toBe(control.js);
    expect(Object.hasOwn(noEdit, "map")).toBe(false);
  });
});

describe("import leaf negative and span controls", () => {
  it("preserves unchanged escaped identity and raw path without normalization", () => {
    const js = 'import "./\\u0078.js";';
    validateArtifactModuleImports([{ path: "raw/./main.js", js }, { path: "raw/x.js", js: "" }]);
    const result = rewriteModuleImports(js, "raw/./main.js", (specifier) => specifier);
    expect(result.js).toBe(js);
    expect(result.modulePath).toBe("raw/./main.js");
    expect(result.records[0]!.rawSpecifier).toBe("./\\u0078.js");
    expect(result.records[0]!.specifier).toBe("./x.js");
  });
  it("retains options and safely encodes every delimiter control", () => {
    const replacement = "a\\b'\"`\r\n\u2028\u2029${x}";
    for (const delimiter of ["'", '"', "`"] as const) {
      const js = `import(${delimiter}@canlang/stdlib${delimiter}, {with:{type:"json"}});`;
      const result = rewriteModuleImports(js, "main.js", () => replacement);
      expect(result.js.endsWith(', {with:{type:"json"}});')).toBe(true);
      expect(scanModuleImports(result.js, "main.js")[0]!.specifier).toBe(replacement);
    }
  });
  it("uses original UTF16 edits across multiple length-changing replacements", () => {
    const js = 'const x="😀"; import "@canlang/ui"; import("@canlang/stdlib");';
    const result = rewriteModuleImports(js, "main.js", () => "./longer/a.js");
    for (const edit of result.edits) expect(js.slice(edit.start, edit.end)).toBe(edit.specifier);
    expect(result.edits.map((edit) => edit.start)).toEqual([22, 44]);
    expect(result.js).toBe('const x="😀"; import "./longer/a.js"; import("./longer/a.js");');
  });
  it("rejects all phase kinds with approved original-offset envelopes", () => {
    for (const [js, phase] of [
      ['import source x from "./x.js";', "source-static"],
      ['import.source("./x.js");', "source-dynamic"],
      ['import defer * as x from "./x.js";', "defer-static"],
      ['import.defer("./x.js");', "defer-dynamic"],
    ]) expect(() => validateArtifactModuleImports([{ path: "main.js", js: js! }], "assembleModules"))
      .toThrow(`assembleModules: module "main.js" has unsupported import kind "${phase}" at offset 0 (only evaluation-phase imports are supported)`);
  });
  it("rejects bare, URL, backslash and missing relative identities exactly", () => {
    for (const specifier of ["node:fs", "data:x", "https://example/x", "package", "\\x"])
      expect(() => validateArtifactModuleImports([{ path: "main.js", js: `import ${JSON.stringify(specifier)};` }]))
        .toThrow(`deploy bundle: module "main.js" has unresolvable import ${JSON.stringify(specifier)} (only @canlang/stdlib, @canlang/ui, and relative imports are supported)`);
    expect(() => validateArtifactModuleImports([{ path: "main.js", js: 'import "./x.js?q#f";' }, { path: "x.js", js: "" }]))
      .toThrow('deploy bundle: module "main.js" imports "./x.js?q#f" (resolves to "x.js?q#f"): no such artifact module');
  });
  it("observes computed trusted producers without invoking a literal mapper", () => {
    let calls = 0;
    const result = rewriteModuleImports("import(moduleUrl);", "worker/main.js", () => { calls++; return ""; }, { profile: "trusted-producer" });
    expect(calls).toBe(0);
    expect(result.records[0]!.dynamicStatus).toBe("dynamic_unchecked");
    expect(result.js).toBe("import(moduleUrl);");
  });
  it("rewrites an empty literal without losing its delimiters", () => {
    expect(rewriteModuleImports('import("");', "main.js", () => "./x.js").js).toBe('import("./x.js");');
  });
  it("keeps lone surrogates in JSON diagnostic identities", () => {
    expect(() => validateArtifactModuleImports([{ path: "\ud800.js", js: 'import "bad";' }]))
      .toThrow('deploy bundle: module "\\ud800.js" has unresolvable import "bad" (only @canlang/stdlib, @canlang/ui, and relative imports are supported)');
  });
  it("maps an unchanged same-line throw back through a length-changing edit", () => {
    const js = 'import x from "@canlang/stdlib"; throw new Error("boom");';
    const result = rewriteModuleImports(js, "raw/./main.js", () => "./a/much/longer/vendor/index.js", {
      previousStageId: "opaque:before", editedStageId: "opaque:after",
    });
    const segments = decode(result.map!.mappings)[0]!;
    expect(segments.find((segment) => segment[0] === result.js.indexOf("throw")))
      .toEqual([result.js.indexOf("throw"), 0, 0, js.indexOf("throw")]);
    expect(result.map!.sources).toEqual(["opaque:before"]);
    expect(result.map!.file).toBe("opaque:after");
  });
});
