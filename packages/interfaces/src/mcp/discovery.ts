/**
 * S5 MCP discovery: the registry tool list filtered by current permissions.
 *
 * Discovery rechecks from live identity/grants on every call (never cached
 * across callers, teams, or revisions). `team`-kind tools are additionally
 * owner-only: only a caller whose active membership has `is_owner` sees
 * them, so team management never leaks to non-owners via discovery.
 */
import type { ResolvedIdentity } from '@canlang/contracts';
import type { McpDeps } from '../ports.js';
import { toMcpTool } from './tools.js';
import type { McpTool } from './tools.js';

export async function listToolsFor(
  deps: McpDeps,
  identity: ResolvedIdentity,
): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  for (const descriptor of deps.registry.list(deps.app)) {
    if (descriptor.kind === 'team' && identity.membership?.is_owner !== true) {
      continue;
    }
    if (!(await deps.permissions.canDiscover(identity, descriptor.name))) {
      continue;
    }
    tools.push(toMcpTool(descriptor));
  }
  return tools;
}
