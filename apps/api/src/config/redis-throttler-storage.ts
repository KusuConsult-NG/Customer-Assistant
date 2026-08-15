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
 * Used by app.module.ts only when REDIS_URL is set; otherwise the default
 * in-memory storage applies (correct for single-node dev).
 */
import { OnApplicationShutdown } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { createClient, RedisClientType } from 'redis';
import { AceLogger } from './logger';

const log = new AceLogger('RedisThrottlerStorage');

export class RedisThrottlerStorage implements ThrottlerStorage, OnApplicationShutdown {
  private client: RedisClientType;
  private connecting: Promise<void> | null = null;
  private lastErrorLogAt = 0;

  constructor(redisUrl: string) {
    this.client = createClient({
      url: redisUrl,
      socket: {
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

  private async ensureConnected(): Promise<void> {
    if (this.client.isOpen) return;
    if (!this.connecting) {
      this.connecting = this.client.connect().then(
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
    try {
      await this.ensureConnected();

      const counterKey = `throttle:{${throttlerName}}:${key}`;
      const blockKey = `${counterKey}:blocked`;

      const blockTtl = await this.client.pTTL(blockKey);
      if (blockTtl > 0) {
        return { totalHits: limit + 1, timeToExpire: 0, isBlocked: true, timeToBlockExpire: blockTtl };
      }

      const totalHits = await this.client.incr(counterKey);
      if (totalHits === 1) {
        await this.client.pExpire(counterKey, ttl);
      }
      let timeToExpire = await this.client.pTTL(counterKey);
      if (timeToExpire < 0) {
        // Key lost its TTL (e.g. INCR raced an expiry) — reset the window.
        await this.client.pExpire(counterKey, ttl);
        timeToExpire = ttl;
      }

      if (totalHits > limit && blockDuration > 0) {
        await this.client.set(blockKey, '1', { PX: blockDuration });
        return { totalHits, timeToExpire, isBlocked: true, timeToBlockExpire: blockDuration };
      }

      return { totalHits, timeToExpire, isBlocked: false, timeToBlockExpire: 0 };
    } catch {
      // Redis down → fail open (allow the request); error already throttle-logged.
      return { totalHits: 1, timeToExpire: ttl, isBlocked: false, timeToBlockExpire: 0 };
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit().catch(() => {});
    }
  }
}
