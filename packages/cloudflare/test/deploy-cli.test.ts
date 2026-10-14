import { execFile, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalCommandLifetime, LocalCommandInterrupted } from "../src/cli/command-lifetime.js";
import { runPreparedDeploy } from "../src/preparation/host.js";


const directDeploy = vi.hoisted(() => ({
  elapsedMs: 0, bunAdvanceMs: [] as number[], expireAfterWrite: "", expireFailedCleanup: false, wranglerAdvanceMs: 0, wranglerOptions: null as unknown,
  beforeWrite: null as ((path: string) => void) | null, physicalWriteFailure: undefined as unknown,
  bunCalls: 0, bunTimeoutAt: 0, bunStages: [] as Array<{ entry: string; output: string; options: unknown }>, wranglerCalls: 0, wranglerFailure: "", failPath: "", failure: new Error("second sidecar write sentinel"),
}));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, rmSync: (...args: Parameters<typeof actual.rmSync>) => {
    const result = actual.rmSync(...args);
    if (directDeploy.expireFailedCleanup && directDeploy.bunCalls === directDeploy.bunTimeoutAt &&
        directDeploy.bunStages.some(stage => dirname(stage.entry) === String(args[0]))) directDeploy.elapsedMs = 10_000;
    return result;
  }, writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
    if (String(args[0]) === directDeploy.failPath) throw directDeploy.failure;
    directDeploy.beforeWrite?.(String(args[0]));
    let result: ReturnType<typeof actual.writeFileSync>;
    try { result = actual.writeFileSync(...args); }
    catch (error) { directDeploy.physicalWriteFailure = error; throw error; }
    if (String(args[0]) === directDeploy.expireAfterWrite) directDeploy.elapsedMs = 10_000;
    return result;
  } };
});
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFileSync: (command: string, args: string[], options: unknown) => {
    if (command === "wrangler") {
      directDeploy.wranglerCalls++;
      directDeploy.wranglerOptions = options;
      directDeploy.elapsedMs += directDeploy.wranglerAdvanceMs;
      if (directDeploy.wranglerFailure === "nonzero") {
        throw Object.assign(new Error("Wrangler exited 1"), { status: 1, stdout: "partial diagnostic", stderr: "remote write diagnostic" });
      }
      if (directDeploy.wranglerFailure === "timeout") {
        throw Object.assign(new Error("spawn wrangler ETIMEDOUT"), { code: "ETIMEDOUT" });
      }
      return "uploaded";
    }
    if (command !== "bun") throw new Error(`unexpected direct deploy subprocess ${command}`);
    directDeploy.bunCalls++;
    const output = args.find(arg => arg.startsWith("--outfile="))?.slice(10);
    if (output === undefined) throw new Error("missing mocked Bun output");
    const entry = args[1];
    if (entry === undefined) throw new Error("missing mocked Bun entry");
    directDeploy.bunStages.push({ entry, output, options });
    if (directDeploy.bunCalls === directDeploy.bunTimeoutAt) {
      throw Object.assign(new Error("spawn bun ETIMEDOUT"), { code: "ETIMEDOUT" });
    }
    writeFileSync(output, "export const createMcpHandler = () => {}; export const createArtifactRegistry = () => {}; export const createArtifactCatalog = () => {}; export class IdentityError extends Error {} export const receiverFromIdentity = () => {}; export const handleOperationRequest = () => {}; export const handlePageRequest = () => {}; export const handlePagePreferencePost = () => {}; export const handleAuthRequest = () => {}; export const SESSION_EXPIRES_MS = 1; export const createSourceFormBindings = () => {}; export const parseJsonBody = async () => ({}); export const JSON_BODY_MAX_BYTES = 1048576; ");
    directDeploy.elapsedMs += directDeploy.bunAdvanceMs[directDeploy.bunCalls - 1] ?? 0;
    return "";
  } };
});

const CLI = new URL("../dist/cli/platform.js", import.meta.url);

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], timeout = 15000, cwd?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI.pathname, ...args],
      { timeout, ...(cwd === undefined ? {} : { cwd }) },
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

const SHA = "b".repeat(64);

/** Minimal valid CompileArtifact v1 (loader-strict). */
function validArtifact(): Record<string, unknown> {
  return {
    artifact_version: 1,
    language_version: "1.0.0",
    tool_version: "0.1.0",
    sources: [{ path: "app.can", sha256: SHA }],
    modules: [
      {
        path: "worker.mjs",
        js: "export default { async fetch() { return new Response(\"ok\"); } };\n",
        map: { version: 3, file: "worker.mjs", sources: [], sourcesContent: [], names: [], mappings: "" },
      },
    ],
    callables: [],
    pages: [],
    requires: [],
    tests: [],
  };
}

/** Deploy bundle next to the artifact (activate bundle convention). */
function deployBundle(): { dir: string; artifact: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "can-deploy-cli-")));
  const artifact = join(dir, "teamtasks.artifact.json");
  writeFileSync(artifact, JSON.stringify(validArtifact()));
  writeFileSync(
    join(dir, "teamtasks.descriptor.json"),
    JSON.stringify({
      identity: {
        appName: "TeamTasks",
        sourceRevision: "14fa6a0",
        languageVersion: "1.0.0",
        compilerVersion: "0.1.0",
        contractsVersion: 1,
        artifactDigest: "digest-fixture",
      },
      requiredCapabilities: [],
      resourceBindings: [{ binding: "DB", kind: "d1", logicalName: "teamtasks-db" }],
      secrets: [],
      schedules: [],
    }),
  );
  writeFileSync(
    join(dir, "teamtasks.prod.environment.json"),
    JSON.stringify({
      environment: "prod",
      resources: [
        {
          requirement: { binding: "DB", kind: "d1", logicalName: "teamtasks-db" },
          resourceId: "db-123",
        },
      ],
      secretsPresent: [],
      vars: { API_URL: "https://api.example.com" },
    }),
  );
  writeFileSync(
    join(dir, "teamtasks.target.json"),
    JSON.stringify({
      contractsVersion: 1,
      runtimeVersion: "0.1.0",
      knownLanguageVersions: ["1.0.0"],
      capabilities: [],
      supportsSchedules: false,
    }),
  );
  return { dir, artifact };
}

describe("can-platform deploy/test/build local paths (B5-J3)", () => {
  it("deploy --preview prints a human-diffable plan and writes nothing", async () => {
    const { dir, artifact } = deployBundle();
    const result = await runCli(["deploy", "--artifact", artifact, "--env", "prod", "--preview"]);
    expect(result.code).toBe(0);
    const body = envelope(result.stdout);
    expect(body).toMatchObject({ ok: true, command: "deploy", preview: true, wrote: false });
    expect(body["plan"]).toBeDefined();
    expect(body["changed"]).toBe(true);
    expect(result.stderr).toContain("teamtasks");
    expect(existsSync(join(dir, "teamtasks.deploy-plan.json"))).toBe(false);
    expect(existsSync(join(dir, "teamtasks.wrangler.toml"))).toBe(false);
  });

  it("bare deploy blocks: confirm gate requires --preview or --yes", async () => {
    const { artifact } = deployBundle();
    const result = await runCli(["deploy", "--artifact", artifact, "--env", "prod"]);
    expect(result.code).toBe(2);
    const body = envelope(result.stdout);
    expect(body).toMatchObject({ ok: false, command: "deploy", code: "confirm-required" });
    expect(String(body["detail"])).toContain("--yes");
  });

  it("deploy --yes writes plan files; second preview shows no changes", async () => {
    const { dir, artifact } = deployBundle();
    const first = await runCli(["deploy", "--artifact", artifact, "--env", "prod", "--yes"]);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    const firstBody = envelope(first.stdout);
    expect(firstBody).toMatchObject({ ok: true, command: "deploy", wrote: true });
    expect(existsSync(join(dir, "teamtasks.deploy-plan.json"))).toBe(true);
    const toml = join(dir, "teamtasks.wrangler.toml");
    expect(existsSync(toml)).toBe(true);
    const second = await runCli(["deploy", "--artifact", artifact, "--env", "prod", "--preview"]);
    expect(second.code).toBe(0);
    expect(envelope(second.stdout)).toMatchObject({ changed: false });
    // C3: two CLI runs × two bun bundles each (MCP + HTTP op chain)
    // exceed the 5s default under load; bounded explicit timeout.
  }, 30000);

  it("deploy refuses an incompatible bundle (compat gate first)", async () => {
    const { artifact } = deployBundle();
    const bad = join(artifact, "..", "teamtasks.prod.environment.json");
    const env = JSON.parse(
      (await import("node:fs")).readFileSync(bad, "utf8") as unknown as string,
    ) as { resources: unknown[]; [key: string]: unknown };
    env.resources = [];
    writeFileSync(bad, JSON.stringify(env));
    const result = await runCli(["deploy", "--artifact", artifact, "--env", "prod", "--preview"]);
    expect(result.code).toBe(2);
    expect(envelope(result.stdout)).toMatchObject({ ok: false, command: "deploy", code: "incompatible" });
  });

  it("build validates the artifact and installed release tree from an app directory", async () => {
    const { artifact } = deployBundle();
    const result = await runCli(["build", "--artifact", artifact], 15000, dirname(artifact));
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const body = envelope(result.stdout);
    expect(body).toMatchObject({ ok: true, command: "build", release: "0.1.0" });
    expect(body["modules"]).toBe(1);
  });

  it("test refuses zero-row success until the compiled row producer is joined", async () => {
    const { artifact } = deployBundle();
    const result = await runCli(["test", "--artifact", artifact], 90000);
    expect(result.code).toBe(2);
    const body = envelope(result.stdout);
    expect(body).toMatchObject({ ok: false, command: "test", code: "missing-producer" });
    expect(String(body["detail"])).toContain("zero-row results cannot pass");
  }, 100000);
});


describe("confirmed direct deploy output ownership", () => {
  const roots: string[] = [];
  const prepare = () => {
    const fixture = deployBundle();
    const dir = realpathSync(fixture.dir);
    roots.push(dir);
    return { dir, artifact: join(dir, "teamtasks.artifact.json") };
  };
  afterEach(() => {
    vi.restoreAllMocks();
    directDeploy.beforeWrite = null;
    directDeploy.physicalWriteFailure = undefined;
    directDeploy.elapsedMs = directDeploy.wranglerAdvanceMs = 0;
    directDeploy.bunAdvanceMs = [];
    directDeploy.expireAfterWrite = "";
    directDeploy.expireFailedCleanup = false;
    directDeploy.wranglerOptions = null;
    directDeploy.failPath = "";
    directDeploy.wranglerFailure = "";
    directDeploy.bunTimeoutAt = 0;
    directDeploy.bunStages = [];
    directDeploy.bunCalls = directDeploy.wranglerCalls = 0;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const outputNames = ["teamtasks.deploy-plan.json", "teamtasks.wrangler.toml"];
  it.each(outputNames)("refuses pre-existing %s symlink before output or apply", async name => {
    const { dir, artifact } = prepare();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "can-deploy-outside-"))); roots.push(outside);
    const sentinel = join(outside, "sentinel"); writeFileSync(sentinel, "outside unchanged");
    symlinkSync(name.endsWith(".json") ? join(outside, "absent-plan.json") : sentinel, join(dir, name));
    await expect(runPreparedDeploy(artifact, "prod", false, true)).rejects.toThrow(/symlink/);
    expect(readFileSync(sentinel, "utf8")).toBe("outside unchanged");
    expect(existsSync(join(dir, "teamtasks.deploy"))).toBe(false);
    expect(existsSync(join(dir, outputNames.find(other => other !== name)!))).toBe(false);
    expect(directDeploy.wranglerCalls).toBe(0);
  });
  it("refuses an aliased ancestor before output or apply", async () => {
    const { dir } = prepare();
    const aliases = realpathSync(mkdtempSync(join(tmpdir(), "can-deploy-alias-"))); roots.push(aliases);
    symlinkSync(dirname(dir), join(aliases, "alias"), "dir");
    const sentinel = join(dir, "outside-sentinel"); writeFileSync(sentinel, "unchanged");
    await expect(runPreparedDeploy(join(aliases, "alias", basename(dir), "teamtasks.artifact.json"), "prod", false, true))
      .rejects.toThrow(/symlink.*ancestors/);
    expect(readFileSync(sentinel, "utf8")).toBe("unchanged");
    expect(existsSync(join(dir, "teamtasks.deploy"))).toBe(false);
    for (const name of outputNames) expect(existsSync(join(dir, name))).toBe(false);
    expect(directDeploy.wranglerCalls).toBe(0);
  });
  it("refuses a real child directory-to-symlink replacement before consumed publication preflight", async () => {
    const { dir, artifact } = prepare();
    const prior = `${dir}-before-replacement`; roots.push(prior);
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "can-deploy-replaced-outside-"))); roots.push(outside);
    const sentinel = join(outside, "sentinel"); writeFileSync(sentinel, "outside unchanged");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const owned = createLocalCommandLifetime("deploy", 60_000);
    let replaced = false;
    const lifetime = { ...owned, checkpoint(stage: string) {
      if (stage === "deploy publication preflight") {
        expect(replaced).toBe(false);
        const child = spawnSync(process.execPath, ["-e", `
          const fs = require("node:fs");
          const [source, prior, outside] = JSON.parse(process.argv[1]);
          fs.renameSync(source, prior);
          fs.symlinkSync(outside, source, "dir");
        `, JSON.stringify([dir, prior, outside])], { encoding: "utf8", stdio: "pipe" });
        expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.signal).toBeNull();
        expect(child.stderr).toBe("");
        replaced = true;
        expect(lstatSync(dir).isSymbolicLink()).toBe(true);
      }
      owned.checkpoint(stage);
    } };
    let primary: unknown;
    try { await runPreparedDeploy(artifact, "prod", false, true, lifetime); }
    catch (error) { primary = error; }
    finally { owned.dispose(); }
    expect(replaced, JSON.stringify({ stdout: stdout.mock.calls, stderr: stderr.mock.calls, primary: String(primary) })).toBe(true);
    expect(primary).toBeInstanceOf(Error); expect(String(primary)).toMatch(/refusing output symlink/);
    expect(owned.signal.aborted).toBe(false);
    expect(directDeploy.wranglerCalls).toBe(0); expect(stdout.mock.calls).toEqual([]);
    expect(readFileSync(sentinel, "utf8")).toBe("outside unchanged");
    for (const name of ["teamtasks.deploy-plan.json", "teamtasks.wrangler.toml", "teamtasks.deploy"]) {
      expect(existsSync(join(outside, name))).toBe(false);
      expect(existsSync(join(prior, name))).toBe(false);
    }
    expect(existsSync(join(prior, "teamtasks.artifact.json"))).toBe(true);
    expect(directDeploy.bunCalls).toBe(2);
    for (const stage of directDeploy.bunStages) expect(existsSync(dirname(stage.entry))).toBe(false);
    // The consumed preflight detects this actual replacement. No atomic
    // check-to-write, absolute process-tree, or remote-effect claim follows.
  });

  it("preserves a real second-sidecar filesystem failure and reports retained partial outputs without apply", async () => {
    const { dir, artifact } = prepare();
    const plan = join(dir, "teamtasks.deploy-plan.json"), toml = join(dir, "teamtasks.wrangler.toml");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let interrupted = false;
    directDeploy.beforeWrite = path => {
      if (path !== toml) return;
      expect(interrupted).toBe(false);
      const child = spawnSync(process.execPath, ["-e", `
        const fs = require("node:fs");
        const target = JSON.parse(process.argv[1]);
        fs.mkdirSync(target);
      `, JSON.stringify(toml)], { encoding: "utf8", stdio: "pipe" });
      expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.signal).toBeNull();
      expect(child.stderr).toBe(""); interrupted = true;
    };
    let primary: unknown;
    try { await runPreparedDeploy(artifact, "prod", false, true); } catch (error) { primary = error; }
    expect(interrupted, JSON.stringify({ stdout: stdout.mock.calls, stderr: stderr.mock.calls, primary: String(primary) })).toBe(true);
    expect(primary).toBe(directDeploy.physicalWriteFailure);
    expect(primary).toBeInstanceOf(Error); expect(primary).toMatchObject({ code: "EISDIR" });
    expect(directDeploy.wranglerCalls).toBe(0); expect(stdout.mock.calls).toEqual([]);
    expect(stderr.mock.calls.map(call => String(call[0])).join("")).toContain("earlier outputs may remain; no apply was attempted");
    expect(JSON.parse(readFileSync(plan, "utf8"))).toBeTypeOf("object");
    expect(readFileSync(plan, "utf8")).toContain("db-123");
    expect(existsSync(join(dir, "teamtasks.deploy", "bundle.json"))).toBe(true);
    expect(lstatSync(toml).isDirectory()).toBe(true);
    expect(existsSync(join(dir, "teamtasks.artifact.json"))).toBe(true);
    for (const stage of directDeploy.bunStages) expect(existsSync(dirname(stage.entry))).toBe(false);
    // Generated scratch is owner-cleaned; known published files and the
    // caller-owned root remain. The test owns their final removal.
  });

  it("writes real bundle and sidecar bytes with only mocked Bun and Wrangler", async () => {
    const { dir, artifact } = prepare();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runPreparedDeploy(artifact, "prod", false, true);
    const result = envelope(stdout.mock.calls.map(call => String(call[0])).join(""));
    expect(result).toMatchObject({ ok: true, wrote: true, applied: true, applyStatus: 0, applyDetail: "uploaded" });
    expect(result["manualApply"]).toContain(join(dir, "teamtasks.wrangler.toml"));
    expect(JSON.parse(readFileSync(join(dir, "teamtasks.deploy-plan.json"), "utf8"))).toEqual(result["plan"]);
    expect(readFileSync(join(dir, "teamtasks.wrangler.toml"), "utf8")).toContain("db-123");
    expect(existsSync(join(dir, "teamtasks.deploy", "bundle.json"))).toBe(true);
    expect(directDeploy.bunCalls).toBe(2);
    for (const stage of directDeploy.bunStages) expect(stage.options).toEqual({
      stdio: 'pipe', timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 1_048_576,
    });
    expect(directDeploy.wranglerCalls).toBe(1);
  });
  it("shortens each child timeout to the remaining cumulative command budget", async () => {
    const { artifact } = prepare();
    const lifetime = createLocalCommandLifetime("deploy", 10_000, () => directDeploy.elapsedMs);
    directDeploy.bunAdvanceMs = [6_000, 3_000];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try { await runPreparedDeploy(artifact, "prod", false, true, lifetime); } finally { lifetime.dispose(); }
    expect(directDeploy.bunStages.map(stage => stage.options)).toEqual([
      { stdio: "pipe", timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 1_048_576 },
      { stdio: "pipe", timeout: 4_000, killSignal: "SIGKILL", maxBuffer: 1_048_576 },
    ]);
    expect(directDeploy.wranglerOptions).toMatchObject({ timeout: 1_000 });
    expect(directDeploy.wranglerCalls).toBe(1);
    expect(envelope(stdout.mock.calls.map(call => String(call[0])).join(""))).toMatchObject({ ok: true, applied: true });
  });
  it("refuses cumulative expiration after sequential Bun stages before publication", async () => {
    const { dir, artifact } = prepare();
    const lifetime = createLocalCommandLifetime("deploy", 10_000, () => directDeploy.elapsedMs);
    directDeploy.bunAdvanceMs = [6_000, 4_000];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try { await expect(runPreparedDeploy(artifact, "prod", false, true, lifetime)).rejects.toBeInstanceOf(LocalCommandInterrupted); } finally { lifetime.dispose(); }
    expect(lifetime.signal.reason).toMatchObject({ code: "command-timeout" });
    expect(stdout).not.toHaveBeenCalled();
    expect(directDeploy.bunCalls).toBe(2);
    for (const stage of directDeploy.bunStages) expect(existsSync(dirname(stage.entry))).toBe(false);
    expect(existsSync(join(dir, "teamtasks.deploy"))).toBe(false);
    for (const name of outputNames) expect(existsSync(join(dir, name))).toBe(false);
    expect(directDeploy.wranglerCalls).toBe(0);
  });
  it.each(["teamtasks.deploy-plan.json", "teamtasks.wrangler.toml"])("retains truthful written-file context when budget expires after %s", async name => {
    const { dir, artifact } = prepare();
    const lifetime = createLocalCommandLifetime("deploy", 10_000, () => directDeploy.elapsedMs);
    directDeploy.expireAfterWrite = join(dir, name);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try { await expect(runPreparedDeploy(artifact, "prod", false, true, lifetime)).rejects.toBeInstanceOf(LocalCommandInterrupted); } finally { lifetime.dispose(); }
    const interruption: unknown = lifetime.signal.reason;
    expect(interruption).toBeInstanceOf(LocalCommandInterrupted);
    if (!(interruption instanceof LocalCommandInterrupted)) throw new Error("missing genuine interruption");
    expect(interruption.failureContext).toMatchObject({ wrote: true, applied: false, applyStatus: null });
    expect(interruption.failureContext?.detail).toContain("no apply was attempted");
    expect(interruption.failureContext?.files).toContain(join(dir, "teamtasks.deploy-plan.json"));
    for (const file of interruption.failureContext?.files ?? []) expect(existsSync(file)).toBe(true);
    expect(existsSync(join(dir, "teamtasks.wrangler.toml"))).toBe(name.endsWith(".toml"));
    if (name.endsWith(".json")) expect(stderr.mock.calls.map(call => String(call[0])).join("")).toContain("earlier outputs may remain");
    expect(stdout).not.toHaveBeenCalled();
    expect(directDeploy.wranglerCalls).toBe(0);
  });
  it("never reports success when the command expires during an attempted apply", async () => {
    const { artifact } = prepare();
    const lifetime = createLocalCommandLifetime("deploy", 10_000, () => directDeploy.elapsedMs);
    directDeploy.wranglerAdvanceMs = 10_000;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try { await expect(runPreparedDeploy(artifact, "prod", false, true, lifetime)).rejects.toBeInstanceOf(LocalCommandInterrupted); } finally { lifetime.dispose(); }
    const interruption: unknown = lifetime.signal.reason;
    if (!(interruption instanceof LocalCommandInterrupted)) throw new Error("missing genuine interruption");
    expect(interruption.failureContext).toMatchObject({ wrote: true, applied: false, applyStatus: 0, applyDetail: "uploaded" });
    expect(interruption.failureContext?.detail).toMatch(/remote outcome unconfirmed; inspect.*before any manual retry/);
    expect(stdout).not.toHaveBeenCalled();
    expect(directDeploy.wranglerCalls).toBe(1);
  });
  it.each([1, 2])("refuses Bun stage %s timeout before publication and removes generated scratch", async stage => {
    const { dir, artifact } = prepare();
    directDeploy.bunTimeoutAt = stage;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exit = new Error('observed bundle refusal exit');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw exit; });
    await expect(runPreparedDeploy(artifact, "prod", false, true)).rejects.toBe(exit);
    expect(exitSpy).toHaveBeenCalledWith(2);
    const result = envelope(stdout.mock.calls.map(call => String(call[0])).join(""));
    expect(result).toMatchObject({ ok: false, command: 'deploy', code: 'bundle-failed' });
    expect(result['detail']).toContain('ETIMEDOUT');
    expect(result['detail']).toContain(stage === 1 ? 'MCP bundle build failed' : 'HTTP bundle build failed');
    expect(directDeploy.bunCalls).toBe(stage);
    for (const generated of directDeploy.bunStages) {
      expect(existsSync(generated.entry)).toBe(false);
      expect(existsSync(generated.output)).toBe(false);
      expect(existsSync(dirname(generated.entry))).toBe(false);
    }
    expect(existsSync(join(dir, 'teamtasks.deploy'))).toBe(false);
    for (const name of outputNames) expect(existsSync(join(dir, name))).toBe(false);
    expect(directDeploy.wranglerCalls).toBe(0);
  });
  it.each([1, 2])("preserves Bun stage %s failure when only its awaited scratch cleanup exhausts the budget", async stage => {
    const { dir, artifact } = prepare();
    const lifetime = createLocalCommandLifetime("deploy", 10_000, () => directDeploy.elapsedMs);
    directDeploy.bunTimeoutAt = stage;
    directDeploy.expireFailedCleanup = true;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exit = new Error("observed operative Bun failure");
    vi.spyOn(process, "exit").mockImplementation(() => { throw exit; });
    try { await expect(runPreparedDeploy(artifact, "prod", false, true, lifetime)).rejects.toBe(exit); }
    finally { lifetime.dispose(); }
    expect(directDeploy.elapsedMs).toBe(10_000);
    const result = envelope(stdout.mock.calls.map(call => String(call[0])).join(""));
    expect(result).toMatchObject({ ok: false, command: "deploy", code: "bundle-failed" });
    expect(result["detail"]).toContain("ETIMEDOUT");
    expect(result["detail"]).toContain(stage === 1 ? "MCP bundle build failed" : "HTTP bundle build failed");
    for (const generated of directDeploy.bunStages) expect(existsSync(dirname(generated.entry))).toBe(false);
    expect(existsSync(join(dir, "teamtasks.deploy"))).toBe(false);
    for (const name of outputNames) expect(existsSync(join(dir, name))).toBe(false);
    expect(directDeploy.wranglerCalls).toBe(0);
  });
  it.each(["nonzero", "timeout"])("reports unconfirmed mocked Wrangler %s through the actual host envelope", async mode => {
    const { dir, artifact } = prepare();
    directDeploy.wranglerFailure = mode;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runPreparedDeploy(artifact, "prod", false, true);
    const result = envelope(stdout.mock.calls.map(call => String(call[0])).join(""));
    expect(result).toMatchObject({ ok: true, command: "deploy", wrote: true, applied: false,
      applyStatus: mode === "nonzero" ? 1 : null });
    const files = result["files"];
    expect(Array.isArray(files)).toBe(true);
    expect(files).toContain(join(dir, "teamtasks.deploy-plan.json"));
    expect(files).toContain(join(dir, "teamtasks.wrangler.toml"));
    for (const file of files as string[]) expect(existsSync(file)).toBe(true);
    expect(result["manualApply"]).toContain(join(dir, "teamtasks.wrangler.toml"));
    if (mode === "nonzero") expect(result["applyDetail"]).toBe("remote write diagnostic");
    else {
      expect(result["applyDetail"]).toContain("ETIMEDOUT");
      expect(result["applyDetail"]).toContain("remote outcome unconfirmed");
      expect(result["applyDetail"]).toMatch(/inspect the deployment before any manual retry/i);
    }
    const diagnostics = stderr.mock.calls.map(call => String(call[0])).join("");
    expect(diagnostics).toContain("remote outcome unconfirmed");
    expect(diagnostics).toMatch(/inspect the deployment before any manual retry/i);
    expect(diagnostics).not.toMatch(/nothing was applied|no deploy was performed/i);
    expect(String(result["applyDetail"])).not.toMatch(/nothing was applied|no deploy was performed/i);
    expect(directDeploy.wranglerCalls).toBe(1);
  });
  it.each([false, true])("preserves second sidecar failure and partial outputs (warning failure=%s)", async warningFails => {
    const { dir, artifact } = prepare();
    directDeploy.failPath = join(dir, "teamtasks.wrangler.toml");
    const warnings: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
      warnings.push(String(chunk));
      if (warningFails && String(chunk).includes("earlier")) throw new Error("warning write sentinel");
      return true;
    });
    await expect(runPreparedDeploy(artifact, "prod", false, true)).rejects.toBe(directDeploy.failure);
    expect(existsSync(join(dir, "teamtasks.deploy", "bundle.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "teamtasks.deploy-plan.json"), "utf8"))).toHaveProperty("wrangler");
    expect(existsSync(directDeploy.failPath)).toBe(false);
    expect(warnings.join("")).toMatch(/earlier outputs may remain/i);
    expect(warnings.join("")).toMatch(/no apply.*attempted/i);
    expect(directDeploy.wranglerCalls).toBe(0);
  });
});
