/**
 * S5 MCP tool generation: one tool per operation-descriptor entry.
 *
 * Tool names are the canonical operation names verbatim
 * (`package.Model.read`); dots are legal in MCP tool names
 * (`/^[A-Za-z0-9._-]{1,128}$/`), so no mangling is needed. Descriptions are
 * the authored `#` text verbatim; `##` never leaves the source.
 */
import type { AppInfo, OperationDescriptor, OperationRegistry } from '../ports.js';
import { toToolInputSchema } from './schemas.js';

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export function toMcpTool(descriptor: OperationDescriptor): McpTool {
  return {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: toToolInputSchema(descriptor),
  };
}

/** Generate the full tool list for an app from its operation registry. */
export function toolsFor(registry: OperationRegistry, app: AppInfo): McpTool[] {
  return registry.list(app).map(toMcpTool);
}
