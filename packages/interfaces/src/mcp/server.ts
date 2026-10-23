/**
 * S5 MCP protocol server: grant-authenticated tool calls over stateless
 * Streamable HTTP, admitted through the same canonical invocation as S4.
 *
 * Authentication: ONLY `Authorization: Bearer <mcp-grant-token>`, resolved
 * via `resolveIdentity` with the `mcp-grant` audience asserted. Cookies are
 * never read here — a session cookie without a grant Bearer [REDACTED] 401s,
 * and a session token presented as a Bearer [REDACTED] no grant, so it 401s
 * too. Missing/invalid/expired/revoked grants answer 401 with a safe
 * `{ error: { code, message } }` body; internals never leak.
 *
 * Lifecycle: one fresh SDK `Server` + stateless transport per request, so
 * permission rechecks are naturally per call and no server state is shared
 * across requests.
 *
 * Argument validation mirrors `http/operations.ts` framing order: handle
 * mode (closed against `handleModeAllowed`, mutation kinds only), else
 * `operation_id` for mutation kinds, then `checkClosedInputs` against the
 * catalog shape, then ref/version SHAPE checks from the descriptor's typed
 * fields (staleness stays L3's `conflict`). Framing failures are JSON-RPC
 * `InvalidParams` (-32602); unknown tools are `InvalidParams`; denied calls
 * and business errors are `isError` results with the S3 safe projection;
 * invoker throws are `InternalError` with a generic message after an
 * incident-logged journal entry.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { bearerToken } from '../internal/input-admission.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  InitializeRequestSchema,
  LATEST_PROTOCOL_VERSION,
  ListToolsRequestSchema,
  McpError,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  BusinessError,
  ClosedInputs,
  FileTransferMeta,
  MutationEnvelope,
  ReadEnvelope,
  ResolvedIdentity,
} from '@canlang/contracts';
import { FILE_TRANSFER_META_KEY } from '@canlang/contracts';
import { assertAudience, IdentityError, assertCredentialLive, resolveIdentity, sha256HexText } from '@canlang/identity';
import type {
  McpDeps,
  InvocationContext,
  McpOperationKind,
  MutationOutcome,
  OperationDescriptor,
  ReadOutcome,
} from '../ports.js';
import { buildBusinessError, toMcpError } from '../errors/envelope.js';
import { logBusinessError, logInternalError } from '../errors/logging.js';
import { checkClosedInputs, validateOperationId } from '../envelope/validate.js';
import { checkMcpRefShape } from './prepared.js';
import { listToolsFor } from './discovery.js';
import { checkBoundArguments, handleModeAllowed } from './schemas.js';
import { wwwAuthenticateChallenge } from '../oauth/metadata.js';

/** MCP server version advertised in `serverInfo`. */
export const MCP_SERVER_VERSION = '0.1.0';

const SERVER_NAME = 'can-mcp';
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** Mutation kinds admit through `invokeMutation`; `read`/`list` through `invokeRead`. */
function isMutationKind(kind: McpOperationKind): boolean {
  switch (kind) {
    case 'create':
    case 'update':
    case 'delete':
    case 'scenario':
    case 'team':
      return true;
    case 'read':
    case 'list':
      return false;
  }
}

function errorResponse(status: number, error: BusinessError, wwwAuthenticate?: string): Response {
  return new Response(JSON.stringify({ error: { code: error.code, message: error.message } }), {
    status,
    headers: {
      'content-type': JSON_CONTENT_TYPE,
      ...(wwwAuthenticate === undefined ? {} : { 'www-authenticate': wwwAuthenticate }),
    },
  });
}


/**
 * Resolve the grant caller. Returns the identity, or the 401/500 response
 * to answer with: credential failures (including audience mismatch) are
 * 401 with safe messages; unexpected store failures are 500 generic after
 * an incident-logged journal entry.
 */
async function resolveGrantIdentity(
  deps: McpDeps,
  request: Request,
): Promise<{ identity: ResolvedIdentity; grantTokenHash: string; invocation: InvocationContext } | Response> {
  const token = bearerToken(request);
  if (token === null) {
    return errorResponse(401, buildBusinessError('forbidden', 'Authentication required.'), wwwAuthenticateChallenge(request.url));
  }
  try {
    const identity = await resolveIdentity(
      deps.identity.store,
      { mcp_grant_token: token },
      { clock: deps.clock },
    );
    assertAudience(identity.binding, 'mcp-grant');
    // B4: capture the credential hash at transport admission; the mutation
    // admission re-read checks current facts immediately before invoker entry.
    const teamId = identity.team?.team_id ?? null;
    const actorUserId = identity.actor?.user_id ?? null;
    const invocation: InvocationContext = Object.freeze({ resolveCaller: async () => {
      const current = await resolveIdentity(deps.identity.store, { mcp_grant_token: token,
        ...(teamId === null ? {} : { team_id: teamId }) }, { clock: deps.clock });
      assertAudience(current.binding, 'mcp-grant');
      if ((current.actor?.user_id ?? null) !== actorUserId || (current.team?.team_id ?? null) !== teamId) {
        throw new IdentityError('forbidden', 'The originating caller scope is no longer available.');
      }
      return current;
    } });
    return { identity, grantTokenHash: await sha256HexText(token), invocation };
  } catch (err) {
    if (err instanceof IdentityError) {
      return errorResponse(401, buildBusinessError(err.code, err.message), wwwAuthenticateChallenge(request.url));
    }
    logInternalError(deps.logger, err, { route: 'mcp' });
    return errorResponse(500, buildBusinessError('rule_failed'));
  }
}

type McpTextBlock = {
  readonly type: 'text';
  readonly text: string;
};

/**
 * `tools/call` result in the SDK's `CallToolResult` shape (mutable
 * members). A `type` alias (not `interface`) so it carries the implicit
 * index signature the SDK's loose-object result types require.
 */
type ToolCallResult = {
  content: McpTextBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Error projection: the S3 `toMcpError` text + envelope, reshaped to the
 * SDK result type (the S3 projection uses readonly members). Denials and
 * business errors are journaled at info level like S4 `deny()`, so probing
 * stays visible; only safe envelope members travel to the log fields.
 */
function errorResult(deps: McpDeps, operation: string, error: BusinessError): ToolCallResult {
  logBusinessError(deps.logger, error, { route: 'mcp', tool: operation });
  const projected = toMcpError(error);
  return {
    content: projected.content.map((block) => ({ type: 'text' as const, text: block.text })),
    structuredContent: { ...projected.structuredContent },
    isError: true,
  };
}

/**
 * Success projection: the result as one JSON text block plus, when the
 * result is a plain object, as `structuredContent`. The server sends
 * results unvalidated (clients validate against `CallToolResultSchema`,
 * whose `structuredContent` is a string-record-or-absent), so non-object
 * results (possible for reads: `ReadResult` is `unknown`) omit the member
 * to stay client-valid; the JSON text always carries them.
 */
function successResult(result: unknown): ToolCallResult {
  const content: McpTextBlock[] = [{ type: 'text', text: JSON.stringify(result) }];
  if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
    return { content, structuredContent: result as Record<string, unknown> };
  }
  return { content };
}

async function invokeMutationOutcome(
  deps: McpDeps,
  identity: ResolvedIdentity,
  envelope: MutationEnvelope,
  grantTokenHash: string,
  invocation: InvocationContext,
  retainedOnly = false,
): Promise<ToolCallResult> {
  /* B4 pre-invoker admission: re-read CURRENT grant facts after arguments
   * and permission checks. Revocation or expiry before this read refuses
   * entry with admission-identical forbidden. Already admitted invoker work
   * has no retroactive cancellation guarantee. Unexpected faults stay 500. */
  try {
    await assertCredentialLive(deps.identity.store, {
      kind: 'mcp_grant',
      tokenHash: grantTokenHash,
      now: new Date(deps.clock.nowMs()).toISOString(),
    });
  } catch (err) {
    if (err instanceof IdentityError) {
      return errorResult(deps, envelope.operation, buildBusinessError('forbidden', err.message));
    }
    logInternalError(deps.logger, err, { route: 'mcp', tool: envelope.operation });
    throw new McpError(ErrorCode.InternalError, 'Internal error.');
  }
  let outcome: MutationOutcome;
  try {
    outcome = retainedOnly
      ? await deps.invoker.invokeRetainedMutation!(envelope, identity, invocation)
      : await deps.invoker.invokeMutation(envelope, identity, invocation);
  } catch (err) {
    logInternalError(deps.logger, err, { route: 'mcp', tool: envelope.operation });
    throw new McpError(ErrorCode.InternalError, 'Internal error.');
  }
  if ('error' in outcome) return errorResult(deps, envelope.operation, outcome.error);
  return successResult(outcome.result);
}

async function invokeReadOutcome(
  deps: McpDeps,
  identity: ResolvedIdentity,
  envelope: ReadEnvelope,
): Promise<ToolCallResult> {
  let outcome: ReadOutcome;
  try {
    outcome = await deps.invoker.invokeRead(envelope, identity);
  } catch (err) {
    logInternalError(deps.logger, err, { route: 'mcp', tool: envelope.operation });
    throw new McpError(ErrorCode.InternalError, 'Internal error.');
  }
  if ('error' in outcome) return errorResult(deps, envelope.operation, outcome.error);
  return successResult(outcome.result);
}

/**
 * Handle-mode framing (wire `ActionHandleInvocation`): sealed handle +
 * `operation_id` + all non-record canonical inputs as siblings. Closed
 * against `handleModeAllowed(descriptor)`; ref-kind members are rejected
 * (the record is sealed — overrides fail); mutation kinds only. The sealed
 * handle contents are opaque here — verification is L3/L4's.
 */
async function invokeHandleMode(
  deps: McpDeps,
  identity: ResolvedIdentity,
  grantTokenHash: string,
  invocation: InvocationContext,
  descriptor: OperationDescriptor,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!isMutationKind(descriptor.kind)) {
    throw new McpError(ErrorCode.InvalidParams, 'action_handle is only accepted for mutation tools.');
  }
  const allowed = handleModeAllowed(descriptor);
  const refNames = new Set(
    descriptor.inputs.fields.filter((named) => named.field.kind === 'ref').map((named) => named.name),
  );
  for (const key of Object.keys(args)) {
    if (refNames.has(key)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Record input '${key}' is sealed by the action handle.`,
      );
    }
    if (!allowed.includes(key)) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown input '${key}'.`);
    }
  }
  const handle: unknown = args['action_handle'];
  if (typeof handle !== 'object' || handle === null || Array.isArray(handle)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid action_handle.');
  }
  const operationId: unknown = args['operation_id'];
  if (typeof operationId !== 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'Missing operation_id.');
  }
  const idError = validateOperationId(operationId, deps.clock);
  if (idError !== null) {
    throw new McpError(ErrorCode.InvalidParams, idError.message);
  }
  const inputs: ClosedInputs = { action_handle: handle };
  for (const named of descriptor.inputs.fields) {
    if (named.field.kind === 'ref') continue;
    if (Object.prototype.hasOwnProperty.call(args, named.name)) {
      inputs[named.name] = args[named.name];
    }
  }
  // E1 bound-input wiring for handle mode: the sealed handle is not a
  // derived member, so the checker binds the carried non-ref values only.
  const derived = deps.catalog.derivedFor?.(descriptor.name) ?? null;
  if (derived !== null) {
    const boundError = checkBoundArguments(derived, inputs);
    if (boundError !== null) {
      throw new McpError(ErrorCode.InvalidParams, boundError.message);
    }
  }
  const envelope: MutationEnvelope = {
    operation: descriptor.name,
    operation_id: operationId,
    inputs,
  };
  return invokeMutationOutcome(deps, identity, envelope, grantTokenHash, invocation);
}

/**
 * Ordinary-mode framing, mirroring `http/operations.ts` order:
 * `operation_id` for mutation kinds, catalog closed-inputs check, then
 * ref/version SHAPE checks from the descriptor's typed fields.
 */
async function invokeOrdinaryMode(
  deps: McpDeps,
  identity: ResolvedIdentity,
  grantTokenHash: string,
  invocation: InvocationContext,
  descriptor: OperationDescriptor,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const mutation = isMutationKind(descriptor.kind);
  let operationId = '';
  let retainedTeamOutcome = false;
  if (mutation) {
    const raw: unknown = args['operation_id'];
    if (typeof raw !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Missing operation_id.');
    }
    const idError = validateOperationId(raw, deps.clock);
    if (idError !== null) {
      // Team receipts outlive the age gate for unseen commands. The retained
      // entry point must refuse absence/skew; it can never execute a new command.
      retainedTeamOutcome = descriptor.kind === 'team' && idError.message === 'Expired operation_id.' &&
        typeof deps.invoker.invokeRetainedMutation === 'function';
      if (!retainedTeamOutcome) throw new McpError(ErrorCode.InvalidParams, idError.message);
    }
    operationId = raw;
  }
  const businessInputs: ClosedInputs = { ...args };
  if (mutation) {
    // `operation_id` is framing, not a business input: validated above,
    // then stripped before the closed-inputs check (mirrors the S4
    // `_csrf` strip). Reads carry no `operation_id`; a present one
    // fails closed.
    delete businessInputs['operation_id'];
  }
  // Closed-inputs are enforced against the catalog shape while the schema
  // and ref checks derive from the descriptor: the L1 production binding
  // must keep both views of an operation consistent (B1 join).
  const shape = deps.catalog.shapeFor(descriptor.name);
  if (shape === null) {
    // Registry/catalog skew: the tool was discoverable, so existence is
    // not secret — answer the S4 `not_found` meaning as an `isError`.
    return errorResult(deps, descriptor.name, buildBusinessError('not_found', 'Unknown operation.'));
  }
  const closedError = checkClosedInputs(businessInputs, shape);
  if (closedError !== null) {
    throw new McpError(ErrorCode.InvalidParams, closedError.message);
  }
  // E2b null parity with HTTP: the derived channel owns nullability, so an
  // explicit null on a derived-declared ref input skips shape framing here
  // and binds below (nullable admits, else InvalidParams) — exactly the
  // HTTP verdict, which has no ref-shape framing step. Shape-only catalogs
  // (no derived channel) and skewed undeclared members keep strict framing.
  const derived = deps.catalog.derivedFor?.(descriptor.name) ?? null;
  const nullDefersToBinding = (name: string, value: unknown): boolean =>
    value === null && (derived?.inputs.some((input) => input.name === name) ?? false);
  for (const named of descriptor.inputs.fields) {
    if (named.field.kind !== 'ref') continue;
    if (!Object.prototype.hasOwnProperty.call(businessInputs, named.name)) continue;
    const value: unknown = businessInputs[named.name];
    if (nullDefersToBinding(named.name, value)) continue;
    // Keyed on the descriptor's requireVersion (matching the generated
    // schema), not the tool kind: a mutation input modeled without a
    // version accepts ReadRef shape, exactly as its schema advertises.
    const error = checkMcpRefShape(value, named.name, named.field.requireVersion, named.array !== undefined);
    if (error !== null) throw new McpError(ErrorCode.InvalidParams, error.message);
  }
  // E1 bound-input wiring: framing first (above), then each present value
  // binds to its derived declaration. Catalogs without the derived
  // channel keep framing-only behavior (`derived` was fetched above for
  // the E2b null rule and is reused here).
  if (derived !== null) {
    const boundError = checkBoundArguments(derived, businessInputs);
    if (boundError !== null) {
      throw new McpError(ErrorCode.InvalidParams, boundError.message);
    }
  }
  if (mutation) {
    const envelope: MutationEnvelope = {
      operation: descriptor.name,
      operation_id: operationId,
      inputs: businessInputs,
    };
    return invokeMutationOutcome(deps, identity, envelope, grantTokenHash, invocation, retainedTeamOutcome);
  }
  const envelope: ReadEnvelope = { operation: descriptor.name, inputs: businessInputs };
  return invokeReadOutcome(deps, identity, envelope);
}

async function handleToolCall(
  deps: McpDeps,
  identity: ResolvedIdentity,
  grantTokenHash: string,
  invocation: InvocationContext,
  name: string,
  args: unknown,
): Promise<ToolCallResult> {
  const descriptor = deps.registry.list(deps.app).find((d) => d.name === name) ?? null;
  if (descriptor === null) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown tool '${name}'.`);
  }
  // Forbidden stays an `isError` with the uniform safe message. This
  // makes no existence-oracle claim: unknown names answer `-32602` while
  // known-but-denied tools answer `isError`-forbidden, which is the DESIGN
  // taxonomy (operation names are not secret).
  if (!(await deps.permissions.canCall(identity, descriptor.name))) {
    return errorResult(deps, descriptor.name, buildBusinessError('forbidden'));
  }
  // Owner-only team management, enforced on the call path exactly as in
  // discovery. Guarantee: every denial answers the uniform safe `forbidden`
  // regardless of reason (permission port, ownership, or business rule);
  // operation-name existence is not secret (DESIGN section 10 publishes
  // `system.team.*`), so no existence-oracle claim is made here.
  if (descriptor.kind === 'team' && identity.membership?.is_owner !== true) {
    return errorResult(deps, descriptor.name, buildBusinessError('forbidden'));
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments.');
  }
  const record = args as Record<string, unknown>;
  if ('action_handle' in record) {
    return invokeHandleMode(deps, identity, grantTokenHash, invocation, descriptor, record);
  }
  return invokeOrdinaryMode(deps, identity, grantTokenHash, invocation, descriptor, record);
}

/**
 * Build the MCP request handler: grant auth, then a fresh SDK server on a
 * stateless transport per request.
 *
 * Initialize `_meta` seam: the low-level `Server` constructor registers
 * `InitializeRequestSchema -> _oninitialize`, and the base
 * `Protocol.setRequestHandler` is a plain map set, so calling
 * `setRequestHandler(InitializeRequestSchema, ...)` afterwards cleanly
 * replaces the default. The replacement replicates the SDK's version
 * negotiation (exported `SUPPORTED_PROTOCOL_VERSIONS` /
 * `LATEST_PROTOCOL_VERSION`, same fallback rule) and adds
 * `_meta['org.canlang/fileTransfer']` exactly when the app uses files.
 * No transport-output post-processing is needed.
 */
export function createMcpHandler(deps: McpDeps): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const authed = await resolveGrantIdentity(deps, request);
    if (authed instanceof Response) return authed;
    const { identity, grantTokenHash, invocation } = authed;

    const server = new Server(
      { name: SERVER_NAME, version: MCP_SERVER_VERSION },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(InitializeRequestSchema, (init) => {
      const requested: string = init.params.protocolVersion;
      const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;
      const base = {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: MCP_SERVER_VERSION },
      };
      if (!deps.files.usesFiles(deps.app)) return base;
      const fileTransfer: FileTransferMeta = { version: 1, intents: deps.files.intentsUrl(deps.app) };
      return { ...base, _meta: { [FILE_TRANSFER_META_KEY]: fileTransfer } };
    });
    server.setRequestHandler(ListToolsRequestSchema, () => {
      return listToolsFor(deps, identity).then((tools) => ({ tools }));
    });
    server.setRequestHandler(CallToolRequestSchema, (call) => {
      return handleToolCall(deps, identity, grantTokenHash, invocation, call.params.name, call.params.arguments);
    });

    // Stateless: omitting `sessionIdGenerator` leaves it undefined, so each
    // request uses a fresh transport with no session (explicit `undefined`
    // is rejected under `exactOptionalPropertyTypes`; omission is identical).
    // Plain JSON responses: the server emits no notifications or
    // request-scoped streams, so SSE framing would add nothing.
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  };
}
