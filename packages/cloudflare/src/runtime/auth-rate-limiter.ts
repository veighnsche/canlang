/** Durable first-hit fixed windows for the owning Interfaces auth limiter port. */
import type { D1Database } from '@cloudflare/workers-types';
import type { Clock } from '@canlang/identity';

export interface D1AuthRateLimiter {
  check(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean; retryAfterMs: number }>;
}

/** One shared Identity D1 binding; scope is trusted app/host configuration. */
export async function createD1AuthRateLimiter(
  db: D1Database,
  options: { readonly scope: string; readonly clock: Clock },
): Promise<D1AuthRateLimiter> {
  const { scope, clock } = options;
  if (typeof scope !== 'string' || scope === '' || typeof clock?.nowMs !== 'function') {
    throw new TypeError('Auth rate limiting requires a nonempty scope and clock.');
  }
  await db.exec('CREATE TABLE IF NOT EXISTS can_auth_rate_limits (scope TEXT NOT NULL, key TEXT NOT NULL, limit_count INTEGER NOT NULL, window_ms INTEGER NOT NULL, hits INTEGER NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY (scope, key, limit_count, window_ms));');
  await db.exec('CREATE INDEX IF NOT EXISTS can_auth_rate_limits_expiry ON can_auth_rate_limits(scope, expires);');
  return {
    async check(key, limit, windowMs) {
      const now = clock.nowMs();
      // One extra saturated hit distinguishes denial; it must remain exact.
      if (typeof key !== 'string' || key === '' || !Number.isSafeInteger(limit) || limit < 1 ||
          limit >= Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(windowMs) || windowMs < 1 ||
          !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + windowMs)) {
        throw new TypeError('Auth rate limiting requires safe positive limits/windows and a safe nonnegative clock.');
      }
      // Bounded indexed cleanup; no live window or another app scope is removed.
      await db.prepare(`DELETE FROM can_auth_rate_limits WHERE rowid IN (
        SELECT rowid FROM can_auth_rate_limits WHERE scope = ? AND expires <= ?
        ORDER BY expires LIMIT 64
      )`).bind(scope, now).run();
      const row = await db.prepare(`INSERT INTO can_auth_rate_limits
        (scope, key, limit_count, window_ms, hits, expires) VALUES (?, ?, ?, ?, 1, ?)
        ON CONFLICT(scope, key, limit_count, window_ms) DO UPDATE SET
          hits = CASE WHEN expires <= ? THEN 1 ELSE MIN(hits + 1, limit_count + 1) END,
          expires = CASE WHEN expires <= ? THEN excluded.expires ELSE expires END
        RETURNING hits, expires`).bind(scope, key, limit, windowMs, now + windowMs, now, now)
        .first<{ hits: number; expires: number }>();
      if (row === null || !Number.isSafeInteger(row.hits) || row.hits < 1 || row.hits > limit + 1 ||
          !Number.isSafeInteger(row.expires) || row.expires <= now || row.expires > now + windowMs) {
        throw new Error('Auth rate limiter returned an invalid durable window.');
      }
      const allowed = row.hits <= limit;
      return { allowed, retryAfterMs: allowed ? 0 : row.expires - now };
    },
  };
}
