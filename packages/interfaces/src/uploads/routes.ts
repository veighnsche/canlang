/**
 * S6 upload-transport HTTP dispatch: bridge v1 intents/content/finalize.
 *
 * Routes (DESIGN section 8): `POST /files/intents` mints an intent grant,
 * `PUT /files/content/{id}` streams transfer bytes with a stateless
 * append-then-complete per chunk batch, `POST /files/finalize/{id}`
 * finalizes a completed transfer. Anything else under `/files/*`, and any
 * method mismatch, answers `not_found` — method existence is not an oracle
 * (S4 rule).
 *
 * Order: path/method match -> `usesFiles` gate (app-public config, gated
 * before auth because it is cheap and not secret) -> credential resolution
 * -> CSRF (session path only) -> capped body read -> kernel.
 *
 * Authentication: a well-formed `Authorization: Bearer` grant wins when
 * present (resolved via `resolveIdentity` with the `mcp-grant` audience
 * asserted, no CSRF — mirroring the S5 MCP server); otherwise the session
 * cookie path (`resolveRequestIdentity` + header CSRF). Missing or invalid
 * credentials answer 401 with the `forbidden` code (MCP-server-style
 * credential status, not the contract-table 403); a valid session with a
 * bad CSRF token answers 403 via the normal deny path. A malformed
 * `Authorization` header (not a Bearer) is treated as absent and falls
 * through to the session path; a well-formed but invalid Bearer never
 * falls through.
 *
 * Audience rule (F1, S6 decision; see identity audience.ts): /files/*
 * explicitly accepts both same-origin credentials (browser-session and
 * mcp-grant), because DESIGN section 8 gives browser and supporting host
 * the same upload flow.
 * Bodies: intent/finalize JSON via the S4 capped reader (`parseJsonBody`,
 * 1 MiB default cap); non-object JSON is `validation`. PUT bytes
 * early-reject when `content-length` exceeds the kernel ceiling (kernel
 * untouched), else stream-read capped at `maxBytes + 1` — never an
 * unbounded `arrayBuffer()`.
 *
 * Content completion is stateless: every successful append is followed
 * immediately by `complete` (kernel-cheap). `completed` answers
 * `{received_bytes, complete: true, check}`; `partial` answers
 * `{received_bytes, complete: false}` — a stay-open resume signal, not an
 * error. Kernel outcome reasons map without leaking kernel internals:
 * foreign/expired hide existence (`not_found`), closed/partial-finalize
 * are state errors (`rule_failed`), oversized is quota (`limit`),
 * malformed/rejected content is `validation`, conflicts stay `conflict`.
 */
import type {
  BusinessError,
  ResolvedIdentity,
  UploadIntentRequest,
} from '@canlang/contracts';
import { parseObjectBody, bearerToken } from '../internal/input-admission.js';
import { IdentityError, assertAudience, resolveIdentity } from '@canlang/identity';
import type { UploadDeps, UploadReceiver } from '../ports.js';
import {
  buildBusinessError,
  fromUnknown,
  toHttpResponse,
} from '../errors/envelope.js';
import { logBusinessError, logInternalError } from '../errors/logging.js';
import {
  CSRF_HEADER,
  assertPostCsrf,
  caughtToBusinessError,
  jsonErrorResponse,
  resolveRequestIdentity,
} from '../http/context.js';
import { readCappedBody } from '../http/limits.js';
import { bindingForIntent, receiverFromIdentity } from './principals.js';
import { wwwAuthenticateChallenge } from '../oauth/metadata.js';

const INTENTS_PATH = '/files/intents';
const CONTENT_PREFIX = '/files/content/';
const FINALIZE_PREFIX = '/files/finalize/';

type UploadRoute =
  | { readonly kind: 'intents' }
  | { readonly kind: 'content'; readonly intentId: string }
  | { readonly kind: 'finalize'; readonly intentId: string };

function requestPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return 'unknown';
  }
}

/**
 * Match an upload route. The path id is a single non-empty segment:
 * undecodable or empty ids, extra segments, unknown paths, and method
 * mismatches all return null (`not_found`, never a 405 oracle).
 */
function matchUploadRoute(pathname: string, method: string): UploadRoute | null {
  if (pathname === INTENTS_PATH) {
    return method === 'POST' ? { kind: 'intents' } : null;
  }
  let rest: string | null = null;
  let kind: 'content' | 'finalize' | null = null;
  if (pathname.startsWith(CONTENT_PREFIX)) {
    rest = pathname.slice(CONTENT_PREFIX.length);
    kind = 'content';
  } else if (pathname.startsWith(FINALIZE_PREFIX)) {
    rest = pathname.slice(FINALIZE_PREFIX.length);
    kind = 'finalize';
  }
  if (rest === null || kind === null) return null;
  if (rest === '' || rest.includes('/')) return null;
  let intentId: string;
  try {
    intentId = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (intentId === '') return null;
  if (kind === 'content' && method !== 'PUT') return null;
  if (kind === 'finalize' && method !== 'POST') return null;
  return { kind, intentId };
}


type Caller =
  | { readonly via: 'grant'; readonly identity: ResolvedIdentity }
  | { readonly via: 'session'; readonly identity: ResolvedIdentity; readonly sessionToken: string };

/**
 * Resolve the caller: well-formed Bearer [REDACTED] the grant path (audience
 * asserted, no CSRF), else the session cookie path. Throws
 * `IdentityError('forbidden')` when no credential is presented; invalid or
 * revoked credentials throw from `resolveIdentity`/`assertAudience` with
 * their own safe messages.
 */
async function resolveCaller(deps: UploadDeps, request: Request): Promise<Caller> {
  const token = bearerToken(request);
  if (token !== null) {
    const identity = await resolveIdentity(
      deps.identity.store,
      { mcp_grant_token: token },
      { clock: deps.clock },
    );
    assertAudience(identity.binding, 'mcp-grant');
    return { via: 'grant', identity };
  }
  const { identity, sessionToken } = await resolveRequestIdentity(
    deps.identity.store,
    request,
    { clock: deps.clock },
  );
  if (sessionToken === null) {
    throw new IdentityError('forbidden', 'Authentication required.');
  }
  return { via: 'session', identity, sessionToken };
}

function deny(deps: UploadDeps, error: BusinessError, tool: string): Response {
  logBusinessError(deps.logger, error, { route: 'uploads', tool });
  const { status, body } = toHttpResponse(error);
  return jsonErrorResponse(body, status);
}

/** Credential denial: 401 status with the safe `forbidden` envelope. */
function denyCredential(deps: UploadDeps, error: BusinessError, tool: string, requestUrl: string): Response {
  logBusinessError(deps.logger, error, { route: 'uploads', tool });
  return jsonErrorResponse(error, 401, { 'www-authenticate': wwwAuthenticateChallenge(requestUrl) });
}

function jsonOk(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}


function notFound(deps: UploadDeps, tool: string): Response {
  return deny(deps, buildBusinessError('not_found', 'Not found.'), tool);
}

async function handleIntent(
  deps: UploadDeps,
  request: Request,
  receiver: UploadReceiver,
  tool: string,
): Promise<Response> {
  const body = await parseObjectBody(request);
  // The route needs string `upload_id`/`field` members to construct the
  // delivery binding; everything else is kernel-owned structural
  // validation (same `validation` code either way).
  const uploadId = body['upload_id'];
  const field = body['field'];
  if (
    typeof uploadId !== 'string' || uploadId === '' ||
    typeof field !== 'string' || field === ''
  ) {
    return deny(deps, buildBusinessError('validation', 'Invalid upload intent.'), tool);
  }
  const outcome = await deps.kernel.createIntent({
    request: body as unknown as UploadIntentRequest,
    receiver,
    binding: bindingForIntent({ upload_id: uploadId, field } as UploadIntentRequest),
  });
  switch (outcome.status) {
    case 'granted':
    case 'duplicate':
      return jsonOk(outcome.grant);
    case 'rejected': {
      switch (outcome.reason) {
        case 'invalid-request':
          return deny(deps, buildBusinessError('validation', 'Invalid upload intent.'), tool);
        case 'conflict':
          return deny(deps, buildBusinessError('conflict', 'Conflicting upload identity.'), tool);
        case 'oversized':
          return deny(deps, buildBusinessError('limit', 'Upload exceeds the size limit.'), tool);
        case 'unauthorized':
          // Defensive: the route pre-authenticates every caller, so the
          // kernel should never see an unauthenticated one.
          return deny(deps, buildBusinessError('forbidden', 'Authentication required.'), tool);
        default:
          return deny(deps, buildBusinessError('rule_failed', 'Upload failed.'), tool);
      }
    }
    default:
      return deny(deps, buildBusinessError('rule_failed', 'Upload failed.'), tool);
  }
}

async function handleContent(
  deps: UploadDeps,
  request: Request,
  receiver: ReturnType<typeof receiverFromIdentity>,
  tool: string,
  intentId: string,
): Promise<Response> {
  const maxBytes = await deps.kernel.maxBytes();
  // Early reject on a definite over-cap declaration; unparseable values
  // are ignored and the streaming cap below enforces instead.
  const contentLengthRaw = request.headers.get('content-length');
  if (contentLengthRaw !== null && contentLengthRaw.trim() !== '') {
    const declared = Number(contentLengthRaw.trim());
    if (Number.isSafeInteger(declared) && declared > maxBytes) {
      return deny(deps, buildBusinessError('limit', 'Upload exceeds the size limit.'), tool);
    }
  }
  const chunk = await readCappedBody(request, maxBytes + 1);
  const appended = await deps.kernel.append(intentId, receiver, chunk);
  if (appended.status === 'failed') {
    switch (appended.reason) {
      case 'foreign':
      case 'expired':
        return notFound(deps, tool);
      case 'closed':
        return deny(deps, buildBusinessError('rule_failed', 'Upload is closed.'), tool);
      default:
        return deny(deps, buildBusinessError('rule_failed', 'Upload failed.'), tool);
      case 'oversized':
        return deny(deps, buildBusinessError('limit', 'Upload exceeds the size limit.'), tool);
    }
  }
  // Stateless completion: complete after every successful append.
  const completed = await deps.kernel.complete(intentId, receiver);
  if (completed.status === 'completed') {
    return jsonOk({
      received_bytes: appended.receivedBytes,
      complete: true,
      check: completed.check,
    });
  }
  switch (completed.reason) {
    case 'partial':
      return jsonOk({ received_bytes: appended.receivedBytes, complete: false });
    case 'foreign':
    case 'expired':
      return notFound(deps, tool);
    case 'closed':
      return deny(deps, buildBusinessError('rule_failed', 'Upload is closed.'), tool);
    case 'oversized':
      return deny(deps, buildBusinessError('limit', 'Upload exceeds the size limit.'), tool);
    case 'malformed':
    case 'rejected':
      return deny(deps, buildBusinessError('validation', 'Upload content rejected.'), tool);
    default:
      return deny(deps, buildBusinessError('rule_failed', 'Upload failed.'), tool);
  }
}

async function handleFinalize(
  deps: UploadDeps,
  request: Request,
  receiver: ReturnType<typeof receiverFromIdentity>,
  tool: string,
  intentId: string,
): Promise<Response> {
  const body = await parseObjectBody(request);
  const uploadId = body['upload_id'];
  const bytesDigest = body['bytes_digest'];
  if (
    typeof uploadId !== 'string' || uploadId === '' ||
    typeof bytesDigest !== 'string' || bytesDigest === ''
  ) {
    return deny(deps, buildBusinessError('validation', 'Invalid finalize request.'), tool);
  }
  const outcome = await deps.kernel.finalize({
    intentId,
    retryId: uploadId,
    bytesDigest,
    caller: receiver,
  });
  switch (outcome.status) {
    case 'finalized':
    case 'repeated':
      return jsonOk({ file: outcome.result.file });
    case 'failed': {
      switch (outcome.reason) {
        case 'foreign':
        case 'expired':
          return notFound(deps, tool);
        case 'partial':
          return deny(deps, buildBusinessError('rule_failed', 'Upload is incomplete.'), tool);
        case 'conflict':
          return deny(deps, buildBusinessError('conflict', 'Conflicting finalize request.'), tool);
        default:
          return deny(deps, buildBusinessError('rule_failed', 'Upload failed.'), tool);
      }
    }
    default:
      return deny(deps, buildBusinessError('rule_failed', 'Upload failed.'), tool);
  }
}

/**
 * Dispatch one upload-transport request. See the module doc for routing,
 * auth, body, and kernel-mapping rules.
 */
export async function handleUploadRequest(
  deps: UploadDeps,
  request: Request,
): Promise<Response> {
  const pathname = requestPath(request.url);
  const route = matchUploadRoute(pathname, request.method.toUpperCase());
  if (route === null) {
    return notFound(deps, pathname);
  }
  if (!deps.files.usesFiles(deps.app)) {
    return deny(deps, buildBusinessError('not_found', 'Uploads unavailable.'), pathname);
  }
  let caller: Caller;
  try {
    caller = await resolveCaller(deps, request);
  } catch (err) {
    if (err instanceof IdentityError) {
      return denyCredential(deps, caughtToBusinessError(err), pathname, request.url);
    }
    throw err;
  }
  try {
    if (caller.via === 'session') {
      // Header-only CSRF: JSON intent/finalize bodies are kernel-owned
      // (passed verbatim, never stripped), and PUT carries raw bytes.
      await assertPostCsrf({
        sessionToken: caller.sessionToken,
        headerValue: request.headers.get(CSRF_HEADER),
        fieldValue: undefined,
      });
    }
    const receiver = receiverFromIdentity(deps.app.appId, caller.identity);
    switch (route.kind) {
      case 'intents':
        return await handleIntent(deps, request, receiver, pathname);
      case 'content':
        return await handleContent(deps, request, receiver, pathname, route.intentId);
      case 'finalize':
        return await handleFinalize(deps, request, receiver, pathname, route.intentId);
    }
  } catch (err) {
    if (err instanceof IdentityError) {
      return deny(deps, caughtToBusinessError(err), pathname);
    }
    const incidentId = logInternalError(deps.logger, err, { route: 'uploads', tool: pathname });
    void incidentId;
    const error = fromUnknown(err);
    const { status, body } = toHttpResponse(error);
    return jsonErrorResponse(body, status);
  }
}
