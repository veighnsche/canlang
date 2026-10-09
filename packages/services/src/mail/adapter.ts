/**
 * `std.EmailV1` provider adapter.
 *
 * - Builds a frozen provider request from `EmailSendInput`: recipient,
 *   subject and body frozen with finalized attachment refs, plus the
 *   aggregate attachment byte count resolved through `AttachmentSizes`.
 * - Enforces the aggregate transport limit before sending: oversized or
 *   unresolvable attachment sets are rejected, never sent partially and
 *   never trimmed silently.
 * - Sends via the typed fetch wrapper with the delivery id as the
 *   idempotency key, then maps the outcome to a validated
 *   `CapabilityCompletion<EmailAccepted>`:
 *   2xx + `{reference}` -> succeeded; 4xx -> failed (permanent);
 *   5xx / timeout / lost response / cross-origin redirect -> unknown
 *   (never proof of no remote effect); invalid provider schemas ->
 *   failed (`invalid_response`), never pending.
 * - `unknown` completions retain the original delivery id so
 *   `reconcile` reuses that identity (`GET /deliveries/{id}`).
 * - All `DeliveryError` values use stable codes with redacted messages.
 */
import type {
  CapabilityCompletion,
  DeliveryError,
  EmailAccepted,
  EmailSendInput,
} from '@canlang/contracts';
import { assertValidHttpConfig, httpRequest } from '../http/client.js';
import type { HttpClientConfig } from '../http/client.js';
import {
  HttpBodyLimitError,
  HttpRedirectError,
  HttpStatusError,
  HttpTooManyRedirectsError,
  HttpTransportError,
} from '../http/errors.js';
import { deliveryError, specificOrGeneric } from './redact.js';
import { fixedAttachmentSizes, systemClock } from '../ports.js';
import type { AttachmentSizes, Clock, MailSender } from '../ports.js';

export type AttachmentRef = EmailSendInput['attachments'][number];

export interface EmailAdapterConfig {
  /** Fixed provider endpoint origin. */
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
  /** Literal `Authorization` header value; server-only, never logged. */
  readonly authorization?: string;
  /**
   * Declared aggregate attachment limit in bytes. `null` means the
   * deployment declares no limit, so enforcement is skipped.
   */
  readonly maxTransportBytes: number | null;
  /** Injected for deterministic tests; defaults to wall clock. */
  readonly clock?: Clock;
  /** Resolves finalized refs to byte sizes; unknown refs reject. */
  readonly sizes?: AttachmentSizes;
}

/** Frozen provider request: the committed outbox snapshot for one send. */
export interface FrozenMailRequest {
  readonly deliveryId: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly attachments: Readonly<EmailSendInput['attachments']>;
  /** Aggregate attachment bytes resolved through `AttachmentSizes`. */
  readonly attachmentBytes: number;
  /** Creation instant from the injected clock. */
  readonly createdAt: number;
}

export interface FrozenMailRequestContext {
  readonly deliveryId: string;
  readonly createdAt: number;
  readonly sizes: AttachmentSizes;
  readonly maxTransportBytes: number | null;
}

export class MailValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailValidationError';
  }
}

/** An attachment ref could not be resolved to a size: refuse, never drop. */
export class MailAttachmentError extends Error {
  readonly refs: readonly AttachmentRef[];
  constructor(refs: readonly AttachmentRef[]) {
    super('Cannot resolve attachment sizes; refusing to send');
    this.name = 'MailAttachmentError';
    this.refs = refs;
  }
}

/**
 * Aggregate transport limit exceeded before sending. Carries the frozen
 * request with attachments intact for inspection.
 */
export class MailTransportLimitError extends Error {
  readonly request: FrozenMailRequest;
  readonly limitBytes: number;
  constructor(request: FrozenMailRequest, limitBytes: number) {
    super(
      `Aggregate attachment size ${request.attachmentBytes} exceeds transport limit ${limitBytes}`,
    );
    this.name = 'MailTransportLimitError';
    this.request = request;
    this.limitBytes = limitBytes;
  }
}

export class MailCompletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailCompletionError';
  }
}

const SEND_PATH = '/send';
const DELIVERIES_PREFIX = '/deliveries/';

const GENERIC = {
  rejected: 'Mail delivery rejected by provider.',
  rateLimited: 'Mail provider rate-limited the send; outcome unknown.',
  clientTimeout: 'Mail provider timed out waiting for the send; outcome unknown.',
  transient: 'Mail provider returned a transient error; outcome unknown.',
  timeout: 'Mail send timed out; outcome unknown.',
  unreachable: 'Mail provider unreachable; outcome unknown.',
  redirectRefused:
    'Mail provider redirected off the configured endpoint; outcome unknown.',
  redirectLoop:
    'Mail provider redirected repeatedly without answering; outcome unknown.',
  invalidResponse: 'Mail provider returned an invalid response.',
  unknownDelivery: 'Mail provider has no record of this delivery.',
} as const;

/**
 * Freeze recipient/subject/body plus finalized attachment refs and
 * enforce the aggregate transport limit. The aggregate covers attachment
 * bytes (DESIGN: the provider "applies its declared aggregate transport
 * limit, and reports rejection instead of dropping attachments"); the
 * small envelope text is bounded by the HTTP body cap instead.
 */
export function buildFrozenMailRequest(
  input: EmailSendInput,
  ctx: FrozenMailRequestContext,
): FrozenMailRequest {
  if (typeof input !== 'object' || input === null) {
    throw new MailValidationError('Email input must be an object');
  }
  const { to, subject, body, attachments } = input;
  if (typeof to !== 'string' || to.length === 0) {
    throw new MailValidationError(
      'Email recipient must be a non-empty string',
    );
  }
  if (typeof subject !== 'string') {
    throw new MailValidationError('Email subject must be a string');
  }
  if (typeof body !== 'string') {
    throw new MailValidationError('Email body must be a string');
  }
  if (
    !Array.isArray(attachments) ||
    !attachments.every((ref) => typeof ref === 'string')
  ) {
    throw new MailValidationError(
      'Email attachments must be finalized file references',
    );
  }
  const frozenAttachments = Object.freeze(attachments.slice());
  let attachmentBytes = 0;
  let unresolved = false;
  for (const ref of frozenAttachments) {
    const size = ctx.sizes.sizeOf(ref);
    if (size === null || !Number.isSafeInteger(size) || size < 0) {
      unresolved = true;
      continue;
    }
    attachmentBytes += size;
    if (!Number.isSafeInteger(attachmentBytes)) unresolved = true;
  }
  if (unresolved) {
    throw new MailAttachmentError(frozenAttachments);
  }
  const request: FrozenMailRequest = {
    deliveryId: ctx.deliveryId,
    to,
    subject,
    body,
    attachments: frozenAttachments,
    attachmentBytes,
    createdAt: ctx.createdAt,
  };
  Object.freeze(request);
  if (
    ctx.maxTransportBytes !== null &&
    attachmentBytes > ctx.maxTransportBytes
  ) {
    throw new MailTransportLimitError(request, ctx.maxTransportBytes);
  }
  return request;
}

export function succeededCompletion(
  deliveryId: string,
  reference: string,
): CapabilityCompletion<EmailAccepted> {
  return {
    delivery_id: deliveryId,
    status: 'succeeded',
    result: { reference },
    error: null,
  };
}

export function failedCompletion(
  deliveryId: string,
  error: DeliveryError,
): CapabilityCompletion<EmailAccepted> {
  return {
    delivery_id: deliveryId,
    status: 'failed',
    result: null,
    error,
  };
}

export function unknownCompletion(
  deliveryId: string,
  error: DeliveryError | null,
): CapabilityCompletion<EmailAccepted> {
  return {
    delivery_id: deliveryId,
    status: 'unknown',
    result: null,
    error,
  };
}

/**
 * Skipped (undispatched/superseded/ineligible) completion. The adapter
 * itself never skips; the runtime uses this for false dispatch guards.
 */
export function skippedCompletion(
  deliveryId: string,
): CapabilityCompletion<EmailAccepted> {
  return {
    delivery_id: deliveryId,
    status: 'skipped',
    result: null,
    error: null,
  };
}

/**
 * Validate status and payload together (DESIGN section 8): succeeded
 * carries result + null error; failed carries null result + non-null
 * error; unknown carries null result + diagnostic-or-null; skipped
 * carries null + null. Pending is a receipt, never a completion.
 */
export function assertValidCompletion<R>(
  completion: CapabilityCompletion<R>,
): void {
  if (typeof completion !== 'object' || completion === null) {
    throw new MailCompletionError('Completion must be an object');
  }
  const { delivery_id, status, result, error } = completion;
  if (typeof delivery_id !== 'string' || delivery_id.length === 0) {
    throw new MailCompletionError(
      'Completion delivery_id must be a non-empty string',
    );
  }
  const validError =
    typeof error === 'object' &&
    error !== null &&
    typeof error.code === 'string' &&
    error.code.length > 0 &&
    typeof error.message === 'string' &&
    error.message.length > 0;
  switch (status) {
    case 'succeeded':
      if (result === null || result === undefined || error !== null) {
        throw new MailCompletionError(
          'succeeded requires a result and null error',
        );
      }
      break;
    case 'failed':
      if (result !== null || !validError) {
        throw new MailCompletionError(
          'failed requires null result and non-null error',
        );
      }
      break;
    case 'unknown':
      if (result !== null || !(error === null || validError)) {
        throw new MailCompletionError(
          'unknown requires null result and a diagnostic error or null',
        );
      }
      break;
    case 'skipped':
      if (result !== null || error !== null) {
        throw new MailCompletionError('skipped requires null result and null error');
      }
      break;
    default:
      throw new MailCompletionError(
        'pending is a receipt, never a completion',
      );
  }
}

function readReference(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const reference = (value as Record<string, unknown>)['reference'];
  return typeof reference === 'string' && reference.length > 0
    ? reference
    : null;
}

/** Extract a candidate provider message from a rejection body, if any. */
function readProviderMessage(bodyText: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (typeof parsed === 'string') {
    return parsed;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record['message'] === 'string') {
    return record['message'];
  }
  if (typeof record['error'] === 'string') {
    return record['error'];
  }
  return undefined;
}

/** Map a send outcome by status code (exported for unit tests). */
export function mapSendResponse(
  deliveryId: string,
  status: number,
  bodyText: string,
): CapabilityCompletion<EmailAccepted> {
  if (status >= 200 && status <= 299) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = undefined;
    }
    const reference = readReference(parsed);
    if (reference === null) {
      return failedCompletion(
        deliveryId,
        deliveryError('invalid_response', GENERIC.invalidResponse),
      );
    }
    return succeededCompletion(deliveryId, reference);
  }
  if (status === 408 || status === 429) {
    return unknownCompletion(
      deliveryId,
      deliveryError(
        status === 429 ? 'provider_rate_limited' : 'provider_client_timeout',
        status === 429 ? GENERIC.rateLimited : GENERIC.clientTimeout,
      ),
    );
  }
  if (status >= 400 && status <= 499) {
    const message = specificOrGeneric(
      readProviderMessage(bodyText),
      GENERIC.rejected,
    );
    return failedCompletion(
      deliveryId,
      deliveryError('provider_rejected', message),
    );
  }
  if (status >= 500 && status <= 599) {
    return unknownCompletion(
      deliveryId,
      deliveryError('provider_transient', GENERIC.transient),
    );
  }
  // No final 1xx/3xx is a valid provider answer to a send.
  return failedCompletion(
    deliveryId,
    deliveryError('invalid_response', GENERIC.invalidResponse),
  );
}

/** Map a send transport failure; rethrows non-HTTP (unexpected) errors. */
export function mapSendError(
  deliveryId: string,
  err: unknown,
): CapabilityCompletion<EmailAccepted> {
  if (err instanceof HttpStatusError) {
    return mapSendResponse(deliveryId, err.status, err.bodyText);
  }
  if (err instanceof HttpBodyLimitError) {
    if (err.status >= 200 && err.status <= 299) {
      return failedCompletion(
        deliveryId,
        deliveryError('invalid_response', GENERIC.invalidResponse),
      );
    }
    return mapSendResponse(deliveryId, err.status, '');
  }
  if (err instanceof HttpTransportError) {
    return err.kind === 'timeout'
      ? unknownCompletion(
          deliveryId,
          deliveryError('transport_timeout', GENERIC.timeout),
        )
      : unknownCompletion(
          deliveryId,
          deliveryError('transport_unreachable', GENERIC.unreachable),
        );
  }
  if (err instanceof HttpRedirectError) {
    return unknownCompletion(
      deliveryId,
      deliveryError('redirect_refused', GENERIC.redirectRefused),
    );
  }
  if (err instanceof HttpTooManyRedirectsError) {
    return unknownCompletion(
      deliveryId,
      deliveryError('too_many_redirects', GENERIC.redirectLoop),
    );
  }
  throw err;
}

/** Map a reconcile outcome by status code (exported for unit tests). */
export function mapReconcileResponse(
  deliveryId: string,
  status: number,
  bodyText: string,
): CapabilityCompletion<EmailAccepted> {
  if (status >= 200 && status <= 299) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      parsed = undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return failedCompletion(
        deliveryId,
        deliveryError('invalid_response', GENERIC.invalidResponse),
      );
    }
    const record = parsed as Record<string, unknown>;
    switch (record['status']) {
      case 'accepted': {
        const reference = readReference(parsed);
        if (reference === null) {
          return failedCompletion(
            deliveryId,
            deliveryError('invalid_response', GENERIC.invalidResponse),
          );
        }
        return succeededCompletion(deliveryId, reference);
      }
      case 'rejected': {
        const message = specificOrGeneric(
          record['message'] ?? record['error'],
          GENERIC.rejected,
        );
        return failedCompletion(
          deliveryId,
          deliveryError('provider_rejected', message),
        );
      }
      case 'pending':
        return unknownCompletion(deliveryId, null);
      default:
        return failedCompletion(
          deliveryId,
          deliveryError('invalid_response', GENERIC.invalidResponse),
        );
    }
  }
  if (status === 404) {
    return failedCompletion(
      deliveryId,
      deliveryError('unknown_delivery', GENERIC.unknownDelivery),
    );
  }
  if (status === 408 || status === 429) {
    return unknownCompletion(
      deliveryId,
      deliveryError(
        status === 429 ? 'provider_rate_limited' : 'provider_client_timeout',
        status === 429 ? GENERIC.rateLimited : GENERIC.clientTimeout,
      ),
    );
  }
  if (status >= 400 && status <= 499) {
    return failedCompletion(
      deliveryId,
      deliveryError('provider_rejected', GENERIC.rejected),
    );
  }
  if (status >= 500 && status <= 599) {
    return unknownCompletion(
      deliveryId,
      deliveryError('provider_transient', GENERIC.transient),
    );
  }
  return failedCompletion(
    deliveryId,
    deliveryError('invalid_response', GENERIC.invalidResponse),
  );
}

/** Map a reconcile transport failure; rethrows unexpected errors. */
export function mapReconcileError(
  deliveryId: string,
  err: unknown,
): CapabilityCompletion<EmailAccepted> {
  if (err instanceof HttpStatusError) {
    return mapReconcileResponse(deliveryId, err.status, err.bodyText);
  }
  if (err instanceof HttpBodyLimitError) {
    if (err.status >= 200 && err.status <= 299) {
      return failedCompletion(
        deliveryId,
        deliveryError('invalid_response', GENERIC.invalidResponse),
      );
    }
    return mapReconcileResponse(deliveryId, err.status, '');
  }
  if (err instanceof HttpTransportError) {
    return err.kind === 'timeout'
      ? unknownCompletion(
          deliveryId,
          deliveryError('transport_timeout', GENERIC.timeout),
        )
      : unknownCompletion(
          deliveryId,
          deliveryError('transport_unreachable', GENERIC.unreachable),
        );
  }
  if (err instanceof HttpRedirectError) {
    return unknownCompletion(
      deliveryId,
      deliveryError('redirect_refused', GENERIC.redirectRefused),
    );
  }
  if (err instanceof HttpTooManyRedirectsError) {
    return unknownCompletion(
      deliveryId,
      deliveryError('too_many_redirects', GENERIC.redirectLoop),
    );
  }
  throw err;
}

export class EmailV1Adapter implements MailSender {
  private readonly http: HttpClientConfig;
  private readonly maxTransportBytes: number | null;
  private readonly clock: Clock;
  private readonly sizes: AttachmentSizes;

  constructor(config: EmailAdapterConfig) {
    assertValidHttpConfig({
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      maxBodyBytes: config.maxBodyBytes,
    });
    if (
      config.maxTransportBytes !== null &&
      (!Number.isInteger(config.maxTransportBytes) ||
        config.maxTransportBytes < 0)
    ) {
      throw new RangeError(
        'maxTransportBytes must be a non-negative integer or null',
      );
    }
    this.http = {
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      maxBodyBytes: config.maxBodyBytes,
      ...(config.authorization === undefined
        ? {}
        : { authorization: config.authorization }),
    };
    this.maxTransportBytes = config.maxTransportBytes;
    this.clock = config.clock ?? systemClock();
    this.sizes = config.sizes ?? fixedAttachmentSizes({});
  }

  async send(
    input: EmailSendInput,
    options: { readonly deliveryId: string },
  ): Promise<CapabilityCompletion<EmailAccepted>> {
    const deliveryId = options.deliveryId;
    if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
      throw new MailValidationError(
        'deliveryId must be a non-empty string',
      );
    }
    const request = buildFrozenMailRequest(input, {
      deliveryId,
      createdAt: this.clock.now(),
      sizes: this.sizes,
      maxTransportBytes: this.maxTransportBytes,
    });
    const wireBody = JSON.stringify({
      delivery_id: request.deliveryId,
      to: request.to,
      subject: request.subject,
      body: request.body,
      attachments: [...request.attachments],
    });
    let completion: CapabilityCompletion<EmailAccepted>;
    try {
      const response = await httpRequest(this.http, {
        method: 'POST',
        path: SEND_PATH,
        body: wireBody,
        idempotencyKey: request.deliveryId,
      });
      completion = mapSendResponse(
        request.deliveryId,
        response.status,
        response.bodyText,
      );
    } catch (err) {
      completion = mapSendError(request.deliveryId, err);
    }
    assertValidCompletion(completion);
    return completion;
  }

  /**
   * Reconcile an uncertain delivery through its ORIGINAL identity: the
   * same delivery id the timed-out send used.
   */
  async reconcile(
    deliveryId: string,
  ): Promise<CapabilityCompletion<EmailAccepted>> {
    if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
      throw new MailValidationError(
        'deliveryId must be a non-empty string',
      );
    }
    let completion: CapabilityCompletion<EmailAccepted>;
    try {
      const response = await httpRequest(this.http, {
        method: 'GET',
        path: `${DELIVERIES_PREFIX}${encodeURIComponent(deliveryId)}`,
      });
      completion = mapReconcileResponse(
        deliveryId,
        response.status,
        response.bodyText,
      );
    } catch (err) {
      completion = mapReconcileError(deliveryId, err);
    }
    assertValidCompletion(completion);
    return completion;
  }
}
