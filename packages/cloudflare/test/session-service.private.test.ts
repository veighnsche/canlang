import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ExampleRerunCoordinator } from "../src/dev/example-rerun.js";
import { attachDevSessionService, startDevSessionService } from "../src/dev/session-service.js";

const race = vi.hoisted(() => ({
  onLoad: undefined as undefined | (() => Promise<void>),
  onRun: undefined as undefined | ((signal?: AbortSignal) => Promise<void>),
  runs: 0,
}));

vi.mock("../src/dev/compiler-check.js", () => ({
  compileCapturedSingleFile: async () => ({
    kind: "artifact", artifact: { tool_version: "test", language_version: "1.0" },
    artifactBytes: new Uint8Array([123, 125]),
  }),
}));
vi.mock("../src/dev/example-runner.js", () => ({
  loadInstalledExampleTestkit: async () => {
    await race.onLoad?.();
    return { loadExampleSuite() {}, runTable() {}, createReport() {}, fixtureValuesOf() {} };
  },
  runCompiledExamples: async (input: { signal?: AbortSignal }) => {
    race.runs += 1;
    await race.onRun?.(input.signal);
    return {
      ok: false, executed: 1,
      report: {
        cases: [{ kind: "table", operation: "OfficeSupplies.Supply.update",
          rows: [{ rowIndex: 0, outcome: "failed", detail: "row failed" }] }],
        summary: { total: 1, passed: 0, failed: 1, setupFailed: 0, unsupported: 0 },
      },
    };
  },
}));

afterEach(() => { race.onLoad = undefined; race.onRun = undefined; race.runs = 0; vi.restoreAllMocks(); });

async function ownerFixture() {
  const scratch = await mkdtemp(join(tmpdir(), "can-example-race-"));
  const root = join(scratch, "app");
  const runtimeDir = join(scratch, "runtime");
  await mkdir(root);
  await mkdir(runtimeDir);
  await writeFile(join(root, "Office.can"), "app OfficeSupplies\nGiven\n Supply { name:text }\nWhen\nThen\n");
  for (const name of ["compiler", "help.md", "runtime.js"]) await writeFile(join(root, name), name);
  const owner = await startDevSessionService({
    selectedApp: "OfficeSupplies", runtimeDir,
    capture: {
      checkoutRoot: root, appPath: "Office.can", profile: "local-d1-identity",
      compilerPath: "compiler", catalogPath: null, helpIndexPath: "help.md",
      packageInputPaths: [{ name: "runtime", path: "runtime.js" }],
    },
    previewBuilder: async (_artifact, capture) => ({
      id: "preview-test", dispose: async () => undefined,
      exampleInput: () => ({
        artifactBytes: new Uint8Array([123, 125]), artifactLabel: "Office.can",
        sourceRevision: capture.sourceRevision,
        worker: { mainModule: "worker.js", modules: { "worker.js": "export default {};" } },
        workerName: "test", compatibilityDate: "2026-01-01", d1Binding: "DB",
      }),
    }),
  });
  const client = await attachDevSessionService({ checkoutRoot: root, runtimeDir });
  const checked = await client.request({ command: "check" }) as { revision: string; preview: string };
  expect(checked.preview).toBe("ready");
  return { scratch, root, owner, client, revision: checked.revision };
}

it("refuses changed runtime bytes after Testkit first import before any row or retention", async () => {
  const fixture = await ownerFixture();
  const retained = vi.spyOn(ExampleRerunCoordinator.prototype, "retainArtifact");
  try {
    race.onLoad = async () => { await writeFile(join(fixture.root, "runtime.js"), "new producer bytes"); };
    await expect(fixture.client.request({ command: "example.run", payload: { expectedRevision: fixture.revision } }))
      .rejects.toMatchObject({ code: "CAPTURE_CHANGED" });
    expect(race.runs).toBe(0);
    expect(retained).not.toHaveBeenCalled();
    const failures = await fixture.client.request({ command: "failures", payload: { revision: fixture.revision } }) as { total_retained: number };
    expect(failures.total_retained).toBe(0);
  } finally {
    await fixture.owner.stop();
    await rm(fixture.scratch, { recursive: true, force: true });
  }
});

it("discards a completed failed row when producer bytes change during execution", async () => {
  const fixture = await ownerFixture();
  const retained = vi.spyOn(ExampleRerunCoordinator.prototype, "retainArtifact");
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    race.onRun = async () => { entered(); await gate; };
    const pending = fixture.client.request({ command: "example.run", payload: { expectedRevision: fixture.revision } });
    await started;
    await writeFile(join(fixture.root, "runtime.js"), "changed while row executes");
    release();
    await expect(pending).rejects.toMatchObject({ code: "CAPTURE_CHANGED" });
    expect(race.runs).toBe(1);
    expect(retained).not.toHaveBeenCalled();
    const failures = await fixture.client.request({ command: "failures", payload: { revision: fixture.revision } }) as { total_retained: number };
    expect(failures.total_retained).toBe(0);
  } finally {
    release();
    await fixture.owner.stop();
    await rm(fixture.scratch, { recursive: true, force: true });
  }
});

it("stop cancels an active example and queued requests without retaining late results", async () => {
  const fixture = await ownerFixture();
  const retained = vi.spyOn(ExampleRerunCoordinator.prototype, "retainArtifact");
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let disposed = false;
  race.onRun = async signal => {
    expect(signal).toBeDefined();
    entered();
    await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => {
      disposed = true;
      reject(new DOMException("cancelled", "AbortError"));
    }, { once: true }));
  };
  try {
    const active = fixture.client.request({ command: "example.run", payload: { expectedRevision: fixture.revision } });
    const activeOutcome = active.then(() => "completed", () => "cancelled");
    await started;
    const queued = fixture.client.request({ command: "example.run", payload: { expectedRevision: fixture.revision } });
    const queuedOutcome = queued.then(() => "completed", () => "cancelled");
    await fixture.owner.stop();
    expect(await activeOutcome).toBe("cancelled");
    expect(await queuedOutcome).toBe("cancelled");
    expect(disposed).toBe(true);
    expect(race.runs).toBe(1);
    expect(retained).not.toHaveBeenCalled();
  } finally {
    await fixture.owner.stop();
    await rm(fixture.scratch, { recursive: true, force: true });
  }
});
