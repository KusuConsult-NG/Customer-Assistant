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
import * as bcrypt from 'bcryptjs';
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

    // Fixtures go straight into the database rather than through
    // POST /api/auth/register: that endpoint is throttled to 5/min per IP as
    // an anti-abuse control, the whole CI suite shares one IP, and the sixth
    // registering spec in a minute gets a 429 that has nothing to do with what
    // it tests. Login carries a 60/min budget, so the token still comes from
    // the real auth path.
    const email = `lang.${randomBytes(4).toString('hex')}@lang.test`;
    const password = 'LanguagePassw0rd!';
    const org = await prisma.organization.create({
      data: { name: 'Language Test Ltd', slug: `lang-test-${randomBytes(4).toString('hex')}`, industry: 'CLINIC' },
    });
    orgId = org.id;
    await prisma.user.create({
      data: {
        organizationId: orgId,
        email,
        fullName: 'Lang Tester',
        role: 'OWNER',
        passwordHash: await bcrypt.hash(password, 10),
      },
    });
    const login = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password });
    token = login.body.accessToken;
    expect(token).toBeTruthy();
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

  // ── The agency name ───────────────────────────────────────────────────────
  //
  // An agency was renamed to the literal string "NEW AGENCY NAME", copied from
  // a command whose placeholder had not been filled in. This endpoint accepted
  // it and it went live — so the assistant greeted every caller with it, and
  // it printed on the identity card citizens present as proof.
  //
  // The validator is unit-tested in packages/database/test/agency-name.spec.ts.
  // What is proved HERE is that the endpoint applies it, refuses with 400, and
  // writes nothing — because the failure was never in the rule, it was that no
  // rule was consulted.
  describe('the agency name', () => {
    it('refuses the placeholder that actually shipped, and stores nothing', async () => {
      const before = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });

      const res = await request(app.getHttpServer())
        .patch('/api/organizations/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'NEW AGENCY NAME' });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/placeholder/i);

      const after = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
      expect(after?.name).toBe(before?.name);
    });

    it('refuses an unfilled angle-bracket placeholder', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/organizations/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: '<agency name>' });
      expect(res.status).toBe(400);
    });

    it('refuses an empty name', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/organizations/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: '   ' });
      expect(res.status).toBe(400);
    });

    it('accepts a real agency name and trims it', async () => {
      // A trailing space is invisible in a form and audible in a greeting.
      await request(app.getHttpServer())
        .patch('/api/organizations/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: '  Plateau State Water Board  ' })
        .expect(200);

      const row = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
      expect(row?.name).toBe('Plateau State Water Board');
    });

    it('does not touch the name when the field is not sent', async () => {
      // An empty body, so this says only what it means. Sending another field
      // here changed the language and broke the test below it, which is its
      // own small lesson about shared fixtures.
      await request(app.getHttpServer())
        .patch('/api/organizations/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({})
        .expect(200);

      const row = await prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } });
      expect(row?.name).toBe('Plateau State Water Board');
    });
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
