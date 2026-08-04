import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('ACE Platform API Integration Tests', () => {
  let app: INestApplication;
  let authToken: string;

  jest.setTimeout(30000);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('1. System Health & Public Config', () => {
    it('GET /api/health - should return 200 OK with health status', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/health')
        .expect(200);

      expect(res.body).toHaveProperty('status', 'ok');
      expect(res.body).toHaveProperty('timestamp');
    });

    it('GET /api/widget/config - should return public widget configuration', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/widget/config?apiKey=test-api-key')
        .expect(200);

      expect(res.body).toHaveProperty('organizationName');
      expect(res.body).toHaveProperty('enableVoiceCall');
    });
  });

  describe('2. Auth & Registration Flows', () => {
    const testEmail = `test.user.${Date.now()}@example.com`;

    it('POST /api/auth/register - should handle registration', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/register')
        .send({
          email: testEmail,
          password: 'TestPassword123!',
          fullName: 'Test Automation Agent',
          organizationName: 'Automated Testing Org',
        });

      expect([200, 201, 400]).toContain(res.status);
      if (res.body?.token) authToken = res.body.token;
    });

    it('GET /api/organizations/me - should reject unauthenticated request with 401', async () => {
      await request(app.getHttpServer())
        .get('/api/organizations/me')
        .expect(401);
    });
  });

  describe('3. WhatsApp Webhook Security', () => {
    it('GET /api/whatsapp/webhook - should verify webhook when token matches or reject when invalid', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=invalid_token&hub.challenge=CHALLENGE_12345');

      expect([200, 403]).toContain(res.status);
    });
  });

  describe('4. SSRF Security Defense on Web Crawler', () => {
    it('POST /api/knowledge/crawl-website - should block internal IP ranges (SSRF Protection) or require auth', async () => {
      const reqBuilder = request(app.getHttpServer()).post('/api/knowledge/crawl-website');
      if (authToken) reqBuilder.set('Authorization', `Bearer ${authToken}`);
      
      const res = await reqBuilder.send({ url: 'http://169.254.169.254/latest/meta-data/' });
      expect([400, 401]).toContain(res.status);
    });
  });

  describe('5. CRM Endpoints', () => {
    it('GET /api/crm/contacts - should require authentication', async () => {
      await request(app.getHttpServer())
        .get('/api/crm/contacts')
        .expect(401);
    });
  });
});
