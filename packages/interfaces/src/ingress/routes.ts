/**
 * S7 provider-ingress HTTP dispatch: `POST /ingress/{namespace}`.
 *
 * Route (lane-06 authored; DESIGN section 8 pins the verified-causation
 * envelope and the actor-null handler, not the HTTP mechanics): POST only,
 * namespace is a single non-empty URL-decoded path segment. Unknown paths,
 * empty namespaces, extra segments, undecodable segments, and method
 * mismatches all answer `not_found` — method existence is not an oracle
 * (S4 rule, mirroring the S6 upload routes). Unknown namespaces are
 * `not_found` too: namespaces are routing, not secret.
 *
 * Order: path/method match -> binding lookup -> capped body read ->
 * JSON-object parse -> verifier -> namespace/envelope consistency check ->
 * map -> sink.
 *
 * Bodies: raw bytes stream-read capped at {@link INGRESS_BODY_MAX_BYTES}
 * (over-cap is `limit`, never an unbounded `arrayBuffer()`). The verifier
 * receives the RAW bytes plus the request headers, but the route parses
 * JSON first and fails fast on malformed input WITHOUT calling the
 * verifier: verification is the expensive step (HMAC/signature checks),
 * and there is no typed event to hand the sink when parsing fails.
 * The parsed body must be a JSON object (arrays and scalars are
 * `validation`); the sink consumes typed events, not bare values.
 *
 * Headers are copied from the request as-is into a plain Record (the
 * `Headers` iterator already lowercases names; combining duplicates with
 * `, ` follows the Fetch spec) and handed to the verifier untouched — the
 * adapter decides case and signature rules.
 *
 * Verification failure (`null`) answers 401 with the safe `forbidden`
 * envelope (MCP-server-style credential status, mirroring the S6 upload
 * credential denial, minus the OAuth `www-authenticate` challenge, which
 * belongs to the OAuth flow, not HMAC-signed provider webhooks). The
 * verifier is trusted to bind correctly, but a namespace/envelope mismatch
 * (`envelope.namespace !== binding.namespace`) is a binding bug: fail
 * closed with the IDENTICAL 401 envelope (no oracle detail) after
 * journaling the mismatch as an internal incident for operators.
 *
 * Sink outcomes are business receipts, not errors (lane-06 authored):
 * `{accepted:false}` declines answer `200 {accepted:false}` with the
 * envelope's `producer_event_id`, exactly like accepts. Both answer
 * `{accepted, producer_event_id}` verbatim from the verified envelope.
 *
 * Unexpected throws (verifier bugs, sink bugs — `null`/`{accepted:false}`
 * are the failure channels, never throws) are journaled as internal
 * incidents and answer the generic `rule_failed` envelope with status 500
 * (lane-06 authored: 5xx is the provider-retry signal for webhooks; the
 * canonical table's 422 would read as a permanent rejection).
 *
 * Logging: verification failures and sink declines log at `info` with
 * route/tool/namespace only — never body or header material (signature
 * secrets). Accepts are not logged (delivery volume). Unexpected throws
 * log at `error` with an incident id.
 */
import type { BusinessError, VerifiedIngressEnvelope } from '@canlang/contracts';
import { IdentityError } from '@canlang/identity';
import type { IngressDeps } from '../ports.js';
import {
  buildBusinessError,
  fromUnknown,
  toHttpResponse,
} from '../errors/envelope.js';
import { logBusinessError, logInternalError } from '../errors/logging.js';
import {
  caughtToBusinessError,
  jsonErrorResponse,
} from '../http/context.js';
import { readCappedBody } from '../http/limits.js';
import { mapVerifiedIngress } from './mapping.js';

/** Path prefix for provider-ingress delivery (mirrors `INGRESS_PREFIX`). */
const INGRESS_PREFIX = '/ingress/';

/** 256 KiB cap for ingress request bodies (lane-06 authored). */
export const INGRESS_BODY_MAX_BYTES = 262_144;

function requestPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return 'unknown';
  }
}

/**
 * Match the ingress route: POST with a single non-empty URL-decoded
 * namespace segment. Anything else returns null (`not_found`).
 */
function matchIngressRoute(pathname: string, method: string): string | null {
  if (method !== 'POST') return null;
  if (!pathname.startsWith(INGRESS_PREFIX)) return null;
  const rest = pathname.slice(INGRESS_PREFIX.length);
  if (rest === '' || rest.includes('/')) return null;
  let namespace: string;
  try {
    namespace = decodeURIComponent(rest);
  } catch {
    return null;
  }
  return namespace === '' ? null : namespace;
}

function deny(deps: IngressDeps, error: BusinessError, tool: string): Response {
  logBusinessError(deps.logger, error, { route: 'ingress', tool });
  const { status, body } = toHttpResponse(error);
  return jsonErrorResponse(body, status);
}

function notFound(deps: IngressDeps, tool: string): Response {
  return deny(deps, buildBusinessError('not_found', 'Not found.'), tool);
}

/**
 * Credential denial: 401 status with the safe `forbidden` envelope. No
 * `www-authenticate` challenge: provider webhooks authenticate via
 * adapter-owned signature headers, not an interactive scheme.
 */
function denyCredential(deps: IngressDeps, tool: string, namespace: string): Response {
  const error = buildBusinessError('forbidden', 'Invalid ingress signature.');
  logBusinessError(deps.logger, error, { route: 'ingress', tool, namespace });
  return jsonErrorResponse(error, 401);
}

function jsonOk(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * Dispatch one provider-ingress request. See the module doc for routing,
 * verification order, receipt, and logging rules.
 */
export async function handleIngressRequest(
  deps: IngressDeps,
  request: Request,
): Promise<Response> {
  const pathname = requestPath(request.url);
  const namespace = matchIngressRoute(pathname, request.method.toUpperCase());
  if (namespace === null) {
    return notFound(deps, pathname);
  }
  const binding = deps.bindings.bindingFor(namespace);
  if (binding === null) {
    return notFound(deps, pathname);
  }
  let body: Uint8Array;
  let event: unknown;
  try {
    body = await readCappedBody(request, INGRESS_BODY_MAX_BYTES);
  } catch (err) {
    if (err instanceof IdentityError) {
      return deny(deps, caughtToBusinessError(err), pathname);
    }
    const incidentId = logInternalError(deps.logger, err, { route: 'ingress', tool: pathname });
    void incidentId;
    return jsonErrorResponse(fromUnknown(err), 500);
  }
  // Fail fast on malformed JSON BEFORE the verifier (see module doc): no
  // typed event exists to sink, and verification is the expensive step.
  try {
    const text = new TextDecoder().decode(body);
    event = JSON.parse(text) as unknown;
  } catch {
    return deny(deps, buildBusinessError('validation', 'Invalid JSON body.'), pathname);
  }
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    return deny(deps, buildBusinessError('validation', 'Invalid ingress event.'), pathname);
  }
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  let envelope: VerifiedIngressEnvelope | null;
  try {
    envelope = await deps.verifier.verify(binding, { headers, body });
  } catch (err) {
    const incidentId = logInternalError(deps.logger, err, { route: 'ingress', tool: pathname });
    void incidentId;
    return jsonErrorResponse(fromUnknown(err), 500);
  }
  if (envelope === null) {
    return denyCredential(deps, pathname, namespace);
  }
  if (envelope.namespace !== binding.namespace) {
    // Binding bug: the verifier authenticated for the wrong namespace.
    // Fail closed with the identical 401 envelope; operators get the
    // incident journal (no oracle detail for the caller).
    logInternalError(
      deps.logger,
      new Error('Ingress envelope namespace mismatch.'),
      { route: 'ingress', tool: pathname, namespace },
    );
    return denyCredential(deps, pathname, namespace);
  }
  const context = mapVerifiedIngress(binding, envelope);
  try {
    const outcome = await deps.sink.accept(context, event);
    if (!outcome.accepted) {
      deps.logger.log('info', 'ingress declined', {
        route: 'ingress',
        tool: pathname,
        namespace,
      });
    }
    return jsonOk({ accepted: outcome.accepted, producer_event_id: envelope.producerEventId });
  } catch (err) {
    const incidentId = logInternalError(deps.logger, err, { route: 'ingress', tool: pathname });
    void incidentId;
    return jsonErrorResponse(fromUnknown(err), 500);
  }
}
