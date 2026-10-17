/** Bounded app-local administration commands. Hosts must hold the stopped
 * application's writer lock; identity facts remain in the owning D1 schema. */
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../accounts/passwords.js';
import { normalizeEmail } from '../accounts/registration.js';
import { IdentityError, systemClock, toInstant, webRandom } from '../ports.js';
import { ensureIdentitySchema, IDENTITY_DDL, type IdentityD1Database } from './d1.js';

export interface D1OwnerBootstrapInput {
  readonly email: string;
  readonly password: string;
  readonly timezone?: string;
}

export interface D1OwnerBootstrapOutcome {
  readonly userId: string;
  readonly teamId: string;
}

interface OwnerClaim {
  readonly user_id: string;
  readonly team_id: string;
  readonly email_lc: string;
  readonly password_hash: string;
  readonly timezone: string;
}

// Every owning table participates, including future schema additions. Names
// are derived from our static DDL and never interpolate administration input.
const IDENTITY_TABLES = IDENTITY_DDL.flatMap(sql => {
  const match = /^CREATE TABLE IF NOT EXISTS (identity_[a-z_]+) /.exec(sql);
  return match?.[1] === undefined ? [] : [match[1]];
});

function validate(input: D1OwnerBootstrapInput): { email: string; timezone: string } {
  const email = normalizeEmail(input.email);
  checkPasswordPolicy(input.password);
  const timezone = input.timezone ?? 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
  catch { throw new IdentityError('validation', 'Enter a supported timezone.', 'timezone'); }
  return { email, timezone };
}

async function readOwnerClaim(db: IdentityD1Database): Promise<OwnerClaim | null> {
  return db.prepare('SELECT c.user_id, c.team_id, u.email_lc, u.password_hash, t.timezone ' +
    'FROM identity_bootstrap_claim c JOIN identity_users u ON u.user_id = c.user_id ' +
    'JOIN identity_teams t ON t.team_id = c.team_id ' +
    'JOIN identity_memberships m ON m.membership_id = c.membership_id AND m.user_id = c.user_id AND m.team_id = c.team_id ' +
    "WHERE c.slot = 1 AND u.email_verified = 1 AND m.is_owner = 1 AND m.status = 'active'")
    .bind().first<OwnerClaim>();
}

async function recover(claim: OwnerClaim, input: D1OwnerBootstrapInput,
  validated: { email: string; timezone: string }): Promise<D1OwnerBootstrapOutcome> {
  if (claim.email_lc !== validated.email || claim.timezone !== validated.timezone ||
      !await verifyPassword(input.password, claim.password_hash)) {
    throw new IdentityError('conflict', 'Owner bootstrap was already claimed with different credentials or configuration.');
  }
  return { userId: claim.user_id, teamId: claim.team_id };
}

/** Claim the first owner, user, team and membership in one genuine D1 batch.
 * Existing unclaimed identity data cannot be adopted. Retried matching input
 * returns the retained outcome; it never resets credentials or membership. */
export async function bootstrapD1Owner(db: IdentityD1Database,
  input: D1OwnerBootstrapInput): Promise<D1OwnerBootstrapOutcome> {
  const validated = validate(input);
  if (typeof db.batch !== 'function') throw new Error('Owner bootstrap requires genuine transactional D1 batch support.');
  await ensureIdentitySchema(db);
  const prior = await readOwnerClaim(db);
  if (prior !== null) return recover(prior, input, validated);
  const userId = webRandom.randomUUID(), teamId = webRandom.randomUUID(), membershipId = webRandom.randomUUID();
  const at = toInstant(systemClock.nowMs()), passwordHash = await hashPassword(input.password);
  const empty = IDENTITY_TABLES
    .map(table => `NOT EXISTS (SELECT 1 FROM ${table})`).join(' AND ');
  const statements = [
    db.prepare(`INSERT INTO identity_bootstrap_claim (slot, user_id, team_id, membership_id) SELECT 1, ?, ?, ? WHERE ${empty}`)
      .bind(userId, teamId, membershipId),
    db.prepare('INSERT INTO identity_users (user_id, email, email_lc, email_verified, password_hash, created_at, updated_at) ' +
      'SELECT user_id, ?, ?, 1, ?, ?, ? FROM identity_bootstrap_claim WHERE slot = 1 AND user_id = ?')
      .bind(validated.email, validated.email, passwordHash, at, at, userId),
    db.prepare('INSERT INTO identity_teams (team_id, timezone, created_at) ' +
      'SELECT team_id, ?, ? FROM identity_bootstrap_claim WHERE slot = 1 AND user_id = ?')
      .bind(validated.timezone, at, userId),
    db.prepare('INSERT INTO identity_memberships (membership_id, team_id, user_id, is_owner, roles, status, created_at, updated_at) ' +
      "SELECT membership_id, team_id, user_id, 1, '[]', 'active', ?, ? FROM identity_bootstrap_claim WHERE slot = 1 AND user_id = ?")
      .bind(at, at, userId),
  ];
  let failed = false;
  try { await db.batch(statements); } catch { failed = true; }
  // A missing acknowledgement is resolved only from a complete committed
  // claim and verified credentials, never from an optimistic user lookup.
  const saved = await readOwnerClaim(db);
  if (saved !== null) return recover(saved, input, validated);
  if (failed) throw new Error('Owner bootstrap transaction did not complete; retry with the same credentials.');
  throw new IdentityError('conflict', 'Identity database is populated or has an incomplete owner claim; bootstrap refused.');
}

export interface D1TeamMemberInput {
  readonly teamId: string;
  readonly email: string;
  readonly password: string;
}

/** Add an ordinary verified member through the stopped writer's admin path.
 * Existing matching accounts are reused, never reset or elevated; removed
 * memberships and unverified/differently credentialed accounts are refused. */
export async function addD1TeamMember(db: IdentityD1Database,
  input: D1TeamMemberInput): Promise<D1OwnerBootstrapOutcome> {
  const email = normalizeEmail(input.email);
  checkPasswordPolicy(input.password);
  if (!input.teamId) throw new IdentityError('validation', 'A team ID is required.', 'teamId');
  if (typeof db.batch !== 'function') throw new Error('Member administration requires genuine transactional D1 batch support.');
  await ensureIdentitySchema(db);
  const ownerGuard = "EXISTS (SELECT 1 FROM identity_bootstrap_claim c JOIN identity_memberships owner ON owner.team_id = c.team_id " +
    "WHERE c.slot = 1 AND c.team_id = ? AND owner.is_owner = 1 AND owner.status = 'active')";
  const claimed = await db.prepare(`SELECT 1 AS claimed WHERE ${ownerGuard}`).bind(input.teamId).first();
  if (claimed === null) throw new IdentityError('conflict', 'Member administration requires the claimed team and its active owner.');
  const prior = await db.prepare('SELECT user_id, password_hash, email_verified FROM identity_users WHERE email_lc = ?')
    .bind(email).first<{ user_id: string; password_hash: string; email_verified: number }>();
  if (prior !== null && (prior.email_verified !== 1 || !await verifyPassword(input.password, prior.password_hash))) {
    throw new IdentityError('conflict', 'An existing account has different credentials or verification state.');
  }
  const passwordHash = prior?.password_hash ?? await hashPassword(input.password);
  const userId = prior?.user_id ?? webRandom.randomUUID(), membershipId = webRandom.randomUUID();
  const at = toInstant(systemClock.nowMs());
  let failed = false;
  try {
    await db.batch([
      db.prepare('INSERT INTO identity_users (user_id, email, email_lc, email_verified, password_hash, created_at, updated_at) ' +
        `SELECT ?, ?, ?, 1, ?, ?, ? WHERE ${ownerGuard} AND NOT EXISTS (SELECT 1 FROM identity_users WHERE email_lc = ?)`)
        .bind(userId, email, email, passwordHash, at, at, input.teamId, email),
      db.prepare('INSERT INTO identity_memberships (membership_id, team_id, user_id, is_owner, roles, status, created_at, updated_at) ' +
        "SELECT ?, ?, u.user_id, 0, '[]', 'active', ?, ? FROM identity_users u WHERE u.email_lc = ? AND u.password_hash = ? AND u.email_verified = 1 AND " +
        `${ownerGuard} AND NOT EXISTS (SELECT 1 FROM identity_memberships m WHERE m.team_id = ? AND m.user_id = u.user_id)`)
        .bind(membershipId, input.teamId, at, at, email, passwordHash, input.teamId, input.teamId),
    ]);
  } catch { failed = true; }
  const saved = await db.prepare('SELECT u.user_id, u.password_hash, m.team_id, m.status FROM identity_users u ' +
    'JOIN identity_memberships m ON m.user_id = u.user_id WHERE u.email_lc = ? AND u.email_verified = 1 AND m.team_id = ?')
    .bind(email, input.teamId).first<{ user_id: string; password_hash: string; team_id: string; status: string }>();
  if (saved !== null && saved.status === 'active' && await verifyPassword(input.password, saved.password_hash)) {
    return { userId: saved.user_id, teamId: saved.team_id };
  }
  if (failed) throw new Error('Member administration transaction did not complete; retry with the same credentials.');
  throw new IdentityError('conflict', 'Member administration could not confirm an active matching membership.');
}
