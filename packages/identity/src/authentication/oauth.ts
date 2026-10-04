/**
 * OAuth public-client flows (lane 06, S7): dynamic registration, PKCE
 * authorization codes, and code-for-grant exchange.
 *
 * Lane 06 is its own authorization server: public clients only (RFC 7591
 * registration, no secrets), PKCE S256 only (RFC 7636), and the issued
 * access token is an `McpGrant` Bearer [REDACTED] refresh tokens in v1. The raw
 * authorization code is returned once to the consenting caller (who
 * delivers it to the registered redirect URI); the store keeps only its
 * SHA-256 hash, mirroring every other issued credential.
 *
 * Exchange failures collapse missing/consumed/expired codes, client and
 * redirect mismatches, and PKCE mismatches into one validation text: code
 * validity is not an oracle. Consume-then-mint keeps codes single-use even
 * when grant minting throws (a spent code is the correct outcome).
 *
 * WebCrypto globals only; no node:crypto, so this module runs in workerd.
 */
import type {
  AuthCode,
  OAuthClient,
  OAuthClientId,
  TeamId,
  UserId,
} from '@canlang/contracts';
import type { Clock, IdentityStore, RandomSource } from '../ports.js';
import { IdentityError, systemClock, toInstant, webRandom } from '../ports.js';
import {
  bytesToBase64Url,
  createOpaqueToken,
  sha256HexText,
  timingSafeEqualText,
} from '../sessions/tokens.js';
import { issueMcpGrant } from './grants.js';
import type { IssuedMcpGrant } from './grants.js';

export type { IssuedMcpGrant };

/** Authorization-code lifetime: 10 minutes, single use. */
export const AUTH_CODE_TTL_MS = 600_000;

/** Registration bounds: 1..5 redirect URIs per client (lane-06 authored). */
export const OAUTH_MAX_REDIRECT_URIS = 5;

/** PKCE S256 challenge: base64url, 43..128 chars (RFC 7636 section 4.2). */
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

/** `state` passthrough cap: opaque to us, bounded for the redirect line. */
export const OAUTH_MAX_STATE_LENGTH = 1024;

const CODE_FAILED = 'Invalid or expired code.';

function isLoopbackHttp(url: URL): boolean {
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase();
  // RFC 8252 section 7.3 loopback exception: any 127/8, ::1, or localhost.
  // URL.hostname lowercases and strips brackets for IPv6 (Node + workerd).
  return (
    host === 'localhost' || host === '::1' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * Registration-time redirect-URI gate: absolute URL, https or the loopback
 * http exception, no userinfo, no fragment (RFC 6749 section 3.1.2 forbids
 * fragments on the endpoint). Query strings are ALLOWED here: matching is
 * exact-string at issue/exchange time, so a registered query can only help
 * the client (RFC 6749 section 3.1.2.2 requires the full URI match).
 */
function assertRegistrableRedirectUri(uri: unknown): string {
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new IdentityError('validation', 'Each redirect_uri must be a non-empty string.');
  }
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new IdentityError('validation', 'Each redirect_uri must be an absolute URL.');
  }
  if (url.protocol !== 'https:' && !isLoopbackHttp(url)) {
    throw new IdentityError('validation', 'redirect_uri must use https (http is allowed only for loopback).');
  }
  if (url.username !== '' || url.password !== '') {
    throw new IdentityError('validation', 'redirect_uri must not include credentials.');
  }
  if (url.hash !== '') {
    throw new IdentityError('validation', 'redirect_uri must not include a fragment.');
  }
  return uri;
}

export interface RegisterClientInput {
  readonly redirect_uris: readonly string[];
  readonly client_name?: string;
}

export async function registerClient(
  store: IdentityStore,
  input: RegisterClientInput,
  opts: { clock?: Clock } = {},
): Promise<OAuthClient> {
  void (opts.clock ?? systemClock);
  if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0) {
    throw new IdentityError('validation', 'At least one redirect_uri is required.');
  }
  if (input.redirect_uris.length > OAUTH_MAX_REDIRECT_URIS) {
    throw new IdentityError(
      'validation',
      `At most ${OAUTH_MAX_REDIRECT_URIS} redirect_uris are allowed.`,
    );
  }
  const redirect_uris = input.redirect_uris.map(assertRegistrableRedirectUri);
  let client_name = 'MCP client';
  if (input.client_name !== undefined) {
    if (typeof input.client_name !== 'string') {
      throw new IdentityError('validation', 'client_name must be a string.');
    }
    client_name = input.client_name.trim();
    if (client_name.length === 0 || client_name.length > 100) {
      throw new IdentityError('validation', 'client_name must be 1..100 characters.');
    }
  }
  return store.createOAuthClient({ client_name, redirect_uris });
}

export interface AuthorizationRequestInput {
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly code_challenge: string;
}

/**
 * Shared authorize-time validation for the consent descriptor (GET) and the
 * consent issuance (POST): the client must exist, the redirect URI must
 * EXACTLY string-match one registered URI (no normalization — trailing
 * slashes, case, and query all matter), and the PKCE challenge must be
 * well-formed S256. Returns the client row for descriptor rendering.
 */
export async function validateAuthorizationRequest(
  store: IdentityStore,
  input: AuthorizationRequestInput,
): Promise<OAuthClient> {
  const client = await store.findOAuthClient(input.client_id);
  if (client === null) {
    throw new IdentityError('validation', 'Unknown client.');
  }
  if (!client.redirect_uris.includes(input.redirect_uri)) {
    throw new IdentityError('validation', 'redirect_uri does not match this client.');
  }
  if (!CODE_CHALLENGE_PATTERN.test(input.code_challenge)) {
    throw new IdentityError('validation', 'code_challenge must be base64url, 43..128 characters (S256).');
  }
  return client;
}

export interface IssueAuthCodeInput {
  readonly user_id: UserId;
  readonly team_id: TeamId | null;
  readonly client_id: OAuthClientId;
  readonly redirect_uri: string;
  readonly code_challenge: string;
}

export interface IssuedAuthCode {
  /** Presented once at the token endpoint; never stored or logged. */
  readonly code: string;
  readonly codeRecord: AuthCode;
}

/**
 * Mint an authorization code for an already-authenticated user. The caller
 * (consent route) must have verified the session + team + CSRF; this
 * function validates the OAuth parameters and mints, it does not
 * authenticate.
 */
export async function issueAuthCode(
  store: IdentityStore,
  input: IssueAuthCodeInput,
  opts: { clock?: Clock; random?: RandomSource } = {},
): Promise<IssuedAuthCode> {
  await validateAuthorizationRequest(store, {
    client_id: input.client_id,
    redirect_uri: input.redirect_uri,
    code_challenge: input.code_challenge,
  });
  const clock = opts.clock ?? systemClock;
  const { token: code, token_sha256 } = await createOpaqueToken(opts.random ?? webRandom);
  const codeRecord = await store.createAuthCode({
    client_id: input.client_id,
    user_id: input.user_id,
    team_id: input.team_id,
    redirect_uri: input.redirect_uri,
    code_challenge: input.code_challenge,
    code_sha256: token_sha256,
    expires_at: toInstant(clock.nowMs() + AUTH_CODE_TTL_MS),
  });
  return { code, codeRecord };
}

export interface ExchangeCodeInput {
  readonly code: string;
  readonly client_id: OAuthClientId;
  readonly redirect_uri: string;
  readonly code_verifier: string;
}

async function pkceChallengeMatches(verifier: string, challenge: string): Promise<boolean> {
  // S256: BASE64URL(SHA256(verifier)) compared constant-time. A malformed
  // verifier simply fails the comparison — no separate error, no oracle.
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return timingSafeEqualText(bytesToBase64Url(new Uint8Array(digest)), challenge);
}

/**
 * Exchange a code for an MCP grant Bearer. Every failure mode — unknown,
 * consumed, or expired code, client or redirect mismatch, PKCE mismatch —
 * collapses into one validation text. The code is consumed BEFORE minting
 * so it is single-use even when minting throws.
 */
export async function exchangeCode(
  store: IdentityStore,
  input: ExchangeCodeInput,
  opts: { clock?: Clock; random?: RandomSource } = {},
): Promise<IssuedMcpGrant> {
  const clock = opts.clock ?? systemClock;
  const row = await store.findAuthCodeByHash(await sha256HexText(input.code));
  const now = toInstant(clock.nowMs());
  if (row === null || row.consumed_at !== null || row.expires_at <= now) {
    throw new IdentityError('validation', CODE_FAILED);
  }
  if (row.client_id !== input.client_id || row.redirect_uri !== input.redirect_uri) {
    throw new IdentityError('validation', CODE_FAILED);
  }
  if (!(await pkceChallengeMatches(input.code_verifier, row.code_challenge))) {
    throw new IdentityError('validation', CODE_FAILED);
  }
  await store.consumeAuthCode(row.code_sha256);
  return issueMcpGrant(
    store,
    { user_id: row.user_id, team_id: row.team_id, client_id: row.client_id },
    { clock, ...(opts.random === undefined ? {} : { random: opts.random }) },
  );
}
