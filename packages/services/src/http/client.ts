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
  /**
   * Caller-owned cancellation. When this aborts (and the deadline did
   * not expire first), the original abort error propagates instead of a
   * transport mapping, so the caller can tell its own cancellation
   * apart from timeout/network failure.
   */
  readonly signal?: AbortSignal;
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

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
  status: number,
): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array(0);
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
  return merged;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  status: number,
): Promise<string> {
  return new TextDecoder().decode(
    await readBoundedBytes(response, maxBytes, status),
  );
}

function resolveRequestUrl(config: HttpClientConfig, request: HttpRequest): URL {
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
  return url;
}

function combinedSignal(
  controller: AbortController,
  request: HttpRequest,
): AbortSignal {
  return request.signal === undefined
    ? controller.signal
    : AbortSignal.any([controller.signal, request.signal]);
}

interface FetchedResponse {
  readonly response: Response;
  readonly url: URL;
}

// Same-endpoint redirect policy, enforced BEFORE following: manual mode
// exposes status + Location, so each hop's target origin is checked
// against the fixed base URL and a cross-origin redirect is refused
// without sending the second request. Same-origin hops are followed
// (301/302/303 convert POST to GET per fetch semantics; 307/308
// preserve method and body) up to a hop cap. Shared by the buffered
// and streaming readers so both enforce the identical policy.
async function fetchWithRedirects(
  config: HttpClientConfig,
  request: HttpRequest,
  startUrl: URL,
  signal: AbortSignal,
  timedOut: () => boolean,
): Promise<FetchedResponse> {
  const baseOrigin = baseOriginOf(config.baseUrl);
  let method: 'GET' | 'POST' = request.method;
  let body: string | undefined = request.body;
  let url = startUrl;
  let hops = 0;
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
    let response: Response;
    try {
      response = await fetch(url.href, {
        method,
        headers,
        body,
        signal,
        redirect: 'manual',
        credentials: 'omit',
      });
    } catch (err) {
      if (timedOut()) {
        throw new HttpTransportError('timeout');
      }
      if (request.signal?.aborted === true) {
        throw err;
      }
      throw new HttpTransportError('network-error');
    }
    if (!isRedirect(response.status)) {
      return { response, url };
    }
    const location = response.headers.get('location');
    try {
      await response.arrayBuffer();
    } catch (err) {
      if (timedOut()) {
        throw new HttpTransportError('timeout');
      }
      if (request.signal?.aborted === true) {
        throw err;
      }
      // Drained body is best effort; the hop below is what matters.
    }
    if (timedOut()) {
      throw new HttpTransportError('timeout');
    }
    if (request.signal?.aborted === true) {
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    if (location === null) {
      return { response, url };
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
}

function startDeadline(
  config: HttpClientConfig,
): { controller: AbortController; timer: ReturnType<typeof setTimeout>; timedOut: () => boolean } {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, config.timeoutMs);
  return { controller, timer, timedOut: () => expired };
}

export async function httpRequest(
  config: HttpClientConfig,
  request: HttpRequest,
): Promise<HttpResponse> {
  assertValidHttpConfig(config);
  const startUrl = resolveRequestUrl(config, request);
  const { controller, timer, timedOut } = startDeadline(config);
  const signal = combinedSignal(controller, request);
  let bodyText: string;
  let fetched: FetchedResponse;
  try {
    fetched = await fetchWithRedirects(
      config,
      request,
      startUrl,
      signal,
      timedOut,
    );
    try {
      bodyText = await readBoundedBody(
        fetched.response,
        config.maxBodyBytes,
        fetched.response.status,
      );
    } catch (err) {
      if (err instanceof HttpBodyLimitError) {
        throw err;
      }
      if (timedOut()) {
        throw new HttpTransportError('timeout');
      }
      if (request.signal?.aborted === true) {
        throw err;
      }
      throw new HttpTransportError('network-error');
    }
  } finally {
    clearTimeout(timer);
  }
  if (fetched.response.status < 200 || fetched.response.status > 299) {
    throw new HttpStatusError(fetched.response.status, bodyText);
  }
  return {
    status: fetched.response.status,
    url: fetched.url.href,
    bodyText,
  };
}

/** Binary response: exact bytes plus the transport content-type claim. */
export interface HttpBinaryResponse {
  readonly status: number;
  readonly url: string;
  readonly bytes: Uint8Array;
  /** Raw `content-type` header, or null when absent. Untrusted claim. */
  readonly contentType: string | null;
}

/**
 * Binary variant of `httpRequest` for provider byte downloads: same
 * origin/redirect/deadline/cap policy, but the body is returned as
 * exact bytes (never UTF-8 decoded) with the transport content-type.
 * Non-2xx statuses throw `HttpStatusError` with a bounded text body.
 */
export async function httpRequestBinary(
  config: HttpClientConfig,
  request: HttpRequest,
): Promise<HttpBinaryResponse> {
  assertValidHttpConfig(config);
  const startUrl = resolveRequestUrl(config, request);
  const { controller, timer, timedOut } = startDeadline(config);
  const signal = combinedSignal(controller, request);
  let bytes: Uint8Array;
  let fetched: FetchedResponse;
  try {
    fetched = await fetchWithRedirects(
      config,
      request,
      startUrl,
      signal,
      timedOut,
    );
    try {
      bytes = await readBoundedBytes(
        fetched.response,
        config.maxBodyBytes,
        fetched.response.status,
      );
    } catch (err) {
      if (err instanceof HttpBodyLimitError) {
        throw err;
      }
      if (timedOut()) {
        throw new HttpTransportError('timeout');
      }
      if (request.signal?.aborted === true) {
        throw err;
      }
      throw new HttpTransportError('network-error');
    }
  } finally {
    clearTimeout(timer);
  }
  if (fetched.response.status < 200 || fetched.response.status > 299) {
    throw new HttpStatusError(
      fetched.response.status,
      new TextDecoder().decode(bytes),
    );
  }
  return {
    status: fetched.response.status,
    url: fetched.url.href,
    bytes,
    contentType: fetched.response.headers.get('content-type'),
  };
}

/** One incrementally decoded text segment of a streamed response. */
export interface HttpStreamProgress {
  /** Decoded text appended since the previous segment. */
  readonly text: string;
  /** Total response bytes received so far. */
  readonly totalBytes: number;
}

/**
 * Stream a response body as decoded text segments. Enforces the same
 * policy as `httpRequest`: single deadline over headers, hops and the
 * whole stream; same-origin redirects only; total byte cap (exceeding
 * it throws `HttpBodyLimitError` mid-stream, never truncation).
 * Non-2xx statuses throw `HttpStatusError` before any segment is
 * yielded. Callers MUST fully consume, break or return the generator
 * so the deadline timer is released; caller-owned `request.signal`
 * aborts surface as the original abort error.
 */
export async function* httpStreamText(
  config: HttpClientConfig,
  request: HttpRequest,
): AsyncGenerator<HttpStreamProgress, { status: number; url: string }, void> {
  assertValidHttpConfig(config);
  const startUrl = resolveRequestUrl(config, request);
  const { controller, timer, timedOut } = startDeadline(config);
  const signal = combinedSignal(controller, request);
  try {
    const fetched = await fetchWithRedirects(
      config,
      request,
      startUrl,
      signal,
      timedOut,
    );
    const { response } = fetched;
    if (response.status < 200 || response.status > 299) {
      let bodyText = '';
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
        if (timedOut()) {
          throw new HttpTransportError('timeout');
        }
        if (request.signal?.aborted === true) {
          throw err;
        }
        throw new HttpTransportError('network-error');
      }
      throw new HttpStatusError(response.status, bodyText);
    }
    if (response.body === null) {
      return { status: response.status, url: fetched.url.href };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    try {
      for (;;) {
        let read: ReadableStreamReadResult<Uint8Array>;
        try {
          read = await reader.read();
        } catch (err) {
          if (timedOut()) {
            throw new HttpTransportError('timeout');
          }
          if (request.signal?.aborted === true) {
            throw err;
          }
          throw new HttpTransportError('network-error');
        }
        if (read.done) {
          break;
        }
        total += read.value.byteLength;
        if (total > config.maxBodyBytes) {
          try {
            await reader.cancel();
          } catch {
            // Already closed; the limit error below is what matters.
          }
          throw new HttpBodyLimitError(response.status, config.maxBodyBytes);
        }
        const text = decoder.decode(read.value, { stream: true });
        if (text.length > 0) {
          yield { text, totalBytes: total };
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Already released via cancel.
      }
    }
    const tail = decoder.decode();
    if (tail.length > 0) {
      yield { text: tail, totalBytes: total };
    }
    return { status: response.status, url: fetched.url.href };
  } finally {
    clearTimeout(timer);
  }
}
