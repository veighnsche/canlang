/**
 * S5 MCP tool generation: one tool per operation-descriptor entry.
 *
 * Tool names are the canonical operation names verbatim
 * (`package.Model.read`); dots are legal in MCP tool names
 * (`/^[A-Za-z0-9._-]{1,128}$/`), so no mangling is needed. Descriptions are
 * the authored `#` text verbatim; `##` never leaves the source.
 */
import type { ArtifactOperation } from '@canlang/contracts';
import type { AppInfo, OperationDescriptor, OperationRegistry } from '../ports.js';
import {
  checkArtifactOperation,
  checkArtifactOperations,
  checkedToMcpInputSchema,
  checkedToToolInputSchema,
  toToolInputSchema,
} from './schemas.js';
import type { ArtifactOperationSlice } from './schemas.js';

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

/* ------------------------------------------------------------------ */
/* T19a checked derivation: artifact operations -> MCP registry/tools. */
/* Every builder checks through the shared `schemas.ts` rule, so the   */
/* MCP view derives the same writable allowlist the HTTP catalog      */
/* derives from the same checked operation.                            */
/* ------------------------------------------------------------------ */

/**
 * Convert one artifact operation to its framing-level MCP descriptor:
 * canonical name, verbatim `#` description, kind, and typed inputs.
 * The inputs view is framing-level (element vocabulary — arrays render
 * element-typed, defaults ride the wire channel); value-level array
 * shapes render in `toMcpToolFromArtifact`.
 */
export function toOperationDescriptor(op: ArtifactOperation): OperationDescriptor {
  const checked = checkArtifactOperation(op);
  return {
    name: checked.name,
    kind: checked.kind,
    description: checked.description,
    inputs: checkedToMcpInputSchema(checked),
  };
}

/**
 * Build the MCP operation registry for one version-fenced artifact
 * slice: descriptors in emission order. The registry serves a single
 * artifact and never reads the `app` argument (mirroring the L7 join);
 * a new artifact requires a fresh derivation — stale descriptors never
 * serve new traffic. Any unknown kind, server-owned input, duplicate,
 * or version mismatch rejects the whole slice.
 */
export function registryFromArtifactOperations(slice: ArtifactOperationSlice): OperationRegistry {
  const descriptors = checkArtifactOperations(slice).map(
    (checked): OperationDescriptor => ({
      name: checked.name,
      kind: checked.kind,
      description: checked.description,
      inputs: checkedToMcpInputSchema(checked),
    }),
  );
  const frozen = Object.freeze(descriptors);
  return {
    list: (_app: AppInfo): readonly OperationDescriptor[] => {
      void _app;
      return frozen;
    },
  };
}

/**
 * One artifact operation to its MCP tool: canonical name, verbatim
 * description, and the full array-aware closed input schema.
 */
export function toMcpToolFromArtifact(op: ArtifactOperation): McpTool {
  const checked = checkArtifactOperation(op);
  return {
    name: checked.name,
    description: checked.description,
    inputSchema: checkedToToolInputSchema(checked),
  };
}

/**
 * Generate the full array-aware tool list for one version-fenced
 * artifact slice, in emission order. Schemas render through the
 * artifact path (array inputs as `{type: 'array', items}`); the
 * registry path (`toolsFor` over `registryFromArtifactOperations`)
 * renders the same operations framing-level. Both derive from the
 * same checked operations — same allowlist, same required sets.
 */
export function toolsFromArtifactOperations(slice: ArtifactOperationSlice): McpTool[] {
  return checkArtifactOperations(slice).map((checked) => ({
    name: checked.name,
    description: checked.description,
    inputSchema: checkedToToolInputSchema(checked),
  }));
}
