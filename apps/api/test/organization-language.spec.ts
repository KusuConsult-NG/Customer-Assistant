/**
 * Organization default language — the setting behind the Settings → General
 * selector.
 *
 * The validation matters more than the write: the orchestrator silently falls
 * back to English on any code it does not recognise, so an unvalidated PATCH
 * would produce a selector that appears to save and changes nothing. Refusing
 * the write is the honest behavior.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { AppModule } from '../src/app.module';

describe('PATCH /api/organizations/settings — defaultLanguage', () => {
  let app: INestApplication;
  let orgId: string;
  let token: string;

  jest.setTimeout(60000);

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    const email = `lang.${randomBytes(4).toString('hex')}@lang.test`;
    const password = 'LanguagePassw0rd!';
    const reg = await request(app.getHttpServer()).post('/api/auth/register').send({
      organizationName: 'Language Test Ltd', industry: 'CLINIC', email, password, fullName: 'Lang Tester',
    });
    expect(reg.status).toBeLessThan(400);
    const login = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password });
    token = login.body.accessToken;
    orgId = login.body.user.organizationId;
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
    await app?.close();
  });

  it('persists a supported language and returns it on GET /me', async () => {
    await request(app.getHttpServer())
      .patch('/api/organizations/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ defaultLanguage: 'ha' })
      .expect(200);

    const me = await request(app.getHttpServer())
      .get('/api/organizations/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(me.body.defaultLanguage).toBe('ha');
  });

  it('refuses an unsupported code with 400 and writes nothing', async () => {
    const res = await request(app.getHttpServer())
      .patch('/api/organizations/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ defaultLanguage: 'fr' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/defaultLanguage must be one of/);

    const row = await prisma.organization.findUnique({ where: { id: orgId }, select: { defaultLanguage: true } });
    expect(row?.defaultLanguage).toBe('ha'); // the previous write, untouched
  });

  it('leaves the language alone when the field is not sent', async () => {
    await request(app.getHttpServer())
      .patch('/api/organizations/settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Language Test Ltd (renamed)' })
      .expect(200);

    const row = await prisma.organization.findUnique({ where: { id: orgId }, select: { defaultLanguage: true } });
    expect(row?.defaultLanguage).toBe('ha');
  });
});
