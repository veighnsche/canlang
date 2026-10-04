/**
 * Credential audience binding: browser sessions, MCP grants, and the upload
 * bridge are separate audiences. A bearer valid in one audience is never
 * silently honored in another (DESIGN section 8: MCP tokens are not blindly
 * forwarded to another audience or origin; section 10: tokens carry the
 * correct audience and cannot impersonate a source).
 *
 * The upload-bridge audience is declared here; its credential binding
 * arrives with the S6 bridge implementation.
 */
import { IdentityError } from '../ports.js';
import type { IdentityBinding } from '../../../contracts/src/identity.js';

export type TokenAudience = 'browser-session' | 'mcp-grant' | 'upload-bridge';

export function bindingAudience(binding: IdentityBinding): TokenAudience | 'public' {
  switch (binding.kind) {
    case 'session':
      return 'browser-session';
    case 'mcp_grant':
      return 'mcp-grant';
    case 'none':
      return 'public';
  }
}

export function assertAudience(
  binding: IdentityBinding,
  expected: TokenAudience,
): void {
  if (bindingAudience(binding) !== expected) {
    throw new IdentityError('forbidden', 'Credential audience mismatch.');
  }
}
