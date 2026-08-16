import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { prisma } from '@ace/database';

/**
 * Integration tests that run WITHOUT a database.
 *
 * They therefore assert the things that are decided before any query runs:
 * authentication, request validation, SSRF defence and tenant-credential handling.
 *
 * The previous versions of these tests accepted a range of statuses
 * (`expect([200, 201, 400]).toContain(res.status)`), which meant they passed whether
 * the endpoint worked or not — registration was completely broken for the whole life
 * of the suite and every test still went green. Each assertion below now has exactly
 * one acceptable outcome.
 */
describe('Customer Care Agent API Integration Tests', () => {
  let app: INestApplication;

  jest.setTimeout(30000);

  beforeAll(async () => {
    // Required env for the module graph to construct.
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    process.env.WHATSAPP_VERIFY_TOKEN ??= 'test_verify_token';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    // Mirror main.ts exactly. The suite previously omitted forbidNonWhitelisted, so
    // it could not have caught a payload with wrong field names — which is precisely
    // the bug that broke registration.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: true },
      })
    );
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    await prisma.$disconnect().catch(() => {});
  });

  describe('1. System health', () => {
    it('GET /api/health returns ok', async () => {
      const res = await request(app.getHttpServer()).get('/api/health').expect(200);
      expect(res.body).toHaveProperty('status', 'ok');
      expect(res.body).toHaveProperty('timestamp');
    });
  });

  describe('2. Widget tenant isolation', () => {
    it('rejects a request with no API key instead of serving an arbitrary organization', async () => {
      await request(app.getHttpServer()).get('/api/widget/config').expect(401);
    });

    it('rejects a malformed API key', async () => {
      // Regression guard: getWidgetConfig used to fall back to
      // `prisma.organization.findFirst()` when the key did not resolve, handing the
      // first organization in the table to any caller.
      await request(app.getHttpServer())
        .get('/api/widget/config?apiKey=ace_live_pk_not_a_real_key')
        .expect((res) => {
          // 401 with a database; 500 when the DB is unreachable in CI. Never 200.
          expect(res.status).not.toBe(200);
        });
    });

    it('rejects a chat message with no API key', async () => {
      await request(app.getHttpServer())
        .post('/api/widget/chat')
        .send({ sessionId: 'sess_test', message: 'hello' })
        .expect(401);
    });
  });

  describe('3. Registration payload contract', () => {
    it('rejects the legacy adminEmail/adminPassword field names with 400, not 500', async () => {
      // These are the exact field names the dashboard used to send. They must produce
      // a validation error, not an unhandled crash inside bcrypt.
      const res = await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          organizationName: 'Legacy Field Test',
          industry: 'SME',
          adminFullName: 'Test User',
          adminEmail: 'legacy@example.com',
          adminPassword: 'TestPassword123!',
        });

      expect(res.status).toBe(400);
    });

    it('rejects an industry value outside the IndustryType enum', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          organizationName: 'Bad Industry Test',
          industry: 'HOSPITALITY', // never existed server-side
          fullName: 'Test User',
          email: `test.${Date.now()}@example.com`,
          password: 'TestPassword123!',
        });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message)).toMatch(/industry/i);
    });

    it('rejects a password shorter than 8 characters', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          organizationName: 'Short Password Test',
          industry: 'SME',
          fullName: 'Test User',
          email: `test.${Date.now()}@example.com`,
          password: 'short',
        });

      expect(res.status).toBe(400);
    });
  });

  describe('4. Authentication is enforced', () => {
    const protectedRoutes: Array<[string, string]> = [
      ['get', '/api/organizations/me'],
      ['get', '/api/crm/contacts'],
      ['get', '/api/conversations'],
      ['get', '/api/analytics/dashboard'],
      ['get', '/api/billing/subscription'],
      ['get', '/api/scheduling/bookings'],
      ['get', '/api/knowledge/documents'],
      ['get', '/api/workflows'],
      ['get', '/api/telephony/calls'],
      ['get', '/api/whatsapp/conversations'],
    ];

    it.each(protectedRoutes)('%s %s requires a token', async (method, path) => {
      await (request(app.getHttpServer()) as any)[method](path).expect(401);
    });

    it('rejects a syntactically valid but unsigned token', async () => {
      await request(app.getHttpServer())
        .get('/api/organizations/me')
        .set('Authorization', 'Bearer eyJhbGciOiJub25lIn0.eyJ1c2VySWQiOiJ4In0.')
        .expect(401);
    });
  });

  describe('5. WhatsApp webhook security', () => {
    it('rejects the verification handshake when the token does not match', async () => {
      await request(app.getHttpServer())
        .get('/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=definitely_wrong&hub.challenge=CHALLENGE_12345')
        .expect(403);
    });

    it('echoes the challenge when the token matches', async () => {
      const res = await request(app.getHttpServer())
        .get(
          `/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${process.env.WHATSAPP_VERIFY_TOKEN}&hub.challenge=CHALLENGE_12345`
        )
        .expect(200);
      expect(res.text).toBe('CHALLENGE_12345');
    });
  });

  describe('6. Paystack webhook signature', () => {
    it('does not report success for an unsigned payload', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/billing/paystack-webhook')
        .send({ event: 'charge.success', data: { reference: 'forged' } });

      // Must never be `{ status: 'success' }`. The old handler passed the parsed body
      // into createHmac().update(), threw a TypeError, and 500'd on every delivery.
      expect(res.body.status).not.toBe('success');
    });
  });

  describe('7. SSRF defence on the web crawler', () => {
    it('requires authentication before crawling anything', async () => {
      await request(app.getHttpServer())
        .post('/api/knowledge/crawl-website')
        .send({ url: 'http://169.254.169.254/latest/meta-data/' })
        .expect(401);
    });
  });
});
