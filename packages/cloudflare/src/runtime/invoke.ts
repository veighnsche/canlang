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
import type { CompileArtifact } from "@canlang/contracts";
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

/**
 * Invoke callable `id` as `fn(ctx, ...args)` where `fn` is the callable's
 * `export` binding of its assembled module (`"default"` selects the
 * default export). Never throws: import and handler failures are
 * returned as `{ ok: false, error }`.
 */
export async function invokeCallable(
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
  const key = callable.export === "default" ? "default" : callable.export;
  const fn = mod[key];
  if (typeof fn !== "function") {
    const reason =
      fn === undefined
        ? `has no export ${JSON.stringify(key)}`
        : `export ${JSON.stringify(key)} is ${typeof fn}, not a function`;
    return {
      ok: false,
      error:
        `module ${JSON.stringify(callable.module)} ${reason} ` +
        `for callable ${JSON.stringify(id)}`,
    };
  }
  try {
    const value = await (fn as (ctx: HandlerContext, ...args: unknown[]) => unknown)(
      ctx,
      ...(args ?? []),
    );
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}
