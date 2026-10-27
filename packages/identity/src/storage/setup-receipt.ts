/** Read-only setup-receipt inspection for private receipt reconstruction.
 *
 * This module is structurally separated from the creation path: it imports
 * only inert schema text plus the error type, it operates on a prepare-only
 * handle (no batch, no exec, no schema seeding), and every statement it
 * issues is a SELECT. Nothing reachable from `readD1SetupReceipt` can
 * create an owner, consume an admission, or rewrite a claim.
 *
 * Outcomes are explicit, never a single refusal:
 * - a complete committed claim matching (operation + tokenHash + context)
 *   returns its `{teamId, completedAt}`;
 * - no claim and no conflicting identity row anywhere reports `not_found`
 *   (proven unclaimed);
 * - anything else (foreign admission, incomplete/orphaned claim, populated
 *   store without a matching claim, unreadable store) reports `conflict`.
 *
 * Expiry is deliberately NOT an input: an expired admission with a matching
 * committed claim must still reconstruct its receipt. Callers validate
 * `completedAt` against the retained expiry themselves. */
import { IdentityError } from '../ports.js';
import { IDENTITY_DDL, type IdentityD1Database } from './d1.js';

/** Admission key; raw tokens/credentials are never accepted nor retained. */
export interface D1SetupReceiptQuery {
  readonly operation: string;
  readonly tokenHash: string;
  readonly context: string;
}

export interface D1SetupReceipt {
  readonly teamId: string;
  readonly completedAt: number;
}

/** Narrowest handle this path can use: prepare-only, so creation and
 * rewrite primitives are not representable here. */
export type D1SetupReceiptStore = Pick<IdentityD1Database, 'prepare'>;

// Table names are derived from our static DDL and never interpolate
// administration input (same derivation as the bootstrap claim check).
const IDENTITY_TABLES = IDENTITY_DDL.flatMap(sql => {
  const match = /^CREATE TABLE IF NOT EXISTS (identity_[a-z_]+) /.exec(sql);
  return match?.[1] === undefined ? [] : [match[1]];
});

interface SetupClaimRow {
  operation: string;
  token_hash: string;
  context: string;
  completed_at: number;
}

interface OwnerClaimRow {
  user_id: string;
  team_id: string;
}

function missingTable(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

function conflict(message = 'Setup receipt inspection found a conflicting claim.'): never {
  throw new IdentityError('conflict', message);
}

function unclaimed(): never {
  throw new IdentityError('not_found', 'Setup receipt inspection found no committed claim.');
}

/** True only when every owning table is absent or empty: proof that no
 * conflicting identity fact or claim exists. */
async function isUnclaimed(db: D1SetupReceiptStore): Promise<boolean> {
  for (const table of IDENTITY_TABLES) {
    let hit: unknown;
    try {
      hit = await db.prepare(`SELECT 1 AS hit FROM ${table} LIMIT 1`).bind().first();
    } catch (error) {
      if (missingTable(error)) continue;
      conflict();
    }
    if (hit !== null) return false;
  }
  return true;
}

export async function readD1SetupReceipt(db: D1SetupReceiptStore, setup: D1SetupReceiptQuery): Promise<D1SetupReceipt> {
  if (typeof setup.operation !== 'string' || setup.operation.length === 0 || setup.operation.length > 160 ||
    !/^[a-f0-9]{64}$/.test(setup.tokenHash) || typeof setup.context !== 'string' ||
    setup.context.length === 0 || setup.context.length > 4096)
    throw new IdentityError('validation', 'Setup receipt inspection is invalid.');
  let saved: SetupClaimRow | null;
  try {
    saved = await db.prepare('SELECT operation, token_hash, context, completed_at FROM identity_setup_claim WHERE slot = 1')
      .bind().first<SetupClaimRow>();
  } catch (error) {
    // An absent claim table holds no claim, but it proves nothing about the
    // rest of the store: a legacy, populated, or damaged store without this
    // table must still conflict. Only a verified-empty store is unclaimed;
    // anything else fails closed.
    if (missingTable(error)) {
      try {
        if (await isUnclaimed(db)) unclaimed();
      } catch (nested) {
        if (nested instanceof IdentityError) throw nested;
        conflict();
      }
      conflict();
    }
    conflict();
  }
  if (saved === null) {
    try {
      if (await isUnclaimed(db)) unclaimed();
    } catch (error) {
      if (error instanceof IdentityError) throw error;
      conflict();
    }
    conflict();
  }
  if (saved.operation !== setup.operation || saved.token_hash !== setup.tokenHash || saved.context !== setup.context)
    conflict('First-owner setup belongs to a different operation, token or application.');
  // The committed claim is only reconstructible behind a complete owner:
  // the same verified active-owner join the bootstrap recovery requires.
  let owner: OwnerClaimRow | null;
  try {
    owner = await db.prepare('SELECT c.user_id, c.team_id ' +
      'FROM identity_bootstrap_claim c JOIN identity_users u ON u.user_id = c.user_id ' +
      'JOIN identity_teams t ON t.team_id = c.team_id ' +
      'JOIN identity_memberships m ON m.membership_id = c.membership_id AND m.user_id = c.user_id AND m.team_id = c.team_id ' +
      "WHERE c.slot = 1 AND u.email_verified = 1 AND m.is_owner = 1 AND m.status = 'active'")
      .bind().first<OwnerClaimRow>();
  } catch {
    conflict();
  }
  if (owner === null || owner.team_id.length === 0) conflict();
  if (!Number.isSafeInteger(saved.completed_at) || saved.completed_at <= 0) conflict();
  return { teamId: owner.team_id, completedAt: saved.completed_at };
}
