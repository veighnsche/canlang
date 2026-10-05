/**
 * MCP bridge: a minimal JSON-RPC client for the worker's Streamable-HTTP
 * MCP endpoint (`POST /mcp`) over the e2e {@link HttpBridge}.
 *
 * The client owns NO business logic and invents NO responses: every call is
 * one `fetch` POST of a `{"jsonrpc":"2.0","id","method","params"}` envelope
 * to `<bridge.url>/mcp`, and the worker's `{status, body}` is returned
 * verbatim for the spec to assert. Shapes mirror the `createMcpHandler`
 * contract in `packages/interfaces/src/mcp/server.ts` (unit-proven by
 * `packages/interfaces/test/mcp-server.test.ts`):
 *
 * - authed JSON-RPC calls answer HTTP 200 with `{result}` or `{error}`.
 * - missing/invalid/expired/revoked grants answer HTTP 401 with a safe
 *   `{error:{code,message}}` body (never JSON-RPC).
 * - `initialize` -> `{protocolVersion, capabilities, serverInfo}`.
 * - `tools/list` -> `{tools:[{name, description, inputSchema}]}`.
 * - `tools/call` -> `{content:[{type:"text",text}], structuredContent?,
 *   isError?}`; denials and business errors are `isError` results, framing
 *   failures are JSON-RPC errors (e.g. -32602 InvalidParams).
 *
 * Auth: ONLY `Authorization: Bearer <mcp-grant-token>`. Cookies are never
 * sent here — a session cookie without a grant Bearer [REDACTED] 401s by design.
 */
import type { HttpBridge } from "./http-bridge.js";

/** Single JSON-RPC request id namespace per client (stateless server). */
const CLIENT_NAME = "teamtasks-mcp-e2e";

/** Protocol version requested at initialize (mirrors the unit seam). */
export const MCP_PROTOCOL_VERSION = "2025-11-25";

export interface McpRawResponse {
  readonly status: number;
  /** Parsed JSON body, or the raw text when the body is not JSON. */
  readonly body: unknown;
}

export interface McpRequestOptions {
  /** Grant Bearer [REDACTED] Omit only for the unauthenticated-probe test. */
  readonly grant?: string;
  /** JSON-RPC id. Default: auto-incremented per client. */
  readonly id?: number;
}

export interface McpToolDescription {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

export interface McpClient {
  /** One raw JSON-RPC POST; never throws on HTTP/RPC error statuses. */
  request(method: string, params: Record<string, unknown>, options?: McpRequestOptions): Promise<McpRawResponse>;
  /** `initialize` result body (asserted by the caller). */
  initialize(options?: McpRequestOptions): Promise<McpRawResponse>;
  /** `tools/list` result body (asserted by the caller). */
  listTools(grant: string): Promise<McpRawResponse>;
  /** `tools/call` result body (asserted by the caller). */
  callTool(grant: string, name: string, args: Record<string, unknown>): Promise<McpRawResponse>;
}

/** Narrow a `tools/list` result to its tool array; fails loud on skew. */
export function toolsFromList(body: unknown): McpToolDescription[] {
  const result = rpcResult(body);
  if (typeof result !== "object" || result === null || !Array.isArray((result as { tools?: unknown }).tools)) {
    throw new Error("mcp bridge: tools/list result has no tools array");
  }
  return (result as { tools: McpToolDescription[] }).tools;
}

/** Narrow a `tools/call` result to the tool-result shape; fails loud on skew. */
export function toolResultFromCall(body: unknown): McpToolResult {
  const result = rpcResult(body);
  if (typeof result !== "object" || result === null) {
    throw new Error("mcp bridge: tools/call result is not an object");
  }
  return result as McpToolResult;
}

/** Unwrap `{result}` or throw naming the JSON-RPC `{error}`. */
export function rpcResult(body: unknown): unknown {
  if (typeof body !== "object" || body === null) {
    throw new Error("mcp bridge: response body is not a JSON object");
  }
  const envelope = body as { result?: unknown; error?: { code?: unknown; message?: unknown } };
  if (envelope.error !== undefined) {
    throw new Error(
      `mcp bridge: JSON-RPC error ${String(envelope.error.code)}: ${String(envelope.error.message)}`,
    );
  }
  if (envelope.result === undefined) {
    throw new Error("mcp bridge: response has neither result nor error");
  }
  return envelope.result;
}

/** Unwrap a JSON-RPC `{error}` or throw when the body holds `{result}`. */
export function rpcErrorFrom(body: unknown): { readonly code: number; readonly message: string } {
  if (typeof body !== "object" || body === null) {
    throw new Error("mcp bridge: response body is not a JSON object");
  }
  const envelope = body as { error?: { code?: unknown; message?: unknown } };
  if (
    envelope.error === undefined ||
    typeof envelope.error.code !== "number" ||
    typeof envelope.error.message !== "string"
  ) {
    throw new Error("mcp bridge: response has no JSON-RPC error");
  }
  return { code: envelope.error.code, message: envelope.error.message };
}

export function createMcpClient(bridge: HttpBridge): McpClient {
  let nextId = 1;
  async function request(
    method: string,
    params: Record<string, unknown>,
    options: McpRequestOptions = {},
  ): Promise<McpRawResponse> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (options.grant !== undefined) headers["authorization"] = `Bearer ${options.grant}`;
    const response = await fetch(`${bridge.url}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: options.id ?? nextId++, method, params }),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text === "" ? null : (JSON.parse(text) as unknown);
    } catch {
      // Non-JSON body (e.g. a 404 text page): keep the raw text.
    }
    return { status: response.status, body };
  }
  return {
    request,
    initialize: (options = {}) =>
      request(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: CLIENT_NAME, version: "0.0.0" },
        },
        options,
      ),
    listTools: (grant) => request("tools/list", {}, { grant }),
    callTool: (grant, name, args) => request("tools/call", { name, arguments: args }, { grant }),
  };
}
