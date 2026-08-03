/**
 * ACE Platform — Socket.IO Redis Adapter Configuration
 *
 * WHY this is critical:
 *   Socket.IO rooms are in-memory by default. When you run more than one NestJS
 *   API pod behind a load balancer (ALB, Nginx, Cloudflare), each pod has its
 *   own isolated in-memory room registry.
 *
 *   Scenario that breaks without this:
 *     - Agent connects to Pod A, joins room org_abc123
 *     - Customer sends WhatsApp message, webhook lands on Pod B
 *     - Pod B emits 'new_message_received' to org_abc123
 *     - Pod A never receives this event — agent sees no live updates
 *
 *   The @socket.io/redis-adapter publishes events to a Redis pub/sub channel.
 *   All pods subscribe to the same channel and fan-out to their local room clients.
 *   This makes WebSocket events work correctly across any number of pods.
 *
 * Degraded mode (no Redis):
 *   If REDIS_URL is not set, or Redis is unreachable, the adapter is skipped.
 *   The API continues to work in single-node mode — all REST endpoints and
 *   WebSocket connections on the same pod function normally. Only cross-pod
 *   fan-out is degraded.
 *
 *   Error logging is THROTTLED to prevent log spam: only the first connection
 *   error and then one error per minute are logged. This keeps the console clean
 *   during local development without Redis.
 *
 * Reference:
 *   https://socket.io/docs/v4/redis-adapter/
 */

import { INestApplication, Logger } from '@nestjs/common';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';

const logger = new Logger('SocketIORedisAdapter');

/** Throttle error logs: log at most once per 60 seconds per client. */
function makeThrottledErrorHandler(clientName: string) {
  let lastLoggedAt = 0;
  let suppressedCount = 0;

  return (err: Error) => {
    const now = Date.now();
    if (now - lastLoggedAt > 60_000) {
      const suppressed = suppressedCount > 0 ? ` (${suppressedCount} similar errors suppressed)` : '';
      logger.warn(
        `Redis ${clientName} unreachable: ${err.message}${suppressed}. ` +
        `Running in single-node WebSocket mode. Start Redis to enable multi-pod fan-out.`
      );
      lastLoggedAt = now;
      suppressedCount = 0;
    } else {
      suppressedCount++;
    }
  };
}

export async function attachRedisAdapter(app: INestApplication): Promise<void> {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    logger.warn(
      'REDIS_URL is not set — Socket.IO running in single-node mode. ' +
      'Set REDIS_URL=redis://localhost:6379 and start Redis to enable cross-pod events.'
    );
    return;
  }

  const pubClient = createClient({
    url: redisUrl,
    socket: {
      reconnectStrategy: (retries) => {
        // Exponential backoff: 100ms → 200ms → 400ms → ... capped at 30s
        const delay = Math.min(100 * Math.pow(2, retries), 30_000);
        return delay;
      },
    },
  });
  const subClient = pubClient.duplicate();

  pubClient.on('error', makeThrottledErrorHandler('pub'));
  subClient.on('error', makeThrottledErrorHandler('sub'));

  pubClient.on('connect',   () => logger.log('Redis pub client connected'));
  pubClient.on('reconnecting', () => logger.log('Redis pub client reconnecting...'));
  subClient.on('connect',   () => logger.log('Redis sub client connected'));

  try {
    // Connect with a 5-second timeout — don't block server startup indefinitely
    await Promise.race([
      Promise.all([pubClient.connect(), subClient.connect()]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Redis connection timeout after 5s')), 5_000)
      ),
    ]);

    // Get the underlying Socket.IO server from the NestJS HTTP adapter
    const httpAdapter = app.getHttpAdapter() as any;
    const io = httpAdapter?.getInstance?.()?.io;

    if (!io) {
      logger.warn(
        'Socket.IO server instance not found — Redis adapter not attached. ' +
        'This is expected if no WebSocket gateway is bootstrapped.'
      );
      return;
    }

    io.adapter(createAdapter(pubClient, subClient));
    logger.log('✅ Socket.IO Redis adapter attached — multi-node real-time events enabled.');
    logger.log(`   Redis: ${redisUrl.replace(/:[^:@]+@/, ':***@')}`);

  } catch (err: any) {
    // Redis is down — fall back to single-node gracefully, no crash
    logger.warn(
      `Redis unavailable (${err.message}) — Socket.IO running in single-node mode. ` +
      `Start Redis with: brew services start redis   OR   docker compose up -d redis`
    );

    // Clients will keep trying to reconnect in the background with exponential backoff.
    // If Redis comes up later, they'll auto-reconnect and the adapter will activate.
    // We still attach the adapter so it activates once clients reconnect.
    try {
      const httpAdapter = app.getHttpAdapter() as any;
      const io = httpAdapter?.getInstance?.()?.io;
      if (io) {
        io.adapter(createAdapter(pubClient, subClient));
        logger.log('Redis adapter registered — will activate automatically when Redis reconnects.');
      }
    } catch {
      // Silently ignore — single-node mode is acceptable for development
    }
  }
}
