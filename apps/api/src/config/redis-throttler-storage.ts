/**
 * Redis-backed storage for @nestjs/throttler.
 *
 * Why: the default ThrottlerStorageService is in-memory — counters reset on
 * every restart/deploy and are NOT shared between pods, so at >1 replica each
 * pod enforces its own independent limit (effectively N× the configured rate).
 *
 * Behavior:
 *  - Fixed-window counting: INCR + PEXPIRE on first hit of the window. This is
 *    slightly coarser than the library's sliding record list but is the
 *    standard Redis pattern, O(1) per request, and correct across pods.
 *  - blockDuration is honored via a separate block key.
 *  - FAIL-OPEN: if Redis is unreachable, requests are allowed (and the error is
 *    throttle-logged). Rate limiting is a protection layer — an outage in it
 *    must not take down the whole API. HMAC-verified webhooks and auth guards
 *    do not depend on this path.
 *
 * Failing open requires BOUNDING both waits, because node-redis blocks rather
 * than erroring when the server is gone, and ThrottlerGuard is global — an
 * unbounded wait here hangs every single request to the API, health checks
 * included:
 *  - `connect()` NEVER settles while `reconnectStrategy` returns a delay, so it
 *    is raced against CONNECT_TIMEOUT_MS. `connecting` is cleared on failure so
 *    a later request can retry.
 *  - commands issued while the socket is down would sit in the offline queue
 *    until it reconnects, so `disableOfflineQueue` makes them reject instead.
 *  - after a failure we stop trying for UNAVAILABLE_COOLDOWN_MS instead of
 *    paying the connect timeout on every request.
 *
 * Used by app.module.ts only when REDIS_URL is set; otherwise the default
 * in-memory storage applies (correct for single-node dev).
 */
import { OnApplicationShutdown } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { createClient, RedisClientType } from 'redis';
import { AceLogger } from './logger';

const log = new AceLogger('RedisThrottlerStorage');

const CONNECT_TIMEOUT_MS = 2_000;
const COMMAND_TIMEOUT_MS = 1_000;
const UNAVAILABLE_COOLDOWN_MS = 10_000;

export class RedisThrottlerStorage implements ThrottlerStorage, OnApplicationShutdown {
  private client: RedisClientType;
  private connecting: Promise<void> | null = null;
  private lastErrorLogAt = 0;
  private unavailableUntil = 0;

  constructor(redisUrl: string) {
    this.client = createClient({
      url: redisUrl,
      // Without this, commands sent while the socket is down queue silently and
      // resolve only if Redis comes back — an unbounded wait on every request.
      disableOfflineQueue: true,
      socket: {
        connectTimeout: CONNECT_TIMEOUT_MS,
        reconnectStrategy: (retries) => Math.min(100 * Math.pow(2, retries), 30_000),
      },
    });
    // Errors are handled per-operation (fail-open); throttle the log noise.
    this.client.on('error', (err: Error) => {
      const now = Date.now();
      if (now - this.lastErrorLogAt > 60_000) {
        log.warn('redis_throttler_storage_error', { error: err.message, action: 'failing_open' });
        this.lastErrorLogAt = now;
      }
    });
  }

  /** Reject after `ms` rather than waiting on a promise that may never settle. */
  private withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout;
    return Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]).finally(() => clearTimeout(timer)) as Promise<T>;
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.isOpen) return;
    if (!this.connecting) {
      // connect() stays pending forever while reconnectStrategy keeps retrying,
      // so the race is what makes the failure observable at all.
      this.connecting = this.withTimeout(
        this.client.connect().then(() => undefined),
        CONNECT_TIMEOUT_MS,
        'redis connect'
      ).then(
        () => log.info('redis_throttler_storage_connected'),
        (err) => {
          this.connecting = null; // allow a later retry
          throw err;
        }
      );
    }
    await this.connecting;
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string
  ): Promise<ThrottlerStorageRecord> {
    const allow = (): ThrottlerStorageRecord => ({
      totalHits: 1,
      timeToExpire: ttl,
      isBlocked: false,
      timeToBlockExpire: 0,
    });

    // Known-down: skip Redis entirely rather than paying the connect timeout on
    // every request for the duration of the outage.
    if (Date.now() < this.unavailableUntil) return allow();

    try {
      await this.ensureConnected();

      const counterKey = `throttle:{${throttlerName}}:${key}`;
      const blockKey = `${counterKey}:blocked`;
      const cmd = <T>(work: Promise<T>) => this.withTimeout(work, COMMAND_TIMEOUT_MS, 'redis command');

      const blockTtl = await cmd(this.client.pTTL(blockKey));
      if (blockTtl > 0) {
        return { totalHits: limit + 1, timeToExpire: 0, isBlocked: true, timeToBlockExpire: blockTtl };
      }

      const totalHits = await cmd(this.client.incr(counterKey));
      if (totalHits === 1) {
        await cmd(this.client.pExpire(counterKey, ttl));
      }
      let timeToExpire = await cmd(this.client.pTTL(counterKey));
      if (timeToExpire < 0) {
        // Key lost its TTL (e.g. INCR raced an expiry) — reset the window.
        await cmd(this.client.pExpire(counterKey, ttl));
        timeToExpire = ttl;
      }

      if (totalHits > limit && blockDuration > 0) {
        await cmd(this.client.set(blockKey, '1', { PX: blockDuration }));
        return { totalHits, timeToExpire, isBlocked: true, timeToBlockExpire: blockDuration };
      }

      return { totalHits, timeToExpire, isBlocked: false, timeToBlockExpire: 0 };
    } catch (err: any) {
      // Redis down → fail open (allow the request), and stop trying for a while.
      this.unavailableUntil = Date.now() + UNAVAILABLE_COOLDOWN_MS;
      const now = Date.now();
      if (now - this.lastErrorLogAt > 60_000) {
        log.warn('redis_throttler_storage_error', {
          error: err?.message ?? String(err),
          action: 'failing_open',
          cooldownMs: UNAVAILABLE_COOLDOWN_MS,
        });
        this.lastErrorLogAt = now;
      }
      return allow();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.client.isOpen) return;
    // `quit()` waits for a round-trip that never comes if Redis is gone, and
    // `isOpen` is true from the moment connect() is called — including while
    // the client is still retrying. Unbounded, that hangs shutdown until the
    // orchestrator SIGKILLs the pod. Try the graceful close, then force it.
    try {
      await this.withTimeout(this.client.quit().then(() => undefined), COMMAND_TIMEOUT_MS, 'redis quit');
    } catch {
      // disconnect() drops the socket without waiting for a reply.
      await this.withTimeout(this.client.disconnect(), COMMAND_TIMEOUT_MS, 'redis disconnect').catch(
        () => {}
      );
    }
  }
}
