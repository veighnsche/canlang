#!/usr/bin/env node
/** Owned stdin/stdout adapter. Process-tree supervision belongs to the native host. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PreviewAdmissionError } from "./preview-builder.js";
import { RuntimeTargets } from "./runtime-host-target.js";
import { MAX_RUNTIME_FRAME, parseRuntimeRequest, RUNTIME_PROTOCOL, runtimeString,
  type RuntimeRequest, type RuntimeResult } from "./runtime-host-protocol.js";

const COMMANDS = ["inventory", "prepare", "probe", "cancel", "release", "retry", "actors", "examples", "qualify", "refusals"];
function send(value: unknown): void {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line) > MAX_RUNTIME_FRAME) throw new Error("runtime result exceeds frame limit");
  process.stdout.write(line);
}
/** Logs are a separate, bounded, sanitized stream and never readiness facts. */
function boundedLogs(sessionId: string): void {
  let remaining = 64 * 1024, dropped = 0;
  const log = (...values: unknown[]): void => {
    if (remaining <= 0) { dropped += 1; return; }
    const message = "target output withheld";
    const line = `${JSON.stringify({ protocol: RUNTIME_PROTOCOL, kind: "log", sessionId,
      generationId: null, operationId: null, source: "runtime", message, dropped })}\n`;
    remaining -= Buffer.byteLength(line); process.stderr.write(line);
  };
  console.log = log; console.info = log; console.warn = log; console.error = log; console.debug = log;
}
async function respond(targets: RuntimeTargets, request: RuntimeRequest): Promise<void> {
  let result: RuntimeResult;
  const identity = { protocol: RUNTIME_PROTOCOL as typeof RUNTIME_PROTOCOL, sessionId: request.sessionId,
    operationId: request.operationId, generationId: request.generationId };
  try {
    const value = await targets.execute(request);
    result = { ...identity, kind: "result", ok: true, allocation: targets.allocation(request.generationId), result: value };
  } catch (error) {
    // Detailed runtime errors may include credentials/drafts. The owner gets a closed safe failure.
    result = { ...identity, kind: "result", ok: false, allocation: targets.allocation(request.generationId),
      error: { code: error instanceof PreviewAdmissionError ? error.code : "RUNTIME_OPERATION_FAILED", message: "target runtime operation failed; inspect retained ownership before retry" } };
  }
  send(result);
}
export async function runRuntimeHost(sessionId: string): Promise<void> {
  runtimeString(sessionId); boundedLogs(sessionId);
  delete process.env.NODE_INSPECTOR_INFO;
  const directory = await mkdtemp(join(tmpdir(), "can-runtime-host-"));
  const targets = new RuntimeTargets(directory), running = new Set<Promise<void>>();
  let stopping = false, buffered = Buffer.alloc(0);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    stopping = true; process.stdin.pause();
    try { await targets.close(); await Promise.allSettled(running); await rm(directory, { recursive: true, force: true }); }
    catch { process.exitCode = 1; }
  })();
  const stop = (): void => { void close().finally(() => { process.exit(process.exitCode ?? 0); }); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  send({ protocol: RUNTIME_PROTOCOL, kind: "ready", sessionId, pid: process.pid, profile: "local-d1-identity", commands: COMMANDS });
  try {
    for await (const chunk of process.stdin) {
      if (stopping) break;
      buffered = Buffer.concat([buffered, chunk as Buffer]);
      let index: number;
      while ((index = buffered.indexOf(10)) !== -1) {
        const frame = buffered.subarray(0, index); buffered = buffered.subarray(index + 1);
        const request = parseRuntimeRequest(frame, sessionId);
        if (running.size >= 16 && !["cancel", "release", "retry"].includes(request.command)) throw new Error("runtime concurrency exceeds limit");
        const pending = respond(targets, request); running.add(pending);
        void pending.finally(() => running.delete(pending)).catch(() => { void close(); });
      }
      if (buffered.length > MAX_RUNTIME_FRAME) throw new Error("unterminated runtime frame exceeds limit");
    }
  } finally { await close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const index = process.argv.indexOf("--session");
  if (index === -1) throw new Error("runtime host requires --session");
  void runRuntimeHost(runtimeString(process.argv[index + 1])).catch(() => { process.exitCode = 1; });
}
