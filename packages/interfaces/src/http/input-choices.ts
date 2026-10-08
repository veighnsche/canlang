/** Partial drafts can assist one declared input without invoking its mutation. */
import { COLLECTION_MAX_LIMIT, SOURCE_FORM_BINDING_FIELD } from '@canlang/contracts';
import type { ClosedInputs } from '@canlang/contracts';
import type { HttpDeps } from '../ports.js';
import { buildBusinessError, toHttpResponse } from '../errors/envelope.js';
import { logBusinessError, logInternalError } from '../errors/logging.js';
import { checkBoundArguments } from '../mcp/schemas.js';
import { validateOperationId } from '../envelope/validate.js';
import { CSRF_HEADER, assertPostCsrf, caughtToBusinessError, isBusinessThrow,
  jsonErrorResponse, resolveRequestIdentity } from './context.js';
import { JSON_BODY_MAX_BYTES, parseJsonBody } from './limits.js';

const OPERATION_NAME = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*){1,2}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Same session, CSRF, protected binding and current read authority as its form. */
export async function handleInputChoiceRequest(deps: HttpDeps, request: Request,
  operation: string, input: string): Promise<Response> {
  try {
    if (request.method !== 'POST' || !OPERATION_NAME.test(operation)) {
      throw buildBusinessError('not_found', 'Unknown input assistance.');
    }
    const { identity, sessionToken } = await resolveRequestIdentity(deps.identity.store, request, { clock: deps.clock });
    if (sessionToken === null) throw buildBusinessError('forbidden', 'Authentication required.');
    await assertPostCsrf({ sessionToken, headerValue: request.headers.get(CSRF_HEADER), fieldValue: undefined });
    if ((request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      throw buildBusinessError('validation', 'Input assistance requires a JSON draft.');
    }
    const body = await parseJsonBody(request);
    if (!record(body) || Object.keys(body).some(name =>
      !['operation_id', 'inputs', SOURCE_FORM_BINDING_FIELD].includes(name)) || !record(body['inputs'])) {
      throw buildBusinessError('validation', 'Invalid input assistance draft.');
    }
    const idError = validateOperationId(body['operation_id'], deps.clock);
    if (idError !== null) throw idError;
    const operationId = body['operation_id'] as string;
    const derived = deps.catalog.derivedFor?.(operation);
    const assisted = derived?.inputs.find(field => field.name === input);
    if (derived === undefined || derived === null || assisted?.choices === undefined ||
      !['create', 'update', 'scenario'].includes(derived.kind) || deps.inputChoices === undefined) {
      throw buildBusinessError('not_found', 'Unknown input assistance.');
    }
    let inputs = body['inputs'] as ClosedInputs;
    if (Object.hasOwn(body, SOURCE_FORM_BINDING_FIELD)) {
      const token = body[SOURCE_FORM_BINDING_FIELD];
      const restored = typeof token === 'string' && deps.formBindings !== undefined
        ? await deps.formBindings.restore({ appId: deps.app.appId, sessionToken, identity, derived,
          operationId, nowMs: deps.clock.nowMs() }, token, inputs) : null;
      if (restored === null) throw buildBusinessError('forbidden', 'This form binding is no longer valid.');
      inputs = restored;
    }
    // Presence of unfinished siblings is optional here; supplied values still
    // use the same closed, typed input boundary as final submission.
    const boundError = checkBoundArguments(derived, inputs);
    if (boundError !== null) throw boundError;
    const result = await deps.inputChoices({ derived, input, inputs, identity });
    if (!record(result) || !['ready', 'absent'].includes(result.state) ||
      !Array.isArray(result.choices) || result.choices.length > COLLECTION_MAX_LIMIT ||
      (result.state === 'absent' && result.choices.length !== 0) || result.choices.some(choice =>
        !record(choice) || !Object.hasOwn(choice, 'value') || !Array.isArray(choice.labels) ||
        choice.labels.some(label => typeof label !== 'string'))) {
      throw new Error('Canonical input assistance returned an incompatible result.');
    }
    const bodyText = JSON.stringify(result);
    if (new TextEncoder().encode(bodyText).byteLength > JSON_BODY_MAX_BYTES) {
      throw buildBusinessError('limit', 'Input assistance exceeds the response limit.');
    }
    return new Response(bodyText, { headers: {
      'content-type': 'application/json', 'cache-control': 'no-store', vary: 'Cookie',
    } });
  } catch (error) {
    const business = caughtToBusinessError(error);
    if (!isBusinessThrow(error)) logInternalError(deps.logger, error, { route: 'input-choices', operation });
    else logBusinessError(deps.logger, business, { route: 'input-choices', operation });
    const response = toHttpResponse(business);
    return jsonErrorResponse(response.body, response.status);
  }
}
