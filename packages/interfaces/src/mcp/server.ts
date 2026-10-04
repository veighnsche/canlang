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
 * mode (closed against `HANDLE_MODE_ALLOWED`, mutation kinds only), else
 * `operation_id` for mutation kinds, then `checkClosedInputs` against the
 * catalog shape, then ref/version SHAPE checks from the descriptor's typed
 * fields (staleness stays L3's `conflict`). Framing failures are JSON-RPC
 * `InvalidParams` (-32602); unknown tools are `InvalidParams`; denied calls
 * and business errors are `isError` results with the S3 safe projection;
 * invoker throws are `InternalError` with a generic message after an
 * incident-logged journal entry.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
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
import { assertAudience, IdentityError, resolveIdentity } from '@canlang/identity';
import type {
  McpDeps,
  McpOperationKind,
  MutationOutcome,
  OperationDescriptor,
  ReadOutcome,
} from '../ports.js';
import { buildBusinessError, toMcpError } from '../errors/envelope.js';
import { logInternalError } from '../errors/logging.js';
import { checkClosedInputs, validateOperationId } from '../envelope/validate.js';
import { parseMutationRef, parseReadRef } from '../envelope/refs.js';
import { listToolsFor } from './discovery.js';
import { HANDLE_MODE_ALLOWED } from './schemas.js';

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

function errorResponse(status: number, error: BusinessError): Response {
  return new Response(JSON.stringify({ error: { code: error.code, message: error.message } }), {
    status,
    headers: { 'content-type': JSON_CONTENT_TYPE },
  });
}

/** Extract the grant Bearer [REDACTED] `Authorization`; null when absent or malformed. */
function bearerToken(request: Request): string | null {
  const header = (request.headers.get('authorization') ?? '').trim();
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token === '' ? null : token;
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
): Promise<ResolvedIdentity | Response> {
  const token = bearerToken(request);
  if (token === null) {
    return errorResponse(401, buildBusinessError('forbidden', 'Authentication required.'));
  }
  try {
    const identity = await resolveIdentity(
      deps.identity.store,
      { mcp_grant_token: token },
      { clock: deps.clock },
    );
    assertAudience(identity.binding, 'mcp-grant');
    return identity;
  } catch (err) {
    if (err instanceof IdentityError) {
      return errorResponse(401, buildBusinessError(err.code, err.message));
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
 * SDK result type (the S3 projection uses readonly members).
 */
function errorResult(error: BusinessError): ToolCallResult {
  const projected = toMcpError(error);
  return {
    content: projected.content.map((block) => ({ type: 'text' as const, text: block.text })),
    structuredContent: { ...projected.structuredContent },
    isError: true,
  };
}

/**
 * Success projection: the result as one JSON text block plus, when the
 * result is a plain object, as `structuredContent`. The SDK validates
 * `tools/call` results against `CallToolResultSchema`, whose
 * `structuredContent` is a string-record-or-absent — non-object results
 * (possible for reads: `ReadResult` is `unknown`) therefore omit the
 * member rather than fail validation; the JSON text always carries them.
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
): Promise<ToolCallResult> {
  let outcome: MutationOutcome;
  try {
    outcome = await deps.invoker.invokeMutation(envelope, identity);
  } catch (err) {
    logInternalError(deps.logger, err, { route: 'mcp', tool: envelope.operation });
    throw new McpError(ErrorCode.InternalError, 'Internal error.');
  }
  if ('error' in outcome) return errorResult(outcome.error);
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
  if ('error' in outcome) return errorResult(outcome.error);
  return successResult(outcome.result);
}

/**
 * Handle-mode framing: closed against `HANDLE_MODE_ALLOWED`, mutation
 * kinds only, sealed-handle object shape + `operation_id` plausibility.
 * The sealed handle contents are opaque here — verification is L3/L4's.
 */
async function invokeHandleMode(
  deps: McpDeps,
  identity: ResolvedIdentity,
  descriptor: OperationDescriptor,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  if (!isMutationKind(descriptor.kind)) {
    throw new McpError(ErrorCode.InvalidParams, 'action_handle is only accepted for mutation tools.');
  }
  for (const key of Object.keys(args)) {
    if (!(HANDLE_MODE_ALLOWED as readonly string[]).includes(key)) {
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
  const envelope: MutationEnvelope = {
    operation: descriptor.name,
    operation_id: operationId,
    inputs: { action_handle: handle },
  };
  return invokeMutationOutcome(deps, identity, envelope);
}

/**
 * Ordinary-mode framing, mirroring `http/operations.ts` order:
 * `operation_id` for mutation kinds, catalog closed-inputs check, then
 * ref/version SHAPE checks from the descriptor's typed fields.
 */
async function invokeOrdinaryMode(
  deps: McpDeps,
  identity: ResolvedIdentity,
  descriptor: OperationDescriptor,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const mutation = isMutationKind(descriptor.kind);
  let operationId = '';
  if (mutation) {
    const raw: unknown = args['operation_id'];
    if (typeof raw !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'Missing operation_id.');
    }
    const idError = validateOperationId(raw, deps.clock);
    if (idError !== null) {
      throw new McpError(ErrorCode.InvalidParams, idError.message);
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
  const shape = deps.catalog.shapeFor(descriptor.name);
  if (shape === null) {
    // Registry/catalog skew: the tool was discoverable, so existence is
    // not secret — answer the S4 `not_found` meaning as an `isError`.
    return errorResult(buildBusinessError('not_found', 'Unknown operation.'));
  }
  const closedError = checkClosedInputs(businessInputs, shape);
  if (closedError !== null) {
    throw new McpError(ErrorCode.InvalidParams, closedError.message);
  }
  for (const named of descriptor.inputs.fields) {
    if (named.field.kind !== 'ref') continue;
    if (!Object.prototype.hasOwnProperty.call(businessInputs, named.name)) continue;
    const value: unknown = businessInputs[named.name];
    // Keyed on the descriptor's requireVersion (matching the generated
    // schema), not the tool kind: a mutation input modeled without a
    // version accepts ReadRef shape, exactly as its schema advertises.
    if (named.field.requireVersion) {
      const parsed = parseMutationRef(value, `/${named.name}`);
      if ('error' in parsed) {
        throw new McpError(ErrorCode.InvalidParams, parsed.error.message);
      }
    } else {
      const parsed = parseReadRef(value);
      if ('error' in parsed) {
        throw new McpError(ErrorCode.InvalidParams, parsed.error.message);
      }
    }
  }
  if (mutation) {
    const envelope: MutationEnvelope = {
      operation: descriptor.name,
      operation_id: operationId,
      inputs: businessInputs,
    };
    return invokeMutationOutcome(deps, identity, envelope);
  }
  const envelope: ReadEnvelope = { operation: descriptor.name, inputs: businessInputs };
  return invokeReadOutcome(deps, identity, envelope);
}

async function handleToolCall(
  deps: McpDeps,
  identity: ResolvedIdentity,
  name: string,
  args: unknown,
): Promise<ToolCallResult> {
  const descriptor = deps.registry.list(deps.app).find((d) => d.name === name) ?? null;
  if (descriptor === null) {
    throw new McpError(ErrorCode.InvalidParams, `Unknown tool '${name}'.`);
  }
  // Forbidden stays an `isError` with the safe message: discovery already
  // decided what the caller may see, and the denial must not become a
  // tool-existence oracle beyond it.
  if (!(await deps.permissions.canCall(identity, descriptor.name))) {
    return errorResult(buildBusinessError('forbidden'));
  }
  // Owner-only team management, enforced on the call path exactly as in
  // discovery: discovery filtering alone would leave a direct tools/call
  // oracle for non-owners when the permission port is permissive.
  if (descriptor.kind === 'team' && identity.membership?.is_owner !== true) {
    return errorResult(buildBusinessError('forbidden'));
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid arguments.');
  }
  const record = args as Record<string, unknown>;
  if ('action_handle' in record) {
    return invokeHandleMode(deps, identity, descriptor, record);
  }
  return invokeOrdinaryMode(deps, identity, descriptor, record);
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
    const identity = authed;

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
      return handleToolCall(deps, identity, call.params.name, call.params.arguments);
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
