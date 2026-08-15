/**
 * ACE Platform — Socket.IO Redis Adapter (NestJS IoAdapter subclass)
 *
 * WHY this is critical:
 *   Socket.IO rooms are in-memory by default. With more than one API pod
 *   behind a load balancer, an event emitted on pod B never reaches a client
 *   whose socket lives on pod A. The @socket.io/redis-adapter bridges pods
 *   over Redis pub/sub.
 *
 * WHY this file was rewritten:
 *   The previous implementation ran AFTER app.listen() and tried to find the
 *   Socket.IO server via `app.getHttpAdapter().getInstance().io` — a property
 *   that does not exist in a NestJS app (socket.io attaches to the HTTP
 *   server, and Nest's IoAdapter keeps its own reference). The lookup always
 *   failed, the code logged "Socket.IO server instance not found — this is
 *   expected", and the multi-pod feature silently never worked anywhere.
 *
 *   The correct NestJS pattern (per the official docs) is to subclass
 *   IoAdapter, connect the Redis clients BEFORE the app starts listening, and
 *   apply the adapter inside createIOServer() — which Nest calls when it
 *   bootstraps the gateways. main.ts registers this adapter before listen().
 *
 * Degraded mode (no Redis / Redis down):
 *   connectToRedis() gives up after 5 s and leaves adapterConstructor unset —
 *   createIOServer() then behaves exactly like the default IoAdapter
 *   (single-node, in-memory rooms). The API always boots.
 */

import { INestApplication, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ServerOptions } from 'socket.io';
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

export class RedisSocketIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null;

  constructor(app: INestApplication) {
    super(app);
  }

  /**
   * Connect pub/sub clients and prepare the adapter. Never throws — on any
   * failure the adapter simply stays unset and sockets run single-node.
   * The clients keep retrying in the background; if Redis appears later the
   * already-created adapter picks it up automatically.
   */
  async connectToRedis(redisUrl: string): Promise<void> {
    const pubClient = createClient({
      url: redisUrl,
      socket: {
        reconnectStrategy: (retries: number) => Math.min(100 * Math.pow(2, retries), 30_000),
      },
    });
    const subClient = pubClient.duplicate();

    pubClient.on('error', makeThrottledErrorHandler('pub'));
    subClient.on('error', makeThrottledErrorHandler('sub'));
    pubClient.on('connect', () => logger.log('Redis pub client connected'));
    subClient.on('connect', () => logger.log('Redis sub client connected'));

    try {
      // 5-second cap — never block server startup on a slow/absent Redis
      await Promise.race([
        Promise.all([pubClient.connect(), subClient.connect()]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Redis connection timeout after 5s')), 5_000)
        ),
      ]);

      this.adapterConstructor = createAdapter(pubClient, subClient);
      logger.log('✅ Socket.IO Redis adapter ready — multi-node real-time events enabled.');
      logger.log(`   Redis: ${redisUrl.replace(/:[^:@]+@/, ':***@')}`);
    } catch (err: any) {
      logger.warn(
        `Redis unavailable (${err.message}) — Socket.IO running in single-node mode. ` +
        `Clients keep retrying in the background.`
      );
      // Still register the adapter: it activates when the clients reconnect.
      try {
        this.adapterConstructor = createAdapter(pubClient, subClient);
      } catch {
        this.adapterConstructor = null;
      }
    }
  }

  override createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }
}
