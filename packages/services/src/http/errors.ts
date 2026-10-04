/**
 * Typed HTTP-layer failures for `@canlang/services` adapters.
 *
 * Classification (S4 brief + DESIGN section 8):
 * - network-error / timeout -> unknown-or-transient; never proof of no
 *   remote effect.
 * - HTTP 4xx -> permanent, except 408/429 (explicit try-again signals),
 *   which ride the section-7 retry budget as transient; HTTP 5xx ->
 *   transient.
 * - cross-origin redirect -> refused with a typed error. Adapter config
 *   fixes one base URL; only same-origin responses are accepted.
 *
 * Errors carry safe metadata only: statuses, origins, limits. Provider
 * response bytes ride on `HttpStatusError.bodyText` for careful mapping
 * (never embedded raw into `DeliveryError` messages).
 */

export type HttpTransportKind = 'network-error' | 'timeout';

/** Local transport failure: the request may or may not have landed. */
export class HttpTransportError extends Error {
  readonly kind: HttpTransportKind;
  constructor(kind: HttpTransportKind) {
    super(kind === 'timeout' ? 'Request timed out' : 'Network error');
    this.name = 'HttpTransportError';
    this.kind = kind;
  }
}

/**
 * Non-2xx response. `transient` is true for 5xx and for the explicit
 * try-again 4xx (408/429); other 4xx is permanent. Retries reuse the same
 * delivery identity, so a duplicate send is impossible; see the adapter
 * mapping.
 */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly transient: boolean;
  /** Bounded raw body; untrusted provider bytes, handle with redaction. */
  readonly bodyText: string;
  constructor(status: number, bodyText: string) {
    super(`Request failed with status ${status}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.transient =
      (status >= 500 && status <= 599) || status === 408 || status === 429;
    this.bodyText = bodyText;
  }
}

/**
 * A redirect left the configured base origin. Origins only (never full
 * URLs) so tokens in query strings cannot leak through the error.
 */
export class HttpRedirectError extends Error {
  readonly fromOrigin: string;
  readonly toOrigin: string;
  constructor(fromOrigin: string, toOrigin: string) {
    super('Refused cross-origin redirect');
    this.name = 'HttpRedirectError';
    this.fromOrigin = fromOrigin;
    this.toOrigin = toOrigin;
  }
}

/** Same-origin redirect chain exceeded the hop cap: fail loudly, never loop. */
export class HttpTooManyRedirectsError extends Error {
  readonly hops: number;
  constructor(hops: number) {
    super('Too many same-origin redirects');
    this.name = 'HttpTooManyRedirectsError';
    this.hops = hops;
  }
}

/** Response body exceeded the configured byte cap. Carries the status so
 * the adapter can still classify by it. */
export class HttpBodyLimitError extends Error {
  readonly status: number;
  readonly maxBytes: number;
  constructor(status: number, maxBytes: number) {
    super(`Response body exceeded ${maxBytes} bytes`);
    this.name = 'HttpBodyLimitError';
    this.status = status;
    this.maxBytes = maxBytes;
  }
}
