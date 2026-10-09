/**
 * Supervised process launcher for the one-file local development owner.
 * The child owns the session socket and all resources; this module never
 * substitutes a successful process spawn for a verified owner handshake.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { admitSingleAppProfile } from "./compiler-check.js";
import { createInstalledLocalPreviewBuilder } from "./preview-host.js";
import { createInstalledFirstProfileQualification } from "./first-profile-qualification.js";
import { attachDevSessionService, startDevSessionService, type SessionServiceOwner, type SessionServiceStatus } from "./session-service.js";
import {
  captureIsCurrent,
  captureSingleFileSource,
  type SingleFileCapture,
  type SingleFileCaptureRequest,
} from "./source-capture.js";
import {
  discoverSessionSocket,
  SessionSocketError,
  type SessionSocketIdentity,
  type SessionSocketLookup,
} from "./session-socket.js";

const PROFILE = "local-d1-identity";
const DEFAULT_STARTUP_MS = 20_000;
const MAX_STARTUP_MS = 60_000;
const MAX_INIT_BYTES = 1024 * 1024;
const MAX_ERROR_MESSAGE = 300;

export interface DevDaemonStartOptions {
  selectedApp: string;
  capture: SingleFileCaptureRequest;
  runtimeDir?: string;
  startupTimeoutMs?: number;
}

export interface DevDaemonResult {
  attached: boolean;
  identity: SessionSocketIdentity;
  status: SessionServiceStatus;
}

/** The entry override is for an embedded or compiled test runner. */
export interface DevDaemonLauncherDependencies {
  entryPath?: string;
  execPath?: string;
}

interface ChildStartMessage {
  type: "start";
  selectedApp: string;
  capture: SingleFileCaptureRequest;
  runtimeDir?: string;
  expectedSourceRevision: string;
  expectedEpochMaterial: string;
}

type ChildReply =
  | { type: "ready"; identity: SessionSocketIdentity }
  | { type: "failed"; code: string; message: string };

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeMessage(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_ERROR_MESSAGE);
}

function namedApp(source: string): string | null {
  const line = source.split(/\r?\n/).map(item => item.trimStart()).find(item => /^app\s+/.test(item));
  return line?.match(/^app\s+([A-Za-z_][A-Za-z0-9_]*)\b/)?.[1] ?? null;
}

async function admittedCapture(options: Pick<DevDaemonStartOptions, "selectedApp" | "capture">): Promise<SingleFileCapture> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.selectedApp)) {
    throw new SessionSocketError("INVALID_SELECTION", "selected app must be one Can identifier");
  }
  if (options.capture.profile !== PROFILE) {
    throw new SessionSocketError("PROFILE_UNSUPPORTED", "the local D1 and Identity profile is the only daemon profile");
  }
  if (options.capture.catalogPath === null || options.capture.packageInputPaths.length === 0) {
    throw new SessionSocketError("CAPTURE_INCOMPLETE", "compiler catalog and package input inventory are required");
  }
  let captured: SingleFileCapture;
  try {
    captured = await captureSingleFileSource(options.capture);
  } catch (error) {
    throw new SessionSocketError("CAPTURE_INCOMPLETE", safeMessage(error instanceof Error ? error.message : String(error)));
  }
  if (captured.inputs.some(input => input.state !== "present") ||
      !captured.inputs.some(input => input.name.startsWith("package:"))) {
    throw new SessionSocketError("CAPTURE_INCOMPLETE", "every declared compiler and package input must exist");
  }
  const admitted = admitSingleAppProfile(captured.sourceText);
  if (!admitted.ok) throw new SessionSocketError("PROFILE_UNSUPPORTED", safeMessage(admitted.reason));
  if (namedApp(captured.sourceText) !== options.selectedApp) {
    throw new SessionSocketError("SELECTION_MISMATCH", "selected app differs from the captured source declaration");
  }
  if (!(await captureIsCurrent(captured))) {
    throw new SessionSocketError("CAPTURE_CHANGED", "source or installed inputs changed during admission");
  }
  return captured;
}

function childMessage(value: unknown): ChildReply | null {
  const reply = object(value);
  if (reply?.type === "failed" && typeof reply.code === "string" && typeof reply.message === "string") {
    return { type: "failed", code: reply.code, message: safeMessage(reply.message) };
  }
  if (reply?.type === "ready") {
    const identity = object(reply.identity);
    if (identity && typeof identity.sessionId === "string" && typeof identity.root === "string" &&
        typeof identity.app === "string" && typeof identity.profile === "string" &&
        typeof identity.processStart === "string" && typeof identity.pid === "number") {
      return { type: "ready", identity: reply.identity as SessionSocketIdentity };
    }
  }
  return null;
}

function startupLimit(value: number | undefined): number {
  const selected = value ?? DEFAULT_STARTUP_MS;
  if (!Number.isSafeInteger(selected) || selected < 1_000 || selected > MAX_STARTUP_MS) {
    throw new SessionSocketError("INVALID_LIMIT", "daemon startup timeout is outside the supported range");
  }
  return selected;
}

function sendStart(child: ChildProcess, message: ChildStartMessage): Promise<void> {
  let encoded: string;
  try { encoded = JSON.stringify(message); }
  catch { throw new SessionSocketError("INVALID_START", "daemon setup cannot be encoded"); }
  if (Buffer.byteLength(encoded) > MAX_INIT_BYTES) {
    throw new SessionSocketError("INVALID_START", "daemon setup exceeds the private IPC byte limit");
  }
  return new Promise((resolveSend, rejectSend) => {
    child.send(message, error => {
      if (error) rejectSend(new SessionSocketError("DAEMON_START_FAILED", "daemon setup could not be delivered"));
      else resolveSend();
    });
  });
}

function awaitReply(child: ChildProcess, timeoutMs: number): Promise<ChildReply> {
  return new Promise((resolveReply, rejectReply) => {
    const timer = setTimeout(() => finish(new SessionSocketError("DAEMON_START_TIMEOUT", "session owner did not become ready")), timeoutMs);
    function finish(error?: Error, reply?: ChildReply): void {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) rejectReply(error);
      else resolveReply(reply!);
    }
    function onMessage(value: unknown): void {
      const reply = childMessage(value);
      if (reply === null) finish(new SessionSocketError("INVALID_RESPONSE", "session owner returned an invalid startup reply"));
      else finish(undefined, reply);
    }
    function onError(): void { finish(new SessionSocketError("DAEMON_START_FAILED", "session owner process failed")); }
    function onExit(): void { finish(new SessionSocketError("DAEMON_START_FAILED", "session owner exited before ready")); }
    child.once("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function verifiedStatus(lookup: SessionSocketLookup, expected?: SingleFileCapture): Promise<DevDaemonResult> {
  const client = await attachDevSessionService(lookup);
  const response = await client.request({ command: "status" });
  const status = object(response);
  if (status?.schema !== "can.dev.status.v1" || status.session !== client.identity.sessionId ||
      status.app !== client.identity.app || status.profile !== client.identity.profile) {
    throw new SessionSocketError("INVALID_RESPONSE", "session status does not match the verified owner");
  }
  if (expected && status.source_revision !== expected.sourceRevision) {
    throw new SessionSocketError("CAPTURE_CHANGED", "session source revision differs from the admitted source");
  }
  return { attached: false, identity: client.identity, status: response as SessionServiceStatus };
}

/** Discovery verifies the private descriptor and owner handshake before status. */
export async function discoverDevDaemon(lookup: SessionSocketLookup): Promise<DevDaemonResult> {
  const found = await verifiedStatus(lookup);
  return { ...found, attached: true };
}

/**
 * Start the long-lived owner. An existing owner is a conflict because its
 * non-source input inventory is not yet exposed by the owner handshake.
 * `ready` means control is usable; preview readiness is reported separately.
 */
export async function startDevDaemon(
  options: DevDaemonStartOptions,
  dependencies: DevDaemonLauncherDependencies = {},
): Promise<DevDaemonResult> {
  const timeoutMs = startupLimit(options.startupTimeoutMs);
  const expected = await admittedCapture(options);
  const entryPath = dependencies.entryPath ?? fileURLToPath(new URL("./session-daemon-entry.js", import.meta.url));
  try { await access(entryPath); }
  catch { throw new SessionSocketError("DAEMON_ENTRY_UNAVAILABLE", "built development owner entry is unavailable"); }
  const lookup: SessionSocketLookup = {
    checkoutRoot: expected.root,
    app: options.selectedApp,
    profile: PROFILE,
    ...(options.runtimeDir === undefined ? {} : { runtimeDir: options.runtimeDir }),
  };
  const child = spawn(dependencies.execPath ?? process.execPath, [entryPath, "--serve"], {
    cwd: expected.root,
    detached: true,
    shell: false,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let handedOff = false;
  try {
    const replyPromise = awaitReply(child, timeoutMs);
    const delivery = sendStart(child, {
      type: "start", selectedApp: options.selectedApp, capture: options.capture,
      ...(options.runtimeDir === undefined ? {} : { runtimeDir: options.runtimeDir }),
      expectedSourceRevision: expected.sourceRevision,
      expectedEpochMaterial: expected.epochMaterial,
    });
    const [reply] = await Promise.all([replyPromise, delivery]);
    if (reply.type === "failed") throw new SessionSocketError(reply.code, reply.message);
    if (reply.identity.root !== expected.root || reply.identity.app !== options.selectedApp ||
        reply.identity.profile !== PROFILE || reply.identity.pid !== child.pid) {
      throw new SessionSocketError("SESSION_MISMATCH", "daemon startup identity did not match its child process");
    }
    const verified = await verifiedStatus({ ...lookup, sessionId: reply.identity.sessionId }, expected);
    if (verified.identity.processStart !== reply.identity.processStart ||
        verified.identity.pid !== reply.identity.pid) {
      throw new SessionSocketError("SESSION_MISMATCH", "daemon startup reply differs from the verified owner");
    }
    const current = await captureSingleFileSource(options.capture);
    if (current.epochMaterial !== expected.epochMaterial || !(await captureIsCurrent(current))) {
      throw new SessionSocketError("CAPTURE_CHANGED", "source or installed inputs changed before daemon handoff");
    }
    handedOff = true;
    child.disconnect();
    child.unref();
    return verified;
  } finally {
    if (!handedOff) {
      if (child.connected) child.disconnect();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    }
  }
}

/** Stop only the verified owner and wait for its private endpoint to vanish. */
export async function stopDevDaemon(lookup: SessionSocketLookup, timeoutMs = 5_000): Promise<{ session: string; stopped: true }> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new SessionSocketError("INVALID_LIMIT", "daemon stop timeout is outside the supported range");
  }
  const client = await discoverSessionSocket(lookup);
  const session = client.identity.sessionId;
  await client.request({ command: "stop" });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
    try {
      await discoverSessionSocket({ ...lookup, sessionId: session });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { session, stopped: true };
      }
      if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED" ||
          (error instanceof SessionSocketError && ["CONTROL_CLOSED", "CONTROL_TIMEOUT"].includes(error.code))) {
        continue;
      }
      throw error;
    }
  }
  throw new SessionSocketError("DAEMON_STOP_TIMEOUT", "session owner did not release its control endpoint");
}

function childRequest(value: unknown): ChildStartMessage | null {
  const item = object(value);
  const capture = object(item?.capture);
  if (item?.type !== "start" || typeof item.selectedApp !== "string" ||
      typeof item.expectedSourceRevision !== "string" || typeof item.expectedEpochMaterial !== "string" ||
      (item.runtimeDir !== undefined && typeof item.runtimeDir !== "string") ||
      capture === null || typeof capture.checkoutRoot !== "string" || typeof capture.appPath !== "string" ||
      typeof capture.profile !== "string" || typeof capture.compilerPath !== "string" ||
      (capture.catalogPath !== null && typeof capture.catalogPath !== "string") ||
      typeof capture.helpIndexPath !== "string" || !Array.isArray(capture.packageInputPaths)) return null;
  return item as unknown as ChildStartMessage;
}

/** Invoked only by the dedicated spawned entry. It owns signals and cleanup. */
export async function serveDevDaemonProcess(): Promise<void> {
  if (typeof process.send !== "function") {
    throw new SessionSocketError("DAEMON_IPC_REQUIRED", "session owner requires private launcher IPC");
  }
  let owner: SessionServiceOwner | null = null;
  let stopping: Promise<void> | null = null;
  let terminationRequested = false;
  const stop = (): Promise<void> => {
    terminationRequested = true;
    if (owner === null) return Promise.resolve();
    if (stopping !== null) return stopping;
    stopping = owner.stop();
    return stopping;
  };
  process.once("SIGTERM", () => {
    void stop().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
  });
  process.once("SIGINT", () => {
    void stop().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
  });
  try {
    const init = await new Promise<unknown>((resolveInit, rejectInit) => {
      const timer = setTimeout(() => rejectInit(new SessionSocketError("DAEMON_START_TIMEOUT", "launcher did not provide setup")), DEFAULT_STARTUP_MS);
      process.once("message", value => { clearTimeout(timer); resolveInit(value); });
      process.once("disconnect", () => { clearTimeout(timer); rejectInit(new SessionSocketError("DAEMON_START_FAILED", "launcher disconnected before setup")); });
    });
    const request = childRequest(init);
    if (request === null || Buffer.byteLength(JSON.stringify(init)) > MAX_INIT_BYTES) {
      throw new SessionSocketError("INVALID_START", "daemon setup is invalid or too large");
    }
    const captured = await admittedCapture(request);
    if (captured.sourceRevision !== request.expectedSourceRevision ||
        captured.epochMaterial !== request.expectedEpochMaterial) {
      throw new SessionSocketError("CAPTURE_CHANGED", "source or installed inputs changed before owner startup");
    }
    owner = await startDevSessionService({
      selectedApp: request.selectedApp,
      capture: request.capture,
      previewBuilder: createInstalledLocalPreviewBuilder(),
      constructRanking: { qualify: createInstalledFirstProfileQualification() },
      ...(request.runtimeDir === undefined ? {} : { runtimeDir: request.runtimeDir }),
    });
    if (terminationRequested) {
      throw new SessionSocketError("DAEMON_START_FAILED", "launcher terminated during owner startup");
    }
    const after = await captureSingleFileSource(request.capture);
    const status = owner.status();
    if (after.epochMaterial !== captured.epochMaterial || !(await captureIsCurrent(after)) ||
        status.source_revision !== captured.sourceRevision || status.capture_error !== null) {
      throw new SessionSocketError("CAPTURE_CHANGED", "source or installed inputs changed during owner startup");
    }
    if (terminationRequested) {
      throw new SessionSocketError("DAEMON_START_FAILED", "launcher terminated before owner handoff");
    }
    await new Promise<void>((resolveSend, rejectSend) => {
      process.send!({ type: "ready", identity: owner!.identity } satisfies ChildReply, error =>
        error ? rejectSend(error) : resolveSend());
    });
  } catch (error) {
    await stop().catch(() => undefined);
    const code = error instanceof SessionSocketError ? error.code : "DAEMON_START_FAILED";
    const message = safeMessage(error instanceof Error ? error.message : "session owner failed to start");
    if (process.connected) {
      await new Promise<void>(resolveSend => {
        process.send!({ type: "failed", code, message } satisfies ChildReply, () => resolveSend());
      });
    }
    process.exitCode = 1;
  }
}
