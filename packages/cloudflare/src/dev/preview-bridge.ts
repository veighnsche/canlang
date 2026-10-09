/**
 * Owner-controlled browser access to one local Worker build. The session
 * owner decides when to start/stop this bridge and supplies its disposable
 * LocalDev instance. This bridge never grants application identity.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { BusinessError } from "@canlang/contracts";
import { buildBusinessError, FORM_REFUSAL_HEADER, isBusinessErrorCode } from "@canlang/interfaces";
import type { LocalDev } from "./local-run.js";

const BOOTSTRAP_PATH = "/_can_dev/preview/bootstrap";
const PREVIEW_COOKIE = "can_dev_preview";
const DEFAULT_BOOTSTRAP_TTL_MS = 30_000;
const DEFAULT_COOKIE_TTL_MS = 15 * 60_000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MAX_COOKIES = 8;
const MAX_OBSERVED_ERROR_BYTES = 8 * 1024;

export interface PreviewRefusal {
  readonly requestId: string;
  readonly status: number;
  readonly error: BusinessError;
  /** MCP tool errors retain their actual successful HTTP transport status. */
  readonly transport?: "mcp";
}

/** Node and Fetch manage these headers; they must not be copied verbatim. */
const REQUEST_HOP_HEADERS = new Set([
  "connection", "content-length", "expect", "host", "keep-alive",
  "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade",
]);

export interface ProtectedPreviewOptions {
  /** Test clock; production uses Date.now. */
  readonly now?: () => number;
  readonly bootstrapTtlMs?: number;
  readonly cookieTtlMs?: number;
  readonly maxBodyBytes?: number;
}

export interface ProtectedPreview {
  /** Fixed loopback origin with an OS-selected port. This is not an access URL. */
  readonly url: string;
  /** Mint a one-use access URL. Never include it in ordinary status output. */
  issueOpenUrl(): string;
  observeRefusals(handler: (event: PreviewRefusal) => void): () => void;
  close(): Promise<void>;
}

/** Project the closed code and boolean retry policy; response prose and values are untrusted. */
function observedError(response: Response, body: Buffer, request: {
  method: string; pathname: string; body: Buffer;
}): { error: BusinessError; transport?: "mcp" } | null {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (response.status >= 400 && request.method === "POST" &&
      request.pathname.startsWith("/api/operations/") && contentType.startsWith("text/html")) {
    // HTML may contain the user's draft and credential-bearing controls. Only
    // the owning handler's bounded metadata is eligible for observation.
    const raw = response.headers.get(FORM_REFUSAL_HEADER);
    if (raw === null || Buffer.byteLength(raw, "utf8") > 256) return null;
    let metadata: unknown;
    try { metadata = JSON.parse(raw); } catch { return null; }
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const fields = metadata as Record<string, unknown>;
    if (Object.keys(fields).sort().join(",") !== "code,retryable,version" || fields.version !== 1 ||
        !isBusinessErrorCode(fields.code) || typeof fields.retryable !== "boolean") return null;
    return { error: buildBusinessError(fields.code, undefined, { retryable: fields.retryable }) };
  }
  if (body.length === 0 || body.length > MAX_OBSERVED_ERROR_BYTES ||
      !contentType.startsWith("application/json")) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString("utf8")); } catch { return null; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  let candidate: unknown;
  let transport: "mcp" | undefined;
  if (response.status >= 400) candidate = root.error ?? root;
  else {
    // Success values and protocol errors are not business refusals. Match the
    // owning tools/call envelope rather than interpreting arbitrary JSON.
    if (response.status !== 200 || request.method !== "POST" || request.pathname !== "/mcp" ||
        root.jsonrpc !== "2.0" || root.error !== undefined) return null;
    let call: Record<string, unknown>;
    try {
      const raw: unknown = JSON.parse(request.body.toString("utf8"));
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
      call = raw as Record<string, unknown>;
    } catch { return null; }
    if (call.jsonrpc !== "2.0" || call.method !== "tools/call" ||
        (typeof call.id !== "string" && !(typeof call.id === "number" && Number.isSafeInteger(call.id))) ||
        root.id !== call.id) return null;
    const result = root.result;
    if (result === null || typeof result !== "object" || Array.isArray(result) ||
        (result as Record<string, unknown>).isError !== true) return null;
    candidate = (result as Record<string, unknown>).structuredContent;
    transport = "mcp";
  }
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const error = candidate as Record<string, unknown>;
  if (!isBusinessErrorCode(error.code) || typeof error.message !== "string") return null;
  return { error: buildBusinessError(error.code, undefined,
    typeof error.retryable === "boolean" ? { retryable: error.retryable } : undefined),
    ...(transport === undefined ? {} : { transport }) };
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`preview bridge: ${name} must be a positive safe integer`);
  }
  return value;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sendRefusal(reply: ServerResponse, status: number, code: string): void {
  reply.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  reply.end(JSON.stringify({ code }));
}

function previewCookie(request: IncomingMessage): string | null {
  const source = request.headers.cookie;
  if (source === undefined) return null;
  let found: string | null = null;
  for (const part of source.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator < 0 || trimmed.slice(0, separator) !== PREVIEW_COOKIE) continue;
    if (found !== null) return null; // Duplicate authority is ambiguous.
    found = trimmed.slice(separator + 1);
  }
  return found;
}

function forwardedHeaders(request: IncomingMessage): Array<[string, string]> {
  const headers: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || REQUEST_HOP_HEADERS.has(lower) || lower === "cookie") continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.push([name, entry]);
    } else {
      headers.push([name, value]);
    }
  }
  // The preview cookie belongs to this bridge, never to the Can app.
  const appCookies = (request.headers.cookie ?? "")
    .split(";")
    .map(part => part.trim())
    .filter(part => part.length > 0 && part.split("=", 1)[0] !== PREVIEW_COOKIE);
  if (appCookies.length > 0) headers.push(["cookie", appCookies.join("; ")]);
  return headers;
}

async function boundedBody(request: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const declared = request.headers["content-length"];
  if (declared !== undefined && Number(declared) > maxBytes) return null;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += part.length;
    if (bytes > maxBytes) {
      request.pause();
      return null;
    }
    chunks.push(part);
  }
  return Buffer.concat(chunks, bytes);
}

function isEffectful(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

function whileOpen<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("preview bridge: closed"));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error("preview bridge: closed"));
    signal.addEventListener("abort", abort, { once: true });
    work.then(
      value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

function relay(reply: ServerResponse, workerResponse: Response, body: Buffer): boolean {
  const headers: Record<string, string | string[]> = {};
  workerResponse.headers.forEach((value, name) => {
    if (name.toLowerCase() !== "set-cookie") headers[name] = value;
  });
  const setCookies = workerResponse.headers.getSetCookie();
  // An app must not overwrite the bridge's access cookie. Other cookies,
  // including the application's Identity session, retain their own bytes.
  if (setCookies.some(cookie => cookie.split("=", 1)[0]?.trim() === PREVIEW_COOKIE)) {
    sendRefusal(reply, 502, "preview_cookie_conflict");
    return false;
  }
  if (setCookies.length > 0) headers["set-cookie"] = setCookies;
  reply.writeHead(workerResponse.status, headers);
  reply.end(body);
  return true;
}

/**
 * Start a protected HTTP bridge for a single disposable local Worker.
 * Every browser request requires bridge access; the Worker still applies
 * normal application Identity, grants, policies, and CSRF checks.
 */
export async function startProtectedPreview(
  dev: Pick<LocalDev, "dispatchUrl">,
  options: ProtectedPreviewOptions = {},
): Promise<ProtectedPreview> {
  const now = options.now ?? Date.now;
  const bootstrapTtlMs = positiveLimit(options.bootstrapTtlMs ?? DEFAULT_BOOTSTRAP_TTL_MS, "bootstrapTtlMs");
  const cookieTtlMs = positiveLimit(options.cookieTtlMs ?? DEFAULT_COOKIE_TTL_MS, "cookieTtlMs");
  const maxBodyBytes = positiveLimit(options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, "maxBodyBytes");
  let pending: { hash: string; expiresAt: number } | null = null;
  const cookies = new Map<string, number>();
  const active = new Set<AbortController>();
  const refusalObservers = new Set<(event: PreviewRefusal) => void>();
  let closed = false;
  let origin = "";

  const prune = (): void => {
    for (const [hash, expiresAt] of cookies) {
      if (expiresAt <= now()) cookies.delete(hash);
    }
  };

  const server: Server = createServer((request, reply) => {
    if (closed) {
      reply.destroy();
      return;
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    active.add(controller);
    reply.once("close", abort);
    void (async () => {
      const raw = request.url ?? "";
      if (!raw.startsWith("/") || raw.startsWith("//")) {
        sendRefusal(reply, 400, "invalid_preview_path");
        return;
      }
      let url: URL;
      try {
        url = new URL(raw, origin);
      } catch {
        sendRefusal(reply, 400, "invalid_preview_path");
        return;
      }
      if (url.origin !== origin) {
        sendRefusal(reply, 400, "invalid_preview_path");
        return;
      }
      if (request.headers.host !== new URL(origin).host) {
        sendRefusal(reply, 400, "invalid_preview_host");
        return;
      }
      const method = (request.method ?? "GET").toUpperCase();
      if (url.pathname === BOOTSTRAP_PATH) {
        const token = url.searchParams.get("token");
        const valid = method === "GET" && token !== null && url.searchParams.size === 1 &&
          pending !== null && pending.expiresAt > now() && digest(token) === pending.hash;
        if (!valid) {
          sendRefusal(reply, 403, "invalid_preview_bootstrap");
          return;
        }
        pending = null; // Consumed before any asynchronous work.
        prune();
        const cookie = randomBytes(32).toString("base64url");
        if (cookies.size >= MAX_COOKIES) cookies.delete(cookies.keys().next().value!);
        cookies.set(digest(cookie), now() + cookieTtlMs);
        reply.writeHead(303, {
          "cache-control": "no-store",
          "location": "/",
          "referrer-policy": "no-referrer",
          "set-cookie": `${PREVIEW_COOKIE}=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.ceil(cookieTtlMs / 1000)}`,
        });
        reply.end();
        return;
      }
      prune();
      const cookie = previewCookie(request);
      if (cookie === null || !cookies.has(digest(cookie))) {
        sendRefusal(reply, 401, "preview_access_required");
        return;
      }
      if (isEffectful(method) && request.headers.origin !== origin) {
        sendRefusal(reply, 403, "preview_origin_mismatch");
        return;
      }
      const body = await whileOpen(boundedBody(request, maxBodyBytes), controller.signal);
      if (controller.signal.aborted) return;
      if (body === null) {
        reply.shouldKeepAlive = false;
        sendRefusal(reply, 413, "preview_body_too_large");
        return;
      }
      const workerResponse = await whileOpen(dev.dispatchUrl(url.href, {
        method,
        headers: forwardedHeaders(request),
        redirect: "manual",
        signal: controller.signal,
        ...(body.length > 0 ? { body } : {}),
      }), controller.signal);
      if (controller.signal.aborted) return;
      const responseBody = await whileOpen(workerResponse.arrayBuffer(), controller.signal);
      if (controller.signal.aborted) return;
      const bytes = Buffer.from(responseBody);
      if (relay(reply, workerResponse, bytes) && refusalObservers.size > 0) {
        const observation = observedError(workerResponse, bytes, { method, pathname: url.pathname, body });
        if (observation !== null) {
          const event = { requestId: randomUUID(), status: workerResponse.status, ...observation };
          for (const observer of refusalObservers) {
            try { observer(event); } catch { /* Observation cannot affect the response. */ }
          }
        }
      }
    })().catch(() => {
      if (closed || controller.signal.aborted || reply.destroyed) reply.destroy();
      else if (!reply.headersSent) sendRefusal(reply, 502, "preview_dispatch_failed");
      else reply.destroy();
    }).finally(() => {
      active.delete(controller);
      reply.off("close", abort);
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("preview bridge: could not determine loopback port");
  }
  origin = `http://127.0.0.1:${address.port}`;
  let closing: Promise<void> | null = null;
  return {
    url: origin,
    issueOpenUrl(): string {
      if (closed) throw new Error("preview bridge: closed");
      const token = randomBytes(32).toString("base64url");
      pending = { hash: digest(token), expiresAt: now() + bootstrapTtlMs };
      return `${origin}${BOOTSTRAP_PATH}?token=${token}`;
    },
    observeRefusals(handler): () => void {
      if (closed) return () => undefined;
      refusalObservers.add(handler);
      return () => { refusalObservers.delete(handler); };
    },
    close(): Promise<void> {
      if (closing !== null) return closing;
      closed = true;
      pending = null;
      cookies.clear();
      refusalObservers.clear();
      for (const controller of active) controller.abort();
      closing = new Promise<void>((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error));
        // A Worker dispatch or response body may never settle. Do not hold
        // the owned Worker open waiting for its browser socket to drain.
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
