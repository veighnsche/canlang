import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// Exercise the actual CLI dispatch without starting workerd. Acquisitions and
// failures are controlled at their owning boundaries; scratch is real on disk.
const cleanup = vi.hoisted(() => ({
  directories: [] as string[],
  events: [] as string[],
  failures: new Map<string, unknown>(),
  emitted: undefined as ((value: unknown) => void) | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    access: async () => {},
    mkdtemp: async (prefix: string) => {
      cleanup.events.push("acquire");
      if (cleanup.failures.has("acquire")) throw cleanup.failures.get("acquire");
      const directory = await fs.mkdtemp(prefix);
      cleanup.directories.push(directory);
      return directory;
    },
    rm: async (directory: string, options: { recursive: boolean; force: boolean }) => {
      cleanup.events.push("remove");
      expect(options).toEqual({ recursive: true, force: true });
      if (cleanup.failures.has("remove")) throw cleanup.failures.get("remove");
      await fs.rm(directory, options);
    },
  };
});
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (file: Parameters<typeof fs.readFileSync>[0], options: unknown) => {
      if (file instanceof URL && file.pathname.includes("can-platform-test-")) {
        cleanup.events.push("read");
        if (cleanup.failures.has("read")) throw cleanup.failures.get("read");
      }
      return fs.readFileSync(file, options as "utf8");
    },
  };
});
vi.mock("../src/runtime/artifact.js", () => ({
  loadArtifactFile: () => ({ artifact: { modules: [{ path: "worker.mjs" }], tests: [] } }),
}));
vi.mock("../src/dev/zero-config.js", () => ({
  resolveLocalDefaults: () => ({ workerName: "cleanup-worker", compatibilityDate: "2026-10-09" }),
  assertDistReady: async () => {},
}));
vi.mock("../src/runtime/modules.js", () => ({
  assembleModules: async (_loaded: unknown, options: { workDir: string }) => {
    cleanup.events.push("assemble");
    writeFileSync(join(options.workDir, "worker.mjs"), "export default {};\n");
    if (cleanup.failures.has("assemble")) throw cleanup.failures.get("assemble");
    return { moduleUrls: { "worker.mjs": new URL(`file://${join(options.workDir, "worker.mjs")}`).href } };
  },
}));
vi.mock("../src/dev/row-scope.js", () => ({
  createLocalRowScope: async () => {
    cleanup.events.push("create");
    if (cleanup.failures.has("create")) throw cleanup.failures.get("create");
    return {
      snapshot: async () => {
        cleanup.events.push("snapshot");
        if (cleanup.failures.has("snapshot")) throw cleanup.failures.get("snapshot");
      },
      dispose: async () => {
        cleanup.events.push("dispose");
        if (cleanup.failures.has("dispose")) throw cleanup.failures.get("dispose");
      },
    };
  },
}));
vi.mock("../src/preparation/host.js", async (original) => ({
  ...await original<typeof import("../src/preparation/host.js")>(),
  emit: (value: unknown) => cleanup.emitted?.(value),
}));

describe("test CLI owned scratch lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of cleanup.directories) rmSync(directory, { recursive: true, force: true });
    cleanup.directories = [];
    cleanup.events = [];
    cleanup.failures.clear();
    cleanup.emitted = undefined;
  });

  async function invokeTest(): Promise<Record<string, unknown>> {
    vi.resetModules();
    vi.spyOn(process, "argv", "get").mockReturnValue([process.execPath, "platform", "test", "--artifact", "/artifact.json"]);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const result = new Promise<Record<string, unknown>>((resolve) => {
      cleanup.emitted = (value) => resolve(value as Record<string, unknown>);
    });
    await import("../src/cli/platform.js");
    return result;
  }

  it("reports success only after disposing the scope and removing scratch", async () => {
    expect(await invokeTest()).toMatchObject({ ok: true, command: "test", executed: 0 });
    expect(cleanup.events).toEqual(["acquire", "assemble", "read", "create", "snapshot", "dispose", "remove"]);
    expect(cleanup.directories).toHaveLength(1);
    expect(existsSync(cleanup.directories[0]!)).toBe(false);
  });

  it.each(["acquire", "assemble", "read", "create", "snapshot", "dispose", "remove"])(
    "preserves the %s failure and cleans every acquired resource", async (stage) => {
      cleanup.failures.set(stage, new Error(`${stage} sentinel`));
      expect(await invokeTest()).toEqual({ ok: false, command: null, code: "internal", detail: `${stage} sentinel` });
      const all = ["acquire", "assemble", "read", "create", "snapshot", "dispose", "remove"];
      const expected = all.slice(0, all.indexOf(stage) + 1);
      if (stage !== "acquire" && stage !== "remove") {
        if (stage === "snapshot") expected.push("dispose");
        expected.push("remove");
      }
      expect(cleanup.events).toEqual(expected);
      expect(cleanup.directories).toHaveLength(stage === "acquire" ? 0 : 1);
      for (const directory of cleanup.directories) expect(existsSync(directory)).toBe(stage === "remove");
    },
  );

  it.each([new Error("operation sentinel"), "scalar sentinel", undefined, null])(
    "retains operative failure %s when both cleanup steps also fail", async (failure) => {
      cleanup.failures.set("snapshot", failure);
      cleanup.failures.set("dispose", new Error("dispose sentinel"));
      cleanup.failures.set("remove", new Error("remove sentinel"));
      expect(await invokeTest()).toEqual({
        ok: false, command: null, code: "internal", detail: failure instanceof Error ? failure.message : String(failure),
      });
      expect(cleanup.events).toEqual(["acquire", "assemble", "read", "create", "snapshot", "dispose", "remove"]);
    },
  );

  it("retains disposal failure if removal also fails", async () => {
    cleanup.failures.set("dispose", new Error("dispose sentinel"));
    cleanup.failures.set("remove", new Error("remove sentinel"));
    expect(await invokeTest()).toMatchObject({ ok: false, detail: "dispose sentinel" });
    expect(cleanup.events).toEqual(["acquire", "assemble", "read", "create", "snapshot", "dispose", "remove"]);
  });
});
