/**
 * Liveness and readiness, which are different questions.
 *
 * `/api/health` returned `{status:'ok'}` without touching anything, and
 * kubernetes/deployment.yaml used it for the readinessProbe AND the
 * livenessProbe, with render.yaml as its healthCheckPath.
 *
 * That made readiness a lie. With PostgreSQL unreachable a pod still reported
 * ready, the Service kept routing to it and every request failed — rather than
 * the load balancer holding traffic off until a pod could serve.
 *
 * It cannot be fixed by deepening the one endpoint, because a liveness probe
 * that fails on a dependency RESTARTS the pod. Restarting the API does not fix
 * the database; it would crash-loop the fleet for the length of a database
 * incident. So the two are separate, and these tests pin both halves —
 * including that liveness stays shallow, which is the half somebody would
 * "improve" later.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppController } from '../src/app.controller';

// Only the health controller: booting AppModule would require the whole
// application, and what is under test is two handlers.
jest.mock('@ace/database', () => ({
  prisma: { $queryRawUnsafe: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { prisma } = require('@ace/database');
const query = prisma.$queryRawUnsafe as jest.Mock;

describe('health probes', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => jest.clearAllMocks());

  describe('liveness — /api/health', () => {
    it('answers without touching any dependency', async () => {
      query.mockRejectedValue(new Error('database is down'));

      const res = await request(app.getHttpServer()).get('/api/health').expect(200);

      // Still 200 with the database unreachable, deliberately. The only
      // remedy a liveness failure triggers is a restart, and restarting does
      // not repair PostgreSQL.
      expect(res.body).toMatchObject({ status: 'ok' });
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('readiness — /api/health/ready', () => {
    it('is ready when the database answers', async () => {
      query.mockResolvedValue([{ '?column?': 1 }]);

      const res = await request(app.getHttpServer()).get('/api/health/ready').expect(200);
      expect(res.body).toMatchObject({ status: 'ready', checks: { database: 'ok' } });
    });

    it('is NOT ready when the database is unreachable', async () => {
      query.mockRejectedValue(new Error('connection refused'));

      // 503 is what takes the pod out of rotation. A 200 here is the original
      // bug: traffic routed to a pod that fails every request.
      const res = await request(app.getHttpServer()).get('/api/health/ready').expect(503);
      expect(res.body.status).toBe('not ready');
      expect(res.body.checks.database).toMatch(/unavailable/i);
    });

    it('stays ready without Redis, which is optional', async () => {
      const real = process.env.REDIS_URL;
      delete process.env.REDIS_URL;
      query.mockResolvedValue([{ '?column?': 1 }]);

      try {
        // Redis enables queued ingestion, cross-pod sockets and Redis-backed
        // rate limiting, and the platform degrades honestly without it.
        // Failing readiness for it would take the deployment out of rotation
        // over a dependency designed to be absent.
        const res = await request(app.getHttpServer()).get('/api/health/ready').expect(200);
        expect(res.body.checks.redis).toMatch(/optional/i);
      } finally {
        if (real === undefined) delete process.env.REDIS_URL;
        else process.env.REDIS_URL = real;
      }
    });

    it('does not leak the connection string when it reports a failure', async () => {
      query.mockRejectedValue(
        new Error('connect ECONNREFUSED postgresql://ace:sup3rsecret@db.internal:5432/ace')
      );

      // Probes are unauthenticated, so whatever this says is public.
      const res = await request(app.getHttpServer()).get('/api/health/ready').expect(503);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('sup3rsecret');
    });
  });
});
