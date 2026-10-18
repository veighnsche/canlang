/** Private bounded process contract. This is not a public command/session API. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SingleFileCapture } from "./source-capture.js";

export const RUNTIME_PROTOCOL = "can.dev.runtime.v1";
export const MAX_RUNTIME_FRAME = 64 * 1024;
export const MAX_RUNTIME_FILE = 32 * 1024 * 1024;
export interface RuntimeFile { path: string; sha256: string; bytes: number }
export interface RuntimeRequest {
  protocol: typeof RUNTIME_PROTOCOL;
  sessionId: string;
  operationId: string;
  generationId: string | null;
  command: string;
  payload: Record<string, unknown>;
}
export type RuntimeAllocation = "none" | "owned" | "released" | "release_failed";
export interface RuntimeResult extends Omit<RuntimeRequest, "payload" | "command"> {
  kind: "result";
  ok: boolean;
  allocation: RuntimeAllocation;
  result?: unknown;
  error?: { code: string; message: string };
}
export function runtimeObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid runtime object");
  return value as Record<string, unknown>;
}
export function runtimeString(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 4096) throw new Error("invalid runtime string");
  return value;
}
export function parseRuntimeRequest(bytes: Uint8Array, sessionId: string): RuntimeRequest {
  if (bytes.byteLength > MAX_RUNTIME_FRAME) throw new Error("runtime frame exceeds limit");
  const value = runtimeObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (value.protocol !== RUNTIME_PROTOCOL || value.sessionId !== sessionId) throw new Error("runtime protocol/session mismatch");
  runtimeString(value.operationId); runtimeString(value.command);
  if (value.generationId !== null) runtimeString(value.generationId);
  runtimeObject(value.payload);
  return value as unknown as RuntimeRequest;
}
function checkedFile(value: unknown): RuntimeFile {
  const file = runtimeObject(value);
  const path = runtimeString(file.path);
  if (!isAbsolute(path) || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) || Number(file.bytes) < 0 || Number(file.bytes) > MAX_RUNTIME_FILE) {
    throw new Error("invalid runtime file reference");
  }
  return file as unknown as RuntimeFile;
}
/** Open/read/hash the actual private regular file; metadata alone is never evidence. */
export async function readRuntimeFile(value: unknown): Promise<Buffer> {
  const file = checkedFile(value), before = await lstat(file.path);
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o077) !== 0 || before.uid !== process.getuid?.() ||
      await realpath(file.path) !== file.path) throw new Error("runtime file must be private, canonical and regular");
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== file.bytes) throw new Error("runtime file changed");
    const bytes = await handle.readFile();
    if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw new Error("runtime file hash mismatch");
    return bytes;
  } finally { await handle.close(); }
}
export async function writeRuntimeFile(directory: string, value: unknown): Promise<RuntimeFile> {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_RUNTIME_FILE) throw new Error("runtime output exceeds file limit");
  await boundRuntimeSpool(directory, bytes.length);
  const path = join(await realpath(directory), `${randomUUID()}.json`);
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
/** Capture is verified as a file before its owned byte snapshots are revived. */
export function parseRuntimeCapture(bytes: Uint8Array): SingleFileCapture {
  const value = runtimeObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  for (const key of ["requestedRoot", "root", "requestedAppPath", "appPath", "compilerOperand", "sourceText", "sourceSha256",
    "sourceRevision", "epochMaterial", "profile"]) {
    if (typeof value[key] !== "string") throw new Error(`invalid capture ${key}`);
  }
  if (!Array.isArray(value.inputs) || value.inputs.length > 32000 || !Number.isSafeInteger(value.sourceBytes)) throw new Error("invalid capture inventory");
  runtimeObject(value.semanticOptions);
  validateCapturedSource(value);
  for (const input of value.inputs) validateCaptureInput(input);
  if (value.sourceSnapshot !== undefined) value.sourceSnapshot = reviveSnapshot(value.sourceSnapshot);
  return value as unknown as SingleFileCapture;
}
function validateCapturedSource(value: Record<string, unknown>): void {
  const bytes = Buffer.from(value.sourceText as string, "utf8");
  if (bytes.length !== value.sourceBytes || createHash("sha256").update(bytes).digest("hex") !== value.sourceSha256) {
    throw new Error("capture source bytes/hash mismatch");
  }
}
function validateCaptureInput(raw: unknown): void {
  const input = runtimeObject(raw); runtimeString(input.name);
  if (!["present", "missing", "unreadable"].includes(String(input.state))) throw new Error("invalid capture input state");
  for (const key of ["requestedPath", "canonicalPath", "sha256"]) {
    if (input[key] !== null && typeof input[key] !== "string") throw new Error("invalid capture input");
  }
  if (input.bytes !== null && (!Number.isSafeInteger(input.bytes) || Number(input.bytes) < 0)) throw new Error("invalid capture input size");
}
function reviveSnapshot(raw: unknown) {
  if (!Array.isArray(raw) || raw.length > 32000) throw new Error("invalid source snapshot");
  return raw.map(row => {
    const input = runtimeObject(row), bytes = runtimeObject(input.bytes);
    if (bytes.type !== "Buffer" || !Array.isArray(bytes.data) || bytes.data.length > MAX_RUNTIME_FILE ||
        bytes.data.some(item => !Number.isInteger(item) || item < 0 || item > 255)) throw new Error("invalid source snapshot bytes");
    runtimeString(input.path); runtimeString(input.sha256);
    const actual = Buffer.from(bytes.data as number[]);
    if (createHash("sha256").update(actual).digest("hex") !== input.sha256) throw new Error("source snapshot hash mismatch");
    return { path: input.path, sha256: input.sha256, bytes: actual };
  });
}

async function boundRuntimeSpool(directory: string, nextBytes: number): Promise<void> {
  const entries = await readdir(directory);
  if (entries.length >= 128) throw new Error("runtime output file retention limit reached");
  let retained = nextBytes;
  for (const entry of entries) retained += (await lstat(join(directory, entry))).size;
  if (retained > 128 * 1024 * 1024) throw new Error("runtime output byte retention limit reached");
}
