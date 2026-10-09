import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ExampleReport, TableRowResult } from "@canlang/contracts";
import type { CompiledExampleInput } from "../src/dev/example-runner.js";
import { ExampleRerunCoordinator, ExampleRerunError, type ExampleAttemptResult } from "../src/dev/example-rerun.js";

const caller = { account: "u-1", team: "current" as const, roles: ["members"], authenticated: true };
const selector = { operation: "Office.supplies", rowIndex: 1 };

function failedResult(bytes: Uint8Array, sourceRevision: string, detail: string,
                      idempotency?: ExampleAttemptResult["idempotency"]): ExampleAttemptResult {
  const row: TableRowResult = { rowIndex: selector.rowIndex, caller, outcome: "failed", detail };
  const report: ExampleReport = {
    contractsVersion: 1,
    examplesVersion: 1,
    artifact: { digest: createHash("sha256").update(bytes).digest("hex"), sourceRevision },
    startedAt: "2026-10-09T10:00:00.000Z",
    finishedAt: "2026-10-09T10:00:01.000Z",
    cases: [{ kind: "table", operation: selector.operation, rows: [row] }],
    summary: { total: 1, passed: 0, failed: 1, setupFailed: 0, unsupported: 0 },
  };
  return { ok: false, executed: 1, report, ...(idempotency === undefined ? {} : { idempotency }) };
}

function input(bytes: Uint8Array): Omit<CompiledExampleInput, "selectedRow" | "runId"> {
  return {
    artifactBytes: bytes,
    artifactLabel: "Office.can.artifact.json",
    sourceRevision: "source-17",
    worker: { mainModule: "worker.js", modules: { "worker.js": "export default {};" } },
    workerName: "office",
    compatibilityDate: "2026-01-01",
    d1Binding: "DB",
    // The selected-run port below owns execution in this coordinator test.
    testkit: { loadExampleSuite() {}, runTable() {}, createReport() {}, fixtureValuesOf() {} },
    hooks: { materializeFixtures: async () => ({ materialized: [], values: new Map() }),
      invoke: async () => ({ ok: false, error: "not_called" }), observeLive: async () => null },
  };
}

describe("revision-pinned isolated example rerun", () => {
  it("uses copied artifact bytes, a new run ID and a single selected row; classifies a saved receipt", async () => {
    const sourceBytes = Uint8Array.from(Buffer.from("original compiled artifact"));
    const originalInput = input(sourceBytes);
    const wasmBytes = Uint8Array.from([1, 2, 3]);
    (originalInput.worker as { binaryModules?: Record<string, Uint8Array> }).binaryModules = { "values.wasm": wasmBytes };
    const calls: CompiledExampleInput[] = [];
    const coordinator = new ExampleRerunCoordinator({
      resourcesReady: async () => ({ available: true }),
      runSelected: async received => {
        calls.push(received);
        return failedResult(received.artifactBytes, received.sourceRevision, "saved rejection",
          { kind: "saved_outcome", receiptId: "receipt-1" });
      },
    });
    const artifact = coordinator.retainArtifact({ revision: "r17", fixtureRecipeId: "recipe-2",
      runtimeProfileId: "local-d1-1", input: originalInput });
    const original = coordinator.recordFailure({ artifactRef: artifact.artifactRef, selector,
      runId: "original-run", result: failedResult(sourceBytes, "source-17", "original failure") });

    sourceBytes[0] = 88; // caller edits its source buffer after retention
    wasmBytes[0] = 9;
    (originalInput.worker.modules as Record<string, string>)["worker.js"] = "changed";
    const result = await coordinator.rerun(original.failureRef);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.detail);
    expect(calls).toHaveLength(1);
    expect(Buffer.from(calls[0]!.artifactBytes).toString()).toBe("original compiled artifact");
    expect(calls[0]!.worker.modules["worker.js"]).toBe("export default {};");
    expect([...calls[0]!.worker.binaryModules!["values.wasm"]!]).toEqual([1, 2, 3]);
    expect(calls[0]!.selectedRow).toEqual(selector);
    expect(calls[0]!.runId).toBe(result.rerun.runId);
    expect(result.rerun.runId).not.toBe(original.original.runId);
    expect(result.artifact).toEqual(artifact);
    expect(result.original.row.detail).toBe("original failure");
    expect(result.rerun.row.detail).toBe("saved rejection");
    expect(result.rerun.idempotency).toEqual({ kind: "saved_outcome", receiptId: "receipt-1" });
    expect(result.inputs.changed).toContain("D1_row_scope");
    expect(result.replay.available).toBe(false);
    coordinator.close();
  });

  it("refuses an evicted artifact or unavailable resource before invoking the run port", async () => {
    let runCalls = 0;
    let ready = true;
    const coordinator = new ExampleRerunCoordinator({
      resourcesReady: async () => ready ? { available: true } : { available: false, reason: "D1 scope unavailable" },
      runSelected: async received => { runCalls += 1; return failedResult(received.artifactBytes, received.sourceRevision, "run failed"); },
    }, { maxArtifacts: 1 });
    const firstBytes = Uint8Array.from(Buffer.from("artifact one"));
    const first = coordinator.retainArtifact({ revision: "r1", fixtureRecipeId: "recipe", runtimeProfileId: "local-d1",
      input: input(firstBytes) });
    const failure = coordinator.recordFailure({ artifactRef: first.artifactRef, selector,
      runId: "first-run", result: failedResult(firstBytes, "source-17", "first failure") });
    const secondBytes = Uint8Array.from(Buffer.from("artifact two"));
    const second = coordinator.retainArtifact({ revision: "r2", fixtureRecipeId: "recipe", runtimeProfileId: "local-d1",
      input: input(secondBytes) });
    expect(await coordinator.rerun(failure.failureRef)).toMatchObject({ ok: false, code: "artifact_unavailable",
      original: { row: { detail: "first failure" } }, replay: { available: false } });

    const secondFailure = coordinator.recordFailure({ artifactRef: second.artifactRef, selector,
      runId: "second-run", result: failedResult(secondBytes, "source-17", "second failure") });
    ready = false;
    expect(await coordinator.rerun(secondFailure.failureRef)).toMatchObject({ ok: false, code: "resource_unavailable",
      detail: "D1 scope unavailable" });
    expect(runCalls).toBe(0);
    coordinator.close();
  });

  it("refuses unsupported rows instead of storing a replayable failure", () => {
    const bytes = Uint8Array.from(Buffer.from("artifact"));
    const coordinator = new ExampleRerunCoordinator({ resourcesReady: async () => ({ available: true }) });
    const artifact = coordinator.retainArtifact({ revision: "r3", fixtureRecipeId: "recipe", runtimeProfileId: "local-d1",
      input: input(bytes) });
    const failure = failedResult(bytes, "source-17", "cannot observe");
    const table = failure.report.cases[0];
    if (table?.kind !== "table") throw new Error("expected a table case");
    (table.rows as TableRowResult[])[0]!.outcome = "unsupported";
    expect(() => coordinator.recordFailure({ artifactRef: artifact.artifactRef, selector,
      runId: "original", result: failure })).toThrowError(ExampleRerunError);
    coordinator.close();
  });
});
