/**
 * S7 OAuth metadata (coordinator-owned): protected-resource + authorization-
 * server documents and the `WWW-Authenticate` challenge. Lane 06 is its own
 * authorization server (public clients, PKCE S256 only, access-token =
 * McpGrant Bearer, no refresh in v1). Origins derive per-request from the
 * request URL: same-origin deployment is the honest source at runtime.
 */
export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';
export const AUTHORIZATION_SERVER_PATH = '/.well-known/oauth-authorization-server';
export const REGISTER_PATH = '/oauth/register';
export const AUTHORIZE_PATH = '/oauth/authorize';
export const TOKEN_PATH = '/oauth/token';

/** Request origin (`scheme://host`), or null when the URL is unusable. */
export function requestOrigin(requestUrl: string): string | null {
  try {
    const url = new URL(requestUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** RFC 9728 protected-resource metadata for this origin. */
export function protectedResourceMetadata(origin: string): Record<string, unknown> {
  return {
    resource: origin,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
  };
}

/** Authorization-server metadata (RFC 8414 subset we implement). */
export function authorizationServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
    token_endpoint: `${origin}${TOKEN_PATH}`,
    registration_endpoint: `${origin}${REGISTER_PATH}`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  };
}

/**
 * `WWW-Authenticate` challenge advertising protected-resource discovery
 * (MCP auth spec 2025-11-25). Callers fall back to a bare `Bearer` challenge
 * when the origin is unusable.
 */
export function wwwAuthenticateChallenge(requestUrl: string): string {
  const origin = requestOrigin(requestUrl);
  if (origin === null) return 'Bearer';
  return `Bearer resource_metadata="${origin}${PROTECTED_RESOURCE_PATH}"`;
}
