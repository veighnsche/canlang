/**
 * First-profile owner service. The socket is control-only; compiler, source
 * capture, and preview behavior stay with their owning producers.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BusinessError, CompileArtifact, Diagnostic, DiagnosticResult, DiagnosticSpan } from "@canlang/contracts";
import { compileCapturedSingleFile } from "./compiler-check.js";
import { joinCompilerConstructCandidates, loadConstructHelpIndex, parseCompilerConstructCandidates,
  type CatalogFact, type CompilerConstructCandidates, type ConstructHelpIndex } from "./construct-help.js";
import { loadInstalledExampleTestkit, runCompiledExamples, type CompiledExampleInput } from "./example-runner.js";
import { ExampleRerunCoordinator, type ExampleRerunResult } from "./example-rerun.js";
import { projectBusinessRefusal, projectCompilerFailure, projectExampleFailure, type FailureProjection } from "./failure-occurrence.js";
import { installedLocalPreviewInputInventory } from "./preview-inputs.js";
import { DevRevisionConflictError, DevSessionCore, type DevCheck, type DevPreview } from "./session-core.js";
import {
  captureSingleFileSource,
  capturedRuntimeInputsAreCurrent,
  type SingleFileCapture,
  type SingleFileCaptureRequest,
} from "./source-capture.js";
import {
  discoverSessionSocket,
  SessionSocketError,
  startSessionSocket,
  type SessionSocketClient,
  type SessionSocketCommand,
  type SessionSocketIdentity,
  type SessionSocketLookup,
  type SessionSocketOwner,
  SESSION_SOCKET_PROTOCOL,
} from "./session-socket.js";

const MAX_DIAGNOSTICS = 256;
const MAX_MESSAGE = 600;
const MAX_REASON = 300;
const MAX_PAGE = 25;

const COMMAND_HELP = [
  { name: "help", required: [], optional: [], output: "can.dev.help.v1", availability: "always" },
  { name: "status", required: [], optional: [], output: "can.dev.status.v1", availability: "always" },
  { name: "check", required: [], optional: [{ name: "expectedRevision", type: "revision" }], output: "can.dev.check.v1", availability: "always" },
  { name: "diagnostics", required: [{ name: "revision", type: "revision" }], optional: [{ name: "after", type: "integer>=-1" }, { name: "limit", type: "integer:1..25" }], output: "can.dev.diagnostics.v1", availability: "captured_revision" },
  { name: "diagnostic.detail", required: [{ name: "revision", type: "revision" }, { name: "index", type: "integer>=0" }], optional: [], output: "can.dev.diagnostic.v1", availability: "captured_revision" },
  { name: "construct.help", required: [{ name: "revision", type: "revision" }, { name: "id", type: "construct_id" }], optional: [], output: "can.dev.construct-help.v1", availability: "captured_revision" },
  { name: "failure.lookup", required: [{ name: "ref", type: "failure_ref" }], optional: [], output: "can.dev.failure.v1", availability: "captured_revision" },
  { name: "failure.detail", required: [{ name: "ref", type: "failure_ref" }], optional: [], output: "can.dev.failure-detail.v1", availability: "captured_revision" },
  { name: "failures", required: [{ name: "revision", type: "revision" }], optional: [{ name: "after", type: "integer>=-1" }, { name: "limit", type: "integer:1..25" }], output: "can.dev.failures.v1", availability: "captured_revision" },
  { name: "preview.status", required: [], optional: [], output: "can.dev.preview.v1", availability: "always" },
  { name: "preview.open", required: [], optional: [], output: "can.dev.preview-open.v1", availability: "serving_preview" },
  { name: "example.run", required: [{ name: "expectedRevision", type: "revision" }], optional: [{ name: "operation", type: "operation" }, { name: "rowIndex", type: "integer>=0" }], output: "can.dev.example-run.v1", availability: "current_verified_artifact" },
  { name: "example.rerun", required: [{ name: "ref", type: "failure_ref" }], optional: [], output: "can.dev.example-rerun.v1", availability: "retained_failed_row" },
  { name: "stop", required: [], optional: [], output: "can.dev.stop.v1", availability: "always" },
] as const;

export interface SessionServicePreview extends DevPreview {
  /** A protected, short-lived bootstrap URL; status never returns it. */
  issueOpenUrl?(): string;
  /** Local-only real Identity fixture credentials, released through owner control. */
  issueLocalActors?(): readonly {
    label: string;
    email: string;
    password: string;
    teams: readonly string[];
  }[];
  /** Exact admitted artifact and verified Worker recipe for isolated rows. */
  exampleInput?(): Omit<CompiledExampleInput, "selectedRow" | "runId" | "testkit">;
  /** Actual bounded business refusal; no request headers, credentials or raw response detail. */
  observeRefusals?(handler: (event: { requestId: string; status: number; error: BusinessError }) => void): () => void;
}

export interface SessionServiceOptions {
  selectedApp: string;
  capture: SingleFileCaptureRequest;
  runtimeDir?: string;
  /** Trusted host builder must admit real bindings and own all runtime cleanup. */
  previewBuilder?: (artifact: CompileArtifact, capture: SingleFileCapture,
    artifactBytes: Uint8Array) => Promise<SessionServicePreview>;
}

export interface SessionServiceOwner {
  readonly identity: SessionSocketIdentity;
  readonly descriptorPath: string;
  status(): SessionServiceStatus;
  check(): Promise<SessionCheckResponse>;
  stop(): Promise<void>;
}

export interface SessionServiceStatus {
  schema: "can.dev.status.v1";
  session: string;
  app: string;
  profile: string;
  revision: string | null;
  source_revision: string | null;
  check_revision: string | null;
  build_revision: string | null;
  serving_revision: string | null;
  serving_build: string | null;
  stale: boolean;
  dirty: boolean;
  preview_reset: boolean;
  capture_error: string | null;
  preview: "ready" | "unavailable";
}

interface CapturedDiagnostic {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  primary: DiagnosticSpan;
  related: Diagnostic["related"];
  tags: string[];
  construct_candidates?: CompilerConstructCandidates;
}

interface SessionCheckDetail {
  kind: "artifact" | "diagnostics" | "profile_unsupported" | "capture_incomplete" | "tool_failure";
  source: { path: string; sha256: string };
  diagnostics: CapturedDiagnostic[];
  reported: number;
  compilerOmitted: number;
  serviceOmitted: number;
  reason: string | null;
  toolVersion: string | null;
  languageVersion: string | null;
  helpIndexRevision: string | null;
}

export interface SessionCheckResponse {
  schema: "can.dev.check.v1";
  session: string;
  revision: string;
  source_revision: string | null;
  current: boolean;
  state: "valid" | "errors" | "limited" | "incomplete" | "unsupported" | "tool_failure" | "superseded";
  evidence: {
    capture_complete: boolean;
    analysis_complete: boolean;
    diagnostics_reported: number;
    diagnostics_omitted: number;
    diagnostics_service_omitted: number;
  };
  focus: null | { ref: string; code: string; severity: string; message: string; at: { path: string; start: number; end: number } };
  next_diagnostics: string | null;
  preview: "ready" | "unavailable" | "build_failed";
  preview_reason: string | null;
  cleanup_warning?: string;
}

function short(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").slice(0, max);
}

/** Runtime values require effective-actor projection; owner control alone cannot release them. */
function safeRerunResult(result: ExampleRerunResult): Record<string, unknown> {
  const attempt = (value: NonNullable<ExampleRerunResult["original"]>) => ({
    run_id: value.runId, observed_at: value.observedAt, outcome: value.row.outcome,
    row_index: value.row.rowIndex, idempotency: value.idempotency.kind,
  });
  return {
    schema: "can.dev.example-rerun.v1", ok: result.ok, kind: result.kind, replay: result.replay,
    ...(result.original === undefined ? {} : { original: attempt(result.original) }),
    ...(result.rerun === undefined ? {} : { rerun: attempt(result.rerun) }),
    ...(result.ok ? { artifact: result.artifact, inputs: result.inputs }
      : { code: result.code, detail: "The retained example rerun could not complete." }),
    evidence: { missing: ["actor_projection_unavailable", "runtime_detail_unreleased", "trace_unavailable"] },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function validSpan(value: unknown, sourceBytes: number): value is DiagnosticSpan {
  const item = record(value);
  return item !== null && item.file === 0 && integer(item.start) && integer(item.end) &&
    item.start <= item.end && item.end <= sourceBytes;
}

function diagnosticsFrom(value: readonly unknown[], sourceBytes: number): CapturedDiagnostic[] | null {
  const diagnostics: CapturedDiagnostic[] = [];
  for (const candidate of value.slice(0, MAX_DIAGNOSTICS)) {
    const item = record(candidate);
    if (
      item === null || typeof item.code !== "string" || typeof item.message !== "string" ||
      (item.severity !== "error" && item.severity !== "warning" && item.severity !== "info") ||
      !validSpan(item.primary, sourceBytes) || !Array.isArray(item.related) || !Array.isArray(item.tags)
    ) return null;
    const related: Diagnostic["related"] = [];
    for (const raw of item.related.slice(0, 8)) {
      if (!validSpan(raw, sourceBytes) || typeof record(raw)?.message !== "string") return null;
      related.push({
        file: raw.file, start: raw.start, end: raw.end,
        message: short(record(raw)!.message as string, MAX_MESSAGE),
      });
    }
    if (!item.tags.every(tag => typeof tag === "string")) return null;
    diagnostics.push({
      code: short(item.code, 40),
      severity: item.severity,
      message: short(item.message, MAX_MESSAGE),
      primary: { file: item.primary.file, start: item.primary.start, end: item.primary.end },
      related,
      tags: item.tags.slice(0, 12).map(tag => short(tag as string, 40)),
      ...(item.construct_candidates === undefined ? {} : {
        construct_candidates: parseCompilerConstructCandidates(item.construct_candidates),
      }),
    });
  }
  return diagnostics;
}

function failureDetail(capture: SingleFileCapture, kind: SessionCheckDetail["kind"], reason: string,
  helpIndexRevision: string | null): SessionCheckDetail {
  return {
    kind,
    source: { path: capture.compilerOperand, sha256: capture.sourceSha256 },
    diagnostics: [], reported: 0, compilerOmitted: 0, serviceOmitted: 0,
    reason: short(reason, MAX_REASON), toolVersion: null, languageVersion: null, helpIndexRevision,
  };
}

function capturedInput(capture: SingleFileCapture, path: string, producer?: RegExp): { sha256: string; canonicalPath: string } {
  const matches = capture.inputs.filter(input => (input.canonicalPath === resolve(capture.root, path) ||
    producer?.test(input.name) === true) &&
    input.state === "present" && typeof input.sha256 === "string");
  const selected = matches.length === 1 ? matches[0] : undefined;
  if (selected === undefined || typeof selected.sha256 !== "string" || selected.canonicalPath === null) {
    throw new Error(`construct help input is absent: ${path}`);
  }
  return { sha256: selected.sha256, canonicalPath: selected.canonicalPath };
}

async function capturedCatalog(capture: SingleFileCapture, path: string, exportName: string,
  producer?: RegExp): Promise<readonly CatalogFact[]> {
  const input = capturedInput(capture, path, producer);
  const hash = async (): Promise<string> => createHash("sha256").update(await readFile(input.canonicalPath)).digest("hex");
  if (await hash() !== input.sha256) throw new Error(`construct help catalog changed after capture: ${path}`);
  const module = await import(`${pathToFileURL(input.canonicalPath).href}?can-dev=${input.sha256}`) as Record<string, unknown>;
  if (await hash() !== input.sha256) throw new Error(`construct help catalog changed during load: ${path}`);
  const entries = record(module[exportName])?.entries;
  if (!Array.isArray(entries)) throw new Error(`construct help catalog export is missing: ${exportName}`);
  return entries as readonly CatalogFact[];
}

async function capturedHelpIndex(capture: SingleFileCapture): Promise<ConstructHelpIndex> {
  const compiler = capture.inputs.find(input => input.name === "compiler" && input.state === "present");
  const help = capture.inputs.find(input => input.name === "help-index" && input.state === "present");
  if (!compiler?.sha256 || !help?.sha256) throw new Error("construct help compiler or document input is missing");
  const grammar = capturedInput(capture, "docs/specification/GRAMMAR.md");
  const values = capturedInput(capture, "packages/values/src/catalog.ts",
    /^extra:source:@canlang\/values@[^/]+\/src\/catalog\.ts$/);
  const ui = capturedInput(capture, "packages/ui/src/catalog.ts",
    /^extra:source:@canlang\/ui@[^/]+\/src\/catalog\.ts$/);
  const [valuesEntries, uiEntries] = await Promise.all([
    capturedCatalog(capture, "packages/values/dist/src/catalog.js", "CATALOG",
      /^package:@canlang\/values@[^/]+\/dist\/src\/catalog\.js$/),
    capturedCatalog(capture, "packages/ui/dist/src/catalog.js", "UI_CATALOG",
      /^package:@canlang\/ui@[^/]+\/dist\/src\/catalog\.js$/),
  ]);
  return loadConstructHelpIndex(capture.root, {
    languageVersion: "1.0", compiler: { sha256: compiler.sha256 }, grammar: { sha256: grammar.sha256 },
    values: { sha256: values.sha256, entries: valuesEntries },
    ui: { sha256: ui.sha256, entries: uiEntries },
  }, help.sha256);
}

function checkState(check: DevCheck<SessionCheckDetail>): SessionCheckResponse["state"] {
  const detail = check.detail;
  if (detail.kind === "artifact") return "valid";
  if (detail.kind === "profile_unsupported") return "unsupported";
  if (detail.kind === "capture_incomplete") return "incomplete";
  if (detail.kind === "tool_failure") return "tool_failure";
  if (!check.complete) return "incomplete";
  if (detail.compilerOmitted > 0 || detail.serviceOmitted > 0) return "limited";
  return "errors";
}

function selectedAppName(source: string): string | null {
  const declaration = source.split(/\r?\n/).map(line => line.trimStart())
    .find(line => /^app\s+/.test(line));
  return declaration?.match(/^app\s+([A-Za-z_][A-Za-z0-9_]*)\b/)?.[1] ?? null;
}

async function watchDirectories(request: SingleFileCaptureRequest, capture: SingleFileCapture | null): Promise<string[]> {
  const root = resolve(request.checkoutRoot);
  const paths = [
    root, resolve(root, request.appPath), resolve(root, request.compilerPath),
    resolve(root, request.helpIndexPath),
    ...(request.catalogPath === null ? [] : [resolve(root, request.catalogPath)]),
    ...request.packageInputPaths.map(input => resolve(root, input.path)),
    ...(request.extraInputPaths ?? []).map(input => resolve(root, input.path)),
    ...(capture === null ? [] : [capture.appPath, ...capture.inputs.flatMap(input =>
      input.canonicalPath === null ? [] : [input.canonicalPath])]),
  ];
  const directories = new Set<string>();
  for (const path of paths) {
    const directory = path === root ? root : dirname(path);
    try {
      if ((await stat(directory)).isDirectory()) directories.add(directory);
    } catch {
      // An explicit check recaptures missing inputs even without a watcher.
    }
  }
  return [...directories];
}

function diagnosticRef(session: string, revision: string, index: number): string {
  return `${session}/${revision}/d${index}`;
}

function checkResponse(
  session: string,
  core: DevSessionCore<SessionCheckDetail, SessionServicePreview>,
  publication: Awaited<ReturnType<DevSessionCore<SessionCheckDetail, SessionServicePreview>["check"]>>,
  hasBuilder: boolean,
): SessionCheckResponse {
  const status = core.status();
  const current = status.revision === publication.revision && !status.dirty;
  const empty = {
    schema: "can.dev.check.v1" as const,
    session, revision: publication.revision,
    source_revision: status.sourceRevision,
    current,
    evidence: {
      capture_complete: false, analysis_complete: false,
      diagnostics_reported: 0, diagnostics_omitted: 0, diagnostics_service_omitted: 0,
    },
    focus: null,
    next_diagnostics: null,
    preview: "unavailable" as const,
    preview_reason: null,
  };
  if (publication.kind === "capture_incomplete") {
    return { ...empty, state: "incomplete", current: false, preview_reason: "capture_incomplete" };
  }
  if (publication.kind === "superseded") {
    return { ...empty, state: "superseded", source_revision: publication.sourceRevision,
      current: false, preview_reason: "superseded" };
  }
  const check = publication.check;
  const detail = check.detail;
  const captured = core.detail(publication.revision);
  const focus = detail.diagnostics[0];
  const preview = publication.kind === "checked" && publication.preview === "ready"
    ? "ready" as const
    : publication.kind === "build_failed" && hasBuilder
      ? "build_failed" as const
      : "unavailable" as const;
  return {
    ...empty,
    source_revision: "error" in captured ? status.sourceRevision : captured.sourceRevision,
    state: checkState(check),
    evidence: {
      capture_complete: detail.kind !== "capture_incomplete",
      analysis_complete: check.complete,
      diagnostics_reported: detail.reported,
      diagnostics_omitted: detail.compilerOmitted,
      diagnostics_service_omitted: detail.serviceOmitted,
    },
    focus: focus === undefined ? null : {
      ref: diagnosticRef(session, publication.revision, 0),
      code: focus.code, severity: focus.severity,
      message: short(focus.message, 180),
      at: { path: detail.source.path, start: focus.primary.start, end: focus.primary.end },
    },
    next_diagnostics: detail.diagnostics.length > 1
      ? `${session}/${publication.revision}/diagnostics?after=0` : null,
    preview,
    preview_reason: publication.kind === "build_failed"
      ? (hasBuilder ? "preview_build_failed" : "preview_builder_unavailable")
      : !check.passed ? "check_not_passed" : null,
    ...(publication.kind === "checked" && publication.cleanupError !== undefined
      ? { cleanup_warning: "PREVIOUS_PREVIEW_DISPOSE_FAILED" } : {}),
  };
}

/** Start one owner with actual captured inputs and a private control socket. */
export async function startDevSessionService(options: SessionServiceOptions): Promise<SessionServiceOwner> {
  if (!options.selectedApp) throw new SessionSocketError("INVALID_SELECTION", "selected app is required");
  const captures = new Map<string, SingleFileCapture>();
  const helpByDigest = new Map<string, ConstructHelpIndex>();
  const checkedHelp = new Map<string, ConstructHelpIndex>();
  const artifacts = new Map<string, { artifact: CompileArtifact; bytes: Uint8Array }>();
  const previews = new Map<string, SessionServicePreview>();
  const exampleFailures = new Map<string, { projection: FailureProjection; cursor: number; rerunRef?: string }>();
  let failureCursor = 0;
  const exampleCaptures = new Map<string, SingleFileCapture>();
  let exampleQueue: Promise<unknown> = Promise.resolve();
  const reruns = new ExampleRerunCoordinator({
    resourcesReady: async ({ fixtureRecipeId }) => {
      const captured = exampleCaptures.get(fixtureRecipeId);
      return captured !== undefined && await capturedRuntimeInputsAreCurrent(captured)
        ? { available: true } : { available: false, reason: "retained runtime inputs changed or were evicted" };
    },
  });
  let latestCapture: SingleFileCapture | null = null;
  let sessionProducerIdentity: string | null = null;
  const core = new DevSessionCore<SessionCheckDetail, SessionServicePreview>({
    async capture() {
      const request = options.capture.inputInventory === "installed-local-preview"
        ? { ...options.capture, ...installedLocalPreviewInputInventory(options.capture.checkoutRoot, options.capture.compilerPath) }
        : options.capture;
      const captured = await captureSingleFileSource(request);
      // Node retains the service and Testkit's transitive imports for this
      // process. A newly admitted package hash cannot reload that graph.
      const producerIdentity = createHash("sha256").update(JSON.stringify(captured.inputs
        .filter(input => input.name.startsWith("package:"))
        .map(input => [input.name, input.canonicalPath, input.sha256]))).digest("hex");
      if (sessionProducerIdentity !== null && sessionProducerIdentity !== producerIdentity) {
        throw new Error("installed runtime producer changed; stop and restart this session to consume its new modules");
      }
      sessionProducerIdentity = producerIdentity;
      let help = helpByDigest.get(captured.epochMaterial);
      if (help === undefined && captured.inputs.some(input => input.name === "extra:grammar" && input.state === "present")) {
        help = await capturedHelpIndex(captured);
        helpByDigest.set(captured.epochMaterial, help);
      }
      latestCapture = captured;
      core.watchDirectories(await watchDirectories(request, captured));
      captures.set(captured.epochMaterial, captured);
      while (captures.size > 4) {
        const oldest = captures.keys().next().value!;
        captures.delete(oldest);
        helpByDigest.delete(oldest);
      }
      return { sourceRevision: captured.sourceRevision, inputDigest: captured.epochMaterial };
    },
    async check(inputs) {
      const captured = captures.get(inputs.inputDigest);
      const helpIndexRevision = helpByDigest.get(inputs.inputDigest)?.revision ?? null;
      if (captured === undefined) {
        const source = latestCapture;
        if (source === null) throw new SessionSocketError("CAPTURE_INCOMPLETE", "captured input was not retained");
        return { complete: false, passed: false, detail: failureDetail(source, "capture_incomplete", "captured input was not retained", helpIndexRevision) };
      }
      if (selectedAppName(captured.sourceText) !== options.selectedApp) {
        return { complete: false, passed: false, detail: failureDetail(captured, "profile_unsupported", "selected app does not match source app declaration", helpIndexRevision) };
      }
      try {
        const result = await compileCapturedSingleFile(captured);
        if (result.kind === "artifact") {
          artifacts.set(inputs.inputDigest, { artifact: result.artifact, bytes: result.artifactBytes });
          return {
            complete: true, passed: true,
            detail: {
              kind: "artifact" as const,
              source: { path: captured.compilerOperand, sha256: captured.sourceSha256 },
              diagnostics: [], reported: 0, compilerOmitted: 0, serviceOmitted: 0,
              reason: null, toolVersion: result.artifact.tool_version,
              languageVersion: result.artifact.language_version, helpIndexRevision,
            },
          };
        }
        if (result.kind !== "diagnostics") {
          return { complete: false, passed: false, detail: failureDetail(captured, result.kind, result.reason, helpIndexRevision) };
        }
        const envelope = result.envelope as typeof result.envelope & { omitted?: unknown; tool_version?: unknown; language_version?: unknown };
        const diagnostics = diagnosticsFrom(envelope.diagnostics, captured.sourceBytes);
        if (diagnostics === null || !integer(envelope.omitted)) {
          return { complete: false, passed: false, detail: failureDetail(captured, "tool_failure", "compiler diagnostic envelope has invalid fields", helpIndexRevision) };
        }
        return {
          complete: true, passed: false,
          detail: {
            kind: "diagnostics", source: { path: captured.compilerOperand, sha256: captured.sourceSha256 },
            diagnostics, reported: envelope.diagnostics.length,
            compilerOmitted: envelope.omitted,
            serviceOmitted: Math.max(0, envelope.diagnostics.length - diagnostics.length),
            reason: null,
            toolVersion: typeof envelope.tool_version === "string" ? short(envelope.tool_version, 80) : null,
            languageVersion: typeof envelope.language_version === "string" ? short(envelope.language_version, 80) : null,
            helpIndexRevision,
          },
        };
      } catch (error) {
        return { complete: false, passed: false, detail: failureDetail(captured, "tool_failure", error instanceof Error ? error.message : String(error), helpIndexRevision) };
      }
    },
    async preparePreview(inputs) {
      const captured = captures.get(inputs.inputDigest);
      const selected = artifacts.get(inputs.inputDigest);
      artifacts.delete(inputs.inputDigest);
      if (options.previewBuilder === undefined) {
        throw new SessionSocketError("PREVIEW_UNAVAILABLE", "preview builder is not configured");
      }
      if (captured === undefined || selected === undefined) {
        throw new SessionSocketError("PREVIEW_UNAVAILABLE", "verified artifact is unavailable");
      }
      const buildRevision = core.status().revision!;
      const preview = await options.previewBuilder(selected.artifact, captured, selected.bytes);
      if (!preview || typeof preview.id !== "string" || preview.id.length === 0 || typeof preview.dispose !== "function") {
        throw new SessionSocketError("PREVIEW_UNAVAILABLE", "preview builder returned no disposable build");
      }
      if (previews.has(preview.id)) {
        await preview.dispose();
        throw new SessionSocketError("PREVIEW_UNAVAILABLE", "preview builder reused a live build identity");
      }
      const unobserve = preview.observeRefusals?.(event => {
        if (core.status().servingBuild !== preview.id || stopping !== null) return;
        const projection = projectBusinessRefusal({ context: {
          session: socket!.identity.sessionId, revision: buildRevision,
          sourceRevision: captured.sourceRevision, sourcePaths: [captured.compilerOperand], servingBuild: preview.id,
        }, requestId: event.requestId, error: event.error, status: event.status, phase: "unknown" });
        exampleFailures.set(projection.occurrence.ref, { projection, cursor: failureCursor++ });
        while (exampleFailures.size > 64) exampleFailures.delete(exampleFailures.keys().next().value!);
      });
      const wrapped: SessionServicePreview = {
        id: preview.id,
        ...(preview.issueOpenUrl === undefined ? {} : { issueOpenUrl: () => preview.issueOpenUrl!() }),
        ...(preview.issueLocalActors === undefined ? {} : { issueLocalActors: () => preview.issueLocalActors!() }),
        ...(preview.exampleInput === undefined ? {} : { exampleInput: () => preview.exampleInput!() }),
        async dispose() {
          unobserve?.();
          if (previews.get(preview.id) === wrapped) previews.delete(preview.id);
          await preview.dispose();
        },
      };
      previews.set(preview.id, wrapped);
      return wrapped;
    },
  }, { historyLimit: 8 });
  let socket: SessionSocketOwner | null = null;
  let stopping: Promise<void> | null = null;

  const status = (): SessionServiceStatus => {
    const state = core.status();
    return {
      schema: "can.dev.status.v1", session: socket?.identity.sessionId ?? "starting",
      app: options.selectedApp, profile: options.capture.profile,
      revision: state.revision, source_revision: state.sourceRevision,
      check_revision: state.checkRevision, build_revision: state.buildRevision,
      serving_revision: state.servingRevision, serving_build: state.servingBuild,
      stale: state.stale, dirty: state.dirty, preview_reset: state.previewReset,
      capture_error: state.captureError === null ? null : short(state.captureError, MAX_REASON),
      preview: state.servingBuild !== null && previews.has(state.servingBuild) ? "ready" : "unavailable",
    };
  };

  const check = async (expectedRevision?: string): Promise<SessionCheckResponse> => {
    let result: Awaited<ReturnType<typeof core.check>>;
    try {
      result = await core.check(expectedRevision);
    } catch (error) {
      if (error instanceof DevRevisionConflictError) {
        throw new SessionSocketError("REVISION_CONFLICT", error.message);
      }
      throw error;
    }
    artifacts.clear();
    if (result.kind === "checked" || result.kind === "build_failed") {
      const index = [...helpByDigest.values()].find(candidate =>
        candidate.revision === result.check.detail.helpIndexRevision);
      if (index !== undefined) checkedHelp.set(result.revision, index);
      while (checkedHelp.size > 8) checkedHelp.delete(checkedHelp.keys().next().value!);
    }
    return checkResponse(socket?.identity.sessionId ?? "starting", core, result, options.previewBuilder !== undefined);
  };

  const stop = (): Promise<void> => {
    if (stopping !== null) return stopping;
    stopping = (async () => {
      let stopError: unknown;
      try { await core.stop(); } catch (error) { stopError = error; }
      await exampleQueue;
      reruns.close();
      exampleCaptures.clear();
      exampleFailures.clear();
      try { await socket?.stop(); } catch (error) { stopError ??= error; }
      captures.clear();
      helpByDigest.clear();
      checkedHelp.clear();
      artifacts.clear();
      previews.clear();
      if (stopError !== undefined) throw stopError;
    })();
    return stopping;
  };

  const detail = (revision: string): { revision: string; sourceRevision: string; check: DevCheck<SessionCheckDetail> } => {
    const found = core.detail(revision);
    if ("error" in found) throw new SessionSocketError("REVISION_UNAVAILABLE", "captured revision is unavailable");
    return found;
  };

  const compilerFailure = (ref: string): FailureProjection => {
    const match = ref.match(/^([A-Za-z0-9_-]{1,64})\/(r[1-9][0-9]*)\/d(0|[1-9][0-9]*)$/);
    if (!match || match[1] !== socket?.identity.sessionId) {
      throw new SessionSocketError("INVALID_FAILURE_REF", "failure ref does not select this session");
    }
    const revision = match[2]!;
    const index = Number(match[3]);
    if (!Number.isSafeInteger(index)) throw new SessionSocketError("INVALID_FAILURE_REF", "failure index is invalid");
    const found = detail(revision);
    const captured = found.check.detail;
    if (captured.kind !== "diagnostics" || index >= captured.diagnostics.length) {
      throw new SessionSocketError("FAILURE_UNAVAILABLE", "captured failure is unavailable");
    }
    const result: DiagnosticResult = {
      tool: "can", tool_version: captured.toolVersion ?? "unknown",
      language_version: captured.languageVersion ?? "unknown", schema_version: 1,
      sources: [{ id: 0, path: captured.source.path, sha256: captured.source.sha256 }],
      complete: found.check.complete,
      omitted: captured.compilerOmitted + captured.serviceOmitted,
      diagnostics: captured.diagnostics,
    };
    return projectCompilerFailure({
      context: {
        session: socket!.identity.sessionId, revision, sourceRevision: found.sourceRevision,
        sourcePaths: [captured.source.path],
      },
      result, index, captureComplete: true, sourceReadable: true,
    });
  };

  const handle = async (command: SessionSocketCommand): Promise<unknown> => {
    const payload = record(command.payload);
    if (command.command === "help") {
      return {
        schema: "can.dev.help.v1", protocol: SESSION_SOCKET_PROTOCOL,
        session: socket?.identity.sessionId,
        commands: COMMAND_HELP,
        unavailable: [],
      };
    }
    if (command.command === "status") return status();
    if (command.command === "check") {
      if (payload?.expectedRevision !== undefined &&
        (payload.expectedRevision !== core.status().revision || core.status().dirty)) {
        throw new SessionSocketError("REVISION_CONFLICT", "expected revision is not current");
      }
      return check(payload?.expectedRevision as string | undefined);
    }
    if (command.command === "diagnostics" || command.command === "diagnostic.detail") {
      const revision = payload?.revision;
      if (typeof revision !== "string" || !/^r[1-9][0-9]*$/.test(revision)) {
        throw new SessionSocketError("INVALID_REQUEST", "captured revision is required");
      }
      const found = detail(revision);
      const diagnostics = found.check.detail.diagnostics;
      if (command.command === "diagnostic.detail") {
        if (!integer(payload?.index) || payload.index >= diagnostics.length) {
          throw new SessionSocketError("DIAGNOSTIC_UNAVAILABLE", "diagnostic index is unavailable");
        }
        return {
          schema: "can.dev.diagnostic.v1", session: socket?.identity.sessionId,
          revision, source_revision: found.sourceRevision,
          current: core.status().revision === revision && !core.status().dirty,
          ref: diagnosticRef(socket!.identity.sessionId, revision, payload.index),
          source: found.check.detail.source,
          diagnostic: diagnostics[payload.index],
          construct_help: checkedHelp.has(revision)
            ? joinCompilerConstructCandidates(checkedHelp.get(revision)!,
              diagnostics[payload.index]!.construct_candidates, options.capture.profile)
            : { disposition: "unknown", slot: null, candidateCoverage: "unknown", cards: [],
              reason: "captured help index is unavailable" },
          evidence: { source_excerpt: "unavailable", trace: "unavailable" },
        };
      }
      const after = payload?.after === undefined ? -1 : payload.after;
      const limit = payload?.limit === undefined ? 10 : payload.limit;
      if (!integer(after, -1) || !integer(limit, 1) || limit > MAX_PAGE) {
        throw new SessionSocketError("INVALID_REQUEST", "diagnostic cursor or limit is invalid");
      }
      const start = after + 1;
      const page = diagnostics.slice(start, start + limit).map((item, offset) => ({
        ref: diagnosticRef(socket!.identity.sessionId, revision, start + offset),
        code: item.code, severity: item.severity,
        message: short(item.message, 180),
        at: { path: found.check.detail.source.path, start: item.primary.start, end: item.primary.end },
      }));
      const last = start + page.length - 1;
      return {
        schema: "can.dev.diagnostics.v1", session: socket?.identity.sessionId,
        revision, source_revision: found.sourceRevision,
        current: core.status().revision === revision && !core.status().dirty,
        reported: found.check.detail.reported,
        compiler_omitted: found.check.detail.compilerOmitted,
        service_omitted: found.check.detail.serviceOmitted,
        diagnostics: page,
        next_after: last + 1 < diagnostics.length ? last : null,
      };
    }
    if (command.command === "construct.help") {
      const revision = payload?.revision;
      const id = payload?.id;
      if (typeof revision !== "string" || !/^r[1-9][0-9]*$/.test(revision) ||
          typeof id !== "string" || !/^can\.v1\.[a-z0-9_.-]{1,100}$/.test(id)) {
        throw new SessionSocketError("INVALID_REQUEST", "construct help needs captured revision and construct ID");
      }
      const found = detail(revision);
      const index = checkedHelp.get(revision);
      if (index === undefined || index.revision !== found.check.detail.helpIndexRevision) {
        throw new SessionSocketError("HELP_UNAVAILABLE", "captured construct help is unavailable");
      }
      const card = index.get(id);
      if (card === undefined) throw new SessionSocketError("CONSTRUCT_UNKNOWN", "construct ID is not in captured help");
      return {
        schema: "can.dev.construct-help.v1", session: socket?.identity.sessionId,
        revision, source_revision: found.sourceRevision, index_revision: index.revision,
        current: core.status().revision === revision && !core.status().dirty,
        card, candidate_coverage: "unknown",
      };
    }
    if (command.command === "failure.lookup" || command.command === "failure.detail") {
      const ref = payload?.ref;
      if (typeof ref !== "string") throw new SessionSocketError("INVALID_FAILURE_REF", "failure ref is required");
      if (!ref.startsWith(`${socket!.identity.sessionId}/`)) {
        throw new SessionSocketError("INVALID_FAILURE_REF", "failure ref does not select this session");
      }
      const runtime = exampleFailures.get(ref);
      if (runtime === undefined && !/^.+\/r[1-9][0-9]*\/d[0-9]+$/.test(ref)) {
        throw new SessionSocketError("FAILURE_UNAVAILABLE", "captured runtime failure is unavailable");
      }
      const projection = runtime?.projection ?? compilerFailure(ref);
      if (command.command === "failure.lookup") return projection.occurrence;
      return {
        schema: "can.dev.failure-detail.v1", ref: projection.occurrence.ref,
        revision: projection.occurrence.revision, source_revision: projection.occurrence.source_revision,
        detail: projection.detail,
      };
    }
    if (command.command === "failures") {
      const revision = payload?.revision;
      const after = payload?.after ?? -1;
      const limit = payload?.limit ?? 1;
      if (typeof revision !== "string" || !/^r[1-9][0-9]*$/.test(revision) ||
          !integer(after, -1) || !integer(limit, 1) || limit > MAX_PAGE) {
        throw new SessionSocketError("INVALID_REQUEST", "failure list needs a captured revision and bounded cursor");
      }
      detail(revision);
      const retained = [...exampleFailures.values()].filter(value => value.projection.occurrence.revision === revision);
      const available = retained.filter(value => value.cursor > after);
      const page = available.slice(0, limit);
      return { schema: "can.dev.failures.v1", session: socket!.identity.sessionId, revision,
        origins: ["example", "http"], total_retained: retained.length,
        failures: page.map(value => value.projection.occurrence),
        next_after: available.length > page.length ? page.at(-1)!.cursor : null };
    }
    if (command.command === "example.run" || command.command === "example.rerun") {
      const work = exampleQueue.then(async () => {
        if (stopping !== null) throw new SessionSocketError("SESSION_STOPPED", "session is stopping");
        if (command.command === "example.rerun") {
          const ref = payload?.ref;
          if (typeof ref !== "string" || !ref.startsWith(`${socket!.identity.sessionId}/`)) {
            throw new SessionSocketError("INVALID_FAILURE_REF", "failure ref does not select this session");
          }
          const failure = exampleFailures.get(ref);
          if (failure?.rerunRef === undefined) {
            throw new SessionSocketError("RERUN_UNAVAILABLE", "retained failure has no supported example row");
          }
          return safeRerunResult(await reruns.rerun(failure.rerunRef));
        }
        const expectedRevision = payload?.expectedRevision;
        if (typeof expectedRevision !== "string" || !/^r[1-9][0-9]*$/.test(expectedRevision)) {
          throw new SessionSocketError("REVISION_REQUIRED", "example run needs the expected revision");
        }
        const operation = payload?.operation;
        const rowIndex = payload?.rowIndex;
        if ((operation === undefined) !== (rowIndex === undefined) ||
            (operation !== undefined && (typeof operation !== "string" || operation.length > 200 || !integer(rowIndex)))) {
          throw new SessionSocketError("INVALID_REQUEST", "selected row needs an operation and nonnegative row index");
        }
        await core.refresh();
        const state = core.status();
        if (state.revision !== expectedRevision || state.dirty || state.servingRevision !== expectedRevision) {
          throw new SessionSocketError("REVISION_CONFLICT", "example run requires the current admitted build");
        }
        const preview = state.servingBuild === null ? undefined : previews.get(state.servingBuild);
        if (preview?.exampleInput === undefined || latestCapture === null) {
          throw new SessionSocketError("EXAMPLES_UNAVAILABLE", "serving build has no verified example recipe");
        }
        const captured = latestCapture;
        const recipe = preview.exampleInput();
        if (recipe.sourceRevision !== state.sourceRevision) {
          throw new SessionSocketError("EXAMPLES_UNAVAILABLE", "example recipe differs from the admitted source");
        }
        const input = { ...recipe, testkit: await loadInstalledExampleTestkit(captured.root) };
        const artifactDigest = createHash("sha256").update(input.artifactBytes).digest("hex");
        const runId = randomUUID();
        const result = await runCompiledExamples({ ...input, runId,
          ...(typeof operation === "string" ? { selectedRow: { operation, rowIndex: rowIndex as number } } : {}) });
        // Passing and unsupported runs have no row to rerun. They must not
        // consume the bounded artifacts backing earlier failure references.
        const rerunnable = result.report.cases.some(example => example.kind === "table" &&
          example.rows.some(row => row.outcome === "failed" || row.outcome === "setup-failed"));
        const artifact = rerunnable ? reruns.retainArtifact({ revision: expectedRevision,
          fixtureRecipeId: captured.epochMaterial, runtimeProfileId: options.capture.profile, input }) : null;
        if (artifact !== null) {
          exampleCaptures.delete(captured.epochMaterial);
          exampleCaptures.set(captured.epochMaterial, captured);
          while (exampleCaptures.size > 8) exampleCaptures.delete(exampleCaptures.keys().next().value!);
        }
        const failures: FailureProjection["occurrence"][] = [];
        for (const [caseIndex, example] of result.report.cases.entries()) {
          const entries = example.kind === "table" ? example.rows : example.steps;
          for (const [entryIndex, entry] of entries.entries()) {
            if (entry.outcome === "passed") continue;
            const projection = projectExampleFailure({ context: {
              session: socket!.identity.sessionId, revision: expectedRevision, sourceRevision: captured.sourceRevision,
              sourcePaths: [captured.compilerOperand], servingBuild: state.servingBuild!,
            }, report: result.report, artifactSourceRevision: captured.sourceRevision, runId, caseIndex, entryIndex });
            let rerunRef: string | undefined;
            if (example.kind === "table" && artifact !== null && entry.outcome !== "unsupported") {
              rerunRef = reruns.recordFailure({ artifactRef: artifact.artifactRef, runId, result,
                selector: { operation: example.operation, rowIndex: example.rows[entryIndex]!.rowIndex } }).failureRef;
            }
            exampleFailures.set(projection.occurrence.ref, { projection, cursor: failureCursor++,
              ...(rerunRef === undefined ? {} : { rerunRef }) });
            failures.push(projection.occurrence);
            while (exampleFailures.size > 64) exampleFailures.delete(exampleFailures.keys().next().value!);
          }
        }
        await core.refresh().catch(() => undefined);
        return { schema: "can.dev.example-run.v1", session: socket!.identity.sessionId, revision: expectedRevision,
          source_revision: captured.sourceRevision, serving_build: state.servingBuild, artifact_digest: artifactDigest,
          run_id: runId, current: core.status().revision === expectedRevision && !core.status().dirty,
          ok: result.ok, executed: result.executed, summary: result.report.summary,
          focus: failures[Math.max(0, failures.length - 64)] ?? null,
          failures_retained: Math.min(failures.length, 64), failures_omitted: Math.max(0, failures.length - 64),
          replay: { available: false, reason: "no_restore_capsule" } };
      });
      exampleQueue = work.then(() => undefined, () => undefined);
      return work;
    }
    if (command.command === "preview.status") {
      const state = status();
      return { schema: "can.dev.preview.v1", session: state.session, state: state.preview,
        serving_revision: state.serving_revision, serving_build: state.serving_build, stale: state.stale,
        failure_focus: [...exampleFailures.values()].reverse().find(value =>
          value.projection.occurrence.serving_build === state.serving_build)?.projection.occurrence ?? null };
    }
    if (command.command === "preview.open") {
      const build = core.status().servingBuild;
      const preview = build === null ? undefined : previews.get(build);
      if (preview?.issueOpenUrl === undefined) {
        throw new SessionSocketError("PREVIEW_UNAVAILABLE", "no protected preview is serving");
      }
      return { schema: "can.dev.preview-open.v1", serving_build: build,
        url: preview.issueOpenUrl(),
        ...(preview.issueLocalActors === undefined ? {} : { actors: preview.issueLocalActors() }) };
    }
    if (command.command === "stop") {
      // Let the socket write its acknowledgement before closing active peers.
      setTimeout(() => { void stop().catch(() => undefined); }, 100).unref();
      return { schema: "can.dev.stop.v1", session: socket?.identity.sessionId, stopping: true };
    }
    throw new SessionSocketError("UNKNOWN_COMMAND", "control command is unsupported");
  };

  try {
    await core.refresh().catch(() => undefined);
    core.watchDirectories(await watchDirectories(options.capture, latestCapture));
    socket = await startSessionSocket({
      checkoutRoot: options.capture.checkoutRoot,
      app: options.selectedApp,
      profile: options.capture.profile,
      ...(options.runtimeDir === undefined ? {} : { runtimeDir: options.runtimeDir }),
      handle,
    });
  } catch (error) {
    await core.stop();
    throw error;
  }
  return { identity: socket.identity, descriptorPath: socket.descriptorPath, status, check, stop };
}

/** Attach only after the socket verifies root, selection, descriptor and hello. */
export function attachDevSessionService(lookup: SessionSocketLookup): Promise<SessionSocketClient> {
  return discoverSessionSocket(lookup);
}
