/**
 * FP.INSTRUMENTATION error-report intake: `POST /errors/{key}`.
 *
 * Versioned ErrorsV1 admission boundary per the pinned CanCatch intake
 * contract (design snapshot `draft/CanCatch.md`): the version-1 body
 * carries report identity, occurrence time, message, optional
 * stack/environment/release, and an optional explicit fingerprint.
 * F's browser capture produces this shape; D's services half durably
 * queues admitted reports behind the injected `IntakeSink`.
 *
 * Admission order: path/method match -> key resolution -> per-key
 * rate throttle -> capped body read (256 KiB) -> JSON-object parse ->
 * version + closed-member + bound checks -> sink. Success answers
 * HTTP 202 `{reference}` (durable intent exists, per contract);
 * unknown/rotated/revoked keys answer the uniform safe `forbidden`
 * (403 via the contract table, sibling-consistent with operations
 * auth denial); oversize answers `limit` (429);
 * malformed/unknown-version/unknown-member/out-of-bound reports
 * answer `validation`. Unknown paths and method mismatches answer
 * `not_found` (S4 rule: no 405 oracle).
 *
 * Gate AL-INSTRUMENTATION: intake keys are public write-only
 * identifiers — they admit reports only and never authorize health
 * reads, team administration, or project nomination. A body that
 * names another project, quota, grouping version, viewer, or health
 * authority fails closed as an unknown member. There is no health
 * surface in this module: `IntakeV1.health` is a verified snapshot
 * from the intake/processing authority, never a browser operation.
 */
import type { BusinessError, ErrorAccepted } from '@canlang/contracts';
import { IdentityError } from '@canlang/identity';
import type { HttpDeps } from '../ports.js';
import { buildBusinessError, toHttpResponse } from '../errors/envelope.js';
import { logBusinessError, logInternalError } from '../errors/logging.js';
import { parseJsonBody } from '../http/limits.js';
import { caughtToBusinessError } from '../http/context.js';

/** Intake prefix: exactly one non-empty key segment follows. */
export const INTAKE_PREFIX = '/errors/';

/** 256 KiB encoded-UTF-8 cap, enforced before parsing (CanCatch pinned). */
export const INTAKE_BODY_MAX_BYTES = 262_144;

/** Normalized message bound in characters (CanCatch pinned). */
export const INTAKE_MESSAGE_MAX_CHARS = 4_096;

/** Stack bound in characters (CanCatch pinned). */
export const INTAKE_STACK_MAX_CHARS = 32_000;

/** Transport abuse guard: reports per key per window (product quota is separate, downstream). */
export const INTAKE_RATE_LIMIT = 120;

/** Transport abuse-guard window: one minute. */
export const INTAKE_RATE_WINDOW_MS = 60_000;

/** Occurrence times over five minutes ahead reject (CanCatch pinned). */
export const OCCURRENCE_FUTURE_TOLERANCE_MS = 300_000;

/** Occurrence times over seven days old reject (CanCatch pinned). */
export const OCCURRENCE_MAX_AGE_MS = 7 * 86_400_000;

/** The only report version this boundary admits. */
export const INTAKE_VERSION = 1;

/**
 * Server-configured intake binding: fixes the project an intake key
 * resolves to, plus optional environment/release allowlists applied
 * before grouping. Provisioned by trusted developer maintenance;
 * secrets stay server-side and this type carries none.
 */
export interface IntakeBinding {
  readonly projectId: string;
  readonly environments?: readonly string[];
  readonly releases?: readonly string[];
}

/** Key resolution: unknown, rotated, or revoked keys resolve to null (fail closed, no oracle detail). */
export interface IntakeBindings {
  resolveKey(key: string): IntakeBinding | null;
}

/** Admitted report handed downstream; D's services half durably queues it. */
export interface AdmittedReport {
  readonly projectId: string;
  readonly id: string;
  readonly occurredAt: string;
  readonly message: string;
  readonly stack?: string;
  readonly environment?: string;
  readonly release?: string;
  readonly fingerprint?: string;
}

/** Durable-queue sink (D-owned): 202 means this accepted. */
export interface IntakeSink {
  store(report: AdmittedReport): Promise<ErrorAccepted>;
}

/** Closed v1 member set: anything else (incl. project/quota/health nomination) rejects. */
const ADMITTED_MEMBERS = new Set([
  'version',
  'id',
  'occurred_at',
  'message',
  'stack',
  'environment',
  'release',
  'fingerprint',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Pure v1 admission: validate a parsed body against the pinned
 * boundary. Throws `IdentityError` (`validation`) on any rejection;
 * unknown versions, unknown members, invalid types, out-of-bound
 * values, and disallowed environment/release all fail admission and
 * are never stored as arbitrary context.
 */
export function admitIntakeReport(
  binding: IntakeBinding,
  body: unknown,
  nowMs: number,
): AdmittedReport {
  if (!isRecord(body)) {
    throw new IdentityError('validation', 'Report must be a JSON object.');
  }
  for (const key of Object.keys(body)) {
    if (!ADMITTED_MEMBERS.has(key)) {
      throw new IdentityError('validation', `Unknown report member ${JSON.stringify(key)}.`);
    }
  }
  if (body['version'] !== INTAKE_VERSION) {
    throw new IdentityError('validation', 'Unsupported report version.');
  }
  const id = body['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new IdentityError('validation', 'Report needs a non-empty id.');
  }
  const occurredAt = body['occurred_at'];
  if (typeof occurredAt !== 'string') {
    throw new IdentityError('validation', 'Report needs occurred_at.');
  }
  const occurredMs = Date.parse(occurredAt);
  if (!Number.isFinite(occurredMs)) {
    throw new IdentityError('validation', 'Report occurred_at is not a valid instant.');
  }
  if (occurredMs - nowMs > OCCURRENCE_FUTURE_TOLERANCE_MS) {
    throw new IdentityError('validation', 'Report occurred_at is too far in the future.');
  }
  if (nowMs - occurredMs > OCCURRENCE_MAX_AGE_MS) {
    throw new IdentityError('validation', 'Report occurred_at is too old.');
  }
  const message = body['message'];
  if (typeof message !== 'string' || message.length === 0) {
    throw new IdentityError('validation', 'Report needs a non-empty message.');
  }
  if (message.length > INTAKE_MESSAGE_MAX_CHARS) {
    throw new IdentityError('validation', 'Report message is too long.');
  }
  const report: AdmittedReport = {
    projectId: binding.projectId,
    id,
    occurredAt,
    message,
  };
  const stack = body['stack'];
  if (stack !== undefined) {
    if (typeof stack !== 'string') {
      throw new IdentityError('validation', 'Report stack must be a string.');
    }
    if (stack.length > INTAKE_STACK_MAX_CHARS) {
      throw new IdentityError('validation', 'Report stack is too long.');
    }
    (report as { stack?: string }).stack = stack;
  }
  const environment = body['environment'];
  if (environment !== undefined) {
    if (typeof environment !== 'string' || environment.length === 0) {
      throw new IdentityError('validation', 'Report environment must be a non-empty string.');
    }
    if (binding.environments !== undefined && !binding.environments.includes(environment)) {
      throw new IdentityError('validation', 'Report environment is not allowed for this project.');
    }
    (report as { environment?: string }).environment = environment;
  }
  const release = body['release'];
  if (release !== undefined) {
    if (typeof release !== 'string' || release.length === 0) {
      throw new IdentityError('validation', 'Report release must be a non-empty string.');
    }
    if (binding.releases !== undefined && !binding.releases.includes(release)) {
      throw new IdentityError('validation', 'Report release is not allowed for this project.');
    }
    (report as { release?: string }).release = release;
  }
  const fingerprint = body['fingerprint'];
  if (fingerprint !== undefined) {
    if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
      throw new IdentityError('validation', 'Report fingerprint must be a non-empty string.');
    }
    (report as { fingerprint?: string }).fingerprint = fingerprint;
  }
  return report;
}

/** Authored unknown/method response: `not_found`, never a 405 oracle. */
function notFoundResponse(): Response {
  const { status, body } = toHttpResponse(buildBusinessError('not_found', 'Not found.'));
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function deny(deps: HttpDeps, error: BusinessError, retryAfterMs: number | null): Response {
  logBusinessError(deps.logger, error, { route: 'intake' });
  const { status, body } = toHttpResponse(error);
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(retryAfterMs === null ? {} : { 'retry-after': String(Math.ceil(retryAfterMs / 1000)) }),
    },
  });
}

/**
 * Serve one `POST /errors/{key}` intake request: throttle, resolve,
 * admit, sink. Unexpected throws answer the generic internal envelope
 * after an incident-logged journal entry (never a recursive report).
 */
export async function handleIntakeRequest(
  deps: HttpDeps,
  bindings: IntakeBindings,
  sink: IntakeSink,
  request: Request,
): Promise<Response> {
  try {
    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return notFoundResponse();
    }
    if (request.method.toUpperCase() !== 'POST' || !pathname.startsWith(INTAKE_PREFIX)) {
      return notFoundResponse();
    }
    let key: string;
    try {
      key = decodeURIComponent(pathname.slice(INTAKE_PREFIX.length));
    } catch {
      return notFoundResponse();
    }
    if (key === '' || key.includes('/')) {
      return notFoundResponse();
    }
    // Resolve before throttling: unknown keys answer cheaply without
    // polluting per-key throttle buckets under garbage-key probing.
    const binding = bindings.resolveKey(key);
    if (binding === null) {
      return deny(deps, buildBusinessError('forbidden', 'Authentication required.'), null);
    }
    const throttle = await deps.limiter.check(
      `intake/key:${key}`,
      INTAKE_RATE_LIMIT,
      INTAKE_RATE_WINDOW_MS,
    );
    if (!throttle.allowed) {
      return deny(deps, buildBusinessError('limit', undefined, { retryable: true }), throttle.retryAfterMs);
    }
    const parsed = await parseJsonBody(request, INTAKE_BODY_MAX_BYTES);
    const report = admitIntakeReport(binding, parsed, deps.clock.nowMs());
    const accepted = await sink.store(report);
    return new Response(JSON.stringify({ reference: accepted.reference }), {
      status: 202,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  } catch (error) {
    if (error instanceof IdentityError) {
      return deny(deps, caughtToBusinessError(error), null);
    }
    const incidentId = logInternalError(deps.logger, error, { route: 'intake' });
    void incidentId;
    return deny(deps, buildBusinessError('rule_failed'), null);
  }
}
