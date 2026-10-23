import type { CompileArtifact } from "@canlang/contracts";
import type { AssembledModules } from "./modules.js";
import type { MappedPosition } from "./sourcemap.js";
import { lookup } from "./sourcemap.js";


export interface InvokeResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  /**
   * B3 I2: 1-based `.can` position the throwing frame maps to, attached
   * only when the top assembled frame resolves through the artifact map.
   * Absent on success, on resolution failures, and whenever the frame is
   * unmapped — existing message-only assertions are unaffected.
   */
  mapped?: MappedPosition;
}


export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


/** One parsed stack frame pointing into an assembled module. */
export interface AssembledFrame {
  /** Artifact module path (key into `moduleUrls`). */
  module: string;
  /** 1-based generated line. */
  line: number;
  /** 1-based generated column (V8 convention). */
  column: number;
}


const PAREN_FRAME_RE = /^\s*at (?:async )?[^()]*\((.*):(\d+):(\d+)\)\s*$/;

const BARE_FRAME_RE = /^\s*at (?:async )?(.*):(\d+):(\d+)\s*$/;


/** `file://` URL to decoded path, or `null` for non-file URLs. */
function urlToPath(url: string): string | null {
  if (!url.startsWith("file://")) return null;
  const path = url.slice("file://".length);
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}


interface ParsedFrame {
  file: string;
  line: number;
  column: number;
}


/** Top-down `file:line:col` frames; greedy from the line end so URLs with parens/colons parse. */
function parseStackFrames(stack: string): ParsedFrame[] {
  const frames: ParsedFrame[] = [];
  for (const line of stack.split("\n")) {
    const match = PAREN_FRAME_RE.exec(line) ?? BARE_FRAME_RE.exec(line);
    if (match === null) continue;
    const [, file, lineText, colText] = match;
    if (file === undefined || lineText === undefined || colText === undefined) continue;
    const parsedLine = Number.parseInt(lineText, 10);
    const parsedCol = Number.parseInt(colText, 10);
    if (!Number.isInteger(parsedLine) || parsedLine < 1) continue;
    if (!Number.isInteger(parsedCol) || parsedCol < 1) continue;
    frames.push({ file, line: parsedLine, column: parsedCol });
  }
  return frames;
}


/** Per-frame generated-module matcher: exact URL/path first, then longest `/<module>` suffix. */
function matchGeneratedModule(
  file: string,
  exact: ReadonlyMap<string, string>,
  suffixes: readonly { module: string; suffix: string }[],
): string | null {
  const direct = exact.get(file);
  if (direct !== undefined) return direct;
  const normalized = file.replace(/\\/g, "/");
  for (const { module, suffix } of suffixes) {
    if (normalized === module || normalized.endsWith(suffix)) return module;
  }
  return null;
}


function buildModuleMatchers(moduleUrls: Readonly<Record<string, string>>): {
  exact: Map<string, string>;
  suffixes: { module: string; suffix: string }[];
} {
  const exact = new Map<string, string>();
  const suffixes: { module: string; suffix: string }[] = [];
  for (const [module, url] of Object.entries(moduleUrls)) {
    exact.set(url, module);
    const path = urlToPath(url);
    if (path !== null) exact.set(path, module);
    suffixes.push({ module, suffix: `/${module}` });
  }
  suffixes.sort((a, b) => b.suffix.length - a.suffix.length);
  return { exact, suffixes };
}


/**
 * B3 I2: return the topmost stack frame pointing into an assembled module,
 * or `null` when no frame resolves. Each frame matches by exact module URL
 * (or its decoded `file://` path — V8 prints either form) or, failing
 * that, by longest `/<module path>` suffix, which covers realpath/symlink
 * divergence between the staged URL and the printed frame (e.g. macOS
 * `/tmp` vs `/private/tmp`). Pure and total: never throws.
 */
export function findAssembledFrame(
  stack: string,
  moduleUrls: Readonly<Record<string, string>>,
): AssembledFrame | null {
  const { exact, suffixes } = buildModuleMatchers(moduleUrls);
  for (const frame of parseStackFrames(stack)) {
    const module = matchGeneratedModule(frame.file, exact, suffixes);
    if (module !== null) return { module, line: frame.line, column: frame.column };
  }
  return null;
}


/**
 * B3 I2: return the already-mapped position from the topmost frame the
 * runtime remapped through a staged map (Node with source-map support
 * rewrites the frame file to the map's `sources` entry), or `null` when no
 * frame points into a known source. The frame's 1-based line/column are the
 * `.can` position directly. Pure and total: never throws.
 */
export function findRemappedFrame(
  stack: string,
  sources: readonly string[],
): MappedPosition | null {
  const ordered = sources.filter((source) => source.length > 0).sort((a, b) => b.length - a.length);
  for (const frame of parseStackFrames(stack)) {
    const normalized = frame.file.replace(/\\/g, "/");
    for (const source of ordered) {
      if (normalized === source || normalized.endsWith(`/${source}`)) {
        return { source, line: frame.line, column: frame.column };
      }
    }
  }
  return null;
}


/** Every map `sources` entry across artifact modules (flat; positions are source-global). */
function collectSources(artifact: CompileArtifact, asm: AssembledModules): string[] {
  const out: string[] = [];
  for (const mod of artifact.modules) {
    const map = asm.sourceMaps !== undefined && Object.hasOwn(asm.sourceMaps, mod.path) ? asm.sourceMaps[mod.path] : mod.map;
    const sources: unknown = map?.sources;
    if (!Array.isArray(sources)) continue;
    for (const source of sources) {
      if (typeof source === "string" && source.length > 0) out.push(source);
    }
  }
  return out;
}


/**
 * B3 I2: map a handler throw to its `.can` position, or `undefined` when
 * anything is missing (no stack, no assembled frame, unknown module,
 * unmapped position, malformed map). Single top-down scan: the first frame
 * classifying as a generated module frame resolves through that module's
 * map via `lookup` (V8 columns are 1-based; `lookup` takes 0-based); the
 * first frame classifying as a runtime-remapped source frame carries the
 * 1-based `.can` position directly. Never throws: mapping is diagnostic
 * only and must not break invoke's never-throws contract.
 */
export function mapThrownError(
  error: unknown,
  artifact: CompileArtifact,
  asm: AssembledModules,
): MappedPosition | undefined {
  try {
    if (!(error instanceof Error) || typeof error.stack !== "string") return undefined;
    const { exact, suffixes } = buildModuleMatchers(asm.moduleUrls);
    const sources = collectSources(artifact, asm).sort((a, b) => b.length - a.length);
    for (const frame of parseStackFrames(error.stack)) {
      const module = matchGeneratedModule(frame.file, exact, suffixes);
      if (module !== null) {
        const mod = artifact.modules.find((entry) => entry.path === module);
        if (mod === undefined) return undefined;
        // V8 columns are 1-based; `lookup` takes a 0-based generated column.
        const map = asm.sourceMaps !== undefined && Object.hasOwn(asm.sourceMaps, module) ? asm.sourceMaps[module] : mod.map;
        return map === undefined ? undefined : lookup(map, frame.line, frame.column - 1) ?? undefined;
      }
      const normalized = frame.file.replace(/\\/g, "/");
      for (const source of sources) {
        if (normalized === source || normalized.endsWith(`/${source}`)) {
          return { source, line: frame.line, column: frame.column };
        }
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
