/** Private fixed DTO transport. Capture, compilation and leases belong to Rust. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const checkout = fileURLToPath(new URL("../../../../", import.meta.url));
const limit = 64 * 1024 * 1024;
function configuration() {
  const candidate = join(checkout, "compiler/target/debug/can-dev");
  const binary = process.env.CAN_DEV_BIN ?? (existsSync(candidate) ? candidate : "can-dev");
  const sourceHost = join(checkout, "dev-server/host/entry.mjs");
  const env = { ...process.env };
  if (env.CAN_DEV_RUNTIME_HOST === undefined && existsSync(sourceHost)) env.CAN_DEV_RUNTIME_HOST = sourceHost;
  return { binary, env };
}
function decoded<T>(bytes: string): T {
  const value = JSON.parse(bytes) as { ok: boolean; result?: T; detail?: string };
  if (value.ok !== true) throw new Error(value.detail ?? "native DTO operation failed");
  return value.result as T;
}
export function nativeHandoffSync<T>(operation: string, input: unknown): T {
  const { binary, env } = configuration();
  const result = spawnSync(binary, ["test-api"], { env, input: JSON.stringify({ operation, input }),
    encoding: "utf8", maxBuffer: limit, timeout: 120_000 });
  if (result.error) throw result.error;
  return decoded<T>(result.stdout);
}
export async function nativeHandoff<T>(operation: string, input: unknown, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const { binary, env } = configuration();
  return new Promise<T>((resolve, reject) => {
    const child = spawn(binary, ["test-api"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let bytes = 0, output = "";
    const cancel = () => { child.kill("SIGTERM"); };
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, 120_000);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > limit) cancel(); else output += chunk.toString("utf8"); });
    child.stderr.resume();
    child.once("error", reject);
    child.once("close", () => {
      clearTimeout(timer); signal?.removeEventListener("abort", cancel);
      try { signal?.throwIfAborted(); if (bytes > limit) throw new Error("native DTO result exceeds limit"); resolve(decoded<T>(output)); }
      catch (error) { reject(error); }
    });
    child.stdin.on("error", () => { /* The close result owns early native failure. */ });
    child.stdin.end(JSON.stringify({ operation, input }));
  });
}
