/**
 * Expiring email-token account recovery (DESIGN section 4).
 *
 * Anti-enumeration: `requestRecovery` returns success for unknown addresses
 * and sends nothing, so callers cannot probe for accounts. Recovery links
 * expire after 1h (lane-06 authored). A completed recovery rotates the
 * credential and revokes every session, MCP grant, and outstanding recovery
 * token for the account: authentication changes reuse verification/recovery
 * (DESIGN section 9), never a parallel account CRUD.
 */
import {
  IdentityError,
  systemClock,
  toInstant,
  webRandom,
} from '../ports.js';
import type { Clock, IdentityStore, MailPort, RandomSource } from '../ports.js';
import { createOpaqueToken, sha256HexText } from '../sessions/tokens.js';
import { checkPasswordPolicy, hashPassword } from './passwords.js';
import { normalizeEmail } from './registration.js';

export const RECOVERY_EXPIRES_MS = 60 * 60 * 1000;

export interface RecoveryRequestOptions {
  readonly clock?: Clock;
  readonly random?: RandomSource;
  /** Absolute page URL that receives `?token=` (browser route, S4). */
  readonly recoveryBaseUrl: string;
  readonly recoveryExpiresMs?: number;
}

export async function requestRecovery(
  store: IdentityStore,
  mail: MailPort,
  input: { email: string },
  opts: RecoveryRequestOptions,
): Promise<{ ok: true }> {
  const clock = opts.clock ?? systemClock;
  const random = opts.random ?? webRandom;
  let email: string;
  try {
    email = normalizeEmail(input.email);
  } catch {
    return { ok: true };
  }
  const user = await store.findUserByEmail(email);
  if (user === null) return { ok: true };
  await store.revokeUserEmailTokens(user.user_id, 'recover_account');
  const { token, token_sha256 } = await createOpaqueToken(random);
  await store.createEmailToken({
    user_id: user.user_id,
    purpose: 'recover_account',
    token_sha256,
    expires_at: toInstant(clock.nowMs() + (opts.recoveryExpiresMs ?? RECOVERY_EXPIRES_MS)),
  });
  await mail.sendMail(
    email,
    'Recover your account',
    `Reset your password with this link:\n${opts.recoveryBaseUrl}?token=${token}\nIt expires in 1 hour. If you did not ask for this, ignore this message.`,
  );
  return { ok: true };
}

export async function recoverAccount(
  store: IdentityStore,
  input: { token: string; new_password: string },
  opts: { clock?: Clock; random?: RandomSource } = {},
): Promise<{ user_id: string }> {
  const clock = opts.clock ?? systemClock;
  const random = opts.random ?? webRandom;
  checkPasswordPolicy(input.new_password);
  const row = await store.findEmailTokenByHash(await sha256HexText(input.token));
  const now = toInstant(clock.nowMs());
  if (
    row === null ||
    row.purpose !== 'recover_account' ||
    row.consumed_at !== null ||
    row.expires_at <= now
  ) {
    throw new IdentityError('validation', 'Invalid or expired recovery link.');
  }
  await store.setUserPassword(row.user_id, await hashPassword(input.new_password, random));
  await store.consumeEmailToken(row.token_id);
  await store.revokeUserEmailTokens(row.user_id, 'recover_account');
  await store.revokeUserSessions(row.user_id);
  await store.revokeUserMcpGrants(row.user_id);
  return { user_id: row.user_id };
}
