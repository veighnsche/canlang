/**
 * Native session driver (P03.3): host-side frame codec plus the
 * retained-session loop for one `can-preparation` child process.
 *
 * Wire form mirrors `preparation/src/protocol.rs`: `tag:u8` +
 * `len:u32LE` + payload. Tag 0 carries closed JSON metadata, tag 1
 * raw bytes. The driver enforces the same 64MiB frame cap before
 * allocating and matches each `NeedHost` token exactly once, in
 * issue order. Consumed by the P03.4 launcher; the P03.4 protocol
 * test pins this module against the real binary.
 */

import type { ChildProcess } from "node:child_process";

export const PROTOCOL_NAME = "can-preparation";
export const PROTOCOL_VERSION = 1;
export const TAG_JSON = 0;
export const TAG_BYTES = 1;
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export interface NeedHost {
  need: { token: number; stage: string; request: unknown };
}

export interface Prepared {
  prepared: { scaffold: boolean; mode: string; stages: string[]; resumes: unknown[] };
}

export interface Failed {
  error: { code: string; detail: string };
}

export class ProtocolError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`preparation-protocol: ${detail}`);
    this.name = "ProtocolError";
    this.code = code;
  }
}

/** Encode one frame. Rejects oversized payloads before allocating. */
export function encodeFrame(tag: number, payload: Uint8Array): Uint8Array {
  if (tag !== TAG_JSON && tag !== TAG_BYTES) {
    throw new ProtocolError("frame-corrupt", `unknown frame tag ${tag}`);
  }
  if (payload.length > MAX_FRAME_BYTES) {
    throw new ProtocolError("frame-too-large", `payload ${payload.length} exceeds cap`);
  }
  const out = new Uint8Array(5 + payload.length);
  out[0] = tag;
  new DataView(out.buffer, out.byteOffset + 1, 4).setUint32(0, payload.length, true);
  out.set(payload, 5);
  return out;
}

/** Encode a JSON-tagged frame for any JSON value. */
export function encodeJsonFrame(value: unknown): Uint8Array {
  return encodeFrame(TAG_JSON, new TextEncoder().encode(JSON.stringify(value)));
}

/** Incremental frame decoder over streamed stdout chunks. */
export class FrameDecoder {
  private buffered = new Uint8Array(0);

  /** Feed bytes; returns complete frames, keeping the tail buffered. */
  push(chunk: Uint8Array): Array<{ tag: number; payload: Uint8Array }> {
    const merged = new Uint8Array(this.buffered.length + chunk.length);
    merged.set(this.buffered, 0);
    merged.set(chunk, this.buffered.length);
    this.buffered = merged;
    const frames: Array<{ tag: number; payload: Uint8Array }> = [];
    while (this.buffered.length >= 5) {
      const tag = this.buffered[0] as number;
      const length = new DataView(
        this.buffered.buffer,
        this.buffered.byteOffset + 1,
        4,
      ).getUint32(0, true);
      if (tag !== TAG_JSON && tag !== TAG_BYTES) {
        throw new ProtocolError("frame-corrupt", `unknown frame tag ${tag}`);
      }
      if (length > MAX_FRAME_BYTES) {
        throw new ProtocolError("frame-too-large", `declared length ${length} exceeds cap`);
      }
      if (this.buffered.length < 5 + length) break;
      frames.push({ tag, payload: this.buffered.slice(5, 5 + length) });
      this.buffered = this.buffered.slice(5 + length);
    }
    return frames;
  }

  /** Bytes the peer left mid-frame at EOF (must be empty when clean). */
  trailing(): Uint8Array {
    return this.buffered;
  }
}

function isNeedHost(value: unknown): value is NeedHost {
  if (typeof value !== "object" || value === null) return false;
  const need = (value as { need?: unknown }).need;
  if (typeof need !== "object" || need === null) return false;
  const { token, stage } = need as { token?: unknown; stage?: unknown };
  return typeof token === "number" && Number.isInteger(token) && typeof stage === "string";
}

function isPrepared(value: unknown): value is Prepared {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as { prepared?: unknown }).prepared === "object";
}

function isFailed(value: unknown): value is Failed {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  const { code, detail } = error as { code?: unknown; detail?: unknown };
  return typeof code === "string" && typeof detail === "string";
}

/**
 * Drive one child session: handshake, begin, then answer each
 * `NeedHost` via `onNeed(stage, request)` exactly once until the
 * terminal `Prepared` (returned) or `Failed` (thrown as
 * `ProtocolError` carrying the core code). Any out-of-order frame,
 * token mismatch or trailing garbage fails deterministically.
 */
export async function driveSession(options: {
  child: ChildProcess;
  mode: string;
  onNeed: (stage: string, request: unknown) => Promise<unknown> | unknown;
  timeoutMs?: number | undefined;
}): Promise<Prepared["prepared"]> {
  const { child, mode, onNeed } = options;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (child.stdin === null || child.stdout === null) {
    throw new ProtocolError("frame-corrupt", "child stdio is not piped");
  }
  const stdin = child.stdin;
  const stdout = child.stdout;
  const decoder = new FrameDecoder();
  const pending: Array<{ tag: number; payload: Uint8Array }> = [];
  let ended = false;
  let waiter: (() => void) | null = null;
  let decodeError: ProtocolError | null = null;

  const fail = (code: string, detail: string): never => {
    try {
      child.kill();
    } catch {
      // Already gone; the error below carries the verdict.
    }
    throw new ProtocolError(code, detail);
  };

  stdout.on("data", (chunk: Uint8Array) => {
    // Never throw from a stream callback: record and surface via nextFrame.
    if (decodeError === null) {
      try {
        pending.push(...decoder.push(chunk));
      } catch (error) {
        decodeError =
          error instanceof ProtocolError
            ? error
            : new ProtocolError("frame-corrupt", String(error));
      }
    }
    if (waiter !== null) {
      const wake = waiter;
      waiter = null;
      wake();
    }
  });
  stdout.on("end", () => {
    ended = true;
    if (waiter !== null) {
      const wake = waiter;
      waiter = null;
      wake();
    }
  });

  const nextFrame = async (): Promise<{ tag: number; payload: Uint8Array } | null> => {
    for (;;) {
      if (decodeError !== null) throw decodeError;
      const frame = pending.shift();
      if (frame !== undefined) return frame;
      if (ended) return null;
      await new Promise<void>((resolve) => {
        waiter = resolve;
      });
    }
  };

  const withTimeout = async <T>(promise: Promise<T>, what: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ProtocolError("truncated", `${what} timed out`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };

  try {
    stdin.write(encodeJsonFrame({ protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION }));
    const acceptFrame = await withTimeout(nextFrame(), "handshake");
    if (acceptFrame === null || acceptFrame.tag !== TAG_JSON) {
      // fail() kills the child and throws; the explicit throw keeps
      // narrowing sound even if fail's contract ever weakens.
      fail("frame-corrupt", "handshake: expected a JSON accept frame");
      throw new ProtocolError("frame-corrupt", "unreachable after fail()");
    }
    const accept = JSON.parse(new TextDecoder().decode(acceptFrame.payload)) as {
      ready?: unknown;
      protocol?: unknown;
      version?: unknown;
    };
    if (accept.ready !== true || accept.protocol !== PROTOCOL_NAME || accept.version !== PROTOCOL_VERSION) {
      fail("version-mismatch", `handshake rejected: ${JSON.stringify(accept)}`);
    }
    stdin.write(encodeJsonFrame({ begin: { mode } }));
    let expectedToken = 1;
    for (;;) {
      const frame = await withTimeout(nextFrame(), `resume token ${expectedToken}`);
      if (frame === null) {
        if (decoder.trailing().length > 0) fail("truncated", "EOF mid-frame");
        fail("truncated", "EOF before terminal Prepared/Failed");
        throw new ProtocolError("truncated", "unreachable after fail()");
      }
      if (frame.tag !== TAG_JSON) fail("frame-corrupt", "session messages must be JSON frames");
      const message: unknown = JSON.parse(new TextDecoder().decode(frame.payload));
      if (isFailed(message)) {
        throw new ProtocolError(message.error.code, message.error.detail);
      }
      if (isPrepared(message)) {
        if (decoder.trailing().length > 0) fail("frame-corrupt", "trailing bytes after Prepared");
        stdin.end();
        return message.prepared;
      }
      if (!isNeedHost(message)) {
        fail("protocol-violation", `unexpected message: ${JSON.stringify(message)}`);
      } else if (message.need.token !== expectedToken) {
        fail(
          "protocol-violation",
          `token skew: open ${expectedToken}, got ${message.need.token}`,
        );
      } else {
        const payload = await onNeed(message.need.stage, message.need.request);
        stdin.write(encodeJsonFrame({ resume: { token: expectedToken, payload } }));
        expectedToken += 1;
      }
    }
  } finally {
    stdout.removeAllListeners("data");
    stdout.removeAllListeners("end");
  }
}
