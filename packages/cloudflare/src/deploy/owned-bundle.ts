/** One portable build owned by its caller; blocking producer work stays in a child. */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deserialize, serialize } from "node:v8";
import type { CompileArtifact } from "@canlang/contracts";
import type { LocalCommandLifetime } from "../cli/command-lifetime.js";
import { cleanupAfterFailure, retryableDispose } from "../runtime/resource-lifetime.js";
import type { BuildPackageDeployBundleOptions, PackageDeployBundle } from "./bundle.js";

export interface OwnedBundleOptions extends BuildPackageDeployBundleOptions {
  signal?: AbortSignal;
}

/** Private file transport preserves typed resource bytes without a large IPC buffer. */
export interface OwnedBundleJob {
  artifact: CompileArtifact;
  options: Omit<BuildPackageDeployBundleOptions, "commandLifetime">;
}
export type OwnedBundleReply = { ok: true; bundle: PackageDeployBundle } |
  { ok: false; error: unknown; code?: unknown };

function runBundleChild(job: string, result: string, signal: AbortSignal | undefined,
  lifetime: LocalCommandLifetime | undefined): Promise<void> {
  signal?.throwIfAborted();
  lifetime?.checkpoint("portable bundle child start");
  const remainingMs = lifetime?.remainingMs(2_147_483_647);
  return new Promise((resolve, reject) => {
    // The local control host is Unix-only. This new process group contains only
    // this build and its esbuild subprocesses, never another session's children.
    const child = spawn(process.execPath, [fileURLToPath(new URL("./owned-bundle-entry.js", import.meta.url)), job, result], {
      detached: true, shell: false, stdio: ["ignore", "ignore", "pipe"],
    });
    let failed = false;
    let failure: unknown;
    let stderr = "";
    let stderrBytes = 0;
    const terminate = (error: unknown): void => {
      if (!failed) { failed = true; failure = error; }
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL"); }
    };
    const onAbort = (): void => terminate(signal!.reason);
    const onCommandAbort = (): void => terminate(lifetime!.signal.reason);
    const timer = remainingMs === undefined ? undefined : setTimeout(() => {
      try { lifetime!.checkpoint("portable bundle child deadline"); }
      catch (error) { terminate(error); }
    }, remainingMs);
    timer?.unref();
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      lifetime?.signal.removeEventListener("abort", onCommandAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    lifetime?.signal.addEventListener("abort", onCommandAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (lifetime?.signal.aborted) onCommandAbort();
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > 1_048_576) terminate(new Error("portable bundle child stderr exceeded limit"));
      else stderr += chunk.toString("utf8");
    });
    child.once("error", error => {
      if (child.pid === undefined) { cleanup(); reject(error); }
      else terminate(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      // Also release a subprocess if the entry failed unexpectedly before its
      // synchronous tool wait finished. Never target a pre-existing process group.
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH" && !failed) { failed = true; failure = error; } }
      }
      if (failed) reject(failure);
      else if (code !== 0) reject(new Error(`portable bundle child exited ${code ?? signal}: ${stderr.slice(0, 8192)}`));
      else resolve();
    });
  });
}

/** Synchronous deployment APIs remain unchanged; sessions use this owned boundary. */
export async function buildOwnedDeployBundleWithAssets(artifact: CompileArtifact,
  options: OwnedBundleOptions): Promise<PackageDeployBundle> {
  const { commandLifetime, signal, ...buildOptions } = options;
  const checkpoint = (): void => {
    signal?.throwIfAborted();
    commandLifetime?.checkpoint("owned portable bundle");
  };
  checkpoint();
  const workDir = await mkdtemp(join(tmpdir(), "can-owned-bundle-"));
  const dispose = retryableDispose(() => rm(workDir, { recursive: true, force: true }));
  try {
    checkpoint();
    const job = join(workDir, "job.v8"), result = join(workDir, "result.v8");
    await writeFile(job, serialize({ artifact, options: { ...buildOptions, temporaryRoot: workDir } } satisfies OwnedBundleJob));
    checkpoint();
    await runBundleChild(job, result, signal, commandLifetime);
    checkpoint();
    const reply = deserialize(await readFile(result)) as OwnedBundleReply;
    checkpoint();
    if (!reply.ok) {
      if (reply.error instanceof Error && reply.code !== undefined) Object.assign(reply.error, { code: reply.code });
      throw reply.error;
    }
    await dispose();
    checkpoint();
    return reply.bundle;
  } catch (error) {
    return cleanupAfterFailure(error, dispose);
  }
}
