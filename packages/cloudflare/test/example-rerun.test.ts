import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExampleReport, TableRowResult } from "@canlang/contracts";
import { loadInstalledExampleTestkit, MissingExampleTestkitError, runCompiledExamples, type CompiledExampleInput } from "../src/dev/example-runner.js";
import { ExampleRerunCoordinator, ExampleRerunError, type ExampleAttemptResult } from "../src/dev/example-rerun.js";

const caller = { account: "u-1", team: "current" as const, roles: ["members"], authenticated: true };
const selector = { operation: "Office.supplies", rowIndex: 1 };

describe("application-owned installed example producer", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  function application(source?: string): { root: string; entry: string } {
    const root = mkdtempSync(join(tmpdir(), "can-example-application-"));
    roots.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", dependencies: {
      "@canlang/cloudflare": "0.1.0", "@canlang/testkit": "0.1.0",
    } }));
    const packageRoot = join(root, "node_modules", "@canlang", "testkit");
    const entry = join(packageRoot, "entry.js");
    if (source !== undefined) {
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ type: "module", exports: "./entry.js" }));
      writeFileSync(entry, source);
    }
    return { root, entry };
  }
  it("loads the application's exported entry and reuses its actual module identity", async () => {
    const first = application('export function loadExampleSuite() {} export function runTable() { return "first-app"; } export function createReport() {} export function fixtureValuesOf() {}');
    const second = application('export function loadExampleSuite() {} export function runTable() { return "second-app"; } export function createReport() {} export function fixtureValuesOf() {}');
    const kit = await loadInstalledExampleTestkit(first.root);
    expect(kit).toBe(await import(pathToFileURL(first.entry).href));
    expect(kit.runTable()).toBe("first-app");
    expect((await loadInstalledExampleTestkit(second.root)).runTable()).toBe("second-app");
  });
  it("refuses a missing application installation even when the workspace has Testkit", async () => {
    await expect(loadInstalledExampleTestkit(application().root)).rejects.toBeInstanceOf(MissingExampleTestkitError);
  });
  it("retains malformed-export validation at the owning check", async () => {
    const { root } = application('export function loadExampleSuite() {} export const runTable = 1;');
    await expect(loadInstalledExampleTestkit(root)).rejects.toThrow("example runner: missing testkit table runner producer");
  });
  it("retains import-time producer failures instead of relabeling them missing", async () => {
    const { root } = application('throw new Error("producer initialization sentinel");');
    await expect(loadInstalledExampleTestkit(root)).rejects.toThrow("producer initialization sentinel");
  });
});

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
  it("cancels hung readiness, never invokes a row, and keeps the recipe usable", async () => {
    const bytes = Uint8Array.from(Buffer.from("ready-cancellation-artifact"));
    const stale = new AbortController();
    const recipe = { ...input(bytes), signal: stale.signal };
    let checks = 0;
    let runs = 0;
    const coordinator = new ExampleRerunCoordinator({
      resourcesReady: async () => {
        checks += 1;
        if (checks === 1) return new Promise<never>(() => {});
        return { available: true };
      },
      runSelected: async received => {
        runs += 1;
        expect(received.signal).not.toBe(stale.signal);
        return failedResult(received.artifactBytes, received.sourceRevision, "fresh result");
      },
    });
    const artifact = coordinator.retainArtifact({ revision: "r17", fixtureRecipeId: "recipe",
      runtimeProfileId: "profile", input: recipe });
    const failure = coordinator.recordFailure({ artifactRef: artifact.artifactRef, selector,
      runId: "original", result: failedResult(bytes, "source-17", "original") });
    const canceled = new AbortController();
    const pending = coordinator.rerun(failure.failureRef, canceled.signal);
    await vi.waitFor(() => expect(checks).toBe(1));
    canceled.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(runs).toBe(0);
    stale.abort();
    const fresh = new AbortController();
    expect((await coordinator.rerun(failure.failureRef, fresh.signal)).ok).toBe(true);
    expect(runs).toBe(1);
    coordinator.close();
  });

  it("propagates an in-flight run abort and accepts a later fresh attempt", async () => {
    const bytes = Uint8Array.from(Buffer.from("run-cancellation-artifact"));
    let runs = 0;
    let receivedSignal: AbortSignal | undefined;
    let releaseCleanup: (() => void) | undefined;
    const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
    const coordinator = new ExampleRerunCoordinator({
      resourcesReady: async () => ({ available: true }),
      runSelected: async received => {
        runs += 1;
        receivedSignal = received.signal;
        if (runs === 1) {
          await new Promise<void>(resolve => {
            received.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          await cleanup; // Owner finishes disposing its row scope before rejecting.
          throw new DOMException("row canceled", "AbortError");
        }
        return failedResult(received.artifactBytes, received.sourceRevision, "fresh run");
      },
    });
    const artifact = coordinator.retainArtifact({ revision: "r17", fixtureRecipeId: "recipe",
      runtimeProfileId: "profile", input: input(bytes) });
    const failure = coordinator.recordFailure({ artifactRef: artifact.artifactRef, selector,
      runId: "original", result: failedResult(bytes, "source-17", "original") });
    const canceled = new AbortController();
    const pending = coordinator.rerun(failure.failureRef, canceled.signal);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await vi.waitFor(() => expect(runs).toBe(1));
    expect(receivedSignal).toBe(canceled.signal);
    canceled.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseCleanup?.();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(settled).toBe(true);
    const fresh = new AbortController();
    const result = await coordinator.rerun(failure.failureRef, fresh.signal);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rerun.runId).not.toBe(failure.original.runId);
    expect(runs).toBe(2);
    coordinator.close();
  });

  it("refuses a completed row if its runtime producer changed during execution", async () => {
    const bytes = Uint8Array.from(Buffer.from("post-run-change-artifact"));
    let current = true;
    let checks = 0;
    let runs = 0;
    const coordinator = new ExampleRerunCoordinator({
      resourcesReady: async () => { checks += 1; return current
        ? { available: true } : { available: false, reason: "runtime producer changed" }; },
      runSelected: async received => {
        runs += 1;
        if (runs === 1) current = false;
        return failedResult(received.artifactBytes, received.sourceRevision, "observed");
      },
    });
    const artifact = coordinator.retainArtifact({ revision: "r17", fixtureRecipeId: "recipe",
      runtimeProfileId: "profile", input: input(bytes) });
    const failure = coordinator.recordFailure({ artifactRef: artifact.artifactRef, selector,
      runId: "original", result: failedResult(bytes, "source-17", "original") });
    expect(await coordinator.rerun(failure.failureRef)).toMatchObject({ ok: false,
      code: "resource_unavailable", detail: "runtime producer changed" });
    expect(checks).toBe(2);
    current = true;
    const result = await coordinator.rerun(failure.failureRef);
    expect(result.ok).toBe(true);
    expect(runs).toBe(2);
    coordinator.close();
  });

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

const scratch = vi.hoisted(() => ({
  directories: [] as string[], events: [] as string[], failures: new Map<string, unknown>(), createScope: false,
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    mkdtemp: async (prefix: string) => {
      scratch.events.push("acquire");
      if (scratch.failures.has("acquire")) throw scratch.failures.get("acquire");
      const directory = await fs.mkdtemp(prefix); scratch.directories.push(directory); return directory;
    },
    rm: async (directory: string, options: { force: boolean; recursive: boolean }) => {
      scratch.events.push("remove");
      if (scratch.failures.has("remove")) throw scratch.failures.get("remove");
      await fs.rm(directory, options);
    },
  };
});
vi.mock("../src/runtime/artifact.js", async (original) => ({
  ...await original<typeof import("../src/runtime/artifact.js")>(),
  parseArtifactText: () => ({ artifact: { modules: [{ path: "worker.js" }], tests: [{ scope: "Office.supplies", fixtures: [], module: { path: "examples.js" } }] } }),
}));
vi.mock("../src/runtime/modules.js", async (original) => ({
  ...await original<typeof import("../src/runtime/modules.js")>(),
  assembleModules: async () => {
    scratch.events.push("assemble");
    if (scratch.failures.has("assemble")) throw scratch.failures.get("assemble");
    return { moduleUrls: { "examples.js": "file:///examples.js" } };
  },
}));
vi.mock("../src/dev/row-scope.js", () => ({
  createLocalRowScope: async () => {
    scratch.events.push("scope");
    if (scratch.failures.has("scope")) throw scratch.failures.get("scope");
    return {
      dev: { getD1Database: async () => {
        scratch.events.push("database");
        throw scratch.failures.get("database");
      } },
      dispose: async () => {
        scratch.events.push("dispose");
        if (scratch.failures.has("dispose")) throw scratch.failures.get("dispose");
      },
    };
  },
}));

describe("compiled example producer scratch lifetime", () => {
  afterEach(() => {
    for (const directory of scratch.directories) rmSync(directory, { recursive: true, force: true });
    scratch.directories = []; scratch.events = []; scratch.failures.clear(); scratch.createScope = false;
  });
  function run(): ReturnType<typeof runCompiledExamples> {
    const received = input(new Uint8Array([1, 2, 3]));
    const stage = (name: string) => {
      scratch.events.push(name);
      if (scratch.failures.has(name)) throw scratch.failures.get(name);
    };
    return runCompiledExamples({ ...received, testkit: {
      loadExampleSuite: async () => { stage("suite"); return {
        rows: [{ rowIndex: 1, caller: { kind: "public" }, seed: [], setup() {}, invoke() {}, observe() {} }], userFixtures: [],
      }; },
      runTable: async (spec: { createScope(row: number): Promise<unknown> }) => {
        stage("table");
        if (scratch.createScope) await spec.createScope(1);
        return { kind: "table", rows: [{}] };
      },
      createReport: () => ({ addCase() {}, build: () => {
        stage("report"); return { summary: { total: 1, failed: 0, setupFailed: 0, unsupported: 0 } };
      } }),
      fixtureValuesOf() {},
    } });
  }
  it("returns only after removing acquired scratch", async () => {
    expect(await run()).toMatchObject({ ok: true, executed: 1 });
    expect(scratch.events).toEqual(["acquire", "assemble", "suite", "table", "report", "remove"]);
    expect(existsSync(scratch.directories[0]!)).toBe(false);
  });
  it.each(["acquire", "assemble", "suite", "table", "report", "remove"])("preserves %s failure and attempts owned cleanup", async stage => {
    const failure = new Error(`${stage} sentinel`); scratch.failures.set(stage, failure);
    await expect(run()).rejects.toBe(failure);
    const phases = ["acquire", "assemble", "suite", "table", "report", "remove"];
    const expected = phases.slice(0, phases.indexOf(stage) + 1);
    if (stage !== "acquire" && stage !== "remove") expected.push("remove");
    expect(scratch.events).toEqual(expected);
  });
  it("retains body failure when removal also fails", async () => {
    const failure = new Error("suite sentinel"); scratch.failures.set("suite", failure);
    scratch.failures.set("remove", new Error("cleanup sentinel"));
    await expect(run()).rejects.toBe(failure);
    expect(scratch.events).toEqual(["acquire", "assemble", "suite", "remove"]);
  });
  it("disposes an acquired row scope after database provisioning failure", async () => {
    scratch.createScope = true;
    const failure = new Error("database sentinel"); scratch.failures.set("database", failure);
    scratch.failures.set("dispose", new Error("dispose sentinel"));
    await expect(run()).rejects.toBe(failure);
    expect(scratch.events).toEqual(["acquire", "assemble", "suite", "table", "scope", "database", "dispose", "remove"]);
  });
});
