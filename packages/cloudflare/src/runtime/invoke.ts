/**
 * B1 op-execution path: invoke one callable from an assembled artifact.
 *
 * Coordinator decision R1 (recorded): invoke calls emitted handlers
 * DIRECTLY (their inlined by/guard admission runs for real); parity with
 * a canonical-invoke() entrypoint is a follow-up, not done here.
 *
 * `ctx` is the real `./context.js` shape, passed through untouched as
 * the first handler argument; this module never inspects it.
 */
import type { CompileArtifact, OccurrenceId } from "@canlang/contracts";
import type { HandlerContext } from "./context.js";
import type { AssembledModules } from "./modules.js";
import type { MappedPosition } from "./sourcemap.js";
import { lookup } from "./sourcemap.js";

export type { AssembledModules } from "./modules.js";
export type { HandlerContext } from "./context.js";
export type { MappedPosition } from "./sourcemap.js";

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

function message(error: unknown): string {
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
function collectSources(artifact: CompileArtifact): string[] {
  const out: string[] = [];
  for (const mod of artifact.modules) {
    const sources: unknown = mod.map?.sources;
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
function mapThrownError(
  error: unknown,
  artifact: CompileArtifact,
  asm: AssembledModules,
): MappedPosition | undefined {
  try {
    if (!(error instanceof Error) || typeof error.stack !== "string") return undefined;
    const { exact, suffixes } = buildModuleMatchers(asm.moduleUrls);
    const sources = collectSources(artifact).sort((a, b) => b.length - a.length);
    for (const frame of parseStackFrames(error.stack)) {
      const module = matchGeneratedModule(frame.file, exact, suffixes);
      if (module !== null) {
        const mod = artifact.modules.find((entry) => entry.path === module);
        if (mod === undefined) return undefined;
        // V8 columns are 1-based; `lookup` takes a 0-based generated column.
        return lookup(mod.map, frame.line, frame.column - 1) ?? undefined;
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

/** Shared registry resolution + `fn(ctx, ...args)` call behind both public entries. */
async function invokeWith(
  asm: AssembledModules,
  artifact: CompileArtifact,
  id: string,
  ctx: HandlerContext,
  args?: unknown[],
): Promise<InvokeResult> {
  const callable = artifact.callables.find((entry) => entry.id === id);
  if (callable === undefined) {
    const available = artifact.callables.map((entry) => entry.id);
    return {
      ok: false,
      error:
        `unknown callable ${JSON.stringify(id)} ` +
        `(available: ${available.length > 0 ? available.join(", ") : "none"})`,
    };
  }
  const moduleUrl = asm.moduleUrls[callable.module];
  if (moduleUrl === undefined) {
    return {
      ok: false,
      error:
        `no assembled module URL for callable ${JSON.stringify(id)} ` +
        `module ${JSON.stringify(callable.module)}`,
    };
  }
  let mod: Record<string, unknown>;
  try {
    mod = (await import(moduleUrl)) as Record<string, unknown>;
  } catch (error) {
    return {
      ok: false,
      error:
        `cannot import module ${JSON.stringify(callable.module)} ` +
        `for callable ${JSON.stringify(id)}: ${message(error)}`,
    };
  }
  const member: unknown = callable.member;
  if (
    !Array.isArray(member) ||
    member.length === 0 ||
    !member.every((segment) => typeof segment === "string" && segment.length > 0)
  ) {
    return {
      ok: false,
      error:
        `callable ${JSON.stringify(id)} has no valid registry member path ` +
        `(member must be a non-empty array of non-empty strings); ` +
        "recompile with the fixed `can compile`",
    };
  }
  const segments = member as string[];
  const path = JSON.stringify(segments);
  const canApp: unknown = mod["canApp"];
  if (typeof canApp !== "function") {
    return {
      ok: false,
      error:
        `module ${JSON.stringify(callable.module)} has no canApp() registry ` +
        `for callable ${JSON.stringify(id)} (member path ${path})`,
    };
  }
  let current: unknown;
  try {
    current = (canApp as () => unknown)();
  } catch (error) {
    return {
      ok: false,
      error:
        `module ${JSON.stringify(callable.module)} canApp() threw ` +
        `for callable ${JSON.stringify(id)} (member path ${path}): ${message(error)}`,
    };
  }
  for (const [index, segment] of segments.entries()) {
    if (typeof current !== "object" || current === null) {
      const parent = index === 0 ? "canApp() registry" : `segment ${index - 1} value`;
      const actual = current === null ? "null" : typeof current;
      return {
        ok: false,
        error:
          `callable ${JSON.stringify(id)} member path ${path}: ` +
          `cannot resolve segment ${index} ${JSON.stringify(segment)} ` +
          `(${parent} is ${actual}, not an object)`,
      };
    }
    const next: unknown = (current as Record<string, unknown>)[segment];
    if (next === undefined) {
      return {
        ok: false,
        error:
          `callable ${JSON.stringify(id)} member path ${path}: ` +
          `missing segment ${index} ${JSON.stringify(segment)}`,
      };
    }
    const last = index === segments.length - 1;
    if (last && typeof next !== "function") {
      const actual = next === null ? "null" : typeof next;
      return {
        ok: false,
        error:
          `callable ${JSON.stringify(id)} member path ${path}: ` +
          `segment ${index} ${JSON.stringify(segment)} is ${actual}, not a function`,
      };
    }
    current = next;
  }
  const fn = current as (ctx: HandlerContext, ...args: unknown[]) => unknown;
  try {
    const value = await fn(ctx, ...(args ?? []));
    return { ok: true, value };
  } catch (error) {
    const mapped = mapThrownError(error, artifact, asm);
    return mapped === undefined
      ? { ok: false, error: message(error) }
      : { ok: false, error: message(error), mapped };
  }
}

/**
 * Runtime-stamped origin occurrence carried on an occurrence-aware context.
 * `null` marks a direct business-operation call (no occurrence); any other
 * value must be the non-empty id of the admitted occurrence being executed
 * (L3 S9b addendum: runtime-stamped, null direct).
 */
export interface OccurrenceScope {
  readonly originOccurrence: OccurrenceId | null;
}

/**
 * Handler context carrying the runtime stamp. Structural extension only —
 * `./context.js` is untouched; executors build this via
 * `./executors.js` `withOriginOccurrence`.
 */
export type OccurrenceContext = HandlerContext & OccurrenceScope;

/**
 * Invoke callable `id` as `fn(ctx, ...args)` where `fn` is resolved through
 * the module's `canApp()` registry object (DESIGN §13): import the
 * callable's module, call its `canApp()` export once, then walk the
 * callable's `member` path segments into the returned registry and require
 * a function at the end. Module `export` bindings are identity consts
 * (strings), never implementations — there is deliberately NO fallback to
 * `mod[export]`. Never throws: every resolution and handler failure is
 * returned as `{ ok: false, error }`, naming the callable id, the full
 * member path, and which segment failed.
 */
export async function invokeCallable(
  asm: AssembledModules,
  artifact: CompileArtifact,
  id: string,
  ctx: HandlerContext,
  args?: unknown[],
): Promise<InvokeResult> {
  return invokeWith(asm, artifact, id, ctx, args);
}

/**
 * Occurrence-aware entry used by `./executors.js`: validates the
 * `originOccurrence` stamp, then invokes exactly like `invokeCallable`
 * (same registry resolution, same `fn(ctx, ...args)` call, same
 * never-throws contract). The stamp reaches the fenced commit through the
 * dispatch-producing store the executors install on `ctx`.
 */
export async function invokeCallableInOccurrence(
  asm: AssembledModules,
  artifact: CompileArtifact,
  id: string,
  ctx: OccurrenceContext,
  args?: unknown[],
): Promise<InvokeResult> {
  const origin: unknown = ctx.originOccurrence;
  if (origin !== null && (typeof origin !== "string" || origin.length === 0)) {
    return {
      ok: false,
      error:
        `callable ${JSON.stringify(id)} has no valid originOccurrence ` +
        `(must be null or a non-empty string); ` +
        `occurrence executions must thread the runtime stamp`,
    };
  }
  return invokeWith(asm, artifact, id, ctx, args);
}
