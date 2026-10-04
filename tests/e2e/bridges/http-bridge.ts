/**
 * HTTP bridge: serves one L7 `LocalDev` workerd instance over a real
 * localhost TCP port so Playwright drives the worker through genuine HTTP.
 *
 * The bridge owns NO business logic and invents NO responses: every request
 * is forwarded byte-faithfully to `LocalDev.dispatch` (the L7 stable bridge
 * contract) and the worker's response is relayed back with status, headers
 * (including repeated `set-cookie`), and body intact. A bridge-side failure
 * answers 502 with a `e2e bridge` prefix, distinct from any app 5xx.
 *
 * Isolation: callers start one bridge per Playwright worker over one
 * `startLocalDev` instance (one D1 per scope). The bridge binds 127.0.0.1
 * and an ephemeral port by default; it never listens on 0.0.0.0.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { LocalDev } from "@canlang/cloudflare";

export interface BridgeOptions {
  /** Bind host. Default "127.0.0.1". Never pass "0.0.0.0". */
  readonly host?: string;
  /** Bind port. Default 0 (ephemeral). */
  readonly port?: number;
}

export interface HttpBridge {
  /** Base URL, e.g. "http://127.0.0.1:54321". */
  readonly url: string;
  readonly close: () => Promise<void>;
}

/** Headers the bridge manages itself; never forwarded to the worker. */
const HOP_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "expect"]);

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.once("end", () => {
      resolve(Buffer.concat(chunks));
    });
    request.once("error", reject);
  });
}

async function handle(request: IncomingMessage, response: ServerResponse, dev: LocalDev): Promise<void> {
  // Plain pairs, not `new Headers()`: @types/node's Headers and miniflare's
  // bundled undici Headers are distinct classes; pairs satisfy both.
  const headers: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_HEADERS.has(name.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.push([name, entry]);
    } else {
      headers.push([name, value]);
    }
  }
  const body = await readBody(request);
  const method = request.method ?? "GET";
  const workerResponse = await dev.dispatch(request.url ?? "/", {
    method,
    headers,
    // dispatchFetch follows redirects by default, which would swallow the
    // worker's 3xx status, Location, and Set-Cookie (breaking login through
    // the bridge). Manual mode preserves the exact worker response; the
    // browser under test follows redirects itself, as in production.
    redirect: "manual",
    ...(body.length > 0 ? { body } : null),
  });
  const outHeaders: Record<string, string | string[]> = {};
  workerResponse.headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie") return;
    outHeaders[name] = value;
  });
  const setCookies = workerResponse.headers.getSetCookie();
  if (setCookies.length > 0) outHeaders["set-cookie"] = setCookies;
  response.writeHead(workerResponse.status, outHeaders);
  response.end(Buffer.from(await workerResponse.arrayBuffer()));
}

export async function startBridge(dev: LocalDev, options: BridgeOptions = {}): Promise<HttpBridge> {
  const host = options.host ?? "127.0.0.1";
  if (host === "0.0.0.0" || host === "::") {
    throw new Error("e2e bridge: refusing to listen on a wildcard host");
  }
  const server: Server = createServer((request, reply) => {
    void handle(request, reply, dev).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      if (!reply.headersSent) {
        reply.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      }
      reply.end(`e2e bridge dispatch failed: ${detail}`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("e2e bridge: could not determine the bound port");
  }
  return {
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error: Error | undefined) => {
          if (error !== undefined) reject(error);
          else resolve();
        });
      }),
  };
}
