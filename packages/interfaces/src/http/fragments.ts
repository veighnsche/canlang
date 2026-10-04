/**
 * S4 fragment helpers: partial-request detection and fragment error shape.
 *
 * A partial request is any request carrying the `HX-Request` header (value
 * ignored; htmx sends `true`). Fragment errors keep the S4 contract shape —
 * the BusinessError JSON body with the canonical status — exactly like page
 * and operation errors; L5 error-fragment markup is join J5.
 */
import type { BusinessError } from '@canlang/contracts';
import { httpStatusFor } from '../errors/envelope.js';
import { jsonErrorResponse } from './context.js';

/** True when the request carries the `HX-Request` header (partial render). */
export function isPartialRequest(request: Request): boolean {
  return request.headers.has('HX-Request');
}

/**
 * Fragment error response: BusinessError JSON with the canonical status.
 * JSON+status is the S4 contract; L5 error-fragment markup is join J5.
 */
export function fragmentErrorResponse(error: BusinessError): Response {
  return jsonErrorResponse(error, httpStatusFor(error.code));
}
