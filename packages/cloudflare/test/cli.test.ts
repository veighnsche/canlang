import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const CLI = new URL("../dist/cli/platform.js", import.meta.url);

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI.pathname, ...args],
      { timeout: 15000 },
      (error, stdout, stderr) => {
        const code =
          error !== null && "code" in error && typeof error.code === "number" ? error.code : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

function envelope(stdout: string): Record<string, unknown> {
  const lines = stdout.split("\n").filter((line) => line.length > 0);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] as string) as Record<string, unknown>;
}

function fixtureArtifact(): string {
  const dir = mkdtempSync(join(tmpdir(), "can-platform-"));
  const path = join(dir, "artifact.json");
  writeFileSync(path, JSON.stringify({ note: "opaque to the CLI" }));
  return path;
}

describe("can-platform CLI (L1 IR-03 delegation target)", () => {
  it("run returns a staged file URL usable after CLI exit until the caller removes it", async () => {
    const inputDir = mkdtempSync(join(tmpdir(), "can-platform-run-input-"));
    let workDir: string | undefined;
    try {
      const path = join(inputDir, "artifact.json");
      const js = 'export const marker = "retained-after-exit";\n';
      writeFileSync(path, JSON.stringify({
        artifact_version: 1, language_version: "1.0.0", tool_version: "0.1.0",
        sources: [{ path: "app.can", sha256: "b".repeat(64) }], modules: [{ path: "entry.mjs", js, map: {
          version: 3, file: "entry.mjs", sources: [], sourcesContent: [], names: [], mappings: "",
        } }], callables: [], pages: [], requires: [], tests: [],
      }));
      const result = await runCli(["run", "--artifact", path]);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      const body = envelope(result.stdout);
      expect(body).toMatchObject({ ok: true, callables: [], pages: [] });
      const entry = new URL(body["entry"] as string);
      expect(entry.protocol).toBe("file:");
      const entryPath = fileURLToPath(entry);
      workDir = dirname(dirname(entryPath));
      expect(workDir).toMatch(/can-platform-run-[^/]+$/);
      expect(readFileSync(entryPath, "utf8")).toContain(js);
      // A separate process consumes the returned entry after its producer exits.
      const imported = await new Promise<string>((resolve, reject) => {
        execFile(process.execPath, ["--input-type=module", "-e", "const m = await import(process.argv[1]); process.stdout.write(m.marker);", entry.href],
          { timeout: 15000 }, (error, stdout) => error === null ? resolve(stdout) : reject(error));
      });
      expect(imported).toBe("retained-after-exit");
      rmSync(workDir, { recursive: true, force: true });
      expect(existsSync(entryPath)).toBe(false);
    } finally {
      if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
      rmSync(inputDir, { recursive: true, force: true });
    }
  });

  it("--version prints the identity envelope", async () => {
    const result = await runCli(["--version"]);
    expect(result.code).toBe(0);
    expect(envelope(result.stdout)).toEqual({
      ok: true,
      name: "can-platform",
      version: "0.1.0",
    });
  });

  it("--help still emits exactly one envelope (exit 0)", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(0);
    const body = envelope(result.stdout);
    expect(body).toMatchObject({ ok: true, name: "can-platform", version: "0.1.0" });
    expect(typeof body["usage"]).toBe("string");
    expect(result.stderr).toContain("Usage:");
  });

  it("-h and -V match their long aliases", async () => {
    const help = await runCli(["-h"]);
    expect(help.code).toBe(0);
    const helpBody = envelope(help.stdout);
    expect(helpBody).toMatchObject({ ok: true, name: "can-platform", version: "0.1.0" });
    expect(typeof helpBody["usage"]).toBe("string");
    const version = await runCli(["-V"]);
    expect(version.code).toBe(0);
    expect(envelope(version.stdout)).toEqual({
      ok: true,
      name: "can-platform",
      version: "0.1.0",
    });
  });

  it("--env is accepted and run validates the artifact", async () => {
    const result = await runCli(["run", "--artifact", fixtureArtifact(), "--env", "staging"]);
    expect(result.code).toBe(2);
    const body = envelope(result.stdout);
    expect(body).toMatchObject({ ok: false, command: "run", code: "invalid-artifact" });
    expect(typeof body["detail"]).toBe("string");
  });

  it("duplicate flags are a usage failure", async () => {
    const path = fixtureArtifact();
    const dupArtifact = await runCli(["run", "--artifact", path, "--artifact", path]);
    expect(dupArtifact.code).toBe(2);
    expect(envelope(dupArtifact.stdout)).toMatchObject({ ok: false, code: "usage" });
    const dupEnv = await runCli(["run", "--artifact", path, "--env", "a", "--env", "b"]);
    expect(dupEnv.code).toBe(2);
    expect(envelope(dupEnv.stdout)).toMatchObject({ ok: false, code: "usage" });
  });

  it.each([["--help"], ["-h"]])("%s after a subcommand answers help (L1 verbatim passthrough)", async (flag) => {
    const result = await runCli(["run", flag]);
    expect(result.code).toBe(0);
    const body = envelope(result.stdout);
    expect(body).toMatchObject({ ok: true, name: "can-platform", version: "0.1.0" });
    expect(typeof body["usage"]).toBe("string");
    expect(result.stderr).toContain("Usage:");
  });

  it("trailing flag without a value is a usage failure", async () => {
    const result = await runCli(["run", "--artifact"]);
    expect(result.code).toBe(2);
    expect(envelope(result.stdout)).toMatchObject({ ok: false, code: "usage" });
  });

  it("no command is a usage failure", async () => {
    const result = await runCli([]);
    expect(result.code).toBe(2);
    const body = envelope(result.stdout);
    expect(body).toMatchObject({ ok: false, code: "usage" });
    expect(result.stderr).toContain("Usage:");
  });

  it("unknown command is a usage failure", async () => {
    const result = await runCli(["frobnicate", "--artifact", "x"]);
    expect(result.code).toBe(2);
    expect(envelope(result.stdout)).toMatchObject({ ok: false, code: "usage" });
  });

  it("missing --artifact is a usage failure", async () => {
    const result = await runCli(["run"]);
    expect(result.code).toBe(2);
    expect(envelope(result.stdout)).toMatchObject({ ok: false, code: "usage" });
  });

  it("unreadable artifact reports missing-artifact, not a producer error", async () => {
    const result = await runCli(["run", "--artifact", join(tmpdir(), "does-not-exist-7.can")]);
    expect(result.code).toBe(2);
    expect(envelope(result.stdout)).toMatchObject({
      ok: false,
      command: "run",
      code: "missing-artifact",
    });
  });

  it("run with a present-but-invalid artifact reports invalid-artifact", async () => {
    const result = await runCli(["run", "--artifact", fixtureArtifact()]);
    expect(result.code).toBe(2);
    const body = envelope(result.stdout);
    expect(body).toMatchObject({ ok: false, command: "run", code: "invalid-artifact" });
    expect(typeof body["detail"]).toBe("string");
  });

  it.each(["test", "build", "deploy"])(
    "%s with a present artifact reports the exact missing producer",
    async (command) => {
      const result = await runCli([command, "--artifact", fixtureArtifact()]);
      expect(result.code).toBe(2);
      const body = envelope(result.stdout);
      expect(body).toMatchObject({
        ok: false,
        command,
        code: "missing-producer",
        producer: "lane-01",
      });
      expect(typeof body["contract"]).toBe("string");
      expect(typeof body["detail"]).toBe("string");
    },
  );
});

// Exercise actual dispatch and preserve upstream capture/activation/execution
// ownership. The example runner owns scratch and row-scope cleanup internally.
const examples = vi.hoisted(() => ({
  events: [] as string[],
  failures: new Map<string, unknown>(),
  result: { ok: true, executed: 3, report: { summary: { total: 3 } } },
  emitted: undefined as ((value: unknown) => void) | undefined,
}));
const runLifetime = vi.hoisted(() => ({
  active: false,
  workDirs: [] as string[],
  removals: [] as string[],
  failures: new Map<string, unknown>(),
}));
function exampleStage(stage: string): void {
  examples.events.push(stage);
  if (examples.failures.has(stage)) throw examples.failures.get(stage);
}
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdtemp: async (prefix: string) => {
      const dir = await actual.mkdtemp(prefix);
      if (runLifetime.active) runLifetime.workDirs.push(dir);
      return dir;
    },
    rm: async (path: string, options: Parameters<typeof actual.rm>[1]) => {
      if (runLifetime.active) {
        runLifetime.removals.push(path);
        if (runLifetime.failures.has("cleanup")) throw runLifetime.failures.get("cleanup");
      }
      return actual.rm(path, options);
    },
    access: async () => {},
    readFile: async (file: string) => {
      exampleStage("read");
      expect(file).toBe("/artifact.json");
      return new Uint8Array([1, 2, 3]);
    },
  };
});
vi.mock("../src/runtime/artifact.js", () => ({
  loadArtifactFile: () => ({ artifact: { modules: [{ path: "worker.mjs" }], callables: [], pages: [], tests: [{}], sources: [{ path: "app.can" }] } }),
}));
vi.mock("../src/runtime/modules.js", () => ({
  assembleModules: async (_loaded: unknown, options: { workDir: string }) => {
    const entryPath = join(options.workDir, "partial.mjs");
    writeFileSync(entryPath, "export default {};\n");
    if (runLifetime.failures.has("assemble")) throw runLifetime.failures.get("assemble");
    return { entryUrl: pathToFileURL(entryPath).href };
  },
}));
vi.mock("../src/dev/zero-config.js", () => ({
  resolveLocalDefaults: () => ({ workerName: "example-worker", compatibilityDate: "2026-10-09" }),
}));
vi.mock("../src/dev/preview-inputs.js", () => ({
  prepareLocalPreviewCapture: (input: { appPath: string }) => {
    exampleStage("request");
    expect(input.appPath).toBe("app.can");
    return { appPath: input.appPath };
  },
}));
vi.mock("../src/dev/source-capture.js", () => ({
  captureSingleFileSource: async () => { exampleStage("capture"); return { sourceRevision: "revision" }; },
  verifyCompilerSources: () => { exampleStage("verify"); return { ok: true }; },
}));
vi.mock("../src/dev/preview-host.js", () => ({
  preflightLocalPreviewActivation: async () => { exampleStage("activate"); return { active: true }; },
  produceInstalledPortableBundle: async () => {
    exampleStage("bundle");
    return { bundle: { mainModule: "worker.mjs", modules: { "worker.mjs": "export default {};" }, binaries: {} } };
  },
}));
vi.mock("../src/dev/example-runner.js", () => ({
  MissingExampleTestkitError: class extends Error {},
  loadInstalledExampleTestkit: async (applicationRoot: string) => {
    expect(applicationRoot).toBe(process.cwd());
    exampleStage("testkit");
    return "testkit-port";
  },
  runCompiledExamples: async (input: unknown) => {
    exampleStage("execute");
    expect(input).toEqual({
      artifactBytes: new Uint8Array([1, 2, 3]), artifactLabel: "/artifact.json", sourceRevision: "revision",
      worker: { mainModule: "worker.mjs", modules: { "worker.mjs": "export default {};" }, binaryModules: {} },
      workerName: "example-worker", compatibilityDate: "2026-10-09", d1Binding: "DB", testkit: "testkit-port",
    });
    return examples.result;
  },
}));
vi.mock("../src/preparation/host.js", async (original) => ({
  ...await original<typeof import("../src/preparation/host.js")>(),
  emit: (value: unknown) => examples.emitted?.(value),
}));

async function invokePlatform(command: "run" | "test"): Promise<Record<string, unknown>> {
  vi.resetModules();
  vi.spyOn(process, "argv", "get").mockReturnValue([process.execPath, "platform", command, "--artifact", "/artifact.json"]);
  vi.spyOn(process.stderr, "write").mockImplementation(() => {
    if (runLifetime.failures.has("report")) throw runLifetime.failures.get("report");
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const result = new Promise<Record<string, unknown>>((resolve) => {
    examples.emitted = (value) => resolve(value as Record<string, unknown>);
  });
  await import("../src/cli/platform.js");
  return result;
}

describe("run CLI acquired staging lifetime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of runLifetime.workDirs) rmSync(dir, { recursive: true, force: true });
    runLifetime.active = false;
    runLifetime.workDirs = [];
    runLifetime.removals = [];
    runLifetime.failures.clear();
    examples.emitted = undefined;
  });

  it.each(["assemble", "report"])("removes acquired partial staging when %s fails", async (stage) => {
    runLifetime.active = true;
    runLifetime.failures.set(stage, new Error(`${stage} sentinel`));
    expect(await invokePlatform("run")).toEqual({ ok: false, command: null, code: "internal", detail: `${stage} sentinel` });
    expect(runLifetime.workDirs).toHaveLength(1);
    expect(runLifetime.removals).toEqual(runLifetime.workDirs);
    expect(existsSync(runLifetime.workDirs[0]!)).toBe(false);
  });

  it.each(["scalar sentinel", null, undefined])("preserves original thrown value %s if cleanup fails", async (failure) => {
    runLifetime.active = true;
    runLifetime.failures.set("assemble", failure);
    runLifetime.failures.set("cleanup", new Error("secondary cleanup failure"));
    expect(await invokePlatform("run")).toEqual({ ok: false, command: null, code: "internal", detail: String(failure) });
    expect(runLifetime.removals).toEqual(runLifetime.workDirs);
    expect(existsSync(join(runLifetime.workDirs[0]!, "partial.mjs"))).toBe(true);
  });
});

describe("test CLI compiled example execution", () => {
  const stages = ["request", "capture", "verify", "activate", "bundle", "testkit", "read", "execute"];
  afterEach(() => {
    vi.restoreAllMocks();
    examples.events = [];
    examples.failures.clear();
    examples.result = { ok: true, executed: 3, report: { summary: { total: 3 } } };
    examples.emitted = undefined;
  });

  async function invokeTest(): Promise<Record<string, unknown>> {
    return invokePlatform("test");
  }

  it("executes compiled rows with the verified source and portable worker, then reports exact results", async () => {
    expect(await invokeTest()).toEqual({ ok: true, command: "test", executed: 3, report: examples.result.report });
    expect(examples.events).toEqual(stages);
  });

  it.each(stages)("preserves the %s failure before demanding later stages", async (stage) => {
    examples.failures.set(stage, new Error(`${stage} sentinel`));
    expect(await invokeTest()).toEqual({ ok: false, command: null, code: "internal", detail: `${stage} sentinel` });
    expect(examples.events).toEqual(stages.slice(0, stages.indexOf(stage) + 1));
  });

  it.each(["scalar sentinel", undefined, null])("retains operative thrown value %s", async (failure) => {
    examples.failures.set("execute", failure);
    expect(await invokeTest()).toEqual({ ok: false, command: null, code: "internal", detail: String(failure) });
    expect(examples.events).toEqual(stages);
  });

  it("reports failed rows honestly and sets exitCode", async () => {
    examples.result.ok = false;
    const priorExitCode = process.exitCode;
    try {
      expect(await invokeTest()).toEqual({ ok: false, command: "test", executed: 3, report: examples.result.report });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = priorExitCode;
    }
  });
});
