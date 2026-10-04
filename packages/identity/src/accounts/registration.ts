/**
 * Verified-email registration, email verification, and password sign-in
 * (DESIGN section 4: default `auth email password` needs no source lines).
 *
 * Email rules are lane-06 authored (DESIGN pins verification, not syntax):
 * trimmed, lowercased, max 254 chars, single-@ dotted shape. Verification
 * links expire after 24h (authored); sessions last 7d absolute (authored).
 * Sign-in failures use one identical message for unknown email vs wrong
 * password (no account oracle); unverified accounts get a distinct message
 * because registration already confirmed the address exists.
 */
import {
  IdentityError,
  systemClock,
  toInstant,
  webRandom,
} from '../ports.js';
import type { Clock, IdentityStore, MailPort, RandomSource } from '../ports.js';
import { bytesToBase64Url, createOpaqueToken, sha256HexText } from '../sessions/tokens.js';
import { checkPasswordPolicy, hashPassword, verifyPassword } from './passwords.js';

export const EMAIL_MAX_LENGTH = 254;
export const VERIFY_EMAIL_EXPIRES_MS = 24 * 60 * 60 * 1000;
export const SESSION_EXPIRES_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Well-formed dummy encoding (all-zero salt/key) for oracle-free login
 * misses. Built programmatically so the salt/key lengths always parse and
 * the dummy verification always pays the full PBKDF2 cost.
 */
export const DUMMY_PASSWORD_ENCODING =
  `pbkdf2-sha256$600000$${bytesToBase64Url(new Uint8Array(16))}$${bytesToBase64Url(new Uint8Array(32))}`;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > EMAIL_MAX_LENGTH ||
    !EMAIL_PATTERN.test(normalized)
  ) {
    throw new IdentityError('validation', 'Enter a valid email address.', 'email');
  }
  return normalized;
}

export interface RegisterOptions {
  readonly clock?: Clock;
  readonly random?: RandomSource;
  /** Absolute page URL that receives `?token=` (browser route, S4). */
  readonly verifyBaseUrl: string;
  readonly verifyExpiresMs?: number;
}

export async function registerWithEmail(
  store: IdentityStore,
  mail: MailPort,
  input: { email: string; password: string },
  opts: RegisterOptions,
): Promise<{ user_id: string; email: string }> {
  const clock = opts.clock ?? systemClock;
  const random = opts.random ?? webRandom;
  const email = normalizeEmail(input.email);
  checkPasswordPolicy(input.password);
  const existing = await store.findUserByEmail(email);
  if (existing !== null) {
    throw new IdentityError(
      'conflict',
      'An account with this email already exists.',
      'email',
    );
  }
  const password_hash = await hashPassword(input.password, random);
  const user = await store.createUser({ email, password_hash, email_verified: false });
  const { token, token_sha256 } = await createOpaqueToken(random);
  await store.createEmailToken({
    user_id: user.user_id,
    purpose: 'verify_email',
    token_sha256,
    expires_at: toInstant(clock.nowMs() + (opts.verifyExpiresMs ?? VERIFY_EMAIL_EXPIRES_MS)),
  });
  await mail.sendMail(
    email,
    'Verify your email',
    `Welcome. Confirm this address to finish creating your account:\n${opts.verifyBaseUrl}?token=${token}\nThis link expires in 24 hours.`,
  );
  return { user_id: user.user_id, email };
}

const INVALID_LINK = 'Invalid or expired verification link.';

export async function verifyEmail(
  store: IdentityStore,
  input: { token: string },
  opts: { clock?: Clock } = {},
): Promise<{ user_id: string }> {
  const clock = opts.clock ?? systemClock;
  const row = await store.findEmailTokenByHash(await sha256HexText(input.token));
  const now = toInstant(clock.nowMs());
  if (
    row === null ||
    row.purpose !== 'verify_email' ||
    row.consumed_at !== null ||
    row.expires_at <= now
  ) {
    throw new IdentityError('validation', INVALID_LINK);
  }
  await store.setUserEmailVerified(row.user_id, true);
  await store.consumeEmailToken(row.token_id);
  return { user_id: row.user_id };
}

export interface LoginOptions {
  readonly clock?: Clock;
  readonly random?: RandomSource;
  readonly sessionExpiresMs?: number;
}

export async function loginWithPassword(
  store: IdentityStore,
  input: { email: string; password: string },
  opts: LoginOptions = {},
): Promise<{ token: string; session_id: string }> {
  const clock = opts.clock ?? systemClock;
  const random = opts.random ?? webRandom;
  const email = normalizeEmail(input.email);
  const user = await store.findUserByEmail(email);
  // Identical failure for unknown email vs wrong password: no oracle. The
  // dummy verification keeps unknown-email timing near wrong-password
  // timing (same PBKDF2 cost); without it the short-circuit is measurable.
  if (user === null) {
    await verifyPassword(input.password, DUMMY_PASSWORD_ENCODING);
    throw new IdentityError('forbidden', 'Invalid email or password.');
  }
  if (!(await verifyPassword(input.password, user.password_hash))) {
    throw new IdentityError('forbidden', 'Invalid email or password.');
  }
  if (!user.email_verified) {
    throw new IdentityError('forbidden', 'Verify your email before signing in.');
  }
  const { token, token_sha256 } = await createOpaqueToken(random);
  const session = await store.createSession({
    user_id: user.user_id,
    token_sha256,
    expires_at: toInstant(clock.nowMs() + (opts.sessionExpiresMs ?? SESSION_EXPIRES_MS)),
    last_team_id: null,
  });
  return { token, session_id: session.session_id };
}
