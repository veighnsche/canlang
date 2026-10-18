/** P03.4: native launcher behind selection, live subprocess coverage. */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTRACTS_VERSION,
  type CompatibilityDescriptor,
  type CompileArtifact,
} from "@canlang/contracts";
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
import { LocalCommandInterrupted } from "../src/cli/command-lifetime.js";
import { launchPreparation, settleLaunchedChild } from "../src/preparation/executable.js";
import {
  probeReadiness,
  publishDeployAndApply,
  runNativeDeploy,
  runNativeJob,
  selectBackend,
} from "../src/preparation/host.js";
import { execFileSync } from "node:child_process";
import { buildDeployPlan } from "../src/deploy/plan.js";
import { renderWranglerToml } from "../src/deploy/render.js";
import {
  buildDeployBundleWithAssets,
  bundleMixedSha256,
  DEPLOY_DIR_SUFFIX,
  inventorizeAssets,
} from "../src/deploy/bundle.js";
import type { WranglerSpawner } from "../src/upgrade/apply.js";

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

  /** Frame-speaking fake: answers handshake/abort with the given payloads. */
  async function withFrameFake(
    accept: unknown,
    abortResponse: unknown,
    run: (binaryPath: string) => Promise<unknown>,
    extras: readonly unknown[] = [],
  ): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "can-prep-framefake-"));
    const fake = join(dir, "can-preparation");
    writeFileSync(
      fake,
      [
        `#!/usr/bin/env node`,
        `const ACCEPT = ${JSON.stringify(JSON.stringify(accept))};`,
        `const RESP = ${JSON.stringify(JSON.stringify(abortResponse))};`,
        `const EXTRAS = ${JSON.stringify(extras.map((extra) => JSON.stringify(extra)))};`,
        `let buf = Buffer.alloc(0);`,
        `function send(text) {`,
        `  const p = Buffer.from(text);`,
        `  const h = Buffer.alloc(5); h[0] = 0; h.writeUInt32LE(p.length, 1);`,
        `  process.stdout.write(Buffer.concat([h, p]));`,
        `}`,
        `process.stdin.on("data", (chunk) => {`,
        `  buf = Buffer.concat([buf, chunk]);`,
        `  while (buf.length >= 5) {`,
        `    const len = buf.readUInt32LE(1);`,
        `    if (buf.length < 5 + len) break;`,
        `    const msg = JSON.parse(buf.slice(5, 5 + len).toString());`,
        `    buf = buf.slice(5 + len);`,
        `    if (msg.protocol) send(ACCEPT);`,
        `    else if (msg.abort) { send(RESP); for (const extra of EXTRAS) send(extra); setTimeout(() => process.exit(0), 50); }`,
        `  }`,
        `});`,
        ``,
      ].join("\n"),
    );
    chmodSync(fake, 0o755);
    try {
      await run(fake);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("refuses a wrong-version accept frame (P09 protocol skew)", async () => {
    await withFrameFake(
      { ready: true, protocol: "can-preparation", version: 999, job: "test" },
      { error: { code: "aborted", detail: "aborted before begin" } },
      async (binaryPath) => {
        await expect(probeReadiness(binaryPath, { timeoutMs: 5000 })).resolves.toBe(false);
      },
    );
  });

  it("refuses a detail-only abort frame (substring is not validation)", async () => {
    await withFrameFake(
      { ready: true, protocol: "can-preparation", version: 1, job: "test" },
      { detail: "aborted" },
      async (binaryPath) => {
        await expect(probeReadiness(binaryPath, { timeoutMs: 5000 })).resolves.toBe(false);
      },
    );
  });

  it("a ready probe retains no deadline timer afterwards (048)", async () => {
    // Genuine handle check (not wall duration): a distinctive 9000ms
    // deadline must not survive the probe — neither the frame/exit
    // deadline nor the kill escalation may linger as active handles.
    const resolution = await resolvePreparationBinary();
    await expect(probeReadiness(resolution.path, { timeoutMs: 9000 })).resolves.toBe(true);
    const lingering = (process._getActiveHandles() as unknown[]).filter(
      (handle) =>
        typeof (handle as { _idleTimeout?: unknown })._idleTimeout === "number" &&
        (handle as { _idleTimeout: number })._idleTimeout === 9000,
    );
    expect(lingering).toEqual([]);
  });

  it("refuses an extra frame after a valid aborted answer (040)", async () => {
    await withFrameFake(
      { ready: true, protocol: "can-preparation", version: 1, job: "test" },
      { error: { code: "aborted", detail: "aborted before begin" } },
      async (binaryPath) => {
        await expect(probeReadiness(binaryPath, { timeoutMs: 5000 })).resolves.toBe(false);
      },
      [{ error: { code: "aborted", detail: "second answer" } }],
    );
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
    const bytes = new TextEncoder().encode(script);
    writeFileSync(fake, bytes);
    chmodSync(fake, 0o755);
    // Explicit-env binaries verify like all others: stage the genuine
    // sidecar for these exact bytes (a tampered fake would carry a
    // mismatching manifest and fail before launch).
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        triple: packagedTriple({ platform: process.platform, arch: process.arch }),
        binary: "can-preparation",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        toolchain: { rustc: "1.99.0", cargo: "1.99.0", pinned: "1.99.0" },
        lockfileSha256: "0".repeat(64),
        sourceHead: "test",
        release: "0.1.1",
      }),
    );
    const prior = process.env[PREPARATION_BIN_ENV];
    process.env[PREPARATION_BIN_ENV] = fake;
    try {
      await run();
    } finally {
      if (prior === undefined) delete process.env[PREPARATION_BIN_ENV];
      else process.env[PREPARATION_BIN_ENV] = prior;
    }
  }

  it("an explicit bare name launches the verified cwd file, never the PATH file (041)", async () => {
    // Concrete setup: valid frame-speaking cwd binary plus a different
    // garbage PATH binary under the same basename. Old code verified the
    // cwd file but spawned the raw name (PATH search); the resolved
    // absolute path must bind guard and launch to the verified file.
    const frameScript = [
      `#!/usr/bin/env node`,
      `let buf = Buffer.alloc(0);`,
      `function send(text) {`,
      `  const p = Buffer.from(text);`,
      `  const h = Buffer.alloc(5); h[0] = 0; h.writeUInt32LE(p.length, 1);`,
      `  process.stdout.write(Buffer.concat([h, p]));`,
      `}`,
      `process.stdin.on("data", (chunk) => {`,
      `  buf = Buffer.concat([buf, chunk]);`,
      `  while (buf.length >= 5) {`,
      `    const len = buf.readUInt32LE(1);`,
      `    if (buf.length < 5 + len) break;`,
      `    const msg = JSON.parse(buf.slice(5, 5 + len).toString());`,
      `    buf = buf.slice(5 + len);`,
      `    if (msg.protocol) send(JSON.stringify({ ready: true, protocol: "can-preparation", version: 1, job: "test" }));`,
      `    else if (msg.abort) { send(JSON.stringify({ error: { code: "aborted", detail: "aborted before begin" } })); setTimeout(() => process.exit(0), 50); }`,
      `  }`,
      `});`,
      ``,
    ].join("\n");
    const cwdDir = mkdtempSync(join(tmpdir(), "can-prep-cwd-"));
    const pathDir = mkdtempSync(join(tmpdir(), "can-prep-pathbin-"));
    writeFileSync(join(cwdDir, "can-preparation"), frameScript);
    writeFileSync(join(pathDir, "can-preparation"), `#!/bin/sh\necho 'wrong binary'\n`);
    chmodSync(join(cwdDir, "can-preparation"), 0o755);
    chmodSync(join(pathDir, "can-preparation"), 0o755);
    const priorCwd = process.cwd();
    const priorPath = process.env["PATH"];
    const priorEnv = process.env[PREPARATION_BIN_ENV];
    process.chdir(cwdDir);
    process.env["PATH"] = `${pathDir}${priorPath === undefined ? "" : `:${priorPath}`}`;
    process.env[PREPARATION_BIN_ENV] = "can-preparation";
    try {
      const resolution = await resolvePreparationBinary();
      // Absolute cwd-resolved path — never the raw searchable name.
      expect(realpathSync(resolution.path)).toBe(realpathSync(join(cwdDir, "can-preparation")));
      expect(resolution.path).not.toBe("can-preparation");
      expect(resolution.source).toBe("env");
      // The verified cwd file launches (valid handshake); the PATH
      // file would fail the frame protocol.
      await expect(probeReadiness(resolution.path, { timeoutMs: 5000 })).resolves.toBe(true);
    } finally {
      process.chdir(priorCwd);
      if (priorPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = priorPath;
      if (priorEnv === undefined) delete process.env[PREPARATION_BIN_ENV];
      else process.env[PREPARATION_BIN_ENV] = priorEnv;
      rmSync(cwdDir, { recursive: true, force: true });
      rmSync(pathDir, { recursive: true, force: true });
    }
  });

  /** PIDs of live can-preparation processes (cleanup discriminator). */
  function livePreparationPids(): number[] {
    try {
      const out = execFileSync("pgrep", ["-f", "[c]an-preparation"], { encoding: "utf8" }) as string;
      return out.split("\n").map((line) => Number(line)).filter((pid) => Number.isInteger(pid));
    } catch {
      return [];
    }
  }

  /** Full native-deploy fixtures (proven shapes from the differential workloads). */
  function writeNativeDeployFixtures(dir: string, previousPlan: string | null): string {
    const sha = "b".repeat(64);
    writeFileSync(
      join(dir, "nativedeploy.artifact.json"),
      JSON.stringify({
        artifact_version: 1,
        language_version: "1.0.0",
        tool_version: "0.1.0",
        sources: [{ path: "app.can", sha256: sha }],
        modules: [
          {
            path: "worker.mjs",
            js: 'export default { async fetch() { return new Response("ok"); } };\n',
            map: { version: 3, file: "worker.mjs", sources: [], sourcesContent: [], names: [], mappings: "" },
          },
        ],
        callables: [],
        operations: [],
        pages: [],
        requires: [],
        tests: [],
      }),
    );
    writeFileSync(
      join(dir, "nativedeploy.descriptor.json"),
      JSON.stringify({
        identity: {
          appName: "NativeDeploy",
          sourceRevision: "14fa6a0",
          languageVersion: "1.0.0",
          compilerVersion: "0.1.0",
          contractsVersion: CONTRACTS_VERSION,
          artifactDigest: "digest-fixture",
        },
        requiredCapabilities: [],
        resourceBindings: [],
        secrets: [],
        schedules: [],
      }),
    );
    writeFileSync(
      join(dir, "nativedeploy.prod.environment.json"),
      JSON.stringify({ environment: "prod", resources: [], secretsPresent: [], vars: {} }),
    );
    writeFileSync(
      join(dir, "nativedeploy.target.json"),
      JSON.stringify({
        contractsVersion: 1,
        runtimeVersion: "0.1.0",
        knownLanguageVersions: ["1.0.0"],
        capabilities: [],
        supportsSchedules: false,
      }),
    );
    if (previousPlan !== null) writeFileSync(join(dir, "nativedeploy.deploy-plan.json"), previousPlan);
    return join(dir, "nativedeploy.artifact.json");
  }

  it("a malformed previous plan fails settled with the identical envelope (042)", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "can-prep-nativedeploy-")));
    try {
      const artifactPath = writeNativeDeployFixtures(dir, "not json");
      const liveBefore = new Set(livePreparationPids());
      // Bounded settle first, then the exact bare code — and no
      // lingering child afterwards (old code exited from inside the
      // session callback, abandoning the delayed SIGKILL).
      const { envelope } = await expectCliFail(
        () => runNativeDeploy(artifactPath, "prod", true, false),
        /^invalid-deploy-bundle$/,
      );
      expect(envelope["command"]).toBe("deploy");
      expect(envelope["code"]).toBe("invalid-deploy-bundle");
      expect(String(envelope["detail"])).toMatch(/not valid JSON/);
      expect(livePreparationPids().filter((pid) => !liveBefore.has(pid))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("confirmed native deploy applies reviewed config and bundle through one mocked spawn (039)", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "can-prep-nativeconfirm-")));
    try {
      const artifactPath = writeNativeDeployFixtures(dir, null);
      const calls: { command: string; args: readonly string[] }[] = [];
      let appliedConfig = "";
      let appliedMainModule = "";
      let appliedModuleCount = -1;
      const spawn: WranglerSpawner = (command, args, options) => {
        calls.push({ command, args });
        const configIndex = args.indexOf("--config");
        appliedConfig = readFileSync(String(args[configIndex + 1]), "utf8");
        // 045: consume the staged reviewed bundle closure before
        // reporting apply success — recompute the owning mixed digest
        // over the exact staged bytes and require the main module.
        const bundleDir = join(options.cwd, `nativedeploy${DEPLOY_DIR_SUFFIX}`);
        const mixed = JSON.parse(readFileSync(join(bundleDir, "bundle.mixed.json"), "utf8")) as {
          mainModule: string;
          mixedSha256: string;
        };
        const textManifest = JSON.parse(readFileSync(join(bundleDir, "bundle.json"), "utf8")) as {
          modules: { key: string }[];
        };
        const modules: Record<string, string> = {};
        for (const entry of textManifest.modules) {
          modules[entry.key] = readFileSync(join(bundleDir, entry.key), "utf8");
        }
        const recomputed = bundleMixedSha256(mixed.mainModule, inventorizeAssets(modules, {}));
        if (recomputed !== mixed.mixedSha256) {
          throw new Error("staged bundle closure mismatch: refusing mocked apply");
        }
        const mainBytes = modules[mixed.mainModule];
        if (typeof mainBytes !== "string" || mainBytes.length === 0) {
          throw new Error("staged bundle main module missing or empty: refusing mocked apply");
        }
        appliedMainModule = mixed.mainModule;
        appliedModuleCount = Object.keys(modules).length;
        return { status: 0, stdout: "mock-native-apply-ok", stderr: "" };
      };
      let output = "";
      vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
        output += String(chunk);
        return true;
      }) as typeof process.stdout.write);
      vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
      // Genuine native job (real binary, all stages) into the confirmed
      // publisher; only the wrangler spawn itself is mocked — no live deploy.
      await runNativeDeploy(artifactPath, "prod", false, true, undefined, { wranglerSpawn: spawn });
      expect(calls.length).toBe(1);
      expect(calls[0]?.command).toBe("wrangler");
      const envelope = JSON.parse(output.trim().split("\n").pop() as string) as Record<string, unknown>;
      expect(envelope["ok"]).toBe(true);
      expect(envelope["applied"]).toBe(true);
      expect(envelope["applyStatus"]).toBe(0);
      expect(envelope["applyDetail"]).toContain("mock-native-apply-ok");
      const files = envelope["files"] as string[];
      expect(files.length).toBeGreaterThan(2);
      // The apply consumed the exact reviewed sidecar bytes on disk.
      expect(appliedConfig).toBe(readFileSync(files[1] as string, "utf8"));
      // Genuine bundle modules staged beside the sidecars, and the
      // apply consumed that same reviewed closure (main + digest).
      const bundleFiles = files.slice(2);
      expect(bundleFiles.length).toBeGreaterThan(0);
      for (const file of bundleFiles) expect(existsSync(file as string)).toBe(true);
      expect(appliedModuleCount).toBeGreaterThan(0);
      expect(files).toContain(join(dir, `nativedeploy${DEPLOY_DIR_SUFFIX}`, appliedMainModule));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancellation at plan-inputs keeps the original interruption (040)", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "can-prep-nativedeploy-cancel-")));
    try {
      const artifactPath = writeNativeDeployFixtures(dir, null);
      const lifetime = {
        signal: new AbortController().signal,
        checkpoint: (stage: string): void => {
          if (stage === "deploy plan inputs loaded") throw new LocalCommandInterrupted("deploy", "command-cancelled");
        },
        remainingMs: (): number => 60_000,
        dispose: (): void => {},
      };
      let thrown: unknown;
      try {
        await runNativeDeploy(artifactPath, "prod", true, false, lifetime);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(LocalCommandInterrupted);
      expect((thrown as LocalCommandInterrupted).code).toBe("command-cancelled");
      expect((thrown as LocalCommandInterrupted).failureContext).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a child that closes stdin refuses without crashing the CLI (052)", async () => {
    // Wrong-arch ELF equivalent: the child is gone before the
    // handshake write, surfacing EPIPE. Owned listeners map it to
    // refusal; an unowned stream event would crash this worker.
    await withFakeBinary("#!/bin/sh\nexec 0<&-\nexit 1\n", async () => {
      const resolution = await resolvePreparationBinary();
      await expect(probeReadiness(resolution.path, { timeoutMs: 5000 })).resolves.toBe(false);
    });
  });

  it("a tampered binary fails loudly, never silently", async () => {
    await withFakeBinary("#!/bin/sh\necho 'not a frame protocol'\n", async () => {
      await expectCliFail(() => runNativeJob("deploy", "build"), /^native-/);
    });
  });

  it("the executable verifier gates launch before any session", async () => {
    await withFakeBinary("#!/bin/sh\necho 'not a frame protocol'\n", async () => {
      const { envelope } = await expectCliFail(() => runNativeJob("deploy", "build"), /^native-/);
      expect(envelope["code"]).toBe("native-unavailable");
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

  // Packaged integrity before any launch (P07/P09): stage a synthetic
  // triple bundle (manifest + bytes) under a temp package root and
  // resolve through it with the env override removed.
  function stagePackaged(binaryBytes: Uint8Array, manifestSha: string): string {
    const root = mkdtempSync(join(tmpdir(), "can-prep-pkg-"));
    const triple = packagedTriple({ platform: process.platform, arch: process.arch });
    const binPath = packagedBinaryPath(root, triple);
    mkdirSync(dirname(binPath), { recursive: true });
    writeFileSync(binPath, binaryBytes);
    chmodSync(binPath, 0o755);
    writeFileSync(
      join(dirname(binPath), "manifest.json"),
      JSON.stringify({
        triple,
        binary: basename(binPath),
        sha256: manifestSha,
        bytes: binaryBytes.length,
        toolchain: { rustc: "1.99.0", cargo: "1.99.0", pinned: "1.99.0" },
        lockfileSha256: "0".repeat(64),
        sourceHead: "test",
        release: "0.1.1",
      }),
    );
    return root;
  }

  async function withoutEnvBin(run: () => Promise<unknown>): Promise<void> {
    const prior = process.env[PREPARATION_BIN_ENV];
    delete process.env[PREPARATION_BIN_ENV];
    try {
      await run();
    } finally {
      if (prior !== undefined) process.env[PREPARATION_BIN_ENV] = prior;
    }
  }

  it("a tampered packaged binary fails native-manifest-hash before any launch", async () => {
    const root = stagePackaged(new TextEncoder().encode("#!/bin/sh\nexit 1\n"), "0".repeat(64));
    await withoutEnvBin(async () => {
      const { envelope } = await expectCliFail(
        () => runNativeJob("build", "build", undefined, { packageRoot: root }),
        /^native-manifest-hash$/,
      );
      expect(envelope["command"]).toBe("build");
    });
  });

  it("a valid manifest lets the packaged binary launch (probe decides next)", async () => {
    const bytes = new TextEncoder().encode("#!/bin/sh\nexit 1\n");
    const root = stagePackaged(bytes, createHash("sha256").update(bytes).digest("hex"));
    await withoutEnvBin(async () => {
      // Integrity passed; the dead stub fails later at the probe.
      const { envelope } = await expectCliFail(
        () => runNativeJob("build", "build", undefined, { packageRoot: root }),
        /^native-unavailable$/,
      );
      expect(envelope["command"]).toBe("build");
    });
  });

  // Exact-path never-spawn controls (019): the fake touches a sentinel
  // as its first act, so absence proves no process ever started.
  it("an env binary without a manifest is refused before any spawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "can-prep-noman-"));
    const fake = join(dir, "can-preparation");
    const sentinel = join(dir, "spawned");
    writeFileSync(fake, `#!/bin/sh\ntouch "${sentinel}"\nexit 1\n`);
    chmodSync(fake, 0o755);
    const prior = process.env[PREPARATION_BIN_ENV];
    process.env[PREPARATION_BIN_ENV] = fake;
    try {
      const { envelope } = await expectCliFail(
        () => runNativeJob("build", "build"),
        /^native-manifest-unreadable$/,
      );
      expect(envelope["command"]).toBe("build");
    } finally {
      if (prior === undefined) delete process.env[PREPARATION_BIN_ENV];
      else process.env[PREPARATION_BIN_ENV] = prior;
    }
    expect(existsSync(sentinel)).toBe(false);
  });

  it("a manifest validating another file refuses the launch path before any spawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "can-prep-mismatch-"));
    const other = join(dir, "other-binary");
    const otherBytes = new TextEncoder().encode("#!/bin/sh\nexit 0\n");
    writeFileSync(other, otherBytes);
    chmodSync(other, 0o755);
    const sentinel = join(dir, "spawned");
    const fake = join(dir, "can-preparation");
    writeFileSync(fake, `#!/bin/sh\ntouch "${sentinel}"\nexit 1\n`);
    chmodSync(fake, 0o755);
    // Manifest is genuine for other-binary, but launch resolves the
    // env binary: exact-path binding must refuse the mismatch.
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        triple: packagedTriple({ platform: process.platform, arch: process.arch }),
        binary: "other-binary",
        sha256: createHash("sha256").update(otherBytes).digest("hex"),
        bytes: otherBytes.length,
        toolchain: { rustc: "1.99.0", cargo: "1.99.0", pinned: "1.99.0" },
        lockfileSha256: "0".repeat(64),
        sourceHead: "test",
        release: "0.1.1",
      }),
    );
    const prior = process.env[PREPARATION_BIN_ENV];
    process.env[PREPARATION_BIN_ENV] = fake;
    try {
      const { envelope } = await expectCliFail(
        () => runNativeJob("build", "build"),
        /^native-manifest-path$/,
      );
      expect(envelope["command"]).toBe("build");
    } finally {
      if (prior === undefined) delete process.env[PREPARATION_BIN_ENV];
      else process.env[PREPARATION_BIN_ENV] = prior;
    }
    expect(existsSync(sentinel)).toBe(false);
  });

  it("a stale-release binary is refused before any spawn even with a matching hash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "can-prep-skew-"));
    const fake = join(dir, "can-preparation");
    const sentinel = join(dir, "spawned");
    const bytes = new TextEncoder().encode(`#!/bin/sh\ntouch "${sentinel}"\nexit 1\n`);
    writeFileSync(fake, bytes);
    chmodSync(fake, 0o755);
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        triple: packagedTriple({ platform: process.platform, arch: process.arch }),
        binary: "can-preparation",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        toolchain: { rustc: "1.99.0", cargo: "1.99.0", pinned: "1.99.0" },
        lockfileSha256: "0".repeat(64),
        sourceHead: "test",
        release: "0.1.0",
      }),
    );
    const prior = process.env[PREPARATION_BIN_ENV];
    process.env[PREPARATION_BIN_ENV] = fake;
    try {
      const { envelope } = await expectCliFail(
        () => runNativeJob("build", "build"),
        /^native-manifest-release$/,
      );
      expect(envelope["command"]).toBe("build");
    } finally {
      if (prior === undefined) delete process.env[PREPARATION_BIN_ENV];
      else process.env[PREPARATION_BIN_ENV] = prior;
    }
    expect(existsSync(sentinel)).toBe(false);
  });

  it("settleLaunchedChild reaps a TERM-ignoring child inside the bound", async () => {
    const dir = mkdtempSync(join(tmpdir(), "can-prep-settle-"));
    const script = join(dir, "hang.sh");
    // The ready byte proves the trap is installed before any
    // signal lands (no startup race): TERM is then trapped and only
    // the SIGKILL escalation reaps (~2s in).
    writeFileSync(script, "#!/bin/sh\ntrap '' TERM\necho ready\nwhile true; do sleep 1; done\n");
    chmodSync(script, 0o755);
    const launched = launchPreparation(script);
    const pid = launched.child.pid;
    expect(pid).toBeDefined();
    await new Promise<void>((resolve) => {
      launched.child.stdout?.on("data", (chunk: Uint8Array) => {
        if (new TextDecoder().decode(chunk).includes("ready")) resolve();
      });
    });
    const closed = new Promise((resolve) => {
      launched.child.on("close", resolve);
    });
    const started = Date.now();
    await settleLaunchedChild(launched, closed, 4_000);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(4_000);
    expect(elapsed).toBeGreaterThanOrEqual(1_500);
    // ESRCH: no lingering process or group member under that pid.
    expect(() => process.kill(pid!, 0)).toThrow();
  });

  it("settleLaunchedChild reaps a TERM-ignoring grandchild with redirected stdio (046A)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "can-prep-settlegroup-"));
    const pidFile = join(dir, "grandchild.pid");
    const script = join(dir, "parent.sh");
    // Direct child dies on SIGTERM; the same-group grandchild ignores
    // TERM with stdio redirected (so the parent's close already
    // fired) — only awaited group escalation reaps it.
    writeFileSync(
      script,
      `#!/bin/sh\n( trap '' TERM; exec >/dev/null 2>&1 </dev/null; sleep 30 ) &\necho $! > "${pidFile}"\nexec sleep 30\n`,
    );
    chmodSync(script, 0o755);
    const launched = launchPreparation(script);
    const waitStart = Date.now();
    while (!existsSync(pidFile) && Date.now() - waitStart < 5_000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(existsSync(pidFile)).toBe(true);
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    expect(Number.isInteger(grandchild)).toBe(true);
    const closed = new Promise((resolve) => {
      launched.child.on("close", resolve);
    });
    try {
      const started = Date.now();
      await settleLaunchedChild(launched, closed, 8_000);
      expect(Date.now() - started).toBeLessThan(8_000);
      // ESRCH: the grandchild is reaped, not surviving process.exit.
      expect(() => process.kill(grandchild, 0)).toThrow();
    } finally {
      try {
        process.kill(grandchild, "SIGKILL");
      } catch {
        // Already reaped; the assertion above is the verdict.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an aborted lifetime surfaces the owning interruption after reaping the child", async () => {
    const controller = new AbortController();
    const reason = new LocalCommandInterrupted("deploy", "command-cancelled");
    const hangingNeed = (): Promise<never> => new Promise<never>(() => {});
    const started = Date.now();
    const pending = runNativeJob("deploy", "deploy", hangingNeed, { signal: controller.signal });
    setTimeout(() => controller.abort(reason), 300);
    await expect(pending).rejects.toBe(reason);
    // Abort plus bounded group settlement: prompt, no lingering session.
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("a dev-layout binary without a manifest is refused before any spawn", async () => {
    const root = mkdtempSync(join(tmpdir(), "can-prep-devroot-"));
    const binDir = join(root, "preparation", "target", "debug");
    mkdirSync(binDir, { recursive: true });
    const sentinel = join(root, "spawned");
    writeFileSync(join(binDir, "can-preparation"), `#!/bin/sh\ntouch "${sentinel}"\nexit 1\n`);
    chmodSync(join(binDir, "can-preparation"), 0o755);
    await withoutEnvBin(async () => {
      const { envelope } = await expectCliFail(
        () => runNativeJob("build", "build", undefined, { packageRoot: root }),
        /^native-manifest-unreadable$/,
      );
      expect(envelope["command"]).toBe("build");
    });
    expect(existsSync(sentinel)).toBe(false);
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

describe("native confirmed publication (P07.1)", () => {
  const descriptor: CompatibilityDescriptor = {
    identity: {
      appName: "PubQual",
      sourceRevision: "pub001",
      languageVersion: "1.0.0",
      compilerVersion: "0.1.0",
      contractsVersion: CONTRACTS_VERSION,
      artifactDigest: "digest-pub",
    },
    requiredCapabilities: [],
    resourceBindings: [],
    secrets: [],
    schedules: [],
  };
  const environment = {
    environment: "prod",
    resources: [],
    secretsPresent: [],
    vars: {},
  } as const;

  function stageArgs(dir: string): {
    planPath: string;
    tomlPath: string;
    renderedJson: string;
    renderedToml: string;
    plan: ReturnType<typeof buildDeployPlan>;
  } {
    const plan = buildDeployPlan(descriptor, environment, {
      workerName: "pubqual",
      main: "./dist/worker/entry.js",
      compatibilityDate: "2026-10-04",
    });
    const planPath = join(dir, "pub.deploy-plan.json");
    const tomlPath = join(dir, "pub.wrangler.toml");
    return {
      planPath,
      tomlPath,
      renderedJson: JSON.stringify(plan),
      renderedToml: renderWranglerToml(plan),
      plan,
    };
  }

  it("stages reviewed bytes and publishes plan+toml (no wrangler: apply recorded, no crash)", async () => {
    // A real wrangler exists on this machine: hide it via PATH so the apply
    // attempt fails locally (ENOENT) instead of reaching any remote deploy.
    const priorPath = process.env["PATH"];
    process.env["PATH"] = "/nonexistent-pub";
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "can-prep-pub-")));
    try {
      const staged = stageArgs(dir);
      let output = "";
      vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
        output += String(chunk);
        return true;
      }) as typeof process.stdout.write);
      vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
      await publishDeployAndApply({
        dir,
        stem: "pub",
        ...staged,
        deployBundle: null,
        diffChanged: false,
        diffLines: [],
        verdict: { active: true, reasons: [] },
        compilerMatch: true,
        compilerDetail: null,
      });
      expect(readFileSync(staged.planPath, "utf8")).toBe(staged.renderedJson);
      expect(readFileSync(staged.tomlPath, "utf8")).toBe(staged.renderedToml);
      const envelope = JSON.parse(output.trim().split("\n").pop() as string) as Record<string, unknown>;
      expect(envelope["ok"]).toBe(true);
      expect(envelope["wrote"]).toBe(true);
      expect(envelope["files"]).toEqual([staged.planPath, staged.tomlPath]);
      expect(envelope["applied"]).toBe(false);
    } finally {
      if (priorPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = priorPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies the confirmed bundle through the injected spawner (no live wrangler)", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "can-prep-pubapply-")));
    const workerDistDir = join(dir, "worker-dist");
    mkdirSync(workerDistDir);
    writeFileSync(
      join(workerDistDir, "main.js"),
      [
        `import { helper } from "./helper.js";`,
        `export default { async fetch() { return Response.json({ helper: helper() }); } };`,
        ``,
      ].join("\n"),
    );
    writeFileSync(join(workerDistDir, "helper.js"), `export function helper() { return "from-helper"; }\n`);
    // Same seam-only stub as deploy-bundle.test.ts: the pinned real runtime
    // set links resource-dispatch.js against ../worker/assembly.js.
    writeFileSync(join(workerDistDir, "assembly.js"), `export function assembleDispatchCommands() { return []; }\n`);
    try {
      const staged = stageArgs(dir);
      const emptyMap = { version: 3, file: "app.can", sources: [], sourcesContent: [], names: [], mappings: "" };
      const artifact: CompileArtifact = {
        artifact_version: 1,
        language_version: "1.0.0",
        tool_version: "0.1.0",
        sources: [{ path: "app.can", sha256: "0".repeat(64) }],
        modules: [
          {
            path: "app/main.js",
            js: [`import { util } from "./util.js";`, `export const descriptor = { util };`, ``].join("\n"),
            map: { ...emptyMap },
          },
          { path: "app/util.js", js: `export function util() { return "util"; }\n`, map: { ...emptyMap } },
        ],
        callables: [],
        operations: [],
        pages: [{ owner: "test", path: "/main", module: "app/main.js", export: "descriptor" }],
        requires: [],
        tests: [],
      };
      const bundle = buildDeployBundleWithAssets(artifact, {
        workerDistDir,
        verdict: { active: true, reasons: [] },
        assets: {},
      });
      const calls: { command: string; args: readonly string[] }[] = [];
      const spawn: WranglerSpawner = (command, args) => {
        calls.push({ command, args });
        // The apply consumes the reviewed bundle config bytes.
        const configIndex = args.indexOf("--config");
        expect(readFileSync(String(args[configIndex + 1]), "utf8")).toBe(staged.renderedToml);
        return { status: 0, stdout: "mock-deploy-ok", stderr: "" };
      };
      let output = "";
      vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
        output += String(chunk);
        return true;
      }) as typeof process.stdout.write);
      vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
      await publishDeployAndApply({
        dir,
        stem: "pub",
        ...staged,
        deployBundle: bundle,
        diffChanged: false,
        diffLines: [],
        verdict: { active: true, reasons: [] },
        compilerMatch: true,
        compilerDetail: null,
        wranglerSpawn: spawn,
      });
      expect(calls.length).toBe(1);
      expect(calls[0]?.command).toBe("wrangler");
      const envelope = JSON.parse(output.trim().split("\n").pop() as string) as Record<string, unknown>;
      expect(envelope["ok"]).toBe(true);
      expect(envelope["applied"]).toBe(true);
      expect(envelope["applyStatus"]).toBe(0);
      expect(envelope["applyDetail"]).toContain("mock-deploy-ok");
      const files = envelope["files"] as string[];
      expect(files.slice(0, 2)).toEqual([staged.planPath, staged.tomlPath]);
      expect(files.length).toBeGreaterThan(2);
      expect(existsSync(join(dir, "pub.deploy", bundle.mainModule))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to stage anything when the compiler build does not match", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "can-prep-pubreject-")));
    try {
      const staged = stageArgs(dir);
      let exitCode = -1;
      let output = "";
      vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
        output += String(chunk);
        return true;
      }) as typeof process.stdout.write);
      vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
      vi.spyOn(process, "exit").mockImplementation(((code?: unknown) => {
        exitCode = (code as number) ?? 0;
        throw new Error(`__exit_${exitCode}__`);
      }) as typeof process.exit);
      await expect(
        publishDeployAndApply({
          dir,
          stem: "pub",
          ...staged,
          deployBundle: null,
          diffChanged: false,
          diffLines: [],
          verdict: { active: true, reasons: [] },
          compilerMatch: false,
          compilerDetail: "artifact digest mismatch",
        }),
      ).rejects.toThrow("__exit_2__");
      expect(exitCode).toBe(2);
      const envelope = JSON.parse(output.trim().split("\n").pop() as string) as Record<string, unknown>;
      expect(envelope["code"]).toBe("compiler-mismatch");
      expect(existsSync(staged.planPath)).toBe(false);
      expect(existsSync(staged.tomlPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancel before apply keeps staged files and reports failure context", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "can-prep-pubcancel-")));
    try {
      const staged = stageArgs(dir);
      vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
      const lifetime = {
        signal: new AbortController().signal,
        checkpoint: (stage: string): void => {
          if (stage === "deploy before apply") throw new LocalCommandInterrupted("deploy", "command-cancelled");
        },
        remainingMs: (): number => 60_000,
        dispose: (): void => {},
      };
      let thrown: unknown;
      try {
        await publishDeployAndApply({
          dir,
          stem: "pub",
          ...staged,
          deployBundle: null,
          diffChanged: false,
          diffLines: [],
          verdict: { active: true, reasons: [] },
          compilerMatch: true,
          compilerDetail: null,
          lifetime,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(LocalCommandInterrupted);
      const context = (thrown as LocalCommandInterrupted).failureContext;
      expect(context?.wrote).toBe(true);
      expect(context?.applied).toBe(false);
      expect([...(context?.files ?? [])]).toEqual([staged.planPath, staged.tomlPath]);
      expect(readFileSync(staged.planPath, "utf8")).toBe(staged.renderedJson);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
