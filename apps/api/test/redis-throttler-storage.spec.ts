/**
 * Rate-limit storage must fail OPEN, and must fail open FAST.
 *
 * ThrottlerGuard is registered globally, so every request to the API waits on
 * this class. node-redis does not error when the server is gone — `connect()`
 * stays pending for as long as its reconnectStrategy keeps returning a delay,
 * and commands sent while the socket is down sit in the offline queue. An
 * unbounded wait here therefore does not degrade rate limiting, it hangs the
 * entire API: every route, including /api/health, accepts the connection and
 * never answers. That shipped once — with REDIS_URL set and Redis unreachable
 * the process looked healthy in its logs and served nothing.
 *
 * These tests point the storage at a port with nothing on it, which is exactly
 * what an outage (or a developer without Redis) looks like.
 */

import { RedisThrottlerStorage } from '../src/config/redis-throttler-storage';

// Reserved-by-convention port; nothing listens here.
const DEAD_REDIS = 'redis://127.0.0.1:6399';

// The class allows 2s to connect and 1s per command. Anything under this ceiling
// proves the wait is bounded; the point is not the exact number.
const MUST_ANSWER_WITHIN_MS = 6_000;

describe('RedisThrottlerStorage with Redis unreachable', () => {
  let storage: RedisThrottlerStorage;

  beforeEach(() => {
    storage = new RedisThrottlerStorage(DEAD_REDIS);
  });

  afterEach(async () => {
    await storage.onApplicationShutdown();
  });

  it('resolves instead of hanging, and allows the request', async () => {
    const startedAt = Date.now();
    const record = await storage.increment('ip:1.2.3.4', 60_000, 100, 0, 'default');
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(MUST_ANSWER_WITHIN_MS);
    // Fail OPEN: a rate-limiter outage must not reject traffic either.
    expect(record.isBlocked).toBe(false);
    expect(record.totalHits).toBeLessThanOrEqual(100);
  }, 20_000);

  it('does not pay the connect timeout again on every subsequent request', async () => {
    await storage.increment('ip:1.2.3.4', 60_000, 100, 0, 'default');

    // Once it knows Redis is down it short-circuits for a cooldown window,
    // otherwise every request in an outage adds the full connect timeout.
    const startedAt = Date.now();
    for (let i = 0; i < 5; i++) {
      const record = await storage.increment(`ip:1.2.3.${i}`, 60_000, 100, 0, 'default');
      expect(record.isBlocked).toBe(false);
    }
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(500);
  }, 20_000);

  it('never blocks, even past the configured limit', async () => {
    // With storage unavailable there are no counters, so nothing can legitimately
    // conclude a client is over its limit.
    for (let i = 0; i < 10; i++) {
      const record = await storage.increment('ip:9.9.9.9', 60_000, 2, 60_000, 'auth');
      expect(record.isBlocked).toBe(false);
    }
  }, 20_000);
});
