import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BusinessError, CompileArtifact, ExampleReport, ObservationMismatch, OperationId, TableRowResult } from "@canlang/contracts";
import type { CompiledExampleInput } from "../src/dev/example-runner.js";
import type { PreviewRefusal } from "../src/dev/preview-bridge.js";
import { attachDevSessionService, startDevSessionService, type SessionConstructRankingOptions, type SessionConstructQualificationRequest } from "../src/dev/session-service.js";
import { FIRST_PROFILE } from "../src/dev/construct-help.js";
import { DevSessionCore } from "../src/dev/session-core.js";
import type { JevChoiceRequest, RankResult } from "../src/dev/jev-ranker.js";
import { runDevControlArgv, type DevControlEnvelope } from "../src/dev/control-client.js";

function controlResult<T>(envelope: DevControlEnvelope): T {
  if (!envelope.ok) throw new Error(`expected successful ${envelope.command}: ${envelope.code}`);
  return envelope.result as T;
}

const producer = vi.hoisted(() => ({ calls: [] as unknown[], routing: undefined as unknown, passed: false, primary: undefined as { start: number; end: number } | undefined, omitted: 0, complete: true }));
vi.mock("../src/dev/compiler-check.js", () => ({
  compileCapturedSingleFile: async (capture: { compilerOperand: string; sourceSha256: string }) => producer.routing !== undefined ? {
    kind: "diagnostics", envelope: { tool: "can", tool_version: "test-compiler", language_version: "1.0", schema_version: 1,
      sources: [{ id: 0, path: capture.compilerOperand, sha256: capture.sourceSha256 }], complete: producer.complete, omitted: producer.omitted,
      diagnostics: [{ code: "E1001", severity: "error", message: "source error", primary: { file: 0, ...(producer.primary ?? { start: 0, end: 1 }) },
        related: [], tags: [], construct_candidates: producer.routing }] },
  } : ({
    kind: "artifact", capture,
    artifact: { tool_version: "test-compiler", language_version: "1.0",
      sources: [{ path: capture.compilerOperand, sha256: capture.sourceSha256 }] },
    artifactBytes: Uint8Array.from(Buffer.from(`artifact:${capture.sourceSha256}`)),
  }),
}));
vi.mock("../src/dev/example-runner.js", () => ({
  loadInstalledExampleTestkit: async () => ({ loadExampleSuite() {}, runTable() {}, createReport() {}, fixtureValuesOf() {} }),
  runCompiledExamples: async (input: CompiledExampleInput) => {
    producer.calls.push({ bytes: [...input.artifactBytes], worker: input.worker.modules,
      sourceRevision: input.sourceRevision, selectedRow: input.selectedRow, runId: input.runId });
    const mismatches = [{ observation: "private-observation", expected: "PRIVATE_EXPECTED",
      actual: "PRIVATE_ACTUAL" }] satisfies readonly ObservationMismatch[];
    const row: TableRowResult = {
      rowIndex: input.selectedRow?.rowIndex ?? 0,
      caller: { account: "PRIVATE_CALLER", team: "current", roles: ["PRIVATE_ROLE"], authenticated: true },
      outcome: producer.passed ? "passed" : "failed", detail: "PRIVATE_RUNTIME_MESSAGE",
      ...(producer.passed ? {} : { mismatches }),
    };
    const report: ExampleReport = {
      contractsVersion: 1, examplesVersion: 1,
      artifact: { digest: createHash("sha256").update(input.artifactBytes).digest("hex"),
        sourceRevision: input.sourceRevision },
      startedAt: "2026-10-09T10:00:00.000Z", finishedAt: "2026-10-09T10:00:01.000Z",
      cases: [{ kind: "table", operation: input.selectedRow?.operation ?? "Office.use", rows: [row] }],
      summary: { total: 1, passed: producer.passed ? 1 : 0, failed: producer.passed ? 0 : 1, setupFailed: 0, unsupported: 0 },
    };
    return { ok: producer.passed, executed: 1, report };
  },
}));

const scratch: string[] = [];
afterEach(() => {
  producer.calls.length = 0;
  producer.routing = undefined;
  producer.passed = false;
  producer.primary = undefined;
  producer.omitted = 0;
  producer.complete = true;
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("retains compiler routing by revision without turning unqualified grammar IDs into working help", async () => {
  const fixture = await ownerFixture();
  try {
    producer.routing = { version: 1, disposition: "structural", ids: [], complete: false };
    const first = await settledRankingCheck(fixture);
    expect(first.state).toBe("errors");
    expect(await fixture.client.request({ command: "construct.rank", payload: { revision: first.revision, index: 0 } }))
      .toMatchObject({ result: { state: "structural" } });
    const query = async (revision: string) => fixture.client.request({ command: "diagnostic.detail", payload: { revision, index: 0 } });
    expect(await query(first.revision)).toMatchObject({ diagnostic: { construct_candidates: {
      disposition: "structural", complete: false,
    } }, construct_help: { candidateCoverage: "unknown", cards: [] } });
    writeFileSync(fixture.app, "app Office\nGiven\nWhen\nThen\n## exact slot\n");
    producer.routing = { version: 1, disposition: "exact", slot: "given_type", ids: ["can.v1.type.builtin.text"], complete: true };
    const second = await settledRankingCheck(fixture);
    expect(await fixture.client.request({ command: "construct.rank", payload: { revision: second.revision, index: 0 } }))
      .toMatchObject({ result: { state: "candidate_coverage_unknown" } });
    expect(await query(second.revision)).toMatchObject({ diagnostic: { construct_candidates: {
      disposition: "exact", ids: ["can.v1.type.builtin.text"],
    } }, construct_help: { candidateCoverage: "unknown", cards: [] } });
    expect(await query(first.revision)).toMatchObject({ diagnostic: { construct_candidates: { disposition: "structural" } } });
  } finally { await fixture.owner.stop(); }
});

async function ownerFixture(constructRanking?: SessionConstructRankingOptions, realHelp = false) {
  const base = mkdtempSync(join(tmpdir(), "can-example-control-"));
  scratch.push(base);
  const root = join(base, "checkout");
  const runtimeDir = join(base, "control");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(runtimeDir, { mode: 0o700 });
  const app = join(root, "Office.can");
  const runtime = join(root, "runtime.js");
  writeFileSync(app, "app Office\nGiven\nWhen\nThen\n");
  for (const name of ["compiler", "catalog.json", "help.md"]) writeFileSync(join(root, name), name);
  writeFileSync(runtime, "runtime v1");
  const capturedPaths = ["docs/specification/CONSTRUCT-HELP.md", "docs/specification/GRAMMAR.md",
    "docs/specification/DESIGN.md", "design/UI-COMPONENTS.md", "packages/values/src/catalog.ts",
    "packages/ui/src/catalog.ts", "packages/values/dist/src/catalog.js", "packages/ui/dist/src/catalog.js"];
  if (realHelp) {
    const repository = resolve(import.meta.dirname, "../../..");
    for (const path of capturedPaths) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      copyFileSync(join(repository, path), join(root, path));
    }
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
  }
  let admittedBytes: Uint8Array | null = null;
  const refusalObservers = new Set<(event: PreviewRefusal) => void>();
  let unobserves = 0;
  const owner = await startDevSessionService({
    selectedApp: "Office", runtimeDir,
    ...(constructRanking === undefined ? {} : { constructRanking }),
    capture: { checkoutRoot: root, appPath: "Office.can", profile: "local-d1-identity",
      compilerPath: "compiler", catalogPath: "catalog.json", helpIndexPath: realHelp ? "docs/specification/CONSTRUCT-HELP.md" : "help.md",
      packageInputPaths: [{ name: "runtime", path: "runtime.js" }, ...(realHelp ? [
        { name: "values-catalog", path: "packages/values/dist/src/catalog.js" },
        { name: "ui-catalog", path: "packages/ui/dist/src/catalog.js" }] : [])],
      ...(realHelp ? { extraInputPaths: capturedPaths.filter(path => !path.endsWith(".js") &&
        !path.endsWith("CONSTRUCT-HELP.md")).map(path => ({ name: path.endsWith("GRAMMAR.md") ? "grammar" : path, path })) } : {}) },
    previewBuilder: async (_artifact: CompileArtifact, capture, artifactBytes) => {
      admittedBytes = artifactBytes;
      return { id: `build-${capture.sourceSha256.slice(0, 12)}`, dispose: async () => undefined,
      observeRefusals: (handler: (event: PreviewRefusal) => void) => {
        refusalObservers.add(handler);
        return () => { refusalObservers.delete(handler); unobserves += 1; };
      },
      exampleInput: () => ({ artifactBytes, artifactLabel: "Office.artifact.json",
        sourceRevision: capture.sourceRevision,
        worker: { mainModule: "worker.js", modules: { "worker.js": "export default {};" } },
        workerName: "office", compatibilityDate: "2026-01-01", d1Binding: "DB",
        hooks: { materializeFixtures: async () => ({ materialized: [], values: new Map() }),
          invoke: async () => ({ ok: false as const, error: "unused" }), observeLive: async () => null } }) };
    },
  });
  const client = await attachDevSessionService({ checkoutRoot: root, app: "Office",
    profile: "local-d1-identity", runtimeDir });
  return { owner, client, root, app, runtime,
    mutateAdmittedBytes: () => { admittedBytes?.fill(88); },
    emitRefusal: (event: PreviewRefusal) => {
      for (const observer of refusalObservers) observer(event);
    },
    subscriberCount: () => refusalObservers.size,
    unobserves: () => unobserves };
}

it("runs through the private owner, retains safe failure lookup, and reruns copied bytes", async () => {
  const fixture = await ownerFixture();
  try {
    const checked = await fixture.client.request({ command: "check" }) as { revision: string; preview: string };
    expect(checked.preview).toBe("ready");
    const control = (args: string[]) => runDevControlArgv(args, {
      cwd: fixture.root, discover: async () => fixture.client,
    });
    expect(await control(["example.run"])) .toMatchObject({ ok: false, code: "REVISION_REQUIRED" });
    expect(await control(["example.run", "--expected-revision", "r999"]))
      .toMatchObject({ ok: false, code: "REVISION_CONFLICT" });
    const run = await control(["example.run", "--expected-revision", checked.revision,
      "--operation", "Office.use", "--row", "0"]);
    expect(run).toMatchObject({ ok: true, result: { schema: "can.dev.example-run.v1", executed: 1,
      revision: checked.revision, replay: { available: false } } });
    const result = controlResult<{ run_id: string; focus: { ref: string }; artifact_digest: string }>(run);
    expect(producer.calls).toHaveLength(1);
    expect(producer.calls[0]).toMatchObject({ selectedRow: { operation: "Office.use", rowIndex: 0 },
      runId: result.run_id });
    const firstBytes = Uint8Array.from((producer.calls[0] as { bytes: number[] }).bytes);
    expect(result.artifact_digest).toBe(createHash("sha256").update(firstBytes).digest("hex"));
    const failure = await control(["failure.lookup", "--ref", result.focus.ref]);
    const detail = await control(["failure.detail", "--ref", result.focus.ref]);
    expect(failure).toMatchObject({ ok: true, result: { origin: "example", revision: checked.revision } });
    expect(detail).toMatchObject({ ok: true, result: { detail: { outcome: "failed" } } });
    expect(JSON.stringify([run, failure, detail])).not.toMatch(/PRIVATE_(?:CALLER|ROLE|RUNTIME_MESSAGE|EXPECTED|ACTUAL)/);
    expect(await control(["failure.lookup", "--ref", `foreign/${checked.revision}/${result.run_id}/f0_0`]))
      .toMatchObject({ ok: false, code: "INVALID_FAILURE_REF" });

    fixture.mutateAdmittedBytes();
    const rerun = await control(["example.rerun", "--ref", result.focus.ref]);
    expect(rerun).toMatchObject({ ok: true, result: { ok: true, kind: "isolated_example_rerun",
      original: { run_id: result.run_id }, inputs: { changed: expect.arrayContaining(["D1_row_scope"]) } } });
    expect(controlResult<{ rerun: { run_id: string } }>(rerun).rerun.run_id).not.toBe(result.run_id);
    expect(producer.calls).toHaveLength(2);
    expect(producer.calls[1]).toMatchObject({ selectedRow: { operation: "Office.use", rowIndex: 0 },
      bytes: [...firstBytes] });
    expect(JSON.stringify(rerun)).not.toMatch(/PRIVATE_(?:CALLER|ROLE|RUNTIME_MESSAGE|EXPECTED|ACTUAL)/);

    writeFileSync(fixture.app, "app Office\nGiven\nWhen\nThen\n## changed\n");
    expect(await control(["example.run", "--expected-revision", checked.revision]))
      .toMatchObject({ ok: false, code: "REVISION_CONFLICT" });
    const newCheck = await fixture.client.request({ command: "check" }) as { revision: string };
    expect(newCheck.revision).not.toBe(checked.revision);
    expect(await control(["failure.lookup", "--ref", result.focus.ref]))
      .toMatchObject({ ok: true, result: { revision: checked.revision } });
    expect(await control(["example.run", "--expected-revision", checked.revision]))
      .toMatchObject({ ok: false, code: "REVISION_CONFLICT" });
    writeFileSync(fixture.runtime, "runtime v2");
    expect(await control(["example.rerun", "--ref", result.focus.ref]))
      .toMatchObject({ ok: true, result: { ok: false, code: "resource_unavailable" } });
    expect(producer.calls).toHaveLength(2);
  } finally {
    await fixture.owner.stop();
  }
});

it("keeps a failed row's artifact when subsequent runs pass", async () => {
  const fixture = await ownerFixture();
  try {
    const { revision } = await fixture.client.request({ command: "check" }) as { revision: string };
    const run = () => fixture.client.request({ command: "example.run", payload: { expectedRevision: revision } });
    const failed = await run() as { focus: { ref: string }; artifact_digest: string; run_id: string };
    producer.passed = true;
    for (let index = 0; index < 9; index++) {
      expect(await run()).toMatchObject({ ok: true, focus: null, artifact_digest: failed.artifact_digest });
    }
    expect(await fixture.client.request({ command: "example.rerun", payload: { ref: failed.focus.ref } }))
      .toMatchObject({ ok: true, artifact: { artifactDigest: failed.artifact_digest },
        original: { run_id: failed.run_id, outcome: "failed" }, rerun: { outcome: "passed" } });
  } finally { await fixture.owner.stop(); }
});

it("projects observed business refusals through the owner and releases the observer on disposal", async () => {
  const fixture = await ownerFixture();
  try {
    const first = await fixture.client.request({ command: "check" }) as { revision: string; preview: string };
    expect(first.preview).toBe("ready");
    expect(fixture.subscriberCount()).toBe(1);
    const secret = "PRIVATE_HTTP_MESSAGE_AND_VALUES";
    const privateOperation = "018f4d7a-0000-7000-8000-000000000001" as OperationId;
    fixture.emitRefusal({ requestId: "request1", status: 403,
      error: { code: "forbidden", message: secret, operation_id: privateOperation,
        fields: [{ path: "/PRIVATE_FIELD", code: "PRIVATE_CODE", message: secret }] } });
    const control = (args: string[]) => runDevControlArgv(args, {
      cwd: fixture.root, discover: async () => fixture.client,
    });
    const preview = await control(["preview.status"]);
    expect(preview).toMatchObject({ ok: true, result: { failure_focus: {
      origin: "http", revision: first.revision, code: "forbidden" } } });
    const ref = controlResult<{ failure_focus: { ref: string } }>(preview).failure_focus.ref;
    const listed = await control(["failures", "--revision", first.revision, "--limit", "5"]);
    expect(listed).toMatchObject({ ok: true, result: { schema: "can.dev.failures.v1",
      total_retained: 1, failures: [{ ref, origin: "http" }] } });
    const lookup = await control(["failure.lookup", "--ref", ref]);
    const detail = await control(["failure.detail", "--ref", ref]);
    expect(lookup).toMatchObject({ ok: true, result: { ref, origin: "http",
      owner_ref: { request_id: "request1", status: 403 } } });
    expect(detail).toMatchObject({ ok: true, result: { detail: { status: 403, retryable: false } } });
    expect(JSON.stringify([preview, listed, lookup, detail])).not.toMatch(/PRIVATE_(?:HTTP_MESSAGE_AND_VALUES|FIELD|CODE)/);
    expect(JSON.stringify([preview, listed, lookup, detail])).not.toContain(privateOperation);

    fixture.emitRefusal({ requestId: "mcp1", status: 200, transport: "mcp",
      error: { code: "busy", message: secret, retryable: true } });
    const mcpRef = `${fixture.client.identity.sessionId}/${first.revision}/mcp1/f0`;
    expect(await control(["failure.lookup", "--ref", mcpRef])).toMatchObject({ ok: true, result: {
      code: "busy", owner_ref: { status: 200, transport: "mcp" } } });
    const mcpDetail = await control(["failure.detail", "--ref", mcpRef]);
    expect(mcpDetail).toMatchObject({ ok: true, result: { detail: {
      status: 200, transport: "mcp", retryable: true } } });
    expect(JSON.stringify(mcpDetail)).not.toContain(secret);

    writeFileSync(fixture.app, "app Office\nGiven\nWhen\nThen\n## next revision\n");
    // The native write hint may supersede a captured check. A different
    // revision alone does not publish a replacement preview or dispose its
    // predecessor; retry only that explicit currency refusal, without delays.
    let second: { revision: string; state: string; current: boolean; preview: string } | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      second = await fixture.client.request({ command: "check" }) as typeof second;
      if (second?.state !== "superseded") break;
    }
    expect(second).toMatchObject({ state: "valid", current: true, preview: "ready" });
    expect(second!.revision).not.toBe(first.revision);
    expect(await control(["failure.lookup", "--ref", ref]))
      .toMatchObject({ ok: true, result: { ref, revision: first.revision } });
    expect(fixture.unobserves()).toBeGreaterThanOrEqual(1);
    expect(fixture.subscriberCount()).toBe(1);
  } finally {
    await fixture.owner.stop();
    expect(fixture.subscriberCount()).toBe(0);
  }
});

it("refuses newly changed runtime modules until the owner restarts", async () => {
  const fixture = await ownerFixture();
  try {
    await fixture.client.request({ command: "check" });
    writeFileSync(fixture.runtime, "new runtime producer");
    expect(await fixture.client.request({ command: "check" })).toMatchObject({ state: "incomplete",
      preview_reason: "capture_incomplete" });
    const state = await fixture.client.request({ command: "status" }) as { revision: string };
    expect(state).toMatchObject({ stale: true, dirty: true,
      capture_error: expect.stringContaining("restart this session") });
    await expect(fixture.client.request({ command: "example.run", payload: { expectedRevision: state.revision } }))
      .rejects.toMatchObject({ code: "REQUEST_FAILED" });
    expect(producer.calls).toHaveLength(0);
  } finally { await fixture.owner.stop(); }
});

it("refreshes retained capture order when a failed artifact epoch returns", async () => {
  const fixture = await ownerFixture();
  try {
    const source = "app Office\nGiven\nWhen\nThen\n";
    const run = async (label: string) => {
      writeFileSync(fixture.app, `${source}## ${label}\n`);
      const { revision } = await fixture.client.request({ command: "check" }) as { revision: string };
      return fixture.client.request({ command: "example.run", payload: { expectedRevision: revision } }) as
        Promise<{ focus: { ref: string }; artifact_digest: string }>;
    };
    for (const label of ["A", "B", "C", "D", "E", "F", "G", "H"]) await run(label);
    const newestA = await run("A");
    await run("I");
    expect(await fixture.client.request({ command: "example.rerun", payload: { ref: newestA.focus.ref } }))
      .toMatchObject({ ok: true, artifact: { artifactDigest: newestA.artifact_digest } });
  } finally { await fixture.owner.stop(); }
});

it("keeps failure cursors stable when bounded retention evicts older occurrences", async () => {
  const fixture = await ownerFixture();
  try {
    const { revision } = await fixture.client.request({ command: "check" }) as { revision: string };
    await expect(fixture.client.request({ command: "failures", payload: { revision: "r999" } }))
      .rejects.toMatchObject({ code: "REVISION_UNAVAILABLE" });
    const emit = (index: number) => fixture.emitRefusal({ requestId: `request${index}`, status: 403,
      error: { code: "forbidden", message: "denied" } });
    for (let index = 0; index < 3; index++) emit(index);
    const first = await fixture.client.request({ command: "failures", payload: { revision, limit: 1 } }) as {
      failures: { ref: string }[]; next_after: number;
    };
    expect(first.next_after).toBe(0);
    for (let index = 3; index < 67; index++) emit(index);
    const next = await fixture.client.request({ command: "failures", payload: {
      revision, limit: 1, after: first.next_after,
    } }) as { total_retained: number; failures: { owner_ref: { request_id: string } }[]; next_after: number };
    expect(next.total_retained).toBe(64);
    expect(next.failures[0]!.owner_ref.request_id).toBe("request3");
    expect(next.next_after).toBe(3);
    await expect(fixture.client.request({ command: "failure.lookup", payload: { ref: first.failures[0]!.ref } }))
      .rejects.toMatchObject({ code: "FAILURE_UNAVAILABLE" });
  } finally { await fixture.owner.stop(); }
});

const rankIds = ["can.v1.then.text", "can.v1.ui.stat"];
const rankSource = "app Office\nGiven\nWhen\nThen\nwidgit\n";
function rankingContext() {
  return { version: 1, messageKind: "synthetic_unknown_page_item", section: "Then", guess: "widgit",
    exactSourceSpan: true, structuralRecovery: false, recoveryComplete: true, nameFilterComplete: true,
    materialIntentChoice: false, evidenceSufficient: true, unsupportedBehaviorProven: false };
}
function rankRouting(ids = rankIds, context: unknown = rankingContext()) {
  return { version: 1, disposition: "exact", slot: "then.page_item", ids, complete: true, context };
}
/** Component-only evidence. These names establish no actual compiler/runtime pass. */
function syntheticQualification(request: SessionConstructQualificationRequest) {
  expect(Object.isFrozen(request)).toBe(true);
  expect(Object.isFrozen(request.inputs)).toBe(true);
  expect(request.producerInputsDigest).toBe(createHash("sha256").update(JSON.stringify(request.inputs)).digest("hex"));
  expect(Object.isFrozen(request.capture)).toBe(true);
  expect(request.capture.sourceText).toContain("widgit");
  const { inputs: _inputs, capture: _capture, ...binding } = request;
  expect(JSON.stringify(binding)).not.toContain("widgit");
  return Object.freeze({ ...binding, messageKinds: Object.freeze(["synthetic_unknown_page_item"]),
    proofs: Object.freeze(rankIds.map(id => Object.freeze({ id, indexRevision: request.indexRevision,
      compilerSha256: request.compilerSha256, profile: FIRST_PROFILE,
      compilerCheck: "synthetic-component-only-compiler", runtimeCheck: "synthetic-component-only-runtime" }))) });
}
function rankAnswer(request: JevChoiceRequest, choice: string) {
  const ids = Object.keys(request.questions.construct_for_occurrence.criteria);
  return { model: "jev-component-fake", answers: { construct_for_occurrence: {
    type: "choice", choice, confidence: 0.9,
    probabilities: Object.fromEntries(ids.map(id => [id, id === choice ? 0.85 : 0.15 / (ids.length - 1)])),
  } }, usage: { input_tokens: 20, output_tokens: 3 }, prose: "PRIVATE_PROVIDER_PROSE" };
}
/** Native watcher hints can supersede a check even when the authored bytes are stable.
 * Let the actual write event/debounce settle, then require an admitted captured check.
 * Retry only a reported superseded attempt; never treat it as retained diagnostics.
 */
async function settledRankingCheck(fixture: Pick<Awaited<ReturnType<typeof ownerFixture>>, "client">,
  expectedState: "errors" | "limited" | "incomplete" = "errors") {
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const checked = await fixture.client.request({ command: "check" }) as { revision: string; state: string; current: boolean;
      evidence: { capture_complete: boolean; analysis_complete: boolean } };
    if (checked.state === "superseded") continue;
    expect(checked.state).toBe(expectedState);
    expect(checked.evidence.capture_complete).toBe(true);
    expect(checked.evidence.analysis_complete).toBe(expectedState !== "incomplete");
    expect(checked.current).toBe(true);
    return checked;
  }
  throw new Error("authored component fixture did not settle into captured diagnostics");
}

async function rankingFixture(config?: SessionConstructRankingOptions) {
  const fixture = await ownerFixture(config, true);
  const original = await fixture.client.request({ command: "check" }) as { revision: string };
  writeFileSync(fixture.app, rankSource);
  producer.primary = { start: rankSource.indexOf("widgit"), end: rankSource.indexOf("widgit") + 6 };
  producer.routing = rankRouting();
  const checked = await settledRankingCheck(fixture);
  const control = (args: string[]) => runDevControlArgv(args, { cwd: fixture.root, discover: async () => fixture.client });
  const rank = async (revision = checked.revision) => controlResult<{ result: RankResult }>(await control([
    "construct.rank", "--revision", revision, "--index", "0",
  ])).result;
  return { ...fixture, original, checked, control, rank };
}

it("ranks only captured qualified cards through private CLI/socket control and preserves diagnostics/preview", async () => {
  let choice = rankIds[0]!;
  let calls = 0;
  const inputDigests: string[] = [];
  const fixture = await rankingFixture({ qualify: request => { inputDigests.push(request.producerInputsDigest); return syntheticQualification(request); }, allowExternal: () => true,
    transport: { choose: async request => { calls++; return rankAnswer(request, choice); } } });
  try {
    expect(await fixture.rank()).toMatchObject({ state: "likely", card: { id: rankIds[0] } });
    const first = await fixture.client.request({ command: "diagnostic.detail", payload: { revision: fixture.checked.revision, index: 0 } });
    expect(first).toMatchObject({ diagnostic: { message: "source error" } });
    expect(await fixture.client.request({ command: "preview.status" })).toMatchObject({ state: "ready", serving_revision: fixture.original.revision, stale: true });
    for (const next of ["none", "unclear"]) {
      choice = next;
      writeFileSync(fixture.app, `${rankSource}## ${next}\n`);
      const { revision } = await settledRankingCheck(fixture);
      expect(await fixture.rank(revision)).toMatchObject({ state: next === "unclear" ? "intent_unclear" : "none" });
    }
    expect(calls).toBe(3);
    expect(new Set(inputDigests).size).toBe(1);
    await expect(fixture.client.request({ command: "construct.rank", payload: {
      revision: fixture.checked.revision, index: 0, context: rankingContext(), proofs: [], cards: [],
    } })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(JSON.stringify(await fixture.rank())).not.toContain("PRIVATE_PROVIDER_PROSE");
  } finally { await fixture.owner.stop(); }
});

it("keeps structural/none/unknown local and refuses omitted or malformed context and unbound qualification", async () => {
  let qualificationMode = "valid";
  let calls = 0;
  const fixture = await rankingFixture({ allowExternal: () => true, qualify: request => {
    const bundle = syntheticQualification(request);
    if (qualificationMode === "missing") return null;
    if (qualificationMode === "mutable") return { ...bundle };
    if (qualificationMode === "branch") return Object.freeze({ ...bundle, messageKinds: Object.freeze(["different_branch"]) });
    if (qualificationMode === "profile") return Object.freeze({ ...bundle, resourceProfile: "other-resource-profile" });
    if (qualificationMode === "producer") return Object.freeze({ ...bundle, producerInputsDigest: "0".repeat(64) });
    if (qualificationMode === "help") return Object.freeze({ ...bundle, indexRevision: "0".repeat(64) });
    if (qualificationMode === "compiler") return Object.freeze({ ...bundle, compilerSha256: "0".repeat(64) });
    return bundle;
  }, transport: { choose: async () => { calls++; throw new Error("unexpected provider"); } } });
  try {
    let edit = 0;
    const changed = async (routing: unknown, expected: string, checkState: "errors" | "limited" | "incomplete" = "errors") => {
      producer.routing = routing;
      writeFileSync(fixture.app, `${rankSource}## context ${edit++}\n`);
      const { revision } = await settledRankingCheck(fixture, checkState);
      expect(await fixture.rank(revision)).toMatchObject({ state: expected });
    };
    await changed({ version: 1, disposition: "structural", ids: [], complete: false }, "structural");
    await changed({ version: 1, disposition: "none", ids: [], complete: true }, "none");
    const { context: _context, ...withoutContext } = rankRouting();
    await changed(withoutContext, "candidate_coverage_unknown");
    for (const context of [null, { ...rankingContext(), extra: "bad" }, { ...rankingContext(), version: 2 }]) {
      await changed(rankRouting(rankIds, context), "candidate_coverage_unknown");
    }
    for (const flag of ["exactSourceSpan", "recoveryComplete", "nameFilterComplete"]) {
      await changed(rankRouting(rankIds, { ...rankingContext(), [flag]: false }), "ineligible");
    }
    await changed(rankRouting(rankIds, { ...rankingContext(), guess: "wrong" }), "ineligible");
    for (const mode of ["missing", "mutable", "profile", "producer", "help", "compiler", "branch"]) {
      qualificationMode = mode;
      await changed(rankRouting(), "candidate_coverage_unknown");
    }
    qualificationMode = "valid";
    for (const line of ['"widgit"', "# widgit", "## widgit"]) {
      const source = `app Office\nGiven\nWhen\nThen\n${line}\n`;
      producer.routing = rankRouting();
      producer.primary = { start: source.indexOf("widgit"), end: source.indexOf("widgit") + 6 };
      writeFileSync(fixture.app, source);
      const { revision } = await settledRankingCheck(fixture);
      expect(await fixture.rank(revision)).toMatchObject({ state: "ineligible" });
    }
    producer.primary = { start: rankSource.indexOf("widgit"), end: rankSource.indexOf("widgit") + 6 };
    producer.omitted = 1;
    await changed(rankRouting(), "ineligible", "limited");
    producer.omitted = 0;
    producer.complete = false;
    await changed(rankRouting(), "ineligible", "incomplete");
    producer.complete = true;
    await changed(rankRouting(rankIds, { ...rankingContext(), materialIntentChoice: true }), "intent_required");
    await changed(rankRouting(rankIds, { ...rankingContext(), evidenceSufficient: false }), "intent_unclear");
    expect(calls).toBe(0);
  } finally { await fixture.owner.stop(); }
});

it("awaits card qualification without granting a ranking branch and refuses an edited source before disclosure", async () => {
  let calls=0, release: (() => void) | undefined, entered: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const fixture=await rankingFixture({ allowExternal: () => true,
    qualify: async request => {
      if (gate) { entered?.(); await gate; }
      return Object.freeze({...syntheticQualification(request),messageKinds:Object.freeze([])});
    }, transport:{choose:async request=>{calls++;return rankAnswer(request,rankIds[0]!);}} });
  try {
    const detail=await fixture.client.request({command:"diagnostic.detail",payload:{revision:fixture.checked.revision,index:0}});
    expect(detail).toMatchObject({construct_help:{candidateCoverage:"complete",
      classification:rankIds.map(id=>({id,profile:"included",working:"qualified"}))}});
    expect(await fixture.rank()).toMatchObject({state:"candidate_coverage_unknown"});
    let started!: () => void;
    const starting=new Promise<void>(resolve=>{started=resolve;}); entered=started;
    gate=new Promise<void>(resolve=>{release=resolve;});
    const pending=fixture.rank(); await starting;
    writeFileSync(fixture.app,`${rankSource}## Changed while actual qualification was pending.\n`);
    release!();
    expect(await pending).toMatchObject({state:"stale"});
    expect(calls).toBe(0);
  } finally {release?.();await fixture.owner.stop();}
});

it("refreshes diagnostic detail after pending qualification when source changes before watcher delivery", async () => {
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const fixture = await rankingFixture({ qualify: async request => {
    if (gate !== undefined) { entered!(); await gate; }
    return Object.freeze({ ...syntheticQualification(request), messageKinds: Object.freeze([]) });
  } });
  let restoreWatcher: (() => void) | undefined;
  try {
    const payload = { revision: fixture.checked.revision, index: 0 };
    expect(await fixture.client.request({ command: "diagnostic.detail", payload })).toMatchObject({
      current: true, construct_help: { candidateCoverage: "complete" },
    });
    const started = new Promise<void>(resolve => { entered = resolve; });
    gate = new Promise<void>(resolve => { release = resolve; });
    const pending = fixture.client.request({ command: "diagnostic.detail", payload });
    await started;
    // Hold only the watcher hint; the actual source capture and explicit
    // refresh remain real, so this check cannot pass through watcher timing.
    const delayedWatcher = vi.spyOn(DevSessionCore.prototype, "markDirty").mockImplementation(() => undefined);
    restoreWatcher = () => { delayedWatcher.mockRestore(); };
    writeFileSync(fixture.app, `${rankSource}## Edited while diagnostic qualification was pending.\n`);
    expect(await fixture.client.request({ command: "status" })).toMatchObject({
      revision: fixture.checked.revision, dirty: false,
    });
    release!();
    const detail = await pending as { construct_help: { cards: { status: string }[];
      classification: { working: string }[] } };
    expect(detail).toMatchObject({ revision: fixture.checked.revision, current: false,
      source: { sha256: createHash("sha256").update(rankSource).digest("hex") },
      diagnostic: { message: "source error" }, construct_help: { candidateCoverage: "unknown" },
    });
    expect(detail.construct_help.cards.every(card => card.status !== "working")).toBe(true);
    expect(detail.construct_help.classification.every(card => card.working === "unqualified")).toBe(true);
  } finally {
    release?.();
    restoreWatcher?.();
    await fixture.owner.stop();
  }
});

it("stop aborts and waits for private qualification cleanup without retaining its late bundle", async () => {
  let entered!: () => void, aborted!: () => void, cleanup!: () => void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const cancelled=new Promise<void>(resolve=>{aborted=resolve;});
  const disposal=new Promise<void>(resolve=>{cleanup=resolve;});
  let disposed=false, calls=0;
  const fixture=await rankingFixture({allowExternal:()=>true,
    qualify:async(request,signal)=>{
      expect(signal).toBeDefined(); entered();
      await new Promise<void>(resolve=>signal!.addEventListener("abort",()=>{aborted();resolve();},{once:true}));
      await disposal; disposed=true;
      return syntheticQualification(request);
    },transport:{choose:async request=>{calls++;return rankAnswer(request,rankIds[0]!);}}});
  try {
    const pending=fixture.rank().then(()=>"completed",()=>"cancelled"); await started;
    let stopped=false;
    const stopping=fixture.owner.stop().then(()=>{stopped=true;});
    await cancelled; expect(stopped).toBe(false); expect(disposed).toBe(false);
    cleanup(); await stopping;
    expect(disposed).toBe(true); expect(await pending).toBe("cancelled"); expect(calls).toBe(0);
  } finally {cleanup();await fixture.owner.stop();}
});

it("defaults to no disclosure, permits a deterministic single card, and reports absent provider", async () => {
  const fixture = await rankingFixture({ qualify: syntheticQualification });
  try {
    expect(await fixture.rank()).toMatchObject({ state: "ranking_disallowed" });
    producer.routing = rankRouting([rankIds[0]!]);
    writeFileSync(fixture.app, `${rankSource}## single\n`);
    const { revision } = await settledRankingCheck(fixture);
    expect(await fixture.rank(revision)).toMatchObject({ state: "deterministic", card: { id: rankIds[0] } });
  } finally { await fixture.owner.stop(); }
  producer.routing = undefined;
  const noProvider = await rankingFixture({ qualify: syntheticQualification, allowExternal: () => true });
  try { expect(await noProvider.rank()).toEqual({ state: "ranking_unavailable", reason: "no_provider" }); }
  finally { await noProvider.owner.stop(); }
});

it("pins pending lookup to the captured revision, checks help currency, and aborts owned work on stop", async () => {
  let signal: AbortSignal | undefined;
  let request: JevChoiceRequest | undefined;
  let finish: ((value: unknown) => void) | undefined;
  const fixture = await rankingFixture({ qualify: syntheticQualification, allowExternal: () => true,
    inlineBudgetMs: 1, providerDeadlineMs: 1000,
    transport: { choose: (value, nextSignal) => { request = value; signal = nextSignal; return new Promise(resolve => { finish = resolve; }); } } });
  try {
    const pending = await fixture.rank();
    expect(pending.state).toBe("pending");
    if (pending.state !== "pending") throw new Error("missing pending ref");
    const lookup = () => fixture.control(["rank.lookup", "--revision", fixture.checked.revision, "--ref", pending.ref]);
    expect(await lookup()).toMatchObject({ ok: true, result: { result: { state: "pending" } } });
    expect(await fixture.control(["rank.lookup", "--revision", "r999", "--ref", pending.ref]))
      .toMatchObject({ ok: false, code: "RANK_UNAVAILABLE" });
    finish?.(rankAnswer(request!, rankIds[0]!));
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(await lookup()).toMatchObject({ ok: true, result: { result: { state: "likely" } } });
    writeFileSync(join(fixture.root, "docs/specification/CONSTRUCT-HELP.md"), "changed help");
    expect(await lookup()).toMatchObject({ ok: true, result: { result: { state: "stale" } } });
  } finally { await fixture.owner.stop(); }
  expect(signal?.aborted).toBe(true);

  producer.routing = undefined;
  let cancelled = false;
  const hanging = await rankingFixture({ qualify: syntheticQualification, allowExternal: () => true,
    inlineBudgetMs: 1, providerDeadlineMs: 10000, transport: { choose: (_request, nextSignal) => {
      nextSignal.addEventListener("abort", () => { cancelled = true; }); return new Promise(() => {});
    } } });
  expect(await hanging.rank()).toMatchObject({ state: "pending" });
  await hanging.owner.stop();
  expect(cancelled).toBe(true);
});

it("keeps serving preview and captured diagnostics when provider work times out or fails, and refuses a raced source", async () => {
  for (const mode of ["timeout", "failure", "invalid", "source-race", "unqualified"]) {
    producer.routing = undefined;
    let fixture: Awaited<ReturnType<typeof rankingFixture>>;
    fixture = await rankingFixture({ ...(mode === "unqualified" ? {} : { qualify: syntheticQualification }),
      allowExternal: () => true, inlineBudgetMs: 1, providerDeadlineMs: 15, transport: { choose: async request => {
        if (mode === "timeout") return new Promise(() => {});
        if (mode === "failure") throw new Error("PRIVATE_PROVIDER_SECRET");
        if (mode === "invalid") return { prose: "PRIVATE_PROVIDER_SECRET" };
        if (mode === "source-race") writeFileSync(fixture.app, `${rankSource}## raced source\n`);
        return rankAnswer(request, rankIds[0]!);
      } } });
    try {
      let result = await fixture.rank();
      if (result.state === "pending") {
        await new Promise(resolve => setTimeout(resolve, 25));
        result = controlResult<{ result: RankResult }>(await fixture.control([
          "rank.lookup", "--revision", fixture.checked.revision, "--ref", result.ref,
        ])).result;
      }
      expect(result).toMatchObject(mode === "source-race" ? { state: "stale" }
        : mode === "unqualified" ? { state: "candidate_coverage_unknown" }
        : { state: "ranking_unavailable", reason: mode === "timeout" ? "timeout" : mode === "invalid" ? "invalid_response" : "transport_error" });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_PROVIDER_SECRET");
      expect(await fixture.client.request({ command: "diagnostic.detail", payload: { revision: fixture.checked.revision, index: 0 } }))
        .toMatchObject({ diagnostic: { message: "source error", code: "E1001" } });
      expect(await fixture.client.request({ command: "preview.status" })).toMatchObject({ state: "ready", serving_revision: fixture.original.revision });
    } finally { await fixture.owner.stop(); }
  }
});

it("retains each failed rerun under its own safe ref and original revision, with bounded eviction", async () => {
  const fixture = await ownerFixture();
  try {
    const checked = await fixture.client.request({ command: "check" }) as { revision: string };
    const original = await fixture.client.request({ command: "example.run", payload: { expectedRevision: checked.revision } }) as {
      run_id: string; focus: { ref: string; source_revision: string; serving_build: string }; artifact_digest: string;
    };
    const firstPage = await fixture.client.request({ command: "failures", payload: { revision: checked.revision, limit: 1 } }) as {
      next_after: number | null;
    };
    // A source edit cannot replace the retained recipe or relabel its occurrence.
    writeFileSync(fixture.app, "app Office\nGiven\nWhen\nThen\n## rerun after edit\n");
    const newer = await fixture.client.request({ command: "check" }) as { revision: string };
    expect(newer.revision).not.toBe(checked.revision);
    const rerun = await fixture.client.request({ command: "example.rerun", payload: { ref: original.focus.ref } }) as {
      ok: boolean; original: { run_id: string }; rerun: { run_id: string };
      focus: { ref: string; revision: string; source_revision: string; serving_build: string; owner_ref: { run_id: string } };
    };
    expect(rerun.ok).toBe(true);
    expect(rerun.original.run_id).toBe(original.run_id);
    expect(rerun.focus.ref).not.toBe(original.focus.ref);
    expect(rerun.focus).toMatchObject({ revision: checked.revision, source_revision: original.focus.source_revision,
      serving_build: original.focus.serving_build, owner_ref: { run_id: rerun.rerun.run_id } });
    expect(rerun.rerun.run_id).not.toBe(original.run_id);
    const originalLookup = await fixture.client.request({ command: "failure.lookup", payload: { ref: original.focus.ref } });
    expect(originalLookup).toMatchObject({ revision: checked.revision, owner_ref: { run_id: original.run_id } });
    const detail = await fixture.client.request({ command: "failure.detail", payload: { ref: rerun.focus.ref } });
    expect(detail).toMatchObject({ revision: checked.revision, source_revision: original.focus.source_revision,
      detail: { outcome: "failed", artifact_digest: original.artifact_digest, mismatch_count: 1 } });
    expect(JSON.stringify({ rerun, detail, originalLookup })).not.toMatch(/PRIVATE_(?:CALLER|ROLE|RUNTIME_MESSAGE|EXPECTED|ACTUAL)/);
    const page = await fixture.client.request({ command: "failures", payload: { revision: checked.revision, limit: 25 } }) as {
      failures: { ref: string }[];
    };
    expect(page.failures.map(item => item.ref)).toEqual([original.focus.ref, rerun.focus.ref]);
    // Passed attempts add neither a failure nor a disclosure-bearing report.
    producer.passed = true;
    const passed = await fixture.client.request({ command: "example.rerun", payload: { ref: rerun.focus.ref } });
    expect(passed).not.toHaveProperty("focus");
    expect((await fixture.client.request({ command: "failures", payload: { revision: checked.revision } }) as {
      total_retained: number;
    }).total_retained).toBe(2);
    // Exercise the existing shared 64-entry store using real session callbacks.
    // These new-build HTTP records evict old refs without resetting cursor IDs.
    for (let index = 0; index < 64; index++) fixture.emitRefusal({ requestId: `rerun-evict-${index}`, status: 403,
      error: { code: "forbidden", message: "denied" } });
    await expect(fixture.client.request({ command: "failure.lookup", payload: { ref: original.focus.ref } }))
      .rejects.toMatchObject({ code: "FAILURE_UNAVAILABLE" });
    await expect(fixture.client.request({ command: "failure.detail", payload: { ref: rerun.focus.ref } }))
      .rejects.toMatchObject({ code: "FAILURE_UNAVAILABLE" });
    await expect(fixture.client.request({ command: "example.rerun", payload: { ref: rerun.focus.ref } }))
      .rejects.toMatchObject({ code: "RERUN_UNAVAILABLE" });
    const evicted = await fixture.client.request({ command: "failures", payload: { revision: checked.revision,
      ...(firstPage.next_after === null ? {} : { after: firstPage.next_after }) } }) as { total_retained: number };
    expect(evicted.total_retained).toBe(0);
  } finally { await fixture.owner.stop(); }
});
