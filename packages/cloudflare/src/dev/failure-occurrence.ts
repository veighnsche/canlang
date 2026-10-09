/**
 * Bounded `can dev` failure projections from existing owner records.
 *
 * These functions do not diagnose a cause, parse freeform runtime detail, or
 * create a trace. The session owner retains the original record under the
 * returned revision-bound ref. Source text and business values need their
 * own effective-actor admission before any detail is released.
 */
import type {
  BusinessError,
  DiagnosticResult,
  ExampleReport,
  ObservationMismatch,
  ResolvedCaller,
} from "@canlang/contracts";
import { PUBLIC_ERROR_MESSAGES } from "@canlang/interfaces";
import type { MappedPosition } from "../runtime/sourcemap.js";

const REF_PART = /^[A-Za-z0-9_-]{1,64}$/;
const SOURCE_REVISION = /^sha256:[0-9a-f]{64}$/;
const MAX_MESSAGE = 512;
const MAX_MISMATCHES = 3;
const MAX_VALUE_BYTES = 512;

export interface FailureContext {
  session: string;
  revision: string;
  sourceRevision: string;
  /** Captured logical paths for this exact source revision. */
  sourcePaths: readonly string[];
  /** Actual artifact/build identity; required for example and HTTP records. */
  servingBuild?: string;
}

export type FailureAt =
  | { kind: "exact_span"; path: string; sha256: string; start: number; end: number }
  | { kind: "mapped_point"; path: string; line: number; column: number };

export interface FailureOccurrence {
  schema: "can.dev.failure.v1";
  ref: string;
  session: string;
  revision: string;
  source_revision: string;
  serving_build?: string;
  origin: "compiler" | "example" | "http";
  phase: string;
  code?: string;
  summary: string;
  owner_ref: Readonly<Record<string, string | number>>;
  at?: FailureAt;
  evidence: { state: "complete" | "partial"; missing: readonly string[] };
  detail_ref: string;
}

export interface FailureProjection {
  occurrence: FailureOccurrence;
  /** Safe bounded detail; original owner records stay in the session store. */
  detail: Readonly<Record<string, unknown>>;
}

function refPart(value: string, name: string): string {
  if (!REF_PART.test(value)) throw new Error(`${name} needs a bounded ref-safe identity`);
  return value;
}

function base(context: FailureContext, localRef: string, origin: FailureOccurrence["origin"]): Pick<
  FailureOccurrence,
  "schema" | "ref" | "session" | "revision" | "source_revision" | "serving_build" | "origin" | "detail_ref"
> {
  const session = refPart(context.session, "session");
  const revision = refPart(context.revision, "revision");
  if (!SOURCE_REVISION.test(context.sourceRevision)) throw new Error("invalid source revision");
  if (origin !== "compiler" && context.servingBuild === undefined) {
    throw new Error("runtime failure needs an actual serving build");
  }
  if (context.servingBuild !== undefined) refPart(context.servingBuild, "serving build");
  const ref = `${session}/${revision}/${localRef}`;
  return {
    schema: "can.dev.failure.v1",
    ref,
    session,
    revision,
    source_revision: context.sourceRevision,
    ...(context.servingBuild === undefined ? {} : { serving_build: context.servingBuild }),
    origin,
    detail_ref: `${ref}/detail`,
  };
}

function evidence(missing: readonly string[]): FailureOccurrence["evidence"] {
  return { state: missing.length === 0 ? "complete" : "partial", missing: [...new Set(missing)] };
}

function boundedText(value: string): string {
  const printable = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  return printable.length <= MAX_MESSAGE ? printable : `${printable.slice(0, MAX_MESSAGE - 1)}…`;
}

function mappedPoint(value: MappedPosition | undefined, sourcePaths: readonly string[]): FailureAt | undefined {
  if (
    value === undefined ||
    !value.source ||
    !sourcePaths.includes(value.source) ||
    !Number.isSafeInteger(value.line) || value.line < 1 ||
    !Number.isSafeInteger(value.column) || value.column < 1
  ) return undefined;
  return { kind: "mapped_point", path: value.source, line: value.line, column: value.column };
}

/** One compiler diagnostic, keeping exact bytes only when its source entry exists. */
export function projectCompilerFailure(input: {
  context: FailureContext;
  result: DiagnosticResult;
  index: number;
  captureComplete: boolean;
  /** Granted by the owner-only source access check, not by the diagnostic. */
  sourceReadable: boolean;
}): FailureProjection {
  const { context, result, index } = input;
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("invalid diagnostic index");
  const diagnostic = result.diagnostics[index];
  if (diagnostic === undefined) throw new Error("diagnostic index not found");
  const source = result.sources.find((entry) => entry.id === diagnostic.primary.file);
  const span = diagnostic.primary;
  const at: FailureAt | undefined = source !== undefined &&
    context.sourcePaths.includes(source.path) &&
    Number.isSafeInteger(span.start) && span.start >= 0 &&
    Number.isSafeInteger(span.end) && span.end >= span.start
    ? { kind: "exact_span", path: source.path, sha256: source.sha256, start: span.start, end: span.end }
    : undefined;
  const missing = [
    ...(!input.captureComplete ? ["source_closure_unverified"] : []),
    ...(!result.complete ? ["compiler_analysis_incomplete"] : []),
    ...(result.omitted > 0 ? ["diagnostics_omitted"] : []),
    ...(at === undefined ? ["source_span_unavailable"] : []),
    ...(!input.sourceReadable ? ["source_detail_withheld"] : []),
    "causal_trace_unavailable",
  ];
  const occurrence: FailureOccurrence = {
    ...base(context, `d${index}`, "compiler"),
    phase: "analysis",
    code: boundedText(diagnostic.code).slice(0, 32),
    summary: `Compiler reported ${boundedText(diagnostic.code).slice(0, 32)}.`,
    owner_ref: { diagnostic_index: index },
    ...(at === undefined ? {} : { at }),
    evidence: evidence(missing),
  };
  const detail: Record<string, unknown> = {
    ref: occurrence.ref,
    severity: diagnostic.severity,
    diagnostic_code: diagnostic.code,
    analysis_complete: result.complete,
    omitted: result.omitted,
  };
  if (input.sourceReadable) {
    detail["message"] = boundedText(diagnostic.message);
    detail["related"] = diagnostic.related.slice(0, 4).map((item) => ({
      file: item.file, start: item.start, end: item.end, message: boundedText(item.message),
    }));
  }
  return { occurrence, detail };
}

export interface ExampleValueAccess {
  viewer: ResolvedCaller;
  /** The owning policy returns an already authorized, redacted projection. */
  projectMismatch: (
    mismatch: ObservationMismatch,
    viewer: ResolvedCaller,
    effectiveCaller: ResolvedCaller,
  ) => ObservationMismatch | null;
  /** Operation identity is withheld unless the same policy explicitly releases it. */
  projectOperation?: (operation: string, viewer: ResolvedCaller, effectiveCaller: ResolvedCaller) => string | null;
}

/** One failed table row or sequence step from a compiled ExampleReport. */
export function projectExampleFailure(input: {
  context: FailureContext;
  report: ExampleReport;
  /** Must match the retained artifact selected by the session owner. */
  artifactSourceRevision: string;
  runId: string;
  caseIndex: number;
  entryIndex: number;
  mapped?: MappedPosition;
  access?: ExampleValueAccess;
}): FailureProjection {
  const { context, report, caseIndex, entryIndex } = input;
  if (report.artifact.sourceRevision !== input.artifactSourceRevision) {
    throw new Error("example report is not from the retained artifact source revision");
  }
  if (!Number.isSafeInteger(caseIndex) || caseIndex < 0 || !Number.isSafeInteger(entryIndex) || entryIndex < 0) {
    throw new Error("invalid example index");
  }
  const example = report.cases[caseIndex];
  if (example === undefined) throw new Error("example case not found");
  const entry = example.kind === "table" ? example.rows[entryIndex] : example.steps[entryIndex];
  if (entry === undefined) throw new Error("example entry not found");
  if (entry.outcome === "passed") throw new Error("passed example has no failure occurrence");
  const ref = `${refPart(input.runId, "run")}/f${caseIndex}_${entryIndex}`;
  const at = mappedPoint(input.mapped, context.sourcePaths);
  const phase = entry.outcome === "setup-failed" ? "setup" :
    entry.outcome === "unsupported" ? "unsupported" :
    entry.mismatches !== undefined ? "assertion" : "invoke_or_observe";
  const effectiveCaller = entry.caller ?? { account: "unknown", team: null, roles: [], authenticated: false };
  const projected: ObservationMismatch[] = [];
  if (input.access !== undefined && entry.mismatches !== undefined) {
    for (const mismatch of entry.mismatches.slice(0, MAX_MISMATCHES)) {
      try {
        const safe = input.access.projectMismatch(mismatch, input.access.viewer, effectiveCaller);
        if (safe !== null && Buffer.byteLength(JSON.stringify(safe), "utf8") <= MAX_VALUE_BYTES) projected.push(safe);
      } catch {
        // A failed policy projection withholds data; it cannot turn into a leak.
      }
    }
  }
  const missing = [
    ...(at === undefined ? ["structured_example_location_unavailable"] : []),
    "trace_unavailable",
    "runtime_detail_unreleased",
    ...(input.access === undefined ? ["actor_projection_unavailable"] : []),
    ...(entry.mismatches !== undefined && projected.length < entry.mismatches.length ? ["actor_values_withheld"] : []),
    ...(entry.mismatches !== undefined && entry.mismatches.length > MAX_MISMATCHES ? ["mismatch_values_truncated"] : []),
    ...(entry.rejection?.sideEffectsAbsent === true ? [] : ["side_effect_scope_unproven"]),
  ];
  const entryRef = example.kind === "table"
    ? { row_index: example.rows[entryIndex]!.rowIndex }
    : { step_index: example.steps[entryIndex]!.index };
  const occurrence: FailureOccurrence = {
    ...base(context, ref, "example"),
    phase,
    summary: entry.outcome === "setup-failed" ? "Example setup failed." :
      entry.outcome === "unsupported" ? "Example could not run in this profile." :
      phase === "assertion" ? "Example assertion failed." : "Example invocation or observation failed.",
    owner_ref: {
      run_id: input.runId,
      case_index: caseIndex,
      entry_index: entryIndex,
      ...entryRef,
    },
    ...(at === undefined ? {} : { at }),
    evidence: evidence(missing),
  };
  const detail: Record<string, unknown> = {
    ref: occurrence.ref,
    outcome: entry.outcome,
    artifact_digest: report.artifact.digest,
    mismatch_count: entry.mismatches?.length ?? 0,
    ...(entry.rejection?.sideEffectsAbsent === true ? { side_effects_absent: true } : {}),
  };
  if (input.access !== undefined) {
    const operation = input.access.projectOperation?.(example.operation, input.access.viewer, effectiveCaller);
    if (operation) detail["operation"] = boundedText(operation);
  }
  if (projected.length > 0) detail["mismatches"] = projected;
  return { occurrence, detail };
}

/** A business error already emitted by HTTP/MCP; never echoes raw message or conflict values. */
export function projectBusinessRefusal(input: {
  context: FailureContext;
  requestId: string;
  error: BusinessError;
  status: number;
  phase: "admission" | "invoke" | "commit" | "unknown";
  mapped?: MappedPosition;
  /** The owning policy must release operation identity for this effective actor. */
  operationAccess?: {
    viewer: ResolvedCaller;
    effectiveActor: ResolvedCaller | null;
    project: (viewer: ResolvedCaller, effectiveActor: ResolvedCaller | null) => string | null;
  };
}): FailureProjection {
  if (!Number.isInteger(input.status) || input.status < 400 || input.status > 599) {
    throw new Error("business refusal needs a failure HTTP status");
  }
  const requestId = refPart(input.requestId, "request");
  const at = mappedPoint(input.mapped, input.context.sourcePaths);
  let operation: string | null = null;
  try {
    operation = input.operationAccess?.project(input.operationAccess.viewer, input.operationAccess.effectiveActor) ?? null;
  } catch {
    // Authorization lookup failure withholds operation identity.
  }
  const occurrence: FailureOccurrence = {
    ...base(input.context, `${requestId}/f0`, "http"),
    phase: input.phase,
    code: input.error.code,
    summary: PUBLIC_ERROR_MESSAGES[input.error.code],
    owner_ref: { request_id: requestId, status: input.status },
    ...(at === undefined ? {} : { at }),
    evidence: evidence([
      ...(at === undefined ? ["source_mapping_unavailable"] : []),
      "trace_unavailable",
      ...(operation === null ? ["operation_identity_withheld"] : []),
      ...(input.error.code === "delivery_unknown" ? ["external_effect_uncertain"] : []),
    ]),
  };
  return {
    occurrence,
    detail: {
      ref: occurrence.ref,
      status: input.status,
      retryable: input.error.retryable ?? false,
      ...(operation === null ? {} : { operation: boundedText(operation) }),
    },
  };
}
