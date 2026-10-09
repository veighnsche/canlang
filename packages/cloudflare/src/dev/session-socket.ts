import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

/** The transport owns no application authority; it only binds a local owner. */
export const SESSION_SOCKET_PROTOCOL = "can.dev.control.v1";
const PROCESS_START_ID = randomBytes(16).toString("hex");
const execFileAsync = promisify(execFile);
const DEFAULT_REQUEST_BYTES = 64 * 1024;
const DEFAULT_RESPONSE_BYTES = 128 * 1024;
const DEFAULT_HANDSHAKE_MS = 1_500;
const DEFAULT_REQUEST_MS = 30_000;
const MAX_REQUEST_MS = 60_000;
const INCOMPLETE_CLAIM_GRACE_MS = 10_000;

export class SessionSocketError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SessionSocketError";
  }
}

export interface SessionSocketIdentity {
  protocol: typeof SESSION_SOCKET_PROTOCOL;
  root: string;
  app: string;
  profile: string;
  sessionId: string;
  pid: number;
  uid: number;
  processStart: string;
  socketPath: string;
}

export interface SessionSocketCommand {
  command: string;
  payload?: unknown;
}

export interface SessionSocketOptions {
  checkoutRoot: string;
  app: string;
  profile: string;
  /** Test/embedding override; still must be private and outside checkout. */
  runtimeDir?: string;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
  handle(command: SessionSocketCommand, signal: AbortSignal): Promise<unknown> | unknown;
}

export interface SessionSocketOwner {
  identity: SessionSocketIdentity;
  descriptorPath: string;
  stop(): Promise<void>;
}

export interface SessionSocketLookup {
  checkoutRoot: string;
  app?: string;
  profile?: string;
  sessionId?: string;
  runtimeDir?: string;
}

export interface SessionSocketClient {
  identity: SessionSocketIdentity;
  request(command: SessionSocketCommand): Promise<unknown>;
}

interface SessionPaths {
  runtimeDir: string;
  sessionDir: string;
  claimPath: string;
  descriptorPath: string;
  socketPath: string;
}

type StoredClaim = Pick<SessionSocketIdentity, "root" | "sessionId" | "pid" | "uid" | "processStart"> & {
  processBirth?: string;
};

function currentUid(): number {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    throw new SessionSocketError("UNSUPPORTED_PLATFORM", "Unix session control requires a local UID");
  }
  return process.getuid();
}

function isInside(parent: string, candidate: string): boolean {
  const rest = relative(parent, candidate);
  return rest === "" || (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest));
}

function numericLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 128 || value > 1024 * 1024) {
    throw new SessionSocketError("INVALID_LIMIT", "control transport limit is out of range");
  }
  return value;
}

async function canonicalRoot(path: string): Promise<string> {
  const root = await realpath(path);
  const info = await stat(root);
  if (!info.isDirectory()) throw new SessionSocketError("INVALID_ROOT", "checkout root is not a directory");
  return root;
}

async function privateDirectory(path: string, create: boolean): Promise<void> {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== currentUid() || (info.mode & 0o077) !== 0) {
    throw new SessionSocketError("INSECURE_RUNTIME_DIR", "control runtime directory is not owner-only");
  }
}

async function privateFile(path: string, kind: "file" | "socket"): Promise<void> {
  const info = await lstat(path);
  if (
    info.uid !== currentUid() ||
    (info.mode & 0o077) !== 0 ||
    (kind === "file" ? !info.isFile() : !info.isSocket())
  ) {
    throw new SessionSocketError("INSECURE_ENDPOINT", "control endpoint is not owner-only");
  }
}

async function pathsFor(root: string, override?: string, create = true): Promise<SessionPaths> {
  const uid = currentUid();
  const givenBase = override === undefined ? join(await realpath(tmpdir()), `cv-${uid}`) : resolve(override);
  if (create) await privateDirectory(givenBase, true);
  else await privateDirectory(givenBase, false);
  const base = await realpath(givenBase);
  if (isInside(root, base)) {
    throw new SessionSocketError("INVALID_RUNTIME_DIR", "control runtime directory must be outside checkout");
  }
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 24);
  const sessionDir = join(base, hash);
  const socketPath = join(sessionDir, "s");
  // Darwin sockaddr_un is short; fail before claiming a checkout.
  if (Buffer.byteLength(socketPath) > 100) {
    throw new SessionSocketError("SOCKET_PATH_TOO_LONG", "control socket path exceeds the portable Unix limit");
  }
  return {
    runtimeDir: base,
    sessionDir,
    claimPath: join(sessionDir, "claim.json"),
    descriptorPath: join(sessionDir, "descriptor.json"),
    socketPath,
  };
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function storedIdentity(value: unknown): SessionSocketIdentity | null {
  const item = object(value);
  if (
    item?.protocol !== SESSION_SOCKET_PROTOCOL ||
    typeof item.root !== "string" ||
    typeof item.app !== "string" ||
    typeof item.profile !== "string" ||
    typeof item.sessionId !== "string" ||
    typeof item.pid !== "number" ||
    typeof item.uid !== "number" ||
    typeof item.processStart !== "string" ||
    typeof item.socketPath !== "string"
  ) return null;
  return item as unknown as SessionSocketIdentity;
}

function storedClaim(value: unknown): StoredClaim | null {
  const item = object(value);
  if (
    typeof item?.root !== "string" ||
    typeof item.sessionId !== "string" ||
    typeof item.pid !== "number" ||
    typeof item.uid !== "number" ||
    typeof item.processStart !== "string"
  ) return null;
  return {
    root: item.root, sessionId: item.sessionId, pid: item.pid,
    uid: item.uid, processStart: item.processStart,
    ...(typeof item.processBirth === "string" ? { processBirth: item.processBirth } : {}),
  };
}

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** /proc stat keeps the command in parentheses; it may itself contain spaces or ')'. */
function procStatFields(entry: string, pid: number): string[] | null {
  const close = entry.lastIndexOf(")");
  if (close < 0 || !entry.startsWith(`${pid} (`)) return null;
  const fields = entry.slice(close + 1).trim().split(/\s+/);
  return fields.length >= 20 && /^[A-Za-z]$/.test(fields[0] ?? "") && /^\d+$/.test(fields[19] ?? "")
    ? fields : null;
}

async function linuxProcessDead(pid: number): Promise<boolean> {
  if (process.platform !== "linux") return false;
  try {
    const fields = procStatFields(await readFile(`/proc/${pid}/stat`, "utf8"), pid);
    // A missing/restricted/malformed proc entry cannot authorize reclaim.
    return fields?.[0] === "Z" || fields?.[0] === "X";
  } catch {
    return false;
  }
}

async function processBirth(pid: number, format?: "proc" | "ps"): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux" && format !== "ps") {
    try {
      const [entry, bootId] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      ]);
      const startTicks = procStatFields(entry, pid)?.[19]; // /proc stat field 22, after pid and comm.
      if (startTicks && /^\d+$/.test(startTicks) && bootId.trim()) {
        return `proc:${bootId.trim()}:${startTicks}`;
      }
    } catch { /* A restricted procfs cannot establish process identity. */ }
  }
  if (format === "proc") return null;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C" }, timeout: DEFAULT_HANDSHAKE_MS, maxBuffer: 1024,
    });
    const started = stdout.trim().replace(/\s+/g, " ");
    return started ? `ps:${started}` : null;
  } catch {
    return null;
  }
}

async function claimProcessAlive(claim: StoredClaim): Promise<boolean> {
  if (!pidAlive(claim.pid)) return false;
  if (await linuxProcessDead(claim.pid)) return false;
  const format = claim.processBirth?.startsWith("proc:") ? "proc"
    : claim.processBirth?.startsWith("ps:") ? "ps" : undefined;
  if (!format) return true;
  const actualBirth = await processBirth(claim.pid, format);
  return actualBirth === null || actualBirth === claim.processBirth;
}

function writeLine(socket: Socket, value: unknown, maxBytes: number, direction: "request" | "response" = "response"): void {
  let line: string;
  try {
    line = JSON.stringify(value);
  } catch {
    throw new SessionSocketError("INVALID_RESPONSE", "control response is not JSON serializable");
  }
  if (line === undefined || Buffer.byteLength(line) + 1 > maxBytes) {
    throw new SessionSocketError(
      direction === "request" ? "REQUEST_TOO_LARGE" : "RESPONSE_TOO_LARGE",
      `control ${direction} exceeds byte limit`,
    );
  }
  socket.write(`${line}\n`);
}

function readLine(socket: Socket, maxBytes: number, timeoutMs: number): Promise<unknown> {
  return new Promise((resolveLine, rejectLine) => {
    let bytes = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new SessionSocketError("CONTROL_TIMEOUT", "control endpoint timed out")), timeoutMs);
    function finish(error?: Error, value?: unknown): void {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      if (error) rejectLine(error);
      else resolveLine(value);
    }
    function onData(chunk: Buffer): void {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > maxBytes) return finish(new SessionSocketError("RESPONSE_TOO_LARGE", "control frame exceeds byte limit"));
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      try {
        finish(undefined, JSON.parse(bytes.subarray(0, newline).toString("utf8")) as unknown);
      } catch {
        finish(new SessionSocketError("INVALID_RESPONSE", "control endpoint returned invalid JSON"));
      }
    }
    function onError(error: Error): void { finish(error); }
    function onEnd(): void { finish(new SessionSocketError("CONTROL_CLOSED", "control endpoint closed")); }
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

function dial(path: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      rejectSocket(new SessionSocketError("CONTROL_TIMEOUT", "control endpoint did not connect"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", onError);
      resolveSocket(socket);
    });
    function onError(error: Error): void {
      clearTimeout(timer);
      rejectSocket(error);
    }
    socket.once("error", onError);
  });
}

async function hello(socket: Socket, expected: SessionSocketIdentity): Promise<void> {
  const nonce = randomBytes(16).toString("hex");
  writeLine(socket, { type: "hello", ...expected, nonce }, DEFAULT_REQUEST_BYTES, "request");
  const answer = object(await readLine(socket, DEFAULT_RESPONSE_BYTES, DEFAULT_HANDSHAKE_MS));
  if (
    answer?.type !== "hello" || answer.nonce !== nonce ||
    answer.protocol !== expected.protocol || answer.root !== expected.root ||
    answer.app !== expected.app || answer.profile !== expected.profile ||
    answer.sessionId !== expected.sessionId || answer.processStart !== expected.processStart ||
    answer.pid !== expected.pid || answer.uid !== expected.uid ||
    answer.socketPath !== expected.socketPath
  ) throw new SessionSocketError("SESSION_MISMATCH", "control handshake did not match selected session");
}

async function verifyLive(identity: SessionSocketIdentity): Promise<boolean> {
  let socket: Socket | undefined;
  try {
    await privateFile(identity.socketPath, "socket");
    socket = await dial(identity.socketPath, DEFAULT_HANDSHAKE_MS);
    await hello(socket, identity);
    return true;
  } catch {
    return false;
  } finally {
    socket?.destroy();
  }
}

function sameInode(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

async function acquireRecoveryLock(root: string, reclaimPath: string): Promise<{
  owner: StoredClaim;
  inode: { dev: number; ino: number };
}> {
  const ownerPath = join(reclaimPath, "owner.json");
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await mkdir(reclaimPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: { dev: number; ino: number; mtimeMs: number };
      try {
        await privateDirectory(reclaimPath, false);
        existing = await lstat(reclaimPath);
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw inspectionError;
      }
      const previous = storedClaim(await readJson(ownerPath));
      if (previous?.root !== undefined && previous.root !== root) {
        throw new SessionSocketError("ROOT_COLLISION", "recovery lock belongs to another checkout");
      }
      if (previous ? await claimProcessAlive(previous) : Date.now() - existing.mtimeMs < INCOMPLETE_CLAIM_GRACE_MS) {
        throw new SessionSocketError("RECOVERY_IN_PROGRESS", "another process is recovering this session");
      }
      const stalePath = `${reclaimPath}.stale-${randomBytes(8).toString("hex")}`;
      try {
        await rename(reclaimPath, stalePath);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw renameError;
      }
      const moved = await lstat(stalePath);
      if (!sameInode(existing, moved)) {
        // Another contender replaced the stale lock; put its live lock back if possible.
        const replacement = await lstat(reclaimPath).catch(() => null);
        if (!replacement) await rename(stalePath, reclaimPath).catch(() => undefined);
        throw new SessionSocketError("RECOVERY_IN_PROGRESS", "recovery lock changed during takeover");
      }
      await rm(stalePath, { recursive: true, force: true });
      continue;
    }
    const inode = await lstat(reclaimPath);
    const birth = await processBirth(process.pid);
    const owner: StoredClaim = {
      root, sessionId: randomBytes(16).toString("hex"), pid: process.pid,
      uid: currentUid(), processStart: PROCESS_START_ID,
      ...(birth === null ? {} : { processBirth: birth }),
    };
    try {
      await writeFile(ownerPath, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
    } catch (writeError) {
      const current = await lstat(reclaimPath).catch(() => null);
      if (current && sameInode(current, inode)) await rm(reclaimPath, { recursive: true, force: true });
      throw writeError;
    }
    return { owner, inode };
  }
  throw new SessionSocketError("RECOVERY_IN_PROGRESS", "another process is recovering this session");
}

async function reclaimStale(root: string, paths: SessionPaths): Promise<void> {
  const reclaimPath = `${paths.sessionDir}.recover`;
  const lock = await acquireRecoveryLock(root, reclaimPath);
  try {
    await privateDirectory(paths.sessionDir, false);
    const staleDirectory = await lstat(paths.sessionDir);
    const claim = storedClaim(await readJson(paths.claimPath));
    const descriptor = storedIdentity(await readJson(paths.descriptorPath));
    if ((claim?.root !== undefined && claim.root !== root) || (descriptor?.root !== undefined && descriptor.root !== root)) {
      throw new SessionSocketError("ROOT_COLLISION", "session index belongs to another checkout");
    }
    if (descriptor && await verifyLive(descriptor)) {
      throw new SessionSocketError("SESSION_EXISTS", "a live session already owns this checkout");
    }
    if (claim && await claimProcessAlive(claim)) {
      throw new SessionSocketError("OWNER_UNRESPONSIVE", "session owner is alive but its control endpoint is unavailable");
    }
    if (!claim) {
      const age = Date.now() - (await stat(paths.sessionDir)).mtimeMs;
      if (age < INCOMPLETE_CLAIM_GRACE_MS) {
        throw new SessionSocketError("CLAIM_IN_PROGRESS", "session claim is still being created");
      }
    }
    const currentLock = await lstat(reclaimPath).catch(() => null);
    if (!currentLock || !sameInode(currentLock, lock.inode)) {
      throw new SessionSocketError("RECOVERY_IN_PROGRESS", "recovery lock changed before takeover");
    }
    const stalePath = `${paths.sessionDir}.stale-${randomBytes(8).toString("hex")}`;
    await rename(paths.sessionDir, stalePath);
    const movedDirectory = await lstat(stalePath);
    if (!sameInode(staleDirectory, movedDirectory)) {
      const replacement = await lstat(paths.sessionDir).catch(() => null);
      if (!replacement) await rename(stalePath, paths.sessionDir).catch(() => undefined);
      throw new SessionSocketError("RECOVERY_IN_PROGRESS", "session directory changed during takeover");
    }
    try {
      await mkdir(paths.sessionDir, { mode: 0o700 });
    } finally {
      await rm(stalePath, { recursive: true, force: true });
    }
  } finally {
    const currentLock = await lstat(reclaimPath).catch(() => null);
    if (currentLock && sameInode(currentLock, lock.inode)) {
      const currentOwner = storedClaim(await readJson(join(reclaimPath, "owner.json")));
      if (currentOwner?.sessionId === lock.owner.sessionId) {
        await rm(reclaimPath, { recursive: true, force: true });
      }
    }
  }
}

async function claimRoot(root: string, paths: SessionPaths): Promise<void> {
  try {
    await mkdir(paths.sessionDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await reclaimStale(root, paths);
  }
  await privateDirectory(paths.sessionDir, false);
}

function serveConnection(
  socket: Socket,
  identity: SessionSocketIdentity,
  options: SessionSocketOptions,
  controllers: Set<AbortController>,
): void {
  const maxRequest = numericLimit(options.maxRequestBytes, DEFAULT_REQUEST_BYTES);
  const maxResponse = numericLimit(options.maxResponseBytes, DEFAULT_RESPONSE_BYTES);
  const requestMs = numericLimit(options.requestTimeoutMs, DEFAULT_REQUEST_MS);
  let stage: "hello" | "request" | "busy" | "done" = "hello";
  let bytes = Buffer.alloc(0);
  const handshakeTimer = setTimeout(() => socket.destroy(), DEFAULT_HANDSHAKE_MS);
  let idleTimer: NodeJS.Timeout | undefined;
  socket.on("close", () => {
    clearTimeout(handshakeTimer);
    if (idleTimer) clearTimeout(idleTimer);
  });
  socket.on("data", (chunk: Buffer) => {
    if (stage === "busy" || stage === "done") {
      socket.destroy();
      return;
    }
    bytes = Buffer.concat([bytes, chunk]);
    if (bytes.length > maxRequest) {
      socket.destroy();
      return;
    }
    while (stage === "hello" || stage === "request") {
      const newline = bytes.indexOf(10);
      if (newline < 0) break;
      const line = bytes.subarray(0, newline).toString("utf8");
      bytes = bytes.subarray(newline + 1);
      let frame: Record<string, unknown> | null;
      try { frame = object(JSON.parse(line) as unknown); }
      catch { socket.destroy(); return; }
      if (stage === "hello") {
        if (
          frame?.type !== "hello" || frame.protocol !== identity.protocol ||
          frame.root !== identity.root || frame.app !== identity.app ||
          frame.profile !== identity.profile || frame.sessionId !== identity.sessionId ||
          frame.processStart !== identity.processStart ||
          frame.pid !== identity.pid || frame.uid !== identity.uid ||
          frame.socketPath !== identity.socketPath ||
          typeof frame.nonce !== "string" || frame.nonce.length !== 32
        ) { socket.destroy(); return; }
        clearTimeout(handshakeTimer);
        try { writeLine(socket, { type: "hello", ...identity, nonce: frame.nonce }, maxResponse); }
        catch { socket.destroy(); return; }
        idleTimer = setTimeout(() => socket.destroy(), DEFAULT_HANDSHAKE_MS);
        stage = "request";
        continue;
      }
      if (
        frame?.type !== "request" || typeof frame.id !== "string" || frame.id.length > 64 ||
        typeof frame.command !== "string" || frame.command.length === 0 || frame.command.length > 100
      ) { socket.destroy(); return; }
      if (idleTimer) clearTimeout(idleTimer);
      stage = "busy";
      const command: SessionSocketCommand = { command: frame.command, payload: frame.payload };
      const controller = new AbortController();
      controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), requestMs);
      void Promise.race([
        Promise.resolve().then(() => options.handle(command, controller.signal)),
        new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(
          new SessionSocketError("REQUEST_TIMEOUT", "control request timed out"),
        ), { once: true })),
      ]).then(
        result => {
          try { writeLine(socket, { type: "response", id: frame!.id, ok: true, result: result ?? null }, maxResponse); }
          catch { writeLine(socket, { type: "response", id: frame!.id, ok: false, error: { code: "RESPONSE_TOO_LARGE", message: "control response exceeds byte limit" } }, maxResponse); }
        },
        error => {
          const code = error instanceof SessionSocketError ? error.code : "REQUEST_FAILED";
          const message = error instanceof SessionSocketError ? error.message : "control request failed";
          try { writeLine(socket, { type: "response", id: frame!.id, ok: false, error: { code, message } }, maxResponse); }
          catch { socket.destroy(); }
        },
      ).finally(() => {
        clearTimeout(timer);
        controllers.delete(controller);
        stage = "done";
        socket.end();
      });
      break;
    }
  });
}

export async function startSessionSocket(options: SessionSocketOptions): Promise<SessionSocketOwner> {
  const root = await canonicalRoot(options.checkoutRoot);
  if (!options.app || !options.profile) throw new SessionSocketError("INVALID_SELECTION", "app and profile are required");
  numericLimit(options.maxRequestBytes, DEFAULT_REQUEST_BYTES);
  numericLimit(options.maxResponseBytes, DEFAULT_RESPONSE_BYTES);
  if (numericLimit(options.requestTimeoutMs, DEFAULT_REQUEST_MS) > MAX_REQUEST_MS) {
    throw new SessionSocketError("INVALID_LIMIT", "control request timeout exceeds the supported limit");
  }
  const paths = await pathsFor(root, options.runtimeDir);
  await claimRoot(root, paths);
  const identity: SessionSocketIdentity = {
    protocol: SESSION_SOCKET_PROTOCOL,
    root,
    app: options.app,
    profile: options.profile,
    sessionId: randomBytes(24).toString("hex"),
    pid: process.pid,
    uid: currentUid(),
    processStart: PROCESS_START_ID,
    socketPath: paths.socketPath,
  };
  const ownedDirectory = await lstat(paths.sessionDir);
  let server: Server | undefined;
  const sockets = new Set<Socket>();
  const controllers = new Set<AbortController>();
  try {
    const helloBytes = Buffer.byteLength(JSON.stringify({ type: "hello", ...identity, nonce: "0".repeat(32) })) + 1;
    if (helloBytes > numericLimit(options.maxResponseBytes, DEFAULT_RESPONSE_BYTES)) {
      throw new SessionSocketError("INVALID_LIMIT", "control response limit cannot fit session handshake");
    }
    const birth = await processBirth(process.pid);
    const claim: StoredClaim = {
      root, sessionId: identity.sessionId, pid: identity.pid,
      uid: identity.uid, processStart: identity.processStart,
      ...(birth === null ? {} : { processBirth: birth }),
    };
    await writeFile(paths.claimPath, JSON.stringify(claim), { mode: 0o600, flag: "wx" });
    server = createServer(socket => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      serveConnection(socket, identity, options, controllers);
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server!.once("error", rejectListen);
      server!.listen(paths.socketPath, () => {
        server!.off("error", rejectListen);
        resolveListen();
      });
    });
    await chmod(paths.socketPath, 0o600);
    const temporaryDescriptor = join(paths.sessionDir, `descriptor-${identity.sessionId}.tmp`);
    await writeFile(temporaryDescriptor, JSON.stringify(identity), { mode: 0o600, flag: "wx" });
    await rename(temporaryDescriptor, paths.descriptorPath);
    let stopped = false;
    return {
      identity,
      descriptorPath: paths.descriptorPath,
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        for (const controller of controllers) controller.abort();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolveClose => server!.close(() => resolveClose()));
        const current = await lstat(paths.sessionDir).catch(() => null);
        if (current && current.dev === ownedDirectory.dev && current.ino === ownedDirectory.ino) {
          const claimNow = storedClaim(await readJson(paths.claimPath));
          if (claimNow?.sessionId === identity.sessionId) {
            await rm(paths.sessionDir, { recursive: true, force: true });
          }
        }
      },
    };
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise<void>(resolveClose => server!.close(() => resolveClose()));
    const current = await lstat(paths.sessionDir).catch(() => null);
    if (current && current.dev === ownedDirectory.dev && current.ino === ownedDirectory.ino) {
      await rm(paths.sessionDir, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function discoverSessionSocket(lookup: SessionSocketLookup): Promise<SessionSocketClient> {
  const root = await canonicalRoot(lookup.checkoutRoot);
  const paths = await pathsFor(root, lookup.runtimeDir, false);
  await privateDirectory(paths.sessionDir, false);
  await privateFile(paths.descriptorPath, "file");
  const identity = storedIdentity(await readJson(paths.descriptorPath));
  if (!identity || identity.root !== root || identity.uid !== currentUid() || identity.socketPath !== paths.socketPath) {
    throw new SessionSocketError("INVALID_DESCRIPTOR", "session descriptor does not match this checkout");
  }
  if (
    (lookup.app !== undefined && lookup.app !== identity.app) ||
    (lookup.profile !== undefined && lookup.profile !== identity.profile) ||
    (lookup.sessionId !== undefined && lookup.sessionId !== identity.sessionId)
  ) throw new SessionSocketError("SESSION_MISMATCH", "session selection does not match descriptor");
  await privateFile(paths.socketPath, "socket");
  const first = await dial(paths.socketPath, DEFAULT_HANDSHAKE_MS);
  try { await hello(first, identity); }
  finally { first.destroy(); }
  return {
    identity,
    async request(command): Promise<unknown> {
      if (!command.command || command.command.length > 100) {
        throw new SessionSocketError("INVALID_COMMAND", "control command is invalid");
      }
      await privateFile(paths.socketPath, "socket");
      const socket = await dial(paths.socketPath, DEFAULT_HANDSHAKE_MS);
      try {
        await hello(socket, identity);
        const id = randomBytes(8).toString("hex");
        writeLine(socket, { type: "request", id, command: command.command, payload: command.payload }, DEFAULT_REQUEST_BYTES, "request");
        const answer = object(await readLine(socket, DEFAULT_RESPONSE_BYTES, MAX_REQUEST_MS + DEFAULT_HANDSHAKE_MS));
        if (answer?.type !== "response" || answer.id !== id || typeof answer.ok !== "boolean") {
          throw new SessionSocketError("INVALID_RESPONSE", "control response does not match request");
        }
        if (answer.ok) return answer.result;
        const failure = object(answer.error);
        throw new SessionSocketError(
          typeof failure?.code === "string" ? failure.code : "REQUEST_FAILED",
          typeof failure?.message === "string" ? failure.message : "control request failed",
        );
      } finally {
        socket.destroy();
      }
    },
  };
}
