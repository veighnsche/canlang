/**
 * Credential audience binding: credentials carry identity; ROUTES declare
 * which audiences they accept, and acceptance is explicit per route — a
 * Bearer [REDACTED] one audience is never silently honored in another
 * (DESIGN section 8: MCP tokens are not blindly forwarded to another
 * audience or origin; section 10: tokens carry the correct audience and
 * cannot impersonate a source).
 *
 * Route audiences (lane-06 decision, S6): `/api/operations/*` accepts
 * `browser-session` only; `/mcp` accepts `mcp-grant` only; `/files/*`
 * (upload bridge) accepts BOTH `browser-session` (browser flow) and
 * `mcp-grant` (supporting-host flow, DESIGN section 8: both use the same
 * upload flow). This crosses no audience boundary: a grant's audience was
 * always the app, the bridge endpoints are same-origin app endpoints, and
 * every call re-establishes the app-audience runtime authorization —
 * app/team/principal receiver binding — from the presented credential.
 * The token never leaves the app origin; principal/team never change
 * across the acceptance. `upload-bridge` names this dual-acceptance rule,
 * not a third credential kind: there is no exchange step (DESIGN section
 * 8 describes none), and least-privilege scoping stays with the kernel's
 * operation-authority checks plus unattached expiry.
 */
import { IdentityError } from '../ports.js';
import type { IdentityBinding } from '@canlang/contracts';

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
