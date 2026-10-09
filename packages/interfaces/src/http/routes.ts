/**
 * S4 top-level HTTP dispatch: operations, auth, CSV, and pages.
 *
 * Lane-06 canonical endpoints: POST `/api/operations/<op>` invokes one
 * canonical operation (agent F), `/auth/*` serves the browser auth routes
 * (agent F), `/api/csv/*` serves the FP.CSV review/commit slice (agent E's
 * `http/csv.js`, wired by FP.CSV-DISPATCH), `/api/exports` serves the
 * FP.EXPORT bounded export and `/print/*` the declared Print views (agent
 * E's `http/export.js` / `http/print.js`, wired by FP.EXPORT-DISPATCH),
 * and every other GET/HEAD path renders a source page (agent E).
 * The F-owned sub-handlers arrive by injection so E and F stay disjoint:
 * this module never imports `./operations.js`, `./auth.js`,
 * `./limits.js`, `./csv.js`, `./export.js`, or `./print.js`, not even as
 * types.
 *
 * Unknown paths and wrong-method requests answer `not_found` ("Not found.",
 * authored mapping for 405/unknown): method existence is not an oracle.
 * The top-level catch maps business throws to their envelope and every
 * other throw to the generic internal envelope after journaling the
 * redacted detail; internals never leak to the caller.
 */
import type { HttpDeps } from '../ports.js';
import { caughtToBusinessError, isBusinessThrow, jsonErrorResponse } from './context.js';
import { buildBusinessError, httpStatusFor } from '../errors/envelope.js';
import { logInternalError } from '../errors/logging.js';
import { handlePagePreferencePost, handlePageRequest } from './pages.js';

/** Canonical sign-in page: the shell links here, auth serves it (agent F). */
export const SIGN_IN_PATH = '/auth/login';
/** Canonical sign-out endpoint: POST with the session CSRF token. */
export const SIGN_OUT_PATH = '/auth/logout';
/** Canonical team-switch endpoint: POST with CSRF + the team field. */
export const SWITCH_TEAM_PATH = '/auth/select-team';
/** Operation invocation prefix: POST only, op name is the decoded rest. */
export const OPERATIONS_PREFIX = '/api/operations/';
/** Upload-transport prefix (S6 bridge v1): intents/content/finalize. */
export const UPLOADS_PREFIX = '/files/';
/** Provider-ingress prefix (S7): POST only, namespace is the rest. */
export const INGRESS_PREFIX = '/ingress/';
/** OAuth endpoints (S7): register/authorize/token + well-known. */
export const OAUTH_PREFIX = '/oauth/';
export const WELL_KNOWN_PREFIX = '/.well-known/';
/** FP.CSV review/commit prefix: POST only, served by the injected csv handler. */
export const CSV_PREFIX = '/api/csv/';
/** FP.EXPORT bounded-export path: exact POST only, served by the injected exports handler. */
export const EXPORTS_PREFIX = '/api/exports';
/** FP.EXPORT Print prefix: GET only, served by the injected print handler. */
export const PRINT_PREFIX = '/print/';

/**
 * F-owned sub-handlers, injected so this module never imports the F-owned
 * `./operations.js` / `./auth.js` / `./limits.js` modules.
 */
export interface HttpSubHandlers {
  /** Invoke one canonical operation; `op` is the decoded path remainder. */
  readonly operations: (req: Request, op: string) => Promise<Response>;
  /** Serve one `/auth/*` route (any method; the handler decides). */
  readonly auth: (req: Request) => Promise<Response>;
  /** Serve one `/files/*` upload route (any method; the handler decides). */
  readonly uploads: (req: Request) => Promise<Response>;
  /** Serve one `/ingress/*` provider route (the handler decides). */
  readonly ingress: (req: Request) => Promise<Response>;
  /** Serve `/oauth/*` + OAuth well-known metadata (the handler decides). */
  readonly oauth: (req: Request) => Promise<Response>;
  /**
   * Serve one `/api/csv/*` review/commit route (the handler decides
   * methods and subpaths). Optional so assemblies that have not taken
   * the FP.CSV delivery join keep compiling: an unmounted CSV prefix
   * answers `not_found`, never a bypass. The delivery join injects
   * `(req) => handleCsvRequest(deps, req)`.
   */
  readonly csv?: (req: Request) => Promise<Response>;
  /**
   * Serve the FP.EXPORT bounded-export path (the handler gates the
   * exact path + POST itself). Optional like `csv`: unmounted answers
   * `not_found`. The delivery join injects
   * `(req) => handleExportRequest(deps, req)`.
   */
  readonly exports?: (req: Request) => Promise<Response>;
  /**
   * Serve one `/print/*` declared view (GET only; the handler decides
   * subpaths). Optional like `csv`: unmounted answers `not_found`.
   * The delivery join injects
   * `(req) => handlePrintRequest(deps, views, req)` with the
   * L7-assembled view registry.
   */
  readonly print?: (req: Request) => Promise<Response>;
}

/** Authored unknown/method response: `not_found`, never a 405 oracle. */
function notFoundResponse(): Response {
  const error = buildBusinessError('not_found', 'Not found.');
  return jsonErrorResponse(error, httpStatusFor(error.code));
}

function requestPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return 'unknown';
  }
}

function decodeOperation(remainder: string): string | null {
  try {
    return decodeURIComponent(remainder);
  } catch {
    return null;
  }
}

/**
 * Build the request handler. Dispatch: POST `/api/operations/<op>` to the
 * injected operations handler (empty/undecodable op is 404), `/auth/*` to
 * the injected auth handler, `/files/*`, `/ingress/*`, `/oauth/*` (+ OAuth
 * well-known) to their injected handlers, `/api/csv/*` to the injected csv
 * handler (`not_found` when unmounted), `/api/exports` to the injected
 * exports handler (`not_found` when unmounted), `/print/*` to the injected
 * print handler (`not_found` when unmounted), else GET/HEAD to the page
 * renderer.
 * Any other method+path answers `not_found`; unexpected throws answer the
 * generic internal envelope after an incident-logged journal entry.
 */
export function createHttpHandler(
  deps: HttpDeps,
  sub: HttpSubHandlers,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    try {
      const pathname = requestPath(request.url);
      const method = request.method.toUpperCase();
      if (pathname.startsWith(OPERATIONS_PREFIX)) {
        if (method !== 'POST') return notFoundResponse();
        const op = decodeOperation(pathname.slice(OPERATIONS_PREFIX.length));
        if (op === null || op.length === 0) return notFoundResponse();
        return await sub.operations(request, op);
      }
      if (pathname.startsWith('/auth/')) {
        return await sub.auth(request);
      }
      if (pathname.startsWith(UPLOADS_PREFIX)) {
        return await sub.uploads(request);
      }
      if (pathname.startsWith(INGRESS_PREFIX)) {
        return await sub.ingress(request);
      }
      if (pathname.startsWith(OAUTH_PREFIX) || pathname.startsWith(WELL_KNOWN_PREFIX)) {
        return await sub.oauth(request);
      }
      if (pathname.startsWith(CSV_PREFIX)) {
        if (sub.csv === undefined) return notFoundResponse();
        return await sub.csv(request);
      }
      if (pathname === EXPORTS_PREFIX || pathname.startsWith(`${EXPORTS_PREFIX}/`)) {
        if (sub.exports === undefined) return notFoundResponse();
        return await sub.exports(request);
      }
      if (pathname.startsWith(PRINT_PREFIX)) {
        if (sub.print === undefined) return notFoundResponse();
        return await sub.print(request);
      }
      if (method === 'POST') return await handlePagePreferencePost(deps, request);
      if (method !== 'GET' && method !== 'HEAD') return notFoundResponse();
      return await handlePageRequest(deps, request);
    } catch (err) {
      const error = caughtToBusinessError(err);
      if (!isBusinessThrow(err)) {
        logInternalError(deps.logger, err, {
          method: request.method,
          path: requestPath(request.url),
        });
      }
      return jsonErrorResponse(error, httpStatusFor(error.code));
    }
  };
}
