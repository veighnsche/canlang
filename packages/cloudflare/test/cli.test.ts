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

function runCli(args: string[], env?: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI.pathname, ...args],
      { timeout: 15000, ...(env === undefined ? {} : { env }) },
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
      version: "0.1.1",
    });
  });

  it("--help still emits exactly one envelope (exit 0)", async () => {
    const result = await runCli(["--help"]);
    expect(result.code).toBe(0);
    const body = envelope(result.stdout);
    expect(body).toMatchObject({ ok: true, name: "can-platform", version: "0.1.1" });
    expect(typeof body["usage"]).toBe("string");
    expect(result.stderr).toContain("Usage:");
  });

  it("-h and -V match their long aliases", async () => {
    const help = await runCli(["-h"]);
    expect(help.code).toBe(0);
    const helpBody = envelope(help.stdout);
    expect(helpBody).toMatchObject({ ok: true, name: "can-platform", version: "0.1.1" });
    expect(typeof helpBody["usage"]).toBe("string");
    const version = await runCli(["-V"]);
    expect(version.code).toBe(0);
    expect(envelope(version.stdout)).toEqual({
      ok: true,
      name: "can-platform",
      version: "0.1.1",
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
    expect(body).toMatchObject({ ok: true, name: "can-platform", version: "0.1.1" });
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

  it("test reports its exact missing native producer after the child joins", async () => {
    const artifact = fixtureArtifact();
    try {
      const result = await runCli(["test", "--artifact", artifact], {
        ...process.env, CAN_DEV_BIN: join(dirname(artifact), "missing-native-dev"),
      });
      expect(result.code).toBe(2);
      expect(envelope(result.stdout)).toMatchObject({
        ok: false, command: "test", code: "missing-producer", producer: "dev-server",
        contract: "native saved-artifact examples",
      });
    } finally { rmSync(dirname(artifact), { recursive: true, force: true }); }
  });

  it.each(["build", "deploy"])(
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
  executeWait: undefined as ((signal: AbortSignal) => Promise<void>) | undefined,
}));
const runLifetime = vi.hoisted(() => ({
  active: false,
  workDirs: [] as string[],
  removals: [] as string[],
  failures: new Map<string, unknown>(),
  assembleWait: undefined as (() => Promise<void>) | undefined,
  cleanupWait: undefined as (() => Promise<void>) | undefined,
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
        await runLifetime.cleanupWait?.();
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
    await runLifetime.assembleWait?.();
    return { entryUrl: pathToFileURL(entryPath).href };
  },
}));
vi.mock("../src/cli/artifact-defaults.js", () => ({
  resolveLocalDefaults: () => ({ workerName: "example-worker", compatibilityDate: "2026-10-09" }),
}));
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  return { ...actual, spawn: (binary: string, args: string[]) => {
    expect(binary).toBe(process.env.CAN_DEV_BIN ?? "can-dev");
    expect(args).toEqual(["examples-artifact", "--artifact", "/artifact.json", "--root", process.cwd()]);
    const controller = new AbortController();
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(),
      kill(signal: string) {
        expect(signal).toBe("SIGTERM");
        examples.events.push("SIGTERM");
        controller.abort(new DOMException("native example cancelled", "AbortError"));
        return true;
      },
    });
    queueMicrotask(() => { void (async () => {
      let result: unknown = examples.result;
      try { exampleStage("execute"); await examples.executeWait?.(controller.signal); }
      catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          result = { ok: false, code: "command-cancelled", detail: "native examples cancelled" };
        } else { child.emit("error", new Error(String(error instanceof Error ? error.message : error))); child.emit("close", 1, null); return; }
      }
      child.stdout.emit("data", Buffer.from(JSON.stringify(result)));
      child.emit("close", (result as { ok: boolean }).ok ? 0 : 1, null);
    })(); });
    return child;
  } };
});
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
    runLifetime.assembleWait = undefined;
    runLifetime.cleanupWait = undefined;
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

  it("cancels run without publishing late assembly success and awaits acquired staging cleanup", async () => {
    runLifetime.active = true;
    const beforeInt = process.listenerCount("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    let assembled!: () => void;
    const assemblyEntered = new Promise<void>(resolve => { assembled = resolve; });
    let releaseAssembly!: () => void;
    const assemblyHeld = new Promise<void>(resolve => { releaseAssembly = resolve; });
    let cleaning!: () => void;
    const cleanupEntered = new Promise<void>(resolve => { cleaning = resolve; });
    let releaseCleanup!: () => void;
    const cleanupHeld = new Promise<void>(resolve => { releaseCleanup = resolve; });
    runLifetime.assembleWait = async () => { assembled(); await assemblyHeld; };
    runLifetime.cleanupWait = async () => { cleaning(); await cleanupHeld; };
    let reported = false;
    const result = invokePlatform("run").then(value => { reported = true; return value; });
    try {
      await assemblyEntered;
      process.emit("SIGINT");
      releaseAssembly();
      await cleanupEntered;
      expect(reported).toBe(false);
      expect(existsSync(join(runLifetime.workDirs[0]!, "partial.mjs"))).toBe(true);
      releaseCleanup();
      expect(await result).toEqual({ ok: false, command: "run", code: "command-cancelled", detail: "run command was cancelled" });
      expect(runLifetime.removals).toEqual(runLifetime.workDirs);
      expect(existsSync(runLifetime.workDirs[0]!)).toBe(false);
      expect(process.listenerCount("SIGINT")).toBe(beforeInt);
      expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    } finally {
      releaseAssembly();
      releaseCleanup();
      await result;
    }
  });

  it("preserves the primary assembly failure when cancelled during awaited cleanup", async () => {
    runLifetime.active = true;
    runLifetime.failures.set("assemble", new Error("primary assembly sentinel"));
    const beforeInt = process.listenerCount("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    let cleaning!: () => void;
    const cleanupEntered = new Promise<void>(resolve => { cleaning = resolve; });
    let releaseCleanup!: () => void;
    const cleanupHeld = new Promise<void>(resolve => { releaseCleanup = resolve; });
    runLifetime.cleanupWait = async () => { cleaning(); await cleanupHeld; };
    let reported = false;
    const result = invokePlatform("run").then(value => { reported = true; return value; });
    try {
      await cleanupEntered;
      process.emit("SIGINT");
      expect(reported).toBe(false);
      expect(existsSync(join(runLifetime.workDirs[0]!, "partial.mjs"))).toBe(true);
      releaseCleanup();
      expect(await result).toEqual({ ok: false, command: null, code: "internal", detail: "primary assembly sentinel" });
      expect(runLifetime.removals).toEqual(runLifetime.workDirs);
      expect(existsSync(runLifetime.workDirs[0]!)).toBe(false);
      expect(process.listenerCount("SIGINT")).toBe(beforeInt);
      expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    } finally {
      releaseCleanup();
      await result;
    }
  });
});

describe("test CLI compiled example execution", () => {
  const stages = ["execute"];
  afterEach(() => {
    vi.restoreAllMocks();
    examples.events = [];
    examples.failures.clear();
    examples.result = { ok: true, executed: 3, report: { summary: { total: 3 } } };
    examples.emitted = undefined;
    examples.executeWait = undefined;
    vi.useRealTimers();
  });

  async function invokeTest(): Promise<Record<string, unknown>> {
    return invokePlatform("test");
  }

  it("delegates exact saved artifact and root to native examples, then reports exact results", async () => {
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

  it.each(["late success", "owned AbortError"])("sends SIGTERM at the command deadline and joins native cleanup before refusing its %s", async mode => {
    vi.useFakeTimers();
    const beforeInt = process.listenerCount("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    const beforeTimers = vi.getTimerCount();
    let executing!: () => void;
    const entered = new Promise<void>(resolve => { executing = resolve; });
    let aborted!: () => void;
    const interrupted = new Promise<void>(resolve => { aborted = resolve; });
    let releaseCleanup!: () => void;
    const cleanupHeld = new Promise<void>(resolve => { releaseCleanup = resolve; });
    let signal: AbortSignal | undefined;
    examples.executeWait = async actualSignal => {
      signal = actualSignal;
      actualSignal.addEventListener("abort", aborted, { once: true });
      executing();
      await interrupted;
      await cleanupHeld;
      if (mode === "owned AbortError") throw new DOMException("example runner: cancelled", "AbortError");
    };
    let reported = false;
    const result = invokeTest().then(value => { reported = true; return value; });
    try {
      await entered;
      await vi.advanceTimersByTimeAsync(300_000);
      await interrupted;
      expect(signal?.aborted).toBe(true);
      expect(signal?.reason).toMatchObject({ name: "AbortError" });
      expect(reported).toBe(false);
      releaseCleanup();
      expect(await result).toEqual({ ok: false, command: "test", code: "command-timeout", detail: "test command timed out" });
      expect(examples.events).toEqual([...stages, "SIGTERM"]);
      expect(process.listenerCount("SIGINT")).toBe(beforeInt);
      expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
      expect(vi.getTimerCount()).toBe(beforeTimers);
    } finally {
      releaseCleanup();
      await result;
    }
  });
});
