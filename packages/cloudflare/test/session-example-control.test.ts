import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { BusinessError, CompileArtifact, ExampleReport, ObservationMismatch, OperationId, TableRowResult } from "@canlang/contracts";
import type { CompiledExampleInput } from "../src/dev/example-runner.js";
import { attachDevSessionService, startDevSessionService } from "../src/dev/session-service.js";
import { runDevControlArgv, type DevControlEnvelope } from "../src/dev/control-client.js";

function controlResult<T>(envelope: DevControlEnvelope): T {
  if (!envelope.ok) throw new Error(`expected successful ${envelope.command}: ${envelope.code}`);
  return envelope.result as T;
}

const producer = vi.hoisted(() => ({ calls: [] as unknown[], routing: undefined as unknown, passed: false }));
vi.mock("../src/dev/compiler-check.js", () => ({
  compileCapturedSingleFile: async (capture: { compilerOperand: string; sourceSha256: string }) => producer.routing !== undefined ? {
    kind: "diagnostics", envelope: { tool: "can", tool_version: "test-compiler", language_version: "1.0", schema_version: 1,
      sources: [{ id: 0, path: capture.compilerOperand, sha256: capture.sourceSha256 }], complete: true, omitted: 0,
      diagnostics: [{ code: "E1001", severity: "error", message: "source error", primary: { file: 0, start: 0, end: 1 },
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
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("retains compiler routing by revision without turning unqualified grammar IDs into working help", async () => {
  const fixture = await ownerFixture();
  try {
    producer.routing = { version: 1, disposition: "structural", ids: [], complete: false };
    const first = await fixture.client.request({ command: "check" }) as { revision: string; state: string };
    expect(first.state).toBe("errors");
    const query = async (revision: string) => fixture.client.request({ command: "diagnostic.detail", payload: { revision, index: 0 } });
    expect(await query(first.revision)).toMatchObject({ diagnostic: { construct_candidates: {
      disposition: "structural", complete: false,
    } }, construct_help: { candidateCoverage: "unknown", cards: [] } });
    writeFileSync(fixture.app, "app Office\nGiven\nWhen\nThen\n## exact slot\n");
    producer.routing = { version: 1, disposition: "exact", slot: "given_type", ids: ["can.v1.type.builtin.text"], complete: true };
    const second = await fixture.client.request({ command: "check" }) as { revision: string };
    expect(await query(second.revision)).toMatchObject({ diagnostic: { construct_candidates: {
      disposition: "exact", ids: ["can.v1.type.builtin.text"],
    } }, construct_help: { candidateCoverage: "unknown", cards: [] } });
    expect(await query(first.revision)).toMatchObject({ diagnostic: { construct_candidates: { disposition: "structural" } } });
  } finally { await fixture.owner.stop(); }
});

async function ownerFixture() {
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
  let admittedBytes: Uint8Array | null = null;
  const refusalObservers = new Set<(event: { requestId: string; status: number; error: BusinessError }) => void>();
  let unobserves = 0;
  const owner = await startDevSessionService({
    selectedApp: "Office", runtimeDir,
    capture: { checkoutRoot: root, appPath: "Office.can", profile: "local-d1-identity",
      compilerPath: "compiler", catalogPath: "catalog.json", helpIndexPath: "help.md",
      packageInputPaths: [{ name: "runtime", path: "runtime.js" }] },
    previewBuilder: async (_artifact: CompileArtifact, capture, artifactBytes) => {
      admittedBytes = artifactBytes;
      return { id: `build-${capture.sourceSha256.slice(0, 12)}`, dispose: async () => undefined,
      observeRefusals: (handler: (event: { requestId: string; status: number; error: BusinessError }) => void) => {
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
    emitRefusal: (event: { requestId: string; status: number; error: BusinessError }) => {
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

    writeFileSync(fixture.app, "app Office\nGiven\nWhen\nThen\n## next revision\n");
    const second = await fixture.client.request({ command: "check" }) as { revision: string };
    expect(second.revision).not.toBe(first.revision);
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
