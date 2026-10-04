/**
 * Typed fetch wrapper for provider adapters. Native fetch only.
 *
 * - One fixed base URL per client; requests outside its origin are
 *   rejected before sending, and cross-origin redirects are refused
 *   with `HttpRedirectError` (same-origin redirects are followed).
 * - `AbortController` timeout: one deadline covers headers, redirect hops
 *   and the bounded body read. Expiry yields a `timeout` transport error
 *   (even mid-body: a header-then-drip response cannot hang the adapter);
 *   unreachable hosts yield `network-error`.
 * - Response bodies are read through a bounded reader (`maxBodyBytes`);
 *   oversized bodies yield `HttpBodyLimitError`, never truncation.
 * - Non-2xx responses yield `HttpStatusError` with 4xx-permanent /
 *   5xx-transient classification.
 */
import {
  HttpBodyLimitError,
  HttpRedirectError,
  HttpStatusError,
  HttpTooManyRedirectsError,
  HttpTransportError,
} from './errors.ts';

/** Maximum same-origin redirect hops per request. */
const MAX_REDIRECT_HOPS = 5;

function isRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

export interface HttpClientConfig {
  /** Single fixed provider endpoint origin, e.g. `https://mail.example`. */
  readonly baseUrl: string;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Maximum accepted response body size in bytes. */
  readonly maxBodyBytes: number;
  /** Optional literal `Authorization` header value (server-only). */
  readonly authorization?: string;
}

export interface HttpRequest {
  readonly method: 'GET' | 'POST';
  /** Path resolved against `baseUrl`, e.g. `/send`. */
  readonly path: string;
  /** JSON request body for POST. */
  readonly body?: string;
  /** Sent as the `Idempotency-Key` header when present. */
  readonly idempotencyKey?: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly url: string;
  readonly bodyText: string;
}

function baseOriginOf(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError('baseUrl must be an absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('baseUrl must use http(s)');
  }
  return parsed.origin;
}

export function assertValidHttpConfig(config: HttpClientConfig): void {
  baseOriginOf(config.baseUrl);
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be a positive finite number');
  }
  if (!Number.isInteger(config.maxBodyBytes) || config.maxBodyBytes <= 0) {
    throw new RangeError('maxBodyBytes must be a positive integer');
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  status: number,
): Promise<string> {
  if (response.body === null) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Already closed; the limit error below is what matters.
        }
        throw new HttpBodyLimitError(status, maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released via cancel.
    }
  }
  let size = 0;
  for (const chunk of chunks) {
    size += chunk.byteLength;
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function httpRequest(
  config: HttpClientConfig,
  request: HttpRequest,
): Promise<HttpResponse> {
  assertValidHttpConfig(config);
  const baseOrigin = baseOriginOf(config.baseUrl);
  let url: URL;
  try {
    url = new URL(request.path, config.baseUrl);
  } catch {
    throw new TypeError('request path is not a valid URL or path');
  }
  if (url.origin !== baseOrigin) {
    throw new TypeError('request path escapes the configured base URL');
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);
  // Same-endpoint redirect policy, enforced BEFORE following: manual mode
  // exposes status + Location, so each hop's target origin is checked
  // against the fixed base URL and a cross-origin redirect is refused
  // without sending the second request. Same-origin hops are followed
  // (301/302/303 convert POST to GET per fetch semantics; 307/308
  // preserve method and body) up to a hop cap.
  let method: 'GET' | 'POST' = request.method;
  let body: string | undefined = request.body;
  let hops = 0;
  let response: Response;
  let bodyText: string;
  try {
    for (;;) {
      const headers: Record<string, string> = {};
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
      }
      if (request.idempotencyKey !== undefined) {
        headers['idempotency-key'] = request.idempotencyKey;
      }
      if (config.authorization !== undefined) {
        headers['authorization'] = config.authorization;
      }
      try {
        response = await fetch(url.href, {
          method,
          headers,
          body,
          signal: controller.signal,
          redirect: 'manual',
          credentials: 'omit',
        });
      } catch {
        throw new HttpTransportError(timedOut ? 'timeout' : 'network-error');
      }
      if (!isRedirect(response.status)) {
        break;
      }
      const location = response.headers.get('location');
      try {
        await response.arrayBuffer();
      } catch {
        if (timedOut) {
          throw new HttpTransportError('timeout');
        }
        // Drained body is best effort; the hop below is what matters.
      }
      if (timedOut) {
        throw new HttpTransportError('timeout');
      }
      if (location === null) {
        break;
      }
      const next = new URL(location, url);
      if (next.origin !== baseOrigin) {
        throw new HttpRedirectError(baseOrigin, next.origin);
      }
      hops += 1;
      if (hops > MAX_REDIRECT_HOPS) {
        throw new HttpTooManyRedirectsError(hops);
      }
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          method === 'POST')
      ) {
        method = 'GET';
        body = undefined;
      }
      url = next;
    }
    try {
      bodyText = await readBoundedBody(
        response,
        config.maxBodyBytes,
        response.status,
      );
    } catch (err) {
      if (err instanceof HttpBodyLimitError) {
        throw err;
      }
      throw new HttpTransportError(
        timedOut || controller.signal.aborted ? 'timeout' : 'network-error',
      );
    }
  } finally {
    clearTimeout(timer);
  }
  if (response.status < 200 || response.status > 299) {
    throw new HttpStatusError(response.status, bodyText);
  }
  return { status: response.status, url: url.href, bodyText };
}
