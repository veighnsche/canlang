/** Host-only, synchronous import policy and original-coordinate edit adapter. */
import { posix } from "node:path";
import { parse, type ImportSpecifier } from "es-module-lexer/minimal/js";
import MagicString from "magic-string";

export type ImportErrorPrefix = "assembleModules" | "deploy bundle";
export type ImportGroup = "from" | "dynamic" | "side-effect" | "meta";
export type UnsupportedImportPhase = "source-static" | "source-dynamic" | "defer-static" | "defer-dynamic";
export type ModuleImportKind = "evaluation-static" | "reexport" | "literal-dynamic" | "computed-dynamic" | "import-meta" | "unsupported-phase";
export interface ImportSpan { readonly start: number; readonly end: number }
export interface ModuleImport {
  readonly modulePath: string;
  readonly kind: ModuleImportKind;
  readonly lexerKind: number;
  readonly group: ImportGroup;
  readonly statement: ImportSpan;
  readonly argument: ImportSpan;
  readonly literal?: ImportSpan;
  readonly content?: ImportSpan;
  readonly delimiter?: "'" | '"' | "`";
  readonly rawSpecifier?: string;
  readonly specifier?: string;
  readonly phase?: UnsupportedImportPhase;
  /** Computed producer imports are observed, never certified as resolved edges. */
  readonly dynamicStatus?: "dynamic_unchecked";
}
export interface ImportModuleInput { readonly path: string; readonly js: string }
export interface ImportEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
  readonly specifier: string;
  readonly mappedSpecifier: string;
}
export interface ImportTransformMap {
  readonly version: 3;
  readonly file: string;
  readonly sources: readonly string[];
  readonly names: readonly string[];
  readonly mappings: string;
}
export interface ImportRewriteOptions {
  readonly prefix?: ImportErrorPrefix;
  readonly profile?: "artifact" | "trusted-producer";
  readonly previousStageId?: string;
  readonly editedStageId?: string;
}
export interface ImportRewriteResult {
  readonly modulePath: string;
  readonly js: string;
  readonly changed: boolean;
  readonly records: readonly ModuleImport[];
  readonly edits: readonly ImportEdit[];
  /** Newest-to-previous map; absent for exact no-edit pass-through. */
  readonly map?: ImportTransformMap;
}

const PRODUCERS = new Set(["@canlang/stdlib", "@canlang/ui"]);
const GROUP_ORDER: Record<ImportGroup, number> = { from: 0, dynamic: 1, "side-effect": 2, meta: 3 };
const TRIVIA = /^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n\u2028\u2029]*(?:[\r\n\u2028\u2029]|$))*$/;
// The pinned asm lexer recognizes ASCII/NBSP whitespace only. This view keeps
// one original UTF-16 unit per unit; it never becomes emitted JavaScript.
const UNICODE_WHITESPACE = /[\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/g;
const PHASES: Readonly<Record<number, UnsupportedImportPhase>> = {
  4: "source-static", 5: "source-dynamic", 6: "defer-static", 7: "defer-dynamic",
};

export function isRelativeImportSpecifier(specifier: string): boolean {
  return specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
}

function parseOriginalImports(js: string): readonly ImportSpecifier[] {
  let remainingLineSeparators = 0;
  let view = js.replace(UNICODE_WHITESPACE, (unit) => {
    if (unit !== "\u2028" && unit !== "\u2029") return " ";
    remainingLineSeparators++;
    return "\n";
  });
  let imports: readonly ImportSpecifier[];
  for (;;) {
    try {
      [imports] = parse(view);
      break;
    } catch (error) {
      const offset = (error as { idx?: unknown } | null)?.idx;
      // A projected LF inside a quoted string/regex is rejected by the lexer.
      // Let the same lexer identify that position, restore exactly that unit,
      // and retry. Each unit is restored once, bounding retries by the original
      // Unicode line-separator count. Comment boundaries elsewhere remain LF.
      if (remainingLineSeparators === 0 || typeof offset !== "number" || !Number.isInteger(offset) || view[offset] !== "\n" || (js[offset] !== "\u2028" && js[offset] !== "\u2029")) throw error;
      remainingLineSeparators--;
      view = view.slice(0, offset) + js[offset]! + view.slice(offset + 1);
    }
  }
  if (view === js) return imports;
  return imports.map((item) => {
    if (item.n === undefined) return item;
    const start = item.d >= 0 ? item.s : item.s - 1;
    const end = item.d >= 0 ? item.e : item.e + 1;
    const literal = js.slice(start, end);
    if (literal === view.slice(start, end)) return item;
    // Decode the original raw literal with the pinned library, never eval or a
    // local string decoder. Synthetic-prefix offsets translate back directly.
    try {
      const [original] = parse(`import(${literal});`);
      return { ...item, n: original[0]!.n };
    } catch (error) {
      const offset = (error as { idx?: unknown } | null)?.idx;
      if (typeof offset === "number" && Number.isInteger(offset)) Object.assign(error as object, { idx: offset + start - 7 });
      throw error;
    }
  });
}

function normalizedImport(js: string, modulePath: string, item: ImportSpecifier): ModuleImport {
  const dynamic = item.d >= 0;
  const meta = item.t === 3;
  const reexport = js.slice(item.ss, item.ss + 6) === "export";
  const sideEffect = !dynamic && !meta && !reexport && TRIVIA.test(js.slice(item.ss + 6, item.s - 1));
  const phase = PHASES[item.t];
  const literal = item.n === undefined ? undefined : { start: dynamic ? item.s : item.s - 1, end: dynamic ? item.e : item.e + 1 };
  const quote = literal === undefined ? undefined : js[literal.start];
  if (literal !== undefined && (quote !== "'" && quote !== '"' && quote !== "`")) {
    throw new Error("module-imports: lexer returned an invalid literal span");
  }
  const content = literal === undefined ? undefined : { start: literal.start + 1, end: literal.end - 1 };
  return {
    modulePath,
    lexerKind: item.t,
    kind: meta ? "import-meta" : phase !== undefined ? "unsupported-phase" : dynamic ? item.n === undefined ? "computed-dynamic" : "literal-dynamic" : reexport ? "reexport" : "evaluation-static",
    group: meta ? "meta" : dynamic ? "dynamic" : sideEffect ? "side-effect" : "from",
    statement: { start: item.ss, end: item.se },
    argument: { start: item.s, end: item.e },
    ...(literal === undefined ? {} : { literal, content: content!, delimiter: quote as "'" | '"' | "`", rawSpecifier: js.slice(content!.start, content!.end), specifier: item.n! }),
    ...(phase === undefined ? {} : { phase }),
    ...(dynamic && item.n === undefined ? { dynamicStatus: "dynamic_unchecked" as const } : {}),
  };
}

/** All offsets address the original JavaScript UTF-16 string. No init/await. */
export function scanModuleImports(js: string, modulePath: string, prefix: ImportErrorPrefix = "deploy bundle"): readonly ModuleImport[] {
  let imports: readonly ImportSpecifier[];
  try {
    imports = parseOriginalImports(js);
  } catch (error) {
    const offset = (error as { idx?: unknown } | null)?.idx;
    if (typeof offset !== "number" || !Number.isInteger(offset)) throw error;
    throw new Error(`${prefix}: module ${JSON.stringify(modulePath)} has invalid import syntax at offset ${offset}`);
  }
  return imports.map((item) => normalizedImport(js, modulePath, item))
    .sort((a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || a.statement.start - b.statement.start || a.argument.start - b.argument.start);
}

function assertArtifactKind(record: ModuleImport, prefix: ImportErrorPrefix): void {
  if (record.phase !== undefined) {
    throw new Error(`${prefix}: module ${JSON.stringify(record.modulePath)} has unsupported import kind ${JSON.stringify(record.phase)} at offset ${record.statement.start} (only evaluation-phase imports are supported)`);
  }
  if (record.kind === "computed-dynamic") {
    throw new Error(`${prefix}: module ${JSON.stringify(record.modulePath)} has nonliteral dynamic import at offset ${record.statement.start} (only literal dynamic imports are supported)`);
  }
}

/** Preserve module array order; fully parse each module before its policy pass. */
export function validateArtifactModuleImports(modules: readonly ImportModuleInput[], prefix: ImportErrorPrefix = "deploy bundle"): void {
  const known = new Set(modules.map((module) => module.path));
  for (const module of modules) {
    for (const record of scanModuleImports(module.js, module.path, prefix)) {
      assertArtifactKind(record, prefix);
      const specifier = record.specifier;
      if (specifier === undefined || PRODUCERS.has(specifier)) continue;
      if (isRelativeImportSpecifier(specifier)) {
        const target = posix.normalize(posix.join(posix.dirname(module.path), specifier));
        if (!known.has(target)) {
          throw new Error(`${prefix}: module ${JSON.stringify(module.path)} imports ${JSON.stringify(specifier)} (resolves to ${JSON.stringify(target)}): no such artifact module`);
        }
      } else {
        throw new Error(`${prefix}: module ${JSON.stringify(module.path)} has unresolvable import ${JSON.stringify(specifier)} (only @canlang/stdlib, @canlang/ui, and relative imports are supported)`);
      }
    }
  }
}

function escapeSpecifier(value: string, delimiter: "'" | '"' | "`"): string {
  return value.replace(/[\\'"`\r\n\u2028\u2029]|\$\{/g, (part) => {
    if (part === "\\") return "\\\\";
    if (part === "\r") return "\\r";
    if (part === "\n") return "\\n";
    if (part === "\u2028") return "\\u2028";
    if (part === "\u2029") return "\\u2029";
    if (part === delimiter) return `\\${part}`;
    if (part === "${" && delimiter === "`") return "\\${";
    return part;
  });
}

/** Rewrite literal content only, retaining attributes, options, trivia and quotes. */
export function rewriteModuleImports(
  js: string,
  modulePath: string,
  mapSpecifier: (specifier: string, record: ModuleImport) => string,
  options: ImportRewriteOptions = {},
): ImportRewriteResult {
  const prefix = options.prefix ?? "deploy bundle";
  const records = scanModuleImports(js, modulePath, prefix);
  if (options.profile !== "trusted-producer") for (const record of records) assertArtifactKind(record, prefix);
  const edits: ImportEdit[] = [];
  for (const record of records) {
    if (record.specifier === undefined) continue;
    const mapped = mapSpecifier(record.specifier, record);
    if (mapped === record.specifier) continue;
    edits.push({ start: record.content!.start, end: record.content!.end, replacement: escapeSpecifier(mapped, record.delimiter!), specifier: record.specifier, mappedSpecifier: mapped });
  }
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  if (edits.length === 0) return { modulePath, js, changed: false, records, edits };
  const editor = new MagicString(js);
  // MagicString counts LF only. This equal-length map view represents all JS
  // line terminators, without changing emitted text or original UTF-16 spans.
  const mapSource = js.replace(/\r(?!\n)|[\u2028\u2029]/g, "\n");
  const mapEditor = mapSource === js ? editor : new MagicString(mapSource);
  let previousEnd = -1;
  for (const edit of edits) {
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < previousEnd || edit.start < 0 || edit.end < edit.start || edit.end > js.length) {
      throw new Error("module-imports: invalid or overlapping original edit spans");
    }
    if (edit.start === edit.end) {
      editor.appendLeft(edit.start, edit.replacement);
      if (mapEditor !== editor) mapEditor.appendLeft(edit.start, edit.replacement);
    } else {
      editor.overwrite(edit.start, edit.end, edit.replacement);
      if (mapEditor !== editor) mapEditor.overwrite(edit.start, edit.end, edit.replacement);
    }
    previousEnd = edit.end;
  }
  const generated = mapEditor.generateMap({ hires: true, includeContent: false });
  const map: ImportTransformMap = {
    version: 3,
    file: options.editedStageId ?? "can:imports:edited",
    sources: [options.previousStageId ?? "can:imports:previous"],
    names: generated.names,
    mappings: generated.mappings,
  };
  return { modulePath, js: editor.toString(), changed: true, records, edits, map };
}
