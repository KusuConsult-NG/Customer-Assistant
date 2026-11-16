/**
 * A spent Redis quota must not take the API down.
 *
 * In production the Upstash plan ran out ("ERR max requests limit exceeded")
 * and the API exited one second after every boot:
 *
 *   node:internal/process/promises … triggerUncaughtException(err, true /* fromPromise *\/)
 *   [ErrorReply: ERR max requests limit exceeded. Limit: 500000, Usage: 500002 …]
 *
 * `@socket.io/redis-adapter` subscribes the moment it is created, and publishes
 * on every broadcast, without catching either. A Redis that ACCEPTS the
 * connection and REFUSES every command turned that into an unhandled rejection.
 *
 * The fake server here does exactly what Upstash did: accepts the socket and
 * answers every command with the quota error.
 */
import * as net from 'net';
import { ErrorReply } from 'redis';
import { RedisSocketIoAdapter } from '../src/config/socket-redis-adapter';
import { isRedisClientError, redisRejectionGuard } from '../src/common/redis-quota';

const QUOTA = 'ERR max requests limit exceeded. Limit: 500000, Usage: 500002. See https://upstash.com/docs/redis/troubleshooting/max_requests_limit for details';

/** A RESP server that answers every command with the Upstash quota error. */
function quotaSpentRedis(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      // One error reply per command in the chunk (each RESP array starts with '*').
      const commands = (chunk.toString().match(/(^|\r\n)\*/g) ?? ['*']).length;
      for (let i = 0; i < commands; i++) socket.write(`-${QUOTA}\r\n`);
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        url: `redis://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    })
  );
}

describe('A spent Redis quota', () => {
  jest.setTimeout(20000);

  it('leaves Socket.IO single-node instead of crashing the process', async () => {
    const redis = await quotaSpentRedis();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const adapter = new RedisSocketIoAdapter({ getHttpServer: () => undefined } as any);
      await adapter.connectToRedis(redis.url);
      // Give any unawaited subscribe a chance to reject, as it did in production.
      await new Promise((r) => setTimeout(r, 500));

      expect((adapter as any).adapterConstructor).toBeNull();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await redis.close();
    }
  });

  describe('the process-level guard', () => {
    it('absorbs a Redis refusal nobody awaited, and says so once', () => {
      const logged: string[] = [];
      const guard = redisRejectionGuard((m) => logged.push(m));
      for (let i = 0; i < 10; i++) guard(new ErrorReply(QUOTA));
      // A spent quota refuses every command: a few lines, then quiet.
      expect(logged.length).toBe(3);
      expect(logged[0]).toMatch(/max requests limit exceeded/);
      expect(logged[0]).toMatch(/unset REDIS_URL/);
    });

    it('still crashes on anything that is not Redis, exactly as Node would', () => {
      const guard = redisRejectionGuard(() => undefined);
      const bug = new TypeError("Cannot read properties of undefined (reading 'id')");
      expect(() => guard(bug)).toThrow(bug);
      expect(() => guard('a string rejection')).toThrow();
    });

    it('recognises the redis client\'s own error classes, not just the quota text', () => {
      expect(isRedisClientError(new ErrorReply('ERR something else'))).toBe(true);
      expect(isRedisClientError(new Error(QUOTA))).toBe(true);
      expect(isRedisClientError(new Error('ECONNRESET from somewhere else'))).toBe(false);
    });
  });
});
