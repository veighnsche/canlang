import { performance } from "node:perf_hooks";

/** Cooperative ownership for one normal local CLI command. */
export interface LocalCommandLifetime {
  readonly signal: AbortSignal;
  checkpoint(stage: string): void;
  remainingMs(stageLimitMs: number): number;
  dispose(): void;
}

export interface LocalCommandFailureContext {
  readonly wrote: boolean;
  readonly files: readonly string[];
  readonly applied: false;
  readonly applyStatus: number | null;
  readonly applyDetail: string;
  readonly manualApply: string;
  readonly detail: string;
}

export class LocalCommandInterrupted extends Error {
  /** Added only by the owned prepared-deploy boundary after side effects. */
  failureContext?: Readonly<LocalCommandFailureContext>;
  constructor(
    readonly command: string,
    readonly code: "command-timeout" | "command-cancelled",
  ) {
    super(`${command} command ${code === "command-timeout" ? "timed out" : "was cancelled"}`);
    this.name = "LocalCommandInterrupted";
  }
}

export function createLocalCommandLifetime(
  command: string,
  budgetMs: number,
  now: () => number = () => performance.now(),
): LocalCommandLifetime {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error("command budget must be finite and positive");
  const controller = new AbortController();
  const startedAt = now();
  const interrupt = (code: LocalCommandInterrupted["code"]): void => {
    if (!controller.signal.aborted) controller.abort(new LocalCommandInterrupted(command, code));
  };
  const cancel = (): void => interrupt("command-cancelled");
  const timer = setTimeout(() => interrupt("command-timeout"), budgetMs);
  timer.unref();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  let disposed = false;
  const checkpoint = (_stage: string): void => {
    if (now() - startedAt >= budgetMs) interrupt("command-timeout");
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  return {
    signal: controller.signal,
    checkpoint,
    remainingMs(stageLimitMs) {
      if (!Number.isFinite(stageLimitMs) || stageLimitMs <= 0) throw new Error("stage limit must be finite and positive");
      checkpoint("stage budget");
      const remaining = budgetMs - (now() - startedAt);
      if (remaining <= 0) {
        interrupt("command-timeout");
        throw controller.signal.reason;
      }
      return Math.min(stageLimitMs, Math.ceil(remaining));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    },
  };
}
