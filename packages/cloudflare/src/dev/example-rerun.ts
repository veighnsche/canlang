import { createHash, randomUUID } from "node:crypto";
import type { ExampleReport, TableRowResult } from "@canlang/contracts";
import {
  runCompiledExamples,
  type CompiledExampleInput,
  type CompiledExampleResult,
} from "./example-runner.js";

export interface ExampleSelector {
  readonly operation: string;
  readonly rowIndex: number;
}

/** The actual artifact, Worker closure and fixture producers for one check. */
export interface ExampleRerunArtifact {
  readonly revision: string;
  readonly fixtureRecipeId: string;
  readonly runtimeProfileId: string;
  readonly input: Omit<CompiledExampleInput, "selectedRow" | "runId" | "signal">;
}

export interface RetainedExampleRef {
  readonly artifactRef: string;
  readonly revision: string;
  readonly sourceRevision: string;
  readonly artifactDigest: string;
}

/** A receipt result is never called execution replay or a fresh body execution. */
export interface ExampleAttemptResult extends CompiledExampleResult {
  readonly idempotency?: { readonly kind: "saved_outcome"; readonly receiptId?: string };
}

export interface ExampleAttempt {
  readonly runId: string;
  readonly observedAt: string;
  readonly row: TableRowResult;
  readonly idempotency: { readonly kind: "saved_outcome"; readonly receiptId?: string } | { readonly kind: "not_reported" };
}

export interface FailedExampleRef {
  readonly failureRef: string;
  readonly artifact: RetainedExampleRef;
  readonly selector: ExampleSelector;
  readonly original: ExampleAttempt;
}

export interface RerunInputs {
  readonly unchanged: readonly string[];
  readonly changed: readonly string[];
  readonly unknown: readonly string[];
}

export type ExampleRerunResult =
  | {
      readonly ok: true;
      readonly kind: "isolated_example_rerun";
      readonly artifact: RetainedExampleRef;
      readonly selector: ExampleSelector;
      readonly original: ExampleAttempt;
      readonly rerun: ExampleAttempt;
      readonly inputs: RerunInputs;
      readonly replay: { readonly available: false; readonly reason: "no_restore_capsule" };
    }
  | {
      readonly ok: false;
      readonly kind: "rerun_refused";
      readonly code: "failure_unavailable" | "artifact_unavailable" | "resource_unavailable" | "row_unsupported" | "rerun_incomplete";
      readonly detail: string;
      readonly original?: ExampleAttempt;
      readonly rerun?: ExampleAttempt;
      readonly replay: { readonly available: false; readonly reason: "no_restore_capsule" };
    };

interface RetainedArtifact {
  readonly ref: RetainedExampleRef;
  readonly input: Omit<CompiledExampleInput, "selectedRow" | "runId" | "signal">;
  readonly fixtureRecipeId: string;
  readonly runtimeProfileId: string;
  readonly size: number;
  readonly expiresAt: number;
}

interface FailureRecord extends FailedExampleRef {
  readonly expiresAt: number;
}

export interface ExampleRerunPorts {
  /** Must run a selected row through the real adapter with a fresh row scope. */
  readonly runSelected?: (input: CompiledExampleInput) => Promise<ExampleAttemptResult>;
  /** Checks that the pinned fixture/runtime recipe remains usable. */
  readonly resourcesReady: (input: {
    readonly revision: string;
    readonly sourceRevision: string;
    readonly artifactDigest: string;
    readonly fixtureRecipeId: string;
    readonly runtimeProfileId: string;
  }) => Promise<{ readonly available: true; readonly changed?: readonly string[]; readonly unknown?: readonly string[] } |
                 { readonly available: false; readonly reason: string }>;
}

export interface ExampleRerunLimits {
  readonly maxArtifacts?: number;
  readonly maxArtifactBytes?: number;
  readonly maxFailures?: number;
  readonly artifactTtlMs?: number;
  readonly failureTtlMs?: number;
}

export class ExampleRerunError extends Error {
  constructor(readonly code: "invalid_artifact" | "artifact_too_large" | "artifact_unavailable" | "invalid_failure" | "row_unsupported", message: string) {
    super(message);
    this.name = "ExampleRerunError";
  }
}

const replay = Object.freeze({ available: false as const, reason: "no_restore_capsule" as const });

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function oneRow(report: ExampleReport, selector: ExampleSelector): TableRowResult | null {
  const matches = report.cases
    .filter((item): item is Extract<typeof item, { kind: "table" }> => item.kind === "table" && item.operation === selector.operation)
    .flatMap(item => item.rows.filter(row => row.rowIndex === selector.rowIndex));
  return matches.length === 1 ? matches[0]! : null;
}

function singleRowCountsMatch(report: ExampleReport, row: TableRowResult): boolean {
  const counts = {
    passed: row.outcome === "passed" ? 1 : 0,
    failed: row.outcome === "failed" ? 1 : 0,
    setupFailed: row.outcome === "setup-failed" ? 1 : 0,
    unsupported: row.outcome === "unsupported" ? 1 : 0,
  };
  return report.summary.total === 1 && report.summary.passed === counts.passed &&
    report.summary.failed === counts.failed && report.summary.setupFailed === counts.setupFailed &&
    report.summary.unsupported === counts.unsupported;
}

function boundedLabels(values: readonly string[] | undefined): string[] {
  return (values ?? []).slice(0, 8).filter(value => typeof value === "string").map(value => value.slice(0, 64));
}

function attempt(runId: string, result: ExampleAttemptResult, row: TableRowResult): ExampleAttempt {
  return {
    runId,
    observedAt: result.report.finishedAt,
    row: structuredClone(row),
    idempotency: result.idempotency?.kind === "saved_outcome"
      ? { kind: "saved_outcome", ...(result.idempotency.receiptId === undefined ? {} : { receiptId: result.idempotency.receiptId }) }
      : { kind: "not_reported" },
  };
}

function refusal(code: Extract<ExampleRerunResult, { ok: false }>["code"], detail: string,
                 original?: ExampleAttempt, rerun?: ExampleAttempt): ExampleRerunResult {
  return { ok: false, kind: "rerun_refused", code, detail: detail.slice(0, 240),
    ...(original === undefined ? {} : { original: structuredClone(original) }),
    ...(rerun === undefined ? {} : { rerun: structuredClone(rerun) }), replay };
}

function abortError(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error && reason.name === "AbortError"
    ? reason : new DOMException("Example rerun was canceled.", "AbortError");
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

/** A readiness callback may be waiting on I/O; cancellation must release the caller. */
async function awaitAbortable<T>(start: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  assertNotAborted(signal);
  if (signal === undefined) return start();
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => reject(abortError(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      try { Promise.resolve(start()).then(resolve, reject); }
      catch (error) { reject(error); }
    });
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Session-local bounded retention. It pins exact artifact and Worker bytes;
 * generated IDs, fresh D1 and ambient inputs still make this a rerun, not a
 * deterministic replay. The session owner should dispose this with its socket.
 */
export class ExampleRerunCoordinator {
  private readonly artifacts = new Map<string, RetainedArtifact>();
  private readonly failures = new Map<string, FailureRecord>();
  private readonly maxArtifacts: number;
  private readonly maxArtifactBytes: number;
  private readonly maxFailures: number;
  private readonly artifactTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly ports: ExampleRerunPorts;
  private byteCount = 0;
  private closed = false;

  constructor(ports: ExampleRerunPorts, limits: ExampleRerunLimits = {}) {
    if (typeof ports.resourcesReady !== "function") throw new Error("example rerun: resource availability port is required");
    this.ports = ports;
    this.maxArtifacts = positiveInteger(limits.maxArtifacts ?? 8, "maxArtifacts");
    this.maxArtifactBytes = positiveInteger(limits.maxArtifactBytes ?? 64 * 1024 * 1024, "maxArtifactBytes");
    this.maxFailures = positiveInteger(limits.maxFailures ?? 64, "maxFailures");
    this.artifactTtlMs = positiveInteger(limits.artifactTtlMs ?? 30 * 60_000, "artifactTtlMs");
    this.failureTtlMs = positiveInteger(limits.failureTtlMs ?? 60 * 60_000, "failureTtlMs");
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("example rerun: coordinator is closed");
  }

  private prune(now = Date.now()): void {
    for (const [key, item] of this.artifacts) if (item.expiresAt <= now) this.dropArtifact(key);
    for (const [key, item] of this.failures) if (item.expiresAt <= now) this.failures.delete(key);
  }

  private dropArtifact(ref: string): void {
    const item = this.artifacts.get(ref);
    if (item === undefined) return;
    this.byteCount -= item.size;
    this.artifacts.delete(ref);
  }

  retainArtifact(pinned: ExampleRerunArtifact): RetainedExampleRef {
    this.assertOpen();
    this.prune();
    const { input } = pinned;
    if (!pinned.revision || !pinned.fixtureRecipeId || !pinned.runtimeProfileId ||
        !input.sourceRevision || !input.artifactLabel || input.artifactBytes.byteLength === 0 ||
        !input.worker.mainModule || input.worker.modules[input.worker.mainModule] === undefined) {
      throw new ExampleRerunError("invalid_artifact", "rerun artifact or pinned recipe is incomplete");
    }
    const modules = Object.freeze({ ...input.worker.modules });
    const binaries = input.worker.binaryModules === undefined ? undefined : Object.freeze(
      Object.fromEntries(Object.entries(input.worker.binaryModules).map(([name, bytes]) => [name, Uint8Array.from(bytes)])),
    );
    const size = input.artifactBytes.byteLength + Object.entries(modules)
      .reduce((total, [name, source]) => total + Buffer.byteLength(name) + Buffer.byteLength(source), 0) +
      (binaries === undefined ? 0 : Object.entries(binaries)
        .reduce((total, [name, bytes]) => total + Buffer.byteLength(name) + bytes.byteLength, 0));
    if (size > this.maxArtifactBytes) {
      throw new ExampleRerunError("artifact_too_large", "rerun artifact exceeds session retention limit");
    }
    const bytes = Uint8Array.from(input.artifactBytes);
    const ref: RetainedExampleRef = Object.freeze({
      artifactRef: randomUUID(), revision: pinned.revision,
      sourceRevision: input.sourceRevision, artifactDigest: digest(bytes),
    });
    // A request signal and selection/run metadata are never part of an immutable recipe.
    const { signal: _signal, selectedRow: _selectedRow, runId: _runId, ...recipe } =
      input as CompiledExampleInput & { readonly signal?: AbortSignal };
    const retained: RetainedArtifact = {
      ref,
      input: { ...recipe, artifactBytes: bytes,
        worker: { mainModule: input.worker.mainModule, modules,
          ...(binaries === undefined ? {} : { binaryModules: binaries }) } },
      fixtureRecipeId: pinned.fixtureRecipeId,
      runtimeProfileId: pinned.runtimeProfileId,
      size,
      expiresAt: Date.now() + this.artifactTtlMs,
    };
    this.artifacts.set(ref.artifactRef, retained);
    this.byteCount += size;
    while (this.artifacts.size > this.maxArtifacts || this.byteCount > this.maxArtifactBytes) {
      this.dropArtifact(this.artifacts.keys().next().value as string);
    }
    return ref;
  }

  recordFailure(input: {
    readonly artifactRef: string;
    readonly selector: ExampleSelector;
    readonly runId: string;
    readonly result: ExampleAttemptResult;
  }): FailedExampleRef {
    this.assertOpen();
    this.prune();
    const retained = this.artifacts.get(input.artifactRef);
    if (retained === undefined) throw new ExampleRerunError("artifact_unavailable", "exact artifact is no longer retained");
    const { selector, result } = input;
    if (!input.runId || !selector.operation || !Number.isSafeInteger(selector.rowIndex) || selector.rowIndex < 0 ||
        result.report.artifact.digest !== retained.ref.artifactDigest ||
        result.report.artifact.sourceRevision !== retained.ref.sourceRevision ||
        result.executed !== result.report.summary.total || result.executed < 1) {
      throw new ExampleRerunError("invalid_failure", "failure does not identify a row in the retained artifact");
    }
    const row = oneRow(result.report, selector);
    if (row === null) throw new ExampleRerunError("invalid_failure", "failure row is absent or ambiguous");
    if (row.outcome === "unsupported") throw new ExampleRerunError("row_unsupported", "unsupported example row cannot be rerun");
    if (row.outcome !== "failed" && row.outcome !== "setup-failed") {
      throw new ExampleRerunError("invalid_failure", "only failed example rows can be rerun");
    }
    const record: FailureRecord = {
      failureRef: randomUUID(), artifact: retained.ref, selector: structuredClone(selector),
      original: attempt(input.runId, result, row), expiresAt: Date.now() + this.failureTtlMs,
    };
    this.failures.set(record.failureRef, record);
    while (this.failures.size > this.maxFailures) this.failures.delete(this.failures.keys().next().value as string);
    return structuredClone(record);
  }

  async rerun(failureRef: string, signal?: AbortSignal): Promise<ExampleRerunResult> {
    assertNotAborted(signal);
    this.assertOpen();
    this.prune();
    const failure = this.failures.get(failureRef);
    if (failure === undefined) return refusal("failure_unavailable", "failure reference is no longer retained");
    const retained = this.artifacts.get(failure.artifact.artifactRef);
    if (retained === undefined) return refusal("artifact_unavailable", "exact artifact was evicted or expired", failure.original);
    const checkResources = () => awaitAbortable(() => this.ports.resourcesReady({
      revision: retained.ref.revision,
      sourceRevision: retained.ref.sourceRevision,
      artifactDigest: retained.ref.artifactDigest,
      fixtureRecipeId: retained.fixtureRecipeId,
      runtimeProfileId: retained.runtimeProfileId,
    }), signal);
    let available: Awaited<ReturnType<ExampleRerunPorts["resourcesReady"]>>;
    try {
      available = await checkResources();
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError(signal);
      return refusal("resource_unavailable", error instanceof Error ? error.message : String(error), failure.original);
    }
    assertNotAborted(signal);
    if (!available.available) return refusal("resource_unavailable", available.reason, failure.original);

    const runId = randomUUID();
    let result: ExampleAttemptResult;
    try {
      const runSelected = this.ports.runSelected ?? runCompiledExamples;
      // The selected-run producer owns its row scope. Await its abort-aware
      // promise through cleanup before releasing the session's serial queue.
      result = await runSelected({
        ...retained.input,
        artifactBytes: Uint8Array.from(retained.input.artifactBytes),
        worker: { ...retained.input.worker,
          ...(retained.input.worker.binaryModules === undefined ? {} : { binaryModules: Object.fromEntries(
            Object.entries(retained.input.worker.binaryModules).map(([name, bytes]) => [name, Uint8Array.from(bytes)]),
          ) }) },
        selectedRow: failure.selector,
        runId,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError(signal);
      return refusal("rerun_incomplete", error instanceof Error ? error.message : String(error), failure.original);
    }
    assertNotAborted(signal);
    try {
      available = await checkResources();
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError(signal);
      return refusal("resource_unavailable", error instanceof Error ? error.message : String(error), failure.original);
    }
    assertNotAborted(signal);
    if (!available.available) return refusal("resource_unavailable", available.reason, failure.original);
    const row = oneRow(result.report, failure.selector);
    if (result.report.artifact.digest !== retained.ref.artifactDigest ||
        result.report.artifact.sourceRevision !== retained.ref.sourceRevision ||
        result.executed !== 1 || result.report.summary.total !== 1 ||
        result.report.cases.length !== 1 || row === null || !singleRowCountsMatch(result.report, row)) {
      return refusal("rerun_incomplete", "selected run did not return exactly one row for the pinned artifact", failure.original);
    }
    const observed = attempt(runId, result, row);
    if (row.outcome === "unsupported") {
      return refusal("row_unsupported", "selected row is unsupported by the retained runtime", failure.original, observed);
    }
    return {
      ok: true,
      kind: "isolated_example_rerun",
      artifact: retained.ref,
      selector: structuredClone(failure.selector),
      original: structuredClone(failure.original),
      rerun: observed,
      inputs: {
        unchanged: ["artifact_bytes", "source_revision", "worker_modules", "fixture_recipe_id", "runtime_profile_id"],
        changed: ["run_id", "D1_row_scope", "Identity_accounts_and_sessions", ...boundedLabels(available.changed)],
        unknown: ["ambient_time", "generated_random_values", "external_resource_state", ...boundedLabels(available.unknown)],
      },
      replay,
    };
  }

  close(): void {
    this.closed = true;
    this.artifacts.clear();
    this.failures.clear();
    this.byteCount = 0;
  }
}
