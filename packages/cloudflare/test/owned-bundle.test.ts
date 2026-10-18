import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { CompileArtifact } from "@canlang/contracts";
import { createLocalCommandLifetime, LocalCommandInterrupted } from "../src/cli/command-lifetime.js";

const control = vi.hoisted(() => ({ entry: "", jobs: [] as string[] }));
vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: (command: string, args: string[], options: Parameters<typeof actual.spawn>[2]) => {
    control.jobs.push(args[1]!);
    return actual.spawn(command, [control.entry, ...args.slice(1)], options);
  } };
});
import { buildOwnedDeployBundleWithAssets } from "../src/deploy/owned-bundle.js";

let fixtureRoot: string;
beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "can-owned-bundle-test-"));
  control.entry = join(fixtureRoot, "delayed-build.mjs");
  await writeFile(control.entry, `
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { serialize, deserialize } from "node:v8";
import { join } from "node:path";
import { spawn } from "node:child_process";
const [jobPath, resultPath] = process.argv.slice(2);
const { artifact, options } = deserialize(readFileSync(jobPath));
writeFileSync(join(options.temporaryRoot, "pid"), String(process.pid));
mkdirSync(join(options.temporaryRoot, "partial-output"));
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(join(options.temporaryRoot, "child-pid"), String(child.pid));
// Deliberate event-loop blocking simulates the synchronous bundle producer.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, artifact.delay);
child.kill("SIGKILL");
writeFileSync(resultPath, serialize(artifact.failure ? { ok: false, error: artifact.failure } : {
  ok: true, bundle: { mainModule: "worker/main.js", modules: { "worker/main.js": "export default {};" },
    moduleCount: 1, sha256: options.esbuildBinaryPath, mcpBundleBytes: 0, httpOperationsBytes: 0,
    binaries: {}, mixedSha256: "mixed", resources: { test: { bytes: new Uint8Array([1,2,3]), contentType: "test" } }, resourcesSha256: "resources" }
}));
`);
});
afterAll(async () => { await rm(fixtureRoot, { recursive: true, force: true }); });

function artifact(delay = 1000, failure?: unknown): CompileArtifact {
  return { delay, ...(failure === undefined ? {} : { failure }) } as unknown as CompileArtifact;
}
async function started(jobIndex: number): Promise<{ dir: string; pid: number; childPid: number }> {
  await vi.waitFor(() => {
    expect(control.jobs[jobIndex]).toBeDefined();
    expect(existsSync(join(dirname(control.jobs[jobIndex]!), "child-pid"))).toBe(true);
  }, { timeout: 3000, interval: 10 });
  const dir = dirname(control.jobs[jobIndex]!);
  return { dir, pid: Number(readFileSync(join(dir, "pid"))), childPid: Number(readFileSync(join(dir, "child-pid"))) };
}
function dead(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

it("serves status and awaits stop while the owned producer is blocked, with no late success", async () => {
  const abort = new AbortController();
  const reason = new Error("session stopped");
  const jobIndex = control.jobs.length;
  const build = buildOwnedDeployBundleWithAssets(artifact(5000), { verdict: { active: true }, signal: abort.signal });
  const settled = build.catch(error => error);
  const owned = await started(jobIndex);
  const server = createServer((req, res) => {
    if (req.url === "/stop") {
      abort.abort(reason);
      void settled.then(() => { res.end("stopped"); });
    } else res.end("building");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test listener missing");
  const get = (path: string): Promise<string> => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: address.port, path, timeout: 1500 }, res => {
      let text = ""; res.on("data", chunk => { text += chunk; }); res.on("end", () => resolve(text));
    });
    req.on("timeout", () => req.destroy(new Error("control request blocked by build")));
    req.on("error", reject); req.end();
  });
  try {
    expect(await get("/status")).toBe("building");
    expect(await get("/stop")).toBe("stopped");
    expect(await settled).toBe(reason);
    expect(existsSync(owned.dir)).toBe(false);
    expect(dead(owned.pid)).toBe(true);
    await vi.waitFor(() => expect(dead(owned.childPid)).toBe(true), { timeout: 2000 });
  } finally {
    abort.abort(reason); await settled;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

it("enforces the command timeout and releases owned scratch before rejecting", async () => {
  const lifetime = createLocalCommandLifetime("preview", 1500);
  const index = control.jobs.length;
  const build = buildOwnedDeployBundleWithAssets(artifact(5000), { verdict: { active: true }, commandLifetime: lifetime });
  const settled = build.catch(error => error);
  try {
    const owned = await started(index);
    const error = await settled;
    expect(error).toBeInstanceOf(LocalCommandInterrupted);
    expect(error.code).toBe("command-timeout");
    expect(dead(owned.pid)).toBe(true);
    expect(existsSync(owned.dir)).toBe(false);
  } finally { lifetime.dispose(); await settled; }
});

it("keeps simultaneous job binary selections private and returns typed bytes after cleanup", async () => {
  const initial = process.env.ESBUILD_BINARY_PATH;
  const index = control.jobs.length;
  const a = buildOwnedDeployBundleWithAssets(artifact(250), { verdict: { active: true }, esbuildBinaryPath: "/job/a/esbuild" });
  const b = buildOwnedDeployBundleWithAssets(artifact(250), { verdict: { active: true }, esbuildBinaryPath: "/job/b/esbuild" });
  await started(index); await started(index + 1);
  expect(process.env.ESBUILD_BINARY_PATH).toBe(initial);
  const [one, two] = await Promise.all([a, b]);
  expect(one.sha256).toBe("/job/a/esbuild"); expect(two.sha256).toBe("/job/b/esbuild");
  expect(one.resources.test!.bytes).toBeInstanceOf(Uint8Array);
  expect([...one.resources.test!.bytes]).toEqual([1, 2, 3]);
  expect(process.env.ESBUILD_BINARY_PATH).toBe(initial);
  expect(control.jobs.slice(index).every(job => !existsSync(dirname(job)))).toBe(true);
});

it("preserves scalar build failures and skips allocating an already cancelled job", async () => {
  const index = control.jobs.length;
  await expect(buildOwnedDeployBundleWithAssets(artifact(1, "producer refusal"), { verdict: { active: true } })).rejects.toBe("producer refusal");
  expect(existsSync(dirname(control.jobs[index]!))).toBe(false);
  const controller = new AbortController(); controller.abort("already stopped");
  await expect(buildOwnedDeployBundleWithAssets(artifact(), { verdict: { active: true }, signal: controller.signal })).rejects.toBe("already stopped");
  expect(control.jobs).toHaveLength(index + 1);
});
