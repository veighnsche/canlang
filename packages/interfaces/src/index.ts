/**
 * @canlang/interfaces public surface (lane 06).
 *
 * `testing.ts` is deliberately NOT re-exported (test-only doubles).
 */
export * from './ports.js';
export * from './http/context.js';
export * from './errors/envelope.js';
export * from './errors/safe.js';
export * from './errors/redact.js';
export * from './errors/logging.js';
export * from './envelope/validate.js';
export * from './envelope/refs.js';
export * from './envelope/versions.js';
export * from './projection/project.js';
export * from './http/routes.js';
export { handlePageRequest } from './http/pages.js';
export * from './http/operations.js';
export * from './http/fragments.js';
export * from './http/limits.js';
export * from './http/auth.js';
export * from './mcp/schemas.js';
export * from './mcp/tools.js';
export * from './mcp/discovery.js';
export * from './mcp/server.js';
export * from './uploads/principals.js';
export * from './uploads/routes.js';
export * from './ingress/mapping.js';
export * from './ingress/routes.js';
export * from './oauth/metadata.js';
export * from './oauth/routes.js';
export * from './docs/reference.js';

export * from './http/presentation.js';
export * from './http/forms.js';
