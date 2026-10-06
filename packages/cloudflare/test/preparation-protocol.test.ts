/** P03.4: native launcher behind selection, live subprocess coverage. */
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompileArtifact } from "@canlang/contracts";
import { WORKER_MAIN_MISSING } from "../src/deploy/bundle.js";
import {
  buildBundleWithHostPhases,
  runCatalogPhase,
  runMcpBunPhase,
} from "../src/preparation/build-adapter.js";
import {
  PREPARATION_BIN_ENV,
  devBinaryPath,
  packagedBinaryPath,
  packagedTriple,
  packageRootDir,
  resolvePreparationBinary,
} from "../src/preparation/executable.js";
import { probeReadiness, runNativeJob, selectBackend } from "../src/preparation/host.js";

const MODES = ["build", "deploy-preview", "deploy-bare"] as const;

describe("preparation launcher: triple registry", () => {
  it("maps platform/arch/libc to packaged triples", () => {
    expect(packagedTriple({ platform: "darwin", arch: "arm64" })).toBe("darwin-arm64");
    expect(packagedTriple({ platform: "linux", arch: "x64" })).toBe("linux-x64-gnu");
    expect(packagedTriple({ platform: "linux", arch: "arm64", libc: "musl" })).toBe(
      "linux-arm64-musl",
    );
    expect(packagedTriple({ platform: "win32", arch: "x64" })).toBe("windows-x64");
  });

  it("builds packaged paths with .exe only on windows", () => {
    expect(packagedBinaryPath("/pkg", "darwin-arm64")).toBe(
      join("/pkg", "dist", "preparation", "darwin-arm64", "can-preparation"),
    );
    expect(packagedBinaryPath("/pkg", "windows-x64")).toBe(
      join("/pkg", "dist", "preparation", "windows-x64", "can-preparation.exe"),
    );
  });
});

describe("preparation launcher: live binary per mode", () => {
  it("resolves a launchable binary or fails with build instructions", async () => {
    const resolution = await resolvePreparationBinary().catch((error: Error) => error);
    if (resolution instanceof Error) {
      expect(resolution.message).toMatch(/cargo build --locked in packages\/cloudflare\/preparation/);
      throw new Error(`native binary absent: ${resolution.message}`);
    }
    expect(["env", "packaged", "dev"]).toContain(resolution.source);
  });

  for (const mode of MODES) {
    it(`runs the scaffold job for mode ${mode}`, async () => {
      const result = await runNativeJob("deploy", mode);
      expect(result.prepared.scaffold).toBe(true);
      expect(result.prepared.mode).toBe(mode);
      expect(result.prepared.stages).toEqual(["mcp_bun_probe", "catalog_probe"]);
      expect(result.prepared.resumes).toHaveLength(2);
    });
  }

  it("selects native on auto when a binary resolves", async () => {
    const selection = await selectBackend("auto");
    expect(selection.backend).toBe("native");
    expect(selection.resolution).not.toBeNull();
  });

  it("reports readiness for the resolved binary", async () => {
    const resolution = await resolvePreparationBinary();
    await expect(probeReadiness(resolution.path)).resolves.toBe(true);
  });
});

describe("preparation launcher: failure mapping", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** CLI failures exit(2) with a JSON envelope; capture both instead. */
  async function expectCliFail(
    run: () => Promise<unknown>,
    code: RegExp,
  ): Promise<{ exitCode: number; envelope: Record<string, unknown> }> {
    let exitCode = -1;
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process, "exit").mockImplementation(((c?: unknown) => {
      exitCode = (c as number) ?? 0;
      throw new Error(`__exit_${exitCode}__`);
    }) as typeof process.exit);
    await expect(run()).rejects.toThrow(`__exit_${2}__`);
    expect(exitCode).toBe(2);
    const envelope = JSON.parse(output.trim().split("\n").pop() as string) as Record<string, unknown>;
    expect(envelope["ok"]).toBe(false);
    expect(String(envelope["code"])).toMatch(code);
    return { exitCode, envelope };
  }

  async function withFakeBinary(script: string, run: () => Promise<unknown>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "can-prep-fake-"));
    const fake = join(dir, "can-preparation");
    writeFileSync(fake, script);
    chmodSync(fake, 0o755);
    const prior = process.env[PREPARATION_BIN_ENV];
    process.env[PREPARATION_BIN_ENV] = fake;
    try {
      await run();
    } finally {
      if (prior === undefined) delete process.env[PREPARATION_BIN_ENV];
      else process.env[PREPARATION_BIN_ENV] = prior;
    }
  }

  it("a tampered binary fails loudly, never silently", async () => {
    await withFakeBinary("#!/bin/sh\necho 'not a frame protocol'\n", async () => {
      await expectCliFail(() => runNativeJob("deploy", "build"), /^native-/);
    });
  });

  it("a hanging binary times out and is killed", async () => {
    // sleep-60 orphan proves group kill: completion well under 60s
    // means no grandchild survived holding stdio open.
    await withFakeBinary(
      "#!/bin/sh\npython3 -c 'import sys; sys.stdin.buffer.read(5)'\nsleep 60\n",
      async () => {
        await expectCliFail(
          () => runNativeJob("deploy", "build", undefined, { timeoutMs: 3_000 }),
          /^native-/,
        );
      },
    );
  }, 20_000);

  it("dev binary path stays under the package root", () => {
    expect(devBinaryPath(packageRootDir()).startsWith(packageRootDir())).toBe(true);
  });
});

describe("preparation build adapter: two real host phases (P05.2)", () => {
  const repoRoot = resolve(packageRootDir(), "..", "..");

  function testArtifact(): CompileArtifact {
    return {
      artifact_version: 1,
      language_version: "1.0.0",
      tool_version: "0.1.0",
      sources: [{ path: "app.can", sha256: "0".repeat(64) }],
      modules: [
        {
          path: "app/main.js",
          js: `import { util } from "./util.js";\nexport const descriptor = { util };\n`,
          map: { version: 3, file: "app.can", sources: [], sourcesContent: [], names: [], mappings: "" },
        },
        {
          path: "app/util.js",
          js: `export function util() { return "util"; }\n`,
          map: { version: 3, file: "app.can", sources: [], sourcesContent: [], names: [], mappings: "" },
        },
      ],
      callables: [],
      operations: [],
      pages: [{ owner: "test", path: "/main", module: "app/main.js", export: "descriptor" }],
      requires: [],
      tests: [],
    };
  }

  function fakeWorkerDist(): string {
    const dir = mkdtempSync(join(tmpdir(), "can-prep-adapter-"));
    writeFileSync(
      join(dir, "main.js"),
      `import { createMcpHandler } from "./mcp-handler.js";\n` +
        `export default { async fetch() { return Response.json({ mcp: typeof createMcpHandler }); } };\n`,
    );
    return dir;
  }

  it("adapter phases byte-match the bundle-embedded modules", () => {
    const artifact = testArtifact();
    const bundle = buildBundleWithHostPhases(artifact, {
      repoRoot,
      workerDistDir: fakeWorkerDist(),
      verdict: { active: true },
    });
    const bun = runMcpBunPhase(repoRoot);
    expect(bun.mcpHandlerJs).toBe(bundle.modules["worker/mcp-handler.js"]);
    expect(bun.httpOperationsJs).toBe(bundle.modules["worker/http-operations.js"]);
    expect(runCatalogPhase(artifact)).toBe(bundle.modules["worker/derived-inputs.js"]);
    expect(bundle.mcpBundleBytes).toBe(bun.mcpHandlerJs.length);
    expect(bundle.httpOperationsBytes).toBe(bun.httpOperationsJs.length);
  }, 120_000);

  it("catalog phase bakes empty operations deterministically", () => {
    expect(runCatalogPhase(testArtifact())).toBe("export const derivedInputs = {};\n");
  });

  it("legacy worker-missing path invokes neither phase", () => {
    const empty = mkdtempSync(join(tmpdir(), "can-prep-no-worker-"));
    const priorPath = process.env["PATH"];
    // Bun absent: any phase attempt would fail ENOENT-loud instead.
    process.env["PATH"] = "/nonexistent-p05_2";
    try {
      let code: unknown = null;
      try {
        buildBundleWithHostPhases(testArtifact(), {
          repoRoot,
          workerDistDir: empty,
          verdict: { active: true },
        });
      } catch (error) {
        code = (error as { code?: unknown }).code;
      }
      expect(code).toBe(WORKER_MAIN_MISSING);
    } finally {
      if (priorPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = priorPath;
    }
  });

  it("bun phase fails loud without bun (real spawn path, no stub)", () => {
    const priorPath = process.env["PATH"];
    process.env["PATH"] = "/nonexistent-p05_2";
    try {
      expect(() => runMcpBunPhase(repoRoot)).toThrow(/`bun` is not on PATH/);
    } finally {
      if (priorPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = priorPath;
    }
  });
});
