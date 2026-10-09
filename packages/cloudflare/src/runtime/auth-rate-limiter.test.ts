import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import { createD1AuthRateLimiter } from './auth-rate-limiter.js';

test('actual local D1 shares atomic auth windows, expiry and bounded cleanup across limiter instances', async () => {
  const worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }',
    d1Databases: { DB: 'auth-rate-limiter' } });
  try {
    const db = await worker.getD1Database('DB') as unknown as D1Database;
    let now = 1_000;
    const clock = { nowMs: () => now };
    const first = await createD1AuthRateLimiter(db, { scope: 'OfficeSupplies', clock });
    const second = await createD1AuthRateLimiter(db, { scope: 'OfficeSupplies', clock });
    const other = await createD1AuthRateLimiter(db, { scope: 'AnotherApp', clock });
    const attempts = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      (index % 2 === 0 ? first : second).check('/auth/login:client', 10, 60_000)));
    assert.equal(attempts.filter(result => result.allowed).length, 10);
    assert.deepEqual(attempts.filter(result => !result.allowed),
      Array.from({ length: 10 }, () => ({ allowed: false, retryAfterMs: 60_000 })));
    now += 10_000;
    assert.deepEqual(await second.check('/auth/login:client', 10, 60_000),
      { allowed: false, retryAfterMs: 50_000 });
    assert.equal((await other.check('/auth/login:client', 10, 60_000)).allowed, true);
    assert.equal((await first.check('/auth/login:another-client', 10, 60_000)).allowed, true);
    assert.equal((await first.check('/auth/login:client', 11, 60_000)).allowed, true);
    assert.equal((await first.check('/auth/login:client', 10, 120_000)).allowed, true);
    for (let index = 0; index < 5; index++) {
      assert.equal((await first.check('/auth/recover:client', 5, 3_600_000)).allowed, true);
    }
    assert.deepEqual(await second.check('/auth/recover:client', 5, 3_600_000),
      { allowed: false, retryAfterMs: 3_600_000 });
    now = 61_000;
    assert.deepEqual(await first.check('/auth/login:client', 10, 60_000),
      { allowed: true, retryAfterMs: 0 });
    assert.deepEqual(await first.check('/auth/recover:client', 5, 3_600_000),
      { allowed: false, retryAfterMs: 3_550_000 });
    now = 3_611_000;
    assert.equal((await second.check('/auth/recover:client', 5, 3_600_000)).allowed, true);
    const saturated = await first.check('largest-limit', Number.MAX_SAFE_INTEGER - 1, 1);
    assert.equal(saturated.allowed, true);
    await db.batch(Array.from({ length: 100 }, (_, index) => db.prepare(
      'INSERT INTO can_auth_rate_limits VALUES (?, ?, 1, 1, 1, ?)').bind('cleanup', `expired-${index}`, now)));
    await db.prepare('INSERT INTO can_auth_rate_limits VALUES (?, ?, 1, 1, 1, ?)')
      .bind('cleanup', 'live', now + 1).run();
    const cleanup = await createD1AuthRateLimiter(db, { scope: 'cleanup', clock });
    await cleanup.check('fresh', 1, 1);
    const remaining = await db.prepare('SELECT COUNT(*) AS count FROM can_auth_rate_limits WHERE scope = ? AND expires <= ?')
      .bind('cleanup', now).first<{ count: number }>();
    assert.equal(remaining?.count, 36);
    assert.deepEqual(await cleanup.check('live', 1, 1), { allowed: false, retryAfterMs: 1 });
    await assert.rejects(first.check('x', Number.MAX_SAFE_INTEGER, 1), TypeError);
    await assert.rejects(first.check('', 10, 60_000), TypeError);
    await assert.rejects(first.check('x', 0, 60_000), TypeError);
    await assert.rejects(first.check('x', 10, 0), TypeError);
    now = Number.MAX_SAFE_INTEGER;
    await assert.rejects(first.check('x', 10, 1), TypeError);
    now = 3_611_000;
    await db.exec('DROP TABLE can_auth_rate_limits');
    await assert.rejects(first.check('x', 10, 60_000));
  } finally { await worker.dispose(); }
});

test('auth limiter refuses failed schema setup and invalid durable decision shapes', async () => {
  const clock = { nowMs: () => 1_000 };
  await assert.rejects(createD1AuthRateLimiter({ exec: async () => { throw new Error('unavailable'); } } as unknown as D1Database,
    { scope: 'app', clock }), /unavailable/);
  for (const returned of [null, { hits: 0, expires: 2_000 }, { hits: 12, expires: 2_000 },
    { hits: 1, expires: 1_000 }, { hits: 1, expires: 100_000 }, { hits: '1', expires: 2_000 }]) {
    const statement = { bind() { return this; }, async run() { return {}; }, async first() { return returned; } };
    const db = { async exec() {}, prepare() { return statement; } } as unknown as D1Database;
    const limiter = await createD1AuthRateLimiter(db, { scope: 'app', clock });
    await assert.rejects(limiter.check('client', 10, 60_000), /invalid durable window/);
  }
});
