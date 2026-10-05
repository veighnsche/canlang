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

export type { AssembledModules } from "./modules.js";
export type { HandlerContext } from "./context.js";

export interface InvokeResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    return { ok: false, error: message(error) };
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
